// Error copy (architecture §2.10, spec §3.6): a ConvexError code (§6.1), a job
// errorCode (§6.1, set by the companion) or a renderer code → one sentence, at
// most two actions, and the raw text for Details.
//
//   describeError(input, {context, song?, device?, storage?, router?, jobs?, desktop?})
//     → {code, sentence, primary?, secondary?, details, detailsFirst}
//
// input is an ApiError ({code, message, data}), a job ({jobId, errorCode, error,
// retryAt?, attempts?, meta?, source?}) or anything thrown. Actions are
// {label, target, run}: `target` names the §2.10 action target (TARGETS in
// error-copy.copy.js) and `run()` performs it, returning a promise. Job actions
// appear only when a job id is known; "Restart processor" only in the desktop app.
//
// Dependencies are resolved when an action runs, so this module stays a pure
// helper (commands modules may import it, D46): `router` defaults to the
// registry's 'router' provider, `jobs` to src/api/jobs.js and `desktop` to
// src/app/desktop.js, each loaded on demand.
//
// Job rows stored before job error codes existed have no errorCode; their raw
// text is classified once here (legacyJobCode), so old failures still read right.

import {LABELS, TARGETS, ROUTES, ROWS, SENTENCES, UNKNOWN_BY_CONTEXT, NO_DETAILS} from './error-copy.copy.js';
import {registry} from './commands.js';

export {LABELS, TARGETS, ROWS, SENTENCES};

export const CONTEXTS = Object.freeze(['add', 'job', 'resplit', 'load', 'save', 'share', 'detect']);

/** Renderer-side codes (no ConvexError carries them). */
export const RENDERER_CODES = Object.freeze(['processor_offline', 'codec', 'offline']);

/** Codes the companion's /resolve and /search answer with (§6.10 CPA), besides job codes. */
export const LOOKUP_CODES = Object.freeze(['timeout', 'invalid']);

const LEGACY_RULES = [
  [/sign in to confirm|not a bot|bot check/i, 'bot_check'],
  [/private video|video unavailable|is not available|not available in your country|has been removed|members-only|account .* terminated/i, 'unavailable'],
  [/no space left on device|ENOSPC|errno 28/i, 'disk_full'],
  [/cloud library is full|cloud storage is currently full|storage is full/i, 'storage_full'],
  [/export-only mode|account is suspended/i, 'account_paused'],
  [/original file (is not on|unavailable locally)|legacy files missing/i, 'source_missing'],
  [/no audio could be downloaded|could not resolve this spotify link/i, 'not_found'],
  [/sync upload failed/i, 'sync_failed'],
  [/beatnet/i, 'beats_unavailable'],
  [/out of memory|memoryerror|killed|missing stem/i, 'separation_failed'],
];

/** The job code for a stored job row without `errorCode` (rows from before §6.1), from its raw text. */
export function legacyJobCode(error) {
  const text = String(error ?? '');
  for (const [re, code] of LEGACY_RULES) if (re.test(text)) return code;
  return 'unknown';
}

const isObject = v => v !== null && typeof v === 'object';

/** Splits the input into {kind: 'job'|'api', code, job, data, raw}. */
function normalize(input) {
  if (!isObject(input)) return {kind: 'api', code: 'unknown', job: null, data: {}, raw: input == null ? '' : String(input)};
  const looksLikeJob = !(input instanceof Error) && ('errorCode' in input || 'jobId' in input || ('error' in input && 'status' in input));
  if (looksLikeJob) {
    const code = typeof input.errorCode === 'string' && input.errorCode ? input.errorCode : legacyJobCode(input.error);
    return {kind: 'job', code, job: input, data: isObject(input.data) ? input.data : {}, raw: input.error ?? ''};
  }
  const code = typeof input.code === 'string' && input.code ? input.code : 'unknown';
  return {kind: 'api', code, job: null, data: isObject(input.data) ? input.data : {}, raw: input.message ?? ''};
}

const jobIdOf = job => job?.jobId ?? job?.id ?? job?._id ?? null;

const gb = bytes => (bytes / 1e9).toFixed(1);

function storageSentence(data, storage) {
  const used = data.usedBytes ?? storage?.usedBytes;
  const limit = data.limitBytes ?? storage?.limitBytes;
  if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
    return ROWS.storageFull.sentence.replace('{used}', gb(used)).replace('{limit}', gb(limit));
  }
  return ROWS.storageFull.sentenceNoNumbers;
}

