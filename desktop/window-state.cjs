'use strict';
// Window size and position memory (architecture §6.11 item 8,
// maps/companion-desktop.md §16.9). userData/window-state.json holds
// {x, y, width, height, maximized, fullScreen, displayId}.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SIZE = Object.freeze({ width: 1280, height: 850 });
const MIN_SIZE = Object.freeze({ width: 640, height: 480 });
const MIN_VISIBLE = 100;
const SAVE_EVENTS = ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'];

const finite = value => typeof value === 'number' && Number.isFinite(value);

function overlap(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width, height };
}

function centred(area, size, min) {
  const width = Math.max(min.width, Math.min(size.width, area.width));
  const height = Math.max(min.height, Math.min(size.height, area.height));
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

/**
 * Pure: the bounds to open with.
 * Saved bounds are used only when they overlap some display's work area by at
 * least 100×100 px; otherwise the default size is centred on the primary
 * display. Sizes are clamped to the minimum.
 * @param {object|null} saved
 * @param {{displays: {id?: number, workArea: {x,y,width,height}}[], primary: {workArea: {x,y,width,height}}, defaults?: {width,height}, min?: {width,height}}} screenInfo
 * @returns {{bounds: {x?: number, y?: number, width: number, height: number}, maximized: boolean, fullScreen: boolean}}
 */
function restoreBounds(saved, { displays, primary, defaults = DEFAULT_SIZE, min = MIN_SIZE }) {
  const maximized = saved?.maximized === true;
  const fullScreen = saved?.fullScreen === true;
  const area = primary?.workArea;
  const fallback = area ? centred(area, defaults, min) : { width: defaults.width, height: defaults.height };
  const valid = saved && ['x', 'y', 'width', 'height'].every(key => finite(saved[key])) && saved.width > 0 && saved.height > 0;
  if (!valid) return { bounds: fallback, maximized, fullScreen };
  const bounds = {
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: Math.max(min.width, Math.round(saved.width)),
    height: Math.max(min.height, Math.round(saved.height)),
  };
  const visible = (displays || []).some(display => {
    if (!display?.workArea) return false;
    const shared = overlap(bounds, display.workArea);
    return shared.width >= MIN_VISIBLE && shared.height >= MIN_VISIBLE;
  });
  return { bounds: visible ? bounds : fallback, maximized, fullScreen };
}

/** Reads the window's state for saving; normal bounds keep the pre-maximize size. */
function snapshot(win, screen) {
  const normal = win.getNormalBounds();
  let displayId;
  try {
    displayId = screen?.getDisplayMatching?.(normal)?.id;
  } catch {
    displayId = undefined;
  }
  return {
    x: normal.x,
    y: normal.y,
    width: normal.width,
    height: normal.height,
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
    ...(displayId === undefined ? {} : { displayId }),
  };
}

/**
 * @param {{file: string, screen: Electron.Screen, fs?: typeof import('node:fs'), timers?: {setTimeout, clearTimeout}, debounceMs?: number, defaults?: {width,height}, min?: {width,height}}} options
 */
function createWindowState({ file, screen, fs: fsImpl = fs, timers = globalThis, debounceMs = 500, defaults = DEFAULT_SIZE, min = MIN_SIZE }) {
  let timer = null;

  function read() {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function write(state) {
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      fsImpl.writeFileSync(file, JSON.stringify(state));
    } catch {
      // Window memory is a convenience; a read-only profile must not break the app.
    }
  }

  /** The restore decision, plus BrowserWindow options for it. */
  function load() {
    const restored = restoreBounds(read(), {
      displays: screen.getAllDisplays(),
      primary: screen.getPrimaryDisplay(),
      defaults,
      min,
    });
    return { ...restored, options: { ...restored.bounds, minWidth: min.width, minHeight: min.height } };
  }

  function saveNow(win) {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    if (!win || win.isDestroyed?.()) return;
    write(snapshot(win, screen));
  }

  function schedule(win) {
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      saveNow(win);
    }, debounceMs);
  }

  /**
   * Saves (debounced) on every bounds change and synchronously on close.
   * Call this before installing other `close` listeners, so the state is
   * written before the quit guard runs.
   */
  function track(win) {
    const onChange = () => schedule(win);
    const onClose = () => saveNow(win);
    for (const name of SAVE_EVENTS) win.on(name, onChange);
    win.on('close', onClose);
    return () => {
      for (const name of SAVE_EVENTS) win.removeListener(name, onChange);
      win.removeListener('close', onClose);
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    };
  }

  /** Applies maximize or full screen once the window is shown. */
  function applyAfterShow(win, restored) {
    if (restored.fullScreen) win.setFullScreen(true);
    else if (restored.maximized) win.maximize();
  }

  return { load, track, saveNow, applyAfterShow, read };
}

/** Sends `desktop:fullscreen` {on} on full-screen changes (bridge onFullScreen). */
function watchFullScreen(win, send) {
  const enter = () => send('desktop:fullscreen', { on: true });
  const leave = () => send('desktop:fullscreen', { on: false });
  win.on('enter-full-screen', enter);
  win.on('leave-full-screen', leave);
  return () => {
    win.removeListener('enter-full-screen', enter);
    win.removeListener('leave-full-screen', leave);
  };
}

module.exports = { DEFAULT_SIZE, MIN_SIZE, restoreBounds, snapshot, createWindowState, watchFullScreen };
