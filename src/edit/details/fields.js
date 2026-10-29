// Edit · Details fields (spec §5.3; ported from src/js/song-metadata.js:6-68): which fields there are,
// how each is grouped and shown, how a stored value reads and compares, and one field row (a src/ui
// Field primitive plus the row's inline status and its aside: Revert, or Apply to N songs).
//
//   FIELDS[key]        → {key, label, group: 'song'|'practice', kind: 'text'|'textarea'|'chips', wide, required, …}
//   GROUPS             → {song: [key…], practice: [key…]}   (the page's order, FIELD_KEYS without artwork)
//   storedValue(song, key)        the value a song holds: '' for a missing text, [] for missing tags
//   commonValue(songs, key)       → {mixed: false, value} | {mixed: true, value: '' | []}   (bulk)
//   isSame(key, a, b)             shared/metadata.ts#sameValue (G1: an unchanged value never saves)
//   check(key, raw)               shared/metadata.ts#validateField → {value} | {error}
//   errorText(err), errorField(err)   a failed save's sentence (a field error's labelled copy, else §3.6) and field
//   createField(key, {value, placeholder, hint, onCommit(value), onInput(value), debounceMs}) → FieldRow
//
// FieldRow = {key, def, el, control, input, get value, dirty(), focused(), set(value), flush(),
//             status(null|'saving'|'saved'|{error}), error(message|null), hint(text|null), aside: Element, destroy()}
//   onCommit runs on blur and Enter (text), after 1 s idle, on blur and on flush() (notes), and on
//   every chip change (tags); `set(value)` never replaces text the user typed and has not committed.

import {Textarea, TextField, ChipInput, STATUS_TEXT, SAVED_MS, FADE_MS} from '../../ui/field.js';
import {h} from '../../ui/h.js';
import {describeError} from '../../app/error-copy.js';
import {FIELD_KEYS, LABELS, LIMITS, maxLength, sameValue, validateField} from '../../../shared/metadata.ts';
import {COPY} from './details.copy.js';

/** Notes save after this much idle typing (G15), and on blur, unmount and pagehide. */
export const NOTES_DEBOUNCE_MS = 1000;

const SONG = ['title', 'artist', 'album', 'albumArtist', 'year', 'genre', 'trackNumber', 'discNumber'];
const PRACTICE = ['musicalKey', 'tuning', 'tags', 'notes'];
export const GROUPS = Object.freeze({song: Object.freeze(SONG), practice: Object.freeze(PRACTICE)});
/** Every text and tag field, in page order (FIELD_KEYS without artwork). */
export const FIELD_ORDER = Object.freeze(FIELD_KEYS.filter((k) => k !== 'artwork'));

const def = (key, more = {}) => Object.freeze({
  key, label: LABELS[key], group: SONG.includes(key) ? 'song' : 'practice', kind: 'text', wide: false, required: false,
  maxLength: key === 'tags' ? undefined : maxLength(key), inputmode: undefined, autocomplete: 'off', ...more,
});

export const FIELDS = Object.freeze({
  title: def('title', {wide: true, required: true}),
  artist: def('artist'),
  album: def('album'),
  albumArtist: def('albumArtist'),
  year: def('year', {inputmode: 'numeric', maxLength: 4}),
  genre: def('genre'),
  trackNumber: def('trackNumber', {inputmode: 'numeric', maxLength: 4}),
  discNumber: def('discNumber', {inputmode: 'numeric', maxLength: 4}),
  musicalKey: def('musicalKey', {placeholder: COPY.placeholders.musicalKey}),
  tuning: def('tuning', {placeholder: COPY.placeholders.tuning}),
  tags: def('tags', {kind: 'chips', wide: true, placeholder: COPY.placeholders.tags, hint: COPY.hints.tags}),
  notes: def('notes', {kind: 'textarea', wide: true, placeholder: COPY.placeholders.notes, hint: COPY.hints.notes}),
});

