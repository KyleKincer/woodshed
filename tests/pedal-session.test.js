// @vitest-environment happy-dom
// The scripted 10-minute pedal-only session (architecture §9 PD1, §10 "Pedal session test"; spec §13 milestone
// "a 10-minute pedal-only trainer session with no touches"). A real session (tests/helpers/test-session.js: SongMapStore,
// Metronome, MultitrackEngine on the fake audio clock, transport, practice state) behind the real transport commands,
// the real dispatcher and pedal mode with three learned pedals on a Custom profile. Only pedal key events drive it:
//   right tap  Play/Stop           right hold  Next section
//   left tap   Again               left hold   Previous section
//   pedal 3 tap  Loop toggle       pedal 3 hold  Start the speed trainer (the custom binding)
// The trainer then climbs every step on the looped section; the passes it counts must match, and no pointer, mouse,
// touch or click event may occur anywhere in the ten minutes.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {createRegistry} from '../src/app/commands.js';
import {startDispatcher} from '../src/app/dispatch.js';
import {clock as appClock} from '../src/app/clock.js';
import {signal} from '../src/app/store.js';
import {HOLD_MS, PEDAL_SOURCE, startPedals} from '../src/app/pedals.js';
import {defineTransportCommands} from '../src/stage/transport-commands.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession} from './helpers/test-session.js';

const SESSION_SEC = 600;
const SECTION_SEC = 16;          // tests/fixtures/maps.js `sectioned`: 64 bars of 4/4 at 120 bpm, a section every 8 bars
const BAR_SEC = 2;
const PEDALS = Object.freeze([
  {slot: 'left', code: 'PageUp', canHold: true},
  {slot: 'right', code: 'PageDown', canHold: true},
  {slot: 'p3', code: 'KeyT', canHold: true},
]);
const CUSTOM = Object.freeze({
  left: {tap: 'transport.again', hold: 'nav.prevSection'},
  right: {tap: 'transport.playStop', hold: 'nav.nextSection'},
  p3: {tap: 'transport.loopToggle', hold: 'trainer.toggle'},
});
const KEY = {PageUp: 'PageUp', PageDown: 'PageDown', KeyT: 't'};
const POINTER_EVENTS = ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'contextmenu'];

let clock, restoreAudio, current = [];

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(Date.parse('2026-10-29T19:00:00Z'));
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
});

afterEach(async () => {
  for (const off of current.splice(0).reverse()) await off();
  delete document.documentElement.dataset.posture;
  restoreAudio();
  vi.useRealTimers();
});

