// Pedal gestures (architecture §2.7, spec §7.5): the tap / hold / double-tap classifier, the built-in profiles, the
// pedal-mode runtime (startPedals) and the learn flow (learn).
//
// Pedal mode is per device: prefs.pedals = {enabled, profile, pedals: [{slot, code, canHold}], custom: {[slot]: {tap, hold}}}.
// While it is on and at least one pedal is learned, startPedals installs the dispatcher's pedal handler (dispatch rule 2):
// a learned code then belongs to the pedals, ahead of every keyboard binding, and the classifier turns its presses into
// tap / hold / double-tap commands run through the registry with source 'pedal'. Without pedal mode a pedal is an ordinary
// key: PageUp and PageDown already move between sections (spec §7.5 "out of the box").
//
// A learned key stays an ordinary key where the pedals have nothing to do: with Ctrl, ⌘ or ⌥ held, while a text field has
// focus, and where none of its commands can run (the Library, Settings), so a pedal that sends PageDown still scrolls a
// list. learn() takes every key but Esc, Tab and bare modifiers while it listens, through the same handler slot.

import {setPedalHandler} from './dispatch.js';
import {registry as appRegistry} from './commands.js';
import {prefs as appPrefs} from './prefs.js';
import {computed, effect, untracked} from './store.js';
import {now} from './clock.js';

export const SLOTS = Object.freeze(['left', 'right', 'p3', 'p4']);
export const GESTURES = Object.freeze(['tap', 'hold', 'double']);
export const HOLD_MS = 600;
export const DOUBLE_MS = 350;

export const PROFILES = Object.freeze({
  practice: Object.freeze({
    left: Object.freeze({tap: 'transport.again', hold: 'nav.prevSection'}),
    right: Object.freeze({tap: 'transport.playStop', hold: 'nav.nextSection'}),
    p3: Object.freeze({tap: 'transport.loopToggle'}),
    p4: Object.freeze({tap: 'mix.minusMe'}),
  }),
  navigate: Object.freeze({
    left: Object.freeze({tap: 'nav.prevSection', hold: 'transport.loopToggle'}),
    right: Object.freeze({tap: 'nav.nextSection', hold: 'transport.playStop'}),
    p3: Object.freeze({tap: 'transport.loopToggle'}),
    p4: Object.freeze({tap: 'mix.minusMe'}),
  }),
  pageturn: Object.freeze({
    left: Object.freeze({tap: 'stage.scrollUp', hold: 'stage.scrollTop'}),
    right: Object.freeze({tap: 'stage.scrollDown'}),
  }),
});

/** In a setlist (?set=, B3) the practice profile's right hold moves to the next song. */
export const SETLIST_RIGHT_HOLD = 'setlist.next';

/**
 * The slot → {tap, hold} table for a profile name ('practice' | 'navigate' | 'pageturn' | 'custom'). Custom bindings come
 * from prefs.pedals.custom; `isPedalCommand(id)` keeps only commands marked pedal:true (unknown or ineligible ids drop out).
 */
export function profileBindings(name, {custom = {}, inSetlist = false, isPedalCommand = () => true} = {}) {
  let table;
  if (name === 'custom') {
    table = {};
    for (const slot of SLOTS) {
      const b = custom?.[slot];
      if (!b) continue;
      const tap = typeof b.tap === 'string' && isPedalCommand(b.tap) ? b.tap : undefined;
      const hold = typeof b.hold === 'string' && isPedalCommand(b.hold) ? b.hold : undefined;
      if (tap || hold) table[slot] = {...(tap && {tap}), ...(hold && {hold})};
    }
  } else {
    const base = PROFILES[name] ?? PROFILES.practice;
    table = Object.fromEntries(Object.entries(base).map(([slot, b]) => [slot, {...b}]));
    if (inSetlist && (name === 'practice' || !PROFILES[name])) table.right = {...table.right, hold: SETLIST_RIGHT_HOLD};
  }
  return table;
}

