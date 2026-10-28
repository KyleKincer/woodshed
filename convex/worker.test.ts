/// <reference types="vite/client" />
// BK3: the companion's side of a job (architecture §6.6): next/claim order and
// shapes, progress with coded failures and the bot-check retry, finish (B4
// fields, D43, imports, the B6 chain), beatsDone/sectionsDone (D44, D47) and
// the presence heartbeat (D11).
import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { afterEach, describe, expect, test, vi } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { hashToken } from './devices';
import { BOT_CHECK_BACKOFF_MS, RESUME_MESSAGE } from './worker';
import { barsOf, defaultSongMap, hasRealMap, sectionsOf, songMapFromTempo, type SongMapData } from '../shared/song-map';
import { PRACTICE_CAP } from '../shared/practice';

const modules = import.meta.glob('./**/*.ts');
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const TOKEN = 'a'.repeat(64), OTHER_TOKEN = 'b'.repeat(64);
const quality = { model: 'htdemucs', shifts: 0, overlap: 0.25, format: 'opus' as const, bitrate: 192 };
const MIN = 60_000;

async function caught(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    return (error as ConvexError<any>).data as Record<string, unknown>;
  }
  throw new Error('expected a coded failure');
}

/** A real (edited) constant map at `bpm`, with section labels on the given bar indices. */
function madeMap(duration: number, bpm = 100, labels: Record<number, string> = {}): SongMapData {
  const data: SongMapData = { ...defaultSongMap(duration, bpm), origin: 'edited' };
  for (const [index, label] of Object.entries(labels)) data.measures[Number(index)].label = label;
  return data;
}

/** BeatNet's pairs: [time, beatInBar], 1 on a downbeat. */
function beatPairs(bpm: number, offset: number, duration: number, perBar = 4) {
  const out: number[][] = [];
  for (let t = offset, i = 0; t < duration - 0.2; t += 60 / bpm, i++) out.push([Number(t.toFixed(4)), (i % perBar) + 1]);
  return out;
}

async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity({ subject: 'alice' }), bob = t.withIdentity({ subject: 'bob' });
  const deviceId = await alice.mutation(api.devices.pair, { tokenHash: await hashToken(TOKEN), name: 'Studio Mac' });
  const otherId = await bob.mutation(api.devices.pair, { tokenHash: await hashToken(OTHER_TOKEN), name: 'Other' });
  let clock = 1_000;
  const job = (fields: Record<string, unknown> = {}) => t.run(ctx => {
    const now = clock++;
    return ctx.db.insert('jobs', {
      userId: 'alice', deviceId, kind: 'separate', label: 'Song', status: 'queued', stage: 'queued', percent: 0,
      attempts: 0, createdAt: now, updatedAt: now, ...fields,
    } as never) as Promise<Id<'jobs'>>;
  });
  const song = (fields: Record<string, unknown> = {}) => t.run(ctx => ctx.db.insert('songs', {
    userId: 'alice', title: 'Harbor Lights', duration: 200, stems: [], stemMode: 'full', quality, addedAt: 1, ...fields,
  } as never) as Promise<Id<'songs'>>);
  const getJob = (id: Id<'jobs'>) => t.run(ctx => ctx.db.get('jobs', id));
  const getSong = (id: Id<'songs'>) => t.run(ctx => ctx.db.get('songs', id));
  const settings = (value: unknown) => t.run(ctx => ctx.db.insert('userSettings', { userId: 'alice', settings: value }));
  return { t, alice, bob, deviceId, otherId, job, song, getJob, getSong, settings };
}

/** Reserves one stem and finishes the (claimed) job, as blobs.complete does after the upload. */
async function finishJob(s: Awaited<ReturnType<typeof setup>>, jobId: Id<'jobs'>, result: Record<string, unknown> = {}) {
  await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
  const [row] = await s.t.mutation(internal.storage.reserve, { token: TOKEN, jobId, files: [{ name: 'drums.webm', bytes: 100, mime: 'audio/webm', checksum: 'a'.repeat(43) + '=' }] });
  return await s.t.mutation(internal.worker.finish, {
    token: TOKEN, jobId,
    result: { title: 'Harbor Lights', duration: 200, stemMode: 'full', quality, stems: [{ name: 'drums', key: row.key }], ...result } as never,
  });
}

