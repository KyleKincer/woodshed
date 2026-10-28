/// <reference types="vite/client" />
/**
 * convex/jobs.ts (BK2, architecture §6.4): listing, creation rules, detections,
 * retry, the applied-detection offer, and coded errors (§6.1).
 */
import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import type { WithoutSystemFields } from 'convex/server';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { defaultSongMap } from '../shared/song-map';
import { LIST_PER_STATUS, PRESENCE_ONLINE_MS, QUEUE_CAP, RESUME_MESSAGE, UNAPPLIED_MAX, UNAPPLIED_SCAN, jobRowValidator, jobDetailValidator } from './jobs';
import { resolveQuality } from './lib/presets';

const modules = import.meta.glob('./**/*.ts');
const quality = { model: 'htdemucs', shifts: 1, overlap: 0.25, format: 'opus' as const, bitrate: 192 };
const stems = [{ name: 'drums', key: 'users/alice/songs/a/drums.opus' }];
const T0 = 1_700_000_000_000;

type T = ReturnType<typeof convexTest>;
type JobInput = WithoutSystemFields<Doc<'jobs'>>;
type SongInput = WithoutSystemFields<Doc<'songs'>>;

const song = (userId: string, title: string, extra: Partial<SongInput> = {}): SongInput => ({
  userId, title, duration: 200, stems, stemMode: 'full', quality, addedAt: T0, ...extra,
});
const job = (userId: string, extra: Partial<JobInput> = {}): JobInput => ({
  userId, kind: 'separate', label: 'x', status: 'queued', stage: 'queued', percent: 0, createdAt: T0, updatedAt: T0, ...extra,
});
const search = (value = 'radiohead weird fishes') => ({ type: 'search' as const, value });
const realTempo = { songMap: { ...defaultSongMap(200, 120, 4, 4, 0.5), origin: 'tapped' as const } };

/** Two accounts, each with a computer; alice also has a second one. */
async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity({ subject: 'alice' });
  const bob = t.withIdentity({ subject: 'bob' });
  const ids = await t.run(async ctx => ({
    mac: await ctx.db.insert('devices', { userId: 'alice', tokenHash: 'a'.repeat(64), name: 'Kyle’s MacBook Pro', displayName: 'Studio Mac', revoked: false }),
    pc: await ctx.db.insert('devices', { userId: 'alice', tokenHash: 'b'.repeat(64), name: 'DESKTOP-4F2K9', revoked: false }),
    bobPc: await ctx.db.insert('devices', { userId: 'bob', tokenHash: 'c'.repeat(64), name: 'Bob’s PC', revoked: false }),
    songId: await ctx.db.insert('songs', song('alice', 'Weird Fishes')),
    bobSong: await ctx.db.insert('songs', song('bob', 'Bob’s song')),
  }));
  return { t, alice, bob, ...ids };
}

/** The ConvexError data of a rejected call. */
async function errorOf(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error, 'expected the call to fail').toBeInstanceOf(ConvexError);
  return (error as ConvexError<any>).data as Record<string, unknown>;
}
const codeOf = async (promise: Promise<unknown>) => (await errorOf(promise)).code;

const insertJob = (t: T, row: JobInput) => t.run(ctx => ctx.db.insert('jobs', row));
const readJob = (t: T, id: Id<'jobs'>) => t.run(ctx => ctx.db.get('jobs', id));
const setAccount = (t: T, userId: string, status: 'active' | 'export_only' | 'suspended') =>
  t.run(ctx => ctx.db.insert('accountControls', { userId, status, notes: '' }));

// ---- listActive ---------------------------------------------------------------

describe('listActive', () => {
  test('reads each live status on its own, so 60 newer done jobs never hide live ones', async () => {
    const { t, alice, mac } = await setup();
    const live = [
      await insertJob(t, job('alice', { deviceId: mac, status: 'queued', createdAt: T0 + 3 })),
      await insertJob(t, job('alice', { deviceId: mac, status: 'running', stage: 'separate', percent: 40, createdAt: T0 + 1 })),
      await insertJob(t, job('alice', { deviceId: mac, status: 'error', stage: 'download', error: 'boom', createdAt: T0 + 2 })),
    ];
    for (let i = 0; i < 60; i++) await insertJob(t, job('alice', { status: i % 2 ? 'done' : 'canceled', stage: 'done', percent: 100, createdAt: T0 + 100 + i }));
    await insertJob(t, job('bob', { status: 'queued' }));
    const rows = await alice.query(api.jobs.listActive, {});
    // Sorted by createdAt: running (T0+1), error (T0+2), queued (T0+3).
    expect(rows.map(r => r.jobId)).toEqual([live[1], live[2], live[0]]);
    expect(await t.query(api.jobs.listActive, {})).toEqual([]);
  });

  test('caps each status at 50: the head of the queue and the newest failures', async () => {
    const { t, alice } = await setup();
    const queued: Id<'jobs'>[] = [], failed: Id<'jobs'>[] = [];
    for (let i = 0; i < LIST_PER_STATUS + 5; i++) queued.push(await insertJob(t, job('alice', { status: 'queued', createdAt: T0 + i })));
    for (let i = 0; i < LIST_PER_STATUS + 5; i++) failed.push(await insertJob(t, job('alice', { status: 'error', createdAt: T0 + 1000 + i })));
    const rows = await alice.query(api.jobs.listActive, {});
    expect(rows).toHaveLength(2 * LIST_PER_STATUS);
    expect(rows.filter(r => r.status === 'queued').map(r => r.jobId)).toEqual(queued.slice(0, LIST_PER_STATUS));
    expect(rows.filter(r => r.status === 'error').map(r => r.jobId)).toEqual(failed.slice(5));
    for (let i = 1; i < rows.length; i++) expect(rows[i].createdAt).toBeGreaterThanOrEqual(rows[i - 1].createdAt);
  });

  test('rows carry the 2.0 fields, with nulls and defaults for 1.9 rows', async () => {
    const { t, alice, mac, songId } = await setup();
    const chain = await insertJob(t, job('alice', { status: 'done', stage: 'done' }));
    const full = await insertJob(t, job('alice', {
      deviceId: mac, songId, label: 'Weird Fishes', status: 'error', stage: 'download', percent: 0, message: 'Downloading…', error: 'Sign in to confirm',
      source: { type: 'upload', value: 'up-1', filename: 'take 3.wav' }, settings: { preset: 'fast', stemMode: 'six', bitrate: 192, custom: { model: 'htdemucs_ft', shifts: 2, overlap: 0.25 } },
      meta: { title: 'Weird Fishes/Arpeggi', thumbnail: 'https://i.ytimg.com/x.jpg' }, attempts: 2, startedAt: T0 + 5, updatedAt: T0 + 9,
      errorCode: 'bot_check', retryAt: T0 + 300_000, confirmed: true, createdAt: T0 + 1,
    }));
    const beats = await insertJob(t, job('alice', { kind: 'beats', songId, chainedFrom: chain, settings: { sections: true }, status: 'running', stage: 'detect', createdAt: T0 + 2 }));
    const legacy = await insertJob(t, job('alice', { label: 'Pre-device job', createdAt: T0 + 3 }));
    const rows = await alice.query(api.jobs.listActive, {});
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(Object.keys(jobRowValidator.fields).sort());
    expect(rows.find(r => r.jobId === full)).toEqual({
      jobId: full, kind: 'separate', songId, label: 'Weird Fishes', status: 'error', stage: 'download', percent: 0,
      message: 'Downloading…', error: 'Sign in to confirm', meta: { title: 'Weird Fishes/Arpeggi', thumbnail: 'https://i.ytimg.com/x.jpg' },
      deviceId: mac, createdAt: T0 + 1, startedAt: T0 + 5, updatedAt: T0 + 9, attempts: 2, errorCode: 'bot_check', retryAt: T0 + 300_000,
      chainedFrom: null, confirmed: true, source: { type: 'upload', value: 'up-1', filename: 'take 3.wav' },
      // The model is whatever the worker resolves for `six` (BK4 forces htdemucs_6s), never a literal here.
      settingsSummary: { preset: 'fast', stemMode: 'six', model: resolveQuality({ preset: 'fast', stemMode: 'six' }).model },
    });
    expect(rows.find(r => r.jobId === beats)).toMatchObject({ kind: 'beats', chainedFrom: chain, settingsSummary: null, confirmed: false });
    expect(rows.find(r => r.jobId === legacy)).toMatchObject({
      deviceId: null, songId: null, source: null, settingsSummary: null, meta: null, attempts: 0, startedAt: null,
      errorCode: null, retryAt: null, chainedFrom: null, confirmed: false, message: null, error: null,
    });
  });
});

