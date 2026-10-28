// BeatLamps: the visual metronome (architecture §2.12 and D15, spec §4.3 and §8.6).
//
//   const lamps = BeatLamps({units, groups, size = 'md', ...common})
//     units   meter units in the bar (the numerator: 4 for 4/4, 7 for 7/8, 6 for 6/8)
//     groups  units per counted beat (beatGroups: [1,1,1,1], [2,2,3], [3,3]); its sum must equal
//             `units`, else one counted beat per unit is assumed
//     size    'md' (the HUD: --lamp, 18 px band / 20 px rail, × Distance) | 'sm' (the mini rail)
//   lamps.set({units, groups}) per bar (rebuilds only when the meter changes)
//   lamps.frame(unitIndex, groupStart) per tick: a cheap attribute flip on at most a few dots
//     unitIndex   the 0-based meter unit at the playhead (BarBeat.unitIndex), or null/-1 for none
//     groupStart  optional: true when this tick is a counted beat's onset (re-triggers the flash
//                 even when the lit dot does not move, e.g. a count-in), or the unit index where the
//                 current counted beat starts (both are derived from `groups` when omitted). Derived
//                 onsets: the lit dot entering a new group, or returning to a group's first unit (a
//                 bar wrap in a one-group bar such as 3/8 counted as 3). A one-unit bar (1/4) lights
//                 the same unit every tick, so its caller passes `true` on each onset.
//   lamps.destroy() · lamps.el · lamps.mode ('units' | 'groups') · lamps.dots (the dot count)
//
// D15: one dot per meter unit, grouped by `groups` with a gap between groups. A group's first dot
// (a counted beat, which clicks) is larger; the downbeat dot is the largest. A bar with more than
// 12 units shows one dot per counted beat instead (15/16 as 3+3+3+3+3 → five dots). When that is
// still more than 12 dots (beatGroups' default all-ones for 13/16, 15/16 or 16/16), consecutive
// counted beats are chunked for display into runs of 4 units (3 when the bar divides by 3 but not
// by 4: 15/16 → 3+3+3+3+3, 16/16 → 4+4+4+4, 13/16 → 4+4+5), so the rail never holds more than
// 12 dots. Chunks follow counted-beat boundaries; the lit dot is the chunk holding the playhead
// and its onset flashes at the chunk start. Dots before the
// lit one are "past" (filled), the lit one is "now" (--now), later ones are "next" (outlined): the
// wireframe's `● ●  ● ◉  ○ ○ ○`. A counted beat's onset flashes (60 ms on, 180 ms decay); reduced
// motion keeps the per-beat state change without the fade. Decorative: aria-hidden (nothing is
// announced per beat, spec §8.4).

import '../styles/primitives/beat-lamps.css';

export const MAX_UNIT_DOTS = 12;
const EMPTY = Object.freeze({});

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

/**
 * Pure D15 layout for a bar: {mode, units, groups, dots, starts}.
 *   dots    [{kind: 'downbeat'|'beat'|'unit', group, unit}] in order (unit: the first meter unit it stands for)
 *   starts  the first unit of each group
 * In 'units' mode every unit has a dot; in 'groups' mode (units > 12) every counted beat has one,
 * or every display chunk of counted beats when there would be more than 12 (see chunkGroups).
 */
export function lampLayout(units, groups) {
  const n = Math.max(0, Math.floor(Number(units) || 0));
  let g = Array.isArray(groups) ? groups.map(x => Math.floor(Number(x))) : [];
  if (!g.length || g.some(x => !(x >= 1)) || g.reduce((a, b) => a + b, 0) !== n) g = Array.from({length: n}, () => 1);
  const mode = n > MAX_UNIT_DOTS ? 'groups' : 'units';
  if (mode === 'groups' && g.length > MAX_UNIT_DOTS) g = chunkGroups(g, n);
  const starts = [];
  let at = 0;
  for (const size of g) { starts.push(at); at += size; }
  const dots = [];
  if (mode === 'groups') {
    g.forEach((_, gi) => dots.push({kind: gi === 0 ? 'downbeat' : 'beat', group: gi, unit: starts[gi]}));
  } else {
    g.forEach((size, gi) => {
      for (let k = 0; k < size; k++) dots.push({kind: k > 0 ? 'unit' : gi === 0 ? 'downbeat' : 'beat', group: gi, unit: starts[gi] + k});
    });
  }
  return {mode, units: n, groups: g, dots, starts};
}

/**
 * Pure: merges consecutive counted beats into display chunks of about `size` units (D15 groups
 * mode with more than 12 counted beats). A short tail (under half a chunk) joins the chunk before it.
 */
