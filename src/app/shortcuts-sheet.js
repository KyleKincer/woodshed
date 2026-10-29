// The `?` shortcut sheet (architecture §2.8, spec §7.2): generated from the command registry, the active scope chain's
// bindings first.
//
//   openShortcuts({registry, chain} = {}) → {close(), el, get open}
//     A modal overlay (a native <dialog> on the dispatcher's overlay stack, D36): centred and up to 880 px wide, or a
//     full-height sheet in the band layout and on narrow screens. `chain` defaults to dispatch.activeScopeChain(), read
//     before the sheet opens. "Here" lists every binding the chain resolves now (commands whose `when` fails are left
//     out), grouped by command group in SHEET_GROUPS order; "Elsewhere" lists the other scopes' bindings, one block per
//     scope. A key an inner scope of the chain takes first is marked on the outer command as shadowed ("here: <inner
//     command>"), and a key a stop scope in the chain blocks (D45) is marked "not while <scope>". Labels come from
//     keys.label() through Kbd. Esc, ✕, a tap on the backdrop or `?` close it; the filter field narrows the rows. While
//     it is open a registry or state change (registry.onChange) rebuilds the rows for the same chain, keeping the filter.
//   shortcutModel({registry, chain, ctx}) → {chain, here: {label, groups}, elsewhere: [{scope, label, groups}]}   (pure over the registry)
//     groups: [{group, rows: [{id, title, group, scope, keys: KeyString[], shadowed: [{key, by: {id, title, scope}}],
//                              blocked: [{key, scope}]}]}]
//   SHEET_GROUPS — the sheet's group order (the registry's GROUPS; registry CI compares them).

import {GROUPS, registry as appRegistry} from './commands.js';
import {activeScopeChain, pushOverlay} from './dispatch.js';
import {label as keyLabel} from './keys.js';
import {store as appStore} from './store.js';
import {h} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {Kbd} from '../ui/kbd.js';
import {closeAllMenus} from '../ui/menu.js';
import {layerHost, pushModalHost, restoreFocus, trackLayer, trapTab} from '../ui/popover.js';
import '../styles/views/app/shortcuts.css';

export const SHEET_GROUPS = GROUPS;
export const SCOPE_LABELS = Object.freeze({
  global: 'Everywhere',
  stage: 'Stage',
  'stage.stems': 'Stems view',
  'stage.strip': 'Song strip (focused)',
  'stage.bars': 'Bar list (focused)',
  edit: 'Edit',
  'edit.map': 'Edit · Map',
  'edit.chart': 'Edit · Chart',
  'edit.chart.score': 'Score (focused)',
  'edit.details': 'Edit · Details',
  library: 'Library',
  settings: 'Settings',
  admin: 'Administration',
});
export const SCOPE_ORDER = Object.freeze(['global', 'stage', 'stage.stems', 'stage.strip', 'stage.bars', 'edit', 'edit.map',
  'edit.chart', 'edit.chart.score', 'edit.details', 'library', 'settings', 'admin']);
export const BAND_WIDTH = 720;

export const scopeLabel = scope => SCOPE_LABELS[scope] ?? scope;

function scopeRank(scope) {
  const i = SCOPE_ORDER.indexOf(scope);
  return i < 0 ? SCOPE_ORDER.length : i;
}

/** Every [key, defs] bound in a scope. */
function bindingsIn(reg, scope) {
  return [...reg.bindingsFor(scope).keys()].map(key => [key, reg.defsFor(scope, key)]);
}

function titleOf(reg, def, ctx) {
  const title = reg.titleFor(def.id, ctx);
  return title || def.menu?.label || '';
}

function grouped(rows) {
  const byGroup = new Map();
  for (const row of rows) {
    if (!byGroup.has(row.group)) byGroup.set(row.group, []);
    byGroup.get(row.group).push(row);
  }
  const order = g => {
    const i = SHEET_GROUPS.indexOf(g);
    return i < 0 ? SHEET_GROUPS.length : i;
  };
  return [...byGroup.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([group, list]) => ({group, rows: list}));
}

