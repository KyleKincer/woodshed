// Edit · Map main area (architecture §2.15 "map/view.js"; spec §5.1 and wireframe §10.10; D19, D20,
// D23, D47; maps/mapedit.md §5.6, §11.4).
//
//   mountMapView(el, {session, mapSession, inspectorEl, find, review, query, mapHooks, edit, registry,
//                     onCloseFind}) → {el, destroy(), …the 'mapView' context below}
//     session      the song session (map, transport, practice, detect, peaks, frame, load)
//     mapSession   the Map tab's MapSession (Edit creates it and sets session.mapEditor, D23)
//     inspectorEl  the inspector container Edit provides: the inspector (inspector.js), or with
//                  `find` the Find a chart panel (find-panel.js), which replaces it
//     review       ?review=sections: open the suggestion review in the sections lane (D47)
//     query        the route query; ?bar=N selects (and reveals) bar N
//     mapHooks     the map session's hooks: this view answers `status` (the inspector's status line)
//                  and `rename` (the sections lane's inline rename) while it is mounted
//     onCloseFind  Find a chart finished (a commit): Edit goes back to /s/:id/edit/map
//   Test and harness seams: prefs, platform, feedback, store, desktop (the inspector's), raf, caf, mountFindPanel.
//
// Top to bottom (spec §5.1): the 40 px toolbar ([− + Fit] [Z] Grid: Beat ▾ Snap ⇧S), the bar ruler
// with meter chips (times when unmapped, never bars), the 32 px sections lane (editable blocks,
// suggestions and their review), the 96 px tempo lane (steps, ramps, amber suspect spans, 12 px pin
// diamonds), one row per stem on wave-render's drawRows with M / S and a fader, the markers banner,
// and the song strip with a viewport bracket for the visible window. A key column on the left names
// each lane; the tempo lane's guide values sit in it. Every lane shares one time window.
//
// Pointer model: the ruler and a row click select the nearest bar line (rows: the nearest grid
// line with Snap on, the exact time with Snap off) and cue there when stopped (seek while playing);
// the tempo lane is lane.js's (pins drag, double-click pins/unpins); the wheel zooms at the pointer
// (horizontal or Shift pans, as 1.9). While playing, the window follows the playhead unless the user
// moved it in the last FOLLOW_IDLE_MS. A selection outside the window scrolls it into view at 25 %.
// Grid and Snap are remembered for the page session (not stored).
//
// While mounted the view provides the 'mapView' command context: {zoom(dir), fit(), zoomSelection(),
// toggleGrid(), gridOn(), setGrid(division), grid(), toggleSnap(), snapOn(), focusMeter(),
// applyFocused(), escape(), playing(), window()}.
import '../../styles/views/edit/map.css';
import {registry as appRegistry} from '../../app/commands.js';
import {prefs as appPrefs} from '../../app/prefs.js';
import {platform as appPlatform} from '../../app/platform.js';
import * as appFeedback from '../../app/feedback.js';
import {now as clockNow} from '../../app/clock.js';
import {effect, signal, untracked} from '../../app/store.js';
import {h} from '../../ui/h.js';
import {Button, IconButton} from '../../ui/button.js';
import {Toggle} from '../../ui/toggle.js';
import {Fader, percent} from '../../ui/fader.js';
import {Menu} from '../../ui/menu.js';
import {Kbd} from '../../ui/kbd.js';
import {stemColor} from '../../ui/stem-pad.js';
import {wheelNavigation} from '../../js/timeline-navigation.js';
import {gridTicks} from '../../stage/grid.js';
import {drawGrid, drawRows, STEM_KEYS} from '../../stage/wave-render.js';
import {mountStrip} from '../../stage/strip.js';
import {stemLabel} from '../../stage/transport-commands.js';
import {mountFindPanel as findPanel} from './find-panel.js';
import {createRuler, createTempoLane, selectLine} from './lane.js';
import {createMarkersBanner, createSectionsLane} from './sections.js';
import {mountInspector} from './inspector.js';
import {COPY, GRID_CHOICES, MAP_COMMANDS as C} from './map.copy.js';

