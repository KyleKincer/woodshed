// ST2: src/stage/grid.js — grid ticks per division and snapping (pure, on real SongMapStores).
import {describe, expect, test} from 'vitest';
import {DIVISIONS, gridTicks, snapTime, UNMAPPED_STEP} from '../src/stage/grid.js';
import {mapStore, pickup, sectioned, sevenEight} from './fixtures/maps.js';

const frac = (n, d = 1) => ({n, d});
/** 6/8 at 120 quarters per minute: 1.5 s bars, dotted-quarter beats at 0 and 0.75 s. */
const sixEight = {
  name: 'six-eight', duration: 6,
  tempo: {songMap: {version: 1, origin: 'edited', tailQpm: 120, pins: [{position: frac(0), time: 0}],
    measures: Array.from({length: 4}, (_, i) => ({id: `x${i}`, numerator: 6, denominator: 8, length: frac(3), label: ''}))}},
};

const times = ticks => ticks.map(t => Math.round(t.t * 1000) / 1000);
const kinds = ticks => ticks.map(t => t.kind).join('');
const r3 = t => Math.round(t * 1000) / 1000;

describe('gridTicks', () => {
  const map = mapStore(sectioned);   // 4/4, 2 s bars

  test('bar, beat, half and quarter on 4/4', () => {
    expect(DIVISIONS).toEqual(['bar', 'beat', 'half', 'quarter']);
    expect(gridTicks(map, 0, 6, 'bar')).toEqual([{t: 0, kind: 'bar'}, {t: 2, kind: 'bar'}, {t: 4, kind: 'bar'}, {t: 6, kind: 'bar'}]);
    const beats = gridTicks(map, 0, 2, 'beat');
    expect(times(beats)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(kinds(beats)).toBe(['bar', 'beat', 'beat', 'beat', 'bar'].join(''));
    const halves = gridTicks(map, 0, 1, 'half');
    expect(times(halves)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(halves.map(t => t.kind)).toEqual(['bar', 'sub', 'beat', 'sub', 'beat']);
    const quarters = gridTicks(map, 0, 0.5, 'quarter');
    expect(times(quarters)).toEqual([0, 0.125, 0.25, 0.375, 0.5]);
    expect(quarters.map(t => t.kind)).toEqual(['bar', 'sub', 'sub', 'sub', 'beat']);
  });

  test('the window bounds are inclusive and mid-bar windows start at the right line', () => {
    const map4 = mapStore(sectioned);
    expect(times(gridTicks(map4, 2.6, 4.1, 'beat'))).toEqual([3, 3.5, 4]);
    expect(gridTicks(map4, 2.6, 2.9, 'beat')).toEqual([]);
    expect(gridTicks(map4, 5, 3, 'beat')).toEqual([]);
  });

  test('the end of the last bar is a bar line', () => {
    const ticks = gridTicks(map, 126, 128, 'bar');
    expect(ticks).toEqual([{t: 126, kind: 'bar'}, {t: 128, kind: 'bar'}]);
    expect(gridTicks(map, 127, 200, 'beat').map(t => t.t)).toEqual([127, 127.5, 128]);
  });

  test('grouped meters: 7/8 2+2+3 counts three beats; ½ and ¼ split into units and half-units', () => {
    const seven = mapStore(sevenEight);   // eighth = 0.25 s, bar 1.75 s
    expect(times(gridTicks(seven, 0, 1.75, 'beat'))).toEqual([0, 0.5, 1, 1.75]);
    expect(kinds(gridTicks(seven, 0, 1.75, 'beat'))).toBe('barbeatbeatbar');
    expect(times(gridTicks(seven, 0, 1.75, 'half'))).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75]);
    expect(times(gridTicks(seven, 0, 0.5, 'quarter'))).toEqual([0, 0.125, 0.25, 0.375, 0.5]);
    const six = mapStore(sixEight);
    expect(times(gridTicks(six, 0, 1.5, 'beat'))).toEqual([0, 0.75, 1.5]);
    expect(times(gridTicks(six, 0, 0.75, 'half'))).toEqual([0, 0.25, 0.5, 0.75]);
    expect(gridTicks(six, 0, 0.75, 'quarter')).toHaveLength(7);
  });

  test("a pickup's start is a counted beat, not a bar line", () => {
    const p = mapStore(pickup);   // pickup 0.5–1.5 s (2 beats), bar 1 at 1.5 s
    const ticks = gridTicks(p, 0, 2.5, 'beat');
    expect(times(ticks)).toEqual([0.5, 1, 1.5, 2, 2.5]);
    expect(ticks.map(t => t.kind)).toEqual(['beat', 'beat', 'bar', 'beat', 'beat']);
    expect(gridTicks(p, 0, 4, 'bar')).toEqual([{t: 0.5, kind: 'beat'}, {t: 1.5, kind: 'bar'}, {t: 3.5, kind: 'bar'}]);
  });

  test('unmapped songs and unknown divisions', () => {
    expect(gridTicks(null, 0, 10, 'beat')).toEqual([]);
    expect(() => gridTicks(map, 0, 10, 'eighth')).toThrow(TypeError);
  });
});

