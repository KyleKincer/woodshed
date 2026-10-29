/**
 * The song map: one run of bars for the whole recording, some of whose bar
 * lines or beats are pinned to audio times. Tempo is never stored between
 * pins; it is derived from them. Editing meter or bar numbering therefore
 * never moves a pin, and a miscounted bar shows up as an odd derived tempo.
 */
import {type Fraction,type Measure,type Timeline,fraction,number,add,subtract,compare,beatGroups,id,MAX_MEASURES} from './notation';

export type Pin = {position:Fraction; time:number; ramp?:boolean};
/** How a map became real: written by every edit, detection, tap and import (spec §1.1). */
export const ORIGINS = ['detected', 'tapped', 'imported', 'edited'] as const;
export type Origin = typeof ORIGINS[number];
export const isOrigin = (value:unknown):value is Origin => (ORIGINS as readonly unknown[]).includes(value);
export type SongMapData = {version:1; measures:Measure[]; pins:Pin[]; tailQpm?:number; origin?:Origin};
export type Span = {p0:number; p1:number; t0:number; t1:number; v0:number; v1:number; ramp:boolean};
export type Compiled = {pins:Pin[]; spans:Span[]; head:number; tail:number};
export type Beat = {time:number; downbeat:boolean; bar:number; beat:number; q:number};

export const MAX_PINS = 8000;
export const MIN_QPM = 10, MAX_QPM = 1000;
const EPS = 1e-9;
const clamp = (n:number, a:number, b:number) => Math.max(a, Math.min(b, n));
const clone = <T>(value:T):T => structuredClone(value);
// The Convex target predates Array.prototype.at.
const final = <T>(list:T[]):T|undefined => list[list.length - 1];

export function fullLength(m:{numerator:number; denominator:number}) { return fraction(4 * m.numerator, m.denominator); }
export function measureStarts(measures:Measure[]) { let q = fraction(0); return measures.map(m => { const start = q; q = add(q, m.length); return start; }); }
export function extentOf(data:SongMapData) { return data.measures.reduce((q, m) => add(q, m.length), fraction(0)); }

/** The counted pulse, in quarter notes: dotted quarter in 6/8, eighth in 7/8 (2+2+3). */
export function pulseOf(measure:Measure) {
  const groups = beatGroups(measure);
  return groups.every(g => g === groups[0]) ? groups[0] * 4 / measure.denominator : 4 / measure.denominator;
}

// For a ramp whose tempo changes linearly over musical position from v0 to v1,
// the span's duration is Q·ln(v1/v0)/(v1−v0), symmetric in v0 and v1. Given
// one end's tempo and the pins, solve for the other end.
function solveRampEnd(v0:number, quarters:number, seconds:number) {
  const target = seconds * v0 / quarters, g = (x:number) => Math.abs(x) < 1e-9 ? 1 - x / 2 : x / Math.expm1(x);
  if (Math.abs(target - 1) < 1e-9) return v0;
  let low = -12, high = 12;
  for (let i = 0; i < 80; i++) { const mid = (low + high) / 2; if (g(mid) > target) low = mid; else high = mid; }
  return v0 * Math.exp((low + high) / 2);
}

export function compile(data:SongMapData):Compiled {
  const pins = [...data.pins].sort((a, b) => compare(a.position, b.position));
  const spans:Span[] = [];
  for (let i = 0; i + 1 < pins.length; i++) {
    const a = pins[i], b = pins[i + 1], p0 = number(a.position), p1 = number(b.position), t0 = a.time, t1 = b.time;
    const average = (p1 - p0) / (t1 - t0), previous = spans[i - 1];
    const c = pins[i + 2], next = c && !b.ramp ? (number(c.position) - p1) / (c.time - t1) : null;
    // A ramp leaves the tempo before it; the first span instead lands on the tempo after it.
    if (a.ramp && previous) spans.push({p0, p1, t0, t1, v0: previous.v1, v1: solveRampEnd(previous.v1, p1 - p0, t1 - t0), ramp: true});
    else if (a.ramp && next) spans.push({p0, p1, t0, t1, v0: solveRampEnd(next, p1 - p0, t1 - t0), v1: next, ramp: true});
    else spans.push({p0, p1, t0, t1, v0: average, v1: average, ramp: false});
  }
  const tailQps = data.tailQpm ? data.tailQpm / 60 : null;
  const tail = tailQps ?? final(spans)?.v1 ?? 2;
  const head = spans[0]?.v0 ?? tail;
  return {pins, spans, head, tail};
}

function spanIndexAt(c:Compiled, value:number, key:'p0'|'t0') {
  let low = 0, high = c.spans.length - 1, found = -1;
  while (low <= high) { const mid = (low + high) >> 1; if (c.spans[mid][key] <= value + EPS) { found = mid; low = mid + 1; } else high = mid - 1; }
  return found;
}