/** The smallest visible window (s), as the Stems surface. */
export const MIN_SPAN = 0.25;
/** − / + zoom by this factor. */
export const ZOOM_STEP = 2;
/** The wheel's zoom rate per pixel of delta (as 1.9). */
export const WHEEL_ZOOM_RATE = 0.0015;
/** Follow pages the playhead back here (fraction of the width) when it reaches FOLLOW_EDGE. */
export const FOLLOW_LINE = 0.1;
export const FOLLOW_EDGE = 0.9;
/** A selection that leaves the window is revealed here (fraction of the width). */
export const REVEAL_AT = 0.25;
/** Manual navigation (wheel, zoom, the strip's bracket) holds Follow off this long while playing. */
export const FOLLOW_IDLE_MS = 8000;
/** Grid lines closer than this are not drawn (the "barcode" rule). */
export const GRID_MIN_PX = 6;
/** Zoom to selection shows the selected bar and this many bars either side. */
export const SELECTION_SPREAD = 1;

const EPS = 1e-6;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const peek = (s) => (s && typeof s === 'object' && typeof s.peek === 'function' ? s.peek() : s);
const colorKey = (name) => {
  const lower = String(name ?? '').toLowerCase();
  return STEM_KEYS.includes(lower) ? lower : 'other';
};

/** A key-cap hint inside a control: aria-hidden, shown only inside [data-kbd-hints] (spec §5.0). */
export function hint(el, keys) {
  if (!el || !keys) return null;
  const k = Kbd({keys, hint: true, className: 'map-hint'});
  k.el.setAttribute('aria-hidden', 'true');
  el.append(k.el);
  return k;
}

/** Grid and Snap for the page session (the toolbar's state survives a tab switch, not a reload). */
const remembered = {grid: 'beat', lastDivision: 'beat', snap: true};

// ------------------------------------------------------------------ pure window helpers

/** A window {t0, span} kept inside [0, duration] as a whole (hitting an end never changes the zoom). */
export function clampWindow({t0 = 0, span = 0} = {}, duration = 0, minSpan = MIN_SPAN) {
  const d = Math.max(0, finite(duration) ? duration : 0);
  if (!(d > 0)) return {t0: 0, span: 0};
  const s = clamp(finite(span) && span > 0 ? span : d, Math.min(minSpan, d), d);
  return {t0: clamp(finite(t0) ? t0 : 0, 0, d - s), span: s};
}

/** Zoom a window by `factor` (< 1 zooms in), keeping time `at` at the same place on screen. */
export function zoomWindow(win, {at, factor}, duration, minSpan = MIN_SPAN) {
  if (!(win?.span > 0)) return clampWindow(win, duration, minSpan);
  const d = Math.max(0, duration || 0);
  const span = clamp(win.span * factor, Math.min(minSpan, d), d);
  const anchor = finite(at) ? at : win.t0 + win.span / 2;
  const frac = clamp((anchor - win.t0) / win.span, 0, 1);
  return clampWindow({t0: anchor - frac * span, span}, d, minSpan);
}

/** The window that shows [a, b] with a small margin. */
export function windowAround(a, b, duration, {margin = 0.05, minSpan = MIN_SPAN} = {}) {
  const length = Math.max(minSpan, b - a);
  return clampWindow({t0: a - length * margin, span: length * (1 + 2 * margin)}, duration, minSpan);
}

/**
 * Where Follow moves the window for the playhead at `pos` (null: leave it). The playhead pages
 * back to FOLLOW_LINE when it passes FOLLOW_EDGE or is outside the window.
 */
export function followWindow(win, pos, duration) {
  if (!(win?.span > 0) || !finite(pos)) return null;
  const frac = (pos - win.t0) / win.span;
  if (frac >= 0 && frac <= FOLLOW_EDGE) return null;
  const next = clampWindow({t0: pos - win.span * FOLLOW_LINE, span: win.span}, duration);
  return Math.abs(next.t0 - win.t0) < EPS ? null : next;
}

// ------------------------------------------------------------------ the view

