// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {LEGACY_KEYS, PREFS_DEFAULTS, PREFS_KEY, SCALE_STEPS, letterToKeyString, loadPrefs, migrateLegacy, normalizePrefs, snapScale}
  from '../src/app/prefs.js';

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: vi.fn((k, v) => { map.set(k, String(v)); }),
    removeItem: vi.fn(k => { map.delete(k); }),
  };
}

const LEGACY_1_9 = {
  'ws.theme': 'dark',
  'ws.view': JSON.stringify({group: 'albums', layout: 'list'}),
  'ws.stopBehavior': 'stay',
  'ws.grid': JSON.stringify({visible: true, snap: true, division: 2}),
  'ws.overview': '1',
  'ws.preservePitch': '0',
  'ws.practice.view': 'chart',
  'ws.chart.scale': '1.25',
  'ws.chart.layout': JSON.stringify('lanes-left'),
  'ws.notation.layout': 'lanes',
  'ws.notation.keys': JSON.stringify({snare: 'q', kick: 'Z', hihat: '', crash: '1', ride: 'ab'}),
  'ws.tapSnap': '0',
  'ws.tapOffset': '0.35',
};

describe('migrateLegacy (§2.5 table)', () => {
  test('there are exactly 13 legacy keys', () => {
    expect(LEGACY_KEYS).toHaveLength(13);
    expect(new Set(LEGACY_KEYS)).toEqual(new Set(Object.keys(LEGACY_1_9)));
  });

  test('maps every key, returns the account carry-over, writes ws.prefs and removes the legacy keys', () => {
    const storage = memoryStorage(LEGACY_1_9);
    const {prefs, account} = migrateLegacy(storage);
    expect(prefs.theme).toBe('dark');
    expect(prefs.library.layout).toBe('list');
    expect(prefs.library.group).toBe('album');
    expect(prefs.stems).toEqual({...PREFS_DEFAULTS.stems, grid: 'half', snap: true});
    expect(prefs.chart.pinchScale).toBe(1.3);
    expect(prefs.chart.pinchDistance).toBe('stand');                       // 1.x's one size: the default Distance
    expect(prefs.chart.display.layout).toBe('lanes-left');
    expect(prefs.edit.chart.view).toBe('lanes');
    // '' (a key the user cleared) stays as "no key"; '1' and 'ab' are dropped.
    expect(prefs.edit.chart.keys).toEqual({snare: 'KeyQ', kick: 'KeyZ', hihat: ''});
    expect(prefs.edit.map).toEqual({tapSnap: false, tapOffset: 0.2});        // clamped to ±0.2 s
    expect(account).toEqual({practice: {stop: 'stay', keepPitch: false}});
    expect(prefs.pendingAccount).toEqual(account);
    // dropped keys leave no trace
    expect(JSON.stringify(prefs)).not.toMatch(/overview|practiceView/);
    expect(JSON.parse(storage.map.get(PREFS_KEY))).toEqual(prefs);
    for (const key of LEGACY_KEYS) expect(storage.map.has(key)).toBe(false);
  });

  test.each([
    [{'ws.view': JSON.stringify({group: 'artists', layout: 'grid'})}, p => [p.library.group, p.library.layout], ['artist', 'grid']],
    [{'ws.view': JSON.stringify({group: 'songs'})}, p => p.library.group, 'none'],
    [{'ws.grid': JSON.stringify({visible: false, snap: false, division: 4})}, p => [p.stems.grid, p.stems.snap], ['off', false]],
    [{'ws.grid': JSON.stringify({visible: true, division: 1})}, p => p.stems.grid, 'beat'],
    [{'ws.grid': JSON.stringify({division: 4, snap: true})}, p => [p.stems.grid, p.stems.snap], ['quarter', true]],
    [{'ws.grid': JSON.stringify({division: 3})}, p => p.stems.grid, 'beat'],
    [{'ws.chart.scale': '1.4'}, p => p.chart.pinchScale, 1.45],
    [{'ws.chart.scale': '0.9'}, p => p.chart.pinchScale, 0.9],
    [{'ws.chart.layout': 'null'}, p => p.chart.display.layout, null],
    [{'ws.notation.layout': 'score'}, p => p.edit.chart.view, 'score'],
    [{'ws.tapSnap': '1', 'ws.tapOffset': '-0.05'}, p => p.edit.map, {tapSnap: true, tapOffset: -0.05}],
    [{'ws.tapOffset': '-3'}, p => p.edit.map.tapOffset, -0.2],
    [{'ws.theme': 'sepia'}, p => p.theme, 'system'],
  ])('%j', (entries, pick, expected) => {
    expect(pick(migrateLegacy(memoryStorage(entries)).prefs)).toEqual(expected);
  });

  test('stop behaviour return → cue and keep pitch on, each alone', () => {
    expect(migrateLegacy(memoryStorage({'ws.stopBehavior': 'return'})).account).toEqual({practice: {stop: 'cue'}});
    expect(migrateLegacy(memoryStorage({'ws.preservePitch': '1'})).account).toEqual({practice: {keepPitch: true}});
  });

  test('a fresh device migrates to the defaults with no account carry-over', () => {
    const storage = memoryStorage();
    const {prefs, account} = migrateLegacy(storage);
    expect(account).toBeNull();
    expect(prefs).toEqual(normalizePrefs({}));
    expect(prefs).toEqual(JSON.parse(JSON.stringify(PREFS_DEFAULTS)));
  });

  test('garbage values never throw', () => {
    const storage = memoryStorage({'ws.view': '{bad', 'ws.grid': '[1,2]', 'ws.chart.scale': '"big"', 'ws.notation.keys': 'nope', 'ws.tapOffset': 'x'});
    const {prefs} = migrateLegacy(storage);
    expect(prefs.library.layout).toBe('grid');
    expect(prefs.stems.grid).toBe('bar');
    expect(prefs.chart.pinchScale).toBeNull();
    expect(prefs.edit.chart.keys).toEqual({});
    expect(prefs.edit.map.tapOffset).toBe(0);
  });

  test('survives a storage that throws on every call', () => {
    const throwing = {getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); }};
    expect(() => migrateLegacy(throwing)).not.toThrow();
    expect(loadPrefs(throwing)).toEqual(normalizePrefs({}));
  });

  test('a full storage keeps the legacy keys for next time and the prefs in memory', () => {
    const storage = memoryStorage({'ws.theme': 'light'});
    storage.setItem = vi.fn(() => { throw new Error('QuotaExceededError'); });
    const {prefs} = migrateLegacy(storage);
    expect(prefs.theme).toBe('light');
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.map.get('ws.theme')).toBe('light');
  });
});

