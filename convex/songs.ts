import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { getUserId, requireUserId } from './lib/auth';
import { fail } from './lib/errors';
import { r2 } from './r2';
import { release } from './renditions';
import { retireKey } from './storage';
import { paginationOptsValidator } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { coverKeyOf } from './lib/songMetadata';
import { readPart, deletePart } from './notation';
import { sameContent } from '../shared/content';
import { PRACTICE_CAP } from '../shared/practice';
import { cleanSongMap, hasRealMap, sectionsOf } from '../shared/song-map';
import { chartOf, ensureBackfill, mapSummaryFor, practiceSummaryFor, storedPractice } from './migrations';

type Song = Doc<'songs'>;

/** Songs per library read and per bulk read (D34). */
export const LIST_LIMIT = 1000, MANY_LIMIT = 100;
/** `tempo` keys that describe the map. Everything else 1.9 stored there (the click settings) is kept as is (D51). */
const MAP_KEYS = new Set(['songMap', 'source', 'map', 'detected']);
const MAX_SAVE_ID = 100;

const coverUrlOf = (s: Song) =>
  s.artwork?.kind === 'release' ? `https://coverartarchive.org/release/${s.artwork.releaseId}/front-500` : null;

/** The file name of an upload, with and without its extension. */
function uploadNames(filename: string | undefined) {
  const base = String(filename ?? '').split(/[\\/]/).pop()!.trim();
  return base ? [base, base.replace(/\.[^.]+$/, '')] : [];
}

/**
 * The Library's "Is this right?" flag (D43): an untitled upload, a metadata
 * lookup that was not sure, or an upload still named after its file.
 */
export function reviewMetadataOf(s: Pick<Song, 'needsReview' | 'metadataStatus' | 'source' | 'artist' | 'title'>) {
  if (s.needsReview === true || s.metadataStatus === 'uncertain') return true;
  if (s.source?.type !== 'upload' || (s.artist ?? '').trim()) return false;
  return uploadNames(s.source.filename).includes(s.title.trim());
}

/**
 * The slim Library row (B1, D4, D5): no notes, tempo, practice, metadata
 * locks or recording/release ids. A row the B1 upgrade has not reached yet
 * gets its summaries computed here, from the same functions the upgrade uses,
 * with `hasChart` as `chartOf` derived it (a summary stored while the flag was
 * unknown may have missed the chart, so it is recomputed too).
 */
export function toListRow(s: Song, hasChart = s.hasChart === true) {
  const chartKnown = s.hasChart !== undefined, current = { ...s, hasChart };
  const mapSummary = chartKnown && s.mapSummary ? s.mapSummary : mapSummaryFor(current);
  const practiceSummary = s.practiceSummary ?? (s.practice != null ? practiceSummaryFor(s.practice, current).summary : null);
  return {
    id: s._id,
    title: s.title,
    artist: s.artist ?? '',
    album: s.album ?? '',
    albumArtist: s.albumArtist ?? '',
    uploader: s.uploader ?? '',
    duration: s.duration,
    addedAt: s.addedAt,
    stemMode: s.stemMode,
    stems: s.stems.map(({ name, key, bytes, mime }) => ({ name, key, ...(bytes !== undefined ? { bytes } : {}), ...(mime !== undefined ? { mime } : {}) })),
    coverKey: coverKeyOf(s) ?? null,
    coverUrl: coverUrlOf(s),
    artwork: s.artwork ?? null,
    source: s.source ?? null,
    quality: s.quality,
    year: s.year ?? '',
    genre: s.genre ?? '',
    trackNumber: s.trackNumber ?? '',
    discNumber: s.discNumber ?? '',
    musicalKey: s.musicalKey ?? '',
    tuning: s.tuning ?? '',
    tags: s.tags ?? [],
    metadataStatus: s.metadataStatus ?? null,
    reviewMetadata: reviewMetadataOf(s),
    recordingUnconfirmed: s.recordingUnconfirmed === true,
    suggestion: s.metadataSuggestion
      ? { title: s.metadataSuggestion.title, artist: s.metadataSuggestion.artist ?? '', album: s.metadataSuggestion.album ?? '', releaseId: s.metadataSuggestion.releaseId ?? null }
      : null,
    hasChart,
    mapSummary,
    lastPracticedAt: s.lastPracticedAt ?? null,
    practiceSummary,
    hasSectionSuggestion: (s.sectionSuggestion?.sections.length ?? 0) > 0,
  };
}

