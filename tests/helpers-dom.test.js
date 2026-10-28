// @vitest-environment happy-dom
import {afterEach, describe, expect, test, vi} from 'vitest';
import {
  contextOf, createRecordingContext, evaluateMedia, flushFrames, installCanvasShim, installDomShims, installFontsStub,
  installFrameShim, installPopoverShim, installResizeObserverShim, isPopoverOpen, keyEvent, keyForCode, keyInit, keydown, keyup,
  pendingFrames, pointer, pointerEvent, press, restoreDomShims, setMedia, setRect, tap, touch, touchEvent, triggerResize,
} from './helpers/dom.js';

afterEach(() => { restoreDomShims(); document.body.replaceChildren(); });

describe('keyboard events', () => {
  test('code specs derive the US key; modifiers parse; Mod follows the platform', () => {
    expect(keyInit('KeyK')).toMatchObject({code: 'KeyK', key: 'k', shiftKey: false});
    expect(keyInit('Shift+KeyK')).toMatchObject({code: 'KeyK', key: 'K', shiftKey: true});
    expect(keyInit('Shift+Comma')).toMatchObject({code: 'Comma', key: '<'});
    expect(keyInit('Shift+Slash')).toMatchObject({code: 'Slash', key: '?'});
    expect(keyInit('Shift+Digit1')).toMatchObject({code: 'Digit1', key: '!'});
    expect(keyInit('Space')).toMatchObject({code: 'Space', key: ' '});
    expect(keyInit('Mod+KeyK')).toMatchObject({ctrlKey: true, metaKey: false});
    expect(keyInit('Mod+KeyK', {mac: true})).toMatchObject({ctrlKey: false, metaKey: true});
    expect(keyInit('Ctrl+Alt+Meta+F5')).toMatchObject({code: 'F5', key: 'F5', ctrlKey: true, altKey: true, metaKey: true});
    expect(() => keyInit('Hyper+KeyK')).toThrow(/modifier/);
  });

  test('bare keys derive the code where unambiguous; objects pass through', () => {
    expect(keyInit('?')).toMatchObject({key: '?', code: 'Slash'});
    expect(keyInit('k')).toMatchObject({key: 'k', code: 'KeyK'});
    expect(keyInit('5')).toMatchObject({key: '5', code: 'Digit5'});
    expect(keyInit('Enter')).toMatchObject({key: 'Enter', code: 'Enter'});
    expect(keyInit('+')).toMatchObject({key: '+', code: 'Equal'});
    expect(keyInit('Shift++')).toMatchObject({key: '+', shiftKey: true});
    expect(keyInit({key: 'q', code: 'KeyA'})).toEqual({key: 'q', code: 'KeyA'});   // an AZERTY 'a' key
    expect(keyForCode('Numpad4')).toBe('4');
    expect(keyForCode('Unknown')).toBe('Unknown');
  });

  test('keydown / keyup / press dispatch bubbling, cancelable events on the focused element', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    const seen = [];
    document.addEventListener('keydown', e => { seen.push([e.type, e.code, e.key, e.target === button, e.repeat]); e.preventDefault(); }, {once: true});
    const down = keydown('KeyL', {repeat: true});
    expect(down.defaultPrevented).toBe(true);
    expect(seen).toEqual([['keydown', 'KeyL', 'l', true, true]]);
    const target = document.createElement('div');
    const up = vi.fn();
    target.addEventListener('keyup', up);
    keyup('Escape', {target});
    expect(up.mock.calls[0][0].key).toBe('Escape');
    const {down: d2, up: u2} = press('Space', {target});
    expect([d2.type, u2.type, d2.cancelable, d2.bubbles]).toEqual(['keydown', 'keyup', true, true]);
    expect(keyEvent('keydown', 'Mod+KeyZ', {mac: true}).metaKey).toBe(true);
  });
});

