// Fixture handlers for convex/sharing.ts and convex/shareAudio.ts (architecture
// §6.7, package BK5). Links live in `db.shares` ({[songId]: {token,
// includeNotation, createdAt}}), so a link resolves by its token: the share
// dialog's (Glasshouse) and the demo's (`db.demoToken`, Paper Lanterns).
//
// `sharing:view` returns the v2 snapshot the server returns: the song's public
// fields, `tempo: {songMap}`, the practice through the same one-way upgrade and
// `sanitizeForShare` (songPractice first, else the 1.9 songs.practice, with the
// 1.x click fields from tempo), and `ownerName` from `db.user` ("Kyle K.").
//
// The fixture's signed-in user owns every seeded song; "Add to my library"
// behaves as it does for another account: it makes a copy (`<songId>-copy`,
// once) with its practice in `db.songPractice`, the drum part when the link
// includes it, and its summaries. `db.shareCopies` ({[songId]: copyId}) is
// created on the first save.
//   fx-share=missing   every shared link is unavailable
//   fx-share=saved     the shared song is already in the library
//   fx-share=copying   a save is in progress (sharing:saved reports 'copying')
import {db, fx, clone, wait, findSong, publicSong, convexError} from './runtime.js';
import {COVERS} from './seed.js';
import {stemUrl} from '../audio.js';
import {upgradePractice, sanitizeForShare, summarize} from '../../../shared/practice.ts';
import {cleanSongMap, hasRealMap, songMapFromTempo, mapSummaryOf, barsOf, sectionsFromBars} from '../../../shared/song-map.ts';

export const UNAVAILABLE = 'This share link is unavailable. It may have been stopped or the song removed.';
const unavailable = () => convexError({code: 'not_found', message: UNAVAILABLE});
const exportOnly = () => convexError({code: 'account_export_only', message: 'Your account is in export-only mode. Playback and library export remain available.'});

const sharedSongId = token => Object.entries(db.shares).find(([, share]) => share.token === token)?.[0] ?? null;
const sharedSong = token => {
  const id = fx.share === 'missing' ? null : sharedSongId(token);
  return id ? findSong(id) ?? null : null;
};
const storedPractice = song => db.songPractice.find(row => row.songId === song.id)?.practice ?? song.practice;
const newToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');

/** As convex/sharing.ts#ownerNameOf: "Kyle Kincer" → "Kyle K.", one word as is, else "a Woodshed user". */
export function ownerNameOf(name) {
  if (typeof name !== 'string' || /\S@\S/.test(name)) return 'a Woodshed user';
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'a Woodshed user';
  if (words.length === 1) return words[0];
  const initial = Array.from(words[words.length - 1]).find(c => /[\p{L}\p{N}]/u.test(c));
  return initial ? `${words[0]} ${initial.toLocaleUpperCase()}.` : words[0];
}

/** As convex/sharing.ts#sharedTempo: a stored map (origin kept, made maps stamped), else a pre-1.6 song's lists. */
function sharedTempo(tempo, duration) {
  if (!tempo || typeof tempo !== 'object') return undefined;
  if (cleanSongMap(tempo.songMap)) return {songMap: songMapFromTempo(tempo, duration)};
  if (!hasRealMap(tempo)) return undefined;
  return {...(typeof tempo.source === 'string' ? {source: tempo.source} : {}), map: clone(tempo.map ?? []), detected: clone(tempo.detected ?? [])};
}

const sharedPractice = song => sanitizeForShare(upgradePractice(storedPractice(song), {duration: song.duration, legacyTempo: song.tempo}));

/** The snapshot `sharing:view` returns for a seeded song. */
export function shareView(song) {
  const s = publicSong(song);
  return {
    title: s.title, artist: s.artist || s.uploader || '', album: s.album || '', albumArtist: s.albumArtist || '', year: s.year || '',
    genre: s.genre || '', trackNumber: s.trackNumber || '', discNumber: s.discNumber || '', musicalKey: s.musicalKey || '', tuning: s.tuning || '',
    duration: s.duration, stemMode: s.stemMode, quality: s.quality,
    artwork: s.artwork?.kind === 'release' ? s.artwork : undefined,
    tempo: sharedTempo(s.tempo, s.duration), practice: sharedPractice(song),
    id: 'shared', ownerName: ownerNameOf(db.user?.name), revision: 'r1',
    coverKey: s.coverKey || s.coverUrl ? 'cover' : null, coverUrl: s.artwork?.kind === 'release' ? s.coverUrl : null,
    stems: s.stems.map((x, i) => ({name: x.name, key: `stem-${i}`})),
  };
}

/** As convex/sharing.ts#partHasChart: the copied part holds a chart when any bar has a hit or is marked reviewed. */
export const scoreHasChart = score => (score?.bars ?? []).some(b => b.hits?.length > 0 || b.coverage === 'reviewed');

