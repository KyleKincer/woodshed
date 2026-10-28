// Device presence (B5, D11; architecture §6.10 CPB item 8).
//
// The companion tells Convex it is alive through `worker.heartbeat`: on
// connect, every 60 s, at job start and end, and `state: 'offline'` on
// shutdown. "Online" is decided by the client from `lastSeenAt` (online while
// a beat is under 150 s old), so a beat must go out at least every 90 s.
//
// `state` and `currentJobId` ride on every beat (the server clears an absent
// job); the descriptive fields (`appVersion`, `platform`, `accelerator`) only
// on the first beat after start() and whenever they change.
//
// A heartbeat failure is logged and never stops a job.
//
// Effects are arguments (send, timers, clock), so heartbeat.test.mjs drives it
// with fake timers.

export const HEARTBEAT_INTERVAL_MS = 60_000;
/** The offline beat at shutdown is raced against this. */
export const OFFLINE_TIMEOUT_MS = 1_000;

const DESCRIPTIVE = ['appVersion', 'platform', 'accelerator'];

/** The descriptive fields that have a value, trimmed. */
function described(describe) {
  const raw = describe() ?? {};
  const out = {};
  for (const key of DESCRIPTIVE) {
    const value = typeof raw[key] === 'string' ? raw[key].trim() : '';
    if (value) out[key] = value;
  }
  return out;
}

/**
 * @param {{
 *   send: (beat: {state: 'idle'|'busy'|'offline', currentJobId?: string, appVersion?: string, platform?: string, accelerator?: string}) => Promise<unknown>,
 *   setInterval?: typeof globalThis.setInterval, clearInterval?: typeof globalThis.clearInterval,
 *   setTimeout?: typeof globalThis.setTimeout, clearTimeout?: typeof globalThis.clearTimeout,
 *   now?: () => number,
 *   describe?: () => {appVersion?: string, platform?: string, accelerator?: string},
 *   intervalMs?: number, offlineTimeoutMs?: number,
 *   log?: (...args: unknown[]) => void,
 * }} options
 */
export function createHeartbeat({
  send,
  setInterval: every = globalThis.setInterval,
  clearInterval: stopEvery = globalThis.clearInterval,
  setTimeout: after = globalThis.setTimeout,
  clearTimeout: cancelAfter = globalThis.clearTimeout,
  now = Date.now,
  describe = () => ({}),
  intervalMs = HEARTBEAT_INTERVAL_MS,
  offlineTimeoutMs = OFFLINE_TIMEOUT_MS,
  log = (...args) => console.error(...args),
}) {
  let timer = null;
  let running = false;
  let state = 'idle';
  let jobId = null;
  let sentDescription = null; // JSON of the descriptive fields the server last accepted
  let lastBeatAt = -Infinity;

  function beat() {
    const payload = { state, ...(jobId ? { currentJobId: jobId } : {}) };
    const description = described(describe);
    const key = JSON.stringify(description);
    // Counted as sent at once, so beats in flight together carry it once; a failure re-arms it.
    const carries = key !== sentDescription;
    if (carries) { Object.assign(payload, description); sentDescription = key; }
    lastBeatAt = now();
    return Promise.resolve()
      .then(() => send(payload))
      .catch(error => {
        if (carries && sentDescription === key) sentDescription = null;
        log('Heartbeat:', error?.message ?? String(error));
      });
  }

  function tick() {
    // A job start or end beat already went out recently: the next tick covers it.
    if (now() - lastBeatAt < intervalMs / 2) return;
    void beat();
  }

  return {
    /** Starts beating (on connect). Sends the descriptive fields again. */
    start() {
      if (running) return;
      running = true;
      sentDescription = null;
      if (state === 'offline') state = jobId ? 'busy' : 'idle';
      void beat();
      timer = every(tick, intervalMs);
      timer?.unref?.();
    },
    /** A job started on this computer. */
    jobStarted(id) {
      state = 'busy';
      jobId = String(id);
      if (running) void beat();
    },
    /** The current job ended (done, failed or stopped). */
    jobEnded() {
      state = 'idle';
      jobId = null;
      if (running) void beat();
    },
    /** Stops beating and reports `offline`, waiting at most `offlineTimeoutMs`. Never rejects. */
    stop() {
      if (!running) return Promise.resolve();
      running = false;
      if (timer !== null) stopEvery(timer);
      timer = null;
      state = 'offline';
      jobId = null;
      let timeout = null;
      const limit = new Promise(resolve => { timeout = after(resolve, offlineTimeoutMs); timeout?.unref?.(); });
      return Promise.race([beat(), limit]).finally(() => cancelAfter(timeout));
    },
    /** For /status and tests: what the next beat would report. */
    get state() { return state; },
    get currentJobId() { return jobId; },
    get running() { return running; },
  };
}
