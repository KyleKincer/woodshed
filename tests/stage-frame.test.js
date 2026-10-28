import {describe, expect, test, vi} from 'vitest';
import {createFrameBus, readFrame} from '../src/stage/frame.js';
import {mapStore, sectioned, unmapped} from './fixtures/maps.js';

/** Hand-driven rAF: frames run only when the test says so. */
function frames(frameMs = 1000 / 60) {
  let t = 0, nextId = 1;
  const queue = new Map();
  return {
    raf: vi.fn((fn) => { const id = nextId++; queue.set(id, fn); return id; }),
    caf: vi.fn((id) => { queue.delete(id); }),
    now: () => t,
    get pending() { return queue.size; },
    step(n = 1) {
      for (let i = 0; i < n; i++) {
        t += frameMs;
        const due = [...queue.values()];
        queue.clear();
        for (const fn of due) fn(t);
      }
    },
  };
}

function fakeSession({fixture = sectioned, phase = 'playing', position = 33} = {}) {
  const state = {phase, position};
  return {
    state,
    session: {
      engine: {ctx: {currentTime: 12.5}},
      map: mapStore(fixture),
      transport: {
        position: () => state.position,
        snapshot: {peek: () => ({phase: state.phase}), get value() { return {phase: state.phase}; }},
      },
    },
  };
}

/** A minimal visibility target (EventTarget) and a mutable hidden flag. */
function page() {
  const target = new EventTarget();
  let hidden = false;
  return {
    target, isHidden: () => hidden,
    hide() { hidden = true; target.dispatchEvent(new Event('visibilitychange')); },
    show() { hidden = false; target.dispatchEvent(new Event('visibilitychange')); },
  };
}

function bus(options = {}) {
  const f = frames(options.frameMs);
  const p = page();
  const {session, state} = fakeSession(options);
  const b = createFrameBus({session, raf: f.raf, caf: f.caf, now: f.now, isHidden: p.isHidden, visibility: p.target});
  return {f, p, b, session, state};
}

describe('readFrame', () => {
  test('mapped: ctx time, position, phase flags and the bar', () => {
    const {session} = fakeSession({phase: 'counting', position: 33});
    const frame = readFrame(session);
    expect(frame).toMatchObject({now: 12.5, position: 33, playing: false, counting: true});
    expect(frame.bar).toMatchObject({index: 16, display: 17, beat: 3});
  });

  test('unmapped: no bar', () => {
    const {session} = fakeSession({fixture: unmapped, position: 3});
    expect(readFrame(session)).toEqual({now: 12.5, position: 3, playing: true, counting: false, bar: null});
  });
});

