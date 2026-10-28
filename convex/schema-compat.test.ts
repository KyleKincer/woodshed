/// <reference types="vite/client" />
/**
 * Schema compatibility (architecture §6.2, BK0).
 *
 * Every row shape a 1.9 deployment can hold must validate against the 2.0
 * schema (convex-test validates every insert against it) and read back through
 * the public queries. The assertions on `songs.get`, `songs.list` and
 * `jobs.listActive` use only fields that survive B1/B2 (slim list rows,
 * practice out of `songs.get`), so this file stays valid through wave 0B.
 *
 * V1 removes `songs.practice` from the schema and, in the same commit, deletes
 * the single test named "v1 songs.practice rows …" below.
 */
import { convexTest } from 'convex-test';
import type {
  FunctionReference,
  RegisteredAction,
  RegisteredMutation,
  RegisteredQuery,
  WithoutSystemFields,
} from 'convex/server';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type * as setlistsModule from './setlists';
import type * as migrationsModule from './migrations';
import apiDts from './_generated/api.d.ts?raw';

const modules = import.meta.glob('./**/*.ts');
const quality = { model: 'htdemucs', shifts: 1, overlap: 0.25, format: 'opus' as const, bitrate: 192 };
const stems = [
  { name: 'drums', key: 'users/alice/songs/a/drums.opus', bytes: 1_200_000, mime: 'audio/ogg' },
  { name: 'bass', key: 'users/alice/songs/a/bass.opus' },
];
const frac = (n: number, d = 1) => ({ n, d });
const measure = (i: number, numerator = 4, denominator = 4) =>
  ({ id: `m${i}`, numerator, denominator, length: frac(numerator, denominator), label: '' });

// ---- 1.9 row shapes ---------------------------------------------------------

/** A song row written before 2.0: none of the new fields, no tempo, no practice. */
const bareSong = (userId: string, title: string, addedAt: number): WithoutSystemFields<Doc<'songs'>> => ({
  userId, title, duration: 241.5, stems, stemMode: 'four', quality, addedAt,
});

/** 1.9's `metronome.serialize()` for a 1.6–1.9 song map (no `origin`), with the legacy dual-write and click fields. */
const legacyTempo19 = {
  accent: true, volume: 0.8, countIn: true, countInLength: 2, countInUnit: 'bars', audiblePreRoll: false, enabled: false,
  songMap: { version: 1, measures: [measure(0), measure(1), measure(2, 7, 8)], pins: [{ position: frac(0), time: 0.42 }, { position: frac(8), time: 4.42, ramp: false }] },
  source: 'detected', map: [],
  detected: [{ time: 0.42, downbeat: true }, { time: 0.92, downbeat: false }, { time: 1.42, downbeat: false }],
};
/** A pre-1.6 tempo map, saved untouched by 1.9 (`songMap.legacy`). */
const legacyTempoMap = {
  accent: false, volume: 1, countIn: false, countInLength: 1, countInUnit: 'beats', audiblePreRoll: true, enabled: true,
  source: 'manual', map: [{ t: 0, bpm: 120, beatsPerBar: 4, unit: 4 }, { t: 64, bpm: 96, beatsPerBar: 3, unit: 4 }],
};
/** A pre-1.6 detected beat list. */
const legacyTempoDetected = {
  source: 'detected', map: [],
  detected: [{ time: 0.5, downbeat: true }, { time: 1, downbeat: false }, { time: 1.5, downbeat: false }, { time: 2, downbeat: false }],
};

/** Practice blobs 1.9 wrote (`player.js` flushPractice) and the older shapes still stored. */
const v1Practice = {
  loop: { enabled: true, a: 12.5, b: 30.25 }, rate: 0.75,
  grid: { visible: true, snap: false, division: 2 },
  tracks: [{ name: 'drums', volume: 0.9, muted: true, soloed: false }, { name: 'bass', volume: 1, muted: false, soloed: false }],
};
const v1PracticeShapes = [v1Practice, { rate: 1 }, { rate: 0.9, loop: { enabled: false, a: 0, b: 0 }, tracks: [] }];

