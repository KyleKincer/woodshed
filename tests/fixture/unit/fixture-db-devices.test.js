// @vitest-environment happy-dom
// The fixture's devices handlers (tests/fixture/db/devices.js, BK3) mirror
// convex/devices.ts: the list row shape and order, the seed's
// fx-devices modes, rename and revoke rules, and pairing.
import {describe, it, expect, beforeEach} from 'vitest';

globalThis.__FX_DB_MANUAL_BOOT__ = true;
const {boot, call} = await import('../db/index.js');
const runtime = await import('../db/runtime.js');
const {deviceRowValidator} = await import('../../../convex/devices.ts');

const NOW = Date.parse('2026-10-28T09:00:00Z');
const store = () => ({map: new Map(), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, String(v)); }, removeItem(k) { this.map.delete(k); }});
const start = (search = '') => boot({search, store: store(), now: NOW});
const codeOf = promise => promise.then(() => null, error => error.data?.code ?? error.message);

describe('devices:list', () => {
  beforeEach(() => start());

  it('returns exactly the server row fields, most recently seen first', async () => {
    const rows = await call('query', 'devices:list');
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(Object.keys(deviceRowValidator.fields).sort());
    expect(rows.map(r => r.deviceId)).toEqual(['dev1', 'dev2']);
    expect(rows[0]).toMatchObject({name: 'Studio MacBook', state: 'busy', currentJobId: 'job-run', appVersion: '2.0.0', platform: 'darwin-arm64'});
    expect(rows[1]).toMatchObject({name: 'DESKTOP-4F2K9', state: 'offline', currentJobId: null});
    const queued = runtime.db.jobs.filter(j => j.status === 'queued');
    expect(rows[0].queued).toBe(queued.filter(j => j.deviceId === 'dev1').length);
    expect(rows[1].queued).toBe(queued.filter(j => j.deviceId === 'dev2').length);
  });

  it('follows fx-devices', async () => {
    start('?fx-devices=none');
    expect(await call('query', 'devices:list')).toEqual([]);
    start('?fx-devices=offline');
    expect((await call('query', 'devices:list')).map(r => r.state)).toEqual(['offline', 'offline']);
    start('?fx-devices=online');
    expect((await call('query', 'devices:list')).every(r => r.state !== 'offline')).toBe(true);
  });

  it('caps the queued count at 21', async () => {
    for (let i = 0; i < 30; i++) runtime.db.jobs.push({jobId: `q${i}`, kind: 'separate', status: 'queued', stage: 'queued', percent: 0, deviceId: 'dev2', createdAt: i, updatedAt: i});
    expect((await call('query', 'devices:list')).find(r => r.deviceId === 'dev2').queued).toBe(21);
  });
});

describe('rename, revoke, pair', () => {
  beforeEach(() => start());

  it('rename trims and validates like the server', async () => {
    await call('mutation', 'devices:rename', {deviceId: 'dev2', name: '  Office   PC '});
    expect((await call('query', 'devices:list')).find(r => r.deviceId === 'dev2').name).toBe('Office PC');
    for (const name of ['', '  ', 'x'.repeat(81)]) {
      const error = await call('mutation', 'devices:rename', {deviceId: 'dev2', name}).catch(e => e);
      expect(error.data).toMatchObject({code: 'invalid', field: 'name'});
    }
    expect(await codeOf(call('mutation', 'devices:rename', {deviceId: 'nope', name: 'x'}))).toBe('not_found');
  });

  it('a user revoke hides the computer and pairing again brings it back; an admin revoke refuses', async () => {
    await call('mutation', 'devices:revoke', {deviceId: 'dev1'});
    expect((await call('query', 'devices:list')).map(r => r.deviceId)).toEqual(['dev2']);
    expect(runtime.db.devices.find(d => d.id === 'dev1')).toMatchObject({revoked: true, revokedBy: 'user'});
    const tokenHash = 'c'.repeat(64);
    expect(await call('mutation', 'devices:pair', {tokenHash, name: 'Kyle’s MacBook Pro'})).toBe('dev1');
    expect((await call('query', 'devices:list')).map(r => r.deviceId)).toContain('dev1');
    expect(runtime.db.devices.find(d => d.id === 'dev1').revokedBy).toBeUndefined();
    runtime.db.devices.find(d => d.id === 'dev1').revoked = true;
    runtime.db.devices.find(d => d.id === 'dev1').revokedBy = 'admin';
    expect(await codeOf(call('mutation', 'devices:pair', {tokenHash, name: 'x'}))).toBe('device_revoked_admin');
    expect(await codeOf(call('mutation', 'devices:pair', {tokenHash: 'bad', name: 'x'}))).toBe('invalid');
  });

  it('re-pairing a user-revoked computer is refused at the limit, like the server', async () => {
    const tokenHash = 'c'.repeat(64);
    await call('mutation', 'devices:pair', {tokenHash, name: 'Studio MacBook'});
    await call('mutation', 'devices:revoke', {deviceId: 'dev1'});
    const active = () => runtime.db.devices.filter(d => !d.revoked).length;
    for (let n = 0; active() < 20; n++) await call('mutation', 'devices:pair', {tokenHash: n.toString(16).padStart(64, 'e'), name: `PC ${n}`});
    expect(await call('mutation', 'devices:pair', {tokenHash, name: 'x'}).catch(e => e.data)).toMatchObject({code: 'device_limit', limit: 20});
    expect(runtime.db.devices.find(d => d.id === 'dev1').revoked).toBe(true);
    expect(await call('query', 'devices:list')).toHaveLength(20);
  });

  it('pairing with no computers creates the fake processor’s device', async () => {
    start('?fx-devices=none');
    expect(await call('mutation', 'devices:pair', {tokenHash: 'd'.repeat(64), name: '  Studio  Mac '})).toBe('dev1');
    expect(await call('query', 'devices:list')).toEqual([expect.objectContaining({deviceId: 'dev1', name: 'Studio Mac', state: 'offline', lastSeenAt: null})]);
    expect(await call('mutation', 'devices:pair', {tokenHash: 'd'.repeat(64), name: 'Studio Mac'})).toBe('dev1');
    expect(runtime.db.devices).toHaveLength(1);
  });
});
