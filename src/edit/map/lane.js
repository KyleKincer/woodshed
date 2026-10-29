// Edit · Map lanes: drawing and hit testing for the bar ruler and the tempo lane (architecture
// §2.15 "lane.js"; spec §5.1; maps/mapedit.md §5.6, §6, §11.4). The sections lane is
// src/edit/map/sections.js. Geometry comes from the pure helpers in src/js/map-lane.js; this
// module draws it and turns pointers into map edits.
//
//   LANE_PX                      the fixed lane heights: ruler 24, sections 32, tempo 96 (spec §5.1)
//   laneColors()                 the canvas colours, resolved from the tokens (cached per theme)
//   drawTempoLane(ctx, geo, o)   the tempo lane: selected bar, guides, amber-striped suspect spans,
//                                steps and ramps, span labels, 12 px pin diamonds, the selection
//   createRuler(host, opts)      the bar ruler (DOM): numbers thinned to 26 px, meter chips, labels;
//                                an unmapped song gets times (m:ss), never bars
//   createTempoLane(host, opts)  the tempo lane (canvas) with its pointer model:
//     pointerdown on a pin (24 px hit, 44 coarse)   select it; a drag past 2 px moves it in one map
//                                                   batch ('drag' edits, one undo step on release),
//                                                   2 ms inside its neighbours; a refusal keeps the
//                                                   last valid place and says why
//     pointerdown elsewhere                          select the nearest line (and cue there, stopped)
//     double-click                                   pin or unpin the nearest line at its time
//     hover                                          a tip: "Pinned bar 12 · 0:24.000" / "bar 12 · 120 BPM"
//   Lane edits are refused while Find a chart auditions (D20), while tapping and on read-only songs.
import {h} from '../../ui/h.js';
import {pin as pinAt} from '../../../shared/song-map.ts';
import {compare, number} from '../../../shared/notation.ts';
import {formatClock} from '../../../shared/practice.ts';
import {DIAMOND, HIT, diamond, dragTime, hitPin, rulerMarks, tempoGeometry, timeScale} from '../../js/map-lane.js';
import {hatch} from '../../stage/wave-render.js';
import {MAP_SESSION_COPY, bpmText, clockText} from './session.js';
import {COPY} from './map.copy.js';

/** Lane heights in CSS px (spec §5.1: sections 32, tempo 96; the ruler matches the Stems ruler). */
export const LANE_PX = Object.freeze({ruler: 24, sections: 32, tempo: 96});
/** A pointer must move this far before a pin drag starts (1.9: 2 px). */
export const DRAG_SLOP = 2;
/** Times on an unmapped ruler keep this much room. */
export const TIME_MARK_PX = 64;
const TIME_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

// ------------------------------------------------------------------ colours

const COLOR_VARS = Object.freeze({
  ink: '--ink', ink2: '--ink-2', ink3: '--ink-3', accent: '--accent', accentFill: '--accent-fill', accentSoft: '--accent-soft',
  onAccent: '--on-accent', now: '--now', warn: '--warn', line: '--line', lineStrong: '--line-strong', surface: '--surface',
  surface2: '--surface-2', bg: '--bg', edit: '--edit', fontMono: '--font-mono', fontUi: '--font-ui',
});
let colorCache = null;
let listening = false;

/** Forgets the cached colours (the view also calls it on theme changes). */
export function invalidateLaneColors() { colorCache = null; }

/**
 * The lane colours (and the two font stacks), resolved from the tokens on the root element through
 * a hidden probe, so var() values reach the canvas as plain colours. Cached until the theme or
 * place changes (window events 'woodshed:theme' and 'woodshed:place').
 */
