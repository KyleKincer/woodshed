// Edit · Map session (no DOM): the selected line (the cursor), go-to-bar
// digits, pins, meter, tempo, tap passes, tap calibration, the preview loop,
// sections, suggestion review and the Find-a-chart audition, all over one
// SongMapStore (architecture §2.15; ported from 1.9 map-mode.js).
//
// Inputs are narrow so the session builds and tests without a Stage session:
//   engine     MultitrackEngine (position, seek, play/stop, loop, ctx, tracks)
//   metronome  Metronome (`enabled`/`setEnabled` for the preview click,
//              `clickAt` for the calibration clicks)
//   map        SongMapStore (every edit goes through `map.edit(change, reason)`,
//              which stamps the origin, §4.2)
//   prefs      device prefs (`edit.map.tapSnap`, `edit.map.tapOffset`, §2.5)
//   hooks      suspendSaves(on, {changed}), pauseMapSync(on): the audition (D20);
//                resuming with `changed: true` must save the map (Use their map)
//              status(text, {tone, action}): results that offer Undo
//              loop.get() / loop.set(range|null): the user's practice loop;
//                set(get()) restores it exactly (Preview)
//              markers.list() / markers.tombstone(ids, deleted = true): live
//                markers, and (un)deleting them (markers → sections) without a
//                practice-undo step (the map step's `linked` undo owns it, D23)
//              rename(barIndex): open the inline rename (the "Section n added" status)
//
// Every user-visible outcome lands in `message` ({text, tone}); refusals from
// the model and the drum-part guards come back as tone 'error' and change nothing.
import {fraction, number, compare, beatGroups} from '../../../shared/notation.ts';
import {pin, unpin, renumberPin, editBars, rebarBars, beatsPinnedNear, setMeter, meterRun, scaleTempo, fullLength, sameMeter,
  pulseOf, hasPickup, sectionLabelOf, sectionsFromMarkers, applySuggestion, MIN_QPM, MAX_QPM} from '../../../shared/song-map.ts';
import {signal, computed, readonly, batch} from '../../app/store.js';
import {detectOnsets, nearestOnset} from '../../js/onsets.js';

