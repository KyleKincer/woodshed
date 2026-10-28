// Fixture handlers for convex/songs.ts (architecture §6.3, package BK1). Each
// handler mirrors its Convex function: the slim list row, `get` without
// practice, `getPractice` with the 1.9 fallback, the B2 cap, the stale-map
// conflict, the summaries and the delete cleanup. There is one user, so
// ownership checks reduce to "the song exists".
// Seed shape (db/seed.js): `db.songs` rows carry the 2.0 song fields; practice
// saved by 2.0 lives in `db.songPractice` ({songId, userId, practice, updatedAt});
// v1 rows still hold `songs.practice` (pre-backfill).
//   fx-library=slow   the library never arrives (the loading skeleton)
import {db, fx, clone, findSong, publicSong, convexError, NEVER} from './runtime.js';
import {PRACTICE_CAP, upgradePractice, summarize} from '../../../shared/practice.ts';
import {cleanSongMap, hasRealMap, mapSummaryOf, songMapFromTempo, barsOf, sectionsFromBars, sectionsOf} from '../../../shared/song-map.ts';
import {sameContent} from '../../../shared/content.ts';

const MAP_KEYS = new Set(['songMap', 'source', 'map', 'detected']);
const fail = (code, message, data = {}) => { throw convexError({...data, code, message}); };

/** A chart counts once it has a hit or a reviewed bar (notation.save, B1). */
function hasChart(s) {
  const score = db.notation?.[s.id]?.score;
  if (score) return score.bars.some(b => b.hits.length > 0 || b.coverage === 'reviewed');
  return s.hasChart === true;
}

function practiceRow(id) { return (db.songPractice ??= []).find(r => r.songId === id) ?? null; }

function summaryMap(s) {
  if (!hasRealMap(s.tempo, {hasPart: hasChart(s)})) return null;
  const duration = Math.max(0.001, s.duration || 0), bars = barsOf(songMapFromTempo(s.tempo, duration), duration);
  return {sections: sectionsFromBars(bars), bars};
}
function practiceSummary(practice, s) {
  const p = upgradePractice(practice, {legacyTempo: s.tempo, duration: s.duration});
  return {summary: summarize(p, p.loop?.on ? summaryMap(s) : null), lastAt: p.lastAt};
}
const mapSummary = s => mapSummaryOf(s.tempo, s.duration, {hasPart: hasChart(s)});

function uploadNames(filename) {
  const base = String(filename ?? '').split(/[\\/]/).pop().trim();
  return base ? [base, base.replace(/\.[^.]+$/, '')] : [];
}
/** convex/songs.ts reviewMetadataOf: the derived upload clause ends once `metadata:confirm` sets 'matched'. */
export function reviewMetadata(s) {
  if (s.needsReview === true || s.metadataStatus === 'uncertain') return true;
  if (s.metadataStatus === 'matched' || s.source?.type !== 'upload' || (s.artist ?? '').trim()) return false;
  return uploadNames(s.source.filename).includes(String(s.title).trim());
}

/**
 * convex/songs.ts toListRow. The chart flag is derived live from
 * `db.notation`, so when it differs from the stored flag (a chart saved or
 * removed here, which on the server rewrites the summaries with it) the
 * summaries are recomputed with it too.
 */
export function listRow(s) {
  const suggestion = s.metadataSuggestion;
  const stale = hasChart(s) !== s.hasChart, practice = practiceRow(s.id)?.practice ?? s.practice;
  return {
    id: s.id, title: s.title, artist: s.artist ?? '', album: s.album ?? '', albumArtist: s.albumArtist ?? '', uploader: s.uploader ?? '',
    duration: s.duration, addedAt: s.addedAt, stemMode: s.stemMode,
    stems: s.stems.map(({name, key, bytes, mime}) => ({name, key, ...(bytes !== undefined ? {bytes} : {}), ...(mime !== undefined ? {mime} : {})})),
    coverKey: s.coverKey ?? null, coverUrl: s.coverUrl ?? null, artwork: s.artwork ?? null, source: s.source ?? null, quality: s.quality,
    year: s.year ?? '', genre: s.genre ?? '', trackNumber: s.trackNumber ?? '', discNumber: s.discNumber ?? '',
    musicalKey: s.musicalKey ?? '', tuning: s.tuning ?? '', tags: s.tags ?? [], metadataStatus: s.metadataStatus ?? null,
    reviewMetadata: reviewMetadata(s), recordingUnconfirmed: s.recordingUnconfirmed === true,
    suggestion: suggestion ? {title: suggestion.title, artist: suggestion.artist ?? '', album: suggestion.album ?? '', releaseId: suggestion.releaseId ?? null} : null,
    hasChart: hasChart(s),
    mapSummary: clone(!stale && s.mapSummary ? s.mapSummary : mapSummary(s)),
    lastPracticedAt: s.lastPracticedAt ?? null,
    practiceSummary: clone(stale && practice != null ? practiceSummary(practice, s).summary
      : s.practiceSummary ?? (s.practice != null ? practiceSummary(s.practice, s).summary : null)),
    hasSectionSuggestion: (s.sectionSuggestion?.sections?.length ?? 0) > 0,
  };
}

