/**
 * Deterministic drum engraving. Hits store only *when* they sound; the
 * written rhythm (durations, rests, tuplets, beat-aligned grouping) is derived
 * here, so every source — manual entry, MIDI, Guitar Pro or charts — produces
 * the same conventional notation for the same performance.
 *
 * Rules, in order:
 * 1. A bar is divided into rhythm cells: one per counted beat (the measure's
 *    beat grouping), carved further by explicit tuplet spans.
 * 2. Each cell is written on the coarsest grid that contains all its onsets.
 *    Binary grids are plain notes; 3/5/7… grids become one bracketed tuplet
 *    per cell. A grid of 6 or 12 per beat is split into triplets per half or
 *    quarter beat, the way Guitar Pro and Songsterr write 16th/32nd triplets.
 * 3. Notes sound until the next onset in their voice, never across a cell
 *    boundary; the remainder is filled with beat-aligned rests. Drums are
 *    never tied.
 * 4. Whole empty or single-note cells merge into half-bar and whole-bar
 *    values so sparse bars stay sparse.
 */
import {type Fraction, type Hit, type Measure, type Bar, type TupletSpan, fraction, add, subtract, compare, number, beatGroups, KIT} from './notation';

export type Layout = 'split' | 'combined';
export type TupletRatio = {n: number; m: number; group: number};
export type EngravedBeat = {
  start: Fraction; duration: Fraction;
  /** Written note value: 1 whole … 64 sixty-fourth. */
  value: number; dots: number;
  tuplet: TupletRatio | null;
  hits: Hit[];
  rest: boolean;
  /** Invisible spacer for an otherwise empty secondary voice. */
  hidden: boolean;
};
export type EngravedVoice = {voice: 1 | 2; beats: EngravedBeat[]};
export type EngravedBar = {voices: EngravedVoice[]};

// notation.ts imports this module; nothing here may call into it at load time.
const zero = () => fraction(0);
const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;
const mul = (a: Fraction, k: number) => fraction(a.n * k, a.d);
const div = (a: Fraction, k: number) => fraction(a.n, a.d * k);
const ratio = (a: Fraction, b: Fraction) => fraction(a.n * b.d, a.d * b.n);
const gcdInt = (a: number, b: number): number => b ? gcdInt(b, a % b) : Math.abs(a);
const gcdFraction = (a: Fraction, b: Fraction) => fraction(gcdInt(a.n * b.d, b.n * a.d), a.d * b.d);
const isInteger = (a: Fraction) => a.d === 1;

/** Quarter-note lengths that are a plain power-of-two value, whole to 64th. */
export function isBinary(q: Fraction) {
  return q.n > 0 && ((q.d === 1 && isPow2(q.n) && q.n <= 4) || (q.n === 1 && isPow2(q.d) && q.d <= 16));
}
/** Written value and dots for a quarter-note length, or null when not a single symbol. */
export function writtenValue(q: Fraction, maxDots = 1): {value: number; dots: number} | null {
  if (isBinary(q)) return {value: 4 * q.d / q.n, dots: 0};
  if (maxDots >= 1) { const base = ratio(q, fraction(3, 2)); if (isBinary(base) && compare(base, fraction(1, 16)) > 0) return {value: 4 * base.d / base.n, dots: 1}; }
  if (maxDots >= 2) { const base = ratio(q, fraction(7, 4)); if (isBinary(base) && compare(base, fraction(1, 8)) > 0) return {value: 4 * base.d / base.n, dots: 2}; }
  return null;
}

type Event = {offset: Fraction; hits: Hit[]};
type Cell = {start: Fraction; length: Fraction; forced: number | null};
type CellResult = {beats: EngravedBeat[]; kind: 'empty' | 'single' | 'complex'};

let tupletGroup = 0;

/** Rests from `from` (grid units) for `count` units; each piece aligned to its own size. */
function rests(cellStart: Fraction, unit: Fraction, written: Fraction, from: number, count: number, tuplet: TupletRatio | null, allowDots: boolean): EngravedBeat[] {
  const out: EngravedBeat[] = [];
  let pos = from, left = count;
  while (left > 0) {
    let size = 1;
    // Largest piece that is aligned at `pos` and writable as one symbol.
    for (let k = left; k >= 1; k--) {
      const w = writtenValue(mul(written, k), allowDots ? 1 : 0);
      if (w && (pos % k === 0 || (allowDots && w.dots && pos === from && k === left))) { size = k; break; }
    }
    const w = writtenValue(mul(written, size), allowDots ? 1 : 0)!;
    out.push({start: add(cellStart, mul(unit, pos)), duration: mul(unit, size), ...w, tuplet, hits: [], rest: true, hidden: false});
    pos += size; left -= size;
  }
  return out;
}

