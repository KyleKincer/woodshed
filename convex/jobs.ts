import { v, type Infer, type Validator } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { getUserId, requireUserId, requireWritableUserId } from './lib/auth';
import { fail } from './lib/errors';
import { PRESETS, STEM_MODES, resolveQuality, withDefaults } from './lib/presets';
import { jobKindValidator, jobMetaValidator, jobStatusValidator, type JobMeta } from './lib/validators';
import { hasRealMap } from '../shared/song-map';
import { sourceValidator } from './schema';

/**
 * Jobs, as the browser sees them (architecture §6.4).
 *
 * - `listActive`: the Jobs popover and the Library's "Adding" row read every
 *   live (`queued`, `running`) and failed (`error`) job. Each status is read on
 *   its own, so done jobs can never push live ones out of the window.
 * - `createSeparation`: a new song (or a re-split) on one of the caller's
 *   computers (B5), with the early card metadata and the "the user chose this
 *   recording" flag (B4, D43).
 * - `createBeatDetection` / `createSectionDetection`: one live detection per
 *   song; the device is the one the web chose, else the caller's most recently
 *   seen computer (the desktop app's own).
 * - `retry`, `cancel`, `dismiss`: the job card's actions (§2.10).
 * - `markApplied` / `latestDetection`: the one-applier rule for detections on
 *   mapped songs (D44).
 *
 * Every user-reachable failure is a coded error (§6.1).
 */

/** Rows read per status by `listActive`. */
export const LIST_PER_STATUS = 50;
/** Queued jobs one computer may hold (B5). */
export const QUEUE_CAP = 20;
/** Card metadata text fields (B4). */
export const META_TEXT_MAX = 300;
/** `meta.thumbnail` URL length. */
export const THUMBNAIL_MAX = 2000;
/** A job label (the typed query, URL or filename). */
export const LABEL_MAX = 500;
/** `source.value` (a URL, a search, an upload id). */
export const SOURCE_MAX = 2000;
/** An upload's original filename. */
export const FILENAME_MAX = 500;
/** Longest believable `meta.duration`, in seconds (a 24-hour stream). */
export const META_DURATION_MAX = 86_400;
/** The message every re-queue shows (`worker.autoRetry` shows the same). */
export const RESUME_MESSAGE = 'Resuming local files…';
/** Quality presets `createSeparation` and `retry` accept. */
export const PRESET_IDS: readonly string[] = [...Object.keys(PRESETS), 'custom'];
/** Stem modes `createSeparation` accepts; `six` is accepted whether or not `lib/presets.ts` lists it yet (§6.5). */
export const STEM_MODE_IDS: readonly string[] = [...new Set([...Object.keys(STEM_MODES), 'six'])];

/** A song's newest jobs scanned for a live detection to reuse. */
const SONG_SCAN = 50;
/** A song's newest jobs scanned by `latestDetection` (§6.4). */
const LATEST_SCAN = 5;
/** Paired computers scanned for the default detection device. */
const DEVICE_SCAN = 20;

const NO_COMPANION = 'Connect this computer’s companion in Settings first.';
const ADMIN_REVOKED = 'This computer was disconnected by an administrator.';
const NO_SOURCE = 'This song can’t be split again — its original audio is gone.';

type Job = Doc<'jobs'>;
type Song = Doc<'songs'>;
type Device = Doc<'devices'>;
type Ctx = QueryCtx | MutationCtx;

// ---- rows -------------------------------------------------------------------

const orNull = <T extends Validator<unknown, 'required', string>>(validator: T) => v.union(validator, v.null());

/** A job as `listActive` returns it: 1.9's fields plus what the Jobs popover needs (§6.4). */
export const jobRowValidator = v.object({
  jobId: v.id('jobs'),
  kind: jobKindValidator,
  songId: orNull(v.id('songs')),
  label: v.string(),
  status: jobStatusValidator,
  stage: v.string(),
  percent: v.number(),
  message: orNull(v.string()),
  error: orNull(v.string()),
  // 1.9 rows carry other shapes (`artist`, `uploader`, `coverKey`, …), so the stored meta stays loose; null when absent.
  meta: v.any(),
  deviceId: orNull(v.id('devices')),
  createdAt: v.number(),
  startedAt: orNull(v.number()),
  updatedAt: v.number(),
  attempts: v.number(),
  errorCode: orNull(v.string()),
  retryAt: orNull(v.number()),
  chainedFrom: orNull(v.id('jobs')),
  confirmed: v.boolean(),
  source: orNull(v.object({ type: sourceValidator.fields.type, value: v.string(), filename: orNull(v.string()) })),
  settingsSummary: orNull(v.object({ preset: v.string(), stemMode: v.string(), model: v.string() })),
});
export type JobRow = Infer<typeof jobRowValidator>;