/**
 * The classifier's actionFor(slot, gesture) for a bindings table. A hold-capable pedal uses 'hold'; a pedal that cannot
 * report a hold uses 'double' (≤ doubleMs) as its hold action (spec §7.5).
 */
export function actionsFor(bindings, {canHold = () => true} = {}) {
  return (slot, gesture) => {
    const b = bindings?.[slot];
    if (!b) return null;
    if (gesture === 'tap') return b.tap ?? null;
    if (gesture === 'hold') return canHold(slot) ? b.hold ?? null : null;
    if (gesture === 'double') return canHold(slot) ? null : b.hold ?? null;
    return null;
  };
}

/**
 * Classifies pedal key events into tap / hold / double gestures.
 *   slotFor(e) → 'left'|'right'|'p3'|'p4'|null; actionFor(slot, gesture) → commandId|null; fire(commandId, {slot, gesture});
 *   canHold(slot) → boolean (default true): whether the pedal reports a hold (auto-repeat or a long keydown→keyup).
 * Rules:
 *   keydown (not repeat): no hold and no double action → fire tap at once (keydown latency: the Play/Stop rule);
 *     otherwise, when a hold action exists, start the hold timer (holdMs).
 *   auto-repeat keydown → fire hold once (the press is then consumed).
 *   hold timer elapses → fire hold (consumed).
 *   keyup of an unconsumed press: a pedal that cannot hold and has a double action waits doubleMs for a second press;
 *     a second keyup inside the window fires double, otherwise tap fires when the window closes. Every other pedal fires tap.
 * down(e) and up(e) return true when the event belonged to a slot.
 */
export function createClassifier({holdMs = HOLD_MS, doubleMs = DOUBLE_MS, slotFor, actionFor, fire, canHold = () => true} = {}) {
  if (typeof slotFor !== 'function' || typeof actionFor !== 'function' || typeof fire !== 'function') {
    throw new TypeError('createClassifier needs slotFor, actionFor and fire.');
  }
  const presses = new Map();   // slot → {consumed, holdTimer}
  const windows = new Map();   // slot → double-tap window timer

  const emit = (slot, gesture) => {
    const id = actionFor(slot, gesture);
    if (id) fire(id, {slot, gesture});
    return !!id;
  };

  const clearHold = press => {
    if (press?.holdTimer != null) { clearTimeout(press.holdTimer); press.holdTimer = null; }
  };

  function down(e) {
    const slot = slotFor(e);
    if (!slot) return false;
    const current = presses.get(slot);
    if (e.repeat) {
      if (current && !current.consumed) {
        clearHold(current);
        current.consumed = true;
        emit(slot, 'hold');
      }
      return true;
    }
    if (current) clearHold(current);
    const press = {consumed: false, holdTimer: null};
    presses.set(slot, press);
    const hasHold = actionFor(slot, 'hold') != null;
    const hasDouble = actionFor(slot, 'double') != null;
    if (!hasHold && !hasDouble) {
      press.consumed = true;
      emit(slot, 'tap');
      return true;
    }
    if (hasHold) {
      press.holdTimer = setTimeout(() => {
        press.holdTimer = null;
        if (presses.get(slot) !== press || press.consumed) return;
        press.consumed = true;
        emit(slot, 'hold');
      }, holdMs);
    }
    return true;
  }

  function up(e) {
    const slot = slotFor(e);
    if (!slot) return false;
    const press = presses.get(slot);
    if (!press) return true;
    presses.delete(slot);
    clearHold(press);
    if (press.consumed) return true;
    if (!canHold(slot) && actionFor(slot, 'double') != null) {
      const pending = windows.get(slot);
      if (pending != null) {
        clearTimeout(pending);
        windows.delete(slot);
        emit(slot, 'double');
      } else {
        windows.set(slot, setTimeout(() => {
          windows.delete(slot);
          emit(slot, 'tap');
        }, doubleMs));
      }
      return true;
    }
    emit(slot, 'tap');
    return true;
  }

  function reset() {
    for (const press of presses.values()) clearHold(press);
    for (const t of windows.values()) clearTimeout(t);
    presses.clear();
    windows.clear();
  }

  return {down, up, reset};
}

