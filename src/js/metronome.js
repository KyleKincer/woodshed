// Metronome. Clicks are synthesized on the engine's AudioContext and
// scheduled in *media time* mapped through the engine's current playback rate,
// so they stay locked to the audio at any speed and through loops/seeks.
//
// Every click comes from the song map (see song-map.js): bars with meters,
// some bar lines or beats pinned to the recording, tempo derived between pins.
import { SongMapStore } from './song-map.js';
import { defaultSongMap } from '../../shared/song-map.ts';

export class Metronome {
  constructor(engine, songMap = null) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.out = this.ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(this.ctx.destination);

    this.enabled = false;
    this.accent = true;
    this.volume = 0.7;
    this.countIn = false;
    this.countInLength = 1;
    this.countInUnit = 'bars';
    this.audiblePreRoll = false;

    this.beats = [];
    this._timer = null;
    this._schedUntil = 0;
    this._lastPos = 0;
    this._scheduledClicks = new Set();
    this._transportRevision = -1;
    this.onChange = null; // notified when the map/settings change (for persistence + redraw)
    // A song with no saved tempo has no map yet either: treat it like the legacy
    // default so an existing drum part's timing can still be adopted.
    this.songMap = songMap || new SongMapStore(defaultSongMap(engine.duration || 1), engine.duration || 1, {legacy: {map: null, detected: null, source: 'map'}});
    this._unsubscribe = this.songMap.subscribe(() => { this.recompute(); this._notify(); });
    this.recompute();
  }

  load(tempo) {
    if (!tempo) return;
    if (typeof tempo.accent === 'boolean') this.accent = tempo.accent;
    if (typeof tempo.volume === 'number') this.volume = tempo.volume;
    if (typeof tempo.countIn === 'boolean') this.countIn = tempo.countIn;
    this.countInLength = Math.max(1, Math.min(16, Math.round(+tempo.countInLength || 1)));
    this.countInUnit = tempo.countInUnit === 'beats' ? 'beats' : 'bars';
    this.audiblePreRoll = tempo.audiblePreRoll === true;
    this.songMap.load(tempo);
    this.recompute();
    if (tempo.enabled) this.setEnabled(true);
  }

  serialize() {
    const settings = {
      accent: this.accent, volume: this.volume, countIn: this.countIn,
      countInLength: this.countInLength, countInUnit: this.countInUnit, audiblePreRoll: this.audiblePreRoll,
      enabled: this.enabled,
    };
    // Untouched pre-1.6 maps are saved as they were. Otherwise save the song
    // map, plus its pulses in the old detected-beat shape so earlier desktop
    // versions still hear the same clicks.
    if (this.songMap.legacy) return {...settings, ...this.songMap.legacy};
    return {...settings, songMap: this.songMap.serialize(), source: 'detected', map: [],
      detected: this.beats.map((b) => ({time: b.time, downbeat: b.downbeat}))};
  }

  // Detection output: [[time, beatInBar], ...] where beatInBar === 1 is a downbeat.
  setDetected(rawBeats) {
    this.songMap.replaceFromBeats(rawBeats.map(([time, k]) => ({time: +time, downbeat: +k === 1})));
  }

  recompute() { this.beats = this.songMap.beats; }

  /** Legacy section shape at a recording time: {t, bpm, beatsPerBar, unit}. */
  sectionAt(t) {
    const map = this.songMap, q = map.positionAt(t), index = Math.max(0, map.barIndexAt(q)), m = map.measure(index);
    return {t: map.timeAt(map.barStart(index)), bpm: map.bpmAt(q), beatsPerBar: map.beatsPerBarAt(t), unit: m.denominator};
  }

  setAccent(b) { this.accent = b; this._notify(false); }
  setVolume(v) { this.volume = v; this._notify(false); }
  setCountIn(b) { this.countIn = b; this._notify(); }
  setCountInLength(n) { this.countInLength = Math.max(1, Math.min(16, Math.round(+n || 1))); this._notify(); }
  setCountInUnit(unit) { this.countInUnit = unit === 'beats' ? 'beats' : 'bars'; this._notify(); }
  setAudiblePreRoll(b) { this.audiblePreRoll = !!b; this._notify(); }

  _notify(cancelCountIn = true) {
    if (cancelCountIn && this.engine.countingIn) { this.engine.pause(); this._cancelClicks(); }
    if (this.onChange) this.onChange();
  }

  // ---- enable + scheduling ------------------------------------------------
  setEnabled(b) {
    this.enabled = b;
    if (b || this.engine.countingIn) this.start(); else this.stop();
    this._notify(false);
  }

  start() {
    if (this._timer) return;
    this._schedUntil = this.ctx.currentTime;
    this._timer = setInterval(() => this.tick(), 25);
    this.tick();
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; this._cancelClicks(); }

  _cancelClicks() {
    for (const osc of this._scheduledClicks) { try { osc.stop(); } catch {} }
    this._scheduledClicks.clear();
  }

  tick() {
    const now = this.ctx.currentTime;
    if (this._transportRevision !== this.engine.revision) {
      this._cancelClicks();
      this._transportRevision = this.engine.revision;
      this._schedUntil = now;
    }
    if (!this.enabled && !this.engine.countingIn) { this.stop(); return; }
    if (!this.engine.playing) { this._cancelClicks(); this._schedUntil = now; return; }
    const end = now + 0.12;
    const start = Math.max(now, this._schedUntil);
    const countIn = this.engine.countIn;
    if (countIn) {
      for (const beat of countIn.beats) {
        const when = countIn.startWhen + beat.offset / countIn.rate;
        if (when >= start && when < end) this._click(when, beat.downbeat && this.accent);
      }
    }
    if (this.enabled) {
      for (const beat of this.engine.beatsBetween(Math.max(start, countIn?.endWhen ?? start), end, this.beats)) {
        this._click(beat.when, beat.downbeat && this.accent);
      }
    }
    this._schedUntil = end;
  }

  // Build a media-time lead-in; the engine schedules it on the audio clock.
  countInPlan() {
    const pos = this.engine.getPosition() >= this.engine.duration ? 0 : this.engine.getPosition();
    const n = Math.max(1, this.songMap.beatsPerBarAt(pos));
    const count = this.countInLength * (this.countInUnit === 'bars' ? n : 1);
    const grid = this.beats.length ? this.beats : [{time:pos,downbeat:true}];
    const fallback = 60 / Math.max(20, Math.min(400, this.songMap.bpmAt(this.songMap.positionAt(pos)) || 120));
    const firstInterval = grid.length > 1 ? Math.max(0.15, grid[1].time - grid[0].time) : fallback;
    const lastInterval = grid.length > 1 ? Math.max(0.15, grid.at(-1).time - grid.at(-2).time) : fallback;
    const lastDownbeat = grid.findLastIndex(b => b.downbeat);
    const at = i => i < 0 ? {time:grid[0].time + i * firstInterval,downbeat:i % n === 0}
      : i >= grid.length ? {time:grid.at(-1).time + (i - grid.length + 1) * lastInterval,downbeat:(i - Math.max(0,lastDownbeat)) % n === 0} : grid[i];
    let index = grid.findLastIndex(b => b.time <= pos + 1e-6);
    if (index < 0) index = Math.floor((pos - grid[0].time) / firstInterval);
    else if (index === grid.length - 1) index += Math.floor((pos - grid.at(-1).time) / lastInterval);
    const fraction = (pos - at(index).time) / Math.max(0.001, at(index+1).time - at(index).time);
    const start = at(index-count).time + fraction * (at(index-count+1).time - at(index-count).time);
    const beats = [];
    for (let i = index-count; i <= index; i++) {
      const beat = at(i);
      if (beat.time >= start - 1e-6 && beat.time < pos - 1e-6) beats.push({offset:Math.max(0,beat.time-start),downbeat:beat.downbeat});
    }
    return {duration:pos-start, beats};
  }

  // Untracked clicks (tap calibration) survive the transport's click cancellation.
  _click(ctxTime, accent, tracked = true) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1050;
    const v = Math.max(0.0001, this.volume) * (accent ? 1 : 0.8);
    g.gain.setValueAtTime(0.0001, ctxTime);
    g.gain.exponentialRampToValueAtTime(v, ctxTime + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, ctxTime + 0.05);
    osc.connect(g).connect(this.out);
    if (tracked) this._scheduledClicks.add(osc);
    osc.onended = () => { this._scheduledClicks.delete(osc); osc.disconnect(); g.disconnect(); };
    osc.start(ctxTime);
    osc.stop(ctxTime + 0.06);
  }

  beatsForView(t0, t1) { return this.beats.filter((b) => b.time >= t0 && b.time <= t1); }

  destroy() { this.stop(); this._unsubscribe(); try { this.out.disconnect(); } catch {} }
}
