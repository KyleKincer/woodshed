// @vitest-environment happy-dom
// Edit · Chart (ED5): the commands (src/edit/chart/commands.js: architecture §3.4 scopes Ec and Ecs,
// D18, D45, D56), the toolbar, menus and kit bank, the score's stop scope through the real
// dispatcher, the Drum keys validation, and chart-edit.js mounted on a real song session.
// The editor's internals are covered by notation-editor.test.js and notation-songmap.test.js;
// engraving and geometry are Playwright states (tests/fixture/states/ED5.cjs).
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

// alphaTab cannot lay out in happy-dom: a fake view records what the editor asks it to draw.
const views = vi.hoisted(() => []);
vi.mock('../src/js/notation/score-view.js', () => ({createScoreView: (host, options = {}) => {
  const stage = document.createElement('div');
  host.replaceChildren(stage);
  let score = null;
  const view = {host, stage, options, ready: true, ranges: [], get score() { return score; },
    setScore(next, opts = {}) { score = next; view.ranges.push(opts.range); options.onRender?.(view); },
    setOptions() {}, setScale() {}, setBarsPerRow() {}, setBarMarks() {}, setCaret() {}, setSelection() {}, setPlayhead() {}, setLoop() {},
    setRange() {}, noteBoxes: () => [], barBounds: () => null, barAt: () => 0, rendered: () => true, destroy() {}};
  views.push(view);
  return view;
}}));

import {createRegistry} from '../src/app/commands.js';
import {startDispatcher} from '../src/app/dispatch.js';
import {canonical} from '../src/app/keys.js';
import {signal} from '../src/app/store.js';
import {KIT, emptyScore} from '../shared/notation.ts';
import {
  CHART_COMMAND_IDS, COPY as COMMAND_COPY, ECS, EC, PIECE_IDS, STEP_IDS, STEP_VALUE, defineChartCommands, drumKeyFor, drumKeyMap,
  keyStringLetter, letterToKeyString, reservedScoreKeys, validateDrumKeys,
} from '../src/edit/chart/commands.js';
import {COPY, CONTROLS, editMenu, gridMenu, partMenu, sectionsMenu, tupletMenu, viewMenu} from '../src/edit/chart/menus.js';
import {STEP_BUTTONS, createToolbar} from '../src/edit/chart/toolbar.js';
import {BANK_ROWS, PAD_LONG_PRESS_MS, createKitBank} from '../src/edit/chart/kit-bank.js';
import {createNotationWorkspace} from '../src/js/notation/editor.js';
import {openPart} from '../src/js/notation/part.js';
import {restoreDomShims} from './helpers/dom.js';

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const memoryPrefs = (data = {}) => ({
  data,
  get(path) { return path.split('.').reduce((o, k) => o?.[k], this.data); },
  set(path, value) { const keys = path.split('.'); let o = this.data; for (const k of keys.slice(0, -1)) o = o[k] ??= {}; o[keys.at(-1)] = value; },
});

/** A silent DrumAudio stand-in (previews and audition). */
const quietDrums = () => ({mode: 'recording', level: .65, play() {}, setScore() {}, setMode(m) { this.mode = m; }, setLevel(x) { this.level = x; }});

/** The accessible name the tests read: aria-label, aria-labelledby, else the text without key-caps. */
function nameOf(el) {
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
  const by = el.getAttribute('aria-labelledby');
  if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  const copy = el.cloneNode(true);
  for (const k of copy.querySelectorAll('kbd, .ui-button-reason')) k.remove();
  return copy.textContent.replace(/\s+/g, ' ').trim();
}
const byRole = (root, role) => [...root.querySelectorAll(role === 'button' ? 'button, [role=button]' : `[role=${role}]`)]
  .filter((el) => (role === 'button' ? !el.getAttribute('role') || el.getAttribute('role') === 'button' : true));

const CODES = {'/': 'Slash', '.': 'Period', '=': 'Equal', '-': 'Minus', ',': 'Comma', '[': 'BracketLeft', ']': 'BracketRight', '?': 'Slash'};
const codeOf = (k) => (/^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^\d$/.test(k) ? `Digit${k}` : k === ' ' ? 'Space' : CODES[k] ?? k);
function press(k, extra = {}, target = document.activeElement ?? document.body) {
  const e = new KeyboardEvent('keydown', {key: k, code: codeOf(k), bubbles: true, cancelable: true, ...extra});
  (target ?? document.body).dispatchEvent(e);
  return e;
}

// ---------------------------------------------------------------------------------------------------------------
// The command table (architecture §3.4, Edit · Chart rows)

