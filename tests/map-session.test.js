// @vitest-environment node
// Edit · Map session (architecture §2.15, package ED1) on the real
// SongMapStore and Metronome, with the real engine over fake-audio.js. The
// scenarios of 1.9's tests/map-mode.test.js are ported here: pin, renumber,
// meter and undo; digits never leak; drum-part guard refusals; the Meter form
// (meter, groups, scope); 4/4 → 3/4 re-barring on a tapped map. Plus Preview,
// calibration, taps, the Find-a-chart audition (D20), markers and suggested
// sections.
import {afterEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => (await import('./helpers/fake-audio.js')).fakeStemcache);
const onsetState = vi.hoisted(() => ({onsets: []}));
vi.mock('../src/js/onsets.js', async (importOriginal) => ({...(await importOriginal()), detectOnsets: vi.fn(() => onsetState.onsets)}));
import {MultitrackEngine} from '../src/js/engine.js';
import {Metronome} from '../src/js/metronome.js';
import {SongMapStore} from '../src/js/song-map.js';
import {createMapSession, MAP_SESSION_COPY, CALIBRATION, MAX_DIGITS, bpmText, clockText} from '../src/edit/map/session.js';
import {fraction} from '../shared/notation.ts';
import {fromBeats} from '../shared/song-map.ts';
import {sameContent} from '../shared/content.ts';
import {FAKE_TIMERS, createClock, installFakeAudio, loadFakeStems} from './helpers/fake-audio.js';
import {legacySongMap, mapStore, pickup, sectioned} from './fixtures/maps.js';

let engine, metronome, map, session, clock, restore, log;

/** Device prefs at a dotted path, like src/app/prefs.js. */
function fakePrefs(initial = {}) {
  const data = {edit: {map: {tapSnap: true, tapOffset: 0, ...initial}}};
  const at = (path) => path.split('.').reduce((o, k) => o?.[k], data);
  return {
    data,
    get: at,
    set: vi.fn((path, value) => { const keys = path.split('.'), leaf = keys.pop(); keys.reduce((o, k) => (o[k] ??= {}), data)[leaf] = value; }),
  };
}

/** The session-side hooks: a practice loop applied to the engine, live markers with tombstones, and call logs. */
function fakeHooks(markers = []) {
  let loop = null;
  return {
    markers,
    get loop() { return loop; },
    hooks: {
      suspendSaves: (on, opts) => log.push(`suspendSaves:${on}${opts?.changed ? ':changed' : ''}`),
      pauseMapSync: (on) => log.push(`pauseMapSync:${on}`),
      status: vi.fn(),
      rename: vi.fn(),
      loop: {
        get: () => (loop ? {...loop} : null),
        set: (range) => { loop = range ? {...range} : null; engine.setLoop(!!range?.on, range?.a ?? 0, range?.b ?? 0); },
      },
      markers: {
        list: () => markers.filter((m) => !m.deleted),
        tombstone: (ids, deleted = true) => { for (const m of markers) if (ids.includes(m.id)) m.deleted = deleted; },
      },
    },
  };
}

async function open({tempo, store, duration = 40, prefs = fakePrefs(), markers = []} = {}) {
  vi.useFakeTimers(FAKE_TIMERS);
  restore = installFakeAudio();
  clock = createClock();
  engine = new MultitrackEngine();
  await loadFakeStems(engine, ['drums', 'bass'], {duration});
  map = store ?? SongMapStore.fromTempo(tempo, duration);
  metronome = new Metronome(engine, map);
  log = [];
  map.subscribe((reason) => log.push(`map:${reason}`));
  const h = fakeHooks(markers);
  session = createMapSession({engine, metronome, map, prefs, hooks: h.hooks});
  return {prefs, h};
}

afterEach(() => {
  session?.destroy();
  metronome?.destroy();
  engine?.destroy();
  session = metronome = engine = map = null;
  onsetState.onsets = [];
  restore?.();
  vi.useRealTimers();
});

const text = () => session.message.value?.text ?? '';
const tone = () => session.message.value?.tone;
const span = () => session.span.value;
/** Run the audio clock until the playing engine reaches media time `t`. */
const playTo = (t) => clock.advance(engine.whenAt(t) - clock.now());

