// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
vi.mock('signalsmith-stretch', () => ({default: vi.fn()}));
vi.mock('../src/js/stemcache.js', () => ({fetchStem:vi.fn(async()=>new ArrayBuffer(0))}));
import { MultitrackEngine } from '../src/js/engine.js';
import { DrumAudio, VOICES, CHOKES, sample, scoreEvents } from '../src/js/notation/audio.js';
import { KIT, emptyScore, fraction, kitPiece, toTime } from '../shared/notation.ts';

let engine, audio;
beforeEach(() => {
  const param = () => ({value:1, cancelScheduledValues:vi.fn(), setValueAtTime:vi.fn(), setTargetAtTime:vi.fn()});
  globalThis.AudioContext = class {
    currentTime = 0; state = 'running'; sampleRate = 48000; destination = {};
    createGain() { return {gain:param(), connect:vi.fn(target=>target), disconnect:vi.fn()}; }
    createChannelSplitter() { return {connect:vi.fn(),disconnect:vi.fn()}; }
    createChannelMerger() { return {connect:vi.fn(),disconnect:vi.fn()}; }
    createBuffer(_channels, length, sampleRate) { const data = new Float32Array(length); return {length, sampleRate, duration:length/sampleRate, getChannelData:()=>data}; }
    createBufferSource() { return {playbackRate:param(), connect:vi.fn(target=>target), disconnect:vi.fn(), start:vi.fn(), stop:vi.fn()}; }
    close = vi.fn().mockResolvedValue();
  };
  engine = new MultitrackEngine();
  engine.duration = 100; engine.loop.b = 100;
  engine.stretch = {schedule:vi.fn(), stop:vi.fn()};
  engine.pitchGate = engine.ctx.createGain();
  engine.tracks = [{name:'drums', buffer:{}, nativeSources:new Set(), gain:engine.ctx.createGain()}];
  audio = new DrumAudio(engine);
});
afterEach(() => audio.destroy());

const hit = (beats, instrument, extra = {}) => ({id:`${instrument}@${beats}`, offset:fraction(Math.round(beats*96), 96), instrument, voice:kitPiece(instrument).voice, accent:false, ghost:false, flam:false, sticking:'', velocity:.75, ...extra});
function scoreWith(...bars) {
  const score = emptyScore(20, 120);
  score.bars = bars.map((hits, i) => ({measureId:score.timeline.measures[i].id, coverage:'progress', hits}));
  return score;
}
const starts = () => [...audio.active].map(e => [e.instrument, e.when]);

test('every kit piece has a synthesized voice that renders a finite, audible buffer', () => {
  for (const piece of KIT) {
    expect(VOICES[piece.id], piece.id).toBeDefined();
    const data = sample(engine.ctx, piece.id).getChannelData(0);
    expect(data.length, piece.id).toBeGreaterThan(0);
    expect(data.every(Number.isFinite), piece.id).toBe(true);
    const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak, piece.id).toBeGreaterThan(.05); expect(peak, piece.id).toBeLessThan(2);
  }
});

test('kit variants sound different and chokes ring shorter than their cymbal', () => {
  const render = id => sample(engine.ctx, id).getChannelData(0);
  for (const [a, b] of [['crash','crash2'],['crash','splash'],['snare','rimshot'],['rackTom','tom1'],['rideBell','cowbell'],['ride','rideEdge']])
    expect(render(a), `${a} vs ${b}`).not.toEqual(render(b));
  for (const choke of ['crashChoke','crash2Choke','splashChoke','chinaChoke','rideChoke'])
    expect(render(choke).length).toBeLessThan(render(CHOKES[choke][0]).length / 3);
  expect(render('kick')).toEqual(render('kick'));
});

test('a roll repeats strokes through its beat until the next onset of the same piece', () => {
  // Hi-hat eighths make the snare an eighth note, but its 16th roll fills the beat.
  const score = scoreWith([hit(0,'snare',{roll:2,accent:true,flam:true}), hit(0,'closedHat'), hit(.5,'closedHat'), hit(1.5,'snare',{roll:3}), hit(1.75,'snare'), hit(2,'kick')]);
  const snares = scoreEvents(score).filter(e => e.instrument === 'snare');
  expect(snares.map(e => e.time)).toEqual([0, .125, .25, .375, .75, .8125, .875]);
  expect(snares.filter(e => e.stroke).every(e => !e.accent && !e.flam && !e.roll)).toBe(true);
  expect(snares[0]).toMatchObject({accent:true, flam:true, roll:2});
  expect(new Set(scoreEvents(score).map(e => e.id)).size).toBe(scoreEvents(score).length);
});

