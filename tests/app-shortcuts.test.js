// @vitest-environment happy-dom
// src/app/shortcuts-sheet.js: the ? sheet is generated from the registry, the active scope chain's bindings first,
// grouped in SHEET_GROUPS order; inner bindings mark the outer commands they shadow, and a stop scope marks the keys it
// blocks; the overlay is modal, filterable and closes on Esc, ✕, the backdrop and `?`.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {BOOT_SCOPES, GROUPS, createRegistry} from '../src/app/commands.js';
import {openOverlays, startDispatcher} from '../src/app/dispatch.js';
import {setPlatform} from '../src/app/keys.js';
import {SCOPE_LABELS, SHEET_GROUPS, openShortcuts, sheetLayout, shortcutModel} from '../src/app/shortcuts-sheet.js';
import {store} from '../src/app/store.js';
import {installPopoverShim, keydown, restoreDomShims} from './helpers/dom.js';

let reg, focused, session;

const def = (id, title, group, keys, scopes, extra = {}) => ({id, title, group, keys, scopes, run() {}, ...extra});

beforeEach(() => {
  installPopoverShim();
  setPlatform('mac');
  focused = null;
  session = {id: 'gh'};
  reg = createRegistry({bootScopes: BOOT_SCOPES});
  reg.provide('session', () => session);
  reg.registerMany([
    def('focus.play', 'Play from here', 'Transport', ['Enter'], ['stage.strip', 'stage.bars']),
    def('focus.loop', 'Loop this', 'Loop', ['KeyL'], ['stage.strip', 'stage.bars']),
    def('transport.playStop', 'Play / Stop', 'Transport', ['Space'], ['stage', 'edit']),
    def('transport.again', 'Start again', 'Transport', ['Enter'], ['stage', 'edit.chart']),
    def('transport.loopToggle', 'Loop', 'Loop', ['KeyL'], ['stage']),
    def('nav.prevSection', 'Previous section', 'Navigate', ['[', 'PageUp'], ['stage', 'edit.map']),
    def('click.countIn', 'Count-in', 'Click', ['KeyC'], ['stage', 'edit']),
    def('setlist.next', 'Next song in set', 'Navigate', ['Alt+ArrowDown'], ['stage'], {when: () => false}),
    def('mix.mute.1', 'Mute drums', 'Mix', ['Digit1'], ['stage'], {when: c => !!c.session}),
    def('chart.write', 'Write note', 'Chart', ['KeyN'], ['edit.chart.score']),
    def('chart.step.1', 'Step 1/64', 'Chart', ['Digit1'], ['edit.chart.score']),
    def('library.add', 'Add song…', 'Library', ['KeyN'], ['library']),
    def('library.search', 'Search', 'Library', ['/'], ['library']),
    def('app.palette', 'Command palette', 'App', ['Mod+KeyK'], ['global']),
    def('app.shortcuts', 'Keyboard shortcuts', 'App', ['?'], ['global']),
    def('app.escape', 'Close / back', 'App', ['Escape'], ['global']),
  ]);
});

afterEach(() => {
  for (const d of document.querySelectorAll('dialog')) d.__uiClose?.();
  setPlatform(null);
  store.stage.value = null;
  delete document.documentElement.dataset.posture;
  delete document.documentElement.dataset.place;
  restoreDomShims();
  document.body.replaceChildren();
});

const rowsOf = groups => groups.flatMap(g => g.rows);
const rowById = (groups, id) => rowsOf(groups).find(r => r.id === id);

