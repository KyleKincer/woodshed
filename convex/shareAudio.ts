'use node';
// The R2 half of sharing (architecture §6.7, package BK5): short-lived playback
// URLs for a link's visitors, and the copy behind "Add to my library".
//
// Errors with a meaning the client can act on are coded (`fail`, §6.1). The two
// transient copy failures stay plain `ConvexError` messages, so the client's
// error copy reads them as "something went wrong" with Try again.
import {v, ConvexError} from 'convex/values';
import {HeadObjectCommand, CopyObjectCommand} from '@aws-sdk/client-s3';
import {action} from './_generated/server';
import {internal, api} from './_generated/api';
import {r2} from './r2';
import {fail} from './lib/errors';
import type {Id} from './_generated/dataModel';

export const playback = action({
  args: {token: v.string()},
  handler: async (ctx, {token}): Promise<Record<string, string>> => {
    const files = await ctx.runQuery(internal.sharing.mediaContext, {token});
    // Short-lived URLs never grant arbitrary storage access. Revocation stops
    // later URL issuance; audio already downloaded cannot be recalled.
    return Object.fromEntries(await Promise.all(files.map(async f => [f.id, await r2.getUrl(f.key, {expiresIn: 300})])));
  },
});

export const save = action({
  args: {token: v.string()},
  handler: async (ctx, {token}): Promise<Id<'songs'>> => {
    const {keys} = await ctx.runQuery(internal.sharing.importContext, {token});
    const saved = await ctx.runQuery(api.sharing.saved, {token});
    if (saved?.songId) return saved.songId;
    if (saved?.status === 'copying') fail('invalid', 'This song is already being added. Please wait.');
    const heads = await Promise.all(keys.map(async sourceKey => {
      const head = await r2.client.send(new HeadObjectCommand({Bucket: r2.config.bucket, Key: sourceKey}), {abortSignal: AbortSignal.timeout(30000)});
      return {sourceKey, bytes: head.ContentLength || 0, mime: head.ContentType || 'application/octet-stream', etag: head.ETag || ''};
    })).catch(() => { throw new ConvexError('The shared audio could not be loaded. Please try again.'); });
    const reservation = await ctx.runMutation(internal.sharing.beginImport, {token, heads});
    if (!reservation.files) return reservation.songId;
    const {id, attempt, files} = reservation;
    try {
      // Wait for every copy before cleanup, including siblings of a failed one.
      const copies = await Promise.allSettled(files.map(async f => {
        const copied = await r2.client.send(new CopyObjectCommand({Bucket: r2.config.bucket, Key: f.key,
          CopySource: `${r2.config.bucket}/${f.sourceKey.split('/').map(encodeURIComponent).join('/')}`,
          CopySourceIfMatch: f.etag, MetadataDirective: 'REPLACE', ContentType: f.mime, Metadata: {},
        }), {abortSignal: AbortSignal.timeout(120000)});
        const head = await r2.client.send(new HeadObjectCommand({Bucket: r2.config.bucket, Key: f.key}), {abortSignal: AbortSignal.timeout(30000)});
        if (head.ContentLength !== f.bytes || head.ETag !== copied.CopyObjectResult?.ETag) throw Error('Copy verification failed');
      }));
      if (copies.some(c => c.status === 'rejected')) throw new ConvexError('Couldn’t copy all of the audio. Please try again shortly.');
      return await ctx.runMutation(internal.sharing.finishImport, {id, attempt});
    } catch (error) {
      await ctx.runMutation(internal.sharing.failImport, {id, attempt});
      throw error;
    }
  },
});
