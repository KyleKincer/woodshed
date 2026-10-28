/// <reference types="vite/client" />
// BK3: paired computers (B5, architecture §6.6): pairing and its coded
// refusals, devices.list joined with presence, rename, user and admin
// revokes, the admin account view, and the coded storage failures.
import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { afterEach, describe, expect, test, vi } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { hashToken, MAX_DEVICES } from './devices';

const modules = import.meta.glob('./**/*.ts');
afterEach(() => vi.unstubAllEnvs());

const tokenOf = (n: number) => n.toString(16).padStart(64, '0');

async function caught(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    return (error as ConvexError<any>).data as Record<string, unknown>;
  }
  throw new Error('expected a coded failure');
}

async function setup() {
  const t = convexTest(schema, modules);
  const [ownerId, aliceId, bobId] = await t.run(ctx => Promise.all(['owner', 'alice', 'bob'].map(name =>
    ctx.db.insert('users', { name, email: `${name}@test.example`, emailVerified: true, createdAt: 1 }))));
  vi.stubEnv('ADMIN_USER_IDS', ownerId);
  const owner = t.withIdentity({ subject: ownerId }), alice = t.withIdentity({ subject: aliceId }), bob = t.withIdentity({ subject: bobId });
  const pair = async (client = alice, n = 1, name = 'Kyle’s MacBook Pro') => client.mutation(api.devices.pair, { tokenHash: await hashToken(tokenOf(n)), name });
  const getDevice = (id: Id<'devices'>) => t.run(ctx => ctx.db.get('devices', id));
  const presence = (deviceId: Id<'devices'>, userId: string, fields: Record<string, unknown>) =>
    t.run(ctx => ctx.db.insert('devicePresence', { deviceId, userId, lastSeenAt: 0, state: 'idle', ...fields } as never));
  return { t, owner, alice, bob, ownerId, aliceId, bobId, pair, getDevice, presence };
}

describe('devices.pair', () => {
  test('pairs a computer with a tidied, capped friendly name; re-pairing refreshes the name', async () => {
    const s = await setup();
    const id = await s.pair(s.alice, 1, `  Studio\n  Mac ${'x'.repeat(100)}`);
    const row = (await s.getDevice(id))!;
    expect(row).toMatchObject({ userId: s.aliceId, revoked: false });
    expect(row.name).toBe(`Studio Mac ${'x'.repeat(100)}`.slice(0, 80));
    expect(await s.pair(s.alice, 1, 'Renamed in System Settings')).toBe(id);
    expect((await s.getDevice(id))!.name).toBe('Renamed in System Settings');
    expect((await s.getDevice(await s.pair(s.alice, 2, '   ')))!.name).toBe('Computer');
  });

  test('coded refusals: another account, a bad code, the device limit, export-only and signed-out callers', async () => {
    const s = await setup();
    await s.pair(s.alice, 1);
    expect(await caught(s.pair(s.bob, 1))).toMatchObject({ code: 'device_other_account', message: expect.stringContaining('another account') });
    expect((await caught(s.alice.mutation(api.devices.pair, { tokenHash: 'nope', name: 'x' }))).code).toBe('invalid');
    for (let n = 2; n <= MAX_DEVICES; n++) await s.pair(s.alice, n);
    expect(await caught(s.pair(s.alice, 99))).toMatchObject({ code: 'device_limit', limit: MAX_DEVICES });
    // A revoked computer frees its place.
    const [first] = await s.alice.query(api.devices.list, {});
    await s.alice.mutation(api.devices.revoke, { deviceId: first.deviceId });
    await expect(s.pair(s.alice, 99)).resolves.toBeTruthy();
    await s.owner.mutation(api.admin.updateAccount, { id: s.bobId as Id<'users'>, status: 'export_only', byteLimit: null, notes: '', reason: 'Access review' });
    expect((await caught(s.pair(s.bob, 200))).code).toBe('account_export_only');
    expect((await caught(s.t.mutation(api.devices.pair, { tokenHash: await hashToken(tokenOf(300)), name: 'x' }))).code).toBe('not_signed_in');
  });
});

