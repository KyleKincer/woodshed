import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createPracticeState, COPY, SAVE_DEBOUNCE_MS, RETRY_MS} from '../src/stage/practice-state.js';
import {signal} from '../src/app/store.js';
import {clock} from '../src/app/clock.js';
import {deviceStore} from '../src/app/prefs.js';
import {emptyPractice, PRACTICE_CAP, MAX_SPOTS, MAX_MARKERS, TOMBSTONE_DAYS} from '../shared/practice.ts';
import {FAKE_TIMERS} from './helpers/fake-audio.js';
import {mapStore, sectioned} from './fixtures/maps.js';

const T0 = Date.parse('2026-10-28T12:00:00Z');
const DAY = 86_400_000;
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** A Map-backed localStorage, so deviceStore persists across instances like a real page. */
function installStorage() {
  const data = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  });
  return data;
}

function setup({raw = emptyPractice(), server = undefined, persist, ...rest} = {}) {
  const saves = [];
  const serverSig = signal(server === undefined ? structuredClone(raw) : server);
  const persistFn = persist ?? vi.fn(async (p, opts) => { saves.push({p: structuredClone(p), ...opts}); });
  const status = vi.fn();
  const practice = createPracticeState({songId: 'song-1', raw, duration: 128, persist: persistFn, server: serverSig, status, ...rest});
  return {practice, saves, server: serverSig, persist: persistFn, status, value: () => practice.value.value};
}

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(T0);
  clock.set();
});
afterEach(() => {
  clock.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('save cadence', () => {
  test('a patch saves once, 600 ms after the last change, as a non-final save', async () => {
    const {practice, saves, value} = setup();
    practice.patch({rate: 0.9});
    vi.advanceTimersByTime(400);
    practice.patch({rate: 0.85});
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
    expect(saves).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await settle();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({final: false, p: {rate: 0.85}});
    expect(value().rate).toBe(0.85);
  });

  test('flush({final: true}) saves at once; a final flush after a non-final save still runs (summary, D52)', async () => {
    const {practice, saves} = setup();
    practice.patch({cue: 12});
    await practice.flush({final: true});
    expect(saves.map((s) => s.final)).toEqual([true]);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 2);
    await settle();
    expect(saves).toHaveLength(1);                  // the debounce was cancelled

    await practice.flush({final: true});
    expect(saves).toHaveLength(1);                  // nothing new and already summarised

    practice.patch({cue: 13});
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    await settle();
    expect(saves.map((s) => s.final)).toEqual([true, false]);
    await practice.markStopped();
    expect(saves.map((s) => s.final)).toEqual([true, false, true]);
    expect(saves[2].p.cue).toBe(13);
  });

  test('a non-final flush with nothing changed does not save; a no-op patch changes nothing', async () => {
    const {practice, saves, value} = setup();
    const before = value();
    practice.patch({rate: 1});
    expect(value()).toBe(before);
    await practice.flush();
    await practice.flush({final: true});
    expect(saves).toHaveLength(0);
  });

  test('one save runs at a time; a request during a save runs after it with the latest value', async () => {
    let release;
    const calls = [];
    const persist = vi.fn((p, {final}) => {
      calls.push({rate: p.rate, final});
      return calls.length === 1 ? new Promise((r) => { release = r; }) : Promise.resolve();
    });
    const {practice} = setup({persist});
    practice.patch({rate: 0.9});
    const first = practice.flush();
    practice.patch({rate: 0.8});
    const second = practice.flush({final: true});
    const third = practice.flush();
    expect(calls).toHaveLength(1);
    release();
    await first;
    await second;
    await third;
    expect(calls).toEqual([{rate: 0.9, final: false}, {rate: 0.8, final: true}]);
  });

  test('dispose() saves unsaved changes (final) and stops the debounce', async () => {
    const {practice, saves} = setup();
    practice.patch({cue: 5});
    practice.dispose();
    await settle();
    expect(saves).toEqual([expect.objectContaining({final: true})]);
    practice.patch({cue: 6});
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 2);
    await settle();
    expect(saves).toHaveLength(1);
  });

  test('dispose() after a non-final save finished still sends the final save (summary, D52)', async () => {
    const {practice, saves} = setup();
    practice.patch({rate: 0.8});
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    await settle();
    expect(saves.map((s) => s.final)).toEqual([false]);
    practice.dispose();
    await settle();
    expect(saves.map((s) => s.final)).toEqual([false, true]);
    expect(saves[1].p.rate).toBe(0.8);
  });

  test('dispose() while a non-final save is in flight queues the final save behind it', async () => {
    let release;
    const finals = [];
    const persist = vi.fn((p, {final}) => {
      finals.push(final);
      return finals.length === 1 ? new Promise((r) => { release = r; }) : Promise.resolve();
    });
    const {practice} = setup({persist});
    practice.patch({rate: 0.8});
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    await settle();
    expect(finals).toEqual([false]);
    practice.dispose();
    release();
    await settle();
    expect(finals).toEqual([false, true]);
  });

  test('dispose() with nothing saved this session sends nothing', async () => {
    const {practice, saves} = setup();
    practice.dispose();
    await settle();
    expect(saves).toHaveLength(0);
  });

  test('patch accepts a draft function; spots and markers come out sanitised', async () => {
    const {practice, value} = setup();
    practice.patch((p) => { p.loop = {...p.loop, on: true, a: 40, b: 32}; p.rate = 9; });
    expect(value().loop).toMatchObject({on: true, a: 32, b: 40});
    expect(value().rate).toBe(1.5);
    practice.patch(null);
    expect(value().rate).toBe(1.5);
  });
});