// ---- createSeparation ---------------------------------------------------------

describe('createSeparation', () => {
  test('stores the cleaned card metadata and confirmed, and returns only the job id', async () => {
    const { t, alice, mac } = await setup();
    const result = await alice.mutation(api.jobs.createSeparation, {
      deviceId: mac, source: search(), settings: { preset: 'fast' }, label: 'radiohead weird fishes', confirmed: true,
      meta: { title: '  Weird Fishes/Arpeggi ', channel: 'Radiohead', duration: 318, thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg', provider: 'youtube' },
    });
    expect(Object.keys(result)).toEqual(['jobId']);
    const stored = await readJob(t, result.jobId);
    expect(stored).toMatchObject({
      kind: 'separate', status: 'queued', stage: 'queued', percent: 0, attempts: 0, deviceId: mac, confirmed: true,
      meta: { title: 'Weird Fishes/Arpeggi', channel: 'Radiohead', duration: 318, thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg', provider: 'youtube' },
    });
    const unconfirmed = await alice.mutation(api.jobs.createSeparation, { deviceId: mac, source: search(), settings: {}, label: 'x', confirmed: false });
    expect((await readJob(t, unconfirmed.jobId))?.confirmed).toBe(false);
    const absent = await alice.mutation(api.jobs.createSeparation, { deviceId: mac, source: search(), settings: {}, label: 'x', meta: { title: '  ' } });
    const row = await readJob(t, absent.jobId);
    expect(row?.confirmed).toBeUndefined();
    expect(row?.meta).toBeUndefined();
  });

  test('meta validation: https thumbnails only, and length caps', async () => {
    const { alice, mac } = await setup();
    const create = (meta: Record<string, unknown>) => alice.mutation(api.jobs.createSeparation, { deviceId: mac, source: search(), settings: {}, label: 'x', meta });
    for (const thumbnail of ['http://i.ytimg.com/x.jpg', 'javascript:alert(1)', 'not a url', `https://i.ytimg.com/${'x'.repeat(2000)}.jpg`]) {
      expect(await errorOf(create({ thumbnail })), thumbnail).toMatchObject({ code: 'invalid', field: 'meta.thumbnail' });
    }
    expect(await errorOf(create({ title: 'x'.repeat(301) }))).toMatchObject({ code: 'invalid', field: 'meta.title' });
    expect(await errorOf(create({ channel: 'x'.repeat(301) }))).toMatchObject({ code: 'invalid', field: 'meta.channel' });
    expect(await errorOf(create({ provider: 'x'.repeat(301) }))).toMatchObject({ code: 'invalid', field: 'meta.provider' });
    expect(await errorOf(create({ duration: -1 }))).toMatchObject({ code: 'invalid', field: 'meta.duration' });
    expect(await errorOf(create({ duration: Number.POSITIVE_INFINITY }))).toMatchObject({ code: 'invalid', field: 'meta.duration' });
    await expect(create({ title: 'x'.repeat(300), thumbnail: `https://i.ytimg.com/${'x'.repeat(1900)}` })).resolves.toHaveProperty('jobId');
  });

  test('an upload is processed by, and recorded against, the chosen computer', async () => {
    const { t, alice, pc } = await setup();
    const source = { type: 'upload' as const, value: 'up-7f3a', filename: 'rehearsal.wav' };
    const { jobId } = await alice.mutation(api.jobs.createSeparation, { deviceId: pc, source, settings: {}, label: 'rehearsal.wav' });
    expect(await readJob(t, jobId)).toMatchObject({ deviceId: pc, source });
    expect((await alice.query(api.jobs.listActive, {}))[0]).toMatchObject({ deviceId: pc, source });
  });

  test('a new upload’s title is stored as a protected override (ticket I2a-5)', async () => {
    const { t, alice, mac, pc } = await setup();
    const source = { type: 'upload' as const, value: 'up-9c1d', filename: 'take 3.wav' };
    const { jobId } = await alice.mutation(api.jobs.createSeparation, {
      deviceId: pc, source, settings: {}, label: 'take 3.wav', meta: { title: '  Blue in Green (live) ' },
    });
    expect((await readJob(t, jobId))?.meta).toEqual({ title: 'Blue in Green (live)', titleOverride: true });
    expect((await alice.query(api.jobs.listActive, {})).find(r => r.jobId === jobId)?.meta).toEqual({ title: 'Blue in Green (live)', titleOverride: true });
    // An upload without a title (or a blank one) has nothing to protect.
    const untitled = await alice.mutation(api.jobs.createSeparation, { deviceId: pc, source, settings: {}, label: 'take 3.wav', meta: { title: '   ' } });
    expect((await readJob(t, untitled.jobId))?.meta).toBeUndefined();
    const durationOnly = await alice.mutation(api.jobs.createSeparation, { deviceId: pc, source, settings: {}, label: 'take 3.wav', meta: { duration: 12 } });
    expect((await readJob(t, durationOnly.jobId))?.meta).toEqual({ duration: 12 });
    // A search result's title is the processor's guess (B4), not the user's.
    const searched = await alice.mutation(api.jobs.createSeparation, { deviceId: mac, source: search(), settings: {}, label: 'x', meta: { title: 'Weird Fishes' } });
    expect((await readJob(t, searched.jobId))?.meta).toEqual({ title: 'Weird Fishes' });
    // A re-split keeps its song's title.
    const uploaded = await t.run(ctx => ctx.db.insert('songs', song('alice', 'jam', { source, originDeviceId: pc })));
    const resplit = await alice.mutation(api.jobs.createSeparation, { deviceId: pc, settings: {}, label: 'jam (re-split)', replaceSongId: uploaded, meta: { title: 'jam' } });
    expect((await readJob(t, resplit.jobId))?.meta).toEqual({ title: 'jam' });
    // Only the server sets the flag: a client cannot send it.
    const forged = { title: 'x', titleOverride: true } as unknown as { title: string };
    await expect(alice.mutation(api.jobs.createSeparation, { deviceId: mac, source: search(), settings: {}, label: 'x', meta: forged })).rejects.toThrow();
  });

  test('a job needs an owned, paired computer (B5)', async () => {
    const { t, alice, bob, mac, pc } = await setup();
    const create = (deviceId: Id<'devices'>, caller = alice) => caller.mutation(api.jobs.createSeparation, { deviceId, source: search(), settings: {}, label: 'x' });
    const foreign = await errorOf(create(mac, bob));
    expect(foreign).toMatchObject({ code: 'device_unpaired' });
    expect(String(foreign.message)).toContain('companion');
    await t.run(ctx => ctx.db.patch('devices', pc, { revoked: true, revokedBy: 'user' }));
    expect(await codeOf(create(pc))).toBe('device_unpaired');
    await t.run(ctx => ctx.db.patch('devices', pc, { revokedBy: 'admin' }));
    expect(await codeOf(create(pc))).toBe('device_revoked_admin');
    await t.run(ctx => ctx.db.patch('devices', pc, { revokedBy: undefined }));
    expect(await codeOf(create(pc))).toBe('device_unpaired'); // a 1.9 revoked row without revokedBy
    await t.run(ctx => ctx.db.delete('devices', pc));
    expect(await codeOf(create(pc))).toBe('device_unpaired');
    await expect(create(mac)).resolves.toHaveProperty('jobId');
  });

  test('re-splitting an uploaded song must run on the computer that holds the file (D38)', async () => {
    const { t, alice, mac, pc } = await setup();
    const upload = { type: 'upload' as const, value: 'local-1', filename: 'jam.wav' };
    const uploaded = await t.run(ctx => ctx.db.insert('songs', song('alice', 'jam', { source: upload, originDeviceId: mac })));
    const resplit = (deviceId: Id<'devices'>, extra: Record<string, unknown> = {}) =>
      alice.mutation(api.jobs.createSeparation, { deviceId, settings: {}, label: 'jam (re-split)', replaceSongId: uploaded, ...extra });
    expect(await errorOf(resplit(pc))).toMatchObject({
      code: 'resplit_wrong_device', deviceName: 'Studio Mac', message: 'Re-split this song on Studio Mac, which has the original file.',
    });
    expect(await codeOf(resplit(pc, { source: upload }))).toBe('resplit_wrong_device');
    const { jobId } = await resplit(mac);
    expect(await readJob(t, jobId)).toMatchObject({ songId: uploaded, source: upload, deviceId: mac });
    // A new recording for the same song is not a re-split of the file.
    await expect(resplit(pc, { source: search() })).resolves.toHaveProperty('jobId');
    // A 1.9 upload without an origin device runs anywhere.
    const legacy = await t.run(ctx => ctx.db.insert('songs', song('alice', 'old', { source: upload })));
    await expect(alice.mutation(api.jobs.createSeparation, { deviceId: pc, settings: {}, label: 'old', replaceSongId: legacy })).resolves.toHaveProperty('jobId');
  });

  test('re-split refusals: no source, another account’s song', async () => {
    const { alice, mac, songId, bobSong } = await setup();
    expect(await errorOf(alice.mutation(api.jobs.createSeparation, { deviceId: mac, settings: {}, label: 'x', replaceSongId: songId }))).toMatchObject({ code: 'resplit_no_source' });
    expect(await codeOf(alice.mutation(api.jobs.createSeparation, { deviceId: mac, settings: {}, label: 'x', replaceSongId: bobSong }))).toBe('not_owner');
  });

  test('settings: validated, `six` kept, unknown keys dropped', async () => {
    const { t, alice, mac } = await setup();
    const create = (settings: unknown) => alice.mutation(api.jobs.createSeparation, { deviceId: mac, source: search(), settings, label: 'x' });
    const { jobId } = await create({ preset: 'studio', stemMode: 'six', junk: 'x'.repeat(100) });
    const stored = (await readJob(t, jobId))?.settings;
    expect(stored).toMatchObject({ preset: 'studio', stemMode: 'six' });
    expect(stored).not.toHaveProperty('junk');
    expect(await errorOf(create({ preset: 'ultra' }))).toMatchObject({ code: 'invalid', field: 'settings.preset' });
    expect(await errorOf(create({ stemMode: 'eight' }))).toMatchObject({ code: 'invalid', field: 'settings.stemMode' });
    expect(await errorOf(create('fast'))).toMatchObject({ code: 'invalid', field: 'settings' });
  });

  test('caps: the per-computer queue, labels and sources', async () => {
    const { t, alice, mac, pc } = await setup();
    for (let i = 0; i < QUEUE_CAP; i++) await insertJob(t, job('alice', { deviceId: mac }));
    expect(await errorOf(alice.mutation(api.jobs.createSeparation, { deviceId: mac, source: search(), settings: {}, label: 'x' }))).toMatchObject({ code: 'queue_full' });
    await expect(alice.mutation(api.jobs.createSeparation, { deviceId: pc, source: search(), settings: {}, label: 'x' })).resolves.toHaveProperty('jobId');
    expect(await errorOf(alice.mutation(api.jobs.createSeparation, { deviceId: pc, source: search(), settings: {}, label: 'x'.repeat(501) }))).toMatchObject({ code: 'invalid', field: 'label' });
    expect(await errorOf(alice.mutation(api.jobs.createSeparation, { deviceId: pc, source: search('x'.repeat(2001)), settings: {}, label: 'x' }))).toMatchObject({ code: 'invalid', field: 'source', message: 'The source is too long (2000 characters max).' });
    // A blank source is not "too long".
    expect(await errorOf(alice.mutation(api.jobs.createSeparation, { deviceId: pc, source: search('   '), settings: {}, label: 'x' }))).toMatchObject({ code: 'invalid', field: 'source', message: 'Enter a link or search.' });
  });

  test('account states: signed out, export-only and suspended are refused with codes', async () => {
    const { t, alice, mac } = await setup();
    const args = { deviceId: mac, source: search(), settings: {}, label: 'x' };
    expect(await codeOf(t.mutation(api.jobs.createSeparation, args))).toBe('not_signed_in');
    await setAccount(t, 'alice', 'export_only');
    const exportOnly = await errorOf(alice.mutation(api.jobs.createSeparation, args));
    expect(exportOnly.code).toBe('account_export_only');
    expect(String(exportOnly.message)).toContain('export-only');
  });

  test('a suspended account can do nothing with jobs', async () => {
    const { t, alice, mac, songId } = await setup();
    const jobId = await insertJob(t, job('alice', { kind: 'beats', songId, deviceId: mac, status: 'done', stage: 'done', result: { beats: [] } }));
    await setAccount(t, 'alice', 'suspended');
    expect(await codeOf(alice.mutation(api.jobs.createSeparation, { deviceId: mac, source: search(), settings: {}, label: 'x' }))).toBe('account_suspended');
    expect(await codeOf(alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: mac }))).toBe('account_suspended');
    expect(await codeOf(alice.mutation(api.jobs.cancel, { jobId }))).toBe('account_suspended');
    expect(await codeOf(alice.mutation(api.jobs.dismiss, { jobId }))).toBe('account_suspended');
    expect(await codeOf(alice.mutation(api.jobs.markApplied, { jobId }))).toBe('account_suspended');
    expect(await codeOf(alice.mutation(api.jobs.retry, { jobId }))).toBe('account_suspended');
    expect(await codeOf(alice.query(api.jobs.listActive, {}))).toBe('account_suspended');
    expect(await codeOf(alice.query(api.jobs.get, { jobId }))).toBe('account_suspended');
    expect(await codeOf(alice.query(api.jobs.latestDetection, { songId }))).toBe('account_suspended');
  });
});

