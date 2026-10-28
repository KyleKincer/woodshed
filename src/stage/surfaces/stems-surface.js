// The Stems surface (architecture §2.14.12, §3.3; spec §4.4D): today's Tracks view, rebuilt on
// pointer events. One waveform row per stem under a 40 px view toolbar and a ruler.
//
//   createStemsSurface(host, opts) → Surface & {viewport}
//     opts (SurfaceOpts, §2.14.12): {session, stage, layout, distance, onActivate, onLoopEdit,
//       onFollowChange, status} plus, for tests and harnesses, {registry, prefs, platform,
//       setSurfaceScope, now, raf, caf}
//     Surface: {el, kind: 'stems', frame(f), setLoop(range), setGlass(playing), setFollow(on),
//       reveal(t), anchor(), zoom(dir), setLayout(l), setDistance(d), destroy()}
//     viewport   Signal<{t0, t1}|null>: the visible window. The strip draws its bracket from it and
//                writes it back when the bracket is dragged (the surface then shows that window).
//
// Toolbar: [− + Fit] [Zoom to loop Z] [Grid: Bar ▾] [Snap] [Follow]. Grid ▾ chooses Off · Bar ·
// Beat · ½ · ¼ (mapped songs only: an unmapped song has no grid, so the control is not shown);
// Snap (⇧S) snaps cues and loop edges to the grid division (bars when the grid is off; 0.1 s
// unmapped); Follow (F) keeps the playhead in view while playing.
// Ruler: bar numbers when mapped, times when not (never "Bar" for an unmapped song, §2.14.4).
// Rows (canonical stem order, so row N is key N): a header of 168 px (laptop) or 128 px (iPad,
// or any coarse pointer) with the colour bar, the name (16/700), the key-cap, the OUT / SOLO word,
// [M] [S] (32 px fine, 44 coarse) and, on a laptop, a 120 px fader with its % value (on the iPad
// the fader lives in the Mix sheet). The waveforms are one canvas (wave-render.js drawRows):
// muted rows as an outline with a 45° hatch (never opacity), soloed rows full, the others as
// outlines while anything is soloed. Grid lines (drawGrid): beats at 8% --ink, bars at 18%, each
// kind only when its lines are ≥ 6 px apart.
//
// One pointer model (press.js, glass.js; touch-action none):
//   mouse   click seeks (immediately, even while playing; the Stage applies glass.pressPolicy);
//           a drag past 8 px makes a loop; the loop's edges resize it and a drag inside moves it
//           (loop-handles.js); right-click opens the bar menu
//   touch   stopped: tap cues; a 350 ms long-press then drag makes a loop; releasing a long press
//           opens the bar menu; two fingers pan, a pinch zooms (pinch.js). Playing: tap shows the
//           pill, no loop drags (glass).
//   wheel   as 1.9 (timeline-navigation.js wheelNavigation): vertical zooms at the cursor,
//           horizontal or Shift pans, ⌘/Ctrl or a trackpad pinch zooms.
// Manual navigation while playing (wheel, two-finger pan, pinch, the strip's viewport bracket)
// pauses Follow and the Stage shows "⤓ Back to playhead" (onFollowChange(false)); the next Play,
// Back to playhead (setFollow(true)) or F resumes it.
//
// Device prefs (prefs.stems): grid, snap, follow and zoom (the visible seconds, null = Fit),
// restored when the surface opens. While the surface is shown the dispatcher's surface scope is
// 'stage.stems' (D24) and the §3.3 commands are registered (defineStemsCommands; they act on the
// surface on screen).
import '../../styles/views/stage/surface-stems.css';
import {registry as appRegistry} from '../../app/commands.js';
import {setSurfaceScope as appSetSurfaceScope} from '../../app/dispatch.js';
import {prefs as appPrefs} from '../../app/prefs.js';
import {haptic as platformHaptic, platform as appPlatform} from '../../app/platform.js';
import {now as clockNow} from '../../app/clock.js';
import {effect, signal, untracked} from '../../app/store.js';
import {h} from '../../ui/h.js';
import {Button, IconButton} from '../../ui/button.js';
import {Toggle} from '../../ui/toggle.js';
import {Fader} from '../../ui/fader.js';
import {Kbd} from '../../ui/kbd.js';
import {Menu} from '../../ui/menu.js';
import {stemColor} from '../../ui/stem-pad.js';
import {wheelNavigation} from '../../js/timeline-navigation.js';
import {formatClock} from '../../../shared/practice.ts';
import {pressPolicy} from '../glass.js';
import {createPressRecognizer} from '../press.js';
import {createPinch} from '../pinch.js';
import {mountLoopHandles} from '../loop-handles.js';
import {gridTicks, snapTime} from '../grid.js';
import {drawGrid, drawRows, STEM_KEYS} from '../wave-render.js';
import {stemLabel} from '../transport-commands.js';

/** The dispatcher scope while the surface is shown (D24). */
export const SCOPE = 'stage.stems';
/** The smallest visible window, in seconds (as 1.9). */
export const MIN_SPAN = 0.25;
/** − / + / = / - zoom by this factor. */
export const ZOOM_STEP = 2;
/** The wheel's zoom rate per pixel of delta (as 1.9). */
export const WHEEL_ZOOM_RATE = 0.0015;
/** Follow re-anchors the playhead here (fraction of the width) when it leaves the window… */
export const FOLLOW_LINE = 0.1;
/** …which it does past this fraction. */
export const FOLLOW_EDGE = 0.9;
/** Zoom to loop leaves this fraction of the loop as margin on each side. */
export const LOOP_MARGIN = 0.05;
/** Grid lines of a kind are drawn only when at least this far apart (spec §4.4D). */
export const GRID_MIN_PX = 6;
/** Row minimum height (spec §4.4D). */
export const ROW_MIN_PX = 72;
/** Header widths (spec §4.4D). */
export const HEADER_PX = Object.freeze({laptop: 168, ipad: 128});
/** Ruler labels keep at least this much room. */
export const RULER_MIN_PX = Object.freeze({bar: 40, time: 64});
/** The zoom pref is written this long after the last zoom (wheel and pinch fire many). */
export const ZOOM_SAVE_MS = 300;
/** Grid divisions in toolbar order. */
export const GRID_CHOICES = Object.freeze(['off', 'bar', 'beat', 'half', 'quarter']);
const TIME_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const BAR_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
const MIN_LOOP = 0.02;
const EPS = 1e-6;

