// EmptyState (architecture §2.12, spec §2.7 and §5.4): a title, a sentence and actions.
//
//   const e = EmptyState({title, body, actions, headingLevel = 2, ...common})
//     title         the heading text (string)
//     body          a string, a Node, or an array of strings and Nodes ("No songs match <b>zzzz</b>.")
//     actions       an array of: a Node, a primitive ({el}, e.g. Button({command})), or a plain
//                   spec {label, onClick(e), href?, target?, variant: 'primary'|'secondary'|'quiet'|'danger',
//                   …other Button props}. A plain spec without href is a Button(...) (button.js);
//                   with href it is a native <a> link wearing the same Button look (Button renders
//                   only <button>, and a link must keep the link role); a link takes only label,
//                   href, target, variant, onClick and the common props.
//     headingLevel  2–6 (the heading element; default h2)
//   e.set(partial) · e.destroy() · e.el (section.ui-empty)
//
// The section is labelled by its heading. Buttons built here from plain specs are destroyed
// when the actions change and on destroy(); primitives passed in are not (their owner does).

import '../styles/primitives/empty.css';
import {Button} from './button.js';

const EMPTY = Object.freeze({});
const DEV = !!import.meta.env?.DEV;
const VARIANTS = ['primary', 'secondary', 'quiet', 'danger'];
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

const isNode = v => v && typeof v === 'object' && typeof v.nodeType === 'number';

function nodesOf(content) {
  const list = Array.isArray(content) ? content.flat(Infinity) : [content];
  return list.filter(c => c != null && c !== false && c !== '').map(c => (isNode(c) ? c : document.createTextNode(String(c))));
}

// A link styled as a Button: Button's own classes and data attributes, so the app keeps a single
// button style (button.css) while the element keeps the link role.
function linkButton(action) {
  const {label, href, target, variant, onClick} = action;
  const a = document.createElement('a');
  applyCommon(a, action, EMPTY);
  a.classList.add('ui-button');
  a.dataset.variant = VARIANTS.includes(variant) ? variant : 'secondary';
  a.dataset.size = 'md';
  const text = a.appendChild(document.createElement('span'));
  text.className = 'ui-button-text';
  const name = text.appendChild(document.createElement('span'));
  name.className = 'ui-button-label';
  name.textContent = String(label);
  a.href = href;
  if (target) {
    a.target = target;
    if (target === '_blank') a.rel = 'noopener';
  }
  if (typeof onClick === 'function') a.addEventListener('click', e => onClick(e));
  return a;
}

// Resolves one action to its node; plain specs it builds as Buttons are pushed onto `owned`.
function actionNode(action, owned) {
  if (isNode(action)) return action;
  if (action && isNode(action.el)) return action.el;
  if (!action || typeof action !== 'object') throw new TypeError('EmptyState: each action is a Node, a primitive {el} or {label, onClick, href?}');
  if (DEV && !String(action.label ?? '').trim()) throw new Error('EmptyState: an action needs a label');
  if (action.href) return linkButton(action);
  const button = Button({variant: 'secondary', ...action, label: String(action.label)});
  owned.push(button);
  return button.el;
}

export function EmptyState(initial = {}) {
  const el = document.createElement('section');
  el.className = 'ui-empty';
  const headingId = `ui-empty-${++seq}-title`;
  let heading = null;
  const body = document.createElement('p');
  body.className = 'ui-empty-body';
  const actions = document.createElement('div');
  actions.className = 'ui-empty-actions';
  let props = EMPTY;
  let owned = [];

  function set(partial = {}) {
    const prev = props;
    props = {...prev, ...partial};
    applyCommon(el, props, prev);
    const level = Math.min(6, Math.max(2, Math.round(Number(props.headingLevel) || 2)));
    if (!heading || heading.tagName !== `H${level}`) {
      const next = document.createElement(`h${level}`);
      next.className = 'ui-empty-title';
      next.id = headingId;
      if (heading) { next.textContent = heading.textContent; heading.replaceWith(next); }
      heading = next;
    }
    if (prev === EMPTY || props.title !== prev.title) heading.textContent = String(props.title ?? '');
    heading.hidden = !props.title;
    if (props.title) el.setAttribute('aria-labelledby', headingId); else el.removeAttribute('aria-labelledby');
    if (prev === EMPTY || props.body !== prev.body) body.replaceChildren(...nodesOf(props.body));
    body.hidden = !body.firstChild;
    if (prev === EMPTY || props.actions !== prev.actions) {
      const next = [];
      const nodes = (props.actions ?? []).filter(Boolean).map(a => actionNode(a, next));
      for (const b of owned) b.destroy();
      owned = next;
      actions.replaceChildren(...nodes);
    }
    actions.hidden = !actions.firstChild;
    if (!heading.parentNode) el.append(heading, body, actions);
  }

  function destroy() {
    for (const b of owned) b.destroy();
    owned = [];
    el.remove();
  }

  set({headingLevel: 2, ...initial});
  return {el, set, destroy};
}
