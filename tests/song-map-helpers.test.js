// Bar/time helpers on SongMapStore and the pure section builders (architecture §4.3–4.6).
import {describe, expect, test} from 'vitest';
import {fraction} from '../shared/notation.ts';
import {barsOf, sectionsOf, fromTaps, sectionsFromMarkers, applySuggestion, defaultSongMap, editBars, setMeter, compile, timeAt, validateSongMap, START_SECTION} from '../shared/song-map.ts';
import {SongMapStore} from '../src/js/song-map.js';
import {mapStore, pickup, sevenEight, sectioned, unmapped, REHEARSAL_SECTIONS} from './fixtures/maps.js';

const labelled = (labels, {duration = 40, pickupLength} = {}) => {
  const data = defaultSongMap(duration);
  if (pickupLength) data.measures[0].length = fraction(pickupLength);
  for (const [i, label] of Object.entries(labels)) data.measures[i].label = label;
  data.origin = 'edited';
  return new SongMapStore(data, duration);
};
/** The HUD's Position main text (§4.4), built from barBeatAt. */
const positionText = (bb) => bb.pickup || bb.before ? `Pickup · ${bb.beat}` : `${bb.display} · ${bb.beat}`;
/** The HUD's Next text (§4.4), built from nextSection and the current bar's counted beats. */
const nextText = (map, t) => {
  const next = map.nextSection(t);
  if (!next) return null;
  if (next.barsUntil > 2) return `next: ${next.section.name} · ${next.barsUntil} ${next.barsUntil === 1 ? 'bar' : 'bars'}`;
  const bpb = map.barBeatAt(t).groups.length, B = Math.floor((next.beatsUntil - 1) / bpb), b = ((next.beatsUntil - 1) % bpb) + 1;
  return B === 0 ? `${next.section.name} in ${b}` : `${next.section.name} in ${B} · ${b}`;
};

describe('bars', () => {
  test('display numbers skip a pickup; bar 1 is the first full bar', () => {
    const bars = mapStore(pickup).bars;
    expect(bars.map((b) => b.display).slice(0, 4)).toEqual([null, 1, 2, 3]);
    expect(bars[0]).toMatchObject({index: 0, id: 'p0', pickup: true, q0: 0, q1: 2, t0: 0.5, t1: 1.5});
    expect(bars[1]).toMatchObject({pickup: false, t0: 1.5, t1: 3.5, qpm: 120, bpm: 120, meterChange: false, tempoChange: false});
    expect(mapStore(sectioned).bars.map((b) => b.display).slice(0, 3)).toEqual([1, 2, 3]);
  });
  test('only bars starting inside the recording are listed; the last one ends at the duration', () => {
    const bars = mapStore(pickup).bars;
    expect(bars).toHaveLength(11);
    expect(bars.at(-1)).toMatchObject({t0: 19.5, t1: 20});
    const short = new SongMapStore(defaultSongMap(20), 20);
    short.setDuration(5);
    expect(short.bars.map((b) => [b.t0, b.t1])).toEqual([[0, 2], [2, 4], [4, 5]]);
  });
  test('groups, units, meter and tempo changes', () => {
    const seven = mapStore(sevenEight).bars[0];
    expect(seven).toMatchObject({numerator: 7, denominator: 8, groups: [2, 2, 3], units: 7, bpm: 240});
    const data = defaultSongMap(30);
    setMeter(data.measures[3], 3, 4);
    data.pins.push({position: fraction(15), time: 7.25});   // bar 5 onwards at a slower tempo
    const bars = barsOf(data, 30);
    expect(bars.map((b) => b.meterChange).slice(0, 6)).toEqual([false, false, false, true, true, false]);
    expect(bars.find((b) => b.tempoChange)?.index).toBe(4);
    expect(bars[3].bpm).toBeCloseTo(60 * 15 / 7.25, 9);
    expect(bars[4].bpm).toBeCloseTo(120, 9);
  });
});

