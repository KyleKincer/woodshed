// The rehearsal chart: the drum part engraved like Guitar Pro or Songsterr and
// read while playing along (spec §4.4A, architecture §2.14.12). Chrome-less:
// no toolbar, chips, notice, hint or mute button. The chart surface
// (src/stage/surfaces/chart-surface.js) owns the rest of the Stage, so the
// chart only draws, follows and reports:
//   - gestures are emitted (onBarActivate, onLoopEdit) and never seek; the
//     surface applies the glass rules (spec §4.9) and the transport decides;
//   - the loop is pushed in (setLoopRange), never read from the engine;
//   - the playing position comes from tick(time), one rAF owned by the Stage;
//   - Follow pauses on any manual scroll (playing or stopped) and reports it.
// Device state (the Display layout) lives in prefs (src/app/prefs.js).
import {number, musicalStarts, toTime, toQuarter, beatGroups} from '../../../shared/notation.ts';
import {createScoreView} from './score-view.js';
import {prefs} from '../../app/prefs.js';
import {now} from '../../app/clock.js';
import {h} from '../../ui/h.js';
import '../../styles/views/notation/chart.css';

/** The `=` / `−` steps; they include every Distance default (§2.14.12). */
export const SCALE_STEPS = Object.freeze([0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.45, 1.6, 1.8, 2.0]);
export const SCALE_MIN = 0.8, SCALE_MAX = 2.0, DEFAULT_SCALE = 1.2;
/** On-screen label floors in px at Distance 1 (spec §4.4A): bar numbers 14, section labels 20. */
export const FONT_FLOORS = Object.freeze({barNumber: 14, marker: 20});
export const LONG_PRESS_MS = 350;      // D50
export const DOUBLE_TAP_MS = 300;
export const SLOP_PX = 8;              // tap vs drag, and the mouse drag threshold (spec §4.8)
export const FOLLOW_GUARD_MS = 900;    // manual scrolls this soon after a programmatic one do not pause Follow
export const PAGE_TURN_MS = 200;
export const COMMIT_HOLD_MS = 1000;    // a committed loop edit is drawn until setLoopRange answers
const LINE_SLOP_PX = 2;
const HAPTIC_MS = 8;
const LAYOUTS = ['combined', 'split'];

/** Copy (spec §4.4A, §5.4). */
export const COPY = Object.freeze({
  emptyTitle: 'No drum chart yet',
  sharedTitle: 'No drum chart was shared.',
  armHint: 'Drag across bars to loop them',
  chartLabel: bars => `Drum chart, ${bars} ${bars === 1 ? 'bar' : 'bars'}`,
});
/** The empty state's actions, in order (spec §5.4); each shows when its onEmpty handler exists. */
export const EMPTY_ACTIONS = Object.freeze([
  Object.freeze({key: 'findChart', role: 'button', name: 'Find a chart'}),
  Object.freeze({key: 'importFile', role: 'button', name: 'Import a file'}),
  Object.freeze({key: 'write', role: 'button', name: 'Write one'}),
]);

export const clampScale = value => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(value)));
/** The next scale step above (dir 1) or below (dir −1) `value`. */
export function stepScale(value, dir) {
  const v = clampScale(value);
  if (dir > 0) return SCALE_STEPS.find(s => s > v + 1e-6) ?? SCALE_MAX;
  return [...SCALE_STEPS].reverse().find(s => s < v - 1e-6) ?? SCALE_MIN;
}
/**
 * alphaTab label sizes (engraving px, multiplied by the scale) that keep the
 * on-screen floors: ceil(14 × d / scale) and ceil(20 × d / scale), where the
 * floors passed in already carry the Distance factor d.
 */
export function fontFloors(floors, scale) {
  const s = clampScale(scale);
  return {barNumber: Math.ceil(floors.barNumber / s - 1e-9), marker: Math.ceil(floors.marker / s - 1e-9)};
}

const noop = () => {};
const finite = value => typeof value === 'number' && Number.isFinite(value);
function readPref(path) { try { return prefs.get(path); } catch { return undefined; } }
function writePref(path, value) { try { if (prefs.get(path) !== value) prefs.set(path, value); } catch { /* storage unavailable: in memory only */ } }
function reducedMotion() { try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } }
const raf = fn => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(() => fn(now()), 16));
const caf = id => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

