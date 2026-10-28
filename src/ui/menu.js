// Menu (architecture §2.12, spec §7.7): the one menu primitive, for the ⋯ buttons, card and row context menus and the
// Stage's bar, section, spot, marker, loop-band and stem menus.
//
//   Menu({items, anchor, placement = 'bottom', label, onClose, presentation = 'auto', registry,
//         className, id, attrs, dataset, testid})
//     → {el, set(partial), close(reason = 'close'), destroy(), get open, get presentation, sheet}
//   Menu.open(items, opts) → the same handle
//   bindContextMenu(el, getItems, {label, placement, registry, presentation, onOpen}) → off
//   closeAllMenus(reason = 'dismiss')       Dialog calls it: opening a Dialog closes open menus
//
//   MenuItem = {id?, label, kbd?, command?, icon?, type: 'item'|'checkbox'|'radio'|'separator'|'submenu', checked?,
//               items?, disabled?, reason?, danger?, run?, args?}
//   A `command` item takes its label (def.menu.label, else the title), key-cap (keys[0]), enabled state, checked state
//   and disabled reason from the registry (`registry.state(id)`), and follows registry changes while the menu is open;
//   an item's own label, kbd, icon, type and checked win. `reason` is a visible disabled reason (aria-describedby).
//   Activating an item closes the menu, returns focus, then runs the command (`registry.run(id, {source, args, event})`,
//   source 'key' or 'pointer') and the item's `run({item, event, source})`.
//
// Behaviour: role=menu with roving focus (↑ ↓ Home End, wrapping), type-ahead, Enter/Space activate, → opens a submenu
// and ← closes it, Esc closes the innermost level (through the dispatcher's overlay stack: menus are modal overlays,
// D36), Tab closes the menu, a pointer-down outside closes it. On coarse pointers (`presentation: 'auto'`) the menu is a
// modal bottom sheet with 56 px rows and submenus open in place with a Back row. Fine pointers get an anchored popover
// (CSS anchor positioning or place()); a submenu opens to the right of its row.
//
// bindContextMenu (cards, rows and chrome; music surfaces use src/stage/press.js, D50) opens getItems(event) on
// right-click (at the pointer), a 500 ms touch or pen long-press (at the press point; the click that follows is
// swallowed), Shift+F10 and the ContextMenu key (below the focused element). getItems returning null or [] leaves the
// browser's own context menu alone.

import {registry as appRegistry} from '../app/commands.js';
import {pushOverlay} from '../app/dispatch.js';
import {aria as keyAria, label as keyLabel} from '../app/keys.js';
import {h} from './h.js';
import {anchorTo} from './position.js';
import {applyCommon, glyph, hideLayer, onOutside, showLayer, withDefaults} from './popover.js';
import {Sheet} from './sheet.js';
import '../styles/primitives/menu.css';

export const LONG_PRESS_MS = 500;
export const TYPEAHEAD_MS = 500;
export const MOVE_TOLERANCE_PX = 10;
const CONSUMED_KEYS = 'ArrowUp ArrowDown ArrowLeft ArrowRight Home End Enter Space';
const ROLE = {item: 'menuitem', submenu: 'menuitem', checkbox: 'menuitemcheckbox', radio: 'menuitemradio'};
const TYPES = new Set(['item', 'checkbox', 'radio', 'separator', 'submenu']);

const openMenus = new Set();

/** Closes every open menu (Dialog calls this when it opens). */
export function closeAllMenus(reason = 'dismiss') {
  for (const menu of [...openMenus]) menu.close(reason);
}

const isElement = v => !!v && typeof v === 'object' && v.nodeType === 1;
const isCoarse = win => !!win?.matchMedia?.('(pointer: coarse)')?.matches;

