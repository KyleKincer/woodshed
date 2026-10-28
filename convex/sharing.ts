// Sharing (architecture §6.7, package BK5).
//
// A share link is one `songShares` row per song with a 64-hex token. Visitors
// read the song through `view` (public, no account) and keep a copy through
// `shareAudio.save`, which reserves storage here (`beginImport`), copies the
// audio in R2, then commits the new song here (`finishImport`).
//
// What a link carries is an explicit allowlist (`sharedSnapshot`): the song's
// public metadata, its stems, its map, and its practice setup run through
// `shared/practice.ts#sanitizeForShare` (loops, spots and markers; no spot
// notes, no practice history, no Minus me / Only me, no tombstones). Notes,
// personal tags, source paths, emails and account ids never leave the account.
//
// Stored data is read through the same one-way upgrades as everywhere else:
// practice comes from `songPractice` first, else the 1.9 `songs.practice`
// (v1 or v2), upgraded with the legacy click fields that 1.x kept inside
// `tempo` (D51). An import row written by 1.9 (a v1 practice and a legacy
// tempo in its snapshot) commits through the same normalisation, so nothing
// here needs a backfill.
import {v} from 'convex/values';
import {query, mutation, internalQuery, internalMutation} from './_generated/server';
import type {QueryCtx, MutationCtx} from './_generated/server';
import type {Doc, Id} from './_generated/dataModel';
import {internal} from './_generated/api';
import {requireUserId, requireWritableUserId, getUserId, accountControl} from './lib/auth';
import {fail} from './lib/errors';
import {coverKeyOf} from './lib/songMetadata';
import {adjust, limits, used, retireKey} from './storage';
import {capturePart, deletePart} from './notation';
import {cleanSongMap, hasRealMap, songMapFromTempo, mapSummaryOf, barsOf, sectionsFromBars, type SongMapData} from '../shared/song-map';
import {PRACTICE_CAP, upgradePractice, sanitizeForShare, prunePractice, summarize, type PracticeV2, type SummaryMap} from '../shared/practice';
import {MAX_MEASURES} from '../shared/notation';

/** Shown for every link that is revoked, malformed, or whose song is gone, suspended or not ready. */
export const UNAVAILABLE = 'This share link is unavailable. It may have been stopped or the song removed.';
/** `view.ownerName` when the owner has no usable name. */
export const ANONYMOUS_OWNER = 'a Woodshed user';
/** Legacy (pre-1.6) tempo lists are capped as 1.9 capped them. */
const MAX_LEGACY_ENTRIES = 8192;

function unavailable(): never { fail('not_found', UNAVAILABLE); }
const tokenValid = (token: string) => /^[a-f0-9]{64}$/.test(token);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : '';

type Song = Doc<'songs'>;
/** `{songMap}` for any song with a stored map; the legacy lists only for a pre-1.6 song that has nothing else. */
export type SharedTempo = {songMap?: SongMapData; source?: string; map?: Record<string, unknown>[]; detected?: Record<string, unknown>[]};
export type ShareSnapshot = {
  title: string; artist: string; album: string; albumArtist: string; year: string; genre: string;
  trackNumber: string; discNumber: string; musicalKey: string; tuning: string;
  duration: number; stems: Song['stems']; stemMode: string; quality: Song['quality'];
  coverKey: string | undefined; artwork: Song['artwork'];
  tempo: SharedTempo | undefined; practice: PracticeV2;
};

/** The song behind an active token, or null when the link must not work. */
export async function sharedSource(ctx: QueryCtx | MutationCtx, token: string) {
  if (!tokenValid(token)) return null;
  const share = await ctx.db.query('songShares').withIndex('by_token', q => q.eq('token', token)).unique();
  if (!share?.active) return null;
  const song = await ctx.db.get('songs', share.songId);
  if (!song || song.userId !== share.userId || (await accountControl(ctx, share.userId))?.status === 'suspended') return null;
  if (!song.stems.length || song.stems.length > 8) return null;
  for (const key of song.stems.map(s => s.key)) {
    const object = await ctx.db.query('audioObjects').withIndex('by_key', q => q.eq('key', key)).unique();
    if (object && object.status !== 'ready') return null;
  }
  return song;
}

function pick(value: unknown, keys: string[]) {
  const row = isRecord(value) ? value : {};
  return Object.fromEntries(keys.filter(k => ['string', 'number', 'boolean'].includes(typeof row[k])).map(k => [k, row[k]]));
}