/** Every string the surface shows or announces (spec §4.4D, §3.3). */
export const COPY = Object.freeze({
  region: 'Stems',
  toolbar: 'Stems view',
  rows: 'Stem rows',
  zoomOut: 'Zoom out',
  zoomIn: 'Zoom in',
  fit: 'Fit',
  zoomLoop: 'Zoom to loop',
  gridToggle: 'Grid on/off',
  grid: 'Grid',
  gridButton: (division) => `Grid: ${division}`,
  divisions: Object.freeze({off: 'Off', bar: 'Bar', beat: 'Beat', half: '½', quarter: '¼'}),
  snap: 'Snap',
  follow: 'Follow',
  mute: (name) => `Mute ${name}`,
  solo: (name) => `Solo ${name}`,
  level: (name) => `${name} level`,
  muteShort: 'M',
  soloShort: 'S',
  out: 'OUT',
  soloWord: 'SOLO',
  backToPlayhead: 'Back to playhead',
});

/** The §3.3 command ids. */
export const COMMAND_IDS = Object.freeze({
  zoomIn: 'stems.zoomIn', zoomOut: 'stems.zoomOut', fit: 'stems.fit', zoomLoop: 'stems.zoomLoop',
  grid: 'stems.grid', snap: 'stems.snap', follow: 'stems.follow',
});

/** The surface's controls, for the table-driven test: role, accessible name, command, when it shows. */
export const CONTROLS = Object.freeze([
  Object.freeze({role: 'region', name: COPY.region, context: 'always'}),
  Object.freeze({role: 'group', name: COPY.toolbar, context: 'always'}),
  Object.freeze({role: 'button', name: COPY.zoomOut, command: COMMAND_IDS.zoomOut, context: 'always'}),
  Object.freeze({role: 'button', name: COPY.zoomIn, command: COMMAND_IDS.zoomIn, context: 'always'}),
  Object.freeze({role: 'button', name: COPY.fit, command: COMMAND_IDS.fit, context: 'always'}),
  Object.freeze({role: 'button', name: COPY.zoomLoop, command: COMMAND_IDS.zoomLoop, context: 'always'}),
  Object.freeze({role: 'button', name: COPY.gridButton(COPY.divisions.bar), context: 'mapped'}),
  Object.freeze({role: 'button', name: COPY.snap, command: COMMAND_IDS.snap, context: 'always'}),
  Object.freeze({role: 'button', name: COPY.follow, command: COMMAND_IDS.follow, context: 'always'}),
  Object.freeze({role: 'group', name: 'Drums', context: 'row'}),
  Object.freeze({role: 'button', name: COPY.mute('Drums'), context: 'row'}),
  Object.freeze({role: 'button', name: COPY.solo('Drums'), context: 'row'}),
  Object.freeze({role: 'slider', name: COPY.level('Drums'), context: 'laptop'}),
  Object.freeze({role: 'button', name: COPY.backToPlayhead, context: 'paused'}),
]);

// ------------------------------------------------------------------ pure helpers

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const peek = (s) => (s && typeof s.peek === 'function' ? s.peek() : s);

/**
 * A window {t0, span} kept inside [0, duration] as a whole: hitting either end never changes the
 * zoom (timeline-navigation.js boundedView's rule). The span is at least MIN_SPAN (or the song).
 */
export function clampView({t0 = 0, span = 0} = {}, duration = 0, minSpan = MIN_SPAN) {
  const d = Math.max(0, finite(duration) ? duration : 0);
  if (!(d > 0)) return {t0: 0, span: 0};
  const s = clamp(finite(span) && span > 0 ? span : d, Math.min(minSpan, d), d);
  return {t0: clamp(finite(t0) ? t0 : 0, 0, d - s), span: s};
}

/** Zooms a window by `factor` (< 1 zooms in) keeping time `at` at the same place on screen. */
export function zoomView(view, {at, factor}, duration, minSpan = MIN_SPAN) {
  const d = Math.max(0, duration || 0);
  if (!(d > 0) || !(view?.span > 0)) return clampView(view, d, minSpan);
  const span = clamp(view.span * factor, Math.min(minSpan, d), d);
  const anchor = finite(at) ? at : view.t0 + view.span / 2;
  const frac = clamp((anchor - view.t0) / view.span, 0, 1);
  return clampView({t0: anchor - frac * span, span}, d, minSpan);
}

/** The window that shows a loop with LOOP_MARGIN on each side. */
export function loopView({a, b}, duration, minSpan = MIN_SPAN) {
  const length = Math.max(0, b - a);
  return clampView({t0: a - length * LOOP_MARGIN, span: length * (1 + 2 * LOOP_MARGIN)}, duration, minSpan);
}

/** How a row draws (spec §4.4D): muted → 'out', soloed → 'solo', the rest 'dim' while anything is soloed. */
export function rowState(track, anySolo) {
  if (anySolo && track?.soloed) return 'solo';
  if (track?.muted) return 'out';
  return anySolo ? 'dim' : 'on';
}

/** The word in a row header: SOLO, OUT or nothing. */
export function rowWord(track, anySolo) {
  const state = rowState(track, anySolo);
  return state === 'solo' ? COPY.soloWord : state === 'out' ? COPY.out : '';
}

/** A ruler time label: m:ss, or m:ss.s when the step is under a second. */
export function timeLabel(t, step = 1) {
  if (step >= 1) return formatClock(t);
  const tenths = Math.round(t * 10);
  return `${formatClock(Math.floor(tenths / 10))}.${tenths % 10}`;
}

/**
 * The ruler's labels for the window [t0, t0 + span] over `width` px: [{x, label, kind}].
 * Mapped: numbered bars every 1, 2, 4, 8 … bars so labels keep RULER_MIN_PX.bar apart (the pickup
 * bar is not numbered). Unmapped: times every 0.5, 1, 2, 5, 10 … s, RULER_MIN_PX.time apart.
 */
export function rulerMarks({map = null, t0 = 0, span = 0, width = 0} = {}) {
  if (!(span > 0) || !(width > 0)) return [];
  const t1 = t0 + span;
  const x = (t) => ((t - t0) / span) * width;
  const out = [];
  if (map?.isReal && map.bars?.length) {
    const bars = map.bars;
    const first = Math.max(0, map.barIndexAt(t0)), last = Math.min(bars.length - 1, map.barIndexAt(t1));
    let narrowest = Infinity;
    for (let i = first; i <= last; i++) {
      const b = bars[i];
      if (b.display == null) continue;
      narrowest = Math.min(narrowest, ((b.t1 - b.t0) / span) * width);
    }
    if (!finite(narrowest)) return [];
    const step = BAR_STEPS.find((n) => n * narrowest >= RULER_MIN_PX.bar) ?? BAR_STEPS[BAR_STEPS.length - 1];
    for (let i = first; i <= last; i++) {
      const b = bars[i];
      if (b.display == null || (b.display - 1) % step !== 0 || b.t0 < t0 - EPS || b.t0 > t1 + EPS) continue;
      out.push({x: x(b.t0), label: String(b.display), kind: 'bar', t: b.t0});
    }
    return out;
  }
  const step = TIME_STEPS.find((s) => (s / span) * width >= RULER_MIN_PX.time) ?? TIME_STEPS[TIME_STEPS.length - 1];
  for (let k = Math.ceil(t0 / step - EPS); k * step <= t1 + EPS; k++) {
    const t = Math.round(k * step * 1000) / 1000;
    out.push({x: x(t), label: timeLabel(t, step), kind: 'time', t});
  }
  return out;
}