export function laneColors() {
  if (!listening && typeof window !== 'undefined' && window.addEventListener) {
    listening = true;
    window.addEventListener('woodshed:theme', invalidateLaneColors, true);
    window.addEventListener('woodshed:place', invalidateLaneColors, true);
  }
  if (colorCache) return colorCache;
  const out = {};
  if (typeof document === 'undefined' || !document.documentElement) {
    for (const key of Object.keys(COLOR_VARS)) out[key] = '';
    return Object.freeze(out);
  }
  const root = document.documentElement, style = getComputedStyle(root);
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
  (document.body ?? root).append(probe);
  try {
    for (const [key, variable] of Object.entries(COLOR_VARS)) {
      const raw = style.getPropertyValue(variable).trim();
      if (key.startsWith('font')) { out[key] = raw || (key === 'fontMono' ? 'monospace' : 'sans-serif'); continue; }
      probe.style.color = '';
      probe.style.color = `var(${variable})`;
      const computed = getComputedStyle(probe).color?.trim() ?? '';
      out[key] = computed && !computed.includes('var(') && raw ? computed : raw;
    }
  } finally {
    probe.remove();
  }
  colorCache = Object.freeze(out);
  return colorCache;
}

// ------------------------------------------------------------------ the tempo lane drawing

const polygon = (ctx, points) => {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
};

/**
 * Draws a tempoGeometry() result.
 *   o: {width, height, dpr = 1, colors = laneColors(), selectedQ, band: [x0, x1]|null (the selected
 *      bar), cursorX: number|null (the selected line), cursorY, hoverQ}
 * Returns what it drew, for tests and probes: {suspect, pins, selected, labels}.
 */
