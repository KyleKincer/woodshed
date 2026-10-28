// Platform signals and services (architecture §2.11, spec §4.2, D13).
//
//   detect(globals)                pure: {isDesktopApp, isMac, isIPad, isIOS, isWindows, features}
//   platform                       detect() for this window plus live media/online signals
//   haptic(ms)                     navigator.vibrate when present
//   createWakeLock()               the Stage's screen wake lock policy
//   watchInterruptions()           audio interruptions → transport.interrupt('audio')
//   startMediaSession()            Media Session handlers, metadata, and the iOS/iPadOS keep-alive
//   startGestureAudio()            resume the AudioContext inside the Play gesture
//   install                        PWA install state and prompt
//
// Everything that reads a global takes it as an option, so tests pass fakes;
// the defaults read the window at call time.
//
// `isIOS` is true for every Apple touch device (iPhone, iPod and iPad, including
// desktop-class iPadOS Safari, which reports MacIntel); `isIPad` is the iPad subset.
// The fixture's `fx-platform` and `fx-nofeature` switches come from
// window.__FIXTURE_EARLY__.fx (or window.fixture.fx), never the query string, so
// they survive a reload after the app rewrote the URL.

import {signal, computed, store} from './store.js';
import {now as clockNow} from './clock.js';
import {registry} from './commands.js';
import {desktop as desktopBridge} from './desktop.js';

/** fx-nofeature tokens → feature keys. */
export const FEATURE_SWITCHES = Object.freeze({
  anchor: 'anchor', popover: 'popover', wakelock: 'wakeLock', midi: 'midi', mediasession: 'mediaSession', viewtransition: 'viewTransition',
});
export const FX_PLATFORMS = Object.freeze(['ipad', 'mac', 'win']);

/** The wake-lock choices of account.practice.wake (minutes, or 'always'); 10 is the default. */
export const WAKE_CHOICES = Object.freeze([5, 10, 30, 'always']);
export const WAKE_DEFAULT = 10;

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

/**
 * Pure platform detection. `fx` is the fixture switch map ({platform, nofeature}),
 * applied over what the navigator says; `css` and `document` feed the anchor,
 * popover and view-transition probes. `matchMedia` and `location` are accepted for
 * the contract's shape; detection does not need them.
 */
export function detect({navigator: nav = {}, matchMedia, location, bridge = null, css = null, document: doc = null, fx = null} = {}) {
  void matchMedia; void location;
  nav = nav ?? {};
  const ua = String(nav.userAgent ?? '');
  const hinted = String(nav.userAgentData?.platform ?? '');
  const plat = `${hinted} ${String(nav.platform ?? '')}`;
  const touchPoints = Number(nav.maxTouchPoints) || 0;
  let isIPad = /iPad/.test(ua) || /iPad/.test(plat) || (/Mac/i.test(plat) && touchPoints > 1);
  let isIOS = isIPad || /iPhone|iPod/.test(ua) || /iPhone|iPod|\biOS\b/i.test(plat);
  let isMac = !isIOS && /Mac/i.test(`${plat} ${ua}`);
  let isWindows = !isIOS && /Win/i.test(`${plat} ${ua}`);

  const features = {
    anchor: !!safe(() => css?.supports?.('anchor-name: --a'), false),
    popover: typeof doc?.documentElement?.showPopover === 'function',
    wakeLock: !!safe(() => nav.wakeLock, null),
    midi: typeof safe(() => nav.requestMIDIAccess, null) === 'function',
    mediaSession: !!safe(() => nav.mediaSession, null),
    viewTransition: typeof doc?.startViewTransition === 'function',
  };

  const forced = String(fx?.platform ?? '').toLowerCase();
  if (forced === 'ipad') { isIPad = true; isIOS = true; isMac = false; isWindows = false; }
  else if (forced === 'mac') { isIPad = false; isIOS = false; isMac = true; isWindows = false; }
  else if (forced === 'win') { isIPad = false; isIOS = false; isMac = false; isWindows = true; }
  for (const raw of String(fx?.nofeature ?? '').split(',')) {
    const key = FEATURE_SWITCHES[raw.trim().toLowerCase()];
    if (key) features[key] = false;
  }

  return {isDesktopApp: !!bridge, isMac, isIPad, isIOS, isWindows, features};
}

