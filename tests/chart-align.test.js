// @vitest-environment node
// src/js/chart-align.js: an imported chart lined up with a recording's drum stem. The "stem" is rendered from
// the chart's own hits at known times (a short noise burst per hit, as loud as its drum is in a real stem:
// kick and snare well above the hats; 10% of them missing, a little jitter and stray hits), so the fit can
// be checked against the truth: a steady take at another tempo, a take whose
// tempo wanders, a section that changes speed without the chart saying so, and audio that isn't this chart.
import {describe, expect, test} from 'vitest';
import {alignChart, fitMap, followShift} from '../src/js/chart-align.js';
import {detectOnsets, onsetStrength} from '../src/js/onsets.js';
import {compile, defaultSongMap, timeAt, validateSongMap} from '../shared/song-map.ts';

const RATE = 16000;

function random(seed) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
}

/** 48 bars of 4/4 at 120: a groove (hats in 8ths, kick 1 and 3, snare 2 and 4) with a crash every four bars and a fill every eight. */
function chart() {
  const map = defaultSongMap(96, 120, 4, 4);
  map.measures = map.measures.slice(0, 48);
  const hits = [];
  for (let bar = 0; bar < 48; bar++) {
    const q0 = bar * 4;
    if (bar % 4 === 0) hits.push({q: q0, midi: 49});
    if (bar % 8 === 7) {
      for (let i = 0; i < 16; i++) hits.push({q: q0 + i / 4, midi: [38, 48, 45, 43][Math.floor(i / 4)]});
      continue;
    }
    for (let i = 0; i < 8; i++) hits.push({q: q0 + i / 2, midi: 42});
    hits.push({q: q0, midi: 36}, {q: q0 + 2, midi: 36}, {q: q0 + 1, midi: 38}, {q: q0 + 3, midi: 38});
    if (bar % 2) hits.push({q: q0 + 2.5, midi: 36});
  }
  return {map, hits};
}

/** A mono "drum stem": a decaying noise burst at each {t, amp}, plus a noise floor. */
function stem(times, duration, seed = 3) {
  const rnd = random(seed), data = new Float32Array(Math.ceil(duration * RATE));
  for (let i = 0; i < data.length; i++) data[i] = (rnd() - 0.5) * 0.002;
  for (const {t, amp: level} of times) {
    const at = Math.round(t * RATE), amp = level * (0.8 + rnd() * 0.4);
    for (let i = 0; i < RATE * 0.03 && at + i < data.length; i++) if (at + i >= 0) data[at + i] += (rnd() - 0.5) * amp * Math.exp(-i / (RATE * 0.006));
  }
  return {sampleRate: RATE, length: data.length, numberOfChannels: 1, getChannelData: () => data};
}

const LOUD = {36: 0.8, 38: 0.8, 49: 0.6, 48: 0.7, 45: 0.7, 43: 0.7, 42: 0.15};

/** Plays the chart through `warp` (its own seconds → recording seconds) and fits it. */
async function play({map, hits}, warp, duration, seed = 5) {
  const rnd = random(seed), c = compile(map), loudest = new Map();
  for (const h of hits) loudest.set(h.q, Math.max(loudest.get(h.q) ?? 0, LOUD[h.midi]));
  const times = [...loudest].filter(() => rnd() > 0.1).map(([q, amp]) => ({t: warp(timeAt(c, q)) + (rnd() - 0.5) * 0.006, amp}));
  for (let i = 0; i < 30; i++) times.push({t: rnd() * duration, amp: 0.3});
  const buffer = stem(times, duration, seed);
  return alignChart({map, hits, strength: onsetStrength(buffer), onsets: detectOnsets(buffer), duration, yieldEvery: 1000});
}

/** How far the fitted map puts each hit from where it was played (seconds): [median, worst]. */
function errors(fitted, {map, hits}, warp) {
  const c = compile(map), f = compile(fitted);
  const list = [...new Set(hits.map(h => h.q))].map(q => Math.abs(timeAt(f, q) - warp(timeAt(c, q)))).sort((a, b) => a - b);
  return [list[list.length >> 1], list.at(-1)];
}

