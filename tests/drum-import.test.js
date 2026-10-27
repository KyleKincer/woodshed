// @vitest-environment node
import {expect, test} from 'vitest';
import {importDrumHits} from '../src/js/notation/import-drums.js';
import {emptyScore, fraction, validateScore} from '../shared/notation.ts';
import {engraveBar} from '../shared/engrave.ts';
import {fromTimeline} from '../shared/song-map.ts';

const note = (q, midi = 38, extra = {}) => ({q, midi, durationQ: 0.01, velocity: 0.7, ...extra});
const timeline = () => emptyScore(8).timeline;
const flat = result => result.score.bars.flatMap(bar => bar.hits);
const offsets = (result, instrument) => flat(result).filter(hit => !instrument || hit.instrument === instrument).map(hit => hit.offset);
const shape = (result, bar = 0) => engraveBar(result.score.bars[bar], result.score.timeline.measures.find(m => m.id === result.score.bars[bar].measureId)).voices[0].beats
  .map(b => `${b.rest ? 'r' : 'n'}${b.value}${'.'.repeat(b.dots)}${b.tuplet ? `(${b.tuplet.n}:${b.tuplet.m})` : ''}`).join(' ');

test('imports editable two-voice drums as onsets only, never MIDI gates', () => {
  const timing = timeline(), before = structuredClone(timing);
  const hits = [note(0, 36), note(0, 42), note(0.5, 42), note(1, 38), note(1, 42), note(1.5, 42), note(2, 36, {durationQ: 3})];
  const result = importDrumHits(hits, timing);
  expect(result.importedCount).toBe(7); expect(result.skippedCount).toBe(0);
  validateScore(result.score);
  expect(result.score.version).toBe(2); expect(result.score.bars[0].coverage).toBe('progress');
  expect(flat(result).find(hit => hit.instrument === 'kick')).toEqual({id: expect.any(String), offset: fraction(0), instrument: 'kick', voice: 2, accent: false, ghost: false, flam: false, sticking: '', velocity: 0.7});
  expect(flat(result).find(hit => hit.instrument === 'closedHat')).toMatchObject({voice: 1});
  expect(shape(result)).toBe('n8 n8 n8 n8 n2');
  expect(timing).toEqual(before); expect(hits[0].durationQ).toBe(0.01);
  expect(result.warnings.join(' ')).toContain('drafts');
  expect(result.warnings.join(' ')).not.toContain('rounded');
});

test('preserves exact triplet and quintuplet onsets and writes them as tuplets', () => {
  const triplets = importDrumHits([note(0), note(1 / 3), note(2 / 3)], timeline());
  expect(offsets(triplets)).toEqual([fraction(0), fraction(1, 3), fraction(2, 3)]);
  expect(shape(triplets)).toBe('n8(3:2) n8(3:2) n8(3:2) r4 r2');
  const quintuplets = importDrumHits([note(0), note(0.2), note(0.4), note(0.6), note(0.8)], timeline());
  expect(offsets(quintuplets)[3]).toEqual(fraction(3, 5));
  expect(shape(quintuplets)).toBe(`${Array(5).fill('n16(5:4)').join(' ')} r4 r2`);
  for (const result of [triplets, quintuplets]) { validateScore(result.score); expect(result.warnings.join(' ')).not.toContain('rounded'); }
});

test('quantizes a noisy performance per beat: sixteenths or triplets, never both in one beat', () => {
  const played = [0.01, 0.27, 0.49, 0.76, 1.02, 1.35, 1.65, 2, 2.64, 3.02, 3.48].map(q => note(q, 42));
  const result = importDrumHits(played, timeline());
  expect(offsets(result)).toEqual([fraction(0), fraction(1, 4), fraction(1, 2), fraction(3, 4), fraction(1), fraction(4, 3), fraction(5, 3), fraction(2), fraction(8, 3), fraction(3), fraction(7, 2)]);
  expect(shape(result)).toBe('n16 n16 n16 n16 n8(3:2) n8(3:2) n8(3:2) n8(3:2) r8(3:2) n8(3:2) n8 n8');
  expect(result.warnings.join(' ')).toContain('10 note positions were rounded');
  // Simultaneous hands and feet share one grid per beat in the combined rhythm.
  const together = importDrumHits([note(0, 42), note(0.34, 42), note(0.68, 42), note(0.49, 36)], timeline());
  expect(offsets(together)).toEqual([fraction(0), fraction(1, 3), fraction(1, 2), fraction(2, 3)]);
  expect(shape(together)).toBe('n16(3:2) r16(3:2) n16(3:2) n16(3:2) n16(3:2) r16(3:2) r4 r2');
});

