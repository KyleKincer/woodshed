// The song's single tempo/meter map, shared by the metronome, beat grid,
// bar readout and drum transcription. Edits are transactions with undo.
import {fraction, number, beatGroups, MAX_MEASURES} from '../../shared/notation.ts';
import {compile, timeAt, positionAt, velocityAt, beatsOf, linesOf, measureStarts, barIndexAt, pulseOf, normalize, MIN_QPM, MAX_QPM,
  validateSongMap, cleanSongMap, defaultSongMap, fromSections, fromBeats, fromTimeline, toTimeline} from '../../shared/song-map.ts';

const clone = (value) => structuredClone(value);
const UNDO_LIMIT = 200;

export class SongMapStore {
  constructor(data, duration, {legacy = null} = {}) {
    this.duration = Math.max(0.001, duration || 0);
    // While the map is still a translation of the pre-1.6 format, saving keeps
    // the original fields untouched; the first real edit makes it a song map.
    this.legacy = legacy;
    this.undoStack = []; this.redoStack = [];
    this.batch = null;
    this.listeners = new Set();
    this.guards = new Map();
    this._set(normalize(clone(data), this.duration, (id) => this._kept(id)));
  }

  static fromTempo(tempo, duration) {
    const store = new SongMapStore(defaultSongMap(Math.max(0.001, duration || 0)), duration);
    store.load(tempo);
    return store;
  }

  /** Read a stored tempo object: a saved song map wins over the legacy fields. */
  load(tempo) {
    const stored = cleanSongMap(tempo?.songMap);
    let data, legacy = null;
    if (stored) data = stored;
    else {
      const detected = Array.isArray(tempo?.detected) && tempo.detected.length && tempo.source === 'detected' ? tempo.detected : null;
      const sections = Array.isArray(tempo?.map) && tempo.map.length ? tempo.map : null;
      try {
        data = detected ? fromBeats(detected.map(b => ({time: +b.time, downbeat: !!b.downbeat})), this.duration) : sections ? fromSections(sections, this.duration) : defaultSongMap(this.duration);
        validateSongMap(data);
      } catch { data = defaultSongMap(this.duration); }
      legacy = {map: tempo?.map ?? null, detected: tempo?.detected ?? null, source: tempo?.source ?? 'map'};
    }
    this.legacy = legacy;
    this.undoStack = []; this.redoStack = [];
    this._set(normalize(data, this.duration, (id) => this._kept(id)));
    this._emit('load');
  }

  // ---- change plumbing ----------------------------------------------------
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /**
   * A named guard throws to refuse a map (e.g. bars whose notes would no
   * longer fit); `keep(id)` protects bars from being trimmed off the end.
   */
  setGuard(name, guard) { this.guards.set(name, guard); return () => { if (this.guards.get(name) === guard) this.guards.delete(name); }; }
  _kept(id) { for (const guard of this.guards.values()) if (guard.keep?.(id)) return true; return false; }
  /** Whether any bar after `index` holds drum notation (re-barring would shift it). */
  notationAfter(index) { return this.data.measures.slice(index + 1).some((m) => this._kept(m.id)); }
  _emit(reason) { for (const listener of [...this.listeners]) listener(reason); }

  _set(data) {
    this.data = data;
    this.compiled = compile(data);
    this._starts = null; this._beats = null; this._lines = null; this._timeline = null; this._barCount = null;
  }

  /** Apply `change(draft)`; returns its result. Throws (and changes nothing) when invalid. */
  edit(change, reason = 'edit') {
    const draft = clone(this.data);
    const result = change(draft);
    // Down to one pin, the tempo after it would otherwise reset to a default.
    if (draft.pins.length === 1 && !draft.tailQpm) draft.tailQpm = Math.max(MIN_QPM, Math.min(MAX_QPM, this.compiled.tail * 60));
    normalize(draft, this.duration, (id) => this._kept(id));
    validateSongMap(draft);
    const extent = draft.measures.reduce((q, m) => q + number(m.length), 0);
    if (draft.measures.length >= MAX_MEASURES && timeAt(compile(draft), extent) < this.duration - 1e-3)
      throw new Error('That tempo needs more than 1024 bars to cover the song.');
    const timeline = toTimeline(draft);
    for (const guard of this.guards.values()) guard(timeline, draft);
    if (JSON.stringify(draft) === JSON.stringify(this.data)) return result;
    if (!this.batch) { this.undoStack.push(this.data); if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift(); }
    else this.batch.changed = true;
    this.redoStack = [];
    this.legacy = null;
    this._set(draft);
    this._emit(reason);
    return result;
  }

  /** Group many edits (a tap pass) into one undo step. */
  beginBatch() { if (!this.batch) this.batch = {before: this.data, changed: false}; }
  endBatch() {
    const batch = this.batch; this.batch = null;
    if (batch?.changed) { this.undoStack.push(batch.before); if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift(); }
  }

