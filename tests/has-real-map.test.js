// The real-map rule (spec §1.1, architecture §4.1, D21) and the one-way upgrade
// that stamps an origin on maps saved before 2.0.
import {describe, expect, test} from 'vitest';
import {fraction} from '../shared/notation.ts';
import {hasRealMap, cleanSongMap, defaultSongMap, songMapFromTempo, mapSummaryOf, validateSongMap, ORIGINS, isMadeLegacyMap} from '../shared/song-map.ts';
import {SongMapStore} from '../src/js/song-map.js';
import {MAP_FIXTURES, pickup, sevenEight, sectioned, unmapped, legacySongMap, legacyTempoMap, legacyDetected, mapStore, tempoOf, REHEARSAL_SECTIONS} from './fixtures/maps.js';

const placeholder = (extra = {}) => ({...defaultSongMap(20), ...extra});
const withMeasure = (data, i, patch) => { const next = structuredClone(data); Object.assign(next.measures[i], patch); return next; };

describe('rule 1: a stored origin', () => {
  test.each(ORIGINS)('origin %s is real', (origin) => {
    expect(hasRealMap({songMap: placeholder({origin})})).toBe(true);
  });
  test('an unknown origin is dropped by cleanSongMap, so a placeholder with it is not real', () => {
    expect(hasRealMap({songMap: placeholder({origin: 'guessed'})})).toBe(false);
    expect(cleanSongMap(placeholder({origin: 'guessed'}))).not.toHaveProperty('origin');
  });
});

describe('rule 2: a drum part', () => {
  test('hasPart makes any map real, even no tempo at all', () => {
    expect(hasRealMap(undefined, {hasPart: true})).toBe(true);
    expect(hasRealMap(tempoOf(unmapped), {hasPart: true})).toBe(true);
    expect(hasRealMap(tempoOf(unmapped))).toBe(false);
  });
});

describe('rule 3: a 1.6–1.9 map without origin', () => {
  test('the placeholder is not real', () => {
    expect(hasRealMap({songMap: placeholder()})).toBe(false);
    expect(hasRealMap(tempoOf(unmapped))).toBe(false);
  });
  test('more than one pin', () => {
    expect(hasRealMap(tempoOf(legacySongMap))).toBe(true);
    const two = placeholder(); two.pins.push({position: fraction(8), time: 4});
    expect(hasRealMap({songMap: two})).toBe(true);
  });
  test('any section label, except the auto Pickup label on measure 0', () => {
    expect(hasRealMap({songMap: withMeasure(placeholder(), 3, {label: 'Chorus'})})).toBe(true);
    expect(hasRealMap({songMap: withMeasure(placeholder(), 0, {label: 'Intro'})})).toBe(true);
    expect(hasRealMap({songMap: withMeasure(placeholder(), 0, {label: 'Pickup'})})).toBe(false);
    expect(hasRealMap({songMap: withMeasure(placeholder(), 2, {label: 'Pickup'})})).toBe(true);
    expect(hasRealMap({songMap: withMeasure(placeholder(), 2, {label: '   '})})).toBe(false);
  });
  test('addition: one pin that is not the placeholder (time, tail tempo or meter)', () => {
    expect(hasRealMap({songMap: placeholder({pins: [{position: fraction(0), time: 0.35}]})})).toBe(true);
    expect(hasRealMap({songMap: placeholder({tailQpm: 97})})).toBe(true);
    expect(hasRealMap({songMap: placeholder({tailQpm: 120})})).toBe(false);
    const {tailQpm, ...noTail} = placeholder();
    expect(hasRealMap({songMap: noTail})).toBe(false);
    expect(hasRealMap({songMap: withMeasure(placeholder(), 4, {numerator: 3, length: fraction(3)})})).toBe(true);
    expect(hasRealMap({songMap: withMeasure(placeholder(), 4, {grouping: [2, 2]})})).toBe(true);
    expect(hasRealMap({songMap: withMeasure(placeholder(), 4, {grouping: [1, 1, 1, 1]})})).toBe(false);
  });
  test("source: 'detected' is ignored whenever a valid songMap exists", () => {
    const noisy = {songMap: placeholder(), source: 'detected', detected: Array.from({length: 30}, (_, i) => ({time: i / 2, downbeat: i % 4 === 0})), map: [{t: 0, bpm: 97, beatsPerBar: 3, unit: 4}]};
    expect(hasRealMap(noisy)).toBe(false);
  });
});

