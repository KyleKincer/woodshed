// @vitest-environment happy-dom
// DL1: the /download page (architecture §9.6 DL1, §2.3 bootRoutes; spec §1.2).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {boot, isSameOrigin, linkTarget, mountDownload, RELEASE_STATES} from '../src/download/download.js';
import {CONTROLS, COPY, LINKS, PLATFORMS} from '../src/download/download.copy.js';
import {RELEASE_SOURCES} from '../src/js/download-release.js';

const manifest = JSON.parse(readFileSync(`${process.cwd()}/public/downloads.json`, 'utf8'));
const VERSION = manifest.tag_name.slice(1);
const ORIGIN = 'http://localhost:3000';

const NAV = {
  mac: {platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', maxTouchPoints: 0},
  windows: {platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'},
  linux: {platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)'},
  ipad: {platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', maxTouchPoints: 5},
  chromeos: {platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)'},
};

const ok = () => ({ok: true, status: 200, json: async () => structuredClone(manifest)});

/** A fetch whose answers are queued per call; an unqueued call answers the manifest. */
function fakeFetch(...answers) {
  const queue = [...answers];
  return vi.fn((url, {signal} = {}) => {
    const next = queue.shift() ?? 'ok';
    if (next === 'ok') return Promise.resolve(ok());
    if (next === 'down') return Promise.reject(new TypeError('Failed to fetch'));
    if (next === '503') return Promise.resolve({ok: false, status: 503, json: async () => ({})});
    if (next === 'hang') {
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), {once: true}));
    }
    throw new Error(`unknown answer ${next}`);
  });
}

/** Mounts the page into a fresh host and waits for the first lookup to settle. */
async function mount({nav = NAV.mac, fetch = fakeFetch(), desktopApp = false, settle = true, ...rest} = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const view = mountDownload(host, {fetch, navigator: nav, desktopApp, origin: ORIGIN, reducedMotion: () => true, ...rest});
  if (settle) await view.ready;
  return {host, view, fetch, root: view.el};
}

const collapse = s => s.replace(/\s+/g, ' ').trim();
/** The accessible name of a link or button (aria-label, else its text content). */
const nameOf = el => collapse(el.getAttribute('aria-label') ?? el.textContent ?? '');
const links = root => [...root.querySelectorAll('a[href]')];
const linkNamed = (root, name) => links(root).filter(a => (name instanceof RegExp ? name.test(nameOf(a)) : nameOf(a) === name));
const primary = root => root.querySelector('.download-primary-link');
const status = root => root.querySelector('.download-status');
const card = (root, key) => root.querySelector(`.download-platform[data-platform=${key}]`);

