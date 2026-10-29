// @vitest-environment node
// The runner's helpers without a browser (architecture §11.4–11.5): the pure
// parts of the structural checks, the counting wrapper, CDP touch sequences,
// and the target and focus probes. tests/fixture/states/FX1.cjs runs them in Chromium.
import {describe, it, expect, vi} from 'vitest';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const structure = require('../lib/structure.cjs');
const {createCounter, BUDGETS, resolveKey, isCharacter} = require('../lib/count.cjs');
const {touchOn, fingers, path, pointOf} = require('../lib/touch.cjs');
const targets = require('../probes/probe-targets.cjs');
const focus = require('../probes/probe-focus.cjs');
const touchProbe = require('../probes/probe-touch.cjs');

describe('lib/structure.cjs', () => {
  const rect = (x, y, w, h) => ({x, y, w, h});
  it('overlapArea counts real overlap only (touching edges are fine)', () => {
    expect(structure.overlapArea(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBe(25);
    expect(structure.overlapArea(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe(0);
    expect(structure.overlapArea(rect(0, 0, 10, 10), rect(9.5, 0, 10, 10))).toBe(0);
    expect(structure.overlapArea(rect(0, 0, 10, 10), rect(20, 20, 5, 5))).toBe(0);
  });
  it('findOverlaps skips nested pairs', () => {
    const t = [{label: 'card', path: 'a', rect: rect(0, 0, 100, 100)}, {label: 'menu', path: 'b', rect: rect(80, 0, 20, 20)}, {label: 'other', path: 'c', rect: rect(90, 10, 40, 40)}];
    expect(structure.findOverlaps(t, [[0, 1]]).map(o => [o.a.label, o.b.label])).toEqual([['card', 'other'], ['menu', 'other']]);
  });
  it('findOverlaps compares one frame by rect, and different frames only where both were on screen at the start', () => {
    // A [data-scroller]'s pair scrolled into view (no view), a fixed button where they would be
    // unscrolled, a window target under the fixed button at the start, and one scrolled into view.
    const t = [
      {label: 'fifth', path: 'a', frame: 'scroller:0', rect: rect(0, 600, 120, 40), view: null},
      {label: 'sixth', path: 'b', frame: 'scroller:0', rect: rect(60, 610, 120, 40), view: null},
      {label: 'decoy', path: 'c', frame: 'fixed', rect: rect(0, 600, 180, 50), view: rect(0, 600, 180, 50)},
      {label: 'row', path: 'd', frame: 'window', rect: rect(2000, 2600, 100, 40), view: rect(100, 620, 100, 40)},
      {label: 'far', path: 'e', frame: 'window', rect: rect(2050, 2610, 100, 40), view: null},
    ];
    expect(structure.findOverlaps(t).map(o => [o.a.label, o.b.label])).toEqual([['fifth', 'sixth'], ['decoy', 'row'], ['row', 'far']]);
  });
  it('findOverlaps skips a pair where exactly one target is inside an open overlay', () => {
    // A menu item partly over the page button that opened it; two items of one menu; a page pair.
    const t = [
      {label: 'trigger', path: 'a', frame: 'fixed', rect: rect(0, 0, 120, 40), view: rect(0, 0, 120, 40), overlay: null},
      {label: 'item', path: 'b', frame: 'fixed', rect: rect(60, 10, 120, 40), view: rect(60, 10, 120, 40), overlay: 0},
      {label: 'item 2', path: 'c', frame: 'fixed', rect: rect(100, 20, 120, 40), view: rect(100, 20, 120, 40), overlay: 0},
      {label: 'other menu', path: 'd', frame: 'fixed', rect: rect(150, 30, 60, 40), view: rect(150, 30, 60, 40), overlay: 1},
      {label: 'page', path: 'e', frame: 'fixed', rect: rect(10, 5, 40, 20), view: rect(10, 5, 40, 20)},
    ];
    expect(structure.findOverlaps(t).map(o => [o.a.label, o.b.label])).toEqual([['trigger', 'page'], ['item', 'item 2'], ['item', 'other menu'], ['item 2', 'other menu']]);
  });
  it('the clip check names chips and readouts, not their containers', () => {
    const token = new RegExp(structure.LABEL_CLASS);
    for (const c of ['chip', 'readout', 'stage-chip', 'hud_readout', 'chip--on', 'filter-chip--active']) expect(token.test(c), c).toBe(true);
    for (const c of ['chips', 'chip-row', 'readouts', 'chipper', 'readout-group', 'microchip']) expect(token.test(c), c).toBe(false);
    expect(structure.LABELLED).not.toMatch(/\.chip\b(?!")/);
  });
  it('analyse reports each kind of problem and honours skip and placeholder', () => {
    const data = {
      overflow: [{target: 'html', scrollWidth: 1500, clientWidth: 1440}],
      targets: [{label: 'First', path: 'p1', rect: rect(0, 0, 120, 40)}, {label: 'Second', path: 'p2', rect: rect(60, 10, 120, 40)}],
      nested: [],
      clipped: [{label: 'Long label', path: 'button', scrollWidth: 180, clientWidth: 48}],
      placeholder: true,
    };
    const problems = structure.analyse(data);
    expect(problems).toEqual([
      'overflow: html is 1500px wide in 1440px',
      'overlap: "First" (p1) and "Second" (p2) share 1800px²',
      'clip: "Long label" (button) needs 180px, has 48px',
      'placeholder: "Not built yet" is on screen',
    ]);
    expect(structure.analyse(data, {skip: ['overflow', 'overlap', 'clip']})).toEqual(['placeholder: "Not built yet" is on screen']);
    expect(structure.analyse(data, {skip: ['overflow', 'overlap', 'clip'], placeholder: true})).toEqual([]);
    expect(structure.analyse({overflow: [], targets: [], nested: [], clipped: [], placeholder: false})).toEqual([]);
  });
  it('checkStructure refuses an unknown check name', async () => {
    await expect(structure.checkStructure({evaluate: vi.fn()}, {skip: ['colour']})).rejects.toThrow(/unknown check "colour"/);
  });
  it('checkStructure passes the options to the page and analyses the answer', async () => {
    const page = {evaluate: vi.fn(async (fn, args) => { expect(fn).toBe(structure.collect); expect(args.allowClip).toEqual(['.title']); return {overflow: [], targets: [], nested: [], clipped: [], placeholder: true}; })};
    expect(await structure.checkStructure(page, {allowClip: ['.title'], placeholder: true})).toEqual([]);
  });
});

describe('lib/count.cjs', () => {
  function fakePage() {
    const calls = [];
    return {calls, keyboard: {
      press: vi.fn(async k => calls.push(['press', k])), down: vi.fn(async k => calls.push(['down', k])), up: vi.fn(async k => calls.push(['up', k])),
      type: vi.fn(async t => calls.push(['type', t])), insertText: vi.fn(async t => calls.push(['insertText', t])),
    }};
  }
  it('Mod resolves to the platform modifier; characters are told from keys', () => {
    expect(resolveKey('Mod+K', 'Meta')).toBe('Meta+K');
    expect(resolveKey('Mod+Shift+Enter', 'Control')).toBe('Control+Shift+Enter');
    expect(['a', 'A', '/', 'Shift+A', 'Space'].every(isCharacter)).toBe(true);
    expect(['Enter', 'Mod+K', 'Control+a', 'ArrowLeft', 'Escape'].some(isCharacter)).toBe(false);
  });
  it('the Appendix A budgets', () => {
    expect(BUDGETS).toEqual({'F-laptop': {actions: 6, mode: 'keys'}, 'R-laptop': {actions: 3, mode: 'keys'}, 'F-ipad': {actions: 6, mode: 'touch'}, 'R-ipad': {actions: 3, mode: 'touch'}, K: {keys: 9, mode: 'keys'}});
  });
  it('counts keys and chords once, and characters typed into a field not at all', async () => {
    const page = fakePage();
    let inField = false;
    const counter = createCounter(page, {mode: 'keys', mod: 'Meta', isTextField: async () => inField});
    await counter.step('open the song', async () => {
      await counter.keyboard.press('/');
      inField = true;
      await counter.keyboard.type('glasshouse');
      await counter.keyboard.press('g');
      await counter.keyboard.press('Enter');
    });
    inField = false;
    await counter.step('loop the bridge', async () => { await counter.keyboard.press('Mod+K'); inField = true; await counter.keyboard.insertText('bridge'); await counter.keyboard.press('Mod+Enter'); });
    expect(page.calls).toContainEqual(['press', 'Meta+K']);
    const r = counter.assertBudget('F-laptop');
    expect(r.steps.map(s => [s.label, s.keys, s.typed])).toEqual([['open the song', 2, 11], ['loop the bridge', 2, 6]]);
    expect(r.totals).toEqual({actions: 2, keys: 4, typed: 17, taps: 0, gestures: 0});
  });
  it('typing outside a text field counts every character', async () => {
    const counter = createCounter(fakePage(), {isTextField: async () => false});
    await counter.step('shortcuts', () => counter.keyboard.type('ms'));
    expect(counter.report().totals.keys).toBe(2);
  });
  it('counts taps and gestures through the touch driver', async () => {
    const driver = Object.fromEntries(['tap', 'doubleTap', 'longPress', 'drag', 'swipe', 'pinch', 'pan'].map(g => [g, vi.fn(async () => {})]));
    const counter = createCounter(fakePage(), {mode: 'touch', touch: driver});
    await counter.step('open', () => counter.touch.tap({x: 1, y: 1}));
    await counter.step('loop the bridge', () => counter.touch.doubleTap({x: 2, y: 2}));
    await counter.step('zoom', () => counter.touch.pinch({x: 3, y: 3}));
    expect(driver.doubleTap).toHaveBeenCalledWith({x: 2, y: 2});
    expect(counter.assertBudget('R-ipad').totals).toEqual({actions: 3, keys: 0, typed: 0, taps: 1, gestures: 2});
    await expect(counter.keyboard.press('Space')).rejects.toThrow(/touch only/);
  });
  it('a keys-only counter refuses touch', async () => {
    const counter = createCounter(fakePage(), {mode: 'keys', isTextField: async () => false});
    await expect(counter.touch.tap({x: 0, y: 0})).rejects.toThrow(/keys only/);
  });
  it('fails a budget that is exceeded, an empty step, input outside a step, or the wrong mode', async () => {
    const counter = createCounter(fakePage(), {isTextField: async () => false});
    await counter.keyboard.press('x');
    await counter.step('nothing', async () => {});
    for (let i = 0; i < 4; i++) await counter.step(`step ${i}`, () => counter.keyboard.press('M'));
    let error;
    try { counter.assertBudget({actions: 3}); } catch (e) { error = e; }
    expect(error.message).toMatch(/1 input\(s\) outside any step/);
    expect(error.message).toMatch(/step "nothing" had no input/);
    expect(error.message).toMatch(/5 actions > budget 3/);
    expect(error.report.totals.actions).toBe(5);
    expect(() => counter.assertBudget('K')).toThrow(/keys only; this counter is any/);
    expect(() => counter.assertBudget('Z')).toThrow(/unknown budget/);
  });
  it('steps cannot nest; an unknown mode is refused', async () => {
    const counter = createCounter(fakePage(), {isTextField: async () => false});
    await expect(counter.step('outer', () => counter.step('inner', async () => {}))).rejects.toThrow(/started inside step "outer"/);
    expect(() => createCounter(fakePage(), {mode: 'mouse'})).toThrow(/mode is any, keys or touch/);
  });
});

describe('lib/touch.cjs', () => {
  function recorder() {
    const sent = [];
    const touch = touchOn(async (method, params) => { sent.push({method, ...params}); }, {sleep: async () => {}});
    return {sent, touch, types: () => sent.map(s => `${s.type}:${s.touchPoints.length}`)};
  }
  it('tap, double-tap and long-press are start/end pairs with one finger', async () => {
    const {sent, touch, types} = recorder();
    await touch.tap({x: 10, y: 20});
    await touch.doubleTap({x: 10, y: 20});
    await touch.longPress({x: 10, y: 20}, {ms: 350});
    expect(types()).toEqual(['touchStart:1', 'touchEnd:0', 'touchStart:1', 'touchEnd:0', 'touchStart:1', 'touchEnd:0', 'touchStart:1', 'touchEnd:0']);
    expect(sent.every(s => s.method === 'Input.dispatchTouchEvent')).toBe(true);
    expect(sent[0].touchPoints[0]).toMatchObject({x: 10, y: 20, id: 0});
    expect(touch.log.map(l => l.gesture)).toEqual(['tap', 'doubleTap', 'longPress']);
  });
  it('drag moves one finger in steps (a hold first makes a long-press drag)', async () => {
    const {sent, touch, types} = recorder();
    await touch.drag({x: 0, y: 0}, {x: 100, y: 0}, {steps: 4, holdMs: 400});
    expect(types()).toEqual(['touchStart:1', 'touchMove:1', 'touchMove:1', 'touchMove:1', 'touchMove:1', 'touchEnd:0']);
    expect(sent.filter(s => s.type === 'touchMove').map(s => s.touchPoints[0].x)).toEqual([25, 50, 75, 100]);
    expect(touch.log[0].gesture).toBe('longPressDrag');
  });
  it('pinch and pan send two touch points at once', async () => {
    const {sent, touch} = recorder();
    await touch.pinch({x: 200, y: 200}, {from: 100, to: 200, steps: 2});
    const [start, , last] = sent;
    expect(start.touchPoints.map(p => [p.x, p.id])).toEqual([[150, 0], [250, 1]]);
    expect(last.touchPoints.map(p => p.x)).toEqual([100, 300]);
    sent.length = 0;
    await touch.pan({x: 200, y: 200}, {dy: -60}, {spread: 80, steps: 3});
    expect(sent.filter(s => s.type === 'touchMove').every(s => s.touchPoints.length === 2)).toBe(true);
    expect(sent.at(-2).touchPoints.map(p => p.y)).toEqual([140, 140]);
  });
  it('helpers: fingers, path, and targets as points or locators', async () => {
    expect(fingers({x: 0, y: 0}, 10, 90).map(p => [Math.round(p.x) + 0, Math.round(p.y) + 0])).toEqual([[0, -5], [0, 5]]);
    expect(path({x: 0, y: 0}, {x: 10, y: 10}, 2)).toEqual([{x: 5, y: 5}, {x: 10, y: 10}]);
    expect(await pointOf({boundingBox: async () => ({x: 10, y: 20, width: 100, height: 40})})).toEqual({x: 60, y: 40});
    await expect(pointOf({boundingBox: async () => null})).rejects.toThrow(/not visible/);
    await expect(pointOf('nowhere')).rejects.toThrow(TypeError);
  });
});

describe('probes', () => {
  it('probe-targets: 24 px on fine pointers, 44 on coarse, stricter rules win', () => {
    const data = coarse => ({coarse, targets: [
      {name: 'Play', tag: 'button', w: 64, h: 64, ruleMin: 72},
      {name: 'Mute', tag: 'button', w: 32, h: 32, ruleMin: 0},
      {name: 'Tiny', tag: 'a', w: 20, h: 30, ruleMin: 0},
    ]});
    expect(targets.tooSmall(data(false)).map(t => [t.name, t.min])).toEqual([['Play', 72], ['Tiny', 24]]);
    expect(targets.tooSmall(data(true)).map(t => [t.name, t.min])).toEqual([['Play', 72], ['Mute', 44], ['Tiny', 44]]);
    expect(targets.tooSmall(data(true), {min: 20}).map(t => t.name)).toEqual(['Play']);
    expect([targets.FINE, targets.COARSE]).toEqual([24, 44]);
  });
  it('probe-targets: checkTargets formats each problem', async () => {
    const page = {evaluate: async (fn, args) => { expect(args.rules).toEqual([{selector: '.play', min: 72}]); return {coarse: false, targets: [{name: 'Play', tag: 'button', w: 64, h: 64, x: 5, y: 6, ruleMin: 72}]}; }};
    expect(await targets.checkTargets(page, {rules: [{selector: '.play', min: 72}]})).toEqual(['target: "Play" (button at 5,6) is 64×64, needs 72×72']);
  });
  it('probe-focus: an outline of 2 px or a box-shadow ring is visible; none is a problem', () => {
    const stop = extra => ({name: 'Add', visible: true, outlineStyle: 'solid', outlineWidth: 3, outlineColor: 'rgb(23, 75, 209)', boxShadow: 'none', ...extra});
    expect(focus.ringProblem(stop())).toBeNull();
    expect(focus.ringProblem(stop({outlineStyle: 'none', boxShadow: 'rgb(0, 0, 0) 0px 0px 0px 3px'}))).toBeNull();
    expect(focus.ringProblem(stop({outlineStyle: 'none'}))).toMatch(/shows no focus ring/);
    expect(focus.ringProblem(stop({outlineWidth: 1}))).toMatch(/shows no focus ring/);
    expect(focus.ringProblem(stop({outlineColor: 'rgba(0, 0, 0, 0)'}))).toMatch(/shows no focus ring/);
    expect(focus.ringProblem(stop({visible: false}))).toMatch(/not visible/);
    expect(focus.ringProblem(null)).toBeNull();
  });
  it('probe-focus: with the unfocused look known, a ring must differ from it', () => {
    const stop = extra => ({name: 'Card', visible: true, outlineStyle: 'none', outlineWidth: 0, outlineColor: 'rgb(0, 0, 0)', boxShadow: 'rgba(0, 0, 0, 0.2) 0px 1px 2px 0px', ...extra});
    const rest = extra => ({outlineStyle: 'none', outlineWidth: 0, outlineColor: 'rgb(0, 0, 0)', boxShadow: 'rgba(0, 0, 0, 0.2) 0px 1px 2px 0px', ...extra});
    expect(focus.ringProblem(stop(), rest())).toMatch(/looks the same focused and unfocused/);
    expect(focus.ringProblem(stop())).toBeNull();
    expect(focus.ringProblem(stop({boxShadow: 'rgb(23, 75, 209) 0px 0px 0px 3px'}), rest())).toBeNull();
    expect(focus.ringProblem(stop({outlineStyle: 'solid', outlineWidth: 3, outlineColor: 'rgb(23, 75, 209)'}), rest())).toBeNull();
    const ringed = {outlineStyle: 'solid', outlineWidth: 2, outlineColor: 'rgb(23, 75, 209)', boxShadow: 'none'};
    expect(focus.ringProblem(stop(ringed), rest(ringed))).toMatch(/looks the same/);
    expect(focus.ringProblem(stop({...ringed, outlineWidth: 3}), rest(ringed))).toBeNull();
    expect(focus.ringProblem(stop({boxShadow: 'none'}), rest({boxShadow: 'none'}))).toMatch(/shows no focus ring/);
  });
  it('probe-focus: walkFocus judges each stop against its look after Tab moves on', async () => {
    const shadow = 'rgba(0, 0, 0, 0.2) 0px 1px 2px 0px';
    const flat = {outlineStyle: 'none', outlineWidth: 0, outlineColor: 'red', boxShadow: shadow};
    const steps = [
      {key: 'raised', name: 'Raised', visible: true, ...flat, prevRest: null},
      {key: 'ringed', name: 'Ringed', visible: true, outlineStyle: 'solid', outlineWidth: 3, outlineColor: 'blue', boxShadow: 'none', prevRest: flat},
      {none: true, prevRest: {outlineStyle: 'none', outlineWidth: 0, outlineColor: 'blue', boxShadow: 'none'}},
      null,
    ];
    let i = 0;
    const page = {keyboard: {press: vi.fn(async () => {})}, evaluate: async () => steps[Math.min(i++, steps.length - 1)]};
    expect(await focus.walkFocus(page, {stops: 4})).toEqual([expect.stringMatching(/"Raised" looks the same focused and unfocused/)]);
    // At the stop limit, one more Tab measures the last stop's unfocused look.
    let j = 0;
    const limited = {keyboard: {press: vi.fn(async () => {})}, evaluate: async () => steps[j++]};
    expect(await focus.walkFocus(limited, {stops: 1})).toEqual([expect.stringMatching(/"Raised" looks the same/)]);
    expect(limited.keyboard.press).toHaveBeenCalledTimes(2);
  });
  it('probe-focus: walkFocus stops when focus cycles and reports a page with nothing focusable', async () => {
    const stops = [{key: 'a', name: 'A', visible: true, outlineStyle: 'solid', outlineWidth: 3, outlineColor: 'red', boxShadow: 'none'}, {key: 'b', name: 'B', visible: true, outlineStyle: 'none', outlineWidth: 0, outlineColor: 'red', boxShadow: 'none'}];
    let i = 0;
    const page = {keyboard: {press: vi.fn(async () => {})}, evaluate: async () => stops[i++ % 2]};
    expect(await focus.walkFocus(page, {stops: 10})).toEqual(['focus: "B" shows no focus ring (outline none 0px)']);
    expect(page.keyboard.press).toHaveBeenCalledTimes(3);
    const empty = {keyboard: {press: async () => {}}, evaluate: async () => null};
    expect(await focus.walkFocus(empty, {stops: 3})).toEqual(['focus: Tab reached no focusable element']);
  });
  it('probe-touch: long-press opens a menu; a short press and a stray tap do not', async () => {
    const touch = {longPress: vi.fn(async () => {}), tap: vi.fn(async () => {})};
    let menuVisible = true;
    const page = {
      locator: () => ({first: () => ({waitFor: async () => { if (!menuVisible) throw new Error('timeout'); }, isVisible: async () => menuVisible})}),
      evaluate: vi.fn(async () => 12.5), waitForTimeout: async () => {},
    };
    expect(await touchProbe.longPressOpens(page, {x: 1, y: 1}, {ms: 500, touch})).toEqual({ok: true, opens: '[role=menu]', ms: 500});
    expect(touch.longPress).toHaveBeenCalledWith({x: 1, y: 1}, {ms: 550});
    menuVisible = false;
    expect((await touchProbe.longPressOpens(page, {x: 1, y: 1}, {touch, withinMs: 10})).ok).toBe(false);
    expect((await touchProbe.shortPressDoesNotOpen(page, {x: 1, y: 1}, {touch})).ok).toBe(true);
    expect(touch.longPress).toHaveBeenLastCalledWith({x: 1, y: 1}, {ms: 300});
    expect(await touchProbe.tapDoesNotChange(page, {x: 1, y: 1}, () => 0, {touch})).toEqual({ok: true, before: 12.5, after: 12.5});
  });
});
