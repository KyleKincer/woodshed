// Row layout for the Road map and the Wave page (architecture §2.14.12, spec §4.4B/C). Pure:
// every dimension is an input (§0.1), nothing touches the DOM, and nothing is imported, so the
// commands modules may use it (PURE_HELPERS, §7.6) and the tests need no layout engine.
//
// Road map (a mapped song): a lead-sheet "page of bars", read top to bottom.
//   - 4 bars per row on the band, 8 on the rail when the music is at least 1100 px wide.
//   - A row breaks at every section start and every meter change; a long section wraps.
//   - The first row of a section carries its heading ("Chorus · bars 13–20").
//   - A row holding the start of a spot (or of a marker flag) gets a flag lane above its cells.
//   - Cells are 88 px × Distance tall and share one width per layout (a short row keeps it).
// Wave page (unmapped): rows of a fixed time span, 10 s on the rail and 8 s on the band
//   (4–30 s through = / − or a pinch), with a time lane (second ticks, labels every 5 s) above
//   the waveform and the same flag lane for markers and spots.
//
// All positions are in the content box of the surface's scroller (y from its top, x from its left).
// Times are media seconds. Rows are ordered by time and by y; lookups are binary searches, so the
// per-frame path (rowOfTime, xOfTime) stays O(log n).

export const CELL_H = 88;
export const HEADING_H = 36;
export const FLAG_H = 26;
export const TIME_H = 22;
export const ROW_GAP = 12;
export const PAD_X = 16;
export const PAD_TOP = 16;
export const PAD_BOTTOM = 24;
/** The music width from which the rail shows 8 bars per row (spec §4.4B). */
export const WIDE_MUSIC = 1100;
/** The follow line: the current row is held this far down the viewport (spec §4.4B). */
export const FOLLOW_ANCHOR = 0.3;
/** Wave page row lengths (s): the default per layout and the = / − steps (4–30 s, spec §4.4C). */
export const WAVE_SECONDS = Object.freeze({rail: 10, band: 8});
export const WAVE_STEPS = Object.freeze([4, 5, 6, 8, 10, 12, 15, 20, 25, 30]);
export const WAVE_MIN = WAVE_STEPS[0];
export const WAVE_MAX = WAVE_STEPS[WAVE_STEPS.length - 1];
/** Second ticks every second, a label every 5 s (spec §4.4C). */
export const LABEL_EVERY = 5;

const EPS = 1e-6;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** Bars per Road map row: 8 on the rail with ≥ 1100 px of music, else 4. */
export function barsPerRow({layout, width} = {}) {
  return layout === 'rail' && finite(width) && width >= WIDE_MUSIC ? 8 : 4;
}

/** The row metrics at a Distance factor (0.8 Near, 1 Stand, 1.3 Kit). */
export function metrics(distance = 1) {
  const d = finite(distance) && distance > 0 ? distance : 1;
  return {
    cellH: Math.round(CELL_H * d), headingH: Math.round(HEADING_H * d), flagH: Math.round(FLAG_H * d),
    timeH: Math.round(TIME_H * d), gap: Math.round(ROW_GAP * d), padX: PAD_X, padTop: PAD_TOP,
  };
}

/** The bottom padding that lets the last row reach the follow line. */
function bottomPad(viewportH, lastH) {
  const v = finite(viewportH) ? viewportH : 0;
  return Math.max(PAD_BOTTOM, Math.round(v * (1 - FOLLOW_ANCHOR) - lastH));
}

/** Sorted, finite flag times. */
const flagTimes = (flags) => (Array.isArray(flags) ? flags.map((f) => (typeof f === 'number' ? f : f?.t)).filter(finite).sort((a, b) => a - b) : []);

/** True when a sorted time list has a value in [t0, t1) (or [t0, t1] for the last row). */
function anyIn(times, t0, t1, last) {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t0 - EPS) lo = mid + 1; else hi = mid; }
  if (lo >= times.length) return false;
  const t = times[lo];
  return last ? t <= t1 + EPS : t < t1 - EPS;
}

/**
 * How the bars split into rows: [{first, last, section, heading}] (bar indexes, inclusive).
 * `sections` are SongMapStore sections ({startBar, endBar, name}); a row starts at every section
 * start, every meter change and after `perRow` bars.
 */
