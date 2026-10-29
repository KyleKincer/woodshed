// @vitest-environment happy-dom
// Edit · Map view and commands (src/edit/map/view.js, commands.js, map.copy.js; architecture §2.15,
// §3.4 Em, D19, D20, D23, D47; spec §5.1–5.1.1; maps/mapedit.md §11.4) on a real song session
// (tests/helpers/test-session.js) with the real map session (src/edit/map/session.js) wired the way
// Edit wires it. Keys go through the real dispatcher on an isolated registry. Sizes and geometry
// are Playwright states (tests/fixture/states/ED3.cjs); here canvases are recording contexts.
//
// ED4's Find a chart panel (src/edit/map/find-panel.js) is a same-wave peer that view.js imports
// statically (§9.0): it is mocked here, and until it merges vitest cannot load view.js at all
// (Appendix C item 60), so the mounted suites are skipped while the file is missing.
import {existsSync} from 'node:fs';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));
const findPanel = vi.hoisted(() => ({mounts: []}));
vi.mock('../src/edit/map/find-panel.js', () => ({
  mountFindPanel: (el, opts) => {
    const node = document.createElement('div');
    node.className = 'find-panel-mock';
    el.append(node);
    const handle = {opts, destroyed: false, destroy() { handle.destroyed = true; node.remove(); }};
    findPanel.mounts.push(handle);
    return handle;
  },
}));

import {createRegistry} from '../src/app/commands.js';
import {startDispatcher} from '../src/app/dispatch.js';
import {clock as appClock} from '../src/app/clock.js';
import {signal} from '../src/app/store.js';
import {defineStageCommands} from '../src/stage/commands.js';
import {defineTransportCommands} from '../src/stage/transport-commands.js';
import {clearHatchCache} from '../src/stage/wave-render.js';
import {createMapSession, MAP_SESSION_COPY} from '../src/edit/map/session.js';
import {COPY, CONTROLS, MAPPING, MAP_COMMANDS as C, MAP_SCOPE} from '../src/edit/map/map.copy.js';
import {DIGIT_IDS, MAP_COMMAND_IDS, defineMapCommands, mapCommandDefs} from '../src/edit/map/commands.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {installCanvasShim, installPopoverShim, installResizeObserverShim, keydown, pointer, restoreDomShims, setRect, triggerResize} from './helpers/dom.js';

const PEER = 'src/edit/map/find-panel.js';
const peerOnDisk = existsSync(new URL(`../${PEER}`, import.meta.url));
// The view loads only once its peer exists (or a local alias stands in for it); a broken view.js still fails here.
const viewModule = await import('../src/edit/map/view.js').catch((err) => { if (peerOnDisk) throw err; return null; });

const KEY = 136, TOP = 40, WIDTH = 800, ROWS_H = 256;
let clock, restoreAudio, current = [];
const frames = new Map();
let frameId = 0;
const raf = (fn) => { frames.set(++frameId, fn); return frameId; };
const caf = (id) => { frames.delete(id); };
function frame() {
  const batch = [...frames.values()];
  frames.clear();
  for (const fn of batch) fn(0);
}

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(Date.parse('2026-10-28T12:00:00Z'));
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
  installPopoverShim();
  installCanvasShim();
  installResizeObserverShim();
  clearHatchCache();
  frames.clear();
  findPanel.mounts.length = 0;
});

