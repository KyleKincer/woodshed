// The test session (architecture §11.3): a real song Session (src/stage/session.js `openSession`)
// over in-memory persistence, for every test that needs the Stage's state without a backend.
//
//   const ts = await createTestSession({tempo, practice, stems, mapped, account, clock, …});
//   ts.session      the real Session: SongMapStore, Metronome, MultitrackEngine, transport,
//                   position, practice state, undo, notation session, detect flow, frame bus
//   ts.server       the in-memory backend (songs, practice, tempo saves, jobs; see below)
//   await ts.play() / ts.advance(sec) / ts.passes()
//
// Browser-safe: this module imports no test framework and no Node API, so a harness page
// (§11.2) can build the same session over fixture data. Under vitest the audio comes from
// tests/helpers/fake-audio.js; the test file installs it (vi.mock is per test file):
//
//   vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
//   vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));
//   beforeEach(() => { vi.useFakeTimers(FAKE_TIMERS); clockModule.set(); restore = installFakeAudio(); clock = createClock(); });
//
// and passes `clock` (createClock()) so `advance(sec)` moves audio time and the fake timers
// together. In a browser the engine runs on the page's AudioContext; stems are silent WAV blobs
// (or `media` signs real keys) and `advance` uses the fixture's manual audio clock
// (`window.fixture.advance`, fx-audio=manual) when no clock is given.
//
// Options (all optional):
//   tempo        the stored `songs.tempo` (default: the rehearsal song `sectioned` when
//                `mapped`, else null: a song nobody mapped)
//   mapped       true (default) | false; ignored when `tempo` is given
//   practice     the stored practice blob (v1, v2 or null: no saved practice)
//   stems        stem names (default: the rehearsal song's four)
//   account      AccountSettings merged over DEFAULT_ACCOUNT (profile drums, count-in off, click 'countin')
//   clock        the fake audio clock ({advance(sec), now()})
//   duration     seconds (default: the tempo fixture's duration, else 128)
//   id, title, artist, hasChart, sectionSuggestion, recordingUnconfirmed, song: {…}  song row fields
//   score        a drum part (shared/notation.ts score): sets hasChart and an in-memory part store
//   shared       {token} → a read-only Shared Stage session (no songs API; practice stays local)
//   desktop      true → this computer's processor is ready (canDetect ok); or a desktop object
//   devices      'online' | 'offline' | device rows: the paired computers (B5, web detection)
//   accountStatus 'active' (default) | 'export_only' | 'suspended'
//   load         true (default): resolve once the audio is ready; false: resolve right after open
//   songs, jobs, media, createTransport, openPart, notationPersistence, status, navigate,
//   window, document   replace a dependency of openSession
//
// The in-memory server (`ts.server`) behaves like convex/songs.ts and worker.ts where the
// session can tell: subscriptions deliver on a microtask; `saveTempo` bumps `tempoRev`, stores
// `tempoSaveId`, echoes the row, refuses a stale base that would replace a real map with an
// unreal one (`conflict`) and clears `sectionSuggestion` when sections appear; `savePractice`
// stores the blob and echoes it; map writes keep the other `tempo` fields (nonMapFields) and an
// unchanged map is a no-op; a beats job that finishes on a song with no real map (a drum part
// counts as one) writes a usable detected map itself and stamps `appliedAt` (D44); sections
// become a suggestion only when the map has none (D47).

import {signal} from '../../src/app/store.js';
import {openSession} from '../../src/stage/session.js';
import {beatsOf} from '../../src/stage/detect.js';
import {MultitrackEngine} from '../../src/js/engine.js';
import {cleanSongMap, fromBeats, hasRealMap, sectionsOf, songMapFromTempo, validateSongMap} from '../../shared/song-map.ts';
import {sameContent} from '../../shared/content.ts';
import {sectioned} from '../fixtures/maps.js';

