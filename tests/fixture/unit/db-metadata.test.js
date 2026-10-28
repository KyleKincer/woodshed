// @vitest-environment happy-dom
// The fixture's metadata handlers (tests/fixture/db/metadata.js) follow the
// server's edit rules (architecture §6.9), so harness pages see real behaviour.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.hoisted(() => { globalThis.__FX_DB_MANUAL_BOOT__ = true; });

const {boot, call, handlers, settleAll} = await import('../db/index.js');
const runtime = await import('../db/runtime.js');
const {LOOKUP_MS} = await import('../db/metadata.js');

const NOW = Date.parse('2026-10-28T09:00:00Z');
const REC = '5e1f0000-0000-4000-8000-000000000001', REL = '7e1e0000-0000-4000-8000-000000000001';
const song = id => runtime.findSong(id);
const errorOf = async promise => { try { await promise; } catch (error) { return error.data; } throw new Error('expected a failure'); };

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

beforeEach(() => { boot({search: '', store: new MemoryStorage(), now: NOW}); });
afterEach(() => { vi.useRealTimers(); });

describe('metadata:update', () => {
  it('skips unchanged keys, locks changed ones and unlocks on Revert', async () => {
    const before = structuredClone(song('glasshouse'));
    await call('mutation', 'metadata:update', {ids: ['glasshouse'], changes: {title: ` ${before.title} `, artist: before.artist, tags: [...before.tags, before.tags[0]?.toUpperCase() ?? '']}});
    expect(song('glasshouse')).toEqual(before);
    await call('mutation', 'metadata:update', {ids: ['glasshouse'], changes: {genre: 'Shoegaze'}});
    expect(song('glasshouse')).toMatchObject({genre: 'Shoegaze', metadataLocks: ['genre']});
    await call('mutation', 'metadata:update', {ids: ['glasshouse'], changes: {genre: before.genre}, unlock: ['genre']});
    expect(song('glasshouse')).toMatchObject({genre: before.genre, metadataLocks: []});
  });

  it('a title change clears ids, suggestion and needsReview; a match sets matched after it', async () => {
    expect(song('counting').metadataSuggestion).toBeTruthy();
    await call('mutation', 'metadata:update', {ids: ['counting'], changes: {title: 'Counting Stars'}, match: {recordingId: REC, releaseId: REL}});
    expect(song('counting')).toMatchObject({title: 'Counting Stars', metadataStatus: 'matched', metadataRecordingId: REC, metadataReleaseId: REL});
    expect(song('counting').metadataSuggestion).toBeUndefined();
    expect(song('jam03').needsReview).toBe(true);
    await call('mutation', 'metadata:update', {ids: ['jam03'], changes: {title: 'Jam 3'}});
    expect(song('jam03').needsReview).toBeUndefined();
  });

  it('is atomic and reports coded field errors', async () => {
    const before = structuredClone(song('glasshouse'));
    expect(await errorOf(call('mutation', 'metadata:update', {ids: ['glasshouse', 'missing'], changes: {genre: 'X'}}))).toMatchObject({code: 'not_found'});
    expect(await errorOf(call('mutation', 'metadata:update', {ids: ['glasshouse'], changes: {albumArtist: 'x'.repeat(501)}})))
      .toEqual({code: 'invalid', field: 'albumArtist', message: 'Album artist is too long (500 characters max).'});
    expect(await errorOf(call('mutation', 'metadata:update', {ids: ['glasshouse', 'counting'], changes: {}, match: {recordingId: REC}}))).toMatchObject({code: 'invalid'});
    expect(song('glasshouse')).toEqual(before);
  });

  it('keeps the cover in step with the artwork choice', async () => {
    await call('mutation', 'metadata:update', {ids: ['glasshouse'], changes: {artwork: {kind: 'removed'}}});
    expect(song('glasshouse')).toMatchObject({coverUrl: null, coverKey: null, artwork: {kind: 'removed'}});
    await call('mutation', 'metadata:update', {ids: ['glasshouse'], changes: {artwork: {kind: 'release', releaseId: REL}}});
    expect(song('glasshouse').coverUrl).toMatch(/^data:image\/svg/);
  });
});

