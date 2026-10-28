// @vitest-environment node
// The song session (architecture §2.14.1): open order, tempo persistence and
// adoption (D53), map-change routing (D23), the markers offer, spot counters,
// flush triggers and the cache. Real SongMapStore, Metronome and
// MultitrackEngine over tests/helpers/fake-audio.js; the transport (ST1a) and
// feedback (S2) are same-wave peers and are mocked by their contract paths.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const peers = vi.hoisted(() => {
  const transports = [];
  const makeTransport = (options) => {
    const handlers = new Map();
    const t = {
      options,
      on: (event, fn) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); return () => handlers.get(event).delete(fn); },
      emit: (event, payload) => { for (const fn of [...(handlers.get(event) ?? [])]) fn(payload); },
      destroy: () => { t.destroyed = true; },
      // ST1a's `ready()`: called once the engine has loaded and the map has its decoded length.
      ready: vi.fn(async () => { t.readyAt = {tracks: options.engine.tracks.length, mapDuration: options.map.duration}; }),
      destroyed: false,
      engineTracksAtCreation: options.engine.tracks.length,
    };
    transports.push(t);
    return t;
  };
  return {transports, makeTransport, status: null};
});

vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({
  ...(await import('./helpers/fake-audio.js')).fakeStemcache,
  isDecodeError: (err) => /decode/i.test(String(err?.message ?? '')),
}));
vi.mock('../src/js/notation/store.js', () => ({NotationStore: vi.fn(), loadSharedNotation: vi.fn(async () => null), watchSharedNotation: () => () => {}}));
// Same-wave peers (§9.0): mocked by their contract paths. The second spelling of each
// is how an importer names the module while the peer has not merged yet.
vi.mock('../src/stage/transport.js', () => ({createTransport: vi.fn((options) => peers.makeTransport(options))}));
vi.mock('./transport.js', () => ({createTransport: vi.fn((options) => peers.makeTransport(options))}));
vi.mock('../src/app/feedback.js', () => ({status: vi.fn(), toast: vi.fn()}));
vi.mock('../app/feedback.js', () => ({status: vi.fn(), toast: vi.fn()}));

import {openSession, getSession, disposeSession, activeSession, clickOf, COPY, TEMPO_DEBOUNCE_MS, OWN_SAVE_IDS, ACCOUNT_WAIT_MS} from '../src/stage/session.js';
import {MultitrackEngine} from '../src/js/engine.js';
import {SongMapStore} from '../src/js/song-map.js';
import {signal, store as appStore} from '../src/app/store.js';
import {clock as appClock} from '../src/app/clock.js';
import {ApiError} from '../src/api/client.js';
import * as profile from '../src/app/profile.js';
import {emptyPractice} from '../shared/practice.ts';
import {emptyScore} from '../shared/notation.ts';
import {FAKE_TIMERS, installFakeAudio, createClock} from './helpers/fake-audio.js';
import {sectioned, unmapped, legacyTempoMap, tempoOf} from './fixtures/maps.js';

const T0 = Date.parse('2026-10-28T12:00:00Z');
const tick = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
let restoreAudio;
let seq = 0;

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(T0);
  appClock.set();
  restoreAudio = installFakeAudio();
  createClock();
  peers.transports.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  restoreAudio();
  vi.clearAllMocks();
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

function makeSong(overrides = {}) {
  const n = ++seq;
  return {
    id: `song-${n}`, title: 'Glasshouse', artist: 'Ada Moreno', duration: 128,
    stems: [{name: 'drums', key: `k${n}/drums.webm`}, {name: 'bass', key: `k${n}/bass.webm`}],
    tempo: tempoOf(sectioned), tempoRev: 3, hasChart: false,
    ...overrides,
  };
}

/** In-memory songs API: subscriptions deliver the first value on a microtask; `push*` sends later ones. */
function fakeSongs(song, practice) {
  const subs = {song: null, practice: null};
  let rev = song?.tempoRev ?? 0;
  const api = {
    subs,
    subscribeSong: vi.fn((args, onValue, onError) => {
      subs.song = {onValue, onError};
      queueMicrotask(() => onValue(song ? structuredClone(song) : null));
      return vi.fn();
    }),
    subscribePractice: vi.fn((args, onValue, onError) => {
      subs.practice = {onValue, onError};
      queueMicrotask(() => onValue(practice ? structuredClone(practice) : null));
      return vi.fn();
    }),
    savePractice: vi.fn(async () => null),
    saveTempo: vi.fn(async () => { rev += 1; return {tempoRev: rev, conflict: false}; }),
    dismissSectionSuggestion: vi.fn(async () => null),
    // A pushed row is the server's latest: later saves build on its revision.
    pushSong: (next) => { if (Number.isFinite(next?.tempoRev)) rev = Math.max(rev, next.tempoRev); subs.song.onValue(structuredClone(next)); },
    pushPractice: (next) => subs.practice.onValue(structuredClone(next)),
    get rev() { return rev; },
  };
  return api;
}

function fakeTarget() {
  const target = new EventTarget();
  target.visibilityState = 'visible';
  return target;
}

/** Opens a session over fakes. Returns the session and every fake. */
async function open({song = makeSong(), practice = null, account = {}, persistence = null, duration = 128, jobs, media, desktop, shared, ...extra} = {}) {
  const songs = fakeSongs(song, practice);
  const status = vi.fn();
  const win = fakeTarget(), doc = fakeTarget();
  const flushRequests = [];
  const deps = {
    songs, status,
    media: media ?? {signKeys: vi.fn(async (keys) => Object.fromEntries(keys.map((k) => [k, `https://stems.invalid/${k}`])))},
    jobs: jobs ?? {
      latestDetection: vi.fn(async () => null), subscribeJob: vi.fn(() => vi.fn()), markApplied: vi.fn(async () => null),
      createBeatDetection: vi.fn(), createSectionDetection: vi.fn(), retry: vi.fn(),
    },
    account: {value: signal({practice: {stop: 'cue', countIn: {on: false, length: 1, unit: 'bars'}, click: 'countin', keepPitch: true}, profile: {instruments: ['drums'], primary: 'drums', openWithMyPart: 'in'}, ...account})},
    desktop: desktop ?? {available: false, processor: signal({phase: 'web'}), onFlushRequest: vi.fn((cb) => { flushRequests.push(cb); return vi.fn(); })},
    createEngine: () => { const engine = new MultitrackEngine(); engine.ctx.decodeDuration = duration; return engine; },
    notationPersistence: persistence,
    window: win, document: doc,
    detect: {library: {jobs: signal([]), devices: signal([])}, accountSession: signal({status: 'active'}), navigate: vi.fn()},
    ...(shared ? {shared} : {}),
    ...extra,
  };
  const session = await openSession(song.id, deps);
  return {session, song, songs, status, win, doc, deps, flushRequests};
}

