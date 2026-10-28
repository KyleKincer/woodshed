// Slider (architecture §2.12, spec §7.1 and §8.8): a custom role=slider element, not
// input[type=range]. When focused it consumes the arrow keys and Home/End only
// (data-consume-keys); Space, digits, letters and PageUp/PageDown always reach the registry, so a
// focused slider can never swallow Play. Shift+arrow moves ten steps. Pointer drags use pointer
// capture: onInput(v) while moving, onChange(v) on release; a key step calls both.
//
//   Slider({value, min = 0, max = 1, step = 0.01, format(v), onInput(v), onChange(v), label,
//           showValue = true, orientation = 'horizontal' | 'vertical', disabled, pointer = true,
//           …common props}) → {el, control, value, dragging, set(partial), destroy()}
//
// `pointer: false` leaves pointer gestures to a host (Fader's pad mode drags inside StemPad).
// `el` is the wrapper (control plus the shown value); `control` is the role=slider element.
// The position is exposed to CSS as --ui-slider-pos (0…1) on the wrapper.

import '../styles/primitives/slider.css';
import {applyCommon, requireLabel, setAttr, setText} from './button.js';
import {snapValue} from './stepper.js';

export const SLIDER_KEYS = 'ArrowLeft ArrowRight ArrowUp ArrowDown Home End';

/** The value at a client point inside `rect` (pure; layout is the caller's). */
export function valueAtPoint({x, y}, rect, {min = 0, max = 1, step = 0, orientation = 'horizontal'} = {}) {
  const span = orientation === 'vertical' ? rect.height : rect.width;
  if (!(span > 0)) return null;
  const frac = orientation === 'vertical' ? (rect.top + rect.height - y) / span : (x - rect.left) / span;
  return snapValue(min + Math.min(1, Math.max(0, frac)) * (max - min), {min, max, step});
}

export function Slider(props = {}) {
  let p = {min: 0, max: 1, step: 0.01, showValue: true, orientation: 'horizontal', pointer: true, ...props};
  const ac = new AbortController();
  const opts = {signal: ac.signal};
  const el = document.createElement('div');
  el.className = 'ui-slider';
  const control = document.createElement('div');
  control.className = 'ui-slider-control';
  control.setAttribute('role', 'slider');
  control.tabIndex = 0;
  control.setAttribute('data-consume-keys', SLIDER_KEYS);
  const track = document.createElement('div');
  track.className = 'ui-slider-track';
  const fill = document.createElement('div');
  fill.className = 'ui-slider-fill';
  const thumb = document.createElement('div');
  thumb.className = 'ui-slider-thumb';
  track.append(fill);
  control.append(track, thumb);
  const out = document.createElement('span');
  out.className = 'ui-slider-value';
  out.setAttribute('aria-hidden', 'true');
  el.append(control, out);

  let value = clamp(p.value ?? p.min);
  let drag = null;   // {pointerId}
  let prevCommon = {};

  function clamp(v) { return snapValue(v, p); }
  const text = v => (typeof p.format === 'function' ? String(p.format(v)) : String(v));
  const disabled = () => !!p.disabled;

  function render() {
    applyCommon(el, p, prevCommon);
    prevCommon = {className: p.className, id: p.id, attrs: p.attrs, dataset: p.dataset, testid: p.testid};
    requireLabel('Slider', p.label);
    const vertical = p.orientation === 'vertical';
    setAttr(el, 'data-orientation', vertical ? 'vertical' : 'horizontal');
    setAttr(control, 'aria-label', p.label);
    setAttr(control, 'aria-orientation', vertical ? 'vertical' : 'horizontal');
    setAttr(control, 'aria-valuemin', p.min);
    setAttr(control, 'aria-valuemax', p.max);
    setAttr(control, 'aria-valuenow', value);
    setAttr(control, 'aria-valuetext', text(value));
    setAttr(control, 'aria-disabled', disabled() ? 'true' : null);
    const span = p.max - p.min;
    el.style.setProperty('--ui-slider-pos', String(span > 0 ? (value - p.min) / span : 0));
    out.hidden = !p.showValue;
    setText(out, p.showValue ? text(value) : '');
  }

  function apply(next) {
    const v = clamp(next);
    if (v === value) return false;
    value = v;
    render();
    return true;
  }

  function fromEvent(e) {
    return valueAtPoint({x: e.clientX, y: e.clientY}, control.getBoundingClientRect(), p);
  }

  control.addEventListener('pointerdown', e => {
    if (disabled() || p.pointer === false || !e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    control.focus({preventScroll: true});
    drag = {pointerId: e.pointerId};
    control.setPointerCapture?.(e.pointerId);
    el.setAttribute('data-dragging', '');
    const v = fromEvent(e);
    if (v != null && apply(v)) p.onInput?.(value);
  }, opts);
  control.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const v = fromEvent(e);
    if (v != null && apply(v)) p.onInput?.(value);
  }, opts);
  const end = e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
    el.removeAttribute('data-dragging');
    control.releasePointerCapture?.(e.pointerId);
    p.onChange?.(value);
  };
  control.addEventListener('pointerup', end, opts);
  control.addEventListener('pointercancel', end, opts);
  control.addEventListener('lostpointercapture', end, opts);

  control.addEventListener('keydown', e => {
    if (disabled() || e.ctrlKey || e.metaKey || e.altKey) return;
    const steps = e.shiftKey ? 10 : 1;
    const unit = p.step > 0 ? p.step : (p.max - p.min) / 100;
    let next;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp': next = value + unit * steps; break;
      case 'ArrowLeft': case 'ArrowDown': next = value - unit * steps; break;
      case 'Home': next = p.min; break;
      case 'End': next = p.max; break;
      default: return;
    }
    e.preventDefault();
    if (apply(next)) {
      p.onInput?.(value);
      p.onChange?.(value);
    }
  }, opts);

  render();

  return {
    el,
    control,
    get value() { return value; },
    get dragging() { return !!drag; },
    set(partial = {}) {
      p = {...p, ...partial};
      if ('value' in partial && !drag) value = clamp(partial.value);
      else if ('min' in partial || 'max' in partial || 'step' in partial) value = clamp(value);
      render();
    },
    destroy() {
      ac.abort();
      drag = null;
      el.remove();
    },
  };
}
