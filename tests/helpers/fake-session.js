// A fake song Session for pure view tests (architecture §11.3): every key the real Session has
// (src/stage/session.js), with no audio, no timers and no backend. Tests that need behaviour
// (playback, saves, undo through the transport, detection) use tests/helpers/test-session.js.
//
//   const s = createFakeSession({mapped, tempo, duration, stems, practice, snapshot, load});
//   mount(el, {session: s});
//   s.transport.set({phase: 'playing', loop: {on: true, a: 32, b: 48}});   // drive the view
//   s.transport.calls                                                      // [['toggleLoop'], …]
//
// What is real and what is fake:
// - real and pure: `map` (SongMapStore over the stored tempo), `position` (the position model),
//   `undo` (the practice undo stack), `peaks` (an empty peaks cache unless one is passed);
// - fake: `transport` (a settable snapshot built from the practice value, recorded calls, `on` +
//   `emit`, `position()` from `setPosition(t)`), `practice` (a practice value signal whose
//   writes apply synchronously), `engine` (state read from the snapshot), `metronome`
//   (`emitBeat(beat)` delivers an onBeat), `notation`, `frame` (`emit()` delivers a frame),
//   `detect`, `load` (`setLoad(patch)`) and the session methods (recorded in `calls`).
//
// The shape is checked against a real session (tests/helpers-test-session.test.js): a key of the
// real Session, of one of its members or of the transport snapshot that is missing here fails
// that test; the engine and metronome are compared by public prototype-chain names, less the
// reviewed OMITTED_MEMBERS. `sessionShape(obj)` is the description both sides are compared with.
//
// Browser-safe: no test framework, no Node API.

import {signal, readonly} from '../../src/app/store.js';
import {SongMapStore} from '../../src/js/song-map.js';
import {createPositionModel} from '../../src/stage/position.js';
import {createPracticeUndo} from '../../src/stage/undo.js';
import {createPeaks} from '../../src/stage/wave-render.js';
import {canonicalStems} from '../../src/stage/transport.js';
import {upgradePractice} from '../../shared/practice.ts';
import {sectioned} from '../fixtures/maps.js';

export const DEFAULT_STEMS = Object.freeze(['drums', 'bass', 'vocals', 'other']);

/** Session members whose own keys the shape check compares (the rest are compared by name only). */
export const SHAPED_MEMBERS = Object.freeze(['transport', 'position', 'practice', 'undo', 'notation', 'frame', 'detect', 'peaks']);

/**
 * Class-instance members (MultitrackEngine, Metronome) are compared by their public names along
 * the prototype chain (fields, getters and methods; `_`-prefixed internals excluded). View tests
 * reach audio through the transport, so the fakes cover only what a view reads; every other
 * public member is listed here as a deliberate omission. A new real member fails the shape test
 * until it is faked or added below, and an omission the real class no longer has fails too.
 */
export const NAMED_MEMBERS = Object.freeze(['engine', 'metronome']);
export const OMITTED_MEMBERS = Object.freeze({
  // Loading, mixing, scheduling and seeking: the transport owns these (§2.14); a view never calls them.
  engine: Object.freeze([
    'master', 'recordingAudible', 'stretch', 'pitchGate', 'splitter', 'plan', 'planVersion', 'playRequest', 'revision',
    'transportListeners', 'pausedAt', 'editPosition', 'countIn', 'stopAtWhen', 'onEnded',
    'loadStems', 'setVolume', 'setRecordingAudible', 'setMuted', 'setSoloed', 'toggleMute', 'toggleSolo', 'resetMixer',
    'setTrackGains', 'loopGap', 'getPositionAt', 'subscribeTransport', 'play', 'pause', 'stop', 'seek', 'seekAt',
    'cancelPending', 'stopAt', 'cancelStopAt', 'setSpeed', 'setPreservePitch', 'setLoop', 'beatsBetween', 'gapsBetween',
  ]),
  // Click scheduling and the map wiring: the transport configures the click (D14); views read settings().
  metronome: Object.freeze([
    'engine', 'ctx', 'out', 'countInAudible', 'accent', 'volume', 'countIn', 'countInLength', 'countInUnit', 'audiblePreRoll',
    'onChange', 'setDetected', 'recompute', 'sectionAt', 'setEnabled', 'start', 'stop', 'tick',
  ]),
});

