// @vitest-environment node
// The detect flow (architecture §2.14.1 detect.js, D44, D47, B5): where a
// detection runs, dedupe, the progress line, applying results on the right
// undo stack, the server-applied path, the resume offer, suggestions and error
// copy. The flows run inside real sessions (openSession over fakes); the
// transport (ST1a) and feedback (S2) peers are mocked by their contract paths.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const peers = vi.hoisted(() => ({
  makeTransport: () => ({on: () => () => {}, destroy: () => {}}),
}));
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));
vi.mock('../src/js/notation/store.js', () => ({NotationStore: vi.fn(), loadSharedNotation: vi.fn(async () => null), watchSharedNotation: () => () => {}}));
vi.mock('../src/stage/transport.js', () => ({createTransport: vi.fn(() => peers.makeTransport())}));
vi.mock('./transport.js', () => ({createTransport: vi.fn(() => peers.makeTransport())}));
vi.mock('../src/app/feedback.js', () => ({status: vi.fn(), toast: vi.fn()}));
vi.mock('../app/feedback.js', () => ({status: vi.fn(), toast: vi.fn()}));

import {openSession} from '../src/stage/session.js';
import {createDetectFlow, detectTarget, lineFor, beatsOf, COPY} from '../src/stage/detect.js';
import {MultitrackEngine} from '../src/js/engine.js';
import {SongMapStore} from '../src/js/song-map.js';
import {signal} from '../src/app/store.js';
import {clock as appClock} from '../src/app/clock.js';
import {ApiError} from '../src/api/client.js';
import {ONLINE_WINDOW_MS, RECHECK_MS} from '../src/api/devices.js';
import {emptyPractice} from '../shared/practice.ts';
import {FAKE_TIMERS, installFakeAudio, createClock} from './helpers/fake-audio.js';
import {sectioned, unmapped, tempoOf} from './fixtures/maps.js';

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
});
afterEach(() => {
  vi.useRealTimers();
  restoreAudio();
  vi.clearAllMocks();
});

/** Detected beats ([[time, beatInBar]]) for a steady 100 bpm 4/4 from 0.3 s. */
const rawBeats = (n = 160, step = 0.6) => Array.from({length: n}, (_, i) => [Math.round((0.3 + i * step) * 1000) / 1000, (i % 4) + 1]);
const detectedTempo = (duration) => {
  const store = SongMapStore.fromTempo({}, duration);
  store.replaceFromBeats(beatsOf({beats: rawBeats()}));
  return {songMap: store.serialize()};
};

/** A jobs API whose job subscriptions the test drives with `jobs.emit(jobId, job)`. */
function fakeJobs() {
  const watchers = new Map();
  let next = 1;
  const api = {
    watchers,
    latestDetection: vi.fn(async () => null),
    createBeatDetection: vi.fn(async () => ({jobId: `job-${next++}`})),
    createSectionDetection: vi.fn(async () => ({jobId: `job-${next++}`})),
    retry: vi.fn(async () => null),
    markApplied: vi.fn(async () => null),
    subscribeJob: vi.fn(({jobId}, onValue, onError) => {
      watchers.set(jobId, {onValue, onError});
      return vi.fn(() => watchers.delete(jobId));
    }),
    emit: (jobId, job) => watchers.get(jobId)?.onValue(job === null ? null : {jobId, kind: 'beats', ...job}),
  };
  return api;
}

function fakeSongs(song) {
  const subs = {};
  return {
    subs,
    subscribeSong: vi.fn((args, onValue) => { subs.song = onValue; queueMicrotask(() => onValue(structuredClone(song))); return vi.fn(); }),
    subscribePractice: vi.fn((args, onValue) => { queueMicrotask(() => onValue({...emptyPractice(), v: 2})); return vi.fn(); }),
    savePractice: vi.fn(async () => null),
    saveTempo: vi.fn(async () => ({tempoRev: 10, conflict: false})),
    dismissSectionSuggestion: vi.fn(async () => null),
    push: (next) => subs.song(structuredClone(next)),
  };
}