export function splitRows({bars = [], sections = [], perRow = 4} = {}) {
  const n = Math.max(1, Math.floor(perRow));
  const starts = new Map(sections.map((s, i) => [s.startBar, i]));
  const sectionOf = (i) => {
    let found = null;
    for (let k = 0; k < sections.length; k++) if (sections[k].startBar <= i && i <= sections[k].endBar) { found = k; break; }
    return found;
  };
  const rows = [];
  let row = null;
  bars.forEach((bar, i) => {
    const breaks = !row || starts.has(i) || bar.meterChange || row.last - row.first + 1 >= n;
    if (breaks) {
      row = {first: i, last: i, section: sectionOf(i), heading: starts.has(i)};
      rows.push(row);
    } else {
      row.last = i;
    }
  });
  return rows;
}

/**
 * The Road map layout.
 *   bars       SongMapStore bars ({t0, t1, meterChange, …})
 *   sections   SongMapStore sections
 *   width      the scroller's content width (px); layout 'rail' | 'band'; distance factor
 *   flags      times (or {t}) that put a flag above their bar: spot starts
 *   viewportH  the scroller's height (the bottom padding lets the last row reach the follow line)
 * → {mode: 'bars', perRow, cellW, height, metrics, rows: [Row]}
 *   Row = {index, kind: 'bars', first, last, section, heading, t0, t1, y, h, headingY, flagY, flag,
 *          band: {x, y, w, h} (the cells), cells: [{bar, x, w}]}
 */
export function roadmapLayout({bars = [], sections = [], width = 0, layout = 'band', distance = 1, flags = [], viewportH = 0} = {}) {
  const m = metrics(distance);
  const perRow = barsPerRow({layout, width});
  const inner = Math.max(0, (finite(width) ? width : 0) - 2 * m.padX);
  const cellW = perRow ? Math.max(0, Math.floor(inner / perRow)) : 0;
  const times = flagTimes(flags);
  const split = splitRows({bars, sections, perRow});
  const rows = [];
  let y = m.padTop;
  split.forEach((r, index) => {
    const t0 = bars[r.first].t0, t1 = bars[r.last].t1;
    const flag = anyIn(times, t0, t1, index === split.length - 1);
    const headingY = y;
    const flagY = headingY + (r.heading ? m.headingH : 0);
    const cellsY = flagY + (flag ? m.flagH : 0);
    const count = r.last - r.first + 1;
    const cells = Array.from({length: count}, (_, k) => ({bar: r.first + k, x: m.padX + k * cellW, w: cellW}));
    const h = cellsY + m.cellH - y;
    rows.push({index, kind: 'bars', first: r.first, last: r.last, section: r.section, heading: r.heading, t0, t1,
      y, h, headingY, flagY, flag, band: {x: m.padX, y: cellsY, w: count * cellW, h: m.cellH}, cells});
    y += h + m.gap;
  });
  const lastH = rows.length ? rows[rows.length - 1].h : 0;
  const height = rows.length ? y - m.gap + bottomPad(viewportH, lastH) : m.padTop + PAD_BOTTOM;
  return {mode: 'bars', perRow, cellW, height, metrics: m, rows};
}

/** The Wave page's default seconds per row (10 s rail, 8 s band). */
export function defaultSeconds(layout) {
  return layout === 'rail' ? WAVE_SECONDS.rail : WAVE_SECONDS.band;
}

/** A row length clamped to 4–30 s. */
export function clampSeconds(seconds) {
  return clamp(finite(seconds) ? seconds : WAVE_SECONDS.band, WAVE_MIN, WAVE_MAX);
}

/**
 * The next row length for = (dir 1: zoom in, fewer seconds per row) or − (dir −1: more): the
 * neighbouring step of WAVE_STEPS, clamped at 4 and 30 s.
 */
export function stepSeconds(seconds, dir) {
  const s = clampSeconds(seconds);
  if (dir > 0) {
    for (let i = WAVE_STEPS.length - 1; i >= 0; i--) if (WAVE_STEPS[i] < s - EPS) return WAVE_STEPS[i];
    return WAVE_MIN;
  }
  for (const step of WAVE_STEPS) if (step > s + EPS) return step;
  return WAVE_MAX;
}

/** The nearest step of WAVE_STEPS to any length (a pinch's result). */
export function nearestStep(seconds) {
  const s = clampSeconds(seconds);
  return WAVE_STEPS.reduce((best, step) => (Math.abs(step - s) < Math.abs(best - s) ? step : best), WAVE_STEPS[0]);
}