describe('worker.next (B6 order, D12)', () => {
  test('a running job first; then the first queued beats job, then sections, then the oldest queued job', async () => {
    const s = await setup();
    expect(await s.t.query(api.worker.next, { token: TOKEN })).toBeNull();
    const separate = await s.job({ label: 'first' });
    await s.job({ label: 'second' });
    expect((await s.t.query(api.worker.next, { token: TOKEN }))._id).toBe(separate);
    const sections = await s.job({ kind: 'sections' });
    expect((await s.t.query(api.worker.next, { token: TOKEN }))._id).toBe(sections);
    const beats = await s.job({ kind: 'beats' });
    await s.job({ kind: 'beats', label: 'later beats' });
    expect((await s.t.query(api.worker.next, { token: TOKEN }))._id).toBe(beats);
    const running = await s.job({ status: 'running', stage: 'separate' });
    expect((await s.t.query(api.worker.next, { token: TOKEN }))._id).toBe(running);
  });

  test("another device's and another account's jobs are never offered", async () => {
    const s = await setup();
    await s.t.run(ctx => ctx.db.insert('jobs', { userId: 'bob', deviceId: s.otherId, kind: 'beats', label: 'x', status: 'queued', stage: 'queued', percent: 0, createdAt: 1, updatedAt: 1 }));
    expect(await s.t.query(api.worker.next, { token: TOKEN })).toBeNull();
    expect(await s.t.query(api.worker.next, { token: OTHER_TOKEN })).not.toBeNull();
  });
});

describe('worker.claim', () => {
  test('sets startedAt on the first claim only and counts every dispatch', async () => {
    const s = await setup();
    const jobId = await s.job();
    const first = await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
    expect(first).toMatchObject({ status: 'running', attempts: 1, chainedFrom: null });
    const startedAt = (await s.getJob(jobId))!.startedAt!;
    expect(startedAt).toBeGreaterThan(0);
    // A restarted companion resumes its running job: a second dispatch, the same start.
    const again = await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
    expect(again.attempts).toBe(2);
    expect((await s.getJob(jobId))).toMatchObject({ attempts: 2, startedAt, status: 'running' });
  });

  test('`six` reaches Python as `full` on the 6-stem model; the stored settings keep `six`', async () => {
    const s = await setup();
    const jobId = await s.job({ settings: { preset: 'fast', stemMode: 'six', bitrate: 160 } });
    const claimed = await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
    expect(claimed.settings).toMatchObject({ preset: 'fast', stemMode: 'full' });
    expect(claimed.quality).toMatchObject({ model: 'htdemucs_6s', shifts: 0, overlap: 0.25, bitrate: 160 });
    expect((await s.getJob(jobId))!.settings.stemMode).toBe('six');
    const plain = await s.t.mutation(api.worker.claim, { token: TOKEN, jobId: await s.job({ settings: { preset: 'fast', stemMode: 'drums' } }) });
    expect(plain.settings.stemMode).toBe('drums');
    expect(plain.quality.model).toBe('htdemucs');
  });

  test('a chained beats job returns chainedFrom', async () => {
    const s = await setup();
    const parent = await s.job({ status: 'done', stage: 'done' });
    const claimed: any = await s.t.mutation(api.worker.claim, { token: TOKEN, jobId: await s.job({ kind: 'beats', chainedFrom: parent, settings: { sections: true } }) });
    expect(claimed).toMatchObject({ kind: 'beats', chainedFrom: parent, settings: { sections: true } });
    expect(claimed.downbeats).toBeUndefined();
  });

  test('a sections job returns the bar starts of the current map; an unmapped song returns none', async () => {
    const s = await setup();
    const map = madeMap(30, 100);
    const songId = await s.song({ duration: 30, tempo: { songMap: map } });
    const claimed: any = await s.t.mutation(api.worker.claim, { token: TOKEN, jobId: await s.job({ kind: 'sections', songId }) });
    const expected = barsOf(map, 30).map(b => b.t0);
    expect(claimed.downbeats).toEqual(expected);
    expect(expected.slice(0, 3)).toEqual([0, 2.4, 4.8].map(n => expect.closeTo(n, 9)));
    expect(claimed.song._id).toBe(songId);
    const bare = await s.song({ duration: 30 });
    const unmapped: any = await s.t.mutation(api.worker.claim, { token: TOKEN, jobId: await s.job({ kind: 'sections', songId: bare }) });
    expect(unmapped.downbeats).toEqual([]);
  });

  test('finished jobs and other devices are refused with coded errors', async () => {
    const s = await setup();
    const done = await s.job({ status: 'done', stage: 'done' });
    expect(await caught(s.t.mutation(api.worker.claim, { token: TOKEN, jobId: done }))).toMatchObject({ code: 'not_found', message: 'Job unavailable.' });
    const mine = await s.job();
    expect((await caught(s.t.mutation(api.worker.claim, { token: OTHER_TOKEN, jobId: mine }))).code).toBe('not_found');
  });
});

