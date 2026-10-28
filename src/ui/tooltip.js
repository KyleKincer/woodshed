// tooltip(el, {text, kbd}) → off (architecture §2.12, spec §8.7–8.8).
//
//   const off = tooltip(button, {text: 'Loop', kbd: 'KeyL'})
//     text   a string, or a function returning one (read each time the tooltip shows)
//     kbd    an optional KeyString (or function returning one): drawn as a Kbd after the text
//   off()            removes every listener and any visible tooltip
//   off.set({text, kbd})   updates the content (a visible tooltip updates in place)
//
// Shows on hover (mouse and pen, never touch) and on keyboard focus, after 400 ms.
// While another tooltip is up (or was within the last 300 ms) the next one shows at
// once. Hides on leave, blur, pointerdown, Escape, scroll and resize. One tooltip is
// visible at a time. The tooltip is role=tooltip and, while visible, describes `el`
// through aria-describedby (unless its text only repeats el's accessible name).
// It is never the only carrier of information: icon-only controls also have an
// aria-label and aria-keyshortcuts, and touch users never see tooltips.
// Rendered in the top layer (popover=manual) when the Popover API exists, else
// position: fixed on --z-toast.

import '../styles/primitives/tooltip.css';
import {Kbd} from './kbd.js';

export const TOOLTIP_DELAY_MS = 400;
export const TOOLTIP_WARM_MS = 300;
const GAP = 8;      // px between the anchor and the tooltip
const MARGIN = 8;   // px kept from the viewport edges

let seq = 0;
let visible = null;     // the tooltip controller currently shown
let warm = false;
let warmTimer = null;

const read = v => (typeof v === 'function' ? v() : v);

function setWarm() {
  warm = true;
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => { warm = false; warmTimer = null; }, TOOLTIP_WARM_MS);
}

function keyboardFocused(el) {
  try { return el.matches(':focus-visible'); } catch { return true; }
}

const supportsPopover = node => typeof node.showPopover === 'function';

/**
 * Pure placement: above the anchor, centred and clamped to the viewport; below when
 * there is no room above. Returns {left, top, placement}.
 */
export function placeTooltip(anchor, size, viewport, {gap = GAP, margin = MARGIN} = {}) {
  const above = anchor.top - gap - size.height;
  const below = anchor.bottom + gap;
  let placement = 'top';
  let top = above;
  if (above < margin && below + size.height <= viewport.height - margin) { placement = 'bottom'; top = below; }
  top = Math.max(margin, Math.min(top, viewport.height - margin - size.height));
  const centre = anchor.left + anchor.width / 2;
  const left = Math.max(margin, Math.min(centre - size.width / 2, viewport.width - margin - size.width));
  return {left: Math.round(left), top: Math.round(top), placement};
}

function accessibleName(el) {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ');
}

export function tooltip(el, options = {}) {
  if (!el || typeof el.addEventListener !== 'function') throw new TypeError('tooltip: el must be an Element');
  let opts = {...options};
  let timer = null;
  let node = null;
  let kbd = null;
  let textNode = null;
  const id = `ui-tooltip-${++seq}`;
  let described = false;
  const ctl = {hide};

  function content() {
    const text = String(read(opts.text) ?? '');
    const keys = read(opts.kbd) || null;
    return {text, keys};
  }

  function fill() {
    const {text, keys} = content();
    textNode.textContent = text;
    if (keys) {
      if (kbd) kbd.set({keys});
      else { kbd = Kbd({keys, className: 'ui-tooltip-kbd'}); node.append(kbd.el); }
    } else if (kbd) {
      kbd.destroy();
      kbd = null;
    }
    const describe = text && text !== accessibleName(el);
    if (describe && !described) {
      const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      el.setAttribute('aria-describedby', [...ids, id].join(' '));
      described = true;
    } else if (!describe && described) {
      undescribe();
    }
    return text || keys;
  }

  function undescribe() {
    if (!described) return;
    const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(x => x && x !== id);
    if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
    else el.removeAttribute('aria-describedby');
    described = false;
  }

  function position() {
    if (!node) return;
    const a = el.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const view = {width: document.documentElement.clientWidth || globalThis.innerWidth || 0, height: document.documentElement.clientHeight || globalThis.innerHeight || 0};
    const {left, top, placement} = placeTooltip(a, {width: r.width, height: r.height}, view);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.dataset.placement = placement;
  }

  function show() {
    clearTimeout(timer);
    timer = null;
    if (!el.isConnected) return;
    if (visible && visible !== ctl) visible.hide();
    if (!node) {
      node = document.createElement('div');
      node.className = 'ui-tooltip';
      node.id = id;
      node.setAttribute('role', 'tooltip');
      textNode = document.createElement('span');
      textNode.className = 'ui-tooltip-text';
      node.append(textNode);
    }
    if (!fill()) { hide(); return; }
    const host = supportsPopover(node) ? document.body : (el.closest('dialog') ?? document.body);
    if (node.parentNode !== host) host.append(node);
    if (supportsPopover(node)) {
      node.setAttribute('popover', 'manual');
      try { if (!node.matches(':popover-open')) node.showPopover(); } catch { /* not connected or already open */ }
    }
    position();
    node.dataset.open = '';
    visible = ctl;
    globalThis.addEventListener?.('scroll', hide, {capture: true, passive: true});
    globalThis.addEventListener?.('resize', hide, {passive: true});
  }

  function hide() {
    clearTimeout(timer);
    timer = null;
    if (!node) return;
    globalThis.removeEventListener?.('scroll', hide, {capture: true});
    globalThis.removeEventListener?.('resize', hide);
    if (node.isConnected) {
      if (visible === ctl) setWarm();
      try { if (node.hasAttribute('popover') && node.matches(':popover-open')) node.hidePopover(); } catch { /* already closed */ }
      node.remove();
    }
    delete node.dataset.open;
    undescribe();
    if (visible === ctl) visible = null;
  }

  function schedule() {
    if (node?.isConnected) return;
    clearTimeout(timer);
    if (visible || warm) { show(); return; }
    timer = setTimeout(show, TOOLTIP_DELAY_MS);
  }

  const onEnter = e => { if (e.pointerType !== 'touch') schedule(); };
  const onLeave = e => {
    if (e.pointerType === 'touch') return;
    // Keyboard focus inside keeps it up; a hover-only tooltip goes.
    const active = document.activeElement;
    if (active && el.contains(active) && keyboardFocused(active)) return;
    hide();
  };
  const onFocus = () => { if (keyboardFocused(el)) schedule(); };
  const onBlur = e => { if (!el.contains(e.relatedTarget)) hide(); };
  const onDown = () => hide();
  const onKey = e => { if (e.key === 'Escape' && node?.isConnected) hide(); };

  el.addEventListener('pointerenter', onEnter);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('focusin', onFocus);
  el.addEventListener('focusout', onBlur);
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('keydown', onKey);

  function off() {
    hide();
    kbd?.destroy();
    kbd = null;
    el.removeEventListener('pointerenter', onEnter);
    el.removeEventListener('pointerleave', onLeave);
    el.removeEventListener('focusin', onFocus);
    el.removeEventListener('focusout', onBlur);
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('keydown', onKey);
  }
  off.set = (partial = {}) => {
    opts = {...opts, ...partial};
    if (node?.isConnected) { if (fill()) position(); else hide(); }
  };
  off.show = show;
  off.hide = hide;
  return off;
}
