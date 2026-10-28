// @vitest-environment happy-dom
// The chrome-less chart (src/js/notation/chart.js, architecture §2.14.12,
// maps/notation.md §11). alphaTab cannot lay out in happy-dom, so a fake score
// view stands in: bars are four quarters, four to a system; a system is
// 100 px × scale tall and a bar 200 px wide; pointer events on its stage are
// located from clientX/clientY (the stage sits at 0,0). Engraving geometry is
// a Playwright probe (tests/fixture/states/ST3.cjs, probe-geometry.cjs).
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pointer as firePointer, setRect, setMedia, installFrameShim, flushFrames, restoreDomShims} from './helpers/dom.js';

const views = vi.hoisted(() => []);
vi.mock('../src/js/notation/score-view.js', () => ({
  createScoreView(host, options = {}) {
    const stage = document.createElement('div');
    stage.className = 'score-stage';
    const edges = {};
    for (const side of ['start', 'end']) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('data-loop-edge', side);
      edges[side] = g;
      stage.append(g);
    }
    host.replaceChildren(stage);
    // The stage scrolls with its scroller, as in a browser (its top is 0 when unscrolled).
    stage.getBoundingClientRect = () => {
      const top = -(host.closest('.chart-scroll')?.scrollTop ?? 0);
      return {x: 0, y: top, left: 0, top, width: 800, height: 0, right: 800, bottom: top};
    };
    let score = null;
    const settings = {scale: options.scale, barsPerRow: options.barsPerRow, fonts: {...options.fonts}};
    const calls = {setScore: [], setLoop: [], setRange: [], setPlayhead: [], configure: [], relayout: 0, setLoopHandles: []};
    const rowH = () => 100 * settings.scale;
    const bars = () => score?.timeline.measures.length ?? 0;
    const view = {
      host, stage, edges, calls, options, settings, ready: false, destroyed: false, deferRender: false, beats: true,
      get score() { return score; },
      finish() { view.ready = true; options.onRender?.(view); },
      render() { view.ready = false; if (!view.deferRender) view.finish(); },
      setScore(next, opts = {}) { score = next; calls.setScore.push([next, opts]); view.render(); },
      configure(next) {
        calls.configure.push(next);
        let changed = false;
        if (next.scale != null && next.scale !== settings.scale) { settings.scale = next.scale; changed = true; }
        if (next.barsPerRow != null && next.barsPerRow !== settings.barsPerRow) { settings.barsPerRow = next.barsPerRow; changed = true; }
        if (next.fonts && (next.fonts.barNumber !== settings.fonts.barNumber || next.fonts.marker !== settings.fonts.marker)) { settings.fonts = {...next.fonts}; changed = true; }
        return changed;
      },
      relayout() { calls.relayout += 1; view.render(); },
      setLoop(range, opts = {}) { calls.setLoop.push([range, opts]); },
      setLoopHandles(on) { calls.setLoopHandles.push(on); },
      setRange(range) { calls.setRange.push(range); },
      setPlayhead(q) { calls.setPlayhead.push(q); },
      barAt: q => Math.max(0, Math.min(Math.floor(q / 4), bars() - 1)),
      barBounds: i => (i >= 0 && i < bars() ? {x: (i % 4) * 200, y: Math.floor(i / 4) * rowH(), w: 200, h: rowH(), lineTop: 20, lineHeight: 40} : null),
      renderedBars: () => bars(),
      locate(event) {
        const x = event.clientX, y = event.clientY, row = Math.floor(y / rowH()), col = Math.floor(x / 200);
        if (x < 0 || col > 3 || y < 0 || row * 4 + col >= bars()) return {x, y};
        const index = row * 4 + col, q = index * 4 + ((x % 200) / 200) * 4;
        return {x, y, index, q, beatQ: view.beats ? Math.round(q) : null};
      },
      destroy() { view.destroyed = true; },
    };
    if (options.onPointer) for (const kind of ['down', 'move', 'up', 'cancel']) stage.addEventListener(`pointer${kind}`, event => options.onPointer({kind, event, at: view.locate(event)}));
    views.push(view);
    return view;
  },
}));

import {createChart, COPY, EMPTY_ACTIONS, SCALE_STEPS, FONT_FLOORS, LONG_PRESS_MS, stepScale, fontFloors, clampScale} from '../src/js/notation/chart.js';
import {prefs} from '../src/app/prefs.js';
import {demoScore} from './fixtures/drum-score.js';

// 120 bpm in 4/4: every bar is 2 s and four quarters.
const BAR = 2;
let host, chart, part, engine, events, edits, follows, statuses, relayouts, listeners;
const view = () => views.at(-1);
const scroller = () => host.querySelector('.chart-scroll');
const stage = () => view().stage;
const ids = () => part.score.timeline.measures.map(m => m.id);
// Client coordinates at fraction f across bar `index` (systems are 100 px × scale tall).
const at = (index, fraction = 0.5, scale = 1.2) => ({x: (index % 4) * 200 + fraction * 200, y: Math.floor(index / 4) * 100 * scale + 50});

