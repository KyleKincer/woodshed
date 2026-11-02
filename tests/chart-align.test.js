// @vitest-environment node
// src/js/chart-align.js: an imported chart lined up with a recording's drum stem. The "stem" is rendered from
// the chart's own hits at known times (a short noise burst per hit, as loud as its drum is in a real stem:
// kick and snare well above the hats; 10% of them missing, a little jitter and stray hits), so the fit can
// be checked against the truth: the chart starting late or early in the recording, a chart that repeats its
// sections, and audio that isn't this chart. The chart's tempo is trusted: only the offset is found.
import {describe, expect, test} from 'vitest';
import {alignChart} from '../src/js/chart-align.js';
import {detectOnsets, onsetStrength} from '../src/js/onsets.js';
import {compile, defaultSongMap, timeAt} from '../shared/song-map.ts';

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
  return alignChart({map, hits, strength: onsetStrength(buffer), onsets: detectOnsets(buffer), duration});
}

describe('alignChart', () => {
  test('finds where bar 1 starts in the recording, to the millisecond', async () => {
    const song = chart();
    for (const start of [2.37, 0.004, 11.8]) {
      const fit = await play(song, t => start + t, 110);
      expect(fit.quality, `${start}`).toBe('good');
      expect(fit.offset, `${start}`).toBeCloseTo(start, 2);
      expect(Math.abs(fit.offset - start), `${start}`).toBeLessThan(0.003);
      expect(fit.matched / fit.total).toBeGreaterThan(0.8);
      expect(Object.keys(fit).sort()).toEqual(['matched', 'offset', 'quality', 'total']);   // the tempo is the chart's own
    }
  }, 30000);

  test('a recording that cuts the chart\'s intro: bar 1 is before 0 s', async () => {
    const fit = await play(chart(), t => -1.3 + t, 96);
    expect(fit.offset).toBeCloseTo(-1.3, 2);
  }, 30000);

  test('a chart that repeats its sections lines up on its own start, not on a repeat', async () => {
    // The chart's groove repeats every two bars and its fills every eight: the whole chart decides.
    const fit = await play(chart(), t => 0.8 + t, 100);
    expect(fit.offset).toBeCloseTo(0.8, 2);
  }, 30000);

  test('audio that is not this chart is "poor"', async () => {
    const song = chart(), rnd = random(17);
    const buffer = stem(Array.from({length: 700}, () => ({t: rnd() * 96, amp: rnd() < 0.3 ? 0.8 : 0.15})), 96, 17);
    const fit = await alignChart({map: song.map, hits: song.hits, strength: onsetStrength(buffer), onsets: detectOnsets(buffer), duration: 96});
    expect(fit.quality).toBe('poor');
  }, 30000);

  test('nothing to match: no hits or no audio', async () => {
    const {map, hits} = chart();
    const buffer = stem([], 10);
    expect(await alignChart({map, hits: [], strength: onsetStrength(buffer)})).toBeNull();
    expect(await alignChart({map, hits, strength: null})).toBeNull();
    expect(await alignChart({map, hits: hits.slice(0, 2), strength: onsetStrength(buffer)})).toBeNull();
  });
});