describe('devices.list', () => {
  test('returns the contract shape joined with presence, most recently seen first', async () => {
    const s = await setup();
    const mac = await s.pair(s.alice, 1, 'Kyle’s MacBook Pro');
    const pc = await s.pair(s.alice, 2, 'DESKTOP-4F2K9');
    const fresh = await s.pair(s.alice, 3, 'New Laptop');
    await s.alice.mutation(api.devices.rename, { deviceId: mac, name: 'Studio MacBook' });
    const running = await s.t.run(ctx => ctx.db.insert('jobs', { userId: s.aliceId, deviceId: mac, kind: 'separate', label: 'x', status: 'running', stage: 'separate', percent: 40, createdAt: 1, updatedAt: 1 }));
    await s.presence(mac, s.aliceId, { lastSeenAt: 5_000, state: 'busy', currentJobId: running, appVersion: '2.0.0', platform: 'darwin-arm64', accelerator: 'Apple GPU' });
    await s.presence(pc, s.aliceId, { lastSeenAt: 9_000, state: 'offline', appVersion: '1.9.0', platform: 'win32-x64' });
    await s.t.run(async ctx => {
      for (let i = 0; i < 25; i++) await ctx.db.insert('jobs', { userId: s.aliceId, deviceId: pc, kind: 'separate', label: `q${i}`, status: 'queued', stage: 'queued', percent: 0, createdAt: i, updatedAt: i });
      await ctx.db.insert('jobs', { userId: s.aliceId, deviceId: mac, kind: 'beats', label: 'q', status: 'queued', stage: 'queued', percent: 0, createdAt: 1, updatedAt: 1 });
    });
    expect(await s.alice.query(api.devices.list, {})).toEqual([
      { deviceId: pc, name: 'DESKTOP-4F2K9', platform: 'win32-x64', appVersion: '1.9.0', lastSeenAt: 9_000, state: 'offline', currentJobId: null, queued: 21 },
      { deviceId: mac, name: 'Studio MacBook', platform: 'darwin-arm64', appVersion: '2.0.0', lastSeenAt: 5_000, state: 'busy', currentJobId: running, queued: 1 },
      { deviceId: fresh, name: 'New Laptop', platform: null, appVersion: null, lastSeenAt: null, state: 'offline', currentJobId: null, queued: 0 },
    ]);
  });

  test('a real heartbeat shows up; revoked and foreign computers do not; signed out is empty', async () => {
    const s = await setup();
    const mac = await s.pair(s.alice, 1);
    const old = await s.pair(s.alice, 2);
    await s.pair(s.bob, 3);
    await s.alice.mutation(api.devices.revoke, { deviceId: old });
    await s.t.mutation(api.worker.heartbeat, { token: tokenOf(1), state: 'idle', appVersion: '2.0.0', platform: 'darwin-arm64' });
    const rows = await s.alice.query(api.devices.list, {});
    expect(rows.map(r => r.deviceId)).toEqual([mac]);
    expect(rows[0]).toMatchObject({ state: 'idle', appVersion: '2.0.0', platform: 'darwin-arm64' });
    expect(rows[0].lastSeenAt).toBeGreaterThan(0);
    expect(await s.t.query(api.devices.list, {})).toEqual([]);
  });

  test('re-pairing a user-revoked computer takes a place again, so the limit applies', async () => {
    const s = await setup();
    const first = await s.pair(s.alice, 1);
    for (let n = 2; n <= MAX_DEVICES; n++) await s.pair(s.alice, n);
    await s.alice.mutation(api.devices.revoke, { deviceId: first });
    await s.pair(s.alice, 99); // the freed place
    expect(await caught(s.pair(s.alice, 1))).toMatchObject({ code: 'device_limit', limit: MAX_DEVICES });
    expect((await s.getDevice(first))!.revoked).toBe(true);
    const listed = await s.alice.query(api.devices.list, {});
    expect(listed).toHaveLength(MAX_DEVICES);
    // An active computer re-pairing (a name refresh) never counts against itself.
    expect(await s.pair(s.alice, 2, 'Renamed')).toBeDefined();
  });
});

describe('devices.rename', () => {
  test('sets the display name (1–80 after trimming) for the owner only', async () => {
    const s = await setup();
    const id = await s.pair(s.alice, 1, 'Kyle’s MacBook Pro');
    await s.alice.mutation(api.devices.rename, { deviceId: id, name: '  Studio   MacBook ' });
    expect(await s.getDevice(id)).toMatchObject({ name: 'Kyle’s MacBook Pro', displayName: 'Studio MacBook' });
    await s.alice.mutation(api.devices.rename, { deviceId: id, name: 'x'.repeat(80) });
    expect((await s.getDevice(id))!.displayName).toHaveLength(80);
    for (const name of ['', '   ', 'x'.repeat(81)]) {
      expect(await caught(s.alice.mutation(api.devices.rename, { deviceId: id, name }))).toMatchObject({ code: 'invalid', field: 'name' });
    }
    expect((await caught(s.bob.mutation(api.devices.rename, { deviceId: id, name: 'Mine now' }))).code).toBe('not_found');
    // Re-pairing refreshes the friendly name but keeps the user's own.
    await s.pair(s.alice, 1, 'MacBook Pro (2)');
    expect(await s.getDevice(id)).toMatchObject({ name: 'MacBook Pro (2)', displayName: 'x'.repeat(80) });
  });
});