/** The rehearsal song's stems (glasshouse, Appendix A). */
export const DEFAULT_STEMS = Object.freeze(['drums', 'bass', 'vocals', 'other']);
export const DEFAULT_DURATION = 128;
export const TRANSPORT_EVENTS = Object.freeze(['pass', 'trainer', 'jumped', 'ended', 'interrupted', 'count', 'gesture', 'mix-sheet']);
/** Account settings for a drummer with today's defaults (count-in off, click during count-in, Stop returns to the cue). */
export const DEFAULT_ACCOUNT = Object.freeze({
  practice: Object.freeze({stop: 'cue', countIn: Object.freeze({on: false, length: 1, unit: 'bars'}), click: 'countin', eachPassCount: true, keepPitch: true}),
  profile: Object.freeze({instruments: Object.freeze(['drums']), primary: 'drums', openWithMyPart: 'in'}),
});
/** How many microtask turns `settle()` and the load wait give the session (no timers involved). */
export const SETTLE_TURNS = 50;
const LOAD_TURNS = 2000;
const LOCAL_DEVICE = 'device-local';

let sequence = 0;

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
/** convex/songs.ts MAP_KEYS / nonMapFields: a map write keeps every other `tempo` field (D51's 1.9 click settings). */
const MAP_KEYS = new Set(['songMap', 'source', 'map', 'detected']);
const nonMapFields = (tempo) => (!tempo || typeof tempo !== 'object' || Array.isArray(tempo) ? {}
  : Object.fromEntries(Object.entries(tempo).filter(([key, value]) => !MAP_KEYS.has(key) && value !== undefined)));
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** Plain deep merge for settings objects (arrays and scalars replace). */
function merge(base, over) {
  if (!isObject(over)) return clone(base);
  const out = clone(base) ?? {};
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(out[k]) ? merge(out[k], v) : clone(v);
  return out;
}

/** `n` microtask turns: lets promise chains (subscriptions, saves, loads) run without touching timers. */
export async function settle(turns = SETTLE_TURNS) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** A subscription hub: `subscribe(onValue)` delivers the current value on a microtask, `push` later ones. */
function channel(current) {
  const subs = new Set();
  return {
    subscribe(onValue, onError) {
      const sub = {onValue, onError, live: true};
      subs.add(sub);
      queueMicrotask(() => { if (sub.live) sub.onValue(clone(current())); });
      return () => { sub.live = false; subs.delete(sub); };
    },
    push() {
      const value = current();
      for (const sub of [...subs]) if (sub.live) sub.onValue(clone(value));
    },
    get size() { return subs.size; },
  };
}

/** A mono 16-bit silent WAV of `seconds` (browser stems when no `media` is given). */
function silentWavUrl(seconds) {
  const rate = 8000, frames = Math.max(1, Math.ceil(seconds * rate));
  const view = new DataView(new ArrayBuffer(44 + frames * 2));
  const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, frames * 2, true);
  return URL.createObjectURL(new Blob([view.buffer], {type: 'audio/wav'}));
}

/**
 * The in-memory backend for one song: the row (`songs.get`), its practice (`songs.getPractice`),
 * and its detection jobs. Every call is recorded in `calls`.
 */
