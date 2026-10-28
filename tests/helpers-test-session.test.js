// @vitest-environment node
// The shared test helpers (architecture §11.3): tests/helpers/test-session.js builds a real
// Session over in-memory persistence and the fake clock; tests/helpers/fake-session.js is the
// shape-checked fake for pure view tests.
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {clock as appClock} from '../src/app/clock.js';
import {MultitrackEngine} from '../src/js/engine.js';
import {Metronome} from '../src/js/metronome.js';
import {SongMapStore} from '../src/js/song-map.js';
import {COPY as SESSION_COPY} from '../src/stage/session.js';
import {COPY as DETECT_COPY} from '../src/stage/detect.js';
import {SAVE_DEBOUNCE_MS} from '../src/stage/practice-state.js';
import {FAKE_TIMERS, FakeAudioContext, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {DEFAULT_STEMS, createTestServer, createTestSession, settle, waitForLoad} from './helpers/test-session.js';
import {NAMED_MEMBERS, OMITTED_MEMBERS, SHAPED_MEMBERS, TRANSPORT_METHODS, createFakeSession, memberNames, missingKeys, sessionShape} from './helpers/fake-session.js';
import {emptyScore} from '../shared/notation.ts';
import {legacyTempoMap, sectioned, tempoOf, unmapped, REHEARSAL_SECTIONS} from './fixtures/maps.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.parse('2026-10-28T12:00:00Z');
let clock, restoreAudio;
const open = [];

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(T0);
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
});

afterEach(async () => {
  for (const ts of open.splice(0)) if (!ts.session.disposed) await ts.dispose();
  restoreAudio();
  vi.useRealTimers();
});

async function make(options = {}) {
  const ts = await createTestSession({clock, ...options});
  open.push(ts);
  return ts;
}

/** 120 detected beats at 100 bpm, a downbeat every 4: [[time, beatInBar], …]. */
const BEATS = Array.from({length: 120}, (_, i) => [0.3 + i * 0.6, (i % 4) + 1]);