describe('barBeatAt', () => {
  const map = mapStore(pickup);
  test('inside a pickup the beats count from the end of the bar (Pickup · 3)', () => {
    expect(map.barBeatAt(0.6)).toMatchObject({index: 0, display: null, pickup: true, before: false, beat: 3, groupIndex: 0, unitIndex: 2, downbeat: false});
    expect(positionText(map.barBeatAt(0.6))).toBe('Pickup · 3');
    expect(positionText(map.barBeatAt(1.2))).toBe('Pickup · 4');
  });
  test('before the first bar it extrapolates backwards and never reports bar 0', () => {
    const bb = map.barBeatAt(0.2);
    expect(bb).toMatchObject({index: 0, display: null, before: true, beat: 2, groupIndex: 1});
    expect(bb.phase).toBeCloseTo(0.4);
    expect(positionText(bb)).toBe('Pickup · 2');
    const plain = mapStore(sectioned);
    plain.edit((d) => { d.pins[0].time = 3; }, 'pin');
    expect(positionText(plain.barBeatAt(2.6))).toBe('Pickup · 4');
    expect(positionText(plain.barBeatAt(0.1))).toBe('Pickup · 3');
  });
  test('the downbeat of bar 1 and mid-bar beats', () => {
    expect(map.barBeatAt(1.5)).toMatchObject({index: 1, display: 1, beat: 1, groupIndex: 0, downbeat: true, phase: 0});
    expect(positionText(map.barBeatAt(2.75))).toBe('1 · 3');
    expect(map.barBeatAt(2.75).phase).toBeCloseTo(0.5);
    expect(positionText(mapStore(sectioned).barBeatAt(25))).toBe('13 · 3');
  });
  test('7/8 counts groups for the beat and units for the lamps', () => {
    const seven = mapStore(sevenEight);
    const at = (eighths) => seven.barBeatAt(1.75 + eighths * 0.25 + 0.01);
    expect([0, 1, 2, 3, 4, 5, 6].map((e) => [at(e).beat, at(e).unitIndex])).toEqual([[1, 0], [1, 1], [2, 2], [2, 3], [3, 4], [3, 5], [3, 6]]);
    expect(at(0)).toMatchObject({display: 2, groups: [2, 2, 3], units: 7, downbeat: true});
    expect(at(5).phase).toBeCloseTo(0.52 / 1.5, 9);
  });
  test('beatGrouping: labels and lamp mode', () => {
    expect(mapStore(sevenEight).beatGrouping(0)).toEqual({groups: [2, 2, 3], label: '2+2+3', counted: 3, units: 7, lampMode: 'units'});
    expect(mapStore(sectioned).beatGrouping(3)).toEqual({groups: [1, 1, 1, 1], label: '', counted: 4, units: 4, lampMode: 'units'});
    const data = defaultSongMap(20);
    setMeter(data.measures[0], 13, 8, [3, 3, 3, 4]);
    expect(new SongMapStore(data, 20).beatGrouping(0)).toMatchObject({label: '3+3+3+4', units: 13, lampMode: 'groups'});
  });
});

describe('sections', () => {
  test('the rehearsal song: one section per labelled bar, 8 bars each', () => {
    const map = mapStore(sectioned);
    expect(map.hasSections).toBe(true);
    expect(map.sections.map((s) => s.name)).toEqual([...REHEARSAL_SECTIONS]);
    expect(map.sections[5]).toMatchObject({index: 5, label: 'Bridge', name: 'Bridge', startBar: 40, endBar: 47, t0: 80, t1: 96, bars: 8});
    expect(map.sections.at(-1).t1).toBe(128);
    expect(sectionsOf(map.data, 128)).toEqual(map.sections);
  });
  test('a leading "Start" section covers unlabelled bars before the first label', () => {
    const map = labelled({4: 'Verse'});
    expect(map.sections.map((s) => [s.name, s.label, s.startBar, s.endBar])).toEqual([[START_SECTION, '', 0, 3], ['Verse', 'Verse', 4, 19]]);
  });
  test('duplicates are numbered and never collide with a written label', () => {
    expect(labelled({0: 'Chorus', 4: 'Verse', 8: 'Chorus', 12: 'Chorus'}).sections.map((s) => s.name)).toEqual(['Chorus', 'Verse', 'Chorus 2', 'Chorus 3']);
    expect(labelled({0: 'Chorus 2', 4: 'Chorus', 8: 'Chorus'}).sections.map((s) => s.name)).toEqual(['Chorus 2', 'Chorus', 'Chorus 3']);
  });
  test('a written "Start" keeps its name; the synthetic leading section takes the next free number', () => {
    expect(labelled({2: 'Chorus', 4: 'Chorus', 6: 'Chorus 2', 8: 'Start'}).sections.map((s) => [s.name, s.label]))
      .toEqual([['Start 2', ''], ['Chorus', 'Chorus'], ['Chorus 3', 'Chorus'], ['Chorus 2', 'Chorus 2'], ['Start', 'Start']]);
    expect(labelled({2: 'Start', 4: 'Start 2'}).sections.map((s) => s.name)).toEqual(['Start 3', 'Start', 'Start 2']);
    expect(labelled({0: 'Start', 4: 'Start'}).sections.map((s) => s.name)).toEqual(['Start', 'Start 2']);
  });
  test("measure 0's auto 'Pickup' label is ignored; no labels means no sections", () => {
    expect(labelled({0: 'Pickup'}, {pickupLength: 2}).sections).toEqual([]);
    expect(labelled({0: 'Pickup', 3: 'Verse'}, {pickupLength: 2}).sections.map((s) => [s.name, s.startBar])).toEqual([['Start', 0], ['Verse', 3]]);
    expect(mapStore(unmapped).hasSections).toBe(false);
    expect(mapStore(unmapped).sectionAt(4)).toBeNull();
  });
  test('sectionAt clamps into the recording', () => {
    const map = mapStore(sectioned);
    expect(map.sectionAt(0).name).toBe('Intro');
    expect(map.sectionAt(-3).name).toBe('Intro');
    expect(map.sectionAt(16).name).toBe('Verse');
    expect(map.sectionAt(15.999).name).toBe('Intro');
    expect(map.sectionAt(500).name).toBe('Outro');
  });
});

