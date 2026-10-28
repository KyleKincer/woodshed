import {describe, expect, test} from 'vitest';
import {createPositionModel, formatTenths} from '../src/stage/position.js';
import {signal, readonly, effect} from '../src/app/store.js';
import {mapStore, pickup, sectioned, sevenEight, unmapped} from './fixtures/maps.js';

/** The practice-state surface position.js reads: `value` (a signal of PracticeV2). */
function practiceWith(markers = []) {
  const value = signal({v: 2, cue: 0, rate: 1, markers, spots: []});
  return {value: readonly(value), set: (next) => { value.value = {...value.peek(), markers: next}; }};
}

const MARKERS = [
  {id: 'm3', t: 20, label: 'Marker 3', updatedAt: 3},
  {id: 'm1', t: 4, label: 'Marker 1', updatedAt: 1},
  {id: 'gone', t: 8, label: 'Marker 2', updatedAt: 2, deleted: true},
  {id: 'm2', t: 12, label: 'Chorus', updatedAt: 2},
];

const model = (fixture, markers = []) => {
  const map = mapStore(fixture);
  const practice = practiceWith(markers);
  return {map, practice, position: createPositionModel({map, practice})};
};

describe('mapped (sectioned: 64 bars of 2 s, a section every 8 bars)', () => {
  const {position, map} = model(sectioned, MARKERS);

  test('mapped is true and label reads bar · beat with the time below', () => {
    expect(position.mapped.value).toBe(true);
    expect(position.label(0)).toEqual({main: '1 · 1', sub: '0:00 / 2:08'});
    expect(position.label(33)).toEqual({main: '17 · 3', sub: '0:33 / 2:08'});
    expect(position.label(1000).sub).toBe('2:08 / 2:08');
  });

  test('regions are the sections; markers stay ticks', () => {
    const regions = position.regions();
    expect(regions.map((r) => r.label)).toEqual(['Intro', 'Verse', 'Chorus', 'Verse 2', 'Chorus 2', 'Bridge', 'Chorus 3', 'Outro']);
    expect(regions[1]).toMatchObject({id: 'g8', kind: 'section', t0: 16, t1: 32, startBar: 8, endBar: 15, bars: 8});
    expect(position.markerTicks()).toEqual([
      {id: 'm1', t: 4, label: 'Marker 1'}, {id: 'm2', t: 12, label: 'Chorus'}, {id: 'm3', t: 20, label: 'Marker 3'}]);
    expect(position.regionAt(20).label).toBe('Verse');
    expect(position.regionAt(-3).label).toBe('Intro');
    expect(position.againTarget(20)).toBe(16);
  });

  test('next counts bars, then the last beats like a count-in (§4.4)', () => {
    expect(position.next(0)).toMatchObject({text: 'next: Verse · 8 bars', imminent: false});
    expect(position.next(0).region.label).toBe('Verse');
    expect(position.next(11.9).text).toBe('next: Verse · 3 bars');
    expect(position.next(13)).toMatchObject({text: 'Verse in 1 · 2', imminent: true});
    expect(position.next(14.1).text).toBe('Verse in 4');
    expect(position.next(15.1).text).toBe('Verse in 2');
    expect(position.next(15.6).text).toBe('Verse in 1');
    expect(position.next(120)).toBe(null);
  });

  test('steps go to bar and beat lines', () => {
    expect(position.stepTarget(33, 'bar', 1)).toBe(34);
    expect(position.stepTarget(33, 'bar', -1)).toBe(32);
    expect(position.stepTarget(32, 'bar', -1)).toBe(30);
    expect(position.stepTarget(33, 'beat', 1)).toBe(33.5);
    expect(position.stepTarget(33, 'beat', -1)).toBe(32.5);
    expect(position.stepTarget(0, 'bar', -1)).toBe(0);
    expect(position.stepTarget(127.5, 'bar', 1)).toBe(128);
    expect(position.stepTarget(128, 'bar', 1)).toBe(128);
  });

  test('snap to bar, beat, unit and tenth', () => {
    expect(position.snap(33.3, 'bar')).toBe(34);
    expect(position.snap(33.3, 'beat')).toBe(33.5);
    expect(position.snap(33.1, 'unit')).toBe(33);
    expect(position.snap(33.33, 'tenth')).toBe(33.3);
    expect(position.snap(-1, 'bar')).toBe(0);
  });

  test('loop default is the current section; labels name sections and bars', () => {
    expect(position.loopDefault(20)).toEqual({a: 16, b: 32, label: 'Verse'});
    expect(position.loopLabel(32, 48)).toBe('Chorus');
    expect(position.loopLabel(34, 40)).toBe('Bars 18–20');
    expect(position.loopLabel(34, 36)).toBe('Bar 18');
    expect(position.rangeLabel(32, 48)).toBe('Bars 17–24 · Chorus (8 bars)');
    expect(position.rangeLabel(34, 40)).toBe('Bars 18–20 (3 bars)');
    expect(position.rangeLabel(34, 36)).toBe('Bar 18 (1 bar)');
    expect(position.rangeLabel(34, 35)).toBe('Bar 18 (1.0 s)');
    expect(position.rangeLabel(33.5, 37)).toBe('Bars 17–19 (3.5 s)');
  });

  test('an edge within 10 ms before a bar line counts from that bar in both labels', () => {
    expect(position.rangeLabel(33.995, 40)).toBe('Bars 18–20 (3 bars)');
    expect(position.loopLabel(33.995, 40)).toBe('Bars 18–20');
    expect(position.rangeLabel(34.005, 40)).toBe('Bars 18–20 (3 bars)');
    expect(position.rangeLabel(33.98, 40)).toBe('Bars 17–20 (6.0 s)');
  });

  test('refs survive as bar ids and resolve back to times', () => {
    const ref = position.ref(33);
    expect(ref).toEqual({id: 'g16', beat: 2, frac: 0});
    expect(position.resolve(ref)).toBe(33);
    expect(position.resolve({id: 'nope', beat: 0})).toBe(null);
    expect(position.resolve(null)).toBe(null);
    expect(map.timeOfRef(ref)).toBe(33);
  });
});