beforeEach(() => {
  document.body.replaceChildren();
  document.title = '';
  delete document.documentElement.dataset.viewReady;
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('the recommended installer', () => {
  test.each([
    ['mac', /-mac-arm64\.dmg$/, PLATFORMS.mac.detail],
    ['windows', /-win-x64\.exe$/, PLATFORMS.windows.detail],
    ['linux', /-linux-(?:x64|x86_64)\.AppImage$/, PLATFORMS.linux.detail],
  ])('%s: the primary downloads its first installer directly, and its card is recommended', async (key, file, detail) => {
    const {root} = await mount({nav: NAV[key]});
    const link = primary(root);
    expect(nameOf(link)).toBe(PLATFORMS[key].primary);
    expect(link.getAttribute('href')).toMatch(new RegExp(`/releases/download/v${VERSION.replace(/\./g, '\\.')}/`));
    expect(link.getAttribute('href')).toMatch(file);
    expect(link.getAttribute('download')).toMatch(file);
    expect(link.hasAttribute('target')).toBe(false);
    expect(link.classList.contains('ui-button')).toBe(true);
    expect(link.dataset.variant).toBe('primary');
    const size = manifest.assets.find(a => file.test(a.name)).size;
    expect(root.querySelector('.download-detail').textContent).toBe(`${detail} · ${Math.round(size / 1024 / 1024)} MB · v${VERSION}`);
    for (const other of ['mac', 'windows', 'linux']) {
      expect(card(root, other).hasAttribute('data-recommended')).toBe(other === key);
      expect(card(root, other).querySelector('.download-badge').hidden).toBe(other !== key);
    }
    expect(nameOf(root.querySelector('.download-secondary-link'))).toBe(COPY.otherPlatforms);
    expect(root.dataset.releaseState).toBe('ready');
  });

  test('every installer of every platform is listed with its size, and the version is shown', async () => {
    const {root} = await mount();
    const files = [...root.querySelectorAll('.download-file')];
    expect(files.map(nameOf)).toEqual([
      expect.stringMatching(/^Download Woodshed for macOS, DMG installer, \d+ MB$/),
      expect.stringMatching(/^Download Woodshed for macOS, ZIP archive, \d+ MB$/),
      expect.stringMatching(/^Download Woodshed for Windows, EXE installer, \d+ MB$/),
      expect.stringMatching(/^Download Woodshed for Linux, AppImage, \d+ MB$/),
    ]);
    for (const a of files) {
      expect(a.getAttribute('href')).toMatch(/^https:\/\/github\.com\/KyleKincer\/woodshed\/releases\/download\/v[\d.]+\//);
      expect(a.getAttribute('download')).toBe(a.getAttribute('href').split('/').pop());
      expect(a.querySelector('.download-file-size').textContent).toMatch(/^\d+ MB$/);
    }
    expect(root.querySelector('.download-version').textContent).toBe(COPY.version(VERSION));
    expect(root.querySelector('.download-platforms').hasAttribute('aria-busy')).toBe(false);
    expect(status(root).hidden).toBe(true);
  });

  test('iPad and phones get the web player as the primary, in a new tab, and no recommended card', async () => {
    const {root} = await mount({nav: NAV.ipad});
    const link = primary(root);
    expect(nameOf(link)).toBe(`${COPY.openApp} ${COPY.newTab}`);
    expect(link.getAttribute('href')).toBe(LINKS.app);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
    expect(root.querySelector('.download-detail').textContent).toBe(COPY.detailMobile);
    expect(nameOf(root.querySelector('.download-secondary-link'))).toBe(COPY.primaryFallback);
    expect(root.querySelectorAll('[data-recommended]')).toHaveLength(0);
    expect(root.querySelectorAll('.download-file')).toHaveLength(4);
  });

  test('ChromeOS and ARM Linux get the web player and the "choose below" line', async () => {
    const {root} = await mount({nav: NAV.chromeos});
    expect(primary(root).getAttribute('href')).toBe(LINKS.app);
    expect(root.querySelector('.download-detail').textContent).toBe(COPY.detailWeb);
  });

  test('clicking any download says it should start shortly (politely)', async () => {
    const {root} = await mount();
    const prevent = e => e.preventDefault();
    document.addEventListener('click', prevent);
    primary(root).click();
    expect(status(root).hidden).toBe(false);
    expect(status(root).getAttribute('role')).toBe('status');
    expect(status(root).textContent).toContain(COPY.started);
    root.querySelector('.download-file').click();
    expect(status(root).textContent).toContain(COPY.started);
    document.removeEventListener('click', prevent);
  });
});

describe('looking up the release', () => {
  test('while loading: skeleton rows, a busy list, the loading status and the "See all downloads" primary', async () => {
    const {root, view} = await mount({fetch: fakeFetch('hang'), settle: false, timeoutMs: 60000});
    expect(view.state()).toBe('loading');
    expect(root.dataset.releaseState).toBe('loading');
    expect(root.querySelector('.download-platforms').getAttribute('aria-busy')).toBe('true');
    expect(card(root, 'mac').querySelectorAll('.ui-skeleton-item')).toHaveLength(2);
    expect(card(root, 'windows').querySelectorAll('.ui-skeleton-item')).toHaveLength(1);
    expect(status(root).getAttribute('role')).toBe('status');
    expect(status(root).textContent).toContain(COPY.loading);
    expect(nameOf(primary(root))).toBe(COPY.primaryFallback);
    expect(primary(root).getAttribute('href')).toBe('#all-downloads');
    expect(root.querySelector('.download-secondary-link')).toBeNull();
    expect(root.querySelector('.download-detail').textContent).toBe(COPY.detailLoading);
    expect(root.querySelector('.download-version').textContent).toBe(COPY.versionUnknown);
    view.destroy();
  });

  test('the cached lookup comes first, and the bundled manifest covers an API outage', async () => {
    const {root, fetch} = await mount({fetch: fakeFetch('down')});
    expect(fetch.mock.calls.map(c => c[0])).toEqual([...RELEASE_SOURCES]);
    expect(RELEASE_SOURCES).toEqual(['/api/downloads', '/downloads.json']);
    expect(root.dataset.releaseState).toBe('ready');
    expect(root.querySelectorAll('.download-file')).toHaveLength(4);
  });

  test('a non-2xx answer and a source that never answers also fall through to the next source', async () => {
    const first = await mount({fetch: fakeFetch('503')});
    expect(first.root.dataset.releaseState).toBe('ready');
    const second = await mount({fetch: fakeFetch('hang'), timeoutMs: 20});
    expect(second.fetch).toHaveBeenCalledTimes(2);
    expect(second.root.dataset.releaseState).toBe('ready');
  });

  test('a complete outage says so, marks every card unavailable and offers Try again, which recovers', async () => {
    const fetch = fakeFetch('down', 'down');
    const {root, view} = await mount({fetch});
    expect(view.state()).toBe('unavailable');
    expect(root.dataset.releaseState).toBe('unavailable');
    const line = status(root);
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.textContent).toContain(COPY.unavailable);
    for (const key of ['mac', 'windows', 'linux']) expect(card(root, key).textContent).toContain(COPY.fileUnavailable);
    expect(root.querySelectorAll('.download-file')).toHaveLength(0);
    expect(root.querySelector('.download-platforms').hasAttribute('aria-busy')).toBe(false);
    expect(nameOf(primary(root))).toBe(COPY.primaryFallback);

    const retry = line.querySelector('.ui-status-action');
    expect(retry.hidden).toBe(false);
    expect(nameOf(retry)).toBe(COPY.retry);
    retry.focus();
    retry.click();
    expect(view.state()).toBe('loading');
    await vi.waitFor(() => expect(view.state()).toBe('ready'));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(root.querySelectorAll('.download-file')).toHaveLength(4);
    expect(status(root).hidden).toBe(true);
    // Try again hid itself while loading; focus lands on the download it found.
    expect(document.activeElement).toBe(primary(root));
  });

  test('Try again that fails again keeps focus on Try again', async () => {
    const {root, view} = await mount({fetch: fakeFetch('down', 'down', 'down', 'down')});
    const retry = status(root).querySelector('.ui-status-action');
    retry.focus();
    retry.click();
    await vi.waitFor(() => expect(view.state()).toBe('unavailable'));
    expect(document.activeElement).toBe(status(root).querySelector('.ui-status-action'));
  });

  test('destroy aborts the lookup and removes the page; a late answer changes nothing', async () => {
    const {root, view, fetch} = await mount({fetch: fakeFetch('hang'), settle: false, timeoutMs: 60000});
    const signal = fetch.mock.calls[0][1].signal;
    view.destroy();
    expect(signal.aborted).toBe(true);
    expect(root.isConnected).toBe(false);
    await view.ready;
    expect(view.state()).toBe('loading');
  });

  test('reload() looks the release up again', async () => {
    const {view, fetch} = await mount();
    expect(await view.reload()).toBe('ready');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('the release states are the documented three', () => {
    expect(RELEASE_STATES).toEqual(['loading', 'ready', 'unavailable']);
  });
});

describe('new-tab links', () => {
  test.each([
    // href, newTab, desktopApp → target, rel, inPlace
    ['/', true, false, '_blank', 'noopener', false],
    ['/', true, true, null, null, true],
    [`${ORIGIN}/settings`, true, true, null, null, true],
    ['https://github.com/KyleKincer/woodshed', true, false, '_blank', 'noopener noreferrer', false],
    ['https://github.com/KyleKincer/woodshed', true, true, '_blank', 'noopener noreferrer', false],
    ['/', false, false, null, null, true],
    ['https://example.com/', false, true, null, null, true],
  ])('%s newTab=%s desktop=%s', (href, newTab, desktopApp, target, rel, inPlace) => {
    expect(linkTarget({href, newTab, desktopApp, origin: ORIGIN})).toEqual({target, rel, inPlace});
  });

  test('isSameOrigin resolves relative URLs against the origin', () => {
    expect(isSameOrigin('/download', ORIGIN)).toBe(true);
    expect(isSameOrigin('#all-downloads', ORIGIN)).toBe(true);
    expect(isSameOrigin('http://localhost:3001/', ORIGIN)).toBe(false);
    expect(isSameOrigin('https://github.com/', ORIGIN)).toBe(false);
    expect(isSameOrigin('http://[bad', 'not a url')).toBe(false);
  });

  test('on the web the way back into the app opens a new tab, marked for assistive tech', async () => {
    const {root} = await mount();
    const [open] = linkNamed(root, `${COPY.openApp} ${COPY.newTab}`);
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.querySelector('.download-link-ext')).not.toBeNull();
    expect(open.querySelector('.sr-only').textContent).toBe(` ${COPY.newTab}`);
  });

  test('inside the desktop app same-origin new-tab links navigate in place; external links keep their tab', async () => {
    const {root} = await mount({desktopApp: true, nav: NAV.ipad});
    for (const a of links(root)) {
      if (isSameOrigin(a.getAttribute('href'), ORIGIN)) {
        expect(a.hasAttribute('target'), nameOf(a)).toBe(false);
        expect(a.querySelector('.download-link-ext'), nameOf(a)).toBeNull();
        expect(nameOf(a)).not.toContain(COPY.newTab);
      }
    }
    expect(linkNamed(root, COPY.openAppDesktop)).toHaveLength(1);
    expect(nameOf(primary(root))).toBe(COPY.openApp);
    for (const name of [COPY.releaseNotes, COPY.source]) {
      const [a] = linkNamed(root, `${name} ${COPY.newTab}`);
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  test('the platform list link scrolls to the cards and focuses their heading without touching the URL', async () => {
    const {root} = await mount();
    const before = location.href;
    const section = root.querySelector('#all-downloads');
    section.scrollIntoView = vi.fn();
    const jump = root.querySelector('.download-secondary-link');
    const event = new MouseEvent('click', {bubbles: true, cancelable: true});
    jump.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(section.scrollIntoView).toHaveBeenCalledWith({behavior: 'auto', block: 'start'});
    expect(document.activeElement).toBe(root.querySelector('#all-downloads-title'));
    expect(location.href).toBe(before);
  });
});

describe('controls and structure', () => {
  test.each(CONTROLS.map(c => [c.role, String(c.name), c]))('%s "%s" is on the page exactly once', async (role, _name, row) => {
    const {root} = await mount();
    expect(role).toBe('link');
    expect(linkNamed(root, row.name)).toHaveLength(1);
  });

  test('every link on the page is a CONTROLS row', async () => {
    const {root} = await mount();
    for (const a of links(root)) {
      expect(CONTROLS.some(c => (c.name instanceof RegExp ? c.name.test(nameOf(a)) : c.name === nameOf(a))), nameOf(a)).toBe(true);
    }
  });

  test('landmarks, headings and the one scroller', async () => {
    const {root} = await mount();
    expect(root.hasAttribute('data-scroller')).toBe(true);
    expect(document.querySelectorAll('[data-scroller]')).toHaveLength(1);
    expect(root.querySelectorAll('main')).toHaveLength(1);
    expect(root.querySelector('nav').getAttribute('aria-label')).toBe(COPY.navLabel);
    expect(root.querySelector('h1').textContent).toBe(COPY.title);
    expect([...root.querySelectorAll('.download-platform h3')].map(h3 => h3.firstChild.textContent)).toEqual(['macOS', 'Windows', 'Linux']);
    for (const article of root.querySelectorAll('.download-platform')) {
      expect(root.querySelector(`#${article.getAttribute('aria-labelledby')}`)).not.toBeNull();
    }
    expect([...root.querySelectorAll('.download-step-title')].map(e => e.textContent)).toEqual(COPY.steps.map(s => s.title));
    expect(root.querySelector('.download-step-hint').textContent).toBe(COPY.steps[0].hint);
    expect(root.querySelector('img').getAttribute('alt')).toBe(COPY.iconAlt);
    expect(root.querySelector('.download-footer').textContent).toContain(COPY.footerNote);
    expect(root.querySelector('.download-lead').textContent).toBe(COPY.lead);
  });

  test('the page keeps no theme picker (theme follows the device prefs)', async () => {
    const {root} = await mount();
    expect(root.querySelector('select')).toBeNull();
  });
});

describe('boot', () => {
  test('renders into #app, titles the document and marks the view ready', async () => {
    const app = document.createElement('div');
    app.id = 'app';
    document.body.append(app);
    const view = await boot({name: 'download', path: '/download', params: {}}, {fetch: fakeFetch(), navigator: NAV.windows, desktopApp: false, origin: ORIGIN});
    expect(document.title).toBe(COPY.documentTitle);
    expect(document.documentElement.dataset.viewReady).toBe('download');
    expect(app.firstElementChild).toBe(view.el);
    expect(await view.ready).toBe('ready');
    expect(nameOf(primary(view.el))).toBe(PLATFORMS.windows.primary);
    view.destroy();
  });

  test('a root passed in wins over #app', async () => {
    const root = document.createElement('section');
    document.body.append(root);
    const view = await boot({}, {root, fetch: fakeFetch(), navigator: NAV.linux, desktopApp: false, origin: ORIGIN});
    expect(root.firstElementChild).toBe(view.el);
    await view.ready;
    view.destroy();
  });
});
