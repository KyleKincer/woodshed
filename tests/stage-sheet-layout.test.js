// @vitest-environment happy-dom
// The Chart layout sheet (src/stage/sheets/layout.js), the bar menu's New line here (src/stage/menus.js) and the
// song's line breaks in the drum part (shared/notation.ts ScoreEditor.setLineBreak / clearLineBreaks).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createRegistry} from '../src/app/commands.js';
import {prefs} from '../src/app/prefs.js';
import {signal} from '../src/app/store.js';
import {ScoreEditor, emptyScore, validateScore, validLineBreaks} from '../shared/notation.ts';
import {render} from '../src/stage/sheets/layout.js';
import {COPY, CONTROLS} from '../src/stage/sheets/sheets-b.copy.js';
import {COPY as MENU, CONTROLS as MENU_CONTROLS, barMenu} from '../src/stage/menus.js';

const C = COPY.layout;

/** A drum part as the notation session gives it: a real ScoreEditor, commit() and subscribe(). */
function partOf(score = emptyScore(16, 120)) {
  const listeners = new Set();
  const part = {
    editor: new ScoreEditor(score), readOnly: false, commits: [],
    get score() { return this.editor.score; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    commit(reason) { this.commits.push(reason); for (const fn of [...listeners]) fn(reason); },
  };
  return part;
}

function bed({readOnly = false, display = null} = {}) {
  const part = partOf();
  const session = {readOnly, notation: {part}};
  const stage = {display: signal(display)};
  const registry = createRegistry();
  const ran = [];
  const cmd = (id, run) => registry.register({id, title: id, group: 'View', run: (c) => { ran.push([id, c.args ?? null]); run?.(c); }});
  cmd('view.smaller');
  cmd('view.bigger');
  cmd('view.display', (c) => { stage.display.value = c.args?.layout ?? null; });
  registry.provide('stage', () => stage);
  const container = document.createElement('div');
  document.body.append(container);
  const handle = render(container, {session, registry, prefs});
  return {part, session, stage, registry, ran, container, handle};
}

const group = (root, name) => root.querySelector(`[role=radiogroup][aria-label="${name}"]`);
const checked = (g) => g.querySelector('[aria-checked=true]')?.textContent.trim();
const option = (g, label) => [...g.querySelectorAll('[role=radio]')].find((el) => el.textContent.trim() === label);
const button = (root, name) => [...root.querySelectorAll('button')].find((el) => !el.closest('[hidden]') && !el.hidden && el.textContent.trim() === name) ?? null;

beforeEach(() => { prefs.update((d) => { d.chart.lines = {bars: 'auto', spacing: 'normal'}; }); });
afterEach(() => { document.body.replaceChildren(); });

describe('the Chart layout sheet', () => {
  test.each(CONTROLS.filter((row) => row.sheet === 'chartLayout').map((row) => [row.role, row.name, row]))('%s “%s”', (role, name, row) => {
    const b = bed();
    if (row.when === 'breaks') { b.part.editor.setLineBreak(b.part.score.timeline.measures[2].id); b.part.commit('layout'); }
    const el = role === 'radiogroup' ? group(b.container, name) : button(b.container, name);
    expect(el, name).not.toBeNull();
    if (row.command) {
      el.click();
      expect(b.ran.at(-1)?.[0]).toBe(row.command);
    }
  });

  test('bars per line and spacing write this device\'s prefs; Auto and Normal are the defaults', () => {
    const b = bed();
    const bars = group(b.container, C.bars), spacing = group(b.container, C.spacing);
    expect(checked(bars)).toBe(C.auto);
    expect(checked(spacing)).toBe(C.normal);
    expect([...bars.querySelectorAll('[role=radio]')].map((el) => el.textContent.trim())).toEqual([C.auto, '1', '2', '3', '4', '5', '6']);
    option(bars, '3').click();
    option(spacing, C.roomy).click();
    expect(prefs.get('chart.lines.bars')).toBe('3');
    expect(prefs.get('chart.lines.spacing')).toBe('roomy');
    // Changed elsewhere (another window): the sheet follows.
    prefs.set('chart.lines.bars', '5');
    expect(checked(bars)).toBe('5');
  });

  test('Notation shows the device\'s choice, else the part\'s own, and runs view.display', () => {
    const b = bed();
    const notation = group(b.container, C.notation);
    expect(checked(notation)).toBe(C.together);
    option(notation, C.handsFeet).click();
    expect(b.ran.at(-1)).toEqual(['view.display', {layout: 'split'}]);
    expect(checked(notation)).toBe(C.handsFeet);
  });

  test('line breaks: how many, and Clear line breaks drops them all in one commit', () => {
    const b = bed();
    const hint = b.container.querySelector('[data-section=breaks] .sheet-layout-hint');
    expect(hint.textContent).toBe(C.breaksNone);
    expect(button(b.container, C.clear)).toBeNull();
    const ids = b.part.score.timeline.measures.map((m) => m.id);
    b.part.editor.setLineBreak(ids[2]);
    b.part.editor.setLineBreak(ids[5]);
    b.part.commit('layout');
    expect(hint.textContent).toBe(C.breaksSome(2));
    button(b.container, C.clear).click();
    expect(b.part.score.lineBreaks).toBeUndefined();
    expect(b.part.commits.at(-1)).toBe('layout');
    expect(hint.textContent).toBe(C.breaksNone);
  });

  test('a shared song shows its line breaks but cannot clear them', () => {
    const b = bed({readOnly: true});
    b.part.editor.setLineBreak(b.part.score.timeline.measures[3].id);
    b.part.commit('layout');
    expect(b.container.querySelector('[data-section=breaks] .sheet-layout-hint').textContent).toBe(C.breaksSome(1));
    expect(button(b.container, C.clear)).toBeNull();
  });

  test('Reset layout: Auto, Normal and the part\'s own notation', () => {
    const b = bed({display: 'split'});
    prefs.update((d) => { d.chart.lines = {bars: '2', spacing: 'tight'}; });
    button(b.container, C.reset).click();
    expect(prefs.get('chart.lines')).toEqual({bars: 'auto', spacing: 'normal'});
    expect(b.ran.at(-1)).toEqual(['view.display', {layout: null}]);
    expect(checked(group(b.container, C.bars))).toBe(C.auto);
    expect(checked(group(b.container, C.notation))).toBe(C.together);
  });

  test('destroy stops listening', () => {
    const b = bed();
    b.handle.destroy();
    expect(b.container.childElementCount).toBe(0);
    prefs.set('chart.lines.bars', '4');
    b.part.commit('layout');
  });
});

describe('New line here (the bar menu, on the Chart)', () => {
  function menuBed({readOnly = false, surface = 'chart', mapped = true} = {}) {
    const part = partOf();
    const measures = part.score.timeline.measures;
    const session = {
      readOnly, notation: {part},
      transport: {cue: vi.fn(), playFrom: vi.fn(), loopBars: vi.fn(), loopRange: vi.fn()},
      position: {regions: () => []},
      map: mapped ? {isReal: true, hasSections: false, sections: [], bars: measures.map((m, i) => ({display: i + 1})),
        barIndexAt: (t) => Math.min(measures.length - 1, Math.floor(t / 2))} : null,
    };
    const items = (t) => barMenu(session, {t}, {surface, registry: createRegistry()});
    return {part, session, items, measures};
  }
  const lineItem = (items) => items.find((i) => i.id === 'line-break');

  test('toggles the bar\'s line break, saved with the drum part', () => {
    const b = menuBed();
    let item = lineItem(b.items(4.5));   // bar 3
    expect(item).toMatchObject({label: MENU.newLine, type: 'checkbox', checked: false});
    item.run();
    expect(b.part.score.lineBreaks).toEqual([b.measures[2].id]);
    expect(b.part.commits).toEqual(['layout']);
    item = lineItem(b.items(4.5));
    expect(item.checked).toBe(true);
    item.run();
    expect(b.part.score.lineBreaks).toBeUndefined();
  });

  test('the first bar always starts a line', () => {
    const item = lineItem(menuBed().items(0.5));
    expect(item).toMatchObject({checked: true, reason: MENU.firstLine});
  });

  test('only on the Chart, of an owner\'s mapped song', () => {
    expect(lineItem(menuBed({surface: 'roadmap'}).items(4.5))).toBeUndefined();
    expect(lineItem(menuBed({readOnly: true}).items(4.5))).toBeUndefined();
    expect(MENU_CONTROLS.find((r) => r.menu === 'bar' && r.name === MENU.newLine)).toMatchObject({role: 'menuitemcheckbox', when: 'chart mapped part owner'});
  });
});

describe('the song\'s line breaks (Score.lineBreaks)', () => {
  test('setLineBreak toggles or sets a bar\'s break; ids that left the timeline are dropped on the next change', () => {
    const e = new ScoreEditor(emptyScore(16, 120));
    const ids = e.score.timeline.measures.map((m) => m.id);
    expect(e.setLineBreak(ids[2])).toBe(true);
    expect(e.setLineBreak(ids[4], true)).toBe(true);
    expect(e.setLineBreak(ids[4], true)).toBe(false);
    expect(e.score.lineBreaks).toEqual([ids[2], ids[4]]);
    expect(e.setLineBreak('nope', true)).toBe(false);
    e.setLineBreak(ids[2]);
    expect(e.score.lineBreaks).toEqual([ids[4]]);
    e.undo();
    expect(e.score.lineBreaks).toEqual([ids[2], ids[4]]);
    expect(e.clearLineBreaks()).toBe(true);
    expect('lineBreaks' in e.score).toBe(false);
    expect(e.clearLineBreaks()).toBe(false);
  });

  test('validation: unique non-empty ids', () => {
    expect(validLineBreaks(['a', 'b'])).toBe(true);
    expect(validLineBreaks([])).toBe(true);
    expect(validLineBreaks(['a', 'a'])).toBe(false);
    expect(validLineBreaks([''])).toBe(false);
    expect(validLineBreaks('a')).toBe(false);
    const score = emptyScore(8, 120);
    expect(() => validateScore({...score, lineBreaks: [3]})).toThrow();
    expect(() => validateScore({...score, lineBreaks: [score.timeline.measures[1].id]})).not.toThrow();
  });
});
