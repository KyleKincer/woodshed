// Paired computers (B5; architecture §2.1, §6.6). One-line wrappers over the
// Convex `devices` module, plus the client's "online" rule: presence is a
// `lastSeenAt` the server never compares with the clock (D11), so the client
// decides and re-evaluates every RECHECK_MS with `now` from src/app/clock.js.
//
// A list row: {deviceId, name, platform, appVersion, lastSeenAt: number|null,
//   state: 'idle'|'busy'|'offline', currentJobId: string|null, queued /* ≤ 21 */}.

import {mutation, query, subscribe} from './client.js';

/** A computer is online while its last heartbeat is younger than this (and it did not say offline). */
export const ONLINE_WINDOW_MS = 150_000;
/** How often a view re-evaluates `isOnline` while it shows devices. */
export const RECHECK_MS = 30_000;
/** `queued` is counted up to this; at the cap it means "more than 20". */
export const QUEUED_COUNT_CAP = 21;

/** The caller's paired computers, most recently seen first. */
export const list = () => query('devices:list', {});

/** Live `list` (data.js keeps it in store.library.devices). Returns off(). */
export const subscribeList = (onValue, onError) => subscribe('devices:list', {}, onValue, onError);

/** Pair this computer's companion credential (its SHA-256) under its friendly name. Returns the device id. */
export const pair = ({tokenHash, name}) => mutation('devices:pair', {tokenHash, name});

/** The user's own name for a computer (1–80 characters after trimming; `invalid` with `field: 'name'` otherwise). */
export const rename = ({deviceId, name}) => mutation('devices:rename', {deviceId, name});

/** Disconnect a computer. Pairing it again reconnects it unless an administrator disconnected it. */
export const revoke = ({deviceId}) => mutation('devices:revoke', {deviceId});

/** `state !== 'offline' && now − lastSeenAt < ONLINE_WINDOW_MS`; a computer never seen is offline. */
export function isOnline(device, now) {
  if (!device || device.state === 'offline' || typeof device.lastSeenAt !== 'number' || !Number.isFinite(now)) return false;
  return now - device.lastSeenAt < ONLINE_WINDOW_MS;
}

/** The online computers of a list, in list order (most recently seen first). */
export const onlineDevices = (devices, now) => (Array.isArray(devices) ? devices : []).filter(d => isOnline(d, now));
