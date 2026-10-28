// Fields (architecture §2.12, spec §8.8 "Field"): TextField, Select, Textarea and ChipInput, each
// with a visible label, an optional hint and an error. The error sets aria-invalid and is linked
// with aria-describedby and aria-errormessage; the hint is linked with aria-describedby.
//
//   TextField({label, value, hint, error, placeholder, maxLength, pattern, inputmode, autocomplete,
//              type = 'text', onInput(value), onCommit(value), status, size, disabled, …common props})
//     onCommit runs on Enter and on blur, only when the value differs from the last committed one.
//     set({value}) moves the committed baseline but keeps text the user has typed and not committed.
//     status: null | 'saving' | 'saved' | {error}: inline after the field ("Saving…", "Saved", the
//     error); "Saved" fades after SAVED_MS (2 s).
//   Select({label, options: [{value, label, disabled?}] | [{label, options: […]}], value, onChange(value),
//           hint, error, size, disabled, …common props})        a native <select>, styled;
//     `value` is undefined while no option is selected
//   Textarea({label, value, rows = 3, maxLength, debounceMs = 600, onInput(value), onCommit(value), status,
//             hint, error, placeholder, …common props}) → {…, flush()}
//     onCommit runs when typing has been idle for debounceMs, on blur and on flush(), only on change.
//   ChipInput({label, values, maxItems = 30, maxLength = 60, caseInsensitive = true, onChange(values),
//              hint, placeholder, …common props})
//     A value is committed on Enter, a comma (typed or pasted) or blur; Backspace in the empty input
//     removes the last chip; every chip has a ✕ named "Remove <value>". Duplicates (case-insensitive
//     by default), values over maxLength and values past maxItems are refused with a polite note;
//     refused typed text stays in the input.
// Every factory returns {el, input, value, set(partial), destroy()} (`input` is the native control).

import '../styles/primitives/field.css';
import {applyCommon, requireLabel, setAttr, setText, uid} from './button.js';
import {Chip} from './chip.js';

export const SAVED_MS = 2000;
/** How long "Saved" takes to fade out once SAVED_MS has passed (--motion-slow). */
export const FADE_MS = 260;
export const STATUS_TEXT = Object.freeze({saving: 'Saving…', saved: 'Saved'});

/** The shared frame: label, control slot, hint, error and an optional inline status. */
function frame(kind, p, control, {status = false} = {}) {
  const el = document.createElement('div');
  el.className = 'ui-field';
  el.setAttribute('data-field', kind);
  const id = uid(`ui-${kind}`);
  const label = document.createElement('label');
  label.className = 'ui-field-label';
  label.htmlFor = id;
  const row = document.createElement('div');
  row.className = 'ui-field-row';
  const hint = document.createElement('p');
  hint.className = 'ui-field-hint';
  hint.id = `${id}-hint`;
  const error = document.createElement('p');
  error.className = 'ui-field-error';
  error.id = `${id}-error`;
  const statusEl = status ? document.createElement('span') : null;
  if (statusEl) {
    statusEl.className = 'ui-field-status';
    statusEl.id = `${id}-status`;
    statusEl.setAttribute('role', 'status');
  }
  row.append(control);
  if (statusEl) row.append(statusEl);
  el.append(label, row, hint, error);
  let prevCommon = {};
  let savedTimer = null;
  let input = control;

  return {
    el, id, row, hint, error, statusEl,
    bind(target) {
      input = target;
      input.id = id;
    },
    render(q) {
      applyCommon(el, q, prevCommon);
      prevCommon = {className: q.className, id: q.id, attrs: q.attrs, dataset: q.dataset, testid: q.testid};
      requireLabel(kind, q.label);
      setText(label, q.label);
      setAttr(el, 'data-size', q.size ?? 'md');
      setText(hint, q.hint ?? '');
      hint.hidden = !q.hint;
      const err = typeof q.error === 'string' && q.error ? q.error : '';
      setText(error, err);
      error.hidden = !err;
      setAttr(el, 'data-invalid', !!err);
      setAttr(input, 'aria-invalid', err ? 'true' : null);
      setAttr(input, 'aria-errormessage', err ? error.id : null);
      const described = [q.hint ? hint.id : null, err ? error.id : null, statusEl && statusEl.textContent ? statusEl.id : null];
      setAttr(input, 'aria-describedby', described.filter(Boolean).join(' ') || null);
      setAttr(input, 'disabled', !!q.disabled);
    },
    status(value) {
      if (!statusEl) return;
      clearTimeout(savedTimer);
      savedTimer = null;
      const isError = value && typeof value === 'object';
      const text = isError ? String(value.error ?? '') : STATUS_TEXT[value] ?? '';
      setText(statusEl, text);
      setAttr(statusEl, 'data-tone', isError ? 'error' : value === 'saved' ? 'ok' : value ? 'info' : null);
      setAttr(statusEl, 'role', isError ? 'alert' : 'status');
      statusEl.removeAttribute('data-fading');
      if (value === 'saved') {
        savedTimer = setTimeout(() => {
          statusEl.setAttribute('data-fading', '');
          savedTimer = setTimeout(() => { setText(statusEl, ''); statusEl.removeAttribute('data-fading'); savedTimer = null; }, FADE_MS);
        }, SAVED_MS);
      }
    },
    dispose() { clearTimeout(savedTimer); el.remove(); },
  };
}

