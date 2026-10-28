// @vitest-environment happy-dom
// The fixture database: handler merging, routing, subscriptions, sessionStorage
// persistence, window.fixture, job creep, and the handlers adapted to seed v2
// (architecture §11.2).
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

vi.hoisted(() => { globalThis.__FX_DB_MANUAL_BOOT__ = true; });

const dbIndex = await import('../db/index.js');
const runtime = await import('../db/runtime.js');
const {SEED_VERSION, SHARE_TOKEN, DEMO_TOKEN, seedKey} = await import('../db/seed.js');
const {ConvexClient} = await import('../stubs/convex-browser.js');

const {boot, call, subscribe, persist, reset, mergeHandlers, handlers, installFixtureApi, startJobCreep, stopJobCreep, freezeJobs, STORAGE_KEY} = dbIndex;
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const NOW = Date.parse('2026-10-28T09:00:00Z');

class MemoryStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

let store;
beforeEach(() => { store = new MemoryStorage(); boot({search: '', store, now: NOW}); });
afterEach(() => { stopJobCreep(); vi.useRealTimers(); });

describe('handler modules (db/index.js)', () => {
  it('merges every db/*.js handlers table and covers every function the 1.9 app calls', () => {
    const names = Object.keys(handlers);
    for (const name of ['users:me', 'admin:access', 'settings:config', 'songs:list', 'songs:savePractice', 'jobs:listActive', 'jobs:createBeatDetection', 'devices:pair', 'media:signKeys', 'notation:get', 'notation:save', 'sharing:view', 'shareAudio:playback', 'metadata:update', 'metadataLookup:find', 'tempoSources:search', 'billingData:status', 'storage:usage'])
      expect(names, name).toContain(name);
  });
  it('rejects a function defined in two modules, a bad name and a non-function', () => {
    expect(() => mergeHandlers({'./a.js': {handlers: {'x:y': () => 1}}, './b.js': {handlers: {'x:y': () => 2}}})).toThrow(/x:y is defined in both .\/a.js and .\/b.js/);
    expect(() => mergeHandlers({'./a.js': {handlers: {'nope': () => 1}}})).toThrow(/bad handler name/);
    expect(() => mergeHandlers({'./a.js': {handlers: {'x:y': 1}}})).toThrow(/not a function/);
    expect(mergeHandlers({'./a.js': {}, './b.js': {handlers: {'a:b': () => 1}}})).toHaveProperty('a:b');
  });
  it('routes calls by name and refuses an unknown one', async () => {
    expect((await call('query', 'songs:get', {id: 'glasshouse'})).title).toBe('Glasshouse');
    expect(await call('query', 'songs:get', {id: 'missing'})).toBeNull();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(call('query', 'nothing:here', {})).rejects.toThrow('Fixture has no handler for nothing:here');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('the convex/browser stub reaches the same handlers (query, mutation, onUpdate)', async () => {
    const client = new ConvexClient('https://fixture.convex.invalid');
    const seen = [];
    const off = client.onUpdate('songs:get', {id: 'quiet'}, v => seen.push(v.title));
    await tick();
    await client.mutation('songs:rename', {id: 'quiet', title: 'Quieter Hours'});
    await tick(); await tick();
    expect(seen).toEqual(['Quiet Hours', 'Quieter Hours']);
    off();
    await client.mutation('songs:rename', {id: 'quiet', title: 'Ignored'});
    await tick();
    expect(seen).toHaveLength(2);
  });
});

describe('subscriptions', () => {
  it('re-run after a change, report only new values, and stop when unsubscribed', async () => {
    const values = [];
    const stop = subscribe('songs:get', {id: 'glasshouse'}, v => values.push(v.title));
    await tick();
    runtime.changed();
    await tick();
    expect(values).toEqual(['Glasshouse']);
    runtime.db.songs[0].title = 'Glasshouse (edit)';
    runtime.changed();
    await tick();
    expect(values).toEqual(['Glasshouse', 'Glasshouse (edit)']);
    expect(stop.getCurrentValue().title).toBe('Glasshouse (edit)');
    stop.unsubscribe();
    runtime.db.songs[0].title = 'Later';
    runtime.changed();
    await tick();
    expect(values).toHaveLength(2);
  });
  it('a query that never resolves (fx-library=slow) never calls back; errors go to onError', async () => {
    boot({search: '?fx-library=slow', store, now: NOW});
    const cb = vi.fn(), onError = vi.fn();
    subscribe('songs:list', {}, cb);
    subscribe('nothing:here', {}, () => {}, onError);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await tick();
    expect(cb).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({message: 'Fixture has no handler for nothing:here'}));
  });
});

describe('persistence (sessionStorage["fx-db"])', () => {
  it('writes the seed on boot and every change after it', async () => {
    const stored = JSON.parse(store.getItem(STORAGE_KEY));
    expect(stored.version).toBe(SEED_VERSION);
    expect(stored.key).toBe(seedKey({}));
    expect(stored.data.songs).toHaveLength(12);
    await call('mutation', 'songs:rename', {id: 'glasshouse', title: 'Renamed'});
    await tick();
    expect(JSON.parse(store.getItem(STORAGE_KEY)).data.songs[0].title).toBe('Renamed');
  });
  it('reloads what was stored', async () => {
    await call('mutation', 'songs:remove', {id: 'quiet'});
    await tick();
    expect(boot({search: '', store, now: NOW + 1000})).toEqual({restored: true});
    expect(runtime.db.songs.map(s => s.id)).not.toContain('quiet');
  });
  it('reseeds for another seed switch, a stale version or unreadable data', async () => {
    await call('mutation', 'songs:remove', {id: 'quiet'});
    await tick();
    expect(boot({search: '?fx-library=empty', store, now: NOW}).restored).toBe(false);
    expect(runtime.db.songs).toEqual([]);
    expect(boot({search: '', store, now: NOW}).restored).toBe(false);
    expect(runtime.db.songs).toHaveLength(12);
    store.setItem(STORAGE_KEY, JSON.stringify({version: SEED_VERSION - 1, key: seedKey({}), data: {songs: []}}));
    expect(boot({search: '', store, now: NOW}).restored).toBe(false);
    store.setItem(STORAGE_KEY, '{not json');
    expect(boot({search: '', store, now: NOW}).restored).toBe(false);
    expect(runtime.db.songs).toHaveLength(12);
  });
  it('switches that do not shape the seed keep the stored data', async () => {
    await call('mutation', 'songs:remove', {id: 'quiet'});
    await tick();
    expect(boot({search: '?fx-media=slow&fx-desktop=1&fx-platform=ipad', store, now: NOW}).restored).toBe(true);
  });
  it('survives a storage that refuses writes (in-memory only, with a warning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const full = new MemoryStorage();
    full.setItem = () => { throw new Error('QuotaExceededError'); };
    expect(() => boot({search: '', store: full, now: NOW})).not.toThrow();
    expect(persist()).toBe(false);
    expect(warn).toHaveBeenCalledWith('[fixture] could not persist the database:', 'QuotaExceededError');
    expect(runtime.db.songs).toHaveLength(12);
    warn.mockRestore();
  });
  it('reset() starts again from the seed', async () => {
    runtime.db.songs = [];
    reset({now: NOW});
    await tick();
    expect(runtime.db.songs).toHaveLength(12);
    expect(JSON.parse(store.getItem(STORAGE_KEY)).data.songs).toHaveLength(12);
  });
});