/**
 * The whole library, newest first, as slim rows (§6.3). Keeps the `{songs}`
 * envelope. Rows carry R2 *keys*, not URLs: signing happens in
 * `media.signKeys`, so this query stays cheap and its results stay stable.
 */
export const list = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    if (!userId) return { songs: [] };
    const songs = await ctx.db
      .query('songs')
      .withIndex('by_user_added', (q) => q.eq('userId', userId))
      .order('desc')
      .take(LIST_LIMIT);
    return { songs: await Promise.all(songs.map(async s => toListRow(s, await chartOf(ctx, s)))) };
  },
});

/** The full song for its owner (no practice, D52), else null. */
export const get = query({
  args: { id: v.id('songs') },
  returns: v.any(),
  handler: async (ctx, args) => {
    const song = await ownedOrNull(ctx, args.id);
    if (!song) return null;
    return {
      ...toClient(song, await chartOf(ctx, song)),
      tempoRev: song.tempoRev ?? 0,
      tempoSaveId: song.tempoSaveId ?? null,
      recordingUnconfirmed: song.recordingUnconfirmed === true,
      sectionSuggestion: song.sectionSuggestion ?? null,
    };
  },
});

/** The stored practice blob (any version; the client upgrades it), falling back to the 1.9 `songs.practice` (until V1). */
export const getPractice = query({
  args: { id: v.id('songs') },
  returns: v.any(),
  handler: async (ctx, args) => {
    const song = await ownedOrNull(ctx, args.id);
    if (!song) return null;
    return storedPractice(ctx, song);
  },
});

/** The owner's songs among `ids` (1–100, bulk Details, G9), in the order asked; missing and foreign ids are omitted. */
export const getMany = query({
  args: { ids: v.array(v.id('songs')) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    if (args.ids.length < 1 || args.ids.length > MANY_LIMIT) fail('invalid', `Choose between 1 and ${MANY_LIMIT} songs.`);
    const userId = await getUserId(ctx);
    if (!userId) return [];
    const out = [];
    for (const id of new Set(args.ids)) {
      const song = await ctx.db.get('songs', id);
      if (song && song.userId === userId) out.push(toClient(song, await chartOf(ctx, song)));
    }
    return out;
  },
});

/**
 * The full client shape: the 1.9 library.json entry (without practice, D52)
 * plus the 2.0 song fields. `id` is the Convex document id. Readers pass
 * `hasChart` from `chartOf`, so a song the upgrade has not reached still
 * opens with its chart (§2.14.1).
 */
export function toClient(s: Song, hasChart = s.hasChart === true) {
  return {
    albumArtist: s.albumArtist ?? '', year: s.year ?? '', genre: s.genre ?? '',
    trackNumber: s.trackNumber ?? '', discNumber: s.discNumber ?? '',
    musicalKey: s.musicalKey ?? '', tuning: s.tuning ?? '', tags: s.tags ?? [], notes: s.notes ?? '',
    metadataLocks: s.metadataLocks ?? [],
    metadataStatus: s.metadataStatus ?? null,
    metadataRecordingId: s.metadataRecordingId ?? null,
    metadataReleaseId: s.metadataReleaseId ?? null,
    metadataSuggestion: s.metadataSuggestion ?? null,
    needsReview: s.needsReview === true,
    artwork: s.artwork ?? null,
    coverUrl: coverUrlOf(s),
    id: s._id,
    title: s.title,
    uploader: s.uploader ?? '',
    artist: s.artist ?? '',
    album: s.album ?? '',
    duration: s.duration,
    source: s.source ?? null,
    resolvedUrl: s.resolvedUrl ?? null,
    provider: s.provider ?? null,
    originDeviceId: s.originDeviceId ?? null,
    coverKey: coverKeyOf(s) ?? null,
    stems: s.stems,
    stemMode: s.stemMode,
    quality: s.quality,
    addedAt: s.addedAt,
    tempo: s.tempo ?? null,
    hasChart,
  };
}

/** The `tempo` fields that are not the map: what 1.9 left there (D51), kept for `upgradePractice`. */
export function nonMapFields(tempo: unknown): Record<string, unknown> {
  if (!tempo || typeof tempo !== 'object' || Array.isArray(tempo)) return {};
  return Object.fromEntries(Object.entries(tempo as Record<string, unknown>).filter(([key, value]) => !MAP_KEYS.has(key) && value !== undefined));
}

/**
 * Saves the song map (`tempo.songMap`). A stale save (`baseRev` behind
 * `tempoRev`) that would replace a real map with a non-real one keeps the
 * stored map and returns it as a conflict, writing nothing (no `tempoRev`
 * bump, no `tempoSaveId`). Every write bumps `tempoRev`, stores `tempoSaveId`
 * (D53), recomputes `mapSummary` (with `hasChart` from `chartOf`) and clears a
 * section suggestion once the map has sections (D47). Unchanged content is a
 * no-op.
 */