describe('worker.progress', () => {
  test('stage, percent and message update a running job; meta is merged and cleaned (B4)', async () => {
    const s = await setup();
    const jobId = await s.job({ meta: { title: 'Old', coverKey: 'covers/x.png' } });
    await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
    expect(await s.t.mutation(api.worker.progress, {
      token: TOKEN, jobId, stage: 'download', percent: 140, message: 'Downloading audio…',
      meta: { title: `  ${'T'.repeat(400)}  `, channel: 'Ada Moreno', duration: 204, thumbnail: 'http://i.ytimg.com/x.jpg', provider: 'Youtube' },
    })).toBe(true);
    const row = (await s.getJob(jobId))!;
    expect(row).toMatchObject({ status: 'running', stage: 'download', percent: 100, message: 'Downloading audio…' });
    expect(row.meta).toEqual({ title: 'T'.repeat(300), coverKey: 'covers/x.png', channel: 'Ada Moreno', duration: 204, provider: 'Youtube' });
    await s.t.mutation(api.worker.progress, { token: TOKEN, jobId, stage: 'download', percent: 20, meta: { thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg' } });
    expect((await s.getJob(jobId))!.meta.thumbnail).toBe('https://i.ytimg.com/vi/x/hq.jpg');
    expect((await s.getJob(jobId))!.meta.channel).toBe('Ada Moreno');
  });

  test('a classified failure stores its errorCode; an unknown code becomes `unknown`', async () => {
    const s = await setup();
    const jobId = await s.job();
    await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
    await s.t.mutation(api.worker.progress, { token: TOKEN, jobId, stage: 'error', percent: 0, error: 'separator exited with code 1', errorCode: 'separation_failed' });
    expect(await s.getJob(jobId)).toMatchObject({ status: 'error', errorCode: 'separation_failed', error: 'separator exited with code 1' });
    expect((await s.getJob(jobId))!.retryAt).toBeUndefined();
    const other = await s.job();
    await s.t.mutation(api.worker.claim, { token: TOKEN, jobId: other });
    await s.t.mutation(api.worker.progress, { token: TOKEN, jobId: other, stage: 'error', percent: 0, error: 'odd', errorCode: 'gremlins' });
    expect((await s.getJob(other))!.errorCode).toBe('unknown');
    // A plain failure (the 1.9 companion sends no code) has none.
    const plain = await s.job();
    await s.t.mutation(api.worker.claim, { token: TOKEN, jobId: plain });
    await s.t.mutation(api.worker.progress, { token: TOKEN, jobId: plain, stage: 'error', percent: 0, error: 'boom' });
    expect(await s.getJob(plain)).toMatchObject({ status: 'error', stage: 'error' });
    expect((await s.getJob(plain))!.errorCode).toBeUndefined();
  });

  test('a bot check re-queues itself with backoff 5 min × 2^(attempts − 1), at most until the third attempt', async () => {
    const s = await setup();
    const jobId = await s.job({ source: { type: 'url', value: 'https://www.youtube.com/watch?v=x' } });
    const scheduled = () => s.t.run(ctx => ctx.db.system.query('_scheduled_functions').collect());
    for (const [attempt, backoff] of [[1, 5 * MIN], [2, 10 * MIN]] as const) {
      await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
      await s.t.mutation(api.worker.progress, { token: TOKEN, jobId, stage: 'error', percent: 0, error: 'Sign in to confirm you’re not a bot', errorCode: 'bot_check' });
      const row = (await s.getJob(jobId))!;
      expect(row).toMatchObject({ status: 'error', errorCode: 'bot_check', attempts: attempt });
      expect(row.retryAt! - row.updatedAt).toBe(backoff);
      expect(BOT_CHECK_BACKOFF_MS * 2 ** (attempt - 1)).toBe(backoff);
      const retries = (await scheduled()).filter(f => f.name.includes('autoRetry'));
      expect(retries).toHaveLength(attempt);
      expect(retries[attempt - 1]).toMatchObject({ args: [{ jobId, attempts: attempt }], scheduledTime: row.retryAt });
      expect(await s.t.mutation(internal.worker.autoRetry, { jobId, attempts: attempt })).toBe(true);
      expect(await s.getJob(jobId)).toMatchObject({ status: 'queued', stage: 'queued', percent: 0, message: RESUME_MESSAGE });
      const reset = (await s.getJob(jobId))!;
      expect([reset.errorCode, reset.retryAt, reset.error]).toEqual([undefined, undefined, undefined]);
    }
    // The third dispatch fails for good: no retry time and nothing scheduled.
    await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
    await s.t.mutation(api.worker.progress, { token: TOKEN, jobId, stage: 'error', percent: 0, error: 'bot again', errorCode: 'bot_check' });
    expect(await s.getJob(jobId)).toMatchObject({ status: 'error', errorCode: 'bot_check', attempts: 3 });
    expect((await s.getJob(jobId))!.retryAt).toBeUndefined();
    expect((await scheduled()).filter(f => f.name.includes('autoRetry'))).toHaveLength(2);
  });

  test('autoRetry is a no-op once anything happened to the job', async () => {
    const s = await setup();
    const fail = async () => {
      const jobId = await s.job();
      await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
      await s.t.mutation(api.worker.progress, { token: TOKEN, jobId, stage: 'error', percent: 0, error: 'bot', errorCode: 'bot_check' });
      return jobId;
    };
    const retried = await fail();
    await s.t.run(ctx => ctx.db.patch('jobs', retried, { status: 'queued', stage: 'queued' })); // the user pressed Retry
    expect(await s.t.mutation(internal.worker.autoRetry, { jobId: retried, attempts: 1 })).toBe(false);
    const redispatched = await fail();
    await s.t.run(ctx => ctx.db.patch('jobs', redispatched, { attempts: 2 }));
    expect(await s.t.mutation(internal.worker.autoRetry, { jobId: redispatched, attempts: 1 })).toBe(false);
    expect((await s.getJob(redispatched))!.status).toBe('error');
    const dismissed = await fail();
    await s.t.run(ctx => ctx.db.delete('jobs', dismissed));
    expect(await s.t.mutation(internal.worker.autoRetry, { jobId: dismissed, attempts: 1 })).toBe(false);
  });

  test('autoRetry leaves the job failed (no retry time) when its computer was revoked or the account paused during the backoff', async () => {
    const s = await setup();
    const botChecked = async () => {
      const jobId = await s.job();
      await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
      await s.t.mutation(api.worker.progress, { token: TOKEN, jobId, stage: 'error', percent: 0, error: 'bot', errorCode: 'bot_check' });
      expect((await s.getJob(jobId))!.retryAt).toBeTypeOf('number');
      return jobId;
    };
    const paused = await botChecked();
    await s.t.run(ctx => ctx.db.insert('accountControls', { userId: 'alice', status: 'export_only', notes: '' }));
    expect(await s.t.mutation(internal.worker.autoRetry, { jobId: paused, attempts: 1 })).toBe(false);
    expect(await s.getJob(paused)).toMatchObject({ status: 'error', errorCode: 'bot_check' });
    expect((await s.getJob(paused))!.retryAt).toBeUndefined();
    await s.t.run(async ctx => { for (const row of await ctx.db.query('accountControls').collect()) await ctx.db.delete('accountControls', row._id); });

    const revoked = await botChecked();
    await s.alice.mutation(api.devices.revoke, { deviceId: s.deviceId });
    expect(await s.t.mutation(internal.worker.autoRetry, { jobId: revoked, attempts: 1 })).toBe(false);
    const row = (await s.getJob(revoked))!;
    expect(row).toMatchObject({ status: 'error', errorCode: 'bot_check', attempts: 1 });
    expect(row.retryAt).toBeUndefined();
  });

  test('progress on a canceled job returns false and changes nothing', async () => {
    const s = await setup();
    const jobId = await s.job({ status: 'canceled' });
    expect(await s.t.mutation(api.worker.progress, { token: TOKEN, jobId, stage: 'separate', percent: 50 })).toBe(false);
    expect((await s.getJob(jobId))!.stage).toBe('queued');
  });
});

describe('worker.finish', () => {
  test('a new song stores resolvedUrl, provider and its origin device (B4, D38)', async () => {
    const s = await setup();
    const jobId = await s.job({ source: { type: 'url', value: 'https://youtu.be/x' }, confirmed: true });
    const songId = await finishJob(s, jobId, { resolvedUrl: 'https://www.youtube.com/watch?v=x', provider: 'Youtube' });
    const row = (await s.getSong(songId))!;
    expect(row).toMatchObject({ resolvedUrl: 'https://www.youtube.com/watch?v=x', provider: 'Youtube', originDeviceId: s.deviceId, mapSummary: { real: false, sections: [] } });
    expect(row.recordingUnconfirmed).toBeUndefined();
    expect(await s.getJob(jobId)).toMatchObject({ status: 'done', stage: 'done', songId, percent: 100 });
    // A malformed resolved URL is dropped rather than stored.
    const other = await finishJob(s, await s.job({ source: { type: 'url', value: 'https://youtu.be/y' } }), { resolvedUrl: 'javascript:alert(1)' });
    expect((await s.getSong(other))!.resolvedUrl).toBeUndefined();
  });

  test('recordingUnconfirmed is set only for searches the user did not confirm (D43)', async () => {
    const s = await setup();
    const search = { type: 'search', value: 'harbor lights ada moreno' };
    const unconfirmed = await finishJob(s, await s.job({ source: search, meta: { title: 'Harbor Lights (Official Audio)' } }));
    expect((await s.getSong(unconfirmed))!.recordingUnconfirmed).toBe(true);
    const explicitFalse = await finishJob(s, await s.job({ source: search, confirmed: false }));
    expect((await s.getSong(explicitFalse))!.recordingUnconfirmed).toBe(true);
    const confirmed = await finishJob(s, await s.job({ source: search, confirmed: true }));
    expect((await s.getSong(confirmed))!.recordingUnconfirmed).toBeUndefined();
    const url = await finishJob(s, await s.job({ source: { type: 'url', value: 'https://youtu.be/x' } }));
    expect((await s.getSong(url))!.recordingUnconfirmed).toBeUndefined();
  });

  test('a re-split keeps the song identity, origin device and review flag', async () => {
    const s = await setup();
    const songId = await s.song({ title: 'Mine', recordingUnconfirmed: true, resolvedUrl: 'https://www.youtube.com/watch?v=old', provider: 'Youtube' });
    const jobId = await s.job({ songId, source: { type: 'search', value: 'x' } });
    expect(await finishJob(s, jobId, { title: 'Theirs', stemMode: 'full' })).toBe(songId);
    const row = (await s.getSong(songId))!;
    expect(row).toMatchObject({ title: 'Mine', recordingUnconfirmed: true, resolvedUrl: 'https://www.youtube.com/watch?v=old', provider: 'Youtube' });
    expect(row.originDeviceId).toBeUndefined();
  });

  test('a `six` split stores stemMode six', async () => {
    const s = await setup();
    const songId = await finishJob(s, await s.job({ settings: { stemMode: 'six' } }), { stemMode: 'full' });
    expect((await s.getSong(songId))!.stemMode).toBe('six');
  });

  describe('B6 chain (account settings, not job.settings)', () => {
    const chained = async (s: Awaited<ReturnType<typeof setup>>, parent: Id<'jobs'>) =>
      (await s.t.run(ctx => ctx.db.query('jobs').collect())).filter(j => j.chainedFrom === parent);

    test('chains a beats job when the account says so, though job.settings lacks the keys', async () => {
      const s = await setup();
      await s.settings({ preset: 'balanced', autoBeats: true, autoSections: true });
      const jobId = await s.job({ settings: { preset: 'fast', stemMode: 'full' } });
      const songId = await finishJob(s, jobId);
      const [beats] = await chained(s, jobId);
      expect(beats).toMatchObject({
        kind: 'beats', userId: 'alice', deviceId: s.deviceId, songId, label: 'Finding bars — Harbor Lights',
        chainedFrom: jobId, settings: { sections: true }, status: 'queued', stage: 'queued', percent: 0,
      });
      expect((await s.t.query(api.worker.next, { token: TOKEN }))._id).toBe(beats._id);
    });

    test('defaults chain with sections when the account stored nothing', async () => {
      const s = await setup();
      const jobId = await s.job();
      await finishJob(s, jobId);
      expect((await chained(s, jobId)).map(j => j.settings)).toEqual([{ sections: true }]);
    });

    test('autoSections false still chains bars, without sections', async () => {
      const s = await setup();
      await s.settings({ autoBeats: true, autoSections: false });
      const jobId = await s.job({ settings: { autoSections: true } });
      await finishJob(s, jobId);
      expect((await chained(s, jobId)).map(j => j.settings)).toEqual([{ sections: false }]);
    });

    test('does not chain when the account says no, even if job.settings says yes', async () => {
      const s = await setup();
      await s.settings({ autoBeats: false });
      const jobId = await s.job({ settings: { autoBeats: true } });
      await finishJob(s, jobId);
      expect(await chained(s, jobId)).toEqual([]);
    });

    test('does not chain for a mapped song, a song with a chart, an import, or when bars are already queued', async () => {
      const s = await setup();
      const mapped = await s.song({ tempo: { songMap: madeMap(200) } });
      const resplit = await s.job({ songId: mapped, source: { type: 'url', value: 'https://youtu.be/x' } });
      await finishJob(s, resplit);
      expect(await chained(s, resplit)).toEqual([]);
      const charted = await s.song({ hasChart: true });
      const chartJob = await s.job({ songId: charted, source: { type: 'url', value: 'https://youtu.be/y' } });
      await finishJob(s, chartJob);
      expect(await chained(s, chartJob)).toEqual([]);
      const imported = await s.job({ kind: 'import', importMeta: { id: 'legacy-1', tempo: null, practice: null } });
      await finishJob(s, imported);
      expect(await chained(s, imported)).toEqual([]);
      const pendingSong = await s.song();
      await s.job({ kind: 'beats', songId: pendingSong });
      const dupe = await s.job({ songId: pendingSong, source: { type: 'url', value: 'https://youtu.be/z' } });
      await finishJob(s, dupe);
      expect(await chained(s, dupe)).toEqual([]);
    });
  });

  test('an import writes songPractice (upgraded, capped) and the summaries, never songs.practice (B1, B2, D51)', async () => {
    const s = await setup();
    const tempo = { songMap: madeMap(200, 100, { 0: 'Intro', 4: 'Verse' }), countIn: true, countInLength: 2, countInUnit: 'bars', enabled: true, accent: false, volume: 0.5 };
    const practice = { rate: 0.75, loop: { enabled: true, a: 9.6, b: 19.2 }, tracks: [], markers: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, t: i, label: 'x'.repeat(2000), updatedAt: i })) };
    const { jobId } = await s.t.mutation(api.worker.importSong, { token: TOKEN, legacyId: 'legacy-7', title: 'Old Friends', tempo, practice });
    const stored = (await s.getJob(jobId!))!.importMeta;
    expect(JSON.stringify(stored.practice).length).toBeLessThanOrEqual(PRACTICE_CAP);
    expect(stored.practice.v).toBe(2);
    const songId = await finishJob(s, jobId!, { title: 'Old Friends' });
    const song = (await s.getSong(songId))!;
    expect(song.practice).toBeUndefined();
    expect(song).toMatchObject({ localImportId: 'legacy-7', tempo, originDeviceId: s.deviceId });
    // A 1.9 blob has no practice history.
    expect(song.lastPracticedAt).toBeUndefined();
    expect(song.mapSummary).toEqual({ real: true, bpm: 100, meter: '4/4', sections: ['Intro', 'Verse'] });
    expect(song.practiceSummary).toMatchObject({ rate: 0.75, minusMe: false, spotCount: 0, loopLabel: 'Bars 5–8 loop' });
    const rows = await s.t.run(ctx => ctx.db.query('songPractice').withIndex('by_songId', q => q.eq('songId', songId)).collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: 'alice', practice: { v: 2, rate: 0.75, loop: { on: true, a: 9.6, b: 19.2 } } });
    // The 1.9 click settings moved into practice (D51).
    expect(rows[0].practice.click).toMatchObject({ countIn: { on: true, length: 2, unit: 'bars' }, mode: 'always', accent: false, volume: 0.5 });
    expect(JSON.stringify(rows[0].practice).length).toBeLessThanOrEqual(PRACTICE_CAP);
    // Metadata lookup does not run for imports.
    expect(song.metadataStatus).toBeUndefined();
  });

  test('an unmapped import labels its loop in time, never in bars', async () => {
    const s = await setup();
    const practice = { v: 2, lastAt: 1_700_000_000_000, cue: 0, rate: 1, loop: { on: true, a: 65, b: 80 }, tracks: [], minusMe: false, trainer: null, spots: [], markers: [] };
    const { jobId } = await s.t.mutation(api.worker.importSong, { token: TOKEN, legacyId: 'legacy-8', title: 'Loose', practice });
    const songId = await finishJob(s, jobId!);
    expect((await s.getSong(songId))!.practiceSummary).toMatchObject({ loopLabel: '1:05–1:20 loop' });
    expect((await s.getSong(songId))!.lastPracticedAt).toBe(1_700_000_000_000);
    expect((await s.getSong(songId))!.mapSummary).toEqual({ real: false, sections: [] });
  });

  test('importSong refuses an oversized tempo and a full queue with coded errors', async () => {
    const s = await setup();
    expect((await caught(s.t.mutation(api.worker.importSong, { token: TOKEN, legacyId: 'big', title: 'Big', tempo: { pad: 'x'.repeat(900_000) } }))).code).toBe('invalid');
    for (let i = 0; i < 20; i++) await s.job();
    expect(await caught(s.t.mutation(api.worker.importSong, { token: TOKEN, legacyId: 'late', title: 'Late' }))).toMatchObject({ code: 'queue_full' });
  });

  test('finish failures carry codes and keep their messages', async () => {
    const s = await setup();
    const jobId = await s.job();
    await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
    const result = { title: 'x', duration: 10, stemMode: 'full', quality, stems: [{ name: 'drums', key: 'missing' }] };
    expect(await caught(s.t.mutation(internal.worker.finish, { token: TOKEN, jobId, result }))).toMatchObject({ code: 'invalid', message: 'Invalid upload manifest.' });
    expect((await caught(s.t.mutation(internal.worker.finish, { token: OTHER_TOKEN, jobId, result }))).code).toBe('not_found');
  });
});

