// Everything the UI needs from the server, in one module.
//
// This replaces the Electron preload's `window.api`. The shape is deliberately
// close to it — same verbs, same argument order — so the library/player/
// settings code needed only its call sites swapped, not a rewrite. The two
// real differences: progress arrives as reactive subscriptions instead of IPC
// events, and media is addressed by R2 object key rather than a file path.

import { anyApi } from 'convex/server';
import { convex } from './auth.js';

const api = anyApi;

// ---- config + settings ----------------------------------------------------

export function getConfig() {
  return convex.query(api.settings.config, {});
}

export function saveSettings(settings) {
  return convex.mutation(api.settings.save, { settings });
}

// ---- library --------------------------------------------------------------

export function listLibrary() {
  return convex.query(api.songs.list, {});
}

/** Subscribe to the library. Returns an unsubscribe function. */
export function onLibrary(cb) {
  return convex.onUpdate(api.songs.list, {}, cb);
}

/** Subscribe to in-flight jobs. Returns an unsubscribe function. */
export function onJobs(cb) {
  return convex.onUpdate(api.jobs.listActive, {}, cb);
}

export function renameSong(id, title) {
  return convex.mutation(api.songs.rename, { id, title });
}

export function saveTempo(id, tempo) {
  return convex.mutation(api.songs.saveTempo, { id, tempo });
}

export function deleteSong(id) {
  return convex.mutation(api.songs.remove, { id });
}

export function cancelJob(jobId) {
  return convex.mutation(api.jobs.cancel, { jobId });
}

export function dismissJob(jobId) {
  return convex.mutation(api.jobs.dismiss, { jobId });
}

// ---- media ----------------------------------------------------------------

// Signed URLs are good for hours, so cache them in memory and only re-sign
// what has actually expired. Keyed by R2 object key.
const urlCache = new Map(); // key -> { url, expiresAt }
const URL_TTL_MS = 6 * 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Resolve R2 object keys to signed URLs, batched.
 * @param {string[]} keys
 * @returns {Promise<Record<string,string>>}
 */
export async function signKeys(keys) {
  const now = Date.now();
  const out = {};
  const missing = [];
  for (const key of keys) {
    if (!key) continue;
    const hit = urlCache.get(key);
    if (hit && hit.expiresAt - REFRESH_MARGIN_MS > now) out[key] = hit.url;
    else missing.push(key);
  }
  if (missing.length) {
    const fresh = await convex.action(api.media.signKeys, { keys: missing });
    for (const [key, url] of Object.entries(fresh)) {
      urlCache.set(key, { url, expiresAt: now + URL_TTL_MS });
      out[key] = url;
    }
  }
  return out;
}

/** Convenience for a single key. Returns null if the key is missing. */
export async function signKey(key) {
  if (!key) return null;
  const map = await signKeys([key]);
  return map[key] || null;
}

// ---- adding songs ---------------------------------------------------------

/** Classify a raw text input into a source descriptor. */
export function classifyInput(text) {
  const t = String(text).trim();
  if (/open\.spotify\.com|spotify:/i.test(t)) return { type: 'spotify', value: t };
  if (/^https?:\/\//i.test(t)) return { type: 'url', value: t };
  return { type: 'search', value: t };
}

/**
 * Queue a song.
 *
 * Resolves to `{ jobId, songId }` with exactly one set. A `songId` means the
 * same audio at the same settings was already separated, so the song is in the
 * library already and there is no job to watch — the library subscription picks
 * it up on the next tick either way, so callers rarely need to look.
 */
export function addSong(input, settings) {
  const source = classifyInput(input);
  return convex.mutation(api.jobs.createSeparation, {
    source,
    settings,
    label: String(input).trim(),
  });
}

/** Re-run separation in place. Source is inherited from the existing song. */
export function reprocessSong(songId, settings, label) {
  return convex.mutation(api.jobs.createSeparation, {
    settings,
    label,
    replaceSongId: songId,
  });
}

export const AUDIO_FILE_RE = /\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?|wma)$/i;

/**
 * Upload local files straight to R2, then queue a separation job for each.
 *
 * The bytes never pass through Convex — the browser PUTs to a signed R2 URL
 * and Modal reads it back from there, so a 60 MB source file costs nothing in
 * function bandwidth.
 *
 * @param {File[]} files
 * @param {object} settings
 * @param {(f: {name: string, loaded: number, total: number}) => void} [onProgress]
 */
export async function addFiles(files, settings, onProgress) {
  const jobIds = [];
  for (const file of files) {
    const { key, url } = await convex.mutation(api.r2.generateSourceUploadUrl, {
      filename: file.name,
    });
    await putWithProgress(url, file, (loaded, total) =>
      onProgress?.({ name: file.name, loaded, total })
    );
    const res = await convex.mutation(api.jobs.createSeparation, {
      source: { type: 'upload', value: key, filename: file.name },
      settings,
      label: file.name,
    });
    // Uploads never dedupe — they're the user's own file — so a job is always
    // queued here. Guarded anyway so a null can't reach the progress overlay.
    if (res.jobId) jobIds.push(res.jobId);
  }
  return { jobIds };
}

// fetch() can't report upload progress; XHR still can.
function putWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Upload failed — check your connection.'));
    xhr.send(file);
  });
}

// ---- beat detection -------------------------------------------------------

/**
 * Run BeatNet on a song and resolve with its beat track.
 * @returns {Promise<{beats?: Array, error?: string}>}
 */
export async function detectBeats(songId, onProgress) {
  const { jobId } = await convex.mutation(api.jobs.createBeatDetection, { songId });
  return new Promise((resolve) => {
    let settled = false;
    const unsub = convex.onUpdate(api.jobs.get, { jobId }, (job) => {
      if (!job || settled) return;
      if (job.status === 'done') {
        settled = true;
        unsub();
        resolve({ beats: job.result?.beats || [] });
      } else if (job.status === 'error') {
        settled = true;
        unsub();
        resolve({ error: job.error || 'Beat detection failed.' });
      } else if (job.status === 'canceled') {
        settled = true;
        unsub();
        resolve({ error: 'Canceled.' });
      } else {
        onProgress?.(job.message || 'Working…');
      }
    });
  });
}

/** Open an external link. Trivial in a browser; kept for call-site parity. */
export function openExternal(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}
