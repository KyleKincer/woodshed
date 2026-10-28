// Jobs (convex/jobs.ts, architecture §6.4). One-line wrappers over
// src/api/client.js: every call sends exactly the contract arguments (unset
// optional ones are left out) and rejects with an ApiError (§2.1). The
// subscriptions return `off()`.
//
//   listActive()                                   → JobRow[]          queued, running and failed jobs, by createdAt
//   get({jobId})                                   → JobDetail | null  `result` only for a done detection
//   latestDetection({songId})                      → JobDetail | null  a done, user-started, unapplied beat detection (D44)
//   listUnappliedDetections()                      → JobDetail[]       every song's such detection, newest first, at most 20
//   createSeparation({source?, deviceId, settings, label, replaceSongId?, meta?, confirmed?}) → {jobId}
//   createBeatDetection({songId, deviceId?})       → {jobId}           an existing live detection is returned instead
//   createSectionDetection({songId, deviceId?})    → {jobId}           likewise; needs a real map
//   cancel({jobId}) → boolean · dismiss({jobId}) → boolean · retry({jobId, preset?, deviceId?}) → null · markApplied({jobId}) → null
//
// A JobRow: {jobId, kind, songId, label, status, stage, percent, message, error, meta, deviceId,
//   createdAt, startedAt, updatedAt, attempts, errorCode, retryAt, chainedFrom, confirmed,
//   source: {type, value, filename} | null, settingsSummary: {preset, stemMode, model} | null}.
// A JobDetail adds {result, appliedAt}.

import {mutation, query, subscribe} from './client.js';

/** Copies the listed keys whose value is not undefined. */
const pick = (args, keys) => {
  const out = {};
  for (const key of keys) if (args?.[key] !== undefined) out[key] = args[key];
  return out;
};

/** Statuses `listActive` returns. */
export const ACTIVE_STATUSES = Object.freeze(['queued', 'running', 'error']);
/** Statuses during which a job can still change on its own. */
export const isLive = job => job?.status === 'queued' || job?.status === 'running';

export const listActive = () => query('jobs:listActive', {});
export const get = ({jobId}) => query('jobs:get', {jobId});
export const latestDetection = ({songId}) => query('jobs:latestDetection', {songId});
export const listUnappliedDetections = () => query('jobs:listUnappliedDetections', {});

export const createSeparation = args => mutation('jobs:createSeparation', pick(args, ['source', 'deviceId', 'settings', 'label', 'replaceSongId', 'meta', 'confirmed']));
export const createBeatDetection = args => mutation('jobs:createBeatDetection', pick(args, ['songId', 'deviceId']));
export const createSectionDetection = args => mutation('jobs:createSectionDetection', pick(args, ['songId', 'deviceId']));
export const cancel = ({jobId}) => mutation('jobs:cancel', {jobId});
export const dismiss = ({jobId}) => mutation('jobs:dismiss', {jobId});
/** `Try again` / `Try now`; `Try Fast quality` passes `preset: 'fast'` (§2.10). */
export const retry = args => mutation('jobs:retry', pick(args, ['jobId', 'preset', 'deviceId']));
export const markApplied = ({jobId}) => mutation('jobs:markApplied', {jobId});

/** The live job list (store.library.jobs, S1 data.js). */
export const subscribeActive = (onValue, onError) => subscribe('jobs:listActive', {}, onValue, onError);
/** One job, while a flow waits on it (the detect flow, §2.14.1). */
export const subscribeJob = ({jobId}, onValue, onError) => subscribe('jobs:get', {jobId}, onValue, onError);
/** Detections waiting to be used, for the Library's Jobs model (LB1b). */
export const subscribeUnappliedDetections = (onValue, onError) => subscribe('jobs:listUnappliedDetections', {}, onValue, onError);
