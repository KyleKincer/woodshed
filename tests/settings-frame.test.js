// @vitest-environment happy-dom
// SE1: the Settings frame (architecture §2.17, §9.10 SE1; spec §6.2, §1.2): the split and stack
// layouts, the section nav and list, Back rules, section loading, and the shared row, saver and
// desktop-note pieces.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {
  FROM_LIST, SECTION_MODULES, STACK_MAX_WIDTH, availableSections, createSaver, desktopNote, mount, sectionPath,
  settingRow, settingsLayout,
} from '../src/settings/settings.js';
import {COPY, SECTIONS, SECTION_IDS, SECTION_TITLES} from '../src/settings/settings.copy.js';
import {SETTINGS_SECTIONS, SECTION_TITLES as GLOBAL_TITLES} from '../src/app/global-commands.js';
import {createRegistry} from '../src/app/commands.js';
import {signal} from '../src/app/store.js';
import {FADE_MS, SAVED_MS} from '../src/ui/field.js';
import {routes} from '../src/app/routes.js';

// ---------------------------------------------------------------------------------------------
// helpers

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const viewport = width => window.happyDOM.setViewport({width, height: 900});

/** Fake section modules: each renders a marker and records its lifecycle. */
function fakeModules(ids = ['practice', 'instruments', 'pedals', 'appearance', 'device', 'account'], {fail = new Set(), hold = null} = {}) {
  const log = [];
  const modules = {};
  for (const id of ids) {
    modules[sectionPath(id)] = async () => {
      log.push(`load:${id}`);
      if (hold?.[id]) await hold[id];
      if (fail.has(id)) { fail.delete(id); throw new Error(`no ${id}`); }
      return {
        default: {
          id, title: SECTION_TITLES[id],
          render(el, ctx) {
            log.push(`render:${id}`);
            el.append(Object.assign(document.createElement('p'), {className: 'fake-section', textContent: `${id} body`}));
            modules.lastCtx = ctx;
            return {destroy() { log.push(`destroy:${id}`); }};
          },
        },
      };
    };
  }
  return {modules, log};
}

function fakeRouter() {
  return {navigate: vi.fn(), back: vi.fn()};
}

const matchOf = (section, state = null) => (section
  ? {name: 'settingsPage', path: `/settings/${section}`, params: {section}, query: {}, state}
  : {name: 'settings', path: '/settings', params: {}, query: {}, state});

