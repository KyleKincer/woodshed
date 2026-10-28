// The song's single tempo/meter map, shared by the metronome, beat grid,
// bar readout and drum transcription. Edits are transactions with undo, and
// every edit stamps where the map came from (`origin`, architecture §4.2).
import {fraction, number, beatGroups, MAX_MEASURES} from '../../shared/notation.ts';
import {sameContent} from '../../shared/content.ts';
import {compile, timeAt, positionAt, velocityAt, beatsOf, linesOf, measureStarts, barIndexAt as barIndexAtQ, pulseOf, normalize, MIN_QPM, MAX_QPM,
  validateSongMap, cleanSongMap, defaultSongMap, fromBeats, fromTimeline, toTimeline, songMapFromTempo, barsOf, sectionsFromBars, isMadeLegacyMap} from '../../shared/song-map.ts';

const clone = (value) => structuredClone(value);
const UNDO_LIMIT = 200;
const EPS = 1e-9;

/**
 * The origin each edit reason stamps (exhaustive). `null` keeps the data's own
 * origin. Every `edit`/`replace` call names one of these reasons.
 */
export const REASON_ORIGIN = Object.freeze({
  pin: 'edited', nudge: 'edited', renumber: 'edited', meter: 'edited', unpin: 'edited', ramp: 'edited', tempo: 'edited',
  scale: 'edited', bar: 'edited', drag: 'edited', label: 'edited', sections: 'edited', edit: 'edited',
  tap: 'tapped', tapBeat: 'tapped',
  detect: 'detected',
  'tempo-source': 'imported', timeline: 'imported', 'part-fit': 'imported', adopt: 'imported',
  restore: null, 'tempo-source-cancel': null,
});
/** Label-only reasons never cancel an active count-in (§4.2). */
export const LABEL_REASONS = Object.freeze(['label', 'sections']);

const withoutOrigin = ({origin, ...rest}) => rest;
const sameMap = (a, b) => sameContent(withoutOrigin(a), withoutOrigin(b));
const entry = (data, linked = []) => ({data, linked});

export class SongMapStore {
  constructor(data, duration) {
    this.duration = Math.max(0.001, duration || 0);
    this.undoStack = []; this.redoStack = [];
    this.batch = null;
    this.listeners = new Set();
    this.guards = new Map();
    this._revision = 0;
    this._hasPart = false;
    this._quiet = 0;
    this._set(normalize(clone(data), this.duration, (id) => this._kept(id)));
  }

  static fromTempo(tempo, duration) {
    const store = new SongMapStore(defaultSongMap(Math.max(0.001, duration || 0)), duration);
    store.load(tempo);
    return store;
  }

  /** Read a stored tempo object through the one-way upgrade (`songMapFromTempo`); clears undo. */
  load(tempo) {
    const data = songMapFromTempo(tempo, this.duration);
    this.undoStack = []; this.redoStack = []; this.batch = null;
    this._set(normalize(data, this.duration, (id) => this._kept(id)));
    this._emit('load');
  }

  // ---- change plumbing ----------------------------------------------------
  /** `listener(reason, {reason, revision})` runs after every data change except `setDuration`. */
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /**
   * A named guard throws to refuse a map (e.g. bars whose notes would no
   * longer fit); `keep(id)` protects bars from being trimmed off the end.
   */
  setGuard(name, guard) { this.guards.set(name, guard); return () => { if (this.guards.get(name) === guard) this.guards.delete(name); }; }
  _kept(id) { for (const guard of this.guards.values()) if (guard.keep?.(id)) return true; return false; }
  _guard(data) { const timeline = toTimeline(data); for (const guard of this.guards.values()) guard(timeline, data); }
  /** Whether any bar after `index` holds drum notation (re-barring would shift it). */
  notationAfter(index) { return this.data.measures.slice(index + 1).some((m) => this._kept(m.id)); }
  _emit(reason) { const event = {reason, revision: this._revision}; for (const listener of [...this.listeners]) listener(reason, event); }

  _set(data) {
    this.data = data;
    this.compiled = compile(data);
    this._revision++;
    this._clearCaches();
  }
  _clearCaches() {
    this._starts = null; this._beats = null; this._lines = null; this._timeline = null; this._barCount = null;
    this._bars = null; this._sections = null; this._barT0 = null; this._barIds = null;
  }
  /** A stored step's data, re-normalised in case `setDuration` ran since it was recorded. */
  _fit(data) { return normalize(clone(data), this.duration, (id) => this._kept(id)); }
  _push(stack, item) { stack.push(item); if (stack.length > UNDO_LIMIT) stack.shift(); }