/** Write one rhythm cell. Throws when an onset cannot be notated in it. */
function writeCell(cell: Cell, events: Event[], allowDottedCell: boolean): CellResult[] {
  const {start, length, forced} = cell;
  const rel = events.map(e => subtract(e.offset, start));
  let s: number;
  if (forced) {
    s = forced;
    const unit = div(length, s);
    if (rel.some(r => !isInteger(ratio(r, unit)))) throw new Error('A note does not fall on this tuplet’s grid.');
  } else {
    let g = length;
    for (const r of rel) if (r.n) g = gcdFraction(g, r);
    s = ratio(length, g).n;
  }
  const unit = div(length, s);
  if (compare(unit, fraction(1, 32)) < 0) throw new Error('A note is closer than a 128th to the beat grid. Snap it to a coarser grid.');
  // 16th/32nd triplets (and other even tuplet grids) read best as one tuplet
  // per half/quarter beat, each simplified on its own.
  let odd = s; while (odd % 2 === 0) odd /= 2;
  const plain = isBinary(unit) || (s <= 2 && allowDottedCell && writtenValue(unit) !== null);
  if (!forced && !plain && odd > 1 && s !== odd && isBinary(div(length, s / odd))) {
    const parts = s / odd, size = div(length, parts), out: CellResult[] = [];
    for (let i = 0; i < parts; i++) {
      const subStart = add(start, mul(size, i)), subEnd = add(subStart, size);
      out.push(...writeCell({start: subStart, length: size, forced: null}, events.filter(e => compare(e.offset, subStart) >= 0 && compare(e.offset, subEnd) < 0), false));
    }
    return out;
  }
  let written = unit, tuplet: TupletRatio | null = null;
  if (!plain) {
    let m = 0;
    for (let k = s - 1; k >= 1; k--) if (isBinary(div(length, k))) { m = k; break; }
    if (!m) throw new Error('This rhythm cannot be written as a tuplet.');
    written = div(length, m);
    tuplet = {n: s, m, group: ++tupletGroup};
  }
  if (!writtenValue(written)) throw new Error('This rhythm is too fine to notate.');
  const positions = rel.map(r => ratio(r, unit).n);
  const beats: EngravedBeat[] = [];
  let pos = 0;
  const allowDots = !tuplet;
  for (let i = 0; i < events.length; i++) {
    const p = positions[i];
    if (p > pos) beats.push(...rests(start, unit, written, pos, p - pos, tuplet, allowDottedCell && allowDots));
    const available = (positions[i + 1] ?? s) - p;
    // Inside tuplets each note is one grid step with rests after it, so the
    // grid stays visible (x 𝄾 x rather than a quarter-note triplet).
    let k = tuplet ? 1 : available;
    while (k > 1 && !writtenValue(mul(written, k), allowDots ? 2 : 1)) k--;
    beats.push({start: add(start, mul(unit, p)), duration: mul(unit, k), ...writtenValue(mul(written, k), allowDots ? 2 : 1)!, tuplet, hits: events[i].hits, rest: false, hidden: false});
    pos = p + k;
    if (available > k) { beats.push(...rests(start, unit, written, pos, available - k, tuplet, allowDottedCell && allowDots)); pos = p + available; }
  }
  if (pos < s) beats.push(...rests(start, unit, written, pos, s - pos, tuplet, allowDottedCell && allowDots));
  const kind = !events.length ? 'empty' : events.length === 1 && !positions[0] && beats.length === 1 ? 'single' : 'complex';
  return [{beats, kind}];
}

/** Beat cells for a measure, truncated for partial (pickup) bars. */
export function rhythmCells(measure: Measure, spans: TupletSpan[] = []): Cell[] {
  const cells: Cell[] = [];
  let q = zero();
  for (const g of beatGroups(measure)) {
    if (compare(q, measure.length) >= 0) break;
    let length = fraction(4 * g, measure.denominator);
    if (compare(add(q, length), measure.length) > 0) length = subtract(measure.length, q);
    cells.push({start: q, length, forced: null}); q = add(q, length);
  }
  const sorted = [...spans].sort((a, b) => compare(a.start, b.start));
  let result = cells;
  for (const span of sorted) {
    const end = add(span.start, span.length), next: Cell[] = [];
    for (const cell of result) {
      const cellEnd = add(cell.start, cell.length);
      if (compare(cellEnd, span.start) <= 0 || compare(cell.start, end) >= 0) { next.push(cell); continue; }
      if (cell.forced) throw new Error('Tuplets overlap.');
      if (compare(cell.start, span.start) < 0) next.push({start: cell.start, length: subtract(span.start, cell.start), forced: null});
      if (!next.some(c => c.forced && compare(c.start, span.start) === 0)) next.push({start: span.start, length: span.length, forced: span.count});
      if (compare(cellEnd, end) > 0) next.push({start: end, length: subtract(cellEnd, end), forced: null});
    }
    result = next;
  }
  return result;
}

