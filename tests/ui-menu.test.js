// @vitest-environment happy-dom
// src/ui/menu.js: roles, roving focus, type-ahead, Esc, submenus, checked/radio, disabled reasons, registry-backed
// items, coarse pointers → sheet, bindContextMenu, and the dispatcher's overlay stack (menus are modal, D36).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createRegistry} from '../src/app/commands.js';
import {openOverlays, startDispatcher} from '../src/app/dispatch.js';
import {bindContextMenu, closeAllMenus, LONG_PRESS_MS, Menu, resolveItem} from '../src/ui/menu.js';
import {installPopoverShim, isPopoverOpen, keydown, pointer, restoreDomShims, setMedia, tap} from './helpers/dom.js';

let anchor, opened, stops;

beforeEach(() => {
  installPopoverShim();
  anchor = document.createElement('button');
  anchor.textContent = 'More';
  document.body.append(anchor);
  anchor.focus();
  opened = [];
  stops = [];
});

afterEach(() => {
  for (const m of opened) m.destroy();
  closeAllMenus();
  for (const stop of stops) stop();
  vi.useRealTimers();
  restoreDomShims();
  document.body.replaceChildren();
});

const open = (props = {}) => {
  const m = Menu({anchor, label: 'Song', ...props});
  opened.push(m);
  return m;
};
const rows = m => [...m.el.querySelectorAll(':scope > .ui-menu-item')];
const labelOf = row => row.querySelector('.ui-menu-label').textContent;
const active = () => document.activeElement;

const ITEMS = [
  {label: 'Play from here', kbd: 'Enter'},
  {label: 'Pin', type: 'checkbox', checked: true},
  {type: 'separator'},
  {label: 'Chart', type: 'radio', checked: true},
  {label: 'Road map', type: 'radio', checked: false},
  {label: 'Re-split…', reason: 'Re-split from Woodshed for desktop.'},
  {label: 'View', items: [{label: 'Chart'}, {label: 'Stems'}]},
  {label: 'Delete', danger: true},
];

describe('structure and roles', () => {
  test('role=menu with menuitem, menuitemcheckbox, menuitemradio and separator', () => {
    const m = open({items: ITEMS});
    expect(m.el.getAttribute('role')).toBe('menu');
    expect(m.el.getAttribute('aria-label')).toBe('Song');
    expect(m.presentation).toBe('popover');
    const roles = [...m.el.children].map(n => n.getAttribute('role'));
    expect(roles).toEqual(['menuitem', 'menuitemcheckbox', 'separator', 'menuitemradio', 'menuitemradio', 'menuitem', 'menuitem', 'menuitem']);
    const [, pin, chart, road] = rows(m);
    expect(pin.getAttribute('aria-checked')).toBe('true');
    expect(pin.querySelector('.ui-menu-check svg')).not.toBeNull();
    expect(chart.querySelector('.ui-menu-check .ui-menu-dot')).not.toBeNull();
    expect(road.querySelector('.ui-menu-check').childElementCount).toBe(0);
    expect(chart.getAttribute('aria-checked')).toBe('true');
    expect(road.getAttribute('aria-checked')).toBe('false');
    expect(rows(m)[0].hasAttribute('aria-checked')).toBe(false);
  });

  test('key-caps, submenu flags, danger and a visible disabled reason', () => {
    const m = open({items: ITEMS});
    const [play, , , , resplit, view, del] = rows(m);
    expect(play.getAttribute('aria-keyshortcuts')).toBe('Enter');
    expect(play.querySelector('kbd').textContent).toBe('Enter');
    expect(view.getAttribute('aria-haspopup')).toBe('menu');
    expect(view.getAttribute('aria-expanded')).toBe('false');
    expect(del.hasAttribute('data-danger')).toBe(true);
    expect(resplit.getAttribute('aria-disabled')).toBe('true');
    const reason = resplit.querySelector('.ui-menu-reason');
    expect(reason.textContent).toBe('Re-split from Woodshed for desktop.');
    expect(resplit.getAttribute('aria-describedby')).toBe(reason.id);
  });

  test('opens as a popover in the top layer and focuses the first enabled item', () => {
    const m = open({items: [{label: 'Off', disabled: true}, {label: 'On'}]});
    expect(m.el.getAttribute('popover')).toBe('manual');
    expect(isPopoverOpen(m.el)).toBe(true);
    expect(m.el.dataset.layer).toBe('menu');
    expect(labelOf(active())).toBe('On');
  });

  test('without the Popover API it uses the fallback layer', () => {
    restoreDomShims();
    const m = open({items: [{label: 'One'}]});
    expect(m.el.hasAttribute('popover')).toBe(false);
    expect(m.el.hasAttribute('data-layer-fallback')).toBe(true);
    expect(m.el.isConnected).toBe(true);
  });

  test('resolveItem validates items', () => {
    expect(() => resolveItem({label: ''})).toThrow(TypeError);
    expect(() => resolveItem({label: 'x', type: 'nope'})).toThrow(RangeError);
    expect(() => resolveItem({label: 'x', type: 'submenu'})).toThrow(TypeError);
    expect(resolveItem({label: 'x', items: []}).type).toBe('submenu');
    expect(() => Menu({items: []})).toThrow(TypeError);
  });
});