const TABLE = [
  ['chart.undo', ['Mod+KeyZ'], [EC, ECS]],
  ['chart.redo', ['Mod+Shift+KeyZ', 'Mod+KeyY'], [EC, ECS]],
  ['chart.pagePrev', ['[', 'PageUp'], [EC]],
  ['chart.pageNext', [']', 'PageDown'], [EC]],
  ['chart.loopSelection', ['KeyL'], [EC]],
  ['chart.write', ['KeyN'], [ECS]],
  ['chart.cursorBack', ['ArrowLeft'], [ECS]],
  ['chart.cursorFwd', ['ArrowRight'], [ECS]],
  ['chart.extendBack', ['Shift+ArrowLeft'], [ECS]],
  ['chart.extendFwd', ['Shift+ArrowRight'], [ECS]],
  ['chart.pieceUp', ['ArrowUp'], [ECS]],
  ['chart.pieceDown', ['ArrowDown'], [ECS]],
  ['chart.moveBack', ['Alt+ArrowLeft'], [ECS]],
  ['chart.moveFwd', ['Alt+ArrowRight'], [ECS]],
  ['chart.barStart', ['Home'], [ECS]],
  ['chart.barEnd', ['End'], [ECS]],
  ['chart.skip', ['KeyR'], [ECS]],
  ['chart.finer', ['='], [ECS]],
  ['chart.coarser', ['-'], [ECS]],
  ['chart.dot', ['.'], [ECS]],
  ['chart.tuplet', ['/'], [ECS]],
  ['chart.accent', ['KeyA'], [ECS]],
  ['chart.heavy', ['Shift+KeyA'], [ECS]],
  ['chart.ghost', ['KeyG'], [ECS]],
  ['chart.delete', ['Backspace', 'Delete'], [ECS]],
  ['chart.copy', ['Mod+KeyC'], [ECS]],
  ['chart.paste', ['Mod+KeyV'], [ECS]],
  ['chart.repeat', ['Mod+KeyD'], [ECS]],
  ['chart.selectBar', ['Mod+KeyA'], [ECS]],
  ['chart.clear', ['Escape'], [ECS]],
  ...[1, 2, 3, 4, 5].map((n) => [`chart.step.${n}`, [`Digit${n}`], [ECS]]),
];
const MENU_ONLY = ['chart.moveDialog', 'chart.tupletDialog', 'chart.review', 'chart.barMeter', 'chart.align', 'chart.export', 'chart.print',
  'chart.openPart', 'chart.importDrums', 'chart.drumKeys', 'chart.noteList', 'chart.allLanes', 'chart.shortcuts', 'chart.view',
  'chart.partLayout', 'chart.listen', 'chart.playCursor', 'chart.fit', 'chart.follow', 'chart.retrySave', 'chart.resolve', 'chart.paging'];