function makePart(score = demoScore(64, 120), extra = {}) {
  listeners = new Set();
  return {score, hasNotation: !!score?.bars?.length, readOnly: false, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, ...extra};
}
function sizeScroller() {
  setRect(scroller(), {width: 900, height: 800, scrollHeight: 20000});
  scroller().scrollTo = ({top}) => { scroller().scrollTop = top; };
}
function open(options = {}) {
  chart = createChart({
    host, part, engine,
    onBarActivate: e => events.push(e), onLoopEdit: e => edits.push(e), onFollowChange: f => follows.push(f),
    onStatus: s => statuses.push(s), onRelayout: r => relayouts.push(r), ...options,
  });
  sizeScroller();
  chart.setVisible(true);
  return chart;
}
const fire = (type, point, init = {}) => firePointer(stage(), type, {x: point.x, y: point.y, ...init});
const target = el => ({dispatch: (type, point, init = {}) => firePointer(el, type, {x: point.x, y: point.y, ...init})});
function mouseTap(point, init = {}) { fire('pointerdown', point, init); fire('pointerup', point, init); }
function touchTap(point, init = {}) { fire('pointerdown', point, {pointerType: 'touch', ...init}); fire('pointerup', point, {pointerType: 'touch', ...init}); }

beforeEach(() => {
  views.length = 0;
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});
  vi.setSystemTime(new Date('2026-10-28T09:00:00Z'));
  document.body.innerHTML = '<section id="music"></section>';
  host = document.getElementById('music');
  events = []; edits = []; follows = []; statuses = []; relayouts = [];
  engine = {getPosition: vi.fn(() => 0), seek: vi.fn(), setLoop: vi.fn()};
  part = makePart();
  prefs.set('chart.display.layout', null);
  installFrameShim();
});
afterEach(() => {
  chart?.destroy();
  chart = null;
  restoreDomShims();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('creation and engraving', () => {
  it('renders the part with no toolbar, chips, notice, hint or mute button, and stamps data-rendered', () => {
    open();
    expect(view().calls.setScore).toHaveLength(1);
    expect(view().calls.setScore[0][1]).toEqual({layout: 'combined'});
    expect(host.querySelector('[role=toolbar], .chart-bar, .chart-sections, .chart-notice, .chart-hint, [data-chart]')).toBeNull();
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.dataset.rendered).toBe('1');
    expect(host.querySelector('.chart-score').getAttribute('role')).toBe('img');
    expect(host.querySelector('.chart-score').getAttribute('aria-label')).toBe(COPY.chartLabel(32));
    expect(view().calls.setLoopHandles).toEqual([true]);
    chart.refresh();
    expect(host.dataset.rendered).toBe('2');
    chart.setScale(1.6);
    expect(host.dataset.rendered).toBe('3');
  });

  it('is hidden until setVisible(true), and data-rendered is "false" before the first engraving', () => {
    chart = createChart({host, part, engine});
    expect(host.hidden).toBe(true);
    expect(host.dataset.rendered).toBe('false');
    expect(views).toHaveLength(0);
    chart.setVisible(true);
    expect(host.hidden).toBe(false);
    expect(views).toHaveLength(1);
  });

  it('reports every relayout it starts with its duration and bar count', () => {
    open();
    expect(relayouts).toEqual([{ms: 0, bars: 32}]);
    view().deferRender = true;
    chart.setScale(1.6);
    expect(host.getAttribute('aria-busy')).toBe('true');
    vi.advanceTimersByTime(140);
    view().finish();
    expect(relayouts.at(-1)).toEqual({ms: 140, bars: 32});
    expect(host.hasAttribute('aria-busy')).toBe(false);
    view().finish();   // a relayout alphaTab started itself (a width change) is not reported
    expect(relayouts).toHaveLength(2);
  });

  it('re-engraves when the part changes and ignores app-theme events (only score-view listens)', () => {
    open();
    window.dispatchEvent(new Event('woodshed:theme'));
    expect(view().calls.setScore).toHaveLength(1);
    part.score = demoScore(32, 120);
    for (const fn of listeners) fn();
    expect(view().calls.setScore).toHaveLength(2);
    expect(view().calls.setScore[1][0]).toBe(part.score);
  });

  it('destroys its view, unsubscribes from the part and empties the host', () => {
    open();
    const v = view();
    chart.destroy();
    chart = null;
    expect(v.destroyed).toBe(true);
    expect(listeners.size).toBe(0);
    expect(host.children).toHaveLength(0);
    expect(host.classList.contains('chart')).toBe(false);
  });

  it('keeps the music width stable: .chart-scroll has scrollbar-gutter: stable', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/views/notation/chart.css'), 'utf8');
    expect(css).toMatch(/\.chart-scroll\s*\{[^}]*scrollbar-gutter:\s*stable/);
    open();
    expect(scroller()).not.toBeNull();
  });
});

