'use strict';
// Every desktop:* IPC handler, the companion (local processor) host, the
// background shortcuts and the per-device desktop prefs (architecture §6.11
// items 2, 4, 5, 6 and 10; maps/companion-desktop.md §16.5–16.11).
//
// Electron APIs arrive as arguments so node --test can drive all of it with
// fakes; desktop/main.cjs only wires these together.
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const INVOKE_CHANNELS = Object.freeze([
  'desktop:media-url',
  'desktop:theme',
  'desktop:info',
  'desktop:update',
  'desktop:restart-processor',
  'desktop:global-shortcuts',
  'desktop:notify',
]);
const SEND_CHANNELS = Object.freeze(['desktop:menu', 'desktop:activity']);
const THEMES = Object.freeze(['system', 'light', 'dark']);

// ---------- trust ----------

/** `trusted(event)`: the sender is the window's main frame on the UI origin. */
function createTrust({ getWindow, uiOrigin }) {
  const expected = new URL(uiOrigin).origin;
  return function trusted(event) {
    const win = getWindow();
    const frame = event?.senderFrame;
    if (!win || win.isDestroyed?.() || !frame || frame !== win.webContents.mainFrame) return false;
    try {
      return new URL(frame.url).origin === expected;
    } catch {
      return false;
    }
  };
}

// ---------- validation ----------

const NOTIFY_ROUTE = /^\/(s|edit|set)\/[A-Za-z0-9_-]{1,64}(\/.*)?$/;
const UNSAFE_ROUTE_CHARS = /[\u0000- \u007f\\]/;
const NOTIFY_LIMITS = Object.freeze({ title: 120, body: 240 });

/** desktop:notify payload → {title, body, route}; throws on anything else. */
function validateNotification(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid notification');
  const { title, body = '', route = '/' } = payload;
  if (typeof title !== 'string' || !title.trim() || title.length > NOTIFY_LIMITS.title) throw new Error('Invalid notification title');
  if (typeof body !== 'string' || body.length > NOTIFY_LIMITS.body) throw new Error('Invalid notification body');
  if (typeof route !== 'string' || route.length > 512 || UNSAFE_ROUTE_CHARS.test(route) || route.startsWith('//')
    || (route !== '/' && !NOTIFY_ROUTE.test(route))) throw new Error('Invalid notification route');
  return { title, body, route };
}

/** desktop:activity payload → only the boolean keys present, or null. */
function validateActivity(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const out = {};
  for (const key of ['playing', 'songOpen', 'keepAwake']) {
    if (payload[key] === undefined) continue;
    if (typeof payload[key] !== 'boolean') return null;
    out[key] = payload[key];
  }
  return out;
}

// ---------- desktop prefs (userData/desktop-prefs.json) ----------

const DEFAULT_DESKTOP_PREFS = Object.freeze({ backgroundShortcuts: false });

function createDesktopPrefs({ file, fs = nodeFs }) {
  let cache = null;
  function get() {
    if (cache) return cache;
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      saved = {};
    }
    cache = Object.freeze({
      backgroundShortcuts: saved.backgroundShortcuts === true,
    });
    return cache;
  }
  function set(patch) {
    const next = Object.freeze({ ...get(), ...patch });
    cache = next;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(next));
      fs.renameSync(temp, file);
    } catch {
      // Keep the in-memory value; the next launch starts from the default.
    }
    return next;
  }
  return { get, set };
}

// ---------- background shortcuts (§16.7) ----------

const GLOBAL_SHORTCUTS = Object.freeze([
  { accelerator: 'Control+Alt+Space', id: 'transport.playStop' },
  { accelerator: 'Control+Alt+Return', id: 'transport.again' },
  { accelerator: 'Control+Alt+L', id: 'transport.loopToggle' },
  { accelerator: 'MediaPlayPause', id: 'transport.playStop', media: true },
  { accelerator: 'MediaNextTrack', id: 'nav.nextSection', media: true },
  { accelerator: 'MediaPreviousTrack', id: 'transport.again', media: true },
  { accelerator: 'MediaStop', id: 'transport.stop', media: true },
]);

/**
 * @param {{globalShortcut: Electron.GlobalShortcut, systemPreferences?: Electron.SystemPreferences, platform: string, send: (id: string) => void}} deps
 */
