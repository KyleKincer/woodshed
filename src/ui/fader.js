// Fader (architecture §2.12, spec §4.4D and §4.7): a Slider for levels, with a reset.
//
//   Fader({…Slider props, resetValue = 1, variant = 'inline' | 'pad', host}) → {el, control, value, set, reset(), destroy()}
//
// inline  a horizontal level slider (the Stems header's 120 px fader with its % value). A double
//         click or double tap resets it to `resetValue` (onInput and onChange both report it).
// pad     the level of a StemPad. A vertical drag anywhere inside `host` (the pad) changes the
//         level relative to where it started (a full host height is the whole range), so touching
//         a pad never jumps its level; `el` is the pad's role=slider strip (keyboard: arrows,
//         Home/End) showing the value. The host's owner recognises taps and calls reset() on its
//         double tap (StemPad: tap mutes, double tap = 100%). The level is exposed on the host as
//         --ui-fader-level (0…1) for the pad's fill.
// Default format: a whole percentage of the value (1 → "100%").

import '../styles/primitives/fader.css';
import {now} from '../app/clock.js';
import {Slider} from './slider.js';

export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP = 24;
/** Movement (px) before a press on a pad becomes a level drag. */
export const DRAG_SLOP = 8;

export const percent = v => `${Math.round(v * 100)}%`;

export function Fader(props = {}) {
  let p = {min: 0, max: 1, step: 0.01, resetValue: 1, variant: 'inline', format: percent, ...props};
  const ac = new AbortController();
  const opts = {signal: ac.signal};
  const pad = () => p.variant === 'pad';

  // The value goes to the slider only when given (at creation, or in set): the slider owns it after that.
  const sliderProps = (withValue = false) => {
    const {resetValue, variant, host, value, ...rest} = p;
    return {
      ...(withValue ? {value} : {}),
      ...rest,
      className: ['ui-fader', p.className].filter(Boolean).join(' '),
      dataset: {...p.dataset, variant: pad() ? 'pad' : 'inline'},
      orientation: pad() ? 'vertical' : p.orientation ?? 'horizontal',
      pointer: !pad(),
      onInput: v => { syncHost(); p.onInput?.(v); },
      onChange: v => { syncHost(); p.onChange?.(v); },
    };
  };
  const slider = Slider(sliderProps(true));

  function syncHost() {
    if (!pad() || !p.host) return;
    const span = p.max - p.min;
    p.host.style.setProperty('--ui-fader-level', String(span > 0 ? (slider.value - p.min) / span : 0));
  }

  function setLevel(v, {commit}) {
    const before = slider.value;
    slider.set({value: v});
    syncHost();
    if (slider.value !== before) p.onInput?.(slider.value);
    if (commit) p.onChange?.(slider.value);
  }

  function reset() {
    if (p.disabled) return;
    setLevel(p.resetValue, {commit: true});
  }

  // ---- inline: double click / double tap resets
  let lastTap = null;   // {at, x, y}
  let downAt = null;
  slider.control.addEventListener('pointerdown', e => {
    if (pad() || !e.isPrimary) return;
    downAt = {x: e.clientX, y: e.clientY};
  }, opts);
  slider.control.addEventListener('pointerup', e => {
    if (pad() || !e.isPrimary || !downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > DRAG_SLOP;
    downAt = null;
    if (moved) { lastTap = null; return; }
    const t = now();
    if (lastTap && t - lastTap.at <= DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) <= DOUBLE_TAP_SLOP) {
      lastTap = null;
      reset();
    } else {
      lastTap = {at: t, x: e.clientX, y: e.clientY};
    }
  }, opts);

  // ---- pad: a vertical drag inside the host
  let drag = null;   // {pointerId, x, y, value, active, height}
  let boundHost = null;
  let hostAc = null;
  function bindHost() {
    const host = pad() ? p.host ?? null : null;
    if (host === boundHost) return;
    hostAc?.abort();
    boundHost = host;
    hostAc = null;
    if (!host) return;
    hostAc = new AbortController();
    const hopts = {signal: hostAc.signal};
    host.classList.add('ui-fader-host');
    host.addEventListener('pointerdown', e => {
      if (p.disabled || !e.isPrimary || e.button !== 0) return;
      drag = {pointerId: e.pointerId, x: e.clientX, y: e.clientY, value: slider.value, active: false, height: host.getBoundingClientRect().height};
    }, hopts);
    host.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.x, dy = drag.y - e.clientY;
      if (!drag.active) {
        if (Math.abs(dy) <= DRAG_SLOP || Math.abs(dy) < Math.abs(dx)) return;
        if (!(drag.height > 0)) { drag = null; return; }
        drag.active = true;
        host.setPointerCapture?.(e.pointerId);
        host.setAttribute('data-level-drag', '');
      }
      setLevel(drag.value + (dy / drag.height) * (p.max - p.min), {commit: false});
    }, hopts);
    // pointerup commits a level drag; pointercancel puts back the level from before it.
    const end = (e, commit) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const {active, value} = drag;
      drag = null;
      host.removeAttribute('data-level-drag');
      if (!active) return;
      if (commit) p.onChange?.(slider.value);
      else setLevel(value, {commit: false});
    };
    host.addEventListener('pointerup', e => end(e, true), hopts);
    host.addEventListener('pointercancel', e => end(e, false), hopts);
  }

  bindHost();
  syncHost();

  return {
    el: slider.el,
    control: slider.control,
    get value() { return slider.value; },
    /** True while a pad drag (past DRAG_SLOP) is changing the level. */
    get dragging() { return !!drag?.active || slider.dragging; },
    set(partial = {}) {
      if (p.host && 'host' in partial && partial.host !== p.host) p.host.classList.remove('ui-fader-host');
      p = {...p, ...partial};
      slider.set(sliderProps('value' in partial));
      bindHost();
      syncHost();
    },
    reset,
    destroy() {
      hostAc?.abort();
      ac.abort();
      slider.destroy();
    },
  };
}
