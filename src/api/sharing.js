// Sharing (convex/sharing.ts and convex/shareAudio.ts, architecture §6.7).
// One-line wrappers over src/api/client.js; every call sends exactly the
// contract arguments and rejects with an ApiError (§2.1). Subscriptions
// return `off()`.
//
// Owner (authenticated client):
//   status({id})                    → {token, includeNotation} | null   the song's active link
//   create({id, includeNotation?})  → {token}   reuses the active link (updating includeNotation); a stopped link is never revived
//   revoke({id})                    → null      Stop sharing
// Visitor of /share/:token (the public client, so no account is needed):
//   view({token})                   → SharedSong | null   subscribeView({token}, onValue, onError) → off
//   playback({token})               → {'stem-0': url, …, cover?: url}   5-minute signed URLs
// Signed-in visitor:
//   saved({token})                  → {songId, status: 'ready'} | {songId: null, status: 'copying'} | null
//   subscribeSaved({token}, onValue, onError) → off
//   save({token})                   → songId    "Add to my library" (idempotent; the owner gets their own song)
//
// A SharedSong is the snapshot `sharing.view` returns: {id: 'shared', revision, ownerName ('Kyle K.' or
// 'a Woodshed user'), title, artist, album, albumArtist, year, genre, trackNumber, discNumber, musicalKey,
// tuning, duration, stemMode, quality, stems: [{name, key: 'stem-<i>'}], coverKey: 'cover' | null, coverUrl,
// artwork, tempo: {songMap} (or a pre-1.6 song's legacy {source?, map, detected}) | undefined,
// practice: a v2 practice blob with nothing personal (shared/practice.ts#sanitizeForShare)}.
import {action, mutation, publicClient, query, subscribe} from './client.js';

/** The shape of a share token (64 lowercase hex characters); anything else is never sent. */
export const TOKEN_RE = /^[a-f0-9]{64}$/;
export const isShareToken = token => typeof token === 'string' && TOKEN_RE.test(token);

export const status = ({id}) => query('sharing:status', {id});
export const create = ({id, includeNotation}) => mutation('sharing:create', includeNotation === undefined ? {id} : {id, includeNotation});
export const revoke = ({id}) => mutation('sharing:revoke', {id});

export const view = ({token}) => publicClient().query('sharing:view', {token});
export const subscribeView = ({token}, onValue, onError) => publicClient().subscribe('sharing:view', {token}, onValue, onError);
export const playback = ({token}) => publicClient().action('shareAudio:playback', {token});

export const saved = ({token}) => query('sharing:saved', {token});
export const subscribeSaved = ({token}, onValue, onError) => subscribe('sharing:saved', {token}, onValue, onError);
export const save = ({token}) => action('shareAudio:save', {token});
