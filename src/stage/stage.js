// The Stage view (architecture §2.14.10, spec §4): the practice surface's frame. It lays out the
// HUD, the music, the song strip and the controls as a right rail (laptop, iPad landscape) or a
// band (iPad portrait, narrow windows), and owns everything between them:
//
// - Layout (§2.14.9): rail/band from the window, the Distance (prefs.practice.distance), Focus
//   (prefs.practice.focus), the 150 ms debounced relayout on resize/rotation with the anchor kept.
// - The music surface: Chart, Road map (Wave page when unmapped) or Stems, chosen per song
//   (practice.surface, else surfaceDefault, switched once when the drum part answers), switched
//   with a crossfade from the old surface's anchor; glass (pressPolicy) for taps on the music.
// - Loading and errors: everything is live while the audio loads; a load error replaces the music
//   with its message and disables the transport commands (aria-disabled, with the reason).
// - The status line (feedback.status), the resume chip, the detection and markers offers, the
//   "Is this the right recording?" banner (D43), the glass pill, undo feedback.
// - Leaving: ‹ (a 600 ms hold while playing, the HUD's HoldButton), Esc when stopped and not on an
//   iPad (app.escape), Back; leaving returns to the Library entry with its card refocused.
// - Per session while mounted: the wake lock, the interruption watcher, the Media Session and the
//   gesture-audio resume (platform.js), store.stage, prefs.library.opened, the setlist context
//   (?set=), the URL (?bar=/?t= written on Stop; ?spot=, ?bar=, ?t= applied on open).
// - The Library → Stage View Transition (the opened card's cover morphs into the identity cover)
//   when supported and motion is allowed; otherwise the Stage simply appears.
//
//   mount(el, match, ctx) → {update(match), unmount()}
//     ctx: {router, store, registry, feedback, platform, desktop, session, sessionError?, stageDeps?}
//   surfaceDefault(song, hasNotation) → 'chart' | 'roadmap'
//   armStageEntry(router, {platform, document}) → off    the Library → Stage transition hook (idempotent)
//
// The 'stage' command context (§2.14.10; commands.js and transport-commands.js read it):
//   {session, layout, surface, focus, distance, following, display, followStyle, setlist, wakeHeld,
//    load, loadLabel, menuAvailable, shareAvailable (signals, read with peek()),
//    setSurface(kind), cycleSurface(), toggleFocus(), setDistance(d), zoom(dir, {source, event}), commitSize(),
//    resumeFollow(), setDisplay(layout), setFollowStyle(style), openSheet(name, {anchor}), closeSheets(),
//    openMenu(kind, {anchor, t, bar, region, spot, marker, stemName, rename, onOpen, zoomToLoop}), share(), startOver(),
//    leave(), close(), leaveHint(), goSetlist(dir), scrollBy(screens), scrollTop(), batch(fn), statusLine, anchors,
//    plateHost (the music area: the count-in plate)}
// followStyle is per surface (spec §4.4B, Appendix C item 117): the Road map and the Wave page follow with
// prefs.roadmap.follow, else 'scroll' (the current row held at 30%), on both layouts; the Chart and Stems with
// prefs.practice.follow[layout] (rail 'scroll', band 'page'). setFollowStyle writes the shown surface's key.
// D54 release (Appendix C item 118): a Distance change applies a deferred chart size at once, or when the menu it came
// from closes; =/− from the keyboard on the key's keyup; a held stepper calls commitSize() on release.
// openMenu kinds: 'stage' | 'bar' | 'section' | 'spot' | 'marker' | 'loopBand' | 'stem' (ST8a's builders). A surface's
// 'context'/'long' activation that carries `target: {kind: 'spot'|'marker'|'loopBand'|'stem', spot?, marker?,
// stemName?}` opens that menu instead of the bar menu.
// `anchors` is a Map: explicit entries (anchors.set(name, el)) first, then the Stage's
// `[data-stage-anchor=<name>]` element (HUD, controls and strip mark theirs), then the controls area.
//
// Peers: hud.js, controls.js and strip.js (wave 2a) are imported statically by contract path.
// Surfaces, menus, sheets and the share dialog (later waves) resolve by contract path and render
// a "Not built yet" note until they exist (D2, Appendix C item 58).

import '../styles/views/stage/stage.css';
import '../styles/views/stage/status.css';
import '../styles/views/stage/focus.css';
import {registry as appRegistry} from '../app/commands.js';
import {batch, computed, effect, readonly, signal, store as appStore} from '../app/store.js';
import {prefs as appPrefs} from '../app/prefs.js';
import * as appFeedback from '../app/feedback.js';
import {createWakeLock, platform as appPlatform, startGestureAudio, startMediaSession, watchInterruptions} from '../app/platform.js';
import * as setlistsApi from '../api/setlists.js';
import {h} from '../ui/h.js';
import {Button} from '../ui/button.js';
import {Menu} from '../ui/menu.js';
import {formatClock} from '../../shared/practice.ts';
import {pressPolicy} from './glass.js';
import {mountHud} from './hud.js';
import {mountControls} from './controls.js';
import {mountStrip} from './strip.js';
import {mountReviewBanner, shouldReview} from './review-banner.js';
import {closeSheets as hostCloseSheets, openSheet as hostOpenSheet} from './sheets/host.js';
import {applyStageAttributes, createLayoutWatcher, distanceOf, isNarrow, stageLayout, FRAME} from './layout.js';
import {armStageEntry, canEntryTransition, dropEntryGhost, entryGhost, ENTRY_WAIT_MS, openSpot, SURFACE_ORDER} from './commands.js';
import {COPY, loadingLabel, mixWord, resumeText} from './stage.copy.js';

// Later-wave modules, by contract path (D2; Appendix C item 58).
const LATER = import.meta.glob(['./surfaces/chart-surface.js', './surfaces/roadmap-surface.js', './surfaces/stems-surface.js',
  './menus.js', '../share/share-dialog.js']);
const SURFACE_MODULES = Object.freeze({
  chart: ['./surfaces/chart-surface.js', 'createChartSurface'],
  roadmap: ['./surfaces/roadmap-surface.js', 'createRoadmapSurface'],
  stems: ['./surfaces/stems-surface.js', 'createStemsSurface'],
});
const MENUS_PATH = './menus.js';
/** The menus a surface's 'context'/'long' activation can open on its target (spec §8 "Defined menus"). */
const TARGET_MENUS = new Set(['spot', 'marker', 'loopBand', 'stem']);
/** The surfaces that follow with prefs.roadmap.follow (spec §4.4B). */
const ROADMAP_KINDS = new Set(['roadmap', 'wave']);
const FOLLOW_STYLES = new Set(['scroll', 'page']);
/** The keys view.bigger/smaller are bound to ('=', '−', with their shifted and numpad forms). */
const SIZE_KEY = /^[=+\-_]$/;
const SHARE_PATH = '../share/share-dialog.js';

