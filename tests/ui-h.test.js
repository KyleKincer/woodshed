// @vitest-environment happy-dom
import {beforeEach, describe, expect, test, vi} from 'vitest';
import {h, reconcileList, text} from '../src/ui/h.js';

beforeEach(() => { document.body.replaceChildren(); });

describe('h()', () => {
  test('a select built with value in props selects that option (value-like props wait for the children)', () => {
    const select = h('select', {value: 'b'}, h('option', {value: 'a'}, 'A'), h('option', {value: 'b'}, 'B'));
    expect(select.value).toBe('b');
    expect(select.selectedIndex).toBe(1);
    const byIndex = h('select', {selectedIndex: 2}, ['x', 'y', 'z'].map(v => h('option', {value: v}, v)));
    expect(byIndex.value).toBe('z');
    const area = h('textarea', {value: 'typed'}, 'default');
    expect(area.value).toBe('typed');
    const box = h('input', {type: 'checkbox', checked: true});
    expect(box.checked).toBe(true);
  });

  test('null leaves a property unset instead of stringifying it', () => {
    const d = h('div', {id: null, title: null, hidden: null});
    expect(d.hasAttribute('id')).toBe(false);
    expect(d.hasAttribute('title')).toBe(false);
    expect(d.hidden).toBe(false);
    const label = h('label', {htmlFor: null});
    expect(label.hasAttribute('for')).toBe(false);
    expect(h('input', {value: null}).value).toBe('');
  });

  test('class, style, dataset, attrs, text and properties', () => {
    const el = h('button', {
      class: ['ui-button', null, false && 'x', ['nested']], style: {color: 'red', '--size': '4px', marginTop: '2px'},
      dataset: {variant: 'primary', on: true, off: false, none: null}, attrs: {'aria-pressed': 'true', 'aria-hidden': false, inert: true},
      type: 'button', disabled: true, id: 'b1', role: 'switch', 'aria-label': 'Loop', tabIndex: -1, text: 'Loop',
    });
    expect(el.tagName).toBe('BUTTON');
    expect(el.className).toBe('ui-button nested');
    expect(el.style.color).toBe('red');
    expect(el.style.getPropertyValue('--size')).toBe('4px');
    expect(el.style.marginTop).toBe('2px');
    expect(el.dataset.variant).toBe('primary');
    expect(el.getAttribute('data-on')).toBe('');
    expect(el.hasAttribute('data-off')).toBe(false);
    expect(el.hasAttribute('data-none')).toBe(false);
    expect(el.getAttribute('aria-pressed')).toBe('true');
    expect(el.hasAttribute('aria-hidden')).toBe(false);
    expect(el.getAttribute('inert')).toBe('');
    expect(el.type).toBe('button');
    expect(el.disabled).toBe(true);
    expect(el.id).toBe('b1');
    expect(el.getAttribute('role')).toBe('switch');
    expect(el.getAttribute('aria-label')).toBe('Loop');
    expect(el.tabIndex).toBe(-1);
    expect(el.textContent).toBe('Loop');
  });

  test('class as an object map; for/htmlFor become the for attribute', () => {
    expect(h('div', {class: {a: true, b: false, c: 1}}).className).toBe('a c');
    expect(h('label', {for: 'x'}).getAttribute('for')).toBe('x');
    expect(h('label', {htmlFor: 'y'}).htmlFor).toBe('y');
  });

  test('on: handlers and [handler, options]; ref receives the element', () => {
    const click = vi.fn();
    const once = vi.fn();
    let seen = null;
    const el = h('button', {on: {click, focus: [once, {once: true}]}, ref: e => { seen = e; }});
    el.click();
    el.dispatchEvent(new Event('focus'));
    el.dispatchEvent(new Event('focus'));
    expect(click).toHaveBeenCalledTimes(1);
    expect(once).toHaveBeenCalledTimes(1);
    expect(seen).toBe(el);
  });

  test('children: nodes, strings, numbers, nested arrays; null, undefined and booleans skipped', () => {
    const el = h('p', {}, 'a', 1, null, undefined, false, true, [h('b', {}, 'B'), ['c', [text('d')]]], 0);
    expect(el.textContent).toBe('a1Bcd0');
    expect(el.childNodes).toHaveLength(6);
  });

  test('props may be omitted', () => {
    expect(h('p', 'hello').textContent).toBe('hello');
    expect(h('div', h('span')).firstChild.tagName).toBe('SPAN');
    expect(h('div', null, 'x').textContent).toBe('x');
  });

  test('text is set as text, never parsed as HTML', () => {
    const el = h('div', {text: '<img src=x onerror=alert(1)>'});
    expect(el.children).toHaveLength(0);
    expect(h('div', {}, '<b>x</b>').children).toHaveLength(0);
    expect(text('<i>').nodeType).toBe(Node.TEXT_NODE);
    expect(text(null).data).toBe('');
  });

  test('SVG elements are created in the SVG namespace with attributes', () => {
    const svg = h('svg', {class: 'ui-icon', width: 20, height: 20, 'aria-hidden': 'true'}, h('use', {href: '#i-play'}));
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('class')).toBe('ui-icon');
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.firstChild.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.firstChild.getAttribute('href')).toBe('#i-play');
    expect(h('svg:a', {}).namespaceURI).toBe('http://www.w3.org/2000/svg');
  });

  test('rejects a missing tag', () => {
    expect(() => h('')).toThrow(TypeError);
  });
});