/**
 * @param options.host element the chart fills (the surface owns it)
 * @param options.part the session's drum part ({score, hasNotation, readOnly, subscribe})
 * @param options.engine read only for engine.getPosition() when tick() gets no time
 * @param options.scale engraving scale (the surface passes the Distance default or the pinch value)
 * @param options.display {layout, barsPerRow}; layout null = the part's own; omitted → prefs chart.display.layout
 * @param options.fonts on-screen label floors in px ({barNumber: 14 × d, marker: 20 × d})
 */
export function createChart({
  host, part, engine = null, scale = DEFAULT_SCALE, display, followStyle = 'scroll', followAnchor = 0.33,
  glass = false, fonts = FONT_FLOORS,
  onBarActivate = noop, onLoopEdit = noop, onFollowChange = noop, onStatus = noop, onRelayout = noop, onEmpty = {},
} = {}) {
  const initialLayout = display && 'layout' in display ? display.layout : readPref('chart.display.layout');
  const state = {
    scale: finite(Number(scale)) ? clampScale(scale) : DEFAULT_SCALE,
    layoutOverride: LAYOUTS.includes(initialLayout) ? initialLayout : null,
    barsPerRow: Number.isInteger(display?.barsPerRow) && display.barsPerRow > 0 ? display.barsPerRow : -1,
    floors: sanitizeFloors(fonts, FONT_FLOORS),
    followStyle: followStyle === 'page' ? 'page' : 'scroll',
    followAnchor: anchorValue(followAnchor, 0.33),
    glass: !!glass,
    follow: true,
    visible: false,
  };
  let view = null, renderedScore = null, renderedLayout = null, revision = 0, disposed = false;
  let lastQ = null, lastTime = null, lastSystem = null, relayoutStart = null, pendingAnchor = null, pendingReveal = null;
  let loopRange = null, pendingCommit = null, commitTimer = null;
  let gesture = null, lastTap = null, lastDoubleAt = -Infinity, lastTouchAt = -Infinity, programmaticAt = -Infinity, pageAnimation = null;
  let startsCache = {timeline: null, starts: []};

  host.classList.add('chart');
  host.hidden = true;
  host.dataset.rendered = 'false';
  if (state.glass) host.dataset.glass = '';
  const scoreHost = h('div', {class: 'chart-score', role: 'img', 'aria-label': COPY.chartLabel(0)});
  const scroller = h('div', {class: 'chart-scroll', tabIndex: -1}, scoreHost);
  const empty = h('div', {class: 'chart-empty', hidden: true});
  host.replaceChildren(scroller, empty);

  // ---------- musical helpers ----------
  const timeline = () => part?.score?.timeline ?? null;
  const layout = () => state.layoutOverride || part?.score?.layout || 'combined';
  function starts() {
    const t = timeline();
    if (startsCache.timeline !== t) startsCache = {timeline: t, starts: t ? musicalStarts(t).map(number) : []};
    return startsCache.starts;
  }
  const measures = () => timeline()?.measures ?? [];
  const barLength = i => number(measures()[i].length);
  const barStartQ = i => starts()[i];
  const barEndQ = i => starts()[i] + barLength(i);
  const extentQ = () => (measures().length ? barEndQ(measures().length - 1) : 0);
  const qToTime = q => toTime(timeline(), q);
  const timeToQ = t => toQuarter(timeline(), t);
  function barIndexAtQ(q) {
    const s = starts();
    let low = 0, high = s.length - 1, index = 0;
    while (low <= high) { const mid = (low + high) >> 1; if (s[mid] <= q + 1e-9) { index = mid; low = mid + 1; } else high = mid - 1; }
    return index;
  }
  /** Beat starts (absolute quarters) of bar i, grouping-aware (6/8 counts dotted quarters). */
  function beatsOf(i) {
    const m = measures()[i], unit = 4 / m.denominator, out = [];
    let q = barStartQ(i);
    for (const group of beatGroups(m)) { out.push(q); q += group * unit; }
    return out;
  }
  function beatFloor(q) {
    const i = barIndexAtQ(q);
    return beatsOf(i).filter(b => b <= q + 1e-9).at(-1) ?? barStartQ(i);
  }
  function beatAfter(q) {
    const i = barIndexAtQ(q);
    return beatsOf(i).find(b => b > q + 1e-9) ?? barEndQ(i);
  }
  /** The bar line (or, for 'beat', the beat line) nearest q. */
  function nearestLine(q, mode) {
    const i = barIndexAtQ(q), n = measures().length;
    const lines = [];
    for (let k = Math.max(0, i - 1); k <= Math.min(n - 1, i + 1); k++) {
      if (mode === 'beat') lines.push(...beatsOf(k)); else lines.push(barStartQ(k));
    }
    lines.push(extentQ());
    return lines.reduce((best, line) => (Math.abs(line - q) < Math.abs(best - q) ? line : best), lines[0]);
  }
  /** A loop edit in seconds, with bar ids when both ends sit on bar lines. */
  function loopEdit(qa, qb) {
    const edit = {a: qToTime(qa), b: qToTime(qb)};
    const s = starts(), ia = s.findIndex(v => Math.abs(v - qa) < 1e-6);
    const ib = measures().findIndex((m, i) => Math.abs(barEndQ(i) - qb) < 1e-6);
    if (ia >= 0 && ib >= 0) { edit.aBar = measures()[ia].id; edit.bBar = measures()[ib].id; }
    return edit;
  }
  const loopQ = () => {
    const r = pendingCommit ?? loopRange;
    return r && timeline() ? [timeToQ(r.a), timeToQ(r.b)] : null;
  };

  // ---------- engraving ----------
  const floorsNow = () => fontFloors(state.floors, state.scale);
  function beginRelayout(keepAnchor) {
    relayoutStart = now();
    host.setAttribute('aria-busy', 'true');
    if (keepAnchor && view?.ready && !pendingAnchor) pendingAnchor = captureAnchor();
  }
  function ensureView() {
    if (view) return;
    view = createScoreView(scoreHost, {scale: state.scale, barsPerRow: state.barsPerRow, fonts: floorsNow(), onRender: rendered, onPointer: pointer});
    view.setLoopHandles(true);
    const stage = view.stage;
    stage.addEventListener('contextmenu', onContextMenu);
    stage.addEventListener('dblclick', onDoubleClick);
    // After a touch long-press the finger draws a loop; it must not scroll (which would cancel the gesture).
    stage.addEventListener('touchmove', event => { if ((gesture?.armed || gesture?.mode === 'edge') && event.cancelable) event.preventDefault(); }, {passive: false});
  }
  function destroyView() {
    cancelGesture();
    view?.destroy();
    view = null;
    renderedScore = null;
    renderedLayout = null;
  }
  function showEmpty() {
    scroller.hidden = true;
    empty.hidden = false;
    host.dataset.rendered = 'empty';
    host.removeAttribute('aria-busy');
    const readOnly = !!part?.readOnly;
    const actions = readOnly ? [] : EMPTY_ACTIONS.filter(action => typeof onEmpty?.[action.key] === 'function');
    const titleId = `chart-empty-${Math.random().toString(36).slice(2, 9)}`;
    empty.replaceChildren(
      h('h2', {id: titleId}, readOnly ? COPY.sharedTitle : COPY.emptyTitle),
      actions.length ? h('div', {class: 'chart-empty-actions', role: 'group', 'aria-labelledby': titleId},
        ...actions.map((action, i) => h('button', {type: 'button', dataset: {chartAction: action.key}, attrs: {'data-primary': i === 0},
          on: {click: () => onEmpty[action.key]()}}, action.name))) : null);
  }
  function render() {
    if (!state.visible || disposed) return;
    if (!part?.score || !part.hasNotation) { destroyView(); showEmpty(); return; }
    empty.hidden = true;
    empty.replaceChildren();
    scroller.hidden = false;
    ensureView();
    if (renderedScore !== part.score || renderedLayout !== layout()) {
      renderedScore = part.score;
      renderedLayout = layout();
      beginRelayout(true);
      view.setScore(part.score, {layout: layout()});
    }
  }
  function rendered() {
    if (disposed || !view) return;
    revision += 1;
    host.dataset.rendered = String(revision);
    host.removeAttribute('aria-busy');
    scoreHost.setAttribute('aria-label', COPY.chartLabel(measures().length));
    drawLoop();
    if (lastQ != null) view.setPlayhead(lastQ);
    lastSystem = null;
    if (pendingAnchor) { restoreAnchor(pendingAnchor); pendingAnchor = null; }
    else if (pendingReveal) { const {t, smooth} = pendingReveal; pendingReveal = null; reveal(t, {smooth}); }
    else if (state.follow) followNow(false);
    if (relayoutStart != null) {
      const ms = Math.max(0, now() - relayoutStart);
      relayoutStart = null;
      onRelayout({ms, bars: view.renderedBars?.() ?? measures().length});
    }
  }
  function drawLoop() {
    if (!view || gestureOwnsLoop()) return;
    view.setLoop(loopQ());
  }

  // ---------- scrolling and follow ----------
  function cancelPageAnimation() { if (pageAnimation) { caf(pageAnimation.id); pageAnimation = null; } }
  const maxScroll = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  function jumpTo(top) {
    cancelPageAnimation();
    programmaticAt = now();
    scroller.scrollTop = Math.max(0, top);
  }
  /** Scroll so `target` is the top; waits (≤ 30 frames) while alphaTab grows the surface. */
  function scrollToY(target, smooth, attempt = 0) {
    const top = Math.max(0, target);
    cancelPageAnimation();
    if (Math.abs(scroller.scrollTop - top) < 4) return;
    if (maxScroll() < top - 1 && attempt < 30 && scroller.scrollHeight > 0) { raf(() => { if (!disposed) scrollToY(target, smooth, attempt + 1); }); return; }
    programmaticAt = now();
    if (smooth && !reducedMotion() && typeof scroller.scrollTo === 'function') scroller.scrollTo({top, behavior: 'smooth'});
    else scroller.scrollTop = top;
  }
  /** Page follow: a 200 ms turn (a jump under reduced motion). */
  function turnTo(target, smooth) {
    const to = Math.min(Math.max(0, target), maxScroll() || Math.max(0, target));
    if (!smooth || reducedMotion()) { jumpTo(to); return; }
    cancelPageAnimation();
    const from = scroller.scrollTop;
    if (Math.abs(to - from) < 1) return;
    const animation = {start: null, id: 0};
    const step = time => {
      if (disposed || pageAnimation !== animation) return;
      if (animation.start == null) animation.start = time;
      const p = Math.min(1, (time - animation.start) / PAGE_TURN_MS), eased = 1 - (1 - p) ** 3;
      programmaticAt = now();
      scroller.scrollTop = from + (to - from) * eased;
      if (p < 1) animation.id = raf(step); else pageAnimation = null;
    };
    pageAnimation = animation;
    programmaticAt = now();
    animation.id = raf(step);
  }
  // Bar bounds are in score-stage coordinates; scrolling needs scroller-content
  // coordinates (the stage sits below .chart-score's padding). The offset is
  // cached while a pinch preview transforms the score.
  let cachedOffset = 0;
  function stageOffset() {
    if (!view || scoreHost.hasAttribute('data-previewing')) return cachedOffset;
    const top = view.stage.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    cachedOffset = Number.isFinite(top) ? top : 0;
    return cachedOffset;
  }
  function boundsAt(index, offset = stageOffset()) {
    const bounds = view?.barBounds(index);
    return bounds ? {...bounds, y: bounds.y + offset} : null;
  }
  function followSystem(bounds, smooth) {
    const viewport = scroller.clientHeight;
    if (state.followStyle === 'scroll') { scrollToY(bounds.y - viewport * state.followAnchor, smooth); return; }
    if (!viewport) return;
    const top = scroller.scrollTop;
    const shown = bounds.y >= top - 1 && bounds.y + bounds.h <= top + viewport + 1;
    // Like a page-turner: when the playing system crosses the middle, advance half a viewport.
    if (shown && bounds.y >= top + viewport / 2) turnTo(top + viewport / 2, smooth);
    // A jump (loop wrap, seek) out of view page-aligns the system into the top half.
    else if (!shown) turnTo(bounds.y - viewport * state.followAnchor, smooth);
  }
  // Runs every frame while playing: it reads only the cached geometry until the playing system changes.
  function followIndex(index, smooth) {
    const raw = view?.barBounds(index);
    if (!raw || raw.y === lastSystem) return;
    lastSystem = raw.y;
    followSystem(boundsAt(index), smooth);
  }
  function followNow(smooth) {
    if (!view?.ready || !timeline()) return;
    const t = lastTime ?? position();
    const q = lastQ ?? timeToQ(t);
    lastQ = q;
    view.setPlayhead(q);
    lastSystem = null;
    followIndex(barIndexAtQ(q), smooth);
  }
  function position() { const p = Number(engine?.getPosition?.()); return Number.isFinite(p) ? p : 0; }
  function setFollowState(next) {
    if (state.follow === next) return false;
    state.follow = next;
    onFollowChange(next);
    return true;
  }
  // Manual wheel, touch scroll or scrollbar drag pauses Follow, playing or stopped.
  function userScroll(event) {
    if (gesture && (gesture.armed || gesture.dragging || gesture.mode === 'edge')) return;
    if (event.type === 'wheel' && (event.ctrlKey || event.metaKey)) return;   // ⌘-wheel / trackpad pinch is the surface's zoom
    if (event.touches && event.touches.length > 1) return;                      // two fingers: the surface's pinch
    if (event.type === 'pointerdown' && event.target !== scroller) return;      // only the scrollbar itself
    if (now() - programmaticAt < FOLLOW_GUARD_MS) return;
    cancelPageAnimation();
    setFollowState(false);
  }
  scroller.addEventListener('wheel', userScroll, {passive: true});
  scroller.addEventListener('touchmove', userScroll, {passive: true});
  scroller.addEventListener('pointerdown', userScroll);

  function captureAnchor() {
    const index = anchorBar(), bounds = boundsAt(index), viewport = scroller.clientHeight;
    return bounds ? {index, fraction: viewport ? (bounds.y - scroller.scrollTop) / viewport : 0} : null;
  }
  function restoreAnchor(anchor) {
    const bounds = boundsAt(anchor.index);
    if (!bounds) return;
    // alphaTab may size its surface a few frames after the render: scrollToY waits for it.
    scrollToY(bounds.y - anchor.fraction * scroller.clientHeight, false);
    lastSystem = lastQ != null ? view.barBounds(barIndexAtQ(lastQ))?.y ?? null : null;
  }
  /** The bar at the follow line: the playing bar when its system is there, else that system's first bar. */
  function anchorBar() {
    if (!view?.ready || !timeline()) return 0;
    const line = scroller.scrollTop + scroller.clientHeight * state.followAnchor, offset = stageOffset();
    let systemY = null, first = 0;
    for (let i = 0; i < measures().length; i++) {
      const bounds = boundsAt(i, offset);
      if (!bounds) continue;
      if (systemY != null && bounds.y > line + LINE_SLOP_PX) break;   // scrollTop is whole pixels
      if (bounds.y !== systemY) { systemY = bounds.y; first = i; }
    }
    if (lastQ != null) {
      const playing = barIndexAtQ(lastQ), bounds = boundsAt(playing, offset);
      if (bounds && bounds.y === systemY) return playing;
    }
    return first;
  }
  function reveal(t, {smooth = false} = {}) {
    if (!view?.ready || !timeline()) { pendingReveal = {t, smooth}; return; }
    const index = barIndexAtQ(timeToQ(t)), bounds = boundsAt(index);
    if (!bounds) return;
    lastSystem = view.barBounds(index).y;
    scrollToY(bounds.y - scroller.clientHeight * state.followAnchor, smooth);
  }

  // ---------- gestures ----------
  // Taps, double-taps, long-presses and right-clicks are emitted with their
  // pointer type; mouse drags (and touch drags after a long-press, when
  // stopped) edit the loop. Nothing here seeks.
  function activation(kind, at, event, pointerType) {
    const q = at.q, beatQ = at.beatQ != null && Math.abs(at.beatQ - q) < 1 ? at.beatQ : barStartQ(at.index);
    return {kind, index: at.index, barId: measures()[at.index]?.id, q, time: qToTime(q), beatTime: qToTime(beatQ),
      pointerType, glass: state.glass, clientX: event.clientX, clientY: event.clientY};
  }
  function emit(kind, at, event, pointerType) {
    if (kind === 'double') lastDoubleAt = now();
    onBarActivate(activation(kind, at, event, pointerType));
  }
  const typeOf = event => (event.pointerType === 'touch' || event.pointerType === 'pen' ? event.pointerType : 'mouse');
  const gestureOwnsLoop = () => !!gesture && (gesture.mode === 'edge' || ((gesture.mode === 'create' || gesture.mode === 'move') && gesture.dragging));
  function capture(event) { try { view?.stage.setPointerCapture(event.pointerId); } catch { /* not capturable */ } }

  function pointer({kind, event, at}) {
    if (kind === 'down') { down(event, at); return; }
    if (!gesture || event.pointerId !== gesture.id) return;
    if (kind === 'move') move(event, at);
    else if (kind === 'up') up(event, at);
    else cancelGesture();
  }
  function down(event, at) {
    const type = typeOf(event);
    if (type !== 'mouse') lastTouchAt = now();
    if (event.button !== 0) return;
    if (gesture) cancelGesture();
    const edge = event.target?.closest?.('[data-loop-edge]')?.getAttribute('data-loop-edge');
    const loop = loopQ();
    if (edge && loop && (type === 'mouse' || !state.glass)) {
      gesture = {id: event.pointerId, type, mode: 'edge', edge, loop, x: event.clientX, y: event.clientY, lastQ: edge === 'start' ? loop[0] : loop[1], range: null};
      capture(event);
      event.preventDefault?.();
      return;
    }
    if (at.index == null) return;
    gesture = {id: event.pointerId, type, mode: 'press', start: at, lastAt: at, x: event.clientX, y: event.clientY, dragging: false, armed: false, long: false, range: null};
    if (type === 'mouse') {
      capture(event);
      if (loop && at.q >= loop[0] - 1e-9 && at.q < loop[1] - 1e-9) gesture.inside = loop;
      return;
    }
    const pressed = gesture;
    pressed.timer = setTimeout(() => {
      if (gesture !== pressed) return;
      pressed.long = true;
      try { navigator.vibrate?.(HAPTIC_MS); } catch { /* no haptics */ }
      // Glass (playing): a long-press opens the bar menu but never draws a loop.
      if (state.glass) return;
      pressed.armed = true;
      view?.setRange([pressed.start.index, pressed.start.index]);
      onStatus(COPY.armHint);
    }, LONG_PRESS_MS);
  }
  function move(event, at) {
    const g = gesture, distance = Math.hypot(event.clientX - g.x, event.clientY - g.y);
    if (g.type === 'mouse' && event.buttons === 0) { up(event, at); return; }   // released outside the window
    if (at.index != null) g.lastAt = at;
    if (g.mode === 'edge') { editEdge(event, at); return; }
    if (g.type === 'mouse') {
      if (!g.dragging && distance > SLOP_PX) { g.dragging = true; g.mode = g.inside ? 'move' : 'create'; }
    } else {
      if (!g.armed) { if (distance > SLOP_PX) cancelGesture(); return; }   // a scroll, not a press
      if (!g.dragging && distance > SLOP_PX) { g.dragging = true; g.mode = 'create'; view?.setRange(null); }
    }
    if (!g.dragging) return;
    event.preventDefault?.();
    if (g.mode === 'move') moveLoop(event, g.lastAt);
    else createLoop(event, g.lastAt);
  }
  function up(event, at) {
    const g = gesture;
    clearTimeout(g.timer);
    gesture = null;
    if (g.type !== 'mouse') lastTouchAt = now();
    if (g.mode === 'edge' || g.dragging) { commit(g); return; }
    if (g.armed) view?.setRange(null);
    if (g.type !== 'mouse' && g.long) { emit('long', g.start, event, g.type); return; }
    const t = now(), place = {x: event.clientX, y: event.clientY};
    if (lastTap && lastTap.type === g.type && t - lastTap.at <= DOUBLE_TAP_MS && Math.hypot(place.x - lastTap.x, place.y - lastTap.y) <= SLOP_PX) {
      lastTap = null;
      emit('double', g.start, event, g.type);
      return;
    }
    lastTap = {at: t, type: g.type, ...place};
    emit('tap', g.start, event, g.type);
  }
  function cancelGesture() {
    const g = gesture;
    if (!g) return;
    clearTimeout(g.timer);
    gesture = null;
    if (g.armed) view?.setRange(null);
    if (g.mode === 'edge' || g.dragging) drawLoop();
  }
  function preview(g, [va, vb], [sa, sb]) {
    view?.setLoop([va, vb], {dragging: true});
    const key = `${sa}:${sb}`;
    g.range = [sa, sb];
    if (g.previewKey === key) return;
    g.previewKey = key;
    onLoopEdit({...loopEdit(sa, sb), phase: 'preview'});
  }
  function createLoop(event, at) {
    const g = gesture, from = g.start, to = at ?? from;
    let qa, qb;
    if (event.altKey) {
      // Alt-drag snaps to beats: from the beat under the press to the end of the beat under the pointer.
      qa = beatFloor(Math.min(from.q, to.q));
      qb = beatAfter(Math.max(from.q, to.q));
    } else {
      qa = barStartQ(Math.min(from.index, to.index));
      qb = barEndQ(Math.max(from.index, to.index));
    }
    preview(g, [qa, qb], [qa, qb]);
  }
  function moveLoop(event, at) {
    const g = gesture, [la, lb] = g.inside, n = measures().length;
    let qa, qb;
    if (event.altKey) {
      const unit = 4 / measures()[barIndexAtQ(la)].denominator;
      let dq = Math.round((at.q - g.start.q) / unit) * unit;
      dq = Math.max(-la, Math.min(extentQ() - lb, dq));
      qa = la + dq; qb = lb + dq;
    } else {
      const ia = barIndexAtQ(la), ib = barIndexAtQ(lb - 1e-6);
      const d = Math.max(-ia, Math.min(n - 1 - ib, at.index - g.start.index));
      qa = barStartQ(ia + d) + Math.min(barLength(ia + d), la - barStartQ(ia));
      qb = barStartQ(ib + d) + Math.min(barLength(ib + d), lb - barStartQ(ib));
    }
    preview(g, [qa, qb], [qa, qb]);
  }
  function editEdge(event, at) {
    const g = gesture, [la, lb] = g.loop, mode = event.altKey ? 'beat' : 'bar';
    let q = at.index != null ? at.q : g.lastQ;
    g.lastQ = q;
    if (g.edge === 'start') {
      q = Math.max(0, Math.min(q, lb - 1e-3));
      let snapped = nearestLine(q, mode);
      if (snapped >= lb - 1e-6) snapped = mode === 'beat' ? beatFloor(lb - 1e-6) : barStartQ(barIndexAtQ(lb - 1e-6));
      preview(g, [q, lb], [snapped, lb]);
    } else {
      q = Math.min(extentQ(), Math.max(q, la + 1e-3));
      let snapped = nearestLine(q, mode);
      if (snapped <= la + 1e-6) snapped = mode === 'beat' ? beatAfter(la) : barEndQ(barIndexAtQ(la));
      preview(g, [la, q], [la, snapped]);
    }
  }
  function commit(g) {
    if (!g.range) { drawLoop(); return; }
    const [qa, qb] = g.range, edit = loopEdit(qa, qb);
    // The brackets spring from the pointer to their snapped lines (--motion-fast) until setLoopRange answers.
    pendingCommit = {a: edit.a, b: edit.b};
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => { pendingCommit = null; commitTimer = null; drawLoop(); }, COMMIT_HOLD_MS);
    view?.setLoop([qa, qb], {dragging: false});
    onLoopEdit({...edit, phase: 'commit'});
  }
  function onContextMenu(event) {
    if (gesture && gesture.type !== 'mouse') { event.preventDefault(); return; }   // a touch long-press opens the menu on release
    if (now() - lastTouchAt < 800) { event.preventDefault(); return; }             // the browser's own long-press menu after a touch
    const at = view?.locate(event);
    if (at?.index == null) return;
    event.preventDefault();
    cancelGesture();
    emit('context', at, event, 'mouse');
  }
  function onDoubleClick(event) {
    if (now() - lastDoubleAt < 500 || now() - lastTouchAt < 800) return;   // already emitted by the tap rule
    const at = view?.locate(event);
    if (at?.index == null) return;
    lastTap = null;
    emit('double', at, event, 'mouse');
  }

  const unsubscribe = typeof part?.subscribe === 'function' ? part.subscribe(() => { if (state.visible) render(); }) : noop;

  return {
    host,
    setVisible(next) {
      state.visible = !!next;
      host.hidden = !state.visible;
      if (!state.visible) { cancelGesture(); return; }
      const shown = view?.ready;
      render();
      // Shown again with the same engraving: put the playing system back at the follow line.
      if (shown && view?.ready && state.follow) followNow(false);
    },
    /** Draws the playhead at `time` (seconds; default engine.getPosition()) and follows it. */
    tick(time) {
      if (!state.visible || !view?.ready || !timeline()) return;
      const t = finite(time) ? time : position();
      lastTime = t;
      const q = timeToQ(t);
      if (q === lastQ) return;
      lastQ = q;
      view.setPlayhead(q);
      if (state.follow) followIndex(barIndexAtQ(q), true);
    },
    refresh() { renderedScore = null; render(); },
    destroy() {
      disposed = true;
      unsubscribe?.();
      clearTimeout(commitTimer);
      cancelPageAnimation();
      destroyView();
      scroller.removeEventListener('wheel', userScroll);
      scroller.removeEventListener('touchmove', userScroll);
      scroller.removeEventListener('pointerdown', userScroll);
      host.replaceChildren();
      host.classList.remove('chart');
      for (const name of ['data-rendered', 'data-glass', 'aria-busy']) host.removeAttribute(name);
    },
    /** One relayout; with `anchor` the bar at the follow line keeps its screen position. */
    setScale(value, {anchor = true} = {}) {
      const next = clampScale(value);
      if (!Number.isFinite(next) || Math.abs(next - state.scale) < 1e-9) return;
      state.scale = next;
      if (!view) return;
      beginRelayout(anchor);
      view.configure({scale: next, fonts: floorsNow()});
      view.relayout();
    },
    /** Pinch preview: a CSS transform on .chart-score only, no relayout; null clears it. */
    previewScale(factor, {clientX, clientY} = {}) {
      if (factor == null || !finite(Number(factor))) {
        scoreHost.style.transform = '';
        scoreHost.style.transformOrigin = '';
        scoreHost.removeAttribute('data-previewing');
        return;
      }
      const f = clampScale(state.scale * factor) / state.scale;
      if (!scoreHost.hasAttribute('data-previewing')) stageOffset();   // cache the unscaled offset first
      if (finite(clientX) && finite(clientY)) {
        const rect = scoreHost.getBoundingClientRect();
        scoreHost.style.transformOrigin = `${clientX - rect.left}px ${clientY - rect.top}px`;
      }
      scoreHost.dataset.previewing = '';
      scoreHost.style.transform = `scale(${f})`;
    },
    /** Display (this device): layout ('combined'|'split'|null = the part's own) and bars per row, in one relayout. */
    setDisplay(next = {}) {
      let changed = false;
      if ('layout' in next && (next.layout == null || LAYOUTS.includes(next.layout))) {
        const own = part?.score?.layout || 'combined';
        const value = next.layout === own ? null : next.layout ?? null;
        writePref('chart.display.layout', value);
        if (value !== state.layoutOverride) { state.layoutOverride = value; changed = true; }
      }
      if ('barsPerRow' in next) {
        const value = Number.isInteger(next.barsPerRow) && next.barsPerRow > 0 ? next.barsPerRow : -1;
        if (value !== state.barsPerRow) { state.barsPerRow = value; changed = true; }
      }
      if (!changed || !view) return;
      beginRelayout(true);
      view.configure({barsPerRow: state.barsPerRow});
      if (renderedScore && renderedLayout !== layout()) { renderedLayout = layout(); view.setScore(part.score, {layout: layout()}); }
      else view.relayout();
    },
    /** On-screen label floors in px ({barNumber: 14 × d, marker: 20 × d}); relayouts when the engraving sizes change. */
    setFonts(next = {}) {
      state.floors = sanitizeFloors(next, state.floors);
      if (view && view.configure({fonts: floorsNow()})) { beginRelayout(true); view.relayout(); }
    },
    setFollowStyle(style, {anchor} = {}) {
      if (style === 'scroll' || style === 'page') state.followStyle = style;
      state.followAnchor = anchorValue(anchor, state.followAnchor);
      if (state.follow) followNow(true);
    },
    setFollow(on) {
      setFollowState(!!on);
      if (state.follow) followNow(true);
    },
    /** {a, b} seconds, or null. Draws the band, brackets and handles; nothing is polled. */
    setLoopRange(range) {
      loopRange = range && finite(range.a) && finite(range.b) && range.b > range.a ? {a: range.a, b: range.b} : null;
      pendingCommit = null;
      clearTimeout(commitTimer);
      commitTimer = null;
      drawLoop();
    },
    setGlass(on) {
      state.glass = !!on;
      host.toggleAttribute('data-glass', state.glass);
      // Touch never draws a loop while playing.
      if (state.glass && gesture && gesture.type !== 'mouse' && (gesture.armed || gesture.mode === 'edge')) cancelGesture();
    },
    /** Puts `t` at the follow line (resume, §4.12 step 4); waits for the first engraving if needed. */
    reveal,
    anchorBar,
    barAtPoint(clientX, clientY) {
      if (!view?.ready || !timeline()) return null;
      const at = view.locate({clientX, clientY});
      return at.index == null ? null : {index: at.index, q: at.q, time: qToTime(at.q)};
    },
    /** Read-only state for the surface and tests. */
    get state() { return {...state, floors: {...state.floors}, layout: layout(), revision, loop: loopRange && {...loopRange}}; },
  };
}

function sanitizeFloors(fonts, fallback) {
  const out = {...fallback};
  for (const key of ['barNumber', 'marker']) {
    const value = Number(fonts?.[key]);
    if (Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}
function anchorValue(value, fallback) {
  const v = Number(value);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : fallback;
}