// ---------------------------------------------------------------------------------------------------------------
// Pedal mode: the per-device configuration (prefs.pedals)

export const PROFILE_NAMES = Object.freeze(['practice', 'navigate', 'pageturn', 'custom']);
/** Pedal mode learns two to four pedals (spec §7.5). */
export const MIN_PEDALS = 2;
export const MAX_PEDALS = SLOTS.length;
/** The registry `source` of a command a pedal ran (MIDI uses 'midi'). */
export const PEDAL_SOURCE = 'pedal';

/** What learn() asks for, in order (architecture §2.7). */
export const LEARN_PROMPTS = Object.freeze({
  left: 'Press the left pedal…',
  hold: 'Hold it for a second…',
  right: 'Press the right pedal…',
  p3: 'Third pedal (or Done)…',
  p4: 'Fourth pedal (or Done)…',
});

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const validCode = code => typeof code === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(code);

/**
 * prefs.pedals as the runtime reads it: a known profile, learned pedals with a slot and a code each (first wins, in slot
 * order, at most four), custom bindings of command-id strings, and `on` (enabled with at least one pedal learned).
 * Stored data from any earlier shape reads back without throwing; unknown parts are dropped.
 */
export function pedalConfig(raw) {
  const src = isObject(raw) ? raw : {};
  const profile = PROFILE_NAMES.includes(src.profile) ? src.profile : 'practice';
  const bySlot = new Map();
  const codes = new Set();
  for (const p of Array.isArray(src.pedals) ? src.pedals : []) {
    if (!isObject(p) || !SLOTS.includes(p.slot) || !validCode(p.code)) continue;
    if (bySlot.has(p.slot) || codes.has(p.code)) continue;
    bySlot.set(p.slot, {slot: p.slot, code: p.code, canHold: p.canHold !== false});
    codes.add(p.code);
  }
  const pedals = SLOTS.filter(s => bySlot.has(s)).map(s => bySlot.get(s));
  const custom = {};
  for (const slot of SLOTS) {
    const b = isObject(src.custom) ? src.custom[slot] : null;
    if (!isObject(b)) continue;
    const entry = {};
    if (typeof b.tap === 'string' && b.tap) entry.tap = b.tap;
    if (typeof b.hold === 'string' && b.hold) entry.hold = b.hold;
    if (entry.tap || entry.hold) custom[slot] = entry;
  }
  const enabled = src.enabled === true;
  return {enabled, profile, pedals, custom, on: enabled && pedals.length > 0};
}

/** True while pedal mode is on: enabled, with at least one pedal learned. */
export function isPedalMode(raw) {
  return pedalConfig(raw).on;
}

/** Pedal mode on this device (the HUD's ⎍ indicator; the Stage frame passes it as `stage.pedalMode`). */
export const pedalMode = computed(() => isPedalMode(appPrefs.value.value?.pedals));

/** The registry commands a custom pedal may run (pedal: true), by group then title. */
export function pedalCommands(registry = appRegistry) {
  const ctx = registry.context();
  return registry.all()
    .filter(def => def.pedal)
    .map(def => ({id: def.id, group: def.group, title: registry.titleFor(def.id, ctx) || def.id}))
    .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------------------------------------------
// The handler slot: learn() takes it from the runtime while it listens, then gives it back.

let runtimeHandler = null;
let learnHandler = null;
let stopRuntime = null;

function applyHandler() {
  setPedalHandler(learnHandler ?? runtimeHandler);
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Fn', 'FnLock', 'Hyper', 'Super', 'CapsLock', 'NumLock', 'ScrollLock']);
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'submit', 'reset', 'hidden']);

