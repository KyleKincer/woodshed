/// <reference types="vite/client" />
// convex/songs.ts and the B1/B2 parts of notation.ts (architecture §6.3, package BK1).
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { codeOf } from './lib/errors';
import { deletePart } from './notation';
import { summaryPatch, toListRow, reviewMetadataOf, nonMapFields } from './songs';
import { emptyPractice, PRACTICE_CAP, type PracticeV2 } from '../shared/practice';
import { defaultSongMap, type SongMapData } from '../shared/song-map';
import { emptyScore, fraction } from '../shared/notation';

const modules = import.meta.glob('./**/*.ts');
afterEach(() => { vi.useRealTimers(); });

type NewSong = Omit<Doc<'songs'>, '_id' | '_creationTime'>;
const quality = { model: 'htdemucs', shifts: 0, overlap: 0.25, format: 'opus' as const };
/** A song row as 2.0 leaves it after the B1 upgrade (so saves schedule no backfill). */
const songRow = (userId: string, extra: Partial<NewSong> = {}): NewSong => ({
  userId, title: 'Song', duration: 60, addedAt: 1, stemMode: 'full', quality,
  stems: [{ name: 'drums', key: `users/${userId}/s/drums.webm`, bytes: 10, mime: 'audio/webm' }],
  hasChart: false, mapSummary: { real: false, sections: [] },
  ...extra,
});
/** 60 s at 120 bpm in 4/4: 30 bars of 2 s; "Intro" bars 1–8 (0–16 s), "Verse" bars 9–30 (16–60 s). */
function realMap(): SongMapData {
  const map = defaultSongMap(60, 120);
  map.origin = 'edited';
  map.measures[0].label = 'Intro';
  map.measures[8].label = 'Verse';
  return map;
}
const placeholder = () => defaultSongMap(60, 120);
const practice = (patch: Partial<PracticeV2> = {}): PracticeV2 => ({ ...emptyPractice(), ...patch });
const loop = (a: number, b: number) => ({ on: true, a, b, eachPassCount: true, playTimes: 0 as const, between: 'none' as const });

function setup() {
  const t = convexTest(schema, modules);
  return { t, alice: t.withIdentity({ subject: 'alice' }), bob: t.withIdentity({ subject: 'bob' }) };
}
type T = ReturnType<typeof setup>['t'];
const insert = (t: T, row: NewSong) => t.run(ctx => ctx.db.insert('songs', row));
const read = (t: T, id: Id<'songs'>) => t.run(ctx => ctx.db.get('songs', id));
const practiceRows = (t: T) => t.run(ctx => ctx.db.query('songPractice').collect());
async function code(promise: Promise<unknown>) {
  try { await promise; } catch (error) { return codeOf(error); }
  throw new Error('expected a rejection');
}

