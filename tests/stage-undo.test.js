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
