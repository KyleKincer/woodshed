// Signed media URLs (convex/media.ts `signKeys`, architecture §1).
//
// Signed URLs are good for 6 hours, so they are cached in memory by R2 object
// key and only re-signed when they are within 5 minutes of expiring. Requests
// for keys already being signed share the one in flight, so a Library page
// that asks for the same cover many times signs it once. The server signs at
// most 100 keys per call; longer lists are split.
import {action} from './client.js';
import {now} from '../app/clock.js';

export const URL_TTL_MS = 6 * 60 * 60 * 1000;
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const BATCH = 100;

const cache = new Map();     // key → {url, expiresAt}
const inflight = new Map();  // key → Promise<string | undefined>

function fresh(key, at) {
  const hit = cache.get(key);
  return hit && hit.expiresAt - REFRESH_MARGIN_MS > at ? hit.url : undefined;
}

async function signBatch(keys, requestedAt) {
  const signed = await action('media:signKeys', {keys});
  for (const [key, url] of Object.entries(signed ?? {})) cache.set(key, {url, expiresAt: requestedAt + URL_TTL_MS});
  return signed ?? {};
}

/**
 * Resolves R2 object keys to signed URLs. Keys the server does not grant (not
 * the caller's, or gone) are absent from the result. Rejects with an ApiError.
 * @param {string[]} keys
 * @returns {Promise<Record<string, string>>}
 */
export async function signKeys(keys) {
  const at = now();
  const out = {}, waits = [], missing = [];
  for (const key of new Set(keys ?? [])) {
    if (!key) continue;
    const url = fresh(key, at);
    if (url) out[key] = url;
    else if (inflight.has(key)) waits.push(inflight.get(key).then(u => { if (u) out[key] = u; }));
    else missing.push(key);
  }
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const request = signBatch(batch, at);
    for (const key of batch) {
      // A caller that asks for this key while it is being signed shares the outcome, failure included.
      const one = request.then(signed => signed[key]);
      const done = () => { if (inflight.get(key) === one) inflight.delete(key); };
      one.then(done, done);
      inflight.set(key, one);
    }
    waits.push(request.then(signed => { for (const key of batch) if (signed[key]) out[key] = signed[key]; }));
  }
  await Promise.all(waits);
  return out;
}

/** One key's signed URL, or null when the key is empty or not granted. */
export async function signKey(key) {
  if (!key) return null;
  return (await signKeys([key]))[key] ?? null;
}

/** Forget every cached URL (sign-out, or tests). */
export function clearMediaCache() {
  cache.clear();
  inflight.clear();
}
