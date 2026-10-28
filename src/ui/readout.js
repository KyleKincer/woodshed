// Readout: a Stage readout (architecture §2.12 and §4.4, spec §4.3 and §8.1).
//
//   const r = Readout({label, value, sub, size, tone = 'ink', mono = false, minCh, subMinCh, ...common})
//     label     the readout's accessible name ('Position', 'Speed'): a role=group labelled by it
//     value     the main text ('13 · 2', '75%', 'Chorus'); a number is shown as is
//     sub       an optional second line in --ink-3 ('0:26 / 1:04', '84 bpm'); hidden when empty
//     size      'identity'|'sub'|'loop'|'section'|'speed'|'position'|'count': the font size is the
//               matching --fs-stage-* token, so it scales with Distance and the rail/band layout
//     tone      'ink' | 'ink-3' | 'now' (the value's colour; Speed at exactly 100% is ink-3)
//     mono      the value in --font-mono (Position, Speed, count-in, times)
//     minCh     a fixed min-width for the value in ch, so changing digits never jitter the layout
//     subMinCh  the same for the sub line
//   r.set(partial) · r.destroy() · r.el (div.ui-readout)
//
// Numerals are always tabular. set() writes text nodes only when the text changed, so the HUD
// can call it every frame (≤ 30 Hz) cheaply. Readouts never animate their numerals.

import '../styles/primitives/readout.css';

export const READOUT_SIZES = Object.freeze(['identity', 'sub', 'loop', 'section', 'speed', 'position', 'count']);
export const READOUT_TONES = Object.freeze(['ink', 'ink-3', 'now']);
const EMPTY = Object.freeze({});
const DEV = !!import.meta.env?.DEV;

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

const textOf = v => (v == null || v === false ? '' : String(v));
const chOf = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? `${v}ch` : '');

export function Readout(initial = {}) {
  const el = document.createElement('div');
  el.className = 'ui-readout';
  const valueEl = document.createElement('span');
  valueEl.className = 'ui-readout-value';
  const valueText = document.createTextNode('');
  valueEl.append(valueText);
  const subEl = document.createElement('span');
  subEl.className = 'ui-readout-sub';
  const subText = document.createTextNode('');
  subEl.append(subText);
  subEl.hidden = true;
  el.append(valueEl, subEl);
  let props = EMPTY;

  function set(partial = {}) {
    const prev = props;
    props = {...prev, ...partial};
    applyCommon(el, props, prev);

    const value = textOf(props.value);
    if (valueText.data !== value) valueText.data = value;
    const sub = textOf(props.sub);
    if (subText.data !== sub) subText.data = sub;
    if (subEl.hidden !== !sub) subEl.hidden = !sub;

    if (props.label !== prev.label) {
      if (props.label) { el.setAttribute('role', 'group'); el.setAttribute('aria-label', String(props.label)); }
      else { el.removeAttribute('role'); el.removeAttribute('aria-label'); }
    }
    if (props.size !== prev.size) {
      if (DEV && props.size != null && !READOUT_SIZES.includes(props.size)) throw new Error(`Readout: unknown size "${props.size}"`);
      if (props.size) el.dataset.size = props.size; else delete el.dataset.size;
    }
    if (props.tone !== prev.tone) {
      if (DEV && props.tone != null && !READOUT_TONES.includes(props.tone)) throw new Error(`Readout: unknown tone "${props.tone}"`);
      el.dataset.tone = props.tone ?? 'ink';
    }
    if (!!props.mono !== !!prev.mono || prev === EMPTY) { if (props.mono) el.dataset.mono = ''; else delete el.dataset.mono; }
    if (props.minCh !== prev.minCh) {
      const w = chOf(props.minCh);
      if (w) valueEl.style.minWidth = w; else valueEl.style.removeProperty('min-width');
    }
    if (props.subMinCh !== prev.subMinCh) {
      const w = chOf(props.subMinCh);
      if (w) subEl.style.minWidth = w; else subEl.style.removeProperty('min-width');
    }
  }

  function destroy() {
    el.remove();
  }

  set({tone: 'ink', mono: false, ...initial});
  return {el, set, destroy};
}
