// The press recogniser for music surfaces (D50, architecture §2.14.8). One
// recogniser per surface element turns pointer input into gestures; the surface
// hit-tests each gesture (adding t/bar) and applies glass.pressPolicy.
//
//   createPressRecognizer(el, {longMs = 350, doubleMs = 300, moveTol = 8, haptic,
//     onTap, onDouble, onLongStart, onLongDrag, onLongEnd, onMenu, onDragStart, onDrag, onDragEnd,
//     touchAction = 'pan-y'}) → off
//
// Touch and pen:
//   - a press held longMs without moving more than moveTol fires haptic() and onLongStart(e);
//     moving afterwards fires onLongDrag(e, {dx, dy}) on every move, and the release
//     onLongEnd(e, {dragged: true}). Scrolling is blocked for the rest of that press.
//     When onLongStart returns false (glass.pressPolicy says 'scroll' for a long drag: touch
//     while playing) the press stays scrollable instead: no capture, no blocked touchmove, and
//     moving past moveTol hands it to the browser with onLongEnd(e, {dragged: false,
//     cancelled: true}) (no onLongDrag, no menu). Releasing it still ends it and opens the menu.
//   - releasing a long press without moving fires onLongEnd(e, {dragged: false}), then onMenu(e).
//   - moving more than moveTol before longMs gives the press to the browser (native scroll,
//     `touch-action: pan-y`): nothing fires.
//   - a quick release is onTap(e); a second tap within doubleMs (and 3 × moveTol) is onDouble(e)
//     instead of a second onTap. onTap never waits for the double window.
//   - a second finger cancels the press (a pinch is pinch.js's); a long press then ends with
//     onLongEnd(e, {dragged, cancelled: true}) and no menu.
// Mouse:
//   - button 0: moving more than moveTol starts a drag at once: onDragStart(e), onDrag(e) per
//     move, onDragEnd(e) on release (pointer capture held). A release without moving is a tap
//     or double click as above.
//   - right-click (contextmenu), Shift+F10 and the ContextMenu key on the element → onMenu(e).
//     The keyboard paths place e at the focused element's centre and set e.keyboard. A macOS
//     Ctrl-click (button-0 pointerdown, then contextmenu) is a menu only: the pending press ends.
//   - a release outside el (no capture before a drag) drops the press: no tap, no later drag.
// Pen: only the tip (button 0) presses; the barrel button's contextmenu is a right-click → onMenu.
// The gesture object e = {clientX, clientY, pointerType: 'mouse'|'touch'|'pen', button, altKey,
//   shiftKey, ctrlKey, metaKey, target, event, keyboard?, cancelled?}; the surface adds t/bar.
// Cooperation with other layers (loop-handles.js): a press that starts inside
// [data-press-ignore] is not seen at all, and a mouse drag that starts inside
// [data-press-nodrag] never becomes a drag (taps there still count).
// pointercancel ends whatever is running with cancelled: true (no tap, no menu).

/** navigator.vibrate where it exists (platform.haptic, §2.11); a no-op otherwise. */
export function defaultHaptic(ms = 8) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
  } catch {
    // Some browsers throw when vibration is blocked by policy; a missing haptic is fine.
  }
}

const DOUBLE_TOL_FACTOR = 3;
/** How long after a handled menu the browser's own contextmenu event is swallowed. */
const SUPPRESS_MS = 800;

function gesture(event, extra = {}) {
  return {
    clientX: event.clientX, clientY: event.clientY,
    pointerType: event.pointerType || 'mouse', button: event.button ?? 0,
    altKey: !!event.altKey, shiftKey: !!event.shiftKey, ctrlKey: !!event.ctrlKey, metaKey: !!event.metaKey,
    target: event.target, event, ...extra,
  };
}

function centreOf(node) {
  const r = node?.getBoundingClientRect?.();
  return r ? {clientX: r.left + r.width / 2, clientY: r.top + r.height / 2} : {clientX: 0, clientY: 0};
}

/**
 * Attaches the recogniser to `el` and returns `off()`, which removes every listener, clears
 * timers and restores the element's touch-action and consume-keys attributes.
 */
