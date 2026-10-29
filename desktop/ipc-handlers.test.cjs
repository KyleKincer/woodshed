const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  INVOKE_CHANNELS, SEND_CHANNELS, GLOBAL_SHORTCUTS, PROCESSOR_MESSAGES,
  createTrust, validateNotification, validateActivity, createDesktopPrefs, createGlobalShortcuts,
  createCompanionHost, companionEnv, deviceName, createHandlers,
} = require('./ipc-handlers.cjs');

const UI = 'http://127.0.0.1:47832';
const tick = () => new Promise(resolve => setImmediate(resolve));

// ---------- fakes ----------

function fakeIpcMain() {
  const ipc = new EventEmitter();
  ipc.handlers = new Map();
  ipc.handle = (channel, fn) => {
    if (ipc.handlers.has(channel)) throw new Error(`second handler for ${channel}`);
    ipc.handlers.set(channel, fn);
  };
  ipc.removeHandler = channel => ipc.handlers.delete(channel);
  ipc.invoke = (channel, event, ...args) => Promise.resolve().then(() => ipc.handlers.get(channel)(event, ...args));
  return ipc;
}

function fakeWindow() {
  const win = new EventEmitter();
  win.mainFrame = { url: `${UI}/` };
  win.sent = [];
  win.calls = [];
  win.focused = true;
  win.minimized = false;
  win.webContents = { mainFrame: win.mainFrame, send: (channel, payload) => win.sent.push([channel, payload]) };
  win.isDestroyed = () => false;
  win.isFocused = () => win.focused;
  win.isMinimized = () => win.minimized;
  win.restore = () => win.calls.push('restore');
  win.show = () => win.calls.push('show');
  win.focus = () => win.calls.push('focus');
  return win;
}

function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFileSync(file) {
      if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(file);
    },
    mkdirSync() {},
    writeFileSync(file, data) { files.set(file, String(data)); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
}

function fakeGlobalShortcut({ taken = [], throws = [] } = {}) {
  const registered = new Map();
  return {
    registered,
    unregisterAllCalls: 0,
    register(accelerator, fn) {
      if (throws.includes(accelerator)) throw new Error('bad accelerator');
      if (taken.includes(accelerator)) return false;
      registered.set(accelerator, fn);
      return true;
    },
    unregisterAll() { this.unregisterAllCalls++; registered.clear(); },
  };
}

class FakeNotification extends EventEmitter {
  static supported = true;
  static shown = [];
  static isSupported() { return FakeNotification.supported; }
  constructor(options) { super(); this.options = options; }
  show() { FakeNotification.shown.push(this); }
}

function setup({ prefsFile, platform = 'linux', shortcut = fakeGlobalShortcut(), trustedResult, accessibility = true } = {}) {
  const ipcMain = fakeIpcMain();
  const app = new EventEmitter();
  app.getVersion = () => '2.0.0';
  const win = fakeWindow();
  const fs = fakeFs(prefsFile ? { '/user/desktop-prefs.json': prefsFile } : {});
  const blocker = { started: new Set(), next: 1, starts: [], isStarted: id => blocker.started.has(id) };
  blocker.start = type => { const id = blocker.next++; blocker.started.add(id); blocker.starts.push(type); return id; };
  blocker.stop = id => blocker.started.delete(id);
  const menu = { specs: [], songOpen: [], resets: 0, setSpec(spec) { this.specs.push(spec); return true; }, setSongOpen(on) { this.songOpen.push(on); }, reset() { this.resets++; } };
  const updates = { playing: [], shows: 0, getState: () => ({ status: 'current', version: '2.0.0', percent: 0, message: '' }),
    show: async () => { updates.shows++; }, setPlaying(on) { this.playing.push(on); } };
  const companion = {
    restarts: 0,
    info: () => ({ port: 5000, token: 'a'.repeat(64) }),
    state: () => ({ phase: 'ready' }),
    restart: async () => { companion.restarts++; return { port: 5001, token: 'b'.repeat(64), extra: 'dropped' }; },
  };
  const nativeTheme = { themeSource: 'system' };
  const prompts = [];
  const systemPreferences = { isTrustedAccessibilityClient: prompt => { prompts.push(prompt); return accessibility; } };
  const trusted = trustedResult === undefined ? createTrust({ getWindow: () => win, uiOrigin: UI }) : () => trustedResult;
  FakeNotification.shown = [];
  FakeNotification.supported = true;
  const handlers = createHandlers({
    app, ipcMain, powerSaveBlocker: blocker, globalShortcut: shortcut, Notification: FakeNotification, systemPreferences,
    getWindow: () => win, trusted, updateController: updates, companion, nativeTheme,
    mediaProxy: { register: url => `${UI}/media/ticket-for-${url.length}` }, menu,
    prefs: createDesktopPrefs({ file: '/user/desktop-prefs.json', fs }), themeFile: '/user/appearance.json', fs, platform,
  });
  const event = { senderFrame: win.mainFrame };
  return { ipcMain, app, win, fs, blocker, menu, updates, companion, nativeTheme, shortcut, handlers, event, prompts };
}

