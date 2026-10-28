// Fixture handlers for convex/devices.ts (BK3, architecture §6.6): pair, list,
// rename and revoke over the seed's `db.devices` and `db.devicePresence`
// (fx-devices=none|offline|online). They mirror the server: list joins presence
// and counts queued jobs (capped at 21), most recently seen first; rename trims
// to 1–80 characters; a user revoke re-pairs, an admin revoke does not. Errors
// are ConvexError look-alikes with the same codes and messages.
import {db, clone, convexError} from './runtime.js';

const NAME_MAX = 80, MAX_DEVICES = 20, QUEUED_COUNT_CAP = 21;
/** The fake local processor (fakes/companion.js) is paired as dev1. */
const PROCESSOR_ID = 'dev1';

const tidy = raw => String(raw ?? '').replace(/\s+/g, ' ').trim();
const userId = () => db.user?._id ?? 'user1';
const devices = () => (db.devices ??= []);
const presence = () => (db.devicePresence ??= []);

function ownDevice(deviceId) {
  const device = devices().find(d => d.id === deviceId);
  if (!device || device.userId !== userId()) throw convexError({code: 'not_found', message: 'Not your device.'});
  return device;
}

function row(d) {
  const p = presence().find(x => x.deviceId === d.id);
  const queued = (db.jobs ?? []).filter(j => j.deviceId === d.id && j.status === 'queued').length;
  return {
    deviceId: d.id, name: d.displayName ?? d.name,
    platform: p?.platform ?? null, appVersion: p?.appVersion ?? null, lastSeenAt: p?.lastSeenAt ?? null,
    state: p?.state ?? 'offline', currentJobId: p?.currentJobId ?? null,
    queued: Math.min(queued, QUEUED_COUNT_CAP),
  };
}

export const handlers = {
  'devices:list': () => devices()
    .filter(d => d.userId === userId() && !d.revoked)
    .slice(0, MAX_DEVICES)
    .map(d => ({row: row(d), created: d.createdAt ?? 0}))
    .sort((a, b) => (b.row.lastSeenAt ?? -Infinity) - (a.row.lastSeenAt ?? -Infinity) || b.created - a.created)
    .map(({row}) => clone(row)),

  'devices:pair': ({tokenHash, name}) => {
    if (!/^[a-f0-9]{64}$/.test(String(tokenHash ?? ''))) throw convexError({code: 'invalid', message: 'Invalid pairing code.'});
    const friendly = tidy(name).slice(0, NAME_MAX) || 'Computer';
    // The fixture has one local processor: a credential not seen before belongs to it.
    let device = devices().find(d => d.tokenHash === tokenHash) ?? devices().find(d => d.id === PROCESSOR_ID && !d.tokenHash);
    if (device) {
      if (device.userId !== userId()) throw convexError({code: 'device_other_account', message: 'This companion belongs to another account. Reset its pairing locally first.'});
      if (device.revoked && device.revokedBy === 'admin') throw convexError({code: 'device_revoked_admin', message: 'This computer was disconnected by an administrator.'});
      if (device.revoked && devices().filter(d => d.userId === userId() && !d.revoked).length >= MAX_DEVICES) throw convexError({code: 'device_limit', message: 'Device limit reached.', limit: MAX_DEVICES});
      Object.assign(device, {tokenHash, name: friendly, revoked: false});
      delete device.revokedBy;
      return device.id;
    }
    if (devices().filter(d => d.userId === userId() && !d.revoked).length >= MAX_DEVICES) throw convexError({code: 'device_limit', message: 'Device limit reached.', limit: MAX_DEVICES});
    const id = devices().some(d => d.id === PROCESSOR_ID) ? `dev-${tokenHash.slice(0, 6)}` : PROCESSOR_ID;
    devices().push({id, userId: userId(), tokenHash, name: friendly, revoked: false, createdAt: Date.now()});
    return id;
  },

  'devices:rename': ({deviceId, name}) => {
    const device = ownDevice(deviceId);
    const clean = tidy(name);
    if (!clean || clean.length > NAME_MAX) throw convexError({code: 'invalid', message: `Enter a name of 1–${NAME_MAX} characters.`, field: 'name'});
    device.displayName = clean;
    return null;
  },

  'devices:revoke': ({deviceId}) => {
    const device = ownDevice(deviceId);
    if (!device.revoked) Object.assign(device, {revoked: true, revokedBy: 'user'});
    return null;
  },
};
