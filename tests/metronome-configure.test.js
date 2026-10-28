// @vitest-environment node
// The metronome's click settings and count-in (architecture §5.2, D14, D51;
// §5.4 item 13): `configure` and its truth table, `countInPlanAt`, the
// visual click (`onBeat`), `clickAt`, `serialize() → {songMap}`, and the
// metronome running by itself while the engine plays.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => (await import('./helpers/fake-audio.js')).fakeStemcache);
import {MultitrackEngine} from '../src/js/engine.js';
import {Metronome, CLICK_MODES} from '../src/js/metronome.js';
import {SongMapStore} from '../src/js/song-map.js';
import {defaultSongMap} from '../shared/song-map.ts';
import {FAKE_TIMERS, createClock, installFakeAudio, loadFakeStems} from './helpers/fake-audio.js';
import {mapStore, sectioned, sevenEight} from './fixtures/maps.js';

let engine, clock, restore, metro, beats;
async function setup(fixture = sectioned, {store = mapStore(fixture)} = {}) {
  vi.useFakeTimers(FAKE_TIMERS);
  restore = installFakeAudio();
  clock = createClock();
  engine = new MultitrackEngine();
  await loadFakeStems(engine, ['drums', 'bass'], {duration: fixture.duration});
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
/** Clicks that will sound: started, and not cancelled before their start. */
const sounding = () => engine.ctx.oscillators.filter((o) => o.startTime != null && o.playsAt(o.startTime));
const times = (list) => list.map((o) => o.startTime);
const clickVolume = (osc) => osc.outputs[0].target.gain.calls.find(([name]) => name === 'exponentialRampToValueAtTime')[1];

/** What the transport does on Play (§2.14.3 rule 2): a count-in only when count-in is on. */
async function playFrom(t) {
  engine.seek(t);
  await engine.play(metro.countIn ? {countIn: metro.countInPlanAt(t)} : {});
}

describe('configure: the D14 truth table', () => {
  beforeEach(() => setup());

  // sectioned: 4/4 at 120 bpm, so a one-bar count is four beats over 2 s.
  test.each([
    {countIn: false, mode: 'off', count: 0, countAudible: 0, clicks: false},
    {countIn: false, mode: 'countin', count: 0, countAudible: 0, clicks: false},
    {countIn: false, mode: 'always', count: 0, countAudible: 0, clicks: true},
    {countIn: true, mode: 'off', count: 4, countAudible: 0, clicks: false},
    {countIn: true, mode: 'countin', count: 4, countAudible: 4, clicks: false},
    {countIn: true, mode: 'always', count: 4, countAudible: 4, clicks: true},
  ])('count-in $countIn, mode $mode', async ({countIn, mode, count, countAudible, clicks}) => {
    expect(metro.configure({countIn, mode})).toMatchObject({countIn, mode});
    expect(metro.enabled).toBe(mode === 'always');
    expect(metro.countInAudible).toBe(mode !== 'off');
    await playFrom(20);
    clock.advance(4);
    const counted = beats.filter((b) => b.kind === 'count');
    expect(counted).toHaveLength(count);
    expect(counted.filter((b) => b.audible)).toHaveLength(countAudible);
    const L = engine.lookahead;
    expect(counted.map((b) => b.when)).toEqual([0, 0.5, 1, 1.5].slice(0, count).map((o) => expect.closeTo(L + o, 9)));
    const start = L + (countIn ? 2 : 0);
    const continuous = beats.filter((b) => b.kind === 'click');
    if (clicks) {
      expect(continuous.length).toBeGreaterThanOrEqual(3);
      expect(continuous[0].when).toBeCloseTo(start, 9);
      expect(continuous.every((b) => b.audible)).toBe(true);
    } else expect(continuous).toEqual([]);
    expect(sounding()).toHaveLength(countAudible + continuous.length);
    // A silent count still drives the lamps, and nothing sounds once it ends.
    expect(sounding().filter((o) => o.startTime < start - 1e-9)).toHaveLength(countAudible);
  });

  test('every mode is listed; settings() mirrors configure, partial updates keep the rest', () => {
    expect(CLICK_MODES).toEqual(['off', 'countin', 'always']);
    expect(metro.settings()).toEqual({countIn: false, countInLength: 1, countInUnit: 'bars', mode: 'countin', accent: true, volume: 0.7, audiblePreRoll: false});
    metro.configure({countIn: true, countInLength: 2, countInUnit: 'beats', mode: 'always', accent: false, volume: 0.4, audiblePreRoll: true});
    metro.configure({volume: 0.5});
    expect(metro.settings()).toEqual({countIn: true, countInLength: 2, countInUnit: 'beats', mode: 'always', accent: false, volume: 0.5, audiblePreRoll: true});
    metro.configure({mode: 'loud', countInLength: 40, countInUnit: 'quarters', volume: 3});
    expect(metro.settings()).toMatchObject({mode: 'always', countInLength: 16, countInUnit: 'bars', volume: 1});
    metro.configure({countInLength: 0, volume: -1});
    expect(metro.settings()).toMatchObject({countInLength: 1, volume: 0});
  });

  test('the 1.9 setters go through configure and notify onChange', () => {
    const changed = vi.fn();
    metro.onChange = changed;
    metro.configure({mode: 'off'});
    metro.setEnabled(true);
    expect([metro.mode, metro.enabled]).toEqual(['always', true]);
    metro.setEnabled(false);
    expect([metro.mode, metro.enabled, metro.countInAudible]).toEqual(['off', false, false]);
    metro.setCountIn(true); metro.setCountInLength(3); metro.setCountInUnit('beats');
    metro.setAudiblePreRoll(true); metro.setAccent(false); metro.setVolume(0.25);
    expect(metro.settings()).toEqual({countIn: true, countInLength: 3, countInUnit: 'beats', mode: 'off', accent: false, volume: 0.25, audiblePreRoll: true});
    expect(changed).toHaveBeenCalledTimes(8);
  });
});

describe('the visual click and settings while playing', () => {
  beforeEach(() => setup());

  test('a silent count emits onBeat with each beat and its lamp unit, and schedules no oscillator', async () => {
    metro.configure({countIn: true, countInLength: 2, mode: 'off'});
    await playFrom(21);
    clock.advance(4.5);
    const L = engine.lookahead;
    // Two bars before 21 s (beat 3 of a bar starting at 20 s): beats from 17 s.
    expect(beats).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((o, i) => ({
      when: expect.closeTo(L + o, 9), downbeat: i === 2 || i === 6, unit: (i + 2) % 4, kind: 'count', audible: false,
    })));
    expect(engine.ctx.oscillators).toEqual([]);
  });

  test('lamp units follow the meter groups (7/8 as 2+2+3)', async () => {
    metro.destroy(); engine.destroy(); restore();
    await setup(sevenEight);
    metro.configure({mode: 'always'});
    await playFrom(0);
    clock.advance(1.8);
    expect(beats.slice(0, 4).map((b) => [b.unit, b.downbeat])).toEqual([[0, true], [2, false], [4, false], [0, true]]);
    expect(beats[3].when).toBeCloseTo(engine.lookahead + 1.75, 9);
  });

  test('a change of mode, accent or volume applies to the clicks not yet sounded; the count carries on', async () => {
    metro.configure({countIn: true, countInLength: 2, mode: 'countin'});
    await playFrom(20);
    clock.advance(1);
    expect(engine.countingIn).toBe(true);
    const ahead = sounding().filter((o) => o.startTime > now());
    expect(ahead.length).toBeGreaterThan(0);
    metro.configure({volume: 0.2, accent: false});
    for (const osc of ahead) expect(osc.playsAt(osc.startTime)).toBe(false);
    const replaced = sounding().filter((o) => o.startTime > now());
    expect(replaced.map((o) => o.startTime)).toEqual(ahead.map((o) => o.startTime));
    for (const osc of replaced) { expect(clickVolume(osc)).toBeCloseTo(0.16, 9); expect(osc.frequency.value).toBe(1050); }
    metro.configure({mode: 'off'});
    clock.advance(3.2);
    expect(engine.countingIn).toBe(false);
    expect(engine.playing).toBe(true);
    expect(sounding().filter((o) => o.startTime > engine.lookahead + 1.1)).toEqual([]);
    expect(beats.filter((b) => b.kind === 'count')).toHaveLength(8);
  });

  test('the metronome runs by itself while the engine plays and needs no timer while stopped', async () => {
    metro.configure({mode: 'always'});
    expect(vi.getTimerCount()).toBe(0);
    await playFrom(10);
    clock.advance(1);
    expect(sounding().length).toBeGreaterThanOrEqual(2);
    engine.pause();
    clock.advance(0.1);
    expect(vi.getTimerCount()).toBe(0);
    await engine.play();
    const before = sounding().length;
    clock.advance(1);
    expect(sounding().length).toBeGreaterThan(before);
    metro.configure({mode: 'countin'});
    expect(sounding().filter((o) => o.startTime > now())).toEqual([]);
    engine.pause();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a count the engine plays clicks through the aux bus while the stems wait; pause cancels it at once', async () => {
    // The transport decides on the count (rule 2); the metronome clicks whatever count the engine plays.
    expect(metro.countIn).toBe(false);
    engine.seek(20);
    await engine.play({countIn: metro.countInPlanAt(20)});
    clock.advance(0.6);
    expect(engine.master.gain.valueAt(0.5)).toBe(0);
    expect(engine.aux.gain.valueAt(0.5)).toBe(1);
    expect(times(sounding())).toEqual([0, 0.5].map((o) => expect.closeTo(engine.lookahead + o, 9)));
    clock.advance(0.4);
    const ahead = sounding().filter((o) => o.startTime > now());
    expect(ahead).toHaveLength(1);
    engine.pause();
    const t = now();
    expect(ahead[0].playsAt(ahead[0].startTime)).toBe(false);
    expect(engine.aux.gain.valueAt(t)).toBe(0);
    expect(engine.aux.gain.valueAt(t + 0.1)).toBe(1);
    clock.advance(3);
    expect(sounding().filter((o) => o.startTime >= t)).toEqual([]);
  });

  test('clickAt sounds through the aux bus and survives every cancellation', async () => {
    metro.configure({mode: 'always'});
    await playFrom(10);
    metro.clickAt(now() + 0.3, true);
    const calibration = engine.ctx.oscillators.at(-1);
    engine.pause();
    metro.tick();
    expect(calibration.playsAt(calibration.startTime)).toBe(true);
    expect(calibration.frequency.value).toBe(1600);
    expect(calibration.outputs[0].target.outputs[0].target).toBe(metro.out);
    expect(metro.out.connectedTo(engine.aux)).toBe(true);
    // While stopped the aux bus reopens after 50 ms, so the click is heard.
    expect(engine.aux.gain.valueAt(calibration.startTime)).toBe(1);
  });

  test('a map edit never pauses a count; a label edit leaves the scheduled clicks, a tempo edit moves them', async () => {
    metro.configure({countIn: true, mode: 'always'});
    await playFrom(20);
    clock.advance(1.1);
    sectionedEdit((d) => { d.tailQpm = 100; }, 'tempo');
    expect([engine.playing, engine.countingIn]).toEqual([true, true]);
    // 100 bpm from 0: the beat at 21 s sounds at 2.05 + 1 s.
    clock.advance(1.9);
    const ahead = sounding().filter((o) => o.startTime > now());
    expect(ahead.length).toBeGreaterThan(0);
    sectionedEdit((d) => { d.measures[12].label = 'Hook'; }, 'label');
    for (const osc of ahead) expect(osc.playsAt(osc.startTime)).toBe(true);
    sectionedEdit((d) => { d.tailQpm = 140; }, 'tempo');
    for (const osc of ahead) expect(osc.playsAt(osc.startTime)).toBe(false);
    const position = (t) => engine.getPositionAt(t);
    const rescheduled = sounding().filter((o) => o.startTime > now());
    expect(rescheduled.length).toBeGreaterThan(0);
    // Each new click lands on a beat of the edited map (140 bpm from 0: every 60/140 s).
    for (const osc of rescheduled) expect((position(osc.startTime) / (60 / 140)) % 1).toBeCloseTo(0, 6);
  });
});