async function ready(session) {
  for (let i = 0; i < 400 && session.load.peek().phase !== 'ready' && session.load.peek().phase !== 'error'; i++) await Promise.resolve();
  return session.load.peek();
}

/** A drum-part persistence for the real part.js. */
function partStore(score) {
  return {load: vi.fn(async () => (score ? structuredClone(score) : null)), set: vi.fn(), flush: vi.fn(async () => {}), destroy: vi.fn(), reload: vi.fn(), blocked: false};
}

const real = (map) => SongMapStore.fromTempo({songMap: map.serialize()}, map.duration).isReal;
const detectedTempo = (duration) => {
  const store = SongMapStore.fromTempo({}, duration);
  store.replaceFromBeats(Array.from({length: 120}, (_, i) => ({time: 0.25 + i * 0.6, downbeat: i % 4 === 0})));
  return {songMap: store.serialize()};
};

describe('open order (spec §4.12: interactive before decode)', () => {
  test('the session resolves before the audio: map, practice and transport first, then signing → loading → ready', async () => {
    const signing = deferred();
    const {session} = await open({practice: {...emptyPractice(), v: 2, rate: 0.75, cue: 20}, media: {signKeys: vi.fn(() => signing.promise)}});
    expect(session.load.peek().phase).toBe('signing');
    expect(session.map.isReal).toBe(true);
    expect(session.practice.value.peek().rate).toBe(0.75);
    expect(peers.transports).toHaveLength(1);
    expect(peers.transports[0].engineTracksAtCreation).toBe(0);   // built over an engine that has not loaded
    expect(peers.transports[0].options).toMatchObject({engine: session.engine, metronome: session.metronome, map: session.map,
      position: session.position, practice: session.practice, undo: session.undo, profile});
    expect(session.deps).toBeUndefined();
    const phases = [];
    session.load.subscribe((l) => phases.push(l.phase));
    const loaded = vi.fn();
    session.on('loaded', loaded);
    signing.resolve(Object.fromEntries(session.song.peek().stems.map((s) => [s.key, `https://stems.invalid/${s.key}`])));
    expect((await ready(session)).phase).toBe('ready');
    expect(phases[0]).toBe('loading');
    expect(phases).toContain('preparing');
    expect(phases.at(-1)).toBe('ready');
    expect(loaded).toHaveBeenCalledOnce();
    expect(peers.transports[0].ready).toHaveBeenCalledOnce();
    expect(peers.transports[0].readyAt).toEqual({tracks: 2, mapDuration: 128});
    expect(peers.transports[0].options).toMatchObject({status: expect.any(Function), stems: ['drums', 'bass'], notation: session.notation});
    expect(peers.transports[0].options.account.practice.stop).toBe('cue');
    expect(session.engine.tracks.map((t) => t.name)).toEqual(['drums', 'bass']);
    expect(session.peaks.ready).toBe(true);
  });

  test('step 7 applies the practice state to the engine and metronome; the click falls back to the account default', async () => {
    const practice = {...emptyPractice(), v: 2, rate: 0.8, cue: 31, keepPitch: false,
      loop: {on: true, a: 28, b: 44, eachPassCount: true, playTimes: 0, between: 'none'},
      tracks: [{name: 'drums', volume: 0.5, muted: true, soloed: false}, {name: 'bass', volume: 1, muted: false, soloed: true}]};
    const {session} = await open({practice, account: {practice: {countIn: {on: true, length: 2, unit: 'beats'}, click: 'always', keepPitch: true}}});
    await ready(session);
    const {engine, metronome} = session;
    expect(engine.rate).toBe(0.8);
    expect(engine.preservePitch).toBe(false);
    expect(engine.loop).toMatchObject({enabled: true, a: 28, b: 44});
    expect(engine.editPosition).toBe(31);
    expect(engine.tracks.find((t) => t.name === 'drums')).toMatchObject({volume: 0.5, muted: true});
    expect(engine.tracks.find((t) => t.name === 'bass').soloed).toBe(true);
    expect(metronome.settings()).toMatchObject({countIn: true, countInLength: 2, countInUnit: 'beats', mode: 'always'});
  });

  test('clickOf: a stored click wins; without one the account countIn and click mode apply (D14)', () => {
    expect(clickOf({countIn: {on: true, length: 4, unit: 'bars'}, mode: 'off', accent: false, volume: 0.3, preRoll: true}, {click: 'always'}))
      .toEqual({countIn: true, countInLength: 4, countInUnit: 'bars', mode: 'off', accent: false, volume: 0.3, audiblePreRoll: true});
    expect(clickOf(undefined, {countIn: {on: true, length: 2, unit: 'beats'}, click: 'always'}))
      .toEqual({countIn: true, countInLength: 2, countInUnit: 'beats', mode: 'always', accent: true, volume: 0.7, audiblePreRoll: false});
    expect(clickOf(undefined, {})).toMatchObject({countIn: false, mode: 'countin'});
  });

  test('setDuration after decode is silent: no map event, no undo step and no tempo save', async () => {
    const {session, songs} = await open({song: makeSong({duration: 100, tempo: tempoOf(sectioned)}), duration: 128});
    const events = vi.fn();
    session.map.subscribe(events);
    await ready(session);
    expect(session.map.duration).toBe(128);
    expect(events).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS * 3);
    await tick();
    expect(songs.saveTempo).not.toHaveBeenCalled();
    expect(session.undo.size).toEqual({undo: 0, redo: 0});
    expect(session.map.undoStack).toHaveLength(0);
  });

  test('the one-way upgrade of a 1.6–1.9 map is not saved on open', async () => {
    const legacy = {songMap: structuredClone(sectioned.tempo.songMap)};
    delete legacy.songMap.origin;
    const {session, songs} = await open({song: makeSong({tempo: legacy})});
    await ready(session);
    expect(session.map.data.origin).toBe('edited');
    vi.advanceTimersByTime(2000);
    await tick();
    expect(songs.saveTempo).not.toHaveBeenCalled();
  });

  test('"Open with my part Out" mutes my stems on a song with no saved practice, without an undo step', async () => {
    const {session} = await open({account: {profile: {instruments: ['drums'], primary: 'drums', openWithMyPart: 'out'}}});
    expect(session.practice.value.peek()).toMatchObject({minusMe: true});
    expect(session.practice.value.peek().tracks.find((t) => t.name === 'drums').muted).toBe(true);
    expect(session.undo.size.undo).toBe(0);
    await ready(session);
    expect(session.engine.tracks.find((t) => t.name === 'drums').muted).toBe(true);
    const saved = await open({practice: {...emptyPractice(), v: 2}, account: {profile: {instruments: ['drums'], primary: 'drums', openWithMyPart: 'out'}}});
    expect(saved.session.practice.value.peek().minusMe).toBe(false);
  });

  test('a deep link at boot waits briefly for the account settings, so "my part Out" still applies', async () => {
    const song = makeSong();
    const songs = fakeSongs(song, null);
    const value = signal({practice: {}, profile: {instruments: [], primary: null, openWithMyPart: 'in'}});
    const loaded = signal(false);
    const opening = openSession(song.id, {songs, status: vi.fn(), window: null, document: null, account: {value, loaded},
      createEngine: () => { const e = new MultitrackEngine(); e.ctx.decodeDuration = 128; return e; },
      media: {signKeys: vi.fn(async (keys) => Object.fromEntries(keys.map((k) => [k, `https://stems.invalid/${k}`])))},
      jobs: {latestDetection: vi.fn(async () => null), subscribeJob: vi.fn(() => vi.fn())},
      detect: {library: {jobs: signal([]), devices: signal([])}, accountSession: signal({status: 'active'}), navigate: vi.fn()}});
    await tick();
    // The first settings.config arrives after songs.get.
    value.value = {practice: {}, profile: {instruments: ['drums'], primary: 'drums', openWithMyPart: 'out'}};
    loaded.value = true;
    const session = await opening;
    expect(session.practice.value.peek().minusMe).toBe(true);
    expect(session.practice.value.peek().tracks.find((t) => t.name === 'drums').muted).toBe(true);

    // Settings that never arrive do not hold the song: the open goes ahead after ACCOUNT_WAIT_MS.
    const late = openSession(song.id, {songs: fakeSongs(song, null), status: vi.fn(), window: null, document: null,
      account: {value: signal({practice: {}, profile: {instruments: [], primary: null, openWithMyPart: 'in'}}), loaded: signal(false)},
      createEngine: () => new MultitrackEngine(), media: {signKeys: vi.fn(() => new Promise(() => {}))},
      detect: {library: {jobs: signal([]), devices: signal([])}, accountSession: signal({status: 'active'}), navigate: vi.fn()}});
    let settled = false;
    void late.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(ACCOUNT_WAIT_MS);
    await tick();
    expect(settled).toBe(true);
  });

  test('a song that no longer exists rejects with not_found', async () => {
    const songs = fakeSongs(null, null);
    await expect(openSession('gone', {songs, status: vi.fn(), window: null, document: null})).rejects.toMatchObject({code: 'not_found', message: COPY.notFound});
    expect(songs.subscribeSong.mock.results[0].value).toHaveBeenCalled();   // both subscriptions are closed
    expect(songs.subscribePractice.mock.results[0].value).toHaveBeenCalled();
  });
});

