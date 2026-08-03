import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';

const http = httpRouter();

/**
 * Single callback endpoint for Modal. Authenticated with a shared secret
 * rather than a user JWT — the GPU container acts on its own behalf, and the
 * job row it names already carries the owning user.
 *
 * The response body carries `{ cancel: boolean }`, which is how a cancel
 * reaches a running container: Modal checks it on every progress post and
 * aborts, so we never have to reach into Modal to kill a call.
 */
const callback = httpAction(async (ctx, request) => {
  const secret = process.env.MODAL_SHARED_SECRET;
  const auth = request.headers.get('authorization') || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  const { jobId, event } = body || {};
  if (!jobId || !event) return new Response('Missing jobId/event', { status: 400 });

  const job = await ctx.runQuery(internal.jobs.load, { jobId });
  if (!job) return new Response('Unknown job', { status: 404 });
  if (job.status === 'canceled') {
    return Response.json({ ok: true, cancel: true });
  }

  switch (event) {
    case 'progress': {
      await ctx.runMutation(internal.jobs.patch, {
        jobId,
        status: 'running',
        stage: String(body.stage || job.stage),
        percent: Number(body.percent ?? job.percent) || 0,
        message: body.message ? String(body.message).slice(0, 300) : undefined,
      });
      break;
    }

    // Early metadata (title / art / duration) so the library can render the
    // real card while the slow separation is still running.
    case 'meta': {
      await ctx.runMutation(internal.jobs.patch, {
        jobId,
        meta: {
          title: body.title ?? null,
          uploader: body.uploader ?? null,
          artist: body.artist ?? null,
          album: body.album ?? null,
          duration: body.duration ?? 0,
          coverKey: body.coverKey ?? null,
        },
      });
      break;
    }

    case 'done': {
      if (job.kind === 'beats') {
        await ctx.runMutation(internal.jobs.patch, {
          jobId,
          status: 'done',
          stage: 'finalize',
          percent: 100,
          result: { beats: body.beats || [] },
        });
        break;
      }
      const meta = job.meta || {};
      const songId = await ctx.runMutation(internal.songs.upsertFromJob, {
        userId: job.userId,
        songId: job.songId ?? undefined,
        title: String(body.title || meta.title || job.label),
        uploader: body.uploader ?? meta.uploader ?? undefined,
        artist: body.artist ?? meta.artist ?? undefined,
        album: body.album ?? meta.album ?? undefined,
        duration: Number(body.duration || meta.duration || 0),
        source: job.source,
        coverKey: body.coverKey ?? meta.coverKey ?? undefined,
        stems: body.stems || [],
        stemMode: String(body.stemMode || 'full'),
        quality: body.quality,
        addedAt: job.createdAt,
      });
      await ctx.runMutation(internal.jobs.patch, {
        jobId,
        status: 'done',
        stage: 'finalize',
        percent: 100,
        songId,
      });
      break;
    }

    case 'error': {
      await ctx.runMutation(internal.jobs.patch, {
        jobId,
        status: 'error',
        error: String(body.error || 'Processing failed.').slice(0, 4000),
      });
      break;
    }

    default:
      return new Response('Unknown event', { status: 400 });
  }

  return Response.json({ ok: true, cancel: false });
});

http.route({ path: '/modal/callback', method: 'POST', handler: callback });

export default http;
