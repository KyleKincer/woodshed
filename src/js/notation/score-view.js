// Engraved drum notation for reading and editing. alphaTab lays out and draws
// the score; this module owns an overlay for the playing bar, beat cursor,
// loop range, selection and edit caret, a handle layer for the loop edges, and
// maps pointer positions back to bars, beats and hits. All positions are
// absolute quarter notes.
//
// Colours and the label typeface come from the host's computed tokens
// (--ink, --ink-3, --ink-2, --font-ui), so a scoped token set (the always-dark
// Stage, D3) wins over the app theme. The 1.9 signatures of createScoreView,
// setScore, noteBoxes() and barBounds() are kept: the geometry harness
// (tests/fixture/harness/score-geometry.js) calls them on both trees.
import * as alphaTab from '@coderline/alphatab';
import bravuraWoff2 from '@coderline/alphatab/font/Bravura.woff2?url';
import bravuraWoff from '@coderline/alphatab/font/Bravura.woff?url';
import {number, musicalStarts} from '../../../shared/notation.ts';
import {buildAlphaTabScore} from './alphatab-score.js';
import '../../styles/views/notation/score-view.css';

const SVG = 'http://www.w3.org/2000/svg';
/** alphaTab label sizes in engraving px (multiplied by display.scale); the 1.9 values. */
export const DEFAULT_FONTS = Object.freeze({barNumber: 11, marker: 15});
/** The loop-edge hit area: 44 px wide × the system's height (spec §4.8). */
export const HANDLE_HIT_PX = 44;
/** The face the first render waits for, at most FONT_WAIT_MS (§2.14.12). */
export const FONT_PROBE = '600 15px "Atkinson Hyperlegible Next"';
export const FONT_WAIT_MS = 1500;
const FALLBACK_FAMILY = 'Arial, Helvetica, sans-serif';
// Used only when the host resolves no tokens (a page without tokens.css); the paper values.
const FALLBACK = {ink: '#17201f', ink2: '#3f4a46', ink3: '#626d68'};
// alphaTab print colours (exempt from the colour guard, §7.6); ink comes from --print-ink.
const PRINT = {ink: '#111111', muted: '#555555', lines: '#444444'};

let fontsWait = null;
/** Resolves once the UI face is loaded, after FONT_WAIT_MS, or at once without document.fonts. */
function waitForFonts() {
  if (fontsWait) return fontsWait;
  const fonts = globalThis.document?.fonts;
  if (typeof fonts?.load !== 'function') { fontsWait = Promise.resolve(true); return fontsWait; }
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, FONT_WAIT_MS); });
  fontsWait = Promise.race([Promise.resolve().then(() => fonts.load(FONT_PROBE)).catch(() => {}), timeout])
    .then(() => { clearTimeout(timer); return true; });
  return fontsWait;
}

function pickFonts(fonts) {
  const out = {};
  for (const key of ['barNumber', 'marker']) {
    const value = Number(fonts?.[key]);
    if (Number.isFinite(value) && value > 0) out[key] = Math.round(value);
  }
  return out;
}

/**
 * @param host element to render into
 * @param options.scale engraving scale (1 = alphaTab default)
 * @param options.barsPerRow -1 for automatic by width
 * @param options.fonts {barNumber, marker} label sizes in engraving px (default DEFAULT_FONTS)
 * @param options.resizeSettleMs 0: a width change re-engraves at once (alphaTab's own 10 ms
 *   throttle). Above 0 it waits this long after the last width change and re-engraves only if no
 *   relayout or render since took the new width, so a size change that comes with the width
 *   change (configure + relayout) engraves once.
 * @param options.onRender (view) after every finished engraving
 * @param options.onPointer ({kind:'down'|'move'|'up'|'cancel', event, at}) pointer callback
 */
