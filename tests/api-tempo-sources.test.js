// src/api/tempo-sources.js (ED4): one-line wrappers over src/api/client.js for convex/tempoSources.ts (§2.1).
import {beforeEach, expect, test, vi} from 'vitest';

const client = vi.hoisted(() => ({action: vi.fn(async () => null)}));
vi.mock('../src/api/client.js', () => client);

const tempoSources = await import('../src/api/tempo-sources.js');

beforeEach(() => vi.clearAllMocks());

test('search and load are the tempoSources actions with their own argument objects', async () => {
  client.action.mockResolvedValueOnce({candidates: [], warnings: []});
  expect(await tempoSources.search({query: 'Band Song', duration: 20})).toEqual({candidates: [], warnings: []});
  expect(client.action).toHaveBeenLastCalledWith('tempoSources:search', {query: 'Band Song', duration: 20});
  await tempoSources.load({id: 'chorus:abc'});
  expect(client.action).toHaveBeenLastCalledWith('tempoSources:load', {id: 'chorus:abc'});
});

test('a failure rejects with what the client threw (an ApiError)', async () => {
  const error = Object.assign(new Error('This tempo map is unavailable. Try another match.'), {name: 'ApiError', code: 'unknown'});
  client.action.mockRejectedValueOnce(error);
  await expect(tempoSources.load({id: 'x'})).rejects.toBe(error);
});