function isTextField(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const tag = n.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(String(n.type || 'text').toLowerCase());
    if (n.isContentEditable || n.hasAttribute('data-text-input')) return true;
    if (n.hasAttribute('contenteditable') && n.getAttribute('contenteditable') !== 'false') return true;
  }
  return false;
}

const withModifier = e => !!(e.ctrlKey || e.metaKey || e.altKey);
const peek = v => (v && typeof v === 'object' && typeof v.peek === 'function' ? v.peek() : v);

/**
 * Starts pedal mode (boot step 7) and returns `stop`. It follows prefs.pedals: while pedal mode is on it installs the
 * dispatcher's pedal handler, and swaps or removes it when the pedals, the profile or the custom bindings change (a pedal
 * held across the change still ends on the handler that took its keydown). Options exist for tests and harnesses:
 * `registry`, `prefs` (an object with a `.value` signal of the prefs), `document`, `holdMs`, `doubleMs`, `onFire`.
 */
export function startPedals({registry = appRegistry, prefs = appPrefs, document: doc = globalThis.document,
  holdMs = HOLD_MS, doubleMs = DOUBLE_MS, onFire = null} = {}) {
  stopRuntime?.();
  let config = null, key = '', classifier = null, codes = new Map(), slots = new Map();
  const down = new Set();     // codes this handler took a keydown for and has not seen the keyup of
  const isPedalCommand = id => !!registry.get(id)?.pedal;

  const inSetlist = () => {
    try { return !!peek(registry.context().stage?.setlist); } catch { return false; }
  };
  const bindings = () => profileBindings(config.profile, {custom: config.custom, inSetlist: inSetlist(), isPedalCommand});
  const canHold = slot => slots.get(slot)?.canHold !== false;
  const actionFor = (slot, gesture) => actionsFor(bindings(), {canHold})(slot, gesture);
  const fire = (id, detail) => {
    const ran = registry.run(id, {source: PEDAL_SOURCE});
    onFire?.(id, {...detail, ran});
  };

  const handler = {
    owns(e) {
      if (!config?.on || !codes.has(e.code)) return false;
      if (down.has(e.code)) return true;                  // the rest of a press this handler took
      if (withModifier(e) || isTextField(doc?.activeElement ?? null)) return false;
      const b = bindings()[codes.get(e.code).slot];
      return !!b && [b.tap, b.hold].some(id => id && registry.isEnabled(id));
    },
    down(e) {
      down.add(e.code);
      classifier?.down(e);
    },
    up(e) {
      down.delete(e.code);
      classifier?.up(e);
    },
  };

  function configure(next) {
    const nextKey = JSON.stringify(next);
    if (nextKey === key) return;
    key = nextKey;
    classifier?.reset();
    down.clear();
    config = next;
    codes = new Map(next.pedals.map(p => [p.code, p]));
    slots = new Map(next.pedals.map(p => [p.slot, p]));
    classifier = next.on ? createClassifier({holdMs, doubleMs, slotFor: e => codes.get(e.code)?.slot ?? null, actionFor, fire, canHold}) : null;
    runtimeHandler = next.on ? handler : null;
    applyHandler();
  }

  const off = effect(() => {
    const next = pedalConfig(prefs.value.value?.pedals);
    untracked(() => configure(next));
  });

  const stop = () => {
    off();
    classifier?.reset();
    classifier = null;
    down.clear();
    if (runtimeHandler === handler) {
      runtimeHandler = null;
      applyHandler();
    }
    if (stopRuntime === stop) stopRuntime = null;
  };
  stopRuntime = stop;
  return stop;
}

// ---------------------------------------------------------------------------------------------------------------
// Learn my pedal

