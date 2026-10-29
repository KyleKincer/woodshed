// The song strip (architecture §2.14.10, spec §4.5): sections, overview and progress in one
// 56 px band under the music (rail) or above the dock (band).
//
//   mountStrip(el, {session, onScrub, viewport, onViewport, registry}) → {el, rename(region), destroy()}
//     session      the song session (transport, position, practice, map, detect, frame, peaks, load)
//     onScrub(t)   a stopped touch scrub is at t (the Stage reveals it on the music)
//     viewport     Signal<{t0, t1}|null>: the Stems surface's visible window (the viewport bracket)
//     onViewport({t0, t1})   the bracket was dragged to a new window
//     registry     the command registry (default: the app's); chips, menus and the focus provider use it
//
// Modes (nav[data-mode]):
//   'sections'  mapped with sections: one segment per section, widths proportional to duration with a
//               56 px minimum (stripLayout). When they overflow, the track scrolls horizontally and
//               keeps the current segment in view. Segments alternate --surface / --surface-2; the
//               current one gets --now-soft and a 2 px --now progress fill.
//   'wave'      unmapped, or mapped without sections: the full-song mini waveform (drawStripWave).
//               Unmapped: the "No bar grid · Get bars →" chip (stage.getBars). Mapped without
//               sections: suggested sections (detect.suggestion, D47) as dashed blocks with an inline
//               [Keep all] [Review] chip (sections.keepAll, sections.review).
// Overlays in both modes: marker ticks (live markers; on mapped songs until they are turned into
// sections), spot diamonds, the loop bracket (--loop; it springs to the snapped edges over
// --motion-fast after a strip drag), the viewport bracket (Stems), the cue flag (▼ --accent) and
// the playhead (2 px --now). A pending quantized jump labels its target `→ Verse 2`.
//
// Gestures (src/stage/press.js, D50):
//   stopped        tap → cue at the segment start (wave mode: the tapped bar's start, unmapped the
//                  tapped time); double-tap → loop the section (wave mode: position.loopDefault)
//   playing        tap → transport.jump (quantized at the next downbeat; unmapped: at once); a tap
//                  on the pending target (or a double-tap) cancels it. Mouse clicks are the same.
//   long-press (350 ms) / right-click / Shift+F10 / ContextMenu → the section menu
//                  (menus.sectionMenu, ST8a; the strip passes `rename` for its inline Rename… field).
//                  A pointer press on an overlay opens that overlay's menu instead (spec §8 "Defined
//                  menus"), first match wins: a spot diamond → 'spot', a marker tick → 'marker', the
//                  loop bracket → 'loopBand'. Their hit areas are MENU_HIT_PX either side (fine/coarse;
//                  a narrow bracket is widened to the same). They open through the Stage's
//                  `stage.openMenu(kind, {spot|marker, rename, anchor})` (registry context 'stage'),
//                  else (no Stage: the harness) straight from menus.js. The keyboard (Shift+F10,
//                  ContextMenu) keeps the section menu of the roving item.
//   touch drag while stopped → scrub with a `Bar 41 · Bridge` label (cue on release); touch drag
//                  while playing scrolls the strip
//   mouse drag (any time), touch long-press then drag → a loop across segments (bars in wave mode,
//                  0.1 s unmapped; Alt snaps a mapped wave-mode loop to beats)
// Keyboard: the strip is one role=slider (aria-valuetext 'Bar 12, beat 3, Chorus' | '1:12') inside
// nav[aria-label=Sections][data-scope=stage.strip]. ←/→ (Home/End) rove over the segments (wave mode:
// markers, else bars, else 5 s steps); while it has focus the strip provides ctx.focused, so Enter
// plays (focus.play) and L loops (focus.loop) the focused segment (D45).
//
// No string this module produces for an unmapped song says "Bar" (§2.14.4), apart from the spec's
// "No bar grid" chip copy, which states exactly that.
import '../styles/views/stage/strip.css';
import {registry as appRegistry} from '../app/commands.js';
import {effect} from '../app/store.js';
import {h} from '../ui/h.js';
import {Button} from '../ui/button.js';
import {Menu} from '../ui/menu.js';
import {createPressRecognizer} from './press.js';
import {drawStripWave} from './wave-render.js';
import {formatClock} from '../../shared/practice.ts';
import {sectionLabelOf} from '../../shared/song-map.ts';

// Later-wave module, resolved by contract path (D2; Appendix C item 58): ST8a's menu builders.
const LATER = import.meta.glob('./menus.js');
const MENUS_PATH = './menus.js';

/** The minimum segment width (spec §4.5). */
export const MIN_SEGMENT_PX = 56;
/** Unmapped songs without markers move the keyboard focus in steps of this many seconds. */
export const STEP_SEC = 5;
/** How long the loop bracket springs after a drag (--motion-fast is 120 ms; a little slack). */
export const SPRING_MS = 180;
/** A touch or mouse press moves this far before it is a drag or scrub (press.js's moveTol). */
export const MOVE_TOL = 8;
const EPS = 1e-6;
/** Half-widths (px) of the spot, marker and loop-bracket menu hit areas: 24 px fine, 44 px coarse (spec §5.1's pins). */
export const MENU_HIT_PX = Object.freeze({fine: 12, coarse: 22});
/** How long after a press on the strip a focus-in still counts as the press's (no click came). */
const PRESS_FOCUS_MS = 1000;
const MAX_LABEL = 60;
const KEYS = 'ArrowLeft ArrowRight Home End';

/** Every string the strip shows or announces (spec §4.5). */
export const COPY = Object.freeze({
  nav: 'Sections',
  slider: 'Song position',
  noGrid: 'No bar grid',
  getBars: 'Get bars',
  suggested: 'Suggested',
  suggestedGroup: 'Suggested sections',
  keepAll: 'Keep all',
  review: 'Review',
  start: 'Start',
  pickup: 'Pickup',
  bar: (n) => `Bar ${n}`,
  pending: (label) => `→ ${label}`,
  /** aria-valuetext, mapped: 'Bar 12, beat 3, Chorus' (before bar 1: 'Pickup, beat 3, Start'). */
  valueMapped: ({bar, beat, section}) => [`${bar}, beat ${beat}`, section].filter(Boolean).join(', '),
  /** aria-valuetext, unmapped: '1:12' (inside a marker region: '1:12, Marker 2'). */
  valueUnmapped: ({time, region}) => [time, region].filter(Boolean).join(', '),
  /** The scrub label: 'Bar 41 · Bridge' | '1:12 · Marker 2'. */
  scrub: (parts) => parts.filter(Boolean).join(' · '),
  rename: (name) => `Rename ${name}`,
  renameUndo: 'Rename section',
  renameMarkerUndo: 'Rename marker',
  /** The overlay menus' accessible names (without a Stage; the Stage names its own). */
  menuLabel: Object.freeze({spot: (spot) => spot?.name || 'Spot', marker: (marker) => marker?.label || 'Marker', loopBand: () => 'Loop'}),
});