describe('shortcutModel', () => {
  test('the sheet groups are the registry groups (registry CI compares them)', () => {
    expect(SHEET_GROUPS).toEqual(GROUPS);
  });

  test('Here: the chain bindings, grouped in SHEET_GROUPS order; commands whose when fails are left out', () => {
    const model = shortcutModel({registry: reg, chain: ['stage', 'global']});
    expect(model.here.label).toBe('Stage');
    expect(model.here.groups.map(g => g.group)).toEqual(['Transport', 'Loop', 'Click', 'Mix', 'Navigate', 'App']);
    expect(rowById(model.here.groups, 'nav.prevSection').keys).toEqual(['[', 'PageUp']);
    expect(rowById(model.here.groups, 'setlist.next')).toBeUndefined();
    expect(rowById(model.here.groups, 'app.palette')).toMatchObject({scope: 'global', keys: ['Mod+KeyK']});
    session = null;
    expect(rowById(shortcutModel({registry: reg, chain: ['stage', 'global']}).here.groups, 'mix.mute.1')).toBeUndefined();
  });

  test('an inner focus scope shadows the outer key; the outer row is marked with what wins here', () => {
    const model = shortcutModel({registry: reg, chain: ['stage.strip', 'stage', 'global']});
    expect(model.here.label).toBe('Song strip (focused) · Stage');
    const again = rowById(model.here.groups, 'transport.again');
    expect(again.keys).toEqual([]);
    expect(again.shadowed).toEqual([{key: 'Enter', by: {id: 'focus.play', title: 'Play from here', scope: 'stage.strip'}}]);
    expect(rowById(model.here.groups, 'transport.loopToggle').shadowed[0].by.id).toBe('focus.loop');
    expect(rowById(model.here.groups, 'focus.play')).toMatchObject({keys: ['Enter'], shadowed: []});
  });

  test('a stop scope blocks every outer key outside its pass-through list', () => {
    const model = shortcutModel({registry: reg, chain: ['edit.chart.score', 'edit.chart', 'edit', 'global']});
    expect(rowById(model.here.groups, 'chart.write').keys).toEqual(['KeyN']);
    expect(rowById(model.here.groups, 'transport.playStop').keys).toEqual(['Space']);     // passes through
    expect(rowById(model.here.groups, 'transport.again').keys).toEqual(['Enter']);
    expect(rowById(model.here.groups, 'click.countIn')).toMatchObject({keys: [], blocked: [{key: 'KeyC', scope: 'edit.chart.score'}]});
    expect(rowById(model.here.groups, 'app.palette').keys).toEqual(['Mod+KeyK']);
    expect(rowById(model.here.groups, 'app.escape').keys).toEqual(['Escape']);
  });

  test('Elsewhere: one block per other scope, in a fixed order, with readable labels', () => {
    const model = shortcutModel({registry: reg, chain: ['stage', 'global']});
    expect(model.elsewhere.map(b => b.scope)).toEqual(['stage.strip', 'stage.bars', 'edit', 'edit.map', 'edit.chart', 'edit.chart.score', 'library']);
    expect(model.elsewhere.map(b => b.label)).toEqual(['Song strip (focused)', 'Bar list (focused)', 'Edit', 'Edit · Map', 'Edit · Chart',
      'Score (focused)', 'Library']);
    const library = model.elsewhere.find(b => b.scope === 'library');
    expect(rowsOf(library.groups).map(r => [r.id, r.keys])).toEqual([['library.add', ['KeyN']], ['library.search', ['/']]]);
    expect(SCOPE_LABELS.global).toBe('Everywhere');
  });

  test('the default chain is the dispatcher’s active chain', () => {
    const stop = startDispatcher({registry: reg});
    document.documentElement.dataset.posture = 'stage';
    expect(shortcutModel({registry: reg}).chain).toEqual(['stage', 'global']);
    document.documentElement.dataset.posture = '';
    document.documentElement.dataset.place = 'library';
    expect(shortcutModel({registry: reg}).chain).toEqual(['library', 'global']);
    stop();
  });

  test('sheetLayout: a full-height sheet in the band layout and on narrow screens', () => {
    expect(sheetLayout({stageLayout: 'band'})).toBe('band');
    expect(sheetLayout({width: 500})).toBe('band');
    expect(sheetLayout({stageLayout: 'rail', width: 1440})).toBe('center');
  });
});