export function createTestServer(song, {practice = null, clock = {now: () => Date.now()}} = {}) {
  let row = clone(song);
  let stored = clone(practice);
  const songCh = channel(() => row);
  const practiceCh = channel(() => stored);
  const jobs = new Map();          // jobId → job row
  const jobChannels = new Map();   // jobId → channel
  let jobSeq = 0;
  const calls = {savePractice: [], saveTempo: [], dismissSectionSuggestion: [], confirmRecording: [], markApplied: [],
    createBeatDetection: [], createSectionDetection: [], retry: [], latestDetection: []};

  const jobChannel = (jobId) => {
    let ch = jobChannels.get(jobId);
    if (!ch) jobChannels.set(jobId, ch = channel(() => jobs.get(jobId) ?? null));
    return ch;
  };
  const touchJob = (jobId, patch) => {
    const job = jobs.get(jobId);
    if (!job) throw new Error(`No job ${jobId}`);
    Object.assign(job, patch, {updatedAt: clock.now()});
    jobChannel(jobId).push();
    return clone(job);
  };
  const live = (job) => job.status === 'queued' || job.status === 'running';

  function createDetection(kind, {songId, deviceId} = {}) {
    const existing = [...jobs.values()].find((j) => j.songId === songId && j.kind === kind && live(j));
    if (existing) return {jobId: existing.jobId};
    const jobId = `job-${kind}-${++jobSeq}`;
    jobs.set(jobId, {jobId, kind, songId, deviceId: deviceId ?? null, status: 'queued', stage: 'queued', percent: 0,
      createdAt: clock.now(), updatedAt: clock.now(), result: null, appliedAt: null});
    return {jobId};
  }

  const songsApi = {
    subscribeSong: (args, onValue, onError) => songCh.subscribe(onValue, onError),
    subscribePractice: (args, onValue, onError) => practiceCh.subscribe(onValue, onError),
    async savePractice({id, practice: next, final}) {
      calls.savePractice.push({id, practice: clone(next), final: !!final});
      stored = clone(next);
      queueMicrotask(() => practiceCh.push());
      return null;
    },
    async saveTempo({id, tempo, baseRev, saveId}) {
      calls.saveTempo.push({id, tempo: clone(tempo), baseRev, saveId});
      const songMap = cleanSongMap(tempo?.songMap);
      if (!songMap) throw Object.assign(new Error('This song map could not be saved.'), {code: 'invalid'});
      const rev = row.tempoRev ?? 0;
      const next = {...nonMapFields(row.tempo), songMap};
      if (sameContent(clone(row.tempo) ?? null, clone(next))) return {tempoRev: rev, conflict: false};
      if (baseRev !== rev && hasRealMap(row.tempo) && !hasRealMap(next)) return {tempoRev: rev, conflict: true, tempo: clone(row.tempo)};
      row = {...row, tempo: next, tempoRev: rev + 1, tempoSaveId: saveId};
      if (row.sectionSuggestion && sectionsOf(songMap, Math.max(0.001, row.duration || 0)).length) delete row.sectionSuggestion;
      queueMicrotask(() => songCh.push());
      return {tempoRev: rev + 1, conflict: false};
    },
    async dismissSectionSuggestion({id}) {
      calls.dismissSectionSuggestion.push({id});
      if (row.sectionSuggestion) { row = {...row}; delete row.sectionSuggestion; queueMicrotask(() => songCh.push()); }
      return null;
    },
    async confirmRecording({id}) {
      calls.confirmRecording.push({id});
      if (row.recordingUnconfirmed) { row = {...row, recordingUnconfirmed: false}; queueMicrotask(() => songCh.push()); }
      return null;
    },
  };

  const jobsApi = {
    async createBeatDetection(args) { calls.createBeatDetection.push(clone(args)); return createDetection('beats', args); },
    async createSectionDetection(args) { calls.createSectionDetection.push(clone(args)); return createDetection('sections', args); },
    subscribeJob: ({jobId}, onValue, onError) => jobChannel(jobId).subscribe(onValue, onError),
    async latestDetection({songId}) {
      calls.latestDetection.push({songId});
      const list = [...jobs.values()].filter((j) => j.songId === songId && (j.kind === 'beats' || j.kind === 'sections'));
      return clone(list.at(-1) ?? null);
    },
    async markApplied({jobId}) {
      calls.markApplied.push({jobId});
      if (jobs.has(jobId)) touchJob(jobId, {appliedAt: clock.now()});
      return null;
    },
    async retry({jobId}) {
      calls.retry.push({jobId});
      if (jobs.has(jobId)) touchJob(jobId, {status: 'queued', stage: 'queued', percent: 0, error: undefined, errorCode: undefined});
      return {jobId};
    },
  };

  return {
    songs: songsApi,
    jobs: jobsApi,
    calls,
    /** The stored row (a copy). */
    get song() { return clone(row); },
    /** The stored practice blob (a copy). */
    get practice() { return clone(stored); },
    get tempoRev() { return row.tempoRev ?? 0; },
    /** Every job row (copies). */
    get jobRows() { return [...jobs.values()].map(clone); },
    job: (jobId) => clone(jobs.get(jobId) ?? null),
    /** Another device changed the row (merge `patch`; a `tempo` bumps `tempoRev` with no save id of ours). */
    pushSong(patch = {}) {
      const next = {...row, ...clone(patch)};
      if ('tempo' in patch && !('tempoRev' in patch)) { next.tempoRev = (row.tempoRev ?? 0) + 1; next.tempoSaveId = undefined; }
      row = next;
      songCh.push();
    },
    /** Another device saved practice. */
    pushPractice(next) { stored = clone(next); practiceCh.push(); },
    /** Seed a job row (e.g. a finished, unapplied detection for the resume offer). */
    addJob(job) {
      const jobId = job.jobId ?? `job-${job.kind ?? 'beats'}-${++jobSeq}`;
      jobs.set(jobId, {kind: 'beats', songId: row.id, status: 'queued', percent: 0, result: null, appliedAt: null,
        createdAt: clock.now(), updatedAt: clock.now(), ...clone(job), jobId});
      return jobId;
    },
    /** The worker reports progress. */
    progressJob: (jobId, percent, extra = {}) => touchJob(jobId, {status: 'running', stage: 'detect', percent, ...extra}),
    /**
     * The worker finishes a detection. `beats` is `[[time, beatInBar], …]` (or `{time, downbeat}`).
     * On a song with no real map (a drum part counts as one) a usable beats result is written by the
     * server itself (worker.beatsDone, D44); non-empty `sections` become the song's
     * `sectionSuggestion` when its map has no sections (worker.suggestSections, D47).
     */
    finishJob(jobId, {beats = [], sections = null} = {}) {
      const job = jobs.get(jobId);
      if (!job) throw new Error(`No job ${jobId}`);
      const list = Array.isArray(sections) ? clone(sections) : [];
      const result = job.kind === 'beats'
        ? {beats: beats.map((b) => (Array.isArray(b) ? b : [b.time, b.downbeat ? 1 : 2])), sections: list}
        : {sections: list};
      let patch = {status: 'done', stage: 'done', percent: 100, result};
      let songPatch = null;
      const duration = row.duration;
      let map = songMapFromTempo(row.tempo, duration);
      // worker.beatsDone: only a song with no real map (a drum part counts as one) and only a usable map.
      if (job.kind === 'beats' && result.beats.length && !hasRealMap(row.tempo, {hasPart: row.hasChart === true})) {
        const detected = {...fromBeats(beatsOf(result), duration), origin: 'detected'};
        let usable = detected.pins.length >= 2;
        try { validateSongMap(detected); } catch { usable = false; }
        if (usable) {
          songPatch = {tempo: {...nonMapFields(row.tempo), songMap: detected}, tempoRev: (row.tempoRev ?? 0) + 1, tempoSaveId: undefined};
          patch = {...patch, appliedAt: clock.now()};
          map = detected;
        }
      }
      // worker.suggestSections (D47): only a non-empty list, only when the map has no sections of its own.
      if (list.length && !sectionsOf(map, duration).length) {
        songPatch = {...songPatch, sectionSuggestion: {jobId, createdAt: clock.now(), sections: list}};
      }
      if (songPatch) { row = {...row, ...songPatch}; songCh.push(); }
      return touchJob(jobId, patch);
    },
    /** The worker fails a detection with an error code (e.g. 'sync_failed'). */
    failJob: (jobId, code = 'unknown', message = 'Detection failed.') => touchJob(jobId, {status: 'error', errorCode: code, error: message}),
  };
}

