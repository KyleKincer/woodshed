// Progress display (architecture §2.12, spec §3.4 and §2.8).
//
//   ProgressRail({value, striped, label, ...common})
//     value    0..1 (determinate) or null (indeterminate: a shimmer; under reduced motion a
//              static rail at 90%, spec §3.4 "Finishing")
//     striped  diagonal stripes on the track ("Waiting": empty, striped)
//     label    the progressbar's accessible name; without one the rail is decorative (aria-hidden)
//   ProgressRing({value, size, label, ...common})
//     value    0..1 or null (a turning arc; under reduced motion a static quarter arc)
//     size     px number, or 'sm' (20) | 'md' (32, default) | 'lg' (48) | 'fill' (the container's size)
//     label    as for the rail. Used by the Play loading ring and HoldButton.
//   StageStepper({stages: [{id, label}], current, percent, failed, label, ...common})
//     stages before `current` are done (✓), `current` is in progress (● and `percent`%), later
//     ones are pending: `Fetch ✓ — Split ● 46% — Finish — Ready`. current null: nothing started.
//     failed  the current stage failed (✕ instead of ●). label: the list's name (default 'Progress').
//   Each returns {el, set(partial), destroy()}; set patches only what changed.
//
// Motion: the rail and ring read `(prefers-reduced-motion: reduce)` live and expose it as
// data-motion="animate|static" while indeterminate, so the static fallback is in the DOM, not
// only in CSS. Percent text carries data-volatile (masked in captures, §11.2).

import '../styles/primitives/progress.css';

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
/** Where an indeterminate rail rests under reduced motion (spec §3.4). */
export const STATIC_RAIL_VALUE = 0.9;
/** Where an indeterminate ring rests under reduced motion. */
export const STATIC_RING_VALUE = 0.25;
export const RING_SIZES = Object.freeze({sm: 20, md: 32, lg: 48});

const SVG_NS = 'http://www.w3.org/2000/svg';
const EMPTY = Object.freeze({});
const clamp01 = v => Math.min(1, Math.max(0, v));
const isValue = v => typeof v === 'number' && Number.isFinite(v);

// Common props (§2.12): className, id, attrs, dataset, testid.
function applyCommon(el, next, prev) {
  if (next.className !== prev.className) {
    for (const c of String(prev.className ?? '').split(/\s+/)) if (c) el.classList.remove(c);
    for (const c of String(next.className ?? '').split(/\s+/)) if (c) el.classList.add(c);
  }
  if (next.id !== prev.id) { if (next.id) el.id = next.id; else el.removeAttribute('id'); }
  if (next.testid !== prev.testid) { if (next.testid) el.dataset.testid = next.testid; else delete el.dataset.testid; }
  if (next.attrs !== prev.attrs) {
    for (const k of Object.keys(prev.attrs ?? {})) if (!Object.hasOwn(next.attrs ?? {}, k)) el.removeAttribute(k);
    for (const [k, v] of Object.entries(next.attrs ?? {})) { if (v == null || v === false) el.removeAttribute(k); else el.setAttribute(k, v === true ? '' : String(v)); }
  }
  if (next.dataset !== prev.dataset) {
    for (const k of Object.keys(prev.dataset ?? {})) if (!Object.hasOwn(next.dataset ?? {}, k)) delete el.dataset[k];
    for (const [k, v] of Object.entries(next.dataset ?? {})) { if (v == null || v === false) delete el.dataset[k]; else el.dataset[k] = v === true ? '' : String(v); }
  }
}

function reducedMotion() {
  const mql = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(REDUCED_MOTION_QUERY) : null;
  return {
    get matches() { return !!mql?.matches; },
    listen(fn) { mql?.addEventListener?.('change', fn); return () => mql?.removeEventListener?.('change', fn); },
  };
}

