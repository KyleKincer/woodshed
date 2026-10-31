// @vitest-environment node
// src/export/song-files.js: the shared timeline (lead-in bars + audio padding), WAV, the tempo-map and drum MIDI
// files (round-tripped through Woodshed's own MIDI importer), Guitar Pro through alphaTab, and the README.
import {describe, expect, test} from 'vitest';
import * as at from '@coderline/alphatab';
import {KIT, fraction, number} from '../shared/notation.ts';
import {compile, defaultSongMap, fromTimeline, measureStarts, normalize, timeAt} from '../shared/song-map.ts';
import {parseMidiTempo} from '../src/js/tempo-import.js';
import {
  PPQ, alignment, drumChartMidi, drumStrokes, guitarProFile, mapSeconds, mixdown, readme, tempoMapMidi, tooSlowBar, wavChunks, wavHeader,
} from '../src/export/song-files.js';
import {demoScore} from './fixtures/drum-score.js';

const concat = chunks => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

const measure = (id, numerator = 4, denominator = 4, length = fraction(4 * numerator, denominator), label = '') => ({id, numerator, denominator, length, label});

/** Every bar of `map` starts, in the exported MIDI, `pad` seconds later than in the recording (within 1 ms). */
function expectAligned(map, bytes, duration = 60) {
  const align = alignment(map, duration);
  const parsed = parseMidiTempo(bytes, {duration: duration + 20}).map;
  const original = compile(map), back = compile(parsed);
  const starts = measureStarts(map.measures).map(number), backStarts = measureStarts(parsed.measures).map(number);
  expect(backStarts.length).toBeGreaterThanOrEqual(starts.length + align.leadBars);
  starts.forEach((q, i) => {
    const want = timeAt(original, q) + align.padSeconds;
    expect(Math.abs(timeAt(back, backStarts[i + align.leadBars]) - want), `bar ${i + 1}`).toBeLessThan(0.001);
  });
  return {align, parsed};
}

describe('alignment', () => {
  test('bar 1 at 0 s needs no lead-in and no padding', () => {
    expect(alignment(defaultSongMap(20, 120), 20)).toMatchObject({leadBars: 0, padSeconds: 0, qpm: 120, numerator: 4, denominator: 4});
  });

  test('a late bar 1 gets whole count-in bars and pads the audio up to them', () => {
    expect(alignment(defaultSongMap(20, 120, 4, 4, 0.7), 20)).toMatchObject({leadBars: 1, leadSeconds: 2});
    expect(alignment(defaultSongMap(20, 120, 4, 4, 0.7), 20).padSeconds).toBeCloseTo(1.3, 9);
    const long = alignment(defaultSongMap(30, 120, 4, 4, 5.2), 30);
    expect(long.leadBars).toBe(3);
    expect(long.padSeconds).toBeCloseTo(0.8, 9);
    expect(alignment(defaultSongMap(20, 120, 4, 4, 4), 20)).toMatchObject({leadBars: 2, padSeconds: 0});
  });

  test('a bar 1 before the audio starts gets one count-in bar and more padding', () => {
    const map = normalize({version: 1, measures: [measure('a')], pins: [{position: fraction(0), time: -0.3}, {position: fraction(8), time: 3.7}]}, 20);
    const a = alignment(map, 20);
    expect(a.leadBars).toBe(1);
    expect(a.padSeconds).toBeCloseTo(2.3, 9);
  });
});

