// Native playback is transparent at 1x. Time stretching links every stem channel
// in one processor so spectral phase changes remain coherent across the mix.
import SignalsmithStretch from 'signalsmith-stretch';
import stretchModuleUrl from 'signalsmith-stretch?url';
// Load an emitted same-origin module; do not stringify bundled code into a blob.
SignalsmithStretch.moduleUrl = stretchModuleUrl;
import { fetchStem } from './stemcache.js';
import { decodedStemCache } from './decoded-stem-cache.js';

/** Slowest playback rate (E1: the speed range is 25–150%). */
export const MIN_RATE = 0.25;
/** Fastest playback rate. */
export const MAX_RATE = 1.5;
const TICK_MS = 25;
/** A position projected within this of a loop end reads as the loop start. */
const WRAP_EPS = 1e-6;
/** A boundary (wrap, gap start) this close after now is due now: the ticker emits it on this tick. */
const BOUNDARY_EPS = 1e-9;
/** After pause/stop the aux bus is muted, then reopened for previews and calibration clicks. */
const AUX_RELEASE = 0.05;
const EVENTS = new Set(['wrap', 'gap', 'ended', 'interrupted', 'state', 'plan', 'transport']);
const DEV = import.meta.env?.DEV === true;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * The playback plan (architecture §5.0). `plan` holds the segments from the
 * audible one onwards, in time order:
 *   - `{kind: 'play', when, offset, rate, loop, processing, seekOffset?, scheduled?}`:
 *     gapless playback (a loop wraps inside the segment: native `source.loop`,
 *     Signalsmith `loopStart`/`loopEnd`);
 *   - `{kind: 'pass', when, offset, until, index}` and
 *     `{kind: 'gap', when, until, target, mode, sec, elapsed}`: a segmented loop
 *     (`setLoop(…, {gapSec > 0})`). Each pass plays `[offset, b)` once and ends
 *     at `until`; a gap of `sec` media seconds follows, silent or playing the
 *     audio before `a` ('preroll'), then the next pass from `a`. A segmented
 *     run always holds the current pass, the next gap and the next pass: when a
 *     pass starts, the next gap and pass are appended (`_extend`), so a
 *     throttled timer never starves either path.
 * Entries made by one change share a `run` id (appended passes keep it) and a
 * `seq`. Every change replaces the plan from a time T and posts every new entry
 * to both paths: native sources (one per entry and track; a preroll gap and its
 * pass share one) and the Signalsmith processor.
 *
 * `revision` bumps on discontinuities (play, pause, stop, an immediate seek,
 * rate or pitch change, a loop edit that moves the position) and notifies
 * `subscribeTransport` and `'transport'` listeners, which drop everything they
 * scheduled. Every other plan change (a scheduled rate, `seekAt`,
 * `cancelPending`, a loop edit that keeps the position) bumps `planVersion`
 * and emits `'plan' {from, version}`, so listeners cancel only what they
 * scheduled at or after `from`.
 *
 * `rate` and `loop` are what is audible now: an entry changes them once it
 * starts (`_promote`, run by the ticker, by every change before it builds on
 * them, and by the `rate`/`loop` getters). Entries and direct writes are
 * stamped in order, so an entry never overrides a newer direct write (a loop
 * the user set after the entry was planned), and an entry derived from a
 * pending scheduled one carries its rate forward.
 *
 * Signalsmith posting (SignalsmithStretch 1.3.2): the worklet's `schedule`
 * pops every queued change at or after `outputTime` and then drops every
 * segment that precedes a change whose `output` is at or before `outputTime`.
 * Posting a future change with `outputTime === output` would discard the
 * audible segment, and the processor would render the future segment's
 * timeline extrapolated backwards until it starts. Every call therefore passes
 * an explicit `outputTime` at the cut (after the last kept change, before the
 * new one). The time map can hold one future change next to the audible
 * segment, so a later entry is posted once the earlier one has started (by the
 * ticker); the pitch gate and the native sources carry the whole plan ahead.
 */
export class MultitrackEngine {
  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    // Clicks and drum hits connect here: after the stems' master, so a count-in
    // sounds while master is held at 0, and silenced by stopAt and pause.
    this.aux = this.ctx.createGain();
    this.aux.connect(this.ctx.destination);
    this.recordingAudible = true;
    this.tracks = [];
    this.stretch = null;
    this.pitchGate = null;
    this.splitter = null;
    this.duration = 0;

    this.playing = false;
    this.plan = [];
    this._seq = 0;
    this._rateSeq = 0;
    this._loopSeq = 0;
    this._rate = 1;
    this.preservePitch = true;
    this.planVersion = 0;
    this.lookahead = 0.05;
    this.destroyed = false;
    this.playRequest = 0;
    this.revision = 0;
    this.transportListeners = new Set();
    this.pausedAt = 0;
    this.editPosition = 0;
    this.paused = false;
    this.countIn = null;
    this.stopAtWhen = null;

    this._loop = { enabled: false, a: 0, b: 0 };
    // Segmented loops: the gap between passes in media seconds, and what it plays.
    this._gap = {sec: 0, mode: 'silent'};
    this._runs = 0;
    this.onEnded = null;

