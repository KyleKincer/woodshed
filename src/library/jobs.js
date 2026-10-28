// Jobs: the view-model over store.library.jobs and store.library.uploads, the top bar's Jobs chip and
// the Jobs popover (architecture §2.16, spec §2.1, §2.8, §3.4, §3.5).
//
//   createJobsModel(deps?) → JobsModel
//   JobsModel = {
//     items:  ReadonlySignal<JobVM[]>        every row of the popover: failures, live jobs, uploads, found detections
//     chip:   ReadonlySignal<{text, tone, icon}|null>   the top bar chip; null when there is nothing to show
//     bySong: ReadonlySignal<Map<songId, JobVM>>       the job a song's card shows (processing, re-splitting, failed)
//     ready:  ReadonlySignal<Song[]>         songs whose split finished during this app session and that have not
//                                            been opened since: the Stage `1 ready` chip, toasts, notifications
//     dismissFound(jobId), destroy()
//   }
//   jobsModel                                the app's shared model (created on first use): jobsModel.items, .chip,
//                                            .bySong, .ready; sharedJobsModel() returns the same object
//   openJobsPopover({anchor, focusJobId}) → {close}      one at a time; opening again refocuses
//   closeJobsPopover()
//   mountJobsChip(slot) → {destroy}                      fills the top bar's jobs slot (topbar.jobsSlot)
//
// JobVM = {id, jobId, kind: 'separate'|'beats'|'sections'|'import'|'upload', status: 'queued'|'running'|'error'|'done',
//          songId, title, quoted, artist, cover, coverKey, stages: [{id, label, state}], current, percent,
//          line /* the card line, §3.4 */, activity /* the popover line, §2.8 */, rail: {value, striped}|null,
//          ahead, device: {id, name, online, local}|null, settingsLine, message, source: {label, url}|null,
//          eta /* ms left, or null */, startedAt, failure: describeError()|null, local, resplit,
//          detailsFirst /* the §3.6 row's primary is Details (disk full): actions are its secondaries */,
//          setup /* a first-run model/runtime download under the separate stage: no split percent, no ETA */,
//          actions: [{label, run, tone, target?}], details}
//
// Where the rows come from:
//   - store.library.jobs (jobs.listActive: queued, running and failed jobs, S1 data.js);
//   - store.library.uploads (src/library/upload.js, LB2a): entries {id, name | file.name, title?, deviceId?,
//     progress: Signal<{loaded, total}>, state: Signal<'uploading'|'queued'|'error'|'canceled'>, cancel(),
//     error?, dismiss?()}; `progress`/`state`/`error` may also be plain values. Only uploading and failed
//     entries are rows: a queued one already has its job;
//   - found detections: a user-started (no chainedFrom) beat detection that is done, has a result and is
//     unapplied (D44: the server applies it itself on an unmapped song and sets appliedAt). Either one seen
//     live this session that left the list done while its song was not open (an open session applies its
//     own; followed with jobs.get, subscribeJob), or a row of `jobs.listUnappliedDetections` (§6.4: every
//     song, newest first, capped by the server), subscribed once the library has loaded. Either leaves once
//     applied anywhere, and stays gone once dismissed here (Not now, or opening its song). The row offers [Open song] (the Stage then offers "Bars found while you were away")
//     and [Not now] (jobs.markApplied, as the Stage's own Not now does).
// `ready` follows separations (and imports) seen live that left the list done (jobs.get after they vanish)
// while their song was not open; opening the song (store.stage.songId) removes it.
//
// ETA (spec §3.4): from the percent samples of the current `separate` stage, after the stage was seen for
// ETA_AFTER_MS, over a moving ETA_WINDOW_MS window; hidden when the window's newer half moves at more
// than 2× (or under half) the older half's rate, when nothing moved for ETA_STALL_MS, or above ETA_MAX_MS.
//
// The popover is non-modal (D36). While it is open it polls the processor (desktop.watchStatus) and its
// footer reads "Processor ready · <name>" on the desktop (Restart processor when offline), or the paired
// computer on the web (B5).

import '../styles/views/library/jobs.css';
import * as jobsApi from '../api/jobs.js';
import {isOnline} from '../api/devices.js';
import {signKeys} from '../api/media.js';
import {now as clockNow} from '../app/clock.js';
import {registry as appRegistry} from '../app/commands.js';
import {desktop as appDesktop, processorLabel} from '../app/desktop.js';
import {describeError} from '../app/error-copy.js';
import {toast} from '../app/feedback.js';
import {computed, effect, signal, store as appStore, untracked} from '../app/store.js';
import {Button} from '../ui/button.js';
import {h, reconcileList} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {Popover} from '../ui/popover.js';
import {StageStepper} from '../ui/progress.js';
import {PRESETS} from '../../convex/lib/presets.ts';
import {ACTIONS, CHIP, DEVICES, ETA, LINES, POPOVER, SETTINGS, STAGES, VERBS, quote} from './jobs.copy.js';

export {CONTROLS} from './jobs.copy.js';

export const ETA_AFTER_MS = 15_000;
export const ETA_WINDOW_MS = 60_000;
export const ETA_STALL_MS = 30_000;
export const ETA_MAX_MS = 6 * 3600_000;
export const TICK_MS = 1000;
export const COPIED_MS = 2000;
/** Samples kept per job (the window rarely holds more). */
const MAX_SAMPLES = 120;

/**
 * The stage a failed job stopped in when the companion reported only `stage: 'error'` (companion/server.mjs
 * sends every failure that way): from its error code. Unknown codes read as the first step.
 */
const FAILED_STAGE = Object.freeze({
  bot_check: 'download', unavailable: 'download', not_found: 'download', playlist: 'download', source_missing: 'download',
  unreadable: 'download', separation_failed: 'separate', disk_full: 'separate', storage_full: 'sync', storage_full_user: 'sync',
  account_paused: 'sync', sync_failed: 'sync',
});
/** The stage a failed job reads as on its stepper. */
export function failedStage(job, code = job?.errorCode) {
  const stage = job?.stage;
  if (stage && stage !== 'error' && stage !== 'queued') return stage;
  return FAILED_STAGE[code] ?? 'download';
}

/**
 * A first-run download the companion reports under the `separate` stage (the separation model, or the
 * NVIDIA runtime: companion/pipeline.py DOWNLOAD_MESSAGE, companion/gpu_runtime.py). Not split progress.
 */
const SETUP_MESSAGE = /\(first run\)|one-time download/i;
export const isSetupMessage = message => typeof message === 'string' && SETUP_MESSAGE.test(message);

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v.trim() : '');
const isLiveStatus = s => s === 'queued' || s === 'running';
const clampPct = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
/** A signal's value, or the value itself (upload entries may carry either). */
const read = v => (v !== null && typeof v === 'object' && 'value' in v && typeof v.peek === 'function' ? v.value : v);

