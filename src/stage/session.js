// One song session (architecture §2.14.1): the song, its engine, metronome,
// map, transport, position, practice state, undo, drum part, peaks, frame bus
// and detection flow, shared by the Stage and Edit (the router keeps it while
// the song stays open).
//
//   getSession(songId, {shared}) → Promise<Session>   cached by id
//   disposeSession(songId)                            final flush, then destroy
//   activeSession() → Session|null                    the desktop flush, sign-out, the dev handle
//   openSession(songId, {shared, ...deps})            builds one uncached (tests, the test session)
//
// Open order (spec §4.12: the song is interactive before decode):
//   1. the song (`songs.get`) and its practice (`songs.getPractice`), or the shared snapshot;
//   2. the map from the stored tempo (one-way upgrade, no save);
//   3. the practice state (v1 → v2, legacy tempo click fields, account defaults);
//   4. the transport over an engine that has not loaded yet (getSession resolves here);
//   5. the drum part when the song has one, or when its tempo predates `songMap`
//      (legacy timeline adoption runs before the part opens; no undo step);
//   6. signed URLs → engine.loadStems with progress into `load`; then the silent
//      `map.setDuration(engine.duration)` and the peaks;
//   7. the practice state onto the engine and metronome (loop, rate, keep-pitch,
//      mix, cue, click);
//   8. `load.phase = 'ready'`, then `detect.resume()`.
//
// Tempo persistence (D53): every map change saves `metronome.serialize()` 400 ms
// later with a fresh `saveId` (kept for the session, ≤ 200), one save at a time.
// A `songs.get` update carrying one of our ids is our own save echoing (even
// before the mutation resolves); any other new `tempoRev` is foreign. Saves are
// suspended while Edit · Map auditions a chart (D20) or while a map session
// suspends them, and flushed by `flush()`. A `conflict` answer (our map was not
// real, theirs is) adopts their map as one undo step.
//
// Map changes outside Edit · Map are one practice-undo step (`mapChange`, D23);
// with Edit · Map mounted (`mapEditor`) they are one map-stack step.
import {signal, readonly, effect} from '../app/store.js';
import {now as clockNow} from '../app/clock.js';
import {account as appAccount} from '../app/account.js';
import * as profileModule from '../app/profile.js';
import {desktop as appDesktop} from '../app/desktop.js';
import {status as feedbackStatus} from '../app/feedback.js';
import {ApiError} from '../api/client.js';
import * as songsApi from '../api/songs.js';
import * as jobsApi from '../api/jobs.js';
import {signKeys} from '../api/media.js';
import {MultitrackEngine} from '../js/engine.js';
import {Metronome} from '../js/metronome.js';
import {SongMapStore} from '../js/song-map.js';
import {isDecodeError} from '../js/stemcache.js';
import {hasRealMap, songMapFromTempo, sectionsFromMarkers} from '../../shared/song-map.ts';
import {createTransport} from './transport.js';
import {createPositionModel} from './position.js';
import {createPracticeState} from './practice-state.js';
import {createPracticeUndo, undidMessage} from './undo.js';
import {createFrameBus} from './frame.js';
import {createPeaks} from './wave-render.js';
import {createNotationSession} from './notation-session.js';
import {createDetectFlow} from './detect.js';

export const TEMPO_DEBOUNCE_MS = 400;
export const TEMPO_RETRY_MS = 5000;
export const OWN_SAVE_IDS = 200;
export const MARKERS_OFFER_MS = 8000;
/** How long an open waits for the first account settings (boot does not await them, §2.3.1). */
export const ACCOUNT_WAIT_MS = 1500;
/** A loop "is" a spot when both edges agree within 1 ms (spot counters). */
export const SPOT_EPS = 0.001;
const MIN_LOOP = 0.02;