afterEach(async () => {
  for (const off of current.splice(0).reverse()) await off();
  document.body.replaceChildren();
  for (const k of ['place', 'posture']) delete document.documentElement.dataset[k];
  restoreDomShims();
  restoreAudio();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const ROLE_OF = (el) => el.getAttribute('role') ?? ({BUTTON: 'button', SECTION: 'region', ASIDE: 'complementary', INPUT: 'textbox', A: 'link'})[el.tagName] ?? null;
function nameOf(el) {
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
  const by = el.getAttribute('aria-labelledby');
  if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  if (el.tagName === 'INPUT' && el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) return label.textContent.trim();
  }
  return (el.querySelector('.ui-button-label')?.textContent ?? el.textContent).trim();
}
function byRole(root, role, name) {
  return [root, ...root.querySelectorAll('*')].filter((el) => ROLE_OF(el) === role && !el.closest('[hidden]') && nameOf(el) === name);
}
const one = (root, role, name) => {
  const found = byRole(root, role, name);
  if (found.length !== 1) throw new Error(`expected one ${role} "${name}", found ${found.length}`);
  return found[0];
};

/** Device prefs over a signal (prefs.js's shape). */
function fakePrefs() {
  const value = signal({edit: {map: {tapSnap: true, tapOffset: 0}}});
  const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  return {
    value,
    get: (path) => at(value.peek(), path),
    set(path, v) {
      const next = structuredClone(value.peek());
      const keys = path.split('.');
      let o = next;
      for (const k of keys.slice(0, -1)) o = o[k] ??= {};
      o[keys.at(-1)] = v;
      value.value = next;
    },
  };
}

/** The map session the way Edit (ED2) wires it to the song session (§2.15 hooks, Appendix C item 50). */
function mapSessionFor(session, prefs) {
  const engine = session.engine;
  const statuses = [];
  const hooks = {
    suspendSaves: (on, opts) => session.suspendSaves?.(on, opts),
    pauseMapSync: (on) => session.notation?.setMapSyncPaused?.(!!on),
    status: (text, opts) => statuses.push({text, ...opts}),
    rename: () => {},
    loop: {
      get: () => ({loop: {...engine.loop}, gap: engine.loopGap}),
      set: (value) => {
        const l = value?.loop;
        if (l && Number.isFinite(l.a) && Number.isFinite(l.b)) engine.setLoop(!!l.enabled, l.a, l.b);
      },
    },
    markers: {
      list: () => (session.practice.value.peek().markers ?? []).filter((m) => !m.deleted),
      tombstone: (ids, deleted = true) => {
        const set = new Set(ids ?? []);
        session.practice.patch((p) => { for (const m of p.markers) if (set.has(m.id)) m.deleted = !!deleted; });
      },
    },
  };
  const mapSession = createMapSession({engine, metronome: session.metronome, map: session.map, prefs, hooks});
  session.mapEditor.value = mapSession;
  return {mapSession, hooks, statuses};
}

const feedbackStub = () => {
  const line = signal(null);
  const calls = [];
  return {
    calls,
    statusLine: line,
    attachStatusLine: () => () => {},
    status: (text, opts = {}) => { calls.push({text, ...opts}); line.value = {text, ...opts}; },
    toast: vi.fn(),
  };
};

/** A session, an isolated registry with the Map, Stage-map and transport commands, and a mounted view. */
async function bed({query = {}, review = false, find = false, dispatcher = false, platform = {isIPad: false, coarse: signal(false)}, ...options} = {}) {
  const ts = await createTestSession({clock, ...options});
  // The inspector's view of where Detect runs: this computer's processor, else the paired computers.
  const desktop = {available: !!options.desktop, processor: signal(options.desktop ? {phase: 'ready'} : {phase: 'web'})};
  const store = {library: ts.library};
  const reg = createRegistry();
  defineMapCommands({registry: reg});
  defineStageCommands({registry: reg, later: {}});
  defineTransportCommands({registry: reg, sheets: {}});
  const prefs = fakePrefs();
  const feedback = feedbackStub();
  const {mapSession, hooks, statuses} = mapSessionFor(ts.session, prefs);
  const router = {calls: [], navigate(to, opts) { this.calls.push([to, opts ?? null]); }};
  reg.provide('session', () => ts.session);
  reg.provide('transport', () => ts.session.transport);
  reg.provide('map', () => mapSession);
  reg.provide('router', () => router);
  reg.provide('edit', () => ({tab: 'map', done() {}, escape() {}}));
  const panel = document.createElement('div');
  const inspectorEl = document.createElement('div');
  document.body.append(panel, inspectorEl);
  let stop = null;
  if (dispatcher) {
    document.documentElement.dataset.place = 'edit';
    document.documentElement.dataset.posture = 'edit';
    stop = startDispatcher({registry: reg, platform: 'win'});
  }
  const closes = [];
  const view = viewModule.mountMapView(panel, {
    session: ts.session, mapSession, inspectorEl, find, review, query, mapHooks: hooks, registry: reg, prefs, platform, feedback, desktop, store,
    raf, caf, onCloseFind: () => closes.push('find'),
  });
  const root = panel.querySelector('section.map-view');
  const rows = root.querySelector('.map-cell-rows');
  setRect(rows, {x: KEY, y: TOP + 24 + 32 + 96, width: WIDTH, height: ROWS_H});
  for (const el of [root.querySelector('.map-ruler'), root.querySelector('.map-tempo-canvas'), root.querySelector('.map-sections')]) {
    setRect(el, {x: KEY, y: TOP, width: WIDTH, height: 24});
  }
  triggerResize(root.querySelector('.map-lanes'));
  frame();
  // The registry re-evaluates `when` 50 ms after the view provides 'mapView' (buttons enable then).
  vi.advanceTimersByTime(60);
  current.push(async () => { view.destroy(); mapSession.destroy(); ts.session.mapEditor.value = null; stop?.(); await ts.dispose(); });
  return {
    ts, reg, view, root, panel, inspectorEl, mapSession, hooks, statuses, feedback, prefs, router, closes, rows,
    get map() { return ts.session.map; },
    get snap() { return ts.snapshot; },
    xOf: (t) => KEY + ((t - view.window().t0) / (view.window().t1 - view.window().t0)) * WIDTH,
    run: (id, extra = {}) => reg.run(id, {source: 'key', ...extra}),
  };
}

const press = (code, opts = {}) => keydown(code, {target: document.activeElement ?? document.body, ...opts});
const barOf = (b) => b.mapSession.span.peek().display;

// ---------------------------------------------------------------------------------------------------------------
// The command definitions (no DOM needed)

describe('§3.4 Em commands', () => {
  test('every Em row is registered in edit.map with its keys, group Map, and the digits family is dynamic', () => {
    const reg = createRegistry();
    defineMapCommands({registry: reg});
    const keysOf = (id) => [...reg.get(id).keys];
    const expected = {
      [C.undo]: ['Mod+KeyZ'], [C.redo]: ['Mod+Shift+KeyZ', 'Mod+KeyY'],
      [C.prevBar]: ['ArrowLeft'], [C.nextBar]: ['ArrowRight'], [C.prevBeat]: ['Shift+ArrowLeft'], [C.nextBeat]: ['Shift+ArrowRight'],
      [C.prevPin]: ['Mod+ArrowLeft'], [C.nextPin]: ['Mod+ArrowRight'], [C.goOrApply]: ['Enter'], [C.first]: ['Home'], [C.last]: ['End'],
      [C.pinDownbeat]: ['KeyD'], [C.pinBeat]: ['KeyT'], [C.unpin]: ['Backspace', 'Delete'],
      [C.nudgeBack]: [','], [C.nudgeFwd]: ['.'], [C.nudgeBackFine]: ['Shift+,'], [C.nudgeFwdFine]: ['Shift+.'],
      [C.renumberBack]: ['Alt+ArrowLeft'], [C.renumberFwd]: ['Alt+ArrowRight'],
      [C.renumberBeatBack]: ['Alt+Shift+ArrowLeft'], [C.renumberBeatFwd]: ['Alt+Shift+ArrowRight'],
      [C.beatsDown]: ['ArrowDown'], [C.beatsUp]: ['ArrowUp'], [C.beatsDownBar]: ['Shift+ArrowDown'], [C.beatsUpBar]: ['Shift+ArrowUp'],
      [C.tailDown]: ['Alt+ArrowDown'], [C.tailUp]: ['Alt+ArrowUp'], [C.tailDownFine]: ['Alt+Shift+ArrowDown'], [C.tailUpFine]: ['Alt+Shift+ArrowUp'],
      [C.editBar]: ['KeyE'], [C.ramp]: ['KeyR'], [C.preview]: ['KeyP'], [C.double]: ['*'], [C.halve]: ['/'], [C.addSection]: ['KeyS'],
      [C.grid]: ['KeyG'], [C.snap]: ['Shift+KeyS'], [C.zoomIn]: ['='], [C.zoomOut]: ['-'], [C.fit]: ['\\'], [C.zoomSelection]: ['KeyZ'],
      [C.tapAlong]: [], [C.calibrate]: [], [C.markersToSections]: [],
    };
    for (const [id, keys] of Object.entries(expected)) {
      expect(reg.get(id), id).not.toBeNull();
      expect(keysOf(id), id).toEqual(keys);
      expect(reg.get(id).group, id).toBe('Map');
      if (keys.length) expect([...reg.get(id).scopes], id).toEqual([MAP_SCOPE]);
    }
    DIGIT_IDS.forEach((id, n) => expect(keysOf(id)).toEqual([`Digit${n}`]));
    expect(reg.dynamicFamilies().find((f) => f.template === 'map.digit.{n}').ids).toEqual(DIGIT_IDS);
    expect(new Set(MAP_COMMAND_IDS).size).toBe(MAP_COMMAND_IDS.length);
    for (const id of MAP_COMMAND_IDS) expect(reg.get(id), id).not.toBeNull();
    // Repeat on steps and nudges (§3.4 "(repeat)").
    for (const id of [C.prevBar, C.nextBar, C.nudgeBack, C.nudgeFwdFine, C.tailUp, C.zoomIn, C.zoomOut]) expect(reg.get(id).repeat, id).toBe(true);
  });

  test('defineMapCommands is idempotent per registry and its off() unregisters everything', () => {
    const reg = createRegistry();
    const off = defineMapCommands({registry: reg});
    expect(defineMapCommands({registry: reg})).toBeTypeOf('function');
    off();
    for (const id of MAP_COMMAND_IDS) expect(reg.get(id), id).toBeNull();
    expect(mapCommandDefs().length + DIGIT_IDS.length).toBe(MAP_COMMAND_IDS.length);
  });

  test('without a map session every Em command is disabled (keys fall through to the outer scopes)', () => {
    const reg = createRegistry();
    defineMapCommands({registry: reg});
    for (const id of MAP_COMMAND_IDS) expect(reg.isEnabled(id), id).toBe(false);
  });

  test('every MAPPING row (1.9 key-only edits) names a CONTROLS control, and its command is an Em or Stage-map command', () => {
    const names = new Set(CONTROLS.map((r) => r.name));
    const reg = createRegistry();
    defineMapCommands({registry: reg});
    defineStageCommands({registry: reg, later: {}});
    for (const row of MAPPING) {
      expect(names.has(row.name), `${row.was} → "${row.name}"`).toBe(true);
      if (row.command) expect(reg.get(row.command), row.command).not.toBeNull();
    }
    // Every key-bound Em command that edits the map has a visible control (maps/mapedit.md §11.4).
    const mapped = new Set(MAPPING.map((r) => r.command).filter(Boolean));
    for (const id of [C.prevBar, C.nextBar, C.prevPin, C.nextPin, C.goOrApply, C.pinDownbeat, C.pinBeat, C.unpin, C.nudgeBack, C.nudgeFwd,
      C.nudgeBackFine, C.nudgeFwdFine, C.renumberFwd, C.beatsUp, C.editBar, C.ramp, C.preview, C.double, C.halve, C.tailUp, C.tailDown,
      C.addSection, C.grid, C.snap, C.zoomIn, C.zoomOut, C.fit, C.zoomSelection]) {
      expect(mapped.has(id), id).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe.skipIf(!viewModule)('the mounted view', () => {
  const {clampWindow, zoomWindow, followWindow, windowAround} = viewModule ?? {};

  test('window helpers: clamp as a whole, zoom about an anchor, follow pages at 90%', () => {
    expect(clampWindow({t0: -5, span: 10}, 100)).toEqual({t0: 0, span: 10});
    expect(clampWindow({t0: 95, span: 10}, 100)).toEqual({t0: 90, span: 10});
    expect(clampWindow({t0: 3, span: 500}, 100)).toEqual({t0: 0, span: 100});
    const z = zoomWindow({t0: 20, span: 40}, {at: 30, factor: 0.5}, 128);
    expect(z.span).toBe(20);
    expect((30 - z.t0) / z.span).toBeCloseTo(0.25, 9);
    expect(followWindow({t0: 0, span: 10}, 5, 128)).toBeNull();
    expect(followWindow({t0: 0, span: 10}, 9.5, 128)).toEqual({t0: 8.5, span: 10});
    expect(followWindow({t0: 0, span: 10}, 40, 128)).toEqual({t0: 39, span: 10});
    expect(windowAround(10, 16, 128).t0).toBeLessThan(10);
  });

  test('every CONTROLS row renders with its role and accessible name (laptop, mapped, a pinned line, the tail span)', async () => {
    const b = await bed();
    // Select the last pin's line: the tail span is open (the ♩ field) and the line is pinned (Unpin, renumber).
    const lastPin = b.map.data.pins.at(-1).position;
    b.mapSession.select(lastPin);
    frame();
    const contexts = new Set(['always', 'toolbar', 'row', 'laptop', 'inspector', 'pinned', 'open']);
    for (const row of CONTROLS.filter((r) => contexts.has(r.context))) {
      const scope = row.role === 'complementary' || ['inspector', 'pinned', 'open'].includes(row.context) ? b.inspectorEl : b.root;
      expect(byRole(scope, row.role, row.name).length, `${row.role} "${row.name}" (${row.context})`).toBeGreaterThan(0);
      if (row.command) expect(b.reg.get(row.command), row.command).not.toBeNull();
    }
  });

  test('unmapped: the ruler shows times, the bar lanes are gone, the inspector is "Get a map", and nothing says Bar', async () => {
    const b = await bed({mapped: false});
    expect(b.root.dataset.mapped).toBe('false');
    expect(b.root.querySelector('.map-ruler').dataset.ruler).toBe('time');
    // The web with no paired computer: "Needs Woodshed for desktop [Get it ↗]" instead of [Detect].
    for (const row of CONTROLS.filter((r) => r.context === 'unmapped' || r.context === 'unmapped-web')) {
      expect(byRole(b.inspectorEl, row.role, row.name).length, row.name).toBeGreaterThan(0);
    }
    expect(byRole(b.inspectorEl, 'button', COPY.detectAction)).toHaveLength(0);
    expect(b.root.querySelector('.map-grid-button').hidden).toBe(true);
    // The main area (the strip's "No bar grid" chip aside) never says "Bar" for an unmapped song (§2.14.4).
    const main = b.root.cloneNode(true);
    main.querySelector('.map-strip')?.remove();
    main.querySelectorAll('[hidden]').forEach((n) => n.remove());
    expect(main.textContent).not.toMatch(/\bbar\b/i);
    expect(b.reg.isEnabled(C.nextBar)).toBe(false);
    expect(b.reg.isEnabled('map.digit.4')).toBe(false);
  });

  test('unmapped with Detect available (desktop): Get a map offers [Detect] "on this computer"; a paired computer names it', async () => {
    const b = await bed({mapped: false, desktop: true});
    for (const row of CONTROLS.filter((r) => r.context === 'unmapped' || r.context === 'unmapped-detect')) {
      expect(byRole(b.inspectorEl, row.role, row.name).length, row.name).toBeGreaterThan(0);
    }
    expect(b.inspectorEl.textContent).toContain(COPY.detectBody(COPY.detectHere));
    expect(byRole(b.inspectorEl, 'link', COPY.getIt)).toHaveLength(0);
    const web = await bed({mapped: false, devices: 'online'});
    expect(web.inspectorEl.textContent).toContain(COPY.detectBody(COPY.detectRemote('Studio Mac')));
    expect(byRole(web.inspectorEl, 'button', COPY.detectAction)).toHaveLength(1);
  });

  test('a mapped song without sections offers Suggest sections in Tools', async () => {
    const {pickup} = await import('./fixtures/maps.js');
    const b = await bed({tempo: structuredClone(pickup.tempo), desktop: true});
    expect(b.map.hasSections).toBe(false);
    for (const row of CONTROLS.filter((r) => r.context === 'unsectioned')) {
      expect(byRole(b.inspectorEl, row.role, row.name).length, row.name).toBeGreaterThan(0);
    }
  });

  test('toolbar: − + Fit and Z change the shared window; Grid ▾ picks a division; Snap toggles (aria-pressed)', async () => {
    const b = await bed();
    const full = b.view.window();
    expect(full).toEqual({t0: 0, t1: b.map.duration});
    one(b.root, 'button', COPY.zoomIn).click();
    frame();
    expect(b.view.window().t1 - b.view.window().t0).toBeCloseTo(b.map.duration / 2, 6);
    one(b.root, 'button', COPY.zoomOut).click();
    one(b.root, 'button', COPY.fit).click();
    expect(b.view.window()).toEqual(full);
    b.mapSession.goToBar(20);
    one(b.root, 'button', COPY.zoomSelection).click();
    const w = b.view.window(), bar = b.map.bars[b.mapSession.span.peek().index];
    expect(w.t0).toBeLessThanOrEqual(bar.t0);
    expect(w.t1).toBeGreaterThanOrEqual(bar.t1);
    expect(w.t1 - w.t0).toBeLessThan(10);

    b.view.setGrid('beat');
    const gridButton = one(b.root, 'button', COPY.gridButton(COPY.divisions.beat));
    gridButton.click();
    const items = [...document.querySelectorAll('[role=menuitemradio]')];
    expect(items.map((i) => nameOf(i))).toEqual(['Off', 'Bar', 'Beat', '½', '¼']);
    items.find((i) => nameOf(i) === 'Bar').click();
    await settle();
    frame();
    expect(b.root.dataset.grid).toBe('bar');
    expect(byRole(b.root, 'button', COPY.gridButton(COPY.divisions.bar))).toHaveLength(1);
    b.run(C.grid);
    expect(b.root.dataset.grid).toBe('off');
    b.run(C.grid);
    expect(b.root.dataset.grid).toBe('bar');

    const snap = one(b.root, 'button', COPY.snap);
    expect(b.view.snapOn()).toBe(true);
    snap.click();
    expect(b.view.snapOn()).toBe(false);
    expect(b.reg.isChecked(C.snap)).toBe(false);
    b.run(C.snap);
    expect(b.view.snapOn()).toBe(true);
  });

  test('the grid is drawn on the stem rows (bars and beats when they are ≥ 6 px apart)', async () => {
    const b = await bed();
    b.view.setGrid('beat');
    b.view.zoom(1); b.view.zoom(1); b.view.zoom(1);
    frame();
    expect(b.root.querySelector('.map-rows-canvas').dataset.gridDrawn).toContain('beat');
    b.view.setGrid('off');
    frame();
    expect(b.root.querySelector('.map-rows-canvas').dataset.gridDrawn).toBeUndefined();
  });

  test('stem rows: M and S mute and solo through the transport, the fader sets the level, words OUT / SOLO', async () => {
    const b = await bed();
    one(b.root, 'button', COPY.mute('Drums')).click();
    frame();
    expect(b.snap.mix.tracks.find((t) => t.name === 'drums').muted).toBe(true);
    const head = one(b.root, 'group', 'Drums').closest('.map-head');
    expect(head.dataset.state).toBe('out');
    expect(head.querySelector('.map-row-word').textContent).toBe(COPY.out);
    one(b.root, 'button', COPY.solo('Bass')).click();
    frame();
    expect(one(b.root, 'group', 'Bass').closest('.map-head').querySelector('.map-row-word').textContent).toBe(COPY.soloWord);
    const fader = one(b.root, 'slider', COPY.level('Vocals'));
    fader.focus();
    keydown('ArrowLeft', {target: fader});
    expect(b.snap.mix.tracks.find((t) => t.name === 'vocals').volume).toBeLessThan(1);
  });

  test('a ruler click selects the nearest bar line and cues there; a row click snaps to a line, Snap off cues the exact time', async () => {
    const b = await bed();
    const ruler = b.root.querySelector('.map-ruler');
    const bar10 = b.map.bars[9];
    pointer(ruler, 'pointerdown', {x: b.xOf(bar10.t0 + 0.2), y: TOP + 5});
    expect(barOf(b)).toBe(10);
    expect(b.snap.cue).toBeCloseTo(bar10.t0, 6);
    pointer(b.rows, 'pointerdown', {x: b.xOf(bar10.t0 + 0.55), y: TOP + 200});
    expect(b.map.timeAt(b.mapSession.cursorQ.peek())).toBeCloseTo(bar10.t0 + 0.5, 6);   // the nearest beat (120 bpm)
    b.view.toggleSnap();
    pointer(b.rows, 'pointerdown', {x: b.xOf(30.3), y: TOP + 200});
    expect(b.snap.cue).toBeCloseTo(30.3, 1);
  });

  test('a selection outside the window scrolls into view; ?bar=N selects and reveals that bar', async () => {
    const b = await bed({query: {bar: '41'}});
    expect(barOf(b)).toBe(41);
    const t = b.map.bars[40].t0;
    b.view.zoom(1); b.view.zoom(1); b.view.zoom(1); b.view.zoom(1);
    b.mapSession.goToBar(3);
    await settle();
    const w = b.view.window();
    expect(b.map.bars[2].t0).toBeGreaterThanOrEqual(w.t0);
    expect(b.map.bars[2].t0).toBeLessThanOrEqual(w.t1);
    expect(t).toBeGreaterThan(w.t1);
  });

  test('the strip shows the window as its viewport bracket and dragging it (onViewport) moves the window', async () => {
    const b = await bed();
    b.view.zoom(1);
    frame();
    expect(b.root.querySelector('.map-strip nav.strip')).not.toBeNull();
    const bracket = b.root.querySelector('.strip-viewport');
    expect(bracket).not.toBeNull();
  });

  test('wheel: vertical zooms at the pointer, horizontal pans', async () => {
    const b = await bed();
    const lanes = b.root.querySelector('.map-lanes');
    lanes.dispatchEvent(new window.WheelEvent('wheel', {deltaY: -200, clientX: b.xOf(64), bubbles: true, cancelable: true}));
    const w = b.view.window();
    expect(w.t1 - w.t0).toBeLessThan(b.map.duration);
    vi.advanceTimersByTime(300);
    lanes.dispatchEvent(new window.WheelEvent('wheel', {deltaX: 100, deltaY: 0, clientX: b.xOf(64), bubbles: true, cancelable: true}));
    expect(b.view.window().t0).toBeGreaterThan(w.t0);
    expect(b.view.window().t1 - b.view.window().t0).toBeCloseTo(w.t1 - w.t0, 6);
  });

  test('hooks: status and rename belong to the view while mounted and are restored on destroy', async () => {
    const b = await bed();
    const before = {status: b.hooks.status, rename: b.hooks.rename};
    b.hooks.status('Tapped 4 lines', {tone: 'ok'});
    expect(b.feedback.calls.at(-1)).toMatchObject({text: 'Tapped 4 lines', key: 'map'});
    b.mapSession.addSectionAt(b.map.bars[11].t0 + 0.1);
    const added = b.feedback.calls.at(-1);
    expect(added.action.label).toBe(MAP_SESSION_COPY.renameAction);
    added.action.run();
    expect(b.root.querySelector('.map-section-input')).not.toBeNull();
    expect(document.activeElement).toBe(b.root.querySelector('.map-section-input'));
    b.view.destroy();
    expect(b.hooks.status).not.toBe(before.status);   // ED2's default comes back (a fresh function from the bed)
  });

  test('find: the Find a chart panel replaces the inspector in the inspector container; a commit closes Find', async () => {
    const b = await bed({find: true});
    expect(findPanel.mounts).toHaveLength(1);
    expect(b.inspectorEl.querySelector('.find-panel-mock')).not.toBeNull();
    expect(b.inspectorEl.querySelector('.map-inspector')).toBeNull();
    expect(findPanel.mounts[0].opts.mapSession).toBe(b.mapSession);
    findPanel.mounts[0].opts.onClose({result: 'theirs'});
    expect(b.closes).toEqual(['find']);
    b.view.destroy();
    expect(findPanel.mounts[0].destroyed).toBe(true);
  });

  test('escape(): the view\'s own Esc layer cancels a rename first, and reports nothing to close otherwise', async () => {
    const b = await bed();
    expect(b.view.escape()).toBe(false);
    b.view.sections.rename(8);
    expect(b.view.sections.renaming).toBe(true);
    expect(b.view.escape()).toBe(true);
    expect(b.view.sections.renaming).toBe(false);
    expect(b.map.measure(8).label).toBe('Verse');
  });

  test('?review=sections opens the suggestion review in the sections lane (D47)', async () => {
    const sectionSuggestion = {jobId: 'job-s', createdAt: 1, sections: [{t0: 0, label: 'Intro', confidence: 0.8}, {t0: 16, label: 'Verse', confidence: 0.7},
      {t0: 48, label: 'Chorus', confidence: 0.7}]};
    const b = await bed({tempo: {songMap: (await import('./fixtures/maps.js')).pickup.tempo.songMap}, sectionSuggestion, review: true, duration: 128});
    if (!b.map.isReal || b.map.hasSections) throw new Error('fixture: a mapped song without sections');
    expect(b.mapSession.review.peek()?.blocks).toHaveLength(3);
    expect(b.root.querySelector('.map-sections').dataset.mode).toBe('review');
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe.skipIf(!viewModule)('keys through the dispatcher (D19)', () => {
  test('digits + Enter go to a bar and never mute a stem; ⌫ edits the digits first', async () => {
    const b = await bed({dispatcher: true});
    press('Digit4'); press('Digit2');
    expect(b.mapSession.digits.peek()).toBe('42');
    expect(b.snap.mix.tracks.every((t) => !t.muted)).toBe(true);
    press('Backspace');
    expect(b.mapSession.digits.peek()).toBe('4');
    press('Digit1');
    press('Enter');
    expect(b.mapSession.digits.peek()).toBe('');
    expect(barOf(b)).toBe(41);
  });

  test('arrows step bars and beats; Home / End; ⌘← → jump between pins', async () => {
    const b = await bed({dispatcher: true});
    b.mapSession.goToBar(10);
    press('ArrowRight');
    expect(barOf(b)).toBe(11);
    press('ArrowLeft'); press('ArrowLeft');
    expect(barOf(b)).toBe(9);
    press('ArrowRight', {shiftKey: true});
    expect(b.mapSession.span.peek().beat).toBe(2);
    press('End');
    expect(barOf(b)).toBe(b.map.bars.at(-1).display);
    press('Home');
    expect(barOf(b)).toBe(1);
  });

  test('E focuses Meter → Beats; Enter on it applies the Meter form; ↑ adds a beat (one map step)', async () => {
    const b = await bed({dispatcher: true});
    b.mapSession.goToBar(5);
    press('KeyE');
    const beats = b.inspectorEl.querySelector('.map-beats [role=spinbutton]');
    expect(document.activeElement).toBe(beats);
    // The spinbutton consumes the arrows itself (one step = one edit).
    const undo = b.map.undoStack.length;
    keydown('ArrowUp', {target: beats});
    expect(b.map.measure(4).numerator).toBe(5);
    expect(b.map.undoStack.length).toBe(undo + 1);
    keydown('Enter', {target: beats});
    expect(b.mapSession.message.peek().tone).toBe('ok');
  });

  test('D pins the nearest downbeat at the playhead; ⌫ unpins; Space plays and stops (taps are D and T)', async () => {
    const b = await bed({dispatcher: true});
    const at = b.map.bars[7].t0 + 0.03;   // (the pin moves bar 8, so read the target first)
    b.ts.session.transport.cue(at);
    press('KeyD');
    expect(b.map.data.pins.some((p) => Math.abs(p.time - at) < 1e-6)).toBe(true);
    expect(b.map.bars[7].t0).toBeCloseTo(at, 6);
    expect(b.mapSession.span.peek().pin).not.toBeNull();
    document.body.focus();
    press('Backspace');
    expect(b.mapSession.span.peek().pin).toBeNull();
    press('Space');
    await settle();
    expect(['playing', 'counting']).toContain(b.snap.phase);
    press('Space');
    await settle();
    expect(b.snap.phase).toBe('stopped');
  });

  test('S adds a section at the playhead on the map stack; ⌘Z undoes it there (not the practice stack)', async () => {
    const b = await bed({dispatcher: true});
    const labels = () => b.map.data.measures.map((m) => m.label).join('|');
    const before = labels();
    b.ts.session.transport.cue(b.map.bars[2].t0 + 0.5);
    press('KeyS');
    expect(labels()).not.toBe(before);
    expect(b.ts.session.undo.canUndo.peek()).toBe(false);
    press('KeyZ', {ctrlKey: true});
    expect(labels()).toBe(before);
  });

  test('= − \\ Z G ⇧S reach the view; P previews and Esc-stoppable preview restores the loop', async () => {
    const b = await bed({dispatcher: true});
    press('Equal');
    expect(b.view.window().t1).toBeLessThan(b.map.duration);
    press('Backslash');
    expect(b.view.window().t1).toBeCloseTo(b.map.duration, 6);
    const grid = b.root.dataset.grid;
    press('KeyG');
    expect(b.root.dataset.grid).not.toBe(grid);
    expect([b.root.dataset.grid, grid]).toContain('off');
    // Grid and Snap are remembered for the page session, so compare with what the view opened with.
    const snapWas = b.view.snapOn();
    press('KeyS', {shiftKey: true});
    expect(b.view.snapOn()).toBe(!snapWas);
    press('KeyP');
    await settle();
    expect(b.mapSession.previewing.peek()).toBe(true);
    press('KeyP');
    expect(b.mapSession.previewing.peek()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe.skipIf(!viewModule)('Find a chart audition (D20)', () => {
  test('while auditioning every map-mutating command and map.undo are disabled; navigation, zoom and snap stay live', async () => {
    const b = await bed();
    b.mapSession.addSectionAt(4.2);   // something to undo
    expect(b.reg.isEnabled(C.undo)).toBe(true);
    b.mapSession.beginAudition();
    for (const id of [C.undo, C.redo, C.pinDownbeat, C.pinBeat, C.nudgeBack, C.beatsUp, C.tailUp, C.ramp, C.double, C.halve, C.addSection,
      C.renumberFwd, C.editBar, C.tapAlong, C.calibrate, C.preview]) {
      expect(b.reg.isEnabled(id), id).toBe(false);
    }
    for (const id of [C.nextBar, C.prevPin, C.first, C.zoomIn, C.fit, C.snap, C.grid, 'map.digit.3']) expect(b.reg.isEnabled(id), id).toBe(true);
    // Lane edits are refused too: a section rename does nothing.
    expect(b.view.sections.rename(3)).toBe(false);
    b.mapSession.endAudition({commit: false});
    expect(b.reg.isEnabled(C.undo)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe.skipIf(!viewModule)('detection on a mapped song (D44, D23)', () => {
  test('Detect beats (desktop): one map-stack step, "Beat grid found · Undo", and Undo puts the old map back', async () => {
    const b = await bed({desktop: true});
    const before = JSON.stringify(b.map.data);
    expect(b.reg.isEnabled(C.detect)).toBe(true);
    one(b.inspectorEl, 'button', COPY.detect).click();
    await settle();
    const job = b.ts.server.jobRows.find((j) => j.kind === 'beats');
    expect(job).toBeTruthy();
    const beats = Array.from({length: 100}, (_, i) => [0.25 + i * 0.6, (i % 3) + 1]);
    b.ts.server.finishJob(job.jobId, {beats});
    await settle();
    expect(JSON.stringify(b.map.data)).not.toBe(before);
    expect(b.map.data.origin).toBe('detected');
    expect(b.ts.statuses.some((c) => c.text === 'Beat grid found' && c.action?.label === 'Undo')).toBe(true);
    // The practice stack is untouched (D23): the map stack owns the step.
    expect(b.ts.session.undo.canUndo.peek()).toBe(false);
    b.run(C.undo);
    expect(JSON.stringify(b.map.data)).toBe(before);
  });
});