/**
 * Commit a copy of the shared song, as convex/sharing.ts#finishImport does; idempotent.
 * Built from an explicit field list (the snapshot's song fields plus the columns the
 * fixture's library rows always carry), so source-only fields such as `resolvedUrl`,
 * `provider`, `metadataRecordingId` or `bpm` never reach the copy.
 */
function copyOf(song) {
  db.shareCopies ??= {};
  const existing = db.shareCopies[song.id];
  if (existing && findSong(existing)) return existing;
  const id = `${song.id}-copy`, view = shareView(song), now = Date.now();
  const tempo = view.tempo && (view.tempo.songMap || hasRealMap(view.tempo)) ? {songMap: songMapFromTempo(view.tempo, view.duration)} : null;
  const withPart = db.shares[song.id]?.includeNotation !== false && !!db.notation[song.id];
  const score = withPart ? clone(db.notation[song.id].score) : null;
  const hasChart = withPart && scoreHasChart(score);
  const real = hasRealMap(tempo, {hasPart: hasChart});
  const bars = real ? barsOf(songMapFromTempo(tempo, view.duration), view.duration) : null;
  const practice = view.practice;
  db.songs.unshift({
    id, addedAt: now,
    title: view.title || 'Shared song', artist: view.artist, album: view.album, albumArtist: view.albumArtist, year: view.year,
    genre: view.genre, trackNumber: view.trackNumber, discNumber: view.discNumber, musicalKey: view.musicalKey, tuning: view.tuning,
    duration: view.duration, stemMode: view.stemMode, quality: clone(view.quality),
    // The fixture's stand-ins for the copied audio and cover objects.
    stems: clone(song.stems), coverKey: song.coverKey ?? null, coverUrl: song.coverUrl ?? null, artwork: view.artwork ? clone(view.artwork) : null,
    uploader: '', tags: [], notes: '', source: null, metadataLocks: [], metadataStatus: null, metadataRecordingId: null, metadataReleaseId: null,
    tempo, tempoRev: 0, hasChart,
    mapSummary: mapSummaryOf(tempo, view.duration, {hasPart: hasChart}),
    practiceSummary: summarize(practice, bars ? {sections: sectionsFromBars(bars), bars} : null),
  });
  db.songPractice.push({songId: id, userId: db.user._id, practice, updatedAt: now});
  if (withPart) db.notation[id] = {score, revision: 1};
  db.shareCopies[song.id] = id;
  return id;
}

export const handlers = {
  'sharing:status': ({id}) => db.shares[id] ? {token: db.shares[id].token, includeNotation: db.shares[id].includeNotation !== false} : null,
  'sharing:create': ({id, includeNotation}) => {
    if (fx.auth === 'export_only') throw exportOnly();
    if (!findSong(id)) throw convexError({code: 'not_found', message: 'Song unavailable.'});
    const share = db.shares[id];
    if (share) {
      if (includeNotation !== undefined) share.includeNotation = includeNotation;
      return {token: share.token};
    }
    db.shares[id] = {token: newToken(), includeNotation: includeNotation !== false, createdAt: Date.now()};
    return {token: db.shares[id].token};
  },
  'sharing:revoke': ({id}) => { delete db.shares[id]; return null; },
  'sharing:view': ({token}) => {
    const song = sharedSong(token);
    return song ? shareView(song) : null;
  },
  'sharing:saved': ({token}) => {
    const song = sharedSong(token);
    if (!song) return null;
    if (fx.share === 'copying') return {songId: null, status: 'copying'};
    const copy = db.shareCopies?.[song.id];
    if (copy && findSong(copy)) return {songId: copy, status: 'ready'};
    return fx.share === 'saved' ? {songId: song.id, status: 'ready'} : null;
  },
  'shareAudio:playback': ({token}) => {
    const s = sharedSong(token);
    if (!s) throw unavailable();
    const cover = s.coverUrl || db.coverKeys[s.coverKey] || COVERS.weather;
    return Object.fromEntries([...s.stems.map((x, i) => [`stem-${i}`, stemUrl(s, x.name, db.notation[s.id]?.score)]), ['cover', cover]]);
  },
  'shareAudio:save': async ({token}) => {
    if (fx.auth === 'export_only') throw exportOnly();
    if (!sharedSong(token)) throw unavailable();
    await wait(800);
    const song = sharedSong(token);
    if (!song) throw unavailable();
    // As convex/shareAudio.ts#save: an existing copy (or, under fx-share=saved, the song) is returned
    // as is, and a save already in progress is refused.
    const saved = handlers['sharing:saved']({token});
    if (saved?.songId) return saved.songId;
    if (saved?.status === 'copying') throw convexError({code: 'invalid', message: 'This song is already being added. Please wait.'});
    return copyOf(song);
  },
};