export const COPY = Object.freeze({
  notFound: 'This song isn’t here any more. It may have been deleted.',
  undo: 'Undo',
  keptMap: 'Kept the map from your other device',
  barsFound: 'Bars found',
  gridFound: 'Beat grid found',
  turnMarkers: (n) => (n === 1 ? 'Turn 1 marker into a section' : `Turn ${n} markers into sections`),
  turnAction: 'Turn into sections',
  turnLabel: 'Turn markers into sections',
  markersTurned: (n, skipped) => `Turned ${n === 1 ? '1 marker' : `${n} markers`} into sections${skipped ? ` · skipped ${skipped} on a bar that already had one` : ''}`,
  markersAlready: 'Those sections are already in the map.',
  loadFailed: 'Couldn’t load the audio for this song.',
  storageFailed: 'Couldn’t reach storage for this song’s audio.',
  missing: (names) => `Missing stem audio for: ${names.join(', ')}.`,
});

/** Default click settings when a song has no `practice.click` (D14: the account default applies). */
export function clickOf(click, accountPractice = {}) {
  const countIn = click?.countIn ?? accountPractice?.countIn ?? {};
  return {
    countIn: countIn.on === true,
    countInLength: Number.isFinite(countIn.length) ? countIn.length : 1,
    countInUnit: countIn.unit === 'beats' ? 'beats' : 'bars',
    mode: click?.mode ?? accountPractice?.click ?? 'countin',
    accent: click?.accent ?? true,
    volume: Number.isFinite(click?.volume) ? click.volume : 0.7,
    audiblePreRoll: click?.preRoll ?? false,
  };
}

const json = (value) => JSON.stringify(value ?? null);
const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const peekFlag = (value) => (value && typeof value === 'object' && 'value' in value
  ? (typeof value.peek === 'function' ? value.peek() : value.value) : !!value);
const readFlag = (value) => (value && typeof value === 'object' && 'value' in value ? value.value : !!value);
const warn = (what, err) => console.warn(`[session] ${what}`, err);

/** Resolves once `account.loaded` is true (at once when it is, or when there is no such flag), or after `ms`. */
function accountLoaded(account, ms) {
  const loaded = account?.loaded;
  if (!loaded || typeof loaded.peek !== 'function' || loaded.peek()) return Promise.resolve();
  return new Promise((resolve) => {
    let off = null;
    const done = () => { clearTimeout(timer); off?.(); resolve(); };
    const timer = setTimeout(done, ms);
    off = loaded.subscribe?.((value) => { if (value) done(); }) ?? null;
  });
}

/** A subscription whose first value resolves a promise; later values go to `later`. */
function firstOf(subscribe, args, later) {
  let settled = false, resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const off = subscribe(args, (value) => {
    if (!settled) { settled = true; resolve(value); } else later(value);
  }, (err) => {
    if (!settled) { settled = true; reject(err); } else warn('subscription failed', err);
  });
  return {promise, off};
}

function defaults() {
  return {
    songs: songsApi,
    jobs: jobsApi,
    media: {signKeys},
    account: appAccount,
    profile: profileModule,
    desktop: appDesktop,
    status: feedbackStatus,
    clock: {now: clockNow},
    createEngine: () => new MultitrackEngine(),
    createTransport,
    openPart: undefined,
    notationPersistence: null,
    detect: {},
    window: typeof window !== 'undefined' ? window : null,
    document: typeof document !== 'undefined' ? document : null,
  };
}

/**
 * Builds one session (uncached). `shared = {token, snapshot, resolveUrls, cacheNamespace}`
 * opens a read-only Shared Stage session (§2.18 step 9). Every other option replaces a
 * dependency (the test session passes in-memory APIs and fakes).
 */
