// Shared song-map fixtures (architecture §11.3, package F5). Every fixture is
// `{name, duration, tempo}`: `tempo` is the stored `songs.tempo` shape, deep
// frozen, with fixed measure ids so tests can compare bars and refs exactly.
// `mapStore(fixture)` builds a real SongMapStore through the one-way upgrade.
import {SongMapStore} from '../../src/js/song-map.js';

const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const frac = (n, d = 1) => ({n, d});
const bar = (id, numerator = 4, denominator = 4, {length, label = '', grouping} = {}) =>
  ({id, numerator, denominator, length: length ?? frac(4 * numerator, denominator), label, ...(grouping ? {grouping} : {})});
const bars = (count, prefix, make = (id) => bar(id)) => Array.from({length: count}, (_, i) => make(`${prefix}${i}`, i));

/**
 * A two-beat pickup in 4/4 at 120 bpm: the pickup starts at 0.5 s, bar 1's
 * downbeat is at 1.5 s and every full bar lasts 2 s (11 measures in 20 s).
 */
export const pickup = freeze({
  name: 'pickup', duration: 20,
  tempo: {songMap: {version: 1, origin: 'edited', tailQpm: 120, pins: [{position: frac(0), time: 0.5}],
    measures: bars(11, 'p', (id, i) => bar(id, 4, 4, i === 0 ? {length: frac(2)} : {}))}},
});

/** 7/8 grouped 2+2+3 at 120 quarters per minute: 1.75 s per bar, 8 bars in 14 s. */
export const sevenEight = freeze({
  name: 'seven-eight', duration: 14,
  tempo: {songMap: {version: 1, origin: 'edited', tailQpm: 120, pins: [{position: frac(0), time: 0}],
    measures: bars(8, 's', (id) => bar(id, 7, 8, {grouping: [2, 2, 3]}))}},
});

/** The rehearsal song's eight sections (Appendix A), eight bars each. */
export const REHEARSAL_SECTIONS = freeze(['Intro', 'Verse', 'Chorus', 'Verse 2', 'Chorus 2', 'Bridge', 'Chorus 3', 'Outro']);

/** `glasshouse`: 64 bars of 4/4 at 120 bpm (2 s per bar, 128 s), mapped (origin `edited`), with the eight rehearsal sections. */
export const sectioned = freeze({
  name: 'sectioned', duration: 128,
  tempo: {songMap: {version: 1, origin: 'edited', tailQpm: 120, pins: [{position: frac(0), time: 0}],
    measures: bars(64, 'g', (id, i) => bar(id, 4, 4, {label: i % 8 === 0 ? REHEARSAL_SECTIONS[i / 8] : ''}))}},
});

/** The placeholder every 1.6–1.9 save wrote for a song nobody mapped: one pin at 0:00, 120 bpm, plain 4/4, no origin. */
export const unmapped = freeze({
  name: 'unmapped', duration: 30,
  tempo: {songMap: {version: 1, tailQpm: 120, pins: [{position: frac(0), time: 0}], measures: bars(15, 'u')},
    source: 'detected', detected: [{time: 0, downbeat: true}, {time: 0.5, downbeat: false}], map: []},
});

/**
 * A map saved by 1.6–1.9 (no `origin`): two pins (bar 1 at 1.0 s, bar 5 at
 * 9.0 s, so 120 bpm), plus the legacy dual-write noise that sat beside it.
 */
export const legacySongMap = freeze({
  name: 'legacy-song-map', duration: 30,
  tempo: {songMap: {version: 1, pins: [{position: frac(0), time: 1}, {position: frac(16), time: 9}], measures: bars(15, 'l')},
    source: 'detected', detected: [{time: 1, downbeat: true}, {time: 1.5, downbeat: false}], map: []},
});

/** A pre-1.6 manual tempo map: one section, 97 bpm in 3/4 from 0.5 s. */
export const legacyTempoMap = freeze({
  name: 'legacy-tempo-map', duration: 30,
  tempo: {map: [{t: 0.5, bpm: 97, beatsPerBar: 3, unit: 4}], countIn: false},
});

/** A pre-1.6 detected beat list: 0.6 s beats from 0.3 s, a downbeat every 4 (100 bpm), 40 beats. */
export const legacyDetected = freeze({
  name: 'legacy-detected', duration: 25,
  tempo: {source: 'detected', map: [], detected: Array.from({length: 40}, (_, i) => ({time: Math.round((0.3 + i * 0.6) * 1000) / 1000, downbeat: i % 4 === 0}))},
});

export const MAP_FIXTURES = freeze([pickup, sevenEight, sectioned, unmapped, legacySongMap, legacyTempoMap, legacyDetected]);

/** A real SongMapStore for a fixture (through `SongMapStore.fromTempo`, so legacy fixtures are upgraded). */
export function mapStore(fixture, {duration = fixture.duration} = {}) {
  return SongMapStore.fromTempo(structuredClone(fixture.tempo), duration);
}

/** A fresh, mutable copy of a fixture's stored tempo. */
export const tempoOf = (fixture) => structuredClone(fixture.tempo);
