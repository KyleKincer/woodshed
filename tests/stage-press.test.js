// @vitest-environment happy-dom
// ST2: src/stage/press.js — the music-surface press recogniser (D50, §2.14.8) on synthetic
// pointer events and fake timers: tap, double, 350 ms long-press with haptic, long-drag,
// release → menu, scroll hand-off, mouse drag at once, right-click / Shift+F10 / ContextMenu.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createPressRecognizer, defaultHaptic} from '../src/stage/press.js';
import {keyEvent, pointer, restoreDomShims, setRect, touchEvent} from './helpers/dom.js';

let el, off, log, haptic;

function mount(opts = {}) {
  el = document.createElement('div');
  el.tabIndex = 0;
  setRect(el, {x: 0, y: 0, width: 400, height: 300});
  document.body.append(el);
  log = [];
  haptic = vi.fn();
  const record = name => (e, info) => log.push(info ? [name, info] : [name, {x: e.clientX, y: e.clientY, type: e.pointerType, keyboard: !!e.keyboard, cancelled: !!e.cancelled}]);
  off = createPressRecognizer(el, {haptic, onTap: record('tap'), onDouble: record('double'), onLongStart: record('longStart'),
    onLongDrag: record('longDrag'), onLongEnd: record('longEnd'), onMenu: record('menu'), onDragStart: record('dragStart'),
    onDrag: record('drag'), onDragEnd: record('dragEnd'), ...opts});
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  el.hasPointerCapture = vi.fn(() => true);
  return el;
}

const names = () => log.map(([n]) => n);
const down = (init) => pointer(el, 'pointerdown', init);
const move = (init) => pointer(el, 'pointermove', init);
const up = (init) => pointer(el, 'pointerup', init);
const touch = (x, y, extra = {}) => ({x, y, pointerType: 'touch', pointerId: 7, ...extra});
const mouse = (x, y, extra = {}) => ({x, y, pointerType: 'mouse', pointerId: 1, ...extra});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  off?.();
  el?.remove();
  vi.useRealTimers();
  restoreDomShims();
});

