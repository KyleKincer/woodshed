/// <reference types="vite/client" />
// Sharing v2 (architecture §6.7, package BK5): what a link carries, how its
// owner is named, and how a saved copy is committed. Practice and tempo are
// read straight from the tables (`songPractice`, `songs.tempo`) so these
// tests do not depend on the shape of `songs.get`.
import {convexTest} from 'convex-test';
import {expect, test, vi, beforeEach, afterEach} from 'vitest';
import schema from './schema';
import {api, internal} from './_generated/api';
import type {Id} from './_generated/dataModel';
import {emptyScore, upgradeScore} from '../shared/notation';
import {defaultSongMap, hasRealMap, type SongMapData} from '../shared/song-map';
import {ownerNameOf, sharedTempo, sharedPractice, ANONYMOUS_OWNER, UNAVAILABLE} from './sharing';
import sharingSource from './sharing.ts?raw';

const remote = vi.hoisted(() => ({objects: new Map<string, {ContentLength: number, ContentType: string, ETag: string}>(), copyHook: null as null | (() => Promise<void>), copies: 0}));
vi.mock('./r2', () => ({r2: {config: {bucket: 'test'}, getUrl: vi.fn(async (key: string) => 'https://storage.test/' + key), deleteObject: vi.fn(async () => {}), client: {send: vi.fn(async (command: any) => {
  const {Key, CopySource, CopySourceIfMatch} = command.input;
  if (command.constructor.name === 'HeadObjectCommand') { const head = remote.objects.get(Key); if (!head) throw Error('Missing file'); return head; }
  if (command.constructor.name === 'CopyObjectCommand') {
    remote.copies++; if (remote.copyHook) await remote.copyHook();
    const head = remote.objects.get(decodeURIComponent(CopySource.slice(5))); if (!head || head.ETag !== CopySourceIfMatch) throw Error('Source changed');
    const copied = {...head, ETag: 'copied-' + head.ETag}; remote.objects.set(Key, copied); return {CopyObjectResult: {ETag: copied.ETag}};
  }
  throw Error('Unexpected storage operation');
})}}}));
const modules = import.meta.glob('./**/*.ts');
const quality = {model: 'htdemucs', shifts: 0, overlap: .25, format: 'opus' as const};
const NOW = Date.parse('2026-10-28T09:00:00Z');
beforeEach(() => { remote.objects.clear(); remote.copyHook = null; remote.copies = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

/** 1.9 data: a v1 practice and a pre-1.6 tempo carrying the 1.x click settings. */
const LEGACY_TEMPO = {map: [{t: 0, bpm: 97, beatsPerBar: 7, unit: 8, notes: 'private'}], detected: [{time: 1, downbeat: true}], countIn: true, countInLength: 2, countInUnit: 'bars', audiblePreRoll: false, notes: 'private'};
const V1_PRACTICE = {rate: .75, loop: {enabled: true, a: 10, b: 20}, grid: {visible: true, snap: true, division: 2}, tracks: [{name: 'drums', volume: .5, muted: true, soloed: false}], notes: 'private'};

/** 120 bpm 4/4 (2 s bars) with sections Start (bars 1–4), Chorus (5–8), Verse (9–). */
function sectionMap(duration = 120, origin: SongMapData['origin'] = 'edited'): SongMapData {
  const map = defaultSongMap(duration);
  map.measures[4].label = 'Chorus';
  map.measures[8].label = 'Verse';
  return origin ? {...map, origin} : map;
}

/** A v2 practice with everything `sanitizeForShare` must strip or keep. */
function v2Practice(map: SongMapData) {
  const ref = (i: number) => ({id: map.measures[i].id, beat: 0});
  return {
    v: 2, lastAt: NOW - 1000, cue: 8, surface: 'roadmap', rate: .9, lastRate: 1, keepPitch: true,
    loop: {on: true, a: 8, b: 16, aBar: ref(4), bBar: ref(8), eachPassCount: true, playTimes: 4, between: 'rest'},
    tracks: [{name: 'drums', volume: 1, muted: true, soloed: false}],
    minusMe: true, onlyMe: true, chartAudio: 'quiet',
    click: {countIn: {on: true, length: 1, unit: 'bars'}, mode: 'always', lastMode: 'countin', accent: true, volume: .6, preRoll: false},
    trainer: {start: .7, end: 1, step: .05, passes: 2},
    spots: [
      {id: 'sp1', name: 'Chorus fill', a: 14, b: 16, aBar: ref(7), bBar: ref(8), rate: .8, note: 'left hand into the crash', lastAt: NOW - 5000, passes: 14, updatedAt: NOW - 5000},
      {id: 'sp2', name: 'Old idea', a: 0, b: 2, rate: 1, passes: 0, updatedAt: NOW - 9000, deleted: true},
    ],
    markers: [
      {id: 'mk1', t: 31.2, label: 'Snare roll', updatedAt: NOW - 3000},
      {id: 'mk2', t: 50, label: 'Cut', updatedAt: NOW - 3000, deleted: true},
    ],
  };
}

type Options = {name?: string | null, email?: string, tempo?: unknown, practice?: unknown, songPractice?: unknown, songPracticeOnly?: boolean};
async function setup(options: Options = {}) {
  const t = convexTest(schema, modules);
  const {name = 'Kyle Kincer', email = 'kyle@example.com'} = options;
  const owner = await t.run(ctx => ctx.db.insert('users', {email, emailVerified: true, createdAt: 1, ...(name === null ? {} : {name})}));
  const alice = t.withIdentity({subject: owner}), bob = t.withIdentity({subject: 'bob'});
  const songId = await t.run(async ctx => {
    const stems = [{name: 'drums', key: 'private/audio drums', bytes: 100, mime: 'audio/webm'}, {name: 'bass', key: 'private/bass', bytes: 100, mime: 'audio/webm'}];
    const id = await ctx.db.insert('songs', {userId: owner, title: 'Shared song', artist: 'Artist', duration: 120, stemMode: 'full', quality, stems, coverKey: 'private/cover', addedAt: 1,
      source: {type: 'upload', value: '/private/original.wav'}, notes: 'Private note', tags: ['private tag'],
      tempo: 'tempo' in options ? options.tempo : LEGACY_TEMPO,
      ...(options.songPracticeOnly ? {} : {practice: 'practice' in options ? options.practice : V1_PRACTICE}),
    });
    if (options.songPractice !== undefined) await ctx.db.insert('songPractice', {songId: id, userId: owner, practice: options.songPractice, updatedAt: 1});
    for (const f of [...stems, {name: 'cover', key: 'private/cover', bytes: 10, mime: 'image/png'}]) {
      await ctx.db.insert('audioObjects', {userId: owner, songId: id, key: f.key, name: f.name, bytes: f.bytes, mime: f.mime, checksum: '', expiresAt: 0, status: 'ready'});
      remote.objects.set(f.key, {ContentLength: f.bytes, ContentType: f.mime, ETag: f.name});
    }
    await ctx.db.insert('storageUsage', {scope: 'app', bytes: 210}); await ctx.db.insert('storageUsage', {scope: `user:${owner}`, bytes: 210});
    return id;
  });
  const {token} = await alice.mutation(api.sharing.create, {id: songId});
  return {t, alice, bob, owner, songId, token};
}
type T = Awaited<ReturnType<typeof setup>>['t'];
/** Writes a stored tempo as any client version may have left it (no validation, as 1.x rows). */
const setTempo = (t: T, id: Id<'songs'>, tempo: unknown) => t.run(ctx => ctx.db.patch('songs', id, {tempo}));
const songRow = (t: T, id: Id<'songs'>) => t.run(ctx => ctx.db.get('songs', id));
const practiceRows = (t: T, id: Id<'songs'>) => t.run(ctx => ctx.db.query('songPractice').withIndex('by_songId', q => q.eq('songId', id)).take(10));
const codeOf = (promise: Promise<unknown>) => promise.then(() => null, (e: any) => e?.data?.code ?? null);

// ---- what a link carries ----

test('public links expose only the song and practice setup; private and arbitrary files remain protected', async () => {
  const {t, bob, owner, songId, token} = await setup();
  const view = await t.query(api.sharing.view, {token});
  expect(view?.tempo).toEqual({map: [{t: 0, bpm: 97, beatsPerBar: 7, unit: 8}], detected: [{time: 1, downbeat: true}]});
  expect(JSON.stringify(view)).not.toMatch(/private|kyle@|Kincer/);
  expect(JSON.stringify(view)).not.toContain(owner);
  expect(view?.stems[0].key).toBe('stem-0');
  expect(view?.coverKey).toBe('cover');
  await expect(t.mutation(api.sharing.create, {id: songId})).rejects.toThrow('Not signed in');
  expect(await codeOf(bob.mutation(api.sharing.create, {id: songId}))).toBe('not_found');
  expect(await codeOf(bob.query(api.sharing.status, {id: songId}))).toBe('not_found');
  expect(await codeOf(bob.mutation(api.sharing.revoke, {id: songId}))).toBe('not_owner');
  await expect(bob.mutation(api.sharing.revoke, {id: songId})).rejects.toThrow('Not your');
  expect(await bob.query(internal.media.authorizedKeys, {keys: ['private/bass']})).toEqual([]);
  expect(await t.query(api.sharing.view, {token: 'invalid'})).toBeNull();
});

test('a v1 source shares its loop, rate and mix, and its 1.x click settings move from tempo into practice', async () => {
  const {t, token} = await setup();
  const view = await t.query(api.sharing.view, {token});
  expect(view?.practice).toMatchObject({v: 2, rate: .75, loop: {on: true, a: 10, b: 20, eachPassCount: true, playTimes: 0, between: 'none'},
    tracks: [{name: 'drums', volume: .5, muted: true, soloed: false}], minusMe: false, spots: [], markers: [],
    click: {countIn: {on: true, length: 2, unit: 'bars'}, mode: 'countin', preRoll: false}});
  expect(view?.practice).not.toHaveProperty('grid');
  expect(view?.practice).not.toHaveProperty('notes');
  expect(view?.tempo).not.toHaveProperty('countIn');
  expect(view?.tempo).not.toHaveProperty('countInLength');
});

test('a v2 source shares spots, markers and click without notes, history, tombstones or Minus me', async () => {
  const map = sectionMap();
  const {t, token} = await setup({tempo: {songMap: map}, songPractice: v2Practice(map), practice: V1_PRACTICE});
  const {practice, tempo} = (await t.query(api.sharing.view, {token}))!;
  // songPractice wins over the 1.9 songs.practice.
  expect(practice.rate).toBe(.9);
  expect(practice.loop).toMatchObject({on: true, a: 8, b: 16, playTimes: 4, between: 'rest', aBar: {id: map.measures[4].id}});
  expect(practice.spots).toEqual([{id: 'sp1', name: 'Chorus fill', a: 14, b: 16, aBar: {id: map.measures[7].id, beat: 0}, bBar: {id: map.measures[8].id, beat: 0}, rate: .8, passes: 0, updatedAt: NOW - 5000}]);
  expect(practice.markers).toEqual([{id: 'mk1', t: 31.2, label: 'Snare roll', updatedAt: NOW - 3000}]);
  expect(practice.click).toEqual({countIn: {on: true, length: 1, unit: 'bars'}, mode: 'always', lastMode: 'countin', accent: true, volume: .6, preRoll: false});
  expect(practice).toMatchObject({minusMe: false, chartAudio: 'quiet', trainer: {start: .7, end: 1, step: .05, passes: 2}, surface: 'roadmap', keepPitch: true});
  expect(practice).not.toHaveProperty('lastAt');
  expect(practice).not.toHaveProperty('onlyMe');
  expect(JSON.stringify(practice)).not.toMatch(/left hand|Old idea|Cut/);
  expect(tempo).toEqual({songMap: map});
});

test('the shared map keeps its origin, stamps an origin-less made map, and is stable across runs', async () => {
  const legacyMade = sectionMap(120, undefined);
  const {t, token, songId} = await setup({tempo: {songMap: legacyMade, source: 'detected', detected: [{time: 0, downbeat: true}, {time: .5, downbeat: false}], accent: true, enabled: true}});
  const first = await t.query(api.sharing.view, {token});
  expect(first?.tempo).toEqual({songMap: {...legacyMade, origin: 'edited'}});
  expect(await t.query(api.sharing.view, {token})).toEqual(first);
  // The 1.x `enabled` click flag still reaches the shared practice (D51).
  expect(first?.practice.click).toMatchObject({mode: 'always', accent: true});
  // An unknown origin is dropped, never the map.
  await setTempo(t, songId, {songMap: {...sectionMap(), origin: 'bogus'}});
  const placeholder = defaultSongMap(120);
  expect((await t.query(api.sharing.view, {token}))?.tempo?.songMap?.origin).toBe('edited');
  await setTempo(t, songId, {songMap: placeholder});
  expect((await t.query(api.sharing.view, {token}))?.tempo).toEqual({songMap: placeholder});
  await setTempo(t, songId, {source: 'detected', detected: [{time: 1, downbeat: true}]});
  expect((await t.query(api.sharing.view, {token}))?.tempo).toBeUndefined();
});

test('pure helpers: sharedTempo and sharedPractice never throw on junk', () => {
  for (const junk of [null, undefined, 3, 'x', [], {songMap: {measures: 'no'}}]) {
    expect(() => sharedTempo(junk, 100)).not.toThrow();
    expect(sharedPractice(junk, junk, 100)).toMatchObject({v: 2, rate: 1, spots: [], markers: [], minusMe: false});
  }
  expect(sharedTempo({songMap: {measures: 'no'}}, 100)).toBeUndefined();
});

// ---- ownerName ----

test('ownerName formats the owner as first name and last initial, and never returns an email', async () => {
  expect(ownerNameOf('Kyle Kincer')).toBe('Kyle K.');
  expect(ownerNameOf('  Ana  María de la cruz ')).toBe('Ana C.');
  expect(ownerNameOf('Élodie émond')).toBe('Élodie É.');
  expect(ownerNameOf('Prince')).toBe('Prince');
  expect(ownerNameOf('Kyle (drums)')).toBe('Kyle D.');
  expect(ownerNameOf('Kyle 😀')).toBe('Kyle');
  for (const none of ['', '   ', null, undefined, 42, 'kyle@example.com', 'Kyle kyle@example.com']) expect(ownerNameOf(none)).toBe(ANONYMOUS_OWNER);

  const named = await setup();
  const view = await named.t.query(api.sharing.view, {token: named.token});
  expect(view?.ownerName).toBe('Kyle K.');
  expect(JSON.stringify(view)).not.toMatch(/@/);
  const single = await setup({name: 'Kyle'});
  expect((await single.t.query(api.sharing.view, {token: single.token}))?.ownerName).toBe('Kyle');
  const none = await setup({name: null});
  expect((await none.t.query(api.sharing.view, {token: none.token}))?.ownerName).toBe('a Woodshed user');
  const email = await setup({name: 'kyle@example.com'});
  expect((await email.t.query(api.sharing.view, {token: email.token}))?.ownerName).toBe('a Woodshed user');
});

// ---- links ----

test('revocation invalidates the link and media access; re-enabling never revives the old link', async () => {
  const {t, alice, songId, token} = await setup();
  expect((await alice.mutation(api.sharing.create, {id: songId})).token).toBe(token);
  expect(await alice.query(api.sharing.status, {id: songId})).toEqual({token, includeNotation: true, includeMap: true});
  await alice.mutation(api.sharing.create, {id: songId, includeNotation: false});
  expect(await alice.query(api.sharing.status, {id: songId})).toEqual({token, includeNotation: false, includeMap: true});
  await alice.mutation(api.sharing.revoke, {id: songId});
  expect(await alice.query(api.sharing.status, {id: songId})).toBeNull();
  expect(await t.query(api.sharing.view, {token})).toBeNull();
  await expect(t.action(api.shareAudio.playback, {token})).rejects.toThrow('unavailable');
  expect(await codeOf(t.action(api.shareAudio.playback, {token}))).toBe('not_found');
  const next = await alice.mutation(api.sharing.create, {id: songId}); expect(next.token).not.toBe(token);
  expect(next.token).toMatch(/^[a-f0-9]{64}$/);
  expect(await t.query(api.sharing.view, {token: next.token})).not.toBeNull();
  expect(Object.keys(await t.action(api.shareAudio.playback, {token: next.token})).sort()).toEqual(['cover', 'stem-0', 'stem-1']);
});

test('"Sections and tempo map" (includeMap): stored per link, absent means on, and only the choices given change', async () => {
  const {t, alice, songId, token} = await setup();
  const share = () => t.run(ctx => ctx.db.query('songShares').withIndex('by_songId', q => q.eq('songId', songId)).unique());
  expect(await share()).toMatchObject({includeNotation: true, includeMap: true});
  expect((await alice.mutation(api.sharing.create, {id: songId, includeMap: false})).token).toBe(token);
  expect(await alice.query(api.sharing.status, {id: songId})).toEqual({token, includeNotation: true, includeMap: false});
  // Changing one choice leaves the other as it was.
  await alice.mutation(api.sharing.create, {id: songId, includeNotation: false});
  expect(await alice.query(api.sharing.status, {id: songId})).toEqual({token, includeNotation: false, includeMap: false});
  await alice.mutation(api.sharing.create, {id: songId});
  expect(await alice.query(api.sharing.status, {id: songId})).toEqual({token, includeNotation: false, includeMap: false});
  await alice.mutation(api.sharing.create, {id: songId, includeMap: true});
  expect(await alice.query(api.sharing.status, {id: songId})).toEqual({token, includeNotation: false, includeMap: true});
  // A link written before the field existed (1.9 or 2.0 before G1) reads as on.
  await t.run(async ctx => { const row = (await ctx.db.query('songShares').withIndex('by_songId', q => q.eq('songId', songId)).unique())!; const {_id, _creationTime, includeMap, ...rest} = row; await ctx.db.replace('songShares', _id, rest); });
  expect(await share()).not.toHaveProperty('includeMap');
  expect(await alice.query(api.sharing.status, {id: songId})).toEqual({token, includeNotation: false, includeMap: true});
  expect((await t.query(api.sharing.view, {token}))?.tempo).toBeDefined();
  // A new link takes the choices it is created with; a stopped link's choices do not carry over.
  await alice.mutation(api.sharing.revoke, {id: songId});
  const next = await alice.mutation(api.sharing.create, {id: songId, includeMap: false});
  expect(await alice.query(api.sharing.status, {id: songId})).toEqual({token: next.token, includeNotation: true, includeMap: false});
  await alice.mutation(api.sharing.revoke, {id: songId});
  const third = await alice.mutation(api.sharing.create, {id: songId});
  expect(await alice.query(api.sharing.status, {id: songId})).toEqual({token: third.token, includeNotation: true, includeMap: true});
});

test('with includeMap false the link carries no tempo (practice keeps its times) and a saved copy is unmapped', async () => {
  const map = sectionMap();
  const {t, alice, bob, songId, token} = await setup({tempo: {songMap: map, countIn: true, countInLength: 2, countInUnit: 'bars'}, songPractice: v2Practice(map)});
  const mapped = (await t.query(api.sharing.view, {token}))!;
  expect(mapped.tempo).toEqual({songMap: map});
  await alice.mutation(api.sharing.create, {id: songId, includeMap: false});
  const view = (await t.query(api.sharing.view, {token}))!;
  expect(view).not.toHaveProperty('tempo');
  expect(view.practice).toEqual(mapped.practice);
  expect(view.practice.loop).toMatchObject({on: true, a: 8, b: 16});
  expect(view.practice.spots.map(s => [s.a, s.b])).toEqual([[14, 16]]);
  expect(view.practice.markers.map(m => m.t)).toEqual([31.2]);
  expect(JSON.stringify(view)).not.toMatch(/songMap|"measures"/);
  const copyId = await bob.action(api.shareAudio.save, {token});
  const copy = (await songRow(t, copyId))!;
  expect(copy).not.toHaveProperty('tempo');
  expect(copy).toMatchObject({hasChart: false, tempoRev: 0, mapSummary: {real: false, sections: []}});
  expect(copy.practiceSummary?.loopLabel).toBe('0:08–0:16 loop');
  const [row] = await practiceRows(t, copyId);
  expect(row.practice.loop).toMatchObject({on: true, a: 8, b: 16});
  // The original keeps its map.
  expect((await songRow(t, songId))!.tempo.songMap).toEqual(map);
});

test('the snapshot taken when a save begins decides the copy, even if the owner turns the map off mid-copy', async () => {
  const map = sectionMap();
  const {t, alice, bob, songId, token} = await setup({tempo: {songMap: map}, songPractice: v2Practice(map)});
  let toggled = false;
  remote.copyHook = async () => { if (!toggled) { toggled = true; await alice.mutation(api.sharing.create, {id: songId, includeMap: false}); } };
  const copy = (await songRow(t, await bob.action(api.shareAudio.save, {token})))!;
  expect(copy.tempo).toEqual({songMap: map});
  expect(copy.mapSummary).toMatchObject({real: true, sections: ['Start', 'Chorus', 'Verse']});
});

test('practice is read through migrations.storedPractice (one definition, I0B-7)', async () => {
  expect(sharingSource).toMatch(/import \{storedPractice\} from '\.\/migrations'/);
  expect(sharingSource).not.toMatch(/function storedPractice/);
  // Neither a songPractice row nor a 1.9 songs.practice: the link carries the default practice.
  const {t, token} = await setup({songPracticeOnly: true});
  expect((await t.query(api.sharing.view, {token}))?.practice).toMatchObject({v: 2, rate: 1, spots: [], markers: [], minusMe: false});
});

test('only finished, synced songs can be shared; export-only owners cannot create links', async () => {
  const {t, alice, songId} = await setup();
  await t.run(async ctx => { const o = await ctx.db.query('audioObjects').withIndex('by_key', q => q.eq('key', 'private/bass')).unique(); await ctx.db.patch('audioObjects', o!._id, {status: 'reserved'}); });
  await alice.mutation(api.sharing.revoke, {id: songId});
  expect(await codeOf(alice.mutation(api.sharing.create, {id: songId}))).toBe('invalid');
  await expect(alice.mutation(api.sharing.create, {id: songId})).rejects.toThrow('Finish syncing');
  await t.run(ctx => ctx.db.patch('songs', songId, {stems: []}));
  await expect(alice.mutation(api.sharing.create, {id: songId})).rejects.toThrow('Finish processing');
  const owner = (await songRow(t, songId))!.userId;
  await t.run(ctx => ctx.db.insert('accountControls', {userId: owner, status: 'export_only', notes: ''}));
  expect(await codeOf(alice.mutation(api.sharing.create, {id: songId}))).toBe('account_export_only');
});

// ---- saving a copy ----

test('saving copies audio, cover, tempo and practice independently; repeated saves do not charge twice', async () => {
  const {t, alice, bob, songId, token} = await setup();
  const savedId = await bob.action(api.shareAudio.save, {token});
  expect(await bob.action(api.shareAudio.save, {token})).toBe(savedId); expect(remote.copies).toBe(3);
  const saved = (await songRow(t, savedId))!;
  expect(saved).toMatchObject({userId: 'bob', title: 'Shared song', artist: 'Artist', duration: 120, tempoRev: 0, hasChart: false});
  expect(saved.notes).toBeUndefined(); expect(saved.tags).toBeUndefined(); expect(saved.source).toBeUndefined();
  expect(saved.stems.every(s => s.key.startsWith('users/bob/shared/'))).toBe(true);
  expect(saved.coverKey).toMatch(/^users\/bob\/shared\/.+\/2$/);
  // The pre-1.6 map is translated once into a songMap; the 1.x click fields are not copied into tempo.
  expect(Object.keys(saved.tempo)).toEqual(['songMap']);
  expect(saved.tempo.songMap.origin).toBe('edited');
  expect(saved.tempo.songMap.measures[0]).toMatchObject({numerator: 7, denominator: 8});
  expect(hasRealMap(saved.tempo)).toBe(true);
  expect((await bob.query(api.storage.usage, {})).usedBytes).toBe(210);
  await setTempo(t, songId, {map: [{t: 0, bpm: 200, beatsPerBar: 4, unit: 4}]});
  await t.run(ctx => ctx.db.patch('songs', songId, {practice: {rate: .5}}));
  await alice.mutation(api.sharing.revoke, {id: songId}); await alice.mutation(api.songs.remove, {id: songId});
  expect((await songRow(t, savedId))!.tempo).toEqual(saved.tempo);
  expect((await practiceRows(t, savedId))[0].practice.rate).toBe(.75);
  expect(await bob.query(internal.media.authorizedKeys, {keys: saved.stems.map(s => s.key)})).toHaveLength(2);
});

test('finishImport strips practice from the song and writes songPractice, summaries and hasChart', async () => {
  const map = sectionMap();
  const {t, alice, bob, songId, token} = await setup({tempo: {songMap: map}, songPractice: v2Practice(map), songPracticeOnly: true});
  const score = emptyScore(120), {bars, ...header} = score;
  bars.push({measureId: score.timeline.measures[0].id, coverage: 'progress', hits: [{id: 'h1', offset: {n: 0, d: 1}, instrument: 'snare', voice: 1, accent: false, ghost: false, flam: false, sticking: '', velocity: .75}]});
  await alice.mutation(api.notation.save, {songId, baseRevision: 0, mutationId: 'chart', header, bars});
  const copyId = await bob.action(api.shareAudio.save, {token});
  const copy = (await songRow(t, copyId))!;
  expect(copy).not.toHaveProperty('practice');
  expect(copy.hasChart).toBe(true);
  expect(copy.tempoRev).toBe(0);
  expect(copy.tempo).toEqual({songMap: map});
  expect(copy.mapSummary).toEqual({real: true, bpm: 120, meter: '4/4', sections: ['Start', 'Chorus', 'Verse']});
  expect(copy.practiceSummary).toEqual({loopLabel: 'Chorus loop', rate: .9, minusMe: false, surface: 'roadmap', spotCount: 1, spots: [{id: 'sp1', name: 'Chorus fill', rate: .8}]});
  expect(copy.lastPracticedAt).toBeUndefined();
  const rows = await practiceRows(t, copyId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({userId: 'bob', practice: {v: 2, minusMe: false, spots: [{id: 'sp1', passes: 0}], markers: [{id: 'mk1'}]}});
  expect(rows[0].practice.spots[0]).not.toHaveProperty('note');
  // The import row no longer holds the snapshot.
  const imports = await t.run(ctx => ctx.db.query('shareImports').take(5));
  expect(imports).toMatchObject([{status: 'ready', songId: copyId, snapshot: null, files: []}]);
});

test('a link made without the drum part saves a copy without a chart; a bars loop on a mapped song is labelled by bars', async () => {
  const map = sectionMap();
  const practice = {...v2Practice(map), loop: {on: true, a: 2, b: 6, eachPassCount: true, playTimes: 0, between: 'none'}};
  const {t, alice, bob, songId} = await setup({tempo: {songMap: map}, songPractice: practice});
  const score = emptyScore(120), {bars, ...header} = score;
  bars.push({measureId: score.timeline.measures[0].id, coverage: 'reviewed', hits: []});
  await alice.mutation(api.notation.save, {songId, baseRevision: 0, mutationId: 'chart', header, bars});
  const {token} = await alice.mutation(api.sharing.create, {id: songId, includeNotation: false});
  const copyId = await bob.action(api.shareAudio.save, {token});
  const copy = (await songRow(t, copyId))!;
  expect(copy.hasChart).toBe(false);
  expect(await bob.query(api.notation.get, {songId: copyId})).toBeNull();
  expect(copy.practiceSummary?.loopLabel).toBe('Bars 2–3 loop');
});

test('a reviewed-only chart counts as a chart; an unmapped copy labels loops by time', async () => {
  const {t, alice, bob, songId, token} = await setup({tempo: undefined});
  const score = emptyScore(120), {bars, ...header} = score;
  bars.push({measureId: score.timeline.measures[0].id, coverage: 'reviewed', hits: []});
  await alice.mutation(api.notation.save, {songId, baseRevision: 0, mutationId: 'chart', header, bars});
  const copyId = await bob.action(api.shareAudio.save, {token});
  const copy = (await songRow(t, copyId))!;
  expect(copy.hasChart).toBe(true);
  expect(copy.tempo).toBeUndefined();
  expect(copy.mapSummary).toMatchObject({real: true});
  const plain = await setup({tempo: undefined});
  const plainCopy = (await songRow(plain.t, await plain.bob.action(api.shareAudio.save, {token: plain.token})))!;
  expect(plainCopy).toMatchObject({hasChart: false, mapSummary: {real: false, sections: []}, practiceSummary: {loopLabel: '0:10–0:20 loop', rate: .75}});
});

test('an import row written by 1.9 (v1 practice, legacy tempo, extra fields) commits through the same upgrade', async () => {
  const {t, bob, token} = await setup();
  const heads = [...remote.objects].map(([sourceKey, h]) => ({sourceKey, bytes: h.ContentLength, mime: h.ContentType, etag: h.ETag}));
  const begun = await bob.mutation(internal.sharing.beginImport, {token, heads});
  if (!begun.id || !begun.attempt || !begun.files) throw Error('Missing import');
  const legacySnapshot = {
    title: 'Shared song', artist: 'Artist', album: '', albumArtist: '', year: '', genre: '', trackNumber: '', discNumber: '', musicalKey: '', tuning: '',
    duration: 120, stems: [{name: 'drums', key: 'private/audio drums', bytes: 100, mime: 'audio/webm'}, {name: 'bass', key: 'private/bass', bytes: 100, mime: 'audio/webm'}],
    stemMode: 'full', quality, coverKey: 'private/cover',
    tempo: {accent: true, volume: .5, countIn: true, countInLength: 1, countInUnit: 'beats', enabled: false, source: 'detected',
      map: [], detected: [{time: 0, downbeat: true}, {time: .5, downbeat: false}, {time: 1, downbeat: false}, {time: 1.5, downbeat: false}, {time: 2, downbeat: true}]},
    practice: {rate: .8, loop: {enabled: true, a: 4, b: 8}, grid: {visible: true, snap: true, division: 2}, tracks: []},
    surprise: 'not a song column',
  };
  await t.run(ctx => ctx.db.patch('shareImports', begun.id, {snapshot: legacySnapshot}));
  for (const f of begun.files) remote.objects.set(f.key, {ContentLength: f.bytes, ContentType: f.mime, ETag: 'x'});
  const copyId = await bob.mutation(internal.sharing.finishImport, {id: begun.id, attempt: begun.attempt});
  const copy = (await songRow(t, copyId))!;
  expect(copy).not.toHaveProperty('practice');
  expect(copy).not.toHaveProperty('surprise');
  expect(Object.keys(copy.tempo)).toEqual(['songMap']);
  expect(copy.tempo.songMap.origin).toBe('detected');
  expect(copy.mapSummary?.real).toBe(true);
  const [row] = await practiceRows(t, copyId);
  expect(row.practice).toMatchObject({v: 2, rate: .8, loop: {on: true, a: 4, b: 8}, click: {countIn: {on: true, length: 1, unit: 'beats'}, mode: 'countin', accent: true, volume: .5}});
  expect(row.practice).not.toHaveProperty('grid');
  expect(copy.practiceSummary).toMatchObject({rate: .8, spotCount: 0});
});

test('owners open their existing song, anonymous saves are denied, and deleting a saved copy allows adding again', async () => {
  const {t, alice, bob, songId, token} = await setup();
  expect(await alice.action(api.shareAudio.save, {token})).toBe(songId); expect(remote.copies).toBe(0);
  await expect(t.action(api.shareAudio.save, {token})).rejects.toThrow('Not signed in');
  expect(await t.query(api.sharing.saved, {token})).toBeNull();
  expect(await alice.query(api.sharing.saved, {token})).toEqual({songId, status: 'ready'});
  const first = await bob.action(api.shareAudio.save, {token});
  expect(await bob.query(api.sharing.saved, {token})).toEqual({songId: first, status: 'ready'});
  await bob.mutation(api.songs.remove, {id: first});
  expect(await bob.query(api.sharing.saved, {token})).toBeNull();
  const second = await bob.action(api.shareAudio.save, {token}); expect(second).not.toBe(first);
});

test('revocation during a copy prevents commit and retires every reserved destination', async () => {
  const {t, alice, bob, songId, token} = await setup(); let revoked = false;
  remote.copyHook = async () => { if (!revoked) { revoked = true; await alice.mutation(api.sharing.revoke, {id: songId}); } };
  await expect(bob.action(api.shareAudio.save, {token})).rejects.toThrow(UNAVAILABLE);
  expect((await bob.query(api.songs.list, {})).songs).toHaveLength(0);
  expect(await t.run(ctx => ctx.db.query('songPractice').take(10))).toHaveLength(0);
  const rows = await t.run(ctx => ctx.db.query('audioObjects').withIndex('by_userId_status', q => q.eq('userId', 'bob').eq('status', 'deleting')).take(10));
  expect(rows).toHaveLength(3);
  for (const row of rows) await t.mutation(internal.storage.deleted, {id: row._id});
  expect((await bob.query(api.storage.usage, {})).usedBytes).toBe(0);
});

test('a failed copy never creates a partial song and can be retried', async () => {
  const {t, bob, token} = await setup(); remote.copyHook = async () => { throw Error('offline'); };
  await expect(bob.action(api.shareAudio.save, {token})).rejects.toThrow('copy all');
  expect((await bob.query(api.songs.list, {})).songs).toHaveLength(0);
  expect(await t.run(ctx => ctx.db.query('songPractice').take(10))).toHaveLength(0);
  remote.copyHook = null; expect(await bob.action(api.shareAudio.save, {token})).toBeTruthy();
});

test('user and app quotas reject saves before copying, with storage codes', async () => {
  const {bob, token} = await setup(); vi.stubEnv('CLOUD_USER_BYTE_LIMIT', '200');
  await expect(bob.action(api.shareAudio.save, {token})).rejects.toThrow('library is full');
  expect(await codeOf(bob.action(api.shareAudio.save, {token}))).toBe('storage_full_user');
  vi.stubEnv('CLOUD_USER_BYTE_LIMIT', '1000'); vi.stubEnv('CLOUD_APP_BYTE_LIMIT', '400');
  await expect(bob.action(api.shareAudio.save, {token})).rejects.toThrow('Cloud storage');
  expect(await codeOf(bob.action(api.shareAudio.save, {token}))).toBe('storage_full_app');
  expect(remote.copies).toBe(0); expect((await bob.query(api.storage.usage, {})).usedBytes).toBe(0);
});

test('suspended senders disable public access, export-only recipients cannot save', async () => {
  const {t, bob, owner, token} = await setup();
  await t.run(ctx => ctx.db.insert('accountControls', {userId: 'bob', status: 'export_only', notes: ''}));
  await expect(bob.action(api.shareAudio.save, {token})).rejects.toThrow('export-only');
  expect(await codeOf(bob.action(api.shareAudio.save, {token}))).toBe('account_export_only');
  await t.run(ctx => ctx.db.insert('accountControls', {userId: owner, status: 'suspended', notes: ''}));
  expect(await t.query(api.sharing.view, {token})).toBeNull();
});

test('simultaneous attempts cannot create duplicate reservations or overwrite the first save', async () => {
  const {bob, token} = await setup(); let release!: () => void; const held = new Promise<void>(r => { release = r; });
  remote.copyHook = () => held;
  const first = bob.action(api.shareAudio.save, {token});
  await vi.waitFor(() => expect(remote.copies).toBe(3));
  await expect(bob.action(api.shareAudio.save, {token})).rejects.toThrow('already being added');
  expect(await codeOf(bob.action(api.shareAudio.save, {token}))).toBe('invalid');
  expect(await bob.query(api.sharing.saved, {token})).toEqual({songId: null, status: 'copying'});
  release(); await first; expect((await bob.query(api.songs.list, {})).songs).toHaveLength(1);
});

test('missing audio fails before reservation and a reprocessed source gets a new cache revision', async () => {
  const {t, bob, songId, token} = await setup(); const before = await t.query(api.sharing.view, {token});
  remote.objects.delete('private/bass'); await expect(bob.action(api.shareAudio.save, {token})).rejects.toThrow('could not be loaded');
  expect((await bob.query(api.storage.usage, {})).usedBytes).toBe(0);
  await t.run(ctx => ctx.db.patch('songs', songId, {stems: [{name: 'drums', key: 'new/reprocessed', bytes: 100, mime: 'audio/webm'}]}));
  expect((await t.query(api.sharing.view, {token}))?.revision).not.toBe(before?.revision);
});

test('disabling account writes during a save prevents commit and cleans up reservations', async () => {
  const {t, bob, token} = await setup(); let changed = false;
  remote.copyHook = async () => { if (!changed) { changed = true; await t.run(ctx => ctx.db.insert('accountControls', {userId: 'bob', status: 'export_only', notes: ''})); } };
  await expect(bob.action(api.shareAudio.save, {token})).rejects.toThrow('export-only');
  expect((await bob.query(api.songs.list, {})).songs).toHaveLength(0);
});

test('expired imports release reserved files and stale cleanup cannot affect a later successful attempt', async () => {
  const {t, bob, token} = await setup();
  const heads = [...remote.objects].map(([sourceKey, h]) => ({sourceKey, bytes: h.ContentLength, mime: h.ContentType, etag: h.ETag}));
  const first = await bob.mutation(internal.sharing.beginImport, {token, heads}); if (!first.id || !first.attempt || !first.files) throw Error('Missing import');
  await t.run(ctx => ctx.db.patch('shareImports', first.id, {expiresAt: 0}));
  await expect(bob.mutation(internal.sharing.finishImport, {id: first.id, attempt: first.attempt})).rejects.toThrow('timed out');
  expect(await codeOf(bob.mutation(internal.sharing.finishImport, {id: first.id, attempt: 'other'}))).toBe('not_found');
  await t.mutation(internal.sharing.failImport, {id: first.id, attempt: first.attempt});
  const saved = await bob.action(api.shareAudio.save, {token});
  await t.mutation(internal.sharing.failImport, {id: first.id, attempt: first.attempt});
  expect(await songRow(t, saved)).not.toBeNull();
});

test('changed heads are refused before anything is reserved', async () => {
  const {bob, token} = await setup();
  const heads = [...remote.objects].map(([sourceKey, h]) => ({sourceKey, bytes: h.ContentLength, mime: h.ContentType, etag: h.ETag}));
  expect(await codeOf(bob.mutation(internal.sharing.beginImport, {token, heads: heads.slice(1)}))).toBe('invalid');
  expect(await codeOf(bob.mutation(internal.sharing.beginImport, {token, heads: heads.map(h => ({...h, bytes: 0}))}))).toBe('invalid');
  expect((await bob.query(api.storage.usage, {})).usedBytes).toBe(0);
});

// ---- notation travels with the copy ----

test('recipient gets a coherent notation snapshot even when the sender edits while audio copies', async () => {
  const {alice, bob, songId, token} = await setup(); const score = emptyScore(120), {bars, ...header} = score;
  bars.push({measureId: score.timeline.measures[0].id, coverage: 'reviewed', hits: []});
  await alice.mutation(api.notation.save, {songId, baseRevision: 0, mutationId: 'initial-score', header, bars});
  let edited = false; remote.copyHook = async () => { if (edited) return; edited = true; await alice.mutation(api.notation.save, {songId, baseRevision: 1, mutationId: 'later-score', header: {...header, title: 'Changed during copy'}, bars: []}); };
  const copyId = await bob.action(api.shareAudio.save, {token}); const copied = await bob.query(api.notation.get, {songId: copyId});
  expect(copied?.score.title).toBe('Drums'); expect(copied?.score.timeline).toEqual(score.timeline); expect(copied?.score.bars[0].coverage).toBe('reviewed');
  expect((await alice.query(api.notation.get, {songId}))?.score.title).toBe('Changed during copy');
  await alice.mutation(api.songs.remove, {id: songId}); expect((await bob.query(api.notation.get, {songId: copyId}))?.score.title).toBe('Drums');
});
const drumHit = (id: string, instrument: string, offset: {n: number, d: number}, extra = {}) => ({id, offset, instrument, voice: (instrument === 'kick' ? 2 : 1) as 1 | 2, accent: false, ghost: false, flam: false, sticking: '' as const, velocity: .75, ...extra});
test('saved copies keep version 1 notation as stored and remain editable by old and current clients', async () => {
  const {t, alice, bob, songId, token} = await setup(); const score = emptyScore(120), header = {version: 1, title: 'Old drums', timeline: score.timeline};
  const v1 = (id: string, instrument: string, n: number, value: number) => ({id, offset: {n, d: 1}, duration: {n: 4, d: value}, instrument, voice: 1, value, dotted: false, tuplet: 1, accent: false, ghost: false, flam: false, sticking: '', velocity: .75});
  const bar = {measureId: score.timeline.measures[0].id, coverage: 'reviewed', hits: [v1('snare', 'snare', 1, 4), v1('rest', 'rest', 2, 2)]};
  await alice.mutation(api.notation.save, {songId, baseRevision: 0, mutationId: 'desktop', header, bars: [bar]} as any);
  const copyId = await bob.action(api.shareAudio.save, {token});
  expect(await bob.query(api.notation.get, {songId: copyId})).toEqual({score: {...header, bars: [bar]}, revision: 1});
  const parts = await t.run(ctx => ctx.db.query('notationParts').collect());
  expect(parts.find(p => p.songId === copyId)).toMatchObject({userId: 'bob', revision: 1, lastMutation: 'shared-copy', hitCount: parts.find(p => p.songId === songId)!.hitCount});
  expect((await songRow(t, copyId))!.hasChart).toBe(true);
  // A recipient on desktop 1.5 can keep editing; a current client upgrades the copy only.
  expect(await bob.mutation(api.notation.save, {songId: copyId, baseRevision: 1, mutationId: 'old-edit', header: {...header, title: 'Bob drums'}, bars: []} as any)).toEqual({revision: 2});
  const {bars: _, ...current} = score;
  expect(await bob.mutation(api.notation.save, {songId: copyId, baseRevision: 2, mutationId: 'upgrade', header: {...current, layout: 'split'}, bars: []})).toEqual({revision: 3});
  const upgraded = upgradeScore((await bob.query(api.notation.get, {songId: copyId}))!.score);
  expect(upgraded).toMatchObject({version: 2, layout: 'split', bars: [{coverage: 'reviewed', hits: [drumHit('snare', 'snare', {n: 1, d: 1})]}]});
  expect((await alice.query(api.notation.get, {songId}))!.score).toEqual({...header, bars: [bar]});
});
test('saved copies keep version 2 layout and tuplets and refuse outdated writers', async () => {
  const {alice, bob, songId, token} = await setup(); const score = emptyScore(120), {bars: _, ...base} = score, header = {...base, layout: 'split' as const};
  const bar = {measureId: score.timeline.measures[1].id, coverage: 'progress' as const, hits: [0, 1, 2, 3, 4].map(i => drumHit('q' + i, 'snare', {n: i, d: 5}, i ? {} : {accent: true, heavy: true})), tuplets: [{start: {n: 0, d: 1}, length: {n: 1, d: 1}, count: 5}]};
  await alice.mutation(api.notation.save, {songId, baseRevision: 0, mutationId: 'current', header, bars: [bar]});
  const copyId = await bob.action(api.shareAudio.save, {token});
  expect(await bob.query(api.notation.get, {songId: copyId})).toEqual({score: {...header, bars: [bar]}, revision: 1});
  await expect(bob.mutation(api.notation.save, {songId: copyId, baseRevision: 1, mutationId: 'old', header: {version: 1, title: 'Drums', timeline: score.timeline}, bars: []} as any)).rejects.toThrow('NOTATION_UPGRADE_REQUIRED');
  await alice.mutation(api.notation.save, {songId, baseRevision: 1, mutationId: 'combined', header: base, bars: [{...bar, tuplets: undefined}]});
  expect((await bob.query(api.notation.get, {songId: copyId}))!.score).toEqual({...header, bars: [bar]});
});