describe('load errors (spec §4.12) and retry', () => {
  test('storage, missing stem and codec failures are reported by kind; retry loads again', async () => {
    const storage = await open({media: {signKeys: vi.fn(async () => { throw new ApiError({code: 'unknown', message: 'offline'}); })}});
    expect((await ready(storage.session)).error).toMatchObject({kind: 'storage', message: 'offline'});
    const errors = vi.fn();
    storage.session.on('error', errors);
    await storage.session.retry();
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({kind: 'storage', message: 'offline'}));

    const missing = await open({media: {signKeys: vi.fn(async (keys) => ({[keys[0]]: 'https://stems.invalid/a'}))}});
    expect((await ready(missing.session)).error).toEqual({kind: 'missing', message: COPY.missing(['bass']), missing: ['bass']});

    const codec = await open({createEngine: () => { const e = new MultitrackEngine(); e.ctx.decodeAudioData = async () => { throw new Error('Unable to decode audio data'); }; return e; }});
    expect((await ready(codec.session)).error.kind).toBe('codec');

    let fail = true;
    const flaky = await open({media: {signKeys: vi.fn(async (keys) => { if (fail) throw new Error('timeout'); return Object.fromEntries(keys.map((k) => [k, `https://stems.invalid/${k}`])); })}});
    expect((await ready(flaky.session)).phase).toBe('error');
    fail = false;
    await flaky.session.retry();
    expect((await ready(flaky.session)).phase).toBe('ready');
    expect(flaky.session.load.peek().error).toBeNull();
  });
});

