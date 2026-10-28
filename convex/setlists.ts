import { v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { getUserId, requireUserId, requireWritableUserId } from './lib/auth';
import { fail } from './lib/errors';

/**
 * Setlists (B3, architecture §6.8): ordered lists of the caller's own songs.
 *
 * - A user keeps at most `LIMITS.lists` lists (`setlist_limit`); a list holds at
 *   most `LIMITS.songs` songs (`setlist_full`) and has a name of 1–`LIMITS.name`
 *   characters after whitespace is tidied (`invalid` with `field: 'name'`).
 * - Song ids are deduplicated (the first occurrence keeps its place) and must
 *   all be the caller's songs. A foreign id and a missing one are both
 *   `not_found`, so a caller learns nothing about other people's songs; the
 *   same holds for lists.
 * - Creating and changing lists needs a writable account (D10: export-only
 *   accounts cannot create setlists). `touch` only records that the owner
 *   opened a list, which is personal state, so export-only accounts may do it.
 * - Deleting a song strips its id from every list (`deleteSongData`, §6.3,
 *   BK1); that cleanup reaches all of a user's lists because of the 100-list cap.
 */
export const LIMITS = { lists: 100, songs: 100, name: 80 } as const;

const listRowValidator = v.object({
  id: v.id('setlists'),
  name: v.string(),
  count: v.number(),
  songIds: v.array(v.id('songs')),
  updatedAt: v.number(),
  lastOpenedAt: v.union(v.number(), v.null()),
});

type Ctx = QueryCtx | MutationCtx;

/** Whitespace runs collapse and the ends are trimmed, so a pasted name never wraps oddly. */
const tidy = (raw: string) => raw.replace(/\s+/g, ' ').trim();

function cleanName(raw: string): string {
  const name = tidy(raw);
  if (!name || name.length > LIMITS.name) fail('invalid', `Enter a setlist name of 1–${LIMITS.name} characters.`, { field: 'name' });
  return name;
}

/** The first occurrence keeps its place, so a reorder that repeats an id keeps the earlier one. */
const dedupe = <T>(ids: readonly T[]): T[] => [...new Set(ids)];

function assertRoom(count: number) {
  if (count > LIMITS.songs) fail('setlist_full', `A setlist holds up to ${LIMITS.songs} songs.`, { limit: LIMITS.songs });
}

const notYourSong = () => fail('not_found', 'One of these songs is not in your library.');

/** Every id must be one of the caller's songs. Callers pass at most `LIMITS.songs` ids. */
async function assertOwnedSongs(ctx: Ctx, userId: string, ids: readonly Id<'songs'>[]) {
  for (const id of ids) {
    const song = await ctx.db.get('songs', id);
    if (!song || song.userId !== userId) notYourSong();
  }
}

/** The caller's list, else `not_found` (a missing list and someone else's look the same). */
async function ownList(ctx: Ctx, userId: string, id: Id<'setlists'> | null): Promise<Doc<'setlists'>> {
  const row = id ? await ctx.db.get('setlists', id) : null;
  if (!row || row.userId !== userId) fail('not_found', 'This setlist is not in your library.');
  return row;
}

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** The caller's setlists, most recently changed first (≤ 100). Signed out → []. */
export const list = query({
  args: {},
  returns: v.array(listRowValidator),
  handler: async ctx => {
    const userId = await getUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query('setlists')
      .withIndex('by_userId_and_updatedAt', q => q.eq('userId', userId))
      .order('desc')
      .take(LIMITS.lists);
    return rows.map(row => ({
      id: row._id,
      name: row.name,
      count: row.songIds.length,
      songIds: row.songIds,
      updatedAt: row.updatedAt,
      lastOpenedAt: row.lastOpenedAt ?? null,
    }));
  },
});

/**
 * One of the caller's setlists, else null. `id` is a plain string because it
 * comes from the URL (`/set/:id`, `?set=`): a malformed id reads as "no such list".
 */
export const get = query({
  args: { id: v.string() },
  returns: v.union(v.null(), v.object({ id: v.id('setlists'), name: v.string(), songIds: v.array(v.id('songs')) })),
  handler: async (ctx, args) => {
    const userId = await getUserId(ctx);
    const id = ctx.db.normalizeId('setlists', args.id);
    if (!userId || !id) return null;
    const row = await ctx.db.get('setlists', id);
    if (!row || row.userId !== userId) return null;
    return { id: row._id, name: row.name, songIds: row.songIds };
  },
});

/** A new setlist, optionally with songs in order. Returns its id. */
export const create = mutation({
  args: { name: v.string(), songIds: v.optional(v.array(v.id('songs'))) },
  returns: v.id('setlists'),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);
    const name = cleanName(args.name);
    const existing = await ctx.db
      .query('setlists')
      .withIndex('by_userId_and_updatedAt', q => q.eq('userId', userId))
      .take(LIMITS.lists);
    if (existing.length >= LIMITS.lists) fail('setlist_limit', `You can keep up to ${LIMITS.lists} setlists.`, { limit: LIMITS.lists });
    const songIds = dedupe(args.songIds ?? []);
    assertRoom(songIds.length);
    await assertOwnedSongs(ctx, userId, songIds);
    const now = Date.now();
    return await ctx.db.insert('setlists', { userId, name, songIds, createdAt: now, updatedAt: now });
  },
});