describe('merge before save', () => {
  test('dirty keys keep this device’s value; other keys and the lists come from the server', async () => {
    const raw = emptyPractice();
    const {practice, server, saves} = setup({raw});
    practice.patch({rate: 0.75});
    server.value = {...raw, cue: 42, surface: 'roadmap',
      spots: [{id: 'other', name: 'Bridge', a: 80, b: 96, rate: 0.8, passes: 3, updatedAt: T0 - 5}]};
    await practice.flush({final: true});
    expect(saves[0].p).toMatchObject({rate: 0.75, cue: 42, surface: 'roadmap'});
    expect(saves[0].p.spots.map((s) => s.id)).toEqual(['other']);
  });

  test('a v1 server value is read through the upgrade', async () => {
    const {practice, server, saves} = setup();
    server.value = {loop: {enabled: true, a: 10, b: 20}, rate: 0.6, grid: true, tracks: [{name: 'drums', volume: 0.5, muted: true, soloed: false}]};
    practice.patch({cue: 3});
    await practice.flush();
    expect(saves[0].p).toMatchObject({v: 2, cue: 3, rate: 0.6, loop: {on: true, a: 10, b: 20}});
    expect(saves[0].p.grid).toBeUndefined();
  });

  test('another device’s change is adopted live for keys this device has not changed', () => {
    const raw = emptyPractice();
    const {practice, server, value} = setup({raw});
    practice.patch({rate: 0.9});
    server.value = {...raw, rate: 0.5, cue: 20};
    expect(value()).toMatchObject({rate: 0.9, cue: 20});
  });

  test('our own save is not undone by a stale server value, and later foreign changes apply again', async () => {
    const raw = emptyPractice();
    let release;
    const persist = vi.fn(() => new Promise((r) => { release = r; }));
    const {practice, server, value} = setup({raw, persist});
    practice.patch({rate: 0.9});
    const saving = practice.flush();
    server.value = {...raw, rate: 1, cue: 1};           // a result from before our save landed
    expect(value()).toMatchObject({rate: 0.9, cue: 1});
    server.value = {...raw, rate: 0.9, cue: 1};         // our echo (before the mutation resolves)
    release();
    await saving;
    server.value = {...raw, rate: 0.7, cue: 1};         // another device, later
    expect(value().rate).toBe(0.7);
  });

  test('a save that sends what the server already holds pins nothing: a later foreign change is adopted and kept', async () => {
    const raw = emptyPractice();                         // rate 1
    const {practice, server, saves, value} = setup({raw});
    practice.patch({rate: 0.8});
    practice.patch({rate: 1});                           // back within the debounce
    practice.patch({cue: 4});
    await practice.flush();
    expect(saves[0].p.rate).toBe(1);
    server.value = {...raw, cue: 4, rate: 0.7};          // another device; no echo of ours ever comes
    expect(value().rate).toBe(0.7);
    practice.patch({cue: 5});
    await practice.flush();
    expect(saves[1].p).toMatchObject({cue: 5, rate: 0.7});
  });

  test('a foreign write that lands after ours is adopted even when our echo is skipped', async () => {
    const raw = emptyPractice();
    let release;
    const persist = vi.fn(() => new Promise((r) => { release = r; }));
    const {practice, server, value} = setup({raw, persist});
    practice.patch({rate: 0.9});
    const saving = practice.flush();
    server.value = {...raw, rate: 0.6};                  // the other device wrote right after us
    expect(value().rate).toBe(0.6);
    release();
    await saving;
    expect(value().rate).toBe(0.6);
  });

  test('when the write resolves and the server already shows a newer foreign value, that value is taken', async () => {
    const raw = emptyPractice();
    let release;
    const persist = vi.fn(() => new Promise((r) => { release = r; }));
    const server = signal(structuredClone(raw));
    const practice = createPracticeState({songId: 's', raw, duration: 128, persist, server: {peek: () => server.peek()}});
    practice.patch({rate: 0.9});
    const saving = practice.flush();
    server.value = {...raw, rate: 0.6};                  // seen only through peek (no subscription)
    release();
    await saving;
    expect(practice.value.value.rate).toBe(0.6);
  });

  test('a key whose echo has not arrived when the write resolves ends on the next server value', async () => {
    const raw = emptyPractice();
    const {practice, server, value} = setup({raw});
    practice.patch({rate: 0.9});
    await practice.flush();                              // the server signal still shows rate 1
    expect(value().rate).toBe(0.9);
    server.value = {...raw, rate: 0.5};                  // the next result: another device
    expect(value().rate).toBe(0.5);
  });

  test('a removed spot is a tombstone, so the merge never resurrects it', async () => {
    const raw = {...emptyPractice(), spots: [{id: 's1', name: 'Verse', a: 16, b: 32, rate: 1, passes: 0, updatedAt: T0 - 1000}]};
    const {practice, saves, value} = setup({raw});
    const before = value().spots;
    const id = practice.addSpot({name: 'Chorus', a: 32, b: 48, rate: 0.8});
    expect(value().spots.filter((s) => !s.deleted).map((s) => s.name)).toEqual(['Verse', 'Chorus']);
    await practice.flush();
    vi.advanceTimersByTime(5);
    practice.patch({spots: before});                    // what an Undo of "Save spot" does
    const tomb = value().spots.find((s) => s.id === id);
    expect(tomb).toMatchObject({deleted: true});
    expect(tomb.updatedAt).toBeGreaterThan(saves[0].p.spots.find((s) => s.id === id).updatedAt);
    await practice.flush();
    expect(saves[1].p.spots.find((s) => s.id === id).deleted).toBe(true);

    vi.advanceTimersByTime(5);
    practice.patch({spots: saves[0].p.spots});          // Redo brings it back
    expect(value().spots.find((s) => s.id === id).deleted).toBeUndefined();
  });
});

