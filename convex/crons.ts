// Scheduled jobs (integration I0B, architecture Appendix C "Amendments after I0B").
//
// The B1 whole-table backfill (`migrations.backfillB1`, BK1) runs itself after
// a deploy instead of waiting for owner gate G2. Every hour `backfillB1Tick`
// looks for work cheaply and starts one `backfillB1` chain only when there is
// some: for each account it reads the oldest and the newest song (two indexed
// reads) and starts the chain when either is not upgraded. Once the table is
// upgraded the tick costs one read of the recent scheduled functions, one read
// per account and two indexed reads per account, and schedules nothing. The
// backfill itself is idempotent (upgraded songs are left alone), so a chain
// started while another is somehow still running only repeats work.
import { cronJobs } from 'convex/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, type MutationCtx } from './_generated/server';
import { isUpgraded } from './migrations';

/** Newest scheduled functions read to see whether a backfill chain is still running (each link schedules the next). */
export const SCHEDULED_SCAN = 200;

const BACKFILL = 'migrations:backfillB1';
const RUNNING = new Set(['pending', 'inProgress']);

/** True while a `backfillB1` link is waiting or running. */
async function backfillRunning(ctx: MutationCtx): Promise<boolean> {
  const recent = await ctx.db.system.query('_scheduled_functions').order('desc').take(SCHEDULED_SCAN);
  return recent.some(f => f.name.replace(/\.js:/, ':') === BACKFILL && RUNNING.has(f.state.kind));
}

/** True when some account's oldest or newest song has not been through the B1 upgrade. */
async function backfillNeeded(ctx: MutationCtx): Promise<boolean> {
  for await (const user of ctx.db.query('users')) {
    const userId = user._id as string;
    for (const order of ['asc', 'desc'] as const) {
      const song = await ctx.db.query('songs').withIndex('by_user_added', q => q.eq('userId', userId)).order(order).first();
      if (song && !isUpgraded(song)) return true;
    }
  }
  return false;
}

export const backfillB1Tick = internalMutation({
  args: {},
  returns: v.object({ started: v.boolean(), reason: v.union(v.literal('running'), v.literal('complete'), v.literal('started')) }),
  handler: async ctx => {
    if (await backfillRunning(ctx)) return { started: false, reason: 'running' as const };
    if (!(await backfillNeeded(ctx))) return { started: false, reason: 'complete' as const };
    await ctx.scheduler.runAfter(0, internal.migrations.backfillB1, { cursor: null });
    return { started: true, reason: 'started' as const };
  },
});

const crons = cronJobs();

crons.interval('B1 backfill (self-running after deploy)', { hours: 1 }, internal.crons.backfillB1Tick, {});

export default crons;