describe('roving focus and type-ahead', () => {
  test('↓ ↑ wrap, Home and End; disabled items are focusable, separators are not', () => {
    const m = open({items: ITEMS});
    expect(labelOf(active())).toBe('Play from here');
    keydown('ArrowDown');
    expect(labelOf(active())).toBe('Pin');
    keydown('ArrowDown');
    expect(labelOf(active())).toBe('Chart');
    keydown('ArrowUp');
    keydown('ArrowUp');
    keydown('ArrowUp');
    expect(labelOf(active())).toBe('Delete');
    keydown('ArrowDown');
    expect(labelOf(active())).toBe('Play from here');
    keydown('End');
    expect(labelOf(active())).toBe('Delete');
    keydown('Home');
    expect(labelOf(active())).toBe('Play from here');
    keydown('ArrowDown'); keydown('ArrowDown'); keydown('ArrowDown'); keydown('ArrowDown');
    expect(labelOf(active())).toBe('Re-split…');
    expect(m.el.contains(active())).toBe(true);
  });

  test('handled keys are prevented; the menu declares the keys it consumes', () => {
    const m = open({items: ITEMS});
    expect(keydown('ArrowDown').defaultPrevented).toBe(true);
    expect(m.el.getAttribute('data-consume-keys')).toContain('ArrowDown');
  });

  test('type-ahead: a prefix, repeated letters cycle, the buffer resets after 500 ms', () => {
    vi.useFakeTimers();
    open({items: [{label: 'Save spot'}, {label: 'Rename'}, {label: 'Re-split'}, {label: 'Remove'}, {label: 'Share'}]});
    keydown('r');
    expect(labelOf(active())).toBe('Rename');
    keydown('r');
    expect(labelOf(active())).toBe('Re-split');
    keydown('r');
    expect(labelOf(active())).toBe('Remove');
    vi.advanceTimersByTime(600);
    keydown('s');
    expect(labelOf(active())).toBe('Share');
    keydown('a');
    expect(labelOf(active())).toBe('Save spot');
    vi.advanceTimersByTime(600);
    keydown('r'); keydown('e'); keydown('m');
    expect(labelOf(active())).toBe('Remove');
  });
});

