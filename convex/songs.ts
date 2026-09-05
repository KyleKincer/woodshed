import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { getUserId, requireUserId } from './lib/auth';
import { r2 } from './r2';
import { release } from './renditions';
import { retireKey } from './storage';
import { paginationOptsValidator } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { qualityValidator, sourceValidator, stemValidator } from './schema';

/**
 * The whole library, newest first.
 *
 * Note this returns R2 *keys*, not URLs — signing happens in `media.signKeys`
 * so this query stays cheap and its results stay stable across re-runs (a
 * freshly-signed URL on every reactive tick would bust the browser's cache).
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
      .take(1000);
    return { songs: songs.map(toClient) };
  },
});

export const get = query({
  args: { id: v.id('songs') },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await getUserId(ctx);
    const song = await ctx.db.get(args.id);
    if (!song || !userId || song.userId !== userId) return null;
    return toClient(song);
  },
});

// Keep the client-facing shape identical to the old library.json entries so
// the player and library UI need no reshaping. `id` is the Convex document id.
export function toClient(s: Doc<"songs">) {
  return {
    id: s._id,
    title: s.title,
    uploader: s.uploader ?? '',
    artist: s.artist ?? '',
    album: s.album ?? '',
    duration: s.duration,
    source: s.source ?? null,
    coverKey: s.coverKey ?? null,
    stems: s.stems,
    stemMode: s.stemMode,
    quality: s.quality,
    addedAt: s.addedAt,
    tempo: s.tempo ?? null,
    practice: s.practice ?? null,
  };
}

export const rename = mutation({
  args: { id: v.id('songs'), title: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const song = await requireOwned(ctx, args.id);
    await ctx.db.patch(song._id, { title: args.title });
    return toClient({ ...song, title: args.title });
  },
});

export const saveTempo = mutation({
  args: { id: v.id('songs'), tempo: v.any() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const song = await requireOwned(ctx, args.id);
    await ctx.db.patch(song._id, { tempo: args.tempo });
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id('songs') },
  returns: v.any(),
  handler: async (ctx, args) => {
    const song = await requireOwned(ctx, args.id);
    await deleteSongData(ctx,song);
    return true;
  },
});

export async function deleteSongData(ctx: MutationCtx, song: Doc<'songs'>) {
    // Shared audio is freed by `release` only when this was the last song
    // holding it; `freeBlobs` is true only when this song owned its stems
    // outright, in which case clean them up here.
    for (const key of [...song.stems.map(s => s.key), ...(song.coverKey ? [song.coverKey] : [])]) await retireKey(ctx, key);
    const jobs = await ctx.db.query('jobs').withIndex('by_song', q => q.eq('songId', song._id)).take(100);
    for (const job of jobs) if (['queued', 'running'].includes(job.status)) await ctx.db.patch(job._id, {status: 'canceled'});
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
    await ctx.db.delete(song._id);
}

async function requireOwned(ctx: MutationCtx, id: Id<'songs'>) {
  const userId = await requireUserId(ctx);
  const song = await ctx.db.get(id);
  if (!song) throw new Error('Song not found.');
  if (song.userId !== userId) throw new Error('Not your song.');
  return song;
}


export const savePractice = mutation({
  args: { id: v.id('songs'), practice: v.any() }, returns: v.null(),
  handler: async (ctx, {id, practice}) => {
    const song = await requireOwned(ctx, id);
    if (JSON.stringify(practice).length > 10_000) throw new Error('Practice settings too large.');
    await ctx.db.patch(song._id, {practice}); return null;
  },
});
export const exportPage = query({
  args: { paginationOpts: paginationOptsValidator }, returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const page = await ctx.db.query('songs').withIndex('by_user', q => q.eq('userId', userId)).paginate(args.paginationOpts);
    return { ...page, page: page.page.map(toClient) };
  },
});
