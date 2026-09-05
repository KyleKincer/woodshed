import { v } from 'convex/values';
import { internalQuery } from './_generated/server';

// Split out from songs.ts so the public module stays free of unauthenticated
// entry points — everything here is reachable only from actions we control.
export const load = internalQuery({
  args: { songId: v.id('songs') },
  returns: v.any(),
  handler: async (ctx, args) => await ctx.db.get(args.songId),
});