/** The display model of a MenuItem, with command items resolved through `registry`. Pure apart from the registry read. */
export function resolveItem(item, registry = appRegistry) {
  if (!item || typeof item !== 'object') throw new TypeError('Menu: every item must be an object');
  if (item.type === 'separator') return {type: 'separator'};
  if (item.type != null && !TYPES.has(item.type)) throw new RangeError(`Menu: unknown item type ${JSON.stringify(item.type)}`);
  const def = item.command ? registry.get(item.command) : null;
  const state = item.command ? registry.state(item.command) : null;
  const type = item.type ?? (item.items ? 'submenu' : state && state.checked !== undefined ? (def?.menu?.radio ? 'radio' : 'checkbox') : 'item');
  if (type === 'submenu' && !Array.isArray(item.items)) throw new TypeError('Menu: a submenu item needs items');
  const label = item.label ?? def?.menu?.label ?? state?.title ?? item.command ?? '';
  if (!String(label).trim()) throw new TypeError('Menu: every item needs a label');
  const reason = item.reason ?? state?.reason ?? null;
  const unknownCommand = !!item.command && !state;
  const disabled = !!item.disabled || !!reason || unknownCommand || (state ? !state.enabled : false);
  return {
    type,
    label: String(label),
    kbd: item.kbd ?? def?.keys?.[0] ?? null,
    icon: item.icon ?? def?.icon ?? null,
    checked: type === 'checkbox' || type === 'radio' ? !!(item.checked ?? state?.checked) : undefined,
    disabled,
    reason: reason ? String(reason) : null,
    danger: !!item.danger,
    items: type === 'submenu' ? item.items : null,
    command: item.command ?? null,
  };
}

let menuSeq = 0;

