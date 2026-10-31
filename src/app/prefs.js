// Device prefs: localStorage['ws.prefs'], schema v1 (architecture §2.5).
//
// - `loadPrefs(storage)` parses ws.prefs and deep-merges it over the defaults;
//   when ws.prefs is absent (or unreadable) it runs the one-way migration of the
//   13 legacy ws.* keys and writes the result.
// - `migrateLegacy(storage)` is that migration, pure over a Storage-like object
//   apart from writing ws.prefs and removing the legacy keys. Two legacy keys
//   were account settings (stop behaviour, keep pitch); they come back in
//   `account` and ride in `prefs.pendingAccount` until account.patch succeeds.
// - `prefs` is the live API; its signal is `store.prefs`. Writes persist the
//   whole JSON (in memory only when storage fails), other tabs follow through
//   `storage` events, and theme/stage changes go to window.woodshedAppearance.
// - `deviceStore(ns)` is a small namespaced key/value store (ws.<ns>.<key>).
//
// This module and src/app/router.js (ws.intendedRoute) are the only web-storage
// users in the app (guard §7.6). theme-init.js reads ws.prefs pre-paint.
//
// Import-cycle note: store.js imports prefsSignal() from here and this module
// imports store.js; neither touches the other at module-evaluation time.

import {signal, readonly, store, untracked} from './store.js';

export const PREFS_KEY = 'ws.prefs';

export const PREFS_DEFAULTS = deepFreeze({
  v: 1,
  theme: 'system',                 // 'system'|'light'|'dark'
  stage: 'dark',                   // 'dark'|'match'   (Appearance → Stage)
  library: {layout: 'grid', group: 'none', sort: null, filter: null, opened: []},
  practice: {distance: 'stand', focus: false, follow: {rail: 'scroll', band: 'page'}, edgeFlash: false, announceSections: false},
  chart: {display: {layout: null}, pinchScale: null, pinchDistance: null},   // pinchDistance: the Distance pinchScale was set at
  stems: {grid: 'bar', snap: true, follow: true, zoom: null},
  roadmap: {waveRowSec: null, follow: null},                         // follow: 'scroll'|'page'; null → 'scroll' (spec §4.4B)
  edit: {lastTab: 'map', map: {tapSnap: true, tapOffset: 0}, chart: {view: 'score', paging: 'pages', keys: {}}},   // keys: kitId → KeyString; '' = deliberately no key
  pedals: {enabled: false, profile: 'practice', pedals: [], custom: {}},
  midi: {enabled: false, bindings: []},
  remote: {allow: true, hostId: null, last: null},   // the phone remote (src/remote): allow control here, this device's host id, the device last controlled
  palette: {frecency: {}},
  deviceId: null,
  jobStats: {},
  hints: {fullscreenFocus: false},
  pendingAccount: null,
});

/** The 13 legacy localStorage keys the migration reads and then removes. */
export const LEGACY_KEYS = Object.freeze([
  'ws.theme', 'ws.view', 'ws.stopBehavior', 'ws.grid', 'ws.overview', 'ws.preservePitch', 'ws.practice.view',
  'ws.chart.scale', 'ws.chart.layout', 'ws.notation.layout', 'ws.notation.keys', 'ws.tapSnap', 'ws.tapOffset',
]);

/** Chart scale steps (§2.14.12); legacy ws.chart.scale snaps to these, ties upward. */
export const SCALE_STEPS = Object.freeze([0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.45, 1.6, 1.8, 2.0]);

export const OPENED_CAP = 500;
export const FRECENCY_CAP = 200;
export const TAP_OFFSET_LIMIT = 0.2;

const ENUMS = {
  theme: ['system', 'light', 'dark'],
  stage: ['dark', 'match'],
  'library.layout': ['grid', 'list'],
  'library.group': ['none', 'album', 'artist'],
  'practice.distance': ['near', 'stand', 'kit'],
  'practice.follow.rail': ['scroll', 'page'],
  'practice.follow.band': ['scroll', 'page'],
  'stems.grid': ['off', 'bar', 'beat', 'half', 'quarter'],
  'edit.lastTab': ['map', 'chart', 'details'],
  'edit.chart.view': ['score', 'lanes'],
  'edit.chart.paging': ['pages', 'scroll'],
};