async function open({song, devices = [], desktop, jobs = fakeJobs(), accountStatus = 'active', library} = {}) {
  const n = ++seq;
  song ??= {id: `song-${n}`, title: 'Glasshouse', duration: 128, tempo: tempoOf(sectioned), tempoRev: 1, hasChart: false,
    stems: [{name: 'drums', key: `d${n}/drums`}, {name: 'bass', key: `d${n}/bass`}]};
  const songs = fakeSongs(song);
  const status = vi.fn();
  const navigate = vi.fn();
  const lib = library ?? {jobs: signal([]), devices: signal(devices)};
  const session = await openSession(song.id, {
    songs, jobs, status, window: null, document: null,
    media: {signKeys: vi.fn(async (keys) => Object.fromEntries(keys.map((k) => [k, `https://stems.invalid/${k}`])))},
    account: {value: signal({practice: {}, profile: {instruments: ['drums'], primary: 'drums', openWithMyPart: 'in'}})},
    desktop: desktop ?? {available: false, processor: signal({phase: 'web'}), onFlushRequest: () => () => {}},
    createEngine: () => { const e = new MultitrackEngine(); e.ctx.decodeDuration = song.duration; return e; },
    detect: {library: lib, accountSession: signal({status: accountStatus}), navigate},
  });
  for (let i = 0; i < 400 && session.load.peek().phase !== 'ready'; i++) await Promise.resolve();
  await tick();
  return {session, songs, jobs, status, navigate, song, library: lib};
}

const online = (id = 'dev-1', name = 'MacBook Pro') => ({deviceId: id, name, platform: 'mac', state: 'idle', lastSeenAt: T0 - 1000, currentJobId: null, queued: 0});

describe('pure helpers', () => {
  test('beatsOf reads worker.beatsDone results', () => {
    expect(beatsOf({beats: [[0.5, 1], [1.1, 2], [1.7, 1.02]]})).toEqual([{time: 0.5, downbeat: true}, {time: 1.1, downbeat: false}, {time: 1.7, downbeat: true}]);
    expect(beatsOf(null)).toEqual([]);
  });

  test('lineFor: "Finding bars · 30%" while running; waiting while queued', () => {
    expect(lineFor({status: 'running', percent: 30.4})).toBe('Finding bars · 30%');
    expect(lineFor({status: 'running', percent: 55}, 'sections')).toBe('Finding sections · 55%');
    expect(lineFor({status: 'queued'})).toBe(COPY.waiting);
  });

  test('detectTarget: desktop processor, then an online paired computer (B5), else the reasons (D10)', () => {
    const now = T0;
    expect(detectTarget({desktopAvailable: true, processor: {phase: 'ready', deviceId: 'local'}, now})).toEqual({ok: true, deviceId: 'local'});
    expect(detectTarget({desktopAvailable: true, processor: {phase: 'busy', deviceId: 'local'}, now})).toEqual({ok: true, deviceId: 'local'});
    expect(detectTarget({desktopAvailable: true, processor: {phase: 'starting'}, now})).toEqual({ok: false, reason: COPY.processorStarting});
    expect(detectTarget({desktopAvailable: true, processor: {phase: 'offline'}, now})).toEqual({ok: false, reason: COPY.processorOffline});
    expect(detectTarget({desktopAvailable: true, processor: {phase: 'offline'}, devices: [online('other')], now})).toEqual({ok: true, deviceId: 'other'});
    expect(detectTarget({devices: [online('dev-9')], now})).toEqual({ok: true, deviceId: 'dev-9'});
    const stale = {...online(), lastSeenAt: now - ONLINE_WINDOW_MS - 1};
    expect(detectTarget({devices: [stale, {...online('off'), state: 'offline'}], now})).toEqual({ok: false, reason: COPY.needsDesktop});
    expect(COPY.needsDesktop).toBe('Needs Woodshed for desktop running on one of your computers.');
    expect(detectTarget({readOnly: true, devices: [online()], now})).toEqual({ok: false, reason: COPY.readOnly});
    expect(detectTarget({accountStatus: 'export_only', devices: [online()], now})).toEqual({ok: false, reason: COPY.exportOnly});
  });
});

