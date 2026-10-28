// fx-nofeature=<list> (architecture §2.11, §10.6): remove browser features so
// the Safari and older-browser fallbacks render in Chromium. Removal happens
// before any fake is installed; a removed feature is never faked.
//   anchor          CSS anchor positioning (CSS.supports and the style properties)
//   popover         the Popover API (showPopover/hidePopover/togglePopover, popover, :popover-open)
//   wakelock        navigator.wakeLock
//   midi            navigator.requestMIDIAccess
//   mediasession    navigator.mediaSession and MediaMetadata
//   viewtransition  document.startViewTransition (and view-transition CSS)
//   share           navigator.share and navigator.canShare
//   clipboard       navigator.clipboard
export const FEATURES = ['anchor', 'popover', 'wakelock', 'midi', 'mediasession', 'viewtransition', 'share', 'clipboard'];

const CSS_PATTERNS = {
  anchor: /anchor|position-area|position-try|inset-area/i,
  popover: /popover/i,
  viewtransition: /view-transition/i,
};

/** Parse "a,b , c" into a Set of known feature names; unknown names are reported. */
export function parseFeatures(list, win = globalThis) {
  const out = new Set();
  for (const raw of String(list ?? '').split(',')) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if (FEATURES.includes(name)) out.add(name);
    else win.console.error(`[fixture] fx-nofeature: unknown feature ${JSON.stringify(name)} (known: ${FEATURES.join(', ')})`);
  }
  return out;
}

function remove(target, key) {
  if (!target) return;
  try { delete target[key]; } catch { /* not configurable */ }
  if (key in target) {
    try { Object.defineProperty(target, key, {configurable: true, value: undefined}); } catch { /* frozen */ }
  }
}

/** Remove every feature in `names` from `win`; returns the Set of removed names. */
export function removeFeatures(win, names) {
  const set = names instanceof Set ? names : parseFeatures(names, win);
  const nav = win.navigator, NavProto = win.Navigator?.prototype;
  const fromNavigator = key => { remove(NavProto, key); if (key in nav) remove(nav, key); };
  if (set.has('wakelock')) fromNavigator('wakeLock');
  if (set.has('midi')) fromNavigator('requestMIDIAccess');
  if (set.has('mediasession')) { fromNavigator('mediaSession'); remove(win, 'MediaMetadata'); }
  if (set.has('share')) { fromNavigator('share'); fromNavigator('canShare'); }
  if (set.has('clipboard')) fromNavigator('clipboard');
  if (set.has('viewtransition')) { remove(win.Document?.prototype, 'startViewTransition'); remove(win.document, 'startViewTransition'); remove(win, 'ViewTransition'); }
  if (set.has('popover')) {
    const proto = win.HTMLElement?.prototype;
    for (const key of ['showPopover', 'hidePopover', 'togglePopover', 'popover']) remove(proto, key);
    remove(win.HTMLButtonElement?.prototype, 'popoverTargetElement');
    remove(win.HTMLButtonElement?.prototype, 'popoverTargetAction');
    remove(win, 'ToggleEvent');
  }
  if (set.has('anchor')) {
    const style = win.CSSStyleDeclaration?.prototype;
    for (const key of ['anchorName', 'positionAnchor', 'positionArea', 'positionTry', 'positionTryFallbacks', 'positionTryOrder', 'positionVisibility', 'insetArea', 'anchorScope'])
      remove(style, key);
  }
  const patterns = [...set].map(name => CSS_PATTERNS[name]).filter(Boolean);
  const css = win.CSS;
  if (patterns.length && css?.supports) {
    const native = css.supports.bind(css);
    const supports = (...args) => (patterns.some(re => re.test(args.join(' '))) ? false : native(...args));
    try { Object.defineProperty(css, 'supports', {configurable: true, writable: true, value: supports}); } catch { css.supports = supports; }
    // Keep the patched namespace when window.CSS is a getter returning a fresh object.
    if (win.CSS !== css) Object.defineProperty(win, 'CSS', {configurable: true, writable: true, value: css});
  }
  return set;
}
