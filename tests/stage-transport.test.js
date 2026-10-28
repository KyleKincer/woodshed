// @vitest-environment node
// The transport (architecture §2.14.3 rules 1–23, §5.4 item 14) on the real
// engine, metronome, song map, position model, practice state and undo stack,
// over tests/helpers/fake-audio.js and the fake clock. The test bed below is
// ST1a's own (ST1c generalises it into tests/helpers/test-session.js). The
// flows that depend on playback timing run on both engine paths: native
// (rate 1) and Signalsmith (keep pitch at 80%), asserting the §5.0 cut rule
// on every `stretch.schedule` call.
import {afterEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => (await import('./helpers/fake-audio.js')).fakeStemcache);
import {MultitrackEngine} from '../src/js/engine.js';
import {Metronome} from '../src/js/metronome.js';
import {createPositionModel} from '../src/stage/position.js';
import {createPracticeState} from '../src/stage/practice-state.js';
import {createPracticeUndo} from '../src/stage/undo.js';
import {createTransport, canonicalStems, trainerRates, COPY, LEAD_IN_SEC} from '../src/stage/transport.js';
import {FAKE_TIMERS, createClock, installFakeAudio, loadFakeStems} from './helpers/fake-audio.js';
import {mapStore, sectioned, sevenEight, unmapped} from './fixtures/maps.js';

const SIX = ['drums', 'bass', 'guitar', 'piano', 'vocals', 'other'];
const ACCOUNT = Object.freeze({
  practice: {stop: 'cue', countIn: {on: false, length: 1, unit: 'bars'}, click: 'countin', eachPassCount: true, keepPitch: true},
  profile: {instruments: ['guitar'], primary: 'guitar', openWithMyPart: 'in'},
});
const CLICK_ON = Object.freeze({countIn: {on: true, length: 1, unit: 'bars'}, mode: 'countin', accent: true, volume: 0.7, preRoll: false});
const loopAt = (a, b, extra = {}) => ({on: true, a, b, eachPassCount: true, playTimes: 0, between: 'none', ...extra});
const PATHS = [{name: 'native', rate: 1}, {name: 'signalsmith', rate: 0.8}];

let current = null;
let restoreAudio = null;

/**
 * A song session reduced to what the transport needs, built the way §2.14.1
 * builds it: the transport first, on an engine that has not loaded; then the
 * stems load, the map takes the decoded duration and `transport.ready()` runs.
 */
async function bed({fixture = sectioned, raw = {}, stems = SIX, account = ACCOUNT, load = true, rate = 1, resplit = null} = {}) {
  vi.useFakeTimers(FAKE_TIMERS);
  restoreAudio = installFakeAudio();
  const clock = createClock();
  const engine = new MultitrackEngine();
  const map = mapStore(fixture);
  const metronome = new Metronome(engine, map);
  const saves = [];
  const practice = createPracticeState({
    songId: 'song-1', raw: {v: 2, rate, ...raw}, duration: fixture.duration,
    persist: async (p, {final}) => { saves.push({p, final}); }, defaults: account.practice,
  });
  const position = createPositionModel({map, practice});
  const undo = createPracticeUndo();
  const statuses = [];
  const transport = createTransport({engine, metronome, map, position, practice, undo, account, resplit, stems,
    status: (text, options = {}) => statuses.push({text, ...options})});
  const events = [];
  for (const type of ['pass', 'trainer', 'jumped', 'ended', 'interrupted', 'count', 'gesture', 'mix-sheet']) {
    transport.on(type, (payload) => events.push({type, ...payload}));
  }
  const phases = [];
  transport.snapshot.subscribe((s) => { if (phases.at(-1) !== s.phase) phases.push(s.phase); });
  const tb = {
    clock, engine, map, metronome, practice, position, undo, transport, statuses, events, phases, saves, fixture,
    get snap() { return transport.snapshot.peek(); },
    get now() { return engine.ctx.currentTime; },
    advance: (sec) => clock.advance(sec),
    async load() {
      await loadFakeStems(engine, stems, {duration: fixture.duration});
      map.setDuration(engine.duration);
      await transport.ready();
    },
    of: (type) => events.filter((e) => e.type === type),
    /** Oscillators (clicks) that will sound, started at or after `t`. */
    clicksFrom: (t) => engine.ctx.oscillators.filter((o) => o.startTime != null && o.startTime >= t - 1e-9 && o.playsAt(o.startTime)),
    track: (name) => engine.tracks.find((t) => t.name === name),
  };
  current = tb;
  if (load) await tb.load();
  return tb;
}

afterEach(() => {
  if (current) {
    current.transport.destroy();
    current.metronome.destroy();
    current.engine.destroy();
    current.practice.dispose();
    current.position.dispose();
  }
  current = null;
  restoreAudio?.();
  restoreAudio = null;
  vi.useRealTimers();
});

/** Every Signalsmith post carries an explicit `outputTime` strictly before its `output` (§5.0 cut rule). */
function expectCutRule(engine) {
  const calls = engine.stretch.schedule.mock.calls.map(([arg]) => arg);
  for (const call of calls) {
    expect(call).toHaveProperty('outputTime');
    expect(call.outputTime).toBeLessThan(call.output);
  }
  return calls;
}

describe('helpers', () => {
  test('canonical stem order: the six stems, then others, then no_*', () => {
    expect(canonicalStems(['other', 'vocals', 'no_drums', 'drums', 'click', 'bass'])).toEqual(['drums', 'bass', 'vocals', 'other', 'click', 'no_drums']);
    expect(canonicalStems(['no_vocals', 'vocals'])).toEqual(['vocals', 'no_vocals']);
  });

  test('trainer rates run from start to end inclusive, the last one clamped', () => {
    expect(trainerRates({start: 0.7, end: 1, step: 0.05})).toEqual([0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1]);
    expect(trainerRates({start: 0.7, end: 0.82, step: 0.05})).toEqual([0.7, 0.75, 0.8, 0.82]);
  });
});

describe.each(PATHS)('play, stop and the cue on the $name path', ({name, rate}) => {
  afterEach(() => { if (name === 'signalsmith' && current?.engine.stretch) expectCutRule(current.engine); });

  test('Space plays from the loop start; Stop returns to the cue (rules 1, 2, 4)', async () => {
    const tb = await bed({rate, raw: {cue: 10}});
    const {transport} = tb;
    expect(tb.snap.phase).toBe('stopped');
    expect(transport.position()).toBe(10);
    transport.loopRange(32, 36);
    expect(tb.snap.cue).toBe(32);                // setting a loop sets cue = loop.a
    transport.cue(20);                           // the cue may sit elsewhere while the loop is on
    await transport.playStop();
    expect(tb.snap.phase).toBe('playing');
    tb.advance(1);
    expect(transport.position()).toBeCloseTo(32 + (1 - tb.engine.lookahead) * rate, 3);
    transport.playStop();
    expect(tb.snap.phase).toBe('stopped');
    expect(transport.position()).toBe(20);
    expect(tb.snap.cue).toBe(20);
    transport.clearLoop();
    expect(tb.snap.cue).toBe(20);                // clearing the loop leaves the cue
    await transport.playStop();
    expect(transport.position()).toBeCloseTo(20, 1);
  });

  test("stop in 'stay' mode moves the cue to where playback stopped (rule 4)", async () => {
    const tb = await bed({rate, raw: {cue: 10}, account: {...ACCOUNT, practice: {...ACCOUNT.practice, stop: 'stay'}}});
    await tb.transport.play();
    tb.advance(2);
    const at = tb.transport.position();
    tb.transport.stop();
    expect(tb.snap.phase).toBe('stopped');
    expect(tb.snap.cue).toBeCloseTo(at, 2);
    expect(tb.transport.position()).toBeCloseTo(at, 2);
  });

  test('Stop flushes the practice save with final: true', async () => {
    const tb = await bed({rate, raw: {cue: 10}});
    await tb.transport.play();
    tb.advance(0.5);
    tb.transport.stop();
    await vi.runOnlyPendingTimersAsync();
    expect(tb.saves.some((s) => s.final)).toBe(true);
  });

  test('position() in each phase: cue when stopped, playhead when playing, pausedAt when paused, the target while counting', async () => {
    const tb = await bed({rate, raw: {cue: 40, click: CLICK_ON}});
    const {transport, engine} = tb;
    expect(transport.position()).toBe(40);
    await transport.play();
    expect(tb.snap.phase).toBe('counting');
    tb.advance(0.5);
    expect(transport.position()).toBe(40);       // a silent count reads the target
    tb.advance(2 / rate);
    expect(tb.snap.phase).toBe('playing');
    const playing = transport.position();
    expect(playing).toBeGreaterThan(40);
    await transport.pause();
    expect(tb.snap.phase).toBe('paused');
    expect(transport.position()).toBe(engine.pausedAt);
    expect(engine.pausedAt).toBeCloseTo(playing, 3);
    expect(tb.snap.cue).toBe(40);                // pause never moves the cue
  });

  test('pause continues in place with no count-in; outside the loop it continues from a (rule 5)', async () => {
    const tb = await bed({rate, raw: {cue: 32, loop: loopAt(32, 36), click: CLICK_ON}});
    const {transport, engine} = tb;
    await transport.play();
    tb.advance(2 / rate + 0.5);
    expect(tb.snap.phase).toBe('playing');
    await transport.pause();
    const at = engine.pausedAt;
    await transport.pause();                     // continue
    expect(tb.snap.phase).toBe('playing');
    expect(engine.countIn).toBe(null);
    expect(transport.position()).toBeCloseTo(at, 3);
    await transport.pause();
    engine.pausedAt = 50;                        // e.g. the loop moved while paused
    transport.seek(50);
    await transport.play();
    expect(transport.position()).toBeCloseTo(32, 3);
  });
});

