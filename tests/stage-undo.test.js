import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createPracticeUndo, undidMessage, redidMessage, UNDO_LIMIT, COALESCE_MS} from '../src/stage/undo.js';
import {clock} from '../src/app/clock.js';
import {FAKE_TIMERS} from './helpers/fake-audio.js';

const pct = (r) => `${Math.round(r * 100)}%`;

/** A tiny practice stand-in: undo entries apply values to it. */
function harness(options) {
  const undo = createPracticeUndo(options);
  const state = {rate: 1, loop: null, level: {drums: 1}};
  const setRate = (from, to) => {
    state.rate = to;
    return undo.push({key: 'speed', label: 'speed', from, to, describe: (a, b) => `speed ${pct(a)} → ${pct(b)}`,
      apply: (v) => { state.rate = v; }});
  };
  return {undo, state, setRate};
}

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
  clock.set();
});
afterEach(() => { clock.reset(); vi.useRealTimers(); });

describe('value entries', () => {
  test('undo applies from, redo applies to, and the signals follow', () => {
    const {undo, state, setRate} = harness();
    expect(undo.canUndo.value).toBe(false);
    setRate(1, 0.85);
    expect(undo.canUndo.value).toBe(true);
    expect(undo.canRedo.value).toBe(false);
    const entry = undo.undo();
    expect(state.rate).toBe(1);
    expect(entry.describe()).toBe('speed 100% → 85%');
    expect(undidMessage(entry)).toBe('Undid: speed 100% → 85%');
    expect(undo.canUndo.value).toBe(false);
    expect(undo.canRedo.value).toBe(true);
    expect(redidMessage(undo.redo())).toBe('Redid: speed 100% → 85%');
    expect(state.rate).toBe(0.85);
    expect(undo.undo()).toBe(entry);
    expect(undo.undo()).toBe(null);
  });

  test('pushes with the same key within 1 s coalesce on the fake clock, keeping the first from', () => {
    const {undo, state, setRate} = harness();
    setRate(1, 0.95);
    vi.advanceTimersByTime(400);
    setRate(0.95, 0.9);
    vi.advanceTimersByTime(999);       // the window slides with each push
    const entry = setRate(0.9, 0.85);
    expect(undo.size.undo).toBe(1);
    expect(entry.from).toBe(1);
    expect(entry.to).toBe(0.85);
    expect(entry.describe()).toBe('speed 100% → 85%');
    vi.advanceTimersByTime(COALESCE_MS + 1);
    setRate(0.85, 0.8);
    expect(undo.size.undo).toBe(2);
    undo.undo();
    expect(state.rate).toBe(0.85);
    undo.undo();
    expect(state.rate).toBe(1);
  });

  test('different keys never coalesce, and neither do pushes after an undo', () => {
    const {undo, state, setRate} = harness();
    setRate(1, 0.9);
    undo.push({key: 'level:drums', label: 'drums level', from: 1, to: 0.5, apply: (v) => { state.level.drums = v; }});
    expect(undo.size.undo).toBe(2);
    undo.undo();
    setRate(0.9, 0.8);               // the speed step on top is older than the undo: a new step
    expect(undo.size.undo).toBe(2);
    expect(undo.canRedo.value).toBe(false);   // a new push clears redo
  });

  test('only speed and level:<stem> coalesce by default; loop, markers, spots, mix, section, startOver never do', () => {
    const undo = createPracticeUndo();
    let markers = [];
    const setMarkers = (to) => { const from = markers; markers = to; undo.push({key: 'markers', label: 'marker', from, to, apply: (v) => { markers = v; }}); };
    setMarkers(['m1']);
    vi.advanceTimersByTime(400);
    setMarkers(['m1', 'm2']);                     // S pressed twice quickly: two steps
    vi.advanceTimersByTime(200);
    for (const key of ['loop', 'spots', 'mix', 'section', 'startOver']) {
      undo.push({key, label: key, from: 1, to: 2, apply() {}});
      vi.advanceTimersByTime(100);
      undo.push({key, label: key, from: 2, to: 3, apply() {}});
      vi.advanceTimersByTime(100);
    }
    expect(undo.size.undo).toBe(12);
    for (let i = 0; i < 10; i++) undo.undo();
    undo.undo();
    expect(markers).toEqual(['m1']);
    undo.undo();
    expect(markers).toEqual([]);

    const levels = createPracticeUndo();
    levels.push({key: 'level:drums', label: 'drums', from: 1, to: 0.8, apply() {}});
    vi.advanceTimersByTime(300);
    levels.push({key: 'level:drums', label: 'drums', from: 0.8, to: 0.6, apply() {}});
    expect(levels.size.undo).toBe(1);
  });

  test('the coalesce option overrides the default per push', () => {
    const {undo, setRate} = harness();
    setRate(1, 0.9);
    vi.advanceTimersByTime(200);
    undo.push({key: 'speed', label: 'speed', from: 0.9, to: 0.8, coalesce: false, apply() {}});   // setSpeed(r, {coalesce: false})
    expect(undo.size.undo).toBe(2);
    vi.advanceTimersByTime(200);
    setRate(0.8, 0.7);                            // a coalescing push does not merge into a non-coalescing step
    expect(undo.size.undo).toBe(3);
    vi.advanceTimersByTime(200);
    undo.push({key: 'loop', label: 'loop', from: 1, to: 2, coalesce: true, apply() {}});
    vi.advanceTimersByTime(200);
    undo.push({key: 'loop', label: 'loop', from: 2, to: 3, coalesce: true, apply() {}});
    expect(undo.size.undo).toBe(4);
  });

  test('a coalesced run that returns to its start removes the step; a no-op push adds nothing', () => {
    const {undo, setRate} = harness();
    setRate(1, 0.9);
    expect(setRate(0.9, 1)).toBe(null);
    expect(undo.canUndo.value).toBe(false);
    expect(setRate(1, 1)).toBe(null);
    expect(undo.push({key: 'loop', label: 'loop', from: {on: true, a: 1}, to: {on: true, a: 1}, apply() {}})).toBe(null);
    expect(undo.size.undo).toBe(0);
  });

  test('describe falls back to the label', () => {
    const {undo} = harness();
    const entry = undo.push({key: 'loop', label: 'loop', from: null, to: {a: 0, b: 4}, apply() {}});
    expect(entry.describe()).toBe('loop');
    expect(undidMessage(entry)).toBe('Undid: loop');
  });

  test('pushes made while an undo is applying are ignored', () => {
    const undo = createPracticeUndo();
    let rate = 1;
    const apply = (v) => {
      rate = v;
      undo.push({key: 'speed', label: 'speed', from: 0, to: v, apply});   // a careless apply re-pushing
    };
    undo.push({key: 'speed', label: 'speed', from: 1, to: 0.5, apply});
    undo.undo();
    expect(rate).toBe(1);
    expect(undo.size).toEqual({undo: 0, redo: 1});
  });

  test('apply is required', () => {
    expect(() => createPracticeUndo().push({key: 'x', from: 1, to: 2})).toThrow(TypeError);
  });
});

