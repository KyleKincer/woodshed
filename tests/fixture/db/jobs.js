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
//   - the seeded running detections (`job-beats`, `job-sections`) are display rows
//     that never finish, so a user-started detection is never folded into them:
//     only a live detection the fixture created is reused;
//   - like the other handler modules, the queries do not refuse a suspended account
//     (fx-auth=suspended); every mutation applies the server's account rules.
// `db.jobs` holds done jobs too (the unapplied detection `job-detect-nightbus`,
// finished chains); listActive returns queued, running and failed jobs only.
import {db, fx, changed, clone, findSong, convexError} from './runtime.js';
import {PRESETS, STEM_MODES, resolveQuality, withDefaults} from '../../../convex/lib/presets.ts';

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

/** convex/jobs.ts detectionDevice: the chosen computer, else the most recently seen one (online first), else the only one. */
function detectionDevice(deviceId) {
  if (deviceId) return pairedDevice(deviceId);
  const devices = (db.devices ?? []).filter(d => !d.revoked);
  if (!devices.length) fail('device_unpaired', 'Connect the local companion first.');
  let best = null;
  for (const device of devices) {
    for (const p of (db.devicePresence ?? []).filter(row => row.deviceId === device.id)) {
      const next = {device, online: p.state !== 'offline', seen: p.lastSeenAt};
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

/** convex/jobs.ts needs a real map for sections: the seed's `mapSummary.real`, a stored map with an origin, or a drum chart. */
const hasRealMap = song => song.mapSummary?.real === true || !!song.tempo?.songMap?.origin || song.hasChart === true;

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

/** A live detection of this kind for the song that the fixture created (see the header). */
const liveDetection = (songId, kind) => db.jobs.find(j => j.jobId === `${kind}-${songId}` && isLive(j));

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

  'jobs:createSeparation': ({source: given, deviceId, settings: rawSettings, label, replaceSongId, meta: rawMeta, confirmed}) => {
    account({write: true});
    const song = replaceSongId ? ownSong(replaceSongId) : null;
    const source = given ?? song?.source;
    if (!source) fail('resplit_no_source', 'This song can’t be split again — its original audio is gone.');
    if (typeof label !== 'string' || label.length > LABEL_MAX) fail('invalid', `The label is too long (${LABEL_MAX} characters max).`, {field: 'label'});
    if (!String(source.value ?? '').trim() || source.value.length > SOURCE_MAX) fail('invalid', 'Source is too long.', {field: 'source'});
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
    // The computer claims it and reports the recording's details, as the companion's meta event would.
    setTimeout(() => {
      const j = db?.jobs.find(x => x.jobId === jobId);
      if (!j || j.status !== 'queued') return;
      const at = Date.now();
      Object.assign(j, {status: 'running', stage: 'download', percent: 8, message: 'Downloading audio…', attempts: 1, startedAt: at, updatedAt: at,
        meta: {...j.meta, title: j.meta?.title || (source.type === 'upload' ? source.filename : 'Harbor Lights'), channel: j.meta?.channel || 'Ada Moreno', duration: j.meta?.duration ?? 204}});
      changed();
    }, 1500);
    return {jobId};
  },

  'jobs:createBeatDetection': ({songId, deviceId}) => {
    account({write: true});
    const song = ownSong(songId);
    const live = liveDetection(songId, 'beats');
    if (live) return {jobId: live.jobId};
    const device = detectionDevice(deviceId);
    const sections = withDefaults(db.settings).autoSections !== false;
    const jobId = `beats-${songId}`;
    const ms = fx.detect === 'slow' ? 8000 : 1500, now = Date.now();
    db.jobs = db.jobs.filter(j => j.jobId !== jobId);
    db.jobs.push({jobId, kind: 'beats', songId, deviceId: device.id, status: 'running', stage: 'detect', percent: 20, message: 'Listening for beats…',
      label: `Finding bars — ${song.title}`, settings: {sections}, attempts: 1, createdAt: now, startedAt: now, updatedAt: now, finishAt: now + ms});
    changed();
    setTimeout(() => { if (settle()) changed(); }, ms);
    return {jobId};
  },

  'jobs:createSectionDetection': ({songId, deviceId}) => {
    account({write: true});
    const song = ownSong(songId);
    if (!hasRealMap(song)) fail('invalid', 'Find the bars before suggesting sections.');
    const live = liveDetection(songId, 'sections');
    if (live) return {jobId: live.jobId};
    const device = detectionDevice(deviceId);
    const jobId = `sections-${songId}`, now = Date.now();
    db.jobs = db.jobs.filter(j => j.jobId !== jobId);
    db.jobs.push({jobId, kind: 'sections', songId, deviceId: device.id, status: 'running', stage: 'detect', percent: 30, message: 'Suggesting sections…',
      label: `Finding sections — ${song.title}`, attempts: 1, createdAt: now, startedAt: now, updatedAt: now});
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