/** The sheet's content. See the header. */
export function shortcutModel({registry = appRegistry, chain = activeScopeChain(), ctx = registry.context({source: 'shortcuts'})} = {}) {
  const rows = new Map();          // id → row (Here)
  const winners = new Map();       // key → {id, title, scope}: what the key does here
  const stops = [];                // stop scopes met so far in the chain
  for (const scope of chain) {
    for (const [key, defs] of bindingsIn(registry, scope)) {
      for (const def of defs) {
        if (!registry.passes(def, ctx)) continue;
        const title = titleOf(registry, def, ctx);
        if (!title) continue;
        let row = rows.get(def.id);
        if (!row) rows.set(def.id, row = {id: def.id, title, group: def.group, scope, keys: [], shadowed: [], blocked: []});
        const winner = winners.get(key);
        const stop = stops.find(s => !s.passThrough.includes(key));
        if (winner && winner.id !== def.id) row.shadowed.push({key, by: winner});
        else if (!winner && stop) row.blocked.push({key, scope: stop.name});
        else if (!winner) {
          winners.set(key, {id: def.id, title, scope});
          if (!row.keys.includes(key)) row.keys.push(key);
        }
      }
    }
    const scopeDef = registry.getScope(scope);
    if (scopeDef?.stop) stops.push(scopeDef);
  }
  // Row keys follow the definition's own order.
  for (const row of rows.values()) {
    const def = registry.get(row.id);
    row.keys.sort((a, b) => def.keys.indexOf(a) - def.keys.indexOf(b));
  }

  const elsewhere = registry.boundScopes()
    .filter(scope => !chain.includes(scope))
    .sort((a, b) => scopeRank(a) - scopeRank(b) || a.localeCompare(b))
    .map(scope => {
      const list = new Map();
      for (const [key, defs] of bindingsIn(registry, scope)) {
        for (const def of defs) {
          const title = titleOf(registry, def, ctx);
          if (!title) continue;
          let row = list.get(def.id);
          if (!row) list.set(def.id, row = {id: def.id, title, group: def.group, scope, keys: [], shadowed: [], blocked: []});
          if (!row.keys.includes(key)) row.keys.push(key);
        }
      }
      for (const row of list.values()) {
        const def = registry.get(row.id);
        row.keys.sort((a, b) => def.keys.indexOf(a) - def.keys.indexOf(b));
      }
      return {scope, label: scopeLabel(scope), groups: grouped([...list.values()])};
    })
    .filter(block => block.groups.length);

  const named = chain.filter(s => s !== 'global').map(scopeLabel);
  return {
    chain: [...chain],
    here: {label: named.length ? named.join(' · ') : scopeLabel('global'), groups: grouped([...rows.values()])},
    elsewhere,
  };
}

/** 'band' (a full-height sheet) in the Stage's band layout or on a narrow screen, else 'center'. Pure. */
export function sheetLayout({stageLayout = null, width = Infinity} = {}) {
  return stageLayout === 'band' || width < BAND_WIDTH ? 'band' : 'center';
}

// ---------------------------------------------------------------------------------------------------------------
// The overlay

let openHandle = null;
let sheetSeq = 0;

function keyText(keys) {
  return keys.map(k => keyLabel(k)).join(' ');
}

// Every Kbd holds a matchMedia listener until destroy(), so the caps a render makes are collected in `made`.
function capEl(made, key) {
  const k = Kbd({keys: key, force: true});
  made.push(k);
  return k.el;
}

