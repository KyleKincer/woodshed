// Tempo-map metronome. Clicks are synthesized on the engine's AudioContext and
// scheduled in *media time* mapped through the engine's current playback rate,
// so they stay locked to the audio at any speed and through loops/seeks.
//
// A tempo map is an ordered list of sections { t, bpm, beatsPerBar, unit }.
// Each section's start time is a downbeat; beats run at 60/bpm until the next
// section (or end of song). One section = a single fixed tempo.

export class Metronome {
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.out = this.ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(this.ctx.destination);

    this.enabled = false;
    this.accent = true;
    this.volume = 0.7;
    this.countIn = false;
    this.map = [{ t: 0, bpm: 120, beatsPerBar: 4, unit: 4 }];
    this.source = 'map';   // 'map' (manual tempo map) | 'detected' (BeatNet)
    this.detected = null;  // [{ time, downbeat }]

    this.beats = [];
    this._timer = null;
    this._schedUntil = 0;
    this._lastPos = 0;
    this.onChange = null; // notified when the map/settings change (for persistence + redraw)
    this.recompute();
  }

  load(tempo) {
    if (!tempo) return;
    if (Array.isArray(tempo.map) && tempo.map.length) this.map = tempo.map.map(normSection);
    if (typeof tempo.accent === 'boolean') this.accent = tempo.accent;
    if (typeof tempo.volume === 'number') this.volume = tempo.volume;
    if (typeof tempo.countIn === 'boolean') this.countIn = tempo.countIn;
    if (Array.isArray(tempo.detected) && tempo.detected.length) this.detected = tempo.detected;
    if (tempo.source === 'detected' && this.detected) this.source = 'detected';
    this.recompute();
    if (tempo.enabled) this.setEnabled(true);
  }

  serialize() {
    return {
      map: this.map, accent: this.accent, volume: this.volume, countIn: this.countIn,
      enabled: this.enabled, source: this.source, detected: this.detected,
    };
  }

  // BeatNet output: [[time, beatInBar], ...] where beatInBar === 1 is a downbeat.
  setDetected(rawBeats) {
    this.detected = rawBeats.map(([time, k]) => ({ time: +time, downbeat: +k === 1 }));
    this.source = 'detected';
    this.recompute();
    this._notify();
  }
  clearDetected() { this.detected = null; this.source = 'map'; this.recompute(); this._notify(); }

  // ---- per-beat manual correction (operates on the beat list) -------------
  _ensureList() { if (!this.detected) this.detected = []; this.source = 'detected'; }
  addBeat(t, downbeat = false) {
    this._ensureList();
    const o = { time: Math.max(0, t), downbeat: !!downbeat };
    this.detected.push(o);
    this.recompute(); this._notify();
    return o;
  }
  removeBeat(o) {
    if (!this.detected) return;
    const i = this.detected.indexOf(o);
    if (i >= 0) { this.detected.splice(i, 1); this.recompute(); this._notify(); }
  }
  moveBeat(o, t) { o.time = Math.max(0, t); this.recompute(); this._notify(); }
  toggleDownbeat(o) { o.downbeat = !o.downbeat; this.recompute(); this._notify(); }
  shiftAll(delta) { if (!this.detected) return; this.detected.forEach((b) => { b.time = Math.max(0, b.time + delta); }); this.recompute(); this._notify(); }
  nearestBeat(t, maxDist) {
    let best = null, bd = Infinity;
    for (const b of this.beats) { const d = Math.abs(b.time - t); if (d < bd) { bd = d; best = b; } }
    return best && bd <= maxDist ? best : null;
  }

  // ---- tempo map ----------------------------------------------------------
  recompute() {
    if (this.source === 'detected' && this.detected && this.detected.length) {
      this.beats = this.detected.filter((b) => b.time >= 0).sort((a, b) => a.time - b.time);
      return;
    }
    const dur = this.engine.duration || 0;
    this.map.sort((a, b) => a.t - b.t);
    const beats = [];
    for (let i = 0; i < this.map.length; i++) {
      const s = this.map[i];
      const end = i + 1 < this.map.length ? this.map[i + 1].t : dur;
      const interval = 60 / Math.max(20, Math.min(400, s.bpm));
      const n = Math.max(1, s.beatsPerBar | 0);
      let k = 0;
      for (let t = s.t; t < end - 1e-6 && beats.length < 100000; t += interval, k++) {
        if (t >= 0) beats.push({ time: t, downbeat: k % n === 0 });
      }
    }
    this.beats = beats;
  }

  sectionAt(t) {
    let s = this.map[0];
    for (const sec of this.map) if (sec.t <= t + 1e-6) s = sec; else break;
    return s;
  }

  setMap(map) { this.map = map.map(normSection); this.recompute(); this._notify(); }

  setSection(t, patch) {
    const s = this.sectionAt(t);
    Object.assign(s, patch);
    this.recompute();
    this._notify();
  }

  addChangeAt(t, bpm, beatsPerBar, unit) {
    // Snap onto an existing section start if very close.
    const existing = this.map.find((s) => Math.abs(s.t - t) < 0.04);
    if (existing) { Object.assign(existing, { bpm, beatsPerBar, unit }); }
    else this.map.push(normSection({ t: Math.max(0, t), bpm, beatsPerBar, unit }));
    this.recompute();
    this._notify();
  }

  removeSectionAt(t) {
    if (this.map.length <= 1) return false;
    const i = this.map.findIndex((s) => Math.abs(s.t - t) < 1e-6);
    if (i === -1) return false;
    this.map.splice(i, 1);
    this.recompute();
    this._notify();
    return true;
  }

  // Re-anchor the active section's downbeat to time t (keeps its tempo/sig).
  setDownbeatAt(t) { this.setSection(t, {}); const s = this.sectionAt(t); s.t = Math.max(0, t); this.recompute(); this._notify(); }

  setAccent(b) { this.accent = b; this._notify(); }
  setVolume(v) { this.volume = v; this._notify(); }
  setCountIn(b) { this.countIn = b; this._notify(); }

  _notify() { if (this.onChange) this.onChange(); }

  // ---- enable + scheduling ------------------------------------------------
  setEnabled(b) {
    this.enabled = b;
    if (b) this.start(); else this.stop();
    this._notify();
  }

  start() {
    if (this._timer) return;
    this._schedUntil = this.engine.getPosition();
    this._timer = setInterval(() => this.tick(), 25);
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  tick() {
    if (!this.enabled || !this.engine.playing) { this._schedUntil = this.engine.getPosition(); return; }
    const pos = this.engine.getPosition();
    const now = this.ctx.currentTime;
    const rate = this.engine.rate || 1;
    // Reset the scheduling cursor when the playhead jumps (loop wrap / seek).
    if (pos < this._lastPos - 0.05 || pos > this._schedUntil + 1) this._schedUntil = pos;
    this._lastPos = pos;

    const loop = this.engine.loop;
    const maxMedia = loop.enabled && loop.b > loop.a ? loop.b : (this.engine.duration || 1e9);
    const windowEnd = Math.min(pos + 0.12 * rate, maxMedia);

    for (const b of this.beats) {
      if (b.time > this._schedUntil && b.time <= windowEnd) {
        const ctxTime = now + (b.time - pos) / rate;
        if (ctxTime >= now) this._click(ctxTime, b.downbeat && this.accent);
      }
    }
    if (windowEnd > this._schedUntil) this._schedUntil = windowEnd;
  }

  // One free bar of clicks before playback; calls onDone when the bar elapses.
  countInThenPlay(onDone) {
    const pos = this.engine.getPosition();
    let interval, n;
    if (this.source === 'detected' && this.beats.length > 1) {
      const idx = Math.max(0, this.beats.findIndex((b) => b.time >= pos));
      const a = this.beats[idx], b = this.beats[idx + 1] || this.beats[idx];
      interval = Math.max(0.15, b.time - a.time || 0.5);
      // beats per bar = gap between the two downbeats around the cursor (default 4)
      const dbs = this.beats.filter((x) => x.downbeat).map((x) => x.time);
      const di = dbs.findIndex((t) => t >= pos);
      n = di > 0 ? Math.max(1, Math.round((dbs[di] - dbs[di - 1]) / interval)) : 4;
    } else {
      const s = this.sectionAt(pos);
      interval = 60 / Math.max(20, Math.min(400, s.bpm));
      n = Math.max(1, s.beatsPerBar | 0);
    }
    const now = this.ctx.currentTime + 0.12;
    for (let k = 0; k < n; k++) this._click(now + k * interval, k === 0 && this.accent);
    setTimeout(onDone, n * interval * 1000);
  }

  _click(ctxTime, accent) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1050;
    const v = Math.max(0.0001, this.volume) * (accent ? 1 : 0.8);
    g.gain.setValueAtTime(0.0001, ctxTime);
    g.gain.exponentialRampToValueAtTime(v, ctxTime + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, ctxTime + 0.05);
    osc.connect(g).connect(this.out);
    osc.start(ctxTime);
    osc.stop(ctxTime + 0.06);
  }

  beatsForView(t0, t1) { return this.beats.filter((b) => b.time >= t0 && b.time <= t1); }

  destroy() { this.stop(); try { this.out.disconnect(); } catch {} }
}

function normSection(s) {
  return {
    t: Math.max(0, +s.t || 0),
    bpm: Math.max(20, Math.min(400, Math.round(+s.bpm || 120))),
    beatsPerBar: Math.max(1, Math.min(16, (s.beatsPerBar | 0) || 4)),
    unit: [1, 2, 4, 8, 16].includes(s.unit) ? s.unit : 4,
  };
}
