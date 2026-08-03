import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import { getUserId, requireUserId } from './lib/auth';
import { withDefaults } from './lib/presets';
import { sourceValidator } from './schema';

// Jobs the library view cares about. Terminal jobs stay around briefly so the
// UI can show a failure inline; `dismiss` clears them.
const LIVE = ['queued', 'running', 'error'] as const;

export const listActive = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query('jobs')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .order('desc')
      .take(50);
    return rows
      .filter((j) => (LIVE as readonly string[]).includes(j.status))
      .map((j) => ({
        jobId: j._id,
        kind: j.kind,
        songId: j.songId ?? null,
        label: j.label,
        status: j.status,
        stage: j.stage,
        percent: j.percent,
        message: j.message ?? null,
        error: j.error ?? null,
        meta: j.meta ?? null,
      }));
  },
});

/** A single job, for the beat-detection modal which waits on one result. */
export const get = query({
  args: { jobId: v.id('jobs') },
  handler: async (ctx, args) => {
    const userId = await getUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || !userId || job.userId !== userId) return null;
    return {
      jobId: job._id,
      status: job.status,
      stage: job.stage,
      percent: job.percent,
      message: job.message ?? null,
      error: job.error ?? null,
      result: job.result ?? null,
    };
  },
});

export const createSeparation = mutation({
  args: {
    // Omitted for a reprocess, which inherits the song's original source.
    source: v.optional(sourceValidator),
    settings: v.any(),
    label: v.string(),
    replaceSongId: v.optional(v.id('songs')),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    let source = args.source;
    if (args.replaceSongId) {
      const song = await ctx.db.get(args.replaceSongId);
      if (!song || song.userId !== userId) throw new Error('Not your song.');
      source = source ?? song.source ?? undefined;
    }
    if (!source) {
      throw new Error('This song can’t be split again — its original audio is gone.');
    }

    const now = Date.now();
    const jobId = await ctx.db.insert('jobs', {
      userId,
      kind: 'separate',
      songId: args.replaceSongId,
      label: args.label,
      source,
      settings: withDefaults(args.settings),
      status: 'queued',
      stage: 'queued',
      percent: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.ingest.dispatchSeparate, { jobId });
    return { jobId };
  },
});

export const createBeatDetection = mutation({
  args: { songId: v.id('songs') },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const song = await ctx.db.get(args.songId);
    if (!song || song.userId !== userId) throw new Error('Not your song.');
    const now = Date.now();
    const jobId = await ctx.db.insert('jobs', {
      userId,
      kind: 'beats',
      songId: args.songId,
      label: `Detecting beats — ${song.title}`,
      status: 'queued',
      stage: 'queued',
      percent: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.ingest.dispatchBeats, { jobId });
    return { jobId };
  },
});

/**
 * Mark a job canceled. Modal notices on its next progress callback (the
 * response carries a `cancel` flag) and aborts, so there is no need to reach
 * into the GPU container from here.
 */
export const cancel = mutation({
  args: { jobId: v.id('jobs') },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.userId !== userId) return false;
    if (job.status === 'done' || job.status === 'canceled') return false;
    await ctx.db.patch(args.jobId, { status: 'canceled', updatedAt: Date.now() });
    return true;
  },
});

/** Clear a failed job's card without retrying it. */
export const dismiss = mutation({
  args: { jobId: v.id('jobs') },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.userId !== userId) return false;
    await ctx.db.delete(args.jobId);
    return true;
  },
});

// ---- internal: driven by ingest actions and Modal HTTP callbacks ----------

export const load = internalQuery({
  args: { jobId: v.id('jobs') },
  handler: async (ctx, args) => await ctx.db.get(args.jobId),
});

export const patch = internalMutation({
  args: {
    jobId: v.id('jobs'),
    status: v.optional(v.string()),
    stage: v.optional(v.string()),
    percent: v.optional(v.number()),
    message: v.optional(v.string()),
    error: v.optional(v.string()),
    meta: v.optional(v.any()),
    result: v.optional(v.any()),
    songId: v.optional(v.id('songs')),
  },
  handler: async (ctx, args) => {
    const { jobId, ...rest } = args;
    const job = await ctx.db.get(jobId);
    if (!job) return null;
    // A cancel racing a progress update must win; otherwise the job would
    // resurrect itself into `running` and the card would never clear.
    if (job.status === 'canceled' && rest.status !== 'canceled') {
      return job.status;
    }
    const patchDoc: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [k, val] of Object.entries(rest)) {
      if (val !== undefined) patchDoc[k] = val;
    }
    await ctx.db.patch(jobId, patchDoc);
    return job.status;
  },
});