describe('songs.list', () => {
  test('keeps the {songs} envelope, newest first, with slim rows only', async () => {
    const { t, alice, bob } = setup();
    const older = await insert(t, songRow('alice', {
      title: 'Older', artist: 'Band', notes: 'private notes', metadataLocks: ['title'], metadataRecordingId: 'rec', metadataReleaseId: 'rel',
      tempo: { songMap: realMap() }, practice: { rate: 0.5 }, addedAt: 1, year: '2001', tags: ['x'],
      artwork: { kind: 'release', releaseId: '0f0e0d0c-0b0a-4908-8706-050403020100' },
    }));
    const newer = await insert(t, songRow('alice', { title: 'Newer', addedAt: 2, hasChart: true, lastPracticedAt: 99 }));
    await insert(t, songRow('bob', { title: 'Bob' }));
    const result = await alice.query(api.songs.list, {});
    expect(Object.keys(result)).toEqual(['songs']);
    expect(result.songs.map((s: { id: string }) => s.id)).toEqual([newer, older]);
    const row = result.songs[1];
    for (const key of ['notes', 'tempo', 'practice', 'metadataLocks', 'metadataRecordingId', 'metadataReleaseId', 'metadataSuggestion', 'userId', 'fingerprint'])
      expect(row, key).not.toHaveProperty(key);
    expect(row).toMatchObject({
      id: older, title: 'Older', artist: 'Band', album: '', albumArtist: '', uploader: '', duration: 60, addedAt: 1, stemMode: 'full',
      stems: [{ name: 'drums', key: 'users/alice/s/drums.webm', bytes: 10, mime: 'audio/webm' }], coverKey: null,
      coverUrl: 'https://coverartarchive.org/release/0f0e0d0c-0b0a-4908-8706-050403020100/front-500',
      source: null, quality, year: '2001', genre: '', trackNumber: '', discNumber: '', musicalKey: '', tuning: '', tags: ['x'],
      metadataStatus: null, reviewMetadata: false, recordingUnconfirmed: false, suggestion: null, hasChart: false,
      lastPracticedAt: null, hasSectionSuggestion: false,
    });
    expect(result.songs[0]).toMatchObject({ hasChart: true, lastPracticedAt: 99, practiceSummary: null });
    expect((await bob.query(api.songs.list, {})).songs.map((s: { title: string }) => s.title)).toEqual(['Bob']);
    expect(await t.query(api.songs.list, {})).toEqual({ songs: [] });
  });

  test('carries the review flags, the metadata suggestion and the section suggestion flag', async () => {
    const { t, alice } = setup();
    const jobId = await t.run(ctx => ctx.db.insert('jobs', { userId: 'alice', kind: 'beats', label: 'x', status: 'done', stage: 'done', percent: 100, createdAt: 1, updatedAt: 1 }));
    const id = await insert(t, songRow('alice', {
      recordingUnconfirmed: true, metadataStatus: 'uncertain',
      metadataSuggestion: { recordingId: 'r1', releaseId: 'rel1', title: 'Real title', artist: 'Real artist', album: 'Real album', score: 80 },
      sectionSuggestion: { jobId, createdAt: 1, sections: [{ t0: 0, label: 'Intro', confidence: 0.5 }] },
    }));
    const [row] = (await alice.query(api.songs.list, {})).songs;
    expect(row).toMatchObject({ id, reviewMetadata: true, recordingUnconfirmed: true, hasSectionSuggestion: true,
      suggestion: { title: 'Real title', artist: 'Real artist', album: 'Real album', releaseId: 'rel1' } });
  });

  test('reviewMetadata: needsReview, an uncertain lookup, or an upload still named after its file (D43)', () => {
    const upload = (filename: string) => ({ type: 'upload' as const, value: 'k', filename });
    const cases: [Parameters<typeof reviewMetadataOf>[0], boolean][] = [
      [{ title: 'Song', needsReview: true }, true],
      [{ title: 'Song', metadataStatus: 'uncertain' }, true],
      [{ title: 'Song', metadataStatus: 'matched' }, false],
      [{ title: 'take_03.wav', source: upload('take_03.wav') }, true],
      [{ title: 'take_03', source: upload('C:\\Music\\take_03.wav') }, true],
      [{ title: 'take_03', source: upload('take_03.wav'), artist: 'Me' }, false],
      [{ title: 'My jam', source: upload('take_03.wav') }, false],
      [{ title: 'take_03.wav', source: { type: 'url', value: 'https://x.test/take_03.wav' } }, false],
      [{ title: 'Song' }, false],
    ];
    for (const [song, expected] of cases) expect(reviewMetadataOf(song), JSON.stringify(song)).toBe(expected);
  });

  test('a row the B1 upgrade has not reached gets its summaries computed on read', async () => {
    const { t, alice } = setup();
    // A 1.9 row: a 1.6–1.9 hand-made map without origin, and a v1 practice blob.
    const map = realMap();
    delete map.origin;
    const id = await insert(t, { userId: 'alice', title: 'Legacy', duration: 60, addedAt: 1, stemMode: 'full', quality, stems: [],
      tempo: { songMap: map, source: 'detected', detected: [], map: [] }, practice: { rate: 0.75, loop: { enabled: true, a: 16, b: 60 }, tracks: [] } });
    const [row] = (await alice.query(api.songs.list, {})).songs;
    expect(row.id).toBe(id);
    expect(row.mapSummary).toEqual({ real: true, bpm: 120, meter: '4/4', sections: ['Intro', 'Verse'] });
    expect(row.practiceSummary).toEqual({ loopLabel: 'Verse loop', rate: 0.75, minusMe: false, spotCount: 0, spots: [] });
    expect(row.hasChart).toBe(false);
    // Reading never writes.
    expect(await read(t, id)).not.toHaveProperty('mapSummary');
  });

  test('a 1,000-song library (mapped, with practice) lists in under 2 MB of JSON', async () => {
    const { t, alice } = setup();
    const tempo = { songMap: realMap() };
    const sections = ['Intro', 'Verse', 'Pre-chorus', 'Chorus', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro'];
    await t.run(async ctx => {
      for (let i = 0; i < 1000; i++) {
        const key = (name: string) => `users/alice/songs/k57d${String(i).padStart(4, '0')}x9q2m3n4/${name}.webm`;
        await ctx.db.insert('songs', {
          userId: 'alice', title: `A fairly long song title number ${i}`, artist: 'Some Artist Name', album: 'An Album Title (Deluxe Edition)',
          albumArtist: 'Some Artist Name', year: '2019', genre: 'Indie rock', trackNumber: '7', musicalKey: 'A minor', tuning: 'Standard', tags: ['setlist', 'drums'],
          duration: 240, addedAt: i, stemMode: 'full', quality: { ...quality, bitrate: 160 }, coverKey: `users/alice/covers/${i}.jpg`,
          source: { type: 'url', value: `https://www.youtube.com/watch?v=abcdefghij${i}` }, metadataStatus: 'matched',
          stems: ['drums', 'bass', 'vocals', 'other'].map(name => ({ name, key: key(name), bytes: 4_800_000, mime: 'audio/webm' })),
          tempo, practice: { rate: 0.8, loop: { enabled: true, a: 1, b: 2 }, tracks: [] }, notes: 'n'.repeat(400),
          hasChart: i % 3 === 0, lastPracticedAt: 1_700_000_000_000 + i, mapSummary: { real: true, bpm: 120, meter: '4/4', sections },
          practiceSummary: { loopLabel: 'Chorus 2 loop', rate: 0.85, minusMe: true, surface: 'chart', spotCount: 7,
            spots: [{ id: 'spot-aaaaaaaa-1', name: 'Fill into the chorus', rate: 0.8 }, { id: 'spot-aaaaaaaa-2', name: 'Verse groove', rate: 0.9 }, { id: 'spot-aaaaaaaa-3', name: 'Outro tag', rate: 1 }] },
        });
      }
    });
    const result = await alice.query(api.songs.list, {});
    expect(result.songs).toHaveLength(1000);
    expect(JSON.stringify(result).length).toBeLessThan(2_000_000);
  });
});

describe('songs.get, getPractice, getMany', () => {
  test('get returns the full song without practice, plus the tempo and review fields', async () => {
    const { t, alice, bob } = setup();
    const tempo = { songMap: realMap() };
    const id = await insert(t, songRow('alice', { tempo, practice: { rate: 0.5 }, notes: 'Mine', metadataLocks: ['title'] }));
    const song = await alice.query(api.songs.get, { id });
    expect(song).not.toHaveProperty('practice');
    expect(song).toMatchObject({ id, notes: 'Mine', metadataLocks: ['title'], tempo, tempoRev: 0, tempoSaveId: null,
      recordingUnconfirmed: false, sectionSuggestion: null, hasChart: false });
    await t.run(ctx => ctx.db.patch('songs', id, { tempoRev: 4, tempoSaveId: 'save-1', recordingUnconfirmed: true }));
    expect(await alice.query(api.songs.get, { id })).toMatchObject({ tempoRev: 4, tempoSaveId: 'save-1', recordingUnconfirmed: true });
    expect(await bob.query(api.songs.get, { id })).toBeNull();
    expect(await t.query(api.songs.get, { id })).toBeNull();
  });

  test('getPractice reads songPractice and falls back to the 1.9 songs.practice', async () => {
    const { t, alice, bob } = setup();
    const v1 = { rate: 0.75, loop: { enabled: true, a: 1, b: 2 } };
    const id = await insert(t, songRow('alice', { practice: v1 }));
    const none = await insert(t, songRow('alice'));
    expect(await alice.query(api.songs.getPractice, { id })).toEqual(v1);
    expect(await alice.query(api.songs.getPractice, { id: none })).toBeNull();
    const v2 = practice({ rate: 0.9 });
    await alice.mutation(api.songs.savePractice, { id, practice: v2 });
    expect(await alice.query(api.songs.getPractice, { id })).toEqual(v2);
    expect(await bob.query(api.songs.getPractice, { id })).toBeNull();
    expect(await t.query(api.songs.getPractice, { id })).toBeNull();
  });

  test('getMany returns the caller’s songs in order, omits missing and foreign ids, and is capped at 100', async () => {
    const { t, alice, bob } = setup();
    const a = await insert(t, songRow('alice', { title: 'A' }));
    const b = await insert(t, songRow('alice', { title: 'B', practice: { rate: 1 } }));
    const foreign = await insert(t, songRow('bob', { title: 'Bob' }));
    const gone = await insert(t, songRow('alice', { title: 'Gone' }));
    await t.run(ctx => ctx.db.delete('songs', gone));
    const many = await alice.query(api.songs.getMany, { ids: [b, foreign, gone, a, b] });
    expect(many.map((s: { title: string }) => s.title)).toEqual(['B', 'A']);
    expect(many[0]).not.toHaveProperty('practice');
    expect(many[0]).toHaveProperty('metadataLocks');
    expect(await bob.query(api.songs.getMany, { ids: [a] })).toEqual([]);
    expect(await t.query(api.songs.getMany, { ids: [a] })).toEqual([]);
    expect(await code(alice.query(api.songs.getMany, { ids: [] }))).toBe('invalid');
    expect(await code(alice.query(api.songs.getMany, { ids: Array(101).fill(a) }))).toBe('invalid');
    expect(await alice.query(api.songs.getMany, { ids: Array(100).fill(a) })).toHaveLength(1);
  });
});

describe('songs.savePractice (B1, B2)', () => {
  test('a non-final save upserts songPractice and never patches the song', async () => {
    const { t, alice } = setup();
    const id = await insert(t, songRow('alice', { tempo: { songMap: realMap() }, practiceSummary: { rate: 1, minusMe: false, spotCount: 0, spots: [] } }));
    const before = await read(t, id);
    await alice.mutation(api.songs.savePractice, { id, practice: practice({ rate: 0.5, loop: loop(16, 60), lastAt: 5 }) });
    await alice.mutation(api.songs.savePractice, { id, practice: practice({ rate: 0.6, lastAt: 6 }), final: false });
    expect(await read(t, id)).toEqual(before);
    const rows = await practiceRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ songId: id, userId: 'alice', practice: { rate: 0.6 } });
  });

  test('saving the same content again is a no-op', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1000);
    const { t, alice } = setup();
    const id = await insert(t, songRow('alice'));
    const value = practice({ rate: 0.5 });
    await alice.mutation(api.songs.savePractice, { id, practice: value });
    vi.setSystemTime(5000);
    await alice.mutation(api.songs.savePractice, { id, practice: JSON.parse(JSON.stringify(value)) });
    expect((await practiceRows(t))[0].updatedAt).toBe(1000);
    await alice.mutation(api.songs.savePractice, { id, practice: { ...value, cue: 3 } });
    expect((await practiceRows(t))[0].updatedAt).toBe(5000);
  });

  test('a final save writes the summary and lastPracticedAt, labelling loops by section, bars or time', async () => {
    const { t, alice } = setup();
    const mapped = await insert(t, songRow('alice', { tempo: { songMap: realMap() }, hasChart: false }));
    const unmapped = await insert(t, songRow('alice', { tempo: { songMap: placeholder() } }));
    const spot = (n: number, lastAt?: number) => ({ id: `s${n}`, name: `Spot ${n}`, a: 0, b: 2, rate: 0.5 + n / 10, passes: 1, updatedAt: n, ...(lastAt ? { lastAt } : {}) });
    const save = (id: Id<'songs'>, p: PracticeV2) => alice.mutation(api.songs.savePractice, { id, practice: p, final: true });
    await save(mapped, practice({ loop: loop(16, 60), rate: 0.8, minusMe: true, surface: 'roadmap', lastAt: 1234,
      spots: [spot(1, 10), spot(2), spot(3, 30), spot(4, 20), { ...spot(5, 40), deleted: true }] }));
    expect(await read(t, mapped)).toMatchObject({ lastPracticedAt: 1234, practiceSummary: {
      loopLabel: 'Verse loop', rate: 0.8, minusMe: true, surface: 'roadmap', spotCount: 4,
      spots: [{ id: 's3', name: 'Spot 3', rate: 0.8 }, { id: 's4', name: 'Spot 4', rate: 0.9 }, { id: 's1', name: 'Spot 1', rate: 0.6 }] } });
    await save(mapped, practice({ loop: loop(2, 6), lastAt: 2000 }));
    expect((await read(t, mapped))?.practiceSummary?.loopLabel).toBe('Bars 2–3 loop');
    await save(unmapped, practice({ loop: loop(2, 6) }));
    expect(await read(t, unmapped)).toMatchObject({ practiceSummary: { loopLabel: '0:02–0:06 loop' } });
    expect((await read(t, unmapped))?.lastPracticedAt).toBeUndefined();
  });

  test('a final save patches the song only when the summary or lastPracticedAt changed', async () => {
    const { t } = setup();
    const id = await insert(t, songRow('alice', { tempo: { songMap: realMap() } }));
    const song = (await read(t, id))!;
    const first = practice({ loop: loop(16, 60), lastAt: 10 });
    const patch = summaryPatch(song, first);
    expect(patch).toEqual({ lastPracticedAt: 10, practiceSummary: { loopLabel: 'Verse loop', rate: 1, minusMe: false, spotCount: 0, spots: [] } });
    const saved = { ...song, ...patch! };
    // The cue, the mix and spot notes are not in the summary.
    expect(summaryPatch(saved, { ...first, cue: 40, tracks: [{ name: 'drums', volume: 0.5, muted: true, soloed: false }] })).toBeNull();
    // A save without lastAt keeps the stored lastPracticedAt.
    expect(summaryPatch(saved, { ...first, lastAt: undefined })).toBeNull();
    expect(summaryPatch(saved, { ...first, lastAt: 11 })).toEqual({ lastPracticedAt: 11, practiceSummary: saved.practiceSummary });
    expect(summaryPatch(saved, { ...first, rate: 0.5 })?.practiceSummary?.rate).toBe(0.5);
  });

  test('32,768 characters are accepted and 32,769 are rejected with practice_too_large (B2)', async () => {
    const { t, alice } = setup();
    const id = await insert(t, songRow('alice'));
    const sized = (length: number) => {
      const value = { ...practice(), pad: '' };
      value.pad = 'x'.repeat(length - JSON.stringify(value).length);
      expect(JSON.stringify(value).length).toBe(length);
      return value;
    };
    await alice.mutation(api.songs.savePractice, { id, practice: sized(PRACTICE_CAP) });
    expect(PRACTICE_CAP).toBe(32_768);
    const error = await alice.mutation(api.songs.savePractice, { id, practice: sized(PRACTICE_CAP + 1), final: true }).catch(e => e);
    expect(codeOf(error)).toBe('practice_too_large');
    expect(JSON.stringify((await practiceRows(t))[0].practice).length).toBe(PRACTICE_CAP);
  });

  test('ownership, validation and account states', async () => {
    const { t, alice, bob } = setup();
    const id = await insert(t, songRow('alice'));
    expect(await code(bob.mutation(api.songs.savePractice, { id, practice: practice() }))).toBe('not_owner');
    expect(await code(t.mutation(api.songs.savePractice, { id, practice: practice() }))).toBe('not_signed_in');
    expect(await code(alice.mutation(api.songs.savePractice, { id, practice: null }))).toBe('invalid');
    expect(await code(alice.mutation(api.songs.savePractice, { id, practice: [1] }))).toBe('invalid');
    await t.run(ctx => ctx.db.insert('accountControls', { userId: 'alice', status: 'export_only', notes: '' }));
    await alice.mutation(api.songs.savePractice, { id, practice: practice({ rate: 0.7 }), final: true });
    expect((await read(t, id))?.practiceSummary?.rate).toBe(0.7);
    await t.run(async ctx => {
      const row = await ctx.db.query('accountControls').withIndex('by_userId', q => q.eq('userId', 'alice')).unique();
      await ctx.db.patch('accountControls', row!._id, { status: 'suspended' });
    });
    expect(await code(alice.mutation(api.songs.savePractice, { id, practice: practice() }))).toBe('account_suspended');
  });
});