describe('rule 4: no valid songMap', () => {
  test("source: 'detected' with at least two beats", () => {
    expect(hasRealMap(tempoOf(legacyDetected))).toBe(true);
    expect(hasRealMap({source: 'detected', detected: [{time: 1, downbeat: true}]})).toBe(false);
    expect(hasRealMap({source: 'map', detected: [{time: 1, downbeat: true}, {time: 2, downbeat: false}]})).toBe(false);
  });
  test('addition: a non-empty legacy tempo.map', () => {
    expect(hasRealMap(tempoOf(legacyTempoMap))).toBe(true);
    expect(hasRealMap({map: []})).toBe(false);
  });
  test('an invalid stored songMap falls through to the legacy fields', () => {
    const broken = {songMap: {version: 1, measures: [], pins: []}};
    expect(hasRealMap(broken)).toBe(false);
    expect(hasRealMap({...broken, ...tempoOf(legacyTempoMap)})).toBe(true);
  });
  test('nothing at all, and garbage, are not real', () => {
    for (const tempo of [undefined, null, {}, 'x', 7, [], {songMap: 'map'}]) expect(hasRealMap(tempo)).toBe(false);
  });
});

describe('the one-way upgrade', () => {
  test('every fixture loads with isReal equal to hasRealMap', () => {
    for (const fixture of MAP_FIXTURES) expect(mapStore(fixture).isReal, fixture.name).toBe(hasRealMap(fixture.tempo));
  });
  test('origins: rule 3 → edited, legacy detected → detected, legacy map → edited, placeholder → none', () => {
    expect(songMapFromTempo(tempoOf(legacySongMap), 30).origin).toBe('edited');
    expect(songMapFromTempo(tempoOf(legacyDetected), 25).origin).toBe('detected');
    expect(songMapFromTempo(tempoOf(legacyTempoMap), 30).origin).toBe('edited');
    expect(songMapFromTempo(tempoOf(unmapped), 30)).not.toHaveProperty('origin');
    expect(songMapFromTempo(undefined, 30)).not.toHaveProperty('origin');
    expect(songMapFromTempo(tempoOf(sectioned), 128).origin).toBe('edited');
  });
  test('translations keep the legacy timing', () => {
    const detected = mapStore(legacyDetected);
    expect(detected.beats.slice(0, 5).map((b) => b.time)).toEqual([0.3, 0.9, 1.5, 2.1, 2.7]);
    const manual = mapStore(legacyTempoMap);
    expect(manual.bars[0].t0).toBeCloseTo(0.5);
    expect(manual.bars[0].numerator).toBe(3);
    expect(manual.bars[1].bpm).toBeCloseTo(97, 6);
  });
  test('the upgraded map is what the next save writes, and a reload reads it as real without the heuristic', () => {
    const store = mapStore(legacySongMap), saved = store.serialize();
    expect(saved.origin).toBe('edited');
    expect(hasRealMap({songMap: saved})).toBe(true);
    expect(isMadeLegacyMap(saved)).toBe(true);
  });
  test('an unreadable legacy map loads the placeholder', () => {
    const store = SongMapStore.fromTempo({source: 'detected', detected: [{time: 'x'}, {time: -4}]}, 20);
    expect(store.isReal).toBe(false);
    expect(store.pins).toHaveLength(1);
  });
});