describe('the overlay', () => {
  test('a modal dialog: the chain first, then elsewhere; labels from keys.label; shadowed keys marked', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const stop = startDispatcher({registry: reg});
    const handle = openShortcuts({registry: reg, chain: ['stage.strip', 'stage', 'global']});
    const el = handle.el;
    expect(el.tagName).toBe('DIALOG');
    expect(el.open).toBe(true);
    expect(openOverlays().at(-1)).toMatchObject({modal: true, scope: 'shortcuts'});
    expect(document.getElementById(el.getAttribute('aria-labelledby')).textContent).toBe('Keyboard shortcuts');
    const sections = [...el.querySelectorAll('.app-shortcuts-section')];
    expect(sections[0].dataset.section).toBe('here');
    expect(sections[0].querySelector('h3').textContent).toBe('Here: Song strip (focused) · Stage');
    expect(sections.slice(1).every(s => s.dataset.section === 'elsewhere')).toBe(true);
    const groups = [...sections[0].querySelectorAll('.app-shortcuts-group h4')].map(n => n.textContent);
    expect(groups).toEqual(['Transport', 'Loop', 'Click', 'Mix', 'Navigate', 'App']);
    const palette = el.querySelector('[data-command-id="app.palette"]');
    expect(palette.querySelector('.app-shortcuts-name').textContent).toBe('Command palette');
    expect(palette.querySelector('kbd').textContent).toBe('⌘K');
    const again = sections[0].querySelector('[data-command-id="transport.again"]');
    expect(again.hasAttribute('data-shadowed')).toBe(true);
    expect(again.querySelector('[data-shadowed] .app-shortcuts-note').textContent).toBe('here: Play from here');
    expect(again.querySelector('[data-shadowed] .sr-only').textContent).toBe('Shadowed: ');
    expect(document.activeElement).toBe(el.querySelector('.app-shortcuts-body'));
    keydown({key: 'Escape', code: 'Escape'});
    expect(handle.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(openOverlays()).toEqual([]);
    stop();
  });

  test('blocked keys say which focused scope blocks them', () => {
    const handle = openShortcuts({registry: reg, chain: ['edit.chart.score', 'edit.chart', 'edit', 'global']});
    const count = handle.el.querySelector('[data-section=here] [data-command-id="click.countIn"]');
    expect(count.querySelector('[data-blocked] .app-shortcuts-note').textContent).toBe('not while score has focus');
    handle.close();
  });

  test('the filter narrows rows by title or key label, hides empty groups and says when nothing matches', () => {
    const handle = openShortcuts({registry: reg, chain: ['stage', 'global']});
    const filter = handle.el.querySelector('.app-shortcuts-filter');
    const visibleIds = () => [...handle.el.querySelectorAll('.app-shortcuts-row')].filter(r => !r.hidden && !r.closest('[hidden]'))
      .map(r => r.dataset.commandId);
    filter.value = 'loop';
    filter.dispatchEvent(new window.Event('input', {bubbles: true}));
    expect(visibleIds()).toEqual(['transport.loopToggle', 'focus.loop', 'focus.loop']);   // the strip and the bar list
    filter.value = '⌘k';
    filter.dispatchEvent(new window.Event('input', {bubbles: true}));
    expect(visibleIds()).toEqual(['app.palette']);
    filter.value = 'zzz';
    filter.dispatchEvent(new window.Event('input', {bubbles: true}));
    expect(visibleIds()).toEqual([]);
    expect(handle.el.querySelector('.app-shortcuts-empty').hidden).toBe(false);
    filter.value = '';
    filter.dispatchEvent(new window.Event('input', {bubbles: true}));
    expect(handle.el.querySelector('.app-shortcuts-empty').hidden).toBe(true);
    expect(visibleIds().length).toBeGreaterThan(10);
    handle.close();
  });

  test('? and ✕ and the backdrop close it; opening again while open returns the same handle', () => {
    let handle = openShortcuts({registry: reg, chain: ['stage', 'global']});
    expect(openShortcuts({registry: reg})).toBe(handle);
    keydown({key: '?', code: 'Slash', shiftKey: true}, {target: handle.el.querySelector('.app-shortcuts-body')});
    expect(handle.open).toBe(false);
    handle = openShortcuts({registry: reg, chain: ['stage', 'global']});
    const filter = handle.el.querySelector('.app-shortcuts-filter');
    keydown({key: '?', code: 'Slash', shiftKey: true}, {target: filter});
    expect(handle.open).toBe(true);                       // typing ? into the filter does not close it
    handle.el.querySelector('.app-shortcuts-close').dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
    expect(handle.open).toBe(false);
    handle = openShortcuts({registry: reg, chain: ['stage', 'global']});
    handle.el.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
    expect(handle.open).toBe(false);
  });

  test('band layout in the Stage band layout', () => {
    store.stage.value = {songId: 'gh', layout: 'band', playing: false};
    const handle = openShortcuts({registry: reg, chain: ['stage', 'global']});
    expect(handle.el.dataset.layout).toBe('band');
    handle.close();
  });

  test('a registry or state change while open rebuilds the rows and keeps the filter', async () => {
    const handle = openShortcuts({registry: reg, chain: ['stage', 'global']});
    const filter = handle.el.querySelector('.app-shortcuts-filter');
    const visibleIds = () => [...handle.el.querySelectorAll('[data-section=here] .app-shortcuts-row')]
      .filter(r => !r.hidden && !r.closest('[hidden]')).map(r => r.dataset.commandId);
    filter.value = 'mute';
    filter.dispatchEvent(new window.Event('input', {bubbles: true}));
    expect(visibleIds()).toEqual(['mix.mute.1']);
    // A surface registers a binding while the sheet is open.
    reg.register(def('mix.mute.2', 'Mute bass', 'Mix', ['Digit2'], ['stage']));
    expect(visibleIds()).toEqual(['mix.mute.1', 'mix.mute.2']);
    expect(handle.model.here.groups.flatMap(g => g.rows).some(r => r.id === 'mix.mute.2')).toBe(true);
    expect(filter.value).toBe('mute');
    // A `when` stops passing (the song closes): the row goes once the registry recomputes.
    session = null;
    reg.invalidate();   // (provide() in beforeEach may already have one pending, on real timers)
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(visibleIds()).toEqual(['mix.mute.2']);
    handle.close();
    // Closed: later changes are ignored.
    reg.register(def('mix.mute.3', 'Mute vocals', 'Mix', ['Digit3'], ['stage']));
    expect(handle.el.querySelector('[data-command-id="mix.mute.3"]')).toBe(null);
  });

  test('every key-cap it makes is destroyed on re-render and on close (no matchMedia listener leak)', () => {
    const real = globalThis.matchMedia;
    let added = 0, removed = 0;
    globalThis.matchMedia = query => {
      const mql = real ? real.call(globalThis, query) : {matches: false, addEventListener() {}, removeEventListener() {}};
      return {
        get matches() { return mql.matches; },
        addEventListener: (type, fn) => { added++; mql.addEventListener?.(type, fn); },
        removeEventListener: (type, fn) => { removed++; mql.removeEventListener?.(type, fn); },
      };
    };
    try {
      const handle = openShortcuts({registry: reg, chain: ['stage', 'global']});
      expect(added).toBeGreaterThan(5);
      reg.register(def('mix.mute.2', 'Mute bass', 'Mix', ['Digit2'], ['stage']));
      const live = handle.el.querySelectorAll('kbd.ui-kbd').length;
      expect(added - removed).toBe(live);
      handle.close();
      expect(removed).toBe(added);
    } finally {
      globalThis.matchMedia = real;
    }
  });

  test('a chain with nothing bound says so', () => {
    const empty = createRegistry();
    const handle = openShortcuts({registry: empty, chain: ['settings', 'global']});
    expect(handle.el.querySelector('.app-shortcuts-none').textContent).toBe('No keyboard shortcuts here.');
    handle.close();
    vi.restoreAllMocks();
  });
});
