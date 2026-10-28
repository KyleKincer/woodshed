const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { INVOKE_CHANNELS, SEND_CHANNELS } = require('./ipc-handlers.cjs');

const MAIN = path.join(__dirname, 'main.cjs');
const source = fs.readFileSync(MAIN, 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('main.cjs requires the factored modules and defines no IPC handler itself', () => {
  for (const module of ['./ipc-handlers.cjs', './menu.cjs', './window-state.cjs', './permissions.cjs', './flush.cjs', './static-server.cjs', './update-controller.cjs']) {
    assert.ok(source.includes(`require('${module}')`), module);
  }
  for (const banned of ['ipcMain.handle(', 'ipcMain.on(', 'ipcMain.once(', 'setPermissionRequestHandler', 'buildFromTemplate', 'globalShortcut.register',
    'http.createServer', 'forUpdate', "'desktop:update-state',{", 'emit(\'error\'']) {
    assert.ok(!source.includes(banned), `main.cjs must not contain ${banned}`);
  }
});

// ---------- wiring, with a fake Electron ----------

const log = [];
let electron, updater, userData, restore = [];

function fakeModule(id, exports) {
  const resolved = require.resolve(id, { paths: [__dirname] });
  const saved = require.cache[resolved];
  const mod = new Module(resolved);
  mod.filename = resolved;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[resolved] = mod;
  restore.push(() => { if (saved) require.cache[resolved] = saved; else delete require.cache[resolved]; });
}

function makeElectron() {
  const ipcMain = new EventEmitter();
  ipcMain.handlers = new Map();
  ipcMain.handle = (channel, fn) => ipcMain.handlers.set(channel, fn);
  ipcMain.removeHandler = channel => ipcMain.handlers.delete(channel);
  const app = new EventEmitter();
  let ready;
  const readyPromise = new Promise(resolve => { ready = resolve; });
  Object.assign(app, {
    isPackaged: false,
    name: 'Woodshed',
    getPath: name => (name === 'userData' ? userData : os.tmpdir()),
    setPath: () => {},
    getVersion: () => '2.0.0',
    requestSingleInstanceLock: () => true,
    whenReady: () => readyPromise,
    ready: () => ready(),
    setAppUserModelId: id => log.push(['appUserModelId', id]),
    quit: () => log.push(['quit']),
    exit: code => log.push(['exit', code]),
  });
  class BrowserWindow extends EventEmitter {
    static instances = [];
    constructor(options) {
      super();
      log.push(['window', options]);
      this.options = options;
      this.destroyed = false;
      const mainFrame = { url: 'http://127.0.0.1:47832/' };
      const webContents = new EventEmitter();
      Object.assign(webContents, {
        mainFrame,
        sent: [],
        ipc: new EventEmitter(),
        isDestroyed: () => false,
        session: {
          setPermissionRequestHandler: fn => { webContents.session.request = fn; },
          setPermissionCheckHandler: fn => { webContents.session.check = fn; },
        },
        setWindowOpenHandler: fn => { webContents.openHandler = fn; },
        send: (channel, payload) => {
          webContents.sent.push([channel, payload]);
          if (channel === 'desktop:flush') queueMicrotask(() => webContents.ipc.emit('desktop:flushed', { senderFrame: mainFrame }, { id: payload.id }));
        },
      });
      this.webContents = webContents;
      BrowserWindow.instances.push(this);
    }
    loadURL(url) { log.push(['loadURL', url]); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isFocused() { return true; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    getNormalBounds() { return { x: 0, y: 0, width: 1280, height: 850 }; }
    show() {}
    focus() {}
    close() { log.push(['close']); }
    setBackgroundColor() {}
  }
  const children = [];
  return {
    app,
    BrowserWindow,
    ipcMain,
    shell: { openExternal: () => Promise.resolve(), openPath: file => { log.push(['openPath', file]); return Promise.resolve(''); } },
    utilityProcess: {
      children,
      fork: (entry, args, options) => {
        const child = new EventEmitter();
        child.entry = entry;
        child.options = options;
        child.messages = [];
        child.postMessage = message => {
          child.messages.push(message);
          if (message.type === 'shutdown') queueMicrotask(() => child.emit('exit', 0));
        };
        child.kill = () => child.emit('exit', null);
        children.push(child);
        log.push(['fork']);
        // The processor answers later than the window opens (it never blocks startup).
        setImmediate(() => child.emit('message', { port: 47999, token: 'f'.repeat(64) }));
        return child;
      },
    },
    dialog: { showMessageBox: async () => ({ response: 0 }), showErrorBox: (title, message) => log.push(['fatal', title, message]) },
    Menu: { buildFromTemplate: template => ({ template }), setApplicationMenu: menu => log.push(['menu', menu.template]) },
    powerMonitor: new EventEmitter(),
    powerSaveBlocker: { start: () => 1, stop: () => {}, isStarted: () => false },
    globalShortcut: { register: () => true, unregisterAll: () => {} },
    Notification: class { static isSupported() { return true; } on() {} show() {} },
    systemPreferences: { isTrustedAccessibilityClient: () => true },
    nativeTheme: Object.assign(new EventEmitter(), { themeSource: 'system', shouldUseDarkColors: true }),
    screen: {
      getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
      getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getDisplayMatching: () => ({ id: 1 }),
    },
  };
}

before(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-main-'));
  electron = makeElectron();
  updater = Object.assign(new EventEmitter(), { checkForUpdates: async () => {}, downloadUpdate: async () => {}, quitAndInstall: () => log.push(['quitAndInstall']) });
  fakeModule('electron', electron);
  fakeModule('electron-updater', { autoUpdater: updater });
  const createServer = http.createServer;
  http.createServer = handler => {
    const server = new EventEmitter();
    server.handler = handler;
    server.listen = (port, host, cb) => { log.push(['listen', port, host]); cb(); };
    server.close = () => log.push(['server-close']);
    return server;
  };
  restore.push(() => { http.createServer = createServer; });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ busy: false }) });
  restore.push(() => { globalThis.fetch = realFetch; });
  delete require.cache[MAIN];
  require(MAIN);
  electron.app.ready();
  for (let i = 0; i < 20 && !log.some(entry => entry[0] === 'loadURL'); i++) await tick();
});

