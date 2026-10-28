// @vitest-environment happy-dom
// ST2: src/stage/pinch.js — two synthetic touch pointers: the scale factor (clamped through
// base/min/max), the centre and pan, the CSS-transform preview, commit on release (once),
// cancel when nothing moved, the native-scroll block, ⌘/Ctrl-wheel and shouldStart.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createPinch} from '../src/stage/pinch.js';
import {pointer, restoreDomShims, setRect, touchEvent} from './helpers/dom.js';

let el, pinch, calls;

function mount(opts = {}) {
  el = document.createElement('div');
  setRect(el, {x: 0, y: 0, width: 800, height: 600});
  el.setPointerCapture = vi.fn();
  document.body.append(el);
  calls = [];
  const rec = name => g => calls.push([name, g]);
  pinch = createPinch(el, {onStart: rec('start'), onPreview: rec('preview'), onCommit: rec('commit'), onCancel: rec('cancel'), ...opts});
  return pinch;
}

const finger = (id, x, y, primary = id === 1) => ({x, y, pointerType: 'touch', pointerId: id, isPrimary: primary});
const down = (id, x, y) => pointer(el, 'pointerdown', finger(id, x, y));
const move = (id, x, y) => pointer(el, 'pointermove', finger(id, x, y));
const up = (id, x, y) => pointer(el, 'pointerup', finger(id, x, y));
const names = () => calls.map(([n]) => n);
const last = name => calls.filter(([n]) => n === name).at(-1)?.[1];

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  pinch?.destroy();
  el?.remove();
  vi.useRealTimers();
  restoreDomShims();
});

describe('two-finger pinch', () => {
  test('the factor is the finger spread over the starting spread; it commits once, on release', () => {
    mount({base: 1.2, min: 0.8, max: 2});
    down(1, 300, 300);
    expect(calls).toEqual([]);
    down(2, 500, 300);                           // spread 200, centre (400, 300)
    expect(names()).toEqual(['start']);
    expect(last('start')).toEqual({factor: 1, value: 1.2, cx: 400, cy: 300, dx: 0, dy: 0, source: 'touch'});
    expect(el.setPointerCapture).toHaveBeenCalledWith(1);
    expect(el.setPointerCapture).toHaveBeenCalledWith(2);
    move(2, 550, 300);                           // spread 250
    expect(last('preview').factor).toBeCloseTo(1.25, 9);
    expect(last('preview').value).toBeCloseTo(1.5, 9);
    move(1, 250, 300);                           // spread 300 → 1.5 × 1.2 = 1.8
    expect(last('preview')).toMatchObject({cx: 400, cy: 300, dx: 0, dy: 0});
    expect(last('preview').value).toBeCloseTo(1.8, 9);
    expect(pinch.active).toBe(true);
    up(2, 550, 300);
    expect(names().filter(n => n === 'commit')).toHaveLength(1);
    expect(last('commit').value).toBeCloseTo(1.8, 9);
    expect(last('commit').factor).toBeCloseTo(1.5, 9);
    expect(pinch.active).toBe(false);
    // The remaining finger is ignored until it lifts.
    move(1, 100, 300);
    up(1, 100, 300);
    expect(names().filter(n => n === 'preview')).toHaveLength(2);
    expect(names().at(-1)).toBe('commit');
  });

  test('the value is clamped to [min, max] (80–200% chart sizes) and the factor follows it', () => {
    mount({base: 1.2, min: 0.8, max: 2});
    down(1, 300, 300); down(2, 500, 300);
    move(2, 900, 300);                           // spread 600 → ×3 → 3.6, clamped to 2
    expect(last('preview').value).toBe(2);
    expect(last('preview').factor).toBeCloseTo(2 / 1.2, 9);
    move(2, 320, 300);                           // spread 20 → ×0.1 → clamped to 0.8
    expect(last('preview').value).toBeCloseTo(0.8, 9);
    up(1, 300, 300);
    expect(last('commit').value).toBeCloseTo(0.8, 9);
  });

  test('two fingers moving together report the pan (Stems), and setBase moves the next gesture', () => {
    mount();
    down(1, 100, 100); down(2, 200, 100);
    move(1, 140, 160); move(2, 240, 160);
    expect(last('preview')).toMatchObject({dx: 40, dy: 60});
    expect(last('preview').factor).toBeCloseTo(1, 9);
    up(1, 140, 160); up(2, 240, 160);
    expect(last('commit')).toMatchObject({dx: 40, dy: 60, value: 1});
    pinch.setBase(1.5);
    expect(pinch.base).toBe(1.5);
    down(1, 100, 100); down(2, 200, 100);
    move(2, 300, 100);
    expect(last('preview').value).toBeCloseTo(3, 9);
  });

  test('two fingers that never move past 8 px cancel instead of committing', () => {
    mount();
    down(1, 100, 100); down(2, 200, 100);
    move(2, 204, 100);
    up(2, 204, 100); up(1, 100, 100);
    expect(names()).toEqual(['start', 'cancel']);
  });

  test('pointercancel of a finger cancels the gesture; a third finger is ignored', () => {
    mount();
    down(1, 100, 100); down(2, 200, 100);
    down(3, 300, 100);
    move(3, 400, 100);
    expect(names()).toEqual(['start']);
    move(2, 260, 100);
    pointer(el, 'pointercancel', finger(1, 100, 100));
    expect(names()).toEqual(['start', 'preview', 'cancel']);
  });

  test('a mouse pointer never pinches; one finger never pinches', () => {
    mount();
    pointer(el, 'pointerdown', {x: 10, y: 10, pointerType: 'mouse', pointerId: 1});
    pointer(el, 'pointerdown', {x: 90, y: 10, pointerType: 'mouse', pointerId: 2, isPrimary: false});
    down(5, 100, 100);
    move(5, 300, 100);
    up(5, 300, 100);
    expect(calls).toEqual([]);
  });

  test('preview: a CSS transform about the centre on the given element, restored before commit', () => {
    const target = document.createElement('div');
    target.style.transform = 'translateZ(0)';
    mount({preview: target});
    setRect(target, {x: 100, y: 50, width: 400, height: 400});
    el.append(target);
    let seenInCommit = null;
    pinch.destroy();
    pinch = createPinch(el, {preview: target, onCommit: () => { seenInCommit = target.style.transform; }});
    down(1, 200, 250); down(2, 400, 250);
    expect(target.style.transform).toBe('translateZ(0)');
    move(2, 500, 250);
    expect(target.style.transformOrigin).toBe('200px 200px');
    expect(target.style.transform).toBe('scale(1.5)');
    up(2, 500, 250);
    expect(seenInCommit).toBe('translateZ(0)');
    expect(target.style.transform).toBe('translateZ(0)');
  });

  test('preview with pan translates too', () => {
    const target = document.createElement('div');
    setRect(target, {x: 0, y: 0, width: 400, height: 400});
    mount({preview: target, pan: true});
    down(1, 100, 100); down(2, 200, 100);
    move(1, 110, 120); move(2, 210, 120);
    expect(target.style.transform).toBe('translate(10px, 20px) scale(1)');
  });

  test('while two fingers are down, touchmove is prevented (no native scroll or zoom)', () => {
    mount();
    const one = touchEvent('touchmove', el, [{x: 1, y: 1}]);
    el.dispatchEvent(one);
    expect(one.defaultPrevented).toBe(false);
    const two = touchEvent('touchmove', el, [{x: 1, y: 1, id: 0}, {x: 50, y: 1, id: 1}]);
    el.dispatchEvent(two);
    expect(two.defaultPrevented).toBe(true);
    const gesture = new window.Event('gesturestart', {cancelable: true});
    el.dispatchEvent(gesture);
    expect(gesture.defaultPrevented).toBe(true);
  });

  test('shouldStart false skips the gesture (glass policy "none")', () => {
    const shouldStart = vi.fn(() => false);
    mount({shouldStart});
    down(1, 100, 100); down(2, 200, 100);
    move(2, 400, 100);
    up(2, 400, 100); up(1, 100, 100);
    expect(shouldStart).toHaveBeenCalledWith({source: 'touch', clientX: 150, clientY: 100});
    expect(calls).toEqual([]);
  });

  test('cancel() abandons a running gesture; destroy() removes the listeners', () => {
    const target = document.createElement('div');
    setRect(target, {x: 0, y: 0, width: 100, height: 100});
    mount({preview: target});
    down(1, 100, 100); down(2, 200, 100);
    move(2, 300, 100);
    pinch.cancel();
    expect(names()).toEqual(['start', 'preview', 'cancel']);
    expect(target.style.transform).toBe('');
    up(2, 300, 100); up(1, 100, 100);
    pinch.destroy();
    calls.length = 0;
    down(1, 100, 100); down(2, 200, 100);
    expect(calls).toEqual([]);
  });
});

