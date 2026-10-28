// The frame bus (architecture §2.14.7): one requestAnimationFrame loop per
// mounted posture. Canvases subscribe at 60 Hz; text readouts pass `hz: 30` and
// are throttled. The playback position never passes through signals; it flows
// through here once per frame.
//
//   createFrameBus({session, raf, caf, now, isHidden, visibility}) → {subscribe(fn, {hz}) → off, start(), stop()}
//   Frame = {now: ctxTime, position, playing, counting, bar: BarBeat|null}
//
// - `bar` is `map.barBeatAt(position)` when the song is mapped, else null.
// - The bus idles (no rAF requested) while stopped, while it has no subscribers
//   and while the page is hidden; the engine's own 25 ms ticker keeps wraps and
//   end detection running meanwhile (§5). It resumes on `visibilitychange`.
// - `raf`, `caf`, `now` (wall ms, for throttling) and `isHidden` are injected so
//   tests drive frames by hand.
import {now as clockNow} from '../app/clock.js';

/** Slack for throttling, so a 30 Hz subscriber fires on every second 60 Hz frame despite timer jitter. */
const SLACK_MS = 2;

const defaultRaf = (fn) => globalThis.requestAnimationFrame(fn);
const defaultCaf = (id) => globalThis.cancelAnimationFrame(id);
const defaultHidden = () => (typeof document !== 'undefined' ? document.hidden === true : false);
const defaultVisibility = () => (typeof document !== 'undefined' ? document : null);

const report = (err) => {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(err);
  else console.error(err);
};

/** The frame for the session's current state. Exported for tests and for one-off paints. */
export function readFrame(session) {
  const transport = session?.transport;
  const snapshot = transport?.snapshot;
  const state = snapshot ? (typeof snapshot.peek === 'function' ? snapshot.peek() : snapshot.value) : null;
  const phase = state?.phase;
  const position = typeof transport?.position === 'function' ? transport.position() : 0;
  const map = session?.map;
  const mapped = !!map?.isReal;
  return {
    now: session?.engine?.ctx?.currentTime ?? 0,
    position,
    playing: phase === 'playing',
    counting: phase === 'counting',
    bar: mapped && typeof map.barBeatAt === 'function' ? map.barBeatAt(position) : null,
  };
}

export function createFrameBus({session, raf = defaultRaf, caf = defaultCaf, now = clockNow, isHidden = defaultHidden,
  visibility = defaultVisibility()} = {}) {
  const subscribers = new Set();
  let running = false;
  let handle = null;

  const wanted = () => running && subscribers.size > 0 && !isHidden();

  function schedule() {
    if (handle !== null || !wanted()) return;
    handle = raf(tick);
  }

  function cancel() {
    if (handle === null) return;
    caf(handle);
    handle = null;
  }

  function tick() {
    handle = null;
    if (!wanted()) return;
    const t = now();
    let frame = null;
    for (const sub of [...subscribers]) {
      if (!subscribers.has(sub)) continue;   // removed by an earlier subscriber this frame
      if (sub.last !== null && t - sub.last < sub.interval - SLACK_MS) continue;
      sub.last = t;
      frame ??= Object.freeze(readFrame(session));
      try { sub.fn(frame); } catch (err) { report(err); }
    }
    schedule();
  }

  const onVisibility = () => {
    if (isHidden()) cancel();
    else schedule();
  };
  visibility?.addEventListener?.('visibilitychange', onVisibility);

  return {
    /** fn(frame) on every frame, throttled to `hz` (default 60). Returns off(). */
    subscribe(fn, {hz = 60} = {}) {
      if (typeof fn !== 'function') throw new TypeError('frame.subscribe: fn is required');
      const rate = Number.isFinite(hz) && hz > 0 ? hz : 60;
      const sub = {fn, interval: 1000 / rate, last: null};
      subscribers.add(sub);
      schedule();
      return () => {
        subscribers.delete(sub);
        if (!subscribers.size) cancel();
      };
    },
    start() {
      running = true;
      schedule();
    },
    stop() {
      running = false;
      cancel();
    },
    /** Stops the loop for good and drops the visibility listener (posture unmount). */
    destroy() {
      running = false;
      cancel();
      subscribers.clear();
      visibility?.removeEventListener?.('visibilitychange', onVisibility);
    },
    get running() { return running; },
  };
}

export default createFrameBus;
