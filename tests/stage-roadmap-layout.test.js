// The Road map and Wave page row layout (src/stage/surfaces/roadmap-layout.js; architecture
// §2.14.12, spec §4.4B/C). Pure: dimensions are inputs, so every rule is checked here without a
// layout engine; the rendered geometry is checked by the harness states (tests/fixture/states/ST10.cjs).
import {describe, expect, test} from 'vitest';
import {
  barsPerRow, beatTicks, cellOfTime, clampSeconds, clockLabel, defaultSeconds, followScrollTop, metrics, nearestStep,
  pageScrollTop, roadmapLayout, rowAtY, rowInView, rowOfTime, secondTicks, splitRows, stepSeconds, timeAtX, visibleRange,
  waveLayout, xOfTime, CELL_H, FOLLOW_ANCHOR, PAD_TOP, PAD_X, WAVE_STEPS,
} from '../src/stage/surfaces/roadmap-layout.js';
import {SongMapStore} from '../src/js/song-map.js';
import {mapStore, pickup, sectioned, sevenEight, tempoOf} from './fixtures/maps.js';

const frac = (n, d = 1) => ({n, d});
const rehearsal = () => mapStore(sectioned);

/** The rehearsal map with a 7/8 (2+2+3) Bridge (bars 41–48) and a 12-bar Outro made of the last sections. */
function meterMap() {
  const tempo = tempoOf(sectioned);
  for (let i = 40; i < 48; i++) Object.assign(tempo.songMap.measures[i], {numerator: 7, denominator: 8, length: frac(7, 2), grouping: [2, 2, 3]});
  return SongMapStore.fromTempo(tempo, 124);
}

/** The rehearsal map with only two labels: Intro (bars 1–4) and a 60-bar Jam (wraps). */
function longSection() {
  const tempo = tempoOf(sectioned);
  tempo.songMap.measures.forEach((m, i) => { m.label = i === 0 ? 'Intro' : i === 4 ? 'Jam' : ''; });
  return SongMapStore.fromTempo(tempo, 128);
}

describe('bars per row (spec §4.4B)', () => {
  test.each([
    ['rail with ≥ 1100 px of music', 'rail', 1176, 8],
    ['rail exactly 1100', 'rail', 1100, 8],
    ['a narrow rail (1280 − 232)', 'rail', 1048, 4],
    ['band (iPad portrait)', 'band', 820, 4],
    ['a wide band window', 'band', 1400, 4],
  ])('%s → %i', (_, layout, width, n) => {
    expect(barsPerRow({layout, width})).toBe(n);
  });
});