describe('the empty state', () => {
  const handlers = () => ({findChart: vi.fn(), importFile: vi.fn(), write: vi.fn()});
  it.each(EMPTY_ACTIONS.map((row, i) => [row.name, row, i]))('offers %s as a button that calls its handler', (_, row, i) => {
    part = makePart(null);
    const onEmpty = handlers();
    open({onEmpty});
    expect(host.querySelector('h2').textContent).toBe(COPY.emptyTitle);
    const buttons = [...host.querySelectorAll('.chart-empty-actions button')];
    expect(buttons.map(b => b.textContent)).toEqual(EMPTY_ACTIONS.map(r => r.name));
    const button = buttons[i];
    expect(button.tagName.toLowerCase()).toBe(row.role);
    expect(button.getAttribute('type')).toBe('button');
    expect(button.hasAttribute('data-primary')).toBe(i === 0);
    button.click();
    expect(onEmpty[row.key]).toHaveBeenCalledTimes(1);
    for (const other of EMPTY_ACTIONS.filter(r => r !== row)) expect(onEmpty[other.key]).not.toHaveBeenCalled();
    expect(host.querySelector('.chart-empty-actions').getAttribute('role')).toBe('group');
    expect(host.querySelector('.chart-empty-actions').getAttribute('aria-labelledby')).toBe(host.querySelector('h2').id);
  });

  it('copies spec §5.4 exactly', () => {
    expect(EMPTY_ACTIONS.map(r => r.name)).toEqual(['Find a chart', 'Import a file', 'Write one']);
    expect(COPY.emptyTitle).toBe('No drum chart yet');
    expect(COPY.sharedTitle).toBe('No drum chart was shared.');
  });

  it('shows only the actions it has handlers for, and none for a shared part', () => {
    part = makePart(null);
    open({onEmpty: {write: vi.fn()}});
    expect([...host.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Write one']);
    chart.destroy();
    part = makePart(null, {readOnly: true});
    open({onEmpty: handlers()});
    expect(host.querySelector('h2').textContent).toBe('No drum chart was shared.');
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.dataset.rendered).toBe('empty');
  });

  it('a part without notation is empty; adding notation engraves it', () => {
    part = makePart(demoScore(64, 120), {hasNotation: false});
    open({onEmpty: handlers()});
    expect(views).toHaveLength(0);
    expect(host.querySelector('.chart-empty').hidden).toBe(false);
    expect(scroller().hidden).toBe(true);
    part.hasNotation = true;
    for (const fn of listeners) fn();
    expect(views).toHaveLength(1);
    expect(host.querySelector('.chart-empty').hidden).toBe(true);
    expect(scroller().hidden).toBe(false);
  });
});

describe('taps, double-taps, long-presses and the bar menu', () => {
  it('a mouse click emits a tap with the nearest beat, or the bar start when no beat is close, and never seeks', () => {
    open();
    mouseTap(at(1, 0.75));   // q 7 in bar 2
    expect(events.at(-1)).toMatchObject({kind: 'tap', index: 1, barId: ids()[1], q: 7, time: 3.5, beatTime: 3.5, pointerType: 'mouse', glass: false});
    view().beats = false;
    mouseTap(at(2, 0.3));
    expect(events.at(-1)).toMatchObject({kind: 'tap', index: 2, beatTime: 2 * BAR});
    expect(events.at(-1).clientX).toBe(at(2, 0.3).x);
    expect(engine.seek).not.toHaveBeenCalled();
    expect(engine.setLoop).not.toHaveBeenCalled();
    expect(edits).toHaveLength(0);
  });

  it('emits the pointer type of touch and pen taps', () => {
    open();
    touchTap(at(4));
    expect(events.at(-1)).toMatchObject({kind: 'tap', index: 4, pointerType: 'touch'});
    fire('pointerdown', at(5), {pointerType: 'pen'});
    fire('pointerup', at(5), {pointerType: 'pen'});
    expect(events.at(-1)).toMatchObject({kind: 'tap', index: 5, pointerType: 'pen'});
  });

  it('a second tap within 300 ms and 8 px is a double', () => {
    open();
    touchTap(at(3));
    vi.advanceTimersByTime(200);
    touchTap({x: at(3).x + 5, y: at(3).y});
    expect(events.map(e => e.kind)).toEqual(['tap', 'double']);
    vi.advanceTimersByTime(400);
    touchTap(at(3));
    vi.advanceTimersByTime(301);
    touchTap(at(3));
    touchTap({x: at(3).x + 20, y: at(3).y});
    expect(events.map(e => e.kind)).toEqual(['tap', 'double', 'tap', 'tap', 'tap']);
  });

  it('mouse double-clicks emit one double, whether the tap rule or dblclick catches it', () => {
    open();
    mouseTap(at(6));
    vi.advanceTimersByTime(100);
    mouseTap(at(6));
    stage().dispatchEvent(new MouseEvent('dblclick', {bubbles: true, clientX: at(6).x, clientY: at(6).y}));
    expect(events.map(e => e.kind)).toEqual(['tap', 'double']);
    vi.advanceTimersByTime(1000);
    mouseTap(at(7));
    vi.advanceTimersByTime(450);   // a slow OS double-click interval
    mouseTap(at(7));
    stage().dispatchEvent(new MouseEvent('dblclick', {bubbles: true, clientX: at(7).x, clientY: at(7).y}));
    expect(events.map(e => e.kind)).toEqual(['tap', 'double', 'tap', 'tap', 'double']);
    expect(events.at(-1)).toMatchObject({index: 7, pointerType: 'mouse'});
  });

  it('a 350 ms touch long-press buzzes, marks the bar, and on release without a drag emits long', () => {
    open();
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', {value: vibrate, configurable: true});
    fire('pointerdown', at(9), {pointerType: 'touch'});
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(vibrate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(LONG_PRESS_MS).toBe(350);
    expect(vibrate).toHaveBeenCalledWith(8);
    expect(view().calls.setRange.at(-1)).toEqual([9, 9]);
    expect(statuses).toEqual([COPY.armHint]);
    fire('pointerup', at(9), {pointerType: 'touch'});
    expect(events.map(e => e.kind)).toEqual(['long']);
    expect(events[0]).toMatchObject({index: 9, pointerType: 'touch'});
    expect(view().calls.setRange.at(-1)).toBeNull();
    expect(edits).toHaveLength(0);
    delete navigator.vibrate;
  });

  it('has no long-press-then-tap pending loop: the next tap is just a tap', () => {
    open();
    fire('pointerdown', at(5), {pointerType: 'touch'});
    vi.advanceTimersByTime(400);
    fire('pointerup', at(5), {pointerType: 'touch'});
    vi.advanceTimersByTime(500);
    touchTap(at(7));
    expect(events.map(e => [e.kind, e.index])).toEqual([['long', 5], ['tap', 7]]);
    expect(edits).toHaveLength(0);
    expect(view().calls.setLoop.every(([range]) => range === null)).toBe(true);
  });

  it('a touch that moves before the long-press is a scroll: nothing is emitted', () => {
    open();
    fire('pointerdown', at(2), {pointerType: 'touch'});
    fire('pointermove', {x: at(2).x, y: at(2).y + 40}, {pointerType: 'touch', buttons: 1});
    vi.advanceTimersByTime(400);
    fire('pointerup', {x: at(2).x, y: at(2).y + 40}, {pointerType: 'touch'});
    expect(events).toHaveLength(0);
    expect(edits).toHaveLength(0);
    expect(view().calls.setRange).toHaveLength(0);
  });

  it('right-click emits context at the bar and keeps the browser menu closed', () => {
    open();
    const event = new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: at(10).x, clientY: at(10).y});
    stage().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(events.at(-1)).toMatchObject({kind: 'context', index: 10, pointerType: 'mouse'});
    const outside = new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 2000, clientY: 10});
    stage().dispatchEvent(outside);
    expect(events).toHaveLength(1);
  });

  it('suppresses the browser menu during a touch long-press (the chart emits long on release instead)', () => {
    open();
    fire('pointerdown', at(4), {pointerType: 'touch'});
    vi.advanceTimersByTime(400);
    const menu = new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: at(4).x, clientY: at(4).y});
    stage().dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    fire('pointerup', at(4), {pointerType: 'touch'});
    expect(events.map(e => e.kind)).toEqual(['long']);
  });
});