let host;
beforeEach(() => {
  viewport(1440);
  host = document.createElement('main');
  document.body.append(host);
  document.title = 'Woodshed';
});
afterEach(() => {
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function open(section, {width = 1440, state = null, modules = fakeModules().modules, router = fakeRouter(), ...extra} = {}) {
  viewport(width);
  const view = await mount(host, matchOf(section, state), {router, sectionModules: modules, platform: {isDesktopApp: false}, desktop: {available: false}, ...extra});
  await flush();
  return {view, router, modules};
}

const links = () => [...host.querySelectorAll('a.settings-nav-link')];
const linkNames = () => links().map(a => a.querySelector('.settings-nav-title').textContent);

// ---------------------------------------------------------------------------------------------

describe('layout and sections', () => {
  test.each([
    [1440, 'split'], [1280, 'split'], [1180, 'split'], [1024, 'split'], [900, 'split'],
    [STACK_MAX_WIDTH, 'stack'], [820, 'stack'], [600, 'stack'], [390, 'stack'], [0, 'split'], [NaN, 'split'],
  ])('settingsLayout(%s) is %s (dimensions as inputs)', (width, layout) => {
    expect(settingsLayout(width)).toBe(layout);
  });

  test('the sections are spec §6.2 in order, titled as the global Settings commands are', () => {
    expect(SECTION_IDS).toEqual(SETTINGS_SECTIONS);
    expect(SECTION_TITLES).toEqual(GLOBAL_TITLES);
    expect(SECTIONS.map(s => s.title)).toEqual(['Practice', 'Instruments', 'Pedals & keys', 'Processing', 'Appearance', 'Plan & storage', 'This device', 'Account']);
  });

  test('SE1 builds six section modules; Processing and Plan & storage appear once their files exist (D2, item 58)', () => {
    const built = ['practice', 'instruments', 'pedals', 'appearance', 'device', 'account'];
    for (const id of built) expect(typeof SECTION_MODULES[sectionPath(id)]).toBe('function');
    expect(availableSections().map(s => s.id)).toEqual(SECTION_IDS.filter(id => built.includes(id) || SECTION_MODULES[sectionPath(id)]));
    const all = Object.fromEntries(SECTION_IDS.map(id => [sectionPath(id), async () => ({})]));
    expect(availableSections({modules: all}).map(s => s.id)).toEqual(SECTION_IDS);
  });

  test('the routes resolve this module for /settings and /settings/:section', () => {
    const names = routes.filter(r => r.place === 'settings').map(r => [r.name, r.path, r.chrome]);
    expect(names).toEqual([['settings', '/settings', 'topbar'], ['settingsPage', '/settings/:section', 'topbar']]);
  });
});

describe('laptop: 200 px nav + content (split)', () => {
  test('/settings is replaced by the first section', async () => {
    const {router} = await open(null);
    expect(router.navigate).toHaveBeenCalledWith('/settings/practice', {replace: true});
    expect(host.querySelector('.settings-content')).toBeNull();
  });

  test('a section page: the nav lists every built section with the current one marked, and the section renders', async () => {
    const {modules} = await open('practice');
    const root = host.querySelector('.settings');
    expect(root.dataset.layout).toBe('split');
    expect(host.querySelectorAll('[data-scroller]')).toHaveLength(1);
    const nav = host.querySelector('nav.settings-nav');
    expect(nav.getAttribute('aria-label')).toBe(COPY.navLabel);
    expect(nav.querySelector('h1').textContent).toBe('Settings');
    expect(linkNames()).toEqual(['Practice', 'Instruments', 'Pedals & keys', 'Appearance', 'This device', 'Account']);
    expect(links().map(a => a.getAttribute('href'))).toEqual(['practice', 'instruments', 'pedals', 'appearance', 'device', 'account'].map(id => `/settings/${id}`));
    expect(links().map(a => a.dataset.focusKey)).toEqual(['practice', 'instruments', 'pedals', 'appearance', 'device', 'account'].map(id => `settings:${id}`));
    expect(links().filter(a => a.getAttribute('aria-current') === 'page').map(a => a.dataset.section)).toEqual(['practice']);
    const heading = host.querySelector('.settings-content h2');
    expect(heading.textContent).toBe('Practice');
    expect(host.querySelector('section.settings-content').getAttribute('aria-labelledby')).toBe(heading.id);
    expect(document.activeElement).toBe(heading);
    expect(host.querySelector('.fake-section').textContent).toBe('practice body');
    expect(document.title).toBe('Practice — Settings — Woodshed');
    expect(modules.lastCtx.headingId).toBe(heading.id);
    expect(modules.lastCtx.layout).toBe('split');
  });

  test('a nav click replaces the URL (Back leaves Settings, spec §1.2); the same section and modifier clicks do nothing', async () => {
    const {router} = await open('practice');
    const [practice, instruments] = links();
    practice.click();
    expect(router.navigate).not.toHaveBeenCalled();
    const modified = new MouseEvent('click', {bubbles: true, cancelable: true, metaKey: true});
    instruments.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(router.navigate).not.toHaveBeenCalled();
    const plain = new MouseEvent('click', {bubbles: true, cancelable: true});
    instruments.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(router.navigate).toHaveBeenCalledWith('/settings/instruments', {replace: true});
  });

  test('update() between sections swaps only the content: the old section is destroyed, focus stays on the nav', async () => {
    const {modules, log} = fakeModules();
    const {view} = await open('practice', {modules});
    const nav = host.querySelector('nav');
    links()[3].focus();
    await view.update(matchOf('appearance'));
    expect(host.querySelector('nav')).toBe(nav);
    expect(log).toEqual(['load:practice', 'render:practice', 'destroy:practice', 'load:appearance', 'render:appearance']);
    expect(host.querySelector('.settings-content h2').textContent).toBe('Appearance');
    expect(links().find(a => a.getAttribute('aria-current') === 'page').dataset.section).toBe('appearance');
    expect(document.activeElement).toBe(links()[3]);
    expect(host.querySelectorAll('.fake-section')).toHaveLength(1);
  });

  test('an unknown or unbuilt section is replaced by /settings', async () => {
    const {router} = await open('processing');
    expect(router.navigate).toHaveBeenCalledWith('/settings', {replace: true});
    const again = await open('nope');
    expect(again.router.navigate).toHaveBeenCalledWith('/settings', {replace: true});
  });

  test('a section that fails to load shows an alert with Try again, which loads it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const {modules, log} = fakeModules(undefined, {fail: new Set(['device'])});
    await open('device', {modules});
    const alert = host.querySelector('[role=alert]');
    expect(alert.textContent).toContain(COPY.loadFailed);
    alert.querySelector('button').click();
    await flush();
    expect(host.querySelector('.fake-section').textContent).toBe('device body');
    expect(log.filter(e => e === 'load:device')).toHaveLength(2);
  });

  test('a slow section never renders over a later one', async () => {
    let release;
    const hold = {practice: new Promise(resolve => { release = resolve; })};
    const {modules, log} = fakeModules(undefined, {hold});
    viewport(1440);
    const pending = mount(host, matchOf('practice'), {router: fakeRouter(), sectionModules: modules, platform: {}, desktop: {}});
    await flush();
    const view = await Promise.race([pending, flush().then(() => null)]);
    expect(view).toBeNull();   // mount waits for the section
    release();
    const v = await pending;
    await v.update(matchOf('account'));
    expect(log.filter(e => e.startsWith('render'))).toEqual(['render:practice', 'render:account']);
    expect(host.querySelector('.settings-content h2').textContent).toBe('Account');
  });

  test('a desktop-only section loaded on the web is replaced by /settings', async () => {
    const modules = {
      [sectionPath('practice')]: async () => ({default: {id: 'practice', title: 'Practice', desktopOnly: true, render: () => ({destroy() {}})}}),
    };
    const {router} = await open('practice', {modules});
    expect(router.navigate).toHaveBeenCalledWith('/settings', {replace: true});
  });

  test('unmount destroys the section, removes the view and restores the title', async () => {
    const {modules, log} = fakeModules();
    const {view} = await open('account', {modules});
    view.unmount();
    expect(log.at(-1)).toBe('destroy:account');
    expect(host.children).toHaveLength(0);
    expect(document.title).toBe('Woodshed');
  });
});

describe('iPad portrait: list → detail (stack)', () => {
  test('/settings is the list: 64 px rows with summaries, the heading focused', async () => {
    const {router} = await open(null, {width: 820});
    expect(router.navigate).not.toHaveBeenCalled();
    const root = host.querySelector('.settings');
    expect(root.dataset).toMatchObject({layout: 'stack', view: 'list'});
    const nav = host.querySelector('nav.settings-list');
    const h1 = nav.querySelector('h1');
    expect(nav.getAttribute('aria-labelledby')).toBe(h1.id);
    expect(document.activeElement).toBe(h1);
    expect(linkNames()).toEqual(['Practice', 'Instruments', 'Pedals & keys', 'Appearance', 'This device', 'Account']);
    expect(links()[0].querySelector('.settings-nav-summary').textContent).toBe(SECTIONS[0].summary);
    expect(links().some(a => a.hasAttribute('aria-current'))).toBe(false);
    expect(host.querySelector('.settings-content')).toBeNull();
    expect(document.title).toBe('Settings — Woodshed');
  });

  test('a list row pushes the detail page with the list as its origin', async () => {
    const {router} = await open(null, {width: 820});
    links()[4].click();
    expect(router.navigate).toHaveBeenCalledWith('/settings/device', {state: {from: FROM_LIST}});
  });

  test('the detail page: "‹ Settings", the section as h1 (focused), no nav', async () => {
    await open('device', {width: 820, state: {from: FROM_LIST}});
    expect(host.querySelector('nav')).toBeNull();
    const back = host.querySelector('.settings-back');
    expect(back.textContent).toContain('Settings');
    const h1 = host.querySelector('.settings-content h1');
    expect(h1.textContent).toBe('This device');
    expect(document.activeElement).toBe(h1);
    expect(host.querySelector('.fake-section').textContent).toBe('device body');
  });

  test('Back rules: from the list, "‹ Settings" goes back; from a deep link it replaces the URL with the list', async () => {
    const fromList = await open('device', {width: 820, state: {from: FROM_LIST}});
    host.querySelector('.settings-back').click();
    expect(fromList.router.back).toHaveBeenCalledWith({fallback: '/settings'});
    expect(fromList.router.navigate).not.toHaveBeenCalled();
    fromList.view.unmount();
    const deep = await open('device', {width: 820});
    host.querySelector('.settings-back').click();
    expect(deep.router.back).not.toHaveBeenCalled();
    expect(deep.router.navigate).toHaveBeenCalledWith('/settings', {replace: true});
  });

  test('rotating re-renders in the other layout (150 ms after the last resize)', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const {modules, log} = fakeModules();
    viewport(1440);
    const pending = mount(host, matchOf('appearance'), {router: fakeRouter(), sectionModules: modules, platform: {}, desktop: {}});
    await vi.runAllTimersAsync();
    await pending;
    expect(host.querySelector('.settings').dataset.layout).toBe('split');
    viewport(820);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.querySelector('.settings').dataset.layout).toBe('split');
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();
    expect(host.querySelector('.settings').dataset).toMatchObject({layout: 'stack', view: 'detail'});
    expect(host.querySelector('.settings-back')).not.toBeNull();
    expect(log.filter(e => e.startsWith('render'))).toEqual(['render:appearance', 'render:appearance']);
    expect(log).toContain('destroy:appearance');
  });

  test('rotating the list to landscape replaces /settings with the first section', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const router = fakeRouter();
    viewport(820);
    const pending = mount(host, matchOf(null), {router, sectionModules: fakeModules().modules, platform: {}, desktop: {}});
    await vi.runAllTimersAsync();
    await pending;
    viewport(1180);
    await vi.advanceTimersByTimeAsync(200);
    expect(router.navigate).toHaveBeenCalledWith('/settings/practice', {replace: true});
  });
});