/** The fixture switch map when the page runs under the fixture, else null. */
export function fixtureSwitches(win = globalThis.window) {
  if (!win?.__FIXTURE__) return null;
  return win.__FIXTURE_EARLY__?.fx ?? win.fixture?.fx ?? null;
}

/** detect()'s inputs, read from a window. */
export function globalsOf(win = globalThis.window) {
  if (!win) return {navigator: globalThis.navigator ?? {}, bridge: null};
  return {
    navigator: win.navigator ?? {},
    matchMedia: typeof win.matchMedia === 'function' ? q => win.matchMedia(q) : undefined,
    location: win.location,
    bridge: win.woodshedDesktop ?? null,
    css: win.CSS ?? null,
    document: win.document ?? null,
    fx: fixtureSwitches(win),
  };
}

const readonly = s => computed(() => s.value);

function mediaSignal(win, query) {
  const list = safe(() => win?.matchMedia?.(query), null);
  const s = signal(!!list?.matches);
  const onChange = e => { s.value = typeof e?.matches === 'boolean' ? e.matches : !!list.matches; };
  if (list?.addEventListener) list.addEventListener('change', onChange);
  else list?.addListener?.(onChange);
  return readonly(s);
}

/** Builds the platform object for a window (exported for tests; the app uses `platform`). */
export function createPlatform(win = globalThis.window) {
  const info = detect(globalsOf(win));
  const nav = win?.navigator;
  const online = signal(nav?.onLine !== false);
  win?.addEventListener?.('online', () => { online.value = true; });
  win?.addEventListener?.('offline', () => { online.value = false; });
  return Object.freeze({
    ...info,
    coarse: mediaSignal(win, '(pointer: coarse)'),
    hoverFine: mediaSignal(win, '(hover: hover) and (pointer: fine)'),
    reducedMotion: mediaSignal(win, '(prefers-reduced-motion: reduce)'),
    standalone: !!(safe(() => win?.matchMedia?.('(display-mode: standalone)')?.matches, false) || nav?.standalone === true),
    online: readonly(online),
    detect: () => detect(globalsOf(win)),
  });
}

export const platform = createPlatform();

/** A short vibration where supported (D50's long-press feedback); a no-op otherwise. */
export function haptic(ms = 8, nav = globalThis.navigator) {
  if (typeof nav?.vibrate !== 'function') return false;
  return !!safe(() => nav.vibrate(ms), false);
}

// ---------- wake lock ----------

/** account.practice.wake, validated: 5 | 10 | 30 | 'always'. */
export function wakeSetting(value) {
  return WAKE_CHOICES.includes(value) ? value : WAKE_DEFAULT;
}

const timers = () => ({
  set: (fn, ms) => globalThis.setTimeout(fn, ms),
  clear: id => globalThis.clearTimeout(id),
});

/**
 * The Stage's screen wake lock (spec §4.2). Policy: hold while
 * `stageOpen && (playing || wake === 'always' || now - stoppedAt < wake minutes)`.
 * A lock the system takes back (the page hid) is re-acquired on
 * visibilitychange → visible, and a change of the setting (`settings`, the account
 * signal) applies at once. A denied request leaves `supported` true and `held`
 * false, and is retried only on the next visible or Stage open. In the desktop app
 * the lock is `desktop.setActivity({keepAwake})` (powerSaveBlocker) instead.
 */