// ---------- trust ----------

test('trusted(): only the window main frame on the UI origin', () => {
  const win = fakeWindow();
  const trusted = createTrust({ getWindow: () => win, uiOrigin: UI });
  assert.equal(trusted({ senderFrame: win.mainFrame }), true);
  assert.equal(trusted({ senderFrame: { url: `${UI}/` } }), false, 'a sub-frame on the same origin');
  win.mainFrame.url = 'https://evil.example/';
  assert.equal(trusted({ senderFrame: win.mainFrame }), false, 'the main frame navigated away');
  win.mainFrame.url = 'garbage';
  assert.equal(trusted({ senderFrame: win.mainFrame }), false);
  assert.equal(trusted({ senderFrame: null }), false);
  assert.equal(trusted({}), false);
  assert.equal(createTrust({ getWindow: () => null, uiOrigin: UI })({ senderFrame: win.mainFrame }), false);
});

test('every desktop:* channel is registered and checks trust', async () => {
  const h = setup({ trustedResult: false });
  assert.deepEqual([...h.ipcMain.handlers.keys()].sort(), [...INVOKE_CHANNELS].sort());
  for (const channel of SEND_CHANNELS) assert.equal(h.ipcMain.listenerCount(channel), 1, channel);
  for (const channel of INVOKE_CHANNELS) {
    await assert.rejects(h.ipcMain.invoke(channel, {}, true), /Untrusted window/, channel);
  }
  h.ipcMain.emit('desktop:menu', {}, [{ menu: 'file', items: [] }]);
  h.ipcMain.emit('desktop:activity', {}, { keepAwake: true, songOpen: true, playing: true });
  assert.deepEqual(h.menu.specs, []);
  assert.deepEqual(h.menu.songOpen, []);
  assert.equal(h.blocker.starts.length, 0);
  assert.deepEqual(h.updates.playing, []);
});

test('dispose removes every handler and listener', () => {
  const h = setup();
  h.handlers.dispose();
  assert.equal(h.ipcMain.handlers.size, 0);
  for (const channel of SEND_CHANNELS) assert.equal(h.ipcMain.listenerCount(channel), 0);
  assert.equal(h.app.listenerCount('will-quit'), 0);
});

// ---------- info, theme, media, update, processor ----------

test('info() returns version, platform, companion, update, processor and background shortcuts', async () => {
  const h = setup();
  assert.deepEqual(await h.ipcMain.invoke('desktop:info', h.event), {
    version: '2.0.0',
    platform: 'linux',
    companion: { port: 5000, token: 'a'.repeat(64) },
    update: { status: 'current', version: '2.0.0', percent: 0, message: '' },
    processor: { phase: 'ready' },
    backgroundShortcuts: { enabled: false, registered: [], failed: [] },
  });
});

