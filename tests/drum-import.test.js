// @vitest-environment node
import {expect, test} from 'vitest';
import {importDrumHits} from '../src/js/notation/import-drums.js';
import {emptyScore, fraction, number, validateScore} from '../shared/notation.ts';
import {fromTimeline} from '../shared/song-map.ts';

const note = (q, midi = 38, extra = {}) => ({q, midi, durationQ: 0.01, velocity: 0.7, ...extra});
const timeline = () => emptyScore(8).timeline;
const flat = result => result.score.bars.flatMap(bar => bar.hits);

test('imports editable two-voice drums and infers readable onset durations, not MIDI gates', () => {
  const timing = timeline(), before = structuredClone(timing);
  const hits = [note(0, 36), note(0, 42), note(0.5, 42), note(1, 38), note(1, 42), note(1.5, 42), note(2, 36)];
  const result = importDrumHits(hits, timing);
  expect(result.importedCount).toBe(7); expect(result.skippedCount).toBe(0);
  validateScore(result.score);
  expect(result.score.bars[0].coverage).toBe('progress');
  expect(flat(result).find(hit => hit.instrument === 'kick')).toMatchObject({voice: 2, value: 4, duration: fraction(1)});
  expect(flat(result).find(hit => hit.instrument === 'closedHat')).toMatchObject({voice: 1, value: 8, duration: fraction(1, 2)});
  expect(flat(result).find(hit => hit.instrument === 'snare')).toMatchObject({accent: false, ghost: false, sticking: '', velocity: 0.7});
  expect(timing).toEqual(before); expect(hits[0].durationQ).toBe(0.01);
  expect(result.warnings.join(' ')).toContain('drafts');
});

test('preserves exact triplet and quintuplet onsets and uses supported tuplets', () => {
  const triplets = importDrumHits([note(0), note(1 / 3), note(2 / 3)], timeline());
  expect(flat(triplets)[0]).toMatchObject({tuplet: 3, value: 8, duration: fraction(1, 3)});
  expect(flat(triplets)[1].offset).toEqual(fraction(1, 3));
  const quintuplets = importDrumHits([note(0), note(0.2), note(0.4), note(0.6), note(0.8)], timeline());
  expect(flat(quintuplets)[0]).toMatchObject({tuplet: 5, value: 8, duration: fraction(1, 5)});
  expect(flat(quintuplets)[3].offset).toEqual(fraction(3, 5));
  validateScore(triplets.score); validateScore(quintuplets.score);
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
  const result = importDrumHits([note(0, 35), note(0, 36, {velocity: 0.9}), note(1, 45), note(2, 47), note(3, 54)], timeline(), {source: 'chart'});
  expect(result.importedCount).toBe(3); expect(result.skippedCount).toBe(2);
  expect(flat(result)[0]).toMatchObject({instrument: 'kick', velocity: 0.9});
  expect(flat(result).map(hit => hit.instrument)).toEqual(['kick', 'floorTom', 'rackTom']);
  expect(result.warnings.join(' ')).toMatch(/approximate/);
  expect(result.warnings.join(' ')).toMatch(/Unsupported GM percussion.*54/);
  expect(result.warnings.join(' ')).toMatch(/35 → Kick/);
  expect(result.warnings.join(' ')).toContain('duplicate');
});

test('keeps quantized same-drum durations within bars and reports clipped/invalid inputs', () => {
  const timing = timeline();
  const result = importDrumHits([note(0), note(0.50001), note(3.99), note(-1), note(1000), note(NaN), note(1, 38, {velocity: 2})], timing, {duration: 8});
  validateScore(result.score);
  expect(result.importedCount).toBe(2); expect(result.skippedCount).toBe(5);
  expect(flat(result)[1].offset).toEqual(fraction(1, 2));
  expect(result.warnings.join(' ')).toContain('rounded');
  expect(result.warnings.join(' ')).toContain('outside');
  expect(result.warnings.join(' ')).toContain('invalid');
  expect(result.warnings.join(' ')).toContain('too close');
});

test('rejects oversized inputs and invalid timing before returning a partial score', () => {
  expect(() => importDrumHits(Array.from({length: 16001}, () => note(0)), timeline())).toThrow('16,000');
  expect(() => importDrumHits([], {...timeline(), anchors: []})).toThrow('timeline');
  const dense = [];
  for (let i = 0; i < 100; i++) for (const midi of [36, 38, 42, 44]) dense.push(note(i / 24, midi));
  expect(() => importDrumHits(dense, timeline())).toThrow('256');
});