export function createWakeLock({
  navigator: nav = globalThis.navigator, document: doc = globalThis.document, desktop = desktopBridge,
  wake = () => store.account.value?.practice?.wake, settings = store.account, now = clockNow, timer = timers(),
} = {}) {
  const useDesktop = !!desktop?.available;
  const api = useDesktop ? null : safe(() => nav?.wakeLock, null);
  const held = signal(false);
  const inputs = {stageOpen: false, playing: false, stoppedAt: null};
  let openedAt = null, sentinel = null, pending = null, denied = false, desktopHeld = false, timeoutId = null, destroyed = false;

  const minutes = () => wakeSetting(wake());
  const since = () => inputs.stoppedAt ?? openedAt ?? now();
  const visible = () => !doc || doc.visibilityState === undefined || doc.visibilityState === 'visible';

  function wanted() {
    if (destroyed || !inputs.stageOpen) return false;
    if (inputs.playing) return true;
    const w = minutes();
    return w === 'always' || now() - since() < w * 60_000;
  }

  function clearTimer() {
    if (timeoutId != null) timer.clear(timeoutId);
    timeoutId = null;
  }

  function schedule() {
    clearTimer();
    if (destroyed || !inputs.stageOpen || inputs.playing) return;
    const w = minutes();
    if (w === 'always') return;
    const left = since() + w * 60_000 - now();
    if (left > 0) timeoutId = timer.set(() => { timeoutId = null; evaluate(); }, left);
  }

  function acquire() {
    if (useDesktop) {
      if (!desktopHeld) { desktopHeld = true; desktop.setActivity({keepAwake: true}); }
      held.value = true;
      return;
    }
    if (!api || pending || denied || (sentinel && !sentinel.released) || !visible()) return;
    pending = Promise.resolve()
      .then(() => api.request('screen'))
      .then(s => {
        pending = null;
        if (!wanted()) { safe(() => s.release()?.catch?.(() => {}), null); return; }
        sentinel = s;
        held.value = true;
        s.addEventListener?.('release', () => {
          if (sentinel !== s) return;
          sentinel = null;
          held.value = false;
        });
      }, () => {
        pending = null;
        denied = true;
        held.value = false;
      });
  }

  function drop() {
    if (desktopHeld) { desktopHeld = false; desktop.setActivity({keepAwake: false}); }
    if (sentinel) {
      const s = sentinel;
      sentinel = null;
      safe(() => s.release()?.catch?.(() => {}), null);
    }
    held.value = false;
  }

  function evaluate() {
    if (wanted()) acquire(); else drop();
    schedule();
  }

  const onVisibility = () => {
    if (!visible()) return;
    denied = false;
    evaluate();
  };
  doc?.addEventListener?.('visibilitychange', onVisibility);
  // Changing "Keep the screen on" in Settings applies to an open Stage at once.
  const offSettings = settings?.subscribe?.(() => { if (inputs.stageOpen) evaluate(); }) ?? null;

  function release() {
    inputs.stageOpen = false;
    inputs.playing = false;
    clearTimer();
    drop();
  }

  return {
    held: readonly(held),
    supported: useDesktop || !!api,
    /** Feed the Stage's state; `stoppedAt` defaults to the moment playing turned false (or the Stage opened). */
    update({stageOpen = inputs.stageOpen, playing = inputs.playing, stoppedAt} = {}) {
      if (stageOpen && !inputs.stageOpen) { openedAt = now(); denied = false; inputs.stoppedAt = null; }
      if (!playing && inputs.playing && stoppedAt === undefined) inputs.stoppedAt = now();
      if (stoppedAt !== undefined) inputs.stoppedAt = stoppedAt;
      inputs.stageOpen = !!stageOpen;
      inputs.playing = !!playing;
      evaluate();
    },
    /** Stop holding (the Stage closed). A later update({stageOpen: true}) holds again. */
    release,
    /** release() and stop listening for visibility. */
    destroy() {
      release();
      destroyed = true;
      doc?.removeEventListener?.('visibilitychange', onVisibility);
      offSettings?.();
    },
  };
}