describe('songs.saveTempo', () => {
  test('writes only the map, keeps the 1.9 click fields, bumps tempoRev and stores the save id', async () => {
    const { t, alice } = setup();
    const click = { countIn: true, countInLength: 2, countInUnit: 'bars', enabled: false, accent: true, volume: 0.8, audiblePreRoll: false };
    const id = await insert(t, songRow('alice', { tempo: { ...click, source: 'detected', detected: [{ time: 0, downbeat: true }], map: [] } }));
    const map = realMap();
    const result = await alice.mutation(api.songs.saveTempo, { id, tempo: { songMap: map, source: 'detected', countIn: false }, baseRev: 0, saveId: 'save-1' });
    expect(result).toEqual({ tempoRev: 1, conflict: false });
    const song = (await read(t, id))!;
    expect(song.tempo).toEqual({ ...click, songMap: map });
    expect(song).toMatchObject({ tempoRev: 1, tempoSaveId: 'save-1', mapSummary: { real: true, bpm: 120, meter: '4/4', sections: ['Intro', 'Verse'] } });
    // The same content again: no write, no bump.
    expect(await alice.mutation(api.songs.saveTempo, { id, tempo: { songMap: JSON.parse(JSON.stringify(map)) }, baseRev: 1, saveId: 'save-2' })).toEqual({ tempoRev: 1, conflict: false });
    expect((await read(t, id))?.tempoSaveId).toBe('save-1');
    // A save without an id clears the stored one.
    const moved = realMap();
    moved.pins[0].time = 0.5;
    expect(await alice.mutation(api.songs.saveTempo, { id, tempo: { songMap: moved }, baseRev: 1 })).toEqual({ tempoRev: 2, conflict: false });
    expect((await read(t, id))?.tempoSaveId).toBeUndefined();
    expect(nonMapFields({ songMap: 1, source: 2, map: 3, detected: 4, volume: 0.5 })).toEqual({ volume: 0.5 });
  });

  test('a stale save keeps a real map and returns the stored tempo as a conflict', async () => {
    const { t, alice } = setup();
    const id = await insert(t, songRow('alice', { tempo: { songMap: realMap() }, tempoRev: 3 }));
    const stored = (await read(t, id))!.tempo;
    const conflict = await alice.mutation(api.songs.saveTempo, { id, tempo: { songMap: placeholder() }, baseRev: 2, saveId: 'stale' });
    expect(conflict).toEqual({ tempoRev: 3, conflict: true, tempo: stored });
    expect(await read(t, id)).toMatchObject({ tempo: stored, tempoRev: 3 });
    expect((await read(t, id))?.tempoSaveId).toBeUndefined();
    // A stale save of another real map is a normal write; so is a current save of the placeholder.
    const other = realMap();
    other.measures[4].label = 'Groove';
    expect(await alice.mutation(api.songs.saveTempo, { id, tempo: { songMap: other }, baseRev: 1 })).toEqual({ tempoRev: 4, conflict: false });
    expect(await alice.mutation(api.songs.saveTempo, { id, tempo: { songMap: placeholder() }, baseRev: 4 })).toEqual({ tempoRev: 5, conflict: false });
    expect((await read(t, id))?.mapSummary).toEqual({ real: false, sections: [] });
  });

  test('clears the section suggestion once the map has sections', async () => {
    const { t, alice } = setup();
    const jobId = await t.run(ctx => ctx.db.insert('jobs', { userId: 'alice', kind: 'beats', label: 'x', status: 'done', stage: 'done', percent: 100, createdAt: 1, updatedAt: 1 }));
    const sectionSuggestion = { jobId, createdAt: 1, sections: [{ t0: 0, label: 'Intro', confidence: 0.7 }] };
    const id = await insert(t, songRow('alice', { tempo: { songMap: placeholder() }, sectionSuggestion }));
    const unlabelled = placeholder();
    unlabelled.origin = 'detected';
    await alice.mutation(api.songs.saveTempo, { id, tempo: { songMap: unlabelled }, baseRev: 0 });
    expect((await read(t, id))?.sectionSuggestion).toEqual(sectionSuggestion);
    await alice.mutation(api.songs.saveTempo, { id, tempo: { songMap: realMap() }, baseRev: 1 });
    expect((await read(t, id))?.sectionSuggestion).toBeUndefined();
  });

  test('a chart counts for the map summary; invalid maps, save ids and foreign songs are refused', async () => {
    const { t, alice, bob } = setup();
    const id = await insert(t, songRow('alice', { hasChart: true }));
    await alice.mutation(api.songs.saveTempo, { id, tempo: { songMap: placeholder() }, baseRev: 0 });
    expect((await read(t, id))?.mapSummary).toMatchObject({ real: true, bpm: 120, meter: '4/4', sections: [] });
    expect(await code(alice.mutation(api.songs.saveTempo, { id, tempo: { map: [{ t: 0, bpm: 90, beatsPerBar: 4, unit: 4 }] } }))).toBe('invalid');
    expect(await code(alice.mutation(api.songs.saveTempo, { id, tempo: null }))).toBe('invalid');
    expect(await code(alice.mutation(api.songs.saveTempo, { id, tempo: { songMap: { ...placeholder(), pins: [] } } }))).toBe('invalid');
    expect(await code(alice.mutation(api.songs.saveTempo, { id, tempo: { songMap: realMap() }, saveId: 'x'.repeat(101) }))).toBe('invalid');
    expect(await code(bob.mutation(api.songs.saveTempo, { id, tempo: { songMap: realMap() } }))).toBe('not_owner');
    await t.run(ctx => ctx.db.insert('accountControls', { userId: 'alice', status: 'export_only', notes: '' }));
    expect(await alice.mutation(api.songs.saveTempo, { id, tempo: { songMap: realMap() }, baseRev: 1 })).toEqual({ tempoRev: 2, conflict: false });
  });
});