describe('glass', () => {
  it('flags taps while playing; touch and mouse taps both report glass for the surface to apply §4.9', () => {
    open({glass: true});
    expect(host.hasAttribute('data-glass')).toBe(true);
    touchTap(at(3));
    mouseTap(at(8));
    expect(events.map(e => [e.pointerType, e.glass])).toEqual([['touch', true], ['mouse', true]]);
    chart.setGlass(false);
    expect(host.hasAttribute('data-glass')).toBe(false);
    touchTap(at(12));
    expect(events.at(-1).glass).toBe(false);
  });

  it('never creates a loop from touch while playing; a long-press still emits long', () => {
    open();
    chart.setGlass(true);
    fire('pointerdown', at(2), {pointerType: 'touch'});
    vi.advanceTimersByTime(400);
    expect(statuses).toEqual([]);
    expect(view().calls.setRange).toHaveLength(0);
    fire('pointermove', at(6), {pointerType: 'touch', buttons: 1});
    fire('pointerup', at(6), {pointerType: 'touch'});
    expect(edits).toHaveLength(0);
    expect(events).toHaveLength(0);
    fire('pointerdown', at(2), {pointerType: 'touch'});
    vi.advanceTimersByTime(400);
    fire('pointerup', at(2), {pointerType: 'touch'});
    expect(events.map(e => [e.kind, e.glass])).toEqual([['long', true]]);
  });

  it('a mouse still drags loops while playing', () => {
    open({glass: true});
    fire('pointerdown', at(1, 0.2), {buttons: 1});
    fire('pointermove', at(2, 0.5), {buttons: 1});
    fire('pointerup', at(2, 0.5));
    expect(edits.map(e => e.phase)).toEqual(['preview', 'commit']);
  });

  it('turning glass on cancels a touch loop drag in progress and restores the loop', () => {
    open();
    chart.setLoopRange({a: 0, b: 4});
    fire('pointerdown', at(5), {pointerType: 'touch'});
    vi.advanceTimersByTime(400);
    fire('pointermove', at(7), {pointerType: 'touch', buttons: 1});
    expect(edits.at(-1).phase).toBe('preview');
    chart.setGlass(true);
    expect(view().calls.setLoop.at(-1)).toEqual([[0, 8], {}]);
    fire('pointerup', at(7), {pointerType: 'touch'});
    expect(edits.map(e => e.phase)).toEqual(['preview']);
  });
});

