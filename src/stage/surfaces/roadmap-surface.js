// The Road map (a mapped song) and the Wave page (unmapped): architecture §2.14.12, spec §4.4B/C.
//
//   createRoadmapSurface(host, opts) → Surface
//     opts: SurfaceOpts {session, stage, layout, distance, onActivate, onLoopEdit, onFollowChange, status}
//           plus `registry` (default: the app's) for the stage.bars focus provider
//     kind  'roadmap' while position.mapped, 'wave' otherwise; the surface switches by itself when
//           the song gains (or loses) a bar grid
//
// Road map: a lead-sheet page of bars, read top to bottom (roadmap-layout.js decides the rows: 4
// bars on the band, 8 on the rail with ≥ 1100 px of music, breaks at sections and meter changes).
// Each section's first row carries "Chorus · bars 13–20"; each cell is 88 px × Distance with its
// bar number, a meter chip on a change ("7/8 (2+2+3)"), a tempo chip on a change > 1 bpm
// ("♩=96"), grouping-aware beat ticks along the bottom and a mini waveform: the stems stacked in
// their colours, your instrument on top at full strength, the others at 55%, muted stems as a
// 1 px outline ghost with a 45° hatch (wave-render.drawEnvelopeStack). The current bar gets a
// 3 px --now outline over a --now-soft cell, a sweeping playhead and its beat tick lit. Spots fly
// a "◆ name" flag above their start bar; live markers (until they become sections) are ticks.
// Wave page: the honest variant: rows of 10 s (rail) or 8 s (band), 4–30 s through = / − or a
// pinch, second ticks with a label every 5 s, the mix-stacked waveform, markers and spots as
// flags. No bar numbers, no beat lamps and no "Bar" anywhere.
//
// Rendering: rows are virtualised (the visible ones plus 2 either side), one canvas per row for
// the envelopes and ticks, DOM for labels, chips, flags, the current-bar outline and the loop
// band and handles (loop-handles.js, with its 120 ms spring). Until the peaks exist the cells
// shimmer; the root and each canvas carry data-peaks-ready once drawn from them.
//
// Glass (glass.js, press.js, D50): taps, double taps, long presses and right-clicks are hit-tested
// to {t, bar, beatTime} and handed to opts.onActivate (the Stage applies pressPolicy). A mouse
// drag (any time) and a touch long-press-drag (stopped) make a loop, bar-snapped (Alt: beats;
// 0.1 s unmapped) through opts.onLoopEdit (preview, then commit or cancel).
//
// Follow: the current row is held 30% down the scroller ('scroll' style), or the view advances
// half a page when the row crosses the middle ('page'), as stage.followStyle says. Manual
// scrolling pauses Follow (onFollowChange(false)); it resumes 8 s after the last manual scroll
// while playing, on Play/Again (the transport's 'gesture'), or through setFollow(true).
//
// Keyboard: the bars are a role=grid in the stage.bars focus scope (D45) with a roving tabindex:
// ←/→ move by bar, ↑/↓ by row, Home/End to the row's ends (⌘/Ctrl: the song's). While a cell has
// keyboard focus the surface provides ctx.focused, so Enter plays from it (focus.play) and L loops
// it (focus.loop). On the Wave page each row is one cell.
import '../../styles/views/stage/surface-roadmap.css';
import {registry as appRegistry} from '../../app/commands.js';
import {now as clockNow} from '../../app/clock.js';
import {h} from '../../ui/h.js';
import {Button} from '../../ui/button.js';
import {pressPolicy} from '../glass.js';
import {createPressRecognizer} from '../press.js';
import {createPinch} from '../pinch.js';
import {mountLoopHandles} from '../loop-handles.js';
import {snapTime} from '../grid.js';
import {drawEnvelopeStack, readTokens, STEM_KEYS} from '../wave-render.js';
import {DISTANCE, distanceOf} from '../layout.js';
import {
  beatTicks, cellOfTime, clockLabel, defaultSeconds, followScrollTop, nearestStep, pageScrollTop, roadmapLayout,
  rowAtY, rowInView, rowOfTime, secondTicks, stepSeconds, timeAtX, visibleRange, waveLayout, xOfTime, WAVE_MAX, WAVE_MIN,
} from './roadmap-layout.js';

/** Rows rendered beyond the visible ones, each side (spec §4.4B). */
export const OVERSCAN = 2;
/** Programmatic scrolls (follow, reveal) do not count as manual scrolling for this long (as the chart). */
export const SCROLL_GUARD_MS = 900;
/** Follow resumes this long after the last manual scroll while playing (spec §4.9). */
export const FOLLOW_IDLE_MS = 8000;
/** A focus-in this soon after a press on the grid came from the press (no ctx.focused). */
const PRESS_FOCUS_MS = 1000;
/** The pinch scale reference: value = REF / seconds per row. */
const PINCH_REF = 10;
const EPS = 1e-6;
const GRID_KEYS = 'ArrowLeft ArrowRight ArrowUp ArrowDown Home End';

/** Every string the surface shows or announces (spec §4.4B/C). */
export const COPY = Object.freeze({
  grid: 'Bars',
  waveGrid: 'Song timeline',
  bar: (n) => `Bar ${n}`,
  pickup: 'Pickup',
  /** The heading's range: 'bars 13–20' | 'bar 13' | 'pickup–bar 4' | 'pickup'. */
  barsRange: (x, y) => {
    if (x === y) return x === null ? 'pickup' : `bar ${x}`;
    if (x === null) return `pickup–bar ${y}`;
    return `bars ${x}–${y}`;
  },
  meter: (numerator, denominator, grouping) => (grouping ? `${numerator}/${denominator} (${grouping})` : `${numerator}/${denominator}`),
  tempo: (pulse, bpm) => `${pulse}=${bpm}`,
  tempoName: (bpm) => `${bpm} bpm`,
  spotFlag: (name) => `◆ ${name}`,
  spotName: (name) => `spot ${name}`,
  markerFlag: (label) => `⚑ ${label}`,
  markerName: (label) => `marker ${label}`,
  /** A gridcell's accessible name: 'Bar 13, Chorus, 7/8 (2+2+3), 96 bpm, spot Fill'. */
  cell: (parts) => parts.filter(Boolean).join(', '),
  /** A Wave row: '0:40 to 0:50'. */
  span: (a, b) => `${a} to ${b}`,
  /** ctx.focused's label for a Wave row: '0:40–0:50'. */
  spanLabel: (a, b) => `${a}–${b}`,
  followResume: 'Back to playhead',
});

