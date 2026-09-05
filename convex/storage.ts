import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import { requireUserId, accountControl } from './lib/auth';
import { requireDevice } from './devices';

export async function limits(ctx: QueryCtx | MutationCtx, userId?: string) {
  const number = (key: string, fallback: number) => {
    const n = Number(process.env[key] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${key}`);
    return n;
  };
  const policy = await ctx.db.query('appPolicy').withIndex('by_key', q => q.eq('key', 'storage')).unique();
  const control = userId ? await accountControl(ctx, userId) : null;
  return { userBytes: control?.byteLimit ?? policy?.userBytes ?? number('CLOUD_USER_BYTE_LIMIT', 250_000_000), appBytes: policy?.appBytes ?? number('CLOUD_APP_BYTE_LIMIT', 8_000_000_000) };
}
export async function used(ctx: QueryCtx | MutationCtx, scope: string) {
  return (await ctx.db.query('storageUsage').withIndex('by_scope', q => q.eq('scope', scope)).unique())?.bytes ?? 0;
}
export async function adjust(ctx: MutationCtx, userId: string, delta: number) {
  for (const scope of ['app', `user:${userId}`]) {
    const row = await ctx.db.query('storageUsage').withIndex('by_scope', q => q.eq('scope', scope)).unique();
    const bytes = Math.max(0, (row?.bytes ?? 0) + delta);
    if (row) await ctx.db.patch(row._id, { bytes });
    else await ctx.db.insert('storageUsage', { scope, bytes });
  }
}
export const usage = query({
  args: {}, returns: v.object({ usedBytes: v.number(), limitBytes: v.number(), appFull: v.boolean() }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const l = await limits(ctx, userId);
    return { usedBytes: await used(ctx, `user:${userId}`), limitBytes: l.userBytes, appFull: await used(ctx, 'app') >= l.appBytes };
  },
});
export const fileValidator = v.object({ name: v.string(), bytes: v.number(), mime: v.string(), checksum: v.string() });
export const reserve = internalMutation({
  args: { token: v.string(), jobId: v.id('jobs'), files: v.array(fileValidator) }, returns: v.any(),
  handler: async (ctx, args) => {
    const device = await requireDevice(ctx, args.token);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.deviceId !== device._id || job.userId !== device.userId || job.status !== 'running') throw new Error('Job unavailable.');
    if (args.files.length < 1 || args.files.length > 8) throw new Error('Expected 1–8 audio/art files.');
    const names = new Set<string>();
    for (const file of args.files) {
      if (!/^(drums|bass|other|vocals|guitar|piano|no_drums|no_bass|no_vocals)\.(webm|flac)$|^cover\.(jpg|png)$/.test(file.name) || names.has(file.name)) throw new Error('Invalid file name.');
      names.add(file.name);
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 250_000_000 || !/^[A-Za-z0-9+/]{43}=$/.test(file.checksum)) throw new Error('Invalid file size/checksum.');
      if (!['audio/webm', 'audio/flac', 'image/jpeg', 'image/png'].includes(file.mime)) throw new Error('Invalid file type.');
    }
    const existing = await ctx.db.query('audioObjects').withIndex('by_job', q => q.eq('jobId', args.jobId)).take(9);
    if (existing.length) {
      if (existing.some(row => row.status === 'deleting' || row.expiresAt <= Date.now() + 60_000)) throw new Error('The previous sync attempt is awaiting cloud cleanup. Wait for storage usage to drop, then Retry. Local outputs are preserved. Cleanup normally completes within one hour of the first upload attempt.');
      if (existing.length !== args.files.length || existing.some(row => row.status !== 'reserved' || !args.files.some(f => f.name === row.name && f.bytes === row.bytes && f.checksum === row.checksum && f.mime === row.mime))) throw new Error('The local files changed since this upload started. Wait for cleanup before retrying.');
      return existing;
    }
    const bytes = args.files.reduce((sum, f) => sum + f.bytes, 0);
    const l = await limits(ctx, device.userId);
    if (await used(ctx, `user:${device.userId}`) + bytes > l.userBytes) throw new Error('Your cloud library is full. Export or delete songs to make room. The processed files remain on this computer.');
    if (await used(ctx, 'app') + bytes > l.appBytes) throw new Error('Cloud storage is currently full. Playback and export remain available. Your processed files remain local.');
    await adjust(ctx, device.userId, bytes);
    const rows = [];
    for (const file of args.files) {
      const key = `users/${encodeURIComponent(device.userId)}/${args.jobId}/${crypto.randomUUID()}/${file.name}`;
      const expiresAt = Date.now() + 3_600_000;
      const id = await ctx.db.insert('audioObjects', { ...file, userId: device.userId, jobId: args.jobId, key, status: 'reserved', expiresAt });
      rows.push({ ...file, userId: device.userId, jobId: args.jobId, key, status: 'reserved' as const, expiresAt, _id: id });
      await ctx.scheduler.runAt(expiresAt, internal.storage.expire, { id });
    }
    return rows;
  },
});
export const expire = internalMutation({
  args: { id: v.id('audioObjects') }, returns: v.null(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (row?.status === 'reserved') {
      await ctx.db.patch(id, { status: 'deleting' });
      await ctx.scheduler.runAfter(0, internal.blobs.erase, { id });
    }
    return null;
  },
});
export const getObject = internalQuery({ args: { id: v.id('audioObjects') }, returns: v.any(), handler: (ctx, { id }) => ctx.db.get(id) });
export const deleted = internalMutation({
  args: { id: v.id('audioObjects') }, returns: v.null(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (row?.status === 'deleting') { await adjust(ctx, row.userId, -row.bytes); await ctx.db.delete(id); }
    return null;
  },
});
export async function retireKey(ctx: MutationCtx, key: string) {
  const row = await ctx.db.query('audioObjects').withIndex('by_key', q => q.eq('key', key)).unique();
  if (row && row.status !== 'deleting') {
    await ctx.db.patch(row._id, { status: 'deleting' });
    // Wait until every signed PUT has expired, so it cannot recreate the object.
    await ctx.scheduler.runAt(Math.max(Date.now(), row.expiresAt), internal.blobs.erase, { id: row._id });
  }
}
