// @vitest-environment node
// The engine's plan model, ticker events and scheduled changes (architecture
// §5.0, §5.1, §5.4 items 1–3 and 7–12), on both playback paths: native
// sources (keep-pitch off) and the Signalsmith processor (keep-pitch on,
// rate ≠ 1). "Audible" assertions read what each path would render: the
// native sources playing at a time, or the processor's time map, plus the gate.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => (await import('./helpers/fake-audio.js')).fakeStemcache);
import {MultitrackEngine, MIN_RATE} from '../src/js/engine.js';
import {Metronome} from '../src/js/metronome.js';
import {SongMapStore} from '../src/js/song-map.js';
import {defaultSongMap} from '../shared/song-map.ts';
import {FAKE_TIMERS, createClock, installFakeAudio, loadFakeStems, scheduleTimeMap, timeMapInputAt} from './helpers/fake-audio.js';
// The 1.9 player's no-store placeholder map clicked; I1 deleted it, so these tests pass a real 120 qpm map.
const clickingMap = (engine) => new SongMapStore({...defaultSongMap(engine.duration), origin: 'edited'}, engine.duration);

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

/** What both paths would render at audio time `t` (t ≥ now). */
function audible(t) {
  const sources = engine.tracks.map((track) => engine.ctx.sources.filter((s) => s.buffer === track.buffer && s.playsAt(t)));
  return {gate: engine.pitchGate.gain.valueAt(t), native: sources.map((list) => list.map((s) => s.mediaAt(t))), processed: engine.stretch.inputAt(t)};
}

function expectAudibleAt(path, t, position) {
  expect(engine.getPositionAt(t)).toBeCloseTo(position, 6);
  const heard = audible(t);
  if (path === 'native') {
    expect(heard.gate).toBe(0);
    for (const list of heard.native) { expect(list).toHaveLength(1); expect(list[0]).toBeCloseTo(position, 6); }
  } else {
    expect(heard.gate).toBe(1);
    for (const list of heard.native) expect(list).toHaveLength(0);
    expect(heard.processed).toBeCloseTo(position, 6);
  }
}

async function playLoop(rate, {a = 10, b = 14, from = a, after = 1} = {}) {
  engine.setLoop(true, a, b);
  engine.seek(from);
  await engine.play();
  clock.advance(after);
  return {L: engine.lookahead, start: engine.lookahead, rate};
}

