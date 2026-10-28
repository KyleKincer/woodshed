// Fixture handlers for convex/metadata.ts, metadataLookup.ts and artworkUpload.ts
// (architecture §6.9; BK7 owns the bodies). They follow the server's rules with
// the shared field rules (shared/metadata.ts):
//   - `update`/`updateEach` are atomic, skip unchanged keys (no write, no lock,
//     no id clearing), lock changed keys, then unlock `unlock`; a title or artist
//     change clears the ids and the suggestion (a title change also needsReview),
//     album/albumArtist clears the release id; `match` sets 'matched' and the ids;
//   - `confirm` sets 'matched', locks the identity fields present, clears the
//     suggestion and needsReview (never recordingUnconfirmed);
//   - field errors are coded {code: 'invalid', message, field}.
// Seed: the `counting` song carries a `metadataSuggestion` (metadataStatus
// 'uncertain'); `jam03` has `needsReview`.
//
// `metadataLookup:retry` marks the song 'pending' and finishes the lookup 1.2 s
// later (a song with an artist matches; one without stays 'uncertain', no
// suggestion). The due time lives in `db.metadataLookups` ({songId: dueAt}) so a
// reload finishes it (`settle`/`resume`). The fixture has no artwork storage:
// `artworkUpload:prepare` fails (coded `account_export_only` on such accounts).
import {db, changed, convexError, wait, findSong} from './runtime.js';
import {COVERS} from './seed.js';
import {IDENTITY_KEYS, LIMITS, MBID, RECORDING_KEYS, RELEASE_KEYS, changedKeys, hasValue, isFieldKey, validatePatch} from '../../../shared/metadata.ts';

export const LOOKUP_MS = 1200;
const UNAVAILABLE = 'Song unavailable.';

const invalid = (message, extra = {}) => convexError({code: 'invalid', message, ...extra});
const notFound = () => convexError({code: 'not_found', message: UNAVAILABLE});

function owned(id) {
  const song = findSong(id);
  if (!song) throw notFound();
  return song;
}

function clean(changes) {
  const result = validatePatch(changes ?? {});
  if ('error' in result) throw invalid(result.error, {field: result.field});
  return result.value;
}

function cleanUnlock(unlock) {
  const keys = [...new Set(unlock ?? [])];
  for (const key of keys) if (!isFieldKey(key)) throw invalid('Unknown field.', {field: key});
  return keys;
}

function cleanMatch(match, count) {
  if (!match) return undefined;
  if (count !== 1) throw invalid('Apply a match to one song at a time.');
  if (!MBID.test(match.recordingId ?? '') || (match.releaseId != null && !MBID.test(match.releaseId))) throw invalid('Invalid match.');
  return match;
}

/** What a song shows for its artwork (the fixture keeps `coverUrl` in step with `artwork`). */
function showArtwork(song, artwork) {
  if (artwork.kind === 'removed') { song.coverUrl = null; song.coverKey = null; }
  if (artwork.kind === 'release') song.coverUrl = COVERS.harbor;
}

/** The server's edit rules on one fixture song (convex/metadata.ts#applyEdit). */
function applyEdit(song, patch, unlock, match) {
  const keys = changedKeys(patch, song);
  for (const key of keys) {
    song[key] = structuredClone(patch[key]);
    if (key === 'artwork') showArtwork(song, patch.artwork);
  }
  if (RECORDING_KEYS.some(k => keys.includes(k))) {
    song.metadataRecordingId = null;
    song.metadataReleaseId = null;
    delete song.metadataSuggestion;
  } else if (RELEASE_KEYS.some(k => keys.includes(k))) song.metadataReleaseId = null;
  if (keys.includes('title')) delete song.needsReview;
  song.metadataLocks = [...new Set([...(song.metadataLocks ?? []), ...keys])].filter(k => !unlock.includes(k));
  if (match) {
    song.metadataStatus = 'matched';
    song.metadataRecordingId = match.recordingId;
    song.metadataReleaseId = match.releaseId ?? null;
    delete song.metadataSuggestion;
    delete song.needsReview;
  }
}

// ---- lookups ----------------------------------------------------------------------

const REC = n => `5e1f0000-0000-4000-8000-00000000000${n}`;
const REL = n => `7e1e0000-0000-4000-8000-00000000000${n}`;

/** Recordings for a search, shaped like `lib/musicBrainz.ts#candidate()`. */
function candidates({title, artist}) {
  const t = title || 'Glasshouse', a = artist || 'Northbound';
  const base = {albumArtist: a, trackNumber: '3', discNumber: '1', score: 100, disambiguation: ''};
  return [
    {...base, recordingId: REC(1), releaseId: REL(1), title: t, artist: a, album: 'Weather Systems', year: '2021', duration: 64},
    {...base, recordingId: REC(2), releaseId: REL(4), title: t, artist: a, album: `${t} (Single)`, year: '2020', duration: 63, trackNumber: '1', disambiguation: 'radio edit', score: 88},
    {...base, recordingId: REC(3), title: `${t} (Live)`, artist: a, album: '', albumArtist: '', year: '', duration: 71, trackNumber: '', discNumber: '', disambiguation: 'live, 2022-05-14: The Grange', score: 71},
  ];
}