// ---- detections ---------------------------------------------------------------

describe('createBeatDetection', () => {
  test('runs on the chosen computer, and a live detection is reused instead of duplicated', async () => {
    const { t, alice, pc, songId } = await setup();
    const first = await alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: pc });
    expect(await readJob(t, first.jobId)).toMatchObject({
      kind: 'beats', songId, deviceId: pc, status: 'queued', stage: 'queued', percent: 0, label: 'Finding bars — Weird Fishes', settings: { sections: true },
    });
    expect(await alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: pc })).toEqual(first);
    await t.run(ctx => ctx.db.patch('jobs', first.jobId, { status: 'running', stage: 'detect' }));
    expect(await alice.mutation(api.jobs.createBeatDetection, { songId })).toEqual(first);
    await t.run(ctx => ctx.db.patch('jobs', first.jobId, { status: 'done', stage: 'done' }));
    const second = await alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: pc });
    expect(second.jobId).not.toBe(first.jobId);
    // A live sections job is a different kind and is not reused.
    await t.run(ctx => ctx.db.patch('jobs', second.jobId, { status: 'error' }));
    await insertJob(t, job('alice', { kind: 'sections', songId, deviceId: pc }));
    expect((await alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: pc })).jobId).not.toBe(second.jobId);
  });

  test('settings.sections follows the account’s autoSections', async () => {
    const { t, alice, mac, songId } = await setup();
    await t.run(ctx => ctx.db.insert('userSettings', { userId: 'alice', settings: { preset: 'fast', autoSections: false } }));
    const { jobId } = await alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: mac });
    expect((await readJob(t, jobId))?.settings).toEqual({ sections: false });
  });

  test('without a deviceId, the most recently seen online computer runs it', async () => {
    const { t, alice, mac, pc, songId } = await setup();
    // No presence and two computers: the caller has to choose.
    expect(await codeOf(alice.mutation(api.jobs.createBeatDetection, { songId }))).toBe('device_unpaired');
    const now = Date.now();
    const presence = await t.run(async ctx => ({
      mac: await ctx.db.insert('devicePresence', { deviceId: mac, userId: 'alice', lastSeenAt: now - 1_000, state: 'offline' }),
      pc: await ctx.db.insert('devicePresence', { deviceId: pc, userId: 'alice', lastSeenAt: now - 30_000, state: 'idle' }),
    }));
    const { jobId } = await alice.mutation(api.jobs.createBeatDetection, { songId });
    expect((await readJob(t, jobId))?.deviceId).toBe(pc);
    // A computer that stopped heartbeating without saying so (§6.6: not seen for 150 s) is offline,
    // so a cleanly shut-down computer seen more recently wins.
    await t.run(async ctx => {
      await ctx.db.delete('jobs', jobId);
      await ctx.db.patch('devicePresence', presence.pc, { lastSeenAt: now - 30 * 86_400_000 });
      await ctx.db.patch('devicePresence', presence.mac, { lastSeenAt: now - 60_000 });
    });
    const viaMac = (await alice.mutation(api.jobs.createBeatDetection, { songId })).jobId;
    expect((await readJob(t, viaMac))?.deviceId).toBe(mac);
    // Just inside the window, the PC is online again and wins.
    await t.run(async ctx => {
      await ctx.db.delete('jobs', viaMac);
      await ctx.db.patch('devicePresence', presence.pc, { lastSeenAt: Date.now() - PRESENCE_ONLINE_MS + 10_000 });
    });
    expect((await readJob(t, (await alice.mutation(api.jobs.createBeatDetection, { songId })).jobId))?.deviceId).toBe(pc);
  });

  test('dedupe never returns a detection no computer can run', async () => {
    const { t, alice, mac, pc, bobPc, songId } = await setup();
    const first = await alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: mac });
    // The computer it was queued on is revoked: the stale job is canceled and a new one runs on the computer chosen now.
    await t.run(ctx => ctx.db.patch('devices', mac, { revoked: true, revokedBy: 'user' }));
    const second = await alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: pc });
    expect(second.jobId).not.toBe(first.jobId);
    expect(await readJob(t, first.jobId)).toMatchObject({ status: 'canceled' });
    expect(await readJob(t, second.jobId)).toMatchObject({ status: 'queued', deviceId: pc });
    // A gone computer (no deviceId given): replaced on the default computer.
    await t.run(ctx => ctx.db.delete('devices', pc));
    await t.run(ctx => ctx.db.patch('devices', mac, { revoked: false, revokedBy: undefined }));
    const third = await alice.mutation(api.jobs.createBeatDetection, { songId });
    expect(third.jobId).not.toBe(second.jobId);
    expect(await readJob(t, third.jobId)).toMatchObject({ status: 'queued', deviceId: mac });
    // Another account's computer is refused even while a live detection exists.
    expect(await codeOf(alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: bobPc }))).toBe('device_unpaired');
  });

  test('dedupe follows the computer the web chose, unless the job is already running', async () => {
    const { t, alice, mac, pc, songId } = await setup();
    const first = await alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: mac });
    // Queued on an offline Mac, and the web now picks the online PC: moved, not ignored.
    const moved = await alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: pc });
    expect(moved.jobId).not.toBe(first.jobId);
    expect((await readJob(t, first.jobId))?.status).toBe('canceled');
    expect((await alice.query(api.jobs.listActive, {})).map(r => r.jobId)).toEqual([moved.jobId]);
    // Once a computer is running it, it is reused whichever computer is chosen.
    await t.run(ctx => ctx.db.patch('jobs', moved.jobId, { status: 'running', stage: 'detect' }));
    expect(await alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: mac })).toEqual(moved);
    expect(await alice.mutation(api.jobs.createBeatDetection, { songId })).toEqual(moved);
  });

  test('a user request that reuses a chained B6 job makes it user-started (D44)', async () => {
    const { t, alice, mac, songId } = await setup();
    const chain = await insertJob(t, job('alice', { status: 'done', stage: 'done' }));
    const chained = await insertJob(t, job('alice', { kind: 'beats', songId, deviceId: mac, chainedFrom: chain, settings: { sections: true } }));
    expect(await alice.mutation(api.jobs.createBeatDetection, { songId })).toEqual({ jobId: chained });
    expect((await readJob(t, chained))?.chainedFrom).toBeUndefined();
    await t.run(ctx => ctx.db.patch('jobs', chained, { status: 'done', stage: 'done', result: { beats: [[0.5, 1]] } }));
    expect(await alice.query(api.jobs.latestDetection, { songId })).toMatchObject({ jobId: chained });
  });

  test('without a deviceId, a single paired computer is used; none is refused', async () => {
    const { t, alice, mac, pc, songId } = await setup();
    await t.run(ctx => ctx.db.patch('devices', pc, { revoked: true, revokedBy: 'user' }));
    const { jobId } = await alice.mutation(api.jobs.createBeatDetection, { songId });
    expect((await readJob(t, jobId))?.deviceId).toBe(mac);
    await t.run(async ctx => { await ctx.db.patch('devices', mac, { revoked: true }); await ctx.db.delete('jobs', jobId); });
    expect(await codeOf(alice.mutation(api.jobs.createBeatDetection, { songId }))).toBe('device_unpaired');
  });

  test('refusals: another account’s song or computer, export-only accounts', async () => {
    const { t, alice, mac, bobPc, songId, bobSong } = await setup();
    expect(await codeOf(alice.mutation(api.jobs.createBeatDetection, { songId: bobSong, deviceId: mac }))).toBe('not_owner');
    expect(await codeOf(alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: bobPc }))).toBe('device_unpaired');
    await setAccount(t, 'alice', 'export_only');
    expect(await codeOf(alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: mac }))).toBe('account_export_only');
  });
});