test('setTheme validates and persists appearance.json', async () => {
  const h = setup();
  await h.ipcMain.invoke('desktop:theme', h.event, 'dark');
  assert.equal(h.nativeTheme.themeSource, 'dark');
  assert.deepEqual(JSON.parse(h.fs.files.get('/user/appearance.json')), { theme: 'dark' });
  await assert.rejects(h.ipcMain.invoke('desktop:theme', h.event, 'sepia'), /Unknown theme/);
  assert.equal(h.nativeTheme.themeSource, 'dark');
});

test('mediaUrl, update show and restart-processor delegate', async () => {
  const h = setup();
  assert.equal(await h.ipcMain.invoke('desktop:media-url', h.event, 'abc'), `${UI}/media/ticket-for-3`);
  assert.deepEqual(await h.ipcMain.invoke('desktop:update', h.event, 'show'), h.updates.getState());
  assert.equal(h.updates.shows, 1);
  await assert.rejects(h.ipcMain.invoke('desktop:update', h.event, 'install'), /Unknown update action/);
  assert.deepEqual(await h.ipcMain.invoke('desktop:restart-processor', h.event), { port: 5001, token: 'b'.repeat(64) });
  assert.equal(h.companion.restarts, 1);
});

// ---------- menu and activity ----------

test('desktop:menu forwards the spec to the menu controller', () => {
  const h = setup();
  const spec = [{ menu: 'transport', items: [] }];
  h.ipcMain.emit('desktop:menu', h.event, spec);
  assert.deepEqual(h.menu.specs, [spec]);
});

test('desktop:activity drives the wake blocker, Close Song and update deferral', () => {
  const h = setup();
  h.ipcMain.emit('desktop:activity', h.event, { playing: true, songOpen: true, keepAwake: true });
  assert.deepEqual(h.blocker.starts, ['prevent-display-sleep']);
  assert.equal(h.handlers.keepAwake, true);
  assert.deepEqual(h.menu.songOpen, [true]);
  assert.deepEqual(h.updates.playing, [true]);
  h.ipcMain.emit('desktop:activity', h.event, { keepAwake: true });
  assert.equal(h.blocker.starts.length, 1, 'one blocker at a time');
  h.ipcMain.emit('desktop:activity', h.event, { playing: false, songOpen: false, keepAwake: false });
  assert.equal(h.blocker.started.size, 0);
  assert.equal(h.handlers.keepAwake, false);
  assert.deepEqual(h.menu.songOpen, [true, false]);
  assert.deepEqual(h.updates.playing, [true, false]);
  h.ipcMain.emit('desktop:activity', h.event, { playing: 'yes' });
  h.ipcMain.emit('desktop:activity', h.event, null);
  assert.deepEqual(h.updates.playing, [true, false], 'invalid payloads are ignored');
});

test('resetActivity forgets the page: blocker released, fallback menu, not playing', () => {
  const h = setup();
  h.ipcMain.emit('desktop:activity', h.event, { playing: true, songOpen: true, keepAwake: true });
  h.handlers.resetActivity();
  assert.equal(h.blocker.started.size, 0);
  assert.equal(h.menu.resets, 1, 'the menu goes back to the fallback (no stale registry items, no song)');
  assert.equal(h.updates.playing.at(-1), false);
});

test('validateActivity keeps only boolean keys', () => {
  assert.deepEqual(validateActivity({ playing: true, extra: 1 }), { playing: true });
  assert.deepEqual(validateActivity({}), {});
  assert.equal(validateActivity({ songOpen: 1 }), null);
  assert.equal(validateActivity([]), null);
  assert.equal(validateActivity('x'), null);
});

// ---------- notifications ----------