describe('pins, renumbering, meter and undo (1.9 map mode, ported)', () => {
  test('D pins the nearest bar line at the playhead, ⌥← renumbers it, a meter edit and Undo, and the map saves with every pin', async () => {
    await open();
    expect(span().real).toBe(false);                         // the placeholder: no pin shown yet
    expect(span().pin).toBeNull();
    expect(span().tempo.rampAvailable).toBe(false);          // no span between two pins yet
    engine.seek(1);
    expect(session.pinDownbeat()).toBe(true);
    expect(text()).toBe('Pinned bar 1 at 0:01.000');
    expect(tone()).toBe('ok');
    expect(map.data.origin).toBe('edited');
    expect(span().pin).toEqual({time: 1, ramp: false});
    engine.seek(31.3);
    session.pinDownbeat();                                    // the default 120 BPM guesses bar 16
    expect(text()).toMatch(/^Pinned bar 16 at 0:31\.300 · 118\.81 BPM since bar 1$/);
    session.renumber(-1);                                     // it was really bar 15
    expect(text()).toBe('Bar 16 is now bar 15 · 110.89 BPM since bar 1');
    expect(session.typeDigit('9')).toBe(true);
    expect(session.commitDigits()).toBe(true);
    expect(span().display).toBe(9);
    expect(session.digits.value).toBe('');
    session.changeBeats(-1, {thisBar: true});                 // a single 3/4 bar; only downbeats are pinned
    expect(text()).toBe('Bar 9 is 3/4 for this bar · pinned bar lines stayed put, the beats re-spread');
    expect(span().meter.text).toBe('3/4');
    expect(map.undoStack).toHaveLength(4);
    expect(session.undo()).toBe(true);
    expect(text()).toBe('Undone.');
    expect(span().meter.text).toBe('4/4');
    expect(session.canRedo.value).toBe(true);
    const saved = metronome.serialize().songMap;
    expect(saved.pins.map((p) => p.time)).toEqual([1, 31.3]);
    expect(saved.pins[1].position).toEqual(fraction(56));
    expect(saved.origin).toBe('edited');
  });

  test('arrows walk bars and beats, ⌘← → finds pins, Home/End, and selecting while stopped moves the cue', async () => {
    await open();
    session.step(1, 'bar'); expect(engine.getPosition()).toBeCloseTo(2);
    expect(engine.editPosition).toBeCloseTo(2);
    session.step(1, 'beat'); expect(engine.getPosition()).toBeCloseTo(2.5);
    expect(span().beat).toBe(2);
    session.step(-1, 'bar'); expect(engine.getPosition()).toBeCloseTo(2);
    expect(session.step(1, 'pin')).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.noLaterPin);
    session.last(); expect(span().display).toBe(span().barCount);
    session.first(); expect(span().display).toBe(1);
    const near = session.selectNear(5.1);                     // any line; the cue stays put
    expect(near.q).toEqual(fraction(10));
    expect(span().beat).toBe(3);
    expect(engine.getPosition()).toBeCloseTo(0);
    session.pinLine(fraction(24), 13);                         // bar 7
    session.first();
    session.step(1, 'pin'); expect(span().display).toBe(7);
    session.step(-1, 'pin'); expect(span().display).toBe(1);
    expect(session.select(fraction(8))).toBe(true);
    expect(engine.editPosition).toBeCloseTo(8 * 13 / 24);    // bar 3 on the new tempo
  });

  test('digits are a bar number: they jump with Enter, never start playback or touch the mix', async () => {
    await open();
    const play = vi.spyOn(engine, 'play');
    session.typeDigit(1); session.typeDigit('2');
    expect(session.digits.value).toBe('12');
    expect(session.commitDigits()).toBe(true);
    expect(engine.getPosition()).toBeCloseTo(22);
    expect(play).not.toHaveBeenCalled();
    expect(engine.tracks.every((t) => !t.muted && !t.soloed)).toBe(true);
    expect(session.typeDigit('x')).toBe(false);
    for (const d of '123456') session.typeDigit(d);
    expect(session.digits.value).toBe('1234'.slice(0, MAX_DIGITS));
    expect(session.backspaceDigit()).toBe(true);
    expect(session.digits.value).toBe('123');
    expect(session.clearDigits()).toBe(true);
    expect(session.commitDigits()).toBe(false);               // nothing typed: no jump
    expect(engine.getPosition()).toBeCloseTo(22);
    session.goToBar(9999);                                    // clamped to the last bar inside the recording
    expect(span().display).toBe(20);
    session.goToBar('nope');
    expect(span().display).toBe(1);
  });

  // I0A-2: SongMapStore.barIndexAt takes seconds; the session looks bars up by
  // quarter position (barIndexAtQ). 14 bars of 6/8 (3 quarters, 1.5 s each, so
  // 21 s) then 10 bars of 4/4 at 120 quarters a minute: quarter 40 (20 s) is in
  // bar 14 (6/8), while 40 *seconds* would be the last 4/4 bar.
  test('the cursor bar, meter and felt tempo come from the quarter position, not seconds', async () => {
    const measures = Array.from({length: 24}, (_, i) => (i < 14
      ? {id: `m${i}`, numerator: 6, denominator: 8, length: {n: 3, d: 1}, label: ''}
      : {id: `m${i}`, numerator: 4, denominator: 4, length: {n: 4, d: 1}, label: ''}));
    await open({tempo: {songMap: {version: 1, origin: 'edited', tailQpm: 120, pins: [{position: {n: 0, d: 1}, time: 0}], measures}}});
    session.select(fraction(40));
    expect(span()).toMatchObject({display: 14, meter: {text: '6/8'}, tempo: {unit: '♩.', open: 'tail'}});
    expect(span().tempo.bpm).toBeCloseTo(80);                // the tail at 20 s is felt in dotted quarters
    session.goToBar(14);
    expect(engine.editPosition).toBeCloseTo(19.5);          // bar 14 starts at quarter 39
    session.goToBar(15);
    expect(span()).toMatchObject({display: 15, meter: {text: '4/4'}, tempo: {unit: '♩'}});
    expect(engine.editPosition).toBeCloseTo(21);
  });

  test('a pickup displays as "Pickup", counts its beats from the end of its bar, and bar 1 follows it', async () => {
    await open({store: mapStore(pickup), duration: pickup.duration});
    session.goToBar(1);
    expect(engine.getPosition()).toBeCloseTo(1.5);
    expect(span()).toMatchObject({display: 1, name: 'Bar 1', pickup: false});
    session.goToBar(0);
    expect(span()).toMatchObject({display: null, name: 'Pickup', pickup: true, beat: 3, downbeat: false});
    session.step(1, 'beat');
    expect(span().beat).toBe(4);
    session.step(1, 'beat');
    expect(span()).toMatchObject({display: 1, beat: null, downbeat: true});
  });
});