describe('the cap', () => {
  test(`keeps the latest ${UNDO_LIMIT} steps`, () => {
    const {undo, state} = harness();
    for (let i = 0; i < 60; i++) {
      undo.pushAction({key: 'loop', label: `step ${i}`, undo: () => { state.loop = i - 1; }, redo: () => { state.loop = i; }});
    }
    expect(undo.size.undo).toBe(50);
    let last;
    for (let entry; (entry = undo.undo());) last = entry;
    expect(last.label).toBe('step 10');
    expect(state.loop).toBe(9);
    expect(undo.size).toEqual({undo: 0, redo: 50});
  });

  test('limit is configurable', () => {
    const undo = createPracticeUndo({limit: 2});
    for (let i = 0; i < 3; i++) undo.pushAction({key: 'k', label: String(i), undo() {}, redo() {}});
    expect(undo.size.undo).toBe(2);
  });
});

describe('action entries and amend', () => {
  test('pushAction runs undo/redo and never coalesces', () => {
    const undo = createPracticeUndo();
    const calls = [];
    undo.pushAction({key: 'map', label: 'Bars found', undo: () => calls.push('undo1'), redo: () => calls.push('redo1')});
    undo.pushAction({key: 'map', label: 'Rename', describe: () => 'rename Chorus → Hook', undo: () => calls.push('undo2'), redo: () => calls.push('redo2')});
    expect(undo.size.undo).toBe(2);
    expect(undidMessage(undo.undo())).toBe('Undid: rename Chorus → Hook');
    expect(undidMessage(undo.undo())).toBe('Undid: Bars found');
    undo.redo();
    expect(calls).toEqual(['undo2', 'undo1', 'redo1']);
  });

  test('amend: undo runs the new undo then the old; redo the old then the new', () => {
    const undo = createPracticeUndo();
    const calls = [];
    const entry = undo.pushAction({key: 'map', label: 'Tap the beat', undo: () => calls.push('map-undo'), redo: () => calls.push('map-redo')});
    undo.amend(entry, {label: 'Tap the beat and turn markers into sections', undo: () => calls.push('markers-undo'), redo: () => calls.push('markers-redo')});
    expect(undo.size.undo).toBe(1);
    expect(undo.undo().describe()).toBe('Tap the beat and turn markers into sections');
    expect(calls).toEqual(['markers-undo', 'map-undo']);
    undo.redo();
    expect(calls).toEqual(['markers-undo', 'map-undo', 'map-redo', 'markers-redo']);
  });

  test('an amended value entry is no longer a coalescing target', () => {
    const {undo, state, setRate} = harness();
    const entry = setRate(1, 0.9);
    const extra = [];
    undo.amend(entry, {undo: () => extra.push('u'), redo: () => extra.push('r')});
    setRate(0.9, 0.8);
    expect(undo.size.undo).toBe(2);
    undo.undo(); undo.undo();
    expect(state.rate).toBe(1);
    expect(extra).toEqual(['u']);
  });

  test('pushAction requires undo and redo; amend requires an entry', () => {
    const undo = createPracticeUndo();
    expect(() => undo.pushAction({key: 'x', undo() {}})).toThrow(TypeError);
    expect(() => undo.amend(null, {undo() {}, redo() {}})).toThrow(TypeError);
  });
});

