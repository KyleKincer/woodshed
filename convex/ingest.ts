import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction } from './_generated/server';
import { resolveQuality } from './lib/presets';
import { userPrefix } from './lib/auth';
import { r2 } from './r2';

// Modal fetches and writes R2 objects directly with its own credentials, but
// reads of *existing* objects go through presigned URLs so the GPU container
// never needs read access beyond what a job requires.
const SOURCE_URL_TTL = 60 * 60 * 2;

function modalConfig() {
  const secret = process.env.MODAL_SHARED_SECRET;
  const site = process.env.CONVEX_SITE_URL;
  if (!secret) throw new Error('MODAL_SHARED_SECRET is not set on this deployment.');
  if (!site) throw new Error('CONVEX_SITE_URL is unavailable.');
  return { secret, site };
}

async function postToModal(url: string, secret: string, payload: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 500);
    throw new Error(`Modal rejected the job (${res.status}). ${detail}`);
  }
  return res;
}

export const dispatchSeparate = internalAction({
  args: { jobId: v.id('jobs') },
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.jobs.load, { jobId: args.jobId });
    if (!job || job.status === 'canceled') return;

    try {
      const endpoint = process.env.MODAL_SEPARATE_URL;
      if (!endpoint) throw new Error('MODAL_SEPARATE_URL is not set on this deployment.');
      const { secret, site } = modalConfig();
      const settings = job.settings || {};
      const quality = resolveQuality(settings);

      // An uploaded original already sits in R2; hand Modal a read URL for it
      // rather than round-tripping the bytes through Convex.
      let sourceUrl: string | null = null;
      if (job.source?.type === 'upload') {
        sourceUrl = await r2.getUrl(job.source.value, { expiresIn: SOURCE_URL_TTL });
      }

      await postToModal(endpoint, secret, {
        jobId: args.jobId,
        userId: job.userId,
        source: job.source,
        sourceUrl,
        quality,
        stemMode: settings.stemMode || 'full',
        // Stems are keyed by job, not song: a reprocess must not overwrite the
        // stems the user is currently listening to until the new set lands.
        keyPrefix: `${userPrefix(job.userId)}/songs/${args.jobId}`,
        callbackUrl: `${site}/modal/callback`,
      });

      await ctx.runMutation(internal.jobs.patch, {
        jobId: args.jobId,
        status: 'running',
        stage: 'download',
        percent: 0,
        message: 'Starting…',
      });
    } catch (err: any) {
      await ctx.runMutation(internal.jobs.patch, {
        jobId: args.jobId,
        status: 'error',
        error: String(err?.message || err),
      });
    }
  },
});

export const dispatchBeats = internalAction({
  args: { jobId: v.id('jobs') },
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.jobs.load, { jobId: args.jobId });
    if (!job || job.status === 'canceled' || !job.songId) return;

    try {
      const endpoint = process.env.MODAL_BEATS_URL;
      if (!endpoint) throw new Error('MODAL_BEATS_URL is not set on this deployment.');
      const { secret, site } = modalConfig();
      const song = await ctx.runQuery(internal.songsInternal.load, { songId: job.songId });
      if (!song) throw new Error('Song not found.');

      const stemUrls = await Promise.all(
        song.stems.map((s: any) => r2.getUrl(s.key, { expiresIn: SOURCE_URL_TTL }))
      );

      await postToModal(endpoint, secret, {
        jobId: args.jobId,
        stemUrls,
        callbackUrl: `${site}/modal/callback`,
      });

      await ctx.runMutation(internal.jobs.patch, {
        jobId: args.jobId,
        status: 'running',
        stage: 'detect',
        percent: 0,
        message: 'Preparing the beat detector…',
      });
    } catch (err: any) {
      await ctx.runMutation(internal.jobs.patch, {
        jobId: args.jobId,
        status: 'error',
        error: String(err?.message || err),
      });
    }
  },
});