describe('createSectionDetection', () => {
  test('needs a real map, then creates one live sections job per song', async () => {
    const { t, alice, mac, songId } = await setup();
    expect(await errorOf(alice.mutation(api.jobs.createSectionDetection, { songId, deviceId: mac }))).toMatchObject({ code: 'invalid' });
    await t.run(ctx => ctx.db.patch('songs', songId, { tempo: realTempo }));
    const first = await alice.mutation(api.jobs.createSectionDetection, { songId, deviceId: mac });
    expect(await readJob(t, first.jobId)).toMatchObject({ kind: 'sections', songId, deviceId: mac, status: 'queued', label: 'Finding sections — Weird Fishes' });
    expect(await alice.mutation(api.jobs.createSectionDetection, { songId })).toEqual(first);
    expect((await alice.query(api.jobs.listActive, {})).map(r => r.kind)).toEqual(['sections']);
  });

  test('a drum chart counts as a real map; another account’s song is refused', async () => {
    const { t, alice, mac, songId, bobSong } = await setup();
    await t.run(ctx => ctx.db.patch('songs', songId, { hasChart: true }));
    await expect(alice.mutation(api.jobs.createSectionDetection, { songId, deviceId: mac })).resolves.toHaveProperty('jobId');
    expect(await codeOf(alice.mutation(api.jobs.createSectionDetection, { songId: bobSong, deviceId: mac }))).toBe('not_owner');
  });
});