export function createScoreView(host, {scale = 1, barsPerRow = -1, print = false, fonts = null, resizeSettleMs = 0, onRender = () => {}, onPointer = null} = {}) {
  host.classList.add('score-view');
  const stage = document.createElement('div');
  stage.className = 'score-stage';
  const root = document.createElement('div');
  root.className = 'score-engraving';
  const overlay = document.createElementNS(SVG, 'svg');
  overlay.setAttribute('class', 'score-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  const handles = document.createElementNS(SVG, 'svg');
  handles.setAttribute('class', 'score-handles');
  handles.setAttribute('aria-hidden', 'true');
  stage.append(overlay, root, handles);
  host.replaceChildren(stage);

  const css = name => {
    try { return getComputedStyle(host).getPropertyValue(name).trim(); } catch { return ''; }
  };
  function el(name, attrs = {}) { const node = document.createElementNS(SVG, name); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node; }
  const set = (node, attrs) => { for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); };

  const settings = new alphaTab.Settings();
  settings.core.useWorkers = false;
  settings.core.includeNoteBounds = true;
  settings.core.enableLazyLoading = !print;
  settings.core.smuflFontSources = new Map([[alphaTab.FontFileFormat.Woff2, bravuraWoff2], [alphaTab.FontFileFormat.Woff, bravuraWoff]]);
  settings.player.enablePlayer = false;
  settings.player.enableCursor = false;
  settings.player.enableUserInteraction = false;
  settings.display.layoutMode = alphaTab.LayoutMode.Page;
  settings.display.staveProfile = alphaTab.StaveProfile.Score;
  settings.display.scale = scale;
  settings.display.barsPerRow = barsPerRow;
  settings.display.justifyLastSystem = false;
  settings.display.padding = [12, 18, 12, 18];
  settings.display.firstSystemPaddingTop = 6;
  settings.display.systemPaddingTop = 6;
  settings.display.systemPaddingBottom = 18;
  for (const element of ['ScoreTitle', 'ScoreSubTitle', 'ScoreArtist', 'ScoreAlbum', 'ScoreWords', 'ScoreMusic', 'ScoreWordsAndMusic', 'ScoreCopyright', 'GuitarTuning', 'TrackNames', 'EffectDynamics', 'ChordDiagrams'])
    settings.notation.elements.set(alphaTab.NotationElement[element], false);

  // Theme (spec §8.3): --ink for glyphs, --ink-3 for staff lines and bar separators, --ink-2 for bar numbers.
  function themeResources() {
    const ink = print ? css('--print-ink') || PRINT.ink : css('--ink') || FALLBACK.ink;
    const numbers = print ? PRINT.muted : css('--ink-2') || FALLBACK.ink2;
    const lines = print ? PRINT.lines : css('--ink-3') || FALLBACK.ink3;
    // The second voice uses secondaryGlyphColor; drums need both voices at full ink.
    return {mainGlyphColor: ink, secondaryGlyphColor: ink, staffLineColor: lines, barSeparatorColor: lines, barNumberColor: numbers, scoreInfoColor: ink};
  }
  let labelSizes = {...DEFAULT_FONTS, ...pickFonts(fonts)};
  // Labels use the app's typeface; section marks read like rehearsal letters.
  const family = () => (css('--font-ui') || FALLBACK_FAMILY).replace(/"/g, "'");
  let themeKey = '';
  function applyResources() {
    const resources = themeResources(), face = family();
    for (const [key, value] of Object.entries(resources)) settings.display.resources[key] = alphaTab.model.Color.fromJson(value);
    const elementFonts = settings.display.resources.elementFonts, font = spec => alphaTab.model.Font.fromJson(`${spec} ${face}`);
    elementFonts.set(alphaTab.NotationElement.EffectMarker, font(`bold ${labelSizes.marker}px`));
    elementFonts.set(alphaTab.NotationElement.EffectTempo, font('bold 12px'));
    elementFonts.set(alphaTab.NotationElement.BarNumber, font(`${labelSizes.barNumber}px`));
    elementFonts.set(alphaTab.NotationElement.EffectText, font('italic 12px'));
    elementFonts.set(alphaTab.NotationElement.EffectLyrics, font('bold 11px'));
    themeKey = JSON.stringify(resources) + face;
  }
  applyResources();
  const api = new alphaTab.AlphaTabApi(root, settings);

  let built = null, score = null, renderOptions = {}, starts = [], ready = false, disposed = false, fontsLoaded = false, renderToken = 0;
  // Width changes: alphaTab re-engraves through triggerResize() when its container's width differs
  // from the width it last rendered at. With a settle, that waits; any render in between (render()
  // and renderScore() take the container's current width) makes the late check a no-op.
  let widthTimer = null;
  if (resizeSettleMs > 0 && typeof api.triggerResize === 'function') {
    const resizeNow = api.triggerResize.bind(api);
    api.triggerResize = () => {
      clearTimeout(widthTimer);
      widthTimer = setTimeout(() => {
        widthTimer = null;
        if (disposed) return;
        const container = api.container, renderer = api.renderer;
        // Hidden: nothing to do; showing it again is a width change of its own.
        if (!container?.isVisible || !renderer) return;
        if (container.width !== renderer.width) resizeNow();
      }, resizeSettleMs);
    };
  }
  let playhead = null, loop = null, selection = new Set(), caret = null, focusBars = null, barMarks = new Map();
  let handlesOn = false, dragging = false;
  /** Per rendered bar: knots of {q, x} for cursor interpolation, plus bounds. */
  let geometry = new Map();

  function measureGeometry() {
    geometry = new Map();
    const lookup = api.boundsLookup;
    if (!lookup || !built) return;
    const knots = new Map();
    for (const [beat, info] of built.beats) {
      const bounds = lookup.findBeat(beat);
      if (!bounds) continue;
      const q = number(starts[info.index]) + number(info.beat.start);
      if (!knots.has(info.index)) knots.set(info.index, []);
      knots.get(info.index).push({q, x: bounds.onNotesX, beat, info, bounds});
    }
    built.bars.forEach((index, k) => {
      const master = lookup.findMasterBarByIndex(k);
      if (!master) return;
      const system = master.staffSystemBounds?.realBounds ?? master.realBounds;
      const bar = master.realBounds, start = number(starts[index]), end = start + number(score.timeline.measures[index].length);
      const list = (knots.get(index) || []).sort((a, b) => a.q - b.q || a.x - b.x);
      const unique = [];
      for (const knot of list) if (!unique.length || knot.q > unique.at(-1).q + 1e-9) unique.push(knot); else unique.at(-1).x = Math.min(unique.at(-1).x, knot.x);
      const left = unique.length ? Math.min(unique[0].x, bar.x + bar.w * .12) : bar.x + bar.w * .12;
      const points = [{q: start, x: unique[0]?.q <= start + 1e-9 ? unique[0].x : left}, ...unique.filter(u => u.q > start + 1e-9), {q: end, x: bar.x + bar.w - 4}];
      geometry.set(index, {index, bar, system, start, end, points, beats: list, top: master.visualBounds.y, height: master.visualBounds.h, lineTop: master.lineAlignedBounds?.y ?? bar.y, lineHeight: master.lineAlignedBounds?.h ?? bar.h});
    });
  }

  function barIndexAt(q) {
    let low = 0, high = starts.length - 1, index = 0;
    while (low <= high) { const mid = (low + high) >> 1; if (number(starts[mid]) <= q + 1e-9) { index = mid; low = mid + 1; } else high = mid - 1; }
    return index;
  }
  function xIn(g, q) {
    const p = g.points;
    for (let i = 0; i < p.length - 1; i++) if (q <= p[i + 1].q + 1e-9) {
      const a = p[i], b = p[i + 1];
      return a.x + (b.x - a.x) * Math.max(0, Math.min(1, (q - a.q) / Math.max(1e-9, b.q - a.q)));
    }
    return p.at(-1).x;
  }
  function xAt(q) {
    const g = geometry.get(barIndexAt(q));
    return g ? {g, x: xIn(g, q)} : null;
  }
  /** A loop edge: a start edge sits in the bar that holds q; an end edge on a bar line sits at the end of the bar before it. */
  function edgeAt(q, side) {
    if (side === 'start') {
      const g = geometry.get(barIndexAt(q));
      return g ? {g, x: q <= g.start + 1e-9 ? g.bar.x : xIn(g, q)} : null;
    }
    const g = geometry.get(barIndexAt(q - 1e-6));
    return g ? {g, x: q >= g.end - 1e-9 ? g.bar.x + g.bar.w : xIn(g, q)} : null;
  }

  // Two layers under the notes: marks that change on edits, and the playhead
  // that moves every frame without rebuilding anything else.
  const staticLayer = el('g'), nowBar = el('rect', {class: 'score-now-bar', rx: 4}), nowLine = el('line', {class: 'score-playhead'});
  const nowLayer = el('g', {class: 'score-now'});
  nowLayer.append(nowBar, nowLine);
  overlay.append(staticLayer, nowLayer);
  // Above the notes: the loop edges, each a bracket, a 3 px edge, a 20 px grip
  // dot and a 44 px × system-height hit area that takes pointer events.
  const edges = {};
  for (const side of ['start', 'end']) {
    const group = el('g', {class: 'score-loop-edge', 'data-loop-edge': side});
    const hit = el('rect', {class: 'score-loop-hit', x: -HANDLE_HIT_PX / 2, y: 0, width: HANDLE_HIT_PX, height: 0});
    const line = el('line', {class: 'score-loop-line', x1: 0, x2: 0});
    const bracket = el('path', {class: 'score-loop-bracket'});
    const grip = el('circle', {class: 'score-loop-grip', cx: 0, r: 10});
    group.append(hit, line, bracket, grip);
    group.style.display = 'none';
    handles.append(group);
    edges[side] = {group, hit, line, bracket, grip};
  }

  function drawPlayhead() {
    const at = ready && playhead != null ? xAt(playhead) : null;
    nowLayer.style.display = at ? '' : 'none';
    if (!at) return;
    set(nowBar, {x: at.g.bar.x, y: at.g.lineTop - 8, width: at.g.bar.w, height: at.g.lineHeight + 16});
    set(nowLine, {x1: at.x, x2: at.x, y1: at.g.lineTop - 12, y2: at.g.lineTop + at.g.lineHeight + 12});
  }
  function drawEdges() {
    handles.classList.toggle('is-dragging', dragging);
    for (const side of ['start', 'end']) {
      const edge = edges[side];
      const at = ready && handlesOn && loop ? edgeAt(loop[side === 'start' ? 0 : 1], side) : null;
      edge.group.style.display = at ? '' : 'none';
      if (!at) continue;
      const {g, x} = at, top = g.lineTop - 6 - g.system.y, bottom = g.lineTop + g.lineHeight + 6 - g.system.y, arm = side === 'start' ? 8 : -8;
      edge.group.style.transform = `translate(${x}px, ${g.system.y}px)`;
      set(edge.hit, {height: Math.max(g.system.h, bottom)});
      set(edge.line, {y1: top, y2: bottom});
      set(edge.bracket, {d: `M ${arm} ${top} H 0 V ${bottom} H ${arm}`});
      set(edge.grip, {cy: (top + bottom) / 2});
    }
  }
  function drawOverlay() {
    staticLayer.replaceChildren();
    if (!ready) { drawPlayhead(); drawEdges(); return; }
    for (const svg of [overlay, handles]) { svg.setAttribute('width', root.offsetWidth); svg.setAttribute('height', root.offsetHeight); }
    const append = node => staticLayer.append(node);
    for (const [index, kind] of barMarks) {
      const g = geometry.get(index);
      if (g) append(el('rect', {class: `score-mark score-mark-${kind}`, x: g.bar.x, y: g.lineTop - 4, width: g.bar.w, height: g.lineHeight + 8, rx: 4}));
    }
    if (loop) {
      const [a, b] = loop;
      for (const g of geometry.values()) {
        if (g.end <= a + 1e-9 || g.start >= b - 1e-9) continue;
        const x0 = a > g.start ? xIn(g, a) : g.bar.x, x1 = b < g.end ? xIn(g, b) : g.bar.x + g.bar.w;
        append(el('rect', {class: 'score-loop', x: x0, y: g.lineTop - 6, width: Math.max(2, x1 - x0), height: g.lineHeight + 12, rx: 3}));
      }
    }
    if (focusBars) {
      for (let i = focusBars[0]; i <= focusBars[1]; i++) { const g = geometry.get(i); if (g) append(el('rect', {class: 'score-range', x: g.bar.x, y: g.lineTop - 6, width: g.bar.w, height: g.lineHeight + 12})); }
    }
    if (selection.size && built) {
      for (const [note, hit] of built.noteHits) {
        if (!selection.has(hit.id)) continue;
        const beatBounds = api.boundsLookup?.findBeat(note.beat);
        const nb = beatBounds?.notes?.find(n => n.note === note);
        if (nb) { const b = nb.noteHeadBounds; append(el('rect', {class: 'score-selected', x: b.x - 3, y: b.y - 3, width: b.w + 6, height: b.h + 6, rx: 4})); }
      }
    }
    if (caret) {
      const at = xAt(caret.q);
      if (at) {
        append(el('line', {class: 'score-caret', x1: at.x, x2: at.x, y1: at.g.lineTop - 14, y2: at.g.lineTop + at.g.lineHeight + 14}));
        if (caret.label) { const t = el('text', {class: 'score-caret-label', x: at.x + 4, y: at.g.lineTop - 16}); t.textContent = caret.label; append(t); }
      }
    }
    drawPlayhead();
    drawEdges();
  }

  api.renderFinished.on(() => {
    if (disposed) return;
    ready = true;
    measureGeometry();
    drawOverlay();
    onRender(view);
  });

  function engrave() {
    applyResources();
    starts = musicalStarts(score.timeline);
    // A range renders part of the whole model, so bar numbers, meters and
    // tempo marks stay those of the song.
    const {range = null, ...options} = renderOptions;
    settings.display.startBar = range ? range[0] + 1 : 1;
    settings.display.barCount = range ? range[1] - range[0] + 1 : -1;
    api.updateSettings();
    built = buildAlphaTabScore(alphaTab, score, options);
    ready = false;
    api.renderScore(built.score, [0]);
  }
  // The first engraving waits for the UI face, since alphaTab measures labels with it.
  function render() {
    if (!score || disposed) return;
    if (fontsLoaded) { engrave(); return; }
    const token = ++renderToken;
    waitForFonts().then(() => {
      fontsLoaded = true;
      if (!disposed && token === renderToken) engrave();
    });
  }
  /** Re-lays out the current model with the current settings (one alphaTab render). */
  function relayout() {
    if (disposed) return;
    if (!built) { render(); return; }
    applyResources();
    api.updateSettings();
    ready = false;
    api.render();
  }
  /** Scale, bars per row and label sizes without rendering; true when anything changed. */
  function configure({scale: nextScale, barsPerRow: nextBars, fonts: nextFonts} = {}) {
    let changed = false;
    if (nextScale != null && settings.display.scale !== nextScale) { settings.display.scale = nextScale; changed = true; }
    if (nextBars != null && settings.display.barsPerRow !== nextBars) { settings.display.barsPerRow = nextBars; changed = true; }
    if (nextFonts) {
      const next = {...labelSizes, ...pickFonts(nextFonts)};
      if (next.barNumber !== labelSizes.barNumber || next.marker !== labelSizes.marker) { labelSizes = next; changed = true; }
    }
    return changed;
  }

  // Only the score view follows app-theme and place changes, and only when its
  // own tokens changed (the always-dark Stage ignores a desk theme switch).
  const onTheme = () => {
    if (disposed) return;
    const previous = themeKey;
    applyResources();
    if (themeKey !== previous && built) relayout();
  };
  window.addEventListener('woodshed:theme', onTheme);
  window.addEventListener('woodshed:place', onTheme);

  /** Locate a pointer: bar, nearest written beat, note under it, and a snapped quarter. */
  function locate(event) {
    const rect = stage.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    let best = null;
    for (const g of geometry.values()) {
      const top = Math.min(g.system.y, g.lineTop - 24), bottom = Math.max(g.system.y + g.system.h, g.lineTop + g.lineHeight + 30);
      if (y < top || y > bottom || x < g.bar.x - 2 || x > g.bar.x + g.bar.w + 2) continue;
      best = g; break;
    }
    if (!best) return {x, y};
    const p = best.points;
    let q = p[0].q;
    for (let i = 0; i < p.length - 1; i++) if (x <= p[i + 1].x || i === p.length - 2) { const a = p[i], b = p[i + 1]; q = a.q + (b.q - a.q) * Math.max(0, Math.min(1, (x - a.x) / Math.max(1, b.x - a.x))); break; }
    // alphaTab's getBeatAtPos prefers the last beat left of x across voices,
    // so test noteheads directly.
    let hit = null, distance = 10;
    for (const knot of best.beats) for (const nb of knot.bounds.notes || []) {
      const b = nb.noteHeadBounds, dx = Math.max(b.x - x, 0, x - (b.x + b.w)), dy = Math.max(b.y - y, 0, y - (b.y + b.h)), d = Math.hypot(dx, dy);
      if (d < distance && built.noteHits.has(nb.note)) { distance = d; hit = built.noteHits.get(nb.note); }
    }
    const nearest = best.beats.reduce((a, b) => !a || Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a, null);
    return {x, y, index: best.index, q, hit, beat: nearest?.info ?? null, beatQ: nearest?.q ?? null, lineTop: best.lineTop, lineHeight: best.lineHeight};
  }
  if (onPointer) for (const kind of ['down', 'move', 'up', 'cancel']) stage.addEventListener(`pointer${kind}`, event => onPointer({kind, event, at: locate(event)}));
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (ready) requestAnimationFrame(() => { if (disposed) return; measureGeometry(); drawOverlay(); }); }) : null;
  resize?.observe(stage);

  const view = {
    api, host, stage, handles,
    get ready() { return ready; },
    get score() { return score; },
    get scale() { return settings.display.scale; },
    get barsPerRow() { return settings.display.barsPerRow; },
    get fonts() { return {...labelSizes}; },
    setScore(next, options = {}) { score = next; renderOptions = options; render(); },
    setOptions(options) { renderOptions = {...renderOptions, ...options}; render(); },
    setScale(value) { settings.display.scale = value; relayout(); },
    setBarsPerRow(value) { settings.display.barsPerRow = value; relayout(); },
    /** Label sizes in engraving px; relayouts when they change. */
    setFonts(next) { if (configure({fonts: next})) relayout(); },
    configure,
    relayout,
    setPlayhead(q) { if (playhead === q) return; playhead = q; drawPlayhead(); },
    /** [qa, qb] or null; {dragging} turns the edges' snap animation off while a pointer moves them. */
    setLoop(range, {dragging: moving = false} = {}) { loop = range; dragging = moving; drawOverlay(); },
    /** Shows the loop edges (brackets, grip dots and hit areas) whenever a loop is set. */
    setLoopHandles(on) { handlesOn = !!on; drawEdges(); },
    setSelection(ids) { selection = ids; drawOverlay(); },
    setCaret(value) { caret = value; drawOverlay(); },
    setRange(bars) { focusBars = bars; drawOverlay(); },
    setBarMarks(marks) { barMarks = marks; drawOverlay(); },
    locate,
    /** Notehead boxes in stage coordinates, for marquee selection. */
    noteBoxes() { const out = []; if (!built || !api.boundsLookup) return out; for (const [note, hit] of built.noteHits) { const nb = api.boundsLookup.findBeat(note.beat)?.notes?.find(n => n.note === note); if (nb) out.push({...nb.noteHeadBounds, x: nb.noteHeadBounds.x, y: nb.noteHeadBounds.y, w: nb.noteHeadBounds.w, h: nb.noteHeadBounds.h, hit}); } return out; },
    /** Bar bounds in stage coordinates, for scrolling. */
    barBounds(index) { const g = geometry.get(index); return g ? {x: g.bar.x, y: g.system.y, w: g.bar.w, h: g.system.h, lineTop: g.lineTop, lineHeight: g.lineHeight} : null; },
    positionX(q) { const at = xAt(q); return at ? {x: at.x, ...this.barBounds(at.g.index)} : null; },
    barAt: barIndexAt,
    rendered(index) { return geometry.has(index); },
    /** Number of bars with geometry in the current engraving. */
    renderedBars() { return geometry.size; },
    destroy() { disposed = true; clearTimeout(widthTimer); resize?.disconnect(); window.removeEventListener('woodshed:theme', onTheme); window.removeEventListener('woodshed:place', onTheme); api.destroy(); host.replaceChildren(); host.classList.remove('score-view'); },
  };
  return view;
}
