// @vitest-environment happy-dom
// ST2: src/stage/loop-handles.js — the loop band and handles: 44 px × row-height hit areas,
// edge and inside drags with the surface's snapping (Alt / Shift), pointer capture, 50% and
// touch-scroll while playing, the 120 ms spring after a drag (reduced motion: a jump), wrapped
// Road map rows and the cooperation with press.js.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {mountLoopHandles, SPRING_MS} from '../src/stage/loop-handles.js';
import {pointer, restoreDomShims, setMedia, setRect} from './helpers/dom.js';

const PX = 100;   // px per second on the Stems-like timeline
let host, parent, handles, edits, playing, snap, parentDowns;

const rect = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height, x: left, y: top});
const STEM_ROWS = [rect(0, 0, 800, 100), rect(0, 100, 800, 100), rect(0, 200, 800, 100)];

function mount(opts = {}) {
  parent = document.createElement('div');
  host = document.createElement('div');
  parent.append(host);
  document.body.append(parent);
  setRect(host, {x: 0, y: 0, width: 800, height: 300});
  edits = [];
  playing = false;
  parentDowns = 0;
  parent.addEventListener('pointerdown', () => { parentDowns++; });
  // Bars are whole seconds, Alt snaps to quarter-second beats; mode 'ceil'/'floor' is honoured.
  snap = vi.fn((t, {alt, shift, mode}) => {
    if (shift) return t;
    const step = alt ? 0.25 : 1, round = mode === 'ceil' ? Math.ceil : mode === 'floor' ? Math.floor : Math.round;
    return round(t / step) * step;
  });
  handles = mountLoopHandles(host, {
    toX: t => t * PX, toT: x => x / PX, rows: () => STEM_ROWS, snap,
    onEdit: e => edits.push(e), playing: () => playing, ...opts,
  });
  return handles;
}

const root = () => host.querySelector('.loop-handles');
const visible = sel => [...host.querySelectorAll(sel)].filter(el => !el.hidden);
const box = el => ({left: parseFloat(el.style.left), top: parseFloat(el.style.top), width: parseFloat(el.style.width), height: parseFloat(el.style.height)});
const handleAt = (edge, row = 0) => visible(`.loop-handle[data-edge=${edge}]`).find(el => parseFloat(el.style.top) === row * 100);
const withCapture = el => {
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  el.hasPointerCapture = vi.fn(() => true);
  return el;
};
const mouse = (x, extra = {}) => ({x, y: 50, pointerType: 'mouse', pointerId: 1, ...extra});
const r6 = v => Math.round(v * 1e6) / 1e6;

beforeEach(() => { vi.useFakeTimers(); setMedia({reducedMotion: false}); });
afterEach(() => {
  handles?.destroy();
  parent?.remove();
  vi.useRealTimers();
  restoreDomShims();
});