describe('nextSection', () => {
  const map = mapStore(sectioned);
  test('counts bars, counted beats (the downbeat included) and seconds', () => {
    expect(map.nextSection(10)).toMatchObject({barsUntil: 3, beatsUntil: 12, timeUntil: 6});
    expect(map.nextSection(10).section.name).toBe('Verse');
    expect(map.nextSection(12.25)).toMatchObject({barsUntil: 2, beatsUntil: 8});
    expect(map.nextSection(15.1)).toMatchObject({barsUntil: 1, beatsUntil: 2});
    expect(map.nextSection(16).section.name).toBe('Chorus');
    expect(map.nextSection(120)).toBeNull();
  });
  test('drives the HUD Next line (§4.4)', () => {
    expect(nextText(map, 10)).toBe('next: Verse · 3 bars');
    expect(nextText(map, 12.25)).toBe('Verse in 1 · 4');
    expect(nextText(map, 14.1)).toBe('Verse in 4');
    expect(nextText(map, 15.6)).toBe('Verse in 1');
  });
  test('before the first bar, and through a pickup', () => {
    const map = labelled({0: 'Intro', 1: 'Verse'}, {pickupLength: 2});
    map.edit((d) => { d.pins[0].time = 1; }, 'pin');     // pickup 1–2 s, bar 1 at 2 s
    const before = map.nextSection(0.4);
    expect(before.section.name).toBe('Intro');
    expect(before).toMatchObject({barsUntil: 1, beatsUntil: 2});
    expect(before.timeUntil).toBeCloseTo(0.6, 9);
    expect(nextText(map, 0.4)).toBe('Intro in 2');
    expect(map.nextSection(1.2)).toMatchObject({barsUntil: 1, beatsUntil: 2});
    expect(nextText(map, 1.2)).toBe('Verse in 2');
    const later = labelled({4: 'Verse'}, {pickupLength: 2});
    later.edit((d) => { d.pins[0].time = 1; }, 'pin');
    expect(later.nextSection(0.4).section.name).toBe('Start');
    expect(later.nextSection(1.2)).toMatchObject({barsUntil: 4, beatsUntil: 1 + 12 + 1});
  });
});

describe('downbeatAfter', () => {
  test('skips a pickup start and honours `after`', () => {
    const map = mapStore(pickup);
    expect(map.downbeatAfter(0.1)).toEqual({index: 1, time: 1.5});
    expect(map.downbeatAfter(1.5)).toEqual({index: 2, time: 3.5});
    expect(map.downbeatAfter(1.4995, {after: 0.001})).toEqual({index: 2, time: 3.5});
    expect(map.downbeatAfter(19.6)).toBeNull();
  });
  test('within a loop: null when no downbeat lies before its end', () => {
    const map = mapStore(sectioned);
    expect(map.downbeatAfter(9, {within: [8, 16]})).toEqual({index: 5, time: 10});
    expect(map.downbeatAfter(14.5, {within: [8, 16]})).toBeNull();
    expect(map.downbeatAfter(14.5)).toEqual({index: 8, time: 16});
  });
});