describe('WAV', () => {
  test('a 16-bit PCM header', () => {
    const h = new DataView(wavHeader(10, 2, 48000).buffer);
    expect(String.fromCharCode(...new Uint8Array(h.buffer, 0, 4))).toBe('RIFF');
    expect(h.getUint32(4, true)).toBe(36 + 40);
    expect(h.getUint16(20, true)).toBe(1);
    expect(h.getUint16(22, true)).toBe(2);
    expect(h.getUint32(24, true)).toBe(48000);
    expect(h.getUint32(28, true)).toBe(48000 * 4);
    expect(h.getUint16(34, true)).toBe(16);
    expect(h.getUint32(40, true)).toBe(40);
  });

  test('pads with silence, interleaves, clips and chunks', () => {
    const left = new Float32Array([0.5, -1, 2]), right = new Float32Array([-0.5, 1, -2]);
    const bytes = concat([...wavChunks([left, right], 44100, {padFrames: 2, chunkFrames: 2})]);
    expect(bytes.length).toBe(44 + 5 * 4);
    const pcm = new Int16Array(bytes.buffer.slice(44));
    expect([...pcm]).toEqual([0, 0, 0, 0, Math.round(0.5 * 0x7fff), Math.round(-0.5 * 0x8000), -0x8000, 0x7fff, 0x7fff, -0x8000]);
  });

  test('mixdown sums stems (mono into both sides) and keeps the peak under full scale', () => {
    const out = mixdown([[new Float32Array([0.25, 0.9])], [new Float32Array([0.25, 0.9]), new Float32Array([0, 0.1])]]);
    expect(out).toHaveLength(2);
    expect(out[0][0]).toBeCloseTo(0.5 * (0.999 / 1.8), 6);
    expect(Math.max(...out[0].map(Math.abs))).toBeLessThanOrEqual(0.999 + 1e-6);
    expect(out[1][0]).toBeCloseTo(0.25 * (0.999 / 1.8), 6);
  });
});

describe('tempo map MIDI', () => {
  test('steady tempo with a late bar 1: one count-in bar, then every bar lands where the recording has it', () => {
    const map = defaultSongMap(30, 96, 4, 4, 0.85);
    const {align, parsed} = expectAligned(map, tempoMapMidi(map, 30, {title: 'Glasshouse'}), 30);
    expect(align.leadBars).toBe(1);
    expect(parsed.measures[0]).toMatchObject({numerator: 4, denominator: 4});
  });

  test('a ramp, a meter change and section markers', () => {
    const measures = [
      ...Array.from({length: 4}, (_, i) => measure(`a${i}`, 4, 4, undefined, i === 0 ? 'Intro' : '')),
      measure('b0', 7, 8, undefined, 'Verse'), measure('b1', 7, 8),
      ...Array.from({length: 6}, (_, i) => measure(`c${i}`, 4, 4, undefined, i === 0 ? 'Chorus' : '')),
    ];
    // 120 BPM for 16 quarters from 1.0 s, then a ramp across the 7/8 bars, then steady.
    const map = normalize({version: 1, measures, pins: [
      {position: fraction(0), time: 1.0}, {position: fraction(16), time: 9.0, ramp: true},
      {position: fraction(23), time: 12.0}, {position: fraction(39), time: 19.0},
    ]}, 40);
    const bytes = tempoMapMidi(map, 40, {title: 'Ramp'});
    const {parsed} = expectAligned(map, bytes, 40);
    expect(parsed.measures.some(m => m.numerator === 7 && m.denominator === 8)).toBe(true);
    const text = new TextDecoder('latin1').decode(bytes);
    for (const label of ['Count-in', 'Intro', 'Verse', 'Chorus', 'Ramp']) expect(text).toContain(label);
  });

  test('a pickup bar is stated as its own short meter', () => {
    const measures = [measure('p', 4, 4, fraction(1)), ...Array.from({length: 6}, (_, i) => measure(`m${i}`))];
    const map = normalize({version: 1, measures, pins: [{position: fraction(0), time: 0.5}, {position: fraction(25), time: 13}]}, 14);
    const {parsed, align} = expectAligned(map, tempoMapMidi(map, 14), 14);
    expect(parsed.measures[align.leadBars]).toMatchObject({numerator: 1, denominator: 4});
  });

  test('a quarter note longer than MIDI can state (16.8 s): tooSlowBar names the bar the drift starts in', () => {
    // Bar 9 (measure 8) is pinned across an 80 s break, so one quarter note lasts 20 s.
    const measures = Array.from({length: 14}, (_, i) => measure(`m${i}`));
    const map = normalize({version: 1, measures, pins: [
      {position: fraction(0), time: 0}, {position: fraction(32), time: 16}, {position: fraction(36), time: 96}, {position: fraction(52), time: 104},
    ]}, 104);
    expect(tooSlowBar(map, 104)).toBe(8);
    expect(tooSlowBar(defaultSongMap(30, 96, 4, 4, 0.85), 30)).toBeNull();
  });

  test('mapSeconds is where the last bar ends', () => {
    expect(mapSeconds(defaultSongMap(16, 120))).toBeCloseTo(16, 9);
    expect(mapSeconds(defaultSongMap(15, 120, 4, 4, 0.7))).toBeCloseTo(16.7, 9);
  });
});

