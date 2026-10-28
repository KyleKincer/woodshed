// @vitest-environment happy-dom
// U1 StemPad (architecture §2.12, §7.5; spec §4.7 Mix sheet, §7.6 touch gestures).
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {setPlatform} from '../src/app/keys.js';
import * as clock from '../src/app/clock.js';
import {LONG_PRESS_MS, StemPad, stemColor} from '../src/ui/stem-pad.js';
import {DOUBLE_TAP_MS} from '../src/ui/fader.js';
import {keydown, pointer, restoreDomShims, setRect} from './helpers/dom.js';

const FAKE = {toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame']};

let pad, calls;
function make(extra = {}) {
  calls = {toggle: 0, solo: 0, levels: []};
  pad = StemPad({
    name: 'Drums', color: 'drums', state: 'on', level: 0.8, keyCap: 'Digit1',
    onToggle: () => calls.toggle++, onSolo: () => calls.solo++, onLevel: (v, info) => calls.levels.push([v, info]),
    ...extra,
  });
  document.body.append(pad.el);
  setRect(pad.el, {left: 0, top: 0, width: 120, height: 168});
  return pad;
}
const main = () => pad.el.querySelector('.ui-stem-pad-main');
const slider = () => pad.el.querySelector('[role=slider]');
const word = () => pad.el.querySelector('.ui-stem-pad-word');

/** A pointer tap on the pad's button followed by its click, as a browser sends them. */
function tapPad({x = 60, y = 60, shiftKey = false, type = 'touch'} = {}) {
  pointer(main(), 'pointerdown', {x, y, shiftKey, pointerType: type});
  pointer(main(), 'pointerup', {x, y, shiftKey, pointerType: type});
  main().dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, shiftKey, detail: 1}));
}

beforeEach(() => {
  setPlatform('win');
  vi.useFakeTimers(FAKE);
  clock.set(() => Date.now());
});
afterEach(() => {
  pad?.destroy();
  pad = null;
  document.body.replaceChildren();
  restoreDomShims();
  vi.useRealTimers();
  clock.reset();
  setPlatform(null);
});

