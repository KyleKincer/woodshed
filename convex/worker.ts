import { internal } from './_generated/api';
import { fingerprintValidator, metadataFields, cleanMetadata } from './lib/songMetadata';
import { v } from 'convex/values';
import { query, mutation, internalMutation, internalQuery } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { hashToken, requireDevice } from './devices';
import { assertAccountAccess } from './lib/auth';
import { resolveQuality, withDefaults } from './lib/presets';
import { retireKey } from './storage';
import { qualityValidator, stemValidator } from './schema';
import { codeOf, fail, isJobErrorCode } from './lib/errors';
import { jobMetaValidator, presenceStateValidator, suggestedSectionValidator, SECTION_SUGGESTIONS_MAX } from './lib/validators';
import { barsOf, fromBeats, hasRealMap, mapSummaryOf, sectionsOf, songMapFromTempo, validateSongMap } from '../shared/song-map';
import { PRACTICE_CAP, prunePractice, summarize, upgradePractice } from '../shared/practice';
import { mapSummaryFor, summaryMapOf } from './migrations';

/**
 * The companion's side of a job (architecture §6.6). Every function here
 * authenticates with a device token (`requireDevice`), so a companion only
 * ever sees and changes its own account's jobs on its own device.
 *
 * - `next` / `claim`: what to run next (a running job first, then beats, then
 *   sections, then the oldest queued job; B6, D12), with `six` normalised.
 * - `progress`: stage updates, early metadata (B4) and classified failures;
 *   a bot check re-queues itself with backoff (`autoRetry`).
 * - `finish` (internal, through `blobs.complete`): the song row, its
 *   practice for imports, and the B6 chained beats job.
 * - `beatsDone` / `sectionsDone`: detection results. The server writes the
 *   map only when the song has none (D44) and stores section suggestions
 *   (D47) only when the map has no sections.
 * - `heartbeat`: device presence (D11).
 */

/** Dispatches a bot-checked job gets before it stays failed (§6.6). */
export const BOT_CHECK_ATTEMPTS = 3;
/** The first bot-check backoff; it doubles with each attempt. */
export const BOT_CHECK_BACKOFF_MS = 5 * 60_000;
/** The message every re-queue shows (the same resets as `jobs.retry`). */
export const RESUME_MESSAGE = 'Resuming local files…';
/** Queued jobs scanned for the B6 priority order. */
const NEXT_SCAN = 20;
/** Detected beats accepted in one result. */
const MAX_BEATS = 8000;
/** Import blobs stay well under the 1 MB document limit. */
const MAX_IMPORT_TEMPO_CHARS = 800_000;
const SECTION_LABEL_MAX = 60;

const META_TEXT_MAX = 300;
const THUMBNAIL_MAX = 2000;
const URL_MAX = 2000;
const PROVIDER_MAX = 100;

type Job = Doc<'jobs'>;
type Song = Doc<'songs'>;
type SuggestedSection = { t0: number; label: string; confidence: number };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** `settings` as Python sees it: `six` is the 6-stem model on the `full` mode (§6.6). */
function settingsForWorker(settings: unknown) {
  const s = isObject(settings) ? settings : {};
  return s.stemMode === 'six' ? { ...s, stemMode: 'full' } : s;
}

function qualityFor(settings: unknown) {
  const quality = resolveQuality(settings);
  // `six` always runs the 6-stem model, whatever the preset says.
  return isObject(settings) && settings.stemMode === 'six' ? { ...quality, model: 'htdemucs_6s' } : quality;
}

/** Everything in a stored tempo except the map and the 1.9 map copies (`source`, `map`, `detected`). */
function nonMapFields(tempo: unknown): Record<string, unknown> {
  if (!isObject(tempo)) return {};
  const { songMap: _songMap, map: _map, detected: _detected, source: _source, ...rest } = tempo;
  return rest;
}

/** The song's map, upgraded the way a session would load it. */
const mapOf = (song: Song) => songMapFromTempo(song.tempo, song.duration);