describe('the drum part at open (§2.14.1 step 5)', () => {
  test('legacy timeline adoption runs before the part opens, with no undo step; the changed map is saved once', async () => {
    const score = emptyScore(128, 100);
    const persistence = partStore(score);
    const replace = vi.spyOn(SongMapStore.prototype, 'replaceFromTimeline');
    const {session, songs} = await open({song: makeSong({tempo: tempoOf(legacyTempoMap), duration: 128, hasChart: true}), persistence});
    await session.notation.ready;
    expect(session.notation.part).not.toBeNull();
    // The map took the part's timeline (100 bpm), so the part fitted without a part-fit rebuild.
    expect(session.map.data.measures.map((m) => m.id)).toEqual(score.timeline.measures.map((m) => m.id));
    expect(session.map.data.origin).toBe('imported');
    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
    expect(session.notation.part.score.timeline.measures.map((m) => m.id)).toEqual(score.timeline.measures.map((m) => m.id));
    expect(session.undo.size.undo).toBe(0);
    expect(session.map.undoStack).toHaveLength(0);
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS);
    await tick();
    expect(songs.saveTempo).toHaveBeenCalledOnce();
    expect(songs.saveTempo.mock.calls[0][0].tempo.songMap.origin).toBe('imported');
  });

  test('a stored part that fits the map changes nothing and saves no tempo; a misfit rebuilds with part-fit, no undo', async () => {
    const fits = await open({song: makeSong({hasChart: true}), persistence: partStore(null)});
    await fits.session.notation.ready;
    vi.advanceTimersByTime(2000);
    await tick();
    expect(fits.songs.saveTempo).not.toHaveBeenCalled();
    expect(fits.session.undo.size.undo).toBe(0);

    const misfit = emptyScore(200, 90, 3, 4);   // 100 bars of 3/4: bar 91 has no bar in the 64-bar map
    misfit.bars = [{measureId: misfit.timeline.measures[90].id, coverage: 'progress', hits: [{id: 'h1', offset: {n: 0, d: 1}, instrument: 'kick', voice: 2, accent: false, ghost: false, flam: false, sticking: '', velocity: 0.75}]}];
    const replace = vi.spyOn(SongMapStore.prototype, 'replaceFromTimeline');
    const rebuilt = await open({song: makeSong({hasChart: true}), persistence: partStore(misfit)});
    await rebuilt.session.notation.ready;
    expect(replace).toHaveBeenCalledWith(expect.anything(), 'part-fit');
    replace.mockRestore();
    expect(rebuilt.session.map.data.origin).toBe('imported');
    expect(rebuilt.session.undo.size.undo).toBe(0);
    expect(rebuilt.session.map.undoStack).toHaveLength(0);
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS);
    await tick();
    expect(rebuilt.songs.saveTempo).toHaveBeenCalledOnce();
  });

  test('the notation map guard is installed once (by the part), and a song with notation counts as mapped', async () => {
    const score = emptyScore(30, 120);
    score.bars = [{measureId: score.timeline.measures[0].id, coverage: 'reviewed', hits: []}];
    // A 1.5 song (no songMap) whose drum part has notation but the default tempo: mapped only by its part.
    const song = makeSong({tempo: {}, duration: 30, hasChart: false});
    const spy = vi.spyOn(SongMapStore.prototype, 'setGuard');
    const {session} = await open({song, duration: 30, persistence: partStore(score)});
    expect(session.position.mapped.peek()).toBe(false);
    await session.notation.ready;
    expect(spy.mock.calls.filter(([name]) => name === 'notation')).toHaveLength(1);
    expect(session.map.guards.size).toBe(1);
    expect(session.notation.hasNotation.peek()).toBe(true);
    expect(session.map.isReal).toBe(true);
    expect(session.position.mapped.peek()).toBe(true);   // refreshed by hand after setHasPart
    spy.mockRestore();
  });

  test('song.hasChart counts as mapped from the first render, before the part opens', async () => {
    const {session} = await open({song: makeSong({tempo: tempoOf(unmapped), duration: 30, hasChart: true}), duration: 30, persistence: partStore(null)});
    expect(session.map.isReal).toBe(true);
    expect(session.position.mapped.peek()).toBe(true);
  });

  test('a mapped song without a chart opens no part', async () => {
    const {session} = await open();
    await session.notation.ready;
    expect(session.notation.part).toBeNull();
  });
});