describe('window.fixture database API', () => {
  it('db() is a deep copy; update(fn) mutates and notifies; reset() and freezeJobs()', async () => {
    const win = {};
    const api = installFixtureApi(win);
    expect(win.fixture).toBe(api);
    const copy = api.db();
    copy.songs.length = 0;
    expect(api.db().songs).toHaveLength(12);
    const values = [];
    subscribe('songs:get', {id: 'lowtide'}, v => values.push(v.title));
    await tick();
    expect(api.update(db => { db.songs.find(s => s.id === 'lowtide').title = 'Low Tide'; return db.songs[1]; }).title).toBe('Low Tide');
    await tick();
    expect(values).toEqual(['Low Tide Static', 'Low Tide']);
    api.freezeJobs();
    expect(api.db().jobs.every(j => j.frozen)).toBe(true);
    api.reset();
    expect(api.db().jobs.some(j => j.frozen)).toBe(false);
    expect(api.fx).toBe(runtime.fx);
  });
  it('running jobs creep forward until frozen', () => {
    vi.useFakeTimers();
    startJobCreep(1000);
    const before = runtime.db.jobs.find(j => j.jobId === 'job-run').percent;
    vi.advanceTimersByTime(3000);
    expect(runtime.db.jobs.find(j => j.jobId === 'job-run').percent).toBe(before + 3);
    expect(runtime.db.jobs.find(j => j.jobId === 'job-q').percent).toBe(0);
    freezeJobs();
    vi.advanceTimersByTime(3000);
    expect(runtime.db.jobs.find(j => j.jobId === 'job-run').percent).toBe(before + 3);
  });
});

