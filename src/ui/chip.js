// Chip and ChipGroup (architecture §2.12, spec §8.8).
//
//   Chip({label, pressed, removable, onRemove(e), onClick(e), tone, icon, badge, removeLabel, …common props})
//     → {el, set(partial), destroy()}
//   A chip with `onClick` or a boolean `pressed` is a toggle button (aria-pressed when pressed is
//   boolean); otherwise its label is plain text. `removable` adds a ✕ button named
//   "Remove <label>" (or `removeLabel`) that calls onRemove. `tone`: neutral | accent | ok | warn |
//   danger. `badge` adds a small text badge after the label (ChipGroup's `primary`).
//
//   ChipGroup({options: [{value, label, icon?, disabled?}], value, multiple = false, clearable = true,
//              onChange(value), label, primary?, …common props}) → {el, value, set(partial), destroy()}
//   Single-select by default: tapping the chosen chip again clears it (value null) when
//   `clearable`. With `multiple`, value is an array and each chip toggles. `primary` (an option
//   value) badges that chip "Primary" (Instruments). The group is role=group named by `label`.

import '../styles/primitives/chip.css';
import {applyCommon, requireLabel, setAttr, setText} from './button.js';
import {icon as makeIcon} from './icon.js';

export const TONES = Object.freeze(['neutral', 'accent', 'ok', 'warn', 'danger']);

export function Chip(props = {}) {
  let p = {tone: 'neutral', ...props};
  const ac = new AbortController();
  const el = document.createElement('span');
  el.className = 'ui-chip';
  let main = null, mainKind = null, iconEl = null, iconName = null, labelEl = null, badgeEl = null, removeBtn = null;
  let prevCommon = {};

  const interactive = () => typeof p.onClick === 'function' || typeof p.pressed === 'boolean';

  function buildMain() {
    const kind = interactive() ? 'button' : 'span';
    if (kind === mainKind) return;
    const next = document.createElement(kind);
    next.className = 'ui-chip-main';
    if (kind === 'button') {
      next.type = 'button';
      next.addEventListener('click', e => {
        if (next.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
        p.onClick?.(e);
      }, {signal: ac.signal});
    }
    labelEl = labelEl ?? document.createElement('span');
    labelEl.className = 'ui-chip-label';
    if (iconEl) next.append(iconEl);
    next.append(labelEl);
    if (badgeEl) next.append(badgeEl);
    if (main) main.replaceWith(next); else el.prepend(next);
    main = next;
    mainKind = kind;
  }

  function render() {
    applyCommon(el, p, prevCommon);
    prevCommon = {className: p.className, id: p.id, attrs: p.attrs, dataset: p.dataset, testid: p.testid};
    buildMain();
    setAttr(el, 'data-tone', TONES.includes(p.tone) ? p.tone : 'neutral');
    setAttr(el, 'data-pressed', p.pressed === true);
    setAttr(el, 'data-interactive', mainKind === 'button');
    if (mainKind === 'button') {
      setAttr(main, 'aria-pressed', typeof p.pressed === 'boolean' ? String(p.pressed) : null);
      setAttr(main, 'aria-disabled', p.disabled ? 'true' : null);
    }
    if ((p.icon ?? null) !== iconName) {
      iconEl?.remove();
      iconEl = p.icon ? makeIcon(p.icon, {size: 20}) : null;
      if (iconEl) main.prepend(iconEl);
      iconName = p.icon ?? null;
    }
    setText(labelEl, p.label);
    if (p.badge) {
      if (!badgeEl) {
        badgeEl = document.createElement('span');
        badgeEl.className = 'ui-chip-badge';
        main.append(badgeEl);
      }
      setText(badgeEl, p.badge);
    } else if (badgeEl) { badgeEl.remove(); badgeEl = null; }
    if (p.removable) {
      if (!removeBtn) {
        removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'ui-chip-remove';
        removeBtn.append(makeIcon('x', {size: 20}));
        removeBtn.addEventListener('click', e => p.onRemove?.(e), {signal: ac.signal});
        el.append(removeBtn);
      }
      const name = p.removeLabel ?? `Remove ${p.label ?? ''}`.trim();
      requireLabel('Chip remove button', name);
      setAttr(removeBtn, 'aria-label', name);
    } else if (removeBtn) { removeBtn.remove(); removeBtn = null; }
  }

  render();

  return {
    el,
    /** The chip's focusable part (its toggle button, else its remove button), or null. */
    get focusTarget() { return mainKind === 'button' ? main : removeBtn; },
    set(partial = {}) {
      p = {...p, ...partial};
      render();
    },
    destroy() {
      ac.abort();
      el.remove();
    },
  };
}

export function ChipGroup(props = {}) {
  let p = {multiple: false, clearable: true, options: [], ...props};
  const el = document.createElement('div');
  el.className = 'ui-chip-group';
  el.setAttribute('role', 'group');
  const chips = new Map();   // key → Chip
  let prevCommon = {};
  const keyOf = v => JSON.stringify(v ?? null);
  let value = normalise(p.value);

  function normalise(v) {
    if (p.multiple) return Array.isArray(v) ? [...v] : v == null ? [] : [v];
    return v ?? null;
  }

  const isOn = v => (p.multiple ? value.some(x => keyOf(x) === keyOf(v)) : value != null && keyOf(value) === keyOf(v));

  function toggle(option) {
    if (option.disabled) return;
    if (p.multiple) {
      value = isOn(option.value) ? value.filter(x => keyOf(x) !== keyOf(option.value)) : [...value, option.value];
    } else if (isOn(option.value)) {
      if (!p.clearable) return;
      value = null;
    } else {
      value = option.value;
    }
    render();
    p.onChange?.(p.multiple ? [...value] : value);
  }

  function render() {
    applyCommon(el, p, prevCommon);
    prevCommon = {className: p.className, id: p.id, attrs: p.attrs, dataset: p.dataset, testid: p.testid};
    if (!p.attrs?.['aria-labelledby']) requireLabel('ChipGroup', p.label);
    setAttr(el, 'aria-label', p.label);
    setAttr(el, 'data-multiple', !!p.multiple);
    const live = new Set();
    (p.options ?? []).forEach((option, i) => {
      const k = keyOf(option.value);
      live.add(k);
      const chipProps = {
        label: option.label,
        icon: option.icon,
        pressed: isOn(option.value),
        disabled: !!option.disabled,
        tone: option.tone ?? 'neutral',
        badge: p.primary !== undefined && p.primary !== null && keyOf(p.primary) === k ? 'Primary' : null,
        onClick: () => toggle(option),
      };
      let chip = chips.get(k);
      if (!chip) { chip = Chip(chipProps); chips.set(k, chip); } else chip.set(chipProps);
      if (el.children[i] !== chip.el) el.insertBefore(chip.el, el.children[i] ?? null);
    });
    for (const [k, chip] of chips) if (!live.has(k)) { chip.destroy(); chips.delete(k); }
  }

  render();

  return {
    el,
    get value() { return p.multiple ? [...value] : value; },
    set(partial = {}) {
      p = {...p, ...partial};
      if ('value' in partial || 'multiple' in partial) value = normalise('value' in partial ? partial.value : value);
      render();
    },
    destroy() {
      for (const chip of chips.values()) chip.destroy();
      chips.clear();
      el.remove();
    },
  };
}
