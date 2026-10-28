/// <reference types="vite/client" />
// Setlists (B3, architecture §6.8, package BK6): ownership, caps, dedupe,
// export-only refusal and touch, through convex-test.
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { codeOf, type Code } from './lib/errors';
import { LIMITS } from './setlists';

const modules = import.meta.glob('./**/*.ts');
const T0 = Date.parse('2026-10-28T09:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

type Test = ReturnType<typeof convexTest>;

function setup() {
  const t = convexTest(schema, modules);
  return { t, alice: t.withIdentity({ subject: 'alice' }), bob: t.withIdentity({ subject: 'bob' }) };
}

let songCounter = 0;
/** Inserts `n` songs owned by `userId` and returns their ids in insertion order. */
function songs(t: Test, userId: string, n: number): Promise<Id<'songs'>[]> {
  return t.run(async ctx => {
    const ids: Id<'songs'>[] = [];
    for (let i = 0; i < n; i++) {
      songCounter++;
      ids.push(await ctx.db.insert('songs', {
        userId, title: `Song ${songCounter}`, duration: 120, addedAt: songCounter,
        stems: [{ name: 'drums', key: `users/${userId}/s${songCounter}/drums.opus` }], stemMode: 'full',
        quality: { model: 'htdemucs', shifts: 0, overlap: 0.25, format: 'opus' },
      }));
    }
    return ids;
  });
}

const control = (t: Test, userId: string, status: 'active' | 'export_only' | 'suspended') =>
  t.run(ctx => ctx.db.insert('accountControls', { userId, status, notes: '' }));

const stored = (t: Test, id: Id<'setlists'>) => t.run(ctx => ctx.db.get('setlists', id));

/** The coded error a call threw (the test fails when it does not throw). */
async function codeFrom(fn: () => Promise<unknown>): Promise<{ code: Code | null; data: Record<string, unknown> }> {
  try {
    await fn();
  } catch (error) {
    return { code: codeOf(error), data: ((error as { data?: Record<string, unknown> }).data ?? {}) };
  }
  throw new Error('expected the call to fail');
}

describe('list and get', () => {
  test('signed-out callers get [] and null', async () => {
    const { t, alice } = setup();
    const id = await alice.mutation(api.setlists.create, { name: 'Thursday' });
    expect(await t.query(api.setlists.list, {})).toEqual([]);
    expect(await t.query(api.setlists.get, { id })).toBeNull();
  });

  test('list returns the caller\'s lists, most recently changed first, with count and lastOpenedAt', async () => {
    const { t, alice, bob } = setup();
    const [a, b, c] = await songs(t, 'alice', 3);
    const first = await alice.mutation(api.setlists.create, { name: 'Thursday rehearsal', songIds: [a, b] });
    vi.setSystemTime(T0 + 1000);
    const second = await alice.mutation(api.setlists.create, { name: 'Warm-ups' });
    await bob.mutation(api.setlists.create, { name: 'Bob only' });

    expect(await alice.query(api.setlists.list, {})).toEqual([
      { id: second, name: 'Warm-ups', count: 0, songIds: [], updatedAt: T0 + 1000, lastOpenedAt: null },
      { id: first, name: 'Thursday rehearsal', count: 2, songIds: [a, b], updatedAt: T0, lastOpenedAt: null },
    ]);

    // A change moves a list to the front.
    vi.setSystemTime(T0 + 2000);
    await alice.mutation(api.setlists.addSongs, { id: first, songIds: [c] });
    const rows = await alice.query(api.setlists.list, {});
    expect(rows.map(r => [r.name, r.count, r.updatedAt])).toEqual([['Thursday rehearsal', 3, T0 + 2000], ['Warm-ups', 0, T0 + 1000]]);
    expect((await bob.query(api.setlists.list, {})).map(r => r.name)).toEqual(['Bob only']);
  });

  test('get returns {id, name, songIds} for the owner only', async () => {
    const { t, alice, bob } = setup();
    const [a] = await songs(t, 'alice', 1);
    const id = await alice.mutation(api.setlists.create, { name: 'Gig', songIds: [a] });
    expect(await alice.query(api.setlists.get, { id })).toEqual({ id, name: 'Gig', songIds: [a] });
    expect(await bob.query(api.setlists.get, { id })).toBeNull();
  });

  test('get reads a malformed or deleted URL id as no list', async () => {
    const { alice } = setup();
    expect(await alice.query(api.setlists.get, { id: 'not-a-real-id' })).toBeNull();
    const id = await alice.mutation(api.setlists.create, { name: 'Gone soon' });
    await alice.mutation(api.setlists.remove, { id });
    expect(await alice.query(api.setlists.get, { id })).toBeNull();
  });

  test('reads stay available to export-only accounts and are refused for suspended ones', async () => {
    const { t, alice, bob } = setup();
    const id = await alice.mutation(api.setlists.create, { name: 'Keep' });
    await control(t, 'alice', 'export_only');
    expect((await alice.query(api.setlists.list, {})).map(r => r.id)).toEqual([id]);
    expect(await alice.query(api.setlists.get, { id })).toMatchObject({ name: 'Keep' });
    await bob.mutation(api.setlists.create, { name: 'Bob' });
    await control(t, 'bob', 'suspended');
    expect((await codeFrom(() => bob.query(api.setlists.list, {}))).code).toBe('account_suspended');
  });
});

describe('create', () => {
  test('stores a tidied name, deduplicated songs in order, and the timestamps', async () => {
    const { t, alice } = setup();
    const [a, b, c] = await songs(t, 'alice', 3);
    const id = await alice.mutation(api.setlists.create, { name: '  Thursday \n  rehearsal ', songIds: [b, a, b, c, a] });
    expect(await stored(t, id)).toMatchObject({ userId: 'alice', name: 'Thursday rehearsal', songIds: [b, a, c], createdAt: T0, updatedAt: T0 });
    expect((await stored(t, id))!.lastOpenedAt).toBeUndefined();
    const empty = await alice.mutation(api.setlists.create, { name: 'Empty' });
    expect((await stored(t, empty))!.songIds).toEqual([]);
  });

  test('names are 1–80 characters after trimming', async () => {
    const { t, alice } = setup();
    expect(LIMITS.name).toBe(80);
    const id = await alice.mutation(api.setlists.create, { name: `  ${'x'.repeat(80)}  ` });
    expect((await stored(t, id))!.name).toBe('x'.repeat(80));
    for (const name of ['', '   ', '\n\t', 'y'.repeat(81)]) {
      const { code, data } = await codeFrom(() => alice.mutation(api.setlists.create, { name }));
      expect(code, JSON.stringify(name)).toBe('invalid');
      expect(data).toMatchObject({ field: 'name', message: 'Enter a setlist name of 1–80 characters.' });
    }
    expect(await alice.query(api.setlists.list, {})).toHaveLength(1);
  });

  test('a user keeps at most 100 lists (setlist_limit); others are unaffected', async () => {
    const { t, alice, bob } = setup();
    expect(LIMITS.lists).toBe(100);
    await t.run(async ctx => {
      for (let i = 0; i < 99; i++) await ctx.db.insert('setlists', { userId: 'alice', name: `List ${i}`, songIds: [], createdAt: i, updatedAt: i });
    });
    await alice.mutation(api.setlists.create, { name: 'The hundredth' });
    const { code, data } = await codeFrom(() => alice.mutation(api.setlists.create, { name: 'One too many' }));
    expect(code).toBe('setlist_limit');
    expect(data.limit).toBe(100);
    expect(await alice.query(api.setlists.list, {})).toHaveLength(100);
    await bob.mutation(api.setlists.create, { name: 'Bob is fine' });
  });

  test('a list holds at most 100 songs (setlist_full), counted after dedupe', async () => {
    const { t, alice } = setup();
    expect(LIMITS.songs).toBe(100);
    const ids = await songs(t, 'alice', 101);
    const full = await alice.mutation(api.setlists.create, { name: 'Full', songIds: [...ids.slice(0, 100), ...ids.slice(0, 50)] });
    expect((await stored(t, full))!.songIds).toEqual(ids.slice(0, 100));
    const { code, data } = await codeFrom(() => alice.mutation(api.setlists.create, { name: 'Too many', songIds: ids }));
    expect(code).toBe('setlist_full');
    expect(data.limit).toBe(100);
    expect(await alice.query(api.setlists.list, {})).toHaveLength(1);
  });

  test('every song must be the caller\'s: Bob cannot put Alice\'s songs in his list', async () => {
    const { t, alice, bob } = setup();
    const [aliceSong] = await songs(t, 'alice', 1);
    const [bobSong] = await songs(t, 'bob', 1);
    const { code, data } = await codeFrom(() => bob.mutation(api.setlists.create, { name: 'Sneaky', songIds: [bobSong, aliceSong] }));
    expect(code).toBe('not_found');
    expect(data.message).toBe('One of these songs is not in your library.');
    expect(await bob.query(api.setlists.list, {})).toEqual([]);
    // A deleted song reads exactly like someone else's.
    await t.run(ctx => ctx.db.delete('songs', bobSong));
    expect((await codeFrom(() => bob.mutation(api.setlists.create, { name: 'Ghost', songIds: [bobSong] }))).code).toBe('not_found');
    expect(await alice.mutation(api.setlists.create, { name: 'Fine', songIds: [aliceSong] })).toBeTruthy();
  });

  test('signed-out, export-only and suspended callers cannot create', async () => {
    const { t, alice, bob } = setup();
    expect((await codeFrom(() => t.mutation(api.setlists.create, { name: 'Anon' }))).code).toBe('not_signed_in');
    await control(t, 'alice', 'export_only');
    const refused = await codeFrom(() => alice.mutation(api.setlists.create, { name: 'Paused' }));
    expect(refused.code).toBe('account_export_only');
    await control(t, 'bob', 'suspended');
    expect((await codeFrom(() => bob.mutation(api.setlists.create, { name: 'Suspended' }))).code).toBe('account_suspended');
    expect(await t.run(ctx => ctx.db.query('setlists').take(10))).toEqual([]);
  });
});

describe('rename', () => {
  test('renames with the same name rules and bumps updatedAt; an unchanged name writes nothing', async () => {
    const { t, alice } = setup();
    const id = await alice.mutation(api.setlists.create, { name: 'Thursday' });
    vi.setSystemTime(T0 + 5000);
    await alice.mutation(api.setlists.rename, { id, name: '  Friday   gig ' });
    expect(await stored(t, id)).toMatchObject({ name: 'Friday gig', updatedAt: T0 + 5000, createdAt: T0 });
    vi.setSystemTime(T0 + 9000);
    await alice.mutation(api.setlists.rename, { id, name: 'Friday gig ' });
    expect((await stored(t, id))!.updatedAt).toBe(T0 + 5000);
    for (const name of ['', ' ', 'z'.repeat(81)]) expect((await codeFrom(() => alice.mutation(api.setlists.rename, { id, name }))).code).toBe('invalid');
    expect((await stored(t, id))!.name).toBe('Friday gig');
  });

  test('Bob cannot rename Alice\'s list, and a deleted list is not_found', async () => {
    const { t, alice, bob } = setup();
    const id = await alice.mutation(api.setlists.create, { name: 'Alice' });
    const { code, data } = await codeFrom(() => bob.mutation(api.setlists.rename, { id, name: 'Mine now' }));
    expect(code).toBe('not_found');
    expect(data.message).toBe('This setlist is not in your library.');
    expect((await stored(t, id))!.name).toBe('Alice');
    await alice.mutation(api.setlists.remove, { id });
    expect((await codeFrom(() => alice.mutation(api.setlists.rename, { id, name: 'Back' }))).code).toBe('not_found');
  });
});

describe('setSongs', () => {
  test('replaces the order, deduplicated, and returns it', async () => {
    const { t, alice } = setup();
    const [a, b, c, d] = await songs(t, 'alice', 4);
    const id = await alice.mutation(api.setlists.create, { name: 'Set', songIds: [a, b, c] });
    vi.setSystemTime(T0 + 1000);
    expect(await alice.mutation(api.setlists.setSongs, { id, songIds: [c, a, c, d, a] })).toEqual([c, a, d]);
    expect(await stored(t, id)).toMatchObject({ songIds: [c, a, d], updatedAt: T0 + 1000 });
    // Removing everything is allowed.
    expect(await alice.mutation(api.setlists.setSongs, { id, songIds: [] })).toEqual([]);
  });

  test('an unchanged order writes nothing', async () => {
    const { t, alice } = setup();
    const [a, b] = await songs(t, 'alice', 2);
    const id = await alice.mutation(api.setlists.create, { name: 'Set', songIds: [a, b] });
    vi.setSystemTime(T0 + 1000);
    await alice.mutation(api.setlists.setSongs, { id, songIds: [a, b, a] });
    expect((await stored(t, id))!.updatedAt).toBe(T0);
  });

  test('at most 100 distinct songs (setlist_full)', async () => {
    const { t, alice } = setup();
    const ids = await songs(t, 'alice', 101);
    const id = await alice.mutation(api.setlists.create, { name: 'Big' });
    expect(await alice.mutation(api.setlists.setSongs, { id, songIds: [...ids.slice(0, 100), ids[0]] })).toHaveLength(100);
    expect((await codeFrom(() => alice.mutation(api.setlists.setSongs, { id, songIds: ids }))).code).toBe('setlist_full');
    expect((await stored(t, id))!.songIds).toEqual(ids.slice(0, 100));
  });

  test('ownership: Bob cannot reorder Alice\'s list, nor slip his or her songs across', async () => {
    const { t, alice, bob } = setup();
    const [a1, a2] = await songs(t, 'alice', 2);
    const [b1] = await songs(t, 'bob', 1);
    const aliceList = await alice.mutation(api.setlists.create, { name: 'Alice', songIds: [a1, a2] });
    const bobList = await bob.mutation(api.setlists.create, { name: 'Bob', songIds: [b1] });
    expect((await codeFrom(() => bob.mutation(api.setlists.setSongs, { id: aliceList, songIds: [a2, a1] }))).code).toBe('not_found');
    expect((await codeFrom(() => bob.mutation(api.setlists.setSongs, { id: bobList, songIds: [b1, a1] }))).code).toBe('not_found');
    expect((await codeFrom(() => alice.mutation(api.setlists.setSongs, { id: aliceList, songIds: [a1, b1] }))).code).toBe('not_found');
    expect((await stored(t, aliceList))!.songIds).toEqual([a1, a2]);
    expect((await stored(t, bobList))!.songIds).toEqual([b1]);
  });

  test('a song deleted since the client read the list is dropped; a new missing id is refused', async () => {
    const { t, alice } = setup();
    const [a, b, c] = await songs(t, 'alice', 3);
    const id = await alice.mutation(api.setlists.create, { name: 'Set', songIds: [a, b] });
    await t.run(ctx => ctx.db.delete('songs', b));
    expect(await alice.mutation(api.setlists.setSongs, { id, songIds: [b, a] })).toEqual([a]);
    expect((await stored(t, id))!.songIds).toEqual([a]);
    await t.run(ctx => ctx.db.delete('songs', c));
    expect((await codeFrom(() => alice.mutation(api.setlists.setSongs, { id, songIds: [a, c] }))).code).toBe('not_found');
  });
});

describe('addSongs', () => {
  test('appends only the songs not yet present, in order, and returns them', async () => {
    const { t, alice } = setup();
    const [a, b, c, d] = await songs(t, 'alice', 4);
    const id = await alice.mutation(api.setlists.create, { name: 'Set', songIds: [a, b] });
    vi.setSystemTime(T0 + 1000);
    expect(await alice.mutation(api.setlists.addSongs, { id, songIds: [d, b, c, d] })).toEqual({ added: [d, c] });
    expect(await stored(t, id)).toMatchObject({ songIds: [a, b, d, c], updatedAt: T0 + 1000 });
  });

  test('adding songs that are all present writes nothing, even on a full list', async () => {
    const { t, alice } = setup();
    const ids = await songs(t, 'alice', 100);
    const id = await alice.mutation(api.setlists.create, { name: 'Full', songIds: ids });
    vi.setSystemTime(T0 + 1000);
    expect(await alice.mutation(api.setlists.addSongs, { id, songIds: [ids[3], ids[99]] })).toEqual({ added: [] });
    expect((await stored(t, id))!.updatedAt).toBe(T0);
  });

  test('past 100 songs is setlist_full and nothing is added', async () => {
    const { t, alice } = setup();
    const ids = await songs(t, 'alice', 102);
    const id = await alice.mutation(api.setlists.create, { name: 'Nearly', songIds: ids.slice(0, 99) });
    expect(await alice.mutation(api.setlists.addSongs, { id, songIds: [ids[99]] })).toEqual({ added: [ids[99]] });
    const { code, data } = await codeFrom(() => alice.mutation(api.setlists.addSongs, { id, songIds: [ids[100], ids[101]] }));
    expect(code).toBe('setlist_full');
    expect(data.limit).toBe(100);
    expect((await stored(t, id))!.songIds).toEqual(ids.slice(0, 100));
  });

  test('ownership: Bob cannot add to Alice\'s list or add Alice\'s ids to his own', async () => {
    const { t, alice, bob } = setup();
    const [a1] = await songs(t, 'alice', 1);
    const [b1, b2] = await songs(t, 'bob', 2);
    const aliceList = await alice.mutation(api.setlists.create, { name: 'Alice', songIds: [a1] });
    const bobList = await bob.mutation(api.setlists.create, { name: 'Bob', songIds: [b1] });
    expect((await codeFrom(() => bob.mutation(api.setlists.addSongs, { id: aliceList, songIds: [b2] }))).code).toBe('not_found');
    expect((await codeFrom(() => bob.mutation(api.setlists.addSongs, { id: bobList, songIds: [b2, a1] }))).code).toBe('not_found');
    expect((await stored(t, aliceList))!.songIds).toEqual([a1]);
    expect((await stored(t, bobList))!.songIds).toEqual([b1]);
  });
});

describe('remove', () => {
  test('deletes the owner\'s list and leaves its songs in the library', async () => {
    const { t, alice } = setup();
    const [a] = await songs(t, 'alice', 1);
    const id = await alice.mutation(api.setlists.create, { name: 'Bye', songIds: [a] });
    expect(await alice.mutation(api.setlists.remove, { id })).toBeNull();
    expect(await stored(t, id)).toBeNull();
    expect(await t.run(ctx => ctx.db.get('songs', a))).not.toBeNull();
    expect((await codeFrom(() => alice.mutation(api.setlists.remove, { id }))).code).toBe('not_found');
  });

  test('Bob cannot delete Alice\'s list', async () => {
    const { t, alice, bob } = setup();
    const id = await alice.mutation(api.setlists.create, { name: 'Alice' });
    expect((await codeFrom(() => bob.mutation(api.setlists.remove, { id }))).code).toBe('not_found');
    expect(await stored(t, id)).not.toBeNull();
  });
});

describe('export-only accounts (D10)', () => {
  test('every write except touch is refused with account_export_only and changes nothing', async () => {
    const { t, alice } = setup();
    const [a, b] = await songs(t, 'alice', 2);
    const id = await alice.mutation(api.setlists.create, { name: 'Before', songIds: [a] });
    await control(t, 'alice', 'export_only');
    const before = await stored(t, id);
    for (const [label, fn] of [
      ['create', () => alice.mutation(api.setlists.create, { name: 'New' })],
      ['rename', () => alice.mutation(api.setlists.rename, { id, name: 'After' })],
      ['setSongs', () => alice.mutation(api.setlists.setSongs, { id, songIds: [] })],
      ['addSongs', () => alice.mutation(api.setlists.addSongs, { id, songIds: [b] })],
      ['remove', () => alice.mutation(api.setlists.remove, { id })],
    ] as const) {
      const { code, data } = await codeFrom(fn);
      expect(code, label).toBe('account_export_only');
      expect(data.message, label).toBe('Your account is in export-only mode. Playback and library export remain available.');
    }
    expect(await stored(t, id)).toEqual(before);
    expect(await alice.query(api.setlists.list, {})).toHaveLength(1);
    // Opening a list is personal state, so it still records.
    vi.setSystemTime(T0 + 1000);
    await alice.mutation(api.setlists.touch, { id });
    expect((await stored(t, id))!.lastOpenedAt).toBe(T0 + 1000);
  });
});

describe('touch', () => {
  test('sets lastOpenedAt only, so the list keeps its place', async () => {
    const { t, alice } = setup();
    const older = await alice.mutation(api.setlists.create, { name: 'Older' });
    vi.setSystemTime(T0 + 1000);
    const newer = await alice.mutation(api.setlists.create, { name: 'Newer' });
    vi.setSystemTime(T0 + 60_000);
    expect(await alice.mutation(api.setlists.touch, { id: older })).toBeNull();
    expect(await stored(t, older)).toMatchObject({ lastOpenedAt: T0 + 60_000, updatedAt: T0 });
    const rows = await alice.query(api.setlists.list, {});
    expect(rows.map(r => r.id)).toEqual([newer, older]);
    expect(rows[1].lastOpenedAt).toBe(T0 + 60_000);
    vi.setSystemTime(T0 + 120_000);
    await alice.mutation(api.setlists.touch, { id: older });
    expect((await stored(t, older))!.lastOpenedAt).toBe(T0 + 120_000);
  });

  test('only the owner can touch: Bob, a malformed URL id and a signed-out caller are refused', async () => {
    const { t, alice, bob } = setup();
    const id = await alice.mutation(api.setlists.create, { name: 'Alice' });
    expect((await codeFrom(() => bob.mutation(api.setlists.touch, { id }))).code).toBe('not_found');
    expect((await codeFrom(() => alice.mutation(api.setlists.touch, { id: 'garbage' }))).code).toBe('not_found');
    expect((await codeFrom(() => t.mutation(api.setlists.touch, { id }))).code).toBe('not_signed_in');
    expect((await stored(t, id))!.lastOpenedAt).toBeUndefined();
    await control(t, 'alice', 'suspended');
    expect((await codeFrom(() => alice.mutation(api.setlists.touch, { id }))).code).toBe('account_suspended');
  });
});
