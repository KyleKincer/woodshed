// @vitest-environment node
import { beforeEach, expect, test, vi } from 'vitest';
vi.mock('signalsmith-stretch', () => ({default: vi.fn()}));
import SignalsmithStretch from 'signalsmith-stretch';
vi.mock('../src/js/stemcache.js', () => ({fetchStem:vi.fn(async()=>new ArrayBuffer(0))}));
import { MultitrackEngine } from '../src/js/engine.js';
import { buildBarIndex, barPosition } from '../src/js/musical-position.js';
let engine;
beforeEach(() => {
  const param = () => ({cancelScheduledValues:vi.fn(), setValueAtTime:vi.fn(), setTargetAtTime:vi.fn()});
  globalThis.AudioContext = class {
    currentTime = 0; state = 'running'; sampleRate=48000;
    createGain() { return {gain:param(), connect:vi.fn(target=>target), disconnect:vi.fn()}; }
    createChannelSplitter() { return {connect:vi.fn(),disconnect:vi.fn()}; }
    createChannelMerger() { return {connect:vi.fn(),disconnect:vi.fn()}; }
    createBufferSource() { return {playbackRate:param(),connect:vi.fn(),disconnect:vi.fn(),start:vi.fn(),stop:vi.fn()}; }
    close = vi.fn().mockResolvedValue();
  };
  engine = new MultitrackEngine();
  engine.duration = 100;
  engine.loop.b = 100;
  engine.stretch = {schedule:vi.fn(),stop:vi.fn()};
  engine.pitchGate = engine.ctx.createGain();
  engine.tracks = ['drums', 'bass'].map(name => ({name,buffer:{},nativeSources:new Set(),gain:engine.ctx.createGain()}));
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
  expect(engine.stretch.schedule.mock.lastCall[0]).toMatchObject({rate:0.5,loopStart:0,loopEnd:0});
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
  expect(engine.stretch.schedule.mock.lastCall[0]).toMatchObject({rate:0.5,semitones:0});
  engine.setPreservePitch(false);
  expect(engine.stretch.schedule.mock.lastCall[0]).toMatchObject({rate:0.5,active:false});
  engine.setSpeed(1);
  expect(engine.stretch.schedule.mock.lastCall[0]).toMatchObject({rate:1,active:false});
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

test('normal speed bypasses DSP with sample-locked original buffers and no processed tail', async () => {
  engine.seek(10); await engine.play();
  const entries=engine.tracks.map(track=>[...track.nativeSources][0]);
  expect(entries[0].source.start.mock.calls).toEqual(entries[1].source.start.mock.calls);
  entries.forEach((entry,i)=>expect(entry.source.buffer).toBe(engine.tracks[i].buffer));
  expect(engine.stretch.schedule.mock.lastCall[0].active).toBe(false);
  expect(engine.pitchGate.gain.setValueAtTime.mock.lastCall[0]).toBe(0);
  settle();engine.setSpeed(0.75);
  expect(engine.stretch.schedule.mock.lastCall[0].active).toBe(true);
  expect(entries[0].source.stop.mock.lastCall[0]).toBeCloseTo(engine.ctx.currentTime+engine.lookahead);
  settle();engine.setSpeed(1);
  expect(engine.stretch.schedule.mock.lastCall[0].active).toBe(false);
  expect(engine.pitchGate.gain.setValueAtTime.mock.lastCall[0]).toBe(0);
  const newest=engine.tracks.map(track=>[...track.nativeSources].at(-1));
  expect(newest[0].source.start.mock.calls).toEqual(newest[1].source.start.mock.calls);
});
test('pausing during a pending seek retains the requested destination', async () => {
  await engine.play();settle();advance(1);engine.seek(42);engine.pause();
  expect(engine.getPosition()).toBe(42);
});

test('loading creates one discrete phase-linked processor with separate stereo routes for each stem', async () => {
  const data=Float32Array.from({length:64},(_,i)=>i/64);
  engine.ctx.decodeAudioData=async()=>({duration:64/48000,length:64,numberOfChannels:1,getChannelData:()=>data});
  const node={connect:vi.fn(target=>target),addBuffers:vi.fn(async()=>{}),latency:vi.fn(async()=>0.1)};
  SignalsmithStretch.mockResolvedValue(node);
  await engine.loadStems([{name:'drums',key:'load-a',url:'a'},{name:'bass',key:'load-b',url:'b'}]);
  expect(SignalsmithStretch).toHaveBeenCalledTimes(1);
  expect(SignalsmithStretch.mock.lastCall[1]).toMatchObject({outputChannelCount:[4],channelInterpretation:'discrete'});
  expect(node.addBuffers.mock.lastCall[0]).toHaveLength(4);
  expect(engine.pitchGate.channelCount).toBe(4);
  expect(engine.pitchGate.gain.value).toBe(0);
  expect(engine.splitter.connect.mock.calls).toEqual([
    [engine.tracks[0].merger,0,0],[engine.tracks[0].merger,1,1],
    [engine.tracks[1].merger,2,0],[engine.tracks[1].merger,3,1],
  ]);
});
