// The position model (architecture §2.14.4, §4.3–§4.5): every place in the
// Stage and Edit that names a time asks this one module, so mapped and unmapped
// songs read consistently.
//
// - Mapped (`map.isReal`): bars and beats ('13 · 2', 'Pickup · 3'), sections as
//   regions, bar-line steps and snapping, bar refs that survive map edits.
// - Unmapped: clock time ('1:12', '0:31.2–0:41.0 (9.8 s)'), live markers as
//   regions, ±5 s / ±1 s steps. **No string produced for an unmapped song says
//   "Bar"** (the placeholder map's bars are never consulted for text).
//
// Markers are drawn as ticks in both modes (`markerTicks`); on mapped songs they
// stay ticks until they are turned into sections (§2.14.1).
//
// Times are media seconds. The model reads the map and the practice state on
// each call; `revision` is a signal that bumps on every map change, and the
// practice markers are read through `practice.value`, so an effect that calls
// these methods re-runs when either changes.
import {signal, readonly, batch} from '../app/store.js';
import {formatClock} from '../../shared/practice.ts';

const EPS = 1e-6;
/** A loop edge "is on" a bar line or "equals" a section within 10 ms (as `summarize`). */
const EDGE_EPS = 0.01;
const UNMAPPED_STEP = {bar: 5, beat: 1};
const UNMAPPED_LOOP_HALF = 5;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** `m:ss.s` with the seconds rounded to a tenth: 31.24 → '0:31.2'. */
export function formatTenths(seconds) {
  const tenths = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 10));
  const s = Math.floor(tenths / 10), m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}.${tenths % 10}`;
}

/** A length in seconds to one decimal: 9.8 → '9.8 s'. */
const formatLength = (seconds) => `${(Math.round(Math.max(0, seconds) * 10) / 10).toFixed(1)} s`;

/** Bars x–y as text; a pickup (display null) reads 'Pickup'. */
function barsText(x, y) {
  if (x === y) return x === null ? 'Pickup' : `Bar ${x}`;
  if (x === null) return `Pickup–bar ${y}`;
  return `Bars ${x}–${y}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function createPositionModel({map, practice}) {
  if (!map) throw new TypeError('createPositionModel: map is required');
  const revision = signal(0);
  const mappedSig = signal(!!map.isReal);
  const sync = () => batch(() => {
    mappedSig.value = !!map.isReal;
    revision.value = revision.peek() + 1;
  });
  const off = typeof map.subscribe === 'function' ? map.subscribe(sync) : null;

  const duration = () => Math.max(0, map.duration || 0);
  /** Read the map through the signals so callers inside effects re-run on map changes. */
  const isMapped = () => { revision.value; mappedSig.value; return !!map.isReal; };
  const practiceValue = () => practice?.value?.value ?? null;

  // ---- markers (live, sorted) ------------------------------------------------
  let markerCache = {source: undefined, list: []};
  function liveMarkers() {
    const source = practiceValue()?.markers;
    if (markerCache.source === source) return markerCache.list;
    const list = (Array.isArray(source) ? source : [])
      .filter((m) => m && !m.deleted && Number.isFinite(m.t))
      .slice()
      .sort((a, b) => (a.t - b.t) || String(a.id).localeCompare(String(b.id)));
    markerCache = {source, list};
    return list;
  }

  // Regions are rebuilt only when their inputs change (the HUD asks up to 30 times a second).
  let markerRegionCache = {list: null, end: NaN, regions: []};
  function markerRegions() {
    const markers = liveMarkers(), end = duration();
    if (markerRegionCache.list === markers && markerRegionCache.end === end) return markerRegionCache.regions;
    const regions = markers.map((m, i) => Object.freeze({
      id: m.id, kind: 'marker', label: m.label, index: i,
      t0: m.t, t1: i + 1 < markers.length ? markers[i + 1].t : Math.max(end, m.t),
    }));
    markerRegionCache = {list: markers, end, regions};
    return regions;
  }

  let sectionCache = {revision: NaN, regions: []};
  function sectionRegions() {
    if (sectionCache.revision === map.revision) return sectionCache.regions;
    const bars = map.bars;
    const regions = map.sections.map((s) => Object.freeze({
      id: bars[s.startBar]?.id ?? `section-${s.index}`, kind: 'section', label: s.name, name: s.name,
      index: s.index, t0: s.t0, t1: s.t1, startBar: s.startBar, endBar: s.endBar, bars: s.bars,
    }));
    sectionCache = {revision: map.revision, regions};
    return regions;
  }

  /** A fresh array each call (callers may sort or filter it); the region objects are shared and frozen. */
  function regions() {
    return (isMapped() ? sectionRegions() : markerRegions()).slice();
  }

  function regionAt(t) {
    const end = duration();
    const time = end > 0 ? clamp(t, 0, end - EPS) : Math.max(0, t);
    if (isMapped()) {
      const section = map.sectionAt(time);
      if (!section) return null;
      return sectionRegions()[section.index] ?? null;
    }
    const list = markerRegions();
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (r.t0 <= time + EPS && (time < r.t1 - EPS || (i === list.length - 1 && time <= r.t1))) return r;
    }
    return null;
  }

  // ---- bars --------------------------------------------------------------------
  /** Index of the listed bar holding `t`, or -1 before bar 0. */
  function barAt(t) {
    const bars = map.bars;
    if (!bars.length || t < bars[0].t0 - EPS) return -1;
    return map.barIndexAt(t);
  }

  /** {first, last, display: [x, y]} of the bars a range [a, b) touches. */
  function barSpan(a, b) {
    const bars = map.bars;
    const first = barAt(a + EPS);
    const last = Math.max(first, barAt(Math.max(a + EPS, b - EDGE_EPS)));
    const x = first < 0 ? null : bars[first].display;
    const y = last < 0 ? null : bars[last].display;
    return {first, last, x, y};
  }

  function sectionMatching(a, b) {
    return map.sections.find((s) => Math.abs(s.t0 - a) <= EDGE_EPS && Math.abs(s.t1 - b) <= EDGE_EPS) ?? null;
  }

  /** Whole bars when both edges sit on bar lines, else null. */
  function wholeBars(a, b) {
    const bars = map.bars;
    if (!bars.length) return null;
    const i = bars.findIndex((bar) => Math.abs(bar.t0 - a) <= EDGE_EPS);
    if (i < 0) return null;
    for (let j = i; j < bars.length; j++) {
      if (Math.abs(bars[j].t1 - b) <= EDGE_EPS) return j - i + 1;
      if (bars[j].t1 > b + EDGE_EPS) break;
    }
    return null;
  }

  // ---- readouts ----------------------------------------------------------------
  function label(t) {
    const end = duration();
    const time = clamp(Number.isFinite(t) ? t : 0, 0, end || Infinity);
    if (!isMapped()) return {main: formatClock(time), sub: null};
    const bb = map.barBeatAt(time);
    const main = bb.pickup || bb.before || bb.display === null ? `Pickup · ${bb.beat}` : `${bb.display} · ${bb.beat}`;
    return {main, sub: `${formatClock(time)} / ${formatClock(end)}`};
  }

  function next(t) {
    if (isMapped()) {
      const upcoming = map.nextSection(t);
      if (!upcoming) return null;
      const {section, barsUntil, beatsUntil} = upcoming;
      const region = sectionRegions()[section.index] ?? null;
      if (barsUntil > 2) return {region, text: `next: ${section.name} · ${plural(barsUntil, 'bar')}`, imminent: false};
      const bpb = Math.max(1, map.barBeatAt(t).groups.length);
      const R = Math.max(1, beatsUntil);
      const B = Math.floor((R - 1) / bpb), b = ((R - 1) % bpb) + 1;
      return {region, text: B === 0 ? `${section.name} in ${b}` : `${section.name} in ${B} · ${b}`, imminent: true};
    }
    const upcoming = markerRegions().find((r) => r.t0 > t + EPS);
    if (!upcoming) return null;
    // A countdown: the remaining time rounds up, so it reads 0:01 until the marker arrives.
    return {region: upcoming, text: `next: ${upcoming.label} · ${formatClock(Math.ceil(upcoming.t0 - t - 1e-3))}`, imminent: false};
  }

  function againTarget(t) {
    return regionAt(t)?.t0 ?? null;
  }

  function stepTarget(t, kind, dir) {
    const end = duration();
    const sign = dir < 0 ? -1 : 1;
    if (!isMapped()) return clamp(t + sign * (UNMAPPED_STEP[kind] ?? UNMAPPED_STEP.bar), 0, end);
    const unit = kind === 'beat' ? 'beat' : 'bar';
    const target = sign > 0
      ? map.snapTime(t + 1e-3, unit, {mode: 'ceil'})
      : map.snapTime(t - 1e-3, unit, {mode: 'floor'});
    if (sign > 0 && target <= t + EPS) return end;   // nothing after the last line: the end
    return clamp(target, 0, end);
  }

  /**
   * Snap a time. Mapped: 'bar' / 'beat' / 'unit' to the nearest line, 'tenth' to 0.1 s.
   * Unmapped (no grid): 'bar' and 'tenth' to 0.1 s (loop edges, spec §4.8), 'beat' and
   * 'unit' keep the exact time (a cue lands where it was tapped, spec §4.9).
   */
  function snap(t, unit) {
    const end = duration();
    const tenth = () => clamp(Math.round(t * 10) / 10, 0, end);
    if (unit === 'tenth') return tenth();
    if (!isMapped()) return unit === 'bar' ? tenth() : clamp(t, 0, end);
    return clamp(map.snapTime(t, unit === 'unit' ? 'unit' : unit === 'beat' ? 'beat' : 'bar'), 0, end);
  }

  /** The loop's own name: 'Chorus' | 'Bars 13–20' | '0:31.2–0:41.0' (TransportState.loop.label). */
  function loopLabel(a, b) {
    if (!isMapped()) return `${formatTenths(a)}–${formatTenths(b)}`;
    const section = sectionMatching(a, b);
    if (section) return section.name;
    const {x, y} = barSpan(a, b);
    return barsText(x, y);
  }

  /** The range for the Loop card: 'Bars 13–20 · Chorus (8 bars)' | '0:31.2–0:41.0 (9.8 s)'. */
  function rangeLabel(a, b) {
    if (!isMapped()) return `${formatTenths(a)}–${formatTenths(b)} (${formatLength(b - a)})`;
    const {x, y} = barSpan(a, b);
    const bars = barsText(x, y);
    const whole = wholeBars(a, b);
    const size = whole === null ? formatLength(b - a) : plural(whole, 'bar');
    const section = sectionMatching(a, b);
    return section ? `${bars} · ${section.name} (${size})` : `${bars} (${size})`;
  }

  /**
   * The loop a bare toggle makes (transport rule 13): the current section; else the
   * current 4-bar phrase; unmapped, 10 s around t (shifted to stay inside the song).
   */
  function loopDefault(t) {
    const end = duration();
    if (isMapped()) {
      const bars = map.bars;
      const section = map.hasSections ? map.sectionAt(t) : null;
      if (section) return {a: section.t0, b: section.t1, label: section.name};
      const {startBar, endBar} = map.phraseAt(t);
      const a = bars[startBar].t0, b = bars[endBar].t1;
      return {a, b, label: loopLabel(a, b)};
    }
    const span = Math.min(2 * UNMAPPED_LOOP_HALF, end);
    const a = clamp(t - UNMAPPED_LOOP_HALF, 0, Math.max(0, end - span));
    const b = Math.min(end, a + span);
    return {a, b, label: loopLabel(a, b)};
  }

  function markerTicks() {
    return liveMarkers().map((m) => ({id: m.id, t: m.t, label: m.label}));
  }

  function ref(t) {
    if (!isMapped()) return null;
    return map.refAt(t) ?? null;
  }

  function resolve(barRef) {
    if (!barRef) return null;
    revision.value;
    return map.timeOfRef(barRef);
  }

  return {
    mapped: readonly(mappedSig),
    /** Bumps on every map change (the map emits no signal of its own). */
    revision: readonly(revision),
    label, regions, markerTicks, regionAt, next, againTarget, stepTarget, snap,
    loopDefault, loopLabel, rangeLabel, ref, resolve,
    /** Re-read `map.isReal` (after `map.setHasPart`, which emits no event). */
    refresh: sync,
    dispose() { off?.(); },
  };
}

export default createPositionModel;