describe('reconcileList()', () => {
  const row = item => {
    const el = h('button', {dataset: {key: item.id}, text: item.label});
    const entry = {el, updates: 0, update(next) { entry.updates++; el.textContent = next.label; }};
    return entry;
  };
  const keys = container => [...container.children].map(el => el.dataset.key);
  const opts = (create = row) => ({key: item => item.id, create});

  test('creates, updates in place, removes, and reorders by key', () => {
    const list = h('div');
    document.body.append(list);
    const create = vi.fn(row);
    reconcileList(list, [{id: 'a', label: 'A'}, {id: 'b', label: 'B'}, {id: 'c', label: 'C'}], opts(create));
    expect(keys(list)).toEqual(['a', 'b', 'c']);
    const [a, b] = list.children;
    reconcileList(list, [{id: 'c', label: 'C2'}, {id: 'a', label: 'A2'}, {id: 'd', label: 'D'}], opts(create));
    expect(keys(list)).toEqual(['c', 'a', 'd']);
    expect(list.children[1]).toBe(a);            // moved, not rebuilt
    expect(a.textContent).toBe('A2');
    expect(b.isConnected).toBe(false);
    expect(create).toHaveBeenCalledTimes(4);
  });

  test('never moves or recreates the node holding focus', () => {
    const list = h('div');
    document.body.append(list);
    const items = ['a', 'b', 'c', 'd', 'e'].map(id => ({id, label: id}));
    reconcileList(list, items, opts());
    const focused = list.children[2];   // c
    focused.focus();
    expect(document.activeElement).toBe(focused);
    const blur = vi.fn();
    focused.addEventListener('blur', blur);
    const moves = vi.spyOn(list, 'insertBefore');
    for (const order of [['e', 'd', 'c', 'b', 'a'], ['c', 'a', 'b', 'd', 'e'], ['a', 'b', 'd', 'e', 'c'], ['b', 'c'], ['x', 'c', 'y']]) {
      reconcileList(list, order.map(id => ({id, label: id})), opts());
      expect(keys(list)).toEqual(order);
      expect(list.querySelector('[data-key="c"]')).toBe(focused);
      expect(document.activeElement).toBe(focused);
    }
    expect(moves.mock.calls.some(([node]) => node === focused)).toBe(false);
    expect(blur).not.toHaveBeenCalled();
  });

  test('keeps a focused descendant (e.g. a menu button inside a card)', () => {
    const list = h('div');
    document.body.append(list);
    const card = item => ({el: h('div', {dataset: {key: item.id}}, h('button', {text: item.id}))});
    reconcileList(list, [{id: 'a'}, {id: 'b'}], opts(card));
    const inner = list.children[1].querySelector('button');
    inner.focus();
    reconcileList(list, [{id: 'b'}, {id: 'a'}], opts(card));
    expect(keys(list)).toEqual(['b', 'a']);
    expect(document.activeElement).toBe(inner);
  });

  test('a no-op reconcile moves nothing', () => {
    const list = h('div');
    const items = [{id: 'a', label: 'a'}, {id: 'b', label: 'b'}];
    reconcileList(list, items, opts());
    const moves = vi.spyOn(list, 'insertBefore');
    reconcileList(list, items, opts());
    expect(moves).not.toHaveBeenCalled();
  });

  test('`before` keeps the list ahead of static content; destroy() runs on removal', () => {
    const footer = h('p', {text: 'footer'});
    const list = h('div', {}, h('h2', {text: 'head'}), footer);
    const destroy = vi.fn();
    const create = item => ({el: h('span', {dataset: {key: item.id}}), destroy});
    reconcileList(list, [{id: 'a'}, {id: 'b'}], {key: i => i.id, create, before: footer});
    expect([...list.children].map(el => el.dataset.key ?? el.tagName)).toEqual(['H2', 'a', 'b', 'P']);
    reconcileList(list, [{id: 'b'}], {key: i => i.id, create, before: footer});
    expect(destroy).toHaveBeenCalledTimes(1);
    expect([...list.children].map(el => el.dataset.key ?? el.tagName)).toEqual(['H2', 'b', 'P']);
  });

  test('re-creates an entry whose node was removed from outside', () => {
    const list = h('div');
    reconcileList(list, [{id: 'a', label: 'a'}], opts());
    list.firstChild.remove();
    reconcileList(list, [{id: 'a', label: 'a'}], opts());
    expect(keys(list)).toEqual(['a']);
  });

  test('rejects duplicate keys and bad options', () => {
    const list = h('div');
    expect(() => reconcileList(list, [{id: 'a'}, {id: 'a'}], opts())).toThrow(/duplicate key/);
    expect(() => reconcileList(list, [], {})).toThrow(TypeError);
    expect(() => reconcileList(list, [{id: 'z'}], {key: i => i.id, create: () => ({})})).toThrow(TypeError);
    expect(() => reconcileList(list, [], {key: i => i.id, create: row, before: h('p')})).toThrow(/before/);
  });
});
