// @vitest-environment node
// Engraving invariants over the demo part and a seeded fuzz of writable rhythms.
import {describe, it, expect} from 'vitest';
import * as at from '@coderline/alphatab';
import {fraction, add, subtract, compare, number, validateBar, KIT} from '../shared/notation.ts';
import {engraveBar, rhythmCells} from '../shared/engrave.ts';
import {buildAlphaTabScore} from '../src/js/notation/alphatab-score.js';
import {demoScore} from './fixtures/drum-score.js';

const LAYOUTS = ['combined', 'split'];
const VALUES = [1, 2, 4, 8, 16, 32, 64];
const mul = (a, b) => fraction(a.n * b.n, a.d * b.d);
const div = (a, k) => fraction(a.n, a.d * k);
const isPow2 = n => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
const str = f => `${f.n}/${f.d}`;
const sum = fs => fs.reduce(add, fraction(0));

// Deterministic PRNG (mulberry32), so every failure reproduces from its seed.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {next, int: n => Math.floor(next() * n), pick: list => list[Math.floor(next() * list.length)], chance: p => next() < p};
}

// --- engraved-bar invariants ---------------------------------------------

/** Exact quarter-note length a written beat stands for. */
function writtenLength(beat) {
  let q = fraction(4, beat.value);
  if (beat.dots === 1) q = mul(q, fraction(3, 2));
  if (beat.dots === 2) q = mul(q, fraction(7, 4));
  return beat.tuplet ? mul(q, fraction(beat.tuplet.m, beat.tuplet.n)) : q;
}
// In the combined rhythm a voice's tuplet applies only when every onset in it fits its grid.
const fitsAll = (bar, s) => bar.hits.every(h => compare(h.offset, s.start) < 0 || compare(h.offset, add(s.start, s.length)) >= 0
  || mul(mul(subtract(h.offset, s.start), fraction(s.count, 1)), fraction(s.length.d, s.length.n)).d === 1);
const spansFor = (bar, layout, voice) => (bar.tuplets ?? []).filter(s => !s.voice || (layout === 'combined' ? fitsAll(bar, s) : s.voice === voice));

/** Throws a description of the first broken invariant. */
function checkEngraved(bar, measure, layout) {
  const engraved = engraveBar(bar, measure, layout);
  const seen = new Map();
  for (const v of engraved.voices) {
    let at = fraction(0);
    v.beats.forEach((b, i) => {
      if (compare(b.start, at)) throw new Error(`voice ${v.voice} beat ${i} starts at ${str(b.start)}, expected ${str(at)}`);
      if (!VALUES.includes(b.value) || ![0, 1, 2].includes(b.dots)) throw new Error(`voice ${v.voice} beat ${i} has unwritable value ${b.value}/${b.dots}`);
      // An empty bar in an odd meter is one whole-bar rest.
      if (b.measureRest) { if (v.beats.length !== 1 || !b.rest || compare(b.duration, measure.length)) throw new Error(`voice ${v.voice} has a malformed bar rest`); }
      else if (compare(writtenLength(b), b.duration)) throw new Error(`voice ${v.voice} beat ${i} lasts ${str(b.duration)} but is written as ${str(writtenLength(b))}`);
      if (b.rest !== !b.hits.length) throw new Error(`voice ${v.voice} beat ${i} rest flag disagrees with its hits`);
      for (const h of b.hits) {
        if (compare(h.offset, b.start)) throw new Error(`hit ${h.id} at ${str(h.offset)} written at ${str(b.start)}`);
        if (layout === 'split' && h.voice !== v.voice) throw new Error(`hit ${h.id} in the wrong voice`);
        seen.set(h.id, (seen.get(h.id) ?? 0) + 1);
      }
      at = add(at, b.duration);
    });
    if (compare(at, measure.length)) throw new Error(`voice ${v.voice} fills ${str(at)} of ${str(measure.length)}`);
    // Tuplets: each group is contiguous, one ratio, and fills exactly one rhythm cell
    // (or, for 6/12 grids, one aligned binary part of a cell).
    const cells = rhythmCells(measure, spansFor(bar, layout, v.voice));
    const groups = new Map();
    v.beats.forEach((b, i) => { if (b.tuplet) { if (!groups.has(b.tuplet.group)) groups.set(b.tuplet.group, []); groups.get(b.tuplet.group).push(i); } });
    for (const [group, indices] of groups) {
      const beats = indices.map(i => v.beats[i]), first = beats[0];
      if (indices.some((i, k) => i !== indices[0] + k)) throw new Error(`tuplet group ${group} is interrupted`);
      if (beats.some(b => b.tuplet.n !== first.tuplet.n || b.tuplet.m !== first.tuplet.m)) throw new Error(`tuplet group ${group} mixes ratios`);
      if (!(first.tuplet.m < first.tuplet.n && first.tuplet.n < 2 * first.tuplet.m)) throw new Error(`tuplet ${first.tuplet.n}:${first.tuplet.m} is not a conventional ratio`);
      const start = first.start, length = sum(beats.map(b => b.duration)), end = add(start, length);
      const cell = cells.find(c => compare(c.start, start) <= 0 && compare(end, add(c.start, c.length)) <= 0);
      if (!cell) throw new Error(`tuplet group ${group} at ${str(start)} crosses a beat`);
      const parts = number(cell.length) / number(length), offset = number(subtract(start, cell.start)) / number(length);
      if (cell.forced ? parts !== 1 : !(isPow2(parts) && Number.isInteger(offset))) throw new Error(`tuplet group ${group} fills ${str(length)} of a ${str(cell.length)} cell`);
    }
  }
  if (layout === 'split' && engraved.voices.length !== (bar.hits.some(h => h.voice === 2) ? 2 : 1)) throw new Error('split layout has the wrong voice count');
  for (const h of bar.hits) if (seen.get(h.id) !== 1) throw new Error(`hit ${h.id} at ${str(h.offset)} written ${seen.get(h.id) ?? 0} times`);
  if (seen.size !== bar.hits.length) throw new Error('engraving wrote hits that are not in the bar');
  return engraved;
}

