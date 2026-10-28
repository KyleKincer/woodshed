// Overlay placement (architecture §2.12, spec §8.8): a pure `place()` that flips and clamps, and `anchorTo()`, which
// keeps an overlay next to its anchor through CSS anchor positioning where the browser has it and through `place()`
// everywhere else (Safari before 26, `fx-nofeature=anchor`). Layout code takes dimensions as inputs (§0.1): `place()`
// never touches the DOM; only `anchorTo()` measures, at its call site.
//
//   place(anchor, size, viewport, placement = 'bottom', {gap = 8, margin = 8, align = 'start'})
//     anchor     a rect {x|left, y|top, width, height} (or {left, top, right, bottom}), or a point {x, y}
//     size       {width, height} of the overlay at its natural size
//     viewport   {width, height, x = 0, y = 0}
//     placement  'bottom' | 'top' | 'left' | 'right' | 'auto' (bottom, top, right, left: the first side that fits)
//     → {x, y, side, align, flipped, maxWidth, maxHeight}   maxWidth/maxHeight are null unless the overlay had to shrink
//   Rules: the overlay goes on the preferred side when it fits there; otherwise on the opposite side (or, for 'auto', the
//   next side in order) when that fits; otherwise on the side with the most room, shrunk to it. Along the other axis it
//   aligns with the anchor's start (or centre, or end) and is clamped `margin` px inside the viewport; an overlay larger
//   than the viewport is pinned at the margin and shrunk.
//
//   anchorTo(el, anchor, {placement, gap, margin, align, mode = 'auto'}) → {mode: 'css'|'js', update(), destroy()}
//     Positions a fixed (top-layer or fallback) overlay. 'css' sets `anchor-name` on the anchor element and
//     `position-anchor` on the overlay, with `data-placement` choosing the position-area and try-fallbacks in
//     position.css. 'js' measures and writes left/top (and max sizes) from `place()`, again on scroll, resize and size
//     changes. A point anchor always uses 'js'. `el.dataset.anchor` records the mode and `el.dataset.side` the side
//     ('css' mode: the preferred side; the browser may flip it).

import '../styles/primitives/position.css';

export const GAP = 8;
export const MARGIN = 8;
export const PLACEMENTS = Object.freeze(['bottom', 'top', 'left', 'right', 'auto']);

const ORDER = {
  bottom: ['bottom', 'top'],
  top: ['top', 'bottom'],
  left: ['left', 'right'],
  right: ['right', 'left'],
  auto: ['bottom', 'top', 'right', 'left'],
};

const num = v => (Number.isFinite(v) ? v : 0);

/** Normalises a rect or point to {left, top, right, bottom, width, height}. */
export function rectOf(anchor) {
  if (!anchor || typeof anchor !== 'object') throw new TypeError('place: the anchor must be a rect or a point');
  const left = num(anchor.left ?? anchor.x);
  const top = num(anchor.top ?? anchor.y);
  const width = Number.isFinite(anchor.width) ? anchor.width : Number.isFinite(anchor.right) ? anchor.right - left : 0;
  const height = Number.isFinite(anchor.height) ? anchor.height : Number.isFinite(anchor.bottom) ? anchor.bottom - top : 0;
  return {left, top, width: Math.max(0, width), height: Math.max(0, height), right: left + Math.max(0, width), bottom: top + Math.max(0, height)};
}

const vertical = side => side === 'top' || side === 'bottom';

/** Places an overlay of `size` next to `anchor` inside `viewport`. Pure. */
export function place(anchor, size, viewport, placement = 'bottom', {gap = GAP, margin = MARGIN, align = 'start'} = {}) {
  const order = ORDER[placement];
  if (!order) throw new RangeError(`place: unknown placement ${JSON.stringify(placement)}`);
  const a = rectOf(anchor);
  const w = Math.max(0, num(size?.width)), h = Math.max(0, num(size?.height));
  const vx = num(viewport?.x), vy = num(viewport?.y);
  const vw = Math.max(0, num(viewport?.width)), vh = Math.max(0, num(viewport?.height));
  const space = {
    bottom: vy + vh - margin - (a.bottom + gap),
    top: a.top - gap - (vy + margin),
    right: vx + vw - margin - (a.right + gap),
    left: a.left - gap - (vx + margin),
  };
  const need = side => (vertical(side) ? h : w);
  let side = order.find(s => space[s] >= need(s));
  let shrinkMain = false;
  if (!side) {
    side = order.reduce((best, s) => (space[s] > space[best] ? s : best), order[0]);
    shrinkMain = true;
  }
  const room = Math.max(0, space[side]);
  const mainSize = shrinkMain ? Math.min(need(side), room) : need(side);
  let x, y, maxWidth = null, maxHeight = null;

  // Cross axis: align with the anchor, then clamp inside the viewport.
  const cross = (length, anchorStart, anchorLength, viewStart, viewLength) => {
    let pos = align === 'center' ? anchorStart + anchorLength / 2 - length / 2
      : align === 'end' ? anchorStart + anchorLength - length : anchorStart;
    const min = viewStart + margin, max = viewStart + viewLength - margin - length;
    if (max < min) return {pos: min, shrink: Math.max(0, viewLength - 2 * margin)};
    pos = Math.min(Math.max(pos, min), max);
    return {pos, shrink: null};
  };

  if (vertical(side)) {
    y = side === 'bottom' ? a.bottom + gap : a.top - gap - mainSize;
    if (shrinkMain) maxHeight = room;
    const c = cross(w, a.left, a.width, vx, vw);
    x = c.pos;
    maxWidth = c.shrink;
  } else {
    x = side === 'right' ? a.right + gap : a.left - gap - mainSize;
    if (shrinkMain) maxWidth = room;
    const c = cross(h, a.top, a.height, vy, vh);
    y = c.pos;
    maxHeight = c.shrink;
  }
  return {
    x: Math.round(x), y: Math.round(y), side, align, flipped: side !== order[0],
    maxWidth: maxWidth == null ? null : Math.floor(maxWidth), maxHeight: maxHeight == null ? null : Math.floor(maxHeight),
  };
}

