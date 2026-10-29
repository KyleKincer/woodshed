// The map lanes' pure helpers (src/js/map-lane.js; architecture §0.1 "layout code takes dimensions as
// inputs", §1 "map-lane.js (pure helpers only)"; spec §5.1; maps/mapedit.md §6). No DOM: every
// width and height is an argument.
import {describe, expect, test} from 'vitest';
import {fraction} from '../shared/notation.ts';
import {SongMapStore} from '../src/js/song-map.js';
import {
  DIAMOND, HIT, PIN_GAP, RULER_MIN_PX, diamond, dragTime, guides, hitPin, nearestBar, rulerMarks, sectionBlocks,
  segments, suggestionBlocks, tempoGeometry, tempoRange, timeScale,
} from '../src/js/map-lane.js';
import {legacySongMap, mapStore, sectioned, sevenEight} from './fixtures/maps.js';

const map = (pins, bars = 12) => new SongMapStore({version: 1, measures: Array.from({length: bars}, (_, i) => ({id: 'm' + i, numerator: 4, denominator: 4, length: fraction(4), label: ''})), pins}, 24);

describe('tempo segments and range', () => {
  test('a stretch that disagrees with both neighbours is flagged as a likely miscount', () => {
    // 120 BPM everywhere except bars 3–4, which read 4 beats fast (a missing bar).
    const store = map([{position: fraction(0), time: 0}, {position: fraction(8), time: 4}, {position: fraction(12), time: 5.6}, {position: fraction(20), time: 9.6}]);
    const segs = segments(store, 24);
    expect(segs.filter((s) => s.suspect)).toHaveLength(1);
    expect(Math.round(segs.find((s) => s.suspect).q0)).toBe(150);
  });

  test('the lane range ignores outliers and always has room around a steady tempo', () => {
    const steady = tempoRange([{t0: 0, t1: 20, q0: 120, q1: 120}]);
    expect(steady.lo).toBeLessThan(120);
    expect(steady.hi).toBeGreaterThan(120);
    const withGap = tempoRange([{t0: 0, t1: 20, q0: 100, q1: 112}, {t0: 20, t1: 20.02, q0: 900, q1: 900}]);
    expect(withGap.hi).toBeLessThan(140);
    expect(guides({lo: 92, hi: 118})).toEqual([100, 110]);
  });
});

describe('timeScale', () => {
  test('maps a window to pixels and back; an empty window maps everything to its start', () => {
    const s = timeScale({t0: 10, span: 20, width: 400});
    expect(s.x(10)).toBe(0);
    expect(s.x(30)).toBe(400);
    expect(s.x(15)).toBe(100);
    expect(s.t(100)).toBe(15);
    const empty = timeScale({t0: 3, span: 0, width: 400});
    expect(empty.x(9)).toBe(0);
    expect(empty.t(200)).toBe(3);
  });
});

