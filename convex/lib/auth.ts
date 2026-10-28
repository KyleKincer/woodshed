import type { QueryCtx, MutationCtx } from '../_generated/server';
import { getAuthUserId } from '@convex-dev/auth/core';
import { fail } from './errors';

type AnyCtx = QueryCtx | MutationCtx;

/** Convex Auth v2's JWT subject is the stable app users document ID. */
export async function requireUserId(ctx: AnyCtx): Promise<string> {
  const userId = await getUserId(ctx);
  if (!userId) fail('not_signed_in', 'Not signed in.');
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

/**
 * Suspended accounts can do nothing. Export-only accounts can read, export and
 * change personal state; `write` marks the calls that add stored media or
 * shared objects (D10), which they cannot make.
 */
export async function assertAccountAccess(ctx: AnyCtx, userId: string, write = false) {
  const control = await accountControl(ctx, userId);
  if (control?.status === 'suspended') fail('account_suspended', 'Your account is suspended. Contact the app owner for help.');
  if (write && control?.status === 'export_only') fail('account_export_only', 'Your account is in export-only mode. Playback and library export remain available.');
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
  const user = id ? await ctx.db.get('users', id) : null;
  return user?.googleAccountId === owner;
}

/** Admin pages belong to the app owner, so a non-admin caller is `not_owner`. */
export async function requireAdmin(ctx: AnyCtx) {
  const id = await requireUserId(ctx);
  if (!await isAdminId(ctx, id)) fail('not_owner', 'Administrator access required.');
  return id;
}
