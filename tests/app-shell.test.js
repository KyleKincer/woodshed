// @vitest-environment happy-dom
// S1: the shell — index.html's head, the top bar (spec §2.1), the fatal card, the paused page and the
// banners (spec §2.7, §6.3), the global commands (§3.5), app data (§2.13), the dev handle (§11.4) and
// boot-common.
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createRegistry} from '../src/app/commands.js';
import {signal, store} from '../src/app/store.js';
import {closeAllMenus} from '../src/ui/menu.js';
import {installPopoverShim, restoreDomShims} from './helpers/dom.js';
import {mountTopbar, accountMenuItems, initialsOf, COPY, CONTROLS} from '../src/app/topbar.js';
import * as fatal from '../src/app/fatal.js';
import {startData, nextSongs, nextList} from '../src/app/data.js';
import {installDevHandle, sessionView, devHandleWanted} from '../src/app/dev-handle.js';
import {bootCommon, FONT_PRELOADS, preloadFonts} from '../src/app/boot-common.js';

const apiCalls = vi.hoisted(() => ({action: [], portalUrl: 'https://billing.example/portal', fail: false}));
vi.mock('../src/api/client.js', async importOriginal => ({
  ...(await importOriginal()),
  action: vi.fn(async (name, args) => {
    apiCalls.action.push([name, args]);
    if (apiCalls.fail) throw new Error('portal down');
    return apiCalls.portalUrl;
  }),
}));
const authCalls = vi.hoisted(() => ({signOut: 0}));
vi.mock('../src/app/auth.js', async importOriginal => ({...(await importOriginal()), signOut: vi.fn(async () => { authCalls.signOut++; })}));
const exportCalls = vi.hoisted(() => ({count: 0, error: null}));
vi.mock('../src/js/export.js', () => ({exportLibrary: vi.fn(async onProgress => {
  exportCalls.count++;
  if (exportCalls.error) throw exportCalls.error;
  onProgress('Exporting 1/2: Song');
})}));
// S2's modules (same wave): global-commands.js imports them statically.
vi.mock('../src/app/palette.js', () => ({openPalette: vi.fn(() => ({close() {}}))}));
vi.mock('../src/app/shortcuts-sheet.js', () => ({openShortcuts: vi.fn(() => ({close() {}}))}));

const repo = (...parts) => join(process.cwd(), ...parts);
const S2_PEERS = ['src/app/palette.js', 'src/app/shortcuts-sheet.js'];
const missingPeers = S2_PEERS.filter(p => !existsSync(repo(p)));

const root = document.documentElement;

