'use node';
import { v } from 'convex/values';
import { PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { action, internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { r2 } from './r2';
import { fileValidator } from './storage';
import { resultValidator } from './worker';

export const prepare = action({
  args: { token: v.string(), jobId: v.id('jobs'), files: v.array(fileValidator) }, returns: v.any(),
  handler: async (ctx, args): Promise<unknown> => {
    const rows = await ctx.runMutation(internal.storage.reserve, args);
    return await Promise.all(rows.map(async (row: { key: string; bytes: number; mime: string; checksum: string; name: string; expiresAt: number }) => ({
      ...row,
      url: await getSignedUrl(r2.client, new PutObjectCommand({ Bucket: r2.config.bucket, Key: row.key, ContentLength: row.bytes, ContentType: row.mime, ChecksumSHA256: row.checksum }), { expiresIn: Math.max(1, Math.min(600, Math.floor((row.expiresAt - Date.now()) / 1000) - 30)), signableHeaders: new Set(['content-length', 'content-type']), unhoistableHeaders: new Set(['x-amz-checksum-sha256']) }),
    })));
  },
});
export const complete = action({
  args: { token: v.string(), jobId: v.id('jobs'), result: resultValidator }, returns: v.id('songs'),
  handler: async (ctx, args): Promise<any> => {
    const { job, files } = await ctx.runQuery(internal.worker.uploadContext, { token: args.token, jobId: args.jobId });
    if (job.status === 'done' && job.songId) return job.songId;
    for (const row of files) {
      const head = await r2.client.send(new HeadObjectCommand({ Bucket: r2.config.bucket, Key: row.key, ChecksumMode: 'ENABLED' }));
      if (head.ContentLength !== row.bytes || head.ContentType !== row.mime || head.ChecksumSHA256 !== row.checksum) throw new Error('Uploaded file did not match its reservation.');
    }
    return await ctx.runMutation(internal.worker.finish, args);
  },
});
export const erase = internalAction({
  args: { id: v.id('audioObjects'), attempt: v.optional(v.number()) }, returns: v.null(),
  handler: async (ctx, { id, attempt = 0 }) => {
    const row = await ctx.runQuery(internal.storage.getObject, { id });
    if (!row || row.status !== 'deleting') return null;
    try {
      await r2.client.send(new DeleteObjectCommand({ Bucket: r2.config.bucket, Key: row.key }));
    } catch {
      await ctx.scheduler.runAfter(Math.min(86_400_000, 30_000 * 2 ** Math.min(attempt, 12)), internal.blobs.erase, { id, attempt: attempt + 1 });
      return null;
    }
    await ctx.runMutation(internal.storage.deleted, { id });
    return null;
  },
});
