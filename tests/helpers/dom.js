// DOM test kit for happy-dom suites (architecture §11.3). Use in files that
// start with `// @vitest-environment happy-dom`.
//
// happy-dom has no Popover API, no 2D canvas, no layout (every rect is 0×0), no
// document.fonts, a matchMedia that is always false and a ResizeObserver that
// never fires. These shims let unit tests assert behaviour, structure, roles and
// names. Computed sizes, styles and geometry are Playwright probes, never vitest.
//
// Every install*() returns a restore function; restoreDomShims() undoes all of
// them (call it in afterEach). installDomShims() installs everything at once.

const restorers = [];

function remember(restore) {
  let done = false;
  const once = () => { if (done) return; done = true; restore(); const i = restorers.indexOf(once); if (i >= 0) restorers.splice(i, 1); };
  restorers.push(once);
  return once;
}

function patch(target, name, descriptor) {
  const own = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, {configurable: true, ...descriptor});
  return () => {
    if (own) Object.defineProperty(target, name, own);
    else delete target[name];
  };
}

// Patches a global on window and, when the test environment keeps a separate globalThis, there too.
function patchGlobal(name, value) {
  const undo = [patch(window, name, {value, writable: true})];
  if (globalThis !== window) undo.push(patch(globalThis, name, {value, writable: true}));
  return () => undo.forEach(fn => fn());
}

/** Undoes every shim installed by this module. */
export function restoreDomShims() {
  for (const restore of [...restorers].reverse()) restore();
}

// ---------- event builders ----------