afterEach(() => {
  closeAllMenus();
  restoreDomShims();
  document.body.replaceChildren();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------

describe('index.html', () => {
  const html = readFileSync(repo('index.html'), 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = name => doc.head.querySelector(`meta[name="${name}"]`)?.getAttribute('content');

  test('the head: viewport-fit=cover, manifest, Apple web-app tags, touch icon, theme-color, theme-init first', () => {
    expect(meta('viewport').split(',').map(s => s.trim())).toEqual(['width=device-width', 'initial-scale=1', 'viewport-fit=cover']);
    expect(doc.head.querySelector('link[rel=manifest]').getAttribute('href')).toBe('/manifest.webmanifest');
    expect(meta('apple-mobile-web-app-capable')).toBe('yes');
    expect(meta('apple-mobile-web-app-status-bar-style')).toBe('black-translucent');
    expect(doc.head.querySelector('link[rel=apple-touch-icon]').getAttribute('href')).toBe('/icon-180.png');
    expect(meta('theme-color')).toMatch(/^#[0-9a-f]{6}$/i);
    const scripts = [...doc.querySelectorAll('script')];
    expect(scripts[0].getAttribute('src')).toBe('/theme-init.js');
    expect(scripts[0].getAttribute('type')).toBeNull();
    expect(doc.documentElement.dataset.startup).toBe('loading');
  });

  test('the body: #app, the #startup status and the module entry, with no view markup', () => {
    const children = [...doc.body.children];
    expect(children.map(el => el.id || el.tagName)).toEqual(['app', 'startup', 'SCRIPT']);
    expect(doc.getElementById('app').childElementCount).toBe(0);
    expect(doc.getElementById('startup').getAttribute('role')).toBe('status');
    const entry = doc.body.querySelector('script[type=module]');
    expect(entry.getAttribute('src')).toBe('/src/app/main.js');
    expect(html).not.toMatch(/stylesheet/);
  });

  test('every file the head links exists in public/', () => {
    for (const el of doc.head.querySelectorAll('link[href], script[src]')) {
      const href = el.getAttribute('href') ?? el.getAttribute('src');
      expect(existsSync(repo('public', href)), href).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('the top bar (spec §2.1)', () => {
  let topbar, el, registry, router, desktop;

  const IDS = ['nav.settings', 'nav.plan', 'app.shortcuts', 'app.updates', 'app.download', 'nav.admin', 'app.signOut'];
  beforeEach(() => {
    installPopoverShim();
    registry = createRegistry();
    for (const id of IDS) registry.register({id, title: `Title ${id}`, group: 'App', run: vi.fn(), ...(id === 'app.shortcuts' ? {keys: ['?'], scopes: ['global']} : {})});
    router = {navigate: vi.fn(), setQuery: vi.fn(), href: vi.fn((name, params, query) => `/?q=${query.q}`), current: signal({name: 'settings'})};
    desktop = {available: false};
    store.session.value = {user: {id: 'u1', name: 'Kyle Kincer', email: 'kyle@example.com', image: null}, admin: false, status: 'active', online: true};
    store.update.value = {status: 'idle'};
    el = document.createElement('header');
    document.body.append(el);
    topbar = mountTopbar(el, {router, store, desktop, registry});
  });
  afterEach(() => topbar.destroy());

  test('left to right: wordmark (Home link), search with the ⌘K hint, Jobs slot, Add song, avatar', () => {
    const bar = el.querySelector('.shell-topbar');
    const wordmark = bar.querySelector('a');
    expect(wordmark.getAttribute('href')).toBe('/');
    expect(wordmark.textContent).toBe('Woodshed');
    const input = bar.querySelector('input[type=search]');
    expect(input.placeholder).toBe('Search songs, artists, sections…');
    expect(bar.querySelector('[role=search]').contains(input)).toBe(true);
    expect(bar.querySelector('kbd').getAttribute('aria-hidden')).toBe('true');
    expect(bar.querySelector('kbd').textContent).toMatch(/K$/);
    const order = [...bar.querySelectorAll('a, input, [data-jobs-slot], button')].map(n => n.tagName === 'A' ? 'home'
      : n.tagName === 'INPUT' ? 'search' : n.hasAttribute('data-jobs-slot') ? 'jobs' : n.classList.contains('shell-avatar') ? 'avatar' : 'add');
    expect(order).toEqual(['home', 'search', 'jobs', 'add', 'avatar']);
    expect(el.classList.contains('app-topbar')).toBe(true);
  });

  test('CONTROLS: each control renders with its role and accessible name', () => {
    const roleOf = n => n.getAttribute('role') ?? ({A: 'link', BUTTON: 'button'}[n.tagName]) ?? (n.type === 'search' ? 'searchbox' : null);
    const nameOf = n => (n.getAttribute('aria-label') ?? n.textContent).trim();
    for (const row of CONTROLS) {
      const hit = [...el.querySelectorAll('a, button, input')].find(n => roleOf(n) === row.role && nameOf(n) === row.name);
      expect(hit, `${row.role} "${row.name}"`).toBeDefined();
    }
  });

  test('Add song opens /add', () => {
    [...el.querySelectorAll('button')].find(b => b.textContent.includes(COPY.add)).click();
    expect(router.navigate).toHaveBeenCalledWith('/add');
  });

  test('the avatar menu on the web: email, Settings, Plan & storage, Keyboard shortcuts ?, Get the desktop app, Sign out', () => {
    const avatar = el.querySelector('.shell-avatar');
    expect(avatar.getAttribute('aria-haspopup')).toBe('menu');
    avatar.click();
    expect(avatar.getAttribute('aria-expanded')).toBe('true');
    const menu = document.querySelector('[role=menu]');
    const labels = [...menu.querySelectorAll('.ui-menu-label')].map(n => n.textContent);
    expect(labels).toEqual(['kyle@example.com', 'Title nav.settings', 'Title nav.plan', 'Title app.shortcuts', 'Title app.download', 'Title app.signOut']);
    const shortcuts = [...menu.querySelectorAll('[role=menuitem]')].find(r => r.textContent.includes('app.shortcuts'));
    expect(shortcuts.getAttribute('aria-keyshortcuts')).toBe('?');
    const settings = [...menu.querySelectorAll('[role=menuitem]')].find(r => r.textContent.includes('nav.settings'));
    expect(settings.hasAttribute('aria-keyshortcuts')).toBe(false);   // ⌘, only on the desktop app
    expect(menu.querySelector('[role=menuitem]').getAttribute('aria-disabled')).toBe('true');   // the email row
    avatar.click();
    expect(avatar.getAttribute('aria-expanded')).toBe('false');
  });

  test('a menu row runs its command through the registry', () => {
    el.querySelector('.shell-avatar').click();
    const row = [...document.querySelectorAll('[role=menuitem]')].find(r => r.textContent.includes('nav.plan'));
    row.click();
    expect(registry.get('nav.plan').run).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['web', {session: {admin: false}, desktopApp: false}, ['account.email', 'nav.settings', 'nav.plan', 'app.shortcuts', 'app.download', 'app.signOut']],
    ['desktop', {session: {admin: false}, desktopApp: true}, ['account.email', 'nav.settings', 'nav.plan', 'app.shortcuts', 'app.updates', 'app.signOut']],
    ['admin', {session: {admin: true}, desktopApp: false}, ['account.email', 'nav.settings', 'nav.plan', 'app.shortcuts', 'app.download', 'nav.admin', 'app.signOut']],
  ])('accountMenuItems (%s)', (_, opts, ids) => {
    const items = accountMenuItems(opts);
    expect(items.filter(i => i.type !== 'separator').map(i => i.command ?? i.id)).toEqual(ids);
    expect(items.find(i => i.command === 'nav.settings').kbd).toBe(opts.desktopApp ? 'Mod+,' : undefined);
  });

  test('an 8 px dot on the avatar marks a ready desktop update', () => {
    const avatar = el.querySelector('.shell-avatar');
    const dot = avatar.querySelector('.shell-avatar-dot');
    expect(dot.hidden).toBe(true);
    expect(avatar.getAttribute('aria-label')).toBe(COPY.account);
    store.update.value = {status: 'downloading', percent: 40};
    expect(dot.hidden).toBe(true);
    store.update.value = {status: 'ready', version: '2.0.1'};
    expect(dot.hidden).toBe(false);
    expect(avatar.getAttribute('aria-label')).toBe(COPY.accountUpdate);
  });

  test('a picture that failed to load stays replaced by initials across session updates, until the image changes', () => {
    const img = el.querySelector('.shell-avatar-image');
    const initials = el.querySelector('.shell-avatar-initials');
    store.session.value = {...store.session.peek(), user: {...store.session.peek().user, image: 'https://img.example/broken.png'}};
    expect(img.hidden).toBe(false);
    img.dispatchEvent(new Event('error'));
    expect(img.hidden).toBe(true);
    expect(initials.hidden).toBe(false);
    store.session.value = {...store.session.peek(), online: false};
    store.session.value = {...store.session.peek(), online: true, status: 'export_only'};
    expect(img.hidden).toBe(true);
    expect(initials.hidden).toBe(false);
    store.session.value = {...store.session.peek(), user: {...store.session.peek().user, image: 'https://img.example/new.png'}};
    expect(img.getAttribute('src')).toBe('https://img.example/new.png');
    expect(img.hidden).toBe(false);
    expect(initials.hidden).toBe(true);
  });

  test('the avatar shows the picture, else initials', () => {
    const img = el.querySelector('.shell-avatar-image');
    const initials = el.querySelector('.shell-avatar-initials');
    expect(img.hidden).toBe(true);
    expect(initials.textContent).toBe('KK');
    store.session.value = {...store.session.peek(), user: {id: 'u1', name: '', email: 'sam@example.com', image: 'https://img.example/a.png'}};
    expect(img.hidden).toBe(false);
    expect(img.getAttribute('src')).toBe('https://img.example/a.png');
    expect(img.getAttribute('alt')).toBe('');
    expect(initials.hidden).toBe(true);
    expect(initialsOf({email: 'sam@example.com'})).toBe('S');
    expect(initialsOf({name: 'Dana  Ruiz Lopez'})).toBe('DR');
    expect(initialsOf(null)).toBe('·');
  });

  test('typing outside the Library opens it filtered; inside it, ?q= follows (replace, 400 ms)', () => {
    const input = el.querySelector('input');
    input.value = 'glass';
    input.dispatchEvent(new Event('input'));
    expect(router.navigate).toHaveBeenCalledWith('/?q=glass');
    router.current.value = {name: 'library'};
    input.value = 'glassh';
    input.dispatchEvent(new Event('input'));
    expect(router.setQuery).toHaveBeenCalledWith({q: 'glassh'}, {debounceMs: 400});
  });

  test('setSearch hands the field to the Library and back; clearSearch empties it through the handler', () => {
    const onInput = vi.fn(), onKeydown = vi.fn();
    topbar.setSearch({value: 'drums', onInput, onKeydown});
    const input = el.querySelector('input');
    expect(input.value).toBe('drums');
    input.value = 'drum';
    input.dispatchEvent(new Event('input'));
    expect(onInput).toHaveBeenCalledWith('drum', expect.any(Event));
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));
    expect(onKeydown).toHaveBeenCalledTimes(1);
    expect(router.navigate).not.toHaveBeenCalled();
    expect(topbar.searchValue).toBe('drum');
    expect(topbar.clearSearch()).toBe(true);
    expect(onInput).toHaveBeenLastCalledWith('', null);
    expect(topbar.clearSearch()).toBe(false);
    input.focus();
    input.value = 'typing';
    topbar.setSearch({value: 'stale', onInput});
    expect(input.value).toBe('typing');   // never overwrite what the user is typing
    topbar.setSearch(null);
    expect(input.value).toBe('typing');
    input.blur();
    topbar.setSearch(null);
    expect(input.value).toBe('');
  });

  test('focusSearch focuses the field; the Jobs slot takes a node and hands it back', () => {
    topbar.focusSearch();
    expect(document.activeElement).toBe(el.querySelector('input'));
    const chip = document.createElement('button');
    chip.textContent = '2 splitting';
    topbar.setJobsSlot(chip);
    expect(topbar.jobsSlot.firstChild).toBe(chip);
    topbar.setJobsSlot(null);
    expect(topbar.jobsSlot.childElementCount).toBe(0);
  });

  test('destroy removes the bar and stops following the store', () => {
    topbar.destroy();
    expect(el.childElementCount).toBe(0);
    store.update.value = {status: 'ready'};
    topbar = {destroy() {}};
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('the fatal card, the paused page and the banners (spec §2.7, §6.3)', () => {
  let el;
  beforeEach(() => {
    el = document.createElement('main');
    document.body.append(el);
    apiCalls.action.length = 0;
    apiCalls.fail = false;
    authCalls.signOut = 0;
    exportCalls.count = 0;
    exportCalls.error = null;
  });

  test('renderFatal: a 480 px card with the copy, Retry (focused) and the raw details behind Details, with Copy', async () => {
    const onRetry = vi.fn();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true});
    const err = Object.assign(new Error('[CONVEX Q(users:me)] Connection lost'), {name: 'AuthError'});
    fatal.renderFatal(el, {details: err, onRetry});
    const card = el.querySelector('.shell-fatal');
    expect(card.getAttribute('role')).toBe('alert');
    expect(card.querySelector('h1').textContent).toBe('Couldn’t open Woodshed');
    expect(card.textContent).toContain('Check your connection and try again.');
    expect(el.querySelector('[data-scroller]')).not.toBeNull();
    const retry = [...card.querySelectorAll('button')].find(b => b.textContent === 'Retry');
    expect(document.activeElement).toBe(retry);
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    const details = card.querySelector('details');
    expect(details.open).toBe(false);
    expect(details.querySelector('summary').textContent).toBe('Details');
    expect(details.querySelector('pre').textContent).toBe('AuthError: [CONVEX Q(users:me)] Connection lost');
    const copy = [...details.querySelectorAll('button')].find(b => b.textContent === 'Copy');
    copy.click();
    await vi.waitFor(() => expect(copy.textContent).toBe('Copied'));
    expect(writeText).toHaveBeenCalledWith('AuthError: [CONVEX Q(users:me)] Connection lost');
  });

  test('renderFatal details: a cause chain, an object, nothing', () => {
    const outer = new Error('outer', {cause: new Error('inner')});
    fatal.renderFatal(el, {details: outer});
    expect(el.querySelector('pre').textContent).toBe('outer\ninner');
    fatal.renderFatal(el, {details: {code: 'timeout'}});
    expect(el.querySelector('pre').textContent).toBe('{\n  "code": "timeout"\n}');
    fatal.renderFatal(el, {});
    expect(el.querySelector('pre').textContent).toBe(fatal.COPY.noDetails);
  });

  test('renderPaused: the title, the reason and Manage billing / Export library / Sign out', async () => {
    const win = {location: {assign: vi.fn(), reload: vi.fn()}};
    fatal.renderPaused(el, {status: 'suspended', win});
    const card = el.querySelector('.shell-paused');
    expect(card.querySelector('h1').textContent).toBe('Your account is paused');
    expect(card.textContent).toContain(fatal.COPY.reasons.suspended);
    const button = name => [...card.querySelectorAll('button')].find(b => b.textContent.includes(name));
    button('Manage billing').click();
    await vi.waitFor(() => expect(win.location.assign).toHaveBeenCalledWith('https://billing.example/portal'));
    expect(apiCalls.action).toEqual([['billing:portal', {}]]);
    button('Export library').click();
    await vi.waitFor(() => expect(card.textContent).toContain(fatal.COPY.exported));
    expect(exportCalls.count).toBe(1);
    button('Sign out').click();
    await vi.waitFor(() => expect(win.location.reload).toHaveBeenCalled());
    expect(authCalls.signOut).toBe(1);
  });

  test('renderPaused: an export failure reads as copy, never a raw TypeError', async () => {
    exportCalls.error = new TypeError('Cannot read properties of null (reading \'query\')');
    fatal.renderPaused(el, {status: 'suspended', win: {location: {assign: vi.fn()}}});
    [...el.querySelectorAll('button')].find(b => b.textContent.includes('Export library')).click();
    await vi.waitFor(() => expect(el.querySelector('[role=alert]')?.textContent).toBe('The export didn’t finish. Try again.'));
    expect(el.textContent).not.toContain('Cannot read properties');
  });

  test('exportFailedText: export.js\'s own sentences stay; backend codes read through error-copy; the rest say Try again', async () => {
    const {ApiError} = await import('../src/api/client.js');
    const {describeError} = await import('../src/app/error-copy.js');
    const big = 'This browser cannot stream a large archive to disk. Export from Chrome or Edge on a desktop.';
    expect(fatal.exportFailedText(new Error(big))).toBe(`The export didn’t finish. ${big}`);
    expect(fatal.exportFailedText(new TypeError('x is null'))).toBe('The export didn’t finish. Try again.');
    expect(fatal.exportFailedText(null)).toBe('The export didn’t finish. Try again.');
    const apiErr = new ApiError({code: 'account_suspended', message: 'raw server text'});
    expect(fatal.exportFailedText(apiErr)).toBe(`The export didn’t finish. ${describeError(apiErr, {context: 'job'}).sentence}`);
    expect(fatal.exportFailedText(apiErr)).not.toContain('raw server text');
  });

  test('the shell never reaches the 1.9 backend client statically (§0.1)', () => {
    for (const file of ['main', 'routes', 'topbar', 'fatal', 'placeholder', 'data', 'global-commands', 'boot-common', 'dev-handle']) {
      const src = readFileSync(repo('src/app', `${file}.js`), 'utf8');
      expect(src, file).not.toMatch(/from\s+['"][^'"]*js\/(backend|auth)\.js['"]/);
    }
  });

  test('renderPaused: a billing failure shows inline; a given reason wins', async () => {
    apiCalls.fail = true;
    fatal.renderPaused(el, {status: 'suspended', reason: 'Payment failed.', win: {location: {assign: vi.fn()}}});
    expect(el.textContent).toContain('Payment failed.');
    [...el.querySelectorAll('button')].find(b => b.textContent.includes('Manage billing')).click();
    await vi.waitFor(() => expect(el.querySelector('[role=alert]')?.textContent).toContain(fatal.COPY.billingFailed));
  });

  test('CONTROLS: each control renders with its role and accessible name', () => {
    const roleOf = n => n.tagName === 'SUMMARY' ? 'disclosure' : n.getAttribute('role') ?? ({BUTTON: 'button'}[n.tagName]);
    const parts = {
      fatal: () => fatal.renderFatal(el, {details: 'x'}),
      paused: () => fatal.renderPaused(el, {status: 'suspended'}),
      'banner:export-only': () => fatal.mountBanners(el, {store: {session: signal({status: 'export_only'})}, platform: {online: signal(true)}}),
      'banner:codec': () => fatal.mountBanners(el, {store: {session: signal({status: 'active'})}, platform: {online: signal(true)}, codecSupported: false}),
    };
    for (const row of fatal.CONTROLS) {
      el.replaceChildren();
      parts[row.where]();
      const hit = [...el.querySelectorAll('button, summary')].find(n => roleOf(n) === row.role && (n.getAttribute('aria-label') ?? n.textContent).trim() === row.name);
      expect(hit, `${row.where}: ${row.role} "${row.name}"`).toBeDefined();
    }
  });

  test('banners: offline follows platform.online, export-only follows the session, codec until dismissed', () => {
    const online = signal(true);
    const session = signal({status: 'active'});
    const navigate = vi.fn();
    const banners = fatal.mountBanners(el, {store: {session}, platform: {online}, codecSupported: false, navigate});
    expect(el.getAttribute('role')).toBe('region');
    expect(el.getAttribute('aria-label')).toBe('Notices');
    const kinds = () => [...el.children].map(b => b.dataset.banner);
    expect(kinds()).toEqual(['codec']);
    expect(el.textContent).toContain('This browser can’t play Woodshed’s audio format.');
    online.value = false;
    session.value = {status: 'export_only'};
    expect(kinds()).toEqual(['offline', 'export-only', 'codec']);
    expect(el.textContent).toContain('You’re offline. Songs you’ve opened recently can still play.');
    expect(el.textContent).toContain('Adding songs is paused on this account.');
    [...el.querySelectorAll('button')].find(b => b.textContent === 'Plan & storage').click();
    expect(navigate).toHaveBeenCalledWith('/settings/plan');
    [...el.querySelectorAll('button')].find(b => b.textContent === 'Dismiss').click();
    expect(kinds()).toEqual(['offline', 'export-only']);
    online.value = true;
    session.value = {status: 'active'};
    expect(kinds()).toEqual([]);
    expect(el.hidden).toBe(true);
    banners.destroy();
    online.value = false;
    expect(el.childElementCount).toBe(0);
  });

  test('banners: none show while `visible` is false (a full-bleed place), and they come back with it', () => {
    const visible = signal(false);
    const online = signal(false);
    fatal.mountBanners(el, {store: {session: signal({status: 'export_only'})}, platform: {online}, codecSupported: false, visible});
    expect(el.childElementCount).toBe(0);
    expect(el.hidden).toBe(true);
    visible.value = true;
    expect([...el.children].map(b => b.dataset.banner)).toEqual(['offline', 'export-only', 'codec']);
    expect(el.hidden).toBe(false);
    visible.value = false;
    online.value = true;
    expect(el.childElementCount).toBe(0);
  });

  test('banners are in flow (never fixed) and the offline one is a status, not an alert', () => {
    fatal.mountBanners(el, {store: {session: signal({status: 'active'})}, platform: {online: signal(false)}});
    const banner = el.firstElementChild;
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.style.position).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe.skipIf(missingPeers.length)('global commands (§3.5)', () => {
  let reg, gc, router, feedback, topbar, library, stageCtx, st, desktop, platform, palette, shortcuts, signOut, win, off;

  beforeEach(async () => {
    gc = await import('../src/app/global-commands.js');
    palette = vi.fn();
    shortcuts = vi.fn();
    signOut = vi.fn();
    reg = createRegistry();
    st = {session: signal({user: {id: 'u'}, admin: false, status: 'active', online: true}), update: signal({status: 'idle'}), stage: signal(null)};
    desktop = {available: false, update: vi.fn()};
    platform = {isIPad: false};
    win = {open: vi.fn()};
    router = {navigate: vi.fn()};
    feedback = {status: vi.fn()};
    topbar = {searchValue: '', clearSearch: vi.fn(() => true), jobsSlot: document.createElement('div')};
    library = null;
    stageCtx = {toggleFocus: vi.fn()};
    off = gc.defineGlobalCommands({registry: reg, store: st, platform, desktop, openPalette: palette, openShortcuts: shortcuts, signOut, later: {}, win});
    reg.provide('router', () => router);
    reg.provide('feedback', () => feedback);
    reg.provide('topbar', () => topbar);
    reg.provide('library', () => library);
    reg.provide('stage', () => stageCtx);
    root.dataset.place = 'library';
    delete root.dataset.posture;
  });
  afterEach(() => { off(); delete root.dataset.place; delete root.dataset.posture; });

  // id, title, keys, scopes
  const TABLE = [
    ['app.palette', 'Command palette', ['Mod+KeyK'], ['global']],
    ['app.shortcuts', 'Keyboard shortcuts', ['?'], ['global']],
    ['app.escape', 'Close / back', ['Escape'], ['global']],
    ['nav.library', 'Library', [], []],
    ['nav.settings', 'Settings…', [], []],
    ['nav.plan', 'Plan & storage', [], []],
    ['nav.admin', 'Administration', [], []],
    ['app.updates', 'App updates', [], []],
    ['app.download', 'Get the desktop app', [], []],
    ['app.signOut', 'Sign out', [], []],
    ['library.jobs', 'Jobs', [], []],
    ['library.demo', 'Open the example song', [], []],
  ];
  test.each(TABLE)('%s: "%s", keys %j in %j', (id, title, keys, scopes) => {
    const def = reg.get(id);
    expect(reg.titleFor(id)).toBe(title);
    expect(def.keys).toEqual(keys);
    expect(def.scopes).toEqual(scopes);
    expect(['App', 'Library']).toContain(def.group);
  });

  test('nav.settings.<section>: one command per Settings section, in the palette', () => {
    const fam = reg.dynamicFamilies().find(f => f.template === 'nav.settings.{n}');
    expect(fam.ids).toEqual(gc.SETTINGS_SECTIONS.map(s => `nav.settings.${s}`));
    expect(reg.titleFor('nav.settings.pedals')).toBe('Settings: Pedals & keys');
    expect(reg.titleFor('nav.settings.device')).toBe('Settings: This device');
    reg.run('nav.settings.processing');
    expect(router.navigate).toHaveBeenCalledWith('/settings/processing');
  });

  test.each([
    ['nav.library', '/'], ['nav.settings', '/settings'], ['nav.plan', '/settings/plan'],
  ])('%s navigates to %s', (id, path) => {
    expect(reg.run(id)).toBe(true);
    expect(router.navigate).toHaveBeenCalledWith(path);
  });

  test('the palette, the ? sheet and sign-out', () => {
    reg.run('app.palette');
    reg.run('app.shortcuts');
    reg.run('app.signOut');
    expect([palette.mock.calls.length, shortcuts.mock.calls.length, signOut.mock.calls.length]).toEqual([1, 1, 1]);
  });

  test('Administration only for admins', () => {
    expect(reg.isEnabled('nav.admin')).toBe(false);
    expect(reg.run('nav.admin')).toBe(false);
    st.session.value = {...st.session.peek(), admin: true};
    expect(reg.run('nav.admin')).toBe(true);
    expect(router.navigate).toHaveBeenCalledWith('/admin');
  });

  test('web: Get the desktop app opens /download in a new tab; App updates is hidden', () => {
    expect(reg.isEnabled('app.updates')).toBe(false);
    reg.run('app.download');
    expect(win.open).toHaveBeenCalledWith('/download', '_blank', 'noopener');
  });

  test('desktop: App updates shows main\'s update UI and names the update state', () => {
    desktop.available = true;
    expect(reg.isEnabled('app.download')).toBe(false);
    reg.run('app.updates');
    expect(desktop.update).toHaveBeenCalledWith('show');
    st.update.value = {status: 'downloading', percent: 40.4};
    expect(reg.titleFor('app.updates')).toBe('Downloading update 40%');
    st.update.value = {status: 'ready'};
    expect(reg.titleFor('app.updates')).toBe('Update ready — Restart to install');
    expect(gc.updateTitle({status: 'available'})).toBe('App updates');
  });

  test('Jobs and the demo stay hidden until their modules exist, then load them on demand', async () => {
    expect(reg.isEnabled('library.jobs')).toBe(false);
    expect(reg.isEnabled('library.demo')).toBe(false);
    off();
    const openJobsPopover = vi.fn(), openDemo = vi.fn();
    off = gc.defineGlobalCommands({registry: reg, store: st, platform, desktop, openPalette: palette, openShortcuts: shortcuts, signOut, win,
      later: {'../library/jobs.js': async () => ({openJobsPopover}), '../share/demo.js': async () => ({openDemo})}});
    expect(reg.run('library.jobs')).toBe(true);
    await vi.waitFor(() => expect(openJobsPopover).toHaveBeenCalledWith({anchor: topbar.jobsSlot, focusJobId: null}));
    expect(reg.run('library.demo')).toBe(true);
    await vi.waitFor(() => expect(openDemo).toHaveBeenCalledWith(router));
  });

  describe('app.escape (layered)', () => {
    const stage = (state, {iPad = false} = {}) => {
      root.dataset.place = 'stage';
      root.dataset.posture = 'stage';
      st.stage.value = {songId: 's', layout: 'rail', surface: 'chart', playing: false, focus: false, ...state};
      platform.isIPad = iPad;
    };
    const leave = vi.fn();
    beforeEach(() => {
      leave.mockClear();
      reg.register({id: 'stage.leave', title: 'Back to Library', group: 'App', scopes: ['stage'], run: leave});
    });

    test('Stage with Focus on: leaves Focus', () => {
      stage({focus: true, playing: true});
      expect(reg.run('app.escape')).toBe(true);
      expect(stageCtx.toggleFocus).toHaveBeenCalledTimes(1);
      expect(leave).not.toHaveBeenCalled();
    });

    test('Stage while playing: the status line says to stop first; Esc never navigates', () => {
      stage({playing: true});
      expect(reg.run('app.escape')).toBe(true);
      expect(feedback.status).toHaveBeenCalledWith('Stop playback first (Space)');
      expect(leave).not.toHaveBeenCalled();
    });

    test('Stage, stopped, laptop: back to the Library through stage.leave', () => {
      stage({});
      expect(reg.run('app.escape')).toBe(true);
      expect(leave).toHaveBeenCalledTimes(1);
    });

    test('Stage, stopped, iPad: Esc does nothing (‹ leaves)', () => {
      stage({}, {iPad: true});
      expect(reg.isEnabled('app.escape')).toBe(false);
      expect(reg.run('app.escape')).toBe(false);
      expect(leave).not.toHaveBeenCalled();
    });

    test('Edit: no binding here (edit.done shadows Esc in the edit scope)', () => {
      root.dataset.place = 'edit';
      root.dataset.posture = 'edit';
      expect(reg.isEnabled('app.escape')).toBe(false);
    });

    test('Library: clears the search first, then exits selection, then nothing', () => {
      topbar.searchValue = 'glass';
      library = {selecting: true, exitSelection: vi.fn()};
      reg.run('app.escape');
      expect(topbar.clearSearch).toHaveBeenCalledTimes(1);
      expect(library.exitSelection).not.toHaveBeenCalled();
      topbar.searchValue = '';
      reg.run('app.escape');
      expect(library.exitSelection).toHaveBeenCalledTimes(1);
      library = {selecting: false, exitSelection: vi.fn()};
      expect(reg.isEnabled('app.escape')).toBe(false);
    });

    test('Settings: nothing to do', () => {
      root.dataset.place = 'settings';
      topbar.searchValue = 'x';
      expect(reg.isEnabled('app.escape')).toBe(false);
    });
  });

  test('importing the module registers the commands on the app registry (main.js, registry CI)', async () => {
    const {registry} = await import('../src/app/commands.js');
    for (const [id] of TABLE) expect(registry.get(id), id).not.toBeNull();
    expect(registry.get('nav.settings.account')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('app data (startData)', () => {
  let subs, lib, st;
  beforeEach(() => {
    subs = {};
    lib = {songs: signal(new Map()), loaded: signal(false), jobs: signal([]), uploads: signal([]), devices: signal([]), setlists: signal([])};
    st = {library: lib};
  });

  const api = () => ({songs: {subscribeList: (v, e) => { subs.songs = {v, e}; return () => { subs.songs.off = true; }; }},
    jobs: {subscribeActive: v => { subs.jobs = {v}; return () => {}; }},
    devices: {subscribeList: v => { subs.devices = {v}; return () => {}; }},
    setlists: {subscribeList: v => { subs.setlists = {v}; return () => {}; }}});

  test('songs.list fills the map by id; loaded flips after the first list; unchanged rows keep their object', () => {
    const stop = startData({store: st, api: api()});
    expect(lib.loaded.value).toBe(false);
    const a = {id: 'a', title: 'A'}, b = {id: 'b', title: 'B'};
    subs.songs.v({songs: [a, b]});
    expect(lib.loaded.value).toBe(true);
    expect([...lib.songs.value.keys()]).toEqual(['a', 'b']);
    const first = lib.songs.value;
    subs.songs.v({songs: [{id: 'a', title: 'A'}, {id: 'b', title: 'B'}]});
    expect(lib.songs.value).toBe(first);   // nothing changed: no notification
    subs.songs.v({songs: [{id: 'a', title: 'A'}, {id: 'b', title: 'B2'}, {id: 'c', title: 'C'}]});
    expect(lib.songs.value).not.toBe(first);
    expect(lib.songs.value.get('a')).toBe(a);
    expect(lib.songs.value.get('b').title).toBe('B2');
    expect([...lib.songs.value.keys()]).toEqual(['a', 'b', 'c']);
    stop();
    expect(subs.songs.off).toBe(true);
    stop();
  });

  test('jobs, devices and setlists go to their slices; uploads are left alone', () => {
    startData({store: st, api: api()});
    const uploads = lib.uploads.value;
    subs.jobs.v([{jobId: 'j1', status: 'running'}]);
    subs.devices.v([{deviceId: 'd1', name: 'MacBook Pro'}]);
    subs.setlists.v([{id: 'set-1', name: 'Friday'}]);
    expect(lib.jobs.value.map(j => j.jobId)).toEqual(['j1']);
    expect(lib.devices.value.map(d => d.name)).toEqual(['MacBook Pro']);
    expect(lib.setlists.value.map(s => s.name)).toEqual(['Friday']);
    expect(lib.uploads.value).toBe(uploads);
  });

  test('jobs (jobId) and devices (deviceId) rows are reused by their own keys; an unchanged result keeps the array', () => {
    startData({store: st, api: api()});
    const jobs = [{jobId: 'a', status: 'running', progress: 0.1}, {jobId: 'b', status: 'queued', progress: 0}];
    subs.jobs.v(jobs);
    const first = lib.jobs.value;
    subs.jobs.v(structuredClone(jobs));
    expect(lib.jobs.value).toBe(first);
    subs.jobs.v([{...jobs[0], progress: 0.5}, {...jobs[1]}]);
    expect(lib.jobs.value).not.toBe(first);
    expect(lib.jobs.value[0].progress).toBe(0.5);
    expect(lib.jobs.value[1]).toBe(first[1]);

    const devices = [{deviceId: 'd1', name: 'MacBook Pro'}, {deviceId: 'd2', name: 'Studio'}];
    subs.devices.v(devices);
    const firstDevices = lib.devices.value;
    subs.devices.v(structuredClone(devices));
    expect(lib.devices.value).toBe(firstDevices);
    subs.devices.v([{deviceId: 'd1', name: 'Laptop'}, {deviceId: 'd2', name: 'Studio'}]);
    expect(lib.devices.value[0].name).toBe('Laptop');
    expect(lib.devices.value[1]).toBe(firstDevices[1]);
  });

  test('a subscription error is reported, not thrown', () => {
    const onError = vi.fn();
    startData({store: st, api: api(), onError});
    subs.songs.e(new Error('account_suspended'));
    expect(onError).toHaveBeenCalledWith('songs.list', expect.any(Error));
  });

  test('nextSongs and nextList reuse by id and content, and detect order changes', () => {
    const a = {id: 'a', n: 1}, b = {id: 'b', n: 2};
    const prev = new Map([['a', a], ['b', b]]);
    expect(nextSongs(prev, [{id: 'a', n: 1}, {id: 'b', n: 2}])).toBe(prev);
    const swapped = nextSongs(prev, [{id: 'b', n: 2}, {id: 'a', n: 1}]);
    expect(swapped).not.toBe(prev);
    expect(swapped.get('a')).toBe(a);
    expect(nextSongs(prev, [{id: 'a', n: 1}]).size).toBe(1);
    const list = [a, b];
    expect(nextList(list, [{id: 'a', n: 1}, {id: 'b', n: 2}])).toBe(list);
    expect(nextList(list, [{id: 'a', n: 1}, {id: 'b', n: 3}])[0]).toBe(a);
    expect(nextList(list, null)).toEqual([]);
    const rows = [{jobId: 'x', n: 1}, {deviceId: 'y', n: 2}];
    expect(nextList(rows, [{jobId: 'x', n: 1}, {deviceId: 'y', n: 2}])).toBe(rows);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('the dev handle (§11.4) and boot-common', () => {
  afterEach(() => { delete window.__woodshed; delete window.__FIXTURE__; });

  test('installed in development builds and on the fixture only', () => {
    expect(devHandleWanted({}, {DEV: true})).toBe(true);
    expect(devHandleWanted({__FIXTURE__: true}, {DEV: false})).toBe(true);
    expect(devHandleWanted({}, {DEV: false})).toBe(false);
    expect(installDevHandle({win: window, env: {DEV: false}})).toBeNull();
    expect(window.__woodshed).toBeUndefined();
    window.__FIXTURE__ = true;
    expect(installDevHandle({win: window, env: {DEV: false}})).toBe(window.__woodshed);
  });

  test('store, commands, activeSession() and idle()', async () => {
    const reg = createRegistry();
    const run = vi.fn();
    reg.register({id: 'demo.go', title: 'Go', group: 'App', run});
    const flush = vi.fn(async () => {});
    const session = {id: 's1', flush, transport: {snapshot: signal({phase: 'stopped'}), position: () => 12.5},
      practice: {value: signal({v: 2, cue: 3})}, map: {isReal: true, sections: [{label: 'Verse'}]}};
    let active = null;
    const settled = vi.fn(async () => {});
    const handle = installDevHandle({win: window, env: {DEV: true}, registry: reg, activeSession: () => active, settled});
    expect(handle.store).toBe(store);
    expect(handle.commands.isEnabled('demo.go')).toBe(true);
    handle.commands.run('demo.go');
    expect(run).toHaveBeenCalled();
    expect(handle.activeSession()).toBeNull();
    await handle.idle();
    expect(settled).toHaveBeenCalledTimes(1);
    active = session;
    const view = handle.activeSession();
    expect(view.id).toBe('s1');
    expect(view.transport.snapshot).toEqual({phase: 'stopped'});
    expect(view.transport.position()).toBe(12.5);
    expect(view.practice.value).toEqual({v: 2, cue: 3});
    expect(view.map.isReal).toBe(true);
    expect(view.map.sections).toEqual([{label: 'Verse'}]);
    session.transport.snapshot.value = {phase: 'playing'};
    expect(view.transport.snapshot).toEqual({phase: 'playing'});   // live, not a copy
    await handle.idle();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(sessionView(null)).toBeNull();
  });

  test('bootCommon inlines the sprite once and preloads the two Latin faces once', async () => {
    bootCommon({doc: document, win: window});
    bootCommon({doc: document, win: window});
    expect(document.querySelectorAll('#ws-icon-sprite')).toHaveLength(1);
    expect(document.querySelector('#i-play')).not.toBeNull();
    const links = [...document.head.querySelectorAll('link[rel=preload][as=font]')];
    expect(links.map(l => l.getAttribute('href'))).toEqual([...FONT_PRELOADS]);
    expect(FONT_PRELOADS).toHaveLength(2);
    for (const l of links) {
      expect(l.getAttribute('type')).toBe('font/woff2');
      expect(l.hasAttribute('crossorigin')).toBe(true);
    }
    expect(FONT_PRELOADS[0]).toMatch(/atkinson-hyperlegible-next-latin-wght-normal/);
    expect(FONT_PRELOADS[1]).toMatch(/atkinson-hyperlegible-mono-latin-wght-normal/);
    preloadFonts(document);
    expect(document.head.querySelectorAll('link[rel=preload][as=font]')).toHaveLength(2);
    expect(window.__woodshed).toBeDefined();   // vitest is a development build
    for (const l of links) l.remove();
  });
});
