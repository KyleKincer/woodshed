// Data migrations (architecture §6.3, B1). Package BK1. Distinct from the
// empty legacy `migrate.ts`.
//
// B1 moves practice out of `songs` into `songPractice` and denormalises what
// the slim Library row needs (`practiceSummary`, `lastPracticedAt`,
// `mapSummary`, `hasChart`). Stored 1.9 data is never rewritten in place:
// `songs.practice` stays readable (it is removed in wave 4, owner gate G7) and
// every reader falls back to it until a song is upgraded.
//
// The upgrade runs on its own after a deploy, three ways, all idempotent:
// - lazily: `songs.getPractice` falls back to `songs.practice`, the first
//   `savePractice` writes `songPractice`, `saveTempo` writes `mapSummary`,
//   `notation.save` writes `hasChart`, and `songs.list` computes a missing
//   summary on read;
// - per account: the first practice, tempo or chart save of an account whose
//   oldest song is not upgraded schedules `backfillUser` (`ensureBackfill`);
// - whole table: `backfillB1` (owner gate G2, or
//   `npx convex run migrations:backfillB1 '{"cursor":null}'`).
// Both backfills page 50 songs per transaction and reschedule themselves with
// `runAfter(0)` until done. Running either again changes nothing.
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { PRACTICE_CAP, upgradePractice, prunePractice, summarize, type SummaryMap } from '../shared/practice';
import { hasRealMap, mapSummaryOf, songMapFromTempo, barsOf, sectionsFromBars } from '../shared/song-map';

/** Songs per backfill transaction. */
export const BACKFILL_BATCH = 50;

type Song = Doc<'songs'>;
type SongTempo = Pick<Song, 'tempo' | 'duration' | 'hasChart'>;

/**
 * The map `summarize` labels loops against, or null for an unmapped song (a
 * placeholder map's bars mean nothing, so its loops read 'm:ss–m:ss loop').
 */
export function summaryMapOf(song: SongTempo): SummaryMap | null {
  if (!hasRealMap(song.tempo, { hasPart: song.hasChart === true })) return null;
  const duration = Math.max(0.001, song.duration || 0);
  const bars = barsOf(songMapFromTempo(song.tempo, duration), duration);
  return { sections: sectionsFromBars(bars), bars };
}

/**
 * The Library's practice summary for a stored practice value of any version,
 * and that practice's `lastAt` (D52). Legacy click fields in `tempo` are read
 * by `upgradePractice` (D51).
 */
export function practiceSummaryFor(practice: unknown, song: SongTempo) {
  const upgraded = upgradePractice(practice, { legacyTempo: song.tempo, duration: song.duration });
  return { summary: summarize(upgraded, summaryMapOf(song)), lastAt: upgraded.lastAt };
}

/** The Library's map summary (`mapSummaryOf` is its only definition, §4.1). */
export function mapSummaryFor(song: SongTempo) {
  return mapSummaryOf(song.tempo, song.duration, { hasPart: song.hasChart === true });
}

/** A song the B1 upgrade has visited. On a 1.9 row nothing but the upgrade and a chart save writes `hasChart`. */
export const isUpgraded = (song: Pick<Song, 'hasChart' | 'mapSummary'>) => song.hasChart !== undefined && song.mapSummary !== undefined;

/**
 * Upgrades one song in place; returns true when it wrote anything.
 * - `hasChart`: the drum part exists with hits (`notationParts.by_songId`);
 * - `mapSummary` from the stored tempo;
 * - `songs.practice` → `songPractice`, upgraded with the legacy click fields
 *   (D51) and pruned to the cap, unless a `songPractice` row exists (it is newer);
 * - `practiceSummary` and `lastPracticedAt` from the practice, when missing.
 */
export async function upgradeSong(ctx: MutationCtx, song: Song, now = Date.now()): Promise<boolean> {
  const patch: Partial<Song> = {};
  let hasChart = song.hasChart;
  if (hasChart === undefined) {
    const part = await ctx.db.query('notationParts').withIndex('by_songId', q => q.eq('songId', song._id)).first();
    hasChart = !!part && part.hitCount > 0;
    patch.hasChart = hasChart;
  }
  const current = { ...song, hasChart };
  if (song.mapSummary === undefined) patch.mapSummary = mapSummaryFor(current);
  let wrote = false;
  if (song.practice != null || song.practiceSummary === undefined) {
    const row = await ctx.db.query('songPractice').withIndex('by_songId', q => q.eq('songId', song._id)).unique();
    let practice: unknown = row?.practice;
    if (!row && song.practice != null) {
      practice = prunePractice(upgradePractice(song.practice, { legacyTempo: song.tempo, duration: song.duration }), PRACTICE_CAP, now).value;
      await ctx.db.insert('songPractice', { songId: song._id, userId: song.userId, practice, updatedAt: now });
      wrote = true;
    }
    if (song.practiceSummary === undefined && practice != null) {
      const { summary, lastAt } = practiceSummaryFor(practice, current);
      patch.practiceSummary = summary;
      if (lastAt !== undefined && song.lastPracticedAt === undefined) patch.lastPracticedAt = lastAt;
    }
  }
  if (Object.keys(patch).length) {
    await ctx.db.patch('songs', song._id, patch);
    wrote = true;
  }
  return wrote;
}

const resultValidator = v.object({ processed: v.number(), upgraded: v.number(), done: v.boolean() });

async function upgradePage(ctx: MutationCtx, songs: Song[]) {
  const now = Date.now();
  let upgraded = 0;
  for (const song of songs) if (await upgradeSong(ctx, song, now)) upgraded++;
  return upgraded;
}

/** Every song, 50 per transaction (owner gate G2). */
export const backfillB1 = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: resultValidator,
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('songs').paginate({ numItems: BACKFILL_BATCH, cursor });
    const upgraded = await upgradePage(ctx, page.page);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.migrations.backfillB1, { cursor: page.continueCursor });
    return { processed: page.page.length, upgraded, done: page.isDone };
  },
});

/**
 * One account's songs, newest first, so the oldest song (the marker
 * `ensureBackfill` reads) is upgraded last: a backfill that stopped early is
 * scheduled again by the account's next save.
 */
export const backfillUser = internalMutation({
  args: { userId: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: resultValidator,
  handler: async (ctx, { userId, cursor }) => {
    const page = await ctx.db.query('songs').withIndex('by_user_added', q => q.eq('userId', userId)).order('desc')
      .paginate({ numItems: BACKFILL_BATCH, cursor });
    const upgraded = await upgradePage(ctx, page.page);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.migrations.backfillUser, { userId, cursor: page.continueCursor });
    return { processed: page.page.length, upgraded, done: page.isDone };
  },
});

/**
 * Schedules `backfillUser` when the account's oldest song is not upgraded.
 * The account's own saves call it before they write, so once the account is
 * upgraded it costs one indexed read. Returns true when it scheduled.
 */
export async function ensureBackfill(ctx: MutationCtx, userId: string): Promise<boolean> {
  const oldest = await ctx.db.query('songs').withIndex('by_user_added', q => q.eq('userId', userId)).order('asc').first();
  if (!oldest || isUpgraded(oldest)) return false;
  await ctx.scheduler.runAfter(0, internal.migrations.backfillUser, { userId, cursor: null });
  return true;
}
