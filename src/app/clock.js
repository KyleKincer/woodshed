// The single wall-clock source for the app (architecture §0.1).
//
// Everything in the new top-level directories that needs wall time (undo
// coalescing, pedal timing, toasts, the wake-lock policy, presence "online",
// relative times, frecency, practice `updatedAt`) calls `now()` from here; a
// guard test bans `Date.now()` and `performance.now()` everywhere else. Audio
// time is `ctx.currentTime`, never this clock.
//
// `now()` returns epoch milliseconds. By default it reads `Date.now()` at call
// time, so `vi.useFakeTimers({toFake: [..., 'Date']})` and the fixture's
// `fx-now` (which replaces `Date`) both apply without any wiring. Tests and the
// fixture may also pin or replace the source with `set()`.

let source = null;   // null → Date.now(); otherwise () => epoch ms
let offset = 0;      // added by advance()

const toMs = value => {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return new Date(value).getTime();
  return NaN;
};

/** Current wall time in epoch milliseconds. */
export function now() {
  return (source ? source() : Date.now()) + offset;
}

/**
 * Replaces the clock source and clears any `advance()` offset.
 *   set()                         → the real clock (Date.now() at call time)
 *   set(ms | Date | ISO string)   → frozen at that instant (move it with advance())
 *   set(ms | Date | ISO, {ticking: true}) → starts at that instant and runs with the real clock
 *   set(() => ms)                 → a custom source
 */
export function set(value, {ticking = false} = {}) {
  offset = 0;
  if (value == null) { source = null; return; }
  if (typeof value === 'function') { source = value; return; }
  const at = toMs(value);
  if (!Number.isFinite(at)) throw new TypeError(`clock.set: not a time: ${String(value)}`);
  if (ticking) {
    const startedAt = Date.now();
    source = () => at + (Date.now() - startedAt);
  } else {
    source = () => at;
  }
}

/** Moves the clock forward (or back, with a negative value) by `ms`. */
export function advance(ms) {
  if (!Number.isFinite(ms)) throw new TypeError(`clock.advance: not a number: ${String(ms)}`);
  offset += ms;
}

/** Back to the real clock. Same as `set()`. */
export function reset() { set(); }

export const clock = Object.freeze({now, set, advance, reset});
export default clock;
