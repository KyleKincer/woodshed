// File uploads for the Add sheet (architecture §2.16, spec §3.2 and §3.4): each file goes to the local processor
// with real progress (XHR POST /upload through src/js/companion.js uploadXHR), and only then becomes a job
// (jobs.createSeparation). Canceling before the job exists never creates it: the S1 bug of 1.9, where the
// in-flight upload still queued the song after its card was removed, is gone.
//
//   startUploads(files, {settings, deviceId?, title?, titles?}) → UploadHandle[]
//       one batch: the processor's device id is fetched once (requireCompanion) unless the caller passes it, and
//       the files upload one after another in the order given (a file waiting for its turn is already
//       'uploading', at 0 bytes), so their jobs queue in that order too. `title` overrides a single file's title; `titles` (array or Map by file) per file.
//   startUpload(file, {settings, deviceId, title?}) → UploadHandle      a batch of one
//   uploadDevice() → Promise<deviceId>   the paired processor's device id, rejecting with a mapped error
//   uploadError(error) → {code, message, data, raw}|null                 the describeError input; null = canceled
//
// UploadHandle = {id, name, title, file, deviceId, progress: ReadonlySignal<{loaded, total}>,
//                 state: ReadonlySignal<'uploading'|'queued'|'error'|'canceled'>, error: ReadonlySignal<…|null>,
//                 jobId, promise, cancel() → Promise<boolean>, retry() → Promise, dismiss()}
//   state     'uploading' until the job exists, then 'queued' (the job is queued on the processor and its Jobs row
//             takes over); 'error' keeps the entry until dismissed or retried; 'canceled' removes it.
//   promise   resolves {jobId} once the job exists, null when canceled; rejects with the mapped error
//             (a handler is attached, so an unawaited failure is not reported as unhandled). retry() replaces it.
//   cancel()  queued or uploading: aborts, no job is created; while createSeparation is in flight, the job it
//             returns is canceled at once; queued: jobs.cancel({jobId}) (the Add toast's Undo, spec §3.2).
//   retry()   a failed upload uploads the same file again (a local failure has no job to retry, S2).
//   dismiss() removes a failed or canceled entry.
//
// Every live handle is an entry of store.library.uploads (read by the Jobs model, LB1b) from the moment it is
// started until its job exists, it is canceled or it is dismissed; a failed one stays until dismissed or retried.

import {readonly, signal, store} from '../app/store.js';
import * as jobs from '../api/jobs.js';
import {requireCompanion, uploadXHR} from '../js/companion.js';

/** The companion refuses bodies over 1 GB (companion/server.mjs /upload); refuse them before sending a byte. */
export const MAX_UPLOAD_BYTES = 1_000_000_000;
/** createSeparation limits (convex/jobs.ts LABEL_MAX, FILENAME_MAX, META_TEXT_MAX). */
const LABEL_MAX = 500;
const FILENAME_MAX = 500;
const TITLE_MAX = 300;

export const COPY = Object.freeze({
  tooLarge: 'This file is larger than 1 GB, the most Woodshed can add.',
});

let seq = 0;

// ---------------------------------------------------------------- errors

const MESSAGE_RULES = [
  [/no space left on device|\bENOSPC\b|errno 28/i, 'disk_full'],
  [/pair the companion|connect this computer.s companion/i, 'processor_offline'],
  [/disconnected by an administrator/i, 'device_revoked_admin'],
];

/**
 * The describeError input for an upload failure (§2.10, context 'add'), or null when it was a cancel.
 * Companion and API errors keep their code; the companion's uncoded 400s are read by message (a full disk,
 * an unpaired or revoked processor). The result is a plain {code, message, data, raw}.
 */
export function uploadError(error) {
  if (error == null) return {code: 'unknown', message: '', data: {}, raw: error};
  if (error?.code === 'aborted' || error?.name === 'AbortError') return null;
  const message = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : '';
  const data = error && typeof error.data === 'object' && error.data !== null ? error.data : {};
  let code = typeof error?.code === 'string' && error.code ? error.code : 'unknown';
  if (code === 'unknown') {
    const rule = MESSAGE_RULES.find(([re]) => re.test(message));
    if (rule) code = rule[1];
  }
  return {code, message, data, raw: error};
}

