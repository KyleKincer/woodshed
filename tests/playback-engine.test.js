// @vitest-environment node
import { beforeEach, expect, test, vi } from 'vitest';
vi.mock('signalsmith-stretch', () => ({default: vi.fn()}));
import SignalsmithStretch from 'signalsmith-stretch';
vi.mock('../src/js/stemcache.js', () => ({fetchStem:vi.fn(async()=>new ArrayBuffer(0))}));
import { MultitrackEngine } from '../src/js/engine.js';
import { buildBarIndex, barPosition } from '../src/js/musical-position.js';
import { Metronome } from '../src/js/metronome.js';
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

test('silent count-in schedules playback exactly after its clicks at the current rate', async () => {
  engine.seek(10); engine.setSpeed(0.5);
  await engine.play({countIn:{duration:4,beats:[{offset:0,downbeat:true}]}});
  const start = engine.lookahead, end = start + 8;
  expect(engine.countingIn).toBe(true);
  expect(engine.getPosition()).toBe(10);
  expect(engine.stretch.schedule.mock.lastCall[0]).toMatchObject({input:10,output:end,rate:0.5});
  engine.ctx.currentTime = end;
  expect(engine.countingIn).toBe(false);
  expect(engine.getPosition()).toBe(10);
  advance(2); expect(engine.getPosition()).toBe(11);
});
test('audible pre-roll plays into a loop without changing its boundaries', async () => {
  engine.setLoop(true,10,12); engine.seek(10);
  await engine.play({countIn:{duration:4,beats:[]},audiblePreRoll:true});
  settle(); expect(engine.getPosition()).toBe(6);
  expect([...engine.tracks[0].nativeSources][0].source.start.mock.lastCall).toEqual([engine.lookahead,6]);
  advance(4); expect(engine.getPosition()).toBe(10);
  advance(3); expect(engine.getPosition()).toBe(11);
  expect(engine.loop).toEqual({enabled:true,a:10,b:12});
});
test('pre-roll before song start retains a full count-in with silence for unavailable audio', async () => {
  engine.seek(1);
  await engine.play({countIn:{duration:4,beats:[]},audiblePreRoll:true});
  expect([...engine.tracks[0].nativeSources][0].source.start.mock.lastCall).toEqual([engine.lookahead+3,0]);
  settle(); advance(2); expect(engine.getPosition()).toBe(0);
  advance(2); expect(engine.getPosition()).toBe(1);
});
test('cancel, seek, and speed changes during count-in cannot leave a delayed start armed', async () => {
  engine.seek(10);
  await engine.play({countIn:{duration:4,beats:[]},audiblePreRoll:true});
  settle();advance(1);engine.pause();
  expect(engine.getPosition()).toBe(10);expect(engine.countIn).toBeNull();
  advance(10); expect(engine.playing).toBe(false);
  await engine.play({countIn:{duration:4,beats:[]}}); engine.seek(30);
  expect(engine.playing).toBe(false);expect(engine.getPosition()).toBe(30);
  await engine.play({countIn:{duration:4,beats:[]}});engine.setSpeed(0.75);
  expect(engine.playing).toBe(false);expect(engine.getPosition()).toBe(30);
});
test('count-in supports bars and beats, legacy defaults, and persisted audible pre-roll', () => {
  const metro = new Metronome(engine);
  metro.load({countIn:true,map:[{t:0,bpm:120,beatsPerBar:3,unit:4}]});
  expect(metro.countInPlan()).toEqual({duration:1.5,beats:[{offset:0,downbeat:true},{offset:0.5,downbeat:false},{offset:1,downbeat:false}]});
  expect(metro.audiblePreRoll).toBe(false);
  metro.setCountInLength(2);
  expect(metro.countInPlan().duration).toBe(3);
  metro.setCountInUnit('beats');metro.setAudiblePreRoll(true);
  expect(metro.countInPlan().duration).toBe(1);
  const other = new Metronome(engine);other.load(metro.serialize());
  expect(other.serialize()).toMatchObject({countInLength:2,countInUnit:'beats',audiblePreRoll:true});
  metro.destroy();other.destroy();
});
test('count-in clicks work with the metronome off and stop immediately on cancellation', async () => {
  const metro = new Metronome(engine);
  metro._click = vi.fn();
  await engine.play({countIn:metro.countInPlan()});
  metro.tick();expect(metro._click).toHaveBeenCalledWith(engine.lookahead,true);
  metro.tick();expect(metro._click).toHaveBeenCalledTimes(1);
  const stop = vi.fn();metro._scheduledClicks.add({stop});engine.pause();metro.tick();
  expect(stop).toHaveBeenCalled();
  advance(3);metro.tick();expect(metro._click).toHaveBeenCalledTimes(1);
  metro.destroy();
});
test('detected count-in at the end uses the final local tempo and meter', () => {
  const metro = new Metronome(engine);
  metro.setDetected([[1,1],[1.5,2],[2,3],[2.5,1],[2.75,2],[3,3],[3.25,1],[3.5,2],[3.75,3]]);
  engine.seek(3.8);
  expect(metro.countInPlan().duration).toBe(0.75);
  metro.destroy();
});
test('count-in follows tempo changes and extrapolates clicks beyond a detected grid', () => {
  const metro = new Metronome(engine);
  metro.setDetected([[0,1],[0.5,2],[1,3],[1.5,1],[2.5,2],[3.5,3],[4.5,1]]);
  metro.setCountInUnit('beats');metro.setCountInLength(4);engine.seek(4.5);
  expect(metro.countInPlan().duration).toBe(3.5);
  engine.seek(10.5);
  expect(metro.countInPlan().beats).toHaveLength(4);
  metro.destroy();
});