test('notification validation: title ≤ 120, body ≤ 240, route allow-list', () => {
  assert.deepEqual(validateNotification({ title: 'Woodshed', body: 'Song is ready to practise', route: '/s/abc_123' }),
    { title: 'Woodshed', body: 'Song is ready to practise', route: '/s/abc_123' });
  assert.deepEqual(validateNotification({ title: 'Woodshed' }), { title: 'Woodshed', body: '', route: '/' });
  for (const route of ['/', '/s/a', '/edit/abc/map', '/set/x-y', `/s/${'a'.repeat(64)}`]) {
    assert.equal(validateNotification({ title: 't', route }).route, route);
  }
  for (const route of ['', 's/abc', '//evil.example', '/settings', '/s/', `/s/${'a'.repeat(65)}`, '/s/a.b', 'https://evil.example/s/a',
    '/s/abc/\nx', '/s/abc\\..', 'javascript:alert(1)', 42]) {
    assert.throws(() => validateNotification({ title: 't', route }), /route/, String(route));
  }
  assert.doesNotThrow(() => validateNotification({ title: 'x'.repeat(120), body: 'y'.repeat(240) }));
  assert.throws(() => validateNotification({ title: 'x'.repeat(121) }), /title/);
  assert.throws(() => validateNotification({ title: '  ' }), /title/);
  assert.throws(() => validateNotification({ title: 't', body: 'y'.repeat(241) }), /body/);
  assert.throws(() => validateNotification({ title: 't', body: 5 }), /body/);
  assert.throws(() => validateNotification(null), /notification/);
});

test('a notification shows only while the window is unfocused; a click focuses and navigates', async () => {
  const h = setup();
  const payload = { title: 'Woodshed', body: 'Glasshouse is ready to practise', route: '/s/song1' };
  assert.equal(await h.ipcMain.invoke('desktop:notify', h.event, payload), false, 'focused: main decides, nothing shown');
  assert.equal(FakeNotification.shown.length, 0);
  h.win.focused = false;
  h.win.minimized = true;
  assert.equal(await h.ipcMain.invoke('desktop:notify', h.event, payload), true);
  const [note] = FakeNotification.shown;
  assert.deepEqual(note.options, { title: 'Woodshed', body: 'Glasshouse is ready to practise' });
  note.emit('click');
  assert.deepEqual(h.win.calls, ['restore', 'show', 'focus']);
  assert.deepEqual(h.win.sent.at(-1), ['desktop:navigate', '/s/song1']);
  await assert.rejects(h.ipcMain.invoke('desktop:notify', h.event, { title: 't', route: '/admin' }), /route/);
  FakeNotification.supported = false;
  assert.equal(await h.ipcMain.invoke('desktop:notify', h.event, payload), false, 'no libnotify: skipped silently');
});

// ---------- background shortcuts ----------

test('enabling background shortcuts registers every combo and media key; each sends a global command', async () => {
  const h = setup();
  const result = await h.ipcMain.invoke('desktop:global-shortcuts', h.event, true);
  assert.deepEqual(result, { registered: GLOBAL_SHORTCUTS.map(s => s.accelerator), failed: [] });
  assert.deepEqual(GLOBAL_SHORTCUTS.map(s => [s.accelerator, s.id]), [
    ['Control+Alt+Space', 'transport.playStop'],
    ['Control+Alt+Return', 'transport.again'],
    ['Control+Alt+L', 'transport.loopToggle'],
    ['MediaPlayPause', 'transport.playStop'],
    ['MediaNextTrack', 'nav.nextSection'],
    ['MediaPreviousTrack', 'transport.again'],
    ['MediaStop', 'transport.stop'],
  ]);
  h.shortcut.registered.get('Control+Alt+L')();
  h.shortcut.registered.get('MediaNextTrack')();
  assert.deepEqual(h.win.sent, [
    ['desktop:command', { id: 'transport.loopToggle', source: 'global' }],
    ['desktop:command', { id: 'nav.nextSection', source: 'global' }],
  ]);
  assert.deepEqual(h.win.calls, [], 'global commands never focus the window');
  assert.deepEqual(JSON.parse(h.fs.files.get('/user/desktop-prefs.json')), { backgroundShortcuts: true });
  assert.equal((await h.ipcMain.invoke('desktop:info', h.event)).backgroundShortcuts.enabled, true);
});

