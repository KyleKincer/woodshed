// Sheet (architecture §2.12, spec §4.7 and §8.8): one API for the Stage's sheets and the app's bottom sheets.
//
//   Sheet({title, content, layout = 'auto', anchor, detents = [40, 60, 90], initialDetent = 60, modal = false,
//          grabber = true, width = 360, label, closeLabel = 'Close', autofocus = true, onClose,
//          className, id, attrs, dataset, testid})
//     → {el, body, set(partial), close(reason = 'close'), destroy(), setDetent(percent), get detent, get presentation, get open}
//
//   layout 'auto': a bottom sheet in the band layout (and anywhere without a Stage), a popover anchored left of `anchor`
//   in the rail layout, read from the nearest [data-stage-layout] (the anchor's ancestor, else the document's).
//   'bottom' and 'popover' force one presentation ('popover' needs an element anchor).
//   Detents are percentages of the viewport height: the sheet sizes to its content up to the current detent; dragging the
//   header up moves to the next detent, down to the previous one; a swipe down dismisses when shouldDismiss() says so.
//   It closes on ✕ (44 px), Esc (the dispatcher's overlay stack: modal per D36 when `modal`, else non-modal) and a tap
//   outside. Modal sheets are a native <dialog> (showModal); non-modal ones use the Popover API (or the fallback layer).
//   A sheet never pushes history, never pauses playback and never moves the page.
//
//   shouldDismiss({dy, h, v}) → boolean   pure: a downward drag of more than a quarter of the sheet's height, or a
//                                          downward flick faster than 0.5 px/ms. Never for an upward drag.
//   resolveLayout(layout, anchor, doc) → 'bottom' | 'popover'

import {now} from '../app/clock.js';
import {pushOverlay} from '../app/dispatch.js';
import {h} from './h.js';
import {anchorTo} from './position.js';
import {
  applyCommon, closeLayersInside, focusInto, glyph, withDefaults, hideLayer, onOutside, pushModalHost, restoreFocus, setContent, showLayer, trackLayer, trapTab, layerHost,
} from './popover.js';
import '../styles/primitives/sheet.css';

export const DISMISS_FRACTION = 0.25;
export const DISMISS_VELOCITY = 0.5;      // px/ms
const STEP_PX = 48;                        // a drag this far moves one detent
const VELOCITY_WINDOW_MS = 100;

/** True when a drag of dy px (positive = down) at v px/ms on a sheet h px tall dismisses it. Pure. */
export function shouldDismiss({dy, h, v = 0}) {
  if (!(dy > 0)) return false;
  return dy > DISMISS_FRACTION * h || v > DISMISS_VELOCITY;
}

const isElement = v => !!v && typeof v === 'object' && v.nodeType === 1;

/** The Stage layout ('rail' | 'band') around `anchor`, else in the document, else null. */
export function stageLayoutOf(anchor, doc = globalThis.document) {
  const host = (isElement(anchor) && anchor.closest('[data-stage-layout]')) || doc?.querySelector?.('[data-stage-layout]');
  return host?.getAttribute('data-stage-layout') ?? null;
}

/** 'bottom' or 'popover' for a layout prop. */
export function resolveLayout(layout = 'auto', anchor, doc = globalThis.document) {
  if (layout === 'bottom') return 'bottom';
  if (layout === 'popover') return isElement(anchor) ? 'popover' : 'bottom';
  if (layout !== 'auto') throw new RangeError(`Sheet: unknown layout ${JSON.stringify(layout)}`);
  return stageLayoutOf(anchor, doc) === 'rail' && isElement(anchor) ? 'popover' : 'bottom';
}

let sheetSeq = 0;

