import { fetchMedia } from './media-fetch.js';
import { decodedStemCache } from './decoded-stem-cache.js';
// Device-local cache for stem audio, plus the codec capability probe.
//
// Stems are immutable once written (a reprocess writes new R2 keys), so they
// can be cached forever. Caching on the *object key* rather than the signed
// URL matters: signed URLs rotate every few hours, and keying on them would
// re-download tens of MB every time one expired.

const CACHE_NAME = 'woodshed-stems-v1';
// Synthetic origin — Cache API needs an http(s) URL as the key, but this one
// is never fetched.
const cacheUrlFor = (key) => `https://stem.cache.invalid/${encodeURIComponent(key)}`;

let cachePromise = null;
function openCache() {
  if (!('caches' in window)) return Promise.resolve(null);
  cachePromise ??= caches.open(CACHE_NAME).catch(() => null);
  return cachePromise;
}

/**
 * Fetch a stem, using the local cache when possible.
 *
 * @param {string} key R2 object key — the stable cache identity.
 * @param {string} url Signed URL to fetch on a miss.
 * @param {(loaded:number,total:number)=>void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchStem(key, url, onProgress) {
  const cache = await openCache();
  const cacheKey = cacheUrlFor(key);

  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) {
      onProgress?.(1, 1);
      return hit.arrayBuffer();
    }
  }

  const res = await fetchMedia(url);
  if (!res.ok) throw new Error(`Could not load stem (${res.status})`);

  // Tee the body so progress reporting doesn't consume the copy we cache.
  const total = Number(res.headers.get('content-length')) || 0;
  const buf = await readWithProgress(res.clone(), total, onProgress);

  if (cache) {
    // Best effort: a full disk or a private-mode quota error must not stop
    // playback, it just means we re-download next time.
    await cache.put(cacheKey, res).catch(() => {});
  }
  return buf;
}

async function readWithProgress(res, total, onProgress) {
  if (!onProgress || !res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

/** Drop every cached stem. Exposed in Settings. */
export async function clearStemCache() {
  decodedStemCache.clear();
  if (!('caches' in window)) return 0;
  cachePromise = null;
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  await Promise.all(keys.map((k) => cache.delete(k)));
  return keys.length;
}

/** Rough on-disk size of the cache, for the Settings readout. */
export async function stemCacheSize() {
  if (!('caches' in window)) return 0;
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  let bytes = 0;
  for (const req of keys) {
    const res = await cache.match(req);
    if (!res) continue;
    const len = Number(res.headers.get('content-length'));
    bytes += Number.isFinite(len) && len > 0 ? len : (await res.blob()).size;
  }
  return bytes;
}

// ---- codec support --------------------------------------------------------

const OPUS_WEBM = 'audio/webm; codecs="opus"';

/**
 * Cheap upfront hint about Opus-in-WebM support.
 *
 * This is only a hint: the authoritative test is whether `decodeAudioData`
 * accepts a real stem, and browsers have historically disagreed with their
 * own `canPlayType`. The player treats a decode failure as the real signal
 * (see `codecErrorMessage`); this exists to warn *before* a 20 MB download.
 *
 * Safari decodes Opus in WebM (macOS 12+/iOS 15+) but not in Ogg, which is
 * why the encoder targets WebM.
 */
export function likelySupportsOpus() {
  if (window.MediaSource?.isTypeSupported?.(OPUS_WEBM)) return true;
  const probe = document.createElement('audio').canPlayType(OPUS_WEBM);
  return probe === 'probably' || probe === 'maybe';
}

/** True when an error from decodeAudioData looks like "codec not supported". */
export function isDecodeError(err) {
  const name = err?.name || '';
  return (
    name === 'EncodingError' ||
    name === 'NotSupportedError' ||
    /decode|unsupported|format/i.test(String(err?.message || ''))
  );
}

export const codecErrorMessage =
  "This browser couldn't decode the stem audio (Opus in WebM). " +
  'Chrome, Edge and Firefox all support it, as does Safari on macOS 12 / iOS 15 and later. ' +
  'If you need to support an older browser, re-process the song with the FLAC format in Settings.';