describe('tempo persistence and adoption (D53)', () => {
  const editLabel = (session, text = 'Riff') => session.map.edit((d) => { d.measures[3].label = text; }, 'label');

  test('a map edit saves {songMap} 400 ms later with baseRev and a fresh saveId', async () => {
    const {session, songs} = await open();
    await ready(session);
    editLabel(session);
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS - 1);
    expect(songs.saveTempo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await tick();
    expect(songs.saveTempo).toHaveBeenCalledOnce();
    const args = songs.saveTempo.mock.calls[0][0];
    expect(Object.keys(args.tempo)).toEqual(['songMap']);
    expect(args).toMatchObject({id: session.id, baseRev: 3});
    expect(args.saveId).toMatch(/^[0-9a-f-]{36}$/);
    editLabel(session, 'Riff 2');
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS);
    await tick();
    expect(songs.saveTempo.mock.calls[1][0].baseRev).toBe(4);
    expect(songs.saveTempo.mock.calls[1][0].saveId).not.toBe(args.saveId);
  });

  test('our own save echoing before the mutation resolves is ignored (no adoption, no undo step)', async () => {
    const {session, songs, song} = await open();
    await ready(session);
    const pending = deferred();
    songs.saveTempo.mockImplementationOnce(() => pending.promise);
    editLabel(session);
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS);
    await tick();
    const {saveId, tempo} = songs.saveTempo.mock.calls[0][0];
    const adopted = vi.fn();
    session.on('tempo-adopted', adopted);
    const before = session.map.snapshot();
    songs.pushSong({...song, tempo, tempoRev: 4, tempoSaveId: saveId});
    expect(adopted).not.toHaveBeenCalled();
    expect(session.map.snapshot()).toEqual(before);
    pending.resolve({tempoRev: 4, conflict: false});
    await tick();
    // A later foreign change is adopted against the echoed revision.
    const next = structuredClone(tempo);
    next.songMap.measures[5].label = 'From the iPad';
    songs.pushSong({...song, tempo: next, tempoRev: 5, tempoSaveId: 'someone-else'});
    expect(adopted).toHaveBeenCalledOnce();
    expect(session.map.data.measures[5].label).toBe('From the iPad');
    expect(session.undo.size.undo).toBe(0);   // real → real: adopted silently
  });

  test('every recent saveId is remembered (≤ 200)', async () => {
    const {session, songs, song} = await open();
    await ready(session);
    const ids = [];
    for (let i = 0; i < 3; i++) {
      editLabel(session, `L${i}`);
      vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS);
      await tick();
      ids.push(songs.saveTempo.mock.calls.at(-1)[0]);
    }
    const adopted = vi.fn();
    session.on('tempo-adopted', adopted);
    songs.pushSong({...song, tempo: ids[0].tempo, tempoRev: 99, tempoSaveId: ids[0].saveId});
    expect(adopted).not.toHaveBeenCalled();
    expect(OWN_SAVE_IDS).toBe(200);
  });

  test('a foreign real map on an unmapped song is one practice-undo step with "Bars found · Undo"', async () => {
    const song = makeSong({tempo: tempoOf(unmapped), duration: 72});
    const {session, songs, status} = await open({song, duration: 72});
    await ready(session);
    const placeholder = session.map.snapshot();
    const real = vi.fn();
    session.on('map-real', real);
    songs.pushSong({...song, tempo: detectedTempo(72), tempoRev: 4, tempoSaveId: undefined});
    expect(session.map.isReal).toBe(true);
    expect(session.map.data.origin).toBe('detected');
    expect(session.undo.size.undo).toBe(1);
    expect(session.map.undoStack).toHaveLength(0);
    expect(real).toHaveBeenCalledOnce();
    const [text, opts] = status.mock.calls.find(([t]) => t === COPY.barsFound);
    expect(text).toBe('Bars found');
    expect(opts.action.label).toBe('Undo');
    opts.action.run();
    expect(session.map.snapshot()).toEqual(placeholder);
    expect(session.map.isReal).toBe(false);
    // Undoing saves the old map back (through baseRev).
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS);
    await tick();
    expect(songs.saveTempo).toHaveBeenCalledOnce();
    expect(songs.saveTempo.mock.calls[0][0].baseRev).toBe(4);
  });

  test('with Edit · Map mounted the same adoption is one map-stack step', async () => {
    const song = makeSong({tempo: tempoOf(unmapped), duration: 72});
    const {session, songs, status} = await open({song, duration: 72});
    await ready(session);
    const editorUndo = vi.fn(() => session.map.undo());
    session.mapEditor.value = {auditioning: signal(false), undo: editorUndo};
    songs.pushSong({...song, tempo: detectedTempo(72), tempoRev: 4});
    expect(session.map.undoStack).toHaveLength(1);
    expect(session.undo.size.undo).toBe(0);
    const [, opts] = status.mock.calls.find(([t]) => t === COPY.barsFound);
    opts.action.run();
    expect(editorUndo).toHaveBeenCalled();
    expect(session.map.isReal).toBe(false);
  });

  test('a foreign change while local edits are pending is ignored; the next save resolves through baseRev', async () => {
    const {session, songs, song} = await open();
    await ready(session);
    editLabel(session, 'Mine');
    const theirs = structuredClone(song.tempo);
    theirs.songMap.measures[5].label = 'Theirs';
    songs.pushSong({...song, tempo: theirs, tempoRev: 7});
    expect(session.map.data.measures[3].label).toBe('Mine');
    expect(session.map.data.measures[5].label).not.toBe('Theirs');
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS);
    await tick();
    expect(songs.saveTempo.mock.calls[0][0].baseRev).toBe(3);
  });

  test('a foreign change that arrives while our save is in flight is adopted once the save resolves', async () => {
    const {session, songs, song} = await open();
    await ready(session);
    const pending = deferred();
    songs.saveTempo.mockImplementationOnce(() => pending.promise);
    editLabel(session, 'Mine');
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS);
    await tick();
    expect(songs.saveTempo).toHaveBeenCalledOnce();
    // The server applied ours as rev 4, then the other device's as rev 5; rev 5 reaches us first.
    const theirs = structuredClone(songs.saveTempo.mock.calls[0][0].tempo);
    theirs.songMap.measures[5].label = 'Theirs';
    songs.pushSong({...song, tempo: theirs, tempoRev: 5, tempoSaveId: 'other-device'});
    expect(session.map.data.measures[5].label).not.toBe('Theirs');   // held while our save is in flight
    pending.resolve({tempoRev: 4, conflict: false});
    await tick();
    expect(session.map.data.measures[5].label).toBe('Theirs');
    expect(session.map.data.measures[3].label).toBe('Mine');
    expect(session.pending).toBe(false);
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS * 2);
    await tick();
    expect(songs.saveTempo).toHaveBeenCalledOnce();
    // Our next edit builds on their revision.
    editLabel(session, 'Mine again');
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS);
    await tick();
    expect(songs.saveTempo.mock.calls[1][0].baseRev).toBe(5);
  });

  test('a foreign change held back by a local edit is adopted when that edit is undone inside the debounce', async () => {
    const {session, songs, song} = await open();
    await ready(session);
    session.mapChange('Rename', (m) => m.edit((d) => { d.measures[3].label = 'Mine'; }, 'label'));
    const theirs = structuredClone(song.tempo);
    theirs.songMap.measures[5].label = 'Theirs';
    songs.pushSong({...song, tempo: theirs, tempoRev: 6});
    expect(session.map.data.measures[5].label).not.toBe('Theirs');
    session.undo.undo();
    expect(session.map.data.measures[5].label).toBe('Theirs');
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS * 2);
    await tick();
    expect(songs.saveTempo).not.toHaveBeenCalled();
    expect(session.pending).toBe(false);
  });

  test('a foreign real map arriving during a Find a chart audition waits; after Keep my map it is adopted', async () => {
    const song = makeSong({tempo: tempoOf(unmapped), duration: 72});
    const {session, songs, status} = await open({song, duration: 72});
    await ready(session);
    const auditioning = signal(true);
    session.mapEditor.value = {auditioning, undo: vi.fn()};
    songs.pushSong({...song, tempo: detectedTempo(72), tempoRev: 4});
    expect(session.map.isReal).toBe(false);
    // Keep my map: the batch is aborted and the audition ends with the map unchanged.
    session.map.beginBatch();
    session.map.abortBatch();
    auditioning.value = false;
    expect(session.map.isReal).toBe(true);
    expect(session.map.data.origin).toBe('detected');
    expect(session.map.undoStack).toHaveLength(1);   // one map-stack step (Edit · Map is mounted)
    expect(status.mock.calls.some(([t]) => t === COPY.barsFound)).toBe(true);
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS * 2);
    await tick();
    expect(songs.saveTempo).not.toHaveBeenCalled();
    expect(session.pending).toBe(false);
  });

  test('a conflict answer during an audition is not dropped: the save after the audition meets it again and adopts', async () => {
    const song = makeSong({tempo: tempoOf(unmapped), duration: 72});
    const {session, songs, status} = await open({song, duration: 72});
    await ready(session);
    const stored = detectedTempo(72);
    const first = deferred();
    songs.saveTempo.mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => ({tempoRev: 9, conflict: true, tempo: stored}));
    session.map.edit((d) => { d.measures[1].label = 'Verse'; }, 'restore');
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS);
    await tick();
    const auditioning = signal(true);
    session.mapEditor.value = {auditioning, undo: vi.fn()};
    first.resolve({tempoRev: 9, conflict: true, tempo: stored});
    await tick();
    expect(session.map.isReal).toBe(false);
    expect(session.pending).toBe(true);   // the server holds a different map
    auditioning.value = false;
    session.mapEditor.value = null;
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS);
    await tick();
    expect(songs.saveTempo).toHaveBeenCalledTimes(2);
    expect(songs.saveTempo.mock.calls[1][0].baseRev).toBe(3);   // still the stale revision: the server reports the conflict
    expect(session.map.data.origin).toBe('detected');
    expect(status.mock.calls.some(([t]) => t === COPY.keptMap)).toBe(true);
    expect(session.pending).toBe(false);
  });

  test('the tempo conflict answer adopts the stored map as one undo step: "Kept the map from your other device · Undo"', async () => {
    const song = makeSong({tempo: tempoOf(unmapped), duration: 72});
    const {session, songs, status} = await open({song, duration: 72});
    await ready(session);
    const stored = detectedTempo(72);
    songs.saveTempo.mockImplementationOnce(async () => ({tempoRev: 9, conflict: true, tempo: stored}));
    // A local change that keeps the map unmapped (no origin), e.g. undoing an adoption.
    session.map.edit((d) => { d.measures[1].label = 'Verse'; }, 'restore');
    expect(session.map.isReal).toBe(false);
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS);
    await tick();
    expect(songs.saveTempo).toHaveBeenCalledOnce();
    expect(session.map.data.origin).toBe('detected');
    expect(session.undo.size.undo).toBe(1);
    const call = status.mock.calls.find(([t]) => t === COPY.keptMap);
    expect(call[1].action.label).toBe('Undo');
    // The adopted map is what the server has: no further save.
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS * 2);
    await tick();
    expect(songs.saveTempo).toHaveBeenCalledOnce();
  });

  test('saves are suspended while Edit · Map auditions a chart (D20) and resume when it ends', async () => {
    const {session, songs} = await open({song: makeSong({hasChart: true}), persistence: partStore(null)});
    await ready(session);
    await session.notation.ready;
    const auditioning = signal(true);
    session.mapEditor.value = {auditioning, undo: vi.fn()};
    expect(session.notation.mapSyncPaused).toBe(true);
    expect(session.notation.part.mapSyncPaused).toBe(true);
    session.map.beginBatch();
    editLabel(session, 'Their intro');
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS * 3);
    await session.flush();
    expect(songs.saveTempo).not.toHaveBeenCalled();
    // Keep my map: abortBatch restores silently → nothing to save.
    session.map.abortBatch();
    auditioning.value = false;
    expect(session.notation.mapSyncPaused).toBe(false);
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS * 3);
    await tick();
    expect(songs.saveTempo).not.toHaveBeenCalled();
    // Use their map: the change stays and is saved once the audition ends.
    auditioning.value = true;
    session.map.beginBatch();
    editLabel(session, 'Their intro');
    session.map.endBatch();
    auditioning.value = false;
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS);
    await tick();
    expect(songs.saveTempo).toHaveBeenCalledOnce();
  });

  test('suspendSaves holds saves; resuming with {changed: true} saves at once', async () => {
    const {session, songs} = await open();
    await ready(session);
    session.suspendSaves(true);
    editLabel(session, 'Held');
    vi.advanceTimersByTime(TEMPO_DEBOUNCE_MS * 2);
    await tick();
    expect(songs.saveTempo).not.toHaveBeenCalled();
    session.suspendSaves(false, {changed: true});
    await tick();
    expect(songs.saveTempo).toHaveBeenCalledOnce();
  });
});