describe('the Meter form ("Edit bar"): every field, one edit', () => {
  test('meter, groups and scope; only the chosen bars change; bad groups and units are refused', async () => {
    await open();
    session.goToBar(3);
    expect(span().form).toMatchObject({numerator: 4, denominator: 4, groups: '', applyTo: 'until', keep: 'lines', pickup: {editable: false}, tempo: {editable: true}});
    expect(session.applyBar({numerator: 7, denominator: 8, groups: '2+2+3', applyTo: 'this'})).toBe(true);
    expect(text()).toBe('Bar 3 is 7/8 for this bar · pinned bar lines stayed put, the beats re-spread');
    expect(span().meter).toMatchObject({text: '7/8', groups: '2+2+3'});
    expect(span().tempo.unit).toBe('♪');                     // uneven groups are felt in eighths
    session.step(1);
    expect(span().meter.text).toBe('4/4');                   // only bar 3 changed
    session.goToBar(3);
    const revision = map.revision;
    expect(session.applyBar({numerator: 5, denominator: 8, groups: '2+2'})).toBe(false);
    expect(text()).toBe('Groups must add up to 5, like 3+2.');
    expect(tone()).toBe('error');
    expect(session.applyBar({numerator: 4, denominator: 3})).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.unitRange);
    expect(session.applyBar({numerator: 17, denominator: 4})).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.beatsRange);
    expect(session.applyBar({numerator: 4, denominator: 4, groups: 'two+two'})).toBe(false);
    expect(map.revision).toBe(revision);
  });

  test('"To the end" with a label, the open-span tempo, and a pickup length on bar 1', async () => {
    await open();
    session.goToBar(5);
    session.applyBar({numerator: 3, denominator: 4, applyTo: 'end', label: '  Bridge  '});
    expect(text()).toMatch(/^Bar 5 is 3\/4 to the end · /);
    expect(span().meter.label).toBe('Bridge');
    session.goToBar(15);
    expect(span().meter.text).toBe('3/4');
    session.goToBar(5);
    expect(session.applyBar({numerator: 3, denominator: 4, tempo: 96})).toBe(true);
    expect(text()).toBe('Bar 5 updated');
    expect(span().tempo.bpm).toBeCloseTo(96);
    expect(span().meter.label).toBe('Bridge');               // an omitted label is kept
    session.goToBar(1);
    expect(span().form.pickup).toEqual({editable: true, value: 4});
    session.applyBar({numerator: 4, denominator: 4, pickup: 2});
    expect(span()).toMatchObject({name: 'Pickup', pickup: true});
    expect(text()).toMatch(/^The pickup is 4\/4 until the next change/);
    expect(map.measure(0).length).toEqual(fraction(2));
    expect(map.undoStack).toHaveLength(3);
  });

  test('on a map tapped on every beat, 4/4 → 3/4 re-bars without moving a single beat', async () => {
    // Every beat pinned at 0.5 s steps, the way a tap-along pass (or a 1.9 detection) leaves the map.
    await open({tempo: {source: 'detected', detected: Array.from({length: 60}, (_, i) => ({time: 0.5 + i * 0.5, downbeat: i % 4 === 0}))}});
    session.goToBar(3);
    expect(span().form.keep).toBe('beats');
    const before = span().pin.time;
    expect(before).toBeCloseTo(4.5);
    session.changeBeats(-1, {thisBar: true});
    expect(text()).toBe('Bar 3 is 3/4 for this bar · beats stayed put, later bar lines moved');
    expect(span().meter.text).toBe('3/4');
    expect(span().pin.time).toBe(before);
    session.step(1);                                          // bar 4 now starts on what was bar 3 beat 4
    expect(clockText(span().pin.time)).toBe('0:06.000');
  });
});

describe('drum-part guard refusals', () => {
  const tapped = () => ({source: 'detected', detected: Array.from({length: 60}, (_, i) => ({time: 0.5 + i * 0.5, downbeat: i % 4 === 0}))});
  /** A drum part on bar 7: it keeps its bar and refuses any change to that bar's meter. */
  function guardBar7() {
    const id = map.measure(6).id;
    const guard = Object.assign((timeline, data) => {
      const m = data.measures.find((x) => x.id === id);
      if (!m || m.numerator !== 4) throw new Error('Bar 7 has drum notes that would no longer fit. Edit them in Edit · Chart first.');
    }, {keep: (barId) => barId === id});
    return map.setGuard('notation', guard);
  }

  test('keeping beats is refused when later bars hold notes; a guard refusal changes nothing; keeping bar lines works', async () => {
    await open({tempo: tapped()});
    guardBar7();
    session.goToBar(3);
    const revision = map.revision, depth = map.undoStack.length;
    expect(session.changeBeats(-1, {thisBar: true})).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.notesAfter);
    expect(tone()).toBe('error');
    expect(session.applyBar({numerator: 3, denominator: 4, applyTo: 'this', keep: 'beats'})).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.notesAfter);
    session.goToBar(7);
    expect(session.changeBeats(-1, {thisBar: true})).toBe(false);
    expect(text()).toBe('Bar 7 has drum notes that would no longer fit. Edit them in Edit · Chart first.');
    expect(tone()).toBe('error');
    expect(map.revision).toBe(revision);
    expect(map.undoStack).toHaveLength(depth);
    session.goToBar(3);
    expect(session.applyBar({numerator: 3, denominator: 4, applyTo: 'this', keep: 'lines'})).toBe(true);
    expect(span().meter.text).toBe('3/4');
  });

  test('an undo the guard refuses is reported and leaves both stacks alone', async () => {
    await open();
    session.goToBar(2);
    session.changeBeats(-1, {thisBar: true});
    const id = map.measure(1).id;
    map.setGuard('notation', (timeline, data) => { if (data.measures.find((m) => m.id === id)?.numerator === 4) throw new Error('That change would remove a bar that has drum notation.'); });
    expect(session.undo()).toBe(false);
    expect(text()).toBe('That change would remove a bar that has drum notation.');
    expect(map.undoStack).toHaveLength(1);
    expect(map.measure(1).numerator).toBe(3);
  });
});

