// @vitest-environment node
// Segmented loops (architecture §5.0, §5.1 `setLoop` with `gapSec > 0`,
// `gapsBetween`, `beatsBetween`; §5.4 items 4–6), on both playback paths:
// native sources (keep-pitch off) and the Signalsmith processor (keep-pitch
// on, rate ≠ 1). "Audible" assertions read what each path renders at an audio
// time: the native sources playing then, or the processor's time map behind
// the pitch gate, and the stems' master gain.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => (await import('./helpers/fake-audio.js')).fakeStemcache);
import {MultitrackEngine} from '../src/js/engine.js';
import {FAKE_TIMERS, createClock, installFakeAudio, loadFakeStems} from './helpers/fake-audio.js';

const PATHS = [
  {path: 'native', rate: 0.8, preservePitch: false},
  {path: 'signalsmith', rate: 0.8, preservePitch: true},
];

let engine, clock, restore;
async function setup({rate, preservePitch}) {
  vi.useFakeTimers(FAKE_TIMERS);
  restore = installFakeAudio();
  clock = createClock();
  engine = new MultitrackEngine();
  await loadFakeStems(engine, ['drums', 'bass'], {duration: 100});
  engine.setPreservePitch(preservePitch);
  engine.setSpeed(rate);
}
afterEach(() => {
  // Every processor post names its cut explicitly, strictly before the change.
  for (const [call] of engine?.stretch?.schedule.mock.calls ?? []) {
    expect(call).toHaveProperty('outputTime');
    expect(call.outputTime).toBeLessThan(call.output);
  }
  engine?.destroy();
  engine = null;
  restore?.();
  vi.useRealTimers();
});

const now = () => engine.ctx.currentTime;
const advanceTo = (t) => clock.advance(Math.max(0, t - now()));
const sourcesOf = (track) => engine.ctx.sources.filter((s) => s.buffer === track.buffer && s.startTime != null);

function heard(t) {
  return {
    master: engine.master.gain.valueAt(t),
    gate: engine.pitchGate.gain.valueAt(t),
    native: engine.tracks.map((track) => sourcesOf(track).filter((s) => s.playsAt(t)).map((s) => s.mediaAt(t))),
    processed: engine.stretch.inputAt(t),
  };
}

/** Exactly one path renders media time `position` at `t`, and the engine reads it. */
function expectAudibleAt(path, t, position) {
  expect(engine.getPositionAt(t)).toBeCloseTo(position, 6);
  const h = heard(t);
  expect(h.master).toBe(1);
  if (path === 'native') {
    expect(h.gate).toBe(0);
    for (const list of h.native) { expect(list).toHaveLength(1); expect(list[0]).toBeCloseTo(position, 6); }
  } else {
    expect(h.gate).toBe(1);
    for (const list of h.native) expect(list).toHaveLength(0);
    expect(h.processed).toBeCloseTo(position, 6);
  }
}

/** Nothing reaches the output at `t`: no native source, the gate shut, the master at 0. */
function expectSilentAt(t) {
  const h = heard(t);
  for (const list of h.native) expect(list).toEqual([]);
  expect(h.gate).toBe(0);
  expect(h.master).toBe(0);
}

async function playSegmented(rate, {a = 10, b = 14, gapSec = 2, gap = 'silent', from = a} = {}) {
  engine.setLoop(true, a, b, {gapSec, gap});
  engine.seek(from);
  await engine.play();
  const L = engine.lookahead, P = (b - a) / rate, G = gapSec / rate;
  return {L, P, G, first: L + (b - from) / rate};
}