export function timeAt(c:Compiled, q:number) {
  const first = c.pins[0], last = final(c.pins)!;
  if (q < number(first.position)) return first.time + (q - number(first.position)) / c.head;
  if (q >= number(last.position)) return last.time + (q - number(last.position)) / c.tail;
  const s = c.spans[Math.max(0, spanIndexAt(c, q, 'p0'))], k = (s.v1 - s.v0) / (s.p1 - s.p0);
  if (Math.abs(k) < 1e-12) return s.t0 + (q - s.p0) / s.v0;
  return s.t0 + Math.log((s.v0 + k * (q - s.p0)) / s.v0) / k;
}

export function positionAt(c:Compiled, t:number) {
  const first = c.pins[0], last = final(c.pins)!;
  if (t < first.time) return number(first.position) + (t - first.time) * c.head;
  if (t >= last.time) return number(last.position) + (t - last.time) * c.tail;
  const s = c.spans[Math.max(0, spanIndexAt(c, t, 't0'))], k = (s.v1 - s.v0) / (s.p1 - s.p0);
  if (Math.abs(k) < 1e-12) return s.p0 + (t - s.t0) * s.v0;
  return s.p0 + s.v0 * Math.expm1(k * (t - s.t0)) / k;
}

/** Quarter notes per second at a musical position. */
export function velocityAt(c:Compiled, q:number) {
  const first = c.pins[0], last = final(c.pins)!;
  if (q < number(first.position)) return c.head;
  if (q >= number(last.position)) return c.tail;
  const s = c.spans[Math.max(0, spanIndexAt(c, q, 'p0'))];
  return s.v0 + (s.v1 - s.v0) * (q - s.p0) / (s.p1 - s.p0);
}

export function barIndexAt(data:SongMapData, q:number, starts = measureStarts(data.measures)) {
  let low = 0, high = starts.length - 1, found = 0;
  while (low <= high) { const mid = (low + high) >> 1; if (number(starts[mid]) <= q + EPS) { found = mid; low = mid + 1; } else high = mid - 1; }
  return found;
}

/** Every counted pulse inside the recording, with exact bar/beat numbering. */
export function beatsOf(data:SongMapData, c:Compiled, duration:number):Beat[] {
  const beats:Beat[] = [], starts = measureStarts(data.measures);
  data.measures.forEach((m, bar) => {
    const start = number(starts[bar]), length = number(m.length), groups = beatGroups(m);
    // A short first bar is a pickup: no accent, counted from the end of the bar.
    const pickup = bar === 0 && length < number(fullLength(m)) - 1e-9;
    let q = 0, beat = 1;
    if (pickup) { let fits = 0, end = 0; for (const g of groups) { if (end >= length - 1e-7) break; end += g * 4 / m.denominator; fits++; } beat = groups.length - fits + 1; }
    for (const group of groups) {
      if (q >= length - 1e-7) break;
      const time = timeAt(c, start + q);
      if (time >= 0 && time < duration) beats.push({time, downbeat: q === 0 && !pickup, bar, beat, q: start + q});
      q += group * 4 / m.denominator; beat++;
    }
  });
  return beats;
}

/** Bars, beats and pins keyed to positions in the map, for navigation. */
export function linesOf(data:SongMapData) {
  const starts = measureStarts(data.measures), lines:{q:Fraction; bar:number; beat:number; downbeat:boolean}[] = [];
  data.measures.forEach((m, bar) => {
    let q = fraction(0), beat = 1;
    for (const group of beatGroups(m)) {
      if (compare(q, m.length) >= 0) break;
      lines.push({q: add(starts[bar], q), bar, beat, downbeat: beat === 1});
      q = add(q, fraction(group * 4, m.denominator)); beat++;
    }
  });
  return lines;
}

// ---- validation -----------------------------------------------------------
function validFraction(f:unknown):f is Fraction {
  const v = f as Fraction;
  return !!v && Number.isSafeInteger(v.n) && Number.isSafeInteger(v.d) && v.d >= 1 && v.d <= 1e6 && Math.abs(v.n) <= 1e8;
}
export function validateSongMap(data:SongMapData) {
  if (!data || data.version !== 1 || !Array.isArray(data.measures) || !Array.isArray(data.pins)) throw new Error('Invalid song map.');
  if (!data.measures.length || data.measures.length > MAX_MEASURES) throw new Error('The song map has too many bars.');
  if (!data.pins.length || data.pins.length > MAX_PINS) throw new Error('The song map needs between one and 8000 pins.');
  const ids = new Set<string>();
  for (const m of data.measures) {
    if (typeof m.id !== 'string' || !m.id || m.id.length > 80 || ids.has(m.id) || !Number.isInteger(m.numerator) || m.numerator < 1 || m.numerator > 16 || ![1, 2, 4, 8, 16].includes(m.denominator) || typeof m.label !== 'string' || m.label.length > 120 || !validFraction(m.length)) throw new Error('Invalid bar in the song map.');
    if (number(m.length) <= 0 || number(m.length) > number(fullLength(m)) + 1e-9) throw new Error('Invalid bar length.');
    if (m.grouping && (!Array.isArray(m.grouping) || !m.grouping.length || m.grouping.length > 16 || m.grouping.some(n => !Number.isInteger(n) || n < 1) || m.grouping.reduce((a, b) => a + b, 0) !== m.numerator)) throw new Error('Beat groups must add up to the meter numerator.');
    ids.add(m.id);
  }
  let p = -Infinity, t = -Infinity;
  for (const pin of [...data.pins].sort((a, b) => compare(a.position, b.position))) {
    if (!validFraction(pin.position) || !Number.isFinite(pin.time) || pin.time < 0 || number(pin.position) <= p || pin.time <= t + 1e-4) throw new Error('Pins must move forward in both bars and recording time.');
    if (pin.ramp !== undefined && typeof pin.ramp !== 'boolean') throw new Error('Invalid pin.');
    p = number(pin.position); t = pin.time;
  }
  if (data.tailQpm !== undefined && (!Number.isFinite(data.tailQpm) || data.tailQpm < MIN_QPM || data.tailQpm > MAX_QPM)) throw new Error('Choose a tempo between 10 and 1000 BPM.');
  if (data.origin !== undefined && !isOrigin(data.origin)) throw new Error('Invalid song map origin.');
  const c = compile(data);
  // Steady spans may be any positive tempo (a gap between two sections has no clicks); ramps must stay playable.
  for (const s of c.spans) if (s.ramp && !(s.v0 * 60 >= MIN_QPM / 4 && s.v1 * 60 >= MIN_QPM / 4 && s.v0 * 60 <= MAX_QPM * 4 && s.v1 * 60 <= MAX_QPM * 4)) throw new Error('That ramp needs an impossible tempo. Move a pin or remove the ramp.');
}