/**
 * The map a link carries. A stored `songMap` is cleaned (its `origin` kept) and
 * an origin-less map someone made is stamped `edited`, as `SongMapStore.load`
 * would (`songMapFromTempo`; deterministic for stored maps, so every `view`
 * run returns the same measure ids). A pre-1.6 song with only a legacy `map`
 * or `detected` list carries those lists for the client's own one-way upgrade;
 * `finishImport` translates them once. Click settings never travel in `tempo`
 * (D51): `sharedPractice` moves them into `practice.click`.
 */
export function sharedTempo(tempo: unknown, duration: number): SharedTempo | undefined {
  if (!isRecord(tempo)) return undefined;
  if (cleanSongMap(tempo.songMap)) return {songMap: songMapFromTempo(tempo, duration)};
  if (!hasRealMap(tempo)) return undefined;
  return {
    ...pick(tempo, ['source']),
    map: Array.isArray(tempo.map) ? tempo.map.slice(0, MAX_LEGACY_ENTRIES).map(s => pick(s, ['t', 'bpm', 'beatsPerBar', 'unit'])) : [],
    detected: Array.isArray(tempo.detected) ? tempo.detected.slice(0, MAX_LEGACY_ENTRIES).map(b => pick(b, ['time', 'downbeat'])) : [],
  };
}

/** The tempo a saved copy stores: `{songMap}` only (D51), a legacy list translated once. */
function importedTempo(tempo: unknown, duration: number): {songMap: SongMapData} | undefined {
  if (!isRecord(tempo) || (!cleanSongMap(tempo.songMap) && !hasRealMap(tempo))) return undefined;
  return {songMap: songMapFromTempo(tempo, duration)};
}

/** Any stored practice (v1 or v2; `legacyTempo` for the 1.x click fields) as what a link may carry. */
export function sharedPractice(raw: unknown, legacyTempo: unknown, duration: number): PracticeV2 {
  return sanitizeForShare(upgradePractice(raw, {duration, legacyTempo}));
}

/** The song's stored practice: `songPractice` first, else the 1.9 `songs.practice` (read until V1). */
async function storedPractice(ctx: QueryCtx | MutationCtx, song: Song): Promise<unknown> {
  const row = await ctx.db.query('songPractice').withIndex('by_songId', q => q.eq('songId', song._id)).first();
  return row ? row.practice : song.practice;
}

/** Explicit allowlist: no notes, personal tags, source file paths or account ids. */
export async function sharedSnapshot(ctx: QueryCtx | MutationCtx, song: Song): Promise<ShareSnapshot> {
  return {
    title: song.title, artist: song.artist || song.uploader || '', album: song.album || '',
    albumArtist: song.albumArtist || '', year: song.year || '', genre: song.genre || '',
    trackNumber: song.trackNumber || '', discNumber: song.discNumber || '',
    musicalKey: song.musicalKey || '', tuning: song.tuning || '',
    duration: song.duration, stems: song.stems, stemMode: song.stemMode, quality: song.quality,
    coverKey: coverKeyOf(song), artwork: song.artwork?.kind === 'release' ? song.artwork : undefined,
    tempo: sharedTempo(song.tempo, song.duration),
    practice: sharedPractice(await storedPractice(ctx, song), song.tempo, song.duration),
  };
}

/**
 * How a link names its owner: the first word plus the last word's initial and
 * a full stop ("Kyle Kincer" → "Kyle K."); one word stays as is; no name, or a
 * name holding an email address, reads "a Woodshed user". Never an email.
 */
export function ownerNameOf(name: unknown): string {
  if (typeof name !== 'string' || /\S@\S/.test(name)) return ANONYMOUS_OWNER;
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return ANONYMOUS_OWNER;
  if (words.length === 1) return words[0];
  const initial = Array.from(words[words.length - 1]).find(c => /[\p{L}\p{N}]/u.test(c));
  return initial ? `${words[0]} ${initial.toLocaleUpperCase()}.` : words[0];
}

async function ownerName(ctx: QueryCtx, userId: string) {
  const id = ctx.db.normalizeId('users', userId);
  const user = id ? await ctx.db.get('users', id) : null;
  return ownerNameOf(user?.name);
}

