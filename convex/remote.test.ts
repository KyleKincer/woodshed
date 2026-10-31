/// <reference types="vite/client" />
// The phone remote (convex/remote.ts): hosts announce, heartbeat and close; remotes on the same account list
// them, watch one and send it allowlisted commands; the host reads and acks them. Nothing crosses accounts.
import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { describe, expect, test, vi } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import { CLEANUP_BATCH, EXPIRE_MS } from './remote';
import { MAX_HOSTS, MAX_PENDING } from '../shared/remote';

const modules = import.meta.glob('./**/*.ts');

async function code(promise: Promise<unknown>) {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    return ((error as ConvexError<any>).data as { code: string }).code;
  }
  throw new Error('expected a coded failure');
}

const STATE = { phase: 'playing', position: '13 · 2', section: 'Chorus', next: 'next: Bridge · 4 bars', rate: 0.75, bpm: 90,
  loop: true, loopLabel: 'Chorus', countIn: false, click: true, minusMe: true, mine: 'drums' };

async function setup() {
  const t = convexTest(schema, modules);
  const [kyleId, alexId] = await t.run(ctx => Promise.all(['kyle', 'alex'].map(name =>
    ctx.db.insert('users', { name, email: `${name}@test.example`, emailVerified: true, createdAt: 1 }))));
  const songId = await t.run(ctx => ctx.db.insert('songs', { userId: kyleId, title: 'Glasshouse', artist: 'Northbound', duration: 120, stems: [], stemMode: 'full', quality: { model: 'htdemucs', shifts: 0, overlap: 0.25, format: 'opus', bitrate: 192 }, addedAt: 1 } as any));
  return { t, kyle: t.withIdentity({ subject: kyleId }), alex: t.withIdentity({ subject: alexId }), songId };
}

describe('hosts', () => {
  test('a Stage announces, heartbeats, publishes its HUD and closes', async () => {
    const { kyle, alex, songId } = await setup();
    await kyle.mutation(api.remote.announce, { hostId: 'mac-host-1', name: 'MacBook', platform: 'mac', songId, title: 'Glasshouse', artist: 'Northbound', fresh: true });
    const [host] = await kyle.query(api.remote.hosts, {});
    expect(host).toMatchObject({ hostId: 'mac-host-1', name: 'MacBook', platform: 'mac', songId, title: 'Glasshouse', artist: 'Northbound' });
    expect(await alex.query(api.remote.hosts, {})).toEqual([]);   // another account sees nothing

    expect((await kyle.query(api.remote.view, { hostId: 'mac-host-1' }))?.state).toBeNull();
    await kyle.mutation(api.remote.publish, { hostId: 'mac-host-1', state: STATE });
    expect((await kyle.query(api.remote.view, { hostId: 'mac-host-1' }))?.state).toEqual(STATE);
    await kyle.mutation(api.remote.publish, { hostId: 'mac-host-1', state: { ...STATE, phase: 'stopped', section: 'x'.repeat(500) } });
    const view = await kyle.query(api.remote.view, { hostId: 'mac-host-1' });
    expect(view?.state?.phase).toBe('stopped');
    expect(view?.state?.section).toHaveLength(80);
    expect(await alex.query(api.remote.view, { hostId: 'mac-host-1' })).toBeNull();

    await kyle.mutation(api.remote.announce, { hostId: 'mac-host-1', name: 'MacBook', title: 'Low Tide' });
    expect((await kyle.query(api.remote.hosts, {}))).toHaveLength(1);
    expect((await kyle.query(api.remote.hosts, {}))[0].title).toBe('Low Tide');
    await kyle.mutation(api.remote.close, { hostId: 'mac-host-1' });
    expect(await kyle.query(api.remote.hosts, {})).toEqual([]);
    expect(await kyle.query(api.remote.view, { hostId: 'mac-host-1' })).toBeNull();
  });

  test('a song from another account, a bad host id and signed-out callers are refused', async () => {
    const { t, alex, songId } = await setup();
    expect(await code(alex.mutation(api.remote.announce, { hostId: 'alex-host-1', name: 'iPad', songId, title: 'x' }))).toBe('not_found');
    expect(await code(alex.mutation(api.remote.announce, { hostId: 'no', name: 'iPad', title: 'x' }))).toBe('invalid');
    expect(await code(t.mutation(api.remote.announce, { hostId: 'anon-host-1', name: 'x', title: 'x' }))).toBe('not_signed_in');
    expect(await t.query(api.remote.hosts, {})).toEqual([]);
    // Publishing for a host that never announced does nothing.
    await alex.mutation(api.remote.publish, { hostId: 'alex-host-1', state: STATE });
    expect(await alex.query(api.remote.view, { hostId: 'alex-host-1' })).toBeNull();
  });

  test('announce and watch return the server\'s clock (clients judge freshness by it); watch with no host only reads it', async () => {
    const { kyle } = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(5_000_000);
    expect(await kyle.mutation(api.remote.announce, { hostId: 'mac-host-1', name: 'MacBook', title: 'Glasshouse', fresh: true })).toEqual({ now: 5_000_000 });
    vi.setSystemTime(5_020_000);
    expect(await kyle.mutation(api.remote.watch, {})).toEqual({ now: 5_020_000 });
    expect((await kyle.query(api.remote.commands, { hostId: 'mac-host-1' })).watchedAt).toBeNull();
    expect(await kyle.mutation(api.remote.watch, { hostId: 'mac-host-1' })).toEqual({ now: 5_020_000 });
    expect((await kyle.query(api.remote.commands, { hostId: 'mac-host-1' })).watchedAt).toBe(5_020_000);
    // The next song is a fresh announce of the same row: still watched.
    await kyle.mutation(api.remote.announce, { hostId: 'mac-host-1', name: 'MacBook', title: 'Low Tide', fresh: true });
    expect((await kyle.query(api.remote.commands, { hostId: 'mac-host-1' })).watchedAt).toBe(5_020_000);
    vi.useRealTimers();
  });

  test('long names are cut on whole characters, never through an emoji', async () => {
    const { kyle } = await setup();
    const long = 'a'.repeat(199) + '\u{1F3B8}b';   // the guitar straddles the 200th code unit
    await kyle.mutation(api.remote.announce, { hostId: 'mac-host-1', name: 'MacBook', title: long, artist: long });
    const [host] = await kyle.query(api.remote.hosts, {});
    expect(host.title).toBe('a'.repeat(199) + '\u{1F3B8}');
    expect(host.artist).toBe('a'.repeat(199) + '\u{1F3B8}');
    await kyle.mutation(api.remote.publish, { hostId: 'mac-host-1', state: { ...STATE, section: 'a'.repeat(79) + '\u{1D11E}b' } });
    expect((await kyle.query(api.remote.view, { hostId: 'mac-host-1' }))?.state?.section).toBe('a'.repeat(79) + '\u{1D11E}');
  });

  test(`at most ${MAX_HOSTS} hosts per account: a new one drops the one seen longest ago`, async () => {
    const { kyle } = await setup();
    for (let i = 0; i < MAX_HOSTS + 2; i++) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_000_000 + i * 1000);
      await kyle.mutation(api.remote.announce, { hostId: `host-number-${i}`, name: `Device ${i}`, title: 'x' });
      vi.useRealTimers();
    }
    const hosts = await kyle.query(api.remote.hosts, {});
    expect(hosts).toHaveLength(MAX_HOSTS);
    expect(hosts[0].hostId).toBe(`host-number-${MAX_HOSTS + 1}`);
    expect(hosts.some(h => h.hostId === 'host-number-0')).toBe(false);
  });
});