describe('pruning', () => {
  test('dropping markers to fit shows the warning once and saves under the cap', async () => {
    const markers = Array.from({length: 600}, (_, i) => ({id: `m${i}`, t: i * 0.2, label: `Marker ${i + 1}`, updatedAt: T0 - (600 - i)}));
    const raw = {...emptyPractice(), markers};
    const {practice, saves, status, value} = setup({raw, server: null});
    practice.patch({cue: 1});
    await practice.flush({final: true});
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(COPY.pruned);
    expect(COPY.pruned).toBe('Some old markers were removed to make room.');
    expect(JSON.stringify(saves[0].p).length).toBeLessThanOrEqual(PRACTICE_CAP);
    expect(value().markers.length).toBeLessThan(600);
    expect(value().markers.some((m) => m.id === 'm599')).toBe(true);   // the oldest go first
  });

  test('expired tombstones are dropped silently', async () => {
    const raw = {...emptyPractice(), markers: [
      {id: 'old', t: 1, label: 'Marker 1', updatedAt: T0 - (TOMBSTONE_DAYS + 1) * DAY, deleted: true},
      {id: 'live', t: 2, label: 'Marker 2', updatedAt: T0 - DAY},
    ]};
    const {practice, saves, status} = setup({raw, server: null});
    practice.patch({cue: 1});
    await practice.flush();
    expect(saves[0].p.markers.map((m) => m.id)).toEqual(['live']);
    expect(status).not.toHaveBeenCalled();
  });
});