/** `get` and `latestDetection`: the row plus the detection result and when a session applied it. */
export const jobDetailValidator = jobRowValidator.extend({
  result: v.any(),
  appliedAt: orNull(v.number()),
});
export type JobDetail = Infer<typeof jobDetailValidator>;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Preset, stem mode and the model `worker.claim` will run, for a separation; null for detections and imports. */
function settingsSummary(job: Job): JobRow['settingsSummary'] {
  if (job.kind !== 'separate' || !isObject(job.settings)) return null;
  const settings = withDefaults(job.settings);
  // The preset (or custom) resolved, as the worker resolves it, never a stale stored `model`.
  return { preset: String(settings.preset), stemMode: String(settings.stemMode), model: resolveQuality(settings).model };
}

export function toRow(job: Job): JobRow {
  return {
    jobId: job._id,
    kind: job.kind,
    songId: job.songId ?? null,
    label: job.label,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    message: job.message ?? null,
    error: job.error ?? null,
    meta: job.meta ?? null,
    deviceId: job.deviceId ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    updatedAt: job.updatedAt,
    attempts: job.attempts ?? 0,
    errorCode: job.errorCode ?? null,
    retryAt: job.retryAt ?? null,
    chainedFrom: job.chainedFrom ?? null,
    confirmed: job.confirmed === true,
    source: job.source ? { type: job.source.type, value: job.source.value, filename: job.source.filename ?? null } : null,
    settingsSummary: settingsSummary(job),
  };
}

/** A detection's result is returned only once the detection is done. */
export function toDetail(job: Job): JobDetail {
  const detection = job.kind === 'beats' || job.kind === 'sections';
  return {
    ...toRow(job),
    result: detection && job.status === 'done' ? job.result ?? null : null,
    appliedAt: job.appliedAt ?? null,
  };
}

// ---- helpers ----------------------------------------------------------------

/** The caller's song, or a coded refusal. */
async function ownSong(ctx: Ctx, userId: string, songId: Id<'songs'>): Promise<Song> {
  const song = await ctx.db.get('songs', songId);
  if (!song) fail('not_found', 'Song not found.');
  if (song.userId !== userId) fail('not_owner', 'Not your song.');
  return song;
}

/** The caller's job, or a coded refusal (another account's job reads as missing). */
async function ownJob(ctx: Ctx, userId: string, jobId: Id<'jobs'>): Promise<Job> {
  const job = await ctx.db.get('jobs', jobId);
  if (!job || job.userId !== userId) fail('not_found', 'Job not found.');
  return job;
}

const deviceName = (device: Device | null) => device?.displayName?.trim() || device?.name?.trim() || 'the computer that added it';

/** An owned, paired computer (B5). Another account's computer reads as unpaired. */
async function pairedDevice(ctx: Ctx, userId: string, deviceId: Id<'devices'>): Promise<Device> {
  const device = await ctx.db.get('devices', deviceId);
  if (!device || device.userId !== userId) fail('device_unpaired', NO_COMPANION);
  if (device.revoked) {
    if (device.revokedBy === 'admin') fail('device_revoked_admin', ADMIN_REVOKED);
    fail('device_unpaired', NO_COMPANION);
  }
  return device;
}

/**
 * The computer a detection runs on: the one the web chose, else the caller's
 * most recently seen paired computer, an online one first. The desktop app's
 * companion heartbeats while it runs, so on the desktop that is its own
 * computer. With no presence recorded at all, a single paired computer is used.
 */
async function detectionDevice(ctx: MutationCtx, userId: string, deviceId: Id<'devices'> | undefined): Promise<Device> {
  if (deviceId) return pairedDevice(ctx, userId, deviceId);
  const devices = (await ctx.db.query('devices').withIndex('by_user', q => q.eq('userId', userId)).take(DEVICE_SCAN)).filter(d => !d.revoked);
  if (devices.length === 0) fail('device_unpaired', 'Connect the local companion first.');
  let best: { device: Device; online: boolean; seen: number } | null = null;
  for (const device of devices) {
    for (const presence of await ctx.db.query('devicePresence').withIndex('by_deviceId', q => q.eq('deviceId', device._id)).take(5)) {
      const next = { device, online: presence.state !== 'offline', seen: presence.lastSeenAt };
      if (!best || (next.online && !best.online) || (next.online === best.online && next.seen > best.seen)) best = next;
    }
  }
  if (best) return best.device;
  if (devices.length === 1) return devices[0];
  fail('device_unpaired', 'Choose which computer should do this.');
}

