// Practice undo (architecture §2.14.6, spec §4.14): one stack per song session,
// 50 steps, with value changes of the same kind coalescing within 1 s.
//
//   push({key, label, describe, from, to, apply, coalesce, gesture})  a value entry (practice patches):
//       undo → apply(from), redo → apply(to). Only coalescing keys merge (transport
//       rule 19: `speed` and `level:<stem>` by default; `coalesce` overrides per push):
//       a coalescing push with the same `key` within `coalesceMs` of the previous
//       coalescing push merges into it, keeping the first `from` (a speed drag is one
//       step). A merge that lands back on `from` removes the step. `loop`, `mix`,
//       `markers`, `spots`, `section` and `startOver` pushes are always their own step.
//   beginGesture(key) → token {key, active, end()}  a gesture-bounded step (§2.14.6,
//       ticket I2a-1): value pushes with this `key` that carry `{gesture: token}` merge
//       into one entry however far apart they are (a speed drag that pauses past
//       `coalesceMs` is still one step), whatever `coalesce` says. The gesture's first
//       push never merges into an earlier entry, and a push without the token never
//       merges into the gesture's entry. After `end()` (idempotent) the next push starts
//       a new entry; an ended token, a foreign token or a token for another key is
//       ignored (the push follows the normal rules). A push of another step in the middle,
//       or an undo, closes the current entry: the gesture's next push starts a fresh one.
//   pushAction({key, label, describe, undo, redo})  a compound entry (map snapshots,
//       D23); action entries never coalesce.
//   amend(entry, {label, undo, redo})  wraps an entry so one Undo also reverts a
//       follow-up change (markers → sections, §2.14.1): undo runs the new undo then
//       the old one; redo runs the old redo then the new one.
//   undo() / redo() → the entry, or null when there is nothing to do.
//   canUndo / canRedo: read-only signals.
//
// The stack shows nothing itself. `stage.js` turns the returned entry into
// "Undid: {describe} [Redo]" (`undidMessage`): a toast when stopped, the status
// line when playing. Wall time comes from the injected clock (src/app/clock.js),
// so coalescing runs on the fake clock in tests.
import {signal, readonly} from '../app/store.js';
import {clock as appClock} from '../app/clock.js';

export const UNDO_LIMIT = 50;
export const COALESCE_MS = 1000;

/** Keys whose value pushes coalesce unless the push says otherwise (transport rule 19, spec §4.14). */
export const coalescesByDefault = (key) => typeof key === 'string' && (key === 'speed' || key.startsWith('level:'));

const same = (a, b) => {
  if (Object.is(a, b)) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
};

/** "Undid: speed 85% → 100%" (spec Appendix A; stage.js adds the [Redo] action). */
export function undidMessage(entry) { return `Undid: ${entry.describe()}`; }
/** "Redid: speed 85% → 100%". */
export function redidMessage(entry) { return `Redid: ${entry.describe()}`; }

