// @vitest-environment happy-dom
// U1 inputs: Segmented, Chip/ChipGroup, Stepper, Slider, Fader, fields, and the dispatcher interop
// rule that a focused slider, stepper or fader consumes only its own keys (architecture §2.6 rule 5,
// §2.12, §9.4 U1; spec §7.1).
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createRegistry} from '../src/app/commands.js';
import {startDispatcher} from '../src/app/dispatch.js';
import {setPlatform} from '../src/app/keys.js';
import * as clock from '../src/app/clock.js';
import {Segmented} from '../src/ui/segmented.js';
import {Chip, ChipGroup} from '../src/ui/chip.js';
import {REPEAT_DELAY_MS, REPEAT_EVERY_MS, Stepper, snapValue} from '../src/ui/stepper.js';
import {SLIDER_KEYS, Slider, valueAtPoint} from '../src/ui/slider.js';
import {DOUBLE_TAP_MS, Fader} from '../src/ui/fader.js';
import {ChipInput, FADE_MS, SAVED_MS, Select, TextField, Textarea} from '../src/ui/field.js';
import {Button, IconButton} from '../src/ui/button.js';
import {Toggle} from '../src/ui/toggle.js';
import {HoldButton} from '../src/ui/hold-button.js';
import {StemPad} from '../src/ui/stem-pad.js';
import {keydown, pointer, restoreDomShims, setRect, tap} from './helpers/dom.js';