describe('session hooks', () => {
  test('lastAt is written once per session, on the first Play', async () => {
    const {practice, value, saves} = setup();
    practice.markPlayed();
    expect(value().lastAt).toBe(T0);
    vi.advanceTimersByTime(60_000);
    practice.markPlayed();
    expect(value().lastAt).toBe(T0);
    await practice.flush();
    expect(saves[0].p.lastAt).toBe(T0);
  });

  test('touchSpot adds passes, stamps lastAt and bumps updatedAt (not an undo step, still saved)', async () => {
    const {practice, value, saves} = setup();
    const id = practice.addSpot({name: 'Chorus', a: 32, b: 48, rate: 0.85});
    vi.advanceTimersByTime(1000);
    const stampBefore = value().spots[0].updatedAt;
    practice.touchSpot(id);
    practice.touchSpot(id, {passes: 2});
    expect(value().spots[0]).toMatchObject({passes: 3, lastAt: T0 + 1000});
    expect(value().spots[0].updatedAt).toBeGreaterThan(stampBefore);
    practice.touchSpot('missing');
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    await settle();
    expect(saves).toHaveLength(2);                      // the add (saved during the second), then the passes
    expect(saves[1].p.spots[0].passes).toBe(3);
    expect(saves[1].p.spots[0].lastAt).toBe(T0 + 1000);
  });

  test('activeSpotId is a signal; deleting the active spot clears it', () => {
    const {practice, value} = setup();
    const id = practice.addSpot({name: 'Chorus', a: 32, b: 48});
    practice.activeSpotId.value = id;
    expect(practice.activeSpotId.value).toBe(id);
    practice.deleteSpot(id);
    expect(practice.activeSpotId.value).toBe(null);
    expect(value().spots[0].deleted).toBe(true);
  });

  test('reanchor moves the loop and spots to their bars after a map change', () => {
    const map = mapStore(sectioned);
    const raw = {...emptyPractice(),
      loop: {on: true, a: 32, b: 48, aBar: map.refAt(32), bBar: map.refAt(48), eachPassCount: true, playTimes: 0, between: 'none'},
      spots: [{id: 's1', name: 'Verse', a: 16, b: 20, aBar: map.refAt(16), bBar: map.refAt(20), rate: 1, passes: 0, updatedAt: T0 - 1}],
    };
    const {practice, value} = setup({raw});
    map.edit((d) => { d.pins = [{position: {n: 0, d: 1}, time: 2}]; }, 'pin');   // everything 2 s later
    practice.reanchor(map, {auditioning: true});
    expect(value().loop.a).toBe(32);                    // not while auditioning
    practice.reanchor({...map, auditioning: true, timeOfRef: () => 0});
    expect(value().loop.a).toBe(32);
    practice.reanchor(map);
    expect(value().loop).toMatchObject({a: 34, b: 50});
    expect(value().spots[0]).toMatchObject({a: 18, b: 22});
  });

  test('a ref that no longer resolves keeps the seconds and drops the refs', () => {
    const raw = {...emptyPractice(),
      loop: {on: true, a: 10, b: 14, aBar: {id: 'x1', beat: 0}, bBar: {id: 'x2', beat: 0}, eachPassCount: true, playTimes: 0, between: 'none'}};
    const {practice, value} = setup({raw});
    practice.reanchor({timeOfRef: (ref) => (ref.id === 'x1' ? 11 : null)});
    expect(value().loop).toMatchObject({on: true, a: 10, b: 14});
    expect(value().loop.aBar).toBeUndefined();
    expect(value().loop.bBar).toBeUndefined();
  });
});