/** Valid suggestions inside the recording, sorted, one per time, capped. */
function cleanSections(sections: SuggestedSection[] | undefined, duration: number): SuggestedSection[] {
  const out: SuggestedSection[] = [];
  const valid = (sections ?? [])
    .filter(s => Number.isFinite(s.t0) && s.t0 >= 0 && (!(duration > 0) || s.t0 < duration))
    .sort((a, b) => a.t0 - b.t0);
  for (const s of valid) {
    if (out.length && s.t0 - out[out.length - 1].t0 < 0.05) continue;
    const label = s.label.replace(/\s+/g, ' ').trim().slice(0, SECTION_LABEL_MAX) || 'Section';
    out.push({ t0: s.t0, label, confidence: Number.isFinite(s.confidence) ? Math.max(0, Math.min(1, s.confidence)) : 0 });
    if (out.length >= SECTION_SUGGESTIONS_MAX) break;
  }
  return out;
}

/** Early job metadata (B4): strings ≤ 300, thumbnails https only and ≤ 2000. */
function cleanMeta(meta: { title?: string; channel?: string; duration?: number; thumbnail?: string; provider?: string }) {
  const out: Record<string, string | number> = {};
  for (const key of ['title', 'channel', 'provider'] as const) {
    const value = meta[key]?.trim();
    if (value) out[key] = value.slice(0, META_TEXT_MAX);
  }
  if (meta.duration !== undefined && Number.isFinite(meta.duration) && meta.duration > 0) out.duration = meta.duration;
  const thumb = meta.thumbnail?.trim();
  if (thumb && thumb.length <= THUMBNAIL_MAX && /^https:\/\/[^\s]+$/i.test(thumb)) out.thumbnail = thumb;
  return out;
}

function cleanUrl(url: string | undefined) {
  const value = url?.trim();
  return value && value.length <= URL_MAX && /^https?:\/\/[^\s]+$/i.test(value) ? value : undefined;
}

/** Stores the suggestion only when the song's map has no sections of its own (D47). */
async function suggestSections(ctx: MutationCtx, song: Song, map: ReturnType<typeof mapOf>, sections: SuggestedSection[], jobId: Id<'jobs'>, now: number) {
  if (!sections.length || sectionsOf(map, song.duration).length) return;
  await ctx.db.patch('songs', song._id, { sectionSuggestion: { sections, jobId, createdAt: now } });
}

async function deviceJob(ctx: MutationCtx, token: string, jobId: Id<'jobs'>) {
  const d = await requireDevice(ctx, token);
  const job = await ctx.db.get('jobs', jobId);
  if (!job || job.deviceId !== d._id || job.userId !== d.userId) fail('not_found', 'Job unavailable.');
  return { d, job };
}

async function ownSong(ctx: MutationCtx, job: Job) {
  const song = job.songId ? await ctx.db.get('songs', job.songId) : null;
  return song && song.userId === job.userId ? song : null;
}

export const next = query({
  args: { token: v.string() }, returns: v.any(),
  handler: async (ctx, { token }) => {
    const d = await requireDevice(ctx, token);
    // A restarted (or updated) companion resumes its own unfinished job first (D12).
    const running = await ctx.db.query('jobs').withIndex('by_device_status', q => q.eq('deviceId', d._id).eq('status', 'running')).first();
    if (running) return running;
    // B6: bars come quickly and make a song playable with its grid, so detection jumps the queue.
    const queued = await ctx.db.query('jobs').withIndex('by_device_status', q => q.eq('deviceId', d._id).eq('status', 'queued')).take(NEXT_SCAN);
    return queued.find(j => j.kind === 'beats') ?? queued.find(j => j.kind === 'sections') ?? queued[0] ?? null;
  },
});

export const claim = mutation({
  args: { token: v.string(), jobId: v.id('jobs') }, returns: v.any(),
  handler: async (ctx, { token, jobId }) => {
    const { job } = await deviceJob(ctx, token, jobId);
    if (job.status !== 'running' && job.status !== 'queued') fail('not_found', 'Job unavailable.');
    const now = Date.now();
    const attempts = (job.attempts ?? 0) + 1;
    const startedAt = job.startedAt ?? now;
    await ctx.db.patch('jobs', jobId, { status: 'running', attempts, startedAt, updatedAt: now });
    const song = await ownSong(ctx, job);
    const settings = settingsForWorker(job.settings);
    const claimed = {
      ...job, status: 'running' as const, attempts, startedAt, updatedAt: now,
      settings, quality: qualityFor(job.settings), chainedFrom: job.chainedFrom ?? null, song,
    };
    if (job.kind !== 'sections') return claimed;
    // A sections job (D47) segments the song along its current map's bar starts.
    const downbeats = song && hasRealMap(song.tempo) ? barsOf(mapOf(song), song.duration).map(b => b.t0) : [];
    return { ...claimed, downbeats };
  },
});