/**
 * Keep only known fields so stored maps cannot carry arbitrary data. An
 * unknown `origin` is dropped silently: it never fails the whole map.
 */
export function cleanSongMap(value:unknown):SongMapData|null {
  try {
    const raw = value as SongMapData;
    const data:SongMapData = {version: 1,
      measures: raw.measures.map(m => ({id: String(m.id), numerator: m.numerator, denominator: m.denominator, length: {n: m.length.n, d: m.length.d}, label: String(m.label ?? ''), ...(Array.isArray(m.grouping) ? {grouping: m.grouping.map(Number)} : {})})),
      pins: raw.pins.map(p => ({position: {n: p.position.n, d: p.position.d}, time: p.time, ...(p.ramp ? {ramp: true} : {})})),
      ...(typeof raw.tailQpm === 'number' ? {tailQpm: raw.tailQpm} : {}),
      ...(isOrigin(raw.origin) ? {origin: raw.origin} : {})};
    validateSongMap(data);
    return data;
  } catch { return null; }
}

// ---- normalization --------------------------------------------------------
function newMeasure(like:Measure):Measure {
  return {id: id(), numerator: like.numerator, denominator: like.denominator, length: fullLength(like), label: '', ...(like.grouping ? {grouping: [...like.grouping]} : {})};
}
/** Bars always cover the recording: extend with the last meter, trim empty bars past the end. */
export function normalize(data:SongMapData, duration:number, keep:(id:string)=>boolean = () => false) {
  data.pins.sort((a, b) => compare(a.position, b.position));
  const lastPin = number(final(data.pins)!.position);
  let c = compile(data), end = extentOf(data);
  while (data.measures.length < MAX_MEASURES && (timeAt(c, number(end)) < duration - 1e-6 || number(end) <= lastPin)) {
    const m = newMeasure(final(data.measures)!); data.measures.push(m); end = add(end, m.length);
  }
  while (data.measures.length > 1) {
    const m = final(data.measures)!, start = subtract(end, m.length);
    if (keep(m.id) || number(start) <= lastPin || timeAt(c, number(start)) < duration - 1e-6) break;
    data.measures.pop(); end = start;
  }
  return data;
}

// ---- construction ---------------------------------------------------------
export function defaultSongMap(duration:number, qpm = 120, numerator = 4, denominator = 4, firstDownbeat = 0):SongMapData {
  const measure = {id: id(), numerator, denominator, length: fraction(4 * numerator, denominator), label: ''};
  return normalize({version: 1, measures: [measure], pins: [{position: fraction(0), time: Math.max(0, firstDownbeat)}], tailQpm: qpm}, duration);
}

type LegacySection = {t:number; bpm:number; beatsPerBar:number; unit:number};
/**
 * Legacy manual sections clicked every 60/bpm seconds, grouped by beatsPerBar,
 * restarting at each section. Pin each section start and its final pulse so
 * every click stays exactly where it was; a short final bar keeps its pulses.
 */