export function createPracticeUndo({limit = UNDO_LIMIT, coalesceMs = COALESCE_MS, clock = appClock} = {}) {
  const max = Math.max(1, Math.floor(limit));
  const undoStack = [];
  const redoStack = [];
  const canUndo = signal(false);
  const canRedo = signal(false);
  let last = null;        // the entry the latest push created or extended (coalescing target)
  let lastAt = -Infinity; // when that push happened
  let applying = false;   // an undo/redo is running: pushes from its apply/undo/redo are ignored
  const gestures = new WeakMap(); // token → {key, open, entry}: this stack's gestures

  const sync = () => {
    canUndo.value = undoStack.length > 0;
    canRedo.value = redoStack.length > 0;
  };

  function makeEntry(fields) {
    const entry = {
      kind: fields.kind, key: fields.key, label: fields.label ?? fields.key ?? '',
      from: fields.from, to: fields.to,
      at: clock.now(),
      describe() {
        const text = entry.kind === 'value'
          ? fields.describe?.(entry.from, entry.to)
          : fields.describe?.();
        return text || entry.label;
      },
      _undo: fields.undo, _redo: fields.redo,
    };
    return entry;
  }

  function add(entry) {
    undoStack.push(entry);
    while (undoStack.length > max) undoStack.shift();
    redoStack.length = 0;
    last = entry;
    lastAt = entry.at;
    sync();
    return entry;
  }

  function beginGesture(key) {
    const g = {key, open: true, entry: null};
    const token = {
      key,
      get active() { return g.open; },
      end() {
        if (!g.open) return;
        g.open = false;
        if (g.entry && last === g.entry) last = null;
        g.entry = null;
      },
    };
    gestures.set(token, g);
    return token;
  }

  function pushGesture(g, {key, label, describe, from, to, apply}) {
    const top = undoStack[undoStack.length - 1];
    if (g.entry && top === g.entry && !top.amended) {
      top.to = to;
      lastAt = clock.now();
      if (same(top.from, top.to)) {     // the drag came back to where it started
        undoStack.pop();
        g.entry = null;
        last = null;
        sync();
        return null;
      }
      return top;
    }
    g.entry = null;
    if (same(from, to)) return null;
    const entry = makeEntry({kind: 'value', key, label, describe, from, to,
      undo: () => apply(entry.from), redo: () => apply(entry.to)});
    entry.coalesce = false;             // only this gesture's pushes extend it
    entry.gesture = true;
    g.entry = entry;
    return add(entry);
  }

  function push({key, label, describe, from, to, apply, coalesce, gesture} = {}) {
    if (applying) return null;
    if (typeof apply !== 'function') throw new TypeError('undo.push: apply(value) is required');
    const g = gesture ? gestures.get(gesture) : null;
    if (g && g.open && g.key === key) return pushGesture(g, {key, label, describe, from, to, apply});
    const t = clock.now();
    const merges = coalesce === undefined ? coalescesByDefault(key) : !!coalesce;
    const top = undoStack[undoStack.length - 1];
    if (merges && top && top === last && top.kind === 'value' && top.coalesce && !top.amended && top.key === key
      && t - lastAt <= coalesceMs) {
      top.to = to;
      lastAt = t;
      if (same(top.from, top.to)) {     // back where the run started: nothing left to undo
        undoStack.pop();
        last = null;
        sync();
        return null;
      }
      return top;
    }
    if (same(from, to)) return null;
    const entry = makeEntry({kind: 'value', key, label, describe, from, to,
      undo: () => apply(entry.from), redo: () => apply(entry.to)});
    entry.coalesce = merges;
    return add(entry);
  }

  function pushAction({key, label, describe, undo, redo} = {}) {
    if (applying) return null;
    if (typeof undo !== 'function' || typeof redo !== 'function') throw new TypeError('undo.pushAction: undo() and redo() are required');
    return add(makeEntry({kind: 'action', key, label, describe, undo, redo}));
  }

  function amend(entry, {label, undo, redo} = {}) {
    if (!entry || typeof entry._undo !== 'function') throw new TypeError('undo.amend: not an entry');
    const oldUndo = entry._undo, oldRedo = entry._redo;
    entry._undo = () => { undo?.(); oldUndo(); };
    entry._redo = () => { oldRedo(); redo?.(); };
    if (label) entry.label = label;
    entry.amended = true;   // a later push never coalesces into a compound step
    return entry;
  }

  function run(entry, which) {
    applying = true;
    try { entry[which](); } finally { applying = false; }
  }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) return null;
    try {
      run(entry, '_undo');
    } catch (err) {
      sync();
      throw err;
    }
    redoStack.push(entry);
    last = null;
    sync();
    return entry;
  }

  function redo() {
    const entry = redoStack.pop();
    if (!entry) return null;
    try {
      run(entry, '_redo');
    } catch (err) {
      sync();
      throw err;
    }
    undoStack.push(entry);
    while (undoStack.length > max) undoStack.shift();
    last = null;
    sync();
    return entry;
  }

  function clear() {
    undoStack.length = 0;
    redoStack.length = 0;
    last = null;
    sync();
  }

  return {
    push, pushAction, amend, beginGesture, undo, redo, clear,
    canUndo: readonly(canUndo), canRedo: readonly(canRedo),
    /** Steps on each stack (for the dev handle and tests). */
    get size() { return {undo: undoStack.length, redo: redoStack.length}; },
    /** The entry the next Undo would undo, or null (read-only). */
    get top() { return undoStack[undoStack.length - 1] ?? null; },
    /** True while `entry` is the step the next Undo would undo. */
    isTop(entry) { return !!entry && undoStack[undoStack.length - 1] === entry; },
  };
}

export default createPracticeUndo;