/**
 * The device behind a `progress` call. A failure report still gets through on
 * a paused account (§10.2 `account_paused`): a job the companion claimed
 * before the pause then ends as an error instead of sitting `running`. Every
 * other call on a paused account is refused as before.
 */
async function progressDevice(ctx: MutationCtx, token: string, failed: boolean) {
  try {
    return { device: await requireDevice(ctx, token), paused: false };
  } catch (error) {
    const code = codeOf(error);
    if (!failed || (code !== 'account_suspended' && code !== 'account_export_only')) throw error;
    const hash = await hashToken(token);
    const device = await ctx.db.query('devices').withIndex('by_token', q => q.eq('tokenHash', hash)).unique();
    if (!device || device.revoked) throw error;
    return { device, paused: true };
  }
}

export const progress = mutation({
  args: {
    token: v.string(), jobId: v.id('jobs'), stage: v.string(), percent: v.number(),
    message: v.optional(v.string()), error: v.optional(v.string()),
    errorCode: v.optional(v.string()), meta: v.optional(jobMetaValidator),
  },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    const failed = a.error !== undefined || a.stage === 'error';
    const { device: d, paused } = await progressDevice(ctx, a.token, failed);
    const j = await ctx.db.get('jobs', a.jobId);
    // false tells the companion to stop: the job was canceled, dismissed or moved.
    if (!j || j.deviceId !== d._id || j.userId !== d.userId || (j.status !== 'queued' && j.status !== 'running')) return false;
    const now = Date.now();
    const errorCode = failed ? (isJobErrorCode(a.errorCode) ? a.errorCode : a.errorCode === undefined ? undefined : 'unknown') : undefined;
    const attempts = j.attempts ?? 0;
    // A paused account could not claim the job again, so it is never auto-retried.
    const retry = !paused && errorCode === 'bot_check' && attempts < BOT_CHECK_ATTEMPTS;
    const retryAt = retry ? now + BOT_CHECK_BACKOFF_MS * 2 ** Math.max(0, attempts - 1) : undefined;
    const meta = a.meta ? cleanMeta(a.meta) : null;
    await ctx.db.patch('jobs', j._id, {
      status: failed ? 'error' : 'running',
      stage: a.stage.slice(0, 30),
      percent: Number.isFinite(a.percent) ? Math.max(0, Math.min(100, a.percent)) : 0,
      message: a.message?.slice(0, 300),
      error: a.error?.slice(0, 2000),
      errorCode, retryAt, updatedAt: now,
      ...(meta && Object.keys(meta).length ? { meta: { ...(isObject(j.meta) ? j.meta : {}), ...meta } } : {}),
    });
    if (retry) await ctx.scheduler.runAt(retryAt!, internal.worker.autoRetry, { jobId: j._id, attempts });
    return true;
  },
});

/** A bot-checked job re-queues itself, unless anything happened to it since (a retry, a cancel, a dismiss). */
export const autoRetry = internalMutation({
  args: { jobId: v.id('jobs'), attempts: v.number() }, returns: v.boolean(),
  handler: async (ctx, { jobId, attempts }) => {
    const job = await ctx.db.get('jobs', jobId);
    if (!job || job.status !== 'error' || (job.attempts ?? 0) !== attempts || job.errorCode !== 'bot_check') return false;
    // A computer revoked, or an account paused, during the backoff could never
    // claim the job: it stays failed, with the normal Retry path instead.
    const device = job.deviceId ? await ctx.db.get('devices', job.deviceId) : null;
    let canProcess = !!device && !device.revoked && device.userId === job.userId;
    if (canProcess) {
      try { await assertAccountAccess(ctx, job.userId, true); } catch { canProcess = false; }
    }
    if (!canProcess) {
      await ctx.db.patch('jobs', jobId, { retryAt: undefined, updatedAt: Date.now() });
      return false;
    }
    await ctx.db.patch('jobs', jobId, {
      status: 'queued', stage: 'queued', percent: 0, error: undefined, errorCode: undefined, retryAt: undefined,
      message: RESUME_MESSAGE, updatedAt: Date.now(),
    });
    return true;
  },
});