/** Opens a menu. See the header. */
export function Menu(props = {}) {
  let p = withDefaults({placement: 'bottom', presentation: 'auto', registry: appRegistry}, props);
  if (!Array.isArray(p.items)) throw new TypeError('Menu: items must be an array');
  if (!p.anchor) throw new TypeError('Menu: an anchor (element or {x, y}) is required');
  const reg = p.registry;
  const doc = isElement(p.anchor) ? p.anchor.ownerDocument : globalThis.document;
  const win = doc.defaultView;
  const presentation = p.presentation === 'auto' ? (isCoarse(win) ? 'sheet' : 'popover') : p.presentation;
  if (presentation !== 'sheet' && presentation !== 'popover') throw new RangeError(`Menu: unknown presentation ${JSON.stringify(presentation)}`);
  const previous = doc.activeElement;
  const seq = ++menuSeq;
  const info = new WeakMap();      // row element → {level, index} (index 'back' for the Back row)
  let open = true;
  let sheet = null;
  let offOutside = null;
  let typeahead = {text: '', timer: null};

  // ------------------------------------------------------------------ levels
  function renderRow(row, level, r) {
    row.className = 'ui-menu-item';
    row.tabIndex = -1;
    row.dataset.type = r.type;
    if (r.danger) row.dataset.danger = ''; else delete row.dataset.danger;
    row.setAttribute('role', ROLE[r.type]);
    if (r.disabled) row.setAttribute('aria-disabled', 'true'); else row.removeAttribute('aria-disabled');
    if (r.checked !== undefined) row.setAttribute('aria-checked', String(r.checked)); else row.removeAttribute('aria-checked');
    if (r.type === 'submenu') {
      row.setAttribute('aria-haspopup', 'menu');
      row.setAttribute('aria-expanded', String(level.child?.parentIndex === info.get(row)?.index));
    } else {
      row.removeAttribute('aria-haspopup');
      row.removeAttribute('aria-expanded');
    }
    if (r.kbd) row.setAttribute('aria-keyshortcuts', keyAria(r.kbd)); else row.removeAttribute('aria-keyshortcuts');
    const reasonId = `${row.id}-reason`;
    if (r.reason) row.setAttribute('aria-describedby', reasonId); else row.removeAttribute('aria-describedby');
    const parts = [];
    const mark = !r.checked ? null : r.type === 'radio' ? h('span', {class: 'ui-menu-dot'}) : glyph('check', {size: 16});
    if (level.hasChecks) parts.push(h('span', {class: 'ui-menu-check', 'aria-hidden': 'true'}, mark));
    if (level.hasIcons) parts.push(h('span', {class: 'ui-menu-icon', 'aria-hidden': 'true'}, r.icon ? glyph(r.icon) : null));
    parts.push(h('span', {class: 'ui-menu-text'},
      h('span', {class: 'ui-menu-label'}, r.label),
      r.reason ? h('span', {class: 'ui-menu-reason', id: reasonId}, r.reason) : null));
    if (r.kbd) parts.push(h('kbd', {class: 'ui-menu-kbd', 'aria-hidden': 'true'}, keyLabel(r.kbd)));
    if (r.type === 'submenu') parts.push(h('span', {class: 'ui-menu-chevron', 'aria-hidden': 'true'}, glyph('chevron-right', {size: 16})));
    row.replaceChildren(...parts);
  }

  function fillLevel(level) {
    level.resolved = level.items.map(item => resolveItem(item, reg));
    level.hasChecks = level.resolved.some(r => r.type === 'checkbox' || r.type === 'radio');
    level.hasIcons = level.resolved.some(r => r.icon);
    const nodes = [];
    if (level.back) nodes.push(level.back);
    level.rows = level.resolved.map((r, index) => {
      if (r.type === 'separator') {
        const sep = h('div', {class: 'ui-menu-separator', role: 'separator'});
        nodes.push(sep);
        return null;
      }
      const row = h('div', {id: `ui-menu-${seq}-${level.depth}-${index}`});
      info.set(row, {level, index});
      renderRow(row, level, r);
      nodes.push(row);
      return row;
    });
    level.el.replaceChildren(...nodes);
  }

  function refreshLevel(level) {
    const next = level.items.map(item => resolveItem(item, reg));
    const sameShape = next.length === level.resolved.length && next.every((r, i) => (r.type === 'separator') === (level.resolved[i].type === 'separator'));
    if (!sameShape) { closeChild(level); fillLevel(level); return; }
    level.resolved = next;
    const hasChecks = next.some(r => r.type === 'checkbox' || r.type === 'radio');
    const hasIcons = next.some(r => r.icon);
    level.hasChecks = hasChecks;
    level.hasIcons = hasIcons;
    next.forEach((r, i) => { if (level.rows[i]) renderRow(level.rows[i], level, r); });
    if (level.child) refreshLevel(level.child);
  }

  function buildLevel(items, parent, parentIndex) {
    const depth = parent ? parent.depth + 1 : 0;
    const el = h('div', {
      class: 'ui-menu', role: 'menu', tabIndex: -1, 'data-consume-keys': CONSUMED_KEYS,
      'aria-label': parent ? parent.resolved[parentIndex].label : p.label ?? null,
    });
    el.dataset.presentation = presentation;
    const level = {items, parent, parentIndex, depth, el, rows: [], resolved: [], child: null, back: null, positioner: null, pop: null};
    if (parent && presentation === 'sheet') {
      level.back = h('div', {class: 'ui-menu-item ui-menu-back', role: 'menuitem', tabIndex: -1, id: `ui-menu-${seq}-${depth}-back`},
        h('span', {class: 'ui-menu-icon', 'aria-hidden': 'true'}, glyph('chevron-left')),
        h('span', {class: 'ui-menu-text'}, h('span', {class: 'ui-menu-label'}, 'Back')));
      info.set(level.back, {level, index: 'back'});
    }
    fillLevel(level);
    el.addEventListener('keydown', e => onKeydown(level, e));
    el.addEventListener('click', e => onClick(level, e));
    el.addEventListener('pointermove', e => onHover(level, e));
    return level;
  }

  const nav = level => [level.back, ...level.rows].filter(Boolean);
  const activeRow = level => nav(level).find(row => row === doc.activeElement) ?? null;

  function focusRow(level, row) {
    if (!row) { level.el.focus({preventScroll: true}); return; }
    row.focus({preventScroll: true});
    row.scrollIntoView?.({block: 'nearest'});
  }

  function firstRow(level) {
    const rows = nav(level);
    return rows.find(row => row !== level.back && !level.resolved[info.get(row).index]?.disabled) ?? rows[0] ?? null;
  }

  function move(level, delta) {
    const rows = nav(level);
    if (!rows.length) return;
    const at = rows.indexOf(activeRow(level));
    const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : (at + delta + rows.length) % rows.length;
    focusRow(level, rows[next]);
  }

  function typeAhead(level, ch) {
    clearTimeout(typeahead.timer);
    const text = typeahead.text + ch.toLowerCase();
    typeahead.text = text;
    typeahead.timer = setTimeout(() => { typeahead.text = ''; }, TYPEAHEAD_MS);
    const rows = level.rows.filter(Boolean);
    if (!rows.length) return;
    const current = rows.indexOf(activeRow(level));
    const repeated = text.length > 1 && [...text].every(c => c === text[0]);
    const needle = repeated ? text[0] : text;
    const start = needle.length === 1 ? current + 1 : Math.max(0, current);
    for (let k = 0; k < rows.length; k++) {
      const row = rows[(start + k) % rows.length];
      const r = level.resolved[info.get(row).index];
      if (r.label.toLowerCase().startsWith(needle)) { focusRow(level, row); return; }
    }
  }

  // ------------------------------------------------------------------ submenus
  function openChild(level, index, {focus = true} = {}) {
    const r = level.resolved[index];
    if (!r || r.type !== 'submenu' || r.disabled) return;
    if (level.child && level.child.parentIndex === index) {
      if (focus) focusRow(level.child, firstRow(level.child));
      return;
    }
    closeChild(level);
    const row = level.rows[index];
    const child = buildLevel(r.items, level, index);
    level.child = child;
    row.setAttribute('aria-expanded', 'true');
    const onEscape = () => closeChild(level, {focusParent: true});
    if (presentation === 'popover') {
      showLayer(child.el, 'menu');
      child.positioner = anchorTo(child.el, row, {placement: 'right', gap: 0});
    } else {
      level.el.hidden = true;
      level.el.after(child.el);
      sheet?.set({title: r.label});
    }
    child.pop = pushOverlay({el: child.el, modal: true, onEscape});
    if (focus || presentation === 'sheet') focusRow(child, firstRow(child));
  }

  function closeChild(level, {focusParent = false} = {}) {
    const child = level.child;
    if (!child) return;
    closeChild(child);
    level.child = null;
    child.pop?.();
    child.positioner?.destroy();
    const hadFocus = child.el.contains(doc.activeElement);
    if (presentation === 'popover') hideLayer(child.el); else child.el.remove();
    level.el.hidden = false;
    if (presentation === 'sheet' && open) sheet?.set({title: level.parent ? level.parent.resolved[level.parentIndex].label : p.label ?? ''});
    const row = level.rows[child.parentIndex];
    row?.setAttribute('aria-expanded', 'false');
    if (focusParent || hadFocus) focusRow(level, row);
  }

  // ------------------------------------------------------------------ input
  function activate(level, row, event) {
    const where = info.get(row);
    if (!where) return;
    if (where.index === 'back') { closeChild(level.parent, {focusParent: true}); return; }
    const r = level.resolved[where.index];
    const item = level.items[where.index];
    if (!r || r.disabled) return;
    if (r.type === 'submenu') { openChild(level, where.index, {focus: true}); return; }
    const source = event?.type === 'keydown' ? 'key' : 'pointer';
    close('select');
    if (r.command) reg.run(r.command, {source, args: item.args, event});
    item.run?.({item, event, source});
  }

  function onKeydown(level, e) {
    if (e.isComposing || !open) return;
    const row = activeRow(level);
    const where = row ? info.get(row) : null;
    switch (e.key) {
      case 'ArrowDown': move(level, 1); break;
      case 'ArrowUp': move(level, -1); break;
      case 'Home': focusRow(level, nav(level)[0]); break;
      case 'End': { const rows = nav(level); focusRow(level, rows[rows.length - 1]); break; }
      case 'ArrowRight':
        if (where && where.index !== 'back' && level.resolved[where.index]?.type === 'submenu') openChild(level, where.index, {focus: true});
        break;
      case 'ArrowLeft':
        if (level.parent) closeChild(level.parent, {focusParent: true});
        break;
      case 'Enter':
      case ' ':
        if (row) activate(level, row, e);
        break;
      case 'Escape':
        // The dispatcher handles Esc (and calls preventDefault) when it runs; this is the fallback without it.
        if (e.defaultPrevented) return;
        if (level.parent) closeChild(level.parent, {focusParent: true}); else close('escape');
        break;
      case 'Tab':
        close('tab');
        break;
      default:
        if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) { typeAhead(level, e.key); break; }
        return;
    }
    e.preventDefault();
  }

  function onClick(level, e) {
    const row = e.target?.closest?.('.ui-menu-item');
    if (!row || info.get(row)?.level !== level) return;
    activate(level, row, e);
  }

  function onHover(level, e) {
    if (presentation !== 'popover' || e.pointerType === 'touch') return;
    const row = e.target?.closest?.('.ui-menu-item');
    const where = row ? info.get(row) : null;
    if (!where || where.level !== level || row === doc.activeElement) return;
    focusRow(level, row);
    const r = level.resolved[where.index];
    if (r?.type === 'submenu' && !r.disabled) openChild(level, where.index, {focus: false});
    else closeChild(level);
  }

  // ------------------------------------------------------------------ open and close
  let root = buildLevel(p.items, null, null);
  applyCommon(root.el, p);

  function close(reason = 'close') {
    if (!open) return;
    open = false;
    openMenus.delete(handle);
    clearTimeout(typeahead.timer);
    offChange();
    offOutside?.();
    // Focus returns to where it was, unless a pointer-down outside is taking it elsewhere.
    if (reason !== 'outside' && levelContains(root, doc.activeElement) && previous?.isConnected && previous !== doc.body) {
      previous.focus?.({preventScroll: true});
    }
    closeChild(root);
    root.pop?.();
    root.positioner?.destroy();
    if (presentation === 'popover') hideLayer(root.el);
    sheet?.destroy();
    if (reason !== 'destroy') p.onClose?.(reason);
  }

  function levelContains(level, node) {
    for (let l = level; l; l = l.child) if (l.el.contains(node)) return true;
    return false;
  }

  if (presentation === 'popover') {
    showLayer(root.el, 'menu');
    root.positioner = anchorTo(root.el, p.anchor, {placement: p.placement, gap: isElement(p.anchor) ? 4 : 2});
    root.pop = pushOverlay({el: root.el, modal: true, onEscape: () => close('escape')});
    offOutside = onOutside(root.el, {except: isElement(p.anchor) ? [p.anchor] : [], onDismiss: () => close('outside')});
  } else {
    sheet = Sheet({
      title: p.label ?? '', label: p.label ?? 'Menu', content: root.el, layout: 'bottom', modal: true, detents: [90],
      initialDetent: 90, autofocus: false, className: 'ui-menu-sheet', onClose: reason => close(reason),
    });
  }

  const offChange = reg.onChange(() => { if (open) refreshLevel(root); });
  focusRow(root, firstRow(root));

  const handle = {
    get el() { return root.el; },
    get open() { return open; },
    get presentation() { return presentation; },
    get sheet() { return sheet; },
    set(partial = {}) {
      if (!open) return;
      const prev = p;
      p = {...p, ...partial, presentation: prev.presentation, registry: prev.registry};
      applyCommon(root.el, p, prev);
      if (p.label !== prev.label) {
        if (p.label) root.el.setAttribute('aria-label', p.label); else root.el.removeAttribute('aria-label');
        sheet?.set({title: p.label ?? '', label: p.label ?? 'Menu'});
      }
      if (p.items !== prev.items) {
        if (!Array.isArray(p.items)) throw new TypeError('Menu: items must be an array');
        const hadFocus = levelContains(root, doc.activeElement);
        closeChild(root);
        root.items = p.items;
        fillLevel(root);
        if (hadFocus) focusRow(root, firstRow(root));
      }
      if (presentation === 'popover' && (p.anchor !== prev.anchor || p.placement !== prev.placement)) {
        root.positioner?.destroy();
        root.positioner = anchorTo(root.el, p.anchor, {placement: p.placement, gap: isElement(p.anchor) ? 4 : 2});
        offOutside?.();
        offOutside = onOutside(root.el, {except: isElement(p.anchor) ? [p.anchor] : [], onDismiss: () => close('outside')});
      }
    },
    close,
    destroy() { close('destroy'); },
  };
  openMenus.add(handle);
  return handle;
}

