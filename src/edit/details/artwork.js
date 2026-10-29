// Edit · Details · Artwork (spec §5.3; G11; ported from src/js/song-metadata.js:133-187, 232-246): the
// cover over the stable fallback sleeve, Choose another cover (the inline lookup in cover mode → a
// release's Cover Art Archive image), Upload image (JPEG, PNG or WebP up to 2 MB, decoded with
// createImageBitmap first; api.metadata.uploadArtwork → key, then update with {kind: 'upload', key}),
// Remove ({kind: 'removed'}), and Revert to the cover the page opened with (an earlier upload only
// within REVERT_UPLOAD_MS: the server retires a replaced upload's key after about an hour). Every
// choice saves at once.
//
//   createArtworkSection({songId, metadata, sign, getSong(), getQuery(), now(), decode, objectURL, announce})
//     → {el, heading, update(song), uploading(), destroy()}

import {Button} from '../../ui/button.js';
import {h} from '../../ui/h.js';
import {InlineStatus} from '../../ui/status.js';
import {SAVED_MS, FADE_MS} from '../../ui/field.js';
import {setArtwork} from '../../js/artwork.js';
import {ARTWORK_TYPES, LIMITS, sameValue} from '../../../shared/metadata.ts';
import {COPY} from './details.copy.js';
import {errorText, storedValue} from './fields.js';
import {createLookup, releaseCover} from './match.js';

/** How long after replacing an uploaded cover Revert can still restore it (G11, BK7). */
export const REVERT_UPLOAD_MS = 60 * 60 * 1000;

/** What the song shows as its cover: {url} | {key} | null (explicit artwork wins over an imported cover). */
export function coverOf(song) {
  const art = storedValue(song, 'artwork');
  const url = typeof song?.coverUrl === 'string' && song.coverUrl ? song.coverUrl : null;
  const key = typeof song?.coverKey === 'string' && song.coverKey ? song.coverKey : null;
  if (art?.kind === 'removed') return null;
  if (art?.kind === 'release') return url ? {url} : {url: releaseCover(art.releaseId, 500)};
  if (art?.kind === 'upload') return {key: art.key, url};
  if (key) return {key, url};
  return url ? {url} : null;
}

const locked = (song, key) => Array.isArray(song?.metadataLocks) && song.metadataLocks.includes(key);