/** The releases of one recording (Albums/covers). */
function releasesOf(recordingId, {title, artist}) {
  const t = title || 'Glasshouse', a = artist || 'Northbound';
  const base = {recordingId, title: t, artist: a, albumArtist: a, discNumber: '1', duration: 64, disambiguation: '', score: 100};
  return [
    {...base, releaseId: REL(1), album: 'Weather Systems', year: '2021', trackNumber: '3'},
    {...base, releaseId: REL(2), album: 'Weather Systems (Deluxe)', year: '2022', trackNumber: '3'},
    {...base, releaseId: REL(3), album: 'Songs from the Shed: A Compilation', year: '2023', trackNumber: '11', albumArtist: 'Various Artists', duration: 65},
  ];
}

function finishLookup(song) {
  delete song.metadataSuggestion;
  if (song.artist) Object.assign(song, {metadataStatus: 'matched', metadataRecordingId: candidates(song)[0].recordingId});
  else song.metadataStatus = 'uncertain';
}

/** Finish every retried lookup that is due; returns whether anything changed. */
export function settle(now = Date.now()) {
  const due = db?.metadataLookups;
  if (!due) return false;
  let any = false;
  for (const [id, at] of Object.entries(due)) {
    if (at > now) continue;
    delete due[id];
    const song = findSong(id);
    if (song && song.metadataStatus === 'pending') finishLookup(song);
    any = true;
  }
  return any;
}

/** After a reload: re-arm the timer of every retried lookup that is not due yet. */
export function resume(now = Date.now()) {
  for (const at of Object.values(db?.metadataLookups ?? {}))
    if (at > now) setTimeout(() => { if (settle()) changed(); }, at - now);
}

export const handlers = {
  'metadata:update': ({ids, changes, unlock, match}) => {
    const unique = [...new Set(ids ?? [])];
    if (!unique.length || unique.length > LIMITS.bulk) throw invalid(`Select between 1 and ${LIMITS.bulk} songs.`);
    const patch = clean(changes), keys = cleanUnlock(unlock), chosen = cleanMatch(match, unique.length);
    if (!Object.keys(patch).length && !keys.length && !chosen) return null;
    if (patch.artwork?.kind === 'upload' && unique.length !== 1) throw invalid('Upload artwork for one song at a time.', {field: 'artwork'});
    const songs = unique.map(owned);
    for (const song of songs) applyEdit(song, patch, keys, chosen);
    changed();
    return null;
  },
  'metadata:updateEach': ({items}) => {
    if (!items?.length || items.length > LIMITS.bulk) throw invalid(`Select between 1 and ${LIMITS.bulk} songs.`);
    if (new Set(items.map(item => item.id)).size !== items.length) throw invalid('Each song can appear only once.');
    const prepared = items.map(item => ({song: owned(item.id), patch: clean(item.changes), unlock: cleanUnlock(item.unlock)}));
    for (const {song, patch, unlock} of prepared) applyEdit(song, patch, unlock, undefined);
    changed();
    return null;
  },
  'metadata:confirm': ({id}) => {
    const song = owned(id);
    const identity = [...IDENTITY_KEYS.filter(k => hasValue(song, k)), ...(hasValue(song, 'artwork') ? ['artwork'] : [])];
    song.metadataStatus = 'matched';
    song.metadataLocks = [...new Set([...(song.metadataLocks ?? []), ...identity])];
    delete song.metadataSuggestion;
    delete song.needsReview;
    changed();
    return null;
  },
  'metadataLookup:find': async ({id, title = '', artist = '', recordingId}) => {
    owned(id);
    if (title.length > LIMITS.search || artist.length > LIMITS.search)
      throw invalid('Search text is too long.', {field: title.length > LIMITS.search ? 'title' : 'artist'});
    if (recordingId && !MBID.test(recordingId)) throw invalid('Invalid recording.');
    await wait(500);
    if (recordingId) return releasesOf(recordingId, {title, artist});
    return title.trim() ? candidates({title, artist}) : [];
  },
  'metadataLookup:detail': async ({id, recordingId, releaseId}) => {
    const song = owned(id);
    if (!MBID.test(recordingId ?? '') || (releaseId && !MBID.test(releaseId))) throw invalid('Invalid match.');
    await wait(300);
    const pool = [...candidates(song), ...releasesOf(recordingId, song)];
    const hit = pool.find(c => c.recordingId === recordingId && (c.releaseId ?? null) === (releaseId ?? null))
      ?? pool.find(c => c.recordingId === recordingId) ?? candidates(song)[0];
    const {releaseId: _drop, ...rest} = hit;
    return releaseId ? {...rest, recordingId, releaseId} : {...rest, recordingId};
  },
  'metadataLookup:retry': ({id}) => {
    const song = owned(id);
    if (song.metadataStatus === 'pending') return null;
    if (song.metadataStatus === 'matched') throw invalid('This song is already matched.');
    song.metadataStatus = 'pending';
    (db.metadataLookups ??= {})[song.id] = Date.now() + LOOKUP_MS;
    setTimeout(() => { if (settle()) changed(); }, LOOKUP_MS);
    changed();
    return null;
  },
  'artworkUpload:prepare': () => {
    if (db.user?.status === 'export_only')
      throw convexError({code: 'account_export_only', message: 'Your account is in export-only mode. Playback and library export remain available.'});
    throw convexError({code: 'invalid', message: 'Artwork upload is not available in the fixture.', field: 'artwork'});
  },
};