describe('commands (architecture §3.4)', () => {
  let registry, handle;
  beforeEach(() => { registry = createRegistry(); handle = defineChartCommands({registry}); });

  test.each(TABLE)('%s binds %j in %j', (id, keys, scopes) => {
    const def = registry.get(id);
    expect(def, id).toBeTruthy();
    expect(def.group).toBe('Chart');
    expect(def.keys).toEqual(keys.map(canonical));
    expect(def.scopes).toEqual(scopes);
    expect(typeof def.title === 'function' ? def.title(registry.context(), 1) : def.title).toBeTruthy();
  });

  test('every menu-only command exists with no keys, so a menu shows it (§3.4)', () => {
    for (const id of MENU_ONLY) {
      const def = registry.get(id);
      expect(def, id).toBeTruthy();
      expect(def.group).toBe('Chart');
      expect(def.keys, id).toEqual([]);
    }
    expect(new Set([...CHART_COMMAND_IDS, ...STEP_IDS, ...PIECE_IDS]).size).toBe(CHART_COMMAND_IDS.length + 5 + KIT.length);
    for (const id of [...CHART_COMMAND_IDS, ...STEP_IDS, ...PIECE_IDS]) expect(registry.get(id), id).toBeTruthy();
  });

  test('steps follow D18: 1 = 1/64 … 5 = 1/4, and 6 and 7 are unbound', () => {
    expect(STEP_VALUE).toEqual({1: 64, 2: 32, 3: 16, 4: 8, 5: 4});
    const score = registry.bindingsFor(ECS);
    expect(score.has('Digit6')).toBe(false);
    expect(score.has('Digit7')).toBe(false);
    expect(STEP_BUTTONS.map((b) => b.digit)).toEqual([5, 4, 3, 2, 1]);
  });

  test('the dynamic families are declared for registry CI (chart.step.N, chart.piece.<kitId>)', () => {
    const families = Object.fromEntries(registry.dynamicFamilies().map((f) => [f.template, f.ids]));
    expect(families['chart.step.{n}']).toEqual(STEP_IDS);
    expect(families['chart.piece.{n}']).toEqual(PIECE_IDS);
  });

  test('nothing runs without a mounted chart: `when` is false', () => {
    for (const id of ['chart.undo', 'chart.write', 'chart.piece.snare', 'chart.step.3', 'chart.export']) {
      expect(registry.state(id).visible, id).toBe(false);
      expect(registry.run(id)).toBe(false);
    }
  });

  test('drum letters are physical keys (D56): the KIT default, a stored KeyString, or none when cleared', () => {
    const score = registry.bindingsFor(ECS);
    for (const kit of KIT) {
      const key = kit.key ? `Key${kit.key.toUpperCase()}` : null;
      if (key) expect(score.get(key)?.id, kit.id).toBe(`chart.piece.${kit.id}`);
    }
    expect(handle.setDrumKeys({crash: 'KeyX', crossStick: ''})).toBe(true);
    const after = registry.bindingsFor(ECS);
    expect(after.get('KeyX').id).toBe('chart.piece.crash');
    expect(after.has('KeyC')).toBe(false);                        // crash moved; nothing else takes C
    expect(registry.get('chart.piece.crossStick').keys).toEqual([]);   // '' is no key, never the default
    expect(handle.setDrumKeys({crash: 'KeyX', crossStick: ''})).toBe(false);
    expect(handle.drumKeys.crash).toBe('KeyX');
  });

  test('drum key helpers convert stored letters and KeyStrings', () => {
    expect(letterToKeyString('q')).toBe('KeyQ');
    expect(letterToKeyString('1')).toBeNull();
    expect(keyStringLetter('KeyQ')).toBe('Q');
    expect(keyStringLetter('Digit1')).toBe('');
    const crash = KIT.find((k) => k.id === 'crash');
    expect(drumKeyFor(crash, {})).toBe('KeyC');
    expect(drumKeyFor(crash, {crash: ''})).toBe('');
    expect(drumKeyFor(crash, {crash: 'KeyV'})).toBe('KeyV');
    expect(drumKeyFor(crash, {crash: 'v'})).toBe('KeyV');
    expect(Object.keys(drumKeyMap())).toHaveLength(KIT.length);
  });

  test('the score reserves every key it binds except the drum letters (D18), and validation refuses them', () => {
    const reserved = reservedScoreKeys(registry);
    for (const k of ['KeyN', 'KeyR', 'KeyA', 'KeyG', 'Digit1', 'Digit5', '.', '/', '=', '-', 'Escape', 'Mod+KeyZ']) expect(reserved, k).toHaveProperty(k);
    for (const k of ['KeyS', 'KeyK', 'KeyC', 'KeyE']) expect(reserved, k).not.toHaveProperty(k);
    const letters = Object.fromEntries(KIT.map((k) => [k.id, k.key ?? '']));
    expect(validateDrumKeys(letters, {reserved}).keys.snare).toBe('KeyS');
    expect(validateDrumKeys({...letters, crash: 'n'}, {reserved})).toMatchObject({kitId: 'crash', error: expect.stringMatching(/A, G, N and R/)});
    expect(validateDrumKeys({...letters, crash: 's'}, {reserved})).toMatchObject({kitId: 'snare', error: expect.stringMatching(/S is set for both Crash and Snare/)});
    expect(validateDrumKeys({...letters, crash: '1'}, {reserved})).toMatchObject({kitId: 'crash', error: COMMAND_COPY.drumKeysLetter('Crash')});
    expect(validateDrumKeys({...letters, crash: ''}, {reserved}).keys.crash).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The score's stop scope (D18, D45) through the real dispatcher

describe('the score surface is a stop scope', () => {
  let registry, stop, workspace, part, persistence, engine, outer, host, prefs;
  beforeEach(async () => {
    views.length = 0;
    registry = createRegistry();
    defineChartCommands({registry});
    stop = startDispatcher({registry, platform: 'win'});
    outer = [];
    const record = (id, keys, scopes) => registry.register({id, title: id, group: 'App', keys, scopes, run: () => outer.push(id)});
    record('test.playStop', ['Space'], ['edit']);
    record('test.pause', ['Shift+Space'], ['edit']);
    record('test.again', ['Enter'], ['edit']);
    record('test.done', ['Escape'], ['edit']);
    record('test.edit', ['KeyE'], ['edit']);
    record('test.countIn', ['KeyC'], ['edit']);
    record('test.click', ['KeyK'], ['edit']);
    record('test.speedDown', [','], ['edit']);
    record('test.palette', ['Mod+KeyK'], ['global']);
    record('test.help', ['?'], ['global']);
    registry.provide('posture', () => 'edit');
    registry.provide('edit', () => ({tab: 'chart'}));
    registry.provide('chart', () => workspace);
    document.body.innerHTML = '<main><section></section></main>';
    host = document.querySelector('section');
    engine = {duration: 64, playing: false, ctx: {currentTime: 0}, tracks: [], loop: {enabled: false}, seek: vi.fn(), getPosition: () => 0, setLoop: vi.fn()};
    persistence = {load: vi.fn(async () => emptyScore(64)), set: vi.fn(), destroy: vi.fn(), flush: vi.fn()};
    part = await openPart({song: {id: 's', title: 'S'}, engine, metronome: {beats: [], sectionAt: () => ({bpm: 120, beatsPerBar: 4, unit: 4})}, persistence});
    prefs = memoryPrefs({edit: {chart: {view: 'score', keys: {}}}});
    workspace = await createNotationWorkspace({host, part, song: {id: 's', title: 'S'}, engine, prefs, drumAudio: quietDrums(),
      drumKeys: {get: () => prefs.data.edit.chart.keys, save: vi.fn(), reserved: () => reservedScoreKeys(registry)}});
    workspace.setVisible(true);
    workspace.focus();
  });
  afterEach(() => { workspace?.destroy(); part?.destroy(); stop(); document.body.replaceChildren(); restoreDomShims(); });
  const hits = () => (persistence.set.mock.calls.at(-1)?.[0]?.bars ?? []).flatMap((b) => b.hits);

  test.each([
    ['Space', ' ', {}, 'test.playStop'],
    ['⇧Space', ' ', {shiftKey: true}, 'test.pause'],
    ['Enter', 'Enter', {}, 'test.again'],
    ['Esc (nothing to clear)', 'Escape', {}, 'test.done'],
    ['⌘K', 'k', {ctrlKey: true}, 'test.palette'],
    ['?', '?', {shiftKey: true}, 'test.help'],
  ])('%s passes through to the outer scopes', (_, k, extra, id) => {
    expect(document.activeElement).toBe(workspace.surface);
    press(k, extra);
    expect(outer).toEqual([id]);
    expect(hits()).toEqual([]);
  });

  test('PageUp and PageDown pass through to the posture: previous / next 16 bars', () => {
    expect(workspace.state().range.first).toBe(0);
    press('PageDown');
    expect(workspace.state().range.first).toBe(16);
    press('PageUp');
    expect(workspace.state().range.first).toBe(0);
    expect(outer).toEqual([]);
  });

  test('E writes Crash 2 while it is a drum letter, and passes through when no drum letter uses it (D18)', () => {
    press('e');
    expect(hits().map((h) => h.instrument)).toEqual(['crash2']);
    expect(outer).toEqual([]);
  });

  test(', does nothing in the score', () => {
    const e = press(',');
    expect(outer).toEqual([]);
    expect(hits()).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  test('C and K write Crash and Kick in the score, never Count-in or Click', () => {
    press('c');
    press('ArrowRight');
    press('k');
    expect(hits().map((h) => h.instrument)).toEqual(['crash', 'kick']);
    expect(outer).toEqual([]);
  });

  test('outside the score C, K and L act on the posture', () => {
    workspace.surface.blur();
    press('c', {}, document.body);
    press('k', {}, document.body);
    press('l', {}, document.body);
    expect(outer).toEqual(['test.countIn', 'test.click']);
    expect(engine.setLoop).toHaveBeenCalledWith(true, 0, 2);   // chart.loopSelection: bar 1 at 120 bpm
    expect(hits()).toEqual([]);
  });

  test('Esc clears a selection first (chart.clear), then reaches Done', () => {
    press('s');
    expect(workspace.state().selectedCount).toBe(1);
    press('Escape');
    expect(workspace.state().selectedCount).toBe(0);
    expect(outer).toEqual([]);
    press('Escape');
    expect(outer).toEqual(['test.done']);
  });

  test('a key the score does not bind ends there (stop scope): ⇧S writes nothing and runs nothing', () => {
    const e = press('S', {shiftKey: true});
    expect(e.defaultPrevented).toBe(false);
    expect(outer).toEqual([]);
    expect(hits()).toEqual([]);
  });

  test('digits pick steps: 5 = 1/4, 1 = 1/64; 6 and 7 do nothing', () => {
    press('5');
    expect(workspace.state().step.value).toBe(4);
    press('1');
    expect(workspace.state().step.value).toBe(64);
    press('6');
    press('7');
    expect(workspace.state().step.value).toBe(64);
  });
});

describe('E passes through when no drum letter is E', () => {
  test('clearing Crash 2 lets E reach the posture', async () => {
    views.length = 0;
    const registry = createRegistry();
    defineChartCommands({registry, keys: {crash2: ''}});
    const stop = startDispatcher({registry, platform: 'win'});
    const outer = [];
    registry.register({id: 'test.edit', title: 'Edit', group: 'App', keys: ['KeyE'], scopes: ['edit'], run: () => outer.push('test.edit')});
    registry.provide('posture', () => 'edit');
    registry.provide('edit', () => ({tab: 'chart'}));
    document.body.innerHTML = '<section></section>';
    const engine = {duration: 8, playing: false, ctx: {currentTime: 0}, tracks: [], seek: vi.fn(), getPosition: () => 0};
    const persistence = {load: vi.fn(async () => null), set: vi.fn(), destroy: vi.fn(), flush: vi.fn()};
    const part = await openPart({song: {id: 's'}, engine, metronome: {beats: [], sectionAt: () => ({bpm: 120, beatsPerBar: 4, unit: 4})}, persistence});
    const workspace = await createNotationWorkspace({host: document.querySelector('section'), part, song: {id: 's'}, engine, drumAudio: quietDrums(),
      prefs: memoryPrefs({edit: {chart: {}}}), drumKeys: {get: () => ({crash2: ''}), save() {}, reserved: () => ({})}});
    registry.provide('chart', () => workspace);
    workspace.setVisible(true);
    workspace.focus();
    press('e');
    expect(outer).toEqual(['test.edit']);
    expect(persistence.set).not.toHaveBeenCalled();
    workspace.destroy(); part.destroy(); stop();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Toolbar, menus and the kit bank

const STATE = {
  ready: true, layout: 'score', paging: 'pages', pagingModes: ['pages'], inspectorTab: 'kit',
  step: {value: 8, dotted: false, tuplet: 1}, grid: {value: 16, triplet: false},
  piece: {id: 'snare', name: 'Snare', short: 'SD', key: 'KeyS'}, selectedCount: 0, canClear: false,
  range: {first: 16, last: 31, page: 1, pages: 4, total: 64}, barLabel: 'Bar 17', barRange: [16, 16], position: 'Bar 17 · Beat 1.00',
  canUndo: true, canRedo: false, status: 'saved', statusText: 'Saved', recovery: null, message: '',
  listenMode: 'recording', listen: {mode: 'recording', level: .65}, recordedDrums: {available: true, out: false},
  audition: false, allLanes: false, showList: false, follow: true, partLayout: 'combined',
  expression: {accent: false, heavy: false, ghost: false, flam: false, drag: false, roll: 0, sticking: '', velocity: .75}, voice: 'auto',
};

describe('toolbar (spec §5.2)', () => {
  let registry, chart, toolbar;
  beforeEach(() => {
    registry = createRegistry();
    defineChartCommands({registry});
    chart = {state: () => STATE, run: vi.fn()};
    registry.provide('chart', () => chart);
    toolbar = createToolbar({run: chart.run, registry, openMenu: vi.fn(), saveStatus: true});
    document.body.append(toolbar.el);
    toolbar.update(STATE);
  });
  afterEach(() => { toolbar.destroy(); document.body.replaceChildren(); restoreDomShims(); });

  test.each(CONTROLS.map((c) => [c.role, c.name, c.command ?? null]))('%s "%s" (%s)', (role, name, command) => {
    const matches = byRole(toolbar.el, role).filter((el) => nameOf(el) === name);
    expect(matches.length, `${role} ${name}`).toBeGreaterThanOrEqual(1);
    if (command && role === 'button') expect(matches.some((el) => el.getAttribute('aria-keyshortcuts') !== null || command === 'chart.fit')).toBe(true);
  });

  test('the step buttons read ♩ 1/4 · ♪ 1/8 · 1/16 · 1/32 · 1/64 with key-cap hints 5·4·3·2·1', () => {
    const steps = [...toolbar.el.querySelectorAll('.chart-tool-step')];
    expect(steps.map((b) => b.querySelector('.ui-button-label').textContent)).toEqual(['♩ 1/4', '♪ 1/8', '1/16', '1/32', '1/64']);
    expect(steps.map((b) => b.querySelector('kbd[data-hint]')?.dataset.keys)).toEqual(['Digit5', 'Digit4', 'Digit3', 'Digit2', 'Digit1']);
    expect(steps.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false', 'false']);
    steps[0].click();
    expect(chart.run).toHaveBeenCalledWith('step', 5);
  });

  test('Writing: Snare (S), the range "Bars 17–32", Undo and Redo with text and names', () => {
    expect(toolbar.el.querySelector('.chart-tool-writing').textContent.replace(/\s+/g, ' ').trim()).toBe('Writing: Snare S');
    expect(toolbar.el.querySelector('.chart-tool-range-text').textContent).toBe('Bars 17–32');
    const [undo, redo] = toolbar.el.querySelectorAll('.chart-tool-history button');
    expect([nameOf(undo), nameOf(redo)]).toEqual(['Undo', 'Redo']);
    expect(undo.querySelector('.ui-button-label').textContent).toBe('Undo');
    expect(undo.getAttribute('aria-keyshortcuts')).toBe('Control+Z');
  });

  test('Grid ▾ and Fit show in Lanes only', () => {
    expect(toolbar.el.querySelector('.chart-tool-lanes').hidden).toBe(true);
    toolbar.update({...STATE, layout: 'lanes', grid: {value: 32, triplet: true}});
    expect(toolbar.el.querySelector('.chart-tool-lanes').hidden).toBe(false);
    expect(toolbar.el.querySelector('.chart-tool-grid .ui-button-label').textContent).toBe('Grid: 1/32 Triplet');
  });

  test('the save status (without a posture bar) offers Review on a conflict and Retry offline', () => {
    const status = toolbar.el.querySelector('.chart-tool-save');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toContain('Saved');
    toolbar.update({...STATE, status: 'conflict', statusText: 'Another version exists · edits kept here', recovery: 'resolve'});
    const action = status.querySelector('button');
    expect(action.hidden).toBe(false);
    expect(nameOf(action)).toBe('Review');
    action.click();
    expect(chart.run).toHaveBeenLastCalledWith('resolve');
    toolbar.update({...STATE, status: 'offline', statusText: 'Waiting for connection · edits kept here', recovery: 'retry'});
    expect(nameOf(action)).toBe('Retry');
    action.click();
    expect(chart.run).toHaveBeenLastCalledWith('retry-save');
  });

  test('menu buttons open their menus under themselves', () => {
    const openMenu = vi.fn();
    const t = createToolbar({run: chart.run, registry, openMenu});
    for (const name of ['view', 'tuplet', 'sections', 'edit', 'part', 'grid']) {
      t.el.querySelector(`[data-menu=${name}]`).click();
      expect(openMenu).toHaveBeenLastCalledWith(name, t.el.querySelector(`[data-menu=${name}]`));
    }
    t.destroy();
  });
});

describe('menus (spec §5.2)', () => {
  let registry;
  beforeEach(() => {
    registry = createRegistry();
    defineChartCommands({registry});
    registry.provide('chart', () => ({state: () => STATE, run: vi.fn()}));
  });
  const resolved = (items) => items.filter((i) => i.type !== 'separator').map((i) => {
    const def = i.command ? registry.get(i.command) : null;
    return {label: i.label ?? def?.menu?.label ?? (typeof def?.title === 'string' ? def.title : ''), kbd: i.kbd ?? def?.keys?.[0] ?? null};
  });

  test('Edit ▾: Copy ⌘C, Paste ⌘V, Repeat bars… ⌘D, Move notes… ⌥←, Tuplet on this beat…, Mark bars reviewed, then Loop selection L and the map links', () => {
    expect(resolved(editMenu())).toEqual([
      {label: 'Copy', kbd: 'Mod+KeyC'}, {label: 'Paste', kbd: 'Mod+KeyV'}, {label: 'Repeat bars…', kbd: 'Mod+KeyD'},
      {label: 'Move notes…', kbd: 'Alt+ArrowLeft'}, {label: 'Tuplet on this beat…', kbd: null}, {label: 'Mark bars reviewed', kbd: null},
      {label: 'Loop selection', kbd: 'KeyL'}, {label: 'Bar meter & label…', kbd: null}, {label: 'Align in tempo map…', kbd: null},
    ]);
  });

  test('Part ▾: export, print, open part, drum part from file, Drum keys…, Note list ✓, Show every kit piece ✓, Keyboard shortcuts ?', () => {
    const items = partMenu({...STATE, showList: true});
    expect(resolved(items).map((i) => i.label)).toEqual(['Export .woodshed.json', 'Print', 'Open .woodshed.json part…',
      'Drum part from file (Guitar Pro, MIDI, Clone Hero)…', 'Drum keys…', 'Note list', 'Show every kit piece', 'Keyboard shortcuts']);
    expect(items.find((i) => i.command === 'chart.noteList')).toMatchObject({type: 'checkbox', checked: true});
    expect(items.find((i) => i.command === 'chart.shortcuts').kbd).toBe('?');
    expect(registry.state('chart.allLanes').reason).toBe(COMMAND_COPY.allLanesReason);
  });

  test('View ▾: Score · Lanes radios and Follow; Pages · Continuous once the workspace offers both (D48)', () => {
    const items = viewMenu(STATE);
    expect(items.filter((i) => i.command === 'chart.view').map((i) => [i.label, i.checked])).toEqual([['Score', true], ['Lanes', false]]);
    expect(items.some((i) => i.command === 'chart.paging')).toBe(false);
    const both = viewMenu({...STATE, pagingModes: ['pages', 'scroll']});
    expect(both.filter((i) => i.command === 'chart.paging').map((i) => i.label)).toEqual(['Pages', 'Continuous']);
  });

  test('Tuplet ▾, Grid ▾ and the section jump menu run the workspace', () => {
    const run = vi.fn();
    tupletMenu(STATE, run).find((i) => i.label === 'Triplet').run();
    expect(run).toHaveBeenLastCalledWith('setTuplet', 3);
    gridMenu(STATE, run).find((i) => i.label === '1/32').run();
    expect(run).toHaveBeenLastCalledWith('setGrid', 32, false);
    gridMenu(STATE, run).find((i) => i.label === 'Triplet').run();
    expect(run).toHaveBeenLastCalledWith('setGrid', 16, true);
    const sections = sectionsMenu([{id: 'bar-0', label: 'Intro', bar: 0}, {id: 'bar-4', label: 'Verse', bar: 4}], run);
    expect(sections.map((i) => i.label)).toEqual(['Intro · Bar 1', 'Verse · Bar 5']);
    sections[1].run();
    expect(run).toHaveBeenLastCalledWith('goToBar', 4);
  });
});

describe('kit pad bank (iPad portrait)', () => {
  afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); restoreDomShims(); });

  test('4 rows × 7 pads: the 27 kit pieces and Skip, grouped by family colour, then ◂ ▸', () => {
    const run = vi.fn();
    const bank = createKitBank({run});
    document.body.append(bank.el);
    const rows = [...bank.el.querySelectorAll('.chart-bank-row')];
    expect(rows.map((r) => r.querySelectorAll('button').length)).toEqual([7, 7, 7, 7]);
    const kits = [...bank.el.querySelectorAll('[data-kit]')].map((b) => b.dataset.kit);
    expect(kits.sort()).toEqual(KIT.map((k) => k.id).sort());
    expect(BANK_ROWS.flat().at(-1)).toBe('skip');
    for (const b of bank.el.querySelectorAll('[data-kit]')) {
      const kit = KIT.find((k) => k.id === b.dataset.kit);
      expect(nameOf(b)).toBe(kit.name);
      expect(b.dataset.family).toBe(kit.family);
    }
    bank.el.querySelector('[data-kit=snare]').click();
    expect(run).toHaveBeenLastCalledWith('pad', 'snare');
    bank.el.querySelector('.chart-bank-skip').click();
    expect(run).toHaveBeenLastCalledWith('skip');
    const [back, forward] = bank.el.querySelectorAll('.chart-bank-step');
    expect([nameOf(back), nameOf(forward)]).toEqual([COPY.stepBack, COPY.stepForward]);
    back.click();
    expect(run).toHaveBeenLastCalledWith('cursor', -1);
    forward.click();
    expect(run).toHaveBeenLastCalledWith('cursor', 1);
    bank.update({piece: {id: 'kick'}});
    expect(bank.el.querySelector('[data-kit=kick]').getAttribute('aria-pressed')).toBe('true');
    bank.update({piece: {id: 'snare'}});
    expect(bank.el.querySelector('[data-kit=kick]').getAttribute('aria-pressed')).toBe('false');
    bank.destroy();
  });

  test('a long-press auditions without writing', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const bank = createKitBank({run});
    document.body.append(bank.el);
    const pad = bank.el.querySelector('[data-kit=ride]');
    pad.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, isPrimary: true, button: 0, pointerId: 1, pointerType: 'touch', clientX: 5, clientY: 5}));
    vi.advanceTimersByTime(PAD_LONG_PRESS_MS + 10);
    pad.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, isPrimary: true, button: 0, pointerId: 1, pointerType: 'touch', clientX: 5, clientY: 5}));
    pad.click();
    expect(run.mock.calls).toEqual([['audition', 'ride']]);
    bank.destroy();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// chart-edit.js on a real song session. Its Part ▾ → Drum part from file… imports ED4's
// src/edit/drum-import.js (same wave); vitest cannot mock a module that does not exist yet
// (Appendix C item 60), so this suite runs once that file is present (always at integration).

const DRUM_IMPORT = join(process.cwd(), 'src/edit/drum-import.js');
const drumImport = vi.hoisted(() => ({calls: [], result: {count: 12, skipped: 2, warnings: []}, fail: null}));
vi.mock('../src/edit/drum-import.js', () => ({
  importDrumPartFromFile: async (file, options) => {
    drumImport.calls.push([file, options]);
    if (drumImport.fail) throw drumImport.fail;
    return drumImport.result;
  },
}));

describe.skipIf(!existsSync(DRUM_IMPORT))('chart-edit.js (mounted on a song session)', () => {
  let mod, clock, restoreAudio, current;
  beforeEach(async () => {
    const audio = await import('./helpers/fake-audio.js');
    const {clock: appClock} = await import('../src/app/clock.js');
    vi.useFakeTimers(audio.FAKE_TIMERS);
    vi.setSystemTime(Date.parse('2026-10-28T12:00:00Z'));
    appClock.set();
    restoreAudio = audio.installFakeAudio();
    clock = audio.createClock();
    mod = await import('../src/edit/chart/chart-edit.js');
    views.length = 0;
    drumImport.calls.length = 0;
    drumImport.fail = null;
    current = [];
  });
  afterEach(async () => {
    for (const off of current.splice(0).reverse()) await off();
    document.body.replaceChildren();
    restoreDomShims();
    restoreAudio();
    vi.useRealTimers();
  });

  async function bed({layout = 'wide', score, query = {}, shared = false, withEdit = true, openPart: open} = {}) {
    const {createTestSession, settle} = await import('./helpers/test-session.js');
    const {demoScore} = await import('./fixtures/drum-score.js');
    const ts = await createTestSession({clock, score: score === null ? null : score ?? demoScore(128, 120), ...(shared ? {shared: {token: 'share-1'}} : {}), ...(open ? {openPart: open} : {})});
    const registry = createRegistry();
    const commands = defineChartCommands({registry});
    const setDrumKeys = vi.fn((keys) => commands.setDrumKeys(keys));
    const router = {calls: [], navigate(path, opts) { this.calls.push([path, opts]); }};
    registry.provide('router', () => router);
    const stopDispatch = startDispatcher({registry, platform: 'win'});
    registry.provide('posture', () => 'edit');
    registry.provide('edit', () => ({tab: 'chart'}));
    const panel = document.createElement('div');
    const inspectorEl = document.createElement('div');
    document.body.append(panel, inspectorEl);
    const edit = withEdit ? {saveStatus: signal(null), layout: signal(layout), setTab: vi.fn()} : null;
    const prefs = memoryPrefs({edit: {chart: {view: 'score', paging: 'pages', keys: {}}}});
    const files = [];
    const view = mod.mount(panel, {session: ts.session, query, inspectorEl, edit, registry, prefs, commands: {setDrumKeys},
      chooseFile: async () => files.shift() ?? null});
    await view.ready;
    await settle();
    current.push(async () => { view.destroy(); stopDispatch(); commands.off(); await ts.dispose(); });
    return {ts, registry, router, panel, inspectorEl, edit, prefs, view, files, setDrumKeys, settle, ws: () => view.workspace};
  }

  test('mounts the workspace, provides it as the chart context, and shows the save status in the posture bar', async () => {
    const b = await bed();
    expect(b.view.root.dataset.state).toBe('ready');
    expect(b.registry.context().chart).toBe(b.ws());
    expect(b.panel.querySelector('[role=toolbar]')).toBeTruthy();
    expect(b.panel.querySelector('.chart-tool-save')).toBeNull();   // the posture bar shows it
    expect(b.edit.saveStatus.value).toMatchObject({state: 'saved'});
    expect(['Saved', 'Local development fixture']).toContain(b.edit.saveStatus.value.text);
    expect(b.setDrumKeys).toHaveBeenCalledWith({});
    expect(document.activeElement).toBe(b.ws().surface);
    // The score's labels follow the desk minimums (spec §8.1), not score-view's 1.9 defaults (11/15).
    expect(views.at(-1).options.fonts).toEqual({barNumber: 12, marker: 15});
    b.view.destroy();
    expect(b.registry.context().chart).toBeFalsy();
    expect(b.edit.saveStatus.value).toBeNull();
  });

  test('saveStatusOf maps the part status to the posture bar: Review on a conflict, Retry offline', () => {
    const run = vi.fn();
    expect(mod.saveStatusOf({status: 'saving', statusText: 'Saving…'}, run)).toEqual({state: 'saving', text: 'Saving…'});
    expect(mod.saveStatusOf({status: 'local', statusText: 'Saved on this device'}, run)).toEqual({state: 'local', text: 'Saved on this device'});
    const conflict = mod.saveStatusOf({status: 'conflict', statusText: 'Another version exists · edits kept here', recovery: 'resolve'}, run);
    expect(conflict).toMatchObject({state: 'conflict', action: {label: 'Review'}});
    conflict.action.run();
    expect(run).toHaveBeenLastCalledWith('resolve');
    const offline = mod.saveStatusOf({status: 'offline', statusText: 'Waiting for connection · edits kept here', recovery: 'retry'}, run);
    expect(offline).toMatchObject({state: 'error', action: {label: 'Retry'}});
    offline.action.run();
    expect(run).toHaveBeenLastCalledWith('retry-save');
  });

  test('laptop: the inspector tabs Kit · Properties · Listen live in the frame’s inspector', async () => {
    const b = await bed();
    const tabs = [...b.inspectorEl.querySelectorAll('[role=tab]')];
    expect(tabs.map(nameOf)).toEqual(['Kit', 'Properties', 'Listen']);
    const panels = [...b.inspectorEl.querySelectorAll('[role=tabpanel]')];
    expect(panels.map((p) => p.hidden)).toEqual([false, true, true]);
    expect(panels[0].querySelectorAll('[data-kit]')).toHaveLength(KIT.length);
    tabs[2].click();
    await b.settle();
    expect(b.ws().state().inspectorTab).toBe('listen');
    expect(panels.map((p) => p.hidden)).toEqual([true, true, false]);
    expect(b.panel.querySelector('.chart-edit-bank').hidden).toBe(true);
    // Each pad shows its key letter (spec §5.2).
    expect(panels[0].querySelector('[data-kit=snare] kbd').textContent).toBe('S');
  });

  test('iPad portrait: the inspector stays empty, each tab opens as a sheet, and the kit bank docks below', async () => {
    const b = await bed({layout: 'portrait'});
    expect(b.inspectorEl.childElementCount).toBe(0);
    const bank = b.panel.querySelector('.chart-edit-bank');
    expect(bank.hidden).toBe(false);
    expect(bank.querySelectorAll('.chart-bank-pad')).toHaveLength(28);
    const dock = b.panel.querySelector('.chart-edit-dock');
    expect(dock.firstElementChild.classList.contains('chart-edit-tools')).toBe(true);   // score on top, then the toolbar
    const props = [...b.panel.querySelectorAll('.chart-edit-panel-button')].find((x) => nameOf(x) === 'Properties');
    props.click();
    await b.settle();
    const sheet = document.querySelector('dialog.chart-edit-sheet');
    expect(sheet).toBeTruthy();
    expect(sheet.querySelector('.chart-edit-panel-properties [data-layout=split]')).toBeTruthy();
    expect(props.getAttribute('aria-expanded')).toBe('true');
    b.edit.layout.value = 'wide';
    await b.settle();
    expect(b.inspectorEl.querySelectorAll('[role=tab]')).toHaveLength(3);
    expect(bank.hidden).toBe(true);
  });

  test('a pad in the bank writes at the cursor through the workspace', async () => {
    const b = await bed({layout: 'portrait'});
    const before = b.ts.session.notation.part.score.bars.flatMap((x) => x.hits).length;
    b.panel.querySelector('.chart-bank-pad[data-kit=cowbell]').click();
    const after = b.ts.session.notation.part.score.bars.flatMap((x) => x.hits);
    expect(after.length).toBe(before + 1);
    expect(after.some((h) => h.instrument === 'cowbell')).toBe(true);
  });

  test('Recorded drums In/Out is the Mix sheet’s switch, both ways', async () => {
    const b = await bed();
    b.ws().run('setInspectorTab', 'listen');
    const listen = b.inspectorEl.querySelector('.chart-edit-panel-listen');
    listen.querySelector('[data-recorded=out]').click();
    await b.settle();
    const drums = () => b.ts.session.transport.snapshot.peek().mix.tracks.find((t) => t.name === 'drums');
    expect(drums().muted).toBe(true);
    b.ts.session.transport.setMuted('drums', false);
    await b.settle();
    expect(listen.querySelector('[data-recorded=in]').getAttribute('aria-pressed')).toBe('true');
  });

  test('Listen persists across postures: it lives on the session’s notation', async () => {
    const b = await bed();
    b.ws().run('listen', 'notation');
    expect(b.ts.session.notation.listenMode).toBe('notation');
    b.view.destroy();
    expect(b.ts.session.notation.listenMode).toBe('notation');
    const again = mod.mount(document.createElement('div'), {session: b.ts.session, registry: b.registry, prefs: b.prefs, commands: null});
    await again.ready;
    expect(again.workspace.state().listen.mode).toBe('notation');
    again.destroy();
  });

  test('?bar=N places the cursor on bar N, and 16-bar pages hold it', async () => {
    const b = await bed({query: {bar: '21'}});
    expect(b.ws().state().barRange).toEqual([20, 20]);
    expect(b.ws().state().range).toMatchObject({first: 16, last: 31});
    expect(views.at(-1).ranges.at(-1)).toEqual([16, 31]);
  });

  test('Bar meter & label… and Align in tempo map… switch to Edit · Map at the bar (replace)', async () => {
    const b = await bed({query: {bar: '5'}});
    b.registry.run('chart.barMeter');
    expect(b.router.calls.at(-1)).toEqual([`/s/${b.ts.id}/edit/map?bar=5`, {replace: true}]);
    b.registry.run('chart.align');
    expect(b.router.calls.at(-1)).toEqual([`/s/${b.ts.id}/edit/map?bar=5`, {replace: true}]);
  });

  test('Part ▾ → Drum part from file… imports through drum-import.js and reports the count', async () => {
    const b = await bed();
    const file = new File(['x'], 'groove.mid');
    b.files.push(file);
    b.registry.run('chart.importDrums');
    await b.settle();
    expect(drumImport.calls).toEqual([[file, {session: b.ts.session}]]);
    expect(b.panel.querySelector('.chart-edit-message').textContent).toBe(COPY.imported(12, 2));
    drumImport.fail = new Error('This file has no drum part.');
    b.files.push(file);
    b.registry.run('chart.importDrums');
    await b.settle();
    expect(b.panel.querySelector('.chart-edit-message').textContent).toBe('This file has no drum part.');
  });

  test('Drum keys… saves to prefs and re-registers the drum letters; a reserved key is refused inline', async () => {
    const b = await bed();
    b.registry.run('chart.drumKeys');
    await b.settle();
    const form = document.querySelector('dialog form');
    form.querySelector('[name=crash]').value = 'N';
    form.dispatchEvent(new Event('submit', {cancelable: true}));
    await b.settle();
    expect(document.querySelector('dialog [role=alert]').textContent).toMatch(/kept for the score/);
    form.querySelector('[name=crash]').value = '';
    form.dispatchEvent(new Event('submit', {cancelable: true}));
    await b.settle();
    expect(b.prefs.data.edit.chart.keys.crash).toBe('');
    expect(b.setDrumKeys).toHaveBeenLastCalledWith(expect.objectContaining({crash: '', snare: 'KeyS'}));
    expect(b.registry.get('chart.piece.crash').keys).toEqual([]);
  });

  test('Esc with nothing selected reaches Done through the posture (the surface clears first)', async () => {
    const b = await bed();
    const done = vi.fn();
    b.registry.register({id: 'test.done', title: 'Done', group: 'Edit', keys: ['Escape'], scopes: ['edit'], run: done});
    b.ws().run('write');
    expect(b.ws().state().selectedCount).toBe(1);
    press('Escape', {}, b.ws().surface);
    expect(b.ws().state().selectedCount).toBe(0);
    expect(done).not.toHaveBeenCalled();
    press('Escape', {}, b.ws().surface);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test('a shared song shows why it cannot be edited; a failed open offers Try again', async () => {
    const shared = await bed({shared: true, score: null});
    expect(shared.view.root.dataset.state).toBe('read-only');
    expect(shared.panel.textContent).toContain(COPY.readOnly);
    // The session's own open (step 5) and Edit · Chart's both fail; Try again opens it.
    let failures = 2;
    const {openPart: realOpen} = await import('../src/js/notation/part.js');
    const b = await bed({openPart: async (o) => { if (failures > 0) { failures -= 1; throw new Error('offline'); } return realOpen(o); }});
    expect(b.view.root.dataset.state).toBe('error');
    const retry = [...b.panel.querySelectorAll('button')].find((x) => nameOf(x) === COPY.tryAgain);
    retry.click();
    await b.settle();
    expect(b.view.root.dataset.state).toBe('ready');
  });
});