describe('alignChart', () => {
  test('a steady take finds where bar 1 starts and the real tempo (the chart says 120, the take is 119.4)', async () => {
    const song = chart();
    const fit = await play(song, t => 2.37 + 1.005 * t, 104);
    expect(fit.quality).toBe('good');
    expect(fit.offset).toBeCloseTo(2.37, 2);
    expect(fit.stretch).toBeCloseTo(1.005, 3);
    expect(fit.chartBpm).toBeCloseTo(120, 6);
    expect(fit.bpm).toBeCloseTo(120 / 1.005, 1);
    expect(fit.follow).toBeNull();   // a steady fit already holds every bar
    const [median, worst] = errors(fitMap(song.map, fit), song, t => 2.37 + 1.005 * t);
    expect(median).toBeLessThan(0.003);
    expect(worst).toBeLessThan(0.008);
  }, 30000);

  test('a chart that starts before the recording does (a cut intro) is shifted with a pin at 0 s', async () => {
    const song = chart();
    const warp = t => -1.3 + t;
    const fit = await play(song, warp, 96);
    expect(fit.offset).toBeCloseTo(-1.3, 2);
    const fitted = fitMap(song.map, fit);
    expect(() => validateSongMap(fitted)).not.toThrow();
    expect(fitted.pins[0].time).toBe(0);
    expect(errors(fitted, song, warp)[0]).toBeLessThan(0.003);
  }, 30000);

  test('a take whose tempo wanders gets a map that follows it bar by bar', async () => {
    const song = chart();
    const warp = t => 0.8 + 1.002 * t + 0.07 * Math.sin(t / 45 * 2 * Math.PI);
    const fit = await play(song, warp, 100);
    expect(fit.quality).toBe('good');
    expect(fit.follow).not.toBeNull();
    expect(fit.follow.matched).toBeGreaterThan(fit.matched);
    expect(() => validateSongMap(fit.follow.map)).not.toThrow();
    expect(fit.follow.map.pins).toHaveLength(48);
    const [median, worst] = errors(fit.follow.map, song, warp);
    expect(median).toBeLessThan(0.012);   // one pin per bar: within a bar the map is straight, the take is not
    expect(worst).toBeLessThan(0.035);
  }, 30000);

  test('a section that speeds up without the chart saying so is followed after the change', async () => {
    const song = chart();
    const warp = t => 1.1 + (t < 40 ? t : 40 + (t - 40) * 0.97);
    const fit = await play(song, warp, 96);
    expect(fit.follow).not.toBeNull();
    const [median, worst] = errors(fit.follow.map, song, warp);
    expect(median).toBeLessThan(0.006);
    expect(worst).toBeLessThan(0.06);
  }, 30000);

  test('audio that is not this chart is "poor" and offers nothing to follow', async () => {
    const song = chart(), rnd = random(17);
    const buffer = stem(Array.from({length: 700}, () => ({t: rnd() * 96, amp: rnd() < 0.3 ? 0.8 : 0.15})), 96, 17);
    const fit = await alignChart({map: song.map, hits: song.hits, strength: onsetStrength(buffer), onsets: detectOnsets(buffer), duration: 96, yieldEvery: 1000});
    expect(fit.quality).toBe('poor');
    expect(fit.follow).toBeNull();
  }, 30000);

  test('nothing to match: no hits or no audio', async () => {
    const {map, hits} = chart();
    const buffer = stem([], 10);
    expect(await alignChart({map, hits: [], strength: onsetStrength(buffer)})).toBeNull();
    expect(await alignChart({map, hits, strength: null})).toBeNull();
    expect(await alignChart({map, hits: hits.slice(0, 2), strength: onsetStrength(buffer)})).toBeNull();
  });
});

describe('fitMap and followShift', () => {
  test('fitMap stretches every time and the tail tempo, then shifts', () => {
    const map = defaultSongMap(20, 120, 4, 4);
    map.pins = [{position: {n: 0, d: 1}, time: 0}, {position: {n: 8, d: 1}, time: 4}];
    map.tailQpm = 120;
    const fitted = fitMap(map, {offset: 1.5, stretch: 1.01});
    expect(fitted.pins.map(p => p.time)).toEqual([1.5, 1.5 + 4 * 1.01]);
    expect(fitted.tailQpm).toBeCloseTo(120 / 1.01, 9);
    expect(map.pins[1].time).toBe(4);   // the chart's own map is untouched
  });

  test('a shift that moves pins before 0 s keeps the later ones and pins the chart position at 0 s', () => {
    const map = defaultSongMap(20, 120, 4, 4);
    map.pins = [{position: {n: 0, d: 1}, time: 0}, {position: {n: 8, d: 1}, time: 4}];
    const moved = followShift(map, -1);
    expect(moved.pins[0]).toEqual({position: {n: 2, d: 1}, time: 0});
    expect(moved.pins[1].time).toBe(3);
    expect(() => validateSongMap(moved)).not.toThrow();
  });
});
