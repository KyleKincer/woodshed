// Kbd: a key-cap (architecture §2.12, spec §8.8).
//
//   const k = Kbd({keys, force = false, hint = false, platform, ...common})
//     keys      a KeyString ('Mod+KeyK', 'Shift+Space', '[') or an array of them (rendered as alternatives)
//     force     show the cap on touch-only devices too
//     hint      a key-cap hint (Edit's toolbar caps): shown only inside an element carrying
//               [data-kbd-hints], which Edit adds after keyboard use (spec §5.0)
//     platform  override keys.js's platform for the label ('mac' → '⌘K', 'win' → 'Ctrl+K')
//     common    className, id, attrs, dataset, testid
//   k.set(partial) · k.destroy() · k.el (a <kbd class="ui-kbd">)
//
// Labels come from keys.label() (keys.setPlatform() and the cached keyboard layout map, D56),
// computed on create and on every set(): a cap re-renders when its label text changed, so a
// set() after keys.loadLayoutMap() resolves or after setPlatform() picks the new label up.
// keys.js has no change signal yet, so an untouched cap keeps the label it was drawn with. On `(hover: none) and (pointer: coarse)` the cap is
// `hidden` unless `force`, tracking the media query live. Touch users always get
// the same command from a visible control, never only from a key-cap.

import '../styles/primitives/kbd.css';
import {label as keyLabel} from '../app/keys.js';

export const TOUCH_ONLY_QUERY = '(hover: none) and (pointer: coarse)';

const EMPTY = Object.freeze({});
const toList = keys => (Array.isArray(keys) ? keys : keys == null || keys === '' ? [] : [keys]).filter(k => typeof k === 'string' && k);

/** The visible label of one KeyString on the given platform (keys.js decides when platform is undefined). */
export function kbdLabel(key, {platform} = {}) {
  return keyLabel(key, platform === undefined ? {} : {platform});
}

/** True on touch-only devices, where key-caps are hidden unless forced. */
export function isTouchOnly() {
  return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(TOUCH_ONLY_QUERY).matches;
}

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

export function Kbd(initial = {}) {
  const el = document.createElement('kbd');
  el.className = 'ui-kbd';
  let props = EMPTY;
  const mql = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(TOUCH_ONLY_QUERY) : null;
  const onMedia = () => syncHidden();
  mql?.addEventListener?.('change', onMedia);

  function syncHidden() {
    el.hidden = !!mql?.matches && !props.force;
  }

  let drawn = null;   // the label signature last rendered

  function render() {
    const list = toList(props.keys);
    const labels = list.map(k => kbdLabel(k, {platform: props.platform}));
    const signature = `${list.join('\n')}\t${labels.join('\n')}`;
    if (signature === drawn) return;
    drawn = signature;
    if (list.length) el.dataset.keys = list.join(' '); else delete el.dataset.keys;
    if (labels.length <= 1) {
      el.replaceChildren(document.createTextNode(labels[0] ?? ''));
      return;
    }
    // Alternatives: one nested <kbd> per key, read as "or", drawn as a slash.
    const parts = [];
    labels.forEach((text, i) => {
      if (i) {
        const sep = document.createElement('span');
        sep.className = 'ui-kbd-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '/';
        const or = document.createElement('span');
        or.className = 'sr-only';
        or.textContent = ' or ';
        parts.push(sep, or);
      }
      const key = document.createElement('kbd');
      key.className = 'ui-kbd-key';
      key.textContent = text;
      parts.push(key);
    });
    el.replaceChildren(...parts);
  }

  function set(partial = {}) {
    const prev = props;
    props = {...prev, ...partial};
    applyCommon(el, props, prev);
    render();
    if (props.hint) el.dataset.hint = ''; else delete el.dataset.hint;
    if (props.force) el.dataset.force = ''; else delete el.dataset.force;
    syncHidden();
  }

  function destroy() {
    mql?.removeEventListener?.('change', onMedia);
    el.remove();
  }

  set({force: false, hint: false, ...initial});
  return {el, set, destroy};
}
