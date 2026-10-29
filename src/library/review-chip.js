// "Is this right?" (spec §2.4, architecture §2.16, D43): a quiet chip on a card or list row whose song
// needs a metadata review (`row.reviewMetadata`: an untitled upload, or a lookup that was not sure). It
// opens an inline popover with the match (cover, title, artist, album) and two actions:
//   Yes, that's it   the details shown are right.
//                    - The song's own details (no suggestion, or the suggestion names the same title and
//                      artist): metadata.confirm({id}) (BK7: matched, identity fields locked; the
//                      suggestion's ids are kept when it names the same song).
//                    - A MusicBrainz suggestion for another title or artist: the suggestion is applied,
//                      metadata.update({ids: [id], changes: <its fields>, match: {recordingId, releaseId}})
//                      with the recording id from songs.get (the list row carries no recording id); when
//                      that id is not available, the fields are applied and then confirmed.
//   Find another     → /s/:id/edit/details#match (Edit · Details, the match panel).
// The chip hides itself when the row no longer needs review (the songs list update after the write).
//
//   ReviewChip(song, {cover?, router?, metadata?, songs?, sign?}) → {el, update(song), open(), close(), destroy()}
//     cover   the cover URL the card already shows (else song.coverUrl, else the signed coverKey)

import '../styles/views/library/review.css';
import * as metadataApi from '../api/metadata.js';
import * as songsApi from '../api/songs.js';
import {signKeys} from '../api/media.js';
import {registry as appRegistry} from '../app/commands.js';
import {describeError} from '../app/error-copy.js';
import {Button} from '../ui/button.js';
import {Chip} from '../ui/chip.js';
import {h} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {Popover} from '../ui/popover.js';
import {InlineStatus} from '../ui/status.js';
import {REVIEW} from './jobs.copy.js';

export {REVIEW as COPY};

const str = v => (typeof v === 'string' ? v.trim() : '');
const fold = v => str(v).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');

/** True when the row's suggestion names another song than the row's own title and artist. */
export function suggestsOther(song) {
  const s = song?.suggestion;
  if (!s || !str(s.title)) return false;
  return fold(s.title) !== fold(song.title) || fold(s.artist) !== fold(song.artist);
}

/** What the popover shows: the suggestion when it names another song, else the song's own details. */
export function matchOf(song) {
  if (suggestsOther(song)) {
    const s = song.suggestion;
    return {kind: 'suggestion', title: str(s.title), artist: str(s.artist), album: str(s.album)};
  }
  return {kind: 'current', title: str(song?.title), artist: str(song?.artist), album: str(song?.album)};
}

/** The changes that apply a suggestion (only fields it has). */
function suggestionChanges(full, row) {
  const s = full?.metadataSuggestion ?? row?.suggestion ?? {};
  const changes = {};
  for (const key of ['title', 'artist', 'album', 'albumArtist', 'year', 'trackNumber', 'discNumber']) {
    const value = s[key];
    if (typeof value === 'string' && value.trim()) changes[key] = value.trim();
    else if (typeof value === 'number' && Number.isFinite(value)) changes[key] = String(value);
  }
  return changes;
}

/**
 * Accepts the shown details (see the header). Exported for tests.
 * @returns {Promise<void>}
 */
export async function acceptMatch(song, {metadata = metadataApi, songs = songsApi} = {}) {
  const id = song.id;
  if (!suggestsOther(song)) {
    await metadata.confirm({id});
    return;
  }
  let full = null;
  try { full = await songs.get({id}); } catch { full = null; }
  const changes = suggestionChanges(full, song);
  const recordingId = str(full?.metadataSuggestion?.recordingId);
  const releaseId = str(full?.metadataSuggestion?.releaseId) || str(song.suggestion?.releaseId);
  if (recordingId) {
    await metadata.update({ids: [id], changes, match: releaseId ? {recordingId, releaseId} : {recordingId}});
    return;
  }
  await metadata.update({ids: [id], changes});
  await metadata.confirm({id});
}

let seq = 0;

