// Fixture handlers for convex/jobs.ts. Created by FX1 with the 1.9 fixture's
// handlers moved verbatim; BK2 (wave 0B) owns the bodies from here on (§6.4).
// Two adaptations to the v2 seed: `db.jobs` now also holds done jobs (the
// unapplied detection, finished chains), so listActive keeps the 1.9 contract
// of live and failed jobs only; and beat-detection jobs live in `db.jobs`
// (1.9 kept them in a separate `db.beatJobs`).
//   fx-detect=ok|fail|slow   a beat detection finishes in 1.5 s | fails (beats_unavailable) | takes 8 s
// A detection stores when it finishes (`finishAt`), so one that was running when
// the page reloaded (or a new tab opened) still finishes: db/index.js calls
// `settle()` on boot and on every job-creep tick, and `resume()` re-arms the timers.
import {db, fx, changed, clone, findSong} from './runtime.js';

const LIVE = new Set(['queued', 'running', 'error']);
const beatsAt = (bpm, offset, seconds) => { const out = []; for (let t = offset, i = 0; t < seconds - .2; t += 60 / bpm, i++) out.push({time: +t.toFixed(4), downbeat: i % 4 === 0}); return out; };

/** Finish one running beat detection the way the 1.9 timer did. */
function finishBeats(j) {
  const s = findSong(j.songId);
  const updatedAt = Date.now();
  delete j.finishAt;
  if (fx.detect === 'fail' || !s) Object.assign(j, {status: 'error', stage: 'error', percent: 0, errorCode: 'beats_unavailable', error: 'BeatNet is not installed on this computer (fixture).', updatedAt});
  else Object.assign(j, {status: 'done', percent: 100, updatedAt, result: {beats: beatsAt(s.bpm || 120, s.offset || 0, s.duration).map((b, i) => [b.time, i % 4 + 1])}});
}

/** Finish every beat detection whose `finishAt` has passed; returns whether anything changed. */
export function settle(now = Date.now()) {
  let any = false;
  for (const j of db?.jobs ?? []) if (j.kind === 'beats' && j.status === 'running' && typeof j.finishAt === 'number' && j.finishAt <= now) { finishBeats(j); any = true; }
  return any;
}

/** After a reload: re-arm the finishing timer of every detection that is not due yet. */
export function resume(now = Date.now()) {
  for (const j of db?.jobs ?? []) if (j.kind === 'beats' && j.status === 'running' && typeof j.finishAt === 'number' && j.finishAt > now)
    setTimeout(() => { if (settle()) changed(); }, j.finishAt - now);
}

const onlineDevice = () => (db.devicePresence ?? []).find(p => p.state && p.state !== 'offline')?.deviceId;

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
    const ms = fx.detect === 'slow' ? 8000 : 1500, now = Date.now();
    const song = findSong(songId), deviceId = onlineDevice();
    db.jobs = db.jobs.filter(j => j.jobId !== jobId);
    db.jobs.push({jobId, kind: 'beats', songId, status: 'running', stage: 'detect', percent: 20, message: 'Listening for beats…',
      label: `Finding bars — ${song?.title ?? songId}`, settings: {sections: false}, attempts: 1, createdAt: now, startedAt: now, updatedAt: now, finishAt: now + ms, ...(deviceId ? {deviceId} : {})});
    setTimeout(() => { if (settle()) changed(); }, ms);
    return {jobId};
  },
};
