// Web Audio fakes for engine, metronome and transport tests (architecture §11.3).
//
// - `FakeAudioContext`: a controllable `currentTime`, recorded GainNode
//   automation (`param.events`, `param.valueAt(t)`), recorded
//   BufferSource/Oscillator start and stop times, and context state changes
//   (`ctx.setState('interrupted')`).
// - `createStretchFake(ctx)`: a recording Signalsmith node. Every `schedule`
//   argument is kept (including `outputTime`), and the node keeps the same
//   time map the SignalsmithStretch 1.3.2 worklet keeps, so `inputAt(t)` says
//   which media time the processor renders at output time `t`.
// - `createClock({start})`: `advance(sec)` moves audio time in 25 ms steps;
//   each step adds to `ctx.currentTime` and calls `vi.advanceTimersByTime(25)`
//   when fake timers are installed, so the engine and metronome tickers run.
//
// Engine tests mock the two engine imports with these fakes:
//   vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
//   vi.mock('../src/js/stemcache.js', async () => (await import('./helpers/fake-audio.js')).fakeStemcache);
// and load stems with `loadFakeStems(engine, ['drums', 'bass'], {duration})`.
import {vi} from 'vitest';

export const STEP = 0.025;
const round9 = (x) => Math.round(x * 1e9) / 1e9;
const liveContexts = new Set();
let activeClock = null;

/** An AudioParam that records its automation and can evaluate it. */
export class FakeAudioParam {
  constructor(value = 1) {
    this._value = value;
    this.events = [];
    this.calls = [];
  }
  get value() { return this._value; }
  set value(v) { this._value = v; this.calls.push(['value', v]); }
  _insert(event) {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time > event.time) i--;
    this.events.splice(i, 0, event);
    return this;
  }
  setValueAtTime(value, time) { this.calls.push(['setValueAtTime', value, time]); return this._insert({type: 'set', value, time}); }
  setTargetAtTime(value, time, timeConstant) { this.calls.push(['setTargetAtTime', value, time, timeConstant]); return this._insert({type: 'target', value, time, timeConstant}); }
  linearRampToValueAtTime(value, time) { this.calls.push(['linearRampToValueAtTime', value, time]); return this._insert({type: 'linear', value, time}); }
  exponentialRampToValueAtTime(value, time) { this.calls.push(['exponentialRampToValueAtTime', value, time]); return this._insert({type: 'exponential', value, time}); }
  cancelScheduledValues(time) {
    this.calls.push(['cancelScheduledValues', time]);
    this.events = this.events.filter((e) => e.time < time);
    return this;
  }
  /** The automated value at audio time `t` (set, target, linear and exponential events). */
  valueAt(t) {
    let value = this._value, at = -Infinity;
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      if (e.type === 'linear' || e.type === 'exponential') {
        if (e.time <= t) { value = e.value; at = e.time; continue; }
        const span = e.time - Math.max(at, 0) || 1, k = (t - Math.max(at, 0)) / span;
        return e.type === 'linear' ? value + (e.value - value) * k : value * (e.value / value) ** k;
      }
      if (e.time > t) break;
      if (e.type === 'set') value = e.value;
      else if (e.type === 'target') {
        const end = this.events.slice(i + 1).find((n) => n.time > e.time)?.time ?? Infinity;
        value = e.value + (value - e.value) * Math.exp(-(Math.min(t, end) - e.time) / e.timeConstant);
      }
      at = e.time;
    }
    return value;
  }
}

export class FakeAudioNode {
  constructor(context, kind) {
    this.context = context;
    this.kind = kind;
    this.outputs = [];
    this.disconnects = 0;
    this.channelCount = 2;
    this.channelCountMode = 'max';
    this.channelInterpretation = 'speakers';
  }
  connect(target, output = 0, input = 0) { this.outputs.push({target, output, input}); return target; }
  disconnect(target) {
    this.disconnects++;
    this.outputs = target === undefined ? [] : this.outputs.filter((o) => o.target !== target);
  }
  connectedTo(target) { return this.outputs.some((o) => o.target === target); }
}

export class FakeGainNode extends FakeAudioNode {
  constructor(context) { super(context, 'gain'); this.gain = new FakeAudioParam(1); }
}