  /** Bumps on every data change, including `restore` and `setDuration`. */
  get revision() { return this._revision; }
  /** A map someone made (any origin), or a song with a drum part. */
  get isReal() { return !!this.data.origin || this._hasPart; }
  setHasPart(on) { this._hasPart = !!on; }

  /**
   * Re-normalise for the decoded length, keeping notation bars. Silent: no
   * event, no undo step and no save; the next real save writes it.
   */
  setDuration(seconds) {
    const duration = Math.max(0.001, seconds || 0);
    if (Math.abs(duration - this.duration) < 1e-9) return;
    this.duration = duration;
    this.data = normalize(clone(this.data), this.duration, (id) => this._kept(id));
    this.compiled = compile(this.data);
    this._revision++;
    this._clearCaches();
  }

  /**
   * Apply `change(draft)` and return its result. Throws (and changes nothing)
   * when the result is invalid or a guard refuses it. The origin is stamped
   * from `REASON_ORIGIN[reason]` (or `origin`) only when the map really
   * changed; `linked.undo()`/`linked.redo()` run with this step's undo and redo.
   * The generic reason is `'edit'`; an unknown reason throws.
   */
  edit(change, reason = 'edit', {origin, linked} = {}) {
    if (!Object.prototype.hasOwnProperty.call(REASON_ORIGIN, reason)) throw new TypeError(`Unknown song-map edit reason: ${reason}`);
    const draft = clone(this.data);
    const result = change(draft);
    // Down to one pin, the tempo after it would otherwise reset to a default.
    if (draft.pins.length === 1 && !draft.tailQpm) draft.tailQpm = Math.max(MIN_QPM, Math.min(MAX_QPM, this.compiled.tail * 60));
    normalize(draft, this.duration, (id) => this._kept(id));
    const stamp = origin ?? REASON_ORIGIN[reason];
    if (stamp) draft.origin = stamp;
    validateSongMap(draft);
    const extent = draft.measures.reduce((q, m) => q + number(m.length), 0);
    if (draft.measures.length >= MAX_MEASURES && timeAt(compile(draft), extent) < this.duration - 1e-3)
      throw new Error('That tempo needs more than 1024 bars to cover the song.');
    this._guard(draft);
    // Reasons that keep the data's own origin (restore, cancel) also change it; the others never stamp a no-op.
    if (stamp ? sameMap(draft, this.data) : sameContent(draft, this.data)) return result;
    this._commit(draft, reason, linked);
    return result;
  }

  /**
   * Record a real change: an open batch collects it (even inside `withoutUndo`,
   * so `abortBatch` can still undo it); otherwise one map-stack step, except
   * inside `withoutUndo`, where the caller records it on the practice stack (D23).
   */
  _commit(next, reason, linked) {
    if (this.batch) { this.batch.changed = true; if (linked) this.batch.linked.push(linked); }
    else if (!this._quiet) this._push(this.undoStack, entry(this.data, linked ? [linked] : []));
    this.redoStack = [];
    this._set(next);
    this._emit(reason);
  }

  /** Edits inside `fn` push nothing on the map stack. */
  withoutUndo(fn) {
    this._quiet++;
    try { return fn(this); } finally { this._quiet--; }
  }

  /** A deep copy of the data, origin included. */
  snapshot() { return clone(this.data); }

  /** Set data with no undo entry, keeping its origin; emits `'restore'`. Throws when it is invalid or a guard refuses it. */
  restore(data) {
    const next = this._fit(data);
    validateSongMap(next);
    if (sameContent(next, this.data)) return false;
    this._guard(next);
    if (this.batch) this.batch.changed = true;
    this._set(next);
    this._emit('restore');
    return true;
  }

  /** Group many edits (a tap pass, a drag, an audition) into one undo step. An edit during a batch joins it. */
  beginBatch() { if (!this.batch) this.batch = {before: this.data, changed: false, linked: [], redo: [...this.redoStack]}; }
  endBatch() {
    const batch = this.batch; this.batch = null;
    if (batch?.changed) this._push(this.undoStack, entry(batch.before, batch.linked));
    return !!batch?.changed;
  }
  /** Drop an open batch: restore the data from `beginBatch` silently (one `'restore'` event); both stacks stay exactly as they were. */
  abortBatch() {
    const batch = this.batch; this.batch = null;
    if (!batch) return false;
    this.redoStack = batch.redo;
    if (!batch.changed) return false;
    this._set(this._fit(batch.before));
    for (const link of [...batch.linked].reverse()) link.undo();
    this._emit('restore');
    return true;
  }