/** The paired processor's device id (desktop only); rejects with a mapped error. */
export async function uploadDevice() {
  try {
    return await requireCompanion();
  } catch (error) {
    throw uploadError(error) ?? {code: 'processor_offline', message: '', data: {}, raw: error};
  }
}

// ---------------------------------------------------------------- the uploads list

function addEntry(handle) {
  const list = store.library.uploads;
  const current = list.peek() ?? [];
  if (!current.includes(handle)) list.value = [...current, handle];
}

function removeEntry(handle) {
  const list = store.library.uploads;
  const current = list.peek() ?? [];
  if (current.includes(handle)) list.value = current.filter(entry => entry !== handle);
}

// ---------------------------------------------------------------- handles

const clean = (text, max) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const fileName = file => (typeof file?.name === 'string' && file.name ? file.name : 'upload');

/**
 * One upload. `turn` is the promise the batch hands out: it resolves when the previous file has finished
 * uploading (or ended), so this file may start. `device()` resolves the batch's device id.
 */
function createHandle(file, {settings, title, device, turn}) {
  const name = fileName(file);
  const total = Math.max(0, Number(file?.size) || 0);
  const progress = signal({loaded: 0, total}, {equals: (a, b) => a.loaded === b.loaded && a.total === b.total});
  const state = signal('uploading');
  const error = signal(null);
  const titleOverride = clean(title, TITLE_MAX);
  const device$ = signal(null);   // read through a getter, so a Jobs row picks up the device line when it is known
  let jobId = null;
  let controller = null;
  let canceled = false;
  let creating = false;
  let attempt = 0;
  let retrying = false;       // a retry asks for the device again if the batch's lookup failed
  let settle = null;          // resolves the current attempt's promise
  let release = () => {};     // lets the next file of the batch start

  const handle = {
    id: `upload-${++seq}`,
    name,
    title: titleOverride || null,
    file,
    get deviceId() { return device$.value; },
    get jobId() { return jobId; },
    progress: readonly(progress),
    state: readonly(state),
    error: readonly(error),
    promise: null,
    cancel,
    retry,
    dismiss,
  };

  function fail(mapped, run) {
    error.value = mapped;
    state.value = 'error';
    run.reject(mapped);
  }

  async function attemptUpload(run, wait) {
    try {
      await wait;
      if (run.stale()) return;
      if (total > MAX_UPLOAD_BYTES) {
        fail({code: 'unknown', message: COPY.tooLarge, data: {bytes: total, limit: MAX_UPLOAD_BYTES}, raw: null}, run);
        return;
      }
      let id;
      try {
        id = await device(retrying);
      } catch (deviceError) {
        if (!run.stale()) fail(uploadError(deviceError) ?? {code: 'processor_offline', message: '', data: {}, raw: deviceError}, run);
        return;
      }
      if (run.stale()) return;
      device$.value = id;
      controller = new AbortController();
      progress.value = {loaded: 0, total};
      let uploaded;
      try {
        uploaded = await uploadXHR(file, {
          signal: controller.signal,
          onProgress: ({loaded, total: size}) => {
            if (run.stale()) return;
            const all = Number(size) > 0 ? Number(size) : total;
            progress.value = {loaded: Math.min(Math.max(0, Number(loaded) || 0), all || Infinity), total: all};
          },
        });
      } catch (uploadFailure) {
        if (run.stale()) return;
        const mapped = uploadError(uploadFailure);
        if (mapped) fail(mapped, run);
        return;
      } finally {
        controller = null;
        release();          // the next file may upload while this one becomes a job
      }
      if (run.stale()) return;
      creating = true;
      let created;
      try {
        created = await jobs.createSeparation({
          source: {type: 'upload', value: uploaded.id, filename: name.slice(0, FILENAME_MAX)},
          deviceId: id,
          settings,
          label: name.slice(0, LABEL_MAX),
          ...(titleOverride ? {meta: {title: titleOverride}} : {}),
        });
      } catch (createFailure) {
        creating = false;
        if (canceled) return;
        fail(uploadError(createFailure) ?? {code: 'unknown', message: '', data: {}, raw: createFailure}, run);
        return;
      }
      creating = false;
      jobId = created?.jobId ?? null;
      if (canceled) {
        // Canceled while the job was being created: the job must not run (S1).
        if (jobId) await jobs.cancel({jobId}).catch(() => false);
        return;
      }
      state.value = 'queued';
      removeEntry(handle);
      run.resolve({jobId});
    } finally {
      release();
    }
  }

  /** Starts an attempt; `wait` is the batch turn (the first attempt) or nothing (a retry). */
  function begin(wait) {
    const mine = ++attempt;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => {});
    const run = {
      stale: () => canceled || attempt !== mine,
      resolve: value => resolve(value),
      reject: reason => reject(reason),
    };
    settle = resolve;
    handle.promise = promise;
    error.value = null;
    progress.value = {loaded: 0, total};
    state.value = 'uploading';
    addEntry(handle);
    attemptUpload(run, wait);
    return promise;
  }

  async function cancel() {
    const now = state.peek();
    if (now === 'queued') {
      if (!jobId) return false;
      try { return (await jobs.cancel({jobId})) !== false; } catch { return false; }
    }
    if (now === 'canceled') { removeEntry(handle); return false; }
    if (now === 'error') { dismiss(); return false; }
    // The batch's next file starts once this attempt has unwound (its upload aborted, or its turn come).
    canceled = true;
    controller?.abort();
    state.value = 'canceled';
    removeEntry(handle);
    settle?.(null);
    return true;
  }

  function retry() {
    if (state.peek() !== 'error') return handle.promise;
    retrying = true;
    return begin(undefined);
  }

  function dismiss() {
    const now = state.peek();
    if (now === 'uploading' || creating) return;
    removeEntry(handle);
  }

  // The first attempt waits for its turn in the batch; the batch learns when this file's upload is over.
  let releaseTurn;
  const turnDone = new Promise(res => { releaseTurn = res; });
  release = () => { release = () => {}; releaseTurn(); };
  begin(turn);
  return {handle, turnDone};
}