describe.each(PATHS)('Again on the $name path (rule 6)', ({name, rate}) => {
  afterEach(() => { if (name === 'signalsmith' && current?.engine.stretch) expectCutRule(current.engine); });

  test('stopped, count-in off: plays from the current section start and keeps the cue', async () => {
    const tb = await bed({rate, raw: {cue: 20}});
    await tb.transport.again();
    expect(tb.snap.phase).toBe('playing');
    expect(tb.transport.position()).toBeCloseTo(16, 2);   // Verse starts at 16 s
    expect(tb.snap.cue).toBe(20);
    tb.transport.stop();
    expect(tb.transport.position()).toBe(20);
  });

  test('playing, count-in off: seeks in place without stopping', async () => {
    const tb = await bed({rate, raw: {cue: 20}});
    await tb.transport.play();
    tb.advance(1);
    const revision = tb.engine.revision;
    await tb.transport.again();
    expect(tb.snap.phase).toBe('playing');
    expect(tb.engine.revision).toBeGreaterThan(revision);
    expect(tb.phases).not.toContain('counting');
    tb.advance(0.5);
    expect(tb.transport.position()).toBeCloseTo(16 + (0.5 - tb.engine.lookahead) * rate, 2);
    expect(tb.snap.cue).toBe(20);
  });

  test('playing, count-in on: restarts with a count at the target', async () => {
    const tb = await bed({rate, raw: {cue: 20, click: CLICK_ON}});
    await tb.transport.play();
    tb.advance(2 / rate + 1);
    expect(tb.snap.phase).toBe('playing');
    await tb.transport.again();
    expect(tb.snap.phase).toBe('counting');
    expect(tb.engine.countIn.target).toBe(16);
    expect(tb.snap.cue).toBe(20);
  });

  test('counting: restarts the count; paused: plays from the target with a count; a loop makes the target a', async () => {
    const tb = await bed({rate, raw: {cue: 20, click: CLICK_ON}});
    await tb.transport.play();
    tb.advance(0.5);
    const first = tb.engine.countIn.startWhen;
    await tb.transport.again();
    expect(tb.snap.phase).toBe('counting');
    expect(tb.engine.countIn.startWhen).toBeGreaterThan(first);
    expect(tb.engine.countIn.target).toBe(16);
    tb.advance(2 / rate + 1);
    await tb.transport.pause();
    await tb.transport.again();
    expect(tb.snap.phase).toBe('counting');
    expect(tb.engine.countIn.target).toBe(16);
    tb.transport.stop();
    tb.transport.loopRange(40, 44);
    tb.transport.cue(50);
    await tb.transport.again();
    expect(tb.engine.countIn.target).toBe(40);
    expect(tb.snap.cue).toBe(50);
  });

  test('Again and Play emit gesture synchronously, before any await', async () => {
    const tb = await bed({rate});
    const promise = tb.transport.again();
    expect(tb.of('gesture')).toHaveLength(1);
    await promise;
    tb.transport.stop();
    tb.transport.play();
    tb.transport.playFrom(30);
    expect(tb.of('gesture')).toHaveLength(3);
  });
});

describe('during a count-in (rule 21 table, phase from engine events)', () => {
  /** Counting at cue 32 (bar 17), 0.5 s in. */
  async function counting(extra = {}) {
    const tb = await bed({raw: {cue: 32, click: CLICK_ON, ...extra}});
    await tb.transport.play();
    tb.advance(0.5);
    expect(tb.snap.phase).toBe('counting');
    return tb;
  }
  const restarted = (tb, before) => tb.engine.countIn && tb.engine.countIn.startWhen > before + 1e-9;

  test('Play/Stop cancels the count; the cue is unchanged and no click follows', async () => {
    const tb = await counting();
    tb.transport.playStop();
    expect(tb.snap.phase).toBe('stopped');
    expect(tb.snap.cue).toBe(32);
    expect(tb.clicksFrom(tb.now)).toHaveLength(0);
  });

  test('Again restarts the count at the re-computed target', async () => {
    const tb = await counting();
    const before = tb.engine.countIn.startWhen;
    await tb.transport.again();
    expect(restarted(tb, before)).toBe(true);
    expect(tb.engine.countIn.target).toBe(32);
    expect(tb.phases).toEqual(['stopped', 'counting']);   // the restart never shows 'stopped'
  });

  test('a speed change restarts the count at the same target with the new rate', async () => {
    const tb = await counting();
    const before = tb.engine.countIn.startWhen;
    tb.transport.setSpeed(0.9);
    expect(restarted(tb, before)).toBe(true);
    expect(tb.engine.countIn.target).toBe(32);
    expect(tb.engine.countIn.rate).toBe(0.9);
    expect(tb.phases).toEqual(['stopped', 'counting']);
  });

  test('a keep-pitch change restarts the count', async () => {
    const tb = await counting({rate: 0.8});
    const before = tb.engine.countIn.startWhen;
    tb.transport.setKeepPitch(false);
    expect(restarted(tb, before)).toBe(true);
    expect(tb.engine.preservePitch).toBe(false);
  });

  test('a loop edit restarts the count only when the start target changes', async () => {
    const tb = await counting();
    const before = tb.engine.countIn.startWhen;
    tb.transport.loopRange(32, 36);              // starts at the target: the count continues
    expect(tb.engine.countIn.startWhen).toBe(before);
    expect(tb.engine.loop.enabled).toBe(false);  // applied when the count ends
    tb.advance(2);
    expect(tb.snap.phase).toBe('playing');
    expect(tb.engine.loop).toMatchObject({enabled: true, a: 32, b: 36});
    tb.transport.stop();
    await tb.transport.play();
    tb.advance(0.5);
    const second = tb.engine.countIn.startWhen;
    tb.transport.loopRange(40, 44);              // a new start: count again there
    expect(restarted(tb, second)).toBe(true);
    expect(tb.engine.countIn.target).toBe(40);
  });

  test('a seek or tap cue cancels the count and cues there', async () => {
    const tb = await counting();
    tb.transport.seek(40);
    expect(tb.snap.phase).toBe('stopped');
    expect(tb.snap.cue).toBe(40);
  });

  test('a quantized jump cancels the count, cues at t and counts in afresh there', async () => {
    const tb = await counting();
    tb.transport.jump(40, {label: 'Verse 2'});
    expect(tb.snap.phase).toBe('counting');
    expect(tb.engine.countIn.target).toBe(40);
    expect(tb.snap.cue).toBe(40);
  });

  test('count-in off ends the count now and plays from the target', async () => {
    const tb = await counting();
    tb.transport.toggleCountIn();
    expect(tb.snap.phase).toBe('playing');
    expect(tb.snap.countIn.on).toBe(false);
    expect(tb.engine.countIn).toBe(null);
    tb.advance(0.2);
    expect(tb.transport.position()).toBeCloseTo(32 + 0.2 - tb.engine.lookahead, 2);
  });

  test('click mode, accent and volume apply to the remaining clicks; the count continues', async () => {
    const tb = await counting();
    const before = tb.engine.countIn.startWhen;
    tb.transport.setClickMode('always');
    tb.transport.setAccent(false);
    tb.transport.setClickVolume(0.3);
    expect(tb.engine.countIn.startWhen).toBe(before);
    expect(tb.metronome.settings()).toMatchObject({mode: 'always', accent: false, volume: 0.3});
    tb.advance(2);
    expect(tb.snap.phase).toBe('playing');
  });

  test('mix, chart audio and label-only map edits have no effect on the count', async () => {
    const tb = await counting();
    const before = tb.engine.countIn.startWhen;
    tb.transport.setMuted('drums', true);
    tb.transport.setChartAudio('quiet');
    tb.map.edit((d) => { d.measures[20].label = 'Hook'; }, 'label');
    expect(tb.engine.countIn.startWhen).toBe(before);
    expect(tb.snap.phase).toBe('counting');
    expect(tb.track('drums').muted).toBe(true);
  });

  test('map edits other than labels restart the count at the same target', async () => {
    const tb = await counting();
    const before = tb.engine.countIn.startWhen;
    tb.map.edit((d) => { d.tailQpm = 100; }, 'tempo');
    expect(restarted(tb, before)).toBe(true);
    expect(tb.engine.countIn.target).toBe(32);
    expect(tb.engine.countIn.duration).toBeCloseTo(2.4, 6);   // one 4/4 bar at 100 bpm
  });

  test('the phase follows the engine: a count that ends turns into playing with no transport call', async () => {
    const tb = await counting();
    tb.advance(1.6);
    expect(tb.snap.phase).toBe('playing');
    expect(tb.phases).toEqual(['stopped', 'counting', 'playing']);
  });

  test('the count-in plate counts down with the beats', async () => {
    const tb = await bed({raw: {cue: 32, click: CLICK_ON}});
    await tb.transport.play();
    expect(tb.snap.countdown).toEqual({current: 4, of: 4, label: 'Count-in · bar 17'});
    tb.advance(0.06);
    expect(tb.snap.countdown.current).toBe(4);
    tb.advance(0.5);
    expect(tb.snap.countdown.current).toBe(3);
    tb.advance(1);
    expect(tb.snap.countdown.current).toBe(1);
    tb.advance(0.5);
    expect(tb.snap.countdown).toBe(null);
    expect(tb.of('count').map((e) => e.current)).toEqual([4, 3, 2, 1]);
  });

  test('a silent count (mode off) counts the plate but plays no click', async () => {
    const tb = await bed({raw: {cue: 32, click: {...CLICK_ON, mode: 'off'}}});
    const from = tb.now;
    await tb.transport.play();
    tb.advance(1);
    expect(tb.snap.countdown.current).toBe(3);
    tb.advance(1.2);
    expect(tb.clicksFrom(from)).toHaveLength(0);
  });
});

