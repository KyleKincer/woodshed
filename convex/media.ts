import { v } from 'convex/values';
import { action } from './_generated/server';
import { ownsKey, requireUserId } from './lib/auth';
import { r2 } from './r2';

// Signing lives in an action rather than a query on purpose. A query would
// re-sign on every reactive tick, handing the browser a new URL for unchanged
// bytes and defeating HTTP caching; it also keeps presigning off the hot path
// of the library subscription.
const DEFAULT_EXPIRY_SECONDS = 60 * 60 * 6;

/**
 * Turn R2 object keys into signed GET URLs. Batched because opening a song
 * needs 4–6 stems at once and rendering the library needs every cover.
 */
export const signKeys = action({
  args: {
    keys: v.array(v.string()),
    expiresIn: v.optional(v.number()),
  },
  returns: v.record(v.string(), v.string()),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const expiresIn = args.expiresIn ?? DEFAULT_EXPIRY_SECONDS;
    const out: Record<string, string> = {};
    await Promise.all(
      args.keys.map(async (key) => {
        if (!ownsKey(userId, key)) return; // silently skipped, not fatal
        out[key] = await r2.getUrl(key, { expiresIn });
      })
    );
    return out;
  },
});
