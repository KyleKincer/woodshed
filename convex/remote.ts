// The phone remote (2.1). A device with one of its account's songs open on the Stage is a *host*: it
// announces itself (`announce`, again every HEARTBEAT_MS as a heartbeat), runs the commands sent to it
// (`commands` → the registry → `ack`), publishes what its HUD shows (`publish`) while a remote is watching
// (`commands` reports `watchedAt`), and leaves (`close`) when the song closes. Any other device signed in to
// the same account is a *remote*: it lists the hosts (`hosts`), opens one (`view`, with `watch` every
// HEARTBEAT_MS) and sends it commands (`send`). There is no pairing and no token: every function requires
// the account, and a host only ever exists for its own account.
//
// Queries never read the clock: clients compare `seenAt`, `watchedAt` and `sentAt` with the server's clock as
// they estimate it (`announce` and `watch` return the server's time; shared/remote.ts STALE_MS). `cleanup`
// (hourly cron) drops hosts that stopped heartbeating more than a day ago with their state and any commands
// they never ran.
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { getUserId, requireUserId } from './lib/auth';
import { fail } from './lib/errors';
import { remoteStateValidator, type RemoteState } from './lib/validators';
import { MAX_HOSTS, MAX_PENDING, isHostId, isRemoteCommand } from '../shared/remote';

/** A host not seen for this long is removed by `cleanup`. */
export const EXPIRE_MS = 24 * 60 * 60 * 1000;
/** Hosts `cleanup` removes in one transaction; it runs again at once while more remain. */
export const CLEANUP_BATCH = 100;

/** At most `n` characters, cut on code points: a cut through a surrogate pair is not a valid Convex string. */
const clip = (value: unknown, n: number) => Array.from(String(value ?? '').trim()).slice(0, n).join('');
/** An object without its undefined fields (not Convex values). */
const defined = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as T;

async function hostOf(ctx: QueryCtx | MutationCtx, userId: string, hostId: string): Promise<Doc<'remoteHosts'> | null> {
  if (!isHostId(hostId)) return null;
  return await ctx.db.query('remoteHosts').withIndex('by_userId_and_hostId', q => q.eq('userId', userId).eq('hostId', hostId)).unique();
}

async function dropCommands(ctx: MutationCtx, host: Doc<'remoteHosts'>) {
  for (const row of await ctx.db.query('remoteCommands').withIndex('by_hostRef', q => q.eq('hostRef', host._id)).take(MAX_PENDING * 4)) {
    await ctx.db.delete('remoteCommands', row._id);
  }
}

async function removeHost(ctx: MutationCtx, host: Doc<'remoteHosts'>) {
  await dropCommands(ctx, host);
  for (const row of await ctx.db.query('remoteStates').withIndex('by_hostRef', q => q.eq('hostRef', host._id)).take(8)) {
    await ctx.db.delete('remoteStates', row._id);
  }
  await ctx.db.delete('remoteHosts', host._id);
}

const hostView = (h: Doc<'remoteHosts'>) => defined({
  hostId: h.hostId, name: h.name, platform: h.platform, songId: h.songId, title: h.title, artist: h.artist, seenAt: h.seenAt,
});
const hostValidator = v.object({
  hostId: v.string(), name: v.string(), platform: v.optional(v.string()), songId: v.optional(v.id('songs')),
  title: v.string(), artist: v.optional(v.string()), seenAt: v.number(),
});

/**
 * Host: I have this song open (also the heartbeat). `fresh` (a new Stage, or the next song) drops commands left
 * from before. Returns the server's time.
 */