describe('commands', () => {
  test('a remote sends allowlisted commands; the host reads them in order and acks them', async () => {
    const { kyle, alex } = await setup();
    await kyle.mutation(api.remote.announce, { hostId: 'mac-host-1', name: 'MacBook', title: 'Glasshouse' });
    expect(await kyle.mutation(api.remote.send, { hostId: 'mac-host-1', command: 'transport.playStop' })).toEqual({ queued: true });
    await kyle.mutation(api.remote.send, { hostId: 'mac-host-1', command: 'nav.nextSection' });
    const waiting = (await kyle.query(api.remote.commands, { hostId: 'mac-host-1' })).commands;
    expect(waiting.map(c => c.command)).toEqual(['transport.playStop', 'nav.nextSection']);
    expect(await code(kyle.mutation(api.remote.send, { hostId: 'mac-host-1', command: 'library.deleteSongs' }))).toBe('invalid');
    expect(await code(alex.mutation(api.remote.send, { hostId: 'mac-host-1', command: 'transport.playStop' }))).toBe('not_found');
    expect(await alex.query(api.remote.commands, { hostId: 'mac-host-1' })).toEqual({ watchedAt: null, commands: [] });
    await alex.mutation(api.remote.ack, { hostId: 'mac-host-1', ids: waiting.map(c => c.id) });   // not alex's: ignored
    expect((await kyle.query(api.remote.commands, { hostId: 'mac-host-1' })).commands).toHaveLength(2);
    await kyle.mutation(api.remote.ack, { hostId: 'mac-host-1', ids: [waiting[0].id] });
    expect((await kyle.query(api.remote.commands, { hostId: 'mac-host-1' })).commands.map(c => c.command)).toEqual(['nav.nextSection']);
  });

  test(`a host with ${MAX_PENDING} waiting commands takes no more; a fresh announce drops the old ones`, async () => {
    const { kyle } = await setup();
    await kyle.mutation(api.remote.announce, { hostId: 'mac-host-1', name: 'MacBook', title: 'Glasshouse' });
    for (let i = 0; i < MAX_PENDING; i++) await kyle.mutation(api.remote.send, { hostId: 'mac-host-1', command: 'speed.up' });
    expect(await kyle.mutation(api.remote.send, { hostId: 'mac-host-1', command: 'speed.up' })).toEqual({ queued: false });
    await kyle.mutation(api.remote.announce, { hostId: 'mac-host-1', name: 'MacBook', title: 'Glasshouse' });
    expect((await kyle.query(api.remote.commands, { hostId: 'mac-host-1' })).commands).toHaveLength(MAX_PENDING);
    await kyle.mutation(api.remote.announce, { hostId: 'mac-host-1', name: 'MacBook', title: 'Glasshouse', fresh: true });
    expect((await kyle.query(api.remote.commands, { hostId: 'mac-host-1' })).commands).toEqual([]);
  });

  test('a remote watching a host shows in the host\'s commands; a heartbeat keeps it', async () => {
    const { kyle, alex } = await setup();
    await kyle.mutation(api.remote.announce, { hostId: 'mac-host-1', name: 'MacBook', title: 'Glasshouse', artist: 'Northbound' });
    expect((await kyle.query(api.remote.commands, { hostId: 'mac-host-1' })).watchedAt).toBeNull();
    await alex.mutation(api.remote.watch, { hostId: 'mac-host-1' });   // another account: nothing
    expect((await kyle.query(api.remote.commands, { hostId: 'mac-host-1' })).watchedAt).toBeNull();
    await kyle.mutation(api.remote.watch, { hostId: 'mac-host-1' });
    const watched = (await kyle.query(api.remote.commands, { hostId: 'mac-host-1' })).watchedAt;
    expect(watched).toEqual(expect.any(Number));
    await kyle.mutation(api.remote.announce, { hostId: 'mac-host-1', name: 'MacBook', title: 'Low Tide' });
    expect((await kyle.query(api.remote.commands, { hostId: 'mac-host-1' })).watchedAt).toBe(watched);
    expect((await kyle.query(api.remote.hosts, {}))[0].artist).toBeUndefined();   // the new song has none
  });

  test('closing a host removes its commands; sending to it says it closed', async () => {
    const { kyle } = await setup();
    await kyle.mutation(api.remote.announce, { hostId: 'mac-host-1', name: 'MacBook', title: 'Glasshouse' });
    await kyle.mutation(api.remote.send, { hostId: 'mac-host-1', command: 'transport.again' });
    await kyle.mutation(api.remote.close, { hostId: 'mac-host-1' });
    expect(await code(kyle.mutation(api.remote.send, { hostId: 'mac-host-1', command: 'transport.again' }))).toBe('not_found');
  });
});