test('failures are reported per accelerator, never silently replaced', async () => {
  const h = setup({ shortcut: fakeGlobalShortcut({ taken: ['Control+Alt+Space'], throws: ['MediaStop'] }) });
  const result = await h.ipcMain.invoke('desktop:global-shortcuts', h.event, true);
  assert.deepEqual(result.failed, ['Control+Alt+Space', 'MediaStop']);
  assert.equal(result.registered.length, GLOBAL_SHORTCUTS.length - 2);
  assert.ok(!h.shortcut.registered.has('Control+Alt+Space'));
});

test('disabling and will-quit unregister everything; the setting persists', async () => {
  const h = setup();
  await h.ipcMain.invoke('desktop:global-shortcuts', h.event, true);
  const before = h.shortcut.unregisterAllCalls;
  assert.deepEqual(await h.ipcMain.invoke('desktop:global-shortcuts', h.event, false), { registered: [], failed: [] });
  assert.equal(h.shortcut.unregisterAllCalls, before + 1);
  assert.equal(h.shortcut.registered.size, 0);
  assert.deepEqual(JSON.parse(h.fs.files.get('/user/desktop-prefs.json')), { backgroundShortcuts: false });
  await h.ipcMain.invoke('desktop:global-shortcuts', h.event, true);
  h.app.emit('will-quit');
  assert.equal(h.shortcut.registered.size, 0);
  await assert.rejects(h.ipcMain.invoke('desktop:global-shortcuts', h.event, 'on'), /true or false/);
});

test('the persisted setting registers at startup', () => {
  const shortcut = fakeGlobalShortcut();
  setup({ prefsFile: JSON.stringify({ backgroundShortcuts: true }), shortcut });
  assert.equal(shortcut.registered.size, GLOBAL_SHORTCUTS.length);
  const off = fakeGlobalShortcut();
  setup({ prefsFile: '{broken', shortcut: off });
  assert.equal(off.registered.size, 0);
});

test('macOS reports Accessibility trust and prompts only when asked', async () => {
  const needed = setup({ platform: 'darwin', accessibility: false });
  assert.equal((await needed.ipcMain.invoke('desktop:global-shortcuts', needed.event, true)).accessibility, 'needed');
  await needed.ipcMain.invoke('desktop:global-shortcuts', needed.event, true, { promptAccessibility: true });
  assert.deepEqual(needed.prompts, [false, true]);
  const granted = setup({ platform: 'darwin', accessibility: true });
  assert.equal((await granted.ipcMain.invoke('desktop:global-shortcuts', granted.event, true)).accessibility, 'granted');
  const linux = setup({ platform: 'linux' });
  assert.equal('accessibility' in await linux.ipcMain.invoke('desktop:global-shortcuts', linux.event, true), false);
});

test('createGlobalShortcuts.state tracks the last result', () => {
  const shortcuts = createGlobalShortcuts({ globalShortcut: fakeGlobalShortcut({ taken: ['MediaStop'] }), platform: 'win32', send: () => {} });
  shortcuts.apply(true);
  assert.equal(shortcuts.state().enabled, true);
  assert.deepEqual(shortcuts.state().failed, ['MediaStop']);
  shortcuts.apply(false);
  assert.deepEqual(shortcuts.state(), { enabled: false, registered: [], failed: [] });
});