describe.each(PATHS)('count in every pass and between passes on the $name path (rule 9)', ({name, rate}) => {
  afterEach(() => { if (name === 'signalsmith' && current?.engine.stretch) expectCutRule(current.engine); });

  test('the gap is the count-in plan at a; its clicks end where the next pass starts', async () => {
    const tb = await bed({rate, raw: {cue: 32, loop: loopAt(32, 36), click: CLICK_ON}});
    expect(tb.engine.loopGap).toEqual({sec: 2, mode: 'silent'});
    await tb.transport.play();
    tb.advance(2 / rate + 0.1);                  // the first count is over
    const wrap = tb.engine.nextWrapAt();
    const passStart = wrap + 2 / rate;
    expect(tb.clicksFrom(wrap - 1e-6)).toHaveLength(0);
    tb.advance(wrap - tb.now + 0.6 / rate);
    expect(tb.snap.countdown).toEqual({current: 3, of: 4, label: 'Count-in · bar 17'});
    expect(tb.transport.position()).toBe(32);    // a silent gap reads a
    tb.advance(passStart - tb.now + 0.1);
    const clicks = tb.clicksFrom(wrap - 1e-6).map((o) => o.startTime).filter((t) => t < passStart - 1e-6);
    expect(clicks).toHaveLength(4);
    expect(clicks[0]).toBeCloseTo(wrap, 6);
    expect(clicks.at(-1)).toBeCloseTo(passStart - 0.5 / rate, 6);
    expect(tb.snap.countdown).toBe(null);
    expect(tb.transport.position()).toBeCloseTo(32 + (tb.now - passStart) * rate, 2);
    expect(tb.snap.pass).toBe(1);
  });

  test("'1 bar rest' adds one bar at a to the gap; without every-pass count the rest is the whole gap", async () => {
    const tb = await bed({rate, raw: {cue: 32, loop: loopAt(32, 36, {between: 'rest'}), click: CLICK_ON}});
    expect(tb.engine.loopGap).toEqual({sec: 4, mode: 'silent'});
    tb.transport.setLoopOptions({eachPassCount: false});
    expect(tb.engine.loopGap).toEqual({sec: 2, mode: 'silent'});
    tb.transport.setLoopOptions({between: 'none'});
    expect(tb.engine.loopGap).toEqual({sec: 0, mode: 'silent'});
  });

  test('pass counting skips the gap; passes reset on a seek', async () => {
    const tb = await bed({rate, raw: {cue: 32, loop: loopAt(32, 36), click: CLICK_ON}});
    await tb.transport.play();
    tb.advance((2 + 4 + 2 + 4) / rate + 0.2);
    expect(tb.snap.pass).toBe(2);
    tb.transport.seek(33);
    expect(tb.snap.pass).toBe(0);
  });
});