describe('barToTime, timeToBar and phraseAt', () => {
  test('barToTime with groups and fractions, clamped, bars.length = the end', () => {
    const map = mapStore(sevenEight);
    expect(map.barToTime(2)).toBeCloseTo(3.5);
    expect(map.barToTime(2, {group: 2})).toBeCloseTo(4.5);
    expect(map.barToTime(2, {group: 2, frac: 0.5})).toBeCloseTo(4.875);
    expect(map.barToTime(-4)).toBe(0);
    expect(map.barToTime(8)).toBe(14);
    expect(map.barToTime(99)).toBe(14);
    expect(mapStore(pickup).barToTime(0, {group: 1})).toBeCloseTo(1);
  });
  test('timeToBar gives the bar and quarters into it', () => {
    expect(mapStore(sevenEight).timeToBar(4.0)).toEqual({index: 2, q: 1});
    const before = mapStore(pickup).timeToBar(0.25);
    expect(before.index).toBe(0);
    expect(before.q).toBeCloseTo(-0.5);
  });
  test('phrases align to the section start, else to the first downbeat bar', () => {
    const map = mapStore(sectioned);
    expect(map.phraseAt(map.barToTime(12))).toEqual({startBar: 12, endBar: 15});
    expect(map.phraseAt(map.barToTime(9) + 0.5)).toEqual({startBar: 8, endBar: 11});
    expect(map.phraseAt(map.barToTime(9), 8)).toEqual({startBar: 8, endBar: 15});
    const short = labelled({0: 'A', 6: 'B'});
    expect(short.phraseAt(short.barToTime(5))).toEqual({startBar: 4, endBar: 5});
    const p = mapStore(pickup);
    expect(p.phraseAt(p.barToTime(6))).toEqual({startBar: 5, endBar: 8});
    expect(p.phraseAt(0.7)).toEqual({startBar: 1, endBar: 4});
    expect(p.phraseAt(19.7)).toEqual({startBar: 9, endBar: 10});
  });
});

describe('bar refs', () => {
  test('refAt/timeOfRef round-trip, and refs follow their bar across a meter edit', () => {
    const map = mapStore(sectioned), t = map.barToTime(20, {group: 2, frac: 0.5});
    const ref = map.refAt(t);
    expect(ref).toEqual({id: 'g20', beat: 2, frac: 0.5});
    expect(map.timeOfRef(ref)).toBeCloseTo(t, 9);
    const end = map.refAt(map.sections[2].t1);
    // Bars 3–4 become 3/4 with bar lines kept: later bars keep their ids and move earlier by two beats.
    map.edit((d) => editBars(d, 3, 4, (m) => setMeter(m, 3, 4)), 'meter');
    expect(map.timeOfRef(ref)).toBeCloseTo(t - 1, 9);
    expect(map.timeOfRef(end)).toBeCloseTo(map.sections[3].t0, 9);
    const inShortBar = map.refAt(map.barToTime(4, {group: 2}));
    map.edit((d) => editBars(d, 4, 4, (m) => setMeter(m, 2, 4)), 'meter');
    expect(map.timeOfRef(inShortBar)).toBeCloseTo(map.barToTime(4, {group: 1}), 9);
  });
  test('a ref to a bar that no longer exists resolves to null; before bar 0 there is no ref', () => {
    const map = mapStore(pickup);
    expect(map.refAt(0.2)).toBeNull();
    expect(map.timeOfRef({id: 'gone', beat: 0, frac: 0})).toBeNull();
    expect(map.timeOfRef(null)).toBeNull();
    const ref = map.refAt(19.8);
    map.setDuration(12);
    expect(map.timeOfRef(ref)).toBeNull();
  });
  test('the song end is a valid ref', () => {
    const map = mapStore(sectioned), ref = map.refAt(128);
    expect(ref).toEqual({id: 'g63', beat: 3, frac: 1});
    expect(map.timeOfRef(ref)).toBeCloseTo(128, 9);
  });
});