/** A queued or running detection of this kind for the song, if one exists. */
async function liveDetection(ctx: MutationCtx, userId: string, songId: Id<'songs'>, kind: 'beats' | 'sections') {
  const rows = await ctx.db.query('jobs').withIndex('by_song', q => q.eq('songId', songId)).order('desc').take(SONG_SCAN);
  return rows.find(j => j.userId === userId && j.kind === kind && (j.status === 'queued' || j.status === 'running')) ?? null;
}

async function accountSettings(ctx: MutationCtx, userId: string) {
  const row = await ctx.db.query('userSettings').withIndex('by_user', q => q.eq('userId', userId)).unique();
  return withDefaults(row?.settings);
}

/** The separation settings a job keeps (known keys only; `six` kept as is, the worker normalises it at claim). */
function pickSettings(s: Record<string, unknown>) {
  const custom = isObject(s.custom) ? s.custom : {};
  const out: Record<string, unknown> = {
    preset: s.preset,
    stemMode: s.stemMode,
    bitrate: s.bitrate,
    custom: { model: String(custom.model ?? ''), shifts: Number(custom.shifts), overlap: Number(custom.overlap) },
  };
  if (s.format !== undefined) out.format = s.format;
  return out;
}

/** What the Add sheet sent, over the defaults, validated. */
function separationSettings(raw: unknown) {
  if (raw !== undefined && raw !== null && !isObject(raw)) fail('invalid', 'These processing settings could not be read.', { field: 'settings' });
  const s = withDefaults(raw);
  if (!PRESET_IDS.includes(String(s.preset))) fail('invalid', 'Choose a quality preset.', { field: 'settings.preset' });
  if (!STEM_MODE_IDS.includes(String(s.stemMode))) fail('invalid', 'Choose which stems to make.', { field: 'settings.stemMode' });
  return pickSettings(s);
}