// ---------------------------------------------------------------------------------------------- pure helpers

/** m:ss (h:mm:ss from an hour). */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const s = total % 60, m = Math.floor(total / 60) % 60, hrs = Math.floor(total / 3600);
  const ss = String(s).padStart(2, '0');
  return hrs ? `${hrs}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "~2 min" (card) or "about 2 min left" (popover); null for no estimate. */
export function formatEta(ms, {style = 'card'} = {}) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = ms < 60_000 ? 0 : Math.round(ms / 60_000);
  if (minutes >= 60) {
    const hrs = Math.floor(minutes / 60), rest = minutes % 60;
    return style === 'card' ? ETA.cardHours(hrs, rest) : ETA.popoverHours(hrs, rest);
  }
  return style === 'card' ? ETA.card(minutes) : ETA.popover(minutes);
}

/** Megabytes for "Uploading · 12 of 31 MB": whole numbers from 10 MB, one decimal below. */
export function formatMB(bytes) {
  const mb = Math.max(0, Number(bytes) || 0) / 1e6;
  return mb >= 10 ? String(Math.round(mb)) : String(Math.round(mb * 10) / 10);
}

/**
 * Milliseconds left for a job from its percent samples [[t, pct], …] (ascending, one stage), at `at`; null
 * when there is no trustworthy estimate yet (see the header).
 */
export function estimateRemaining(samples, at) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const first = samples[0], last = samples[samples.length - 1];
  if (at - first[0] < ETA_AFTER_MS) return null;
  if (at - last[0] > ETA_STALL_MS) return null;
  let start = samples.findIndex(s => s[0] >= last[0] - ETA_WINDOW_MS);
  if (start < 0 || start >= samples.length - 1) start = Math.max(0, samples.length - 2);
  const w0 = samples[start];
  const span = last[0] - w0[0];
  if (!(span > 0)) return null;
  const rate = (last[1] - w0[1]) / span;
  if (!(rate > 0)) return null;
  const mid = w0[0] + span / 2;
  const m = samples.slice(start, -1).find(s => s[0] >= mid) ?? null;
  if (m && last[0] > m[0] && m[0] > w0[0]) {
    // Stable: the newer half of the window moves at 0.5–2× the older half's rate.
    const older = (m[1] - w0[1]) / (m[0] - w0[0]);
    const recent = (last[1] - m[1]) / (last[0] - m[0]);
    if (!(older > 0) || !(recent > 0) || recent / older < 0.5 || recent / older > 2) return null;
  }
  const remaining = (100 - last[1]) / rate - (at - last[0]);
  if (remaining > ETA_MAX_MS) return null;
  return Math.max(0, remaining);
}

/** "Balanced · 4 stems" from a job's settingsSummary; null when unknown. */
export function settingsLine(summary) {
  if (!isObject(summary)) return null;
  const preset = summary.preset === 'custom' ? SETTINGS.custom : PRESETS[summary.preset]?.label ?? null;
  const stems = SETTINGS.stems[summary.stemMode] ?? null;
  const parts = [preset, stems].filter(Boolean);
  return parts.length ? parts.join(SETTINGS.join) : null;
}

/** {label: 'youtube.com/…', url} for a link source; null for searches and uploads. */
export function sourceLink(source) {
  if (!isObject(source) || (source.type !== 'url' && source.type !== 'spotify')) return null;
  let url;
  try { url = new URL(String(source.value)); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.replace(/^www\./i, '');
  const more = (url.pathname && url.pathname !== '/') || url.search ? '/…' : '';
  return {label: `${host}${more}`, url: url.href};
}

/** The stepper stages and the current one for a job (spec §2.8). */
export function stagesFor(kind, stage, {sourceType = null} = {}) {
  const S = (id, label) => ({id, label});
  if (kind === 'upload') return {stages: [S('upload', STAGES.upload), S('split', STAGES.split), S('finish', STAGES.finish), S('ready', STAGES.ready)], current: 'upload'};
  if (kind === 'beats' || kind === 'sections') {
    const work = kind === 'beats' ? S('bars', STAGES.bars) : S('sections', STAGES.sections);
    return {stages: [work, S('ready', STAGES.ready)], current: stage === 'queued' ? null : stage === 'done' ? 'ready' : work.id};
  }
  if (kind === 'import') {
    const current = stage === 'queued' ? null : stage === 'finalize' || stage === 'sync' ? 'finish' : stage === 'done' ? 'ready' : 'copy';
    return {stages: [S('copy', STAGES.copy), S('finish', STAGES.finish), S('ready', STAGES.ready)], current};
  }
  const fetch = sourceType === 'upload' ? S('fetch', STAGES.prepare) : S('fetch', STAGES.fetch);
  const CURRENT = {queued: null, download: 'fetch', upload: 'fetch', separate: 'split', finalize: 'finish', sync: 'finish', done: 'ready'};
  const current = Object.hasOwn(CURRENT, stage) ? CURRENT[stage] : 'fetch';
  return {stages: [fetch, S('split', STAGES.split), S('finish', STAGES.finish), S('ready', STAGES.ready)], current};
}

function stageStateList(stages, current, failed) {
  const at = current == null ? -1 : stages.findIndex(s => s.id === current);
  return stages.map((s, i) => ({...s, state: at < 0 ? 'pending' : i < at ? 'done' : i === at ? (failed ? 'failed' : 'current') : 'pending'}));
}

/** The one-word verb of what a running job is doing. */
function verbFor(kind, current, sourceType) {
  if (kind === 'upload') return VERBS.uploading;
  if (kind === 'beats') return VERBS.bars;
  if (kind === 'sections') return VERBS.sections;
  if (kind === 'import') return current === 'finish' ? VERBS.finishing : VERBS.importing;
  if (current === 'split') return VERBS.splitting;
  if (current === 'finish') return VERBS.finishing;
  return sourceType === 'upload' ? VERBS.preparing : VERBS.fetching;
}

/** The device a job runs on, with its name and whether it is online. */
export function deviceFor(deviceId, {devices = [], processor = null, desktopAvailable = false, at}) {
  if (!deviceId) return null;
  const row = (Array.isArray(devices) ? devices : []).find(d => d?.deviceId === deviceId) ?? null;
  const local = !!desktopAvailable && !!processor?.deviceId && processor.deviceId === deviceId;
  const name = str(local ? processor?.name : '') || str(row?.name) || (local ? DEVICES.thisComputer : DEVICES.yourComputer);
  const online = local ? !['offline', 'pair-failed', 'web'].includes(processor?.phase) : isOnline(row, at);
  return {id: deviceId, name, online, local};
}

/** Live jobs on the same computer that run before this queued one (running ones, then older queued ones). */
export function aheadOf(job, jobs) {
  if (job?.status !== 'queued') return 0;
  return jobs.filter(j => j !== job && j.jobId !== job.jobId && (j.deviceId ?? null) === (job.deviceId ?? null)
    && (j.status === 'running' || (j.status === 'queued' && (j.createdAt < job.createdAt || (j.createdAt === job.createdAt && jobs.indexOf(j) < jobs.indexOf(job)))))).length;
}

// ---------------------------------------------------------------------------------------------- the model

let detailSeq = 0;

/**
 * Builds a jobs model. Every dependency can be replaced (tests); the app uses `jobsModel`.
 * @param {{store?, api?, desktop?, now?, timer?, router?, notify?}} [deps]
 */
export function createJobsModel({
  store = appStore, api = jobsApi, desktop = appDesktop, now = clockNow,
  timer = {set: (fn, ms) => globalThis.setInterval(fn, ms), clear: id => globalThis.clearInterval(id)},
  router = null, notify = (message, opts) => toast(message, opts), registry = appRegistry,
} = {}) {
  const lib = store.library;
  const tick = signal(now());
  const history = new Map();          // jobId → {stage, samples: [[t, pct]]}
  const historyVersion = signal(0);
  const seen = new Map();             // jobId → {kind, songId} of jobs seen live this session
  const readyIds = signal(new Set());
  const found = signal(new Map());    // jobId → JobDetail (done, unapplied, user-started detections)
  const foundWatches = new Map();     // jobId → off() of its jobs.get subscription
  const listedIds = new Set();        // jobIds in `found` that came from jobs.listUnappliedDetections
  const dismissedIds = new Set();     // jobIds dismissed here: a later list value does not bring them back
  const disposers = [];
  let destroyed = false;

  /** A first-run download on this job's computer (the message, or the desktop processor's first run). */
  const settingUp = (job, processor = store.processor.peek()) => isSetupMessage(job?.message)
    || (!!desktop.available && !!processor?.firstRun && !!processor?.deviceId && processor.deviceId === job?.deviceId);

  const routerOf = () => {
    if (router) return router;
    try { return registry.context().router ?? null; } catch { return null; }
  };

  // ---- watch the list: ETA samples, and what finished
  disposers.push(effect(() => {
    const jobs = lib.jobs.value ?? [];
    const at = now();
    untracked(() => {
      let touched = false;
      const present = new Set();
      for (const job of jobs) {
        if (!job?.jobId) continue;
        present.add(job.jobId);
        if (isLiveStatus(job.status)) seen.set(job.jobId, {kind: job.kind, songId: job.songId ?? null});
        else seen.delete(job.jobId);
        if (job.status === 'running' && job.stage === 'separate' && job.kind === 'separate' && !settingUp(job)) {
          const pct = Number(job.percent) || 0;
          let entry = history.get(job.jobId);
          if (!entry || entry.stage !== job.stage || pct < (entry.samples.at(-1)?.[1] ?? 0)) {
            entry = {stage: job.stage, samples: []};
            history.set(job.jobId, entry);
          }
          const last = entry.samples.at(-1);
          if (!last || last[1] !== pct) {
            entry.samples.push([at, pct]);
            if (entry.samples.length > MAX_SAMPLES) entry.samples.splice(0, entry.samples.length - MAX_SAMPLES);
            touched = true;
          }
        } else if (history.delete(job.jobId)) touched = true;
      }
      for (const id of [...history.keys()]) if (!present.has(id)) { history.delete(id); touched = true; }
      const openSong = store.stage.peek()?.songId ?? null;
      for (const [jobId, info] of [...seen]) {
        if (present.has(jobId)) continue;
        seen.delete(jobId);
        void settleVanished(jobId, {...info, openAtVanish: openSong});
      }
      if (touched) historyVersion.value++;
    });
  }));

  /** A detection the Library may offer: done, user-started, with a result, not applied (§6.4, D44). */
  const offerable = d => !!d && d.status === 'done' && d.kind === 'beats' && !d.chainedFrom && !d.appliedAt && d.result != null;

  async function settleVanished(jobId, info) {
    let detail = null;
    try { detail = await api.get({jobId}); } catch { return; }
    if (destroyed || !detail || detail.status !== 'done') return;
    const songId = detail.songId ?? info.songId ?? null;
    if (!songId) return;
    // The song is open (or was when the job finished): that session applies the result itself (D44) and the
    // user is looking at the song, so it is neither "ready" nor a found detection here.
    if (info.openAtVanish === songId || store.stage.peek()?.songId === songId) return;
    if (detail.kind === 'separate' || detail.kind === 'import') {
      const next = new Set(readyIds.peek());
      next.add(songId);
      readyIds.value = next;
    } else if (offerable(detail)) addFound({...detail, songId});
  }

  function addFound(detail) {
    if (destroyed || dismissedIds.has(detail.jobId) || found.peek().has(detail.jobId)) return;
    const next = new Map(found.peek());
    next.set(detail.jobId, detail);
    found.value = next;
    // Follow the job: once a session (here or on another device) applies it, the row goes.
    if (typeof api.subscribeJob === 'function') {
      try {
        const off = api.subscribeJob({jobId: detail.jobId}, value => { if (!offerable(value)) dismissFound(detail.jobId); }, () => {});
        if (typeof off === 'function') foundWatches.set(detail.jobId, off);
      } catch { /* not signed in: the row stays until Not now or the song is opened */ }
    }
  }

  function dropFound(predicate) {
    const f = found.peek();
    const gone = [...f].filter(([id, d]) => predicate(d, id)).map(([id]) => id);
    if (!gone.length) return;
    for (const id of gone) { foundWatches.get(id)?.(); foundWatches.delete(id); listedIds.delete(id); dismissedIds.add(id); }
    found.value = new Map([...f].filter(([id]) => !gone.includes(id)));
  }

  // ---- unapplied detections from before this session (D44: a reload, or finished while the app was closed):
  // one jobs.listUnappliedDetections subscription across every song, started once the library has loaded
  // (signed in). The query is reactive, so a row it drops was applied (or acted on) somewhere.
  let unappliedOff = null;
  let unappliedStarted = false;
  function applyUnapplied(rows) {
    if (destroyed) return;
    const list = (Array.isArray(rows) ? rows : []).filter(d => offerable(d) && d.jobId && d.songId);
    const ids = new Set(list.map(d => d.jobId));
    const stale = [...listedIds].filter(id => !ids.has(id));
    if (stale.length) {
      for (const id of stale) listedIds.delete(id);
      const f = found.peek();
      found.value = new Map([...f].filter(([id]) => !stale.includes(id)));
    }
    const openSong = store.stage.peek()?.songId ?? null;
    let next = null;
    for (const d of list) {
      if (dismissedIds.has(d.jobId) || found.peek().has(d.jobId) || next?.has(d.jobId)) continue;
      // Its song is open: the Stage offers it ("Bars found while you were away"), so it is not offered here.
      if (d.songId === openSong) { dismissedIds.add(d.jobId); continue; }
      next ??= new Map(found.peek());
      next.set(d.jobId, d);
      listedIds.add(d.jobId);
    }
    if (next) found.value = next;
  }
  disposers.push(effect(() => {
    const loaded = lib.loaded ? lib.loaded.value : true;
    if (unappliedStarted || !loaded) return;
    untracked(() => {
      if (typeof api.subscribeUnappliedDetections === 'function') {
        try {
          const off = api.subscribeUnappliedDetections(applyUnapplied, () => {});
          unappliedStarted = true;
          if (typeof off === 'function') unappliedOff = off;
        } catch { /* not signed in yet: tried again when the library loads again */ }
      } else if (typeof api.listUnappliedDetections === 'function') {
        unappliedStarted = true;
        Promise.resolve().then(() => api.listUnappliedDetections()).then(applyUnapplied, () => {});
      }
    });
  }));

  // ---- opening a song clears its ready mark and its found detection (the Stage offers it)
  disposers.push(effect(() => {
    const songId = store.stage.value?.songId ?? null;
    if (!songId) return;
    untracked(() => {
      if (readyIds.peek().has(songId)) {
        const next = new Set(readyIds.peek());
        next.delete(songId);
        readyIds.value = next;
      }
      dropFound(d => d.songId === songId);
    });
  }));

  // ---- a clock for "started 1:42 ago" and the ETA, only while something is live
  const hasLive = computed(() => (lib.jobs.value ?? []).some(j => isLiveStatus(j?.status))
    || (lib.uploads.value ?? []).some(u => read(u?.state) === 'uploading'));
  disposers.push(effect(() => {
    if (!hasLive.value) return undefined;
    untracked(() => { tick.value = now(); });
    const id = timer.set(() => { tick.value = now(); }, TICK_MS);
    return () => timer.clear(id);
  }));

  function dismissFound(jobId) {
    dropFound((_, id) => id === jobId);
  }

  /** Wraps an action: a failure becomes an error toast with the error copy's sentence. */
  const guarded = (fn, context = 'job') => async () => {
    try {
      return await fn();
    } catch (err) {
      notify(describeError(err, {context}).sentence, {tone: 'error'});
      return undefined;
    }
  };

  const refreshProcessor = () => { try { void desktop.refreshStatus?.(); } catch { /* not the desktop app */ } };

  function failureActions(failure, {retries = true} = {}) {
    const out = [];
    for (const [action, tone] of [[failure?.primary, 'primary'], [failure?.secondary, 'quiet']]) {
      if (!action) continue;
      const run = action.target === 'jobs.retry' || action.target === 'jobs.retryFast'
        ? async () => { await action.run(); if (retries) refreshProcessor(); }
        : action.run;
      out.push({label: action.label, target: action.target, tone, run: guarded(run)});
    }
    return out;
  }

  function detailsText(lines) {
    return lines.filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${v}`).join('\n');
  }

  function jobVM(job, ctx) {
    const kind = ['separate', 'beats', 'sections', 'import'].includes(job.kind) ? job.kind : 'separate';
    const song = job.songId ? ctx.songs.get(job.songId) ?? null : null;
    const meta = isObject(job.meta) ? job.meta : {};
    const sourceType = isObject(job.source) ? job.source.type : null;
    const metaTitle = str(meta.title);
    const songTitle = str(song?.title);
    const raw = str(sourceType === 'search' ? job.source.value : '') || str(job.label) || str(job.source?.value);
    const detection = kind === 'beats' || kind === 'sections';
    const title = (detection ? songTitle || metaTitle : metaTitle || songTitle) || (sourceType === 'upload' ? str(job.source?.filename) || raw : raw);
    const quoted = !metaTitle && !songTitle && kind === 'separate' && sourceType !== 'upload';
    const artist = str(meta.artist) || str(meta.uploader) || str(meta.channel) || str(song?.artist);
    const thumb = str(meta.thumbnail);
    const cover = (/^https:\/\//i.test(thumb) ? thumb : '') || str(song?.coverUrl) || null;
    const coverKey = cover ? null : str(meta.coverKey) || str(song?.coverKey) || null;
    const failed = job.status === 'error';
    const device = deviceFor(job.deviceId ?? null, ctx);
    const deviceName = device?.name ?? DEVICES.yourComputer;
    const failure = failed ? describeError(job, {context: 'job', song, device: deviceName, jobs: api, desktop, ...(router ? {router} : {})}) : null;
    const {stages, current} = stagesFor(kind, failed ? failedStage(job, failure.code) : job.stage, {sourceType});
    const setup = job.status === 'running' && kind === 'separate' && current === 'split' && settingUp(job, ctx.processor);
    const percent = job.status === 'running' && current !== 'finish' && current != null && !setup ? clampPct(job.percent) : null;
    const ahead = aheadOf(job, ctx.jobs);
    const resplit = kind === 'separate' && !!song;
    const local = !!device?.local;
    const startedAt = Number.isFinite(job.startedAt) ? job.startedAt : null;
    const samples = history.get(job.jobId)?.samples;
    const eta = job.status === 'running' && kind === 'separate' && current === 'split' && !setup ? estimateRemaining(samples, ctx.at) : null;
    const settings = kind === 'separate' ? settingsLine(job.settingsSummary) : null;
    let line, activity, rail = null;
    const actions = [];

    if (failed) {
      line = failure.sentence;
      activity = failure.sentence;
      actions.push(...failureActions(failure));
    } else if (job.status === 'queued') {
      if (device && !device.online) {
        line = LINES.waitingFor(device.name);
        activity = LINES.offlineOn(device.name);
      } else {
        line = ahead > 0 ? LINES.waitingAhead(ahead) : VERBS.waiting;
        activity = LINES.waitingOn(deviceName);
      }
      rail = {value: 0, striped: true};
    } else if (device && !device.online) {
      // Running on a computer that has gone offline: the job pauses there and resumes when it is back (D12).
      line = LINES.waitingFor(device.name);
      activity = LINES.pausedOn(device.name);
      rail = {value: percent != null ? percent / 100 : 0, striped: true};
    } else if (setup) {
      // A first-run download (spec §6.6): its own percent, no split percent and no ETA; the message says what.
      const pct = clampPct(job.percent);
      line = LINES.percent(VERBS.settingUp, pct);
      const parts = [LINES.on(VERBS.settingUp, deviceName)];
      if (startedAt != null) parts.push(LINES.started(formatElapsed(ctx.at - startedAt)));
      activity = parts.join(' · ');
      rail = {value: pct / 100, striped: false};
    } else {
      const verb = verbFor(kind, current, sourceType);
      line = percent != null ? LINES.percent(verb, percent) : verb;
      const etaCard = formatEta(eta, {style: 'card'});
      if (etaCard) line = LINES.withEta(line, etaCard);
      const parts = [LINES.on(verb, deviceName)];
      if (startedAt != null) parts.push(LINES.started(formatElapsed(ctx.at - startedAt)));
      const etaLong = formatEta(eta, {style: 'popover'});
      if (etaLong) parts.push(etaLong);
      activity = parts.join(' · ');
      rail = {value: percent != null ? percent / 100 : null, striped: false};
    }
    if (isLiveStatus(job.status)) actions.push({label: ACTIONS.cancel, tone: 'danger', run: guarded(() => api.cancel({jobId: job.jobId}))});

    const details = failure ? failure.details : detailsText([
      ['Job', job.jobId], ['Kind', kind], ['Status', job.status], ['Stage', job.stage], ['Progress', `${clampPct(job.percent)}%`],
      ['Source', job.source?.value ?? job.label], ['Device', device?.name], ['Attempts', job.attempts],
    ]);

    return {
      id: job.jobId, jobId: job.jobId, kind, status: job.status, songId: job.songId ?? null, title, quoted, artist, cover, coverKey,
      stages: stageStateList(stages, current, failed), current, percent, line, activity, rail, ahead, device,
      settingsLine: settings, message: isLiveStatus(job.status) ? str(job.message) || null : null, source: sourceLink(job.source),
      eta, startedAt, failure, detailsFirst: !!failure?.detailsFirst, setup, local, resplit, actions, details,
    };
  }

  function uploadVM(entry, ctx) {
    const state = read(entry.state);
    if (state !== 'uploading' && state !== 'error') return null;
    const progress = read(entry.progress) ?? {};
    const loaded = Math.max(0, Number(progress.loaded) || 0), total = Math.max(0, Number(progress.total) || 0);
    const name = str(entry.name) || str(entry.file?.name) || str(entry.filename);
    const title = str(entry.title) || name;
    const {stages, current} = stagesFor('upload');
    const device = deviceFor(entry.deviceId ?? null, ctx);
    const failed = state === 'error';
    const percent = !failed && total > 0 ? clampPct((loaded / total) * 100) : null;
    const remove = () => {
      if (typeof entry.dismiss === 'function') return entry.dismiss();
      lib.uploads.value = (lib.uploads.peek() ?? []).filter(e => e !== entry);
      return undefined;
    };
    let failure = null, line, activity, rail = null;
    const actions = [];
    if (failed) {
      failure = describeError(read(entry.error) ?? {code: 'unknown'}, {context: 'add', device: device?.name, desktop, ...(router ? {router} : {})});
      line = activity = failure.sentence;
      actions.push(...failureActions(failure, {retries: false}));
      actions.push({label: ACTIONS.dismiss, tone: 'quiet', run: guarded(async () => remove())});
    } else {
      line = total > 0 ? LINES.uploaded(formatMB(loaded), formatMB(total)) : VERBS.uploading;
      activity = line;
      rail = {value: total > 0 ? loaded / total : null, striped: false};
      actions.push({label: ACTIONS.cancel, tone: 'danger', run: guarded(async () => entry.cancel?.())});
    }
    const id = `upload:${entry.id ?? name}`;
    return {
      id, jobId: null, kind: 'upload', status: failed ? 'error' : 'running', songId: null, title, quoted: false, artist: '', cover: null,
      coverKey: null, stages: stageStateList(stages, current, failed), current, percent, line, activity, rail, ahead: 0, device,
      settingsLine: null, message: null, source: null, eta: null, startedAt: null, failure, detailsFirst: !!failure?.detailsFirst, setup: false,
      local: !!device?.local, resplit: false, actions,
      details: failure ? failure.details : detailsText([['Upload', name], ['Bytes', total ? `${loaded} of ${total}` : loaded]]),
    };
  }

  function foundVM(detail, ctx) {
    const song = ctx.songs.get(detail.songId) ?? null;
    const {stages} = stagesFor('beats', 'done');
    const title = str(song?.title) || str(detail.label);
    return {
      id: detail.jobId, jobId: detail.jobId, kind: 'beats', status: 'done', songId: detail.songId, title, quoted: false,
      artist: str(song?.artist), cover: str(song?.coverUrl) || null, coverKey: str(song?.coverUrl) ? null : str(song?.coverKey) || null,
      stages: stageStateList(stages, 'ready', false), current: 'ready', percent: null,
      line: LINES.found, activity: LINES.found, rail: null, ahead: 0, device: deviceFor(detail.deviceId ?? null, ctx), settingsLine: null,
      message: null, source: null, eta: null, startedAt: detail.startedAt ?? null, failure: null, detailsFirst: false, setup: false, local: false, resplit: false,
      actions: [
        {label: ACTIONS.openSong, tone: 'primary', run: guarded(async () => routerOf()?.navigate?.(`/s/${encodeURIComponent(detail.songId)}`))},
        {label: ACTIONS.notNow, tone: 'quiet', run: guarded(async () => { await api.markApplied({jobId: detail.jobId}); dismissFound(detail.jobId); })},
      ],
      details: detailsText([['Job', detail.jobId], ['Kind', 'beats'], ['Status', 'done'], ['Song', detail.songId]]),
    };
  }

  const items = computed(() => {
    historyVersion.value;
    const ctx = {
      at: tick.value, jobs: lib.jobs.value ?? [], songs: lib.songs.value ?? new Map(), devices: lib.devices.value ?? [],
      processor: store.processor.value, desktopAvailable: !!desktop.available,
    };
    const jobs = ctx.jobs.filter(j => j && j.jobId && (isLiveStatus(j.status) || j.status === 'error'));
    const failed = jobs.filter(j => j.status === 'error').sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).map(j => jobVM(j, ctx));
    const running = jobs.filter(j => j.status === 'running').map(j => jobVM(j, ctx));
    const queued = jobs.filter(j => j.status === 'queued').map(j => jobVM(j, ctx));
    const uploads = (lib.uploads.value ?? []).map(u => (u ? uploadVM(u, ctx) : null)).filter(Boolean);
    const live = new Set(jobs.map(j => j.jobId));
    const done = [...found.value.values()].filter(d => !live.has(d.jobId)).map(d => foundVM(d, ctx));
    return [...failed, ...uploads.filter(u => u.status === 'error'), ...running, ...uploads.filter(u => u.status !== 'error'), ...queued, ...done];
  });

  const chip = computed(() => {
    const list = items.value;
    const processor = store.processor.value;
    if (desktop.available && processor?.phase === 'offline') return {text: CHIP.offline, tone: 'danger', icon: 'wifi-off'};
    const live = list.filter(i => isLiveStatus(i.status) || (i.kind === 'upload' && i.status === 'running'));
    const failed = list.filter(i => i.status === 'error');
    const foundCount = list.filter(i => i.status === 'done').length;
    // One message (spec §2.1: `◐ 2 splitting`, `⚠ 1 failed` or `⦸ Processor offline`), the most urgent first.
    if (failed.length) return {text: CHIP.failed(failed.length), tone: 'warn', icon: 'alert-triangle'};
    if (live.length) {
      // "Splitting" only while every live job is a running split or upload; only queued ones are "waiting".
      const queued = live.filter(i => i.status === 'queued').length;
      const splits = !queued && live.every(i => i.kind === 'separate' || i.kind === 'upload');
      const text = queued === live.length ? CHIP.waiting(live.length) : splits ? CHIP.splitting(live.length) : CHIP.inProgress(live.length);
      return {text, tone: 'neutral', icon: 'loader'};
    }
    if (foundCount) return {text: CHIP.found(foundCount), tone: 'accent', icon: 'sparkles'};
    return null;
  });

  const KIND_RANK = {separate: 0, upload: 0, import: 1, beats: 2, sections: 2};
  const rank = vm => (isLiveStatus(vm.status) && vm.kind === 'separate' ? 0 : vm.status === 'error' ? 1 : 2 + (KIND_RANK[vm.kind] ?? 3));
  const bySong = computed(() => {
    const map = new Map();
    for (const vm of items.value) {
      if (!vm.songId || vm.status === 'done') continue;
      const held = map.get(vm.songId);
      if (!held || rank(vm) < rank(held)) map.set(vm.songId, vm);
    }
    return map;
  });

  const ready = computed(() => {
    const songs = lib.songs.value ?? new Map();
    return [...readyIds.value].map(id => songs.get(id)).filter(Boolean);
  });

  return {
    items, chip, bySong, ready, dismissFound,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const d of disposers.splice(0)) d();
      for (const off of foundWatches.values()) off();
      foundWatches.clear();
      unappliedOff?.();
      unappliedOff = null;
    },
  };
}

