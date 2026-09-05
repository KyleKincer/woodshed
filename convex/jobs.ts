import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { getUserId, requireWritableUserId } from './lib/auth';
import { withDefaults } from './lib/presets';

import { sourceValidator } from './schema';

// Jobs the library view cares about. Terminal jobs stay around briefly so the
// UI can show a failure inline; `dismiss` clears them.
const LIVE = ['queued', 'running', 'error'] as const;

export const listActive = query({
  args: {},
  returns: v.any(),
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
  returns: v.any(),
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
    deviceId: v.id('devices'),
    settings: v.any(),
    label: v.string(),
    replaceSongId: v.optional(v.id('songs')),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);

    let source = args.source;
    if (args.replaceSongId) {
      const song = await ctx.db.get(args.replaceSongId);
      if (!song || song.userId !== userId) throw new Error('Not your song.');
      source = source ?? song.source ?? undefined;
    }
    if (!source) {
      throw new Error('This song can’t be split again — its original audio is gone.');
    }

    const device = await ctx.db.get(args.deviceId);
    if (!device || device.revoked || device.userId !== userId) throw new Error('Connect this computer’s companion in Settings first.');
    const active = await ctx.db.query('jobs').withIndex('by_device_status', q => q.eq('deviceId', args.deviceId).eq('status', 'queued')).take(20);
    if (active.length >= 20) throw new Error('Process the queued songs before adding more.');
    if (args.label.length > 500 || source.value.length > 2000) throw new Error('Source is too long.');
    const settings = withDefaults(args.settings);
    const now = Date.now();

    const jobId = await ctx.db.insert('jobs', {
      userId,
      kind: 'separate',
      deviceId: args.deviceId,
      songId: args.replaceSongId,
      label: args.label,
      source,
      settings,
      status: 'queued',
      stage: 'queued',
      percent: 0,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });

    return { jobId, songId: null };
  },
});

export const createBeatDetection = mutation({
  args: { songId: v.id('songs'), deviceId: v.id('devices') },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);
    const song = await ctx.db.get(args.songId);
    if (!song || song.userId !== userId) throw new Error('Not your song.');
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.revoked || device.userId !== userId) throw new Error('Connect the local companion first.');
    const now = Date.now();
    const jobId = await ctx.db.insert('jobs', {
      userId,
      deviceId: args.deviceId,
      kind: 'beats',
      songId: args.songId,
      label: `Detecting beats — ${song.title}`,
      status: 'queued',
      stage: 'queued',
      percent: 0,
      createdAt: now,
      updatedAt: now,
    });

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
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);
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
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.userId !== userId) return false;
    if (job.status === 'queued' || job.status === 'running') throw new Error('Cancel the job first.');
    await ctx.db.delete(args.jobId);
    return true;
  },
});

export const retry = mutation({
  args: { jobId: v.id('jobs'), deviceId: v.id('devices') }, returns: v.null(),
  handler: async (ctx, {jobId, deviceId}) => {
    const userId=await requireWritableUserId(ctx);
    const job=await ctx.db.get(jobId), device=await ctx.db.get(deviceId);
    if(!job || job.userId!==userId || job.deviceId!==deviceId || !device || device.revoked || device.userId!==userId) throw new Error('Retry from the original processing computer.');
    if(job.status!=='error') throw new Error('Only failed jobs can be retried.');
    await ctx.db.patch(jobId,{status:'queued',error:undefined,message:'Resuming local files…',updatedAt:Date.now()});return null;
  },
});