export function createPressRecognizer(el, {
  longMs = 350, doubleMs = 300, moveTol = 8, haptic = defaultHaptic, touchAction = 'pan-y',
  onTap, onDouble, onLongStart, onLongDrag, onLongEnd, onMenu, onDragStart, onDrag, onDragEnd,
} = {}) {
  /** The press in progress: {id, pointerType, x0, y0, phase: 'down'|'long'|'longDrag'|'drag'|'nodrag', nodrag, timer}. */
  let press = null;
  /** The last tap, while the double window is open: {pointerType, x, y, timer}. */
  let lastTap = null;
  /** Pointers currently down on el (to see a second finger). */
  const down = new Set();
  let suppressContextMenu = false;
  const win = el.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
  let suppressTimer = null;
  const suppressMenuEvent = () => {
    suppressContextMenu = true;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => { suppressContextMenu = false; suppressTimer = null; }, SUPPRESS_MS);
  };

  const call = (fn, ...args) => (typeof fn === 'function' ? fn(...args) : undefined);
  const clearLong = () => { if (press?.timer) { clearTimeout(press.timer); press.timer = null; } };
  const clearTap = () => { if (lastTap?.timer) clearTimeout(lastTap.timer); lastTap = null; };
  const capture = id => { try { el.setPointerCapture?.(id); } catch { /* the pointer is already gone */ } };
  const release = id => { try { if (el.hasPointerCapture?.(id)) el.releasePointerCapture(id); } catch { /* already released */ } };

  const tapped = event => {
    const e = gesture(event);
    const tol = moveTol * DOUBLE_TOL_FACTOR;
    if (lastTap && lastTap.pointerType === e.pointerType && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) <= tol) {
      clearTap();
      call(onDouble, e);
      return;
    }
    clearTap();
    lastTap = {pointerType: e.pointerType, x: e.clientX, y: e.clientY, timer: setTimeout(() => { lastTap = null; }, doubleMs)};
    call(onTap, e);
  };

  const cancel = (event, {silent = false} = {}) => {
    if (!press) return;
    const p = press;
    clearLong();
    press = null;
    release(p.id);
    if (silent) return;
    if (p.phase === 'long' || p.phase === 'longDrag') call(onLongEnd, gesture(event, {cancelled: true}), {dragged: p.phase === 'longDrag', cancelled: true});
    else if (p.phase === 'drag') call(onDragEnd, gesture(event, {cancelled: true}));
  };

  const onPointerDown = event => {
    if (event.target?.closest?.('[data-press-ignore]')) return;
    // A primary pointer means no other pointer of its kind is down: forget any stale ones.
    if (event.isPrimary) down.clear();
    down.add(event.pointerId);
    if (press) {
      // A second pointer (a pinch, a palm): the press is no longer a press. A new primary
      // pointer means the old press lost its pointerup: it ends, and this one starts.
      cancel(event);
      if (!event.isPrimary) return;
    }
    if (down.size > 1) return;
    const pointerType = event.pointerType || 'mouse';
    // Right-click and the pen's barrel button go through contextmenu (touch reports button 0).
    if (pointerType !== 'touch' && event.button !== 0) return;
    press = {id: event.pointerId, pointerType, x0: event.clientX, y0: event.clientY, phase: 'down', timer: null,
      nodrag: !!event.target?.closest?.('[data-press-nodrag]')};
    if (pointerType === 'mouse') return;
    press.timer = setTimeout(() => {
      if (!press || press.phase !== 'down') return;
      press.timer = null;
      press.phase = 'long';
      capture(press.id);
      clearTap();
      call(haptic, 8);
      const p = press;
      if (call(onLongStart, gesture(event)) === false && press === p) {
        // The surface declines long drags (playing touch): the press stays scrollable.
        p.scrolls = true;
        release(p.id);
      }
    }, longMs);
  };

  const onPointerMove = event => {
    if (!press || event.pointerId !== press.id) return;
    const dx = event.clientX - press.x0, dy = event.clientY - press.y0;
    const moved = Math.hypot(dx, dy) > moveTol;
    switch (press.phase) {
      case 'down':
        if (!moved) return;
        if (press.pointerType === 'mouse') {
          if (press.nodrag) { press.phase = 'nodrag'; return; }
          press.phase = 'drag';
          capture(press.id);
          clearTap();
          call(onDragStart, gesture(event));
          call(onDrag, gesture(event));
          return;
        }
        // Touch or pen moved before the long press: it is a scroll, the browser's.
        clearLong();
        press = null;
        return;
      case 'long':
        if (!moved) return;
        if (press.scrolls) {
          // A declined long press that moves is the browser's scroll.
          press = null;
          call(onLongEnd, gesture(event, {cancelled: true}), {dragged: false, cancelled: true});
          return;
        }
        press.phase = 'longDrag';
        call(onLongDrag, gesture(event), {dx, dy});
        return;
      case 'longDrag':
        call(onLongDrag, gesture(event), {dx, dy});
        return;
      case 'drag':
        call(onDrag, gesture(event));
        return;
      default:
    }
  };

  const onPointerUp = event => {
    down.delete(event.pointerId);
    if (!press || event.pointerId !== press.id) return;
    const p = press;
    clearLong();
    press = null;
    release(p.id);
    switch (p.phase) {
      case 'down': tapped(event); break;
      case 'long':
        call(onLongEnd, gesture(event), {dragged: false});
        suppressMenuEvent();
        call(onMenu, gesture(event));
        break;
      case 'longDrag': call(onLongEnd, gesture(event), {dragged: true}); break;
      case 'drag': call(onDragEnd, gesture(event)); break;
      default:
    }
  };

  const onPointerCancel = event => {
    down.delete(event.pointerId);
    if (press && event.pointerId === press.id) cancel(event);
  };

  const onContextMenu = event => {
    // Touch and pen long presses are ours (the timer above); the browser's own long-press menu is
    // suppressed. A pen contextmenu with no pen press of ours is the barrel button: a right-click.
    const fromTouch = event.pointerType === 'touch' || (press && press.pointerType !== 'mouse') || suppressContextMenu;
    event.preventDefault();
    if (fromTouch) return;
    if (press?.phase === 'drag') return;
    // A macOS Ctrl-click: the button-0 press that began it is the menu, not a tap.
    if (press) cancel(event, {silent: true});
    const keyboard = event.button === -1 || (event.clientX === 0 && event.clientY === 0 && event.detail === 0);
    if (keyboard) {
      const focused = el.contains(document.activeElement) ? document.activeElement : el;
      call(onMenu, gesture(event, {...centreOf(focused), pointerType: 'mouse', keyboard: true, target: focused}));
      return;
    }
    clearTap();
    call(onMenu, gesture(event, {pointerType: event.pointerType === 'pen' ? 'pen' : 'mouse'}));
  };

  const onKeyDown = event => {
    const isMenuKey = event.key === 'ContextMenu' || event.code === 'ContextMenu' || (event.shiftKey && (event.key === 'F10' || event.code === 'F10'));
    if (!isMenuKey || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    event.preventDefault();
    // The browser may follow with its own contextmenu event (Windows sends it on keyup): handled already.
    suppressMenuEvent();
    const focused = el.contains(document.activeElement) ? document.activeElement : el;
    call(onMenu, gesture(event, {...centreOf(focused), pointerType: 'mouse', keyboard: true, target: focused, button: 0}));
  };

  // Long-press drags must not scroll; nor may a press that has become a long press.
  const onTouchMove = event => {
    if (press && !press.scrolls && (press.phase === 'long' || press.phase === 'longDrag') && event.cancelable) event.preventDefault();
  };

  // A mouse press released outside el before it became a drag (no capture yet): the pointerup
  // never reaches el, so it is caught here and the press dropped (a later hover is not a drag).
  const onWindowPointerUp = event => {
    if (!press || press.pointerType !== 'mouse' || event.pointerId !== press.id) return;
    try { if (el.contains(event.target)) return; } catch { /* not a node: outside */ }
    if (press.phase !== 'down' && press.phase !== 'nodrag') return;
    clearLong();
    press = null;
  };

  const previousTouchAction = el.style.touchAction;
  const previousCallout = el.style.webkitTouchCallout;
  const previousConsume = el.getAttribute('data-consume-keys');
  if (touchAction != null) el.style.touchAction = touchAction;
  el.style.webkitTouchCallout = 'none';
  const consumed = new Set((previousConsume ?? '').split(/\s+/).filter(Boolean));
  consumed.add('ContextMenu');
  el.setAttribute('data-consume-keys', [...consumed].join(' '));

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerCancel);
  el.addEventListener('lostpointercapture', onPointerCancelIfCaptured);
  el.addEventListener('contextmenu', onContextMenu);
  el.addEventListener('keydown', onKeyDown);
  el.addEventListener('touchmove', onTouchMove, {passive: false});
  win?.addEventListener('pointerup', onWindowPointerUp, true);

  // Losing capture without a pointerup (the element was hidden, another capture) is a cancel.
  function onPointerCancelIfCaptured(event) {
    // Only el's own capture: a child losing its implicit capture to el bubbles here too.
    if (event.target !== el) return;
    if (!press || event.pointerId !== press.id || press.phase === 'down') return;
    queueMicrotask(() => { if (press && press.id === event.pointerId && press.phase !== 'down') cancel(event); });
  }

  return function off() {
    cancel(null, {silent: true});
    clearTap();
    clearTimeout(suppressTimer);
    down.clear();
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('pointercancel', onPointerCancel);
    el.removeEventListener('lostpointercapture', onPointerCancelIfCaptured);
    el.removeEventListener('contextmenu', onContextMenu);
    el.removeEventListener('keydown', onKeyDown);
    el.removeEventListener('touchmove', onTouchMove);
    win?.removeEventListener('pointerup', onWindowPointerUp, true);
    el.style.touchAction = previousTouchAction;
    el.style.webkitTouchCallout = previousCallout ?? '';
    if (previousConsume == null) el.removeAttribute('data-consume-keys');
    else el.setAttribute('data-consume-keys', previousConsume);
  };
}
