import { v } from 'convex/values';
import { query, mutation, internalMutation, internalQuery } from './_generated/server';
import { requireDevice } from './devices';
import { resolveQuality } from './lib/presets';
import { retireKey } from './storage';
import { qualityValidator, stemValidator } from './schema';

export const next = query({
  args: { token: v.string() }, returns: v.any(),
  handler: async (ctx, { token }) => {
    const d = await requireDevice(ctx, token);
    // A restarted companion resumes its own unfinished job from local files.
    const running = await ctx.db.query('jobs').withIndex('by_device_status', q => q.eq('deviceId', d._id).eq('status', 'running')).first();
    return running ?? await ctx.db.query('jobs').withIndex('by_device_status', q => q.eq('deviceId', d._id).eq('status', 'queued')).first();
  },
});
export const claim = mutation({
  args: { token: v.string(), jobId: v.id('jobs') }, returns: v.any(),
  handler: async (ctx, { token, jobId }) => {
    const d = await requireDevice(ctx, token);
    const job = await ctx.db.get(jobId);
    if (!job || job.userId !== d.userId || job.deviceId !== d._id || !['running', 'queued'].includes(job.status)) throw new Error('Job unavailable.');
    await ctx.db.patch(jobId, { status: 'running', updatedAt: Date.now() });
    const song = job.songId ? await ctx.db.get(job.songId) : null;
    return { ...job, quality: resolveQuality(job.settings), song: song?.userId === d.userId ? song : null };
  },
});
export const progress = mutation({
  args: { token: v.string(), jobId: v.id('jobs'), stage: v.string(), percent: v.number(), message: v.optional(v.string()), error: v.optional(v.string()) }, returns: v.boolean(),
  handler: async (ctx, a) => {
    const d = await requireDevice(ctx, a.token);
    const j = await ctx.db.get(a.jobId);
    if (!j || j.deviceId !== d._id || j.userId !== d.userId || !['queued', 'running'].includes(j.status)) return false;
    await ctx.db.patch(j._id, { status: a.error ? 'error' : 'running', stage: a.stage.slice(0, 30), percent: Math.max(0, Math.min(100, a.percent)), message: a.message?.slice(0, 300), error: a.error?.slice(0, 2000), updatedAt: Date.now() });
    return true;
  },
});
export const uploadContext = internalQuery({
  args: { token: v.string(), jobId: v.id('jobs') }, returns: v.any(),
  handler: async (ctx, a) => {
    const d = await requireDevice(ctx, a.token);
    const job = await ctx.db.get(a.jobId);
    if (!job || job.deviceId !== d._id || job.userId !== d.userId) throw new Error('Not your job.');
    return { job, files: await ctx.db.query('audioObjects').withIndex('by_job', q => q.eq('jobId', a.jobId)).take(9) };
  },
});
export const resultValidator = v.object({
  title: v.string(), uploader: v.optional(v.string()), artist: v.optional(v.string()), album: v.optional(v.string()),
  duration: v.number(), stems: v.array(stemValidator), coverKey: v.optional(v.string()),
  stemMode: v.string(), quality: qualityValidator,
});
export const finish = internalMutation({
  args: { token: v.string(), jobId: v.id('jobs'), result: resultValidator }, returns: v.id('songs'),
  handler: async (ctx, a) => {
    const d = await requireDevice(ctx, a.token);
    const job = await ctx.db.get(a.jobId);
    if (!job || job.deviceId !== d._id || job.userId !== d.userId) throw new Error('Not your job.');
    if (job.status === 'done' && job.songId) return job.songId;
    if (job.status !== 'running') throw new Error('Job no longer running.');
    const objects = await ctx.db.query('audioObjects').withIndex('by_job', q => q.eq('jobId', job._id)).take(9);
    const keys = [...a.result.stems.map(s => s.key), ...(a.result.coverKey ? [a.result.coverKey] : [])];
    if (keys.length !== objects.length || new Set(keys).size !== keys.length || a.result.stems.length < 1 || objects.some(o => o.status !== 'reserved' || o.expiresAt <= Date.now() || !keys.includes(o.key))) throw new Error('Invalid upload manifest.');
    if (!Number.isFinite(a.result.duration) || a.result.duration <= 0 || a.result.title.length > 500) throw new Error('Invalid song metadata.');
    const stems = a.result.stems.map(s => {
      const o = objects.find(o => o.key === s.key)!;
      if (o.name.replace(/\.[^.]+$/, '') !== s.name || !o.mime.startsWith('audio/')) throw new Error('Invalid stem.');
      return { name: s.name, key: o.key, bytes: o.bytes, mime: o.mime };
    });
    if (job.kind === 'import' && job.importMeta?.id) {
      const existing = await ctx.db.query('songs').withIndex('by_user_import', q => q.eq('userId', d.userId).eq('localImportId', job.importMeta.id)).unique();
      if (existing) {
        for (const o of objects) await retireKey(ctx, o.key);
        await ctx.db.patch(job._id, {status:'done',songId:existing._id,percent:100,updatedAt:Date.now()});
        return existing._id;
      }
    }
    let songId = job.songId;
    const fields = { ...a.result, stems, source: job.source, userId: d.userId, addedAt: job.createdAt };
    if (songId) {
      const old = await ctx.db.get(songId);
      if (!old || old.userId !== d.userId) throw new Error('Song was deleted during processing.');
      for (const key of [...old.stems.map(s => s.key), ...(old.coverKey ? [old.coverKey] : [])]) await retireKey(ctx, key);
      await ctx.db.patch(songId, { ...fields, title: old.title, addedAt: old.addedAt, renditionId: undefined });
    } else {
      songId = await ctx.db.insert('songs', { ...fields, ...(job.importMeta ? { tempo: job.importMeta.tempo, practice: job.importMeta.practice, localImportId: job.importMeta.id } : {}) });
    }
    for (const o of objects) await ctx.db.patch(o._id, { status: 'ready' });
    await ctx.db.patch(job._id, { status: 'done', songId, percent: 100, stage: 'done', updatedAt: Date.now() });
    return songId;
  },
});
export const beatsDone = mutation({
  args: { token: v.string(), jobId: v.id('jobs'), beats: v.array(v.array(v.number())) }, returns: v.null(),
  handler: async (ctx, a) => {
    const d = await requireDevice(ctx, a.token);
    const j = await ctx.db.get(a.jobId);
    if (!j || j.deviceId !== d._id || j.userId !== d.userId || j.kind !== 'beats' || j.status !== 'running') throw new Error('Job unavailable.');
    if (a.beats.length > 8000 || a.beats.some(b => b.length !== 2 || b.some(n => !Number.isFinite(n)))) throw new Error('Invalid beat map.');
    await ctx.db.patch(j._id, { status: 'done', result: { beats: a.beats }, percent: 100, updatedAt: Date.now() });
    return null;
  },
});
export const importSong = mutation({
  args: { token: v.string(), legacyId: v.string(), title: v.string(), tempo: v.optional(v.any()), practice: v.optional(v.any()) }, returns: v.any(),
  handler: async (ctx, a) => {
    const d = await requireDevice(ctx, a.token);
    if (a.legacyId.length > 200 || a.title.length > 500) throw new Error('Invalid import.');
    const existing = await ctx.db.query('songs').withIndex('by_user_import', q => q.eq('userId', d.userId).eq('localImportId', a.legacyId)).unique();
    if (existing) return { songId: existing._id, jobId: null };
    const queued = await ctx.db.query('jobs').withIndex('by_device_status', q => q.eq('deviceId', d._id).eq('status', 'queued')).take(20);
    const running = await ctx.db.query('jobs').withIndex('by_device_status', q => q.eq('deviceId', d._id).eq('status', 'running')).take(20);
    const same = [...queued, ...running].find(j => j.importMeta?.id === a.legacyId);
    if (same) return { jobId: same._id, songId: null };
    if (queued.length >= 20) throw new Error('Import queue full. Import more after these finish.');
    const now = Date.now();
    const jobId = await ctx.db.insert('jobs', { userId: d.userId, deviceId: d._id, kind: 'import', label: a.title, importMeta: { id: a.legacyId, tempo: a.tempo ?? null, practice: a.practice ?? null }, status: 'queued', stage: 'queued', percent: 0, createdAt: now, updatedAt: now });
    return { jobId, songId: null };
  },
});
