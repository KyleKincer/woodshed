// Skeleton (architecture §2.12, spec §2.7 "an 8-card skeleton in the new geometry", §4.12
// "a bar grid with shimmering cells").
//
//   const s = Skeleton({shape: 'card'|'row'|'text'|'cell', count = 1, label, ...common})
//     shape  card: a square cover and two lines (the Library grid card)
//            row:  a small cover and two lines (the list row, Jobs rows)
//            text: one line of text (varying widths)
//            cell: a bar-grid cell (Road map loading)
//     count  how many placeholders (an integer ≥ 0)
//     label  optional: a polite role=status "Loading…" text for assistive tech; without it the
//            skeleton is decorative (aria-hidden) and the region it fills should carry aria-busy
//   s.set(partial) · s.destroy() · s.el (div.ui-skeleton)
//
// The shimmer is CSS only and stops under reduced motion (a static tint).

import '../styles/primitives/skeleton.css';

export const SKELETON_SHAPES = Object.freeze(['card', 'row', 'text', 'cell']);
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

const block = cls => {
  const d = document.createElement('div');
  d.className = `ui-skeleton-block ${cls}`;
  return d;
};

function placeholder(shape, i) {
  const item = document.createElement('div');
  item.className = 'ui-skeleton-item';
  if (shape === 'card' || shape === 'row') {
    const lines = document.createElement('div');
    lines.className = 'ui-skeleton-lines';
    lines.append(block('ui-skeleton-line'), block('ui-skeleton-line ui-skeleton-line-short'));
    item.append(block('ui-skeleton-cover'), lines);
  } else if (shape === 'text') {
    // Widths cycle so a paragraph of lines does not look like a table.
    item.append(block(`ui-skeleton-line ui-skeleton-w${i % 3}`));
  } else {
    item.append(block('ui-skeleton-cell'));
  }
  return item;
}

export function Skeleton(initial = {}) {
  const el = document.createElement('div');
  el.className = 'ui-skeleton';
  const status = document.createElement('span');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  let props = EMPTY;
  let built = '';

  function set(partial = {}) {
    const prev = props;
    props = {...prev, ...partial};
    applyCommon(el, props, prev);
    let shape = props.shape;
    if (!SKELETON_SHAPES.includes(shape)) {
      if (DEV && shape != null) throw new Error(`Skeleton: unknown shape "${shape}"`);
      shape = 'text';
    }
    const count = Math.max(0, Math.floor(Number(props.count) || 0));
    el.dataset.shape = shape;
    const key = `${shape}|${count}`;
    if (key !== built) {
      el.replaceChildren(...Array.from({length: count}, (_, i) => placeholder(shape, i)));
      built = key;
    }
    if (props.label) {
      status.textContent = String(props.label);
      el.prepend(status);
      el.removeAttribute('aria-hidden');
    } else {
      status.remove();
      el.setAttribute('aria-hidden', 'true');
    }
  }

  function destroy() {
    el.remove();
  }

  set({shape: 'text', count: 1, ...initial});
  return {el, set, destroy};
}
