const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { requestFlush, createQuitGuard, installUpdate, BUSY_QUIT_DIALOG } = require('./flush.cjs');

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout: id => pending.delete(id),
    fire: () => { for (const [id, { fn }] of [...pending]) { pending.delete(id); fn(); } },
  };
}

function fakeContents({ reply = true } = {}) {
  const contents = new EventEmitter();
  contents.ipc = new EventEmitter();
  contents.sent = [];
  contents.destroyed = false;
  contents.isDestroyed = () => contents.destroyed;
  contents.mainFrame = { url: 'http://127.0.0.1:47832/' };
  contents.send = (channel, payload) => {
    contents.sent.push([channel, payload]);
    if (reply) queueMicrotask(() => contents.ipc.emit('desktop:flushed', { senderFrame: contents.mainFrame }, { id: payload.id }));
  };
  return contents;
}

test('sends desktop:flush and resolves on the matching desktop:flushed', async () => {
  const contents = fakeContents();
  const timers = fakeTimers();
  const result = await requestFlush(contents, { timers });
  assert.equal(result, 'flushed');
  assert.equal(contents.sent[0][0], 'desktop:flush');
  assert.match(contents.sent[0][1].id, /^flush-\d+$/);
  assert.equal(timers.pending.size, 0, 'the timeout is cleared');
  assert.equal(contents.ipc.listenerCount('desktop:flushed'), 0, 'the listener is removed');
});

test('times out after 3 s when the renderer never answers', async () => {
  const contents = fakeContents({ reply: false });
  const timers = fakeTimers();
  const pending = requestFlush(contents, { timers });
  assert.equal([...timers.pending.values()][0].ms, 3000);
  // A stale or foreign reply does not count.
  contents.ipc.emit('desktop:flushed', {}, { id: 'flush-0' });
  contents.ipc.emit('desktop:flushed', {}, null);
  timers.fire();
  assert.equal(await pending, 'timeout');
  assert.equal(contents.ipc.listenerCount('desktop:flushed'), 0);
});

test('an untrusted reply is ignored', async () => {
  const contents = fakeContents({ reply: false });
  const timers = fakeTimers();
  const pending = requestFlush(contents, { timers, trusted: event => event.senderFrame === contents.mainFrame });
  const { id } = contents.sent[0][1];
  contents.ipc.emit('desktop:flushed', { senderFrame: { url: 'https://evil.example/' } }, { id });
  contents.ipc.emit('desktop:flushed', { senderFrame: contents.mainFrame }, { id });
  assert.equal(await pending, 'flushed');
});

test('a destroyed or crashing renderer resolves at once', async () => {
  assert.equal(await requestFlush(null), 'gone');
  const destroyed = fakeContents();
  destroyed.destroyed = true;
  assert.equal(await requestFlush(destroyed), 'gone');
  const crashing = fakeContents({ reply: false });
  const timers = fakeTimers();
  const pending = requestFlush(crashing, { timers });
  crashing.emit('render-process-gone');
  assert.equal(await pending, 'gone');
  assert.equal(timers.pending.size, 0);
});

function guard({ busy = false, statusFails = false, answer = 1, closing = false } = {}) {
  const log = [];
  const onClose = createQuitGuard({
    isClosing: () => closing,
    localStatus: async () => { log.push('status'); if (statusFails) throw new Error('down'); return { busy }; },
    showDialog: async options => { log.push(['dialog', options]); return { response: answer }; },
    flush: async () => { log.push('flush'); return 'flushed'; },
    quit: () => log.push('quit'),
  });
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  return { log, onClose, event };
}

test('quit guard: idle → flush then quit', async () => {
  const h = guard();
  await h.onClose(h.event);
  assert.equal(h.event.prevented, true);
  assert.deepEqual(h.log, ['status', 'flush', 'quit']);
});

test('quit guard: busy + Quit Woodshed → flush after the decision, then quit', async () => {
  const h = guard({ busy: true, answer: 1 });
  await h.onClose(h.event);
  assert.equal(h.log[1][0], 'dialog');
  assert.deepEqual(h.log[1][1], BUSY_QUIT_DIALOG);
  assert.deepEqual(h.log.slice(2), ['flush', 'quit']);
});

test('quit guard: busy + Keep processing → no flush, no quit', async () => {
  const h = guard({ busy: true, answer: 0 });
  await h.onClose(h.event);
  assert.equal(h.event.prevented, true);
  assert.deepEqual(h.log.filter(x => typeof x === 'string'), ['status']);
});

test('quit guard: unreadable status still flushes and quits; closing passes straight through', async () => {
  const h = guard({ statusFails: true });
  await h.onClose(h.event);
  assert.deepEqual(h.log, ['status', 'flush', 'quit']);
  const closing = guard({ closing: true });
  await closing.onClose(closing.event);
  assert.equal(closing.event.prevented, false);
  assert.deepEqual(closing.log, []);
});

test('quit guard copy is unchanged', () => {
  assert.equal(BUSY_QUIT_DIALOG.message, 'A song is still processing');
  assert.equal(BUSY_QUIT_DIALOG.detail, 'Quitting stops this job. Completed local stages can resume when you reopen Woodshed.');
  assert.deepEqual(BUSY_QUIT_DIALOG.buttons, ['Keep processing', 'Quit Woodshed']);
});

test('update install flushes before stopping the companion, then installs', async () => {
  const log = [];
  await installUpdate({
    markClosing: () => log.push('closing'),
    flush: async () => { log.push('flush'); throw new Error('renderer gone'); },
    stopCompanion: async () => log.push('stop'),
    quitAndInstall: () => log.push('install'),
  });
  assert.deepEqual(log, ['closing', 'flush', 'stop', 'install']);
});
