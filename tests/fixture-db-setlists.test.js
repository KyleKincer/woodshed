// @vitest-environment happy-dom
// Fixture handlers for setlists (tests/fixture/db/setlists.js, BK6): they mirror
// every function of convex/setlists.ts (architecture §6.8) over the seed's
// db.setlists rows, with the same rules and coded errors.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

vi.hoisted(() => { globalThis.__FX_DB_MANUAL_BOOT__ = true; });

const {boot, call, stopJobCreep} = await import('./fixture/db/index.js');
const runtime = await import('./fixture/db/runtime.js');
const {handlers, LIMITS} = await import('./fixture/db/setlists.js');
const serverLimits = (await import('../convex/setlists.ts')).LIMITS;

const NOW = Date.parse('2026-10-28T09:00:00Z');
const DAY = 864e5;

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const start = (search = '') => boot({search, store: new MemoryStorage(), now: NOW});
const db = () => runtime.db;

/** The coded error a handler threw. */
async function codeFrom(promise) {
  try { await promise; } catch (error) { return {code: error.data?.code ?? null, data: error.data ?? {}}; }
  throw new Error('expected the call to fail');
}

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(NOW);
  start();
});
afterEach(() => { stopJobCreep(); vi.useRealTimers(); });

describe('coverage', () => {
  test('every §6.8 function has a handler, and the caps match the server', () => {
    expect(Object.keys(handlers).sort()).toEqual(['setlists:addSongs', 'setlists:create', 'setlists:get', 'setlists:list', 'setlists:remove', 'setlists:rename', 'setlists:setSongs', 'setlists:touch']);
    expect(LIMITS).toEqual({...serverLimits});
  });
});

describe('queries', () => {
  test('list returns the seed lists, most recently changed first, in the server row shape', async () => {
    const rows = await call('query', 'setlists:list', {});
    expect(rows).toEqual([
      {id: 'set-friday', name: 'Friday at the Grange', count: 5, songIds: ['glasshouse', 'lowtide', 'secondwind', 'nightbus', 'velvet'], updatedAt: NOW - DAY, lastOpenedAt: NOW - DAY},
      {id: 'set-warmup', name: 'Warm-ups', count: 2, songIds: ['shuffle', 'quiet'], updatedAt: NOW - 12 * DAY, lastOpenedAt: null},
    ]);
    // The rows are copies: changing one does not change the database.
    rows[0].songIds.push('x');
    expect(db().setlists[0].songIds).toHaveLength(5);
  });

  test('get returns {id, name, songIds}, null for an unknown id', async () => {
    expect(await call('query', 'setlists:get', {id: 'set-warmup'})).toEqual({id: 'set-warmup', name: 'Warm-ups', songIds: ['shuffle', 'quiet']});
    expect(await call('query', 'setlists:get', {id: 'nope'})).toBeNull();
  });

  test('another user\'s row is invisible and untouchable', async () => {
    db().setlists.push({id: 'set-other', userId: 'user2', name: 'Not yours', songIds: ['quiet'], createdAt: NOW, updatedAt: NOW + 1});
    expect((await call('query', 'setlists:list', {})).map(r => r.id)).toEqual(['set-friday', 'set-warmup']);
    expect(await call('query', 'setlists:get', {id: 'set-other'})).toBeNull();
    for (const [name, args] of [['rename', {id: 'set-other', name: 'Mine'}], ['setSongs', {id: 'set-other', songIds: []}], ['addSongs', {id: 'set-other', songIds: ['lowtide']}], ['remove', {id: 'set-other'}], ['touch', {id: 'set-other'}]])
      expect((await codeFrom(call('mutation', `setlists:${name}`, args))).code, name).toBe('not_found');
    expect(db().setlists.find(l => l.id === 'set-other')).toMatchObject({name: 'Not yours', songIds: ['quiet']});
  });

  test('fx-library=empty has no lists', async () => {
    start('?fx-library=empty');
    expect(await call('query', 'setlists:list', {})).toEqual([]);
  });
});

