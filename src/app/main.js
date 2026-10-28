// The app's boot (architecture §2.3.1), in order:
//   1. main.css, the icon sprite, the font preload and the test handle (boot-common.js)
//   2. a boot route (/download, /share/:token) hands over to that module's boot(match), then the boot
//      status leaves (finishStartup) and the boot stops here
//   3. auth.initialize(): AuthError 'oauth' → the sign-in card with the error; 'config'/'network' (and
//      anything unexpected) → the fatal card, whose Retry runs initialize() again; signed out → the
//      sign-in card; suspended → the paused page. Each of these stops the boot.
//   4. store.session = {user, status, admin: admin.access, online} before the router starts, so the
//      /admin guard works on a deep link; desktop.start()
//   5. startAccount(): settings.config → store.config/store.account; it applies and clears
//      store.pendingAccount itself
//   6. startData(): songs, jobs, devices, setlists → store.library
//   7. every commands module (definitions are eager, D46), the command context providers,
//      startDispatcher(), and the starters of later packages once their modules exist
//      (startPedals, startMidi, startDesktopMenu, startNotifyReady, startLibraryDrop)
//   8. the app frame (top bar, banners, outlet), router.start(), then /welcome is pushed once when
//      account.onboarding.whatDoYouPlay is unset (D39)
// Leaving: the router calls its onLeave hooks on pagehide and visibilitychange → hidden.
//
// boot() runs on load; tests (Vite mode 'test') call it themselves. It resolves to
// {kind: 'app'|'signin'|'paused'|'download'|'share', router?}.

import '../styles/main.css';
import {bootCommon} from './boot-common.js';
import {bootRoutes, matchBootRoute, redirects, routes} from './routes.js';
import * as auth from './auth.js';
import {query} from '../api/client.js';
import {account, startAccount} from './account.js';
import {startData} from './data.js';
import {registry} from './commands.js';
import {startDispatcher} from './dispatch.js';
import * as keys from './keys.js';
import {createRouter} from './router.js';
import {computed, effect, store} from './store.js';
import {platform} from './platform.js';
import {desktop} from './desktop.js';
import * as feedback from './feedback.js';
import {mountTopbar} from './topbar.js';
import {mountBanners, renderFatal, renderPaused} from './fatal.js';
import {renderSignIn as placeholderSignIn} from './placeholder.js';
import './global-commands.js';
import {finishStartup, showSignIn, showStartup} from '../js/startup.js';
import {likelySupportsOpus} from '../js/stemcache.js';

// Step 7: the other definition modules register on import. They belong to later waves; a module
// that does not exist yet is simply not in the glob (its commands appear when it lands).
const COMMAND_MODULES = import.meta.glob(['../library/commands.js', '../stage/transport-commands.js', '../stage/commands.js',
  '../edit/commands.js', '../edit/map/commands.js', '../edit/chart/commands.js'], {eager: true});

// Step 7: starters owned by later packages, by contract path and export name.
const STARTER_MODULES = import.meta.glob(['./pedals.js', './midi.js', './desktop-menu.js', './notify-ready.js', '../library/dropzone.js']);
export const STARTERS = Object.freeze([
  ['./pedals.js', 'startPedals'], ['./midi.js', 'startMidi'], ['./desktop-menu.js', 'startDesktopMenu'],
  ['./notify-ready.js', 'startNotifyReady'], ['../library/dropzone.js', 'startLibraryDrop'],
]);

// Step 3: ON1's sign-in card (a later wave); until it lands the placeholder's card signs in.
const SIGN_IN = import.meta.glob('../onboarding/signin.js');

/** The definition modules main.js loaded (tests, registry CI). */
export const commandModules = Object.freeze(Object.keys(COMMAND_MODULES));

// ---------- the session (src/stage/session.js), loaded with the first Stage or Edit route ----------