describe('snapTime', () => {
  const map = mapStore(sevenEight);
  test('bar, beat and unit, nearest by default', () => {
    expect(map.snapTime(2.4, 'bar')).toBeCloseTo(1.75);
    expect(map.snapTime(2.7, 'bar')).toBeCloseTo(3.5);
    expect(map.snapTime(2.7, 'beat')).toBeCloseTo(2.75);
    expect(map.snapTime(3.1, 'beat')).toBeCloseTo(2.75);
    expect(map.snapTime(3.2, 'beat')).toBeCloseTo(3.5);
    expect(map.snapTime(3.1, 'unit')).toBeCloseTo(3.0);
  });
  test('floor and ceil, and exact hits stay put', () => {
    expect(map.snapTime(2.7, 'bar', {mode: 'floor'})).toBeCloseTo(1.75);
    expect(map.snapTime(2.0, 'bar', {mode: 'ceil'})).toBeCloseTo(3.5);
    expect(map.snapTime(2.3, 'beat', {mode: 'floor'})).toBeCloseTo(2.25);
    expect(map.snapTime(2.3, 'beat', {mode: 'ceil'})).toBeCloseTo(2.75);
    expect(map.snapTime(3.5, 'beat', {mode: 'floor'})).toBeCloseTo(3.5);
    expect(map.snapTime(3.5, 'unit', {mode: 'ceil'})).toBeCloseTo(3.5);
  });
  test('before the first downbeat the grid is extrapolated: floor ≤ t and ceil ≥ t', () => {
    const early = mapStore(pickup);              // pickup from 0.5 s, beats every 0.5 s, bar 1 at 1.5 s
    expect(early.snapTime(0.2, 'bar', {mode: 'floor'})).toBeCloseTo(-0.5);
    expect(early.snapTime(0.2, 'bar', {mode: 'ceil'})).toBeCloseTo(0.5);
    expect(early.snapTime(0.2, 'beat', {mode: 'floor'})).toBeCloseTo(0);
    expect(early.snapTime(0.2, 'beat', {mode: 'ceil'})).toBeCloseTo(0.5);
    expect(early.snapTime(0.2, 'beat')).toBeCloseTo(0);
    expect(early.snapTime(0.4, 'unit')).toBeCloseTo(0.5);
    for (const unit of ['bar', 'beat', 'unit']) for (const t of [0, 0.1, 0.3, 0.49]) {
      expect(early.snapTime(t, unit, {mode: 'floor'})).toBeLessThanOrEqual(t + 1e-9);
      expect(early.snapTime(t, unit, {mode: 'ceil'})).toBeGreaterThanOrEqual(t - 1e-9);
    }
  });
  test('past the end there is nothing to ceil to, so t stays; floor and nearest give the end', () => {
    expect(map.snapTime(15, 'bar', {mode: 'ceil'})).toBe(15);
    expect(map.snapTime(15, 'bar', {mode: 'floor'})).toBe(14);
    expect(map.snapTime(15, 'beat')).toBe(14);
  });
  test('the end of the song is a snap point; an unknown unit throws', () => {
    expect(map.snapTime(13.95, 'bar')).toBe(14);
    expect(() => map.snapTime(1, 'tenth')).toThrow(TypeError);
  });
});

describe('fromTaps (D22)', () => {
  let seed = 11;
  const noise = () => ((seed = seed * 16807 % 2147483647) / 2147483647 - 0.5);
  test('jittered taps at 92 bpm fit 92 ± 0.2 with two pins', () => {
    const period = 60 / 92, taps = Array.from({length: 16}, (_, k) => 2.1 + k * period + noise() * 0.04);
    const data = fromTaps(taps, 60);
    validateSongMap(data);
    expect(data.pins).toHaveLength(2);
    expect(data.origin).toBe('tapped');
    expect(Math.abs(data.tailQpm - 92)).toBeLessThan(0.2);
    const c = compile(data);
    expect(Math.abs(60 * 15 / (timeAt(c, 15) - timeAt(c, 0)) - 92)).toBeLessThan(0.2);
    expect(data.pins[0].time).toBeCloseTo(2.1, 1);
    expect(data.measures[0]).toMatchObject({numerator: 4, denominator: 4, length: fraction(4), label: ''});
    expect(new SongMapStore(data, 60).bars[0]).toMatchObject({pickup: false, display: 1});
  });
  test('an outlier tap is dropped once, then the fit is redone', () => {
    const taps = Array.from({length: 12}, (_, k) => 1 + k * 0.5);
    taps[6] += 0.3;
    const data = fromTaps(taps, 30);
    expect(data.tailQpm).toBeCloseTo(120, 6);
    expect(data.pins.map((p) => p.time)).toEqual([expect.closeTo(1, 6), expect.closeTo(6.5, 6)]);
  });
  test('numerator, too few taps and impossible tempos', () => {
    expect(fromTaps([0.5, 1, 1.5, 2, 2.5, 3], 20, {numerator: 3}).measures[0]).toMatchObject({numerator: 3, length: fraction(3)});
    expect(() => fromTaps([1, 2, 3], 20)).toThrow(/at least 4/);
    expect(() => fromTaps([1, 1.0005, 2, 3], 20)).toThrow(/at least 4/);
    expect(() => fromTaps([0, 0.01, 0.02, 0.03, 0.04], 20)).toThrow(/between 10 and 1000/);
    expect(() => fromTaps([1, 2, 3, 4], 20, {numerator: 0})).toThrow();
  });
  test('Tap the beat [Use it] replaces the map as a tapped edit', () => {
    const map = mapStore(unmapped);
    map.replace(fromTaps([1, 1.5, 2, 2.5, 3], 30), 'tapBeat');
    expect(map.isReal).toBe(true);
    expect(map.data.origin).toBe('tapped');
    expect(map.bars[0].t0).toBeCloseTo(1);
  });
});