// --- alphaTab invariants ----------------------------------------------------

function checkAlphaTab(score, layout) {
  const {score: out, noteHits} = buildAlphaTabScore(at, score, {layout});
  const {GraceType} = at.model, problems = [];
  const bars = out.tracks[0].staves[0].bars, voices = layout === 'split' ? 2 : 1;
  bars.forEach((atBar, i) => {
    const measure = score.timeline.measures[i];
    if (atBar.voices.length !== voices) problems.push(`bar ${i}: ${atBar.voices.length} voices`);
    for (const voice of atBar.voices) {
      const beats = voice.beats;
      beats.forEach((beat, k) => {
        if (beat.graceType === GraceType.None && !beat.isEmpty && beat.duration > 64) problems.push(`bar ${i}: beat ${k} is shorter than a 64th`);
        // Report each bracket once, against the bar it opens in.
        const group = beat.tupletGroup;
        if (group && group.beats[0] === beat) {
          const ratio = `${beat.tupletNumerator}:${beat.tupletDenominator}`;
          if (!group.isFull) problems.push(`bar ${i}: the ${ratio} bracket at beat ${k} is never closed`);
          if (group.beats.some(b => b.voice.bar !== atBar)) problems.push(`bar ${i}: the ${ratio} bracket at beat ${k} runs past the barline`);
        }
        if (beat.graceType !== GraceType.None) {
          const main = beats.slice(k + 1).find(b => b.graceType === GraceType.None);
          if (!main || main.graceGroup?.beats.indexOf(beat) < 0 || !main.notes.some(n => noteHits.get(n)?.flam || noteHits.get(n)?.drag)) problems.push(`bar ${i}: grace beat ${k} does not lead into its flam`);
        }
      });
      // A transcribed voice spans the bar; tuplet ticks truncate by at most one per beat.
      if (!(beats.length === 1 && beats[0].isEmpty)) {
        const ticks = beats.reduce((t, b) => t + b.displayDuration, 0), expected = number(measure.length) * 960;
        if (Math.abs(ticks - expected) > beats.length) problems.push(`bar ${i}: voice spans ${ticks} ticks, not ${expected}`);
      }
    }
  });
  return problems;
}

// --- fuzz generator -----------------------------------------------------

