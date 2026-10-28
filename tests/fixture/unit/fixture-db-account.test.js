// @vitest-environment happy-dom
// The fixture's account handlers (db/account.js): users:me in convex/users.ts's shape and the
// stateful Administration backend the full app's /admin routes run on (ticket I2a-9).
import {describe, it, expect, beforeEach} from 'vitest';

const {boot, call, persist, STORAGE_KEY} = await import('../db/index.js');
const runtime = await import('../db/runtime.js');

const NOW = Date.parse('2026-10-28T09:00:00Z');
const DAY = 864e5;

class MemoryStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

let store;
beforeEach(() => { store = new MemoryStorage(); boot({search: '?fx-admin=1', store, now: NOW}); });

const q = (name, args = {}) => call('query', name, args);
const m = (name, args) => call('mutation', name, args);
const page = (numItems = 25, cursor = null) => ({paginationOpts: {numItems, cursor}});
const codeOf = promise => promise.then(() => 'resolved', e => e?.data?.code ?? 'uncoded');

describe('users:me', () => {
  it('returns `id` like convex/users.ts, never the stored `_id`, and no null picture', async () => {
    const me = await q('users:me');
    expect(me).toEqual({id: 'user1', name: 'Kyle Kincer', email: 'kyle@example.com', status: 'active'});
    expect(me).not.toHaveProperty('_id');
    runtime.db.user.picture = 'https://example.com/me.png';
    expect((await q('users:me')).picture).toBe('https://example.com/me.png');
  });
});

describe('admin access', () => {
  it('refuses every admin query and mutation without fx-admin=1, as requireAdmin does', async () => {
    boot({search: '', store, now: NOW});
    expect(await q('admin:access')).toBe(false);
    for (const [kind, name, args] of [['query', 'admin:overview', {}], ['query', 'admin:accounts', page()], ['query', 'admin:account', {id: 'user2'}],
      ['query', 'admin:history', page()], ['mutation', 'admin:updatePolicy', {userBytes: 1, appBytes: 1, reason: 'why not'}]])
      expect(await codeOf(call(kind, name, args)), name).toBe('not_owner');
  });
});

describe('admin:accounts', () => {
  it('lists newest first and pages with continueCursor', async () => {
    const first = await q('admin:accounts', page(3));
    expect(first.page.map(r => r.id)).toEqual(['user4', 'user3', 'user2']);
    expect(first).toMatchObject({isDone: false, continueCursor: '3'});
    expect(first.page[1]).toEqual({id: 'user3', name: '', email: 'sam.l@example.com', createdAt: NOW - 60 * DAY, status: 'export_only', usedBytes: 2.1e9, limitBytes: 1e9, admin: false});
    const second = await q('admin:accounts', page(3, first.continueCursor));
    expect(second).toEqual(expect.objectContaining({isDone: true, continueCursor: null}));
    expect(second.page.map(r => r.id)).toEqual(['user1']);
    expect(second.page[0].admin).toBe(true);
  });
  it('filters by exact email (trimmed)', async () => {
    expect((await q('admin:accounts', {...page(), email: ' dana@example.com '})).page.map(r => r.id)).toEqual(['user2']);
    expect((await q('admin:accounts', {...page(), email: 'dana@example'})).page).toEqual([]);
  });
});

describe('admin:account', () => {
  it('uses its id', async () => {
    const kyle = await q('admin:account', {id: 'user1'});
    expect(kyle).toMatchObject({id: 'user1', name: 'Kyle Kincer', admin: true, devices: [], jobs: []});
    const dana = await q('admin:account', {id: 'user2'});
    expect(dana).toMatchObject({id: 'user2', name: 'Dana Ruiz', emailVerified: true, createdAt: NOW - 120 * DAY, status: 'active', byteLimit: null, notes: 'Beta tester. Asked about FLAC export.', usedBytes: 980e6, limitBytes: 1e9});
    expect((await q('admin:account', {id: 'user3'})).status).toBe('export_only');
  });
  it('a missing well-formed id is not_found; a malformed one fails with the uncoded validator error', async () => {
    expect(await codeOf(q('admin:account', {id: 'nobody'}))).toBe('not_found');
    expect(await codeOf(q('admin:account', {id: 'user99'}))).toBe('not_found');
    const malformed = await q('admin:account', {id: 'not-an-id'}).catch(e => e);
    expect(malformed.data).toBeUndefined();
    expect(malformed.message).toMatch(/Validator error: Expected ID for table "users"/);
  });
  it('device rows carry revokedBy and lastSeenAt; job rows carry retryAt; no userId leaks', async () => {
    const {devices, jobs} = await q('admin:account', {id: 'user2'});
    expect(devices.map(d => [d.id, d.revoked, d.revokedBy, d.lastSeenAt])).toEqual([
      ['d1', false, null, NOW - 20_000], ['d2', false, null, NOW - 3 * DAY], ['d3', true, 'user', NOW - 90 * DAY], ['d4', true, 'admin', null], ['d5', false, null, null]]);
    expect(jobs.map(j => j.id)).toEqual(['j3', 'j1', 'j2', 'j4', 'j5', 'j6']);
    expect(jobs.find(j => j.id === 'j2')).toMatchObject({status: 'error', retryAt: NOW + 5 * 6e4});
    for (const row of [...devices, ...jobs]) expect(row).not.toHaveProperty('userId');
  });
});

