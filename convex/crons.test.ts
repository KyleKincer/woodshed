/// <reference types="vite/client" />
// convex/crons.ts: the self-running B1 backfill (integration I0B).
import { convexTest } from 'convex-test';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import crons from './crons';

const modules = import.meta.glob('./**/*.ts');
afterEach(() => { vi.useRealTimers(); });

type NewSong = Omit<Doc<'songs'>, '_id' | '_creationTime'>;
const quality = { model: 'htdemucs', shifts: 0, overlap: 0.25, format: 'opus' as const };
/** A song row exactly as 1.9 wrote it: none of the 2.0 fields. */
const legacySong = (userId: string, extra: Partial<NewSong> = {}): NewSong =>
  ({ userId, title: 'Old song', duration: 60, addedAt: 1, stemMode: 'full', quality, stems: [], ...extra });

function setup() {
  vi.useFakeTimers();
  return convexTest(schema, modules);
}
type T = ReturnType<typeof setup>;
const scheduled = (t: T) => t.run(ctx => ctx.db.system.query('_scheduled_functions').collect());
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const addUser = (t: T) => t.run(ctx => ctx.db.insert('users', { emailVerified: true, createdAt: 1 }));

describe('crons', () => {
  test('registers the hourly B1 tick and the hourly remote cleanup, both with no arguments', () => {
    const jobs = Object.values((crons as unknown as { crons: Record<string, { name: string; args: unknown[]; schedule: unknown }> }).crons);
    expect(jobs.map(j => j.name)).toEqual([getFunctionName(internal.crons.backfillB1Tick), getFunctionName(internal.remote.cleanup)]);
    for (const job of jobs) {
      expect(job.args).toEqual([{}]);
      expect(job.schedule).toEqual({ type: 'interval', hours: 1 });
    }
  });
});

describe('backfillB1Tick', () => {
  test('starts backfillB1 from the beginning while 1.9 songs remain, then is a no-op once the table is upgraded', async () => {
    const t = setup();
    const alice = await addUser(t);
    await t.run(async ctx => {
      for (let i = 0; i < 3; i++) await ctx.db.insert('songs', legacySong(alice, { addedAt: i, practice: { rate: 1 } }));
    });
    expect(await t.mutation(internal.crons.backfillB1Tick, {})).toEqual({ started: true, reason: 'started' });
    const runs = (await scheduled(t)).filter(f => f.name === 'migrations:backfillB1');
    expect(runs.map(f => f.args)).toEqual([[{ cursor: null }]]);
    // While the chain is pending, a second tick does not start another.
    expect(await t.mutation(internal.crons.backfillB1Tick, {})).toEqual({ started: false, reason: 'running' });
    await drain(t);
    const songs = await t.run(ctx => ctx.db.query('songs').collect());
    expect(songs.every(s => s.hasChart !== undefined && s.mapSummary !== undefined)).toBe(true);
    const before = (await scheduled(t)).length;
    expect(await t.mutation(internal.crons.backfillB1Tick, {})).toEqual({ started: false, reason: 'complete' });
    expect((await scheduled(t)).length).toBe(before);
  });

  test('a new song that was never upgraded starts the backfill again', async () => {
    const t = setup();
    const alice = await addUser(t);
    await t.run(ctx => ctx.db.insert('songs', legacySong(alice)));
    await t.mutation(internal.crons.backfillB1Tick, {});
    await drain(t);
    expect(await t.mutation(internal.crons.backfillB1Tick, {})).toEqual({ started: false, reason: 'complete' });
    await t.run(ctx => ctx.db.insert('songs', legacySong(alice, { addedAt: 99, title: 'New' })));
    expect(await t.mutation(internal.crons.backfillB1Tick, {})).toEqual({ started: true, reason: 'started' });
  });

  test('an empty deployment schedules nothing', async () => {
    const t = setup();
    await addUser(t);
    expect(await t.mutation(internal.crons.backfillB1Tick, {})).toEqual({ started: false, reason: 'complete' });
    expect(await scheduled(t)).toEqual([]);
  });
});
