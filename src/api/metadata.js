// Song metadata (convex/metadata.ts, convex/metadataLookup.ts, convex/artworkUpload.ts;
// architecture §6.9). One-line wrappers over src/api/client.js: every call takes
// the Convex function's own argument object and rejects with an ApiError (§2.1).
// Field rules, labels and the Match status copy live in shared/metadata.ts.
//
//   update({ids, changes, unlock?, match?})   → null   1–100 songs, atomic; unchanged keys are skipped (G1),
//                                                      `unlock` keys are unlocked after patching (Revert, G2),
//                                                      `match: {recordingId, releaseId?}` records a match (one song, G4)
//   updateEach({items: [{id, changes, unlock?}]}) → null   a patch per song (≤ 100), atomic (bulk Revert, G10)
//   confirm({id})                             → null   "Yes, this is right": matched, identity fields locked (G3)
//   find({id, title, artist, recordingId?})   → Candidate[]   ≤ 12 recordings, or ≤ 100 releases of one recording
//   detail({id, recordingId, releaseId?})     → Candidate      one full candidate (for the field-diff review)
//   retry({id})                               → null   look the song up again (G17); 'lookup_unavailable' / 'lookup_busy'
//   uploadArtwork({id, file, signal?})        → key    then save it with update({ids: [id], changes: {artwork: {kind: 'upload', key}}})
//
// Field errors are ApiError 'invalid' with `data.field` naming the field and a
// labelled message ("Album artist is too long (500 characters max).").
import {ApiError, action, mutation} from './client.js';
import {ARTWORK_TYPES, LIMITS} from '../../shared/metadata.ts';

export const update = args => mutation('metadata:update', args);
export const updateEach = args => mutation('metadata:updateEach', args);
export const confirm = args => mutation('metadata:confirm', args);

export const find = args => action('metadataLookup:find', args);
export const detail = args => action('metadataLookup:detail', args);
export const retry = args => action('metadataLookup:retry', args);

const ARTWORK_INVALID = 'Choose a JPEG, PNG or WebP image under 2 MB.';
const ARTWORK_FAILED = 'Could not upload artwork. Try again.';

async function sha256Base64(file) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Uploads a cover image for one song: reserve (`artworkUpload.prepare`), PUT
 * the bytes to the signed URL with their SHA-256, then verify
 * (`artworkUpload.complete`). Resolves to the stored key; the caller saves it
 * as the song's artwork with `update`. The type and size are checked first,
 * with the server's copy. An abort through `signal` rejects with the
 * AbortError itself.
 * @param {{id: string, file: Blob, signal?: AbortSignal}} args
 * @returns {Promise<string>}
 */
export async function uploadArtwork({id, file, signal}) {
  if (!file || !ARTWORK_TYPES.includes(file.type) || !(file.size > 0) || file.size > LIMITS.artworkBytes)
    throw new ApiError({code: 'invalid', message: ARTWORK_INVALID, data: {code: 'invalid', message: ARTWORK_INVALID, field: 'artwork'}});
  const checksum = await sha256Base64(file);
  signal?.throwIfAborted();
  const {url, objectId} = await action('artworkUpload:prepare', {id, bytes: file.size, mime: file.type, checksum});
  let response;
  try {
    response = await fetch(url, {method: 'PUT', headers: {'Content-Type': file.type, 'x-amz-checksum-sha256': checksum}, body: file, signal});
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new ApiError({message: ARTWORK_FAILED, raw: error});
  }
  if (!response.ok) throw new ApiError({message: ARTWORK_FAILED, data: {status: response.status}});
  signal?.throwIfAborted();
  try {
    return await action('artworkUpload:complete', {objectId});
  } catch (error) {
    // artworkUpload.complete reports a mismatched upload as a bare string; give it a code (§6.1).
    if (error instanceof ApiError && error.code === 'unknown')
      throw new ApiError({code: 'invalid', message: error.message, data: {code: 'invalid', message: error.message, field: 'artwork'}, raw: error.raw});
    throw error;
  }
}
