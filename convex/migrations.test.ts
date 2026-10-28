/// <reference types="vite/client" />
// convex/migrations.ts: the B1 upgrade (architecture §6.3, package BK1).
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { BACKFILL_BATCH } from './migrations';
import { emptyPractice, PRACTICE_CAP } from '../shared/practice';
import { defaultSongMap } from '../shared/song-map';
import { emptyScore } from '../shared/notation';

const modules = import.meta.glob('./**/*.ts');
afterEach(() => { vi.useRealTimers(); });

type NewSong = Omit<Doc<'songs'>, '_id' | '_creationTime'>;
const quality = { model: 'htdemucs', shifts: 0, overlap: 0.25, format: 'opus' as const };
/** A song row exactly as 1.9 wrote it: none of the 2.0 fields. */
const legacySong = (userId: string, extra: Partial<NewSong> = {}): NewSong =>
  ({ userId, title: 'Old song', duration: 60, addedAt: 1, stemMode: 'full', quality, stems: [], ...extra });
/** 1.9's `metronome.serialize()`: a 1.6–1.9 map without origin plus the dual-write and the click settings. */
function legacyTempo() {
  const songMap = defaultSongMap(60, 120);
  songMap.measures[0].label = 'Intro';
  songMap.measures[8].label = 'Verse';
  return { songMap, source: 'detected', detected: [], map: [], countIn: true, countInLength: 2, countInUnit: 'beats', enabled: true, accent: false, volume: 0.5, audiblePreRoll: true };
}
const v1Practice = { rate: 0.75, loop: { enabled: true, a: 16, b: 60 }, grid: { visible: true, snap: false, division: 2 }, tracks: [{ name: 'drums', volume: 0.5, muted: true, soloed: false }] };

function setup() {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  return { t, alice: t.withIdentity({ subject: 'alice' }) };
}
type T = ReturnType<typeof setup>['t'];
const songs = (t: T) => t.run(ctx => ctx.db.query('songs').collect());
const rows = (t: T) => t.run(ctx => ctx.db.query('songPractice').collect());
const scheduled = (t: T) => t.run(ctx => ctx.db.system.query('_scheduled_functions').collect());
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
async function addPart(t: T, songId: Id<'songs'>, hitCount: number) {
  const { bars: _bars, ...header } = emptyScore(60);
  await t.run(ctx => ctx.db.insert('notationParts', { songId, userId: 'alice', revision: 1, lastMutation: 'm', hitCount, header }));
}

describe('backfillB1', () => {
  test('moves practice into songPractice (with the click settings from tempo) and fills every summary', async () => {
    const { t } = setup();
    vi.setSystemTime(5_000);
    const tempo = legacyTempo();
    const [practised, charted, blank] = await t.run(async ctx => [
      await ctx.db.insert('songs', legacySong('alice', { title: 'Practised', tempo, practice: v1Practice })),
      await ctx.db.insert('songs', legacySong('alice', { title: 'Charted' })),
      await ctx.db.insert('songs', legacySong('bob', { title: 'Blank', tempo: { source: 'manual', map: [{ t: 0.5, bpm: 90, beatsPerBar: 3, unit: 4 }] } })),
    ]);
    await addPart(t, charted, 12);
    const result = await t.mutation(internal.migrations.backfillB1, { cursor: null });
    expect(result).toEqual({ processed: 3, upgraded: 3, done: true });
    const [row] = await rows(t);
    expect(row).toMatchObject({ songId: practised, userId: 'alice', updatedAt: 5_000 });
    expect(row.practice).toMatchObject({
      v: 2, rate: 0.75, loop: { on: true, a: 16, b: 60, eachPassCount: true, playTimes: 0, between: 'none' },
      tracks: [{ name: 'drums', volume: 0.5, muted: true, soloed: false }],
      click: { countIn: { on: true, length: 2, unit: 'beats' }, mode: 'always', accent: false, volume: 0.5, preRoll: true },
    });
    expect(row.practice).not.toHaveProperty('grid');
    const byTitle = new Map((await songs(t)).map(s => [s.title, s]));
    expect(byTitle.get('Practised')).toMatchObject({
      hasChart: false, mapSummary: { real: true, bpm: 120, meter: '4/4', sections: ['Intro', 'Verse'] },
      practiceSummary: { loopLabel: 'Verse loop', rate: 0.75, minusMe: false, spotCount: 0, spots: [] },
      // 1.9 data stays readable until V1.
      practice: v1Practice, tempo,
    });
    expect(byTitle.get('Practised')?.lastPracticedAt).toBeUndefined();
    expect(byTitle.get('Charted')).toMatchObject({ hasChart: true, mapSummary: { real: true, bpm: 120, meter: '4/4', sections: [] } });
    expect(byTitle.get('Charted')?.practiceSummary).toBeUndefined();
    expect(byTitle.get('Blank')).toMatchObject({ hasChart: false, mapSummary: { real: true, bpm: 90, meter: '3/4' } });
    expect(blank).toBeDefined();
  });

  test('is idempotent: a second run writes nothing, and a newer songPractice row is never replaced', async () => {
    const { t } = setup();
    const id = await t.run(ctx => ctx.db.insert('songs', legacySong('alice', { practice: v1Practice })));
    const newer = { ...emptyPractice(), rate: 0.5, lastAt: 42 };
    await t.run(ctx => ctx.db.insert('songPractice', { songId: id, userId: 'alice', practice: newer, updatedAt: 9 }));
    await addPart(t, id, 0);
    expect(await t.mutation(internal.migrations.backfillB1, { cursor: null })).toEqual({ processed: 1, upgraded: 1, done: true });
    const after = { songs: await songs(t), rows: await rows(t) };
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]).toMatchObject({ practice: newer, updatedAt: 9 });
    expect(after.songs[0]).toMatchObject({ hasChart: false, lastPracticedAt: 42, practiceSummary: { rate: 0.5 } });
    expect(await t.mutation(internal.migrations.backfillB1, { cursor: null })).toEqual({ processed: 1, upgraded: 0, done: true });
    expect({ songs: await songs(t), rows: await rows(t) }).toEqual(after);
  });

  test('pages 50 songs at a time and reschedules itself until done', async () => {
    const { t } = setup();
    await t.run(async ctx => {
      for (let i = 0; i < 2 * BACKFILL_BATCH + 7; i++) await ctx.db.insert('songs', legacySong(i % 2 ? 'alice' : 'bob', { addedAt: i, practice: { rate: 1 } }));
    });
    expect(await t.mutation(internal.migrations.backfillB1, { cursor: null })).toEqual({ processed: 50, upgraded: 50, done: false });
    expect((await songs(t)).filter(s => s.hasChart !== undefined)).toHaveLength(50);
    await drain(t);
    const all = await songs(t);
    expect(all.every(s => s.hasChart === false && s.mapSummary && s.practiceSummary)).toBe(true);
    expect(await rows(t)).toHaveLength(107);
    const runs = (await scheduled(t)).filter(f => f.name === 'migrations:backfillB1');
    expect(runs.map(f => f.state.kind)).toEqual(['success', 'success']);
  });

  test('prunes an oversized legacy blob to the cap instead of failing', async () => {
    const { t } = setup();
    vi.setSystemTime(Date.parse('2026-10-28T00:00:00Z'));
    const markers = Array.from({ length: 900 }, (_, i) => ({ id: `mk${i}`, t: i / 10, label: `Marker ${i}`, updatedAt: i }));
    const big = { ...emptyPractice(), markers };
    expect(JSON.stringify(big).length).toBeGreaterThan(PRACTICE_CAP);
    await t.run(ctx => ctx.db.insert('songs', legacySong('alice', { duration: 120, practice: big })));
    await t.mutation(internal.migrations.backfillB1, { cursor: null });
    const [row] = await rows(t);
    expect(JSON.stringify(row.practice).length).toBeLessThanOrEqual(PRACTICE_CAP);
    expect(row.practice.markers.length).toBeGreaterThan(0);
    expect(row.practice.markers.length).toBeLessThan(900);
  });
});

