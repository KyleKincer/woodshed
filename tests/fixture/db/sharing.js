// Fixture handlers for convex/sharing.ts and convex/shareAudio.ts. Created by
// FX1 with the 1.9 fixture's handlers moved verbatim; BK5 (wave 0B) owns the
// bodies from here on (§6.7). One adaptation to the v2 seed: links are looked
// up by token in `db.shares` ({[songId]: {token, includeNotation, createdAt}}),
// so the demo link (`db.demoToken`) resolves too, not only Glasshouse's.
//   fx-share=missing   every shared link is unavailable
//   fx-share=saved     the shared song is already in the library
import {db, fx, clone, wait, findSong, publicSong} from './runtime.js';
import {COVERS} from './seed.js';
import {stemUrl} from '../audio.js';

const sharedSongId = token => Object.entries(db.shares).find(([, share]) => share.token === token)?.[0] ?? null;

export const handlers = {
  'sharing:status': ({id}) => db.shares[id] ? clone(db.shares[id]) : null,
  'sharing:create': ({id, includeNotation}) => { db.shares[id] = {token: db.shares[id]?.token || [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join(''), includeNotation, createdAt: Date.now()}; return {token: db.shares[id].token}; },
  'sharing:revoke': ({id}) => { delete db.shares[id]; return null; },
  'sharing:view': ({token}) => {
    const songId = sharedSongId(token);
    if (fx.share === 'missing' || !songId || !findSong(songId)) return null;
    const s = publicSong(findSong(songId));
    return {...s, id: 'shared', revision: 'r1', coverKey: 'cover', stems: s.stems.map((x, i) => ({name: x.name, key: `stem-${i}`}))};
  },
  'sharing:saved': () => fx.share === 'saved' ? {songId: 'glasshouse', status: 'ready'} : null,
  'shareAudio:playback': ({token} = {}) => {
    const s = findSong(sharedSongId(token) ?? 'glasshouse');
    if (!s) return {};
    const cover = s.coverUrl || db.coverKeys[s.coverKey] || COVERS.weather;
    return Object.fromEntries([...s.stems.map((x, i) => [`stem-${i}`, stemUrl(s, x.name, db.notation[s.id]?.score)]), ['cover', cover]]);
  },
  'shareAudio:save': async () => { await wait(800); return 'glasshouse'; },
};
