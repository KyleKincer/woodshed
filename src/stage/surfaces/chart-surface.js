// The Chart surface (architecture §2.14.12, spec §4.4A, §4.9, §4.11): the drum part's alphaTab
// chart (src/js/notation/chart.js, loaded lazily) inside the Stage's music area, on the Stage's
// dark tokens. The chart only draws, follows and reports; this module owns everything around it:
//
// - Size: the scale is the Distance default for the layout (layout.js chartScale: rail 1.1/1.3/1.6,
//   band 1.0/1.2/1.5) unless this device pinched or stepped it at the current Distance
//   (prefs.chart.pinchScale, written with prefs.chart.pinchDistance: a pinch made at another
//   Distance is ignored, wherever that Distance was changed, and applies again on going back).
//   The label floors are 14 × d and 20 × d px. Dense parts (more than DENSE_HITS hits per notated
//   bar) are engraved 2 bars per system on the band and 4 on the rail.
// - D54 (R1): while the last two size changes took ≤ 300 ms a Distance change or a =/− step relayouts
//   at once; otherwise it applies once, on release (commitSize(), e.g. the Distance menu closing) or
//   400 ms after the last step, with the status "Resizing…". A size change (scale, label floors and
//   bars per system) is one chart.configure call, so one relayout; any further relayout reported
//   within BATCH_IDLE_MS of it is summed into the same sample and counted in data-relayouts.
// - Pinch (src/stage/pinch.js, 80–200 %): a CSS preview while the fingers move, one relayout on
//   release. ⌘/Ctrl-wheel is the same gesture for a trackpad or mouse, refused while playing
//   (glass.pressPolicy 'pinch').
// - Glass: the chart's taps, double-taps, long-presses and right-clicks reach the Stage through
//   onActivate (the Stage applies glass.pressPolicy: the pill, the jump, the bar menu). Loop drags
//   come back as onLoopEdit, and every commit is answered with setLoopRange from the transport.
//   press.js gives the surface its keyboard menu paths (Shift+F10, the ContextMenu key): the bar
//   menu for the focused bar of the bar list, else the playing bar. Presses on the score itself
//   are the chart's ([data-press-ignore]).
// - Follow: a manual scroll pauses it (the chart reports it); "⤓ Back to playhead" (56 px, bottom
//   centre) resumes it, as do Play and Again (the transport's gesture event), F (the Stage's
//   resumeFollow → setFollow) and, while playing, 8 s without touching the music. The scroll
//   anchor is 0.28 on the band and 0.33 on the rail; the style (Scroll · Page) and the Display
//   (Together · Hands & feet) are this device's (stage.followStyle, stage.display).
// - The accessible bar list ([role=listbox], scope stage.bars, D45): ←/→ move, Home/End, Enter
//   plays the bar (focus.play), L loops it (focus.loop), the menu keys open its bar menu.
// - States: "Opening the drum chart…" until the part answers, the part's open error with Try
//   again, and the chart's own empty states (owner: Find a chart · Import a file · Write one;
//   shared: "No drum chart was shared.").
//
//   createChartSurface(host, opts) → Promise<Surface & {setLayout(l), setDistance(d), commitSize()}>
//     opts: {session, stage, layout, distance, onActivate, onLoopEdit, onFollowChange, status,
//            registry?, router?, prefs?}   (registry, router and prefs default to the app's)
//   The chart's scroller is the surface's [data-scroller] (stage.scrollUp/Down/Top use it).
//   Root attributes for tests: data-state (opening | error | chart), data-following, data-relayout-ms
//   (the last size change's cost in ms, the sum of the chart's timings of its relayouts, as D54
//   samples it) and data-relayouts (how many relayouts that change took).

import '../../styles/views/stage/surface-chart.css';
import {registry as appRegistry} from '../../app/commands.js';
import {prefs as appPrefs} from '../../app/prefs.js';
import {h} from '../../ui/h.js';
import {Button} from '../../ui/button.js';
import {DISTANCE, chartScale, distanceOf} from '../layout.js';
import {pressPolicy} from '../glass.js';
import {createPressRecognizer} from '../press.js';
import {createPinch} from '../pinch.js';
import {musicalStarts, number, toTime} from '../../../shared/notation.ts';