const METERS = [
  [4, 4], [4, 4], [4, 4], [3, 4], [2, 4], [5, 4], [5, 4, [3, 2]], [7, 4, [4, 3]], [4, 4, [2, 2]], [4, 4, [3, 1]],
  [2, 2], [3, 2], [6, 8], [6, 8], [9, 8], [12, 8], [3, 8], [3, 8, [3]], [5, 8, [3, 2]], [5, 8, [2, 3]],
  [7, 8, [2, 2, 3]], [7, 8, [3, 2, 2]], [7, 8, [2, 3, 2]], [7, 8], [8, 8, [3, 3, 2]], [6, 16, [3, 3]], [7, 16, [4, 3]],
];
/** Grid divisions per rhythm cell: binary, triplet, sextuplet, quintuplet and septuplet families. */
function grids(length) {
  const binaryCell = isPow2(length.d) && isPow2(length.n);
  const counts = binaryCell ? [1, 2, 4, 8, 16, 32, 64, 3, 6, 12, 24, 48, 5, 10, 20, 7, 14] : [1, 2, 3, 4, 6, 12, 24, 5, 7];
  // Finest: binary 64ths, 32nd triplets, 64th quintuplets.
  return counts.filter(s => { const unit = div(length, s); return isPow2(unit.d) && unit.n === 1 ? unit.d <= 16 : number(unit) >= 1 / 24; });
}
const HANDS = KIT.filter(k => k.voice === 1).map(k => k.id), FEET = KIT.filter(k => k.voice === 2).map(k => k.id);

function fuzzBar(r, index) {
  const [numerator, denominator, grouping] = r.pick(METERS);
  // Pickups and partial bars run a whole number of counted units short.
  const length = r.chance(.15) && numerator > 1 ? fraction(4 * (1 + r.int(numerator - 1)), denominator) : fraction(4 * numerator, denominator);
  const measure = {id: `m${index}`, numerator, denominator, length, label: '', ...(grouping ? {grouping} : {})};
  const hits = [], tuplets = [];
  let serial = 0;
  const density = .15 + r.next() * .8;
  const place = (offset, pool) => {
    const used = new Set(hits.filter(h => !compare(h.offset, offset)).map(h => h.instrument));
    for (let n = 1 + r.int(r.chance(.3) ? 3 : 1); n > 0; n--) {
      const instrument = r.pick(pool.length ? pool : r.chance(.75) ? HANDS : FEET);
      if (used.has(instrument)) continue;
      used.add(instrument);
      const piece = KIT.find(k => k.id === instrument);
      hits.push({id: `b${index}h${serial++}`, offset, instrument, voice: piece.voice, accent: r.chance(.25), ghost: r.chance(.1), flam: r.chance(.05), sticking: r.pick(['', '', 'L', 'R']), velocity: .3 + r.next() * .7,
        ...(r.chance(.05) ? {heavy: true} : {}), ...(r.chance(.03) ? {drag: true} : {}), ...(r.chance(.05) ? {roll: 1 + r.int(3)} : {})});
    }
  };
  if (!r.chance(.05)) for (const cell of rhythmCells(measure)) {
    const s = r.pick(grids(cell.length));
    for (let k = 0; k < s; k++) if (r.chance(density) || (k === 0 && r.chance(.5))) place(add(cell.start, mul(div(cell.length, s), fraction(k))), []);
  }
  // An explicit tuplet over half a beat, one, two or four beats, starting on a beat.
  if (r.chance(.25)) {
    const cells = rhythmCells(measure), i = r.int(cells.length), cell = cells[i];
    const spanBeats = r.pick([.5, 1, 1, 2, 4]);
    const covered = spanBeats >= 1 ? cells.slice(i, i + spanBeats) : [cell];
    const span = spanBeats >= 1 ? sum(covered.map(c => c.length)) : div(cell.length, 2);
    const writable = VALUES.some(v => !compare(span, fraction(4, v)) || !compare(span, fraction(6, v)));
    const count = r.pick([2, 3, 4, 5, 6, 7, 9]), unit = div(span, count);
    if (covered.length === Math.max(1, spanBeats) && writable && number(unit) >= 1 / 18) {
      const voice = r.pick([undefined, undefined, undefined, 1, 2]);
      // Combined layout writes one rhythm and ignores a feet-only tuplet, so a
      // voice's own tuplet gets its beats to itself.
      const start = cell.start, end = add(start, span), clearEnd = voice ? add(covered.at(-1).start, covered.at(-1).length) : end;
      const inside = h => compare(h.offset, start) >= 0 && compare(h.offset, clearEnd) < 0;
      for (let k = hits.length - 1; k >= 0; k--) if (inside(hits[k])) hits.splice(k, 1);
      tuplets.push({start, length: span, count, ...(voice ? {voice} : {})});
      for (let k = 0; k < count; k++) if (r.chance(.7) || k === 0) place(add(start, mul(unit, fraction(k))), voice === 1 ? HANDS : voice === 2 ? FEET : []);
    }
  }
  const bar = {measureId: measure.id, coverage: !hits.length && r.chance(.5) ? 'reviewed' : 'progress', hits, ...(tuplets.length ? {tuplets} : {})};
  return {measure, bar};
}

