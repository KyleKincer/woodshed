// @vitest-environment happy-dom
// S1: src/app/main.js, the boot order of architecture §2.3.1, step by step, on mocks. Each test boots a
// fresh module graph (vi.resetModules) so the store, the registry and the router start empty.
//
// main.js imports S2's feedback.js statically and loads ST1b's session.js on demand (same-wave peers,
// §9.0); these tests mock both and run once those files exist (always at integration).
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const h = vi.hoisted(() => ({
  log: [],
  init: [],            // queued results for auth.initialize(): {user, status} | Error
  onChange: [],
  admin: true,
  configs: [],         // settings.config subscribers
  patch: null,
  mounted: [],
  codec: true,
  sessions: {},
}));

const user = {id: 'u1', name: 'Kyle Kincer', email: 'kyle@example.com', image: null};

vi.mock('../src/app/auth.js', async importOriginal => {
  const real = await importOriginal();
  return {
    ...real,
    configure: vi.fn(opts => { h.log.push('auth.configure'); h.configured = opts; }),
    initialize: vi.fn(async () => {
      h.log.push('auth.initialize');
      const next = h.init.length > 1 ? h.init.shift() : h.init[0];
      if (next instanceof Error) throw next;
      return next;
    }),
    onChange: vi.fn(fn => { h.onChange.push(fn); return () => {}; }),
    signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  };
});
vi.mock('../src/api/client.js', async importOriginal => ({
  ...(await importOriginal()),
  query: vi.fn(async name => {
    h.log.push(name);
    if (name === 'admin:access') return h.admin;
    return null;
  }),
}));
vi.mock('../src/api/settings.js', () => ({
  subscribeConfig: vi.fn(onValue => { h.log.push('settings.config'); h.configs.push(onValue); return () => {}; }),
  patch: vi.fn(async change => { h.patch = change; return {practice: change.practice}; }),
  config: vi.fn(), demo: vi.fn(),
}));
vi.mock('../src/app/data.js', () => ({startData: vi.fn(() => { h.log.push('startData'); return () => {}; })}));
vi.mock('../src/app/dispatch.js', async importOriginal => {
  const real = await importOriginal();
  return {...real, startDispatcher: vi.fn(() => { h.log.push('startDispatcher'); return () => {}; })};
});
vi.mock('../src/app/desktop.js', () => ({desktop: {
  available: false, start: vi.fn(async () => { h.log.push('desktop.start'); }), setTheme: vi.fn(async () => {}), update: vi.fn(),
  processor: {value: {phase: 'web'}},
}}));
vi.mock('../src/app/feedback.js', () => ({
  toast: vi.fn(message => { h.log.push(`toast ${message}`); return {dismiss() {}, update() {}}; }),
  status: vi.fn(), confirm: vi.fn(), form: vi.fn(), announce: vi.fn(),
}));
vi.mock('../src/app/palette.js', () => ({openPalette: vi.fn()}));
vi.mock('../src/app/shortcuts-sheet.js', () => ({openShortcuts: vi.fn()}));
vi.mock('../src/stage/session.js', () => ({
  getSession: vi.fn(async id => {
    h.log.push(`getSession ${id}`);
    h.sessions[id] = {id, flush: vi.fn(async () => {}), transport: {snapshot: {value: {phase: 'stopped'}}, position: () => 0},
      practice: {value: {value: {v: 2}}}, map: {isReal: false, sections: []}};
    h.active = h.sessions[id];
    return h.sessions[id];
  }),
  disposeSession: vi.fn(async id => { h.log.push(`disposeSession ${id}`); h.active = null; }),
  activeSession: vi.fn(() => h.active ?? null),
}));
vi.mock('../src/js/startup.js', async importOriginal => {
  const real = await importOriginal();
  return {
    ...real,
    showStartup: vi.fn(opts => { h.log.push('showStartup'); return real.showStartup(opts); }),
    finishStartup: vi.fn(opts => { h.log.push('finishStartup'); return real.finishStartup(opts); }),
    showSignIn: vi.fn(opts => { h.log.push('showSignIn'); return real.showSignIn(opts); }),
  };
});
vi.mock('../src/js/stemcache.js', () => ({likelySupportsOpus: vi.fn(() => h.codec)}));
// Every route on a recording view; the boot routes on a recording boot.
vi.mock('../src/app/routes.js', async importOriginal => {
  const real = await importOriginal();
  const view = name => () => Promise.resolve({
    mount(el, match, ctx) {
      h.log.push(`mount ${name}`);
      h.mounted.push({name, match, ctx, session: h.sessionAtMount = ctx.store.session.peek()});
      const scroller = document.createElement('div');
      scroller.setAttribute('data-scroller', '');
      scroller.textContent = `view ${name}`;
      el.replaceChildren(scroller);
      return {update() {}, unmount() { h.log.push(`unmount ${name}`); }};
    },
  });
  return {
    ...real,
    routes: real.routes.map(r => ({...r, view: view(r.name)})),
    bootRoutes: real.bootRoutes.map(r => ({...r, boot: async () => ({boot: match => { h.log.push(`boot ${match.name}`); h.bootMatch = match; }})})),
  };
});