test('late hits round onto the next downbeat; hits rounding past the song are skipped', () => {
  const result = importDrumHits([note(3.99, 49), note(15.99, 49)], timeline());
  expect(result.score.bars).toHaveLength(1);
  expect(result.score.bars[0]).toMatchObject({measureId: result.score.timeline.measures[1].id, hits: [{instrument: 'crash', offset: fraction(0)}]});
  expect(result.importedCount).toBe(1); expect(result.warnings.join(' ')).toContain('outside');
});

test('places notes across a pickup and mixed meters without changing map IDs or alignment', () => {
  const timing = timeline();
  timing.measures[0].length = fraction(1);
  timing.measures[1] = {...timing.measures[1], numerator: 7, denominator: 8, length: fraction(7, 2)};
  const map = fromTimeline(timing, 8);
  const result = importDrumHits([note(0.5, 36), note(1, 38), note(4, 42), note(4.5, 36)], map);
  const [first, second, third] = result.score.bars;
  expect(first.measureId).toBe(map.measures[0].id); expect(first.hits[0].offset).toEqual(fraction(1, 2));
  expect(second.measureId).toBe(map.measures[1].id); expect(second.hits.map(hit => hit.offset)).toEqual([fraction(0), fraction(3)]);
  expect(third.measureId).toBe(map.measures[2].id); expect(third.hits[0].offset).toEqual(fraction(0));
  expect(result.score.timeline.measures).toEqual(map.measures);
  validateScore(result.score);
});

test('reports kit simplifications and unsupported percussion; duplicate aliases combine safely', () => {
  const result = importDrumHits([note(0, 35, {accent: true}), note(0, 36, {velocity: 0.9}), note(1, 45), note(2, 47), note(3, 54)], timeline(), {source: 'chart'});
  expect(result.importedCount).toBe(3); expect(result.skippedCount).toBe(2);
  expect(flat(result)[0]).toMatchObject({instrument: 'kick', velocity: 0.9, accent: true});
  expect(flat(result).map(hit => hit.instrument)).toEqual(['kick', 'tom4', 'tom3']);
  const warnings = result.warnings.join(' ');
  expect(warnings).toMatch(/approximate/);
  expect(warnings).toMatch(/Unsupported GM percussion.*54/);
  expect(warnings).toMatch(/35 → Kick/);
  expect(warnings).toContain('1 duplicate drum hit was combined');
});

test('china, splash, second crash and GP articulations import as their own pieces', () => {
  const gm = importDrumHits([note(0, 52), note(1, 55), note(2, 57), note(3, 49)], timeline());
  expect(flat(gm).map(hit => hit.instrument)).toEqual(['china', 'splash', 'crash2', 'crash']);
  expect(gm.warnings.join(' ')).not.toContain('grouped');
  // Chokes, edges and half-open hats share a MIDI note with the plain hit.
  const gp = importDrumHits([note(0, 52, {gp: 96}), note(0, 46, {gp: 92}), note(1, 59, {gp: 93}), note(1, 40, {gp: 91}), note(2, 49, {gp: 97}), note(3, 53, {instrument: 'rideBell'})], timeline(), {source: 'guitar-pro'});
  expect(flat(gp).map(hit => hit.instrument).sort()).toEqual(['chinaChoke', 'crashChoke', 'halfHat', 'rideBell', 'rideEdge', 'rimshot']);
  expect(gp.warnings.join(' ')).not.toContain('grouped');
  // Without an articulation the MIDI note picks the plain piece.
  expect(flat(importDrumHits([note(0, 40), note(1, 59)], timeline())).map(hit => hit.instrument)).toEqual(['rimshot', 'ride']);
});

