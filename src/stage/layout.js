// The Stage's layout rules (architecture §2.14.9, spec §4.1, §4.10, §4.11): the rail/band
// decision, the Distance metrics, the rail width, the Focus geometry and the 150 ms debounced
// relayout. Everything here is pure and takes dimensions as inputs (§0.1): stage.js measures
// the window and passes the numbers in; nothing reads the DOM except applyStageAttributes,
// which only writes the data attributes the tokens key on (§7.2).
//
//   stageLayout({vw, vh}) → 'rail' | 'band'      (vw / vh ≥ 1.15 && vw ≥ 1000) ? 'rail' : 'band'
//   railWidth({distance, vw, focus}) → px        near 232 · stand 264 · kit 312; −32 when vw < 1280; Focus: 120
//   DISTANCE                                     {near: .8, stand: 1, kit: 1.3}
//   chartScale({distance, layout, orientation})  rail 1.1 / 1.3 / 1.6; band (iPad portrait) 1.0 / 1.2 / 1.5
//   readoutSizes({distance, layout})             Position and Section px (spec §4.11 table)
//   stageGeometry({vw, vh, distance, focus, safeTop, safeBottom}) → the frame's boxes (spec §4.1 budgets)
//   focusGeometry({layout})                      what Focus hides or collapses (spec §4.10)
//   applyStageAttributes(root, {layout, distance, focus, playing, narrow})
//   createLayoutWatcher({measure, onChange, delayMs = 150, timer}) → {schedule, flush, current, destroy}
//     one relayout per settled resize or rotation; the caller keeps the anchor (surface.anchor() →
//     surface.reveal()), so the playing bar stays at the same screen fraction.

export const RAIL_RATIO = 1.15;
export const RAIL_MIN_VW = 1000;
export const NARROW_VW = 1280;
export const NARROW_DELTA = 32;
export const MINI_RAIL = 120;
export const LAYOUT_DEBOUNCE_MS = 150;
export const DISTANCES = Object.freeze(['near', 'stand', 'kit']);
export const DEFAULT_DISTANCE = 'stand';
export const DISTANCE = Object.freeze({near: 0.8, stand: 1, kit: 1.3});
export const RAIL_WIDTHS = Object.freeze({near: 232, stand: 264, kit: 312});

const CHART_SCALES = Object.freeze({
  rail: Object.freeze({near: 1.1, stand: 1.3, kit: 1.6}),
  band: Object.freeze({near: 1.0, stand: 1.2, kit: 1.5}),
});
const POSITION_PX = Object.freeze({
  rail: Object.freeze({near: 52, stand: 64, kit: 84}),
  band: Object.freeze({near: 44, stand: 56, kit: 72}),
});
const SECTION_PX = Object.freeze({near: 32, stand: 40, kit: 52});

/** Fixed heights of the frame (spec §4.1, §4.5, §4.6): the strip, the band dock, the Focus reveal zone. */
export const FRAME = Object.freeze({
  strip: 56,
  dock: 88,
  revealZone: 72,
  revealMs: 5000,
  // The band HUD (ST5): the identity row and the readouts; listed so the budget adds up.
  identity: 44,
  readouts: 88,
});

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** A Distance name, defaulting to Stand. */
export function distanceOf(value) {
  return DISTANCES.includes(value) ? value : DEFAULT_DISTANCE;
}

/** 'rail' or 'band' (spec §4.1). */
export function stageLayout({vw, vh} = {}) {
  const w = num(vw), h = num(vh);
  if (!(w > 0) || !(h > 0)) return 'band';
  return w / h >= RAIL_RATIO && w >= RAIL_MIN_VW ? 'rail' : 'band';
}

/** True when the rail is the 32 px slimmer variant (`[data-rail-narrow]`). */
export function isNarrow({vw} = {}) {
  return num(vw, Infinity) < NARROW_VW;
}

/** The rail's width in px: by Distance, 32 px less below 1280 px, 120 px in Focus (the mini rail). */
export function railWidth({distance, vw, focus = false} = {}) {
  if (focus) return MINI_RAIL;
  const base = RAIL_WIDTHS[distanceOf(distance)];
  return isNarrow({vw}) ? base - NARROW_DELTA : base;
}

/** The chart's default scale for a Distance and layout (spec §4.4A, §4.11). */
export function chartScale({distance, layout, orientation} = {}) {
  const kind = layout === 'rail' || layout === 'band' ? layout : orientation === 'landscape' ? 'rail' : 'band';
  return CHART_SCALES[kind][distanceOf(distance)];
}