describe('canDetect (desktop vs web)', () => {
  test('desktop: the local processor and its deviceId; web: an online paired device, re-evaluated as presence ages', async () => {
    const processor = signal({phase: 'ready', deviceId: 'local-1'});
    const desk = await open({desktop: {available: true, processor, onFlushRequest: () => () => {}}});
    expect(desk.session.detect.canDetect.value).toEqual({ok: true, deviceId: 'local-1'});
    processor.value = {phase: 'offline'};
    expect(desk.session.detect.canDetect.value.ok).toBe(false);

    const web = await open({devices: [online('dev-1')]});
    expect(web.session.detect.canDetect.value).toEqual({ok: true, deviceId: 'dev-1'});
    vi.advanceTimersByTime(ONLINE_WINDOW_MS + RECHECK_MS);
    appClock.set();
    expect(web.session.detect.canDetect.value).toEqual({ok: false, reason: COPY.needsDesktop});
    web.library.devices.value = [{...online('dev-2'), lastSeenAt: Date.now() - 10}];
    expect(web.session.detect.canDetect.value).toEqual({ok: true, deviceId: 'dev-2'});

    const exportOnly = await open({devices: [online()], accountStatus: 'export_only'});
    expect(exportOnly.session.detect.canDetect.value.reason).toBe(COPY.exportOnly);
  });

  test('start() without a place to run says why and creates nothing', async () => {
    const {session, jobs, status} = await open();
    await session.detect.start();
    expect(jobs.createBeatDetection).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(COPY.needsDesktop, expect.anything());
  });
});