describe('pointer and touch events', () => {
  test('pointer events carry coordinates, type and buttons; tap clicks', () => {
    const el = document.createElement('div');
    const seen = [];
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'click']) el.addEventListener(t, e => seen.push([e.type, e.clientX, e.clientY, e.pointerType ?? null, e.buttons]));
    pointer(el, 'pointerdown', {x: 10, y: 20, pointerType: 'touch'});
    pointer(el, 'pointermove', {x: 15, y: 25, pointerType: 'touch', buttons: 1});
    const click = tap(el, {x: 5, y: 6});
    expect(seen[0]).toEqual(['pointerdown', 10, 20, 'touch', 1]);
    expect(seen[1]).toEqual(['pointermove', 15, 25, 'touch', 1]);
    expect(seen.at(-1)[0]).toBe('click');
    expect(click.clientX).toBe(5);
    expect(pointerEvent('pointerup').buttons).toBe(0);
    expect(pointerEvent('pointerdown', {pointerId: 7}).pointerId).toBe(7);
  });

  test('touch events build Touch lists', () => {
    const el = document.createElement('div');
    const handler = vi.fn();
    el.addEventListener('touchstart', handler);
    touch(el, 'touchstart', [{x: 1, y: 2}, {x: 30, y: 40, id: 9}]);
    const e = handler.mock.calls[0][0];
    expect(e.touches).toHaveLength(2);
    expect(e.touches[1].identifier).toBe(9);
    expect(e.touches[1].clientX).toBe(30);
    const end = touchEvent('touchend', el, [], {changed: [{x: 1, y: 2}]});
    expect(end.touches).toHaveLength(0);
    expect(end.changedTouches).toHaveLength(1);
  });
});

describe('installPopoverShim', () => {
  test('show / hide / toggle with beforetoggle and toggle events; restore removes it', () => {
    expect(document.createElement('div').showPopover).toBeUndefined();
    const restore = installPopoverShim();
    const el = document.createElement('div');
    el.setAttribute('popover', 'manual');
    const events = [];
    el.addEventListener('toggle', e => events.push(`${e.oldState}→${e.newState}`));
    el.showPopover();
    el.showPopover();   // already open: no event
    expect(isPopoverOpen(el)).toBe(true);
    expect(el.matches('[data-popover-open]')).toBe(true);
    el.hidePopover();
    expect(el.togglePopover()).toBe(true);
    expect(el.togglePopover(true)).toBe(true);
    expect(el.togglePopover(false)).toBe(false);
    expect(events).toEqual(['closed→open', 'open→closed', 'closed→open', 'open→closed']);
    const cancel = document.createElement('div');
    cancel.setAttribute('popover', '');
    cancel.addEventListener('beforetoggle', e => e.preventDefault());
    cancel.showPopover();
    expect(isPopoverOpen(cancel)).toBe(false);
    expect(() => document.createElement('div').showPopover()).toThrow();
    restore();
    expect(document.createElement('div').showPopover).toBeUndefined();
  });

  test(':popover-open works in matches, closest and querySelector(All) via the attribute', () => {
    const restore = installPopoverShim();
    const el = document.createElement('div');
    el.setAttribute('popover', '');
    const inner = document.createElement('span');
    el.append(inner);
    document.body.append(el);
    const frag = document.createDocumentFragment();
    expect(el.matches(':popover-open')).toBe(false);
    expect(document.querySelectorAll(':popover-open')).toHaveLength(0);
    el.showPopover();
    expect(el.matches(':popover-open')).toBe(true);
    expect(el.matches('div:popover-open, p')).toBe(true);
    expect(inner.closest(':popover-open')).toBe(el);
    expect(document.querySelector('[popover]:popover-open')).toBe(el);
    expect(document.body.querySelectorAll(':popover-open')).toHaveLength(1);
    frag.append(el);
    expect(frag.querySelector(':popover-open')).toBe(el);
    el.hidePopover();
    expect(el.matches(':popover-open')).toBe(false);
    expect(frag.querySelector(':popover-open')).toBeNull();
    restore();
    expect(el.matches('[popover]')).toBe(true);
    expect(document.createElement('div').showPopover).toBeUndefined();
  });
});