export function chunkGroups(groups, units) {
  let size = units % 4 !== 0 && units % 3 === 0 ? 3 : 4;
  size = Math.max(size, Math.ceil(units / MAX_UNIT_DOTS));
  const out = [];
  let run = 0;
  for (const x of groups) {
    run += x;
    if (run >= size) { out.push(run); run = 0; }
  }
  if (run) {
    if (out.length && run < size / 2) out[out.length - 1] += run;
    else out.push(run);
  }
  return out;
}

/** Pure: the group (counted beat) holding a meter unit, or -1. */
export function groupOfUnit(starts, units, unitIndex) {
  if (!(unitIndex >= 0) || unitIndex >= units) return -1;
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= unitIndex) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function BeatLamps(initial = {}) {
  const el = document.createElement('div');
  el.className = 'ui-beat-lamps';
  el.setAttribute('aria-hidden', 'true');
  let props = EMPTY;
  let layout = lampLayout(0, []);
  let built = '';
  let dotEls = [];
  let states = [];        // per dot: 'past' | 'now' | 'next'
  let litDot = -1;
  let litGroup = -1;
  let litUnit = -1;
  let flashDot = -1;
  let flashPhase = 0;

  function build() {
    const groupEls = [];
    dotEls = [];
    const uniform = layout.groups.every(x => x === 1);
    let current = null;
    layout.dots.forEach((dot, i) => {
      // One wrapper per group so groups get a gap; 4/4 (all ones) and groups mode are one even row.
      const gi = layout.mode === 'groups' || uniform ? 0 : dot.group;
      if (!current || current.gi !== gi) {
        const g = document.createElement('span');
        g.className = 'ui-beat-lamps-group';
        groupEls.push(g);
        current = {gi, el: g};
      }
      const d = document.createElement('span');
      d.className = 'ui-beat-lamp';
      d.dataset.kind = dot.kind;
      d.dataset.state = 'next';
      current.el.append(d);
      dotEls[i] = d;
    });
    el.replaceChildren(...groupEls);
    states = dotEls.map(() => 'next');
    litDot = -1;
    litGroup = -1;
    litUnit = -1;
    flashDot = -1;
    el.dataset.mode = layout.mode;
    el.dataset.units = String(layout.units);
  }

  function set(partial = {}) {
    const prev = props;
    props = {...prev, ...partial};
    applyCommon(el, props, prev);
    const next = lampLayout(props.units, props.groups);
    const key = `${next.units}:${next.groups.join('+')}`;
    if (key !== built) {
      layout = next;
      built = key;
      build();
    }
    el.dataset.size = props.size === 'sm' ? 'sm' : 'md';
  }

  function dotFor(unitIndex, group) {
    if (group < 0) return -1;
    if (layout.mode === 'groups') return group;
    return unitIndex;
  }

  function writeState(i, state) {
    if (states[i] === state) return;
    states[i] = state;
    dotEls[i].dataset.state = state;
  }

  function flash(i) {
    if (flashDot >= 0 && flashDot !== i && dotEls[flashDot]) delete dotEls[flashDot].dataset.flash;
    // Alternate the animation name so a repeat on the same dot restarts it.
    flashPhase = flashPhase === 1 ? 2 : 1;
    if (dotEls[i]) dotEls[i].dataset.flash = String(flashPhase);
    flashDot = i;
  }

  /** Per tick: lights the dot for `unitIndex` (see the header for `groupStart`). */
  function frame(unitIndex, groupStart) {
    const u = typeof unitIndex === 'number' && unitIndex >= 0 && unitIndex < layout.units ? Math.floor(unitIndex) : -1;
    let group = groupOfUnit(layout.starts, layout.units, u);
    if (typeof groupStart === 'number' && groupStart >= 0) {
      const gi = layout.starts.indexOf(groupStart);
      if (gi >= 0) group = gi;
    }
    const target = dotFor(u, group);
    const wrapped = group >= 0 && u === layout.starts[group] && u !== litUnit;
    const onset = groupStart === true || (group >= 0 && (group !== litGroup || wrapped));
    if (target !== litDot) {
      if (target < 0) {
        for (let i = 0; i < dotEls.length; i++) writeState(i, 'next');
      } else {
        // Usually one or two writes: the previous lit dot becomes past, the new one now.
        for (let i = 0; i < dotEls.length; i++) writeState(i, i < target ? 'past' : i === target ? 'now' : 'next');
      }
      litDot = target;
    }
    if (target >= 0 && onset) {
      const beatDot = layout.mode === 'groups' ? group : layout.starts[group];
      flash(beatDot);
    }
    if (target < 0 && flashDot >= 0) {
      if (dotEls[flashDot]) delete dotEls[flashDot].dataset.flash;
      flashDot = -1;
    }
    litGroup = target < 0 ? -1 : group;
    litUnit = target < 0 ? -1 : u;
  }

  function destroy() {
    el.remove();
  }

  set({size: 'md', ...initial});
  return {
    el, set, frame, destroy,
    get mode() { return layout.mode; },
    get dots() { return dotEls.length; },
  };
}