describe('starting and watching a detection', () => {
  test('dedupe: concurrent and repeated starts create one job; the progress line follows the job', async () => {
    const {session, jobs} = await open({devices: [online('dev-1')]});
    const a = session.detect.start();
    const b = session.detect.start();
    await Promise.all([a, b]);
    await session.detect.start();
    expect(jobs.createBeatDetection).toHaveBeenCalledOnce();
    expect(jobs.createBeatDetection).toHaveBeenCalledWith({songId: session.id, deviceId: 'dev-1'});
    expect(session.detect.state.peek()).toMatchObject({phase: 'running', jobId: 'job-1', line: COPY.waiting});
    jobs.emit('job-1', {status: 'running', stage: 'beats', percent: 30});
    expect(session.detect.state.peek()).toMatchObject({phase: 'running', percent: 30, line: 'Finding bars · 30%'});
  });

  test('a detect call answering with an existing live job follows that job', async () => {
    const jobs = fakeJobs();
    jobs.createBeatDetection.mockResolvedValue({jobId: 'live-7'});
    const {session} = await open({devices: [online()], jobs});
    await session.detect.start();
    expect(jobs.subscribeJob).toHaveBeenCalledWith({jobId: 'live-7'}, expect.any(Function), expect.any(Function));
  });

  test('mapped song: the result is applied as one practice-undo step, "Beat grid found · Undo", and markApplied', async () => {
    const {session, jobs, status} = await open({devices: [online()]});
    const before = session.map.snapshot();
    await session.detect.start();
    jobs.emit('job-1', {status: 'done', percent: 100, result: {beats: rawBeats()}});
    expect(session.map.data.origin).toBe('detected');
    expect(session.undo.size.undo).toBe(1);
    expect(session.map.undoStack).toHaveLength(0);
    expect(jobs.markApplied).toHaveBeenCalledWith({jobId: 'job-1'});
    const [, opts] = status.mock.calls.find(([t]) => t === COPY.found);
    expect(opts.action.label).toBe('Undo');
    expect(session.detect.state.peek()).toMatchObject({phase: 'done', jobId: 'job-1'});
    opts.action.run();
    expect(session.map.snapshot()).toEqual(before);
  });

  test('mapped song with Edit · Map mounted: one map-stack step', async () => {
    const {session, jobs} = await open({devices: [online()]});
    session.mapEditor.value = {auditioning: signal(false), undo: vi.fn()};
    await session.detect.start();
    jobs.emit('job-1', {status: 'done', result: {beats: rawBeats()}});
    expect(session.map.undoStack).toHaveLength(1);
    expect(session.undo.size.undo).toBe(0);
    expect(jobs.markApplied).toHaveBeenCalledWith({jobId: 'job-1'});
  });

  test('a result arriving during a Find a chart audition waits until it ends', async () => {
    const {session, jobs} = await open({devices: [online()]});
    await session.detect.start();
    const auditioning = signal(true);
    session.mapEditor.value = {auditioning, undo: vi.fn()};
    jobs.emit('job-1', {status: 'done', result: {beats: rawBeats()}});
    expect(session.map.data.origin).toBe('edited');
    expect(jobs.markApplied).not.toHaveBeenCalled();
    auditioning.value = false;
    await tick();
    expect(session.map.data.origin).toBe('detected');
    expect(jobs.markApplied).toHaveBeenCalledOnce();
  });

  test('unmapped song: the server writes the map (appliedAt); the flow applies nothing and the session shows "Beat grid found"', async () => {
    const n = ++seq;
    const song = {id: `u-${n}`, title: 'Harbor Lights', duration: 100, tempo: tempoOf(unmapped), tempoRev: 1, hasChart: false,
      stems: [{name: 'drums', key: `u${n}/drums`}]};
    const {session, jobs, status, songs} = await open({song, devices: [online()]});
    await session.detect.start();
    jobs.emit('job-1', {status: 'done', appliedAt: T0, result: {beats: rawBeats()}});
    expect(session.map.isReal).toBe(false);
    expect(jobs.markApplied).not.toHaveBeenCalled();
    songs.push({...song, tempo: detectedTempo(100), tempoRev: 2});
    expect(session.map.isReal).toBe(true);
    expect(status.mock.calls.some(([t]) => t === COPY.found)).toBe(true);
    expect(session.undo.size.undo).toBe(1);
  });

  test('sections: needs a real map; a done sections job only ends the flow', async () => {
    const n = ++seq;
    const song = {id: `s-${n}`, title: 'Unmapped', duration: 100, tempo: tempoOf(unmapped), tempoRev: 1, stems: [{name: 'drums', key: `s${n}/d`}]};
    const unmappedSong = await open({song, devices: [online()]});
    await unmappedSong.session.detect.start({kind: 'sections'});
    expect(unmappedSong.jobs.createSectionDetection).not.toHaveBeenCalled();
    expect(unmappedSong.status).toHaveBeenCalledWith(COPY.needsMap, expect.anything());

    const mapped = await open({devices: [online()]});
    await mapped.session.detect.start({kind: 'sections'});
    expect(mapped.jobs.createSectionDetection).toHaveBeenCalledWith({songId: mapped.session.id, deviceId: 'dev-1'});
    mapped.jobs.emit('job-1', {kind: 'sections', status: 'running', percent: 55});
    expect(mapped.session.detect.state.peek().line).toBe('Finding sections · 55%');
    mapped.jobs.emit('job-1', {kind: 'sections', status: 'done', result: {sections: []}});
    expect(mapped.session.detect.state.peek()).toMatchObject({phase: 'done', kind: 'sections'});
    expect(mapped.jobs.markApplied).not.toHaveBeenCalled();
    await expect(mapped.session.detect.start({kind: 'chords'})).rejects.toThrow(TypeError);
  });
});

