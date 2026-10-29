const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// The preload requires only 'electron'; give it a fake through the module cache.
function loadPreload() {
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoked = [];
  ipcRenderer.sentToMain = [];
  ipcRenderer.invoke = (channel, ...args) => {
    ipcRenderer.invoked.push([channel, ...args]);
    return Promise.resolve({ channel });
  };
  ipcRenderer.send = (channel, ...args) => ipcRenderer.sentToMain.push([channel, ...args]);
  const exposed = {};
  const electron = { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } }, ipcRenderer };
  const electronPath = require.resolve('electron');
  const preloadPath = path.join(__dirname, 'preload.cjs');
  const fake = new Module(electronPath);
  fake.filename = electronPath;
  fake.loaded = true;
  fake.exports = electron;
  const saved = require.cache[electronPath];
  require.cache[electronPath] = fake;
  delete require.cache[preloadPath];
  try {
    require(preloadPath);
  } finally {
    if (saved) require.cache[electronPath] = saved;
    else delete require.cache[electronPath];
    delete require.cache[preloadPath];
  }
  return { api: exposed.woodshedDesktop, ipcRenderer };
}

const BRIDGE = ['info', 'update', 'onUpdate', 'onOpenUpdates', 'setTheme', 'mediaUrl', 'onProcessorState', 'restartProcessor',
  'registerMenu', 'onCommand', 'setActivity', 'setBackgroundShortcuts', 'notify', 'onNavigate', 'onFlushRequest', 'onFullScreen'];

test('the bridge is exactly the final contract, frozen', () => {
  const { api } = loadPreload();
  assert.deepEqual(Object.keys(api).sort(), [...BRIDGE].sort());
  assert.ok(Object.isFrozen(api));
  for (const name of BRIDGE) assert.equal(typeof api[name], 'function', name);
});

test('invoke and send methods use their channels', async () => {
  const { api, ipcRenderer } = loadPreload();
  await api.info();
  await api.update('show');
  await api.setTheme('dark');
  await api.mediaUrl('https://x.r2.cloudflarestorage.com/a');
  await api.restartProcessor();
  await api.notify({ title: 'Woodshed', body: 'Ready', route: '/s/a' });
  await api.setBackgroundShortcuts(true);
  await api.setBackgroundShortcuts('yes', { promptAccessibility: true });
  assert.deepEqual(ipcRenderer.invoked, [
    ['desktop:info'],
    ['desktop:update', 'show'],
    ['desktop:theme', 'dark'],
    ['desktop:media-url', 'https://x.r2.cloudflarestorage.com/a'],
    ['desktop:restart-processor'],
    ['desktop:notify', { title: 'Woodshed', body: 'Ready', route: '/s/a' }],
    ['desktop:global-shortcuts', true, { promptAccessibility: false }],
    ['desktop:global-shortcuts', false, { promptAccessibility: true }],
  ]);
  const spec = [{ menu: 'file', items: [] }];
  api.registerMenu(spec);
  api.setActivity({ playing: true, songOpen: false, keepAwake: 'x', extra: 1 });
  assert.deepEqual(ipcRenderer.sentToMain, [['desktop:menu', spec], ['desktop:activity', { playing: true, songOpen: false }]]);
});

test('every on* subscribes to its channel and returns an unsubscribe', () => {
  const { api, ipcRenderer } = loadPreload();
  const cases = [
    ['onUpdate', 'desktop:update-state', { status: 'ready' }, { status: 'ready' }],
    ['onOpenUpdates', 'desktop:open-updates', undefined, undefined],
    ['onProcessorState', 'desktop:processor-state', { phase: 'ready' }, { phase: 'ready' }],
    ['onCommand', 'desktop:command', { id: 'transport.playStop', source: 'global', junk: 1 }, { id: 'transport.playStop', source: 'global' }],
    ['onNavigate', 'desktop:navigate', '/s/song1', '/s/song1'],
    ['onFullScreen', 'desktop:fullscreen', { on: true }, true],
  ];
  for (const [method, channel, payload, expected] of cases) {
    const received = [];
    const off = api[method](value => received.push(value));
    assert.equal(typeof off, 'function', method);
    ipcRenderer.emit(channel, {}, payload);
    off();
    ipcRenderer.emit(channel, {}, payload);
    assert.deepEqual(received, [expected], method);
    assert.equal(ipcRenderer.listenerCount(channel), 0, `${method} removed its listener`);
    assert.throws(() => api[method]('not a function'), TypeError);
  }
  const fullScreen = [];
  api.onFullScreen(on => fullScreen.push(on));
  ipcRenderer.emit('desktop:fullscreen', {}, { on: false });
  ipcRenderer.emit('desktop:fullscreen', {}, null);
  assert.deepEqual(fullScreen, [false, false]);
});

test('a flush request runs every registered callback, then answers with the request id', async () => {
  const { api, ipcRenderer } = loadPreload();
  const order = [];
  let release;
  const offSlow = api.onFlushRequest(() => new Promise(resolve => { release = () => { order.push('slow'); resolve(); }; }));
  api.onFlushRequest(() => { order.push('sync'); });
  api.onFlushRequest(() => { throw new Error('one failing save does not block the rest'); });
  ipcRenderer.emit('desktop:flush', {}, { id: 'flush-7' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ipcRenderer.sentToMain, [], 'waits for pending saves');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['sync', 'slow']);
  assert.deepEqual(ipcRenderer.sentToMain, [['desktop:flushed', { id: 'flush-7' }]]);
  offSlow();
});

test('a flush with nothing registered answers at once', async () => {
  const { ipcRenderer } = loadPreload();
  ipcRenderer.emit('desktop:flush', {}, { id: 'flush-1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ipcRenderer.sentToMain, [['desktop:flushed', { id: 'flush-1' }]]);
});

test('the preload is self-contained (a sandboxed preload may require only electron)', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
  assert.deepEqual(requires, ['electron']);
});
