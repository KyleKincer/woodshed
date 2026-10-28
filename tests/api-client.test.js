import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {ConvexError} from 'convex/values';
import {ApiError, action, mutation, publicClient, query, subscribe, toApiError} from '../src/api/client.js';

const fake = vi.hoisted(() => {
  const make = () => ({
    query: vi.fn(async () => 'q'), mutation: vi.fn(async () => 'm'), action: vi.fn(async () => 'a'),
    onUpdate: vi.fn(() => vi.fn()), close: vi.fn(async () => {}),
  });
  return {make, auth: make(), signedIn: true, publicClients: []};
});

// src/app/auth.js arrives with AU1 (wave 0B). The first mock applies once the file exists; until then the
// import cannot be resolved and Vitest matches the mock by the importer's raw specifier.
vi.mock('../src/app/auth.js', () => ({client: () => (fake.signedIn ? fake.auth : null)}));
vi.mock('../app/auth.js', () => ({client: () => (fake.signedIn ? fake.auth : null)}));
vi.mock('convex/browser', () => ({
  ConvexClient: class {
    constructor(url) { Object.assign(this, fake.make()); this.url = url; fake.publicClients.push(this); }
  },
}));


beforeEach(() => { fake.auth = fake.make(); fake.signedIn = true; fake.publicClients.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

describe('query / mutation / action', () => {
  test('call the authenticated client with module:function names and default args', async () => {
    expect(await query('songs:get', {id: 's1'})).toBe('q');
    expect(fake.auth.query).toHaveBeenCalledWith('songs:get', {id: 's1'});
    expect(await mutation('songs:remove')).toBe('m');
    expect(fake.auth.mutation).toHaveBeenCalledWith('songs:remove', {});
    expect(await action('tempoSources:search', {q: 'x'})).toBe('a');
    expect(fake.auth.action).toHaveBeenCalledWith('tempoSources:search', {q: 'x'});
  });

  test('a coded ConvexError becomes an ApiError with code, message, data and raw', async () => {
    const raw = new ConvexError({code: 'resplit_wrong_device', message: 'Use the studio Mac.', device: 'Studio Mac'});
    fake.auth.mutation.mockRejectedValueOnce(raw);
    const err = await mutation('jobs:createSeparation', {}).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
    expect(err.code).toBe('resplit_wrong_device');
    expect(err.message).toBe('Use the studio Mac.');
    expect(err.data).toMatchObject({device: 'Studio Mac'});
    expect(err.raw).toBe(raw);
  });

  test('anything else is code "unknown" with its message kept for Details', async () => {
    fake.auth.query.mockRejectedValueOnce(new Error('[CONVEX Q(songs:list)] Connection lost'));
    const err = await query('songs:list').catch(e => e);
    expect(err.code).toBe('unknown');
    expect(err.message).toMatch(/Connection lost/);
    fake.auth.action.mockRejectedValueOnce('plain string');
    expect(await action('x:y').catch(e => [e.code, e.message])).toEqual(['unknown', 'plain string']);
    fake.auth.query.mockRejectedValueOnce(new ConvexError('just text'));
    expect(await query('x:y').catch(e => [e.code, e.message])).toEqual(['unknown', 'just text']);
    fake.auth.query.mockRejectedValueOnce(new ConvexError({message: 'no code'}));
    expect(await query('x:y').catch(e => [e.code, e.message])).toEqual(['unknown', 'no code']);
  });

  test('signed out → not_signed_in, without calling anything', async () => {
    fake.signedIn = false;
    const err = await query('songs:list').catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('not_signed_in');
    expect(() => subscribe('songs:list', {}, () => {})).toThrow(ApiError);
  });
});

describe('toApiError', () => {
  test('is idempotent and tolerates odd inputs', () => {
    const e = new ApiError({code: 'pins_full', message: 'Up to 12 pins'});
    expect(toApiError(e)).toBe(e);
    expect(toApiError(undefined).code).toBe('unknown');
    expect(toApiError(42).message).toBe('Something went wrong.');
    expect(toApiError({data: {code: 'queue_full', message: 'Busy'}}).code).toBe('queue_full');
    expect(new ApiError().code).toBe('unknown');
  });
});

describe('subscribe', () => {
  test('wraps onUpdate; off() is idempotent; errors arrive as ApiError', () => {
    const unsubscribe = vi.fn();
    fake.auth.onUpdate.mockReturnValueOnce(unsubscribe);
    const onValue = vi.fn(), onError = vi.fn();
    const off = subscribe('jobs:listActive', {}, onValue, onError);
    const [name, args, valueCb, errorCb] = fake.auth.onUpdate.mock.calls[0];
    expect([name, args]).toEqual(['jobs:listActive', {}]);
    valueCb([1]);
    expect(onValue).toHaveBeenCalledWith([1]);
    errorCb(new ConvexError({code: 'not_signed_in', message: 'Sign in'}));
    expect(onError.mock.calls[0][0]).toBeInstanceOf(ApiError);
    expect(onError.mock.calls[0][0].code).toBe('not_signed_in');
    off();
    off();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('without onError the Convex default error handling is kept', () => {
    subscribe('songs:list', undefined, () => {});
    const call = fake.auth.onUpdate.mock.calls[0];
    expect(call[1]).toEqual({});
    expect(call[3]).toBeUndefined();
  });
});

describe('publicClient', () => {
  test('one unauthenticated client per page until closed', async () => {
    vi.stubEnv('VITE_CONVEX_URL', 'https://example.convex.cloud');
    const a = publicClient();
    const b = publicClient();
    expect(a).toBe(b);
    expect(fake.publicClients).toHaveLength(1);
    expect(fake.publicClients[0].url).toBe('https://example.convex.cloud');
    const c = fake.publicClients[0];
    c.query.mockRejectedValueOnce(new ConvexError({code: 'not_found', message: 'Gone'}));
    expect(await a.query('sharing:view', {token: 't'}).catch(e => e.code)).toBe('not_found');
    const off = a.subscribe('sharing:view', {token: 't'}, () => {});
    expect(c.onUpdate).toHaveBeenCalledWith('sharing:view', {token: 't'}, expect.any(Function), undefined);
    off();
    await a.close();
    expect(c.close).toHaveBeenCalled();
    const d = publicClient();
    expect(d).not.toBe(a);
    expect(fake.publicClients).toHaveLength(2);
    await d.close();
  });

  test('a missing VITE_CONVEX_URL is a clear error', () => {
    vi.stubEnv('VITE_CONVEX_URL', '');
    expect(() => publicClient()).toThrow(/VITE_CONVEX_URL/);
  });
});
