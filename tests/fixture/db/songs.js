// Fixture handlers for convex/songs.ts. Created by FX1 with the 1.9 fixture's
// handlers moved verbatim; BK1 (wave 0B) owns the bodies from here on and
// mirrors every 2.0 function (§6.3).
// Seed shape (db/seed.js): `db.songs` rows carry the 2.0 song fields; practice
// saved by 2.0 lives in `db.songPractice` ({songId, userId, practice, updatedAt});
// v1 rows still hold `songs.practice` (pre-backfill).
//   fx-library=slow   the library never arrives (the loading skeleton)
import {db, fx, changed, clone, findSong, publicSong, NEVER} from './runtime.js';

export const handlers = {
  'songs:list': () => fx.library === 'slow' ? NEVER : ({songs: db.songs.map(publicSong)}),
  'songs:get': ({id}) => { const s = findSong(id); return s ? publicSong(s) : null; },
  'songs:rename': ({id, title}) => { findSong(id).title = title; changed(); return publicSong(findSong(id)); },
  'songs:saveTempo': ({id, tempo}) => { const s = findSong(id); if (s) s.tempo = clone(tempo); changed(); return null; },
  'songs:savePractice': ({id, practice}) => { const s = findSong(id); if (s) s.practice = clone(practice); changed(); return null; },
  'songs:remove': ({id}) => { db.songs = db.songs.filter(s => s.id !== id); changed(); return null; },
  'songs:exportPage': () => ({page: db.songs.map(publicSong), isDone: true, continueCursor: null}),
};