// Paths whose default is null, and the type a stored value must have
// (or, for a nullable enum, the values it may take).
const NULLABLE = {
  'library.sort': 'string',
  'library.filter': 'string',
  'chart.display.layout': 'string',
  'chart.pinchScale': 'number',
  'chart.pinchDistance': ['near', 'stand', 'kit'],
  'stems.zoom': 'number',
  'roadmap.waveRowSec': 'number',
  'roadmap.follow': ['scroll', 'page'],
  deviceId: 'string',
  'remote.hostId': 'string',
  'remote.last': 'string',
  pendingAccount: 'object',
};

// ---------- helpers ----------

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const typeOk = (v, type) => (Array.isArray(type) ? type.includes(v)
  : type === 'object' ? isPlainObject(v) : type === 'number' ? Number.isFinite(v) : typeof v === type);

function mergeOver(def, value, path) {
  if (isPlainObject(def)) {
    if (!isPlainObject(value)) return clone(def);
    if (Object.keys(def).length === 0) return clone(value);   // free-form maps: keys, custom, frecency, jobStats
    const out = {};
    for (const key of Object.keys(def)) out[key] = mergeOver(def[key], value[key], path ? `${path}.${key}` : key);
    return out;
  }
  if (Array.isArray(def)) return Array.isArray(value) ? clone(value) : [];
  if (def === null) {
    const type = NULLABLE[path];
    return value != null && type && typeOk(value, type) ? clone(value) : null;
  }
  if (typeof value !== typeof def || (typeof def === 'number' && !Number.isFinite(value))) return def;
  const allowed = ENUMS[path];
  if (allowed && !allowed.includes(value)) return def;
  return value;
}

/** Deep-merges a stored prefs object over the defaults and enforces the schema and caps. */
export function normalizePrefs(raw) {
  const p = mergeOver(PREFS_DEFAULTS, isPlainObject(raw) ? raw : {}, '');
  p.v = 1;
  p.library.opened = p.library.opened.filter(id => typeof id === 'string').slice(-OPENED_CAP);
  const tap = p.edit.map.tapOffset;
  p.edit.map.tapOffset = Math.max(-TAP_OFFSET_LIMIT, Math.min(TAP_OFFSET_LIMIT, tap));
  const keys = {};
  for (const [kit, key] of Object.entries(p.edit.chart.keys)) if (typeof key === 'string') keys[kit] = key;
  p.edit.chart.keys = keys;
  const frecency = Object.entries(p.palette.frecency).filter(([, e]) => isPlainObject(e));
  if (frecency.length > FRECENCY_CAP) {
    frecency.sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0));
    frecency.length = FRECENCY_CAP;
  }
  p.palette.frecency = Object.fromEntries(frecency);
  // One-way upgrade: a pinch override stored before chart.pinchDistance existed belongs to
  // the Distance that was current, so it is not applied at the others.
  if (p.chart.pinchScale !== null && p.chart.pinchDistance === null) p.chart.pinchDistance = p.practice.distance;
  return p;
}

/** Nearest chart scale step; an exact tie goes to the larger step (1.25 → 1.3). */
export function snapScale(value) {
  if (!Number.isFinite(value)) return null;
  let best = SCALE_STEPS[0], bestDistance = Infinity;
  for (const step of SCALE_STEPS) {          // ascending, so "<=" hands a tie to the larger step
    const d = Math.abs(step - value);
    if (d <= bestDistance + 1e-9) { best = step; bestDistance = Math.min(d, bestDistance); }
  }
  return best;
}

/** A legacy drum-key character → its KeyString ('q' → 'KeyQ'); anything but a single letter → null. */
export function letterToKeyString(ch) {
  return typeof ch === 'string' && /^[a-z]$/i.test(ch) ? `Key${ch.toUpperCase()}` : null;
}

function safeGet(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}