describe('touch and pen', () => {
  test('a quick release is a tap at the press point', () => {
    mount();
    down(touch(100, 50));
    vi.advanceTimersByTime(120);
    up(touch(102, 51));
    expect(log).toEqual([['tap', {x: 102, y: 51, type: 'touch', keyboard: false, cancelled: false}]]);
    expect(haptic).not.toHaveBeenCalled();
  });

  test('a second tap within 300 ms is a double (and not a second tap); later it is a new tap', () => {
    mount();
    down(touch(100, 50)); up(touch(100, 50));
    vi.advanceTimersByTime(200);
    down(touch(104, 52)); up(touch(104, 52));
    expect(names()).toEqual(['tap', 'double']);
    vi.advanceTimersByTime(1000);
    down(touch(100, 50)); up(touch(100, 50));
    vi.advanceTimersByTime(301);
    down(touch(100, 50)); up(touch(100, 50));
    expect(names()).toEqual(['tap', 'double', 'tap', 'tap']);
    // Too far apart is two taps.
    log.length = 0;
    vi.advanceTimersByTime(1000);
    down(touch(100, 50)); up(touch(100, 50));
    down(touch(180, 50)); up(touch(180, 50));
    expect(names()).toEqual(['tap', 'tap']);
  });

  test('holding 350 ms fires the haptic and onLongStart; releasing without moving ends it and opens the menu', () => {
    mount();
    down(touch(120, 80));
    vi.advanceTimersByTime(349);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(haptic).toHaveBeenCalledWith(8);
    expect(names()).toEqual(['longStart']);
    expect(el.setPointerCapture).toHaveBeenCalledWith(7);
    up(touch(121, 80));
    expect(log).toEqual([
      ['longStart', {x: 120, y: 80, type: 'touch', keyboard: false, cancelled: false}],
      ['longEnd', {dragged: false}],
      ['menu', {x: 121, y: 80, type: 'touch', keyboard: false, cancelled: false}],
    ]);
  });

  test('a long press then a drag is onLongDrag per move with the offset, then onLongEnd({dragged: true}); no menu', () => {
    mount();
    down(touch(100, 100));
    vi.advanceTimersByTime(350);
    move(touch(104, 100));                 // within the 8 px tolerance: nothing yet
    move(touch(130, 104));
    move(touch(160, 110));
    up(touch(160, 110));
    expect(log).toEqual([
      ['longStart', expect.any(Object)],
      ['longDrag', {dx: 30, dy: 4}],
      ['longDrag', {dx: 60, dy: 10}],
      ['longEnd', {dragged: true}],
    ]);
  });

  test('scrolling is blocked during a long press, not before', () => {
    mount();
    down(touch(100, 100));
    const early = touchEvent('touchmove', el, [{x: 100, y: 104}]);
    el.dispatchEvent(early);
    expect(early.defaultPrevented).toBe(false);
    vi.advanceTimersByTime(350);
    const late = touchEvent('touchmove', el, [{x: 100, y: 140}]);
    el.dispatchEvent(late);
    expect(late.defaultPrevented).toBe(true);
    expect(el.style.touchAction).toBe('pan-y');
  });

  test('moving more than 8 px before 350 ms hands the press to the browser: nothing fires', () => {
    mount();
    down(touch(100, 100));
    vi.advanceTimersByTime(100);
    move(touch(100, 112));
    vi.advanceTimersByTime(500);
    up(touch(100, 140));
    expect(log).toEqual([]);
    expect(haptic).not.toHaveBeenCalled();
  });

  test('pen behaves like touch', () => {
    mount();
    down({x: 10, y: 10, pointerType: 'pen', pointerId: 3});
    vi.advanceTimersByTime(350);
    up({x: 10, y: 10, pointerType: 'pen', pointerId: 3});
    expect(names()).toEqual(['longStart', 'longEnd', 'menu']);
  });

  test('a second finger cancels the press (a pinch); a long press ends cancelled without a menu', () => {
    mount();
    down(touch(100, 100));
    down(touch(200, 100, {pointerId: 8, isPrimary: false}));
    vi.advanceTimersByTime(400);
    up(touch(100, 100));
    up(touch(200, 100, {pointerId: 8, isPrimary: false}));
    expect(log).toEqual([]);
    down(touch(100, 100));
    vi.advanceTimersByTime(350);
    down(touch(200, 100, {pointerId: 8, isPrimary: false}));
    up(touch(100, 100));
    expect(log.map(([n, i]) => [n, i.cancelled ?? i.cancelled])).toEqual([['longStart', false], ['longEnd', true]]);
  });

  test('pointercancel ends a long drag cancelled', () => {
    mount();
    down(touch(100, 100));
    vi.advanceTimersByTime(350);
    move(touch(150, 100));
    pointer(el, 'pointercancel', touch(150, 100));
    expect(log.at(-1)).toEqual(['longEnd', {dragged: true, cancelled: true}]);
  });

  test("the browser's own long-press contextmenu is swallowed", () => {
    mount();
    down(touch(100, 100));
    vi.advanceTimersByTime(350);
    const menu = new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 100, clientY: 100});
    Object.defineProperty(menu, 'pointerType', {value: 'touch'});
    el.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(names()).toEqual(['longStart']);
    up(touch(100, 100));
    const after = new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 100, clientY: 100});
    el.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(true);
    expect(names()).toEqual(['longStart', 'longEnd', 'menu']);
  });

  test('onLongStart returning false (playing touch: a long drag scrolls) leaves the press scrollable', () => {
    mount({onLongStart: e => { log.push(['longStart', {x: e.clientX}]); return false; }});
    down(touch(100, 100));
    vi.advanceTimersByTime(350);
    expect(haptic).toHaveBeenCalledWith(8);
    expect(el.releasePointerCapture).toHaveBeenCalledWith(7);
    const tm = touchEvent('touchmove', el, [{x: 100, y: 160}]);
    el.dispatchEvent(tm);
    expect(tm.defaultPrevented).toBe(false);   // the browser may scroll
    move(touch(100, 160));
    expect(log.at(-1)).toEqual(['longEnd', {dragged: false, cancelled: true}]);
    up(touch(100, 160));
    expect(names()).toEqual(['longStart', 'longEnd']);   // no long drag, no menu
    // Released without moving, it is still the menu.
    log.length = 0;
    down(touch(100, 100, {pointerId: 8}));
    vi.advanceTimersByTime(350);
    up(touch(100, 100, {pointerId: 8}));
    expect(names()).toEqual(['longStart', 'longEnd', 'menu']);
  });

  test('a long press the surface accepts still blocks scrolling', () => {
    mount();
    down(touch(100, 100));
    vi.advanceTimersByTime(350);
    const tm = touchEvent('touchmove', el, [{x: 100, y: 160}]);
    el.dispatchEvent(tm);
    expect(tm.defaultPrevented).toBe(true);
  });

  test("a pen's barrel button is a right-click: no tap, and its contextmenu opens the menu", () => {
    mount();
    const pen = {x: 80, y: 60, pointerType: 'pen', pointerId: 4, button: 2};
    down(pen);
    up(pen);
    const menu = new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 80, clientY: 60, button: 2, detail: 1});
    Object.defineProperty(menu, 'pointerType', {value: 'pen'});
    el.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(log).toEqual([['menu', {x: 80, y: 60, type: 'pen', keyboard: false, cancelled: false}]]);
    // A pen tip long press still swallows the browser's own contextmenu.
    log.length = 0;
    down({...pen, button: 0});
    vi.advanceTimersByTime(350);
    const echo = new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 80, clientY: 60});
    Object.defineProperty(echo, 'pointerType', {value: 'pen'});
    el.dispatchEvent(echo);
    expect(names()).toEqual(['longStart']);
  });
});