/** Early card metadata (B4): strings ≤ 300, an https thumbnail ≤ 2000, a finite duration. Blank fields are dropped. */
export function cleanMeta(meta: JobMeta | undefined): JobMeta | undefined {
  if (!meta) return undefined;
  const out: JobMeta = {};
  for (const key of ['title', 'channel', 'provider'] as const) {
    const value = meta[key]?.trim();
    if (!value) continue;
    if (value.length > META_TEXT_MAX) fail('invalid', `The ${key} is too long (${META_TEXT_MAX} characters max).`, { field: `meta.${key}` });
    out[key] = value;
  }
  const thumbnail = meta.thumbnail?.trim();
  if (thumbnail) {
    let url: URL | null = null;
    try { url = new URL(thumbnail); } catch { url = null; }
    if (thumbnail.length > THUMBNAIL_MAX || url?.protocol !== 'https:') fail('invalid', 'The thumbnail must be an https link.', { field: 'meta.thumbnail' });
    out.thumbnail = thumbnail;
  }
  if (meta.duration !== undefined) {
    if (!Number.isFinite(meta.duration) || meta.duration < 0 || meta.duration > META_DURATION_MAX) fail('invalid', 'The duration is not valid.', { field: 'meta.duration' });
    out.duration = meta.duration;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---- queries ------------------------------------------------------------------

export const listActive = query({
  args: {},
  returns: v.array(jobRowValidator),
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    if (!userId) return [];
    const read = (status: 'queued' | 'running' | 'error', order: 'asc' | 'desc') => ctx.db
      .query('jobs')
      .withIndex('by_user_status', q => q.eq('userId', userId).eq('status', status))
      .order(order)
      .take(LIST_PER_STATUS);
    // The head of the queue (oldest first, the order computers claim in) and the newest failures.
    const [queued, running, failed] = await Promise.all([read('queued', 'asc'), read('running', 'asc'), read('error', 'desc')]);
    return [...queued, ...running, ...failed]
      .sort((a, b) => a.createdAt - b.createdAt || a._creationTime - b._creationTime)
      .map(toRow);
  },
});

/** One job (a detection flow waits on one result). Detection results come only with a done job. */
export const get = query({
  args: { jobId: v.id('jobs') },
  returns: v.union(jobDetailValidator, v.null()),
  handler: async (ctx, args) => {
    const userId = await getUserId(ctx);
    const job = await ctx.db.get('jobs', args.jobId);
    if (!job || !userId || job.userId !== userId) return null;
    return toDetail(job);
  },
});

/**
 * The newest user-started beat detection of the song, when it is done, has a
 * result and no session has applied it (D44: "Bars found while you were
 * away"). An older unapplied detection is never offered over a newer one.
 */
export const latestDetection = query({
  args: { songId: v.id('songs') },
  returns: v.union(jobDetailValidator, v.null()),
  handler: async (ctx, args) => {
    const userId = await getUserId(ctx);
    if (!userId) return null;
    const song = await ctx.db.get('songs', args.songId);
    if (!song || song.userId !== userId) return null;
    const rows = await ctx.db.query('jobs').withIndex('by_song', q => q.eq('songId', args.songId)).order('desc').take(LATEST_SCAN);
    const latest = rows.find(j => j.userId === userId && j.kind === 'beats' && j.status === 'done' && !j.chainedFrom);
    if (!latest || latest.result == null || latest.appliedAt !== undefined) return null;
    return toDetail(latest);
  },
});

// ---- mutations ----------------------------------------------------------------

export const createSeparation = mutation({
  args: {
    // Omitted for a re-split, which inherits the song's original source.
    source: v.optional(sourceValidator),
    // The computer that processes it (B5). For an upload it is the one holding the file (`songs.originDeviceId`).
    deviceId: v.id('devices'),
    settings: v.any(),
    label: v.string(),
    replaceSongId: v.optional(v.id('songs')),
    meta: v.optional(jobMetaValidator),
    // D43: the user chose this recording (a B4 candidate or a pasted URL).
    confirmed: v.optional(v.boolean()),
  },
  returns: v.object({ jobId: v.id('jobs') }),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);

    const song = args.replaceSongId ? await ownSong(ctx, userId, args.replaceSongId) : null;
    const source = args.source ?? song?.source;
    if (!source) fail('resplit_no_source', NO_SOURCE);
    if (args.label.length > LABEL_MAX) fail('invalid', `The label is too long (${LABEL_MAX} characters max).`, { field: 'label' });
    if (!source.value.trim() || source.value.length > SOURCE_MAX) fail('invalid', 'Source is too long.', { field: 'source' });
    if (source.filename !== undefined && source.filename.length > FILENAME_MAX) fail('invalid', `The file name is too long (${FILENAME_MAX} characters max).`, { field: 'source.filename' });

    const device = await pairedDevice(ctx, userId, args.deviceId);
    // D38: an uploaded song's original file lives only on the computer that added it.
    const reusesUpload = !!song && source.type === 'upload' && song.source?.type === 'upload' && song.source.value === source.value;
    if (reusesUpload && song.originDeviceId && song.originDeviceId !== device._id) {
      const name = deviceName(await ctx.db.get('devices', song.originDeviceId));
      fail('resplit_wrong_device', `Re-split this song on ${name}, which has the original file.`, { deviceName: name });
    }

    const queued = await ctx.db.query('jobs').withIndex('by_device_status', q => q.eq('deviceId', device._id).eq('status', 'queued')).take(QUEUE_CAP);
    if (queued.length >= QUEUE_CAP) fail('queue_full', 'Process the queued songs before adding more.');

    const settings = separationSettings(args.settings);
    const meta = cleanMeta(args.meta);
    const now = Date.now();
    const jobId = await ctx.db.insert('jobs', {
      userId,
      kind: 'separate',
      deviceId: device._id,
      songId: song?._id,
      label: args.label,
      source,
      settings,
      status: 'queued',
      stage: 'queued',
      percent: 0,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      ...(meta ? { meta } : {}),
      ...(args.confirmed !== undefined ? { confirmed: args.confirmed } : {}),
    });
    return { jobId };
  },
});

export const createBeatDetection = mutation({
  args: {
    songId: v.id('songs'),
    // B5: the web passes an online paired computer; the desktop omits it and its own computer is used.
    deviceId: v.optional(v.id('devices')),
  },
  returns: v.object({ jobId: v.id('jobs') }),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);
    const song = await ownSong(ctx, userId, args.songId);
    const live = await liveDetection(ctx, userId, song._id, 'beats');
    if (live) return { jobId: live._id };
    const device = await detectionDevice(ctx, userId, args.deviceId);
    // B7: the companion also suggests sections unless the account turned that off.
    const sections = (await accountSettings(ctx, userId)).autoSections !== false;
    const now = Date.now();
    const jobId = await ctx.db.insert('jobs', {
      userId,
      deviceId: device._id,
      kind: 'beats',
      songId: song._id,
      label: `Finding bars — ${song.title}`,
      settings: { sections },
      status: 'queued',
      stage: 'queued',
      percent: 0,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { jobId };
  },
});