export function drawTempoLane(ctx, geo, {width, height, dpr = 1, colors = laneColors(), selectedQ = null, band = null,
  cursorX = null, cursorY = null, hoverQ = null} = {}) {
  const drawn = {suspect: 0, pins: 0, selected: false, labels: []};
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (band) { ctx.fillStyle = colors.accentSoft; ctx.fillRect(band[0], 0, Math.max(1, band[1] - band[0]), height); }

  // Guides behind everything (dashed --line).
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  for (const g of geo.guides) {
    const gy = Math.round(g.y) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(width, gy); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Amber stripes behind suspect spans (a miscounted bar, usually).
  for (const path of geo.paths) {
    if (!path.suspect) continue;
    drawn.suspect++;
    const x0 = path.points[0][0], x1 = path.points.at(-1)[0];
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = hatch(ctx, colors.warn, {dpr});
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), height);
    ctx.restore();
  }

  // Connectors between spans (a jump in tempo at a pin), then the curve.
  ctx.strokeStyle = colors.lineStrong;
  ctx.lineWidth = 1;
  for (const [a, b] of geo.connectors) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const path of geo.paths) {
    ctx.strokeStyle = path.suspect ? colors.warn : path.open ? colors.ink3 : colors.accent;
    ctx.lineWidth = 2;
    ctx.setLineDash(path.open ? [5, 4] : []);
    ctx.beginPath();
    path.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // The selected line under the pins and labels.
  if (Number.isFinite(cursorX)) { ctx.fillStyle = colors.accent; ctx.fillRect(Math.round(cursorX) - 1, 0, 2, height); }

  // Span tempos (in the felt pulse), haloed so they read over the curve.
  ctx.font = `600 12px ${colors.fontMono}`;
  ctx.textAlign = 'center';
  for (const path of geo.paths) {
    if (!path.label) continue;
    ctx.lineWidth = 3;
    ctx.strokeStyle = colors.surface;
    ctx.strokeText(path.label, path.labelX, path.labelY);
    ctx.fillStyle = path.suspect ? colors.warn : path.open ? colors.ink3 : colors.ink;
    ctx.fillText(path.label, path.labelX, path.labelY);
    drawn.labels.push(path.label);
  }
  ctx.textAlign = 'left';

  // Pins: 12 px diamonds on the curve; the selected one in --accent-fill with a ring.
  for (const p of geo.pins) {
    const selected = selectedQ !== null && compare(p.pin.position, selectedQ) === 0;
    const hover = hoverQ !== null && compare(p.pin.position, hoverQ) === 0;
    polygon(ctx, diamond(p.x, p.y, DIAMOND + 4));
    ctx.fillStyle = colors.surface;
    ctx.fill();
    polygon(ctx, diamond(p.x, p.y, DIAMOND));
    ctx.fillStyle = selected ? colors.accentFill : colors.ink;
    ctx.fill();
    if (selected || hover) {
      polygon(ctx, diamond(p.x, p.y, DIAMOND + 7));
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (selected) drawn.selected = true;
    drawn.pins++;
  }
  // An unpinned selection shows where it sits on the curve (a hollow diamond).
  if (Number.isFinite(cursorX) && Number.isFinite(cursorY) && !drawn.selected) {
    polygon(ctx, diamond(cursorX, cursorY, DIAMOND));
    ctx.fillStyle = colors.surface;
    ctx.fill();
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
  return drawn;
}

// ------------------------------------------------------------------ the ruler

/** Times for an unmapped ruler: a round step that keeps TIME_MARK_PX between labels. */
export function timeMarks({t0 = 0, span = 0, width = 0, duration = Infinity} = {}) {
  if (!(span > 0) || !(width > 0)) return [];
  const step = TIME_STEPS.find((s) => (s / span) * width >= TIME_MARK_PX) ?? TIME_STEPS.at(-1);
  const scale = timeScale({t0, span, width}), out = [];
  for (let t = Math.ceil(t0 / step) * step; t <= Math.min(t0 + span, duration) + 1e-9; t += step) {
    out.push({t, x: scale.x(t), text: step < 1 ? `${formatClock(t)}.${Math.round((t % 1) * 10)}` : formatClock(t)});
  }
  return out;
}

/**
 * The bar ruler (DOM, aria-hidden: the inspector and the posture's position carry the bar). Marks
 * are `.map-mark` spans placed with `--x`; a meter change carries a `.map-meter` chip and a section
 * start its label. A click selects the bar line nearest the pointer (`onPick(t)`).
 *   createRuler(host, {map, onPick}) → {el, render(view, {mapped, selected}), destroy()}
 */
export function createRuler(host, {map, onPick} = {}) {
  const marks = h('div', {class: 'map-ruler-marks'});
  const el = h('div', {class: 'map-ruler', 'aria-hidden': 'true', dataset: {testid: 'map-ruler'}}, marks);
  host.append(el);
  let last = {t0: 0, span: 0, width: 0};
  const onDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const rect = el.getBoundingClientRect();
    onPick?.(timeScale(last).t(e.clientX - rect.left));
  };
  el.addEventListener('pointerdown', onDown);

  function render(view, {mapped = !!map.isReal, selected = null} = {}) {
    last = view;
    el.dataset.ruler = mapped ? 'bars' : 'time';
    const nodes = [];
    if (mapped) {
      for (const m of rulerMarks(map, {...view, selected})) {
        const mark = h('span', {class: 'map-mark', dataset: {bar: String(m.index)}},
          h('span', {class: 'map-mark-number'}, m.display === null ? 'P' : String(m.display)));
        if (m.meter) mark.append(h('span', {class: 'map-meter'}, m.meter));
        if (m.label) mark.append(h('span', {class: 'map-mark-label'}, m.label));
        if (m.selected) mark.dataset.selected = '';
        mark.style.setProperty('--x', `${m.x}px`);
        nodes.push(mark);
      }
    } else {
      for (const m of timeMarks({...view, duration: map.duration})) {
        const mark = h('span', {class: 'map-mark', dataset: {time: String(m.t)}}, h('span', {class: 'map-mark-number'}, m.text));
        mark.style.setProperty('--x', `${m.x}px`);
        nodes.push(mark);
      }
    }
    marks.replaceChildren(...nodes);
    return nodes.length;
  }

  return {
    el, render,
    destroy() { el.removeEventListener('pointerdown', onDown); el.remove(); },
  };
}

// ------------------------------------------------------------------ the tempo lane

/**
 * Selects a line (a Fraction) the way a click on the lanes does: the map session selects it (and
 * seeks), and while the transport is stopped the line also becomes the cue, so Play starts there.
 */
export function selectLine(session, mapSession, q) {
  if (!mapSession.select(q)) return false;
  const transport = session?.transport;
  const snap = transport?.snapshot?.peek?.();
  if (snap?.phase === 'stopped' && typeof transport.cue === 'function' && !mapSession.previewing?.peek?.() && !mapSession.tapping?.peek?.()) {
    const t = session.map.timeAt(mapSession.cursorQ.peek());
    if (Number.isFinite(t) && Math.abs((snap.cue ?? NaN) - t) > 1e-6) transport.cue(t);
  }
  return true;
}

/** "bar 12" / "bar 12 beat 3" / "the pickup" for a line (display numbers, §4.3). */
export function lineName(map, q) {
  const index = map.barIndexAtQ(number(q)), bar = map.bars[index];
  const name = !bar || bar.display === null ? 'the pickup' : `bar ${bar.display}`;
  const line = map.lines.find((l) => compare(l.q, q) === 0);
  if (!line || line.downbeat) return name;
  return `${name} beat ${line.beat}`;
}

/**
 * The tempo lane. `opts`:
 *   session      the song session (map, transport, readOnly)
 *   mapSession   the map session (select, selectNear, cursorQ, tapping, auditioning, message)
 *   coarse()     true on coarse pointers (44 px pin hits)
 *   requestDraw  ask the view to redraw (after a drag step)
 * Returns {el, canvas, render(view, {mapped}), hits(), dragging, destroy()}.
 */
export function createTempoLane(host, {session, mapSession, coarse = () => false, requestDraw = () => {}} = {}) {
  const {map} = session;
  const canvas = h('canvas', {class: 'map-tempo-canvas', 'aria-hidden': 'true', dataset: {testid: 'map-tempo-canvas'}});
  const guidesEl = h('div', {class: 'map-tempo-guides', 'aria-hidden': 'true'});
  const tip = h('div', {class: 'map-tip', role: 'tooltip', hidden: true});
  const el = h('div', {class: 'map-tempo', dataset: {testid: 'map-tempo'}}, canvas, tip);
  host.append(el);
  let geo = null, view = {t0: 0, span: 0, width: 0}, drawnInfo = null;
  let drag = null;       // {q, startX, moved, time, pointerId}
  let hoverQ = null;

  const say = (text, tone = 'info') => { mapSession.message.value = {text, tone}; };
  const scale = () => timeScale(view);
  const localX = (e) => e.clientX - canvas.getBoundingClientRect().left;
  const localY = (e) => e.clientY - canvas.getBoundingClientRect().top;
  const locked = () => session.readOnly || !!mapSession.auditioning.peek() || !!mapSession.tapping.peek();

  function render(next, {mapped = !!map.isReal} = {}) {
    view = next;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const width = Math.max(0, Math.round(view.width)), height = LANE_PX.tempo;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    el.dataset.mapped = mapped ? 'true' : 'false';
    const ctx = canvas.getContext?.('2d');
    if (!mapped) {
      geo = null;
      ctx?.clearRect?.(0, 0, canvas.width, canvas.height);
      guidesEl.replaceChildren();
      canvas.dataset.pins = '0';
      return null;
    }
    geo = tempoGeometry(map, {...view, height});
    const q = mapSession.cursorQ.peek(), t = map.timeAt(q), x = scale().x(t);
    const index = map.barIndexAtQ(number(q)), bar = map.bars[index];
    const band = bar ? [scale().x(bar.t0), scale().x(bar.t1)] : null;
    if (ctx) {
      drawnInfo = drawTempoLane(ctx, geo, {width, height, dpr, selectedQ: q, band, cursorX: t >= view.t0 && t <= view.t0 + view.span ? x : null,
        cursorY: geo.y(map.qpmAt(t)), hoverQ});
    }
    canvas.dataset.pins = String(geo.pins.length);
    canvas.dataset.suspect = String(geo.paths.filter((p) => p.suspect).length);
    guidesEl.replaceChildren(...geo.guides.map((g) => {
      const label = h('span', {class: 'map-guide'}, String(g.value));
      label.style.setProperty('--y', `${g.y}px`);
      return label;
    }));
    return drawnInfo;
  }

  function showTip(text, x) {
    if (!text) { tip.hidden = true; return; }
    tip.textContent = text;
    tip.style.setProperty('--x', `${x}px`);
    tip.hidden = false;
  }

  function pinUnder(e) {
    if (!geo) return null;
    return hitPin(geo.pins, localX(e), localY(e), {hit: coarse() || e.pointerType === 'touch' ? HIT.coarse : HIT.fine});
  }

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (!map.isReal) { mapSession.selectNear(scale().t(localX(e))); return; }
    const hit = pinUnder(e);
    if (hit) {
      mapSession.select(hit.pin.position, {seek: false});
      if (locked()) { if (mapSession.auditioning.peek()) say(COPY.auditioning, 'error'); return; }
      drag = {q: hit.pin.position, startX: localX(e), moved: false, time: hit.pin.time, pointerId: e.pointerId};
      try { canvas.setPointerCapture?.(e.pointerId); } catch { /* the pointer is gone */ }
      map.beginBatch();
      e.preventDefault();
      return;
    }
    const t = scale().t(localX(e));
    const line = map.nearestLine(Math.max(0, Math.min(map.duration, t)));
    if (line) selectLine(session, mapSession, line.q);
  }

  function onMove(e) {
    if (drag && e.pointerId === drag.pointerId) {
      const x = localX(e);
      if (!drag.moved && Math.abs(x - drag.startX) <= DRAG_SLOP) return;
      drag.moved = true;
      const target = dragTime(map, drag.q, scale().t(x));
      try {
        map.edit((d) => { pinAt(d, drag.q, target); }, 'drag');
        drag.time = target;
      } catch (err) {
        say(err?.message || String(err), 'error');
      }
      showTip(COPY.dragTip(lineName(map, drag.q), clockText(drag.time)), scale().x(drag.time));
      requestDraw();
      return;
    }
    if (!geo) return;
    const hit = pinUnder(e);
    const nextHover = hit ? hit.pin.position : null;
    canvas.dataset.hover = hit ? 'pin' : '';
    if ((nextHover === null) !== (hoverQ === null) || (nextHover && hoverQ && compare(nextHover, hoverQ) !== 0)) {
      hoverQ = nextHover;
      requestDraw();
    }
    if (hit) showTip(COPY.pinTip(lineName(map, hit.pin.position), clockText(hit.pin.time)), hit.x);
    else {
      const t = scale().t(localX(e));
      const line = map.nearestLine(Math.max(0, Math.min(map.duration, t)));
      showTip(line ? COPY.lineTip(lineName(map, line.q), bpmText(map.bpmAt(number(line.q)))) : '', localX(e));
    }
  }

  function endDrag(e, {cancel = false} = {}) {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    const done = drag;
    drag = null;
    try { canvas.releasePointerCapture?.(done.pointerId); } catch { /* released already */ }
    if (cancel) {
      map.abortBatch();
    } else {
      const changed = map.endBatch();
      if (changed) say(MAP_SESSION_COPY.moved(true, lineName(map, done.q), done.time), 'ok');
      else if (!done.moved) selectLine(session, mapSession, done.q);
    }
    showTip('');
    requestDraw();
  }

  function onDouble(e) {
    if (!map.isReal || locked()) return;
    const t = scale().t(localX(e));
    const line = map.nearestLine(Math.max(0, Math.min(map.duration, t)));
    if (!line) return;
    mapSession.select(line.q, {seek: false});
    const pinned = map.data.pins.some((p) => compare(p.position, line.q) === 0);
    if (pinned) mapSession.unpin();
    else mapSession.pinLine(line.q, map.timeAt(line.q));
  }

  const onUp = (e) => endDrag(e);
  const onCancel = (e) => endDrag(e, {cancel: true});
  const onLeave = () => { if (!drag) { showTip(''); if (hoverQ) { hoverQ = null; requestDraw(); } } };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('dblclick', onDouble);

  return {
    el, canvas, guides: guidesEl, render,
    get dragging() { return !!drag; },
    hits: () => geo?.pins ?? [],
    destroy() {
      if (drag) endDrag(null, {cancel: true});
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('dblclick', onDouble);
      el.remove();
      guidesEl.remove();
    },
  };
}
