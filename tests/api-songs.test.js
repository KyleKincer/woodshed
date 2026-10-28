// src/api/songs.js: one-line wrappers over src/api/client.js (§2.1, §6.3).
import {beforeEach, describe, expect, test, vi} from 'vitest';

const client = vi.hoisted(() => ({
  query: vi.fn(async () => 'q'), mutation: vi.fn(async () => 'm'), action: vi.fn(async () => 'a'),
  subscribe: vi.fn(() => () => {}),
}));
vi.mock('../src/api/client.js', () => client);

const songs = await import('../src/api/songs.js');

beforeEach(() => vi.clearAllMocks());

describe('songs', () => {
  test('queries pass their argument object through by module:function name', async () => {
    const rows = [
      [songs.list, undefined, 'songs:list', {}],
      [songs.get, {id: 's1'}, 'songs:get', {id: 's1'}],
      [songs.getPractice, {id: 's1'}, 'songs:getPractice', {id: 's1'}],
      [songs.getMany, {ids: ['a', 'b']}, 'songs:getMany', {ids: ['a', 'b']}],
      [songs.exportPage, {paginationOpts: {cursor: null, numItems: 25}}, 'songs:exportPage', {paginationOpts: {cursor: null, numItems: 25}}],
    ];
    for (const [fn, args, name, sent] of rows) {
      expect(await fn(args)).toBe('q');
      expect(client.query).toHaveBeenLastCalledWith(name, sent);
    }
    expect(client.mutation).not.toHaveBeenCalled();
  });

  test('mutations pass their argument object through by module:function name', async () => {
    const practice = {v: 2, rate: 0.5};
    const rows = [
      [songs.savePractice, {id: 's1', practice, final: true}, 'songs:savePractice'],
      [songs.saveTempo, {id: 's1', tempo: {songMap: {}}, baseRev: 3, saveId: 'u1'}, 'songs:saveTempo'],
      [songs.remove, {id: 's1'}, 'songs:remove'],
      [songs.confirmRecording, {id: 's1'}, 'songs:confirmRecording'],
      [songs.dismissSectionSuggestion, {id: 's1'}, 'songs:dismissSectionSuggestion'],
    ];
    for (const [fn, args, name] of rows) {
      expect(await fn(args)).toBe('m');
      expect(client.mutation).toHaveBeenLastCalledWith(name, args);
    }
    expect(client.query).not.toHaveBeenCalled();
  });

  test('the deleted songs.rename has no wrapper', () => {
    expect(songs).not.toHaveProperty('rename');
    expect(Object.keys(songs).sort()).toEqual(['confirmRecording', 'dismissSectionSuggestion', 'exportPage', 'get', 'getMany', 'getPractice', 'list',
      'remove', 'savePractice', 'saveTempo', 'subscribeList', 'subscribePractice', 'subscribeSong']);
  });

  test('subscriptions go through client.subscribe and return its off()', () => {
    const off = () => {};
    client.subscribe.mockReturnValue(off);
    const onValue = vi.fn(), onError = vi.fn();
    expect(songs.subscribeList(onValue, onError)).toBe(off);
    expect(client.subscribe).toHaveBeenLastCalledWith('songs:list', {}, onValue, onError);
    expect(songs.subscribeSong({id: 's1'}, onValue)).toBe(off);
    expect(client.subscribe).toHaveBeenLastCalledWith('songs:get', {id: 's1'}, onValue, undefined);
    expect(songs.subscribePractice({id: 's1'}, onValue, onError)).toBe(off);
    expect(client.subscribe).toHaveBeenLastCalledWith('songs:getPractice', {id: 's1'}, onValue, onError);
  });

  test('a coded failure reaches the caller unchanged', async () => {
    const error = Object.assign(new Error('Practice settings are too large to save.'), {name: 'ApiError', code: 'practice_too_large'});
    client.mutation.mockRejectedValueOnce(error);
    await expect(songs.savePractice({id: 's1', practice: {}})).rejects.toBe(error);
  });
});