async function requireOwnSong(ctx: QueryCtx | MutationCtx, userId: string, id: Id<'songs'>) {
  const song = await ctx.db.get('songs', id);
  if (!song || song.userId !== userId) fail('not_found', 'Song unavailable.');
  return song;
}

export const status = query({
  args: {id: v.id('songs')},
  handler: async (ctx, {id}) => {
    const userId = await requireUserId(ctx);
    await requireOwnSong(ctx, userId, id);
    const share = await ctx.db.query('songShares').withIndex('by_songId', q => q.eq('songId', id)).unique();
    return share?.active ? {token: share.token, includeNotation: share.includeNotation !== false} : null;
  },
});

export const create = mutation({
  args: {id: v.id('songs'), includeNotation: v.optional(v.boolean())},
  handler: async (ctx, {id, includeNotation}) => {
    const userId = await requireWritableUserId(ctx), song = await requireOwnSong(ctx, userId, id);
    if (!song.stems.length || song.stems.length > 8) fail('invalid', 'Finish processing this song before sharing it.');
    for (const stem of song.stems) {
      const object = await ctx.db.query('audioObjects').withIndex('by_key', q => q.eq('key', stem.key)).unique();
      if (object && object.status !== 'ready') fail('invalid', 'Finish syncing this song before sharing it.');
    }
    const existing = await ctx.db.query('songShares').withIndex('by_songId', q => q.eq('songId', id)).unique();
    if (existing?.active) {
      if (includeNotation !== undefined) await ctx.db.patch('songShares', existing._id, {includeNotation});
      return {token: existing.token};
    }
    // A stopped link never comes back: creating again always mints a new token.
    const token = (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '');
    const fields = {token, active: true, createdAt: Date.now(), includeNotation: includeNotation !== false};
    if (existing) await ctx.db.patch('songShares', existing._id, fields);
    else await ctx.db.insert('songShares', {songId: id, userId, ...fields});
    return {token};
  },
});

export const revoke = mutation({
  args: {id: v.id('songs')},
  handler: async (ctx, {id}) => {
    const userId = await requireUserId(ctx);
    const share = await ctx.db.query('songShares').withIndex('by_songId', q => q.eq('songId', id)).unique();
    if (share && share.userId !== userId) fail('not_owner', 'Not your share link.');
    if (share) await ctx.db.patch('songShares', share._id, {active: false});
    return null;
  },
});

export const view = query({
  args: {token: v.string()},
  handler: async (ctx, {token}) => {
    const song = await sharedSource(ctx, token);
    if (!song) return null;
    const snapshot = await sharedSnapshot(ctx, song);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(song.stems.map(s => s.key).join('|')));
    // Storage keys stay opaque to visitors; signing is a separate, scoped endpoint (`shareAudio.playback`).
    return {
      ...snapshot, id: 'shared', ownerName: await ownerName(ctx, song.userId),
      revision: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''),
      coverKey: snapshot.coverKey ? 'cover' : null,
      coverUrl: snapshot.artwork?.kind === 'release' ? `https://coverartarchive.org/release/${snapshot.artwork.releaseId}/front-500` : null,
      stems: snapshot.stems.map((s, i) => ({name: s.name, key: `stem-${i}`})),
    };
  },
});

export const mediaContext = internalQuery({
  args: {token: v.string()},
  handler: async (ctx, {token}) => {
    const song = await sharedSource(ctx, token);
    if (!song) unavailable();
    const cover = coverKeyOf(song);
    return [...song.stems.map((s, i) => ({id: `stem-${i}`, key: s.key})), ...(cover ? [{id: 'cover', key: cover}] : [])];
  },
});

export const saved = query({
  args: {token: v.string()},
  handler: async (ctx, {token}) => {
    const userId = await getUserId(ctx);
    if (!userId) return null;
    const song = await sharedSource(ctx, token);
    if (!song) return null;
    if (song.userId === userId) return {songId: song._id, status: 'ready' as const};
    const row = await ctx.db.query('shareImports').withIndex('by_userId_and_sourceSongId', q => q.eq('userId', userId).eq('sourceSongId', song._id)).unique();
    if (row?.songId && await ctx.db.get('songs', row.songId)) return {songId: row.songId, status: 'ready' as const};
    return row?.status === 'copying' ? {songId: null, status: 'copying' as const} : null;
  },
});

