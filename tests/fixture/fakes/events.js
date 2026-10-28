// Event plumbing shared by the fakes. A fake object built on EventTarget has
// on<type> handler properties like the real one, but browsers call those only
// for native targets, while happy-dom calls them for every EventTarget. This
// calls the handler exactly once either way.
export function fireWithHandler(target, event, handler) {
  const fn = target[handler];
  if (typeof fn !== 'function') { target.dispatchEvent(event); return; }
  let called = false;
  target[handler] = function onEvent(e) { called = true; return fn.call(this, e); };
  try { target.dispatchEvent(event); } finally { target[handler] = fn; }
  if (!called) fn.call(target, event);
}
