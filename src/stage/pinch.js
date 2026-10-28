// The pinch / two-finger recogniser (architecture §1, spec §4.4, §4.9): chart
// size (80–200%), Wave page row length and Stems zoom/pan. The gesture previews
// live (a CSS transform, or the caller's own onPreview) and commits once, on
// release, so the music relayouts a single time (spec principle 7, risk R1).
//
//   createPinch(el, {base = 1, min = 0, max = Infinity, moveTol = 8, preview = null, pan = false,
//     wheel = true, wheelCommitMs = 250, wheelStep = 0.01, shouldStart,
//     onStart, onPreview, onCommit, onCancel}) → {active, cancel(), setBase(v), destroy()}
//
// Every callback gets g = {factor, value, cx, cy, dx, dy, source: 'touch'|'wheel'}:
//   factor  the scale relative to the start of the gesture (finger spread now / at the start),
//           after clamping: value = clamp(base × factor, min, max), factor = value / base
//   cx, cy  the gesture centre at the start (client px), the anchor for the zoom
//   dx, dy  how far the centre has moved since the start (two-finger pan)
// Touch: two touch (or pen) pointers on el start a gesture (onStart); every move past
// moveTol previews (onPreview); lifting either finger commits (onCommit), or cancels
// (onCancel) when nothing moved past moveTol. Further fingers are ignored, and the rest of
// that touch sequence is too. While two fingers are down, native scrolling and Safari's page
// zoom are blocked.
// Wheel: ⌘/Ctrl + wheel (a trackpad pinch arrives as Ctrl + wheel) zooms at the cursor;
// it commits wheelCommitMs after the last wheel event.
// preview: an element to transform while the gesture runs (scale about the centre, plus the
// pan when `pan` is set); its inline transform is restored before onCommit/onCancel.
// shouldStart({source, clientX, clientY}) → false skips a gesture (the policy says 'none');
// a skipped wheel gesture is left to the browser.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const LINE_PX = 16;

