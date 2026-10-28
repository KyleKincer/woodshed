// Fixture handlers for convex/notation.ts: drum parts by song (`db.notation`,
// {[songId]: {score, revision}}). A shared link reads the shared song's part.
//   fx-share=missing   the shared part is unavailable too
import {db, fx, clone} from './runtime.js';

const sharedSongId = token => Object.entries(db.shares).find(([, share]) => share.token === token)?.[0] ?? null;

export const handlers = {
  'notation:get': ({songId, token}) => {
    if (token) { const id = sharedSongId(token); return fx.share === 'missing' || !id || !db.notation[id] ? null : clone(db.notation[id]); }
    return db.notation[songId] ? clone(db.notation[songId]) : null;
  },
  'notation:save': ({songId, header, bars}) => {
    const cur = db.notation[songId] || {score: {...header, bars: []}, revision: 0};
    const merged = {...header, bars: [...cur.score.bars.filter(b => !bars.some(n => n.measureId === b.measureId)), ...bars].filter(b => b.hits.length || b.coverage !== 'unstarted')};
    db.notation[songId] = {score: merged, revision: cur.revision + 1};
    return {revision: cur.revision + 1};
  },
};