const withDevice = (template, name) => template.replace('{device}', typeof name === 'string' && name.trim() ? name.trim() : SENTENCES.otherDevice);

/**
 * The copy for a code, before binding: {sentence, primary?, secondary?, details?}
 * with primary/secondary as LABELS values. Pure; exported for the table test.
 */
export function copyFor(code, {kind = 'api', context = 'job', retryAt = null, data = {}, storage = null, device = null} = {}) {
  const row = key => ({sentence: ROWS[key].sentence, primary: ROWS[key].primary, secondary: ROWS[key].secondary, details: !!ROWS[key].details});
  const plain = (sentence, primary, secondary) => ({sentence, primary, secondary, details: false});
  const isJob = kind === 'job';
  const unknown = UNKNOWN_BY_CONTEXT[context] ?? ROWS.unknown.sentence;
  switch (code) {
    // Job codes (§6.1, companion and Python).
    case 'bot_check':
      if (isJob && retryAt != null) return row('botCheckPending');
      return isJob ? row('botCheckBlocked') : plain(ROWS.botCheckBlocked.sentence, LABELS.uploadInstead);
    case 'unavailable':
      return isJob ? row('unavailable') : plain(ROWS.unavailable.sentence, LABELS.uploadInstead);
    case 'not_found':
      if (isJob) return plain(SENTENCES.notFound, LABELS.searchAnother, LABELS.dismiss);
      if (context === 'add') return plain(SENTENCES.notFound, LABELS.uploadInstead);
      return plain(context === 'share' ? SENTENCES.missingShare : SENTENCES.missing);
    case 'unreadable':
      return row('unreadable');
    case 'source_missing':
      return plain(SENTENCES.sourceMissing, LABELS.chooseFile, LABELS.dismiss);
    case 'disk_full':
      return row('diskFull');
    case 'separation_failed':
      return row('separationFailed');
    case 'storage_full':
    case 'storage_full_user':
      return {...row('storageFull'), sentence: storageSentence(data, storage)};
    case 'account_paused':
    case 'account_export_only':
      return row('accountPaused');
    case 'sync_failed':
      return plain(SENTENCES.syncFailed, LABELS.tryAgain, LABELS.dismiss);
    case 'beats_unavailable':
      return plain(SENTENCES.beatsUnavailable, LABELS.dismiss);
    case 'playlist':
      return plain(SENTENCES.playlist, LABELS.dismiss);
    // Renderer codes.
    case 'processor_offline':
      return row('processorOffline');
    case 'codec':
      return plain(SENTENCES.codec);
    case 'offline':
      return plain(SENTENCES.offline);
    // Lookup codes (companion /resolve, /search).
    case 'timeout':
      return plain(SENTENCES.lookupTimeout);
    case 'invalid':
      return plain(context === 'add' ? SENTENCES.lookupInvalid : SENTENCES.invalid);
    // ConvexError codes (§6.1).
    case 'not_signed_in':
      return plain(SENTENCES.notSignedIn);
    case 'account_suspended':
      return plain(SENTENCES.suspended);
    case 'not_owner':
      return plain(SENTENCES.notOwner);
    case 'device_unpaired':
      return plain(SENTENCES.deviceUnpaired, LABELS.restartProcessor);
    case 'device_revoked_admin':
      return plain(SENTENCES.deviceRevoked);
    case 'device_other_account':
      return plain(SENTENCES.deviceOtherAccount);
    case 'device_limit':
      return plain(SENTENCES.deviceLimit);
    case 'queue_full':
      return plain(SENTENCES.queueFull);
    case 'storage_full_app':
      return plain(SENTENCES.appStorageFull, isJob ? LABELS.tryAgain : undefined, isJob ? LABELS.dismiss : undefined);
    case 'resplit_no_source':
      return plain(SENTENCES.resplitNoSource);
    case 'resplit_wrong_device':
      return plain(withDevice(SENTENCES.resplitWrongDevice, data.deviceName ?? data.device ?? device));
    case 'retry_wrong_device':
      return plain(withDevice(SENTENCES.retryWrongDevice, data.deviceName ?? data.device ?? device), isJob ? LABELS.dismiss : undefined);
    case 'job_live':
      return plain(SENTENCES.jobLive);
    case 'job_not_failed':
      return plain(SENTENCES.jobNotFailed);
    case 'practice_too_large':
      return plain(SENTENCES.practiceTooLarge);
    case 'setlist_limit':
      return plain(SENTENCES.setlistLimit);
    case 'setlist_full':
      return plain(SENTENCES.setlistFull);
    case 'pins_full':
      return plain(SENTENCES.pinsFull);
    case 'lookup_unavailable':
      return plain(SENTENCES.lookupUnavailable, context === 'add' ? LABELS.uploadInstead : undefined);
    case 'lookup_busy':
      return plain(SENTENCES.lookupBusy);
    case 'artwork_expired':
      return plain(SENTENCES.artworkExpired);
    default:
      // 'unknown' and anything unrecognised.
      return isJob ? {...row('unknown'), sentence: unknown} : plain(unknown);
  }
}