describe('unmapped songs', () => {
  test('a count-in is the 2 s audible lead-in, with no clicks at all (rule 2)', async () => {
    const tb = await bed({fixture: unmapped, raw: {cue: 10, click: {...CLICK_ON, mode: 'always'}}, stems: ['drums', 'bass']});
    expect(tb.map.isReal).toBe(false);
    const from = tb.now;
    await tb.transport.play();
    expect(tb.snap.phase).toBe('counting');
    expect(tb.engine.countIn).toMatchObject({duration: LEAD_IN_SEC, beats: [], audible: true});
    expect(tb.snap.countdown).toEqual({current: 2, of: 2, label: 'Lead-in · 0:10'});
    tb.advance(1.2);
    expect(tb.snap.countdown.current).toBe(1);
    expect(tb.transport.position()).toBeCloseTo(10 - 2 + (1.2 - tb.engine.lookahead), 2);
    tb.advance(2);
    expect(tb.snap.phase).toBe('playing');
    expect(tb.clicksFrom(from)).toHaveLength(0);
  });

  test('every-pass count is a 2 s preroll gap; rest adds 2 s more', async () => {
    const tb = await bed({fixture: unmapped, raw: {cue: 10, loop: loopAt(10, 14), click: CLICK_ON}, stems: ['drums', 'bass']});
    expect(tb.engine.loopGap).toEqual({sec: 2, mode: 'preroll'});
    tb.transport.setLoopOptions({between: 'rest'});
    expect(tb.engine.loopGap).toEqual({sec: 4, mode: 'preroll'});
  });

  test('a playing jump is immediate; no text says "bar"', async () => {
    const tb = await bed({fixture: unmapped, raw: {cue: 5}, stems: ['drums', 'bass']});
    await tb.transport.play();
    tb.advance(0.5);
    tb.transport.jump(20, {label: 'Marker 2'});
    expect(tb.snap.pendingJump).toBe(null);
    expect(tb.of('jumped')).toEqual([{type: 'jumped', t: 20}]);
    tb.advance(0.2);
    expect(tb.transport.position()).toBeCloseTo(20 + 0.2 - tb.engine.lookahead, 2);
    tb.transport.toggleLoop();
    const texts = [];
    const walk = (v) => { if (typeof v === 'string') texts.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk(tb.snap);
    expect(texts).toContain('0:15.2–0:25.2');
    for (const text of texts) expect(text).not.toMatch(/\bbar\b|Bar/);
  });
});

describe.each(PATHS)('passes on the $name path (rule 7)', ({name, rate}) => {
  afterEach(() => { if (name === 'signalsmith' && current?.engine.stretch) expectCutRule(current.engine); });

  test('a pass is a traversal from a to b; a start inside the loop does not count', async () => {
    const tb = await bed({rate, raw: {cue: 32, loop: loopAt(32, 36)}});
    await tb.transport.play();
    tb.advance(4 / rate + 0.1);
    expect(tb.snap.pass).toBe(1);
    tb.advance(4 / rate);
    expect(tb.snap.pass).toBe(2);
    expect(tb.of('pass').map((e) => e.pass)).toEqual([1, 2]);
    tb.transport.seek(34);                       // mid-loop: the next wrap is not a full pass
    expect(tb.snap.pass).toBe(0);
    tb.advance(2 / rate + 0.1);
    expect(tb.snap.pass).toBe(0);
    tb.advance(4 / rate);
    expect(tb.snap.pass).toBe(1);
  });

  test('stop, a manual speed change, a loop edit and a jump reset the count', async () => {
    const tb = await bed({rate, raw: {cue: 32, loop: loopAt(32, 36)}});
    const run = async () => { tb.advance(4 / tb.engine.rate + 0.1); expect(tb.snap.pass).toBe(1); };
    await tb.transport.play();
    await run();
    tb.transport.setSpeed(0.9);
    expect(tb.snap.pass).toBe(0);
    tb.transport.stop();
    await tb.transport.play();
    await run();
    tb.transport.stop();
    expect(tb.snap.pass).toBe(0);
    await tb.transport.play();
    await run();
    tb.transport.nudgeLoopEdge('b', 1, 'bar');
    expect(tb.snap.pass).toBe(0);
    expect(tb.snap.loop.b).toBe(38);
    tb.transport.stop();
    await tb.transport.play();
    tb.advance(6 / tb.engine.rate + 0.1);
    expect(tb.snap.pass).toBe(1);
    tb.transport.jump(33);
    tb.advance(2 / tb.engine.rate + 0.1);
    expect(tb.of('jumped')).toHaveLength(1);
    expect(tb.snap.pass).toBe(0);
  });
});

describe.each(PATHS)('Play N times on the $name path (rule 8)', ({name, rate}) => {
  afterEach(() => { if (name === 'signalsmith' && current?.engine.stretch) expectCutRule(current.engine); });

  test('stops at b after N passes, returns to the cue and plays no click after b', async () => {
    const tb = await bed({rate, raw: {cue: 32, loop: loopAt(32, 34, {playTimes: 2}), click: {...CLICK_ON, countIn: {...CLICK_ON.countIn, on: false}, mode: 'always'}}});
    expect(tb.snap.passTarget).toBe(2);
    await tb.transport.play();
    const start = tb.now + tb.engine.lookahead;
    const end = start + 4 / rate;
    tb.advance(2 / rate + 0.1);
    expect(tb.snap.pass).toBe(1);
    expect(tb.engine.stopAtWhen).toBeCloseTo(end, 6);
    tb.advance(2 / rate + 0.1);
    expect(tb.snap.phase).toBe('stopped');
    expect(tb.transport.position()).toBe(32);
    expect(tb.snap.cue).toBe(32);
    expect(tb.of('ended')).toEqual([{type: 'ended', reason: 'stopAt'}]);
    expect(tb.statuses.map((s) => s.text)).toContain('Played 2 times');
    expect(tb.clicksFrom(end)).toHaveLength(0);
    expect(tb.engine.master.gain.valueAt(end)).toBe(0);
    expect(tb.engine.aux.gain.calls).toContainEqual(['setValueAtTime', 0, end]);
    expect(tb.clicksFrom(start).length).toBeGreaterThan(4);
  });

  test('a pause does not reset the count; Play N times still stops after a continue', async () => {
    const tb = await bed({rate, raw: {cue: 32, loop: loopAt(32, 34, {playTimes: 2})}});
    await tb.transport.play();
    tb.advance(2 / rate + 0.5);
    expect(tb.snap.pass).toBe(1);
    await tb.transport.pause();
    expect(tb.engine.stopAtWhen).toBe(null);
    await tb.transport.pause();
    expect(tb.snap.pass).toBe(1);
    expect(tb.engine.stopAtWhen).toBeCloseTo(tb.engine.nextWrapAt(), 6);
    tb.advance(2 / rate);
    expect(tb.snap.phase).toBe('stopped');
    expect(tb.snap.cue).toBe(32);
  });

  test('a loop edit after the stop was scheduled cancels it', async () => {
    const tb = await bed({rate, raw: {cue: 32, loop: loopAt(32, 34, {playTimes: 2})}});
    await tb.transport.play();
    tb.advance(2 / rate + 0.1);
    expect(tb.engine.stopAtWhen).not.toBe(null);
    tb.transport.nudgeLoopEdge('b', 1, 'bar');
    expect(tb.engine.stopAtWhen).toBe(null);
    tb.advance(4 / rate);
    expect(tb.snap.phase).toBe('playing');
  });
});

describe('trainer (rule 11)', () => {
  test('advances exactly at the wrap after `passes` passes, completes, and keeps looping at the end rate', async () => {
    const tb = await bed({raw: {cue: 32, loop: loopAt(32, 34)}});
    const {transport, engine} = tb;
    transport.startTrainer({start: 0.7, end: 0.8, step: 0.05, passes: 2});
    expect(tb.snap.trainer).toMatchObject({stepIndex: 0, steps: 3, rate: 0.7, done: false});
    expect(tb.snap.rate).toBe(0.7);
    await transport.play();
    const pass = (r) => 2 / r;
    tb.advance(pass(0.7) + 0.1);
    expect(tb.snap.trainer.passInStep).toBe(1);
    const at = engine.nextWrapAt();
    const scheduled = engine.plan.find((s) => s.scheduled && Math.abs(s.when - at) < 1e-6);
    expect(scheduled).toMatchObject({rate: 0.75});
    expect(engine.rate).toBe(0.7);
    tb.advance(at - tb.now - 0.01);
    expect(engine.rate).toBe(0.7);
    tb.advance(0.04);
    expect(engine.rate).toBe(0.75);
    expect(tb.snap.trainer).toMatchObject({stepIndex: 1, passInStep: 0, rate: 0.75});
    expect(tb.of('trainer').at(-1)).toMatchObject({stepIndex: 1, rate: 0.75, done: false});
    tb.advance(pass(0.75) * 2 + 0.1);
    expect(tb.snap.trainer).toMatchObject({stepIndex: 2, rate: 0.8, done: true});
    expect(tb.statuses.map((s) => s.text)).toContain('Trainer done — 80%');
    tb.advance(pass(0.8) * 2);
    expect(engine.rate).toBe(0.8);
    expect(tb.snap.phase).toBe('playing');
    expectCutRule(engine);
  });

  test('passes = 1 schedules right after each step starts', async () => {
    const tb = await bed({raw: {cue: 32, loop: loopAt(32, 34)}});
    tb.transport.startTrainer({start: 0.7, end: 0.8, step: 0.05, passes: 1});
    await tb.transport.play();
    expect(tb.engine.plan.some((s) => s.scheduled && s.rate === 0.75)).toBe(true);
    tb.advance(2 / 0.7 + 0.1);
    expect(tb.snap.trainer.rate).toBe(0.75);
    expect(tb.engine.plan.some((s) => s.scheduled && s.rate === 0.8)).toBe(true);
  });

  test('a manual speed change stops it ("Trainer stopped"); Stop keeps it and Play resumes the step', async () => {
    const tb = await bed({raw: {cue: 32, loop: loopAt(32, 34)}});
    tb.transport.startTrainer({start: 0.7, end: 1, step: 0.1, passes: 1});
    await tb.transport.play();
    tb.advance(2 / 0.7 + 0.1);
    expect(tb.snap.trainer.stepIndex).toBe(1);
    tb.transport.stop();
    expect(tb.snap.trainer).toMatchObject({stepIndex: 1, passInStep: 0, rate: 0.8});
    await tb.transport.play();
    expect(tb.engine.rate).toBe(0.8);
    tb.advance(0.5);
    tb.transport.setSpeed(0.85);
    expect(tb.snap.trainer).toBe(null);
    expect(tb.statuses.map((s) => s.text)).toContain(COPY.trainerStopped);
    expect(tb.engine.plan.some((s) => s.scheduled && !s.promoted)).toBe(false);
  });

  test('with no loop it first loops the current section, as one undo step (D28)', async () => {
    const tb = await bed({raw: {cue: 20}});
    tb.transport.startTrainer();
    expect(tb.snap.loop).toMatchObject({on: true, a: 16, b: 32, label: 'Verse'});
    expect(tb.snap.trainer).toMatchObject({start: 0.7, end: 1, step: 0.05, passes: 2, steps: 7});
    expect(tb.undo.size.undo).toBe(1);
    tb.undo.undo();
    expect(tb.snap.loop.on).toBe(false);
    expect(tb.snap.trainer).toBe(null);
  });
});

describe.each(PATHS)('quantized jump on the $name path (rule 12, D29)', ({name, rate}) => {
  afterEach(() => { if (name === 'signalsmith' && current?.engine.stretch) expectCutRule(current.engine); });

  /** Playing from `from`, advanced until the playhead reads `at`. */
  async function playingAt(from, at, raw = {}) {
    const tb = await bed({rate, raw: {cue: from, ...raw}});
    await tb.transport.play();
    tb.advance(tb.engine.lookahead + (at - from) / rate);
    expect(tb.transport.position()).toBeCloseTo(at, 2);
    return tb;
  }

  test('stopped, a jump is a cue', async () => {
    const tb = await bed({rate, raw: {cue: 10}});
    tb.transport.jump(40);
    expect(tb.snap.cue).toBe(40);
    expect(tb.snap.phase).toBe('stopped');
  });

  test('lands at the next downbeat', async () => {
    const tb = await playingAt(33, 33.3);
    const downbeat = tb.engine.whenAt(34);
    const pending = tb.transport.jump(50, {label: 'Chorus 2'});
    expect(pending.when).toBeCloseTo(downbeat, 6);
    expect(tb.snap.pendingJump).toMatchObject({t: 50, label: 'Chorus 2'});
    tb.advance(pending.when - tb.now - 0.02);
    expect(tb.transport.position()).toBeLessThan(34);
    expect(tb.of('jumped')).toHaveLength(0);
    tb.advance(0.1);
    expect(tb.of('jumped')).toEqual([{type: 'jumped', t: 50}]);
    expect(tb.snap.pendingJump).toBe(null);
    expect(tb.transport.position()).toBeCloseTo(50 + (tb.now - pending.when) * rate, 3);
  });

  test('too close to the downbeat, it takes the following one', async () => {
    const tb = await playingAt(33, 33.96);
    const following = tb.engine.whenAt(36);
    const pending = tb.transport.jump(50);
    expect(pending.when).toBeCloseTo(following, 6);
  });

  test('in a loop, a wrap that comes before the next downbeat wins', async () => {
    const tb = await playingAt(32, 34.5, {loop: loopAt(32, 35)});
    const wrap = tb.engine.nextWrapAt();
    const pending = tb.transport.jump(33);
    expect(pending.when).toBeCloseTo(wrap, 6);
  });

  test('with no downbeat inside [a, b) it jumps at the wrap', async () => {
    const tb = await playingAt(32, 32.5, {loop: loopAt(32, 34)});
    const wrap = tb.engine.nextWrapAt();
    const pending = tb.transport.jump(33);
    expect(pending.when).toBeCloseTo(wrap, 6);
    tb.advance(wrap - tb.now + 0.1);
    expect(tb.transport.position()).toBeCloseTo(33 + (tb.now - wrap) * rate, 3);
    expect(tb.snap.loop.on).toBe(true);
  });

  test('cancel keeps playing where it was', async () => {
    const tb = await playingAt(33, 33.3);
    const pending = tb.transport.jump(50);
    expect(tb.transport.cancelJump()).toBe(true);
    expect(tb.snap.pendingJump).toBe(null);
    tb.advance(pending.when - tb.now + 0.2);
    expect(tb.of('jumped')).toHaveLength(0);
    expect(tb.transport.position()).toBeGreaterThan(34);
    expect(tb.transport.position()).toBeLessThan(35);
  });

  test('a jump outside the loop clears it on the pending segment: quantized, one undo step', async () => {
    const tb = await playingAt(32, 33.3, {loop: loopAt(32, 36)});
    const steps = tb.undo.size.undo;
    const downbeat = tb.engine.whenAt(34);
    const pending = tb.transport.jump(50);
    expect(pending.when).toBeCloseTo(downbeat, 6);
    expect(tb.engine.loop.enabled).toBe(true);    // audible until the jump
    expect(tb.snap.loop.on).toBe(true);
    tb.advance(pending.when - tb.now + 0.1);
    expect(tb.transport.position()).toBeCloseTo(50 + (tb.now - pending.when) * rate, 3);
    expect(tb.engine.loop.enabled).toBe(false);
    expect(tb.snap.loop.on).toBe(false);
    expect(tb.undo.size.undo).toBe(steps + 1);
    tb.undo.undo();
    expect(tb.snap.loop.on).toBe(true);
    expect(tb.engine.loop).toMatchObject({enabled: true, a: 32, b: 36});
  });

  test('previous and next section are quantized jumps', async () => {
    const tb = await playingAt(20, 20.5);
    const region = tb.transport.goToRegion(1);
    expect(region.label).toBe('Chorus');
    expect(tb.snap.pendingJump).toMatchObject({t: 32, label: 'Chorus'});
    tb.transport.cancelJump();
    expect(tb.transport.goToRegion(-1).label).toBe('Intro');
  });
});

describe.each(PATHS)('call & response on the $name path (rule 10, D17)', ({name, rate}) => {
  afterEach(() => { if (name === 'signalsmith' && current?.engine.stretch) expectCutRule(current.engine); });

  test('passes alternate explicit gains; the first mute lands exactly on pass 2', async () => {
    const tb = await bed({rate, raw: {cue: 32, loop: loopAt(32, 34, {between: 'call'})}});
    const guitar = tb.track('guitar'), drums = tb.track('drums');
    await tb.transport.play();
    const start = tb.now + tb.engine.lookahead;
    const w1 = start + 2 / rate, w2 = w1 + 2 / rate;
    const gain = guitar.auto.gain;
    expect(gain.calls).toContainEqual(['setValueAtTime', 1, tb.now]);
    expect(gain.calls).toContainEqual(['setValueAtTime', 0, w1]);
    expect(gain.valueAt(w1 - 1e-4)).toBe(1);
    expect(gain.valueAt(w1)).toBe(0);
    expect(tb.snap.loop.role).toBe('listen');
    tb.advance(w1 - tb.now + 0.03);
    expect(tb.snap.loop.role).toBe('play');
    expect(gain.valueAt(w2 - 1e-4)).toBe(0);
    expect(gain.valueAt(w2)).toBe(1);             // scheduled one pass ahead
    tb.advance(w2 - tb.now + 0.03);
    expect(tb.snap.loop.role).toBe('listen');
    expect(gain.valueAt(w2 + 2 / rate)).toBe(0);
    expect(drums.auto.gain.calls).toHaveLength(0); // only my stems change
    tb.transport.stop();
    expect(gain.valueAt(tb.now)).toBe(1);          // the engine restores every auto gain
    expect(tb.snap.loop.role).toBe(null);
  });

  test('is refused with no profile stem', async () => {
    const tb = await bed({rate, raw: {cue: 32, loop: loopAt(32, 34)}, account: {...ACCOUNT, profile: {instruments: [], primary: null, openWithMyPart: 'in'}}});
    expect(tb.transport.setLoopOptions({between: 'call'})).toBe(false);
    expect(tb.snap.loop.between).toBe('none');
  });
});

describe('loops (rules 1, 13–16)', () => {
  test('the smart toggle: the current section, else the 4-bar phrase, else ±5 s', async () => {
    let tb = await bed({raw: {cue: 20}});
    tb.transport.toggleLoop();
    expect(tb.snap.loop).toMatchObject({on: true, a: 16, b: 32, label: 'Verse'});
    expect(tb.snap.cue).toBe(16);
    tb.transport.toggleLoop();
    expect(tb.snap.loop.on).toBe(false);
    tb.transport.toggleLoop();                   // a range exists: just toggles
    expect(tb.snap.loop).toMatchObject({on: true, a: 16, b: 32});
    tb.transport.destroy(); tb.metronome.destroy(); tb.engine.destroy(); tb.practice.dispose(); restoreAudio(); vi.useRealTimers();

    tb = await bed({fixture: sevenEight, raw: {cue: 9}, stems: ['drums', 'bass']});
    tb.transport.toggleLoop();
    expect(tb.snap.loop).toMatchObject({on: true, a: 7, b: 14, label: 'Bars 5–8'});
    tb.transport.destroy(); tb.metronome.destroy(); tb.engine.destroy(); tb.practice.dispose(); restoreAudio(); vi.useRealTimers();

    tb = await bed({fixture: unmapped, raw: {cue: 12}, stems: ['drums', 'bass']});
    tb.transport.toggleLoop();
    expect(tb.snap.loop).toMatchObject({on: true, a: 7, b: 17, label: '0:07.0–0:17.0'});
  });

  test('loop this section uses the section, else the marker region on unmapped songs', async () => {
    const tb = await bed({fixture: unmapped, stems: ['drums', 'bass'],
      raw: {cue: 12, markers: [{id: 'm1', t: 10, label: 'Riff', updatedAt: 1}, {id: 'm2', t: 18, label: 'Solo', updatedAt: 1}]}});
    tb.transport.loopSection();
    expect(tb.snap.loop).toMatchObject({on: true, a: 10, b: 18});
  });

  test('I and O snap to the nearest bar line unless exact; the other edge is set 1 bar away', async () => {
    const tb = await bed({raw: {cue: 33.3}});
    tb.transport.loopIn();
    expect(tb.snap.loop).toMatchObject({on: true, a: 34, b: 36});
    tb.transport.cue(41.1);
    tb.transport.loopOut();
    expect(tb.snap.loop).toMatchObject({a: 34, b: 42});
    tb.transport.cue(43.3);
    tb.transport.loopIn({exact: true});
    expect(tb.snap.loop.a).toBe(43.3);
    expect(tb.snap.loop.b).toBe(44);             // 42 became invalid: one bar line on from 43.3
    tb.transport.cue(40.2);
    tb.transport.loopOut({exact: true});
    expect(tb.snap.loop).toMatchObject({a: 40, b: 40.2});
  });

  test('I and O on an unmapped song: 0.1 s snapping, the other edge 4 s away', async () => {
    const tb = await bed({fixture: unmapped, raw: {cue: 12.34}, stems: ['drums', 'bass']});
    tb.transport.loopOut();
    expect(tb.snap.loop).toMatchObject({on: true, a: 8.3, b: 12.3});
  });

  test('I and O while playing use the playhead', async () => {
    const tb = await bed({raw: {cue: 32}});
    await tb.transport.play();
    tb.advance(tb.engine.lookahead + 1.2);
    tb.transport.loopIn({exact: true});
    expect(tb.snap.loop.a).toBeCloseTo(33.2, 2);
  });

  test('move by length shifts by b − a, clamps, and recomputes the bar refs', async () => {
    const tb = await bed({raw: {loop: loopAt(32, 36)}});
    tb.transport.moveLoop(1);
    expect(tb.snap.loop).toMatchObject({a: 36, b: 40, aBar: {id: 'g18', beat: 0, frac: 0}, bBar: {id: 'g20', beat: 0, frac: 0}});
    tb.transport.loopRange(2, 6);
    tb.transport.moveLoop(-1);
    expect(tb.snap.loop).toMatchObject({a: 0, b: 4});
  });

  test('edge nudges: bar or beat when mapped; 0.1 s, 50 ms or 10 ms when unmapped; the 20 ms minimum holds', async () => {
    let tb = await bed({raw: {loop: loopAt(32, 36)}});
    tb.transport.nudgeLoopEdge('a', -1, 'bar');
    expect(tb.snap.loop.a).toBe(30);
    tb.transport.nudgeLoopEdge('b', -1, 'beat');
    expect(tb.snap.loop.b).toBe(35.5);
    tb.transport.destroy(); tb.metronome.destroy(); tb.engine.destroy(); tb.practice.dispose(); restoreAudio(); vi.useRealTimers();

    tb = await bed({fixture: unmapped, stems: ['drums', 'bass'], raw: {loop: loopAt(10, 10.05)}});
    tb.transport.nudgeLoopEdge('b', 1, 'tenth');
    expect(tb.snap.loop.b).toBeCloseTo(10.15, 6);
    tb.transport.nudgeLoopEdge('b', -1, '50ms');
    expect(tb.snap.loop.b).toBeCloseTo(10.1, 6);
    tb.transport.nudgeLoopEdge('a', 1, '10ms');
    expect(tb.snap.loop.a).toBeCloseTo(10.01, 6);
    expect(tb.transport.nudgeLoopEdge('a', 1, '50ms')).toBe(true);    // 40 ms left
    expect(tb.transport.nudgeLoopEdge('a', 1, '50ms')).toBe(false);   // would leave less than 20 ms
    expect(tb.snap.loop.a).toBeCloseTo(10.06, 6);
  });

  test('clear loop is undoable and leaves the cue; loop edits push one step each', async () => {
    const tb = await bed({raw: {cue: 5}});
    tb.transport.loopRange(32, 36);
    tb.transport.cue(50);
    tb.transport.clearLoop();
    expect(tb.snap.loop).toMatchObject({on: false});
    expect(tb.snap.cue).toBe(50);
    const entry = tb.undo.undo();
    expect(entry.describe()).toBe('loop Bars 17–18 → off');
    expect(tb.snap.loop).toMatchObject({on: true, a: 32, b: 36});
    expect(tb.engine.loop).toMatchObject({enabled: true, a: 32, b: 36});
  });

  test('extend loop to here takes in the bar at t', async () => {
    const tb = await bed({raw: {loop: loopAt(32, 36)}});
    tb.transport.extendLoopTo(41);
    expect(tb.snap.loop).toMatchObject({a: 32, b: 42});
    tb.transport.extendLoopTo(29);
    expect(tb.snap.loop).toMatchObject({a: 28, b: 42});
  });

  test('loop bars from a bar', async () => {
    const tb = await bed();
    tb.transport.loopBars(41, 4);
    expect(tb.snap.loop).toMatchObject({on: true, a: 40, b: 48});
  });
});

describe('speed (rule 17)', () => {
  test('clamped to 25–150%, rounded to 0.01; ` toggles 100% and the last other rate', async () => {
    const tb = await bed();
    tb.transport.setSpeed(0.1);
    expect(tb.snap.rate).toBe(0.25);
    expect(tb.engine.rate).toBe(0.25);
    tb.transport.setSpeed(0.854);
    expect(tb.snap.rate).toBe(0.85);
    tb.transport.setSpeed(9);
    expect(tb.snap.rate).toBe(1.5);
    tb.transport.setSpeed(0.8);
    tb.transport.toggleSpeed100();
    expect(tb.snap).toMatchObject({rate: 1, lastRate: 0.8});
    tb.transport.toggleSpeed100();
    expect(tb.snap.rate).toBe(0.8);
    tb.transport.nudgeSpeed(-5);
    expect(tb.snap.rate).toBe(0.75);
    tb.transport.nudgeSpeed(1);
    expect(tb.snap.rate).toBe(0.76);
  });

  test('changes within 1 s coalesce into one undo step; undo restores the engine rate', async () => {
    const tb = await bed();
    tb.transport.setSpeed(0.95);
    tb.advance(0.3);
    tb.transport.setSpeed(0.9);
    tb.advance(0.3);
    tb.transport.setSpeed(0.85);
    expect(tb.undo.size.undo).toBe(1);
    tb.advance(1.5);
    tb.transport.setSpeed(0.8);
    expect(tb.undo.size.undo).toBe(2);
    tb.undo.undo();
    const entry = tb.undo.undo();
    expect(entry.describe()).toBe('speed 100% → 85%');
    expect(tb.snap.rate).toBe(1);
    expect(tb.engine.rate).toBe(1);
  });

  test('keep pitch is per song and switches the processing path', async () => {
    const tb = await bed({rate: 0.8});
    expect(tb.snap.keepPitch).toBe(true);
    expect(tb.engine.preservePitch).toBe(true);
    tb.transport.setKeepPitch(false);
    expect(tb.engine.preservePitch).toBe(false);
    expect(tb.practice.value.peek().keepPitch).toBe(false);
    tb.undo.undo();
    expect(tb.engine.preservePitch).toBe(true);
  });
});

describe('click and count-in (D14)', () => {
  test('C toggles count-in; K toggles always and the last other mode; the first change writes the whole click', async () => {
    const tb = await bed();
    expect(tb.practice.value.peek().click).toBeUndefined();
    expect(tb.snap.countIn).toEqual({on: false, length: 1, unit: 'bars'});
    tb.transport.toggleCountIn();
    expect(tb.practice.value.peek().click).toEqual({countIn: {on: true, length: 1, unit: 'bars'}, mode: 'countin', lastMode: 'countin', accent: true, volume: 0.7, preRoll: false});
    expect(tb.metronome.countIn).toBe(true);
    tb.transport.setClickMode('off');
    tb.transport.toggleClick();
    expect(tb.snap.click.mode).toBe('always');
    expect(tb.metronome.enabled).toBe(true);
    tb.transport.toggleClick();
    expect(tb.snap.click.mode).toBe('off');
    tb.transport.setCountIn({length: 2, unit: 'beats'});
    expect(tb.metronome.settings()).toMatchObject({countIn: true, countInLength: 2, countInUnit: 'beats', mode: 'off'});
  });

  test('the account default applies while the song has no click', async () => {
    const tb = await bed({account: {...ACCOUNT, practice: {...ACCOUNT.practice, countIn: {on: true, length: 2, unit: 'bars'}, click: 'always'}}});
    expect(tb.snap.countIn).toEqual({on: true, length: 2, unit: 'bars'});
    expect(tb.snap.click.mode).toBe('always');
    expect(tb.metronome.settings()).toMatchObject({countIn: true, countInLength: 2, mode: 'always'});
  });

  test('a count-in uses the plan at the start target, not the playhead', async () => {
    const tb = await bed({fixture: sevenEight, stems: ['drums', 'bass'], raw: {cue: 3.5, click: CLICK_ON}});
    await tb.transport.play();
    expect(tb.engine.countIn.target).toBe(3.5);
    expect(tb.engine.countIn.duration).toBeCloseTo(1.75, 6);    // one 7/8 bar
    expect(tb.engine.countIn.beats.map((b) => b.unit)).toEqual([0, 2, 4]);
  });
});

describe('mix (rule 18)', () => {
  test('mute and solo by canonical index, not row order', async () => {
    const tb = await bed({stems: ['vocals', 'other', 'drums', 'bass']});
    expect(tb.snap.mix.tracks.map((t) => t.name)).toEqual(['drums', 'bass', 'vocals', 'other']);
    tb.transport.toggleMuteAt(0);
    expect(tb.track('drums').muted).toBe(true);
    tb.transport.toggleSoloAt(2);
    expect(tb.track('vocals').soloed).toBe(true);
    expect(tb.snap.mix.tracks.map((t) => [t.name, t.muted, t.soloed])).toEqual([['drums', true, false], ['bass', false, false], ['vocals', false, true], ['other', false, false]]);
  });

  test('Minus me mutes my stems; on a song without my stem it mutes Other and says so', async () => {
    let tb = await bed();
    expect(tb.snap.mix.mine).toEqual(['guitar']);
    expect(tb.transport.minusMe()).toBe(true);
    expect(tb.track('guitar').muted).toBe(true);
    expect(tb.snap.mix.minusMe).toBe(true);
    expect(tb.statuses).toHaveLength(0);
    tb.transport.minusMe();
    expect(tb.track('guitar').muted).toBe(false);
    tb.transport.destroy(); tb.metronome.destroy(); tb.engine.destroy(); tb.practice.dispose(); restoreAudio(); vi.useRealTimers();

    const resplit = vi.fn();
    tb = await bed({stems: ['drums', 'bass', 'vocals', 'other'], resplit});
    tb.transport.minusMe(true);
    expect(tb.track('other').muted).toBe(true);
    expect(tb.statuses).toHaveLength(1);
    expect(tb.statuses[0].text).toBe("This song wasn't split with a guitar part. Muting Other instead.");
    expect(tb.statuses[0].action.label).toBe('Re-split with 6 stems');
    tb.statuses[0].action.run();
    expect(resplit).toHaveBeenCalledTimes(1);
    tb.transport.destroy(); tb.metronome.destroy(); tb.engine.destroy(); tb.practice.dispose(); restoreAudio(); vi.useRealTimers();

    tb = await bed({stems: ['drums', 'bass', 'vocals', 'other']});
    tb.transport.minusMe(true);
    expect(tb.statuses[0].text).toBe("This song wasn't split with a guitar part. Muting Other instead. Re-split it from Woodshed for desktop.");
    expect(tb.statuses[0].action).toBeUndefined();
  });

  test('with no matching stem, Minus me asks for the Mix sheet and returns false', async () => {
    const tb = await bed({stems: ['drums', 'no_drums'], account: {...ACCOUNT, profile: {instruments: ['bass'], primary: 'bass', openWithMyPart: 'in'}}});
    expect(tb.transport.minusMe()).toBe(false);
    expect(tb.of('mix-sheet')).toEqual([{type: 'mix-sheet', reason: 'no-part'}]);
    expect(tb.undo.size.undo).toBe(0);
  });

  test('Only me solos my stems; Full mix resets everything as one undo step', async () => {
    const tb = await bed();
    tb.transport.setVolume('drums', 0.5);
    tb.transport.minusMe(true);
    tb.transport.onlyMe(true);
    expect(tb.track('guitar')).toMatchObject({soloed: true, muted: false});
    expect(tb.snap.mix).toMatchObject({onlyMe: true, minusMe: false});
    const steps = tb.undo.size.undo;
    tb.transport.fullMix();
    expect(tb.undo.size.undo).toBe(steps + 1);
    expect(tb.engine.tracks.every((t) => t.volume === 1 && !t.muted && !t.soloed)).toBe(true);
    expect(tb.snap.mix).toMatchObject({minusMe: false, onlyMe: false});
    const entry = tb.undo.undo();
    expect(entry.describe()).toBe('mix guitar solo → full mix');
    expect(tb.track('guitar').soloed).toBe(true);
  });

  test('levels coalesce per stem; chart audio reaches the notation session', async () => {
    const tb = await bed();
    tb.transport.setVolume('bass', 0.9);
    tb.advance(0.2);
    tb.transport.setVolume('bass', 0.6);
    expect(tb.undo.size.undo).toBe(1);
    expect(tb.track('bass').volume).toBe(0.6);
    expect(tb.undo.undo().describe()).toBe('bass level 100% → 60%');
    expect(tb.track('bass').volume).toBe(1);
  });

  test('"open with my part Out" is not an undo step', async () => {
    const tb = await bed();
    tb.transport.minusMe(true, {undoable: false});
    expect(tb.track('guitar').muted).toBe(true);
    expect(tb.undo.size.undo).toBe(0);
  });
});

describe('chart audio', () => {
  test('setChartAudio stores the level and calls the notation session', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    restoreAudio = installFakeAudio();
    createClock();
    const engine = new MultitrackEngine();
    await loadFakeStems(engine, ['drums', 'bass'], {duration: 128});
    const map = mapStore(sectioned);
    const metronome = new Metronome(engine, map);
    const practice = createPracticeState({songId: 's', raw: {v: 2}, duration: 128, persist: async () => {}});
    const position = createPositionModel({map, practice});
    const notation = {setChartAudio: vi.fn()};
    const transport = createTransport({engine, metronome, map, position, practice, undo: createPracticeUndo(), account: ACCOUNT, notation: () => notation});
    current = {transport, metronome, engine, practice, position};
    expect(notation.setChartAudio).toHaveBeenCalledWith('off');
    transport.setChartAudio('loud');
    expect(notation.setChartAudio).toHaveBeenLastCalledWith('loud');
    expect(practice.value.peek().chartAudio).toBe('loud');
    expect(transport.snapshot.peek().mix.chartAudio).toBe('loud');
  });
});

