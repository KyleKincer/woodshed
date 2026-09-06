'use node';
import { v, ConvexError } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2 } from './r2';
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
  handler: async (ctx, args): Promise<string> => {
    const row = await ctx.runQuery(internal.metadata.artworkContext, args);
    const head = await r2.client.send(
      new HeadObjectCommand({
        Bucket: r2.config.bucket,
        Key: row.key,
        ChecksumMode: 'ENABLED',
      }),
    );
    if (
      head.ContentLength !== row.bytes ||
      head.ContentType !== row.mime ||
      head.ChecksumSHA256 !== row.checksum
    )
      throw new ConvexError('Artwork upload did not match the selected image.');
    return await ctx.runMutation(internal.metadata.verifiedArtwork, args);
  },
});