// ---------------------------------------------------------------------------------------------
// TextField

export function TextField(props = {}) {
  let p = {type: 'text', size: 'md', ...props};
  const ac = new AbortController();
  const input = document.createElement('input');
  input.className = 'ui-field-input';
  const f = frame('textfield', p, input, {status: true});
  f.bind(input);
  let committed = String(p.value ?? '');
  input.value = committed;

  function render() {
    f.render(p);
    setAttr(input, 'type', p.type || 'text');
    setAttr(input, 'placeholder', p.placeholder);
    setAttr(input, 'maxlength', p.maxLength);
    setAttr(input, 'pattern', p.pattern);
    setAttr(input, 'inputmode', p.inputmode);
    setAttr(input, 'autocomplete', p.autocomplete);
  }

  function commit() {
    if (input.value === committed) return;
    committed = input.value;
    p.onCommit?.(committed);
  }

  input.addEventListener('input', () => p.onInput?.(input.value), {signal: ac.signal});
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    commit();
  }, {signal: ac.signal});
  input.addEventListener('blur', commit, {signal: ac.signal});

  f.status(p.status ?? null);
  render();

  return {
    el: f.el,
    input,
    get value() { return input.value; },
    set(partial = {}) {
      p = {...p, ...partial};
      if ('value' in partial) {
        // Uncommitted typing wins over a re-render that passes the stored value: only the
        // baseline moves, so blur or Enter still commits what the user typed.
        const dirty = input.value !== committed;
        committed = String(partial.value ?? '');
        if (!dirty && input.value !== committed) input.value = committed;
      }
      if ('status' in partial) f.status(partial.status);
      render();
    },
    destroy() { ac.abort(); f.dispose(); },
  };
}

// ---------------------------------------------------------------------------------------------
// Select

export function Select(props = {}) {
  let p = {size: 'md', options: [], ...props};
  const ac = new AbortController();
  const select = document.createElement('select');
  select.className = 'ui-field-input ui-field-select';
  const f = frame('select', p, select);
  f.bind(select);
  let flat = [];   // option values in DOM order
  let builtFrom = null;

  function buildOptions() {
    if (builtFrom === p.options) return;
    builtFrom = p.options;
    flat = [];
    const make = o => {
      const opt = document.createElement('option');
      opt.value = String(flat.length);
      opt.textContent = o.label;
      opt.disabled = !!o.disabled;
      flat.push(o.value);
      return opt;
    };
    select.replaceChildren(...(p.options ?? []).map(o => {
      if (Array.isArray(o.options)) {
        const group = document.createElement('optgroup');
        group.label = o.label;
        group.append(...o.options.map(make));
        return group;
      }
      return make(o);
    }));
  }

  const keyOf = v => JSON.stringify(v ?? null);
  function syncValue() {
    const i = flat.findIndex(v => keyOf(v) === keyOf(p.value));
    select.selectedIndex = i;
  }

  select.addEventListener('change', () => {
    const v = flat[Number(select.value)];
    p = {...p, value: v};
    p.onChange?.(v);
  }, {signal: ac.signal});

  function render() {
    buildOptions();
    f.render(p);
    syncValue();
  }
  render();

  return {
    el: f.el,
    input: select,
    get value() { return select.selectedIndex < 0 ? undefined : flat[Number(select.value)]; },
    set(partial = {}) { p = {...p, ...partial}; render(); },
    destroy() { ac.abort(); f.dispose(); },
  };
}

// ---------------------------------------------------------------------------------------------
// Textarea

export function Textarea(props = {}) {
  let p = {rows: 3, debounceMs: 600, size: 'md', ...props};
  const ac = new AbortController();
  const area = document.createElement('textarea');
  area.className = 'ui-field-input ui-field-textarea';
  const f = frame('textarea', p, area, {status: true});
  f.bind(area);
  const count = document.createElement('span');
  count.className = 'ui-field-count';
  count.setAttribute('aria-hidden', 'true');
  f.el.append(count);
  let committed = String(p.value ?? '');
  area.value = committed;
  let timer = null;

  function render() {
    f.render(p);
    setAttr(area, 'rows', p.rows);
    setAttr(area, 'maxlength', p.maxLength);
    setAttr(area, 'placeholder', p.placeholder);
    setText(count, p.maxLength ? `${area.value.length} / ${p.maxLength}` : '');
    count.hidden = !p.maxLength;
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (area.value === committed) return;
    committed = area.value;
    p.onCommit?.(committed);
  }

  area.addEventListener('input', () => {
    p.onInput?.(area.value);
    if (p.maxLength) setText(count, `${area.value.length} / ${p.maxLength}`);
    clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, Number(p.debounceMs) || 0));
  }, {signal: ac.signal});
  area.addEventListener('blur', flush, {signal: ac.signal});

  f.status(p.status ?? null);
  render();

  return {
    el: f.el,
    input: area,
    get value() { return area.value; },
    flush,
    set(partial = {}) {
      p = {...p, ...partial};
      if ('value' in partial) {
        // Uncommitted typing wins (the pending commit keeps running); otherwise take the new value.
        const dirty = area.value !== committed;
        committed = String(partial.value ?? '');
        if (!dirty && area.value !== committed) area.value = committed;
      }
      if ('status' in partial) f.status(partial.status);
      render();
    },
    destroy() { clearTimeout(timer); ac.abort(); f.dispose(); },
  };
}