let sessionModule = null;
async function loadSession() {
  sessionModule ??= await import('../stage/session.js');
  return sessionModule;
}
export const getSession = async (songId, options) => (await loadSession()).getSession(songId, options);
export const disposeSession = async songId => (await loadSession()).disposeSession(songId);
/** The open session, or null; no session can be open before session.js has loaded. */
export const activeSession = () => (sessionModule ? sessionModule.activeSession() : null);

// ---------- frame ----------

function bareFrame(doc) {
  const app = doc.getElementById('app') ?? doc.body.appendChild(doc.createElement('div'));
  app.id = 'app';
  app.className = 'app-frame';
  app.dataset.chrome = 'none';
  const main = doc.createElement('main');
  main.className = 'app-main';
  app.replaceChildren(main);
  return main;
}

function appFrame(doc) {
  const app = doc.getElementById('app') ?? doc.body.appendChild(doc.createElement('div'));
  app.id = 'app';
  app.className = 'app-frame';
  app.dataset.chrome = 'topbar';
  const header = doc.createElement('header');
  const main = doc.createElement('main');
  main.className = 'app-main shell-main';
  const banners = doc.createElement('div');
  banners.className = 'shell-banners';
  banners.hidden = true;
  const outlet = doc.createElement('div');
  outlet.className = 'shell-outlet';
  main.append(banners, outlet);
  app.replaceChildren(header, main);
  let modalOutlet = doc.querySelector('[data-modal-outlet]');
  if (!modalOutlet) {
    modalOutlet = doc.createElement('div');
    modalOutlet.setAttribute('data-modal-outlet', '');
    app.after(modalOutlet);
  }
  return {app, header, main, banners, outlet, modalOutlet};
}

// ---------- boot ----------

/** Resolves once a boolean signal reads true. */
const whenTrue = sig => new Promise(resolve => {
  if (sig.peek()) { resolve(); return; }
  const off = sig.subscribe(value => { if (value) { off(); resolve(); } });
});

async function renderSignInView(doc, {error}) {
  const el = bareFrame(doc);
  const load = SIGN_IN['../onboarding/signin.js'];
  const render = load ? (await load()).renderSignIn : placeholderSignIn;
  render(el, {error: error ?? null, signIn: () => auth.signIn()});
  showSignIn({doc});
}

/** Shows the fatal card and resolves when Retry is pressed. */
function fatalRetry(doc, err) {
  return new Promise(resolve => {
    const el = bareFrame(doc);
    const card = renderFatal(el, {details: err, onRetry: () => { card.destroy(); resolve(); }});
    finishStartup({doc});
  });
}

/** Step 3. Resolves {user, status, error?}; config and network failures wait on the fatal card's Retry. */
async function initializeAuth(doc, win) {
  for (;;) {
    try {
      return await auth.initialize();
    } catch (err) {
      if (err?.kind === 'oauth') return {user: null, status: null, error: err};
      await fatalRetry(doc, err);
      showStartup({doc, onRetry: () => win.location.reload()});
    }
  }
}

async function runStarters({router}) {
  for (const [path, name] of STARTERS) {
    const load = STARTER_MODULES[path];
    if (!load) continue;
    try {
      const mod = await load();
      if (typeof mod[name] === 'function') await mod[name]({router});
    } catch (err) {
      console.error(`[boot] ${name} failed`, err);
    }
  }
}

