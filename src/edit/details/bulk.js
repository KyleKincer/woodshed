// Edit · Details in bulk mode (spec §5.3 "Bulk", D34, maps/meta-css-backend.md G9, G10): the route
// /edit/details?ids=a,b,c (≤ 100, from the Library selection) inside the bulk posture bar
// ("Editing details · {n} songs", Done → back to the selection; src/edit/edit.js#mountBulkPostureBar).
//
//   mountBulk(el, {ids, ctx, deps}) → {el, update(match), unmount()}
//   parseIds(raw) → string[]   (split on commas, trimmed, deduplicated, at most LIMITS.bulk)
//
// The songs come from songs.getMany (full rows: notes and tags too). Every Song and Practice field shows
// the value the songs share, or is empty with the placeholder "Multiple values — unchanged". Nothing saves
// on blur here: each field has its own [Apply to N songs] (one metadata.update over every id, after the
// client check), then "Applied to N songs" and Revert, which puts back each song's own earlier value and
// lock through metadata.updateEach. Applying an empty value clears the field everywhere, so a field
// with mixed values says so once it has been touched. Artwork and Match are per song (single mode).

import {Button} from '../../ui/button.js';
import {h} from '../../ui/h.js';
import {InlineStatus} from '../../ui/status.js';
import {LIMITS} from '../../../shared/metadata.ts';
import {mountBulkPostureBar} from '../edit.js';
import {COPY} from './details.copy.js';
import {FIELDS, GROUPS, check, commonValue, createField, errorField, errorText, isSame, storedValue} from './fields.js';

/** How many song titles the intro names before "and N others". */
export const NAMED_TITLES = 3;

export function parseIds(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const out = [];
  for (const part of list) {
    const id = String(part ?? '').trim();
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= LIMITS.bulk) break;
  }
  return out;
}

const locksOf = (song) => new Set(Array.isArray(song?.metadataLocks) ? song.metadataLocks : []);
const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

