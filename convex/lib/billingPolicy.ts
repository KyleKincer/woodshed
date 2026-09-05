import type { QueryCtx, MutationCtx } from '../_generated/server';
export const EXPORT_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
export const MONTHLY_CENTS = 200;
export const ANNUAL_CENTS = 2000;
export function proBytes() {
  const value = Number(process.env.PRO_STORAGE_BYTES || 5_000_000_000);
  if (!Number.isSafeInteger(value) || value < 250_000_000) throw new Error('Invalid PRO_STORAGE_BYTES');
  return value;
}
export const billingAccount = (ctx: QueryCtx | MutationCtx, userId: string) =>
  ctx.db.query('billingAccounts').withIndex('by_userId', q => q.eq('userId', userId)).unique();
export async function paidCapacity(ctx: QueryCtx | MutationCtx) {
  return (await ctx.db.query('billingCapacity').withIndex('by_key', q => q.eq('key', 'paid')).unique())?.bytes ?? 0;
}
export async function allocateCapacity(ctx: MutationCtx, delta: number) {
  if (!delta) return;
  const row = await ctx.db.query('billingCapacity').withIndex('by_key', q => q.eq('key', 'paid')).unique();
  const bytes = Math.max(0, (row?.bytes ?? 0) + delta);
  if (row) await ctx.db.patch(row._id, {bytes});
  else await ctx.db.insert('billingCapacity', {key:'paid', bytes});
}