  /** Undo and redo never close an open batch: they do nothing until it ends. */
  undo() { return this._step(this.undoStack, this.redoStack, 'undo'); }
  redo() { return this._step(this.redoStack, this.undoStack, 'redo'); }
  _step(from, to, reason) {
    if (this.batch) return false;
    const target = from.pop();
    if (!target) return false;
    const data = this._fit(target.data);
    try { this._guard(data); }
    catch (error) { from.push(target); throw error; }
    to.push(entry(this.data, target.linked));
    this._set(data);
    if (reason === 'undo') for (const link of [...target.linked].reverse()) link.undo();
    else for (const link of target.linked) link.redo();
    this._emit(reason);
    return true;
  }

  /** Replace the whole map as one edit; `reason` decides the origin ('tempo-source' → imported, 'tapBeat' → tapped). */
  replace(next, reason) {
    if (reason === undefined) throw new TypeError('SongMapStore.replace needs a reason.');
    return this.edit((d) => { for (const key of Object.keys(d)) delete d[key]; Object.assign(d, clone(next)); }, reason);
  }
  /** Detection rebuilds bars; bar N keeps its id so drum notes stay attached to it. */
  replaceFromBeats(beats, reason = 'detect') {
    const next = fromBeats(beats, this.duration);
    next.measures.forEach((m, i) => { if (this.data.measures[i]) m.id = this.data.measures[i].id; });
    return this.replace(next, reason);
  }
  /** A drum part's timeline becomes the map ('part-fit' when a stored part did not fit). */
  replaceFromTimeline(timeline, reason = 'timeline') { return this.replace(fromTimeline(timeline, this.duration), reason); }
  /**
   * Use a stored map only if it is valid; otherwise leave the current map
   * alone (returns false). Keeps a valid origin; data without one is upgraded
   * like `load`: a map someone made (rule 3) is stamped `imported`, the
   * untouched placeholder stays without an origin (not real).
   * A change is an ordinary step emitting `'adopt'`: an open batch collects
   * it, `withoutUndo` pushes nothing (open-time drum-part adoption and silent
   * foreign adoption wrap it there), otherwise it is one map-stack step.
   */
  adopt(data) {
    const clean = cleanSongMap(data);
    if (!clean) return false;
    if (!clean.origin && isMadeLegacyMap(clean)) clean.origin = REASON_ORIGIN.adopt;
    const next = normalize(clean, this.duration, (id) => this._kept(id));
    if (!sameContent(next, this.data)) this._commit(next, 'adopt');
    return true;
  }

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
  /** Measure index at a musical position (quarters). */
  barIndexAtQ(q) { return barIndexAtQ(this.data, q, this.starts); }
  measure(index) { return this.data.measures[index]; }
  barStart(index) { return this.starts[index]; }
  /** Tempo in the bar's felt pulse (♩, ♩. or ♪) at a musical position. */
  bpmAt(q) { const m = this.measure(this.barIndexAtQ(q)); return velocityAt(this.compiled, q) * 60 / pulseOf(m); }
  /** Quarter notes per minute at a recording time: continuous across meter changes. */
  qpmAt(time) { return velocityAt(this.compiled, this.positionAt(time)) * 60; }
  pulseLabel(index) { const m = this.measure(index), p = pulseOf(m); return p === 1.5 ? '♩.' : p === 0.5 ? '♪' : p === 2 ? '𝅗𝅥' : p === 0.25 ? '𝅘𝅥𝅯' : p === 3 ? '𝅗𝅥.' : '♩'; }
  beatsPerBarAt(time) { return beatGroups(this.measure(this.barIndexAtQ(this.positionAt(time)))).length; }

  /** The pin-bounded span around a position: its pins, tempos and whether it is open. */
  spanAt(q) {
    const pins = this.compiled.pins;
    let before = -1;
    for (let i = 0; i < pins.length; i++) if (number(pins[i].position) <= q + 1e-9) before = i;
    const from = pins[before] || null, to = pins[before + 1] || null;
    const span = before >= 0 ? this.compiled.spans[before] : null;
    const bar = this.barIndexAtQ(q), pulse = pulseOf(this.measure(bar));
    const startBpm = (span ? span.v0 : before < 0 ? this.compiled.head : this.compiled.tail) * 60 / pulse;
    const endBpm = (span ? span.v1 : before < 0 ? this.compiled.head : this.compiled.tail) * 60 / pulse;
    return {index: before, from, to, ramp: !!span?.ramp, startBpm, endBpm, open: before < 0 ? 'head' : !to ? 'tail' : null};
  }