export const saveTempo = mutation({
  args: { id: v.id('songs'), tempo: v.any(), baseRev: v.optional(v.number()), saveId: v.optional(v.string()) },
  returns: v.object({ tempoRev: v.number(), conflict: v.boolean(), tempo: v.optional(v.any()) }),
  handler: async (ctx, args) => {
    const song = await requireOwned(ctx, args.id);
    if (args.saveId !== undefined && (!args.saveId || args.saveId.length > MAX_SAVE_ID)) fail('invalid', 'Invalid save id.');
    const songMap = cleanSongMap((args.tempo as { songMap?: unknown } | null)?.songMap);
    if (!songMap) fail('invalid', 'This song map could not be saved.');
    const tempo = { ...nonMapFields(song.tempo), songMap };
    const tempoRev = song.tempoRev ?? 0;
    if (sameContent(song.tempo, tempo)) return { tempoRev, conflict: false };
    if (args.baseRev !== tempoRev && hasRealMap(song.tempo) && !hasRealMap(tempo)) return { tempoRev, conflict: true, tempo: song.tempo };
    await ensureBackfill(ctx, song.userId);
    const duration = Math.max(0.001, song.duration || 0);
    const hasChart = await chartOf(ctx, song);
    const patch: Partial<Song> = {
      tempo, tempoRev: tempoRev + 1, tempoSaveId: args.saveId,
      mapSummary: mapSummaryFor({ tempo, duration: song.duration, hasChart }),
    };
    if (song.hasChart === undefined) patch.hasChart = hasChart;
    if (song.sectionSuggestion && sectionsOf(songMap, duration).length) patch.sectionSuggestion = undefined;
    await ctx.db.patch('songs', song._id, patch);
    return { tempoRev: tempoRev + 1, conflict: false };
  },
});

/**
 * What a final practice save writes to `songs`: the new `practiceSummary` and
 * `lastPracticedAt`, or null when neither changed (D52, R3).
 */
export function summaryPatch(song: Song, practice: unknown, hasChart = song.hasChart === true): Pick<Song, 'practiceSummary' | 'lastPracticedAt'> | null {
  const { summary, lastAt } = practiceSummaryFor(practice, { ...song, hasChart });
  const lastPracticedAt = lastAt ?? song.lastPracticedAt;
  if (sameContent(song.practiceSummary, summary) && lastPracticedAt === song.lastPracticedAt) return null;
  return { practiceSummary: summary, lastPracticedAt };
}

/**
 * Upserts the song's practice (`songPractice`, B1). Rejects a blob over
 * `PRACTICE_CAP` (B2). Only a final save (stop, leave, pagehide, dispose)
 * touches `songs`, and only when the summary or `lastPracticedAt` changed (D52).
 */
export const savePractice = mutation({
  args: { id: v.id('songs'), practice: v.any(), final: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, { id, practice, final }) => {
    const song = await requireOwned(ctx, id);
    if (!practice || typeof practice !== 'object' || Array.isArray(practice)) fail('invalid', 'These practice settings could not be saved.');
    const size = JSON.stringify(practice).length;
    if (size > PRACTICE_CAP) fail('practice_too_large', 'Practice settings are too large to save.', { size, cap: PRACTICE_CAP });
    await ensureBackfill(ctx, song.userId);
    const row = await practiceRow(ctx, song._id);
    if (!row) await ctx.db.insert('songPractice', { songId: song._id, userId: song.userId, practice, updatedAt: Date.now() });
    else if (!sameContent(row.practice, practice)) await ctx.db.patch('songPractice', row._id, { practice, updatedAt: Date.now() });
    const patch = final ? summaryPatch(song, practice, await chartOf(ctx, song)) : null;
    if (patch) await ctx.db.patch('songs', song._id, patch);
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id('songs') },
  returns: v.any(),
  handler: async (ctx, args) => {
    const song = await requireOwned(ctx, args.id);
    await deleteSongData(ctx, song);
    return true;
  },
});

/** "Is this the right recording?" → Yes (D43). */
export const confirmRecording = mutation({
  args: { id: v.id('songs') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const song = await requireOwned(ctx, args.id);
    if (song.recordingUnconfirmed !== undefined) await ctx.db.patch('songs', song._id, { recordingUnconfirmed: undefined });
    return null;
  },
});