export function fromSections(sections:LegacySection[], duration:number):SongMapData {
  const list = [...sections].filter(s => Number.isFinite(s.t) && s.t >= 0 && s.t < Math.max(duration, 1e-3)).sort((a, b) => a.t - b.t);
  if (!list.length) return defaultSongMap(duration);
  const measures:Measure[] = [], pins:Pin[] = [];
  let q = fraction(0), tailQpm = 120;
  list.forEach((s, i) => {
    const bpm = clamp(+s.bpm || 120, 20, 400), n = clamp(Math.round(s.beatsPerBar) || 4, 1, 16), unit = [1, 2, 4, 8, 16].includes(s.unit) ? s.unit : 4;
    const pulse = fraction(4, unit), interval = 60 / bpm, end = list[i + 1]?.t ?? duration;
    const count = Math.max(1, Math.ceil((end - s.t - 1e-6) / interval));
    if (pins.length && s.t <= final(pins)!.time + 1e-3) return;
    pins.push({position: q, time: s.t});
    const lastPulse = add(q, fraction(4 * (count - 1), unit)), lastTime = s.t + (count - 1) * interval;
    if (count > 1 && i + 1 < list.length && lastTime < end - 2e-3) pins.push({position: lastPulse, time: lastTime});
    for (let left = count; left > 0; left -= n) {
      const beats = Math.min(n, left);
      measures.push({id: id(), numerator: n, denominator: unit, length: fraction(4 * beats, unit), label: '', grouping: Array(n).fill(1)});
      q = add(q, fraction(4 * beats, unit));
    }
    tailQpm = bpm * number(pulse);
  });
  // The last bar runs on past the recording, so it is a full bar.
  const lastBar = final(measures)!; lastBar.length = fullLength(lastBar);
  return normalize({version: 1, measures, pins, tailQpm: clamp(tailQpm, MIN_QPM, MAX_QPM)}, duration);
}

/** Detected or tapped beats become one pin per beat; downbeats define bars. */
export function fromBeats(input:{time:number; downbeat:boolean}[], duration:number):SongMapData {
  const beats = input.filter(b => Number.isFinite(b.time) && b.time >= 0 && b.time < duration).sort((a, b) => a.time - b.time).filter((b, i, a) => !i || b.time > a[i - 1].time + 1e-3);
  if (beats.length < 2) return defaultSongMap(duration, 120, 4, 4, beats[0]?.time ?? 0);
  const measures:Measure[] = [], pins:Pin[] = [];
  let q = fraction(0), begin = 0, nominal = 4;
  const downbeats = beats.map((b, i) => b.downbeat ? i : -1).filter(i => i >= 0);
  if (downbeats.length > 1) nominal = clamp(downbeats[1] - downbeats[0], 1, 16);
  while (begin < beats.length) {
    const next = beats.findIndex((b, i) => i > begin && b.downbeat), end = next < 0 ? beats.length : next, count = end - begin;
    const pickup = begin === 0 && !beats[0].downbeat;
    const take = count > 16 ? nominal : count, n = next >= 0 && count <= 16 ? count : Math.max(take, nominal);
    if (!pickup && next >= 0 && count <= 16) nominal = count;
    const numerator = pickup ? Math.max(n, nominal) : n;
    measures.push({id: id(), numerator, denominator: 4, length: fraction(4 * (next < 0 ? Math.max(take, 1) : take), 4), label: pickup ? 'Pickup' : '', grouping: Array(numerator).fill(1)});
    for (let i = 0; i < take; i++) pins.push({position: add(q, fraction(i)), time: beats[begin + i].time});
    q = add(q, final(measures)!.length); begin += take;
  }
  // The open end keeps the last measure full so the grid continues naturally.
  const last = final(measures)!; last.length = fullLength(last);
  return normalize({version: 1, measures, pins}, duration);
}

export function fromTimeline(timeline:Timeline, duration:number):SongMapData {
  // Drum-part anchors only had to increase; pins also need a little room between them.
  const pins:Pin[] = [];
  for (const a of timeline.anchors) if (!pins.length || a.time > final(pins)!.time + 1e-3) pins.push({position: clone(a.position), time: a.time});
  const data:SongMapData = {version: 1, measures: clone(timeline.measures), pins: pins.slice(0, MAX_PINS)};
  return normalize(data, duration, () => true);
}

/**
 * The drum part's timeline. Ramps become dense anchors (every eighth note)
 * so piecewise-linear notation timing stays within about a millisecond.
 */
export function toTimeline(data:SongMapData):Timeline {
  const c = compile(data), anchors:{position:Fraction; time:number}[] = [];
  c.pins.forEach((pin, i) => {
    anchors.push({position: clone(pin.position), time: pin.time});
    const s = c.spans[i];
    if (s?.ramp) for (let q = add(pin.position, fraction(1, 2)); number(q) < s.p1 - 1e-6; q = add(q, fraction(1, 2))) anchors.push({position: q, time: timeAt(c, number(q))});
  });
  const last = final(c.pins)!, after = add(last.position, fraction(4));
  anchors.push({position: after, time: timeAt(c, number(after))});
  return {version: 1, measures: clone(data.measures), anchors: anchors.slice(0, 8192)};
}

// ---- edits (pure; callers clone, normalize and validate) -------------------
export function findPin(data:SongMapData, q:Fraction) { return data.pins.findIndex(p => compare(p.position, q) === 0); }