describe('canvas', () => {
  test('createRecordingContext records calls and property sets', () => {
    const ctx = createRecordingContext();
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 10, 20);
    ctx.save();
    ctx.lineWidth = 3;
    ctx.restore();
    ctx.setLineDash([2, 2]);
    expect(ctx.fillStyle).toBe('red');
    expect(ctx.lineWidth).toBe(1);   // restored
    expect(ctx.callsOf('fillRect')).toEqual([[0, 0, 10, 20]]);
    expect(ctx.setsOf('fillStyle')).toEqual(['red']);
    expect(ctx.calls.map(c => c.name)).toEqual(['fillStyle', 'fillRect', 'save', 'lineWidth', 'restore', 'setLineDash']);
    ctx.font = '20px x';
    expect(ctx.measureText('abc').width).toBeCloseTo(36);
    const g = ctx.createLinearGradient(0, 0, 1, 1);
    g.addColorStop(0, 'a');
    expect(ctx.callsOf('addColorStop')).toEqual([[0, 'a']]);
    ctx.reset();
    expect(ctx.calls).toEqual([]);
  });

  test('installCanvasShim gives each canvas one recording 2d context', () => {
    const canvas = document.createElement('canvas');
    expect(canvas.getContext('2d')).toBeNull();
    const restore = installCanvasShim();
    const ctx = canvas.getContext('2d');
    expect(canvas.getContext('2d')).toBe(ctx);
    expect(contextOf(canvas)).toBe(ctx);
    expect(ctx.canvas).toBe(canvas);
    expect(canvas.getContext('webgl')).toBeNull();
    ctx.stroke();
    expect(ctx.callsOf('stroke')).toHaveLength(1);
    restore();
    expect(document.createElement('canvas').getContext('2d')).toBeNull();
  });
});

describe('setRect and ResizeObserver', () => {
  test('setRect gives an element a box', () => {
    const el = setRect(document.createElement('div'), {x: 10, y: 5, width: 300, height: 40});
    expect(el.getBoundingClientRect()).toMatchObject({left: 10, top: 5, right: 310, bottom: 45, width: 300, height: 40});
    expect([el.clientWidth, el.clientHeight, el.offsetWidth, el.offsetLeft]).toEqual([300, 40, 300, 10]);
    expect(el.getClientRects()).toHaveLength(1);
    setRect(el, {width: 100, height: 10, scrollWidth: 140});
    expect([el.clientWidth, el.scrollWidth]).toEqual([100, 140]);
  });

  test('triggerResize drives the fake ResizeObserver', () => {
    expect(() => triggerResize(document.body)).toThrow(/installResizeObserverShim/);
    installResizeObserverShim();
    const el = document.createElement('div');
    const other = document.createElement('div');
    const cb = vi.fn();
    const ro = new ResizeObserver(cb);
    ro.observe(el);
    expect(triggerResize(other)).toBe(0);
    expect(triggerResize(el, {width: 800, height: 600})).toBe(1);
    const [[entry]] = cb.mock.calls[0];
    expect(entry.target).toBe(el);
    expect(entry.contentRect).toMatchObject({width: 800, height: 600});
    expect(entry.borderBoxSize[0]).toEqual({inlineSize: 800, blockSize: 600});
    ro.unobserve(el);
    expect(triggerResize(el)).toBe(0);
    ro.observe(el);
    ro.disconnect();
    expect(triggerResize(el)).toBe(0);
  });
});