/** A sheet. See the header. */
export function Sheet(props = {}) {
  let p = withDefaults({layout: 'auto', detents: [40, 60, 90], initialDetent: 60, modal: false, grabber: true, width: 360,
    closeLabel: 'Close', autofocus: true}, props);
  const doc = isElement(p.anchor) ? p.anchor.ownerDocument : globalThis.document;
  const presentation = resolveLayout(p.layout, p.anchor, doc);
  const seq = ++sheetSeq;
  const titleId = `ui-sheet-title-${seq}`;

  const grabber = h('span', {class: 'ui-sheet-grabber', 'aria-hidden': 'true'});
  const title = h('h2', {class: 'ui-sheet-title', id: titleId});
  const closeButton = h('button', {type: 'button', class: 'ui-sheet-close'}, glyph('x'));
  const head = h('header', {class: 'ui-sheet-head'}, grabber, title, closeButton);
  const body = h('div', {class: 'ui-sheet-body'});
  const el = h(p.modal ? 'dialog' : 'section', {class: 'ui-sheet', tabIndex: -1}, head, body);
  el.dataset.presentation = presentation;
  const previous = doc.activeElement;

  let open = true;
  let detents = [];
  let detentIndex = 0;
  const cleanups = [];
  let positioner = null;

  const normaliseDetents = list => {
    const out = [...new Set((Array.isArray(list) && list.length ? list : [60]).map(Number).filter(n => n > 0 && n <= 100))].sort((a, b) => a - b);
    return out.length ? out : [60];
  };
  const applyDetent = () => el.style.setProperty('--ui-sheet-detent', String(detents[detentIndex]));
  const nearestIndex = value => detents.reduce((best, d, i) => (Math.abs(d - value) < Math.abs(detents[best] - value) ? i : best), 0);

  const applyProps = (next, prev = {}) => {
    applyCommon(el, next, prev);
    if (!p.modal) el.setAttribute('role', 'dialog');
    if (next.modal) el.setAttribute('aria-modal', 'true'); else el.removeAttribute('aria-modal');
    title.textContent = next.title ?? '';
    title.hidden = !next.title;
    if (next.title) { el.setAttribute('aria-labelledby', titleId); el.removeAttribute('aria-label'); }
    else { el.removeAttribute('aria-labelledby'); el.setAttribute('aria-label', next.label ?? 'Sheet'); }
    closeButton.setAttribute('aria-label', next.closeLabel);
    grabber.hidden = !next.grabber || presentation !== 'bottom';
    if (presentation === 'popover') el.style.inlineSize = typeof next.width === 'number' ? `${next.width}px` : String(next.width);
    if (next.detents !== prev.detents) {
      const current = detents[detentIndex];
      detents = normaliseDetents(next.detents);
      detentIndex = nearestIndex(prev.detents ? current : next.initialDetent);
      applyDetent();
    }
  };

  const close = (reason = 'close') => {
    if (!open) return;
    open = false;
    if (p.modal) closeLayersInside(el, 'close');   // overlays opened inside the <dialog> close with it
    for (const fn of cleanups.splice(0).reverse()) fn();
    positioner?.destroy();
    el.__uiClose = null;
    restoreFocus(previous, el);
    if (p.modal) {
      if (el.open) el.close();
      el.remove();
    } else {
      hideLayer(el);
    }
    if (reason !== 'destroy') p.onClose?.(reason);
  };

  el.__uiClose = close;
  applyProps(p);
  setContent(body, p.content);
  closeButton.addEventListener('click', () => close('close'));

  // Open.
  if (p.modal) {
    layerHost(doc).append(el);
    el.showModal();
    cleanups.push(pushModalHost(el), trackLayer(el));
    const onCancel = e => { e.preventDefault(); close('escape'); };
    // A pointer-down on the backdrop targets the <dialog> itself, outside its box.
    const onBackdrop = e => {
      if (e.target !== el) return;
      const r = el.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close('outside');
    };
    el.addEventListener('cancel', onCancel);
    el.addEventListener('pointerdown', onBackdrop);
    cleanups.push(trapTab(el));
    cleanups.push(() => { el.removeEventListener('cancel', onCancel); el.removeEventListener('pointerdown', onBackdrop); });
  } else {
    showLayer(el, 'sheet');
    cleanups.push(onOutside(el, {except: isElement(p.anchor) ? [p.anchor] : [], onDismiss: () => close('outside')}));
  }
  if (presentation === 'popover') positioner = anchorTo(el, p.anchor, {placement: 'left'});
  cleanups.push(pushOverlay({el, modal: !!p.modal, onEscape: () => close('escape')}));
  // Esc without the dispatcher running (it calls preventDefault when it handles the key).
  const onKeydown = e => {
    if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing) { e.preventDefault(); close('escape'); }
  };
  el.addEventListener('keydown', onKeydown);
  cleanups.push(() => el.removeEventListener('keydown', onKeydown));
  if (p.autofocus) focusInto(el, {preferred: body.querySelector('[autofocus]')});

  // Swipe and drag between detents (bottom presentation only; the header is the handle).
  let drag = null;
  const resetDrag = () => {
    drag = null;
    delete el.dataset.dragging;
    el.style.removeProperty('translate');
  };
  const onDown = e => {
    if (presentation !== 'bottom' || drag || (e.button ?? 0) !== 0 || closeButton.contains(e.target)) return;
    const height = el.getBoundingClientRect().height || (doc.defaultView?.innerHeight ?? 0) * detents[detentIndex] / 100;
    drag = {id: e.pointerId, y0: e.clientY, h: height, samples: [{y: e.clientY, t: now()}]};
    try { head.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    el.dataset.dragging = '';
  };
  const onMove = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    const t = now();
    drag.samples.push({y: e.clientY, t});
    while (drag.samples.length > 2 && t - drag.samples[0].t > VELOCITY_WINDOW_MS) drag.samples.shift();
    el.style.setProperty('translate', `0 ${Math.round(dy >= 0 ? dy : dy / 3)}px`);
    e.preventDefault();
  };
  const onUp = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    const t = now();
    drag.samples.push({y: e.clientY, t});
    const recent = drag.samples.filter(s => t - s.t <= VELOCITY_WINDOW_MS);
    const first = recent[0] ?? drag.samples[0], last = drag.samples[drag.samples.length - 1];
    const dt = last.t - first.t;
    const v = dt > 0 ? (last.y - first.y) / dt : 0;
    const height = drag.h;
    resetDrag();
    if (shouldDismiss({dy, h: height, v})) { close('swipe'); return; }
    if ((dy < -STEP_PX || v < -DISMISS_VELOCITY) && detentIndex < detents.length - 1) { detentIndex++; applyDetent(); }
    else if (dy > STEP_PX && detentIndex > 0) { detentIndex--; applyDetent(); }
  };
  const onCancelDrag = e => { if (drag && e.pointerId === drag.id) resetDrag(); };
  head.addEventListener('pointerdown', onDown);
  head.addEventListener('pointermove', onMove);
  head.addEventListener('pointerup', onUp);
  head.addEventListener('pointercancel', onCancelDrag);
  head.addEventListener('lostpointercapture', onCancelDrag);

  return {
    el,
    body,
    get open() { return open; },
    get presentation() { return presentation; },
    get detent() { return detents[detentIndex]; },
    setDetent(value) {
      detentIndex = nearestIndex(Number(value));
      applyDetent();
    },
    set(partial = {}) {
      if (!open) return;
      const prev = p;
      p = {...p, ...partial, modal: prev.modal, layout: prev.layout};
      applyProps(p, prev);
      if ('content' in partial && partial.content !== prev.content) setContent(body, p.content);
      if (presentation === 'popover' && partial.anchor && partial.anchor !== prev.anchor) {
        positioner?.destroy();
        positioner = anchorTo(el, p.anchor, {placement: 'left'});
      } else {
        positioner?.update();
      }
    },
    close,
    destroy() { close('destroy'); },
  };
}