/** The surface's controls, for the table-driven test: role, accessible name, and when it shows. */
export const CONTROLS = Object.freeze([
  Object.freeze({role: 'grid', name: COPY.grid, context: 'mapped'}),
  Object.freeze({role: 'gridcell', name: COPY.cell([COPY.bar(1), 'Intro']), context: 'mapped'}),
  Object.freeze({role: 'grid', name: COPY.waveGrid, context: 'unmapped'}),
  Object.freeze({role: 'gridcell', name: COPY.span('0:00', '0:10'), context: 'unmapped'}),
  Object.freeze({role: 'button', name: COPY.followResume, context: 'followPaused'}),
]);

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const peek = (s) => (s && typeof s.peek === 'function' ? s.peek() : s);
const listen = (s, fn) => (s && typeof s.subscribe === 'function' ? s.subscribe(fn) : null);
const PLAYING = new Set(['playing', 'counting']);
const nextFrame = (fn) => (typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame(fn) : setTimeout(fn, 16));

function reducedMotion(win) {
  try {
    return !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const px = (n) => `${Math.round(n * 100) / 100}px`;
function place(el, {left, top, width, height}) {
  if (left !== undefined) el.style.left = px(left);
  if (top !== undefined) el.style.top = px(top);
  if (width !== undefined) el.style.width = px(Math.max(0, width));
  if (height !== undefined) el.style.height = px(Math.max(0, height));
}

/** The stems a cell draws, from the transport's mix: your instrument on top, muted as 'out'. */
export function stemsOf(mix) {
  const tracks = Array.isArray(mix?.tracks) ? mix.tracks : [];
  const mine = new Set(Array.isArray(mix?.mine) ? mix.mine : []);
  const soloing = tracks.some((t) => t.soloed);
  return tracks.map((t) => ({
    name: t.name,
    color: STEM_KEYS.includes(t.name) ? t.name : 'other',
    state: t.muted ? 'out' : soloing ? (t.soloed ? 'solo' : 'dim') : 'on',
    primary: mine.has(t.name),
  }));
}

/** The bar's display text: '13' or 'Pickup'. */
const barText = (bar) => (bar?.display == null ? COPY.pickup : String(bar.display));
const barName = (bar) => (bar?.display == null ? COPY.pickup : COPY.bar(bar.display));

/** A meter chip on bar 0 when it is not plain 4/4, and on every change (spec §4.4B). */
function meterChip(bar, i, map) {
  if (!bar) return null;
  const grouping = typeof map.beatGrouping === 'function' ? map.beatGrouping(i).label : '';
  const plain = bar.numerator === 4 && bar.denominator === 4 && !grouping;
  if (i === 0 ? plain || bar.pickup : !bar.meterChange) return null;
  return COPY.meter(bar.numerator, bar.denominator, grouping);
}

/** A tempo chip on a change of more than 1 bpm: '♩=96' (and its spoken form). */
function tempoChip(bar, map) {
  if (!bar?.tempoChange) return null;
  const pulse = typeof map.pulseLabel === 'function' ? map.pulseLabel(bar.index) : '♩';
  const bpm = Math.round(bar.bpm);
  return {text: COPY.tempo(pulse, bpm), name: COPY.tempoName(bpm)};
}

export function createRoadmapSurface(host, opts = {}) {
  const {session} = opts;
  if (!session?.map || !session.position) throw new TypeError('createRoadmapSurface: a session is required');
  const stage = opts.stage ?? null;
  const registry = opts.registry ?? appRegistry;
  const doc = host.ownerDocument ?? document;
  const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : null);
  const map = session.map;
  const transport = session.transport;
  const position = session.position;

  let mapped = !!peek(position.mapped);
  let layoutName = opts.layout ?? peek(stage?.layout) ?? 'band';
  let distanceName = distanceOf(opts.distance ?? peek(stage?.distance));
  let seconds = defaultSeconds(layoutName);
  let model = null;
  let width = 0, viewportH = 0;
  let following = true;
  let playing = false;
  let destroyed = false;
  let guardUntil = 0;
  let idleTimer = null;
  let lastFollowRow = -1;
  let lastPos = null;
  let loopRange = null;
  const views = new Map();        // row index → {row, el, canvas, cells: Map(bar|row → el)}
  let range = {first: 0, last: -1};
  const offs = [];

  // ---------------- DOM ----------------
  const grid = h('div', {class: 'roadmap-grid', role: 'grid', attrs: {'data-scope': 'stage.bars', 'data-consume-keys': GRID_KEYS}});
  const nowBox = h('div', {class: 'roadmap-now', hidden: true});
  const playhead = h('div', {class: 'roadmap-playhead', hidden: true});
  const beatTick = h('div', {class: 'roadmap-beat', hidden: true});
  const nowLayer = h('div', {class: 'roadmap-now-layer', attrs: {'aria-hidden': 'true'}}, nowBox, beatTick, playhead);
  const content = h('div', {class: 'roadmap-content'}, grid, nowLayer);
  const el = h('div', {class: 'roadmap', attrs: {'data-scroller': ''}}, content);
  // ⤓ Back to playhead (spec §4.9): 56 px, bottom centre of the music, while Follow is paused.
  const pill = Button({label: COPY.followResume, icon: 'arrow-down-to-line', variant: 'primary', kbd: 'KeyF',
    className: 'roadmap-follow-pill', onClick: () => { resumeFollow(); }});
  const pillHost = h('div', {class: 'roadmap-follow', hidden: true}, pill.el);
  const root = h('div', {class: 'roadmap-surface'}, el, pillHost);
  host.append(root);

  const duration = () => Math.max(0, map.duration || session.engine?.duration || 0);
  const bars = () => map.bars;
  const rows = () => model?.rows ?? [];
  const factor = () => DISTANCE[distanceName] ?? 1;
  const isPlaying = () => playing;
  const style = () => peek(stage?.followStyle) ?? (layoutName === 'rail' ? 'scroll' : 'page');

  // ---------------- practice: spots and markers ----------------
  const practiceValue = () => peek(session.practice?.value) ?? {};
  const liveSpots = () => (Array.isArray(practiceValue().spots) ? practiceValue().spots : [])
    .filter((s) => s && !s.deleted && finite(s.a) && finite(s.b) && s.b > s.a).sort((a, b) => a.a - b.a);
  const markers = () => (typeof position.markerTicks === 'function' ? position.markerTicks() : []);

  // ---------------- layout ----------------
  function measure() {
    width = el.clientWidth || 0;
    viewportH = el.clientHeight || 0;
  }

  function computeModel() {
    const flags = mapped ? liveSpots().map((s) => s.a) : [...liveSpots().map((s) => s.a), ...markers().map((m) => m.t)];
    if (mapped) {
      return roadmapLayout({bars: bars(), sections: map.sections, width, layout: layoutName, distance: factor(), flags, viewportH});
    }
    return waveLayout({duration: duration(), seconds, width, distance: factor(), flags, viewportH});
  }

  function setKind() {
    el.dataset.kind = mapped ? 'roadmap' : 'wave';
    grid.setAttribute('aria-label', mapped ? COPY.grid : COPY.waveGrid);
  }

  /** Rebuilds the rows (geometry changed), keeping the time at the follow line where it was. */
  function relayout({keep = true} = {}) {
    if (destroyed) return;
    const anchor = keep && model ? anchorTime() : null;
    // The content's height changes: the browser's scroll clamp is not a manual scroll.
    guardUntil = clockNow() + SCROLL_GUARD_MS;
    measure();
    model = computeModel();
    content.style.height = px(model.height);
    grid.setAttribute('aria-rowcount', String(model.rows.length));
    clearViews();
    lastFollowRow = -1;
    renderRows();
    if (anchor !== null) scrollToTop(followScrollTop(model.rows[rowOfTime(model.rows, anchor)], {viewportH, contentH: model.height}), false);
    paintNow(lastPos ?? transport.position());
    handles.update();
  }

  // ---------------- rows ----------------
  function clearViews() {
    for (const view of views.values()) view.el.remove();
    views.clear();
    range = {first: 0, last: -1};
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued || destroyed) return;
    renderQueued = true;
    nextFrame(() => { renderQueued = false; if (!destroyed) { renderRows(); handles.update(); } });
  }

  /** Renders the visible rows plus the overscan (and keeps the row holding focus). */
  function renderRows() {
    if (!model) return;
    const list = model.rows;
    const top = el.scrollTop || 0;
    range = visibleRange(list, top, top + Math.max(viewportH, 1), OVERSCAN);
    const keep = new Set();
    for (let i = range.first; i <= range.last; i++) keep.add(i);
    const focusedRow = focusRowIndex();
    if (focusedRow >= 0 && grid.contains(doc.activeElement)) keep.add(focusedRow);
    for (const [i, view] of views) {
      if (!keep.has(i)) { view.el.remove(); views.delete(i); }
    }
    const ordered = [...keep].sort((a, b) => a - b);
    for (const i of ordered) {
      if (!views.has(i)) {
        const view = buildRow(list[i]);
        views.set(i, view);
        draw(view);
      }
    }
    // Rows stay in index order in the grid (reading order for assistive technology).
    let before = null;
    for (let k = ordered.length - 1; k >= 0; k--) {
      const view = views.get(ordered[k]);
      if (view.el.parentNode !== grid || view.el.nextSibling !== before) {
        if (!view.el.contains(doc.activeElement)) grid.insertBefore(view.el, before);
      }
      before = view.el;
    }
    syncRoving();
    markNow();
  }

  function buildRow(row) {
    const rowEl = h('div', {class: 'roadmap-row', role: 'row', attrs: {'aria-rowindex': row.index + 1}, dataset: {row: row.index}});
    place(rowEl, {left: 0, top: row.y, width, height: row.h});
    const view = {row, el: rowEl, canvas: null, cells: new Map()};
    if (row.kind === 'bars') buildBarsRow(view);
    else buildWaveRow(view);
    return view;
  }

  /** Spots (and on the Wave page markers) whose flag sits on this row: [{x, text, kind}]. */
  function flagsFor(row) {
    if (!row.flag) return [];
    const out = [];
    const inRow = (t) => t >= row.t0 - EPS && (t < row.t1 - EPS || (row.index === model.rows.length - 1 && t <= row.t1 + EPS));
    for (const s of liveSpots()) {
      if (!inRow(s.a)) continue;
      const x = row.kind === 'bars' ? cellOfTime(row, s.a, bars())?.x ?? row.band.x : xOfTime(row, s.a, bars());
      out.push({x, text: COPY.spotFlag(s.name || ''), kind: 'spot', id: s.id});
    }
    if (row.kind === 'wave') {
      for (const m of markers()) if (inRow(m.t)) out.push({x: xOfTime(row, m.t, bars()), text: COPY.markerFlag(m.label || ''), kind: 'marker', id: m.id});
    }
    return out.sort((a, b) => a.x - b.x);
  }

  function buildFlags(view) {
    const {row} = view;
    const flags = flagsFor(row);
    if (!flags.length) return;
    const lane = h('div', {class: 'roadmap-flags', attrs: {'aria-hidden': 'true'}});
    place(lane, {left: 0, top: row.flagY - row.y, width, height: model.metrics.flagH});
    flags.forEach((f, i) => {
      const next = flags[i + 1];
      const flag = h('span', {class: 'roadmap-flag', dataset: {flag: f.kind, id: f.id}}, f.text);
      place(flag, {left: f.x});
      if (next) flag.style.maxWidth = px(Math.max(48, next.x - f.x - 4));
      lane.append(flag);
    });
    view.el.append(lane);
  }

  function buildBarsRow(view) {
    const {row} = view;
    const list = bars();
    const m = model.metrics;
    if (row.heading && row.section !== null) {
      const section = map.sections[row.section];
      const first = list[section.startBar], last = list[section.endBar];
      const heading = h('div', {class: 'roadmap-heading', attrs: {'aria-hidden': 'true'}},
        h('span', {class: 'roadmap-heading-name'}, section.name),
        h('span', {class: 'roadmap-heading-range'}, COPY.barsRange(first?.display ?? null, last?.display ?? null)));
      place(heading, {left: row.band.x, top: row.headingY - row.y, height: m.headingH});
      view.el.append(heading);
    }
    buildFlags(view);
    const spotsByBar = new Map();
    for (const s of liveSpots()) {
      const i = map.barIndexAt(s.a);
      if (i >= row.first && i <= row.last) spotsByBar.set(i, [...(spotsByBar.get(i) ?? []), s.name]);
    }
    for (const cell of row.cells) {
      const bar = list[cell.bar];
      const section = row.heading && cell.bar === row.first && row.section !== null ? map.sections[row.section]?.name : null;
      const meter = meterChip(bar, cell.bar, map);
      const tempo = tempoChip(bar, map);
      const chips = [meter, tempo?.text].filter(Boolean);
      const name = COPY.cell([barName(bar), section, meter, tempo?.name, ...(spotsByBar.get(cell.bar) ?? []).map(COPY.spotName)]);
      const cellEl = h('div', {class: 'roadmap-cell', role: 'gridcell', tabIndex: -1, attrs: {'aria-label': name, 'aria-colindex': cell.bar - row.first + 1},
        dataset: {bar: cell.bar}},
      h('span', {class: 'roadmap-cell-number', attrs: {'aria-hidden': 'true'}}, barText(bar)),
      chips.length ? h('span', {class: 'roadmap-cell-chips', attrs: {'aria-hidden': 'true'}}, ...chips.map((c) => h('span', {class: 'roadmap-chip'}, c))) : null);
      place(cellEl, {left: cell.x, top: row.band.y - row.y, width: cell.w, height: row.band.h});
      view.cells.set(cell.bar, cellEl);
      view.el.append(cellEl);
    }
    const canvas = h('canvas', {class: 'roadmap-canvas', attrs: {'aria-hidden': 'true'}, dataset: {testid: 'roadmap-canvas'}});
    place(canvas, {left: row.band.x, top: row.band.y - row.y, width: row.band.w, height: row.band.h});
    view.canvas = canvas;
    view.el.append(canvas);
    // Live markers on a mapped song stay ticks until they become sections (§2.14.1).
    const ticks = markers().filter((mk) => mk.t >= row.t0 - EPS && mk.t < row.t1 - EPS);
    if (ticks.length) {
      const overlay = h('div', {class: 'roadmap-markers', attrs: {'aria-hidden': 'true'}});
      for (const mk of ticks) {
        const tick = h('span', {class: 'roadmap-marker', dataset: {id: mk.id}, attrs: {title: mk.label}});
        place(tick, {left: xOfTime(row, mk.t, list) - 1, top: row.band.y - row.y, height: row.band.h});
        overlay.append(tick);
      }
      view.el.append(overlay);
    }
  }

  function buildWaveRow(view) {
    const {row} = view;
    const m = model.metrics;
    buildFlags(view);
    const labels = h('div', {class: 'roadmap-times', attrs: {'aria-hidden': 'true'}});
    place(labels, {left: 0, top: row.timeY - row.y, width, height: m.timeH});
    for (const tick of secondTicks(row)) {
      // The row's end belongs to the next row's start (and would hang past the edge).
      if (!tick.label || tick.t > row.t1 - 0.5) continue;
      const label = h('span', {class: 'roadmap-time'}, tick.label);
      place(label, {left: xOfTime(row, tick.t, null)});
      labels.append(label);
    }
    view.el.append(labels);
    const cellEl = h('div', {class: 'roadmap-wavecell', role: 'gridcell', tabIndex: -1,
      attrs: {'aria-label': COPY.span(clockLabel(row.t0), clockLabel(row.t1)), 'aria-colindex': 1}, dataset: {row: row.index}});
    place(cellEl, {left: row.band.x, top: row.band.y - row.y, width: row.band.w, height: row.band.h});
    view.cells.set(row.index, cellEl);
    view.el.append(cellEl);
    const canvas = h('canvas', {class: 'roadmap-canvas', attrs: {'aria-hidden': 'true'}, dataset: {testid: 'roadmap-canvas'}});
    place(canvas, {left: row.band.x, top: row.timeY - row.y, width: row.band.w, height: row.band.y + row.band.h - row.timeY});
    view.canvas = canvas;
    view.el.append(canvas);
  }

  // ---------------- drawing ----------------
  const dpr = () => (win?.devicePixelRatio > 0 ? win.devicePixelRatio : 1);
  let stems = stemsOf(peek(transport.snapshot)?.mix);
  let mixKey = JSON.stringify(stems);

  function contextFor(canvas, w, hgt) {
    const ratio = dpr();
    const cw = Math.max(1, Math.round(w * ratio)), ch = Math.max(1, Math.round(hgt * ratio));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return null;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    return ctx;
  }

  function draw(view) {
    const {row, canvas} = view;
    if (!canvas) return;
    const peaks = session.peaks;
    const ready = !!peaks?.ready;
    const tokens = readTokens();
    const d = factor();
    if (row.kind === 'bars') {
      const ctx = contextFor(canvas, row.band.w, row.band.h);
      if (!ctx) return;
      const list = bars();
      const top = Math.round(24 * d), bottomLane = Math.round(12 * d), inset = 4;
      for (const cell of row.cells) {
        const bar = list[cell.bar];
        const x0 = cell.x - row.band.x;
        if (ready && cell.w > 2 * inset) {
          drawEnvelopeStack(ctx, {x: x0 + inset, y: top, w: cell.w - 2 * inset, h: Math.max(4, row.band.h - top - bottomLane), t0: bar.t0, t1: bar.t1, stems, peaks, dpr: dpr()});
        }
        // Beat ticks along the bottom, grouping-aware: a counted beat is taller than its units.
        ctx.save();
        ctx.fillStyle = tokens.ink3;
        const span = Math.max(EPS, bar.t1 - bar.t0);
        for (const tick of beatTicks(bar, (q) => map.timeAt(q))) {
          const x = x0 + ((tick.t - bar.t0) / span) * cell.w;
          const len = Math.round((tick.first ? 10 : tick.counted ? 8 : 4) * d);
          ctx.fillRect(Math.round(x), row.band.h - len - 2, tick.counted ? 2 : 1, len);
        }
        ctx.restore();
      }
    } else {
      const top = row.timeY;
      const ctx = contextFor(canvas, row.band.w, row.band.y + row.band.h - top);
      if (!ctx) return;
      if (ready && row.band.w > 0) {
        drawEnvelopeStack(ctx, {x: 0, y: row.band.y - top, w: row.band.w, h: row.band.h, t0: row.t0, t1: row.t1, stems, peaks, dpr: dpr()});
      }
      ctx.save();
      ctx.fillStyle = tokens.ink3;
      const timeH = model.metrics.timeH;
      for (const tick of secondTicks(row)) {
        const x = xOfTime(row, tick.t, null) - row.band.x;
        const len = Math.round((tick.major ? 8 : 4) * d);
        ctx.fillRect(Math.min(row.band.w - 1, Math.max(0, Math.round(x))), timeH - len, tick.major ? 2 : 1, len);
      }
      ctx.restore();
    }
    if (ready) canvas.dataset.peaksReady = 'true';
    else delete canvas.dataset.peaksReady;
  }

  function redrawAll() {
    for (const view of views.values()) draw(view);
    const ready = !!session.peaks?.ready;
    if (ready) { el.dataset.peaksReady = 'true'; delete el.dataset.shimmer; } else { delete el.dataset.peaksReady; el.dataset.shimmer = ''; }
  }

  // ---------------- the current bar and the playhead ----------------
  let nowBar = -1, nowRow = -1;
  let beatCache = {bar: -1, ticks: []};

  function markNow() {
    for (const view of views.values()) {
      for (const [key, cellEl] of view.cells) {
        const on = mapped ? key === nowBar : false;
        if (cellEl.hasAttribute('data-now') !== on) cellEl.toggleAttribute('data-now', on);
      }
    }
  }

  function paintNow(t, frame = null) {
    if (!model || !finite(t)) return;
    const list = model.rows;
    if (!list.length) return;
    const ri = rowOfTime(list, t);
    const row = list[ri];
    nowRow = ri;
    if (mapped) {
      const cell = cellOfTime(row, t, bars());
      if (!cell) return;
      const bar = bars()[cell.bar];
      if (cell.bar !== nowBar) {
        nowBar = cell.bar;
        place(nowBox, {left: cell.x, top: row.band.y, width: cell.w, height: row.band.h});
        nowBox.hidden = false;
        markNow();
      }
      const span = Math.max(EPS, bar.t1 - bar.t0);
      const x = cell.x + clamp((t - bar.t0) / span, 0, 1) * cell.w;
      place(playhead, {top: row.band.y, height: row.band.h});
      playhead.style.transform = `translateX(${px(x)})`;
      playhead.hidden = false;
      // The current beat's tick, lit.
      if (beatCache.bar !== cell.bar) beatCache = {bar: cell.bar, ticks: beatTicks(bar, (q) => map.timeAt(q)).filter((k) => k.counted)};
      const bb = frame?.bar ?? (typeof map.barBeatAt === 'function' ? map.barBeatAt(t) : null);
      const onset = bb && !bb.before && bb.index === cell.bar ? beatCache.ticks[Math.min(bb.groupIndex, beatCache.ticks.length - 1)] : null;
      if (onset) {
        const bx = cell.x + ((onset.t - bar.t0) / span) * cell.w;
        const len = Math.round(10 * factor());
        place(beatTick, {top: row.band.y + row.band.h - len - 2, height: len});
        beatTick.style.transform = `translateX(${px(bx)})`;
        beatTick.hidden = false;
      } else {
        beatTick.hidden = true;
      }
    } else {
      if (nowBar !== -1) { nowBar = -1; markNow(); }
      nowBox.hidden = true;
      beatTick.hidden = true;
      const x = xOfTime(row, t, null);
      place(playhead, {top: row.timeY, height: row.band.y + row.band.h - row.timeY});
      playhead.style.transform = `translateX(${px(x)})`;
      playhead.hidden = false;
    }
  }

  // ---------------- scrolling and follow ----------------
  function scrollToTop(top, smooth) {
    if (!finite(top)) return;
    const current = el.scrollTop || 0;
    if (Math.abs(current - top) < 1) return;
    guardUntil = clockNow() + SCROLL_GUARD_MS;
    const behavior = smooth && !reducedMotion(win) ? 'smooth' : 'auto';
    if (typeof el.scrollTo === 'function') {
      try { el.scrollTo({top, behavior}); } catch { el.scrollTop = top; }
    } else {
      el.scrollTop = top;
    }
    scheduleRender();
  }

  function setFollowing(on, {notify = true} = {}) {
    const next = !!on;
    if (next === following) return;
    following = next;
    el.toggleAttribute('data-follow-paused', !following);
    pillHost.hidden = following;
    if (notify) opts.onFollowChange?.(following);
  }

  function clearIdle() { clearTimeout(idleTimer); idleTimer = null; }
  function armIdle() {
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!destroyed && playing && !following) resumeFollow();
    }, FOLLOW_IDLE_MS);
  }

  function onScroll() {
    scheduleRender();
    if (clockNow() < guardUntil) return;
    // Manual scrolling (wheel, a finger, the scrollbar, a keyboard move off screen): Follow pauses.
    setFollowing(false);
    armIdle();
  }

  function resumeFollow() {
    clearIdle();
    setFollowing(true);
    lastFollowRow = -1;
    reveal(transport.position(), {smooth: true});
  }

  function follow(ri) {
    const row = model.rows[ri];
    if (!row) return;
    const top = el.scrollTop || 0;
    if (style() === 'page') {
      const next = pageScrollTop(row, {scrollTop: top, viewportH, contentH: model.height});
      if (next !== null) scrollToTop(next, true);
    } else if (ri !== lastFollowRow || !rowInView(row, {scrollTop: top, viewportH})) {
      scrollToTop(followScrollTop(row, {viewportH, contentH: model.height}), true);
    }
    lastFollowRow = ri;
  }

  /** The time to keep across a relayout: the playhead's while its row shows, else the follow line's. */
  function anchorTime() {
    if (!model?.rows.length) return transport.position();
    const t = transport.position();
    const top = el.scrollTop || 0;
    const row = model.rows[rowOfTime(model.rows, t)];
    if (playing || rowInView(row, {scrollTop: top, viewportH})) return t;
    return model.rows[rowAtY(model.rows, top + viewportH * 0.3)]?.t0 ?? t;
  }

  function reveal(t, {smooth = false} = {}) {
    if (!model?.rows.length || !finite(t)) return;
    const row = model.rows[rowOfTime(model.rows, t)];
    scrollToTop(followScrollTop(row, {viewportH, contentH: model.height}), smooth);
    lastFollowRow = row.index;
  }

  // ---------------- hit testing and glass ----------------
  function hit(e) {
    if (!model?.rows.length) return null;
    const r = content.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const row = model.rows[Math.max(0, rowAtY(model.rows, y))];
    const {t, bar} = timeAtX(row, x, bars());
    const time = clamp(t, 0, duration() || t);
    const out = {t: time, pointerType: e.pointerType || 'touch', clientX: e.clientX, clientY: e.clientY};
    if (mapped && bar !== null) {
      const b = bars()[bar];
      out.barIndex = bar;
      if (b?.display != null) out.bar = b.display;
      out.beatTime = clamp(map.snapTime(time, 'beat'), 0, duration() || time);
    }
    return out;
  }

  const activate = (kind, e) => {
    const at = hit(e);
    if (!at) return;
    const {barIndex, ...payload} = at;
    void barIndex;
    opts.onActivate?.({kind, ...payload});
  };

  // Loop drags on the music: a mouse drag (any time) or a touch long-press-drag (stopped).
  let drag = null;   // {anchor, last}
  let lastDown = null;   // the last pointerdown on the surface (a mouse drag's anchor)
  function dragRange(anchor, cur, alt) {
    const end = duration();
    if (mapped && finite(anchor.barIndex) && finite(cur.barIndex)) {
      if (alt) {
        const lo = Math.min(anchor.t, cur.t), hi = Math.max(anchor.t, cur.t);
        const a = Math.max(0, snapTime(map, lo, 'beat', {mode: 'floor'}));
        let b = snapTime(map, hi, 'beat', {mode: 'ceil'});
        if (b <= a + EPS) b = snapTime(map, a + 1e-3, 'beat', {mode: 'ceil'});
        return {a, b: end > 0 ? Math.min(end, b) : b};
      }
      const list = bars();
      const i = Math.min(anchor.barIndex, cur.barIndex), j = Math.max(anchor.barIndex, cur.barIndex);
      const a = list[i].t0, b = list[j].t1;
      const out = {a, b};
      const ra = position.ref?.(a), rb = position.ref?.(b);
      if (ra) out.aBar = ra;
      if (rb && j + 1 < list.length) out.bBar = rb;
      return out;
    }
    const lo = Math.min(anchor.t, cur.t), hi = Math.max(anchor.t, cur.t);
    const a = snapTime(null, lo, 'bar', {mode: 'floor'});
    let b = snapTime(null, hi, 'bar', {mode: 'ceil'});
    if (b <= a + EPS) b = a + 0.1;
    return {a, b: end > 0 ? Math.min(end, Math.round(b * 10) / 10) : b};
  }
  function dragStart(e) {
    const anchor = hit(e);
    if (!anchor) return false;
    drag = {anchor, last: null};
    return true;
  }
  function dragMove(e) {
    if (!drag) return;
    const cur = hit(e);
    if (!cur) return;
    const next = dragRange(drag.anchor, cur, !!e.altKey);
    if (drag.last && Math.abs(drag.last.a - next.a) < EPS && Math.abs(drag.last.b - next.b) < EPS) return;
    drag.last = next;
    handles.set(next);
    opts.onLoopEdit?.({...next, phase: 'preview'});
  }
  function dragEnd(e, {cancelled = false} = {}) {
    const d = drag;
    drag = null;
    if (!d?.last) return;
    if (cancelled) {
      handles.set(loopRange);
      opts.onLoopEdit?.({...(loopRange ?? d.last), phase: 'cancel'});
      return;
    }
    opts.onLoopEdit?.({...d.last, phase: 'commit'});
  }

  const offPress = createPressRecognizer(el, {
    onTap: (e) => activate('tap', e),
    onDouble: (e) => activate('double', e),
    onMenu: (e) => activate(e.pointerType === 'mouse' || e.keyboard ? 'context' : 'long', e),
    onLongStart: (e) => {
      if (pressPolicy({pointerType: e.pointerType, playing, gesture: 'longDrag'}) !== 'loopDrag') return false;
      return dragStart(e);
    },
    onLongDrag: (e) => dragMove(e),
    onLongEnd: (e, {dragged, cancelled} = {}) => { if (dragged || drag?.last) dragEnd(e, {cancelled: !!cancelled}); else drag = null; },
    onDragStart: (e) => {
      if (pressPolicy({pointerType: e.pointerType, playing, gesture: 'drag'}) !== 'loopDrag') return;
      // press.js reports the drag once it has moved past its tolerance: anchor it where it began.
      dragStart(lastDown && lastDown.pointerId === e.event?.pointerId ? {...e, clientX: lastDown.clientX, clientY: lastDown.clientY} : e);
    },
    onDrag: (e) => dragMove(e),
    onDragEnd: (e) => dragEnd(e, {cancelled: !!e.cancelled}),
  });
  offs.push(offPress);

  // Wave page: a pinch (or ⌘/Ctrl-wheel) changes the row length, live as a transform, once on release.
  const pinch = createPinch(el, {
    base: PINCH_REF / seconds, min: PINCH_REF / WAVE_MAX, max: PINCH_REF / WAVE_MIN, preview: content,
    shouldStart: () => !mapped,
    onCommit: (g) => setSeconds(nearestStep(PINCH_REF / g.value)),
  });
  offs.push(() => pinch.destroy());

  function setSeconds(next) {
    const s = nearestStep(next);
    if (s === seconds) { pinch.setBase(PINCH_REF / seconds); return false; }
    seconds = s;
    pinch.setBase(PINCH_REF / seconds);
    if (!mapped) relayout();
    return true;
  }

  // ---------------- the loop band and handles ----------------
  function rowRects() {
    if (!model || range.last < range.first) return [];
    const r = content.getBoundingClientRect();
    const out = [];
    for (let i = range.first; i <= range.last; i++) {
      const b = model.rows[i].band;
      const left = r.left + b.x, top = r.top + b.y;
      out.push({left, top, right: left + b.w, bottom: top + b.h, width: b.w, height: b.h, x: left, y: top});
    }
    return out;
  }
  const handles = mountLoopHandles(content, {
    toX: (t, side) => {
      if (!model?.rows.length) return null;
      const g = rowOfTime(model.rows, t, side);
      const r = content.getBoundingClientRect();
      return {row: g - range.first, x: r.left + xOfTime(model.rows[g], t, bars())};
    },
    toT: (clientX, clientY) => hit({clientX, clientY})?.t ?? 0,
    rows: rowRects,
    snap: (t, {alt = false, shift = false, mode} = {}) => {
      const end = duration();
      const v = shift ? Math.max(0, t) : snapTime(mapped ? map : null, t, mapped && alt ? 'beat' : 'bar', mode ? {mode} : {});
      return end > 0 ? Math.min(end, v) : v;
    },
    onEdit: ({a, b, phase}) => {
      if (phase === 'commit') loopRange = {a, b};
      opts.onLoopEdit?.({a, b, phase});
    },
    playing: isPlaying,
  });
  offs.push(() => handles.destroy());

  // ---------------- keyboard: the stage.bars grid ----------------
  let roving = -1;       // bar index (mapped) or row index (wave) of the tabbable cell
  let offFocused = null;
  let pointerPress = false, pointerTimer = null;

  const keyOfCell = (cellEl) => Number(mapped ? cellEl.dataset.bar : cellEl.dataset.row);
  const rowIndexOfKey = (key) => {
    if (!model) return -1;
    if (!mapped) return key;
    const list = model.rows;
    let lo = 0, hi = list.length - 1, found = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].first <= key) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found;
  };
  function focusRowIndex() { return roving >= 0 ? rowIndexOfKey(roving) : -1; }
  const cellEl = (key) => views.get(rowIndexOfKey(key))?.cells.get(key) ?? null;
  const keyCount = () => (mapped ? bars().length : model?.rows.length ?? 0);

  function focusedItem() {
    if (roving < 0 || !model) return null;
    if (mapped) {
      const bar = bars()[roving];
      if (!bar) return null;
      return {kind: 'bar', t0: bar.t0, t1: bar.t1, label: barName(bar), bar: bar.display ?? null};
    }
    const row = model.rows[roving];
    if (!row) return null;
    return {kind: 'marker', t0: row.t0, t1: row.t1, label: COPY.spanLabel(clockLabel(row.t0), clockLabel(row.t1))};
  }
  function provideFocused() {
    if (!offFocused) offFocused = registry.provide('focused', () => focusedItem());
    registry.invalidate?.();
  }
  function withdrawFocused() {
    if (!offFocused) return;
    offFocused();
    offFocused = null;
    registry.invalidate?.();
  }

  /** Keeps exactly one tabbable cell: the roving one when it is rendered, else the current position's. */
  function syncRoving() {
    const holds = grid.contains(doc.activeElement);
    if (!holds) {
      if (roving < 0 || roving >= keyCount() || !cellEl(roving)) {
        const t = lastPos ?? transport.position();
        let key = mapped ? map.barIndexAt(t) : rowOfTime(model?.rows ?? [], t);
        if (!cellEl(key)) {
          const first = views.get(range.first);
          key = first ? [...first.cells.keys()][0] ?? -1 : -1;
        }
        roving = key;
      }
    }
    for (const view of views.values()) {
      for (const [key, c] of view.cells) {
        const tab = key === roving ? 0 : -1;
        if (c.tabIndex !== tab) c.tabIndex = tab;
      }
    }
  }

  function moveTo(key) {
    const count = keyCount();
    if (!count) return;
    roving = clamp(key, 0, count - 1);
    const row = model.rows[rowIndexOfKey(roving)];
    const top = el.scrollTop || 0;
    // Keyboard moves that leave the view scroll it like a manual scroll (Follow pauses).
    if (row.y < top) el.scrollTop = Math.max(0, row.y - 8);
    else if (row.y + row.h > top + viewportH) el.scrollTop = row.y + row.h - viewportH + 8;
    renderRows();
    handles.update();
    cellEl(roving)?.focus?.({preventScroll: true});
    provideFocused();
  }

  function onGridKey(e) {
    if (e.altKey || !model) return;
    if (!/^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End)$/.test(e.key)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (roving < 0) syncRoving();
    let next = roving;
    if (mapped) {
      const ri = rowIndexOfKey(roving);
      const row = model.rows[ri];
      const col = roving - row.first;
      if (e.key === 'ArrowRight') next = roving + 1;
      else if (e.key === 'ArrowLeft') next = roving - 1;
      else if (e.key === 'ArrowDown') { const r = model.rows[ri + 1]; next = r ? Math.min(r.first + col, r.last) : roving; }
      else if (e.key === 'ArrowUp') { const r = model.rows[ri - 1]; next = r ? Math.min(r.first + col, r.last) : roving; }
      else if (e.key === 'Home') next = mod ? 0 : row.first;
      else if (e.key === 'End') next = mod ? bars().length - 1 : row.last;
    } else {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = roving + 1;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = roving - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = model.rows.length - 1;
    }
    e.preventDefault();
    moveTo(next);
  }

  function onGridFocusIn(e) {
    const target = e.target?.closest?.('[role=gridcell]');
    if (!target || !grid.contains(target)) return;
    roving = keyOfCell(target);
    syncRoving();
    if (pointerPress) return;   // a click or tap focused it: no ctx.focused until a key
    provideFocused();
  }
  function onGridFocusOut(e) {
    if (e.relatedTarget && grid.contains(e.relatedTarget)) return;
    withdrawFocused();
  }
  function endPress() { pointerPress = false; clearTimeout(pointerTimer); pointerTimer = null; }
  function onPressCapture(e) {
    lastDown = {pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY};
    pointerPress = true;
    clearTimeout(pointerTimer);
    pointerTimer = setTimeout(endPress, PRESS_FOCUS_MS);
    withdrawFocused();
  }
  grid.addEventListener('keydown', onGridKey);
  grid.addEventListener('keydown', endPress, true);
  grid.addEventListener('focusin', onGridFocusIn);
  grid.addEventListener('focusout', onGridFocusOut);
  el.addEventListener('pointerdown', onPressCapture, true);
  el.addEventListener('scroll', onScroll, {passive: true});
  offs.push(() => {
    grid.removeEventListener('keydown', onGridKey);
    grid.removeEventListener('keydown', endPress, true);
    grid.removeEventListener('focusin', onGridFocusIn);
    grid.removeEventListener('focusout', onGridFocusOut);
    el.removeEventListener('pointerdown', onPressCapture, true);
    el.removeEventListener('scroll', onScroll);
    endPress();
    withdrawFocused();
  });

  // ---------------- data: the map, practice, mix, peaks, theme, size ----------------
  const onMapped = (value) => {
    const next = !!value;
    if (next === mapped) return;
    mapped = next;
    roving = -1;
    nowBar = -1;
    setKind();
    relayout();
  };
  const offMapped = listen(position.mapped, onMapped);
  if (offMapped) offs.push(offMapped);
  const offRevision = listen(position.revision, () => {
    const next = !!map.isReal;
    if (next !== mapped) { onMapped(next); return; }
    beatCache = {bar: -1, ticks: []};
    nowBar = -1;
    relayout();
  });
  if (offRevision) offs.push(offRevision);

  let flagsKey = '';
  const flagsKeyOf = () => JSON.stringify([liveSpots().map((s) => [s.id, s.a, s.name]), markers().map((m) => [m.id, m.t, m.label])]);
  const offPractice = listen(session.practice?.value, () => {
    const key = flagsKeyOf();
    if (key === flagsKey) return;
    flagsKey = key;
    relayout();
  });
  if (offPractice) offs.push(offPractice);

  const offSnapshot = listen(transport.snapshot, (snap) => {
    const nextStems = stemsOf(snap?.mix);
    const key = JSON.stringify(nextStems);
    if (key !== mixKey) { mixKey = key; stems = nextStems; redrawAll(); }
  });
  if (offSnapshot) offs.push(offSnapshot);

  const offLoad = listen(session.load, () => redrawAll());
  if (offLoad) offs.push(offLoad);

  const offGesture = typeof transport.on === 'function' ? transport.on('gesture', () => { if (!following) resumeFollow(); }) : null;
  if (offGesture) offs.push(offGesture);

  const onTheme = () => redrawAll();
  win?.addEventListener?.('woodshed:theme', onTheme);
  win?.addEventListener?.('woodshed:place', onTheme);
  offs.push(() => { win?.removeEventListener?.('woodshed:theme', onTheme); win?.removeEventListener?.('woodshed:place', onTheme); });

  // A resize relayouts at once (a ResizeObserver callback runs after layout and before paint; the
  // rows live inside the scroller, so the relayout cannot resize what is observed).
  if (typeof win?.ResizeObserver === 'function' || typeof ResizeObserver === 'function') {
    const RO = win?.ResizeObserver ?? ResizeObserver;
    const observer = new RO(() => {
      const w = el.clientWidth || 0, hgt = el.clientHeight || 0;
      if (w === width && hgt === viewportH) return;
      relayout();
    });
    observer.observe(el);
    offs.push(() => observer.disconnect());
  }

  // ---------------- first render ----------------
  setKind();
  flagsKey = flagsKeyOf();
  measure();
  model = computeModel();
  content.style.height = px(model.height);
  grid.setAttribute('aria-rowcount', String(model.rows.length));
  renderRows();
  redrawAll();
  lastPos = transport.position();
  paintNow(lastPos);
  {
    const snap = peek(transport.snapshot);
    playing = PLAYING.has(snap?.phase);
    const l = snap?.loop;
    if (l?.on && l.b > l.a) { loopRange = {a: l.a, b: l.b}; handles.set(loopRange); }
  }

  return {
    el: root,
    get kind() { return mapped ? 'roadmap' : 'wave'; },
    /** The rows' geometry (tests, harness). */
    get model() { return model; },
    get following() { return following; },
    get seconds() { return seconds; },

    frame(f) {
      if (destroyed || !f) return;
      const t = f.position;
      if (!finite(t)) return;
      paintNow(t, f);
      const moving = !!(f.playing || f.counting);
      if (following && model?.rows.length) {
        const ri = rowOfTime(model.rows, t);
        if (moving) follow(ri);
        else if (lastPos === null || Math.abs(t - lastPos) > 1e-3) {
          const row = model.rows[ri];
          if (!rowInView(row, {scrollTop: el.scrollTop || 0, viewportH})) reveal(t, {smooth: true});
        }
      }
      lastPos = t;
    },

    setLoop(next) {
      loopRange = next && finite(next.a) && finite(next.b) && next.b > next.a ? {a: next.a, b: next.b} : null;
      if (!drag?.last) handles.set(loopRange);
    },

    setGlass(on) {
      playing = !!on;
      el.toggleAttribute('data-playing', playing);
      handles.update();
      if (playing && !following && !idleTimer) armIdle();
    },

    setFollow(on) {
      if (on) resumeFollow();
      else { clearIdle(); setFollowing(false, {notify: false}); }
    },

    reveal,

    anchor() {
      const time = anchorTime();
      if (!mapped) return {time};
      return {time, bar: map.barIndexAt(time)};
    },

    zoom(dir) {
      if (mapped) return false;
      return setSeconds(stepSeconds(seconds, dir > 0 ? 1 : -1));
    },

    setLayout(next) {
      if (!next || next === layoutName) return;
      const wasDefault = seconds === defaultSeconds(layoutName);
      layoutName = next;
      if (wasDefault) { seconds = defaultSeconds(layoutName); pinch.setBase(PINCH_REF / seconds); }
      relayout();
    },

    setDistance(next) {
      const d = distanceOf(next);
      if (d === distanceName) return;
      distanceName = d;
      relayout();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearIdle();
      for (const off of offs.splice(0).reverse()) { try { off(); } catch (err) { console.error('[roadmap] cleanup failed', err); } }
      views.clear();
      pill.destroy();
      root.remove();
    },
  };
}

export default createRoadmapSurface;
