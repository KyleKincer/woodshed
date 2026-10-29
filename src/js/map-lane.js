// Map lanes, pure helpers (architecture §1 "map-lane.js (changed: pure helpers only)", §0.1
// "layout code takes dimensions as inputs"; maps/mapedit.md §6). No DOM and no canvas: the Edit ·
// Map lanes (src/edit/map/lane.js, sections.js) measure their boxes and pass widths and heights in.
//
//   segments(map, duration)                    song-wide tempo segments in qpm, suspect spans flagged
//   tempoRange(segs) / guides(range)           an outlier-proof vertical range and its round guides
//   timeScale({t0, span, width})               {x(t), t(x)} for a visible window
//   rulerMarks(map, view)                      bar-ruler marks thinned to ≥ RULER_MIN_PX, meter chips
//   tempoGeometry(map, view)                   the curve paths, span labels and pins of the tempo lane
//   hitPin(pins, x, y, {hit})                  the pin under a pointer (24 px fine, 44 px coarse)
//   diamond(x, y, size)                        a pin's 12 px diamond as four points
//   sectionBlocks(map, view)                   the sections lane's blocks
//   suggestionBlocks(map, blocks, view)        a section suggestion's dashed blocks
//   dragTime(map, q, t)                        a dragged pin's time, kept 2 ms inside its neighbours
import {compare} from '../../shared/notation.ts';
import {pulseOf} from '../../shared/song-map.ts';

/** Ruler numbers keep at least this much room (1.9 thinned to 26 px). */
export const RULER_MIN_PX = 26;
/** Pins are 12 px diamonds (spec §5.1). */
export const DIAMOND = 12;
/** Pin hit areas: 24 px on fine pointers, 44 px on coarse ones (spec §5.1). */
export const HIT = Object.freeze({fine: 24, coarse: 44});
/** A dragged or nudged pin stays this far inside its neighbours (seconds; as the map session). */
export const PIN_GAP = 0.002;
/** Ramps are sampled every this many pixels. */
export const RAMP_STEP_PX = 6;
/** Span tempo labels need at least this much width. */
export const LABEL_MIN_PX = 58;
/** A steady span this much off both neighbours is suspect (usually a miscounted bar). */
export const SUSPECT_RATIO = 0.06;

const EPS = 1e-6;
const trim = (bpm) => (Math.round(bpm * 10) / 10).toFixed(1).replace(/\.0$/, '');

/** Song-wide tempo segments in quarter notes per minute, clipped to the recording. */
export function segments(songMap, duration) {
  const c = songMap.compiled, first = c.pins[0], last = c.pins[c.pins.length - 1], out = [];
  if (first.time > 0) out.push({t0: 0, t1: Math.min(first.time, duration), q0: c.head * 60, q1: c.head * 60, kind: 'head'});
  c.spans.forEach((s, i) => { if (s.t0 < duration) out.push({t0: s.t0, t1: Math.min(s.t1, duration), q0: s.v0 * 60, q1: s.v1 * 60, kind: s.ramp ? 'ramp' : 'steady', span: s, index: i}); });
  if (last.time < duration) out.push({t0: last.time, t1: duration, q0: c.tail * 60, q1: c.tail * 60, kind: 'tail'});
  // A steady span that disagrees with the spans on both sides by more than 6% is suspect.
  out.forEach((seg, i) => {
    if (seg.kind !== 'steady' || seg.span.p1 - seg.span.p0 < 0.99) return;
    const around = [out[i - 1]?.q1, out[i + 1]?.q0].filter(Number.isFinite);
    if (around.length === 2 && around.every((ref) => Math.abs(seg.q0 / ref - 1) > SUSPECT_RATIO)) seg.suspect = true;
  });
  return out;
}

/** A readable tempo range that ignores outliers (gaps between sections, miscounts). */
export function tempoRange(segs) {
  if (!segs.length) return {lo: 100, hi: 140};
  const weighted = segs.map((s) => ({q: (s.q0 + s.q1) / 2, w: Math.max(1e-3, s.t1 - s.t0)})).sort((a, b) => a.q - b.q);
  const total = weighted.reduce((n, s) => n + s.w, 0);
  let acc = 0, median = weighted[0].q;
  for (const s of weighted) { acc += s.w; if (acc >= total / 2) { median = s.q; break; } }
  const inRange = segs.filter((s) => Math.max(s.q0, s.q1) <= median * 1.5 && Math.min(s.q0, s.q1) >= median / 1.5);
  let lo = Math.min(...inRange.map((s) => Math.min(s.q0, s.q1))), hi = Math.max(...inRange.map((s) => Math.max(s.q0, s.q1)));
  if (!Number.isFinite(lo)) { lo = median; hi = median; }
  const pad = Math.max(4, (hi - lo) * 0.18);
  return {lo: Math.max(1, lo - pad), hi: hi + pad};
}

