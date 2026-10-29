// src/api/jobs.js (BK2): the wrappers call the jobs module by name with exactly
// the contract args (unset optional ones left out) and rethrow ApiError with
// the server's code (architecture §2.1, §6.4).
import {beforeEach, describe, expect, test, vi} from 'vitest';
import {ConvexError} from 'convex/values';

const fake = vi.hoisted(() => ({client: null}));
const make = () => ({query: vi.fn(async () => null), mutation: vi.fn(async () => null), action: vi.fn(), onUpdate: vi.fn(() => vi.fn())});
// src/app/auth.js arrives with AU1 (wave 0B): mock it by both specifiers (see tests/api-client.test.js).
vi.mock('../src/app/auth.js', () => ({client: () => fake.client}));
vi.mock('../app/auth.js', () => ({client: () => fake.client}));

const jobs = await import('../src/api/jobs.js');
const {ApiError} = await import('../src/api/client.js');

beforeEach(() => { fake.client = make(); });

describe('queries and subscriptions', () => {
  test('listActive, get and latestDetection', async () => {
    const rows = [{jobId: 'j1', status: 'queued'}];
    fake.client.query.mockResolvedValueOnce(rows);
    expect(await jobs.listActive()).toBe(rows);
    expect(fake.client.query).toHaveBeenLastCalledWith('jobs:listActive', {});
    await jobs.get({jobId: 'j1', extra: true});
    expect(fake.client.query).toHaveBeenLastCalledWith('jobs:get', {jobId: 'j1'});
    await jobs.latestDetection({songId: 's1'});
    expect(fake.client.query).toHaveBeenLastCalledWith('jobs:latestDetection', {songId: 's1'});
    await jobs.listUnappliedDetections({extra: true});
    expect(fake.client.query).toHaveBeenLastCalledWith('jobs:listUnappliedDetections', {});
  });

  test('subscribeActive and subscribeJob return off()', () => {
    const onValue = vi.fn(), onError = vi.fn();
    const off = jobs.subscribeActive(onValue, onError);
    expect(fake.client.onUpdate).toHaveBeenLastCalledWith('jobs:listActive', {}, onValue, expect.any(Function));
    expect(typeof off).toBe('function');
    jobs.subscribeJob({jobId: 'j2'}, onValue);
    expect(fake.client.onUpdate).toHaveBeenLastCalledWith('jobs:get', {jobId: 'j2'}, onValue, undefined);
    expect(typeof jobs.subscribeUnappliedDetections(onValue, onError)).toBe('function');
    expect(fake.client.onUpdate).toHaveBeenLastCalledWith('jobs:listUnappliedDetections', {}, onValue, expect.any(Function));
  });

  test('a subscription error arrives as an ApiError', () => {
    const onError = vi.fn();
    jobs.subscribeActive(vi.fn(), onError);
    const forward = fake.client.onUpdate.mock.calls[0][3];
    forward(new ConvexError({code: 'account_suspended', message: 'Suspended.'}));
    expect(onError.mock.calls[0][0]).toBeInstanceOf(ApiError);
    expect(onError.mock.calls[0][0].code).toBe('account_suspended');
  });
});

describe('mutations', () => {
  test('createSeparation sends the contract args and drops unset optional ones', async () => {
    fake.client.mutation.mockResolvedValueOnce({jobId: 'j9'});
    const args = {
      source: {type: 'search', value: 'weird fishes'}, deviceId: 'd1', settings: {preset: 'fast'}, label: 'weird fishes',
      meta: {title: 'Weird Fishes', thumbnail: 'https://i.ytimg.com/x.jpg'}, confirmed: true, replaceSongId: undefined, other: 1,
    };
    expect(await jobs.createSeparation(args)).toEqual({jobId: 'j9'});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('jobs:createSeparation', {
      source: args.source, deviceId: 'd1', settings: {preset: 'fast'}, label: 'weird fishes', meta: args.meta, confirmed: true,
    });
    await jobs.createSeparation({deviceId: 'd1', settings: {}, label: 'x (re-split)', replaceSongId: 's1', confirmed: false});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('jobs:createSeparation', {deviceId: 'd1', settings: {}, label: 'x (re-split)', replaceSongId: 's1', confirmed: false});
  });

  test('detections pass deviceId only when the web chose one', async () => {
    await jobs.createBeatDetection({songId: 's1'});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('jobs:createBeatDetection', {songId: 's1'});
    await jobs.createBeatDetection({songId: 's1', deviceId: 'd2'});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('jobs:createBeatDetection', {songId: 's1', deviceId: 'd2'});
    await jobs.createSectionDetection({songId: 's1', deviceId: undefined});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('jobs:createSectionDetection', {songId: 's1'});
    await jobs.createSectionDetection({songId: 's1', deviceId: 'd2'});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('jobs:createSectionDetection', {songId: 's1', deviceId: 'd2'});
  });

  test('job card actions: cancel, dismiss, retry (with and without a preset), markApplied', async () => {
    await jobs.cancel({jobId: 'j1'});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('jobs:cancel', {jobId: 'j1'});
    await jobs.dismiss({jobId: 'j1'});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('jobs:dismiss', {jobId: 'j1'});
    await jobs.retry({jobId: 'j1'});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('jobs:retry', {jobId: 'j1'});
    await jobs.retry({jobId: 'j1', preset: 'fast'});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('jobs:retry', {jobId: 'j1', preset: 'fast'});
    await jobs.markApplied({jobId: 'j1'});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('jobs:markApplied', {jobId: 'j1'});
  });

  test('coded failures come out as ApiError with the code and data', async () => {
    fake.client.mutation.mockRejectedValueOnce(new ConvexError({code: 'resplit_wrong_device', message: 'Re-split this song on Studio Mac, which has the original file.', deviceName: 'Studio Mac'}));
    const error = await jobs.createSeparation({deviceId: 'd2', settings: {}, label: 'x', replaceSongId: 's1'}).catch(e => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({code: 'resplit_wrong_device', data: {deviceName: 'Studio Mac'}});
    fake.client.mutation.mockRejectedValueOnce(new ConvexError({code: 'job_live', message: 'Cancel the job first.'}));
    expect((await jobs.dismiss({jobId: 'j1'}).catch(e => e)).code).toBe('job_live');
    fake.client.mutation.mockRejectedValueOnce(new Error('network down'));
    expect((await jobs.retry({jobId: 'j1'}).catch(e => e)).code).toBe('unknown');
    fake.client = null;
    expect((await jobs.listActive().catch(e => e)).code).toBe('not_signed_in');
  });
});

describe('helpers', () => {
  test('isLive and ACTIVE_STATUSES', () => {
    expect(jobs.ACTIVE_STATUSES).toEqual(['queued', 'running', 'error']);
    expect(['queued', 'running', 'error', 'done', 'canceled'].map(status => jobs.isLive({status}))).toEqual([true, true, false, false, false]);
    expect(jobs.isLive(null)).toBe(false);
  });
});
