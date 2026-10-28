// DOM construction helpers (architecture §2.12). No innerHTML anywhere in the
// new UI: views and primitives build nodes with h() and keep lists in place
// with reconcileList().
//
//   h(tag, props, ...children) → Element
//     props: class (string | string[] | {name: boolean}), style (object; '--custom' props allowed),
//            dataset (object), on ({event: fn | [fn, options]}), attrs (object; true → "", null/false → absent),
//            ref(el), text (textContent). Any other key: a DOM property when the element has it
//            (id, type, value, hidden, disabled, tabIndex, …), else an attribute (role, aria-*, for, …).
//            null or undefined leaves a property unset. value, selectedIndex and checked are assigned
//            after the children are appended, so h('select', {value: 'b'}, ...options) selects 'b'.
//     children: Nodes, strings, numbers, arrays (flattened); null, undefined and booleans are skipped.
//     SVG: 'svg' and SVG element names are created in the SVG namespace (props become attributes).
//   text(s) → Text
//   reconcileList(container, items, {key, create, before}) → void
//     Keyed. Reuses the node for a known key (calling its update(item)), creates new keys, removes
//     missing ones (calling destroy() when the created entry has one), and moves nodes into order
//     without ever moving or recreating the node that holds focus.

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'use', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'defs', 'symbol', 'title', 'desc', 'clipPath', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'stop',
  'foreignObject', 'image', 'marker',
]);

function setClass(el, value) {
  let names;
  if (Array.isArray(value)) names = value.flat(Infinity).filter(Boolean);
  else if (value && typeof value === 'object') names = Object.keys(value).filter(k => value[k]);
  else names = value ? [String(value)] : [];
  const joined = names.join(' ').trim();
  if (joined) el.setAttribute('class', joined);
  else el.removeAttribute('class');
}

function setStyle(el, style) {
  if (typeof style === 'string') { el.setAttribute('style', style); return; }
  for (const [name, value] of Object.entries(style || {})) {
    if (value == null || value === false) continue;
    if (name.startsWith('--') || name.includes('-')) el.style.setProperty(name, String(value));
    else el.style[name] = value;
  }
}

function setAttr(el, name, value) {
  if (value == null || value === false) el.removeAttribute(name);
  else el.setAttribute(name, value === true ? '' : String(value));
}

// Properties that depend on the element's children (a select's options).
const AFTER_CHILDREN = new Set(['value', 'selectedIndex', 'checked']);

function setProp(el, key, value) {
  if (value == null) el.removeAttribute(key === 'htmlFor' ? 'for' : key);
  else el[key] = value;
}

function appendChildren(el, children) {
  for (const child of children) {
    if (child == null || typeof child === 'boolean') continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else if (typeof child === 'object' && typeof child.nodeType === 'number') el.appendChild(child);
    else el.appendChild(el.ownerDocument.createTextNode(String(child)));
  }
}

/** Creates an element. See the header for props. */
export function h(tag, props = {}, ...children) {
  if (typeof tag !== 'string' || !tag) throw new TypeError('h: tag must be a non-empty string');
  if (props != null && (typeof props !== 'object' || Array.isArray(props) || typeof props.nodeType === 'number')) {
    // h('p', 'text') or h('div', child): no props object.
    children.unshift(props);
    props = {};
  }
  props ||= {};
  const isSvg = tag.startsWith('svg:') || SVG_TAGS.has(tag);
  const name = tag.startsWith('svg:') ? tag.slice(4) : tag;
  const el = isSvg ? document.createElementNS(SVG_NS, name) : document.createElement(name);
  let ref = null;
  const deferred = [];
  for (const [key, value] of Object.entries(props)) {
    switch (key) {
      case 'class': case 'className': setClass(el, value); break;
      case 'style': setStyle(el, value); break;
      case 'dataset':
        for (const [k, v] of Object.entries(value || {})) if (v != null && v !== false) el.dataset[k] = v === true ? '' : String(v);
        break;
      case 'on':
        for (const [type, handler] of Object.entries(value || {})) {
          if (Array.isArray(handler)) el.addEventListener(type, handler[0], handler[1]);
          else if (handler) el.addEventListener(type, handler);
        }
        break;
      case 'attrs': for (const [k, v] of Object.entries(value || {})) setAttr(el, k, v); break;
      case 'ref': ref = value; break;
      case 'text': el.textContent = value == null ? '' : String(value); break;
      default:
        if (value === undefined) break;
        if (!isSvg && !key.includes('-') && key in el && key !== 'list' && key !== 'form') {
          if (AFTER_CHILDREN.has(key)) deferred.push([key, value]);
          else setProp(el, key, value);
        } else {
          setAttr(el, key === 'htmlFor' ? 'for' : key, value);
        }
    }
  }
  appendChildren(el, children);
  for (const [key, value] of deferred) setProp(el, key, value);
  if (typeof ref === 'function') ref(el);
  return el;
}

/** A text node. */
export function text(s) {
  return document.createTextNode(s == null ? '' : String(s));
}

// container → Map(before anchor | null → Map(key → entry))
const lists = new WeakMap();

function entriesFor(container, before) {
  let byAnchor = lists.get(container);
  if (!byAnchor) { byAnchor = new Map(); lists.set(container, byAnchor); }
  const anchor = before ?? null;
  let entries = byAnchor.get(anchor);
  if (!entries) { entries = new Map(); byAnchor.set(anchor, entries); }
  return entries;
}

function holdsFocus(el) {
  const active = el.ownerDocument?.activeElement;
  return !!active && active !== el.ownerDocument.body && (el === active || el.contains(active));
}

function removeEntry(entry) {
  if (typeof entry.destroy === 'function') entry.destroy();
  entry.el.remove();
}

/**
 * Keeps `container`'s children for `items` in order, keyed by `key(item)`.
 * `create(item)` returns {el, update?(item), destroy?()}; known keys get update(item).
 * With `before`, the list lives immediately before that child of the container.
 */
export function reconcileList(container, items, {key, create, before = null} = {}) {
  if (typeof key !== 'function' || typeof create !== 'function') throw new TypeError('reconcileList: key and create are required');
  if (before && before.parentNode !== container) throw new Error('reconcileList: before must be a child of container');
  const entries = entriesFor(container, before);
  const next = new Map();
  const order = [];
  for (const item of items) {
    const k = String(key(item));
    if (next.has(k)) throw new Error(`reconcileList: duplicate key ${JSON.stringify(k)}`);
    let entry = entries.get(k);
    if (entry && entry.el.parentNode === container) {
      entry.update?.(item);
    } else {
      entry = create(item);
      if (!entry || !entry.el) throw new TypeError('reconcileList: create(item) must return {el}');
    }
    next.set(k, entry);
    order.push(entry.el);
  }
  for (const [k, entry] of entries) if (next.get(k) !== entry) removeEntry(entry);
  entries.clear();
  for (const [k, entry] of next) entries.set(k, entry);

  // Walk backwards placing each node right before its successor. The focused node is never
  // moved (moving it would blur it); everything before it in the order is placed before it.
  let successor = before;
  for (let i = order.length - 1; i >= 0; i--) {
    const el = order[i];
    if (el.parentNode === container && el.nextSibling === successor) { successor = el; continue; }
    if (el.parentNode === container && holdsFocus(el)) { successor = el; continue; }
    container.insertBefore(el, successor);
    successor = el;
  }
}