describe('⌘/Ctrl + wheel (trackpad pinch)', () => {
  // happy-dom's WheelEvent drops the MouseEvent fields, so they are defined on the instance.
  const wheel = ({deltaY = 0, deltaMode = 0, ...mouse}) => {
    const e = new window.WheelEvent('wheel', {bubbles: true, cancelable: true, deltaY, deltaMode});
    for (const [k, v] of Object.entries({clientX: 300, clientY: 200, ctrlKey: false, metaKey: false, ...mouse})) Object.defineProperty(e, k, {value: v});
    el.dispatchEvent(e);
    return e;
  };

  test('zooms at the cursor and commits 250 ms after the last wheel event', () => {
    mount({base: 1});
    const plain = wheel({deltaY: -100});
    expect(plain.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    const e = wheel({deltaY: -10, ctrlKey: true});
    expect(e.defaultPrevented).toBe(true);
    expect(last('start')).toMatchObject({cx: 300, cy: 200, source: 'wheel'});
    expect(last('preview').value).toBeCloseTo(Math.exp(0.1), 9);
    wheel({deltaY: -10, metaKey: true});
    expect(last('preview').value).toBeCloseTo(Math.exp(0.2), 9);
    vi.advanceTimersByTime(249);
    expect(names()).not.toContain('commit');
    vi.advanceTimersByTime(1);
    expect(last('commit').value).toBeCloseTo(Math.exp(0.2), 9);
    expect(names()).toEqual(['start', 'preview', 'preview', 'commit']);
  });

  test('line-mode deltas, clamping, and wheel: false', () => {
    mount({base: 1, max: 1.1});
    wheel({deltaY: -1, deltaMode: 1, ctrlKey: true});   // 16 px → ×e^0.16, clamped to 1.1
    expect(last('preview').value).toBe(1.1);
    pinch.destroy();
    calls.length = 0;
    pinch = createPinch(el, {wheel: false, onStart: () => calls.push(['start'])});
    expect(wheel({deltaY: -10, ctrlKey: true}).defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });

  test('a wheel gesture the policy refuses is left to the browser', () => {
    mount({shouldStart: ({source}) => source !== 'wheel'});
    expect(wheel({deltaY: -10, ctrlKey: true}).defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });
});