test('a roll on a lone note lasts its written half or whole note and follows tempo changes', () => {
  const lone = scoreWith([hit(0,'snare',{roll:1})]);
  expect(scoreEvents(lone).map(e => e.time)).toEqual([0,.25,.5,.75,1,1.25,1.5,1.75]);
  const half = scoreWith([hit(0,'floorTom',{roll:1}), hit(0,'kick'), hit(2,'kick')]);
  expect(scoreEvents(half).filter(e => e.instrument === 'floorTom')).toHaveLength(4);
  // Second bar at half tempo: a quarter lasts one second.
  const slow = scoreWith([], [hit(0,'snare',{roll:2}), hit(1,'kick')]);
  slow.timeline.anchors = [{position:fraction(0),time:0},{position:fraction(4),time:2},{position:fraction(8),time:6}];
  const times = scoreEvents(slow).filter(e => e.instrument === 'snare').map(e => e.time);
  expect(times).toEqual([4, 4.25, 4.5, 4.75].map(q => toTime(slow.timeline, q)));
  expect(times).toEqual([2, 2.25, 2.5, 2.75]);
});

test('roll strokes inside a tuplet keep the absolute subdivision and stop at the tuplet end', () => {
  const score = scoreWith([hit(0,'snare',{roll:2}), hit(1/3,'kick'), hit(2,'kick')]);
  score.bars[0].tuplets = [{start:fraction(0), length:fraction(1), count:3}];
  expect(scoreEvents(score).filter(e => e.instrument === 'snare').map(e => e.time)).toEqual([0, .125, .25, .375]);
});

test('scheduled rolls play every stroke at its engine time while notation plays', async () => {
  audio.setScore(scoreWith([hit(0,'snare',{roll:2}), hit(1,'snare')]));
  audio.setMode('notation');
  const played = vi.spyOn(audio, 'play').mockImplementation(() => {});
  await engine.play();
  for (let i = 0; i < 40; i++) { audio.tick(); engine.ctx.currentTime += .025; }
  const when = played.mock.calls.map(c => c[1]);
  expect(when).toHaveLength(5);
  [0, .125, .25, .375, .5].forEach((t, i) => expect(when[i]).toBeCloseTo(engine.lookahead + t, 8));
});

test('cymbal chokes play a short hit and grab only the ringing cymbal they belong to', () => {
  audio.play({instrument:'crash', velocity:.8}, 0);
  audio.play({instrument:'crash2', velocity:.8}, 0);
  audio.play({instrument:'ride', velocity:.8}, 0);
  audio.play({instrument:'crash', velocity:.8}, 1);
  const [crash, crash2, ride, later] = [...audio.active];
  audio.play({instrument:'crashChoke', velocity:.8}, .5);
  expect(crash.gain.gain.setTargetAtTime).toHaveBeenCalledWith(0, .5, .02);
  expect(crash.source.stop).toHaveBeenCalledWith(expect.closeTo(.62));
  for (const e of [crash2, ride, later]) expect(e.source.stop).not.toHaveBeenCalled();
  expect(starts()).toContainEqual(['crashChoke', .5]);
  audio.play({instrument:'rideChoke'}, .6);
  expect(ride.source.stop).toHaveBeenCalledWith(expect.closeTo(.72));
  expect(crash2.source.stop).not.toHaveBeenCalled();
});

test('closed and pedal hats choke open and half-open hats', () => {
  audio.play({instrument:'halfHat'}, 0); audio.play({instrument:'openHat'}, .2);
  const [half, open] = [...audio.active];
  audio.play({instrument:'pedalHat'}, .1);
  expect(half.source.stop).toHaveBeenCalledWith(expect.closeTo(.16));
  expect(open.source.stop).not.toHaveBeenCalled();
  audio.play({instrument:'closedHat'}, .3);
  expect(open.gain.gain.setTargetAtTime).toHaveBeenCalledWith(0, .3, .01);
});

test('a flam plays one quieter grace and a drag two, before the main stroke', () => {
  engine.ctx.currentTime = 1;
  audio.play({instrument:'snare', velocity:.8, accent:true, flam:true}, 2);
  expect(starts()).toEqual([['snare',2],['snare',expect.closeTo(1.975)]]);
  const [main, grace] = [...audio.active].map(e => e.gain.gain.setValueAtTime.mock.calls[0][0]);
  expect(grace).toBeLessThan(main / 2);
  audio.cancel();
  audio.play({instrument:'snare', velocity:.8, flam:true, drag:true}, 2);
  expect(starts().map(s => s[1])).toEqual([2, expect.closeTo(1.94), expect.closeTo(1.97)]);
});