export const uploadContext = internalQuery({
  args: { token: v.string(), jobId: v.id('jobs') }, returns: v.any(),
  handler: async (ctx, a) => {
    const d = await requireDevice(ctx, a.token);
    const job = await ctx.db.get('jobs', a.jobId);
    if (!job || job.deviceId !== d._id || job.userId !== d.userId) fail('not_found', 'Not your job.');
    return { job, files: await ctx.db.query('audioObjects').withIndex('by_job', q => q.eq('jobId', a.jobId)).take(9) };
  },
});

export const resultValidator = v.object({
  title: v.string(), uploader: v.optional(v.string()), artist: v.optional(v.string()), album: v.optional(v.string()),
  albumArtist: v.optional(v.string()), year: v.optional(v.string()), genre: v.optional(v.string()),
  trackNumber: v.optional(v.string()), discNumber: v.optional(v.string()), musicalKey: v.optional(v.string()),
  fingerprint: v.optional(fingerprintValidator),
  duration: v.number(), stems: v.array(stemValidator), coverKey: v.optional(v.string()),
  stemMode: v.string(), quality: qualityValidator,
  // B4: where a URL or search resolved to, and the site that served it (yt-dlp `extractor_key`).
  resolvedUrl: v.optional(v.string()), provider: v.optional(v.string()),
});

/**
 * A new song's B1 fields, written at insert so `migrations.isUpgraded` holds
 * from the start and the I0B backfill cron never has to visit it: no job
 * brings a chart (`hasChart: false`), `mapSummary` from the imported tempo
 * (none for a separation), and for an import its practice and summary
 * (B1, B2). Unmapped songs never get bar labels; their loops read
 * 'm:ss–m:ss loop'.
 */
function newSongState(tempo: unknown, rawPractice: unknown, duration: number) {
  const song = { tempo, duration, hasChart: false };
  const base = { hasChart: false, mapSummary: mapSummaryFor(song) };
  if (rawPractice === null || rawPractice === undefined) return { ...base, practice: null };
  const { value } = prunePractice(upgradePractice(rawPractice, { legacyTempo: tempo, duration }), PRACTICE_CAP);
  return { ...base, practice: value, practiceSummary: summarize(value, summaryMapOf(song)), lastPracticedAt: value.lastAt };
}

/** B6: queue bars for a fresh separation when the account wants them and the song has no map yet. */
async function chainBeats(ctx: MutationCtx, job: Job, deviceId: Id<'devices'>, songId: Id<'songs'>, now: number) {
  const song = await ctx.db.get('songs', songId);
  if (!song || hasRealMap(song.tempo, { hasPart: song.hasChart === true })) return null;
  // The account's stored settings decide; `job.settings` holds only what the Add sheet sent.
  const row = await ctx.db.query('userSettings').withIndex('by_user', q => q.eq('userId', job.userId)).unique();
  const settings = withDefaults(row?.settings);
  if (settings.autoBeats === false) return null;
  const pending = await ctx.db.query('jobs').withIndex('by_song', q => q.eq('songId', songId)).order('desc').take(20);
  if (pending.some(j => j.kind === 'beats' && (j.status === 'queued' || j.status === 'running'))) return null;
  return await ctx.db.insert('jobs', {
    kind: 'beats', userId: job.userId, deviceId, songId, label: `Finding bars — ${song.title}`,
    chainedFrom: job._id, settings: { sections: settings.autoSections !== false },
    status: 'queued', stage: 'queued', percent: 0, attempts: 0, createdAt: now, updatedAt: now,
  });
}