test('clear empties both stacks', () => {
  const {undo, setRate} = harness();
  setRate(1, 0.5);
  vi.advanceTimersByTime(2000);
  setRate(0.5, 0.6);
  undo.undo();
  undo.clear();
  expect(undo.canUndo.value).toBe(false);
  expect(undo.canRedo.value).toBe(false);
  expect(undo.size).toEqual({undo: 0, redo: 0});
});

test('an injected clock drives coalescing', () => {
  let t = 0;
  const undo = createPracticeUndo({clock: {now: () => t}, coalesceMs: 100});
  const push = (from, to) => undo.push({key: 'speed', from, to, apply() {}});
  push(1, 0.9); t = 100; push(0.9, 0.8); t = 201; push(0.8, 0.7);
  expect(undo.size.undo).toBe(2);
});

describe('gesture-bounded steps (beginGesture, ticket I2a-1)', () => {
  /** A speed push that carries a gesture token, like transport.setSpeed(rate, {gesture}). */
  const gestureRate = (undo, state, gesture) => (from, to) => {
    state.rate = to;
    return undo.push({key: 'speed', label: 'speed', from, to, gesture,
      describe: (a, b) => `speed ${pct(a)} → ${pct(b)}`, apply: (v) => { state.rate = v; }});
  };

  test('a drag that pauses longer than coalesceMs is still one undo step', () => {
    const {undo, state} = harness();
    const token = undo.beginGesture('speed');
    expect(token.active).toBe(true);
    const drag = gestureRate(undo, state, token);
    drag(1, 0.95);
    vi.advanceTimersByTime(COALESCE_MS * 3);   // the finger rests mid-drag
    drag(0.95, 0.9);
    vi.advanceTimersByTime(COALESCE_MS + 1);
    const entry = drag(0.9, 0.8);
    token.end();
    expect(token.active).toBe(false);
    expect(undo.size.undo).toBe(1);
    expect(entry.from).toBe(1);
    expect(entry.to).toBe(0.8);
    expect(undidMessage(undo.undo())).toBe('Undid: speed 100% → 80%');
    expect(state.rate).toBe(1);
    expect(undo.canUndo.value).toBe(false);
    undo.redo();
    expect(state.rate).toBe(0.8);
  });

  test('the first push of a gesture never merges into an earlier entry (a +/− tap just before stays its own step)', () => {
    const {undo, state, setRate} = harness();
    setRate(1, 0.95);                           // a stepper tap, coalescing by default
    vi.advanceTimersByTime(100);                // well inside coalesceMs
    const token = undo.beginGesture('speed');
    const drag = gestureRate(undo, state, token);
    drag(0.95, 0.9);
    drag(0.9, 0.85);
    token.end();
    expect(undo.size.undo).toBe(2);
    undo.undo();
    expect(state.rate).toBe(0.95);
    undo.undo();
    expect(state.rate).toBe(1);
  });

  test('after end() the next push starts a new entry, with or without the token', () => {
    const {undo, state, setRate} = harness();
    const token = undo.beginGesture('speed');
    const drag = gestureRate(undo, state, token);
    drag(1, 0.9);
    token.end();
    token.end();                                // idempotent
    vi.advanceTimersByTime(50);
    setRate(0.9, 0.85);                         // a tap right after the drag: its own step
    expect(undo.size.undo).toBe(2);
    drag(0.85, 0.8);                            // the ended token is ignored: normal rules
    expect(undo.size.undo).toBe(2);             // …so it coalesces with the tap, not the drag
    undo.undo();
    expect(state.rate).toBe(0.9);
    undo.undo();
    expect(state.rate).toBe(1);
  });

  test('a push without the token never merges into an open gesture', () => {
    const {undo, state, setRate} = harness();
    const token = undo.beginGesture('speed');
    const drag = gestureRate(undo, state, token);
    drag(1, 0.9);
    setRate(0.9, 0.85);
    expect(undo.size.undo).toBe(2);
    drag(0.85, 0.8);                            // another step came between: a fresh entry
    drag(0.8, 0.75);
    token.end();
    expect(undo.size.undo).toBe(3);
    expect(undo.undo().describe()).toBe('speed 85% → 75%');
  });

  test('a gesture that returns to where it started leaves no step', () => {
    const {undo, state} = harness();
    const token = undo.beginGesture('speed');
    const drag = gestureRate(undo, state, token);
    drag(1, 0.9);
    vi.advanceTimersByTime(COALESCE_MS * 2);
    expect(drag(0.9, 1)).toBe(null);
    expect(undo.size.undo).toBe(0);
    expect(undo.canUndo.value).toBe(false);
    drag(1, 1.1);                               // still the same gesture: one fresh step
    drag(1.1, 1.2);
    token.end();
    expect(undo.size.undo).toBe(1);
    expect(undo.undo().describe()).toBe('speed 100% → 120%');
  });

  test('gesture pushes merge even for keys that do not coalesce by default; an undo mid-gesture closes the entry', () => {
    const undo = createPracticeUndo();
    let v = 0;
    const token = undo.beginGesture('loop');
    const set = (from, to) => { v = to; return undo.push({key: 'loop', from, to, gesture: token, apply: (x) => { v = x; }}); };
    set(0, 1);
    set(1, 2);
    expect(undo.size.undo).toBe(1);
    undo.undo();
    expect(v).toBe(0);
    set(0, 3);
    set(3, 4);
    expect(undo.size).toEqual({undo: 1, redo: 0});
    undo.undo();
    expect(v).toBe(0);
  });

  test('a token for another key or another stack is ignored', () => {
    const {undo, state, setRate} = harness();
    const other = createPracticeUndo().beginGesture('speed');
    const wrongKey = undo.beginGesture('level:drums');
    setRate(1, 0.9);
    vi.advanceTimersByTime(COALESCE_MS + 1);
    gestureRate(undo, state, other)(0.9, 0.8);
    vi.advanceTimersByTime(COALESCE_MS + 1);
    gestureRate(undo, state, wrongKey)(0.8, 0.7);
    expect(undo.size.undo).toBe(3);
  });
});