// ---- retry --------------------------------------------------------------------

describe('retry', () => {
  const failedJob = (deviceId: Id<'devices'>, extra: Partial<JobInput> = {}) => job('alice', {
    deviceId, status: 'error', stage: 'download', percent: 37, error: 'Sign in to confirm you’re not a bot', errorCode: 'bot_check',
    retryAt: T0 + 300_000, attempts: 1, message: 'Downloading…', source: search(),
    settings: { preset: 'studio', stemMode: 'full', bitrate: 192, format: 'opus', custom: { model: 'htdemucs_ft', shifts: 10, overlap: 0.5 } }, ...extra,
  });

  test('re-queues a failed job and clears its failure', async () => {
    const { t, alice, mac } = await setup();
    const jobId = await insertJob(t, failedJob(mac));
    await alice.mutation(api.jobs.retry, { jobId });
    const row = await readJob(t, jobId);
    expect(row).toMatchObject({ status: 'queued', stage: 'queued', percent: 0, message: RESUME_MESSAGE, attempts: 1, settings: { preset: 'studio' } });
    expect(row?.error).toBeUndefined();
    expect(row?.errorCode).toBeUndefined();
    expect(row?.retryAt).toBeUndefined();
    expect(row!.updatedAt).toBeGreaterThan(T0);
  });

  test('with a preset, re-resolves the settings (Try Fast quality)', async () => {
    const { t, alice, mac } = await setup();
    const jobId = await insertJob(t, failedJob(mac));
    await alice.mutation(api.jobs.retry, { jobId, preset: 'fast' });
    expect((await readJob(t, jobId))?.settings).toMatchObject({ preset: 'fast', stemMode: 'full', model: 'htdemucs', shifts: 0, overlap: 0.25 });
    await t.run(ctx => ctx.db.patch('jobs', jobId, { status: 'error' }));
    expect((await alice.query(api.jobs.listActive, {}))[0].settingsSummary).toEqual({ preset: 'fast', stemMode: 'full', model: 'htdemucs' });
    // A 1.9 row's settings (a mode 2.0 never writes) still re-resolve.
    const legacy = await insertJob(t, failedJob(mac, { settings: { preset: 'balanced', stemMode: 'four', model: 'htdemucs', shifts: 1, overlap: 0.25, format: 'opus', bitrate: 192 } }));
    await alice.mutation(api.jobs.retry, { jobId: legacy, preset: 'fast' });
    expect((await readJob(t, legacy))?.settings).toMatchObject({ preset: 'fast', stemMode: 'four', model: 'htdemucs', shifts: 0 });
  });

  test('preset refusals: unknown presets and detection jobs', async () => {
    const { t, alice, mac } = await setup();
    const jobId = await insertJob(t, failedJob(mac));
    expect(await errorOf(alice.mutation(api.jobs.retry, { jobId, preset: 'ultra' }))).toMatchObject({ code: 'invalid', field: 'preset' });
    const beats = await insertJob(t, failedJob(mac, { kind: 'beats', settings: { sections: true } }));
    expect(await errorOf(alice.mutation(api.jobs.retry, { jobId: beats, preset: 'fast' }))).toMatchObject({ code: 'invalid', field: 'preset' });
    expect((await readJob(t, jobId))?.status).toBe('error');
  });

  test('only failed jobs, only on the original computer', async () => {
    const { t, alice, bob, mac, pc } = await setup();
    const running = await insertJob(t, failedJob(mac, { status: 'running' }));
    expect(await codeOf(alice.mutation(api.jobs.retry, { jobId: running }))).toBe('job_not_failed');
    const jobId = await insertJob(t, failedJob(mac));
    expect(await errorOf(alice.mutation(api.jobs.retry, { jobId, deviceId: pc }))).toMatchObject({ code: 'retry_wrong_device', deviceName: 'Studio Mac' });
    await alice.mutation(api.jobs.retry, { jobId, deviceId: mac });
    const revoked = await insertJob(t, failedJob(pc));
    await t.run(ctx => ctx.db.patch('devices', pc, { revoked: true, revokedBy: 'user' }));
    expect(await codeOf(alice.mutation(api.jobs.retry, { jobId: revoked }))).toBe('retry_wrong_device');
    const deviceless = await insertJob(t, failedJob(mac, { deviceId: undefined }));
    expect(await codeOf(alice.mutation(api.jobs.retry, { jobId: deviceless }))).toBe('retry_wrong_device');
    expect(await codeOf(bob.mutation(api.jobs.retry, { jobId: revoked }))).toBe('not_found');
  });

  test('a failed detection is not re-queued beside a newer live one (one live detection per song)', async () => {
    const { t, alice, mac, songId } = await setup();
    const a = await alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: mac });
    await t.run(ctx => ctx.db.patch('jobs', a.jobId, { status: 'error', stage: 'error', errorCode: 'beats_unavailable' }));
    const b = await alice.mutation(api.jobs.createBeatDetection, { songId, deviceId: mac });
    expect(b.jobId).not.toBe(a.jobId);
    expect(await errorOf(alice.mutation(api.jobs.retry, { jobId: a.jobId }))).toMatchObject({ code: 'job_live', jobId: b.jobId });
    expect((await readJob(t, a.jobId))?.status).toBe('error');
    // Once the newer one is finished, the failed one can run again.
    await t.run(ctx => ctx.db.patch('jobs', b.jobId, { status: 'done', stage: 'done' }));
    await alice.mutation(api.jobs.retry, { jobId: a.jobId });
    expect((await readJob(t, a.jobId))?.status).toBe('queued');
  });
});

