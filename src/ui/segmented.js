// Segmented (architecture §2.12, spec §8.8): a radiogroup of option buttons with a roving
// tabindex. Arrow keys move the selection (wrapping, skipping disabled options) and are consumed
// (data-consume-keys), so the dispatcher leaves them to the group; Space, Enter, digits and
// letters still reach the registry. A disabled option keeps its place, explains itself with its
// `reason` (visible below the group when it is chosen or focused, and linked to the option with
// aria-describedby) and is never selected.
//
//   Segmented({options: [{value, label, icon?, disabled?, reason?}], value, onChange(value, {source}), label, size,
//              …common props}) → {el, value, set(partial), destroy()}

import '../styles/primitives/segmented.css';
import {applyCommon, requireLabel, setAttr, setText, uid} from './button.js';
import {icon as makeIcon} from './icon.js';

const ARROWS = 'ArrowLeft ArrowRight ArrowUp ArrowDown';

export function Segmented(props = {}) {
  let p = {size: 'md', options: [], ...props};
  const checkName = () => { if (!p.attrs?.['aria-labelledby']) requireLabel('Segmented', p.label); };
  checkName();
  const ac = new AbortController();
  const el = document.createElement('div');
  el.className = 'ui-segmented';
  el.setAttribute('role', 'radiogroup');
  el.setAttribute('data-consume-keys', ARROWS);
  const row = document.createElement('div');
  row.className = 'ui-segmented-options';
  const note = document.createElement('p');
  note.className = 'ui-segmented-reason';
  note.id = uid('ui-seg-reason');
  note.setAttribute('role', 'status');
  note.hidden = true;
  el.append(row, note);
  const buttons = new Map();   // value key → {btn, option, iconName, label, reasonId}
  let prevCommon = {};
  let value = p.value;
  const keyOf = v => JSON.stringify(v ?? null);

  function showReason(option) {
    const text = option?.disabled && option.reason ? option.reason : '';
    setText(note, text);
    note.hidden = !text;
  }

  function choose(option, source) {
    if (!option || option.disabled) { showReason(option); return; }
    showReason(null);
    if (keyOf(option.value) === keyOf(value)) return;
    value = option.value;
    render();
    p.onChange?.(value, {source});
  }

  function renderOption(option, index, tabbable) {
    const k = keyOf(option.value);
    let entry = buttons.get(k);
    if (!entry) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ui-segmented-option';
      btn.setAttribute('role', 'radio');
      const text = document.createElement('span');
      text.className = 'ui-segmented-label';
      btn.append(text);
      entry = {btn, text, iconEl: null, iconName: null, reasonId: uid('ui-seg-opt')};
      btn.addEventListener('click', e => choose(entry.option, e.detail === 0 ? 'key' : 'pointer'), {signal: ac.signal});
      btn.addEventListener('focus', () => showReason(entry.option?.disabled ? entry.option : null), {signal: ac.signal});
      buttons.set(k, entry);
    }
    entry.option = option;
    const {btn} = entry;
    const checked = keyOf(option.value) === keyOf(value);
    setAttr(btn, 'aria-checked', String(checked));
    setAttr(btn, 'tabindex', tabbable ? '0' : '-1');
    setAttr(btn, 'aria-disabled', option.disabled ? 'true' : null);
    setAttr(btn, 'aria-describedby', option.disabled && option.reason ? note.id : null);
    setAttr(btn, 'data-index', index);
    if ((option.icon ?? null) !== entry.iconName) {
      entry.iconEl?.remove();
      entry.iconEl = option.icon ? makeIcon(option.icon, {size: 20}) : null;
      if (entry.iconEl) btn.prepend(entry.iconEl);
      entry.iconName = option.icon ?? null;
    }
    setText(entry.text, option.label);
    return btn;
  }

  function render() {
    applyCommon(el, p, prevCommon);
    prevCommon = {className: p.className, id: p.id, attrs: p.attrs, dataset: p.dataset, testid: p.testid};
    setAttr(el, 'aria-label', p.label);
    setAttr(el, 'data-size', p.size ?? 'md');
    const options = p.options ?? [];
    const selectedIndex = options.findIndex(o => keyOf(o.value) === keyOf(value) && !o.disabled);
    const tabIndex = selectedIndex >= 0 ? selectedIndex : Math.max(0, options.findIndex(o => !o.disabled));
    const wanted = options.map((o, i) => renderOption(o, i, i === tabIndex));
    const live = new Set(options.map(o => keyOf(o.value)));
    for (const [k, entry] of buttons) if (!live.has(k)) { entry.btn.remove(); buttons.delete(k); }
    wanted.forEach((btn, i) => { if (row.children[i] !== btn) row.insertBefore(btn, row.children[i] ?? null); });
  }

  el.addEventListener('keydown', e => {
    if (!ARROWS.split(' ').includes(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
    const options = p.options ?? [];
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter(i => i >= 0);
    if (!enabled.length) return;
    e.preventDefault();
    const active = el.contains(document.activeElement) ? document.activeElement.closest('.ui-segmented-option') : null;
    const focusedIndex = active ? Number(active.dataset.index) : NaN;
    const from = Number.isFinite(focusedIndex) ? focusedIndex : options.findIndex(o => keyOf(o.value) === keyOf(value));
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const rtl = getComputedStyle?.(el)?.direction === 'rtl' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
    const step = (forward ? 1 : -1) * (rtl ? -1 : 1);
    // From a disabled option (focused by a click that showed its reason) go to the nearest enabled
    // neighbour in the direction of travel, wrapping only when there is none that way.
    let next;
    const pos = enabled.indexOf(from);
    if (pos >= 0) next = enabled[(pos + step + enabled.length) % enabled.length];
    else if (step > 0) next = enabled.find(i => i > from) ?? enabled[0];
    else next = enabled.findLast(i => i < from) ?? enabled[enabled.length - 1];
    choose(options[next], 'key');
    buttons.get(keyOf(options[next].value))?.btn.focus();
  }, {signal: ac.signal});

  render();

  return {
    el,
    get value() { return value; },
    set(partial = {}) {
      p = {...p, ...partial};
      checkName();
      if ('value' in partial) value = partial.value;
      render();
    },
    destroy() {
      ac.abort();
      el.remove();
    },
  };
}