/** The chart module, loaded on first use (alphaTab is heavy). */
const loadChartModule = () => import('../../js/notation/chart.js');

/** Follow resumes after this long without touching the music while playing (spec §4.9). */
export const IDLE_RESUME_MS = 8000;
/** D54: the live-relayout budget and the settle delay of a deferred size change. */
export const LIVE_RELAYOUT_MS = 300;
export const SETTLE_MS = 400;
/** A size change's sample stays open this long after its last relayout report (later ones are summed in). */
const BATCH_IDLE_MS = 1000;
/** A part is dense above this many hits per notated bar (maps/notation.md §11.1). */
export const DENSE_HITS = 8;
/** Bars per system for dense parts (spec §4.4A): 2 on the band (iPad portrait), 4 on the rail. */
export const DENSE_BARS = Object.freeze({band: 2, rail: 4});
/** The Scroll follow line (spec §4.4A). */
export const FOLLOW_ANCHOR = Object.freeze({band: 0.28, rail: 0.33});
/** The pinch range (spec §4.9). */
export const PINCH_MIN = 0.8;
export const PINCH_MAX = 2;
/** On-screen label floors at Distance 1 (spec §4.4A); multiplied by the Distance factor. */
export const LABEL_FLOORS = Object.freeze({barNumber: 14, marker: 20});
const BAR_KEYS = 'ArrowLeft ArrowRight Home End';

/** Copy (spec §4.4A, §4.9, D54). The chart's own empty-state copy is chart.js's COPY. */
export const COPY = Object.freeze({
  followResume: 'Back to playhead',
  resizing: 'Resizing…',
  opening: 'Opening the drum chart…',
  openFailed: 'Couldn’t open the drum chart.',
  tryAgain: 'Try again',
  bars: 'Bars',
  barHint: '← → move · Enter plays · L loops',
  pickup: 'Pickup',
  barName: (display) => (display == null ? 'Pickup' : `Bar ${display}`),
  barOption: ({display, section}) => [display == null ? 'Pickup' : `Bar ${display}`, section].filter(Boolean).join(' · '),
});

/** The surface's own controls (§9.0): role, accessible name and the command each runs, if any. */
export const CONTROLS = Object.freeze([
  Object.freeze({role: 'button', name: COPY.followResume}),
  Object.freeze({role: 'listbox', name: COPY.bars}),
  Object.freeze({role: 'button', name: COPY.tryAgain}),
  Object.freeze({role: 'button', name: 'Find a chart', command: 'map.find'}),
  Object.freeze({role: 'button', name: 'Import a file'}),
  Object.freeze({role: 'button', name: 'Write one', command: 'edit.chart'}),
]);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const peek = (v) => (v && typeof v.peek === 'function' ? v.peek() : v?.value ?? v ?? null);
const noop = () => {};

// ---------------------------------------------------------------------------------------------
// Pure rules (dimensions and data as inputs, §0.1)

/** True when the part averages more than DENSE_HITS hits per bar that has any. */
export function isDense(score) {
  const bars = Array.isArray(score?.bars) ? score.bars.filter((b) => b?.hits?.length) : [];
  if (!bars.length) return false;
  return bars.reduce((n, b) => n + b.hits.length, 0) / bars.length > DENSE_HITS;
}

/** Bars per system: 2 (band) or 4 (rail) for a dense part, else -1 (alphaTab fits them to the width). */
export function barsPerSystem({dense, layout}) {
  return dense ? DENSE_BARS[layout === 'rail' ? 'rail' : 'band'] : -1;
}

/** The Scroll follow line for a layout. */
export const followAnchorFor = (layout) => FOLLOW_ANCHOR[layout === 'rail' ? 'rail' : 'band'];

/** The on-screen label floors for a Distance: {barNumber: 14 × d, marker: 20 × d}. */
export function fontsFor(distance) {
  const d = DISTANCE[distanceOf(distance)];
  return {barNumber: LABEL_FLOORS.barNumber * d, marker: LABEL_FLOORS.marker * d};
}

/**
 * The scale: this device's pinch override when it was made at this Distance (pinchDistance), else
 * the Distance default for the layout. A pinch made at another Distance, or with none recorded, is ignored.
 */