describe('mapped edge cases', () => {
  test('a pickup and the time before it read "Pickup · beat"', () => {
    const {position} = model(pickup);
    expect(position.label(0.6).main).toBe('Pickup · 3');
    expect(position.label(1.2).main).toBe('Pickup · 4');
    expect(position.label(0.2).main).toBe('Pickup · 2');
    expect(position.label(1.6).main).toBe('1 · 1');
    expect(position.rangeLabel(0.5, 3.5)).toBe('Pickup–bar 1 (2 bars)');
    expect(position.loopLabel(0.5, 1.5)).toBe('Pickup');
    expect(position.ref(0.2)).toBe(null);
  });

  test('a bare toggle in the pickup (or before it) takes the pickup in, so the loop holds t', () => {
    const {position} = model(pickup);
    expect(position.loopDefault(0.8)).toEqual({a: 0.5, b: 9.5, label: 'Pickup–bar 4'});
    const before = position.loopDefault(0.2);
    expect(before.a).toBe(0);
    expect(before.b).toBe(9.5);
    expect(before.a).toBeLessThanOrEqual(0.2);
    expect(position.loopDefault(2)).toEqual({a: 1.5, b: 9.5, label: 'Bars 1–4'});
  });

  test('without sections: no regions, no next, and a bare toggle loops the 4-bar phrase', () => {
    const {position} = model(sevenEight, MARKERS);
    expect(position.regions()).toEqual([]);
    expect(position.regionAt(3)).toBe(null);
    expect(position.againTarget(3)).toBe(null);
    expect(position.next(3)).toBe(null);
    expect(position.loopDefault(4)).toEqual({a: 0, b: 7, label: 'Bars 1–4'});
    expect(position.loopDefault(8)).toEqual({a: 7, b: 14, label: 'Bars 5–8'});
    expect(position.label(1.75 + 0.5).main).toBe('2 · 2');    // 7/8 as 2+2+3: the second counted beat
    expect(position.stepTarget(2, 'beat', 1)).toBe(2.25);     // 1.75 + 0.5 s (2 eighths at 120 qpm)
  });

  test('revision and mapped follow map changes (and refresh() after setHasPart)', () => {
    const {map, position} = model(unmapped);
    expect(position.mapped.value).toBe(false);
    const seen = [];
    const stop = effect(() => { seen.push(position.regions().length); });
    map.edit((d) => { d.measures[2].label = 'Verse'; }, 'label');
    expect(position.mapped.value).toBe(true);
    expect(position.revision.value).toBeGreaterThan(0);
    expect(seen).toEqual([0, 2]);                 // Start + Verse
    stop();

    const other = model(unmapped);
    other.map.setHasPart(true);
    other.position.refresh();
    expect(other.position.mapped.value).toBe(true);
    expect(other.position.label(2.1).main).toBe('2 · 1');
    other.position.dispose();
  });

  test('a map is required', () => {
    expect(() => createPositionModel({practice: practiceWith()})).toThrow(TypeError);
  });
});

