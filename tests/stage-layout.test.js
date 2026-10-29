// @vitest-environment happy-dom
// The Stage's layout rules (architecture §2.14.9; spec §4.1, §4.10, §4.11): the rail/band decision,
// Distance metrics and rail widths, the spec's vertical budgets, the Focus geometry, the root data
// attributes and the 150 ms debounced relayout. Pure functions with dimensions as inputs (§0.1).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {
  DISTANCE, DISTANCES, FRAME, LAYOUT_DEBOUNCE_MS, MINI_RAIL, RAIL_WIDTHS,
  applyStageAttributes, chartScale, createLayoutWatcher, distanceOf, focusGeometry, isNarrow, railWidth, readoutSizes, stageGeometry, stageLayout,
} from '../src/stage/layout.js';

describe('stageLayout (spec §4.1: vw / vh ≥ 1.15 && vw ≥ 1000 → rail)', () => {
  test.each([
    ['laptop 1440×900', 1440, 900, 'rail'],
    ['desktop 1920×1080', 1920, 1080, 'rail'],
    ['laptop 1280×800', 1280, 800, 'rail'],
    ['iPad landscape 1180×820', 1180, 820, 'rail'],
    ['iPad mini landscape 1133×744', 1133, 744, 'rail'],
    ['iPad portrait 820×1180', 820, 1180, 'band'],
    ['iPad mini portrait 744×1133', 744, 1133, 'band'],
    ['a narrow window 999×600', 999, 600, 'band'],
    ['just under the ratio 1000×870', 1000, 870, 'band'],
    ['just over the ratio 1000×869', 1000, 869, 'rail'],
    ['square 1200×1200', 1200, 1200, 'band'],
    ['no size yet', 0, 0, 'band'],
  ])('%s → %s', (_, vw, vh, want) => {
    expect(stageLayout({vw, vh})).toBe(want);
  });

  test('missing or bad numbers are the band', () => {
    expect(stageLayout()).toBe('band');
    expect(stageLayout({vw: 'wide', vh: NaN})).toBe('band');
  });
});

describe('Distance and the rail (spec §4.11)', () => {
  test('the factors and names', () => {
    expect(DISTANCES).toEqual(['near', 'stand', 'kit']);
    expect(DISTANCE).toEqual({near: 0.8, stand: 1, kit: 1.3});
    expect(distanceOf('kit')).toBe('kit');
    expect(distanceOf('far')).toBe('stand');
    expect(distanceOf(undefined)).toBe('stand');
  });

  test.each([
    ['near', 1440, 232], ['stand', 1440, 264], ['kit', 1440, 312],
    ['near', 1279, 200], ['stand', 1279, 232], ['kit', 1279, 280],
    ['stand', 1280, 264], ['stand', 1180, 232],
  ])('railWidth %s at %i px → %i', (distance, vw, want) => {
    expect(railWidth({distance, vw})).toBe(want);
  });

  test('Focus collapses the rail to the 120 px mini rail at every Distance', () => {
    for (const distance of DISTANCES) expect(railWidth({distance, vw: 1440, focus: true})).toBe(MINI_RAIL);
    expect(MINI_RAIL).toBe(120);
    expect(RAIL_WIDTHS).toEqual({near: 232, stand: 264, kit: 312});
  });

  test('narrow below 1280 px', () => {
    expect(isNarrow({vw: 1279})).toBe(true);
    expect(isNarrow({vw: 1280})).toBe(false);
  });

  test.each([
    ['rail', 'near', 1.1], ['rail', 'stand', 1.3], ['rail', 'kit', 1.6],
    ['band', 'near', 1.0], ['band', 'stand', 1.2], ['band', 'kit', 1.5],
  ])('chartScale on the %s at %s → %d', (layout, distance, want) => {
    expect(chartScale({distance, layout})).toBe(want);
  });

  test('chartScale without a layout follows the orientation (portrait → the band values)', () => {
    expect(chartScale({distance: 'stand', orientation: 'portrait'})).toBe(1.2);
    expect(chartScale({distance: 'stand', orientation: 'landscape'})).toBe(1.3);
  });

  test.each([
    ['rail', 'near', 52, 32], ['rail', 'stand', 64, 40], ['rail', 'kit', 84, 52],
    ['band', 'near', 44, 32], ['band', 'stand', 56, 40], ['band', 'kit', 72, 52],
  ])('readout sizes on the %s at %s: Position %i, Section %i', (layout, distance, position, section) => {
    expect(readoutSizes({distance, layout})).toMatchObject({position, section, factor: DISTANCE[distance]});
  });
});

