/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, test, vi, afterEach } from 'vitest';
import { ConvexError } from 'convex/values';
import type { Id } from './_generated/dataModel';
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
  vi.unstubAllGlobals();
});
/** The stored song document (list rows are slim from B1 on, so tests read the table). */
const doc = (t: ReturnType<typeof convexTest>, id: Id<'songs'>) => t.run((ctx) => ctx.db.get('songs', id));
/** The ConvexError data a call rejects with. */
async function errorOf(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    return (error as ConvexError<any>).data as Record<string, unknown>;
  }
  throw new Error('expected the call to fail');
}
const codeOfCall = async (fn: () => Promise<unknown>) => (await errorOf(fn)).code;
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
  expect(
    await codeOfCall(() => t.mutation(api.metadata.update, { ids: [a], changes: { artist: 'X' } })),
  ).toBe('not_signed_in');
  expect(
    await codeOfCall(() => bob.mutation(api.metadata.update, { ids: [a], changes: { artist: 'X' } })),
  ).toBe('not_found');
  await expect(
    alice.mutation(api.metadata.update, {
      ids: [a, other],
      changes: { artist: 'X' },
    }),
  ).rejects.toThrow('unavailable');
  expect((await doc(t, a))?.artist).toBe('Artist');
  expect(
    await codeOfCall(() => alice.mutation(api.metadata.update, { ids: [], changes: { genre: 'Jazz' } })),
  ).toBe('invalid');
  await alice.mutation(api.metadata.update, {
    ids: [a, b],
    changes: {
      genre: 'Jazz',
      tags: ['warmup', 'Warmup'],
      notes: 'Listen to the bass',
    },
  });
  for (const id of [a, b]) {
    const row = await doc(t, id);
    expect(row).toMatchObject({
      artist: 'Artist',
      album: 'Album',
      genre: 'Jazz',
      tags: ['warmup'],
      notes: 'Listen to the bass',
    });
    expect([...(row?.metadataLocks ?? [])].sort()).toEqual(['genre', 'notes', 'tags']);
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

test('update cancellation is scoped to the device and preserves completed jobs', async () => {
  const {t,alice,bob} = await setup();
  const token = 'b'.repeat(64), otherToken = 'c'.repeat(64);
  const deviceId = await alice.mutation(api.devices.pair,{tokenHash:await hashToken(token),name:'Desktop'});
  await bob.mutation(api.devices.pair,{tokenHash:await hashToken(otherToken),name:'Other desktop'});
  const jobId = await t.run(ctx=>ctx.db.insert('jobs',{userId:'alice',deviceId,kind:'separate',label:'Song',status:'running',stage:'separate',percent:50,createdAt:1,updatedAt:1}));
  expect(await t.mutation(api.worker.cancelForUpdate,{token:otherToken,jobId})).toBe(false);
  expect(await t.mutation(api.worker.cancelForUpdate,{token,jobId})).toBe(true);
  expect(await t.query(api.worker.next,{token})).toBeNull();
  await t.run(ctx=>ctx.db.patch(jobId,{status:'done'}));
  expect(await t.mutation(api.worker.cancelForUpdate,{token,jobId})).toBe(false);
});

// ---- 2.0 metadata additions (§6.9, D6) ---------------------------------------------

const REC = '11111111-1111-4111-8111-111111111111',
  REL = '22222222-2222-4222-8222-222222222222',
  REL2 = '33333333-3333-4333-8333-333333333333';
const suggestion = {
  recordingId: REC,
  releaseId: REL,
  title: 'Original',
  artist: 'Artist',
  album: 'Album',
  year: '1999',
};

test('unchanged keys neither save, lock nor clear ids (G1)', async () => {
  const { t, alice, add } = await setup();
  const a = await add(),
    b = await add('alice', 'Second');
  await t.run(async (ctx) => {
    await ctx.db.patch('songs', a, {
      genre: 'Jazz',
      tags: ['warmup'],
      metadataRecordingId: REC,
      metadataReleaseId: REL,
      metadataStatus: 'matched',
    });
  });
  const before = await doc(t, a);
  // An autosave on blur sends the field even when the user changed nothing.
  await alice.mutation(api.metadata.update, {
    ids: [a],
    changes: { title: ' Original ', artist: 'Artist', album: 'Album', albumArtist: '', tags: [' warmup', 'WARMUP'], genre: 'Jazz' },
  });
  expect(await doc(t, a)).toEqual(before);
  // A bulk save locks only the songs whose value actually changes.
  await alice.mutation(api.metadata.update, { ids: [a, b], changes: { genre: 'Jazz' } });
  expect((await doc(t, a))?.metadataLocks).toBeUndefined();
  expect((await doc(t, b))?.metadataLocks).toEqual(['genre']);
  // An empty value on an absent field is no change either.
  await alice.mutation(api.metadata.update, { ids: [a], changes: { tuning: '', musicalKey: '  ' } });
  expect(await doc(t, a)).toEqual(before);
});

test('a real title or artist change clears ids, suggestion and needsReview; album clears the release only', async () => {
  const { t, alice, add } = await setup();
  const a = await add(),
    b = await add('alice', 'Second');
  for (const id of [a, b])
    await t.run((ctx) =>
      ctx.db.patch('songs', id, {
        metadataRecordingId: REC,
        metadataReleaseId: REL,
        metadataStatus: 'uncertain',
        metadataSuggestion: suggestion,
        needsReview: true,
      }),
    );
  await alice.mutation(api.metadata.update, { ids: [a], changes: { title: 'Renamed' } });
  const renamed = await doc(t, a);
  expect(renamed).toMatchObject({ title: 'Renamed', metadataLocks: ['title'], metadataStatus: 'uncertain' });
  for (const key of ['metadataRecordingId', 'metadataReleaseId', 'metadataSuggestion', 'needsReview'] as const)
    expect(renamed?.[key]).toBeUndefined();
  await alice.mutation(api.metadata.update, { ids: [b], changes: { albumArtist: 'Various' } });
  const album = await doc(t, b);
  expect(album).toMatchObject({ metadataRecordingId: REC, metadataSuggestion: suggestion, needsReview: true });
  expect(album?.metadataReleaseId).toBeUndefined();
});

test('unlock removes locks after patching (Revert, G2)', async () => {
  const { t, alice, add } = await setup();
  const id = await add();
  await alice.mutation(api.metadata.update, { ids: [id], changes: { genre: 'Jazz', year: '2001' } });
  expect([...((await doc(t, id))?.metadataLocks ?? [])].sort()).toEqual(['genre', 'year']);
  // Revert: restore the original value and the original unlocked state in one call.
  await alice.mutation(api.metadata.update, { ids: [id], changes: { genre: '' }, unlock: ['genre'] });
  expect(await doc(t, id)).toMatchObject({ genre: '', metadataLocks: ['year'] });
  // Unlock alone (no value change) works, and unknown keys are refused with the field named.
  await alice.mutation(api.metadata.update, { ids: [id], changes: {}, unlock: ['year', 'year'] });
  expect((await doc(t, id))?.metadataLocks).toEqual([]);
  expect(
    await errorOf(() => alice.mutation(api.metadata.update, { ids: [id], changes: {}, unlock: ['metadataStatus'] })),
  ).toMatchObject({ code: 'invalid', field: 'metadataStatus' });
});

test('match records the chosen recording after the clearing rule (G4)', async () => {
  const { t, alice, add } = await setup();
  const id = await add(),
    other = await add('alice', 'Second');
  await t.run((ctx) =>
    ctx.db.patch('songs', id, { metadataStatus: 'uncertain', metadataSuggestion: suggestion, needsReview: true }),
  );
  await alice.mutation(api.metadata.update, {
    ids: [id],
    changes: { title: 'Catalog title', artist: 'Catalog artist', album: 'Catalog album' },
    match: { recordingId: REC, releaseId: REL },
  });
  const matched = await doc(t, id);
  expect(matched).toMatchObject({
    title: 'Catalog title',
    metadataStatus: 'matched',
    metadataRecordingId: REC,
    metadataReleaseId: REL,
  });
  expect([...(matched?.metadataLocks ?? [])].sort()).toEqual(['album', 'artist', 'title']);
  expect(matched?.metadataSuggestion).toBeUndefined();
  expect(matched?.needsReview).toBeUndefined();
  // A recording without a release drops the old release id; unchanged fields still record the match.
  await alice.mutation(api.metadata.update, {
    ids: [id],
    changes: { title: 'Catalog title' },
    match: { recordingId: '44444444-4444-4444-8444-444444444444' },
  });
  expect(await doc(t, id)).toMatchObject({ metadataRecordingId: '44444444-4444-4444-8444-444444444444' });
  expect((await doc(t, id))?.metadataReleaseId).toBeUndefined();
  expect(
    await codeOfCall(() =>
      alice.mutation(api.metadata.update, { ids: [id, other], changes: {}, match: { recordingId: REC } }),
    ),
  ).toBe('invalid');
  expect(
    await codeOfCall(() =>
      alice.mutation(api.metadata.update, { ids: [id], changes: {}, match: { recordingId: REC, releaseId: 'nope' } }),
    ),
  ).toBe('invalid');
});

test('confirm locks the identity keys present and clears the suggestion and needsReview only', async () => {
  const { t, alice, bob, add } = await setup();
  const id = await add();
  await t.run((ctx) =>
    ctx.db.patch('songs', id, {
      albumArtist: '',
      year: '1999',
      genre: 'Rock',
      artwork: { kind: 'release', releaseId: REL },
      metadataLocks: ['notes'],
      metadataStatus: 'uncertain',
      metadataSuggestion: suggestion,
      needsReview: true,
      recordingUnconfirmed: true,
    }),
  );
  expect(await codeOfCall(() => bob.mutation(api.metadata.confirm, { id }))).toBe('not_found');
  await alice.mutation(api.metadata.confirm, { id });
  const song = await doc(t, id);
  expect(song).toMatchObject({ metadataStatus: 'matched', recordingUnconfirmed: true });
  expect([...(song?.metadataLocks ?? [])].sort()).toEqual(['album', 'artist', 'artwork', 'notes', 'title', 'year']);
  expect(song?.metadataSuggestion).toBeUndefined();
  expect(song?.needsReview).toBeUndefined();
  // The suggestion named this very recording, so its ids are kept.
  expect(song).toMatchObject({ metadataRecordingId: REC, metadataReleaseId: REL });
});

test('confirm keeps no ids from a suggestion for a different recording', async () => {
  const { t, alice, add } = await setup();
  const id = await add();
  await t.run((ctx) =>
    ctx.db.patch('songs', id, {
      metadataStatus: 'uncertain',
      metadataSuggestion: { ...suggestion, title: 'Something else' },
    }),
  );
  await alice.mutation(api.metadata.confirm, { id });
  const song = await doc(t, id);
  expect(song?.metadataRecordingId).toBeUndefined();
  expect(song?.metadataStatus).toBe('matched');
});

test('the suggestion is stored on uncertain, kept on unavailable, cleared on matched and on a title edit (G5)', async () => {
  const { t, alice, add } = await setup();
  const id = await add();
  const before = { title: 'Original', artist: 'Artist', album: 'Album' };
  await t.mutation(internal.metadata.applyAutomatic, { id, before, changes: {}, suggestion, status: 'uncertain' });
  expect(await doc(t, id)).toMatchObject({ metadataStatus: 'uncertain', metadataSuggestion: suggestion });
  await t.mutation(internal.metadata.applyAutomatic, { id, before, changes: {}, status: 'unavailable' });
  expect(await doc(t, id)).toMatchObject({ metadataStatus: 'unavailable', metadataSuggestion: suggestion });
  await alice.mutation(api.metadata.update, { ids: [id], changes: { title: 'Typed title' } });
  expect((await doc(t, id))?.metadataSuggestion).toBeUndefined();
  // A suggestion for the title the lookup started with is stale once the user retitled the song.
  await t.mutation(internal.metadata.applyAutomatic, { id, before, changes: {}, suggestion, status: 'uncertain' });
  expect((await doc(t, id))?.metadataSuggestion).toBeUndefined();
  await t.mutation(internal.metadata.applyAutomatic, {
    id,
    before: { ...before, title: 'Typed title' },
    changes: {},
    suggestion,
    status: 'uncertain',
  });
  expect((await doc(t, id))?.metadataSuggestion).toEqual(suggestion);
  await t.mutation(internal.metadata.applyAutomatic, {
    id,
    before: { ...before, title: 'Typed title' },
    changes: {},
    candidate: suggestion,
    status: 'matched',
  });
  expect(await doc(t, id)).toMatchObject({ metadataStatus: 'matched', metadataRecordingId: REC });
  expect((await doc(t, id))?.metadataSuggestion).toBeUndefined();
});

test('enrich stores the best weak candidate as the suggestion without another request (G5)', async () => {
  const { t, add } = await setup();
  const id = await add('alice', 'Original');
  vi.stubEnv('MUSICBRAINZ_ENABLED', 'true');
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    expect(String(url)).toContain('musicbrainz.org/ws/2/recording?');
    return Response.json({
      recordings: [
        {
          id: REC,
          title: 'Original',
          length: 260000, // a minute longer than the song: not strong
          score: 92,
          'artist-credit': [{ name: 'Artist' }],
          releases: [
            {
              id: REL,
              title: 'Album',
              status: 'Official',
              date: '1999-04-01',
              media: [{ position: 1, tracks: [{ position: 4, recording: { id: REC } }] }],
            },
          ],
        },
      ],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  await t.action(internal.metadataLookup.enrich, { id });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const song = await doc(t, id);
  expect(song?.metadataStatus).toBe('uncertain');
  expect(song?.metadataSuggestion).toMatchObject({
    recordingId: REC,
    releaseId: REL,
    title: 'Original',
    artist: 'Artist',
    album: 'Album',
    year: '1999',
    trackNumber: '4',
    score: 92,
  });
  // Nothing was applied from a weak candidate.
  expect(song?.metadataRecordingId).toBeUndefined();
});

test('enrich with no results is uncertain without a suggestion', async () => {
  const { t, add } = await setup();
  const id = await add();
  await t.run((ctx) => ctx.db.patch('songs', id, { metadataSuggestion: suggestion }));
  vi.stubEnv('MUSICBRAINZ_ENABLED', 'true');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ recordings: [] })));
  await t.action(internal.metadataLookup.enrich, { id });
  const song = await doc(t, id);
  expect(song?.metadataStatus).toBe('uncertain');
  expect(song?.metadataSuggestion).toBeUndefined();
});