/** Opens a menu of `items` (Menu with items). */
Menu.open = (items, opts = {}) => Menu({...opts, items});

/** Binds the context-menu gestures of `el` to a menu of getItems(event). Returns `off`. See the header. */
export function bindContextMenu(el, getItems, {label, placement = 'bottom', registry, presentation, onOpen} = {}) {
  if (!isElement(el)) throw new TypeError('bindContextMenu: el must be an element');
  if (typeof getItems !== 'function') throw new TypeError('bindContextMenu: getItems must be a function');
  let current = null;
  let press = null;              // {id, x, y, timer, pointerType}
  let swallowClick = false;

  const isOpen = () => !!current?.open;
  const openAt = (anchor, event, source) => {
    const items = getItems(event, {source});
    if (!Array.isArray(items) || !items.length) return false;
    current?.destroy();
    current = Menu({items, anchor, label, placement: isElement(anchor) ? placement : 'bottom', registry, presentation,
      onClose: () => { current = null; }});
    onOpen?.(current, {source, event});
    return true;
  };
  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };

  const onContextMenu = e => {
    if (isOpen()) { e.preventDefault(); return; }
    if (press) {
      // A touch long-press the browser reports first: open now, once.
      const {x, y} = press;
      cancelPress();
      if (openAt({x, y}, e, 'longpress')) { e.preventDefault(); swallowClick = true; }
      return;
    }
    const keyboard = e.button !== 2 && e.clientX === 0 && e.clientY === 0;
    const anchor = keyboard && isElement(e.target) ? e.target : {x: e.clientX, y: e.clientY};
    if (openAt(anchor, e, keyboard ? 'key' : 'pointer')) e.preventDefault();
  };
  const onPointerDown = e => {
    swallowClick = false;
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    if (!e.isPrimary) { cancelPress(); return; }
    cancelPress();
    press = {id: e.pointerId, x: e.clientX, y: e.clientY, pointerType: e.pointerType, timer: null};
    press.timer = setTimeout(() => {
      const {x, y} = press;
      press = null;
      if (openAt({x, y}, e, 'longpress')) swallowClick = true;
    }, LONG_PRESS_MS);
  };
  const onPointerMove = e => {
    if (!press || e.pointerId !== press.id) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE_PX) cancelPress();
  };
  const onPointerEnd = e => { if (press && e.pointerId === press.id) cancelPress(); };
  const onClick = e => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const onKeydown = e => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const contextKey = e.key === 'ContextMenu' && !e.shiftKey;
    const shiftF10 = e.key === 'F10' && e.shiftKey;
    if (!contextKey && !shiftF10) return;
    const target = isElement(e.target) ? e.target : el;
    if (openAt(target, e, 'key')) e.preventDefault();
  };

  el.addEventListener('contextmenu', onContextMenu);
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerEnd);
  el.addEventListener('pointercancel', onPointerEnd);
  el.addEventListener('click', onClick, true);
  el.addEventListener('keydown', onKeydown);
  return () => {
    cancelPress();
    el.removeEventListener('contextmenu', onContextMenu);
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', onPointerEnd);
    el.removeEventListener('pointercancel', onPointerEnd);
    el.removeEventListener('click', onClick, true);
    el.removeEventListener('keydown', onKeydown);
  };
}