describe('worker.beatsDone (D44, D47)', () => {
  const run = async (s: Awaited<ReturnType<typeof setup>>, fields: Record<string, unknown>) => {
    const jobId = await s.job({ kind: 'beats', ...fields });
    await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
    return jobId;
  };

  for (const chained of [false, true]) {
    test(`writes a detected map only when the song is unmapped (${chained ? 'chained' : 'user-started'})`, async () => {
      const s = await setup();
      const parent = chained ? await s.job({ status: 'done', stage: 'done' }) : undefined;
      const legacy = { countIn: true, accent: true, source: 'detected', detected: [{ time: 0, downbeat: true }], map: [] };
      const songId = await s.song({ duration: 60, tempo: legacy, tempoRev: 4, tempoSaveId: 'save-9' });
      const jobId = await run(s, { songId, ...(parent ? { chainedFrom: parent } : {}) });
      const beats = beatPairs(120, 0.5, 60);
      await s.t.mutation(api.worker.beatsDone, { token: TOKEN, jobId, beats });
      const job = (await s.getJob(jobId))!;
      expect(job).toMatchObject({ status: 'done', stage: 'done', percent: 100, result: { beats, sections: [] } });
      // D44: the server applied it, so jobs.latestDetection (done, user-started,
      // result, no appliedAt) never offers it to the client again.
      expect(job.appliedAt).toBe(job.updatedAt);
      const song = (await s.getSong(songId))!;
      expect(song.tempoRev).toBe(5);
      expect(song.tempoSaveId).toBeUndefined();
      // Non-map fields stay for upgradePractice to read once; the 1.9 map copies go.
      expect(song.tempo).toMatchObject({ countIn: true, accent: true });
      expect(Object.keys(song.tempo).sort()).toEqual(['accent', 'countIn', 'songMap']);
      expect(song.tempo.songMap.origin).toBe('detected');
      expect(hasRealMap(song.tempo)).toBe(true);
      expect(song.mapSummary).toMatchObject({ real: true, bpm: 120, meter: '4/4', sections: [] });
      const bars = barsOf(songMapFromTempo(song.tempo, 60), 60);
      expect(bars[0].pickup).toBe(false);
      expect(bars[1].t0).toBeCloseTo(0.5 + 2, 6);
    });
  }

  test('a mapped song keeps its tempo; only the result is stored (the session applies it)', async () => {
    const s = await setup();
    const tempo = { songMap: madeMap(60, 90) };
    const songId = await s.song({ duration: 60, tempo, tempoRev: 2, tempoSaveId: 'mine' });
    const jobId = await run(s, { songId });
    const beats = beatPairs(120, 0, 60);
    await s.t.mutation(api.worker.beatsDone, { token: TOKEN, jobId, beats });
    expect((await s.getJob(jobId))!.result.beats).toEqual(beats);
    expect((await s.getJob(jobId))!.appliedAt).toBeUndefined(); // the session's to apply (latestDetection offers it)
    expect(await s.getSong(songId)).toMatchObject({ tempo, tempoRev: 2, tempoSaveId: 'mine' });
  });

  test('a song with a chart counts as mapped', async () => {
    const s = await setup();
    const songId = await s.song({ duration: 60, hasChart: true });
    await s.t.mutation(api.worker.beatsDone, { token: TOKEN, jobId: await run(s, { songId }), beats: beatPairs(120, 0, 60) });
    expect((await s.getSong(songId))!.tempo).toBeUndefined();
  });

  test('stores sectionSuggestion when the new map has no sections, cleaned and sorted', async () => {
    const s = await setup();
    const songId = await s.song({ duration: 60 });
    const jobId = await run(s, { songId, settings: { sections: true } });
    await s.t.mutation(api.worker.beatsDone, {
      token: TOKEN, jobId, beats: beatPairs(120, 0, 60),
      sections: [{ t0: 32, label: ' Chorus ', confidence: 1.4 }, { t0: 0, label: 'Intro', confidence: 0.9 }, { t0: 75, label: 'Past the end', confidence: 1 }, { t0: 16, label: '', confidence: -1 }],
    });
    const song = (await s.getSong(songId))!;
    expect(song.sectionSuggestion).toMatchObject({ jobId, sections: [
      { t0: 0, label: 'Intro', confidence: 0.9 }, { t0: 16, label: 'Section', confidence: 0 }, { t0: 32, label: 'Chorus', confidence: 1 },
    ] });
    expect(song.sectionSuggestion!.createdAt).toBeGreaterThan(0);
    expect((await s.getJob(jobId))!.result.sections).toHaveLength(3);
  });

  test('keeps the map and skips the suggestion when the existing map already has sections', async () => {
    const s = await setup();
    const songId = await s.song({ duration: 60, tempo: { songMap: madeMap(60, 100, { 0: 'Intro', 4: 'Verse' }) } });
    const jobId = await run(s, { songId });
    await s.t.mutation(api.worker.beatsDone, { token: TOKEN, jobId, beats: beatPairs(120, 0, 60), sections: [{ t0: 0, label: 'A', confidence: 1 }] });
    expect((await s.getSong(songId))!.sectionSuggestion).toBeUndefined();
    // A mapped song without sections gets the suggestion, and keeps its map.
    const plain = await s.song({ duration: 60, tempo: { songMap: madeMap(60, 100) } });
    await s.t.mutation(api.worker.beatsDone, { token: TOKEN, jobId: await run(s, { songId: plain }), beats: beatPairs(120, 0, 60), sections: [{ t0: 4.8, label: 'A', confidence: 0.5 }] });
    expect((await s.getSong(plain))!.sectionSuggestion!.sections).toEqual([{ t0: 4.8, label: 'A', confidence: 0.5 }]);
    expect(sectionsOf(songMapFromTempo((await s.getSong(plain))!.tempo, 60), 60)).toEqual([]);
  });

  test('too few beats leave the song unmapped; a repeated report is a no-op; bad input is refused', async () => {
    const s = await setup();
    const songId = await s.song({ duration: 60 });
    const jobId = await run(s, { songId });
    await s.t.mutation(api.worker.beatsDone, { token: TOKEN, jobId, beats: [[1, 1]] });
    expect((await s.getSong(songId))!.tempo).toBeUndefined();
    await s.t.mutation(api.worker.beatsDone, { token: TOKEN, jobId, beats: beatPairs(120, 0, 60) });
    expect((await s.getJob(jobId))!.result.beats).toEqual([[1, 1]]);
    expect((await caught(s.t.mutation(api.worker.beatsDone, { token: TOKEN, jobId: await run(s, { songId }), beats: [[1, 2, 3]] }))).code).toBe('invalid');
    const separate = await s.job({ status: 'running' });
    expect((await caught(s.t.mutation(api.worker.beatsDone, { token: TOKEN, jobId: separate, beats: [] }))).code).toBe('not_found');
  });
});

