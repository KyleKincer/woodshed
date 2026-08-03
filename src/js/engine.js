// Multitrack Web Audio engine: loads N stems, plays them sample-locked, with
// per-track gain (mute/solo/volume), master seek, varispeed, and a seamless
// A/B loop implemented via native AudioBufferSourceNode looping.

import { fetchStem } from './stemcache.js';

export class MultitrackEngine {
  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.tracks = []; // { name, buffer, gain, source, volume, muted, soloed }
    this.duration = 0;

    this.playing = false;
    this.rate = 1;
    this.startCtxTime = 0; // ctx.currentTime when current playback segment began
    this.startOffset = 0; // media position at that moment
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
        const arr = await fetchStem(s.key, s.url, (l, t) => {
          bytes[i] = { loaded: l, total: t || bytes[i].total };
          report();
        });
        // decodeAudioData detaches the ArrayBuffer it is handed, so a cached
        // buffer reused across stems would fail — each fetch returns its own.
        const buffer = await this.ctx.decodeAudioData(arr);
        decoded++;
        report();
        return { ...s, buffer };
      })
    );
    this.duration = Math.max(...loaded.map((l) => l.buffer.duration));
    this.tracks = loaded.map((l) => {
      const gain = this.ctx.createGain();
      gain.connect(this.master);
      return { name: l.name, color: l.color, buffer: l.buffer, gain, source: null, volume: 1, muted: false, soloed: false };
    });
    this.loop.b = this.duration;
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

  _startSources(offset) {
    const when = this.ctx.currentTime + 0.05;
    for (const t of this.tracks) {
      const src = this.ctx.createBufferSource();
      src.buffer = t.buffer;
      src.playbackRate.value = this.rate;
      if (this.loop.enabled) {
        src.loop = true;
        src.loopStart = this.loop.a;
        src.loopEnd = this.loop.b;
      }
      src.connect(t.gain);
      src.start(when, offset);
      t.source = src;
    }
    this.startCtxTime = when;
    this.startOffset = offset;
  }

  _stopSources() {
    for (const t of this.tracks) {
      if (t.source) {
        try { t.source.stop(); } catch {}
        t.source.disconnect();
        t.source = null;
      }
    }
  }

  async play() {
    if (this.playing) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    let offset = this.pausedAt;
    if (offset >= this.duration - 0.05) offset = 0;
    this._startSources(offset);
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = this.getPosition();
    this._stopSources();
    this.playing = false;
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(time) {
    const t = Math.max(0, Math.min(time, this.duration));
    if (this.playing) {
      this._stopSources();
      this._startSources(t);
    } else {
      this.pausedAt = t;
    }
  }

  setSpeed(rate) {
    const pos = this.getPosition();
    this.rate = rate;
    if (this.playing) {
      // Re-baseline so position math stays correct, and apply to live sources.
      this.startOffset = pos;
      this.startCtxTime = this.ctx.currentTime;
      for (const t of this.tracks) {
        if (t.source) t.source.playbackRate.setValueAtTime(rate, this.ctx.currentTime);
      }
    } else {
      this.pausedAt = pos;
    }
  }

  setLoop(enabled, a, b) {
    this.loop.enabled = enabled;
    if (a != null) this.loop.a = Math.max(0, a);
    if (b != null) this.loop.b = Math.min(this.duration, b);
    // Update live sources without restarting (seamless).
    for (const t of this.tracks) {
      if (t.source) {
        t.source.loop = enabled;
        t.source.loopStart = this.loop.a;
        t.source.loopEnd = this.loop.b;
      }
    }
  }

  getPosition() {
    if (!this.playing) return this.pausedAt;
    let pos = this.startOffset + (this.ctx.currentTime - this.startCtxTime) * this.rate;
    if (this.loop.enabled && this.loop.b > this.loop.a) {
      const len = this.loop.b - this.loop.a;
      if (pos >= this.loop.b) pos = this.loop.a + ((pos - this.loop.a) % len);
    } else if (pos >= this.duration) {
      pos = this.duration;
    }
    return pos;
  }

  // Called by the player's animation frame to detect natural end.
  tickEnd() {
    if (this.playing && !this.loop.enabled && this.getPosition() >= this.duration - 0.02) {
      this.pause();
      this.pausedAt = 0;
      if (this.onEnded) this.onEnded();
    }
  }

  destroy() {
    this._stopSources();
    try { this.ctx.close(); } catch {}
  }
}