describe('createFrameBus', () => {
  test('one rAF loop delivers frames to every subscriber after start()', () => {
    const {f, b, state} = bus();
    const a = vi.fn(), c = vi.fn();
    b.subscribe(a);
    b.subscribe(c);
    f.step(3);
    expect(a).not.toHaveBeenCalled();       // not started
    expect(f.pending).toBe(0);
    b.start();
    expect(f.pending).toBe(1);              // one loop, not one per subscriber
    f.step();
    state.position = 34;
    f.step();
    expect(a).toHaveBeenCalledTimes(2);
    expect(c).toHaveBeenCalledTimes(2);
    expect(a.mock.calls[0][0]).toBe(c.mock.calls[0][0]);   // one frame object per tick
    expect(Object.isFrozen(a.mock.calls[0][0])).toBe(true);
    expect(a.mock.calls[1][0].position).toBe(34);
  });

  test('hz: 30 subscribers get every second frame at 60 Hz, and every fourth at 120 Hz', () => {
    const {f, b} = bus();
    const fast = vi.fn(), text = vi.fn();
    b.subscribe(fast);
    b.subscribe(text, {hz: 30});
    b.start();
    f.step(60);
    expect(fast).toHaveBeenCalledTimes(60);
    expect(text).toHaveBeenCalledTimes(30);

    const hi = bus({frameMs: 1000 / 120});
    const sixty = vi.fn(), thirty = vi.fn();
    hi.b.subscribe(sixty);
    hi.b.subscribe(thirty, {hz: 30});
    hi.b.start();
    hi.f.step(120);
    expect(sixty).toHaveBeenCalledTimes(60);
    expect(thirty).toHaveBeenCalledTimes(30);
  });

  test('off() removes a subscriber; with none left the loop idles', () => {
    const {f, b} = bus();
    const fn = vi.fn();
    const off = b.subscribe(fn);
    b.start();
    f.step();
    off();
    expect(f.pending).toBe(0);
    f.step(5);
    expect(fn).toHaveBeenCalledTimes(1);
    b.subscribe(fn);
    expect(f.pending).toBe(1);
  });

  test('a subscriber removed by another during a tick is not called', () => {
    const {f, b} = bus();
    let offSecond;
    const first = vi.fn(() => offSecond());
    const second = vi.fn();
    b.subscribe(first);
    offSecond = b.subscribe(second);
    b.start();
    f.step();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  test('stop() cancels the pending frame; start() resumes', () => {
    const {f, b} = bus();
    const fn = vi.fn();
    b.subscribe(fn);
    b.start();
    b.stop();
    expect(f.caf).toHaveBeenCalledTimes(1);
    expect(f.pending).toBe(0);
    f.step(3);
    expect(fn).not.toHaveBeenCalled();
    b.start();
    b.start();                             // idempotent: still one loop
    expect(f.pending).toBe(1);
    f.step();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(b.running).toBe(true);
  });

  test('the bus stops while the page is hidden and resumes when it is visible', () => {
    const {f, p, b} = bus();
    const fn = vi.fn();
    b.subscribe(fn);
    b.start();
    f.step(2);
    p.hide();
    expect(f.pending).toBe(0);
    f.step(10);
    expect(fn).toHaveBeenCalledTimes(2);
    p.show();
    expect(f.pending).toBe(1);
    f.step(1);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('a hidden page at start requests no frame; a tick that finds the page hidden stops', () => {
    const {f, p, b} = bus();
    const fn = vi.fn();
    b.subscribe(fn);
    p.hide();
    b.start();
    expect(f.raf).not.toHaveBeenCalled();
    p.show();
    f.step();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('one throwing subscriber does not stop the others or the loop', () => {
    const {f, b} = bus();
    const errors = [];
    const original = globalThis.reportError;
    globalThis.reportError = (err) => errors.push(err);
    try {
      const good = vi.fn();
      b.subscribe(() => { throw new Error('boom'); });
      b.subscribe(good);
      b.start();
      f.step(2);
      expect(good).toHaveBeenCalledTimes(2);
      expect(errors.map((e) => e.message)).toEqual(['boom', 'boom']);
    } finally {
      globalThis.reportError = original;
    }
  });

  test('destroy() stops for good and drops the visibility listener', () => {
    const {f, p, b} = bus();
    b.subscribe(vi.fn());
    b.start();
    b.destroy();
    p.show();
    expect(f.pending).toBe(0);
    expect(b.running).toBe(false);
  });

  test('defaults read requestAnimationFrame and document.hidden at call time', () => {
    const queue = [];
    const raf = globalThis.requestAnimationFrame, caf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (fn) => queue.push(fn);
    globalThis.cancelAnimationFrame = () => {};
    try {
      const {session} = fakeSession();
      const b = createFrameBus({session, visibility: null});
      const fn = vi.fn();
      b.subscribe(fn);
      b.start();
      expect(queue).toHaveLength(1);
      queue.shift()(0);
      expect(fn).toHaveBeenCalledTimes(1);
      b.destroy();
    } finally {
      globalThis.requestAnimationFrame = raf;
      globalThis.cancelAnimationFrame = caf;
    }
  });

  test('subscribe requires a function', () => {
    expect(() => bus().b.subscribe(null)).toThrow(TypeError);
  });
});