let shared = null;
/** The app's model, created on first use. */
export function sharedJobsModel() {
  shared ??= createJobsModel();
  return shared;
}

/** The app's model as an object (`jobsModel.ready` for the Stage's `1 ready` chip). */
export const jobsModel = Object.freeze({
  get items() { return sharedJobsModel().items; },
  get chip() { return sharedJobsModel().chip; },
  get bySong() { return sharedJobsModel().bySong; },
  get ready() { return sharedJobsModel().ready; },
  dismissFound: jobId => sharedJobsModel().dismissFound(jobId),
});

// ---------------------------------------------------------------------------------------------- views

const popoverOpen = signal(false);
let openHandle = null;
let chipButton = null;

/** A cover: the image when one is known (a signed key on demand), else a music glyph. */
function Cover({size = 40, sign = signKeys} = {}) {
  const img = h('img', {class: 'lib-job-cover-image', alt: '', attrs: {draggable: 'false', referrerpolicy: 'no-referrer'}});
  const glyph = h('span', {class: 'lib-job-cover-glyph', attrs: {'aria-hidden': 'true'}}, icon('music', {size: 20}));
  const el = h('span', {class: 'lib-job-cover', style: {'--lib-cover': `${size}px`}}, img, glyph);
  let shownKey = null, wanted = null;
  const show = url => {
    img.hidden = !url;
    glyph.hidden = !!url;
    if (url && img.getAttribute('src') !== url) img.setAttribute('src', url);
    if (!url) img.removeAttribute('src');
  };
  img.addEventListener('error', () => show(null));
  return {
    el,
    update({cover, coverKey}) {
      if (cover) { wanted = null; shownKey = null; show(cover); return; }
      if (!coverKey) { wanted = null; show(null); return; }
      if (coverKey === shownKey) return;
      wanted = coverKey;
      show(null);
      Promise.resolve(sign([coverKey])).then(urls => {
        if (wanted !== coverKey) return;
        shownKey = coverKey;
        show(urls?.[coverKey] ?? null);
      }, () => {});
    },
  };
}