describe('handlers adapted to seed v2', () => {
  it('jobs:listActive lists queued, running and failed jobs only; jobs:get finds done ones too', async () => {
    const live = await call('query', 'jobs:listActive', {});
    expect(live.every(j => ['queued', 'running', 'error'].includes(j.status))).toBe(true);
    expect(live.map(j => j.jobId)).toContain('job-bot');
    expect(live.map(j => j.jobId)).not.toContain('job-detect-nightbus');
    expect((await call('query', 'jobs:get', {jobId: 'job-detect-nightbus'})).result.beats.length).toBeGreaterThan(100);
  });
  it('a beat detection is a job in db.jobs that finishes with a result', async () => {
    vi.useFakeTimers();
    const {jobId} = await call('mutation', 'jobs:createBeatDetection', {songId: 'quiet'});
    expect((await call('query', 'jobs:listActive', {})).some(j => j.jobId === jobId)).toBe(true);
    vi.advanceTimersByTime(1600);
    const done = await call('query', 'jobs:get', {jobId});
    expect(done.status).toBe('done');
    expect(done.result.beats[0]).toEqual([0, 1]);
  });
  it('fx-detect=fail and slow shape a beat detection', async () => {
    vi.useFakeTimers();
    boot({search: '?fx-detect=fail', store, now: NOW});
    const failed = await call('mutation', 'jobs:createBeatDetection', {songId: 'quiet'});
    vi.advanceTimersByTime(1600);
    expect(await call('query', 'jobs:get', failed)).toMatchObject({status: 'error', errorCode: 'beats_unavailable'});
    boot({search: '?fx-detect=slow', store, now: NOW});
    const slow = await call('mutation', 'jobs:createBeatDetection', {songId: 'quiet'});
    vi.advanceTimersByTime(1600);
    expect((await call('query', 'jobs:get', slow)).status).toBe('running');
    vi.advanceTimersByTime(6500);
    expect((await call('query', 'jobs:get', slow)).status).toBe('done');
  });
  it('settings:config merges the stored row over the defaults; fx-account=new has none', async () => {
    const {settings, presets} = await call('query', 'settings:config', {});
    expect(settings.preset).toBe('balanced');
    expect(settings.profile).toEqual({instruments: ['drums', 'bass'], primary: 'drums', openWithMyPart: 'in'});
    expect(Object.keys(presets).length).toBeGreaterThan(0);
    boot({search: '?fx-account=new', store, now: NOW});
    const fresh = (await call('query', 'settings:config', {})).settings;
    expect(fresh.preset).toBeTruthy();
    expect(fresh.profile).toBeUndefined();
  });
  it('shared links resolve by token: Glasshouse’s and the demo', async () => {
    expect((await call('query', 'sharing:view', {token: SHARE_TOKEN})).title).toBe('Glasshouse');
    const demo = await call('query', 'sharing:view', {token: DEMO_TOKEN});
    expect(demo.title).toBe('Paper Lanterns');
    expect(demo.id).toBe('shared');
    expect(demo.stems.map(s => s.key)).toEqual(['stem-0', 'stem-1', 'stem-2', 'stem-3', 'stem-4', 'stem-5']);
    expect(await call('query', 'sharing:view', {token: 'b'.repeat(64)})).toBeNull();
    expect((await call('query', 'notation:get', {token: SHARE_TOKEN})).score.timeline.measures).toHaveLength(64);
    expect(await call('query', 'notation:get', {token: DEMO_TOKEN})).toBeNull();
    boot({search: '?fx-share=missing', store, now: NOW});
    expect(await call('query', 'sharing:view', {token: SHARE_TOKEN})).toBeNull();
  });
  it('users:me reflects fx-auth status; admin and billing come from the seed', async () => {
    expect((await call('query', 'users:me', {})).status).toBe('active');
    boot({search: '?fx-auth=export_only', store, now: NOW});
    expect((await call('query', 'users:me', {})).status).toBe('export_only');
    boot({search: '?fx-billing=plus&fx-admin=1', store, now: NOW});
    expect((await call('query', 'billingData:status', {})).access).toBe('paid');
    expect(await call('query', 'admin:access', {})).toBe(true);
    expect((await call('query', 'admin:account', {id: 'user2'})).createdAt).toBe(NOW - 120 * 864e5);
  });
  it('media:signKeys signs covers from the seed and fails with fx-media=fail', async () => {
    const signed = await call('action', 'media:signKeys', {keys: ['covers/weather.png']});
    expect(signed['covers/weather.png']).toMatch(/^data:image\/svg\+xml,/);
    boot({search: '?fx-media=fail', store, now: NOW});
    await expect(call('action', 'media:signKeys', {keys: ['covers/weather.png']})).rejects.toThrow('Request timed out (fixture)');
  });
});
