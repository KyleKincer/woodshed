// Engraved drum notation for reading and editing. alphaTab lays out and draws
// the score; this module owns an overlay for the playing bar, beat cursor,
// loop range, selection and edit caret, and maps pointer positions back to
// bars, beats and hits. All positions are absolute quarter notes.
import * as alphaTab from '@coderline/alphatab';
import bravuraWoff2 from '@coderline/alphatab/font/Bravura.woff2?url';
import bravuraWoff from '@coderline/alphatab/font/Bravura.woff?url';
import {number, musicalStarts} from '../../../shared/notation.ts';
import {buildAlphaTabScore} from './alphatab-score.js';
import './score-view.css';

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const SVG = 'http://www.w3.org/2000/svg';

function themeResources(print) {
  const ink = print ? '#111111' : css('--text') || '#17201f';
  const muted = print ? '#555555' : css('--muted') || '#68716d';
  const lines = print ? '#444444' : css('--notation-lines') || muted;
  // The second voice uses secondaryGlyphColor; drums need both voices at full ink.
  return {mainGlyphColor: ink, secondaryGlyphColor: ink, staffLineColor: lines, barSeparatorColor: lines, barNumberColor: muted, scoreInfoColor: ink};
}

/**
 * @param host element to render into (gets a scroll container)
 * @param options.scale engraving scale (1 = alphaTab default)
 * @param options.barsPerRow -1 for automatic by width
 * @param options.onPointer ({kind:'down'|'move'|'up', event, at}) pointer callback
 */
export function createScoreView(host, {scale = 1, barsPerRow = -1, print = false, onRender = () => {}, onPointer = null} = {}) {
  host.classList.add('score-view');
  const stage = document.createElement('div');
  stage.className = 'score-stage';
  const root = document.createElement('div');
  root.className = 'score-engraving';
  const overlay = document.createElementNS(SVG, 'svg');
  overlay.setAttribute('class', 'score-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  stage.append(overlay, root);
  host.replaceChildren(stage);

  function el(name, attrs) { const node = document.createElementNS(SVG, name); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node; }
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
  const applyTheme = () => { const r = themeResources(print); for (const [key, value] of Object.entries(r)) settings.display.resources[key] = alphaTab.model.Color.fromJson(value); };
  // Labels use the app's typeface; section marks read like rehearsal letters.
  const family = (css('--font') || 'Arial, Helvetica, sans-serif').replace(/"/g, "'");
  const fonts = settings.display.resources.elementFonts, font = spec => alphaTab.model.Font.fromJson(`${spec} ${family}`);
  fonts.set(alphaTab.NotationElement.EffectMarker, font('bold 15px'));
  fonts.set(alphaTab.NotationElement.EffectTempo, font('bold 12px'));
  fonts.set(alphaTab.NotationElement.BarNumber, font('11px'));
  fonts.set(alphaTab.NotationElement.EffectText, font('italic 12px'));
  fonts.set(alphaTab.NotationElement.EffectLyrics, font('bold 11px'));
  applyTheme();
  const api = new alphaTab.AlphaTabApi(root, settings);

  let built = null, score = null, renderOptions = {}, starts = [], ready = false, disposed = false;
  let playhead = null, loop = null, selection = new Set(), caret = null, focusBars = null, barMarks = new Map();
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
      geometry.set(index, {index, bar, system, points, beats: list, top: master.visualBounds.y, height: master.visualBounds.h, lineTop: master.lineAlignedBounds?.y ?? bar.y, lineHeight: master.lineAlignedBounds?.h ?? bar.h});
    });
  }

  function xAt(q) {
    const index = barIndexAt(q), g = geometry.get(index);
    if (!g) return null;
    const p = g.points;
    for (let i = 0; i < p.length - 1; i++) if (q <= p[i + 1].q + 1e-9) {
      const a = p[i], b = p[i + 1];
      return {g, x: a.x + (b.x - a.x) * Math.max(0, Math.min(1, (q - a.q) / Math.max(1e-9, b.q - a.q)))};
    }
    return {g, x: p.at(-1).x};
  }
  function barIndexAt(q) {
    let low = 0, high = starts.length - 1, index = 0;
    while (low <= high) { const mid = (low + high) >> 1; if (number(starts[mid]) <= q + 1e-9) { index = mid; low = mid + 1; } else high = mid - 1; }
    return index;
  }

  // Two layers: marks that change on edits, and the playhead that moves
  // every frame without rebuilding anything else.
  const staticLayer = el('g', {}), nowBar = el('rect', {class: 'score-now-bar', rx: 4}), nowLine = el('line', {class: 'score-playhead'});
  const nowLayer = el('g', {class: 'score-now'});
  nowLayer.append(nowBar, nowLine);
  overlay.append(staticLayer, nowLayer);
  function drawPlayhead() {
    const at = ready && playhead != null ? xAt(playhead) : null;
    nowLayer.style.display = at ? '' : 'none';
    if (!at) return;
    const set = (node, attrs) => { for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); };
    set(nowBar, {x: at.g.bar.x, y: at.g.lineTop - 8, width: at.g.bar.w, height: at.g.lineHeight + 16});
    set(nowLine, {x1: at.x, x2: at.x, y1: at.g.lineTop - 12, y2: at.g.lineTop + at.g.lineHeight + 12});
  }
  function drawOverlay() {
    staticLayer.replaceChildren();
    if (!ready) { drawPlayhead(); return; }
    overlay.setAttribute('width', root.offsetWidth);
    overlay.setAttribute('height', root.offsetHeight);
    const append = node => staticLayer.append(node);
    for (const [index, kind] of barMarks) {
      const g = geometry.get(index);
      if (g) append(el('rect', {class: `score-mark score-mark-${kind}`, x: g.bar.x, y: g.lineTop - 4, width: g.bar.w, height: g.lineHeight + 8, rx: 4}));
    }
    if (loop) {
      const [a, b] = loop;
      for (const g of geometry.values()) {
        const start = number(starts[g.index]), end = start + number(score.timeline.measures[g.index].length);
        if (end <= a + 1e-9 || start >= b - 1e-9) continue;
        const x0 = a > start ? xAt(a).x : g.bar.x, x1 = b < end ? xAt(b).x : g.bar.x + g.bar.w;
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
  }

  api.renderFinished.on(() => {
    if (disposed) return;
    ready = true;
    measureGeometry();
    drawOverlay();
    onRender(view);
  });

  function render() {
    if (!score) return;
    applyTheme();
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

  const onTheme = () => { api.updateSettings(); render(); };
  window.addEventListener('woodshed:theme', onTheme);

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
  const resize = new ResizeObserver(() => { if (ready) requestAnimationFrame(() => { measureGeometry(); drawOverlay(); }); });
  resize.observe(stage);

  const view = {
    api, host, stage,
    get ready() { return ready; },
    get score() { return score; },
    setScore(next, options = {}) { score = next; renderOptions = options; render(); },
    setOptions(options) { renderOptions = {...renderOptions, ...options}; render(); },
    setScale(value) { settings.display.scale = value; api.updateSettings(); api.render(); },
    setBarsPerRow(value) { settings.display.barsPerRow = value; api.updateSettings(); api.render(); },
    setPlayhead(q) { if (playhead === q) return; playhead = q; drawPlayhead(); },
    setLoop(range) { loop = range; drawOverlay(); },
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
    destroy() { disposed = true; resize.disconnect(); window.removeEventListener('woodshed:theme', onTheme); api.destroy(); host.replaceChildren(); host.classList.remove('score-view'); },
  };
  return view;
}