describe.each(PATHS)('$path path', ({path, rate, preservePitch}) => {
  beforeEach(() => setup({rate, preservePitch}));

  test('wrap fires once per pass at its exact audio time, the lead-in first at its arrival at b', async () => {
    const wraps = [];
    engine.on('wrap', (w) => wraps.push({...w, heardAt: now()}));
    await playLoop(rate, {from: 6, after: 0});
    const L = engine.lookahead, first = L + (14 - 6) / rate, period = 4 / rate;
    expectAudibleAt(path, first - 0.01, 14 - 0.01 * rate);
    expectAudibleAt(path, first + 0.01, 10 + 0.01 * rate);
    expectAudibleAt(path, first + period + 0.02, 10 + 0.02 * rate);
    clock.advance(30);
    engine._tick(); engine._tick();
    const expected = [];
    for (let n = 1; first + (n - 1) * period <= now(); n++) expected.push(first + (n - 1) * period);
    expect(expected.length).toBeGreaterThanOrEqual(4);
    expect(wraps.map((w) => w.when)).toEqual(expected.map((t) => expect.closeTo(t, 9)));
    wraps.forEach((w, i) => {
      expect(w).toMatchObject({a: 10, b: 14, pass: i + 1});
      expect(w.heardAt - w.when).toBeGreaterThanOrEqual(0);
      expect(w.heardAt - w.when).toBeLessThan(0.025 + 1e-9);
    });
  });

  test('a late tick (a throttled tab) emits every missed wrap once, in order, with exact times', async () => {
    const wraps = [];
    engine.on('wrap', (w) => wraps.push(w.when));
    await playLoop(rate, {after: 0.1});
    const W = engine.nextWrapAt(), P = 4 / rate;
    vi.clearAllTimers();
    engine.ctx._advanceTo(W + 2.5 * P);
    engine._tick();
    engine._tick();
    expect(wraps).toEqual([W, W + P, W + 2 * P].map((t) => expect.closeTo(t, 9)));
  });

  test('nextWrapAt and whenAt follow a scheduled rate change, a pending seek and a loop disable', async () => {
    const {L} = await playLoop(rate);
    const first = L + 4 / rate;
    expect(engine.nextWrapAt()).toBeCloseTo(first, 9);
    // 10.1 is already behind (the position is about 10.76): the next pass reaches it.
    expect(engine.whenAt(10.1)).toBeCloseTo(first + 0.1 / rate, 9);
    expect(engine.whenAt(12)).toBeCloseTo(L + 2 / rate, 9);
    for (const t of [5, 14, 20]) expect(engine.whenAt(t)).toBeNull();
    expect(engine.whenAt(engine.getPosition())).toBe(now());

    engine.setSpeed(1.25, {at: first});
    expect(engine.nextWrapAt()).toBeCloseTo(first, 9);
    expect(engine.whenAt(10.1)).toBeCloseTo(first + 0.1 / 1.25, 9);
    advanceTo(first + 0.01);
    expect(engine.nextWrapAt()).toBeCloseTo(first + 4 / 1.25, 9);

    const w = now() + 0.5;
    engine.seekAt(30, w, {loop: {enabled: false}});
    expect(engine.nextWrapAt()).toBeNull();
    expect(engine.whenAt(31)).toBeCloseTo(w + 1 / 1.25, 9);
    expect(engine.whenAt(12)).toBeNull();
    engine.cancelPending();
    expect(engine.nextWrapAt()).toBeCloseTo(first + 4 / 1.25, 9);

    engine.setLoop(false);
    expect(engine.nextWrapAt()).toBeNull();
    const t0 = now() + L, p0 = engine.getPositionAt(t0);
    expect(engine.whenAt(p0 + 5)).toBeCloseTo(t0 + 5 / 1.25, 9);
    expect(engine.whenAt(101)).toBeNull();
    engine.pause();
    expect(engine.nextWrapAt()).toBeNull();
    expect(engine.whenAt(50)).toBeNull();
  });

  test('setSpeed at the next wrap changes the rate exactly there, as a plan change', async () => {
    const transport = vi.fn(), plans = [], wraps = [];
    engine.subscribeTransport(transport);
    engine.on('plan', (p) => plans.push(p));
    engine.on('wrap', (w) => wraps.push(w));
    await playLoop(rate);
    transport.mockClear();
    const W = engine.nextWrapAt(), revision = engine.revision, version = engine.planVersion;
    engine.setSpeed(1.2, {at: W});
    expect(engine.revision).toBe(revision);
    expect(transport).not.toHaveBeenCalled();
    expect(engine.planVersion).toBe(version + 1);
    expect(plans.at(-1)).toEqual({from: W, version: version + 1});
    expect(engine.rate).toBe(rate);
    expectAudibleAt(path, W - 0.01, 14 - 0.01 * rate);
    expectAudibleAt(path, W + 0.01, 10 + 0.01 * 1.2);
    expectAudibleAt(path, W + 4 / 1.2 + 0.02, 10 + 0.02 * 1.2);
    if (path === 'native') {
      const started = engine.ctx.sources.filter((s) => s.startTime === W);
      expect(started).toHaveLength(2);
      for (const s of started) { expect(s.playbackRate.value).toBe(1.2); expect(s.offset).toBeCloseTo(10, 9); expect(s.loop).toBe(true); }
    } else {
      expect(engine.stretch.schedule.mock.lastCall[0]).toMatchObject({active: true, output: W, rate: 1.2, loopStart: 10, loopEnd: 14, input: expect.closeTo(10, 9)});
    }
    advanceTo(W - 0.02);
    expect(engine.rate).toBe(rate);
    clock.advance(0.05);
    expect(engine.rate).toBe(1.2);
    advanceTo(W + 4 / 1.2 + 0.05);
    expect(wraps.map((w) => w.when)).toEqual([expect.closeTo(W, 9), expect.closeTo(W + 4 / 1.2, 9)]);
    expect(wraps.map((w) => w.pass)).toEqual([1, 1]);
    expect(engine.revision).toBe(revision);
  });

  test('a change scheduled at a wrap starts at a even when the projection lands a hair before b', async () => {
    // With these values the float projection at the wrap is 4.369999999999999.
    const wraps = [];
    engine.on('wrap', (w) => wraps.push(w.when));
    await playLoop(rate, {a: 1, b: 4.37, after: 0.5});
    const W = engine.nextWrapAt();
    engine.setSpeed(1.2, {at: W});
    expect(engine.plan.at(-1)).toMatchObject({when: W, offset: 1, rate: 1.2});
    advanceTo(W + 0.5);
    expect(wraps).toEqual([W]);
    expect(engine.nextWrapAt()).toBeCloseTo(W + 3.37 / 1.2, 9);
  });

  test.each([
    ['an immediate seek', () => engine.seek(11, {cue: false})],
    ['a loop edit', () => engine.setLoop(true, 10, 13.5)],
  ])('%s before a scheduled rate change cancels it without leaking a segment', async (_name, change) => {
    await playLoop(rate);
    const W = engine.nextWrapAt();
    engine.setSpeed(1.2, {at: W});
    change();
    advanceTo(W + 0.2);
    expect(engine.rate).toBe(rate);
    const t = now() + 0.1;
    expectAudibleAt(path, t, engine.getPositionAt(t));
    const leaked = engine.ctx.sources.filter((s) => s.playbackRate.value === 1.2 && (s.stopTime == null || s.stopTime > s.startTime));
    expect(leaked).toEqual([]);
    expect(engine.stretch.timeMap.some((seg) => seg.rate === 1.2)).toBe(false);
  });

  test('seekAt keeps the audible segment until the jump and clears the loop on the pending segment', async () => {
    const {L} = await playLoop(rate);
    const revision = engine.revision, w = now() + 0.6;
    expect(engine.seekAt(40, w, {loop: {enabled: false}})).toBe(w);
    expect(engine.revision).toBe(revision);
    expect(engine.loop).toEqual({enabled: true, a: 10, b: 14});
    expectAudibleAt(path, w - 0.01, 10 + (w - 0.01 - L) * rate);
    expectAudibleAt(path, w + 0.1, 40 + 0.1 * rate);
    advanceTo(w + 0.03);
    expect(engine.loop).toEqual({enabled: false, a: 10, b: 14});
    expect(engine.getPosition()).toBeCloseTo(40 + 0.03 * rate, 6);
    expect(engine.nextWrapAt()).toBeNull();
    // A jump asked for inside the lookahead is still quantized: it lands one lookahead on.
    const at = engine.seekAt(60, now() + 0.001);
    expect(at).toBeCloseTo(now() + L, 9);
    expectAudibleAt(path, at + 0.05, 60 + 0.05 * rate);
  });

  test('cancelPending drops a pending jump: playback and the loop continue and the jump never lands', async () => {
    const {L} = await playLoop(rate);
    const W = engine.nextWrapAt(), w = now() + 0.6;
    engine.seekAt(40, w, {loop: {enabled: false}});
    const revision = engine.revision, version = engine.planVersion, plans = [];
    engine.on('plan', (p) => plans.push(p));
    expect(engine.cancelPending()).toBe(true);
    expect(engine.revision).toBe(revision);
    expect(engine.planVersion).toBe(version + 1);
    expect(plans).toEqual([{from: now() + L, version: version + 1}]);
    expect(engine.nextWrapAt()).toBeCloseTo(W, 9);
    expectAudibleAt(path, w + 0.1, 10 + (w + 0.1 - L) * rate);
    expectAudibleAt(path, W + 0.1, 10 + 0.1 * rate);
    clock.advance(1);
    expect(engine.loop.enabled).toBe(true);
    expect(engine.cancelPending()).toBe(false);
    const position = engine.getPosition();
    engine.pause();
    expect(engine.pausedAt).toBeCloseTo(position, 9);
  });

  test('pausing before a quantized jump keeps the audible position', async () => {
    await playLoop(rate);
    engine.seekAt(40, now() + 0.6);
    const position = engine.getPosition();
    engine.pause();
    expect(engine.pausedAt).toBeCloseTo(position, 9);
  });

  test('stopAt at a wrap ends at b, with stems and clicks silent from that moment', async () => {
    const metronome = new Metronome(engine, clickingMap(engine));
    metronome.setEnabled(true);
    const ended = [], states = [];
    engine.on('ended', (e) => ended.push(e));
    engine.on('state', (s) => states.push(s));
    await playLoop(rate);
    const W = engine.nextWrapAt();
    engine.stopAt(W);
    expect(engine.stopAtWhen).toBe(W);
    for (const bus of [engine.master, engine.aux]) {
      expect(bus.gain.valueAt(W - 1e-3)).toBe(1);
      expect(bus.gain.valueAt(W)).toBe(0);
    }
    expect(metronome.out.connectedTo(engine.aux)).toBe(true);
    expect(metronome.out.connectedTo(engine.ctx.destination)).toBe(false);
    advanceTo(W + 0.2);
    expect(ended).toEqual([{reason: 'stopAt'}]);
    expect(engine.playing).toBe(false);
    expect(engine.paused).toBe(false);
    expect(engine.pausedAt).toBeCloseTo(14, 3);
    expect(states.at(-1)).toEqual({playing: false, counting: false, paused: false});
    const clicks = engine.ctx.oscillators.filter((o) => o.startTime != null);
    expect(clicks.length).toBeGreaterThan(3);
    expect(clicks.filter((o) => o.startTime >= W - 1e-9)).toEqual([]);
    metronome.destroy();
  });

  test('a late tick still honours stopAt with the position at b', async () => {
    const ended = [];
    engine.on('ended', (e) => ended.push(e));
    await playLoop(rate, {after: 0.1});
    const W = engine.nextWrapAt(), P = 4 / rate;
    engine.stopAt(W + 2 * P);
    vi.clearAllTimers();
    engine.ctx._advanceTo(W + 2.5 * P);
    engine._tick();
    expect(ended).toEqual([{reason: 'stopAt'}]);
    expect(engine.pausedAt).toBeCloseTo(14, 3);
  });

  test('a discontinuity clears a pending stopAt', async () => {
    await playLoop(rate);
    const W = engine.nextWrapAt();
    engine.stopAt(W);
    engine.seek(11);
    expect(engine.stopAtWhen).toBeNull();
    expect(engine.master.gain.valueAt(W + 1)).toBe(1);
    expect(engine.aux.gain.valueAt(W + 1)).toBe(1);
    advanceTo(W + 0.5);
    expect(engine.playing).toBe(true);
  });

  test('setTrackGains automates only the auto gains, is not a plan change, and resets on pause', async () => {
    const transport = vi.fn(), plans = vi.fn();
    engine.subscribeTransport(transport);
    engine.on('plan', plans);
    await playLoop(rate, {after: 0.5});
    transport.mockClear();
    const [drums, bass] = engine.tracks;
    expect(drums.gain.connectedTo(drums.auto)).toBe(true);
    expect(drums.auto.connectedTo(engine.master)).toBe(true);
    const revision = engine.revision, version = engine.planVersion, userCalls = drums.gain.gain.calls.length;
    const W = engine.nextWrapAt();
    engine.setTrackGains({drums: 0}, {at: W});
    engine.setTrackGains({});
    engine.setTrackGains({guitar: 1});
    expect(drums.auto.gain.valueAt(W - 1e-3)).toBe(1);
    expect(drums.auto.gain.valueAt(W)).toBe(0);
    expect(bass.auto.gain.events).toEqual([]);
    expect(drums.gain.gain.calls.length).toBe(userCalls);
    expect([engine.revision, engine.planVersion]).toEqual([revision, version]);
    expect(transport).not.toHaveBeenCalled();
    expect(plans).not.toHaveBeenCalled();
    expect(drums.autoGain).toBe(1);
    advanceTo(W + 0.05);
    expect(drums.autoGain).toBe(0);
    engine.setTrackGains({drums: 1}, {at: engine.nextWrapAt()});
    engine.pause();
    expect(drums.auto.gain.valueAt(now())).toBe(1);
    expect(drums.auto.gain.valueAt(now() + 60)).toBe(1);
    expect(drums.autoGain).toBe(1);
  });

  test('an interruption while playing pauses in place and reports it; it never resumes by itself', async () => {
    const events = [];
    engine.on('state', (s) => events.push(['state', s]));
    engine.on('interrupted', (e) => events.push(['interrupted', e]));
    engine.seek(20);
    await engine.play();
    clock.advance(2);
    const position = engine.getPosition();
    engine.ctx.setState('interrupted');
    expect(engine.playing).toBe(false);
    expect(engine.paused).toBe(true);
    expect(engine.getPosition()).toBeCloseTo(position, 9);
    expect(events.slice(-2)).toEqual([['state', {playing: false, counting: false, paused: true}], ['interrupted', {state: 'interrupted'}]]);
    engine.ctx.setState('running');
    clock.advance(1);
    expect(engine.playing).toBe(false);
    await engine.play();
    clock.advance(0.5);
    engine.ctx.setState('suspended');
    expect(events.at(-1)).toEqual(['interrupted', {state: 'suspended'}]);
    events.length = 0;
    engine.ctx.setState('interrupted');
    expect(events).toEqual([]);
    await engine.play();
    expect(engine.ctx.state).toBe('running');
    expect(engine.playing).toBe(true);
  });

  test('E1: 25% is accepted and lower rates clamp to it', async () => {
    expect(MIN_RATE).toBe(0.25);
    engine.setSpeed(0.2);
    expect(engine.rate).toBe(0.25);
    engine.seek(20);
    await engine.play();
    expectAudibleAt(path, engine.lookahead + 1, 20.25);
    if (path === 'native') expect(engine.ctx.sources.at(-1).playbackRate.value).toBe(0.25);
    else expect(engine.stretch.schedule.mock.lastCall[0]).toMatchObject({active: true, rate: 0.25});
    engine.setSpeed(3);
    expect(engine.rate).toBe(1.5);
  });

  test('a scheduled rate change cancels only the clicks at or after it; a discontinuity cancels all', async () => {
    const metronome = new Metronome(engine, clickingMap(engine));
    metronome.setEnabled(true);
    engine.seek(20);
    await engine.play();
    const clickAhead = (min) => {
      for (let i = 0; i < 200; i++) {
        const click = engine.ctx.oscillators.find((o) => o.startTime > now() + min && o.playsAt(o.startTime));
        if (click) return click;
        clock.advance(0.025);
      }
      throw new Error('no click scheduled ahead');
    };
    const plans = [];
    engine.on('plan', (p) => plans.push(p));
    // A change after a scheduled click keeps it.
    let click = clickAhead(engine.lookahead + 0.002);
    engine.setSpeed(1.2, {at: click.startTime + 0.001});
    expect(plans.at(-1).from).toBeCloseTo(click.startTime + 0.001, 9);
    expect(click.playsAt(click.startTime)).toBe(true);
    engine.setSpeed(rate);
    expect(click.playsAt(click.startTime)).toBe(false);
    // A change before a scheduled click cancels it and reschedules the beat at the new rate.
    click = clickAhead(engine.lookahead + 0.002);
    const at = click.startTime - 0.001, beat = engine.getPositionAt(click.startTime);
    engine.setSpeed(1.2, {at});
    expect(click.playsAt(click.startTime)).toBe(false);
    clock.advance(0.025);
    const rescheduled = engine.ctx.oscillators.filter((o) => o.startTime >= at && o.playsAt(o.startTime));
    expect(rescheduled.map((o) => o.startTime)).toContainEqual(expect.closeTo(at + (beat - engine.getPositionAt(at)) / 1.2, 9));
    metronome.destroy();
  });

  test('a loop edit that keeps the position is a plan change; one that moves it is a discontinuity', async () => {
    const {L} = await playLoop(rate);
    const plans = [];
    engine.on('plan', (p) => plans.push(p));
    const revision = engine.revision, version = engine.planVersion;
    const cut = now() + L, at = engine.getPositionAt(cut);
    engine.setLoop(true, 10, 12);
    expect(engine.revision).toBe(revision);
    expect(plans).toEqual([{from: cut, version: version + 1}]);
    expectAudibleAt(path, cut + 0.1, at + 0.1 * rate);
    engine.setLoop(true, 10, 10.5);
    expect(engine.revision).toBe(revision + 1);
    expectAudibleAt(path, now() + L + 0.01, 10 + 0.01 * rate);
    engine.setLoop(false);
    expect(engine.revision).toBe(revision + 1);
    expect(engine.planVersion).toBe(version + 2);
  });

  test('the processor holds one future change; a later one is posted once the earlier one starts', async () => {
    engine.seek(20);
    await engine.play();
    clock.advance(1);
    const w = now() + 0.5, at = now() + 1;
    engine.seekAt(40, w);
    engine.setSpeed(1.2, {at});
    const posts = engine.stretch.schedule.mock.calls.map(([call]) => call.output);
    expect(posts.at(-1)).toBe(w);
    expectAudibleAt(path, w - 0.01, 20 + (w - 0.01 - engine.lookahead) * rate);
    expectAudibleAt(path, w + 0.1, 40 + 0.1 * rate);
    advanceTo(w + 0.03);
    expect(engine.stretch.schedule.mock.lastCall[0]).toMatchObject({output: at, rate: 1.2, input: expect.closeTo(40 + (at - w) * rate, 9)});
    expectAudibleAt(path, at + 0.1, 40 + (at - w) * rate + 0.1 * 1.2);
  });

  test('count-in clicks sound through the aux bus while the stems are held at 0; pause mutes the bus at once', async () => {
    const metronome = new Metronome(engine, clickingMap(engine));
    engine.seek(20);
    await engine.play({countIn: metronome.countInPlanAt(20)});
    metronome.start();
    clock.advance(0.2);
    expect(engine.master.gain.valueAt(0.15)).toBe(0);
    expect(engine.aux.gain.valueAt(0.15)).toBe(1);
    const clicks = engine.ctx.oscillators.filter((o) => o.startTime != null);
    expect(clicks.length).toBeGreaterThan(0);
    expect(metronome.out.connectedTo(engine.aux)).toBe(true);
    clock.advance(0.4);
    engine.pause();
    const t = now();
    expect(engine.aux.gain.valueAt(t)).toBe(0);
    expect(engine.aux.gain.valueAt(t + 0.1)).toBe(1);
    expect(engine.ctx.oscillators.filter((o) => o.startTime >= t && o.playsAt(o.startTime))).toEqual([]);
    metronome.destroy();
  });

  // A change made while a scheduled entry is about to start, or has started but
  // no tick has run yet, builds on what is audible and keeps the user's loop.
  test.each([
    {gap: 0.025, label: 'before it starts'},
    {gap: 0.05, label: 'with a tick between its start and the cut'},
  ])('setLoop inside the lookahead of a scheduled rate change keeps both ($label)', async ({gap}) => {
    engine.seek(10);
    await engine.play();
    clock.advance(1);
    const T = now() + engine.lookahead + 0.015;
    engine.setSpeed(1.2, {at: T});
    clock.advance(gap);
    expect(now() + engine.lookahead).toBeGreaterThan(T);
    engine.setLoop(true, 0, 50);
    clock.advance(0.5);
    expect(engine.rate).toBe(1.2);
    expect(engine.loop).toEqual({enabled: true, a: 0, b: 50});
    // The next immediate change rebuilds from that state.
    engine.seek(30);
    const t = now() + engine.lookahead + 0.05;
    expect(engine.plan.at(-1)).toMatchObject({rate: 1.2, loop: {enabled: true, a: 0, b: 50}});
    expectAudibleAt(path, t, 30 + 0.05 * 1.2);
    expectAudibleAt(path, t + 0.5, 30 + 0.55 * 1.2);
  });

  test('a change after a scheduled rate has started but before the next tick keeps the new rate', async () => {
    await playLoop(rate);
    const W = engine.nextWrapAt();
    engine.setSpeed(1.2, {at: W});
    vi.clearAllTimers();
    engine.ctx._advanceTo(W + 0.01);
    expect(engine.rate).toBe(1.2);
    engine.seek(11, {cue: false});
    const t = now() + engine.lookahead;
    expect(engine.plan.at(-1)).toMatchObject({rate: 1.2, loop: {enabled: true, a: 10, b: 14}});
    expectAudibleAt(path, t + 0.1, 11 + 0.1 * 1.2);
  });

  test('a change after a quantized jump with a loop change has started keeps the jump\'s loop', async () => {
    await playLoop(rate);
    const W = engine.nextWrapAt();
    engine.seekAt(40, W, {loop: {enabled: false}});
    vi.clearAllTimers();
    engine.ctx._advanceTo(W + 0.01);
    engine.setPreservePitch(preservePitch);
    expect(engine.loop.enabled).toBe(false);
    expect(engine.rate).toBe(rate);
    expect(engine.plan.at(-1).loop.enabled).toBe(false);
    const t = now() + engine.lookahead + 0.1;
    expectAudibleAt(path, t, 40 + (t - W) * rate);
  });

  test('a wrap within the tolerance after a tick is emitted once', async () => {
    const wraps = [];
    engine.on('wrap', (w) => wraps.push([w.when, w.pass]));
    await playLoop(rate, {after: 0.1});
    vi.clearAllTimers();
    const W = engine.nextWrapAt();
    engine.ctx._advanceTo(W - 5e-10);
    engine._tick();
    engine.ctx._advanceTo(W + 0.01);
    engine._tick();
    engine.ctx._advanceTo(W + 0.02);
    engine._tick();
    expect(wraps).toEqual([[W, 1]]);
  });

  test('stop() and pause() reset the auto gains even when already stopped', async () => {
    const [drums] = engine.tracks;
    engine.setTrackGains({drums: 0});
    engine.stop();
    expect(drums.autoGain).toBe(1);
    expect(drums.auto.gain.valueAt(now() + 1)).toBe(1);
    engine.setTrackGains({drums: 0});
    engine.pause();
    expect(drums.autoGain).toBe(1);
    expect(drums.auto.gain.valueAt(now() + 1)).toBe(1);
  });
});