describe('worker.sectionsDone (B7)', () => {
  test('finishes the job and suggests sections for a mapped song without any', async () => {
    const s = await setup();
    const songId = await s.song({ duration: 60, tempo: { songMap: madeMap(60, 100) } });
    const jobId = await s.job({ kind: 'sections', songId });
    await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
    await s.t.mutation(api.worker.sectionsDone, { token: TOKEN, jobId, sections: [{ t0: 0, label: 'Intro', confidence: 0.8 }, { t0: 19.2, label: 'Verse', confidence: 0.7 }] });
    expect(await s.getJob(jobId)).toMatchObject({ status: 'done', stage: 'done', percent: 100, result: { sections: [{ t0: 0, label: 'Intro', confidence: 0.8 }, { t0: 19.2, label: 'Verse', confidence: 0.7 }] } });
    expect((await s.getSong(songId))!.sectionSuggestion).toMatchObject({ jobId, sections: [{ label: 'Intro' }, { label: 'Verse' }] });
    expect(await s.t.mutation(api.worker.sectionsDone, { token: TOKEN, jobId, sections: [] })).toBeNull();
  });

  test('no suggestion once the map has sections; other kinds are refused', async () => {
    const s = await setup();
    const songId = await s.song({ duration: 60, tempo: { songMap: madeMap(60, 100, { 0: 'Intro' }) } });
    const jobId = await s.job({ kind: 'sections', songId });
    await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
    await s.t.mutation(api.worker.sectionsDone, { token: TOKEN, jobId, sections: [{ t0: 0, label: 'A', confidence: 1 }] });
    expect((await s.getSong(songId))!.sectionSuggestion).toBeUndefined();
    const beats = await s.job({ kind: 'beats', status: 'running', songId });
    expect((await caught(s.t.mutation(api.worker.sectionsDone, { token: TOKEN, jobId: beats, sections: [] }))).code).toBe('not_found');
  });
});