// ---- detections applied (D44) ---------------------------------------------------

describe('markApplied and latestDetection', () => {
  const beatsResult = { beats: [[0.5, 1], [1, 2], [1.5, 3], [2, 4]] };
  const doneBeats = (songId: Id<'songs'>, extra: Partial<JobInput> = {}) =>
    job('alice', { kind: 'beats', songId, status: 'done', stage: 'done', percent: 100, result: beatsResult, ...extra });

  test('latestDetection offers the newest done, user-started, unapplied detection once', async () => {
    const { t, alice, songId } = await setup();
    expect(await alice.query(api.jobs.latestDetection, { songId })).toBeNull();
    const user = await insertJob(t, doneBeats(songId, { createdAt: T0 + 1 }));
    const chain = await insertJob(t, doneBeats(songId, { createdAt: T0 + 2, chainedFrom: user }));
    await insertJob(t, job('alice', { kind: 'beats', songId, status: 'running', createdAt: T0 + 3 }));
    const offer = await alice.query(api.jobs.latestDetection, { songId });
    expect(offer).toMatchObject({ jobId: user, kind: 'beats', status: 'done', result: beatsResult, appliedAt: null });
    expect(Object.keys(offer!).sort()).toEqual(Object.keys(jobDetailValidator.fields).sort());
    expect(offer?.jobId).not.toBe(chain);
    await alice.mutation(api.jobs.markApplied, { jobId: user });
    expect(await alice.query(api.jobs.latestDetection, { songId })).toBeNull();
  });

  test('an older unapplied detection is never offered over a newer applied one', async () => {
    const { t, alice, songId } = await setup();
    await insertJob(t, doneBeats(songId));
    await insertJob(t, doneBeats(songId, { appliedAt: T0 + 10 }));
    expect(await alice.query(api.jobs.latestDetection, { songId })).toBeNull();
  });

  test('latestDetection is the owner’s only', async () => {
    const { t, alice, bob, songId } = await setup();
    await insertJob(t, doneBeats(songId));
    expect(await bob.query(api.jobs.latestDetection, { songId })).toBeNull();
    expect(await t.query(api.jobs.latestDetection, { songId })).toBeNull();
    expect(await alice.query(api.jobs.latestDetection, { songId })).not.toBeNull();
  });

  test('markApplied stamps a done beats job once, and refuses anything else', async () => {
    const { t, alice, bob, songId } = await setup();
    const jobId = await insertJob(t, doneBeats(songId));
    await alice.mutation(api.jobs.markApplied, { jobId });
    const first = (await readJob(t, jobId))?.appliedAt;
    expect(first).toEqual(expect.any(Number));
    await alice.mutation(api.jobs.markApplied, { jobId });
    expect((await readJob(t, jobId))?.appliedAt).toBe(first);
    const running = await insertJob(t, doneBeats(songId, { status: 'running' }));
    expect(await codeOf(alice.mutation(api.jobs.markApplied, { jobId: running }))).toBe('invalid');
    const separation = await insertJob(t, job('alice', { status: 'done' }));
    expect(await codeOf(alice.mutation(api.jobs.markApplied, { jobId: separation }))).toBe('invalid');
    expect(await codeOf(bob.mutation(api.jobs.markApplied, { jobId }))).toBe('not_found');
    // Applying a detection is personal map state, which export-only accounts keep (D10).
    await setAccount(t, 'alice', 'export_only');
    const another = await insertJob(t, doneBeats(songId));
    await expect(alice.mutation(api.jobs.markApplied, { jobId: another })).resolves.toBeNull();
  });
});

