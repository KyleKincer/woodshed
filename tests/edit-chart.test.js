// @vitest-environment happy-dom
// Edit · Chart (ED5): the commands (src/edit/chart/commands.js: architecture §3.4 scopes Ec and Ecs,
// D18, D45, D56), the toolbar, menus and kit bank, the score's stop scope through the real
// dispatcher, the Drum keys validation, and chart-edit.js mounted on a real song session.
// The editor's internals are covered by notation-editor.test.js and notation-songmap.test.js;
// engraving and geometry are Playwright states (tests/fixture/states/ED5.cjs).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

// alphaTab cannot lay out in happy-dom: a fake view records what the editor asks it to draw.
const views = vi.hoisted(() => []);
vi.mock('../src/js/notation/score-view.js', () => ({createScoreView: (host, options = {}) => {
  const stage = document.createElement('div');
  host.replaceChildren(stage);
  let score = null;
  const view = {host, stage, options, ready: true, ranges: [], scoreOptions: [], configured: [], get score() { return score; },
    setScore(next, opts = {}) { score = next; view.ranges.push(opts.range); view.scoreOptions.push(opts); options.onRender?.(view); },
    setOptions() {}, setScale() {}, setBarsPerRow() {}, setBarMarks() {}, setCaret() {}, setSelection() {}, setPlayhead() {}, setLoop() {},
    setRange() {}, setMarks() {}, configure(next) { view.configured.push(next); return true; }, relayout() { options.onRender?.(view); },
    noteBoxes: () => [], barBounds: () => null, barsBetween: () => null, barAt: () => 0, rendered: () => true, destroy() {}};
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
import {COPY, CONTROLS, STATUS_CONTROLS, editMenu, gridMenu, partMenu, rollMenu, sectionsMenu, tupletMenu} from '../src/edit/chart/menus.js';
import {ARTICULATIONS, STEP_BUTTONS, STEP_ICONS, createToolbar} from '../src/edit/chart/toolbar.js';
import {createNavigator} from '../src/edit/chart/navigator.js';
import {createStatusBar} from '../src/edit/chart/statusbar.js';
import {BANK_ROWS, PAD_LONG_PRESS_MS, createKitBank} from '../src/edit/chart/kit-bank.js';
import {ZOOM_STEPS, createNotationWorkspace, padGlyph, padHead, scoreFonts, sectionsOf, snapZoom} from '../src/js/notation/editor.js';
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
  ['chart.sectionPrev', ['['], [EC, ECS]],
  ['chart.sectionNext', [']'], [EC, ECS]],
  ['chart.loopSelection', ['KeyL'], [EC]],
  ['chart.firstBar', ['Mod+Home'], [ECS]],
  ['chart.lastBar', ['Mod+End'], [ECS]],
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
  'chart.partLayout', 'chart.listen', 'chart.playCursor', 'chart.fit', 'chart.follow', 'chart.retrySave', 'chart.resolve',
  'chart.zoomIn', 'chart.zoomOut', 'chart.zoomReset', 'chart.lineBreak', 'chart.clearLineBreaks',
  'chart.flam', 'chart.drag', 'chart.stickingRight', 'chart.stickingLeft'];

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

  test('PageUp and PageDown are the browser’s: they scroll the sheet, and nothing here takes them', () => {
    const before = workspace.state().position;
    for (const k of ['PageDown', 'PageUp']) {
      const e = press(k);
      expect(e.defaultPrevented, k).toBe(false);
    }
    expect(workspace.state().position).toBe(before);
    expect(outer).toEqual([]);
    expect(registry.bindingsFor(EC).has('PageDown') || registry.bindingsFor(ECS).has('PageDown')).toBe(false);
  });

  test('[ and ] jump by section with the score focused, and ⌘Home / ⌘End go to the first and last bar', () => {
    part.editor.transact((s) => { s.timeline.measures[4].label = 'Verse'; s.timeline.measures[12].label = 'Chorus'; });
    part.commit();
    const bar = () => workspace.state().cursorBar;
    expect(workspace.state().sections.map((s) => [s.label, s.bar, s.bars])).toEqual([['', 0, 4], ['Verse', 4, 8], ['Chorus', 12, workspace.state().total - 12]]);
    press(']');
    expect(bar()).toBe(4);
    press(']');
    expect(bar()).toBe(12);
    press(']');
    expect(bar()).toBe(12);                      // no section after the last
    press('ArrowRight');                         // inside the section: [ goes to its start first
    press('[');
    expect(bar()).toBe(12);
    expect(workspace.state().position).toBe('Bar 13 · Beat 1.00');
    press('[');
    expect(bar()).toBe(4);
    press('End', {ctrlKey: true});
    expect(bar()).toBe(workspace.state().total - 1);
    press('Home', {ctrlKey: true});
    expect(bar()).toBe(0);
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
  ready: true, layout: 'score', inspectorTab: 'kit',
  step: {value: 8, dotted: false, tuplet: 1}, grid: {value: 16, triplet: false},
  piece: {id: 'snare', name: 'Snare', short: 'SD', key: 'KeyS'}, selectedCount: 0, canClear: false,
  total: 64, cursorBar: 16, section: 2, sections: [{id: 'bar-0', label: 'Intro', bar: 0, bars: 8}, {id: 'bar-8', label: 'Verse', bar: 8, bars: 8},
    {id: 'bar-16', label: 'Chorus', bar: 16, bars: 48}],
  zoom: 1, canZoomIn: true, canZoomOut: true, lineBreak: false, lineBreaks: 0, hint: 'Double-click the staff or press a drum key to add',
  selectionLabel: '', playing: false,
  barLabel: 'Bar 17', barRange: [16, 16], position: 'Bar 17 · Beat 1.00',
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
    // A button whose command has a key says so (aria-keyshortcuts); Flam, Drag, the stickings and Fit have none.
    if (command && role === 'button') expect(matches.some((el) => el.getAttribute('aria-keyshortcuts') !== null)).toBe(registry.get(command).keys.length > 0);
  });

  test('the toolbar holds what the table lists, in its order, and nothing else', () => {
    const controls = [...toolbar.el.querySelectorAll('button, [role=radio]')].filter((el) => !el.closest('.chart-tool-save'));
    expect(controls.map(nameOf)).toEqual(CONTROLS.filter((c) => c.role !== 'radiogroup').map((c) => c.name));
    // Undo and Redo are the posture bar's, the view switch and zoom the status bar's, sections the navigator's.
    for (const gone of ['.chart-tool-history', '.chart-tool-range', '.chart-tool-writing', '.chart-tool-view', '[data-menu=view]', '[data-menu=sections]']) {
      expect(toolbar.el.querySelector(gone), gone).toBeNull();
    }
  });

  test('the step buttons are the note values as glyphs, quarter to 64th, with key-cap hints 5·4·3·2·1', () => {
    const steps = [...toolbar.el.querySelectorAll('.chart-tool-step')];
    expect(steps.map((b) => b.querySelector('svg.ui-icon').dataset.icon)).toEqual(['note-quarter', 'note-eighth', 'note-sixteenth', 'note-thirty-second', 'note-sixty-fourth']);
    expect(STEP_BUTTONS.map((s) => STEP_ICONS[s.value])).toEqual(steps.map((b) => b.querySelector('svg.ui-icon').dataset.icon));
    expect(steps.map(nameOf)).toEqual(['Quarter step', 'Eighth step', 'Sixteenth step', '32nd step', '64th step']);
    expect(steps.map((b) => b.querySelector('kbd[data-hint]')?.dataset.keys)).toEqual(['Digit5', 'Digit4', 'Digit3', 'Digit2', 'Digit1']);
    expect(steps.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false', 'false']);
    steps[0].click();
    expect(chart.run).toHaveBeenCalledWith('step', 5);
  });

  test('the articulations show the selected notes (or the next note) and toggle through their commands', async () => {
    const buttons = () => Object.fromEntries(ARTICULATIONS.map(([key]) => [key, toolbar.el.querySelector(`[data-expression=${key}]`)]));
    expect(Object.values(buttons()).map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'false', 'false']);
    expect(ARTICULATIONS.map(([, , icon]) => icon)).toEqual(Object.values(buttons()).map((b) => b.querySelector('svg.ui-icon').dataset.icon));
    chart.state = () => ({...STATE, expression: {...STATE.expression, accent: true, flam: true, sticking: 'L', roll: 2}});
    registry.invalidate();
    toolbar.update(chart.state());
    await vi.waitFor(() => expect(buttons().accent.getAttribute('aria-pressed')).toBe('true'));   // the registry recomputes on a timer
    expect(Object.entries(buttons()).filter(([, b]) => b.getAttribute('aria-pressed') === 'true').map(([key]) => key)).toEqual(['accent', 'flam']);
    expect(toolbar.el.querySelector('[data-sticking=L]').getAttribute('aria-pressed')).toBe('true');
    expect(toolbar.el.querySelector('[data-sticking=R]').getAttribute('aria-pressed')).toBe('false');
    const roll = toolbar.el.querySelector('[data-menu=roll]');
    expect(roll.hasAttribute('data-active')).toBe(true);
    expect(roll.querySelector('.ui-button-label').textContent).toBe('×2');
    expect(nameOf(roll)).toBe('Roll');
    buttons().ghost.click();
    expect(chart.run).toHaveBeenLastCalledWith('ghost');
    buttons().drag.click();
    expect(chart.run).toHaveBeenLastCalledWith('drag');
    toolbar.el.querySelector('[data-sticking=R]').click();
    expect(chart.run).toHaveBeenLastCalledWith('sticking', 'R');
  });

  test('Tuplet ▾ is its glyph while straight and names the tuplet once one is chosen', () => {
    const tuplet = toolbar.el.querySelector('[data-menu=tuplet]');
    expect(tuplet.querySelector('.ui-button-label').textContent).toBe('');
    expect(tuplet.hasAttribute('data-active')).toBe(false);
    expect(nameOf(tuplet)).toBe('Tuplet');
    toolbar.update({...STATE, step: {value: 8, dotted: false, tuplet: 3}});
    expect(tuplet.querySelector('.ui-button-label').textContent).toBe('Triplet');
    expect(tuplet.hasAttribute('data-active')).toBe(true);
    expect(nameOf(tuplet)).toBe('Tuplet');
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
    for (const name of ['tuplet', 'roll', 'edit', 'part', 'grid']) {
      t.el.querySelector(`[data-menu=${name}]`).click();
      expect(openMenu).toHaveBeenLastCalledWith(name, t.el.querySelector(`[data-menu=${name}]`));
    }
    t.destroy();
  });
});

describe('status bar', () => {
  let registry, chart, bar, openMenu;
  beforeEach(() => {
    registry = createRegistry();
    defineChartCommands({registry});
    chart = {state: () => STATE, run: vi.fn()};
    registry.provide('chart', () => chart);
    openMenu = vi.fn();
    bar = createStatusBar({registry, openMenu});
    document.body.append(bar.el);
    bar.update(STATE);
  });
  afterEach(() => { bar.destroy(); document.body.replaceChildren(); restoreDomShims(); });

  test('its controls, left to right: Go to, Follow, Score · Lanes, Zoom out, the percentage, Zoom in', () => {
    const controls = [...bar.el.querySelectorAll('button, [role=radio]')];
    // The position's name holds its visible text ("Go to: Bar 17 · Beat 1.00").
    expect(controls.map((el) => nameOf(el).replace(/^Go to: .*/, 'Go to'))).toEqual(STATUS_CONTROLS.filter((c) => c.role !== 'radiogroup').map((c) => c.name));
    expect(nameOf(bar.el.querySelector('.chart-status-position'))).toBe('Go to: Bar 17 · Beat 1.00');
    expect(bar.el.querySelector('[role=radiogroup]').getAttribute('aria-label')).toBe('View');
  });

  test('the position opens the Go to menu; the piece shows its key', () => {
    const position = bar.el.querySelector('.chart-status-position');
    expect(position.querySelector('.ui-button-label').textContent).toBe('Bar 17 · Beat 1.00');
    position.click();
    expect(openMenu).toHaveBeenCalledWith('sections', position);
    expect(bar.el.querySelector('.chart-status-piece').textContent.replace(/\s+/g, ' ').trim()).toBe('Writing Snare S');
    bar.update({...STATE, piece: {id: 'crashChoke', name: 'Crash (choke)', short: 'Crash ✕', key: ''}});
    expect(bar.el.querySelector('.chart-status-piece kbd').hidden).toBe(true);
  });

  test('the message: what the editor said, else the selection, else the hint (quieter)', () => {
    const message = bar.el.querySelector('.chart-status-message');
    expect(message.getAttribute('aria-live')).toBe('polite');
    expect([message.textContent, message.hasAttribute('data-hint')]).toEqual([STATE.hint, true]);
    bar.update({...STATE, selectionLabel: '3 notes selected'});
    expect([message.textContent, message.hasAttribute('data-hint')]).toEqual(['3 notes selected', false]);
    bar.say('Looping bars 5–8.');
    expect([message.textContent, message.hasAttribute('data-hint')]).toEqual(['Looping bars 5–8.', false]);
    bar.say('');
    expect(message.textContent).toBe('3 notes selected');
  });

  test('Follow shows only while the song plays; the view switch runs chart.view; zoom shows in Score', () => {
    const follow = bar.el.querySelector('.chart-status-follow');
    expect(follow.hidden).toBe(true);
    bar.update({...STATE, playing: true, follow: false});
    expect(follow.hidden).toBe(false);
    follow.click();
    expect(chart.run).toHaveBeenLastCalledWith('follow');
    bar.el.querySelector('[role=radio]:not([aria-checked=true])').click();
    expect(chart.run).toHaveBeenLastCalledWith('view', 'lanes');
    const zoom = bar.el.querySelector('.chart-status-zoom');
    expect(zoom.hidden).toBe(false);
    bar.update({...STATE, zoom: 1.25});
    expect(zoom.querySelector('.chart-status-zoom-value .ui-button-label').textContent).toBe('125%');
    expect(nameOf(zoom.querySelector('.chart-status-zoom-value'))).toBe('Zoom to 100%, now 125%');
    bar.update({...STATE, layout: 'lanes'});
    expect(zoom.hidden).toBe(true);
  });
});

describe('section navigator', () => {
  afterEach(() => { document.body.replaceChildren(); restoreDomShims(); });

  test('one segment per section, as wide as its share of the bars; a click goes to its first bar and moves the cue', () => {
    const run = vi.fn();
    const nav = createNavigator({run});
    document.body.append(nav.el);
    nav.update(STATE);
    const sections = [...nav.el.querySelectorAll('.chart-nav-section')];
    expect(nav.el.getAttribute('aria-label')).toBe('Sections');
    expect(sections.map((b) => [b.querySelector('.chart-nav-name').textContent, b.querySelector('.chart-nav-bar').textContent, b.style.flexGrow]))
      .toEqual([['Intro', '1', '8'], ['Verse', '9', '8'], ['Chorus', '17', '48']]);
    expect(sections.map(nameOf)).toEqual(['Intro, bars 1 to 8', 'Verse, bars 9 to 16', 'Chorus, bars 17 to 64']);
    expect(sections.map((b) => b.getAttribute('aria-current'))).toEqual([null, null, 'true']);
    sections[1].click();
    expect(run).toHaveBeenLastCalledWith('goToBar', 8, {seek: true});
    nav.update({...STATE, cursorBar: 3, section: 0});
    expect(sections.map((b) => b.getAttribute('aria-current'))).toEqual(['true', null, null]);
    nav.destroy();
  });

  test('a song with no section names is one segment, "Bars 1–64"; an unnamed opening before named sections is "Start"', () => {
    const nav = createNavigator({run: vi.fn()});
    document.body.append(nav.el);
    nav.update({...STATE, sections: [{id: 'bar-0', label: '', bar: 0, bars: 64}], section: 0});
    expect([...nav.el.querySelectorAll('.chart-nav-section')].map((b) => b.textContent)).toEqual(['Bars 1–64']);
    nav.update({...STATE, sections: [{id: 'bar-0', label: '', bar: 0, bars: 4}, {id: 'bar-4', label: 'Verse', bar: 4, bars: 60}], section: 0});
    expect([...nav.el.querySelectorAll('.chart-nav-name')].map((b) => b.textContent)).toEqual(['Start', 'Verse']);
    nav.update({...STATE, total: 0, sections: []});
    expect(nav.el.hidden).toBe(true);
    nav.destroy();
  });

  test('the marks: the bars on screen, the cursor and the playhead', () => {
    const nav = createNavigator({run: vi.fn()});
    document.body.append(nav.el);
    nav.update(STATE);
    const mark = (name) => nav.el.querySelector(`.chart-nav-${name}`);
    expect(mark('window').hidden).toBe(true);
    expect(mark('cursor').hidden).toBe(false);
    expect(mark('now').hidden).toBe(true);
    nav.setViewport({first: 8, last: 19});
    expect(mark('window').hidden).toBe(false);
    nav.setViewport({first: 0, last: 63});      // the whole song on screen needs no window
    expect(mark('window').hidden).toBe(true);
    nav.setViewport(null);
    expect(mark('window').hidden).toBe(true);
    nav.setPlayhead(12.5);
    expect(mark('now').hidden).toBe(false);
    nav.setPlayhead(null);
    expect(mark('now').hidden).toBe(true);
    nav.destroy();
  });
});

describe('the sheet’s helpers (src/js/notation/editor.js)', () => {
  test('sectionsOf: the first bar and every labelled bar start a section', () => {
    const score = emptyScore(32);
    const m = score.timeline.measures;
    expect(sectionsOf(score.timeline)).toEqual([{id: 'bar-0', label: '', bar: 0, bars: m.length}]);
    m[0].label = 'Intro'; m[4].label = 'Verse';
    expect(sectionsOf(score.timeline)).toEqual([{id: 'bar-0', label: 'Intro', bar: 0, bars: 4}, {id: 'bar-4', label: 'Verse', bar: 4, bars: m.length - 4}]);
    expect(sectionsOf(null)).toEqual([]);
  });

  test('zoom steps run 60% to 200% through 100%; a stored value snaps to the nearest', () => {
    expect(ZOOM_STEPS[0]).toBe(0.6);
    expect(ZOOM_STEPS.at(-1)).toBe(2);
    expect(ZOOM_STEPS).toContain(1);
    expect([snapZoom(1.3), snapZoom(0.1), snapZoom(9), snapZoom('x'), snapZoom(undefined)]).toEqual([1.25, 0.6, 2, 1, 1]);
  });

  test('scoreFonts: bar numbers and section names keep 12 px and 15 px on screen below 100%, and grow above it', () => {
    expect(scoreFonts(1)).toEqual({barNumber: 12, marker: 15});
    expect(scoreFonts(2)).toEqual({barNumber: 12, marker: 15});
    expect(scoreFonts(0.6)).toEqual({barNumber: 20, marker: 25});
  });

  test('a pad’s picture is its notehead on the staff: crosses for cymbals, a diamond bell, a triangle cowbell', () => {
    const head = (id) => padHead(KIT.find((k) => k.id === id));
    expect(['snare', 'kick', 'tom1', 'closedHat', 'crash', 'openHat', 'rideBell', 'cowbell', 'crossStick', 'pedalHat', 'rimshot'].map(head))
      .toEqual(['oval', 'oval', 'oval', 'cross', 'cross', 'circle-cross', 'diamond', 'triangle', 'cross', 'cross', 'slash']);
    for (const kit of KIT) {
      const svg = padGlyph(kit);
      expect(svg, kit.id).toMatch(/^<svg class="notation-pad-glyph"[^>]*aria-hidden="true"/);
      expect((svg.match(/class="pad-staff"/g) ?? []).length, kit.id).toBeGreaterThanOrEqual(5);
    }
    // The snare sits in the third space, the kick in the bottom one: lower on the picture.
    const y = (id) => Number(/<ellipse class="pad-fill" cx="14" cy="([\d.]+)"/.exec(padGlyph(KIT.find((k) => k.id === id)))[1]);
    expect(y('kick')).toBeGreaterThan(y('snare'));
    expect(padGlyph(KIT.find((k) => k.id === 'crashChoke'))).toContain('v4.2');   // the stopped mark
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
      {label: 'Select all bars', kbd: 'Mod+KeyA'}, {label: 'Delete selected notes', kbd: 'Backspace'},
      {label: 'Move notes…', kbd: 'Alt+ArrowLeft'}, {label: 'Tuplet on this beat…', kbd: null}, {label: 'Mark bars reviewed', kbd: null},
      {label: 'Loop selection', kbd: 'KeyL'}, {label: 'New line here', kbd: null}, {label: 'Clear line breaks', kbd: null},
      {label: 'Bar meter & label…', kbd: null}, {label: 'Align in tempo map…', kbd: null},
    ]);
    // New line here: bar 1 always starts a line; a chart with no breaks has none to clear.
    expect(registry.state('chart.lineBreak').reason).toBeFalsy();
    expect(registry.state('chart.clearLineBreaks').reason).toBe(COMMAND_COPY.clearLineBreaksReason);
  });

  test('Part ▾: export, print, open part, import a chart, Drum keys…, Note list ✓, Show every kit piece ✓, Keyboard shortcuts ?', () => {
    const items = partMenu({...STATE, showList: true});
    expect(resolved(items).map((i) => i.label)).toEqual(['Export .woodshed.json', 'Print', 'Open .woodshed.json part…',
      'Import a chart from a file…', 'Clear drum chart…', 'Drum keys…', 'Note list', 'Show every kit piece', 'Keyboard shortcuts']);
    expect(items.find((i) => i.command === 'chart.noteList')).toMatchObject({type: 'checkbox', checked: true});
    expect(items.find((i) => i.command === 'chart.shortcuts').kbd).toBe('?');
    expect(registry.state('chart.allLanes').reason).toBe(COMMAND_COPY.allLanesReason);
  });

  test('the 16-bar pages and the paging mode are gone (2.8): the score is the whole song', () => {
    for (const id of ['chart.pagePrev', 'chart.pageNext', 'chart.paging']) expect(registry.get(id), id).toBeFalsy();
  });

  test('Roll ▾: No roll, 1 slash, 2 slashes, 3 slashes', () => {
    const run = vi.fn();
    const items = rollMenu({...STATE, expression: {...STATE.expression, roll: 2}}, run);
    expect(items.map((i) => [i.label, i.checked])).toEqual([['No roll', false], ['1 slash', false], ['2 slashes', true], ['3 slashes', false]]);
    items[3].run();
    expect(run).toHaveBeenLastCalledWith('setExpression', 'roll', 3);
    items[0].run();
    expect(run).toHaveBeenLastCalledWith('setExpression', 'roll', 0);
  });

  test('Tuplet ▾, Grid ▾ and the section jump menu run the workspace', () => {
    const run = vi.fn();
    tupletMenu(STATE, run).find((i) => i.label === 'Triplet').run();
    expect(run).toHaveBeenLastCalledWith('setTuplet', 3);
    gridMenu(STATE, run).find((i) => i.label === '1/32').run();
    expect(run).toHaveBeenLastCalledWith('setGrid', 32, false);
    gridMenu(STATE, run).find((i) => i.label === 'Triplet').run();
    expect(run).toHaveBeenLastCalledWith('setGrid', 16, true);
    // Go to: the jumps with their keys, then every section; a section with no name is "Start".
    const goTo = sectionsMenu([{id: 'bar-0', label: '', bar: 0}, {id: 'bar-4', label: 'Verse', bar: 4}], run);
    expect(goTo.slice(0, 4).map((i) => i.command)).toEqual(['chart.firstBar', 'chart.sectionPrev', 'chart.sectionNext', 'chart.lastBar']);
    const sections = goTo.filter((i) => i.id);
    expect(sections.map((i) => i.label)).toEqual(['Start · Bar 1', 'Verse · Bar 5']);
    sections[1].run();
    expect(run).toHaveBeenLastCalledWith('goToBar', 4, {seek: true});
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
// chart-edit.js on a real song session.

describe('chart-edit.js (mounted on a song session)', () => {
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
    const confirms = [];
    const answers = [];
    const confirm = async (o) => { confirms.push(o); return answers.length ? answers.shift() : true; };
    const view = mod.mount(panel, {session: ts.session, query, inspectorEl, edit, registry, prefs, commands: {setDrumKeys}, confirm});
    await view.ready;
    await settle();
    current.push(async () => { view.destroy(); stopDispatch(); commands.off(); await ts.dispose(); });
    return {ts, registry, router, panel, inspectorEl, edit, prefs, view, confirms, answers, setDrumKeys, settle, ws: () => view.workspace};
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
    // Score on top; docked under it: the status bar, the toolbar, the inspector buttons (with Edit ▾ and Part ▾) and the bank.
    const dock = b.panel.querySelector('.chart-edit-dock');
    expect([...dock.children].map((c) => c.className)).toEqual(['chart-edit-status', 'chart-edit-tools', 'chart-edit-panels', 'chart-edit-bank']);
    expect(b.panel.querySelector('.chart-edit-top').firstElementChild.className).toBe('chart-edit-nav');
    expect(b.panel.querySelector('.chart-edit-panels [data-menu=edit]')).toBeTruthy();
    expect(b.panel.querySelector('.chart-toolbar [data-menu=edit]')).toBeNull();
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
    // Laptop: the toolbar and the navigator stick at the top, the status bar at the bottom; the menus are the toolbar's again.
    expect([...b.panel.querySelector('.chart-edit-top').children].map((c) => c.className)).toEqual(['chart-edit-tools', 'chart-edit-nav']);
    expect(b.panel.querySelector('.chart-toolbar [data-menu=edit]')).toBeTruthy();
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

  test('?bar=N places the cursor on bar N of the whole song (no pages: every bar is engraved)', async () => {
    const b = await bed({query: {bar: '21'}});
    expect(b.ws().state().barRange).toEqual([20, 20]);
    expect(b.ws().state()).toMatchObject({total: 64, cursorBar: 20, position: 'Bar 21 · Beat 1.00'});
    // One engraving of the whole part, with the part's own line breaks (as the Stage draws it).
    expect(views.at(-1).ranges.at(-1)).toBeUndefined();
    expect(views.at(-1).scoreOptions.at(-1)).toEqual({lineBreaks: true});
  });

  test('the navigator shows the song’s sections and jumps to one; the status bar says where the cursor is', async () => {
    const b = await bed();
    const sections = [...b.panel.querySelectorAll('.chart-nav-section')];
    expect(sections.length).toBe(b.ws().state().sections.length);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections[0].getAttribute('aria-current')).toBe('true');
    const target = b.ws().state().sections[2];
    sections[2].click();
    expect(b.ws().state().cursorBar).toBe(target.bar);
    expect(sections[2].getAttribute('aria-current')).toBe('true');
    expect(sections[0].hasAttribute('aria-current')).toBe(false);
    const status = b.panel.querySelector('.chart-status');
    expect(status.querySelector('.chart-status-position .ui-button-label').textContent).toBe(`Bar ${target.bar + 1} · Beat 1.00`);
    expect(status.querySelector('.chart-status-piece').textContent.replace(/\s+/g, ' ').trim()).toMatch(/^Writing \S/);
    // Stopped, the jump moves the cue too, so Play starts from the section.
    expect(b.ts.session.transport.snapshot.peek().cue).toBeCloseTo(target.bar * 2, 3);
  });

  test('what the editor says shows in the status bar; without it, the selection, else the hint', async () => {
    const b = await bed();
    const message = b.panel.querySelector('.chart-status-message');
    expect(message.getAttribute('role')).toBe('status');
    expect(message.textContent).toBe('Double-click the staff or press a drum key to add');
    expect(message.hasAttribute('data-hint')).toBe(true);
    b.ws().run('select-bar');
    expect(message.textContent).toMatch(/notes? selected$/);
    expect(message.hasAttribute('data-hint')).toBe(false);
    b.ws().run('loop');
    expect(message.textContent).toMatch(/^Looping bar/);
  });

  test('zoom: the status bar steps the sheet’s scale, keeps it for the device, and the labels keep their size floor', async () => {
    const b = await bed();
    const zoom = b.panel.querySelector('.chart-status-zoom');
    const [out, value, into] = zoom.querySelectorAll('button');
    expect(value.querySelector('.ui-button-label').textContent).toBe('100%');
    into.click();
    expect(b.ws().state().zoom).toBe(1.1);
    expect(b.prefs.get('edit.chart.zoom')).toBe(1.1);
    expect(value.querySelector('.ui-button-label').textContent).toBe('110%');
    expect(views.at(-1).configured.at(-1)).toEqual({scale: 1.1, fonts: {barNumber: 12, marker: 15}});
    out.click(); out.click(); out.click();
    expect(b.ws().state().zoom).toBe(0.8);
    expect(views.at(-1).configured.at(-1)).toEqual({scale: 0.8, fonts: {barNumber: 15, marker: 19}});   // 12 px and 15 px on screen
    value.click();
    expect(b.ws().state().zoom).toBe(1);
    // In Lanes there is no sheet to zoom.
    b.registry.run('chart.view', {args: {view: 'lanes'}});
    expect(zoom.hidden).toBe(true);
    expect(b.registry.state('chart.zoomIn').reason).toBe(COMMAND_COPY.zoomReason);
  });

  test('New line here starts a line at the cursor’s bar (saved with the part), and Clear line breaks drops them', async () => {
    const b = await bed({query: {bar: '9'}});
    const score = () => b.ts.session.notation.part.score;
    expect(b.registry.state('chart.lineBreak')).toMatchObject({checked: false});
    b.registry.run('chart.lineBreak');
    expect(score().lineBreaks).toEqual([score().timeline.measures[8].id]);
    expect(b.registry.state('chart.lineBreak')).toMatchObject({checked: true});
    b.registry.run('chart.lineBreak');
    expect(score().lineBreaks).toBeUndefined();
    b.registry.run('chart.lineBreak');
    b.registry.run('chart.clearLineBreaks');
    expect(score().lineBreaks).toBeUndefined();
    // Bar 1 always starts a line.
    b.ws().run('goToBar', 0);
    expect(b.registry.state('chart.lineBreak').reason).toBe(COMMAND_COPY.lineBreakReason);
  });

  test('Bar meter & label… and Align in tempo map… switch to Edit · Map at the bar (replace)', async () => {
    const b = await bed({query: {bar: '5'}});
    b.registry.run('chart.barMeter');
    expect(b.router.calls.at(-1)).toEqual([`/s/${b.ts.id}/edit/map?bar=5`, {replace: true}]);
    b.registry.run('chart.align');
    expect(b.router.calls.at(-1)).toEqual([`/s/${b.ts.id}/edit/map?bar=5`, {replace: true}]);
  });

  test('Part ▾ → Import a chart from a file… opens the one import, in Edit · Map, where the chart is lined up', async () => {
    const b = await bed();
    b.registry.run('chart.importDrums');
    await b.settle();
    expect(b.router.calls.at(-1)).toEqual([`/s/${b.ts.id}/edit/map/find?import=1`, undefined]);
  });

  test('Clear drum chart… asks with the counts, clears every note and reviewed mark in one undo step, then is disabled', async () => {
    const b = await bed();
    const part = b.ts.session.notation.part;
    const notes = part.stats.notes;
    expect(notes).toBeGreaterThan(0);
    b.answers.push(false);
    b.registry.run('chart.clearPart');
    await b.settle();
    expect(b.confirms.at(-1)).toMatchObject({title: 'Clear the drum chart?', confirmLabel: 'Clear chart', danger: true});
    expect(b.confirms.at(-1).body).toContain(`all ${notes.toLocaleString('en-US')} notes`);
    expect(part.stats.notes).toBe(notes);
    b.registry.run('chart.clearPart');
    await b.settle();
    expect(part.stats).toEqual({notes: 0, reviewed: 0});
    expect(part.score.bars.every((bar) => bar.coverage === 'unstarted')).toBe(true);
    expect(b.ts.session.notation.hasNotation.peek()).toBe(false);
    expect(b.panel.querySelector('.chart-edit-message').textContent).toBe('Cleared the drum chart. Undo brings it back.');
    expect(b.registry.state('chart.clearPart')).toMatchObject({enabled: false, reason: COMMAND_COPY.clearPartReason});
    b.registry.run('chart.undo');
    await b.settle();
    expect(part.stats.notes).toBe(notes);
    expect(b.registry.state('chart.clearPart').enabled).toBe(true);
  });

  test('⌘A selects the bar, ⌘A again the whole part; Delete removes every note in one undo step', async () => {
    const b = await bed();
    const part = b.ts.session.notation.part;
    const notes = part.stats.notes;
    expect(b.registry.state('chart.delete')).toMatchObject({enabled: false, reason: COMMAND_COPY.deleteReason});
    b.registry.run('chart.selectBar');
    const one = b.ws().state().selectedCount;
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(notes);
    b.registry.run('chart.selectBar');
    expect(b.ws().state().selectedCount).toBe(notes);
    expect(b.ws().state().barRange).toEqual([0, part.score.timeline.measures.length - 1]);
    expect(b.panel.querySelector('.chart-edit-message').textContent).toMatch(/^All \d+ bars selected · [\d,]+ notes\.$/);
    b.registry.run('chart.delete');
    await b.settle();
    expect(part.stats.notes).toBe(0);
    expect(b.panel.querySelector('.chart-edit-message').textContent).toMatch(/^Deleted [\d,]+ notes from Bars 1–\d+\. Undo brings them back\.$/);
    b.registry.run('chart.undo');
    expect(part.stats.notes).toBe(notes);
    // Select all bars is the menu's way to the same selection.
    b.registry.run('chart.selectAll');
    expect(b.ws().state().selectedCount).toBe(notes);
  });

  test('Shift+→ across a bar line makes a bar range; Delete clears its notes, a plain → still moves the cursor', async () => {
    const b = await bed();
    const part = b.ts.session.notation.part;
    const firstBar = part.score.bars.find((bar) => bar.measureId === part.score.timeline.measures[0].id)?.hits.length ?? 0;
    const secondBar = part.score.bars.find((bar) => bar.measureId === part.score.timeline.measures[1].id)?.hits.length ?? 0;
    for (let i = 0; i < 40 && b.ws().state().barRange[1] < 1; i++) b.registry.run('chart.extendFwd');
    expect(b.ws().state().barRange).toEqual([0, 1]);
    expect(b.ws().state().selectedCount).toBe(0);
    expect(b.ws().state().deletable).toBe(firstBar + secondBar);
    const before = part.stats.notes;
    expect(b.registry.run('chart.delete')).toBe(true);
    expect(part.stats.notes).toBe(before - firstBar - secondBar);
    expect(part.score.bars.filter((bar) => [0, 1].includes(part.score.timeline.measures.findIndex((m) => m.id === bar.measureId)))
      .every((bar) => !bar.hits.length)).toBe(true);
    b.registry.run('chart.undo');
    // In Lanes an arrow moves selected notes; a Shift range selects none, so → after it only moves the cursor.
    b.registry.run('chart.view', {args: {view: 'lanes'}});
    expect(b.ws().state().layout).toBe('lanes');
    b.registry.run('chart.clear');
    for (let i = 0; i < 80 && b.ws().state().barRange[1] < 1; i++) b.registry.run('chart.extendFwd');
    const bars = JSON.stringify(part.score.bars);
    b.registry.run('chart.cursorFwd');
    expect(JSON.stringify(part.score.bars)).toBe(bars);
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