describe('createTestSession: a real session', () => {
  test('defaults to the rehearsal song: real map with its 8 sections, 4 stems on the fake engine, the transport ready and stopped', async () => {
    const ts = await make();
    const {session} = ts;
    expect(session.load.peek()).toMatchObject({phase: 'ready', error: null, tracks: 4});
    expect(session.map).toBeInstanceOf(SongMapStore);
    expect(session.metronome).toBeInstanceOf(Metronome);
    expect(session.engine).toBeInstanceOf(MultitrackEngine);
    expect(session.engine.ctx).toBeInstanceOf(FakeAudioContext);
    expect(session.map.isReal).toBe(true);
    expect(session.map.sections.map((s) => s.name)).toEqual([...REHEARSAL_SECTIONS]);
    expect(session.engine.tracks.map((t) => t.name)).toEqual([...DEFAULT_STEMS]);
    expect(session.engine.duration).toBe(sectioned.duration);
    expect(session.map.duration).toBe(sectioned.duration);
    expect(ts.transport.isReady).toBe(true);
    expect(ts.snapshot.phase).toBe('stopped');
    expect(ts.position.mapped.peek()).toBe(true);
    expect(ts.position.label(20).main).toBe('11 · 1');
    expect(typeof ts.undo.pushAction).toBe('function');
    expect(ts.detect.state.peek().phase).toBe('idle');
  });

  test('play(), advance(sec) and passes(): a 4-bar loop played for 17 s makes two passes', async () => {
    const ts = await make();
    ts.transport.loopRange(0, 8);
    const snap = await ts.play();
    expect(snap.phase).toBe('playing');
    expect(ts.phases).toEqual(['stopped', 'playing']);
    await ts.advance(17);
    expect(ts.passes()).toBe(2);
    expect(ts.snapshot.pass).toBe(2);
    expect(ts.of('pass').map((e) => e.pass)).toEqual([1, 2]);
    expect(ts.now).toBeCloseTo(17, 6);
    expect(ts.transport.position()).toBeGreaterThan(0.9);
    expect(ts.transport.position()).toBeLessThan(1.1);
  });

  test('mapped: false is a song nobody mapped: placeholder map, unmapped position text, 5 s steps', async () => {
    const ts = await make({mapped: false, duration: 90});
    expect(ts.map.isReal).toBe(false);
    expect(ts.map.duration).toBe(90);
    expect(ts.engine.duration).toBe(90);
    expect(ts.position.mapped.peek()).toBe(false);
    expect(ts.position.label(72).main).toBe('1:12');
    ts.transport.cue(20);
    ts.transport.step('bar', 1);
    expect(ts.snapshot.cue).toBe(25);
  });

  test('a stored tempo is upgraded one way (pre-1.6 tempo.map) and a v1 practice blob is read as v2', async () => {
    const ts = await make({tempo: tempoOf(legacyTempoMap), duration: 30, practice: {rate: 0.8, loop: {enabled: true, a: 4, b: 10}, tracks: []}});
    expect(ts.map.isReal).toBe(true);
    expect(ts.value.v).toBe(2);
    expect(ts.snapshot.rate).toBe(0.8);
    expect(ts.snapshot.loop).toMatchObject({on: true, a: 4, b: 10});
    expect(ts.engine.rate).toBe(0.8);
  });

  test('account settings apply: "Open with my part Out" mutes your stems on a song with no saved practice; setAccount follows live', async () => {
    const ts = await make({account: {profile: {instruments: ['bass'], primary: 'bass', openWithMyPart: 'out'}}});
    expect(ts.snapshot.mix.mine).toEqual(['bass']);
    expect(ts.snapshot.mix.tracks.find((t) => t.name === 'bass').muted).toBe(true);
    ts.setAccount({profile: {instruments: ['vocals'], primary: 'vocals'}});
    expect(ts.snapshot.mix.mine).toEqual(['vocals']);
  });

  test('load: false resolves before the audio; ready() waits for it', async () => {
    const ts = await make({load: false});
    expect(ts.session.load.peek().phase).not.toBe('ready');
    expect(ts.snapshot.phase).toBe('loading');
    expect((await ts.ready()).phase).toBe('ready');
    expect(ts.snapshot.phase).toBe('stopped');
  });

  test('a loading failure resolves with the error state (here: signing fails)', async () => {
    const ts = await make({media: {signKeys: async () => { throw new Error('offline'); }}});
    expect(ts.session.load.peek()).toMatchObject({phase: 'error', error: {kind: 'storage'}});
  });

  test('advance without a clock (and no fixture manual audio) explains what it needs', async () => {
    const ts = await createTestSession({});
    open.push(ts);
    await expect(ts.advance(1)).rejects.toThrow(/needs a clock/);
  });

  test('shared: a read-only Shared Stage session that keeps practice local', async () => {
    const ts = await make({shared: {token: 'tok'}});
    expect(ts.session.readOnly).toBe(true);
    expect(ts.session.shareToken).toBe('tok');
    expect(ts.session.mapChange('x', (m) => m.edit((d) => { d.tailQpm = 90; }, 'tempo'))).toBeNull();
    ts.transport.setSpeed(0.7);
    await ts.advance(SAVE_DEBOUNCE_MS / 1000 + 0.1);
    expect(ts.server.calls.savePractice).toEqual([]);
    expect(ts.detect.canDetect.peek()).toMatchObject({ok: false, reason: DETECT_COPY.readOnly});
  });
});