test('updateEach applies a patch per song atomically (bulk Revert, G10)', async () => {
  const { t, alice, add } = await setup();
  const a = await add(),
    b = await add('alice', 'Second'),
    foreign = await add('bob');
  await alice.mutation(api.metadata.update, { ids: [a, b], changes: { genre: 'Jazz' } });
  await t.run((ctx) => ctx.db.patch('songs', b, { metadataLocks: ['genre', 'year'] }));
  const snapshot = [await doc(t, a), await doc(t, b)];
  // One foreign id, one invalid patch or a repeated id writes nothing at all.
  for (const items of [
    [{ id: a, changes: { genre: 'Rock' } }, { id: foreign, changes: { genre: 'Rock' } }],
    [{ id: a, changes: { genre: 'Rock' } }, { id: b, changes: { year: 'soon' } }],
    [{ id: a, changes: { genre: 'Rock' } }, { id: a, changes: { genre: 'Pop' } }],
    [{ id: a, changes: { genre: 'Rock' }, unlock: ['genre'] }, { id: b, changes: {}, unlock: ['nope'] }],
  ])
    expect(await codeOfCall(() => alice.mutation(api.metadata.updateEach, { items }))).toMatch(/invalid|not_found/);
  expect([await doc(t, a), await doc(t, b)]).toEqual(snapshot);
  expect(await codeOfCall(() => alice.mutation(api.metadata.updateEach, { items: [] }))).toBe('invalid');
  expect(
    await codeOfCall(() =>
      alice.mutation(api.metadata.updateEach, {
        items: Array.from({ length: 101 }, () => ({ id: a, changes: {} })),
      }),
    ),
  ).toBe('invalid');
  // Revert: each song gets its own original value back, and only the originally unlocked one unlocks.
  await alice.mutation(api.metadata.updateEach, {
    items: [
      { id: a, changes: { genre: '' }, unlock: ['genre'] },
      { id: b, changes: { genre: 'Blues' } },
    ],
  });
  expect(await doc(t, a)).toMatchObject({ genre: '', metadataLocks: [] });
  expect(await doc(t, b)).toMatchObject({ genre: 'Blues', metadataLocks: ['genre', 'year'] });
});