function createGlobalShortcuts({ globalShortcut, systemPreferences, platform, send }) {
  let state = { enabled: false, registered: [], failed: [] };
  function unregisterAll() {
    try {
      globalShortcut.unregisterAll();
    } catch {
      // Nothing registered, or the app is already shutting down.
    }
  }
  /** @returns {{registered: string[], failed: string[], accessibility?: 'granted'|'needed'}} */
  function apply(enabled, { promptAccessibility = false } = {}) {
    unregisterAll();
    if (!enabled) {
      state = { enabled: false, registered: [], failed: [] };
      return { registered: [], failed: [] };
    }
    const registered = [];
    const failed = [];
    for (const { accelerator, id } of GLOBAL_SHORTCUTS) {
      let ok = false;
      try {
        ok = globalShortcut.register(accelerator, () => send(id)) === true;
      } catch {
        ok = false;
      }
      (ok ? registered : failed).push(accelerator);
    }
    const result = { registered, failed };
    // macOS delivers media keys to globalShortcut only for a trusted accessibility client.
    if (platform === 'darwin' && systemPreferences?.isTrustedAccessibilityClient) {
      result.accessibility = systemPreferences.isTrustedAccessibilityClient(promptAccessibility === true) ? 'granted' : 'needed';
    }
    state = { enabled: true, ...result };
    return result;
  }
  return { apply, unregisterAll, state: () => state };
}

// ---------- companion host (§6.11 item 2, D12) ----------

const PROCESSOR_MESSAGES = Object.freeze({
  startFailed: 'The local processor did not start.',
  stopped: 'The local processor stopped.',
});

const validInfo = info => info && Number.isInteger(info.port) && info.port > 0 && typeof info.token === 'string';

/**
 * Lifecycle of the companion utility process.
 * processorState = {phase: 'starting'|'ready'|'stopped'|'restarting', exitCode?, message?}.
 * @param {{fork: (entry: string, args: string[], options: object) => any, entry: string, env: object, origin: string,
 *   fetch?: typeof fetch, timers?: {setTimeout, clearTimeout}, startTimeoutMs?: number, stopTimeoutMs?: number,
 *   quiesceTimeoutMs?: number, onState?: (state) => void, log?: (message: string) => void}} options
 */