/**
 * The Wave page layout.
 *   duration   the song (s); seconds per row (4–30); width, distance, flags (marker and spot times), viewportH
 * → {mode: 'wave', seconds, fullW, height, metrics, rows: [Row]}
 *   Row = {index, kind: 'wave', t0, t1, y, h, flagY, flag, timeY, band: {x, y, w, h} (the waveform), fullW}
 *   A row is `fullW` wide for `seconds`; the last one is as wide as its share of that.
 */
export function waveLayout({duration = 0, seconds = WAVE_SECONDS.band, width = 0, distance = 1, flags = [], viewportH = 0} = {}) {
  const m = metrics(distance);
  const s = clampSeconds(seconds);
  const end = Math.max(0, finite(duration) ? duration : 0);
  const fullW = Math.max(0, (finite(width) ? width : 0) - 2 * m.padX);
  const count = Math.max(1, Math.ceil(end / s - EPS));
  const times = flagTimes(flags);
  const rows = [];
  let y = m.padTop;
  for (let index = 0; index < count; index++) {
    const t0 = index * s, t1 = Math.min(end, (index + 1) * s);
    const last = index === count - 1;
    const flag = anyIn(times, t0, t1, last);
    const flagY = y, timeY = flagY + (flag ? m.flagH : 0), waveY = timeY + m.timeH;
    const w = end > 0 ? Math.max(0, ((t1 - t0) / s) * fullW) : fullW;
    const h = waveY + m.cellH - y;
    rows.push({index, kind: 'wave', t0, t1: end > 0 ? t1 : s, y, h, flagY, flag, timeY, band: {x: m.padX, y: waveY, w, h: m.cellH}, fullW});
    y += h + m.gap;
  }
  const lastH = rows[rows.length - 1].h;
  return {mode: 'wave', seconds: s, fullW, height: y - m.gap + bottomPad(viewportH, lastH), metrics: m, rows};
}

// ------------------------------------------------------------------ lookups

/**
 * The row holding time t: the last row with t0 ≤ t. `side` 'b' makes a time exactly on a row
 * break end the earlier row (a loop's end edge), 'a' (default) start the later one. Before the
 * first row → 0; after the last → the last.
 */
export function rowOfTime(rows, t, side = 'a') {
  if (!rows?.length) return -1;
  let lo = 0, hi = rows.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t0 <= t + EPS) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (side === 'b' && found > 0 && Math.abs(rows[found].t0 - t) <= EPS) return found - 1;
  return found;
}

/** The row at content y: the last row whose top is at or above y (the first row above it). */
export function rowAtY(rows, y) {
  if (!rows?.length) return -1;
  let lo = 0, hi = rows.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].y <= y) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** The rows to render for a viewport [top, bottom): the visible ones plus `overscan` on each side. */
export function visibleRange(rows, top, bottom, overscan = 2) {
  if (!rows?.length) return {first: 0, last: -1};
  const lo = Math.max(0, rowAtY(rows, top));
  let hi = rowAtY(rows, Math.max(top, bottom - EPS));
  if (rows[lo].y + rows[lo].h < top && lo < rows.length - 1 && lo === hi) hi = lo + 1;
  return {first: Math.max(0, lo - overscan), last: Math.min(rows.length - 1, hi + overscan)};
}

/**
 * Where time t sits on a row, as content x. Road map rows map each bar's time linearly over its
 * cell (the envelope is drawn the same way); Wave rows map the row span over `fullW`.
 */
export function xOfTime(row, t, bars) {
  if (!row) return 0;
  if (row.kind === 'wave') {
    const span = Math.max(EPS, (row.t1 - row.t0) || 1);
    const w = row.band.w;
    return row.band.x + clamp((t - row.t0) / span, 0, 1) * w;
  }
  const cell = cellOfTime(row, t, bars);
  if (!cell) return row.band.x;
  const bar = bars[cell.bar];
  const span = Math.max(EPS, bar.t1 - bar.t0);
  return cell.x + clamp((t - bar.t0) / span, 0, 1) * cell.w;
}

/** The cell of a Road map row that holds time t (the first or last cell when t is outside the row). */
export function cellOfTime(row, t, bars) {
  if (!row?.cells?.length) return null;
  const {cells} = row;
  let lo = 0, hi = cells.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[cells[mid].bar].t0 <= t + EPS) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return cells[found];
}