describe('snapTime', () => {
  const map = mapStore(sectioned);

  test("'bar' and 'beat' are SongMapStore#snapTime exactly", () => {
    for (const t of [0, 0.2, 0.26, 1.1, 3.99, 7.75, 127.9]) {
      for (const mode of ['nearest', 'floor', 'ceil']) {
        expect(snapTime(map, t, 'bar', {mode})).toBe(map.snapTime(t, 'bar', {mode}));
        expect(snapTime(map, t, 'beat', {mode})).toBe(map.snapTime(t, 'beat', {mode}));
      }
    }
    expect(snapTime(map, 1.1, 'bar')).toBe(2);
    expect(snapTime(map, 0.9, 'bar')).toBe(0);
    expect(snapTime(map, 0.7, 'beat')).toBe(0.5);
  });

  test('subdivisions: nearest, floor and ceil, and a time on a line stays on it', () => {
    expect(snapTime(map, 0.3, 'half')).toBe(0.25);
    expect(snapTime(map, 0.4, 'half')).toBe(0.5);
    expect(snapTime(map, 0.3, 'half', {mode: 'floor'})).toBe(0.25);
    expect(snapTime(map, 0.3, 'half', {mode: 'ceil'})).toBe(0.5);
    expect(snapTime(map, 0.3, 'quarter')).toBe(0.25);
    expect(snapTime(map, 0.33, 'quarter', {mode: 'ceil'})).toBe(0.375);
    expect(snapTime(map, 0.25, 'half', {mode: 'ceil'})).toBe(0.25);
    expect(snapTime(map, 0.25, 'half', {mode: 'floor'})).toBe(0.25);
    expect(snapTime(map, 0.5, 'quarter', {mode: 'ceil'})).toBe(0.5);
  });

  test('subdivisions follow the grouping: 7/8 3-unit beat, 6/8 dotted quarters', () => {
    const seven = mapStore(sevenEight);
    expect(r3(snapTime(seven, 1.3, 'half'))).toBe(1.25);       // inside the 3-unit beat (1.0–1.75)
    expect(r3(snapTime(seven, 1.6, 'half', {mode: 'floor'}))).toBe(1.5);
    expect(r3(snapTime(seven, 1.6, 'quarter', {mode: 'floor'}))).toBe(1.5);
    expect(r3(snapTime(seven, 1.66, 'quarter', {mode: 'ceil'}))).toBe(1.75);
    const six = mapStore(sixEight);
    expect(r3(snapTime(six, 0.3, 'half'))).toBe(0.25);
    expect(r3(snapTime(six, 0.3, 'quarter'))).toBe(0.25);
    expect(r3(snapTime(six, 0.32, 'quarter', {mode: 'ceil'}))).toBe(0.375);
  });

  test('before the first downbeat and past the end, like SongMapStore', () => {
    const p = mapStore(pickup);
    expect(snapTime(p, 0.2, 'beat')).toBe(p.snapTime(0.2, 'beat'));
    expect(r3(snapTime(p, 0.2, 'half', {mode: 'ceil'}))).toBe(0.25);
    expect(r3(snapTime(p, 0.6, 'half'))).toBe(0.5);
    expect(snapTime(map, 129, 'half', {mode: 'ceil'})).toBe(129);
    expect(snapTime(map, 129, 'beat', {mode: 'floor'})).toBe(128);
  });

  test('unmapped: 0.1 s steps, never below 0', () => {
    expect(UNMAPPED_STEP).toBe(0.1);
    expect(snapTime(null, 1.234, 'bar')).toBe(1.2);
    expect(snapTime(null, 1.26, 'beat')).toBe(1.3);
    expect(snapTime(null, 1.26, 'beat', {mode: 'floor'})).toBe(1.2);
    expect(snapTime(null, 1.21, 'beat', {mode: 'ceil'})).toBe(1.3);
    expect(snapTime(null, 1.2, 'beat', {mode: 'ceil'})).toBe(1.2);
    expect(snapTime(null, -0.3, 'bar')).toBe(0);
  });

  test('bad arguments throw', () => {
    expect(() => snapTime(map, 1, 'eighth')).toThrow(TypeError);
    expect(() => snapTime(map, 1, 'bar', {mode: 'round'})).toThrow(TypeError);
  });
});
