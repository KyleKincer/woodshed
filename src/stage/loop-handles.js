// The loop band and its handles over a music surface (architecture §2.14.13,
// spec §4.8): shared by the Road map and the Stems surface.
//
//   mountLoopHandles(host, {toX, toT, rows, snap, onEdit, playing, hitWidth = 44, moveTol = 8})
//     → {set(range | null), update(), destroy()}
//
//   rows()             the rows the music is drawn in, as client-coordinate DOMRects
//   toX(t, side)       where time t sits, in client x: a number (the same x in every row: Stems),
//                      or {row, x} for wrapped layouts (Road map; side 'a'|'b' says which edge,
//                      so a time on a row break can end one row or start the next). A row < 0
//                      is before the first rendered row, ≥ rows().length after the last; null hides.
//   toT(clientX, clientY) → t
//   snap(t, {alt, shift}) → t   the surface's snapping (bars; Alt → beats; Shift → none)
//   onEdit({a, b, phase})       'preview' while dragging (snapped), 'commit' on release,
//                               'cancel' (with the range before the drag) when the pointer is cancelled
//   playing()                   true while the transport runs: handles show at 50% and only a mouse
//                               may drag them (touch scrolls); re-read by set() and update()
//
// The band is a --loop-fill block per row; each edge has a hit area hitWidth px wide and as tall
// as its row (split at the midpoint when the two edges are closer than that), a 3 px --loop edge
// and a 20 px grip dot. Dragging an edge resizes (the edges may cross); a mouse drag inside the
// band (past moveTol) moves the whole loop. Taps inside the band are left to the surface (the band
// is [data-press-nodrag]; handles are [data-press-ignore], see press.js). After a drag the handles
// spring to the snapped lines over --motion-fast (120 ms, --ease); with reduced motion they jump.
// The overlay is aria-hidden: the loop's keyboard equivalents are I / O, ⇧[ / ⇧] and the Loop card.
import '../styles/views/stage/loop-handles.css';

export const SPRING_MS = 120;
const EPS = 1e-6;

