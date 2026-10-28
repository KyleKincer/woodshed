// Tabs: a roving-tabindex tablist (architecture §2.12, spec §5.0 and §6.2).
//
//   const t = Tabs({tabs: [{id, label, href?, controls?, disabled?}], value, onChange(id, {source}),
//                   variant: 'posture'|'section', label, activation: 'manual'|'auto', ...common})
//     tabs        each a role=tab: an <a> when it has href (the router handles the link), else a <button>
//     controls    the id of the panel the tab controls (aria-controls); panels use t.tabId(id) for
//                 aria-labelledby
//     value       the selected tab id
//     onChange    called when the user picks another tab: source 'pointer' | 'keyboard'
//     variant     'posture' (Edit's Map · Chart · Details) or 'section' (Settings, Jobs); data-variant
//     label       the tablist's aria-label
//     activation  'manual' (default): arrows move focus, Enter/Space or a click selects (a heavy panel
//                 never loads per arrow press); 'auto': arrows also select
//   t.set(partial) · t.destroy() · t.focus() · t.tabId(id) · t.el (div[role=tablist])
//
// Keys handled on the tablist itself (it declares data-consume-keys, so the dispatcher leaves them
// native): ArrowLeft/ArrowRight move with wrap-around, Home/End go to the ends; disabled tabs are
// skipped. Enter (and Space, unless the posture's registry took it, D35) selects. The selected tab
// is the only one in the tab order.
// Tab labels are required (the factory throws in dev without one).

import '../styles/primitives/tabs.css';
import {reconcileList} from './h.js';

export const TAB_KEYS = Object.freeze(['ArrowLeft', 'ArrowRight', 'Home', 'End']);
const EMPTY = Object.freeze({});
const DEV = !!import.meta.env?.DEV;
let seq = 0;

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

const safeId = id => String(id).replace(/[^\w-]/g, '_');

export function Tabs(initial = {}) {
  const el = document.createElement('div');
  el.className = 'ui-tabs';
  el.setAttribute('role', 'tablist');
  el.setAttribute('aria-orientation', 'horizontal');
  el.setAttribute('data-consume-keys', TAB_KEYS.join(' '));
  const base = `ui-tabs-${++seq}`;
  let props = EMPTY;
  const nodes = new Map();   // id → element
  const ids = new WeakMap(); // element → id (the caller's value, which may be a number)

  const tabId = id => `${props.id || base}-tab-${safeId(id)}`;
  const tabsOf = () => (Array.isArray(props.tabs) ? props.tabs : []);
  const enabled = () => tabsOf().filter(t => !t.disabled);

  function select(id, source) {
    if (id === props.value) return;
    const tab = tabsOf().find(t => t.id === id);
    if (!tab || tab.disabled) return;
    props = {...props, value: id};
    sync();
    props.onChange?.(id, {source});
  }

  function create(tab) {
    const node = document.createElement(tab.href ? 'a' : 'button');
    if (!tab.href) node.type = 'button';
    node.className = 'ui-tab';
    node.setAttribute('role', 'tab');
    node.dataset.tab = String(tab.id);
    ids.set(node, tab.id);
    const text = document.createElement('span');
    text.className = 'ui-tab-label';
    node.append(text);
    node.addEventListener('click', e => {
      const id = ids.get(node);
      const t = tabsOf().find(x => x.id === id);
      if (!t || t.disabled) { e.preventDefault(); return; }
      // A modified click on a link opens it elsewhere; leave that to the browser.
      if (t.href && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button > 0)) return;
      if (t.href && props.onChange) e.preventDefault();
      select(t.id, e.detail === 0 ? 'keyboard' : 'pointer');
    });
    const entry = {el: node, update: t => paint(node, t)};
    paint(node, tab);
    nodes.set(tab.id, node);
    return entry;
  }

  function paint(node, tab) {
    if (DEV && !String(tab.label ?? '').trim()) throw new Error(`Tabs: tab "${tab.id}" needs a label`);
    const label = node.firstChild;
    if (label.textContent !== String(tab.label)) label.textContent = String(tab.label);
    node.id = tabId(tab.id);
    if (tab.href) node.setAttribute('href', tab.href); else node.removeAttribute('href');
    if (tab.controls) node.setAttribute('aria-controls', tab.controls); else node.removeAttribute('aria-controls');
    if (tab.disabled) node.setAttribute('aria-disabled', 'true'); else node.removeAttribute('aria-disabled');
  }

  function sync() {
    const tabs = tabsOf();
    for (const id of [...nodes.keys()]) if (!tabs.some(t => t.id === id)) nodes.delete(id);
    // A tab that gains or loses its href changes element (a ↔ button), so the kind is in the key.
    reconcileList(el, tabs, {key: t => `${t.href ? 'a' : 'b'}:${String(t.id)}`, create});
    // Exactly one tab is in the tab order: the selected one, else the first enabled one.
    const selected = tabs.find(t => t.id === props.value && !t.disabled);
    const rover = selected ?? enabled()[0];
    for (const tab of tabs) {
      const node = nodes.get(tab.id);
      if (!node) continue;
      const on = tab.id === props.value;
      node.setAttribute('aria-selected', on ? 'true' : 'false');
      node.tabIndex = rover && tab.id === rover.id ? 0 : -1;
    }
    if (props.variant) el.dataset.variant = props.variant; else delete el.dataset.variant;
    if (props.label) el.setAttribute('aria-label', props.label); else el.removeAttribute('aria-label');
  }

  function focusTab(id) {
    const node = nodes.get(id);
    if (!node) return;
    for (const [other, n] of nodes) n.tabIndex = other === id ? 0 : -1;
    node.focus();
  }

  el.addEventListener('keydown', e => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // A link tab does not activate on Space natively; a button tab does.
    if (e.key === ' ' && !e.defaultPrevented && e.target.matches?.('a[role=tab]')) { e.preventDefault(); e.target.click(); return; }
    if (!TAB_KEYS.includes(e.key)) return;
    const list = enabled();
    if (!list.length) return;
    const from = e.target.closest?.('[role=tab]');
    const current = from ? ids.get(from) : undefined;
    let i = from && ids.has(from) ? list.findIndex(t => t.id === current) : -1;
    if (i < 0) i = Math.max(0, list.findIndex(t => t.id === props.value));
    let next;
    switch (e.key) {
      case 'ArrowLeft': next = list[(i - 1 + list.length) % list.length]; break;
      case 'ArrowRight': next = list[(i + 1) % list.length]; break;
      case 'Home': next = list[0]; break;
      case 'End': next = list[list.length - 1]; break;
    }
    e.preventDefault();
    if (!next) return;
    focusTab(next.id);
    if (props.activation === 'auto') select(next.id, 'keyboard');
  });

  function set(partial = {}) {
    const prev = props;
    props = {...prev, ...partial};
    applyCommon(el, props, prev);
    if (props.id !== prev.id) for (const tab of tabsOf()) { const n = nodes.get(tab.id); if (n) n.id = tabId(tab.id); }
    sync();
  }

  function destroy() {
    el.remove();
  }

  set({tabs: [], value: null, variant: 'section', activation: 'manual', ...initial});
  return {
    el, set, destroy,
    tabId,
    /** Focuses the selected (or first enabled) tab. */
    focus() { const t = tabsOf().find(x => x.id === props.value && !x.disabled) ?? enabled()[0]; if (t) nodes.get(t.id)?.focus(); },
  };
}