describe('rulerMarks', () => {
  test('numbers thin to ≥ 26 px apart, but bar 1 (with its meter chip), section starts and the selected bar always show', () => {
    const m = mapStore(sectioned);
    // 64 bars in 800 px: 12.5 px a bar, so every 4th bar is numbered.
    const marks = rulerMarks(m, {t0: 0, span: 128, width: 800, selected: 13});
    expect(marks[0]).toMatchObject({index: 0, display: 1, x: 0, meter: '4/4', label: 'Intro'});
    const free = marks.filter((k) => !k.label && !k.selected && !k.change);
    for (const k of free) expect((k.display - 1) % 4, `bar ${k.display}`).toBe(0);
    // Every free mark keeps RULER_MIN_PX from the mark before it.
    marks.forEach((k, i) => {
      if (i && !k.label && !k.selected && !k.change) expect(k.x - marks[i - 1].x).toBeGreaterThanOrEqual(RULER_MIN_PX);
    });
    expect(marks.filter((k) => k.label).map((k) => k.label)).toEqual(['Intro', 'Verse', 'Chorus', 'Verse 2', 'Chorus 2', 'Bridge', 'Chorus 3', 'Outro']);
    expect(marks.find((k) => k.index === 13)).toMatchObject({selected: true, display: 14});
    expect(marks.filter((k) => k.meter)).toHaveLength(1);
  });

  test('zoomed in every bar is numbered; marks outside the window or the recording are left out', () => {
    const m = mapStore(sectioned);
    const marks = rulerMarks(m, {t0: 20, span: 16, width: 800});
    expect(marks.map((k) => k.display)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(marks[0].x).toBe(0);
    expect(marks.at(-1).x).toBe(800);
    expect(rulerMarks(m, {t0: 0, span: 0, width: 800})).toEqual([]);
    expect(rulerMarks(m, {t0: 0, span: 128, width: 800, duration: 10}).every((k) => m.bars[k.index].t0 < 10)).toBe(true);
  });

  test('a meter change carries its chip', () => {
    const m = new SongMapStore({version: 1, pins: [{position: fraction(0), time: 0}], measures: [
      {id: 'a', numerator: 4, denominator: 4, length: fraction(4), label: ''},
      {id: 'b', numerator: 4, denominator: 4, length: fraction(4), label: ''},
      {id: 'c', numerator: 7, denominator: 8, length: fraction(7, 2), label: ''},
      {id: 'd', numerator: 7, denominator: 8, length: fraction(7, 2), label: ''},
    ]}, 8);
    const marks = rulerMarks(m, {t0: 0, span: 8, width: 800});
    // (The store extends the last meter to cover the recording.)
    expect(marks.map((k) => k.meter).slice(0, 4)).toEqual(['4/4', null, '7/8', null]);
    expect(marks.slice(4).every((k) => k.meter === null)).toBe(true);
  });
});

describe('tempoGeometry', () => {
  test('head, steady span and tail: open spans are flagged, labels read the tempo, pins sit on the curve', () => {
    const m = mapStore(legacySongMap);   // bar 1 at 1.0 s, bar 5 at 9.0 s: 120 bpm, 30 s
    const geo = tempoGeometry(m, {t0: 0, span: 30, width: 600, height: 96});
    expect(geo.paths.map((p) => p.kind)).toEqual(['head', 'steady', 'tail']);
    expect(geo.paths.map((p) => p.open)).toEqual([true, false, true]);
    expect(geo.paths[1].label).toBe('120');
    expect(geo.paths[2].label).toBe('120 →');
    expect(geo.paths[0].label).toBeNull();   // 20 px is too narrow for a label
    expect(geo.connectors).toHaveLength(2);
    expect(geo.pins.map((p) => p.x)).toEqual([20, 180]);
    for (const p of geo.pins) expect(p.y).toBeCloseTo(geo.y(120), 6);
    for (const g of geo.guides) {
      expect(g.y).toBeGreaterThanOrEqual(0);
      expect(g.y).toBeLessThanOrEqual(96);
    }
  });

  test('a felt pulse other than the quarter labels with its unit; a window clips the paths and drops off-screen pins', () => {
    const m = mapStore(sevenEight);
    const geo = tempoGeometry(m, {t0: 0, span: 14, width: 700, height: 96});
    expect(geo.paths.at(-1).label).toMatch(/→$/);
    const clipped = tempoGeometry(mapStore(legacySongMap), {t0: 10, span: 10, width: 500, height: 96});
    expect(clipped.pins).toHaveLength(0);
    expect(clipped.paths).toHaveLength(1);
    expect(clipped.paths[0].points[0][0]).toBe(0);
    expect(clipped.paths[0].points.at(-1)[0]).toBe(500);
  });

  test('an empty window draws nothing but keeps the range and guides', () => {
    const geo = tempoGeometry(mapStore(sectioned), {t0: 0, span: 0, width: 0, height: 96});
    expect(geo.paths).toEqual([]);
    expect(geo.pins).toEqual([]);
    expect(geo.guides.length).toBeGreaterThan(0);
  });
});

describe('pins: diamonds and hits', () => {
  test('a pin is a 12 px diamond', () => {
    expect(DIAMOND).toBe(12);
    expect(diamond(10, 10)).toEqual([[10, 4], [16, 10], [10, 16], [4, 10]]);
  });

  test('hit areas are 24 px fine and 44 px coarse, centred on the diamond; the nearest wins; the column rule catches the rest', () => {
    expect(HIT).toEqual({fine: 24, coarse: 44});
    const pins = [{x: 100, y: 50, id: 'a'}, {x: 130, y: 50, id: 'b'}];
    expect(hitPin(pins, 105, 52)?.id).toBe('a');
    expect(hitPin(pins, 112, 50)?.id).toBe('a');
    expect(hitPin(pins, 119, 50)?.id).toBe('b');
    expect(hitPin(pins, 115, 63)).toBeNull();                       // outside both 24 px squares and both columns
    expect(hitPin(pins, 102, 90)?.id).toBe('a');                   // the column: ≤ 6 px across, any height
    expect(hitPin(pins, 115, 63, {hit: HIT.coarse})?.id).toBe('a'); // 44 px: inside both, 'a' is nearer
    expect(hitPin([], 0, 0)).toBeNull();
  });

  test('a dragged pin stays inside the recording and 2 ms inside its neighbours', () => {
    const m = mapStore(legacySongMap);
    expect(PIN_GAP).toBe(0.002);
    expect(dragTime(m, fraction(16), 0.5)).toBeCloseTo(1 + PIN_GAP, 9);
    expect(dragTime(m, fraction(16), 100)).toBe(30);
    expect(dragTime(m, fraction(16), 12.25)).toBe(12.25);
    expect(dragTime(m, fraction(0), -4)).toBe(0);
    expect(dragTime(m, fraction(0), 20)).toBeCloseTo(9 - PIN_GAP, 9);
  });
});

describe('sections and suggestions', () => {
  test('one block per section in the window, clipped to the lane, with display bar numbers', () => {
    const m = mapStore(sectioned);
    const blocks = sectionBlocks(m, {t0: 0, span: 128, width: 640});
    expect(blocks.map((b) => b.name)).toEqual(['Intro', 'Verse', 'Chorus', 'Verse 2', 'Chorus 2', 'Bridge', 'Chorus 3', 'Outro']);
    expect(blocks[0]).toMatchObject({startBar: 0, endBar: 7, from: 1, to: 8, x0: 0, x1: 80, pickup: false});
    const zoomed = sectionBlocks(m, {t0: 20, span: 16, width: 800});
    expect(zoomed.map((b) => b.name)).toEqual(['Verse', 'Chorus']);
    expect(zoomed[0].x0).toBe(0);
    expect(zoomed[1].x1).toBe(800);
    expect(sectionBlocks(m, {t0: 0, span: 0, width: 640})).toEqual([]);
  });

  test('suggestion blocks snap to the nearest bar and run to the next block (the last to the end)', () => {
    const m = mapStore(sectioned);
    expect(nearestBar(m, 31.1)).toBe(16);
    expect(nearestBar(m, 30.9)).toBe(15);
    const blocks = suggestionBlocks(m, [{t0: 31.9, label: 'B'}, {t0: 0.1, label: 'A'}], {t0: 0, span: 128, width: 640});
    expect(blocks.map((b) => [b.i, b.label, b.bar, b.display, b.t0, b.t1, b.accepted])).toEqual([
      [1, 'A', 0, 1, 0, 32, true],
      [0, 'B', 16, 17, 32, 128, true],
    ]);
    const review = suggestionBlocks(m, [{bar: 0, label: 'A', accepted: true}, {bar: 40, label: 'C', accepted: false}], {t0: 0, span: 128, width: 640});
    expect(review.map((b) => [b.bar, b.accepted, b.x0, b.x1])).toEqual([[0, true, 0, 400], [40, false, 400, 640]]);
    expect(suggestionBlocks(m, null)).toEqual([]);
  });
});