function parseJson(text) {
  if (text == null) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

// ---------- migration (one way, no UI) ----------

/**
 * Builds ws.prefs from the 13 legacy ws.* keys, writes it, and removes the
 * legacy keys. Never throws: a storage that throws leaves the keys in place and
 * the returned prefs in memory only.
 * @returns {{prefs: object, account: object|null}}
 */
export function migrateLegacy(storage) {
  const p = clone(PREFS_DEFAULTS);
  let account = null;
  const read = key => (storage ? safeGet(storage, key) : null);

  const theme = read('ws.theme');
  if (ENUMS.theme.includes(theme)) p.theme = theme;

  const view = parseJson(read('ws.view'));
  if (isPlainObject(view)) {
    if (view.layout === 'list' || view.layout === 'grid') p.library.layout = view.layout;
    const group = {albums: 'album', artists: 'artist', songs: 'none'}[view.group];
    if (group) p.library.group = group;
  }

  const stop = read('ws.stopBehavior');
  if (stop === 'return' || stop === 'stay') (account ??= {practice: {}}).practice.stop = stop === 'stay' ? 'stay' : 'cue';

  const pitch = read('ws.preservePitch');
  if (pitch === '1' || pitch === '0') (account ??= {practice: {}}).practice.keepPitch = pitch === '1';

  const grid = parseJson(read('ws.grid'));
  if (isPlainObject(grid)) {
    const division = {1: 'beat', 2: 'half', 4: 'quarter'}[grid.division] ?? 'beat';
    p.stems.grid = grid.visible === false ? 'off' : division;
    p.stems.snap = grid.snap === true;
  }

  // ws.overview and ws.practice.view are dropped.

  const scale = parseJson(read('ws.chart.scale'));
  if (Number.isFinite(scale)) {
    p.chart.pinchScale = snapScale(scale);
    p.chart.pinchDistance = p.practice.distance;   // 1.x had one chart size: the default Distance's
  }

  const chartLayout = parseJson(read('ws.chart.layout'));
  if (typeof chartLayout === 'string' && chartLayout) p.chart.display.layout = chartLayout;

  const notationLayout = read('ws.notation.layout');
  if (notationLayout === 'score' || notationLayout === 'lanes') p.edit.chart.view = notationLayout;

  const keys = parseJson(read('ws.notation.keys'));
  if (isPlainObject(keys)) {
    for (const [kit, ch] of Object.entries(keys)) {
      // '' was a key the user cleared in the 1.x Drum shortcuts dialog: keep it as '' ("no key"),
      // so the kit does not fall back to its KIT default letter.
      const key = ch === '' ? '' : letterToKeyString(ch);
      if (key !== null) p.edit.chart.keys[kit] = key;
    }
  }

  const tapSnap = read('ws.tapSnap');
  if (tapSnap === '0' || tapSnap === '1') p.edit.map.tapSnap = tapSnap === '1';

  const tapOffset = parseFloat(read('ws.tapOffset'));
  if (Number.isFinite(tapOffset)) p.edit.map.tapOffset = Math.max(-TAP_OFFSET_LIMIT, Math.min(TAP_OFFSET_LIMIT, tapOffset));

  p.pendingAccount = account;
  const prefs = normalizePrefs(p);
  if (storage) {
    try {
      storage.setItem(PREFS_KEY, JSON.stringify(prefs));
      for (const key of LEGACY_KEYS) storage.removeItem(key);
    } catch {
      // Storage is unavailable or full: keep everything in memory; the legacy keys stay for next time.
    }
  }
  return {prefs, account};
}

/** Reads ws.prefs (deep-merged over the defaults); migrates the legacy keys when it is absent. */
export function loadPrefs(storage = defaultStorage()) {
  const stored = storage ? parseJson(safeGet(storage, PREFS_KEY)) : undefined;
  if (isPlainObject(stored)) return normalizePrefs(stored);
  return migrateLegacy(storage).prefs;
}

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// ---------- the live prefs ----------

// `var` so these exist (undefined) even if prefsSignal() runs during an import cycle.
var state;        // {sig, view, storage}

function writeStorage(value) {
  if (!state.storage) return;
  try { state.storage.setItem(PREFS_KEY, JSON.stringify(value)); } catch { /* in memory only */ }
}

function appearance(previous, next, {local}) {
  if (previous && previous.theme === next.theme && previous.stage === next.stage) return;
  try { globalThis.window?.woodshedAppearance?.apply?.({theme: next.theme, stage: next.stage}); } catch { /* pre-paint script missing */ }
  if (local && previous && previous.theme !== next.theme) {
    // desktop.setTheme (§2.11) over the preload bridge; a no-op when the bridge is absent.
    try { Promise.resolve(globalThis.window?.woodshedDesktop?.setTheme?.(next.theme)).catch(() => {}); } catch { /* bridge missing */ }
  }
}

function commit(next, {persist = true, local = true} = {}) {
  const previous = state.sig.peek();
  const value = deepFreeze(normalizePrefs(next));
  if (JSON.stringify(previous) === JSON.stringify(value)) return;
  if (persist) writeStorage(value);
  state.sig.value = value;
  // By content: every commit clones pendingAccount, and only a real change may notify (boot step 5).
  if (JSON.stringify(store.pendingAccount.peek() ?? null) !== JSON.stringify(value.pendingAccount)) {
    store.pendingAccount.value = value.pendingAccount;
  }
  appearance(previous, value, {local});
}

function init() {
  const storage = defaultStorage();
  const initial = deepFreeze(loadPrefs(storage));
  const sig = signal(initial);
  state = {sig, view: readonly(sig), storage};
  untracked(() => {
    store.pendingAccount.value = initial.pendingAccount;
    // Clearing store.pendingAccount (after account.patch succeeds) clears it in ws.prefs too.
    store.pendingAccount.subscribe(value => {
      if (value == null && state.sig.peek().pendingAccount != null) prefs.set('pendingAccount', null);
    });
  });
  const win = globalThis.window;
  if (win?.addEventListener) {
    win.addEventListener('storage', event => {
      if (event.key !== PREFS_KEY && event.key !== null) return;
      if (event.storageArea && state.storage && event.storageArea !== state.storage) return;
      const stored = state.storage ? parseJson(safeGet(state.storage, PREFS_KEY)) : undefined;
      commit(isPlainObject(stored) ? stored : PREFS_DEFAULTS, {persist: false, local: false});
    });
  }
  appearance(null, initial, {local: false});
  return state;
}

/** The writable signal behind store.prefs; created (and ws.prefs loaded) on first use. */
export function prefsSignal() {
  return (state ?? init()).sig;
}

const getPath = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function setPath(obj, path, value) {
  const keys = String(path).split('.');
  if (!path || keys.some(k => !k)) throw new TypeError(`prefs.set: bad path ${JSON.stringify(path)}`);
  const root = clone(obj);
  let node = root;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = clone(value);
  return root;
}

export const prefs = {
  /** ReadonlySignal<Prefs> (the same signal as store.prefs). */
  get value() { prefsSignal(); return state.view; },
  /** Reads a dotted path, e.g. 'practice.distance'. Tracked inside effects. */
  get(path) { return getPath(prefsSignal().value, path); },
  /** Sets a dotted path and persists the whole JSON (in memory only when storage fails). */
  set(path, value) { prefsSignal(); commit(setPath(state.sig.peek(), path, value)); },
  /** Mutates a draft copy, then commits it. */
  update(fn) {
    prefsSignal();
    const draft = clone(state.sig.peek());
    fn(draft);
    commit(draft);
  },
};

/** Clears the account carry-over once account.patch has applied it (boot step 5). */
export function clearPendingAccount() { prefs.set('pendingAccount', null); }

/**
 * A namespaced device-local key/value store: deviceStore('share').set(token, v) → ws.share.<token>.
 * Values are JSON. When storage throws, values live in memory for this page.
 */
export function deviceStore(namespace) {
  if (!namespace || typeof namespace !== 'string') throw new TypeError('deviceStore: namespace required');
  const memory = new Map();
  const full = key => `ws.${namespace}.${key}`;
  const storage = () => defaultStorage();
  return {
    get(key) {
      const k = full(key);
      if (memory.has(k)) return clone(memory.get(k));
      const s = storage();
      const value = s ? parseJson(safeGet(s, k)) : undefined;
      return value === undefined ? null : value;
    },
    set(key, value) {
      const k = full(key);
      try {
        const s = storage();
        if (!s) throw new Error('no storage');
        s.setItem(k, JSON.stringify(value));
        memory.delete(k);
      } catch {
        memory.set(k, clone(value));
      }
    },
    remove(key) {
      const k = full(key);
      memory.delete(k);
      try { storage()?.removeItem(k); } catch { /* nothing stored */ }
    },
  };
}
