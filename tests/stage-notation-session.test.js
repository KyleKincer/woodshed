// @vitest-environment node
// The session's drum part (architecture §2.14.2): lazy opening, legacy adoption,
// hasNotation and the map, chart audio levels, Listen mode, map-sync pause, and
// notation/audio.js on the engine's aux bus with plan-aware cancelling (§5.0).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => (await import('./helpers/fake-audio.js')).fakeStemcache);
vi.mock('../src/js/notation/store.js', () => ({NotationStore: vi.fn(), loadSharedNotation: vi.fn(async () => null), watchSharedNotation: () => () => {}}));

import {createNotationSession, needsPartAtOpen, CHART_AUDIO, COPY} from '../src/stage/notation-session.js';
import {DrumAudio, LEVELS} from '../src/js/notation/audio.js';
import {openPart} from '../src/js/notation/part.js';
import {MultitrackEngine} from '../src/js/engine.js';
import {Metronome} from '../src/js/metronome.js';
import {SongMapStore} from '../src/js/song-map.js';
import {createPositionModel} from '../src/stage/position.js';
import {signal, readonly} from '../src/app/store.js';
import {emptyScore, fraction, kitPiece} from '../shared/notation.ts';
import {FAKE_TIMERS, installFakeAudio, createClock, loadFakeStems} from './helpers/fake-audio.js';
import {sectioned, unmapped, legacyTempoMap, tempoOf} from './fixtures/maps.js';

let restoreAudio, clock;
beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  restoreAudio = installFakeAudio();
  clock = createClock();
});
afterEach(() => {
  vi.useRealTimers();
  restoreAudio();
});

const hit = (beats, instrument = 'closedHat', extra = {}) => ({id: `${instrument}@${beats}`, offset: fraction(Math.round(beats * 96), 96), instrument,
  voice: kitPiece(instrument).voice, accent: false, ghost: false, flam: false, sticking: '', velocity: 0.75, ...extra});

function partStore(score) {
  return {load: vi.fn(async () => (score ? structuredClone(score) : null)), set: vi.fn(), flush: vi.fn(async () => {}), destroy: vi.fn(), reload: vi.fn(), blocked: false};
}

/** The slice of a Session the notation session reads, over real models. */
function sessionOver({tempo = tempoOf(sectioned), duration = 128, hasChart = false, readOnly = false} = {}) {
  const engine = new MultitrackEngine();
  const map = SongMapStore.fromTempo(tempo, duration);
  const metronome = new Metronome(engine, map);
  const practice = {value: readonly(signal({markers: []}))};
  const position = createPositionModel({map, practice});
  const song = signal({id: 'song-1', title: 'Glasshouse', duration, tempo, hasChart});
  return {id: 'song-1', readOnly, shareToken: readOnly ? 'tok' : null, song: readonly(song), engine, metronome, map, position};
}