describe('mapChange (D23)', () => {
  test('outside Edit · Map: one compound practice-undo entry that restores snapshots; null when nothing changed', async () => {
    const {session, status} = await open();
    await ready(session);
    const before = session.map.snapshot();
    const result = session.mapChange('Rename section', (m) => m.edit((d) => { d.measures[8].label = 'Verse A'; }, 'label'), {status: {text: 'Renamed', undoLabel: 'Undo'}});
    expect(result.entry).toMatchObject({key: 'map', label: 'Rename section'});
    expect(session.map.undoStack).toHaveLength(0);
    expect(session.undo.size.undo).toBe(1);
    expect(status).toHaveBeenCalledWith('Renamed', expect.objectContaining({action: expect.objectContaining({label: 'Undo'})}));
    session.undo.undo();
    expect(session.map.snapshot()).toEqual(before);
    session.undo.redo();
    expect(session.map.data.measures[8].label).toBe('Verse A');
    expect(session.mapChange('Nothing', () => {})).toBeNull();
    expect(session.undo.size.undo).toBe(1);
  });

  test('with Edit · Map mounted: one map-stack step; refused while auditioning', async () => {
    const {session} = await open();
    await ready(session);
    session.mapEditor.value = {auditioning: signal(false), undo: vi.fn()};
    const result = session.mapChange('Two labels', (m) => {
      m.edit((d) => { d.measures[1].label = 'A'; }, 'label');
      m.edit((d) => { d.measures[2].label = 'B'; }, 'label');
    });
    expect(result).toEqual({entry: null});
    expect(session.map.undoStack).toHaveLength(1);
    expect(session.undo.size.undo).toBe(0);
    session.mapEditor.value = {auditioning: signal(true), undo: vi.fn()};
    expect(session.mapChange('Locked', (m) => m.edit((d) => { d.measures[3].label = 'C'; }, 'label'))).toBeNull();
    expect(session.map.data.measures[3].label).toBe('');
  });

  test('a map change re-anchors the loop and spots by bar ref', async () => {
    const ref = (id) => ({id, beat: 0, frac: 0});
    const practice = {...emptyPractice(), v: 2, loop: {on: true, a: 16, b: 32, aBar: ref('g8'), bBar: ref('g16'), eachPassCount: true, playTimes: 0, between: 'none'}};
    const {session} = await open({practice});
    await ready(session);
    session.mapChange('Slower', (m) => m.edit((d) => { d.tailQpm = 60; }, 'tempo'));
    expect(session.practice.value.peek().loop).toMatchObject({a: 32, b: 64});
  });
});

