import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { getUserId, requireUserId, requireWritableUserId, assertAccountAccess } from './lib/auth';
import { fail } from './lib/errors';
import { presenceStateValidator } from './lib/validators';

/**
 * Paired computers (B5, architecture §6.6).
 *
 * A device is a companion credential: the companion keeps a random 64-hex
 * token and the account stores only its SHA-256 (`tokenHash`). Every worker
 * call authenticates with the token through `requireDevice`.
 *
 * - `name` is the computer's friendly name, refreshed on every pair;
 *   `displayName` is the user's own name for it (`rename`).
 * - A user revoke is undone by pairing again; an admin revoke
 *   (`revokedBy: 'admin'`) is not (`device_revoked_admin`).
 * - Presence lives in `devicePresence` (D11), written by `worker.heartbeat`.
 *   `list` returns `lastSeenAt` and the client decides "online", so no query
 *   reads the clock.
 */

/** Paired (non-revoked) computers an account may hold at once. */
export const MAX_DEVICES = 20;
/** Device rows read per account; revoked rows count too, so every read stays bounded. */
export const MAX_DEVICE_ROWS = 100;
/** `name` and `displayName` length after trimming. */
export const NAME_MAX = 80;
/** Queued jobs counted per device in `list` (more than 20 reads as "20+"). */
export const QUEUED_COUNT_CAP = 21;

/** Audit entries scanned for a 1.9 admin revoke (newest first). */
const AUDIT_SCAN = 200;

const TOKEN_RE = /^[a-f0-9]{64}$/;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const UNPAIRED = 'Companion is not paired. Connect it in Settings.';

export async function hashToken(token: string) {
  if (!TOKEN_RE.test(token)) fail('invalid', 'Invalid companion credential.');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Who revoked a revoked device. 1.9 rows carry no `revokedBy`; for those the
 * admin audit log decides (an admin revoke always wrote a `device.revoke`
 * entry naming the device), so an administrator's 1.9 revoke keeps blocking
 * re-pairing. The lookup runs only for revoked rows without the field, and a
 * read never writes, so nothing needs a backfill.
 */
export async function revokedByOf(ctx: QueryCtx | MutationCtx, device: Doc<'devices'>): Promise<'user' | 'admin'> {
  if (device.revokedBy) return device.revokedBy;
  const entries = await ctx.db.query('adminAudit').withIndex('by_targetId', q => q.eq('targetId', device.userId)).order('desc').take(AUDIT_SCAN);
  const admin = entries.some(e => e.action === 'device.revoke' && isObject(e.before) && e.before.id === device._id);
  return admin ? 'admin' : 'user';
}

/** The device a companion token belongs to; refuses unknown, revoked and paused devices. */
export async function requireDevice(ctx: QueryCtx | MutationCtx, token: string) {
  const hash = await hashToken(token);
  const device = await ctx.db.query('devices').withIndex('by_token', q => q.eq('tokenHash', hash)).unique();
  if (!device) fail('device_unpaired', UNPAIRED);
  if (device.revoked) {
    if (await revokedByOf(ctx, device) === 'admin') fail('device_revoked_admin', 'Companion is not paired. This computer was disconnected by an administrator.');
    fail('device_unpaired', UNPAIRED);
  }
  await assertAccountAccess(ctx, device.userId, true);
  return device;
}

/** Whitespace runs collapse, so a pasted name never wraps oddly. */
const tidy = (raw: string) => raw.replace(/\s+/g, ' ').trim();

async function ownDevice(ctx: QueryCtx | MutationCtx, userId: string, deviceId: Id<'devices'>) {
  const device = await ctx.db.get('devices', deviceId);
  if (!device || device.userId !== userId) fail('not_found', 'Not your device.');
  return device;
}

export const pair = mutation({
  args: { tokenHash: v.string(), name: v.string() }, returns: v.id('devices'),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);
    if (!TOKEN_RE.test(args.tokenHash)) fail('invalid', 'Invalid pairing code.');
    const name = tidy(args.name).slice(0, NAME_MAX) || 'Computer';
    const existing = await ctx.db.query('devices').withIndex('by_token', q => q.eq('tokenHash', args.tokenHash)).unique();
    if (existing) {
      if (existing.userId !== userId) fail('device_other_account', 'This companion belongs to another account. Reset its pairing locally first.');
      if (existing.revoked && await revokedByOf(ctx, existing) === 'admin') fail('device_revoked_admin', 'This computer was disconnected by an administrator.');
      // A user-revoked computer re-pairs; the friendly name follows the computer.
      await ctx.db.patch('devices', existing._id, { revoked: false, revokedBy: undefined, name });
      return existing._id;
    }
    const rows = await ctx.db.query('devices').withIndex('by_user', q => q.eq('userId', userId)).take(MAX_DEVICE_ROWS);
    if (rows.length >= MAX_DEVICE_ROWS || rows.filter(d => !d.revoked).length >= MAX_DEVICES) {
      fail('device_limit', 'Device limit reached.', { limit: MAX_DEVICES });
    }
    return await ctx.db.insert('devices', { userId, tokenHash: args.tokenHash, name, revoked: false });
  },
});

