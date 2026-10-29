// @vitest-environment happy-dom
// SH1: the Shared Stage's boot list (architecture §2.18 items 1–10), step by step, on injected dependencies, and
// the identity row's action (spec §4.13): Sign in to keep a copy (?save=1), Add to my library (flush → save →
// practice migration → /s/<id>), Open in my library, the one-time device notice, Minus me from the profile, and
// the pages for a link that does not work.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createRegistry} from '../src/app/commands.js';
import {clock as appClock} from '../src/app/clock.js';
import {defineStageCommands} from '../src/stage/commands.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession} from './helpers/test-session.js';
import {migrateSharedPractice} from '../src/share/shared-practice.js';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

const {boot, BOOT_STEPS, SESSION_ID, STARTERS} = await import('../src/share/shared-stage.js');
const {COPY} = await import('../src/share/share.copy.js');
const {isShareToken} = await import('../src/api/sharing.js');
const {signal} = await import('../src/app/store.js');
const {deviceStore} = await import('../src/app/prefs.js');
const profile = await import('../src/app/profile.js');

const TOKEN = 'a3f1'.repeat(16);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await flush(); };
const SNAPSHOT = Object.freeze({
  id: 'shared', revision: 'r1', ownerName: 'Kyle K.', title: 'Glasshouse', artist: 'The Rooms', duration: 200,
  stems: [{name: 'drums', key: 'stem-0'}, {name: 'bass', key: 'stem-1'}], practice: {v: 2, rate: 1},
});
const USER = {id: 'u2', name: 'Robin Roe', email: 'robin@example.com'};

function setup({user = null, token = TOKEN, view = SNAPSHOT, viewError = null, saved = null, search = '', account = null, saveResult = 'glasshouse-copy',
  saveError = null, demo = null} = {}) {
  const log = [];
  const assign = vi.fn(), reload = vi.fn();
  window.history.replaceState(null, '', `/share/${token}${search}`);
  const win = {
    get location() {
      const l = window.location;
      return {href: l.href, origin: l.origin, pathname: l.pathname, search: l.search, assign, reload};
    },
    history: window.history, navigator: window.navigator, document,
    addEventListener: (...a) => window.addEventListener(...a), removeEventListener: (...a) => window.removeEventListener(...a),
    dispatchEvent: e => window.dispatchEvent(e), CustomEvent: window.CustomEvent, getComputedStyle: el => window.getComputedStyle(el),
  };
  const later = {view: null, saved: null};
  const session = {
    id: SESSION_ID, readOnly: true, shareToken: token, disposed: false,
    flush: vi.fn(async opts => { log.push(['flush', opts]); }),
    song: signal((({practice, ...rest}) => rest)(view ?? SNAPSHOT)),
    practice: {value: signal({v: 2, rate: 1})},
    transport: {minusMe: vi.fn(() => true)},
  };
  const mounted = [];
  const deps = {
    win, doc: document,
    bootCommon: vi.fn(() => { log.push('bootCommon'); return {devHandle: null}; }),
    auth: {
      configure: vi.fn(() => log.push('auth.configure')),
      initialize: vi.fn(async opts => { log.push(['auth.initialize', opts]); return {user, status: user ? 'active' : null}; }),
      onChange: vi.fn(() => () => {}),
      signIn: vi.fn(async () => { log.push('auth.signIn'); }),
    },
    store: {session: signal({user: null}), prefs: signal({})},
    platform: {online: signal(true)},
    keys: {setPlatform: vi.fn(), loadLayoutMap: vi.fn(async () => null)},
    registry: {getScope: vi.fn(() => null), defineScope: vi.fn(), provide: vi.fn(() => () => {})},
    startDispatcher: vi.fn(() => { log.push('startDispatcher'); return () => {}; }),
    configurePalette: vi.fn(opts => log.push(['configurePalette', opts])),
    startAccount: vi.fn(() => log.push('startAccount')),
    account: {loaded: signal(true), value: signal(account ?? {})},
    profile,
    feedback: {status: vi.fn(), dismissStatus: vi.fn(), toast: vi.fn()},
    desktop: {available: false},
    starterArgs: [],
    starters: {
      '../app/pedals.js': async () => ({startPedals: (args) => { log.push('startPedals'); deps.starterArgs.push(args); }}),
      '../app/midi.js': async () => ({startMidi: (args) => { log.push('startMidi'); deps.starterArgs.push(args); }}),
    },
    demoToken: vi.fn(async () => demo),
    sharing: {
      isShareToken,
      subscribeView: vi.fn(({token: t}, onValue, onError) => {
        log.push(['sharing.view', t]);
        later.view = onValue;
        setTimeout(() => (viewError ? onError(viewError) : onValue(view)), 0);
        return () => log.push('view.off');
      }),
      playback: vi.fn(async () => ({})),
      subscribeSaved: vi.fn((args, onValue) => {
        log.push('sharing.saved');
        later.saved = onValue;
        setTimeout(() => onValue(saved), 0);
        return () => {};
      }),
      save: vi.fn(async args => { log.push(['sharing.save', args]); if (saveError) throw saveError; return saveResult; }),
    },
    songs: {savePractice: vi.fn(async args => { log.push(['savePractice', args.id, args.final]); return null; })},
    getSession: vi.fn(async (id, opts) => { log.push(['getSession', id]); session.opts = opts; return session; }),
    loadStage: async () => ({
      mount: vi.fn(async (el, match, ctx) => {
        log.push('stage.mount');
        mounted.push({match, ctx});
        el.replaceChildren(Object.assign(document.createElement('div'), {className: 'stage'}));
        const slot = document.createElement('span');
        slot.className = 'hud-action-slot';
        el.firstChild.append(slot);
        return {update: vi.fn(), unmount: vi.fn()};
      }),
    }),
  };
  return {deps, log, assign, reload, session, mounted, later};
}