describe('hasChart follows the drum part', () => {
  async function chartSetup() {
    const { t, alice } = setup();
    const songId = await insert(t, songRow('alice', { hasChart: undefined }));
    const score = emptyScore(20);
    const { bars, ...header } = score;
    const measureId = score.timeline.measures[0].id;
    const save = (n: number, bar: object) => alice.mutation(api.notation.save, { songId, baseRevision: n, mutationId: `m${n}`, header, bars: [bar as never] });
    const hit = { id: 'h1', offset: fraction(0), instrument: 'snare', voice: 1, accent: false, ghost: false, flam: false, sticking: '', velocity: 0.75 };
    return { t, alice, songId, measureId, save, hit, bars };
  }

  test('notation.save sets it for hits or a reviewed bar and clears it when the part empties', async () => {
    const { t, songId, measureId, save, hit } = await chartSetup();
    await save(0, { measureId, coverage: 'progress', hits: [] });
    expect((await read(t, songId))?.hasChart).toBe(false);
    await save(1, { measureId, coverage: 'progress', hits: [hit] });
    expect((await read(t, songId))?.hasChart).toBe(true);
    await save(2, { measureId, coverage: 'reviewed', hits: [] });
    expect((await read(t, songId))?.hasChart).toBe(true);
    await save(3, { measureId, coverage: 'unstarted', hits: [] });
    expect((await read(t, songId))?.hasChart).toBe(false);
  });

  test('deleting the part clears it; removing the song deletes the part', async () => {
    const { t, alice, songId, measureId, save, hit } = await chartSetup();
    await save(0, { measureId, coverage: 'progress', hits: [hit] });
    const part = await t.run(ctx => ctx.db.query('notationParts').withIndex('by_songId', q => q.eq('songId', songId)).unique());
    await t.run(ctx => deletePart(ctx, part!._id));
    expect((await read(t, songId))?.hasChart).toBe(false);
    await save(0, { measureId, coverage: 'progress', hits: [hit] });
    await alice.mutation(api.songs.remove, { id: songId });
    expect(await t.run(ctx => ctx.db.query('notationParts').collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.query('notationBars').collect())).toEqual([]);
  });

  test('notation.save accepts export-only accounts (D10)', async () => {
    const { t, songId, measureId, save, hit } = await chartSetup();
    await t.run(ctx => ctx.db.insert('accountControls', { userId: 'alice', status: 'export_only', notes: '' }));
    expect(await save(0, { measureId, coverage: 'progress', hits: [hit] })).toEqual({ revision: 1 });
    expect((await read(t, songId))?.hasChart).toBe(true);
  });
});

