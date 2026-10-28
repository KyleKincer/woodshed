// Pedal gestures (architecture §2.7, spec §7.5): the tap / hold / double-tap classifier and the built-in profiles.
// The pedal-mode runtime and the learn flow (startPedals, learn) are added by PD1.

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