  /**
   * Bar (1-based) and beat at a recording time; bar 0 before the first bar.
   * Only the 1.9 player (`src/js/player.js`) reads it, and it is deleted with
   * that module at I1; new code uses `barBeatAt`.
   */
  positionLabel(time) {
    const q = this.positionAt(time);
    if (q < -1e-9) return {bar: 0, beat: 0};
    const index = this.barIndexAtQ(q), m = this.measure(index), offset = q - number(this.starts[index]);
    let beat = 1, end = 0;
    for (const group of beatGroups(m)) { end += group * 4 / m.denominator; if (offset < end - 1e-7) break; beat++; }
    return {bar: index + 1, beat: Math.min(beat, beatGroups(m).length)};
  }

  /** Nearest bar line or beat to a recording time, as a navigation line (linear: not for per-frame use). */
  nearestLine(time, {bars = false} = {}) {
    const lines = bars ? this.lines.filter((l) => l.downbeat) : this.lines;
    let best = lines[0], distance = Infinity;
    for (const line of lines) { const d = Math.abs(this.timeAt(line.q) - time); if (d < distance) { best = line; distance = d; } }
    return best;
  }

  // ---- bar/time helpers (architecture §4.3; built once per data change) --------
  /** Bars starting inside the recording: display numbers, meter, groups, tempo. */
  get bars() { return this._bars ??= barsOf(this.data, this.duration, this.compiled); }
  get sections() { return this._sections ??= sectionsFromBars(this.bars); }
  get hasSections() { return this.sections.length > 0; }
  get _t0s() { return this._barT0 ??= Float64Array.from(this.bars, (b) => b.t0); }
  get _ids() { return this._barIds ??= new Map(this.bars.map((b, i) => [b.id, i])); }

  /** Listed bar index at a recording time (binary search over bar starts); before bar 0 → 0. */
  barIndexAt(t) {
    const t0s = this._t0s;
    let low = 0, high = t0s.length - 1, found = 0;
    while (low <= high) { const mid = (low + high) >> 1; if (t0s[mid] <= t + EPS) { found = mid; low = mid + 1; } else high = mid - 1; }
    return found;
  }

  /** Quarter-note onsets (from the bar start) and lengths of the counted beats inside a bar, as `beatsOf` clicks them. */
  _onsets(bar) {
    const out = [], length = bar.q1 - bar.q0, unit = 4 / bar.denominator;
    let q = 0;
    for (const g of bar.groups) { if (q >= length - 1e-7) break; out.push({q, length: g * unit}); q += g * unit; }
    return out;
  }
  /** Display beat of a bar's first onset: a pickup counts from the end of its bar, like `beatsOf`. */
  _firstBeat(bar, onsets) { return bar.pickup ? bar.groups.length - onsets.length + 1 : 1; }
  _unitOffset(bar) { return bar.pickup ? bar.units - Math.ceil((bar.q1 - bar.q0) / (4 / bar.denominator) - 1e-7) : 0; }

  /** The bar the model counts in before bar 0: bar 0's meter, or the first full bar's when bar 0 is a pickup. */
  _beforeRef() { const [first, second] = this.bars; return first.pickup && second ? second : first; }
  /** Counted-beat onsets (quarters) of the extrapolated bars before bar 0 that lie in (from, bar 0's start). */
  _onsetsBefore(from) {
    const ref = this._beforeRef(), unit = 4 / ref.denominator, length = ref.units * unit, end = this.bars[0].q0, out = [];
    for (let start = ref.q0 + Math.floor((from - ref.q0) / length) * length; start < end - 1e-9; start += length) {
      let q = start;
      for (const g of ref.groups) { if (q > from + 1e-9 && q < end - 1e-9) out.push(q); q += g * unit; }
    }
    return out;
  }