export function createArtworkSection({songId, metadata, sign, getSong, getQuery, now, decode, objectURL, announce = () => {}}) {
  const headingId = `details-artwork-${String(songId).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const heading = h('h2', {class: 'details-heading', id: headingId}, COPY.groups.artwork);
  const cover = h('div', {class: 'details-cover', attrs: {role: 'img', 'aria-label': COPY.coverAlt}});
  const file = h('input', {type: 'file', class: 'details-file', accept: ARTWORK_TYPES.join(','), hidden: true, tabIndex: -1,
    attrs: {'aria-hidden': 'true'}});
  const choose = Button({label: COPY.chooseCover, variant: 'secondary', size: 'sm', className: 'details-choose-cover',
    onClick: () => lookup.open()});
  const upload = Button({label: COPY.upload, icon: 'upload', variant: 'secondary', size: 'sm', className: 'details-upload',
    onClick: () => { if (!busy) file.click(); }});
  const remove = Button({label: COPY.remove, icon: 'trash-2', variant: 'quiet', size: 'sm', className: 'details-remove-cover',
    onClick: () => { void save({kind: 'removed'}, COPY.coverRemoved); }});
  const revert = Button({label: COPY.revert, icon: 'undo-2', variant: 'quiet', size: 'sm', className: 'details-revert-cover',
    attrs: {'aria-label': COPY.revertCover}, onClick: () => { void doRevert(); }});
  const status = InlineStatus({tone: 'info', text: '', className: 'details-artwork-status'});
  status.el.hidden = true;
  const hint = h('p', {class: 'details-hint'}, COPY.artworkHint);
  const lookup = createLookup({
    songId, metadata, mode: 'cover', label: COPY.coverSearchTitle, query: getQuery,
    onCover: (c) => { lookup.close({focusBack: false}); void save({kind: 'release', releaseId: c.releaseId}, COPY.coverSaved); choose.el.focus({preventScroll: true}); },
    onClose: ({focusBack}) => { paint(); if (focusBack) choose.el.focus({preventScroll: true}); },
  });
  const controls = h('div', {class: 'details-artwork-controls'},
    h('div', {class: 'details-artwork-actions'}, choose.el, upload.el, remove.el, revert.el), hint, status.el, file);
  const el = h('section', {class: 'details-section details-artwork', attrs: {'aria-labelledby': headingId}},
    heading, h('div', {class: 'details-artwork-row'}, cover, controls), lookup.el);

  let original = null;      // {value, locked} when the page opened
  let changedAt = null;     // when this session first changed the cover
  let preview = null;       // an object URL while (and after) an upload of this session
  let shown = undefined;    // what the cover paints: a URL, 'k:'+key while signing, or null
  let signToken = 0;
  let busy = false;
  let ac = null;
  let statusTimer = null;
  let destroyed = false;

  function say(text, tone = 'info', {fade = false} = {}) {
    clearTimeout(statusTimer);
    statusTimer = null;
    status.el.hidden = !text;
    if (text) status.set({text, tone});
    if (text && fade) statusTimer = setTimeout(() => { status.el.hidden = true; statusTimer = null; }, SAVED_MS + FADE_MS);
  }

  function paintCover(song) {
    const src = preview ? {url: preview} : coverOf(song);
    const id = !src ? null : src.key ? `k:${src.key}` : `u:${src.url}`;
    if (id === shown) return;
    shown = id;
    const seed = {id: songId, title: song?.title, artist: song?.artist, uploader: song?.uploader, album: song?.album};
    const mine = ++signToken;
    if (!src) { setArtwork(cover, seed, null); return; }
    if (!src.key) { setArtwork(cover, seed, src.url); return; }
    setArtwork(cover, seed, null);
    Promise.resolve().then(() => sign(src.key)).then((url) => {
      if (mine !== signToken || destroyed) return;
      setArtwork(cover, seed, url || src.url || null);
    }, () => {
      if (mine !== signToken || destroyed) return;
      if (src.url) setArtwork(cover, seed, src.url);
      shown = undefined;   // not signed: the next update asks again
    });
  }

  function canRevert() {
    if (changedAt == null || !original?.value) return false;
    if (original.value.kind === 'upload' && now() - changedAt >= REVERT_UPLOAD_MS) return false;
    return true;
  }

  function paint() {
    const song = getSong();
    if (song && !original) original = {value: storedValue(song, 'artwork'), locked: locked(song, 'artwork')};
    paintCover(song);
    remove.el.hidden = !coverOf(song) && !preview;
    revert.el.hidden = !canRevert();
    choose.el.hidden = lookup.isOpen();
    for (const b of [choose, upload, remove, revert]) b.set({disabled: busy});
  }

  function markChanged() {
    if (changedAt == null) changedAt = now();
  }

  async function save(artwork, done) {
    if (busy || destroyed) return;
    const song = getSong();
    if (sameValue('artwork', storedValue(song, 'artwork'), artwork)) return;
    busy = true;
    say(COPY.saving);
    paint();
    try {
      await metadata.update({ids: [songId], changes: {artwork}});
      if (destroyed) return;
      markChanged();
      dropPreview();
      say(done, 'ok', {fade: true});
      announce(done);
    } catch (err) {
      if (destroyed) return;
      say(errorText(err), 'error');
    } finally {
      busy = false;
      if (!destroyed) paint();
    }
  }

  function dropPreview() {
    if (!preview) return;
    try { objectURL.revoke(preview); } catch { /* already revoked */ }
    preview = null;
    shown = undefined;
  }

  async function onFile() {
    const f = file.files?.[0] ?? null;
    file.value = '';
    if (!f || busy || destroyed) return;
    if (!ARTWORK_TYPES.includes(f.type) || !(f.size > 0) || f.size > LIMITS.artworkBytes) { say(COPY.artworkInvalid, 'error'); return; }
    busy = true;
    paint();
    try {
      if (typeof decode === 'function') {
        try { const bitmap = await decode(f); bitmap?.close?.(); }
        catch { if (!destroyed) say(COPY.artworkUnreadable, 'error'); return; }
      }
      if (destroyed) return;
      dropPreview();
      try { preview = objectURL.create(f); } catch { preview = null; }
      shown = undefined;
      paintCover(getSong());
      say(COPY.uploading);
      ac = new AbortController();
      const key = await metadata.uploadArtwork({id: songId, file: f, signal: ac.signal});
      if (destroyed) return;
      await metadata.update({ids: [songId], changes: {artwork: {kind: 'upload', key}}});
      if (destroyed) return;
      markChanged();
      say(COPY.coverSaved, 'ok', {fade: true});
      announce(COPY.coverSaved);
    } catch (err) {
      if (destroyed || err?.name === 'AbortError') return;
      dropPreview();
      say(errorText(err), 'error');
    } finally {
      ac = null;
      busy = false;
      if (!destroyed) paint();
    }
  }
  file.addEventListener('change', () => { void onFile(); });

  async function doRevert() {
    if (busy || !canRevert()) return;
    busy = true;
    say(COPY.saving);
    paint();
    try {
      await metadata.update({ids: [songId], changes: {artwork: original.value}, unlock: original.locked ? [] : ['artwork']});
      if (destroyed) return;
      changedAt = null;
      dropPreview();
      say(COPY.coverReverted, 'ok', {fade: true});
      announce(COPY.coverReverted);
    } catch (err) {
      if (destroyed) return;
      say(errorText(err), 'error');
    } finally {
      busy = false;
      if (!destroyed) paint();
    }
  }

  paint();
  return {
    el, heading, lookup,
    update() { paint(); },
    uploading: () => !!ac,
    destroy() {
      destroyed = true;
      ac?.abort();
      clearTimeout(statusTimer);
      dropPreview();
      lookup.destroy();
      for (const b of [choose, upload, remove, revert, status]) b.destroy();
      el.remove();
    },
  };
}