export const announce = mutation({
  args: {
    hostId: v.string(), name: v.string(), platform: v.optional(v.string()), songId: v.optional(v.id('songs')),
    title: v.string(), artist: v.optional(v.string()), fresh: v.optional(v.boolean()),
  },
  returns: v.object({ now: v.number() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    if (!isHostId(args.hostId)) fail('invalid', 'Invalid remote host.');
    if (args.songId) {
      const song = await ctx.db.get('songs', args.songId);
      if (!song || song.userId !== userId) fail('not_found', 'Song unavailable.');
    }
    const now = Date.now();
    const fields = defined({
      userId, hostId: args.hostId, name: clip(args.name, 60) || 'Woodshed', platform: clip(args.platform, 40) || undefined,
      songId: args.songId, title: clip(args.title, 200) || 'Untitled', artist: clip(args.artist, 200) || undefined, seenAt: now,
    });
    const existing = await hostOf(ctx, userId, args.hostId);
    if (existing) {
      // Optional fields the new song lacks are cleared (patch removes undefined); `watchedAt` is kept.
      await ctx.db.patch('remoteHosts', existing._id, {...fields, platform: fields.platform, songId: fields.songId, artist: fields.artist});
      if (args.fresh) await dropCommands(ctx, existing);
      return { now };
    }
    const all = await ctx.db.query('remoteHosts').withIndex('by_userId', q => q.eq('userId', userId)).take(MAX_HOSTS * 2);
    const oldest = [...all].sort((a, b) => a.seenAt - b.seenAt);
    while (oldest.length >= MAX_HOSTS) await removeHost(ctx, oldest.shift()!);
    await ctx.db.insert('remoteHosts', fields);
    return { now };
  },
});

/** Host: the song closed (or remote control was turned off here). */
export const close = mutation({
  args: { hostId: v.string() },
  returns: v.null(),
  handler: async (ctx, { hostId }) => {
    const userId = await requireUserId(ctx);
    const host = await hostOf(ctx, userId, hostId);
    if (host) await removeHost(ctx, host);
    return null;
  },
});

/** Host: what the HUD shows now. A host that has not announced (or was cleaned up) is ignored. */
export const publish = mutation({
  args: { hostId: v.string(), state: remoteStateValidator },
  returns: v.null(),
  handler: async (ctx, { hostId, state }) => {
    const userId = await requireUserId(ctx);
    const host = await hostOf(ctx, userId, hostId);
    if (!host) return null;
    const clean: RemoteState = defined({
      ...state,
      phase: clip(state.phase, 20),
      position: state.position === undefined ? undefined : clip(state.position, 40),
      section: state.section === undefined ? undefined : clip(state.section, 80),
      next: state.next === undefined ? undefined : clip(state.next, 80),
      loopLabel: state.loopLabel === undefined ? undefined : clip(state.loopLabel, 80),
      mine: state.mine === undefined ? undefined : clip(state.mine, 80),
      rate: Math.min(4, Math.max(0, state.rate)),
    });
    const row = await ctx.db.query('remoteStates').withIndex('by_hostRef', q => q.eq('hostRef', host._id)).first();
    if (row) await ctx.db.patch('remoteStates', row._id, { state: clean, updatedAt: Date.now() });
    else await ctx.db.insert('remoteStates', { hostRef: host._id, userId, state: clean, updatedAt: Date.now() });
    return null;
  },
});

/** Remote: this account's hosts, most recently seen first. Signed out: none. */
export const hosts = query({
  args: {},
  returns: v.array(hostValidator),
  handler: async ctx => {
    const userId = await getUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db.query('remoteHosts').withIndex('by_userId', q => q.eq('userId', userId)).take(MAX_HOSTS * 2);
    return rows.sort((a, b) => b.seenAt - a.seenAt).map(hostView);
  },
});

/** Remote: one host and what its Stage shows, or null when it is gone. */
export const view = query({
  args: { hostId: v.string() },
  returns: v.union(v.null(), v.object({ host: hostValidator, state: v.union(v.null(), remoteStateValidator), updatedAt: v.union(v.null(), v.number()) })),
  handler: async (ctx, { hostId }) => {
    const userId = await getUserId(ctx);
    if (!userId) return null;
    const host = await hostOf(ctx, userId, hostId);
    if (!host) return null;
    const row = await ctx.db.query('remoteStates').withIndex('by_hostRef', q => q.eq('hostRef', host._id)).first();
    return { host: hostView(host), state: row?.state ?? null, updatedAt: row?.updatedAt ?? null };
  },
});

/**
 * Remote: this host is open on a remote (every HEARTBEAT_MS while it is): the host publishes its state. Returns
 * the server's time; with no host (a remote that follows none yet) that is all it does.
 */
export const watch = mutation({
  args: { hostId: v.optional(v.string()) },
  returns: v.object({ now: v.number() }),
  handler: async (ctx, { hostId }) => {
    const userId = await requireUserId(ctx);
    const now = Date.now();
    const host = hostId === undefined ? null : await hostOf(ctx, userId, hostId);
    if (host) await ctx.db.patch('remoteHosts', host._id, { watchedAt: now });
    return { now };
  },
});

/** Remote: ask a host to run a command. `queued: false` when it already has MAX_PENDING waiting. */
export const send = mutation({
  args: { hostId: v.string(), command: v.string() },
  returns: v.object({ queued: v.boolean() }),
  handler: async (ctx, { hostId, command }) => {
    const userId = await requireUserId(ctx);
    if (!isRemoteCommand(command)) fail('invalid', 'That command can’t be sent to another device.');
    const host = await hostOf(ctx, userId, hostId);
    if (!host) fail('not_found', 'That device has closed the song.');
    const waiting = await ctx.db.query('remoteCommands').withIndex('by_hostRef', q => q.eq('hostRef', host._id)).take(MAX_PENDING);
    if (waiting.length >= MAX_PENDING) return { queued: false };
    await ctx.db.insert('remoteCommands', { hostRef: host._id, userId, command, sentAt: Date.now() });
    return { queued: true };
  },
});

/** Host: the commands waiting for it, oldest first, and when a remote last watched it (null: never). */
export const commands = query({
  args: { hostId: v.string() },
  returns: v.object({
    watchedAt: v.union(v.null(), v.number()),
    commands: v.array(v.object({ id: v.id('remoteCommands'), command: v.string(), sentAt: v.number() })),
  }),
  handler: async (ctx, { hostId }) => {
    const userId = await getUserId(ctx);
    const host = userId ? await hostOf(ctx, userId, hostId) : null;
    if (!host) return { watchedAt: null, commands: [] };
    const rows = await ctx.db.query('remoteCommands').withIndex('by_hostRef', q => q.eq('hostRef', host._id)).take(MAX_PENDING);
    return { watchedAt: host.watchedAt ?? null, commands: rows.map(r => ({ id: r._id, command: r.command, sentAt: r.sentAt })) };
  },
});

/** Host: these commands ran (or were refused); they are removed. Ids of other hosts are ignored. */
export const ack = mutation({
  args: { hostId: v.string(), ids: v.array(v.id('remoteCommands')) },
  returns: v.null(),
  handler: async (ctx, { hostId, ids }) => {
    const userId = await requireUserId(ctx);
    const host = await hostOf(ctx, userId, hostId);
    if (!host) return null;
    for (const id of ids.slice(0, MAX_PENDING * 2)) {
      const row = await ctx.db.get('remoteCommands', id);
      if (row && row.hostRef === host._id) await ctx.db.delete('remoteCommands', id);
    }
    return null;
  },
});

/**
 * Hourly: hosts that stopped heartbeating more than EXPIRE_MS ago, with their state and commands, CLEANUP_BATCH
 * at a time. It reads only expired rows (`by_seenAt`), so heartbeats on live hosts never conflict with it.
 */
export const cleanup = internalMutation({
  args: {},
  returns: v.object({ removed: v.number() }),
  handler: async ctx => {
    const cutoff = Date.now() - EXPIRE_MS;
    const batch = await ctx.db.query('remoteHosts').withIndex('by_seenAt', q => q.lt('seenAt', cutoff)).take(CLEANUP_BATCH);
    for (const host of batch) await removeHost(ctx, host);
    if (batch.length === CLEANUP_BATCH) await ctx.scheduler.runAfter(0, internal.remote.cleanup, {});
    return { removed: batch.length };
  },
});