describe('loop creation and editing', () => {
  it('a mouse drag across bars previews and commits the bar range with bar ids, and never seeks', () => {
    open();
    fire('pointerdown', at(3, 0.5), {buttons: 1});
    fire('pointermove', {x: at(3, 0.5).x + 4, y: at(3, 0.5).y}, {buttons: 1});
    expect(edits).toHaveLength(0);   // under the 8 px threshold
    fire('pointermove', at(2, 0.5), {buttons: 1});
    fire('pointermove', at(1, 0.5), {buttons: 1});
    expect(edits).toEqual([
      {a: 2 * BAR, b: 4 * BAR, aBar: ids()[2], bBar: ids()[3], phase: 'preview'},
      {a: 1 * BAR, b: 4 * BAR, aBar: ids()[1], bBar: ids()[3], phase: 'preview'},
    ]);
    expect(view().calls.setLoop.at(-1)).toEqual([[4, 16], {dragging: true}]);
    fire('pointerup', at(1, 0.5));
    expect(edits.at(-1)).toEqual({a: 2, b: 8, aBar: ids()[1], bBar: ids()[3], phase: 'commit'});
    expect(view().calls.setLoop.at(-1)).toEqual([[4, 16], {dragging: false}]);
    expect(events).toHaveLength(0);
    expect(engine.seek).not.toHaveBeenCalled();
    expect(engine.setLoop).not.toHaveBeenCalled();
  });

  it('a drag released outside the score still commits (pointer capture; a move with no buttons ends it)', () => {
    open();
    const capture = vi.spyOn(stage(), 'setPointerCapture');
    fire('pointerdown', at(0, 0.5), {buttons: 1});
    expect(capture).toHaveBeenCalledWith(1);
    fire('pointermove', at(2, 0.5), {buttons: 1});
    fire('pointermove', {x: 5000, y: 5000}, {buttons: 0});
    expect(edits.at(-1)).toMatchObject({phase: 'commit', a: 0, b: 3 * BAR});
  });

  it('Alt-drag snaps to beats, from the beat under the press to the end of the beat under the pointer', () => {
    open();
    fire('pointerdown', at(1, 0.325), {buttons: 1, altKey: true});   // q 5.3
    fire('pointermove', at(1, 0.6), {buttons: 1, altKey: true});     // q 6.4
    fire('pointerup', at(1, 0.6), {altKey: true});
    expect(edits.at(-1)).toEqual({a: 2.5, b: 3.5, phase: 'commit'});
  });

  it('Alt-drag snaps to the counted pulse of compound meters', () => {
    const score = demoScore(64, 120);
    for (const m of score.timeline.measures) { m.numerator = 6; m.denominator = 8; m.length = {n: 3, d: 1}; }
    score.timeline.anchors = [{position: {n: 0, d: 1}, time: 0}, {position: {n: 3, d: 1}, time: 1.5}];
    part = makePart(score);
    open();
    // 6/8 counts two dotted quarters (1.5 q, 0.75 s at 120 per quarter).
    fire('pointerdown', {x: 10, y: 50}, {buttons: 1, altKey: true});   // q 0.2
    fire('pointermove', {x: 70, y: 50}, {buttons: 1, altKey: true});   // q 1.4
    fire('pointerup', {x: 70, y: 50}, {altKey: true});
    expect(edits.at(-1)).toMatchObject({phase: 'commit', a: 0, b: 0.75});
  });

  it('touch, stopped: long-press then drag loops the bars', () => {
    open();
    fire('pointerdown', at(5), {pointerType: 'touch'});
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fire('pointermove', at(6), {pointerType: 'touch', buttons: 1});
    expect(view().calls.setRange.at(-1)).toBeNull();
    fire('pointermove', at(8), {pointerType: 'touch', buttons: 1});
    fire('pointerup', at(8), {pointerType: 'touch'});
    expect(edits.at(-1)).toEqual({a: 5 * BAR, b: 9 * BAR, aBar: ids()[5], bBar: ids()[8], phase: 'commit'});
    expect(events).toHaveLength(0);
  });

  it('a touch long-press drag holds the page still (touchmove is prevented while armed)', () => {
    open();
    fire('pointerdown', at(5), {pointerType: 'touch'});
    const early = new Event('touchmove', {bubbles: true, cancelable: true});
    stage().dispatchEvent(early);
    expect(early.defaultPrevented).toBe(false);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    const armed = new Event('touchmove', {bubbles: true, cancelable: true});
    stage().dispatchEvent(armed);
    expect(armed.defaultPrevented).toBe(true);
  });

  it('dragging a handle resizes the loop to the nearest bar line; the bracket follows the pointer until release', () => {
    open();
    chart.setLoopRange({a: 4, b: 8});   // bars 3–4, q 8–16
    const end = target(view().edges.end);
    end.dispatch('pointerdown', at(3, 1), {buttons: 1});
    fire('pointermove', at(5, 0.375), {buttons: 1});    // q 21.5 → the line at q 20
    expect(view().calls.setLoop.at(-1)).toEqual([[8, 21.5], {dragging: true}]);
    expect(edits.at(-1)).toEqual({a: 4, b: 10, aBar: ids()[2], bBar: ids()[4], phase: 'preview'});
    fire('pointerup', at(5, 0.375));
    expect(edits.at(-1)).toEqual({a: 4, b: 10, aBar: ids()[2], bBar: ids()[4], phase: 'commit'});
    // The brackets spring to the snapped line (dragging off → the --motion-fast transition).
    expect(view().calls.setLoop.at(-1)).toEqual([[8, 20], {dragging: false}]);
    chart.setLoopRange({a: 4, b: 10});
    const start = target(view().edges.start);
    start.dispatch('pointerdown', at(2, 0), {buttons: 1});
    fire('pointermove', at(0, 0.8), {buttons: 1});     // q 3.2 → the line at q 4
    fire('pointerup', at(0, 0.8));
    expect(edits.at(-1)).toEqual({a: 2, b: 10, aBar: ids()[1], bBar: ids()[4], phase: 'commit'});
  });

  it('an Alt handle drag snaps the edge to beats, and an edge never crosses the other one', () => {
    open();
    chart.setLoopRange({a: 4, b: 8});
    target(view().edges.end).dispatch('pointerdown', at(3, 1), {buttons: 1});
    fire('pointermove', at(4, 0.3), {buttons: 1, altKey: true});   // q 17.2 → beat 17
    fire('pointerup', at(4, 0.3), {altKey: true});
    expect(edits.at(-1)).toEqual({a: 4, b: 8.5, phase: 'commit'});
    chart.setLoopRange({a: 4, b: 8});
    target(view().edges.start).dispatch('pointerdown', at(2, 0), {buttons: 1});
    fire('pointermove', at(6, 0.5), {buttons: 1});   // past the end edge
    fire('pointerup', at(6, 0.5));
    expect(edits.at(-1)).toMatchObject({phase: 'commit', a: 3 * BAR, b: 8});
  });

  it('dragging inside the loop moves it by whole bars', () => {
    open();
    chart.setLoopRange({a: 4, b: 8});   // bars 3–4
    fire('pointerdown', at(2, 0.5), {buttons: 1});
    fire('pointermove', at(5, 0.5), {buttons: 1});
    fire('pointerup', at(5, 0.5));
    expect(edits.at(-1)).toEqual({a: 10, b: 14, aBar: ids()[5], bBar: ids()[6], phase: 'commit'});
    chart.setLoopRange({a: 10, b: 14});
    fire('pointerdown', at(6, 0.5), {buttons: 1});
    fire('pointermove', at(31, 0.5), {buttons: 1});   // clamped to the last bar
    fire('pointerup', at(31, 0.5));
    expect(edits.at(-1)).toMatchObject({a: 30 * BAR, b: 32 * BAR, phase: 'commit'});
  });

  it('a click inside the loop without a drag is still a tap', () => {
    open();
    chart.setLoopRange({a: 4, b: 8});
    mouseTap(at(2, 0.5));
    expect(events.map(e => e.kind)).toEqual(['tap']);
    expect(edits).toHaveLength(0);
  });

  it('touch handles work when stopped; while playing only the mouse moves them', () => {
    open();
    chart.setLoopRange({a: 4, b: 8});
    chart.setGlass(true);
    target(view().edges.end).dispatch('pointerdown', at(3, 1), {pointerType: 'touch'});
    fire('pointermove', at(5, 0.5), {pointerType: 'touch', buttons: 1});
    fire('pointerup', at(5, 0.5), {pointerType: 'touch'});
    expect(edits).toHaveLength(0);
    target(view().edges.end).dispatch('pointerdown', at(3, 1), {buttons: 1});
    fire('pointermove', at(5, 0.75), {buttons: 1});   // q 23 → the line at q 24
    fire('pointerup', at(5, 0.75));
    expect(edits.at(-1)).toMatchObject({phase: 'commit', b: 12});
    chart.setGlass(false);
    chart.setLoopRange({a: 4, b: 8});
    target(view().edges.end).dispatch('pointerdown', at(3, 1), {pointerType: 'touch'});
    fire('pointermove', at(4, 0.6), {pointerType: 'touch', buttons: 1});
    fire('pointerup', at(4, 0.6), {pointerType: 'touch'});
    expect(edits.at(-1)).toMatchObject({phase: 'commit', b: 10});
  });

  it('a committed edit is drawn until setLoopRange answers, and reverts if it never does', () => {
    open();
    chart.setLoopRange({a: 4, b: 8});
    fire('pointerdown', at(10, 0.5), {buttons: 1});
    fire('pointermove', at(12, 0.5), {buttons: 1});
    fire('pointerup', at(12, 0.5));
    expect(view().calls.setLoop.at(-1)[0]).toEqual([40, 52]);
    vi.advanceTimersByTime(999);
    expect(view().calls.setLoop.at(-1)[0]).toEqual([40, 52]);
    vi.advanceTimersByTime(1);
    expect(view().calls.setLoop.at(-1)[0]).toEqual([8, 16]);
  });

  it('a cancelled drag restores the loop and emits no commit', () => {
    open();
    chart.setLoopRange({a: 4, b: 8});
    fire('pointerdown', at(10, 0.5), {buttons: 1});
    fire('pointermove', at(12, 0.5), {buttons: 1});
    fire('pointercancel', at(12, 0.5));
    expect(edits.map(e => e.phase)).toEqual(['preview']);
    expect(view().calls.setLoop.at(-1)).toEqual([[8, 16], {}]);
  });
});