export const finish = internalMutation({
  args: { token: v.string(), jobId: v.id('jobs'), result: resultValidator }, returns: v.id('songs'),
  handler: async (ctx, a) => {
    const d = await requireDevice(ctx, a.token);
    const job = await ctx.db.get('jobs', a.jobId);
    if (!job || job.deviceId !== d._id || job.userId !== d.userId) fail('not_found', 'Not your job.');
    if (job.status === 'done' && job.songId) return job.songId;
    if (job.status !== 'running') fail('not_found', 'Job no longer running.');
    const now = Date.now();
    const objects = await ctx.db.query('audioObjects').withIndex('by_job', q => q.eq('jobId', job._id)).take(9);
    const keys = [...a.result.stems.map(s => s.key), ...(a.result.coverKey ? [a.result.coverKey] : [])];
    if (keys.length !== objects.length || new Set(keys).size !== keys.length || a.result.stems.length < 1 || objects.some(o => o.status !== 'reserved' || o.expiresAt <= now || !keys.includes(o.key))) fail('invalid', 'Invalid upload manifest.');
    if (!Number.isFinite(a.result.duration) || a.result.duration <= 0 || a.result.title.length > 500) fail('invalid', 'Invalid song metadata.');
    const stems = a.result.stems.map(s => {
      const o = objects.find(o => o.key === s.key)!;
      if (o.name.replace(/\.[^.]+$/, '') !== s.name || !o.mime.startsWith('audio/')) fail('invalid', 'Invalid stem.');
      return { name: s.name, key: o.key, bytes: o.bytes, mime: o.mime };
    });
    if (job.kind === 'import' && job.importMeta?.id) {
      const existing = await ctx.db.query('songs').withIndex('by_user_import', q => q.eq('userId', d.userId).eq('localImportId', job.importMeta.id)).unique();
      if (existing) {
        for (const o of objects) await retireKey(ctx, o.key);
        await ctx.db.patch('jobs', job._id, { status: 'done', songId: existing._id, percent: 100, stage: 'done', updatedAt: now });
        return existing._id;
      }
    }
    if (a.result.fingerprint && (a.result.fingerprint.value.length > 30000 || !/^[A-Za-z0-9_-]+$/.test(a.result.fingerprint.value) || !Number.isFinite(a.result.fingerprint.duration) || a.result.fingerprint.duration <= 0)) fail('invalid', 'Invalid fingerprint.');
    const { resolvedUrl: rawUrl, provider: rawProvider, ...result } = a.result;
    const imported = cleanMetadata(Object.fromEntries(Object.keys(metadataFields).filter(key => key in result).map(key => [key, result[key as keyof typeof result]])));
    const resolvedUrl = cleanUrl(rawUrl);
    const provider = rawProvider?.trim().slice(0, PROVIDER_MAX) || undefined;
    // A `six` split runs as `full` on the 6-stem model; the song keeps the mode the user chose.
    const stemMode = isObject(job.settings) && job.settings.stemMode === 'six' && result.stemMode === 'full' ? 'six' : result.stemMode;
    let songId = job.songId;
    const fields = { ...result, ...imported, stemMode, stems, source: job.source, userId: d.userId, addedAt: job.createdAt, resolvedUrl, provider };
    if (songId) {
      const old = await ctx.db.get('songs', songId);
      if (!old || old.userId !== d.userId) fail('not_found', 'Song was deleted during processing.');
      for (const key of old.stems.map(s => s.key)) await retireKey(ctx, key);
      await ctx.db.patch('songs', songId, {
        ...fields, ...Object.fromEntries(Object.keys(metadataFields).map(key => [key, old[key as keyof typeof old]])),
        title: old.title, artist: old.artist, album: old.album, uploader: old.uploader, coverKey: old.coverKey, addedAt: old.addedAt, renditionId: undefined,
        resolvedUrl: resolvedUrl ?? old.resolvedUrl, provider: provider ?? old.provider,
      });
    } else {
      const meta = job.kind === 'import' && isObject(job.importMeta) ? job.importMeta : null;
      const tempo = meta && meta.tempo !== null && meta.tempo !== undefined ? meta.tempo : undefined;
      const state = newSongState(tempo, meta?.practice, result.duration);
      songId = await ctx.db.insert('songs', {
        ...fields,
        originDeviceId: d._id,
        hasChart: state.hasChart,
        mapSummary: state.mapSummary,
        // D43: a search the user did not pick from B4 candidates may be the wrong recording.
        ...(job.source?.type === 'search' && job.confirmed !== true ? { recordingUnconfirmed: true } : {}),
        ...(meta ? { localImportId: String(meta.id) } : {}),
        ...(tempo !== undefined ? { tempo } : {}),
        ...(state.practice ? { practiceSummary: state.practiceSummary, ...(state.lastPracticedAt !== undefined ? { lastPracticedAt: state.lastPracticedAt } : {}) } : {}),
      });
      if (state.practice) await ctx.db.insert('songPractice', { songId, userId: d.userId, practice: state.practice, updatedAt: now });
    }
    for (const o of objects) await ctx.db.patch('audioObjects', o._id, { status: 'ready' });
    if (job.songId && a.result.coverKey) await retireKey(ctx, a.result.coverKey);
    if (!job.songId && job.kind !== 'import') {
      await ctx.db.patch('songs', songId, { metadataStatus: 'pending' });
      await ctx.scheduler.runAfter(0, internal.metadataLookup.enrich, { id: songId });
    }
    await ctx.db.patch('jobs', job._id, { status: 'done', songId, percent: 100, stage: 'done', errorCode: undefined, retryAt: undefined, updatedAt: now });
    if (job.kind === 'separate') await chainBeats(ctx, job, d._id, songId, now);
    return songId;
  },
});