/** The surface crossfade (--motion-slow). */
export const SURFACE_FADE_MS = 260;
/** The resume chip's life in the status line (spec §4.12 step 5). */
export const RESUME_MS = 4000;
/** The glass pill's life (spec §4.9). */
export const PILL_MS = 3000;
const PLAYING = new Set(['playing', 'counting']);

// Per session (not per mount): the resume chip and the recording check show once per session,
// across Stage ↔ Edit remounts (spec §3.5, §4.12).
const resumed = new WeakSet();
const reviewed = new WeakSet();

const peek = (v) => (v && typeof v.peek === 'function' ? v.peek() : v?.value ?? v ?? null);
const isElement = (v) => !!v && typeof v === 'object' && v.nodeType === 1;
const safeIdent = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
const finite = (v) => Number.isFinite(v);
/** The next frame (the page's requestAnimationFrame, else a 16 ms timer). */
const nextFrame = (fn) => (typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame(fn) : setTimeout(fn, 16));

/**
 * The surface a song opens on when its practice does not name one (spec §4.4): Chart when a drum
 * part has notation, else Road map. Stems is only ever chosen explicitly. `hasNotation` null means
 * the part has not answered yet: the song's `hasChart` decides until it does.
 */
export function surfaceDefault(song, hasNotation) {
  const has = hasNotation === true || hasNotation === false ? hasNotation : !!song?.hasChart;
  return has ? 'chart' : 'roadmap';
}

// ---------------------------------------------------------------------------------------------------------------
// The Library → Stage View Transition (§2.14.10): the router hook and the cover ghost live in
// commands.js (loaded at boot, so the first open of a page load morphs too); mount runs the transition.

export {armStageEntry, ENTRY_WAIT_MS};

// The app's router exists when stage.js loads (main.js provides it): make sure it is armed.
try {
  const router = appRegistry.context().router;
  if (router?.onLeave) armStageEntry(router);
} catch { /* no registry context outside the app */ }

// ---------------------------------------------------------------------------------------------------------------
// Placeholders for surfaces of a later wave (D2)

