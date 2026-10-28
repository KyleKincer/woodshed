// src/api/devices.js (BK3, B5): the wrappers call the devices module by name
// with exactly the contract args and rethrow ApiError; the online rule
// (architecture §6.6) is pure in `now`.
import {beforeEach, describe, expect, test, vi} from 'vitest';
import {ConvexError} from 'convex/values';

const fake = vi.hoisted(() => ({client: null}));
const make = () => ({query: vi.fn(async () => []), mutation: vi.fn(async () => null), action: vi.fn(), onUpdate: vi.fn(() => vi.fn())});
// src/app/auth.js arrives with AU1 (wave 0B): mock it by both specifiers (see tests/api-client.test.js).
vi.mock('../src/app/auth.js', () => ({client: () => fake.client}));
vi.mock('../app/auth.js', () => ({client: () => fake.client}));

const devices = await import('../src/api/devices.js');
const {ApiError} = await import('../src/api/client.js');

beforeEach(() => { fake.client = make(); });

describe('wrappers', () => {
  test('list and subscribeList read devices:list', async () => {
    const rows = [{deviceId: 'd1', name: 'Mac', platform: null, appVersion: null, lastSeenAt: null, state: 'offline', currentJobId: null, queued: 0}];
    fake.client.query.mockResolvedValueOnce(rows);
    expect(await devices.list()).toBe(rows);
    expect(fake.client.query).toHaveBeenCalledWith('devices:list', {});
    const onValue = vi.fn(), onError = vi.fn();
    const off = devices.subscribeList(onValue, onError);
    expect(fake.client.onUpdate).toHaveBeenCalledWith('devices:list', {}, onValue, expect.any(Function));
    expect(typeof off).toBe('function');
  });

  test('pair, rename and revoke send exactly the contract args', async () => {
    fake.client.mutation.mockResolvedValueOnce('d9');
    expect(await devices.pair({tokenHash: 'f'.repeat(64), name: 'Mac', extra: 1})).toBe('d9');
    expect(fake.client.mutation).toHaveBeenLastCalledWith('devices:pair', {tokenHash: 'f'.repeat(64), name: 'Mac'});
    await devices.rename({deviceId: 'd9', name: 'Studio'});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('devices:rename', {deviceId: 'd9', name: 'Studio'});
    await devices.revoke({deviceId: 'd9'});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('devices:revoke', {deviceId: 'd9'});
  });

  test('coded failures come out as ApiError with the code and data', async () => {
    fake.client.mutation.mockRejectedValueOnce(new ConvexError({code: 'invalid', message: 'Enter a name of 1–80 characters.', field: 'name'}));
    const error = await devices.rename({deviceId: 'd9', name: ''}).catch(e => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({code: 'invalid', message: 'Enter a name of 1–80 characters.', data: {field: 'name'}});
    fake.client.mutation.mockRejectedValueOnce(new ConvexError({code: 'device_revoked_admin', message: 'This computer was disconnected by an administrator.'}));
    expect((await devices.pair({tokenHash: 'a'.repeat(64), name: 'x'}).catch(e => e)).code).toBe('device_revoked_admin');
    fake.client = null;
    expect((await devices.list().catch(e => e)).code).toBe('not_signed_in');
  });
});

describe('online rule', () => {
  const NOW = 1_800_000_000_000;
  const row = (fields) => ({deviceId: 'd', name: 'x', platform: null, appVersion: null, lastSeenAt: NOW - 10_000, state: 'idle', currentJobId: null, queued: 0, ...fields});

  test('online while the last heartbeat is younger than 150 s and the state is not offline', () => {
    expect(devices.ONLINE_WINDOW_MS).toBe(150_000);
    expect(devices.RECHECK_MS).toBe(30_000);
    expect(devices.isOnline(row({}), NOW)).toBe(true);
    expect(devices.isOnline(row({state: 'busy'}), NOW)).toBe(true);
    expect(devices.isOnline(row({lastSeenAt: NOW - 149_999}), NOW)).toBe(true);
    expect(devices.isOnline(row({lastSeenAt: NOW - 150_000}), NOW)).toBe(false);
    expect(devices.isOnline(row({state: 'offline'}), NOW)).toBe(false);
    expect(devices.isOnline(row({lastSeenAt: null}), NOW)).toBe(false);
    expect(devices.isOnline(null, NOW)).toBe(false);
    expect(devices.isOnline(row({}), NaN)).toBe(false);
  });

  test('onlineDevices keeps list order and tolerates a missing list', () => {
    const list = [row({deviceId: 'a'}), row({deviceId: 'b', state: 'offline'}), row({deviceId: 'c', lastSeenAt: NOW - 20_000})];
    expect(devices.onlineDevices(list, NOW).map(d => d.deviceId)).toEqual(['a', 'c']);
    // Thirty seconds on, the re-evaluation drops nothing yet; three minutes on, everything.
    expect(devices.onlineDevices(list, NOW + devices.RECHECK_MS).map(d => d.deviceId)).toEqual(['a', 'c']);
    expect(devices.onlineDevices(list, NOW + 180_000)).toEqual([]);
    expect(devices.onlineDevices(undefined, NOW)).toEqual([]);
  });
});