// ---------------------------------------------------------------------------------------------
// ChipInput

export function ChipInput(props = {}) {
  let p = {maxItems: 30, maxLength: 60, caseInsensitive: true, size: 'md', ...props};
  const ac = new AbortController();
  const opts = {signal: ac.signal};
  const box = document.createElement('div');
  box.className = 'ui-chip-input';
  const list = document.createElement('ul');
  list.className = 'ui-chip-input-list';
  list.setAttribute('role', 'list');
  const input = document.createElement('input');
  input.className = 'ui-chip-input-field';
  input.type = 'text';
  input.setAttribute('enterkeyhint', 'done');
  box.append(list, input);
  const f = frame('chipinput', p, box);
  f.bind(input);
  const note = document.createElement('p');
  note.className = 'ui-field-note';
  note.setAttribute('role', 'status');
  f.el.append(note);
  let values = [...(p.values ?? [])];
  const items = new Map();   // value → {li, chip}

  const norm = v => (p.caseInsensitive ? v.toLocaleLowerCase() : v);
  const has = v => values.some(x => norm(x) === norm(v));
  const say = text => setText(note, text);

  /** Adds each candidate; returns true when anything was added. */
  function add(candidates) {
    let added = false;
    for (const raw of candidates) {
      const v = String(raw).trim();
      if (!v) continue;
      if (v.length > p.maxLength) { say(`Keep each one to ${p.maxLength} characters.`); continue; }
      if (has(v)) { say(`"${v}" is already there.`); continue; }
      if (values.length >= p.maxItems) { say(`Up to ${p.maxItems}.`); break; }
      values = [...values, v];
      added = true;
      say('');
    }
    if (added) { renderChips(); p.onChange?.([...values]); }
    return added;
  }

  function remove(v, {focus = true} = {}) {
    values = values.filter(x => x !== v);
    renderChips();
    say('');
    p.onChange?.([...values]);
    if (focus) input.focus();
  }

  function renderChips() {
    const live = new Set(values);
    for (const [v, item] of items) if (!live.has(v)) { item.chip.destroy(); item.li.remove(); items.delete(v); }
    values.forEach((v, i) => {
      let item = items.get(v);
      if (!item) {
        const li = document.createElement('li');
        li.className = 'ui-chip-input-item';
        const chip = Chip({label: v, removable: true, removeLabel: `Remove ${v}`, onRemove: () => remove(v)});
        li.append(chip.el);
        item = {li, chip};
        items.set(v, item);
      }
      if (list.children[i] !== item.li) list.insertBefore(item.li, list.children[i] ?? null);
    });
    list.hidden = !values.length;
  }

  /** Commits the typed text; refused text (duplicate, too long, full) stays in the input beside the note. */
  function commitInput() {
    const text = input.value;
    if (!text.trim()) { input.value = ''; return false; }
    const added = add([text]);
    if (added) input.value = '';
    return added;
  }

  input.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (input.value.trim()) { e.preventDefault(); commitInput(); }
    } else if (e.key === ',') {
      e.preventDefault();
      commitInput();
    } else if (e.key === 'Backspace' && input.value === '' && values.length && !e.repeat) {
      e.preventDefault();
      remove(values[values.length - 1], {focus: false});
    }
  }, opts);
  // Pasted or autocorrected text with commas splits into values; the last piece stays in the input.
  input.addEventListener('input', () => {
    if (!input.value.includes(',')) return;
    const parts = input.value.split(',');
    input.value = parts.pop();
    add(parts);
  }, opts);
  input.addEventListener('blur', () => { commitInput(); }, opts);
  box.addEventListener('pointerdown', e => {
    if (e.target === box || e.target === list) { e.preventDefault(); input.focus(); }
  }, opts);

  function render() {
    f.render(p);
    // No maxlength here: the input also takes pasted lists, which the browser would cut before the
    // comma split. add() checks each value's length instead.
    setAttr(input, 'placeholder', p.placeholder);
    setAttr(input, 'disabled', !!p.disabled);
  }

  render();
  renderChips();

  return {
    el: f.el,
    input,
    get value() { return [...values]; },
    set(partial = {}) {
      p = {...p, ...partial};
      if ('values' in partial) { values = [...(partial.values ?? [])]; renderChips(); }
      render();
    },
    destroy() {
      for (const {chip} of items.values()) chip.destroy();
      items.clear();
      ac.abort();
      f.dispose();
    },
  };
}