const colorKey = (name) => {
  const lower = String(name ?? '').toLowerCase();
  return STEM_KEYS.includes(lower) ? lower : 'other';
};

// ------------------------------------------------------------------ commands (§3.3)

/** Mounted surfaces, oldest first; the commands act on the newest one that is on screen. */
const live = [];
const activeSurface = () => {
  for (let i = live.length - 1; i >= 0; i--) if (live[i].shown()) return live[i];
  return null;
};

/** The §3.3 definitions. Each acts on the Stems surface on screen and is disabled without one. */
export function stemsCommandDefs() {
  const on = () => !!activeSurface();
  const act = (name) => () => { activeSurface()?.command(name); };
  return [
    {id: COMMAND_IDS.zoomIn, title: COPY.zoomIn, group: 'View', keys: ['='], scopes: [SCOPE], when: on, run: act('zoomIn'),
      repeat: true, icon: 'zoom-in', palette: {keywords: ['stems', 'closer', 'magnify']}},
    {id: COMMAND_IDS.zoomOut, title: COPY.zoomOut, group: 'View', keys: ['-'], scopes: [SCOPE], when: on, run: act('zoomOut'),
      repeat: true, icon: 'zoom-out', palette: {keywords: ['stems', 'wider']}},
    {id: COMMAND_IDS.fit, title: COPY.fit, group: 'View', keys: ['\\'], scopes: [SCOPE], when: on, run: act('fit'),
      icon: 'maximize-2', palette: {keywords: ['stems', 'whole song', 'zoom']}},
    {id: COMMAND_IDS.zoomLoop, title: COPY.zoomLoop, group: 'View', keys: ['KeyZ'], scopes: [SCOPE],
      when: () => !!activeSurface()?.hasLoop(), run: act('zoomLoop'), icon: 'scan', palette: {keywords: ['stems', 'loop', 'zoom']}},
    {id: COMMAND_IDS.grid, title: COPY.gridToggle, group: 'View', keys: ['KeyG'], scopes: [SCOPE],
      when: () => !!activeSurface()?.mapped(), checked: () => !!activeSurface()?.gridOn(), run: act('grid'), icon: 'grid-3x3',
      palette: {keywords: ['stems', 'beats', 'lines']}},
    {id: COMMAND_IDS.snap, title: COPY.snap, group: 'View', keys: ['Shift+KeyS'], scopes: [SCOPE], when: on,
      checked: () => !!activeSurface()?.snapOn(), run: act('snap'), icon: 'magnet', palette: {keywords: ['stems', 'grid', 'snap to grid']}},
    {id: COMMAND_IDS.follow, title: COPY.follow, group: 'View', keys: ['KeyF'], scopes: [SCOPE], when: on,
      checked: () => !!activeSurface()?.followChecked(), run: act('follow'), icon: 'arrow-down-to-line',
      palette: {keywords: ['stems', 'playhead', 'scroll']}},
  ];
}

/**
 * Registers the §3.3 commands on `registry` (registry CI calls this; a mounted surface does it
 * for itself). Returns off().
 */
export function defineStemsCommands({registry = appRegistry} = {}) {
  return registry.registerMany(stemsCommandDefs());
}

/** Per registry: how many surfaces use the commands, and off() when a surface registered them. */
const holds = new WeakMap();
function holdCommands(registry) {
  let hold = holds.get(registry);
  if (!hold) {
    hold = {count: 0, off: registry.get(COMMAND_IDS.zoomIn) ? null : defineStemsCommands({registry})};
    holds.set(registry, hold);
  }
  hold.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--hold.count > 0) return;
    holds.delete(registry);
    hold.off?.();
  };
}

// ------------------------------------------------------------------ the surface