describe('sectionsFromMarkers (§4.5)', () => {
  test('each marker labels the nearest bar start; collisions keep the first; bar 0 is relabelled', () => {
    const map = mapStore(sectioned);
    const markers = [
      {id: 'm2', t: 32.9, label: 'Solo'},
      {id: 'm1', t: 0.4, label: 'Count-off'},
      {id: 'm3', t: 32.6, label: 'Solo again'},
      {id: 'm4', t: 59.2, label: ''},
      {id: 'm5', t: 70, label: 'Gone', deleted: true},
    ];
    const {change, converted, skipped} = sectionsFromMarkers(map.data, markers, map.duration);
    expect(converted).toEqual(['m1', 'm3', 'm4']);
    expect(skipped).toEqual(['m2']);
    map.edit(change, 'sections');
    expect(map.data.measures[0].label).toBe('Count-off');
    expect(map.data.measures[16].label).toBe('Solo again');
    expect(map.data.measures[30].label).toBe('Section 3');
    expect(map.sections.map((s) => s.name)).toContain('Count-off');
  });
  test('on an unmapped placeholder turning real, markers become the only sections', () => {
    const map = mapStore(unmapped);
    const {change} = sectionsFromMarkers(map.data, [{id: 'a', t: 8.1, label: 'Verse'}, {id: 'b', t: 16.2, label: 'Chorus'}], map.duration);
    map.edit(change, 'sections');
    expect(map.sections.map((s) => [s.name, s.startBar])).toEqual([['Start', 0], ['Verse', 4], ['Chorus', 8]]);
  });
});

describe('applySuggestion (D47)', () => {
  test('labels the bar nearest each block and skips bars that already have a label', () => {
    const map = labelled({8: 'Chorus'}, {duration: 60});
    const suggestion = {sections: [{t0: 0.2, label: 'Intro', confidence: 0.8}, {t0: 15.9, label: 'Hook', confidence: 0.6}, {t0: 31.7, label: 'Verse', confidence: 0.7}, {t0: 32.4, label: 'Verse again'}, {t0: 40, label: ''}]};
    const {change, added} = applySuggestion(map.data, suggestion, map.duration);
    expect(added).toBe(3);
    map.edit(change, 'sections');
    expect(map.sections.map((s) => [s.name, s.startBar])).toEqual([['Intro', 0], ['Chorus', 8], ['Verse', 16], ['Section 3', 20]]);
  });
  test('accepts a plain block list and ignores garbage', () => {
    const map = mapStore(unmapped);
    expect(applySuggestion(map.data, [{t0: 4, label: 'A'}, {t0: NaN}], map.duration).added).toBe(1);
    expect(applySuggestion(map.data, null, map.duration).added).toBe(0);
  });
  test("the auto 'Pickup' label on measure 0 is not a label to protect", () => {
    const map = labelled({0: 'Pickup'}, {pickupLength: 2});
    const {change, added} = applySuggestion(map.data, [{t0: 0, label: 'Intro'}], map.duration);
    expect(added).toBe(1);
    map.edit(change, 'sections');
    expect(map.sections[0].name).toBe('Intro');
  });
});

describe('performance', () => {
  test('bars, sections and bar starts are built once per data change', () => {
    const map = mapStore(sectioned);
    const bars = map.bars, sections = map.sections;
    for (let i = 0; i < 1000; i++) map.barBeatAt(i * 0.128);
    expect(map.bars).toBe(bars);
    expect(map.sections).toBe(sections);
    map.edit((d) => { d.measures[9].label = 'Fill'; }, 'label');
    expect(map.bars).not.toBe(bars);
    expect(map.sections.map((s) => s.name)).toContain('Fill');
  });
});
