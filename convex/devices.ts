import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { requireUserId, requireWritableUserId, assertAccountAccess } from './lib/auth';

export async function hashToken(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid companion credential.');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export async function requireDevice(ctx: QueryCtx | MutationCtx, token: string) {
  const hash = await hashToken(token);
  const device = await ctx.db.query('devices').withIndex('by_token', q => q.eq('tokenHash', hash)).unique();
  if (!device || device.revoked) throw new Error('Companion is not paired. Connect it in Settings.');
  await assertAccountAccess(ctx, device.userId, true);
  return device;
}
export const pair = mutation({
  args: { tokenHash: v.string(), name: v.string() }, returns: v.id('devices'),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);
    if (!/^[a-f0-9]{64}$/.test(args.tokenHash)) throw new Error('Invalid pairing code.');
    const existing = await ctx.db.query('devices').withIndex('by_token', q => q.eq('tokenHash', args.tokenHash)).unique();
    if (existing) {
      if (existing.userId !== userId) throw new Error('This companion belongs to another account. Reset its pairing locally first.');
      await ctx.db.patch(existing._id, { revoked: false });
      return existing._id;
    }
    const devices = await ctx.db.query('devices').withIndex('by_user', q => q.eq('userId', userId)).take(20);
    if (devices.length >= 20) throw new Error('Device limit reached.');
    return await ctx.db.insert('devices', { userId, tokenHash: args.tokenHash, name: args.name.slice(0, 80), revoked: false });
  },
});
export const identity = query({
  args: { token: v.string() }, returns: v.object({ userId: v.string(), deviceId: v.id('devices') }),
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    return { userId: device.userId, deviceId: device._id };
  },
});
export const revoke = mutation({
  args: { deviceId: v.id('devices') }, returns: v.null(),
  handler: async (ctx, { deviceId }) => {
    const userId = await requireUserId(ctx);
    const device = await ctx.db.get(deviceId);
    if (!device || device.userId !== userId) throw new Error('Not your device.');
    await ctx.db.patch(deviceId, { revoked: true });
    return null;
  },
});