  /** Bar and beat at a recording time. Before the first bar it counts backwards and reports `before`. */
  barBeatAt(t) {
    const bars = this.bars, first = bars[0];
    if (t < first.t0 - EPS) {
      // Bar lines before bar 0 line up with the reference bar's downbeat.
      const ref = this._beforeRef(), unit = 4 / ref.denominator, length = ref.units * unit;
      const off = (((this.positionAt(t) - ref.q0) % length) + length) % length;
      let start = 0, groupIndex = 0;
      for (let i = 0; i < ref.groups.length; i++) {
        groupIndex = i;
        if (off < start + ref.groups[i] * unit - 1e-9 || i === ref.groups.length - 1) break;
        start += ref.groups[i] * unit;
      }
      return {index: 0, display: null, pickup: false, before: true, groupIndex, beat: groupIndex + 1, groups: ref.groups, units: ref.units,
        unitIndex: Math.min(ref.units - 1, Math.floor(off / unit + 1e-9)), phase: Math.min(1 - EPS, Math.max(0, (off - start) / (ref.groups[groupIndex] * unit))),
        downbeat: groupIndex === 0};
    }
    const index = this.barIndexAt(t), bar = bars[index], onsets = this._onsets(bar), off = Math.max(0, this.positionAt(t) - bar.q0);
    let groupIndex = 0;
    while (groupIndex + 1 < onsets.length && onsets[groupIndex + 1].q <= off + 1e-9) groupIndex++;
    const onset = onsets[groupIndex], unit = 4 / bar.denominator;
    return {index, display: bar.display, pickup: bar.pickup, before: false, groupIndex, beat: this._firstBeat(bar, onsets) + groupIndex,
      groups: bar.groups, units: bar.units, unitIndex: Math.min(bar.units - 1, this._unitOffset(bar) + Math.floor(off / unit + 1e-9)),
      phase: Math.min(1 - EPS, Math.max(0, (off - onset.q) / onset.length)), downbeat: groupIndex === 0 && !bar.pickup};
  }

  /** How a bar's beats are counted: groups, their label ('2+2+3'; '' when all 1) and the lamp mode (D15). */
  beatGrouping(index) {
    const bar = this.bars[Math.max(0, Math.min(this.bars.length - 1, index))];
    return {groups: bar.groups, label: bar.groups.every((g) => g === 1) ? '' : bar.groups.join('+'), counted: bar.groups.length, units: bar.units,
      lampMode: bar.units > 12 ? 'groups' : 'units'};
  }

  /** The section playing at `t` (clamped into the recording), or null. */
  sectionAt(t) {
    const sections = this.sections;
    if (!sections.length) return null;
    const time = Math.max(0, Math.min(t, this.duration - 1e-6));
    return sections.find((s) => s.t0 <= time + EPS && time < s.t1 - EPS) ?? null;
  }

  /** The next section's downbeat: bars, counted beats (its downbeat included) and seconds until it. */
  nextSection(t) {
    const section = this.sections.find((s) => s.t0 > t + EPS);
    if (!section) return null;
    const bars = this.bars, current = this.barIndexAt(t);
    let beatsUntil = 1;
    if (t < bars[0].t0 - EPS) beatsUntil += this._onsetsBefore(this.positionAt(t)).length;
    for (let i = current; i < section.startBar; i++) {
      const bar = bars[i];
      for (const onset of this._onsets(bar)) if (this.timeAt(bar.q0 + onset.q) > t + EPS) beatsUntil++;
    }
    return {section, barsUntil: Math.max(1, section.startBar - current), beatsUntil, timeUntil: section.t0 - t};
  }

  /** The first downbeat after `t + after` (a pickup's start is not one); with `within: [a, b)` it must also lie before `b`. */
  downbeatAfter(t, {after = 1e-3, within} = {}) {
    const bars = this.bars, limit = within ? Math.min(within[1], this.duration) : this.duration;
    for (let i = this.barIndexAt(t + after); i < bars.length; i++) {
      const bar = bars[i];
      if (bar.pickup || bar.t0 <= t + after) continue;
      return bar.t0 < limit ? {index: bar.index, time: bar.t0} : null;
    }
    return null;
  }

  /** Time of a bar (0..bars.length; bars.length is the end of the last bar), a counted beat in it and a fraction of that beat. */
  barToTime(index, {group = 0, frac = 0} = {}) {
    const bars = this.bars, i = Math.max(0, Math.min(bars.length, Math.round(index)));
    if (i === bars.length) return bars[bars.length - 1].t1;
    const bar = bars[i], onsets = this._onsets(bar), g = onsets[Math.max(0, Math.min(onsets.length - 1, group))];
    return this.timeAt(bar.q0 + g.q + Math.max(0, Math.min(1, frac)) * g.length);
  }

