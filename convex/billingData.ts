import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from './_generated/server';
import { internal } from './_generated/api';
import { getAuthUserId } from '@convex-dev/auth/core';
import { assertAccountAccess } from './lib/auth';
import { billingAccount, allocateCapacity, proBytes, EXPORT_GRACE_MS, MONTHLY_CENTS, ANNUAL_CENTS } from './lib/billingPolicy';
import { limits, used } from './storage';
import { deleteSongData } from './songs';
import type { MutationCtx } from './_generated/server';
const interval = v.union(v.literal('month'), v.literal('year'));
async function ensureAccount(ctx: MutationCtx, userId: string) {
  const existing = await billingAccount(ctx, userId);
  if (existing) return existing;
  const id = ctx.db.normalizeId('users', userId);
  if (!id || !await ctx.db.get(id)) throw new Error('Account not found.');
  const accountId = await ctx.db.insert('billingAccounts', {userId, access:'free', allocatedBytes:0, syncGeneration:0, checkoutGeneration:0});
  return (await ctx.db.get(accountId))!;
}
export const status = query({
  args: {}, returns: v.any(),
  handler: async ctx => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error('Not signed in.');
    const account = await billingAccount(ctx, userId);
    const policy = await limits(ctx, userId);
    return {
      enabled: process.env.STRIPE_BILLING_ENABLED === 'true' && !!process.env.STRIPE_PRICE_MONTHLY && !!process.env.STRIPE_PRICE_ANNUAL,
      access: account?.access ?? 'free', status: account?.status ?? null,
      interval: account?.interval ?? null, periodEnd: account?.periodEnd ?? null,
      cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false, graceEndsAt: account?.graceEndsAt ?? null,
      hasCustomer: !!account?.customerId, cleanupPending: account?.cleanupPending ?? false,
      usedBytes: await used(ctx, `user:${userId}`), limitBytes: policy.userBytes,
      freeBytes: (await limits(ctx)).userBytes, proBytes: proBytes(), monthlyCents: MONTHLY_CENTS, annualCents: ANNUAL_CENTS,
    };
  },
});
export const context = internalQuery({
  args: {userId:v.string()}, returns:v.any(), handler: async (ctx,{userId}) => {
    const id=ctx.db.normalizeId('users',userId), user=id?await ctx.db.get(id):null;
    if(!user)throw new Error('Account not found.');
    return {user,account:await billingAccount(ctx,userId)};
  },
});
export const beginCheckout = internalMutation({
  args:{userId:v.string(),interval}, returns:v.any(), handler:async(ctx,args)=>{
    await assertAccountAccess(ctx,args.userId,true);
    const row=await ensureAccount(ctx,args.userId), now=Date.now();
    if(row.customerId && ['active','trialing','past_due','unpaid','incomplete'].includes(row.status||''))return {kind:'portal' as const,customerId:row.customerId};
    if((row.checkoutBusyUntil||0)>now)throw new Error('Checkout is already opening. Try again in a moment.');
    if(!row.subscriptionId && row.checkoutUrl && row.checkoutInterval===args.interval && (row.checkoutExpiresAt||0)>now+60_000)return {kind:'existing' as const,url:row.checkoutUrl};
    const generation=row.checkoutGeneration+1;
    await ctx.db.patch(row._id,{checkoutGeneration:generation,checkoutBusyUntil:now+600_000,checkoutUrl:undefined,checkoutExpiresAt:undefined});
    return {kind:'create' as const,generation,customerId:row.customerId,previousSessionId:row.subscriptionId ? undefined : row.checkoutSessionId};
  },
});
export const bindCustomer = internalMutation({
  args:{userId:v.string(),customerId:v.string()}, returns:v.null(), handler:async(ctx,args)=>{
    const row=await ensureAccount(ctx,args.userId);
    if(row.customerId && row.customerId!==args.customerId)throw new Error('Billing customer mismatch.');
    await ctx.db.patch(row._id,{customerId:args.customerId});return null;
  },
});
export const finishCheckout = internalMutation({
  args:{userId:v.string(),generation:v.number(),sessionId:v.optional(v.string()),url:v.optional(v.string()),expiresAt:v.optional(v.number()),interval:v.optional(interval)}, returns:v.boolean(),
  handler:async(ctx,args)=>{
    const row=await billingAccount(ctx,args.userId);
    if(!row||row.checkoutGeneration!==args.generation)return false;
    await ctx.db.patch(row._id,{checkoutBusyUntil:undefined,checkoutSessionId:args.sessionId,checkoutUrl:args.url,checkoutExpiresAt:args.expiresAt,checkoutInterval:args.interval});return true;
  },
});
export const beginSync = internalMutation({
  args:{customerId:v.string()}, returns:v.any(), handler:async(ctx,{customerId})=>{
    const row=await ctx.db.query('billingAccounts').withIndex('by_customerId',q=>q.eq('customerId',customerId)).unique();
    if(!row)return null;
    const generation=row.syncGeneration+1;await ctx.db.patch(row._id,{syncGeneration:generation});
    return {userId:row.userId,generation};
  },
});
export const applySync = internalMutation({
  args:{userId:v.string(),generation:v.number(),subscription:v.union(v.null(),v.object({id:v.string(),status:v.string(),interval,periodEnd:v.number(),cancelAtPeriodEnd:v.boolean()}))}, returns:v.null(),
  handler:async(ctx,{userId,generation,subscription})=>{
    const row=await billingAccount(ctx,userId);
    if(!row||row.syncGeneration!==generation)return null;
    const paid=subscription && ['active','trialing'].includes(subscription.status);
    const access=paid?'paid':row.access==='paid'||row.access==='grace'?'grace':'free';
    const graceEndsAt=access==='grace'?(row.graceEndsAt??Date.now()+EXPORT_GRACE_MS):undefined;
    const allocation=access==='paid'?proBytes():access==='grace'?row.allocatedBytes:0;
    await allocateCapacity(ctx,allocation-row.allocatedBytes);
    await ctx.db.patch(row._id,{access,allocatedBytes:allocation,subscriptionId:subscription?.id,status:subscription?.status,interval:subscription?.interval,periodEnd:subscription?.periodEnd,cancelAtPeriodEnd:subscription?.cancelAtPeriodEnd,graceEndsAt,cleanupPending:paid?false:row.cleanupPending});
    if(graceEndsAt && graceEndsAt !== row.graceEndsAt)await ctx.scheduler.runAt(Math.max(Date.now(),graceEndsAt),internal.billingData.expireGrace,{userId,deadline:graceEndsAt});
    if(paid && subscription.periodEnd>Date.now())await ctx.scheduler.runAt(subscription.periodEnd+60_000,internal.billing.reconcile,{customerId:row.customerId!});
    return null;
  },
});
export const expireGrace = internalMutation({
  args:{userId:v.string(),deadline:v.number()}, returns:v.null(), handler:async(ctx,{userId,deadline})=>{
    const row=await billingAccount(ctx,userId);
    if(!row||row.access!=='grace'||row.graceEndsAt!==deadline||Date.now()<deadline)return null;
    // Refresh Stripe before removing access, even if its webhook was delayed.
    await ctx.scheduler.runAfter(0,internal.billing.confirmGraceExpiry,{userId,deadline,customerId:row.customerId!});
    return null;
  },
});
export const startCleanup = internalMutation({
  args:{userId:v.string(),deadline:v.number()}, returns:v.null(), handler:async(ctx,{userId,deadline})=>{
    const row=await billingAccount(ctx,userId);
    if(!row||row.access!=='grace'||row.graceEndsAt!==deadline||Date.now()<deadline)return null;
    await allocateCapacity(ctx,-row.allocatedBytes);
    await ctx.db.patch(row._id,{access:'free',allocatedBytes:0,cleanupPending:true});
    await ctx.scheduler.runAfter(0,internal.billingData.cleanup,{userId});return null;
  },
});
export const cleanup = internalMutation({
  args:{userId:v.string()}, returns:v.null(), handler:async(ctx,{userId})=>{
    const row=await billingAccount(ctx,userId);
    if(!row?.cleanupPending||row.access!=='free')return null;
    const policy=await limits(ctx,userId);
    if(await used(ctx,`user:${userId}`)<=policy.userBytes){await ctx.db.patch(row._id,{cleanupPending:false});return null;}
    // Wait for actual R2 deletion and quota release before selecting another
    // song, so a slow delete cannot cause us to discard too many songs.
    const deleting=await ctx.db.query('audioObjects').withIndex('by_userId_status',q=>q.eq('userId',userId).eq('status','deleting')).first();
    if(deleting){await ctx.scheduler.runAfter(60_000,internal.billingData.cleanup,{userId});return null;}
    const song=await ctx.db.query('songs').withIndex('by_user_added',q=>q.eq('userId',userId)).order('asc').first();
    if(!song){await ctx.db.patch(row._id,{cleanupPending:false});return null;}
    await deleteSongData(ctx,song);
    await ctx.scheduler.runAfter(10_000,internal.billingData.cleanup,{userId});return null;
  },
});