after(() => {
  for (const undo of restore.reverse()) undo();
  delete require.cache[MAIN];
  fs.rmSync(userData, { recursive: true, force: true });
});

test('startup order: app user model id, fallback menu, UI server, companion fork, window, handlers, load', () => {
  const kinds = log.map(entry => entry[0]);
  assert.deepEqual(log.find(entry => entry[0] === 'appUserModelId'), ['appUserModelId', 'com.kylekincer.woodshed']);
  const at = kind => kinds.indexOf(kind);
  assert.ok(at('appUserModelId') < at('menu') && at('menu') < at('listen') && at('listen') < at('fork') && at('fork') < at('window') && at('window') < at('loadURL'));
  assert.deepEqual(log.find(entry => entry[0] === 'listen'), ['listen', 47832, '127.0.0.1']);
  assert.deepEqual(log.find(entry => entry[0] === 'loadURL'), ['loadURL', 'http://127.0.0.1:47832']);
  const fallback = log.find(entry => entry[0] === 'menu')[1];
  assert.ok(fallback.some(menu => menu.label === 'Edit'));
});

test('the window does not wait for the processor: it opens during starting and gets ready live', async () => {
  const [win] = electron.BrowserWindow.instances;
  const states = () => win.webContents.sent.filter(([channel]) => channel === 'desktop:processor-state').map(([, state]) => state.phase);
  for (let i = 0; i < 20 && !states().includes('ready'); i++) await tick();
  assert.deepEqual(states(), ['ready'], 'the ready phase reaches the already-open window');
  const info = await electron.ipcMain.handlers.get('desktop:info')({ senderFrame: win.webContents.mainFrame, sender: win.webContents });
  assert.deepEqual(info.processor, { phase: 'ready' });
  assert.equal(info.companion.port, 47999);
});

test('the companion forks with the 2.0 env and reaches phase ready', () => {
  const [child] = electron.utilityProcess.children;
  assert.match(child.entry, /companion[\\/]server\.mjs$/);
  const { env } = child.options;
  assert.equal(env.WOODSHED_APP_VERSION, '2.0.0');
  assert.equal(env.WOODSHED_PLATFORM, `${process.platform}-${process.arch}`);
  assert.equal(typeof env.WOODSHED_DEVICE_NAME, 'string');
  assert.ok(env.WOODSHED_DEVICE_NAME.length > 0);
  assert.equal(env.WOODSHED_WEB_URL, 'http://127.0.0.1:47832');
});

test('the window is sandboxed, sized from window state, and its session is locked down', () => {
  const [win] = electron.BrowserWindow.instances;
  const { options } = win;
  assert.equal(options.show, false);
  assert.equal(options.minWidth, 640);
  assert.equal(options.minHeight, 480);
  assert.equal(options.width, 1280);
  assert.equal(options.height, 850);
  assert.deepEqual(
    { contextIsolation: options.webPreferences.contextIsolation, nodeIntegration: options.webPreferences.nodeIntegration, sandbox: options.webPreferences.sandbox },
    { contextIsolation: true, nodeIntegration: false, sandbox: true },
  );
  assert.match(options.webPreferences.preload, /preload\.cjs$/);
  let granted;
  win.webContents.session.request(win.webContents, 'notifications', value => { granted = value; }, { requestingUrl: 'http://127.0.0.1:47832/' });
  assert.equal(granted, false);
  win.webContents.session.request(win.webContents, 'midi', value => { granted = value; }, { requestingUrl: 'http://127.0.0.1:47832/' });
  assert.equal(granted, true);
  assert.deepEqual(win.webContents.openHandler({ url: 'https://example.com' }), { action: 'deny' });
});

