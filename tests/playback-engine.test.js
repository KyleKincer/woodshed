// @vitest-environment node
import { beforeEach, expect, test, vi } from 'vitest';
vi.mock('signalsmith-stretch', () => ({default: vi.fn()}));
import { MultitrackEngine } from '../src/js/engine.js';
import { buildBarIndex, barPosition } from '../src/js/musical-position.js';
let engine;
beforeEach(() => {
  const param = () => ({cancelScheduledValues:vi.fn(), setValueAtTime:vi.fn(), setTargetAtTime:vi.fn()});
  globalThis.AudioContext = class {
    currentTime = 0; state = 'running';
    createGain() { return {gain:param(), connect:vi.fn(), disconnect:vi.fn()}; }
    close = vi.fn().mockResolvedValue();
  };
  engine = new MultitrackEngine();
  engine.duration = 100;
  engine.loop.b = 100;
  engine.tracks = ['drums', 'bass'].map(name => ({name, source:{schedule:vi.fn(),stop:vi.fn()},gain:engine.ctx.createGain()}));
});
function advance(seconds) { engine.ctx.currentTime += seconds; }
function settle() { advance(engine.lookahead); }
test('disabling a loop after many passes continues from the audible position', async () => {
  engine.setLoop(true, 10, 12); engine.seek(10); await engine.play(); settle();
  advance(201.25); expect(engine.getPosition()).toBeCloseTo(11.25);
  engine.setLoop(false);
  expect(engine.getPosition()).toBeCloseTo(11.25);
  settle(); expect(engine.getPosition()).toBeCloseTo(11.3);
  advance(2); expect(engine.getPosition()).toBeCloseTo(13.3);
  engine.tickEnd(); expect(engine.playing).toBe(true);
});
test('speed changes, clearing and editing loops stay on the same timeline as every stem', async () => {
  engine.setLoop(true, 4, 6); engine.seek(4); await engine.play(); settle(); advance(50.5);
  engine.setSpeed(0.5); settle(); expect(engine.getPosition()).toBeCloseTo(4.55);
  advance(1); expect(engine.getPosition()).toBeCloseTo(5.05);
  engine.setLoop(true, 1, 2); settle(); expect(engine.getPosition()).toBeCloseTo(1);
  advance(3); expect(engine.getPosition()).toBeCloseTo(1.5);
  engine.setLoop(false, 0, 100); settle(); expect(engine.getPosition()).toBeCloseTo(1.525);
  expect(engine.tracks[0].source.schedule.mock.calls).toEqual(engine.tracks[1].source.schedule.mock.calls);
});
test('pre-roll never moves backwards and a pending seek survives rapid rate and pitch changes', async () => {
  engine.seek(20); await engine.play(); expect(engine.getPosition()).toBe(20);
  engine.setSpeed(0.75); engine.setPreservePitch(false); settle();
  expect(engine.getPosition()).toBe(20);
  engine.seek(40); engine.setSpeed(1.5); settle();
  expect(engine.getPosition()).toBe(40);
  advance(1); expect(engine.getPosition()).toBeCloseTo(41.5);
  engine.pause(); advance(10); expect(engine.getPosition()).toBeCloseTo(41.5);
  await engine.play(); settle(); expect(engine.getPosition()).toBeCloseTo(41.5);
});
test('pitch is preserved by default, with explicit varispeed and normal speed reset', async () => {
  engine.setSpeed(0.5); await engine.play();
  expect(engine.tracks[0].source.schedule.mock.lastCall[0]).toMatchObject({rate:0.5,semitones:0});
  engine.setPreservePitch(false);
  expect(engine.tracks[0].source.schedule.mock.lastCall[0]).toMatchObject({rate:0.5,semitones:-12});
  engine.setSpeed(1);
  expect(engine.tracks[0].source.schedule.mock.lastCall[0]).toMatchObject({rate:1,semitones:0});
});
test('seeking to the loop end wraps, seeking before A plays the lead-in, invalid loops disable', async () => {
  engine.setLoop(true, 10, 12); engine.seek(12); expect(engine.getPosition()).toBe(10);
  engine.seek(2); await engine.play(); settle(); expect(engine.getPosition()).toBe(2);
  advance(11); expect(engine.getPosition()).toBeCloseTo(11);
  engine.setLoop(true, 30, 20); expect(engine.loop.enabled).toBe(false);
  engine.setSpeed(NaN); expect(engine.rate).toBe(1);
});
test('natural end stays at the end and replay starts at zero', async () => {
  engine.seek(99); await engine.play(); settle(); advance(1);
  engine.onEnded = vi.fn(); engine.tickEnd(); engine.tickEnd();
  expect(engine.getPosition()).toBe(100); expect(engine.onEnded).toHaveBeenCalledTimes(1);
  await engine.play(); expect(engine.getPosition()).toBe(0);
});
test('an async resume cannot restart playback after pause', async () => {
  engine.ctx.state = 'suspended'; let resume;
  engine.ctx.resume = () => new Promise(resolve => { resume = resolve; });
  const playing = engine.play(); engine.pause(); resume(); await playing;
  expect(engine.playing).toBe(false);
});
test('metronome schedules the loop downbeat and follows pending rate changes', async () => {
  engine.setLoop(true, 1, 2); engine.seek(1.95); await engine.play(); settle();
  const beats = [{time:1,downbeat:true},{time:1.5,downbeat:false}];
  const events = engine.beatsBetween(engine.ctx.currentTime, engine.ctx.currentTime + 0.2, beats);
  expect(events).toHaveLength(1); expect(events[0].when).toBeCloseTo(0.1);
  engine.setSpeed(0.5); settle(); advance(0.9);
  expect(engine.beatsBetween(engine.ctx.currentTime, engine.ctx.currentTime + 0.2, beats)[0].when).toBeCloseTo(1.1);
});
test('bar progress follows irregular detected downbeats, pickups, and partial final bars', () => {
  const index = buildBarIndex([{time:0,downbeat:false},{time:1,downbeat:true},{time:1.5,downbeat:false},{time:2,downbeat:false},{time:2.5,downbeat:true},{time:3,downbeat:false}]);
  expect(index.total).toBe(2);
  expect(barPosition(index, 0.2)).toMatchObject({bar:0});
  expect(barPosition(index, 2)).toMatchObject({bar:1,beat:3});
  expect(barPosition(index, 2.5)).toMatchObject({bar:2,beat:1});
  expect(barPosition(index, 10)).toMatchObject({bar:2,beat:2});
});