describe('tempo: ramps, open spans, ×2 ÷2', () => {
  test('tail tempo only on open spans; ramps need two pins and a steady neighbour; doubling keeps pin times', async () => {
    await open();
    session.tail(1);
    expect(text()).toBe('Tempo after the last pin: 121 BPM');
    expect(span().tempo.bpm).toBeCloseTo(121);
    session.setTempoOpenSpan(96);
    expect(span().tempo.bpm).toBeCloseTo(96);
    expect(session.setTempoOpenSpan('fast')).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.tempoNumber);
    expect(session.toggleRamp()).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.rampNeedsPins);
    session.pinLine(fraction(0), 0);
    session.pinLine(fraction(16), 8);                       // bar 5: 120 BPM
    session.select(fraction(4));
    expect(span().tempo.rampAvailable).toBe(false);
    expect(session.toggleRamp()).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.rampNeedsSteady);
    session.pinLine(fraction(32), 15);                      // bar 9
    session.select(fraction(20));
    expect(span().tempo).toMatchObject({rampAvailable: true, ramp: false, from: 'bar 5', to: 'bar 9', editable: false});
    expect(session.toggleRamp()).toBe(true);
    expect(text()).toMatch(/^Ramp from bar 5 to bar 9: 120 → \d+(\.\d+)? BPM$/);
    expect(span().tempo.ramp).toBe(true);
    session.toggleRamp();
    expect(text()).toBe('Steady from bar 5 to bar 9');
    expect(session.tail(1)).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.tempoFromPins);
    session.scale(2);
    expect(text()).toBe(MAP_SESSION_COPY.doubled);
    expect(map.data.pins.map((p) => [p.position, p.time])).toEqual([[fraction(0), 0], [fraction(32), 8], [fraction(64), 15]]);
    expect(session.cursorQ.value).toEqual(fraction(40));
    session.scale(0.5);
    expect(text()).toBe(MAP_SESSION_COPY.halved);
    expect(map.data.pins.map((p) => p.position)).toEqual([fraction(0), fraction(16), fraction(32)]);
  });

  test('nudge moves or creates a pin inside its neighbours; unpin keeps the last pin; renumberTo keeps the time', async () => {
    await open();
    expect(session.unpin()).toBe(false);                    // the placeholder's pin is not one you placed
    expect(text()).toBe(MAP_SESSION_COPY.notPinned);
    session.pinLine(fraction(0), 1);
    session.nudge(0.01);
    expect(text()).toBe('Moved bar 1 to 0:01.010');
    expect(engine.getPosition()).toBeCloseTo(1.01);
    expect(session.unpin()).toBe(false);
    expect(text()).toBe('The map needs at least one pin.');
    session.pinLine(fraction(16), 9);
    session.pinLine(fraction(32), 17);
    session.select(fraction(16));
    session.nudge(-20);
    expect(map.data.pins[1].time).toBeCloseTo(1.012);       // 2 ms after its neighbour
    session.nudge(7.988);
    session.renumberTo(7);
    expect(text()).toMatch(/^Bar 5 is now bar 7 · /);
    expect(map.data.pins[1]).toMatchObject({position: fraction(24)});
    expect(map.data.pins[1].time).toBeCloseTo(9);
    session.select(fraction(8));
    expect(session.renumber(1)).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.needPin);
    session.nudge(0.5);                                       // a free line gets a pin at its derived time + 0.5 s
    expect(text()).toMatch(/^Pinned bar 3 to /);
    session.select(fraction(0));
    expect(session.unpin()).toBe(true);
    expect(text()).toBe('Unpinned bar 1. It now follows the pins around it.');
    expect(bpmText(118.8149)).toBe('118.81');
    expect(bpmText(120)).toBe('120');
  });
});

describe('taps', () => {
  test('a tap pass pins line after line, is one undo step, and ends when the transport stops', async () => {
    const {h} = await open();
    await engine.play();
    playTo(1); expect(session.pinDownbeat()).toBe(true);
    expect(session.tapping.value).toBe(true);
    playTo(3); session.pinDownbeat();
    playTo(5); session.pinDownbeat();
    expect(text()).toBe('Tap 3 · bar 3 · 120 BPM');
    expect(map.data.pins.map((p) => [p.position, p.time])).toEqual([[fraction(0), 1], [fraction(4), 3], [fraction(8), 5]]);
    expect(map.data.origin).toBe('tapped');
    expect(session.canUndo.value).toBe(true);
    engine.stop();
    expect(session.tapping.value).toBe(false);
    expect(text()).toBe('Tapped 3 lines. Undo takes back the whole pass.');
    expect(h.hooks.status).toHaveBeenLastCalledWith(text(), expect.objectContaining({tone: 'ok', action: expect.objectContaining({label: 'Undo'})}));
    expect(map.undoStack).toHaveLength(1);
    session.undo();
    expect(map.isReal).toBe(false);                          // back to the placeholder
    expect(span().real).toBe(false);
  });

  test('taps use the calibrated offset, the output timestamp, and snap to drum hits within 40 ms', async () => {
    const {prefs} = await open({prefs: fakePrefs({tapOffset: 0.1, tapSnap: false})});
    await engine.play();
    playTo(1); session.pinBeat();
    expect(map.data.pins[0].time).toBeCloseTo(0.9);
    engine.stop(); session.undo();
    prefs.data.edit.map.tapOffset = 0;
    engine.ctx.getOutputTimestamp = () => ({contextTime: engine.ctx.currentTime - 0.05, performanceTime: 5000});
    await engine.play();
    playTo(2); session.pinBeat({timeStamp: 4990});            // heard 50 ms ago (output latency), pressed 10 ms before that
    expect(map.data.pins[0].time).toBeCloseTo(1.94);
    engine.stop(); session.undo();
    delete engine.ctx.getOutputTimestamp;
    prefs.data.edit.map.tapSnap = true;
    onsetState.onsets = [0.5, 1.03, 2];
    await engine.play();
    playTo(1); session.pinBeat();
    expect(map.data.pins[0].time).toBe(1.03);
  });

  test('taps wait for the count-in, key repeats are ignored, and a pin while previewing goes to the nearest line', async () => {
    await open();
    await engine.play({countIn: {duration: 2, beats: []}});
    expect(engine.countingIn).toBe(true);
    expect(session.pinBeat()).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.countIn);
    expect(session.tapping.value).toBe(false);
    expect(session.pinBeat({repeat: true})).toBe(false);
    engine.stop();
    session.goToBar(5);
    await session.togglePreview();
    clock.advance(0.55);                                       // preview loops from bar 4 (6 s): now at 6.5 s
    session.pinBeat();
    expect(session.tapping.value).toBe(false);
    expect(text()).toMatch(/^Pinned bar 4 beat 2 at 0:06\.500/);
  });
});