function renderRow(row, made) {
  const caps = [];
  for (const key of row.keys) caps.push(h('span', {class: 'app-shortcuts-key'}, capEl(made, key)));
  for (const {key, by} of row.shadowed) {
    caps.push(h('span', {class: 'app-shortcuts-key', dataset: {shadowed: ''}},
      h('span', {class: 'sr-only'}, 'Shadowed: '), capEl(made, key),
      h('span', {class: 'app-shortcuts-note'}, `here: ${by.title}`)));
  }
  for (const {key, scope} of row.blocked) {
    caps.push(h('span', {class: 'app-shortcuts-key', dataset: {blocked: ''}},
      h('span', {class: 'sr-only'}, 'Unavailable: '), capEl(made, key),
      h('span', {class: 'app-shortcuts-note'}, `not while ${scopeLabel(scope).replace(/ \(focused\)$/, '').toLowerCase()} has focus`)));
  }
  const allKeys = [...row.keys, ...row.shadowed.map(s => s.key), ...row.blocked.map(b => b.key)];
  return h('li', {
    class: 'app-shortcuts-row',
    dataset: {commandId: row.id, filter: `${row.title} ${keyText(allKeys)}`.toLowerCase(),
      ...(row.shadowed.length ? {shadowed: ''} : {}), ...(row.blocked.length ? {blocked: ''} : {})},
  },
  h('span', {class: 'app-shortcuts-name'}, row.title),
  h('span', {class: 'app-shortcuts-keys'}, ...caps));
}

function renderGroups(groups, idPrefix, made) {
  return h('div', {class: 'app-shortcuts-groups'}, ...groups.map(({group, rows}) => {
    const id = `${idPrefix}-${group.toLowerCase()}`;
    // A labelled group, not a landmark: only the scope sections are regions (their names are unique),
    // whereas group names such as "Transport" repeat from scope to scope (axe landmark-unique).
    return h('div', {class: 'app-shortcuts-group', role: 'group', 'aria-labelledby': id, dataset: {group}},
      h('h4', {class: 'app-shortcuts-group-title', id}, group),
      h('ul', {class: 'app-shortcuts-rows'}, ...rows.map(row => renderRow(row, made))));
  }));
}

