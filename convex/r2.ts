import { R2 } from '@convex-dev/r2';
import { v } from 'convex/values';
import { components } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import { mutation } from './_generated/server';
import { ownsKey, requireUserId, userPrefix } from './lib/auth';

// Credentials come from the Convex deployment env:
//   R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
export const r2 = new R2(components.r2);

// The stock client API, locked down so a signed-in user can only read and
// delete objects under their own `users/<clerkId>/` prefix.
export const { syncMetadata, getMetadata, onSyncMetadata } = r2.clientApi<DataModel>({
  checkUpload: async (ctx) => {
    await requireUserId(ctx);
  },
  checkReadKey: async (ctx, _bucket, key) => {
    const userId = await requireUserId(ctx);
    if (!ownsKey(userId, key)) throw new Error('Not your object.');
  },
  checkDelete: async (ctx, _bucket, key) => {
    const userId = await requireUserId(ctx);
    if (!ownsKey(userId, key)) throw new Error('Not your object.');
  },
});

/**
 * Upload URL for an original audio file the user is adding from their machine.
 *
 * The stock `generateUploadUrl` takes no arguments and picks a random key, so
 * we roll our own to force the per-user prefix — the key is the only thing
 * standing between two tenants' objects.
 */
export const generateSourceUploadUrl = mutation({
  args: { filename: v.string() },
  returns: v.object({ key: v.string(), url: v.string() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const safe = args.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
    // A random segment keeps two uploads of the same filename from colliding.
    const nonce = crypto.randomUUID();
    const key = `${userPrefix(userId)}/uploads/${nonce}/${safe}`;
    return await r2.generateUploadUrl(key);
  },
});