describe('events and lifecycle', () => {
  beforeEach(() => setup({rate: 1, preservePitch: true}));

  test('state events report each change of playing, counting and paused once', async () => {
    const states = [];
    engine.on('state', (s) => states.push(s));
    engine.seek(20);
    await engine.play({countIn: {duration: 1, beats: []}});
    clock.advance(1.2);
    engine.pause();
    await engine.play();
    engine.stop();
    expect(states).toEqual([
      {playing: true, counting: true, paused: false},
      {playing: true, counting: false, paused: false},
      {playing: false, counting: false, paused: true},
      {playing: true, counting: false, paused: false},
      {playing: false, counting: false, paused: false},
    ]);
  });

  test('the ticker finds the end of the song and runs only while playing', async () => {
    engine.onEnded = vi.fn();
    const ended = [];
    engine.on('ended', (e) => ended.push(e));
    engine.seek(99);
    expect(vi.getTimerCount()).toBe(0);
    await engine.play();
    expect(vi.getTimerCount()).toBe(1);
    clock.advance(1.2);
    expect(ended).toEqual([{reason: 'end'}]);
    expect(engine.onEnded).toHaveBeenCalledTimes(1);
    expect(engine.getPosition()).toBe(100);
    expect([engine.playing, engine.paused]).toEqual([false, false]);
    expect(vi.getTimerCount()).toBe(0);
    await engine.play();
    expect(engine.getPosition()).toBe(0);
    engine.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('transport events accompany subscribeTransport; on() rejects unknown types and returns off', async () => {
    const legacy = vi.fn(), transport = vi.fn();
    engine.subscribeTransport(legacy);
    const off = engine.on('transport', transport);
    await engine.play();
    engine.seek(30);
    engine.pause();
    expect(transport.mock.calls.map(([e]) => e.revision)).toEqual([1, 2, 4]);
    expect(legacy).toHaveBeenCalledTimes(3);
    off();
    await engine.play();
    expect(transport).toHaveBeenCalledTimes(3);
    expect(() => engine.on('tick', () => {})).toThrow(TypeError);
  });

  test('a failing listener does not stop the ticker or the other listeners', async () => {
    const thrown = [];
    const microtask = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((fn) => { try { fn(); } catch (error) { thrown.push(error); } });
    try {
      const wraps = [];
      engine.on('wrap', () => { throw new Error('listener failed'); });
      engine.on('wrap', (w) => wraps.push(w));
      engine.setLoop(true, 10, 11);
      engine.seek(10);
      await engine.play();
      clock.advance(3.2);
      expect(wraps).toHaveLength(3);
      expect(thrown.map((e) => e.message)).toEqual(['listener failed', 'listener failed', 'listener failed']);
    } finally { microtask.mockRestore(); }
  });

  test('setMuted and setSoloed are idempotent; the toggles remain', () => {
    const [drums] = engine.tracks;
    const calls = () => drums.gain.gain.calls.length;
    let before = calls();
    expect(engine.setMuted('drums', true)).toBe(true);
    expect(calls()).toBe(before + 1);
    before = calls();
    engine.setMuted('drums', true);
    expect(calls()).toBe(before);
    expect(engine.toggleMute('drums')).toBe(false);
    expect(engine.setSoloed('bass', true)).toBe(true);
    expect(drums.gain.gain.valueAt(now() + 1)).toBeCloseTo(0, 6);
    expect(engine.toggleSolo('bass')).toBe(false);
    expect(engine.setMuted('guitar', true)).toBeUndefined();
  });
});

// ---- SignalsmithStretch 1.3.2 time map --------------------------------------

/** The worklet's own `schedule`, taken from the installed library source. */
function librarySchedule() {
  const source = readFileSync(new URL('../node_modules/signalsmith-stretch/SignalsmithStretch.mjs', import.meta.url), 'utf8');
  const head = source.indexOf('schedule: (objIn, adjustPrevious) => {');
  expect(head).toBeGreaterThan(0);
  let end = source.indexOf('{', head), depth = 0;
  const open = end;
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++;
    else if (source[end] === '}' && --depth === 0) break;
  }
  const body = source.slice(open, end + 1).replace(/\bcurrentTime\b/g, 'scope.currentTime');
  const scope = {currentTime: 0, self: {timeMap: [{active: false, input: 0, output: 0, rate: 1, semitones: 0, tonalityHz: 8000, formantSemitones: 0, formantCompensation: false, formantBaseHz: 0, loopStart: 0, loopEnd: 0}],
    timeIntervalSamples: 4800, timeIntervalCounter: 0, port: {postMessage() {}}}};
  // eslint-disable-next-line no-new-func
  const schedule = new Function('scope', `return function () { return (objIn, adjustPrevious) => ${body}; };`)(scope).call(scope.self);
  return {scope, schedule, map: scope.self.timeMap};
}

const shape = (map) => map.map(({active, input, output, rate, loopStart, loopEnd}) => ({active, input, output, rate, loopStart, loopEnd}));

describe('SignalsmithStretch 1.3.2 time map', () => {
  test('the fake keeps the same time map as the library for every post the engine makes', async () => {
    await setup({rate: 0.8, preservePitch: true});
    const log = [];
    const {schedule, stop} = engine.stretch;
    const record = (kind, fn) => fn.getMockImplementation();
    const scheduleImpl = record('schedule', schedule), stopImpl = record('stop', stop);
    schedule.mockImplementation((obj) => { log.push({t: now(), obj: {...obj}}); return scheduleImpl(obj); });
    stop.mockImplementation((when) => { log.push({t: now(), obj: {active: false, output: typeof when === 'number' ? when : now()}}); return stopImpl(when); });
    await playLoop(0.8, {after: 0.4});
    engine.setSpeed(1.2, {at: engine.nextWrapAt()});
    engine.seekAt(40, engine.nextWrapAt() + 1, {loop: {enabled: false}});
    clock.advance(6);
    engine.seekAt(60, now() + 0.4);
    engine.cancelPending();
    engine.setLoop(true, 50, 52);
    clock.advance(1);
    engine.pause();
    await engine.play();
    clock.advance(1);
    expect(log.length).toBeGreaterThanOrEqual(8);
    const real = librarySchedule(), mirror = [{active: false, input: 0, output: 0, rate: 1, semitones: 0, loopStart: 0, loopEnd: 0}];
    for (const {t, obj} of log) {
      // process() drops the segments that ended before the worklet's current time.
      while (real.map.length > 1 && real.map[1].output <= t) real.map.shift();
      real.scope.currentTime = t;
      real.schedule({...obj});
      scheduleTimeMap(mirror, {...obj}, t);
      expect(shape(mirror)).toEqual(shape(real.map));
    }
    for (let t = now(); t < now() + 3; t += 0.1) expect(timeMapInputAt(mirror, t)).toBeCloseTo(timeMapInputAt(real.map, t), 9);
  });

  test('posting a future change with outputTime === output would drop the audible segment (why the engine posts at the cut)', () => {
    const run = (outputTime) => {
      const real = librarySchedule();
      real.scope.currentTime = 0;
      real.schedule({active: true, output: 0, input: 10, rate: 1});
      real.scope.currentTime = 1;
      real.schedule({active: true, output: 5, outputTime, input: 30, rate: 1});
      return [timeMapInputAt(real.map, 2), timeMapInputAt(real.map, 6)];
    };
    expect(run(5)).toEqual([27, 31]);
    expect(run(1)).toEqual([12, 31]);
  });
});