/** Opens the sheet (or returns the open one). See the header. */
export function openShortcuts({registry = appRegistry, chain} = {}) {
  if (openHandle?.open) return openHandle;
  const doc = globalThis.document;
  const seq = ++sheetSeq;
  const previous = doc.activeElement;
  const scopeChain = chain ?? activeScopeChain();
  let model = shortcutModel({registry, chain: scopeChain});
  const stageLayout = appStore.stage.peek()?.layout ?? doc.querySelector('[data-stage-layout]')?.getAttribute('data-stage-layout') ?? null;
  const layout = sheetLayout({stageLayout, width: doc.defaultView?.innerWidth ?? Infinity});
  const ids = {title: `app-shortcuts-${seq}-title`, here: `app-shortcuts-${seq}-here`, filter: `app-shortcuts-${seq}-filter`};

  const closeButton = h('button', {type: 'button', class: 'app-shortcuts-close', 'aria-label': 'Close'}, icon('x'));
  const filter = h('input', {id: ids.filter, class: 'app-shortcuts-filter', type: 'search', autocomplete: 'off', spellcheck: false,
    placeholder: 'Filter shortcuts'});
  const empty = h('p', {class: 'app-shortcuts-empty', hidden: true}, 'No shortcuts match.');
  const body = h('div', {class: 'app-shortcuts-body', tabIndex: 0, role: 'region', 'aria-labelledby': ids.title});
  const sub = h('p', {class: 'app-shortcuts-sub'});
  let caps = [];
  // (Re)builds the Here and Elsewhere sections from `model`, destroying the previous render's key-caps.
  const renderBody = () => {
    const made = [];
    const hereSection = h('section', {class: 'app-shortcuts-section', 'aria-labelledby': ids.here, dataset: {section: 'here'}},
      h('h3', {class: 'app-shortcuts-section-title', id: ids.here}, `Here: ${model.here.label}`),
      model.here.groups.length ? renderGroups(model.here.groups, `app-shortcuts-${seq}-here`, made)
        : h('p', {class: 'app-shortcuts-none'}, 'No keyboard shortcuts here.'));
    const elsewhere = model.elsewhere.map((block, i) => {
      const id = `app-shortcuts-${seq}-s${i}`;
      return h('section', {class: 'app-shortcuts-section', 'aria-labelledby': id, dataset: {section: 'elsewhere', scope: block.scope}},
        h('h3', {class: 'app-shortcuts-section-title', id}, block.label),
        renderGroups(block.groups, id, made));
    });
    for (const k of caps) k.destroy();
    caps = made;
    body.replaceChildren(hereSection,
      ...(elsewhere.length ? [h('h3', {class: 'app-shortcuts-elsewhere'}, 'Elsewhere')] : []),
      ...elsewhere, empty);
    sub.textContent = `${model.here.label} first`;
  };
  const header = h('header', {class: 'app-shortcuts-header'},
    h('div', {class: 'app-shortcuts-heading'},
      h('h2', {class: 'app-shortcuts-title', id: ids.title}, 'Keyboard shortcuts'), sub),
    closeButton);
  const filterRow = h('div', {class: 'app-shortcuts-filter-row'},
    h('label', {class: 'sr-only', for: ids.filter}, 'Filter shortcuts'), icon('search', {size: 20}), filter);
  const box = h('div', {class: 'app-shortcuts-box'}, header, filterRow, body);
  const el = h('dialog', {class: 'app-shortcuts', 'aria-labelledby': ids.title, dataset: {layout}}, box);

  let open = true;
  const cleanups = [];

  function close(reason = 'close') {
    if (!open) return;
    open = false;
    for (const fn of cleanups.splice(0).reverse()) fn();
    for (const k of caps.splice(0)) k.destroy();
    if (el.open) el.close();
    el.remove();
    restoreFocus(previous, el);
    if (openHandle === handle) openHandle = null;
    el.dataset.closed = reason;
  }

  const applyFilter = () => {
    const q = filter.value.trim().toLowerCase();
    let any = false;
    for (const section of body.querySelectorAll('.app-shortcuts-section')) {
      let sectionAny = false;
      for (const group of section.querySelectorAll('.app-shortcuts-group')) {
        let groupAny = false;
        for (const row of group.querySelectorAll('.app-shortcuts-row')) {
          const show = !q || row.dataset.filter.includes(q);
          row.hidden = !show;
          groupAny ||= show;
        }
        group.hidden = !groupAny;
        sectionAny ||= groupAny;
      }
      const none = section.querySelector('.app-shortcuts-none');
      section.hidden = q ? !sectionAny : false;
      if (none) none.hidden = !!q;
      any ||= sectionAny;
    }
    const heading = body.querySelector('.app-shortcuts-elsewhere');
    if (heading) heading.hidden = !!q && ![...body.querySelectorAll('[data-section=elsewhere]')].some(s => !s.hidden);
    empty.hidden = !q || any;
  };

  closeButton.addEventListener('click', () => close('close'));
  filter.addEventListener('input', applyFilter);
  el.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close('escape'); return; }
    if (e.key === '?' && e.target !== filter && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); close('toggle'); }
  });
  el.addEventListener('cancel', e => { e.preventDefault(); close('escape'); });
  el.addEventListener('click', e => { if (e.target === el) close('outside'); });

  renderBody();
  const handle = {el, get model() { return model; }, get open() { return open; }, close: () => close('close')};
  openHandle = handle;

  closeAllMenus('dialog');
  layerHost(doc).append(el);
  el.showModal();
  cleanups.push(pushModalHost(el), trackLayer(el), trapTab(el));
  cleanups.push(pushOverlay({el, modal: true, scope: 'shortcuts', onEscape: () => close('escape')}));
  // Registry or enablement changes (a song finishes loading, a surface registers its bindings) re-render the rows for
  // the same scope chain, keeping the filter.
  cleanups.push(registry.onChange(change => {
    if (!open || (change?.type !== 'registry' && change?.type !== 'state')) return;
    model = shortcutModel({registry, chain: scopeChain});
    renderBody();
    applyFilter();
  }));
  el.__uiClose = reason => close(reason);
  body.focus({preventScroll: true});
  return handle;
}