test('retry re-schedules the lookup through the shared limiter (G17)', async () => {
  const { t, alice, bob, add } = await setup();
  const id = await add();
  await t.run((ctx) => ctx.db.patch('songs', id, { metadataStatus: 'unavailable' }));
  expect(await codeOfCall(() => t.action(api.metadataLookup.retry, { id }))).toBe('not_signed_in');
  expect(await codeOfCall(() => bob.action(api.metadataLookup.retry, { id }))).toBe('not_found');
  expect(await codeOfCall(() => alice.action(api.metadataLookup.retry, { id }))).toBe('lookup_unavailable');
  expect((await doc(t, id))?.metadataStatus).toBe('unavailable');
  vi.stubEnv('MUSICBRAINZ_ENABLED', 'true');
  await alice.action(api.metadataLookup.retry, { id });
  expect((await doc(t, id))?.metadataStatus).toBe('pending');
  const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
  const enrich = scheduled.filter((f) => f.name.includes('enrich'));
  expect(enrich).toHaveLength(1);
  expect(enrich[0].args[0]).toEqual({ id });
  // The slot was taken from the shared MusicBrainz limiter.
  const slot = await t.run((ctx) =>
    ctx.db.query('metadataRequests').withIndex('by_key', (q) => q.eq('key', 'musicbrainz')).unique(),
  );
  expect(slot?.nextAt).toBeGreaterThan(Date.now());
  // A lookup already pending is not queued twice.
  await alice.action(api.metadataLookup.retry, { id });
  expect(
    (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).filter((f) =>
      f.name.includes('enrich'),
    ),
  ).toHaveLength(1);
  // A matched song keeps its match.
  await t.run((ctx) => ctx.db.patch('songs', id, { metadataStatus: 'matched' }));
  expect(await codeOfCall(() => alice.action(api.metadataLookup.retry, { id }))).toBe('invalid');
  // A long queue is refused as busy.
  await t.run(async (ctx) => {
    await ctx.db.patch('songs', id, { metadataStatus: 'unavailable' });
    await ctx.db.patch('metadataRequests', slot!._id, { nextAt: Date.now() + 60_000 });
  });
  expect(await codeOfCall(() => alice.action(api.metadataLookup.retry, { id }))).toBe('lookup_busy');
  expect((await doc(t, id))?.metadataStatus).toBe('unavailable');
});