describe('songs.remove, confirmRecording, dismissSectionSuggestion, exportPage', () => {
  test('deleteSongData removes the practice row and strips the song from setlists and pins', async () => {
    const { t, alice } = setup();
    const doomed = await insert(t, songRow('alice', { title: 'Doomed' }));
    const kept = await insert(t, songRow('alice', { title: 'Kept' }));
    const bobs = await insert(t, songRow('bob', { title: 'Bob' }));
    await alice.mutation(api.songs.savePractice, { id: doomed, practice: practice({ rate: 0.5 }) });
    await alice.mutation(api.songs.savePractice, { id: kept, practice: practice({ rate: 0.6 }) });
    await t.run(async ctx => {
      await ctx.db.insert('setlists', { userId: 'alice', name: 'Gig', songIds: [kept, doomed, kept], createdAt: 1, updatedAt: 5 });
      await ctx.db.insert('setlists', { userId: 'alice', name: 'Other', songIds: [kept], createdAt: 1, updatedAt: 6 });
      await ctx.db.insert('setlists', { userId: 'bob', name: 'Bob list', songIds: [bobs], createdAt: 1, updatedAt: 7 });
      await ctx.db.insert('userSettings', { userId: 'alice', settings: { preset: 'fast', pins: [doomed, kept] } });
    });
    expect(await alice.mutation(api.songs.remove, { id: doomed })).toBe(true);
    expect(await read(t, doomed)).toBeNull();
    expect((await practiceRows(t)).map(r => r.songId)).toEqual([kept]);
    const lists = await t.run(ctx => ctx.db.query('setlists').collect());
    expect(lists.map(l => [l.name, l.songIds, l.updatedAt])).toEqual([['Gig', [kept, kept], 5], ['Other', [kept], 6], ['Bob list', [bobs], 7]]);
    const settings = await t.run(ctx => ctx.db.query('userSettings').collect());
    expect(settings[0].settings).toEqual({ preset: 'fast', pins: [kept] });
    expect(await code(alice.mutation(api.songs.remove, { id: bobs }))).toBe('not_owner');
    expect(await code(alice.mutation(api.songs.remove, { id: doomed }))).toBe('not_found');
  });

  test('confirmRecording and dismissSectionSuggestion clear their flags for the owner only', async () => {
    const { t, alice, bob } = setup();
    const jobId = await t.run(ctx => ctx.db.insert('jobs', { userId: 'alice', kind: 'beats', label: 'x', status: 'done', stage: 'done', percent: 100, createdAt: 1, updatedAt: 1 }));
    const id = await insert(t, songRow('alice', { recordingUnconfirmed: true, needsReview: true, sectionSuggestion: { jobId, createdAt: 1, sections: [] } }));
    expect(await code(bob.mutation(api.songs.confirmRecording, { id }))).toBe('not_owner');
    expect(await code(bob.mutation(api.songs.dismissSectionSuggestion, { id }))).toBe('not_owner');
    await alice.mutation(api.songs.confirmRecording, { id });
    let song = (await read(t, id))!;
    expect(song.recordingUnconfirmed).toBeUndefined();
    expect(song.needsReview).toBe(true);
    expect(song.sectionSuggestion).toBeDefined();
    await alice.mutation(api.songs.dismissSectionSuggestion, { id });
    song = (await read(t, id))!;
    expect(song.sectionSuggestion).toBeUndefined();
    await alice.mutation(api.songs.confirmRecording, { id });
    expect(await alice.query(api.songs.get, { id })).toMatchObject({ recordingUnconfirmed: false, sectionSuggestion: null });
  });

  test('exportPage joins practice from songPractice, else the 1.9 songs.practice', async () => {
    const { t, alice, bob } = setup();
    const v1 = { rate: 0.5, loop: { enabled: true, a: 1, b: 2 } };
    const legacy = await insert(t, songRow('alice', { title: 'Legacy', practice: v1 }));
    const moved = await insert(t, songRow('alice', { title: 'Moved', practice: v1 }));
    const none = await insert(t, songRow('alice', { title: 'None' }));
    const v2 = practice({ rate: 0.9 });
    await alice.mutation(api.songs.savePractice, { id: moved, practice: v2 });
    const page = await alice.query(api.songs.exportPage, { paginationOpts: { cursor: null, numItems: 10 } });
    const byId = new Map(page.page.map((s: { id: string }) => [s.id, s]));
    expect(byId.get(legacy)).toMatchObject({ title: 'Legacy', practice: v1, notes: '' });
    expect(byId.get(moved)).toMatchObject({ practice: v2 });
    expect(byId.get(none)).toMatchObject({ practice: null });
    expect(page.isDone).toBe(true);
    expect((await bob.query(api.songs.exportPage, { paginationOpts: { cursor: null, numItems: 10 } })).page).toEqual([]);
  });
});

test('toListRow omits optional stem fields that are absent', () => {
  const row = toListRow({ _id: 'x' as Id<'songs'>, _creationTime: 0, ...songRow('alice', { stems: [{ name: 'drums', key: 'k' }] }) });
  expect(row.stems).toEqual([{ name: 'drums', key: 'k' }]);
});