export const beatsDone = mutation({
  args: {
    token: v.string(), jobId: v.id('jobs'), beats: v.array(v.array(v.number())),
    sections: v.optional(v.array(suggestedSectionValidator)),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const { job: j } = await deviceJob(ctx, a.token, a.jobId);
    if (j.kind !== 'beats') fail('not_found', 'Job unavailable.');
    if (j.status === 'done') return null; // a repeated report after a lost response
    if (j.status !== 'running') fail('not_found', 'Job unavailable.');
    if (a.beats.length > MAX_BEATS || a.beats.some(b => b.length !== 2 || b.some(n => !Number.isFinite(n)))) fail('invalid', 'Invalid beat map.');
    const now = Date.now();
    const song = await ownSong(ctx, j);
    const sections = cleanSections(a.sections, song?.duration ?? 0);
    await ctx.db.patch('jobs', j._id, {
      status: 'done', stage: 'done', percent: 100, result: { beats: a.beats, sections },
      errorCode: undefined, retryAt: undefined, updatedAt: now,
    });
    if (!song) return null;
    const hasPart = song.hasChart === true;
    let map = mapOf(song);
    // D44: the server applies detection only to a song with no real map, so a
    // result is never lost; a mapped song's open session applies it instead.
    if (!hasRealMap(song.tempo, { hasPart })) {
      const detected = { ...fromBeats(a.beats.map(([time, beat]) => ({ time, downbeat: Math.round(beat) === 1 })), song.duration), origin: 'detected' as const };
      let usable = detected.pins.length >= 2;
      try { validateSongMap(detected); } catch { usable = false; }
      if (usable) {
        const tempo = { ...nonMapFields(song.tempo), songMap: detected };
        await ctx.db.patch('songs', song._id, {
          tempo, tempoRev: (song.tempoRev ?? 0) + 1, tempoSaveId: undefined,
          mapSummary: mapSummaryOf(tempo, song.duration, { hasPart }),
        });
        // D44: one applier per case. The server applied it, so latestDetection
        // never offers it again; the open song sees it as an external change.
        await ctx.db.patch('jobs', j._id, { appliedAt: now });
        map = detected;
      }
    }
    await suggestSections(ctx, song, map, sections, j._id, now);
    return null;
  },
});