/** The value a song holds for `key` ('' for a missing text, [] for missing tags, null for no artwork choice). */
export function storedValue(song, key) {
  const v = song?.[key];
  if (key === 'tags') return Array.isArray(v) ? v.filter((t) => typeof t === 'string') : [];
  if (key === 'artwork') return v && typeof v === 'object' ? v : null;
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** The shared value of `key` over songs (bulk), or mixed (from song-metadata.js#commonValue; tags compare as lists). */
export function commonValue(songs, key) {
  const list = songs ?? [];
  if (!list.length) return {mixed: false, value: key === 'tags' ? [] : ''};
  const first = storedValue(list[0], key);
  const mixed = list.some((s) => !sameValue(key, storedValue(s, key), first));
  return mixed ? {mixed: true, value: key === 'tags' ? [] : ''} : {mixed: false, value: first};
}

export const isSame = (key, a, b) => sameValue(key, a, b);

/** Client validation with the server's rules and copy: {value} (cleaned) or {error}. */
export function check(key, raw) {
  const result = validateField(key, raw);
  return 'error' in result ? {error: result.error} : {value: result.value};
}

/** One sentence for a failed save or lookup: a field error's labelled copy, else the §3.6 sentence. */
export function errorText(err) {
  if (err?.code === 'invalid' && typeof err.message === 'string' && err.message) return err.message;
  return describeError(err, {context: 'save'}).sentence;
}

/** The field a coded 'invalid' error names (`data.field`), if it is one of ours. */
export const errorField = (err) => (err?.code === 'invalid' && typeof err?.data?.field === 'string' ? err.data.field : null);

/** Tags as the chip input shows them (the stored list, capped at the server's limit). */
const chipValues = (v) => (Array.isArray(v) ? v.slice(0, LIMITS.tags) : []);

/** One field row. See the header. */
export function createField(key, {value, placeholder, hint, onCommit, onInput, debounceMs = NOTES_DEBOUNCE_MS} = {}) {
  const d = FIELDS[key];
  if (!d) throw new RangeError(`createField: unknown field ${JSON.stringify(key)}`);
  const ph = placeholder ?? d.placeholder;
  const baseHint = hint !== undefined ? hint : d.hint;
  let shown = d.kind === 'chips' ? chipValues(value) : String(value ?? '');
  let control;
  if (d.kind === 'textarea') {
    control = Textarea({label: d.label, value: shown, rows: 5, maxLength: d.maxLength, debounceMs, placeholder: ph, hint: baseHint,
      onInput: (v) => onInput?.(v), onCommit: (v) => { shown = v; onCommit?.(v); }});
  } else if (d.kind === 'chips') {
    control = ChipInput({label: d.label, values: shown, maxItems: LIMITS.tags, maxLength: LIMITS.tag, placeholder: ph, hint: baseHint,
      onChange: (v) => { shown = v; onInput?.(v); onCommit?.(v); }});
  } else {
    control = TextField({label: d.label, value: shown, maxLength: d.maxLength, inputmode: d.inputmode, autocomplete: d.autocomplete,
      placeholder: ph, hint: baseHint, onInput: (v) => onInput?.(v), onCommit: (v) => { shown = v; onCommit?.(v); }});
  }
  const input = control.input;
  if (d.required) input.setAttribute('aria-required', 'true');
  input.setAttribute('name', key);

  // The row after the control: the chip input's own inline status (the other primitives have one), then the aside.
  const row = control.el.querySelector('.ui-field-row') ?? control.el;
  let chipStatus = null, chipTimer = null;
  if (d.kind === 'chips') {
    chipStatus = h('span', {class: 'details-chip-status', attrs: {role: 'status'}});
    row.append(chipStatus);
  }
  const aside = h('span', {class: 'details-field-aside'});
  row.append(aside);
  const el = h('div', {class: 'details-field', dataset: {key, kind: d.kind, wide: d.wide || null, required: d.required || null}}, control.el);

  function setChipStatus(s) {
    clearTimeout(chipTimer);
    chipTimer = null;
    const isError = s && typeof s === 'object';
    chipStatus.textContent = isError ? String(s.error ?? '') : STATUS_TEXT[s] ?? '';
    chipStatus.dataset.tone = isError ? 'error' : s === 'saved' ? 'ok' : s ? 'info' : '';
    chipStatus.setAttribute('role', isError ? 'alert' : 'status');
    chipStatus.removeAttribute('data-fading');
    if (s === 'saved') {
      chipTimer = setTimeout(() => {
        chipStatus.setAttribute('data-fading', '');
        chipTimer = setTimeout(() => { chipStatus.textContent = ''; chipStatus.removeAttribute('data-fading'); chipTimer = null; }, FADE_MS);
      }, SAVED_MS);
    }
  }

  const doc = () => el.ownerDocument;
  return {
    key, def: d, el, control, input, aside,
    get value() { return control.value; },
    /** Typed and not committed yet (a text field; chips commit at once). */
    dirty() { return d.kind !== 'chips' && control.value !== shown; },
    focused() { const a = doc()?.activeElement; return !!a && el.contains(a); },
    set(next) {
      if (d.kind === 'chips') {
        const values = chipValues(next);
        if (!sameValue('tags', values, control.value)) control.set({values});
        shown = values;
        return;
      }
      shown = String(next ?? '');
      control.set({value: shown});
    },
    /** Replaces the shown text even when typed (Revert, a bulk reset). */
    reset(next) {
      if (d.kind === 'chips') { this.set(next); return; }
      shown = String(next ?? '');
      control.input.value = shown;
      control.set({value: shown});
    },
    flush() { control.flush?.(); },
    status(s) { if (chipStatus) setChipStatus(s); else control.set({status: s}); },
    error(message) { control.set({error: message || null}); },
    hint(text) { control.set({hint: text ?? baseHint ?? null}); },
    placeholder(text) { control.set({placeholder: text ?? d.placeholder}); },
    destroy() { clearTimeout(chipTimer); control.destroy(); el.remove(); },
  };
}