const FAKE = {toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame']};
const mounted = [];
function mount(prim) {
  document.body.append(prim.el);
  mounted.push(prim);
  return prim;
}
const radios = seg => [...seg.el.querySelectorAll('[role=radio]')];

beforeEach(() => { setPlatform('win'); });
afterEach(() => {
  for (const p of mounted.splice(0)) p.destroy();
  document.body.replaceChildren();
  restoreDomShims();
  vi.useRealTimers();
  clock.reset();
  setPlatform(null);
});

// ---------------------------------------------------------------------------------------------
describe('every primitive: factory shape and common props', () => {
  const FACTORIES = [
    ['Button', Button, {label: 'Go'}, 'ui-button'],
    ['IconButton', IconButton, {label: 'Close', icon: 'x'}, 'ui-button'],
    ['Toggle', Toggle, {label: 'Count-in'}, 'ui-toggle'],
    ['HoldButton', HoldButton, {label: 'Library', icon: 'chevron-left'}, 'ui-hold-button'],
    ['Segmented', Segmented, {label: 'Mode', options: [{value: 1, label: 'One'}]}, 'ui-segmented'],
    ['Chip', Chip, {label: 'Jazz'}, 'ui-chip'],
    ['ChipGroup', ChipGroup, {label: 'Filter', options: [{value: 1, label: 'One'}]}, 'ui-chip-group'],
    ['Stepper', Stepper, {label: 'Beats', value: 4}, 'ui-stepper'],
    ['Slider', Slider, {label: 'Volume'}, 'ui-slider'],
    ['Fader', Fader, {label: 'Level'}, 'ui-fader'],
    ['TextField', TextField, {label: 'Title'}, 'ui-field'],
    ['Select', Select, {label: 'Stems', options: []}, 'ui-field'],
    ['Textarea', Textarea, {label: 'Notes'}, 'ui-field'],
    ['ChipInput', ChipInput, {label: 'Tags'}, 'ui-field'],
    ['StemPad', StemPad, {name: 'Drums'}, 'ui-stem-pad'],
  ];

  it.each(FACTORIES)('%s returns {el, set, destroy} and applies className, id, attrs, dataset and testid', (_, make, props, cls) => {
    const prim = make({...props, className: 'one', id: 'prim', attrs: {lang: 'en'}, dataset: {kind: 'a'}, testid: 'tid'});
    document.body.append(prim.el);
    expect(typeof prim.set).toBe('function');
    expect(typeof prim.destroy).toBe('function');
    expect(prim.el.classList.contains(cls)).toBe(true);
    expect(prim.el.classList.contains('one')).toBe(true);
    expect(prim.el.id).toBe('prim');
    expect(prim.el.getAttribute('lang')).toBe('en');
    expect(prim.el.getAttribute('data-kind')).toBe('a');
    expect(prim.el.getAttribute('data-testid')).toBe('tid');
    prim.set({className: 'two', attrs: {}, dataset: {}, testid: null});
    expect(prim.el.classList.contains(cls)).toBe(true);
    expect(prim.el.classList.contains('one')).toBe(false);
    expect(prim.el.classList.contains('two')).toBe(true);
    expect(prim.el.hasAttribute('lang')).toBe(false);
    expect(prim.el.hasAttribute('data-kind')).toBe(false);
    expect(prim.el.hasAttribute('data-testid')).toBe(false);
    prim.destroy();
    expect(prim.el.isConnected).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Segmented', () => {
  const options = [
    {value: 'mute', label: 'Mute'},
    {value: 'solo', label: 'Solo', icon: 'headphones'},
    {value: 'six', label: '6 stems', disabled: true, reason: 'Re-split from Woodshed for desktop.'},
  ];

  it('is a named radiogroup with a roving tabindex and consumes the arrows', () => {
    const s = mount(Segmented({label: 'Tap to', options, value: 'solo'}));
    expect(s.el.getAttribute('role')).toBe('radiogroup');
    expect(s.el.getAttribute('aria-label')).toBe('Tap to');
    expect(s.el.getAttribute('data-consume-keys')).toBe('ArrowLeft ArrowRight ArrowUp ArrowDown');
    expect(radios(s).map(b => b.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(radios(s).map(b => b.tabIndex)).toEqual([-1, 0, -1]);
    expect(radios(s)[1].querySelector('use').getAttribute('href')).toBe('#i-headphones');
    s.set({value: 'nothing'});
    expect(radios(s).map(b => b.tabIndex)).toEqual([0, -1, -1]);
  });

  it('selects on click and on arrows (wrapping, skipping disabled), reporting the source', () => {
    const onChange = vi.fn();
    const s = mount(Segmented({label: 'Tap to', options, value: 'mute', onChange}));
    tap(radios(s)[1]);
    expect(onChange).toHaveBeenLastCalledWith('solo', {source: 'key'});   // tap() dispatches a click with detail 0
    radios(s)[1].focus();
    keydown('ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('mute', {source: 'key'});   // wraps past the disabled option
    expect(document.activeElement).toBe(radios(s)[0]);
    keydown('ArrowLeft');
    expect(s.value).toBe('solo');
    expect(document.activeElement).toBe(radios(s)[1]);
    keydown('ArrowDown');
    expect(s.value).toBe('mute');
    const calls = onChange.mock.calls.length;
    radios(s)[0].click();
    expect(onChange).toHaveBeenCalledTimes(calls);   // choosing the chosen option is not a change
  });

  it('arrows from a focused disabled option go to its neighbour in that direction', () => {
    const abc = [{value: 'a', label: 'A'}, {value: 'b', label: 'B', disabled: true, reason: 'Not here.'}, {value: 'c', label: 'C'}];
    const s = mount(Segmented({label: 'Pick', options: abc, value: 'a'}));
    radios(s)[1].click();   // a click focuses the disabled option and shows its reason
    radios(s)[1].focus();
    keydown('ArrowRight');
    expect(s.value).toBe('c');
    s.set({value: 'c'});
    radios(s)[1].focus();
    keydown('ArrowLeft');
    expect(s.value).toBe('a');
    // At an end with no enabled option that way, it wraps.
    const ab = mount(Segmented({label: 'Pick two', options: [{value: 'a', label: 'A'}, {value: 'b', label: 'B', disabled: true}], value: 'a'}));
    radios(ab)[1].focus();
    keydown('ArrowRight');
    expect(ab.value).toBe('a');
    expect(document.activeElement).toBe(radios(ab)[0]);
  });

  it('never selects a disabled option and shows its reason', () => {
    const onChange = vi.fn();
    const s = mount(Segmented({label: 'Stems', options, value: 'mute', onChange}));
    const six = radios(s)[2];
    expect(six.getAttribute('aria-disabled')).toBe('true');
    const note = s.el.querySelector('.ui-segmented-reason');
    expect(six.getAttribute('aria-describedby')).toBe(note.id);
    expect(note.hidden).toBe(true);
    six.click();
    expect(onChange).not.toHaveBeenCalled();
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('Re-split from Woodshed for desktop.');
    radios(s)[0].click();
    expect(note.hidden).toBe(true);
  });

  it('keeps option nodes across set() and needs a name', () => {
    const s = mount(Segmented({label: 'Tap to', options, value: 'mute'}));
    const first = radios(s)[0];
    s.set({options: [options[1], options[0]]});
    expect(radios(s)[1]).toBe(first);
    expect(radios(s)).toHaveLength(2);
    expect(() => Segmented({options})).toThrow(/label/);
    expect(() => Segmented({options, attrs: {'aria-labelledby': 'h'}})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
describe('Chip and ChipGroup', () => {
  it('a plain chip is text; with onClick or pressed it is a toggle button', () => {
    const plain = mount(Chip({label: 'Jazz'}));
    expect(plain.el.querySelector('button')).toBeNull();
    expect(plain.el.textContent).toBe('Jazz');
    const onClick = vi.fn();
    const c = mount(Chip({label: 'Review', pressed: false, onClick, tone: 'warn', icon: 'flag'}));
    const btn = c.el.querySelector('.ui-chip-main');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(c.el.dataset.tone).toBe('warn');
    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    c.set({pressed: true, tone: 'nope'});
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(c.el.dataset.tone).toBe('neutral');
    expect(c.focusTarget).toBe(btn);
  });

  it('a removable chip has a named ✕', () => {
    const onRemove = vi.fn();
    const c = mount(Chip({label: 'Jazz', removable: true, onRemove}));
    const x = c.el.querySelector('.ui-chip-remove');
    expect(x.getAttribute('aria-label')).toBe('Remove Jazz');
    x.click();
    expect(onRemove).toHaveBeenCalledTimes(1);
    c.set({removable: false});
    expect(c.el.querySelector('.ui-chip-remove')).toBeNull();
  });

  const instruments = [{value: 'drums', label: 'Drums'}, {value: 'bass', label: 'Bass'}, {value: 'keys', label: 'Keys', disabled: true}];
  const pressedOf = g => [...g.el.querySelectorAll('.ui-chip-main')].map(b => b.getAttribute('aria-pressed'));
  const chipButtons = g => [...g.el.querySelectorAll('.ui-chip-main')];

  it('single select clears on a second tap when clearable', () => {
    const onChange = vi.fn();
    const g = mount(ChipGroup({label: 'Filter', options: instruments, onChange}));
    expect(g.el.getAttribute('role')).toBe('group');
    expect(g.el.getAttribute('aria-label')).toBe('Filter');
    chipButtons(g)[0].click();
    expect(onChange).toHaveBeenLastCalledWith('drums');
    expect(pressedOf(g)).toEqual(['true', 'false', 'false']);
    chipButtons(g)[1].click();
    expect(onChange).toHaveBeenLastCalledWith('bass');
    chipButtons(g)[1].click();
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(g.value).toBeNull();
    chipButtons(g)[2].click();
    expect(g.value).toBeNull();
    g.set({clearable: false, value: 'drums'});
    chipButtons(g)[0].click();
    expect(g.value).toBe('drums');
  });

  it('multiple select toggles values and badges the primary chip', () => {
    const onChange = vi.fn();
    const g = mount(ChipGroup({label: 'Instruments', options: instruments, multiple: true, value: ['drums'], primary: 'drums', onChange}));
    expect(g.el.querySelector('.ui-chip-badge').textContent).toBe('Primary');
    expect(g.el.querySelector('.ui-chip-badge').closest('.ui-chip').textContent).toContain('Drums');
    chipButtons(g)[1].click();
    expect(onChange).toHaveBeenLastCalledWith(['drums', 'bass']);
    chipButtons(g)[0].click();
    expect(onChange).toHaveBeenLastCalledWith(['bass']);
    g.set({primary: 'bass'});
    expect(g.el.querySelector('.ui-chip-badge').closest('.ui-chip').textContent).toContain('Bass');
    expect(g.el.querySelectorAll('.ui-chip-badge')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Stepper', () => {
  const speed = extra => mount(Stepper({label: 'Speed', value: 0.75, min: 0.25, max: 1.5, step: 0.05, bigStep: 0.25,
    format: v => `${Math.round(v * 100)}%`, ...extra}));
  const valueOf = s => s.el.querySelector('[role=spinbutton]');

  it('snapValue clamps and snaps without float drift', () => {
    expect(snapValue(0.75 + 0.05, {min: 0.25, max: 1.5, step: 0.05})).toBe(0.8);
    expect(snapValue(0.1 + 0.2, {min: 0, max: 1, step: 0.1})).toBe(0.3);
    expect(snapValue(7, {min: 0, max: 5, step: 1})).toBe(5);
    expect(snapValue(NaN, {min: 2, max: 5})).toBe(2);
    expect(snapValue(1.234, {})).toBe(1.234);
  });

  it('is a named spinbutton that consumes its keys, with − and + out of the tab order', () => {
    const s = speed();
    const v = valueOf(s);
    expect(s.el.getAttribute('role')).toBe('group');
    expect(v.getAttribute('aria-label')).toBe('Speed');
    expect(v.getAttribute('aria-valuenow')).toBe('0.75');
    expect(v.getAttribute('aria-valuemin')).toBe('0.25');
    expect(v.getAttribute('aria-valuemax')).toBe('1.5');
    expect(v.getAttribute('aria-valuetext')).toBe('75%');
    expect(v.textContent).toBe('75%');
    expect(v.tabIndex).toBe(0);
    expect(v.getAttribute('data-consume-keys')).toBe('ArrowUp ArrowDown ArrowLeft ArrowRight PageUp PageDown Home End');
    const [dec, inc] = s.el.querySelectorAll('button');
    expect([dec.tabIndex, inc.tabIndex]).toEqual([-1, -1]);
    expect(dec.getAttribute('aria-label')).toBe('Decrease Speed');
    expect(inc.getAttribute('aria-label')).toBe('Increase Speed');
    const named = mount(Stepper({label: 'Beats', decLabel: 'Fewer beats', incLabel: 'More beats'}));
    expect(named.el.querySelector('.ui-stepper-dec').getAttribute('aria-label')).toBe('Fewer beats');
    expect(() => Stepper({})).toThrow(/label/);
  });

  it('steps with keys: arrows, PageUp/PageDown by bigStep, Home and End', () => {
    const onChange = vi.fn();
    const s = speed({onChange});
    valueOf(s).focus();
    keydown('ArrowUp');
    expect(onChange).toHaveBeenLastCalledWith(0.8, {source: 'key'});
    keydown('ArrowRight');
    expect(s.value).toBe(0.85);
    keydown('ArrowDown');
    keydown('ArrowLeft');
    expect(s.value).toBe(0.75);
    keydown('PageUp');
    expect(s.value).toBe(1);
    keydown('PageDown');
    keydown('PageDown');
    expect(s.value).toBe(0.5);
    keydown('End');
    expect(s.value).toBe(1.5);
    keydown('ArrowUp');
    expect(s.value).toBe(1.5);
    expect(s.el.querySelector('.ui-stepper-inc').getAttribute('aria-disabled')).toBe('true');
    keydown('Home');
    expect(s.value).toBe(0.25);
    expect(s.el.querySelector('.ui-stepper-dec').getAttribute('aria-disabled')).toBe('true');
    const before = onChange.mock.calls.length;
    keydown('KeyK');
    keydown('Space');
    expect(onChange).toHaveBeenCalledTimes(before);
  });

  it('steps once per tap and repeats while held (400 ms, then every 80 ms)', () => {
    vi.useFakeTimers(FAKE);
    const onChange = vi.fn();
    const s = speed({onChange});
    const inc = s.el.querySelector('.ui-stepper-inc');
    tap(inc);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(0.8, {source: 'pointer'});
    pointer(inc, 'pointerdown');
    expect(s.value).toBe(0.85);
    vi.advanceTimersByTime(REPEAT_DELAY_MS - 1);
    expect(s.value).toBe(0.85);
    vi.advanceTimersByTime(1 + REPEAT_EVERY_MS);
    expect(s.value).toBe(0.9);
    expect(onChange).toHaveBeenLastCalledWith(0.9, {source: 'repeat'});
    vi.advanceTimersByTime(REPEAT_EVERY_MS * 3);
    expect(s.value).toBe(1.05);
    pointer(inc, 'pointerup');
    inc.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    vi.advanceTimersByTime(1000);
    expect(s.value).toBe(1.05);

    s.set({holdRepeat: false});
    const dec = s.el.querySelector('.ui-stepper-dec');
    pointer(dec, 'pointerdown');
    vi.advanceTimersByTime(1000);
    pointer(dec, 'pointerup');
    dec.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(s.value).toBe(1);
    dec.click();   // keyboard/AT activation steps once
    expect(s.value).toBe(0.95);
  });

  it('a held repeat stops at the end of the range', () => {
    vi.useFakeTimers(FAKE);
    const s = speed({value: 1.4});
    const inc = s.el.querySelector('.ui-stepper-inc');
    pointer(inc, 'pointerdown');
    vi.advanceTimersByTime(2000);
    expect(s.value).toBe(1.5);
    pointer(inc, 'pointerup');
  });

  it('the value opens on tap and long-presses at 500 ms', () => {
    vi.useFakeTimers(FAKE);
    const onValueClick = vi.fn(), onValueLongPress = vi.fn();
    const s = speed({onValueClick, onValueLongPress});
    const v = valueOf(s);
    expect(v.hasAttribute('data-clickable')).toBe(true);
    tap(v);
    expect(onValueClick).toHaveBeenCalledTimes(1);
    pointer(v, 'pointerdown', {pointerType: 'touch'});
    vi.advanceTimersByTime(500);
    expect(onValueLongPress).toHaveBeenCalledTimes(1);
    pointer(v, 'pointerup', {pointerType: 'touch'});
    v.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(onValueClick).toHaveBeenCalledTimes(1);
  });

  it('destroy stops a running repeat and removes its listeners', () => {
    vi.useFakeTimers(FAKE);
    const onChange = vi.fn();
    const s = Stepper({label: 'Speed', value: 1, min: 0, max: 10, onChange});
    document.body.append(s.el);
    const inc = s.el.querySelector('.ui-stepper-inc');
    const v = s.el.querySelector('[role=spinbutton]');
    pointer(inc, 'pointerdown');
    expect(onChange).toHaveBeenCalledTimes(1);
    s.destroy();
    vi.advanceTimersByTime(2000);
    v.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true}));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(s.el.isConnected).toBe(false);
  });

  it('set() clamps and re-renders', () => {
    const s = speed();
    s.set({value: 9});
    expect(s.value).toBe(1.5);
    s.set({max: 1.25});
    expect(s.value).toBe(1.25);
    expect(valueOf(s).getAttribute('aria-valuetext')).toBe('125%');
  });
});

// ---------------------------------------------------------------------------------------------
describe('Slider', () => {
  it('valueAtPoint maps positions inside the rect (pure)', () => {
    const rect = {left: 100, top: 0, width: 200, height: 40};
    expect(valueAtPoint({x: 200, y: 20}, rect, {min: 0, max: 1, step: 0.01})).toBe(0.5);
    expect(valueAtPoint({x: 0, y: 20}, rect, {min: 0, max: 1})).toBe(0);
    expect(valueAtPoint({x: 999, y: 20}, rect, {min: 0, max: 2})).toBe(2);
    expect(valueAtPoint({x: 0, y: 90}, {left: 0, top: 0, width: 40, height: 120}, {min: 0, max: 1, step: 0.25, orientation: 'vertical'})).toBe(0.25);
    expect(valueAtPoint({x: 1, y: 1}, {left: 0, top: 0, width: 0, height: 0}, {})).toBeNull();
  });

  it('is a custom role=slider consuming only arrows and Home/End', () => {
    const s = mount(Slider({label: 'Volume', value: 0.5, format: v => `${Math.round(v * 100)}%`}));
    const c = s.control;
    expect(s.el.querySelector('input')).toBeNull();
    expect(c.getAttribute('role')).toBe('slider');
    expect(c.tabIndex).toBe(0);
    expect(c.getAttribute('aria-label')).toBe('Volume');
    expect(c.getAttribute('aria-valuetext')).toBe('50%');
    expect(c.getAttribute('aria-orientation')).toBe('horizontal');
    expect(c.getAttribute('data-consume-keys')).toBe(SLIDER_KEYS);
    expect(SLIDER_KEYS.split(' ').sort()).toEqual(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'End', 'Home']);
    expect(s.el.querySelector('.ui-slider-value').textContent).toBe('50%');
    expect(s.el.style.getPropertyValue('--ui-slider-pos')).toBe('0.5');
    s.set({showValue: false});
    expect(s.el.querySelector('.ui-slider-value').hidden).toBe(true);
    expect(() => Slider({})).toThrow(/label/);
  });

  it('keys step (Shift ×10), Home/End, and report input and change', () => {
    const onInput = vi.fn(), onChange = vi.fn();
    const s = mount(Slider({label: 'Volume', value: 0.5, step: 0.01, onInput, onChange}));
    s.control.focus();
    keydown('ArrowRight');
    expect(s.value).toBe(0.51);
    expect(onInput).toHaveBeenLastCalledWith(0.51);
    expect(onChange).toHaveBeenLastCalledWith(0.51);
    keydown('Shift+ArrowLeft');
    expect(s.value).toBe(0.41);
    keydown('ArrowUp');
    keydown('ArrowDown');
    expect(s.value).toBe(0.41);
    keydown('End');
    expect(s.value).toBe(1);
    keydown('Home');
    expect(s.value).toBe(0);
    const n = onChange.mock.calls.length;
    keydown('PageUp');
    keydown('Space');
    keydown('Digit5');
    expect(onChange).toHaveBeenCalledTimes(n);
    expect(s.value).toBe(0);
  });

  it('drags with pointer capture: input while moving, change once on release', () => {
    const onInput = vi.fn(), onChange = vi.fn();
    const s = mount(Slider({label: 'Volume', value: 0, step: 0.1, onInput, onChange}));
    setRect(s.control, {left: 0, top: 0, width: 100, height: 32});
    s.control.setPointerCapture = vi.fn();
    pointer(s.control, 'pointerdown', {x: 30, y: 10});
    expect(s.control.setPointerCapture).toHaveBeenCalledWith(1);
    expect(s.value).toBe(0.3);
    expect(s.el.hasAttribute('data-dragging')).toBe(true);
    pointer(s.control, 'pointermove', {x: 70, y: 10});
    expect(onInput).toHaveBeenLastCalledWith(0.7);
    s.set({value: 0.2});   // a caller echo during the drag does not fight the pointer
    expect(s.value).toBe(0.7);
    pointer(s.control, 'pointerup', {x: 70, y: 10});
    pointer(s.control, 'lostpointercapture', {x: 70, y: 10});
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(0.7);
    expect(s.el.hasAttribute('data-dragging')).toBe(false);
  });

  it('a cancelled drag puts back the value from before the press and commits nothing', () => {
    const onInput = vi.fn(), onChange = vi.fn();
    const s = mount(Slider({label: 'Volume', value: 0.5, onInput, onChange}));
    setRect(s.control, {left: 0, top: 0, width: 100, height: 32});
    pointer(s.control, 'pointerdown', {x: 90, y: 10, pointerType: 'touch'});
    expect(s.value).toBe(0.9);
    pointer(s.control, 'pointercancel', {x: 90, y: 10, pointerType: 'touch'});   // the browser took it for a scroll
    expect(s.value).toBe(0.5);
    expect(onInput).toHaveBeenLastCalledWith(0.5);
    expect(onChange).not.toHaveBeenCalled();
    expect(s.dragging).toBe(false);
    expect(s.el.hasAttribute('data-dragging')).toBe(false);
    // Capture lost with no pointerup before it is a cancel too.
    pointer(s.control, 'pointerdown', {x: 20, y: 10});
    pointer(s.control, 'pointermove', {x: 30, y: 10});
    pointer(s.control, 'lostpointercapture', {x: 30, y: 10});
    expect(s.value).toBe(0.5);
    expect(onChange).not.toHaveBeenCalled();
    // A cancel without any change reports nothing.
    onInput.mockClear();
    pointer(s.control, 'pointerdown', {x: 50, y: 10});
    pointer(s.control, 'pointercancel', {x: 50, y: 10});
    expect(onInput).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('vertical sliders go up; disabled sliders ignore input', () => {
    const s = mount(Slider({label: 'Level', value: 0, orientation: 'vertical', step: 0.25}));
    setRect(s.control, {left: 0, top: 0, width: 32, height: 100});
    pointer(s.control, 'pointerdown', {x: 10, y: 25});
    pointer(s.control, 'pointerup', {x: 10, y: 25});
    expect(s.value).toBe(0.75);
    s.control.focus();
    keydown('ArrowUp');
    expect(s.value).toBe(1);
    s.set({disabled: true});
    expect(s.control.getAttribute('aria-disabled')).toBe('true');
    keydown('ArrowDown');
    pointer(s.control, 'pointerdown', {x: 10, y: 90});
    expect(s.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Fader', () => {
  beforeEach(() => { vi.useFakeTimers(FAKE); clock.set(() => Date.now()); });

  it('inline: a double click or double tap resets to resetValue', () => {
    const onChange = vi.fn();
    const f = mount(Fader({label: 'Drums level', value: 0.4, onChange}));
    expect(f.control.getAttribute('aria-valuetext')).toBe('40%');
    setRect(f.control, {left: 0, top: 0, width: 100, height: 32});
    tap(f.control, {x: 20, y: 10});
    vi.advanceTimersByTime(DOUBLE_TAP_MS - 50);
    tap(f.control, {x: 22, y: 10});
    expect(f.value).toBe(1);
    expect(onChange).toHaveBeenLastCalledWith(1);
    // Two slow taps are two position clicks, not a reset.
    tap(f.control, {x: 20, y: 10});
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 1);
    tap(f.control, {x: 20, y: 10});
    expect(f.value).toBe(0.2);
    f.set({resetValue: 0.8});
    f.reset();
    expect(f.value).toBe(0.8);
  });

  it('pad: a vertical drag inside the host changes the level relative to its start', () => {
    const host = document.createElement('div');
    document.body.append(host);
    setRect(host, {left: 0, top: 0, width: 120, height: 200});
    const onInput = vi.fn(), onChange = vi.fn();
    const f = Fader({label: 'Bass level', variant: 'pad', host, value: 0.5, onInput, onChange});
    host.append(f.el);
    mounted.push(f);
    expect(f.control.getAttribute('aria-orientation')).toBe('vertical');
    expect(f.el.dataset.variant).toBe('pad');
    expect(host.style.getPropertyValue('--ui-fader-level')).toBe('0.5');
    pointer(host, 'pointerdown', {x: 60, y: 100});
    pointer(host, 'pointermove', {x: 60, y: 95});            // inside the slop: nothing
    expect(onInput).not.toHaveBeenCalled();
    pointer(host, 'pointermove', {x: 60, y: 60});            // 40 px up of 200 → +0.2
    expect(f.dragging).toBe(true);
    expect(host.hasAttribute('data-level-drag')).toBe(true);
    expect(f.value).toBe(0.7);
    expect(onInput).toHaveBeenLastCalledWith(0.7);
    expect(host.style.getPropertyValue('--ui-fader-level')).toBe('0.7');
    pointer(host, 'pointerup', {x: 60, y: 60});
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(0.7);
    // A horizontal swipe is not a level drag; a tap on the strip does not jump the level.
    pointer(host, 'pointerdown', {x: 10, y: 100});
    pointer(host, 'pointermove', {x: 80, y: 95});
    pointer(host, 'pointerup', {x: 80, y: 95});
    pointer(f.control, 'pointerdown', {x: 60, y: 190});
    pointer(f.control, 'pointerup', {x: 60, y: 190});
    expect(f.value).toBe(0.7);
    expect(onChange).toHaveBeenCalledTimes(1);
    f.reset();
    expect(f.value).toBe(1);
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('pad: a cancelled level drag puts the level back and commits nothing', () => {
    const host = document.createElement('div');
    document.body.append(host);
    setRect(host, {left: 0, top: 0, width: 120, height: 200});
    const onInput = vi.fn(), onChange = vi.fn();
    const f = Fader({label: 'Bass level', variant: 'pad', host, value: 0.5, onInput, onChange});
    host.append(f.el);
    mounted.push(f);
    pointer(host, 'pointerdown', {x: 60, y: 100, pointerType: 'touch'});
    pointer(host, 'pointermove', {x: 60, y: 60, pointerType: 'touch'});
    expect(f.value).toBe(0.7);
    pointer(host, 'pointercancel', {x: 60, y: 60, pointerType: 'touch'});
    expect(f.value).toBe(0.5);
    expect(onInput).toHaveBeenLastCalledWith(0.5);
    expect(host.style.getPropertyValue('--ui-fader-level')).toBe('0.5');
    expect(onChange).not.toHaveBeenCalled();
    expect(f.dragging).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('fields', () => {
  it('TextField: label, hint, error and commit on Enter or blur only when changed', () => {
    const onInput = vi.fn(), onCommit = vi.fn();
    const f = mount(TextField({label: 'Title', value: 'Glasshouse', hint: 'As it appears in the Library', maxLength: 120, onInput, onCommit}));
    const input = f.input;
    const label = f.el.querySelector('label');
    expect(label.textContent).toBe('Title');
    expect(label.htmlFor).toBe(input.id);
    expect(input.value).toBe('Glasshouse');
    expect(input.getAttribute('maxlength')).toBe('120');
    const hint = f.el.querySelector('.ui-field-hint');
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
    input.focus();
    keydown('Enter');
    expect(onCommit).not.toHaveBeenCalled();
    input.value = 'Glass House';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    expect(onInput).toHaveBeenLastCalledWith('Glass House');
    keydown('Enter');
    expect(onCommit).toHaveBeenLastCalledWith('Glass House');
    input.blur();
    expect(onCommit).toHaveBeenCalledTimes(1);
    input.focus();
    input.value = 'Glass';
    input.blur();
    expect(onCommit).toHaveBeenLastCalledWith('Glass');

    f.set({error: 'Enter a title.'});
    const error = f.el.querySelector('.ui-field-error');
    expect(error.textContent).toBe('Enter a title.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-errormessage')).toBe(error.id);
    expect(input.getAttribute('aria-describedby').split(' ')).toEqual([hint.id, error.id]);
    f.set({error: null, hint: null, value: 'Reset'});
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(error.hidden).toBe(true);
    expect(input.value).toBe('Reset');
    input.focus();
    input.blur();
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(() => TextField({})).toThrow(/label/);
  });

  it('TextField status: Saving…, then Saved which fades after 2 s; errors are alerts', () => {
    vi.useFakeTimers(FAKE);
    const f = mount(TextField({label: 'Name', status: 'saving'}));
    const status = f.el.querySelector('.ui-field-status');
    expect(status.textContent).toBe('Saving…');
    expect(status.getAttribute('role')).toBe('status');
    f.set({status: 'saved'});
    expect(status.textContent).toBe('Saved');
    vi.advanceTimersByTime(SAVED_MS);
    expect(status.hasAttribute('data-fading')).toBe(true);
    vi.advanceTimersByTime(FADE_MS);
    expect(status.textContent).toBe('');
    f.set({status: {error: 'Could not save. Check your connection.'}});
    expect(status.textContent).toBe('Could not save. Check your connection.');
    expect(status.getAttribute('role')).toBe('alert');
    expect(status.dataset.tone).toBe('error');
    vi.advanceTimersByTime(10_000);
    expect(status.textContent).toBe('Could not save. Check your connection.');
    f.set({status: null});
    expect(status.textContent).toBe('');
  });

  it('Select: options, groups and values of any type', () => {
    const onChange = vi.fn();
    const s = mount(Select({label: 'Stems', value: 4, onChange, options: [
      {value: 2, label: 'Two (vocals and the rest)'}, {value: 4, label: 'Four'},
      {label: 'More', options: [{value: 6, label: 'Six'}, {value: 'x', label: 'Unavailable', disabled: true}]},
    ]}));
    const select = s.input;
    expect(select.tagName).toBe('SELECT');
    expect(select.querySelectorAll('option')).toHaveLength(4);
    expect(select.querySelector('optgroup').label).toBe('More');
    expect(s.value).toBe(4);
    select.value = '2';
    select.dispatchEvent(new Event('change', {bubbles: true}));
    expect(onChange).toHaveBeenCalledWith(6);
    s.set({value: 2});
    expect(select.selectedIndex).toBe(0);
    expect(s.el.querySelector('label').htmlFor).toBe(select.id);
    s.set({value: 'not an option'});
    expect(select.selectedIndex).toBe(-1);
    expect(s.value).toBe(undefined);   // nothing selected reads as nothing, not the first option
  });

  it('Textarea: commits on debounce idle, blur and flush()', () => {
    vi.useFakeTimers(FAKE);
    const onCommit = vi.fn();
    const t = mount(Textarea({label: 'Notes', value: '', debounceMs: 600, maxLength: 200, onCommit}));
    const area = t.input;
    const type = text => { area.value = text; area.dispatchEvent(new Event('input', {bubbles: true})); };
    type('Watch the push');
    vi.advanceTimersByTime(300);
    type('Watch the push into the chorus');
    vi.advanceTimersByTime(599);
    expect(onCommit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onCommit).toHaveBeenLastCalledWith('Watch the push into the chorus');
    expect(t.el.querySelector('.ui-field-count').textContent).toBe('30 / 200');
    type('Fill at bar 16');
    t.flush();
    expect(onCommit).toHaveBeenLastCalledWith('Fill at bar 16');
    vi.advanceTimersByTime(1000);
    expect(onCommit).toHaveBeenCalledTimes(2);
    type('Fill at bar 17');
    area.focus();
    area.blur();
    expect(onCommit).toHaveBeenCalledTimes(3);
    t.flush();
    expect(onCommit).toHaveBeenCalledTimes(3);
  });

  it('set({value}) keeps uncommitted typing (Textarea and TextField) and still commits it', () => {
    vi.useFakeTimers(FAKE);
    const onCommit = vi.fn();
    const t = mount(Textarea({label: 'Notes', value: 'hello', debounceMs: 600, onCommit}));
    t.input.focus();
    t.input.value = 'hello world';
    t.input.dispatchEvent(new Event('input', {bubbles: true}));
    t.set({value: 'hello', status: 'saved'});   // a re-render passing the stored value
    expect(t.input.value).toBe('hello world');
    t.input.blur();
    expect(onCommit).toHaveBeenCalledWith('hello world');
    // With nothing pending the new value is taken.
    t.set({value: 'from elsewhere'});
    expect(t.input.value).toBe('from elsewhere');
    // The debounce commit keeps running through a set().
    t.input.value = 'typed';
    t.input.dispatchEvent(new Event('input', {bubbles: true}));
    t.set({value: 'from elsewhere', status: 'saving'});
    vi.advanceTimersByTime(600);
    expect(onCommit).toHaveBeenLastCalledWith('typed');

    const onField = vi.fn();
    const f = mount(TextField({label: 'Title', value: 'Song', onCommit: onField}));
    f.input.focus();
    f.input.value = 'Song 2';
    f.set({value: 'Song', status: 'saved'});
    expect(f.input.value).toBe('Song 2');
    f.input.blur();
    expect(onField).toHaveBeenCalledWith('Song 2');
    f.set({value: 'Renamed'});
    expect(f.input.value).toBe('Renamed');
  });

  describe('ChipInput', () => {
    let onChange, c;
    beforeEach(() => {
      onChange = vi.fn();
      c = mount(ChipInput({label: 'Tags', values: ['Funk'], onChange, maxItems: 4, maxLength: 10}));
    });
    const chipLabels = () => [...c.el.querySelectorAll('.ui-chip-label')].map(n => n.textContent);
    const type = text => { c.input.value = text; c.input.dispatchEvent(new Event('input', {bubbles: true})); };

    it('commits on Enter and on comma', () => {
      c.input.focus();
      type('Soul');
      const enter = keydown('Enter');
      expect(enter.defaultPrevented).toBe(true);
      expect(onChange).toHaveBeenLastCalledWith(['Funk', 'Soul']);
      type('Jazz');
      keydown(',');
      expect(chipLabels()).toEqual(['Funk', 'Soul', 'Jazz']);
      expect(c.input.value).toBe('');
      expect(keydown('Enter').defaultPrevented).toBe(false);   // empty: Enter stays native
    });

    it('splits pasted text on commas and keeps the last piece in the input; blur commits it', () => {
      c.input.focus();
      type('Soul, Gospel,Bl');
      expect(chipLabels()).toEqual(['Funk', 'Soul', 'Gospel']);
      expect(c.input.value).toBe('Bl');
      c.input.value = 'Blues';
      c.input.blur();
      expect(chipLabels()).toEqual(['Funk', 'Soul', 'Gospel', 'Blues']);
    });

    it('Backspace in the empty input removes the last chip; ✕ removes its chip', () => {
      c.set({values: ['Funk', 'Soul', 'Jazz']});
      c.input.focus();
      type('');
      keydown('Backspace');
      expect(onChange).toHaveBeenLastCalledWith(['Funk', 'Soul']);
      type('x');
      keydown('Backspace');
      expect(chipLabels()).toEqual(['Funk', 'Soul']);
      const x = c.el.querySelector('[aria-label="Remove Funk"]');
      x.click();
      expect(onChange).toHaveBeenLastCalledWith(['Soul']);
      expect(document.activeElement).toBe(c.input);
    });

    it('refuses duplicates (case-insensitive), over-long values and values past maxItems', () => {
      const note = c.el.querySelector('.ui-field-note');
      c.input.focus();
      type('funk');
      keydown('Enter');
      expect(chipLabels()).toEqual(['Funk']);
      expect(note.textContent).toBe('"funk" is already there.');
      expect(note.getAttribute('role')).toBe('status');
      type('Psychedelic');
      keydown('Enter');
      expect(note.textContent).toBe('Keep each one to 10 characters.');
      type('a,b,c,d,');
      expect(chipLabels()).toEqual(['Funk', 'a', 'b', 'c']);
      expect(note.textContent).toBe('Up to 4.');
      c.set({caseInsensitive: false, values: ['Funk'], maxItems: 30});
      type('funk,');
      expect(chipLabels()).toEqual(['Funk', 'funk']);
    });

    it('keeps refused typed text in the input beside the note', () => {
      c.set({values: ['a', 'b', 'c', 'd']});
      c.input.focus();
      type('important');
      keydown('Enter');
      expect(c.input.value).toBe('important');
      expect(c.el.querySelector('.ui-field-note').textContent).toBe('Up to 4.');
      c.input.blur();
      expect(c.input.value).toBe('important');
      c.set({values: ['a']});
      c.input.focus();
      keydown('Enter');
      expect(chipLabels()).toEqual(['a', 'important']);
      expect(c.input.value).toBe('');
    });

    it('puts no maxlength on the input, so a pasted list is never cut before the split', () => {
      const all = mount(ChipInput({label: 'Parts', values: []}));
      expect(all.input.hasAttribute('maxlength')).toBe(false);
      const list = 'Guitar, Bass, Drums, Keys, Vocals, Percussion, Strings, Brass, Woodwinds, Synth';
      expect(list.length).toBeGreaterThan(60);
      all.input.value = `${list},`;
      all.input.dispatchEvent(new Event('input', {bubbles: true}));
      expect(all.value).toEqual(list.split(', '));
      expect(all.input.value).toBe('');
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('dispatcher interop: focused inputs consume only their own keys', () => {
  let r, ran, stop;
  beforeEach(() => {
    r = createRegistry();
    ran = [];
    const cmd = (id, keys, group = 'Transport') => r.register({id, title: id, group, keys, scopes: ['stage'], run: () => ran.push(id)});
    cmd('transport.playStop', ['Space']);
    cmd('transport.again', ['Enter']);
    cmd('mix.mute.1', ['Digit1'], 'Mix');
    cmd('loop.toggle', ['KeyL'], 'Loop');
    cmd('transport.nudgeBack', ['ArrowLeft']);
    cmd('transport.nudgeFwd', ['ArrowRight']);
    cmd('transport.toStart', ['Home']);
    cmd('section.prev', ['PageUp'], 'Navigate');
    stop = startDispatcher({registry: r, platform: 'win'});
    document.documentElement.dataset.place = 'stage';
    document.documentElement.dataset.posture = 'stage';
  });
  afterEach(() => {
    stop();
    delete document.documentElement.dataset.place;
    delete document.documentElement.dataset.posture;
  });

  it('a focused Slider never swallows Space, digits, letters or PageUp', () => {
    const s = mount(Slider({label: 'Volume', value: 0.5, step: 0.1}));
    s.control.focus();
    for (const k of ['Space', 'Digit1', 'KeyL', 'PageUp']) keydown(k);
    expect(ran).toEqual(['transport.playStop', 'mix.mute.1', 'loop.toggle', 'section.prev']);
    expect(s.value).toBe(0.5);
    ran.length = 0;
    keydown('ArrowRight');
    keydown('Home');
    expect(ran).toEqual([]);
    expect(s.value).toBe(0);
  });

  it('a focused Stepper consumes arrows, PageUp/PageDown and Home/End, and nothing else', () => {
    const st = mount(Stepper({label: 'Speed', value: 1, min: 0.25, max: 1.5, step: 0.05, bigStep: 0.25}));
    st.el.querySelector('[role=spinbutton]').focus();
    keydown('PageUp');
    keydown('ArrowLeft');
    expect(ran).toEqual([]);
    expect(st.value).toBe(1.2);
    for (const k of ['Space', 'Enter', 'Digit1']) keydown(k);
    expect(ran).toEqual(['transport.playStop', 'transport.again', 'mix.mute.1']);
    expect(st.value).toBe(1.2);
  });

  it('a focused Fader (inline and pad) and a Segmented group behave the same way', () => {
    const f = mount(Fader({label: 'Drums level', value: 0.5}));
    f.control.focus();
    keydown('ArrowLeft');
    keydown('Space');
    expect(f.value).toBe(0.49);
    expect(ran).toEqual(['transport.playStop']);
    ran.length = 0;
    const host = document.createElement('div');
    document.body.append(host);
    const pad = Fader({label: 'Bass level', value: 0.5, variant: 'pad', host});
    host.append(pad.el);
    mounted.push(pad);
    pad.control.focus();
    keydown('ArrowUp');
    keydown('Digit1');
    expect(pad.value).toBe(0.51);
    expect(ran).toEqual(['mix.mute.1']);
    ran.length = 0;
    const seg = mount(Segmented({label: 'Tap to', options: [{value: 'a', label: 'Mute'}, {value: 'b', label: 'Solo'}], value: 'a'}));
    seg.el.querySelector('[role=radio]').focus();
    keydown('ArrowRight');
    keydown('Space');
    expect(seg.value).toBe('b');
    expect(ran).toEqual(['transport.playStop']);
  });
});