class FakeScheduledSource extends FakeAudioNode {
  constructor(context, kind) {
    super(context, kind);
    this.onended = null;
    this.startTime = null;
    this.stopTime = null;
    this.ended = false;
    this.start = vi.fn((when = 0, offset = 0) => {
      if (this.startTime != null) throw new Error('InvalidStateError: start() called twice');
      this.startTime = when;
      this.offset = offset;
    });
    this.stop = vi.fn((when = 0) => {
      if (this.startTime == null) throw new Error('InvalidStateError: stop() before start()');
      this.stopTime = when;
    });
  }
  /** Whether this source sounds at audio time `t`. */
  playsAt(t) { return this.startTime != null && this.startTime <= t && (this.stopTime == null || t < this.stopTime); }
  _endIfStopped(t) {
    if (this.ended || this.stopTime == null || this.startTime == null) return;
    if (Math.max(this.stopTime, this.startTime) <= t) { this.ended = true; this.onended?.(); }
  }
}

export class FakeBufferSource extends FakeScheduledSource {
  constructor(context) {
    super(context, 'buffer-source');
    this.buffer = null;
    this.playbackRate = new FakeAudioParam(1);
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.offset = 0;
  }
  /** The media time this source renders at audio time `t` (null when silent). */
  mediaAt(t) {
    if (!this.playsAt(t)) return null;
    let pos = this.offset + (t - this.startTime) * this.playbackRate.value;
    if (this.loop && this.loopEnd > this.loopStart && pos >= this.loopEnd) pos = this.loopStart + ((pos - this.loopEnd) % (this.loopEnd - this.loopStart));
    return pos;
  }
}

export class FakeOscillator extends FakeScheduledSource {
  constructor(context) { super(context, 'oscillator'); this.frequency = new FakeAudioParam(440); this.type = 'sine'; }
}

export class FakeAudioBuffer {
  constructor(numberOfChannels, length, sampleRate) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    // Sample content is not modelled: each channel holds at most 4096 frames.
    this._data = Array.from({length: numberOfChannels}, () => new Float32Array(Math.min(length, 4096)));
  }
  getChannelData(channel) { return this._data[channel]; }
  copyToChannel(source, channel) { this._data[channel].set(source.subarray(0, this._data[channel].length)); }
}

export class FakeAudioContext {
  constructor({sampleRate = 48000} = {}) {
    this.currentTime = activeClock ? activeClock.now() : 0;
    this.state = 'running';
    this.sampleRate = sampleRate;
    this.destination = new FakeAudioNode(this, 'destination');
    this.onstatechange = null;
    this.decodeDuration = 100;
    this.sources = [];
    this.oscillators = [];
    this.gains = [];
    this._stateListeners = new Set();
    liveContexts.add(this);
  }
  createGain() { const node = new FakeGainNode(this); this.gains.push(node); return node; }
  createBufferSource() { const node = new FakeBufferSource(this); this.sources.push(node); return node; }
  createOscillator() { const node = new FakeOscillator(this); this.oscillators.push(node); return node; }
  createChannelSplitter(n = 6) { const node = new FakeAudioNode(this, 'splitter'); node.numberOfOutputs = n; return node; }
  createChannelMerger(n = 6) { const node = new FakeAudioNode(this, 'merger'); node.numberOfInputs = n; return node; }
  createBuffer(channels, length, sampleRate) { return new FakeAudioBuffer(channels, length, sampleRate); }
  async decodeAudioData() { return this.createBuffer(2, Math.round(this.decodeDuration * this.sampleRate), this.sampleRate); }
  addEventListener(type, fn) { if (type === 'statechange') this._stateListeners.add(fn); }
  removeEventListener(type, fn) { if (type === 'statechange') this._stateListeners.delete(fn); }
  /** Change the state as the browser would (e.g. 'interrupted' on iOS) and fire `statechange`. */
  setState(state) {
    if (this.state === state) return;
    this.state = state;
    const event = {type: 'statechange', target: this};
    this.onstatechange?.(event);
    for (const fn of [...this._stateListeners]) fn(event);
  }
  async resume() { this.setState('running'); }
  async suspend() { this.setState('suspended'); }
  async close() { this.setState('closed'); liveContexts.delete(this); }
  /** Move audio time to `t`, ending every source whose stop time has passed. */
  _advanceTo(t) {
    this.currentTime = t;
    for (const node of [...this.sources, ...this.oscillators]) node._endIfStopped(t);
  }
}