describe('StemPad structure and looks', () => {
  it('stemColor maps stem names to their tokens', () => {
    expect(stemColor('drums')).toBe('var(--stem-drums)');
    expect(stemColor('stem-bass')).toBe('var(--stem-bass)');
    expect(stemColor('--stem-piano')).toBe('var(--stem-piano)');
    expect(stemColor(undefined)).toBe('var(--stem-other)');
    expect(stemColor('red; color: x')).toBe('var(--stem-other)');
  });

  it('is a named group with a mode-named toggle, a key-cap and a level slider', () => {
    make();
    expect(pad.el.getAttribute('role')).toBe('group');
    expect(pad.el.getAttribute('aria-label')).toBe('Drums');
    expect(pad.el.dataset).toMatchObject({state: 'on', mode: 'mute', size: 'band'});
    expect(pad.el.style.getPropertyValue('--pad-color')).toBe('var(--stem-drums)');
    expect(main().getAttribute('aria-label')).toBe('Mute Drums');
    expect(main().getAttribute('aria-pressed')).toBe('false');
    expect(main().getAttribute('aria-keyshortcuts')).toBe('1');
    expect(pad.el.querySelector('.ui-stem-pad-name').textContent).toBe('Drums');
    expect(word().textContent).toBe('ON');
    expect(word().getAttribute('aria-hidden')).toBe('true');
    expect(pad.el.querySelector('.ui-stem-pad-key').textContent).toContain('1');
    expect(slider().getAttribute('aria-label')).toBe('Drums level');
    expect(slider().getAttribute('aria-valuetext')).toBe('80%');
    expect(slider().getAttribute('aria-orientation')).toBe('vertical');
    expect(pad.el.style.getPropertyValue('--ui-fader-level')).toBe('0.8');
    expect(pad.el.querySelector('.ui-stem-pad-fill').getAttribute('aria-hidden')).toBe('true');
    // The button and the slider are siblings, never nested.
    expect(main().contains(slider())).toBe(false);
    expect(() => StemPad({})).toThrow(/label/);
  });

  it('shows Out with OUT and Solo with SOLO; aria-pressed follows the mode', () => {
    make();
    const nameNode = pad.el.querySelector('.ui-stem-pad-name');
    pad.set({state: 'out'});
    expect(pad.el.dataset.state).toBe('out');
    expect(word().textContent).toBe('OUT');
    expect(main().getAttribute('aria-pressed')).toBe('true');
    pad.set({state: 'solo'});
    expect(word().textContent).toBe('SOLO');
    expect(main().getAttribute('aria-pressed')).toBe('false');
    pad.set({mode: 'solo'});
    expect(main().getAttribute('aria-label')).toBe('Solo Drums');
    expect(main().getAttribute('aria-pressed')).toBe('true');
    pad.set({state: 'bogus', size: 'rail', level: 0.25, keyCap: null, name: 'Kit'});
    expect(pad.el.dataset).toMatchObject({state: 'on', size: 'rail'});
    expect(slider().getAttribute('aria-valuetext')).toBe('25%');
    expect(slider().getAttribute('aria-label')).toBe('Kit level');
    expect(pad.el.querySelector('.ui-stem-pad-key')).toBeNull();
    expect(main().hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(pad.el.querySelector('.ui-stem-pad-name')).toBe(nameNode);
  });
});

describe('StemPad gestures', () => {
  it('a tap toggles once the double-tap window has passed', () => {
    make();
    tapPad();
    expect(calls.toggle).toBe(0);
    vi.advanceTimersByTime(DOUBLE_TAP_MS - 1);
    expect(calls.toggle).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls.toggle).toBe(1);
    expect(calls.solo).toBe(0);
  });

  it('in Solo mode a tap solos', () => {
    make({mode: 'solo'});
    tapPad();
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    expect(calls).toMatchObject({toggle: 0, solo: 1});
  });

  it('a double tap sets the level to 100% and never flips the mute', () => {
    make();
    tapPad();
    vi.advanceTimersByTime(120);
    tapPad({x: 64, y: 58});
    vi.advanceTimersByTime(1000);
    expect(calls.toggle).toBe(0);
    expect(calls.levels).toEqual([[1, {final: false}], [1, {final: true}]]);
    expect(pad.level).toBe(1);
  });

  it('two quick taps far apart are two taps, not a lost one', () => {
    make();
    tapPad({x: 10, y: 10});
    vi.advanceTimersByTime(150);
    tapPad({x: 60, y: 10});   // beyond DOUBLE_TAP_SLOP: not a double tap
    expect(calls.toggle).toBe(1);   // the first tap acts at once
    vi.advanceTimersByTime(1000);
    expect(calls.toggle).toBe(2);
    expect(calls.levels).toEqual([]);
  });

  it('Shift-click solos at once', () => {
    make();
    tapPad({shiftKey: true, type: 'mouse'});
    expect(calls.solo).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(calls.toggle).toBe(0);
  });

  it('a 500 ms long-press solos, and the release does nothing more', () => {
    make();
    pointer(main(), 'pointerdown', {x: 60, y: 60, pointerType: 'touch'});
    const menu = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});
    main().dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(calls.solo).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls.solo).toBe(1);
    pointer(main(), 'pointerup', {x: 60, y: 60, pointerType: 'touch'});
    main().dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 1}));
    vi.advanceTimersByTime(1000);
    expect(calls).toMatchObject({toggle: 0, solo: 1});
  });

  it('a vertical drag inside the pad sets the level live, then finally on release', () => {
    make();
    pointer(main(), 'pointerdown', {x: 60, y: 120, pointerType: 'touch'});
    pointer(main(), 'pointermove', {x: 60, y: 110, pointerType: 'touch'});
    pointer(main(), 'pointermove', {x: 61, y: 120 - 168 * 0.1, pointerType: 'touch'});
    expect(calls.levels.at(-1)).toEqual([0.9, {final: false}]);
    pointer(main(), 'pointermove', {x: 61, y: 0, pointerType: 'touch'});
    pointer(main(), 'pointerup', {x: 61, y: 0, pointerType: 'touch'});
    main().dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 1}));
    vi.advanceTimersByTime(LONG_PRESS_MS + DOUBLE_TAP_MS);
    expect(calls.levels.at(-1)).toEqual([1, {final: true}]);
    expect(calls).toMatchObject({toggle: 0, solo: 0});
    expect(slider().getAttribute('aria-valuetext')).toBe('100%');
  });

  it('keyboard activation of the pad button toggles at once; the slider takes arrows', () => {
    make();
    main().click();
    expect(calls.toggle).toBe(1);
    slider().focus();
    keydown('ArrowDown');
    expect(calls.levels.at(-1)).toEqual([0.79, {final: true}]);
    keydown('Home');
    expect(pad.level).toBe(0);
  });

  it('a press released outside the button leaves no click to swallow', () => {
    make();
    const strip = slider();
    pointer(main(), 'pointerdown', {x: 60, y: 60});
    pointer(strip, 'pointerup', {x: 60, y: 160});
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    expect(calls.toggle).toBe(1);   // still a tap on the pad
    main().click();
    expect(calls.toggle).toBe(2);
  });

  it('destroy cancels a pending tap', () => {
    make();
    tapPad();
    pad.destroy();
    vi.advanceTimersByTime(1000);
    expect(calls.toggle).toBe(0);
    expect(pad.el.isConnected).toBe(false);
    pad = null;
  });
});