test('desktop prefs default to off and survive a write failure in memory', () => {
  const fs = fakeFs();
  const prefs = createDesktopPrefs({ file: '/user/desktop-prefs.json', fs });
  assert.deepEqual(prefs.get(), { backgroundShortcuts: false });
  fs.writeFileSync = () => { throw new Error('EROFS'); };
  assert.deepEqual(prefs.set({ backgroundShortcuts: true }), { backgroundShortcuts: true });
  assert.equal(prefs.get().backgroundShortcuts, true);
});

// ---------- companion host ----------

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout: id => pending.delete(id),
    fire: ms => { for (const [id, entry] of [...pending]) if (entry.ms === ms) { pending.delete(id); entry.fn(); } },
  };
}

function fakeFork({ exitOnShutdown = true } = {}) {
  const children = [];
  const fork = (entry, args, options) => {
    const child = new EventEmitter();
    child.entry = entry;
    child.options = options;
    child.messages = [];
    child.killed = false;
    child.stderr = new EventEmitter();
    child.postMessage = message => {
      child.messages.push(message);
      if (message.type === 'shutdown' && exitOnShutdown) queueMicrotask(() => child.emit('exit', 0));
    };
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', null)); };
    children.push(child);
    return child;
  };
  return { fork, children };
}

function host(options = {}) {
  const forked = fakeFork(options);
  const timers = fakeTimers();
  const states = [];
  const logs = [];
  const companion = createCompanionHost({
    fork: forked.fork, entry: '/res/companion/server.mjs', env: { A: '1' }, origin: UI, timers,
    onState: state => states.push(state), log: message => logs.push(message), fetch: options.fetch,
  });
  return { companion, ...forked, timers, states, logs };
}

test('processor state: starting → ready with the companion {port, token}', async () => {
  const h = host();
  const started = h.companion.start();
  assert.deepEqual(h.states, [{ phase: 'starting' }]);
  assert.equal(h.children[0].entry, '/res/companion/server.mjs');
  assert.deepEqual(h.children[0].options, { env: { A: '1' }, stdio: 'pipe' });
  h.children[0].emit('message', { port: 5123, token: 't'.repeat(64) });
  assert.deepEqual(await started, { port: 5123, token: 't'.repeat(64) });
  assert.deepEqual(h.states.at(-1), { phase: 'ready' });
  assert.deepEqual(h.companion.state(), { phase: 'ready' });
  assert.deepEqual(h.companion.info(), { port: 5123, token: 't'.repeat(64) });
  assert.equal(h.companion.isRunning(), true);
  h.children[0].stderr.emit('data', Buffer.from('warn'));
  assert.deepEqual(h.logs, ['warn']);
});

test('an unexpected exit is phase stopped with the exit code, on the processor channel only', async () => {
  const h = host();
  const started = h.companion.start();
  h.children[0].emit('message', { port: 5123, token: 'x' });
  await started;
  h.children[0].emit('exit', 3);
  assert.deepEqual(h.companion.state(), { phase: 'stopped', exitCode: 3, message: PROCESSOR_MESSAGES.stopped });
  assert.equal(h.companion.info(), null);
  assert.equal(h.companion.isRunning(), false);
});

test('a start that times out (20 s) or exits early is phase stopped with a message', async () => {
  const h = host();
  const started = h.companion.start();
  assert.ok([...h.timers.pending.values()].some(entry => entry.ms === 20000));
  h.timers.fire(20000);
  await assert.rejects(started, /did not start/);
  assert.equal(h.children[0].killed, true);
  assert.deepEqual(h.companion.state(), { phase: 'stopped', message: PROCESSOR_MESSAGES.startFailed });
  const early = host();
  const failing = early.companion.start();
  early.children[0].emit('exit', 1);
  await assert.rejects(failing, /did not start/);
  assert.deepEqual(early.companion.state(), { phase: 'stopped', exitCode: 1, message: PROCESSOR_MESSAGES.startFailed });
});