/** Install `FakeAudioContext` as the global `AudioContext`; returns a restore function. */
export function installFakeAudio() {
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  return () => {
    liveContexts.clear();
    activeClock = null;
    if (previous === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = previous;
  };
}

/**
 * Audio clock for tests. `advance(sec)` moves `ctx.currentTime` in 25 ms
 * steps (for `ctx`, or every live FakeAudioContext when omitted) and advances
 * fake timers by the same amount after each step.
 */
export function createClock({start = 0, ctx} = {}) {
  let time = start;
  const contexts = () => (ctx ? [ctx] : [...liveContexts]);
  for (const c of contexts()) c._advanceTo(time);
  const clock = {
    now: () => time,
    advance(seconds) {
      let remaining = round9(seconds);
      while (remaining > 1e-9) {
        const step = Math.min(STEP, remaining);
        time = round9(time + step);
        remaining = round9(remaining - step);
        for (const c of contexts()) c._advanceTo(time);
        if (vi.isFakeTimers()) vi.advanceTimersByTime(step * 1000);
      }
      return time;
    },
  };
  if (!ctx) activeClock = clock;
  return clock;
}

/** The timer set the architecture mandates for clock-driven tests (§11.3). */
export const FAKE_TIMERS = {toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame']};

// ---- Signalsmith ------------------------------------------------------------

const INITIAL_SEGMENT = {active: false, input: 0, output: 0, rate: 1, semitones: 0, loopStart: 0, loopEnd: 0};

/**
 * The worklet's `schedule` (SignalsmithStretch.mjs 1.3.2, lines 87-127,
 * without `adjustPrevious` and the 'time' message). `process()` first drops
 * the segments that ended before `currentTime`, as the running worklet does.
 */
export function scheduleTimeMap(timeMap, objIn, currentTime) {
  while (timeMap.length > 1 && timeMap[1].output <= currentTime) timeMap.shift();
  const outputTime = 'outputTime' in objIn ? objIn.outputTime : currentTime;
  let latest = timeMap[timeMap.length - 1];
  while (timeMap.length && timeMap[timeMap.length - 1].output >= outputTime) latest = timeMap.pop();
  const obj = {...latest, input: null, output: outputTime, ...objIn};
  if (obj.input === null) obj.input = latest.input + (obj.output - latest.output) * (latest.active ? latest.rate : 0);
  delete obj.outputTime;
  timeMap.push(obj);
  while (timeMap.length > 1 && timeMap[1].output <= outputTime) timeMap.shift();
  return obj;
}

/** The media time the processor renders at output time `t` (null while inactive). */
export function timeMapInputAt(timeMap, t) {
  let i = 0;
  while (i + 1 < timeMap.length && timeMap[i + 1].output <= t) i++;
  const seg = timeMap[i];
  if (!seg.active) return null;
  let input = seg.input + (t - seg.output) * seg.rate;
  const length = seg.loopEnd - seg.loopStart;
  if (length > 0 && input >= seg.loopEnd) input = seg.loopStart + ((input - seg.loopEnd) % length);
  return input;
}

/** A recording Signalsmith node on `ctx` (see the file header). */
export function createStretchFake(ctx, {latency = 0} = {}) {
  const node = new FakeAudioNode(ctx, 'stretch');
  node.timeMap = [{...INITIAL_SEGMENT}];
  node.schedule = vi.fn((objIn) => scheduleTimeMap(node.timeMap, {...objIn}, ctx.currentTime));
  node.stop = vi.fn((when) => scheduleTimeMap(node.timeMap, {active: false, output: typeof when === 'number' ? when : ctx.currentTime}, ctx.currentTime));
  node.start = vi.fn((when) => scheduleTimeMap(node.timeMap, {active: true, output: typeof when === 'number' ? when : ctx.currentTime}, ctx.currentTime));
  node.addBuffers = vi.fn(async (buffers) => buffers.length);
  node.latency = vi.fn(async () => latency);
  node.port = {postMessage: vi.fn(), close: vi.fn()};
  node.inputAt = (t) => timeMapInputAt(node.timeMap, t);
  return node;
}

/** Stand-in for the `signalsmith-stretch` default export. */
export const fakeSignalsmith = vi.fn(async (ctx) => createStretchFake(ctx));

/** Stand-in for `src/js/stemcache.js`. */
export const fakeStemcache = {fetchStem: vi.fn(async () => new ArrayBuffer(8))};

let stemLoads = 0;
/** Load `names` as stems of `duration` seconds through the engine's real `loadStems`. */
export async function loadFakeStems(engine, names = ['drums', 'bass'], {duration = 100} = {}) {
  engine.ctx.decodeDuration = duration;
  const load = ++stemLoads;
  return engine.loadStems(names.map((name) => ({name, color: '#888', key: `fake-${load}-${name}`, url: `https://stems.invalid/${name}`})));
}