describe('setLoopRange', () => {
  it('draws the pushed loop without polling engine.loop', () => {
    const loop = vi.fn(() => ({enabled: true, a: 0, b: 1}));
    Object.defineProperty(engine, 'loop', {get: loop});
    open();
    const before = view().calls.setLoop.length;
    for (let t = 0; t < 10; t += 0.5) chart.tick(t);
    expect(view().calls.setLoop.length).toBe(before);
    chart.setLoopRange({a: 4, b: 8});
    expect(view().calls.setLoop.at(-1)).toEqual([[8, 16], {}]);
    chart.setLoopRange(null);
    expect(view().calls.setLoop.at(-1)).toEqual([null, {}]);
    chart.setLoopRange({a: 3, b: 3});
    expect(view().calls.setLoop.at(-1)).toEqual([null, {}]);
    expect(loop).not.toHaveBeenCalled();
  });

  it('a loop set before the first engraving is drawn when it lands', () => {
    chart = createChart({host, part, engine});
    chart.setLoopRange({a: 2, b: 6});
    chart.setVisible(true);
    expect(view().calls.setLoop.at(-1)).toEqual([[4, 12], {}]);
  });
});

describe('scale, pinch and fonts', () => {
  it('exports the scale steps and clamps to 80–200 %', () => {
    expect(SCALE_STEPS).toEqual([0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.45, 1.6, 1.8, 2.0]);
    expect(stepScale(1.2, 1)).toBe(1.3);
    expect(stepScale(1.25, 1)).toBe(1.3);
    expect(stepScale(1.25, -1)).toBe(1.2);
    expect(stepScale(2, 1)).toBe(2);
    expect(stepScale(0.8, -1)).toBe(0.8);
    expect(clampScale(3)).toBe(2);
    expect(clampScale(0.5)).toBe(0.8);
  });

  it('applies the font floors ceil(14 × d / scale) and ceil(20 × d / scale) before each relayout', () => {
    expect(FONT_FLOORS).toEqual({barNumber: 14, marker: 20});
    expect(fontFloors(FONT_FLOORS, 1.2)).toEqual({barNumber: 12, marker: 17});
    expect(fontFloors(FONT_FLOORS, 1.4)).toEqual({barNumber: 10, marker: 15});   // no float creep: 14 / 1.4 is 10
    expect(fontFloors({barNumber: 14 * 1.3, marker: 20 * 1.3}, 1.6)).toEqual({barNumber: 12, marker: 17});
    open({scale: 1.2});
    expect(view().options.fonts).toEqual({barNumber: 12, marker: 17});
    chart.setScale(2);
    expect(view().calls.configure.at(-1)).toEqual({scale: 2, fonts: {barNumber: 7, marker: 10}});
    const count = view().calls.relayout;
    chart.setFonts({barNumber: 14 * 1.3, marker: 20 * 1.3});   // Kit distance
    expect(view().settings.fonts).toEqual({barNumber: 10, marker: 13});
    expect(view().calls.relayout).toBe(count + 1);
    chart.setFonts({barNumber: 14 * 1.3, marker: 20 * 1.3});
    expect(view().calls.relayout).toBe(count + 1);   // unchanged sizes do not relayout
  });

  it('setScale relayouts once and keeps the anchor bar at its screen fraction', () => {
    open({scale: 1.2});
    chart.setFollow(false);
    scroller().scrollTop = 250;   // the follow line (33 % of 800 px) is at 514: system 4 (y 480), bar 16
    expect(chart.anchorBar()).toBe(16);
    const count = view().calls.relayout;
    chart.setScale(1.6);
    expect(view().calls.relayout).toBe(count + 1);
    // Bar 16's system is now at y 640; it keeps (480 − 250) / 800 of the viewport above it.
    expect(scroller().scrollTop).toBeCloseTo(640 - 230, 6);
    expect(chart.anchorBar()).toBe(16);
    chart.setScale(1.6);
    expect(view().calls.relayout).toBe(count + 1);
    chart.setScale(1.8, {anchor: false});
    expect(scroller().scrollTop).toBeCloseTo(410, 6);
  });

  it('previewScale transforms .chart-score only, around the pinch centre, clamped to 80–200 %', () => {
    open({scale: 1.6});
    const score = host.querySelector('.chart-score');
    const count = view().calls.relayout;
    chart.previewScale(1.1, {clientX: 300, clientY: 200});
    expect(score.style.transform).toBe('scale(1.1)');
    expect(score.style.transformOrigin).toBe('300px 200px');
    chart.previewScale(2);
    expect(score.style.transform).toBe('scale(1.25)');
    chart.previewScale(null);
    expect(score.style.transform).toBe('');
    expect(view().calls.relayout).toBe(count);
  });
});