/**
 * Starts a batch of uploads (spec §3.2: the files confirmed in the Add sheet). The device id is fetched once for
 * the whole batch unless `deviceId` is passed; files upload one at a time, in order.
 * @param {Iterable<File>} files
 * @param {{settings: object, deviceId?: string, title?: string, titles?: Array<string>|Map<File, string>}} options
 * @returns {UploadHandle[]}
 */
export function startUploads(files, {settings, deviceId, title, titles} = {}) {
  const list = [...(files ?? [])].filter(Boolean);
  if (!list.length) return [];
  let pending = null, failed = false;
  const device = (fresh = false) => {
    if (deviceId) return Promise.resolve(deviceId);
    // Fetched once per batch; a retry after a failed lookup (the processor restarted, say) asks again.
    if (fresh && failed) { pending = null; failed = false; }
    pending ??= uploadDevice().catch(failure => { failed = true; throw failure; });
    return pending;
  };
  const titleFor = (file, i) => {
    if (list.length === 1 && typeof title === 'string') return title;
    if (titles instanceof Map) return titles.get(file);
    if (Array.isArray(titles)) return titles[i];
    return undefined;
  };
  const handles = [];
  let turn = Promise.resolve();
  list.forEach((file, i) => {
    const {handle, turnDone} = createHandle(file, {settings, title: titleFor(file, i), device, turn});
    turn = turnDone;
    handles.push(handle);
  });
  return handles;
}

/** One file (a batch of one); `deviceId` is the processor's device when the caller has it. */
export function startUpload(file, {settings, deviceId, title} = {}) {
  return startUploads([file], {settings, deviceId, title})[0];
}
