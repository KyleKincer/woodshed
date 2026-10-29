// @vitest-environment happy-dom
// The Edit frame (src/edit/{edit,slim-transport,commands}.js; architecture §2.15, §3.4, §9.14 ED2;
// spec §5.0, wireframe §10.10): the shared Edit commands (Done and the layered Esc, the posture
// tabs, app.undo / app.redo routed per posture), the entry origin Done goes back to, the slim
// transport, and the mounted frame on a real song session (tests/helpers/test-session.js): the
// posture bar (Done, title, label, tabs with replace, Undo / Redo per tab, the save status slot),
// the inspector container (laptop 320 px column; iPad portrait 45% sheet collapsing to 56 px, the
// landscape hint), key-cap hints after keyboard use on fine pointers, the providers, the shared
// session (playback continues across Stage ↔ Edit), session.mapEditor, the per-session platform
// services, and the bulk Details posture bar. Sizes and the app theme's computed colours are
// Playwright probes (tests/fixture/states/ED2.cjs).
//
// edit.js imports its tab views by contract path: ED3's map/view.js, ED5's chart/chart-edit.js and
// ED6's details/details.js (same-wave peers, §9.0). They are mocked here; the suites that import
// edit.js are skipped until the three files exist and run at integration I3a.
import {existsSync} from 'node:fs';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest';

const hoisted = vi.hoisted(() => ({maps: [], charts: [], details: [], fail: {}, fillChartInspector: false}));
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));
vi.mock('../src/edit/map/view.js', () => ({
  mountMapView: (el, opts) => {
    if (hoisted.fail.map) throw hoisted.fail.map;
    const lanes = document.createElement('div');
    lanes.className = 'test-map-lanes';
    lanes.textContent = 'lanes';
    el.append(lanes);
    const inspector = document.createElement('div');
    inspector.className = 'test-map-inspector';
    inspector.textContent = 'inspector';
    opts.inspectorEl?.append(inspector);
    const v = {el, opts, destroy: vi.fn(() => { lanes.remove(); inspector.remove(); })};
    hoisted.maps.push(v);
    return v;
  },
}));
vi.mock('../src/edit/chart/chart-edit.js', () => ({
  mount: (el, opts) => {
    const score = document.createElement('div');
    score.className = 'test-chart';
    el.append(score);
    let panel = null;
    if (hoisted.fillChartInspector) {
      panel = document.createElement('div');
      panel.className = 'test-chart-inspector';
      opts.inspectorEl?.append(panel);
    }
    const v = {el, opts, destroy: vi.fn(() => { score.remove(); panel?.remove(); })};
    hoisted.charts.push(v);
    return v;
  },
}));
vi.mock('../src/edit/details/details.js', () => ({
  mount: (el, match, ctx) => {
    const page = document.createElement('div');
    page.className = 'test-details';
    el.append(page);
    const v = {el, match, ctx, update: vi.fn(), unmount: vi.fn(() => page.remove())};
    hoisted.details.push(v);
    return v;
  },
}));

import {createRegistry} from '../src/app/commands.js';
import {clock as appClock} from '../src/app/clock.js';
import {signal, store} from '../src/app/store.js';
import {prefs} from '../src/app/prefs.js';
import * as feedback from '../src/app/feedback.js';
import {defineTransportCommands} from '../src/stage/transport-commands.js';
import {
  COMMAND_COPY, EDIT_COMMAND_IDS, EDIT_TABS, UNDO_COMMANDS, armEditOrigin, cameFromStage, defineEditCommands, isTextField,
  noteNavigation, resetEditOrigin, tabOf, undoTarget,
} from '../src/edit/commands.js';
import {mountSlimTransport} from '../src/edit/slim-transport.js';
import {closeSheets} from '../src/stage/sheets/host.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {installPopoverShim, keydown, restoreDomShims} from './helpers/dom.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const E = 'edit';

let clock, restoreAudio;
const cleanups = [];

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(Date.parse('2026-10-28T12:00:00Z'));
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
  installPopoverShim();
  feedback.resetFeedback();
  resetEditOrigin();
  prefs.update((d) => { d.edit.lastTab = 'map'; });
  store.stage.value = null;
  hoisted.maps.length = 0;
  hoisted.charts.length = 0;
  hoisted.details.length = 0;
  hoisted.fail = {};
  hoisted.fillChartInspector = false;
  document.documentElement.dataset.posture = 'edit';
  document.documentElement.dataset.place = 'edit';
});

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  closeSheets();
  feedback.resetFeedback();
  document.body.replaceChildren();
  for (const k of ['place', 'posture', 'transportPhase']) delete document.documentElement.dataset[k];
  restoreDomShims();
  restoreAudio();
  vi.useRealTimers();
});

async function session(options = {}) {
  const ts = await createTestSession({clock, status: (text, opts) => feedback.status(text, opts), ...options});
  cleanups.push(() => ts.dispose());
  return ts;
}

/** The accessible name of a control (aria-label, else its text). */
function nameOf(el) {
  const label = el.getAttribute('aria-label');
  if (label) return label.trim();
  const text = el.querySelector?.('.ui-button-label') ?? el.querySelector?.('.ui-tab-label');
  return (text ?? el).textContent.replace(/\s+/g, ' ').trim();
}
const ROLE_SELECTOR = {button: 'button, [role=button]', tab: '[role=tab]', tablist: '[role=tablist]', toolbar: '[role=toolbar]', heading: 'h1'};
const byRole = (root, role, name) => [...root.querySelectorAll(ROLE_SELECTOR[role])].find((el) => !el.closest('[hidden]') && nameOf(el) === name) ?? null;
const allByRole = (root, role, name) => [...root.querySelectorAll(ROLE_SELECTOR[role])].filter((el) => nameOf(el) === name);

// =====================================================================================================
// commands (src/edit/commands.js)