/**
 * Builds a real Session over in-memory persistence (see the file header). Resolves once the
 * audio is ready (or failed), unless `load: false`.
 */
export async function createTestSession({
  tempo, mapped = true, practice = null, stems = DEFAULT_STEMS, account = {}, clock = null, duration, id, title = 'Glasshouse',
  artist = 'Northbound', hasChart, score = null, sectionSuggestion, recordingUnconfirmed, song: songOverrides = {}, shared = null,
  desktop: desktopOption = false, devices = [], accountStatus = 'active', load = true,
  songs, jobs, media, createTransport, openPart, notationPersistence, status, navigate, window: win = null, document: doc = null,
} = {}) {
  const n = ++sequence;
  const songId = id ?? `test-song-${n}`;
  const storedTempo = tempo !== undefined ? clone(tempo) : mapped ? clone(sectioned.tempo) : null;
  const length = Number.isFinite(duration) ? duration : tempo === undefined && mapped ? sectioned.duration : DEFAULT_DURATION;
  const row = {
    id: songId, title, artist, duration: length,
    stems: stems.map((name) => ({name, key: `${songId}-${n}/${name}`})),
    tempo: storedTempo, tempoRev: 1, hasChart: !!(hasChart ?? score),
    ...(sectionSuggestion ? {sectionSuggestion: clone(sectionSuggestion)} : {}),
    ...(recordingUnconfirmed ? {recordingUnconfirmed: true} : {}),
    ...clone(songOverrides),
  };

  // Wall-clock reads (job rows) follow the app clock; audio time is the engine's.
  const wall = {now: () => Date.now()};
  const server = createTestServer(row, {practice, clock: wall});

  // Recorders.
  const statuses = [];
  const navigations = [];
  const flushRequests = [];
  const recordStatus = status ?? ((text, options = {}) => { statuses.push({text, ...options}); });

  const accountValue = signal(merge(DEFAULT_ACCOUNT, account));
  const accountModule = {value: accountValue, loaded: signal(true)};
  const accountSession = signal({status: accountStatus});
  const deviceRows = devices === 'online' ? [{deviceId: 'device-online', name: 'Studio Mac', state: 'idle', lastSeenAt: Date.now()}]
    : devices === 'offline' ? [{deviceId: 'device-offline', name: 'Old PC', state: 'offline', lastSeenAt: Date.now() - 3_600_000}]
      : Array.isArray(devices) ? clone(devices) : [];
  const library = {jobs: signal([]), devices: signal(deviceRows)};
  const desktop = isObject(desktopOption) ? desktopOption : {
    available: !!desktopOption,
    processor: signal(desktopOption ? {phase: 'ready', deviceId: LOCAL_DEVICE} : {phase: 'web'}),
    onFlushRequest: (cb) => { flushRequests.push(cb); return () => { const i = flushRequests.indexOf(cb); if (i >= 0) flushRequests.splice(i, 1); }; },
  };

  let fakeAudio = false;
  const makeEngine = () => {
    const engine = new MultitrackEngine();
    fakeAudio = 'decodeDuration' in engine.ctx;
    if (fakeAudio) engine.ctx.decodeDuration = length;
    return engine;
  };
  const blobUrls = [];
  const mediaApi = media ?? {
    async signKeys(keys) {
      if (fakeAudio || typeof URL?.createObjectURL !== 'function') return Object.fromEntries(keys.map((k) => [k, `https://stems.invalid/${k}`]));
      return Object.fromEntries(keys.map((k) => { const url = silentWavUrl(length); blobUrls.push(url); return [k, url]; }));
    },
  };

  const partScore = score ? clone(score) : null;
  const partSaves = [];
  const persistence = notationPersistence ?? {
    load: async () => clone(partScore),
    set: (next) => { partSaves.push(clone(next)); },
    flush: async () => {},
    destroy: () => {},
    reload: async () => clone(partSaves.at(-1) ?? partScore),
    blocked: false,
  };

  const sharedOption = shared ? {
    token: shared.token ?? `share-${n}`,
    snapshot: {...clone(row), practice: clone(practice)},
    resolveUrls: async () => mediaApi.signKeys(row.stems.map((s) => s.key)),
    cacheNamespace: `share-${n}:`,
  } : null;

  const session = await openSession(songId, {
    shared: sharedOption,
    songs: songs ?? server.songs,
    jobs: jobs ?? server.jobs,
    media: mediaApi,
    account: accountModule,
    desktop,
    status: recordStatus,
    createEngine: makeEngine,
    ...(createTransport ? {createTransport} : {}),
    openPart,
    notationPersistence: persistence,
    window: win,
    document: doc,
    detect: {library, accountSession, navigate: navigate ?? ((path) => { navigations.push(path); })},
  });

  // Every transport event and phase, in order.
  const events = [];
  const offs = [];
  const transport = session.transport;
  for (const type of TRANSPORT_EVENTS) {
    if (typeof transport?.on === 'function') offs.push(transport.on(type, (payload) => events.push({type, ...(payload ?? {})})));
  }
  const phases = [];
  if (transport?.snapshot?.subscribe) {
    offs.push(transport.snapshot.subscribe((s) => { if (phases.at(-1) !== s.phase) phases.push(s.phase); }));
  }

  const ts = {
    session,
    server,
    statuses,
    navigations,
    events,
    phases,
    /** Notation part saves made through the in-memory part store. */
    partSaves,
    library,
    accountSession,
    get id() { return session.id; },
    get transport() { return session.transport; },
    get map() { return session.map; },
    get practice() { return session.practice; },
    get position() { return session.position; },
    get undo() { return session.undo; },
    get engine() { return session.engine; },
    get metronome() { return session.metronome; },
    get notation() { return session.notation; },
    get detect() { return session.detect; },
    get frame() { return session.frame; },
    /** The transport snapshot (TransportState). */
    get snapshot() { return session.transport.snapshot.peek(); },
    /** The practice value (PracticeV2). */
    get value() { return session.practice.value.peek(); },
    /** Audio time (ctx.currentTime). */
    get now() { return session.engine.ctx.currentTime; },
    /** Events of one type. */
    of: (type) => events.filter((e) => e.type === type),
    /** The number of completed passes since the session opened (transport 'pass' events). */
    passes: () => events.filter((e) => e.type === 'pass').length,
    /** Account settings: replace parts of them (the transport and the detect flow follow). */
    setAccount(patch) { accountValue.value = merge(accountValue.peek(), patch); },
    /** The desktop asks every session to flush (quit, update). */
    requestFlush: () => Promise.all(flushRequests.map((cb) => cb())),
    settle,
    /** Waits for the audio: resolves with the LoadState once it is 'ready' or 'error'. */
    ready: () => waitForLoad(session),
    /** Press Play (the transport's play()), then let the start settle. Resolves with the snapshot. */
    async play() {
      await session.transport.play();
      await settle();
      return ts.snapshot;
    },
    /** Move audio time (and the fake timers) by `sec`, then let promise chains settle. */
    async advance(sec) {
      if (clock && typeof clock.advance === 'function') clock.advance(sec);
      else if (typeof globalThis.fixture?.advance === 'function') await globalThis.fixture.advance(sec * 1000);
      else throw new Error('createTestSession: advance(sec) needs a clock (tests/helpers/fake-audio.js createClock()) or the fixture\'s manual audio (fx-audio=manual).');
      await settle();
      return ts.now;
    },
    /** Final flush, then destroy the session and release its recorders. */
    async dispose() {
      for (const off of offs.splice(0)) off?.();
      await session.dispose();
      for (const url of blobUrls.splice(0)) URL.revokeObjectURL?.(url);
    },
  };

  if (load) await waitForLoad(session);
  return ts;
}

/** Resolves with the LoadState once the session's audio is 'ready' or 'error'. */
export async function waitForLoad(session) {
  const done = (l) => l.phase === 'ready' || l.phase === 'error';
  for (let i = 0; i < LOAD_TURNS && !done(session.load.peek()); i++) await Promise.resolve();
  if (done(session.load.peek())) return session.load.peek();
  // Real audio (a browser) decodes on its own time: wait for the phase change.
  return new Promise((resolve) => {
    let off = null;
    off = session.load.subscribe((l) => { if (done(l)) { off?.(); resolve(l); } });
    if (done(session.load.peek())) { off?.(); resolve(session.load.peek()); }
  });
}

export default createTestSession;
