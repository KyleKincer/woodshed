// Button and IconButton (architecture §2.12, spec §8.8), plus the plumbing every src/ui primitive
// shares (common props, attribute patching, labels, long-press, and U3's tooltips and key-caps).
//
//   Button({label, icon, iconEnd, variant, size, command, onClick, onLongPress, longPressMs = 500,
//           disabled, disabledReason, busy, pressed, kbd, title, sublabel, type = 'button', tone, registry,
//           …common props}) → {el, set(partial), destroy()}
//   IconButton({label, icon, variant, size, command, onClick, pressed, …}) → {el, set, destroy}
//
// variant: primary | secondary (default) | quiet | danger; size: sm | md (default) | lg | dock | play.
// With `command`, the label, icon and tooltip text default from the registry (`title`, `icon`);
// `aria-keyshortcuts` and the tooltip key-cap come from `keys[0]`; a click runs the command with
// source 'pointer'; `disabled`, the visible disabled reason and `aria-pressed` follow the command's
// `when`, `disabledReason` and `checked` live, through `registry.onChange`. `registry` defaults to
// the app registry (tests and harnesses pass an isolated one).
// A disabled button stays focusable (`aria-disabled`, so the reason is reachable) and ignores
// activation. `disabledReason` renders as visible text inside the button, outside its name, linked
// with `aria-describedby`. `busy` (true | 'Saving…' | {label, percent}) shows a spinner and the
// busy text with `aria-busy`; it replaces withButtonProgress and does not block clicks (Play arms
// "Play when ready" while loading), so pass `disabled` too when a second press must not run.
// `kbd` shows a visible key-cap: a KeyString, or true for the command's keys[0].
// `onLongPress(e)` fires after `longPressMs` held without moving; the click that follows is dropped.
// Dock and play sizes put the icon above a 13/600 label. `tone` is passed through as data-tone.
// IconButton is Button with `iconOnly`: `label` becomes aria-label and the tooltip text.

import '../styles/primitives/button.css';
import {registry as appRegistry} from '../app/commands.js';
import {aria as ariaKeys} from '../app/keys.js';
import {icon as makeIcon} from './icon.js';
import {Kbd} from './kbd.js';
import {tooltip} from './tooltip.js';

// ---------------------------------------------------------------------------------------------
// Shared primitive plumbing (used by every module in src/ui; not part of the public contract).

/** True in development builds and tests (Vite's import.meta.env.DEV). */
export function isDev() {
  return !!import.meta.env?.DEV;
}

let nextId = 1;
/** A document-unique id for aria links. */
export function uid(prefix = 'ui') {
  return `${prefix}-${nextId++}`;
}