describe('the shared Edit commands (§3.4)', () => {
  /** [id, title, group, keys, scopes]. */
  const ROWS = [
    ['edit.done', 'Done', 'Edit', ['Escape'], [E]],
    ['edit.tab.map', 'Map', 'Edit', [], [E]],
    ['edit.tab.chart', 'Chart', 'Edit', [], [E]],
    ['edit.tab.details', 'Details', 'Edit', [], [E]],
    ['app.undo', 'Undo', 'App', [], []],
    ['app.redo', 'Redo', 'App', [], []],
  ];

  function bed() {
    const registry = createRegistry();
    const off = defineEditCommands({registry});
    cleanups.push(off);
    return registry;
  }

  test.each(ROWS)('%s: title, group, keys and scopes', (id, title, group, keys, scopes) => {
    const def = bed().get(id);
    expect(def).toBeTruthy();
    expect(def.title).toBe(title);
    expect(def.group).toBe(group);
    expect([...def.keys]).toEqual(keys);
    expect([...def.scopes]).toEqual(scopes);
  });

  test('EDIT_COMMAND_IDS lists exactly what defineEditCommands registers; off() removes them', () => {
    const registry = createRegistry();
    const off = defineEditCommands({registry});
    expect(EDIT_COMMAND_IDS).toEqual(ROWS.map((r) => r[0]));
    expect(registry.all().map((d) => d.id).sort()).toEqual([...EDIT_COMMAND_IDS].sort());
    off();
    expect(registry.all()).toHaveLength(0);
  });

  test('app.undo and app.redo are the Electron Edit menu items and stay out of the palette', () => {
    const registry = bed();
    for (const id of ['app.undo', 'app.redo']) {
      expect(registry.get(id).menu.electron).toBe('Edit');
      expect(registry.get(id).palette.hidden).toBe(true);
    }
  });

  test('every command needs the \'edit\' context; the tabs need setTab and are checked on the open tab', () => {
    const registry = bed();
    expect(registry.isEnabled('edit.done')).toBe(false);
    for (const t of EDIT_TABS) expect(registry.isEnabled(`edit.tab.${t}`)).toBe(false);
    const api = {tab: 'chart', tabs: EDIT_TABS, setTab: vi.fn(), done: vi.fn(), escape: vi.fn()};
    registry.provide('edit', () => api);
    expect(registry.isEnabled('edit.done')).toBe(true);
    expect(registry.state('edit.tab.chart').checked).toBe(true);
    expect(registry.state('edit.tab.map').checked).toBe(false);
    expect(registry.run('edit.tab.details')).toBe(true);
    expect(api.setTab).toHaveBeenCalledWith('details');
    // The bulk posture has no tabs.
    const bulk = {tab: 'details', tabs: [], bulk: true, done: vi.fn(), escape: vi.fn()};
    registry.provide('edit', () => bulk);
    for (const t of EDIT_TABS) expect(registry.isEnabled(`edit.tab.${t}`)).toBe(false);
    expect(registry.isEnabled('edit.done')).toBe(true);
  });

  test('Esc runs the layered escape(); Done from a button or the palette is Done at once', () => {
    const registry = bed();
    const api = {tab: 'map', tabs: EDIT_TABS, setTab: vi.fn(), done: vi.fn(), escape: vi.fn()};
    registry.provide('edit', () => api);
    registry.run('edit.done', {source: 'key'});
    expect(api.escape).toHaveBeenCalledTimes(1);
    expect(api.done).not.toHaveBeenCalled();
    registry.run('edit.done', {source: 'pointer'});
    registry.run('edit.done', {source: 'palette'});
    expect(api.done).toHaveBeenCalledTimes(2);
    expect(api.escape).toHaveBeenCalledTimes(1);
  });

  test('undoTarget routes per posture: the Stage → practice.undo, Map → map.undo, Chart → chart.undo, Details → none', () => {
    expect(undoTarget({posture: 'stage'}, 'undo')).toBe('practice.undo');
    expect(undoTarget({posture: 'stage'}, 'redo')).toBe('practice.redo');
    expect(undoTarget({posture: 'edit', edit: {tab: 'map'}}, 'undo')).toBe('map.undo');
    expect(undoTarget({posture: 'edit', edit: {tab: 'map'}}, 'redo')).toBe('map.redo');
    expect(undoTarget({posture: 'edit', edit: {tab: 'chart'}}, 'undo')).toBe('chart.undo');
    expect(undoTarget({posture: 'edit', edit: {tab: 'chart'}}, 'redo')).toBe('chart.redo');
    expect(undoTarget({posture: 'edit', edit: {tab: 'details'}}, 'undo')).toBeNull();
    // Without the 'edit' context the route decides (bulk Details is Details).
    expect(undoTarget({posture: 'edit', route: {params: {tab: 'chart'}}}, 'undo')).toBe('chart.undo');
    expect(undoTarget({posture: 'edit', route: {name: 'bulkDetails', params: {}}}, 'undo')).toBeNull();
    expect(undoTarget({posture: null}, 'undo')).toBeNull();
    expect(tabOf({edit: {tab: 'nonsense'}})).toBeNull();
    expect(UNDO_COMMANDS.details).toBeNull();
  });

  test('app.undo runs the posture\'s command, enabled only while that command is', () => {
    const registry = bed();
    const runs = [];
    let canUndo = false;
    registry.register({id: 'map.undo', title: 'Undo map edit', group: 'Map', when: () => canUndo, run: () => runs.push('map.undo')});
    registry.register({id: 'practice.undo', title: 'Undo', group: 'Practice', run: () => runs.push('practice.undo')});
    registry.provide('posture', () => 'edit');
    registry.provide('edit', () => ({tab: 'map', tabs: EDIT_TABS, done() {}, setTab() {}}));
    expect(registry.isEnabled('app.undo')).toBe(false);
    canUndo = true;
    expect(registry.isEnabled('app.undo')).toBe(true);
    expect(registry.run('app.undo', {source: 'menu'})).toBe(true);
    expect(runs).toEqual(['map.undo']);
    const off = registry.provide('posture', () => 'stage');
    registry.run('app.undo', {source: 'menu'});
    expect(runs).toEqual(['map.undo', 'practice.undo']);
    off();
    registry.provide('edit', () => ({tab: 'details', tabs: EDIT_TABS, done() {}, setTab() {}}));
    expect(registry.isEnabled('app.undo')).toBe(false);
  });

  test('a focused text field takes app.undo / app.redo through document.execCommand', () => {
    const doc = {activeElement: document.createElement('textarea'), execCommand: vi.fn()};
    const registry = createRegistry();
    cleanups.push(defineEditCommands({registry, document: doc}));
    const runs = [];
    registry.register({id: 'chart.undo', title: 'Undo notation', group: 'Chart', run: () => runs.push('chart.undo')});
    registry.provide('posture', () => 'edit');
    registry.provide('edit', () => ({tab: 'chart', tabs: EDIT_TABS, done() {}, setTab() {}}));
    expect(registry.run('app.undo', {source: 'menu'})).toBe(true);
    expect(registry.run('app.redo', {source: 'menu'})).toBe(true);
    expect(doc.execCommand.mock.calls).toEqual([['undo'], ['redo']]);
    expect(runs).toEqual([]);
    // In the Library (no stack) the field still gets it.
    registry.provide('posture', () => 'library');
    expect(registry.isEnabled('app.undo')).toBe(true);
    doc.activeElement = document.createElement('button');
    expect(registry.isEnabled('app.undo')).toBe(false);
  });

  test('isTextField: inputs that take text, textareas, selects, contenteditable and [data-text-input]', () => {
    const make = (tag, attrs = {}) => Object.assign(document.createElement(tag), attrs);
    expect(isTextField(make('input'))).toBe(true);
    expect(isTextField(make('input', {type: 'search'}))).toBe(true);
    expect(isTextField(make('input', {type: 'checkbox'}))).toBe(false);
    expect(isTextField(make('input', {type: 'range'}))).toBe(false);
    expect(isTextField(make('textarea'))).toBe(true);
    expect(isTextField(make('select'))).toBe(true);
    const editable = make('div');
    editable.setAttribute('contenteditable', 'true');
    expect(isTextField(editable)).toBe(true);
    const widget = make('div');
    widget.setAttribute('data-text-input', '');
    const inner = widget.appendChild(make('span'));
    expect(isTextField(inner)).toBe(true);
    expect(isTextField(make('button'))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });

  describe('the entry origin (Done goes back only to this song\'s Stage)', () => {
    const at = (name, songId, extra = {}) => ({name, params: songId ? {songId, ...extra} : {...extra}, path: name});

    test('Stage → Edit is from the Stage; Library → Edit and a deep link are not', () => {
      noteNavigation(at('stage', 'a'), at('edit', 'a', {tab: 'map'}));
      expect(cameFromStage('a')).toBe(true);
      expect(cameFromStage('b')).toBe(false);
      noteNavigation(at('library'), at('edit', 'b', {tab: 'details'}));
      expect(cameFromStage('b')).toBe(false);
      resetEditOrigin();
      expect(cameFromStage('a')).toBe(false);
      // Another song's Stage is not this song's.
      noteNavigation(at('stage', 'x'), at('edit', 'a', {tab: 'map'}));
      expect(cameFromStage('a')).toBe(false);
    });

    test('tab switches and Find keep the origin of the Edit entry; leaving Edit does not change it', () => {
      noteNavigation(at('stage', 'a'), at('edit', 'a', {tab: 'map'}));
      noteNavigation(at('edit', 'a', {tab: 'map'}), at('edit', 'a', {tab: 'chart'}));
      noteNavigation(at('edit', 'a', {tab: 'chart'}), at('editFind', 'a', {tab: 'map', find: true}));
      noteNavigation(at('editFind', 'a'), at('edit', 'a', {tab: 'map'}));
      expect(cameFromStage('a')).toBe(true);
      noteNavigation(at('edit', 'a'), at('stage', 'a'));
      noteNavigation(at('edit', 'a'), null);   // pagehide
      expect(cameFromStage('a')).toBe(true);
    });

    test('armEditOrigin follows router.onLeave once per router', () => {
      const hooks = [];
      const router = {onLeave: vi.fn((fn) => { hooks.push(fn); return () => {}; })};
      expect(armEditOrigin(router)).toBe(true);
      expect(armEditOrigin(router)).toBe(true);
      expect(router.onLeave).toHaveBeenCalledTimes(1);
      hooks[0](at('stage', 's1'), at('edit', 's1', {tab: 'chart'}));
      expect(cameFromStage('s1')).toBe(true);
      expect(armEditOrigin(null)).toBe(false);
    });

    test('defineEditCommands arms itself once the registry\'s context has a router', () => {
      const registry = createRegistry();
      cleanups.push(defineEditCommands({registry}));
      const hooks = [];
      const router = {onLeave: vi.fn((fn) => { hooks.push(fn); return () => {}; })};
      registry.provide('router', () => router);
      registry.register({id: 'test.ping', title: 'Ping', group: 'App', run() {}});
      expect(router.onLeave).toHaveBeenCalledTimes(1);
      hooks[0](at('stage', 's2'), at('edit', 's2', {tab: 'map'}));
      expect(cameFromStage('s2')).toBe(true);
    });
  });
});

// =====================================================================================================
// the slim transport (src/edit/slim-transport.js)

describe('the slim transport', () => {
  async function slimBed(options = {}) {
    const ts = await session(options);
    const registry = createRegistry();
    const opened = [];
    const host = {openSheet: vi.fn((name, opts) => { opened.push({name, ...opts}); return {name, close() {}, open: true}; })};
    cleanups.push(defineTransportCommands({registry, sheets: {'./sheets/host.js': async () => host}}));
    registry.provide('session', () => ts.session);
    registry.provide('transport', () => ts.session.transport);
    const el = document.body.appendChild(document.createElement('div'));
    const slim = mountSlimTransport(el, {session: ts.session, registry});
    cleanups.push(() => slim.destroy());
    vi.advanceTimersByTime(60);
    return {ts, registry, el, slim, opened, host};
  }

  test('the Stage\'s control set in its \'slim\' variant: one "Transport" toolbar with ⟲ ▶ ‖, position, loop, speed, count-in, click and Mix', async () => {
    const b = await slimBed();
    const bar = b.el.querySelector('.edit-slim');
    expect(bar).toBeTruthy();
    expect(bar.hasAttribute('data-edit-transport')).toBe(true);
    const toolbars = b.el.querySelectorAll('[role=toolbar]');
    expect(toolbars).toHaveLength(1);
    expect(toolbars[0].getAttribute('aria-label')).toBe('Transport');
    expect(toolbars[0].dataset.variant).toBe('slim');
    const order = [...toolbars[0].querySelectorAll('[data-ctl]')].map((c) => c.dataset.ctl);
    expect(order).toEqual(['again', 'play', 'pause', 'position', 'loop', 'speed', 'countIn', 'click', 'mix']);
    for (const name of ['Again', 'Pause']) expect(byRole(b.el, 'button', name), name).toBeTruthy();
  });

  test('the chips open the same Stage sheets, as bottom sheets through the sheets host (no \'stage\' context in Edit)', async () => {
    const b = await slimBed({practice: {v: 2, cue: 32, rate: 0.75, loop: {on: false, a: 0, b: 0}, tracks: [], minusMe: false, trainer: null, spots: [], markers: []}});
    byRole(b.el, 'button', 'Speed 75%').click();
    await settle();
    expect(b.opened.map((o) => o.name)).toEqual(['speed']);
    expect(b.opened[0].session).toBe(b.ts.session);
    expect(b.opened[0].anchor ?? null).toBeNull();
  });

  test('the controls run the same registry commands as the Stage', async () => {
    const b = await slimBed();
    const runs = [];
    const run = b.registry.run;
    b.registry.run = (id, opts) => { runs.push(id); return run(id, opts); };
    byRole(b.el, 'button', 'Again').click();
    byRole(b.el, 'button', 'Pause').click();
    expect(runs).toEqual(['transport.again', 'transport.pause']);
  });

  test('destroy removes the row; mounting needs a host and a session', async () => {
    const b = await slimBed();
    b.slim.destroy();
    expect(b.el.children).toHaveLength(0);
    b.slim.destroy();   // idempotent
    expect(() => mountSlimTransport(null, {session: b.ts.session})).toThrow(TypeError);
    expect(() => mountSlimTransport(b.el, {})).toThrow(TypeError);
  });
});

// =====================================================================================================
// the stylesheets (computed sizes are probes; these pin the contract values in the source)

describe('the frame\'s stylesheets', () => {
  const css = (p) => readFileSync(join(ROOT, p), 'utf8');

  test('frame.css: 48 px posture bar with a 2 px --edit top border; 320 px inspector; 45% portrait sheet with a 56 px header; app tokens only', () => {
    const s = css('src/styles/views/edit/frame.css');
    expect(s).toMatch(/@layer views/);
    expect(s).toMatch(/\.edit-bar \{[^}]*block-size: 48px;[^}]*border-block-start: 2px solid var\(--edit\);/s);
    expect(s).toMatch(/grid-template-columns: minmax\(0, 1fr\) 320px;/);
    expect(s).toMatch(/\[data-inspector=open\] \.edit-body \{[^}]*grid-template-rows: minmax\(0, 55fr\) minmax\(0, 45fr\);/s);
    expect(s).toMatch(/\[data-inspector=collapsed\] \.edit-body \{[^}]*grid-template-rows: minmax\(0, 1fr\) 56px;/s);
    expect(s).toMatch(/\.edit-inspector-head \{[^}]*block-size: 56px;/s);
    // No colour literals and nothing scoped to the Stage's theme (Edit follows the app theme).
    expect(s).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(s).not.toMatch(/data-stage-theme|data-place=stage/);
  });

  test('slim-transport.css: one 56 px row', () => {
    const s = css('src/styles/views/edit/slim-transport.css');
    expect(s).toMatch(/@layer views/);
    expect(s).toMatch(/\.edit-slim \{[^}]*block-size: 56px;/s);
    expect(s).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});

// =====================================================================================================
// the mounted frame (needs the tab views on disk; mocked above)

const PEERS = ['src/edit/map/view.js', 'src/edit/chart/chart-edit.js', 'src/edit/details/details.js'];
const missingPeers = PEERS.filter((p) => !existsSync(join(ROOT, p)));

describe.skipIf(missingPeers.length)('the mounted Edit frame', () => {
  let edit;
  beforeAll(async () => { edit = await import('../src/edit/edit.js'); });

  function setViewport(width, height) {
    Object.defineProperty(window, 'innerWidth', {value: width, configurable: true, writable: true});
    Object.defineProperty(window, 'innerHeight', {value: height, configurable: true, writable: true});
  }

  function fakeRouter() {
    const hooks = new Set();
    return {
      calls: [],
      hooks,
      navigate: vi.fn(async function navigate(to, opts) { this.calls.push(['navigate', to, opts ?? null]); }),
      back: vi.fn(async function back(opts) { this.calls.push(['back', opts ?? null]); }),
      setQuery: vi.fn(),
      onLeave: vi.fn((fn) => { hooks.add(fn); return () => hooks.delete(fn); }),
      link: vi.fn(() => () => {}),
    };
  }

  async function mountEdit({ts, sessionOptions = {}, tab = 'map', name, query = {}, vw = 1440, vh = 900, router: routerOver,
    platform: platformOver = {}, noSession = false, sessionError, createMapSession, withRouter = true} = {}) {
    setViewport(vw, vh);
    if (!noSession) ts ??= await session(sessionOptions);
    const registry = createRegistry();
    cleanups.push(defineEditCommands({registry}));
    cleanups.push(defineTransportCommands({registry, sheets: {}}));
    // The tab stacks the posture bar routes to (ED3's and ED5's commands, stand-ins with the contract ids).
    const stacks = {mapUndo: true, chartUndo: false, runs: []};
    registry.registerMany([
      {id: 'map.undo', title: 'Undo map edit', group: 'Map', when: () => stacks.mapUndo, run: () => stacks.runs.push('map.undo')},
      {id: 'map.redo', title: 'Redo map edit', group: 'Map', when: () => false, run: () => stacks.runs.push('map.redo')},
      {id: 'chart.undo', title: 'Undo', group: 'Chart', when: () => stacks.chartUndo, run: () => stacks.runs.push('chart.undo')},
      {id: 'chart.redo', title: 'Redo', group: 'Chart', when: () => false, run: () => stacks.runs.push('chart.redo')},
    ]);
    const router = withRouter ? routerOver ?? fakeRouter() : null;
    if (router) registry.provide('router', () => router);
    registry.provide('feedback', () => feedback);
    registry.provide('store', () => store);
    const platform = {isIPad: false, isIOS: false, coarse: signal(false), hoverFine: signal(true), reducedMotion: signal(false), features: {}, ...platformOver};
    const wake = {held: signal(false), update: vi.fn(), destroy: vi.fn()};
    const offs = {interruptions: vi.fn(), media: vi.fn(), gesture: vi.fn()};
    const deps = {
      createWakeLock: vi.fn(() => wake),
      watchInterruptions: vi.fn(() => offs.interruptions),
      startMediaSession: vi.fn(() => offs.media),
      startGestureAudio: vi.fn(() => offs.gesture),
      prefs,
      ...(createMapSession ? {createMapSession} : {}),
    };
    const el = document.body.appendChild(document.createElement('div'));
    const routeName = name ?? 'edit';
    const params = noSession ? {songId: 'gone', tab} : {songId: ts.id, tab, ...(routeName === 'editFind' ? {find: true} : {})};
    const match = {name: routeName, path: `/s/${params.songId}/edit/${tab}`, params, query};
    const ctx = {router, store, registry, feedback, platform, session: noSession ? null : ts.session, sessionError, editDeps: deps};
    const view = await edit.mount(el, match, ctx);
    await settle();
    vi.advanceTimersByTime(60);
    let unmounted = false;
    const unmount = async () => { if (!unmounted) { unmounted = true; await view.unmount(); } };
    cleanups.push(unmount);
    const root = el.querySelector('.edit');
    return {
      ts, view, el, root, registry, router, platform, deps, wake, offs, stacks, unmount, match,
      get api() { return registry.context().edit; },
      get bar() { return el.querySelector('.edit-bar'); },
      get inspector() { return el.querySelector('.edit-inspector'); },
      run: (id, args) => registry.run(id, {source: 'key', args}),
      async resize(w, h) { setViewport(w, h); window.dispatchEvent(new Event('resize')); vi.advanceTimersByTime(150); },
      async update(next) { view.update({...match, ...next, params: {...match.params, ...(next.params ?? {})}}); await settle(); vi.advanceTimersByTime(60); },
    };
  }

  /** The frame's CONTROLS rows that apply on `tab` (variant 'song'). */
  const rowsFor = (tab, layout) => edit.CONTROLS.filter((r) => r.variant !== 'bulk' && (!r.when || r.when === tab || r.when === layout));

  describe('the posture bar', () => {
    test.each(['map', 'chart', 'details'])('%s: every CONTROLS row renders with its role and accessible name', async (tab) => {
      const b = await mountEdit({tab});
      for (const row of rowsFor(tab, 'wide')) {
        const found = allByRole(b.bar, row.role, row.name).filter((el) => !el.hidden);
        expect(found.length, `${row.role} "${row.name}"`).toBeGreaterThanOrEqual(1);
      }
    });

    test('Done, the song title (the page\'s h1), the label, Map · Chart · Details and ↶ Undo ↷ Redo; a 2 px --edit header', async () => {
      const b = await mountEdit();
      expect(b.bar.tagName).toBe('HEADER');
      const h1s = b.el.querySelectorAll('h1');
      expect(h1s).toHaveLength(1);
      expect(h1s[0].textContent).toBe('Glasshouse');
      expect(b.bar.querySelector('.edit-label').textContent).toBe('Editing map');
      const tablist = b.bar.querySelector('[role=tablist]');
      expect(tablist.getAttribute('aria-label')).toBe('Edit');
      const tabs = [...tablist.querySelectorAll('[role=tab]')];
      expect(tabs.map(nameOf)).toEqual(['Map', 'Chart', 'Details']);
      expect(tabs.map((t) => t.getAttribute('href'))).toEqual(['map', 'chart', 'details'].map((t) => `/s/${b.ts.id}/edit/${t}`));
      expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
      const panel = b.el.querySelector('[role=tabpanel]');
      expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0].id);
      expect(panel.hasAttribute('data-scroller')).toBe(true);
      expect(b.el.querySelectorAll('[data-scroller]')).toHaveLength(1);
      const done = byRole(b.bar, 'button', 'Done');
      expect(done.getAttribute('aria-keyshortcuts')).toBe('Escape');
      const undo = byRole(b.bar, 'button', 'Undo');
      const redo = byRole(b.bar, 'button', 'Redo');
      expect(undo.getAttribute('aria-keyshortcuts')).toBe(null);
      expect(undo.hasAttribute('aria-disabled')).toBe(false);   // map.undo can undo
      expect(redo.getAttribute('aria-disabled')).toBe('true');
      undo.click();
      expect(b.stacks.runs).toEqual(['map.undo']);
    });

    test('labels per tab: Editing map · Editing drum chart · Editing details; Undo / Redo follow the tab\'s stack and Details has none', async () => {
      const b = await mountEdit();
      await b.update({params: {tab: 'chart'}});
      expect(b.bar.querySelector('.edit-label').textContent).toBe('Editing drum chart');
      const undo = byRole(b.bar, 'button', 'Undo');
      expect(undo.getAttribute('aria-disabled')).toBe('true');   // chart.undo cannot undo yet
      b.stacks.chartUndo = true;
      b.registry.invalidate();
      vi.advanceTimersByTime(60);
      expect(undo.hasAttribute('aria-disabled')).toBe(false);
      undo.click();
      expect(b.stacks.runs).toEqual(['chart.undo']);
      await b.update({params: {tab: 'details'}});
      expect(b.bar.querySelector('.edit-label').textContent).toBe('Editing details');
      expect(b.bar.querySelector('.edit-undo').hidden).toBe(true);
      expect(b.bar.querySelector('.edit-redo').hidden).toBe(true);
      expect(b.api.undo()).toBe(false);
    });

    test('a tab switch replaces the history entry (router.navigate with replace) and writes prefs.edit.lastTab once the tab shows', async () => {
      const b = await mountEdit();
      byRole(b.bar, 'tab', 'Chart').click();
      await settle();
      expect(b.router.calls).toEqual([['navigate', `/s/${b.ts.id}/edit/chart`, {replace: true}]]);
      // The router answers with update(match) for the same route.
      await b.update({params: {tab: 'chart'}});
      expect(prefs.get('edit.lastTab')).toBe('chart');
      expect(hoisted.charts).toHaveLength(1);
      expect(hoisted.maps[0].destroy).toHaveBeenCalled();
      expect(b.el.querySelector('.test-map-lanes')).toBeNull();
      expect(b.root.dataset.tab).toBe('chart');
      expect([...b.bar.querySelectorAll('[role=tab]')].map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
      // edit.tab.* does the same through setTab.
      expect(b.run('edit.tab.details')).toBe(true);
      await settle();
      expect(b.router.calls.at(-1)).toEqual(['navigate', `/s/${b.ts.id}/edit/details`, {replace: true}]);
      expect(b.registry.state('edit.tab.chart').checked).toBe(true);
    });

    test('without a router the frame switches tabs itself', async () => {
      const b = await mountEdit({withRouter: false});
      await b.api.setTab('details');
      await settle();
      expect(hoisted.details).toHaveLength(1);
      expect(hoisted.details[0].ctx.embedded).toBe(true);
      expect(hoisted.details[0].match.params).toEqual({songId: b.ts.id, tab: 'details'});
      expect(hoisted.details[0].ctx.edit).toBe(b.api);
      expect(prefs.get('edit.lastTab')).toBe('details');
    });

    test('the save status slot shows the tab\'s status and its action; a map change reads Saving… then Saved', async () => {
      const b = await mountEdit();
      const slot = b.bar.querySelector('.edit-save');
      expect(slot.getAttribute('role')).toBe('status');
      expect(slot.dataset.state).toBe('idle');
      const review = vi.fn();
      b.api.saveStatus.value = {state: 'conflict', text: 'Another version exists', action: {label: 'Review', run: review}};
      expect(slot.dataset.state).toBe('conflict');
      expect(slot.querySelector('.edit-save-text').textContent).toBe('Another version exists');
      byRole(slot, 'button', 'Review').click();
      expect(review).toHaveBeenCalledTimes(1);
      b.api.saveStatus.value = null;
      expect(slot.querySelector('.edit-save-text').textContent).toBe('');
      expect(slot.querySelector('button')).toBeNull();
      // A map edit goes through the session's tempo save.
      b.ts.map.edit((d) => { d.measures[3].label = 'Hook'; }, 'label');
      expect(slot.querySelector('.edit-save-text').textContent).toBe('Saving…');
      await b.ts.session.flush();
      vi.advanceTimersByTime(edit.SAVE_POLL_MS + 10);
      await settle();
      vi.advanceTimersByTime(edit.SAVE_POLL_MS + 10);
      expect(slot.querySelector('.edit-save-text').textContent).toBe('Saved');
      expect(b.ts.server.calls.saveTempo.length).toBeGreaterThan(0);
    });

    test('the title follows the song row', async () => {
      const b = await mountEdit();
      b.ts.server.pushSong({title: 'Glasshouse (Live)'});
      await settle();
      expect(b.ts.session.song.peek().title).toBe('Glasshouse (Live)');
      expect(b.el.querySelector('h1').textContent).toBe('Glasshouse (Live)');
    });
  });

  describe('Done and Esc', () => {
    test('Done goes back when the entry before Edit is this song\'s Stage, else replaces Edit with the Stage', async () => {
      const ts = await session();
      noteNavigation({name: 'stage', params: {songId: ts.id}}, {name: 'edit', params: {songId: ts.id, tab: 'map'}});
      const b = await mountEdit({ts});
      byRole(b.bar, 'button', 'Done').click();
      await settle();
      expect(b.router.calls).toEqual([['back', {fallback: `/s/${ts.id}`}]]);
      await b.unmount();

      resetEditOrigin();
      noteNavigation({name: 'library', params: {}}, {name: 'edit', params: {songId: ts.id, tab: 'details'}});
      const c = await mountEdit({ts, tab: 'details'});
      expect(c.run('edit.done')).toBe(true);
      await settle();
      expect(c.router.calls).toEqual([['navigate', `/s/${ts.id}`, {replace: true}]]);
    });

    test('a second Done while the first is leaving does nothing', async () => {
      const b = await mountEdit();
      b.api.done();
      b.api.done();
      await settle();
      expect(b.router.calls).toHaveLength(1);
    });

    test('the layered Esc on Map: clear the typed bar → stop the preview → close Find → Done', async () => {
      const digits = signal('');
      const previewing = signal(false);
      const auditioning = signal(false);
      const fake = {
        digits, previewing, auditioning, canUndo: signal(false), canRedo: signal(false),
        clearDigits: vi.fn(() => { digits.value = ''; }), togglePreview: vi.fn(async () => { previewing.value = false; }),
        endAudition: vi.fn(() => { auditioning.value = false; }), goToBar: vi.fn(), destroy: vi.fn(),
      };
      const b = await mountEdit({name: 'editFind', createMapSession: () => fake});
      expect(b.root.hasAttribute('data-find')).toBe(true);
      expect(hoisted.maps[0].opts.find).toBe(true);
      digits.value = '4';
      previewing.value = true;
      expect(b.api.escape()).toBe('digits');
      expect(fake.clearDigits).toHaveBeenCalled();
      expect(b.api.escape()).toBe('preview');
      expect(fake.togglePreview).toHaveBeenCalled();
      expect(b.api.escape()).toBe('find');
      await settle();
      expect(b.router.calls).toEqual([['navigate', `/s/${b.ts.id}/edit/map`, {replace: true}]]);
      // The router remounts Edit for edit ↔ editFind; on plain Map, Esc is Done.
      await b.unmount();
      const c = await mountEdit({ts: b.ts, createMapSession: () => fake});
      expect(c.run('edit.done')).toBe(true);
      await settle();
      expect(c.router.calls).toEqual([['navigate', `/s/${b.ts.id}`, {replace: true}]]);
    });

    test('Chart and Details: Esc is Done', async () => {
      const b = await mountEdit({tab: 'chart'});
      expect(b.api.escape()).toBe('done');
      await settle();
      expect(b.router.calls).toEqual([['navigate', `/s/${b.ts.id}`, {replace: true}]]);
    });

    test('closing Find without a router remounts Map without Find', async () => {
      const b = await mountEdit({name: 'editFind', withRouter: false});
      expect(hoisted.maps[0].opts.find).toBe(true);
      await b.api.closeFind();
      await settle();
      expect(hoisted.maps).toHaveLength(2);
      expect(hoisted.maps[1].opts.find).toBe(false);
      expect(b.root.hasAttribute('data-find')).toBe(false);
    });
  });

  describe('the inspector container', () => {
    test('laptop: the right column (wide), open, its body handed to the map view; no sheet header', async () => {
      const b = await mountEdit();
      expect(b.root.dataset.editLayout).toBe('wide');
      expect(b.root.dataset.inspector).toBe('open');
      expect(b.inspector.hidden).toBe(false);
      expect(b.inspector.getAttribute('aria-label')).toBe('Inspector');
      expect(hoisted.maps[0].opts.inspectorEl).toBe(b.el.querySelector('.edit-inspector-body'));
      expect(b.el.querySelector('.edit-inspector-body .test-map-inspector')).toBeTruthy();
      expect(b.api.inspector.el).toBe(b.el.querySelector('.edit-inspector-body'));
      expect(edit.INSPECTOR).toEqual({width: 320, portraitPercent: 45, header: 56});
    });

    test('iPad portrait: a 45% sheet that collapses to its 56 px header; the landscape hint on Map', async () => {
      const b = await mountEdit({vw: 820, vh: 1180, platform: {isIPad: true, coarse: signal(true), hoverFine: signal(false)}});
      expect(b.root.dataset.editLayout).toBe('portrait');
      expect(b.root.dataset.inspector).toBe('open');
      const toggle = byRole(b.inspector, 'button', 'Inspector');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(toggle.getAttribute('aria-controls')).toBe('edit-inspector-body');
      const hint = b.el.querySelector('.edit-inspector-hint');
      expect(hint.hidden).toBe(false);
      expect(hint.textContent).toBe('Map editing is roomier in landscape');
      toggle.click();
      expect(b.root.dataset.inspector).toBe('collapsed');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(b.el.querySelector('.edit-inspector-body').hidden).toBe(true);
      expect(b.api.inspector.open.peek()).toBe(false);
      toggle.click();
      expect(b.root.dataset.inspector).toBe('open');
      // Rotating to landscape makes it the right column again, 150 ms after the resize settles.
      await b.resize(1180, 820);
      expect(b.root.dataset.editLayout).toBe('wide');
      expect(b.api.layout.peek()).toBe('wide');
      expect(hint.hidden).toBe(true);
    });

    test('the hint is for touch on Map only; a portrait laptop window gets the sheet without it', async () => {
      const b = await mountEdit({vw: 900, vh: 1000});
      expect(b.root.dataset.editLayout).toBe('portrait');
      expect(b.el.querySelector('.edit-inspector-hint').hidden).toBe(true);
      const c = await mountEdit({ts: b.ts, vw: 820, vh: 1180, tab: 'chart', platform: {isIPad: true}});
      expect(c.el.querySelector('.edit-inspector-hint').hidden).toBe(true);
    });

    test('Chart shows the container only while its view fills it; Details has none', async () => {
      const b = await mountEdit({tab: 'chart'});
      expect(b.inspector.hidden).toBe(true);
      expect(b.root.dataset.inspector).toBe('none');
      hoisted.charts[0].opts.inspectorEl.append(document.createElement('div'));
      await settle();
      expect(b.inspector.hidden).toBe(false);
      expect(b.root.dataset.inspector).toBe('open');
      await b.update({params: {tab: 'details'}});
      expect(b.inspector.hidden).toBe(true);
      expect(b.root.dataset.inspector).toBe('none');
    });
  });

  describe('key-cap hints (spec §5.0)', () => {
    test('only after keyboard use, and only on (hover: hover) and (pointer: fine)', async () => {
      edit.resetKeyboardHints();
      const b = await mountEdit();
      const caps = [...b.bar.querySelectorAll('kbd[data-hint]')];
      expect(caps.map((k) => k.dataset.keys)).toEqual(['Escape', 'Mod+KeyZ', 'Mod+Shift+KeyZ']);
      expect(caps.every((k) => k.getAttribute('aria-hidden') === 'true')).toBe(true);
      expect(b.root.hasAttribute('data-kbd-hints')).toBe(false);
      b.root.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      expect(b.root.hasAttribute('data-kbd-hints')).toBe(false);
      keydown({key: 'ArrowRight', code: 'ArrowRight'}, {target: b.root});
      expect(b.root.hasAttribute('data-kbd-hints')).toBe(true);
      // A coarse pointer takes them away again; fine brings them back (live).
      b.platform.hoverFine.value = false;
      expect(b.root.hasAttribute('data-kbd-hints')).toBe(false);
      b.platform.hoverFine.value = true;
      expect(b.root.hasAttribute('data-kbd-hints')).toBe(true);
    });

    test('never on touch, even after a keyboard is used', async () => {
      edit.resetKeyboardHints();
      const b = await mountEdit({platform: {hoverFine: signal(false), coarse: signal(true)}});
      keydown({key: 'a', code: 'KeyA'}, {target: b.root});
      expect(b.root.hasAttribute('data-kbd-hints')).toBe(false);
    });
  });

  describe('the shared session', () => {
    test('provides \'edit\', \'session\' and \'transport\' (and \'map\' on Map) while mounted, and nothing after', async () => {
      const b = await mountEdit();
      const c = b.registry.context();
      expect(c.session).toBe(b.ts.session);
      expect(c.transport).toBe(b.ts.session.transport);
      expect(c.map).toBe(b.ts.session.mapEditor.peek());
      for (const key of ['tab', 'tabs', 'setTab', 'done', 'escape', 'undo', 'redo', 'saveStatus', 'inspector', 'layout']) expect(c.edit, key).toHaveProperty(key);
      expect(c.edit.tab).toBe('map');
      expect(c.edit.bulk).toBe(false);
      await b.unmount();
      const after = b.registry.context();
      expect(after.edit ?? null).toBeNull();
      expect(after.session ?? null).toBeNull();
      expect(after.transport ?? null).toBeNull();
      expect(after.map ?? null).toBeNull();
    });

    test('session.mapEditor is the Map tab\'s MapSession, cleared on a tab change and on unmount', async () => {
      const b = await mountEdit();
      const ms = b.ts.session.mapEditor.peek();
      expect(ms).toBeTruthy();
      expect(typeof ms.goToBar).toBe('function');
      expect(hoisted.maps[0].opts.mapSession).toBe(ms);
      expect(hoisted.maps[0].opts.session).toBe(b.ts.session);
      await b.update({params: {tab: 'chart'}});
      expect(b.ts.session.mapEditor.peek()).toBeNull();
      expect(b.registry.context().map ?? null).toBeNull();
      await b.update({params: {tab: 'map'}});
      const again = b.ts.session.mapEditor.peek();
      expect(again).toBeTruthy();
      expect(again).not.toBe(ms);
      await b.unmount();
      expect(b.ts.session.mapEditor.peek()).toBeNull();
    });

    test('a map change while Map is mounted goes on the map stack (D23), not practice undo', async () => {
      const b = await mountEdit();
      const before = b.ts.session.undo.canUndo.peek();
      b.ts.session.mapChange('rename', (m) => m.edit((d) => { d.measures[0].label = 'Count'; }, 'label'));
      expect(b.ts.session.undo.canUndo.peek()).toBe(before);
      expect(b.ts.map.undoStack.length).toBeGreaterThan(0);
    });

    test('?bar=N selects bar N on Map, at mount and on update', async () => {
      const goTo = [];
      const b = await mountEdit({
        query: {bar: '9'},
        createMapSession: (opts) => {
          const ms = editMapModule.createMapSession(opts);
          const go = ms.goToBar;
          ms.goToBar = (n) => { goTo.push(n); return go(n); };
          return ms;
        },
      });
      expect(goTo).toEqual([9]);
      await b.update({query: {bar: '17'}});
      expect(goTo).toEqual([9, 17]);
    });

    test('playback continues across Stage ↔ Edit: mounting and unmounting Edit never stops the transport', async () => {
      const ts = await session();
      await ts.play();
      expect(ts.snapshot.phase).toBe('playing');
      const b = await mountEdit({ts});
      expect(ts.snapshot.phase).toBe('playing');
      expect(document.documentElement.dataset.transportPhase).toBe('playing');
      await ts.advance(1);
      expect(ts.snapshot.phase).toBe('playing');
      await b.unmount();
      expect(ts.snapshot.phase).toBe('playing');
      expect(ts.session.disposed).toBe(false);
    });

    test('the per-session platform services, the frame bus and store.stage run while mounted', async () => {
      const ts = await session();
      const start = vi.spyOn(ts.session.frame, 'start');
      const stop = vi.spyOn(ts.session.frame, 'stop');
      const b = await mountEdit({ts});
      expect(b.deps.createWakeLock).toHaveBeenCalledTimes(1);
      expect(b.wake.update).toHaveBeenLastCalledWith({stageOpen: true, playing: false});
      expect(b.deps.watchInterruptions).toHaveBeenCalledWith(expect.objectContaining({engine: ts.engine, transport: ts.transport}));
      expect(b.deps.startMediaSession).toHaveBeenCalledWith(expect.objectContaining({transport: ts.transport, session: ts.session}));
      expect(b.deps.startGestureAudio).toHaveBeenCalledWith(expect.objectContaining({transport: ts.transport, engine: ts.engine}));
      expect(start).toHaveBeenCalled();
      expect(store.stage.peek()).toEqual({songId: ts.id, layout: 'rail', surface: null, playing: false, focus: false});
      await ts.play();
      expect(b.wake.update).toHaveBeenLastCalledWith({stageOpen: true, playing: true});
      expect(store.stage.peek().playing).toBe(true);
      await b.unmount();
      expect(b.wake.destroy).toHaveBeenCalled();
      expect(b.offs.interruptions).toHaveBeenCalled();
      expect(b.offs.media).toHaveBeenCalled();
      expect(b.offs.gesture).toHaveBeenCalled();
      expect(stop).toHaveBeenCalled();
      expect(store.stage.peek()).toBeNull();
      expect(document.documentElement.dataset.transportPhase).toBeUndefined();
    });

    test('unmount flushes the session (final) and removes the frame', async () => {
      const b = await mountEdit();
      const flush = vi.spyOn(b.ts.session, 'flush');
      await b.unmount();
      expect(flush).toHaveBeenCalledWith({final: true});
      expect(b.el.querySelector('.edit')).toBeNull();
      expect(hoisted.maps[0].destroy).toHaveBeenCalled();
    });

    test('the slim transport sits at the bottom of every tab', async () => {
      const b = await mountEdit({tab: 'details'});
      const row = b.el.querySelector('.edit-transport [role=toolbar]');
      expect(row).toBeTruthy();
      expect(row.dataset.variant).toBe('slim');
      expect(row.getAttribute('aria-label')).toBe('Transport');
    });

    test('the theme is the app\'s: the frame never sets the Stage\'s theme attributes', async () => {
      const b = await mountEdit();
      expect(document.documentElement.dataset.place).toBe('edit');
      expect(document.documentElement.hasAttribute('data-stage-theme')).toBe(false);
      expect(b.root.closest('[data-stage-layout]')).toBeNull();
    });
  });

  describe('songs Edit cannot open, and tabs that fail', () => {
    test('a deleted song: "Song not found" with a way back to the Library', async () => {
      const b = await mountEdit({noSession: true, sessionError: new Error('gone')});
      const card = b.el.querySelector('[role=alert]');
      expect(card.querySelector('h1').textContent).toBe('Song not found');
      const link = card.querySelector('a');
      expect(link.textContent).toBe('Back to Library');
      link.click();
      expect(b.router.calls).toEqual([['navigate', '/', {replace: true}]]);
    });

    test('a shared (read-only) song: editing is for your own songs, Done goes to its Stage', async () => {
      const ts = await session({shared: {token: 'a'.repeat(64)}});
      const b = await mountEdit({ts});
      expect(b.el.querySelector('h1').textContent).toBe('Editing is for your own songs');
      expect(b.el.querySelector('[role=alert] a').getAttribute('href')).toBe(`/s/${ts.id}`);
      expect(ts.session.mapEditor.peek()).toBeNull();
      expect(b.el.querySelector('.edit-bar')).toBeNull();
    });

    test('a tab view that throws shows the error with Try again, which mounts it again', async () => {
      hoisted.fail.map = new Error('lanes exploded');
      const b = await mountEdit();
      const alert = b.el.querySelector('.edit-tab-error');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toContain('Map couldn’t open.');
      expect(alert.textContent).toContain('lanes exploded');
      hoisted.fail.map = null;
      byRole(alert, 'button', 'Try again').click();
      await settle();
      expect(b.el.querySelector('.edit-tab-error')).toBeNull();
      expect(hoisted.maps).toHaveLength(1);
    });
  });

  describe('the bulk Details posture bar', () => {
    function bulkBed({count = 3, platform: platformOver = {}} = {}) {
      const registry = createRegistry();
      cleanups.push(defineEditCommands({registry}));
      const router = fakeRouter();
      const el = document.body.appendChild(document.createElement('div'));
      const platform = {hoverFine: signal(true), ...platformOver};
      const bar = edit.mountBulkPostureBar(el, {count, router, registry, platform});
      cleanups.push(() => bar.destroy());
      return {registry, router, el, bar};
    }

    test('"Editing details · {n} songs" as the h1, Done only: no tabs, no Undo / Redo, no slim transport', () => {
      const b = bulkBed();
      const header = b.el.querySelector('.edit-bar');
      expect(header.dataset.variant).toBe('bulk');
      expect(b.el.querySelector('h1').textContent).toBe('Editing details · 3 songs');
      expect(b.el.querySelector('[role=tablist]')).toBeNull();
      expect(byRole(b.el, 'button', 'Undo')).toBeNull();
      expect(b.el.querySelector('[role=toolbar]')).toBeNull();
      for (const row of edit.CONTROLS.filter((r) => r.variant === 'bulk')) expect(byRole(b.el, row.role, row.name)).toBeTruthy();
      expect(b.el.querySelector('.edit-save').getAttribute('role')).toBe('status');
      b.bar.set({count: 1});
      expect(b.el.querySelector('h1').textContent).toBe('Editing details · 1 song');
    });

    test('Done and Esc go back to the Library selection (router.back with fallback /)', async () => {
      const b = bulkBed();
      byRole(b.el, 'button', 'Done').click();
      expect(b.router.calls).toEqual([['back', {fallback: '/'}]]);
      vi.advanceTimersByTime(2000);
      expect(b.registry.run('edit.done', {source: 'key'})).toBe(true);
      expect(b.router.calls).toEqual([['back', {fallback: '/'}], ['back', {fallback: '/'}]]);
      expect(b.registry.context().edit.bulk).toBe(true);
      expect(b.registry.isEnabled('edit.tab.map')).toBe(false);
    });

    test('its save status slot is the details page\'s to fill; destroy removes the bar and the context', () => {
      const b = bulkBed();
      b.bar.saveStatus.value = {state: 'saved', text: 'Saved'};
      expect(b.el.querySelector('.edit-save-text').textContent).toBe('Saved');
      b.bar.destroy();
      expect(b.el.querySelector('.edit-bar')).toBeNull();
      expect(b.registry.context().edit ?? null).toBeNull();
    });
  });
});

let editMapModule = null;
beforeAll(async () => { editMapModule = await import('../src/edit/map/session.js'); });
