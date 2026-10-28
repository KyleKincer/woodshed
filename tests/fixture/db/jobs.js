// Fixture handlers for convex/jobs.ts. Created by FX1 with the 1.9 fixture's
// handlers moved verbatim; BK2 (wave 0B) owns the bodies from here on (§6.4).
// Two adaptations to the v2 seed: `db.jobs` now also holds done jobs (the
// unapplied detection, finished chains), so listActive keeps the 1.9 contract
// of live and failed jobs only; and beat-detection jobs live in `db.jobs`
// (1.9 kept them in a separate `db.beatJobs`).
//   fx-detect=ok|fail|slow   a beat detection finishes in 1.5 s | fails (beats_unavailable) | takes 8 s
import {db, fx, changed, clone, findSong} from './runtime.js';

const LIVE = new Set(['queued', 'running', 'error']);
const beatsAt = (bpm, offset, seconds) => { const out = []; for (let t = offset, i = 0; t < seconds - .2; t += 60 / bpm, i++) out.push({time: +t.toFixed(4), downbeat: i % 4 === 0}); return out; };

export const handlers = {
  'jobs:listActive': () => clone(db.jobs.filter(j => LIVE.has(j.status))),
  'jobs:get': ({jobId}) => clone(db.jobs.find(j => j.jobId === jobId) || null),
  'jobs:cancel': ({jobId}) => { db.jobs = db.jobs.filter(j => j.jobId !== jobId); changed(); return null; },
  'jobs:dismiss': ({jobId}) => { db.jobs = db.jobs.filter(j => j.jobId !== jobId); changed(); return null; },
  'jobs:retry': ({jobId}) => { const j = db.jobs.find(x => x.jobId === jobId); Object.assign(j, {status: 'queued', stage: 'queued', percent: 0, error: null}); changed(); return null; },
  'jobs:createSeparation': ({source, label, replaceSongId}) => {
    const jobId = `job-${Math.random().toString(36).slice(2, 8)}`;
    db.jobs.unshift({jobId, kind: 'separate', status: 'queued', stage: 'queued', percent: 0, label, songId: replaceSongId, meta: source?.type === 'search' ? {title: label} : source?.type === 'upload' ? {title: source.filename} : {}});
    changed();
    setTimeout(() => { const j = db.jobs.find(x => x.jobId === jobId); if (j) { Object.assign(j, {status: 'running', stage: 'download', percent: 8, meta: {...j.meta, title: j.meta.title || 'Harbor Lights', artist: 'Ada Moreno', duration: 204}}); changed(); } }, 1500);
    return {jobId};
  },
  'jobs:createBeatDetection': ({songId}) => {
    const jobId = `beats-${songId}`;
    db.jobs = db.jobs.filter(j => j.jobId !== jobId);
    db.jobs.push({jobId, kind: 'beats', songId, status: 'running', stage: 'detect', percent: 20, message: 'Listening for beats…'});
    setTimeout(() => {
      const s = findSong(songId), j = db.jobs.find(x => x.jobId === jobId);
      if (!s || !j) return;
      if (fx.detect === 'fail') Object.assign(j, {status: 'error', stage: 'error', percent: 0, errorCode: 'beats_unavailable', error: 'BeatNet is not installed on this computer (fixture).'});
      else Object.assign(j, {status: 'done', percent: 100, result: {beats: beatsAt(s.bpm || 120, s.offset || 0, s.duration).map((b, i) => [b.time, i % 4 + 1])}});
      changed();
    }, fx.detect === 'slow' ? 8000 : 1500);
    return {jobId};
  },
};