describe('createTestSession: in-memory persistence', () => {
  test('practice saves are debounced (600 ms, not final) and Stop flushes a final one; the server echoes the blob', async () => {
    const ts = await make();
    ts.transport.setSpeed(0.85);
    await ts.advance(0.3);
    expect(ts.server.calls.savePractice).toEqual([]);
    await ts.advance(0.4);
    expect(ts.server.calls.savePractice).toHaveLength(1);
    expect(ts.server.calls.savePractice[0]).toMatchObject({id: ts.id, final: false, practice: {rate: 0.85}});
    expect(ts.server.practice.rate).toBe(0.85);
    await ts.play();
    await ts.advance(1);
    ts.transport.stop();
    await settle();
    expect(ts.server.calls.savePractice.at(-1).final).toBe(true);
    expect(ts.session.practice.pending).toBe(false);
  });

  test('a map change saves the tempo once after 400 ms; the echo is our own save (D53), so nothing is adopted', async () => {
    const ts = await make();
    const adopted = vi.fn();
    ts.session.on('tempo-adopted', adopted);
    const rev = ts.server.tempoRev;
    const result = ts.session.mapChange('Rename', (m) => m.edit((d) => { d.measures[8].label = 'Big verse'; }, 'sections'));
    expect(result?.entry).toBeTruthy();
    await ts.advance(0.45);
    expect(ts.server.calls.saveTempo).toHaveLength(1);
    const save = ts.server.calls.saveTempo[0];
    expect(save).toMatchObject({id: ts.id, baseRev: rev});
    expect(typeof save.saveId).toBe('string');
    expect(ts.server.tempoRev).toBe(rev + 1);
    expect(ts.server.song.tempoSaveId).toBe(save.saveId);
    expect(adopted).not.toHaveBeenCalled();
    expect(ts.map.sections.some((s) => s.name === 'Big verse')).toBe(true);
  });

  test('a foreign real map reaching an unmapped song is adopted as one undo step with "Bars found · Undo"', async () => {
    const ts = await make({mapped: false, duration: 128});
    ts.server.pushSong({tempo: tempoOf(sectioned)});
    await settle();
    expect(ts.map.isReal).toBe(true);
    expect(ts.statuses.at(-1)).toMatchObject({text: SESSION_COPY.barsFound, action: {label: SESSION_COPY.undo}});
    ts.undo.undo();
    expect(ts.map.isReal).toBe(false);
  });

  test('the conflict rule: a stale save that would replace their real map with an unreal one is refused', async () => {
    const server = createTestServer({id: 's', duration: 128, tempo: tempoOf(sectioned), tempoRev: 5, stems: []});
    const placeholder = {songMap: SongMapStore.fromTempo(null, 128).serialize()};
    const answer = await server.songs.saveTempo({id: 's', tempo: placeholder, baseRev: 4, saveId: 'a'});
    expect(answer).toMatchObject({tempoRev: 5, conflict: true});
    expect(answer.tempo).toEqual(tempoOf(sectioned));
    expect(server.tempoRev).toBe(5);
    await expect(server.songs.saveTempo({id: 's', tempo: {map: []}})).rejects.toThrow(/could not be saved/);
  });

  test('dispose flushes a final save, then destroys the engine', async () => {
    const ts = await make();
    ts.transport.setSpeed(0.9);
    await ts.dispose();
    expect(ts.server.calls.savePractice.at(-1)).toMatchObject({final: true, practice: {rate: 0.9}});
    expect(ts.session.disposed).toBe(true);
    expect(ts.engine.destroyed).toBe(true);
  });

  test('a desktop flush request flushes every pending save', async () => {
    const ts = await make({desktop: true});
    ts.transport.setSpeed(0.6);
    await ts.requestFlush();
    expect(ts.server.calls.savePractice.at(-1)).toMatchObject({final: true, practice: {rate: 0.6}});
  });
});

