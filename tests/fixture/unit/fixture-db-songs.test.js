// @vitest-environment happy-dom
// The fixture's songs handlers (tests/fixture/db/songs.js, package BK1) mirror
// convex/songs.ts (§6.3) on seed v2: slim list rows, get without practice,
// getPractice with the 1.9 fallback, getMany, the B2 cap, the stale-map
// conflict, final-save summaries and the delete cleanup.
import {describe, it, expect, beforeEach} from 'vitest';

globalThis.__FX_DB_MANUAL_BOOT__ = true;
const {boot, call, handlers} = await import('../db/index.js');
const runtime = await import('../db/runtime.js');
const {emptyPractice, PRACTICE_CAP} = await import('../../../shared/practice.ts');
const {defaultSongMap} = await import('../../../shared/song-map.ts');

const NOW = Date.parse('2026-10-28T09:00:00Z');
const q = (name, args) => call('query', `songs:${name}`, args);
const m = (name, args) => call('mutation', `songs:${name}`, args);
const song = id => runtime.db.songs.find(s => s.id === id);
const codeOf = async promise => { try { await promise; } catch (e) { return e.data?.code; } return null; };

beforeEach(() => { boot({search: '', store: null, now: NOW}); });

describe('the handler table', () => {
  it('mirrors every songs function of the contract', () => {
    for (const name of ['list', 'get', 'getPractice', 'getMany', 'savePractice', 'saveTempo', 'remove', 'confirmRecording', 'dismissSectionSuggestion', 'exportPage'])
      expect(handlers, name).toHaveProperty(`songs:${name}`);
  });
});

describe('songs:list', () => {
  it('returns slim rows, newest first, with the summaries and flags', async () => {
    const {songs} = await q('list', {});
    expect(songs.map(s => s.id)).toEqual(runtime.db.songs.slice().sort((a, b) => b.addedAt - a.addedAt).map(s => s.id));
    for (const row of songs) for (const key of ['notes', 'tempo', 'practice', 'metadataLocks', 'metadataRecordingId', 'metadataReleaseId', 'bpm', 'offset'])
      expect(row, `${row.id}.${key}`).not.toHaveProperty(key);
    const byId = Object.fromEntries(songs.map(s => [s.id, s]));
    expect(byId.glasshouse).toMatchObject({hasChart: true, mapSummary: {real: true, bpm: 120, meter: '4/4'}, practiceSummary: null, reviewMetadata: false});
    expect(byId.lowtide.practiceSummary).toMatchObject({loopLabel: 'Chorus loop', spotCount: 3});
    expect(byId.jam03.reviewMetadata).toBe(true);
    expect(byId.counting).toMatchObject({reviewMetadata: true, suggestion: {title: 'Counting Stars Backwards', artist: 'Ada Moreno', album: 'Harbor Lights', releaseId: 'c0ffee00-0000-4000-8000-00000000beef'}});
    expect(byId.shuffle.recordingUnconfirmed).toBe(true);
    expect(byId.velvet.hasSectionSuggestion).toBe(true);
    // 1.9 rows the backfill has not reached: summaries computed on read, as on the server.
    expect(byId.secondwind.practiceSummary).toEqual({loopLabel: 'Bars 13–16 loop', rate: 0.85, minusMe: false, spotCount: 0, spots: []});
    expect(byId.nightbus.mapSummary).toMatchObject({real: true, meter: '4/4', sections: ['Start', 'Chorus', 'Verse 2', 'Chorus 2']});
    expect(byId.quiet.mapSummary).toEqual({real: false, sections: []});
  });
});

describe('songs:get, getPractice, getMany', () => {
  it('get has no practice; getPractice reads songPractice, else the v1 songs.practice', async () => {
    const lowtide = await q('get', {id: 'lowtide'});
    expect(lowtide).not.toHaveProperty('practice');
    expect(lowtide).toMatchObject({id: 'lowtide', tempoRev: 5, tempoSaveId: null, recordingUnconfirmed: false, sectionSuggestion: null, notes: ''});
    expect(await q('get', {id: 'missing'})).toBeNull();
    expect(await q('getPractice', {id: 'lowtide'})).toMatchObject({v: 2, rate: 0.9});
    expect(await q('getPractice', {id: 'secondwind'})).toMatchObject({rate: 0.85, loop: {enabled: true}});
    expect(await q('getPractice', {id: 'quiet'})).toBeNull();
  });
  it('getMany keeps order, drops unknown ids and is capped', async () => {
    expect((await q('getMany', {ids: ['quiet', 'nope', 'glasshouse', 'quiet']})).map(s => s.id)).toEqual(['quiet', 'glasshouse']);
    expect(await codeOf(q('getMany', {ids: []}))).toBe('invalid');
    expect(await codeOf(q('getMany', {ids: Array(101).fill('quiet')}))).toBe('invalid');
  });
});