describe('revoking (B5)', () => {
  test('a user revoke disconnects the companion; pairing again reconnects it', async () => {
    const s = await setup();
    const id = await s.pair(s.alice, 1);
    await s.alice.mutation(api.devices.revoke, { deviceId: id });
    expect(await s.getDevice(id)).toMatchObject({ revoked: true, revokedBy: 'user' });
    expect(await caught(s.t.query(api.worker.next, { token: tokenOf(1) }))).toMatchObject({ code: 'device_unpaired', message: expect.stringContaining('not paired') });
    expect(await s.pair(s.alice, 1)).toBe(id);
    const row = (await s.getDevice(id))!;
    expect(row.revoked).toBe(false);
    expect(row.revokedBy).toBeUndefined();
    expect(await s.t.query(api.worker.next, { token: tokenOf(1) })).toBeNull();
    expect((await caught(s.bob.mutation(api.devices.revoke, { deviceId: id }))).code).toBe('not_found');
  });

  test('an admin revoke refuses re-pairing, and a later user revoke keeps it an admin revoke', async () => {
    const s = await setup();
    const id = await s.pair(s.alice, 1);
    await s.owner.mutation(api.admin.revokeDevice, { id, reason: 'Lost computer' });
    expect(await s.getDevice(id)).toMatchObject({ revoked: true, revokedBy: 'admin' });
    expect(await caught(s.pair(s.alice, 1))).toEqual({ code: 'device_revoked_admin', message: 'This computer was disconnected by an administrator.' });
    expect(await caught(s.t.query(api.worker.next, { token: tokenOf(1) }))).toMatchObject({ code: 'device_revoked_admin', message: expect.stringContaining('not paired') });
    await s.alice.mutation(api.devices.revoke, { deviceId: id });
    expect((await s.getDevice(id))!.revokedBy).toBe('admin');
    expect((await caught(s.pair(s.alice, 1))).code).toBe('device_revoked_admin');
    const [audit] = (await s.owner.query(api.admin.history, { paginationOpts: { cursor: null, numItems: 10 } })).page;
    expect(audit).toMatchObject({ action: 'device.revoke', before: { revoked: false, revokedBy: null }, after: { revoked: true, revokedBy: 'admin' } });
  });

  test('1.9 revoked rows (no revokedBy) read as user revokes, whatever the audit log says, and pair again', async () => {
    const s = await setup();
    // 1.9 let any revoked computer pair again, so an old admin audit entry may
    // be one the user since paired over and revoked themselves.
    const id = await s.pair(s.alice, 1);
    await s.t.run(async ctx => {
      await ctx.db.insert('adminAudit', { actorId: s.ownerId, targetId: s.aliceId, action: 'device.revoke', reason: 'Lost computer', before: { id, revoked: false }, after: { revoked: true }, at: 1 });
      await ctx.db.patch('devices', id, { revoked: true });
    });
    expect((await caught(s.t.query(api.worker.next, { token: tokenOf(1) }))).code).toBe('device_unpaired');
    const account = await s.owner.query(api.admin.account, { id: s.aliceId as Id<'users'> });
    expect(account.devices[0]).toMatchObject({ id, revoked: true, revokedBy: 'user' });
    expect(await s.pair(s.alice, 1)).toBe(id);
    expect((await s.getDevice(id))!.revoked).toBe(false);
  });

  test('admin.account device rows carry lastSeenAt and revokedBy', async () => {
    const s = await setup();
    const mac = await s.pair(s.alice, 1, 'Mac');
    const pc = await s.pair(s.alice, 2, 'PC');
    await s.presence(mac, s.aliceId, { lastSeenAt: 7_000 });
    await s.alice.mutation(api.devices.revoke, { deviceId: pc });
    const account = await s.owner.query(api.admin.account, { id: s.aliceId as Id<'users'> });
    expect(account.devices).toEqual([
      { id: mac, name: 'Mac', revoked: false, revokedBy: null, lastSeenAt: 7_000 },
      { id: pc, name: 'PC', revoked: true, revokedBy: 'user', lastSeenAt: null },
    ]);
  });
});

describe('coded failures (§6.1)', () => {
  test('a malformed token is invalid; storage limits are storage_full_user and storage_full_app', async () => {
    const s = await setup();
    expect((await caught(s.t.query(api.worker.next, { token: 'short' }))).code).toBe('invalid');
    const deviceId = await s.pair(s.alice, 1);
    const job = () => s.t.run(ctx => ctx.db.insert('jobs', { userId: s.aliceId, deviceId, kind: 'separate', label: 'x', status: 'running', stage: 'separate', percent: 0, createdAt: 1, updatedAt: 1 }));
    const file = (bytes: number, name = 'drums.webm') => ({ name, bytes, mime: 'audio/webm', checksum: 'a'.repeat(43) + '=' });
    vi.stubEnv('CLOUD_USER_BYTE_LIMIT', '100'); vi.stubEnv('CLOUD_APP_BYTE_LIMIT', '150');
    expect(await caught(s.t.mutation(internal.storage.reserve, { token: tokenOf(1), jobId: await job(), files: [file(101)] }))).toMatchObject({ code: 'storage_full_user', message: expect.stringContaining('library is full') });
    vi.stubEnv('CLOUD_APP_BYTE_LIMIT', '50');
    expect(await caught(s.t.mutation(internal.storage.reserve, { token: tokenOf(1), jobId: await job(), files: [file(60)] }))).toMatchObject({ code: 'storage_full_app', message: expect.stringContaining('Cloud storage') });
    expect((await caught(s.t.mutation(internal.storage.reserve, { token: tokenOf(1), jobId: await job(), files: [file(1, 'evil.exe')] }))).code).toBe('invalid');
  });
});