function createCompanionHost({
  fork,
  entry,
  env,
  origin,
  fetch: fetchImpl = globalThis.fetch,
  timers = globalThis,
  startTimeoutMs = 20000,
  stopTimeoutMs = 2500,
  quiesceTimeoutMs = 3000,
  onState = () => {},
  log = message => console.error(message),
}) {
  let child = null;
  let info = null;
  let state = Object.freeze({ phase: 'stopped' });
  let starting = null;
  let restarting = null;
  const stopping = new WeakSet();

  function setState(next) {
    state = Object.freeze(Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)));
    onState(state);
  }

  function start() {
    if (starting) return starting;
    if (child && info) return Promise.resolve(info);
    setState({ phase: 'starting' });
    starting = new Promise((resolve, reject) => {
      let proc;
      try {
        proc = fork(entry, [], { env, stdio: 'pipe' });
      } catch (error) {
        setState({ phase: 'stopped', message: PROCESSOR_MESSAGES.startFailed });
        reject(error);
        return;
      }
      child = proc;
      let settled = false;
      const fail = (exitCode) => {
        settled = true;
        stopping.add(proc); // a kill after a failed start is not a second, unexpected stop
        setState({ phase: 'stopped', exitCode, message: PROCESSOR_MESSAGES.startFailed });
        reject(new Error(PROCESSOR_MESSAGES.startFailed));
      };
      const timer = timers.setTimeout(() => {
        if (settled) return;
        fail(undefined);
        if (child === proc) child = null;
        try {
          proc.kill();
        } catch {
          // Already gone.
        }
      }, startTimeoutMs);
      proc.once('message', message => {
        if (settled) return;
        timers.clearTimeout(timer);
        if (!validInfo(message)) {
          fail(undefined);
          if (child === proc) child = null;
          try {
            proc.kill();
          } catch {
            // Already gone.
          }
          return;
        }
        settled = true;
        info = Object.freeze({ port: message.port, token: message.token });
        setState({ phase: 'ready' });
        resolve(info);
      });
      proc.on('exit', code => {
        timers.clearTimeout(timer);
        if (child === proc) {
          child = null;
          info = null;
        }
        if (!settled) {
          fail(code ?? undefined);
          return;
        }
        if (stopping.has(proc)) return;
        setState({ phase: 'stopped', exitCode: code ?? undefined, message: PROCESSOR_MESSAGES.stopped });
      });
      proc.stderr?.on('data', data => log(String(data)));
    }).finally(() => {
      starting = null;
    });
    return starting;
  }

  /** Asks the companion to shut down (its job pauses, D12); kills it after stopTimeoutMs. */
  async function stop() {
    const proc = child;
    if (!proc) return;
    stopping.add(proc);
    child = null;
    info = null;
    await new Promise(resolve => {
      const timer = timers.setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // Already gone.
        }
        resolve();
      }, stopTimeoutMs);
      proc.once('exit', () => {
        timers.clearTimeout(timer);
        resolve();
      });
      try {
        proc.postMessage({ type: 'shutdown' });
      } catch {
        try {
          proc.kill();
        } catch {
          // Already gone.
        }
      }
    });
    if (state.phase !== 'restarting') setState({ phase: 'stopped' });
  }

  /** desktop:restart-processor → the new {port, token}. */
  function restart() {
    if (restarting) return restarting;
    restarting = (async () => {
      setState({ phase: 'restarting' });
      if (starting) await starting.catch(() => {});
      await stop();
      return start();
    })().finally(() => {
      restarting = null;
    });
    return restarting;
  }

  function quiesce() {
    const proc = child;
    if (!proc) return Promise.resolve({ busy: false });
    return new Promise(resolve => {
      const listener = message => {
        if (message?.type !== 'quiesced') return;
        timers.clearTimeout(timer);
        proc.off('message', listener);
        resolve({ busy: message.busy === true });
      };
      const timer = timers.setTimeout(() => {
        proc.off('message', listener);
        resolve({ busy: true });
      }, quiesceTimeoutMs);
      proc.on('message', listener);
      proc.postMessage({ type: 'quiesce' });
    });
  }

  function resume() {
    try {
      child?.postMessage({ type: 'resume' });
    } catch {
      // The companion is gone; nothing to resume.
    }
  }

  /** The companion's /status, used by the quit guard and the smoke test. */
  async function status() {
    if (!info) return { busy: false };
    const response = await fetchImpl(`http://127.0.0.1:${info.port}/status`, {
      headers: { Origin: origin, Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('Processing status unavailable.');
    return response.json();
  }

  return {
    start,
    stop,
    restart,
    quiesce,
    resume,
    status,
    info: () => info,
    state: () => state,
    isRunning: () => child !== null,
  };
}

/** WOODSHED_DEVICE_NAME: the macOS computer name, else the hostname without `.local`. */
function deviceName({ platform = process.platform, execFile = execFileSync, hostname = os.hostname } = {}) {
  if (platform === 'darwin') {
    try {
      const name = String(execFile('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 })).trim();
      if (name) return name.slice(0, 100);
    } catch {
      // Fall back to the hostname.
    }
  }
  const host = String(hostname() || '').replace(/\.local$/i, '').trim();
  return (host || 'This computer').slice(0, 100);
}

/** The companion's fork environment (§6.11 item 10). */
function companionEnv({ baseEnv = process.env, uiOrigin, userData, resources, appVersion, platform = process.platform, arch = process.arch, name }) {
  const processorDir = path.join(resources, 'processor', 'woodshed-processor');
  return {
    ...baseEnv,
    WOODSHED_WEB_URL: uiOrigin,
    WOODSHED_COMPANION_PORT: '0',
    WOODSHED_DATA_DIR: path.join(userData, 'library'),
    WOODSHED_PROCESSOR: path.join(processorDir, platform === 'win32' ? 'woodshed-processor.exe' : 'woodshed-processor'),
    WOODSHED_GPU_MANIFEST: path.join(resources, 'gpu-runtime.json'),
    WOODSHED_GPU_CACHE: path.join(userData, 'accelerators'),
    SSL_CERT_FILE: baseEnv.SSL_CERT_FILE || path.join(processorDir, '_internal', 'certifi', 'cacert.pem'),
    PATH: path.join(resources, 'bin') + path.delimiter + (baseEnv.PATH || ''),
    TORCH_HOME: path.join(userData, 'models'),
    MPLCONFIGDIR: path.join(userData, 'matplotlib'),
    WOODSHED_APP_VERSION: appVersion,
    WOODSHED_PLATFORM: `${platform}-${arch}`,
    WOODSHED_DEVICE_NAME: name,
  };
}

// ---------- handlers ----------

/**
 * Registers every desktop:* handler. Call after `app.whenReady()` (it
 * registers the persisted background shortcuts) and before the window loads.
 *
 * @param {{
 *   app: Electron.App, ipcMain: Electron.IpcMain, BrowserWindow?: typeof Electron.BrowserWindow,
 *   powerSaveBlocker: Electron.PowerSaveBlocker, globalShortcut: Electron.GlobalShortcut,
 *   Notification: typeof Electron.Notification, systemPreferences?: Electron.SystemPreferences, shell?: Electron.Shell,
 *   getWindow: () => Electron.BrowserWindow|null, trusted: (event) => boolean,
 *   updateController: {getState(): object, show(): Promise<void>, setPlaying(playing: boolean): unknown},
 *   companion: ReturnType<typeof createCompanionHost>,
 *   nativeTheme: Electron.NativeTheme, mediaProxy: {register(url: string): string},
 *   menu: {setSpec(spec): boolean, setSongOpen(on: boolean): void},
 *   prefs: ReturnType<typeof createDesktopPrefs>, themeFile: string, fs?: typeof import('node:fs'), platform?: string,
 * }} deps
 */
function createHandlers({
  app,
  ipcMain,
  powerSaveBlocker,
  globalShortcut,
  Notification,
  systemPreferences,
  getWindow,
  trusted,
  updateController,
  companion,
  nativeTheme,
  mediaProxy,
  menu,
  prefs,
  themeFile,
  fs = nodeFs,
  platform = process.platform,
}) {
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const guard = event => {
    if (!trusted(event)) throw new Error('Untrusted window');
  };
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    guard(event);
    return fn(...args);
  });
  const on = (channel, fn) => ipcMain.on(channel, (event, ...args) => {
    if (trusted(event)) fn(...args);
  });

  const shortcuts = createGlobalShortcuts({
    globalShortcut,
    systemPreferences,
    platform,
    send: id => send('desktop:command', { id, source: 'global' }),
  });
  const notifications = new Set();
  let blocker = null;

  function setKeepAwake(on) {
    if (on && blocker === null) {
      blocker = powerSaveBlocker.start('prevent-display-sleep');
    } else if (!on && blocker !== null) {
      if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  }

  function setActivity(activity) {
    if (activity.keepAwake !== undefined) setKeepAwake(activity.keepAwake);
    if (activity.songOpen !== undefined) menu.setSongOpen(activity.songOpen);
    if (activity.playing !== undefined) void updateController.setPlaying(activity.playing);
  }

  handle('desktop:media-url', url => mediaProxy.register(url));

  handle('desktop:theme', theme => {
    if (!THEMES.includes(theme)) throw new Error('Unknown theme');
    nativeTheme.themeSource = theme;
    fs.mkdirSync(path.dirname(themeFile), { recursive: true });
    fs.writeFileSync(themeFile, JSON.stringify({ theme }));
  });

  handle('desktop:info', () => ({
    version: app.getVersion(),
    platform,
    companion: companion.info(),
    update: updateController.getState(),
    processor: companion.state(),
    backgroundShortcuts: shortcuts.state(),
  }));

  handle('desktop:update', async action => {
    if (action !== 'show') throw new Error('Unknown update action');
    await updateController.show();
    return updateController.getState();
  });

  handle('desktop:restart-processor', async () => {
    const next = await companion.restart();
    return { port: next.port, token: next.token };
  });

  handle('desktop:global-shortcuts', (enabled, options) => {
    if (typeof enabled !== 'boolean') throw new Error('Expected true or false');
    prefs.set({ backgroundShortcuts: enabled });
    return shortcuts.apply(enabled, { promptAccessibility: options?.promptAccessibility === true });
  });

  handle('desktop:notify', payload => {
    const note = validateNotification(payload);
    const win = getWindow();
    // Main decides focus: the renderer's view of it may be stale.
    if (!win || win.isDestroyed() || win.isFocused()) return false;
    if (!Notification.isSupported()) return false;
    const notification = new Notification({ title: note.title, body: note.body });
    notifications.add(notification);
    notification.on('click', () => {
      notifications.delete(notification);
      const target = getWindow();
      if (!target || target.isDestroyed()) return;
      if (target.isMinimized?.()) target.restore();
      target.show();
      target.focus();
      target.webContents.send('desktop:navigate', note.route);
    });
    notification.on('close', () => notifications.delete(notification));
    notification.show();
    return true;
  });

  on('desktop:menu', spec => {
    menu.setSpec(spec);
  });

  on('desktop:activity', payload => {
    const activity = validateActivity(payload);
    if (activity) setActivity(activity);
  });

  const onWillQuit = () => shortcuts.unregisterAll();
  app.on('will-quit', onWillQuit);
  if (prefs.get().backgroundShortcuts) shortcuts.apply(true);

  return {
    shortcuts,
    /** A reload or renderer crash forgets the old page's activity. */
    resetActivity() {
      setKeepAwake(false);
      menu.setSongOpen(false);
      void updateController.setPlaying(false);
    },
    get keepAwake() {
      return blocker !== null;
    },
    dispose() {
      for (const channel of INVOKE_CHANNELS) ipcMain.removeHandler(channel);
      for (const channel of SEND_CHANNELS) ipcMain.removeAllListeners(channel);
      app.removeListener('will-quit', onWillQuit);
      setKeepAwake(false);
      shortcuts.unregisterAll();
      notifications.clear();
    },
  };
}

module.exports = {
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  GLOBAL_SHORTCUTS,
  NOTIFY_LIMITS,
  PROCESSOR_MESSAGES,
  DEFAULT_DESKTOP_PREFS,
  createTrust,
  validateNotification,
  validateActivity,
  createDesktopPrefs,
  createGlobalShortcuts,
  createCompanionHost,
  companionEnv,
  deviceName,
  createHandlers,
};