test('field errors carry the field and labelled copy', async () => {
  const { alice, add } = await setup();
  const id = await add();
  const cases: [Record<string, unknown>, string, string][] = [
    [{ albumArtist: 'x'.repeat(501) }, 'albumArtist', 'Album artist is too long (500 characters max).'],
    [{ notes: 'x'.repeat(10001) }, 'notes', 'Notes are too long (10,000 characters max).'],
    [{ title: '  ' }, 'title', 'Enter a song title.'],
    [{ year: '99' }, 'year', 'Use a four-digit release year.'],
    [{ discNumber: '0' }, 'discNumber', 'Track and disc numbers must be positive whole numbers.'],
    [{ tags: ['x'.repeat(61)] }, 'tags', 'Use up to 30 tags, each at most 60 characters.'],
    [{ artwork: { kind: 'release', releaseId: 'nope' } }, 'artwork', 'Invalid cover selection.'],
  ];
  for (const [changes, field, message] of cases)
    expect(await errorOf(() => alice.mutation(api.metadata.update, { ids: [id], changes }))).toEqual({
      code: 'invalid',
      field,
      message,
    });
  expect(await errorOf(() => alice.action(api.metadataLookup.find, { id, title: 'x'.repeat(501), artist: '' }))).toMatchObject({
    code: 'invalid',
    field: 'title',
  });
});

