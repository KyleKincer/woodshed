// companion/heartbeat.mjs: device presence cadence (B5, §6.10 CPB item 8), with fake timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeartbeat, HEARTBEAT_INTERVAL_MS, OFFLINE_TIMEOUT_MS } from './heartbeat.mjs';

/** A fake clock with setTimeout/setInterval that only advance through tick(). */
function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => {
    const id = { id: ++seq, unrefed: false, unref() { this.unrefed = true; return this; } };
    timers.set(id, { fn, at: now + ms, every });
    return id;
  };
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, null),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearTimeout: id => timers.delete(id),
    clearInterval: id => timers.delete(id),
    get pending() { return timers.size; },
    timers,
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function setup({ send, describe } = {}) {
  const clock = fakeClock();
  const beats = [];
  const logs = [];
  const heartbeat = createHeartbeat({
    send: send ?? (beat => { beats.push({ at: clock.now(), ...beat }); return Promise.resolve(null); }),
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    now: clock.now,
    describe: describe ?? (() => ({ appVersion: '2.0.0', platform: 'darwin-arm64' })),
    log: (...args) => logs.push(args.join(' ')),
  });
  return { clock, beats, logs, heartbeat };
}

test('beats on start, then every 60 s, on an unref’d interval', async () => {
  const { clock, beats, heartbeat } = setup();
  heartbeat.start();
  await settle();
  assert.deepEqual(beats, [{ at: 0, state: 'idle', appVersion: '2.0.0', platform: 'darwin-arm64' }]);
  const [interval] = [...clock.timers.keys()];
  assert.equal(interval.unrefed, true);
  await clock.tick(HEARTBEAT_INTERVAL_MS * 3);
  assert.deepEqual(beats.map(b => b.at), [0, 60_000, 120_000, 180_000]);
  // The descriptive fields go out once; state rides on every beat.
  assert.deepEqual(beats.slice(1), [60_000, 120_000, 180_000].map(at => ({ at, state: 'idle' })));
});

test('job start and end beat at once with the job id, and the next tick is skipped when one just went out', async () => {
  const { clock, beats, heartbeat } = setup();
  heartbeat.start();
  await clock.tick(50_000);
  heartbeat.jobStarted('job1');
  await settle();
  assert.deepEqual(beats.at(-1), { at: 50_000, state: 'busy', currentJobId: 'job1' });
  await clock.tick(10_000); // t = 60 s: a beat went out 10 s ago
  assert.equal(beats.length, 2);
  await clock.tick(60_000); // t = 120 s
  assert.deepEqual(beats.at(-1), { at: 120_000, state: 'busy', currentJobId: 'job1' });
  heartbeat.jobEnded();
  await settle();
  assert.deepEqual(beats.at(-1), { at: 120_000, state: 'idle' });
  // No gap ever reaches the 150 s online window.
  await clock.tick(600_000);
  const gaps = beats.slice(1).map((b, i) => b.at - beats[i].at);
  assert.ok(Math.max(...gaps) <= 90_000, `gaps ${gaps}`);
});

test('descriptive fields are re-sent when they change, and after a failed beat', async () => {
  let accelerator;
  let fail = false;
  const clock = fakeClock();
  const beats = [];
  const heartbeat = createHeartbeat({
    send: beat => (fail ? Promise.reject(new Error('offline')) : (beats.push(beat), Promise.resolve(null))),
    setInterval: clock.setInterval, clearInterval: clock.clearInterval, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    now: clock.now, describe: () => ({ appVersion: ' 2.0.0 ', accelerator }), log: () => {},
  });
  fail = true;
  heartbeat.start();
  await settle();
  fail = false;
  await clock.tick(60_000);
  assert.deepEqual(beats, [{ state: 'idle', appVersion: '2.0.0' }]);
  accelerator = 'Apple GPU';
  heartbeat.jobEnded();
  await settle();
  assert.deepEqual(beats.at(-1), { state: 'idle', appVersion: '2.0.0', accelerator: 'Apple GPU' });
  await clock.tick(60_000);
  assert.deepEqual(beats.at(-1), { state: 'idle' });
});

test('a failing beat is logged and never throws into the caller', async () => {
  const { heartbeat, logs } = setup({ send: () => Promise.reject(new Error('device_unpaired')) });
  heartbeat.start();
  heartbeat.jobStarted('j');
  heartbeat.jobEnded();
  await settle();
  assert.equal(logs.length, 3);
  assert.match(logs[0], /Heartbeat: device_unpaired/);
  const thrower = setup({ send: () => { throw new Error('sync throw'); } });
  thrower.heartbeat.start();
  await settle();
  assert.match(thrower.logs[0], /sync throw/);
});

test('stop reports offline once and clears the interval', async () => {
  const { clock, beats, heartbeat } = setup();
  heartbeat.start();
  heartbeat.jobStarted('j9');
  await heartbeat.stop();
  assert.deepEqual(beats.at(-1), { at: 0, state: 'offline' });
  assert.equal(heartbeat.running, false);
  assert.equal(clock.pending, 0);
  const count = beats.length;
  heartbeat.jobEnded();
  await clock.tick(300_000);
  await heartbeat.stop();
  assert.equal(beats.length, count, 'no beats after stop');
});

test('stop is raced against 1 s when the server does not answer', async () => {
  const { clock, heartbeat } = setup({ send: beat => (beat.state === 'offline' ? new Promise(() => {}) : Promise.resolve(null)) });
  heartbeat.start();
  let done = false;
  const stopped = heartbeat.stop().then(() => { done = true; });
  await clock.tick(OFFLINE_TIMEOUT_MS - 1);
  assert.equal(done, false);
  await clock.tick(1);
  await stopped;
  assert.equal(done, true);
});

test('start after stop beats again with the descriptive fields', async () => {
  const { beats, heartbeat } = setup();
  heartbeat.start();
  await heartbeat.stop();
  heartbeat.start();
  await settle();
  assert.deepEqual(beats.map(({ at, ...b }) => b), [
    { state: 'idle', appVersion: '2.0.0', platform: 'darwin-arm64' },
    { state: 'offline' },
    { state: 'idle', appVersion: '2.0.0', platform: 'darwin-arm64' },
  ]);
  assert.equal(heartbeat.state, 'idle');
});