export async function openSession(songId, {shared = null, ...overrides} = {}) {
  const deps = {...defaults(), ...overrides};
  const {songs, account, status, clock} = deps;
  const readOnly = !!shared;
  const id = shared?.snapshot?.id ?? songId;

  /* ---------- 1. the song and its practice ---------- */
  let onSongLater = () => {};
  let onPracticeLater = () => {};
  const offs = [];
  let songValue, practiceRaw;
  if (shared) {
    const {practice: snapshotPractice = null, ...snapshot} = shared.snapshot ?? {};
    songValue = snapshot;
    practiceRaw = snapshotPractice;
  } else {
    const songSub = firstOf(songs.subscribeSong, {id: songId}, (v) => onSongLater(v));
    offs.push(songSub.off);
    let practiceSub;
    // The account settings decide "Open with my part Out" and the practice defaults: a deep
    // link at boot can open before the first settings.config arrives, so wait for it briefly
    // (in parallel with the song; a missing song does not wait).
    const accountWait = accountLoaded(account, ACCOUNT_WAIT_MS);
    try {
      practiceSub = firstOf(songs.subscribePractice, {id: songId}, (v) => onPracticeLater(v));
      offs.push(practiceSub.off);
      [songValue, practiceRaw] = await Promise.all([songSub.promise, practiceSub.promise]);
    } catch (err) {
      for (const off of offs) off();
      throw err;
    }
    if (!songValue) {
      for (const off of offs) off();
      throw new ApiError({code: 'not_found', message: COPY.notFound});
    }
    await accountWait;
  }
  const song = signal(songValue);
  const serverPractice = signal(practiceRaw ?? null);
  const accountValue = () => account?.value?.peek?.() ?? {};
  const accountPractice = () => accountValue().practice ?? {};

  /* ---------- 2. the map ---------- */
  const map = SongMapStore.fromTempo(songValue.tempo, songValue.duration);
  // A song with drum notation counts as mapped from the first render (hasRealMap rule 2, B1
  // `hasChart`); the notation session keeps it in step with the part once that opens.
  map.setHasPart(!!songValue.hasChart);

  /* ---------- 3. the practice state ---------- */
  const practice = createPracticeState({
    songId: id, raw: practiceRaw, duration: songValue.duration, readOnly,
    persist: readOnly ? null : (p, {final}) => songs.savePractice({id, practice: p, final}),
    server: readOnly ? null : readonly(serverPractice),
    local: shared ? {token: shared.token} : null,
    clock, status: (text) => status(text), legacyTempo: songValue.tempo, defaults: accountPractice(),
  });

  // Open with "my part Out" (transport rule 18): only for a song with no saved practice; not an undo step.
  const stemNames = (songValue.stems ?? []).map((s) => s.name);
  const acct = accountValue();
  if (!readOnly && practiceRaw == null && acct.profile?.openWithMyPart === 'out') {
    const {names} = deps.profile.myStems(acct.profile, stemNames);
    if (names.length) {
      practice.patch({minusMe: true, tracks: stemNames.map((name) => ({name, volume: 1, muted: names.includes(name), soloed: false}))});
    }
  }

  /* ---------- 4. engine, metronome, position, undo, transport ---------- */
  const engine = deps.createEngine();
  const metronome = new Metronome(engine, map);
  const position = createPositionModel({map, practice});
  const notation = createNotationSession({
    session: {
      get id() { return id; }, readOnly, shareToken: shared?.token ?? null, song: readonly(song),
      engine, metronome, map, position,
    },
    openPart: deps.openPart, persistence: deps.notationPersistence,
    onRealChange: () => { if (!inMapChange && !replaying) noteReal(); },
  });
  const baseUndo = createPracticeUndo({clock});
  let topEntry = null;   // the entry on top of the stack when known (amend and status Undo target only that)
  let replaying = 0;     // an undo or redo is being applied: it restores state, it is not a new change
  const replay = (fn) => {
    replaying++;
    try { return fn(); } finally { replaying--; lastReal = map.isReal; }
  };
  const undo = Object.freeze({
    push(fields) { const e = baseUndo.push(fields); if (e) topEntry = e; return e; },
    pushAction(fields) { const e = baseUndo.pushAction(fields); if (e) topEntry = e; return e; },
    amend: (entry, fields) => baseUndo.amend(entry, fields),
    undo() { const e = replay(() => baseUndo.undo()); topEntry = null; return e; },
    redo() { const e = replay(() => baseUndo.redo()); if (e) topEntry = e; return e; },
    clear() { baseUndo.clear(); topEntry = null; },
    canUndo: baseUndo.canUndo, canRedo: baseUndo.canRedo,
    get size() { return baseUndo.size; },
  });
  // The live account settings: plain reads (`account.practice.stop`) and a signal-like face.
  const accountView = Object.freeze({
    get practice() { return accountPractice(); },
    get profile() { return accountValue().profile ?? {instruments: [], primary: null, openWithMyPart: 'in'}; },
    peek: () => accountValue(),
    subscribe: (fn) => account?.value?.subscribe?.(fn) ?? (() => {}),
  });
  const transport = deps.createTransport({engine, metronome, map, position, practice, undo, account: accountView, profile: deps.profile,
    status, stems: stemNames, notation});

  const load = signal({phase: 'song', loadedBytes: 0, totalBytes: 0, decoded: 0, tracks: stemNames.length, error: null});
  const mapEditor = signal(null);
  const listeners = new Map();
  const emit = (event, payload) => {
    for (const fn of [...(listeners.get(event) ?? [])]) {
      try { fn(payload); } catch (err) { warn(`${event} listener failed`, err); }
    }
  };

  let disposed = false;
  let peaks = createPeaks([]);

  /* ---------- tempo persistence (D53) ---------- */
  let baseRev = songValue.tempoRev ?? 0;
  let baseline = json(map.serialize());   // the map as the server has it (in this session's normalisation)
  const ownSaveIds = [];
  const sentById = new Map();
  let tempoTimer = null;
  let retryTimer = null;
  let tempoRunning = null;
  let tempoQueued = false;
  let savesSuspended = false;

  const auditioning = () => peekFlag(mapEditor.peek()?.auditioning);
  const suspended = () => savesSuspended || auditioning();
  const tempoDirty = () => !readOnly && json(map.serialize()) !== baseline;
  const remember = (saveId, sent) => {
    ownSaveIds.push(saveId);
    sentById.set(saveId, sent);
    while (ownSaveIds.length > OWN_SAVE_IDS) sentById.delete(ownSaveIds.shift());
  };

  function scheduleTempoSave() {
    if (readOnly || disposed) return;
    clearTimeout(tempoTimer);
    tempoTimer = setTimeout(() => { tempoTimer = null; void saveTempo(); }, TEMPO_DEBOUNCE_MS);
  }

  function saveTempo(isRetry = false) {
    if (readOnly || suspended()) return tempoRunning ?? Promise.resolve();
    if (!tempoDirty()) {
      // Nothing of ours to send (e.g. an edit undone inside the debounce): catch up with a foreign change instead.
      if (!tempoRunning) reconcile();
      return tempoRunning ?? Promise.resolve();
    }
    if (tempoRunning) { tempoQueued = true; return tempoRunning; }
    if (!isRetry) { clearTimeout(retryTimer); retryTimer = null; }
    const tempo = metronome.serialize();
    const sent = json(tempo.songMap);
    const saveId = globalThis.crypto.randomUUID();
    remember(saveId, sent);
    tempoRunning = (async () => {
      try {
        const result = await songs.saveTempo({id, tempo, baseRev, saveId});
        if (result?.conflict) {
          // Their map is real and ours is not. During a Find a chart audition the map cannot change:
          // keep baseRev and baseline, so the save after the audition meets the conflict again.
          if (!auditioning() && !disposed) {
            if (Number.isFinite(result.tempoRev)) baseRev = result.tempoRev;
            adoptConflict(result.tempo);
          }
        } else {
          if (Number.isFinite(result?.tempoRev)) baseRev = result.tempoRev;
          baseline = sent;
        }
      } catch (err) {
        warn(`Tempo save failed for ${id}; keeping the map on this device.`, err);
        if (!isRetry && !disposed) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => { retryTimer = null; void saveTempo(true); }, TEMPO_RETRY_MS);
        }
      }
    })().finally(() => {
      tempoRunning = null;
      if (tempoQueued) { tempoQueued = false; void saveTempo(); }
      // A foreign change that arrived while this save was in flight was held back: look again.
      else reconcile();
    });
    return tempoRunning;
  }

  async function flushTempo() {
    clearTimeout(tempoTimer);
    tempoTimer = null;
    if (tempoRunning) await tempoRunning;
    await saveTempo();
    if (tempoRunning) await tempoRunning;
  }

  /** Their map is real and ours was not: keep theirs, as one undo step (D53 conflict). */
  function adoptConflict(stored) {
    const data = stored?.songMap ? stored.songMap : songMapFromTempo(stored, map.duration);
    mapChange(COPY.keptMap, (m) => m.adopt(data), {status: {text: COPY.keptMap, undoLabel: COPY.undo}});
    baseline = json(map.serialize());
    emit('tempo-adopted', {conflict: true});
  }

  /* ---------- external tempo changes (D53) ---------- */
  function onSongUpdate(next) {
    if (disposed) return;
    if (!next) { emit('error', {kind: 'missing', message: COPY.notFound}); return; }
    song.value = next;
    reconcile();
  }

  /**
   * Catch up with the latest `songs.get` value. Our own save echoing (possibly before the
   * mutation resolved) only moves baseRev. A foreign tempo waits while local edits are
   * pending or a save is in flight (pending local edits win; the next save resolves through
   * baseRev) and while Edit · Map auditions a chart; every one of those gates calls this
   * again when it clears, so a held-back change is never lost.
   */
  let reconciling = false;
  function reconcile() {
    if (readOnly || disposed || reconciling) return;
    const next = song.peek();
    const rev = next?.tempoRev ?? 0;
    if (!next || rev <= baseRev) return;
    if (next.tempoSaveId && sentById.has(next.tempoSaveId)) { baseRev = rev; return; }
    if (tempoDirty() || tempoRunning || auditioning()) return;
    reconciling = true;
    try {
      const data = songMapFromTempo(next.tempo, map.duration);
      const theirsReal = !!data.origin || hasRealMap(next.tempo);
      if (theirsReal && !map.isReal) {
        const own = detect.claimServerResult();
        const text = own ? COPY.gridFound : COPY.barsFound;
        mapChange(text, (m) => m.adopt(data), {status: {text, undoLabel: COPY.undo}});
      } else {
        map.withoutUndo(() => map.adopt(data));
      }
      baseRev = rev;
      baseline = json(map.serialize());
    } finally {
      reconciling = false;
    }
    emit('tempo-adopted', {conflict: false});
  }

  /* ---------- map changes (D23) and the markers offer ---------- */
  let inMapChange = 0;
  let lastReal = map.isReal;   // a song mapped by its chart is mapped from the start: no markers offer on open
  const liveMarkers = () => practice.value.peek().markers.filter((m) => !m.deleted);

  function undoEntry(entry) {
    if (!entry || topEntry !== entry) return false;
    const done = undo.undo();
    if (done) status(undidMessage(done), {key: 'undo'});
    return !!done;
  }

  function showStatus(text, {undoLabel, entry, mapStack} = {}) {
    if (!text) return;
    const label = undoLabel ?? null;
    const action = !label ? undefined
      : mapStack ? {label, run: () => mapEditor.peek()?.undo?.()}
        : entry ? {label, run: () => undoEntry(entry)} : undefined;
    status(text, action ? {action} : {});
  }

  /** The song just became mapped: offer to turn live markers into sections (§2.14.1). */
  function noteReal(entry = null, after = null) {
    const real = map.isReal;
    if (real === lastReal) return;
    lastReal = real;
    if (!real) return;
    emit('map-real', {entry});
    const markers = liveMarkers();
    // Edit · Map shows its own markers banner (ED3); the Stage gets the status-line offer.
    if (!markers.length || readOnly || mapEditor.peek()) return;
    status(COPY.turnMarkers(markers.length), {
      action: {label: COPY.turnAction, run: () => convertMarkers(entry, after)},
      durationMs: MARKERS_OFFER_MS, key: 'markers-offer',
    });
  }

  /** Markers → sections; amends the not-real → real entry when it is still the latest change. */
  function convertMarkers(entry, after) {
    if (disposed || !map.isReal) return null;
    const editor = mapEditor.peek();
    if (editor?.markersToSections) return editor.markersToSections();
    const markers = liveMarkers();
    const {change, converted, skipped} = sectionsFromMarkers(map.data, markers, map.duration);
    if (!converted.length) { status(COPY.markersAlready, {key: 'markers-offer'}); return null; }
    const amendable = !!entry && topEntry === entry && !!after && json(map.snapshot()) === json(after);
    const mapBefore = map.snapshot();
    const markersBefore = copy(practice.value.peek().markers);
    map.withoutUndo(() => map.edit(change, 'sections'));
    const ids = new Set(converted);
    practice.patch((p) => { p.markers = p.markers.filter((m) => !ids.has(m.id)); });
    const mapAfter = map.snapshot();
    const markersAfter = copy(practice.value.peek().markers);
    const undoIt = () => { practice.patch({markers: markersBefore}); map.restore(mapBefore); };
    const redoIt = () => { map.restore(mapAfter); practice.patch({markers: markersAfter}); };
    let target = entry;
    if (amendable) undo.amend(entry, {undo: undoIt, redo: redoIt});
    else target = undo.pushAction({key: 'markers', label: COPY.turnLabel, undo: undoIt, redo: redoIt});
    practice.reanchor(map, {auditioning: auditioning()});
    showStatus(COPY.markersTurned(converted.length, skipped.length), {undoLabel: COPY.undo, entry: target});
    return {converted, skipped};
  }

  /**
   * Run `fn(map)` as one undoable change (D23). Returns {entry} (entry null on the map
   * stack), or null when nothing changed. `status.text` may be a function, read after `fn`.
   */
  function mapChange(label, fn, {status: statusSpec = null} = {}) {
    if (readOnly || disposed || auditioning()) return null;
    const editor = mapEditor.peek();
    const wasReal = map.isReal;
    let result;
    inMapChange++;
    try {
      if (editor) {
        const own = !map.batch;
        let changed = false;
        if (own) map.beginBatch();
        const before = own ? null : map.snapshot();
        try { fn(map); } finally { changed = own ? map.endBatch() : json(before) !== json(map.snapshot()); }
        result = changed ? {entry: null} : null;
      } else {
        const before = map.snapshot();
        map.withoutUndo(() => fn(map));
        const after = map.snapshot();
        if (json(before) === json(after)) result = null;
        else {
          const entry = undo.pushAction({key: 'map', label, undo: () => map.restore(before), redo: () => map.restore(after)});
          result = {entry, after};
        }
      }
    } finally {
      inMapChange--;
    }
    if (!result) return null;
    practice.reanchor(map, {auditioning: auditioning()});
    const text = typeof statusSpec?.text === 'function' ? statusSpec.text() : statusSpec?.text;
    showStatus(text, {undoLabel: statusSpec?.undoLabel, entry: result.entry, mapStack: !!editor});
    if (!wasReal && map.isReal) noteReal(result.entry, result.after);
    else lastReal = map.isReal;
    return {entry: result.entry};
  }

  offs.push(map.subscribe((reason) => {
    if (disposed || reason === 'load') return;
    if (!tempoDirty()) { clearTimeout(tempoTimer); tempoTimer = null; }
    else scheduleTempoSave();
    if (!inMapChange) {
      practice.reanchor(map, {auditioning: auditioning()});
      if (!replaying) noteReal();
    }
    // Clean again (an edit undone, Keep my map): a foreign change held back meanwhile is adopted now.
    if (!tempoDirty() && !inMapChange) reconcile();
  }));

  /* ---------- notation and detection ---------- */
  const flowView = {
    get id() { return id; }, readOnly, song: readonly(song), map, position, mapEditor,
    mapChange: (...args) => mapChange(...args),
  };
  const detect = createDetectFlow({session: flowView, jobs: deps.jobs, songs, status, desktop: deps.desktop, clock, ...deps.detect});

  /* ---------- spot counters ---------- */
  const spotOf = (spotId) => practice.value.peek().spots.find((s) => s.id === spotId && !s.deleted) ?? null;
  const matches = (loop, spot) => !!spot && loop.on && Math.abs(loop.a - spot.a) <= SPOT_EPS && Math.abs(loop.b - spot.b) <= SPOT_EPS;
  const offPass = transport?.on?.('pass', () => {
    const spotId = practice.activeSpotId.peek();
    if (!spotId) return;
    if (matches(practice.value.peek().loop, spotOf(spotId))) practice.touchSpot(spotId, {passes: 1});
  });
  if (offPass) offs.push(offPass);
  const loopKey = (p) => json({on: p.loop.on, a: p.loop.a, b: p.loop.b});
  let lastLoop = loopKey(practice.value.peek());
  let lastChartAudio = practice.value.peek().chartAudio ?? 'off';
  offs.push(practice.value.subscribe((p) => {
    const key = loopKey(p);
    if (key !== lastLoop) {
      lastLoop = key;
      const spotId = practice.activeSpotId.peek();
      if (spotId && !matches(p.loop, spotOf(spotId))) practice.activeSpotId.value = null;
    }
    const level = p.chartAudio ?? 'off';
    if (level !== lastChartAudio) { lastChartAudio = level; notation.setChartAudio(level); }
  }));
  if (lastChartAudio !== 'off') notation.setChartAudio(lastChartAudio);

  /* ---------- audition: suspend saves and map sync (D20) ---------- */
  let wasAuditioning = false;
  offs.push(effect(() => {
    const on = readFlag(mapEditor.value?.auditioning);
    if (on === wasAuditioning) return;
    wasAuditioning = on;
    notation.setMapSyncPaused(on || savesSuspended);
    if (on) return;
    if (tempoDirty()) scheduleTempoSave();
    else reconcile();
  }));

  /* ---------- flush ---------- */
  async function flush({final = false} = {}) {
    const results = await Promise.allSettled([practice.flush({final}), flushTempo(), notation.flush()]);
    for (const r of results) if (r.status === 'rejected') warn('flush step failed', r.reason);
  }

  const win = deps.window, doc = deps.document;
  const onPageHide = () => { void flush({final: true}); };
  const onVisibility = () => { if (doc?.visibilityState === 'hidden' || doc?.hidden === true) void flush({final: true}); };
  win?.addEventListener?.('pagehide', onPageHide);
  doc?.addEventListener?.('visibilitychange', onVisibility);
  const offDesktopFlush = deps.desktop?.onFlushRequest?.(() => flush({final: true}));

  /* ---------- 6–8. audio ---------- */
  let loadRun = 0;
  const setLoad = (patch) => { load.value = {...load.peek(), ...patch}; };
  function fail(kind, err, extra = {}) {
    const message = extra.message ?? (err instanceof Error ? err.message : String(err ?? ''));
    setLoad({phase: 'error', error: {kind, message, ...(extra.missing ? {missing: extra.missing} : {})}});
    emit('error', {kind, message, error: err});
  }

  function applyPractice() {
    const p = practice.value.peek();
    const ap = accountPractice();
    engine.setPreservePitch(p.keepPitch ?? ap.keepPitch ?? true);
    engine.setSpeed(p.rate);
    for (const t of p.tracks) {
      if (!engine.tracks.some((x) => x.name === t.name)) continue;
      engine.setVolume(t.name, t.volume);
      engine.setMuted(t.name, t.muted);
      engine.setSoloed(t.name, t.soloed);
    }
    if (p.loop.b - p.loop.a >= MIN_LOOP) engine.setLoop(!!p.loop.on, p.loop.a, p.loop.b);
    if (!engine.playing) engine.seek(p.cue, {cue: true});
    metronome.configure(clickOf(p.click, ap));
  }

  async function loadAudio() {
    const run = ++loadRun;
    const current = song.peek();
    const stems = current.stems ?? [];
    setLoad({phase: 'signing', error: null, loadedBytes: 0, totalBytes: 0, decoded: 0, tracks: stems.length});
    let urls;
    try {
      // §2.18: `resolveUrls` is `sharing.playback`, called as ({token}).
      urls = shared?.resolveUrls ? await shared.resolveUrls({token: shared.token}) : await deps.media.signKeys(stems.map((s) => s.key));
    } catch (err) {
      if (run === loadRun && !disposed) fail('storage', err);
      return;
    }
    if (run !== loadRun || disposed) return;
    const namespace = shared?.cacheNamespace ?? '';
    const list = stems.map((s) => ({name: s.name, key: namespace + s.key, url: urls?.[s.key] ?? null, color: null}));
    const missing = list.filter((s) => !s.url).map((s) => s.name);
    if (!list.length || missing.length) { fail('missing', null, {message: COPY.missing(missing), missing}); return; }
    setLoad({phase: 'loading'});
    try {
      await engine.loadStems(list, (done, total, bytes) => {
        if (run !== loadRun || disposed) return;
        const phase = done >= total ? 'preparing' : bytes?.total && bytes.loaded < bytes.total ? 'loading' : 'decoding';
        setLoad({phase, decoded: done, tracks: total, loadedBytes: bytes?.loaded ?? 0, totalBytes: bytes?.total ?? 0});
      });
    } catch (err) {
      if (run === loadRun && !disposed) fail(isDecodeError(err) ? 'codec' : 'unknown', err);
      return;
    }
    if (run !== loadRun || disposed) return;
    // Silent: no edit event, no undo step, no save; the next real save writes it (§4.2).
    const clean = !tempoDirty();
    map.setDuration(engine.duration);
    if (clean) baseline = json(map.serialize());
    peaks = createPeaks(engine.tracks);
    try { applyPractice(); } catch (err) { warn('applying the practice state failed', err); }
    // The transport applies its own state from here on and starts an armed Play (ST1a `ready()`).
    try { await transport?.ready?.(); } catch (err) { warn('the transport could not start', err); }
    if (run !== loadRun || disposed) return;
    setLoad({phase: 'ready', error: null});
    emit('loaded', {duration: engine.duration});
    void detect.resume();
  }

  /* ---------- the session ---------- */
  const session = {
    id, readOnly, shareToken: shared?.token ?? null,
    song: readonly(song),
    engine, metronome, map, transport, position, practice, undo, notation,
    get peaks() { return peaks; },
    frame: null,
    detect,
    load: readonly(load),
    mapEditor,
    mapChange,
    /** Markers → sections now (the marker menu's "Turn into section" and the offer's action). */
    markersToSections: () => convertMarkers(null, null),
    /** Map sessions hold tempo saves (Find a chart, D20); resuming with `changed` saves at once. */
    suspendSaves(on, {changed = false} = {}) {
      savesSuspended = !!on;
      notation.setMapSyncPaused(savesSuspended || auditioning());
      if (!savesSuspended && changed) void flushTempo();
      else if (!savesSuspended && tempoDirty()) scheduleTempoSave();
      else if (!savesSuspended) reconcile();
    },
    retry() {
      if (disposed || load.peek().phase !== 'error') return Promise.resolve();
      return loadAudio();
    },
    flush,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    get disposed() { return disposed; },
    /** True while a practice or tempo change has not been saved (the desktop quit guard). */
    get pending() { return practice.pending || tempoDirty() || !!tempoRunning; },
    async dispose() {
      if (disposed) return;
      await flush({final: true});
      disposed = true;
      loadRun++;
      clearTimeout(tempoTimer);
      clearTimeout(retryTimer);
      for (const off of offs) { try { off?.(); } catch (err) { warn('cleanup failed', err); } }
      win?.removeEventListener?.('pagehide', onPageHide);
      doc?.removeEventListener?.('visibilitychange', onVisibility);
      offDesktopFlush?.();
      mapEditor.value = null;
      detect.destroy();
      session.frame?.destroy();
      practice.dispose();
      position.dispose();
      try { transport?.destroy?.(); } catch (err) { warn('transport destroy failed', err); }
      engine.destroy();
      metronome.destroy();
      notation.destroy();
      listeners.clear();
    },
  };
  session.frame = createFrameBus({session});

  if (!readOnly) {
    onSongLater = onSongUpdate;
    onPracticeLater = (value) => { if (!disposed) serverPractice.value = value ?? null; };
  }

  /* ---------- 5. the drum part; 6–8. the audio (in the background) ---------- */
  void notation.start();
  void loadAudio();
  return session;
}

/* ---------- the cache ---------- */
const sessions = new Map();   // songId → {promise, session}
let active = null;

export function getSession(songId, {shared = null} = {}) {
  const key = String(songId);
  const hit = sessions.get(key);
  if (hit) return hit.promise;
  const record = {promise: null, session: null};
  record.promise = openSession(songId, {shared}).then((s) => {
    record.session = s;
    if (sessions.get(key) === record) active = s;
    return s;
  }, (err) => {
    if (sessions.get(key) === record) sessions.delete(key);
    throw err;
  });
  sessions.set(key, record);
  return record.promise;
}

export async function disposeSession(songId) {
  const key = String(songId);
  const record = sessions.get(key);
  if (!record) return;
  sessions.delete(key);
  let session;
  try { session = await record.promise; } catch { return; }
  if (active === session) active = null;
  await session.dispose();
}

export function activeSession() {
  return active && !active.disposed ? active : null;
}