function voiceEvents(hits: Hit[]): Event[] {
  const map = new Map<string, Event>();
  for (const hit of hits) {
    const key = `${hit.offset.n}/${hit.offset.d}`;
    if (!map.has(key)) map.set(key, {offset: hit.offset, hits: []});
    map.get(key)!.hits.push(hit);
  }
  return [...map.values()].sort((a, b) => compare(a.offset, b.offset))
    .map(e => ({...e, hits: e.hits.sort((a, b) => KIT_ORDER.get(a.instrument)! - KIT_ORDER.get(b.instrument)!)}));
}
let kitOrder: Map<string, number> | null = null;
const KIT_ORDER = {get: (id: string) => (kitOrder ??= new Map(KIT.map((k, i) => [k.id, i]))).get(id)};

/** Merge whole empty / single-note cells into half-bar and whole-bar values. */
function mergeCells(results: {cell: Cell; result: CellResult}[], measure: Measure): EngravedBeat[] {
  const total = results.reduce((q, r) => add(q, r.cell.length), zero());
  const simple = results.every(r => !r.cell.forced);
  const whole = writtenValue(total);
  if (simple && whole && results.length > 1 && results.every((r, i) => r.result.kind === 'empty' || (i === 0 && r.result.kind === 'single'))) {
    const head = results[0].result;
    return [{...head.beats[0], start: zero(), duration: total, ...whole, tuplet: null}];
  }
  // Half-bar pairs in duple meters (2/2, 4/4, 4/8 …): two equal plain cells
  // starting on a half-bar boundary.
  const out: EngravedBeat[] = [];
  const groups = beatGroups(measure), duple = groups.length % 2 === 0 && groups.every(g => g === groups[0]) && compare(total, measure.length) === 0;
  for (let i = 0; i < results.length; i++) {
    const a = results[i], b = results[i + 1];
    const pairable = duple && b && !a.cell.forced && !b.cell.forced && compare(a.cell.length, b.cell.length) === 0 && isInteger(ratio(a.cell.start, mul(a.cell.length, 2)));
    if (pairable && (a.result.kind === 'empty' || a.result.kind === 'single') && b.result.kind === 'empty') {
      const length = add(a.cell.length, b.cell.length), w = writtenValue(length);
      if (w) { out.push({...a.result.beats[0], start: a.cell.start, duration: length, ...w, tuplet: null}); i++; continue; }
    }
    out.push(...a.result.beats);
  }
  return out;
}

function engraveVoice(hits: Hit[], measure: Measure, spans: TupletSpan[]): EngravedBeat[] {
  const events = voiceEvents(hits), cells = rhythmCells(measure, spans), results: {cell: Cell; result: CellResult}[] = [];
  for (const cell of cells) {
    const end = add(cell.start, cell.length);
    const inside = events.filter(e => compare(e.offset, cell.start) >= 0 && compare(e.offset, end) < 0);
    const dotted = !isBinary(cell.length) && writtenValue(cell.length) !== null;
    const parts = writeCell(cell, inside, dotted);
    // A carved sub-cell keeps its own merge kind; only whole beats merge.
    if (parts.length === 1) results.push({cell, result: parts[0]});
    else results.push({cell, result: {beats: parts.flatMap(p => p.beats), kind: 'complex'}});
  }
  return mergeCells(results, measure);
}

/** Write a bar. `layout` 'split' puts hands up (voice 1) and feet down (voice 2). */
export function engraveBar(bar: Bar | undefined, measure: Measure, layout: Layout = 'combined'): EngravedBar {
  const hits = bar?.hits ?? [], spans = bar?.tuplets ?? [];
  if (layout === 'combined') return {voices: [{voice: 1, beats: engraveVoice(hits, measure, spans.filter(s => !s.voice || s.voice === 1))}]};
  const upper = hits.filter(h => h.voice === 1), lower = hits.filter(h => h.voice === 2);
  const voices: EngravedVoice[] = [{voice: 1, beats: engraveVoice(upper, measure, spans.filter(s => !s.voice || s.voice === 1))}];
  if (lower.length) voices.push({voice: 2, beats: engraveVoice(lower, measure, spans.filter(s => !s.voice || s.voice === 2))});
  // Feet only: hands voice is an invisible spacer, as in printed drum charts.
  if (!upper.length && lower.length) voices[0].beats = voices[0].beats.map(b => ({...b, hidden: true}));
  return {voices};
}

/** True when an onset at `offset` can be written in this bar. */
export function canWrite(bar: Bar | undefined, measure: Measure, hit: Hit, layout: Layout = 'combined') {
  try { engraveBar({measureId: measure.id, coverage: 'progress', hits: [...(bar?.hits ?? []), hit], tuplets: bar?.tuplets}, measure, layout); return true; }
  catch { return false; }
}