// ---- listUnappliedDetections (ticket I1b-1) ---------------------------------------

describe('listUnappliedDetections', () => {
  const beatsResult = { beats: [[0.5, 1], [1, 2], [1.5, 3], [2, 4]] };
  const doneBeats = (userId: string, songId: Id<'songs'>, extra: Partial<JobInput> = {}) =>
    job(userId, { kind: 'beats', songId, status: 'done', stage: 'done', percent: 100, result: beatsResult, ...extra });
  const songs = (t: T, n: number, userId = 'alice') =>
    t.run(async ctx => { const ids: Id<'songs'>[] = []; for (let i = 0; i < n; i++) ids.push(await ctx.db.insert('songs', song(userId, `Song ${i}`))); return ids; });
  const ids = (rows: { jobId: Id<'jobs'> }[]) => rows.map(r => r.jobId);

  test('lists the caller’s done, user-started, unapplied detections with their result, newest first', async () => {
    const { t, alice, songId } = await setup();
    expect(await alice.query(api.jobs.listUnappliedDetections, {})).toEqual([]);
    const [a, b] = await songs(t, 2);
    const older = await insertJob(t, doneBeats('alice', songId, { createdAt: T0 + 1 }));
    const middle = await insertJob(t, doneBeats('alice', a, { createdAt: T0 + 2 }));
    const newest = await insertJob(t, doneBeats('alice', b, { createdAt: T0 + 3 }));
    const rows = await alice.query(api.jobs.listUnappliedDetections, {});
    expect(ids(rows)).toEqual([newest, middle, older]);
    expect(rows[0]).toMatchObject({ kind: 'beats', status: 'done', songId: b, result: beatsResult, appliedAt: null, chainedFrom: null });
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(Object.keys(jobDetailValidator.fields).sort());
  });

  test('chained (B6) detections are excluded', async () => {
    const { t, alice, songId } = await setup();
    const separation = await insertJob(t, job('alice', { songId, status: 'done' }));
    await insertJob(t, doneBeats('alice', songId, { chainedFrom: separation }));
    expect(await alice.query(api.jobs.listUnappliedDetections, {})).toEqual([]);
    // A chained one never hides the song's user-started detection behind it.
    const user = await insertJob(t, doneBeats('alice', songId, { createdAt: T0 - 1 }));
    await insertJob(t, doneBeats('alice', songId, { chainedFrom: separation, createdAt: T0 + 1 }));
    expect(ids(await alice.query(api.jobs.listUnappliedDetections, {}))).toEqual([user]);
  });

  test('applied detections are excluded, and never uncover an older one of the same song', async () => {
    const { t, alice, songId } = await setup();
    const [other] = await songs(t, 1);
    await insertJob(t, doneBeats('alice', songId, { createdAt: T0 + 1 }));
    const applied = await insertJob(t, doneBeats('alice', songId, { createdAt: T0 + 2 }));
    const kept = await insertJob(t, doneBeats('alice', other, { createdAt: T0 + 3 }));
    expect(ids(await alice.query(api.jobs.listUnappliedDetections, {}))).toEqual([kept, applied]);
    await alice.mutation(api.jobs.markApplied, { jobId: applied });
    // As latestDetection: the song's newest detection was used, so its older one is not offered.
    expect(ids(await alice.query(api.jobs.listUnappliedDetections, {}))).toEqual([kept]);
    expect(await alice.query(api.jobs.latestDetection, { songId })).toBeNull();
  });

  test('detections without a result, other kinds and other statuses are excluded', async () => {
    const { t, alice, songId } = await setup();
    const [a, b, c] = await songs(t, 3);
    await insertJob(t, doneBeats('alice', songId, { result: undefined }));
    await insertJob(t, doneBeats('alice', a, { kind: 'sections', result: { sections: [] } }));
    await insertJob(t, job('alice', { songId: b, status: 'done', result: { anything: true } }));
    await insertJob(t, doneBeats('alice', c, { status: 'running' }));
    await insertJob(t, doneBeats('alice', c, { status: 'error' }));
    await insertJob(t, doneBeats('alice', c, { status: 'canceled' }));
    expect(await alice.query(api.jobs.listUnappliedDetections, {})).toEqual([]);
  });

  test('other users’ jobs are excluded; signed out lists nothing', async () => {
    const { t, alice, bob, songId, bobSong } = await setup();
    const mine = await insertJob(t, doneBeats('alice', songId));
    const theirs = await insertJob(t, doneBeats('bob', bobSong));
    // A job naming another account’s song is not listed either.
    await insertJob(t, doneBeats('alice', bobSong, { createdAt: T0 + 1 }));
    expect(ids(await alice.query(api.jobs.listUnappliedDetections, {}))).toEqual([mine]);
    expect(ids(await bob.query(api.jobs.listUnappliedDetections, {}))).toEqual([theirs]);
    expect(await t.query(api.jobs.listUnappliedDetections, {})).toEqual([]);
  });

  test('a deleted song’s detection is excluded', async () => {
    const { t, alice } = await setup();
    const [gone] = await songs(t, 1);
    await insertJob(t, doneBeats('alice', gone));
    await t.run(ctx => ctx.db.delete('songs', gone));
    expect(await alice.query(api.jobs.listUnappliedDetections, {})).toEqual([]);
  });

  test('returns at most 20, the newest', async () => {
    const { t, alice } = await setup();
    const many = await songs(t, UNAPPLIED_MAX + 5);
    const jobIds: Id<'jobs'>[] = [];
    for (const [i, id] of many.entries()) jobIds.push(await insertJob(t, doneBeats('alice', id, { createdAt: T0 + i })));
    const rows = await alice.query(api.jobs.listUnappliedDetections, {});
    expect(rows).toHaveLength(UNAPPLIED_MAX);
    expect(ids(rows)).toEqual(jobIds.slice(-UNAPPLIED_MAX).reverse());
  });

  test('scans only the newest 200 done jobs', async () => {
    const { t, alice, songId } = await setup();
    await insertJob(t, doneBeats('alice', songId, { createdAt: T0 }));
    await t.run(async ctx => {
      for (let i = 0; i < UNAPPLIED_SCAN; i++) await ctx.db.insert('jobs', job('alice', { status: 'done', createdAt: T0 + 1 + i }));
    });
    expect(await alice.query(api.jobs.listUnappliedDetections, {})).toEqual([]);
  });
});