/** Every 1.9 job (kind × status × stage) the backend or the companion could leave behind. */
const legacyJobs = (userId: string, deviceId: Id<'devices'>, songId: Id<'songs'>): WithoutSystemFields<Doc<'jobs'>>[] => {
  const base = { userId, deviceId, percent: 0, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 };
  const search = { type: 'search' as const, value: 'radiohead weird fishes' };
  const upload = { type: 'upload' as const, value: 'users/alice/uploads/u1/take.wav', filename: 'take 3.wav' };
  const sepSettings = { preset: 'balanced', stemMode: 'four', model: 'htdemucs', shifts: 1, overlap: 0.25, format: 'opus', bitrate: 192 };
  return [
    { ...base, kind: 'separate', label: 'Weird Fishes', source: search, settings: sepSettings, status: 'queued', stage: 'queued' },
    { ...base, kind: 'separate', label: 'Weird Fishes', source: search, settings: sepSettings, status: 'running', stage: 'download', percent: 12, message: 'Downloading…', attempts: 1, meta: { title: 'Weird Fishes/Arpeggi', thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg', duration: 318 } },
    { ...base, kind: 'separate', label: 'take 3', source: upload, settings: sepSettings, status: 'running', stage: 'separate', percent: 55, message: 'Separating 2/4', attempts: 2 },
    { ...base, kind: 'separate', label: 'take 3', source: upload, settings: sepSettings, status: 'running', stage: 'finalize', percent: 98, songId },
    { ...base, kind: 'separate', label: 'Weird Fishes', source: search, settings: sepSettings, status: 'done', stage: 'done', percent: 100, songId },
    { ...base, kind: 'separate', label: 'Weird Fishes', source: search, settings: sepSettings, status: 'error', stage: 'download', error: 'ERROR: Sign in to confirm you’re not a bot', attempts: 3 },
    { ...base, kind: 'separate', label: 'Weird Fishes', source: { type: 'url', value: 'https://youtu.be/abc' }, status: 'canceled', stage: 'queued' },
    { ...base, kind: 'separate', label: 'Spotify pick', source: { type: 'spotify', value: 'https://open.spotify.com/track/1' }, status: 'queued', stage: 'queued' },
    { ...base, kind: 'beats', label: 'Detect beats', songId, status: 'queued', stage: 'queued' },
    { ...base, kind: 'beats', label: 'Detect beats', songId, status: 'running', stage: 'detect', percent: 40 },
    { ...base, kind: 'beats', label: 'Detect beats', songId, status: 'done', stage: 'done', percent: 100, result: { beats: [[0.42, 1], [0.92, 2], [1.42, 3], [1.92, 4]] } },
    { ...base, kind: 'beats', label: 'Detect beats', songId, status: 'error', stage: 'detect', error: 'madmom is not installed' },
    { ...base, kind: 'import', label: 'Old library song', importMeta: { id: 'legacy-17', tempo: legacyTempoMap, practice: { rate: 1 } }, status: 'queued', stage: 'queued' },
    { ...base, kind: 'import', label: 'Old library song', importMeta: { id: 'legacy-18', tempo: null, practice: null }, status: 'done', stage: 'done', percent: 100, songId },
    // A job row written before deviceId existed.
    { userId, kind: 'separate', label: 'Pre-device job', status: 'canceled', stage: 'queued', percent: 0, createdAt: 1, updatedAt: 1 },
  ];
};

type Caller = ReturnType<ReturnType<typeof convexTest>['withIdentity']>;
/** `songs.get` for a song the caller owns (asserted non-null). */
async function getSong(caller: Caller, id: Id<'songs'>) {
  const song = await caller.query(api.songs.get, { id });
  expect(song).not.toBeNull();
  return song!;
}

async function seedLegacy() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity({ subject: 'alice' });
  const ids = await t.run(async ctx => {
    const deviceId = await ctx.db.insert('devices', { userId: 'alice', tokenHash: 'h'.repeat(64), name: 'Kyle’s MacBook Pro', revoked: false });
    const revokedDeviceId = await ctx.db.insert('devices', { userId: 'alice', tokenHash: 'r'.repeat(64), name: 'Old PC', revoked: true });
    const bare = await ctx.db.insert('songs', bareSong('alice', 'Bare', 1));
    const full = await ctx.db.insert('songs', {
      ...bareSong('alice', 'Weird Fishes/Arpeggi', 2),
      uploader: 'Radiohead', artist: 'Radiohead', album: 'In Rainbows', albumArtist: 'Radiohead', year: '2007', genre: 'Rock',
      trackNumber: '4', discNumber: '1', musicalKey: 'E minor', tuning: 'Standard', tags: ['odd', 'groove'], notes: 'Watch the ride.',
      artwork: { kind: 'release', releaseId: '9e5d1e4f-6f2e-4b44-9c6d-3a1a1a1a1a1a' },
      metadataLocks: ['title'], metadataStatus: 'matched',
      metadataRecordingId: '1b4b1c3e-1111-4c4c-8a8a-222222222222', metadataReleaseId: '9e5d1e4f-6f2e-4b44-9c6d-3a1a1a1a1a1a',
      fingerprint: { value: 'AQAAE0mUaEkSRZEGAA', duration: 318 },
      source: { type: 'search', value: 'radiohead weird fishes' }, coverKey: 'users/alice/songs/b/cover.jpg',
      tempo: legacyTempo19,
    });
    const preMap = await ctx.db.insert('songs', {
      ...bareSong('alice', 'Old map', 3), tempo: legacyTempoMap,
      source: { type: 'upload', value: 'users/alice/uploads/u1/take.wav', filename: 'take 3.wav' },
      quality: { model: 'htdemucs_ft', shifts: 2, overlap: 0.5, format: 'wav' },
    });
    const beatList = await ctx.db.insert('songs', { ...bareSong('alice', 'Beat list', 4), tempo: legacyTempoDetected, metadataStatus: 'uncertain', localImportId: 'legacy-18' });
    const pending = await ctx.db.insert('songs', { ...bareSong('alice', 'Pending lookup', 5), metadataStatus: 'pending', quality: { ...quality, format: 'flac', bitrate: undefined } });
    const bobSong = await ctx.db.insert('songs', bareSong('bob', 'Bob’s song', 6));
    const jobIds = [];
    for (const job of legacyJobs('alice', deviceId, full)) jobIds.push(await ctx.db.insert('jobs', job));
    const settingsId = await ctx.db.insert('userSettings', {
      userId: 'alice',
      settings: { preset: 'balanced', stemMode: 'four', format: 'opus', bitrate: 192, custom: { model: 'htdemucs_ft', shifts: 2, overlap: 0.5 } },
    });
    return { deviceId, revokedDeviceId, songs: { bare, full, preMap, beatList, pending }, bobSong, jobIds, settingsId };
  });
  return { t, alice, ...ids };
}

describe('1.9 rows under the 2.0 schema', () => {
  test('songs without any new field read back through songs.get and songs.list', async () => {
    const { alice, songs, bobSong } = await seedLegacy();
    const { songs: listed } = await alice.query(api.songs.list, {});
    const byId = new Map(listed.map((row: { id: string }) => [row.id, row]));
    expect(listed).toHaveLength(Object.keys(songs).length);
    for (const [title, id] of [['Bare', songs.bare], ['Weird Fishes/Arpeggi', songs.full], ['Old map', songs.preMap], ['Beat list', songs.beatList], ['Pending lookup', songs.pending]] as const) {
      expect(byId.get(id)).toMatchObject({ id, title, duration: 241.5 });
      const got = await getSong(alice, id);
      expect(got).toMatchObject({ id, title, stemMode: 'four' });
      expect(got.stems.map((s: { name: string }) => s.name)).toEqual(['drums', 'bass']);
    }
    expect(byId.has(bobSong)).toBe(false);
    expect(await alice.query(api.songs.get, { id: bobSong })).toBeNull();
    // Newest first.
    expect(listed.map((row: { title: string }) => row.title)).toEqual(['Pending lookup', 'Beat list', 'Old map', 'Weird Fishes/Arpeggi', 'Bare']);
  });

  test('legacy tempo shapes (source/map/detected and click fields) are stored and returned unchanged', async () => {
    const { alice, songs } = await seedLegacy();
    expect((await getSong(alice, songs.full)).tempo).toEqual(legacyTempo19);
    expect((await getSong(alice, songs.preMap)).tempo).toEqual(legacyTempoMap);
    expect((await getSong(alice, songs.beatList)).tempo).toEqual(legacyTempoDetected);
    expect((await getSong(alice, songs.bare)).tempo ?? null).toBeNull();
  });

  test('metadata, source and quality fields of 1.9 songs survive the read', async () => {
    const { alice, songs } = await seedLegacy();
    const full = await getSong(alice, songs.full);
    expect(full).toMatchObject({
      artist: 'Radiohead', album: 'In Rainbows', year: '2007', tags: ['odd', 'groove'], metadataStatus: 'matched',
      source: { type: 'search', value: 'radiohead weird fishes' }, quality,
    });
    const preMap = await getSong(alice, songs.preMap);
    expect(preMap.source).toEqual({ type: 'upload', value: 'users/alice/uploads/u1/take.wav', filename: 'take 3.wav' });
    expect(preMap.quality.format).toBe('wav');
  });

  test('1.9 jobs of every kind and stage validate; live ones read back through jobs.listActive', async () => {
    const { t, alice, jobIds } = await seedLegacy();
    const stored = await t.run(ctx => Promise.all(jobIds.map(id => ctx.db.get('jobs', id))));
    const active = await alice.query(api.jobs.listActive, {});
    const activeIds = new Set(active.map((row: { jobId: string }) => row.jobId));
    const live = stored.filter(job => job && ['queued', 'running', 'error'].includes(job.status));
    expect(live.length).toBeGreaterThanOrEqual(10);
    for (const job of live) {
      expect(activeIds.has(job!._id)).toBe(true);
      expect(active.find((row: { jobId: string }) => row.jobId === job!._id)).toMatchObject({
        kind: job!.kind, label: job!.label, status: job!.status, stage: job!.stage, percent: job!.percent,
      });
    }
    for (const job of stored.filter(job => job && ['done', 'canceled'].includes(job.status))) expect(activeIds.has(job!._id)).toBe(false);
    expect(await t.withIdentity({ subject: 'bob' }).query(api.jobs.listActive, {})).toEqual([]);
  });

  test('devices without displayName or revokedBy, and userSettings with format, validate and read back', async () => {
    const { t, deviceId, revokedDeviceId, settingsId } = await seedLegacy();
    const [device, revoked, settings] = await t.run(ctx => Promise.all([
      ctx.db.get('devices', deviceId), ctx.db.get('devices', revokedDeviceId), ctx.db.get('userSettings', settingsId),
    ]));
    expect(device).toMatchObject({ name: 'Kyle’s MacBook Pro', revoked: false });
    expect(device?.displayName).toBeUndefined();
    expect(revoked).toMatchObject({ revoked: true });
    expect(revoked?.revokedBy).toBeUndefined();
    expect(settings?.settings).toMatchObject({ preset: 'balanced', format: 'opus' });
  });

  // V1 deletes this test together with the `songs.practice` field (owner gate G7).
  test('v1 songs.practice rows validate and read back', async () => {
    const t = convexTest(schema, modules);
    const alice = t.withIdentity({ subject: 'alice' });
    const ids = await t.run(ctx => Promise.all(v1PracticeShapes.map((practice, i) =>
      ctx.db.insert('songs', { ...bareSong('alice', `Practised ${i}`, 10 + i), practice, tempo: legacyTempo19 })),
    ));
    for (const [i, id] of ids.entries()) {
      expect(await t.run(ctx => ctx.db.get('songs', id))).toMatchObject({ practice: v1PracticeShapes[i] });
      expect(await alice.query(api.songs.get, { id })).toMatchObject({ id, title: `Practised ${i}` });
    }
    expect((await alice.query(api.songs.list, {})).songs).toHaveLength(ids.length);
  });
});

// ---- 2.0 shapes -------------------------------------------------------------

describe('2.0 tables and fields', () => {
  async function seed20() {
    const t = convexTest(schema, modules);
    const rows = await t.run(async ctx => {
      const deviceId = await ctx.db.insert('devices', {
        userId: 'alice', tokenHash: 'd'.repeat(64), name: 'MacBook Pro', revoked: true, displayName: 'Studio Mac', revokedBy: 'user',
      });
      const songId = await ctx.db.insert('songs', bareSong('alice', 'Rehearsal song', 1));
      const jobId = await ctx.db.insert('jobs', {
        userId: 'alice', deviceId, songId, kind: 'sections', label: 'Finding sections — Rehearsal song', status: 'queued', stage: 'queued',
        percent: 0, createdAt: 1, updatedAt: 1, settings: { sections: true },
      });
      const separateId = await ctx.db.insert('jobs', {
        userId: 'alice', deviceId, kind: 'separate', label: 'x', status: 'error', stage: 'download', percent: 0, createdAt: 1, updatedAt: 2,
        errorCode: 'bot_check', retryAt: 300_000, startedAt: 1, confirmed: true, attempts: 1,
      });
      await ctx.db.insert('jobs', {
        userId: 'alice', deviceId, songId, kind: 'beats', label: 'Finding bars — Rehearsal song', status: 'done', stage: 'done', percent: 100,
        createdAt: 1, updatedAt: 3, chainedFrom: separateId, appliedAt: 4, result: { beats: [[0.5, 1]], sections: [] },
      });
      await ctx.db.patch('songs', songId, {
        hasChart: true, lastPracticedAt: 1_800_000_000_000,
        practiceSummary: { loopLabel: 'Chorus 2', rate: 0.75, minusMe: true, surface: 'chart', spotCount: 5, spots: [{ id: 's1', name: 'Fill into bridge', rate: 0.6 }] },
        mapSummary: { real: true, bpm: 92, meter: '7/8', sections: ['Intro', 'Verse 1', 'Chorus 1'] },
        tempoRev: 3, tempoSaveId: 'save-17',
        metadataSuggestion: { recordingId: '1b4b1c3e-1111-4c4c-8a8a-222222222222', title: 'Rehearsal Song', artist: 'Band' },
        needsReview: true, recordingUnconfirmed: true,
        sectionSuggestion: { sections: [{ t0: 0, label: 'Intro', confidence: 0.9 }, { t0: 21.3, label: 'Verse', confidence: 0.62 }], jobId, createdAt: 5 },
        resolvedUrl: 'https://www.youtube.com/watch?v=abc', provider: 'youtube', originDeviceId: deviceId,
      });
      await ctx.db.insert('songPractice', { songId, userId: 'alice', practice: { version: 2, rate: 0.75, spots: [] }, updatedAt: 6 });
      await ctx.db.insert('setlists', { userId: 'alice', name: 'Friday gig', songIds: [songId, songId], createdAt: 1, updatedAt: 7, lastOpenedAt: 8 });
      await ctx.db.insert('setlists', { userId: 'alice', name: 'Empty', songIds: [], createdAt: 1, updatedAt: 2 });
      await ctx.db.insert('devicePresence', {
        deviceId, userId: 'alice', lastSeenAt: 9, state: 'busy', currentJobId: jobId, appVersion: '2.0.0', platform: 'darwin', accelerator: 'mps',
      });
      await ctx.db.insert('devicePresence', { deviceId, userId: 'alice', lastSeenAt: 10, state: 'offline' });
      return { deviceId, songId, jobId };
    });
    return { t, ...rows };
  }

  test('every new table and field accepts its contract shape, and the new indexes are queryable', async () => {
    const { t, deviceId, songId } = await seed20();
    const found = await t.run(async ctx => ({
      practice: await ctx.db.query('songPractice').withIndex('by_songId', q => q.eq('songId', songId)).unique(),
      setlists: await ctx.db.query('setlists').withIndex('by_userId_and_updatedAt', q => q.eq('userId', 'alice')).order('desc').take(100),
      presence: await ctx.db.query('devicePresence').withIndex('by_deviceId', q => q.eq('deviceId', deviceId)).take(5),
      presenceByUser: await ctx.db.query('devicePresence').withIndex('by_userId', q => q.eq('userId', 'alice')).take(5),
      song: await ctx.db.get('songs', songId),
    }));
    expect(found.practice?.practice).toEqual({ version: 2, rate: 0.75, spots: [] });
    expect(found.setlists.map(s => s.name)).toEqual(['Friday gig', 'Empty']);
    expect(found.presence.map(p => p.state)).toEqual(['busy', 'offline']);
    expect(found.presenceByUser).toHaveLength(2);
    expect(found.song?.mapSummary).toEqual({ real: true, bpm: 92, meter: '7/8', sections: ['Intro', 'Verse 1', 'Chorus 1'] });
    expect(found.song?.sectionSuggestion?.sections).toHaveLength(2);
  });

  test('2.0 song rows still read back through songs.get and songs.list', async () => {
    const { t, songId } = await seed20();
    const alice = t.withIdentity({ subject: 'alice' });
    expect(await alice.query(api.songs.get, { id: songId })).toMatchObject({ id: songId, title: 'Rehearsal song' });
    expect((await alice.query(api.songs.list, {})).songs.map((row: { id: string }) => row.id)).toEqual([songId]);
  });

  test('a sections job reads back through jobs.listActive', async () => {
    const { t, jobId } = await seed20();
    const active = await t.withIdentity({ subject: 'alice' }).query(api.jobs.listActive, {});
    expect(active.find((row: { jobId: string }) => row.jobId === jobId)).toMatchObject({ kind: 'sections', status: 'queued' });
  });

  test('a raw MusicBrainz candidate() result stores as metadataSuggestion', async () => {
    const t = convexTest(schema, modules);
    await t.run(ctx => ctx.db.insert('songs', {
      ...bareSong('alice', 'x', 1),
      metadataSuggestion: {
        recordingId: '1b4b1c3e-1111-4c4c-8a8a-222222222222', releaseId: '9e5d1e4f-6f2e-4b44-9c6d-3a1a1a1a1a1a', title: 'X', artist: 'Y',
        album: 'Z', albumArtist: 'Y', year: '1999', trackNumber: '3', discNumber: '1', duration: 201.2, disambiguation: '', score: 88,
      },
    }));
  });

  test('the schema rejects shapes outside the contract (validation is on)', async () => {
    const t = convexTest(schema, modules);
    const songId = await t.run(ctx => ctx.db.insert('songs', bareSong('alice', 'x', 1)));
    const deviceId = await t.run(ctx => ctx.db.insert('devices', { userId: 'alice', tokenHash: 'x', name: 'x', revoked: false }));
    const bad: Array<(ctx: Parameters<Parameters<typeof t.run>[0]>[0]) => Promise<unknown>> = [
      ctx => ctx.db.patch('songs', songId, { practiceSummary: { rate: 1, minusMe: false, spotCount: 0 } } as never),
      ctx => ctx.db.patch('songs', songId, { mapSummary: { real: 'yes', sections: [] } } as never),
      ctx => ctx.db.patch('songs', songId, { metadataSuggestion: { title: 'no recording id' } } as never),
      ctx => ctx.db.patch('songs', songId, { sectionSuggestion: { sections: [{ t0: 0, label: 'Intro' }], jobId: 'nope', createdAt: 1 } } as never),
      ctx => ctx.db.patch('devices', deviceId, { revokedBy: 'system' } as never),
      ctx => ctx.db.insert('devicePresence', { deviceId, userId: 'alice', lastSeenAt: 1, state: 'online' } as never),
      ctx => ctx.db.insert('jobs', { userId: 'alice', kind: 'analyse', label: 'x', status: 'queued', stage: 'queued', percent: 0, createdAt: 1, updatedAt: 1 } as never),
      ctx => ctx.db.insert('setlists', { userId: 'alice', name: 'x', songIds: ['not-an-id'], createdAt: 1, updatedAt: 1 } as never),
      ctx => ctx.db.insert('songPractice', { songId, userId: 'alice', practice: {} } as never),
    ];
    for (const write of bad) await expect(t.run(write)).rejects.toThrow();
  });
});

// ---- type tests (checked by `npm run typecheck`) ----------------------------

// Every 2.0 field is optional: a 1.9-shaped literal is a complete row.
const legacySongRow: WithoutSystemFields<Doc<'songs'>> = { userId: 'u', title: 't', duration: 1, stems: [], stemMode: 'two', quality, addedAt: 1 };
const legacyJobRow: WithoutSystemFields<Doc<'jobs'>> = { userId: 'u', kind: 'beats', label: 'l', status: 'done', stage: 'done', percent: 100, createdAt: 1, updatedAt: 1 };
const legacyDeviceRow: WithoutSystemFields<Doc<'devices'>> = { userId: 'u', tokenHash: 'h', name: 'n', revoked: false };

/**
 * `api.setlists` / `internal.migrations` wiring. Convex's `FilterApi` drops a
 * module with no functions, so while the stubs are empty these resolve to
 * `true` trivially; as soon as BK6 or BK1 exports a function, each exported
 * function must appear under `api.setlists` / `internal.migrations` with the
 * right visibility, which holds only if `_generated/api.d.ts` lists the module.
 */
type Visible<M, V extends 'public' | 'internal'> = {
  [K in keyof M as M[K] extends RegisteredQuery<V, any, any> | RegisteredMutation<V, any, any> | RegisteredAction<V, any, any> ? K : never]: M[K];
};
type ApiModule<A, K extends string> = K extends keyof A ? A[K] : 'module missing from _generated/api.d.ts';
type Wired<M, V extends 'public' | 'internal', A> = [keyof Visible<M, V>] extends [never]
  ? true
  : [A] extends [Record<keyof Visible<M, V>, FunctionReference<any, V>>] ? true : false;
const setlistsWired: Wired<typeof setlistsModule, 'public', ApiModule<typeof api, 'setlists'>> = true;
const setlistsInternalWired: Wired<typeof setlistsModule, 'internal', ApiModule<typeof internal, 'setlists'>> = true;
const migrationsWired: Wired<typeof migrationsModule, 'internal', ApiModule<typeof internal, 'migrations'>> = true;

describe('generated api wiring', () => {
  test('type tests compile (see above) and both modules load', async () => {
    expect([legacySongRow.title, legacyJobRow.kind, legacyDeviceRow.revoked]).toEqual(['t', 'beats', false]);
    expect([setlistsWired, setlistsInternalWired, migrationsWired]).toEqual([true, true, true]);
    expect(await modules['./setlists.ts']()).toBeTypeOf('object');
    expect(await modules['./migrations.ts']()).toBeTypeOf('object');
  });

  test('_generated/api.d.ts lists setlists and migrations in codegen format', () => {
    for (const name of ['setlists', 'migrations']) {
      expect(apiDts).toContain(`import type * as ${name} from "../${name}.js";`);
      expect(apiDts).toContain(`  ${name}: typeof ${name};`);
    }
  });
});