describe('stageGeometry: the spec §4.1 budgets', () => {
  test('laptop 1440×900 at Stand: the music column is 1176 × 844 above a 56 px strip', () => {
    const g = stageGeometry({vw: 1440, vh: 900, distance: 'stand'});
    expect(g).toMatchObject({layout: 'rail', rail: 264, strip: 56, music: {width: 1176, height: 844}});
  });

  test('laptop Focus: the music column is 1320 wide beside the mini rail', () => {
    expect(stageGeometry({vw: 1440, vh: 900, distance: 'stand', focus: true}).music.width).toBe(1320);
  });

  test('the rail is wider at Kit, so the music narrows; the width is fixed per layout and Distance', () => {
    expect(stageGeometry({vw: 1440, vh: 900, distance: 'kit'}).music.width).toBe(1440 - 312);
    expect(stageGeometry({vw: 1440, vh: 900, distance: 'near'}).music.width).toBe(1440 - 232);
  });

  test('iPad portrait 820×1180 at Stand: status 24 + identity 44 + readouts 88 + music 860 + strip 56 + dock 88 + safe area 20', () => {
    const g = stageGeometry({vw: 820, vh: 1180, distance: 'stand', safeTop: 24, safeBottom: 20});
    expect(g).toMatchObject({layout: 'band', rail: 0, strip: 56, dock: 88, music: {width: 820, height: 860}});
    expect(24 + FRAME.identity + FRAME.readouts + g.music.height + FRAME.strip + FRAME.dock + 20).toBe(1180);
  });

  test('iPad portrait Focus: 24 + readouts 88 + music 1048 + 20; only the height changes', () => {
    const plain = stageGeometry({vw: 820, vh: 1180, safeTop: 24, safeBottom: 20});
    const focus = stageGeometry({vw: 820, vh: 1180, safeTop: 24, safeBottom: 20, focus: true});
    expect(focus.music).toEqual({width: 820, height: 1048});
    expect(focus.music.width).toBe(plain.music.width);
    expect(focus).toMatchObject({strip: 0, dock: 0});
  });
});

describe('focusGeometry (spec §4.10)', () => {
  test('band: hides the identity row, the strip and the dock with a 72 px reveal zone and a 5 s reveal; no relayout', () => {
    expect(focusGeometry({layout: 'band'})).toEqual({relayout: false, railWidth: 0, hides: ['identity', 'strip', 'dock'], revealZone: 72, revealMs: 5000});
  });

  test('rail: the 120 px mini rail with Section, Position, lamps, Speed and Play; one relayout', () => {
    expect(focusGeometry({layout: 'rail'})).toEqual({relayout: true, railWidth: 120, hides: [], mini: ['section', 'position', 'lamps', 'speed', 'play']});
  });
});

describe('applyStageAttributes', () => {
  test('writes data-stage-layout, data-distance, data-focus, data-playing and data-rail-narrow (rail only)', () => {
    const root = document.createElement('div');
    applyStageAttributes(root, {layout: 'rail', distance: 'kit', focus: true, playing: true, narrow: true});
    expect(root.getAttribute('data-stage-layout')).toBe('rail');
    expect(root.getAttribute('data-distance')).toBe('kit');
    expect(root.hasAttribute('data-focus')).toBe(true);
    expect(root.hasAttribute('data-playing')).toBe(true);
    expect(root.hasAttribute('data-rail-narrow')).toBe(true);
    applyStageAttributes(root, {layout: 'band', distance: 'nowhere', focus: false, playing: false, narrow: true});
    expect(root.getAttribute('data-stage-layout')).toBe('band');
    expect(root.getAttribute('data-distance')).toBe('stand');
    expect(root.hasAttribute('data-focus')).toBe(false);
    expect(root.hasAttribute('data-playing')).toBe(false);
    expect(root.hasAttribute('data-rail-narrow')).toBe(false);
  });

  test('touches only what changed', () => {
    const root = document.createElement('div');
    applyStageAttributes(root, {layout: 'rail', distance: 'stand'});
    const spy = vi.spyOn(root, 'setAttribute');
    applyStageAttributes(root, {layout: 'rail', distance: 'stand'});
    expect(spy).not.toHaveBeenCalled();
    applyStageAttributes(root, {layout: 'rail', distance: 'near'});
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('no root, no error', () => {
    expect(() => applyStageAttributes(null, {layout: 'rail'})).not.toThrow();
  });
});

describe('createLayoutWatcher: one relayout per settled resize (150 ms)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('a burst of resizes ends in one onChange, 150 ms after the last, with the new and old layouts', () => {
    let size = {vw: 1440, vh: 900};
    const onChange = vi.fn();
    const w = createLayoutWatcher({measure: () => size, onChange});
    expect(w.current).toMatchObject({layout: 'rail', narrow: false});
    size = {vw: 820, vh: 1180};
    w.schedule();
    vi.advanceTimersByTime(100);
    w.schedule();
    vi.advanceTimersByTime(100);
    w.schedule();
    vi.advanceTimersByTime(LAYOUT_DEBOUNCE_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({layout: 'band', vw: 820, vh: 1180});
    expect(onChange.mock.calls[0][1]).toMatchObject({layout: 'rail'});
  });

  test('a resize that keeps the layout (and the rail variant) relayouts nothing', () => {
    let size = {vw: 1440, vh: 900};
    const onChange = vi.fn();
    const w = createLayoutWatcher({measure: () => size, onChange});
    size = {vw: 1500, vh: 880};
    w.schedule();
    vi.advanceTimersByTime(LAYOUT_DEBOUNCE_MS);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('crossing 1280 px on the rail is a relayout (the rail is 32 px slimmer)', () => {
    let size = {vw: 1440, vh: 900};
    const onChange = vi.fn();
    const w = createLayoutWatcher({measure: () => size, onChange});
    size = {vw: 1200, vh: 800};
    w.schedule();
    vi.advanceTimersByTime(LAYOUT_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({layout: 'rail', narrow: true});
  });

  test('flush() runs a pending check now; destroy() cancels it', () => {
    let size = {vw: 1440, vh: 900};
    const onChange = vi.fn();
    const w = createLayoutWatcher({measure: () => size, onChange});
    size = {vw: 820, vh: 1180};
    w.schedule();
    w.flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    size = {vw: 1440, vh: 900};
    w.schedule();
    w.destroy();
    vi.advanceTimersByTime(LAYOUT_DEBOUNCE_MS * 2);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('needs a measure function', () => {
    expect(() => createLayoutWatcher({})).toThrow(TypeError);
  });
});
