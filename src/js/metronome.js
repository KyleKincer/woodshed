// Metronome. Clicks are synthesized on the engine's AudioContext and
// scheduled in *media time* mapped through the engine's plan, so they stay
// locked to the audio at any speed and through loops, gaps and seeks.
//
// Every click comes from the song map (see song-map.js): bars with meters,
// some bar lines or beats pinned to the recording, tempo derived between pins.
// The click settings are the session's `practice.click` (D14, D51): the
// transport applies them with `configure()`. `tempo` stores only the map.
import { SongMapStore, LABEL_REASONS } from './song-map.js';
import { defaultSongMap } from '../../shared/song-map.ts';

/** How far ahead clicks are scheduled (audio seconds). */
const AHEAD = 0.12;
const TICK_MS = 25;
export const CLICK_MODES = Object.freeze(['off', 'countin', 'always']);
const CACHE_LIMIT = 16;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const countLength = (n) => clamp(Math.round(+n || 1), 1, 16);

function remember(cache, key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

function freezePlan(plan) {
  for (const beat of plan.beats) Object.freeze(beat);
  Object.freeze(plan.beats);
  return Object.freeze(plan);
}

export class Metronome {
  /**
   * @param {import('./engine.js').MultitrackEngine} engine
   * @param {SongMapStore} [songMap] the session's store. Without one the
   *   metronome builds a placeholder store (the 1.9 player only; deleted at I1).
   */
  constructor(engine, songMap = null) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.out = this.ctx.createGain();
    this.out.gain.value = 1;
    // The engine's aux bus is silenced with the stems by stopAt and pause.
    this.out.connect(engine.aux ?? this.ctx.destination);

    // Click settings (D14). `mode` drives the two internal flags:
    // `enabled` (the continuous click) and `countInAudible` (count clicks sound).
    this.mode = 'countin';
    this._lastMode = 'countin';
    this.enabled = false;
    this.countInAudible = true;
    this.accent = true;
    this.volume = 0.7;
    this.countIn = false;
    this.countInLength = 1;
    this.countInUnit = 'bars';
    this.audiblePreRoll = false;

    this.beats = [];
    this._timer = null;
    this._schedUntil = 0;
    this._scheduledClicks = new Set();
    this._clickWhen = new WeakMap();
    this._transportRevision = -1;
    this._beatListeners = new Set();
    // Beats before this were reported already (a settings change reschedules the same beats).
    this._reportedUntil = -Infinity;
    this._plans = new Map();
    this._rests = new Map();
    this.onChange = null; // notified when the map changes (for persistence and redraw)
    this.songMap = songMap || new SongMapStore(defaultSongMap(engine.duration || 1), engine.duration || 1);
    this._unsubscribe = this.songMap.subscribe((reason) => this._onMap(reason));
    // A discontinuity drops every scheduled click; a plan change drops only the
    // clicks at or after the change and reschedules from there.
    this._engineOff = [
      engine.on?.('transport', () => { this._cancelClicks(); this._transportRevision = engine.revision; this._schedUntil = this.ctx.currentTime; this._reportedUntil = -Infinity; }),
      engine.on?.('plan', ({from}) => { this._cancelClicks(from); this._schedUntil = Math.min(this._schedUntil, from); this._reportedUntil = -Infinity; }),
      // The metronome runs by itself while the engine plays and it has work.
      engine.on?.('state', ({playing}) => { if (playing && this._wantsRun()) this.start(); }),
    ].filter(Boolean);
    this.recompute();
  }

  /** Load a stored `tempo` object: only its map (D51; old click fields are read by `upgradePractice`). */
  load(tempo) {
    if (!tempo) return;
    this.songMap.load(tempo);
  }

  /** What `tempo` stores: the map, nothing else (D51). */
  serialize() {
    return {songMap: this.songMap.serialize()};
  }

  // Detection output: [[time, beatInBar], ...] where beatInBar === 1 is a downbeat.
  setDetected(rawBeats) {
    this.songMap.replaceFromBeats(rawBeats.map(([time, k]) => ({time: +time, downbeat: +k === 1})));
  }

  recompute() { this.beats = this.songMap.beats; }

  /** Legacy section shape at a recording time: {t, bpm, beatsPerBar, unit}. */
  sectionAt(t) {
    const map = this.songMap, q = map.positionAt(t), index = Math.max(0, map.barIndexAtQ(q)), m = map.measure(index);
    return {t: map.timeAt(map.barStart(index)), bpm: map.bpmAt(q), beatsPerBar: map.beatsPerBarAt(t), unit: m.denominator};
  }

  // Map edits no longer pause the engine during a count (the transport
  // decides, §2.14.3 rule 21). Clicks not yet sounded follow the new map, but
  // a label-only edit moves no beat and leaves them alone.
  _onMap(reason) {
    this.recompute();
    if (!LABEL_REASONS.includes(reason)) this._reschedule();
    this.onChange?.(reason);
  }

  // ---- settings -------------------------------------------------------------
  /**
   * Apply the click settings (`practice.click`, D14). Every field is optional;
   * missing ones keep their value. `mode`: `'always'` → the continuous click;
   * `'countin'` → count clicks only; `'off'` → a silent count (the beats are
   * still reported through `onBeat`). Clicks not yet sounded follow the new
   * settings at once; a running count carries on. Returns `settings()`.
   */
  configure({countIn, countInLength, countInUnit, mode, accent, volume, audiblePreRoll} = {}) {
    if (typeof countIn === 'boolean') this.countIn = countIn;
    if (countInLength !== undefined) this.countInLength = countLength(countInLength);
    if (countInUnit !== undefined) this.countInUnit = countInUnit === 'beats' ? 'beats' : 'bars';
    if (CLICK_MODES.includes(mode)) {
      this.mode = mode;
      if (mode !== 'always') this._lastMode = mode;
    }
    if (typeof accent === 'boolean') this.accent = accent;
    if (Number.isFinite(volume)) this.volume = clamp(volume, 0, 1);
    if (typeof audiblePreRoll === 'boolean') this.audiblePreRoll = audiblePreRoll;
    this.enabled = this.mode === 'always';
    this.countInAudible = this.mode !== 'off';
    if (this._wantsRun()) {
      this._reschedule({beatsMoved: false});
      if (this.engine.playing) this.start();
    } else this.stop();
    return this.settings();
  }

  /** The current click settings, in `configure()`'s shape. */
  settings() {
    return {countIn: this.countIn, countInLength: this.countInLength, countInUnit: this.countInUnit, mode: this.mode,
      accent: this.accent, volume: this.volume, audiblePreRoll: this.audiblePreRoll};
  }

  // The 1.9 player's and map mode's controls (deprecated; the transport calls
  // configure()). They notify `onChange` as before.
  setAccent(b) { this._legacySet({accent: !!b}); }
  setVolume(v) { this._legacySet({volume: +v}); }
  setCountIn(b) { this._legacySet({countIn: !!b}); }
  setCountInLength(n) { this._legacySet({countInLength: n}); }
  setCountInUnit(unit) { this._legacySet({countInUnit: unit}); }
  setAudiblePreRoll(b) { this._legacySet({audiblePreRoll: !!b}); }
  /** The continuous click on or off: `mode` 'always', or back to the last other mode. */
  setEnabled(b) { this._legacySet({mode: b ? 'always' : this._lastMode}); }
  _legacySet(fields) { this.configure(fields); this.onChange?.(); }

  // ---- visual click -----------------------------------------------------------
  /**
   * `fn({when, downbeat, unit, kind, audible})` for every beat the metronome
   * schedules, sounding or not (a silent count still counts the lamps):
   * `unit` is the meter unit of the beat in its bar (the lamp index, D15);
   * `kind` is 'count' (a count-in, first or between passes), 'rest' (a rest
   * bar between passes) or 'click' (the continuous click). Beats are reported
   * up to 0.12 s ahead; an engine 'plan' event invalidates those at or after
   * its `from`, a 'transport' event all of them. Returns the unsubscribe function.
   */
  onBeat(fn) {
    this._beatListeners.add(fn);
    return () => { this._beatListeners.delete(fn); };
  }

  // ---- scheduling -----------------------------------------------------------
  /** Whether there is anything to schedule: the click, a count, or the gaps of a segmented loop. */
  _wantsRun() {
    const engine = this.engine;
    return this.enabled || this.countIn || !!engine.countingIn || (engine.loopGap?.sec > 0 && !!engine.loop?.enabled);
  }

  start() {
    if (this._timer) return;
    this._schedUntil = this.ctx.currentTime;
    this._timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop() { this._stopTimer(); this._cancelClicks(); }

  _stopTimer() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  /**
   * Drop the clicks that have not sounded and schedule again from now. When
   * only the sound changed (`beatsMoved: false`), the beats already reported
   * through `onBeat` are not reported again.
   */
  _reschedule({beatsMoved = true} = {}) {
    const now = this.ctx.currentTime;
    this._cancelClicks(now);
    this._reportedUntil = beatsMoved ? -Infinity : Math.max(this._reportedUntil, this._schedUntil);
    this._schedUntil = now;
    if (this._timer) this.tick();
  }

  /** Stop the tracked clicks scheduled at or after `from` (all of them by default). */
  _cancelClicks(from = -Infinity) {
    for (const osc of this._scheduledClicks) {
      if (this._clickWhen.get(osc) < from - 1e-9) continue;
      try { osc.stop(); } catch {}
      this._scheduledClicks.delete(osc);
    }
  }

  tick() {
    const now = this.ctx.currentTime, engine = this.engine;
    if (this._transportRevision !== engine.revision) {
      this._cancelClicks();
      this._transportRevision = engine.revision;
      this._schedUntil = now;
      this._reportedUntil = -Infinity;
    }
    if (!this._wantsRun()) { this.stop(); return; }
    if (!engine.playing) {
      this._cancelClicks();
      this._schedUntil = now;
      // The engine's 'state' event starts the metronome again with playback.
      if (typeof engine.on === 'function') this._stopTimer();
      return;
    }
    const end = now + AHEAD;
    const start = Math.max(now, this._schedUntil);
    const limit = Math.min(end, engine.stopAtWhen ?? Infinity);
    const countIn = engine.countIn;
    if (countIn) {
      for (const beat of countIn.beats) {
        const when = countIn.startWhen + beat.offset / countIn.rate;
        if (when >= start && when < limit) this._beat(when, beat, 'count', this.countInAudible);
      }
    }
    // Every-pass count-ins and rest bars inside the gaps of a segmented loop.
    // Unmapped songs never click (the transport uses a lead-in instead).
    if (this.songMap.isReal) {
      for (const gap of engine.gapsBetween?.(start, limit) ?? []) this._gapBeats(gap, start, Math.min(limit, gap.end ?? gap.until));
    }
    if (this.enabled) {
      for (const beat of engine.beatsBetween(Math.max(start, countIn?.endWhen ?? start), end, this.beats)) {
        this._beat(beat.when, {downbeat: beat.downbeat, unit: this._unitAt(beat.time)}, 'click', true);
      }
    }
    this._schedUntil = end;
  }

  /**
   * The beats of one gap in `[from, to)`: the count-in for its target, ending
   * where the next pass starts (`until − (plan.duration − offset) / rate`),
   * and before it, when the gap is longer than the count (a rest bar), every
   * counted beat of the loop start's bar at its tempo, downbeat accented.
   */
  _gapBeats(gap, from, to) {
    const rate = gap.rate || this.engine.rate || 1;
    const plan = this.countIn ? this.countInPlanAt(gap.target) : null;
    const countStart = plan ? gap.until - plan.duration / rate : gap.until;
    if (plan) {
      for (const beat of plan.beats) {
        const when = gap.until - (plan.duration - beat.offset) / rate;
        if (when >= gap.when - 1e-9 && when >= from && when < to) this._beat(when, beat, 'count', this.countInAudible);
      }
    }
    const restStart = gap.when - (gap.elapsed ?? 0) / rate;
    if (countStart - restStart <= 1e-3) return;
    const rest = this._restBar(gap.target);
    if (!(rest.duration > 0)) return;
    for (let bar = 0; restStart + bar / rate < countStart - 1e-6; bar += rest.duration) {
      for (const beat of rest.beats) {
        const when = restStart + (bar + beat.offset) / rate;
        if (when >= countStart - 1e-6) return;
        if (when >= gap.when - 1e-9 && when >= from && when < to) this._beat(when, beat, 'rest', this.mode !== 'off');
      }
    }
  }

  /** The bar at `t` as a rest bar: its counted beats `{offset, downbeat, unit}` at its own tempo. */
  _restBar(t) {
    const map = this.songMap, key = `${t}|${map.revision}|${map.duration}`;
    const cached = this._rests.get(key);
    if (cached) return cached;
    const bar = map.bars[map.barIndexAt(t)], unit = 4 / bar.denominator, secondsPerQuarter = 60 / bar.qpm, beats = [];
    let q = 0, u = 0;
    for (const group of bar.groups) {
      beats.push({offset: q * secondsPerQuarter, downbeat: u === 0, unit: u});
      q += group * unit;
      u += group;
    }
    return remember(this._rests, key, freezePlan({duration: bar.units * unit * secondsPerQuarter, beats}));
  }

  _unitAt(time) { return this.songMap.barBeatAt(time).unitIndex; }

  _beat(when, {downbeat, unit}, kind, audible) {
    if (audible) this._click(when, !!downbeat && this.accent, true);
    if (!this._beatListeners.size || when < this._reportedUntil - 1e-9) return;
    const event = {when, downbeat: !!downbeat, unit: unit ?? 0, kind, audible};
    for (const fn of [...this._beatListeners]) {
      try { fn(event); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }

  // ---- count-in ---------------------------------------------------------------
  /**
   * The count-in for a start at media time `t` (a start at or after the end
   * counts in to 0): `{duration, beats: [{offset, downbeat, unit}]}`, read-only.
   * `countInLength` bars (at the meter at `t`) or beats, following the map's
   * tempo and extrapolating before the first and after the last beat. Cached
   * per target, length, unit and map revision.
   */
  countInPlanAt(t) {
    const duration = this.engine.duration;
    const pos = !Number.isFinite(t) ? 0 : duration > 0 && t >= duration ? 0 : Math.max(0, t);
    const map = this.songMap, key = `${pos}|${this.countInLength}|${this.countInUnit}|${map.revision}|${map.duration}`;
    return this._plans.get(key) ?? remember(this._plans, key, freezePlan(this._countIn(pos)));
  }

  _countIn(pos) {
    const n = Math.max(1, this.songMap.beatsPerBarAt(pos));
    const count = this.countInLength * (this.countInUnit === 'bars' ? n : 1);
    const grid = this.beats.length ? this.beats : [{time: pos, downbeat: true}];
    const fallback = 60 / Math.max(20, Math.min(400, this.songMap.bpmAt(this.songMap.positionAt(pos)) || 120));
    const firstInterval = grid.length > 1 ? Math.max(0.15, grid[1].time - grid[0].time) : fallback;
    const lastInterval = grid.length > 1 ? Math.max(0.15, grid.at(-1).time - grid.at(-2).time) : fallback;
    const lastDownbeat = grid.findLastIndex(b => b.downbeat);
    const at = i => i < 0 ? {time: grid[0].time + i * firstInterval, downbeat: i % n === 0}
      : i >= grid.length ? {time: grid.at(-1).time + (i - grid.length + 1) * lastInterval, downbeat: (i - Math.max(0, lastDownbeat)) % n === 0} : grid[i];
    let index = grid.findLastIndex(b => b.time <= pos + 1e-6);
    if (index < 0) index = Math.floor((pos - grid[0].time) / firstInterval);
    else if (index === grid.length - 1) index += Math.floor((pos - grid.at(-1).time) / lastInterval);
    const fraction = (pos - at(index).time) / Math.max(0.001, at(index + 1).time - at(index).time);
    const start = at(index - count).time + fraction * (at(index - count + 1).time - at(index - count).time);
    const beats = [];
    for (let i = index - count; i <= index; i++) {
      const beat = at(i);
      if (beat.time >= start - 1e-6 && beat.time < pos - 1e-6) beats.push({offset: Math.max(0, beat.time - start), downbeat: beat.downbeat, unit: this._unitAt(beat.time)});
    }
    return {duration: pos - start, beats};
  }

  // ---- sound ------------------------------------------------------------------
  /**
   * One click at audio time `when` that no cancellation stops (tap
   * calibration, previews). It plays through the aux bus, which is open while
   * stopped.
   */
  clickAt(when, accent = false) { this._oscillator(when, accent, false); }

  /** @deprecated Use `clickAt` (untracked); the 1.9 map mode calls this until I1. */
  _click(ctxTime, accent, tracked = false) { this._oscillator(ctxTime, accent, tracked); }

  // Tracked clicks are dropped by the transport's and the plan's cancellations.
  _oscillator(ctxTime, accent, tracked) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1050;
    const v = Math.max(0.0001, this.volume) * (accent ? 1 : 0.8);
    g.gain.setValueAtTime(0.0001, ctxTime);
    g.gain.exponentialRampToValueAtTime(v, ctxTime + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, ctxTime + 0.05);
    osc.connect(g).connect(this.out);
    if (tracked) { this._scheduledClicks.add(osc); this._clickWhen.set(osc, ctxTime); }
    osc.onended = () => { this._scheduledClicks.delete(osc); osc.disconnect(); g.disconnect(); };
    osc.start(ctxTime);
    osc.stop(ctxTime + 0.06);
  }

  destroy() {
    this.stop();
    this._unsubscribe();
    for (const off of this._engineOff) off();
    this._beatListeners.clear();
    try { this.out.disconnect(); } catch {}
  }
}