describe('spot counters (§2.14.1, session wiring as ST1b builds it)', () => {
  test('the active spot gains one pass per wrap and loses its active state on a loop edit', async () => {
    const spot = {id: 'spot-1', name: 'Chorus lick', a: 32, b: 34, rate: 1, passes: 3, updatedAt: 1};
    const tb = await bed({raw: {cue: 32, loop: loopAt(32, 34), spots: [spot]}});
    // The session rule: on each pass while the loop equals the active spot, touch it.
    tb.transport.on('pass', () => {
      const id = tb.practice.activeSpotId.peek(), s = tb.practice.value.peek().spots.find((x) => x.id === id && !x.deleted);
      const loop = tb.practice.value.peek().loop;
      if (s && Math.abs(s.a - loop.a) <= 1e-3 && Math.abs(s.b - loop.b) <= 1e-3) tb.practice.touchSpot(id, {passes: 1});
    });
    tb.practice.activeSpotId.value = 'spot-1';
    await tb.transport.play();
    tb.advance(2 + 0.1);
    tb.advance(2);
    const passes = () => tb.practice.value.peek().spots.find((s) => s.id === 'spot-1').passes;
    expect(passes()).toBe(5);
    tb.transport.nudgeLoopEdge('b', 1, 'bar');
    expect(tb.practice.activeSpotId.peek()).toBe(null);
    tb.advance(4);
    expect(passes()).toBe(5);
  });
});