describe('activation and closing', () => {
  test('click runs the item, closes the menu and returns focus first', () => {
    const order = [];
    const run = vi.fn(() => order.push(document.activeElement === anchor ? 'focus returned' : 'focus elsewhere'));
    const onClose = vi.fn(() => order.push('closed'));
    const m = open({items: [{label: 'Loop this bar', run}], onClose});
    tap(rows(m)[0]);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({source: 'pointer'}));
    expect(order).toEqual(['closed', 'focus returned']);
    expect(onClose).toHaveBeenCalledWith('select');
    expect(m.open).toBe(false);
    expect(m.el.isConnected).toBe(false);
  });

  test('Enter and Space activate with source key; disabled items do nothing and keep it open', () => {
    const run = vi.fn();
    const m = open({items: [{label: 'Off', disabled: true, run}, {label: 'On', run}]});
    keydown('ArrowUp');
    expect(labelOf(active())).toBe('Off');
    keydown('Enter');
    tap(rows(m)[0]);
    expect(run).not.toHaveBeenCalled();
    expect(m.open).toBe(true);
    keydown('ArrowDown');
    keydown('Space');
    expect(run).toHaveBeenCalledWith(expect.objectContaining({source: 'key'}));
    expect(m.open).toBe(false);
  });

  test('Esc closes (without the dispatcher) and Tab closes; focus returns to the anchor', () => {
    const onClose = vi.fn();
    open({items: ITEMS, onClose});
    keydown('Escape');
    expect(onClose).toHaveBeenLastCalledWith('escape');
    expect(active()).toBe(anchor);
    open({items: ITEMS, onClose});
    keydown('Tab');
    expect(onClose).toHaveBeenLastCalledWith('tab');
    expect(active()).toBe(anchor);
  });

  test('a pointer-down outside closes without moving focus back; the anchor is not outside', () => {
    const onClose = vi.fn();
    const m = open({items: ITEMS, onClose});
    pointer(anchor, 'pointerdown');
    expect(m.open).toBe(true);
    const elsewhere = document.createElement('div');
    document.body.append(elsewhere);
    pointer(elsewhere, 'pointerdown');
    expect(onClose).toHaveBeenCalledWith('outside');
    expect(m.open).toBe(false);
  });

  test('destroy closes silently; closeAllMenus closes every menu', () => {
    const onClose = vi.fn();
    const a = open({items: ITEMS, onClose});
    a.destroy();
    expect(onClose).not.toHaveBeenCalled();
    const b = open({items: ITEMS, onClose});
    closeAllMenus('dialog');
    expect(b.open).toBe(false);
    expect(onClose).toHaveBeenCalledWith('dialog');
  });

  test('set({items}) re-renders in place', () => {
    const m = open({items: [{label: 'One'}]});
    m.set({items: [{label: 'Two'}, {label: 'Three'}]});
    expect(rows(m).map(labelOf)).toEqual(['Two', 'Three']);
    expect(labelOf(active())).toBe('Two');
    m.set({label: 'Card'});
    expect(m.el.getAttribute('aria-label')).toBe('Card');
  });
});

