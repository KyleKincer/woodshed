// The Shared Stage at /share/:token (architecture §2.18, spec §4.13): the same Stage, read-only,
// for anyone with the link. main.js hands the boot route over to boot(match) before auth; this
// module runs its own boot list, in order (each step is recorded in `steps`, BOOT_STEPS):
//
//   1 'common'    main.css, the icon sprite, the font preload and the test handle (boot-common.js)
//   2 'root'      html[data-place=stage][data-posture=stage], color-scheme, theme-color; the title
//                 and robots noindex
//   3 'auth'      auth.initialize({optional: true}): never throws; user|null decides
//                 [Add to my library] vs [Sign in to keep a copy]
//   4 'store'     store.session = {user, status, admin: false, online} (kept live), the device prefs,
//                 the key labels; a signed-in viewer's account settings (their profile and practice
//                 defaults); store.stage is the Stage's own (so toasts hold while playing)
//   5 'commands'  the global, stage-transport and stage commands (imported here), the stage.strip and
//                 stage.bars scopes, the command context providers, startDispatcher()
//   6 'palette'   configurePalette({songs: false, navigation: false}); the ? sheet (app.shortcuts) and
//                 feedback (toasts, the status line, dialogs) come with the commands and the Stage
//   7 'starters'  startPedals({router}), startMidi({router}) (by contract path, as main.js runs them); the wake lock,
//                 interruptions, Media Session and gesture audio start with the Stage (stage.js)
//   8 'router'    a router over the single route /share/:token (?save=1, ?bar and ?t mirror into the
//                 URL; ‹, Esc and every other link leave through location.assign)
//   9 'view'      publicClient().subscribe('sharing:view', {token}) → getSession('shared', {shared:
//                 {token, snapshot, resolveUrls: sharing.playback, cacheNamespace}})
//  10 'mount'     stage.js mounted read-only: the HUD's "Shared by …" line plus this module's action in
//                 its slot; Edit, Share, map, detect and re-split are off through `session.readOnly`
//
// Practice saves on this device only (shared-practice.js; the one-time status line). Add to my
// library: flush → shareAudio.save → migrateSharedPractice → location.assign('/s/<newId>'). Already
// saved (or the owner): Open in my library. Signed out: Sign in to keep a copy sets ?save=1 and
// starts sign-in, which returns here; boot then adds the song once the link is confirmed.
// Opening with "my part Out" (the viewer's profile, signed in) applies Minus me when this device has
// no practice of its own for the token yet (as an owner's song with no saved practice does). The
// example song (settings.demo's token, demo.js) applies it whenever the viewer has a profile.
//
// A bad token or a link that is not there renders "This link doesn't work any more." (no network call
// for a malformed token); a failed lookup renders "Couldn't open this song." with Try again. While
// open, a stopped link and changed audio are said in the status line.
//
//   boot(match, deps?) → Promise<{state: 'stage'|'unavailable'|'failed', steps, router, session}>
//   deps replace any module dependency (tests): see DEFAULTS.

import '../styles/views/share/shared-stage.css';
import {bootCommon as appBootCommon} from '../app/boot-common.js';
import * as appAuth from '../app/auth.js';
import {account as appAccount, startAccount as appStartAccount} from '../app/account.js';
import {registry as appRegistry} from '../app/commands.js';
import {startDispatcher as appStartDispatcher} from '../app/dispatch.js';
import {devHandleWanted} from '../app/dev-handle.js';
import * as appFeedback from '../app/feedback.js';
import * as appKeys from '../app/keys.js';
import {configurePalette as appConfigurePalette} from '../app/palette.js';
import {platform as appPlatform} from '../app/platform.js';
import {desktop as appDesktop} from '../app/desktop.js';
import * as appProfile from '../app/profile.js';
import {createRouter as appCreateRouter} from '../app/router.js';
import {effect, signal, store as appStore} from '../app/store.js';
import {describeError} from '../app/error-copy.js';
import {SENTENCES} from '../app/error-copy.copy.js';
import '../app/global-commands.js';
import '../stage/transport-commands.js';
import '../stage/commands.js';
import * as appSharing from '../api/sharing.js';
import * as appSongs from '../api/songs.js';
import {Button} from '../ui/button.js';
import {h} from '../ui/h.js';
import {demoToken as appDemoToken} from './demo.js';
import {migrateSharedPractice, sharedPractice, watchLocalNotice} from './shared-practice.js';
import {COPY} from './share.copy.js';

