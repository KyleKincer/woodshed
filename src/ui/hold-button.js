// HoldButton (architecture §2.12, spec §4.9 "Leaving while playing"): when `requireHold()` is
// true a press must last `holdMs` while a ring fills around the icon; a shorter tap calls
// `onTapWhileHold(e)` (the caller shows the hint, "Hold to leave — playback will stop"). When
// `requireHold()` is false it is an ordinary button. Keyboard Enter/Space activate at once only
// when `requireHold()` is false; otherwise they give the hint, like a tap (keyboard users Stop
// first, spec §8.4).
//
//   HoldButton({label, icon, holdMs = 600, requireHold: () => boolean, onActivate(e), onTapWhileHold(e),
//               iconOnly, variant, size, …common props}) → {el, set(partial), destroy()}
//
// Leaving the button or cancelling the pointer mid-hold cancels silently. The button carries
// data-holding while a hold runs; the ring (U3's ProgressRing) is decorative (the hint carries the meaning).

import '../styles/primitives/hold-button.css';
import {now} from '../app/clock.js';
import {Button, requireLabel} from './button.js';
import {icon as makeIcon} from './icon.js';
import {ProgressRing} from './progress.js';

/** U3's ProgressRing, decorative (the hint carries the meaning). */
function makeRing(px, label) {
  const r = ProgressRing({value: 0, size: px, label});
  r.el.setAttribute('aria-hidden', 'true');
  return r;
}

export function HoldButton(props = {}) {
  let p = {holdMs: 600, ...props};
  if (p.iconOnly) requireLabel('HoldButton', p.label);
  const ac = new AbortController();
  const wrap = document.createElement('span');
  wrap.className = 'ui-hold-icon';
  wrap.setAttribute('aria-hidden', 'true');
  let iconName = null, iconEl = null;
  const ringPx = () => (p.size === 'lg' || p.size === 'dock' ? 40 : p.size === 'play' ? 48 : 32);
  let ring = makeRing(ringPx(), p.label);
  wrap.append(ring.el);

  let hold = null;         // {timer, raf, start, pointerId}
  let suppress = false;

  const requireHold = () => (typeof p.requireHold === 'function' ? !!p.requireHold() : false);

  const buttonProps = () => {
    const {holdMs, requireHold: _r, onActivate, onTapWhileHold, icon, ...rest} = p;
    return {...rest, icon: null, className: ['ui-hold-button', p.className].filter(Boolean).join(' '), onClick};
  };

  const button = Button(buttonProps());
  const el = button.el;
  el.insertBefore(wrap, el.querySelector('.ui-button-text'));

  function syncIcon() {
    const name = p.icon ?? null;
    if (name === iconName) return;
    iconEl?.remove();
    iconEl = name ? makeIcon(name, {size: p.size === 'play' ? 32 : 24}) : null;
    if (iconEl) wrap.append(iconEl);
    iconName = name;
    wrap.toggleAttribute('data-empty', !iconEl);
  }

  function frame() {
    if (!hold) return;
    ring.set({value: (now() - hold.start) / p.holdMs});
    hold.raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (!hold) return;
    clearTimeout(hold.timer);
    cancelAnimationFrame(hold.raf);
    hold = null;
    el.removeAttribute('data-holding');
    ring.set({value: 0});
  }

  function start(e) {
    stop();
    hold = {start: now(), pointerId: e.pointerId, timer: null, raf: 0};
    el.setAttribute('data-holding', '');
    ring.set({value: 0});
    hold.raf = requestAnimationFrame(frame);
    hold.timer = setTimeout(() => {
      ring.set({value: 1});
      stop();
      suppress = true;
      p.onActivate?.(e);
    }, p.holdMs);
  }

  function onClick(e) {
    if (suppress) { suppress = false; return; }
    if (requireHold()) p.onTapWhileHold?.(e);
    else p.onActivate?.(e);
  }

  const opts = {signal: ac.signal};
  el.addEventListener('pointerdown', e => {
    suppress = false;
    if (!e.isPrimary || e.button !== 0 || el.getAttribute('aria-disabled') === 'true') return;
    if (requireHold()) start(e);
  }, opts);
  el.addEventListener('pointerup', e => {
    if (!hold || e.pointerId !== hold.pointerId) return;
    stop();
    suppress = true;
    p.onTapWhileHold?.(e);
  }, opts);
  // Leaving or a cancelled pointer ends the hold silently; no click follows either, so nothing is swallowed.
  for (const type of ['pointercancel', 'pointerleave']) {
    el.addEventListener(type, e => {
      if (!hold || e.pointerId !== hold.pointerId) return;
      stop();
    }, opts);
  }
  el.addEventListener('keydown', () => { suppress = false; }, opts);
  // A touch hold must not open the platform's context menu or select text.
  el.addEventListener('contextmenu', e => { if (hold || requireHold()) e.preventDefault(); }, opts);

  syncIcon();

  return {
    el,
    set(partial = {}) {
      const resize = 'size' in partial && partial.size !== p.size;
      p = {...p, ...partial};
      if (p.iconOnly) requireLabel('HoldButton', p.label);
      button.set(buttonProps());
      if (resize) {
        const next = makeRing(ringPx(), p.label);
        ring.el.replaceWith(next.el);
        ring.destroy();
        ring = next;
        iconName = undefined;
      }
      syncIcon();
    },
    destroy() {
      stop();
      ac.abort();
      ring.destroy();
      button.destroy();
    },
  };
}