/** B7 (D47): section suggestions for a song that already has a real map. */
export const createSectionDetection = mutation({
  args: { songId: v.id('songs'), deviceId: v.optional(v.id('devices')) },
  returns: v.object({ jobId: v.id('jobs') }),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);
    const song = await ownSong(ctx, userId, args.songId);
    if (!hasRealMap(song.tempo, { hasPart: song.hasChart === true })) fail('invalid', 'Find the bars before suggesting sections.');
    const live = await liveDetection(ctx, userId, song._id, 'sections');
    if (live) return { jobId: live._id };
    const device = await detectionDevice(ctx, userId, args.deviceId);
    const now = Date.now();
    const jobId = await ctx.db.insert('jobs', {
      userId,
      deviceId: device._id,
      kind: 'sections',
      songId: song._id,
      label: `Finding sections — ${song.title}`,
      status: 'queued',
      stage: 'queued',
      percent: 0,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { jobId };
  },
});

/**
 * Cancel a live or failed job. The companion sees it on its next progress call
 * and stops. Returns false when there is nothing to cancel (finished, or gone),
 * so an Undo racing completion is harmless.
 */
export const cancel = mutation({
  args: { jobId: v.id('jobs') },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await ctx.db.get('jobs', args.jobId);
    if (!job || job.userId !== userId) return false;
    if (job.status === 'done' || job.status === 'canceled') return false;
    await ctx.db.patch('jobs', job._id, { status: 'canceled', retryAt: undefined, updatedAt: Date.now() });
    return true;
  },
});

/** Clear a failed (or finished) job's card without retrying it. */
export const dismiss = mutation({
  args: { jobId: v.id('jobs') },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await ctx.db.get('jobs', args.jobId);
    if (!job || job.userId !== userId) return false;
    if (job.status === 'queued' || job.status === 'running') fail('job_live', 'Cancel the job first.');
    await ctx.db.delete('jobs', job._id);
    return true;
  },
});

/**
 * Re-queue a failed job on the computer that ran it (`Try again`, `Try now`).
 * With `preset` (`Try Fast quality`) the separation settings are re-resolved
 * for that preset first. A `deviceId` (the desktop passing its own computer)
 * must be the job's.
 */
export const retry = mutation({
  args: { jobId: v.id('jobs'), preset: v.optional(v.string()), deviceId: v.optional(v.id('devices')) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);
    const job = await ownJob(ctx, userId, args.jobId);
    if (job.status !== 'error') fail('job_not_failed', 'Only failed jobs can be retried.');
    const device = job.deviceId ? await ctx.db.get('devices', job.deviceId) : null;
    const owned = !!device && device.userId === userId;
    if (!owned || device.revoked || (args.deviceId !== undefined && args.deviceId !== job.deviceId)) {
      fail('retry_wrong_device', 'Retry from the original processing computer.', owned ? { deviceName: deviceName(device) } : {});
    }

    const patch: Partial<Job> = {
      status: 'queued', stage: 'queued', percent: 0,
      error: undefined, errorCode: undefined, retryAt: undefined,
      message: RESUME_MESSAGE, updatedAt: Date.now(),
    };
    if (args.preset !== undefined) {
      if (job.kind !== 'separate') fail('invalid', 'Only song processing has a quality preset.', { field: 'preset' });
      if (!PRESET_IDS.includes(args.preset)) fail('invalid', 'Choose a quality preset.', { field: 'preset' });
      // Stored 1.9 settings may carry modes and keys 2.0 never writes; they are re-resolved, not rejected.
      const settings = { ...withDefaults(job.settings), preset: args.preset };
      const quality = resolveQuality(settings);
      patch.settings = { ...pickSettings(settings), model: quality.model, shifts: quality.shifts, overlap: quality.overlap };
    }
    await ctx.db.patch('jobs', job._id, patch);
    return null;
  },
});

/** D44: the open session applied this detection's beats (or declined them), so it is never offered again. */
export const markApplied = mutation({
  args: { jobId: v.id('jobs') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await ownJob(ctx, userId, args.jobId);
    if (job.kind !== 'beats' || job.status !== 'done') fail('invalid', 'Only a finished bar detection can be applied.');
    if (job.appliedAt === undefined) await ctx.db.patch('jobs', job._id, { appliedAt: Date.now() });
    return null;
  },
});
