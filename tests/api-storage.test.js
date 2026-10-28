// src/api/storage.js: one-line wrappers over src/api/client.js (§2.1).
import {beforeEach, describe, expect, test, vi} from 'vitest';

const client = vi.hoisted(() => ({query: vi.fn(), subscribe: vi.fn(() => () => {})}));
vi.mock('../src/api/client.js', () => client);

const storage = await import('../src/api/storage.js');

beforeEach(() => vi.clearAllMocks());

describe('storage', () => {
  test('usage and its subscription', async () => {
    client.query.mockResolvedValueOnce({usedBytes: 1, limitBytes: 2, appFull: false});
    expect(await storage.usage()).toEqual({usedBytes: 1, limitBytes: 2, appFull: false});
    expect(client.query).toHaveBeenLastCalledWith('storage:usage', {});
    const onValue = vi.fn();
    storage.subscribeUsage(onValue);
    expect(client.subscribe).toHaveBeenLastCalledWith('storage:usage', {}, onValue, undefined);
  });
});