/** Two or three round guide values inside the range. */
export function guides({lo, hi}) {
  const step = [1, 2, 5, 10, 20, 25, 50, 100].find((s) => (hi - lo) / s <= 3) || 200;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

/** The x of a time and the time of an x, for the window [t0, t0 + span) drawn `width` px wide. */
export function timeScale({t0 = 0, span = 0, width = 0} = {}) {
  const ok = span > 0 && width > 0;
  return {
    x: (t) => (ok ? ((t - t0) / span) * width : 0),
    t: (x) => (ok ? t0 + (x / width) * span : t0),
  };
}

function viewOf({t0 = 0, span = 0, width = 0, duration} = {}, map) {
  const d = Number.isFinite(duration) ? duration : map.duration;
  return {t0, span, t1: t0 + span, width, duration: d, scale: timeScale({t0, span, width})};
}

/**
 * The bar ruler's marks for a window: one per bar start that is visible and inside the recording,
 * thinned so numbers keep RULER_MIN_PX apart (every 1, 2, 4, … bars); a meter change, a bar that
 * starts a section and the selected bar always get one. A mark carries the display number (null
 * for a pickup), the meter chip text where the meter changes (and on bar 0), the label and x.
 *   view: {t0, span, width, duration?, selected?: measure index}
 */
export function rulerMarks(map, view = {}) {
  const v = viewOf(view, map);
  if (!(v.span > 0) || !(v.width > 0)) return [];
  const inView = map.bars.filter((b) => b.t0 >= v.t0 - EPS && b.t0 <= v.t1 + EPS && b.t0 < v.duration);
  const average = inView.length > 1 ? (v.scale.x(inView.at(-1).t0) - v.scale.x(inView[0].t0)) / (inView.length - 1) : v.width;
  const every = [1, 2, 4, 8, 16, 32, 64, 128].find((n) => n * average >= RULER_MIN_PX) || 256;
  const out = [];
  let last = -Infinity;
  for (const b of inView) {
    const x = v.scale.x(b.t0), change = b.index === 0 || b.meterChange, selected = b.index === view.selected;
    const forced = change || !!b.label || selected;
    const due = (b.display === null ? 0 : b.display - 1) % every === 0;
    if (!forced && (!due || x - last < RULER_MIN_PX)) continue;
    out.push({index: b.index, display: b.display, x, meter: change ? `${b.numerator}/${b.denominator}` : null,
      label: b.label || '', selected, change});
    last = x;
  }
  return out;
}

/**
 * Everything the tempo lane draws for a window, in lane pixels (y grows downwards):
 *   {range, guides: [{value, y}], paths: [{kind, suspect, open, points: [[x, y]…], label, labelX, labelY}],
 *    connectors: [[[x, y], [x, y]]…], pins: [{pin, x, y, ramp}], y(qpm)}
 *   view: {t0, span, width, height, duration?, top = 12, bottom = 10}
 * Span labels read in the bar's felt pulse ('♩.92' in 6/8), ramps as 'a→b', the tail with ' →'.
 */
export function tempoGeometry(map, view = {}) {
  const v = viewOf(view, map);
  const height = Math.max(0, view.height ?? 0), top = view.top ?? 12, bottom = height - (view.bottom ?? 10);
  const segs = segments(map, v.duration), range = tempoRange(segs);
  const y = (q) => bottom - ((Math.min(Math.max(q, range.lo), range.hi) - range.lo) / (range.hi - range.lo || 1)) * Math.max(1, bottom - top);
  const out = {range, guides: guides(range).map((value) => ({value, y: y(value)})), paths: [], connectors: [], pins: [], y};
  if (!(v.span > 0) || !(v.width > 0)) return out;
  const x = v.scale.x;
  for (const s of segs) {
    if (s.t1 < v.t0 || s.t0 > v.t1) continue;
    const a = Math.max(s.t0, v.t0), b = Math.min(s.t1, v.t1), points = [];
    if (s.kind === 'ramp') {
      const n = Math.max(2, Math.ceil((x(b) - x(a)) / RAMP_STEP_PX));
      for (let k = 0; k <= n; k++) { const t = a + ((b - a) * k) / n; points.push([x(t), y(map.qpmAt(t))]); }
    } else points.push([x(a), y(s.q0)], [x(b), y(s.q1)]);
    const open = s.kind === 'head' || s.kind === 'tail';
    const path = {kind: s.kind, suspect: !!s.suspect, open, points, label: null, labelX: 0, labelY: 0};
    const left = points[0][0], right = points.at(-1)[0];
    if (right - left >= LABEL_MIN_PX) {
      const index = map.barIndexAtQ(map.positionAt((a + b) / 2)), pulse = pulseOf(map.measure(index));
      const unit = pulse === 1 ? '' : map.pulseLabel(index), q0 = s.q0 / pulse, q1 = s.q1 / pulse;
      path.label = unit + (s.kind === 'ramp' ? `${trim(q0)}→${trim(q1)}` : trim(q0)) + (s.kind === 'tail' ? ' →' : '');
      path.labelX = (left + right) / 2;
      path.labelY = Math.max(top + 10, Math.min(...points.map((p) => p[1])) - 6);
    }
    const previous = out.paths.at(-1);
    if (previous) out.connectors.push([previous.points.at(-1), points[0]]);
    out.paths.push(path);
  }
  for (const p of map.compiled.pins) {
    if (p.time < v.t0 - EPS || p.time > v.t1 + EPS) continue;
    out.pins.push({pin: p, x: x(p.time), y: y(map.qpmAt(p.time + 1e-6)), ramp: !!p.ramp});
  }
  return out;
}

/**
 * The pin under (x, y): the nearest whose square hit area (`hit` px, centred on the diamond)
 * contains the point, else the nearest within a quarter of the hit width horizontally (a pin is
 * easy to grab anywhere in its column). Null when none.
 */
export function hitPin(pins, x, y, {hit = HIT.fine} = {}) {
  const half = hit / 2;
  let best = null, distance = Infinity;
  for (const p of pins ?? []) {
    const dx = Math.abs(p.x - x), dy = Math.abs(p.y - y);
    if (dx > half || dy > half) continue;
    const d = Math.hypot(dx, dy);
    if (d < distance) { best = p; distance = d; }
  }
  if (best) return best;
  for (const p of pins ?? []) {
    const dx = Math.abs(p.x - x);
    if (dx <= half / 2 && dx < distance) { best = p; distance = dx; }
  }
  return best;
}

/** A diamond `size` px tall and wide centred on (x, y): top, right, bottom, left. */
export function diamond(x, y, size = DIAMOND) {
  const r = size / 2;
  return [[x, y - r], [x + r, y], [x, y + r], [x - r, y]];
}

/**
 * The sections lane's blocks for a window: one per section that overlaps it, clipped to the lane.
 *   [{index, name, label, startBar, endBar, from, to, t0, t1, x0, x1, pickup}]
 * `from`/`to` are display bar numbers (null for a pickup bar).
 */
export function sectionBlocks(map, view = {}) {
  const v = viewOf(view, map);
  if (!(v.span > 0) || !(v.width > 0)) return [];
  const bars = map.bars;
  return map.sections
    .filter((s) => s.t1 > v.t0 && s.t0 < v.t1)
    .map((s) => ({index: s.index, name: s.name, label: s.label, startBar: s.startBar, endBar: s.endBar,
      from: bars[s.startBar]?.display ?? null, to: bars[s.endBar]?.display ?? null, t0: s.t0, t1: s.t1,
      x0: Math.max(0, v.scale.x(s.t0)), x1: Math.min(v.width, v.scale.x(s.t1)), pickup: !!bars[s.startBar]?.pickup}));
}

/** The index of the bar whose start is nearest `t`. */
export function nearestBar(map, t) {
  const bars = map.bars;
  let best = 0;
  for (let i = 1; i < bars.length; i++) if (Math.abs(bars[i].t0 - t) < Math.abs(bars[best].t0 - t)) best = i;
  return best;
}

/**
 * Dashed suggestion blocks (D47): each block runs from its bar to the next block's bar (the last
 * to the end of the song). `blocks` are the review's `{bar, label, accepted}` or the suggestion's
 * `{t0, label}` (snapped to the nearest bar start). `i` is the block's index in `blocks`.
 *   [{i, bar, label, accepted, display, t0, t1, x0, x1}] in bar order
 */
export function suggestionBlocks(map, blocks, view = {}) {
  const v = viewOf(view, map);
  const bars = map.bars;
  if (!bars.length || !Array.isArray(blocks)) return [];
  const list = blocks.map((b, i) => {
    const bar = Number.isInteger(b.bar) ? Math.max(0, Math.min(bars.length - 1, b.bar)) : nearestBar(map, Number(b.t0) || 0);
    return {i, bar, label: b.label ?? '', accepted: b.accepted !== false, display: bars[bar].display};
  });
  const order = [...list].sort((a, b) => a.bar - b.bar || a.i - b.i);
  const end = Math.min(v.duration, bars.at(-1).t1);
  return order.map((b, k) => {
    const next = order.slice(k + 1).find((o) => o.bar > b.bar);
    const t0 = bars[b.bar].t0, t1 = next ? bars[next.bar].t0 : end;
    return {...b, t0, t1, x0: v.scale.x(t0), x1: v.scale.x(t1)};
  }).filter((b) => !(v.span > 0) || (b.t1 > v.t0 && b.t0 < v.t1));
}

/**
 * Where a pin dragged to `t` lands: inside the recording and PIN_GAP inside the pins either side
 * of its position `q` (a Fraction). Returns the clamped time.
 */
export function dragTime(map, q, t) {
  const pins = map.data.pins;
  const prev = pins.findLast((p) => compare(p.position, q) < 0), next = pins.find((p) => compare(p.position, q) > 0);
  const lo = Math.max(0, (prev?.time ?? -Infinity) + PIN_GAP), hi = Math.min(map.duration, (next?.time ?? Infinity) - PIN_GAP);
  return Math.max(lo, Math.min(hi, Number(t)));
}