describe('Road map rows', () => {
  test('the rehearsal song on the rail: one row per section, 8 bars each, every row headed', () => {
    const map = rehearsal();
    const l = roadmapLayout({bars: map.bars, sections: map.sections, width: 1176, layout: 'rail'});
    expect(l.perRow).toBe(8);
    expect(l.rows).toHaveLength(8);
    expect(l.rows.every((r) => r.heading && r.cells.length === 8)).toBe(true);
    expect(l.rows.map((r) => r.section)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(l.cellW).toBe(Math.floor((1176 - 2 * PAD_X) / 8));
  });

  test('on the band a section of 8 bars wraps into two rows of 4; only the first is headed', () => {
    const map = rehearsal();
    const l = roadmapLayout({bars: map.bars, sections: map.sections, width: 820, layout: 'band'});
    expect(l.rows).toHaveLength(16);
    expect(l.rows.slice(0, 4).map((r) => [r.first, r.last, r.heading, r.section])).toEqual([[0, 3, true, 0], [4, 7, false, 0], [8, 11, true, 1], [12, 15, false, 1]]);
    expect(l.cellW).toBe(Math.floor((820 - 2 * PAD_X) / 4));
  });

  test('a meter change starts a new row; the bars after it continue in rows of their own', () => {
    const map = meterMap();
    const split = splitRows({bars: map.bars, sections: map.sections, perRow: 8});
    const bridge = split.find((r) => r.first === 40);
    expect(bridge).toMatchObject({first: 40, last: 47, heading: true});
    // Chorus 3 (bar 49) is both a section start and a meter change back to 4/4.
    expect(split.find((r) => r.first === 48)).toMatchObject({heading: true});
    // A meter change inside a section breaks the row without a heading.
    const tempo = tempoOf(sectioned);
    for (let i = 10; i < 16; i++) Object.assign(tempo.songMap.measures[i], {numerator: 3, denominator: 4, length: frac(3)});
    const m2 = SongMapStore.fromTempo(tempo, 124);
    const rows = splitRows({bars: m2.bars, sections: m2.sections, perRow: 8});
    expect(rows.find((r) => r.first === 8)).toMatchObject({last: 9, heading: true});
    expect(rows.find((r) => r.first === 10)).toMatchObject({last: 15, heading: false});
  });

  test('a long section wraps every perRow bars', () => {
    const map = longSection();
    const rows = splitRows({bars: map.bars, sections: map.sections, perRow: 8});
    expect(rows.map((r) => [r.first, r.last])).toEqual([[0, 3], [4, 11], [12, 19], [20, 27], [28, 35], [36, 43], [44, 51], [52, 59], [60, 63]]);
    expect(rows.map((r) => r.heading)).toEqual([true, true, false, false, false, false, false, false, false]);
  });

  test('a map without sections: rows of perRow bars and no headings', () => {
    const tempo = tempoOf(sectioned);
    for (const m of tempo.songMap.measures) m.label = '';
    const map = SongMapStore.fromTempo(tempo, 128);
    const l = roadmapLayout({bars: map.bars, sections: map.sections, width: 820, layout: 'band'});
    expect(l.rows).toHaveLength(16);
    expect(l.rows.every((r) => !r.heading && r.section === null)).toBe(true);
    expect(l.rows[0].y).toBe(PAD_TOP);
    expect(l.rows[0].band.y).toBe(PAD_TOP);
  });

  test('cells are 88 px × Distance tall: Near 70, Stand 88, Kit 114', () => {
    const map = rehearsal();
    for (const [d, h] of [[0.8, 70], [1, CELL_H], [1.3, 114]]) {
      const l = roadmapLayout({bars: map.bars, sections: map.sections, width: 1176, layout: 'rail', distance: d});
      expect(l.rows.every((r) => r.band.h === h)).toBe(true);
      expect(metrics(d).cellH).toBe(h);
    }
  });

  test('rows stack top to bottom: heading, then the flag lane when a spot starts there, then the cells', () => {
    const map = rehearsal();
    const m = metrics(1);
    const l = roadmapLayout({bars: map.bars, sections: map.sections, width: 1176, layout: 'rail', flags: [28, {t: 81}]});
    const [intro, verse] = l.rows;
    expect(intro.flag).toBe(false);
    expect(intro.band.y).toBe(intro.y + m.headingH);
    expect(verse.flag).toBe(true);                       // 28 s is bar 15 (Verse)
    expect(verse.band.y).toBe(verse.y + m.headingH + m.flagH);
    expect(verse.y).toBe(intro.y + intro.h + m.gap);
    expect(l.rows[5].flag).toBe(true);                   // 81 s: the Bridge
    for (let i = 1; i < l.rows.length; i++) expect(l.rows[i].y).toBe(l.rows[i - 1].y + l.rows[i - 1].h + m.gap);
  });

  test('the content is tall enough for the last row to reach the follow line', () => {
    const map = rehearsal();
    const l = roadmapLayout({bars: map.bars, sections: map.sections, width: 1176, layout: 'rail', viewportH: 800});
    const last = l.rows[l.rows.length - 1];
    expect(followScrollTop(last, {viewportH: 800, contentH: l.height})).toBe(Math.round(last.y - FOLLOW_ANCHOR * 800));
  });

  test('a pickup is its own first cell; times map linearly across each cell and back', () => {
    const map = mapStore(pickup);
    const l = roadmapLayout({bars: map.bars, sections: map.sections, width: 820, layout: 'band'});
    const row = l.rows[0];
    expect(row.first).toBe(0);
    expect(map.bars[0].pickup).toBe(true);
    const cell = row.cells[1];   // bar 1: 1.5–3.5 s
    expect(cellOfTime(row, 2.5, map.bars)).toBe(cell);
    expect(xOfTime(row, 2.5, map.bars)).toBeCloseTo(cell.x + cell.w / 2, 6);
    for (const t of [0.6, 1.5, 2.25, 5.9]) {
      const back = timeAtX(row, xOfTime(row, t, map.bars), map.bars);
      expect(back.t).toBeCloseTo(t, 6);
      expect(back.bar).toBe(map.barIndexAt(t));
    }
    expect(timeAtX(row, -50, map.bars)).toEqual({t: map.bars[0].t0, bar: 0});
  });
});

describe('Wave page rows', () => {
  test('10 s rows on the rail, 8 s on the band (spec §4.4C)', () => {
    expect(defaultSeconds('rail')).toBe(10);
    expect(defaultSeconds('band')).toBe(8);
    const rail = waveLayout({duration: 128, seconds: 10, width: 1176});
    expect(rail.rows).toHaveLength(13);
    expect(rail.rows.map((r) => [r.t0, r.t1]).slice(-2)).toEqual([[110, 120], [120, 128]]);
    expect(rail.rows[0].band.w).toBe(1176 - 2 * PAD_X);
    expect(rail.rows[12].band.w).toBeCloseTo((8 / 10) * (1176 - 2 * PAD_X), 6);
    const band = waveLayout({duration: 128, seconds: 8, width: 820});
    expect(band.rows).toHaveLength(16);
  });

  test('a time lane sits over each waveform, a flag lane over rows with a marker or a spot', () => {
    const m = metrics(1);
    const l = waveLayout({duration: 60, seconds: 10, width: 1000, flags: [12, 41]});
    expect(l.rows[0]).toMatchObject({flag: false, timeY: l.rows[0].y});
    expect(l.rows[0].band.y).toBe(l.rows[0].y + m.timeH);
    expect(l.rows[1]).toMatchObject({flag: true});
    expect(l.rows[1].timeY).toBe(l.rows[1].y + m.flagH);
    expect(l.rows[4].flag).toBe(true);
    expect(l.rows[2].flag).toBe(false);
  });

  test('= and − step the row length through 4–30 s; a pinch lands on the nearest step', () => {
    expect(stepSeconds(10, 1)).toBe(8);
    expect(stepSeconds(10, -1)).toBe(12);
    expect(stepSeconds(4, 1)).toBe(4);
    expect(stepSeconds(30, -1)).toBe(30);
    expect(stepSeconds(9, 1)).toBe(8);
    expect(stepSeconds(9, -1)).toBe(10);
    let s = 10;
    for (let i = 0; i < 20; i++) s = stepSeconds(s, -1);
    expect(s).toBe(30);
    for (let i = 0; i < 20; i++) s = stepSeconds(s, 1);
    expect(s).toBe(4);
    expect(nearestStep(11.2)).toBe(12);
    expect(nearestStep(2)).toBe(4);
    expect(nearestStep(90)).toBe(30);
    expect(clampSeconds(NaN)).toBe(8);
    expect(WAVE_STEPS[0]).toBe(4);
  });

  test('second ticks every second with an m:ss label every 5 s', () => {
    const [, row] = waveLayout({duration: 60, seconds: 10, width: 1000}).rows;
    const ticks = secondTicks(row);
    expect(ticks.map((t) => t.t)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(ticks.filter((t) => t.major).map((t) => t.label)).toEqual(['0:10', '0:15', '0:20']);
    expect(clockLabel(45.9)).toBe('0:45');
    expect(clockLabel(125)).toBe('2:05');
  });

  test('time ↔ x on a row', () => {
    const l = waveLayout({duration: 30, seconds: 10, width: 1032});
    const row = l.rows[1];
    expect(xOfTime(row, 15, null)).toBeCloseTo(PAD_X + 500, 6);
    expect(timeAtX(row, PAD_X + 250, null)).toEqual({t: 12.5, bar: null});
    expect(timeAtX(row, 99999, null).t).toBe(20);
  });
});

describe('lookups and follow', () => {
  const map = rehearsal();
  const l = roadmapLayout({bars: map.bars, sections: map.sections, width: 820, layout: 'band', viewportH: 900});

  test('rowOfTime: a time on a row break starts the later row, or ends the earlier one (side b)', () => {
    expect(rowOfTime(l.rows, 0)).toBe(0);
    expect(rowOfTime(l.rows, 7.99)).toBe(0);
    expect(rowOfTime(l.rows, 8)).toBe(1);
    expect(rowOfTime(l.rows, 8, 'b')).toBe(0);
    expect(rowOfTime(l.rows, -3)).toBe(0);
    expect(rowOfTime(l.rows, 500)).toBe(15);
    expect(rowOfTime([], 1)).toBe(-1);
  });

  test('rowAtY and the virtualised range: the visible rows plus 2 either side', () => {
    expect(rowAtY(l.rows, 0)).toBe(0);
    expect(rowAtY(l.rows, l.rows[5].y + 1)).toBe(5);
    const top = l.rows[6].y, bottom = l.rows[9].y + l.rows[9].h;
    expect(visibleRange(l.rows, top, bottom, 2)).toEqual({first: 4, last: 11});
    expect(visibleRange(l.rows, 0, 200, 2).first).toBe(0);
    expect(visibleRange(l.rows, l.height - 10, l.height, 2).last).toBe(15);
  });

  test('scroll follow puts the row 30% down; page follow turns half a page past the middle', () => {
    const row = l.rows[8];
    expect(followScrollTop(row, {viewportH: 1000, contentH: l.height})).toBe(Math.round(row.y - 300));
    expect(followScrollTop(l.rows[0], {viewportH: 1000, contentH: l.height})).toBe(0);
    const scrollTop = row.y - 200;   // the row's top sits 200 px down: above the middle
    expect(pageScrollTop(row, {scrollTop, viewportH: 1000, contentH: l.height})).toBeNull();
    expect(pageScrollTop(row, {scrollTop: row.y - 600, viewportH: 1000, contentH: l.height})).toBe(row.y - 100);
    // Out of view: straight to the follow line.
    expect(pageScrollTop(row, {scrollTop: row.y + 2000, viewportH: 1000, contentH: l.height + 5000})).toBe(Math.round(row.y - 300));
    expect(rowInView(row, {scrollTop: row.y - 10, viewportH: 1000})).toBe(true);
    expect(rowInView(row, {scrollTop: row.y + 10, viewportH: 1000})).toBe(false);
  });
});

describe('beat ticks (grouping-aware)', () => {
  test('4/4: four counted beats, the first is the downbeat', () => {
    const map = rehearsal();
    const ticks = beatTicks(map.bars[2], (q) => map.timeAt(q));
    expect(ticks.map((t) => t.t)).toEqual([4, 4.5, 5, 5.5]);
    expect(ticks.map((t) => [t.counted, t.first])).toEqual([[true, true], [true, false], [true, false], [true, false]]);
  });

  test('7/8 (2+2+3): seven units, three counted beats at units 1, 3 and 5', () => {
    const map = mapStore(sevenEight);
    const ticks = beatTicks(map.bars[0], (q) => map.timeAt(q));
    expect(ticks).toHaveLength(7);
    expect(ticks.map((t) => t.counted)).toEqual([true, false, true, false, true, false, false]);
    expect(ticks.map((t) => t.group)).toEqual([0, 0, 1, 1, 2, 2, 2]);
    expect(ticks[2].t).toBeCloseTo(0.5, 6);   // two eighths at 120 qpm
  });

  test('a two-beat pickup holds the bar\'s last two beats, none of them a downbeat', () => {
    const map = mapStore(pickup);
    const ticks = beatTicks(map.bars[0], (q) => map.timeAt(q));
    expect(ticks.map((t) => [t.t, t.group, t.first])).toEqual([[0.5, 2, false], [1, 3, false]]);
  });
});
