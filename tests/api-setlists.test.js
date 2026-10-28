// src/api/setlists.js (BK6, B3): each wrapper calls the setlists module by name
// with exactly the contract args and rethrows ApiError; the name helpers match
// the server's rule (architecture §6.8).
import {beforeEach, describe, expect, test, vi} from 'vitest';
import {ConvexError} from 'convex/values';

const fake = vi.hoisted(() => ({client: null}));
const make = () => ({query: vi.fn(async () => null), mutation: vi.fn(async () => null), action: vi.fn(), onUpdate: vi.fn(() => vi.fn())});
// src/app/auth.js arrives with AU1 (wave 0B): mock it by both specifiers (see tests/api-client.test.js).
vi.mock('../src/app/auth.js', () => ({client: () => fake.client}));
vi.mock('../app/auth.js', () => ({client: () => fake.client}));

const setlists = await import('../src/api/setlists.js');
const {ApiError} = await import('../src/api/client.js');

beforeEach(() => { fake.client = make(); });

describe('queries', () => {
  test('list and subscribeList read setlists:list', async () => {
    const rows = [{id: 's1', name: 'Thursday', count: 2, songIds: ['a', 'b'], updatedAt: 5, lastOpenedAt: null}];
    fake.client.query.mockResolvedValueOnce(rows);
    expect(await setlists.list()).toBe(rows);
    expect(fake.client.query).toHaveBeenCalledWith('setlists:list', {});
    const onValue = vi.fn(), onError = vi.fn();
    const off = setlists.subscribeList(onValue, onError);
    expect(fake.client.onUpdate).toHaveBeenCalledWith('setlists:list', {}, onValue, expect.any(Function));
    expect(typeof off).toBe('function');
  });

  test('get and subscribeGet pass only the id', async () => {
    fake.client.query.mockResolvedValueOnce({id: 's1', name: 'Thursday', songIds: []});
    expect(await setlists.get({id: 's1', extra: true})).toEqual({id: 's1', name: 'Thursday', songIds: []});
    expect(fake.client.query).toHaveBeenCalledWith('setlists:get', {id: 's1'});
    const onValue = vi.fn();
    setlists.subscribeGet({id: 's1'}, onValue);
    expect(fake.client.onUpdate).toHaveBeenCalledWith('setlists:get', {id: 's1'}, onValue, undefined);
  });

  test('a subscription error arrives as ApiError with its code', () => {
    const onError = vi.fn();
    setlists.subscribeList(vi.fn(), onError);
    const forward = fake.client.onUpdate.mock.calls[0][3];
    forward(new ConvexError({code: 'account_suspended', message: 'Suspended.'}));
    expect(onError.mock.calls[0][0]).toBeInstanceOf(ApiError);
    expect(onError.mock.calls[0][0].code).toBe('account_suspended');
  });
});

describe('mutations', () => {
  test('each sends exactly the contract args', async () => {
    fake.client.mutation.mockResolvedValueOnce('s9');
    expect(await setlists.create({name: 'Gig'})).toBe('s9');
    expect(fake.client.mutation).toHaveBeenLastCalledWith('setlists:create', {name: 'Gig'});
    await setlists.create({name: 'Gig', songIds: ['a', 'b'], other: 1});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('setlists:create', {name: 'Gig', songIds: ['a', 'b']});
    await setlists.rename({id: 's9', name: 'Friday'});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('setlists:rename', {id: 's9', name: 'Friday'});
    fake.client.mutation.mockResolvedValueOnce(['b', 'a']);
    expect(await setlists.setSongs({id: 's9', songIds: ['b', 'a']})).toEqual(['b', 'a']);
    expect(fake.client.mutation).toHaveBeenLastCalledWith('setlists:setSongs', {id: 's9', songIds: ['b', 'a']});
    fake.client.mutation.mockResolvedValueOnce({added: ['c']});
    expect(await setlists.addSongs({id: 's9', songIds: ['a', 'c']})).toEqual({added: ['c']});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('setlists:addSongs', {id: 's9', songIds: ['a', 'c']});
    await setlists.remove({id: 's9'});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('setlists:remove', {id: 's9'});
    await setlists.touch({id: 's9'});
    expect(fake.client.mutation).toHaveBeenLastCalledWith('setlists:touch', {id: 's9'});
  });

  test('coded failures come out as ApiError with the code and data', async () => {
    fake.client.mutation.mockRejectedValueOnce(new ConvexError({code: 'setlist_full', message: 'A setlist holds up to 100 songs.', limit: 100}));
    const full = await setlists.addSongs({id: 's9', songIds: ['x']}).catch(e => e);
    expect(full).toBeInstanceOf(ApiError);
    expect(full).toMatchObject({code: 'setlist_full', message: 'A setlist holds up to 100 songs.', data: {limit: 100}});
    fake.client.mutation.mockRejectedValueOnce(new ConvexError({code: 'invalid', message: 'Enter a setlist name of 1–80 characters.', field: 'name'}));
    expect(await setlists.create({name: ''}).catch(e => e)).toMatchObject({code: 'invalid', data: {field: 'name'}});
    fake.client.mutation.mockRejectedValueOnce(new ConvexError({code: 'account_export_only', message: 'Export-only.'}));
    expect((await setlists.remove({id: 's9'}).catch(e => e)).code).toBe('account_export_only');
    fake.client = null;
    expect((await setlists.list().catch(e => e)).code).toBe('not_signed_in');
  });
});

describe('name rule', () => {
  test('LIMITS match the server', () => {
    expect(setlists.LIMITS).toEqual({lists: 100, songs: 100, name: 80});
    expect(Object.isFrozen(setlists.LIMITS)).toBe(true);
  });

  test('tidyName collapses whitespace and trims; isValidName is 1–80 after tidying', () => {
    expect(setlists.tidyName('  Thursday \n\t rehearsal ')).toBe('Thursday rehearsal');
    expect(setlists.tidyName(null)).toBe('');
    expect(setlists.isValidName('x'.repeat(80))).toBe(true);
    expect(setlists.isValidName(`  ${'x'.repeat(80)}  `)).toBe(true);
    expect(setlists.isValidName('x'.repeat(81))).toBe(false);
    for (const raw of ['', '   ', '\n', undefined]) expect(setlists.isValidName(raw)).toBe(false);
  });
});