describe('drum chart MIDI', () => {
  test('every written hit lands on its General MIDI note at its place on the shared timeline', () => {
    const score = demoScore(32, 120);
    const map = fromTimeline(score.timeline, 32);
    const bytes = drumChartMidi(score, map, 32, {title: 'Demo'});
    const parsed = parseMidiTempo(bytes, {duration: 60});
    const align = alignment(map, 32);
    const starts = new Map(map.measures.map((m, i) => [m.id, number(measureStarts(map.measures)[i])]));
    const got = new Set(parsed.drums.hits.map(h => `${Math.round(h.q * PPQ)}:${h.midi}`));
    let plain = 0;
    for (const bar of score.bars) for (const hit of bar.hits) {
      const q = align.leadBars * align.leadQuarters + starts.get(bar.measureId) + number(hit.offset);
      const midi = KIT.find(k => k.id === hit.instrument).midi;
      expect(got.has(`${Math.round(q * PPQ)}:${midi}`), `${hit.instrument} at ${q}`).toBe(true);
      plain++;
    }
    expect(parsed.drums.hits.length).toBeGreaterThanOrEqual(plain);
    expect(expectAligned(map, bytes, 32).align).toEqual(align);
  });

  test('accents, ghosts, flams and rolls', () => {
    const map = defaultSongMap(8, 120);
    const id = map.measures[0].id;
    const h = (offset, instrument, extra = {}) => ({id: `${instrument}${offset}`, offset: fraction(offset), instrument, voice: 1, accent: false, ghost: false, flam: false, sticking: '', velocity: 0.7, ...extra});
    const score = {version: 2, title: '', timeline: {version: 1, measures: map.measures, anchors: []}, bars: [{measureId: id, coverage: 'progress', hits: [
      h(0, 'snare', {accent: true}), h(1, 'snare', {ghost: true}), h(2, 'snare', {flam: true}), h(3, 'snare', {roll: 2}),
    ]}]};
    const hits = parseMidiTempo(drumChartMidi(score, map, 8), {duration: 20}).drums.hits.filter(x => x.midi === 38);
    const at = q => hits.filter(x => Math.abs(x.q - q) < 1e-6);
    expect(at(0)[0].velocity).toBeGreaterThan(0.9);
    expect(at(1)[0].velocity).toBeLessThanOrEqual(0.35);
    expect(at(2 - 1 / 16)).toHaveLength(1);                       // the flam's grace
    expect(hits.filter(x => x.q >= 3 && x.q < 4)).toHaveLength(4); // a 16th roll across the beat
  });

  test('a drag on the first beat with no count-in drops the graces that would fall before 0', () => {
    const map = defaultSongMap(8, 120);
    const id = map.measures[0].id;
    const h = (offset, instrument, extra = {}) => ({id: `${instrument}${offset}`, offset: fraction(offset), instrument, voice: 1, accent: false, ghost: false, flam: false, sticking: '', velocity: 0.7, ...extra});
    const score = {version: 2, title: '', timeline: {version: 1, measures: map.measures, anchors: []}, bars: [{measureId: id, coverage: 'progress', hits: [
      h(0, 'snare', {drag: true}), h(2, 'snare', {drag: true}),
    ]}]};
    const strokes = drumStrokes(score, map, q => q * PPQ, measureStarts(map.measures).map(number));
    expect(strokes.map(x => x.tick)).toEqual([0, 2 * PPQ - PPQ / 8, 2 * PPQ - PPQ / 16, 2 * PPQ]);
    const hits = parseMidiTempo(drumChartMidi(score, map, 8), {duration: 20}).drums.hits.filter(x => x.midi === 38);
    expect(hits.filter(x => Math.abs(x.q) < 1e-6)).toHaveLength(1);
  });
});