/** Place a pin; conflicting pins (out of order in time) are replaced when allowed. */
export function pin(data:SongMapData, q:Fraction, time:number, replace = false) {
  time = Math.max(0, time);
  const lastBefore = data.pins.length ? data.pins.reduce((a, b) => compare(a.position, b.position) > 0 ? a : b).position : null;
  const conflicts = data.pins.filter(p => compare(p.position, q) !== 0 && (compare(p.position, q) < 0 ? p.time >= time - 1e-3 : p.time <= time + 1e-3));
  if (conflicts.length && !replace) throw new Error('That would put this pin out of order with its neighbours.');
  const existing = data.pins.find(p => compare(p.position, q) === 0);
  data.pins = data.pins.filter(p => !conflicts.includes(p) && p !== existing);
  data.pins.push({position: clone(q), time, ...(existing?.ramp ? {ramp: true} : {})});
  data.pins.sort((a, b) => compare(a.position, b.position));
  if (!lastBefore || compare(q, lastBefore) > 0) delete data.tailQpm;
  return conflicts.length;
}

export function unpin(data:SongMapData, q:Fraction) {
  const index = findPin(data, q);
  if (index < 0) return false;
  if (data.pins.length === 1) throw new Error('The map needs at least one pin.');
  data.pins.splice(index, 1);
  return true;
}

/** Give an existing pin a different bar number, keeping its recording time. */
export function renumberPin(data:SongMapData, from:Fraction, to:Fraction) {
  const index = findPin(data, from);
  if (index < 0) throw new Error('Select a pinned line first.');
  const [low, high] = compare(from, to) < 0 ? [from, to] : [to, from];
  if (data.pins.some((p, i) => i !== index && compare(p.position, low) >= 0 && compare(p.position, high) <= 0)) throw new Error('Another pin is in the way. Remove it first.');
  if (number(to) < 0) throw new Error('Bar 1 is the first bar.');
  data.pins[index].position = clone(to);
  return data.pins[index];
}

/**
 * Change bars while every pin stays attached to its own bar line or beat.
 * Pins inside a bar that became too short are removed and counted.
 */
export function editBars(data:SongMapData, from:number, to:number, patch:(m:Measure, index:number)=>void) {
  const starts = measureStarts(data.measures), relative = data.pins.map(p => {
    const q = number(p.position);
    if (q < 0) return {pin: p, bar: -1, offset: p.position};
    const bar = barIndexAt(data, q, starts);
    return {pin: p, bar, offset: subtract(p.position, starts[bar])};
  });
  for (let i = from; i <= to; i++) patch(data.measures[i], i);
  const next = measureStarts(data.measures);
  let dropped = 0;
  data.pins = relative.flatMap(({pin, bar, offset}) => {
    if (bar < 0) return [pin];
    const m = data.measures[bar];
    if (bar < data.measures.length - 1 && compare(offset, m.length) >= 0) { dropped++; return []; }
    return [{...pin, position: add(next[bar], offset)}];
  });
  return dropped;
}

/**
 * Re-bar without moving any beat: bars change, every pin keeps its musical
 * position (and so its time), and later bar lines slide to wherever the new
 * bars put them. Use when the beats are right but a bar line is in the wrong place.
 */
export function rebarBars(data:SongMapData, from:number, to:number, patch:(m:Measure, index:number)=>void) {
  for (let i = from; i <= to; i++) patch(data.measures[i], i);
  return 0;
}

/** True when beats (not just bar lines) are pinned in or right after these bars. */
export function beatsPinnedNear(data:SongMapData, from:number, to:number) {
  const starts = measureStarts(data.measures), a = number(starts[from]), endBar = Math.min(data.measures.length - 1, to + 1);
  const b = number(starts[endBar]) + number(data.measures[endBar].length);
  const bars = new Set(starts.map((q) => number(q)));
  return data.pins.some((p) => { const q = number(p.position); return q >= a - 1e-9 && q < b - 1e-9 && !bars.has(q); });
}

export const sameMeter = (a:Measure, b:Measure) => a.numerator === b.numerator && a.denominator === b.denominator && beatGroups(a).join('+') === beatGroups(b).join('+');

/** Bars from `index` up to (not including) the next meter change. */
export function meterRun(data:SongMapData, index:number) {
  let end = index;
  while (end + 1 < data.measures.length && sameMeter(data.measures[end + 1], data.measures[index])) end++;
  return end;
}

export function setMeter(m:Measure, numerator:number, denominator:number, grouping?:number[]) {
  m.numerator = numerator; m.denominator = denominator;
  if (grouping && grouping.length > 1 && grouping.reduce((a, b) => a + b, 0) === numerator) m.grouping = grouping; else delete m.grouping;
  m.length = fullLength(m);
}

/** Reinterpret the counted tempo (double/half time) without moving any pin in time. */
export function scaleTempo(data:SongMapData, factor:number) {
  const f = factor >= 1 ? fraction(Math.round(factor)) : fraction(1, Math.round(1 / factor));
  data.pins = data.pins.map(p => ({...p, position: fraction(p.position.n * f.n, p.position.d * f.d)}));
  if (data.tailQpm) data.tailQpm = clamp(data.tailQpm * number(f), MIN_QPM, MAX_QPM);
}