describe('opening the part', () => {
  test('needsPartAtOpen: a chart, or a stored tempo with no songMap (legacy adoption)', () => {
    expect(needsPartAtOpen({hasChart: true, tempo: tempoOf(sectioned)})).toBe(true);
    expect(needsPartAtOpen({hasChart: false, tempo: tempoOf(legacyTempoMap)})).toBe(true);
    expect(needsPartAtOpen({hasChart: false, tempo: tempoOf(sectioned)})).toBe(false);
    // A never-mapped song stores no tempo (songs.get → null): nothing to adopt, no part fetched.
    expect(needsPartAtOpen({hasChart: false, tempo: undefined})).toBe(false);
    expect(needsPartAtOpen({hasChart: false, tempo: null})).toBe(false);
    // Read-only (shared) sessions never adopt: only a chart opens the part.
    expect(needsPartAtOpen({hasChart: false, tempo: tempoOf(legacyTempoMap)}, {readOnly: true})).toBe(false);
    expect(needsPartAtOpen({hasChart: true, tempo: undefined}, {readOnly: true})).toBe(true);
  });

  test('a never-mapped song with no chart fetches no part at open', async () => {
    const fakeOpen = vi.fn();
    const notation = createNotationSession({session: sessionOver({tempo: null, duration: 30}), openPart: fakeOpen});
    await notation.start();
    await notation.ready;
    expect(fakeOpen).not.toHaveBeenCalled();
    expect(notation.part).toBeNull();
    notation.destroy();
  });

  test('a shared session never adopts the chart timeline into the map (includeMap off: no tempo)', async () => {
    const calls = [];
    const fakeOpen = vi.fn(async (options) => { calls.push(options); return {hasNotation: true, score: null, subscribe: () => () => {}, destroy: vi.fn(), flush: vi.fn()}; });
    const visitor = createNotationSession({session: sessionOver({tempo: undefined, duration: 30, hasChart: true, readOnly: true}), openPart: fakeOpen});
    await visitor.start();
    const legacyVisitor = createNotationSession({session: sessionOver({tempo: tempoOf(legacyTempoMap), duration: 30, hasChart: true, readOnly: true}), openPart: fakeOpen});
    await legacyVisitor.start();
    expect(calls.map((c) => [c.readOnly, c.adoptLegacy])).toEqual([[true, false], [true, false]]);
  });

  test('part.js: a read-only part never adopts its timeline, even when asked', async () => {
    const store = await import('../src/js/notation/store.js');
    const score = emptyScore(30, 90, 3, 4);
    store.loadSharedNotation.mockResolvedValueOnce({score});
    const session = sessionOver({tempo: tempoOf(legacyTempoMap), duration: 30, hasChart: true, readOnly: true});
    const before = session.map.snapshot();
    const part = await openPart({song: session.song.peek(), engine: session.engine, metronome: session.metronome, songMap: session.map,
      readOnly: true, shareToken: 'tok', adoptLegacy: true});
    expect(session.map.snapshot()).toEqual(before);
    part.destroy();
  });

  test('hasNotation starts from song.hasChart and follows the part once it opens', async () => {
    const session = sessionOver({hasChart: true});
    const notation = createNotationSession({session, openPart, persistence: partStore(null)});
    expect(notation.hasNotation.peek()).toBe(true);
    await notation.start();
    expect(notation.hasNotation.peek()).toBe(false);   // the stored part turned out empty
    notation.destroy();
  });

  test('start() on a mapped song with no chart opens nothing; ready resolves with part null; open() opens on demand', async () => {
    const session = sessionOver();
    const persistence = partStore(null);
    const notation = createNotationSession({session, openPart, persistence});
    await notation.start();
    await notation.ready;
    expect(notation.part).toBeNull();
    expect(persistence.load).not.toHaveBeenCalled();
    await notation.open();
    expect(notation.part).not.toBeNull();
    expect(notation.hasNotation.peek()).toBe(false);
    notation.destroy();
  });

  test('the part is opened with adoptLegacy only when the stored tempo has no songMap', async () => {
    const calls = [];
    const fakeOpen = vi.fn(async (options) => { calls.push(options); return {hasNotation: false, score: null, subscribe: () => () => {}, destroy: vi.fn(), flush: vi.fn()}; });
    const legacy = createNotationSession({session: sessionOver({tempo: tempoOf(legacyTempoMap)}), openPart: fakeOpen});
    await legacy.start();
    const mapped = createNotationSession({session: sessionOver({hasChart: true}), openPart: fakeOpen});
    await mapped.start();
    expect(calls.map((c) => c.adoptLegacy)).toEqual([true, false]);
    expect(calls[1]).toMatchObject({readOnly: false, shareToken: null});
  });

  test('a failed open is reported on `error`, settles ready, and can be retried', async () => {
    let fail = true;
    const flaky = vi.fn(async () => { if (fail) throw new Error('offline'); return {hasNotation: true, score: null, subscribe: () => () => {}, destroy: vi.fn(), flush: vi.fn()}; });
    const notation = createNotationSession({session: sessionOver({hasChart: true}), openPart: flaky});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await notation.start();
    await notation.ready;
    expect(notation.error.peek().message).toBe('offline');
    fail = false;
    await notation.open();
    expect(notation.error.peek()).toBeNull();
    expect(notation.hasNotation.peek()).toBe(true);
    warn.mockRestore();
  });

  test('hasNotation follows the part and makes the map real; the position model is refreshed (setHasPart emits nothing)', async () => {
    // An unmapped song with no chart yet: Edit · Chart opens an empty part; the first note maps the song.
    const session = sessionOver({tempo: tempoOf(unmapped), duration: 30, hasChart: false});
    const onRealChange = vi.fn();
    const notation = createNotationSession({session, openPart, persistence: partStore(null), onRealChange});
    await notation.open();
    expect(notation.hasNotation.peek()).toBe(false);
    expect(session.position.mapped.peek()).toBe(false);
    // Writing the first note turns the song into a mapped one.
    const editor = notation.part.editor;
    editor.transact((draft) => { draft.bars.push({measureId: draft.timeline.measures[0].id, coverage: 'progress', hits: [hit(0, 'kick')]}); });
    notation.part.commit('edit');
    expect(notation.hasNotation.peek()).toBe(true);
    expect(session.map.isReal).toBe(true);
    expect(session.position.mapped.peek()).toBe(true);
    expect(onRealChange).toHaveBeenCalledOnce();
    notation.destroy();
  });

  test('importScore adopts a draft into the empty part and counts its hits', async () => {
    const session = sessionOver({hasChart: false});
    const notation = createNotationSession({session, openPart, persistence: partStore(null)});
    const draft = emptyScore(128, 120);
    draft.timeline = structuredClone(session.map.timeline());
    draft.bars = [{measureId: draft.timeline.measures[0].id, coverage: 'progress', hits: [hit(0, 'kick'), hit(1, 'snare'), hit(2, 'kick')]}];
    const result = await notation.importScore(draft, {skipped: 2});
    expect(result).toEqual({count: 3, skipped: 2, notice: COPY.imported});
    expect(notation.hasNotation.peek()).toBe(true);
    notation.destroy();
  });
});