/** The storage keys `shareAudio.save` copies: the stems, then the cover. */
export const importContext = internalQuery({
  args: {token: v.string()},
  handler: async (ctx, {token}) => {
    await requireWritableUserId(ctx);
    const song = await sharedSource(ctx, token);
    if (!song) unavailable();
    const cover = coverKeyOf(song);
    return {keys: [...song.stems.map(s => s.key), ...(cover ? [cover] : [])]};
  },
});

const headValidator = v.object({sourceKey: v.string(), bytes: v.number(), mime: v.string(), etag: v.string()});

export const beginImport = internalMutation({
  args: {token: v.string(), heads: v.array(headValidator)},
  handler: async (ctx, {token, heads}) => {
    const userId = await requireWritableUserId(ctx), song = await sharedSource(ctx, token);
    if (!song) unavailable();
    if (song.userId === userId) return {songId: song._id};
    const existing = await ctx.db.query('shareImports').withIndex('by_userId_and_sourceSongId', q => q.eq('userId', userId).eq('sourceSongId', song._id)).unique();
    if (existing?.songId && await ctx.db.get('songs', existing.songId)) return {songId: existing.songId};
    if (existing?.status === 'copying') fail('invalid', 'This song is already being added. Please wait.');
    const snapshot = await sharedSnapshot(ctx, song), keys = [...song.stems.map(s => s.key), ...(snapshot.coverKey ? [snapshot.coverKey] : [])];
    if (heads.length !== keys.length || new Set(heads.map(h => h.sourceKey)).size !== keys.length ||
      heads.some(h => !keys.includes(h.sourceKey) || !Number.isSafeInteger(h.bytes) || h.bytes < 1 || h.bytes > 250_000_000 || !h.etag))
      fail('invalid', 'The shared audio changed. Reload the link and try again.');
    if ((await ctx.db.query('songs').withIndex('by_user', q => q.eq('userId', userId)).take(1000)).length >= 1000)
      fail('invalid', 'Your library has reached its song limit. Remove a song before adding another.');
    const bytes = heads.reduce((n, h) => n + h.bytes, 0), policy = await limits(ctx, userId);
    if (await used(ctx, `user:${userId}`) + bytes > policy.userBytes) fail('storage_full_user', 'Your cloud library is full. Upgrade or remove songs, then try again.');
    if (await used(ctx, 'app') + bytes > policy.appBytes) fail('storage_full_app', 'Cloud storage is currently full. Try adding this song later.');
    const attempt = crypto.randomUUID(), expiresAt = Date.now() + 15 * 60_000;
    await adjust(ctx, userId, bytes);
    const files = [];
    for (const [i, h] of heads.entries()) {
      const key = `users/${encodeURIComponent(userId)}/shared/${attempt}/${i}`;
      const objectId = await ctx.db.insert('audioObjects', {userId, key, name: `shared-${i}`, bytes: h.bytes, mime: h.mime, checksum: '', expiresAt, status: 'reserved'});
      files.push({...h, key, objectId});
    }
    if (existing?.notationPartId) await deletePart(ctx, existing.notationPartId);
    const notationPartId = await capturePart(ctx, song._id, userId);
    const row = {userId, sourceSongId: song._id, token, attempt, status: 'copying' as const, snapshot, expiresAt, files, songId: undefined, notationPartId};
    const id = existing ? existing._id : await ctx.db.insert('shareImports', row);
    if (existing) await ctx.db.replace('shareImports', id, row);
    await ctx.scheduler.runAt(expiresAt, internal.sharing.failImport, {id, attempt});
    return {id, attempt, files};
  },
});

/** True when the copied part holds a chart: any hit, or any bar marked reviewed (as `notation.save` decides). */
async function partHasChart(ctx: MutationCtx, partId: Id<'notationParts'>) {
  const part = await ctx.db.get('notationParts', partId);
  if (!part) return false;
  if (part.hitCount > 0) return true;
  const rows = await ctx.db.query('notationBars').withIndex('by_partId', q => q.eq('partId', partId)).take(MAX_MEASURES + 1);
  return rows.some(row => row.bar.coverage === 'reviewed');
}

/** The map `summarize` labels loops against, or null for an unmapped song (its loops read 'm:ss–m:ss loop'). */
function summaryMapOf(tempo: unknown, duration: number, hasPart: boolean): SummaryMap | null {
  if (!hasRealMap(tempo, {hasPart})) return null;
  const seconds = Math.max(0.001, duration || 0), bars = barsOf(songMapFromTempo(tempo, seconds), seconds);
  return {sections: sectionsFromBars(bars), bars};
}