describe('spots and markers', () => {
  test('add, update and delete spots; the add limit blocks at MAX_SPOTS live spots', () => {
    const {practice, value} = setup();
    const id = practice.addSpot({name: '  Chorus  ', a: 48, b: 32, rate: 0.8, note: 'watch the fill'});
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(value().spots[0]).toMatchObject({id, name: 'Chorus', a: 32, b: 48, rate: 0.8, note: 'watch the fill', passes: 0, updatedAt: T0});
    practice.updateSpot(id, {name: 'Hook', note: '', rate: 0.9});
    expect(value().spots[0]).toMatchObject({name: 'Hook', rate: 0.9});
    expect(value().spots[0].note).toBeUndefined();
    expect(practice.addSpot({name: 'Too short', a: 1, b: 1.01})).toBe(null);
    for (let i = 1; i < MAX_SPOTS; i++) expect(practice.addSpot({name: `S${i}`, a: i, b: i + 1})).not.toBe(null);
    expect(practice.addSpot({name: 'One more', a: 100, b: 101})).toBe(null);
    practice.deleteSpot(id);
    expect(practice.addSpot({name: 'Room again', a: 100, b: 101})).not.toBe(null);
  });

  test('markers: default labels count live markers, rename, delete, and the add limit', () => {
    const {practice, value} = setup();
    const a = practice.addMarker({t: 4});
    const b = practice.addMarker({t: 8, label: 'Fill'});
    expect(value().markers.map((m) => m.label)).toEqual(['Marker 1', 'Fill']);
    practice.renameMarker(a, 'Groove');
    practice.renameMarker(b, '   ');            // blank names are ignored
    practice.deleteMarker(b);
    expect(value().markers.filter((m) => !m.deleted).map((m) => m.label)).toEqual(['Groove']);
    expect(practice.addMarker({t: 9})).not.toBe(null);
    expect(value().markers.filter((m) => !m.deleted).map((m) => m.label)).toEqual(['Groove', 'Marker 2']);
    expect(practice.addMarker({t: NaN})).toBe(null);
    for (let i = 2; i < MAX_MARKERS; i++) practice.addMarker({t: i});
    expect(practice.addMarker({t: 99})).toBe(null);
  });
});