function searchQuery(job, song) {
  const q = job?.meta?.title ?? song?.title ?? (job?.source?.type === 'upload' ? null : job?.source?.value) ?? job?.label ?? '';
  return String(q ?? '').trim();
}

// The jobs API (BK2) is resolved by path, like the views (D2): loaded only when an
// action runs, so this module stays free of network code.
const JOBS_API = import.meta.glob('../api/jobs.js');

/** Resolves the dependencies an action needs, at run time. */
function deps(options) {
  return {
    router() {
      if (options.router) return options.router;
      try { return registry.context().router ?? null; } catch { return null; }
    },
    async jobs() {
      if (options.jobs) return options.jobs;
      const load = JOBS_API['../api/jobs.js'];
      if (!load) throw new Error('error-copy: src/api/jobs.js is not built');
      return load();
    },
    async desktop() {
      if (options.desktop) return options.desktop;
      return (await import('./desktop.js')).desktop;
    },
  };
}

function desktopAvailable(options) {
  if (options.desktop) return !!options.desktop.available;
  return !!globalThis.window?.woodshedDesktop;
}

function navigate(d, path, state) {
  const router = d.router();
  if (router?.navigate) { router.navigate(path, state ? {state} : {}); return; }
  globalThis.location?.assign?.(path);
}

/** Binds a label to its target for this error, or null when it cannot run here. */
function bind(label, {jobId, job, song, options}) {
  if (!label) return null;
  const target = TARGETS[label];
  const d = deps(options);
  const action = run => ({label, target, run});
  switch (target) {
    case 'jobs.retry':
      return jobId ? action(async () => (await d.jobs()).retry({jobId})) : null;
    case 'jobs.retryFast':
      return jobId ? action(async () => (await d.jobs()).retry({jobId, preset: 'fast'})) : null;
    case 'jobs.dismiss':
      return jobId ? action(async () => (await d.jobs()).dismiss({jobId})) : null;
    case 'add.search': {
      const q = searchQuery(job, song);
      const path = q ? `${ROUTES.add}?q=${encodeURIComponent(q)}` : ROUTES.add;
      // The Add sheet dismisses the failed job once the new one is submitted.
      return action(async () => navigate(d, path, jobId ? {dismissJobId: jobId} : undefined));
    }
    case 'add.pick':
      return action(async () => navigate(d, ROUTES.pick));
    case 'processor.restart':
      return desktopAvailable(options) ? action(async () => (await d.desktop()).restartProcessor()) : null;
    case 'settings.plan':
      return action(async () => navigate(d, ROUTES.plan));
    default:
      throw new Error(`error-copy: "${label}" has no action target`);
  }
}

/**
 * The sentence, actions and Details for an error (§2.10).
 * @param {object|string|Error} input  ApiError, job row, or anything thrown
 * @param {{context?: string, song?: object, device?: string, storage?: {usedBytes, limitBytes},
 *          router?: object, jobs?: object, desktop?: object}} [options]
 */
export function describeError(input, options = {}) {
  const context = CONTEXTS.includes(options.context) ? options.context : 'job';
  const {kind, code, job, data, raw} = normalize(input);
  const copy = copyFor(code, {kind, context, retryAt: job?.retryAt ?? null, data, storage: options.storage, device: options.device});
  const ctx = {jobId: jobIdOf(job), job, song: options.song ?? null, options};
  let primary = bind(copy.primary, ctx);
  let secondary = bind(copy.secondary, ctx);
  // A row whose spec primary is Details keeps its secondary in place; otherwise a
  // secondary whose primary cannot run here (no job, not desktop) moves up.
  if (!primary && secondary && !copy.details) { primary = secondary; secondary = null; }
  const rawText = String(raw ?? '').trim();
  const out = {code, sentence: copy.sentence, details: rawText || (code !== 'unknown' ? code : NO_DETAILS), detailsFirst: copy.details};
  if (primary) out.primary = primary;
  if (secondary) out.secondary = secondary;
  return out;
}