describe.each(PATHS)('$path path', ({path, rate, preservePitch}) => {
  beforeEach(() => setup({rate, preservePitch}));

  test('a silent gap: passes and stops line up sample-exactly and the position reads a in the gap', async () => {
    const {L, P, G} = await playSegmented(rate);
    const until1 = L + 4 / rate, start2 = until1 + 2 / rate, until2 = start2 + 4 / rate;
    expect(engine.plan.map((s) => s.kind)).toEqual(['pass', 'gap', 'pass']);
    expect(engine.plan[0]).toMatchObject({when: L, offset: 10, until: until1, index: 1});
    expect(engine.plan[1]).toMatchObject({when: until1, until: start2, target: 10, mode: 'silent'});
    expect(engine.plan[2]).toMatchObject({when: start2, offset: 10, until: until2, index: 2});
    expect(engine.loop).toEqual({enabled: true, a: 10, b: 14});
    expect(engine.loopGap).toEqual({sec: 2, mode: 'silent'});
    if (path === 'native') {
      // One source per pass and track, never looping, starting and stopping exactly at the pass bounds.
      for (const track of engine.tracks) {
        const list = sourcesOf(track).filter((s) => s.startTime >= L);
        expect(list.map((s) => [s.startTime, s.offset, s.stopTime, s.loop])).toEqual([[L, 10, until1, false], [start2, 10, until2, false]]);
      }
    } else {
      expect(engine.stretch.schedule.mock.lastCall[0]).toMatchObject({active: true, output: L, input: 10, rate, loopStart: 0, loopEnd: 0});
    }
    expectAudibleAt(path, L + 1, 10 + rate);
    expectAudibleAt(path, until1 - 0.001, 14 - 0.001 * rate);
    for (const t of [until1, until1 + 0.001, until1 + G / 2, start2 - 0.001]) {
      expect(engine.getPositionAt(t)).toBe(10);
      expectSilentAt(t);
    }
    advanceTo(L + 0.05);
    // The processor gets the next pass as soon as the current one has started.
    if (path === 'signalsmith') expect(engine.stretch.schedule.mock.lastCall[0]).toMatchObject({active: true, output: start2, input: 10, rate, loopStart: 0, loopEnd: 0});
    expectAudibleAt(path, start2, 10);
    expectAudibleAt(path, start2 + 0.25, 10 + 0.25 * rate);
    expect(P).toBeGreaterThan(G);
  });

  test('when a pass starts, its gap and the next pass are appended and posted at once', async () => {
    const {L, P, G} = await playSegmented(rate);
    const plans = [];
    engine.on('plan', (p) => plans.push(p));
    const start2 = L + P + G, start3 = start2 + P + G;
    advanceTo(start2 + 0.03);
    expect(engine.plan.map((s) => [s.kind, s.when])).toEqual([
      ['pass', start2], ['gap', start2 + P], ['pass', expect.closeTo(start3, 9)],
    ]);
    expect(plans).toEqual([{from: expect.closeTo(start2 + P, 9), version: engine.planVersion}]);
    if (path === 'native') {
      for (const track of engine.tracks) expect(sourcesOf(track).filter((s) => Math.abs(s.startTime - start3) < 1e-9)).toHaveLength(1);
    } else {
      expect(engine.stretch.schedule.mock.lastCall[0]).toMatchObject({output: expect.closeTo(start3, 9), input: 10});
    }
    expectAudibleAt(path, start3 + 0.1, 10 + 0.1 * rate);
  });

  test('a throttled tab (no tick for over a second) still plays the next gap and pass', async () => {
    const {L, P, G} = await playSegmented(rate);
    const start2 = L + P + G;
    advanceTo(start2 + 0.03);
    vi.clearAllTimers();
    const silentFrom = start2 + P, start3 = silentFrom + G;
    engine.ctx._advanceTo(start2 + 1.2);
    expectAudibleAt(path, start2 + 1.5, 10 + 1.5 * rate);
    expectSilentAt(silentFrom + G / 2);
    expectAudibleAt(path, start3 + 0.2, 10 + 0.2 * rate);
    // Without any tick beyond that pass, its end is silence, never the audio past b.
    expectSilentAt(start3 + P + 0.01);
  });

  test('a very late tick catches up: every missed wrap and gap once, in order, and audio on the timeline', async () => {
    const events = [];
    engine.on('wrap', (w) => events.push(['wrap', w.when, w.pass]));
    engine.on('gap', (g) => events.push(['gap', g.when, g.until, g.target]));
    const {L, P, G} = await playSegmented(rate);
    vi.clearAllTimers();
    const T = P + G, late = L + 3 * T + 0.4;
    engine.ctx._advanceTo(late);
    engine._tick();
    engine._tick();
    const expected = [];
    for (let k = 0; k < 3; k++) {
      const end = L + k * T + P;
      expected.push(['wrap', expect.closeTo(end, 9), k + 1], ['gap', expect.closeTo(end, 9), expect.closeTo(end + G, 9), 10]);
    }
    expect(events).toEqual(expected);
    expectAudibleAt(path, now() + 0.1, 10 + (now() + 0.1 - (L + 3 * T)) * rate);
  });

  test('wrap fires at each pass end, gap at each gap start; nextWrapAt and whenAt follow the passes', async () => {
    const events = [];
    engine.on('wrap', (w) => events.push(['wrap', w]));
    engine.on('gap', (g) => events.push(['gap', g]));
    const {L, P, G} = await playSegmented(rate, {from: 6});
    const until1 = L + 8 / rate, start2 = until1 + G;
    clock.advance(0.5);
    expect(engine.nextWrapAt()).toBe(until1);
    // 12 is ahead in the lead-in pass; 9 lies before a and is reached in this pass only.
    expect(engine.whenAt(12)).toBeCloseTo(L + 6 / rate, 9);
    expect(engine.whenAt(9)).toBeCloseTo(L + 3 / rate, 9);
    for (const t of [14, 20, 3]) expect(engine.whenAt(t)).toBeNull();
    advanceTo(until1 + 0.1);
    expect(events).toEqual([
      ['wrap', {when: until1, a: 10, b: 14, pass: 1}],
      ['gap', {when: until1, until: start2, target: 10}],
    ]);
    expect(engine.getPosition()).toBe(10);
    expect(engine.nextWrapAt()).toBeCloseTo(start2 + P, 9);
    // Nothing is heard in a silent gap: a is reached when the next pass starts.
    expect(engine.whenAt(10)).toBeCloseTo(start2, 9);
    expect(engine.whenAt(9)).toBeNull();
    expect(engine.whenAt(12.5)).toBeCloseTo(start2 + 2.5 / rate, 9);
    advanceTo(start2 + P + G + P + 0.05);
    expect(events.filter(([type]) => type === 'wrap').map(([, w]) => [w.when, w.pass])).toEqual([
      [until1, 1], [expect.closeTo(start2 + P, 9), 2], [expect.closeTo(start2 + 2 * P + G, 9), 3],
    ]);
  });

  test('beatsBetween gives no song beats inside gaps; gapsBetween reports each gap', async () => {
    const beats = Array.from({length: 200}, (_, i) => ({time: i * 0.5, downbeat: i % 4 === 0}));
    const {L, P, G} = await playSegmented(rate);
    const until1 = L + P, start2 = until1 + G;
    const events = engine.beatsBetween(0, start2 + P, beats);
    expect(events.filter((e) => e.when >= until1 - 1e-9 && e.when < start2 - 1e-9)).toEqual([]);
    expect(events.map((e) => e.time)).toEqual([10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5]);
    expect(events[8].when).toBeCloseTo(start2, 9);
    expect(events[1].when).toBeCloseTo(L + 0.5 / rate, 9);
    expect(engine.gapsBetween(0, until1)).toEqual([]);
    expect(engine.gapsBetween(until1 + 0.1, until1 + 0.2)).toEqual([{when: until1, until: start2, target: 10, rate, elapsed: 0, end: start2}]);
    advanceTo(start2 + 0.05);
    expect(engine.gapsBetween(now(), now() + 100).map((g) => g.when)).toEqual([expect.closeTo(start2 + P, 9)]);
    engine.pause();
    expect(engine.gapsBetween(0, 1000)).toEqual([]);
  });

  test('a gap shorter than 0.3 s keeps its boundary on every pass', async () => {
    const {L, P, G} = await playSegmented(rate, {gapSec: 0.2});
    expect(G).toBeLessThan(0.3);
    for (let k = 0; k < 4; k++) {
      const start = L + k * (P + G), end = start + P;
      advanceTo(start + 0.03);
      if (path === 'signalsmith') {
        // The time map still holds the boundary after the next pass is posted.
        const next = engine.stretch.timeMap.find((seg) => Math.abs(seg.output - (end + G)) < 1e-9);
        expect(next).toMatchObject({active: true, input: 10, rate, loopStart: 0, loopEnd: 0});
      }
      expectAudibleAt(path, end - 0.002, 14 - 0.002 * rate);
      expectSilentAt(end + G / 2);
      expectAudibleAt(path, end + G + 0.002, 10 + 0.002 * rate);
    }
  });

  test('a preroll gap plays the audio before a straight into the next pass', async () => {
    const {L, P, G} = await playSegmented(rate, {gap: 'preroll'});
    const until1 = L + P, start2 = until1 + G;
    expect(engine.plan[1]).toMatchObject({kind: 'gap', mode: 'preroll', offset: 8, audibleFrom: until1});
    expect(engine.getPositionAt(until1 + 0.5)).toBeCloseTo(8 + 0.5 * rate, 9);
    advanceTo(L + 0.05);
    if (path === 'native') {
      // One source from a − gapSec through the whole next pass.
      for (const track of engine.tracks) {
        const source = sourcesOf(track).find((s) => s.startTime === until1);
        expect([source.offset, source.stopTime, source.loop]).toEqual([8, start2 + P, false]);
        expect(sourcesOf(track).filter((s) => Math.abs(s.startTime - start2) < 1e-9)).toEqual([]);
      }
    } else {
      expect(engine.stretch.schedule.mock.lastCall[0]).toMatchObject({output: until1, input: 8, loopStart: 0, loopEnd: 0});
    }
    expectAudibleAt(path, until1 + 0.5, 8 + 0.5 * rate);
    expectAudibleAt(path, start2 + 0.3, 10 + 0.3 * rate);
    advanceTo(start2 + 0.05);
    if (path === 'signalsmith') expect(engine.stretch.schedule.mock.lastCall[0]).toMatchObject({output: expect.closeTo(start2 + P, 9), input: 8});
    expectAudibleAt(path, start2 + P + 0.1, 8 + 0.1 * rate);
  });

  test('a preroll gap longer than a is silence before 0', async () => {
    const {L, P, G} = await playSegmented(rate, {a: 1, b: 5, gap: 'preroll'});
    const until1 = L + P, audible = until1 + 1 / rate, start2 = until1 + G;
    expect(engine.plan[1]).toMatchObject({offset: -1, audibleFrom: audible});
    advanceTo(L + 0.05);
    for (const t of [until1 + 0.01, audible - 0.01]) {
      expect(engine.getPositionAt(t)).toBe(0);
      expect(heard(t).native.flat()).toEqual([]);
      expect(heard(t).gate).toBe(0);
    }
    if (path === 'native') for (const track of engine.tracks) expect(sourcesOf(track).find((s) => s.startTime === audible).offset).toBe(0);
    expectAudibleAt(path, audible + 0.2, 0.2 * rate);
    expectAudibleAt(path, start2 + 0.2, 1 + 0.2 * rate);
  });

  test('gapSec = 0 is the gapless loop of today', async () => {
    engine.setLoop(true, 10, 14, {gapSec: 0});
    expect(engine.loopGap).toEqual({sec: 0, mode: 'silent'});
    engine.seek(10);
    await engine.play();
    expect(engine.plan.map((s) => s.kind)).toEqual(['play']);
    if (path === 'native') for (const track of engine.tracks) expect(sourcesOf(track).at(-1)).toMatchObject({loop: true, loopStart: 10, loopEnd: 14});
    else expect(engine.stretch.schedule.mock.lastCall[0]).toMatchObject({loopStart: 10, loopEnd: 14});
    const L = engine.lookahead;
    expectAudibleAt(path, L + 4 / rate + 0.1, 10 + 0.1 * rate);
    expect(engine.gapsBetween(0, 100)).toEqual([]);
    // Without options, setLoop is gapless too (and resets a gap).
    engine.setLoop(true, 10, 14, {gapSec: 1});
    engine.setLoop(true, 10, 14);
    expect(engine.loopGap.sec).toBe(0);
    expect(engine.plan.at(-1).kind).toBe('play');
  });

  test('changing gapSec while playing rebuilds the plan from the current position', async () => {
    const {L} = await playSegmented(rate, {gapSec: 2});
    clock.advance(1);
    const revision = engine.revision, version = engine.planVersion;
    let cut = now() + L, at = engine.getPositionAt(cut);
    engine.setLoop(true, 10, 14, {gapSec: 1});
    expect(engine.revision).toBe(revision);
    expect(engine.planVersion).toBe(version + 1);
    expect(engine.plan.at(-3)).toMatchObject({kind: 'pass', when: cut, offset: expect.closeTo(at, 9)});
    const until = cut + (14 - at) / rate;
    expect(engine.plan.at(-2)).toMatchObject({kind: 'gap', when: expect.closeTo(until, 9), until: expect.closeTo(until + 1 / rate, 9)});
    expectAudibleAt(path, cut + 0.1, at + 0.1 * rate);
    advanceTo(until + 0.3 / rate);
    // In the gap: a longer gap carries on for the rest of it, a gapless loop plays on from a.
    cut = now() + L;
    engine.setLoop(true, 10, 14, {gapSec: 3});
    expect(engine.plan.find((s) => s.kind === 'gap' && s.when === cut)).toMatchObject({until: expect.closeTo(until + 3 / rate, 9), continued: true});
    expectSilentAt(until + 2 / rate);
    cut = now() + L;
    engine.setLoop(true, 10, 14);
    expect(engine.revision).toBe(revision);
    expect(engine.plan.at(-1)).toMatchObject({kind: 'play', when: cut, offset: 10});
    expectAudibleAt(path, cut + 0.1, 10 + 0.1 * rate);
    expectAudibleAt(path, cut + 4 / rate + 0.1, 10 + 0.1 * rate);
  });

  test('a scheduled speed change at the wrap runs the gap and the next pass at the new rate', async () => {
    const {L, P} = await playSegmented(rate);
    clock.advance(0.5);
    const W = engine.nextWrapAt(), revision = engine.revision;
    expect(W).toBe(L + P);
    engine.setSpeed(1.2, {at: W});
    expect(engine.revision).toBe(revision);
    expect(engine.plan.slice(-2)).toMatchObject([{kind: 'gap', when: W, until: W + 2 / 1.2, rate: 1.2}, {kind: 'pass', when: W + 2 / 1.2, offset: 10, rate: 1.2}]);
    expectSilentAt(W + 1);
    advanceTo(W + 2 / 1.2 + 0.05);
    expect(engine.rate).toBe(1.2);
    expectAudibleAt(path, W + 2 / 1.2 + 0.1, 10 + 0.1 * 1.2);
    expect(engine.nextWrapAt()).toBeCloseTo(W + 2 / 1.2 + 4 / 1.2, 9);
  });

  test('an immediate change during a pass keeps the run segmented', async () => {
    const {L} = await playSegmented(rate);
    clock.advance(1);
    const cut = now() + L, at = engine.getPositionAt(cut), revision = engine.revision;
    engine.setSpeed(1.25);
    expect(engine.revision).toBe(revision + 1);
    expectAudibleAt(path, cut + 0.1, at + 0.1 * 1.25);
    advanceTo(cut + 0.03);
    const until = cut + (14 - at) / 1.25;
    expectSilentAt(until + 0.5);
    expectAudibleAt(path, until + 2 / 1.25 + 0.1, 10 + 0.1 * 1.25);
  });

  test('a quantized jump out of the loop at the wrap, and cancelling it, keep the gaps exact', async () => {
    const {L, P, G} = await playSegmented(rate);
    clock.advance(0.5);
    const W = engine.nextWrapAt();
    engine.seekAt(40, W, {loop: {enabled: false}});
    expect(engine.plan.at(-1)).toMatchObject({kind: 'play', when: W, offset: 40, loop: {enabled: false}});
    expectAudibleAt(path, W + 0.1, 40 + 0.1 * rate);
    const cut = now() + L;
    expect(engine.cancelPending()).toBe(true);
    expect(engine.nextWrapAt()).toBeCloseTo(W, 9);
    advanceTo(cut + 0.03);
    expectSilentAt(W + G / 2);
    expectAudibleAt(path, L + P + G + 0.1, 10 + 0.1 * rate);
  });

  test('stopAt at the end of a pass ends at b; the gap after it never reopens the stems', async () => {
    const ended = [];
    engine.on('ended', (e) => ended.push(e));
    const {G} = await playSegmented(rate);
    clock.advance(0.5);
    const W = engine.nextWrapAt();
    engine.stopAt(W);
    for (const bus of [engine.master, engine.aux]) {
      expect(bus.gain.valueAt(W - 1e-3)).toBe(1);
      expect(bus.gain.valueAt(W)).toBe(0);
      expect(bus.gain.valueAt(W + G + 1)).toBe(0);
    }
    expect(engine.gapsBetween(W - 1, W + 10)).toEqual([]);
    advanceTo(W + 0.1);
    expect(ended).toEqual([{reason: 'stopAt'}]);
    expect(engine.pausedAt).toBeCloseTo(14, 3);
  });

  test('a discontinuity clears stopAt and the gaps keep their automation', async () => {
    const {L, P, G} = await playSegmented(rate);
    clock.advance(0.5);
    engine.stopAt(engine.nextWrapAt());
    engine.setSpeed(rate);
    expect(engine.stopAtWhen).toBeNull();
    clock.advance(L + 0.03);
    const until = engine.nextWrapAt();
    expect(until).toBeCloseTo(L + P, 6);
    expectSilentAt(until + G / 2);
    expectAudibleAt(path, until + G + 0.1, 10 + 0.1 * rate);
  });

  test('pausing in a gap rests at a; play resumes with a pass from a', async () => {
    const {L, P, G} = await playSegmented(rate);
    advanceTo(L + P + G / 2);
    engine.pause();
    expect(engine.pausedAt).toBe(10);
    await engine.play();
    expect(engine.plan[0]).toMatchObject({kind: 'pass', offset: 10, when: now() + L});
    expectAudibleAt(path, now() + L + 0.1, 10 + 0.1 * rate);
  });

  test('a loop edit in a gap: a target still inside carries the gap on; one outside moves the position', async () => {
    const {L, P, G} = await playSegmented(rate);
    advanceTo(L + P + G / 4);
    const revision = engine.revision;
    engine.setLoop(true, 10, 13, {gapSec: 2});
    expect(engine.revision).toBe(revision);
    expectSilentAt(L + P + G * 0.9);
    expectAudibleAt(path, L + P + G + 0.1, 10 + 0.1 * rate);
    expect(engine.nextWrapAt()).toBeCloseTo(L + P + G + 3 / rate, 9);
    advanceTo(L + P + G + 3 / rate + G / 4);
    // A loop after the target: playback leads in from the target, as without gaps.
    let cut = now() + L;
    engine.setLoop(true, 20, 24, {gapSec: 2});
    expect(engine.revision).toBe(revision);
    expect(engine.plan.at(-3)).toMatchObject({kind: 'pass', when: cut, offset: 10, until: cut + 14 / rate});
    expectAudibleAt(path, cut + 0.1, 10 + 0.1 * rate);
    // A loop before the target moves the position to its start: a discontinuity.
    cut = now() + L;
    engine.setLoop(true, 2, 6, {gapSec: 2});
    expect(engine.revision).toBe(revision + 1);
    expect(engine.plan.at(-3)).toMatchObject({kind: 'pass', when: cut, offset: 2});
    expectAudibleAt(path, cut + 0.1, 2 + 0.1 * rate);
    engine.setLoop(false);
    expect(engine.plan.at(-1).kind).toBe('play');
  });

  test('changing gapSec in a preroll gap keeps the audio it plays, or is a discontinuity when it cannot', async () => {
    const transports = [];
    const {L, P} = await playSegmented(rate, {gap: 'preroll'});
    engine.on('transport', (e) => transports.push(e.revision));
    advanceTo(L + P + 0.5);
    const revision = engine.revision;
    // A longer preroll: the gap carries on from the same audio and reaches a on time.
    let cut = now() + L, at = engine.getPositionAt(cut);
    engine.setLoop(true, 10, 14, {gapSec: 4, gap: 'preroll'});
    expect(engine.revision).toBe(revision);
    expect(transports).toEqual([]);
    expect(engine.plan.find((s) => s.kind === 'gap' && s.when === cut)).toMatchObject({continued: true, offset: expect.closeTo(at, 9)});
    expectAudibleAt(path, cut + 0.1, at + 0.1 * rate);
    const start2 = cut + (10 - at) / rate;
    expectAudibleAt(path, start2 + 0.1, 10 + 0.1 * rate);
    expect(engine.nextWrapAt()).toBeCloseTo(start2 + P, 9);
    advanceTo(start2 + 0.05);
    expectAudibleAt(path, start2 + P + 0.1, 6 + 0.1 * rate);
    // A shorter one than the audio still needs: the position moves (a discontinuity).
    advanceTo(start2 + P + 0.5);
    cut = now() + L;
    engine.setLoop(true, 10, 14, {gapSec: 2, gap: 'preroll'});
    expect(engine.revision).toBe(revision + 1);
    expect(transports).toEqual([revision + 1]);
    expectAudibleAt(path, cut + 0.1, 8 + 0.1 * rate);
    expectAudibleAt(path, cut + 2 / rate + 0.1, 10 + 0.1 * rate);
    // A mode change in the gap moves the position too.
    advanceTo(cut + 0.2);
    cut = now() + L;
    engine.setLoop(true, 10, 14, {gapSec: 2});
    expect(engine.revision).toBe(revision + 2);
    expectSilentAt(cut + 0.1);
    expect(engine.getPositionAt(cut + 0.1)).toBe(10);
  });

  test('preroll audio already inside a loop moved over it plays on as a pass', async () => {
    const {L, P} = await playSegmented(rate, {gap: 'preroll'});
    advanceTo(L + P + 0.5);
    const revision = engine.revision, cut = now() + L, at = engine.getPositionAt(cut);
    engine.setLoop(true, 8, 14, {gapSec: 2, gap: 'preroll'});
    expect(engine.revision).toBe(revision);
    expect(engine.plan.at(-3)).toMatchObject({kind: 'pass', when: cut, offset: expect.closeTo(at, 9)});
    expectAudibleAt(path, cut + 0.1, at + 0.1 * rate);
    const until = cut + (14 - at) / rate;
    advanceTo(cut + 0.05);
    expectAudibleAt(path, until + 0.1, 6 + 0.1 * rate);
  });

  test('cancelPending after a quantized jump has landed finds nothing pending', async () => {
    await playSegmented(rate);
    clock.advance(0.5);
    const at = engine.seekAt(12, now() + 0.5);
    expect(engine.plan.filter((s) => s.scheduled).map((s) => s.kind)).toEqual(['pass']);
    advanceTo(at + 0.05);
    const version = engine.planVersion, plans = [];
    engine.on('plan', (p) => plans.push(p));
    expect(engine.cancelPending()).toBe(false);
    expect(engine.planVersion).toBe(version);
    expect(plans).toEqual([]);
  });

  test('stopAt at a pass end emits its wrap and no gap; a late tick emits nothing past the stop', async () => {
    for (const late of [false, true]) {
      const events = [], offs = ['wrap', 'gap', 'ended'].map((type) => engine.on(type, (e) => events.push([type, e.when ?? e.reason])));
      const {P, G} = await playSegmented(rate);
      clock.advance(0.5);
      const W = engine.nextWrapAt();
      engine.stopAt(W);
      if (late) {
        vi.clearAllTimers();
        engine.ctx._advanceTo(W + 3 * (P + G));
        engine._tick();
      } else advanceTo(W + G + 1);
      expect(events).toEqual([['wrap', expect.closeTo(W, 9)], ['ended', 'stopAt']]);
      for (const off of offs) off();
    }
  });

  test('a count-in before a segmented loop holds the stems until the first pass', async () => {
    engine.setLoop(true, 10, 14, {gapSec: 2});
    engine.seek(10);
    await engine.play({countIn: {duration: 2, beats: []}});
    const L = engine.lookahead, start = L + 2 / rate, until = start + 4 / rate;
    expect(engine.plan[0]).toMatchObject({kind: 'pass', when: start, offset: 10});
    expect(engine.master.gain.valueAt(L + 1)).toBe(0);
    expectAudibleAt(path, start + 0.1, 10 + 0.1 * rate);
    expectSilentAt(until + 1);
  });
});
