const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

// Clamp the window as a whole: hitting either boundary must not change zoom.
export function boundedView(start, end, duration, minimum = 0.25) {
  const span = clamp(end - start, Math.min(minimum, duration), duration);
  start = clamp(start, 0, duration - span);
  return {start, end: start + span};
}

export function wheelNavigation() {
  let lastTime = -Infinity, mode, modifier;
  return (event, width, now = performance.now()) => {
    const nextModifier = event.ctrlKey || event.metaKey ? 'zoom' : event.shiftKey ? 'pan' : '';
    if (now - lastTime > 200 || modifier !== nextModifier) {
      mode = nextModifier || (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? 'pan' : 'zoom');
    }
    modifier = nextModifier;
    lastTime = now;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1;
    // Keep one interpretation for the entire gesture, including momentum tails.
    const delta = mode === 'pan' ? (event.shiftKey ? event.deltaX || event.deltaY : event.deltaX) : event.deltaY;
    return {mode, delta: delta * scale};
  };
}