  /** Bar index and the position inside it, in quarters. */
  timeToBar(t) { const index = this.barIndexAt(t); return {index, q: this.positionAt(t) - this.bars[index].q0}; }

  /** The n-bar phrase around `t`: aligned to its section's start, else to the first downbeat bar. */
  phraseAt(t, n = 4) {
    const size = Math.max(1, Math.round(n)), bars = this.bars, last = bars.length - 1, i = this.barIndexAt(t), section = this.sectionAt(t);
    if (section && t >= section.t0 - EPS) {
      const start = section.startBar + Math.floor((i - section.startBar) / size) * size;
      return {startBar: start, endBar: Math.min(start + size - 1, section.endBar)};
    }
    const base = Math.min(last, bars[0].pickup ? 1 : 0), start = i < base ? base : base + Math.floor((i - base) / size) * size;
    return {startBar: start, endBar: Math.min(start + size - 1, last)};
  }

  /** A position that survives map edits: bar id, counted beat and the fraction into it. Null before the first bar. */
  refAt(t) {
    const bars = this.bars;
    if (t < bars[0].t0 - EPS) return null;
    const bar = bars[this.barIndexAt(t)], onsets = this._onsets(bar), off = this.positionAt(t) - bar.q0;
    let beat = 0;
    while (beat + 1 < onsets.length && onsets[beat + 1].q <= off + 1e-9) beat++;
    const frac = Math.max(0, Math.min(1, (off - onsets[beat].q) / onsets[beat].length));
    return {id: bar.id, beat, frac: Math.abs(frac - Math.round(frac)) < 1e-9 ? Math.round(frac) : frac};
  }

  /** The time of a ref on the current map, or null when its bar no longer exists. */
  timeOfRef(ref) {
    const index = ref ? this._ids.get(ref.id) : undefined;
    if (index === undefined) return null;
    const last = this._onsets(this.bars[index]).length - 1;
    return this.barToTime(index, {group: Math.min(Math.max(0, ref.beat | 0), last), frac: ref.frac ?? 0});
  }

  /** Quarter offsets (from a bar start) of a bar's snap points for `unit`. */
  _snapOffsets(bar, unit, length = bar.q1 - bar.q0) {
    if (unit === 'bar') return [0];
    if (unit === 'beat') return this._onsets(bar).map((o) => o.q);
    if (unit === 'unit') { const out = [], step = 4 / bar.denominator; for (let q = 0; q < length - 1e-7; q += step) out.push(q); return out; }
    throw new TypeError(`Unknown snap unit: ${unit}`);
  }

  /**
   * Snap a time to the nearest (or floor/ceil) bar start, counted beat or meter
   * unit. Before bar 0 the grid is extrapolated like `barBeatAt`, so floor ≤ t
   * and ceil ≥ t; past the last bar's end there is nothing to ceil to, so t stays.
   */
  snapTime(t, unit, {mode = 'nearest'} = {}) {
    const bars = this.bars, i = this.barIndexAt(t), points = [];
    for (let k = Math.max(0, i - 1); k <= Math.min(bars.length - 1, i + 1); k++) {
      const bar = bars[k];
      for (const q of this._snapOffsets(bar, unit)) points.push(this.timeAt(bar.q0 + q));
    }
    if (i + 1 >= bars.length) points.push(bars[bars.length - 1].t1);
    if (t < bars[0].t0 - EPS) {
      const ref = this._beforeRef(), length = ref.units * 4 / ref.denominator, end = bars[0].q0, offsets = this._snapOffsets(ref, unit, length);
      // The bar before t's, t's own and the next: enough for both neighbours.
      for (let start = ref.q0 + (Math.floor((this.positionAt(t) - ref.q0) / length) - 1) * length, n = 0; n < 3 && start < end - 1e-9; start += length, n++)
        for (const q of offsets) if (start + q < end - 1e-9) points.push(this.timeAt(start + q));
    }
    const floor = points.filter((p) => p <= t + 1e-6), ceil = points.filter((p) => p >= t - 1e-6);
    const down = floor.length ? Math.max(...floor) : t, up = ceil.length ? Math.min(...ceil) : t;
    if (mode === 'floor') return down;
    if (mode === 'ceil') return up;
    if (!floor.length || !ceil.length) return floor.length ? down : up;
    return t - down <= up - t ? down : up;
  }
}

export {fraction};
