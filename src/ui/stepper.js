// Stepper (architecture §2.12, spec §4.6 and §8.8): `[ − | 75% | + ]`. The value is a
// role=spinbutton that consumes ArrowUp/Down/Left/Right, PageUp/PageDown and Home/End when focused
// (data-consume-keys); Space, Enter, digits and letters always reach the registry. Holding − or +
// repeats after 400 ms, then every 80 ms (`holdRepeat`). Tapping the value calls onValueClick
// (the Speed value opens its sheet); a 500 ms long-press calls onValueLongPress (100% ↔ last).
//
//   Stepper({value, min = 0, max = 100, step = 1, bigStep = step * 10, format(v), onChange(v, {source}),
//            onValueClick(e), onValueLongPress(e), label, decLabel, incLabel, holdRepeat = true, size,
//            …common props}) → {el, value, set(partial), destroy()}
//
// `source` is 'pointer' (a tap on − or +), 'repeat' (each held repeat), 'key' (keyboard on the
// value) or 'program'. Values are clamped to [min, max] and snapped to `step` from `min`; the
// buttons are aria-disabled at the ends. The − and + buttons stay out of the tab order (the
// spinbutton is the keyboard control) but keep their names for pointer and screen-reader users.

import '../styles/primitives/stepper.css';
import {applyCommon, requireLabel, setAttr, setText, trackPress} from './button.js';
import {hasIcon, icon as makeIcon} from './icon.js';

export const REPEAT_DELAY_MS = 400;
export const REPEAT_EVERY_MS = 80;
const CONSUMED = 'ArrowUp ArrowDown ArrowLeft ArrowRight PageUp PageDown Home End';

/** Clamps to [min, max] and snaps to the step grid from min (float-safe). */
export function snapValue(v, {min = -Infinity, max = Infinity, step = 0} = {}) {
  let x = Math.min(max, Math.max(min, Number(v)));
  if (!Number.isFinite(x)) x = Number.isFinite(min) ? min : 0;
  if (step > 0) {
    const base = Number.isFinite(min) ? min : 0;
    const decimals = Math.max(0, ...[step, base].map(n => (String(n).split('.')[1] ?? '').length));
    x = Number((base + Math.round((x - base) / step) * step).toFixed(decimals));
    x = Math.min(max, Math.max(min, x));
  }
  return x;
}

