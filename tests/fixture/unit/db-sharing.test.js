// @vitest-environment happy-dom
// The fixture's sharing handlers (tests/fixture/db/sharing.js, package BK5)
// mirror convex/sharing.ts v2: the snapshot shape, ownerName, links by token,
// and "Add to my library" making a copy with its own practice and summaries.
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

vi.hoisted(() => { globalThis.__FX_DB_MANUAL_BOOT__ = true; });

const {boot, call, stopJobCreep} = await import('../db/index.js');
const runtime = await import('../db/runtime.js');
const {SHARE_TOKEN, DEMO_TOKEN} = await import('../db/seed.js');
const {ownerNameOf, shareView} = await import('../db/sharing.js');

const NOW = Date.parse('2026-10-28T09:00:00Z');
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
const start = (search = '') => boot({search, store: new MemoryStorage(), now: NOW});
const codeOf = promise => promise.then(() => null, e => e?.data?.code ?? null);

beforeEach(() => { start(); });
afterEach(() => { stopJobCreep(); vi.useRealTimers(); });

describe('sharing:view', () => {
  it('returns the v2 snapshot: owner name, tempo {songMap}, sanitised practice, opaque stems', async () => {
    const demo = await call('query', 'sharing:view', {token: DEMO_TOKEN});
    expect(demo).toMatchObject({id: 'shared', title: 'Paper Lanterns', artist: 'Marisol Vega', ownerName: 'Kyle K.', coverKey: 'cover', revision: 'r1'});
    expect(Object.keys(demo.tempo)).toEqual(['songMap']);
    expect(demo.tempo.songMap.origin).toBe('imported');
    expect(demo.practice).toMatchObject({v: 2, surface: 'stems', minusMe: false, spots: [], markers: [{id: 'mk-ln-1'}, {id: 'mk-ln-2'}]});
    expect(demo.practice).not.toHaveProperty('lastAt');
    expect(demo.stems.map(s => s.key)).toEqual(['stem-0', 'stem-1', 'stem-2', 'stem-3', 'stem-4', 'stem-5']);
    const json = JSON.stringify(demo);
    expect(json).not.toMatch(/@|artwork\/lanterns|user1/);
    expect(demo).not.toHaveProperty('notes');
    expect(demo).not.toHaveProperty('tags');
    expect(demo).not.toHaveProperty('source');
  });

  it('a v2 source loses notes, history, tombstones and Minus me; a v1 source shares its loop and its tempo click settings', async () => {
    runtime.db.shares.lowtide = {token: 'c'.repeat(64), includeNotation: true, createdAt: NOW};
    runtime.db.shares.secondwind = {token: 'd'.repeat(64), includeNotation: true, createdAt: NOW};
    const lowtide = await call('query', 'sharing:view', {token: 'c'.repeat(64)});
    expect(lowtide.practice.spots.map(s => s.id)).toEqual(['sp-lt-1', 'sp-lt-2', 'sp-lt-3']);
    expect(lowtide.practice.spots.every(s => s.passes === 0 && !('note' in s) && !('lastAt' in s))).toBe(true);
    expect(lowtide.practice.markers.map(m => m.id)).toEqual(['mk-lt-1', 'mk-lt-2']);
    expect(lowtide.practice).toMatchObject({minusMe: false, click: {mode: 'always'}, loop: {on: true}});
    expect(lowtide.practice).not.toHaveProperty('onlyMe');
    const secondwind = await call('query', 'sharing:view', {token: 'd'.repeat(64)});
    expect(secondwind.practice).toMatchObject({rate: .85, loop: {on: true, a: 30.5, b: 40.5}, click: {countIn: {on: true, length: 2}, accent: false, preRoll: true}});
    expect(secondwind.tempo.source).toBe('detected');
    expect(secondwind.tempo).not.toHaveProperty('countIn');
    expect(secondwind.tempo.detected.length).toBeGreaterThan(10);
  });

  it('unknown and stopped links are unavailable; fx-share=missing hides every link', async () => {
    expect(await call('query', 'sharing:view', {token: 'b'.repeat(64)})).toBeNull();
    expect(await codeOf(call('action', 'shareAudio:playback', {token: 'b'.repeat(64)}))).toBe('not_found');
    await call('mutation', 'sharing:revoke', {id: 'glasshouse'});
    expect(await call('query', 'sharing:view', {token: SHARE_TOKEN})).toBeNull();
    expect(await call('query', 'sharing:status', {id: 'glasshouse'})).toBeNull();
    start('?fx-share=missing');
    expect(await call('query', 'sharing:view', {token: DEMO_TOKEN})).toBeNull();
  });

  it('ownerNameOf matches the server rule', () => {
    expect(ownerNameOf('Kyle Kincer')).toBe('Kyle K.');
    expect(ownerNameOf('Kyle')).toBe('Kyle');
    expect(ownerNameOf('')).toBe('a Woodshed user');
    expect(ownerNameOf('kyle@example.com')).toBe('a Woodshed user');
    runtime.db.user.name = 'Ana María López';
    expect(shareView(runtime.db.songs.find(s => s.id === 'glasshouse')).ownerName).toBe('Ana L.');
  });
});