export function scaleFor({distance, layout, pinch, pinchDistance}) {
  if (pinchDistance === distanceOf(distance) && finite(pinch) && pinch > 0) return Math.min(PINCH_MAX, Math.max(PINCH_MIN, pinch));
  return chartScale({distance, layout});
}

/**
 * D54's adaptive gate. `record(ms)` takes each size change's time; `request(apply)` runs `apply` at
 * once while the last two relayouts took ≤ limitMs (or fewer than two were measured, and those
 * were fast), else once, settleMs after the last request, and returns 'now' or 'deferred'.
 */
export function createRelayoutGate({limitMs = LIVE_RELAYOUT_MS, settleMs = SETTLE_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id)} = {}) {
  const samples = [];
  let pending = null;
  const cancel = () => { if (pending) { clearTimer(pending.id); pending = null; } };
  return {
    /** With `replace`, the latest sample is revised (a size change that relayouted again). */
    record(ms, {replace = false} = {}) {
      if (!finite(ms)) return;
      if (replace && samples.length) { samples[samples.length - 1] = ms; return; }
      samples.push(ms);
      if (samples.length > 2) samples.shift();
    },
    get live() { return samples.every((ms) => ms <= limitMs); },
    get pending() { return !!pending; },
    get samples() { return [...samples]; },
    request(apply) {
      if (this.live) { cancel(); apply(); return 'now'; }
      cancel();
      const entry = {id: null, apply};
      entry.id = setTimer(() => { if (pending === entry) pending = null; apply(); }, settleMs);
      pending = entry;
      return 'deferred';
    },
    /** Release (D54: the menu closed): a deferred change applies now; true when one did. */
    flush() {
      if (!pending) return false;
      const {apply} = pending;
      cancel();
      apply();
      return true;
    },
    cancel,
  };
}

// ---------------------------------------------------------------------------------------------
// The surface

