// @vitest-environment happy-dom
// src/ui/position.js: place() flips and clamps (pure), anchorTo() in its JS fallback mode.
import {afterEach, describe, expect, test} from 'vitest';
import {anchorTo, place, rectOf, supportsAnchor, viewportRect} from '../src/ui/position.js';
import {restoreDomShims, setRect} from './helpers/dom.js';

const VIEW = {width: 1000, height: 800};
const SIZE = {width: 200, height: 100};
const rect = (x, y, width = 100, height = 40) => ({x, y, width, height});

describe('place(): preferred side', () => {
  test.each([
    ['bottom', {x: 400, y: 448, side: 'bottom'}],
    ['top', {x: 400, y: 292, side: 'top'}],
    ['right', {x: 508, y: 400, side: 'right'}],
    ['left', {x: 192, y: 400, side: 'left'}],
    ['auto', {x: 400, y: 448, side: 'bottom'}],
  ])('%s fits and is used, aligned with the anchor start, gap 8', (placement, expected) => {
    const r = place(rect(400, 400), SIZE, VIEW, placement);
    expect(r).toMatchObject({...expected, flipped: false, maxWidth: null, maxHeight: null});
  });

  test('align centre and end', () => {
    expect(place(rect(400, 400), SIZE, VIEW, 'bottom', {align: 'center'}).x).toBe(350);
    expect(place(rect(400, 400), SIZE, VIEW, 'bottom', {align: 'end'}).x).toBe(300);
    expect(place(rect(400, 400), SIZE, VIEW, 'right', {align: 'center'}).y).toBe(370);
  });

  test('gap and margin options', () => {
    expect(place(rect(400, 400), SIZE, VIEW, 'bottom', {gap: 0}).y).toBe(440);
    expect(place(rect(0, 400), SIZE, VIEW, 'bottom', {margin: 16}).x).toBe(16);
  });
});

describe('place(): flips', () => {
  test.each([
    ['bottom → top near the bottom edge', rect(400, 700), 'bottom', {side: 'top', y: 592, flipped: true}],
    ['top → bottom near the top edge', rect(400, 20), 'top', {side: 'bottom', y: 68, flipped: true}],
    ['right → left near the right edge', rect(850, 400), 'right', {side: 'left', x: 642, flipped: true}],
    ['left → right near the left edge', rect(20, 400), 'left', {side: 'right', x: 128, flipped: true}],
  ])('%s', (_, anchor, placement, expected) => {
    expect(place(anchor, SIZE, VIEW, placement)).toMatchObject(expected);
  });

  test('auto tries bottom, top, right, left in order', () => {
    // Bottom and top have no room for 500 px; right has 1000 − 8 − 108 = 884 ≥ 200.
    const tall = {width: 200, height: 500};
    expect(place(rect(0, 360, 100, 80), tall, VIEW, 'auto')).toMatchObject({side: 'right', x: 108});
    expect(place(rect(880, 360, 100, 80), tall, VIEW, 'auto')).toMatchObject({side: 'left', x: 672});
  });

  test('neither side fits: the roomier side, shrunk to it', () => {
    const tall = {width: 200, height: 600};
    // Anchor near the top: top has 300 − 8 − 8 = 284, bottom has 800 − 8 − 348 = 444.
    const r = place(rect(400, 300, 100, 40), tall, VIEW, 'top');
    expect(r).toMatchObject({side: 'bottom', y: 348, maxHeight: 444, flipped: true});
    // Anchor near the bottom: top wins and the overlay ends at the gap above the anchor.
    const up = place(rect(400, 600, 100, 40), tall, VIEW, 'bottom');
    expect(up).toMatchObject({side: 'top', maxHeight: 584, y: 8});
  });
});

