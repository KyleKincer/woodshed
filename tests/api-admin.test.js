// src/api/admin.js (SE3): one-line wrappers over src/api/client.js for convex/admin.ts (§2.1, §6.6).
import {beforeEach, describe, expect, test, vi} from 'vitest';

const client = vi.hoisted(() => ({query: vi.fn(async () => null), mutation: vi.fn(async () => null), subscribe: vi.fn(() => () => {})}));
vi.mock('../src/api/client.js', () => client);

const admin = await import('../src/api/admin.js');

beforeEach(() => vi.clearAllMocks());

describe('admin queries', () => {
  test('access, overview and the live overview', async () => {
    client.query.mockResolvedValueOnce(true);
    expect(await admin.access()).toBe(true);
    expect(client.query).toHaveBeenLastCalledWith('admin:access', {});
    await admin.overview();
    expect(client.query).toHaveBeenLastCalledWith('admin:overview', {});
    const onValue = vi.fn(), onError = vi.fn();
    admin.subscribeOverview(onValue, onError);
    expect(client.subscribe).toHaveBeenLastCalledWith('admin:overview', {}, onValue, onError);
  });

  test('accounts pages 25 at a time and sends an email only when there is one', async () => {
    await admin.accounts();
    expect(client.query).toHaveBeenLastCalledWith('admin:accounts', {paginationOpts: {cursor: null, numItems: admin.PAGE_SIZE}});
    expect(admin.PAGE_SIZE).toBe(25);
    await admin.accounts({email: 'dana@example.com', cursor: 'c1'});
    expect(client.query).toHaveBeenLastCalledWith('admin:accounts', {paginationOpts: {cursor: 'c1', numItems: 25}, email: 'dana@example.com'});
    await admin.accounts({email: ''});
    expect(client.query).toHaveBeenLastCalledWith('admin:accounts', {paginationOpts: {cursor: null, numItems: 25}});
  });

  test('account, its live query, and the audit history (all or one target)', async () => {
    await admin.account({id: 'u2'});
    expect(client.query).toHaveBeenLastCalledWith('admin:account', {id: 'u2'});
    const onValue = vi.fn();
    admin.subscribeAccount({id: 'u2'}, onValue);
    expect(client.subscribe).toHaveBeenLastCalledWith('admin:account', {id: 'u2'}, onValue, undefined);
    await admin.history();
    expect(client.query).toHaveBeenLastCalledWith('admin:history', {paginationOpts: {cursor: null, numItems: 25}});
    await admin.history({targetId: 'u2', cursor: 'h1', numItems: 10});
    expect(client.query).toHaveBeenLastCalledWith('admin:history', {paginationOpts: {cursor: 'h1', numItems: 10}, targetId: 'u2'});
  });
});

describe('admin mutations', () => {
  test('each passes exactly the server’s arguments, reason included', async () => {
    await admin.updateAccount({id: 'u2', status: 'export_only', byteLimit: null, notes: 'n', reason: 'why not', extra: 1});
    expect(client.mutation).toHaveBeenLastCalledWith('admin:updateAccount', {id: 'u2', status: 'export_only', byteLimit: null, notes: 'n', reason: 'why not'});
    await admin.updatePolicy({userBytes: 2e9, appBytes: 1.5e11, reason: 'launch'});
    expect(client.mutation).toHaveBeenLastCalledWith('admin:updatePolicy', {userBytes: 2e9, appBytes: 1.5e11, reason: 'launch'});
    await admin.revokeDevice({id: 'd1', reason: 'lost'});
    expect(client.mutation).toHaveBeenLastCalledWith('admin:revokeDevice', {id: 'd1', reason: 'lost'});
    await admin.cancelJob({id: 'j1', reason: 'stuck'});
    expect(client.mutation).toHaveBeenLastCalledWith('admin:cancelJob', {id: 'j1', reason: 'stuck'});
  });

  test('errors pass through as the client’s ApiError', async () => {
    const error = Object.assign(new Error('Enter a reason (3–500 characters).'), {code: 'invalid', data: {field: 'reason'}});
    client.mutation.mockRejectedValueOnce(error);
    await expect(admin.cancelJob({id: 'j1', reason: 'x'})).rejects.toBe(error);
  });
});