let rowSeq = 0;

/** One popover row (spec §2.8). Returns the reconcileList entry {el, update, destroy}. */
function JobRow(initial, {clipboard = globalThis.navigator?.clipboard} = {}) {
  let vm = initial;
  const uid = `lib-job-${++rowSeq}`;
  const cover = Cover({size: 40});
  const title = h('p', {class: 'lib-job-title selectable', id: `${uid}-title`});
  const stepper = StageStepper({stages: [], label: STAGES.label, className: 'lib-job-stepper'});
  const activity = h('p', {class: 'lib-job-activity'});
  const ahead = h('p', {class: 'lib-job-ahead'});
  const settings = h('p', {class: 'lib-job-settings'});
  const message = h('p', {class: 'lib-job-message'});
  const sourceText = h('span', {class: 'lib-job-source-text'});
  const source = h('a', {class: 'lib-job-source', target: '_blank', rel: 'noopener noreferrer'}, sourceText);
  const actions = h('div', {class: 'lib-job-actions'});
  const pre = h('pre', {class: 'lib-job-details-text selectable', id: `${uid}-details`, tabIndex: 0});
  let copiedTimer = null;
  const copy = Button({label: ACTIONS.copy, icon: 'copy', variant: 'quiet', size: 'sm', onClick: async () => {
    try { await clipboard?.writeText?.(pre.textContent); } catch { /* the text stays selectable */ }
    copy.set({label: ACTIONS.copied, icon: 'check'});
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => copy.set({label: ACTIONS.copy, icon: 'copy'}), COPIED_MS);
  }});
  const detailsRegion = h('div', {class: 'lib-job-details', hidden: true, attrs: {role: 'region', 'aria-labelledby': `${uid}-title`}}, pre, copy.el);
  const detailsButton = Button({label: ACTIONS.details, variant: 'quiet', size: 'sm', className: 'lib-job-details-toggle',
    attrs: {'aria-expanded': 'false', 'aria-controls': `${uid}-details-region`}, onClick: () => toggleDetails()});
  detailsRegion.id = `${uid}-details-region`;
  const buttonRow = h('div', {class: 'lib-job-buttons'}, actions, detailsButton.el);
  const body = h('div', {class: 'lib-job-body'}, title, stepper.el, activity, ahead, settings, message, source, buttonRow, detailsRegion);
  const el = h('li', {class: 'lib-job', tabIndex: -1, attrs: {'aria-labelledby': `${uid}-title`}}, cover.el, body);

  function toggleDetails(open = detailsRegion.hidden) {
    detailsRegion.hidden = !open;
    detailsButton.el.setAttribute('aria-expanded', String(open));
  }

  const buttons = new Map();   // label → Button
  function renderActions() {
    reconcileList(actions, vm.actions, {
      key: a => a.label,
      create: a => {
        const b = Button({label: a.label, size: 'sm', variant: a.tone === 'primary' ? 'primary' : 'quiet', tone: a.tone === 'danger' ? 'danger' : undefined,
          className: 'lib-job-action', onClick: async () => {
            const action = vm.actions.find(x => x.label === a.label);
            if (!action || b.running) return;
            b.running = true;
            b.set({busy: true, disabled: true});
            try { await action.run(); } finally {
              b.running = false;
              if (b.el.isConnected) b.set({busy: false, disabled: false});
            }
          }});
        buttons.set(a.label, b);
        return {el: b.el, update: next => b.set({variant: next.tone === 'primary' ? 'primary' : 'quiet', tone: next.tone === 'danger' ? 'danger' : undefined}),
          destroy: () => { buttons.delete(a.label); b.destroy(); }};
      },
    });
  }

  const setText = (node, value) => {
    const t = value ?? '';
    if (node.textContent !== t) node.textContent = t;
    node.hidden = !t;
  };

  function update(next) {
    vm = next;
    el.dataset.jobId = vm.id;
    el.dataset.kind = vm.kind;
    el.dataset.status = vm.status;
    cover.update(vm);
    setText(title, vm.quoted ? quote(vm.title) : vm.title);
    stepper.set({stages: vm.stages.map(({id, label}) => ({id, label})), current: vm.current, percent: vm.percent, failed: vm.status === 'error'});
    setText(activity, vm.activity);
    if (vm.status === 'error') activity.dataset.tone = 'danger'; else delete activity.dataset.tone;
    // "started 1:42 ago" moves every second: masked in captures (§11.2).
    if (vm.status === 'running') activity.dataset.volatile = ''; else delete activity.dataset.volatile;
    setText(ahead, vm.status === 'queued' && vm.ahead > 0 ? LINES.ahead(vm.ahead) : '');
    setText(settings, vm.settingsLine);
    setText(message, vm.message);
    if (vm.source) {
      source.hidden = false;
      source.href = vm.source.url;
      sourceText.textContent = POPOVER.source(vm.source.label);
      source.setAttribute('aria-label', POPOVER.sourceName(vm.source.label));
    } else {
      source.hidden = true;
      source.removeAttribute('href');
    }
    if (pre.textContent !== vm.details) pre.textContent = vm.details ?? '';
    // A row whose primary is Details (spec §3.6, disk full) shows it first, as the primary button.
    detailsButton.set({variant: vm.detailsFirst ? 'primary' : 'quiet'});
    if (vm.detailsFirst && buttonRow.firstChild !== detailsButton.el) buttonRow.prepend(detailsButton.el);
    else if (!vm.detailsFirst && buttonRow.lastChild !== detailsButton.el) buttonRow.append(detailsButton.el);
    renderActions();
  }

  update(initial);
  return {
    el, update,
    destroy() {
      clearTimeout(copiedTimer);
      for (const b of buttons.values()) b.destroy();
      buttons.clear();
      stepper.destroy();
      copy.destroy();
      detailsButton.destroy();
    },
  };
}