describe('display (this device) and prefs', () => {
  it('reads the Display layout from prefs and never touches the 1.9 localStorage keys', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    prefs.set('chart.display.layout', 'split');
    open();
    expect(view().calls.setScore[0][1]).toEqual({layout: 'split'});
    chart.setDisplay({layout: 'combined'});   // the part's own layout is stored as null
    expect(prefs.get('chart.display.layout')).toBeNull();
    chart.setScale(1.45);
    const touched = [...getItem.mock.calls, ...setItem.mock.calls].map(([key]) => key);
    expect(touched.filter(key => /^ws\.(chart|practice)\./.test(key))).toEqual([]);
    const source = readFileSync(join(process.cwd(), 'src/js/notation/chart.js'), 'utf8');
    expect(source).not.toMatch(/localStorage|sessionStorage/);
  });

  it('setDisplay changes layout and bars per row in one relayout and stores the layout', () => {
    open();
    const scores = view().calls.setScore.length, count = view().calls.relayout;
    chart.setDisplay({layout: 'split', barsPerRow: 2});
    expect(prefs.get('chart.display.layout')).toBe('split');
    expect(view().calls.setScore.length).toBe(scores + 1);
    expect(view().calls.setScore.at(-1)[1]).toEqual({layout: 'split'});
    expect(view().calls.relayout).toBe(count);
    expect(view().settings.barsPerRow).toBe(2);
    chart.setDisplay({barsPerRow: 4});
    expect(view().calls.relayout).toBe(count + 1);
    expect(view().calls.setScore.length).toBe(scores + 1);
    chart.setDisplay({barsPerRow: 4});
    chart.setDisplay({layout: 'diagonal'});
    expect(view().calls.relayout).toBe(count + 1);
    expect(chart.state.layout).toBe('split');
  });

  it('an explicit display option wins over prefs', () => {
    prefs.set('chart.display.layout', 'split');
    open({display: {layout: null, barsPerRow: 2}});
    expect(view().calls.setScore[0][1]).toEqual({layout: 'combined'});
    expect(view().options.barsPerRow).toBe(2);
  });
});