describe('rendering', () => {
  test('an aria-hidden overlay; a --loop-fill band per row and a handle per edge per row', () => {
    mount();
    expect(root().getAttribute('aria-hidden')).toBe('true');
    expect(visible('.loop-band')).toHaveLength(0);
    handles.set({a: 1, b: 3});
    const bands = visible('.loop-band');
    expect(bands.map(box)).toEqual([0, 100, 200].map(top => ({left: 100, top, width: 200, height: 100})));
    expect(bands.every(b => b.hasAttribute('data-press-nodrag'))).toBe(true);
    expect(visible('.loop-handle')).toHaveLength(6);
    for (const row of [0, 1, 2]) {
      expect(box(handleAt('a', row))).toEqual({left: 78, top: row * 100, width: 44, height: 100});
      expect(box(handleAt('b', row))).toEqual({left: 278, top: row * 100, width: 44, height: 100});
    }
    const a = handleAt('a');
    expect(a.style.getPropertyValue('--edge-x')).toBe('22px');
    expect(a.hasAttribute('data-press-ignore')).toBe(true);
    expect(a.querySelector('.loop-handle-edge')).not.toBeNull();
    expect(a.querySelector('.loop-handle-grip')).not.toBeNull();
    expect(handles.range).toEqual({a: 1, b: 3});
  });

  test('44 px hit areas split at the midpoint when the edges are closer than that', () => {
    mount();
    handles.set({a: 1, b: 1.2});
    expect(box(handleAt('a'))).toMatchObject({left: 78, width: 32});
    expect(box(handleAt('b'))).toMatchObject({left: 110, width: 32});
    expect(handleAt('b').style.getPropertyValue('--edge-x')).toBe('10px');
  });

  test('a custom hit width, edges off the visible rows, set(null) and invalid ranges hide', () => {
    mount({hitWidth: 24});
    handles.set({a: 1, b: 3});
    expect(box(handleAt('a')).width).toBe(24);
    handles.set({a: -5, b: 3});   // a is far left of every row: only b's handles show
    expect(visible('.loop-handle[data-edge=a]')).toHaveLength(0);
    expect(visible('.loop-band').map(box)[0]).toMatchObject({left: 0, width: 300});
    handles.set(null);
    expect(visible('.loop-band, .loop-handle')).toHaveLength(0);
    expect(handles.range).toBeNull();
    handles.set({a: 3, b: 1});
    expect(handles.range).toBeNull();
  });

  test('while playing the overlay says so (handles at 50% in CSS); update() re-reads playing()', () => {
    mount();
    handles.set({a: 1, b: 3});
    expect(root().hasAttribute('data-playing')).toBe(false);
    playing = true;
    handles.update();
    expect(root().hasAttribute('data-playing')).toBe(true);
  });

  test('wrapped Road map rows: {row, x} positions, the band across rows, one handle per edge', () => {
    const ROW = 4, W = 800;
    const rows = [rect(0, 0, W, 88), rect(0, 100, W, 88), rect(0, 200, W, 88)];
    const toX = (t, side) => {
      let row = Math.floor(t / ROW);
      if (side === 'b' && t % ROW === 0 && t > 0) row -= 1;
      return {row, x: (t - row * ROW) * (W / ROW)};
    };
    mount({toX, rows: () => rows, toT: (x, y) => Math.floor(y / 100) * ROW + x / (W / ROW)});
    handles.set({a: 2, b: 9});
    expect(visible('.loop-band').map(box)).toEqual([
      {left: 400, top: 0, width: 400, height: 88}, {left: 0, top: 100, width: 800, height: 88}, {left: 0, top: 200, width: 200, height: 88}]);
    const [a] = visible('.loop-handle[data-edge=a]'), [b] = visible('.loop-handle[data-edge=b]');
    expect(box(a)).toEqual({left: 378, top: 0, width: 44, height: 88});
    expect(box(b)).toEqual({left: 178, top: 200, width: 44, height: 88});
    // A loop ending exactly on a row break ends that row ('b' side), not the next.
    handles.set({a: 1, b: 4});
    expect(visible('.loop-band').map(box)).toEqual([{left: 200, top: 0, width: 600, height: 88}]);
    // Edges before / after the rendered rows (virtualised): the band runs to the edge of the view.
    mount({toX: t => ({row: t < 0 ? -1 : 9, x: 0}), rows: () => rows, toT: () => 0});
    handles.set({a: -1, b: 50});
    expect(visible('.loop-band')).toHaveLength(3);
    expect(visible('.loop-handle')).toHaveLength(0);
  });
});