describe('createTestSession: the detect flow over the fake jobs API', () => {
  test('desktop: detection runs on this computer; progress shows in the line; the server writes the map on an unmapped song (D44)', async () => {
    const ts = await make({mapped: false, duration: 80, desktop: true});
    expect(ts.detect.canDetect.peek()).toEqual({ok: true, deviceId: 'device-local'});
    await ts.detect.start();
    await settle();
    expect(ts.server.calls.createBeatDetection).toEqual([{songId: ts.id, deviceId: 'device-local'}]);
    const [{jobId}] = ts.server.jobRows;
    ts.server.progressJob(jobId, 30);
    await settle();
    expect(ts.detect.state.peek()).toMatchObject({phase: 'running', line: DETECT_COPY.finding(30)});
    ts.server.finishJob(jobId, {beats: BEATS});
    await settle();
    expect(ts.server.job(jobId)).toMatchObject({status: 'done', appliedAt: expect.any(Number)});
    expect(ts.map.isReal).toBe(true);
    expect(ts.map.data.origin).toBe('detected');
    expect(ts.statuses.at(-1)).toMatchObject({text: SESSION_COPY.gridFound});
    expect(ts.server.calls.markApplied).toEqual([]);   // the server applied it
  });

  test('mapped song: the flow applies the result itself (one undo step) and marks it applied', async () => {
    const ts = await make({desktop: true});
    await ts.detect.start();
    await settle();
    const [{jobId}] = ts.server.jobRows;
    ts.server.finishJob(jobId, {beats: BEATS});
    await settle();
    expect(ts.server.calls.markApplied).toEqual([{jobId}]);
    expect(ts.statuses.at(-1)).toMatchObject({text: DETECT_COPY.found});
    expect(ts.map.data.origin).toBe('detected');
    ts.undo.undo();
    expect(ts.map.data.origin).toBe('edited');
  });

  test('web: an online paired computer runs it; with none the reason says so', async () => {
    const web = await make({devices: 'online'});
    expect(web.detect.canDetect.peek()).toEqual({ok: true, deviceId: 'device-online'});
    const none = await make();
    expect(none.detect.canDetect.peek()).toEqual({ok: false, reason: DETECT_COPY.needsDesktop});
    const paused = await make({devices: 'online', accountStatus: 'export_only'});
    expect(paused.detect.canDetect.peek()).toMatchObject({ok: false, reason: DETECT_COPY.exportOnly});
  });

  test('section suggestions on a mapped song without sections: keep all adds them and dismisses the suggestion', async () => {
    const plain = {songMap: {...structuredClone(sectioned.tempo.songMap), measures: sectioned.tempo.songMap.measures.map((m) => ({...m, label: ''}))}};
    const sections = [{t0: 0, label: 'Intro', confidence: 0.8}, {t0: 32, label: 'Chorus', confidence: 0.7}];
    const ts = await make({tempo: plain, duration: 128, sectionSuggestion: {jobId: 'j', createdAt: T0, sections}});
    expect(ts.detect.suggestion.peek()).toEqual({sections});
    ts.detect.keepAll();
    await settle();
    expect(ts.server.calls.dismissSectionSuggestion).toEqual([{id: ts.id}]);
    expect(ts.map.sections.map((s) => s.name)).toEqual(['Intro', 'Chorus']);
    expect(ts.server.song.sectionSuggestion).toBeUndefined();
  });

  test('resume offers a finished, unapplied detection: "Bars found while you were away"', async () => {
    const server = createTestServer({id: 'x', stems: []});
    expect(server.addJob({status: 'done', result: {beats: BEATS}})).toMatch(/^job-beats-/);
    const ts = await make({load: false});
    ts.server.addJob({jobId: 'away', songId: ts.id, kind: 'beats', status: 'done', result: {beats: BEATS}});
    await ts.ready();
    await settle();
    expect(ts.server.calls.latestDetection).toEqual([{songId: ts.id}]);
    expect(ts.detect.offer.peek()).toMatchObject({jobId: 'away'});
    expect(ts.statuses.some((s) => s.text === DETECT_COPY.away)).toBe(true);
  });
});