const PEERS = ['src/app/feedback.js', 'src/app/palette.js', 'src/app/shortcuts-sheet.js', 'src/stage/session.js'];
const missingPeers = PEERS.filter(p => !existsSync(join(process.cwd(), p)));

const root = document.documentElement;
let reload;

function reset() {
  h.log = [];
  h.init = [{user, status: 'active'}];
  h.onChange = [];
  h.admin = true;
  h.configs = [];
  h.patch = null;
  h.mounted = [];
  h.codec = true;
  h.sessions = {};
  h.active = null;
  h.bootMatch = null;
}

async function load(path = '/') {
  vi.resetModules();
  history.replaceState(null, '', path);
  const main = await import('../src/app/main.js');
  const {store} = await import('../src/app/store.js');
  const {registry} = await import('../src/app/commands.js');
  const {account} = await import('../src/app/account.js');
  return {main, store, registry, account};
}

/** Delivers settings.config to every subscriber. */
const config = settings => { for (const fn of h.configs) fn({presets: {}, models: [], stemModes: [], bitrates: [], defaultPreset: 'balanced', settings}); };
const tick = () => new Promise(r => setTimeout(r, 0));

describe.skipIf(missingPeers.length)('boot (§2.3.1)', () => {
  beforeEach(() => {
    reset();
    localStorage.clear();
    sessionStorage.clear();
    document.head.replaceChildren();
    document.body.innerHTML = '<div id="app"></div><div id="startup" role="status">Opening Woodshed…</div>';
    for (const a of ['data-place', 'data-posture', 'data-view-ready', 'data-startup']) root.removeAttribute(a);
    reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  });
  afterEach(async () => {
    await h.router?.stop?.();
    h.router = null;
    vi.restoreAllMocks();
    delete window.__woodshed;
  });

  async function bootApp(path = '/') {
    const env = await load(path);
    const result = await env.main.boot();
    h.router = result.router;
    return {...env, result};
  }

  test('steps run in order: startup → auth → admin.access → desktop → account → data → dispatcher → router → ready', async () => {
    const {result, store} = await bootApp('/');
    expect(result.kind).toBe('app');
    expect(h.log).toEqual(['showStartup', 'auth.configure', 'auth.initialize', 'admin:access', 'desktop.start', 'settings.config', 'startData',
      'startDispatcher', 'mount library', 'finishStartup']);
    expect(store.session.peek()).toEqual({user, status: 'active', admin: true, online: true});
    expect(root.dataset.startup).toBe('ready');
    expect(root.dataset.viewReady).toBe('library');
    expect(document.getElementById('startup')).toBeNull();
  });

  test('step 1: the sprite, the font preload and the dev handle are in place', async () => {
    await bootApp('/');
    expect(document.getElementById('ws-icon-sprite')).not.toBeNull();
    expect(document.head.querySelectorAll('link[rel=preload][as=font]')).toHaveLength(2);
    expect(window.__woodshed.activeSession()).toBeNull();
  });

  test('step 4: admin.access lands in store.session before router.start, so a /admin deep link passes its guard', async () => {
    await bootApp('/admin');
    expect(h.sessionAtMount.admin).toBe(true);
    expect(h.mounted.map(m => m.name)).toEqual(['admin']);
    expect(location.pathname).toBe('/admin');
  });

  test('step 4: a non-admin /admin deep link goes home with the toast', async () => {
    h.admin = false;
    await bootApp('/admin');
    expect(h.mounted.map(m => m.name)).toEqual(['library']);
    expect(location.pathname).toBe('/');
    expect(h.log).toContain('toast Administration is for admins.');
  });

  test('step 4: a failing admin.access counts as not an admin', async () => {
    const env = await load('/');
    const client = await import('../src/api/client.js');
    client.query.mockImplementationOnce(async () => { throw new Error('offline'); });
    const result = await env.main.boot();
    h.router = result.router;
    expect(env.store.session.peek().admin).toBe(false);
  });

  test('step 5: the prefs carry-over (pendingAccount) is applied once, after the first settings.config', async () => {
    localStorage.setItem('ws.prefs', JSON.stringify({v: 1, pendingAccount: {practice: {stop: 'stay', keepPitch: false}}}));
    const {store} = await bootApp('/');
    expect(store.pendingAccount.peek()).toEqual({practice: {stop: 'stay', keepPitch: false}});
    expect(h.patch).toBeNull();
    config({onboarding: {whatDoYouPlay: 'done'}});
    await vi.waitFor(() => expect(h.patch).toEqual({practice: {stop: 'stay', keepPitch: false}}));
    await vi.waitFor(() => expect(store.pendingAccount.peek()).toBeNull());
    expect(JSON.parse(localStorage.getItem('ws.prefs')).pendingAccount).toBeNull();
    h.patch = null;
    config({onboarding: {whatDoYouPlay: 'done'}, practice: {stop: 'stay'}});
    await tick();
    expect(h.patch).toBeNull();
  });

  test('step 3: an OAuth error shows the sign-in card with its message; nothing else starts', async () => {
    const {AuthError} = await import('../src/app/auth.js');
    h.init = [new AuthError({kind: 'oauth', code: 'expired', message: 'This sign-in link expired. Please sign in again.'})];
    const {result} = await bootApp('/');
    expect(result.kind).toBe('signin');
    expect(document.getElementById('app').textContent).toContain('This sign-in link expired. Please sign in again.');
    expect(root.dataset.startup).toBe('signin');
    expect(h.log).not.toContain('admin:access');
    expect(h.log).not.toContain('startData');
    expect(h.log).not.toContain('startDispatcher');
  });

  test('step 3: signed out shows the sign-in card; a sign-in in another tab reloads', async () => {
    h.init = [{user: null, status: null}];
    const {result} = await bootApp('/s/abc');
    expect(result.kind).toBe('signin');
    expect(document.querySelector('#app [role=alert]')?.hidden ?? true).toBe(true);
    expect(h.log).toEqual(['showStartup', 'auth.configure', 'auth.initialize', 'showSignIn']);
    h.onChange.at(-1)({user, status: 'active'});
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test.each(['network', 'config'])('step 3: a %s error shows the fatal card; Retry runs initialize() again and boots', async kind => {
    const {AuthError} = await import('../src/app/auth.js');
    h.init = [new AuthError({kind, code: 'timeout', message: 'Woodshed could not reach its server.', cause: new Error('socket closed')}), {user, status: 'active'}];
    const env = await load('/');
    const booting = env.main.boot();
    await vi.waitFor(() => expect(document.querySelector('.shell-fatal')).not.toBeNull());
    const card = document.querySelector('.shell-fatal');
    expect(card.textContent).toContain('Couldn’t open Woodshed');
    expect(card.querySelector('pre').textContent).toContain('socket closed');
    expect(h.log.filter(l => l === 'auth.initialize')).toHaveLength(1);
    [...card.querySelectorAll('button')].find(b => b.textContent === 'Retry').click();
    const result = await booting;
    h.router = result.router;
    expect(result.kind).toBe('app');
    expect(h.log.filter(l => l === 'auth.initialize')).toHaveLength(2);
    expect(h.log.filter(l => l === 'showStartup')).toHaveLength(2);
    expect(document.querySelector('.shell-fatal')).toBeNull();
  });

  test('step 3: a suspended account gets the paused page and nothing else', async () => {
    h.init = [{user, status: 'suspended'}];
    const {result} = await bootApp('/');
    expect(result.kind).toBe('paused');
    expect(document.getElementById('app').textContent).toContain('Your account is paused');
    expect(root.dataset.startup).toBe('ready');
    expect(h.log).not.toContain('admin:access');
    expect(h.log).not.toContain('startData');
    h.onChange.at(-1)({user, status: 'active'});
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('an export-only account boots the app with the export-only banner', async () => {
    h.init = [{user, status: 'export_only'}];
    const {store} = await bootApp('/');
    expect(store.session.peek().status).toBe('export_only');
    const banner = document.querySelector('[data-banner=export-only]');
    expect(banner.textContent).toContain('Adding songs is paused on this account.');
    expect(document.querySelector('[data-banner=codec]')).toBeNull();
  });

  test('a browser that cannot play the audio format gets the codec banner', async () => {
    h.codec = false;
    await bootApp('/');
    expect(document.querySelector('[data-banner=codec]')).not.toBeNull();
  });

  test.each([
    ['/download', 'download', {}],
    ['/download/', 'download', {}],
    [`/share/${'c'.repeat(64)}`, 'share', {token: 'c'.repeat(64)}],
  ])('step 2: %s hands over to its boot route, dismisses the boot status and stops', async (path, name, params) => {
    root.dataset.startup = 'loading';   // as index.html ships it
    const env = await load(path);
    const result = await env.main.boot();
    expect(result.kind).toBe(name);
    expect(h.log).toEqual([`boot ${name}`, 'finishStartup']);
    expect(h.bootMatch.params).toEqual(params);
    expect(root.dataset.startup).not.toBe('loading');
    expect(document.getElementById('startup')).toBeNull();
  });

  test('the banners row stays empty on full-bleed places (Stage, Edit, /welcome) and returns on the Library', async () => {
    h.init = [{user, status: 'export_only'}];
    h.codec = false;
    const {result} = await bootApp('/s/song1');
    const row = document.querySelector('.shell-banners');
    expect(document.getElementById('app').dataset.chrome).toBe('none');
    expect(row.childElementCount).toBe(0);
    expect(row.hidden).toBe(true);
    await result.router.navigate('/');
    expect([...row.children].map(b => b.dataset.banner)).toEqual(['export-only', 'codec']);
    expect(row.hidden).toBe(false);
  });

  test('step 8: /welcome is pushed once when "What do you play?" is unanswered', async () => {
    const {result} = await bootApp('/');
    config({onboarding: {}});
    await vi.waitFor(() => expect(root.dataset.viewReady).toBe('welcome'));
    expect(location.pathname).toBe('/welcome');
    expect(history.state.idx).toBe(1);   // pushed: Back returns to where the user was
    config({onboarding: {}});
    await tick();
    expect(result.router.current.peek().name).toBe('welcome');
    expect(h.mounted.filter(m => m.name === 'welcome')).toHaveLength(1);
  });

  test('step 8: an answered profile stays where it is', async () => {
    await bootApp('/settings');
    config({onboarding: {whatDoYouPlay: 'skipped'}});
    await tick();
    await tick();
    expect(location.pathname).toBe('/settings');
  });

  test('step 7: the global commands and the command context (router, store, feedback, platform, topbar)', async () => {
    const {registry, store, result, main} = await bootApp('/');
    for (const id of ['app.palette', 'app.shortcuts', 'app.escape', 'nav.settings', 'app.signOut']) expect(registry.get(id), id).not.toBeNull();
    const c = registry.context();
    expect(c.router).toBe(result.router);
    expect(c.store).toBe(store);
    expect(typeof c.feedback.toast).toBe('function');
    expect(c.topbar).toBe(result.topbar);
    expect(typeof c.platform.detect).toBe('function');
    expect(main.STARTERS.map(([path, name]) => `${path}#${name}`)).toEqual(['./pedals.js#startPedals', './midi.js#startMidi',
      './desktop-menu.js#startDesktopMenu', './notify-ready.js#startNotifyReady', '../library/dropzone.js#startLibraryDrop']);
    expect(main.commandModules.every(p => /\/commands\.js$|transport-commands\.js$/.test(p))).toBe(true);
  });

  test('the frame: the top bar on top-bar places, none on the Stage; the session follows the song', async () => {
    const {result} = await bootApp('/');
    const app = document.getElementById('app');
    const header = app.querySelector('header');
    expect(app.dataset.chrome).toBe('topbar');
    expect(header.hidden).toBe(false);
    expect(header.querySelector('.shell-wordmark').textContent).toBe('Woodshed');
    await result.router.navigate('/s/song-1');
    expect(app.dataset.chrome).toBe('none');
    expect(header.hidden).toBe(true);
    expect(h.log).toContain('getSession song-1');
    expect(h.mounted.at(-1).ctx.session).toBe(h.sessions['song-1']);
    expect(window.__woodshed.activeSession().id).toBe('song-1');
    await window.__woodshed.idle();
    expect(h.sessions['song-1'].flush).toHaveBeenCalled();
    await result.router.navigate('/settings');
    expect(app.dataset.chrome).toBe('topbar');
    expect(h.log).toContain('disposeSession song-1');
  });

  test('the wordmark is a router link; typing in the search outside the Library opens it filtered', async () => {
    await bootApp('/settings');
    const input = document.querySelector('.shell-search-input');
    input.value = 'glass';
    input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(root.dataset.viewReady).toBe('library'));
    expect(location.search).toBe('?q=glass');
    document.querySelector('.shell-wordmark').click();
    await tick();
    expect(location.pathname).toBe('/');
  });

  test('auth.onChange: a sign-out (here or elsewhere) or a suspension reloads; a status change updates the session', async () => {
    const {store} = await bootApp('/');
    const fn = h.onChange.at(-1);
    fn({user, status: 'export_only'});
    expect(store.session.peek().status).toBe('export_only');
    expect(reload).not.toHaveBeenCalled();
    fn({user, status: 'suspended'});
    expect(reload).toHaveBeenCalledTimes(1);
    fn({user: null, status: null});
    expect(reload).toHaveBeenCalledTimes(2);
  });

  test('auth.configure gets activeSession, which reads the loaded session module only', async () => {
    const {result} = await bootApp('/');
    expect(h.configured.activeSession()).toBeNull();
    await result.router.navigate('/s/song-2');
    expect(h.configured.activeSession().id).toBe('song-2');
  });
});
