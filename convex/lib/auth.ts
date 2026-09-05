import type { QueryCtx, MutationCtx } from '../_generated/server';
import { getAuthUserId } from '@convex-dev/auth/core';

type AnyCtx = QueryCtx | MutationCtx;

/** Convex Auth v2's JWT subject is the stable app users document ID. */
export async function requireUserId(ctx: AnyCtx): Promise<string> {
  const userId = await getUserId(ctx);
  if (!userId) throw new Error('Not signed in.');
  return userId;
}

export async function getUserId(ctx: AnyCtx): Promise<string | null> {
  const id = await getAuthUserId(ctx);
  if (id) await assertAccountAccess(ctx, id);
  return id;
}

export function userPrefix(userId: string): string {
  return `users/${userId}`;
}

export function ownsKey(userId: string, key: string): boolean {
  return key.startsWith(`${userPrefix(userId)}/`);
}

export async function accountControl(ctx: AnyCtx, userId: string) {
  return ctx.db.query('accountControls').withIndex('by_userId', q => q.eq('userId', userId)).unique();
}
export async function assertAccountAccess(ctx: AnyCtx, userId: string, write = false) {
  const control = await accountControl(ctx, userId);
  if (control?.status === 'suspended') throw new Error('Your account is suspended. Contact the app owner for help.');
  if (write && control?.status === 'export_only') throw new Error('Your account is in export-only mode. Playback and library export remain available.');
}
export async function requireWritableUserId(ctx: AnyCtx) {
  const id = await requireUserId(ctx);
  await assertAccountAccess(ctx, id, true);
  return id;
}
export async function isAdminId(ctx: AnyCtx, userId: string) {
  if ( (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(userId)) return true;
  const owner = process.env.OWNER_GOOGLE_ACCOUNT_ID;
  if (!owner) return false;
  const id = ctx.db.normalizeId('users', userId);
  const user = id ? await ctx.db.get(id) : null;
  return user?.googleAccountId === owner;
}
export async function requireAdmin(ctx: AnyCtx) {
  const id = await requireUserId(ctx);
  if (!await isAdminId(ctx, id)) throw new Error('Administrator access required.');
  return id;
}
