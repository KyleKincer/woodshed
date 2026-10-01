/**
 * The song map: one run of bars for the whole recording, some of whose bar
 * lines or beats are pinned to audio times. Tempo is never stored between
 * pins; it is derived from them. Editing meter or bar numbering therefore
 * never moves a pin, and a miscounted bar shows up as an odd derived tempo.
 */
import {type Fraction,type Measure,type Timeline,fraction,number,add,subtract,compare,beatGroups,id,MAX_MEASURES} from './notation';

export type Pin = {position:Fraction; time:number; ramp?:boolean};
export type SongMapData = {version:1; measures:Measure[]; pins:Pin[]; tailQpm?:number};
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
  const c = compile(data);
  // Steady spans may be any positive tempo (a gap between two sections has no clicks); ramps must stay playable.
  for (const s of c.spans) if (s.ramp && !(s.v0 * 60 >= MIN_QPM / 4 && s.v1 * 60 >= MIN_QPM / 4 && s.v0 * 60 <= MAX_QPM * 4 && s.v1 * 60 <= MAX_QPM * 4)) throw new Error('That ramp needs an impossible tempo. Move a pin or remove the ramp.');
}

/** Keep only known fields so stored maps cannot carry arbitrary data. */
export function cleanSongMap(value:unknown):SongMapData|null {
  try {
    const raw = value as SongMapData;
    const data:SongMapData = {version: 1,
      measures: raw.measures.map(m => ({id: String(m.id), numerator: m.numerator, denominator: m.denominator, length: {n: m.length.n, d: m.length.d}, label: String(m.label ?? ''), ...(Array.isArray(m.grouping) ? {grouping: m.grouping.map(Number)} : {})})),
      pins: raw.pins.map(p => ({position: {n: p.position.n, d: p.position.d}, time: p.time, ...(p.ramp ? {ramp: true} : {})})),
      ...(typeof raw.tailQpm === 'number' ? {tailQpm: raw.tailQpm} : {})};
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