export function createPinch(el, {
  base = 1, min = 0, max = Infinity, moveTol = 8, preview = null, pan = false,
  wheel = true, wheelCommitMs = 250, wheelStep = 0.01,
  shouldStart, onStart, onPreview, onCommit, onCancel,
} = {}) {
  let scaleBase = base;
  /** Touch/pen pointers on el: id → {x, y}. */
  const pointers = new Map();
  /** The running gesture: {source, ids: [a, b], d0, c0, cx, cy, moved, factor, dx, dy, origin, previous}. */
  let gesture = null;
  /** After a touch gesture ends, the remaining fingers are ignored until every one is up. */
  let draining = false;
  let wheelTimer = null;

  const call = (fn, g) => (typeof fn === 'function' ? fn(g) : undefined);
  const snapshot = () => {
    const value = clamp(scaleBase * gesture.factor, min, max);
    return {factor: value / scaleBase, value, cx: gesture.cx, cy: gesture.cy, dx: gesture.dx, dy: gesture.dy, source: gesture.source};
  };

  const applyPreview = g => {
    if (!preview) return;
    preview.style.transformOrigin = gesture.origin;
    preview.style.transform = `${pan ? `translate(${g.dx}px, ${g.dy}px) ` : ''}scale(${g.factor})`;
  };
  const clearPreview = () => {
    if (!preview || !gesture) return;
    preview.style.transform = gesture.previous.transform;
    preview.style.transformOrigin = gesture.previous.origin;
  };

  const begin = (source, cx, cy, extra = {}) => {
    if (typeof shouldStart === 'function' && shouldStart({source, clientX: cx, clientY: cy}) === false) return false;
    let origin = '';
    if (preview) {
      const r = preview.getBoundingClientRect();
      origin = `${cx - r.left}px ${cy - r.top}px`;
    }
    gesture = {source, cx, cy, moved: false, factor: 1, dx: 0, dy: 0, origin,
      previous: preview ? {transform: preview.style.transform, origin: preview.style.transformOrigin} : null, ...extra};
    call(onStart, snapshot());
    return true;
  };

  const finish = () => {
    if (!gesture) return;
    const g = snapshot();
    const changed = gesture.moved;
    clearPreview();
    gesture = null;
    call(changed ? onCommit : onCancel, g);
  };

  // ---- touch (pointer events)
  const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const centre = (a, b) => ({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});

  const onPointerDown = event => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    if (event.isPrimary) { pointers.clear(); draining = false; }
    pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (gesture || draining || pointers.size !== 2) return;
    const [[ia, a], [ib, b]] = [...pointers];
    const c = centre(a, b);
    const d0 = distance(a, b);
    if (d0 < 1) return;
    if (!begin('touch', c.x, c.y, {ids: [ia, ib], d0, c0: c})) { draining = true; return; }
    for (const id of [ia, ib]) { try { el.setPointerCapture?.(id); } catch { /* gone already */ } }
  };

  const onPointerMove = event => {
    const p = pointers.get(event.pointerId);
    if (!p) return;
    p.x = event.clientX; p.y = event.clientY;
    if (!gesture || gesture.source !== 'touch' || !gesture.ids.includes(event.pointerId)) return;
    const a = pointers.get(gesture.ids[0]), b = pointers.get(gesture.ids[1]);
    const d = distance(a, b), c = centre(a, b);
    gesture.dx = c.x - gesture.c0.x;
    gesture.dy = c.y - gesture.c0.y;
    gesture.factor = d / gesture.d0;
    if (!gesture.moved && (Math.abs(d - gesture.d0) > moveTol || Math.hypot(gesture.dx, gesture.dy) > moveTol)) gesture.moved = true;
    if (!gesture.moved) return;
    const g = snapshot();
    applyPreview(g);
    call(onPreview, g);
  };

  const onPointerEnd = event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (gesture?.source === 'touch' && gesture.ids.includes(event.pointerId)) {
      if (event.type === 'pointercancel') {
        const g = snapshot();
        clearPreview();
        gesture = null;
        call(onCancel, g);
      } else {
        finish();
      }
      draining = pointers.size > 0;
    }
    if (!pointers.size) draining = false;
  };

  // Two fingers down: no native scroll, no page zoom.
  const onTouchMove = event => {
    if ((event.touches?.length ?? 0) >= 2 && event.cancelable) event.preventDefault();
  };
  const onGesture = event => { if (event.cancelable) event.preventDefault(); };

  // ---- wheel (⌘/Ctrl + wheel, trackpad pinch)
  const onWheel = event => {
    if (!wheel || !(event.ctrlKey || event.metaKey)) return;
    if (gesture && gesture.source !== 'wheel') return;
    if (!gesture && !begin('wheel', event.clientX, event.clientY)) return;
    event.preventDefault();
    const dy = event.deltaMode === 1 ? event.deltaY * LINE_PX : event.deltaMode === 2 ? event.deltaY * (el.clientHeight || 800) : event.deltaY;
    const value = clamp(scaleBase * gesture.factor * Math.exp(-dy * wheelStep), min, max);
    gesture.factor = value / scaleBase;
    gesture.moved = true;
    const g = snapshot();
    applyPreview(g);
    call(onPreview, g);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { wheelTimer = null; if (gesture?.source === 'wheel') finish(); }, wheelCommitMs);
  };

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerEnd);
  el.addEventListener('pointercancel', onPointerEnd);
  el.addEventListener('touchmove', onTouchMove, {passive: false});
  el.addEventListener('gesturestart', onGesture);
  el.addEventListener('gesturechange', onGesture);
  el.addEventListener('wheel', onWheel, {passive: false});

  const api = {
    /** True while a gesture is running. */
    get active() { return !!gesture; },
    /** Abandons the running gesture: the preview is undone and onCancel fires. */
    cancel() {
      if (!gesture) return;
      clearTimeout(wheelTimer);
      wheelTimer = null;
      const g = snapshot();
      clearPreview();
      gesture = null;
      draining = pointers.size > 0;
      call(onCancel, g);
    },
    /** The value the next gesture scales from (the surface's current scale after a commit). */
    setBase(v) { if (Number.isFinite(v) && v > 0) scaleBase = v; },
    get base() { return scaleBase; },
    destroy() {
      clearTimeout(wheelTimer);
      clearPreview();
      gesture = null;
      pointers.clear();
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerEnd);
      el.removeEventListener('pointercancel', onPointerEnd);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('gesturestart', onGesture);
      el.removeEventListener('gesturechange', onGesture);
      el.removeEventListener('wheel', onWheel);
    },
  };
  return api;
}
