/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, test, vi, afterEach } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import { cleanMetadata } from './lib/songMetadata';
import {
  candidate,
  selectRelease,
  strongRecording,
  searchText,
  type Recording,
} from './lib/musicBrainz';
import { hashToken } from './devices';
const modules = import.meta.glob('./**/*.ts');
const quality = {
  model: 'htdemucs',
  shifts: 0,
  overlap: 0.25,
  format: 'opus' as const,
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function setup() {
  vi.useFakeTimers();
  const t = convexTest(schema, modules),
    alice = t.withIdentity({ subject: 'alice' }),
    bob = t.withIdentity({ subject: 'bob' });
  const add = async (userId = 'alice', title = 'Original') =>
    t.run((ctx) =>
      ctx.db.insert('songs', {
        userId,
        title,
        artist: 'Artist',
        album: 'Album',
        duration: 200,
        stems: [],
        stemMode: 'full',
        quality,
        addedAt: 1,
      }),
    );
  return { t, alice, bob, add };
}
test('bulk edits are scoped, atomic, and modify only supplied fields', async () => {
  const { t, alice, bob, add } = await setup();
  const a = await add(),
    b = await add('alice', 'Second'),
    other = await add('bob');
  await expect(
    t.mutation(api.metadata.update, { ids: [a], changes: { artist: 'X' } }),
  ).rejects.toThrow('Not signed in');
  await expect(
    bob.mutation(api.metadata.update, { ids: [a], changes: { artist: 'X' } }),
  ).rejects.toThrow('unavailable');
  await expect(
    alice.mutation(api.metadata.update, {
      ids: [a, other],
      changes: { artist: 'X' },
    }),
  ).rejects.toThrow('unavailable');
  expect((await alice.query(api.songs.get, { id: a }))?.artist).toBe('Artist');
  await alice.mutation(api.metadata.update, {
    ids: [a, b],
    changes: {
      genre: 'Jazz',
      tags: ['warmup', 'warmup'],
      notes: 'Listen to the bass',
    },
  });
  const rows = (await alice.query(api.songs.list, {})).songs;
  expect(rows.map((s: { title: string }) => s.title).sort()).toEqual([
    'Original',
    'Second',
  ]);
  for (const row of rows) {
    expect(row).toMatchObject({
      artist: 'Artist',
      album: 'Album',
      genre: 'Jazz',
      tags: ['warmup'],
      notes: 'Listen to the bass',
    });
    expect(row.metadataLocks.sort()).toEqual(['genre', 'notes', 'tags']);
  }
  expect(
    (
      await alice.query(api.songs.exportPage, {
        paginationOpts: { numItems: 50, cursor: null },
      })
    ).page[0].genre,
  ).toBe('Jazz');
});
test('manual clearing and removing artwork wins over an in-flight lookup', async () => {
  const { t, alice, add } = await setup();
  const id = await add();
  await alice.mutation(api.metadata.update, {
    ids: [id],
    changes: { artist: '', album: '', artwork: { kind: 'removed' } },
  });
  await t.mutation(internal.metadata.applyAutomatic, {
    id,
    before: { title: 'Original', artist: 'Artist', album: 'Album' },
    changes: {
      title: 'Identified',
      artist: 'Catalog artist',
      album: 'Catalog album',
      year: '2000',
      artwork: {
        kind: 'release',
        releaseId: '00000000-0000-0000-0000-000000000001',
      },
    },
    status: 'matched',
  });
  expect(await alice.query(api.songs.get, { id })).toMatchObject({
    title: 'Identified',
    artist: '',
    album: '',
    year: '',
    coverKey: null,
    coverUrl: null,
    artwork: { kind: 'removed' },
  });
  // Another automatic write changed title while this request was in flight.
  await t.mutation(internal.metadata.applyAutomatic, {
    id,
    before: { title: 'Original' },
    changes: { title: 'Stale' },
    status: 'matched',
  });
  expect((await alice.query(api.songs.get, { id }))?.title).toBe('Identified');
});
test('validates fields and refuses invalid or foreign artwork', async () => {
  const { alice, bob, add } = await setup();
  const id = await add();
  for (const changes of [
    { title: ' ' },
    { year: 'x' },
    { trackNumber: '-1' },
    { tags: Array(31).fill('a') },
    { notes: 'x'.repeat(10001) },
  ])
    await expect(
      alice.mutation(api.metadata.update, { ids: [id], changes }),
    ).rejects.toThrow();
  const upload = await alice.mutation(internal.metadata.reserveArtwork, {
    id,
    bytes: 100,
    mime: 'image/png',
    checksum: 'a'.repeat(43) + '=',
  });
  await expect(
    bob.query(internal.metadata.artworkContext, { objectId: upload.objectId }),
  ).rejects.toThrow();
  await expect(
    alice.mutation(api.metadata.update, {
      ids: [id],
      changes: { artwork: { kind: 'upload', key: upload.key } },
    }),
  ).rejects.toThrow('expired');
  await alice.mutation(internal.metadata.verifiedArtwork, {
    objectId: upload.objectId,
  });
  await alice.mutation(api.metadata.update, {
    ids: [id],
    changes: { artwork: { kind: 'upload', key: upload.key } },
  });
  expect((await alice.query(api.songs.get, { id }))?.coverKey).toBe(upload.key);
  expect((await alice.query(api.storage.usage, {})).usedBytes).toBe(100);
});
test('reprocessing keeps metadata and original cover while replacing audio', async () => {
  const { t, alice, add } = await setup();
  const id = await add();
  const token = 'a'.repeat(64);
  const deviceId = await alice.mutation(api.devices.pair, {
    tokenHash: await hashToken(token),
    name: 'Desktop',
  });
  const jobId = await t.run(async (ctx) => {
    await ctx.db.patch(id, {
      coverKey: 'old-cover',
      notes: 'Personal',
      artwork: { kind: 'removed' },
    });
    return ctx.db.insert('jobs', {
      userId: 'alice',
      deviceId,
      kind: 'separate',
      songId: id,
      label: 'Again',
      status: 'running',
      stage: 'finalize',
      percent: 90,
      createdAt: 2,
      updatedAt: 2,
    });
  });
  const files = await t.mutation(internal.storage.reserve, {
    token,
    jobId,
    files: [
      {
        name: 'drums.webm',
        bytes: 100,
        mime: 'audio/webm',
        checksum: 'a'.repeat(43) + '=',
      },
      {
        name: 'cover.jpg',
        bytes: 10,
        mime: 'image/jpeg',
        checksum: 'b'.repeat(43) + '=',
      },
    ],
  });
  await t.mutation(internal.worker.finish, {
    token,
    jobId,
    result: {
      title: 'Reimported',
      artist: 'Wrong artist',
      album: 'Wrong album',
      coverKey: files[1].key,
      duration: 200,
      stems: [{ name: 'drums', key: files[0].key }],
      quality,
      stemMode: 'full',
    },
  });
  expect(await alice.query(api.songs.get, { id })).toMatchObject({
    title: 'Original',
    artist: 'Artist',
    album: 'Album',
    notes: 'Personal',
    artwork: { kind: 'removed' },
    coverKey: null,
    addedAt: 1,
  });
  expect(await t.run((ctx) => ctx.db.get(files[1]._id))).toMatchObject({
    status: 'deleting',
  });
  expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
    coverKey: 'old-cover',
  });
});
test('artwork reserves quota and abandoned uploads expire', async () => {
  const { t, alice, add } = await setup();
  const id = await add();
  vi.stubEnv('CLOUD_USER_BYTE_LIMIT', '150');
  const upload = await alice.mutation(internal.metadata.reserveArtwork, {
    id,
    bytes: 100,
    mime: 'image/png',
    checksum: 'a'.repeat(43) + '=',
  });
  await expect(
    alice.mutation(internal.metadata.reserveArtwork, {
      id,
      bytes: 100,
      mime: 'image/png',
      checksum: 'a'.repeat(43) + '=',
    }),
  ).rejects.toThrow('storage');
  await t.mutation(internal.storage.expire, { id: upload.objectId });
  await expect(
    alice.mutation(internal.metadata.verifiedArtwork, {
      objectId: upload.objectId,
    }),
  ).rejects.toThrow('expired');
});
test('matching is conservative about recordings and album identity', () => {
  const r: Recording = {
    id: '00000000-0000-0000-0000-000000000001',
    title: 'Song',
    length: 200000,
    'artist-credit': [{ name: 'Artist' }],
  };
  expect(
    strongRecording({ title: 'Song', artist: 'Artist', duration: 200 }, [r]),
  ).toBe(r);
  expect(
    strongRecording({ title: 'Song', artist: 'Artist', duration: 200 }, [
      r,
      { ...r, id: '00000000-0000-0000-0000-000000000002' },
    ]),
  ).toBeUndefined();
  expect(
    strongRecording({ title: 'Song', artist: 'Artist', duration: 200 }, [
      { ...r, disambiguation: 'live' },
    ]),
  ).toBeUndefined();
  expect(
    strongRecording({ title: 'Song', duration: 200 }, [r]),
  ).toBeUndefined();
  const release = {
    id: r.id,
    title: 'Album',
    status: 'Official',
    date: '2000-01-01',
    'release-group': { 'first-release-date': '2000-01-01' },
  };
  expect(selectRelease('Other', [release])).toBeUndefined();
  expect(selectRelease('', [release])).toBe(release);
  expect(
    candidate(r, {
      ...release,
      media: [
        { position: 2, tracks: [{ position: 7, recording: { id: r.id } }] },
      ],
    }),
  ).toMatchObject({ trackNumber: '7', discNumber: '2', year: '2000' });
  expect(cleanMetadata({ tags: [' warmup ', 'warmup', ''] })).toEqual({
    tags: ['warmup'],
  });
  expect(searchText('Song" OR *:*', 'Artist')).not.toContain('" OR');
});