/** The popover footer (spec §2.8): the desktop processor, or the paired computer on the web. */
function Footer({store, desktop, now}) {
  const text = h('p', {class: 'lib-jobs-footer-text'});
  const dot = h('span', {class: 'lib-jobs-footer-dot', attrs: {'aria-hidden': 'true'}});
  const restart = Button({label: POPOVER.restart, icon: 'refresh-cw', size: 'sm', variant: 'secondary', className: 'lib-jobs-footer-action', onClick: async () => {
    restart.set({busy: true, disabled: true});
    try { await desktop.restartProcessor(); } catch (err) {
      toast(describeError(err, {context: 'job'}).sentence, {tone: 'error'});
    } finally { restart.set({busy: false, disabled: false}); }
  }});
  const retry = Button({label: POPOVER.tryAgain, size: 'sm', variant: 'secondary', className: 'lib-jobs-footer-action', onClick: async () => {
    retry.set({busy: true, disabled: true});
    try { await desktop.retryPairing(); } finally { retry.set({busy: false, disabled: false}); }
  }});
  const download = h('a', {class: 'lib-jobs-footer-link', href: '/download', target: '_blank', rel: 'noopener',
    attrs: {'aria-label': POPOVER.getDesktopName}}, POPOVER.getDesktop);
  const el = h('footer', {class: 'lib-jobs-footer'}, dot, text, restart.el, retry.el, download);
  const clock = signal(now());
  const timer = setInterval(() => { clock.value = now(); }, 30_000);

  const off = effect(() => {
    let state = 'ok', label = '', show = {restart: false, retry: false, download: false};
    if (desktop.available) {
      const p = store.processor.value ?? {};
      const name = str(p.name);
      if (p.phase === 'ready') label = name ? POPOVER.ready(name) : POPOVER.readyUnnamed;
      else if (p.phase === 'offline') { label = POPOVER.offline; state = 'off'; show.restart = true; }
      else if (p.phase === 'pair-failed') { label = p.message || processorLabel(p) || ''; state = 'off'; show.retry = true; }
      else {
        const base = processorLabel(p) ?? '';
        label = name && base ? POPOVER.withName(base, name) : base;
        state = p.phase === 'busy' ? 'ok' : 'wait';
      }
    } else {
      const at = clock.value;
      const devices = (store.library.devices.value ?? []).filter(d => d && !d.revoked);
      const online = devices.find(d => isOnline(d, at));
      if (online) label = POPOVER.onlineDevice(str(online.name) || DEVICES.yourComputer);
      else if (devices.length) { label = POPOVER.offlineDevice(str(devices[0].name) || DEVICES.yourComputer); state = 'off'; }
      else { label = POPOVER.noDevice; state = 'none'; show.download = true; }
    }
    text.textContent = label;
    el.dataset.state = state;
    dot.hidden = state === 'none';
    restart.el.hidden = !show.restart;
    retry.el.hidden = !show.retry;
    download.hidden = !show.download;
  });
  return {el, destroy() { off(); clearInterval(timer); restart.destroy(); retry.destroy(); }};
}

