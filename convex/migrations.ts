// Data migrations (architecture §6.3, B1). Package BK1. Distinct from the
// empty legacy `migrate.ts`.
//
// B1 moves practice out of `songs` into `songPractice` and denormalises what
// the slim Library row needs (`practiceSummary`, `lastPracticedAt`,
// `mapSummary`, `hasChart`). Stored 1.9 data is never rewritten in place:
// `songs.practice` stays readable (it is removed in wave 4, owner gate G7) and
// every reader falls back to it until a song is upgraded.
//
// Nothing has to run for a 1.9 song to read correctly:
// - lazily, on read: `songs.getPractice` falls back to `songs.practice`;
//   `songs.list`, `get` and `getMany` derive a missing `hasChart` from the
//   drum part (`chartOf`, one indexed read) and `list` computes the missing
//   summaries from it;
// - lazily, on write: `savePractice` writes `songPractice`, `saveTempo`
//   writes `mapSummary` (and `hasChart` when it was missing), and
//   `notation.save`/`deletePart` write `hasChart` with the summaries that
//   depend on it (`chartPatch`).
// The stored fields are filled by two idempotent backfills that page 50 songs
// per transaction and reschedule themselves with `runAfter(0)` until done:
// - per account: the first practice, tempo or chart save of an account whose
//   oldest song is not upgraded upgrades that song inline and schedules
//   `backfillUser` once (`ensureBackfill`);
// - whole table: `backfillB1` (owner gate G2, a cron entry, or
//   `npx convex run migrations:backfillB1 '{"cursor":null}'`).
// Running either again changes nothing.
import { v } from 'convex/values';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { PRACTICE_CAP, upgradePractice, prunePractice, summarize, type SummaryMap } from '../shared/practice';
import { sameContent } from '../shared/content';
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
 * by `upgradePractice` (D51). The map is only needed for the loop label, so
 * its bars are computed only while the loop is on.
 */
export function practiceSummaryFor(practice: unknown, song: SongTempo) {
  const upgraded = upgradePractice(practice, { legacyTempo: song.tempo, duration: song.duration });
  return { summary: summarize(upgraded, upgraded.loop?.on ? summaryMapOf(song) : null), lastAt: upgraded.lastAt };
}

/** The Library's map summary (`mapSummaryOf` is its only definition, §4.1). */
export function mapSummaryFor(song: SongTempo) {
  return mapSummaryOf(song.tempo, song.duration, { hasPart: song.hasChart === true });
}

/** A song the B1 upgrade has visited. On a 1.9 row nothing but the upgrade and a chart save writes `hasChart`. */
export const isUpgraded = (song: Pick<Song, 'hasChart' | 'mapSummary'>) => song.hasChart !== undefined && song.mapSummary !== undefined;

/**
 * Whether the song has a chart: the stored flag, else (a song the upgrade has
 * not reached) whether its drum part has hits, the backfill's own rule.
 */
export async function chartOf(ctx: QueryCtx | MutationCtx, song: Pick<Song, '_id' | 'hasChart'>): Promise<boolean> {
  if (song.hasChart !== undefined) return song.hasChart;
  const part = await ctx.db.query('notationParts').withIndex('by_songId', q => q.eq('songId', song._id)).first();
  return !!part && part.hitCount > 0;
}

/**
 * The song's stored practice blob, raw (any version): its `songPractice` row,
 * else the 1.9 `songs.practice` (until V1), else null. Every practice reader
 * (getPractice, the export, share snapshots) goes through this.
 */
export async function storedPractice(ctx: QueryCtx | MutationCtx, song: Pick<Song, '_id' | 'practice'>): Promise<unknown> {
  const row = await ctx.db.query('songPractice').withIndex('by_songId', q => q.eq('songId', song._id)).unique();
  return row ? row.practice : song.practice ?? null;
}

/**
 * What to write to `songs` when its chart flag becomes `hasChart`: the flag
 * and the summaries that depend on it (a part makes the map real, §4.1
 * rule 2, which changes `mapSummary` and the loop label).
 */
export async function chartPatch(ctx: MutationCtx, song: Song, hasChart: boolean): Promise<Partial<Song>> {
  const current = { ...song, hasChart };
  const patch: Partial<Song> = { hasChart, mapSummary: mapSummaryFor(current) };
  const practice = await storedPractice(ctx, song);
  if (practice != null) patch.practiceSummary = practiceSummaryFor(practice, current).summary;
  return patch;
}

/**
 * Upgrades one song in place; returns true when it wrote anything.
 * - `hasChart`: the drum part exists with hits (`notationParts.by_songId`);
 * - `mapSummary` from the stored tempo, when missing or when `hasChart` was
 *   unknown (a summary written before then may have missed the chart);
 * - `songs.practice` → `songPractice`, upgraded with the legacy click fields
 *   (D51) and pruned to the cap, unless a `songPractice` row exists (it is newer);
 * - `practiceSummary` (when missing or `hasChart` was unknown) and
 *   `lastPracticedAt` (when missing) from the practice.
 */
export async function upgradeSong(ctx: MutationCtx, song: Song, now = Date.now()): Promise<boolean> {
  const patch: Partial<Song> = {};
  const chartKnown = song.hasChart !== undefined;
  const hasChart = await chartOf(ctx, song);
  if (!chartKnown) patch.hasChart = hasChart;
  const current = { ...song, hasChart };
  if (!chartKnown || song.mapSummary === undefined) {
    const mapSummary = mapSummaryFor(current);
    if (!sameContent(mapSummary, song.mapSummary)) patch.mapSummary = mapSummary;
  }
  let wrote = false;
  if (song.practice != null || song.practiceSummary === undefined || !chartKnown) {
    const row = await ctx.db.query('songPractice').withIndex('by_songId', q => q.eq('songId', song._id)).unique();
    let practice: unknown = row?.practice;
    if (!row && song.practice != null) {
      practice = prunePractice(upgradePractice(song.practice, { legacyTempo: song.tempo, duration: song.duration }), PRACTICE_CAP, now).value;
      await ctx.db.insert('songPractice', { songId: song._id, userId: song.userId, practice, updatedAt: now });
      wrote = true;
    }
    if ((song.practiceSummary === undefined || !chartKnown) && practice != null) {
      const { summary, lastAt } = practiceSummaryFor(practice, current);
      if (!sameContent(summary, song.practiceSummary)) patch.practiceSummary = summary;
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
  for (const song of songs) {
    // One unreadable song must not stop the chain; its readers keep falling back.
    try {
      if (await upgradeSong(ctx, song, now)) upgraded++;
    } catch (error) {
      console.error(`B1 upgrade skipped song ${song._id}`, error);
    }
  }
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
 * One account's songs, newest first (its recent songs are the ones being
 * opened). `ensureBackfill` has already upgraded the oldest song, the marker
 * it reads, so a running chain is never scheduled twice.
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
 * When the account's oldest song is not upgraded: upgrades it inline (so the
 * account's next saves see it upgraded and schedule nothing more) and
 * schedules `backfillUser` for the rest. The account's own saves call it
 * before they write, so once the account is upgraded it costs one indexed
 * read. Returns true when it scheduled.
 */
export async function ensureBackfill(ctx: MutationCtx, userId: string): Promise<boolean> {
  const oldest = await ctx.db.query('songs').withIndex('by_user_added', q => q.eq('userId', userId)).order('asc').first();
  if (!oldest || isUpgraded(oldest)) return false;
  await upgradeSong(ctx, oldest);
  await ctx.scheduler.runAfter(0, internal.migrations.backfillUser, { userId, cursor: null });
  return true;
}