describe('place(): clamps', () => {
  test('the cross axis stays margin px inside the viewport', () => {
    expect(place(rect(950, 400, 40, 40), SIZE, VIEW, 'bottom').x).toBe(792);
    expect(place(rect(-50, 400, 40, 40), SIZE, VIEW, 'bottom').x).toBe(8);
    expect(place(rect(400, 780, 100, 10), SIZE, VIEW, 'right').y).toBe(692);
    expect(place(rect(400, -30, 100, 10), SIZE, VIEW, 'left').y).toBe(8);
  });

  test('an overlay wider than the viewport is pinned at the margin and shrunk', () => {
    const r = place(rect(400, 100), {width: 1200, height: 100}, VIEW, 'bottom');
    expect(r).toMatchObject({x: 8, maxWidth: 984});
  });

  test('viewport offsets (a scrolled visual viewport)', () => {
    const r = place(rect(400, 400), SIZE, {x: 100, y: 50, width: 600, height: 500}, 'bottom');
    expect(r).toMatchObject({side: 'top', y: 292});
    expect(place(rect(50, 100), SIZE, {x: 100, y: 0, width: 600, height: 800}, 'bottom').x).toBe(108);
  });

  test('a point anchor behaves as a zero-size rect', () => {
    expect(place({x: 300, y: 200}, SIZE, VIEW, 'bottom', {gap: 2})).toMatchObject({x: 300, y: 202, side: 'bottom'});
    expect(place({x: 990, y: 790}, SIZE, VIEW, 'bottom', {gap: 2})).toMatchObject({x: 792, y: 688, side: 'top'});
  });

  test('results are whole pixels', () => {
    const r = place(rect(400.4, 400.6, 99.3, 40.2), {width: 200.5, height: 100.5}, VIEW, 'bottom', {align: 'center'});
    expect(Number.isInteger(r.x) && Number.isInteger(r.y)).toBe(true);
  });
});

describe('rectOf and argument checks', () => {
  test('accepts {x, y, width, height}, {left, top, right, bottom} and points', () => {
    expect(rectOf({left: 10, top: 20, right: 30, bottom: 60})).toEqual({left: 10, top: 20, width: 20, height: 40, right: 30, bottom: 60});
    expect(rectOf({x: 5, y: 6})).toMatchObject({width: 0, height: 0, right: 5, bottom: 6});
  });
  test('rejects unknown placements and missing anchors', () => {
    expect(() => place(rect(0, 0), SIZE, VIEW, 'middle')).toThrow(RangeError);
    expect(() => place(null, SIZE, VIEW)).toThrow(TypeError);
  });
});

describe('anchorTo(): the JS fallback', () => {
  afterEach(() => {
    restoreDomShims();
    document.body.replaceChildren();
  });

  const mount = () => {
    const anchor = document.createElement('button');
    const el = document.createElement('div');
    document.body.append(anchor, el);
    setRect(anchor, rect(400, 700));
    setRect(el, {x: 0, y: 0, ...SIZE});
    return {anchor, el};
  };

  test('without CSS anchor positioning an element anchor uses place()', () => {
    const {anchor, el} = mount();
    const positioner = anchorTo(el, anchor, {placement: 'bottom', mode: 'js'});
    expect(positioner.mode).toBe('js');
    expect(el.dataset.anchor).toBe('js');
    const expected = place(rect(400, 700), SIZE, viewportRect(window), 'bottom');
    expect(el.style.left).toBe(`${expected.x}px`);
    expect(el.style.top).toBe(`${expected.y}px`);
    expect(el.dataset.side).toBe(expected.side);
    positioner.destroy();
    expect(el.dataset.anchor).toBeUndefined();
    expect(el.style.left).toBe('');
  });

  test('update() re-measures; a point anchor works', () => {
    const {anchor, el} = mount();
    const positioner = anchorTo(el, anchor, {placement: 'top', mode: 'js'});
    setRect(anchor, rect(100, 300));
    positioner.update();
    expect(el.style.left).toBe('100px');
    expect(el.style.top).toBe(`${300 - 8 - SIZE.height}px`);
    positioner.destroy();
    const point = anchorTo(el, {x: 50, y: 60}, {placement: 'bottom', gap: 2});
    expect(point.mode).toBe('js');
    expect(el.style.top).toBe('62px');
    point.destroy();
  });

  test('supportsAnchor reads CSS.supports and the style properties', () => {
    expect(supportsAnchor({CSS: {supports: () => false}, document})).toBe(false);
    expect(supportsAnchor({CSS: {supports: () => true}, document: {documentElement: {style: {}}}})).toBe(false);
    expect(supportsAnchor({CSS: {supports: () => true}, document: {documentElement: {style: {anchorName: ''}}}})).toBe(true);
    expect(supportsAnchor({})).toBe(false);
  });

  test('css mode sets and removes anchor-name / position-anchor', () => {
    const {anchor, el} = mount();
    const positioner = anchorTo(el, anchor, {placement: 'left', mode: 'css'});
    expect(positioner.mode).toBe('css');
    const name = anchor.style.getPropertyValue('anchor-name');
    expect(name).toMatch(/^--ui-anchor-\d+$/);
    expect(el.style.getPropertyValue('position-anchor')).toBe(name);
    expect(el.dataset).toMatchObject({anchor: 'css', placement: 'left', side: 'left'});
    positioner.destroy();
    expect(anchor.style.getPropertyValue('anchor-name')).toBe('');
    expect(el.dataset.anchor).toBeUndefined();
  });
});