describe('errors', () => {
  test('a failed save retries once after 5 s, then keeps the change until the next save', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const persist = vi.fn(async () => { throw new Error('offline'); });
    const {practice, value} = setup({persist});
    practice.patch({rate: 0.9});
    await practice.flush({final: true});
    expect(persist).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RETRY_MS - 1);
    await settle();
    expect(persist).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await settle();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1][1]).toEqual({final: true});
    vi.advanceTimersByTime(RETRY_MS * 4);
    await settle();
    expect(persist).toHaveBeenCalledTimes(2);           // no third try on its own
    expect(value().rate).toBe(0.9);                     // kept locally

    persist.mockImplementation(async () => {});
    practice.patch({cue: 4});
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    await settle();
    expect(persist).toHaveBeenCalledTimes(3);
    expect(persist.mock.calls[2][0]).toMatchObject({rate: 0.9, cue: 4});
  });

  test('a successful save in the meantime makes the retry a no-op', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    const persist = vi.fn(async () => { if (fail) throw new Error('offline'); });
    const {practice} = setup({persist});
    practice.patch({rate: 0.9});
    await practice.flush();
    fail = false;
    await practice.flush();
    vi.advanceTimersByTime(RETRY_MS);
    await settle();
    expect(persist).toHaveBeenCalledTimes(2);
  });
});

describe('read-only (shared) songs', () => {
  test('a share token persists on this device only and reads the copy back on open', async () => {
    installStorage();
    const persist = vi.fn();
    const snapshot = {...emptyPractice(), rate: 0.8, markers: [{id: 'm1', t: 3, label: 'Sharer', updatedAt: T0 - 9}]};
    const first = createPracticeState({songId: 'song-1', raw: snapshot, duration: 120, readOnly: true, persist, local: {token: 'tok123'}});
    expect(first.value.value.rate).toBe(0.8);
    first.patch({rate: 0.6});
    first.addMarker({t: 10, label: 'Mine'});
    await first.flush({final: true});
    expect(persist).not.toHaveBeenCalled();
    const stored = deviceStore('share').get('tok123');
    expect(stored).toMatchObject({rate: 0.6});
    expect(stored.markers.map((m) => m.label)).toEqual(['Sharer', 'Mine']);
    expect(localStorage.getItem('ws.share.tok123')).toContain('"Mine"');

    const second = createPracticeState({songId: 'song-1', raw: snapshot, duration: 120, readOnly: true, persist, local: {token: 'tok123'}});
    expect(second.value.value.rate).toBe(0.6);
  });

  test('with a token the sharer’s snapshot signal never overrides the viewer’s own copy', async () => {
    installStorage();
    const persist = vi.fn();
    const snapshot = {...emptyPractice(), rate: 1};
    const open = () => createPracticeState({songId: 'song-1', raw: snapshot, duration: 120, readOnly: true, persist,
      server: signal(structuredClone(snapshot)), local: {token: 'tok9'}});
    const first = open();
    first.patch({rate: 0.7});
    await first.flush({final: true});
    first.dispose();

    const second = open();
    expect(second.value.value.rate).toBe(0.7);
    second.patch({minusMe: true});
    second.addMarker({t: 5, label: 'Here'});
    await second.flush({final: true});
    expect(second.value.value.rate).toBe(0.7);
    expect(deviceStore('share').get('tok9')).toMatchObject({rate: 0.7, minusMe: true});
    expect(persist).not.toHaveBeenCalled();
  });

  test('read-only without a token never persists', async () => {
    const persist = vi.fn();
    const practice = createPracticeState({songId: 's', raw: emptyPractice(), readOnly: true, persist});
    practice.patch({rate: 0.7});
    await practice.flush({final: true});
    expect(persist).not.toHaveBeenCalled();
    expect(practice.value.value.rate).toBe(0.7);
  });
});

test('open reads stored v1 practice and the legacy click fields from tempo (D51)', () => {
  const practice = createPracticeState({songId: 's', raw: {loop: {enabled: true, a: 1, b: 9}, rate: 0.7},
    legacyTempo: {countIn: true, countInLength: 2, enabled: true}, duration: 60, persist: vi.fn()});
  expect(practice.value.value).toMatchObject({v: 2, rate: 0.7, loop: {on: true, a: 1, b: 9},
    click: {countIn: {on: true, length: 2, unit: 'bars'}, mode: 'always'}});
  expect(practice.pending).toBe(false);
});