/** The Position and Section readout sizes (px) the tokens produce (spec §4.11; probe-readouts checks them). */
export function readoutSizes({distance, layout} = {}) {
  const d = distanceOf(distance);
  return {position: POSITION_PX[layout === 'rail' ? 'rail' : 'band'][d], section: SECTION_PX[d], factor: DISTANCE[d]};
}

/** What Focus changes (spec §4.10): the band hides chrome by height only; the rail collapses to the mini rail. */
export function focusGeometry({layout} = {}) {
  if (layout === 'rail') return {relayout: true, railWidth: MINI_RAIL, hides: [], mini: ['section', 'position', 'lamps', 'speed', 'play']};
  return {relayout: false, railWidth: 0, hides: ['identity', 'strip', 'dock'], revealZone: FRAME.revealZone, revealMs: FRAME.revealMs};
}

/**
 * The frame's boxes for a viewport (spec §4.1): the music column and, per layout, the rail or the
 * band rows. `safeTop`/`safeBottom` are the safe-area insets (the iPad status bar and home bar).
 */
export function stageGeometry({vw, vh, distance, focus = false, safeTop = 0, safeBottom = 0} = {}) {
  const w = Math.max(0, num(vw)), h = Math.max(0, num(vh));
  const layout = stageLayout({vw: w, vh: h});
  const top = Math.max(0, num(safeTop)), bottom = Math.max(0, num(safeBottom));
  if (layout === 'rail') {
    const rail = railWidth({distance, vw: w, focus});
    return {layout, narrow: isNarrow({vw: w}), rail, music: {width: Math.max(0, w - rail), height: Math.max(0, h - FRAME.strip)}, strip: FRAME.strip, dock: 0};
  }
  const chrome = focus
    ? top + FRAME.readouts + bottom
    : top + FRAME.identity + FRAME.readouts + FRAME.strip + FRAME.dock + bottom;
  return {
    layout, narrow: isNarrow({vw: w}), rail: 0,
    music: {width: w, height: Math.max(0, h - chrome)},
    strip: focus ? 0 : FRAME.strip, dock: focus ? 0 : FRAME.dock,
  };
}

/** Writes the Stage root's data attributes (the tokens key on them, §7.2). Only changed values are touched. */
export function applyStageAttributes(root, {layout, distance, focus = false, playing = false, narrow = false} = {}) {
  if (!root) return;
  const set = (name, value) => {
    if (value == null || value === false) { if (root.hasAttribute(name)) root.removeAttribute(name); return; }
    const v = value === true ? '' : String(value);
    if (root.getAttribute(name) !== v) root.setAttribute(name, v);
  };
  set('data-stage-layout', layout === 'rail' ? 'rail' : 'band');
  set('data-distance', distanceOf(distance));
  set('data-focus', !!focus);
  set('data-playing', !!playing);
  set('data-rail-narrow', layout === 'rail' && !!narrow);
}

const defaultTimer = () => ({
  set: (fn, ms) => globalThis.setTimeout(fn, ms),
  clear: (id) => globalThis.clearTimeout(id),
});

/** The layout-relevant part of a geometry: a change in any of these is a relayout. */
const keyOf = (g) => `${g.layout}|${g.narrow}`;

/**
 * Debounced relayout (spec §4.1): `schedule()` on every resize or orientation change; once the
 * viewport has been still for `delayMs`, `measure()` → {vw, vh} is read and, when the layout or
 * the rail variant changed, `onChange(next, prev)` runs once. `flush()` runs a pending check now.
 */
export function createLayoutWatcher({measure, onChange, delayMs = LAYOUT_DEBOUNCE_MS, timer = defaultTimer()} = {}) {
  if (typeof measure !== 'function') throw new TypeError('createLayoutWatcher: measure() is required');
  const read = () => {
    const {vw, vh} = measure() ?? {};
    return {layout: stageLayout({vw, vh}), narrow: isNarrow({vw}), vw: num(vw), vh: num(vh)};
  };
  let current = read();
  let pending = null;
  let destroyed = false;
  const check = () => {
    pending = null;
    if (destroyed) return;
    const next = read();
    const prev = current;
    current = next;
    if (keyOf(next) !== keyOf(prev)) onChange?.(next, prev);
  };
  return {
    get current() { return current; },
    schedule() {
      if (destroyed) return;
      if (pending != null) timer.clear(pending);
      pending = timer.set(check, delayMs);
    },
    flush() {
      if (pending == null) return;
      timer.clear(pending);
      check();
    },
    destroy() {
      destroyed = true;
      if (pending != null) timer.clear(pending);
      pending = null;
    },
  };
}
