// Native playback is transparent at 1x. Time stretching links every stem channel
// in one processor so spectral phase changes remain coherent across the mix.
import SignalsmithStretch from 'signalsmith-stretch';
import stretchModuleUrl from 'signalsmith-stretch?url';
// Load an emitted same-origin module; do not stringify bundled code into a blob.
SignalsmithStretch.moduleUrl = stretchModuleUrl;
import { fetchStem } from './stemcache.js';
import { decodedStemCache } from './decoded-stem-cache.js';

export class MultitrackEngine {
  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.tracks = [];
    this.stretch = null;
    this.pitchGate = null;
    this.splitter = null;
    this.duration = 0;

    this.playing = false;
    this.rate = 1;
    this.preservePitch = true;
    this.segments = [];
    this.lookahead = 0.05;
    this.destroyed = false;
    this.playRequest = 0;
    this.revision = 0;
    this.pausedAt = 0;
    this.editPosition = 0;
    this.paused = false;
    this.countIn = null;

    this.loop = { enabled: false, a: 0, b: 0 };
    this.onEnded = null;
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
      const gain = this.ctx.createGain();
      gain.connect(this.master);
      return { name: l.name, color: l.color, buffer: l.buffer, gain, nativeSources: new Set(), merger: null, volume: 1, muted: false, soloed: false };
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