export function Stepper(props = {}) {
  let p = {min: 0, max: 100, step: 1, holdRepeat: true, size: 'md', ...props};
  requireLabel('Stepper', p.label);
  const ac = new AbortController();
  const opts = {signal: ac.signal};
  const el = document.createElement('div');
  el.className = 'ui-stepper';
  el.setAttribute('role', 'group');

  const makeButton = (cls, iconName) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ui-stepper-button ${cls}`;
    b.tabIndex = -1;
    b.append(makeIcon(iconName, {size: 20}));
    return b;
  };
  // − and + (Lucide 'minus' and 'plus'); a sprite without 'minus' uses the chevron pair.
  const signs = hasIcon('minus') ? ['minus', 'plus'] : ['chevron-down', 'chevron-up'];
  const dec = makeButton('ui-stepper-dec', signs[0]);
  const inc = makeButton('ui-stepper-inc', signs[1]);
  const valueEl = document.createElement('div');
  valueEl.className = 'ui-stepper-value';
  valueEl.setAttribute('role', 'spinbutton');
  valueEl.tabIndex = 0;
  valueEl.setAttribute('data-consume-keys', CONSUMED);
  el.append(dec, valueEl, inc);

  let value = clamp(p.value ?? p.min);
  let prevCommon = {};
  let repeat = null;   // {delay, interval, dir, pointerId}
  let swallowClick = new WeakSet();

  function clamp(v) { return snapValue(v, p); }
  const bigStep = () => (Number(p.bigStep) > 0 ? Number(p.bigStep) : p.step * 10);
  const formatted = v => (typeof p.format === 'function' ? String(p.format(v)) : String(v));

  function commit(next, source) {
    const v = clamp(next);
    if (v === value) return false;
    value = v;
    render();
    p.onChange?.(v, {source});
    return true;
  }

  function stepBy(dir, source) {
    return commit(value + dir * p.step, source);
  }

  function render() {
    applyCommon(el, p, prevCommon);
    prevCommon = {className: p.className, id: p.id, attrs: p.attrs, dataset: p.dataset, testid: p.testid};
    setAttr(el, 'data-size', p.size ?? 'md');
    setAttr(valueEl, 'aria-label', p.label);
    setAttr(valueEl, 'aria-valuenow', value);
    setAttr(valueEl, 'aria-valuemin', Number.isFinite(p.min) ? p.min : null);
    setAttr(valueEl, 'aria-valuemax', Number.isFinite(p.max) ? p.max : null);
    const text = formatted(value);
    setAttr(valueEl, 'aria-valuetext', text);
    setAttr(valueEl, 'data-clickable', typeof p.onValueClick === 'function');
    setText(valueEl, text);
    setAttr(dec, 'aria-label', p.decLabel ?? `Decrease ${p.label}`);
    setAttr(inc, 'aria-label', p.incLabel ?? `Increase ${p.label}`);
    setAttr(dec, 'aria-disabled', value <= p.min ? 'true' : null);
    setAttr(inc, 'aria-disabled', value >= p.max ? 'true' : null);
  }

  // ---- − / + with hold-to-repeat
  function stopRepeat() {
    if (!repeat) return;
    clearTimeout(repeat.delay);
    clearInterval(repeat.interval);
    repeat = null;
  }

  for (const [button, dir] of [[dec, -1], [inc, 1]]) {
    button.addEventListener('pointerdown', e => {
      if (!e.isPrimary || e.button !== 0) return;
      stopRepeat();
      // Captured, so the click that ends this press lands here and is swallowed (the press stepped).
      button.setPointerCapture?.(e.pointerId);
      swallowClick.add(button);
      if (!stepBy(dir, 'pointer')) return;
      if (!p.holdRepeat) return;
      repeat = {dir, pointerId: e.pointerId, interval: null, delay: setTimeout(() => {
        if (!repeat) return;
        repeat.interval = setInterval(() => { if (!stepBy(dir, 'repeat')) stopRepeat(); }, REPEAT_EVERY_MS);
      }, REPEAT_DELAY_MS)};
    }, opts);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(type, e => { if (repeat && e.pointerId === repeat.pointerId) stopRepeat(); }, opts);
    }
    // Keyboard and assistive-technology activation (no pointerdown before it) steps once.
    button.addEventListener('click', e => {
      if (swallowClick.has(button)) { swallowClick.delete(button); return; }
      stepBy(dir, 'pointer');
    }, opts);
    button.addEventListener('contextmenu', e => e.preventDefault(), opts);
  }

  // ---- the value: keys, tap, long-press
  valueEl.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let next = null;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': next = value + p.step; break;
      case 'ArrowDown': case 'ArrowLeft': next = value - p.step; break;
      case 'PageUp': next = value + bigStep(); break;
      case 'PageDown': next = value - bigStep(); break;
      case 'Home': if (Number.isFinite(p.min)) next = p.min; break;
      case 'End': if (Number.isFinite(p.max)) next = p.max; break;
      default: return;
    }
    if (next == null) return;
    e.preventDefault();
    commit(next, 'key');
  }, opts);

  const press = trackPress(valueEl, {signal: ac.signal, ms: 500, onLongPress: null});
  const syncPress = () => { press.onLongPress = typeof p.onValueLongPress === 'function' ? e => p.onValueLongPress(e) : null; };
  valueEl.addEventListener('click', e => {
    if (press.consumeClick()) return;
    p.onValueClick?.(e);
  }, opts);

  syncPress();
  render();

  return {
    el,
    get value() { return value; },
    set(partial = {}) {
      p = {...p, ...partial};
      if ('label' in partial) requireLabel('Stepper', p.label);
      if ('value' in partial) value = clamp(partial.value);
      else if ('min' in partial || 'max' in partial || 'step' in partial) value = clamp(value);
      syncPress();
      render();
    },
    destroy() {
      stopRepeat();
      press.cancel();
      ac.abort();
      swallowClick = new WeakSet();
      el.remove();
    },
  };
}