describe('snapScale and KeyStrings', () => {
  test('nearest step, ties upward, clamped to the ends', () => {
    expect(SCALE_STEPS).toEqual([0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.45, 1.6, 1.8, 2.0]);
    expect(snapScale(1.25)).toBe(1.3);
    expect(snapScale(1.4)).toBe(1.45);
    expect(snapScale(1.375)).toBe(1.45);   // exact midpoint of 1.3 and 1.45
    expect(snapScale(0.85)).toBe(0.9);
    expect(snapScale(1.7)).toBe(1.8);
    expect(snapScale(0.1)).toBe(0.8);
    expect(snapScale(9)).toBe(2.0);
    for (const step of SCALE_STEPS) expect(snapScale(step)).toBe(step);
    expect(snapScale(Number.NaN)).toBeNull();
  });

  test('letters become physical-key KeyStrings (D56)', () => {
    expect(letterToKeyString('q')).toBe('KeyQ');
    expect(letterToKeyString('E')).toBe('KeyE');
    for (const bad of ['', '1', ';', 'ab', null, 3]) expect(letterToKeyString(bad)).toBeNull();
  });
});

describe('loadPrefs and normalizePrefs', () => {
  test('ws.prefs wins over legacy keys and nothing is migrated or removed', () => {
    const storage = memoryStorage({[PREFS_KEY]: JSON.stringify({v: 1, theme: 'light'}), 'ws.theme': 'dark'});
    const p = loadPrefs(storage);
    expect(p.theme).toBe('light');
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.map.get('ws.theme')).toBe('dark');
  });

  test('absent ws.prefs runs the migration; unreadable ws.prefs too', () => {
    expect(loadPrefs(memoryStorage({'ws.theme': 'dark'})).theme).toBe('dark');
    const corrupt = memoryStorage({[PREFS_KEY]: '{not json', 'ws.theme': 'light'});
    expect(loadPrefs(corrupt).theme).toBe('light');
    expect(JSON.parse(corrupt.map.get(PREFS_KEY)).theme).toBe('light');
  });

  test('deep-merges defaults, rejects bad types and enum values, keeps free-form maps', () => {
    const p = normalizePrefs({
      theme: 'neon', stage: 'match', library: {layout: 'list', group: 'genre', opened: ['a', 2, 'b'], extra: 1},
      practice: {distance: 'kit', follow: {rail: 'page'}}, stems: {grid: 'quarter', zoom: 'wide'},
      edit: {chart: {keys: {snare: 'KeyQ', bad: 7}}}, jobStats: {balanced: {secPerMin: 30, n: 2}},
      palette: {frecency: {'cmd:x': {n: 2, at: 5}}}, deviceId: 'dev1', pendingAccount: 'nope', unknownTop: true,
    });
    expect(p.theme).toBe('system');
    expect(p.stage).toBe('match');
    expect(p.library).toEqual({layout: 'list', group: 'none', sort: null, filter: null, opened: ['a', 'b']});
    expect(p.practice).toEqual({...PREFS_DEFAULTS.practice, distance: 'kit', follow: {rail: 'page', band: 'page'}});
    expect(p.stems).toEqual({...PREFS_DEFAULTS.stems, grid: 'quarter'});
    expect(p.edit.chart.keys).toEqual({snare: 'KeyQ'});
    expect(p.jobStats).toEqual({balanced: {secPerMin: 30, n: 2}});
    expect(p.palette.frecency).toEqual({'cmd:x': {n: 2, at: 5}});
    expect(p.deviceId).toBe('dev1');
    expect(p.pendingAccount).toBeNull();
    expect(p).not.toHaveProperty('unknownTop');
    expect(p.v).toBe(1);
  });

  test('chart.pinchDistance and roadmap.follow are nullable enums (I2b-3)', () => {
    expect(PREFS_DEFAULTS.chart).toEqual({display: {layout: null}, pinchScale: null, pinchDistance: null});
    expect(PREFS_DEFAULTS.roadmap).toEqual({waveRowSec: null, follow: null});
    for (const d of ['near', 'stand', 'kit']) {
      expect(normalizePrefs({chart: {pinchScale: 1.2, pinchDistance: d}}).chart).toEqual({display: {layout: null}, pinchScale: 1.2, pinchDistance: d});
    }
    for (const f of ['scroll', 'page']) expect(normalizePrefs({roadmap: {follow: f}}).roadmap).toEqual({waveRowSec: null, follow: f});
    for (const bad of ['far', 'Stand', '', 3, true, {}, ['near']]) {
      expect(normalizePrefs({chart: {pinchDistance: bad}}).chart.pinchDistance).toBeNull();
      expect(normalizePrefs({roadmap: {follow: bad}}).roadmap.follow).toBeNull();
    }
    expect(normalizePrefs({roadmap: {follow: 'band'}}).roadmap.follow).toBeNull();
    expect(normalizePrefs({roadmap: {waveRowSec: 6, follow: 'page'}}).roadmap).toEqual({waveRowSec: 6, follow: 'page'});
    // No pinch override: the Distance is kept as written (writers may set it first).
    expect(normalizePrefs({chart: {pinchDistance: 'kit'}}).chart.pinchDistance).toBe('kit');
  });

  test('a pinch override stored without its Distance is upgraded to the current Distance (one way)', () => {
    expect(normalizePrefs({chart: {pinchScale: 1.45}}).chart.pinchDistance).toBe('stand');
    expect(normalizePrefs({practice: {distance: 'kit'}, chart: {pinchScale: 1.45}}).chart.pinchDistance).toBe('kit');
    expect(normalizePrefs({practice: {distance: 'kit'}, chart: {pinchScale: 1.45, pinchDistance: 'near'}}).chart.pinchDistance).toBe('near');
    expect(normalizePrefs({practice: {distance: 'near'}, chart: {pinchScale: 1.45, pinchDistance: 'far'}}).chart.pinchDistance).toBe('near');
    expect(normalizePrefs({chart: {pinchScale: 'big'}}).chart).toEqual({display: {layout: null}, pinchScale: null, pinchDistance: null});
    const storage = memoryStorage({[PREFS_KEY]: JSON.stringify({v: 1, practice: {distance: 'near'}, chart: {pinchScale: 1.1}})});
    expect(loadPrefs(storage).chart).toEqual({display: {layout: null}, pinchScale: 1.1, pinchDistance: 'near'});
  });

  test('caps: opened ≤ 500 (oldest dropped), frecency ≤ 200 (least recent dropped)', () => {
    const opened = Array.from({length: 520}, (_, i) => `s${i}`);
    const frecency = Object.fromEntries(Array.from({length: 230}, (_, i) => [`i${i}`, {n: 1, at: i}]));
    const p = normalizePrefs({library: {opened}, palette: {frecency}});
    expect(p.library.opened).toHaveLength(500);
    expect(p.library.opened[0]).toBe('s20');
    expect(Object.keys(p.palette.frecency)).toHaveLength(200);
    expect(p.palette.frecency.i229).toBeDefined();
    expect(p.palette.frecency.i29).toBeUndefined();
  });
});

