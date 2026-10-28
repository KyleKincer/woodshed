// @vitest-environment node
// Metronome clicks inside the gaps of a segmented loop (architecture §5.2
// "Running" and "Gap clicks", D17; §5.4 items 4 and 13): a count-in before
// every pass that ends exactly where the pass starts, a rest bar at the loop
// start's tempo, silent counts, unmapped songs, plan changes and stopAt. Both
// playback paths: native (keep-pitch off) and Signalsmith (keep-pitch on).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => (await import('./helpers/fake-audio.js')).fakeStemcache);
import {MultitrackEngine} from '../src/js/engine.js';
import {Metronome} from '../src/js/metronome.js';
import {SongMapStore} from '../src/js/song-map.js';
import {FAKE_TIMERS, createClock, installFakeAudio, loadFakeStems} from './helpers/fake-audio.js';
import {mapStore, sectioned, unmapped} from './fixtures/maps.js';

const PATHS = [
  {path: 'native', rate: 0.8, preservePitch: false},
  {path: 'signalsmith', rate: 0.8, preservePitch: true},
];

let engine, clock, restore, metro, beats;
async function setup({rate, preservePitch}, store = mapStore(sectioned), duration = 128) {
  vi.useFakeTimers(FAKE_TIMERS);
  restore = installFakeAudio();
  clock = createClock();
  engine = new MultitrackEngine();
  await loadFakeStems(engine, ['drums', 'bass'], {duration});
  engine.setPreservePitch(preservePitch);
  engine.setSpeed(rate);
  metro = new Metronome(engine, store);
  beats = [];
  metro.onBeat((b) => beats.push(b));
}
afterEach(() => {
  metro?.destroy();
  engine?.destroy();
  metro = engine = null;
  restore?.();
  vi.useRealTimers();
});

const now = () => engine.ctx.currentTime;
const advanceTo = (t) => clock.advance(Math.max(0, t - now()));
const sounding = () => engine.ctx.oscillators.filter((o) => o.startTime != null && o.playsAt(o.startTime)).sort((x, y) => x.startTime - y.startTime);
const times = (list) => list.map((x) => x.startTime ?? x.when);
const near = (values) => values.map((t) => expect.closeTo(t, 9));
const gapsOf = () => engine.plan.filter((s) => s.kind === 'gap');

/**
 * Loop bars 9–12 of `sectioned` (16–24 s, 4/4 at 120 bpm) with a gap of the
 * count-in plus `rest` media seconds, as the transport sets it up (§2.14.3
 * rule 9), and play with the first count.
 */
async function playLoop({countIn = true, mode = 'countin', rest = 0, gap = 'silent', a = 16, b = 24} = {}) {
  metro.configure({countIn, mode, countInLength: 1});
  const plan = countIn ? metro.countInPlanAt(a) : {duration: 0, beats: []};
  engine.setLoop(true, a, b, {gapSec: plan.duration + rest, gap});
  engine.seek(a);
  await engine.play(countIn ? {countIn: plan} : {});
  return plan;
}