/** Sets or removes an attribute, touching the DOM only when the value changes. true → "", null/false/undefined → absent. */
export function setAttr(el, name, value) {
  if (value == null || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  const v = value === true ? '' : String(value);
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

/** Sets textContent only when it changes. */
export function setText(el, value) {
  const v = value == null ? '' : String(value);
  if (el.textContent !== v) el.textContent = v;
}

/** dataset key → attribute name ('focusKey' → 'data-focus-key'). */
const dataAttr = key => `data-${String(key).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;

const classList = value => (Array.isArray(value) ? value.flat(Infinity) : String(value ?? '').split(/\s+/)).filter(Boolean);

/**
 * Applies the common props (className, id, attrs, dataset, testid) to a primitive's root, undoing
 * what `prev` applied and `next` no longer has.
 */
export function applyCommon(el, next = {}, prev = {}) {
  if (next.className !== prev.className) {
    for (const c of classList(prev.className)) el.classList.remove(c);
    for (const c of classList(next.className)) el.classList.add(c);
  }
  if (next.id !== prev.id) setAttr(el, 'id', next.id);
  if (next.testid !== prev.testid) setAttr(el, 'data-testid', next.testid);
  if (next.attrs !== prev.attrs) {
    for (const k of Object.keys(prev.attrs ?? {})) if (!(k in (next.attrs ?? {}))) el.removeAttribute(k);
    for (const [k, v] of Object.entries(next.attrs ?? {})) setAttr(el, k, v);
  }
  if (next.dataset !== prev.dataset) {
    for (const k of Object.keys(prev.dataset ?? {})) if (!(k in (next.dataset ?? {}))) el.removeAttribute(dataAttr(k));
    for (const [k, v] of Object.entries(next.dataset ?? {})) setAttr(el, dataAttr(k), v);
  }
}

/** Throws in development when an icon-only control has no accessible name. */
export function requireLabel(who, label) {
  if (isDev() && !(typeof label === 'string' && label.trim())) {
    throw new TypeError(`${who}: needs a label (its accessible name); icon-only controls are never unnamed.`);
  }
}

const hasLabel = value => typeof value === 'string' && value.trim() !== '';

/** U3's tooltip on hover and focus with an optional key-cap. Returns `off`. */
export function attachTooltip(el, {text, kbd}) {
  if (!hasLabel(text) && !kbd) return () => {};
  return tooltip(el, {text, kbd}) ?? (() => {});
}

/** U3's Kbd key-cap ({el, set({keys}), destroy()}), decorative (the control carries aria-keyshortcuts). */
export function keyCap(keys, {className = ''} = {}) {
  const k = Kbd({keys});
  if (className) k.el.classList.add(...classList(className));
  k.el.setAttribute('aria-hidden', 'true');
  return k;
}

/**
 * Press tracking on one element: long-press (held `ms` within `slop` px) and dropping the click
 * that follows a gesture the primitive already handled. `onLongPress` may be swapped at any time
 * through `tracker.onLongPress`. Listeners are removed with `signal`.
 *   tracker.consumeClick() → true once after a handled gesture (the caller then ignores the click)
 *   tracker.suppressClick() marks the next click as handled
 */
export function trackPress(el, {signal, ms = 500, slop = 10, onLongPress = null} = {}) {
  let timer = null, start = null, fired = false, suppress = false;
  const tracker = {
    onLongPress, ms,
    consumeClick() { const s = suppress; suppress = false; return s; },
    suppressClick() { suppress = true; },
    cancel() { clearTimeout(timer); timer = null; start = null; },
    get pressing() { return !!start; },
  };
  const opts = {signal};
  el.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0) return;
    suppress = false;
    fired = false;
    tracker.cancel();
    if (typeof tracker.onLongPress !== 'function') return;
    start = {x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType};
    timer = setTimeout(() => {
      timer = null;
      if (!start) return;
      fired = true;
      suppress = true;
      tracker.onLongPress(e);
    }, tracker.ms);
  }, opts);
  el.addEventListener('pointermove', e => {
    if (!start || e.pointerId !== start.id) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > slop) tracker.cancel();
  }, opts);
  for (const type of ['pointerup', 'pointercancel']) {
    el.addEventListener(type, e => { if (start && e.pointerId === start.id) tracker.cancel(); }, opts);
  }
  // A key press is never the click a pointer gesture left behind (released off the element).
  el.addEventListener('keydown', () => { suppress = false; }, opts);
  // A touch long-press raises contextmenu on some platforms; the long-press owns it.
  el.addEventListener('contextmenu', e => {
    if (typeof tracker.onLongPress === 'function' && (fired || (start && start.type !== 'mouse'))) e.preventDefault();
  }, opts);
  return tracker;
}

/** A slot child: creates, replaces or removes `current` inside `parent` before `before`. Returns the new node. */
export function slot(parent, current, next, before = null) {
  if (current === next) return current;
  if (current && next) current.replaceWith(next);
  else if (current) current.remove();
  else if (next) parent.insertBefore(next, before && before.parentNode === parent ? before : null);
  return next ?? null;
}

const span = cls => {
  const el = document.createElement('span');
  el.className = cls;
  return el;
};

// ---------------------------------------------------------------------------------------------
// Button

export const VARIANTS = Object.freeze(['primary', 'secondary', 'quiet', 'danger']);
export const SIZES = Object.freeze(['sm', 'md', 'lg', 'dock', 'play']);
const ICON_PX = {sm: 20, md: 20, lg: 24, dock: 24, play: 32};

function busyText(busy, label) {
  if (typeof busy === 'string') return busy;
  if (busy && typeof busy === 'object') {
    const text = busy.label ?? label;
    return Number.isFinite(busy.percent) ? `${text} ${Math.round(busy.percent)}%` : text;
  }
  return label;
}

export function Button(props = {}) {
  let p = {variant: 'secondary', size: 'md', type: 'button', longPressMs: 500, ...props};
  const el = document.createElement('button');
  el.className = 'ui-button';
  const ac = new AbortController();
  const parts = {spinner: null, icon: null, iconName: null, iconPx: null, text: span('ui-button-text'), label: span('ui-button-label'),
    sublabel: null, iconEnd: null, iconEndName: null, kbd: null, reason: null};
  parts.text.append(parts.label);
  el.append(parts.text);
  const reasonId = uid('ui-reason');
  let prevCommon = {};
  let tooltipOff = () => {};
  let tooltipKey = null;
  let unsubscribe = null, subscribedTo = null;
  let current = {disabled: false};

  const registryOf = () => p.registry ?? appRegistry;

  function derive() {
    const reg = registryOf();
    const def = p.command ? reg.get(p.command) : null;
    const s = p.command ? reg.state(p.command) : null;
    const label = p.label ?? s?.title ?? '';
    const key = def?.keys?.[0] ?? (typeof p.kbd === 'string' ? p.kbd : null);
    const shownKbd = p.kbd === true ? key : typeof p.kbd === 'string' ? p.kbd : null;
    const reason = (p.disabledReason !== undefined ? p.disabledReason : s?.reason) || null;
    const disabled = !!p.disabled || !!reason || (p.command ? !s?.enabled : false);
    const pressed = p.pressed !== undefined ? p.pressed : def?.checked ? !!s?.checked : undefined;
    const tip = p.title ?? (p.command ? s?.title : null) ?? (p.iconOnly ? label : null);
    return {label, icon: p.icon ?? def?.icon ?? null, key, shownKbd, reason, disabled, pressed, tip};
  }

  function subscribe() {
    const reg = p.command ? registryOf() : null;
    if (reg === subscribedTo) return;
    unsubscribe?.();
    unsubscribe = null;
    subscribedTo = reg;
    if (reg) unsubscribe = reg.onChange(change => { if (!change?.ids || change.ids.includes(p.command)) render(); });
  }

  function render() {
    const v = derive();
    current = v;
    if (p.iconOnly) requireLabel('IconButton', v.label);
    applyCommon(el, p, prevCommon);
    prevCommon = {className: p.className, id: p.id, attrs: p.attrs, dataset: p.dataset, testid: p.testid};
    setAttr(el, 'type', p.type || 'button');
    setAttr(el, 'data-variant', VARIANTS.includes(p.variant) ? p.variant : 'secondary');
    setAttr(el, 'data-size', SIZES.includes(p.size) ? p.size : 'md');
    setAttr(el, 'data-tone', p.tone);
    setAttr(el, 'data-icon-only', !!p.iconOnly);
    setAttr(el, 'aria-label', p.iconOnly ? v.label : p.attrs?.['aria-label'] ?? null);
    setAttr(el, 'aria-pressed', v.pressed === undefined ? null : String(!!v.pressed));
    setAttr(el, 'aria-disabled', v.disabled ? 'true' : null);
    setAttr(el, 'data-disabled', v.disabled);
    setAttr(el, 'aria-keyshortcuts', v.key ? ariaKeys(v.key) : null);
    setAttr(el, 'aria-busy', p.busy ? 'true' : null);
    setAttr(el, 'data-busy', !!p.busy);

    const px = ICON_PX[p.size] ?? 20;
    if (v.icon !== parts.iconName || px !== parts.iconPx) {
      parts.icon = slot(el, parts.icon, v.icon ? makeIcon(v.icon, {size: px}) : null, parts.text);
      parts.iconName = v.icon;
    }
    if ((p.iconEnd ?? null) !== parts.iconEndName || px !== parts.iconPx) {
      const end = p.iconEnd ? makeIcon(p.iconEnd, {size: px}) : null;
      end?.classList.add('ui-button-icon-end');
      parts.iconEnd = slot(el, parts.iconEnd, end, parts.text.nextSibling);
      parts.iconEndName = p.iconEnd ?? null;
    }
    parts.iconPx = px;
    parts.spinner = slot(el, parts.spinner, p.busy ? parts.spinner ?? makeSpinner(px) : null, el.firstChild);

    setText(parts.label, busyText(p.busy, v.label));
    parts.text.hidden = !!p.iconOnly;
    if (p.sublabel && !p.iconOnly) {
      if (!parts.sublabel) parts.sublabel = parts.text.appendChild(span('ui-button-sublabel'));
      setText(parts.sublabel, p.sublabel);
    } else parts.sublabel = slot(parts.text, parts.sublabel, null);

    if (v.shownKbd) {
      if (!parts.kbd) {
        parts.kbd = keyCap(v.shownKbd, {className: 'ui-button-kbd'});
        el.insertBefore(parts.kbd.el, parts.reason);
      } else parts.kbd.set({keys: v.shownKbd});
    } else if (parts.kbd) { parts.kbd.destroy(); parts.kbd = null; }

    if (v.reason && v.disabled) {
      if (!parts.reason) {
        parts.reason = span('ui-button-reason');
        parts.reason.id = reasonId;
        parts.reason.setAttribute('aria-hidden', 'true');
        el.append(parts.reason);
      }
      setText(parts.reason, v.reason);
    } else parts.reason = slot(el, parts.reason, null);
    const describedBy = [p.attrs?.['aria-describedby'], v.reason && v.disabled ? reasonId : null].filter(Boolean).join(' ');
    setAttr(el, 'aria-describedby', describedBy || null);

    const tipKey = `${v.tip ?? ''}\u0000${v.key ?? ''}`;
    if (tipKey !== tooltipKey) {
      tooltipOff();
      tooltipKey = tipKey;
      tooltipOff = v.tip || v.key ? attachTooltip(el, {text: v.tip ?? '', kbd: v.key}) : () => {};
    }
  }

  const press = trackPress(el, {signal: ac.signal, ms: p.longPressMs, onLongPress: null});
  const syncPress = () => {
    press.ms = p.longPressMs ?? 500;
    press.onLongPress = typeof p.onLongPress === 'function' ? e => { if (!current.disabled) p.onLongPress(e); } : null;
  };

  el.addEventListener('click', e => {
    if (press.consumeClick() || current.disabled) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (p.command) registryOf().run(p.command, {source: 'pointer', event: e});
    p.onClick?.(e);
  }, {signal: ac.signal});

  syncPress();
  subscribe();
  render();

  return {
    el,
    set(partial = {}) {
      p = {...p, ...partial};
      syncPress();
      subscribe();
      render();
    },
    destroy() {
      ac.abort();
      press.cancel();
      unsubscribe?.();
      unsubscribe = null;
      tooltipOff();
      parts.kbd?.destroy();
      el.remove();
    },
  };
}

function makeSpinner(px) {
  const s = span('ui-button-spinner');
  s.setAttribute('aria-hidden', 'true');
  s.append(makeIcon('loader', {size: px}));
  return s;
}

/** An icon-only button: `label` (or the command's title) is its accessible name and tooltip. */
export function IconButton(props = {}) {
  if (!props.command) requireLabel('IconButton', props.label);
  return Button({variant: 'quiet', ...props, iconOnly: true});
}