/** The strip's controls, for the table-driven test: role, accessible name, command and when it shows. */
export const CONTROLS = Object.freeze([
  Object.freeze({role: 'navigation', name: COPY.nav, context: 'always'}),
  Object.freeze({role: 'slider', name: COPY.slider, context: 'always'}),
  Object.freeze({role: 'button', name: COPY.getBars, command: 'stage.getBars', context: 'unmapped'}),
  Object.freeze({role: 'group', name: COPY.suggestedGroup, context: 'suggestion'}),
  Object.freeze({role: 'button', name: COPY.keepAll, command: 'sections.keepAll', context: 'suggestion'}),
  Object.freeze({role: 'button', name: COPY.review, command: 'sections.review', context: 'suggestion'}),
  Object.freeze({role: 'textbox', name: COPY.rename('Chorus'), context: 'rename'}),
]);

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const peek = (s) => (s && typeof s.peek === 'function' ? s.peek() : s);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const keyOf = (list, fields) => JSON.stringify((Array.isArray(list) ? list : []).map((item) => (item ? fields(item) : null)));

/**
 * Pure layout (dimensions as inputs, §0.1): segment boxes for spans [{t0, t1}] across `width`
 * px, proportional to duration with a `minPx` floor. Returns {width, boxes: [{x, w}]}; `width`
 * exceeds the input width when the floors do not fit (the strip then scrolls).
 */
export function stripLayout({spans = [], width = 0, minPx = MIN_SEGMENT_PX} = {}) {
  const n = spans.length;
  if (!n) return {width: Math.max(0, width), boxes: []};
  const durations = spans.map((s) => Math.max(0, s.t1 - s.t0));
  const avail = Math.max(0, width);
  const widths = new Array(n).fill(0);
  const fixed = new Array(n).fill(false);
  // Water-filling: every span below the floor is pinned to it; the rest share what is left.
  for (let round = 0; round <= n; round++) {
    let room = avail, total = 0;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) room -= minPx;
      else total += durations[i];
    }
    const count = fixed.filter((f) => !f).length;
    if (!count) break;
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) { widths[i] = minPx; continue; }
      const w = room > 0 ? (total > 0 ? room * durations[i] / total : room / count) : 0;
      widths[i] = w;
      if (w < minPx - 1e-9) { fixed[i] = true; changed = true; }
    }
    if (!changed) break;
  }
  for (let i = 0; i < n; i++) if (fixed[i]) widths[i] = minPx;
  const boxes = [];
  let x = 0;
  for (const w of widths) { boxes.push({x, w}); x += w; }
  return {width: Math.max(avail, x), boxes};
}

/** Time ↔ x over contiguous spans laid out by stripLayout (piecewise linear). */
export function spanMapper(spans, boxes) {
  const toX = (t) => {
    if (!spans.length) return 0;
    if (t <= spans[0].t0) return boxes[0].x;
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i], b = boxes[i];
      if (t < s.t1 || i === spans.length - 1) {
        const d = s.t1 - s.t0;
        return b.x + (d > 0 ? clamp((t - s.t0) / d, 0, 1) : 0) * b.w;
      }
    }
    return boxes[boxes.length - 1].x + boxes[boxes.length - 1].w;
  };
  const toT = (x) => {
    if (!spans.length) return 0;
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i], b = boxes[i];
      if (x < b.x + b.w || i === spans.length - 1) {
        return s.t0 + (b.w > 0 ? clamp((x - b.x) / b.w, 0, 1) : 0) * (s.t1 - s.t0);
      }
    }
    return spans[spans.length - 1].t1;
  };
  const indexAt = (t) => {
    for (let i = 0; i < spans.length; i++) if (t < spans[i].t1 - EPS) return i;
    return spans.length - 1;
  };
  return {toX, toT, indexAt};
}