/** A usable anchor: the given element when it is on screen, else the chip, else the top-right corner. */
function anchorFor(anchor) {
  const visible = el => !!el && typeof el === 'object' && el.nodeType === 1 && el.isConnected && (el.getClientRects?.().length ?? 0) > 0;
  if (anchor && typeof anchor === 'object' && anchor.nodeType !== 1 && Number.isFinite(anchor.x)) return anchor;
  if (visible(anchor)) return anchor;
  if (visible(chipButton?.el)) return chipButton.el;
  const w = globalThis.innerWidth ?? 1024;
  return {x: Math.max(0, w - 24), y: 56};
}

function focusRow(list, jobId) {
  if (!jobId) return false;
  const row = [...list.children].find(li => li.dataset.jobId === jobId || li.dataset.jobId === `upload:${jobId}`);
  if (!row) return false;
  row.focus({preventScroll: true});
  row.scrollIntoView?.({block: 'nearest'});
  return true;
}

/**
 * Opens the Jobs popover (non-modal, D36). A second call while it is open moves focus to `focusJobId`.
 * @param {{anchor?: Element|{x, y}, focusJobId?: string|null, model?, store?, desktop?, now?}} [opts]
 */
export function openJobsPopover({anchor = null, focusJobId = null, model = null, store = appStore, desktop = appDesktop, now = clockNow} = {}) {
  if (openHandle?.open) {
    openHandle.focus(focusJobId);
    return openHandle;
  }
  const m = model ?? sharedJobsModel();
  const headingId = `lib-jobs-title-${++detailSeq}`;
  const heading = h('h2', {class: 'lib-jobs-title', id: headingId}, POPOVER.title);
  const list = h('ul', {class: 'lib-jobs-list', attrs: {'aria-label': POPOVER.list}});
  const empty = h('div', {class: 'lib-jobs-empty', hidden: true}, h('p', {class: 'lib-jobs-empty-title'}, POPOVER.empty),
    h('p', {class: 'lib-jobs-empty-hint'}, POPOVER.emptyHint));
  const footer = Footer({store, desktop, now});
  const content = h('div', {class: 'lib-jobs'}, heading, list, empty, footer.el);
  const stopWatch = desktop.available ? desktop.watchStatus() : () => {};
  let popover = null;

  const renderRows = effect(() => {
    const vms = m.items.value;
    untracked(() => {
      // A row that leaves while it holds focus (Cancel, Not now) hands focus to the row now in its place.
      const doc = list.ownerDocument;
      const held = list.contains(doc.activeElement) ? [...list.children].indexOf(doc.activeElement.closest('.lib-job')) : -1;
      reconcileList(list, vms, {key: vm => vm.id, create: vm => JobRow(vm)});
      if (held >= 0 && !list.contains(doc.activeElement)) {
        const next = list.children[Math.min(held, list.children.length - 1)];
        (next ?? popover?.el)?.focus({preventScroll: true});
      }
      list.hidden = vms.length === 0;
      empty.hidden = vms.length > 0;
      popover?.update();
    });
  });

  popover = Popover({
    anchor: anchorFor(anchor), content, placement: 'bottom', align: 'end', labelledBy: headingId, className: 'lib-jobs-popover',
    width: 'min(440px, calc(100vw - 2 * var(--s4)))', autofocus: false,
    onClose: () => cleanup(),
  });
  popoverOpen.value = true;

  function cleanup() {
    if (!handle.open) return;
    handle.open = false;
    renderRows();
    stopWatch();
    footer.destroy();
    reconcileList(list, [], {key: vm => vm.id, create: vm => JobRow(vm)});
    if (openHandle === handle) openHandle = null;
    popoverOpen.value = false;
  }

  const handle = {
    open: true,
    el: popover.el,
    focus(jobId) {
      if (!focusRow(list, jobId)) heading.closest('.ui-popover')?.focus?.({preventScroll: true});
    },
    close(reason = 'close') { popover.close(reason); },
  };
  openHandle = handle;
  // Focus goes to the asked-for row, else the first row, else the popover itself.
  if (!focusRow(list, focusJobId) && !focusRow(list, list.firstElementChild?.dataset.jobId)) popover.el.focus({preventScroll: true});
  return handle;
}