/** Most digits "Go to bar" takes (bar 9999 is far past the 1024-bar limit). */
export const MAX_DIGITS = 4;
/** Bars either side of the cursor bar that Preview loops. */
export const PREVIEW_SPREAD = 1;
/** A nudged or tapped pin stays this far inside its neighbours. */
export const PIN_GAP = 0.002;
/** Taps snap to a drum hit this close (seconds). */
export const TAP_SNAP_WINDOW = 0.04;
/** The calibrated tap offset is clamped to ± this (seconds); prefs.js clamps the same. */
export const TAP_OFFSET_LIMIT = 0.2;
/** Tap calibration: 12 clicks 0.6 s apart from 0.4 s ahead; the first 3 taps are ignored and 4 more are needed. */
export const CALIBRATION = Object.freeze({clicks: 12, interval: 0.6, lead: 0.4, tail: 0.3, ignore: 3, needed: 4, accentEvery: 4});
/** The most an input event's own delay is trusted when mapping it to audio time. */
const MAX_EVENT_DELAY = 0.1;
const UNITS = Object.freeze([1, 2, 4, 8, 16]);
const LABEL_MAX = 120;
const RESNAP_REASONS = new Set(['undo', 'redo', 'restore', 'adopt', 'load']);

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** Tempo for messages: two decimals at most, trailing zeros dropped (118.81, 120, 96.5). */
export const bpmText = (bpm) => (Math.round(bpm * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
/** A recording time as m:ss.mmm (−0:00.250 before the start). */
export function clockText(t) {
  if (!Number.isFinite(t)) return '—';
  const sign = t < 0 ? '−' : '', a = Math.abs(t), m = Math.floor(a / 60), s = a - m * 60;
  return `${sign}${m}:${s.toFixed(3).padStart(6, '0')}`;
}
const cleanLabel = (label) => String(label ?? '').trim().slice(0, LABEL_MAX);

/** Every string the session shows (the inspector's status line and the hooks' status). */
export const MAP_SESSION_COPY = Object.freeze({
  pinned: (what, time, since, replaced) => `Pinned ${what} at ${clockText(time)}${since}${replaced ? ` · replaced ${plural(replaced, 'out-of-order pin')}` : ''}`,
  since: (bpm, what) => ` · ${bpmText(bpm)} BPM since ${what}`,
  moved: (existing, what, time) => `${existing ? 'Moved' : 'Pinned'} ${what} to ${clockText(time)}`,
  notPinned: 'This line isn’t pinned.',
  unpinned: (what) => `Unpinned ${what}. It now follows the pins around it.`,
  needPin: 'Select a pin to change its bar number. Previous / next pin jumps between pins.',
  noFurther: 'There is no bar further that way.',
  renumbered: (before, after, since) => `${cap(before)} is now ${after}${since}`,
  sameBar: (what) => `This pin is already ${what}.`,
  beatsRange: 'A bar has between 1 and 16 beats.',
  unitRange: 'Choose a unit of 1, 2, 4, 8 or 16.',
  groups: (n) => `Groups must add up to ${n}, like ${n === 7 ? '2+2+3' : n === 5 ? '3+2' : n > 1 ? `${n - 1}+1` : '1'}.`,
  notesAfter: 'Later bars have drum notes, so the bar lines can’t slide. Choose Keep in place: Bar lines.',
  meter: (bar, meter, scope, keep, dropped) => `${cap(bar)} is ${meter} ${scope} · ${keep === 'beats' ? 'beats stayed put, later bar lines moved' : 'pinned bar lines stayed put, the beats re-spread'}${dropped ? ` · removed ${plural(dropped, 'pin')} that no longer fit` : ''}`,
  scope: {this: 'for this bar', until: 'until the next change', end: 'to the end'},
  barUpdated: (bar) => `${cap(bar)} updated`,
  rampNeedsPins: 'A ramp runs between two pins. Select a line between them.',
  rampNeedsSteady: 'A ramp needs a steady tempo next to it. Pin one more line after this span.',
  rampOn: (from, to, a, b) => `Ramp from ${from} to ${to}: ${bpmText(a)} → ${bpmText(b)} BPM`,
  rampOff: (from, to) => `Steady from ${from} to ${to}`,
  tempoFromPins: 'Tempo here comes from the pins around it. Move or renumber a pin to change it.',
  tailTempo: (bpm) => `Tempo after the last pin: ${bpmText(bpm)} BPM`,
  tempo: (bpm) => `Tempo: ${bpmText(bpm)} BPM`,
  tempoNumber: 'Type a tempo in BPM.',
  doubled: 'Doubled the tempo. Every pin stayed where it was.',
  halved: 'Halved the tempo. Every pin stayed where it was.',
  undone: 'Undone.', redone: 'Redone.', nothingToUndo: 'Nothing to undo.', nothingToRedo: 'Nothing to redo.',
  noEarlierPin: 'No earlier pin or meter change.', noLaterPin: 'No later pin or meter change.',
  countIn: 'Taps start after the count-in.',
  noMoreBars: 'No more bars in the map.',
  tap: (count, what, bpm) => `Tap ${count} · ${what}${bpm === null ? '' : ` · ${bpmText(bpm)} BPM`}`,
  passDone: (count) => `Tapped ${plural(count, 'line')}. Undo takes back the whole pass.`,
  /** Display bar numbers; null is the pickup. */
  previewing: (first, last) => {
    const bar = (n) => (n === null ? 'the pickup' : `bar ${n}`);
    const what = first === last ? bar(first) : first === null ? `the pickup to bar ${last}` : `bars ${first}–${last}`;
    return `Previewing ${what} · Esc to stop`;
  },
  tapAlong: 'Tap T on every beat. D on a downbeat keeps the bars in step.',
  calibrating: `Tap T with each of the ${CALIBRATION.clicks} clicks. The first few taps are ignored.`,
  calibrationNoAudio: 'Audio is not available, so the clicks can’t play. Try again.',
  calibrationShort: 'Not enough taps to calibrate. Try again and tap T with every click.',
  calibrated: (offset) => {
    const ms = Math.round(Math.abs(offset) * 1000);
    return ms === 0 ? 'Your taps land right on the click. No correction needed.' : `Your taps land ${ms} ms ${offset > 0 ? 'late' : 'early'}. Taps are corrected from now on.`;
  },
  auditionLocked: 'Finish with Find a chart first: Use their map or Keep my map.',
  usingTheirs: 'Using their map. Undo puts yours back.',
  keptYours: 'Kept your map.',
  labelled: (bar, label) => `${cap(bar)} starts “${label}”`,
  unlabelled: (bar) => `Removed the section label from ${bar}`,
  noBar: 'That bar is not in the map.',
  notSection: (bar) => `${cap(bar)} doesn’t start a section.`,
  alreadyStarts: (bar, name) => `${cap(bar)} already starts ${name}`,
  crosses: 'That would move past another section. Move that one first.',
  sectionMoved: (name, bar) => `${name} now starts at ${bar}`,
  sectionAdded: (label) => `${label} added`,
  noMarkers: 'There are no markers to turn into sections.',
  markersAlready: 'Those sections are already in the map.',
  markersTurned: (n, skipped) => `Turned ${plural(n, 'marker')} into sections${skipped ? ` · skipped ${skipped} on a bar that already had one` : ''}`,
  suggestionsAdded: (n) => (n ? `Added ${plural(n, 'section')}` : 'No sections added: every chosen bar already has a label.'),
  undoAction: 'Undo',
  renameAction: 'Rename',
});

/**
 * @typedef {{text: string, tone: 'info'|'ok'|'error'}} MapMessage
 * @typedef {{
 *   real: boolean, index: number, display: number|null, pickup: boolean, name: string,
 *   beat: number|null, downbeat: boolean, barCount: number,
 *   meter: {numerator: number, denominator: number, text: string, groups: string, label: string},
 *   tempo: {unit: string, bpm: number, ramp: boolean, startBpm: number, endBpm: number,
 *           open: 'head'|'tail'|null, from: string|null, to: string|null, editable: boolean, rampAvailable: boolean},
 *   pin: {time: number, ramp: boolean}|null,
 *   form: {numerator: number, denominator: number, groups: string, label: string,
 *          pickup: {editable: boolean, value: number}, applyTo: 'until', keep: 'beats'|'lines',
 *          tempo: {editable: boolean, value: number}, ramp: {available: boolean, on: boolean}},
 * }} SpanInfo
 *
 * `SpanInfo` is everything the inspector shows for the cursor: the bar (display
 * number, "Pickup", the counted beat of a beat line), its meter and section
 * label, the tempo span around it, the pin on the line (null while the map is
 * still the placeholder), and the Meter form's starting values ("Edit bar").
 */

/**
 * The Edit · Map session. See the file header for the inputs; the returned
 * members follow architecture §2.15 (plus `first`, `last`, `canUndo`,
 * `canRedo` and `review`, which the inspector and commands read).
 */
export function createMapSession({engine, metronome, map, prefs, hooks = {}}) {
  if (!engine || !metronome || !map) throw new TypeError('createMapSession needs an engine, a metronome and a map.');
  const loopHook = hooks.loop ?? {get: () => null, set: () => {}};
  const markerHook = hooks.markers ?? {list: () => [], tombstone: () => {}};
  const status = (text, opts) => hooks.status?.(text, opts);

  const sameQ = (a, b) => compare(a, b) === 0;
  const revision = signal(map.revision);
  const cursorQ = signal(fraction(0), {equals: sameQ});
  const digits = signal('');
  const tapping = signal(false);
  const previewing = signal(false);
  const calibrating = signal(false);
  const auditioning = signal(false);
  const message = signal(null);
  const review = signal(null);

  let pass = null;          // {lastQ, count} while a tap pass is open
  let preview = null;       // {loop, click} saved when Preview started
  let previewStarting = null; // the preview whose engine.play() is still pending
  let calibration = null;   // {clicks, taps, end, timer}
  let onsets = null;
  let destroyed = false;

  // ---- geometry -------------------------------------------------------------
  const duration = () => map.duration;
  const timeOf = (q) => map.timeAt(q);
  const navigable = () => {
    const list = map.lines.filter((l) => timeOf(l.q) < duration() - 1e-6);
    return list.length ? list : map.lines.slice(0, 1);
  };
  function lineIndex(list, q) {
    let best = 0, distance = Infinity;
    for (let i = 0; i < list.length; i++) { const d = Math.abs(number(list[i].q) - number(q)); if (d < distance) { best = i; distance = d; } }
    return best;
  }
  const lineAt = (q) => map.lines.find((l) => sameQ(l.q, q));
  const pinAt = (q) => map.data.pins.find((p) => sameQ(p.position, q));
  const pickupMap = () => hasPickup(map.data);
  /** Display bar number of a measure index (null for the pickup), architecture §4.3. */
  const displayOf = (index) => (pickupMap() ? (index === 0 ? null : index) : index + 1);
  const barName = (index) => { const d = displayOf(index); return d === null ? 'the pickup' : `bar ${d}`; };
  /** A pickup's beats count from the end of its bar, as the click does (`beatsOf`). */
  function displayBeat(line) {
    if (line.bar !== 0 || !pickupMap()) return line.beat;
    const inBar = map.lines.filter((l) => l.bar === 0).length;
    return beatGroups(map.measure(0)).length - inBar + line.beat;
  }
  function describe(q) {
    const index = map.barIndexAtQ(number(q)), line = lineAt(q);
    return line && !line.downbeat ? `${barName(index)} beat ${displayBeat(line)}` : barName(index);
  }
  /** Index of a display bar number, clamped to the bars inside the recording. */
  const indexOfDisplay = (bar) => clamp((pickupMap() ? bar : bar - 1) || 0, 0, map.bars.length - 1);
  const tempoSince = (q) => {
    const span = map.spanAt(number(q) - 1e-6);
    return span.from ? MAP_SESSION_COPY.since(span.endBpm, describe(span.from.position)) : '';
  };
  /** Keep beats when beats (not just bar lines) are pinned in or right after the bars an edit covers (`end`: its last bar). */
  const keepDefault = (index, end = meterRun(map.data, index)) => (beatsPinnedNear(map.data, index, end) ? 'beats' : 'lines');
  const explicitGroups = (m) => (m.grouping && m.grouping.length > 1 && !m.grouping.every((g) => g === 1) ? m.grouping.join('+') : '');
  const isPartial = (m) => number(m.length) < number(fullLength(m)) - 1e-9;
  const openSpan = (span) => span.open === 'tail' || (span.open === 'head' && map.data.pins.length === 1);
  const rampAvailable = (span) => !!(span.from && span.to && (span.index > 0 || map.data.pins.length > 2));

  function spanInfo(qf) {
    const q = number(qf), index = map.barIndexAtQ(q), m = map.measure(index), span = map.spanAt(q), line = lineAt(qf);
    const real = map.isReal, p = real ? pinAt(qf) : null, open = openSpan(span), groups = explicitGroups(m), partial = isPartial(m);
    const ramp = rampAvailable(span), bpm = map.bpmAt(q), display = displayOf(index);
    // A pickup has no downbeat: its first line is counted like the click counts it (beat 3 of a 2-beat pickup).
    const pickup = display === null;
    return {
      real, index, display, pickup, name: pickup ? 'Pickup' : `Bar ${display}`,
      beat: line && (pickup || !line.downbeat) ? displayBeat(line) : null, downbeat: !pickup && (!line || line.downbeat), barCount: map.bars.length,
      meter: {numerator: m.numerator, denominator: m.denominator, text: `${m.numerator}/${m.denominator}`, groups, label: sectionLabelOf({index, label: m.label})},
      tempo: {unit: map.pulseLabel(index), bpm, ramp: span.ramp, startBpm: span.startBpm, endBpm: span.endBpm, open: span.open,
        from: span.from ? describe(span.from.position) : null, to: span.to ? describe(span.to.position) : null, editable: open, rampAvailable: ramp},
      pin: p ? {time: p.time, ramp: !!p.ramp} : null,
      form: {numerator: m.numerator, denominator: m.denominator, groups, label: m.label,
        pickup: {editable: index === 0 || partial, value: number(partial ? m.length : fullLength(m))},
        applyTo: 'until', keep: keepDefault(index), tempo: {editable: open, value: Math.round(bpm * 100) / 100}, ramp: {available: ramp, on: span.ramp}},
    };
  }
  const span = computed(() => { revision.value; return spanInfo(cursorQ.value); });
  const canUndo = computed(() => { revision.value; tapping.value; return !auditioning.value && (map.undoStack.length > 0 || !!map.batch?.changed); });
  const canRedo = computed(() => { revision.value; return !auditioning.value && !pass && map.redoStack.length > 0; });

  // ---- messages and refusals ------------------------------------------------
  const say = (text, tone = 'info') => { message.value = {text, tone}; };
  const FAILED = Symbol('failed');
  function attempt(fn) {
    try { return fn(); }
    catch (error) { say(error?.message || String(error), 'error'); return FAILED; }
  }
  /** D20: while auditioning every map edit is refused (the find panel's own tries excepted). */
  function locked() {
    if (destroyed) return true;
    if (!auditioning.peek()) return false;
    say(MAP_SESSION_COPY.auditionLocked, 'error');
    return true;
  }

  /** Start a map edit from a member other than a tap: refused while auditioning; an open tap pass closes first (its own undo step). */
  function editable() {
    if (locked()) return false;
    finishPass();
    return true;
  }

  // ---- transport --------------------------------------------------------------
  /** Cue to `t` when stopped; seek without moving the cue while playing; a count-in is cancelled first (§2.14.3 rule 21). */
  function seekTo(t) {
    const time = clamp(t, 0, duration());
    if (engine.countingIn) engine.stop({returnToEdit: false});
    engine.seek(time, {cue: !engine.playing});
  }
  const position = () => clamp(engine.getPosition(), 0, duration());
  const setClick = (on) => { if (!!metronome.enabled !== on) metronome.setEnabled(on); };

  // ---- cursor -------------------------------------------------------------------
  function toFraction(q) {
    if (q && typeof q === 'object' && Number.isFinite(q.n) && Number.isFinite(q.d)) return fraction(q.n, q.d);
    if (Number.isFinite(q)) { const list = navigable(); return list[lineIndex(list, fraction(Math.round(q * 960), 960))].q; }
    return null;
  }
  /** Select a line (Fraction, or a quarter position); stopped → it becomes the cue; while previewing the loop follows. */
  function select(q, {seek = true} = {}) {
    const target = toFraction(q);
    if (!target || destroyed) return false;
    cursorQ.value = target;
    if (preview) placePreview();
    else if (seek && !pass) seekTo(timeOf(target));
    return true;
  }
  /** Select the line nearest a recording time without seeking (a click on the lanes). */
  function selectNear(t, {bars = false} = {}) {
    const line = map.nearestLine(clamp(t, 0, duration()), {bars});
    if (line) cursorQ.value = line.q;
    return line ?? null;
  }
  function resnap() {
    const list = navigable(), q = cursorQ.peek();
    if (!list.some((l) => sameQ(l.q, q))) cursorQ.value = list[lineIndex(list, q)].q;
  }
  function step(direction, unit = 'bar') {
    const dir = direction < 0 ? -1 : 1, q = cursorQ.peek();
    if (unit === 'pin') {
      const pins = map.data.pins.map((p) => p.position);
      const changes = map.starts.filter((_, i) => i > 0 && !sameMeter(map.measure(i), map.measure(i - 1)));
      const targets = [...pins, ...changes].filter((x) => timeOf(x) < duration()).sort(compare);
      const next = dir > 0 ? targets.find((x) => compare(x, q) > 0) : targets.findLast((x) => compare(x, q) < 0);
      if (!next) { say(dir > 0 ? MAP_SESSION_COPY.noLaterPin : MAP_SESSION_COPY.noEarlierPin); return false; }
      return select(next);
    }
    const all = navigable(), list = unit === 'beat' ? all : all.filter((l) => l.downbeat);
    if (!list.length) return false;
    let i = lineIndex(list, q);
    const here = compare(list[i].q, q);
    if (dir > 0) i = here > 0 ? i : i + 1; else i = here < 0 ? i : i - 1;
    return select(list[clamp(i, 0, list.length - 1)].q);
  }
  const first = () => { const list = navigable().filter((l) => l.downbeat); return list.length ? select(list[0].q) : false; };
  const last = () => { const list = navigable().filter((l) => l.downbeat); return list.length ? select(list.at(-1).q) : false; };
  function goToBar(n) {
    const bar = Math.round(Number(n));
    return select(map.barStart(indexOfDisplay(Number.isFinite(bar) ? bar : 1)));
  }
  function typeDigit(d) {
    const text = String(d);
    if (!/^[0-9]$/.test(text) || digits.peek().length >= MAX_DIGITS || destroyed) return false;
    digits.value = digits.peek() + text;
    return true;
  }
  function backspaceDigit() {
    if (!digits.peek()) return false;
    digits.value = digits.peek().slice(0, -1);
    return true;
  }
  function clearDigits() {
    if (!digits.peek()) return false;
    digits.value = '';
    return true;
  }
  function commitDigits() {
    const text = digits.peek();
    if (!text) return false;
    digits.value = '';
    return goToBar(parseInt(text, 10));
  }

  // ---- pins -----------------------------------------------------------------------
  function pinLine(q, time) {
    const target = toFraction(q);
    if (!editable() || !target || !Number.isFinite(time)) return false;
    const replaced = attempt(() => map.edit((d) => pin(d, target, time, true), 'pin'));
    if (replaced === FAILED) return false;
    batch(() => {
      cursorQ.value = target;
      say(MAP_SESSION_COPY.pinned(describe(target), Math.max(0, time), tempoSince(target), replaced), 'ok');
    });
    return true;
  }
  const pinNearest = (kind, time) => pinLine(map.nearestLine(time, {bars: kind === 'D'}).q, time);
  function unpinLine() {
    if (!editable()) return false;
    const q = cursorQ.peek();
    if (!pinAt(q) || !map.isReal) { say(MAP_SESSION_COPY.notPinned); return false; }
    if (attempt(() => map.edit((d) => unpin(d, q), 'unpin')) === FAILED) return false;
    say(MAP_SESSION_COPY.unpinned(describe(q)), 'ok');
    return true;
  }
  function nudge(seconds) {
    if (!editable() || !Number.isFinite(seconds)) return false;
    const q = cursorQ.peek(), existing = pinAt(q), time = existing ? existing.time : timeOf(q);
    const pins = map.data.pins, prev = pins.findLast((p) => compare(p.position, q) < 0), next = pins.find((p) => compare(p.position, q) > 0);
    const target = clamp(time + seconds, Math.max(0, (prev?.time ?? -Infinity) + PIN_GAP), (next?.time ?? Infinity) - PIN_GAP);
    if (attempt(() => map.edit((d) => pin(d, q, target), 'nudge')) === FAILED) return false;
    if (preview) { if (engine.playing) placePreview(); }
    else if (!engine.playing) seekTo(target);
    say(MAP_SESSION_COPY.moved(!!existing, describe(q), target), 'ok');
    return true;
  }
  function renumberToQ(target) {
    const q = cursorQ.peek(), before = describe(q);
    if (sameQ(target, q)) { say(MAP_SESSION_COPY.sameBar(before)); return false; }
    if (attempt(() => map.edit((d) => renumberPin(d, q, target), 'renumber')) === FAILED) return false;
    batch(() => {
      cursorQ.value = target;
      say(MAP_SESSION_COPY.renumbered(before, describe(target), tempoSince(target)), 'ok');
    });
    return true;
  }
  /** Wrong bar number? Move the cursor's pin to the previous/next bar line (byBeat: any beat line), keeping its time. */
  function renumber(direction, {byBeat = false} = {}) {
    if (!editable()) return false;
    const q = cursorQ.peek();
    if (!pinAt(q)) { say(MAP_SESSION_COPY.needPin); return false; }
    const list = byBeat ? map.lines : map.lines.filter((l) => l.downbeat);
    const found = direction > 0 ? list.find((l) => compare(l.q, q) > 0) : list.findLast((l) => compare(l.q, q) < 0);
    if (!found) { say(MAP_SESSION_COPY.noFurther); return false; }
    return renumberToQ(found.q);
  }
  /** "This pin is bar [ 41 ]": the cursor's pin becomes that display bar's downbeat. */
  function renumberTo(bar) {
    if (!editable()) return false;
    if (!pinAt(cursorQ.peek())) { say(MAP_SESSION_COPY.needPin); return false; }
    const n = Math.round(Number(bar));
    if (!Number.isFinite(n)) { say(MAP_SESSION_COPY.noBar, 'error'); return false; }
    const index = clamp(pickupMap() ? n : n - 1, 0, map.data.measures.length - 1);
    return renumberToQ(map.barStart(index));
  }

  // ---- meter ------------------------------------------------------------------------
  /**
   * Two ways to change a meter. Keep beats: every beat stays at its time and
   * later bar lines slide (re-barring). Keep bar lines: pinned bar lines stay
   * and the beats between them re-spread (fixing a miscount between downbeats).
   */
  function changeBeats(direction, {thisBar = false} = {}) {
    if (!editable()) return false;
    const index = map.barIndexAtQ(number(cursorQ.peek())), m = map.measure(index), next = m.numerator + (direction < 0 ? -1 : 1);
    if (next < 1 || next > 16) { say(MAP_SESSION_COPY.beatsRange, 'error'); return false; }
    const keep = keepDefault(index, thisBar ? index : meterRun(map.data, index));
    if (keep === 'beats' && map.notationAfter(index)) { say(MAP_SESSION_COPY.notesAfter, 'error'); return false; }
    const edit = keep === 'beats' ? rebarBars : editBars;
    const dropped = attempt(() => map.edit((d) => edit(d, index, thisBar ? index : meterRun(d, index), (bar) => setMeter(bar, next, bar.denominator)), 'meter'));
    if (dropped === FAILED) return false;
    batch(() => {
      cursorQ.value = map.barStart(index);
      say(MAP_SESSION_COPY.meter(barName(index), `${next}/${m.denominator}`, MAP_SESSION_COPY.scope[thisBar ? 'this' : 'until'], keep, dropped), 'ok');
    });
    return true;
  }
  /** Groups as typed ('2+2+3', '' for even) or an array; null = even, undefined = invalid. */
  function parseGroups(groups) {
    if (groups == null || groups === '') return null;
    const list = Array.isArray(groups) ? groups.map(Number) : String(groups).split('+').map((x) => Number(x.trim()));
    return list.every((g) => Number.isInteger(g) && g >= 1) ? list : undefined;
  }
  /**
   * The Meter form ("Edit bar"), every field of 1.9's form, applied in one edit:
   * `{numerator, denominator, groups, pickup, label, applyTo, keep, tempo?, ramp?}`.
   * `pickup` (quarters) applies to bar 1 or an already-short bar: a full bar
   * becomes short only when `pickup` differs from its current length (so the
   * form's own starting value keeps it full under a new meter); `label` applies
   * to this bar only (omit to keep it). Pass `tempo` only when the user changed
   * the field (it applies on open spans) and `ramp` only when the checkbox is
   * offered. A form that changes no meter edits this bar only; a meter change
   * keeps the shortened bars it covers short where they still fit.
   */
  function applyBar(form = {}) {
    if (!editable()) return false;
    const q = number(cursorQ.peek()), index = map.barIndexAtQ(q), before = map.measure(index), span = map.spanAt(q);
    const n = Number(form.numerator ?? before.numerator), d = Number(form.denominator ?? before.denominator);
    if (!Number.isInteger(n) || n < 1 || n > 16) { say(MAP_SESSION_COPY.beatsRange, 'error'); return false; }
    if (!UNITS.includes(d)) { say(MAP_SESSION_COPY.unitRange, 'error'); return false; }
    const grouping = parseGroups(form.groups);
    if (grouping === undefined || (grouping && grouping.reduce((a, b) => a + b, 0) !== n)) { say(MAP_SESSION_COPY.groups(n), 'error'); return false; }
    const partial = isPartial(before), lengthShown = index === 0 || partial;
    const typed = lengthShown && form.pickup != null ? Number(form.pickup) : NaN;
    const lengthEdited = Number.isFinite(typed) && Math.abs(typed - number(before.length)) > 1e-9;
    // The bar's length after the edit, when it stays (or becomes) short; NaN = a full bar.
    const length = lengthEdited ? typed : partial ? number(before.length) : NaN;
    const scope = ['this', 'until', 'end'].includes(form.applyTo) ? form.applyTo : 'until';
    const keep = form.keep === 'beats' || form.keep === 'lines' ? form.keep : keepDefault(index);
    const label = form.label === undefined ? before.label : cleanLabel(form.label);
    const tempoShown = openSpan(span), rampShown = rampAvailable(span), rampPin = span.from?.position;
    const bpm = Number(form.tempo);
    if (form.tempo != null && tempoShown && !(bpm > 0)) { say(MAP_SESSION_COPY.tempoNumber, 'error'); return false; }
    // Compare what setMeter would store: an all-ones grouping (legacy maps) is the same even count as none.
    const after = {numerator: n, denominator: d, length: before.length};
    setMeter(after, n, d, grouping || undefined);
    const fits = (len, m) => len > 0 && len < number(fullLength(m)) - 1e-9;
    const meterChanged = !sameMeter(before, after) || (Number.isFinite(length) && fits(length, after) ? Math.abs(length - number(before.length)) > 1e-9 : partial);
    if (meterChanged && keep === 'beats' && map.notationAfter(index)) { say(MAP_SESSION_COPY.notesAfter, 'error'); return false; }
    const dropped = attempt(() => map.edit((draft) => {
      let count = 0;
      if (meterChanged) {
        const end = scope === 'this' ? index : scope === 'end' ? draft.measures.length - 1 : meterRun(draft, index);
        count = (keep === 'beats' ? rebarBars : editBars)(draft, index, end, (m, i) => {
          const was = i === index ? length : isPartial(m) ? number(m.length) : NaN;
          setMeter(m, n, d, grouping || undefined);
          if (Number.isFinite(was) && fits(was, m)) m.length = fraction(Math.max(1, Math.round(was * 16)), 16);
        });
      }
      draft.measures[index].label = label;
      if (form.tempo != null && tempoShown) draft.tailQpm = clamp(bpm * pulseOf(draft.measures[index]), MIN_QPM, MAX_QPM);
      if (typeof form.ramp === 'boolean' && rampShown && rampPin) {
        const p = draft.pins.find((x) => sameQ(x.position, rampPin));
        if (p) { if (form.ramp) p.ramp = true; else delete p.ramp; }
      }
      return count;
    }, 'bar'));
    if (dropped === FAILED) return false;
    batch(() => {
      cursorQ.value = map.barStart(index);
      say(meterChanged ? MAP_SESSION_COPY.meter(barName(index), `${n}/${d}`, MAP_SESSION_COPY.scope[scope], keep, dropped) : MAP_SESSION_COPY.barUpdated(barName(index)), 'ok');
    });
    return true;
  }

  // ---- tempo --------------------------------------------------------------------------
  function toggleRamp() {
    if (!editable()) return false;
    const q = number(cursorQ.peek()), span = map.spanAt(q);
    if (!span.from || !span.to) { say(MAP_SESSION_COPY.rampNeedsPins); return false; }
    if (!rampAvailable(span)) { say(MAP_SESSION_COPY.rampNeedsSteady); return false; }
    const at = span.from.position, on = !span.ramp;
    const ok = attempt(() => map.edit((d) => {
      const p = d.pins.find((x) => sameQ(x.position, at));
      if (on) p.ramp = true; else delete p.ramp;
    }, 'ramp'));
    if (ok === FAILED) return false;
    const next = map.spanAt(q);
    say(on ? MAP_SESSION_COPY.rampOn(describe(at), describe(span.to.position), next.startBpm, next.endBpm) : MAP_SESSION_COPY.rampOff(describe(at), describe(span.to.position)), 'ok');
    return true;
  }
  function setOpenTempo(bpm) {
    const q = number(cursorQ.peek()), span = map.spanAt(q);
    if (!openSpan(span)) { say(MAP_SESSION_COPY.tempoFromPins); return false; }
    const pulse = pulseOf(map.measure(map.barIndexAtQ(q)));
    if (attempt(() => map.edit((d) => { d.tailQpm = clamp(bpm * pulse, MIN_QPM, MAX_QPM); }, 'tempo')) === FAILED) return false;
    say(span.open === 'tail' ? MAP_SESSION_COPY.tailTempo(map.bpmAt(q)) : MAP_SESSION_COPY.tempo(map.bpmAt(q)), 'ok');
    return true;
  }
  /** Tail tempo −/+ (⌥↓/⌥↑, Shift ±0.1): only where no pin bounds the tempo. */
  function tail(delta) {
    if (!editable() || !Number.isFinite(delta)) return false;
    const q = number(cursorQ.peek());
    return setOpenTempo(map.bpmAt(q) + delta);
  }
  /** The inspector's ♩ [96.00] field on an open span. */
  function setTempoOpenSpan(bpm) {
    if (!editable()) return false;
    const value = Number(bpm);
    if (!(value > 0)) { say(MAP_SESSION_COPY.tempoNumber, 'error'); return false; }
    return setOpenTempo(value);
  }
  /** ×2 / ÷2: pins keep their times; the cursor follows its musical position. */
  function scale(factor) {
    if (!editable() || !(factor > 0)) return false;
    if (attempt(() => map.edit((d) => scaleTempo(d, factor), 'scale')) === FAILED) return false;
    const list = navigable(), scaled = fraction(Math.round(number(cursorQ.peek()) * factor * 64), 64);
    batch(() => {
      cursorQ.value = list[lineIndex(list, scaled)]?.q ?? fraction(0);
      say(factor > 1 ? MAP_SESSION_COPY.doubled : MAP_SESSION_COPY.halved, 'ok');
    });
    return true;
  }

  // ---- taps -----------------------------------------------------------------------------
  /**
   * The audio-context time of the sample heard when `event` happened: the
   * output timestamp maps the event's own time stamp onto the audio clock
   * (latency included); without one, now minus the reported output latency.
   */
  function heardContextTime(event) {
    const ctx = engine.ctx, stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    const at = Number(event?.timeStamp);
    if (stamp && stamp.performanceTime > 0 && Number.isFinite(stamp.contextTime) && at > 0)
      return stamp.contextTime + clamp((at - stamp.performanceTime) / 1000, -MAX_EVENT_DELAY, MAX_EVENT_DELAY);
    return ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
  }
  const tapOffset = () => { const v = Number(prefs?.get?.('edit.map.tapOffset')); return Number.isFinite(v) ? clamp(v, -TAP_OFFSET_LIMIT, TAP_OFFSET_LIMIT) : 0; };
  const snapTaps = () => prefs?.get?.('edit.map.tapSnap') !== false;
  function ensureOnsets() {
    if (onsets) return onsets;
    const track = engine.tracks?.find((t) => t.name === 'drums') || engine.tracks?.[0];
    onsets = track?.buffer ? detectOnsets(track.buffer) : [];
    return onsets;
  }
  /** The recording time a tap meant: heard time, minus the calibrated offset, snapped to a drum hit within 40 ms. */
  function tapTime(event) {
    const time = engine.getPositionAt(heardContextTime(event) - tapOffset());
    return (snapTaps() ? nearestOnset(ensureOnsets(), time, TAP_SNAP_WINDOW) : null) ?? time;
  }
  function tapPass(kind, event) {
    const time = tapTime(event), q = cursorQ.peek(), all = map.lines;
    if (!pass) { pass = {lastQ: null, count: 0}; map.beginBatch(); tapping.value = true; }
    const lastQ = pass.lastQ;
    const target = lastQ === null
      ? (kind === 'D' ? (lineAt(q)?.downbeat ? q : all.find((l) => l.downbeat && compare(l.q, q) > 0)?.q) : q)
      : all.find((l) => compare(l.q, lastQ) > 0 && (kind !== 'D' || l.downbeat))?.q;
    if (!target) { say(MAP_SESSION_COPY.noMoreBars, 'error'); return false; }
    const ok = attempt(() => map.edit((d) => {
      // A pass rewrites what it covers: pins skipped between two downbeat taps go too.
      if (lastQ) d.pins = d.pins.filter((p) => !(compare(p.position, lastQ) > 0 && compare(p.position, target) < 0));
      pin(d, target, time, true);
      return true;
    }, 'tap'));
    if (ok === FAILED) return false;
    pass.lastQ = target; pass.count++;
    const span = map.spanAt(number(target) - 1e-6);
    batch(() => {
      cursorQ.value = target;
      say(MAP_SESSION_COPY.tap(pass.count, describe(target), span.from ? span.endBpm : null), 'ok');
    });
    return true;
  }
  /** Close the open tap pass: the whole pass is one undo step. */
  function finishPass() {
    if (!pass) return false;
    const {count} = pass;
    pass = null;
    map.endBatch();
    tapping.value = false;
    if (count) {
      say(MAP_SESSION_COPY.passDone(count), 'ok');
      status(MAP_SESSION_COPY.passDone(count), {tone: 'ok', action: {label: MAP_SESSION_COPY.undoAction, run: () => history(false)}});
    }
    return true;
  }
  /**
   * D or T (`kind`), from the keys or the inspector's Pin buttons. Stopped: pin
   * the nearest bar line (D) or beat (T) at the playhead. Playing: one tap of a
   * pass (each tap pins the next line). Previewing: pin the nearest line at the
   * tap. Calibrating: a calibration tap. A key repeat does nothing.
   */
  function tap(kind, event) {
    const which = kind === 'D' ? 'D' : 'T';
    if (destroyed || event?.repeat) return false;
    if (calibration) { calibrationTap(event); return true; }
    if (locked()) return false;
    if (engine.countingIn) { say(MAP_SESSION_COPY.countIn); return false; }
    if (engine.playing && preview) return pinNearest(which, tapTime(event));
    if (engine.playing) return tapPass(which, event);
    return pinNearest(which, position());
  }

  /** The inspector's [Tap along]: tapping along → stop (closing the pass); otherwise end a preview, play, and say how to tap. */
  async function tapAlong() {
    if (destroyed || calibration || locked()) return false;
    if (!preview && (engine.playing || engine.countingIn)) { engine.stop({returnToEdit: false}); return false; }
    stopPreview();
    await engine.play();
    if (destroyed || !engine.playing) return false;
    say(MAP_SESSION_COPY.tapAlong);
    return true;
  }

  // ---- calibration ------------------------------------------------------------------------
  /** Stops playback, resumes the AudioContext first, then plays 12 untracked clicks to tap along with. */
  async function startCalibration() {
    if (destroyed || calibration) return false;
    finishPass();
    stopPreview();
    if (engine.playing) engine.stop({returnToEdit: false});
    const ctx = engine.ctx;
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch { /* reported below */ } }
    if (destroyed || calibration) return false;
    if (ctx.state !== 'running') { say(MAP_SESSION_COPY.calibrationNoAudio, 'error'); return false; }
    const start = ctx.currentTime + CALIBRATION.lead, clicks = [];
    for (let i = 0; i < CALIBRATION.clicks; i++) {
      const when = start + i * CALIBRATION.interval;
      clicks.push(when);
      metronome.clickAt(when, i % CALIBRATION.accentEvery === 0);
    }
    calibration = {clicks, taps: [], end: start + CALIBRATION.clicks * CALIBRATION.interval + CALIBRATION.tail,
      timer: setInterval(() => { if (calibration && engine.ctx.currentTime > calibration.end) finishCalibration(); }, 50)};
    calibrating.value = true;
    say(MAP_SESSION_COPY.calibrating);
    return true;
  }
  function calibrationTap(event) {
    const heard = heardContextTime(event);
    const nearest = calibration.clicks.reduce((a, b) => (Math.abs(b - heard) < Math.abs(a - heard) ? b : a));
    calibration.taps.push(heard - nearest);
  }
  function endCalibration() {
    const done = calibration;
    if (!done) return null;
    clearInterval(done.timer);
    calibration = null;
    calibrating.value = false;
    return done;
  }
  function finishCalibration() {
    const done = endCalibration();
    if (!done) return false;
    const taps = done.taps.slice(CALIBRATION.ignore).sort((a, b) => a - b);
    if (taps.length < CALIBRATION.needed) { say(MAP_SESSION_COPY.calibrationShort, 'error'); return false; }
    const offset = clamp(taps[taps.length >> 1], -TAP_OFFSET_LIMIT, TAP_OFFSET_LIMIT);
    prefs?.set?.('edit.map.tapOffset', Math.round(offset * 1e4) / 1e4);
    say(MAP_SESSION_COPY.calibrated(offset), 'ok');
    return true;
  }

  // ---- preview loop ---------------------------------------------------------------------------
  function previewBounds() {
    const index = map.barIndexAtQ(number(cursorQ.peek())), last = map.data.measures.length - 1;
    const from = Math.max(0, index - PREVIEW_SPREAD), to = Math.min(last, index + PREVIEW_SPREAD);
    const a = clamp(timeOf(map.barStart(from)), 0, duration());
    const b = clamp(timeOf(number(map.barStart(to)) + number(map.measure(to).length)), 0, duration());
    return {a, b, from, to};
  }
  function placePreview() {
    const {a, b} = previewBounds();
    engine.setLoop(true, a, b);
    engine.seek(a, {cue: false});
  }
  /**
   * Preview these bars (P): loop the cursor bar and its neighbours with the
   * click on. P again, Esc, or the transport stopping ends it; the user's own
   * loop and click setting come back.
   */
  async function togglePreview() {
    if (preview) { stopPreview(); return false; }
    if (destroyed || calibration) return false;
    finishPass();
    const mine = preview = {loop: loopHook.get(), click: !!metronome.enabled};
    previewStarting = mine;
    try {
      previewing.value = true;
      setClick(true);
      placePreview();
      const {from, to} = previewBounds();
      say(MAP_SESSION_COPY.previewing(displayOf(from), displayOf(to)));
      if (!engine.playing) await engine.play();
    } finally { if (previewStarting === mine) previewStarting = null; }
    // P again (or destroy) while play() waited on ctx.resume(): stopPreview already cancelled that start.
    if (preview !== mine) return false;
    if (!engine.playing) { stopPreview(); return false; }
    return true;
  }
  function stopPreview() {
    if (!preview) return false;
    const saved = preview;
    preview = null;
    previewing.value = false;
    // A start still waiting on ctx.resume() is cancelled too: stop() → pause() bumps the engine's playRequest.
    if (engine.playing || previewStarting === saved) engine.stop({returnToEdit: false});
    loopHook.set(saved.loop);
    seekTo(timeOf(cursorQ.peek()));
    setClick(saved.click);
    return true;
  }

  // ---- sections ---------------------------------------------------------------------------------
  /** Label a bar (the section that starts there); '' removes it. */
  function setLabel(barIndex, label) {
    if (!editable()) return false;
    const index = Math.round(Number(barIndex)), text = cleanLabel(label);
    if (!(index >= 0 && index < map.data.measures.length)) { say(MAP_SESSION_COPY.noBar, 'error'); return false; }
    if (map.measure(index).label === text) return false;
    if (attempt(() => map.edit((d) => { d.measures[index].label = text; }, 'label')) === FAILED) return false;
    say(text ? MAP_SESSION_COPY.labelled(barName(index), text) : MAP_SESSION_COPY.unlabelled(barName(index)), 'ok');
    return true;
  }
  const sectionStartingAt = (index) => map.sections.find((s) => s.startBar === index) ?? null;
  /** Drag a section's start from one bar to another (one edit; never past another section). */
  function moveSectionBoundary(fromBar, toBar) {
    if (!editable()) return false;
    const from = Math.round(Number(fromBar)), to = Math.round(Number(toBar)), count = map.bars.length;
    if (!(from >= 0 && from < count) || !(to >= 0 && to < count)) { say(MAP_SESSION_COPY.noBar, 'error'); return false; }
    if (from === to) return false;
    const section = sectionStartingAt(from), heading = sectionLabelOf({index: from, label: map.measure(from).label});
    if (!heading) { say(MAP_SESSION_COPY.notSection(barName(from)), 'error'); return false; }
    const [low, high] = from < to ? [from + 1, to] : [to, from - 1];
    for (let i = low; i <= high; i++) {
      if (sectionLabelOf({index: i, label: map.measure(i).label})) { say(i === to ? MAP_SESSION_COPY.alreadyStarts(barName(i), sectionStartingAt(i)?.name ?? map.measure(i).label) : MAP_SESSION_COPY.crosses, 'error'); return false; }
    }
    const ok = attempt(() => map.edit((d) => { d.measures[to].label = d.measures[from].label; d.measures[from].label = ''; }, 'sections'));
    if (ok === FAILED) return false;
    say(MAP_SESSION_COPY.sectionMoved(section?.name ?? heading, barName(to)), 'ok');
    return true;
  }
  /** S in Edit · Map: label the bar under `t` "Section {n}" (n = sections + 1), unless it already starts one (§4.5). */
  function addSectionAt(t) {
    if (!editable()) return null;
    const index = map.barIndexAt(clamp(Number(t) || 0, 0, duration())), existing = sectionLabelOf({index, label: map.measure(index).label});
    if (existing) { say(MAP_SESSION_COPY.alreadyStarts(barName(index), sectionStartingAt(index)?.name ?? existing)); return null; }
    const label = `Section ${map.sections.length + 1}`;
    if (attempt(() => map.edit((d) => { d.measures[index].label = label; }, 'label')) === FAILED) return null;
    const text = MAP_SESSION_COPY.sectionAdded(label);
    say(text, 'ok');
    status(text, {tone: 'ok', action: {label: MAP_SESSION_COPY.renameAction, run: () => hooks.rename?.(index)}});
    return {index, label};
  }
  /**
   * The banner's "Turn them into sections": one map edit (reason 'sections')
   * whose undo/redo also un-tombstones/re-tombstones the converted markers.
   * Two markers on one bar: the earlier wins, the other is skipped and kept.
   */
  function markersToSections() {
    if (!editable()) return {converted: [], skipped: []};
    const {change, converted, skipped} = sectionsFromMarkers(map.data, markerHook.list() ?? [], duration());
    if (!converted.length) { say(MAP_SESSION_COPY.noMarkers); return {converted, skipped}; }
    const before = map.revision;
    const linked = {undo: () => markerHook.tombstone(converted, false), redo: () => markerHook.tombstone(converted, true)};
    if (attempt(() => map.edit(change, 'sections', {linked})) === FAILED) return {converted: [], skipped: []};
    if (map.revision === before) { say(MAP_SESSION_COPY.markersAlready); return {converted: [], skipped}; }
    markerHook.tombstone(converted, true);
    const text = MAP_SESSION_COPY.markersTurned(converted.length, skipped.length);
    say(text, 'ok');
    status(text, {tone: 'ok', action: {label: MAP_SESSION_COPY.undoAction, run: () => history(false)}});
    return {converted, skipped};
  }

  // ---- section suggestions (D47) -------------------------------------------------------------------
  const nearestBarIndex = (t) => {
    const bars = map.bars;
    let best = 0;
    for (let i = 1; i < bars.length; i++) if (Math.abs(bars[i].t0 - t) < Math.abs(bars[best].t0 - t)) best = i;
    return best;
  };
  const copyBlocks = (blocks) => blocks.map((b) => ({...b}));
  /**
   * Open the review of a suggestion (`{sections: [{t0, label, confidence}]}`):
   * each block snaps to the nearest bar and is accepted unless that bar already
   * starts a section (or another block took it). `null` closes the review.
   */
  function reviewSuggestion(suggestion) {
    const list = (Array.isArray(suggestion) ? suggestion : suggestion?.sections ?? []).filter((b) => b && Number.isFinite(b.t0)).sort((a, b) => a.t0 - b.t0);
    if (!list.length) { review.value = null; return {blocks: []}; }
    const taken = new Set();
    const blocks = list.map((b, i) => {
      const bar = nearestBarIndex(b.t0), free = !sectionLabelOf({index: bar, label: map.measure(bar).label}) && !taken.has(bar);
      if (free) taken.add(bar);
      return {t0: map.bars[bar].t0, bar, label: cleanLabel(b.label) || `Section ${i + 1}`, accepted: free, ...(Number.isFinite(b.confidence) ? {confidence: b.confidence} : {})};
    });
    review.value = {blocks};
    return {blocks: copyBlocks(blocks)};
  }
  /** Change one reviewed block: `{label?, accepted?, bar?}` (moving it snaps `t0` to that bar). */
  function setSuggestionBlock(i, patch = {}) {
    const current = review.peek();
    if (!current || !current.blocks[i]) return null;
    const block = {...current.blocks[i]};
    if (patch.label !== undefined) block.label = cleanLabel(patch.label) || block.label;
    if (patch.accepted !== undefined) block.accepted = !!patch.accepted;
    if (patch.bar !== undefined && Number.isFinite(Number(patch.bar))) {
      block.bar = clamp(Math.round(Number(patch.bar)), 0, map.bars.length - 1);
      block.t0 = map.bars[block.bar].t0;
    }
    const blocks = current.blocks.map((b, k) => (k === i ? block : b));
    review.value = {blocks};
    return {...block};
  }
  /** Keep the accepted blocks as section labels: one map edit (reason 'sections'); bars that already have a label are skipped. */
  function applySuggestionReview() {
    const current = review.peek();
    if (!current) return {added: 0};
    if (!editable()) return {added: 0};
    const chosen = current.blocks.filter((b) => b.accepted).map((b) => ({t0: map.bars[clamp(b.bar, 0, map.bars.length - 1)].t0, label: b.label}));
    const {change, added} = applySuggestion(map.data, chosen, duration());
    if (added && attempt(() => map.edit(change, 'sections')) === FAILED) return {added: 0};
    review.value = null;
    const text = MAP_SESSION_COPY.suggestionsAdded(added);
    say(text, added ? 'ok' : 'info');
    if (added) status(text, {tone: 'ok', action: {label: MAP_SESSION_COPY.undoAction, run: () => history(false)}});
    return {added};
  }

  // ---- Find a chart audition (D20) -------------------------------------------------------------------
  /** Open the audition: one batch, tempo saves and notation map-sync suspended; every other map edit is refused. */
  function beginAudition() {
    if (destroyed || auditioning.peek()) return false;
    finishPass();
    stopPreview();
    clearDigits();
    map.beginBatch();
    hooks.suspendSaves?.(true);
    hooks.pauseMapSync?.(true);
    auditioning.value = true;
    return true;
  }
  /** commit → one undo step (Use their map); otherwise `abortBatch` restores the map and both stacks exactly (Keep my map). */
  function endAudition({commit = false} = {}) {
    if (!auditioning.peek()) return false;
    const changed = commit ? map.endBatch() : map.abortBatch();
    batch(() => {
      auditioning.value = false;
      resnap();
    });
    hooks.pauseMapSync?.(false);
    // endBatch emits nothing, and the tries' own events came while saves were off: say whether a save is owed.
    hooks.suspendSaves?.(false, {changed: !!(commit && changed)});
    say(commit && changed ? MAP_SESSION_COPY.usingTheirs : MAP_SESSION_COPY.keptYours, commit && changed ? 'ok' : 'info');
    return changed;
  }

  // ---- undo -----------------------------------------------------------------------------------------
  function history(redo) {
    if (locked()) return false;
    finishPass();
    const done = attempt(() => (redo ? map.redo() : map.undo()));
    if (done === FAILED) return false;
    batch(() => {
      resnap();
      say(done ? (redo ? MAP_SESSION_COPY.redone : MAP_SESSION_COPY.undone) : (redo ? MAP_SESSION_COPY.nothingToRedo : MAP_SESSION_COPY.nothingToUndo));
    });
    return done;
  }

  // ---- wiring -----------------------------------------------------------------------------------------
  const offMap = map.subscribe((reason) => {
    batch(() => {
      revision.value = map.revision;
      if (RESNAP_REASONS.has(reason) && !pass) resnap();
    });
  });
  // The transport stopping (Space, the song ending) closes a tap pass and ends a preview.
  const offState = engine.on?.('state', ({playing}) => {
    if (playing) return;
    finishPass();
    if (preview && !previewStarting) stopPreview();
  }) ?? (() => {});

  {
    const list = navigable(), near = map.nearestLine(position(), {bars: true});
    cursorQ.value = near ? list[lineIndex(list, near.q)].q : fraction(0);
  }

  function destroy() {
    if (destroyed) return;
    finishPass();
    stopPreview();
    if (auditioning.peek()) endAudition({commit: false});
    endCalibration();
    destroyed = true;
    offMap();
    offState();
  }

  return {
    cursorQ, digits, message,
    tapping: readonly(tapping), previewing: readonly(previewing), calibrating: readonly(calibrating), auditioning: readonly(auditioning),
    span, canUndo, canRedo, review: readonly(review),
    select, selectNear, step, first, last, typeDigit, backspaceDigit, commitDigits, clearDigits, goToBar,
    pinDownbeat: (event) => tap('D', event), pinBeat: (event) => tap('T', event), pinLine, unpin: unpinLine, nudge, renumber, renumberTo,
    changeBeats, applyBar, toggleRamp, scale, tail, setTempoOpenSpan,
    tap, tapAlong, startCalibration, togglePreview,
    setLabel, moveSectionBoundary, addSectionAt, markersToSections,
    reviewSuggestion, setSuggestionBlock, applySuggestionReview,
    beginAudition, endAudition,
    undo: () => history(false), redo: () => history(true), destroy,
  };
}
