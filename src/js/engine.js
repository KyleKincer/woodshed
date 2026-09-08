// All stems share an output-time transport and pitch-preserving worklet schedules.
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
    this.tracks = []; // { name, buffer, gain, source, volume, muted, soloed }
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
    this.tracks = loaded.map((l) => {
      const gain = this.ctx.createGain();
      gain.connect(this.master);
      return { name: l.name, color: l.color, buffer: l.buffer, gain, source: null, volume: 1, muted: false, soloed: false };
    });
    this.loop.b = this.duration;
    // Buffered worklets compensate their own algorithm latency. Use one shared
    // output timestamp for every stem, including later speed/loop changes.
    await Promise.all(this.tracks.map(async (track) => {
      const source = await SignalsmithStretch(this.ctx);
      if (this.destroyed) { source.disconnect(); source.port.close(); return; }
      track.source = source;
      source.connect(track.gain);
      const channels = Array.from({length: track.buffer.numberOfChannels},
        (_, c) => track.buffer.getChannelData(c).slice());
      await source.addBuffers(channels, channels.map(c => c.buffer));
      this.lookahead = Math.max(this.lookahead, await source.latency() + 0.02);
    }));
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
    return this._positionIn(this._segmentAt(time), time);
  }

  getPosition() { return this.getPositionAt(this.ctx.currentTime); }

  // Cancel an unrendered change when a control is moved again. Project the
  // currently audible segment forward, never accumulated time from old loops.
  _schedule(offset) {
    const now = this.ctx.currentTime;
    const when = now + this.lookahead;
    const current = this._segmentAt(now);
    const pending = this.segments.find(s => s.when > now);
    const seekOffset = offset ?? pending?.seekOffset;
    let position = seekOffset ?? (current ? this._positionIn(current, when) : this.pausedAt);
    if (this.loop.enabled && position >= this.loop.b) position = this.loop.a;
    const segment = { when, offset: position, seekOffset, rate: this.rate, loop: {...this.loop} };
    this.segments = current && current.when <= now ? [current, segment] : [segment];
    const change = {
      active: true, output: when, input: position, rate: this.rate,
      semitones: this.preservePitch ? 0 : 12 * Math.log2(this.rate),
      loopStart: this.loop.enabled ? this.loop.a : 0,
      loopEnd: this.loop.enabled ? this.loop.b : 0,
    };
    for (const track of this.tracks) track.source.schedule(change);
    this.revision++;
    return when;
  }

  async play() {
    if (this.playing || this.destroyed || !this.tracks.length) return;
    const request = ++this.playRequest;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.destroyed || request !== this.playRequest || this.playing) return;
    let offset = this.pausedAt;
    if (offset >= this.duration) offset = 0;
    this.segments = [];
    const when = this._schedule(offset);
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(0, this.ctx.currentTime);
    this.master.gain.setValueAtTime(1, when);
    this.playing = true;
  }

  pause() {
    this.playRequest++;
    if (!this.playing) return;
    this.pausedAt = this.getPosition();
    this.playing = false;
    this.segments = [];
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(0, this.ctx.currentTime);
    for (const track of this.tracks) track.source?.stop(this.ctx.currentTime);
    this.revision++;
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  seek(time) {
    if (!Number.isFinite(time)) return;
    let position = Math.max(0, Math.min(time, this.duration));
    if (this.loop.enabled && position >= this.loop.b) position = this.loop.a;
    if (this.playing) this._schedule(position);
    else this.pausedAt = position;
    this.revision++;
  }

  setSpeed(rate) {
    if (!Number.isFinite(rate)) return;
    this.rate = Math.max(0.5, Math.min(1.5, rate));
    if (this.playing) this._schedule();
  }

  setPreservePitch(enabled) {
    this.preservePitch = !!enabled;
    if (this.playing) this._schedule();
  }

  setLoop(enabled, a = this.loop.a, b = this.loop.b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
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
    if (this.playing && segment && !segment.loop.enabled && this.getPosition() >= this.duration) {
      this.pause();
      this.pausedAt = this.duration;
      this.onEnded?.();
    }
  }

  destroy() {
    this.pause();
    this.destroyed = true;
    for (const track of this.tracks) {
      track.source?.disconnect();
      track.source?.port.close();
      track.gain.disconnect();
    }
    this.master.disconnect();
    void this.ctx.close().catch(() => {});
  }
}