export async function createChartSurface(host, opts = {}) {
  const {session} = opts;
  if (!session) throw new TypeError('createChartSurface: session is required');
  const stage = opts.stage ?? null;
  const registry = opts.registry ?? appRegistry;
  const prefs = opts.prefs ?? appPrefs;
  const onActivate = opts.onActivate ?? noop;
  const onLoopEdit = opts.onLoopEdit ?? noop;
  const onFollowChange = opts.onFollowChange ?? noop;
  const status = opts.status ?? noop;
  const transport = session.transport;
  const notation = session.notation ?? null;
  const map = session.map;

  let layout = (opts.layout ?? peek(stage?.layout)) === 'rail' ? 'rail' : 'band';
  let distance = distanceOf(opts.distance ?? peek(stage?.distance));
  let destroyed = false;
  let following = true;
  let idleTimer = null;
  let lastReveal = null;
  let chart = null;
  let pinch = null;
  let retryButton = null;
  let retrying = false;
  let onPill = noop;
  const offs = [];
  const cleanup = (fn) => { if (typeof fn === 'function') offs.push(fn); };

  // ---------------- DOM ----------------
  const chartHost = h('div', {class: 'chart-surface-chart'});
  const noteText = h('p', {class: 'chart-surface-note-text'});
  const noteActions = h('div', {class: 'chart-surface-note-actions'});
  const note = h('div', {class: 'chart-surface-note', hidden: true}, noteText, noteActions);
  // The active option is announced through aria-activedescendant; the listbox is the pointer-free target.
  const option = h('div', {class: 'chart-bars-option', role: 'option', id: uniqueId('chart-bar'), attrs: {'aria-selected': 'true', 'data-target-exempt': '', 'data-structure-allow': 'clip'}});
  const barsCard = h('div', {class: 'chart-bars-card', attrs: {'aria-hidden': 'true'}},
    h('span', {class: 'chart-bars-card-name'}), h('span', {class: 'chart-bars-card-hint'}, COPY.barHint));
  const barList = h('div', {
    class: 'chart-bars', role: 'listbox', tabIndex: 0, hidden: true,
    attrs: {'aria-label': COPY.bars, 'aria-activedescendant': option.id, 'data-scope': 'stage.bars', 'data-consume-keys': BAR_KEYS},
  }, option, barsCard);
  const pill = Button({label: COPY.followResume, icon: 'arrow-down-to-line', variant: 'primary', kbd: 'KeyF',
    className: 'chart-surface-follow-pill', onClick: () => onPill()});
  const pillHost = h('div', {class: 'chart-surface-follow', hidden: true}, pill.el);
  const root = h('div', {class: 'chart-surface', dataset: {state: 'opening', following: ''}}, chartHost, note, pillHost);
  host.append(root);
  try {
    return await build();
  } catch (err) {
    // The Stage shows its own fallback in this layer: nothing half-built may stay in front of it.
    destroyed = true;
    for (const off of offs.splice(0).reverse()) { try { off(); } catch { /* best effort */ } }
    try { chart?.destroy(); } catch { /* best effort */ }
    pill.destroy();
    root.remove();
    throw err;
  }

  async function build() {
    // ---------------- the part, as the chart reads it ----------------
    // The notation session opens the part lazily; the chart sees one stable object whose subscribers
    // hear the part changing, the part opening and the notation flag flipping.
    const partListeners = new Set();
    let partOff = null, partSeen = null;
    const notifyPart = () => {
      updateDensity();
      for (const fn of [...partListeners]) { try { fn(); } catch (err) { console.error('[chart-surface] part listener failed', err); } }
    };
    function watchPart() {
      const part = notation?.part ?? null;
      if (part === partSeen) return;
      partOff?.();
      partOff = null;
      partSeen = part;
      if (part && typeof part.subscribe === 'function') partOff = part.subscribe(() => notifyPart());
    }
    cleanup(() => partOff?.());
    const partView = {
      get score() { return notation?.part?.score ?? null; },
      get hasNotation() { return !!notation?.part?.hasNotation; },
      get readOnly() { return !!session.readOnly || !!notation?.part?.readOnly; },
      subscribe(fn) { partListeners.add(fn); return () => partListeners.delete(fn); },
    };

    // ---------------- size ----------------
    const pinchPref = () => { const v = Number(prefs.get('chart.pinchScale')); return Number.isFinite(v) && v > 0 ? v : null; };
    const targetScale = () => scaleFor({distance, layout, pinch: pinchPref(), pinchDistance: prefs.get('chart.pinchDistance')});
    /** A pinch or =/− step: this device's override, for the Distance it was made at. */
    const writePinch = (value) => prefs.update((d) => { d.chart.pinchScale = value; d.chart.pinchDistance = distance; });
    let dense = isDense(partView.score);
    const gate = createRelayoutGate();

    const chartModule = await loadChartModule();
    // The Stage forwards layout and Distance changes only to the surface on screen: one made while
    // the chart module loaded (an iPad rotated during the first open) is read here.
    const liveLayout = peek(stage?.layout);
    if (liveLayout != null) layout = liveLayout === 'rail' ? 'rail' : 'band';
    const liveDistance = peek(stage?.distance);
    if (liveDistance != null) distance = distanceOf(liveDistance);
    chart = chartModule.createChart({
      host: chartHost, part: partView, engine: session.engine,
      scale: targetScale(),
      display: {barsPerRow: barsPerSystem({dense, layout})},
      followStyle: followStyleNow(),
      followAnchor: followAnchorFor(layout),
      glass: isPlaying(),
      fonts: fontsFor(distance),
      onBarActivate: (e) => activate(e),
      onLoopEdit: (e) => loopEdit(e),
      onFollowChange: (on) => followChanged(on),
      onStatus: (text) => status(text),
      onRelayout: ({ms}) => reportRelayout(ms),
      onEmpty: emptyActions(),
    });
    const scroller = chartHost.querySelector('.chart-scroll');
    scroller?.setAttribute('data-scroller', '');
    // The bar list rides at the top of the scroller (sticky), so the scrolling score has keyboard access.
    scroller?.prepend(barList);
    // Presses on the score are the chart's own recogniser; press.js handles everything else.
    chartHost.querySelector('.chart-score')?.setAttribute('data-press-ignore', '');

    function followStyleNow() {
      const style = peek(stage?.followStyle);
      return style === 'scroll' || style === 'page' ? style : layout === 'rail' ? 'scroll' : 'page';
    }

    function updateDensity() {
      const next = isDense(partView.score);
      if (next === dense) return;
      dense = next;
      closeChange();
      chart?.setDisplay?.({barsPerRow: barsPerSystem({dense, layout})});
    }

    // ---------------- D54 samples: one size change, and every relayout it takes ----------------
    // A change is open from its first relayout report until BATCH_IDLE_MS pass without another, or
    // the next change starts: a relayout reported inside it is summed into its sample (the gate's
    // latest) and counted, so data-relayouts shows a change that engraved more than once.
    let change = null;   // {count, sum, timer}
    function showCost(ms, count) {
      // Like data-rendered, test-visible facts for the R1 state: the change's cost and its relayouts.
      root.dataset.relayoutMs = String(Math.round(ms * 10) / 10);
      root.dataset.relayouts = String(count);
    }
    function closeChange() {
      if (change) clearTimeout(change.timer);
      change = null;
    }
    function reportRelayout(ms) {
      if (!finite(ms) || destroyed) return;
      const first = !change;
      if (first) change = {count: 0, sum: 0, timer: null};
      change.sum += ms;
      change.count += 1;
      gate.record(change.sum, {replace: !first});
      showCost(change.sum, change.count);
      clearTimeout(change.timer);
      change.timer = setTimeout(closeChange, BATCH_IDLE_MS);
    }
    cleanup(closeChange);

    /**
     * Applies the current target size (scale, label floors and bars per system) in one
     * chart.configure call: one relayout when any of them changed, sampled for D54 as one change.
     */
    function applySize() {
      if (destroyed) return;
      closeChange();
      chart.configure({scale: targetScale(), fonts: fontsFor(distance), barsPerRow: barsPerSystem({dense, layout})}, {anchor: true});
      pinch?.setBase(chart.state.scale);
    }
    /** A stepped or menu size change (Distance, =/−): live or on release, per D54. */
    function requestSize() {
      if (gate.request(applySize) === 'deferred') status(COPY.resizing, {key: 'chart-resize'});
    }

    // ---------------- transport state ----------------
    function isPlaying() {
      const phase = transport?.snapshot?.peek?.()?.phase;
      return phase === 'playing' || phase === 'counting';
    }
    const positionNow = () => { const p = Number(transport?.position?.()); return Number.isFinite(p) ? p : 0; };
    function loopNow() {
      const loop = transport?.snapshot?.peek?.()?.loop;
      return loop?.on && finite(loop.a) && finite(loop.b) && loop.b > loop.a ? {a: loop.a, b: loop.b} : null;
    }
    // While stopped the frame bus idles: cue changes still move the playhead.
    if (transport?.snapshot?.subscribe) {
      cleanup(transport.snapshot.subscribe((snap) => {
        if (snap?.phase !== 'playing' && snap?.phase !== 'counting') chart.tick(positionNow());
      }));
    }
    // Play and Again (any source: keys, pedals, the dock) bring Follow back.
    if (typeof transport?.on === 'function') cleanup(transport.on('gesture', () => { if (!following) resumeFollow(); }));

    // ---------------- glass: the chart's gestures ----------------
    function barAt(t) {
      if (!map?.isReal || !map.bars?.length) return null;
      return map.bars[map.barIndexAt(t)] ?? null;
    }
    function activate(e) {
      if (!e || !finite(e.time)) return;
      onActivate({kind: e.kind, t: e.time, bar: barAt(e.time)?.display ?? undefined, beatTime: e.beatTime, index: e.index,
        pointerType: e.pointerType, clientX: e.clientX, clientY: e.clientY});
    }
    function loopEdit(e) {
      onLoopEdit(e);
      if (e?.phase !== 'commit') return;
      // Answer every commit with the transport's loop (the chart reverts after 1 s otherwise).
      queueMicrotask(() => { if (!destroyed) chart.setLoopRange(loopNow()); });
    }

    // Keyboard menus (Shift+F10, ContextMenu): the focused bar of the bar list, else the playing bar.
    const offPress = createPressRecognizer(root, {
      haptic: noop, touchAction: null,
      onLongStart: () => false,
      onMenu: (e) => {
        if (!e.keyboard) return;   // pointer menus on the score are the chart's ('context', 'long')
        // The menu keys on the surface's own buttons (Try again, the empty-state actions, the pill) are not a bar's.
        if (!barList.contains(e.target) && e.target?.closest?.('button, a[href], input, select, textarea, [role=button], .chart-empty, .chart-surface-note, .chart-surface-follow')) return;
        const index = barList.contains(e.target) && roving >= 0 ? roving : barIndexAt(positionNow());
        const bar = bars()[index];
        const t = bar ? bar.t0 : positionNow();
        onActivate({kind: 'context', t, bar: bar?.display ?? undefined, beatTime: t, index, pointerType: 'mouse',
          clientX: e.clientX, clientY: e.clientY, keyboard: true});
      },
    });
    cleanup(offPress);

    // ---------------- pinch (spec §4.9: 80–200 %, one relayout on release) ----------------
    pinch = createPinch(root, {
      base: chart.state.scale, min: PINCH_MIN, max: PINCH_MAX,
      shouldStart: ({source}) => pressPolicy({pointerType: source === 'wheel' ? 'mouse' : 'touch', playing: isPlaying(), gesture: 'pinch'}) === 'zoom',
      onPreview: (g) => chart.previewScale(g.factor, {clientX: g.cx, clientY: g.cy}),
      onCommit: (g) => {
        chart.previewScale(null);
        writePinch(Math.round(g.value * 100) / 100);
        // The pinch replaces a deferred step, but not the Distance's label floors that step held.
        gate.cancel();
        applySize();
      },
      onCancel: () => chart.previewScale(null),
    });
    cleanup(() => pinch.destroy());
    // A refused ⌘/Ctrl-wheel (a mouse while playing) does nothing, rather than zooming the page.
    const onWheel = (e) => {
      if ((e.ctrlKey || e.metaKey) && !pinch.active && pressPolicy({pointerType: 'mouse', playing: isPlaying(), gesture: 'pinch'}) === 'none') e.preventDefault();
    };
    root.addEventListener('wheel', onWheel, {passive: false});
    cleanup(() => root.removeEventListener('wheel', onWheel));

    // ---------------- follow ----------------
    function clearIdle() { if (idleTimer != null) { clearTimeout(idleTimer); idleTimer = null; } }
    function armIdle() {
      clearIdle();
      if (following || destroyed || !isPlaying()) return;
      idleTimer = setTimeout(() => { idleTimer = null; if (!following && isPlaying()) resumeFollow(); }, IDLE_RESUME_MS);
    }
    function followChanged(on) {
      following = !!on;
      if (following) root.dataset.following = ''; else delete root.dataset.following;
      pillHost.hidden = following || !partView.hasNotation;
      if (following) clearIdle(); else armIdle();
      onFollowChange(following);
    }
    function resumeFollow() {
      chart.setFollow(true);
      if (!following) followChanged(true);
    }
    onPill = resumeFollow;
    // Touching the music restarts the idle wait.
    const onActivity = () => { if (!following) armIdle(); };
    for (const type of ['wheel', 'pointerdown', 'touchmove', 'keydown']) root.addEventListener(type, onActivity, {passive: true});
    scroller?.addEventListener('scroll', onActivity, {passive: true});
    cleanup(() => {
      for (const type of ['wheel', 'pointerdown', 'touchmove', 'keydown']) root.removeEventListener(type, onActivity);
      scroller?.removeEventListener('scroll', onActivity);
      clearIdle();
    });

    // ---------------- the bar list (stage.bars, D45) ----------------
    let roving = -1;
    let offFocused = null;
    const bars = () => (map?.isReal ? map.bars ?? [] : []);
    function barIndexAt(t) { return map?.isReal && bars().length ? map.barIndexAt(t) : 0; }
    function sectionOf(bar) { return map?.hasSections ? map.sectionAt(bar.t0)?.name ?? null : null; }
    function focusedItem() {
      const bar = bars()[roving];
      if (roving < 0 || !bar) return null;
      return {kind: 'bar', t0: bar.t0, t1: bar.t1, label: COPY.barName(bar.display), bar: bar.display ?? undefined, index: roving};
    }
    function renderRoving() {
      const list = bars();
      const bar = list[roving];
      if (!bar) { option.textContent = ''; barsCard.firstChild.textContent = ''; return; }
      const text = COPY.barOption({display: bar.display, section: sectionOf(bar)});
      option.textContent = text;
      option.setAttribute('aria-posinset', String(roving + 1));
      option.setAttribute('aria-setsize', String(list.length));
      barsCard.firstChild.textContent = text;
    }
    function moveRoving(index, {reveal: show = true} = {}) {
      const list = bars();
      if (!list.length) return;
      roving = Math.max(0, Math.min(list.length - 1, index));
      renderRoving();
      if (show) {
        // The reader is looking elsewhere: Follow pauses, as for a manual scroll.
        chart.setFollow(false);
        if (following) followChanged(false);
        chart.reveal(list[roving].t0, {smooth: true});
      }
      registry.invalidate?.();
    }
    const onBarsFocus = () => {
      // Each visit starts at the playing bar (or the cue), like the strip.
      moveRoving(barIndexAt(positionNow()), {reveal: false});
      if (!offFocused) offFocused = registry.provide('focused', () => focusedItem());
    };
    const onBarsBlur = () => {
      offFocused?.();
      offFocused = null;
      registry.invalidate?.();
    };
    const onBarsKey = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const last = bars().length - 1;
      let next = null;
      if (e.key === 'ArrowRight') next = roving + 1;
      else if (e.key === 'ArrowLeft') next = roving - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = last;
      if (next === null || last < 0) return;
      e.preventDefault();
      moveRoving(next);
    };
    barList.addEventListener('focus', onBarsFocus);
    barList.addEventListener('blur', onBarsBlur);
    barList.addEventListener('keydown', onBarsKey);
    cleanup(() => {
      barList.removeEventListener('focus', onBarsFocus);
      barList.removeEventListener('blur', onBarsBlur);
      barList.removeEventListener('keydown', onBarsKey);
      offFocused?.();
      offFocused = null;
    });

    // ---------------- states: opening, error, chart ----------------
    let ready = !notation || !needsOpening();
    function needsOpening() { return !!session.song?.peek?.()?.hasChart && !notation?.part; }
    function renderState() {
      if (destroyed) return;
      watchPart();
      const error = peek(notation?.error);
      const kind = notation?.part ? 'chart' : retrying || !ready ? 'opening' : error ? 'error' : 'chart';
      root.dataset.state = kind;
      note.hidden = kind === 'chart';
      if (kind === 'opening') root.setAttribute('aria-busy', 'true'); else root.removeAttribute('aria-busy');
      noteActions.replaceChildren();
      retryButton?.destroy();
      retryButton = null;
      if (kind === 'opening') noteText.textContent = COPY.opening;
      if (kind === 'error') {
        noteText.textContent = COPY.openFailed;
        retryButton = Button({label: COPY.tryAgain, variant: 'primary', onClick: () => retryOpen()});
        noteActions.append(retryButton.el);
      }
      const showChart = kind === 'chart';
      chart.setVisible(showChart);
      barList.hidden = !showChart || !partView.hasNotation || !bars().length;
      // The option always names a bar, so the listbox reads well before it is first focused.
      if (!barList.hidden && root.ownerDocument.activeElement !== barList) { roving = barIndexAt(positionNow()); renderRoving(); }
      pillHost.hidden = following || !partView.hasNotation;
    }
    /** Try again after the part failed to open: "Opening…" until it settles. */
    function retryOpen() {
      if (retrying || !notation?.open) return;
      retrying = true;
      renderState();
      Promise.resolve().then(() => notation.open()).catch(() => {}).finally(() => {
        retrying = false;
        if (destroyed) return;
        renderState();
        notifyPart();
      });
    }
    cleanup(() => retryButton?.destroy());
    if (notation?.hasNotation?.subscribe) cleanup(notation.hasNotation.subscribe(() => { renderState(); notifyPart(); }));
    if (notation?.error?.subscribe) cleanup(notation.error.subscribe(() => renderState()));
    Promise.resolve(notation?.ready).then(() => {
      if (destroyed) return;
      ready = true;
      renderState();
      notifyPart();
    }, () => { if (!destroyed) { ready = true; renderState(); } });

    // ---------------- device prefs from the Stage: Display and Follow style ----------------
    if (stage?.display?.subscribe) cleanup(stage.display.subscribe((value) => { closeChange(); chart.setDisplay({layout: value ?? null}); }));
    if (stage?.followStyle?.subscribe) {
      cleanup(stage.followStyle.subscribe(() => {
        // A layout switch changes the style first (the Stage's batch); setLayout then moves the line once.
        const live = peek(stage.layout);
        if (live != null && (live === 'rail' ? 'rail' : 'band') !== layout) return;
        chart.setFollowStyle(followStyleNow(), {anchor: followAnchorFor(layout)});
      }));
    }

    // ---------------- empty-state actions (spec §5.4) ----------------
    function emptyActions() {
      if (session.readOnly) return {};
      const actions = {};
      const run = (id) => () => { registry.run(id, {source: 'pointer'}); };
      if (registry.get?.('map.find')) actions.findChart = run('map.find');
      const router = opts.router ?? registry.context?.()?.router ?? null;
      if (router?.navigate) {
        actions.importFile = () => router.navigate(`/s/${encodeURIComponent(session.id)}/edit/map/find?import=1`);
      }
      if (registry.get?.('edit.chart')) actions.write = run('edit.chart');
      return actions;
    }

    renderState();
    chart.setLoopRange(loopNow());
    chart.tick(positionNow());

    // ---------------- the Surface ----------------
    const surface = {
      el: root,
      kind: 'chart',
      frame(f) { if (finite(f?.position)) chart.tick(f.position); },
      setLoop(range) {
        chart.setLoopRange(range && finite(range.a) && finite(range.b) && range.b > range.a ? {a: range.a, b: range.b} : null);
      },
      setGlass(playing) {
        chart.setGlass(!!playing);
        // The Stage calls this on every transport change: a running idle wait is kept, not restarted.
        if (!playing) clearIdle();
        else if (idleTimer == null) armIdle();
      },
      setFollow(on) {
        chart.setFollow(!!on);
        if (!!on !== following) followChanged(!!on);
      },
      reveal(t, {smooth = false} = {}) {
        if (!finite(t)) return;
        lastReveal = t;
        chart.reveal(t, {smooth});
      },
      anchor() {
        if (!partView.hasNotation || !chart.state.revision) return {time: finite(lastReveal) ? lastReveal : positionNow()};
        const index = chart.anchorBar();
        const time = barTime(index);
        return finite(time) ? {bar: index, time} : {time: finite(lastReveal) ? lastReveal : positionNow()};
      },
      zoom(dir) {
        const step = chartModule.stepScale(targetScale(), dir < 0 ? -1 : 1);
        writePinch(step);
        requestSize();
      },
      setDistance(d) {
        const next = distanceOf(d);
        if (next === distance) return;
        distance = next;   // a pinch made at another Distance stops applying (scaleFor); it is kept for its own
        requestSize();
      },
      setLayout(l) {
        const next = l === 'rail' ? 'rail' : 'band';
        if (next === layout) return;
        layout = next;
        chart.setFollowStyle(followStyleNow(), {anchor: followAnchorFor(layout)});
        gate.cancel();
        applySize();   // bars per system, the floors of a deferred Distance and the scale, as one change
      },
      /** D54 release (the Distance menu closed): a deferred size change applies now. */
      commitSize() { if (!destroyed) gate.flush(); },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        gate.cancel();
        for (const off of offs.splice(0).reverse()) { try { off(); } catch (err) { console.error('[chart-surface] cleanup failed', err); } }
        pill.destroy();
        chart.destroy();
        root.remove();
      },
    };

    /** The start time of chart bar `index`: the map's bar when mapped, else the part's own timeline. */
    function barTime(index) {
      const bar = bars()[index];
      if (bar) return bar.t0;
      const timeline = partView.score?.timeline;
      if (!timeline) return null;
      const starts = musicalStarts(timeline);
      return starts[index] != null ? toTime(timeline, number(starts[index])) : null;
    }

    return surface;
  }
}

let idSeq = 0;
function uniqueId(prefix) { idSeq += 1; return `${prefix}-${idSeq}`; }

export default createChartSurface;