describe('submenus', () => {
  test('→ opens and focuses the first child, ← closes and refocuses the row', () => {
    const m = open({items: ITEMS});
    keydown('End'); keydown('ArrowUp');
    const view = active();
    expect(labelOf(view)).toBe('View');
    keydown('ArrowRight');
    expect(view.getAttribute('aria-expanded')).toBe('true');
    const sub = active().closest('[role=menu]');
    expect(sub).not.toBe(m.el);
    expect(sub.getAttribute('aria-label')).toBe('View');
    expect(labelOf(active())).toBe('Chart');
    expect(isPopoverOpen(sub)).toBe(true);
    keydown('ArrowDown');
    expect(labelOf(active())).toBe('Stems');
    keydown('ArrowLeft');
    expect(active()).toBe(view);
    expect(view.getAttribute('aria-expanded')).toBe('false');
    expect(sub.isConnected).toBe(false);
    expect(m.open).toBe(true);
  });

  test('Enter on a submenu row opens it; activating a child closes everything', () => {
    const run = vi.fn();
    const m = open({items: [{label: 'View', items: [{label: 'Stems', run}]}]});
    keydown('Enter');
    expect(labelOf(active())).toBe('Stems');
    const sub = active().closest('[role=menu]');
    pointer(sub, 'pointerdown');          // inside a later layer: not outside the root
    expect(m.open).toBe(true);
    keydown('Enter');
    expect(run).toHaveBeenCalledTimes(1);
    expect(m.open).toBe(false);
    expect(sub.isConnected).toBe(false);
    expect(active()).toBe(anchor);
  });

  test('hovering a submenu row with a mouse opens it without moving focus into it', () => {
    const m = open({items: [{label: 'Copy'}, {label: 'View', items: [{label: 'Stems'}]}]});
    const view = rows(m)[1];
    pointer(view, 'pointermove');
    expect(view.getAttribute('aria-expanded')).toBe('true');
    expect(active()).toBe(view);
    pointer(rows(m)[0], 'pointermove');
    expect(view.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('command items read the registry', () => {
  const setup = () => {
    const reg = createRegistry();
    const state = {focus: false, canResplit: false, runs: []};
    reg.registerMany([
      {id: 'stage.focus', title: 'Focus', group: 'View', keys: ['KeyF'], scopes: ['stage'], checked: () => state.focus,
        run: (c, args) => state.runs.push(['focus', c.source, args])},
      {id: 'song.resplit', title: 'Re-split…', group: 'Library', disabledReason: () => (state.canResplit ? null : 'Re-split from Woodshed for desktop.'),
        run: () => state.runs.push(['resplit'])},
      {id: 'transport.again', title: 'Start again', group: 'Transport', keys: ['Enter'], scopes: ['stage'],
        menu: {label: 'Start again (with count-in)'}, run: () => state.runs.push(['again'])},
      {id: 'stage.share', title: 'Share…', group: 'App', when: () => false, run: () => state.runs.push(['share'])},
    ]);
    return {reg, state};
  };

  test('label, key-cap, checked state, disabled reason and when come from the registry', () => {
    const {reg} = setup();
    const m = open({registry: reg, items: [{command: 'stage.focus'}, {command: 'song.resplit'}, {command: 'transport.again'},
      {command: 'stage.share'}, {command: 'missing.command', label: 'Gone'}]});
    const [focus, resplit, again, share, gone] = rows(m);
    expect(labelOf(focus)).toBe('Focus');
    expect(focus.getAttribute('role')).toBe('menuitemcheckbox');
    expect(focus.getAttribute('aria-checked')).toBe('false');
    expect(focus.querySelector('kbd').textContent).toBe('F');
    expect(focus.getAttribute('aria-keyshortcuts')).toBe('F');
    expect(resplit.getAttribute('aria-disabled')).toBe('true');
    expect(resplit.querySelector('.ui-menu-reason').textContent).toBe('Re-split from Woodshed for desktop.');
    expect(labelOf(again)).toBe('Start again (with count-in)');
    expect(share.getAttribute('aria-disabled')).toBe('true');
    expect(share.querySelector('.ui-menu-reason')).toBeNull();
    expect(gone.getAttribute('aria-disabled')).toBe('true');
  });

  test('registry changes update an open menu in place', () => {
    vi.useFakeTimers();
    const {reg, state} = setup();
    const m = open({registry: reg, items: [{command: 'stage.focus'}, {command: 'song.resplit'}]});
    const [focus, resplit] = rows(m);
    state.focus = true;
    state.canResplit = true;
    reg.invalidate();
    vi.advanceTimersByTime(60);
    expect(rows(m)[0]).toBe(focus);
    expect(focus.getAttribute('aria-checked')).toBe('true');
    expect(resplit.hasAttribute('aria-disabled')).toBe(false);
    expect(resplit.querySelector('.ui-menu-reason')).toBeNull();
  });

  test('activating runs the command through the registry with its source and args', () => {
    const {reg, state} = setup();
    const m = open({registry: reg, items: [{command: 'stage.focus', args: {from: 'menu'}}]});
    tap(rows(m)[0]);
    expect(state.runs).toEqual([['focus', 'pointer', {from: 'menu'}]]);
    open({registry: reg, items: [{command: 'stage.focus'}, {command: 'song.resplit'}]});
    keydown('Enter');
    expect(state.runs[1]).toEqual(['focus', 'key', undefined]);
  });
});

describe('the dispatcher overlay stack (D36)', () => {
  test('a menu is a modal overlay; a submenu adds one; Esc closes the innermost only', () => {
    const reg = createRegistry();
    const played = vi.fn();
    reg.register({id: 'transport.playStop', title: 'Play', group: 'Transport', keys: ['Space'], scopes: ['global'], run: played});
    stops.push(startDispatcher({registry: reg}));
    const m = open({items: [{label: 'View', items: [{label: 'Stems'}]}]});
    expect(openOverlays().map(o => [o.el, o.modal])).toEqual([[m.el, true]]);
    keydown('Space');                                // modal: registry keys do not run
    expect(played).not.toHaveBeenCalled();
    keydown('ArrowRight');
    expect(openOverlays()).toHaveLength(2);
    expect(openOverlays().every(o => o.modal)).toBe(true);
    keydown('Escape');
    expect(openOverlays()).toHaveLength(1);
    expect(m.open).toBe(true);
    expect(labelOf(active())).toBe('View');
    keydown('Escape');
    expect(m.open).toBe(false);
    expect(openOverlays()).toHaveLength(0);
    expect(active()).toBe(anchor);
  });
});

describe('coarse pointers: a bottom sheet with drill-in submenus', () => {
  test('renders inside a modal sheet with a Back row for submenus', () => {
    setMedia({coarse: true});
    const run = vi.fn();
    const m = open({items: [{label: 'Play from here'}, {label: 'View', items: [{label: 'Stems', run}]}]});
    expect(m.presentation).toBe('sheet');
    expect(m.sheet.el.tagName).toBe('DIALOG');
    expect(m.sheet.el.classList.contains('ui-menu-sheet')).toBe(true);
    expect(m.sheet.el.contains(m.el)).toBe(true);
    expect(m.el.dataset.presentation).toBe('sheet');
    expect(openOverlays().filter(o => o.modal)).toHaveLength(1);
    keydown('ArrowDown');
    keydown('Enter');
    expect(m.el.hidden).toBe(true);
    const sub = active().closest('[role=menu]');
    expect([...sub.querySelectorAll('.ui-menu-item')].map(labelOf)).toEqual(['Back', 'Stems']);
    expect(m.sheet.el.querySelector('.ui-sheet-title').textContent).toBe('View');
    expect(labelOf(active())).toBe('Stems');
    keydown('ArrowUp');
    keydown('Enter');                                   // Back
    expect(m.el.hidden).toBe(false);
    expect(m.sheet.el.querySelector('.ui-sheet-title').textContent).toBe('Song');
    expect(labelOf(active())).toBe('View');
    keydown('Enter');
    keydown('Enter');
    expect(run).toHaveBeenCalled();
    expect(m.open).toBe(false);
    expect(m.sheet.el.isConnected).toBe(false);
  });

  test('presentation can be forced', () => {
    setMedia({coarse: true});
    expect(open({items: [{label: 'A'}], presentation: 'popover'}).presentation).toBe('popover');
    expect(() => open({items: [{label: 'A'}], presentation: 'drawer'})).toThrow(RangeError);
  });
});

describe('bindContextMenu', () => {
  let card, items, menus, off;
  beforeEach(() => {
    card = document.createElement('div');
    card.tabIndex = 0;
    card.append(document.createElement('button'));
    document.body.append(card);
    items = [{label: 'Select'}, {label: 'Delete'}];
    menus = [];
    off = bindContextMenu(card, () => items, {label: 'Card', onOpen: (m, info) => { menus.push([m, info.source]); opened.push(m); }});
  });
  afterEach(() => off());

  const contextmenu = (target, init = {}) => {
    const e = new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 80, ...init});
    target.dispatchEvent(e);
    return e;
  };

  test('right-click opens at the pointer and prevents the native menu', () => {
    const e = contextmenu(card);
    expect(e.defaultPrevented).toBe(true);
    expect(menus).toHaveLength(1);
    expect(menus[0][1]).toBe('pointer');
    expect(menus[0][0].el.getAttribute('aria-label')).toBe('Card');
    const again = contextmenu(card);
    expect(again.defaultPrevented).toBe(true);
    expect(menus).toHaveLength(1);
  });

  test('getItems returning nothing leaves the native menu alone', () => {
    items = null;
    expect(contextmenu(card).defaultPrevented).toBe(false);
    items = [];
    expect(contextmenu(card).defaultPrevented).toBe(false);
    expect(menus).toHaveLength(0);
  });

  test('a 500 ms touch long-press opens and swallows the click that follows', () => {
    vi.useFakeTimers();
    pointer(card, 'pointerdown', {pointerType: 'touch', x: 40, y: 50});
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(menus).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(menus).toHaveLength(1);
    expect(menus[0][1]).toBe('longpress');
    pointer(card, 'pointerup', {pointerType: 'touch', x: 40, y: 50});
    const click = new window.MouseEvent('click', {bubbles: true, cancelable: true});
    const onCardClick = vi.fn();
    card.addEventListener('click', onCardClick);
    card.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(onCardClick).not.toHaveBeenCalled();
  });

  test('moving more than 10 px, lifting early or a mouse press cancels the long-press', () => {
    vi.useFakeTimers();
    pointer(card, 'pointerdown', {pointerType: 'touch', x: 40, y: 50});
    pointer(card, 'pointermove', {pointerType: 'touch', x: 40, y: 65});
    vi.advanceTimersByTime(LONG_PRESS_MS);
    pointer(card, 'pointerdown', {pointerType: 'touch', x: 40, y: 50});
    pointer(card, 'pointerup', {pointerType: 'touch', x: 40, y: 50});
    vi.advanceTimersByTime(LONG_PRESS_MS);
    pointer(card, 'pointerdown', {pointerType: 'mouse', x: 40, y: 50});
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(menus).toHaveLength(0);
  });

  test('a touch contextmenu during the press opens once', () => {
    vi.useFakeTimers();
    pointer(card, 'pointerdown', {pointerType: 'touch', x: 40, y: 50});
    expect(contextmenu(card, {button: 0}).defaultPrevented).toBe(true);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(menus).toHaveLength(1);
    expect(menus[0][1]).toBe('longpress');
  });

  test('Shift+F10 and the ContextMenu key open below the focused element', () => {
    const inner = card.querySelector('button');
    inner.focus();
    const e = keydown('Shift+F10');
    expect(e.defaultPrevented).toBe(true);
    expect(menus).toHaveLength(1);
    expect(menus[0][1]).toBe('key');
    expect(document.activeElement.closest('[role=menu]')).toBe(menus[0][0].el);
    keydown('Escape');
    expect(document.activeElement).toBe(inner);
    keydown('ContextMenu');
    expect(menus).toHaveLength(2);
    keydown('Escape');
    keydown('F10');
    keydown('Ctrl+ContextMenu');
    expect(menus).toHaveLength(2);
  });

  test('off() removes every gesture', () => {
    off();
    contextmenu(card);
    card.focus();
    keydown('Shift+F10');
    expect(menus).toHaveLength(0);
  });

  test('off() also closes a menu it opened (the card is unmounted while its menu is open)', () => {
    contextmenu(card);
    const [[m]] = menus;
    expect(m.open).toBe(true);
    expect(openOverlays()).toHaveLength(1);
    off();
    card.remove();
    expect(m.open).toBe(false);
    expect(document.querySelector('.ui-menu')).toBeNull();
    expect(openOverlays()).toHaveLength(0);
  });
});

describe('accessible names', () => {
  test("an item's name is its label; a disabled reason is its description only", () => {
    const m = open({items: ITEMS});
    const row = rows(m).find(r => labelOf(r) === 'Re-split…');
    const label = document.getElementById(row.getAttribute('aria-labelledby'));
    expect(label.textContent).toBe('Re-split…');
    expect(label.classList.contains('ui-menu-label')).toBe(true);
    expect(document.getElementById(row.getAttribute('aria-describedby')).textContent).toBe('Re-split from Woodshed for desktop.');
    expect(label.contains(row.querySelector('.ui-menu-reason'))).toBe(false);
    const plain = rows(m).find(r => labelOf(r) === 'Delete');
    expect(document.getElementById(plain.getAttribute('aria-labelledby')).textContent).toBe('Delete');
    expect(plain.hasAttribute('aria-describedby')).toBe(false);
  });
});
