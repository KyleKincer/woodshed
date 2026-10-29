// Edit · Details (spec §5.3, architecture §2.15, §6.9; maps/meta-css-backend.md §1.6 G1–G17): the song's
// metadata page, in the Edit frame's Details tab, and the same page in bulk mode at /edit/details?ids=.
//
//   mount(el, match{params: {songId}} | {query: {ids}}, ctx) → {update(match), unmount()}
//     Single (the Edit frame's Details tab): ctx.session is the song session (its `song` signal is the
//     live songs.get row); ctx.edit is the frame's 'edit' API (its saveStatus slot shows Saving… / Saved).
//     Without a session the page subscribes to songs.get itself.
//     Bulk (route 'bulkDetails', ?ids=a,b,c, ≤ 100): src/edit/details/bulk.js inside the bulk posture bar.
//   ctx.detailsDeps (tests, harnesses): {metadata, songs, sign, now, decode, objectURL, announce}
//
// Single mode, top to bottom (two columns from 1000 px of page width: Song and Practice beside Artwork and
// Match; one column below, in the spec's order):
// - Song: title*, artist, album, album artist, year, genre, track, disc. Practice: key, tuning, tags
//   (chip input), notes (shown in the Stage Notes card).
// - Each field saves on its own when it is committed (blur or Enter; notes after 1 s idle, on blur, on
//   unmount and on pagehide; tags on every chip change), only when the cleaned value differs from the
//   stored one (G1), after the client check with the server's rules and copy (shared/metadata.ts): an
//   error shows under the field and nothing is sent. "Saving…", then an inline "Saved". No global Save.
// - Revert, for a field this page saved: the value and lock state the page opened with
//   (update with `unlock` when the field was not locked, G2).
// - Live updates (another device, a lookup finishing) fill a field only when it is not focused, has
//   no save in flight, holds no typed text and shows no error (G12).
// - Artwork (artwork.js) and Match (match.js). `#match` in the URL scrolls to Match and focuses it.

import '../../styles/views/edit/details.css';
import * as metadataApi from '../../api/metadata.js';
import * as songsApi from '../../api/songs.js';
import {signKey} from '../../api/media.js';
import {now as clockNow} from '../../app/clock.js';
import * as appFeedback from '../../app/feedback.js';
import {h} from '../../ui/h.js';
import {COPY} from './details.copy.js';
import {FIELDS, GROUPS, check, createField, errorField, errorText, isSame, storedValue} from './fields.js';
import {createArtworkSection} from './artwork.js';
import {createMatchSection} from './match.js';
import {mountBulk, parseIds} from './bulk.js';

export {COPY};

/** The live-and-default dependencies; ctx.detailsDeps replaces any of them. */
export function defaultDeps(win = globalThis.window) {
  const URLs = win?.URL ?? globalThis.URL;
  const bitmap = win?.createImageBitmap ?? globalThis.createImageBitmap;
  return {
    metadata: metadataApi,
    songs: songsApi,
    sign: signKey,
    now: clockNow,
    decode: typeof bitmap === 'function' ? (file) => bitmap.call(win ?? globalThis, file) : null,
    objectURL: {create: (f) => URLs.createObjectURL(f), revoke: (u) => URLs.revokeObjectURL(u)},
    announce: (text) => appFeedback.announce?.(text),
  };
}

const isBulk = (match) => match?.name === 'bulkDetails' || (!match?.params?.songId && match?.query?.ids !== undefined);

export async function mount(el, match, ctx = {}) {
  if (!el) throw new TypeError('details: el is required');
  const win = el.ownerDocument?.defaultView ?? globalThis.window;
  const deps = {...defaultDeps(win), ...(ctx.detailsDeps ?? {})};
  if (isBulk(match)) return mountBulk(el, {ids: parseIds(match?.query?.ids), ctx, deps});
  return mountSingle(el, match, ctx, deps);
}

export default mount;

// ---------------------------------------------------------------------------------------------------------------
// Single mode

const locksOf = (song) => new Set(Array.isArray(song?.metadataLocks) ? song.metadataLocks : []);