  _applyGains() {
    const anySolo = this.tracks.some((t) => t.soloed);
    for (const t of this.tracks) {
      const audible = anySolo ? t.soloed : !t.muted;
      const target = audible ? t.volume : 0;
      t.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.012);
    }
  }

  setVolume(name, v) {
    const t = this.tracks.find((x) => x.name === name);
    if (t) { t.volume = v; this._applyGains(); }
  }
  toggleMute(name) {
    const t = this.tracks.find((x) => x.name === name);
    if (t) { t.muted = !t.muted; this._applyGains(); }
    return t?.muted;
  }
  toggleSolo(name) {
    const t = this.tracks.find((x) => x.name === name);
    if (t) { t.soloed = !t.soloed; this._applyGains(); }
    return t?.soloed;
  }
  resetMixer() {
    for (const t of this.tracks) { t.muted = false; t.soloed = false; t.volume = 1; }
    this._applyGains();
  }

  _positionIn(segment, time) {
    let pos = segment.offset + Math.max(0, time - segment.when) * segment.rate;
    const { enabled, a, b } = segment.loop;
    if (enabled && pos >= b) pos = a + ((pos - a) % (b - a));
    return Math.max(0, Math.min(pos, this.duration));
  }

  _segmentAt(time) {
    return this.segments.findLast(s => s.when <= time) || this.segments[0];
  }

  getPositionAt(time) {
    if (!this.playing || !this.segments.length) return this.pausedAt;
    if (this.countIn && time < this.countIn.endWhen) {
      const c = this.countIn;
      return c.audible ? Math.max(0, c.target - c.duration + Math.max(0, time - c.startWhen) * c.rate) : c.target;
    }
    return this._positionIn(this._segmentAt(time), time);
  }

  getPosition() { return this.getPositionAt(this.ctx.currentTime); }
  get countingIn() { return this.playing && !!this.countIn && this.ctx.currentTime < this.countIn.endWhen; }

  // Cancel an unrendered change when a control is moved again. Project the
  // currently audible segment forward, never accumulated time from old loops.
  _schedule(offset, when = this.ctx.currentTime + this.lookahead) {
    const now = this.ctx.currentTime;
    const current = this._segmentAt(now);
    const pending = this.segments.find(s => s.when > now);
    const seekOffset = offset ?? pending?.seekOffset;
    let position = seekOffset ?? (current ? this._positionIn(current, when) : this.pausedAt);
    if (this.loop.enabled && position >= this.loop.b) position = this.loop.a;
    const processing = this.preservePitch && this.rate !== 1;
    const segment = { when, offset: position, seekOffset, rate: this.rate, loop: {...this.loop}, processing };
    this.segments = current && current.when <= now ? [current, segment] : [segment];
    const change = {
      active: processing, output: when, input: position, rate: this.rate, semitones: 0,
      loopStart: this.loop.enabled ? this.loop.a : 0,
      loopEnd: this.loop.enabled ? this.loop.b : 0,
    };
    this.stretch.schedule(change);
    // The processed and native paths are mutually exclusive at the same output
    // timestamp. Gate the processor tail too, so it cannot comb with dry audio.
    this.pitchGate.gain.cancelScheduledValues(now);
    this.pitchGate.gain.setValueAtTime(current?.when <= now && current.processing ? 1 : 0, now);
    this.pitchGate.gain.setValueAtTime(processing ? 1 : 0, when);
    for (const track of this.tracks) {
      for (const entry of track.nativeSources) {
        if (entry.when > now) {
          entry.source.stop(now);
          entry.source.disconnect();
          track.nativeSources.delete(entry);
        } else {
          // A scheduled stop can be moved when a pending control change is
          // replaced. Sources which have ended remove themselves below.
          entry.source.stop(when);
        }
      }
      if (!processing) {
        const native = this.ctx.createBufferSource();
        native.buffer = track.buffer;
        native.playbackRate.value = this.rate;
        native.loop = this.loop.enabled;
        native.loopStart = this.loop.a;
        native.loopEnd = this.loop.b;
        native.connect(track.gain);
        const entry = {source: native, when};
        track.nativeSources.add(entry);
        native.onended = () => { native.disconnect(); track.nativeSources.delete(entry); };
        native.start(when, position);
      }
    }
    this.revision++;
    return when;
  }

  async play({countIn = null, audiblePreRoll = false} = {}) {
    if (this.playing || this.destroyed || !this.tracks.length) return;
    const request = ++this.playRequest;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.destroyed || request !== this.playRequest || this.playing) return;
    let offset = this.pausedAt;
    if (offset >= this.duration) offset = 0;
    this.segments = [];
    this.countIn = null;
    let when = this.ctx.currentTime + this.lookahead;
    if (countIn?.duration > 0) {
      const startWhen = when;
      const endWhen = startWhen + countIn.duration / this.rate;
      this.countIn = {...countIn, target: offset, startWhen, endWhen, rate: this.rate, audible: audiblePreRoll};
      const startOffset = offset - countIn.duration;
      when = audiblePreRoll ? startWhen + Math.max(0, -startOffset) / this.rate : endWhen;
      offset = audiblePreRoll ? Math.max(0, startOffset) : offset;
    }
    this._schedule(offset, when);
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(0, this.ctx.currentTime);
    this.master.gain.setValueAtTime(1, when);
    this.playing = true;
    this.paused = false;
  }

  pause() {
    this.playRequest++;
    if (!this.playing) return;
    const pendingSeek = this.segments.find(s => s.when > this.ctx.currentTime && s.seekOffset != null);
    this.pausedAt = this.countingIn ? this.countIn.target : pendingSeek ? pendingSeek.offset : this.getPosition();
    this.countIn = null;
    this.playing = false;
    this.paused = true;
    this.segments = [];
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(0, this.ctx.currentTime);
    this.stretch?.stop(this.ctx.currentTime);
    for (const track of this.tracks) {
      for (const {source} of track.nativeSources) { source.stop(); source.disconnect(); }
      track.nativeSources.clear();
    }
    this.revision++;
  }

  // Stop returns to the selected edit cursor. Pause preserves the audible
  // position without moving that cursor, so auditioning a passage is repeatable.
  stop({returnToEdit = true} = {}) {
    this.pause(); // also cancels a pending AudioContext.resume()
    this.seek(returnToEdit ? this.editPosition : this.pausedAt);
    this.paused = false;
  }

  toggle() { return this.playing ? this.stop() : this.play(); }

  seek(time) {
    if (!Number.isFinite(time)) return;
    if (this.countingIn) this.pause();
    let position = Math.max(0, Math.min(time, this.duration));
    if (this.loop.enabled && position >= this.loop.b) position = this.loop.a;
    this.editPosition = position;
    this.paused = false;
    if (this.playing) this._schedule(position);
    else this.pausedAt = position;
    this.revision++;
  }

  setSpeed(rate) {
    if (!Number.isFinite(rate)) return;
    if (this.countingIn) this.pause();
    this.rate = Math.max(0.5, Math.min(1.5, rate));
    if (this.playing) this._schedule();
  }

  setPreservePitch(enabled) {
    if (this.countingIn) this.pause();
    this.preservePitch = !!enabled;
    if (this.playing) this._schedule();
  }

  setLoop(enabled, a = this.loop.a, b = this.loop.b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    if (this.countingIn) this.pause();
    a = Math.max(0, Math.min(a, this.duration));
    b = Math.max(0, Math.min(b, this.duration));
    this.loop = { enabled: !!enabled && b - a >= 0.02, a, b };
    if (this.playing) this._schedule();
    else if (this.loop.enabled && this.pausedAt >= b) this.pausedAt = a;
  }

  // Metronome scheduling uses the same future output timeline as the stems.
  beatsBetween(start, end, beats) {
    if (!this.playing) return [];
    const events = [];
    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i];
      let cursor = Math.max(start, segment.when);
      const limit = Math.min(end, this.segments[i + 1]?.when ?? end);
      while (cursor < limit - 1e-8) {
        const pos = this._positionIn(segment, cursor);
        const boundary = segment.loop.enabled ? segment.loop.b : this.duration;
        const until = Math.min(limit, cursor + (boundary - pos) / segment.rate);
        if (until <= cursor + 1e-8) break;
        for (const beat of beats) {
          const when = cursor + (beat.time - pos) / segment.rate;
          if (when >= cursor - 1e-8 && when < until - 1e-8) events.push({...beat, when});
          if (when >= until) break;
        }
        cursor = until;
      }
    }
    return events;
  }

  tickEnd() {
    const segment = this._segmentAt(this.ctx.currentTime);
    if (this.playing && !this.countingIn && segment && !segment.loop.enabled && this.getPosition() >= this.duration) {
      this.pause();
      this.pausedAt = this.duration;
      this.paused = false;
      this.onEnded?.();
    }
  }

  destroy() {
    this.pause();
    this.destroyed = true;
    for (const track of this.tracks) {
      track.merger?.disconnect();
      track.gain.disconnect();
    }
    this.stretch?.disconnect();
    this.stretch?.port.close();
    this.pitchGate?.disconnect();
    this.splitter?.disconnect();
    this.master.disconnect();
    void this.ctx.close().catch(() => {});
  }
}