// ---- get, cancel, dismiss ------------------------------------------------------

describe('get, cancel and dismiss', () => {
  test('get returns the owner’s job, with a result only for done detections', async () => {
    const { t, alice, bob, songId } = await setup();
    const running = await insertJob(t, job('alice', { kind: 'beats', songId, status: 'running', result: { beats: [] } }));
    const done = await insertJob(t, job('alice', { kind: 'sections', songId, status: 'done', result: { sections: [{ t0: 0, label: 'Intro', confidence: 0.8 }] } }));
    const separate = await insertJob(t, job('alice', { status: 'done', result: { anything: true } }));
    expect(await alice.query(api.jobs.get, { jobId: running })).toMatchObject({ status: 'running', result: null });
    expect(await alice.query(api.jobs.get, { jobId: done })).toMatchObject({ result: { sections: [{ t0: 0, label: 'Intro', confidence: 0.8 }] } });
    expect(await alice.query(api.jobs.get, { jobId: separate })).toMatchObject({ result: null });
    expect(await bob.query(api.jobs.get, { jobId: done })).toBeNull();
    expect(await t.query(api.jobs.get, { jobId: done })).toBeNull();
  });

  test('cancel stops live and failed jobs and is a no-op otherwise; export-only accounts may cancel', async () => {
    const { t, alice, bob } = await setup();
    const queued = await insertJob(t, job('alice'));
    const failed = await insertJob(t, job('alice', { status: 'error', retryAt: T0 + 1 }));
    const done = await insertJob(t, job('alice', { status: 'done' }));
    expect(await bob.mutation(api.jobs.cancel, { jobId: queued })).toBe(false);
    await setAccount(t, 'alice', 'export_only');
    expect(await alice.mutation(api.jobs.cancel, { jobId: queued })).toBe(true);
    expect(await alice.mutation(api.jobs.cancel, { jobId: failed })).toBe(true);
    expect((await readJob(t, failed))?.retryAt).toBeUndefined();
    expect(await alice.mutation(api.jobs.cancel, { jobId: done })).toBe(false);
    expect(await alice.mutation(api.jobs.cancel, { jobId: queued })).toBe(false);
    expect((await readJob(t, queued))?.status).toBe('canceled');
  });

  test('dismiss clears finished cards and refuses live ones with job_live', async () => {
    const { t, alice, bob } = await setup();
    const running = await insertJob(t, job('alice', { status: 'running' }));
    const failed = await insertJob(t, job('alice', { status: 'error' }));
    expect(await errorOf(alice.mutation(api.jobs.dismiss, { jobId: running }))).toMatchObject({ code: 'job_live', message: 'Cancel the job first.' });
    expect(await bob.mutation(api.jobs.dismiss, { jobId: failed })).toBe(false);
    expect(await alice.mutation(api.jobs.dismiss, { jobId: failed })).toBe(true);
    expect(await readJob(t, failed)).toBeNull();
    expect(await alice.mutation(api.jobs.dismiss, { jobId: failed })).toBe(false);
    expect(await codeOf(t.mutation(api.jobs.dismiss, { jobId: running }))).toBe('not_signed_in');
  });
});
