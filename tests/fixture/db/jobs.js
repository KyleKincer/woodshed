// Fixture handlers for convex/jobs.ts (BK2, architecture §6.4). They mirror the
// server: the same row and detail shapes, the same validation, dedupe and
// device rules, and the same coded errors (convexError({code, message, …})).
//
// What the fixture adds on top of the server:
//   - a separation is claimed 1.5 s after it is queued, as a companion would;
//   - a beat detection is claimed at once and finishes on its own:
//       fx-detect=ok|fail|slow   finishes in 1.5 s | fails (beats_unavailable) | takes 8 s
//     It stores when it finishes (`finishAt`, also returned by `jobs:get`), so one
//     that was running when the page reloaded (or a new tab opened) still finishes:
//     db/index.js calls `settle()` on boot and on every job-creep tick, and `resume()`
//     re-arms the timers. A detection's id is `beats-<songId>`;
//   - a section detection (`sections-<songId>`) is claimed at once and keeps running;
//   - `jobs:retry` runs the job again the way creating it did (a separation is claimed
//     after 1.5 s, a detection at once), so "Try again" never leaves a stuck queued row;
//   - a live detection is reused, or a stale one canceled, as on the server: any live
//     detection of that kind for the song counts, the seeded running ones (`job-beats`
//     on quiet, `job-sections` on lanterns, display rows that never finish) included.
//     The new row replaces any earlier row under the same `<kind>-<songId>` id;
//   - like the other handler modules, the queries do not refuse a suspended account
//     (fx-auth=suspended); every mutation applies the server's account rules.
// `db.jobs` holds done jobs too (the unapplied detection `job-detect-nightbus`,
// finished chains); listActive returns queued, running and failed jobs only, and
// listUnappliedDetections the done, user-started, unapplied detections.
import {db, fx, changed, clone, findSong, convexError} from './runtime.js';
import {PRESETS, STEM_MODES, resolveQuality, withDefaults} from '../../../convex/lib/presets.ts';
import {hasRealMap as songHasRealMap} from '../../../shared/song-map.ts';

const LIST_PER_STATUS = 50;
const QUEUE_CAP = 20;
const META_TEXT_MAX = 300;
const THUMBNAIL_MAX = 2000;
const LABEL_MAX = 500;
const SOURCE_MAX = 2000;
const FILENAME_MAX = 500;
const META_DURATION_MAX = 86_400;
const RESUME_MESSAGE = 'Resuming local files…';
const PRESET_IDS = [...Object.keys(PRESETS), 'custom'];
const STEM_MODE_IDS = [...new Set([...Object.keys(STEM_MODES), 'six'])];
const NO_COMPANION = 'Connect this computer’s companion in Settings first.';
const PRESENCE_ONLINE_MS = 150_000;
const CLAIM_MS = 1500;
const UNAPPLIED_MAX = 20;
const UNAPPLIED_SCAN = 200;