describe('Preview and calibration', () => {
  test('Preview loops the bars around the cursor with the click on, follows the cursor, then restores the loop and click', async () => {
    const {h} = await open();
    h.hooks.loop.set({on: true, a: 10, b: 14});
    session.goToBar(5);
    expect(metronome.enabled).toBe(false);
    expect(await session.togglePreview()).toBe(true);
    expect(session.previewing.value).toBe(true);
    expect(engine.playing).toBe(true);
    expect(engine.loop).toEqual({enabled: true, a: 6, b: 12});
    expect(metronome.enabled).toBe(true);
    expect(text()).toBe('Previewing bars 4–6 · Esc to stop');
    session.step(1);
    expect(engine.loop).toEqual({enabled: true, a: 8, b: 14});
    expect(await session.togglePreview()).toBe(false);
    expect(session.previewing.value).toBe(false);
    expect(engine.playing).toBe(false);
    expect(engine.loop).toEqual({enabled: true, a: 10, b: 14});
    expect(h.loop).toEqual({on: true, a: 10, b: 14});
    expect(metronome.enabled).toBe(false);
    expect(engine.editPosition).toBeCloseTo(10);              // stopped at the cursor bar
  });

  test('the transport stopping ends a preview; a click that was on stays on; no loop stays no loop', async () => {
    await open();
    metronome.setEnabled(true);
    session.goToBar(2);
    await session.togglePreview();
    expect(engine.loop).toEqual({enabled: true, a: 0, b: 6});
    engine.stop();
    expect(session.previewing.value).toBe(false);
    expect(engine.loop.enabled).toBe(false);
    expect(metronome.enabled).toBe(true);
  });

  test('calibration stops playback, resumes a suspended AudioContext first, and stores the median tap offset', async () => {
    const {prefs} = await open();
    await engine.play();
    await engine.ctx.suspend();
    expect(engine.ctx.state).toBe('suspended');
    expect(await session.startCalibration()).toBe(true);
    expect(engine.playing).toBe(false);
    expect(engine.ctx.state).toBe('running');
    expect(session.calibrating.value).toBe(true);
    expect(text()).toBe(MAP_SESSION_COPY.calibrating);
    const clicks = engine.ctx.oscillators.slice(-CALIBRATION.clicks);
    const start = clock.now() + CALIBRATION.lead;
    clicks.forEach((osc, i) => expect(osc.startTime).toBeCloseTo(start + i * CALIBRATION.interval));
    expect(clicks.map((osc) => osc.frequency.value)).toEqual(clicks.map((_, i) => (i % 4 === 0 ? 1600 : 1050)));
    const revision = map.revision;
    for (const osc of clicks) { clock.advance(osc.startTime + 0.03 - clock.now()); session.pinBeat(); }
    expect(map.revision).toBe(revision);                       // calibration taps never pin
    clock.advance(1);
    expect(session.calibrating.value).toBe(false);
    expect(prefs.set).toHaveBeenCalledWith('edit.map.tapOffset', 0.03);
    expect(text()).toBe('Your taps land 30 ms late. Taps are corrected from now on.');
  });

  test('too few calibration taps change nothing; audio that will not start is reported', async () => {
    const {prefs} = await open();
    await session.startCalibration();
    for (let i = 0; i < 5; i++) { clock.advance(0.6); session.pinDownbeat(); }
    clock.advance(8);
    expect(text()).toBe(MAP_SESSION_COPY.calibrationShort);
    expect(prefs.set).not.toHaveBeenCalled();
    await engine.ctx.suspend();
    engine.ctx.resume = async () => {};
    expect(await session.startCalibration()).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.calibrationNoAudio);
    expect(session.calibrating.value).toBe(false);
  });
});

