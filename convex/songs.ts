import { v } from 'convex/values';
import { internalMutation, mutation, query } from './_generated/server';
import { getUserId, requireUserId } from './lib/auth';
import { r2 } from './r2';
import { register, release } from './renditions';
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
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    if (!userId) return { songs: [] };
    const songs = await ctx.db
      .query('songs')
      .withIndex('by_user_added', (q) => q.eq('userId', userId))
      .order('desc')
      .collect();
    return { songs: songs.map(toClient) };
  },
});

export const get = query({
  args: { id: v.id('songs') },
  handler: async (ctx, args) => {
    const userId = await getUserId(ctx);
    const song = await ctx.db.get(args.id);
    if (!song || !userId || song.userId !== userId) return null;
    return toClient(song);
  },
});

// Keep the client-facing shape identical to the old library.json entries so
// the player and library UI need no reshaping. `id` is the Convex document id.
function toClient(s: any) {
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
  };
}

export const rename = mutation({
  args: { id: v.id('songs'), title: v.string() },
  handler: async (ctx, args) => {
    const song = await requireOwned(ctx, args.id);
    await ctx.db.patch(song._id, { title: args.title });
    return toClient({ ...song, title: args.title });
  },
});

export const saveTempo = mutation({
  args: { id: v.id('songs'), tempo: v.any() },
  handler: async (ctx, args) => {
    const song = await requireOwned(ctx, args.id);
    await ctx.db.patch(song._id, { tempo: args.tempo });
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id('songs') },
  handler: async (ctx, args) => {
    const song = await requireOwned(ctx, args.id);
    // Shared audio is freed by `release` only when this was the last song
    // holding it; `freeBlobs` is true only when this song owned its stems
    // outright, in which case clean them up here.
    const { freeBlobs } = await release(ctx, song);
    if (freeBlobs) {
      // Best-effort blob cleanup: a failed delete would otherwise strand the
      // row, and an orphaned R2 object is cheaper than an undeletable song.
      for (const stem of song.stems) {
        try {
          await r2.deleteObject(ctx, stem.key);
        } catch {
          /* orphaned object; swept separately */
        }
      }
      if (song.coverKey) {
        try {
          await r2.deleteObject(ctx, song.coverKey);
        } catch {
          /* ignore */
        }
      }
    }
    await ctx.db.delete(song._id);
    return true;
  },
});

async function requireOwned(ctx: any, id: any) {
  const userId = await requireUserId(ctx);
  const song = await ctx.db.get(id);
  if (!song) throw new Error('Song not found.');
  if (song.userId !== userId) throw new Error('Not your song.');
  return song;
}

// ---- internal: written by the Modal callback path -------------------------

export const upsertFromJob = internalMutation({
  args: {
    userId: v.string(),
    songId: v.optional(v.id('songs')),
    title: v.string(),
    uploader: v.optional(v.string()),
    artist: v.optional(v.string()),
    album: v.optional(v.string()),
    duration: v.number(),
    source: v.optional(sourceValidator),
    coverKey: v.optional(v.string()),
    stems: v.array(stemValidator),
    stemMode: v.string(),
    quality: qualityValidator,
    resolvedUrl: v.optional(v.string()),
    addedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const { songId, resolvedUrl, ...fields } = args;

    // Publish the new audio so the next request for the same track at the same
    // settings skips the GPU entirely. Returns null for uploads, which are the
    // user's own files and never shared.
    const renditionId = await register(ctx, {
      source: fields.source,
      resolvedUrl,
      quality: fields.quality,
      stemMode: fields.stemMode,
      stems: fields.stems,
      coverKey: fields.coverKey,
      title: fields.title,
      uploader: fields.uploader,
      artist: fields.artist,
      album: fields.album,
      duration: fields.duration,
    });

    if (songId) {
      const existing = await ctx.db.get(songId);
      if (existing && existing.userId === args.userId) {
        // A reprocess replaces the audio but keeps the user's edits: title,
        // artist/album corrections, and the hand-corrected beat track.
        //
        // Let go of the old audio before repointing. If those stems were shared,
        // they are still somebody else's — deleting them unconditionally, which
        // is what this used to do, would silently empty another user's song.
        const { freeBlobs } = await release(ctx, existing);
        const oldStems = existing.stems;
        const oldCover = existing.coverKey;
        await ctx.db.patch(songId, {
          duration: fields.duration,
          source: fields.source,
          stems: fields.stems,
          stemMode: fields.stemMode,
          quality: fields.quality,
          renditionId: renditionId ?? undefined,
          ...(fields.coverKey ? { coverKey: fields.coverKey } : {}),
        });
        if (freeBlobs) {
          for (const stem of oldStems) {
            if (!fields.stems.some((s) => s.key === stem.key)) {
              try {
                await r2.deleteObject(ctx, stem.key);
              } catch {
                /* ignore */
              }
            }
          }
          if (fields.coverKey && oldCover && oldCover !== fields.coverKey) {
            try {
              await r2.deleteObject(ctx, oldCover);
            } catch {
              /* ignore */
            }
          }
        }
        return songId;
      }
    }
    return await ctx.db.insert('songs', {
      ...fields,
      renditionId: renditionId ?? undefined,
    });
  },
});