/** Rename a setlist. An unchanged name writes nothing. */
export const rename = mutation({
  args: { id: v.id('setlists'), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);
    const row = await ownList(ctx, userId, args.id);
    const name = cleanName(args.name);
    if (name !== row.name) await ctx.db.patch('setlists', row._id, { name, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Replace the order: reorder, remove, and the Undo of an add or a removal.
 * Ids are deduplicated. A song deleted since the client read the list (still
 * in the stored order, but gone) is dropped quietly; every other id must be
 * the caller's song. An unchanged order writes nothing. Returns the stored order.
 */
export const setSongs = mutation({
  args: { id: v.id('setlists'), songIds: v.array(v.id('songs')) },
  returns: v.array(v.id('songs')),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);
    const row = await ownList(ctx, userId, args.id);
    const wanted = dedupe(args.songIds);
    assertRoom(wanted.length);
    const stored = new Set<string>(row.songIds);
    const songIds: Id<'songs'>[] = [];
    for (const id of wanted) {
      const song = await ctx.db.get('songs', id);
      if (song && song.userId === userId) songIds.push(id);
      else if (song || !stored.has(id)) notYourSong();
    }
    if (!sameOrder(songIds, row.songIds)) await ctx.db.patch('setlists', row._id, { songIds, updatedAt: Date.now() });
    return songIds;
  },
});

/**
 * Append the songs that are not in the list yet, in the order given. Returns
 * the ids it added (empty, with nothing written, when every song was already
 * there), which is exactly what an Undo takes out again.
 */
export const addSongs = mutation({
  args: { id: v.id('setlists'), songIds: v.array(v.id('songs')) },
  returns: v.object({ added: v.array(v.id('songs')) }),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);
    const row = await ownList(ctx, userId, args.id);
    const present = new Set<string>(row.songIds);
    const added = dedupe(args.songIds).filter(id => !present.has(id));
    if (!added.length) return { added };
    assertRoom(row.songIds.length + added.length);
    await assertOwnedSongs(ctx, userId, added);
    await ctx.db.patch('setlists', row._id, { songIds: [...row.songIds, ...added], updatedAt: Date.now() });
    return { added };
  },
});

/** Delete a setlist. Its songs stay in the library. */
export const remove = mutation({
  args: { id: v.id('setlists') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);
    const row = await ownList(ctx, userId, args.id);
    await ctx.db.delete('setlists', row._id);
    return null;
  },
});

/**
 * Record that the owner opened a list (`/set/:id`, or a Stage with `?set=`).
 * Sets only `lastOpenedAt`, so the list keeps its place in `list`. Like `get`
 * it takes the URL's id as a string; anything but one of the caller's lists
 * is `not_found`.
 */
export const touch = mutation({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const row = await ownList(ctx, userId, ctx.db.normalizeId('setlists', args.id));
    await ctx.db.patch('setlists', row._id, { lastOpenedAt: Date.now() });
    return null;
  },
});