/** Closes the Jobs popover when it is open. */
export function closeJobsPopover(reason = 'close') {
  openHandle?.close(reason);
}

/**
 * The Jobs chip in the top bar's slot (spec §2.1): present only when there is something to show; a click
 * opens (or closes) the popover.
 * @param {Element} slot  topbar.jobsSlot
 * @param {{model?, store?, desktop?}} [opts]
 */
export function mountJobsChip(slot, {model = null, store = appStore, desktop = appDesktop, now = clockNow} = {}) {
  const m = model ?? sharedJobsModel();
  // Whether the popover was open when the chip was pressed: read before the popover's outside-press
  // dismissal (a capture listener on the document) closes a popover anchored elsewhere (a card).
  let pressedOpen = null, pressTimer = null;
  const view = slot.ownerDocument?.defaultView ?? globalThis;
  const onPress = event => {
    if (!button.el.contains(event.target)) return;
    pressedOpen = !!openHandle?.open;
  };
  const onRelease = () => {
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { pressedOpen = null; }, 0);
  };
  view.addEventListener?.('pointerdown', onPress, true);
  view.addEventListener?.('pointerup', onRelease, true);
  view.addEventListener?.('pointercancel', onRelease, true);
  const button = Button({label: CHIP.idle, icon: 'loader', variant: 'quiet', className: 'lib-jobs-chip',
    attrs: {'aria-haspopup': 'dialog', 'aria-expanded': 'false'},
    onClick: () => {
      const wasOpen = pressedOpen ?? !!openHandle?.open;
      pressedOpen = null;
      if (wasOpen) closeJobsPopover('close');
      else openJobsPopover({anchor: button.el, model: m, store, desktop, now});
    }});
  chipButton = button;
  const off = effect(() => {
    const chip = m.chip.value;
    const open = popoverOpen.value;
    button.el.setAttribute('aria-expanded', String(open));
    if (!chip && !open) {
      if (button.el.parentNode === slot) slot.replaceChildren();
      return;
    }
    const next = chip ?? {text: CHIP.idle, tone: 'neutral', icon: 'list'};
    button.set({label: next.text, icon: next.icon, tone: next.tone});
    if (button.el.parentNode !== slot) slot.replaceChildren(button.el);
  });
  return {
    el: button.el,
    destroy() {
      off();
      clearTimeout(pressTimer);
      view.removeEventListener?.('pointerdown', onPress, true);
      view.removeEventListener?.('pointerup', onRelease, true);
      view.removeEventListener?.('pointercancel', onRelease, true);
      if (chipButton === button) chipButton = null;
      button.destroy();
    },
  };
}