  undo() { return this._step(this.undoStack, this.redoStack); }
  redo() { return this._step(this.redoStack, this.undoStack); }
  _step(from, to) {
    if (this.batch) this.endBatch();
    const target = from.pop();
    if (!target) return false;
    try { for (const guard of this.guards.values()) guard(toTimeline(target), target); }
    catch (error) { from.push(target); throw error; }
    to.push(this.data);
    this.legacy = null;
    this._set(target);
    this._emit('undo');
    return true;
  }

  replace(next, reason = 'replace') { return this.edit((d) => { for (const key of Object.keys(d)) delete d[key]; Object.assign(d, clone(next)); }, reason); }
  /** Detection rebuilds bars; bar N keeps its id so drum notes stay attached to it. */
  replaceFromBeats(beats) {
    const next = fromBeats(beats, this.duration);
    next.measures.forEach((m, i) => { if (this.data.measures[i]) m.id = this.data.measures[i].id; });
    return this.replace(next);
  }
  /** Use a stored map only if it is valid; otherwise leave the current map alone. */
  adopt(data) { const clean = cleanSongMap(data); if (!clean) return false; this.load({songMap: clean}); return true; }
  replaceFromTimeline(timeline) { return this.replace(fromTimeline(timeline, this.duration)); }

  serialize() { return clone(this.data); }

  // ---- queries --------------------------------------------------------------
  get starts() { return this._starts ??= measureStarts(this.data.measures); }
  get beats() { return this._beats ??= beatsOf(this.data, this.compiled, this.duration); }
  /** Every bar line and counted beat as a musical position, for navigation. */
  get lines() { return this._lines ??= linesOf(this.data); }
  timeline() { return this._timeline ??= toTimeline(this.data); }
  /** Bars that start inside the recording. */
  get barCount() { return this._barCount ??= Math.max(1, this.starts.filter((q) => this.timeAt(q) < this.duration - 1e-6).length); }
  get pins() { return this.compiled.pins; }

  timeAt(q) { return timeAt(this.compiled, typeof q === 'number' ? q : number(q)); }
  positionAt(t) { return positionAt(this.compiled, t); }
  barIndexAt(q) { return barIndexAt(this.data, q, this.starts); }
  measure(index) { return this.data.measures[index]; }
  barStart(index) { return this.starts[index]; }
  /** Tempo in the bar's felt pulse (♩, ♩. or ♪) at a musical position. */
  bpmAt(q) { const m = this.measure(this.barIndexAt(q)); return velocityAt(this.compiled, q) * 60 / pulseOf(m); }
  /** Quarter notes per minute at a recording time: continuous across meter changes. */
  qpmAt(time) { return velocityAt(this.compiled, this.positionAt(time)) * 60; }
  pulseLabel(index) { const m = this.measure(index), p = pulseOf(m); return p === 1.5 ? '♩.' : p === 0.5 ? '♪' : p === 2 ? '𝅗𝅥' : p === 0.25 ? '𝅘𝅥𝅯' : p === 3 ? '𝅗𝅥.' : '♩'; }
  beatsPerBarAt(time) { return beatGroups(this.measure(this.barIndexAt(this.positionAt(time)))).length; }

  /** The pin-bounded span around a position: its pins, tempos and whether it is open. */
  spanAt(q) {
    const pins = this.compiled.pins;
    let before = -1;
    for (let i = 0; i < pins.length; i++) if (number(pins[i].position) <= q + 1e-9) before = i;
    const from = pins[before] || null, to = pins[before + 1] || null;
    const span = before >= 0 ? this.compiled.spans[before] : null;
    const bar = this.barIndexAt(q), pulse = pulseOf(this.measure(bar));
    const startBpm = (span ? span.v0 : before < 0 ? this.compiled.head : this.compiled.tail) * 60 / pulse;
    const endBpm = (span ? span.v1 : before < 0 ? this.compiled.head : this.compiled.tail) * 60 / pulse;
    return {index: before, from, to, ramp: !!span?.ramp, startBpm, endBpm, open: before < 0 ? 'head' : !to ? 'tail' : null};
  }

  /** Bar (1-based) and beat at a recording time; bar 0 before the first bar. */
  positionLabel(time) {
    const q = this.positionAt(time);
    if (q < -1e-9) return {bar: 0, beat: 0};
    const index = this.barIndexAt(q), m = this.measure(index), offset = q - number(this.starts[index]);
    let beat = 1, end = 0;
    for (const group of beatGroups(m)) { end += group * 4 / m.denominator; if (offset < end - 1e-7) break; beat++; }
    return {bar: index + 1, beat: Math.min(beat, beatGroups(m).length)};
  }

  /** Nearest bar line or beat to a recording time, as a navigation line. */
  nearestLine(time, {bars = false} = {}) {
    const lines = bars ? this.lines.filter((l) => l.downbeat) : this.lines;
    let best = lines[0], distance = Infinity;
    for (const line of lines) { const d = Math.abs(this.timeAt(line.q) - time); if (d < distance) { best = line; distance = d; } }
    return best;
  }
}

export {fraction};