describe('createTestServer: parity with convex/songs.ts and worker.ts', () => {
  /** The 1.9 click settings D51 keeps in `songs.tempo` next to the map. */
  const LEGACY_CLICK = {enabled: true, countIn: true, accent: false, volume: 0.4, audiblePreRoll: true};

  test('saveTempo keeps the non-map tempo fields, and an unchanged map is a no-op (no tempoRev bump)', async () => {
    const server = createTestServer({id: 's', duration: 128, tempo: {...tempoOf(sectioned), ...LEGACY_CLICK}, tempoRev: 1, stems: []});
    expect(await server.songs.saveTempo({id: 's', tempo: tempoOf(sectioned), baseRev: 1, saveId: 'a'})).toEqual({tempoRev: 1, conflict: false});
    expect(server.song.tempo).toEqual({...tempoOf(sectioned), ...LEGACY_CLICK});
    const moved = tempoOf(sectioned);
    moved.songMap.tailQpm = 100;
    expect(await server.songs.saveTempo({id: 's', tempo: moved, baseRev: 1, saveId: 'b'})).toEqual({tempoRev: 2, conflict: false});
    expect(server.song.tempo).toMatchObject({...LEGACY_CLICK, songMap: {tailQpm: 100}});
    expect(Object.keys(server.song.tempo)).not.toContain('map');
  });

  test('a song with a drum part counts as mapped (D44 rule 2): the server never writes a detected map over it', () => {
    const server = createTestServer({id: 'c', duration: 80, tempo: tempoOf(unmapped), hasChart: true, stems: []});
    const jobId = server.addJob({kind: 'beats', songId: 'c'});
    server.finishJob(jobId, {beats: BEATS});
    expect(server.job(jobId)).toMatchObject({status: 'done', appliedAt: null, result: {beats: BEATS, sections: []}});
    expect(server.song.tempo).toEqual(tempoOf(unmapped));
    expect(server.tempoRev).toBe(0);
  });

  test('a session with a score (a drum part) applies the result itself, as a mapped song does', async () => {
    const ts = await make({mapped: false, duration: 80, score: emptyScore(80), desktop: true});
    expect(ts.server.song.hasChart).toBe(true);
    await ts.detect.start();
    await settle();
    const [{jobId}] = ts.server.jobRows;
    ts.server.finishJob(jobId, {beats: BEATS});
    await settle();
    expect(ts.server.song.tempo).toBeNull();
    expect(ts.server.calls.markApplied).toEqual([{jobId}]);
  });

  test('an unusable result (fewer than 2 pins) is never written; a usable one keeps the click fields', () => {
    const server = createTestServer({id: 'u', duration: 80, tempo: {...LEGACY_CLICK}, tempoRev: 3, stems: []});
    const one = server.addJob({kind: 'beats', songId: 'u'});
    server.finishJob(one, {beats: [[1, 1]]});
    expect(server.job(one).appliedAt).toBeNull();
    expect(server.song.tempo).toEqual(LEGACY_CLICK);
    const good = server.addJob({kind: 'beats', songId: 'u'});
    server.finishJob(good, {beats: BEATS});
    expect(server.job(good).appliedAt).toEqual(expect.any(Number));
    expect(server.song.tempo).toMatchObject({...LEGACY_CLICK, songMap: {origin: 'detected'}});
    expect(server.tempoRev).toBe(4);
  });

  test('sections become a suggestion only when non-empty and the map has none (worker.suggestSections, D47)', () => {
    const sections = [{t0: 0, label: 'Intro', confidence: 0.8}, {t0: 32, label: 'Chorus', confidence: 0.7}];
    const withSections = createTestServer({id: 'a', duration: 128, tempo: tempoOf(sectioned), stems: []});
    const j1 = withSections.addJob({kind: 'sections', songId: 'a'});
    withSections.finishJob(j1, {sections});
    expect(withSections.song.sectionSuggestion).toBeUndefined();
    expect(withSections.job(j1).result).toEqual({sections});
    const empty = createTestServer({id: 'b', duration: 80, stems: []});
    empty.finishJob(empty.addJob({kind: 'beats', songId: 'b'}), {beats: BEATS, sections: []});
    expect(empty.song.sectionSuggestion).toBeUndefined();
    const fresh = createTestServer({id: 'd', duration: 80, stems: []});
    const j3 = fresh.addJob({kind: 'beats', songId: 'd'});
    fresh.finishJob(j3, {beats: BEATS, sections});
    expect(fresh.song.sectionSuggestion).toMatchObject({jobId: j3, sections});
    expect(fresh.job(j3).result).toEqual({beats: BEATS, sections});
  });
});

describe('browser safety', () => {
  test('neither helper imports a test framework or a Node API', () => {
    for (const file of ['tests/helpers/test-session.js', 'tests/helpers/fake-session.js']) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      expect(specs.length, file).toBeGreaterThan(0);
      for (const spec of specs) {
        expect(spec, `${file}: ${spec}`).not.toMatch(/^(vitest|node:|fs$|path$)|fake-audio/);
      }
      const code = src.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join('\n');
      expect(code, file).not.toMatch(/\bvi\.|\brequire\(|\bprocess\./);
    }
  });
});