describe('setMedia', () => {
  test('controls matchMedia and fires change on flips', () => {
    expect(window.matchMedia('(pointer: coarse)').matches).toBe(false);
    setMedia({coarse: true});
    const coarse = window.matchMedia('(pointer: coarse)');
    const fine = matchMedia('(pointer: fine)');
    expect(coarse.matches).toBe(true);
    expect(fine.matches).toBe(false);
    const onChange = vi.fn();
    const legacy = vi.fn();
    fine.addEventListener('change', onChange);
    fine.addListener(legacy);
    setMedia({coarse: false});
    expect(fine.matches).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].matches).toBe(true);
    expect(legacy).toHaveBeenCalledTimes(1);
    setMedia({coarse: false});   // no flip, no event
    expect(onChange).toHaveBeenCalledTimes(1);
    setMedia({reducedMotion: true, dark: true, hoverNone: true});
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
    expect(matchMedia('(prefers-color-scheme: dark)').matches).toBe(true);
    expect(matchMedia('(hover: none) and (pointer: coarse)').matches).toBe(false);
    setMedia({coarse: true});
    expect(matchMedia('(hover: none) and (pointer: coarse)').matches).toBe(true);
    restoreDomShims();
    expect(window.matchMedia('(pointer: coarse)').matches).toBe(false);
  });

  test('evaluateMedia handles lists, not, screen and widths', () => {
    const s = {coarse: false, hoverNone: false, reducedMotion: false, dark: false, standalone: true, width: 820, height: 1180};
    expect(evaluateMedia('(min-width: 800px)', s)).toBe(true);
    expect(evaluateMedia('screen and (max-width: 700px)', s)).toBe(false);
    expect(evaluateMedia('(max-width: 700px), (orientation: portrait)', s)).toBe(true);
    expect(evaluateMedia('not all and (pointer: coarse)', s)).toBe(true);
    expect(evaluateMedia('(display-mode: standalone)', s)).toBe(true);
    expect(evaluateMedia('(any-pointer: fine)', s)).toBe(true);
    expect(evaluateMedia('(prefers-reduced-motion: no-preference)', s)).toBe(true);
    expect(evaluateMedia('(unknown-feature: x)', s)).toBe(false);
  });
});

describe('installFontsStub', () => {
  test('document.fonts.load resolves and records; ready resolves', async () => {
    expect(document.fonts).toBeUndefined();
    installFontsStub();
    await expect(document.fonts.load('600 15px "Atkinson Hyperlegible Next"')).resolves.toEqual([]);
    expect(document.fonts.loads).toEqual(['600 15px "Atkinson Hyperlegible Next"']);
    expect(await document.fonts.ready).toBe(document.fonts);
    expect(document.fonts.check('1em x')).toBe(true);
    restoreDomShims();
    expect(document.fonts).toBeUndefined();
  });
});

describe('flushFrames', () => {
  test('runs queued callbacks frame by frame with advancing timestamps', () => {
    installFrameShim();
    const times = [];
    const loop = t => { times.push(t); if (times.length < 3) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const cancelled = vi.fn();
    cancelAnimationFrame(requestAnimationFrame(cancelled));
    expect(pendingFrames()).toBe(1);
    expect(flushFrames(1)).toBe(1);
    expect(flushFrames(5)).toBe(2);
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBeCloseTo(1000 / 60);
    expect(cancelled).not.toHaveBeenCalled();
    expect(pendingFrames()).toBe(0);
  });

  test('a callback cancelled by a sibling during the same frame does not run', () => {
    installFrameShim();
    const late = vi.fn();
    let lateId;
    const first = vi.fn(() => cancelAnimationFrame(lateId));
    requestAnimationFrame(first);
    lateId = requestAnimationFrame(late);
    expect(flushFrames(1)).toBe(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
    expect(flushFrames(2)).toBe(0);
    expect(late).not.toHaveBeenCalled();
  });

  test('installs itself on first use; window.requestAnimationFrame is the same queue', () => {
    flushFrames(0);
    const fn = vi.fn();
    window.requestAnimationFrame(fn);
    flushFrames();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('installDomShims', () => {
  test('installs everything and restoreDomShims undoes everything', () => {
    const restore = installDomShims({media: {coarse: true}});
    expect(typeof document.createElement('div').showPopover).toBe('function');
    expect(document.createElement('canvas').getContext('2d')).not.toBeNull();
    expect(matchMedia('(pointer: coarse)').matches).toBe(true);
    expect(document.fonts).toBeDefined();
    const ro = new ResizeObserver(() => {});
    expect(typeof ro.observe).toBe('function');
    restore();
    expect(document.createElement('div').showPopover).toBeUndefined();
    expect(document.createElement('canvas').getContext('2d')).toBeNull();
    expect(matchMedia('(pointer: coarse)').matches).toBe(false);
    expect(document.fonts).toBeUndefined();
  });
});