describe('owner calls', () => {
  it('status/create/revoke behave like the server: reuse the active link, a stopped link is never revived', async () => {
    expect(await call('query', 'sharing:status', {id: 'glasshouse'})).toEqual({token: SHARE_TOKEN, includeNotation: true});
    expect(await call('mutation', 'sharing:create', {id: 'glasshouse', includeNotation: false})).toEqual({token: SHARE_TOKEN});
    expect(await call('query', 'sharing:status', {id: 'glasshouse'})).toEqual({token: SHARE_TOKEN, includeNotation: false});
    await call('mutation', 'sharing:revoke', {id: 'glasshouse'});
    const {token} = await call('mutation', 'sharing:create', {id: 'glasshouse'});
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(token).not.toBe(SHARE_TOKEN);
    expect(await call('query', 'sharing:status', {id: 'glasshouse'})).toEqual({token, includeNotation: true});
    expect(await codeOf(call('mutation', 'sharing:create', {id: 'nope'}))).toBe('not_found');
    start('?fx-auth=export_only');
    expect(await codeOf(call('mutation', 'sharing:create', {id: 'quiet'}))).toBe('account_export_only');
  });
});

describe('Add to my library', () => {
  it('copies the song once with its practice, drum part and summaries; saved reports it', async () => {
    vi.useFakeTimers({toFake: ['setTimeout']});
    expect(await call('query', 'sharing:saved', {token: SHARE_TOKEN})).toBeNull();
    const pending = call('action', 'shareAudio:save', {token: SHARE_TOKEN});
    await vi.advanceTimersByTimeAsync(800);
    const id = await pending;
    expect(id).toBe('glasshouse-copy');
    const copy = runtime.db.songs.find(s => s.id === id);
    expect(copy).toMatchObject({title: 'Glasshouse', tempoRev: 0, hasChart: true, notes: '', tags: [], source: null, mapSummary: {real: true, bpm: 120}});
    expect(copy.practice).toBeUndefined();
    expect(copy.tempo.songMap.origin).toBe('edited');
    expect(runtime.db.songPractice.find(r => r.songId === id).practice).toMatchObject({v: 2, minusMe: false});
    expect(runtime.db.notation[id].revision).toBe(1);
    expect(await call('query', 'sharing:saved', {token: SHARE_TOKEN})).toEqual({songId: id, status: 'ready'});
    const again = call('action', 'shareAudio:save', {token: SHARE_TOKEN});
    await vi.advanceTimersByTimeAsync(800);
    expect(await again).toBe(id);
    expect(runtime.db.songs.filter(s => s.id === id)).toHaveLength(1);
  });

  it('a link without the drum part copies no chart; switches report saved and copying; export-only cannot save', async () => {
    vi.useFakeTimers({toFake: ['setTimeout']});
    const pending = call('action', 'shareAudio:save', {token: DEMO_TOKEN});
    await vi.advanceTimersByTimeAsync(800);
    const id = await pending;
    expect(runtime.db.songs.find(s => s.id === id)).toMatchObject({hasChart: false, practiceSummary: {rate: 1, spotCount: 0, surface: 'stems'}});
    expect(runtime.db.notation[id]).toBeUndefined();
    start('?fx-share=saved');
    expect(await call('query', 'sharing:saved', {token: SHARE_TOKEN})).toEqual({songId: 'glasshouse', status: 'ready'});
    start('?fx-share=copying');
    expect(await call('query', 'sharing:saved', {token: SHARE_TOKEN})).toEqual({songId: null, status: 'copying'});
    start('?fx-auth=export_only');
    expect(await codeOf(call('action', 'shareAudio:save', {token: SHARE_TOKEN}))).toBe('account_export_only');
  });

  it('playback signs every stem and the cover', async () => {
    const urls = await call('action', 'shareAudio:playback', {token: SHARE_TOKEN});
    expect(Object.keys(urls).sort()).toEqual(['cover', 'stem-0', 'stem-1', 'stem-2', 'stem-3']);
  });
});
