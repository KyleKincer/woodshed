import { v } from 'convex/values';
import Stripe from 'stripe';
import { StripeSubscriptions } from '@convex-dev/stripe';
import { getAuthUserId } from '@convex-dev/auth/core';
import { action, internalAction } from './_generated/server';
import type { ActionCtx } from './_generated/server';
import { components, internal } from './_generated/api';

const client = new StripeSubscriptions(components.stripe);
const sdk = () => new Stripe(process.env.STRIPE_SECRET_KEY!);
const site = () => process.env.BILLING_SITE_URL || 'https://woodshed.kylekincer.com';
const prices = () => [process.env.STRIPE_PRICE_MONTHLY, process.env.STRIPE_PRICE_ANNUAL].filter(Boolean);
export async function reconcileCustomer(ctx: Pick<ActionCtx, 'runMutation'>, customerId: string) {
  const lease = await ctx.runMutation(internal.billingData.beginSync, {customerId});
  if (!lease) return;
  const subscriptions = await sdk().subscriptions.list({customer:customerId, status:'all', limit:100});
  // Never apply a partial result: a missed active subscription could remove access.
  if (subscriptions.has_more) throw new Error('Billing history requires review.');
  const relevant = subscriptions.data.filter(s => s.metadata.app === 'woodshed' && s.metadata.userId === lease.userId && s.items.data.some(i => prices().includes(i.price.id)));
  relevant.sort((a,b) => Number(['active','trialing'].includes(b.status))-Number(['active','trialing'].includes(a.status)) || b.created-a.created);
  const sub = relevant[0];
  const item = sub?.items.data.find(i => prices().includes(i.price.id));
  await ctx.runMutation(internal.billingData.applySync, {...lease, subscription: sub && item ? {
    id:sub.id, status:sub.status, interval:item.price.recurring?.interval === 'year' ? 'year' : 'month',
    periodEnd:Math.min(item.current_period_end,sub.cancel_at ?? item.current_period_end)*1000,
    cancelAtPeriodEnd:sub.cancel_at_period_end || sub.cancel_at !== null,
  } : null});
}
export const reconcile = internalAction({args:{customerId:v.string()}, returns:v.null(), handler:async(ctx,{customerId}) => {await reconcileCustomer(ctx,customerId);return null;}});
export const confirmGraceExpiry = internalAction({args:{userId:v.string(),deadline:v.number(),customerId:v.string()}, returns:v.null(), handler:async(ctx,args)=>{
  try { await reconcileCustomer(ctx,args.customerId); } catch {
    await ctx.scheduler.runAfter(3_600_000,internal.billing.confirmGraceExpiry,args);return null;
  }
  await ctx.runMutation(internal.billingData.startCleanup,{userId:args.userId,deadline:args.deadline});return null;
}});
export const portal = action({args:{},returns:v.string(),handler:async(ctx):Promise<string>=>{
  const userId=await getAuthUserId(ctx);if(!userId)throw new Error('Not signed in.');
  const {account}=await ctx.runQuery(internal.billingData.context,{userId});
  if(!account?.customerId)throw new Error('No billing account yet.');
  const result=await client.createCustomerPortalSession(ctx,{customerId:account.customerId,returnUrl:`${site()}/billing`});return result.url;
}});
export const checkout = action({args:{interval:v.union(v.literal('month'),v.literal('year'))},returns:v.string(),handler:async(ctx,{interval}):Promise<string>=>{
  const userId=await getAuthUserId(ctx);if(!userId)throw new Error('Not signed in.');
  const priceId=interval==='year'?process.env.STRIPE_PRICE_ANNUAL:process.env.STRIPE_PRICE_MONTHLY;
  if(process.env.STRIPE_BILLING_ENABLED!=='true'||!priceId)throw new Error('Upgrades are not available yet.');
  const lease=await ctx.runMutation(internal.billingData.beginCheckout,{userId,interval});
  if(lease.kind==='existing')return lease.url;
  const stripe=sdk();
  if(lease.kind==='portal')return (await client.createCustomerPortalSession(ctx,{customerId:lease.customerId,returnUrl:`${site()}/billing`})).url;
  try {
    const customerId=lease.customerId || (await client.createCustomer(ctx,{metadata:{app:'woodshed',userId},idempotencyKey:`woodshed:${userId}`})).customerId;
    await ctx.runMutation(internal.billingData.bindCustomer,{userId,customerId});
    if(lease.previousSessionId){
      const previous=await stripe.checkout.sessions.retrieve(lease.previousSessionId);
      if(previous.status==='complete'){
        await reconcileCustomer(ctx,customerId);
        await ctx.runMutation(internal.billingData.finishCheckout,{userId,generation:lease.generation});
        return (await client.createCustomerPortalSession(ctx,{customerId,returnUrl:`${site()}/billing`})).url;
      }
      if(previous.status==='open')await stripe.checkout.sessions.expire(previous.id);
    }
    // Recover a completed checkout even when its webhook or our previous action
    // was interrupted. Do not create a second subscription for the same account.
    await reconcileCustomer(ctx,customerId);
    const refreshed=await ctx.runQuery(internal.billingData.context,{userId});
    if(['active','trialing','past_due','unpaid','incomplete'].includes(refreshed.account?.status||'')){
      await ctx.runMutation(internal.billingData.finishCheckout,{userId,generation:lease.generation});
      return (await client.createCustomerPortalSession(ctx,{customerId,returnUrl:`${site()}/billing`})).url;
    }
    // Recover sessions created before a failed action could save their IDs.
    const openSessions=await stripe.checkout.sessions.list({customer:customerId,status:'open',limit:100});
    if(openSessions.has_more)throw new Error('Checkout history requires review.');
    for(const open of openSessions.data)if(open.metadata?.app==='woodshed'&&open.metadata.userId===userId)await stripe.checkout.sessions.expire(open.id);
    // Price amounts are checked server-side as well as during provisioning.
    const price=await stripe.prices.retrieve(priceId);
    if(!price.active||price.currency!=='usd'||price.unit_amount!==(interval==='year'?2000:200)||price.recurring?.interval!==interval)throw new Error('Billing configuration needs review.');
    const expiresAt=Math.floor(Date.now()/1000)+1800;
    const session=await client.createCheckoutSession(ctx,{customerId,priceId,mode:'subscription',successUrl:`${site()}/billing?checkout=success`,cancelUrl:`${site()}/billing`,metadata:{app:'woodshed',userId},subscriptionMetadata:{app:'woodshed',userId},params:{managed_payments:{enabled:false},expires_at:expiresAt,customer_update:{name:'auto'},custom_text:{submit:{message:'After your paid period ends, you have 14 days to export or reduce your library to the free limit. Older cloud songs above that limit are then removed. Local files are preserved.'}}}});
    if(!session.url)throw new Error('Checkout did not return a URL.');
    const saved=await ctx.runMutation(internal.billingData.finishCheckout,{userId,generation:lease.generation,sessionId:session.sessionId,url:session.url,expiresAt:expiresAt*1000,interval});
    if(!saved){await stripe.checkout.sessions.expire(session.sessionId);throw new Error('Checkout expired. Please try again.');}
    return session.url;
  } catch(error){await ctx.runMutation(internal.billingData.finishCheckout,{userId,generation:lease.generation});throw error;}
}});