/** Drops the section suggestion: after Keep all applied it to the map, or ✕ (D47). */
export const dismissSectionSuggestion = mutation({
  args: { id: v.id('songs') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const song = await requireOwned(ctx, args.id);
    if (song.sectionSuggestion !== undefined) await ctx.db.patch('songs', song._id, { sectionSuggestion: undefined });
    return null;
  },
});

/**
 * Deletes a song and everything that belongs to it: the drum part, its
 * practice, its place in setlists and pins, its live jobs, and its audio
 * (freed only when no other song holds it). Billing cleanup uses this too.
 */
export async function deleteSongData(ctx: MutationCtx, song: Song) {
    const notation=await readPart(ctx,song._id);if(notation)await deletePart(ctx,notation.part._id,{songDeleted:true});
    for (const row of await ctx.db.query('songPractice').withIndex('by_songId', q => q.eq('songId', song._id)).take(10)) await ctx.db.delete('songPractice', row._id);
    const setlists = await ctx.db.query('setlists').withIndex('by_userId_and_updatedAt', q => q.eq('userId', song.userId)).take(100);
    for (const list of setlists)
      if (list.songIds.includes(song._id)) await ctx.db.patch('setlists', list._id, { songIds: list.songIds.filter(id => id !== song._id) });
    const settings = await ctx.db.query('userSettings').withIndex('by_user', q => q.eq('userId', song.userId)).unique();
    const pins: unknown = settings?.settings?.pins;
    if (settings && Array.isArray(pins) && pins.includes(song._id))
      await ctx.db.patch('userSettings', settings._id, { settings: { ...settings.settings, pins: pins.filter(id => id !== song._id) } });
    // Shared audio is freed by `release` only when this was the last song
    // holding it; `freeBlobs` is true only when this song owned its stems
    // outright, in which case clean them up here.
    for (const key of [...song.stems.map(s => s.key), ...(song.coverKey ? [song.coverKey] : [])]) await retireKey(ctx, key);
    const jobs = await ctx.db.query('jobs').withIndex('by_song', q => q.eq('songId', song._id)).take(100);
    for (const job of jobs) if (['queued', 'running'].includes(job.status)) await ctx.db.patch('jobs', job._id, {status: 'canceled'});
    const { freeBlobs } = await release(ctx, song);
    if (freeBlobs) {
      // Best-effort blob cleanup: a failed delete would otherwise strand the
      // row, and an orphaned R2 object is cheaper than an undeletable song.
      for (const stem of song.stems) {
        try {
          const tracked = await ctx.db.query('audioObjects').withIndex('by_key', q => q.eq('key', stem.key)).unique();
          if (!tracked) await r2.deleteObject(ctx, stem.key);
        } catch {
          /* orphaned object; swept separately */
        }
      }
      if (song.coverKey) {
        try {
          const key = song.coverKey;
          const tracked = await ctx.db.query('audioObjects').withIndex('by_key', q => q.eq('key', key)).unique();
          if (!tracked) await r2.deleteObject(ctx, key);
        } catch {
          /* ignore */
        }
      }
    }
    if (song.artwork?.kind === 'upload') await retireKey(ctx, song.artwork.key);
    await ctx.db.delete('songs', song._id);
}

async function practiceRow(ctx: QueryCtx | MutationCtx, songId: Id<'songs'>) {
  return ctx.db.query('songPractice').withIndex('by_songId', q => q.eq('songId', songId)).unique();
}

async function ownedOrNull(ctx: QueryCtx, id: Id<'songs'>) {
  const userId = await getUserId(ctx);
  const song = userId ? await ctx.db.get('songs', id) : null;
  return song && song.userId === userId ? song : null;
}

/** Owner only. Export-only accounts may change personal state (D10), so this needs only a signed-in user. */
async function requireOwned(ctx: MutationCtx, id: Id<'songs'>) {
  const userId = await requireUserId(ctx);
  const song = await ctx.db.get('songs', id);
  if (!song) fail('not_found', 'Song not found.');
  if (song.userId !== userId) fail('not_owner', 'Not your song.');
  return song;
}

/** The export ZIP's pages: the full song plus its practice (from `songPractice`, else the 1.9 `songs.practice`). */
export const exportPage = query({
  args: { paginationOpts: paginationOptsValidator }, returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const page = await ctx.db.query('songs').withIndex('by_user', q => q.eq('userId', userId)).paginate(args.paginationOpts);
    const songs = [];
    for (const song of page.page) songs.push({ ...toClient(song, await chartOf(ctx, song)), practice: await storedPractice(ctx, song) });
    return { ...page, page: songs };
  },
});