export const BOOT_STEPS = Object.freeze(['common', 'root', 'auth', 'store', 'commands', 'palette', 'starters', 'router', 'view', 'mount']);
/** The session id of the shared song (sharing.view's snapshot id). */
export const SESSION_ID = 'shared';
/** How long the open waits for a signed-in viewer's account settings before applying "my part Out". */
export const ACCOUNT_WAIT_MS = 1500;
export const SCOPES = Object.freeze(['stage.strip', 'stage.bars']);

// Step 7: the starters, by contract path and export name (the same table main.js runs).
const STARTER_MODULES = import.meta.glob(['../app/pedals.js', '../app/midi.js']);
export const STARTERS = Object.freeze([['../app/pedals.js', 'startPedals'], ['../app/midi.js', 'startMidi']]);

const DEFAULTS = Object.freeze({
  bootCommon: appBootCommon, auth: appAuth, account: appAccount, startAccount: appStartAccount, registry: appRegistry,
  startDispatcher: appStartDispatcher, feedback: appFeedback, keys: appKeys, configurePalette: appConfigurePalette,
  platform: appPlatform, desktop: appDesktop, profile: appProfile, createRouter: appCreateRouter, store: appStore,
  sharing: appSharing, songs: appSongs, starters: STARTER_MODULES, demoToken: appDemoToken,
  getSession: async (id, options) => (await import('../stage/session.js')).getSession(id, options),
  loadStage: () => import('../stage/stage.js'),
});

const sentence = (err) => describeError(err, {context: 'share'}).sentence;