describe('Find a chart audition (D20)', () => {
  const candidate = (offset) => fromBeats(Array.from({length: 40}, (_, i) => ({time: offset + i * 0.7, downbeat: i % 4 === 0})), 30);

  test('Keep my map: abortBatch restores the map silently, both stacks stay exactly as they were, and nothing else could edit meanwhile', async () => {
    await open({store: mapStore(legacySongMap), duration: 30});
    session.goToBar(1); session.nudge(0.01); session.nudge(0.01); session.undo();
    const before = map.snapshot(), top = map.undoStack.at(-1), redoTop = map.redoStack.at(-1);
    const depth = [map.undoStack.length, map.redoStack.length];
    expect(session.canUndo.value).toBe(true);
    log.length = 0;
    expect(session.beginAudition()).toBe(true);
    expect(session.auditioning.value).toBe(true);
    expect(session.canUndo.value).toBe(false);
    expect(session.canRedo.value).toBe(false);
    expect(log).toEqual(['suspendSaves:true', 'pauseMapSync:true']);
    map.replace(candidate(0.2), 'tempo-source');              // the find panel's tries
    map.replace(candidate(0.35), 'tempo-source');
    const trying = map.revision;
    expect(session.undo()).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.auditionLocked);
    expect(session.redo()).toBe(false);
    expect(session.pinDownbeat()).toBe(false);
    expect(session.changeBeats(1)).toBe(false);
    expect(session.applyBar({numerator: 3, denominator: 4})).toBe(false);
    expect(session.setLabel(2, 'Verse')).toBe(false);
    expect(session.addSectionAt(4)).toBeNull();
    expect(session.nudge(0.01)).toBe(false);
    expect(map.revision).toBe(trying);
    log.length = 0;
    expect(session.endAudition({commit: false})).toBe(true);
    expect(log).toEqual(['map:restore', 'pauseMapSync:false', 'suspendSaves:false']);
    expect(sameContent(map.snapshot(), before)).toBe(true);
    expect([map.undoStack.length, map.redoStack.length]).toEqual(depth);
    expect(map.undoStack.at(-1)).toBe(top);
    expect(map.redoStack.at(-1)).toBe(redoTop);
    expect(session.auditioning.value).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.keptYours);
    expect(session.canUndo.value).toBe(true);
  });

  test('Use their map: every try becomes one undo step that restores your map exactly', async () => {
    await open({store: mapStore(legacySongMap), duration: 30});
    const before = map.snapshot(), depth = map.undoStack.length;
    session.beginAudition();
    expect(session.beginAudition()).toBe(false);              // already auditioning
    map.replace(candidate(0.2), 'tempo-source');
    map.replace(candidate(0.4), 'tempo-source');
    log.length = 0;
    expect(session.endAudition({commit: true})).toBe(true);
    expect(log).toEqual(['pauseMapSync:false', 'suspendSaves:false:changed']);  // endBatch emits nothing: the save is owed
    expect(text()).toBe(MAP_SESSION_COPY.usingTheirs);
    expect(map.undoStack).toHaveLength(depth + 1);
    expect(map.data.origin).toBe('imported');
    expect(session.endAudition({commit: true})).toBe(false);
    session.undo();
    expect(sameContent(map.snapshot(), before)).toBe(true);
  });

  test('beginning an audition ends a preview and a tap pass; leaving the session mid-audition keeps your map', async () => {
    await open({store: mapStore(legacySongMap), duration: 30});
    const depth = map.undoStack.length;
    await engine.play();
    playTo(1); session.pinDownbeat();
    playTo(3); session.pinDownbeat();
    expect(session.tapping.value).toBe(true);
    session.beginAudition();
    expect(session.tapping.value).toBe(false);
    expect(map.undoStack).toHaveLength(depth + 1);            // the pass closed as its own step before the audition's batch
    const tapped = map.undoStack.at(-1), afterPass = map.snapshot();
    map.replace(candidate(0.2), 'tempo-source');
    session.endAudition({commit: false});
    expect(map.undoStack.at(-1)).toBe(tapped);                // Keep my map leaves the pass's step alone
    expect(sameContent(map.snapshot(), afterPass)).toBe(true);
    engine.stop();
    const before = map.snapshot();
    session.goToBar(3);
    await session.togglePreview();
    session.beginAudition();
    expect(session.previewing.value).toBe(false);
    expect(engine.playing).toBe(false);
    map.replace(candidate(0.2), 'tempo-source');
    session.destroy();
    expect(sameContent(map.snapshot(), before)).toBe(true);
    expect(log.slice(-2)).toEqual(['pauseMapSync:false', 'suspendSaves:false']);
    expect(session.pinDownbeat()).toBe(false);                // a destroyed session edits nothing
    session = null;
  });
});