test('accents, ghosts, flams, drags, rolls and sticking pass through', () => {
  const result = importDrumHits([
    note(0, 38, {accent: true, sticking: 'R'}), note(1, 38, {heavy: true}), note(2, 38, {ghost: true, velocity: 0.3, sticking: 'X'}),
    note(0, 42, {flam: true}), note(1, 42, {flam: true, drag: true}), note(2, 42, {roll: 3}), note(3, 42, {roll: 5}),
  ], timeline());
  const at = (instrument, q) => flat(result).find(hit => hit.instrument === instrument && hit.offset.n === q && hit.offset.d === 1);
  expect(at('snare', 0)).toMatchObject({accent: true, sticking: 'R'}); expect(at('snare', 0)).not.toHaveProperty('heavy');
  expect(at('snare', 1)).toMatchObject({accent: true, heavy: true});
  expect(at('snare', 2)).toMatchObject({ghost: true, velocity: 0.3, sticking: ''});
  expect(at('closedHat', 0)).toMatchObject({flam: true}); expect(at('closedHat', 0)).not.toHaveProperty('drag');
  expect(at('closedHat', 1)).toMatchObject({flam: false, drag: true});
  expect(at('closedHat', 2).roll).toBe(3); expect(at('closedHat', 3)).not.toHaveProperty('roll');
  validateScore(result.score);
});

test('explicit tuplet spans are kept only where the automatic grid would differ', () => {
  const third = q => [note(q), note(q + 1 / 3), note(q + 2 / 3)];
  const redundant = importDrumHits(third(0), timeline(), {tuplets: [{q: 0, length: 1, count: 3}]});
  expect(redundant.score.bars[0]).not.toHaveProperty('tuplets');
  // A quarter-note triplet over two beats, and a bracketed beat holding one note and rests.
  const kept = importDrumHits([note(0), note(0.7), note(4 / 3), note(2)], timeline(), {tuplets: [{q: 0, length: 2, count: 3}, {q: 2, length: 1, count: 3}]});
  expect(kept.score.bars[0].tuplets).toEqual([{start: fraction(0), length: fraction(2), count: 3}, {start: fraction(2), length: fraction(1), count: 3}]);
  expect(offsets(kept)[1]).toEqual(fraction(2, 3));
  expect(shape(kept)).toBe('n4(3:2) n4(3:2) n4(3:2) n8(3:2) r8(3:2) r8(3:2) r4');
  // Unwritable, overlapping, out-of-bar and malformed spans are ignored.
  const ignored = importDrumHits(third(4), timeline(), {tuplets: [{q: 4, length: 1, count: 3}, {q: 4.5, length: 1, count: 5}, {q: 5, length: 5 / 4, count: 3}, {q: 7, length: 2, count: 3}, {q: 6, length: 1, count: 1}, null]});
  expect(ignored.score.bars[0]).not.toHaveProperty('tuplets');
  expect(offsets(ignored)).toEqual([fraction(0), fraction(1, 3), fraction(2, 3)]);
});

test('reports rounded, clipped and invalid inputs', () => {
  const result = importDrumHits([note(0), note(0.50001), note(-1), note(1000), note(NaN), note(1, 38, {velocity: 2}), note(2, 200)], timeline(), {duration: 8});
  validateScore(result.score);
  expect(result.importedCount).toBe(2); expect(result.skippedCount).toBe(5);
  expect(offsets(result)[1]).toEqual(fraction(1, 2));
  const warnings = result.warnings.join(' ');
  expect(warnings).toContain('1 note position was rounded');
  expect(warnings).toContain('2 drum hits lie outside');
  expect(warnings).toContain('3 invalid drum events were skipped');
  // The recording ends before the mapped bars do.
  expect(importDrumHits([note(0), note(6)], timeline(), {duration: 2}).importedCount).toBe(1);
});

test('rejects oversized inputs and invalid timing before returning a partial score', () => {
  expect(() => importDrumHits(Array.from({length: 16001}, () => note(0)), timeline())).toThrow('16,000');
  expect(() => importDrumHits([], {...timeline(), anchors: []})).toThrow('timeline');
  expect(() => importDrumHits([], null)).toThrow('tempo map');
  expect(() => importDrumHits('notes', timeline())).toThrow('drum-note list');
  const dense = [];
  for (let i = 0; i < 100; i++) for (const midi of [36, 38, 42, 44]) dense.push(note(i / 24, midi));
  expect(() => importDrumHits(dense, timeline())).toThrow('256');
});
