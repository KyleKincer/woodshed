import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { query, mutation } from './_generated/server';
import { requireAdmin, getUserId, isAdminId, accountControl } from './lib/auth';
import { limits, used, retireKey } from './storage';
import type { MutationCtx } from './_generated/server';

const reasonValidator = v.string();
function reason(text: string) {
  if (text.trim().length < 3 || text.length > 500) throw new Error('Enter a reason (3–500 characters).');
  return text.trim();
}
function byteLimit(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Storage limits must be nonnegative whole bytes.');
}
async function audit(ctx: MutationCtx, actorId: string, targetId: string, action: string, why: string, before: unknown, after: unknown) {
  await ctx.db.insert('adminAudit', { actorId, targetId, action, reason: reason(why), before, after, at: Date.now() });
}
export const access = query({ args: {}, returns: v.boolean(), handler: async ctx => {
  const id = await getUserId(ctx); return !!id && await isAdminId(ctx, id);
}});
export const overview = query({ args: {}, returns: v.any(), handler: async ctx => {
  await requireAdmin(ctx);
  return { ...await limits(ctx), usedBytes: await used(ctx, 'app') };
}});
export const accounts = query({
  args: { paginationOpts: paginationOptsValidator, email: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const email = args.email?.trim();
    const result = await (email
      ? ctx.db.query('users').withIndex('by_email', q => q.eq('email', email))
      : ctx.db.query('users').withIndex('by_creation_time')).order('desc').paginate({ ...args.paginationOpts, numItems: Math.min(50, args.paginationOpts.numItems) });
    return { ...result, page: await Promise.all(result.page.map(async user => ({
      id: user._id, name: user.name, email: user.email, createdAt: user.createdAt,
      status: (await accountControl(ctx, user._id))?.status ?? 'active',
      usedBytes: await used(ctx, `user:${user._id}`), limitBytes: (await limits(ctx, user._id)).userBytes,
      admin: await isAdminId(ctx, user._id),
    }))) };
  },
});
export const account = query({
  args: { id: v.id('users') }, returns: v.any(), handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const user = await ctx.db.get(id); if (!user) throw new Error('Account not found.');
    const control = await accountControl(ctx, id);
    const devices = await ctx.db.query('devices').withIndex('by_user', q => q.eq('userId', id)).take(20);
    const jobs = await ctx.db.query('jobs').withIndex('by_user', q => q.eq('userId', id)).order('desc').take(30);
    return { id, name: user.name, email: user.email, createdAt: user.createdAt, emailVerified: user.emailVerified,
      status: control?.status ?? 'active', byteLimit: control?.byteLimit ?? null, notes: control?.notes ?? '',
      usedBytes: await used(ctx, `user:${id}`), limitBytes: (await limits(ctx, id)).userBytes, admin: await isAdminId(ctx, id),
      devices: devices.map(d => ({id: d._id, name: d.name, revoked: d.revoked})),
      jobs: jobs.map(j => ({id: j._id, label: j.label, status: j.status, stage: j.stage, error: j.error, createdAt: j.createdAt})),
    };
  },
});
export const updateAccount = mutation({
  args: { id: v.id('users'), status: v.union(v.literal('active'), v.literal('export_only'), v.literal('suspended')), byteLimit: v.union(v.number(), v.null()), notes: v.string(), reason: reasonValidator }, returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireAdmin(ctx); reason(args.reason);
    if (!await ctx.db.get(args.id)) throw new Error('Account not found.');
    if (await isAdminId(ctx, args.id) && args.status !== 'active') throw new Error('An administrator account cannot be restricted.');
    if (args.byteLimit !== null) byteLimit(args.byteLimit);
    if (args.notes.length > 4000) throw new Error('Notes are limited to 4000 characters.');
    const previous = await accountControl(ctx, args.id);
    const fields = { userId: args.id, status: args.status, byteLimit: args.byteLimit ?? undefined, notes: args.notes };
    if (previous) await ctx.db.patch(previous._id, fields); else await ctx.db.insert('accountControls', fields);
    await audit(ctx, actor, args.id, 'account.update', args.reason, previous ? {status:previous.status,byteLimit:previous.byteLimit ?? null,notes:previous.notes} : null, {status:args.status,byteLimit:args.byteLimit,notes:args.notes});
    return null;
  },
});
export const updatePolicy = mutation({
  args: { userBytes: v.number(), appBytes: v.number(), reason: reasonValidator }, returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireAdmin(ctx); reason(args.reason); byteLimit(args.userBytes); byteLimit(args.appBytes);
    const before = await limits(ctx);
    const row = await ctx.db.query('appPolicy').withIndex('by_key', q => q.eq('key', 'storage')).unique();
    const fields = {key:'storage',userBytes:args.userBytes,appBytes:args.appBytes};
    if (row) await ctx.db.patch(row._id,fields); else await ctx.db.insert('appPolicy',fields);
    await audit(ctx,actor,'app','policy.update',args.reason,before,{userBytes:args.userBytes,appBytes:args.appBytes}); return null;
  },
});
export const revokeDevice = mutation({
  args: { id: v.id('devices'), reason: reasonValidator }, returns: v.null(), handler: async (ctx,args) => {
    const actor=await requireAdmin(ctx); reason(args.reason);
    const device=await ctx.db.get(args.id); if(!device) throw new Error('Device not found.');
    await ctx.db.patch(args.id,{revoked:true});
    await audit(ctx,actor,device.userId,'device.revoke',args.reason,{id:args.id,revoked:device.revoked},{revoked:true});return null;
  },
});
export const cancelJob = mutation({
  args: { id: v.id('jobs'), reason: reasonValidator }, returns: v.null(), handler: async (ctx,args) => {
    const actor=await requireAdmin(ctx); reason(args.reason);
    const job=await ctx.db.get(args.id); if(!job || !['queued','running'].includes(job.status)) throw new Error('Job is no longer active.');
    await ctx.db.patch(args.id,{status:'canceled',updatedAt:Date.now()});
    const objects=await ctx.db.query('audioObjects').withIndex('by_job',q=>q.eq('jobId',args.id)).take(9);
    for(const object of objects) await retireKey(ctx,object.key);
    await audit(ctx,actor,job.userId,'job.cancel',args.reason,{id:args.id,status:job.status},{status:'canceled'});return null;
  },
});
export const history = query({
  args: { targetId: v.optional(v.string()), paginationOpts: paginationOptsValidator }, returns: v.any(), handler: async (ctx,args) => {
    await requireAdmin(ctx);
    return (args.targetId ? ctx.db.query('adminAudit').withIndex('by_targetId',q=>q.eq('targetId',args.targetId!)) : ctx.db.query('adminAudit').withIndex('by_creation_time')).order('desc').paginate({...args.paginationOpts,numItems:Math.min(50,args.paginationOpts.numItems)});
  },
});