describe('errors (describeError, context detect)', () => {
  test('a failed job and a refused call read through the error copy', async () => {
    const {session, jobs} = await open({devices: [online()]});
    await session.detect.start();
    jobs.emit('job-1', {status: 'error', errorCode: 'beats_unavailable', error: 'BeatNet missing'});
    expect(session.detect.state.peek()).toMatchObject({phase: 'error', jobId: 'job-1'});
    expect(session.detect.state.peek().error.sentence).toBe('Bar detection isn’t installed on this computer.');
    expect(session.detect.state.peek().error.details).toContain('BeatNet missing');

    const refused = fakeJobs();
    refused.createBeatDetection.mockRejectedValue(new ApiError({code: 'device_unpaired', message: 'Choose which computer should do this.'}));
    const second = await open({devices: [online()], jobs: refused});
    await second.session.detect.start();
    expect(second.session.detect.state.peek().phase).toBe('error');
    expect(second.session.detect.state.peek().error.sentence).toBe('This computer isn’t connected to your account.');
  });

  test('retry: same job on its device; a newer live detection (job_live) is followed instead', async () => {
    const {session, jobs} = await open({devices: [online('dev-1')]});
    await session.detect.start();
    jobs.emit('job-1', {status: 'error', errorCode: 'unknown', error: 'crash'});
    await session.detect.retry();
    expect(jobs.retry).toHaveBeenCalledWith({jobId: 'job-1', deviceId: 'dev-1'});
    expect(session.detect.state.peek()).toMatchObject({phase: 'running', jobId: 'job-1'});
    jobs.emit('job-1', {status: 'error', errorCode: 'unknown', error: 'crash again'});
    jobs.retry.mockRejectedValueOnce(new ApiError({code: 'job_live', message: 'busy', data: {code: 'job_live', jobId: 'job-9'}}));
    await session.detect.retry();
    expect(session.detect.state.peek()).toMatchObject({phase: 'running', jobId: 'job-9'});
  });
});

describe('resume() on open (D44)', () => {
  test('a finished, unapplied detection on a mapped song is offered once: Use them applies it', async () => {
    const jobs = fakeJobs();
    jobs.latestDetection.mockResolvedValue({jobId: 'old-1', kind: 'beats', status: 'done', result: {beats: rawBeats()}});
    const {session, status} = await open({jobs});
    expect(jobs.latestDetection).toHaveBeenCalledWith({songId: session.id});
    const call = status.mock.calls.find(([t]) => t === COPY.away);
    expect(call[0]).toBe('Bars found while you were away');
    expect(call[1].action.label).toBe('Use them');
    expect(session.detect.offer.peek()).toMatchObject({jobId: 'old-1'});
    call[1].action.run();
    expect(session.map.data.origin).toBe('detected');
    expect(session.undo.size.undo).toBe(1);
    expect(jobs.markApplied).toHaveBeenCalledWith({jobId: 'old-1'});
    expect(session.detect.offer.peek()).toBeNull();
  });

  test('Not now marks it applied without changing the map; nothing is offered for applied or unmapped results', async () => {
    const jobs = fakeJobs();
    jobs.latestDetection.mockResolvedValue({jobId: 'old-2', kind: 'beats', status: 'done', result: {beats: rawBeats()}});
    const {session} = await open({jobs});
    session.detect.dismissOffer();
    expect(jobs.markApplied).toHaveBeenCalledWith({jobId: 'old-2'});
    expect(session.map.data.origin).toBe('edited');

    const applied = fakeJobs();
    applied.latestDetection.mockResolvedValue({jobId: 'x', status: 'done', appliedAt: T0, result: {beats: rawBeats()}});
    const second = await open({jobs: applied});
    expect(second.session.detect.offer.peek()).toBeNull();
  });

  test('a live detection for the song (store.library.jobs) is followed on open', async () => {
    const n = ++seq;
    const song = {id: `live-${n}`, title: 'X', duration: 128, tempo: tempoOf(sectioned), tempoRev: 1, stems: [{name: 'drums', key: `l${n}/d`}]};
    const library = {jobs: signal([{jobId: 'job-live', songId: song.id, kind: 'beats', status: 'running', percent: 12}]), devices: signal([])};
    const {session, jobs} = await open({song, library});
    expect(jobs.subscribeJob).toHaveBeenCalledWith({jobId: 'job-live'}, expect.any(Function), expect.any(Function));
    jobs.emit('job-live', {status: 'running', percent: 40});
    expect(session.detect.state.peek().line).toBe('Finding bars · 40%');
  });
});