test('a replaced upload stays restorable until it is retired (G11)', async () => {
  const { t, alice, add } = await setup();
  const id = await add();
  const upload = async () => {
    const row = await alice.mutation(internal.metadata.reserveArtwork, {
      id,
      bytes: 10,
      mime: 'image/jpeg',
      checksum: 'a'.repeat(43) + '=',
    });
    await alice.mutation(internal.metadata.verifiedArtwork, { objectId: row.objectId });
    await alice.mutation(api.metadata.update, { ids: [id], changes: { artwork: { kind: 'upload', key: row.key } } });
    return row;
  };
  const first = await upload(),
    second = await upload();
  const status = (objectId: Id<'audioObjects'>) => t.run(async (ctx) => (await ctx.db.get('audioObjects', objectId))?.status);
  expect(await status(first.objectId)).toBe('ready');
  // Revert to the first image while it is still kept.
  await alice.mutation(api.metadata.updateEach, { items: [{ id, changes: { artwork: { kind: 'upload', key: first.key } } }] });
  expect((await alice.query(api.songs.get, { id }))?.coverKey).toBe(first.key);
  // The deferred retirement skips the image the song shows again and retires the replaced one.
  await t.mutation(internal.metadata.retireArtwork, { id, key: first.key });
  await t.mutation(internal.metadata.retireArtwork, { id, key: second.key });
  expect(await status(first.objectId)).toBe('ready');
  expect(await status(second.objectId)).toBe('deleting');
  const retires = (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).filter((f) =>
    f.name.includes('retireArtwork'),
  );
  expect(retires.map((f) => f.args[0].key).sort()).toEqual([first.key, second.key].sort());
});

test('export-only accounts edit metadata but cannot upload artwork (D10)', async () => {
  const { t, alice, add } = await setup();
  const id = await add();
  await t.run((ctx) => ctx.db.insert('accountControls', { userId: 'alice', status: 'export_only', notes: '' }));
  await alice.mutation(api.metadata.update, { ids: [id], changes: { genre: 'Jazz' } });
  await alice.mutation(api.metadata.confirm, { id });
  expect((await doc(t, id))?.genre).toBe('Jazz');
  expect(
    await codeOfCall(() =>
      alice.mutation(internal.metadata.reserveArtwork, { id, bytes: 10, mime: 'image/png', checksum: 'a'.repeat(43) + '=' }),
    ),
  ).toBe('account_export_only');
});