test('stop asks for shutdown without cancelling the job (D12) and kills after 2.5 s', async () => {
  const h = host();
  const started = h.companion.start();
  h.children[0].emit('message', { port: 1, token: 'x' });
  await started;
  await h.companion.stop();
  assert.deepEqual(h.children[0].messages, [{ type: 'shutdown' }]);
  assert.equal(h.children[0].messages[0].forUpdate, undefined);
  assert.deepEqual(h.companion.state(), { phase: 'stopped' });
  const stuck = host({ exitOnShutdown: false });
  const s = stuck.companion.start();
  stuck.children[0].emit('message', { port: 1, token: 'x' });
  await s;
  const stopping = stuck.companion.stop();
  assert.ok([...stuck.timers.pending.values()].some(entry => entry.ms === 2500));
  stuck.timers.fire(2500);
  await stopping;
  assert.equal(stuck.children[0].killed, true);
});

test('restart: restarting → starting → ready, returning the new {port, token}', async () => {
  const h = host();
  const first = h.companion.start();
  h.children[0].emit('message', { port: 1, token: 'old' });
  await first;
  const restarted = h.companion.restart();
  assert.strictEqual(h.companion.restart(), restarted, 'concurrent restarts share one');
  assert.deepEqual(h.states.at(-1), { phase: 'restarting' });
  await tick();
  assert.equal(h.children.length, 2);
  h.children[1].emit('message', { port: 2, token: 'old' });
  assert.deepEqual(await restarted, { port: 2, token: 'old' });
  assert.deepEqual(h.states.map(s => s.phase), ['starting', 'ready', 'restarting', 'starting', 'ready']);
});

test('stop during a pending start cancels it: a late {port, token} is not kept and no ready is reported', async () => {
  const h = host({ exitOnShutdown: false });
  const started = h.companion.start();
  const stopped = h.companion.stop();
  h.children[0].emit('message', { port: 1234, token: 't' });
  await assert.rejects(started, /stopped while starting/);
  h.children[0].emit('exit', 0);
  await stopped;
  assert.equal(h.companion.info(), null);
  assert.equal(h.companion.isRunning(), false);
  assert.deepEqual(h.states.map(s => s.phase), ['starting', 'stopped']);
  assert.deepEqual(h.companion.state(), { phase: 'stopped' });
  assert.equal(h.timers.pending.size, 0, 'start timer cleared');
  // An exit before any message is a cancel too, not a start failure.
  const early = host();
  const pending = early.companion.start();
  const stopping = early.companion.stop();
  await assert.rejects(pending, /stopped while starting/);
  await stopping;
  assert.deepEqual(early.states.map(s => s.phase), ['starting', 'stopped']);
  assert.deepEqual(early.companion.state(), { phase: 'stopped' });
});

test('restart during a pending start reports restarting, never a spurious stopped', async () => {
  const h = host();
  const first = h.companion.start();
  const restarted = h.companion.restart();
  h.children[0].emit('message', { port: 1, token: 'old' });
  await first;
  await tick();
  await tick();
  assert.equal(h.children.length, 2);
  h.children[1].emit('message', { port: 2, token: 'new' });
  assert.deepEqual(await restarted, { port: 2, token: 'new' });
  const phases = h.states.map(s => s.phase);
  assert.ok(!phases.includes('stopped'), phases.join(' > '));
  assert.deepEqual(phases, ['starting', 'restarting', 'ready', 'restarting', 'starting', 'ready']);
  assert.deepEqual(h.companion.info(), { port: 2, token: 'new' });
});

test('restart from a stopped processor starts it again', async () => {
  const h = host();
  const started = h.companion.start();
  h.children[0].emit('exit', 1);
  await assert.rejects(started);
  const restarted = h.companion.restart();
  await tick();
  h.children[1].emit('message', { port: 9, token: 'x' });
  assert.deepEqual(await restarted, { port: 9, token: 'x' });
});