// ---------- interruptions ----------

const PLAYING = new Set(['playing', 'counting']);
const phaseOf = transport => safe(() => (transport.snapshot.peek?.() ?? transport.snapshot.value)?.phase, null);
const armedOf = transport => !!safe(() => (transport.snapshot.peek?.() ?? transport.snapshot.value)?.armed, false);

/**
 * The engine's 'interrupted' event (AudioContext interrupted/suspended while
 * playing), and on iOS/iPadOS the page hiding while playing, become
 * transport.interrupt('audio'): pause, keep the position as the cue, never resume.
 */
export function watchInterruptions({engine, transport, platform: p = platform, document: doc = globalThis.document}) {
  const offs = [];
  if (engine?.on) offs.push(engine.on('interrupted', () => transport.interrupt('audio')));
  if (p?.isIOS || p?.isIPad) {
    const onVisibility = () => {
      if (doc.visibilityState === 'hidden' && PLAYING.has(phaseOf(transport))) transport.interrupt('audio');
    };
    doc?.addEventListener?.('visibilitychange', onVisibility);
    offs.push(() => doc?.removeEventListener?.('visibilitychange', onVisibility));
  }
  return () => { for (const off of offs.splice(0)) safe(off); };
}

// ---------- Media Session (D13) ----------

/** A 1 s silent mono 16-bit WAV at 8 kHz, for the iOS/iPadOS keep-alive element. */
export function silentWav(seconds = 1, rate = 8000) {
  const samples = Math.round(seconds * rate);
  const bytes = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(bytes);
  const ascii = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, 'data'); v.setUint32(40, samples * 2, true);
  return bytes;
}

/** Media Session metadata for a song (client song shape, convex/songs.ts toClient). */
export function mediaMetadataFor(song) {
  if (!song) return null;
  const artist = song.artist || (song.metadataLocks?.includes?.('artist') ? '' : song.uploader || '');
  const artwork = song.coverUrl
    ? [{src: song.coverUrl, sizes: '500x500', type: 'image/jpeg'}]
    : [{src: '/icon-512.png', sizes: '512x512', type: 'image/png'}];
  return {title: song.title ?? '', artist, album: song.album ?? '', artwork};
}

const ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack'];

/**
 * Registers the Media Session handlers for a session (always, D13): play/pause →
 * transport.playStop (play only starts, pause only stops), previoustrack → Again,
 * nexttrack → nav.nextSection. Keeps metadata and playbackState current.
 * On iOS/iPadOS a silent looping <audio> starts inside the transport's 'gesture'
 * (synchronously, so Safari counts it as user-initiated) and pauses on stop,
 * 'ended' and 'interrupted', so headset and lock-screen buttons reach the page.
 * Returns off().
 */