/** B7: suggested sections for a mapped song (a `sections` job, D47). */
export const sectionsDone = mutation({
  args: { token: v.string(), jobId: v.id('jobs'), sections: v.array(suggestedSectionValidator) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const { job: j } = await deviceJob(ctx, a.token, a.jobId);
    if (j.kind !== 'sections') fail('not_found', 'Job unavailable.');
    if (j.status === 'done') return null;
    if (j.status !== 'running') fail('not_found', 'Job unavailable.');
    const now = Date.now();
    const song = await ownSong(ctx, j);
    const sections = cleanSections(a.sections, song?.duration ?? 0);
    await ctx.db.patch('jobs', j._id, {
      status: 'done', stage: 'done', percent: 100, result: { sections },
      errorCode: undefined, retryAt: undefined, updatedAt: now,
    });
    if (song) await suggestSections(ctx, song, mapOf(song), sections, j._id, now);
    return null;
  },
});

/** Device presence (D11): one row per device, refreshed by every heartbeat. */
export const heartbeat = mutation({
  args: {
    token: v.string(), state: presenceStateValidator, currentJobId: v.optional(v.id('jobs')),
    appVersion: v.optional(v.string()), platform: v.optional(v.string()), accelerator: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const d = await requireDevice(ctx, a.token);
    const current = a.currentJobId ? await ctx.db.get('jobs', a.currentJobId) : null;
    const text = (value: string | undefined, max: number) => value?.trim().slice(0, max) || undefined;
    const fields = {
      deviceId: d._id, userId: d.userId, lastSeenAt: Date.now(), state: a.state,
      currentJobId: current && current.deviceId === d._id && current.userId === d.userId ? current._id : undefined,
      appVersion: text(a.appVersion, 40), platform: text(a.platform, 60), accelerator: text(a.accelerator, 100),
    };
    const existing = await ctx.db.query('devicePresence').withIndex('by_deviceId', q => q.eq('deviceId', d._id)).unique();
    if (existing) {
      // Upsert: state, lastSeenAt and currentJobId follow every beat (an absent
      // job clears it); the descriptive fields keep their stored values when a
      // beat leaves them out.
      const { appVersion, platform, accelerator, ...always } = fields;
      const described = Object.fromEntries(Object.entries({ appVersion, platform, accelerator }).filter(([, value]) => value !== undefined));
      await ctx.db.patch('devicePresence', existing._id, { ...always, ...described });
    } else {
      const row = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as typeof fields;
      await ctx.db.insert('devicePresence', row);
    }
    return null;
  },
});

export const importSong = mutation({
  args: { token: v.string(), legacyId: v.string(), title: v.string(), tempo: v.optional(v.any()), practice: v.optional(v.any()) }, returns: v.any(),
  handler: async (ctx, a) => {
    const d = await requireDevice(ctx, a.token);
    if (a.legacyId.length > 200 || a.title.length > 500) fail('invalid', 'Invalid import.');
    const tempo = a.tempo ?? null;
    if (JSON.stringify(tempo).length > MAX_IMPORT_TEMPO_CHARS) fail('invalid', 'Invalid import.');
    const existing = await ctx.db.query('songs').withIndex('by_user_import', q => q.eq('userId', d.userId).eq('localImportId', a.legacyId)).unique();
    if (existing) return { songId: existing._id, jobId: null };
    const queued = await ctx.db.query('jobs').withIndex('by_device_status', q => q.eq('deviceId', d._id).eq('status', 'queued')).take(20);
    const running = await ctx.db.query('jobs').withIndex('by_device_status', q => q.eq('deviceId', d._id).eq('status', 'running')).take(20);
    const same = [...queued, ...running].find(j => j.importMeta?.id === a.legacyId);
    if (same) return { jobId: same._id, songId: null };
    if (queued.length >= 20) fail('queue_full', 'Import queue full. Import more after these finish.');
    // B2: the practice blob is upgraded and capped now; `finish` clamps it to the song's duration.
    const practice = a.practice === undefined || a.practice === null ? null : prunePractice(upgradePractice(a.practice, { legacyTempo: tempo }), PRACTICE_CAP).value;
    const now = Date.now();
    const jobId = await ctx.db.insert('jobs', { userId: d.userId, deviceId: d._id, kind: 'import', label: a.title, importMeta: { id: a.legacyId, tempo, practice }, status: 'queued', stage: 'queued', percent: 0, attempts: 0, createdAt: now, updatedAt: now });
    return { jobId, songId: null };
  },
});