    this._listeners = new Map();
    this._ticker = null;
    this._wrapCursor = 0;
    this._stretchMap = [];
    this._state = {playing: false, counting: false, paused: false};
    this._stateHold = 0;
    this.ctx.onstatechange = () => this._onContextState();
  }

  /**
   * @param {Array<{name,color,key,url}>} stems
   * @param {(done:number,total:number,bytes:{loaded:number,total:number})=>void} [onProgress]
   */
  async loadStems(stems, onProgress) {
    // Per-stem byte counters, summed so the UI can show one overall bar.
    const bytes = stems.map(() => ({ loaded: 0, total: 0 }));
    let decoded = 0;
    const report = () =>
      onProgress?.(decoded, stems.length, {
        loaded: bytes.reduce((a, b) => a + b.loaded, 0),
        total: bytes.reduce((a, b) => a + b.total, 0),
      });

    const loaded = await Promise.all(
      stems.map(async (s, i) => {
        const buffer = await decodedStemCache.load(s.key, this.ctx.sampleRate, async () => {
          const arr = await fetchStem(s.key, s.url, (l, t) => {
            bytes[i] = { loaded: l, total: t || bytes[i].total };
            report();
          });
          return this.ctx.decodeAudioData(arr);
        });
        decoded++;
        report();
        return { ...s, buffer };
      })
    );
    if (this.destroyed) return;
    this.duration = Math.max(0, ...loaded.map((l) => l.buffer.duration));
    const frames = Math.max(...loaded.map(l => l.buffer.length));
    this.tracks = loaded.map((l) => {
      // A short stem must contribute silence, including within a longer loop.
      if (l.buffer.length < frames) {
        const padded = this.ctx.createBuffer(l.buffer.numberOfChannels, frames, this.ctx.sampleRate);
        for (let c = 0; c < l.buffer.numberOfChannels; c++) padded.copyToChannel(l.buffer.getChannelData(c), c);
        l.buffer = padded;
      }
      // gain (the user's mix) → auto (scheduled gains, call & response) → master.
      const gain = this.ctx.createGain();
      const auto = this.ctx.createGain();
      gain.connect(auto);
      auto.connect(this.master);
      return { name: l.name, color: l.color, buffer: l.buffer, gain, auto, autoGain: 1, autoPending: [], nativeSources: new Set(), merger: null, volume: 1, muted: false, soloed: false };
    });
    this.loop.b = this.duration;
    // One multichannel analysis links phase across all stems. Independent
    // stereo stretchers can smear shared transients and comb-filter the mix.
    const channels = this.tracks.length * 2;
    const source = await SignalsmithStretch(this.ctx, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [channels],
      channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'discrete',
    });
    if (this.destroyed) { source.disconnect(); source.port.close(); return; }
    this.stretch = source;
    this.pitchGate = this.ctx.createGain();
    this.pitchGate.channelCount = channels;
    this.pitchGate.channelCountMode = 'explicit';
    this.pitchGate.channelInterpretation = 'discrete';
    this.pitchGate.gain.value = 0;
    this.splitter = this.ctx.createChannelSplitter(channels);
    source.connect(this.pitchGate).connect(this.splitter);
    const buffers = [];
    this.tracks.forEach((track, i) => {
      track.merger = this.ctx.createChannelMerger(2);
      this.splitter.connect(track.merger, i * 2, 0);
      this.splitter.connect(track.merger, i * 2 + 1, 1);
      track.merger.connect(track.gain);
      for (let c = 0; c < 2; c++) buffers.push(track.buffer.getChannelData(Math.min(c, track.buffer.numberOfChannels - 1)).slice());
    });
    await source.addBuffers(buffers, buffers.map(buffer => buffer.buffer));
    this.lookahead = Math.max(this.lookahead, await source.latency() + 0.02);
    if (this.destroyed) return;
    this._applyGains();
    return { duration: this.duration, tracks: this.tracks };
  }

  // ---- mix ----------------------------------------------------------------
  _track(name) { return this.tracks.find((x) => x.name === name); }

  _applyGains() {
    const anySolo = this.tracks.some((t) => t.soloed);
    for (const t of this.tracks) {
      const audible = anySolo ? t.soloed : !t.muted;
      const target = audible && this.recordingAudible ? t.volume : 0;
      t.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.012);
    }
  }

  setVolume(name, v) {
    const t = this._track(name);
    if (t) { t.volume = v; this._applyGains(); }
  }
  setRecordingAudible(enabled) { this.recordingAudible=enabled; this._applyGains(); }
  /** Idempotent: restore, undo and Minus me set an explicit state. */
  setMuted(name, on) {
    const t = this._track(name);
    if (t && t.muted !== !!on) { t.muted = !!on; this._applyGains(); }
    return t?.muted;
  }
  setSoloed(name, on) {
    const t = this._track(name);
    if (t && t.soloed !== !!on) { t.soloed = !!on; this._applyGains(); }
    return t?.soloed;
  }
  toggleMute(name) { const t = this._track(name); return t ? this.setMuted(name, !t.muted) : undefined; }
  toggleSolo(name) { const t = this._track(name); return t ? this.setSoloed(name, !t.soloed) : undefined; }
  resetMixer() {
    for (const t of this.tracks) { t.muted = false; t.soloed = false; t.volume = 1; }
    this._applyGains();
  }

  /**
   * Scheduled per-track gains on each track's `auto` node (call & response).
   * Only the named tracks change; the user mix is never touched, and this is
   * not a plan change. `pause()` and `stop()` reset every track to 1.
   */
  setTrackGains(gains, {at} = {}) {
    if (!gains || typeof gains !== 'object') return;
    const now = this.ctx.currentTime;
    const when = Number.isFinite(at) ? Math.max(at, now) : now;
    for (const [name, value] of Object.entries(gains)) {
      const track = this._track(name);
      if (!track?.auto || !Number.isFinite(value)) continue;
      const gain = clamp(value, 0, 1);
      track.auto.gain.setValueAtTime(gain, when);
      if (when <= now) track.autoGain = gain;
      else track.autoPending.push({when, gain});
    }
  }

  _resetTrackGains(now) {
    for (const track of this.tracks) {
      if (!track.auto) continue;
      track.auto.gain.cancelScheduledValues(now);
      track.auto.gain.setValueAtTime(1, now);
      track.autoGain = 1;
      track.autoPending = [];
    }
  }

  // ---- rate and loop (what is audible now) --------------------------------
  get rate() { this._promote(); return this._rate; }
  set rate(value) { this._rate = value; this._rateSeq = ++this._seq; }
  get loop() { this._promote(); return this._loop; }
  set loop(value) { this._loop = value; this._loopSeq = ++this._seq; }
  /** The segmented-loop options last given to `setLoop`: `{sec, mode}` (`sec = 0` is gapless). */
  get loopGap() { return {...this._gap}; }

  /**
   * Apply every entry that has started, in order: its rate and loop become
   * the engine's unless a newer direct write (stamped later) has replaced them.
   */
  _promote(now = this.ctx.currentTime) {
    for (const segment of this.plan) {
      if (segment.when > now) break;
      if (segment.promoted) continue;
      segment.promoted = true;
      if (segment.seq > this._rateSeq) { this._rate = segment.rate; this._rateSeq = segment.seq; }
      if (segment.seq > this._loopSeq) { this._loop = {...segment.loop}; this._loopSeq = segment.seq; }
    }
  }

  // ---- position -----------------------------------------------------------
  _positionIn(segment, time) {
    if (segment.kind === 'gap') {
      // A silent gap reads its target; a preroll gap reads the audio it plays.
      if (segment.mode !== 'preroll') return segment.target;
      return clamp(segment.offset + Math.max(0, time - segment.when) * segment.rate, 0, segment.target);
    }
    let pos = segment.offset + Math.max(0, time - segment.when) * segment.rate;
    if (segment.kind === 'pass') return clamp(pos, 0, Math.min(segment.loop.b, this.duration));
    const { enabled, a, b } = segment.loop;
    if (enabled && pos >= b - WRAP_EPS) {
      pos = a + ((pos - a) % (b - a));
      if (b - pos <= WRAP_EPS) pos = a;
    }
    return Math.max(0, Math.min(pos, this.duration));
  }

  _segmentAt(time) {
    return this.plan.findLast(s => s.when <= time) || this.plan[0];
  }

  getPositionAt(time) {
    if (!this.playing || !this.plan.length) return this.pausedAt;
    if (this.countIn && time < this.countIn.endWhen) {
      const c = this.countIn;
      return c.audible ? Math.max(0, c.target - c.duration + Math.max(0, time - c.startWhen) * c.rate) : c.target;
    }
    return this._positionIn(this._segmentAt(time), time);
  }

  getPosition() { return this.getPositionAt(this.ctx.currentTime); }
  get countingIn() { return this.playing && !!this.countIn && this.ctx.currentTime < this.countIn.endWhen; }

  /** Audio time of the `n`th arrival (1-based) at `loop.b` within a looping segment. */
  _wrapTime(seg, n) {
    const { a, b } = seg.loop;
    return seg.when + (b - seg.offset) / seg.rate + (n - 1) * (b - a) / seg.rate;
  }

  /** The first pass number whose wrap comes strictly after audio time `t`. */
  _wrapAfter(seg, t) {
    const first = this._wrapTime(seg, 1), period = (seg.loop.b - seg.loop.a) / seg.rate;
    let n = first > t ? 1 : Math.floor((t - first) / period) + 2;
    while (n > 1 && this._wrapTime(seg, n - 1) > t) n--;
    while (this._wrapTime(seg, n) <= t) n++;
    return n;
  }

  /**
   * The audio time of the next arrival at `loop.b` in the plan, strictly
   * after now; null when not looping or not playing. A wrap within
   * BOUNDARY_EPS after now is the one the ticker emits now (inside a 'wrap'
   * handler it is the wrap being emitted), so it is skipped too.
   */
  nextWrapAt() {
    if (!this.playing) return null;
    const after = this.ctx.currentTime + BOUNDARY_EPS;
    for (let i = 0; i < this.plan.length; i++) {
      const seg = this.plan[i], end = this.plan[i + 1]?.when ?? Infinity;
      if (end <= after) continue;
      if (seg.kind === 'pass') { if (seg.until > after && seg.until <= end + 1e-9) return seg.until; continue; }
      if (seg.kind === 'gap' || !seg.loop.enabled) continue;
      const when = this._wrapTime(seg, this._wrapAfter(seg, Math.max(after, seg.when)));
      if (when <= end + 1e-9) return when;
    }
    return null;
  }

  /**
   * The first audio time (now or later) at which the position reaches media
   * time `t`, through loop wraps and scheduled changes; null when it never does.
   */
  whenAt(t) {
    if (!this.playing || !Number.isFinite(t)) return null;
    const now = this.ctx.currentTime;
    for (let i = 0; i < this.plan.length; i++) {
      const seg = this.plan[i], end = this.plan[i + 1]?.when ?? Infinity;
      if (end <= now) continue;
      const start = Math.max(now, seg.when);
      const when = this._reach(seg, start, this._positionIn(seg, start), t);
      if (when != null && when < end - 1e-9) return when;
    }
    return null;
  }

  _reach(seg, start, from, t) {
    const { enabled, a, b } = seg.loop, rate = seg.rate;
    if (seg.kind === 'gap') {
      // Nothing is heard in a silent gap; a preroll gap plays [max(0, offset), target).
      if (seg.mode !== 'preroll' || t >= seg.target || t < Math.max(0, seg.offset) - 1e-9) return null;
      return Math.max(start, seg.when + (t - seg.offset) / rate);
    }
    if (Math.abs(t - from) <= 1e-9) return start;
    if (seg.kind === 'pass') return t > from && t < b ? start + (t - from) / rate : null;
    if (!enabled) return t > from && t <= this.duration ? start + (t - from) / rate : null;
    if (t >= b) return null;
    if (t > from) return start + (t - from) / rate;
    if (t >= a) return start + (b - from) / rate + (t - a) / rate;
    return null;
  }

  // ---- events -------------------------------------------------------------
  /**
   * Engine events: 'wrap' {when, a, b, pass}, 'gap' {when, until, target},
   * 'ended' {reason: 'end'|'stopAt'}, 'interrupted' {state},
   * 'state' {playing, counting, paused}, 'plan' {from, version} and
   * 'transport' {revision}. Ticker events run from the ticker, outside audio
   * callbacks. Returns the unsubscribe function.
   */
  on(type, fn) {
    if (!EVENTS.has(type)) throw new TypeError(`Unknown engine event: ${type}`);
    let listeners = this._listeners.get(type);
    if (!listeners) this._listeners.set(type, listeners = new Set());
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }

  _emit(type, payload) {
    const listeners = this._listeners.get(type);
    if (!listeners?.size) return;
    for (const fn of [...listeners]) {
      // One failing listener must not stop the ticker or starve the others.
      try { fn(payload); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }

  subscribeTransport(listener){this.transportListeners.add(listener);return ()=>this.transportListeners.delete(listener);}

  _notifyTransport() {
    for (const listener of this.transportListeners) listener();
    this._emit('transport', {revision: this.revision});
  }

  _emitState() {
    if (this._stateHold) return;
    const state = {playing: this.playing, counting: this.countingIn, paused: this.paused};
    const last = this._state;
    if (last.playing === state.playing && last.counting === state.counting && last.paused === state.paused) return;
    this._state = state;
    this._emit('state', {...state});
  }

  // ---- the plan -----------------------------------------------------------
  /**
   * Replace the plan from `cut`: entries at or after `cut` (after `cut` when
   * `strict`), and entries `drop` selects, are removed, `segments` are
   * appended, and both paths are posted from there.
   */
  _replacePlan(cut, segments, {strict = false, drop = null} = {}) {
    const now = this.ctx.currentTime;
    const hadGaps = this._segmented();
    const removed = new Set(this.plan.filter(s => (strict ? s.when > cut : s.when >= cut) || (drop?.(s) ?? false)));
    const kept = this.plan.filter(s => !removed.has(s));
    const first = segments[0].when;
    // Native: drop sources that have not started, move the audible source's stop.
    for (const track of this.tracks) {
      for (const entry of track.nativeSources) {
        if (removed.has(entry.segment)) {
          entry.source.stop(now);
          entry.source.disconnect();
          track.nativeSources.delete(entry);
        } else if (entry.stop == null || entry.stop >= cut) {
          // A scheduled stop can be moved when a pending change is replaced.
          // Sources which have ended remove themselves (onended). A pass never
          // plays beyond its own end.
          const stop = entry.segment.kind === 'play' ? first : Math.min(entry.stop ?? first, first);
          entry.source.stop(stop);
          entry.stop = stop;
        }
      }
    }
    segments.forEach((segment, i) => {
      if (segment.processing) return;
      if (segment.kind !== 'play') { const span = this._nativeSpan(segment); if (span) for (const track of this.tracks) this._startSpan(track, segment, span); return; }
      for (const track of this.tracks) this._startNative(track, segment, segments[i + 1]?.when);
    });
    // The processed and native paths are mutually exclusive at the same output
    // timestamp. Gate the processor tail too, so it cannot comb with dry audio.
    const gate = this.pitchGate?.gain;
    // Entries dropped before the cut take their gate changes with them.
    const from = Math.min(cut, ...[...removed].map(s => s.when).filter(t => t > now));
    if (gate) {
      if (strict) {
        gate.cancelScheduledValues(now);
        gate.setValueAtTime(this._gateAt(kept.findLast(s => s.when <= now), now), now);
      } else {
        gate.cancelScheduledValues(from);
        if (from < cut) {
          gate.setValueAtTime(this._gateAt(kept.findLast(s => s.when <= from), from), from);
          for (const segment of kept) for (const [t, v] of this._gateEvents(segment)) if (t > from && t < cut) gate.setValueAtTime(v, t);
        }
      }
      for (const segment of segments) for (const [t, v] of this._gateEvents(segment)) gate.setValueAtTime(v, t);
    }
    for (const segment of removed) segment.removed = true;
    this.plan = [...kept, ...segments];
    // Silent gaps also hold the stems' master at 0 (§5.1 setLoop).
    if (hadGaps || this._segmented()) this._automateMaster(strict ? now : from);
    this._postStretch();
  }

  _startNative(track, segment, stop) {
    const native = this.ctx.createBufferSource();
    native.buffer = track.buffer;
    native.playbackRate.value = segment.rate;
    native.loop = segment.loop.enabled;
    native.loopStart = segment.loop.a;
    native.loopEnd = segment.loop.b;
    native.connect(track.gain);
    const entry = {source: native, when: segment.when, segment, stop: stop ?? null};
    track.nativeSources.add(entry);
    native.onended = () => { native.disconnect(); track.nativeSources.delete(entry); };
    native.start(segment.when, segment.offset);
    if (stop != null) native.stop(stop);
  }

  /**
   * The one native source a segmented entry needs, `{when, offset, stop}`, or
   * null: a pass plays `[offset, b)` from `when` to `until`; a preroll gap plays
   * from `a − sec` (silence before 0) straight through its pass, which then
   * needs none; a silent gap needs none.
   */
  _nativeSpan(segment) {
    if (segment.kind === 'pass') return segment.continuous ? null : {when: segment.when, offset: segment.offset, stop: segment.until};
    if (segment.kind !== 'gap' || segment.mode !== 'preroll') return null;
    return {when: segment.audibleFrom, offset: Math.max(0, segment.offset + (segment.audibleFrom - segment.when) * segment.rate), stop: segment.spanEnd};
  }

  _startSpan(track, segment, {when, offset, stop}) {
    const now = this.ctx.currentTime;
    if (stop <= now + 1e-9) return;
    // An entry appended late (a throttled tab) starts where its timeline is now.
    if (when < now) { offset += (now - when) * segment.rate; when = now; }
    const native = this.ctx.createBufferSource();
    native.buffer = track.buffer;
    native.playbackRate.value = segment.rate;
    native.loop = false;
    native.connect(track.gain);
    const entry = {source: native, when, segment, stop};
    track.nativeSources.add(entry);
    native.onended = () => { native.disconnect(); track.nativeSources.delete(entry); };
    native.start(when, offset);
    native.stop(stop);
  }

  /**
   * Gate automation for one entry, `[[time, value]]`: open for processed
   * audio, shut in gaps. A pass also shuts the gate at its end, so a late tick
   * (a throttled tab) leaves silence after it, never the audio beyond `b`.
   */
  _gateEvents(segment) {
    const open = segment.processing ? 1 : 0;
    if (segment.kind === 'pass') return [[segment.when, open], [segment.until, 0]];
    if (segment.kind !== 'gap') return [[segment.when, open]];
    if (segment.mode !== 'preroll') return [[segment.when, 0]];
    return segment.audibleFrom > segment.when ? [[segment.when, 0], [segment.audibleFrom, open]] : [[segment.when, open]];
  }

  _gateAt(segment, time) {
    if (!segment) return 0;
    if (segment.kind === 'gap') return segment.mode === 'preroll' && time >= segment.audibleFrom - 1e-12 && segment.processing ? 1 : 0;
    if (segment.kind === 'pass' && time >= segment.until - 1e-12) return 0;
    return segment.processing ? 1 : 0;
  }

  /** Whether the plan holds a segmented loop (its master is automated, §5.1 setLoop). */
  _segmented() { return this.plan.some(s => s.kind !== 'play'); }

  /**
   * Rebuild the stems' master automation from `from`: 0 inside silent gaps
   * (up to the next entry, which can cut a gap short), after a pass that has
   * nothing appended yet, during a count-in before the audio starts, and from
   * `stopAtWhen` on; 1 elsewhere.
   */
  _automateMaster(from) {
    const gain = this.master.gain, spans = [];
    this.plan.forEach((s, i) => {
      const next = this.plan[i + 1];
      if (s.kind === 'pass' && !next) { spans.push([s.until, Infinity]); return; }
      if (s.kind !== 'gap' || s.mode === 'preroll') return;
      const end = Math.min(s.until, next?.when ?? s.until);
      if (end > s.when) spans.push([s.when, end]);
    });
    const stop = this.stopAtWhen, count = this.countIn;
    const valueAt = (t) => ((stop != null && t >= stop - 1e-12) || (count && t < count.audioWhen - 1e-12)
      || spans.some(([w, e]) => t >= w - 1e-12 && t < e - 1e-12) ? 0 : 1);
    // The last pass's span is open ([until, Infinity]): valueAt holds it at 0,
    // but an AudioParam takes only finite times, so only finite ends are points.
    const points = new Set();
    for (const [w, e] of spans) for (const t of [w, e]) if (t > from && Number.isFinite(t)) points.add(t);
    if (stop != null && stop > from) points.add(stop);
    gain.cancelScheduledValues(from);
    gain.setValueAtTime(valueAt(from), from);
    for (const t of [...points].sort((x, y) => x - y)) gain.setValueAtTime(valueAt(t), t);
  }

  /** What the processor is told for an entry, or null when it needs no post (gaps are gated). */
  _stretchPost(segment) {
    if (segment.kind === 'play') {
      return {when: segment.when, input: segment.offset, loopStart: segment.loop.enabled ? segment.loop.a : 0, loopEnd: segment.loop.enabled ? segment.loop.b : 0};
    }
    const span = this._nativeSpan(segment);
    return span ? {when: span.when, input: span.offset, loopStart: 0, loopEnd: 0} : null;
  }

  /** Post unposted plan entries to the processor (see the class comment). */
  _postStretch() {
    const stretch = this.stretch;
    if (!stretch) return;
    const now = this.ctx.currentTime;
    const map = this._stretchMap;
    while (map.length > 1 && map[1].when <= now) map.shift();
    for (const segment of this.plan) {
      if (segment.posted) continue;
      const post = this._stretchPost(segment);
      if (!post) { segment.posted = true; continue; }
      if (map.some(m => m.when > now && m.segment && !m.segment.removed)) return;
      const settled = map.reduce((t, m) => (m.when <= now ? Math.max(t, m.when) : t), -Infinity);
      const outputTime = Math.min(Math.max(now, settled + 1e-6), post.when - 1e-6);
      while (map.length && map[map.length - 1].when >= outputTime) map.pop();
      map.push({when: post.when, segment});
      segment.posted = true;
      stretch.schedule({
        active: segment.processing, output: post.when, outputTime, input: post.input, rate: segment.rate, semitones: 0,
        loopStart: post.loopStart, loopEnd: post.loopEnd,
      });
    }
  }

  _stopStretch(now) {
    if (!this.stretch) return;
    this.stretch.stop(now);
    const map = this._stretchMap;
    while (map.length && map[map.length - 1].when >= now) map.pop();
    map.push({when: now, segment: null});
  }

  // ---- building entries -----------------------------------------------------
  /**
   * The entries for playback from `when`: one 'play' entry, or, for a
   * segmented loop (`loop.enabled` and a gap), the pass from `offset` to `b`,
   * its gap and the next pass. With `gapFrom` (the gap audible at `when`) the
   * gap carries on for what is left of it, towards the new loop start.
   */
  _build(when, {offset, seekOffset, rate, loop, scheduled = false, gapFrom = null}) {
    const processing = this.preservePitch && rate !== 1;
    const common = {rate, processing, scheduled, seq: ++this._seq, run: ++this._runs, gapSec: this._gap.sec, gapMode: this._gap.mode};
    if (!loop.enabled || !(this._gap.sec > 0)) return [{kind: 'play', when, offset, seekOffset, ...common, loop: {...loop}}];
    const entries = [];
    let t = when, elapsed = null, continued;
    if (gapFrom && seekOffset == null) {
      const carry = this._carry(gapFrom, when, loop);
      // Preroll audio already inside the new loop plays on as a pass from where it is.
      if (!carry.inLoop) elapsed = carry.elapsed;
      continued = !!gapFrom.continued || gapFrom.when < when - 1e-9;
    } else if (offset >= loop.b - WRAP_EPS) elapsed = 0;
    if (elapsed == null) {
      const pass = this._passEntry(t, offset, 1, false, loop, common);
      if (seekOffset != null) pass.seekOffset = seekOffset;
      entries.push(pass);
      t = pass.until;
      elapsed = 0;
      continued = undefined;
    }
    entries.push(...this._gapAndPass(t, elapsed, entries.length ? 2 : 1, loop, common, continued));
    // Only the change itself is scheduled: the gap and pass after it are the run's own.
    for (let i = 1; i < entries.length; i++) entries[i].scheduled = false;
    return entries;
  }

  /**
   * How the gap `gapFrom`, audible at `when`, carries on into `loop` with the
   * current gap settings: `elapsed`, the media seconds of the new gap already
   * behind. A silent gap carries on by the time it has run. A preroll gap
   * keeps the audio it plays (the new gap reaches `loop.a` from the same
   * media position); `inLoop` when that position is already inside the loop.
   * `moves` when carrying on cannot keep the audible position (a mode change,
   * or less gap left than the preroll still needs): a discontinuity.
   */
  _carry(gapFrom, when, loop) {
    const {sec, mode} = this._gap, dt = Math.max(0, when - gapFrom.when);
    const media = Math.max(0, (gapFrom.elapsed ?? 0) + dt * gapFrom.rate);
    if (mode !== 'preroll' && gapFrom.mode !== 'preroll') return {elapsed: media, inLoop: false, moves: false};
    if (mode !== gapFrom.mode) return {elapsed: Math.min(media, sec), inLoop: false, moves: true};
    const position = gapFrom.offset + dt * gapFrom.rate;
    if (position >= loop.a - 1e-9 && position < loop.b - WRAP_EPS) return {elapsed: sec, inLoop: true, moves: false};
    const elapsed = sec - (loop.a - position);
    return {elapsed: clamp(elapsed, 0, sec), inLoop: false, moves: elapsed < -1e-9};
  }

  _passEntry(when, offset, index, continuous, loop, common) {
    return {kind: 'pass', when, offset, until: when + (loop.b - offset) / common.rate, index, continuous, ...common, loop: {...loop}};
  }

  /** A gap from `when` with `elapsed` media seconds of it already behind, then the pass after it. */
  _gapAndPass(when, elapsed, index, loop, common, continued = elapsed > 1e-9) {
    const {rate, gapSec: sec, gapMode: mode} = common, remaining = sec - elapsed, entries = [];
    let t = when;
    if (remaining > 1e-9) {
      const gap = {kind: 'gap', when, until: when + remaining / rate, target: loop.a, mode, sec, elapsed, continued, ...common, loop: {...loop}};
      gap.offset = mode === 'preroll' ? loop.a - remaining : loop.a;
      if (mode === 'preroll') {
        gap.audibleFrom = when + Math.max(0, -gap.offset) / rate;
        gap.spanEnd = gap.until + (loop.b - loop.a) / rate;
      }
      entries.push(gap);
      t = gap.until;
    }
    entries.push(this._passEntry(t, loop.a, index, mode === 'preroll' && remaining > 1e-9, loop, common));
    return entries;
  }

  /**
   * Keep every segmented run posted one pass ahead: while the plan's last
   * entry is a pass that has started by `t`, append its gap and the next pass
   * (a plan change from the gap's start).
   */
  _extend(t = this.ctx.currentTime) {
    this._promote();
    for (let guard = 0; guard < 10000; guard++) {
      const last = this.plan.at(-1);
      if (!this.playing || !last || last.kind !== 'pass' || last.when > t) return;
      const {rate, processing, seq, run, gapSec, gapMode} = last;
      this._appendPlan(this._gapAndPass(last.until, 0, last.index + 1, last.loop, {rate, processing, scheduled: false, seq, run, gapSec, gapMode}));
    }
  }

  _appendPlan(entries) {
    const now = this.ctx.currentTime, from = entries[0].when;
    for (const segment of entries) {
      if (segment.processing) continue;
      const span = this._nativeSpan(segment);
      if (span) for (const track of this.tracks) this._startSpan(track, segment, span);
    }
    const gate = this.pitchGate?.gain;
    this.plan.push(...entries);
    if (gate) {
      if (from < now) gate.setValueAtTime(this._gateAt(this._segmentAt(now), now), now);
      for (const segment of entries) for (const [t, v] of this._gateEvents(segment)) if (t >= now) gate.setValueAtTime(v, t);
    }
    if (this._segmented()) this._automateMaster(Math.max(from, now));
    this.planVersion++;
    this._emit('plan', {from, version: this.planVersion});
    this._postStretch();
  }

  // An immediate change (a discontinuity). Cancel unrendered changes when a
  // control is moved again, and project the audible segment forward, never
  // accumulated time from old loops. A pending immediate seek survives; a
  // pending scheduled rate or quantized seek is dropped (the user's change wins).
  // In a segmented run, the run's own entries before `when` still play.
  _schedule(offset, when = this.ctx.currentTime + this.lookahead) {
    const now = this.ctx.currentTime;
    this._promote(now);
    this._extend(when);
    const current = this._segmentAt(now);
    const run = current && current.kind !== 'play' ? current.run : null;
    const pending = this.plan.find(s => s.when > now && !s.scheduled && (run == null || s.run !== run));
    const seekOffset = offset ?? pending?.seekOffset;
    const base = run == null ? current : this.plan.findLast(s => s.when <= when && s.run === run);
    let position = seekOffset ?? (base ? this._positionIn(base, when) : this.pausedAt);
    const gapFrom = seekOffset == null && this._continues(base, this.loop) ? base : null;
    if (this.loop.enabled && position >= this.loop.b) position = this.loop.a;
    const segments = this._build(when, {offset: position, seekOffset, rate: this.rate, loop: this.loop, gapFrom});
    this._clearStopAt();
    if (run == null) this._replacePlan(now, segments, {strict: true});
    else this._replacePlan(when, segments, {drop: s => s.when > now && s.run !== run});
    this.revision++;
    this._notifyTransport();
    return when;
  }

  /** A plan change from `cut` (not a discontinuity): planVersion++ and 'plan'. */
  _planChange(cut, {offset, rate, loop, scheduled = false, seekOffset, base = null}) {
    const gapFrom = seekOffset == null && this._continues(base, loop) ? base : null;
    const segments = this._build(cut, {offset, seekOffset, rate, loop, scheduled, gapFrom});
    this._replacePlan(cut, segments);
    this.planVersion++;
    this._emit('plan', {from: cut, version: this.planVersion});
    return segments[0];
  }

  /** Whether a gap audible at a change carries on into `loop` (its target still lies in the loop). */
  _continues(segment, loop) {
    return segment?.kind === 'gap' && loop.enabled && segment.target >= loop.a - 1e-9 && segment.target < loop.b;
  }

  /** The entry audible at `cut`, and what a replacement starting at `cut` inherits from it. */
  _baseAt(cut) {
    this._extend(cut);
    const base = this._segmentAt(cut);
    const replaced = base.when >= cut - 1e-12;
    return {base, seekOffset: replaced ? base.seekOffset : undefined, scheduled: replaced && !!base.scheduled};
  }

  _normalLoop(enabled, a, b) {
    a = Math.max(0, Math.min(a, this.duration));
    b = Math.max(0, Math.min(b, this.duration));
    return { enabled: !!enabled && b - a >= 0.02, a, b };
  }

  // The transport never changes speed, pitch, loop or position during a count
  // (§2.14.3 rule 21: it restarts or cancels the count). If it happens anyway,
  // the count ends at once and the change applies to playback from now.
  _duringCount(method) {
    if (!this.countingIn) return false;
    if (DEV) console.warn(`MultitrackEngine.${method}() during a count-in: the transport restarts or cancels the count instead.`);
    const now = this.ctx.currentTime;
    this.countIn = null;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(1, now + this.lookahead);
    this._emitState();
    return true;
  }

  // ---- transport ----------------------------------------------------------
  async play({countIn = null, audiblePreRoll = false} = {}) {
    if (this.playing || this.destroyed || !this.tracks.length) return;
    const request = ++this.playRequest;
    if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') await this.ctx.resume();
    if (this.destroyed || request !== this.playRequest || this.playing) return;
    let offset = this.pausedAt;
    if (offset >= this.duration) offset = 0;
    this.plan = [];
    this.countIn = null;
    const now = this.ctx.currentTime;
    let when = now + this.lookahead;
    if (countIn?.duration > 0) {
      const startWhen = when;
      const endWhen = startWhen + countIn.duration / this.rate;
      this.countIn = {...countIn, target: offset, startWhen, endWhen, rate: this.rate, audible: audiblePreRoll};
      const startOffset = offset - countIn.duration;
      when = audiblePreRoll ? startWhen + Math.max(0, -startOffset) / this.rate : endWhen;
      offset = audiblePreRoll ? Math.max(0, startOffset) : offset;
      this.countIn.audioWhen = when;
    }
    this._schedule(offset, when);
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(0, now);
    this.master.gain.setValueAtTime(1, when);
    if (this._segmented()) this._automateMaster(when);
    this.aux.gain.cancelScheduledValues(now);
    this.aux.gain.setValueAtTime(1, now);
    this.playing = true;
    this.paused = false;
    this._wrapCursor = now;
    this._startTicker();
    this._emitState();
  }

  pause() {
    this.playRequest++;
    const now = this.ctx.currentTime;
    if (!this.playing) { this._resetTrackGains(now); return; }
    this._promote(now);
    const pendingSeek = this.plan.find(s => s.when > now && s.seekOffset != null && !s.scheduled);
    this.pausedAt = this.countingIn ? this.countIn.target : pendingSeek ? pendingSeek.offset : this.getPosition();
    this.countIn = null;
    this.playing = false;
    this.paused = true;
    this.plan = [];
    this.stopAtWhen = null;
    this._stopTicker();
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(0, now);
    this.aux.gain.cancelScheduledValues(now);
    this.aux.gain.setValueAtTime(0, now);
    this.aux.gain.setValueAtTime(1, now + AUX_RELEASE);
    this._stopStretch(now);
    for (const track of this.tracks) {
      for (const {source} of track.nativeSources) { source.stop(); source.disconnect(); }
      track.nativeSources.clear();
    }
    this._resetTrackGains(now);
    this.revision++;
    this._notifyTransport();
    this._emitState();
  }

  // Stop returns to the selected edit cursor. Pause preserves the audible
  // position without moving that cursor, so auditioning a passage is repeatable.
  stop({returnToEdit = true} = {}) {
    this._stateHold++;
    try {
      this.pause(); // also cancels a pending AudioContext.resume()
      this.seek(returnToEdit ? this.editPosition : this.pausedAt);
      this.paused = false;
    } finally { this._stateHold--; }
    this._emitState();
  }

  /** An immediate seek. `cue: false` leaves `editPosition` (the cue) where it is. */
  seek(time, {cue = true} = {}) {
    if (!Number.isFinite(time)) return;
    this._duringCount('seek');
    let position = Math.max(0, Math.min(time, this.duration));
    if (this.loop.enabled && position >= this.loop.b) position = this.loop.a;
    if (cue) this.editPosition = position;
    this.paused = false;
    if (this.playing) this._schedule(position);
    else this.pausedAt = position;
    this.revision++;
    this._emitState();
  }

  /**
   * A quantized jump: the audible segment continues until `when` (at least
   * one lookahead away), then playback continues from `target`. `loop`
   * (`{enabled, a?, b?}`) changes the loop on the pending segment, so the
   * loop change is part of the jump. Returns the jump's audio time.
   */
  seekAt(target, when, {loop} = {}) {
    if (!Number.isFinite(target) || !Number.isFinite(when)) return null;
    if (!this.playing) {
      if (loop) this.setLoop(loop.enabled, loop.a ?? this.loop.a, loop.b ?? this.loop.b, {gapSec: this._gap.sec, gap: this._gap.mode});
      this.seek(target, {cue: false});
      return null;
    }
    this._duringCount('seekAt');
    this._promote();
    const at = Math.max(when, this.ctx.currentTime + this.lookahead);
    const {base} = this._baseAt(at);
    const nextLoop = loop ? this._normalLoop(loop.enabled, loop.a ?? base.loop.a, loop.b ?? base.loop.b) : base.loop;
    let position = Math.max(0, Math.min(target, this.duration));
    if (nextLoop.enabled && position >= nextLoop.b) position = nextLoop.a;
    this._planChange(at, {offset: position, seekOffset: position, rate: base.rate, loop: nextLoop, scheduled: true, base});
    return at;
  }

  /**
   * Drop the pending scheduled changes (a quantized jump, a scheduled rate):
   * the audible segment continues, with its loop, from one lookahead on.
   * Returns false when nothing was pending.
   */
  cancelPending() {
    if (!this.playing) return false;
    this._promote();
    const cut = this.ctx.currentTime + this.lookahead;
    if (!this.plan.some(s => s.scheduled && !s.promoted && s.when >= cut)) return false;
    // The entry that would be audible at the cut without the pending changes.
    const base = this.plan.filter(s => !(s.scheduled && s.when >= cut)).findLast(s => s.when <= cut) ?? this.plan[0];
    this._planChange(cut, {
      offset: this._positionIn(base, cut), rate: base.rate, loop: base.loop,
      seekOffset: base.when >= cut - 1e-12 ? base.seekOffset : undefined, base,
    });
    return true;
  }

  /**
   * Silence the stems and the aux bus at `when`; the ticker then pauses with
   * the position just before `when` and emits `ended {reason: 'stopAt'}`.
   * A discontinuity clears it; so does cancelStopAt().
   */
  stopAt(when) {
    if (!this.playing || !Number.isFinite(when)) return;
    const at = Math.max(when, this.ctx.currentTime);
    this._clearStopAt();
    this.stopAtWhen = at;
    this.master.gain.setValueAtTime(0, at);
    this.aux.gain.setValueAtTime(0, at);
    // A later gap must not reopen the master.
    if (this._segmented()) this._automateMaster(at);
  }

  /**
   * Cancel a pending stopAt: the stems and the aux bus play on through it.
   * Returns false when none was pending.
   */
  cancelStopAt() {
    if (this.stopAtWhen == null) return false;
    this._clearStopAt();
    return true;
  }

  _clearStopAt() {
    if (this.stopAtWhen == null) return;
    const at = this.stopAtWhen;
    this.master.gain.cancelScheduledValues(at);
    this.aux.gain.cancelScheduledValues(at);
    this.stopAtWhen = null;
    if (this._segmented()) this._automateMaster(at);
  }

  /**
   * Clamped to [MIN_RATE, MAX_RATE]. With a future `at` (beyond the
   * lookahead) the rate changes exactly at `at` and `rate` is promoted then;
   * otherwise the change is immediate.
   */
  setSpeed(rate, {at} = {}) {
    if (!Number.isFinite(rate)) return;
    rate = clamp(rate, MIN_RATE, MAX_RATE);
    this._promote();
    if (this.playing && !this.countingIn && Number.isFinite(at) && at > this.ctx.currentTime + this.lookahead) {
      const {base, seekOffset} = this._baseAt(at);
      this._planChange(at, {offset: this._positionIn(base, at), rate, loop: base.loop, scheduled: true, seekOffset, base});
      return;
    }
    this._duringCount('setSpeed');
    this.rate = rate;
    if (this.playing) this._schedule();
  }

  setPreservePitch(enabled) {
    this._duringCount('setPreservePitch');
    this.preservePitch = !!enabled;
    if (this.playing) this._schedule();
  }

  /**
   * `gapSec = 0`: a gapless loop (native `source.loop`, Signalsmith
   * `loopStart`/`loopEnd`). `gapSec > 0`: a segmented loop, each pass its own
   * entry and source, with a gap of `gapSec` media seconds before every pass
   * from `a` (`gap: 'silent'` holds the stems at 0 and reads `a`;
   * `'preroll'` plays the audio before `a`). Changing it while playing
   * rebuilds the plan from the current position.
   */
  setLoop(enabled, a = this.loop.a, b = this.loop.b, {gapSec = 0, gap = 'silent'} = {}) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    const counted = this._duringCount('setLoop');
    this._promote();
    this._gap = {sec: Number.isFinite(gapSec) && gapSec > 0 ? gapSec : 0, mode: gap === 'preroll' ? 'preroll' : 'silent'};
    this.loop = this._normalLoop(enabled, a, b);
    if (!this.playing) {
      if (this.loop.enabled && this.pausedAt >= this.loop.b) this.pausedAt = this.loop.a;
      return;
    }
    const cut = this.ctx.currentTime + this.lookahead;
    const {base, seekOffset, scheduled} = this._baseAt(cut);
    const position = this._positionIn(base, cut);
    // A loop edit that moves the position is a discontinuity; otherwise the
    // position carries on and only the plan from `cut` changes (a gap whose
    // target is still in the loop carries on towards the new start).
    // A preroll gap that cannot carry on at the same audio (its mode changed,
    // or it now has less left than the audio needs) is a discontinuity too.
    const continues = this._continues(base, this.loop);
    const moves = continues ? this._carry(base, cut, this.loop).moves : this.loop.enabled && position >= this.loop.b - WRAP_EPS;
    if (counted || moves) this._schedule();
    else this._planChange(cut, {offset: position, rate: base.rate, loop: this.loop, seekOffset, scheduled, base});
  }

  // Metronome scheduling uses the same future output timeline as the stems.
  // Gaps carry no song beats (their count-in comes from `gapsBetween`), and
  // nothing is returned at or after `stopAtWhen`.
  beatsBetween(start, end, beats) {
    if (!this.playing) return [];
    if (this.stopAtWhen != null) end = Math.min(end, this.stopAtWhen);
    const events = [];
    for (let i = 0; i < this.plan.length; i++) {
      const segment = this.plan[i];
      if (segment.kind === 'gap') continue;
      let cursor = Math.max(start, segment.when);
      const limit = Math.min(end, this.plan[i + 1]?.when ?? end);
      while (cursor < limit - 1e-8) {
        const pos = this._positionIn(segment, cursor);
        const boundary = segment.loop.enabled ? segment.loop.b : this.duration;
        const until = Math.min(limit, cursor + (boundary - pos) / segment.rate);
        if (until <= cursor + 1e-8) break;
        // Sorted event lookup also supports dense notation without rescanning
        // the entire song for every scheduler window and loop occurrence.
        let low=0,high=beats.length;
        while(low<high){const mid=(low+high)>>1;if(beats[mid].time<pos-1e-8)low=mid+1;else high=mid;}
        for (let index=low;index<beats.length;index++) {
          const beat=beats[index];
          const when = cursor + (beat.time - pos) / segment.rate;
          if (when >= cursor - 1e-8 && when < until - 1e-8) events.push({...beat, when});
          if (when >= until) break;
        }
        cursor = until;
      }
    }
    return events;
  }

  /**
   * The gaps of a segmented loop overlapping `[t0, t1)`, before `stopAtWhen`:
   * `{when, until, target, rate, elapsed, end}`. `until` is where the next
   * pass starts (count-in clicks end there); `end` is where the gap stops
   * being audible (earlier than `until` when a pending change cuts it short);
   * `elapsed` is the media time of the gap already behind `when` (a gap
   * carried on through a change).
   */
  gapsBetween(t0, t1) {
    if (!this.playing) return [];
    const stop = this.stopAtWhen ?? Infinity, gaps = [];
    this.plan.forEach((s, i) => {
      if (s.kind !== 'gap') return;
      const end = Math.min(s.until, this.plan[i + 1]?.when ?? s.until, stop);
      if (s.when < t1 && end > t0 && s.when < stop) gaps.push({when: s.when, until: s.until, target: s.target, rate: s.rate, elapsed: s.elapsed, end});
    });
    return gaps;
  }

  // ---- ticker -------------------------------------------------------------
  _startTicker() { if (this._ticker == null) this._ticker = setInterval(() => this._tick(), TICK_MS); }
  _stopTicker() { if (this._ticker != null) { clearInterval(this._ticker); this._ticker = null; } }

  /** Wraps (arrivals at `b`) and gap starts with `from < when ≤ to`, in time order. */
  _boundariesBetween(from, to) {
    // Nothing plays after a due stopAt: a wrap at the stop is its last boundary.
    const stop = this.stopAtWhen ?? Infinity, out = [];
    this.plan.forEach((seg, i) => {
      const next = this.plan[i + 1];
      if (seg.kind === 'pass') {
        // A pass cut short by a change never arrives at b.
        if (seg.until > from && seg.until <= to + 1e-9 && (!next || next.when >= seg.until - 1e-9)) {
          out.push({type: 'wrap', event: {when: seg.until, a: seg.loop.a, b: seg.loop.b, pass: seg.index}});
        }
      } else if (seg.kind === 'gap') {
        if (!seg.continued && seg.when > from && seg.when <= to + 1e-9) out.push({type: 'gap', event: {when: seg.when, until: seg.until, target: seg.target}});
      }
    });
    for (const wrap of this._wrapsBetween(from, to)) out.push({type: 'wrap', event: wrap});
    // At one instant the wrap (end of a pass) comes before the gap it opens.
    return out.filter(({type, event}) => (type === 'gap' ? event.when < stop - 1e-9 : event.when <= stop + 1e-9)).sort((x, y) => x.event.when - y.event.when || (x.type === 'wrap' ? -1 : 1));
  }

  _wrapsBetween(from, to) {
    const wraps = [];
    for (let i = 0; i < this.plan.length; i++) {
      const seg = this.plan[i];
      if (seg.kind !== 'play' || !seg.loop.enabled) continue;
      const end = Math.min(to, this.plan[i + 1]?.when ?? Infinity);
      const start = Math.max(from, seg.when);
      if (end < start) continue;
      for (let n = this._wrapAfter(seg, start); ; n++) {
        const when = this._wrapTime(seg, n);
        if (when > end + 1e-9) break;
        wraps.push({when, a: seg.loop.a, b: seg.loop.b, pass: n});
      }
    }
    return wraps;
  }

  /**
   * One scheduler step (the 25 ms ticker calls it while playing; tests call
   * it to force a tick): promote started entries, emit each wrap once with its
   * exact audio time, honour `stopAt`, detect the end, report a count's end.
   */
  _tick() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    this._promote(now);
    this._extend(now);
    const index = this.plan.findLastIndex(s => s.when <= now);
    for (const track of this.tracks) {
      if (!track.autoPending?.length) continue;
      const due = track.autoPending.filter(p => p.when <= now);
      if (!due.length) continue;
      track.autoGain = due.reduce((latest, p) => (p.when >= latest.when ? p : latest)).gain;
      track.autoPending = track.autoPending.filter(p => p.when > now);
    }
    const boundaries = this._boundariesBetween(this._wrapCursor, now);
    // A boundary within the tolerance after `now` is emitted now; never again.
    this._wrapCursor = Math.max(now, boundaries.at(-1)?.event.when ?? -Infinity);
    // Where a due stopAt rests, read before the entries behind `now` go.
    const stopAt = this.stopAtWhen, stopPosition = stopAt != null && now >= stopAt - 1e-9 ? this.getPositionAt(stopAt - 1e-4) : null;
    if (index > 0) this.plan = this.plan.slice(index);
    this._postStretch();
    for (const {type, event} of boundaries) {
      if (!this.playing) return;
      this._emit(type, event);
    }
    if (!this.playing) return;
    if (this.stopAtWhen != null && now >= this.stopAtWhen - 1e-9) {
      const position = this.stopAtWhen === stopAt ? stopPosition : this.getPositionAt(this.stopAtWhen - 1e-4);
      this._halt(position);
      this._emit('ended', {reason: 'stopAt'});
      this._emitState();
      return;
    }
    const segment = this._segmentAt(now);
    if (!this.countingIn && segment && !segment.loop.enabled && this.getPosition() >= this.duration) {
      this._halt(this.duration);
      this.onEnded?.();
      this._emit('ended', {reason: 'end'});
      this._emitState();
      return;
    }
    this._emitState();
  }

  /** Pause, then rest at `position` as stopped (not paused). */
  _halt(position) {
    this._stateHold++;
    try {
      this.pause();
      this.pausedAt = position;
      this.paused = false;
    } finally { this._stateHold--; }
  }

  // iOS interrupts audio for calls and Siri; desktop browsers suspend it. Pause
  // so the position is kept; resuming is always the user's choice.
  _onContextState() {
    const state = this.ctx.state;
    if (!this.playing || (state !== 'interrupted' && state !== 'suspended')) return;
    this.pause();
    this._emit('interrupted', {state});
  }

  destroy() {
    this.pause();
    this._stopTicker();
    this.destroyed = true;
    this.transportListeners.clear();
    this._listeners.clear();
    this.ctx.onstatechange = null;
    for (const track of this.tracks) {
      track.merger?.disconnect();
      track.gain.disconnect();
      track.auto?.disconnect();
    }
    this.stretch?.disconnect();
    this.stretch?.port.close();
    this.pitchGate?.disconnect();
    this.splitter?.disconnect();
    this.aux.disconnect();
    this.master.disconnect();
    void this.ctx.close().catch(() => {});
  }
}
