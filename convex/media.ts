import { v } from 'convex/values';
import { action, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { requireUserId } from './lib/auth';
import { requireDevice } from './devices';
import { r2 } from './r2';

export const authorizedKeys = internalQuery({
  args: { keys: v.array(v.string()), token: v.optional(v.string()) }, returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const userId = args.token ? (await requireDevice(ctx, args.token)).userId : await requireUserId(ctx);
    if (args.keys.length > 100) throw new Error('Request at most 100 files.');
    const allowed: string[] = [];
    for (const key of args.keys) {
      const o = await ctx.db.query('audioObjects').withIndex('by_key', q => q.eq('key', key)).unique();
      if (o?.userId === userId && o.status === 'ready') allowed.push(key);
    }
    // Existing libraries may predate the object ledger, including shared renditions.
    const missing = args.keys.filter(k => !allowed.includes(k));
    if (missing.length) {
      const songs = await ctx.db.query('songs').withIndex('by_user', q => q.eq('userId', userId)).take(1000);
      const owned = new Set(songs.flatMap(s => [...s.stems.map(t => t.key), ...(s.coverKey ? [s.coverKey] : []), ...(s.artwork?.kind === 'upload' ? [s.artwork.key] : [])]));
      for (const key of missing) if (owned.has(key)) allowed.push(key);
    }
    return allowed;
  },
});
export const signKeys = action({
  args: { keys: v.array(v.string()), token: v.optional(v.string()), expiresIn: v.optional(v.number()) }, returns: v.record(v.string(), v.string()),
  handler: async (ctx, args): Promise<Record<string, string>> => {
    const keys = await ctx.runQuery(internal.media.authorizedKeys, { keys: args.keys, token: args.token });
    const ttl = Math.max(60, Math.min(21600, args.expiresIn ?? 21600));
    const entries = await Promise.all(keys.map(async (key: string) => [key, await r2.getUrl(key, {expiresIn: ttl})]));
    return Object.fromEntries(entries);
  },
});
