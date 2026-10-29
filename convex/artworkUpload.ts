'use node';
import { v } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2 } from './r2';
import { fail } from './lib/errors';

const mismatch = 'Artwork upload did not match the selected image.';
/** S3 reports a missing object on HEAD as `NotFound` (404). */
const missing = (error: unknown) =>
  (error as { name?: string })?.name === 'NotFound' ||
  (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;

export const prepare = action({
  args: {
    id: v.id('songs'),
    bytes: v.number(),
    mime: v.string(),
    checksum: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<any> => {
    const row = await ctx.runMutation(internal.metadata.reserveArtwork, args);
    const url = await getSignedUrl(
      r2.client,
      new PutObjectCommand({
        Bucket: r2.config.bucket,
        Key: row.key,
        ContentLength: row.bytes,
        ContentType: row.mime,
        ChecksumSHA256: row.checksum,
      }),
      {
        expiresIn: 600,
        signableHeaders: new Set(['content-length', 'content-type']),
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      },
    );
    return { url, objectId: row.objectId };
  },
});
export const complete = action({
  args: { objectId: v.id('audioObjects') },
  returns: v.string(),
  /**
   * Verifies the uploaded object against its reservation. A reservation that
   * has lapsed is `artwork_expired` (from `artworkContext`/`verifiedArtwork`);
   * an object that is missing or differs from the chosen image is
   * `invalid` on the `artwork` field (§6.1).
   */
  handler: async (ctx, args): Promise<string> => {
    const row = await ctx.runQuery(internal.metadata.artworkContext, args);
    const head = await r2.client
      .send(
        new HeadObjectCommand({
          Bucket: r2.config.bucket,
          Key: row.key,
          ChecksumMode: 'ENABLED',
        }),
      )
      .catch((error: unknown) => {
        if (missing(error)) fail('invalid', mismatch, { field: 'artwork' });
        throw error;
      });
    if (
      head.ContentLength !== row.bytes ||
      head.ContentType !== row.mime ||
      head.ChecksumSHA256 !== row.checksum
    )
      fail('invalid', mismatch, { field: 'artwork' });
    return await ctx.runMutation(internal.metadata.verifiedArtwork, args);
  },
});