// ---- the real-map rule and the one-way upgrade (architecture §4.1) ---------
type TempoRecord = {songMap?:unknown; source?:unknown; detected?:unknown; map?:unknown};
const asTempo = (tempo:unknown):TempoRecord|null => tempo && typeof tempo === 'object' ? tempo as TempoRecord : null;
const isPlainFourFour = (m:Measure) => m.numerator === 4 && m.denominator === 4 && compare(m.length, fraction(4)) === 0 && (!m.grouping || m.grouping.every(g => g === 1));
/** Measure 0's `'Pickup'` label is written by `fromBeats`; it never names a section. */
const isAutoLabel = (label:string, index:number) => index === 0 && label === 'Pickup';
const legacyDetected = (t:TempoRecord|null) => t?.source === 'detected' && Array.isArray(t.detected) && t.detected.length >= 2;
const legacySections = (t:TempoRecord|null) => Array.isArray(t?.map) && (t!.map as unknown[]).length > 0;

/** A 1.6–1.9 map (stored without `origin`) that someone actually made: rule 3 of `hasRealMap`. */
export function isMadeLegacyMap(data:SongMapData):boolean {
  if (data.pins.length > 1) return true;
  if (data.measures.some((m, i) => m.label.trim() !== '' && !isAutoLabel(m.label, i))) return true;
  const only = data.pins[0];
  return only.time !== 0 || only.position.n !== 0 || (data.tailQpm !== undefined && Math.abs(data.tailQpm - 120) > 1e-9) || data.measures.some(m => !isPlainFourFour(m));
}

/**
 * True when the song has a map someone made: detected, tapped, imported or
 * edited (spec §1.1). The first matching rule decides; `tempo.source` and
 * `tempo.detected` are noise whenever a valid `songMap` exists.
 */
export function hasRealMap(tempo:unknown, {hasPart = false}:{hasPart?:boolean} = {}):boolean {
  const t = asTempo(tempo), stored = cleanSongMap(t?.songMap);
  if (stored?.origin) return true;
  if (hasPart) return true;
  if (stored) return isMadeLegacyMap(stored);
  // Rule 4 is decided by the upgrade itself, so the Library and a loaded store never disagree.
  return legacyDetected(t) || legacySections(t) ? !!legacyTranslation(t, 0.001) : false;
}

/** Legacy times reach past `seconds` when the duration is unknown (0 on the server) or short: translate over a span that covers them. */
function legacySpan(t:TempoRecord, seconds:number) {
  const times = [...(Array.isArray(t.detected) ? t.detected : []), ...(Array.isArray(t.map) ? t.map : [])]
    .map(x => Number((x as {time?:unknown; t?:unknown})?.time ?? (x as {t?:unknown})?.t)).filter(Number.isFinite);
  return Math.max(seconds, ...times.map(x => x + 1));
}

/** A legacy `detected` list or `map` translated (detected first, then the map), or null when neither is usable. */
function legacyTranslation(t:TempoRecord|null, seconds:number):SongMapData|null {
  if (!t) return null;
  const spans = [seconds, legacySpan(t, seconds)];
  if (legacyDetected(t)) {
    const beats = (t.detected as {time?:unknown; downbeat?:unknown}[]).map(b => ({time: Number(b?.time), downbeat: !!b?.downbeat}));
    for (const span of spans) {
      try {
        const data = fromBeats(beats, span);
        validateSongMap(data);
        if (data.pins.length >= 2) return {...data, origin: 'detected'};
      } catch { /* try the next span, then the legacy map */ }
    }
  }
  if (legacySections(t)) {
    const sections = t.map as {t:number; bpm:number; beatsPerBar:number; unit:number}[];
    for (const span of spans) {
      if (!sections.some(s => Number.isFinite(s?.t) && s.t >= 0 && s.t < Math.max(span, 1e-3))) continue;
      try {
        const data = fromSections(sections, span);
        validateSongMap(data);
        return {...data, origin: 'edited'};
      } catch { /* an unreadable legacy map falls back to the placeholder */ }
    }
  }
  return null;
}

/**
 * The map a stored tempo describes, upgraded once: a 1.6–1.9 map that passes
 * rule 3 becomes `edited`, a legacy `detected` translation `detected`, a
 * legacy `map` translation `edited`; the placeholder has no origin.
 */
export function songMapFromTempo(tempo:unknown, duration:number):SongMapData {
  const t = asTempo(tempo), seconds = Math.max(0.001, duration || 0), stored = cleanSongMap(t?.songMap);
  if (stored) { if (!stored.origin && isMadeLegacyMap(stored)) stored.origin = 'edited'; return stored; }
  return legacyTranslation(t, seconds) ?? defaultSongMap(seconds);
}

// ---- bars and sections (architecture §4.3) --------------------------------
export type MapBar = {index:number; id:string; display:number|null; q0:number; q1:number; t0:number; t1:number;
  numerator:number; denominator:number; groups:number[]; units:number; label:string; pickup:boolean; meterChange:boolean;
  qpm:number; bpm:number; tempoChange:boolean};
export type MapSection = {index:number; label:string; name:string; startBar:number; endBar:number; t0:number; t1:number; bars:number};
export const START_SECTION = 'Start';
const sum = (list:number[]) => list.reduce((a, b) => a + b, 0);