describe('self-running upgrade after a deploy', () => {
  test('an account’s first save schedules backfillUser, which upgrades only that account, newest first', async () => {
    const { t, alice } = setup();
    const ids = await t.run(async ctx => {
      const out: Id<'songs'>[] = [];
      for (let i = 0; i < BACKFILL_BATCH + 3; i++) out.push(await ctx.db.insert('songs', legacySong('alice', { addedAt: i, practice: v1Practice, tempo: legacyTempo() })));
      await ctx.db.insert('songs', legacySong('bob', { title: 'Bob' }));
      return out;
    });
    const newest = ids[ids.length - 1];
    await alice.mutation(api.songs.savePractice, { id: newest, practice: { ...emptyPractice(), rate: 0.6 } });
    expect((await scheduled(t)).map(f => [f.name, f.args])).toEqual([['migrations:backfillUser', [{ userId: 'alice', cursor: null }]]]);
    await drain(t);
    const all = await songs(t);
    expect(all.filter(s => s.userId === 'alice').every(s => s.hasChart === false && s.mapSummary?.real && s.practiceSummary)).toBe(true);
    expect(all.find(s => s.userId === 'bob')).not.toHaveProperty('hasChart');
    // The row the save wrote is newer than songs.practice and is kept.
    const saved = (await rows(t)).find(r => r.songId === newest);
    expect(saved?.practice).toMatchObject({ rate: 0.6 });
    expect(await rows(t)).toHaveLength(ids.length);
    // Upgraded: later saves schedule nothing.
    const before = (await scheduled(t)).length;
    await alice.mutation(api.songs.savePractice, { id: ids[0], practice: { ...emptyPractice(), rate: 0.7 }, final: true });
    await alice.mutation(api.songs.saveTempo, { id: ids[0], tempo: { songMap: defaultSongMap(60, 100) }, baseRev: 0 });
    expect((await scheduled(t)).length).toBe(before);
  });

  test('tempo and chart saves trigger it too, and reads still see 1.9 data before it runs', async () => {
    const { t, alice } = setup();
    const id = await t.run(ctx => ctx.db.insert('songs', legacySong('alice', { practice: v1Practice, tempo: legacyTempo() })));
    expect(await alice.query(api.songs.getPractice, { id })).toEqual(v1Practice);
    const [row] = (await alice.query(api.songs.list, {})).songs;
    expect(row.practiceSummary).toMatchObject({ loopLabel: 'Verse loop', rate: 0.75 });
    const map = defaultSongMap(60, 100);
    map.origin = 'tapped';
    await alice.mutation(api.songs.saveTempo, { id, tempo: { songMap: map }, baseRev: 0 });
    expect((await scheduled(t)).map(f => f.name)).toEqual(['migrations:backfillUser']);
    await drain(t);
    const song = (await songs(t))[0];
    // The tempo save's own map summary stands; the 1.9 click settings stay in tempo for upgradePractice.
    expect(song).toMatchObject({ hasChart: false, mapSummary: { real: true, bpm: 100 }, tempo: { countIn: true, countInLength: 2, songMap: map } });
    expect((await rows(t))[0].practice).toMatchObject({ v: 2, click: { countIn: { on: true, length: 2, unit: 'beats' }, mode: 'always' } });
  });
});