export function mountMapView(el, opts = {}) {
  const {session, mapSession} = opts;
  if (!el) throw new TypeError('mountMapView needs a host element.');
  if (!session?.map || !mapSession) throw new TypeError('mountMapView needs a session and a map session.');
  const registry = opts.registry ?? appRegistry;
  const prefs = opts.prefs ?? appPrefs;
  const platform = opts.platform ?? appPlatform;
  const feedback = opts.feedback ?? appFeedback;
  const mountFindPanel = opts.mountFindPanel ?? findPanel;
  const raf = opts.raf ?? ((fn) => (typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame(fn) : setTimeout(fn, 16)));
  const caf = opts.caf ?? ((id) => (typeof globalThis.cancelAnimationFrame === 'function' ? globalThis.cancelAnimationFrame(id) : clearTimeout(id)));
  const {map, transport} = session;
  const doc = el.ownerDocument ?? document;
  const win = doc.defaultView ?? globalThis.window;
  const offs = [];
  const parts = [];      // primitives and sub-views destroyed with the view
  const keep = (p) => { parts.push(p); return p; };
  let destroyed = false;

  // ---------------------------------------------------------------- state
  let grid = GRID_CHOICES.includes(remembered.grid) ? remembered.grid : 'beat';
  let snapOn = remembered.snap !== false;
  let view = {t0: 0, span: 0};
  let width = 0;
  let manualAt = -Infinity;
  let fitted = true;        // the window is the whole song (Fit): it re-fits when the duration changes
  const viewport = signal(null);
  const duration = () => Math.max(0, map.duration || session.engine?.duration || 0);
  const mapped = () => !!map.isReal;
  const coarse = () => !!peek(platform?.coarse) || !!platform?.isIPad;
  const snapshot = () => peek(transport?.snapshot) ?? {};
  const playing = () => {
    const phase = snapshot().phase;
    return phase === 'playing' || phase === 'counting';
  };
  const position = () => (typeof transport?.position === 'function' ? transport.position() : Number(snapshot().cue) || 0);
  const tracks = () => {
    const list = snapshot().mix?.tracks;
    return Array.isArray(list) ? list : [];
  };

  // ---------------------------------------------------------------- DOM
  const toolbar = h('div', {class: 'map-toolbar', role: 'group', attrs: {'aria-label': COPY.toolbar}, dataset: {testid: 'map-toolbar'}});
  const rulerKey = h('div', {class: 'map-key map-key-ruler', 'aria-hidden': 'true'}, COPY.rulerKey);
  const sectionsKey = h('div', {class: 'map-key map-key-sections', 'aria-hidden': 'true'}, COPY.sectionsKey);
  const tempoKey = h('div', {class: 'map-key map-key-tempo', 'aria-hidden': 'true'}, h('span', {class: 'map-key-name'}, COPY.tempoKey));
  const rulerCell = h('div', {class: 'map-cell map-cell-ruler'});
  const sectionsCell = h('div', {class: 'map-cell map-cell-sections'});
  const sectionsBarCell = h('div', {class: 'map-cell map-cell-sections-bar'});
  const tempoCell = h('div', {class: 'map-cell map-cell-tempo'});
  const rowsCanvas = h('canvas', {class: 'map-rows-canvas', 'aria-hidden': 'true', dataset: {testid: 'map-rows-canvas'}});
  const rowsCell = h('div', {class: 'map-cell map-cell-rows', 'aria-hidden': 'true'}, rowsCanvas);
  const heads = h('div', {class: 'map-heads', role: 'list', attrs: {'aria-label': COPY.rows}});
  const cursorEl = h('div', {class: 'map-cursor', 'aria-hidden': 'true'});
  const playheadEl = h('div', {class: 'map-playhead', 'aria-hidden': 'true', dataset: {volatile: ''}});
  const overlay = h('div', {class: 'map-overlay', 'aria-hidden': 'true'}, cursorEl, playheadEl);
  const lanes = h('div', {class: 'map-lanes', role: 'group', attrs: {'aria-label': COPY.lanes}, dataset: {testid: 'map-lanes'}},
    rulerKey, rulerCell, sectionsKey, sectionsCell, sectionsBarCell, tempoKey, tempoCell, heads, rowsCell, overlay);
  const bannerHost = h('div', {class: 'map-banners'});
  const stripHost = h('div', {class: 'map-strip'});
  const root = h('section', {class: 'map-view', attrs: {'aria-label': COPY.region}, dataset: {testid: 'map-view'}},
    toolbar, lanes, bannerHost, stripHost);
  el.append(root);
  const ownInspector = !opts.inspectorEl;
  const inspectorHost = opts.inspectorEl ?? h('div', {class: 'map-inspector-host'});
  if (ownInspector) el.append(inspectorHost);

  // ---------------------------------------------------------------- toolbar
  const zoomGroup = h('div', {class: 'map-tool-group'},
    keep(IconButton({label: COPY.zoomOut, icon: 'zoom-out', command: C.zoomOut, size: 'sm', registry})).el,
    keep(IconButton({label: COPY.zoomIn, icon: 'zoom-in', command: C.zoomIn, size: 'sm', registry})).el,
    keep(Button({label: COPY.fit, command: C.fit, size: 'sm', variant: 'quiet', registry})).el);
  const zoomSelectionButton = keep(Button({label: COPY.zoomSelection, icon: 'scan', command: C.zoomSelection, size: 'sm', variant: 'quiet', registry}));
  keep(hint(zoomSelectionButton.el, 'KeyZ'));
  let gridMenu = null;
  const gridButton = keep(Button({label: COPY.gridButton(COPY.divisions[grid]), iconEnd: 'chevron-down', size: 'sm', variant: 'quiet',
    attrs: {'aria-haspopup': 'menu', 'aria-expanded': 'false'}, className: 'map-grid-button', onClick: () => openGridMenu()}));
  const snapToggle = keep(Toggle({label: COPY.snap, icon: 'magnet', command: C.snap, size: 'sm', variant: 'quiet', registry}));
  keep(hint(snapToggle.el, 'Shift+KeyS'));
  toolbar.append(zoomGroup, zoomSelectionButton.el, gridButton.el, snapToggle.el);

  function renderToolbar() {
    gridButton.set({label: COPY.gridButton(COPY.divisions[grid])});
    gridButton.el.hidden = !mapped();
    zoomSelectionButton.el.hidden = !mapped();
    if (!mapped()) gridMenu?.close?.();
    root.dataset.grid = grid;
    root.toggleAttribute('data-snap', snapOn);
  }

  function openGridMenu() {
    if (!mapped()) return;
    gridMenu?.close?.();
    gridButton.el.setAttribute('aria-expanded', 'true');
    const items = GRID_CHOICES.map((choice) => ({
      id: `map-grid-${choice}`, type: 'radio', label: COPY.divisions[choice], checked: grid === choice, run: () => setGrid(choice),
    }));
    gridMenu = Menu.open(items, {
      anchor: gridButton.el, label: COPY.grid, registry,
      onClose: () => { gridButton.el.setAttribute('aria-expanded', 'false'); gridMenu = null; },
    });
  }

  function setGrid(choice) {
    if (!GRID_CHOICES.includes(choice) || choice === grid) return;
    grid = choice;
    remembered.grid = choice;
    if (choice !== 'off') remembered.lastDivision = choice;
    renderToolbar();
    registry.invalidate?.();
    scheduleDraw();
  }
  const toggleGrid = () => setGrid(grid === 'off' ? (remembered.lastDivision || 'beat') : 'off');
  function toggleSnap() {
    snapOn = !snapOn;
    remembered.snap = snapOn;
    renderToolbar();
    registry.invalidate?.();
  }

  // ---------------------------------------------------------------- lanes
  const ruler = createRuler(rulerCell, {map, onPick: (t) => pickBar(t)});
  const tempo = createTempoLane(tempoCell, {session, mapSession, coarse, requestDraw: () => scheduleDraw()});
  tempoKey.append(tempo.guides);
  const sections = createSectionsLane(sectionsCell, {session, mapSession, registry, coarse});
  sectionsBarCell.append(sections.bar);
  const banner = createMarkersBanner(bannerHost, {session, registry});

  /** A ruler click: the nearest bar line becomes the selection (and the cue when stopped). */
  function pickBar(t) {
    const time = clamp(t, 0, duration());
    if (!mapped()) { cueAt(time); return; }
    const line = map.nearestLine(time, {bars: true});
    if (line) selectLine(session, mapSession, line.q);
  }

  /** Cue (stopped) or seek (playing) to an exact time. */
  function cueAt(t) {
    if (!transport) return;
    if (playing()) transport.seek?.(t);
    else transport.cue?.(t);
  }

  // ---------------------------------------------------------------- stem rows
  const rows = new Map();   // name → {head, mute, solo, fader, level, word}
  let rowOrder = [];

  function createRow(track) {
    const label = stemLabel(track.name);
    const color = h('span', {class: 'map-row-color', 'aria-hidden': 'true'});
    color.style.setProperty('--map-row-color', stemColor(colorKey(track.name)));
    const word = h('span', {class: 'map-row-word', 'aria-hidden': 'true'});
    const mute = Button({label: COPY.muteShort, size: 'sm', variant: 'secondary', className: 'map-ms', attrs: {'aria-label': COPY.mute(label)},
      pressed: false, onClick: () => { const t = trackOf(track.name); if (t) transport.setMuted(track.name, !t.muted); }});
    const solo = Button({label: COPY.soloShort, size: 'sm', variant: 'secondary', className: 'map-ms', attrs: {'aria-label': COPY.solo(label)},
      pressed: false, onClick: () => { const t = trackOf(track.name); if (t) transport.setSoloed(track.name, !t.soloed); }});
    const level = h('span', {class: 'map-row-level', 'aria-hidden': 'true'});
    const showLevel = (v) => { level.textContent = percent(v); };
    const fader = Fader({label: COPY.level(label), value: finite(track.volume) ? track.volume : 1, variant: 'inline', className: 'map-fader',
      showValue: false,
      onInput: (v) => { showLevel(v); transport.setVolume(track.name, v); },
      onChange: (v) => { showLevel(v); transport.setVolume(track.name, v); }});
    showLevel(fader.value);
    const head = h('div', {class: 'map-head', role: 'listitem'},
      h('div', {class: 'map-head-body', role: 'group', attrs: {'aria-label': label}},
        color,
        h('div', {class: 'map-head-line'}, h('span', {class: 'map-row-name'}, label), word),
        h('div', {class: 'map-head-line'}, mute.el, solo.el, level),
        h('div', {class: 'map-head-line map-head-fader'}, fader.el)));
    return {name: track.name, head, mute, solo, fader, level, word, showLevel};
  }

  const trackOf = (name) => tracks().find((t) => t.name === name) ?? null;
  const rowStateOf = (track, anySolo) => (anySolo && track.soloed ? 'solo' : track.muted ? 'out' : anySolo ? 'dim' : 'on');

  function renderRows() {
    const list = tracks();
    const names = list.map((t) => t.name);
    const anySolo = list.some((t) => t.soloed);
    if (names.join('\n') !== rowOrder.join('\n')) {
      for (const [name, row] of rows) {
        if (names.includes(name)) continue;
        row.mute.destroy(); row.solo.destroy(); row.fader.destroy?.();
        row.head.remove();
        rows.delete(name);
      }
      for (const t of list) {
        let row = rows.get(t.name);
        if (!row) { row = createRow(t); rows.set(t.name, row); }
        heads.append(row.head);
      }
      rowOrder = names;
      root.style.setProperty('--map-rows', String(Math.max(1, names.length)));
    }
    for (const t of list) {
      const row = rows.get(t.name);
      const state = rowStateOf(t, anySolo);
      row.head.dataset.state = state;
      row.word.textContent = state === 'solo' ? COPY.soloWord : state === 'out' ? COPY.out : '';
      row.mute.set({pressed: !!t.muted});
      row.solo.set({pressed: !!t.soloed});
      if (!row.fader.dragging && finite(t.volume) && Math.abs(row.fader.value - t.volume) > 1e-4) {
        row.fader.set({value: t.volume});
        row.showLevel(row.fader.value);
      }
    }
  }

  /** Each row's band inside the rows canvas (from the headers when laid out, else an equal split). */
  function rowBoxes(height) {
    const n = rowOrder.length;
    if (!n || !(height > 0)) return [];
    const top = rowsCell.getBoundingClientRect?.().top ?? 0;
    const measured = rowOrder.map((name) => rows.get(name)?.head.getBoundingClientRect?.());
    if (measured.every((r) => r && r.height > 0)) return measured.map((r) => ({y: r.top - top, h: r.height}));
    const each = height / n;
    return rowOrder.map((_, i) => ({y: i * each, h: each}));
  }

  // ---------------------------------------------------------------- window
  const t1Of = () => view.t0 + view.span;
  const toX = (t) => (view.span > 0 && width > 0 ? ((t - view.t0) / view.span) * width : 0);
  const toT = (x) => (view.span > 0 && width > 0 ? view.t0 + (x / width) * view.span : view.t0);

  function setWindow(next, {manual = false} = {}) {
    const clamped = clampWindow(next, duration());
    const changed = Math.abs(clamped.t0 - view.t0) > EPS || Math.abs(clamped.span - view.span) > EPS;
    view = clamped;
    fitted = Math.abs(view.span - duration()) < EPS && view.t0 < EPS;
    if (manual) manualAt = clockNow();
    if (changed) {
      root.dataset.t0 = String(Math.round(view.t0 * 1000) / 1000);
      root.dataset.t1 = String(Math.round(t1Of() * 1000) / 1000);
      writeViewport();
      scheduleDraw();
    }
    return changed;
  }
  function writeViewport() {
    const next = view.span > 0 ? {t0: view.t0, t1: t1Of()} : null;
    const current = viewport.peek();
    if (next && current && Math.abs(current.t0 - next.t0) < EPS && Math.abs(current.t1 - next.t1) < EPS) return;
    viewport.value = next;
  }

  const anchorTime = () => {
    const t = selectionTime();
    return finite(t) && t >= view.t0 && t <= t1Of() ? t : view.t0 + view.span / 2;
  };
  const selectionTime = () => (mapped() ? map.timeAt(mapSession.cursorQ.peek()) : position());
  function zoom(dir) {
    const factor = dir > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
    setWindow(zoomWindow(view, {at: anchorTime(), factor}, duration()), {manual: true});
  }
  function fit() { setWindow({t0: 0, span: duration()}, {manual: true}); }
  /** Z: the selected bar and its neighbours. */
  function zoomSelection() {
    if (!mapped()) return;
    const bars = map.bars;
    if (!bars.length) return;
    const index = clamp(Number(mapSession.span.peek()?.index) || 0, 0, bars.length - 1);
    const from = bars[Math.max(0, index - SELECTION_SPREAD)], to = bars[Math.min(bars.length - 1, index + SELECTION_SPREAD)];
    setWindow(windowAround(from.t0, to.t1, duration()), {manual: true});
  }
  /** A time outside the window scrolls into view at REVEAL_AT (the zoom stays). */
  function reveal(t) {
    if (!finite(t) || !(view.span > 0)) return;
    if (t >= view.t0 && t <= t1Of()) return;
    setWindow({t0: t - view.span * REVEAL_AT, span: view.span});
  }

  // Wheel: vertical zooms at the pointer, horizontal or Shift pans (1.9's model).
  const wheel = wheelNavigation();
  function onWheel(e) {
    if (!(view.span > 0) || !(width > 0)) return;
    const {mode, delta} = wheel(e, width, clockNow());
    if (!delta) return;
    e.preventDefault();
    const rect = rowsCell.getBoundingClientRect();
    if (mode === 'zoom') {
      const at = toT(clamp(e.clientX - rect.left, 0, width));
      setWindow(zoomWindow(view, {at, factor: Math.exp(delta * WHEEL_ZOOM_RATE)}, duration()), {manual: true});
    } else {
      setWindow({t0: view.t0 + (delta / width) * view.span, span: view.span}, {manual: true});
    }
  }
  lanes.addEventListener('wheel', onWheel, {passive: false});

  // A click on a stem row: the nearest line (Snap on: bars with the bar grid, beats otherwise) or the exact time.
  function onRowsDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const rect = rowsCell.getBoundingClientRect();
    const t = clamp(toT(e.clientX - rect.left), 0, duration());
    if (mapped() && snapOn && !e.shiftKey) {
      const line = map.nearestLine(t, {bars: grid === 'bar'});
      if (line) { selectLine(session, mapSession, line.q); return; }
    }
    if (mapped()) mapSession.selectNear(t);
    cueAt(t);
  }
  rowsCell.addEventListener('pointerdown', onRowsDown);

  // ---------------------------------------------------------------- drawing
  let drawQueued = null;
  function scheduleDraw() {
    if (drawQueued != null || destroyed) return;
    drawQueued = raf(() => { drawQueued = null; draw(); });
  }

  function measure() {
    const r = rowsCell.getBoundingClientRect?.();
    const w = Math.max(0, Math.round(rowsCell.clientWidth || r?.width || 0));
    if (w !== width) width = w;
    if (!(view.span > 0) || fitted) setWindow({t0: 0, span: duration()});
  }

  function draw() {
    if (destroyed) return;
    measure();
    const real = mapped();
    root.dataset.mapped = String(real);
    root.toggleAttribute('data-compact', coarse());
    renderToolbar();
    const lane = {t0: view.t0, span: view.span, width, duration: duration()};
    ruler.render(lane, {mapped: real, selected: real ? mapSession.span.peek()?.index ?? null : null});
    sections.render(lane);
    tempo.render(lane, {mapped: real});
    renderRows();
    drawRowsCanvas();
    placeLines();
  }

  function drawRowsCanvas() {
    const r = rowsCell.getBoundingClientRect?.();
    const height = Math.max(0, Math.round(rowsCell.clientHeight || r?.height || 0));
    const dpr = win?.devicePixelRatio || 1;
    rowsCanvas.style.width = `${width}px`;
    rowsCanvas.style.height = `${height}px`;
    if (!width || !height || !(view.span > 0)) { delete rowsCanvas.dataset.peaksReady; return; }
    const pw = Math.round(width * dpr), ph = Math.round(height * dpr);
    if (rowsCanvas.width !== pw) rowsCanvas.width = pw;
    if (rowsCanvas.height !== ph) rowsCanvas.height = ph;
    const ctx = rowsCanvas.getContext?.('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const list = tracks();
    const anySolo = list.some((t) => t.soloed);
    const boxes = rowBoxes(height);
    const peaks = session.peaks;
    drawRows(ctx, {
      rows: list.map((t, i) => ({name: t.name, color: colorKey(t.name), state: rowStateOf(t, anySolo), y: boxes[i]?.y ?? 0, h: boxes[i]?.h ?? 0})),
      t0: view.t0, t1: t1Of(), width, dpr, peaks,
    });
    if (peaks?.ready) rowsCanvas.dataset.peaksReady = 'true'; else delete rowsCanvas.dataset.peaksReady;
    let drawn = null;
    if (mapped() && grid !== 'off') {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawn = drawGrid(ctx, {ticks: gridTicks(map, view.t0, t1Of(), grid), t0: view.t0, t1: t1Of(), w: width, h: height, minPx: GRID_MIN_PX});
    }
    const kinds = drawn ? Object.keys(drawn).filter((k) => drawn[k]) : [];
    if (kinds.length) rowsCanvas.dataset.gridDrawn = kinds.join(' '); else delete rowsCanvas.dataset.gridDrawn;
  }

  function placeLine(line, t) {
    if (!finite(t) || !(view.span > 0) || t < view.t0 - EPS || t > t1Of() + EPS) { line.hidden = true; return; }
    line.hidden = false;
    line.style.transform = `translateX(${Math.round(toX(t) * 10) / 10}px)`;
  }
  function placeLines(pos = position()) {
    placeLine(cursorEl, mapped() ? map.timeAt(mapSession.cursorQ.peek()) : null);
    placeLine(playheadEl, pos);
  }

  /** One frame: the playhead line, and Follow while playing. */
  function onFrame(f) {
    if (destroyed) return;
    const pos = finite(f?.position) ? f.position : position();
    if (f?.playing || f?.counting || playing()) {
      const idle = clockNow() - manualAt >= FOLLOW_IDLE_MS;
      const next = idle ? followWindow(view, pos, duration()) : null;
      if (next) setWindow(next);
    }
    placeLine(playheadEl, pos);
  }

  // ---------------------------------------------------------------- the inspector or Find a chart
  let side = null;
  if (opts.find) {
    side = mountFindPanel(inspectorHost, {session, mapSession, onClose: () => opts.onCloseFind?.()});
  } else {
    side = mountInspector(inspectorHost, {session, mapSession, registry, prefs, feedback,
      ...(opts.store ? {store: opts.store} : {}), ...(opts.desktop ? {desktop: opts.desktop} : {})});
  }

  // ---------------------------------------------------------------- hooks (status, rename)
  const hooks = opts.mapHooks ?? null;
  const savedHooks = hooks ? {status: hooks.status, rename: hooks.rename} : null;
  if (hooks) {
    // Results that offer Undo (a tap pass, markers → sections, Section n added · Rename) land in the
    // inspector's status line (feedback's status line, which the inspector renders while mounted).
    hooks.status = (text, options = {}) => feedback.status?.(text, {key: 'map', durationMs: 8000, ...options});
    hooks.rename = (barIndex) => {
      reveal(map.bars[barIndex]?.t0);
      return sections.rename(barIndex);
    };
  }

  // ---------------------------------------------------------------- the strip
  const strip = mountStrip(stripHost, {
    session, registry, viewport,
    onViewport: ({t0, t1}) => { if (finite(t0) && finite(t1) && t1 > t0) setWindow({t0, span: t1 - t0}, {manual: true}); },
  });

  // ---------------------------------------------------------------- the 'mapView' context
  const api = {
    zoom, fit, zoomSelection, toggleGrid, setGrid, toggleSnap, reveal,
    gridOn: () => mapped() && grid !== 'off',
    grid: () => grid,
    snapOn: () => snapOn,
    playing,
    window: () => ({t0: view.t0, t1: t1Of()}),
    focusMeter: () => side?.focusMeter?.() ?? false,
    applyFocused: () => side?.applyFocused?.() ?? false,
    /** The map view's own Esc layer (§3.4 edit.done): close the Grid menu, else cancel a rename or close the review. */
    escape: () => {
      if (gridMenu) { gridMenu.close?.(); return true; }
      return sections.escape();
    },
  };
  offs.push(registry.provide('mapView', () => (destroyed ? undefined : api)));

  // ---------------------------------------------------------------- wiring
  offs.push(map.subscribe(() => { scheduleDraw(); registry.invalidate?.(); }));
  offs.push(effect(() => {
    mapSession.cursorQ.value; mapSession.span.value;
    if (destroyed) return;
    untracked(() => {
      if (mapped()) reveal(map.timeAt(mapSession.cursorQ.peek()));
      scheduleDraw();
    });
  }));
  for (const s of [transport?.snapshot, session.load, mapSession.previewing, mapSession.tapping, mapSession.auditioning, mapSession.calibrating]) {
    if (s?.subscribe) offs.push(s.subscribe(() => { scheduleDraw(); registry.invalidate?.(); }));
  }
  if (session.frame?.subscribe) offs.push(session.frame.subscribe(onFrame, {hz: 60}));
  if (typeof win?.ResizeObserver === 'function') {
    const ro = new win.ResizeObserver(() => scheduleDraw());
    ro.observe(lanes);
    offs.push(() => ro.disconnect());
  } else if (win?.addEventListener) {
    const onResize = () => scheduleDraw();
    win.addEventListener('resize', onResize);
    offs.push(() => win.removeEventListener('resize', onResize));
  }
  const onTheme = () => scheduleDraw();
  win?.addEventListener?.('woodshed:theme', onTheme);
  offs.push(() => win?.removeEventListener?.('woodshed:theme', onTheme));

  // First paint, then the route's requests: ?bar=N selects that bar, ?review=sections opens the review.
  setWindow({t0: 0, span: duration()});
  draw();
  const bar = Number(opts.query?.bar);
  if (mapped() && opts.query?.bar !== undefined && opts.query?.bar !== '' && finite(bar)) {
    mapSession.goToBar(bar);
    selectLine(session, mapSession, mapSession.cursorQ.peek());
    reveal(map.timeAt(mapSession.cursorQ.peek()));
  }
  if (opts.review && !opts.find) sections.openReview();
  registry.invalidate?.();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (drawQueued != null) caf(drawQueued);
    drawQueued = null;
    lanes.removeEventListener('wheel', onWheel);
    rowsCell.removeEventListener('pointerdown', onRowsDown);
    for (const off of offs.splice(0)) { try { off?.(); } catch (err) { console.error('[map view] cleanup failed', err); } }
    if (hooks && savedHooks) { hooks.status = savedHooks.status; hooks.rename = savedHooks.rename; }
    gridMenu?.close?.();
    for (const row of rows.values()) { row.mute.destroy(); row.solo.destroy(); row.fader.destroy?.(); }
    rows.clear();
    for (const p of [side, strip, banner, sections, tempo, ruler, ...parts.splice(0)]) {
      try { p?.destroy?.(); } catch (err) { console.error('[map view] cleanup failed', err); }
    }
    root.remove();
    if (ownInspector) inspectorHost.remove();
    registry.invalidate?.();
  }

  return {el: root, destroy, ...api, get side() { return side; }, get sections() { return sections; }};
}

export default mountMapView;