export const finishImport = internalMutation({
  args: {id: v.id('shareImports'), attempt: v.string()},
  handler: async (ctx, {id, attempt}) => {
    const userId = await requireWritableUserId(ctx), row = await ctx.db.get('shareImports', id);
    if (!row || row.userId !== userId || row.attempt !== attempt) fail('not_found', 'Import unavailable.');
    if (row.status === 'ready' && row.songId) return row.songId;
    if (row.status !== 'copying' || row.expiresAt <= Date.now()) fail('invalid', 'Adding this song timed out. Please try again.');
    if (!await sharedSource(ctx, row.token)) unavailable();
    const snapshot: Record<string, unknown> = isRecord(row.snapshot) ? row.snapshot : {};
    const duration = typeof snapshot.duration === 'number' ? snapshot.duration : 0;
    const stems = (Array.isArray(snapshot.stems) ? snapshot.stems as Song['stems'] : []).map(s => {
      const f = row.files.find(f => f.sourceKey === s.key);
      if (!f) fail('invalid', 'The shared audio changed. Reload the link and try again.');
      return {name: s.name, key: f.key, bytes: f.bytes, mime: f.mime};
    });
    const coverSource = typeof snapshot.coverKey === 'string' ? snapshot.coverKey : undefined;
    const coverKey = coverSource ? row.files.find(f => f.sourceKey === coverSource)?.key : undefined;
    const artwork = isRecord(snapshot.artwork) && snapshot.artwork.kind === 'release' ? snapshot.artwork as Song['artwork'] : undefined;
    // A row written by 1.9 holds a v1 practice and a legacy tempo; both upgrade here, once.
    const tempo = importedTempo(snapshot.tempo, duration);
    const now = Date.now();
    const practice = prunePractice(sharedPractice(snapshot.practice, snapshot.tempo, duration), PRACTICE_CAP, now).value;
    const hasChart = row.notationPartId ? await partHasChart(ctx, row.notationPartId) : false;
    // Built field by field, so `practice` (and anything else in the snapshot that is not a song column) never reaches `songs`.
    const songId = await ctx.db.insert('songs', {
      userId, addedAt: now,
      title: text(snapshot.title) || 'Shared song', artist: text(snapshot.artist), album: text(snapshot.album),
      albumArtist: text(snapshot.albumArtist), year: text(snapshot.year), genre: text(snapshot.genre),
      trackNumber: text(snapshot.trackNumber), discNumber: text(snapshot.discNumber),
      musicalKey: text(snapshot.musicalKey), tuning: text(snapshot.tuning),
      duration, stems, stemMode: text(snapshot.stemMode), quality: snapshot.quality as Song['quality'],
      ...(coverKey ? {coverKey} : {}), ...(artwork ? {artwork} : {}), ...(tempo ? {tempo} : {}),
      tempoRev: 0, hasChart,
      mapSummary: mapSummaryOf(tempo, duration, {hasPart: hasChart}),
      practiceSummary: summarize(practice, summaryMapOf(tempo, duration, hasChart)),
    });
    await ctx.db.insert('songPractice', {songId, userId, practice, updatedAt: now});
    for (const f of row.files) {
      const object = await ctx.db.get('audioObjects', f.objectId);
      if (object?.status !== 'reserved') fail('invalid', 'Import expired.');
      await ctx.db.patch('audioObjects', f.objectId, {status: 'ready', songId, verified: true});
    }
    if (row.notationPartId) await ctx.db.patch('notationParts', row.notationPartId, {songId});
    await ctx.db.patch('shareImports', id, {status: 'ready', songId, snapshot: null, files: [], notationPartId: undefined});
    return songId;
  },
});

export const failImport = internalMutation({
  args: {id: v.id('shareImports'), attempt: v.string()},
  handler: async (ctx, {id, attempt}) => {
    const row = await ctx.db.get('shareImports', id);
    if (!row || row.attempt !== attempt || row.status !== 'copying') return null;
    for (const f of row.files) await retireKey(ctx, f.key);
    if (row.notationPartId) await deletePart(ctx, row.notationPartId);
    await ctx.db.patch('shareImports', id, {status: 'failed', snapshot: null, files: [], notationPartId: undefined});
    return null;
  },
});