describe('follow', () => {
  it('scroll style holds the playing system at followAnchor of the viewport', () => {
    open({scale: 1, followAnchor: 0.28});
    chart.tick(20 * BAR);            // bar 20: system 5, y 500
    expect(scroller().scrollTop).toBeCloseTo(500 - 0.28 * 800, 6);
    chart.tick(20.5 * BAR);          // same system: no scroll
    scroller().scrollTop = 123;
    chart.tick(21 * BAR);
    expect(scroller().scrollTop).toBe(123);
    chart.setFollowStyle('scroll', {anchor: 0.33});   // a layout switch (rail)
    expect(scroller().scrollTop).toBeCloseTo(500 - 0.33 * 800, 6);
    expect(chart.state.followAnchor).toBe(0.33);
  });

  it('scroll targets count the stage’s offset inside the scroller (the score padding)', () => {
    open({scale: 1});
    stage().getBoundingClientRect = () => { const top = 8 - scroller().scrollTop; return {x: 0, y: top, left: 0, top, width: 800, height: 0, right: 800, bottom: top}; };
    chart.tick(20 * BAR);
    expect(scroller().scrollTop).toBeCloseTo(508 - 0.33 * 800, 6);
    expect(chart.anchorBar()).toBe(20);
  });

  it('tick takes the frame time and falls back to engine.getPosition()', () => {
    open({scale: 1});
    chart.tick(9 * BAR);
    expect(view().calls.setPlayhead.at(-1)).toBe(36);
    engine.getPosition.mockReturnValue(3 * BAR);
    chart.tick();
    expect(view().calls.setPlayhead.at(-1)).toBe(12);
  });

  it('page style advances half a viewport over 200 ms when the playing system crosses the middle', () => {
    part = makePart(demoScore(128, 120));   // 64 bars, 16 systems
    open({scale: 1, followStyle: 'page', followAnchor: 0.28});
    chart.tick(0);
    chart.tick(8 * BAR);                     // system 2 (y 200), still in the top half
    expect(scroller().scrollTop).toBe(0);
    chart.tick(16 * BAR);                    // system 4 (y 400) crosses the middle
    flushFrames(1);
    expect(scroller().scrollTop).toBe(0);
    flushFrames(6);                          // 100 ms in
    const mid = scroller().scrollTop;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(400);
    flushFrames(8);
    expect(scroller().scrollTop).toBe(400);
    chart.tick(20 * BAR); chart.tick(24 * BAR); chart.tick(28 * BAR);   // systems 5–7 sit in view
    flushFrames(20);
    expect(scroller().scrollTop).toBe(400);
    chart.tick(32 * BAR);                    // system 8 (y 800) crosses 400 + 400
    flushFrames(20);
    expect(scroller().scrollTop).toBe(800);
    chart.tick(0);                           // a loop wrap back out of view page-aligns into the top half
    flushFrames(20);
    expect(scroller().scrollTop).toBe(0);
    expect(follows).toEqual([]);
  });

  it('page turns jump under reduced motion', () => {
    setMedia({reducedMotion: true});
    part = makePart(demoScore(128, 120));
    open({scale: 1, followStyle: 'page'});
    chart.tick(16 * BAR);
    expect(scroller().scrollTop).toBe(400);
  });

  it('a manual scroll pauses Follow, stopped or playing, except within 900 ms of a programmatic scroll', () => {
    open({scale: 1});
    chart.tick(20 * BAR);                       // programmatic scroll
    scroller().dispatchEvent(new WheelEvent('wheel', {deltaY: 40}));
    expect(follows).toEqual([]);
    vi.advanceTimersByTime(901);
    const zoom = new WheelEvent('wheel', {deltaY: 40});
    Object.defineProperty(zoom, 'ctrlKey', {value: true});   // happy-dom's WheelEvent drops modifier keys
    scroller().dispatchEvent(zoom);                          // ⌘/Ctrl-wheel is the surface's zoom
    expect(follows).toEqual([]);
    scroller().dispatchEvent(new WheelEvent('wheel', {deltaY: 40}));
    expect(follows).toEqual([false]);
    expect(chart.state.follow).toBe(false);
    scroller().scrollTop = 77;
    chart.tick(28 * BAR);
    expect(scroller().scrollTop).toBe(77);
    expect(view().calls.setPlayhead.at(-1)).toBe(28 * 4);
    chart.setFollow(true);
    expect(follows).toEqual([false, true]);
    expect(scroller().scrollTop).toBeCloseTo(700 - 0.33 * 800, 6);
    vi.advanceTimersByTime(901);
    const touchmove = new Event('touchmove', {bubbles: true});
    touchmove.touches = [{}];
    scroller().dispatchEvent(touchmove);
    expect(follows).toEqual([false, true, false]);
  });

  it('a scrollbar drag pauses Follow; a press on the music does not', () => {
    open({scale: 1});
    vi.advanceTimersByTime(1000);
    mouseTap(at(1, 0.5, 1));
    expect(follows).toEqual([]);
    firePointer(scroller(), 'pointerdown', {x: 895, y: 10});
    expect(follows).toEqual([false]);
  });

  it('reveal puts a time at the follow line, and waits for the first engraving when asked early', () => {
    chart = createChart({host, part, engine, scale: 1});
    sizeScroller();
    chart.reveal(24 * BAR);          // bar 24: system 6, y 600
    expect(scroller().scrollTop).toBe(0);
    chart.setVisible(true);
    expect(scroller().scrollTop).toBeCloseTo(600 - 0.33 * 800, 6);
    chart.reveal(8 * BAR);
    expect(scroller().scrollTop).toBe(0);   // y 200 − 264 clamps at the top
  });

  it('anchorBar is the playing bar when its system is at the follow line, else that system’s first bar', () => {
    open({scale: 1});
    chart.tick(21 * BAR);   // bar 21 in system 5 (y 500); scrolled to 500 − 264
    expect(chart.anchorBar()).toBe(21);
    chart.setFollow(false);
    scroller().scrollTop = 0;
    expect(chart.anchorBar()).toBe(8);   // the line at 264 is in system 2
  });

  it('barAtPoint maps client coordinates to a bar and time', () => {
    open({scale: 1});
    expect(chart.barAtPoint(at(6, 0.5, 1).x, at(6, 0.5, 1).y)).toEqual({index: 6, q: 26, time: 13});
    expect(chart.barAtPoint(5000, 5000)).toBeNull();
  });
});