describe('a 10-minute pedal-only practice session', () => {
  test('pedals alone: play, sections, again, loop and the trainer through every step, with no pointer event', async () => {
    const ts = await createTestSession({clock});
    const reg = createRegistry();
    current.push(async () => { off(); await ts.dispose(); });
    const off = defineTransportCommands({registry: reg, sheets: {}});
    reg.provide('session', () => ts.session);
    reg.provide('transport', () => ts.session.transport);
    reg.provide('stage', () => ({openSheet: () => ({close() {}}), anchors: new Map(), setlist: signal(null)}));
    reg.provide('posture', () => 'stage');
    reg.provide('place', () => 'stage');
    current.push(startDispatcher({target: window, registry: reg}));
    const prefs = {value: signal({pedals: {enabled: true, profile: 'custom', pedals: PEDALS, custom: CUSTOM}})};
    const fired = [];
    current.push(startPedals({registry: reg, prefs, onFire: (id, d) => fired.push({id, gesture: d.gesture, ran: d.ran})}));

    const pointer = [];
    const onPointer = e => pointer.push(e.type);
    for (const type of POINTER_EVENTS) window.addEventListener(type, onPointer, true);
    current.push(() => { for (const type of POINTER_EVENTS) window.removeEventListener(type, onPointer, true); });

    let elapsed = 0;
    const wait = async sec => {
      // Small audio steps, so the transport's loop wrap and pass counting run as in playback.
      for (let left = sec; left > 1e-9; left -= 0.25) {
        const step = Math.min(0.25, left);
        await ts.advance(step);
        elapsed += step;
      }
    };
    const sendKey = (type, code, repeat = false) => {
      const e = new KeyboardEvent(type, {code, key: KEY[code], repeat, bubbles: true, cancelable: true});
      document.body.dispatchEvent(e);
      expect(e.defaultPrevented, `${type} ${code} is the pedal’s`).toBe(true);
    };
    const tap = async code => { sendKey('keydown', code); await wait(0.08); sendKey('keyup', code); await wait(0.1); };
    const hold = async code => { sendKey('keydown', code); await wait(HOLD_MS / 1000 + 0.15); sendKey('keyup', code); await wait(0.1); };
    const snap = () => ts.snapshot;
    const at = () => ts.transport.position();

    // 1. Right tap: Play.
    await tap('PageDown');
    await wait(2);
    expect(snap().phase).toBe('playing');
    expect(at()).toBeGreaterThan(1.5);

    // 2. Right hold: the next section (16 s), landing on the next bar line while playing; left hold: back again.
    await wait(3);
    await hold('PageDown');
    await wait(BAR_SEC + 0.5);
    expect(at()).toBeGreaterThanOrEqual(SECTION_SEC);
    expect(at()).toBeLessThan(SECTION_SEC + BAR_SEC * 2);
    await wait(4);
    const later = at();
    await hold('PageUp');
    await wait(BAR_SEC + 0.5);
    const back = at();
    expect(back).toBeLessThan(later - 2);
    await hold('PageDown');
    await wait(BAR_SEC + 0.5);
    expect(at()).toBeGreaterThan(back + SECTION_SEC / 2);

    // 3. Left tap: Again, from the cue.
    await wait(5);
    const before = at();
    await tap('PageUp');
    expect(snap().phase).toBe('playing');
    expect(at()).toBeLessThan(before - 4);

    // 4. Pedal 3 tap: loop the section we are in; pedal 3 hold: start the trainer (the custom binding).
    await tap('KeyT');
    expect(snap().loop.on).toBe(true);
    const loop = {a: snap().loop.a, b: snap().loop.b};
    expect(loop.b - loop.a).toBeGreaterThan(1);
    await hold('KeyT');
    expect(snap().trainer).toBeTruthy();
    const trainer = snap().trainer;
    const passesAtStart = ts.passes();
    const steps = ts.of('trainer');
    expect(steps.at(-1)).toMatchObject({stepIndex: 0, done: false});
    expect(snap().rate).toBeCloseTo(0.7, 5);

    // 5. Practise until the ten minutes are up; the trainer climbs every step on its own.
    while (elapsed < SESSION_SEC - 1) await wait(Math.min(5, SESSION_SEC - 1 - elapsed));
    const climbs = ts.of('trainer');
    const last = climbs.at(-1);
    expect(last.done).toBe(true);
    expect(snap().rate).toBeCloseTo(1, 5);
    const indexes = climbs.map(e => e.stepIndex);
    expect(indexes.slice(indexes.lastIndexOf(0))).toEqual([...Array(last.stepIndex + 1).keys()]);
    // 0.70 → 1.00 in 0.05 steps is seven rates; two passes at each before stepping up.
    expect(last.stepIndex).toBe(6);
    // The trainer counts its passes right: `passes` loop passes at each of the six lower rates, then the last step.
    // At a loop wrap the transport emits the step-up ('trainer') before that wrap's 'pass'.
    const startAt = ts.events.findLastIndex(e => e.type === 'trainer' && e.stepIndex === 0);
    const doneAt = ts.events.findIndex(e => e.type === 'trainer' && e.done);
    expect(ts.events[doneAt + 1]?.type).toBe('pass');
    const passesToDone = ts.events.slice(startAt, doneAt + 2).filter(e => e.type === 'pass').length;
    expect(passesToDone).toBe(last.stepIndex * trainer.passes);
    for (let i = 1; i <= last.stepIndex; i++) {
      const from = ts.events.findIndex(e => e.type === 'trainer' && e.stepIndex === i - 1 && ts.events.indexOf(e) >= startAt);
      const to = ts.events.findIndex(e => e.type === 'trainer' && e.stepIndex === i && ts.events.indexOf(e) >= startAt);
      // Step i - 1 runs from the wrap that started it (its own 'pass' belongs to the step before) to the wrap that ends it.
      const begin = from + (i === 1 ? 1 : 2);
      expect(ts.events.slice(begin, to + 2).filter(e => e.type === 'pass').length, `passes at step ${i - 1}`).toBe(trainer.passes);
    }
    // It keeps looping at full speed for the rest of the ten minutes.
    expect(ts.passes() - passesAtStart).toBeGreaterThan(passesToDone);
    expect(snap().loop.on).toBe(true);
    expect(snap().phase).toBe('playing');

    // 6. Right tap: Stop.
    await tap('PageDown');
    expect(snap().phase).not.toBe('playing');
    expect(elapsed).toBeGreaterThanOrEqual(SESSION_SEC - 1);

    // Every command came from a pedal and ran; nothing touched the screen.
    expect(fired.every(f => f.ran)).toBe(true);
    expect(fired.map(f => `${f.id}:${f.gesture}`)).toEqual([
      'transport.playStop:tap', 'nav.nextSection:hold', 'nav.prevSection:hold', 'nav.nextSection:hold', 'transport.again:tap',
      'transport.loopToggle:tap', 'trainer.toggle:hold', 'transport.playStop:tap',
    ]);
    expect(pointer).toEqual([]);
    expect(PEDAL_SOURCE).toBe('pedal');
  }, 120_000);
});
