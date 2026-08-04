// Sharing separated audio between songs.
//
// Plain helpers rather than internal functions: every caller is already inside a
// mutation, so these run in that transaction directly. The refCount bump and the
// song insert being one atomic step is the point — split across transactions,
// a failure between them either leaks blobs forever or frees them out from under
// a live song.

import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { qualityKey, sourceKey, urlKey } from './lib/dedupe';
import type { Quality } from './lib/presets';
import { r2 } from './r2';

type Source = Doc<'songs'>['source'];

/**
 * Find an existing separation of this source at these settings.
 *
 * Checks the request-time key first, then the resolved one, because a Spotify
 * link and a bare search can land on the same upload and the second of them
 * should hit.
 */
export async function findMatch(
  ctx: QueryCtx,
  source: Source,
  quality: Quality,
  stemMode: string
): Promise<Doc<'renditions'> | null> {
  const key = sourceKey(source);
  if (!key) return null;
  const qKey = qualityKey(quality, stemMode);

  const bySource = await ctx.db
    .query('renditions')
    .withIndex('by_source_quality', (q) => q.eq('sourceKey', key).eq('qualityKey', qKey))
    .first();
  if (bySource) return bySource;

  return await ctx.db
    .query('renditions')
    .withIndex('by_resolved_quality', (q) => q.eq('resolvedKey', key).eq('qualityKey', qKey))
    .first();
}

/** Claim a rendition for a new song row. Returns the new song's id. */
export async function claimInto(
  ctx: MutationCtx,
  rendition: Doc<'renditions'>,
  userId: string,
  source: Source,
  addedAt: number
): Promise<Id<'songs'>> {
  await ctx.db.patch(rendition._id, { refCount: rendition.refCount + 1 });
  return await ctx.db.insert('songs', {
    userId,
    title: rendition.title,
    uploader: rendition.uploader,
    artist: rendition.artist,
    album: rendition.album,
    duration: rendition.duration,
    // Kept so the user can still reprocess at different settings, which is a
    // real download rather than a share.
    source,
    coverKey: rendition.coverKey,
    stems: rendition.stems,
    stemMode: rendition.stemMode,
    quality: rendition.quality,
    renditionId: rendition._id,
    addedAt,
  });
}

/**
 * Record a freshly-completed separation so the next request for it is free.
 *
 * If a matching row already exists — two users asked for the same track at the
 * same time and both jobs ran — this still inserts its own. Merging after the
 * fact would mean repointing a song that may be playing, to save storage that is
 * already paid for.
 */
export async function register(
  ctx: MutationCtx,
  fields: {
    source: Source;
    resolvedUrl?: string;
    quality: Doc<'renditions'>['quality'];
    stemMode: string;
    stems: Doc<'renditions'>['stems'];
    coverKey?: string;
    title: string;
    uploader?: string;
    artist?: string;
    album?: string;
    duration: number;
  }
): Promise<Id<'renditions'> | null> {
  const key = sourceKey(fields.source);
  if (!key) return null; // uploads are never shared
  return await ctx.db.insert('renditions', {
    sourceKey: key,
    resolvedKey: fields.resolvedUrl ? urlKey(fields.resolvedUrl) : undefined,
    qualityKey: qualityKey(fields.quality as Quality, fields.stemMode),
    stems: fields.stems,
    coverKey: fields.coverKey,
    title: fields.title,
    uploader: fields.uploader,
    artist: fields.artist,
    album: fields.album,
    duration: fields.duration,
    stemMode: fields.stemMode,
    quality: fields.quality,
    refCount: 1,
    createdAt: Date.now(),
  });
}

/**
 * Drop one reference to a song's audio, freeing the R2 objects only when the
 * last reference goes.
 *
 * Returns whether the caller still has to delete blobs itself, so a song that
 * owns its audio outright — an upload, or a row written before dedupe existed —
 * keeps the original behaviour.
 */
export async function release(
  ctx: MutationCtx,
  song: Doc<'songs'>
): Promise<{ freeBlobs: boolean }> {
  if (!song.renditionId) return { freeBlobs: true };
  const rendition = await ctx.db.get(song.renditionId);
  if (!rendition) return { freeBlobs: true };

  const remaining = rendition.refCount - 1;
  if (remaining > 0) {
    await ctx.db.patch(song.renditionId, { refCount: remaining });
    return { freeBlobs: false };
  }

  for (const stem of rendition.stems) {
    try {
      await r2.deleteObject(ctx, stem.key);
    } catch {
      /* orphaned object; cheaper than an undeletable song */
    }
  }
  if (rendition.coverKey) {
    try {
      await r2.deleteObject(ctx, rendition.coverKey);
    } catch {
      /* ignore */
    }
  }
  await ctx.db.delete(song.renditionId);
  return { freeBlobs: false };
}