/** Measure 0 shorter than a full bar is a pickup: it displays as "Pickup" and measure 1 is bar 1. */
export function hasPickup(data:SongMapData) {
  const m = data.measures[0];
  return !!m && number(m.length) < number(fullLength(m)) - 1e-9;
}

/** Bars starting inside the recording (always at least bar 0), with display numbers, meter and tempo. */
export function barsOf(data:SongMapData, duration:number, c:Compiled = compile(data)):MapBar[] {
  const bars:MapBar[] = [], pickup = hasPickup(data), starts = measureStarts(data.measures);
  for (let i = 0; i < data.measures.length; i++) {
    const m = data.measures[i], q0 = number(starts[i]), q1 = q0 + number(m.length), t0 = timeAt(c, q0);
    if (i > 0 && t0 >= duration) break;
    const groups = beatGroups(m), qpm = velocityAt(c, q0) * 60, bpm = qpm / pulseOf(m), prev = final(bars);
    bars.push({index: i, id: m.id, display: pickup ? (i === 0 ? null : i) : i + 1, q0, q1, t0, t1: timeAt(c, q1),
      numerator: m.numerator, denominator: m.denominator, groups, units: sum(groups), label: m.label, pickup: pickup && i === 0,
      meterChange: !!prev && !sameMeter(data.measures[i - 1], m), qpm, bpm, tempoChange: !!prev && Math.abs(bpm - prev.bpm) > 1});
  }
  const last = final(bars)!;
  last.t1 = Math.max(last.t0, Math.min(last.t1, duration));
  return bars;
}

/** The section label a bar starts, or '' (measure 0's auto `'Pickup'` label is ignored). */
export const sectionLabelOf = (bar:{index:number; label:string}) => isAutoLabel(bar.label, bar.index) ? '' : bar.label.trim();

/**
 * Display names: a repeated label is numbered ('Chorus', 'Chorus 2'), never
 * colliding with a label in use. Written labels are named first; the
 * synthetic leading section ('' here) is "Start", or the next free "Start N"
 * when the user wrote a "Start" of their own.
 */
function numberNames(labels:string[]) {
  const reserved = new Set(labels.filter(Boolean)), used = new Set<string>(), seen = new Map<string, number>();
  const free = (label:string, from:number) => { let n = from; while (reserved.has(`${label} ${n}`) || used.has(`${label} ${n}`)) n++; return `${label} ${n}`; };
  const names = labels.map(label => {
    if (!label) return '';
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    const name = count > 1 ? free(label, count) : label;
    used.add(name);
    return name;
  });
  return names.map((name, i) => {
    if (labels[i]) return name;
    const start = reserved.has(START_SECTION) || used.has(START_SECTION) ? free(START_SECTION, 2) : START_SECTION;
    used.add(start);
    return start;
  });
}

/** Sections from listed bars: every labelled bar starts one; unlabelled leading bars form "Start". */
export function sectionsFromBars(bars:MapBar[]):MapSection[] {
  const heads = bars.filter(b => sectionLabelOf(b) !== '').map(bar => ({bar, label: sectionLabelOf(bar)}));
  if (!heads.length) return [];
  if (heads[0].bar.index !== bars[0].index) heads.unshift({bar: bars[0], label: ''});
  const names = numberNames(heads.map(h => h.label)), last = final(bars)!;
  return heads.map((h, i) => {
    const next = heads[i + 1], endBar = next ? next.bar.index - 1 : last.index;
    return {index: i, label: h.label, name: names[i], startBar: h.bar.index, endBar, t0: h.bar.t0, t1: next ? next.bar.t0 : last.t1, bars: endBar - h.bar.index + 1};
  });
}

export function sectionsOf(data:SongMapData, duration:number):MapSection[] { return sectionsFromBars(barsOf(data, duration)); }

/** The Library's view of a song's map (B1): computed on the server only through this function. */
export function mapSummaryOf(tempo:unknown, duration:number, {hasPart = false}:{hasPart?:boolean} = {}):{real:boolean; bpm?:number; meter?:string; sections:string[]} {
  if (!hasRealMap(tempo, {hasPart})) return {real: false, sections: []};
  const seconds = Math.max(0.001, duration || 0), bars = barsOf(songMapFromTempo(tempo, seconds), seconds);
  const full = bars.filter(b => !b.pickup), counted = full.length ? full : bars;
  const tempos = counted.map(b => b.bpm).sort((a, b) => a - b), middle = tempos.length >> 1;
  const bpm = tempos.length % 2 ? tempos[middle] : (tempos[middle - 1] + tempos[middle]) / 2;
  const meters = new Map<string, number>();
  for (const b of counted) { const key = `${b.numerator}/${b.denominator}`; meters.set(key, (meters.get(key) ?? 0) + 1); }
  let meter = '', most = 0;
  meters.forEach((count, key) => { if (count > most) { meter = key; most = count; } });
  return {real: true, bpm: Math.round(bpm), meter, sections: sectionsFromBars(bars).map(s => s.name).slice(0, 64)};
}

