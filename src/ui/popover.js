// Popover (architecture §2.12, spec §8.8) and the overlay plumbing the other U2 primitives share.
//
//   Popover({anchor, content, placement = 'auto', width, modal = false, labelledBy, label, onClose, autofocus = true,
//            align = 'start', role = 'dialog', className, id, attrs, dataset, testid})
//     → {el, set(partial), close(reason = 'close'), update(), destroy(), get open}
//   Opens at once: the Popover API (`popover=manual`, top layer) where it exists, else a fixed fallback layer at
//   --z-popover; placed by position.js (CSS anchor positioning, or place()). It grows from the anchor (160 ms), closes
//   on Esc (through the dispatcher's overlay stack: modal per D36 when `modal`, else non-modal) and on a pointer-down
//   outside it and its anchor, and returns focus to where it was when the focus is inside it at close. `onClose(reason)`
//   runs once, for 'escape' | 'outside' | 'close' (and any reason passed to close()); destroy() closes silently.
//
// Shared helpers (used by menu, sheet, dialog, toast, status, banner and coachmark):
//   withDefaults(defaults, props)   props over defaults, ignoring undefined values
//   applyCommon(el, next, prev)     the common props of §2.12: className, id, attrs, dataset, testid
//   glyph(name, {size})             an <svg class="ui-icon"> using the sprite symbol #i-<name>
//   setContent(el, content)         content: a Node, a string, an array of them, or null
//   supportsPopover(win)            the Popover API exists
//   showLayer(el, kind) / hideLayer(el)   put an overlay in the top layer (or the fallback layer, data-layer=<kind>)
//   trackLayer(el) → untrack        record an overlay opened another way (a modal <dialog>) in the layer stack
//   onOutside(el, {except, onDismiss}) → off   pointer-down outside el, its exceptions and every layer opened after it
//   pushModalHost(el) → pop / layerHost(doc)   overlays opened while a modal <dialog> is open are placed inside it, so
//                                   they are not inert
//   firstFocusable(root) / focusInto(el, {preferred}) / restoreFocus(previous, el)

import {pushOverlay} from '../app/dispatch.js';
import {h} from './h.js';
import {anchorTo} from './position.js';
import '../styles/primitives/popover.css';

// ---------------------------------------------------------------------------------------------------------------
// Common props

/** {...defaults, ...props} where a prop that is undefined keeps its default. */
export function withDefaults(defaults, props = {}) {
  const out = {...defaults};
  for (const [key, value] of Object.entries(props ?? {})) if (value !== undefined) out[key] = value;
  return out;
}

const tokens = value => String(value ?? '').split(/\s+/).filter(Boolean);

function patchMap(el, next = {}, prev = {}, set) {
  for (const key of Object.keys(prev ?? {})) if (!(key in (next ?? {}))) set(key, null);
  for (const [key, value] of Object.entries(next ?? {})) if (prev?.[key] !== value) set(key, value);
}

/** Applies the common props (className, id, attrs, dataset, testid) to `el`, patching what changed since `prev`. */
export function applyCommon(el, next = {}, prev = {}) {
  if (next.className !== prev.className) {
    for (const c of tokens(prev.className)) el.classList.remove(c);
    for (const c of tokens(next.className)) el.classList.add(c);
  }
  if (next.id !== prev.id) {
    if (next.id) el.id = next.id; else if (prev.id) el.removeAttribute('id');
  }
  if (next.testid !== prev.testid) {
    if (next.testid) el.setAttribute('data-testid', next.testid); else el.removeAttribute('data-testid');
  }
  if (next.attrs !== prev.attrs) {
    patchMap(el, next.attrs, prev.attrs, (k, v) => {
      if (v == null || v === false) el.removeAttribute(k); else el.setAttribute(k, v === true ? '' : String(v));
    });
  }
  if (next.dataset !== prev.dataset) {
    patchMap(el, next.dataset, prev.dataset, (k, v) => {
      if (v == null || v === false) delete el.dataset[k]; else el.dataset[k] = v === true ? '' : String(v);
    });
  }
}

/** An icon from the sprite (§7.4): <svg class="ui-icon" aria-hidden="true"><use href="#i-name"/></svg>. */
export function glyph(name, {size = 20, className = ''} = {}) {
  return h('svg', {
    class: ['ui-icon', className], width: size, height: size, 'aria-hidden': 'true', focusable: 'false',
  }, h('use', {href: `#i-${name}`}));
}