describe('fake-session: the shape of the real Session', () => {
  test('every key of the real Session, its members, the transport snapshot and the load state exists on the fake', async () => {
    const ts = await make();
    const real = sessionShape(ts.session);
    const fake = sessionShape(createFakeSession());
    expect(real.session.length).toBeGreaterThan(20);
    expect(real.snapshot).toEqual(expect.arrayContaining(['phase', 'loop.on', 'mix.tracks', 'click.mode', 'countIn.on']));
    expect(missingKeys(real, fake)).toEqual([]);
    for (const name of SHAPED_MEMBERS) expect(real.members[name].length, name).toBeGreaterThan(0);
  });

  test('the engine and metronome: every public member of the real classes is faked or a reviewed omission', async () => {
    const ts = await make();
    const real = sessionShape(ts.session);
    const fake = sessionShape(createFakeSession());
    for (const name of NAMED_MEMBERS) {
      expect(real.named[name].length, name).toBeGreaterThan(20);
      // No stale omission: each one is still a real member, and none is also faked.
      expect(OMITTED_MEMBERS[name].filter((k) => !real.named[name].includes(k)), name).toEqual([]);
      expect(OMITTED_MEMBERS[name].filter((k) => fake.named[name].includes(k)), name).toEqual([]);
    }
    expect(missingKeys(real, fake)).toEqual([]);
    const grown = {...real, named: {...real.named, engine: [...real.named.engine, 'setPan'], metronome: [...real.named.metronome, 'swing']}};
    expect(missingKeys(grown, fake)).toEqual(['engine.setPan', 'metronome.swing']);
    expect(memberNames(ts.session.metronome)).toEqual(expect.arrayContaining(['onBeat', 'settings', 'configure']));
    expect(memberNames(ts.session.engine).some((k) => k.startsWith('_'))).toBe(false);
  });

  test('the transport method list is the real transport\'s', async () => {
    const ts = await make();
    const methods = Object.getOwnPropertyNames(ts.transport).filter((k) => typeof ts.transport[k] === 'function');
    expect([...TRANSPORT_METHODS].sort()).toEqual(methods.sort());
  });

  test('the check fails when the real Session has a key the fake lacks', async () => {
    const ts = await make();
    const real = sessionShape(ts.session);
    const fake = sessionShape(createFakeSession());
    const withExtra = {...real, session: [...real.session, 'brandNew'], members: {...real.members, transport: [...real.members.transport, 'warp']},
      snapshot: [...real.snapshot, 'loop.color']};
    expect(missingKeys(withExtra, fake)).toEqual(['brandNew', 'transport.warp', 'snapshot.loop.color']);
  });

  test('the fake drives views: settable snapshot, recorded calls, events, frames and load', () => {
    const s = createFakeSession({stems: ['vocals', 'drums'], practice: {v: 2, rate: 0.75, loop: {on: true, a: 32, b: 48}}});
    expect(s.transport.snapshot.peek()).toMatchObject({phase: 'stopped', rate: 0.75, loop: {on: true, a: 32, b: 48}});
    expect(s.transport.snapshot.peek().loop.label).toBe(s.position.loopLabel(32, 48));
    expect(s.transport.snapshot.peek().mix.tracks.map((t) => t.name)).toEqual(['drums', 'vocals']);
    s.transport.set({phase: 'playing', loop: {on: false}});
    expect(s.transport.snapshot.peek()).toMatchObject({phase: 'playing', loop: {on: false, a: 32, b: 48}});
    s.transport.toggleLoop();
    s.transport.setSpeed(0.5, {coalesce: false});
    expect(s.transport.calls).toEqual([['toggleLoop'], ['setSpeed', 0.5, {coalesce: false}]]);
    const seen = [];
    s.transport.on('pass', (e) => seen.push(e.pass));
    s.transport.emit('pass', {pass: 3});
    expect(seen).toEqual([3]);
    s.transport.setPosition(41);
    const frames = [];
    s.frame.subscribe((f) => frames.push(f));
    s.frame.emit();
    expect(frames[0]).toMatchObject({position: 41, playing: true, bar: {index: 20, display: 21}});
    s.setLoad({phase: 'decoding', decoded: 1});
    expect(s.load.peek()).toMatchObject({phase: 'decoding', decoded: 1, tracks: 2});
    const id = s.practice.addSpot({name: 'Chorus', a: 32, b: 48});
    expect(s.practice.value.peek().spots.map((x) => x.id)).toEqual([id]);
    expect(s.mapChange('Rename', (m) => m.edit((d) => { d.measures[0].label = 'Count'; }, 'sections'))).toEqual({entry: null});
    s.detect.set({state: {phase: 'running', line: 'Finding bars · 30%'}});
    expect(s.detect.state.peek().line).toBe('Finding bars · 30%');
  });

  test('unmapped fake: the placeholder map and clock-time labels; a loading fake starts in phase loading', () => {
    const s = createFakeSession({mapped: false, duration: 60, load: 'decoding'});
    expect(s.map.isReal).toBe(false);
    expect(s.position.label(72 / 2).main).toBe('0:36');
    expect(s.transport.snapshot.peek().phase).toBe('loading');
    expect(s.transport.isReady).toBe(false);
    const ro = createFakeSession({readOnly: true});
    expect(ro.readOnly).toBe(true);
    expect(ro.shareToken).toBe('fake-share');
    expect(ro.mapChange('x', () => {})).toBeNull();
    expect(ro.detect.canDetect.peek().ok).toBe(false);
  });

  test('waitForLoad resolves at once for a loaded session', async () => {
    const ts = await make();
    expect((await waitForLoad(ts.session)).phase).toBe('ready');
  });

  test('a stored unmapped placeholder (1.6–1.9) is not real either', async () => {
    const ts = await make({tempo: tempoOf(unmapped), duration: 30});
    expect(ts.map.isReal).toBe(false);
  });
});