describe('worker.heartbeat (D11)', () => {
  test('upserts one presence row per device and refreshes lastSeenAt', async () => {
    const s = await setup();
    const jobId = await s.job({ status: 'running' });
    await s.t.mutation(api.worker.heartbeat, { token: TOKEN, state: 'busy', currentJobId: jobId, appVersion: '2.0.0', platform: 'darwin-arm64', accelerator: 'Apple GPU' });
    const rows = () => s.t.run(ctx => ctx.db.query('devicePresence').withIndex('by_deviceId', q => q.eq('deviceId', s.deviceId)).collect());
    const [first] = await rows();
    expect(first).toMatchObject({ deviceId: s.deviceId, userId: 'alice', state: 'busy', currentJobId: jobId, appVersion: '2.0.0', platform: 'darwin-arm64', accelerator: 'Apple GPU' });
    await new Promise(resolve => setTimeout(resolve, 5));
    await s.t.mutation(api.worker.heartbeat, { token: TOKEN, state: 'idle', appVersion: '2.0.1' });
    const after = await rows();
    expect(after).toHaveLength(1);
    // Upsert: a beat that leaves the descriptive fields out keeps the stored ones.
    expect(after[0]).toMatchObject({ state: 'idle', appVersion: '2.0.1', platform: 'darwin-arm64', accelerator: 'Apple GPU' });
    expect(after[0].currentJobId).toBeUndefined();
    expect(after[0].lastSeenAt).toBeGreaterThan(first.lastSeenAt);
  });

  test("another device's job is never reported as current; revoked devices cannot beat", async () => {
    const s = await setup();
    const foreign = await s.t.run(ctx => ctx.db.insert('jobs', { userId: 'bob', deviceId: s.otherId, kind: 'separate', label: 'x', status: 'running', stage: 'separate', percent: 0, createdAt: 1, updatedAt: 1 }));
    await s.t.mutation(api.worker.heartbeat, { token: TOKEN, state: 'busy', currentJobId: foreign });
    const [row] = await s.t.run(ctx => ctx.db.query('devicePresence').collect());
    expect(row.currentJobId).toBeUndefined();
    await s.alice.mutation(api.devices.revoke, { deviceId: s.deviceId });
    expect((await caught(s.t.mutation(api.worker.heartbeat, { token: TOKEN, state: 'idle' }))).code).toBe('device_unpaired');
  });
});