describe('sections', () => {
  test('rename, move a boundary (never past another section), and add a section at a time', async () => {
    await open({store: mapStore(sectioned), duration: sectioned.duration});
    expect(session.setLabel(8, 'Verse A')).toBe(true);
    expect(text()).toBe('Bar 9 starts “Verse A”');
    expect(map.sections[1].name).toBe('Verse A');
    expect(session.setLabel(8, 'Verse A')).toBe(false);       // unchanged: no step
    expect(session.moveSectionBoundary(16, 18)).toBe(true);
    expect(text()).toBe('Chorus now starts at bar 19');
    expect(map.sections[2]).toMatchObject({name: 'Chorus', startBar: 18});
    expect(map.measure(16).label).toBe('');
    expect(session.moveSectionBoundary(18, 26)).toBe(false);
    expect(text()).toBe(MAP_SESSION_COPY.crosses);
    expect(session.moveSectionBoundary(18, 24)).toBe(false);
    expect(text()).toBe('Bar 25 already starts Verse 2');
    expect(session.moveSectionBoundary(3, 5)).toBe(false);
    expect(text()).toBe('Bar 4 doesn’t start a section.');
    expect(session.addSectionAt(21)).toEqual({index: 10, label: 'Section 9'});
    expect(text()).toBe('Section 9 added');
    expect(session.addSectionAt(17)).toBeNull();
    expect(text()).toBe('Bar 9 already starts Verse A');
    expect(session.setLabel(10, '')).toBe(true);
    expect(text()).toBe('Removed the section label from bar 11');
    expect(session.setLabel(999, 'x')).toBe(false);
    expect(map.undoStack).toHaveLength(4);
    expect(map.data.origin).toBe('edited');
  });

  test('the first section on a song starts "Start" before it', async () => {
    await open();
    session.pinLine(fraction(0), 0.5);
    expect(session.addSectionAt(5)).toEqual({index: 2, label: 'Section 1'});
    expect(map.sections.map((s) => s.name)).toEqual(['Start', 'Section 1']);
  });

  test('markers become sections in one step whose undo brings the markers back; two on one bar keep the first', async () => {
    const markers = [
      {id: 'a', t: 5.1, label: 'Verse'},
      {id: 'b', t: 5.6, label: 'Duplicate'},
      {id: 'c', t: 12.8, label: ''},
      {id: 'd', t: 20, label: 'Gone', deleted: true},
    ];
    const {h} = await open({store: mapStore(legacySongMap), duration: 30, markers});
    const depth = map.undoStack.length;
    expect(session.markersToSections()).toEqual({converted: ['a', 'c'], skipped: ['b']});
    expect(text()).toBe('Turned 2 markers into sections · skipped 1 on a bar that already had one');
    expect([map.measure(2).label, map.measure(6).label]).toEqual(['Verse', 'Section 2']);
    expect(markers.map((m) => !!m.deleted)).toEqual([true, false, true, true]);
    expect(map.undoStack).toHaveLength(depth + 1);
    const [, opts] = h.hooks.status.mock.lastCall;
    expect(opts.action.label).toBe('Undo');
    opts.action.run();                                        // the status line's Undo
    expect([map.measure(2).label, map.measure(6).label]).toEqual(['', '']);
    expect(markers.map((m) => !!m.deleted)).toEqual([false, false, false, true]);
    session.redo();
    expect(map.measure(2).label).toBe('Verse');
    expect(markers.map((m) => !!m.deleted)).toEqual([true, false, true, true]);
    session.undo();
    markers.splice(0, markers.length);
    expect(session.markersToSections()).toEqual({converted: [], skipped: []});
    expect(text()).toBe(MAP_SESSION_COPY.noMarkers);
  });

  test('suggested sections: review snaps each block to a bar, edits apply as one undoable step, labelled bars are skipped', async () => {
    await open({store: mapStore(legacySongMap), duration: 30});
    session.setLabel(6, 'Mine');
    const suggestion = {sections: [{t0: 17, label: ''}, {t0: 1.1, label: 'Intro', confidence: 0.9}, {t0: 9.2, label: 'Verse'}, {t0: 9.6, label: 'Dup'}, {t0: 13.1, label: 'Clash'}]};
    const {blocks} = session.reviewSuggestion(suggestion);
    expect(blocks.map((b) => [b.bar, b.t0, b.label, b.accepted])).toEqual([
      [0, 1, 'Intro', true], [4, 9, 'Verse', true], [4, 9, 'Dup', false], [6, 13, 'Clash', false], [8, 17, 'Section 5', true],
    ]);
    expect(blocks[0].confidence).toBe(0.9);
    expect(session.review.value.blocks).toHaveLength(5);
    expect(session.setSuggestionBlock(4, {label: 'Chorus', bar: 9})).toMatchObject({bar: 9, t0: 19, label: 'Chorus', accepted: true});
    session.setSuggestionBlock(0, {accepted: false});
    expect(session.setSuggestionBlock(9, {accepted: true})).toBeNull();
    const depth = map.undoStack.length;
    expect(session.applySuggestionReview()).toEqual({added: 2});
    expect(text()).toBe('Added 2 sections');
    expect(session.review.value).toBeNull();
    expect([map.measure(0).label, map.measure(4).label, map.measure(6).label, map.measure(9).label]).toEqual(['', 'Verse', 'Mine', 'Chorus']);
    expect(map.undoStack).toHaveLength(depth + 1);
    session.undo();
    expect([map.measure(4).label, map.measure(9).label]).toEqual(['', '']);
    expect(session.reviewSuggestion(null)).toEqual({blocks: []});
    expect(session.review.value).toBeNull();
    expect(session.applySuggestionReview()).toEqual({added: 0});
  });
});