describe('songs:savePractice', () => {
  it('a non-final save writes only songPractice; a final one writes the summary', async () => {
    const before = structuredClone(song('quiet'));
    const value = {...emptyPractice(), rate: 0.7, lastAt: NOW};
    await m('savePractice', {id: 'quiet', practice: value});
    expect(song('quiet')).toEqual(before);
    expect(runtime.db.songPractice.find(r => r.songId === 'quiet').practice).toEqual(value);
    await m('savePractice', {id: 'quiet', practice: value, final: true});
    expect(song('quiet')).toMatchObject({lastPracticedAt: NOW, practiceSummary: {rate: 0.7, spotCount: 0}});
    expect(await q('getPractice', {id: 'quiet'})).toEqual(value);
  });
  it('accepts 32,768 characters and refuses 32,769 with practice_too_large', async () => {
    const sized = n => { const v = {...emptyPractice(), pad: ''}; v.pad = 'x'.repeat(n - JSON.stringify(v).length); return v; };
    await m('savePractice', {id: 'quiet', practice: sized(PRACTICE_CAP)});
    expect(await codeOf(m('savePractice', {id: 'quiet', practice: sized(PRACTICE_CAP + 1)}))).toBe('practice_too_large');
    expect(await codeOf(m('savePractice', {id: 'nope', practice: {}}))).toBe('not_found');
  });
});

describe('songs:saveTempo', () => {
  it('writes the map, keeps the 1.9 click fields, bumps tempoRev and stores the save id', async () => {
    const map = {...defaultSongMap(233, 90), origin: 'tapped'};
    expect(await m('saveTempo', {id: 'nightbus', tempo: {songMap: map}, baseRev: 0, saveId: 'u1'})).toEqual({tempoRev: 1, conflict: false});
    const s = song('nightbus');
    expect(Object.keys(s.tempo).sort()).toEqual(['accent', 'audiblePreRoll', 'countIn', 'countInLength', 'countInUnit', 'enabled', 'songMap', 'volume']);
    expect(s).toMatchObject({tempoRev: 1, tempoSaveId: 'u1', mapSummary: {real: true, bpm: 90, sections: []}});
    expect(await m('saveTempo', {id: 'nightbus', tempo: {songMap: map}, baseRev: 1})).toEqual({tempoRev: 1, conflict: false});
  });
  it('a stale save keeps a real map as a conflict; sections clear the suggestion', async () => {
    const stored = structuredClone(song('lowtide').tempo);
    expect(await m('saveTempo', {id: 'lowtide', tempo: {songMap: defaultSongMap(92)}, baseRev: 4})).toEqual({tempoRev: 5, conflict: true, tempo: stored});
    expect(song('lowtide').tempo).toEqual(stored);
    const labelled = structuredClone(song('velvet').tempo.songMap);
    labelled.measures[0].label = 'Intro';
    await m('saveTempo', {id: 'velvet', tempo: {songMap: labelled}, baseRev: 1});
    expect(song('velvet').sectionSuggestion).toBeUndefined();
    expect(await codeOf(m('saveTempo', {id: 'velvet', tempo: {map: []}}))).toBe('invalid');
  });
});

describe('songs:remove and the flag mutations', () => {
  it('remove drops the practice row, setlist entries, pins, the part and live jobs', async () => {
    expect(runtime.db.setlists[0].songIds).toContain('lowtide');
    await m('remove', {id: 'lowtide'});
    expect(song('lowtide')).toBeUndefined();
    expect(runtime.db.songPractice.map(r => r.songId)).not.toContain('lowtide');
    expect(runtime.db.setlists[0].songIds).not.toContain('lowtide');
    expect(runtime.db.settings.pins).not.toContain('lowtide');
    await m('remove', {id: 'glasshouse'});
    expect(runtime.db.notation.glasshouse).toBeUndefined();
    expect(await codeOf(m('remove', {id: 'glasshouse'}))).toBe('not_found');
  });
  it('confirmRecording and dismissSectionSuggestion clear their flags', async () => {
    await m('confirmRecording', {id: 'shuffle'});
    expect((await q('get', {id: 'shuffle'})).recordingUnconfirmed).toBe(false);
    await m('dismissSectionSuggestion', {id: 'velvet'});
    expect((await q('get', {id: 'velvet'})).sectionSuggestion).toBeNull();
    expect((await q('list', {})).songs.find(s => s.id === 'velvet').hasSectionSuggestion).toBe(false);
  });
  it('exportPage carries each song with its practice', async () => {
    const {page, isDone} = await q('exportPage', {paginationOpts: {cursor: null, numItems: 50}});
    expect(isDone).toBe(true);
    const byId = Object.fromEntries(page.map(s => [s.id, s]));
    expect(byId.lowtide.practice).toMatchObject({v: 2});
    expect(byId.secondwind.practice).toMatchObject({rate: 0.85});
    expect(byId.quiet.practice).toBeNull();
  });
});
