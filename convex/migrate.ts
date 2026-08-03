import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { qualityValidator, sourceValidator, stemValidator } from './schema';

/**
 * Import one song from the old desktop library.
 *
 * Internal on purpose: it takes an arbitrary `userId` so the migration script
 * can write on your behalf, which must never be reachable from a browser.
 * Invoked by `scripts/migrate-local.mjs` via `npx convex run`.
 */
export const importSong = internalMutation({
  args: {
    userId: v.string(),
    // The old library.json id, so re-running the script updates rather than
    // duplicating. Not a Convex id.
    legacyId: v.string(),
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
    addedAt: v.number(),
    tempo: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const { legacyId, ...fields } = args;
    // Idempotent on (userId, addedAt): the old ids embedded their timestamp,
    // so this is stable across re-runs of a partially-completed migration.
    const existing = await ctx.db
      .query('songs')
      .withIndex('by_user_added', (q) =>
        q.eq('userId', args.userId).eq('addedAt', args.addedAt)
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return { id: existing._id, updated: true };
    }
    const id = await ctx.db.insert('songs', fields);
    return { id, updated: false };
  },
});