export async function boot({win = globalThis.window, doc = globalThis.document} = {}) {
  let router = null;
  // 1.
  bootCommon({doc, win, activeSession, settled: () => router?.settled() ?? Promise.resolve()});

  // 2.
  const bootMatch = matchBootRoute(win.location.pathname, bootRoutes);
  if (bootMatch) {
    const mod = await bootMatch.route.boot();
    await mod.boot(bootMatch);
    // index.html ships the status pill; the boot module's page is up now, so it leaves (§2.3.1).
    finishStartup({doc});
    return {kind: bootMatch.name};
  }

  // Device prefs (and the one-way migration of the 1.x keys) before anything renders.
  void store.prefs.peek();
  keys.setPlatform(platform);
  const layoutMap = keys.loadLayoutMap(win.navigator);
  showStartup({doc, onRetry: () => win.location.reload()});
  auth.configure({activeSession});

  // 3.
  const {user, status, error} = await initializeAuth(doc, win);
  if (!user) {
    await renderSignInView(doc, {error});
    // A sign-in finished in another tab: boot again as that user.
    auth.onChange(next => { if (next.user) win.location.reload(); });
    return {kind: 'signin'};
  }
  if (status === 'suspended') {
    renderPaused(bareFrame(doc), {status, win});
    finishStartup({doc});
    auth.onChange(next => { if (!next.user || next.status !== 'suspended') win.location.reload(); });
    return {kind: 'paused'};
  }

  // 4.
  const admin = await query('admin:access', {}).catch(() => false);
  store.session.value = {user, status, admin: admin === true, online: platform.online.peek()};
  effect(() => {
    const online = platform.online.value;
    if (store.session.peek().online !== online) store.session.value = {...store.session.peek(), online};
  });
  auth.onChange(next => {
    // Signed out (here or in another tab), or paused while open: boot again from the top.
    if (!next.user || next.status === 'suspended') { win.location.reload(); return; }
    store.session.value = {...store.session.peek(), user: next.user, status: next.status};
  });
  desktop.start().catch(err => console.error('[boot] desktop.start failed', err));
  // The native window follows the theme once now; prefs.js keeps it in step after that.
  desktop.setTheme(store.prefs.peek().theme).catch(() => {});

  // 5. and 6.
  startAccount();
  startData();

  // 7.
  registry.provide('router', () => router);
  registry.provide('store', () => store);
  registry.provide('feedback', () => feedback);
  registry.provide('platform', () => platform);
  registry.provide('desktop', () => desktop);
  startDispatcher();

  // 8. Key-caps are labelled on creation: the platform and the keyboard layout come first.
  await layoutMap;
  const frame = appFrame(doc);
  const ctx = {store, registry, feedback, platform, desktop, getSession, disposeSession};
  router = createRouter({routes, redirects, outlet: frame.outlet, modalOutlet: frame.modalOutlet, window: win, ctx});
  const topbar = mountTopbar(frame.header, {router, store, desktop, registry});
  ctx.topbar = topbar;
  registry.provide('topbar', () => topbar);
  router.link(frame.app);
  router.link(frame.modalOutlet);
  effect(() => {
    const m = router.current.value;
    const chrome = m?.route?.chrome === 'none' ? 'none' : 'topbar';
    frame.app.dataset.chrome = chrome;
    frame.header.hidden = chrome !== 'topbar';
    registry.invalidate();
  });
  effect(() => { void store.prefs.value; void store.session.value; void store.update.value; registry.invalidate(); });
  // The banners belong to top-bar places only: the Stage, Edit and /welcome are full-bleed (spec §1.3).
  const onTopbarPlace = computed(() => router.current.value?.route?.chrome !== 'none');
  mountBanners(frame.banners, {store, platform, codecSupported: likelySupportsOpus(), visible: onTopbarPlace,
    navigate: path => router.navigate(path)});
  await runStarters({router});
  await router.start();
  finishStartup({doc});

  // D39: first run asks "What do you play?" once.
  void whenTrue(account.loaded).then(() => {
    if (account.value.peek()?.onboarding?.whatDoYouPlay) return;
    if (router.current.peek()?.name === 'welcome') return;
    router.navigate('/welcome');
  });
  return {kind: 'app', router, topbar};
}

export const booted = import.meta.env?.MODE === 'test' ? null : boot().catch(err => {
  console.error('[boot] failed', err);
  const doc = globalThis.document;
  const el = bareFrame(doc);
  renderFatal(el, {details: err, onRetry: () => globalThis.location.reload()});
  finishStartup({doc});
});