function reducedMotion() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const div = (cls, attrs = {}) => {
  const el = document.createElement('div');
  el.className = cls;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

export function mountLoopHandles(host, {
  toX, toT, rows = () => [], snap = t => t, onEdit, playing = () => false, hitWidth = 44, moveTol = 8,
} = {}) {
  const root = div('loop-handles', {'aria-hidden': 'true'});
  host.append(root);

  /** The committed range (what set() last gave, or the last commit). */
  let range = null;
  /** The drag in progress: {kind: 'a'|'b'|'move', id, el, start, x0, y0, pending, raw: {a, b}, last}. */
  let drag = null;
  let springTimer = null;
  let destroyed = false;
  const bands = [];
  const handles = new Map();   // `${edge}:${slot}` → element

  const emit = (a, b, phase) => { if (typeof onEdit === 'function') onEdit({a, b, phase}); };

  const local = () => {
    const r = host.getBoundingClientRect();
    return {
      x: v => v - r.left - (host.clientLeft || 0) + (host.scrollLeft || 0),
      y: v => v - r.top - (host.clientTop || 0) + (host.scrollTop || 0),
    };
  };

  const handleFor = (edge, slot) => {
    const key = `${edge}:${slot}`;
    let el = handles.get(key);
    if (!el) {
      el = div('loop-handle', {'data-edge': edge, 'data-press-ignore': ''});
      el.append(div('loop-handle-edge'), div('loop-handle-grip'));
      el.addEventListener('pointerdown', onHandleDown);
      handles.set(key, el);
      root.append(el);
    }
    el.setAttribute('data-edge', edge);
    return el;
  };

  const bandAt = i => {
    while (bands.length <= i) {
      const el = div('loop-band', {'data-press-nodrag': ''});
      el.addEventListener('pointerdown', onBandDown);
      // Bands stay in row order, under the handles.
      root.insertBefore(el, bands.length ? bands[bands.length - 1].nextSibling : root.firstChild);
      bands.push(el);
    }
    return bands[i];
  };

  const place = (el, {left, top, width, height}) => {
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${Math.max(0, width)}px`;
    el.style.height = `${Math.max(0, height)}px`;
  };

  /** Where an edge time lands: [{row, x}] (one per row for a plain number). */
  const locate = (t, side) => {
    const at = typeof toX === 'function' ? toX(t, side) : null;
    if (at == null) return null;
    if (typeof at === 'number') return {all: true, x: at};
    return {all: false, row: at.row, x: at.x};
  };

  /**
   * Draws the band and handles for edge positions ta (the 'a' elements) and tb (the 'b' ones).
   * The two may be crossed while an edge is dragged past the other.
   */
  const render = (ta, tb) => {
    root.toggleAttribute('data-playing', !!playing());
    const rects = (typeof rows === 'function' ? rows() : rows) ?? [];
    const used = new Set();
    let bandCount = 0;
    if (ta == null || tb == null || !rects.length) {
      hideUnused(used, 0);
      return;
    }
    const L = local();
    const pa = locate(ta, ta <= tb ? 'a' : 'b'), pb = locate(tb, ta <= tb ? 'b' : 'a');
    if (!pa || !pb) { hideUnused(used, 0); return; }
    const half = hitWidth / 2;
    const handleBoxes = (xa, xb) => {
      // Hit areas: hitWidth wide, split at the midpoint when the edges are too close.
      const lo = Math.min(xa, xb), hi = Math.max(xa, xb), mid = (lo + hi) / 2, close = hi - lo < hitWidth;
      const box = (x, isLo) => {
        let left = x - half, right = x + half;
        if (close) { if (isLo) right = Math.max(x + 1, mid); else left = Math.min(x - 1, mid); }
        return {left, right};
      };
      return {a: box(xa, xa <= xb), b: box(xb, xb < xa)};
    };
    const showHandle = (edge, slot, rect, x, box) => {
      if (x < rect.left - half || x > rect.right + half) return;
      const el = handleFor(edge, slot);
      used.add(`${edge}:${slot}`);
      el.hidden = false;
      const left = L.x(box.left), top = L.y(rect.top);
      place(el, {left, top, width: box.right - box.left, height: rect.height});
      el.style.setProperty('--edge-x', `${L.x(x) - left}px`);
    };

    if (pa.all && pb.all) {
      const lo = Math.min(pa.x, pb.x), hi = Math.max(pa.x, pb.x);
      const boxes = handleBoxes(pa.x, pb.x);
      rects.forEach((rect, i) => {
        const left = Math.max(lo, rect.left), right = Math.min(hi, rect.right);
        if (right > left) {
          const band = bandAt(bandCount++);
          band.hidden = false;
          place(band, {left: L.x(left), top: L.y(rect.top), width: right - left, height: rect.height});
        }
        showHandle('a', i, rect, pa.x, boxes.a);
        showHandle('b', i, rect, pb.x, boxes.b);
      });
    } else {
      // Wrapped rows: the band runs from the earlier edge's row to the later one's.
      const ra = pa.all ? 0 : pa.row, rb = pb.all ? rects.length - 1 : pb.row;
      const A = {row: ra, x: pa.x}, B = {row: rb, x: pb.x};
      const [first, last] = A.row < B.row || (A.row === B.row && A.x <= B.x) ? [A, B] : [B, A];
      for (let i = Math.max(0, first.row); i <= Math.min(rects.length - 1, last.row); i++) {
        const rect = rects[i];
        const left = i === first.row ? Math.max(first.x, rect.left) : rect.left;
        const right = i === last.row ? Math.min(last.x, rect.right) : rect.right;
        if (right > left) {
          const band = bandAt(bandCount++);
          band.hidden = false;
          place(band, {left: L.x(left), top: L.y(rect.top), width: right - left, height: rect.height});
        }
      }
      const sameRow = ra === rb;
      const boxes = sameRow ? handleBoxes(pa.x, pb.x) : {a: {left: pa.x - half, right: pa.x + half}, b: {left: pb.x - half, right: pb.x + half}};
      if (ra >= 0 && ra < rects.length) showHandle('a', 0, rects[ra], pa.x, boxes.a);
      if (rb >= 0 && rb < rects.length) showHandle('b', 0, rects[rb], pb.x, boxes.b);
    }
    hideUnused(used, bandCount);
  };

  const hideUnused = (used, bandCount) => {
    for (let i = bandCount; i < bands.length; i++) bands[i].hidden = true;
    for (const [key, el] of handles) {
      if (used.has(key)) continue;
      if (drag && drag.el === el) continue;   // a dragged handle keeps its pointer capture
      el.hidden = true;
    }
  };

  const draw = () => {
    if (destroyed) return;
    if (drag && !drag.pending) render(drag.raw.a, drag.raw.b);
    else render(range?.a, range?.b);
  };

  // ---------------------------------------------------------------- drags

  const mods = e => ({alt: !!e.altKey, shift: !!e.shiftKey});

  /** Snapped {a, b} from raw edges; never empty (falls back to the raw edges). */
  const snapped = (lo, hi, e) => {
    let a = snap(lo, mods(e)), b = snap(hi, mods(e));
    if (!(b - a > EPS)) { a = lo; b = hi; }
    return {a: Math.max(0, a), b};
  };

  const startDrag = (e, kind, el) => {
    drag = {kind, id: e.pointerId, el, start: {...range}, x0: e.clientX, y0: e.clientY, pending: kind === 'move',
      raw: {...range}, last: null, pointerType: e.pointerType || 'mouse'};
    clearSpring();
    if (kind !== 'move') {
      try { el.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      el.setAttribute('data-dragging', '');
    }
    el.addEventListener('pointermove', onDragMove);
    el.addEventListener('pointerup', onDragEnd);
    el.addEventListener('pointercancel', onDragCancel);
    el.addEventListener('lostpointercapture', onLostCapture);
  };

  function onHandleDown(e) {
    if (!range || drag) return;
    const pointerType = e.pointerType || 'mouse';
    if (pointerType === 'mouse' && e.button !== 0) return;
    if (playing() && pointerType !== 'mouse') return;   // touch while playing scrolls (spec §4.8)
    e.stopPropagation();
    e.preventDefault();
    startDrag(e, e.currentTarget.getAttribute('data-edge'), e.currentTarget);
  }

  function onBandDown(e) {
    if (!range || drag) return;
    if ((e.pointerType || 'mouse') !== 'mouse' || e.button !== 0) return;   // inside moves are mouse-only (spec §4.4D)
    startDrag(e, 'move', e.currentTarget);
  }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.pending) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) <= moveTol) return;
      drag.pending = false;
      try { drag.el.setPointerCapture(e.pointerId); } catch { /* gone */ }
      drag.el.setAttribute('data-dragging', '');
    }
    const t = toT(e.clientX, e.clientY);
    const {start} = drag;
    let lo, hi;
    if (drag.kind === 'move') {
      const length = start.b - start.a;
      lo = start.a + (t - toT(drag.x0, drag.y0));
      if (lo < 0) lo = 0;
      hi = lo + length;
      drag.raw = {a: lo, b: hi};
      const s = snapped(lo, hi, e);
      drag.last = s.b - s.a > EPS ? s : {a: s.a, b: s.a + length};
    } else {
      drag.raw = drag.kind === 'a' ? {a: Math.max(0, t), b: start.b} : {a: start.a, b: Math.max(0, t)};
      lo = Math.min(drag.raw.a, drag.raw.b); hi = Math.max(drag.raw.a, drag.raw.b);
      if (!(hi - lo > EPS)) { draw(); return; }
      drag.last = snapped(lo, hi, e);
    }
    draw();
    emit(drag.last.a, drag.last.b, 'preview');
  }

  const detach = () => {
    const d = drag;
    if (!d) return null;
    d.el.removeEventListener('pointermove', onDragMove);
    d.el.removeEventListener('pointerup', onDragEnd);
    d.el.removeEventListener('pointercancel', onDragCancel);
    d.el.removeEventListener('lostpointercapture', onLostCapture);
    d.el.removeAttribute('data-dragging');
    try { if (d.el.hasPointerCapture?.(d.id)) d.el.releasePointerCapture(d.id); } catch { /* released */ }
    drag = null;
    return d;
  };

  function onDragEnd(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = detach();
    if (d.pending || !d.last) { draw(); return; }
    // A dragged edge that crossed the other becomes the other edge.
    const crossed = d.kind !== 'move' && ((d.kind === 'a' && d.raw.a > d.raw.b) || (d.kind === 'b' && d.raw.b < d.raw.a));
    if (crossed) swapEdges();
    range = {a: d.last.a, b: d.last.b};
    spring();
    emit(range.a, range.b, 'commit');
  }

  function onDragCancel(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = detach();
    range = {...d.start};
    draw();
    if (d.last) emit(range.a, range.b, 'cancel');
  }

  function onLostCapture(e) {
    // Capture lost without a pointerup (the node was hidden, the window lost focus): a cancel.
    if (!drag || e.pointerId !== drag.id || drag.pending) return;
    queueMicrotask(() => { if (drag && drag.id === e.pointerId) onDragCancel(e); });
  }

  const swapEdges = () => {
    const next = new Map();
    for (const [key, el] of handles) {
      const [edge, slot] = key.split(':');
      const other = edge === 'a' ? 'b' : 'a';
      el.setAttribute('data-edge', other);
      next.set(`${other}:${slot}`, el);
    }
    handles.clear();
    for (const [k, v] of next) handles.set(k, v);
  };

  const clearSpring = () => {
    clearTimeout(springTimer);
    springTimer = null;
    root.removeAttribute('data-spring');
  };

  /** Animates from where the drag left the handles to the snapped lines (or jumps, reduced motion). */
  const spring = () => {
    clearSpring();
    if (!reducedMotion()) {
      root.setAttribute('data-spring', '');
      springTimer = setTimeout(() => { springTimer = null; root.removeAttribute('data-spring'); }, SPRING_MS);
    }
    draw();
  };

  // ---------------------------------------------------------------- lifecycle

  let resizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => draw());
    resizeObserver.observe(host);
  }

  return {
    /** Shows a loop ({a, b} in seconds; extra fields are ignored) or hides it (null). */
    set(next) {
      const value = next && Number.isFinite(next.a) && Number.isFinite(next.b) && next.b > next.a ? {a: next.a, b: next.b} : null;
      if (drag) {
        // The surface echoes practice state while a drag runs: the drag's own view wins until it ends.
        drag.start = value ?? drag.start;
        if (!value) { detach(); range = null; draw(); }
        return;
      }
      const same = value && range && Math.abs(value.a - range.a) < EPS && Math.abs(value.b - range.b) < EPS;
      if (!same) {
        if (!(value && range)) clearSpring();
        range = value;
      }
      draw();
    },
    /** Re-reads rows(), toX() and playing() (after a relayout, scroll or transport change). */
    update: draw,
    /** The committed range ({a, b} or null). */
    get range() { return range ? {...range} : null; },
    get dragging() { return !!drag && !drag.pending; },
    destroy() {
      destroyed = true;
      detach();
      clearSpring();
      resizeObserver?.disconnect();
      root.remove();
      handles.clear();
      bands.length = 0;
    },
  };
}