describe('metadata:updateEach and metadata:confirm', () => {
  it('updateEach writes nothing when one item fails', async () => {
    const before = structuredClone(song('glasshouse'));
    expect(await errorOf(call('mutation', 'metadata:updateEach', {items: [{id: 'glasshouse', changes: {genre: 'X'}}, {id: 'counting', changes: {year: 'soon'}}]})))
      .toMatchObject({code: 'invalid', field: 'year'});
    expect(song('glasshouse')).toEqual(before);
    await call('mutation', 'metadata:updateEach', {items: [{id: 'glasshouse', changes: {genre: 'X'}}, {id: 'counting', changes: {genre: 'Y'}}]});
    expect([song('glasshouse').genre, song('counting').genre]).toEqual(['X', 'Y']);
  });

  it('confirm locks the identity fields present and keeps recordingUnconfirmed', async () => {
    song('counting').recordingUnconfirmed = true;
    await call('mutation', 'metadata:confirm', {id: 'counting'});
    const s = song('counting');
    expect(s).toMatchObject({metadataStatus: 'matched', recordingUnconfirmed: true});
    expect([...s.metadataLocks].sort()).toEqual(['album', 'artist', 'title']);
    expect(s.metadataSuggestion).toBeUndefined();
    await call('mutation', 'metadata:confirm', {id: 'jam03'});
    expect(song('jam03').needsReview).toBeUndefined();
  });

  it('confirm keeps the suggestion ids when it names the current title, artist and album (server rule)', async () => {
    const {recordingId, releaseId} = song('counting').metadataSuggestion;
    await call('mutation', 'metadata:confirm', {id: 'counting'});
    expect(song('counting')).toMatchObject({metadataRecordingId: recordingId, metadataReleaseId: releaseId});
    // A suggestion for another title keeps no ids.
    Object.assign(song('glasshouse'), {metadataStatus: 'uncertain', metadataSuggestion: {recordingId: REC, releaseId: REL, title: 'Something else', artist: song('glasshouse').artist}});
    delete song('glasshouse').metadataRecordingId;
    await call('mutation', 'metadata:confirm', {id: 'glasshouse'});
    expect(song('glasshouse').metadataRecordingId).toBeFalsy();
  });

  it('cleared ids are absent, and an empty update still refuses a missing id', async () => {
    await call('mutation', 'metadata:update', {ids: ['counting'], changes: {}, match: {recordingId: REC, releaseId: REL}});
    await call('mutation', 'metadata:update', {ids: ['counting'], changes: {}, match: {recordingId: REC}});
    expect('metadataReleaseId' in song('counting')).toBe(false);
    await call('mutation', 'metadata:update', {ids: ['counting'], changes: {title: 'Renamed'}});
    expect('metadataRecordingId' in song('counting')).toBe(false);
    expect(await errorOf(call('mutation', 'metadata:update', {ids: ['counting', 'missing'], changes: {}}))).toMatchObject({code: 'not_found'});
  });
});

describe('metadataLookup', () => {
  it('find returns candidates with MusicBrainz ids that match accepts', async () => {
    vi.useFakeTimers({now: NOW});
    const pending = call('action', 'metadataLookup:find', {id: 'counting', title: 'Counting Stars Backwards', artist: 'Ada Moreno'});
    await vi.advanceTimersByTimeAsync(600);
    const results = await pending;
    expect(results.length).toBeGreaterThan(1);
    for (const c of results) expect(c).toMatchObject({recordingId: expect.stringMatching(/^[0-9a-f-]{36}$/), title: expect.any(String)});
    const releases = call('action', 'metadataLookup:find', {id: 'counting', title: 'Counting Stars Backwards', artist: 'Ada Moreno', recordingId: results[0].recordingId});
    await vi.advanceTimersByTimeAsync(600);
    expect((await releases).every(r => r.recordingId === results[0].recordingId && r.releaseId)).toBe(true);
    await call('mutation', 'metadata:update', {ids: ['counting'], changes: {}, match: {recordingId: results[0].recordingId, releaseId: results[0].releaseId}});
    expect(song('counting').metadataStatus).toBe('matched');
  });

  it('retry goes pending, then finishes, also across a reload', async () => {
    vi.useFakeTimers({now: NOW});
    song('glasshouse').metadataStatus = 'unavailable';
    await call('action', 'metadataLookup:retry', {id: 'glasshouse'});
    expect(song('glasshouse').metadataStatus).toBe('pending');
    await vi.advanceTimersByTimeAsync(LOOKUP_MS + 10);
    expect(song('glasshouse').metadataStatus).toBe('matched');
    // A reload before the lookup is due finishes it on the next settle.
    song('jam03').metadataStatus = 'unavailable';
    await call('action', 'metadataLookup:retry', {id: 'jam03'});
    expect(song('jam03').metadataStatus).toBe('pending');
    vi.setSystemTime(NOW + 10 * LOOKUP_MS);
    expect(settleAll()).toBe(true);
    expect(song('jam03').metadataStatus).toBe('uncertain');
    expect(await errorOf(call('action', 'metadataLookup:retry', {id: 'glasshouse'}))).toMatchObject({code: 'invalid'});
  });

  it('retry re-queues a song left pending by a lookup that died; a confirm meanwhile wins', async () => {
    vi.useFakeTimers({now: NOW});
    expect(song('metropolis').metadataStatus).toBe('pending'); // seeded pending, no lookup behind it
    await call('action', 'metadataLookup:retry', {id: 'metropolis'});
    await vi.advanceTimersByTimeAsync(LOOKUP_MS + 10);
    expect(song('metropolis').metadataStatus).toBe('matched');
    song('quiet').metadataStatus = 'unavailable';
    await call('action', 'metadataLookup:retry', {id: 'quiet'});
    await call('mutation', 'metadata:update', {ids: ['quiet'], changes: {}, match: {recordingId: REC}});
    await vi.advanceTimersByTimeAsync(LOOKUP_MS + 10);
    expect(song('quiet')).toMatchObject({metadataStatus: 'matched', metadataRecordingId: REC});
  });

  it('artwork upload is refused with a coded error', async () => {
    expect(await errorOf(call('action', 'artworkUpload:prepare', {id: 'glasshouse'}))).toMatchObject({code: 'invalid', field: 'artwork'});
    expect(Object.keys(handlers)).toEqual(expect.arrayContaining(['metadata:updateEach', 'metadata:confirm', 'metadataLookup:retry', 'metadataLookup:detail']));
  });
});