/** Replaces el's children with content: a Node, a string, a number, an array of them, or null. */
export function setContent(el, content) {
  const nodes = [];
  const add = c => {
    if (c == null || c === false || c === true) return;
    if (Array.isArray(c)) { c.forEach(add); return; }
    if (typeof c === 'object' && typeof c.nodeType === 'number') nodes.push(c);
    else if (typeof c === 'object' && c.el && typeof c.el.nodeType === 'number') nodes.push(c.el);   // a primitive
    else nodes.push(el.ownerDocument.createTextNode(String(c)));
  };
  add(content);
  el.replaceChildren(...nodes);
}

// ---------------------------------------------------------------------------------------------------------------
// Layers

const layers = [];        // open overlay elements, bottom first
const modalHosts = [];    // open modal <dialog> elements, bottom first

/** The Popover API exists (fx-nofeature=popover removes it). */
export function supportsPopover(win = globalThis.window) {
  return typeof win?.HTMLElement?.prototype?.showPopover === 'function';
}

/** Records an overlay in the layer stack (for onOutside). Returns `untrack`. */
export function trackLayer(el) {
  layers.push(el);
  return () => {
    const at = layers.lastIndexOf(el);
    if (at >= 0) layers.splice(at, 1);
  };
}

/** A modal <dialog> is open: later overlays go inside it. Returns `pop`. */
export function pushModalHost(el) {
  modalHosts.push(el);
  return () => {
    const at = modalHosts.lastIndexOf(el);
    if (at >= 0) modalHosts.splice(at, 1);
  };
}

/** Where a new overlay element is appended: the topmost open modal <dialog>, else the body. */
export function layerHost(doc = globalThis.document) {
  for (let i = modalHosts.length - 1; i >= 0; i--) if (modalHosts[i].isConnected && modalHosts[i].ownerDocument === doc) return modalHosts[i];
  return doc.body;
}

function popoverOpen(el) {
  try { return el.matches(':popover-open'); } catch { return el.hasAttribute('data-popover-open'); }
}

/** Shows el in the top layer (Popover API) or the fallback layer. kind: popover | menu | sheet | coachmark. */
export function showLayer(el, kind = 'popover') {
  const doc = el.ownerDocument;
  el.dataset.layer = kind;
  if (!el.isConnected) layerHost(doc).append(el);
  if (supportsPopover(doc.defaultView)) {
    el.setAttribute('popover', 'manual');
    if (!popoverOpen(el)) el.showPopover();
  } else {
    el.setAttribute('data-layer-fallback', '');
  }
  el.__uiUntrack?.();
  el.__uiUntrack = trackLayer(el);
}

/** Hides and removes an overlay shown with showLayer. */
export function hideLayer(el) {
  el.__uiUntrack?.();
  el.__uiUntrack = null;
  if (el.hasAttribute('popover') && popoverOpen(el)) {
    try { el.hidePopover(); } catch { /* already hidden */ }
  }
  el.remove();
}

const isNode = v => !!v && typeof v === 'object' && typeof v.nodeType === 'number';

/**
 * Calls onDismiss(event) on a pointer-down outside `el`, outside every element in `except`, and outside every overlay
 * opened after `el` (a submenu, a menu opened from a popover). Returns `off`.
 */
export function onOutside(el, {except = [], onDismiss}) {
  const doc = el.ownerDocument;
  const handler = e => {
    const target = e.composedPath?.()[0] ?? e.target;
    if (!isNode(target)) return;
    if (el.contains(target)) return;
    if (except.some(x => isNode(x) && x.contains(target))) return;
    const at = layers.indexOf(el);
    if (at >= 0 && layers.slice(at + 1).some(layer => layer.contains(target))) return;
    onDismiss(e);
  };
  doc.addEventListener('pointerdown', handler, true);
  return () => doc.removeEventListener('pointerdown', handler, true);
}

// ---------------------------------------------------------------------------------------------------------------
// Focus

const FOCUSABLE = ['a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type=hidden])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])', '[contenteditable=""]', '[contenteditable=true]'].join(',');

/** The first focusable element inside root (not inside [hidden] or [inert]), or null. */
export function firstFocusable(root) {
  for (const node of root.querySelectorAll(FOCUSABLE)) {
    if (!node.closest('[hidden], [inert]')) return node;
  }
  return null;
}

/** Every focusable element inside root, in DOM order. */
export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(node => !node.closest('[hidden], [inert]'));
}

/** Moves focus into el: `preferred`, else an [autofocus] descendant, else el itself. */
export function focusInto(el, {preferred = null} = {}) {
  const target = preferred ?? el.querySelector('[autofocus]') ?? el;
  target.focus?.({preventScroll: true});
}