describe('live prefs (store.prefs)', () => {
  let mod, storeMod;
  async function boot(entries = {}) {
    localStorage.clear();
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    vi.resetModules();
    storeMod = await import('../src/app/store.js');
    mod = await import('../src/app/prefs.js');
    return {prefs: mod.prefs, store: storeMod.store};
  }
  beforeEach(() => {
    window.woodshedAppearance = {apply: vi.fn()};
    window.woodshedDesktop = {setTheme: vi.fn(async () => {})};
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete window.woodshedAppearance;
    delete window.woodshedDesktop;
    localStorage.clear();
  });

  test('first access migrates once, and store.prefs is prefs.value', async () => {
    const {prefs, store} = await boot({'ws.theme': 'dark', 'ws.stopBehavior': 'return'});
    expect(store.prefs.value.theme).toBe('dark');
    expect(prefs.value.value).toBe(store.prefs.value);
    expect(prefs.get('theme')).toBe('dark');
    expect(localStorage.getItem('ws.theme')).toBeNull();
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)).theme).toBe('dark');
    expect(window.woodshedAppearance.apply).toHaveBeenCalledWith({theme: 'dark', stage: 'dark'});
    expect(() => { prefs.value.value = {}; }).toThrow(TypeError);
  });

  test('pendingAccount is kept until cleared, then removed from ws.prefs', async () => {
    const {prefs, store} = await boot({'ws.preservePitch': '0'});
    expect(store.pendingAccount.value).toEqual({practice: {keepPitch: false}});
    expect(prefs.get('pendingAccount')).toEqual({practice: {keepPitch: false}});
    // Still there after a reload.
    vi.resetModules();
    const again = await import('../src/app/prefs.js');
    const againStore = (await import('../src/app/store.js')).store;
    expect(again.prefs.get('pendingAccount')).toEqual({practice: {keepPitch: false}});
    expect(againStore.pendingAccount.value).toEqual({practice: {keepPitch: false}});
    // account.patch succeeded (boot step 5): clearing either side clears both.
    againStore.pendingAccount.value = null;
    expect(again.prefs.get('pendingAccount')).toBeNull();
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)).pendingAccount).toBeNull();
    const third = await boot({'ws.stopBehavior': 'stay'});
    mod.clearPendingAccount();
    expect(third.store.pendingAccount.value).toBeNull();
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)).pendingAccount).toBeNull();
  });

  test('a cleared 1.x drum key survives migration and normalization as unbound', async () => {
    const {prefs} = await boot({'ws.notation.keys': JSON.stringify({snare: 'e', crash2: ''})});
    expect(prefs.get('edit.chart.keys')).toEqual({snare: 'KeyE', crash2: ''});
    expect(normalizePrefs(JSON.parse(localStorage.getItem(PREFS_KEY))).edit.chart.keys).toEqual({snare: 'KeyE', crash2: ''});
  });

  test('unrelated prefs writes do not notify store.pendingAccount subscribers', async () => {
    const {prefs, store} = await boot({'ws.stopBehavior': 'stay'});
    const seen = vi.fn();
    store.pendingAccount.subscribe(seen);
    prefs.set('practice.distance', 'kit');
    prefs.set('stems.snap', false);
    prefs.set('theme', 'dark');
    prefs.update(d => { d.library.layout = 'list'; });
    expect(seen).not.toHaveBeenCalled();
    expect(store.pendingAccount.value).toEqual({practice: {stop: 'stay'}});
    prefs.set('pendingAccount', {practice: {stop: 'cue'}});
    expect(seen).toHaveBeenCalledTimes(1);
  });

  test('set and update persist the whole JSON and notify subscribers', async () => {
    const {prefs, store} = await boot();
    const seen = vi.fn();
    store.prefs.subscribe(seen);
    prefs.set('practice.distance', 'kit');
    expect(prefs.get('practice.distance')).toBe('kit');
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)).practice.distance).toBe('kit');
    prefs.update(d => { d.library.opened.push('song1'); d.stems.zoom = 12; });
    expect(prefs.get('library.opened')).toEqual(['song1']);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)).stems.zoom).toBe(12);
    expect(seen).toHaveBeenCalledTimes(2);
    prefs.set('practice.distance', 'kit');   // unchanged: no write, no notification
    expect(seen).toHaveBeenCalledTimes(2);
    prefs.set('practice.distance', 'huge');  // invalid enum → default
    expect(prefs.get('practice.distance')).toBe('stand');
    prefs.update(d => { d.chart.pinchScale = 1.6; d.chart.pinchDistance = 'kit'; });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)).chart).toEqual({display: {layout: null}, pinchScale: 1.6, pinchDistance: 'kit'});
    prefs.set('roadmap.follow', 'page');
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)).roadmap.follow).toBe('page');
    prefs.set('roadmap.follow', 'sideways');   // invalid → null, the 'scroll' default
    expect(prefs.get('roadmap.follow')).toBeNull();
    expect(() => prefs.set('', 1)).toThrow(TypeError);
    expect(Object.isFrozen(prefs.get('library'))).toBe(true);
  });

  test('a failing setItem keeps the change in memory', async () => {
    const {prefs} = await boot();
    prefs.get('theme');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    expect(() => prefs.set('theme', 'light')).not.toThrow();
    expect(prefs.get('theme')).toBe('light');
  });

  test('theme changes call apply and desktop.setTheme once; stage changes only apply', async () => {
    const {prefs} = await boot();
    prefs.get('theme');
    window.woodshedAppearance.apply.mockClear();
    prefs.set('theme', 'light');
    expect(window.woodshedAppearance.apply).toHaveBeenCalledTimes(1);
    expect(window.woodshedAppearance.apply).toHaveBeenLastCalledWith({theme: 'light', stage: 'dark'});
    expect(window.woodshedDesktop.setTheme).toHaveBeenCalledTimes(1);
    expect(window.woodshedDesktop.setTheme).toHaveBeenLastCalledWith('light');
    prefs.set('stage', 'match');
    expect(window.woodshedAppearance.apply).toHaveBeenLastCalledWith({theme: 'light', stage: 'match'});
    expect(window.woodshedDesktop.setTheme).toHaveBeenCalledTimes(1);
    prefs.set('practice.focus', true);
    expect(window.woodshedAppearance.apply).toHaveBeenCalledTimes(2);
  });

  test('cross-tab: a storage event for ws.prefs re-reads without writing back', async () => {
    const {prefs, store} = await boot();
    prefs.get('theme');
    const other = {...JSON.parse(localStorage.getItem(PREFS_KEY)), theme: 'dark', practice: {...PREFS_DEFAULTS.practice, distance: 'near'}};
    localStorage.setItem(PREFS_KEY, JSON.stringify(other));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    window.dispatchEvent(new StorageEvent('storage', {key: PREFS_KEY}));
    expect(store.prefs.value.theme).toBe('dark');
    expect(prefs.get('practice.distance')).toBe('near');
    expect(setItem).not.toHaveBeenCalled();
    expect(window.woodshedAppearance.apply).toHaveBeenLastCalledWith({theme: 'dark', stage: 'dark'});
    expect(window.woodshedDesktop.setTheme).not.toHaveBeenCalled();   // the other tab already told the desktop
    window.dispatchEvent(new StorageEvent('storage', {key: 'ws.share.abc'}));
    expect(prefs.get('theme')).toBe('dark');
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', {key: null}));
    expect(prefs.get('theme')).toBe('system');
  });

  test('a throwing localStorage getter still yields working in-memory prefs', async () => {
    localStorage.clear();
    vi.resetModules();
    const spy = vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => { throw new Error('SecurityError'); });
    const {prefs} = await import('../src/app/prefs.js');
    expect(prefs.get('theme')).toBe('system');
    prefs.set('theme', 'dark');
    expect(prefs.get('theme')).toBe('dark');
    spy.mockRestore();
  });

  test('deviceStore namespaces JSON values and falls back to memory', async () => {
    await boot();
    const share = mod.deviceStore('share');
    expect(share.get('tok')).toBeNull();
    share.set('tok', {loop: [1, 2]});
    expect(localStorage.getItem('ws.share.tok')).toBe('{"loop":[1,2]}');
    expect(share.get('tok')).toEqual({loop: [1, 2]});
    share.remove('tok');
    expect(share.get('tok')).toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    share.set('big', [1]);
    expect(share.get('big')).toEqual([1]);
    expect(() => mod.deviceStore('')).toThrow(TypeError);
  });
});