describe('section context', () => {
  test('sections get the app modules, overridable by the view context', async () => {
    const account = {tag: 'account'}, prefs = {tag: 'prefs'}, install = {tag: 'install'};
    const store = {session: signal(null)}, registry = createRegistry();
    const {modules} = await open('practice', {account, prefs, install, store, registry, feedback: {tag: 'fb'}});
    expect(modules.lastCtx).toMatchObject({account, prefs, install, store, registry, feedback: {tag: 'fb'}, layout: 'split'});
    expect(modules.lastCtx.router.navigate).toBeTypeOf('function');
  });
});

// ---------------------------------------------------------------------------------------------

describe('createSaver: "Saved" / "Couldn\'t save · [Retry]" (spec §6.2)', () => {
  test('success shows Saved in a status, which fades after 2 s', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const saver = createSaver();
    document.body.append(saver.el);
    await saver.run(() => Promise.resolve());
    const status = saver.el.querySelector('[role=status]');
    expect(status.textContent).toBe('Saved');
    expect(saver.state).toBe('saved');
    expect(saver.el.querySelector('[role=alert]').hidden).toBe(true);
    vi.advanceTimersByTime(SAVED_MS);
    expect(status.hasAttribute('data-fading')).toBe(true);
    vi.advanceTimersByTime(FADE_MS);
    expect(status.textContent).toBe('');
    expect(saver.state).toBe('idle');
    saver.destroy();
  });

  test('a synchronous write (device prefs) is Saved too', async () => {
    const saver = createSaver();
    expect(await saver.run(() => undefined)).toBe(true);
    expect(saver.el.textContent).toContain('Saved');
  });

  test('a failure shows an alert with Retry; Retry runs the same write again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    const saver = createSaver();
    document.body.append(saver.el);
    expect(await saver.run(fn)).toBe(false);
    const alert = saver.el.querySelector('[role=alert]');
    expect(alert.hidden).toBe(false);
    expect(alert.textContent.replace(/\s+/g, ' ')).toContain('Couldn’t save');
    const retry = alert.querySelector('button');
    expect(retry.textContent).toBe('Retry');
    expect(saver.state).toBe('failed');
    retry.click();
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(alert.hidden).toBe(true);
    expect(saver.el.textContent).toContain('Saved');
    saver.destroy();
  });

  test('a throw counts as a failure; only the latest write reports', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saver = createSaver();
    let rejectFirst;
    const first = saver.run(() => new Promise((_, reject) => { rejectFirst = reject; }));
    await saver.run(() => undefined);
    rejectFirst(new Error('late'));
    await first;
    expect(saver.state).toBe('saved');
    await saver.run(() => { throw new Error('sync'); });
    expect(saver.state).toBe('failed');
  });

  test('when Retry disappears under focus, focus goes where the row says', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = document.createElement('button');
    document.body.append(target);
    const saver = createSaver({focus: () => target});
    document.body.append(saver.el);
    await saver.run(() => Promise.reject(new Error('x')));
    const retry = saver.el.querySelector('.settings-save-retry');
    retry.focus();
    let resolve;
    saver.run(() => new Promise(r => { resolve = r; }));
    resolve();
    await flush();
    expect(document.activeElement).toBe(target);
    target.remove();
    saver.destroy();
  });
});