const KEY_FOR_CODE = {
  Space: [' ', ' '], Enter: ['Enter', 'Enter'], Escape: ['Escape', 'Escape'], Tab: ['Tab', 'Tab'],
  Backspace: ['Backspace', 'Backspace'], Delete: ['Delete', 'Delete'],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft'], ArrowRight: ['ArrowRight', 'ArrowRight'], ArrowUp: ['ArrowUp', 'ArrowUp'], ArrowDown: ['ArrowDown', 'ArrowDown'],
  Home: ['Home', 'Home'], End: ['End', 'End'], PageUp: ['PageUp', 'PageUp'], PageDown: ['PageDown', 'PageDown'],
  Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'], Semicolon: [';', ':'], Quote: ["'", '"'],
  BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'], Minus: ['-', '_'], Equal: ['=', '+'], Backquote: ['`', '~'],
  ContextMenu: ['ContextMenu', 'ContextMenu'], ShiftLeft: ['Shift', 'Shift'], ShiftRight: ['Shift', 'Shift'],
  ControlLeft: ['Control', 'Control'], MetaLeft: ['Meta', 'Meta'], AltLeft: ['Alt', 'Alt'],
  NumpadEnter: ['Enter', 'Enter'], MediaPlayPause: ['MediaPlayPause', 'MediaPlayPause'],
};
const SHIFTED_DIGITS = ')!@#$%^&*(';

/** The `key` a US layout produces for a physical `code`. */
export function keyForCode(code, {shift = false} = {}) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return shift ? m[1] : m[1].toLowerCase();
  if ((m = /^Digit([0-9])$/.exec(code))) return shift ? SHIFTED_DIGITS[Number(m[1])] : m[1];
  if ((m = /^Numpad([0-9])$/.exec(code))) return m[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const pair = KEY_FOR_CODE[code];
  return pair ? pair[shift ? 1 : 0] : code;
}

const MODS = {shift: 'shiftKey', ctrl: 'ctrlKey', control: 'ctrlKey', alt: 'altKey', option: 'altKey', meta: 'metaKey', cmd: 'metaKey'};

/**
 * Parses a key spec into KeyboardEvent init. Accepts an object ({key, code, shiftKey, …}) or a
 * string such as 'KeyK', 'Shift+Comma', 'Ctrl+KeyK', 'Mod+KeyK' (Mod = Meta with {mac: true}, else Ctrl)
 * or a bare key ('?', 'Enter', 'k').
 */
export function keyInit(spec, {mac = false} = {}) {
  if (typeof spec !== 'string') return {...spec};
  const parts = spec.split('+');
  // 'Shift++' style: a trailing empty part means the '+' key itself.
  if (parts.length > 1 && parts[parts.length - 1] === '' ) { parts.pop(); parts[parts.length - 1] = '+'; }
  const main = parts.pop();
  const init = {shiftKey: false, ctrlKey: false, altKey: false, metaKey: false};
  for (const p of parts) {
    const mod = p.toLowerCase();
    if (mod === 'mod') init[mac ? 'metaKey' : 'ctrlKey'] = true;
    else if (MODS[mod]) init[MODS[mod]] = true;
    else throw new Error(`keyInit: unknown modifier ${p}`);
  }
  const looksLikeCode = /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F\d+)$/.test(main) || main in KEY_FOR_CODE;
  if (looksLikeCode) return {...init, code: main, key: keyForCode(main, {shift: init.shiftKey})};
  // A bare key: derive the code on a US layout where it is unambiguous.
  let code = '';
  if (/^[a-z]$/i.test(main)) code = `Key${main.toUpperCase()}`;
  else if (/^[0-9]$/.test(main)) code = `Digit${main}`;
  else {
    for (const [c, [plain, shifted]] of Object.entries(KEY_FOR_CODE)) {
      if (plain === main) { code = c; break; }
      if (shifted === main) { code = c; break; }
    }
    const digit = SHIFTED_DIGITS.indexOf(main);
    if (!code && digit >= 0) code = `Digit${digit}`;
  }
  return {...init, key: main, code};
}

/** Builds a KeyboardEvent ('keydown' | 'keyup') from a spec (see keyInit). Bubbles and is cancelable. */
export function keyEvent(type, spec, extra = {}) {
  const {mac, ...rest} = extra;
  return new window.KeyboardEvent(type, {bubbles: true, cancelable: true, composed: true, ...keyInit(spec, {mac}), ...rest});
}

/** Dispatches a keydown on target (default: the focused element) and returns the event. */
export function keydown(spec, {target, ...extra} = {}) {
  const event = keyEvent('keydown', spec, extra);
  (target ?? document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

/** Dispatches a keyup on target (default: the focused element) and returns the event. */
export function keyup(spec, {target, ...extra} = {}) {
  const event = keyEvent('keyup', spec, extra);
  (target ?? document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

/** keydown then keyup; returns {down, up}. */
export function press(spec, options = {}) {
  const down = keydown(spec, options);
  const up = keyup(spec, options);
  return {down, up};
}

/** Builds a PointerEvent. Coordinates are client coordinates. */
export function pointerEvent(type, {x = 0, y = 0, pointerType = 'mouse', pointerId = 1, button = 0, buttons,
  isPrimary = true, pressure, ...rest} = {}) {
  return new window.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y,
    pointerType, pointerId, button, buttons: buttons ?? (type === 'pointerdown' ? 1 : 0),
    isPrimary, pressure: pressure ?? (type === 'pointerdown' ? 0.5 : 0), ...rest,
  });
}

/** Dispatches a pointer event on target; returns it. */
export function pointer(target, type, init = {}) {
  const event = pointerEvent(type, init);
  target.dispatchEvent(event);
  return event;
}

/** pointerdown + pointerup (+ click) at one point: a tap or click. Returns the click event. */
export function tap(target, init = {}) {
  pointer(target, 'pointerdown', init);
  pointer(target, 'pointerup', init);
  const click = new window.MouseEvent('click', {bubbles: true, cancelable: true, clientX: init.x ?? 0, clientY: init.y ?? 0, button: 0});
  target.dispatchEvent(click);
  return click;
}

/**
 * Builds a TouchEvent. `points` is [{x, y, id?}] for the touches currently down
 * (for touchend, the remaining ones); `changed` defaults to `points`.
 */
export function touchEvent(type, target, points = [], {changed} = {}) {
  const toTouch = (p, i) => new window.Touch({identifier: p.id ?? i, target, clientX: p.x ?? 0, clientY: p.y ?? 0,
    screenX: p.x ?? 0, screenY: p.y ?? 0, pageX: p.x ?? 0, pageY: p.y ?? 0});
  const touches = points.map(toTouch);
  const changedTouches = (changed ?? points).map(toTouch);
  return new window.TouchEvent(type, {bubbles: true, cancelable: true, composed: true, touches, targetTouches: touches, changedTouches});
}

/** Dispatches a touch event on target; returns it. */
export function touch(target, type, points = [], options = {}) {
  const event = touchEvent(type, target, points, options);
  target.dispatchEvent(event);
  return event;
}

// ---------- Popover API ----------

/**
 * Adds showPopover / hidePopover / togglePopover to HTMLElement. The open state is the
 * `data-popover-open` attribute (match it in place of `:popover-open`, or use isPopoverOpen()).
 * Fires `beforetoggle` and `toggle` events with {oldState, newState}.
 */
export function installPopoverShim() {
  const proto = window.HTMLElement.prototype;
  const fire = (el, type, oldState, newState) => {
    const event = new window.Event(type, {cancelable: type === 'beforetoggle'});
    event.oldState = oldState;
    event.newState = newState;
    el.dispatchEvent(event);
    return event;
  };
  const show = function showPopover() {
    if (!this.hasAttribute('popover')) throw new window.DOMException('Not a popover', 'NotSupportedError');
    if (this.hasAttribute('data-popover-open')) return;
    if (fire(this, 'beforetoggle', 'closed', 'open').defaultPrevented) return;
    this.setAttribute('data-popover-open', '');
    fire(this, 'toggle', 'closed', 'open');
  };
  const hide = function hidePopover() {
    if (!this.hasAttribute('data-popover-open')) return;
    fire(this, 'beforetoggle', 'open', 'closed');
    this.removeAttribute('data-popover-open');
    fire(this, 'toggle', 'open', 'closed');
  };
  const toggle = function togglePopover(force) {
    const open = this.hasAttribute('data-popover-open');
    const want = typeof force === 'boolean' ? force : !open;
    if (want) show.call(this); else hide.call(this);
    return want;
  };
  const undo = [
    patch(proto, 'showPopover', {value: show, writable: true}),
    patch(proto, 'hidePopover', {value: hide, writable: true}),
    patch(proto, 'togglePopover', {value: toggle, writable: true}),
  ];
  return remember(() => undo.forEach(fn => fn()));
}

/** True when the shimmed popover is open. */
export const isPopoverOpen = el => el.hasAttribute('data-popover-open');

// ---------- canvas ----------

/**
 * A 2D-context stand-in that records every method call and property set:
 *   ctx.calls → [{name, args}] for methods, [{name, set: value}] for properties
 *   ctx.callsOf('fillRect') → the args of each fillRect call
 *   ctx.reset() clears the log.
 * Unknown methods are recorded too; measureText returns a width of 0.6 em per character.
 */
export function createRecordingContext(canvas = null) {
  const calls = [];
  const state = {fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, globalAlpha: 1, font: '10px sans-serif',
    textAlign: 'start', textBaseline: 'alphabetic', lineCap: 'butt', lineJoin: 'miter', globalCompositeOperation: 'source-over'};
  const stack = [];
  const helpers = {
    canvas,
    calls,
    callsOf: name => calls.filter(c => c.name === name && 'args' in c).map(c => c.args),
    setsOf: name => calls.filter(c => c.name === name && 'set' in c).map(c => c.set),
    reset: () => { calls.length = 0; },
    save: () => { calls.push({name: 'save', args: []}); stack.push({...state}); },
    restore: () => { calls.push({name: 'restore', args: []}); Object.assign(state, stack.pop() ?? {}); },
    measureText: s => {
      calls.push({name: 'measureText', args: [s]});
      const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(state.font)?.[1] ?? '10');
      return {width: String(s).length * size * 0.6, actualBoundingBoxAscent: size * 0.8, actualBoundingBoxDescent: size * 0.2};
    },
    getImageData: (x, y, w, h) => { calls.push({name: 'getImageData', args: [x, y, w, h]}); return {width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4))}; },
    createLinearGradient: (...args) => { calls.push({name: 'createLinearGradient', args}); return {addColorStop: (...a) => calls.push({name: 'addColorStop', args: a})}; },
    createRadialGradient: (...args) => { calls.push({name: 'createRadialGradient', args}); return {addColorStop: (...a) => calls.push({name: 'addColorStop', args: a})}; },
    createPattern: (...args) => { calls.push({name: 'createPattern', args}); return {setTransform() {}}; },
    getLineDash: () => [],
    getTransform: () => ({a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}),
    isPointInPath: () => false,
  };
  return new Proxy(helpers, {
    get(target, name) {
      if (name in target) return target[name];
      if (name in state) return state[name];
      if (typeof name === 'symbol') return undefined;
      return (...args) => { calls.push({name, args}); };
    },
    set(target, name, value) {
      state[name] = value;
      calls.push({name, set: value});
      return true;
    },
  });
}

/**
 * Patches HTMLCanvasElement.prototype.getContext to return a recording context
 * (one per canvas, created on first use). contextOf(canvas) returns it.
 */
export function installCanvasShim() {
  const contexts = new WeakMap();
  const undo = patch(window.HTMLCanvasElement.prototype, 'getContext', {
    writable: true,
    value: function getContext(type) {
      if (type !== '2d') return null;
      let ctx = contexts.get(this);
      if (!ctx) { ctx = createRecordingContext(this); contexts.set(this, ctx); }
      return ctx;
    },
  });
  canvasContexts = contexts;
  return remember(() => { undo(); canvasContexts = null; });
}
let canvasContexts = null;

/** The recording context of a canvas (after installCanvasShim and getContext('2d')). */
export function contextOf(canvas) {
  return canvasContexts?.get(canvas) ?? null;
}

// ---------- layout: rects and ResizeObserver ----------

/**
 * Gives an element a layout box: getBoundingClientRect, getClientRects, clientWidth/Height,
 * offsetWidth/Height/Left/Top and scrollWidth/Height (≥ the box). rect: {x|left, y|top, width, height}.
 */
export function setRect(el, rect) {
  const x = rect.x ?? rect.left ?? 0, y = rect.y ?? rect.top ?? 0;
  const width = rect.width ?? 0, height = rect.height ?? 0;
  const box = {x, y, left: x, top: y, width, height, right: x + width, bottom: y + height};
  const domRect = () => ({...box, toJSON: () => ({...box})});
  el.getBoundingClientRect = domRect;
  el.getClientRects = () => [domRect()];
  for (const [name, value] of Object.entries({clientWidth: width, clientHeight: height, offsetWidth: width, offsetHeight: height,
    offsetLeft: x, offsetTop: y})) {
    Object.defineProperty(el, name, {configurable: true, get: () => value});
  }
  for (const [name, value] of Object.entries({scrollWidth: rect.scrollWidth ?? width, scrollHeight: rect.scrollHeight ?? height})) {
    Object.defineProperty(el, name, {configurable: true, get: () => value});
  }
  return el;
}

let observers = null;   // Set of fake ResizeObservers

/** Replaces window.ResizeObserver with a fake that fires only through triggerResize(). */
export function installResizeObserverShim() {
  observers = new Set();
  const live = observers;
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); live.add(this); }
    observe(el) { this.targets.add(el); }
    unobserve(el) { this.targets.delete(el); }
    disconnect() { this.targets.clear(); live.delete(this); }
  }
  const undo = patchGlobal('ResizeObserver', FakeResizeObserver);
  return remember(() => { undo(); observers = null; });
}

/**
 * Fires every fake ResizeObserver watching `el`, with an entry built from its current rect
 * (or from `rect`, which is applied with setRect first). Returns the number of callbacks run.
 */
export function triggerResize(el, rect) {
  if (!observers) throw new Error('triggerResize: call installResizeObserverShim() first');
  if (rect) setRect(el, rect);
  const r = el.getBoundingClientRect();
  const size = [{inlineSize: r.width, blockSize: r.height}];
  const entry = {target: el, contentRect: {x: 0, y: 0, top: 0, left: 0, width: r.width, height: r.height, right: r.width, bottom: r.height},
    borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size};
  let n = 0;
  for (const observer of [...observers]) {
    if (observer.targets.has(el)) { observer.callback([entry], observer); n++; }
  }
  return n;
}

// ---------- matchMedia ----------

let media = null;   // {state, lists: Set}

function evaluateFeature(feature, s) {
  const m = /^\(\s*([a-z-]+)\s*(?::\s*([^)]+?)\s*)?\)$/i.exec(feature.trim());
  if (!m) return false;
  const [, name, rawValue] = m;
  const value = rawValue?.toLowerCase();
  switch (name.toLowerCase()) {
    case 'pointer': case 'any-pointer':
      return value === undefined ? true : value === 'coarse' ? s.coarse : value === 'fine' ? !s.coarse : value === 'none' ? false : false;
    case 'hover': case 'any-hover':
      return value === undefined ? !s.hoverNone : value === 'none' ? s.hoverNone : value === 'hover' ? !s.hoverNone : false;
    case 'prefers-reduced-motion':
      return value === undefined ? s.reducedMotion : value === 'reduce' ? s.reducedMotion : value === 'no-preference' ? !s.reducedMotion : false;
    case 'prefers-color-scheme':
      return value === 'dark' ? s.dark : value === 'light' ? !s.dark : false;
    case 'display-mode':
      return value === (s.standalone ? 'standalone' : 'browser');
    case 'min-width': return s.width >= parseFloat(value);
    case 'max-width': return s.width <= parseFloat(value);
    case 'min-height': return s.height >= parseFloat(value);
    case 'max-height': return s.height <= parseFloat(value);
    case 'orientation': return value === (s.width >= s.height ? 'landscape' : 'portrait');
    default: return false;
  }
}

/** Evaluates a media query list against a media state (used by the matchMedia shim). */
export function evaluateMedia(query, s) {
  return String(query).split(',').some(part => {
    let q = part.trim();
    let negate = false;
    if (/^not\s+/i.test(q)) { negate = true; q = q.replace(/^not\s+/i, ''); }
    q = q.replace(/^(only\s+)?(all|screen)\s*(and\s*)?/i, '');
    const features = q ? q.split(/\s+and\s+/i) : [];
    const result = features.every(f => evaluateFeature(f, s));
    return negate ? !result : result;
  });
}

const MEDIA_DEFAULTS = {coarse: false, hoverNone: false, reducedMotion: false, dark: false, standalone: false, width: 1440, height: 900};

/**
 * Controls window.matchMedia. setMedia({coarse, hoverNone, reducedMotion, dark, standalone, width, height})
 * merges into the current state; live MediaQueryLists fire `change` when their result flips.
 * The first call installs the shim; restoreDomShims() removes it.
 */
export function setMedia(next = {}) {
  if (!media) {
    media = {state: {...MEDIA_DEFAULTS}, lists: new Set()};
    const live = media;
    const matchMedia = query => {
      const listeners = new Set();
      const mql = {
        media: String(query),
        get matches() { return evaluateMedia(query, live.state); },
        onchange: null,
        addEventListener: (type, fn) => { if (type === 'change') listeners.add(fn); },
        removeEventListener: (type, fn) => { if (type === 'change') listeners.delete(fn); },
        addListener: fn => listeners.add(fn),
        removeListener: fn => listeners.delete(fn),
        dispatchEvent: event => { mql.onchange?.(event); listeners.forEach(fn => fn(event)); return true; },
        _last: evaluateMedia(query, live.state),
      };
      live.lists.add(mql);
      return mql;
    };
    const undo = patchGlobal('matchMedia', matchMedia);
    remember(() => { undo(); media = null; });
  }
  Object.assign(media.state, next);
  for (const mql of media.lists) {
    const matches = mql.matches;
    if (matches !== mql._last) {
      mql._last = matches;
      const event = new window.Event('change');
      Object.defineProperty(event, 'matches', {value: matches});
      Object.defineProperty(event, 'media', {value: mql.media});
      mql.dispatchEvent(event);
    }
  }
  return {...media.state};
}

// ---------- document.fonts ----------

/** Installs a document.fonts stub: load() resolves, ready is resolved, check() is true. Records loads. */
export function installFontsStub() {
  const loads = [];
  const fonts = {
    status: 'loaded',
    ready: null,
    loads,
    load: async (font, textSample) => { loads.push(font); return []; },
    check: () => true,
    add() {}, delete() { return true; }, clear() {}, has() { return true; },
    addEventListener() {}, removeEventListener() {},
    [Symbol.iterator]: function* () {},
  };
  fonts.ready = Promise.resolve(fonts);
  const undo = patch(document, 'fonts', {value: fonts, writable: true});
  return remember(undo);
}

// ---------- animation frames ----------

let frames = null;   // {queue: Map(id → fn), next, time}

/** Replaces requestAnimationFrame / cancelAnimationFrame with a queue that flushFrames() runs. */
export function installFrameShim({frameMs = 1000 / 60} = {}) {
  if (frames) return frames.restore;
  const state = {queue: new Map(), next: 1, time: 0, frameMs};
  const raf = fn => { const id = state.next++; state.queue.set(id, fn); return id; };
  const caf = id => { state.queue.delete(id); };
  const undo = [patchGlobal('requestAnimationFrame', raf), patchGlobal('cancelAnimationFrame', caf)];
  state.restore = remember(() => { undo.forEach(fn => fn()); frames = null; });
  frames = state;
  return state.restore;
}

/**
 * Runs `n` animation frames. Each frame runs the callbacks queued before it started (callbacks
 * queued during a frame wait for the next), with a timestamp advancing by frameMs.
 * Installs the frame shim on first use. Returns the number of callbacks run.
 */
export function flushFrames(n = 1) {
  if (!frames) installFrameShim();
  let ran = 0;
  for (let i = 0; i < n; i++) {
    frames.time += frames.frameMs;
    const batch = [...frames.queue.entries()];
    frames.queue.clear();
    for (const [, fn] of batch) { fn(frames.time); ran++; }
  }
  return ran;
}

/** Number of animation-frame callbacks waiting. */
export const pendingFrames = () => (frames ? frames.queue.size : 0);

// ---------- everything ----------

/** Installs every shim (popover, canvas, ResizeObserver, matchMedia, fonts, frames). Returns restoreDomShims. */
export function installDomShims({media: mediaState = {}} = {}) {
  installPopoverShim();
  installCanvasShim();
  installResizeObserverShim();
  setMedia(mediaState);
  installFontsStub();
  installFrameShim();
  return restoreDomShims;
}