describe('seeks, cues and navigation (rules 3, 20, 23)', () => {
  test('seeks never move the cue; a mouse seek while playing is immediate', async () => {
    const tb = await bed({raw: {cue: 10}});
    await tb.transport.play();
    tb.advance(0.5);
    tb.transport.seek(60);
    expect(tb.snap.cue).toBe(10);
    tb.advance(0.2);
    expect(tb.transport.position()).toBeCloseTo(60 + 0.2 - tb.engine.lookahead, 2);
    tb.transport.seek(70, {cue: true});
    expect(tb.snap.cue).toBe(70);
    tb.transport.step('bar', 1);
    expect(tb.snap.cue).toBe(70);
    tb.transport.stop();
    expect(tb.transport.position()).toBe(70);
  });

  test('stopped: steps, nudges, Home and End move the cue', async () => {
    const tb = await bed({raw: {cue: 33}});
    tb.transport.step('bar', 1);
    expect(tb.snap.cue).toBe(34);
    tb.transport.step('beat', -1);
    expect(tb.snap.cue).toBe(33.5);
    tb.transport.nudgeCue(50);
    expect(tb.snap.cue).toBeCloseTo(33.55, 6);
    tb.transport.home();
    expect(tb.snap.cue).toBe(0);
    tb.transport.end();
    expect(tb.snap.cue).toBe(128);
    tb.transport.loopRange(32, 36);
    tb.transport.end();
    expect(tb.snap.cue).toBe(36);
    tb.transport.home();
    expect(tb.snap.cue).toBe(32);
    tb.transport.cue(41.3, {snap: 'beat'});
    expect(tb.snap.cue).toBe(41.5);
  });

  test('Space during a count cancels; Space while playing stops; otherwise plays', async () => {
    const tb = await bed({raw: {cue: 32, click: CLICK_ON}});
    await tb.transport.playStop();
    expect(tb.snap.phase).toBe('counting');
    await tb.transport.playStop();
    expect(tb.snap.phase).toBe('stopped');
    tb.transport.toggleCountIn();
    await tb.transport.playStop();
    expect(tb.snap.phase).toBe('playing');
    await tb.transport.playStop();
    expect(tb.snap.phase).toBe('stopped');
  });

  test('an interruption pauses, keeps the position as the cue, says so and never resumes by itself', async () => {
    const tb = await bed({raw: {cue: 10}});
    await tb.transport.play();
    tb.advance(1);
    tb.engine.ctx.setState('interrupted');       // the engine pauses itself; PL1 then calls interrupt()
    const at = tb.engine.pausedAt;
    expect(tb.transport.interrupt('audio')).toBe(true);
    expect(tb.snap.phase).toBe('paused');
    expect(tb.snap.cue).toBeCloseTo(at, 6);
    expect(tb.statuses.at(-1).text).toBe('Paused — audio was interrupted. Press Play to continue.');
    expect(tb.of('interrupted')).toEqual([{type: 'interrupted', reason: 'audio'}]);
    tb.engine.ctx.setState('running');
    tb.advance(1);
    expect(tb.snap.phase).toBe('paused');
  });

  test('the song ending stops at the cue and reports ended', async () => {
    const tb = await bed({raw: {cue: 127}});
    await tb.transport.play();
    tb.advance(1.2);
    expect(tb.snap.phase).toBe('stopped');
    expect(tb.transport.position()).toBe(127);
    expect(tb.of('ended')).toEqual([{type: 'ended', reason: 'end'}]);
  });
});