describe('cleanup', () => {
  test('drops hosts that stopped heartbeating a day ago, with their state and commands', async () => {
    const { t, kyle } = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000_000);
    await kyle.mutation(api.remote.announce, { hostId: 'old-host-1', name: 'Old', title: 'x' });
    await kyle.mutation(api.remote.publish, { hostId: 'old-host-1', state: STATE });
    await kyle.mutation(api.remote.send, { hostId: 'old-host-1', command: 'transport.again' });
    vi.setSystemTime(10_000_000 + EXPIRE_MS - 1000);
    await kyle.mutation(api.remote.announce, { hostId: 'new-host-1', name: 'New', title: 'y' });
    vi.setSystemTime(10_000_000 + EXPIRE_MS + 1000);
    expect(await t.mutation(internal.remote.cleanup, {})).toEqual({ removed: 1 });
    vi.useRealTimers();
    expect((await kyle.query(api.remote.hosts, {})).map(h => h.hostId)).toEqual(['new-host-1']);
    const leftovers = await t.run(async ctx => [
      ...(await ctx.db.query('remoteStates').collect()), ...(await ctx.db.query('remoteCommands').collect())]);
    expect(leftovers).toEqual([]);
  });

  test(`removes ${CLEANUP_BATCH} hosts per run by the seenAt index and runs again while more remain`, async () => {
    const { t, kyle } = await setup();
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const userId = 'many-hosts-user';
    const expired = CLEANUP_BATCH + 50;
    await t.run(async ctx => {
      for (let i = 0; i < expired; i++) {
        const hostRef = await ctx.db.insert('remoteHosts', { userId, hostId: `old-host-${i}`, name: 'Old', title: 'x', seenAt: 1_000_000 + i });
        await ctx.db.insert('remoteStates', { hostRef, userId, state: STATE, updatedAt: 1 });
        await ctx.db.insert('remoteCommands', { hostRef, userId, command: 'transport.again', sentAt: 1 });
      }
    });
    await kyle.mutation(api.remote.announce, { hostId: 'live-host-1', name: 'New', title: 'y' });
    vi.setSystemTime(1_000_000 + EXPIRE_MS + expired + 1);
    expect(await t.mutation(internal.remote.cleanup, {})).toEqual({ removed: CLEANUP_BATCH });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    const left = await t.run(async ctx => ({
      hosts: (await ctx.db.query('remoteHosts').collect()).map(h => h.hostId),
      states: (await ctx.db.query('remoteStates').collect()).length,
      commands: (await ctx.db.query('remoteCommands').collect()).length,
    }));
    expect(left).toEqual({ hosts: ['live-host-1'], states: 0, commands: 0 });
  });
});