/** Returns focus to `previous` when the focus is inside `el` (or nowhere) and previous is still in the document. */
export function restoreFocus(previous, el) {
  const doc = el.ownerDocument;
  const active = doc.activeElement;
  const lost = !active || active === doc.body || el.contains(active) || !active.isConnected;
  if (lost && previous && previous.isConnected && typeof previous.focus === 'function') previous.focus({preventScroll: true});
}

/** Keeps Tab inside `el` (modal popovers and sheets). Returns `off`. */
export function trapTab(el) {
  const onKeydown = e => {
    if (e.key !== 'Tab' || e.defaultPrevented) return;
    const list = focusables(el);
    if (!list.length) { e.preventDefault(); el.focus?.({preventScroll: true}); return; }
    const first = list[0], last = list[list.length - 1];
    const active = el.ownerDocument.activeElement;
    if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };
  el.addEventListener('keydown', onKeydown);
  return () => el.removeEventListener('keydown', onKeydown);
}

// ---------------------------------------------------------------------------------------------------------------
// Popover

let popoverSeq = 0;

/** A popover anchored to an element (or a point). See the header. */
export function Popover(props = {}) {
  let p = withDefaults({placement: 'auto', modal: false, autofocus: true, align: 'start', role: 'dialog'}, props);
  if (!p.anchor) throw new TypeError('Popover: an anchor (element or {x, y}) is required');
  const doc = isNode(p.anchor) ? p.anchor.ownerDocument : globalThis.document;
  const body = h('div', {class: 'ui-popover-body'});
  const el = h('div', {class: 'ui-popover', tabIndex: -1}, body);
  el.id ||= `ui-popover-${++popoverSeq}`;
  const previous = doc.activeElement;
  let open = true;
  let positioner = null, popOverlay = null, offOutside = null, offTrap = null;

  const applyAttrs = (next, prev = {}) => {
    applyCommon(el, next, prev);
    el.setAttribute('role', next.role);
    if (next.labelledBy) el.setAttribute('aria-labelledby', next.labelledBy); else el.removeAttribute('aria-labelledby');
    if (next.label) el.setAttribute('aria-label', next.label); else el.removeAttribute('aria-label');
    if (next.modal) el.setAttribute('aria-modal', 'true'); else el.removeAttribute('aria-modal');
    el.dataset.modal = next.modal ? 'true' : 'false';
    if (next.width != null) el.style.inlineSize = typeof next.width === 'number' ? `${next.width}px` : String(next.width);
    else el.style.inlineSize = '';
  };

  const place = () => {
    positioner?.destroy();
    positioner = anchorTo(el, p.anchor, {placement: p.placement, align: p.align});
  };

  const close = (reason = 'close') => {
    if (!open) return;
    open = false;
    positioner?.destroy();
    popOverlay?.();
    offOutside?.();
    offTrap?.();
    restoreFocus(previous, el);
    hideLayer(el);
    if (reason !== 'destroy') p.onClose?.(reason);
  };

  applyAttrs(p);
  setContent(body, p.content);
  showLayer(el, 'popover');
  place();
  popOverlay = pushOverlay({el, modal: !!p.modal, onEscape: () => close('escape')});
  offOutside = onOutside(el, {except: isNode(p.anchor) ? [p.anchor] : [], onDismiss: () => close('outside')});
  if (p.modal) offTrap = trapTab(el);
  if (p.autofocus) focusInto(el, {preferred: firstFocusable(body)});

  return {
    el,
    get open() { return open; },
    set(partial = {}) {
      if (!open) return;
      const prev = p;
      p = {...p, ...partial};
      applyAttrs(p, prev);
      if ('content' in partial && partial.content !== prev.content) setContent(body, p.content);
      if (p.modal !== prev.modal) {
        popOverlay?.();
        popOverlay = pushOverlay({el, modal: !!p.modal, onEscape: () => close('escape')});
        offTrap?.();
        offTrap = p.modal ? trapTab(el) : null;
      }
      if (p.anchor !== prev.anchor || p.placement !== prev.placement || p.align !== prev.align) {
        offOutside?.();
        offOutside = onOutside(el, {except: isNode(p.anchor) ? [p.anchor] : [], onDismiss: () => close('outside')});
        place();
      } else {
        positioner?.update();
      }
    },
    update() { positioner?.update(); },
    close,
    destroy() { close('destroy'); },
  };
}