describe('create, rename, setSongs, addSongs, remove, touch', () => {
  test('create tidies the name, dedupes songs and moves the new list to the front', async () => {
    vi.setSystemTime(NOW + 1000);
    const id = await call('mutation', 'setlists:create', {name: '  Thursday \n rehearsal ', songIds: ['lowtide', 'quiet', 'lowtide']});
    expect(id).toBe('set-1');
    expect(await call('mutation', 'setlists:create', {name: 'Second'})).toBe('set-2');
    const rows = await call('query', 'setlists:list', {});
    expect(rows.slice(0, 2).map(r => [r.id, r.name, r.songIds])).toEqual([['set-2', 'Second', []], ['set-1', 'Thursday rehearsal', ['lowtide', 'quiet']]]);
    expect(db().setlists.find(l => l.id === 'set-1')).toMatchObject({userId: 'user1', createdAt: NOW + 1000, updatedAt: NOW + 1000});
  });

  test('the name, list and song caps and song ownership give the server\'s codes', async () => {
    for (const name of ['', '  ', 'n'.repeat(81)]) {
      const {code, data} = await codeFrom(call('mutation', 'setlists:create', {name}));
      expect(code).toBe('invalid');
      expect(data).toMatchObject({field: 'name', message: 'Enter a setlist name of 1–80 characters.'});
    }
    expect((await codeFrom(call('mutation', 'setlists:create', {name: 'Ghost', songIds: ['no-such-song']}))).code).toBe('not_found');
    const many = Array.from({length: 101}, (_, i) => `song-${i}`);
    db().songs.push(...many.map(id => ({id, title: id})));
    expect((await codeFrom(call('mutation', 'setlists:create', {name: 'Big', songIds: many}))).data).toMatchObject({code: 'setlist_full', limit: 100});
    for (let i = db().setlists.length; i < 100; i++) await call('mutation', 'setlists:create', {name: `List ${i}`});
    expect((await codeFrom(call('mutation', 'setlists:create', {name: 'One more'}))).data).toMatchObject({code: 'setlist_limit', limit: 100});
    expect(db().setlists).toHaveLength(100);
  });

  test('rename bumps updatedAt only on a change', async () => {
    vi.setSystemTime(NOW + 1000);
    await call('mutation', 'setlists:rename', {id: 'set-warmup', name: ' Warm-ups '});
    expect(db().setlists.find(l => l.id === 'set-warmup').updatedAt).toBe(NOW - 12 * DAY);
    await call('mutation', 'setlists:rename', {id: 'set-warmup', name: 'Warm  ups'});
    expect(db().setlists.find(l => l.id === 'set-warmup')).toMatchObject({name: 'Warm ups', updatedAt: NOW + 1000});
    expect((await call('query', 'setlists:list', {}))[0].id).toBe('set-warmup');
  });

  test('setSongs reorders and dedupes, drops a song deleted meanwhile, refuses an unknown one', async () => {
    expect(await call('mutation', 'setlists:setSongs', {id: 'set-warmup', songIds: ['quiet', 'shuffle', 'quiet']})).toEqual(['quiet', 'shuffle']);
    db().songs = db().songs.filter(s => s.id !== 'shuffle');
    expect(await call('mutation', 'setlists:setSongs', {id: 'set-warmup', songIds: ['shuffle', 'quiet']})).toEqual(['quiet']);
    expect((await codeFrom(call('mutation', 'setlists:setSongs', {id: 'set-warmup', songIds: ['quiet', 'ghost']}))).code).toBe('not_found');
    expect(db().setlists.find(l => l.id === 'set-warmup').songIds).toEqual(['quiet']);
  });

  test('addSongs appends the new songs and returns them; past 100 is setlist_full', async () => {
    expect(await call('mutation', 'setlists:addSongs', {id: 'set-warmup', songIds: ['quiet', 'lowtide', 'lowtide', 'velvet']})).toEqual({added: ['lowtide', 'velvet']});
    expect(db().setlists.find(l => l.id === 'set-warmup').songIds).toEqual(['shuffle', 'quiet', 'lowtide', 'velvet']);
    vi.setSystemTime(NOW + 5000);
    expect(await call('mutation', 'setlists:addSongs', {id: 'set-warmup', songIds: ['quiet']})).toEqual({added: []});
    expect(db().setlists.find(l => l.id === 'set-warmup').updatedAt).toBe(NOW);
    const many = Array.from({length: 97}, (_, i) => `song-${i}`);
    db().songs.push(...many.map(id => ({id, title: id})));
    expect((await codeFrom(call('mutation', 'setlists:addSongs', {id: 'set-warmup', songIds: many}))).code).toBe('setlist_full');
    expect(db().setlists.find(l => l.id === 'set-warmup').songIds).toHaveLength(4);
  });

  test('remove deletes the list; touch sets lastOpenedAt without moving it', async () => {
    vi.setSystemTime(NOW + 60_000);
    await call('mutation', 'setlists:touch', {id: 'set-warmup'});
    expect(db().setlists.find(l => l.id === 'set-warmup')).toMatchObject({lastOpenedAt: NOW + 60_000, updatedAt: NOW - 12 * DAY});
    expect((await call('query', 'setlists:list', {})).map(r => r.id)).toEqual(['set-friday', 'set-warmup']);
    await call('mutation', 'setlists:remove', {id: 'set-friday'});
    expect(await call('query', 'setlists:get', {id: 'set-friday'})).toBeNull();
    expect(db().songs.some(s => s.id === 'glasshouse')).toBe(true);
    expect((await codeFrom(call('mutation', 'setlists:remove', {id: 'set-friday'}))).code).toBe('not_found');
  });
});

describe('account rules', () => {
  test('fx-auth=export_only refuses every write but touch', async () => {
    start('?fx-auth=export_only');
    for (const [name, args] of [['create', {name: 'New'}], ['rename', {id: 'set-warmup', name: 'X'}], ['setSongs', {id: 'set-warmup', songIds: []}], ['addSongs', {id: 'set-warmup', songIds: ['lowtide']}], ['remove', {id: 'set-warmup'}]])
      expect((await codeFrom(call('mutation', `setlists:${name}`, args))).code, name).toBe('account_export_only');
    expect(await call('query', 'setlists:list', {})).toHaveLength(2);
    await call('mutation', 'setlists:touch', {id: 'set-warmup'});
    expect(db().setlists.find(l => l.id === 'set-warmup').lastOpenedAt).toBe(NOW);
  });

  test('fx-auth=suspended refuses every mutation, touch included', async () => {
    start('?fx-auth=suspended');
    expect((await codeFrom(call('mutation', 'setlists:touch', {id: 'set-warmup'}))).code).toBe('account_suspended');
    expect((await codeFrom(call('mutation', 'setlists:create', {name: 'New'}))).code).toBe('account_suspended');
  });
});