const action = () => document.querySelector('.hud-action-slot .share-action');
const label = () => action()?.querySelector('.ui-button-label')?.textContent ?? action()?.textContent;
let booted = null;
async function run(env) {
  booted = await boot({name: 'share', params: {token: env.deps.win.location.pathname.split('/')[2]}}, env.deps);
  await settle();
  return booted;
}

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), {id: 'app'}));
  document.head.querySelectorAll('meta[name=robots]').forEach(m => m.remove());
  for (const key of Object.keys(document.documentElement.dataset)) delete document.documentElement.dataset[key];
  deviceStore('share').remove(TOKEN);
  deviceStore('shareNotice').remove(TOKEN);
});
afterEach(async () => {
  await booted?.router?.stop?.();
  booted = null;
  window.history.replaceState(null, '', '/');
});

describe('the boot list (§2.18), in order', () => {
  it('runs every step: common, root, auth, store, commands, palette, starters, router, view, mount', async () => {
    const env = setup();
    const result = await run(env);
    expect(result.state).toBe('stage');
    expect(result.steps).toEqual([...BOOT_STEPS]);
    const order = env.log.map(e => (Array.isArray(e) ? e[0] : e));
    expect(order.slice(0, 9)).toEqual(['bootCommon', 'auth.configure', 'auth.initialize', 'startDispatcher', 'configurePalette',
      'startPedals', 'startMidi', 'sharing.view', 'getSession']);
    expect(order).toContain('stage.mount');
    expect(order.indexOf('stage.mount')).toBeGreaterThan(order.indexOf('getSession'));
  });

  it('1–2: the shared boot steps, then the Stage place and posture before auth, the title and noindex', async () => {
    const env = setup();
    let atAuth = null;
    env.deps.auth.initialize.mockImplementation(async () => {
      atAuth = {...document.documentElement.dataset};
      return {user: null, status: null};
    });
    await run(env);
    expect(env.deps.bootCommon).toHaveBeenCalledWith(expect.objectContaining({doc: document, win: env.deps.win}));
    expect(atAuth).toMatchObject({place: 'stage', posture: 'stage'});
    expect(['light', 'dark']).toContain(document.documentElement.style.colorScheme);
    expect(document.head.querySelector('meta[name=robots]').content).toBe('noindex, nofollow, noarchive');
    expect(document.title).toBe('Glasshouse · Shared on Woodshed');
  });

  it('3–4: optional auth (never throws) and store.session = {user, status, admin: false, online}', async () => {
    const env = setup({user: USER});
    await run(env);
    expect(env.deps.auth.initialize).toHaveBeenCalledWith({optional: true});
    expect(env.deps.store.session.peek()).toEqual({user: USER, status: 'active', admin: false, online: true});
    expect(env.deps.startAccount).toHaveBeenCalledTimes(1);
    env.deps.platform.online.value = false;
    await settle(1);
    expect(env.deps.store.session.peek().online).toBe(false);
  });

  it('a signed-out visitor gets no account subscription', async () => {
    const env = setup();
    await run(env);
    expect(env.deps.store.session.peek()).toMatchObject({user: null, admin: false});
    expect(env.deps.startAccount).not.toHaveBeenCalled();
  });

  it('5–7: scopes, context providers, the dispatcher, the palette without songs or navigation, pedals and MIDI', async () => {
    const env = setup();
    await run(env);
    expect(env.deps.registry.defineScope.mock.calls.map(c => c[0])).toEqual(['stage.strip', 'stage.bars']);
    expect(env.deps.registry.provide.mock.calls.map(c => c[0])).toEqual(['router', 'store', 'feedback', 'platform', 'desktop']);
    const router = env.deps.registry.provide.mock.calls[0][1]();
    expect(typeof router.navigate).toBe('function');
    expect(env.deps.configurePalette).toHaveBeenCalledWith({songs: false, navigation: false});
    expect(STARTERS.map(s => s[1])).toEqual(['startPedals', 'startMidi']);
    expect(env.log).toContain('startPedals');
    expect(env.log).toContain('startMidi');
    // As main.js runs them: with {router} (the Shared Stage's own, built at step 8).
    expect(env.deps.starterArgs).toHaveLength(2);
    for (const args of env.deps.starterArgs) expect(args.router).toBe(booted.router);
  });

  it('8–10: the read-only session from the snapshot, then stage.js mounted through the router with it', async () => {
    const env = setup();
    await run(env);
    expect(env.deps.sharing.subscribeView).toHaveBeenCalledWith({token: TOKEN}, expect.any(Function), expect.any(Function));
    expect(env.deps.getSession).toHaveBeenCalledWith(SESSION_ID, {shared: {
      token: TOKEN, snapshot: SNAPSHOT, resolveUrls: env.deps.sharing.playback, cacheNamespace: `share:${TOKEN}:r1:`,
    }});
    const [{match, ctx}] = env.mounted;
    expect(match.name).toBe('share');
    expect(match.params.token).toBe(TOKEN);
    expect(ctx.session).toBe(env.session);
    expect(ctx.router).toBe(booted.router);
    expect(document.documentElement.dataset).toMatchObject({place: 'stage', posture: 'stage', viewReady: 'share'});
    expect(document.querySelector('#app').dataset.chrome).toBe('none');
  });

  it('?bar and ?t reach the Stage in the match query', async () => {
    const env = setup({search: '?bar=17&t=40'});
    await run(env);
    expect(env.mounted[0].match.query).toEqual({bar: '17', t: '40'});
  });
});

