const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { restoreBounds, createWindowState, watchFullScreen, DEFAULT_SIZE, MIN_SIZE } = require('./window-state.cjs');

const laptop = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const external = { id: 2, workArea: { x: 1440, y: 0, width: 2560, height: 1440 } };
const screenInfo = displays => ({ displays, primary: displays[0] });

test('saved bounds on a connected display are restored', () => {
  const saved = { x: 1600, y: 100, width: 1500, height: 1000, maximized: false, fullScreen: false, displayId: 2 };
  assert.deepEqual(restoreBounds(saved, screenInfo([laptop, external])), {
    bounds: { x: 1600, y: 100, width: 1500, height: 1000 }, maximized: false, fullScreen: false,
  });
});

test('off-screen bounds (display unplugged) centre the default size on the primary display', () => {
  const saved = { x: 1600, y: 100, width: 1500, height: 1000, displayId: 2 };
  const { bounds } = restoreBounds(saved, screenInfo([laptop]));
  assert.deepEqual(bounds, { x: 80, y: 38, width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height });
});

test('a sliver under 100×100 px visible does not count as on screen', () => {
  const sliver = { x: 1440 - 99, y: 100, width: 800, height: 600 };
  assert.equal(restoreBounds(sliver, screenInfo([laptop])).bounds.x, 80);
  const enough = { x: 1440 - 100, y: 100, width: 800, height: 600 };
  assert.equal(restoreBounds(enough, screenInfo([laptop])).bounds.x, 1340);
  const above = { x: 100, y: -560, width: 800, height: 600 };
  assert.equal(restoreBounds(above, screenInfo([laptop])).bounds.x, 80, 'only 15 px below the work-area top');
});

test('sizes are clamped to the 640×480 minimum', () => {
  const { bounds } = restoreBounds({ x: 10, y: 40, width: 200, height: 100 }, screenInfo([laptop]));
  assert.equal(bounds.width, MIN_SIZE.width);
  assert.equal(bounds.height, MIN_SIZE.height);
});

test('maximized and full screen are carried; garbage falls back to the default', () => {
  assert.equal(restoreBounds({ x: 0, y: 25, width: 1000, height: 700, maximized: true }, screenInfo([laptop])).maximized, true);
  assert.equal(restoreBounds({ x: 0, y: 25, width: 1000, height: 700, fullScreen: true }, screenInfo([laptop])).fullScreen, true);
  for (const saved of [null, {}, { x: 'a', y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: -5, height: 10 }, { x: NaN, y: 0, width: 900, height: 700 }]) {
    assert.deepEqual(restoreBounds(saved, screenInfo([laptop])).bounds, { x: 80, y: 38, width: 1280, height: 850 }, JSON.stringify(saved));
  }
  const small = { id: 3, workArea: { x: 0, y: 0, width: 1024, height: 700 } };
  assert.deepEqual(restoreBounds(null, screenInfo([small])).bounds, { x: 0, y: 0, width: 1024, height: 700 }, 'default shrinks to a small screen');
});

function fakeWindow(bounds = { x: 10, y: 40, width: 1000, height: 700 }) {
  const win = new EventEmitter();
  Object.assign(win, {
    normal: bounds, maximized: false, fullScreen: false, destroyed: false, calls: [],
    getNormalBounds: () => win.normal,
    isMaximized: () => win.maximized,
    isFullScreen: () => win.fullScreen,
    isDestroyed: () => win.destroyed,
    maximize: () => win.calls.push('maximize'),
    setFullScreen: on => win.calls.push(`fullscreen:${on}`),
  });
  return win;
}

function fakeFs(initial) {
  const files = new Map(initial ? [['/user/window-state.json', JSON.stringify(initial)]] : []);
  return {
    files,
    writes: 0,
    readFileSync(file) {
      if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(file);
    },
    mkdirSync() {},
    writeFileSync(file, data) {
      this.writes++;
      files.set(file, data);
    },
  };
}

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout: id => pending.delete(id),
    flush: () => { for (const [id, { fn }] of [...pending]) { pending.delete(id); fn(); } },
  };
}

const fakeScreen = displays => ({
  getAllDisplays: () => displays,
  getPrimaryDisplay: () => displays[0],
  getDisplayMatching: () => displays[0],
});

test('load() reads the file and returns BrowserWindow options with the minimum size', () => {
  const fs = fakeFs({ x: 100, y: 100, width: 900, height: 700, maximized: true });
  const state = createWindowState({ file: '/user/window-state.json', screen: fakeScreen([laptop]), fs, timers: fakeTimers() });
  const restored = state.load();
  assert.deepEqual(restored.options, { x: 100, y: 100, width: 900, height: 700, minWidth: 640, minHeight: 480 });
  const win = fakeWindow();
  state.applyAfterShow(win, restored);
  assert.deepEqual(win.calls, ['maximize']);
  const full = fakeWindow();
  state.applyAfterShow(full, { maximized: true, fullScreen: true });
  assert.deepEqual(full.calls, ['fullscreen:true'], 'full screen wins over maximize');
});

test('a missing or corrupt file opens at the default size', () => {
  const fs = fakeFs();
  fs.files.set('/user/window-state.json', '{not json');
  const state = createWindowState({ file: '/user/window-state.json', screen: fakeScreen([laptop]), fs, timers: fakeTimers() });
  assert.deepEqual(state.load().bounds, { x: 80, y: 38, width: 1280, height: 850 });
});

test('bounds changes save debounced (500 ms) with normal bounds; close saves at once', () => {
  const fs = fakeFs();
  const timers = fakeTimers();
  const state = createWindowState({ file: '/user/window-state.json', screen: fakeScreen([laptop]), fs, timers });
  const win = fakeWindow();
  const untrack = state.track(win);
  for (const name of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.emit(name);
  assert.equal(timers.pending.size, 1, 'one pending save');
  assert.equal([...timers.pending.values()][0].ms, 500);
  assert.equal(fs.writes, 0);
  win.maximized = true; // getNormalBounds still reports the pre-maximize size
  timers.flush();
  assert.equal(fs.writes, 1);
  assert.deepEqual(JSON.parse(fs.files.get('/user/window-state.json')), {
    x: 10, y: 40, width: 1000, height: 700, maximized: true, fullScreen: false, displayId: 1,
  });
  win.emit('move');
  win.normal = { x: 20, y: 50, width: 1100, height: 800 };
  win.emit('close');
  assert.equal(fs.writes, 2, 'close writes synchronously');
  assert.equal(timers.pending.size, 0, 'and cancels the pending save');
  assert.equal(JSON.parse(fs.files.get('/user/window-state.json')).width, 1100);
  untrack();
  win.emit('resize');
  assert.equal(timers.pending.size, 0);
});

test('a write failure is swallowed', () => {
  const fs = fakeFs();
  fs.writeFileSync = () => { throw new Error('EROFS'); };
  const state = createWindowState({ file: '/user/window-state.json', screen: fakeScreen([laptop]), fs, timers: fakeTimers() });
  assert.doesNotThrow(() => state.saveNow(fakeWindow()));
});

test('full-screen changes are sent as desktop:fullscreen {on}', () => {
  const win = fakeWindow();
  const sent = [];
  const off = watchFullScreen(win, (channel, payload) => sent.push([channel, payload]));
  win.emit('enter-full-screen');
  win.emit('leave-full-screen');
  off();
  win.emit('enter-full-screen');
  assert.deepEqual(sent, [['desktop:fullscreen', { on: true }], ['desktop:fullscreen', { on: false }]]);
});
