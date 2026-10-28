// src/api/sharing.js (package BK5): each wrapper sends exactly the contract
// arguments to its Convex function through src/api/client.js; visitor calls go
// through the public client, owner and save calls through the signed-in one.
import {beforeEach, describe, expect, test, vi} from 'vitest';

const fake = vi.hoisted(() => {
  const make = () => ({query: vi.fn(async () => 'pq'), subscribe: vi.fn(() => 'off-public'), action: vi.fn(async () => 'pa'), close: vi.fn()});
  return {make, pub: make()};
});
vi.mock('../src/api/client.js', () => ({
  query: vi.fn(async () => 'q'),
  mutation: vi.fn(async () => 'm'),
  action: vi.fn(async () => 'a'),
  subscribe: vi.fn(() => 'off'),
  publicClient: vi.fn(() => fake.pub),
}));

const client = await import('../src/api/client.js');
const sharing = await import('../src/api/sharing.js');
const TOKEN = 'a3f1'.repeat(16);

beforeEach(() => { vi.clearAllMocks(); fake.pub = fake.make(); });

describe('owner calls (signed-in client)', () => {
  test('status, create and revoke', async () => {
    expect(await sharing.status({id: 's1'})).toBe('q');
    expect(client.query).toHaveBeenCalledWith('sharing:status', {id: 's1'});
    expect(await sharing.create({id: 's1'})).toBe('m');
    expect(client.mutation).toHaveBeenLastCalledWith('sharing:create', {id: 's1'});
    await sharing.create({id: 's1', includeNotation: false});
    expect(client.mutation).toHaveBeenLastCalledWith('sharing:create', {id: 's1', includeNotation: false});
    await sharing.create({id: 's1', includeNotation: true, extra: 'dropped'});
    expect(client.mutation).toHaveBeenLastCalledWith('sharing:create', {id: 's1', includeNotation: true});
    expect(await sharing.revoke({id: 's1', other: 1})).toBe('m');
    expect(client.mutation).toHaveBeenLastCalledWith('sharing:revoke', {id: 's1'});
  });
});

describe('visitor calls (public client)', () => {
  test('view, subscribeView and playback never need an account', async () => {
    expect(await sharing.view({token: TOKEN})).toBe('pq');
    expect(fake.pub.query).toHaveBeenCalledWith('sharing:view', {token: TOKEN});
    const onValue = () => {}, onError = () => {};
    expect(sharing.subscribeView({token: TOKEN}, onValue, onError)).toBe('off-public');
    expect(fake.pub.subscribe).toHaveBeenCalledWith('sharing:view', {token: TOKEN}, onValue, onError);
    expect(await sharing.playback({token: TOKEN})).toBe('pa');
    expect(fake.pub.action).toHaveBeenCalledWith('shareAudio:playback', {token: TOKEN});
    expect(client.query).not.toHaveBeenCalled();
    expect(client.action).not.toHaveBeenCalled();
  });
  test('saved, subscribeSaved and save use the signed-in client', async () => {
    expect(await sharing.saved({token: TOKEN})).toBe('q');
    expect(client.query).toHaveBeenCalledWith('sharing:saved', {token: TOKEN});
    const onValue = () => {};
    expect(sharing.subscribeSaved({token: TOKEN}, onValue)).toBe('off');
    expect(client.subscribe).toHaveBeenCalledWith('sharing:saved', {token: TOKEN}, onValue, undefined);
    expect(await sharing.save({token: TOKEN})).toBe('a');
    expect(client.action).toHaveBeenCalledWith('shareAudio:save', {token: TOKEN});
    expect(client.publicClient).not.toHaveBeenCalled();
  });
  test('errors pass through unchanged (they are already ApiErrors)', async () => {
    const error = Object.assign(new Error('gone'), {code: 'not_found'});
    fake.pub.query.mockRejectedValueOnce(error);
    await expect(sharing.view({token: TOKEN})).rejects.toBe(error);
    client.action.mockRejectedValueOnce(error);
    await expect(sharing.save({token: TOKEN})).rejects.toBe(error);
  });
});

test('isShareToken accepts only 64 lowercase hex characters', () => {
  expect(sharing.isShareToken(TOKEN)).toBe(true);
  for (const bad of ['', 'A3F1'.repeat(16), TOKEN.slice(1), TOKEN + '0', 'g'.repeat(64), null, 42]) expect(sharing.isShareToken(bad)).toBe(false);
});