describe('section suggestions (D47)', () => {
  const suggestion = {jobId: 'job-s', createdAt: T0, sections: [{t0: 16.1, label: 'Verse', confidence: 0.8}, {t0: 31.9, label: 'Chorus', confidence: 0.7}]};
  const plainSong = () => {
    const n = ++seq;
    const tempo = tempoOf(sectioned);
    for (const m of tempo.songMap.measures) m.label = '';
    return {id: `sg-${n}`, title: 'Plain', duration: 128, tempo, tempoRev: 1, stems: [{name: 'drums', key: `sg${n}/d`}], sectionSuggestion: suggestion};
  };

  test('shown while the map is real and has no sections; Keep all is one undo step and dismisses the suggestion', async () => {
    const {session, songs, status} = await open({song: plainSong()});
    expect(session.detect.suggestion.value).toEqual({sections: suggestion.sections});
    const result = session.detect.keepAll();
    expect(result.entry).toBeTruthy();
    expect(session.map.sections.map((s) => s.label)).toEqual(expect.arrayContaining(['Verse', 'Chorus']));
    expect(session.undo.size.undo).toBe(1);
    expect(songs.dismissSectionSuggestion).toHaveBeenCalledWith({id: session.id});
    expect(status).toHaveBeenCalledWith(COPY.sectionsAdded(2), expect.objectContaining({action: expect.objectContaining({label: 'Undo'})}));
    expect(session.detect.suggestion.value).toBeNull();   // the map has sections now
    session.undo.undo();
    expect(session.map.hasSections).toBe(false);
  });

  test('dismiss hides it at once; review opens Edit · Map with the review; mapped songs with sections show none', async () => {
    const {session, songs, navigate} = await open({song: plainSong()});
    session.detect.dismiss();
    expect(songs.dismissSectionSuggestion).toHaveBeenCalledWith({id: session.id});
    expect(session.detect.suggestion.value).toBeNull();
    session.detect.review();
    expect(navigate).toHaveBeenCalledWith(`/s/${session.id}/edit/map?review=sections`);

    const withSections = await open({song: {...plainSong(), tempo: tempoOf(sectioned)}});
    expect(withSections.session.detect.suggestion.value).toBeNull();
  });
});

test('createDetectFlow requires a session and stops watching on destroy', () => {
  expect(() => createDetectFlow({})).toThrow(TypeError);
  const off = vi.fn();
  const jobs = {...fakeJobs(), subscribeJob: vi.fn(() => off)};
  const map = SongMapStore.fromTempo(tempoOf(sectioned), 128);
  const flow = createDetectFlow({
    session: {id: 's', readOnly: false, song: signal({}), map, mapEditor: signal(null), mapChange: vi.fn()},
    jobs, library: {jobs: signal([{jobId: 'j', songId: 's', kind: 'beats', status: 'queued'}]), devices: signal([])},
    accountSession: signal({status: 'active'}), desktop: {available: false}, status: vi.fn(), navigate: vi.fn(),
  });
  void flow.resume();
  expect(jobs.subscribeJob).toHaveBeenCalled();
  flow.destroy();
  expect(off).toHaveBeenCalled();
});