const fail = (code, message, data = {}) => { throw convexError({...data, code, message}); };
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isLive = j => j.status === 'queued' || j.status === 'running';
const beatsAt = (bpm, offset, seconds) => { const out = []; for (let t = offset, i = 0; t < seconds - .2; t += 60 / bpm, i++) out.push({time: +t.toFixed(4), downbeat: i % 4 === 0}); return out; };
let seq = 0;
const newJobId = () => `job-${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---- rows (convex/jobs.ts toRow / toDetail) ------------------------------------------

function settingsSummary(j) {
  if (j.kind !== 'separate' || !isObject(j.settings)) return null;
  const s = withDefaults(j.settings);
  return {preset: String(s.preset), stemMode: String(s.stemMode), model: resolveQuality(s).model};
}

/** The `jobs:listActive` row. */
export function toRow(j) {
  return clone({
    jobId: j.jobId, kind: j.kind, songId: j.songId ?? null, label: j.label, status: j.status, stage: j.stage, percent: j.percent,
    message: j.message ?? null, error: j.error ?? null, meta: j.meta ?? null, deviceId: j.deviceId ?? null,
    createdAt: j.createdAt, startedAt: j.startedAt ?? null, updatedAt: j.updatedAt, attempts: j.attempts ?? 0,
    errorCode: j.errorCode ?? null, retryAt: j.retryAt ?? null, chainedFrom: j.chainedFrom ?? null, confirmed: j.confirmed === true,
    source: j.source ? {type: j.source.type, value: j.source.value, filename: j.source.filename ?? null} : null,
    settingsSummary: settingsSummary(j),
  });
}

/** The `jobs:get` / `jobs:latestDetection` detail (plus the fixture's own `finishAt`). */
export function toDetail(j) {
  const detection = j.kind === 'beats' || j.kind === 'sections';
  const out = {...toRow(j), result: detection && j.status === 'done' ? clone(j.result ?? null) : null, appliedAt: j.appliedAt ?? null};
  if (typeof j.finishAt === 'number') out.finishAt = j.finishAt;
  return out;
}

// ---- access ------------------------------------------------------------------------

/** lib/auth.ts: suspended accounts can do nothing; export-only ones cannot add media or detect (D10). */
function account({write = false} = {}) {
  const status = db.user?.status;
  if (status === 'suspended') fail('account_suspended', 'Your account is suspended. Contact the app owner for help.');
  if (write && status === 'export_only') fail('account_export_only', 'Your account is in export-only mode. Playback and library export remain available.');
}

function ownSong(songId) {
  const song = findSong(songId);
  if (!song) fail('not_found', 'Song not found.');
  return song;
}

function ownJob(jobId) {
  const job = db.jobs.find(j => j.jobId === jobId);
  if (!job) fail('not_found', 'Job not found.');
  return job;
}

const findDevice = id => (db.devices ?? []).find(d => d.id === id) ?? null;
const deviceName = d => d?.displayName?.trim() || d?.name?.trim() || 'the computer that added it';

function pairedDevice(deviceId) {
  const device = findDevice(deviceId);
  if (!device) fail('device_unpaired', NO_COMPANION);
  if (device.revoked) {
    if (device.revokedBy === 'admin') fail('device_revoked_admin', 'This computer was disconnected by an administrator.');
    fail('device_unpaired', NO_COMPANION);
  }
  return device;
}

/** convex/jobs.ts defaultDevice: the most recently seen computer (online first: not offline and seen in the last 150 s), else the only one. */
function defaultDevice() {
  const devices = (db.devices ?? []).filter(d => !d.revoked);
  if (!devices.length) fail('device_unpaired', 'Connect the local companion first.');
  const now = Date.now();
  let best = null;
  for (const device of devices) {
    for (const p of (db.devicePresence ?? []).filter(row => row.deviceId === device.id)) {
      const next = {device, online: p.state !== 'offline' && now - p.lastSeenAt < PRESENCE_ONLINE_MS, seen: p.lastSeenAt};
      if (!best || (next.online && !best.online) || (next.online === best.online && next.seen > best.seen)) best = next;
    }
  }
  if (best) return best.device;
  if (devices.length === 1) return devices[0];
  fail('device_unpaired', 'Choose which computer should do this.');
}

function pickSettings(s) {
  const custom = isObject(s.custom) ? s.custom : {};
  const out = {preset: s.preset, stemMode: s.stemMode, bitrate: s.bitrate, custom: {model: String(custom.model ?? ''), shifts: Number(custom.shifts), overlap: Number(custom.overlap)}};
  if (s.format !== undefined) out.format = s.format;
  return out;
}

function separationSettings(raw) {
  if (raw !== undefined && raw !== null && !isObject(raw)) fail('invalid', 'These processing settings could not be read.', {field: 'settings'});
  const s = withDefaults(raw);
  if (!PRESET_IDS.includes(String(s.preset))) fail('invalid', 'Choose a quality preset.', {field: 'settings.preset'});
  if (!STEM_MODE_IDS.includes(String(s.stemMode))) fail('invalid', 'Choose which stems to make.', {field: 'settings.stemMode'});
  return pickSettings(s);
}

function cleanMeta(meta) {
  if (!meta) return undefined;
  const out = {};
  for (const key of ['title', 'channel', 'provider']) {
    const value = typeof meta[key] === 'string' ? meta[key].trim() : '';
    if (!value) continue;
    if (value.length > META_TEXT_MAX) fail('invalid', `The ${key} is too long (${META_TEXT_MAX} characters max).`, {field: `meta.${key}`});
    out[key] = value;
  }
  const thumbnail = typeof meta.thumbnail === 'string' ? meta.thumbnail.trim() : '';
  if (thumbnail) {
    let url = null;
    try { url = new URL(thumbnail); } catch { url = null; }
    if (thumbnail.length > THUMBNAIL_MAX || url?.protocol !== 'https:') fail('invalid', 'The thumbnail must be an https link.', {field: 'meta.thumbnail'});
    out.thumbnail = thumbnail;
  }
  if (meta.duration !== undefined) {
    if (!Number.isFinite(meta.duration) || meta.duration < 0 || meta.duration > META_DURATION_MAX) fail('invalid', 'The duration is not valid.', {field: 'meta.duration'});
    out.duration = meta.duration;
  }
  return Object.keys(out).length ? out : undefined;
}

/** convex/jobs.ts needs a real map for sections: the same `shared/song-map.ts` rule, a drum chart counting. */
const hasRealMap = song => songHasRealMap(song.tempo, {hasPart: song.hasChart === true});

// ---- detections that finish on their own ---------------------------------------------

/** Finish one running beat detection the way the 1.9 timer did. */
function finishBeats(j) {
  const s = findSong(j.songId);
  const updatedAt = Date.now();
  delete j.finishAt;
  if (fx.detect === 'fail' || !s) Object.assign(j, {status: 'error', stage: 'error', percent: 0, errorCode: 'beats_unavailable', error: 'BeatNet is not installed on this computer (fixture).', updatedAt});
  else Object.assign(j, {status: 'done', stage: 'done', percent: 100, updatedAt, result: {beats: beatsAt(s.bpm || 120, s.offset || 0, s.duration).map((b, i) => [b.time, i % 4 + 1]), sections: []}});
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

/** convex/jobs.ts liveDetection: the song's newest queued or running detection of this kind. */
const liveDetection = (songId, kind) => db.jobs.filter(j => j.songId === songId && j.kind === kind && isLive(j))
  .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;

/**
 * convex/jobs.ts startDetection: the chosen computer is checked first; a live detection
 * is reused only while its computer is paired and, when a computer was chosen, it is
 * that one or the job is running; a stale one is canceled. Returns `{device}` for a new
 * job or `{jobId}` to reuse.
 */
function detectionTarget(songId, kind, deviceId) {
  const chosen = deviceId ? pairedDevice(deviceId) : null;
  const live = liveDetection(songId, kind);
  if (live) {
    const runner = findDevice(live.deviceId);
    if (runner && !runner.revoked && (!chosen || live.status === 'running' || live.deviceId === chosen.id)) {
      if (live.chainedFrom) { delete live.chainedFrom; live.updatedAt = Date.now(); }
      return {jobId: live.jobId};
    }
  }
  // The server cancels the stale job first, but a refusal below rolls that back: pick the computer first.
  const device = chosen ?? defaultDevice();
  if (live) {
    Object.assign(live, {status: 'canceled', updatedAt: Date.now()});
    delete live.retryAt;
    delete live.finishAt;
  }
  return {device};
}

/** A beat detection claimed now (on creation or retry); it finishes on its own after 1.5 s (8 s with fx-detect=slow). */
function runBeats(j, now = Date.now()) {
  const ms = fx.detect === 'slow' ? 8000 : 1500;
  Object.assign(j, {status: 'running', stage: 'detect', percent: 20, message: 'Listening for beats…', attempts: (j.attempts ?? 0) + 1, startedAt: now, updatedAt: now, finishAt: now + ms});
  setTimeout(() => { if (settle()) changed(); }, ms);
}

/** A section detection claimed now; it keeps running. */
function runSections(j, now = Date.now()) {
  Object.assign(j, {status: 'running', stage: 'detect', percent: 30, message: 'Suggesting sections…', attempts: (j.attempts ?? 0) + 1, startedAt: now, updatedAt: now});
}

/** The computer claims a queued separation after 1.5 s and reports the recording's details, as the companion's meta event would. */
function claimLater(jobId) {
  setTimeout(() => {
    const j = db?.jobs.find(x => x.jobId === jobId);
    if (!j || j.status !== 'queued' || j.kind !== 'separate') return;
    const at = Date.now(), upload = j.source?.type === 'upload';
    Object.assign(j, {status: 'running', stage: 'download', percent: 8, message: 'Downloading audio…', attempts: (j.attempts ?? 0) + 1, startedAt: at, updatedAt: at,
      meta: {...j.meta, title: j.meta?.title || (upload ? j.source.filename : 'Harbor Lights'), channel: j.meta?.channel || 'Ada Moreno', duration: j.meta?.duration ?? 204}});
    changed();
  }, CLAIM_MS);
}

// ---- handlers --------------------------------------------------------------------------

export const handlers = {
  'jobs:listActive': () => {
    const by = status => db.jobs.filter(j => j.status === status).sort((a, b) => a.createdAt - b.createdAt);
    // The head of the queue and the newest failures, 50 each, then by createdAt (as the server reads them).
    return [...by('queued').slice(0, LIST_PER_STATUS), ...by('running').slice(0, LIST_PER_STATUS), ...by('error').slice(-LIST_PER_STATUS)]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(toRow);
  },

  'jobs:get': ({jobId}) => {
    const j = db.jobs.find(x => x.jobId === jobId);
    return j ? toDetail(j) : null;
  },

  'jobs:latestDetection': ({songId}) => {
    if (!findSong(songId)) return null;
    const latest = db.jobs.filter(j => j.songId === songId && j.kind === 'beats' && j.status === 'done' && !j.chainedFrom)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!latest || latest.result == null || latest.appliedAt !== undefined) return null;
    return toDetail(latest);
  },

  // convex/jobs.ts listUnappliedDetections: the newest 200 done jobs; per song only its newest done,
  // user-started detection counts; one with a result and no appliedAt is listed; newest first, at most 20.
  'jobs:listUnappliedDetections': () => {
    if (!db.user) return [];
    const done = db.jobs.map((j, i) => ({j, i})).filter(({j}) => j.status === 'done')
      .sort((a, b) => b.j.createdAt - a.j.createdAt || b.i - a.i).slice(0, UNAPPLIED_SCAN).map(({j}) => j);
    const seen = new Set(), out = [];
    for (const j of done) {
      if (out.length >= UNAPPLIED_MAX) break;
      if (j.kind !== 'beats' || j.chainedFrom || !j.songId || seen.has(j.songId)) continue;
      seen.add(j.songId);
      if (j.result == null || j.appliedAt !== undefined || !findSong(j.songId)) continue;
      out.push(toDetail(j));
    }
    return out;
  },

  'jobs:createSeparation': ({source: given, deviceId, settings: rawSettings, label, replaceSongId, meta: rawMeta, confirmed}) => {
    account({write: true});
    const song = replaceSongId ? ownSong(replaceSongId) : null;
    const source = given ?? song?.source;
    if (!source) fail('resplit_no_source', 'This song can’t be split again — its original audio is gone.');
    if (typeof label !== 'string' || label.length > LABEL_MAX) fail('invalid', `The label is too long (${LABEL_MAX} characters max).`, {field: 'label'});
    if (!String(source.value ?? '').trim()) fail('invalid', 'Enter a link or search.', {field: 'source'});
    if (source.value.length > SOURCE_MAX) fail('invalid', `The source is too long (${SOURCE_MAX} characters max).`, {field: 'source'});
    if (source.filename !== undefined && source.filename.length > FILENAME_MAX) fail('invalid', `The file name is too long (${FILENAME_MAX} characters max).`, {field: 'source.filename'});
    const device = pairedDevice(deviceId);
    // D38: an uploaded song's original file lives only on the computer that added it.
    const reusesUpload = !!song && source.type === 'upload' && song.source?.type === 'upload' && song.source.value === source.value;
    if (reusesUpload && song.originDeviceId && song.originDeviceId !== device.id) {
      const name = deviceName(findDevice(song.originDeviceId));
      fail('resplit_wrong_device', `Re-split this song on ${name}, which has the original file.`, {deviceName: name});
    }
    if (db.jobs.filter(j => j.deviceId === device.id && j.status === 'queued').length >= QUEUE_CAP) fail('queue_full', 'Process the queued songs before adding more.');
    const settings = separationSettings(rawSettings), meta = cleanMeta(rawMeta), now = Date.now();
    const jobId = newJobId();
    const row = {jobId, kind: 'separate', deviceId: device.id, label, source: clone(source), settings, status: 'queued', stage: 'queued', percent: 0, attempts: 0, createdAt: now, updatedAt: now};
    if (song) row.songId = song.id;
    if (meta) row.meta = meta;
    if (confirmed !== undefined) row.confirmed = confirmed;
    db.jobs.push(row);
    changed();
    claimLater(jobId);
    return {jobId};
  },

  'jobs:createBeatDetection': ({songId, deviceId}) => {
    account({write: true});
    const song = ownSong(songId);
    const target = detectionTarget(songId, 'beats', deviceId);
    if (target.jobId) { changed(); return {jobId: target.jobId}; }
    const sections = withDefaults(db.settings).autoSections !== false;
    const jobId = `beats-${songId}`, now = Date.now();
    db.jobs = db.jobs.filter(j => j.jobId !== jobId);
    const j = {jobId, kind: 'beats', songId, deviceId: target.device.id, label: `Finding bars — ${song.title}`, settings: {sections}, attempts: 0, createdAt: now};
    runBeats(j, now);
    db.jobs.push(j);
    changed();
    return {jobId};
  },

  'jobs:createSectionDetection': ({songId, deviceId}) => {
    account({write: true});
    const song = ownSong(songId);
    if (!hasRealMap(song)) fail('invalid', 'Find the bars before suggesting sections.');
    const target = detectionTarget(songId, 'sections', deviceId);
    if (target.jobId) { changed(); return {jobId: target.jobId}; }
    const jobId = `sections-${songId}`, now = Date.now();
    db.jobs = db.jobs.filter(j => j.jobId !== jobId);
    const j = {jobId, kind: 'sections', songId, deviceId: target.device.id, label: `Finding sections — ${song.title}`, attempts: 0, createdAt: now};
    runSections(j, now);
    db.jobs.push(j);
    changed();
    return {jobId};
  },

  'jobs:cancel': ({jobId}) => {
    account();
    const j = db.jobs.find(x => x.jobId === jobId);
    if (!j || j.status === 'done' || j.status === 'canceled') return false;
    Object.assign(j, {status: 'canceled', updatedAt: Date.now()});
    delete j.retryAt;
    delete j.finishAt;
    changed();
    return true;
  },

  'jobs:dismiss': ({jobId}) => {
    account();
    const j = db.jobs.find(x => x.jobId === jobId);
    if (!j) return false;
    if (isLive(j)) fail('job_live', 'Cancel the job first.');
    db.jobs = db.jobs.filter(x => x.jobId !== jobId);
    changed();
    return true;
  },

  'jobs:retry': ({jobId, preset, deviceId}) => {
    account({write: true});
    const j = ownJob(jobId);
    if (j.status !== 'error') fail('job_not_failed', 'Only failed jobs can be retried.');
    const device = findDevice(j.deviceId);
    if (!device || device.revoked || (deviceId !== undefined && deviceId !== j.deviceId))
      fail('retry_wrong_device', 'Retry from the original processing computer.', device ? {deviceName: deviceName(device)} : {});
    if ((j.kind === 'beats' || j.kind === 'sections') && j.songId) {
      const live = db.jobs.find(x => x.jobId !== j.jobId && x.songId === j.songId && x.kind === j.kind && isLive(x));
      if (live) fail('job_live', 'This song is already being checked.', {jobId: live.jobId});
    }
    let settings = j.settings;
    if (preset !== undefined) {
      if (j.kind !== 'separate') fail('invalid', 'Only song processing has a quality preset.', {field: 'preset'});
      if (!PRESET_IDS.includes(preset)) fail('invalid', 'Choose a quality preset.', {field: 'preset'});
      const s = {...withDefaults(j.settings), preset}, q = resolveQuality(s);
      settings = {...pickSettings(s), model: q.model, shifts: q.shifts, overlap: q.overlap};
    }
    Object.assign(j, {status: 'queued', stage: 'queued', percent: 0, message: RESUME_MESSAGE, updatedAt: Date.now()});
    if (settings !== undefined) j.settings = settings;
    for (const key of ['error', 'errorCode', 'retryAt']) delete j[key];
    // Run it again the way creating it did (see the header).
    if (j.kind === 'beats') runBeats(j);
    else if (j.kind === 'sections') runSections(j);
    else claimLater(j.jobId);
    changed();
    return null;
  },

  'jobs:markApplied': ({jobId}) => {
    account();
    const j = ownJob(jobId);
    if (j.kind !== 'beats' || j.status !== 'done') fail('invalid', 'Only a finished bar detection can be applied.');
    if (j.appliedAt === undefined) { j.appliedAt = Date.now(); changed(); }
    return null;
  },
};