describe('settingRow and desktopNote', () => {
  test('a labelled group with its hint; device rows carry the "This device" tag (D40)', () => {
    const control = document.createElement('button');
    const saver = createSaver();
    const row = settingRow({row: 'distance', label: 'Distance', hint: 'How far', scope: 'device', controls: [control], saver});
    expect(row.el.getAttribute('role')).toBe('group');
    expect(document.getElementById.call(document, row.labelId)).toBeNull();   // not attached yet
    document.body.append(row.el);
    expect(document.getElementById(row.el.getAttribute('aria-labelledby')).textContent).toBe('Distance');
    expect(document.getElementById(row.el.getAttribute('aria-describedby')).textContent).toBe('How far');
    expect(row.el.dataset).toMatchObject({scope: 'device', row: 'distance'});
    expect(row.el.querySelector('.settings-scope').textContent).toBe('This device');
    expect(row.el.querySelector('.settings-row-control').contains(control)).toBe(true);
    expect(row.el.contains(saver.el)).toBe(true);
    row.el.remove();
    const plain = settingRow({row: 'x', scope: 'account', controls: [], labelId: 'r1', hint: 'h'});
    expect(plain.el.hasAttribute('role')).toBe(false);
    expect(plain.el.querySelector('.settings-scope')).toBeNull();
    expect(plain.hintId).toBe('r1-hint');
  });

  test('desktopNote: one line and Get it ↗ (a new tab to /download)', () => {
    const note = desktopNote(['Import an old library', 'Export original audio', 'Processing']);
    expect(note.textContent.replace(/\s+/g, ' ').trim()).toBe(
      'These need Woodshed for desktop: Import an old library, Export original audio, Processing. Get it ↗');
    const a = note.querySelector('a');
    expect([a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]).toEqual(['/download', '_blank', 'noopener']);
  });
});