test('quiesce reports busy, or busy after a 3 s timeout; resume posts resume', async () => {
  const h = host();
  assert.deepEqual(await h.companion.quiesce(), { busy: false }, 'no companion: not busy');
  const started = h.companion.start();
  h.children[0].emit('message', { port: 1, token: 'x' });
  await started;
  const quiet = h.companion.quiesce();
  h.children[0].emit('message', { type: 'quiesced', busy: true });
  assert.deepEqual(await quiet, { busy: true });
  const silent = h.companion.quiesce();
  h.timers.fire(3000);
  assert.deepEqual(await silent, { busy: true });
  h.companion.resume();
  assert.deepEqual(h.children[0].messages.map(m => m.type), ['quiesce', 'quiesce', 'resume']);
});

test('status fetches /status with the companion token and the UI origin', async () => {
  const calls = [];
  const h = host({ fetch: async (url, init) => { calls.push([url, init.headers]); return { ok: true, json: async () => ({ busy: true }) }; } });
  assert.deepEqual(await h.companion.status(), { busy: false }, 'no companion yet');
  const started = h.companion.start();
  h.children[0].emit('message', { port: 4321, token: 'tok' });
  await started;
  assert.deepEqual(await h.companion.status(), { busy: true });
  assert.deepEqual(calls, [['http://127.0.0.1:4321/status', { Origin: UI, Authorization: 'Bearer tok' }]]);
});

// ---------- fork env ----------

test('the fork env adds app version, platform and device name', () => {
  const env = companionEnv({
    baseEnv: { PATH: '/usr/bin', HOME: '/home/u' }, uiOrigin: UI, userData: '/user', resources: '/res',
    appVersion: '2.0.0', platform: 'darwin', arch: 'arm64', name: "Kyle's MacBook",
  });
  assert.equal(env.WOODSHED_APP_VERSION, '2.0.0');
  assert.equal(env.WOODSHED_PLATFORM, 'darwin-arm64');
  assert.equal(env.WOODSHED_DEVICE_NAME, "Kyle's MacBook");
  assert.equal(env.WOODSHED_WEB_URL, UI);
  assert.equal(env.WOODSHED_COMPANION_PORT, '0');
  assert.equal(env.WOODSHED_DATA_DIR, path.join('/user', 'library'));
  assert.equal(env.WOODSHED_PROCESSOR, path.join('/res', 'processor', 'woodshed-processor', 'woodshed-processor'));
  assert.equal(env.TORCH_HOME, path.join('/user', 'models'));
  assert.equal(env.PATH, path.join('/res', 'bin') + path.delimiter + '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  const win = companionEnv({ baseEnv: {}, uiOrigin: UI, userData: '/u', resources: '/r', appVersion: '2.0.0', platform: 'win32', arch: 'x64', name: 'PC' });
  assert.match(win.WOODSHED_PROCESSOR, /woodshed-processor\.exe$/);
  assert.equal(win.WOODSHED_PLATFORM, 'win32-x64');
});

test('device name: macOS ComputerName, else the hostname without .local', () => {
  const calls = [];
  assert.equal(deviceName({ platform: 'darwin', execFile: (cmd, args) => { calls.push([cmd, ...args]); return "Kyle's Studio Mac\n"; }, hostname: () => 'x.local' }), "Kyle's Studio Mac");
  assert.deepEqual(calls, [['scutil', '--get', 'ComputerName']]);
  assert.equal(deviceName({ platform: 'darwin', execFile: () => { throw new Error('no scutil'); }, hostname: () => 'studio.local' }), 'studio');
  assert.equal(deviceName({ platform: 'linux', execFile: () => assert.fail('not on linux'), hostname: () => 'box.LOCAL' }), 'box');
  assert.equal(deviceName({ platform: 'win32', hostname: () => 'DESKTOP-1' }), 'DESKTOP-1');
  assert.equal(deviceName({ platform: 'linux', hostname: () => '' }), 'This computer');
});