// ---- Tap the beat (architecture §4.6) -------------------------------------
function fitLine(points:[number, number][]) {
  let n = 0, sk = 0, st = 0, skk = 0, skt = 0;
  for (const [k, t] of points) { n++; sk += k; st += t; skk += k * k; skt += k * t; }
  const period = (n * skt - sk * st) / (n * skk - sk * sk);
  return {period, phase: (st - period * sk) / n};
}

/**
 * A constant-tempo map from beat taps: period and phase by least squares
 * over the tap index (outliers beyond 0.35 of a beat are dropped once, then
 * refit), bar 0 on the first fitted tap, pins on the first and last fitted taps.
 */
export function fromTaps(taps:number[], duration:number, {numerator = 4}:{numerator?:number} = {}):SongMapData {
  const list = taps.filter(t => Number.isFinite(t) && t >= 0).sort((a, b) => a - b).filter((t, i, a) => !i || t > a[i - 1] + 1e-3);
  if (list.length < 4) throw new Error('Tap at least 4 beats.');
  if (!Number.isInteger(numerator) || numerator < 1 || numerator > 16) throw new Error('Beats per bar must be between 1 and 16.');
  const points = list.map((t, k):[number, number] => [k, t]);
  let {period, phase} = fitLine(points);
  const kept = points.filter(([k, t]) => Math.abs(t - (phase + k * period)) <= 0.35 * period);
  if (kept.length >= 2 && kept.length < points.length) ({period, phase} = fitLine(kept));
  if (!(period > 0) || !Number.isFinite(phase)) throw new Error('Those taps do not make a steady beat. Try again.');
  const qpm = 60 / period;
  if (qpm < MIN_QPM || qpm > MAX_QPM) throw new Error('Choose a tempo between 10 and 1000 BPM.');
  const last = list.length - 1, first = phase >= 0 ? 0 : Math.ceil(-phase / period - 1e-9);
  const pins:Pin[] = [{position: fraction(first), time: Math.max(0, phase + first * period)}];
  if (last > first) pins.push({position: fraction(last), time: phase + last * period});
  const measure:Measure = {id: id(), numerator, denominator: 4, length: fraction(numerator), label: ''};
  const data = normalize({version: 1, measures: [measure], pins, tailQpm: qpm, origin: 'tapped'}, duration);
  validateSongMap(data);
  return data;
}

// ---- markers and suggested sections become section labels (§4.5, D47) -----
export type MarkerInput = {id:string; t:number; label?:string; deleted?:boolean};
export type SuggestionBlock = {t0:number; label?:string; confidence?:number};
const cleanLabel = (label:unknown, fallback:string) => String(label ?? '').trim().slice(0, 120) || fallback;

function nearestBar(bars:MapBar[], t:number) {
  let low = 0, high = bars.length - 1;
  while (low < high) { const mid = (low + high + 1) >> 1; if (bars[mid].t0 <= t) low = mid; else high = mid - 1; }
  const next = bars[low + 1];
  return next && next.t0 - t < t - bars[low].t0 ? next : bars[low];
}
const labelChange = (labels:Map<string, string>) => (draft:SongMapData) => {
  for (const m of draft.measures) { const label = labels.get(m.id); if (label !== undefined) m.label = label; }
};

/**
 * Each live marker labels the bar whose start is nearest to it (bar 0 is
 * relabelled too). When two markers land on one bar, the earlier one wins
 * and the other is skipped. `change` is a draft edit for `SongMapStore.edit`.
 */
export function sectionsFromMarkers(data:SongMapData, markers:MarkerInput[], duration:number) {
  const bars = barsOf(data, duration), labels = new Map<string, string>(), converted:string[] = [], skipped:string[] = [];
  const live = markers.filter(m => m && !m.deleted && Number.isFinite(m.t)).map((m, order) => ({m, order})).sort((a, b) => a.m.t - b.m.t || a.order - b.order);
  for (const {m} of live) {
    const bar = nearestBar(bars, m.t);
    if (labels.has(bar.id)) { skipped.push(m.id); continue; }
    labels.set(bar.id, cleanLabel(m.label, `Section ${labels.size + 1}`));
    converted.push(m.id);
  }
  return {change: labelChange(labels), converted, skipped};
}

/** Suggested section blocks label the bar nearest each `t0`; a bar that already has a label is skipped. */
export function applySuggestion(data:SongMapData, suggestion:{sections?:SuggestionBlock[]}|SuggestionBlock[]|null|undefined, duration:number) {
  const blocks = (Array.isArray(suggestion) ? suggestion : suggestion?.sections ?? []).filter(b => b && Number.isFinite(b.t0));
  const bars = barsOf(data, duration), labels = new Map<string, string>();
  for (const block of [...blocks].sort((a, b) => a.t0 - b.t0)) {
    const bar = nearestBar(bars, block.t0);
    if (sectionLabelOf(bar) !== '' || labels.has(bar.id)) continue;
    labels.set(bar.id, cleanLabel(block.label, `Section ${labels.size + 1}`));
  }
  return {change: labelChange(labels), added: labels.size};
}