describe('mouse', () => {
  test('button 0 moving past 8 px drags at once: onDragStart, onDrag per move, onDragEnd; capture held', () => {
    mount();
    down(mouse(50, 50));
    move(mouse(55, 50));
    expect(log).toEqual([]);
    move(mouse(70, 52));
    move(mouse(90, 52));
    up(mouse(90, 52));
    expect(names()).toEqual(['dragStart', 'drag', 'drag', 'dragEnd']);
    expect(log[0][1]).toMatchObject({x: 70, type: 'mouse'});
    expect(el.setPointerCapture).toHaveBeenCalledWith(1);
    expect(el.releasePointerCapture).toHaveBeenCalledWith(1);
    vi.advanceTimersByTime(1000);
    expect(names()).not.toContain('longStart');   // no long press for a mouse
  });

  test('a click is a tap; two quick clicks are a double', () => {
    mount();
    down(mouse(50, 50)); up(mouse(50, 50));
    down(mouse(51, 50)); up(mouse(51, 50));
    expect(names()).toEqual(['tap', 'double']);
    vi.advanceTimersByTime(600);
    down(mouse(50, 50));
    vi.advanceTimersByTime(800);
    up(mouse(50, 50));
    expect(names()).toEqual(['tap', 'double', 'tap']);
  });

  test('right-click opens the menu (and the browser menu is prevented); button 2 never drags', () => {
    mount();
    down(mouse(60, 40, {button: 2}));
    move(mouse(90, 40, {button: 2}));
    up(mouse(90, 40, {button: 2}));
    const menu = new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 90, clientY: 40, button: 2, detail: 1});
    el.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(log).toEqual([['menu', {x: 90, y: 40, type: 'mouse', keyboard: false, cancelled: false}]]);
  });

  test('a macOS Ctrl-click (button 0 down, contextmenu, button 0 up) is the menu only', () => {
    mount();
    down(mouse(60, 40, {ctrlKey: true}));
    const menu = new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 60, clientY: 40, button: 0, detail: 1, ctrlKey: true});
    el.dispatchEvent(menu);
    up(mouse(60, 40));
    expect(names()).toEqual(['menu']);
    expect(menu.defaultPrevented).toBe(true);
    // The next click is a plain tap, not a double.
    vi.advanceTimersByTime(100);
    down(mouse(60, 40)); up(mouse(60, 40));
    expect(names()).toEqual(['menu', 'tap']);
  });

  test('a mouse press released outside the element is dropped: a later hover is not a drag', () => {
    mount();
    const sibling = document.createElement('div');
    document.body.append(sibling);
    down(mouse(2, 2));
    pointer(sibling, 'pointerup', mouse(500, 2));
    move(mouse(60, 20));
    move(mouse(90, 20));
    expect(log).toEqual([]);
    sibling.remove();
    // A drag (pointer capture held) is unaffected by the window listener.
    down(mouse(50, 50));
    move(mouse(80, 50));
    up(mouse(80, 50));
    expect(names()).toEqual(['dragStart', 'drag', 'dragEnd']);
  });

  test('a press whose pointerup was lost ends when the next one starts', () => {
    mount();
    down(mouse(50, 50));
    move(mouse(80, 50));                          // a drag … whose pointerup never arrives
    down(mouse(200, 50));
    up(mouse(200, 50));
    expect(names()).toEqual(['dragStart', 'drag', 'dragEnd', 'tap']);
    expect(log[2][1].cancelled).toBe(true);
  });

  test('pointercancel during a drag ends it cancelled', () => {
    mount();
    down(mouse(50, 50));
    move(mouse(80, 50));
    pointer(el, 'pointercancel', mouse(80, 50));
    expect(log.at(-1)).toEqual(['dragEnd', expect.objectContaining({cancelled: true})]);
  });
});