describe('rule 4 agrees with the upgrade', () => {
  const agree = (tempo, duration) => {
    const real = hasRealMap(tempo), store = SongMapStore.fromTempo(structuredClone(tempo), duration);
    expect(store.isReal).toBe(real);
    expect(mapSummaryOf(tempo, duration).real).toBe(real);
    return {real, store, summary: mapSummaryOf(tempo, duration)};
  };
  test('legacy beats and sections past the duration still translate (and stay real)', () => {
    const late = agree({source: 'detected', detected: [{time: 50, downbeat: true}, {time: 50.5}, {time: 51}, {time: 51.5}]}, 40);
    expect(late.real).toBe(true);
    expect(late.store.data.origin).toBe('detected');
    const map = agree({map: [{t: 100, bpm: 97, beatsPerBar: 3, unit: 4}]}, 40);
    expect(map.real).toBe(true);
    expect(map.store.data.origin).toBe('edited');
  });
  test('the server with no duration summarises a legacy map from its own timing', () => {
    const {summary} = agree(tempoOf(legacyTempoMap), 0);
    expect(summary).toMatchObject({real: true, bpm: 97, meter: '3/4'});
  });
  test('legacy fields the upgrade cannot read are not real anywhere', () => {
    for (const tempo of [
      {source: 'detected', detected: [{time: NaN}, {time: 'x'}]},
      {source: 'detected', detected: [{time: 2}, {time: 2.0001}]},
      {map: [{t: -1, bpm: 97}, {t: 'x'}]},
    ]) expect(agree(tempo, 40).real).toBe(false);
  });
  test('an unusable detected list falls through to the legacy map', () => {
    const {real, store} = agree({source: 'detected', detected: [{time: NaN}, {time: -3}], map: [{t: 0.5, bpm: 97, beatsPerBar: 3, unit: 4}]}, 30);
    expect(real).toBe(true);
    expect(store.data.origin).toBe('edited');
    expect(store.bars[0].numerator).toBe(3);
  });
});

describe('in a session', () => {
  test('undo back to a no-origin map is not real', () => {
    const store = mapStore(unmapped);
    expect(store.isReal).toBe(false);
    store.edit((d) => { d.pins[0].time = 0.4; }, 'pin');
    expect(store.isReal).toBe(true);
    expect(store.data.origin).toBe('edited');
    store.undo();
    expect(store.isReal).toBe(false);
    expect(store.data).not.toHaveProperty('origin');
    store.redo();
    expect(store.isReal).toBe(true);
  });
  test('a drum part makes the session map real without touching the data', () => {
    const store = mapStore(unmapped), before = store.serialize();
    store.setHasPart(true);
    expect(store.isReal).toBe(true);
    expect(store.serialize()).toEqual(before);
    store.setHasPart(false);
    expect(store.isReal).toBe(false);
  });
  test('the shared snapshot round-trip keeps the origin through cleanSongMap', () => {
    for (const fixture of [pickup, sevenEight, sectioned]) {
      const shared = {songMap: cleanSongMap(JSON.parse(JSON.stringify(mapStore(fixture).serialize())))};
      expect(shared.songMap.origin).toBe('edited');
      expect(() => validateSongMap(shared.songMap)).not.toThrow();
      expect(SongMapStore.fromTempo(shared, fixture.duration).isReal).toBe(true);
      expect(hasRealMap(shared)).toBe(true);
    }
  });
});

describe('mapSummaryOf (B1 list rows)', () => {
  test('a mapped song: real, bpm, meter and section names', () => {
    expect(mapSummaryOf(tempoOf(sectioned), 128)).toEqual({real: true, bpm: 120, meter: '4/4', sections: [...REHEARSAL_SECTIONS]});
    expect(mapSummaryOf(tempoOf(legacyTempoMap), 30)).toEqual({real: true, bpm: 97, meter: '3/4', sections: []});
    expect(mapSummaryOf(tempoOf(sevenEight), 14)).toMatchObject({real: true, meter: '7/8'});
  });
  test('an unmapped song has no bars to summarise', () => {
    expect(mapSummaryOf(tempoOf(unmapped), 30)).toEqual({real: false, sections: []});
    expect(mapSummaryOf(undefined, 30)).toEqual({real: false, sections: []});
    expect(mapSummaryOf(undefined, 30, {hasPart: true})).toMatchObject({real: true, bpm: 120, meter: '4/4'});
  });
  test('at most 64 section names, duplicates numbered', () => {
    const data = defaultSongMap(400);
    data.origin = 'edited';
    data.measures.forEach((m) => { m.label = 'Riff'; });
    const {sections} = mapSummaryOf({songMap: data}, 400);
    expect(sections).toHaveLength(64);
    expect(sections.slice(0, 3)).toEqual(['Riff', 'Riff 2', 'Riff 3']);
  });
});