describe('map sync pause (Find a chart audition, D20)', () => {
  test('while paused map edits retime the score in memory without saving; unpausing saves once only if the timeline changed', async () => {
    const session = sessionOver({hasChart: true});
    const persistence = partStore(null);
    const notation = createNotationSession({session, openPart, persistence});
    await notation.start();
    const heard = vi.fn();
    notation.part.subscribe(heard);
    notation.setMapSyncPaused(true);
    expect(notation.part.mapSyncPaused).toBe(true);
    session.map.beginBatch();
    session.map.edit((d) => { d.tailQpm = 100; }, 'tempo');
    expect(heard).toHaveBeenCalledWith('map');
    expect(notation.part.score.timeline).toEqual(session.map.timeline());
    expect(persistence.set).not.toHaveBeenCalled();
    // Keep my map: the timeline is back where it was → nothing to save.
    session.map.abortBatch();
    notation.setMapSyncPaused(false);
    expect(persistence.set).not.toHaveBeenCalled();
    // Use their map: one save on unpause.
    notation.setMapSyncPaused(true);
    session.map.edit((d) => { d.tailQpm = 90; }, 'tempo');
    session.map.edit((d) => { d.tailQpm = 96; }, 'tempo');
    expect(persistence.set).not.toHaveBeenCalled();
    notation.setMapSyncPaused(false);
    expect(persistence.set).toHaveBeenCalledOnce();
    expect(persistence.set.mock.calls[0][0].timeline).toEqual(session.map.timeline());
    // Not paused: each map edit saves the part as before.
    session.map.edit((d) => { d.tailQpm = 98; }, 'tempo');
    expect(persistence.set).toHaveBeenCalledTimes(2);
    notation.destroy();
  });

  test('a pause set before the part opens applies once it opens', async () => {
    const session = sessionOver({hasChart: true});
    const notation = createNotationSession({session, openPart, persistence: partStore(null)});
    notation.setMapSyncPaused(true);
    await notation.start();
    expect(notation.part.mapSyncPaused).toBe(true);
    notation.destroy();
  });
});

describe('chart audio and Listen (D27)', () => {
  test('off → recording; quiet → both at .35; loud → both at .65', async () => {
    const session = sessionOver({hasChart: true});
    const notation = createNotationSession({session, openPart, persistence: partStore(null)});
    expect(CHART_AUDIO).toEqual({off: {mode: 'recording', gain: LEVELS.loud}, quiet: {mode: 'both', gain: 0.35}, loud: {mode: 'both', gain: 0.65}});
    notation.setChartAudio('off');
    expect(notation.listenMode).toBe('recording');
    notation.setChartAudio('quiet');
    const audio = notation.drumAudio;
    expect(audio).toBeInstanceOf(DrumAudio);
    expect(audio.mode).toBe('both');
    expect(audio.level).toBeCloseTo(0.35);
    notation.setChartAudio('loud');
    expect(audio.mode).toBe('both');
    expect(audio.level).toBeCloseTo(0.65);
    notation.setChartAudio('off');
    expect(audio.mode).toBe('recording');
    expect(session.engine.recordingAudible).toBe(true);
    expect(notation.drumAudio).toBe(audio);   // one per session
    notation.destroy();
  });

  test('Listen mode lives on the session DrumAudio: it survives posture changes and leaves chartAudio alone', async () => {
    const session = sessionOver({hasChart: true});
    const notation = createNotationSession({session, openPart, persistence: partStore(null)});
    await notation.start();
    notation.setChartAudio('quiet');
    notation.setListenMode('notation');
    expect(notation.chartAudio).toBe('quiet');
    expect(notation.drumAudio.mode).toBe('notation');
    expect(session.engine.recordingAudible).toBe(false);
    // Edit · Chart unmounts and the Stage mounts: nothing resets the shared player.
    const sameAudio = notation.drumAudio;
    expect(sameAudio.mode).toBe('notation');
    expect(notation.listenMode).toBe('notation');
    expect(() => notation.setListenMode('loud')).toThrow(TypeError);
    notation.destroy();
  });

  test('the score follows the part into the DrumAudio', async () => {
    const session = sessionOver({hasChart: true});
    const score = structuredClone(emptyScore(128, 120));
    score.timeline = structuredClone(session.map.timeline());
    score.bars = [{measureId: score.timeline.measures[0].id, coverage: 'progress', hits: [hit(0, 'kick'), hit(1, 'snare')]}];
    const notation = createNotationSession({session, openPart, persistence: partStore(score)});
    await notation.start();
    expect(notation.drumAudio.events.map((e) => e.instrument)).toEqual(['kick', 'snare']);
    notation.destroy();
  });
});