describe('not real → real: the markers offer with an amended undo entry', () => {
  const markers = [{id: 'm1', t: 4.1, label: 'Groove', updatedAt: T0 - 1000}, {id: 'm2', t: 20.2, label: 'Fill', updatedAt: T0 - 1000}];

  test('Turn into sections amends the adoption entry: one Undo reverts the map and the markers together', async () => {
    const song = makeSong({tempo: tempoOf(unmapped), duration: 72});
    const {session, songs, status} = await open({song, duration: 72, practice: {...emptyPractice(), v: 2, markers}});
    await ready(session);
    songs.pushSong({...song, tempo: detectedTempo(72), tempoRev: 4});
    const offer = status.mock.calls.find(([t]) => t === COPY.turnMarkers(2));
    expect(offer[1]).toMatchObject({durationMs: 8000, action: {label: COPY.turnAction}});
    offer[1].action.run();
    expect(session.map.sections.map((s) => s.label)).toEqual(expect.arrayContaining(['Groove', 'Fill']));
    expect(session.practice.value.peek().markers.filter((m) => !m.deleted)).toHaveLength(0);
    expect(session.undo.size.undo).toBe(1);
    session.undo.undo();
    expect(session.map.isReal).toBe(false);
    expect(session.map.sections).toHaveLength(0);
    expect(session.practice.value.peek().markers.filter((m) => !m.deleted).map((m) => m.id).sort()).toEqual(['m1', 'm2']);
    session.undo.redo();
    expect(session.map.isReal).toBe(true);
    expect(session.map.sections.map((s) => s.label)).toEqual(expect.arrayContaining(['Groove', 'Fill']));
    expect(session.practice.value.peek().markers.filter((m) => !m.deleted)).toHaveLength(0);
  });

  test('redoing the amended entry restores map and markers without offering the markers again', async () => {
    const song = makeSong({tempo: tempoOf(unmapped), duration: 72});
    const {session, songs, status} = await open({song, duration: 72, practice: {...emptyPractice(), v: 2, markers}});
    await ready(session);
    songs.pushSong({...song, tempo: detectedTempo(72), tempoRev: 4});
    status.mock.calls.find(([t]) => t === COPY.turnMarkers(2))[1].action.run();
    session.undo.undo();
    status.mockClear();
    session.undo.redo();
    expect(session.map.isReal).toBe(true);
    expect(session.practice.value.peek().markers.filter((m) => !m.deleted)).toHaveLength(0);
    expect(status.mock.calls.some(([t]) => /marker/i.test(t))).toBe(false);
  });

  test('no offer without live markers; a later conversion after other edits is its own step', async () => {
    const song = makeSong({tempo: tempoOf(unmapped), duration: 72});
    const quiet = await open({song, duration: 72});
    await ready(quiet.session);
    quiet.songs.pushSong({...song, tempo: detectedTempo(72), tempoRev: 4});
    expect(quiet.status.mock.calls.some(([t]) => /marker/.test(t))).toBe(false);

    const song2 = makeSong({tempo: tempoOf(unmapped), duration: 72});
    const busy = await open({song: song2, duration: 72, practice: {...emptyPractice(), v: 2, markers}});
    await ready(busy.session);
    busy.songs.pushSong({...song2, tempo: detectedTempo(72), tempoRev: 4});
    const offer = busy.status.mock.calls.find(([t]) => t === COPY.turnMarkers(2));
    busy.session.mapChange('Rename', (m) => m.edit((d) => { d.measures[10].label = 'Later'; }, 'label'));
    offer[1].action.run();
    expect(busy.session.undo.size.undo).toBe(3);
  });
});

describe('spot counters (spec: "14 times through")', () => {
  test('a pass over the active spot counts; a loop edit clears the active spot', async () => {
    const spot = {id: 's1', name: 'Bridge walk-up', a: 80, b: 96, rate: 0.8, passes: 2, updatedAt: T0 - 5000};
    const practice = {...emptyPractice(), v: 2, spots: [spot], loop: {on: true, a: 80, b: 96, eachPassCount: true, playTimes: 0, between: 'none'}};
    const {session} = await open({practice});
    await ready(session);
    const transport = peers.transports.at(-1);
    session.practice.activeSpotId.value = 's1';
    transport.emit('pass', {pass: 1});
    transport.emit('pass', {pass: 2});
    const counted = session.practice.value.peek().spots[0];
    expect(counted.passes).toBe(4);
    expect(counted.lastAt).toBe(T0);
    expect(session.undo.size.undo).toBe(0);
    session.practice.patch((p) => { p.loop.b = 98; });
    expect(session.practice.activeSpotId.peek()).toBeNull();
    transport.emit('pass', {pass: 3});
    expect(session.practice.value.peek().spots[0].passes).toBe(4);
  });

  test('opening a spot (active id set before or after its loop) keeps it active', async () => {
    const spot = {id: 's1', name: 'Chorus', a: 30, b: 46, rate: 1, passes: 0, updatedAt: T0 - 5000};
    const {session} = await open({practice: {...emptyPractice(), v: 2, spots: [spot]}});
    session.practice.activeSpotId.value = 's1';
    session.practice.patch((p) => { p.loop = {...p.loop, on: true, a: 30, b: 46}; });
    expect(session.practice.activeSpotId.peek()).toBe('s1');
    peers.transports.at(-1).emit('pass', {pass: 1});
    expect(session.practice.value.peek().spots[0].passes).toBe(1);
  });
});

describe('chart audio follows practice.chartAudio (D27)', () => {
  test('a stored level is applied at open, and later changes apply to the shared DrumAudio', async () => {
    const {session} = await open({practice: {...emptyPractice(), v: 2, chartAudio: 'quiet'}});
    expect(session.notation.chartAudio).toBe('quiet');
    expect(session.notation.drumAudio.mode).toBe('both');
    expect(session.notation.drumAudio.level).toBeCloseTo(0.35);
    session.practice.patch({chartAudio: 'off'});
    expect(session.notation.drumAudio.mode).toBe('recording');
  });
});

describe('flush (final on leave, pagehide, hidden, desktop flush, dispose)', () => {
  test('each trigger saves practice with the right final flag', async () => {
    const {session, songs, win, doc, flushRequests} = await open();
    await ready(session);
    const change = (rate) => session.practice.patch({rate});
    change(0.9);
    await session.flush();
    expect(songs.savePractice.mock.calls.at(-1)[0].final).toBe(false);
    change(0.85);
    win.dispatchEvent(new Event('pagehide'));
    await tick();
    expect(songs.savePractice.mock.calls.at(-1)[0]).toMatchObject({final: true, id: session.id});
    change(0.8);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(songs.savePractice.mock.calls.at(-1)[0].final).toBe(true);
    change(0.75);
    await flushRequests[0]();
    expect(songs.savePractice.mock.calls.at(-1)[0]).toMatchObject({final: true, practice: expect.objectContaining({rate: 0.75})});
  });

  test('flush also saves a pending tempo change and the drum part', async () => {
    const persistence = partStore(null);
    const {session, songs} = await open({song: makeSong({hasChart: true}), persistence});
    await ready(session);
    await session.notation.ready;
    session.map.edit((d) => { d.measures[3].label = 'Now'; }, 'label');
    await session.flush({final: true});
    expect(songs.saveTempo).toHaveBeenCalledOnce();
    expect(persistence.flush).toHaveBeenCalled();
  });
});