describe('admin:history', () => {
  it('rows have _id, before and after, newest first, and filter by targetId', async () => {
    const all = await q('admin:history', page());
    expect(all.page.map(r => r._id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    for (const row of all.page) expect(row).toEqual(expect.objectContaining({before: expect.anything(), after: expect.anything(), actorId: expect.any(String), at: expect.any(Number)}));
    expect((await q('admin:history', {...page(), targetId: 'user2'})).page.map(r => r._id)).toEqual(['a3', 'a4']);
    expect((await q('admin:history', {...page(), targetId: 'app'})).page.map(r => r.action)).toEqual(['policy.update']);
    expect(await q('admin:history', page(2))).toMatchObject({isDone: false, continueCursor: '2'});
  });
});

describe('admin mutations', () => {
  it('updateAccount writes the control and the audit log, and refuses what the server refuses', async () => {
    await m('admin:updateAccount', {id: 'user2', status: 'export_only', byteLimit: 2e9, notes: 'Upgraded.', reason: '  Support ticket  '});
    expect(await q('admin:account', {id: 'user2'})).toMatchObject({status: 'export_only', byteLimit: 2e9, limitBytes: 2e9, notes: 'Upgraded.'});
    const [row] = (await q('admin:history', {...page(), targetId: 'user2'})).page;
    expect(row).toMatchObject({action: 'account.update', actorId: 'user1', reason: 'Support ticket', at: expect.any(Number),
      before: {status: 'active', byteLimit: null, notes: 'Beta tester. Asked about FLAC export.'}, after: {status: 'export_only', byteLimit: 2e9, notes: 'Upgraded.'}});
    expect(row._id).toMatch(/^a\d+$/);
    const base = {id: 'user2', status: 'active', byteLimit: null, notes: '', reason: 'a reason'};
    const reasonError = await m('admin:updateAccount', {...base, reason: 'no'}).catch(e => e);
    expect(reasonError.data).toMatchObject({code: 'invalid', field: 'reason'});
    expect(await codeOf(m('admin:updateAccount', {...base, id: 'user1', status: 'suspended'}))).toBe('invalid');
    expect(await codeOf(m('admin:updateAccount', {...base, byteLimit: -1}))).toBe('invalid');
    expect((await m('admin:updateAccount', {...base, notes: 'x'.repeat(4001)}).catch(e => e)).data).toMatchObject({code: 'invalid', field: 'notes'});
    expect(await codeOf(m('admin:updateAccount', {...base, id: 'nobody'}))).toBe('not_found');
  });
  it('updatePolicy changes the overview and every account without an override', async () => {
    expect(await q('admin:overview')).toEqual({baseAppBytes: 150e9, fundedBytes: 50e9, userBytes: 1e9, appBytes: 200e9, usedBytes: 61.2e9});
    await m('admin:updatePolicy', {userBytes: 2e9, appBytes: 160e9, reason: 'Launch week'});
    expect(await q('admin:overview')).toMatchObject({userBytes: 2e9, baseAppBytes: 160e9, appBytes: 210e9});
    expect((await q('admin:account', {id: 'user4'})).limitBytes).toBe(2e9);
    const [row] = (await q('admin:history', {...page(), targetId: 'app'})).page;
    expect(row).toMatchObject({action: 'policy.update', before: {userBytes: 1e9, appBytes: 200e9}, after: {userBytes: 2e9, appBytes: 160e9}});
    expect(await codeOf(m('admin:updatePolicy', {userBytes: 1.5, appBytes: 1, reason: 'Launch week'}))).toBe('invalid');
  });
  it('revokeDevice marks an admin revoke; cancelJob cancels a live job (a bot-check retry included) only', async () => {
    await m('admin:revokeDevice', {id: 'd1', reason: 'Lost laptop'});
    expect((await q('admin:account', {id: 'user2'})).devices[0]).toMatchObject({id: 'd1', revoked: true, revokedBy: 'admin'});
    expect(await codeOf(m('admin:revokeDevice', {id: 'dx', reason: 'Lost laptop'}))).toBe('not_found');
    await m('admin:cancelJob', {id: 'j2', reason: 'Stuck download'});
    const j2 = (await q('admin:account', {id: 'user2'})).jobs.find(j => j.id === 'j2');
    expect(j2.status).toBe('canceled');
    expect(j2).not.toHaveProperty('retryAt');
    for (const id of ['j2', 'j4', 'j5', 'jx']) expect(await codeOf(m('admin:cancelJob', {id, reason: 'Stuck download'})), id).toBe('invalid');
    const actions = (await q('admin:history', {...page(), targetId: 'user2'})).page.slice(0, 2);
    expect(actions.map(r => [r.action, r.before])).toEqual([['job.cancel', {id: 'j2', status: 'error'}], ['device.revoke', {id: 'd1', revoked: false, revokedBy: null}]]);
  });
  it('results are copies, and the admin tables persist with the db across a reload', async () => {
    const dana = await q('admin:account', {id: 'user2'});
    dana.devices[0].name = 'changed';
    (await q('admin:history', page())).page[0].reason = 'changed';
    expect((await q('admin:account', {id: 'user2'})).devices[0].name).toBe('Dana’s MacBook Pro');
    expect((await q('admin:history', page())).page[0].reason).toBe('Raise default limit for launch');
    await m('admin:revokeDevice', {id: 'd2', reason: 'Sold it'});
    persist();
    expect(JSON.parse(store.getItem(STORAGE_KEY)).data.admin.devices[1].revokedBy).toBe('admin');
    expect(boot({search: '?fx-admin=1', store, now: NOW + DAY}).restored).toBe(true);
    expect((await q('admin:account', {id: 'user2'})).devices[1].revokedBy).toBe('admin');
  });
});