export function mountBulk(el, {ids, ctx = {}, deps}) {
  const {metadata, songs: songsApi} = deps;
  const router = ctx.router ?? null;
  let current = [...ids];
  let unmounted = false;
  let loadSeq = 0;
  let songs = [];
  const rows = new Map();   // key → {row, apply, revert, applied, touched, originals, busy}
  let inFlight = 0, lastError = false, anySaved = false;

  const root = h('div', {class: 'details-bulk-page', attrs: {'data-scroller': ''}});
  el.append(root);
  const bar = mountBulkPostureBar(root, {count: current.length, router, registry: ctx.registry, platform: ctx.platform});
  const content = h('div', {class: 'details', dataset: {mode: 'bulk'}});
  root.append(content);

  const report = () => {
    if (unmounted) return;
    bar.saveStatus.value = inFlight > 0 ? {state: 'saving', text: COPY.applying}
      : lastError ? {state: 'error', text: COPY.saveFailed} : anySaved ? {state: 'saved', text: COPY.saved} : null;
  };
  const announce = (text) => { try { deps.announce?.(text); } catch { /* best effort */ } };
  const disposables = [];

  function clear() {
    for (const r of rows.values()) { r.apply.destroy(); r.revert.destroy(); r.row.destroy(); }
    rows.clear();
    for (const d of disposables.splice(0)) { try { d.destroy(); } catch { /* gone */ } }
    content.replaceChildren();
  }

  function showLoading() {
    clear();
    content.append(h('div', {class: 'details-page details-page-bulk'},
      h('p', {class: 'details-loading', attrs: {role: 'status'}}, COPY.loading)));
  }

  function showError(err) {
    clear();
    const status = InlineStatus({tone: 'error', text: [COPY.loadFailed, ' ', errorText(err)].join(''), action: {label: COPY.tryAgain, run: () => { loaded = load(); }}});
    disposables.push(status);
    content.append(h('div', {class: 'details-page details-page-bulk'}, status.el));
  }

  function showNone() {
    clear();
    const link = h('a', {class: 'details-none-link', href: '/'}, COPY.backToLibrary);
    link.addEventListener('click', (e) => {
      if (!router || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      void router.navigate?.('/', {replace: true});
    });
    content.append(h('div', {class: 'details-page details-page-bulk'},
      h('div', {class: 'details-none', attrs: {role: 'alert'}},
        h('h2', {class: 'details-heading'}, COPY.noneTitle), h('p', {}, COPY.none), link)));
  }

  // ---------------- one field row ----------------
  function makeRow(key) {
    const n = songs.length;
    const common = commonValue(songs, key);
    const r = {key, row: null, apply: null, revert: null, appliedEl: null, applied: false, touched: false, mixed: common.mixed,
      shown: common.value, originals: null, busy: false};
    r.row = createField(key, {value: common.value, placeholder: common.mixed ? COPY.mixed : undefined, onInput: () => { r.touched = true; sync(r); }});
    r.apply = Button({label: COPY.apply(n), variant: 'secondary', size: 'sm', className: 'details-apply', disabled: true,
      onClick: () => { void apply(r); }});
    r.appliedEl = h('span', {class: 'details-applied', attrs: {role: 'status'}});
    r.revert = Button({label: COPY.revert, icon: 'undo-2', variant: 'quiet', size: 'sm', className: 'details-bulk-revert',
      attrs: {'aria-label': COPY.revertBulk(FIELDS[key].label)}, onClick: () => { void revert(r); }});
    r.revert.el.hidden = true;
    r.row.aside.append(r.apply.el);
    r.row.el.append(h('div', {class: 'details-applied-row'}, r.appliedEl, r.revert.el));
    rows.set(key, r);
    sync(r);
    return r.row.el;
  }

  /** Apply is enabled once the field was edited (a mixed field: touched at all; else: changed from the shared value). */
  function canApply(r) {
    if (r.busy || !r.touched) return false;
    return r.mixed ? true : !isSame(r.key, r.shown, r.row.value);
  }

  function sync(r) {
    r.apply.set({disabled: !canApply(r)});
    const empty = r.key === 'tags' ? !r.row.value.length : !String(r.row.value).trim();
    r.row.hint(r.mixed && r.touched && empty ? COPY.clearsAll(songs.length) : undefined);
  }

  async function apply(r) {
    if (!canApply(r) || unmounted) return;
    const c = check(r.key, r.row.value);
    if ('error' in c) { r.row.error(c.error); return; }
    r.row.error(null);
    // Revert goes back to what the songs held before the first Apply of this field.
    const before = songs.map((s) => ({id: s.id, value: storedValue(s, r.key), locked: locksOf(s).has(r.key)}));
    r.busy = true;
    inFlight++;
    r.apply.set({busy: COPY.applying, disabled: true});
    report();
    try {
      await metadata.update({ids: songs.map((s) => s.id), changes: {[r.key]: c.value}});
      if (unmounted) return;
      r.originals ??= before;
      for (const s of songs) {
        s[r.key] = structuredClone(c.value);
        s.metadataLocks = [...new Set([...(s.metadataLocks ?? []), r.key])];
      }
      r.mixed = false;
      r.shown = c.value;
      r.touched = false;
      r.row.reset(c.value);
      r.row.placeholder(undefined);
      r.applied = true;
      r.appliedEl.textContent = COPY.appliedTo(songs.length);
      r.revert.el.hidden = false;
      anySaved = true;
      lastError = false;
      announce(COPY.appliedTo(songs.length));
    } catch (err) {
      if (unmounted) return;
      lastError = true;
      if (errorField(err) === r.key) r.row.error(errorText(err));
      else r.row.status({error: errorText(err)});
    } finally {
      r.busy = false;
      inFlight--;
      if (!unmounted) { r.apply.set({busy: false}); sync(r); report(); }
    }
  }

  async function revert(r) {
    if (!r.originals || r.busy || unmounted) return;
    const originals = r.originals;
    r.busy = true;
    inFlight++;
    r.revert.set({busy: true, disabled: true});
    report();
    try {
      await metadata.updateEach({items: originals.map((o) => ({id: o.id, changes: {[r.key]: o.value}, unlock: o.locked ? [] : [r.key]}))});
      if (unmounted) return;
      const byId = new Map(originals.map((o) => [o.id, o]));
      for (const s of songs) {
        const o = byId.get(s.id);
        if (!o) continue;
        s[r.key] = structuredClone(o.value);
        const locks = locksOf(s);
        if (o.locked) locks.add(r.key); else locks.delete(r.key);
        s.metadataLocks = [...locks];
      }
      const common = commonValue(songs, r.key);
      r.originals = null;
      r.mixed = common.mixed;
      r.shown = common.value;
      r.touched = false;
      r.row.reset(common.value);
      r.row.placeholder(common.mixed ? COPY.mixed : undefined);
      r.row.error(null);
      r.applied = false;
      r.appliedEl.textContent = COPY.reverted;
      r.revert.el.hidden = true;
      announce(COPY.reverted);
      r.row.input.focus({preventScroll: true});
    } catch (err) {
      if (unmounted) return;
      lastError = true;
      r.row.status({error: errorText(err)});
    } finally {
      r.busy = false;
      inFlight--;
      if (!unmounted) { r.revert.set({busy: false, disabled: false}); sync(r); report(); }
    }
  }

  // ---------------- the page ----------------
  function render(missing) {
    clear();
    const n = songs.length;
    const titles = songs.slice(0, NAMED_TITLES).map((s) => s.title || '');
    const section = (group) => {
      const id = `details-bulk-${group}-heading`;
      return h('section', {class: 'details-section', dataset: {group}, attrs: {'aria-labelledby': id}},
        h('h2', {class: 'details-heading', id}, COPY.groups[group]),
        h('div', {class: 'details-grid details-grid-bulk'}, ...GROUPS[group].map(makeRow)));
    };
    let missingEl = null;
    if (missing > 0) {
      const s = InlineStatus({tone: 'warn', text: COPY.missing(missing), className: 'details-missing'});
      disposables.push(s);
      missingEl = s.el;
    }
    content.append(h('div', {class: 'details-page details-page-bulk'},
      h('div', {class: 'details-bulk-intro'},
        h('p', {class: 'details-bulk-songs selectable'}, COPY.bulkSongs(titles, Math.max(0, n - titles.length))),
        h('p', {class: 'details-hint'}, COPY.bulkIntro(n)),
        missingEl),
      section('song'),
      section('practice')));
  }

  async function load() {
    const mine = ++loadSeq;
    if (!current.length) { bar.set({count: 0}); showNone(); return; }
    showLoading();
    let found;
    try {
      found = await songsApi.getMany({ids: current});
    } catch (err) {
      if (mine !== loadSeq || unmounted) return;
      showError(err);
      return;
    }
    if (mine !== loadSeq || unmounted) return;
    const byId = new Map((Array.isArray(found) ? found : []).filter((s) => s?.id).map((s) => [s.id, structuredClone(s)]));
    songs = current.map((id) => byId.get(id)).filter(Boolean);
    bar.set({count: songs.length});
    if (!songs.length) { showNone(); return; }
    render(current.length - songs.length);
  }

  let loaded = load();

  return {
    el: root,
    get songs() { return songs; },
    /** Settles once the current ids are loaded (or failed). */
    get loaded() { return loaded; },
    update(match) {
      if (unmounted) return;
      const next = parseIds(match?.query?.ids);
      if (sameIds(next, current)) return;
      current = next;
      bar.set({count: current.length});
      loaded = load();
    },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      loadSeq++;
      clear();
      bar.destroy();
      root.remove();
    },
  };
}