describe('edits that must not spill over', () => {
  /** A stored 20-bar map with one pin at 120 quarters a minute; `make(i)` returns a measure's overrides. */
  const stored = (make = () => ({})) => ({songMap: {version: 1, origin: 'edited', tailQpm: 120, pins: [{position: {n: 0, d: 1}, time: 0}],
    measures: Array.from({length: 20}, (_, i) => ({id: `b${i}`, numerator: 4, denominator: 4, length: {n: 4, d: 1}, label: '', ...make(i)}))}});
  /** Every field of the Meter form as the inspector would send it back unchanged. */
  const formFields = (f = span().form) => ({numerator: f.numerator, denominator: f.denominator, groups: f.groups, pickup: f.pickup.value, label: f.label, applyTo: f.applyTo, keep: f.keep});

  test('the Meter form: the offered pickup keeps a full bar 1 full; a label edit leaves other bars alone; all-ones groups are no change', async () => {
    await open({tempo: stored(() => ({numerator: 3, length: {n: 3, d: 1}}))});
    session.goToBar(1);
    expect(span().form.pickup).toEqual({editable: true, value: 3});
    expect(session.applyBar({...formFields(), numerator: 4})).toBe(true);
    expect(text()).toMatch(/^Bar 1 is 4\/4 until the next change · /);
    expect(map.measure(0).length).toEqual(fraction(4));
    expect(span()).toMatchObject({name: 'Bar 1', display: 1, pickup: false});

    await open({tempo: stored((i) => (i === 5 ? {length: {n: 2, d: 1}} : {}))});
    session.goToBar(2);
    expect(session.applyBar({...formFields(), label: 'Verse'})).toBe(true);
    expect(text()).toBe('Bar 2 updated');
    expect(map.measure(5).length).toEqual(fraction(2));      // the short bar later in the run stays short
    expect(map.measure(1).label).toBe('Verse');
    session.applyBar({...formFields(), numerator: 3});        // a real meter change keeps it short where it still fits
    expect(map.measure(4)).toMatchObject({numerator: 3, length: fraction(3)});
    expect(map.measure(5)).toMatchObject({numerator: 3, length: fraction(2)});

    await open({tempo: stored(() => ({grouping: [1, 1, 1, 1]}))});
    session.goToBar(3);
    expect(span().form.groups).toBe('');
    expect(session.applyBar({...formFields(), label: 'Verse'})).toBe(true);
    expect(text()).toBe('Bar 3 updated');
    expect(map.measure(3).grouping).toEqual([1, 1, 1, 1]);
  });

  test('a this-bar meter change chooses Keep beats from that bar only, not from a beat pin later in the run', async () => {
    await open();
    session.pinLine(fraction(0), 0);
    session.pinLine(fraction(41), 20.5);                      // bar 11 beat 2
    session.goToBar(3);
    expect(span().form.keep).toBe('beats');                   // the whole run holds a beat pin
    session.changeBeats(-1, {thisBar: true});
    expect(text()).toBe('Bar 3 is 3/4 for this bar · pinned bar lines stayed put, the beats re-spread');
  });

  test('canUndo sees a batch the session did not open (a lane drag) before and after it closes', async () => {
    await open();
    expect(session.canUndo.value).toBe(false);
    map.beginBatch();
    map.edit((d) => { d.tailQpm = 100; }, 'drag');
    expect(session.canUndo.value).toBe(true);
    map.endBatch();
    expect(map.undoStack).toHaveLength(1);
    expect(session.canUndo.value).toBe(true);
  });

  test('an edit while a tap pass is open closes the pass first, so Undo of the pass keeps it', async () => {
    const {h} = await open();
    await engine.play();
    playTo(1); session.pinDownbeat();
    expect(session.tapping.value).toBe(true);
    expect(session.addSectionAt(10)).toEqual({index: 4, label: 'Section 1'});  // bar 1 pinned at 1 s: 10 s is in bar 5
    expect(session.tapping.value).toBe(false);
    expect(map.undoStack).toHaveLength(2);
    expect(text()).toBe('Section 1 added');
    const [said, opts] = h.hooks.status.mock.lastCall;       // §4.5: "Section {n} added — Rename"
    expect([said, opts.action.label]).toEqual(['Section 1 added', 'Rename']);
    opts.action.run();
    expect(h.hooks.rename).toHaveBeenCalledWith(4);
    session.undo();
    expect(map.measure(4).label).toBe('');
    expect(map.isReal).toBe(true);                            // the tapped pin is still there
    session.undo();
    expect(map.isReal).toBe(false);
  });

  test('Preview: P again or destroy while play() waits on ctx.resume() leaves the transport stopped; the pickup reads as such', async () => {
    const {h} = await open();
    await engine.ctx.suspend();
    const p1 = session.togglePreview(), p2 = session.togglePreview();
    expect(await p1).toBe(false);
    expect(await p2).toBe(false);
    expect([engine.playing, session.previewing.value, engine.loop.enabled]).toEqual([false, false, false]);
    await engine.ctx.suspend();
    const p3 = session.togglePreview();
    session.togglePreview();
    const p4 = session.togglePreview();                       // a new preview while the first still waits
    expect(await p3).toBe(false);
    expect(await p4).toBe(true);
    expect([engine.playing, session.previewing.value]).toEqual([true, true]);
    await session.togglePreview();
    await engine.ctx.suspend();
    const p5 = session.togglePreview();
    session.destroy();
    expect(await p5).toBe(false);
    expect(engine.playing).toBe(false);
    session = createMapSession({engine, metronome, map: mapStore(pickup), prefs: fakePrefs(), hooks: h.hooks});
    session.goToBar(0);
    await session.togglePreview();
    expect(text()).toBe('Previewing the pickup to bar 1 · Esc to stop');
    expect(MAP_SESSION_COPY.previewing(null, null)).toBe('Previewing the pickup · Esc to stop');
  });

  test('Tap along: a preview gives way to playing with the hint; pressed again it stops and closes the pass', async () => {
    await open();
    session.goToBar(3);
    await session.togglePreview();
    expect(await session.tapAlong()).toBe(true);
    expect([session.previewing.value, engine.playing, engine.loop.enabled]).toEqual([false, true, false]);
    expect(text()).toBe(MAP_SESSION_COPY.tapAlong);
    clock.advance(0.5); session.pinDownbeat();
    expect(session.tapping.value).toBe(true);
    expect(await session.tapAlong()).toBe(false);
    expect([engine.playing, session.tapping.value]).toEqual([false, false]);
    expect(text()).toBe('Tapped 1 line. Undo takes back the whole pass.');
  });
});

describe('lifecycle', () => {
  test('destroy ends a preview and a pass, stops listening, and refuses later edits', async () => {
    const {h, prefs} = await open();
    await engine.play();
    playTo(1); session.pinDownbeat();
    playTo(3); session.pinDownbeat();
    session.destroy();
    expect(session.tapping.value).toBe(false);
    expect(map.batch).toBeNull();
    expect(map.undoStack).toHaveLength(1);                    // the pass is one step
    engine.stop();
    session = createMapSession({engine, metronome, map, prefs, hooks: h.hooks});
    h.hooks.loop.set({on: true, a: 2, b: 4});
    session.goToBar(6);
    await session.togglePreview();
    session.destroy();
    expect(engine.loop).toEqual({enabled: true, a: 2, b: 4});
    expect(engine.playing).toBe(false);
    const revision = session.span.value;
    map.edit((d) => { d.tailQpm = 90; }, 'tempo');
    expect(session.span.value).toBe(revision);               // no longer following the map
    expect(session.pinDownbeat()).toBe(false);
    expect(session.typeDigit('1')).toBe(false);
    session.destroy();                                        // idempotent
    session = null;
  });

  test('the cursor starts on the bar line nearest the playhead and re-snaps after an undo removes its line', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    restore = installFakeAudio();
    clock = createClock();
    engine = new MultitrackEngine();
    await loadFakeStems(engine, ['drums'], {duration: 40});
    engine.seek(8.7);
    map = SongMapStore.fromTempo(undefined, 40);
    metronome = new Metronome(engine, map);
    session = createMapSession({engine, metronome, map, prefs: fakePrefs()});
    expect(span().display).toBe(5);                           // 8 s is the nearest bar line to 8.7 s
    session.goToBar(3);
    session.applyBar({numerator: 7, denominator: 8, groups: '2+2+3', applyTo: 'this'});
    session.step(1, 'beat'); session.step(1, 'beat');         // the 3rd counted beat of the 7/8 bar
    expect(span().beat).toBe(3);
    session.undo();                                           // 4/4 again: that line is gone
    expect(map.lines.some((l) => l.q.n * session.cursorQ.value.d === session.cursorQ.value.n * l.q.d)).toBe(true);
  });
});