describe('the cache: getSession, disposeSession, activeSession', () => {
  test('getSession is cached by id; dispose flushes with final, then destroys engine, metronome and notation', async () => {
    const song = makeSong();
    const songs = fakeSongs(song, {...emptyPractice(), v: 2});
    // The default dependencies use the app's API modules; replace them for this test through vi.spyOn.
    const songsModule = await import('../src/api/songs.js');
    const media = await import('../src/api/media.js');
    vi.spyOn(songsModule, 'subscribeSong').mockImplementation(songs.subscribeSong);
    vi.spyOn(songsModule, 'subscribePractice').mockImplementation(songs.subscribePractice);
    vi.spyOn(songsModule, 'savePractice').mockImplementation(songs.savePractice);
    vi.spyOn(media, 'signKeys').mockImplementation(async (keys) => Object.fromEntries(keys.map((k) => [k, `https://stems.invalid/${k}`])));
    appStore.account.value = {};   // the account settings have arrived (the open waits for them briefly)
    const first = getSession(song.id);
    expect(getSession(song.id)).toBe(first);
    const session = await first;
    expect(activeSession()).toBe(session);
    session.practice.patch({rate: 0.9});
    const destroyEngine = vi.spyOn(session.engine, 'destroy');
    const destroyMetronome = vi.spyOn(session.metronome, 'destroy');
    const destroyNotation = vi.spyOn(session.notation, 'destroy');
    await disposeSession(song.id);
    expect(songs.savePractice.mock.calls.at(-1)[0].final).toBe(true);
    expect(destroyEngine).toHaveBeenCalled();
    expect(destroyMetronome).toHaveBeenCalled();
    expect(destroyNotation).toHaveBeenCalled();
    expect(peers.transports.at(-1).destroyed).toBe(true);
    expect(activeSession()).toBeNull();
    expect(session.disposed).toBe(true);
    const again = getSession(song.id);
    expect(again).not.toBe(first);
    await disposeSession(song.id);
    appStore.account.value = null;
  });

  test('a failed open is not cached', async () => {
    const songsModule = await import('../src/api/songs.js');
    const songs = fakeSongs(null, null);
    vi.spyOn(songsModule, 'subscribeSong').mockImplementation(songs.subscribeSong);
    vi.spyOn(songsModule, 'subscribePractice').mockImplementation(songs.subscribePractice);
    await expect(getSession('missing')).rejects.toMatchObject({code: 'not_found'});
    const retry = getSession('missing');
    await expect(retry).rejects.toMatchObject({code: 'not_found'});
    expect(songs.subscribeSong).toHaveBeenCalledTimes(2);
  });
});

describe('shared (read-only) sessions (§2.18 step 9)', () => {
  test('the snapshot opens read-only: practice from the snapshot, urls from resolveUrls, no tempo saves', async () => {
    const storage = new Map();
    vi.stubGlobal('localStorage', {getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k)});
    const snapshot = {...makeSong({id: 'shared-song'}), practice: {...emptyPractice(), v: 2, rate: 0.7}};
    // sharing.playback's shape (§2.18: resolveUrls is shareAudio.playback): ({token}) → {key: url}.
    const resolveUrls = vi.fn(async ({token}) => {
      if (token !== 'tok-1') throw new Error('no token');
      return Object.fromEntries(snapshot.stems.map((s) => [s.key, `https://share.invalid/${s.key}`]));
    });
    const songs = fakeSongs(snapshot, null);
    const session = await openSession('shared-song', {songs, status: vi.fn(), window: null, document: null,
      account: {value: signal({practice: {}, profile: {instruments: [], primary: null, openWithMyPart: 'in'}})},
      shared: {token: 'tok-1', snapshot, resolveUrls, cacheNamespace: 'share:'}});
    expect(session).toMatchObject({readOnly: true, shareToken: 'tok-1'});
    expect(songs.subscribeSong).not.toHaveBeenCalled();
    expect(session.practice.value.peek().rate).toBe(0.7);
    expect('practice' in session.song.peek()).toBe(false);
    await ready(session);
    expect(resolveUrls).toHaveBeenCalledOnce();
    expect(resolveUrls).toHaveBeenCalledWith({token: 'tok-1'});
    expect(session.load.peek().phase).toBe('ready');
    expect(session.mapChange('No', (m) => m.edit((d) => { d.measures[0].label = 'X'; }, 'label'))).toBeNull();
    session.practice.patch({rate: 0.6});
    await session.flush({final: true});
    expect(songs.savePractice).not.toHaveBeenCalled();
    expect(songs.saveTempo).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get('ws.share.tok-1')).rate).toBe(0.6);
    await session.dispose();
    vi.unstubAllGlobals();
  });
});

test('an own detection on an unmapped song reads "Beat grid found" when the server writes the map', async () => {
  const song = makeSong({tempo: tempoOf(unmapped), duration: 72});
  const jobs = {latestDetection: vi.fn(async () => null), subscribeJob: vi.fn(() => vi.fn()), markApplied: vi.fn(async () => null),
    createBeatDetection: vi.fn(async () => ({jobId: 'job-1'})), createSectionDetection: vi.fn(), retry: vi.fn()};
  const {session, songs, status} = await open({song, duration: 72, jobs,
    detect: {library: {jobs: signal([]), devices: signal([{deviceId: 'dev-1', name: 'MacBook Pro', state: 'idle', lastSeenAt: T0 - 1000}])}, accountSession: signal({status: 'active'}), navigate: vi.fn()}});
  await ready(session);
  await session.detect.start();
  expect(jobs.createBeatDetection).toHaveBeenCalledWith({songId: song.id, deviceId: 'dev-1'});
  songs.pushSong({...song, tempo: detectedTempo(72), tempoRev: 4});
  expect(status.mock.calls.some(([t]) => t === 'Beat grid found')).toBe(true);
  expect(real(session.map)).toBe(true);
});