export function startMediaSession({
  transport, session, navigator: nav = globalThis.navigator, document: doc = globalThis.document, platform: p = platform,
  registry: reg = registry, MediaMetadata: Metadata = globalThis.MediaMetadata, url = globalThis.URL,
}) {
  const ms = safe(() => nav?.mediaSession, null);
  const offs = [];
  const playing = () => PLAYING.has(phaseOf(transport));

  if (ms) {
    const handlers = {
      play: () => { if (!playing()) transport.playStop(); },
      pause: () => { if (playing()) transport.playStop(); },
      previoustrack: () => transport.again(),
      nexttrack: () => { if (!reg?.run?.('nav.nextSection', {source: 'media'})) transport.goToRegion?.(1); },
    };
    for (const action of ACTIONS) safe(() => ms.setActionHandler(action, handlers[action]));
    offs.push(() => { for (const action of ACTIONS) safe(() => ms.setActionHandler(action, null)); });

    const setMetadata = song => {
      const m = mediaMetadataFor(song);
      safe(() => { ms.metadata = m && typeof Metadata === 'function' ? new Metadata(m) : null; });
    };
    if (session?.song) {
      setMetadata(session.song.peek?.() ?? session.song.value);
      if (session.song.subscribe) offs.push(session.song.subscribe(song => setMetadata(song)));
    }
    const setState = () => safe(() => { ms.playbackState = playing() ? 'playing' : 'paused'; });
    setState();
    if (transport.snapshot?.subscribe) offs.push(transport.snapshot.subscribe(setState));
    offs.push(() => safe(() => { ms.metadata = null; ms.playbackState = 'none'; }));
  }

  if ((p?.isIOS || p?.isIPad) && doc?.createElement) {
    const el = doc.createElement('audio');
    const src = safe(() => url.createObjectURL(new globalThis.Blob([silentWav()], {type: 'audio/wav'})), null);
    if (src) {
      el.src = src;
      el.loop = true;
      el.volume = 1;
      el.preload = 'auto';
      el.setAttribute('playsinline', '');
      el.dataset.keepAlive = '';
      const start = () => { safe(() => el.play()?.catch?.(() => {})); };
      const pause = () => { safe(() => el.pause()); };
      offs.push(transport.on('gesture', start));
      offs.push(transport.on('ended', pause));
      offs.push(transport.on('interrupted', pause));
      if (transport.snapshot?.subscribe) {
        offs.push(transport.snapshot.subscribe(() => { if (!playing() && !armedOf(transport)) pause(); }));
      }
      offs.push(() => { pause(); el.removeAttribute('src'); safe(() => url.revokeObjectURL(src)); });
    }
  }

  return () => { for (const off of offs.splice(0).reverse()) safe(off); };
}

/**
 * Resumes the AudioContext synchronously inside the Play gesture (iPad
 * Play-when-ready): the transport emits 'gesture' before any await.
 */
export function startGestureAudio({transport, engine}) {
  return transport.on('gesture', () => {
    const ctx = engine?.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    safe(() => ctx.resume()?.catch?.(() => {}));
  });
}

// ---------- PWA install ----------

const isChromium = nav => !!safe(() => nav?.userAgentData?.brands?.some(b => /Chromium/i.test(b.brand)), false);

/**
 * PWA install state: {canPrompt, installed, steps}. `steps` says which
 * instructions to show: 'ios' (Share → Add to Home Screen), 'chromium' (the install
 * prompt or the browser's menu), or 'none' (installed, the desktop app, or a
 * browser without an install path).
 */
export function createInstall({window: win = globalThis.window, platform: p = platform} = {}) {
  const nav = win?.navigator;
  let deferred = null;
  const standaloneList = safe(() => win?.matchMedia?.('(display-mode: standalone)'), null);
  let installed = !!(standaloneList?.matches || nav?.standalone === true || p?.standalone);
  const state = signal(null);
  const compute = () => {
    const steps = installed || p?.isDesktopApp ? 'none'
      : p?.isIOS || p?.isIPad ? 'ios'
        : deferred || isChromium(nav) ? 'chromium' : 'none';
    state.value = {canPrompt: !!deferred && !installed, installed, steps};
  };
  compute();
  win?.addEventListener?.('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e;
    compute();
  });
  win?.addEventListener?.('appinstalled', () => {
    deferred = null;
    installed = true;
    compute();
  });
  standaloneList?.addEventListener?.('change', e => {
    if (e.matches) { installed = true; deferred = null; compute(); }
  });
  return {
    state: readonly(state),
    /** Shows the browser's install prompt; resolves 'accepted', 'dismissed' or 'unavailable'. */
    async prompt() {
      const e = deferred;
      if (!e) return 'unavailable';
      deferred = null;
      compute();
      const choice = await e.prompt();
      const outcome = (choice ?? await e.userChoice)?.outcome ?? 'dismissed';
      if (outcome === 'accepted') installed = true;
      compute();
      return outcome;
    },
  };
}

export const install = createInstall();