/** convex/songs.ts toClient: the full song without practice (D52). */
function fullSong(s) {
  const {practice: _practice, practiceSummary: _summary, lastPracticedAt: _last, mapSummary: _map, sectionSuggestion: _suggestion,
    tempoRev: _rev, tempoSaveId: _saveId, recordingUnconfirmed: _unconfirmed, ...rest} = publicSong(s);
  return {...rest, metadataSuggestion: s.metadataSuggestion ? clone(s.metadataSuggestion) : null, needsReview: s.needsReview === true,
    resolvedUrl: s.resolvedUrl ?? null, provider: s.provider ?? null, originDeviceId: s.originDeviceId ?? null, tempo: clone(s.tempo ?? null), hasChart: hasChart(s)};
}

function owned(id) {
  const s = findSong(id);
  if (!s) fail('not_found', 'Song not found.');
  return s;
}
const sortedSongs = () => db.songs.slice().sort((a, b) => b.addedAt - a.addedAt);

export const handlers = {
  'songs:list': () => fx.library === 'slow' ? NEVER : ({songs: sortedSongs().map(listRow)}),

  'songs:get': ({id}) => {
    const s = findSong(id);
    if (!s) return null;
    return {...fullSong(s), tempoRev: s.tempoRev ?? 0, tempoSaveId: s.tempoSaveId ?? null, recordingUnconfirmed: s.recordingUnconfirmed === true,
      sectionSuggestion: clone(s.sectionSuggestion ?? null)};
  },

  'songs:getPractice': ({id}) => {
    const s = findSong(id);
    if (!s) return null;
    const row = practiceRow(id);
    return clone(row ? row.practice : s.practice ?? null);
  },

  'songs:getMany': ({ids}) => {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) fail('invalid', 'Choose between 1 and 100 songs.');
    return [...new Set(ids)].map(findSong).filter(Boolean).map(fullSong);
  },

  'songs:savePractice': ({id, practice, final}) => {
    const s = owned(id);
    if (!practice || typeof practice !== 'object' || Array.isArray(practice)) fail('invalid', 'These practice settings could not be saved.');
    const size = JSON.stringify(practice).length;
    if (size > PRACTICE_CAP) fail('practice_too_large', 'Practice settings are too large to save.', {size, cap: PRACTICE_CAP});
    const row = practiceRow(id);
    if (!row) db.songPractice.push({songId: id, userId: db.user?._id ?? s.userId, practice: clone(practice), updatedAt: Date.now()});
    else if (!sameContent(row.practice, practice)) Object.assign(row, {practice: clone(practice), updatedAt: Date.now()});
    if (final) {
      const {summary, lastAt} = practiceSummary(practice, s), lastPracticedAt = lastAt ?? s.lastPracticedAt;
      if (!sameContent(s.practiceSummary, summary) || lastPracticedAt !== s.lastPracticedAt) {
        s.practiceSummary = summary;
        if (lastPracticedAt === undefined) delete s.lastPracticedAt; else s.lastPracticedAt = lastPracticedAt;
      }
    }
    return null;
  },

  'songs:saveTempo': ({id, tempo, baseRev, saveId}) => {
    const s = owned(id);
    if (saveId !== undefined && (!saveId || saveId.length > 100)) fail('invalid', 'Invalid save id.');
    const songMap = cleanSongMap(tempo?.songMap);
    if (!songMap) fail('invalid', 'This song map could not be saved.');
    const stored = s.tempo && typeof s.tempo === 'object' ? s.tempo : {};
    const next = {...Object.fromEntries(Object.entries(stored).filter(([k, v]) => !MAP_KEYS.has(k) && v !== undefined)), songMap};
    const tempoRev = s.tempoRev ?? 0;
    if (sameContent(s.tempo, next)) return {tempoRev, conflict: false};
    if (baseRev !== tempoRev && hasRealMap(s.tempo) && !hasRealMap(next)) return {tempoRev, conflict: true, tempo: clone(s.tempo)};
    s.tempo = next;
    s.tempoRev = tempoRev + 1;
    if (saveId === undefined) delete s.tempoSaveId; else s.tempoSaveId = saveId;
    s.mapSummary = mapSummary(s);
    if (s.sectionSuggestion && sectionsOf(songMap, Math.max(0.001, s.duration || 0)).length) delete s.sectionSuggestion;
    return {tempoRev: s.tempoRev, conflict: false};
  },

  'songs:remove': ({id}) => {
    owned(id);
    db.songs = db.songs.filter(s => s.id !== id);
    db.songPractice = (db.songPractice ?? []).filter(r => r.songId !== id);
    for (const list of db.setlists ?? []) list.songIds = list.songIds.filter(songId => songId !== id);
    if (Array.isArray(db.settings?.pins)) db.settings.pins = db.settings.pins.filter(songId => songId !== id);
    for (const job of db.jobs ?? []) if (job.songId === id && ['queued', 'running'].includes(job.status)) job.status = 'canceled';
    if (db.notation) delete db.notation[id];
    if (db.shares) delete db.shares[id];
    return true;
  },

  'songs:confirmRecording': ({id}) => { delete owned(id).recordingUnconfirmed; return null; },
  'songs:dismissSectionSuggestion': ({id}) => { delete owned(id).sectionSuggestion; return null; },

  'songs:exportPage': () => ({
    page: sortedSongs().map(s => ({...fullSong(s), practice: clone(practiceRow(s.id)?.practice ?? s.practice ?? null)})),
    isDone: true, continueCursor: '',
  }),

  // Fixture only: songs.rename is deleted from Convex (§8, wave 0B). tests/fixture/unit/fixture-db.test.js
  // (FX1) still uses it as its sample mutation; remove it once that test uses a 2.0 mutation.
  'songs:rename': ({id, title}) => { owned(id).title = title; return fullSong(findSong(id)); },
};