const abortError = () => {
  try { return new DOMException('Learning the pedals was cancelled.', 'AbortError'); } catch {
    const err = new Error('Learning the pedals was cancelled.');
    err.name = 'AbortError';
    return err;
  }
};

let cancelLearn = null;

/**
 * Learns two to four pedals and resolves {pedals: [{slot, code, canHold}]} (it does not save them). For each slot it asks
 * for a press (onPrompt: 'Press the left pedal…', 'Press the right pedal…', 'Third pedal (or Done)…', 'Fourth pedal (or
 * Done)…'), then 'Hold it for a second…': canHold is true when an auto-repeat keydown, or a keyup at least holdMs after
 * its keydown, was seen for that pedal. onPrompt(text, {step: 'press'|'hold', slot, learned}) runs at every step.
 * `done` (an AbortSignal) finishes with the pedals learned so far once there are at least two; `signal` cancels (the
 * promise rejects with an AbortError). Esc, Tab, bare modifiers and keys with Ctrl, ⌘ or ⌥ are never learned, so a
 * dialog around the flow still closes on Esc. A new learn() cancels one in progress.
 */
export function learn({onPrompt = () => {}, signal = null, done = null, holdMs = HOLD_MS, slots = SLOTS} = {}) {
  cancelLearn?.();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const order = slots.filter(s => SLOTS.includes(s)).slice(0, MAX_PEDALS);
    const learned = [];
    // {kind: 'press', slot, code, at, repeated} or {kind: 'hold', slot, code, at, repeated, evidence}
    let step = null;
    let finished = false;

    const detail = () => ({step: step.kind, slot: step.slot, learned: learned.map(p => ({...p}))});
    const ask = (kind, slot, evidence = false) => {
      step = {kind, slot, code: kind === 'hold' ? step.code : null, at: null, repeated: false, evidence};
      onPrompt(kind === 'hold' ? LEARN_PROMPTS.hold : LEARN_PROMPTS[slot], detail());
    };

    function cleanup() {
      finished = true;
      signal?.removeEventListener?.('abort', onAbort);
      done?.removeEventListener?.('abort', onDone);
      if (learnHandler === handler) { learnHandler = null; applyHandler(); }
      if (cancelLearn === cancel) cancelLearn = null;
    }
    function finish() {
      if (finished) return;
      cleanup();
      resolve({pedals: learned.map(p => ({...p}))});
    }
    function cancel() {
      if (finished) return;
      cleanup();
      reject(abortError());
    }
    function onAbort() { cancel(); }
    function onDone() { if (learned.length >= Math.min(MIN_PEDALS, order.length)) finish(); }

    const taken = code => learned.some(p => p.code === code);

    const handler = {
      owns: e => !finished && !!e.code && !withModifier(e) && e.key !== 'Escape' && e.key !== 'Tab' && !MODIFIER_KEYS.has(e.key),
      down(e) {
        if (e.repeat) {
          if (e.code === step.code) step.repeated = true;
          return;
        }
        if (step.kind === 'press') {
          if (step.code != null || taken(e.code)) return;
          step.code = e.code;
          step.at = now();
        } else if (e.code === step.code) {
          step.at = now();
        }
      },
      up(e) {
        if (e.code !== step.code || step.at == null) return;
        const long = now() - step.at >= holdMs;
        if (step.kind === 'press') {
          ask('hold', step.slot, step.repeated || long);
          return;
        }
        learned.push({slot: step.slot, code: step.code, canHold: step.evidence || step.repeated || long});
        const next = order[learned.length];
        if (!next) { finish(); return; }
        ask('press', next);
      },
    };

    signal?.addEventListener?.('abort', onAbort, {once: true});
    done?.addEventListener?.('abort', onDone);
    cancelLearn = cancel;
    learnHandler = handler;
    applyHandler();
    step = {kind: 'press', slot: order[0], code: null};
    ask('press', order[0]);
    if (done?.aborted) onDone();
  });
}