export function mountStrip(el, {session, onScrub, viewport = null, onViewport, registry = appRegistry} = {}) {
  if (!el) throw new TypeError('mountStrip: a host element is required');
  if (!session) throw new TypeError('mountStrip: a session is required');
  const {transport, position, practice, map} = session;
  const doc = el.ownerDocument ?? document;
  const win = doc.defaultView ?? globalThis.window;
  const offs = [];
  let destroyed = false;

  // ------------------------------------------------------------------ DOM
  const slider = h('div', {
    class: 'strip-slider', tabindex: '0', role: 'slider',
    attrs: {'aria-label': COPY.slider, 'aria-orientation': 'horizontal', 'aria-valuemin': '0'},
  });
  const segs = h('div', {class: 'strip-segs', 'aria-hidden': 'true'});
  const canvas = h('canvas', {class: 'strip-wave', 'aria-hidden': 'true', dataset: {testid: 'strip-wave'}});
  const suggest = h('div', {class: 'strip-suggest', 'aria-hidden': 'true'});
  const ticks = h('div', {class: 'strip-ticks', 'aria-hidden': 'true'});
  const spots = h('div', {class: 'strip-spots', 'aria-hidden': 'true'});
  const loopEl = h('div', {class: 'strip-loop', 'aria-hidden': 'true', hidden: true});
  const viewEl = h('div', {class: 'strip-viewport', 'aria-hidden': 'true', hidden: true, dataset: {pressIgnore: ''}});
  const focusEl = h('div', {class: 'strip-focus', 'aria-hidden': 'true', hidden: true});
  const pendingEl = h('div', {class: 'strip-pending', 'aria-hidden': 'true', hidden: true});
  const cueEl = h('div', {class: 'strip-cue', 'aria-hidden': 'true'});
  const playhead = h('div', {class: 'strip-playhead', 'aria-hidden': 'true', dataset: {volatile: ''}});
  const scrubEl = h('div', {class: 'strip-scrub', 'aria-hidden': 'true', hidden: true});
  slider.append(canvas, segs, suggest, ticks, spots, loopEl, focusEl, pendingEl, cueEl, playhead, viewEl, scrubEl);
  const content = h('div', {class: 'strip-content'}, slider);
  const track = h('div', {class: 'strip-track'}, content);
  const tray = h('div', {class: 'strip-tray', hidden: true});
  const nav = h('nav', {
    class: 'strip', attrs: {'aria-label': COPY.nav, 'data-scope': 'stage.strip', 'data-consume-keys': KEYS},
  }, track, tray);
  el.append(nav);

  // ------------------------------------------------------------------ model
  const snap = () => peek(transport.snapshot) ?? {};
  const duration = () => Math.max(0, map.duration || 0);
  const mapped = () => !!map.isReal;
  const pos = () => (typeof transport.position === 'function' ? transport.position() : snap().cue ?? 0);
  const playingPhase = (s = snap()) => s.phase === 'playing' || s.phase === 'counting';

  let width = 0;          // the track's width (px)
  let model = {mode: 'wave', spans: [{t0: 0, t1: 0}], regions: [], layout: {width: 0, boxes: [{x: 0, w: 0}]}, mapper: spanMapper([], [])};
  let segEls = [];

  function measure() {
    const w = track.clientWidth || track.getBoundingClientRect?.().width || 0;
    return Math.max(0, Math.round(w));
  }

  /** Builds the mode, spans and layout from the map, the markers and the width. */
  function buildModel() {
    const end = duration();
    const regions = position.regions();
    const sections = mapped() && regions.length > 0 && regions[0].kind === 'section';
    let spans;
    if (sections) {
      // The lead-in before the first bar and the tail after the last are drawn inside the first and
      // last segments; the segment's own start is still the section's (taps cue there).
      spans = regions.map((r, i) => ({t0: i === 0 ? 0 : r.t0, t1: i === regions.length - 1 ? Math.max(end, r.t1) : regions[i + 1].t0}));
    } else {
      spans = [{t0: 0, t1: end}];
    }
    const layout = stripLayout({spans, width, minPx: sections ? MIN_SEGMENT_PX : 0});
    return {mode: sections ? 'sections' : 'wave', spans, regions: sections ? regions : [], layout, mapper: spanMapper(spans, layout.boxes), duration: end};
  }

  const toX = (t) => model.mapper.toX(t);
  const toT = (x) => model.mapper.toT(x);

  /** The section, marker region or null at t. */
  const regionAt = (t) => position.regionAt(t);

  function barStart(t) {
    const bars = map.bars;
    if (!bars?.length || t < bars[0].t0 - EPS) return {t: 0, label: COPY.pickup, display: null};
    const i = map.barIndexAt(t), bar = bars[i];
    const display = bar.display;
    return {t: bar.t0, t1: bar.t1, label: display == null ? COPY.pickup : COPY.bar(display), display, index: i};
  }

  // ------------------------------------------------------------------ rendering: structure
  function renderSegments() {
    segs.replaceChildren();
    segEls = [];
    if (model.mode !== 'sections') return;
    model.regions.forEach((r, i) => {
      const box = model.layout.boxes[i];
      const label = h('span', {class: 'strip-seg-label'}, r.label);
      const progress = h('span', {class: 'strip-seg-progress'});
      const seg = h('div', {class: 'strip-seg', dataset: {index: i, alt: i % 2}}, label, progress);
      seg.style.left = `${box.x}px`;
      seg.style.width = `${box.w}px`;
      segs.append(seg);
      segEls.push({el: seg, label, progress, region: r});
    });
  }

  function renderSuggestion() {
    suggest.replaceChildren();
    const s = model.mode === 'wave' && mapped() ? peek(session.detect?.suggestion) : null;
    const list = Array.isArray(s?.sections) ? s.sections.filter((b) => finite(b.t0)).slice().sort((a, b) => a.t0 - b.t0) : [];
    const end = duration();
    list.forEach((b, i) => {
      const t0 = clamp(b.t0, 0, end), t1 = i + 1 < list.length ? clamp(list[i + 1].t0, 0, end) : end;
      if (t1 - t0 <= EPS) return;
      const block = h('div', {class: 'strip-suggest-block', dataset: {index: i}}, h('span', {class: 'strip-suggest-label'}, String(b.label ?? '')));
      block.style.left = `${toX(t0)}px`;
      block.style.width = `${Math.max(0, toX(t1) - toX(t0))}px`;
      suggest.append(block);
    });
    return list.length > 0;
  }

  function renderTicks() {
    ticks.replaceChildren();
    for (const m of position.markerTicks()) {
      const tick = h('div', {class: 'strip-tick', dataset: {id: m.id}});
      tick.style.left = `${toX(m.t)}px`;
      ticks.append(tick);
    }
  }

  function renderSpots() {
    spots.replaceChildren();
    const list = (peek(practice.value)?.spots ?? []).filter((s) => s && !s.deleted && finite(s.a));
    for (const s of list) {
      const diamond = h('div', {class: 'strip-spot', dataset: {id: s.id}});
      diamond.style.left = `${toX(s.a)}px`;
      spots.append(diamond);
    }
  }

  // The tray: the unmapped chip, or the suggestion chip.
  let trayKind = null;
  let trayButtons = [];
  function renderTray(hasSuggestion) {
    const kind = !mapped() ? (session.readOnly ? 'noGridReadOnly' : 'noGrid') : hasSuggestion && !session.readOnly ? 'suggestion' : null;
    if (kind === trayKind) return;
    trayKind = kind;
    for (const b of trayButtons) b.destroy();
    trayButtons = [];
    tray.replaceChildren();
    tray.removeAttribute('role');
    tray.removeAttribute('aria-label');
    tray.hidden = !kind;
    if (!kind) { delete nav.dataset.tray; return; }
    nav.dataset.tray = kind;
    if (kind === 'noGrid' || kind === 'noGridReadOnly') {
      tray.append(h('span', {class: 'strip-tray-text'}, COPY.noGrid));
      if (kind === 'noGrid') {
        const b = Button({label: COPY.getBars, iconEnd: 'arrow-right', variant: 'quiet', size: 'sm', command: 'stage.getBars', registry});
        trayButtons.push(b);
        tray.append(h('span', {class: 'strip-tray-sep', 'aria-hidden': 'true'}, '·'), b.el);
      }
      return;
    }
    const keep = Button({label: COPY.keepAll, icon: 'check', variant: 'secondary', size: 'sm', command: 'sections.keepAll', registry});
    const review = Button({label: COPY.review, variant: 'quiet', size: 'sm', command: 'sections.review', registry});
    trayButtons.push(keep, review);
    tray.setAttribute('role', 'group');
    tray.setAttribute('aria-label', COPY.suggestedGroup);
    tray.append(h('span', {class: 'strip-tray-text', 'aria-hidden': 'true'}, COPY.suggested), keep.el, review.el);
  }

  function drawWave() {
    if (model.mode !== 'wave') { canvas.hidden = true; delete canvas.dataset.peaksReady; return; }
    canvas.hidden = false;
    const w = Math.max(0, Math.round(model.layout.width));
    const hgt = Math.max(0, Math.round(slider.clientHeight || 0));
    const dpr = win?.devicePixelRatio || 1;
    canvas.style.width = `${w}px`;
    if (!w || !hgt) { delete canvas.dataset.peaksReady; return; }
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    canvas.style.height = `${hgt}px`;
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const peaks = session.peaks;
    if (peaks?.ready && duration() > 0) {
      drawStripWave(ctx, {w, h: hgt, peaks, duration: duration(), dpr});
      canvas.dataset.peaksReady = 'true';
    } else {
      delete canvas.dataset.peaksReady;
    }
  }

  let structureKey = null;
  function renderStructure({force = false} = {}) {
    const next = buildModel();
    const s = next.mode === 'wave' && mapped() ? peek(session.detect?.suggestion) : null;
    const key = JSON.stringify([next.mode, next.duration, next.layout.width, next.layout.boxes, next.regions.map((r) => [r.label, r.t0, r.t1]),
      s?.sections ?? null, mapped(), !!session.readOnly, !!session.peaks?.ready, width]);
    if (!force && key === structureKey) return;
    structureKey = key;
    model = next;
    nav.dataset.mode = model.mode;
    nav.toggleAttribute('data-mapped', mapped());
    content.style.width = `${model.layout.width}px`;
    nav.toggleAttribute('data-overflow', model.layout.width > width + 0.5);
    slider.setAttribute('aria-valuemax', String(Math.round(model.duration * 10) / 10));
    renderSegments();
    const hasSuggestion = renderSuggestion();
    renderTicks();
    renderSpots();
    renderTray(hasSuggestion);
    drawWave();
    lastCurrent = -2;
    renderTransport();
    renderFrame(pos(), {force: true});
    renderFocus();
    renderViewport();
  }

  // ------------------------------------------------------------------ rendering: transport state
  let springTimer = null;
  let preview = null;     // {a, b} while a strip loop drag runs
  function placeLoop(a, b) {
    const x0 = toX(Math.min(a, b)), x1 = toX(Math.max(a, b));
    loopEl.hidden = false;
    loopEl.style.left = `${x0}px`;
    loopEl.style.width = `${Math.max(2, x1 - x0)}px`;
  }

  function spring() {
    clearTimeout(springTimer);
    loopEl.setAttribute('data-spring', '');
    springTimer = setTimeout(() => { springTimer = null; loopEl.removeAttribute('data-spring'); }, SPRING_MS);
  }

  let pendingSeg = -1;
  function renderTransport() {
    const s = snap();
    nav.toggleAttribute('data-playing', playingPhase(s));
    if (preview) placeLoop(preview.a, preview.b);
    else if (s.loop?.on && s.loop.b > s.loop.a) placeLoop(s.loop.a, s.loop.b);
    else loopEl.hidden = true;
    const cue = finite(s.cue) ? s.cue : 0;
    cueEl.style.transform = `translateX(${toX(cue)}px)`;
    // A pending quantized jump: the target segment reads `→ Verse 2`; in wave mode a pill at the target.
    const pj = s.pendingJump && finite(s.pendingJump.t) ? s.pendingJump : null;
    for (const seg of segEls) {
      seg.el.removeAttribute('data-pending');
      seg.label.textContent = seg.region.label;
    }
    pendingSeg = -1;
    pendingEl.hidden = true;
    if (pj) {
      if (model.mode === 'sections') {
        const i = segmentAt(pj.t);
        const seg = segEls[i];
        if (seg) {
          pendingSeg = i;
          seg.el.setAttribute('data-pending', '');
          seg.label.textContent = COPY.pending(pj.label || seg.region.label);
        }
      } else {
        pendingEl.hidden = false;
        pendingEl.textContent = COPY.pending(pj.label || (mapped() ? barStart(pj.t).label : formatClock(pj.t)));
        pendingEl.style.left = `${toX(pj.t)}px`;
      }
    }
  }

  /** The index of the segment whose section holds t (sections mode). */
  function segmentAt(t) {
    if (model.mode !== 'sections' || !segEls.length) return -1;
    return model.mapper.indexAt(t);
  }

  let lastX = NaN, lastCurrent = -2, lastProgress = NaN, scrubbing = null;
  function renderFrame(t, {force = false} = {}) {
    const at = scrubbing ? scrubbing.t : t;
    const x = toX(at);
    if (force || Math.abs(x - lastX) >= 0.25) {
      lastX = x;
      playhead.style.transform = `translateX(${x}px)`;
    }
    if (model.mode !== 'sections') return;
    const i = segmentAt(at);
    if (i !== lastCurrent) {
      if (segEls[lastCurrent]) {
        segEls[lastCurrent].el.removeAttribute('data-current');
        segEls[lastCurrent].progress.style.transform = '';
      }
      lastCurrent = i;
      lastProgress = NaN;
      if (segEls[i]) {
        segEls[i].el.setAttribute('data-current', '');
        if (!scrubbing) keepInView(model.layout.boxes[i]);
      }
    }
    const seg = segEls[i];
    if (seg) {
      // Over the segment's span (the first holds the lead-in, the last the tail), as toX draws it.
      const r = model.spans[i] ?? seg.region;
      const p = r.t1 > r.t0 ? clamp((at - r.t0) / (r.t1 - r.t0), 0, 1) : 0;
      if (force || Math.abs(p - lastProgress) >= 0.002) {
        lastProgress = p;
        seg.progress.style.transform = `scaleX(${p})`;
      }
    }
  }

  /** Scrolls the track so the box [x, x + w] is visible. */
  function keepInView(box, {smooth = true} = {}) {
    if (!box || !(model.layout.width > width + 0.5)) return;
    const left = track.scrollLeft || 0, right = left + width;
    let next = null;
    if (box.x < left) next = box.x;
    else if (box.x + box.w > right) next = Math.min(box.x, box.x + box.w - width);
    if (next === null) return;
    const reduce = !!win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (typeof track.scrollTo === 'function') track.scrollTo({left: Math.max(0, next), behavior: smooth && !reduce ? 'smooth' : 'auto'});
    else track.scrollLeft = Math.max(0, next);
  }

  // ------------------------------------------------------------------ keyboard: roving items
  /** The items ←/→ move over: sections; markers (unmapped); bars (mapped, no sections); else 5 s steps. */
  function items() {
    if (model.mode === 'sections') {
      return model.regions.map((r) => ({kind: 'section', t0: r.t0, t1: r.t1, label: r.label, index: r.index, region: r}));
    }
    const end = duration();
    if (mapped()) {
      return map.bars.map((b) => {
        const label = b.display == null ? COPY.pickup : COPY.bar(b.display);
        return {kind: 'bar', t0: b.t0, t1: b.t1, label, bar: b.display, index: b.index};
      });
    }
    const regions = position.regions();
    if (regions.length) {
      const list = regions.map((r) => ({kind: 'marker', id: r.id, t0: r.t0, t1: r.t1, label: r.label, region: r}));
      if (list[0].t0 > EPS) list.unshift({kind: 'marker', id: null, t0: 0, t1: list[0].t0, label: COPY.start});
      return list;
    }
    const list = [];
    for (let t = 0; t < end - EPS || (!list.length && t === 0); t += STEP_SEC) {
      list.push({kind: 'marker', id: null, t0: t, t1: Math.min(end, t + STEP_SEC), label: formatClock(t)});
    }
    return list;
  }

  const itemIndexAt = (list, t) => {
    let found = 0;
    for (let i = 0; i < list.length; i++) if (list[i].t0 <= t + EPS) found = i;
    return found;
  };

  // The roving item exists only for keyboard use (D45; dispatch.js rule 7's modality): a keyboard
  // focus-in starts it at the position, a pointer focus-in does not, and any pointer press on the
  // strip drops it, so Enter and L then act on what the press did (transport.again, loopToggle)
  // rather than on an item the user can no longer see. The next arrow key starts it again.
  let focusIndex = -1;    // the roving item while the slider has keyboard focus
  let focusPoint = null;  // the slider's value then (the position at focus-in, then the item's start)
  let offFocused = null;
  // A press on the strip is under way: a focus-in now came from it (a mouse focuses on mousedown,
  // a touch tap on its compatibility mousedown after pointerup, both before the click).
  let pointerPress = false, pointerPressTimer = null;

  function focusedItem() {
    if (focusIndex < 0) return null;
    const item = items()[focusIndex];
    if (!item) return null;
    const out = {kind: item.kind, t0: item.t0, t1: item.t1, label: item.label};
    if (item.kind === 'bar') out.bar = item.bar;
    return out;
  }

  function valueText(t) {
    const end = duration();
    const at = clamp(finite(t) ? t : 0, 0, end || Infinity);
    if (!mapped()) {
      const r = regionAt(at);
      return COPY.valueUnmapped({time: formatClock(at), region: r?.label});
    }
    const bb = map.barBeatAt(at);
    const bar = bb.pickup || bb.before || bb.display == null ? COPY.pickup : COPY.bar(bb.display);
    const section = map.hasSections ? map.sectionAt(at)?.name : null;
    return COPY.valueMapped({bar, beat: bb.beat, section});
  }

  let lastValue = null;
  function setValue(t) {
    const text = valueText(t);
    const now = String(Math.round(clamp(t, 0, duration() || Infinity) * 10) / 10);
    if (slider.getAttribute('aria-valuenow') !== now) slider.setAttribute('aria-valuenow', now);
    if (text !== lastValue) { lastValue = text; slider.setAttribute('aria-valuetext', text); }
  }

  function renderFocus() {
    const list = focusIndex >= 0 ? items() : [];
    const item = list[focusIndex];
    if (!item) { focusEl.hidden = true; return; }
    const x0 = toX(item.t0), x1 = toX(item.t1);
    focusEl.hidden = false;
    focusEl.style.left = `${x0}px`;
    focusEl.style.width = `${Math.max(4, x1 - x0)}px`;
    for (const seg of segEls) seg.el.toggleAttribute('data-focused', seg.region.index === item.index && item.kind === 'section');
  }

  function moveFocus(to) {
    const list = items();
    if (!list.length) return;
    focusIndex = clamp(to, 0, list.length - 1);
    focusPoint = list[focusIndex].t0;
    setValue(focusPoint);
    renderFocus();
    keepInView({x: toX(list[focusIndex].t0), w: Math.max(1, toX(list[focusIndex].t1) - toX(list[focusIndex].t0))}, {smooth: false});
    registry.invalidate?.();
  }

  /** Starts the roving item at the position and provides it as ctx.focused. */
  function startRoving(list = items()) {
    focusPoint = pos();
    focusIndex = list.length ? itemIndexAt(list, focusPoint) : -1;
    setValue(focusPoint);
    renderFocus();
    if (!offFocused) offFocused = registry.provide('focused', () => focusedItem());
    registry.invalidate?.();
  }
  /** Drops the roving item and withdraws ctx.focused; aria-valuetext follows the position again. */
  function dropRoving() {
    const had = focusIndex >= 0 || !!offFocused;
    focusIndex = -1;
    focusPoint = null;
    renderFocus();
    offFocused?.();
    offFocused = null;
    setValue(pos());
    if (had) registry.invalidate?.();
  }

  const onKeyDown = (e) => {
    if (e.target !== slider || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) return;
    const list = items();
    if (!list.length) return;
    if (focusIndex < 0) startRoving(list);
    let next = null;
    if (e.key === 'ArrowRight') next = focusIndex + 1;
    else if (e.key === 'ArrowLeft') next = focusPoint !== null && focusPoint > list[focusIndex].t0 + EPS ? focusIndex : focusIndex - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    if (next === null) return;
    e.preventDefault();
    moveFocus(next);
  };

  const onFocus = () => {
    if (pointerPress) return;   // a click or tap focused it: no roving item until a key
    startRoving();
  };
  const onBlur = () => dropRoving();
  const endPress = () => { pointerPress = false; clearTimeout(pointerPressTimer); pointerPressTimer = null; };
  // Capture, so a press on a child that stops propagation (the viewport bracket) counts too.
  const onPressCapture = () => {
    pointerPress = true;
    clearTimeout(pointerPressTimer);
    pointerPressTimer = setTimeout(endPress, PRESS_FOCUS_MS);
    if (focusIndex >= 0 || offFocused) dropRoving();
  };
  slider.addEventListener('keydown', endPress, true);
  slider.addEventListener('keydown', onKeyDown);
  slider.addEventListener('focus', onFocus);
  slider.addEventListener('blur', onBlur);
  slider.addEventListener('pointerdown', onPressCapture, true);
  slider.addEventListener('click', endPress);
  offs.push(() => {
    slider.removeEventListener('keydown', endPress, true);
    slider.removeEventListener('keydown', onKeyDown);
    slider.removeEventListener('focus', onFocus);
    slider.removeEventListener('blur', onBlur);
    slider.removeEventListener('pointerdown', onPressCapture, true);
    slider.removeEventListener('click', endPress);
    endPress();
    offFocused?.();
    offFocused = null;
  });

  // ------------------------------------------------------------------ gestures
  const xOf = (clientX) => clientX - (content.getBoundingClientRect?.().left ?? 0);
  const timeAt = (clientX) => clamp(toT(xOf(clientX)), 0, duration());

  /** What a tap at t aims at: {t, label, seg} (the segment start, the bar start, or the time). */
  function targetAt(t) {
    if (model.mode === 'sections') {
      const i = segmentAt(t), r = model.regions[i];
      return r ? {t: r.t0, label: r.label, seg: i} : {t, label: null, seg: -1};
    }
    if (mapped()) {
      const b = barStart(t);
      return {t: b.t, label: b.label, seg: -1};
    }
    return {t, label: null, seg: -1};
  }

  function tap(t) {
    if (renaming) return;
    const s = snap();
    const target = targetAt(t);
    if (!playingPhase(s)) { transport.cue(target.t); return; }
    const pj = s.pendingJump;
    if (pj && finite(pj.t)) {
      const same = model.mode === 'sections' ? segmentAt(pj.t) === target.seg : Math.abs(pj.t - target.t) < 1e-3;
      if (same) { transport.cancelJump(); return; }
    }
    transport.jump(target.t, target.label ? {label: target.label} : {});
  }

  function doubleTap(t) {
    if (renaming) return;
    if (playingPhase()) { tap(t); return; }
    if (model.mode === 'sections') {
      const r = model.regions[segmentAt(t)];
      if (r) transport.loopRange(r.t0, r.t1, {label: 'loop section', snap: 'none'});
      return;
    }
    const region = !mapped() ? regionAt(t) : null;
    if (region && region.t1 > region.t0) { transport.loopRange(region.t0, region.t1, {label: 'loop section', snap: 'none'}); return; }
    const d = position.loopDefault(t);
    transport.loopRange(d.a, d.b, {label: 'loop section', snap: 'none'});
  }

  /** The snapped loop a drag from a to b makes (spec §4.8 on the strip: across segments). */
  function snapRange(a, b, {alt = false} = {}) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (model.mode === 'sections' && !alt) {
      const i = segmentAt(lo), j = segmentAt(hi);
      const ri = model.regions[i], rj = model.regions[j];
      if (ri && rj) return {a: ri.t0, b: rj.t1};
    }
    if (mapped()) {
      const unit = alt ? 'beat' : 'bar';
      const sa = map.snapTime(lo, unit, {mode: 'floor'});
      let sb = map.snapTime(hi, unit, {mode: 'ceil'});
      if (sb <= sa + EPS) sb = map.snapTime(sa + 1e-3, unit, {mode: 'ceil'});
      return {a: sa, b: sb};
    }
    return {a: position.snap(lo, 'tenth'), b: position.snap(hi, 'tenth')};
  }

  let drag = null;   // {from, alt}
  function dragStart(t, {alt}) {
    if (renaming) return;
    drag = {from: t, alt};
    preview = {a: t, b: t};
    nav.setAttribute('data-dragging', '');
    renderTransport();
  }
  function dragMove(t, {alt}) {
    if (!drag) return;
    drag.alt = alt;
    preview = {a: drag.from, b: t};
    renderTransport();
  }
  function dragEnd(t, {cancelled = false} = {}) {
    if (!drag) return;
    const d = drag;
    drag = null;
    preview = null;
    nav.removeAttribute('data-dragging');
    if (cancelled) { renderTransport(); return; }
    const range = snapRange(d.from, t, {alt: d.alt});
    spring();
    if (!(range.b - range.a > EPS) || !transport.loopRange(range.a, range.b, {label: 'loop', snap: 'none'})) renderTransport();
  }

  // Touch scrub (stopped): a touch that moves before the long press is ours, not the browser's
  // (touch-action is none while stopped); press.js drops such a press itself.
  let candidate = null;   // {id, x0, y0}
  function scrubLabel(t) {
    if (mapped()) {
      const b = barStart(t);
      const section = map.hasSections ? map.sectionAt(t)?.name : null;
      return COPY.scrub([b.label, section]);
    }
    return COPY.scrub([formatClock(t), regionAt(t)?.label]);
  }
  function scrubTo(t, id) {
    scrubbing = {t, id};
    scrubEl.hidden = false;
    scrubEl.textContent = scrubLabel(t);
    scrubEl.style.left = `${toX(t)}px`;
    renderFrame(t, {force: true});
    keepInView({x: toX(t) - 24, w: 48}, {smooth: false});
    try { onScrub?.(t); } catch (err) { console.error('[strip] onScrub failed', err); }
  }
  function scrubEnd({cancelled = false} = {}) {
    if (!scrubbing) return;
    const t = scrubbing.t;
    scrubbing = null;
    scrubEl.hidden = true;
    nav.removeAttribute('data-scrubbing');
    if (!cancelled) transport.cue(mapped() ? barStart(t).t : t);
    renderFrame(pos(), {force: true});
  }

  // The scrub belongs to its own pointer: only that pointer's up, cancel or lost capture ends it,
  // and a second pointer (a pinch, a palm, the mouse) cancels it outright.
  const onPointerDown = (e) => {
    if (e.target?.closest?.('[data-press-ignore]')) return;
    const other = (candidate && e.pointerId !== candidate.id) || (scrubbing && e.pointerId !== scrubbing.id);
    if (other) {
      candidate = null;
      if (scrubbing) scrubEnd({cancelled: true});
    } else if ((e.pointerType === 'touch' || e.pointerType === 'pen') && e.isPrimary !== false && !playingPhase() && !renaming) {
      candidate = {id: e.pointerId, x0: e.clientX, y0: e.clientY};
    } else {
      candidate = null;
    }
    if (e.pointerType === 'mouse' && e.button === 0) mouseDown = {x: e.clientX};
  };
  let mouseDown = null;
  const onPointerMove = (e) => {
    if (scrubbing && e.pointerId === scrubbing.id) {
      scrubTo(timeAt(e.clientX), e.pointerId);
      return;
    }
    if (!candidate || e.pointerId !== candidate.id) return;
    if (Math.hypot(e.clientX - candidate.x0, e.clientY - candidate.y0) <= MOVE_TOL) return;
    try { slider.setPointerCapture?.(e.pointerId); } catch { /* the pointer is already gone */ }
    nav.setAttribute('data-scrubbing', '');
    scrubTo(timeAt(e.clientX), e.pointerId);
  };
  const endPointer = (e, {cancelled}) => {
    if (candidate && e.pointerId === candidate.id) candidate = null;
    if (scrubbing && e.pointerId === scrubbing.id) scrubEnd({cancelled});
  };
  const onPointerUp = (e) => endPointer(e, {cancelled: false});
  const onPointerCancel = (e) => endPointer(e, {cancelled: true});
  // Losing the capture without a pointerup (the strip was hidden, another capture) cancels; after a
  // pointerup the scrub has already ended.
  const onLostCapture = (e) => {
    if (e.target !== slider || !scrubbing || e.pointerId !== scrubbing.id) return;
    const s = scrubbing;
    queueMicrotask(() => { if (scrubbing === s || (scrubbing && scrubbing.id === s.id)) endPointer(e, {cancelled: true}); });
  };
  slider.addEventListener('pointerdown', onPointerDown);
  slider.addEventListener('pointermove', onPointerMove);
  slider.addEventListener('pointerup', onPointerUp);
  slider.addEventListener('pointercancel', onPointerCancel);
  slider.addEventListener('lostpointercapture', onLostCapture);
  offs.push(() => {
    slider.removeEventListener('pointerdown', onPointerDown);
    slider.removeEventListener('pointermove', onPointerMove);
    slider.removeEventListener('pointerup', onPointerUp);
    slider.removeEventListener('pointercancel', onPointerCancel);
    slider.removeEventListener('lostpointercapture', onLostCapture);
  });

  let longFrom = null;
  const offPress = createPressRecognizer(slider, {
    touchAction: null,   // strip.css: none while stopped (scrub), pan-x while playing (scroll)
    onTap: (g) => tap(timeAt(g.clientX)),
    onDouble: (g) => doubleTap(timeAt(g.clientX)),
    onLongStart: (g) => {
      candidate = null;
      if (scrubbing) scrubEnd({cancelled: true});
      longFrom = timeAt(g.clientX);
      return true;
    },
    onLongDrag: (g) => {
      if (longFrom === null) return;
      if (!drag) dragStart(longFrom, {alt: false});
      dragMove(timeAt(g.clientX), {alt: false});
    },
    onLongEnd: (g, {dragged, cancelled} = {}) => {
      longFrom = null;
      if (dragged) dragEnd(timeAt(g.clientX), {cancelled});
    },
    onMenu: (g) => openMenu(g),
    onDragStart: (g) => {
      const from = mouseDown ? timeAt(mouseDown.x) : timeAt(g.clientX);
      dragStart(from, {alt: !!g.altKey});
    },
    onDrag: (g) => dragMove(timeAt(g.clientX), {alt: !!g.altKey}),
    onDragEnd: (g) => { mouseDown = null; dragEnd(timeAt(g.clientX), {cancelled: !!g.cancelled}); },
  });
  offs.push(offPress);

  // A vertical wheel scrolls an overflowing strip sideways.
  // At either end the wheel is left to the page (the Stage scrolls on); line and page deltas
  // (Firefox) are scaled to pixels.
  const WHEEL_LINE_PX = 16;
  const onWheel = (e) => {
    if (!(model.layout.width > width + 0.5) || e.ctrlKey) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const scale = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? Math.max(1, width) : 1;
    const from = track.scrollLeft || 0;
    const to = clamp(from + e.deltaY * scale, 0, Math.max(0, model.layout.width - width));
    if (Math.abs(to - from) < 0.5) return;
    e.preventDefault();
    track.scrollLeft = to;
  };
  track.addEventListener('wheel', onWheel, {passive: false});
  offs.push(() => track.removeEventListener('wheel', onWheel));

  // ------------------------------------------------------------------ the menus
  /** The overlay a pointer menu press at clientX aims at: {kind: 'spot'|'marker'|'loopBand', …} or null. */
  function menuTargetAt(clientX, pointerType) {
    const x = xOf(clientX);
    const tol = pointerType === 'touch' || pointerType === 'pen' ? MENU_HIT_PX.coarse : MENU_HIT_PX.fine;
    const nearest = (list, tOf) => {
      let best = null, bestD = Infinity;
      for (const item of list) {
        const d = Math.abs(toX(tOf(item)) - x);
        if (d <= tol && d < bestD) { best = item; bestD = d; }
      }
      return best;
    };
    const spot = nearest((peek(practice.value)?.spots ?? []).filter((s) => s?.id && !s.deleted && finite(s.a)), (s) => s.a);
    if (spot) return {kind: 'spot', spot};
    const marker = nearest(position.markerTicks().filter((m) => m?.id && finite(m.t)), (m) => m.t);
    if (marker) return {kind: 'marker', marker};
    const loop = snap().loop;
    if (loop?.on && finite(loop.a) && finite(loop.b) && loop.b > loop.a) {
      const x0 = toX(loop.a), x1 = toX(loop.b), mid = (x0 + x1) / 2;
      if (Math.abs(x - mid) <= Math.max((x1 - x0) / 2, tol)) return {kind: 'loopBand'};
    }
    return null;
  }

  /** The mounted Stage's api (registry context 'stage'), or null (the harness mounts the strip alone). */
  function stageApi() {
    try {
      const stage = registry.context?.().stage;
      return stage && typeof stage.openMenu === 'function' ? stage : null;
    } catch {
      return null;
    }
  }

  /** Opens the spot, marker or loop-band menu at the press point. */
  async function openTargetMenu(target, g) {
    const anchor = {x: g.clientX, y: g.clientY};
    const opts = {};
    if (target.kind === 'spot') opts.spot = target.spot;
    if (target.kind === 'marker') {
      opts.marker = target.marker;
      // Unmapped, the marker starts a region: Rename… uses the strip's inline field (else menus.js asks).
      opts.rename = () => {
        const region = mapped() ? null : position.regions().find((r) => r.kind === 'marker' && r.id === target.marker.id);
        return region ? rename(region) : false;
      };
    }
    menu?.close?.();
    const stage = stageApi();
    if (stage) {
      try { await stage.openMenu(target.kind, {...opts, anchor}); } catch (err) { console.error(`[strip] the ${target.kind} menu could not open`, err); }
      return;
    }
    const load = LATER[MENUS_PATH];
    if (!load) return;
    let mod;
    try { mod = await load(); } catch (err) { console.error('[strip] the menus could not load', err); return; }
    if (destroyed) return;
    const build = {spot: mod?.spotMenu, marker: mod?.markerMenu, loopBand: mod?.loopBandMenu}[target.kind];
    if (typeof build !== 'function') return;
    const builderOpts = {registry, ...(opts.rename ? {rename: opts.rename} : {})};
    const list = target.kind === 'loopBand' ? build(session, builderOpts) : build(session, opts[target.kind], builderOpts);
    if (!Array.isArray(list) || !list.length) return;
    menu?.close?.();
    menu = Menu.open(list, {anchor, label: COPY.menuLabel[target.kind](opts[target.kind]), registry, onClose: () => { menu = null; }});
  }

  let menu = null;
  async function openMenu(g) {
    if (renaming) return;
    if (!g.keyboard) {
      const target = menuTargetAt(g.clientX, g.pointerType);
      if (target) { await openTargetMenu(target, g); return; }
    }
    let region = null, t;
    if (g.keyboard) {
      const item = focusIndex >= 0 ? items()[focusIndex] : null;
      t = item?.t0 ?? pos();
      region = item?.region ?? (model.mode === 'sections' ? model.regions[segmentAt(t)] ?? null : regionAt(t));
    } else {
      t = timeAt(g.clientX);
      region = model.mode === 'sections' ? model.regions[segmentAt(t)] ?? null : regionAt(t);
    }
    if (!region) return;
    const load = LATER[MENUS_PATH];
    if (!load) return;
    let mod;
    try { mod = await load(); } catch (err) { console.error('[strip] the menus could not load', err); return; }
    if (destroyed || typeof mod?.sectionMenu !== 'function') return;
    const items_ = mod.sectionMenu(session, region, {t, rename: () => rename(region)});
    if (!Array.isArray(items_) || !items_.length) return;
    menu?.close?.();
    const anchor = g.keyboard ? (focusEl.hidden ? slider : focusEl) : {x: g.clientX, y: g.clientY};
    menu = Menu.open(items_, {anchor, label: region.label, registry, onClose: () => { menu = null; }});
  }

  // ------------------------------------------------------------------ inline rename
  let renaming = null;   // {input, region}
  /**
   * Renames a section (mapped: writes the bar label, one practice-undo step through
   * session.mapChange, D23) or a marker region (unmapped) in an inline field over it.
   * Returns false when the region cannot be renamed here.
   */
  function rename(region) {
    if (destroyed || !region) return false;
    const isSection = region.kind === 'section';
    if (isSection && (session.readOnly || !mapped() || !Number.isInteger(region.startBar))) return false;
    if (!isSection && (region.kind !== 'marker' || !region.id)) return false;
    cancelRename();
    // The section's own stored label: '' for the synthetic Start (measure 0's auto 'Pickup' included).
    const current = isSection ? sectionLabelOf({index: region.startBar, label: String(map.bars[region.startBar]?.label ?? '')})
      : String(region.label ?? '');
    const name = region.label || COPY.start;
    const input = h('input', {
      class: 'strip-rename', type: 'text', value: current, maxLength: MAX_LABEL, placeholder: name,
      attrs: {'aria-label': COPY.rename(name), 'data-consume-keys': 'Enter Escape', autocomplete: 'off', spellcheck: 'false'},
    });
    const x0 = toX(region.t0);
    const box = model.mode === 'sections' ? model.layout.boxes[segmentAt(region.t0)] : null;
    input.style.left = `${box ? box.x : x0}px`;
    input.style.width = `${Math.max(140, box ? box.w : 160)}px`;
    renaming = {input, region};
    nav.setAttribute('data-renaming', '');
    // Enter and Escape return focus to the strip; a blur (Tab, a click elsewhere) commits and
    // leaves focus where the user sent it.
    const finish = (commit, {refocus = true} = {}) => {
      if (!renaming || renaming.input !== input) return;
      const text = input.value.trim().slice(0, MAX_LABEL);
      renaming = null;
      nav.removeAttribute('data-renaming');
      if (refocus && !destroyed) slider.focus?.({preventScroll: true});
      input.remove();
      if (commit && text && text !== current) commitRename(region, text, current);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true, {refocus: false}));
    content.append(input);
    keepInView({x: box ? box.x : x0, w: Math.max(140, box ? box.w : 160)}, {smooth: false});
    input.focus?.();
    input.select?.();
    return true;
  }

  function cancelRename() {
    if (!renaming) return;
    const {input} = renaming;
    renaming = null;
    nav.removeAttribute('data-renaming');
    input.remove();
  }

  function commitRename(region, text, before) {
    if (region.kind === 'section') {
      const index = region.startBar;
      session.mapChange(COPY.renameUndo, (m) => {
        m.edit((d) => { if (d.measures[index]) d.measures[index].label = text; }, 'label');
      });
      return;
    }
    const id = region.id;
    practice.renameMarker(id, text);
    session.undo?.push?.({
      key: 'markers', label: COPY.renameMarkerUndo,
      describe: (from, to) => `marker ${from} → ${to}`,
      from: before, to: text,
      apply: (value) => practice.renameMarker(id, value),
    });
  }

  // ------------------------------------------------------------------ the viewport bracket (Stems)
  function renderViewport() {
    const v = viewport ? viewport.value : null;
    if (!v || !finite(v.t0) || !finite(v.t1) || v.t1 <= v.t0) { viewEl.hidden = true; return; }
    const x0 = toX(v.t0), x1 = toX(v.t1);
    viewEl.hidden = false;
    viewEl.style.left = `${x0}px`;
    viewEl.style.width = `${Math.max(6, x1 - x0)}px`;
  }
  let viewDrag = null;
  const onViewDown = (e) => {
    const v = viewport ? peek(viewport) : null;
    if (!v || typeof onViewport !== 'function' || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    viewDrag = {id: e.pointerId, x0: e.clientX, t0: v.t0, t1: v.t1};
    try { viewEl.setPointerCapture?.(e.pointerId); } catch { /* gone */ }
    viewEl.setAttribute('data-dragging', '');
  };
  const onViewMove = (e) => {
    if (!viewDrag || e.pointerId !== viewDrag.id) return;
    const span = viewDrag.t1 - viewDrag.t0, end = duration();
    const startX = toX(viewDrag.t0) + (e.clientX - viewDrag.x0);
    const t0 = clamp(toT(startX), 0, Math.max(0, end - span));
    onViewport({t0, t1: t0 + span});
  };
  const onViewUp = (e) => {
    if (!viewDrag || e.pointerId !== viewDrag.id) return;
    viewDrag = null;
    viewEl.removeAttribute('data-dragging');
  };
  viewEl.addEventListener('pointerdown', onViewDown);
  viewEl.addEventListener('pointermove', onViewMove);
  viewEl.addEventListener('pointerup', onViewUp);
  viewEl.addEventListener('pointercancel', onViewUp);

  // ------------------------------------------------------------------ wiring
  width = measure();
  // Structure: the map (revision), the suggestion, the load phase (peaks, duration).
  offs.push(effect(() => {
    position.revision?.value;
    position.mapped?.value;
    session.detect?.suggestion?.value;
    session.load?.value?.phase;
    if (destroyed) return;
    renderStructure();
  }));
  // Markers and spots: redrawn only when they change (a cue or loop patch leaves them alone).
  let marksKey = null, spotsKey = null;
  offs.push(effect(() => {
    const p = practice.value?.value;
    if (destroyed) return;
    const mk = keyOf(p?.markers, (m) => [m.id, m.t, !!m.deleted]);
    const sk = keyOf(p?.spots, (s) => [s.id, s.a, !!s.deleted]);
    if (mk !== marksKey) { marksKey = mk; renderTicks(); }
    if (sk !== spotsKey) { spotsKey = sk; renderSpots(); }
  }));
  // Transport: phase, cue, loop, pending jump; the position when stopped.
  offs.push(effect(() => {
    transport.snapshot?.value;
    if (destroyed) return;
    renderTransport();
    renderFrame(pos());
    if (focusIndex < 0) setValue(pos());
  }));
  if (viewport) offs.push(effect(() => { viewport.value; if (!destroyed) renderViewport(); }));
  // Frames: the playhead and progress at 60 Hz, the slider value text at ≤ 30 Hz.
  if (session.frame?.subscribe) {
    offs.push(session.frame.subscribe((f) => renderFrame(f.position), {hz: 60}));
    offs.push(session.frame.subscribe((f) => { if (focusIndex < 0 && !scrubbing) setValue(f.position); }, {hz: 30}));
  }
  // Width.
  const RO = win?.ResizeObserver;
  if (typeof RO === 'function') {
    const ro = new RO(() => {
      const w = measure();
      if (w === width) { drawWave(); return; }
      width = w;
      renderStructure();
    });
    ro.observe(track);
    offs.push(() => ro.disconnect());
  }
  // Theme or place changes re-read the tokens the waveform is drawn with.
  const onTheme = () => drawWave();
  win?.addEventListener?.('woodshed:theme', onTheme);
  win?.addEventListener?.('woodshed:place', onTheme);
  offs.push(() => {
    win?.removeEventListener?.('woodshed:theme', onTheme);
    win?.removeEventListener?.('woodshed:place', onTheme);
  });

  return {
    el: nav,
    rename,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(springTimer);
      cancelRename();
      menu?.close?.();
      for (const b of trayButtons) b.destroy();
      trayButtons = [];
      for (const off of offs.splice(0)) { try { off?.(); } catch (err) { console.error('[strip] cleanup failed', err); } }
      viewEl.removeEventListener('pointerdown', onViewDown);
      viewEl.removeEventListener('pointermove', onViewMove);
      viewEl.removeEventListener('pointerup', onViewUp);
      viewEl.removeEventListener('pointercancel', onViewUp);
      nav.remove();
    },
  };
}

export default mountStrip;