/** progressbar semantics shared by the rail and the ring. */
function applyBar(el, label, value) {
  if (label) {
    el.setAttribute('role', 'progressbar');
    el.setAttribute('aria-label', label);
    el.removeAttribute('aria-hidden');
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    if (isValue(value)) {
      const pct = Math.round(clamp01(value) * 100);
      el.setAttribute('aria-valuenow', String(pct));
      el.setAttribute('aria-valuetext', `${pct}%`);
    } else {
      el.removeAttribute('aria-valuenow');
      el.removeAttribute('aria-valuetext');
    }
  } else {
    for (const a of ['role', 'aria-label', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext']) el.removeAttribute(a);
    el.setAttribute('aria-hidden', 'true');
  }
}

// ------------------------------------------------------------------------------------------------ ProgressRail

export function ProgressRail(initial = {}) {
  const el = document.createElement('div');
  el.className = 'ui-progress-rail';
  const fill = document.createElement('div');
  fill.className = 'ui-progress-rail-fill';
  el.append(fill);
  const motion = reducedMotion();
  const offMotion = motion.listen(() => render());
  let props = EMPTY;
  let shown = null;

  function render() {
    const indeterminate = !isValue(props.value);
    const reduced = motion.matches;
    const shownValue = indeterminate ? (reduced ? STATIC_RAIL_VALUE : null) : clamp01(props.value);
    const key = `${indeterminate}|${reduced}|${shownValue}|${!!props.striped}|${props.label ?? ''}`;
    if (key === shown) return;
    shown = key;
    if (indeterminate) {
      el.dataset.indeterminate = '';
      el.dataset.motion = reduced ? 'static' : 'animate';
    } else {
      delete el.dataset.indeterminate;
      delete el.dataset.motion;
    }
    if (shownValue == null) fill.style.removeProperty('--progress');
    else fill.style.setProperty('--progress', String(shownValue));
    if (props.striped) el.dataset.striped = ''; else delete el.dataset.striped;
    applyBar(el, props.label, indeterminate ? null : props.value);
  }

  function set(partial = {}) {
    const prev = props;
    props = {...prev, ...partial};
    applyCommon(el, props, prev);
    render();
  }

  function destroy() {
    offMotion();
    el.remove();
  }

  set({value: null, striped: false, ...initial});
  return {el, set, destroy};
}

// ------------------------------------------------------------------------------------------------ ProgressRing

const RING_R = 15;   // in a 36×36 viewBox, leaving room for a stroke of 4

export function ProgressRing(initial = {}) {
  const el = document.createElement('span');
  el.className = 'ui-progress-ring';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const circle = cls => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '18');
    c.setAttribute('cy', '18');
    c.setAttribute('r', String(RING_R));
    c.setAttribute('pathLength', '100');
    return c;
  };
  const track = circle('ui-progress-ring-track');
  const arc = circle('ui-progress-ring-fill');
  svg.append(track, arc);
  el.append(svg);
  const motion = reducedMotion();
  const offMotion = motion.listen(() => render());
  let props = EMPTY;

  function render() {
    const indeterminate = !isValue(props.value);
    const reduced = motion.matches;
    const v = indeterminate ? STATIC_RING_VALUE : clamp01(props.value);
    arc.setAttribute('stroke-dasharray', `${(v * 100).toFixed(2)} 100`);
    if (indeterminate) {
      el.dataset.indeterminate = '';
      el.dataset.motion = reduced ? 'static' : 'animate';
    } else {
      delete el.dataset.indeterminate;
      delete el.dataset.motion;
    }
    const size = props.size ?? 'md';
    if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
      delete el.dataset.size;
      el.style.inlineSize = `${size}px`;
      el.style.blockSize = `${size}px`;
    } else {
      el.dataset.size = size === 'fill' || RING_SIZES[size] ? size : 'md';
      el.style.removeProperty('inline-size');
      el.style.removeProperty('block-size');
    }
    applyBar(el, props.label, indeterminate ? null : props.value);
  }

  function set(partial = {}) {
    const prev = props;
    props = {...prev, ...partial};
    applyCommon(el, props, prev);
    render();
  }

  function destroy() {
    offMotion();
    el.remove();
  }

  set({value: null, size: 'md', ...initial});
  return {el, set, destroy};
}

// ------------------------------------------------------------------------------------------------ StageStepper

const STATE_TEXT = {done: 'done', current: 'in progress', failed: 'failed', pending: 'not started'};

function markIcon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ui-icon ui-stage-stepper-icon');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Pure: each stage's state for a `current` id ('done' | 'current' | 'failed' | 'pending'). */
export function stageStates(stages, current, {failed = false} = {}) {
  const at = current == null ? -1 : stages.findIndex(s => s.id === current);
  return stages.map((s, i) => (at < 0 ? 'pending' : i < at ? 'done' : i === at ? (failed ? 'failed' : 'current') : 'pending'));
}

export function StageStepper(initial = {}) {
  const el = document.createElement('ol');
  el.className = 'ui-stage-stepper';
  let props = EMPTY;
  let items = new Map();   // id → {li, name, mark, state, pct, sr}

  function item(stage) {
    const li = document.createElement('li');
    li.className = 'ui-stage-stepper-stage';
    li.dataset.stage = stage.id;
    const name = document.createElement('span');
    name.className = 'ui-stage-stepper-label';
    const mark = document.createElement('span');
    mark.className = 'ui-stage-stepper-mark';
    mark.setAttribute('aria-hidden', 'true');
    const pct = document.createElement('span');
    pct.className = 'ui-stage-stepper-percent';
    pct.dataset.volatile = '';
    const sr = document.createElement('span');
    sr.className = 'sr-only';
    li.append(name, mark, pct, sr);
    return {li, name, mark, pct, sr, state: null, markState: null};
  }

  function render() {
    const stages = Array.isArray(props.stages) ? props.stages : [];
    const states = stageStates(stages, props.current, {failed: !!props.failed});
    const next = new Map();
    stages.forEach((stage, i) => {
      const it = items.get(stage.id) ?? item(stage);
      next.set(stage.id, it);
      const state = states[i];
      if (it.name.textContent !== String(stage.label ?? '')) it.name.textContent = String(stage.label ?? '');
      if (it.state !== state) {
        it.li.dataset.state = state;
        if (state === 'current' || state === 'failed') it.li.setAttribute('aria-current', 'step');
        else it.li.removeAttribute('aria-current');
        if (it.markState !== state) {
          it.mark.replaceChildren(...(state === 'done' ? [markIcon('check')] : state === 'failed' ? [markIcon('x')] : []));
          it.markState = state;
        }
        it.state = state;
      }
      const showPct = state === 'current' && isValue(props.percent);
      const pctText = showPct ? `${Math.round(Math.min(100, Math.max(0, props.percent)))}%` : '';
      if (it.pct.textContent !== pctText) it.pct.textContent = pctText;
      it.pct.hidden = !showPct;
      const srText = `, ${STATE_TEXT[state]}`;
      if (it.sr.textContent !== srText) it.sr.textContent = srText;
    });
    for (const [id, it] of items) if (!next.has(id)) it.li.remove();
    // Keep DOM order equal to stages order (reuses nodes).
    let i = 0;
    for (const it of next.values()) {
      if (el.children[i] !== it.li) el.insertBefore(it.li, el.children[i] ?? null);
      i++;
    }
    items = next;
    el.setAttribute('aria-label', props.label || 'Progress');
  }

  function set(partial = {}) {
    const prev = props;
    props = {...prev, ...partial};
    applyCommon(el, props, prev);
    render();
  }

  function destroy() {
    el.remove();
  }

  set({stages: [], current: null, percent: null, failed: false, ...initial});
  return {el, set, destroy};
}
