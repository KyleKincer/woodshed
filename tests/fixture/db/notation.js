// Fixture handlers for convex/notation.ts: drum parts by song (`db.notation`,
// {[songId]: {score, revision}}). A shared link reads the shared song's part,
// unless the link was made with includeNotation: false.
//   fx-share=missing   the shared part is unavailable too
import {db, fx, clone} from './runtime.js';

const sharedSongId = token => Object.entries(db.shares).find(([, share]) => share.token === token)?.[0] ?? null;

export const handlers = {
  'notation:get': ({songId, token}) => {
    if (token) {
      // Like convex/notation.ts: a link made without the drum part does not show it.
      const id = sharedSongId(token);
      return fx.share === 'missing' || !id || db.shares[id].includeNotation === false || !db.notation[id] ? null : clone(db.notation[id]);
    }
    return db.notation[songId] ? clone(db.notation[songId]) : null;
  },
  'notation:save': ({songId, header, bars}) => {
    const cur = db.notation[songId] || {score: {...header, bars: []}, revision: 0};
    // Like convex/notation.ts: bars whose measure left the header's timeline are deleted with it.
    const measureIds = new Set(header.timeline.measures.map(m => m.id));
    const kept = cur.score.bars.filter(b => measureIds.has(b.measureId) && !bars.some(n => n.measureId === b.measureId));
    const merged = {...header, bars: [...kept, ...bars].filter(b => b.hits.length || b.coverage !== 'unstarted')};
    db.notation[songId] = {score: merged, revision: cur.revision + 1};
    return {revision: cur.revision + 1};
  },
};
