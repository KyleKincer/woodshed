// Glass: what a press on the music does (architecture §2.14.8, spec §4.9).
//
// "Glass for fingers, not for mice": while playing, one stray touch can never
// seek, loop or navigate, while a mouse (deliberate) acts at once. Every music
// surface asks this one pure table what a recognised gesture means; the press
// recogniser (`press.js`) only classifies gestures and the surface carries out
// the returned action.
//
//   pressPolicy({pointerType, playing, gesture}) → action
//
// Gestures: 'tap' | 'double' | 'long' (released without a drag) | 'context'
// (right-click, Shift+F10, the ContextMenu key) | 'longDrag' (touch/pen: held
// 350 ms, then dragged, D50) | 'drag' | 'wheel' | 'pinch' (or ⌘-wheel).
//
// Actions: 'cue' (nearest beat when mapped) | 'seek' | 'pill' ("▶ Play from bar
// 23" for 3 s; tapping the pill → 'jump') | 'playFrom' | 'jump' | 'menu' (the bar
// menu) | 'loopDrag' | 'scroll' (Follow pauses) | 'zoom' | 'none'.
//
// Pure: no imports, no DOM. It is on the commands modules' PURE_HELPERS list.

export const GESTURES = Object.freeze(['tap', 'double', 'long', 'context', 'longDrag', 'drag', 'wheel', 'pinch']);
export const ACTIONS = Object.freeze(['cue', 'seek', 'pill', 'playFrom', 'jump', 'menu', 'loopDrag', 'scroll', 'zoom', 'none']);

/**
 * The spec §4.9 table, one row per gesture. Columns: `stopped` is the same for
 * every pointer unless it is split by pointer kind (`{mouse, touch}`); `touch`
 * covers touch and pen while playing; `mouse` is a mouse while playing.
 */
export const POLICY = Object.freeze({
  tap:      Object.freeze({stopped: 'cue',      touch: 'pill',   mouse: 'seek'}),
  double:   Object.freeze({stopped: 'playFrom', touch: 'jump',   mouse: 'jump'}),
  long:     Object.freeze({stopped: 'menu',     touch: 'menu',   mouse: 'menu'}),
  context:  Object.freeze({stopped: 'menu',     touch: 'menu',   mouse: 'menu'}),
  // No loop drags on touch while playing; a mouse never long-presses (press.js drags at once).
  longDrag: Object.freeze({stopped: 'loopDrag', touch: 'scroll', mouse: 'none'}),
  drag:     Object.freeze({stopped: Object.freeze({mouse: 'loopDrag', touch: 'scroll'}), touch: 'scroll', mouse: 'loopDrag'}),
  wheel:    Object.freeze({stopped: 'scroll',   touch: 'scroll', mouse: 'scroll'}),
  pinch:    Object.freeze({stopped: 'zoom',     touch: 'zoom',   mouse: 'none'}),
});

/**
 * 'mouse' acts deliberately; 'touch' and 'pen' are fingers on glass. Anything
 * else (an empty or unknown `pointerType`, which some browsers report for
 * synthetic events) is treated as touch: the conservative reading never seeks
 * or loops by accident while playing.
 */
export const pointerKind = (pointerType) => (pointerType === 'mouse' ? 'mouse' : 'touch');

/** What a gesture on the music does. Unknown gestures do nothing ('none'). */
export function pressPolicy({pointerType, playing = false, gesture} = {}) {
  const row = Object.prototype.hasOwnProperty.call(POLICY, gesture) ? POLICY[gesture] : null;
  if (!row) return 'none';
  const kind = pointerKind(pointerType);
  if (!playing) return typeof row.stopped === 'string' ? row.stopped : row.stopped[kind];
  return row[kind];
}

export default pressPolicy;