describe('edge drags', () => {
  test('pointer capture, snapped previews, a commit on release and the 120 ms spring', () => {
    mount();
    handles.set({a: 1, b: 3});
    const a = withCapture(handleAt('a'));
    pointer(a, 'pointerdown', mouse(100));
    expect(a.setPointerCapture).toHaveBeenCalledWith(1);
    expect(parentDowns).toBe(0);   // the handle keeps its press from the surface
    pointer(a, 'pointermove', mouse(140));
    expect(edits.at(-1)).toEqual({a: 1, b: 3, phase: 'preview'});
    pointer(a, 'pointermove', mouse(170));
    expect(edits.at(-1)).toEqual({a: 2, b: 3, phase: 'preview'});
    expect(snap).toHaveBeenLastCalledWith(1.7, {alt: false, shift: false});   // only the dragged edge
    // While dragging, the handle follows the pointer (unsnapped) and the band follows it.
    expect(box(a).left).toBe(170 - 22);
    expect(visible('.loop-band').map(box)[0]).toMatchObject({left: 170, width: 130});
    expect(handles.dragging).toBe(true);
    pointer(a, 'pointerup', mouse(170));
    expect(edits.at(-1)).toEqual({a: 2, b: 3, phase: 'commit'});
    expect(edits.filter(e => e.phase === 'commit')).toHaveLength(1);
    expect(a.releasePointerCapture).toHaveBeenCalledWith(1);
    // Spring: the snapped line, animated over --motion-fast.
    expect(root().hasAttribute('data-spring')).toBe(true);
    expect(box(a).left).toBe(200 - 22);
    expect(SPRING_MS).toBe(120);
    vi.advanceTimersByTime(119);
    expect(root().hasAttribute('data-spring')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(root().hasAttribute('data-spring')).toBe(false);
    expect(handles.range).toEqual({a: 2, b: 3});
  });

  test('reduced motion: the handles jump (no spring)', () => {
    setMedia({reducedMotion: true});
    mount();
    handles.set({a: 1, b: 3});
    const b = withCapture(handleAt('b'));
    pointer(b, 'pointerdown', mouse(300));
    pointer(b, 'pointermove', mouse(420));
    pointer(b, 'pointerup', mouse(420));
    expect(edits.at(-1)).toEqual({a: 1, b: 4, phase: 'commit'});
    expect(root().hasAttribute('data-spring')).toBe(false);
    expect(box(handleAt('b')).left).toBe(400 - 22);
  });

  test('Alt snaps to the surface\'s beats and Shift does not snap: the modifiers reach snap()', () => {
    mount();
    handles.set({a: 1, b: 3});
    const b = withCapture(handleAt('b'));
    pointer(b, 'pointerdown', mouse(300));
    pointer(b, 'pointermove', mouse(337, {altKey: true}));
    expect(snap).toHaveBeenLastCalledWith(3.37, {alt: true, shift: false});
    expect(edits.at(-1)).toEqual({a: 1, b: 3.25, phase: 'preview'});
    pointer(b, 'pointermove', mouse(337, {shiftKey: true}));
    expect(snap).toHaveBeenLastCalledWith(3.37, {alt: false, shift: true});
    expect(r6(edits.at(-1).b)).toBe(3.37);
    pointer(b, 'pointerup', mouse(337, {shiftKey: true}));
    expect(r6(edits.at(-1).b)).toBe(3.37);
    expect(edits.at(-1).phase).toBe('commit');
  });

  test('dragging an edge past the other swaps them', () => {
    mount();
    handles.set({a: 1, b: 3});
    const a = withCapture(handleAt('a'));
    pointer(a, 'pointerdown', mouse(100));
    pointer(a, 'pointermove', mouse(420));
    expect(edits.at(-1)).toEqual({a: 3, b: 4, phase: 'preview'});
    pointer(a, 'pointerup', mouse(420));
    expect(edits.at(-1)).toEqual({a: 3, b: 4, phase: 'commit'});
    expect(a.getAttribute('data-edge')).toBe('b');
    expect(box(handleAt('a')).left).toBe(300 - 22);
    expect(box(handleAt('b')).left).toBe(400 - 22);
  });

  test('an edge that would snap onto the other is pushed to the next line away from it (never unsnapped)', () => {
    mount();
    handles.set({a: 1, b: 3});
    const b = withCapture(handleAt('b'));
    pointer(b, 'pointerdown', mouse(300));
    pointer(b, 'pointermove', mouse(130));   // rounds to 1 = a: ceil gives the next bar
    expect(snap).toHaveBeenLastCalledWith(1.3, {alt: false, shift: false, mode: 'ceil'});
    expect(edits.at(-1)).toEqual({a: 1, b: 2, phase: 'preview'});
    pointer(b, 'pointermove', mouse(80));    // crossed: rounds to 1 = a, floor gives 0
    expect(edits.at(-1)).toEqual({a: 0, b: 1, phase: 'preview'});
    pointer(b, 'pointerup', mouse(80));
    expect(edits.at(-1)).toEqual({a: 0, b: 1, phase: 'commit'});
  });

  test('a surface snap that ignores mode: the last valid range is kept (no sub-bar, unsnapped loop)', () => {
    mount({snap: t => Math.round(t)});
    handles.set({a: 1, b: 3});
    const b = withCapture(handleAt('b'));
    pointer(b, 'pointerdown', mouse(300));
    pointer(b, 'pointermove', mouse(130));   // collapses at once: nothing valid yet, no preview
    expect(edits).toEqual([]);
    pointer(b, 'pointermove', mouse(210));
    expect(edits.at(-1)).toEqual({a: 1, b: 2, phase: 'preview'});
    pointer(b, 'pointermove', mouse(110));   // collapses: {1, 2} stays
    expect(edits).toHaveLength(1);
    pointer(b, 'pointerup', mouse(110));
    expect(edits.at(-1)).toEqual({a: 1, b: 2, phase: 'commit'});
    expect(handleAt('b').getAttribute('data-edge')).toBe('b');
  });

  test('crossing past the other edge keeps the fixed edge (and a commit on bar lines)', () => {
    mount();
    handles.set({a: 1, b: 3});
    const a = withCapture(handleAt('a'));
    pointer(a, 'pointerdown', mouse(100));
    pointer(a, 'pointermove', mouse(500));
    pointer(a, 'pointermove', mouse(520));
    pointer(a, 'pointerup', mouse(520));
    expect(edits.at(-1)).toEqual({a: 3, b: 5, phase: 'commit'});
  });

  test('an edge drag snaps only the dragged edge: an unsnapped loop (⇧I / ⇧O) keeps its other edge', () => {
    mount();
    handles.set({a: 1.37, b: 3.37});
    const b = withCapture(handleAt('b'));
    pointer(b, 'pointerdown', mouse(337));
    pointer(b, 'pointermove', mouse(500));
    expect(edits.at(-1)).toEqual({a: 1.37, b: 5, phase: 'preview'});
    pointer(b, 'pointerup', mouse(500));
    expect(edits.at(-1)).toEqual({a: 1.37, b: 5, phase: 'commit'});
    expect(snap.mock.calls.map(([t]) => t)).not.toContain(1.37);
  });

  test('pointercancel restores the range and reports the cancel', () => {
    mount();
    handles.set({a: 1, b: 3});
    const a = withCapture(handleAt('a'));
    pointer(a, 'pointerdown', mouse(100));
    pointer(a, 'pointermove', mouse(250));
    pointer(a, 'pointercancel', mouse(250));
    expect(edits.at(-1)).toEqual({a: 1, b: 3, phase: 'cancel'});
    expect(box(handleAt('a')).left).toBe(78);
    expect(handles.range).toEqual({a: 1, b: 3});
  });

  test('a press on a handle without moving changes nothing', () => {
    mount();
    handles.set({a: 1, b: 3});
    const a = withCapture(handleAt('a'));
    pointer(a, 'pointerdown', mouse(100));
    pointer(a, 'pointerup', mouse(100));
    expect(edits).toEqual([]);
  });

  test('set() while dragging does not fight the drag', () => {
    mount();
    handles.set({a: 1, b: 3});
    const a = withCapture(handleAt('a'));
    pointer(a, 'pointerdown', mouse(100));
    pointer(a, 'pointermove', mouse(170));
    handles.set({a: 1, b: 3});
    expect(box(a).left).toBe(148);
    pointer(a, 'pointerup', mouse(170));
    expect(handles.range).toEqual({a: 2, b: 3});
  });

  test('a surface that echoes every preview through set(): moves are measured from the drag origin', () => {
    mount({onEdit: e => { edits.push(e); if (e.phase === 'preview') handles.set({a: e.a, b: e.b}); }});
    handles.set({a: 1, b: 3});
    const band = withCapture(visible('.loop-band')[0]);
    pointer(band, 'pointerdown', mouse(200));
    pointer(band, 'pointermove', mouse(300));
    pointer(band, 'pointermove', mouse(310));
    pointer(band, 'pointermove', mouse(320));
    pointer(band, 'pointerup', mouse(320));
    expect(edits.filter(e => e.phase === 'preview').map(({a, b}) => [a, b])).toEqual([[2, 4], [2, 4], [2, 4]]);
    expect(edits.at(-1)).toEqual({a: 2, b: 4, phase: 'commit'});
    // An edge dragged past the other with echoes keeps the fixed edge.
    edits.length = 0;
    const a = withCapture(handleAt('a'));
    pointer(a, 'pointerdown', mouse(200));
    pointer(a, 'pointermove', mouse(600));
    pointer(a, 'pointermove', mouse(620));
    pointer(a, 'pointerup', mouse(620));
    expect(edits.at(-1)).toEqual({a: 4, b: 6, phase: 'commit'});
  });

  test('pointercancel after echoed previews restores the range from before the drag', () => {
    mount({onEdit: e => { edits.push(e); if (e.phase === 'preview') handles.set({a: e.a, b: e.b}); }});
    handles.set({a: 1, b: 3});
    const a = withCapture(handleAt('a'));
    pointer(a, 'pointerdown', mouse(100));
    pointer(a, 'pointermove', mouse(220));
    pointer(a, 'pointercancel', mouse(220));
    expect(edits.at(-1)).toEqual({a: 1, b: 3, phase: 'cancel'});
    expect(handles.range).toEqual({a: 1, b: 3});
  });
});

describe('touch and the band', () => {
  test('touch drags a handle while stopped; while playing a touch is left to scrolling, a mouse still drags', () => {
    mount();
    handles.set({a: 1, b: 3});
    let b = withCapture(handleAt('b'));
    const touchAt = (x, id = 5) => ({x, y: 50, pointerType: 'touch', pointerId: id});
    pointer(b, 'pointerdown', touchAt(300));
    pointer(b, 'pointermove', touchAt(400));
    pointer(b, 'pointerup', touchAt(400));
    expect(edits.at(-1)).toEqual({a: 1, b: 4, phase: 'commit'});
    edits.length = 0;
    playing = true;
    handles.update();
    b = withCapture(handleAt('b'));
    pointer(b, 'pointerdown', touchAt(400, 6));
    expect(b.setPointerCapture).not.toHaveBeenCalled();
    expect(parentDowns).toBe(1);   // it bubbles: the surface scrolls
    pointer(b, 'pointermove', touchAt(500, 6));
    pointer(b, 'pointerup', touchAt(500, 6));
    expect(edits).toEqual([]);
    pointer(b, 'pointerdown', mouse(400));
    pointer(b, 'pointermove', mouse(500));
    pointer(b, 'pointerup', mouse(500));
    expect(edits.at(-1)).toEqual({a: 1, b: 5, phase: 'commit'});
  });

  test('a mouse drag inside the band moves the loop (past 8 px), keeping its length', () => {
    mount();
    handles.set({a: 1, b: 3});
    const band = withCapture(visible('.loop-band')[0]);
    pointer(band, 'pointerdown', mouse(200));
    expect(parentDowns).toBe(1);   // taps inside the loop still reach the surface
    pointer(band, 'pointermove', mouse(206));
    expect(edits).toEqual([]);
    expect(band.setPointerCapture).not.toHaveBeenCalled();
    pointer(band, 'pointermove', mouse(262));
    expect(band.setPointerCapture).toHaveBeenCalledWith(1);
    expect(edits.at(-1)).toEqual({a: 2, b: 4, phase: 'preview'});
    pointer(band, 'pointermove', mouse(100));   // dragged before 0: clamped, length kept
    expect(edits.at(-1)).toEqual({a: 0, b: 2, phase: 'preview'});
    pointer(band, 'pointermove', mouse(330));
    pointer(band, 'pointerup', mouse(330));
    expect(edits.at(-1)).toEqual({a: 2, b: 4, phase: 'commit'});
    expect(root().hasAttribute('data-spring')).toBe(true);
  });

  test('a click inside the band is not a move; touches on the band are not moves either', () => {
    mount();
    handles.set({a: 1, b: 3});
    const band = withCapture(visible('.loop-band')[0]);
    pointer(band, 'pointerdown', mouse(200));
    pointer(band, 'pointerup', mouse(202));
    pointer(band, 'pointerdown', {x: 200, y: 50, pointerType: 'touch', pointerId: 9});
    pointer(band, 'pointermove', {x: 300, y: 50, pointerType: 'touch', pointerId: 9});
    pointer(band, 'pointerup', {x: 300, y: 50, pointerType: 'touch', pointerId: 9});
    expect(edits).toEqual([]);
    expect(parentDowns).toBe(2);
  });

  test('destroy() removes the overlay', () => {
    mount();
    handles.set({a: 1, b: 3});
    handles.destroy();
    expect(root()).toBeNull();
    handles = null;
  });
});