describe('notation/audio.js on the engine (§5.0)', () => {
  async function playing(score) {
    const engine = new MultitrackEngine();
    await loadFakeStems(engine, ['drums', 'bass'], {duration: 20});
    const audio = new DrumAudio(engine);
    audio.setScore(score);
    audio.setMode('both');
    await engine.play();
    return {engine, audio};
  }
  const denseScore = () => {
    const score = emptyScore(20, 120);
    // 32nd-note hats: 0.0625 s apart at 120 bpm.
    score.bars = [{measureId: score.timeline.measures[0].id, coverage: 'progress', hits: Array.from({length: 32}, (_, i) => hit(i / 8))}];
    return score;
  };

  test('hits sound through engine.aux, not the destination', async () => {
    const {engine, audio} = await playing(denseScore());
    expect(audio.out.connectedTo(engine.aux)).toBe(true);
    expect(audio.out.connectedTo(engine.ctx.destination)).toBe(false);
    audio.destroy();
    engine.destroy();
  });

  test('a plan change cancels only the hits at or after `from` and reschedules them on the new plan', async () => {
    const {engine, audio} = await playing(denseScore());
    clock.advance(0.05);
    const before = [...audio.active].map((e) => ({e, when: e.when}));
    // Cut just before the first scheduled hat beyond the engine's lookahead.
    const first = before.map((b) => b.when).sort((x, y) => x - y).find((w) => w > engine.ctx.currentTime + engine.lookahead + 0.002);
    const at = first - 0.001;
    expect(before.some(({when}) => when >= at)).toBe(true);
    expect(before.some(({when}) => when < at)).toBe(true);
    engine.setSpeed(0.5, {at});
    for (const {e, when} of before) {
      if (when >= at) expect(e.source.stopTime).not.toBeNull();
      else expect(e.source.stopTime).toBeNull();
    }
    expect(audio.until).toBeLessThanOrEqual(at);
    clock.advance(0.05);
    // The next hat after the cut lands on the half-speed plan.
    const position = engine.getPositionAt(at);
    const next = Math.ceil(position / 0.0625 - 1e-9) * 0.0625;
    const expected = at + (next - position) / 0.5;
    expect([...audio.active].some((e) => Math.abs(e.when - expected) < 1e-6)).toBe(true);
    audio.destroy();
    engine.destroy();
  });

  test('a discontinuity still cancels every hit', async () => {
    const {engine, audio} = await playing(denseScore());
    clock.advance(0.05);
    const scheduled = [...audio.active];
    expect(scheduled.length).toBeGreaterThan(0);
    engine.seek(10, {cue: false});
    expect(scheduled.every((e) => e.source.stopTime !== null)).toBe(true);
    audio.destroy();
    engine.destroy();
  });

  test('setLevel clamps; setScore(null) clears; destroy restores the recorded drums only on a live engine', async () => {
    const {engine, audio} = await playing(denseScore());
    audio.setLevel(2);
    expect(audio.level).toBe(1);
    audio.setLevel(-1);
    expect(audio.level).toBe(0);
    audio.setScore(null);
    expect(audio.events).toEqual([]);
    audio.setMode('notation');
    expect(engine.recordingAudible).toBe(false);
    audio.destroy();
    expect(engine.recordingAudible).toBe(true);
    const second = new DrumAudio(engine);
    second.setMode('notation');
    engine.destroy();
    const setter = vi.spyOn(engine, 'setRecordingAudible');
    second.destroy();
    expect(setter).not.toHaveBeenCalled();
  });
});