export function createStemsSurface(host, opts = {}) {
  if (!host) throw new TypeError('createStemsSurface: a host element is required');
  const {session, stage = null} = opts;
  if (!session) throw new TypeError('createStemsSurface: a session is required');
  const registry = opts.registry ?? appRegistry;
  const prefs = opts.prefs ?? appPrefs;
  const platform = opts.platform ?? appPlatform;
  const setScope = opts.setSurfaceScope ?? appSetSurfaceScope;
  const now = opts.now ?? clockNow;
  const {transport, map} = session;
  const doc = host.ownerDocument ?? document;
  const win = doc.defaultView ?? globalThis.window;
  const offs = [];
  let destroyed = false;

  // ---------------------------------------------------------------- state
  const pref = (key, fallback) => {
    const v = prefs.get?.(`stems.${key}`);
    return v === undefined ? fallback : v;
  };
  let grid = GRID_CHOICES.includes(pref('grid', 'bar')) ? pref('grid', 'bar') : 'bar';
  let lastDivision = grid === 'off' ? 'bar' : grid;
  let snapOn = pref('snap', true) !== false;
  let followOn = pref('follow', true) !== false;
  let followPaused = false;
  let playing = false;
  let loop = null;            // {a, b} from setLoop
  let preview = null;         // {a, b} while a new loop is being dragged here
  let view = {t0: 0, span: 0};
  let width = 0, height = 0;
  let zoomTimer = null;
  let zoomDirty = false;
  const viewport = signal(null);

  const duration = () => Math.max(0, map?.duration || session.engine?.duration || 0);
  const mapped = () => !!map?.isReal;
  const snapshot = () => peek(transport.snapshot) ?? {};
  const position = () => (typeof transport.position === 'function' ? transport.position() : snapshot().cue ?? 0);
  const compact = () => !!platform?.isIPad || !!peek(platform?.coarse);
  const coarse = () => !!peek(platform?.coarse);
  const tracks = () => {
    const list = snapshot().mix?.tracks;
    return Array.isArray(list) ? list : [];
  };

  // ---------------------------------------------------------------- DOM
  const toolbar = h('div', {class: 'stems-toolbar', role: 'group', attrs: {'aria-label': COPY.toolbar}});
  const rulerLabels = h('div', {class: 'stems-ruler-marks'});
  const ruler = h('div', {class: 'stems-ruler', 'aria-hidden': 'true'}, h('div', {class: 'stems-ruler-gap'}), rulerLabels);
  const canvas = h('canvas', {class: 'stems-canvas', 'aria-hidden': 'true', dataset: {testid: 'stems-canvas'}});
  const cueEl = h('div', {class: 'stems-cue', 'aria-hidden': 'true'});
  const playheadEl = h('div', {class: 'stems-playhead', 'aria-hidden': 'true', dataset: {volatile: ''}});
  const lanes = h('div', {class: 'stems-lanes', 'aria-hidden': 'true', dataset: {testid: 'stems-lanes'}}, canvas, cueEl, playheadEl);
  const rowsEl = h('div', {class: 'stems-rows', role: 'list', attrs: {'aria-label': COPY.rows}}, lanes);
  const scroller = h('div', {class: 'stems-scroller', dataset: {scroller: ''}}, rowsEl);
  const pillHost = h('div', {class: 'stems-pill-host'});
  const root = h('section', {class: 'stems', attrs: {'aria-label': COPY.region}, dataset: {surface: 'stems'}}, toolbar, ruler, scroller, pillHost);
  host.append(root);

  // ---------------------------------------------------------------- toolbar
  const buttons = [];
  const keep = (b) => { buttons.push(b); return b; };
  const zoomGroup = h('div', {class: 'stems-tool-group'});
  zoomGroup.append(
    keep(IconButton({label: COPY.zoomOut, icon: 'zoom-out', command: COMMAND_IDS.zoomOut, size: 'sm', registry})).el,
    keep(IconButton({label: COPY.zoomIn, icon: 'zoom-in', command: COMMAND_IDS.zoomIn, size: 'sm', registry})).el,
    keep(Button({label: COPY.fit, command: COMMAND_IDS.fit, size: 'sm', variant: 'quiet', registry})).el,
  );
  const zoomLoopButton = keep(Button({label: COPY.zoomLoop, icon: 'scan', command: COMMAND_IDS.zoomLoop, size: 'sm', variant: 'quiet', kbd: true, registry}));
  let gridMenu = null;
  const gridButton = keep(Button({
    label: COPY.gridButton(COPY.divisions[grid]), iconEnd: 'chevron-down', size: 'sm', variant: 'quiet',
    attrs: {'aria-haspopup': 'menu', 'aria-expanded': 'false'}, className: 'stems-grid-button',
    onClick: () => openGridMenu(),
  }));
  const snapToggle = keep(Toggle({label: COPY.snap, icon: 'magnet', command: COMMAND_IDS.snap, size: 'sm', variant: 'quiet', registry}));
  const followToggle = keep(Toggle({label: COPY.follow, icon: 'arrow-down-to-line', command: COMMAND_IDS.follow, size: 'sm', variant: 'quiet', registry}));
  toolbar.append(zoomGroup, zoomLoopButton.el, gridButton.el, snapToggle.el, followToggle.el);
  // The Follow pill (56 px, bottom centre) while manual navigation has paused Follow.
  const pill = keep(Button({label: COPY.backToPlayhead, icon: 'arrow-down-to-line', variant: 'primary', className: 'stems-pill',
    dataset: {followPill: ''}, onClick: () => resumeFollow()}));
  pill.el.hidden = true;
  pillHost.append(pill.el);

  function renderToolbar() {
    // An unmapped song has no grid: the control is not there at all (and so never says "Bar").
    if (!mapped()) { gridMenu?.close?.(); gridButton.el.remove(); }
    else if (!gridButton.el.isConnected || gridButton.el.parentNode !== toolbar) toolbar.insertBefore(gridButton.el, snapToggle.el);
    gridButton.set({label: COPY.gridButton(COPY.divisions[grid])});
    root.dataset.grid = grid;
    root.toggleAttribute('data-snap', snapOn);
    root.toggleAttribute('data-follow', followOn && !followPaused);
    pill.el.hidden = !(followOn && followPaused);
  }

  function openGridMenu() {
    if (!mapped()) return;
    gridMenu?.close?.();
    gridButton.el.setAttribute('aria-expanded', 'true');
    const items = GRID_CHOICES.map((choice) => ({
      id: `stems-grid-${choice}`, type: 'radio', label: COPY.divisions[choice], checked: grid === choice,
      run: () => setGrid(choice),
    }));
    gridMenu = Menu.open(items, {
      anchor: gridButton.el, label: COPY.grid, registry,
      onClose: () => { gridButton.el.setAttribute('aria-expanded', 'false'); gridMenu = null; },
    });
  }

  // ---------------------------------------------------------------- grid, snap, follow
  function setGrid(choice) {
    if (!GRID_CHOICES.includes(choice) || choice === grid) return;
    grid = choice;
    if (choice !== 'off') lastDivision = choice;
    prefs.set?.('stems.grid', choice);
    changed();
  }
  const toggleGrid = () => setGrid(grid === 'off' ? lastDivision : 'off');
  function toggleSnap() {
    snapOn = !snapOn;
    prefs.set?.('stems.snap', snapOn);
    changed();
  }

  function notifyFollow() {
    try { opts.onFollowChange?.(!followPaused); } catch (err) { console.error('[stems] onFollowChange failed', err); }
  }
  /** Manual navigation while playing pauses Follow (the Stage shows "Back to playhead"). */
  function pauseFollow() {
    if (!followOn || followPaused || !playing) return;
    followPaused = true;
    notifyFollow();
    changed({draw: false});
  }
  function resumeFollow({notify = true} = {}) {
    const was = followPaused;
    followPaused = false;
    if (was && notify) notifyFollow();
    revealPlayhead();
    changed({draw: false});
  }
  /** F / the Follow toggle: a paused Follow resumes; otherwise Follow turns on or off (a device pref). */
  function toggleFollow() {
    if (followOn && followPaused) { resumeFollow(); return; }
    followOn = !followOn;
    prefs.set?.('stems.follow', followOn);
    if (followOn) revealPlayhead();
    changed({draw: false});
  }

  /** The snap division (null: no snapping). Shift never snaps; Alt snaps to beats (mapped). */
  function snapDivision({alt = false, shift = false} = {}) {
    if (shift) return null;
    if (!mapped()) return snapOn ? 'bar' : null;
    if (alt) return 'beat';
    if (!snapOn) return null;
    return grid === 'off' ? 'bar' : grid;
  }
  function snapAt(t, mods = {}) {
    const division = snapDivision(mods);
    if (!division || !finite(t)) return t;
    try {
      return clamp(snapTime(mapped() ? map : null, t, division, {mode: mods.mode ?? 'nearest'}), 0, duration());
    } catch (err) {
      console.warn('[stems] snapping failed', err);
      return t;
    }
  }

  // ---------------------------------------------------------------- the view
  const t1Of = () => view.t0 + view.span;
  const toLocal = (t) => (view.span > 0 ? ((t - view.t0) / view.span) * width : 0);

  function writeViewport() {
    const v = view.span > 0 ? {t0: view.t0, t1: t1Of()} : null;
    // The window on the root, for probes (ms precision).
    root.dataset.t0 = v ? String(Math.round(v.t0 * 1000) / 1000) : '';
    root.dataset.t1 = v ? String(Math.round(v.t1 * 1000) / 1000) : '';
    const cur = viewport.peek();
    if (!v ? cur === null : cur && Math.abs(cur.t0 - v.t0) < EPS && Math.abs(cur.t1 - v.t1) < EPS) return;
    viewport.value = v;
  }

  /** Shows a window. `manual` (wheel, pan, pinch, the strip bracket) pauses Follow while playing; `zoom` saves the zoom. */
  function setView(next, {manual = false, zoom = false} = {}) {
    const v = clampView(next, duration());
    const same = Math.abs(v.t0 - view.t0) < EPS && Math.abs(v.span - view.span) < EPS;
    if (manual) pauseFollow();
    if (zoom && Math.abs(v.span - view.span) > EPS) saveZoomSoon();
    if (same) return false;
    view = v;
    writeViewport();
    scheduleDraw();
    return true;
  }

  function saveZoomSoon() {
    zoomDirty = true;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(saveZoom, ZOOM_SAVE_MS);
  }
  function saveZoom() {
    clearTimeout(zoomTimer);
    zoomTimer = null;
    if (!zoomDirty) return;
    zoomDirty = false;
    const d = duration();
    if (!(d > 0) || !(view.span > 0)) return;
    const value = view.span >= d - 1e-3 ? null : Math.round(view.span * 1000) / 1000;
    if (prefs.get?.('stems.zoom') !== value) prefs.set?.('stems.zoom', value);
  }

  /** The window the device last used (prefs.stems.zoom; null → Fit), around `t` at the follow line. */
  function restoredView(t) {
    const d = duration();
    const zoom = prefs.get?.('stems.zoom');
    const span = finite(zoom) && zoom > 0 ? Math.min(zoom, d) : d;
    return clampView({t0: (finite(t) ? t : 0) - span * FOLLOW_LINE, span}, d);
  }

  const zoomBy = (factor, at) => setView(zoomView(view, {at, factor}, duration()), {zoom: true});
  /** − / + zoom about the playhead when it is on screen, else about the middle. */
  function zoomAnchor() {
    const p = position();
    return p >= view.t0 && p <= t1Of() ? p : view.t0 + view.span / 2;
  }
  const zoomIn = () => zoomBy(1 / ZOOM_STEP, zoomAnchor());
  const zoomOut = () => zoomBy(ZOOM_STEP, zoomAnchor());
  const fit = () => setView({t0: 0, span: duration()}, {zoom: true});
  function zoomToLoop() {
    const range = preview ?? loop;
    if (!range) return;
    setView(loopView(range, duration()), {zoom: true});
  }

  /** Puts t at the follow line. */
  function reveal(t) {
    if (!finite(t)) return;
    if (!(view.span > 0)) { view = restoredView(t); writeViewport(); scheduleDraw(); return; }
    setView({t0: t - view.span * FOLLOW_LINE, span: view.span});
  }
  function revealPlayhead() {
    const p = position();
    if (finite(p) && (p < view.t0 || p > view.t0 + view.span * FOLLOW_EDGE)) reveal(p);
  }

  // The strip's viewport bracket writes the window back.
  offs.push(effect(() => {
    const v = viewport.value;
    if (destroyed || !v || !finite(v.t0) || !finite(v.t1)) return;
    if (Math.abs(v.t0 - view.t0) < EPS && Math.abs(v.t1 - t1Of()) < EPS) return;
    untracked(() => {
      setView({t0: v.t0, span: v.t1 - v.t0}, {manual: true, zoom: Math.abs((v.t1 - v.t0) - view.span) > EPS});
      // The window shown may differ (clamped): the bracket follows it.
      writeViewport();
    });
  }));

  // ---------------------------------------------------------------- rows
  const rows = new Map();   // name → {el, head, word, mute, solo, fader, kbd, lane}
  let rowOrder = [];

  function createRow(track, index) {
    const label = stemLabel(track.name);
    const color = h('span', {class: 'stems-color', 'aria-hidden': 'true'});
    color.style.setProperty('--stems-color', stemColor(colorKey(track.name)));
    const name = h('span', {class: 'stems-name'}, label);
    const kbdHost = h('span', {class: 'stems-key'});
    const word = h('span', {class: 'stems-word', 'aria-hidden': 'true'});
    const mute = Button({label: COPY.muteShort, size: 'sm', variant: 'secondary', className: 'stems-ms', attrs: {'aria-label': COPY.mute(label)},
      pressed: false, onClick: () => { const t = trackOf(track.name); if (t) transport.setMuted(track.name, !t.muted); }});
    const solo = Button({label: COPY.soloShort, size: 'sm', variant: 'secondary', className: 'stems-ms', attrs: {'aria-label': COPY.solo(label)},
      pressed: false, onClick: () => { const t = trackOf(track.name); if (t) transport.setSoloed(track.name, !t.soloed); }});
    const fader = Fader({label: COPY.level(label), value: finite(track.volume) ? track.volume : 1, variant: 'inline', className: 'stems-fader',
      onInput: (v) => transport.setVolume(track.name, v), onChange: (v) => transport.setVolume(track.name, v)});
    const line1 = h('div', {class: 'stems-head-line'}, name, kbdHost);
    const line2 = h('div', {class: 'stems-head-line'}, mute.el, solo.el, word);
    const line3 = h('div', {class: 'stems-head-line stems-head-level'}, fader.el);
    const head = h('div', {class: 'stems-head', role: 'listitem'},
      h('div', {class: 'stems-head-body', role: 'group', attrs: {'aria-label': label}}, color, line1, line2, line3));
    const lane = h('div', {class: 'stems-lane', 'aria-hidden': 'true'});
    // The laptop fader; on an iPad (or any coarse pointer) the level lives in the Mix sheet.
    line3.hidden = compact();
    const row = {name: track.name, head, lane, word, mute, solo, fader, kbdHost, kbd: null, index: -1, line3};
    updateRow(row, track, index, false);
    return row;
  }

  function updateRow(row, track, index, anySolo) {
    if (row.index !== index) {
      row.index = index;
      row.kbd?.destroy?.();
      row.kbd = null;
      row.kbdHost.replaceChildren();
      if (index < 9) {
        row.kbd = Kbd({keys: `Digit${index + 1}`});
        row.kbdHost.append(row.kbd.el);
      }
      row.head.style.gridRow = String(index + 1);
      row.lane.style.gridRow = String(index + 1);
    }
    const state = rowState(track, anySolo);
    row.head.dataset.state = state;
    row.lane.dataset.state = state;
    row.word.textContent = rowWord(track, anySolo);
    row.mute.set({pressed: !!track.muted});
    row.solo.set({pressed: !!track.soloed});
    if (!row.fader.dragging && finite(track.volume) && Math.abs(row.fader.value - track.volume) > 1e-4) row.fader.set({value: track.volume});
  }

  const trackOf = (name) => tracks().find((t) => t.name === name) ?? null;

  function renderRows() {
    const list = tracks();
    const names = list.map((t) => t.name);
    const anySolo = list.some((t) => t.soloed);
    if (names.join('\n') !== rowOrder.join('\n')) {
      for (const [name, row] of rows) {
        if (names.includes(name)) continue;
        row.mute.destroy(); row.solo.destroy(); row.fader.destroy?.(); row.kbd?.destroy?.();
        row.head.remove(); row.lane.remove();
        rows.delete(name);
      }
      list.forEach((t, i) => {
        let row = rows.get(t.name);
        if (!row) { row = createRow(t, i); rows.set(t.name, row); }
        rowsEl.insertBefore(row.head, lanes);
        rowsEl.insertBefore(row.lane, lanes);
      });
      rowOrder = names;
      lanes.style.gridRow = `1 / ${Math.max(1, names.length) + 1}`;
      root.style.setProperty('--stems-rows', String(Math.max(1, names.length)));
    }
    list.forEach((t, i) => updateRow(rows.get(t.name), t, i, anySolo));
  }

  // ---------------------------------------------------------------- drawing
  let drawQueued = null;
  const raf = opts.raf ?? ((fn) => (typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame(fn) : setTimeout(fn, 16)));
  const caf = opts.caf ?? ((id) => (typeof globalThis.cancelAnimationFrame === 'function' ? globalThis.cancelAnimationFrame(id) : clearTimeout(id)));
  function scheduleDraw() {
    if (drawQueued != null || destroyed) return;
    drawQueued = raf(() => { drawQueued = null; draw(); });
  }

  function measure() {
    const r = lanes.getBoundingClientRect?.();
    width = Math.max(0, Math.round(lanes.clientWidth || r?.width || 0));
    height = Math.max(0, Math.round(lanes.clientHeight || r?.height || 0));
  }

  /** Each row's lane box (lanes-local y and height): the headers' boxes, else an equal split. */
  function rowBoxes() {
    const n = rowOrder.length;
    if (!n || !(height > 0)) return [];
    const top = lanes.getBoundingClientRect?.().top ?? 0;
    const measured = rowOrder.map((name) => rows.get(name)?.head.getBoundingClientRect?.());
    if (measured.every((r) => r && r.height > 0)) return measured.map((r) => ({y: r.top - top, h: r.height}));
    const each = height / n;
    return rowOrder.map((_, i) => ({y: i * each, h: each}));
  }

  function draw() {
    if (destroyed) return;
    measure();
    renderRuler();
    placeLines();
    handles.update();
    const dpr = win?.devicePixelRatio || 1;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (!width || !height || !(view.span > 0)) { delete canvas.dataset.peaksReady; delete canvas.dataset.gridDrawn; return; }
    const pw = Math.round(width * dpr), ph = Math.round(height * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const list = tracks();
    const anySolo = list.some((t) => t.soloed);
    const boxes = rowBoxes();
    const peaks = session.peaks;
    const t0 = view.t0, t1 = t1Of();
    drawRows(ctx, {
      rows: list.map((t, i) => ({name: t.name, color: colorKey(t.name), state: rowState(t, anySolo), y: boxes[i]?.y ?? 0, h: boxes[i]?.h ?? 0})),
      t0, t1, width, dpr, peaks,
    });
    if (peaks?.ready) canvas.dataset.peaksReady = 'true'; else delete canvas.dataset.peaksReady;
    let drawn = null;
    if (mapped() && grid !== 'off') {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawn = drawGrid(ctx, {ticks: gridTicks(map, t0, t1, grid), t0, t1, w: width, h: height, minPx: GRID_MIN_PX});
    }
    const kinds = drawn ? Object.keys(drawn).filter((k) => drawn[k]) : [];
    if (kinds.length) canvas.dataset.gridDrawn = kinds.join(' '); else delete canvas.dataset.gridDrawn;
  }

  let rulerKey = '';
  function renderRuler() {
    rulerLabels.style.width = `${width}px`;
    const marks = rulerMarks({map: mapped() ? map : null, t0: view.t0, span: view.span, width});
    const key = marks.map((m) => `${m.label}@${m.x.toFixed(1)}`).join('|');
    root.dataset.ruler = mapped() ? 'bars' : 'time';
    if (key === rulerKey) return;
    rulerKey = key;
    rulerLabels.replaceChildren(...marks.map((m) => {
      const el = h('span', {class: 'stems-mark', dataset: {kind: m.kind}}, m.label);
      el.style.transform = `translateX(${Math.round(m.x)}px)`;
      return el;
    }));
  }

  function placeLine(el, t) {
    if (!finite(t) || !(view.span > 0) || t < view.t0 - EPS || t > t1Of() + EPS) { el.hidden = true; return; }
    el.hidden = false;
    el.style.transform = `translateX(${Math.round(toLocal(t) * 10) / 10}px)`;
  }
  function placeLines(pos = position()) {
    placeLine(cueEl, snapshot().cue);
    placeLine(playheadEl, pos);
  }

  // ---------------------------------------------------------------- loop handles
  const laneRect = () => lanes.getBoundingClientRect();
  const clientToT = (clientX) => {
    const r = laneRect();
    const w = width || r.width || 0;
    if (!(w > 0) || !(view.span > 0)) return view.t0;
    return clamp(view.t0 + ((clientX - r.left) / w) * view.span, 0, duration());
  };
  const handles = mountLoopHandles(lanes, {
    toX: (t) => (view.span > 0 ? laneRect().left + toLocal(t) : null),
    toT: (clientX) => clientToT(clientX),
    rows: () => {
      const r = laneRect();
      return rowBoxes().map((b) => ({left: r.left, right: r.left + (width || r.width), top: r.top + b.y, bottom: r.top + b.y + b.h,
        width: width || r.width, height: b.h, x: r.left, y: r.top + b.y}));
    },
    snap: (t, mods) => snapAt(t, mods),
    playing: () => playing,
    onEdit: ({a, b, phase}) => {
      if (phase === 'cancel') { handles.set(loop); return; }
      loopEdit(a, b, phase);
    },
  });

  function loopEdit(a, b, phase) {
    const range = {a, b};
    if (mapped()) {
      const ia = map.barIndexAt(a), ib = map.barIndexAt(Math.max(a, b - EPS));
      if (map.bars[ia]?.display != null) range.aBar = map.bars[ia].display;
      if (map.bars[ib]?.display != null) range.bBar = map.bars[ib].display;
    }
    try { opts.onLoopEdit?.({...range, phase}); } catch (err) { console.error('[stems] onLoopEdit failed', err); }
  }

  // ---------------------------------------------------------------- gestures
  /** A gesture at a client point: the time, the snapped time and the bar there. */
  function hit(e) {
    const raw = clientToT(e.clientX);
    const t = snapAt(raw, {alt: e.altKey, shift: e.shiftKey});
    const out = {t, beatTime: t, pointerType: e.pointerType || 'touch', clientX: e.clientX, clientY: e.clientY};
    if (mapped()) {
      const bar = map.bars[map.barIndexAt(t)];
      if (bar?.display != null) out.bar = bar.display;
    }
    return out;
  }
  const activate = (kind, e) => {
    try { opts.onActivate?.({kind, ...hit(e)}); } catch (err) { console.error('[stems] onActivate failed', err); }
  };

  /** A new loop dragged from `from` (time): previewed on the handles, committed on release. */
  let loopDrag = null;
  function dragTo(clientX, mods = {}) {
    if (!loopDrag) return;
    const t = clientToT(clientX);
    const lo = Math.min(loopDrag.from, t), hi = Math.max(loopDrag.from, t);
    let a = lo, b = hi;
    if (snapDivision(mods)) {
      a = snapAt(lo, {...mods, mode: 'floor'});
      b = snapAt(hi, {...mods, mode: 'ceil'});
    }
    if (b - a < MIN_LOOP) return;
    preview = {a, b};
    handles.set(preview);
    loopEdit(a, b, 'preview');
  }
  function endDrag({commit}) {
    const d = loopDrag;
    loopDrag = null;
    const range = preview;
    preview = null;
    if (!d) return;
    if (commit && range) {
      loopEdit(range.a, range.b, 'commit');
      handles.set(range);
    } else {
      handles.set(loop);
    }
  }

  let downAt = null;   // the client point of the latest primary press (a mouse drag starts there)
  const onDown = (e) => { if (e.isPrimary !== false) downAt = {x: e.clientX, y: e.clientY}; };
  lanes.addEventListener('pointerdown', onDown, true);
  offs.push(() => lanes.removeEventListener('pointerdown', onDown, true));

  offs.push(createPressRecognizer(lanes, {
    touchAction: 'none',
    haptic: (ms) => platformHaptic(ms),
    onTap: (e) => activate('tap', e),
    onDouble: (e) => activate('double', e),
    onMenu: (e) => activate(e.pointerType === 'mouse' || e.keyboard ? 'context' : 'long', e),
    onLongStart: (e) => {
      if (pressPolicy({pointerType: e.pointerType, playing, gesture: 'longDrag'}) !== 'loopDrag') return false;
      loopDrag = {from: clientToT(e.clientX), pointer: e.pointerType};
      return true;
    },
    onLongDrag: (e) => dragTo(e.clientX, {alt: e.altKey, shift: e.shiftKey}),
    onLongEnd: (e, {dragged, cancelled}) => {
      if (!loopDrag) return;
      endDrag({commit: dragged && !cancelled});
    },
    onDragStart: (e) => {
      if (pressPolicy({pointerType: 'mouse', playing, gesture: 'drag'}) !== 'loopDrag') return;
      const x = downAt?.x ?? e.clientX;
      loopDrag = {from: clientToT(x), pointer: 'mouse'};
    },
    onDrag: (e) => dragTo(e.clientX, {alt: e.altKey, shift: e.shiftKey}),
    onDragEnd: (e) => endDrag({commit: !e.cancelled}),
  }));

  // Two fingers: pan and pinch zoom, previewed live (the canvas redraws), committed on release.
  let pinchStart = null;
  const pinchView = (g) => {
    if (!pinchStart) return null;
    const {rect, w} = pinchStart;
    const span = clamp(pinchStart.span / (g.factor || 1), Math.min(MIN_SPAN, duration()), duration());
    const frac = w > 0 ? clamp((g.cx - rect.left) / w, 0, 1) : 0.5;
    const anchor = pinchStart.t0 + frac * pinchStart.span;
    const t0 = anchor - frac * span - (w > 0 ? (g.dx / w) * span : 0);
    return {t0, span};
  };
  const pinch = createPinch(lanes, {
    base: 1, min: 0, max: Infinity, pan: true, wheel: false,
    shouldStart: () => pressPolicy({pointerType: 'touch', playing, gesture: 'pinch'}) === 'zoom',
    onStart: () => {
      const rect = laneRect();
      pinchStart = {t0: view.t0, span: view.span, rect, w: width || rect.width, scrollTop: scroller.scrollTop};
    },
    onPreview: (g) => {
      const v = pinchView(g);
      if (v) setView(v, {manual: true});
      if (pinchStart) scroller.scrollTop = Math.max(0, pinchStart.scrollTop - g.dy);
    },
    onCommit: (g) => {
      const v = pinchView(g);
      if (v) setView(v, {manual: true, zoom: true});
      pinchStart = null;
    },
    onCancel: () => { pinchStart = null; },
  });
  offs.push(() => pinch.destroy());

  // The wheel, as 1.9: vertical zooms at the cursor, horizontal or Shift pans, ⌘/Ctrl (a trackpad pinch) zooms.
  const interpretWheel = wheelNavigation();
  const onWheel = (e) => {
    if (!(view.span > 0)) return;
    e.preventDefault();
    const w = width || laneRect().width || 1;
    const {mode, delta} = interpretWheel(e, w, now());
    if (!delta) return;
    if (mode === 'pan') setView({t0: view.t0 + (delta / w) * view.span, span: view.span}, {manual: true});
    else setView(zoomView(view, {at: clientToT(e.clientX), factor: Math.exp(delta * WHEEL_ZOOM_RATE)}, duration()), {manual: true, zoom: true});
  };
  for (const target of [lanes, ruler]) {
    target.addEventListener('wheel', onWheel, {passive: false});
    offs.push(() => target.removeEventListener('wheel', onWheel, {passive: false}));
  }

  // ---------------------------------------------------------------- commands and the surface scope
  let shownOnStage = true;
  const self = {
    shown: () => !destroyed && shownOnStage,
    hasLoop: () => !!(preview ?? loop),
    mapped,
    gridOn: () => mapped() && grid !== 'off',
    snapOn: () => snapOn,
    followChecked: () => followOn && !followPaused,
    command(name) {
      switch (name) {
        case 'zoomIn': zoomIn(); break;
        case 'zoomOut': zoomOut(); break;
        case 'fit': fit(); break;
        case 'zoomLoop': zoomToLoop(); break;
        case 'grid': toggleGrid(); break;
        case 'snap': toggleSnap(); break;
        case 'follow': toggleFollow(); break;
        default: break;
      }
    },
  };
  live.push(self);
  const releaseCommands = holdCommands(registry);
  let scoped = false;
  function syncScope() {
    const want = self.shown();
    if (want === scoped) return;
    scoped = want;
    if (want) setScope(SCOPE);
    else if (!activeSurface()) setScope(null);
    registry.invalidate?.();
  }
  // The Stage's surface signal says when this surface is the one on screen (a switch away drops
  // the scope at once, before the crossfade ends).
  if (stage?.surface && typeof stage.surface.subscribe === 'function') {
    offs.push(effect(() => {
      const kind = stage.surface.value;
      shownOnStage = kind == null || kind === 'stems';
      if (!destroyed) syncScope();
    }));
  } else {
    syncScope();
  }

  // ---------------------------------------------------------------- wiring
  /** Something the toolbar, the commands or the canvas show changed. */
  function changed({draw: redraw = true} = {}) {
    renderToolbar();
    registry.invalidate?.();
    if (redraw) scheduleDraw();
  }

  function applyCompact() {
    root.toggleAttribute('data-compact', compact());
    root.toggleAttribute('data-coarse', coarse());
    for (const row of rows.values()) row.line3.hidden = compact();
    root.dataset.layout = stage?.layout?.peek?.() ?? opts.layout ?? '';
  }
  applyCompact();
  if (platform?.coarse?.subscribe) offs.push(platform.coarse.subscribe(() => { applyCompact(); scheduleDraw(); }));

  // Transport: the rows' mix state, the cue, the phase (glass and Follow).
  let lastPhase = snapshot().phase;
  offs.push(effect(() => {
    const s = transport.snapshot?.value ?? {};
    if (destroyed) return;
    untracked(() => onTransport(s));
  }));
  function onTransport(s) {
    root.dataset.phase = s.phase ?? 'stopped';
    renderRows();
    const isPlaying = s.phase === 'playing' || s.phase === 'counting';
    // A new Play resumes a paused Follow (the user asked to hear it from somewhere).
    if (isPlaying && !(lastPhase === 'playing' || lastPhase === 'counting' || lastPhase === 'paused') && followPaused) resumeFollow();
    lastPhase = s.phase;
    placeLines();
    scheduleDraw();
  }

  // The map (grid, ruler, snapping), the load (duration, peaks).
  let knownDuration = duration();
  offs.push(effect(() => {
    session.position?.revision?.value;
    session.position?.mapped?.value;
    session.load?.value?.phase;
    if (destroyed) return;
    untracked(onStructure);
  }));
  function onStructure() {
    const d = duration();
    if (Math.abs(d - knownDuration) > EPS || !(view.span > 0)) {
      const wasFit = !(view.span > 0) || view.span >= knownDuration - 1e-3;
      knownDuration = d;
      const keepAt = view.span > 0 ? view.t0 + view.span * FOLLOW_LINE : position();
      view = wasFit && !finite(prefs.get?.('stems.zoom')) ? clampView({t0: 0, span: d}, d) : restoredView(keepAt);
      writeViewport();
    }
    changed();
  }

  // Prefs changed elsewhere (Settings, another tab).
  if (prefs.value && typeof prefs.value.subscribe === 'function') {
    offs.push(prefs.value.subscribe((p) => {
      const s = p?.stems;
      if (!s || destroyed) return;
      let dirty = false;
      if (GRID_CHOICES.includes(s.grid) && s.grid !== grid) { grid = s.grid; if (grid !== 'off') lastDivision = grid; dirty = true; }
      if (typeof s.snap === 'boolean' && s.snap !== snapOn) { snapOn = s.snap; dirty = true; }
      if (typeof s.follow === 'boolean' && s.follow !== followOn) { followOn = s.follow; followPaused = false; dirty = true; }
      if (dirty) changed();
    }));
  }

  // Size.
  const RO = win?.ResizeObserver;
  if (typeof RO === 'function') {
    const ro = new RO(() => { if (!destroyed) draw(); });
    ro.observe(lanes);
    offs.push(() => ro.disconnect());
  }
  // Theme or place changes re-read the canvas colours.
  const onTheme = () => scheduleDraw();
  win?.addEventListener?.('woodshed:theme', onTheme);
  win?.addEventListener?.('woodshed:place', onTheme);
  offs.push(() => {
    win?.removeEventListener?.('woodshed:theme', onTheme);
    win?.removeEventListener?.('woodshed:place', onTheme);
  });

  // The opening window: the device's zoom around the cue (the Stage then reveals its anchor).
  view = restoredView(snapshot().loop?.on ? snapshot().loop.a : snapshot().cue ?? 0);
  writeViewport();
  renderToolbar();
  draw();

  // ---------------------------------------------------------------- the Surface
  return {
    el: root,
    kind: 'stems',
    viewport,
    /** 60 Hz from the Stage's frame bus: the playhead, and Follow while playing. */
    frame(f) {
      if (destroyed || !f) return;
      const pos = finite(f.position) ? f.position : position();
      const isPlaying = !!(f.playing || f.counting);
      if (isPlaying !== playing) { playing = isPlaying; root.toggleAttribute('data-playing', playing); handles.update(); }
      if (playing && followOn && !followPaused && view.span > 0 && (pos < view.t0 || pos > view.t0 + view.span * FOLLOW_EDGE)) {
        if (setView({t0: pos - view.span * FOLLOW_LINE, span: view.span})) {
          if (drawQueued != null) { caf(drawQueued); drawQueued = null; }
          draw();
        }
      }
      placeLines(pos);
    },
    setLoop(range) {
      loop = range && finite(range.a) && finite(range.b) && range.b > range.a ? {a: range.a, b: range.b} : null;
      if (!loopDrag) handles.set(loop);
      registry.invalidate?.();
    },
    setGlass(on) {
      playing = !!on;
      root.toggleAttribute('data-playing', playing);
      handles.update();
    },
    setFollow(on) {
      if (on) resumeFollow({notify: false});
      else if (followOn && !followPaused) { followPaused = true; changed({draw: false}); }
    },
    reveal(t) { reveal(t); },
    anchor() {
      const p = position();
      const time = finite(p) && p >= view.t0 && p <= t1Of() ? p : view.t0 + view.span * FOLLOW_LINE;
      const out = {time};
      if (mapped() && map.bars?.length) out.bar = Math.max(0, map.barIndexAt(time));
      return out;
    },
    zoom(dir) { if (dir < 0) zoomOut(); else zoomIn(); },
    setLayout(layout) { root.dataset.layout = layout ?? ''; applyCompact(); scheduleDraw(); },
    setDistance() { scheduleDraw(); },
    /** The visible window (tests and harnesses). */
    get view() { return {t0: view.t0, t1: t1Of(), span: view.span}; },
    get following() { return followOn && !followPaused; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      saveZoom();
      if (drawQueued != null) { caf(drawQueued); drawQueued = null; }
      gridMenu?.close?.();
      endDrag({commit: false});
      for (const off of offs.splice(0).reverse()) { try { off?.(); } catch (err) { console.error('[stems] cleanup failed', err); } }
      handles.destroy();
      for (const row of rows.values()) { row.mute.destroy(); row.solo.destroy(); row.fader.destroy?.(); row.kbd?.destroy?.(); }
      rows.clear();
      for (const b of buttons) b.destroy();
      const at = live.indexOf(self);
      if (at >= 0) live.splice(at, 1);
      if (scoped) { scoped = false; if (!activeSurface()) setScope(null); }
      releaseCommands();
      registry.invalidate?.();
      root.remove();
    },
  };
}

export default createStemsSurface;