function mountSingle(el, match, ctx, deps) {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const session = ctx.session ?? null;
  const songId = session?.id ?? match?.params?.songId;
  const edit = ctx.edit ?? null;
  const {metadata} = deps;
  const offs = [];
  let unmounted = false;

  // ---------------- the song ----------------
  let song = session?.song?.peek?.() ?? null;
  const getSong = () => song;

  // ---------------- the save status in the posture bar ----------------
  let inFlight = 0, lastError = false, anySaved = false;
  function report() {
    if (!edit?.saveStatus || unmounted) return;
    edit.saveStatus.value = inFlight > 0 ? {state: 'saving', text: COPY.saving}
      : lastError ? {state: 'error', text: COPY.saveFailed}
        : anySaved ? {state: 'saved', text: COPY.saved} : null;
  }

  // ---------------- fields ----------------
  const state = new Map();   // key → {row, revert, original, saved, pending, seq, invalid}

  function makeRow(key) {
    const st = {key, row: null, revert: null, original: null, saved: false, pending: 0, seq: 0, invalid: false};
    st.row = createField(key, {value: storedValue(song, key), onCommit: (v) => commit(key, v)});
    const label = FIELDS[key].label;
    st.revert = h('button', {type: 'button', class: 'details-revert', hidden: true, attrs: {'aria-label': COPY.revertLabel(label)}},
      COPY.revert);
    st.revert.addEventListener('click', () => { void revert(key); });
    st.row.aside.append(st.revert);
    state.set(key, st);
    return st.row.el;
  }

  function captureOriginals() {
    if (!song) return;
    const locks = locksOf(song);
    for (const st of state.values()) {
      st.original ??= {value: storedValue(song, st.key), locked: locks.has(st.key)};
    }
  }

  function paintRevert(st) {
    const locks = locksOf(song);
    const differs = !!st.original && (!isSame(st.key, storedValue(song, st.key), st.original.value) || locks.has(st.key) !== st.original.locked);
    st.revert.hidden = !(st.saved && differs);
  }

  function commit(key, raw) {
    const st = state.get(key);
    if (!st || unmounted) return;
    const c = check(key, raw);
    if ('error' in c) {
      st.invalid = true;
      st.row.error(c.error);
      st.row.status(null);
      return;
    }
    st.invalid = false;
    st.row.error(null);
    if (isSame(key, storedValue(song, key), c.value)) {
      // Nothing to save (G1); show the cleaned value (a trimmed title, deduplicated tags).
      if (!st.pending) st.row.set(storedValue(song, key));
      return;
    }
    void save(st, {[key]: c.value});
  }

  async function save(st, changes, {unlock} = {}) {
    const seq = ++st.seq;
    st.pending++;
    inFlight++;
    st.row.status('saving');
    report();
    let ok = false;
    try {
      const args = {ids: [songId], changes};
      if (unlock) args.unlock = unlock;
      await metadata.update(args);
      ok = true;
      if (unmounted) return;
      st.saved = true;
      anySaved = true;
      lastError = false;
      if (seq === st.seq) st.row.status('saved');
    } catch (err) {
      if (unmounted) return;
      lastError = true;
      if (seq !== st.seq) return;
      const field = errorField(err);
      if (field === st.key) {
        st.invalid = true;
        st.row.error(errorText(err));
        st.row.status(null);
      } else {
        st.row.status({error: errorText(err)});
      }
    } finally {
      st.pending--;
      inFlight--;
      if (!unmounted) {
        // The live row may already hold the saved value; take it now that nothing is in flight.
        if (ok && !st.pending && !st.row.focused() && !st.row.dirty() && song) {
          const stored = storedValue(song, st.key);
          if (isSame(st.key, stored, changes[st.key])) st.row.set(stored);
        }
        paintRevert(st);
        report();
      }
    }
  }

  async function revert(key) {
    const st = state.get(key);
    if (!st?.original || unmounted) return;
    st.invalid = false;
    st.row.error(null);
    st.row.reset(st.original.value);
    await save(st, {[key]: st.original.value}, {unlock: st.original.locked ? [] : [key]});
    if (!unmounted && st.revert.hidden) st.row.input.focus({preventScroll: true});
  }

  /** A live songs.get row: fill fields nobody is editing (G12), then the sections. */
  function applySong(next) {
    if (unmounted || !next) return;
    song = next;
    captureOriginals();
    for (const st of state.values()) {
      if (!st.pending && !st.invalid && !st.row.focused() && !st.row.dirty()) st.row.set(storedValue(song, st.key));
      paintRevert(st);
    }
    artwork.update();
    matchSection.update();
  }

  // ---------------- the page ----------------
  const section = (group) => {
    const id = `details-${group}-heading`;
    return h('section', {class: 'details-section', dataset: {group}, attrs: {'aria-labelledby': id}},
      h('h2', {class: 'details-heading', id}, COPY.groups[group]),
      h('div', {class: 'details-grid'}, ...GROUPS[group].map(makeRow)));
  };
  const songSection = section('song');
  const practiceSection = section('practice');
  captureOriginals();

  const announce = (text) => { try { deps.announce?.(text); } catch { /* best effort */ } };
  const page = () => ({title: state.get('title')?.row.value ?? song?.title, artist: state.get('artist')?.row.value ?? song?.artist});
  const artwork = createArtworkSection({
    songId, metadata, sign: deps.sign, getSong, getQuery: page, now: deps.now, decode: deps.decode, objectURL: deps.objectURL, announce,
  });
  const matchSection = createMatchSection({
    songId, metadata, getSong, announce,
    review: () => {
      const values = {};
      for (const [key, st] of state) values[key] = st.row.dirty() ? st.row.value : storedValue(song, key);
      const changed = new Set([...state.values()].filter((st) => st.saved || st.row.dirty()).map((st) => st.key));
      return {values, locks: locksOf(song), changed};
    },
    onApplied: (keys) => {
      for (const key of keys) {
        const st = state.get(key);
        if (!st) continue;
        st.saved = true;
        st.invalid = false;
        st.row.error(null);
        paintRevert(st);
      }
      anySaved = true;
      report();
    },
  });

  const root = h('div', {class: 'details', dataset: {mode: 'single', songId}},
    h('div', {class: 'details-page'},
      h('div', {class: 'details-main'}, songSection, practiceSection),
      h('div', {class: 'details-aside'}, artwork.el, matchSection.el)));
  el.append(root);

  // ---------------- live data ----------------
  if (session?.song?.subscribe) {
    offs.push(session.song.subscribe((next) => applySong(next ?? session.song.peek?.())));
  } else if (songId && deps.songs?.subscribeSong) {
    const off = deps.songs.subscribeSong({id: songId}, (next) => applySong(next), (err) => console.error('[details] songs.get failed', err));
    if (typeof off === 'function') offs.push(off);
  }
  if (song) applySong(song);

  // ---------------- flush: notes (debounced) and typed text on pagehide and unmount (G15) ----------------
  function flushAll() {
    for (const st of state.values()) {
      if (st.row.def.kind === 'textarea') st.row.flush();
      else if (st.row.dirty()) commit(st.key, st.row.value);
    }
  }
  const onPageHide = () => flushAll();
  win?.addEventListener?.('pagehide', onPageHide);
  offs.push(() => win?.removeEventListener?.('pagehide', onPageHide));

  // ---------------- #match ----------------
  if (win?.location?.hash === '#match') {
    try { matchSection.el.scrollIntoView?.({block: 'start'}); } catch { /* not laid out */ }
    matchSection.heading.focus({preventScroll: true});
  }

  return {
    el: root,
    update() {
      if (unmounted) return;
      const next = session?.song?.peek?.();
      if (next && next !== song) applySong(next);
    },
    unmount() {
      if (unmounted) return;
      flushAll();
      unmounted = true;
      for (const off of offs.splice(0).reverse()) { try { off(); } catch (err) { console.error('[details] cleanup failed', err); } }
      for (const st of state.values()) st.row.destroy();
      state.clear();
      artwork.destroy();
      matchSection.destroy();
      root.remove();
    },
  };
}