describe('links that do not work', () => {
  it('a malformed token: "This link doesn’t work any more." without a network call', async () => {
    const env = setup({token: 'not-a-token'});
    const result = await run(env);
    expect(result.state).toBe('unavailable');
    expect(env.deps.sharing.subscribeView).not.toHaveBeenCalled();
    expect(document.querySelector('.share-page-title').textContent).toBe('This link doesn’t work any more.');
    expect(document.querySelector('.share-page-body').textContent).toBe(COPY.missingBody);
    expect(document.querySelector('.share-page a').getAttribute('href')).toBe('/');
    expect(document.documentElement.dataset.viewReady).toBe('share');
    // Not the Stage: the page follows the app theme, not the Stage's.
    expect(document.documentElement.dataset.place).toBeUndefined();
    expect(document.documentElement.dataset.posture).toBeUndefined();
  });

  it('a stopped or removed link (sharing.view null) shows the same page and stops listening', async () => {
    const env = setup({view: null});
    const result = await run(env);
    expect(result.state).toBe('unavailable');
    expect(env.deps.getSession).not.toHaveBeenCalled();
    expect(env.log).toContain('view.off');
    expect(document.querySelector('.share-page').dataset.shareState).toBe('unavailable');
  });

  it('a failed lookup: "Couldn’t open this song." with Try again (a reload)', async () => {
    const env = setup({viewError: new Error('offline')});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await run(env);
    expect(result.state).toBe('failed');
    expect(document.querySelector('.share-page-title').textContent).toBe('Couldn’t open this song.');
    expect(document.querySelector('.share-page-card').getAttribute('role')).toBe('alert');
    document.querySelector('.share-page button').click();
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it('while open: a stopped link and changed audio are said in the status line', async () => {
    const env = setup();
    await run(env);
    env.later.view(null);
    expect(env.deps.feedback.status).toHaveBeenCalledWith(COPY.linkStopped, {key: 'share-view', durationMs: Infinity});
    expect(action().hidden).toBe(true);
    env.later.view({...SNAPSHOT, revision: 'r2'});
    const [text, opts] = env.deps.feedback.status.mock.calls.at(-1);
    expect(text).toBe(COPY.audioChanged);
    opts.action.run();
    expect(env.reload).toHaveBeenCalledTimes(1);
  });
});

describe('the identity row action (spec §4.13)', () => {
  it('signed out: Sign in to keep a copy sets ?save=1 and starts sign-in (which returns to this URL)', async () => {
    const env = setup();
    await run(env);
    expect(label()).toBe('Sign in to keep a copy');
    action().click();
    await settle();
    expect(new URL(window.location.href).searchParams.get('save')).toBe('1');
    expect(env.deps.auth.signIn).toHaveBeenCalledTimes(1);
  });

  it('signed in: Add to my library flushes, saves, migrates this device’s practice, then opens the copy', async () => {
    const env = setup({user: USER});
    deviceStore('share').set(TOKEN, {v: 2, rate: 0.75, spots: []});
    await run(env);
    expect(label()).toBe('Add to my library');
    action().click();
    await settle();
    const tail = env.log.filter(e => Array.isArray(e) && ['flush', 'sharing.save', 'savePractice'].includes(e[0]));
    expect(tail).toEqual([['flush', {final: true}], ['sharing.save', {token: TOKEN}], ['savePractice', 'glasshouse-copy', true]]);
    expect(env.deps.songs.savePractice.mock.calls[0][0].practice).toMatchObject({v: 2, rate: 0.75});
    expect(deviceStore('share').get(TOKEN)).toBeNull();
    expect(env.assign).toHaveBeenCalledWith('/s/glasshouse-copy');
  });

  it('without a device copy the saved song keeps the shared practice (no savePractice)', async () => {
    const env = setup({user: USER});
    await run(env);
    action().click();
    await settle();
    expect(env.deps.songs.savePractice).not.toHaveBeenCalled();
    expect(env.assign).toHaveBeenCalledWith('/s/glasshouse-copy');
  });

  it('a refused save says why and offers Add again', async () => {
    const env = setup({user: USER, saveError: Object.assign(new Error('full'), {code: 'storage_full_user'})});
    await run(env);
    action().click();
    await settle();
    const [text, opts] = env.deps.feedback.status.mock.calls.at(-1);
    expect(opts).toMatchObject({key: 'share-add', tone: 'error'});
    expect(text.length).toBeGreaterThan(0);
    expect(env.assign).not.toHaveBeenCalled();
    expect(label()).toBe('Add to my library');
  });

  it('already saved (or the owner): Open in my library', async () => {
    const env = setup({user: USER, saved: {songId: 'glasshouse-copy', status: 'ready'}});
    await run(env);
    expect(label()).toBe('Open in my library');
    action().click();
    expect(env.assign).toHaveBeenCalledWith('/s/glasshouse-copy');
    expect(env.deps.sharing.save).not.toHaveBeenCalled();
  });

  it('a save in progress elsewhere: Adding…, busy', async () => {
    const env = setup({user: USER, saved: {songId: null, status: 'copying'}});
    await run(env);
    expect(action().getAttribute('aria-busy')).toBe('true');
    expect(action().textContent).toContain('Adding…');
  });

  it('back from sign-in with ?save=1: adds once the link is confirmed, and clears ?save', async () => {
    const env = setup({user: USER, search: '?save=1'});
    await run(env);
    expect(env.deps.sharing.save).toHaveBeenCalledWith({token: TOKEN});
    expect(new URL(window.location.href).searchParams.has('save')).toBe(false);
    expect(env.assign).toHaveBeenCalledWith('/s/glasshouse-copy');
  });

  it('?save=1 while signed out (sign-in did not finish) only clears ?save', async () => {
    const env = setup({search: '?save=1'});
    await run(env);
    expect(env.deps.sharing.save).not.toHaveBeenCalled();
    expect(new URL(window.location.href).searchParams.has('save')).toBe(false);
  });
});

describe('practice on this device', () => {
  it('my part Out (the signed-in viewer’s profile) applies Minus me on a first open, then the one-time notice', async () => {
    const env = setup({user: USER, account: {profile: {instruments: ['drums'], primary: 'drums', openWithMyPart: 'out'}}});
    await run(env);
    expect(env.session.transport.minusMe).toHaveBeenCalledWith(true, {undoable: false});
    expect(env.deps.feedback.status).not.toHaveBeenCalledWith(COPY.localNotice, expect.anything());
    env.session.practice.value.value = {v: 2, rate: 0.8};
    expect(env.deps.feedback.status).toHaveBeenCalledWith(COPY.localNotice, expect.objectContaining({key: 'share-local'}));
  });

  it('a device that already has practice for the token keeps it (no Minus me)', async () => {
    deviceStore('share').set(TOKEN, {v: 2, rate: 0.9});
    const env = setup({user: USER, account: {profile: {instruments: ['drums'], openWithMyPart: 'out'}}});
    await run(env);
    expect(env.session.transport.minusMe).not.toHaveBeenCalled();
  });

  it('the example song (settings.demo’s token) takes the viewer’s part out even with “my part In”', async () => {
    const env = setup({user: USER, demo: TOKEN, account: {profile: {instruments: ['drums'], primary: 'drums', openWithMyPart: 'in'}}});
    await run(env);
    expect(env.deps.demoToken).toHaveBeenCalled();
    expect(env.session.transport.minusMe).toHaveBeenCalledWith(true, {undoable: false});
    await booted.router.stop();
    // No profile (they skipped What do you play?): nothing to take out.
    const bare = setup({user: USER, demo: TOKEN, account: {}});
    await run(bare);
    expect(bare.session.transport.minusMe).not.toHaveBeenCalled();
    await booted.router.stop();
    // A failed settings.demo lookup is just not the demo.
    const failed = setup({user: USER, account: {profile: {instruments: ['drums'], openWithMyPart: 'in'}}});
    failed.deps.demoToken.mockRejectedValue(new Error('offline'));
    await run(failed);
    expect(failed.session.transport.minusMe).not.toHaveBeenCalled();
  });

  it('open with my part In, or signed out: nothing is muted', async () => {
    const inEnv = setup({user: USER, account: {profile: {instruments: ['drums'], openWithMyPart: 'in'}}});
    await run(inEnv);
    expect(inEnv.session.transport.minusMe).not.toHaveBeenCalled();
    await booted.router.stop();
    const outEnv = setup();
    await run(outEnv);
    expect(outEnv.session.transport.minusMe).not.toHaveBeenCalled();
  });
});

// The real session the Shared Stage opens (src/stage/session.js with {shared}, practice-state.js `local: {token}`): practice
// persists on this device under the token, moves into the saved copy, and the Edit commands stay off.
describe('a real Shared Stage session', () => {
  let clock, restoreAudio, sessions = [];
  beforeEach(() => {
    vi.useFakeTimers(FAKE_TIMERS);
    vi.setSystemTime(Date.parse('2026-10-28T12:00:00Z'));
    appClock.set();
    restoreAudio = installFakeAudio();
    clock = createClock();
  });
  afterEach(async () => {
    for (const ts of sessions.splice(0)) await ts.dispose();
    restoreAudio();
    vi.useRealTimers();
  });
  const open = async (options = {}) => {
    const ts = await createTestSession({clock, shared: {token: TOKEN}, practice: {v: 2, rate: 1, spots: [], markers: []}, ...options});
    sessions.push(ts);
    return ts;
  };

  it('practice saves on this device only, keyed by the token, reopens from it, and migrates into the saved copy', async () => {
    const ts = await open();
    expect(ts.session.readOnly).toBe(true);
    ts.session.practice.patch({rate: 0.8});
    await ts.session.flush({final: true});
    expect(deviceStore('share').get(TOKEN)).toMatchObject({v: 2, rate: 0.8});
    expect(ts.server.calls.savePractice).toEqual([]);   // nothing reaches the server

    // Another visit on this device opens with the device copy, not the sharer's practice.
    const again = await open();
    expect(again.session.practice.value.peek().rate).toBe(0.8);

    // Add to my library: the device copy becomes the saved song's practice, then leaves this device.
    const songs = {savePractice: vi.fn(async () => null)};
    expect(await migrateSharedPractice({token: TOKEN, songId: 'glasshouse-copy', duration: 200, songs})).toBe(true);
    expect(songs.savePractice).toHaveBeenCalledWith({id: 'glasshouse-copy', practice: expect.objectContaining({v: 2, rate: 0.8}), final: true});
    expect(deviceStore('share').get(TOKEN)).toBeNull();
  });

  it('Edit is hidden: edit.*, Share, map, detect and re-split commands are off on the shared session only', async () => {
    const ids = ['edit.open', 'edit.map', 'edit.chart', 'edit.details', 'stage.share', 'stage.tapBeat', 'stage.getBars'];
    const enabled = async (ts) => {
      const reg = createRegistry();
      const off = defineStageCommands({registry: reg, later: {}});
      const stage = {session: ts.session, share: vi.fn(), shareAvailable: signal(true), menuAvailable: signal(true), openSheet: vi.fn()};
      reg.provide('session', () => ts.session);
      reg.provide('transport', () => ts.session.transport);
      reg.provide('stage', () => stage);
      reg.provide('router', () => ({navigate: vi.fn()}));
      reg.provide('store', () => ({prefs: signal({})}));
      const out = Object.fromEntries(ids.map(id => [id, reg.isEnabled(id)]));
      off();
      return out;
    };
    const shared = await enabled(await open());
    for (const id of ids) expect(shared[id], id).toBe(false);
    const owned = await enabled(await createTestSession({clock}).then(ts => { sessions.push(ts); return ts; }));
    for (const id of ['edit.open', 'edit.map', 'edit.details', 'stage.share']) expect(owned[id], id).toBe(true);
  });
});