function placeholderSurface(host, kind, {initial = 0} = {}) {
  const name = COPY.surfaces[kind] ?? kind;
  const el = h('div', {class: 'stage-surface-later', attrs: {'data-placeholder': kind}},
    h('p', {class: 'stage-surface-later-kicker'}, COPY.notBuilt),
    h('p', {class: 'stage-surface-later-body'}, COPY.surfaceLater(name)));
  host.append(el);
  let at = initial;
  return {
    el, kind,
    frame() {}, setLoop() {}, setGlass() {}, setFollow() {}, zoom() {},
    reveal(t) { if (finite(t)) at = t; },
    anchor: () => ({time: at}),
    destroy() { el.remove(); },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The view for a song that could not be opened (deleted, or the session failed)

function mountMissing(el, {error, router}) {
  const notFound = error?.code === 'not_found' || !error;
  const titleId = 'stage-missing-title';
  const root = h('div', {class: 'stage stage-missing', attrs: {'data-stage-layout': 'band', 'data-distance': 'stand'}},
    h('div', {class: 'stage-missing-card', attrs: {role: 'alert', 'aria-labelledby': titleId}},
      h('h1', {class: 'stage-missing-title', id: titleId}, notFound ? COPY.notFoundTitle : COPY.loadFailed),
      h('p', {class: 'stage-missing-body'}, notFound ? COPY.notFound : String(error?.message ?? '')),
      h('a', {class: 'stage-missing-link', href: '/'}, COPY.leave)));
  el.replaceChildren(root);
  // Back to Library goes back in history like the Stage's ‹ (the Library refocuses the card, idx − 1);
  // the href stays for a middle click or a new tab.
  const link = root.querySelector('.stage-missing-link');
  const onLink = (e) => {
    if (!router || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (router.back) void router.back({fallback: '/'});
    else router.navigate?.('/');
  };
  link.addEventListener('click', onLink);
  const offLink = () => link.removeEventListener('click', onLink);
  const html = el.ownerDocument.documentElement;
  html.dataset.loadPhase = 'error';
  return {
    update() {},
    unmount() {
      offLink();
      delete html.dataset.loadPhase;
      root.remove();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The view

const DEPS = Object.freeze({
  createWakeLock, watchInterruptions, startMediaSession, startGestureAudio,
  setlists: setlistsApi, later: LATER, prefs: appPrefs, Menu,
});

export async function mount(el, match, ctx = {}) {
  // A mount that throws part way (a peer's mount, the view transition, a surface) leaves nothing
  // behind: the router gets no handle to unmount, so the frame tears down what it set up, then rethrows.
  const guard = {teardown: null};
  try {
    return await mountStage(el, match, ctx, guard);
  } catch (err) {
    try { guard.teardown?.(); } catch (cleanupErr) { console.error('[stage] cleanup after a failed mount failed', cleanupErr); }
    throw err;
  }
}

async function mountStage(el, match, ctx, guard) {
  const deps = {...DEPS, ...(ctx.stageDeps ?? {})};
  const registry = ctx.registry ?? appRegistry;
  const store = ctx.store ?? appStore;
  const feedback = ctx.feedback ?? appFeedback;
  const platform = ctx.platform ?? appPlatform;
  const router = ctx.router ?? null;
  const prefs = deps.prefs;
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const html = doc.documentElement;
  if (router) armStageEntry(router, {platform, document: doc});

  const session = ctx.session;
  if (!session || ctx.sessionError) { dropEntryGhost(); return mountMissing(el, {error: ctx.sessionError ?? null, router}); }

  const transport = session.transport;
  const songId = session.id;
  const offs = [];
  let hud = null, strip = null, banner = null, controls = null, controlsKind = null;
  let current = null;       // the surface shown: {kind, requested, layer, instance}
  let requested = null;     // the surface asked for last (shown, or still loading)
  let surfaceSeq = 0;
  const cleanup = (fn) => { if (typeof fn === 'function') offs.push(fn); return fn; };
  let unmounted = false;
  let torndown = false;

  // ---------------- state ----------------
  const measure = () => ({vw: win?.innerWidth ?? 0, vh: win?.innerHeight ?? 0});
  const first = measure();
  const layout = signal(stageLayout(first));
  const narrow = signal(isNarrow(first));
  const distance = signal(distanceOf(prefs.get('practice.distance')));
  const focus = signal(!!prefs.get('practice.focus'));
  const surface = signal(null);                 // the kind shown: 'chart' | 'roadmap' | 'wave' | 'stems'
  const following = signal(true);
  const setlist = signal(null);
  const errored = signal(false);
  const resume = signal(null);
  const reveal = signal(false);
  const wake = deps.createWakeLock();
  const snapshot = () => transport.snapshot.peek();
  const playing = computed(() => PLAYING.has(transport.snapshot.value.phase));
  const display = computed(() => store.prefs.value?.chart?.display?.layout ?? null);
  // Per surface (spec §4.4B): the Road map and the Wave page scroll unless the user chose Page for them.
  const followStyle = computed(() => {
    const p = store.prefs.value;
    if (ROADMAP_KINDS.has(surface.value)) return FOLLOW_STYLES.has(p?.roadmap?.follow) ? p.roadmap.follow : 'scroll';
    const own = p?.practice?.follow?.[layout.value];
    return FOLLOW_STYLES.has(own) ? own : layout.value === 'rail' ? 'scroll' : 'page';
  });
  const loadLabelSig = computed(() => loadingLabel(session.load.value));
  const menuAvailable = signal(!!deps.later[MENUS_PATH]);
  const shareAvailable = signal(!!deps.later[SHARE_PATH]);

  // ---------------- DOM ----------------
  const hudHost = h('div', {class: 'stage-hud'});
  const banners = h('div', {class: 'stage-banners'});
  const surfaces = h('div', {class: 'stage-surfaces'});
  const notesHost = h('div', {class: 'stage-notes-host', attrs: {'data-notes-host': ''}});
  const errorPanel = h('div', {class: 'stage-error', hidden: true});
  const pillLayer = h('div', {class: 'stage-pill-layer'});
  const music = h('div', {class: 'stage-music', attrs: {role: 'region', 'aria-label': COPY.music}}, surfaces, errorPanel, notesHost, pillLayer);
  const stripHost = h('div', {class: 'stage-strip', attrs: {'data-stage-anchor': 'strip'}});
  const main = h('div', {class: 'stage-main'}, music, stripHost);
  const controlsHost = h('div', {class: 'stage-controls', attrs: {'data-stage-anchor': 'controls'}});
  const statusText = h('span', {class: 'stage-status-text'});
  const statusActions = h('span', {class: 'stage-status-actions'});
  const statusEl = h('div', {class: 'stage-status', attrs: {role: 'status', 'aria-live': 'polite', 'aria-label': COPY.status}}, statusText, statusActions);
  const revealZone = h('div', {class: 'stage-reveal', attrs: {'aria-hidden': 'true'}});
  // The recording banner and the status line float over the bottom of the music, so either coming or
  // going (the banner hides while playing) never moves or resizes the music (spec §3.5, §4.10).
  const floatEl = h('div', {class: 'stage-float'}, banners, statusEl);
  const root = h('div', {class: 'stage', dataset: {songId}}, hudHost, main, controlsHost, floatEl, revealZone);

  const anchors = new (class AnchorMap extends Map {
    get(name) {
      const own = super.get(name);
      if (isElement(own) && own.isConnected) return own;
      const marked = root.querySelector(`[data-stage-anchor="${name}"]`);
      if (marked) return marked;
      if (name === 'strip') return stripHost;   // Get bars opens left of the controls like every rail sheet (host.js)
      if (name === 'menu') return hudHost;
      return controlsHost;
    }
  })();

  // ---------------- the stage API ('stage' context) ----------------
  const api = {
    session,
    layout: readonly(layout), surface: readonly(surface), focus: readonly(focus), distance: readonly(distance),
    following: readonly(following), display, followStyle, setlist: readonly(setlist), wakeHeld: wake.held,
    load: session.load, loadLabel: loadLabelSig, menuAvailable: readonly(menuAvailable), shareAvailable: readonly(shareAvailable),
    statusLine: feedback.statusLine ?? null,
    anchors,
    plateHost: music,
    setSurface: (kind) => { void showSurface(kind, {explicit: true}); },
    cycleSurface,
    toggleFocus,
    setDistance,
    zoom,
    commitSize,
    resumeFollow,
    setDisplay: (value) => prefs.set('chart.display.layout', value ?? null),
    setFollowStyle: (style) => prefs.set(ROADMAP_KINDS.has(surface.peek()) ? 'roadmap.follow' : `practice.follow.${layout.peek()}`, style),
    openSheet: (name, {anchor} = {}) => hostOpenSheet(name, {session, anchor: isElement(anchor) ? anchor : anchors.get(name)}),
    closeSheets: hostCloseSheets,
    openMenu,
    share,
    startOver,
    leave,
    close: () => leave({source: 'menu'}),
    leaveHint: () => feedback.status?.(COPY.holdHint, {key: 'leave'}),
    goSetlist,
    scrollBy: (screens) => scrollMusic(screens),
    scrollTop: () => scrollMusic(null),
    /** The signal batch (commands.js imports no store): one spot open reaches the engine once. */
    batch,
  };
  guard.teardown = teardown;

  // ---------------- layout, Focus, Distance ----------------
  function attributes() {
    applyStageAttributes(root, {layout: layout.peek(), distance: distance.peek(), focus: focus.peek(), playing: playing.peek(), narrow: narrow.peek()});
    if (reveal.peek()) root.dataset.reveal = ''; else delete root.dataset.reveal;
    // Follow paused: the surface shows "⤓ Back to playhead" (56 px, bottom centre of the music), so the
    // floating status line and banner lift above it (status.css; ST10 handoff 4).
    if (following.peek()) delete root.dataset.followPaused; else root.dataset.followPaused = '';
  }
  cleanup(effect(() => {
    layout.value; distance.value; focus.value; playing.value; narrow.value; reveal.value; following.value;
    attributes();
  }));

  /** Runs a relayout with the playing bar kept at its screen fraction (spec §4.1, §4.11). */
  function keepingAnchor(fn) {
    const anchor = current?.instance?.anchor?.() ?? null;
    fn();
    if (anchor && finite(anchor.time)) {
      const instance = current?.instance;
      nextFrame(() => { if (current?.instance === instance) instance.reveal?.(anchor.time); });
    }
  }

  const controlsVariant = () => (layout.peek() === 'rail' ? (focus.peek() ? 'mini' : 'rail') : 'dock');
  function mountControlsFor() {
    const variant = controlsVariant();
    if (controls && controlsKind === variant) return;
    try { controls?.destroy?.(); } catch (err) { console.error('[stage] controls cleanup failed', err); }
    controlsHost.replaceChildren();
    controlsKind = variant;
    controlsHost.dataset.variant = variant;
    controls = mountControls(controlsHost, {session, variant, stage: api, registry});
  }

  function toggleFocus() {
    const next = !focus.peek();
    keepingAnchor(() => {
      batch(() => { focus.value = next; reveal.value = false; });
      prefs.set('practice.focus', next);
      hud?.setFocus?.(next);
      mountControlsFor();
    });
  }

  function setDistance(d) {
    const next = distanceOf(d);
    if (next === distance.peek()) return;
    keepingAnchor(() => {
      distance.value = next;
      prefs.set('practice.distance', next);
      current?.instance?.setDistance?.(next);
      releaseDistance();
    });
  }

  // ---------------- D54 release (Appendix C item 118) ----------------
  // A deferred chart size change (the last relayouts were slow) applies on release instead of after its
  // 400 ms settle: the menu that changed Distance closing, the =/− key's keyup, a held stepper let go.
  let menuHandle = null;          // the Stage menu open now (openMenu)
  let commitOnMenuClose = false;  // a Distance change made while it was open
  let keyRelease = null;          // {target, code, off}: the =/− key held now

  function commitSize() {
    try { current?.instance?.commitSize?.(); } catch (err) { console.error('[stage] commitSize failed', err); }
  }
  /** A Distance change is released at once, unless the menu it came from is still open (then on its close). */
  function releaseDistance() {
    if (menuHandle?.open) commitOnMenuClose = true;
    else commitSize();
  }
  function dropKeyRelease() { keyRelease?.off(); keyRelease = null; }
  cleanup(dropKeyRelease);

  /** =/− (view.bigger/smaller): a key step commits on that key's keyup; a held stepper ('repeat') calls commitSize itself. */
  function zoom(dir, {source, event} = {}) {
    current?.instance?.zoom?.(dir < 0 ? -1 : 1);
    if (source === 'repeat') return;
    // Only the =/− key itself is held: Enter in a menu or the palette is a release already.
    const held = source === 'key' && event?.type === 'keydown' && SIZE_KEY.test(event.key ?? '');
    const target = held ? event.target : null;
    const code = event?.code || event?.key;
    if (!target?.isConnected || typeof target.addEventListener !== 'function' || !code) { dropKeyRelease(); commitSize(); return; }
    if (keyRelease && keyRelease.target === target && keyRelease.code === code) return;   // auto-repeat of the held key
    dropKeyRelease();
    // The key's own target (not the window: dispatch.js owns the document listeners, §2.6) gets its keyup.
    const onUp = (e) => {
      if ((e.code || e.key) !== code) return;
      dropKeyRelease();
      commitSize();
    };
    target.addEventListener('keyup', onUp);
    keyRelease = {target, code, off: () => target.removeEventListener('keyup', onUp)};
  }

  // Settings → Practice (and another tab) change Distance and Focus too.
  cleanup(store.prefs.subscribe?.((p) => {
    const d = distanceOf(p?.practice?.distance);
    if (d !== distance.peek()) keepingAnchor(() => { distance.value = d; current?.instance?.setDistance?.(d); commitSize(); });
    const f = !!p?.practice?.focus;
    if (f !== focus.peek()) keepingAnchor(() => { focus.value = f; hud?.setFocus?.(f); mountControlsFor(); });
  }));

  const watcher = createLayoutWatcher({
    measure,
    onChange: (next) => keepingAnchor(() => {
      batch(() => { layout.value = next.layout; narrow.value = next.narrow; });
      hud?.setLayout?.(next.layout);
      mountControlsFor();
      current?.instance?.setLayout?.(next.layout);
    }),
  });
  const onResize = () => watcher.schedule();
  win?.addEventListener?.('resize', onResize);
  win?.addEventListener?.('orientationchange', onResize);
  cleanup(() => {
    watcher.destroy();
    win?.removeEventListener?.('resize', onResize);
    win?.removeEventListener?.('orientationchange', onResize);
  });

  // The band's Focus reveal zone: a tap shows the dock for 5 s (spec §4.10).
  let revealTimer = null;
  const showDock = () => {
    if (!focus.peek() || layout.peek() !== 'band') return;
    reveal.value = true;
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => { reveal.value = false; }, FRAME.revealMs);
  };
  revealZone.addEventListener('pointerdown', showDock);
  controlsHost.addEventListener('pointerdown', () => { if (reveal.peek()) showDock(); });
  cleanup(() => clearTimeout(revealTimer));

  // ---------------- surfaces ----------------
  let chosen = !!session.practice.value.peek().surface;   // the song (or the user, this mount) named a surface

  const cueTime = () => {
    const s = snapshot();
    return s.loop?.on ? s.loop.a : s.cue ?? 0;
  };
  const loopRange = () => {
    const l = snapshot().loop;
    return l?.on && l.b > l.a ? {a: l.a, b: l.b, aBar: l.aBar ?? undefined, bBar: l.bBar ?? undefined} : null;
  };

  function surfaceOpts(kind) {
    return {
      session, stage: api, layout: layout.peek(), distance: distance.peek(), kind,
      onActivate, onLoopEdit,
      onFollowChange: (on) => { following.value = !!on; registry.invalidate(); },
      status: (text, options) => feedback.status?.(text, options),
    };
  }

  async function createSurface(kind, layer, initial) {
    const [path, factory] = SURFACE_MODULES[kind];
    const load = deps.later[path];
    if (!load) return placeholderSurface(layer, kind === 'roadmap' && !session.map.isReal ? 'wave' : kind, {initial});
    try {
      const mod = await load();
      const instance = await mod[factory](layer, surfaceOpts(kind));
      if (!instance) throw new Error(`${factory} returned nothing`);
      return instance;
    } catch (err) {
      console.error(`[stage] the ${kind} surface could not open`, err);
      return placeholderSurface(layer, kind, {initial});
    }
  }

  /**
   * Shows a surface (chart | roadmap | stems). With a surface already up, the new one is revealed at
   * the old one's anchor and the two crossfade (--motion-slow; reduced motion: at once).
   */
  async function showSurface(kind, {explicit = false, initial = false} = {}) {
    if (!SURFACE_ORDER.includes(kind) || unmounted) return;
    if (explicit) {
      chosen = true;
      if (session.practice.value.peek().surface !== kind) session.practice.patch({surface: kind});
    }
    if (requested === kind) return;
    requested = kind;
    const seq = ++surfaceSeq;
    // Asking again for the surface on screen drops a switch that is still loading.
    if (current?.requested === kind) { registry.invalidate(); return; }
    const old = current;
    const anchor = old?.instance?.anchor?.() ?? null;
    const p = session.practice.value.peek();
    const startAt = anchor && finite(anchor.time) ? anchor.time
      : initial && finite(p.anchorTime) ? p.anchorTime : cueTime();
    const layer = h('div', {class: 'stage-surface', dataset: {surface: kind}});
    const fade = !!old && !peek(platform.reducedMotion);
    if (fade) layer.dataset.entering = '';
    surfaces.append(layer);
    const instance = await createSurface(kind, layer, startAt);
    if (seq !== surfaceSeq || unmounted) { try { instance.destroy?.(); } catch { /* superseded */ } layer.remove(); return; }
    const entry = {kind: instance.kind ?? kind, requested: kind, layer, instance};
    layer.dataset.surface = entry.kind;
    current = entry;
    surface.value = entry.kind;
    instance.setLoop?.(loopRange());
    instance.setGlass?.(playing.peek());
    instance.setFollow?.(true);
    following.value = true;
    instance.reveal?.(startAt, {smooth: false});
    if (old) {
      if (fade) {
        old.layer.dataset.leaving = '';
        nextFrame(() => { delete layer.dataset.entering; });
        setTimeout(() => retire(old), SURFACE_FADE_MS);
      } else {
        retire(old);
      }
    }
    registry.invalidate();
  }

  /**
   * The Road map turns into the Wave page (and back) when the song's map changes under it: its `kind`
   * is a live getter (also el[data-kind]), so the shown kind is read again (ST10 handoff 2).
   */
  function syncKind() {
    const entry = current;
    if (!entry || unmounted) return;
    const kind = entry.instance.kind ?? entry.instance.el?.dataset?.kind ?? null;
    if (!kind || kind === entry.kind) return;
    entry.kind = kind;
    entry.layer.dataset.surface = kind;
    surface.value = kind;
    registry.invalidate();
  }
  // The surface hears the change in its own subscription, which may run after this one: read again after it.
  if (session.position?.mapped?.subscribe) {
    cleanup(session.position.mapped.subscribe(() => { syncKind(); queueMicrotask(syncKind); }));
  }

  function retire(entry) {
    try { entry.instance.destroy?.(); } catch (err) { console.error('[stage] surface cleanup failed', err); }
    entry.layer.remove();
  }

  function cycleSurface() {
    const at = SURFACE_ORDER.indexOf(requested ?? 'roadmap');
    void showSurface(SURFACE_ORDER[(at + 1) % SURFACE_ORDER.length], {explicit: true});
  }

  function resumeFollow() {
    current?.instance?.setFollow?.(true);
    following.value = true;
    registry.invalidate();
  }

  function scrollMusic(screens) {
    const layer = current?.layer;
    if (!layer) return;
    const scroller = layer.querySelector('[data-scroller]') ?? layer;
    const behavior = peek(platform.reducedMotion) ? 'auto' : 'smooth';
    if (screens == null) scroller.scrollTo?.({top: 0, behavior});
    else scroller.scrollBy?.({top: screens * Math.max(1, scroller.clientHeight * 0.85), behavior});
  }

  // ---------------- glass and the pill (spec §4.9) ----------------
  let pill = null;
  function clearPill() {
    if (!pill) return;
    clearTimeout(pill.timer);
    pill.el.remove();
    pill = null;
  }
  cleanup(clearPill);

  function pillLabel(e) {
    const bar = finite(e.bar) ? e.bar : null;
    if (session.map.isReal && bar !== null) return COPY.playFromBar(bar);
    return COPY.playFromTime(e.t);
  }

  function showPill(e) {
    clearPill();
    const rect = music.getBoundingClientRect();
    const label = pillLabel(e);
    const el = h('button', {type: 'button', class: 'stage-pill', dataset: {glassPill: ''}},
      h('span', {class: 'stage-pill-icon', 'aria-hidden': 'true'}, '▶'), ` ${label}`);
    el.style.left = `${Math.round((e.clientX ?? rect.left + rect.width / 2) - rect.left)}px`;
    el.style.top = `${Math.round((e.clientY ?? rect.top + rect.height / 2) - rect.top)}px`;
    el.addEventListener('click', () => {
      clearPill();
      transport.jump(e.t, {label});
    });
    pillLayer.append(el);
    pill = {el, timer: setTimeout(clearPill, PILL_MS)};
  }

  function onActivate(e) {
    if (!e || !finite(e.t) || errored.peek()) return;
    const action = pressPolicy({pointerType: e.pointerType || 'touch', playing: playing.peek(), gesture: e.kind});
    switch (action) {
      case 'cue': transport.cue(e.beatTime ?? e.t, {snap: session.map.isReal && !finite(e.beatTime) ? 'beat' : 'none'}); break;
      case 'seek': transport.seek(e.t); break;
      case 'pill': showPill(e); break;
      case 'playFrom': void transport.playFrom(e.t); break;
      case 'jump': transport.jump(e.t, {label: pillLabel(e)}); break;
      case 'menu': {
        // A surface names what was pressed (a spot, a marker, the loop band, a stem); else the bar menu.
        const target = e.target && typeof e.target === 'object' && TARGET_MENUS.has(e.target.kind) ? e.target : null;
        void openMenu(target ? target.kind : 'bar', {...(target ?? {}), t: e.t, bar: e.bar, anchor: {x: e.clientX ?? 0, y: e.clientY ?? 0}});
        break;
      }
      default: break;
    }
  }

  function onLoopEdit(e) {
    if (!e || e.phase !== 'commit' || !finite(e.a) || !finite(e.b) || e.b <= e.a) return;
    transport.loopRange(e.a, e.b, {snap: 'none'});
  }

  // ---------------- menus, share ----------------
  /** ST8a's builders, by kind (spec §8 "Defined menus"); [] when the kind's target is missing. */
  function menuItems(menus, kind, o) {
    const opts = {registry, feedback};
    if (typeof o.rename === 'function') opts.rename = o.rename;
    switch (kind) {
      case 'stage': return menus.stageMenu(session, api, opts);
      case 'section': return o.region ? menus.sectionMenu(session, o.region, {...opts, ...(finite(o.t) ? {t: o.t} : {})}) : [];
      case 'spot': return o.spot ? menus.spotMenu(session, o.spot, {...opts, ...(typeof o.onOpen === 'function' ? {onOpen: o.onOpen} : {})}) : [];
      case 'marker': return o.marker ? menus.markerMenu(session, o.marker, opts) : [];
      case 'loopBand': return menus.loopBandMenu(session, {...opts, ...(typeof o.zoomToLoop === 'function' ? {zoomToLoop: o.zoomToLoop} : {})});
      case 'stem': {
        const name = o.stemName ?? (typeof o.stem === 'string' ? o.stem : o.stem?.name);
        return name ? menus.stemMenu(session, name, opts) : [];
      }
      default: return menus.barMenu(session, {t: o.t, bar: o.bar}, opts);
    }
  }

  // ST8a's menus.js, loaded once: the menus and boundUndo (the status line's Undo).
  let menusModule = null, menusPromise = null;
  function loadMenus() {
    const load = deps.later[MENUS_PATH];
    if (!load) return Promise.resolve(null);
    menusPromise ??= Promise.resolve().then(load).then((mod) => { menusModule = mod; return mod; }, (err) => { menusPromise = null; throw err; });
    return menusPromise;
  }

  async function openMenu(kind, options = {}) {
    const o = options ?? {};
    if (!deps.later[MENUS_PATH]) return null;
    try {
      const menus = await loadMenus();
      const items = menuItems(menus, kind, o);
      if (!items?.length || unmounted) return null;
      let handle = null;
      handle = deps.Menu.open(items, {
        anchor: o.anchor ?? anchors.get('menu'), label: COPY.menuLabels?.[kind] ?? COPY.commands.menu, registry,
        onClose: () => {
          if (menuHandle === handle) menuHandle = null;
          // D54: the menu that changed Distance closed.
          if (commitOnMenuClose && !menuHandle?.open) { commitOnMenuClose = false; commitSize(); }
        },
      });
      menuHandle = handle ?? null;
      return handle;
    } catch (err) {
      console.error(`[stage] the ${kind} menu could not open`, err);
      return null;
    }
  }

  async function share() {
    const load = deps.later[SHARE_PATH];
    if (!load || session.readOnly) return;
    try {
      await session.flush({final: true});
      const mod = await load();
      mod.openShareDialog({session, song: session.song.peek()});
    } catch (err) {
      console.error('[stage] the share dialog could not open', err);
    }
  }

  // ---------------- transport-side actions ----------------
  function startOver() {
    resume.value = null;
    const changed = transport.startOver();
    current?.instance?.reveal?.(0);
    if (changed) {
      // The Undo undoes Start over only while its step is still the latest (spec §7.8); else "can't undo".
      const step = undoFor();
      feedback.status?.(COPY.startedOver, {key: 'start-over', action: {label: COPY.undo, run: () => step.run({source: 'pointer'})}});
    }
    return changed;
  }

  /** An Undo bound to the step just pushed: ST8a's boundUndo (loaded now if menus.js has not been yet). */
  function undoFor() {
    const opts = {registry, feedback};
    let bound = menusModule?.boundUndo ? menusModule.boundUndo(session, null, opts) : null;
    // Before menus.js loads: bound a microtask later, and until then only while the stack has not grown.
    const size = session.undo?.size?.undo;
    if (!bound) {
      loadMenus().then((mod) => { if (!bound && mod?.boundUndo && session.undo?.size?.undo === size) bound = mod.boundUndo(session, null, opts); }, () => {});
    }
    return {
      run({source = 'pointer'} = {}) {
        if (bound) return bound.run({source});
        if (session.disposed || session.undo?.size?.undo !== size) return false;
        return registry.run('practice.undo', {source});
      },
    };
  }

  function saveAnchor() {
    const a = current?.instance?.anchor?.();
    if (!a || !finite(a.time) || session.disposed) return;
    const p = session.practice.value.peek();
    const bar = finite(a.bar) ? a.bar : undefined;
    if (p.anchorTime === a.time && p.anchorBar === bar) return;
    session.practice.patch((draft) => {
      draft.anchorTime = a.time;
      if (bar === undefined) delete draft.anchorBar; else draft.anchorBar = bar;
    });
  }

  let leaving = false;
  function leave({source} = {}) {
    if (leaving || unmounted) return;
    leaving = true;
    const phase = snapshot().phase;
    if (phase === 'playing' || phase === 'counting' || phase === 'paused') transport.stop();
    saveAnchor();
    if (router?.back) void router.back({fallback: '/'});
    else router?.navigate?.('/');
    void source;
    // A navigation that did not happen (no history, a refused route) must not block the next leave.
    const timer = setTimeout(() => { leaving = false; }, 1500);
    cleanup(() => clearTimeout(timer));
  }

  function goSetlist(dir) {
    const set = setlist.peek();
    const target = set?.[dir > 0 ? 'next' : 'prev'];
    if (!set || !target) return false;
    router?.navigate?.(`/s/${encodeURIComponent(target.id)}?set=${encodeURIComponent(set.id)}`, {replace: true});
    return true;
  }

  // ---------------- the setlist context (?set=, B3) ----------------
  let setOff = null, setRow = null, setId = null;
  function setlistFrom(row) {
    if (!row || !Array.isArray(row.songIds)) return null;
    const i = row.songIds.indexOf(songId);
    if (i < 0) return null;
    const songs = store.library?.songs?.peek?.() ?? new Map();
    const item = (id) => (id ? {id, title: songs.get?.(id)?.title ?? ''} : null);
    return {id: row.id ?? setId, name: row.name ?? '', index: i, count: row.songIds.length,
      prev: item(row.songIds[i - 1]), next: item(row.songIds[i + 1])};
  }
  function watchSetlist(id) {
    if (id === setId) return;
    setOff?.();
    setOff = null;
    setRow = null;
    setId = id || null;
    setlist.value = null;
    if (!setId) return;
    setOff = deps.setlists.subscribeGet({id: setId}, (row) => {
      setRow = row ?? null;
      setlist.value = setlistFrom(setRow);
      registry.invalidate();
    }, (err) => console.warn('[stage] the setlist could not load', err));
  }
  cleanup(() => setOff?.());
  if (store.library?.songs?.subscribe) cleanup(store.library.songs.subscribe(() => { if (setRow) setlist.value = setlistFrom(setRow); }));

  // ---------------- query (?spot, ?bar, ?t, ?set) ----------------
  let lastQuery = {};
  function applyQuery(query = {}) {
    const q = query ?? {};
    const changed = (k) => q[k] !== undefined && q[k] !== lastQuery[k];
    if (changed('spot')) {
      openSpot({session, feedback, stage: api}, String(q.spot));
      router?.setQuery?.({spot: null});
    } else if (changed('bar') && session.map.isReal) {
      const n = Number(q.bar);
      const bar = session.map.bars.find((b) => b.display === n);
      if (bar) transport.cue(bar.t0);
    } else if (changed('t')) {
      const t = Number(q.t);
      if (finite(t) && t >= 0) transport.cue(t);
    }
    watchSetlist(q.set ?? null);
    lastQuery = {...q};
  }

  // ---------------- the status line ----------------
  const detect = session.detect;
  let statusButtons = [];
  const dropButtons = (list) => { for (const b of list) { try { b.destroy?.(); } catch { /* already gone */ } } };
  cleanup(() => { dropButtons(statusButtons); statusButtons = []; });
  function renderStatus() {
    const entry = peek(feedback.statusLine);
    const chip = resume.peek();
    dropButtons(statusButtons);
    statusButtons = [];
    statusActions.replaceChildren();
    const button = (label, run, variant = 'quiet') => {
      const b = Button({label, variant, size: 'sm', onClick: run, className: 'stage-status-action'});
      statusButtons.push(b);
      return b.el;
    };
    if (entry) {
      statusText.textContent = entry.text ?? '';
      statusEl.dataset.tone = entry.tone ?? 'info';
      if (entry.action?.label) {
        statusActions.append(button(entry.action.label, () => {
          // Clear the clicked line only: an action that posts its own line ("Undid: …") keeps it.
          try { entry.action.run?.(); } finally {
            if (peek(feedback.statusLine)?.id === entry.id) feedback.dismissStatus?.(entry.key ?? undefined);
          }
        }));
      }
      if (entry.key === 'detect-offer' && peek(detect?.offer)) {
        statusActions.append(button(COPY.notNow, () => { detect.dismissOffer?.(); feedback.dismissStatus?.('detect-offer'); }));
      }
      delete statusEl.dataset.empty;
      return;
    }
    if (chip) {
      statusEl.dataset.tone = 'info';
      statusText.replaceChildren(`${chip.lead} `, h('strong', {class: 'stage-status-strong'}, chip.strong), chip.rest ? ` · ${chip.rest}` : '');
      statusActions.append(button(COPY.startOver, () => registry.run('stage.startOver', {source: 'pointer'}) || startOver()));
      delete statusEl.dataset.empty;
      return;
    }
    statusText.textContent = '';
    statusEl.dataset.empty = '';
  }
  cleanup(feedback.attachStatusLine?.());
  if (feedback.statusLine?.subscribe) {
    cleanup(feedback.statusLine.subscribe((entry) => {
      if (entry) resume.value = null;   // one transient line: any status replaces the resume chip
      renderStatus();
    }));
  }
  cleanup(resume.subscribe(() => renderStatus()));

  // ---------------- the resume chip (spec §4.12 step 5) ----------------
  function resumeChip() {
    const p = session.practice.value.peek();
    const s = snapshot();
    const cue = s.cue ?? 0;
    const notDefault = s.loop?.on || Math.abs((s.rate ?? 1) - 1) > 1e-6 || s.mix?.minusMe || s.mix?.onlyMe || cue > 0.05;
    if (!notDefault || !p) return null;
    let where;
    if (s.loop?.on && s.loop.label) where = `${s.loop.label} loop`;
    else if (session.map.isReal && session.map.hasSections) where = session.map.sectionAt(cue)?.name ?? formatClock(cue);
    else where = formatClock(cue);
    const muted = (s.mix?.tracks ?? []).filter((t) => t.muted).map((t) => t.name);
    return resumeText({where, rate: s.rate ?? 1, mix: mixWord({minusMe: s.mix?.minusMe, onlyMe: s.mix?.onlyMe, mine: s.mix?.mine ?? [], muted})});
  }

  // ---------------- load and errors (spec §4.12) ----------------
  const errorId = `stage-error-${safeIdent(songId)}`;
  let errorButtons = [];   // Button handles: a command Button holds a registry listener until destroyed
  cleanup(() => { dropButtons(errorButtons); errorButtons = []; });
  function renderError(load) {
    dropButtons(errorButtons);
    errorButtons = [];
    const make = (props) => { const b = Button(props); errorButtons.push(b); return b.el; };
    const error = load?.error ?? {};
    const kind = error.kind ?? 'unknown';
    const lines = [];
    if (kind === 'codec') lines.push(COPY.codec);
    else if (kind === 'storage') lines.push(COPY.storageFailed);
    else lines.push(COPY.loadFailed);
    if (kind === 'missing' && error.missing?.length) lines.push(COPY.missing(error.missing));
    const actions = [];
    if (kind !== 'codec') actions.push(make({label: COPY.tryAgain, variant: 'primary', onClick: () => { void session.retry(); }}));
    if (kind === 'missing' && !session.readOnly) {
      actions.push(make({command: 'song.resplit', registry, label: COPY.resplit, variant: 'secondary'}));
    }
    const details = error.message ? h('details', {class: 'stage-error-details'},
      h('summary', {}, COPY.details),
      h('pre', {class: 'stage-error-raw selectable'}, String(error.message)),
      make({label: COPY.copyDetails, variant: 'quiet', size: 'sm', onClick: (e) => {
        const btn = e?.currentTarget;
        Promise.resolve(win?.navigator?.clipboard?.writeText?.(String(error.message))).then(() => { if (btn) btn.dataset.copied = ''; }, () => {});
      }})) : null;
    errorPanel.replaceChildren(h('div', {class: 'stage-error-card', id: errorId, attrs: {role: 'alert'}},
      ...lines.map((text, i) => h('p', {class: i ? 'stage-error-sub' : 'stage-error-title'}, text)),
      h('div', {class: 'stage-error-actions'}, ...actions),
      details));
  }

  let lastPhase = null;
  cleanup(effect(() => {
    const load = session.load.value;
    html.dataset.loadPhase = load.phase;
    const isError = load.phase === 'error';
    if (isError) renderError(load);
    else if (errorButtons.length) { dropButtons(errorButtons); errorButtons = []; errorPanel.replaceChildren(); }
    errorPanel.hidden = !isError;
    surfaces.hidden = isError;
    if (isError) {
      controlsHost.setAttribute('aria-disabled', 'true');
      controlsHost.setAttribute('aria-describedby', errorId);
      controlsHost.dataset.disabled = '';
    } else {
      controlsHost.removeAttribute('aria-disabled');
      controlsHost.removeAttribute('aria-describedby');
      delete controlsHost.dataset.disabled;
    }
    if (isError !== errored.peek()) { errored.value = isError; registry.invalidate(); }
    if (load.phase !== lastPhase) { lastPhase = load.phase; registry.invalidate(); }
  }));
  // Pointer activations on the disabled controls do nothing while the audio failed (the keys are off through `when`).
  controlsHost.addEventListener('click', (e) => { if (errored.peek()) { e.preventDefault(); e.stopPropagation(); } }, true);

  // ---------------- transport phase: attributes, store.stage, wake lock, URL, glass ----------------
  let lastTransport = transport.snapshot.peek().phase;
  cleanup(effect(() => {
    const snap = transport.snapshot.value;
    const phase = snap.phase;
    html.dataset.transportPhase = phase;
    const isPlaying = PLAYING.has(phase);
    current?.instance?.setGlass?.(isPlaying);
    current?.instance?.setLoop?.(loopRange());
    if (isPlaying) { resume.value = null; clearPill(); }
    wake.update({stageOpen: true, playing: isPlaying});
    if (phase === 'stopped' && (lastTransport === 'playing' || lastTransport === 'counting' || lastTransport === 'paused')) {
      writePosition(snap.cue);
      saveAnchor();
    }
    lastTransport = phase;
    registry.invalidate();
  }));

  /** ?bar=N (mapped, a numbered bar) or ?t=s (unmapped or the pickup), with replace, on Stop only. */
  function writePosition(cue) {
    if (!router?.setQuery || !finite(cue)) return;
    const map = session.map;
    let bar = null;
    if (map.isReal) bar = map.bars[map.barIndexAt(cue)]?.display ?? null;
    const patch = bar !== null ? {bar, t: null} : {t: Math.round(cue * 10) / 10, bar: null};
    lastQuery = {...lastQuery, bar: patch.bar == null ? undefined : String(patch.bar), t: patch.t == null ? undefined : String(patch.t)};
    router.setQuery(patch);
  }

  cleanup(effect(() => {
    const value = {songId, layout: layout.value, surface: surface.value, playing: playing.value, focus: focus.value};
    store.stage.value = value;
  }));
  cleanup(() => { if (store.stage.peek()?.songId === songId) store.stage.value = null; });

  // Registry state follows the song, the map, undo, detection and the notation part.
  const watched = [session.song, session.position?.revision, session.undo?.canUndo, session.undo?.canRedo,
    detect?.suggestion, detect?.canDetect, detect?.offer, session.notation?.hasNotation, surface, following, setlist].filter((s) => s?.subscribe);
  for (const s of watched) cleanup(s.subscribe(() => registry.invalidate()));

  // ---------------- providers ----------------
  cleanup(registry.provide('stage', () => (unmounted ? undefined : api)));
  cleanup(registry.provide('session', () => (unmounted || errored.peek() ? null : session)));
  cleanup(registry.provide('transport', () => (unmounted || errored.peek() ? null : transport)));

  // ---------------- per-session platform services ----------------
  cleanup(() => wake.destroy?.() ?? wake.release?.());
  cleanup(deps.watchInterruptions({engine: session.engine, transport, platform}));
  cleanup(deps.startMediaSession({transport, session}));
  cleanup(deps.startGestureAudio({transport, engine: session.engine}));
  // First-Stage coach marks (spec §6.6.5): owner sessions only; never while playing; loaded lazily.
  if (!session.readOnly) {
    let stopCoach = null;
    import('./coach.js')
      .then((m) => { if (!unmounted) stopCoach = m.startStageCoach({stage: api, session, registry}); })
      .catch((err) => console.warn('coach marks:', err));
    cleanup(() => { try { stopCoach?.(); } catch {} });
  }
  session.frame?.start?.();
  cleanup(session.frame?.subscribe?.((f) => current?.instance?.frame?.(f)));
  cleanup(() => session.frame?.stop?.());

  // The New dot: this device has opened the song (prefs.library.opened, FIFO ≤ 500).
  prefs.update((d) => {
    const list = Array.isArray(d.library?.opened) ? d.library.opened.filter((id) => id !== songId) : [];
    list.push(songId);
    d.library = {...(d.library ?? {}), opened: list.slice(-500)};
  });

  // ---------------- build ----------------
  const stripViewport = signal(null);
  function build() {
    el.replaceChildren(root);
    attributes();
    hud = mountHud(hudHost, {session, stage: api, registry});
    hud?.setLayout?.(layout.peek());
    hud?.setFocus?.(focus.peek());
    mountControlsFor();
    strip = mountStrip(stripHost, {
      session, registry,
      onScrub: (t) => { if (finite(t)) current?.instance?.reveal?.(t); },
      viewport: readonly(stripViewport),
      onViewport: (v) => { const vp = current?.instance?.viewport; if (vp && 'value' in vp) vp.value = v; },
    });
    if (!reviewed.has(session) && shouldReview(session)) {
      reviewed.add(session);   // once per session: shown is enough, answered or not (ST4 row)
      banner = mountReviewBanner(banners, {session, router, feedback});
    }
    renderStatus();
  }

  // The identity cover carries the entry transition's name (the HUD marks it data-stage-cover).
  const coverEl = () => hudHost.querySelector('[data-stage-cover]') ?? hudHost.querySelector('[class*="cover"]');
  const entry = entryGhost(songId) && canEntryTransition(doc, platform) ? entryGhost(songId) : null;
  if (entry) {
    const named = `cover-${safeIdent(songId)}`;
    let transition = null;
    let namedHere = null;   // the HUD names its own cover (ST5); otherwise the frame names it for the transition
    try {
      transition = doc.startViewTransition(() => {
        dropEntryGhost();
        build();
        const cover = coverEl();
        if (cover && !cover.style.getPropertyValue('view-transition-name')) {
          cover.style.setProperty('view-transition-name', named);
          namedHere = cover;
        }
      });
    } catch (err) {
      console.warn('[stage] the entry transition could not start', err);
    }
    if (transition) {
      await transition.updateCallbackDone;
      Promise.resolve(transition.finished).catch(() => {}).then(() => { namedHere?.style.removeProperty('view-transition-name'); });
    } else {
      dropEntryGhost();
      build();
    }
  } else {
    dropEntryGhost();
    build();
  }

  // Stems' viewport → the strip's bracket.
  cleanup(effect(() => {
    surface.value;
    const vp = current?.instance?.viewport;
    stripViewport.value = vp && typeof vp.peek === 'function' ? vp.value : null;
  }));

  // ---------------- open: surface, resume, query ----------------
  const initialKind = session.practice.value.peek().surface ?? surfaceDefault(session.song.peek(), peek(session.notation?.hasNotation));
  await showSurface(SURFACE_ORDER.includes(initialKind) ? initialKind : 'roadmap', {initial: true});
  // The default is switched once when the drum part answers (a song whose part has no notation).
  Promise.resolve(session.notation?.ready).then(() => {
    if (unmounted || chosen || session.practice.value.peek().surface) return;
    const want = surfaceDefault(session.song.peek(), peek(session.notation?.hasNotation));
    if (want !== requested) void showSurface(want);
  }, () => {});

  if (!resumed.has(session)) {
    resumed.add(session);
    const chip = resumeChip();
    if (chip && !peek(feedback.statusLine)) {
      resume.value = chip;
      const timer = setTimeout(() => { resume.value = null; }, RESUME_MS);
      cleanup(() => clearTimeout(timer));
    }
  }
  applyQuery(match?.query ?? {});
  registry.invalidate();
  // The menus (and the status line's bound Undo) are ready before the first right-click or Start over.
  void loadMenus().catch((err) => console.warn('[stage] the menus could not load', err));

  return {
    update(next) { if (!unmounted) applyQuery(next?.query ?? {}); },
    unmount() {
      if (unmounted) return;
      saveAnchor();
      clearPill();
      teardown();
      if (!session.disposed) void session.flush({final: true});
    },
  };

  /** Everything mount set up, in reverse: unmount, and a mount that threw part way. */
  function teardown() {
    if (torndown) return;
    torndown = true;
    unmounted = true;
    surfaceSeq++;
    try { hostCloseSheets(); } catch (err) { console.error('[stage] sheet cleanup failed', err); }
    for (const off of offs.splice(0).reverse()) { try { off(); } catch (err) { console.error('[stage] cleanup failed', err); } }
    try { banner?.destroy(); } catch (err) { console.error('[stage] banner cleanup failed', err); }
    try { strip?.destroy?.(); } catch (err) { console.error('[stage] strip cleanup failed', err); }
    try { controls?.destroy?.(); } catch (err) { console.error('[stage] controls cleanup failed', err); }
    try { hud?.destroy?.(); } catch (err) { console.error('[stage] HUD cleanup failed', err); }
    banner = strip = controls = hud = null;
    if (current) retire(current);
    for (const layer of [...surfaces.children]) layer.remove();
    current = null;
    delete html.dataset.loadPhase;
    delete html.dataset.transportPhase;
    registry.invalidate();
    root.remove();
  }
}