/** Resolves once `loaded` reads true, or after `ms`. */
function whenLoaded(loaded, ms) {
  if (!loaded || typeof loaded.peek !== 'function' || loaded.peek()) return Promise.resolve();
  return new Promise((resolve) => {
    let off = null;
    const done = () => { clearTimeout(timer); off?.(); resolve(); };
    const timer = setTimeout(done, ms);
    off = loaded.subscribe?.((value) => { if (value) done(); }) ?? null;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Root and frame

function paintRoot(doc, win) {
  const root = doc.documentElement;
  root.dataset.place = 'stage';
  root.dataset.posture = 'stage';
  const dark = root.dataset.stageTheme === 'dark' || root.dataset.theme === 'dark';
  root.style.colorScheme = dark ? 'dark' : 'light';
  const appearance = win?.woodshedAppearance;
  if (appearance && typeof appearance.refresh === 'function') {
    appearance.refresh();
    root.style.colorScheme = dark ? 'dark' : 'light';
  } else {
    const bg = win?.getComputedStyle?.(root)?.getPropertyValue?.('--bg')?.trim();
    if (bg) doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  }
  doc.title = COPY.documentTitle;
  if (!doc.head.querySelector('meta[name="robots"]')) {
    doc.head.append(h('meta', {name: 'robots', content: 'noindex, nofollow, noarchive'}));
  }
}

function stageFrame(doc) {
  const app = doc.getElementById('app') ?? doc.body.appendChild(doc.createElement('div'));
  app.id = 'app';
  app.className = 'app-frame';
  app.dataset.chrome = 'none';
  const outlet = h('div', {class: 'shell-outlet'});
  app.replaceChildren(h('main', {class: 'app-main shell-main'}, outlet));
  let modalOutlet = doc.querySelector('[data-modal-outlet]');
  if (!modalOutlet) {
    modalOutlet = doc.createElement('div');
    modalOutlet.setAttribute('data-modal-outlet', '');
    app.after(modalOutlet);
  }
  return {app, outlet, modalOutlet};
}

/** The page for a link that does not work is not the Stage: it leaves the Stage place and follows the app theme. */
function leaveStagePlace(doc, win) {
  const root = doc.documentElement;
  delete root.dataset.place;
  delete root.dataset.posture;
  root.style.colorScheme = root.dataset.theme === 'dark' ? 'dark' : 'light';
  const appearance = win?.woodshedAppearance;
  if (appearance && typeof appearance.refresh === 'function') appearance.refresh();
  else {
    const bg = win?.getComputedStyle?.(root)?.getPropertyValue?.('--bg')?.trim();
    if (bg) doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  }
}

/** The calm full page for a link that does not work (or could not be read). */
function renderPage(doc, {state, title, body, action, win}) {
  leaveStagePlace(doc, win);
  const {outlet} = stageFrame(doc);
  const titleId = 'share-page-title';
  const page = h('div', {class: 'share-page', dataset: {shareState: state}},
    h('section', {class: 'share-page-card', attrs: {role: state === 'failed' ? 'alert' : null, 'aria-labelledby': titleId}},
      h('h1', {class: 'share-page-title', id: titleId}, title),
      h('p', {class: 'share-page-body'}, body),
      h('div', {class: 'share-page-actions'}, action)));
  outlet.replaceChildren(page);
  doc.documentElement.dataset.viewReady = 'share';
  return page;
}

function renderUnavailable(doc, win) {
  const home = h('a', {class: 'ui-button share-page-link', href: '/', dataset: {variant: 'primary', size: 'md'}},
    h('span', {class: 'ui-button-text'}, h('span', {class: 'ui-button-label'}, COPY.home)));
  return renderPage(doc, {state: 'unavailable', title: SENTENCES.missingShare, body: COPY.missingBody, action: home, win});
}

function renderFailed(doc, win) {
  const retry = Button({label: COPY.retry, variant: 'primary', icon: 'refresh-cw', onClick: () => win.location.reload()});
  return renderPage(doc, {state: 'failed', title: COPY.failedTitle, body: COPY.failedBody, action: retry.el, win});
}

// ---------------------------------------------------------------------------------------------------------------
// The identity row's action (spec §4.13)

/**
 * Add to my library / Open in my library / Sign in to keep a copy, in the HUD's action slot.
 * `user` and `stopped` are signals; `saved` mirrors sharing.saved for a signed-in viewer.
 */
export function mountShareAction(slot, {token, session, user, stopped, autoSave = false, d, router, win}) {
  const saved = signal(null);          // {songId, status} | null (null until the first answer, too)
  const answered = signal(false);
  const busy = signal(false);
  const signingIn = signal(false);
  const offs = [];
  let destroyed = false;
  let pendingSave = !!autoSave;   // ?save=1: add once the first sharing.saved answer is in

  const button = Button({label: COPY.add, variant: 'primary', size: 'sm', className: 'share-action', onClick: () => void press()});
  slot?.replaceChildren(button.el);

  offs.push(effect(() => {
    const u = user.value, s = saved.value, isBusy = busy.value, signing = signingIn.value, off = stopped.value;
    const copying = s?.status === 'copying';
    let label = COPY.add, busyLabel = false;
    if (!u) { label = COPY.signIn; if (signing) busyLabel = COPY.signingIn; }
    else if (s?.songId) label = COPY.open;
    else if (isBusy || copying) busyLabel = COPY.adding;
    const hidden = off && !s?.songId;
    button.el.hidden = hidden;
    button.set({label, busy: busyLabel, disabled: !!busyLabel || (!!u && !answered.value && !s)});
    button.el.dataset.shareAction = !u ? 'signin' : s?.songId ? 'open' : 'add';
  }));

  let offSaved = null;
  offs.push(effect(() => {
    const u = user.value;
    offSaved?.();
    offSaved = null;
    saved.value = null;
    answered.value = false;
    if (!u) return;
    offSaved = d.sharing.subscribeSaved({token}, (value) => {
      if (destroyed) return;
      saved.value = value ?? null;
      const first = !answered.peek();
      answered.value = true;
      if (first && pendingSave) { pendingSave = false; void finishPendingSave(); }
    }, (err) => {
      if (destroyed) return;
      answered.value = true;
      console.warn('[share] sharing.saved failed', err);
    });
  }));
  offs.push(() => offSaved?.());

  async function finishPendingSave() {
    router?.setQuery?.({save: null});
    if (stopped.peek()) return;
    const s = saved.peek();
    if (s?.songId) { win.location.assign(`/s/${encodeURIComponent(s.songId)}`); return; }
    if (s?.status === 'copying') return;
    await addToLibrary();
  }
  if (pendingSave && !user.peek()) { pendingSave = false; router?.setQuery?.({save: null}); }

  async function press() {
    if (busy.peek() || signingIn.peek() || destroyed) return;
    if (!user.peek()) { await signInToKeep(); return; }
    const s = saved.peek();
    if (s?.songId) { win.location.assign(`/s/${encodeURIComponent(s.songId)}`); return; }
    if (s?.status === 'copying' || stopped.peek()) return;
    await addToLibrary();
  }

  async function signInToKeep() {
    signingIn.value = true;
    router?.setQuery?.({save: '1'});
    try {
      await d.auth.signIn();
    } catch (err) {
      if (destroyed) return;
      signingIn.value = false;
      router?.setQuery?.({save: null});
      d.feedback.status?.(err?.message || sentence(err), {key: 'share-add', tone: 'error', durationMs: 8000});
    }
  }

  async function addToLibrary() {
    if (busy.peek()) return;
    busy.value = true;
    d.feedback.status?.(COPY.addingStatus, {key: 'share-add', durationMs: Infinity});
    let songId;
    try {
      if (!session.disposed) await session.flush?.({final: true});
      songId = await d.sharing.save({token});
    } catch (err) {
      if (destroyed) return;
      busy.value = false;
      d.feedback.status?.(sentence(err), {key: 'share-add', tone: 'error', durationMs: 8000});
      return;
    }
    try {
      await migrateSharedPractice({token, songId, duration: session.song?.peek?.()?.duration, songs: d.songs});
    } catch (err) {
      // The copy exists; the device copy is kept (not cleared) and the saved song opens with the shared practice.
      console.error('[share] the practice from this device could not be moved into the saved song', err);
    }
    d.feedback.dismissStatus?.('share-add');
    win.location.assign(`/s/${encodeURIComponent(songId)}`);
  }

  return {
    el: button.el,
    saved,
    press,
    destroy() {
      destroyed = true;
      for (const off of offs.splice(0).reverse()) { try { off(); } catch (err) { console.error('[share] cleanup failed', err); } }
      button.destroy();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Minus me from the profile

/** Whether `token` is the example song's link (settings.demo); false when that cannot be read. */
async function isDemo(token, d) {
  try { return (await d.demoToken()) === token; } catch { return false; }
}

async function applyMyPart({session, user, d, hadLocal, token}) {
  if (!user || hadLocal || session.disposed) return false;
  const [demo] = await Promise.all([isDemo(token, d), whenLoaded(d.account?.loaded, ACCOUNT_WAIT_MS)]);
  const profile = d.account?.value?.peek?.()?.profile;
  // The example song always starts with the viewer's part out (spec §6.6.4: "Your part starts muted");
  // any other link follows the viewer's "Open songs with my part" setting, as their own songs do.
  if (!profile || (!demo && profile.openWithMyPart !== 'out') || session.disposed) return false;
  const stems = (session.song?.peek?.()?.stems ?? []).map((s) => s.name);
  if (!d.profile.myStems(profile, stems).names.length) return false;
  return session.transport?.minusMe?.(true, {undoable: false}) === true;
}

// ---------------------------------------------------------------------------------------------------------------
// Boot

/** The first value of the shared song's subscription; later values go to `later`. Returns {value, off}. */
function firstView(sharing, token, later) {
  return new Promise((resolve, reject) => {
    let first = true;
    let off = () => {};
    off = sharing.subscribeView({token}, (value) => {
      if (first) { first = false; resolve({value: value ?? null, off: () => off()}); return; }
      later(value ?? null);
    }, (err) => {
      if (first) { first = false; off(); reject(err); return; }
      console.warn('[share] sharing.view failed', err);
    });
  });
}

/** bootRoutes entry for /share/:token. See the header. */
export async function boot(match, deps = {}) {
  const d = {...DEFAULTS, ...deps};
  const win = d.win ?? globalThis.window;
  const doc = d.doc ?? globalThis.document;
  const steps = [];
  const mark = (step) => { steps.push(step); };
  const token = String(match?.params?.token ?? '');
  let router = null;
  let session = null;
  const result = (state) => ({state, steps, router, session});
  if (devHandleWanted(win)) {
    try { Object.defineProperty(win, '__woodshedShare', {value: Object.freeze({get steps() { return [...steps]; }}), configurable: true}); }
    catch { /* a frozen window in tests */ }
  }

  // 1.
  d.bootCommon({doc, win, activeSession: () => session, settled: () => router?.settled() ?? Promise.resolve()});
  mark('common');

  // 2.
  paintRoot(doc, win);
  mark('root');

  // 3.
  d.auth.configure?.({activeSession: () => session});
  const {user, status, error: authError} = await d.auth.initialize({optional: true});
  mark('auth');

  // 4.
  const userSig = signal(user ?? null);
  d.store.session.value = {user: user ?? null, status: status ?? null, admin: false, online: d.platform.online.peek()};
  effect(() => {
    const online = d.platform.online.value;
    if (d.store.session.peek().online !== online) d.store.session.value = {...d.store.session.peek(), online};
  });
  d.auth.onChange?.((next) => {
    d.store.session.value = {...d.store.session.peek(), user: next.user ?? null, status: next.status ?? null};
    userSig.value = next.user ?? null;
  });
  void d.store.prefs.peek();
  d.keys.setPlatform?.(d.platform);
  const layoutMap = d.keys.loadLayoutMap?.(win.navigator);
  if (user) d.startAccount();
  mark('store');

  // 5.
  for (const name of SCOPES) if (!d.registry.getScope?.(name)) d.registry.defineScope(name);
  d.registry.provide('router', () => router);
  d.registry.provide('store', () => d.store);
  d.registry.provide('feedback', () => d.feedback);
  d.registry.provide('platform', () => d.platform);
  d.registry.provide('desktop', () => d.desktop);
  d.startDispatcher();
  mark('commands');

  // 6.
  d.configurePalette({songs: false, navigation: false});
  mark('palette');

  // 7.
  // main.js passes {router}; the Shared Stage's router is built at step 8, so `router` is read when used.
  const starterArgs = Object.freeze({get router() { return router; }});
  for (const [path, name] of STARTERS) {
    const load = d.starters?.[path];
    if (!load) continue;
    try {
      const mod = await load();
      if (typeof mod[name] === 'function') await mod[name](starterArgs);
    } catch (err) {
      console.error(`[share] ${name} failed`, err);
    }
  }
  mark('starters');

  // 8.
  await layoutMap;
  const frame = stageFrame(doc);
  const stopped = signal(false);
  const autoSave = new URLSearchParams(win.location.search).get('save') === '1';
  let action = null;
  const view = {
    async mount(el, m, ctx) {
      const stage = await d.loadStage();
      const instance = await stage.mount(el, m, ctx);
      if (ctx.session && !ctx.sessionError) {
        action = mountShareAction(el.querySelector('.hud-action-slot'), {
          token, session: ctx.session, user: userSig, stopped, autoSave, d, router, win,
        });
      }
      return {
        update: (next) => instance?.update?.(next),
        unmount() { action?.destroy(); action = null; instance?.unmount?.(); },
      };
    },
  };
  const route = Object.freeze({name: 'share', path: '/share/:token', place: 'stage', chrome: 'none', posture: 'stage', session: true,
    params: Object.freeze({songId: SESSION_ID}), view: async () => view});
  const ctx = {store: d.store, registry: d.registry, feedback: d.feedback, platform: d.platform, desktop: d.desktop,
    getSession: async () => session, disposeSession: async () => {}};
  router = d.createRouter({routes: [route], outlet: frame.outlet, modalOutlet: frame.modalOutlet, window: win, ctx,
    assign: (href) => win.location.assign(href)});
  router.link(frame.app);
  router.link(frame.modalOutlet);
  mark('router');

  // 9.
  if (!d.sharing.isShareToken(token)) { renderUnavailable(doc, win); return result('unavailable'); }
  let first;
  let revision = null;
  const later = (value) => {
    if (!value) {
      if (stopped.peek()) return;
      stopped.value = true;
      d.feedback.status?.(COPY.linkStopped, {key: 'share-view', durationMs: Infinity});
      return;
    }
    if (stopped.peek()) { stopped.value = false; d.feedback.dismissStatus?.('share-view'); }
    if (value.revision !== revision) {
      revision = value.revision;
      d.feedback.status?.(COPY.audioChanged, {key: 'share-view', durationMs: Infinity,
        action: {label: COPY.reload, run: () => win.location.reload()}});
    }
  };
  try {
    first = await firstView(d.sharing, token, later);
  } catch (err) {
    console.warn('[share] the shared song could not be read', err);
    renderFailed(doc, win);
    return result('failed');
  }
  if (!first.value) { first.off(); renderUnavailable(doc, win); return result('unavailable'); }
  const snapshot = first.value;
  revision = snapshot.revision ?? null;
  if (snapshot.title) doc.title = COPY.songTitle(snapshot.title);
  const local = sharedPractice(token);
  const hadLocal = local.has();
  try {
    session = await d.getSession(SESSION_ID, {shared: {
      token, snapshot, resolveUrls: d.sharing.playback, cacheNamespace: `share:${token}:${revision ?? ''}:`,
    }});
  } catch (err) {
    first.off();
    console.error('[share] the shared session could not open', err);
    renderFailed(doc, win);
    return result('failed');
  }
  mark('view');
  void applyMyPart({session, user, d, hadLocal, token})
    .catch((err) => { console.warn('[share] my part could not be taken out', err); return false; })
    .then(() => { if (!session.disposed) watchLocalNotice({session, token, status: d.feedback.status}); });

  // 10.
  await router.start();
  mark('mount');
  if (authError && autoSave) d.feedback.status?.(authError.message || sentence(authError), {key: 'share-add', tone: 'error', durationMs: 8000});
  return result('stage');
}