describe.each(PATHS)('$path path', ({rate, preservePitch}) => {
  beforeEach(() => setup({rate, preservePitch}));

  test('every pass gets its count-in after the first count, ending exactly at the pass start', async () => {
    await playLoop();
    const L = engine.lookahead, C = 2 / rate, P = 8 / rate;
    const passStarts = [L + C, L + C + P + C, L + C + 2 * (P + C)];
    advanceTo(passStarts[2] + 1);
    const expected = [];
    for (const start of passStarts) for (const o of [0, 0.5, 1, 1.5]) expected.push(start - C + o / rate);
    expect(times(sounding())).toEqual(near(expected));
    expect(beats.map((x) => [x.kind, x.audible])).toEqual(expected.map(() => ['count', true]));
    // The last beat is one beat before the pass, the downbeat is accented, and nothing clicks inside a pass.
    for (const start of passStarts) {
      const count = sounding().filter((o) => o.startTime >= start - C - 1e-9 && o.startTime < start);
      expect(count.map((o) => o.frequency.value)).toEqual([1600, 1050, 1050, 1050]);
      expect(count.at(-1).startTime).toBeCloseTo(start - 0.5 / rate, 9);
    }
    expect(gapsOf().length).toBeGreaterThan(0);
  });

  test('a silent count (mode off) reports the gap beats and sounds none', async () => {
    await playLoop({mode: 'off'});
    const L = engine.lookahead, C = 2 / rate, P = 8 / rate;
    advanceTo(L + C + P + C + 0.5);
    expect(engine.ctx.oscillators).toEqual([]);
    expect(beats.map((x) => [x.kind, x.audible, x.unit, x.downbeat])).toEqual([0, 1, 2, 3, 0, 1, 2, 3].map((u) => ['count', false, u, u === 0]));
    expect(beats[4].when).toBeCloseTo(L + C + P, 9);
  });

  test('a rest bar before the count clicks every counted beat at the loop start\'s tempo', async () => {
    // Bars 8–15 run at 4 quarters per 1.75 s (about 137 bpm); bar 7, which the count-in follows, at 120.
    metro.destroy(); engine.destroy(); restore();
    const tempo = structuredClone(sectioned.tempo);
    tempo.songMap.pins.push({position: {n: 32, d: 1}, time: 16}, {position: {n: 64, d: 1}, time: 30});
    await setup({rate, preservePitch}, SongMapStore.fromTempo(tempo, 128));
    const plan = await playLoop({rest: 1.75});
    expect(plan.duration).toBeCloseTo(2, 9);
    const L = engine.lookahead, C = 2 / rate, P = 8 / rate;
    advanceTo(L + C + P + 1.75 / rate + C + 0.2);
    const gapStart = L + C + P;
    const inGap = sounding().filter((o) => o.startTime >= gapStart - 1e-9);
    expect(times(inGap)).toEqual(near([...[0, 0.4375, 0.875, 1.3125], ...[0, 0.5, 1, 1.5].map((o) => 1.75 + o)].map((o) => gapStart + o / rate)));
    expect(inGap.map((o) => o.frequency.value)).toEqual([1600, 1050, 1050, 1050, 1600, 1050, 1050, 1050]);
    expect(beats.filter((x) => x.when >= gapStart - 1e-9).map((x) => x.kind)).toEqual(['rest', 'rest', 'rest', 'rest', 'count', 'count', 'count', 'count']);
  });

  test('a rest with count-in off clicks the rest bar unless the click is off', async () => {
    await playLoop({countIn: false, rest: 2});
    const L = engine.lookahead, P = 8 / rate, G = 2 / rate;
    advanceTo(L + P + G + 0.1);
    expect(times(sounding())).toEqual(near([0, 0.5, 1, 1.5].map((o) => L + P + o / rate)));
    expect(beats.every((x) => x.kind === 'rest' && x.audible)).toBe(true);
    metro.configure({mode: 'off'});
    const heard = sounding().length;
    advanceTo(L + 2 * (P + G) + 0.1);
    expect(sounding()).toHaveLength(heard);
    expect(beats.filter((x) => x.kind === 'rest' && !x.audible)).toHaveLength(4);
  });

  test('a rest turned on during playback with count-in off starts the clicks (and the silent beats with the click off)', async () => {
    for (const mode of ['countin', 'off']) {
      metro.configure({countIn: false, mode});
      engine.setLoop(true, 16, 24);
      engine.seek(16);
      await engine.play();
      clock.advance(1);
      expect(metro._timer).toBeNull();
      const before = sounding().length;
      beats.length = 0;
      // The '1 bar rest' toggled on mid-pass: a plan change, not a discontinuity.
      engine.setLoop(true, 16, 24, {gapSec: 2});
      const gap = gapsOf()[0];
      advanceTo(gap.until + 0.1);
      const expected = [0, 0.5, 1, 1.5].map((o) => gap.when + o / rate);
      expect(times(beats)).toEqual(near(expected));
      expect(beats.map((x) => [x.kind, x.audible])).toEqual(expected.map(() => ['rest', mode !== 'off']));
      expect(times(sounding().slice(before))).toEqual(mode === 'off' ? [] : near(expected));
      engine.pause();
    }
  });

  test('the continuous click plays in the passes and the count in the gaps', async () => {
    await playLoop({mode: 'always'});
    const L = engine.lookahead, C = 2 / rate, P = 8 / rate;
    advanceTo(L + C + P + C + 0.05);
    const clicks = beats.filter((x) => x.kind === 'click'), counts = beats.filter((x) => x.kind === 'count');
    expect(times(clicks)).toEqual(near([...Array(16).keys()].map((i) => L + C + i * 0.5 / rate).concat([L + C + P + C])));
    expect(counts).toHaveLength(8);
    for (const c of counts.slice(4)) expect(c.when).toBeGreaterThanOrEqual(L + C + P - 1e-9);
  });

  test('a gap shorter than the count clicks only the beats that fit before the pass', async () => {
    metro.configure({countIn: true, countInLength: 1});
    engine.setLoop(true, 16, 24, {gapSec: 1.2});
    engine.seek(16);
    await engine.play();
    const L = engine.lookahead, P = 8 / rate, G = 1.2 / rate;
    advanceTo(L + P + G + 0.1);
    expect(times(sounding())).toEqual(near([1, 1.5].map((o) => L + P + G - (2 - o) / rate)));
  });

  test('a scheduled speed change at the wrap counts the next gap at the new rate', async () => {
    await playLoop();
    const L = engine.lookahead, C = 2 / rate;
    advanceTo(L + C + 1);
    const W = engine.nextWrapAt();
    engine.setSpeed(1.25, {at: W});
    advanceTo(W + 2 / 1.25 + 0.1);
    expect(times(sounding().filter((o) => o.startTime >= W - 1e-9))).toEqual(near([0, 0.5, 1, 1.5].map((o) => W + o / 1.25)));
  });

  test('a loop edit in the gap keeps the clicks before it and reschedules the rest at the same times', async () => {
    await playLoop();
    const L = engine.lookahead, C = 2 / rate, P = 8 / rate, gapStart = L + C + P;
    advanceTo(gapStart + 0.6 / rate);
    const before = sounding().filter((o) => o.startTime >= gapStart - 1e-9);
    const revision = engine.revision;
    engine.setLoop(true, 16, 22, {gapSec: 2});
    expect(engine.revision).toBe(revision);
    advanceTo(gapStart + C + 0.1);
    const after = sounding().filter((o) => o.startTime >= gapStart - 1e-9);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(times(after)).toEqual(near([0, 0.5, 1, 1.5].map((o) => gapStart + o / rate)));
    // A discontinuity cancels every click that has not sounded.
    engine.seek(18);
    expect(sounding().filter((o) => o.startTime > now())).toEqual([]);
  });

  test('play N times: stopAt at a pass end plays no gap click after it', async () => {
    await playLoop({mode: 'always'});
    const L = engine.lookahead, C = 2 / rate;
    advanceTo(L + C + 1);
    const W = engine.nextWrapAt();
    engine.stopAt(W);
    advanceTo(W + C + 0.5);
    expect(engine.playing).toBe(false);
    expect(sounding().filter((o) => o.startTime >= W - 1e-9)).toEqual([]);
    expect(beats.filter((x) => x.when >= W - 1e-9)).toEqual([]);
  });
});

test('an unmapped song never clicks in its lead-in gaps', async () => {
  await setup({rate: 1, preservePitch: true}, mapStore(unmapped), 30);
  expect(metro.songMap.isReal).toBe(false);
  metro.configure({countIn: true, mode: 'countin'});
  engine.setLoop(true, 6, 10, {gapSec: 2, gap: 'preroll'});
  engine.seek(6);
  await engine.play({countIn: {duration: 2, beats: []}, audiblePreRoll: true});
  clock.advance(14);
  expect(gapsOf().length).toBeGreaterThan(0);
  expect(engine.ctx.oscillators).toEqual([]);
  expect(beats).toEqual([]);
});

test('an unmapped song never sounds the continuous click', async () => {
  await setup({rate: 1, preservePitch: false}, mapStore(unmapped), 30);
  metro.configure({countIn: false, mode: 'always'});
  await engine.play();
  clock.advance(3);
  expect(engine.ctx.oscillators).toEqual([]);
  expect(beats).toEqual([]);
});