describe('unmapped (the 1.9 placeholder map, 30 s, with markers)', () => {
  const {position, practice} = model(unmapped, MARKERS);

  test('label is clock time with no sub line', () => {
    expect(position.mapped.value).toBe(false);
    expect(position.label(12.9)).toEqual({main: '0:12', sub: null});
    expect(position.label(72.4)).toEqual({main: '0:30', sub: null});
    expect(position.label(-1)).toEqual({main: '0:00', sub: null});
  });

  test('live markers are the regions, sorted', () => {
    expect(position.regions()).toEqual([
      {id: 'm1', kind: 'marker', label: 'Marker 1', index: 0, t0: 4, t1: 12},
      {id: 'm2', kind: 'marker', label: 'Chorus', index: 1, t0: 12, t1: 20},
      {id: 'm3', kind: 'marker', label: 'Marker 3', index: 2, t0: 20, t1: 30},
    ]);
    expect(position.markerTicks().map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(position.regionAt(2)).toBe(null);
    expect(position.regionAt(13).label).toBe('Chorus');
    expect(position.regionAt(30).label).toBe('Marker 3');
    expect(position.againTarget(13)).toBe(12);
    expect(position.againTarget(2)).toBe(null);
  });

  test('next counts down the time to the next marker', () => {
    expect(position.next(0)).toMatchObject({text: 'next: Marker 1 · 0:04', imminent: false});
    expect(position.next(5).text).toBe('next: Chorus · 0:07');
    expect(position.next(11.5).text).toBe('next: Chorus · 0:01');
    expect(position.next(25)).toBe(null);
  });

  test('steps are ±5 s and ±1 s; snapping is to tenths for loop edges and exact for a cue', () => {
    expect(position.stepTarget(10, 'bar', 1)).toBe(15);
    expect(position.stepTarget(10, 'beat', -1)).toBe(9);
    expect(position.stepTarget(2, 'bar', -1)).toBe(0);
    expect(position.stepTarget(28, 'bar', 1)).toBe(30);
    expect(position.snap(10.26, 'bar')).toBe(10.3);
    expect(position.snap(10.26, 'tenth')).toBe(10.3);
    expect(position.snap(10.26, 'beat')).toBe(10.26);
    expect(position.ref(10)).toBe(null);
  });

  test('loop default is [t − 5, t + 5], each edge clamped to the song (transport rule 13)', () => {
    expect(position.loopDefault(10)).toEqual({a: 5, b: 15, label: '0:05.0–0:15.0'});
    expect(position.loopDefault(1)).toMatchObject({a: 0, b: 6});
    expect(position.loopDefault(29)).toMatchObject({a: 24, b: 30});
    expect(position.loopDefault(40)).toMatchObject({a: 25, b: 30});
    expect(position.rangeLabel(11.24, 21)).toBe('0:11.2–0:21.0 (9.8 s)');
    expect(position.loopLabel(31.2, 41)).toBe('0:31.2–0:41.0');
  });

  test('markers update with the practice state', () => {
    practice.set([...MARKERS, {id: 'm4', t: 2, label: 'Top', updatedAt: 5}]);
    expect(position.regionAt(2).label).toBe('Top');
    practice.set(MARKERS);
  });

  test('Unmapped never renders Bar: no string from position.js contains "Bar" or "bar "', () => {
    const strings = [];
    const add = (s) => { if (typeof s === 'string') strings.push(s); };
    for (const fixtureMarkers of [MARKERS, []]) {
      practice.set(fixtureMarkers);
      for (const r of position.regions()) add(r.label);
      for (const m of position.markerTicks()) add(m.label);
      for (let t = -1; t <= 31; t += 0.25) {
        const {main, sub} = position.label(t);
        add(main); add(sub);
        add(position.next(t)?.text);
        add(position.next(t)?.region?.label);
        add(position.regionAt(t)?.label);
        add(position.loopDefault(t).label);
        add(position.loopLabel(t, t + 3));
        add(position.rangeLabel(t, t + 3));
        add(position.rangeLabel(t, t + 0.5));
        expect(Number.isFinite(position.stepTarget(t, 'bar', 1))).toBe(true);
        expect(Number.isFinite(position.snap(t, 'bar'))).toBe(true);
      }
    }
    practice.set(MARKERS);
    expect(strings.length).toBeGreaterThan(1000);
    const offending = strings.filter((s) => /Bar|bar /.test(s));
    expect(offending).toEqual([]);
  });
});

test('formatTenths rounds to a tenth and carries into minutes', () => {
  expect(formatTenths(31.24)).toBe('0:31.2');
  expect(formatTenths(59.96)).toBe('1:00.0');
  expect(formatTenths(0)).toBe('0:00.0');
  expect(formatTenths(NaN)).toBe('0:00.0');
});