describe('Guitar Pro', () => {
  test('a .gp file alphaTab reads back with every hit on its kit piece', () => {
    const score = demoScore(16, 120);
    const bytes = guitarProFile(at, score, {title: 'Demo', artist: 'Band'});
    const back = at.importer.ScoreLoader.loadScoreFromBytes(bytes, new at.Settings());
    expect(back.title).toBe('Demo');
    expect(back.artist).toBe('Band');
    expect(back.tracks[0].staves[0].isPercussion).toBe(true);
    const ids = [];
    for (const bar of back.tracks[0].staves[0].bars) for (const v of bar.voices) for (const b of v.beats) if (!b.graceType) for (const n of b.notes) ids.push(n.percussionArticulation);
    const want = score.bars.flatMap(b => b.hits.map(hit => KIT.find(k => k.id === hit.instrument).gp));
    expect(ids.sort()).toEqual(want.sort());
  });
});

describe('README', () => {
  test('names the files and states the shared timeline', () => {
    const align = alignment(defaultSongMap(20, 120, 4, 4, 0.7), 20);
    const text = readme({title: 'Glasshouse', artist: 'Northbound', date: '2026-10-30', sampleRate: 48000, stems: ['drums', 'bass'],
      backing: 'Backing track (no drums).wav', tempoMap: true, drumMidi: true, guitarPro: true, align});
    expect(text).toContain('Northbound – Glasshouse');
    expect(text).toContain('2 stems (drums, bass), 16-bit WAV at 48000 Hz');
    expect(text).toContain('1 count-in bar of 4/4 at 120 BPM, so the song\'s bar 1 is bar 2 in your DAW. The WAV files start with 1.300 s of silence');
    expect(text).toContain('Drum chart.gp');
    expect(readme({title: 'X', stems: ['drums'], tempoMap: true, align: alignment(defaultSongMap(8, 120), 8)})).toContain('bar 1 starts at 0:00');
  });

  test('counts a pickup as a DAW bar of its own', () => {
    const facts = {title: 'X', stems: ['drums'], tempoMap: true, pickup: true, align: alignment(defaultSongMap(20, 120, 4, 4, 0.7), 20)};
    expect(readme(facts)).toContain('1 count-in bar of 4/4 at 120 BPM, then the pickup, so the song\'s bar 1 is bar 3 in your DAW.');
    expect(readme({...facts, original: true})).toContain('1 count-in bar, then the pickup, so the song\'s bar 1 is bar 3.');
    expect(readme({...facts, align: alignment(defaultSongMap(8, 120), 8)})).toContain('the pickup starts at 0:00, so the song\'s bar 1 is bar 2 in your DAW.');
  });

  test('Original files: the backing track is named among the files that are not padded', () => {
    const text = readme({title: 'X', stems: ['bass'], backing: 'Backing track (no drums).wav', original: true, tempoMap: true,
      align: alignment(defaultSongMap(20, 120, 4, 4, 0.7), 20)});
    expect(text).toContain('The original stems and the backing track are not padded: place them 1.300 s after the start of the session.');
  });

  test('names the bar where a tempo too slow for MIDI makes the MIDI files drift', () => {
    const facts = {title: 'X', tempoMap: true, align: alignment(defaultSongMap(20, 120, 4, 4, 0.7), 20)};
    expect(readme({...facts, slowBar: 8})).toContain('The song\'s bar 9 is too slow for a MIDI file (a quarter note there lasts more than 16.8 s). From there on, the MIDI files drift ahead of the audio.');
    expect(readme({...facts, slowBar: 8, pickup: true})).toContain('The song\'s bar 8 is too slow');
    expect(readme({...facts, slowBar: 0, pickup: true})).toContain('The pickup is too slow');
    expect(readme({...facts, slowBar: null})).not.toContain('too slow');
  });
});