/** Public names of an object along its prototype chain (own fields, getters, methods; no `_` internals). */
export function memberNames(obj) {
  const out = new Set();
  for (let p = obj; p && p !== Object.prototype && p !== Function.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) if (k !== 'constructor' && !k.startsWith('_')) out.add(k);
  }
  return [...out];
}

/** Every method of the transport (§2.14.3, as built by src/stage/transport.js). */
export const TRANSPORT_METHODS = Object.freeze([
  'position', 'playStop', 'play', 'stop', 'pause', 'again', 'playFrom',
  'cue', 'seek', 'step', 'nudgeCue', 'home', 'end', 'jump', 'cancelJump', 'goToRegion',
  'toggleLoop', 'loopSection', 'loopRange', 'loopBars', 'loopIn', 'loopOut',
  'moveLoop', 'extendLoopTo', 'nudgeLoopEdge', 'clearLoop', 'setLoopOptions',
  'setSpeed', 'nudgeSpeed', 'toggleSpeed100', 'setKeepPitch', 'startTrainer', 'stopTrainer',
  'setCountIn', 'toggleCountIn', 'setClickMode', 'toggleClick', 'setAccent', 'setClickVolume', 'setPreRoll',
  'setMuted', 'setSoloed', 'setVolume', 'toggleMuteAt', 'toggleSoloAt',
  'minusMe', 'onlyMe', 'fullMix', 'setChartAudio', 'startOver',
  'interrupt', 'armPlayWhenReady', 'ready', 'on', 'destroy',
]);

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const isPlain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isSignal = (value) => !!value && typeof value === 'object' && typeof value.peek === 'function' && typeof value.subscribe === 'function';

/** Every own key of an object (getters included, in definition order). */
function keysOf(obj) {
  return obj && (typeof obj === 'object' || typeof obj === 'function') ? Object.getOwnPropertyNames(obj) : [];
}

/** Plain-object keys two levels deep (loop.a, mix.tracks, …); arrays, signals and deeper values are leaves. */
function deepKeys(value, prefix = '', depth = 2) {
  if (!isPlain(value) || depth <= 0) return [];
  return Object.keys(value).flatMap((k) => [`${prefix}${k}`, ...deepKeys(value[k], `${prefix}${k}.`, depth - 1)]);
}

/**
 * The shape the fake must cover: {session: keys, members: {transport: keys, …}, snapshot: keys,
 * load: keys}. Reads values only through `peek` (no subscriptions) and never calls a method.
 */
export function sessionShape(session) {
  const members = {};
  for (const name of SHAPED_MEMBERS) members[name] = keysOf(session[name]);
  const named = {};
  for (const name of NAMED_MEMBERS) named[name] = memberNames(session[name]);
  const snapshot = session.transport?.snapshot;
  return {
    session: keysOf(session),
    members,
    named,
    snapshot: deepKeys(isSignal(snapshot) ? snapshot.peek() : null),
    load: deepKeys(isSignal(session.load) ? session.load.peek() : null),
  };
}

/** Keys of `real`'s shape that `fake`'s shape lacks, as 'member.key' strings (empty when covered). */
export function missingKeys(real, fake) {
  const out = [];
  const diff = (where, a, b) => { for (const k of a) if (!b.includes(k)) out.push(`${where}${k}`); };
  diff('', real.session, fake.session);
  for (const name of Object.keys(real.members)) diff(`${name}.`, real.members[name], fake.members[name] ?? []);
  for (const name of Object.keys(real.named ?? {})) {
    diff(`${name}.`, real.named[name], [...(fake.named?.[name] ?? []), ...(OMITTED_MEMBERS[name] ?? [])]);
  }
  diff('snapshot.', real.snapshot, fake.snapshot);
  diff('load.', real.load, fake.load);
  return out;
}