describe('account changes', () => {
  test('a profile change reaches "mine" and the snapshot', async () => {
    const {signal} = await import('../src/app/store.js');
    const account = signal({...ACCOUNT, profile: {instruments: ['drums'], primary: 'drums', openWithMyPart: 'in'}});
    const tb = await bed({account});
    expect(tb.snap.mix.mine).toEqual(['drums']);
    account.value = {...ACCOUNT, profile: {instruments: ['bass', 'vocals'], primary: 'bass', openWithMyPart: 'in'}};
    expect(tb.snap.mix.mine).toEqual(['bass', 'vocals']);
    tb.transport.minusMe(true);
    expect(tb.track('bass').muted && tb.track('vocals').muted).toBe(true);
  });

  test('the account module shape ({value: signal}) is read too', async () => {
    const {signal, readonly} = await import('../src/app/store.js');
    const value = signal({...ACCOUNT, practice: {...ACCOUNT.practice, stop: 'stay'}});
    const tb = await bed({account: {value: readonly(value), patch: vi.fn()}});
    await tb.transport.play();
    tb.advance(1);
    tb.transport.stop();
    expect(tb.snap.cue).toBeGreaterThan(0.5);
  });
});

describe('before the engine is ready (§2.14.1 step 4)', () => {
  test('changes queue and apply on ready; Play arms "Play when ready"', async () => {
    const tb = await bed({load: false, raw: {cue: 12}});
    expect(tb.snap.phase).toBe('loading');
    expect(tb.transport.position()).toBe(12);
    tb.transport.setSpeed(0.9);
    tb.transport.loopRange(32, 36);
    tb.transport.minusMe(true);
    expect(tb.snap.mix.mine).toEqual(['guitar']);  // from the song's stem names before the engine has tracks
    const promise = tb.transport.playStop();
    expect(tb.of('gesture')).toHaveLength(1);
    expect(tb.snap.armed).toBe(true);
    await promise;
    expect(tb.engine.playing).toBe(false);
    await tb.load();
    expect(tb.snap.phase).toBe('playing');
    expect(tb.snap.armed).toBe(false);
    expect(tb.engine.rate).toBe(0.9);
    expect(tb.engine.loop).toMatchObject({enabled: true, a: 32, b: 36});
    expect(tb.transport.position()).toBeCloseTo(32, 2);
    expect(tb.of('gesture')).toHaveLength(1);
  });

  test('pressing Play again while armed disarms', async () => {
    const tb = await bed({load: false});
    tb.transport.playStop();
    tb.transport.playStop();
    expect(tb.snap.armed).toBe(false);
    await tb.load();
    expect(tb.snap.phase).toBe('stopped');
  });
});

describe('start over', () => {
  test('cue 0, loop off and 100% as one undo step', async () => {
    const tb = await bed({raw: {cue: 40, rate: 0.75, loop: loopAt(32, 36)}});
    tb.transport.startOver();
    expect(tb.snap).toMatchObject({cue: 0, rate: 1});
    expect(tb.snap.loop.on).toBe(false);
    expect(tb.undo.size.undo).toBe(1);
    tb.undo.undo();
    expect(tb.snap).toMatchObject({cue: 40, rate: 0.75});
    expect(tb.snap.loop.on).toBe(true);
  });
});