/** True when the browser has CSS anchor positioning (`anchor-name` and `position-area`). */
export function supportsAnchor(win = globalThis.window) {
  const css = win?.CSS;
  try {
    const style = win.document?.documentElement?.style;
    return !!css?.supports?.('anchor-name: --ui-a') && !!css.supports('position-area: block-end') && !!style && 'anchorName' in style;
  } catch {
    return false;
  }
}

/** The visual viewport as {x, y, width, height} (layout-viewport coordinates, which position: fixed uses). */
export function viewportRect(win = globalThis.window) {
  const vv = win?.visualViewport;
  if (vv && vv.width > 0 && vv.height > 0) return {x: vv.offsetLeft || 0, y: vv.offsetTop || 0, width: vv.width, height: vv.height};
  const doc = win?.document?.documentElement;
  return {x: 0, y: 0, width: doc?.clientWidth || win?.innerWidth || 0, height: win?.innerHeight || doc?.clientHeight || 0};
}

const isElement = v => !!v && typeof v === 'object' && v.nodeType === 1;
let anchorSeq = 0;

/** Keeps the fixed overlay `el` next to `anchor` (an Element or a point {x, y}). See the header. */
export function anchorTo(el, anchor, {placement = 'bottom', gap = GAP, margin = MARGIN, align = 'start', mode = 'auto'} = {}) {
  if (!isElement(el)) throw new TypeError('anchorTo: el must be an element');
  if (!PLACEMENTS.includes(placement)) throw new RangeError(`anchorTo: unknown placement ${JSON.stringify(placement)}`);
  const win = el.ownerDocument?.defaultView ?? globalThis.window;
  const useCss = mode === 'css' || (mode === 'auto' && isElement(anchor) && supportsAnchor(win));
  el.dataset.placement = placement;
  el.dataset.align = align;
  el.dataset.side = placement === 'auto' ? 'bottom' : placement;

  if (useCss && isElement(anchor)) {
    const name = `--ui-anchor-${++anchorSeq}`;
    const previous = anchor.style.getPropertyValue('anchor-name');
    anchor.style.setProperty('anchor-name', previous && previous !== 'none' ? `${previous}, ${name}` : name);
    el.style.setProperty('position-anchor', name);
    el.dataset.anchor = 'css';
    return {
      mode: 'css',
      update() {},
      destroy() {
        const names = anchor.style.getPropertyValue('anchor-name').split(',').map(s => s.trim()).filter(s => s && s !== name);
        if (names.length) anchor.style.setProperty('anchor-name', names.join(', '));
        else anchor.style.removeProperty('anchor-name');
        el.style.removeProperty('position-anchor');
        delete el.dataset.anchor;
      },
    };
  }

  el.dataset.anchor = 'js';
  let frame = 0, destroyed = false;
  const update = () => {
    if (destroyed || !el.isConnected) return;
    const rect = isElement(anchor) ? anchor.getBoundingClientRect() : {x: anchor.x, y: anchor.y, width: 0, height: 0};
    // Measure at the natural size: clear the limits a previous placement set.
    el.style.maxWidth = '';
    el.style.maxHeight = '';
    const size = {width: el.offsetWidth, height: el.offsetHeight};
    const r = place(rect, size, viewportRect(win), placement, {gap, margin, align});
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.maxWidth = r.maxWidth == null ? '' : `${r.maxWidth}px`;
    el.style.maxHeight = r.maxHeight == null ? '' : `${r.maxHeight}px`;
    el.dataset.side = r.side;
  };
  const schedule = () => {
    if (frame || destroyed) return;
    const raf = win?.requestAnimationFrame ?? (fn => setTimeout(fn, 16));
    frame = raf(() => { frame = 0; update(); });
  };
  win?.addEventListener?.('resize', schedule);
  win?.addEventListener?.('scroll', schedule, {capture: true, passive: true});
  win?.visualViewport?.addEventListener?.('resize', schedule);
  win?.visualViewport?.addEventListener?.('scroll', schedule);
  let observer = null;
  if (typeof win?.ResizeObserver === 'function') {
    observer = new win.ResizeObserver(schedule);
    observer.observe(el);
    if (isElement(anchor)) observer.observe(anchor);
  }
  update();
  return {
    mode: 'js',
    update,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) (win?.cancelAnimationFrame ?? clearTimeout)(frame);
      win?.removeEventListener?.('resize', schedule);
      win?.removeEventListener?.('scroll', schedule, {capture: true});
      win?.visualViewport?.removeEventListener?.('resize', schedule);
      win?.visualViewport?.removeEventListener?.('scroll', schedule);
      observer?.disconnect();
      for (const p of ['left', 'top', 'maxWidth', 'maxHeight']) el.style[p] = '';
      delete el.dataset.anchor;
    },
  };
}