function sectionedEdit(change, reason) { metro.songMap.edit(change, reason); }

describe('countInPlanAt', () => {
  test('bars and beats of the meter at the target, read-only and cached per target, length, unit and map', async () => {
    await setup(sectioned);
    metro.configure({countInLength: 1});
    const plan = metro.countInPlanAt(20);
    expect(plan).toEqual({duration: 2, beats: [0, 0.5, 1, 1.5].map((offset, i) => ({offset, downbeat: i === 0, unit: i}))});
    expect(Object.isFrozen(plan) && Object.isFrozen(plan.beats) && Object.isFrozen(plan.beats[0])).toBe(true);
    expect(metro.countInPlanAt(20)).toBe(plan);
    metro.configure({countInLength: 2});
    expect(metro.countInPlanAt(20).duration).toBe(4);
    metro.configure({countInUnit: 'beats'});
    expect(metro.countInPlanAt(20).duration).toBe(1);
    metro.configure({countInLength: 1, countInUnit: 'bars'});
    expect(metro.countInPlanAt(20)).toBe(plan);
    metro.songMap.edit((d) => { d.tailQpm = 60; }, 'tempo');
    expect(metro.countInPlanAt(20)).not.toBe(plan);
    expect(metro.countInPlanAt(20).duration).toBeCloseTo(4, 9);
  });

  test('the plan is computed at the target, never from the engine position', async () => {
    await setup(sectioned);
    metro.configure({countInLength: 1});
    engine.seek(40);
    const at21 = metro.countInPlanAt(21);
    // From beat 3 of bar 11 (20 s), the bar line falls on the third count beat.
    expect(at21.beats.map((b) => b.downbeat)).toEqual([false, false, true, false]);
    expect(at21).not.toEqual(metro.countInPlanAt(engine.getPosition()));
    engine.seek(3);
    expect(metro.countInPlanAt(21)).toBe(at21);
    // A start at or after the end counts in to the song start.
    expect(metro.countInPlanAt(500)).toBe(metro.countInPlanAt(0));
    expect(metro.countInPlanAt(0)).toEqual({duration: 2, beats: [0, 0.5, 1, 1.5].map((offset, i) => ({offset, downbeat: i === 0, unit: i}))});
  });

  // The 1.9 count-in behaviours, now at an explicit target.
  test('a legacy section map: 3/4 at 120 bpm counts three beats', async () => {
    await setup(sectioned, {store: new SongMapStore(defaultSongMap(100), 100)});
    metro.load({countIn: true, map: [{t: 0, bpm: 120, beatsPerBar: 3, unit: 4}]});
    expect(metro.countInPlanAt(0)).toEqual({duration: 1.5, beats: [{offset: 0, downbeat: true, unit: 0}, {offset: 0.5, downbeat: false, unit: 1}, {offset: 1, downbeat: false, unit: 2}]});
    // load() reads only the map: the old click fields stay in practice (D51).
    expect(metro.countIn).toBe(false);
  });

  test('detected beats: the end uses the final local tempo and meter; tempo changes extrapolate', async () => {
    await setup(sectioned, {store: new SongMapStore(defaultSongMap(100), 100)});
    metro.setDetected([[1, 1], [1.5, 2], [2, 3], [2.5, 1], [2.75, 2], [3, 3], [3.25, 1], [3.5, 2], [3.75, 3]]);
    expect(metro.countInPlanAt(3.8).duration).toBe(0.75);
    metro.setDetected([[0, 1], [0.5, 2], [1, 3], [1.5, 1], [2.5, 2], [3.5, 3], [4.5, 1]]);
    metro.configure({countInUnit: 'beats', countInLength: 4});
    expect(metro.countInPlanAt(4.5).duration).toBe(3.5);
    expect(metro.countInPlanAt(10.5).beats).toHaveLength(4);
  });
});

describe('serialisation (D51)', () => {
  test('serialize() is the map only; load() reads only the map', async () => {
    await setup(sectioned);
    metro.configure({countIn: true, countInLength: 3, mode: 'always', accent: false});
    const saved = metro.serialize();
    expect(Object.keys(saved)).toEqual(['songMap']);
    expect(saved.songMap).toEqual(metro.songMap.serialize());
    const other = new Metronome(engine, new SongMapStore(defaultSongMap(128), 128));
    other.load({...saved, countIn: true, enabled: true, accent: false, volume: 0.1, countInLength: 4, source: 'detected', detected: [], map: []});
    expect(other.settings()).toEqual({countIn: false, countInLength: 1, countInUnit: 'bars', mode: 'countin', accent: true, volume: 0.7, audiblePreRoll: false});
    expect(other.songMap.serialize()).toEqual(saved.songMap);
    other.destroy();
  });
});