/** A recorder: `calls` lists [name, ...args]; `fn(name, result)` records and returns `result(...args)`. */
function recorder() {
  const calls = [];
  const fn = (name, result) => (...args) => {
    calls.push([name, ...args]);
    return typeof result === 'function' ? result(...args) : result;
  };
  return {calls, fn};
}

/** Event hub with `on(event, fn) → off` and `emit(event, payload)`. */
function hub() {
  const listeners = new Map();
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => { listeners.get(event)?.delete(fn); };
    },
    emit(event, payload) { for (const fn of [...(listeners.get(event) ?? [])]) fn(payload); },
  };
}

/** Deep-merge plain objects (arrays and scalars replace). */
function merge(base, over) {
  if (!isPlain(over)) return base;
  const out = {...base};
  for (const [k, v] of Object.entries(over)) out[k] = isPlain(v) && isPlain(out[k]) ? merge(out[k], v) : v;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

function fakePractice({raw, duration}) {
  const {calls, fn} = recorder();
  const state = signal(upgradePractice(raw ?? null, {duration}));
  const activeSpotId = signal(null);
  let seq = 0;
  const write = (mutate) => {
    const draft = clone(state.peek());
    mutate(draft);
    state.value = draft;
  };
  const patch = (partial, options) => {
    calls.push(['patch', partial, options]);
    write((draft) => { if (typeof partial === 'function') partial(draft); else Object.assign(draft, clone(partial)); });
  };
  return {
    value: readonly(state),
    patch,
    addSpot(spot) {
      const id = spot?.id ?? `spot-${++seq}`;
      calls.push(['addSpot', spot]);
      write((d) => { d.spots.push({rate: 1, passes: 0, notes: '', ...clone(spot), id}); });
      return id;
    },
    updateSpot(id, change) {
      calls.push(['updateSpot', id, change]);
      write((d) => { const s = d.spots.find((x) => x.id === id); if (s) Object.assign(s, clone(change)); });
    },
    deleteSpot(id) {
      calls.push(['deleteSpot', id]);
      write((d) => { const s = d.spots.find((x) => x.id === id); if (s) s.deleted = true; });
    },
    touchSpot: fn('touchSpot'),
    activeSpotId,
    addMarker(marker) {
      const id = `marker-${++seq}`;
      calls.push(['addMarker', marker]);
      write((d) => { d.markers.push({label: '', updatedAt: 0, ...clone(marker), id}); });
      return id;
    },
    renameMarker(id, label) {
      calls.push(['renameMarker', id, label]);
      write((d) => { const m = d.markers.find((x) => x.id === id); if (m) m.label = label; });
    },
    deleteMarker(id) {
      calls.push(['deleteMarker', id]);
      write((d) => { const m = d.markers.find((x) => x.id === id); if (m) m.deleted = true; });
    },
    reanchor: fn('reanchor'),
    markPlayed: fn('markPlayed'),
    markStopped: fn('markStopped'),
    flush: fn('flush', () => Promise.resolve()),
    dispose: fn('dispose'),
    get pending() { return false; },
    calls,
    /** Replace the practice value (a server update in a view test). */
    set(next) { state.value = upgradePractice(next, {duration}); },
  };
}

/** The TransportState the fake transport starts from: the practice value seen through the transport's rules. */
function snapshotFrom(p, {stems, position, mine}) {
  const byName = new Map((p.tracks ?? []).map((t) => [t.name, t]));
  const click = p.click ?? {countIn: {on: false, length: 1, unit: 'bars'}, mode: 'countin', accent: true, volume: 0.7, preRoll: false};
  const loop = p.loop;
  return {
    phase: 'stopped', armed: false,
    cue: p.cue, rate: p.rate, lastRate: p.lastRate ?? null, keepPitch: p.keepPitch ?? true,
    loop: {
      on: !!loop.on, a: loop.a, b: loop.b, aBar: loop.aBar ?? null, bBar: loop.bBar ?? null,
      eachPassCount: loop.eachPassCount, playTimes: loop.playTimes, between: loop.between,
      label: loop.b - loop.a >= 0.02 ? position.loopLabel(loop.a, loop.b) : '', role: null,
    },
    pass: 0, passTarget: loop.on && loop.playTimes > 0 ? loop.playTimes : null,
    countIn: {...click.countIn},
    click: {mode: click.mode, lastMode: click.lastMode ?? 'countin', accent: click.accent, volume: click.volume, preRoll: click.preRoll},
    countdown: null,
    mix: {
      tracks: canonicalStems(stems).map((name) => {
        const t = byName.get(name);
        return {name, volume: t ? t.volume : 1, muted: !!t?.muted, soloed: !!t?.soloed};
      }),
      minusMe: !!p.minusMe, onlyMe: !!p.onlyMe, mine: [...mine], chartAudio: p.chartAudio ?? 'off',
    },
    trainer: null,
    pendingJump: null,
  };
}

function fakeTransport({practice, position, stems, mine, snapshot}) {
  const {calls, fn} = recorder();
  const events = hub();
  const snap = signal(merge(snapshotFrom(practice.value.peek(), {stems, position, mine}), snapshot));
  let time = snap.peek().cue;
  const t = {snapshot: readonly(snap)};
  for (const name of TRANSPORT_METHODS) {
    if (name === 'position' || name === 'on') continue;
    t[name] = fn(name, name === 'ready' || name.startsWith('play') || name === 'pause' || name === 'again' || name === 'armPlayWhenReady'
      ? () => Promise.resolve() : null);
  }
  t.position = () => time;
  t.on = (event, handler) => events.on(event, handler);
  Object.defineProperty(t, 'isReady', {get: () => snap.peek().phase !== 'loading', enumerable: true});
  t.calls = calls;
  /** Merge `patch` into the snapshot (nested objects merge; arrays replace). */
  t.set = (patch) => { snap.value = merge(snap.peek(), patch); };
  /** Where `position()` reads (the playhead). */
  t.setPosition = (seconds) => { time = seconds; };
  /** Fire a transport event ('pass', 'count', 'jumped', …). */
  t.emit = (event, payload = {}) => events.emit(event, payload);
  return t;
}

function fakeEngine({stems, duration, transport}) {
  const events = hub();
  const ctx = {currentTime: 0, state: 'running', sampleRate: 48000};
  return {
    ctx,
    tracks: stems.map((name) => ({name, volume: 1, muted: false, soloed: false})),
    duration,
    get playing() { const p = transport.snapshot.peek().phase; return p === 'playing' || p === 'counting'; },
    get paused() { return transport.snapshot.peek().phase === 'paused'; },
    get countingIn() { return transport.snapshot.peek().phase === 'counting'; },
    lookahead: 0.05,
    aux: null,
    get rate() { return transport.snapshot.peek().rate ?? 1; },
    get loop() { const l = transport.snapshot.peek().loop; return {enabled: !!l?.on, a: l?.a ?? 0, b: l?.b ?? 0}; },
    get preservePitch() { return transport.snapshot.peek().keepPitch ?? true; },
    destroyed: false,
    getPosition: () => transport.position(),
    nextWrapAt: () => null,
    whenAt: () => null,
    on: (event, fn) => events.on(event, fn),
    emit: (event, payload) => events.emit(event, payload),
    destroy() { this.destroyed = true; },
  };
}

function fakeMetronome({map}) {
  const {calls, fn} = recorder();
  let settings = {countIn: false, countInLength: 1, countInUnit: 'bars', mode: 'countin', accent: true, volume: 0.7, audiblePreRoll: false};
  const beatListeners = new Set();
  return {
    calls,
    get mode() { return settings.mode; },
    get enabled() { return settings.mode === 'always'; },
    get songMap() { return map; },
    get beats() { return map.beats; },
    /** `fn({when, downbeat, …})` per click; returns off(). `emitBeat(beat)` delivers one. */
    onBeat(fn) { beatListeners.add(fn); return () => { beatListeners.delete(fn); }; },
    emitBeat(beat) { for (const fn of [...beatListeners]) fn(beat); },
    settings: () => ({...settings}),
    configure: (next) => { calls.push(['configure', next]); settings = {...settings, ...next}; },
    serialize: () => ({songMap: map.serialize()}),
    countInPlanAt: fn('countInPlanAt', null),
    clickAt: fn('clickAt'),
    destroy: fn('destroy'),
  };
}

function fakeNotation({readOnly, hasNotation}) {
  const {calls, fn} = recorder();
  const notationSig = signal(!!hasNotation);
  const error = signal(null);
  let chartAudio = 'off', listenMode = 'recording', paused = false;
  return {
    ready: Promise.resolve(),
    part: null,
    hasNotation: readonly(notationSig),
    error: readonly(error),
    get readOnly() { return !!readOnly; },
    drumAudio: null,
    setChartAudio(level) { calls.push(['setChartAudio', level]); chartAudio = level; },
    get chartAudio() { return chartAudio; },
    setListenMode(mode) { calls.push(['setListenMode', mode]); listenMode = mode; },
    get listenMode() { return listenMode; },
    setMapSyncPaused(on) { calls.push(['setMapSyncPaused', on]); paused = !!on; },
    get mapSyncPaused() { return paused; },
    importScore: fn('importScore', () => Promise.resolve({count: 0, skipped: 0, notice: ''})),
    start: fn('start', () => Promise.resolve()),
    open: fn('open', () => Promise.resolve()),
    flush: fn('flush', () => Promise.resolve()),
    destroy: fn('destroy'),
    calls,
    /** Set hasNotation (the part gained or lost notation). */
    setHasNotation(on) { notationSig.value = !!on; },
    setError(err) { error.value = err ?? null; },
  };
}

function fakeFrame(session) {
  const subs = new Set();
  let running = false;
  const frameOf = () => {
    const position = session.transport.position();
    const phase = session.transport.snapshot.peek().phase;
    return {
      now: session.engine.ctx.currentTime, position, playing: phase === 'playing', counting: phase === 'counting',
      bar: session.map.isReal ? session.map.barBeatAt(position) : null,
    };
  };
  return {
    subscribe(fn) { const sub = {fn}; subs.add(sub); return () => { subs.delete(sub); }; },
    start() { running = true; },
    stop() { running = false; },
    destroy() { running = false; subs.clear(); },
    get running() { return running; },
    /** Deliver one frame (default: the session's current state) to every subscriber. */
    emit(frame = frameOf()) {
      const f = Object.freeze({...frame});
      for (const sub of [...subs]) sub.fn(f);
      return f;
    },
  };
}

function fakeDetect({readOnly}) {
  const {calls, fn} = recorder();
  const state = signal({phase: 'idle'});
  const canDetect = signal(readOnly ? {ok: false, reason: 'Add this song to your library to find its bars.'} : {ok: true});
  const suggestion = signal(null);
  const offer = signal(null);
  return {
    state: readonly(state),
    canDetect: readonly(canDetect),
    start: fn('start', () => Promise.resolve()),
    retry: fn('retry', () => Promise.resolve()),
    resume: fn('resume', () => Promise.resolve()),
    offer: readonly(offer),
    useOffer: fn('useOffer'),
    dismissOffer: fn('dismissOffer'),
    suggestion: readonly(suggestion),
    keepAll: fn('keepAll', () => true),
    dismiss: fn('dismiss'),
    review: fn('review'),
    claimServerResult: fn('claimServerResult', false),
    destroy: fn('destroy'),
    calls,
    /** Drive the view: set({state, canDetect, suggestion, offer}). */
    set(patch = {}) {
      if ('state' in patch) state.value = patch.state;
      if ('canDetect' in patch) canDetect.value = patch.canDetect;
      if ('suggestion' in patch) suggestion.value = patch.suggestion;
      if ('offer' in patch) offer.value = patch.offer;
    },
  };
}

/**
 * A fake Session. Options: `mapped` (default true) or `tempo` (a stored `songs.tempo`),
 * `duration`, `stems`, `practice` (a stored blob), `mine` (the stems your instruments map to,
 * default ['drums'] when a drums stem exists), `snapshot` (merged into the transport snapshot),
 * `load` (a phase, or a LoadState patch), `readOnly`, `shareToken`, `song` (row fields),
 * `hasNotation`, `peaks`.
 */
export function createFakeSession({
  id = 'fake-song', mapped = true, tempo, duration, stems = DEFAULT_STEMS, practice = null, mine, snapshot = {}, load = 'ready',
  readOnly = false, shareToken = null, song = {}, hasNotation = false, peaks = null,
} = {}) {
  const storedTempo = tempo !== undefined ? clone(tempo) : mapped ? clone(sectioned.tempo) : null;
  const length = Number.isFinite(duration) ? duration : tempo === undefined && mapped ? sectioned.duration : 128;
  const row = {id, title: 'Glasshouse', artist: 'Northbound', duration: length, stems: stems.map((name) => ({name, key: `${id}/${name}`})),
    tempo: storedTempo, tempoRev: 1, hasChart: !!hasNotation, ...clone(song)};
  const {calls, fn} = recorder();
  const events = hub();

  const map = SongMapStore.fromTempo(storedTempo, length);
  map.setHasPart(!!row.hasChart);
  const practiceState = fakePractice({raw: practice, duration: length});
  const position = createPositionModel({map, practice: practiceState});
  const undo = createPracticeUndo();
  const myStems = mine ?? (stems.includes('drums') ? ['drums'] : []);
  const transport = fakeTransport({practice: practiceState, position, stems, mine: myStems, snapshot});
  const loadState = signal({
    phase: typeof load === 'string' ? load : 'ready', loadedBytes: 0, totalBytes: 0, decoded: stems.length, tracks: stems.length, error: null,
    ...(isPlain(load) ? load : {}),
  });
  if (loadState.peek().phase !== 'ready' && !('phase' in (snapshot ?? {}))) transport.set({phase: 'loading'});
  let disposed = false;

  const session = {
    id, readOnly: !!readOnly, shareToken: readOnly ? shareToken ?? 'fake-share' : shareToken,
    song: readonly(signal(row)),
    engine: null, metronome: fakeMetronome({map}), map, transport, position, practice: practiceState, undo,
    notation: fakeNotation({readOnly, hasNotation}),
    get peaks() { return peakCache; },
    frame: null,
    detect: fakeDetect({readOnly}),
    load: readonly(loadState),
    mapEditor: signal(null),
    /** Runs `fn(map)` with no map-stack entry; returns {entry: null} when it changed the map (as a view sees it). */
    mapChange(label, change, options) {
      calls.push(['mapChange', label, options]);
      if (readOnly) return null;
      const before = JSON.stringify(map.snapshot());
      map.withoutUndo(() => change(map));
      return JSON.stringify(map.snapshot()) === before ? null : {entry: null};
    },
    markersToSections: fn('markersToSections', null),
    suspendSaves: fn('suspendSaves'),
    retry: fn('retry', () => Promise.resolve()),
    flush: fn('flush', () => Promise.resolve()),
    on: (event, handler) => events.on(event, handler),
    get disposed() { return disposed; },
    get pending() { return false; },
    dispose: () => { calls.push(['dispose']); disposed = true; return Promise.resolve(); },
    // Test controls (not on the real Session).
    calls,
    /** Fire a session event ('loaded', 'map-real', 'tempo-adopted', 'error'). */
    emit: (event, payload) => events.emit(event, payload),
    /** Merge `patch` into the LoadState. */
    setLoad(patch) { loadState.value = {...loadState.peek(), ...patch}; },
  };
  const peakCache = peaks ?? createPeaks([]);
  session.engine = fakeEngine({stems, duration: length, transport});
  session.frame = fakeFrame(session);
  return session;
}

export default createFakeSession;