export function ReviewChip(initial, {cover: coverUrl = null, router = null, metadata = metadataApi, songs = songsApi, sign = signKeys,
  registry = appRegistry} = {}) {
  let song = initial;
  let cover = coverUrl;
  let popover = null;
  let saving = false;
  const uid = `lib-review-${++seq}`;
  const routerOf = () => {
    if (router) return router;
    try { return registry.context().router ?? null; } catch { return null; }
  };

  const chip = Chip({label: REVIEW.chip, icon: 'info', tone: 'neutral', className: 'lib-review-chip', onClick: e => {
    e?.stopPropagation?.();
    if (popover?.open) close();
    else open();
  }});
  const button = chip.el.querySelector('button');
  button?.setAttribute('aria-haspopup', 'dialog');
  button?.setAttribute('aria-expanded', 'false');
  // The chip lives inside a card that opens the Stage on click: keep its presses to itself.
  for (const type of ['click', 'pointerdown', 'pointerup', 'contextmenu']) chip.el.addEventListener(type, e => e.stopPropagation());
  const el = chip.el;

  function sync() {
    el.hidden = !song?.reviewMetadata;
    if (el.hidden && popover?.open && !saving) close();
  }

  function content() {
    const match = matchOf(song);
    const img = h('img', {class: 'lib-review-cover-image', alt: REVIEW.cover(match.title), attrs: {draggable: 'false', referrerpolicy: 'no-referrer'}, hidden: true});
    const glyph = h('span', {class: 'lib-review-cover-glyph', attrs: {'aria-hidden': 'true'}}, icon('music', {size: 24}));
    const showCover = url => { img.hidden = !url; glyph.hidden = !!url; if (url) img.src = url; };
    img.addEventListener('error', () => showCover(null));
    // A suggestion for another recording may have other artwork: only the song's own details show its cover.
    const url = match.kind === 'current' ? cover || str(song.coverUrl) : '';
    if (url) showCover(url);
    else if (match.kind === 'current' && str(song.coverKey)) Promise.resolve(sign([song.coverKey])).then(urls => showCover(urls?.[song.coverKey] ?? null), () => {});
    const status = InlineStatus({tone: 'error', text: '', className: 'lib-review-error'});
    status.el.hidden = true;
    const yes = Button({label: REVIEW.yes, variant: 'primary', size: 'sm', className: 'lib-review-yes', onClick: async () => {
      if (saving) return;
      saving = true;
      status.el.hidden = true;
      yes.set({busy: REVIEW.saving, disabled: true});
      try {
        await acceptMatch(song, {metadata, songs});
        saving = false;
        close();
      } catch (err) {
        saving = false;
        yes.set({busy: false, disabled: false});
        status.set({text: describeError(err, {context: 'save'}).sentence});
        status.el.hidden = false;
      }
    }});
    const find = Button({label: REVIEW.findAnother, variant: 'quiet', size: 'sm', className: 'lib-review-find', onClick: () => {
      close();
      routerOf()?.navigate?.(`/s/${encodeURIComponent(song.id)}/edit/details#match`);
    }});
    const parts = [
      h('h2', {class: 'lib-review-title', id: `${uid}-title`}, REVIEW.title),
      h('p', {class: 'lib-review-lead'}, match.kind === 'suggestion' ? REVIEW.suggested : REVIEW.current),
      h('div', {class: 'lib-review-match'},
        h('span', {class: 'lib-review-cover'}, img, glyph),
        h('div', {class: 'lib-review-fields selectable'},
          h('p', {class: 'lib-review-song'}, match.title),
          h('p', {class: 'lib-review-artist'}, match.artist || REVIEW.unknownArtist),
          match.album ? h('p', {class: 'lib-review-album'}, match.album) : null)),
      status.el,
      h('div', {class: 'lib-review-actions'}, yes.el, find.el),
    ];
    return {node: h('div', {class: 'lib-review'}, ...parts), destroy: () => { yes.destroy(); find.destroy(); status.destroy(); }};
  }

  let body = null;
  function open() {
    if (popover?.open) return popover;
    body = content();
    popover = Popover({anchor: button ?? el, content: body.node, placement: 'bottom', align: 'start', labelledBy: `${uid}-title`,
      className: 'lib-review-popover', width: 'min(360px, calc(100vw - 2 * var(--s4)))',
      onClose: () => {
        button?.setAttribute('aria-expanded', 'false');
        body?.destroy();
        body = null;
        popover = null;
      }});
    button?.setAttribute('aria-expanded', 'true');
    return popover;
  }
  function close() { popover?.close('close'); }

  sync();
  return {
    el,
    update(next, opts = {}) {
      song = next;
      if ('cover' in opts) cover = opts.cover;
      sync();
    },
    open,
    close,
    destroy() {
      popover?.destroy();
      popover = null;
      body?.destroy();
      body = null;
      chip.destroy();
    },
  };
}
