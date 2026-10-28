// src/api/media.js: signed URL cache (6 h, re-signed 5 min before expiry), batching and sharing in-flight requests.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const client = vi.hoisted(() => ({action: vi.fn()}));
vi.mock('../src/api/client.js', () => client);

const clock = await import('../src/app/clock.js');
const {signKeys, signKey, clearMediaCache, URL_TTL_MS, REFRESH_MARGIN_MS, BATCH} = await import('../src/api/media.js');

const signer = () => async (name, {keys}) => Object.fromEntries(keys.filter(k => !k.startsWith('denied')).map(k => [k, `https://r2.test/${k}?v=${client.action.mock.calls.length}`]));

beforeEach(() => {
  clock.set(1_000_000);
  clearMediaCache();
  client.action.mockReset();
  client.action.mockImplementation(signer());
});
afterEach(() => clock.set());

describe('signKeys', () => {
  test('signs only what is missing and caches the rest', async () => {
    expect(await signKeys(['a', 'b'])).toEqual({a: 'https://r2.test/a?v=1', b: 'https://r2.test/b?v=1'});
    expect(client.action).toHaveBeenLastCalledWith('media:signKeys', {keys: ['a', 'b']});
    expect(await signKeys(['b', 'c', 'c', '', null])).toEqual({b: 'https://r2.test/b?v=1', c: 'https://r2.test/c?v=2'});
    expect(client.action).toHaveBeenLastCalledWith('media:signKeys', {keys: ['c']});
    expect(client.action).toHaveBeenCalledTimes(2);
  });

  test('re-signs a URL inside the 5-minute margin before its 6-hour expiry', async () => {
    await signKeys(['a']);
    clock.set(1_000_000 + URL_TTL_MS - REFRESH_MARGIN_MS - 1);
    await signKeys(['a']);
    expect(client.action).toHaveBeenCalledTimes(1);
    clock.set(1_000_000 + URL_TTL_MS - REFRESH_MARGIN_MS);
    expect(await signKeys(['a'])).toEqual({a: 'https://r2.test/a?v=2'});
    expect(client.action).toHaveBeenCalledTimes(2);
  });

  test('keys the server does not grant are absent and are asked for again next time', async () => {
    expect(await signKeys(['denied-1', 'a'])).toEqual({a: 'https://r2.test/a?v=1'});
    expect(await signKey('denied-1')).toBeNull();
    expect(client.action).toHaveBeenCalledTimes(2);
  });

  test('splits long lists into batches of 100', async () => {
    const keys = Array.from({length: BATCH * 2 + 5}, (_, i) => `k${i}`);
    const out = await signKeys(keys);
    expect(Object.keys(out)).toHaveLength(keys.length);
    expect(client.action.mock.calls.map(([, args]) => args.keys.length)).toEqual([100, 100, 5]);
  });

  test('concurrent requests for the same key share one signing call, failures included', async () => {
    let release;
    client.action.mockImplementationOnce((name, {keys}) => new Promise(resolve => { release = () => resolve(Object.fromEntries(keys.map(k => [k, `u-${k}`]))); }));
    const first = signKeys(['a', 'b']), second = signKeys(['b']);
    release();
    expect(await first).toEqual({a: 'u-a', b: 'u-b'});
    expect(await second).toEqual({b: 'u-b'});
    expect(client.action).toHaveBeenCalledTimes(1);

    const error = Object.assign(new Error('Request timed out'), {code: 'unknown'});
    let fail;
    client.action.mockImplementationOnce(() => new Promise((_, reject) => { fail = () => reject(error); }));
    const one = signKeys(['z']), two = signKeys(['z']);
    fail();
    await expect(one).rejects.toBe(error);
    await expect(two).rejects.toBe(error);
    // Nothing failed is cached: the next request signs again.
    expect(await signKey('z')).toMatch(/^https:\/\/r2\.test\/z/);
  });

  test('signKey handles an empty key without a call; clearMediaCache forgets everything', async () => {
    expect(await signKey('')).toBeNull();
    expect(await signKey(undefined)).toBeNull();
    expect(client.action).not.toHaveBeenCalled();
    expect(await signKey('a')).toBe('https://r2.test/a?v=1');
    clearMediaCache();
    expect(await signKey('a')).toBe('https://r2.test/a?v=2');
  });
});