/** Pack fuzzed bars into a score whose timeline carries their mixed meters. */
function fuzzScore(entries) {
  const measures = entries.map(e => e.measure);
  return {version: 2, title: 'Fuzz', timeline: {version: 1, measures, anchors: [{position: fraction(0), time: 0}, {position: measures[0].length, time: number(measures[0].length) / 2}]}, bars: entries.map(e => e.bar)};
}

const SEED = 20261027, BARS = 3000, PER_SCORE = 60;
const fuzz = (() => { const r = rng(SEED); return Array.from({length: BARS}, (_, i) => fuzzBar(r, i)); })();
const describeInput = ({measure, bar}) => JSON.stringify({measure, tuplets: bar.tuplets, hits: bar.hits.map(h => [str(h.offset), h.instrument])});

describe('engraving invariants', () => {
  it('fills every voice of the demo part with contiguous, writable beats holding each hit once', () => {
    const score = demoScore();
    for (const layout of LAYOUTS) for (const bar of score.bars) {
      const measure = score.timeline.measures.find(m => m.id === bar.measureId);
      expect(() => checkEngraved(bar, measure, layout)).not.toThrow();
    }
  });

  it('holds over a seeded fuzz of writable rhythms in every meter and layout', () => {
    const failures = [];
    for (const entry of fuzz) for (const layout of LAYOUTS) {
      try { checkEngraved(entry.bar, entry.measure, layout); }
      catch (error) { failures.push(`${layout} ${error.message}: ${describeInput(entry)}`); }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it('exercises the rhythms it claims to', () => {
    const shapes = new Set();
    for (const {bar, measure} of fuzz) for (const v of engraveBar(bar, measure, 'combined').voices) for (const b of v.beats) if (b.tuplet) shapes.add(`${b.tuplet.n}:${b.tuplet.m}`);
    expect([...shapes]).toEqual(expect.arrayContaining(['3:2', '5:4', '6:4', '7:4', '5:3', '7:6', '4:3', '9:8']));
    expect(fuzz.some(e => compare(e.measure.length, fraction(4 * e.measure.numerator, e.measure.denominator)) < 0)).toBe(true);
    expect(fuzz.filter(e => e.bar.tuplets).length).toBeGreaterThan(BARS / 10);
    const hits = fuzz.flatMap(e => e.bar.hits);
    expect(hits.some(h => h.flam) && hits.some(h => h.drag) && hits.some(h => h.roll)).toBe(true);
  });
});

describe('alphaTab engraving invariants', () => {
  it('closes every tuplet bracket, keeps voices aligned and leads graces into their flams in the demo part', () => {
    for (const layout of LAYOUTS) expect(checkAlphaTab(demoScore(), layout)).toEqual([]);
  });

  it('holds over the fuzzed bars', () => {
    const problems = [];
    for (let i = 0; i < fuzz.length; i += PER_SCORE) {
      const chunk = fuzz.slice(i, i + PER_SCORE), score = fuzzScore(chunk);
      for (const layout of LAYOUTS) for (const p of checkAlphaTab(score, layout)) {
        const bar = Number(/^bar (\d+)/.exec(p)[1]);
        problems.push(`${layout} ${p}: ${describeInput(chunk[bar])}`);
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });
});

describe('validateBar against the engraver', () => {
  it('accepts every fuzzed bar', () => {
    const failures = [];
    for (const entry of fuzz) {
      try { validateBar(entry.bar, {measures: [entry.measure]}); }
      catch (error) { failures.push(`${error.message}: ${describeInput(entry)}`); }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  // A 512th nudge leaves a grid of at most 3/128 of a quarter in any cell: finer than a 64th triplet.
  it('rejects any fuzzed bar with one hit nudged off the writable grid', () => {
    const r = rng(SEED + 1), accepted = [];
    let tried = 0;
    for (const {bar, measure} of fuzz) {
      if (!bar.hits.length) continue;
      const target = r.pick(bar.hits), offset = add(target.offset, fraction(1, 128));
      if (compare(offset, measure.length) >= 0 || bar.hits.some(h => h.instrument === target.instrument && !compare(h.offset, offset))) continue;
      const nudged = {...bar, hits: bar.hits.map(h => h === target ? {...h, offset} : h)};
      tried++;
      try { validateBar(nudged, {measures: [measure]}); accepted.push(describeInput({measure, bar: nudged})); } catch {}
    }
    expect(tried).toBeGreaterThan(BARS / 2);
    expect(accepted.slice(0, 3)).toEqual([]);
  });

  it('rejects positions finer than the grid, and off an explicit tuplet’s grid', () => {
    const m = (numerator, denominator, extra = {}) => ({id: 'm', numerator, denominator, length: fraction(4 * numerator, denominator), label: '', ...extra});
    const h = (offset, instrument = 'snare') => ({id: `${instrument}${str(offset)}`, offset, instrument, voice: instrument === 'kick' ? 2 : 1, accent: false, ghost: false, flam: false, sticking: '', velocity: .8});
    const check = (measure, hits, tuplets) => () => validateBar({measureId: 'm', coverage: 'progress', hits, ...(tuplets ? {tuplets} : {})}, {measures: [measure]});
    // 64ths, 32nd triplets and 64th quintuplets are the finest written grids.
    expect(check(m(4, 4), [h(fraction(1, 16))])).not.toThrow();
    expect(check(m(4, 4), [h(fraction(1, 24))])).not.toThrow();
    expect(check(m(4, 4), [h(fraction(1, 20))])).not.toThrow();
    expect(check(m(6, 8), [h(fraction(3, 2)), h(fraction(25, 16))])).not.toThrow();
    for (const offset of [fraction(1, 48), fraction(1, 64), fraction(1, 96), fraction(129, 128)]) expect(check(m(4, 4), [h(offset)])).toThrow();
    expect(check(m(6, 8), [h(fraction(3, 2)), h(fraction(97, 64))])).toThrow();
    // Combined layout writes one rhythm: a kick a 16th-triplet away from a 64th is unwritable.
    expect(check(m(4, 4), [h(fraction(1, 16)), h(fraction(1, 6), 'kick')])).toThrow();
    const triplet = [{start: fraction(0), length: fraction(2), count: 3}];
    expect(check(m(4, 4), [h(fraction(2, 3))], triplet)).not.toThrow();
    expect(check(m(4, 4), [h(fraction(1, 2))], triplet)).toThrow();
    expect(check(m(4, 4), [h(fraction(1))], triplet)).toThrow();
  });
});

// Minimal reproducers shrunk from the fuzz. They fail until shared/engrave.ts is fixed.
describe('engraving reproducers', () => {
  const m = (numerator, denominator) => ({id: 'm', numerator, denominator, length: fraction(4 * numerator, denominator), label: ''});
  const h = (offset, instrument = 'snare') => ({id: `${instrument}${str(offset)}`, offset, instrument, voice: 1, accent: false, ghost: false, flam: false, sticking: '', velocity: .8});

  it('rejects a 128th-note grid instead of writing it as a 32:16 tuplet of 64ths', () => {
    for (const measure of [m(1, 4), m(6, 8)]) {
      const bar = {measureId: 'm', coverage: 'progress', hits: [h(fraction(1, 32))]};
      expect(() => validateBar(bar, {measures: [measure]})).toThrow();
    }
  });

  it('closes alphaTab tuplet brackets that contain merged rests', () => {
    // 1/4: a septuplet with notes on 1 and 2 (7:4 brackets total 959 ticks);
    // 6/8: a quintuplet of eighths with notes on 1 and 2 (5:3 totals 1440 ticks).
    for (const [measure, hits] of [[m(1, 4), [h(fraction(0)), h(fraction(1, 7))]], [m(6, 8), [h(fraction(0)), h(fraction(3, 10))]]]) {
      const score = fuzzScore([{measure, bar: {measureId: 'm', coverage: 'progress', hits}}]);
      expect(checkAlphaTab(score, 'combined')).toEqual([]);
    }
  });
});