export const identity = query({
  args: { token: v.string() }, returns: v.object({ userId: v.string(), deviceId: v.id('devices') }),
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    return { userId: device.userId, deviceId: device._id };
  },
});

/** One `devices.list` row. */
export const deviceRowValidator = v.object({
  deviceId: v.id('devices'),
  name: v.string(),
  platform: v.union(v.string(), v.null()),
  appVersion: v.union(v.string(), v.null()),
  lastSeenAt: v.union(v.number(), v.null()),
  state: presenceStateValidator,
  currentJobId: v.union(v.id('jobs'), v.null()),
  queued: v.number(),
});

/**
 * The caller's paired computers joined with their presence, most recently
 * seen first (never-seen computers last, newest pairing first). Signed out → [].
 * A computer that never sent a heartbeat reads `state: 'offline'`.
 */
export const list = query({
  args: {}, returns: v.array(deviceRowValidator),
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    if (!userId) return [];
    const devices = (await ctx.db.query('devices').withIndex('by_user', q => q.eq('userId', userId)).take(MAX_DEVICE_ROWS))
      .filter(d => !d.revoked).slice(0, MAX_DEVICES);
    const rows = await Promise.all(devices.map(async d => {
      const presence = await ctx.db.query('devicePresence').withIndex('by_deviceId', q => q.eq('deviceId', d._id)).unique();
      const queued = await ctx.db.query('jobs').withIndex('by_device_status', q => q.eq('deviceId', d._id).eq('status', 'queued')).take(QUEUED_COUNT_CAP);
      const row = {
        deviceId: d._id,
        name: d.displayName ?? d.name,
        platform: presence?.platform ?? null,
        appVersion: presence?.appVersion ?? null,
        lastSeenAt: presence?.lastSeenAt ?? null,
        state: presence?.state ?? ('offline' as const),
        currentJobId: presence?.currentJobId ?? null,
        queued: queued.length,
      };
      return { row, created: d._creationTime };
    }));
    rows.sort((a, b) => (b.row.lastSeenAt ?? -Infinity) - (a.row.lastSeenAt ?? -Infinity) || b.created - a.created);
    return rows.map(r => r.row);
  },
});

/** The user's own name for a computer (1–80 characters after trimming). Export-only accounts may rename (D10). */
export const rename = mutation({
  args: { deviceId: v.id('devices'), name: v.string() }, returns: v.null(),
  handler: async (ctx, { deviceId, name }) => {
    const userId = await requireUserId(ctx);
    const device = await ownDevice(ctx, userId, deviceId);
    const clean = tidy(name);
    if (!clean || clean.length > NAME_MAX) fail('invalid', `Enter a name of 1–${NAME_MAX} characters.`, { field: 'name' });
    if (device.displayName !== clean) await ctx.db.patch('devices', deviceId, { displayName: clean });
    return null;
  },
});

/** Disconnect a computer. Pairing it again reconnects it, unless an administrator disconnected it. */
export const revoke = mutation({
  args: { deviceId: v.id('devices') }, returns: v.null(),
  handler: async (ctx, { deviceId }) => {
    const userId = await requireUserId(ctx);
    const device = await ownDevice(ctx, userId, deviceId);
    // Already revoked (by the user or an administrator): nothing changes, so an admin revoke stays an admin revoke.
    if (device.revoked) return null;
    await ctx.db.patch('devices', deviceId, { revoked: true, revokedBy: 'user' });
    return null;
  },
});