describe('keyboard context paths', () => {
  test('Shift+F10 and the ContextMenu key open the menu at the focused element, and are consumed', () => {
    mount();
    const child = document.createElement('button');
    setRect(child, {x: 100, y: 200, width: 40, height: 20});
    el.append(child);
    child.focus();
    const shiftF10 = keyEvent('keydown', {key: 'F10', code: 'F10', shiftKey: true});
    child.dispatchEvent(shiftF10);
    expect(shiftF10.defaultPrevented).toBe(true);
    expect(log).toEqual([['menu', {x: 120, y: 210, type: 'mouse', keyboard: true, cancelled: false}]]);
    // The contextmenu event the browser sends after the key is swallowed (no second menu).
    const echo = new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true});
    child.dispatchEvent(echo);
    expect(echo.defaultPrevented).toBe(true);
    expect(log).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    const key = keyEvent('keydown', 'ContextMenu');
    el.focus();
    el.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(log[1]).toEqual(['menu', {x: 200, y: 150, type: 'mouse', keyboard: true, cancelled: false}]);
    expect(el.getAttribute('data-consume-keys')).toContain('ContextMenu');
    // Plain F10 and modified chords are left alone.
    const plain = keyEvent('keydown', {key: 'F10', code: 'F10'});
    el.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(log).toHaveLength(2);
  });

  test('a keyboard-generated contextmenu (no pointer position) opens the menu at the focused element', () => {
    mount();
    el.focus();
    const menu = new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 0, clientY: 0, detail: 0});
    el.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(log).toEqual([['menu', {x: 200, y: 150, type: 'mouse', keyboard: true, cancelled: false}]]);
  });
});

describe('cooperation and teardown', () => {
  test('presses inside [data-press-ignore] are not seen; mouse drags inside [data-press-nodrag] are not drags but taps count', () => {
    mount();
    const handle = document.createElement('div');
    handle.setAttribute('data-press-ignore', '');
    const band = document.createElement('div');
    band.setAttribute('data-press-nodrag', '');
    el.append(handle, band);
    pointer(handle, 'pointerdown', mouse(10, 10));
    pointer(handle, 'pointerup', mouse(10, 10));
    pointer(handle, 'pointerdown', touch(10, 10));
    vi.advanceTimersByTime(500);
    expect(log).toEqual([]);
    pointer(band, 'pointerdown', mouse(20, 20));
    pointer(band, 'pointermove', mouse(60, 20));
    pointer(band, 'pointerup', mouse(60, 20));
    expect(log).toEqual([]);
    pointer(band, 'pointerdown', mouse(20, 20));
    pointer(band, 'pointerup', mouse(20, 20));
    expect(names()).toEqual(['tap']);
  });

  test('a touch on the band still long-presses (long-press then drag makes a new loop)', () => {
    mount();
    const band = document.createElement('div');
    band.setAttribute('data-press-nodrag', '');
    el.append(band);
    pointer(band, 'pointerdown', touch(20, 20));
    vi.advanceTimersByTime(350);
    pointer(band, 'pointermove', touch(80, 20));
    pointer(band, 'pointerup', touch(80, 20));
    expect(names()).toEqual(['longStart', 'longDrag', 'longEnd']);
  });

  test('custom timings, and off() removes everything', () => {
    mount({longMs: 500, doubleMs: 100, moveTol: 2});
    down(touch(10, 10));
    vi.advanceTimersByTime(400);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(names()).toEqual(['longStart']);
    up(touch(10, 10));
    log.length = 0;
    el.setAttribute('data-consume-keys', 'ArrowLeft ContextMenu');
    off();
    off = null;
    expect(el.style.touchAction).toBe('');
    down(touch(10, 10)); up(touch(10, 10));
    expect(log).toEqual([]);
  });

  test('off() restores an existing data-consume-keys and touch-action', () => {
    el = document.createElement('div');
    el.setAttribute('data-consume-keys', 'ArrowLeft');
    el.style.touchAction = 'none';
    document.body.append(el);
    const stop = createPressRecognizer(el, {touchAction: null});
    expect(el.getAttribute('data-consume-keys')).toBe('ArrowLeft ContextMenu');
    expect(el.style.touchAction).toBe('none');
    stop();
    expect(el.getAttribute('data-consume-keys')).toBe('ArrowLeft');
  });

  test('defaultHaptic calls navigator.vibrate(8) when it exists and is silent otherwise', () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', {value: vibrate, configurable: true, writable: true});
    defaultHaptic();
    expect(vibrate).toHaveBeenCalledWith(8);
    Object.defineProperty(navigator, 'vibrate', {value: () => { throw new Error('blocked'); }, configurable: true, writable: true});
    expect(() => defaultHaptic(8)).not.toThrow();
    delete navigator.vibrate;
    expect(() => defaultHaptic()).not.toThrow();
  });
});