/**
 * The time at content x on a row: {t, bar} (bar = the bar index on a Road map row, else null).
 * x is clamped to the row's band.
 */
export function timeAtX(row, x, bars) {
  if (!row) return {t: 0, bar: null};
  if (row.kind === 'wave') {
    const w = Math.max(EPS, row.band.w);
    const f = clamp((x - row.band.x) / w, 0, 1);
    return {t: row.t0 + f * (row.t1 - row.t0), bar: null};
  }
  const cells = row.cells;
  if (!cells.length) return {t: row.t0, bar: row.first};
  const cw = Math.max(EPS, cells[0].w);
  const k = clamp(Math.floor((x - row.band.x) / cw), 0, cells.length - 1);
  const cell = cells[k], bar = bars[cell.bar];
  const f = clamp((x - cell.x) / cw, 0, 1);
  return {t: bar.t0 + f * (bar.t1 - bar.t0), bar: cell.bar};
}

/** The scrollTop that puts a row's top on the follow line (30% down), clamped to the content. */
export function followScrollTop(row, {viewportH = 0, contentH = 0, anchor = FOLLOW_ANCHOR} = {}) {
  if (!row) return 0;
  const max = Math.max(0, contentH - viewportH);
  return clamp(Math.round(row.y - anchor * viewportH), 0, max);
}

/**
 * Page follow (spec §4.4A, the Road map's "Page style"): when the playing row's top has crossed
 * the middle of the viewport, advance half a viewport; when it is out of view, put it on the
 * follow line. → the new scrollTop, or null to stay.
 */
export function pageScrollTop(row, {scrollTop = 0, viewportH = 0, contentH = 0} = {}) {
  if (!row) return null;
  const max = Math.max(0, contentH - viewportH);
  const top = row.y - scrollTop;
  if (top + row.h <= 0 || top >= viewportH) return followScrollTop(row, {viewportH, contentH});
  if (top > viewportH / 2) return clamp(Math.round(scrollTop + viewportH / 2), 0, max);
  return null;
}

/** True when a row is wholly inside the viewport [scrollTop, scrollTop + viewportH). */
export function rowInView(row, {scrollTop = 0, viewportH = 0} = {}) {
  return !!row && row.y >= scrollTop - EPS && row.y + row.h <= scrollTop + viewportH + EPS;
}

// ------------------------------------------------------------------ ticks

/**
 * A bar's beat ticks along the bottom of its cell, grouping-aware: one per meter unit, where the
 * first unit of each counted beat is `counted` (taller) and the downbeat is `first`.
 *   bar: {q0, q1, t0, t1, groups, denominator, pickup}; timeAt(q) → seconds (SongMapStore#timeAt)
 * → [{t, counted, first, group}] in time order. A pickup's units count from the end of its bar.
 */
export function beatTicks(bar, timeAt) {
  if (!bar || typeof timeAt !== 'function') return [];
  const unit = 4 / (bar.denominator || 4);
  const length = bar.q1 - bar.q0;
  const groups = Array.isArray(bar.groups) && bar.groups.length ? bar.groups : [1];
  const total = groups.reduce((a, g) => a + g, 0) * unit;
  // A pickup (shorter than its meter) holds the bar's last units: start the count that far in.
  const skip = bar.pickup ? Math.max(0, total - length) : 0;
  const out = [];
  let q = 0;
  groups.forEach((g, group) => {
    for (let u = 0; u < g; u++) {
      const at = q + u * unit - skip;
      if (at >= -EPS && at < length - 1e-7) out.push({t: at <= EPS ? bar.t0 : timeAt(bar.q0 + at), counted: u === 0, first: u === 0 && group === 0 && !bar.pickup, group});
    }
    q += g * unit;
  });
  return out;
}

/** m:ss (floor), as the HUD writes clock times. */
export function clockLabel(seconds) {
  const s = Math.max(0, Math.floor((finite(seconds) ? seconds : 0) + 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A Wave row's second ticks: [{t, major, label}] every second inside [t0, t1], `major` (and a
 * label 'm:ss') every LABEL_EVERY seconds.
 */
export function secondTicks(row) {
  if (!row) return [];
  const out = [];
  for (let s = Math.ceil(row.t0 - EPS); s <= row.t1 + EPS; s++) {
    const major = s % LABEL_EVERY === 0;
    out.push({t: s, major, label: major ? clockLabel(s) : null});
  }
  return out;
}