test('every desktop:* handler is registered through ipc-handlers', async () => {
  assert.deepEqual([...electron.ipcMain.handlers.keys()].sort(), [...INVOKE_CHANNELS].sort());
  for (const channel of SEND_CHANNELS) assert.equal(electron.ipcMain.listenerCount(channel), 1, channel);
  const [win] = electron.BrowserWindow.instances;
  const info = await electron.ipcMain.handlers.get('desktop:info')({ senderFrame: win.webContents.mainFrame });
  assert.deepEqual(info.processor, { phase: 'ready' });
  assert.deepEqual(info.companion, { port: 47999, token: 'f'.repeat(64) });
  assert.equal(info.version, '2.0.0');
  await assert.rejects(async () => electron.ipcMain.handlers.get('desktop:info')({ senderFrame: { url: 'https://evil.example/' } }), /Untrusted/);
});

test('menu commands reach the renderer as desktop:command {id, source: menu}', () => {
  const [win] = electron.BrowserWindow.instances;
  electron.ipcMain.emit('desktop:menu', { senderFrame: win.webContents.mainFrame }, [{ menu: 'transport', items: [{ id: 'transport.playStop', label: 'Play/Stop' }] }]);
  const template = log.filter(entry => entry[0] === 'menu').at(-1)[1];
  const transport = template.find(menu => menu.label === 'Transport');
  transport.submenu[0].click();
  assert.deepEqual(win.webContents.sent.at(-1), ['desktop:command', { id: 'transport.playStop', source: 'menu' }]);
  const help = template.find(menu => menu.label === 'Help');
  help.submenu.find(item => item.label === 'Licenses').click();
  assert.match(log.at(-1)[1], /THIRD-PARTY-NOTICES\.txt$/);
});

test('closing the window flushes the renderer before quitting; before-quit stops the companion without cancelling', async () => {
  const [win] = electron.BrowserWindow.instances;
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  win.emit('close', event);
  assert.equal(event.prevented, true);
  for (let i = 0; i < 10 && !log.some(entry => entry[0] === 'quit'); i++) await tick();
  const flushIndex = win.webContents.sent.findIndex(([channel]) => channel === 'desktop:flush');
  assert.ok(flushIndex >= 0, 'desktop:flush was sent');
  assert.ok(log.some(entry => entry[0] === 'quit'));
  const quitEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  electron.app.emit('before-quit', quitEvent);
  assert.equal(quitEvent.prevented, true, 'waits for the companion');
  const [child] = electron.utilityProcess.children;
  assert.deepEqual(child.messages.at(-1), { type: 'shutdown' });
  assert.ok(log.some(entry => entry[0] === 'server-close'));
});

// ---------- --smoke-test appearance step against the real theme-init.js (I0A-4) ----------

const vm = require('node:vm');

function smokeSource() {
  const start = source.indexOf('async function runSmokeTest()');
  assert.ok(start >= 0, 'runSmokeTest exists');
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end);
}

function smokeAppearanceScript() {
  const match = smokeSource().match(/const appearance = await window\.webContents\.executeJavaScript\(`([\s\S]*?)`\);/);
  assert.ok(match, 'the smoke appearance script is found');
  assert.ok(!match[1].includes('${'), 'the appearance script interpolates nothing');
  return match[1];
}

/** A minimal page that runs public/theme-init.js the way <head> does. */
function themePage({ systemDark = false } = {}) {
  const root = { dataset: {}, style: {} };
  const meta = { content: '', setAttribute(name, value) { if (name === 'content') this.content = value; } };
  const storage = new Map();
  const writes = [];
  const context = {
    document: {
      documentElement: root,
      body: {},
      querySelector: selector => (selector === 'meta[name="theme-color"]' ? meta : null),
      addEventListener: () => {},
    },
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { writes.push(key); storage.set(key, String(value)); },
      removeItem: key => { writes.push(key); storage.delete(key); },
    },
    location: { pathname: '/' },
    matchMedia: () => ({ matches: systemDark, addEventListener: () => {} }),
    dispatchEvent: () => true,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    // The body inherits color-scheme from the root.
    getComputedStyle: () => ({ colorScheme: root.style.colorScheme }),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'theme-init.js'), 'utf8'), context);
  const themes = [];
  context.window.woodshedDesktop = { setTheme: async theme => { themes.push(theme); } };
  return { context, root, themes, writes };
}

test('the smoke appearance step never calls woodshedAppearance.set (theme-init.js has no set)', () => {
  assert.doesNotMatch(smokeSource(), /woodshedAppearance\.set\s*\(/);
  const script = smokeAppearanceScript();
  assert.match(script, /woodshedAppearance\.apply\(\{theme\}\)/);
  assert.match(script, /woodshedAppearance\.apply\(\{theme:'system'\}\)/);
});

test('the smoke appearance step passes against the real theme-init.js and persists nothing', async () => {
  for (const systemDark of [false, true]) {
    const page = themePage({ systemDark });
    assert.equal(typeof page.context.window.woodshedAppearance.set, 'undefined');
    const result = await vm.runInContext(smokeAppearanceScript(), page.context);
    assert.deepEqual(page.themes, ['dark', 'light', 'system']);
    assert.equal(result, systemDark ? 'dark' : 'light');
    assert.equal(page.context.window.woodshedAppearance.preference, 'system');
    assert.deepEqual(page.writes, [], 'the smoke never writes storage');
  }
});
