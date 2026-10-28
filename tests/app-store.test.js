import {describe, expect, test, vi} from 'vitest';
import {batch, computed, effect, readonly, signal, store, untracked} from '../src/app/store.js';

describe('signal', () => {
  test('value, peek, update and equality', () => {
    const s = signal(1);
    expect(s.value).toBe(1);
    expect(s.peek()).toBe(1);
    s.value = 2;
    s.update(v => v * 10);
    expect(s.value).toBe(20);
    const runs = vi.fn();
    effect(() => { runs(s.value); });
    s.value = 20;                        // Object.is: no change, no run
    expect(runs).toHaveBeenCalledTimes(1);
    const obj = signal({a: 1}, {equals: (a, b) => a.a === b.a});
    const seen = vi.fn();
    effect(() => seen(obj.value));
    obj.value = {a: 1};
    expect(seen).toHaveBeenCalledTimes(1);
    obj.value = {a: 2};
    expect(seen).toHaveBeenCalledTimes(2);
  });

  test('subscribe fires on changes only, with (value, previous), and off() stops it', () => {
    const s = signal('a');
    const fn = vi.fn();
    const off = s.subscribe(fn);
    expect(fn).not.toHaveBeenCalled();
    s.value = 'b';
    expect(fn).toHaveBeenLastCalledWith('b', 'a');
    off();
    s.value = 'c';
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('readonly() exposes value/peek/subscribe without a setter', () => {
    const s = signal(1);
    const r = readonly(s);
    expect(r.value).toBe(1);
    s.value = 2;
    expect(r.peek()).toBe(2);
    expect(() => { r.value = 3; }).toThrow(TypeError);
    expect(r.update).toBeUndefined();
  });
});

describe('computed', () => {
  test('is lazy, cached, and recomputes only when a dependency changed', () => {
    const a = signal(1), b = signal(2);
    const fn = vi.fn(() => a.value + b.value);
    const sum = computed(fn);
    expect(fn).not.toHaveBeenCalled();
    expect(sum.value).toBe(3);
    expect(sum.value).toBe(3);
    expect(fn).toHaveBeenCalledTimes(1);
    a.value = 5;
    expect(fn).toHaveBeenCalledTimes(1);   // still lazy while unobserved
    expect(sum.value).toBe(7);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(() => { sum.value = 1; }).toThrow(TypeError);
  });

  test('a chain stops propagating when an intermediate value is unchanged', () => {
    const n = signal(1);
    const parity = computed(() => n.value % 2);
    const label = vi.fn(() => (parity.value ? 'odd' : 'even'));
    const text = computed(label);
    const seen = vi.fn();
    effect(() => seen(text.value));
    expect(seen).toHaveBeenCalledTimes(1);
    n.value = 3;                            // parity stays 1
    expect(label).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledTimes(1);
    n.value = 4;
    expect(seen).toHaveBeenLastCalledWith('even');
  });

  test('errors are cached and rethrown on read; recovery clears them', () => {
    const s = signal(0);
    const c = computed(() => { if (s.value === 0) throw new Error('zero'); return 10 / s.value; });
    expect(() => c.value).toThrow('zero');
    expect(() => c.peek()).toThrow('zero');
    s.value = 2;
    expect(c.value).toBe(5);
  });

  test('writing a signal inside computed() throws; cycles are detected', () => {
    const s = signal(0);
    const bad = computed(() => { s.value = 1; return 1; });
    expect(() => bad.value).toThrow(/inside computed/);
    let loop;
    loop = computed(() => loop.value + 1);
    expect(() => loop.value).toThrow(/cycle/);
  });
});

describe('effect', () => {
  test('a first run that writes what it read re-runs after it returns, and every cleanup runs once, in order', () => {
    const s = signal(0);
    const runs = [], cleaned = [];
    const off = effect(() => {
      const v = s.value;
      runs.push(v);
      if (v < 2) s.value = v + 1;
      return () => cleaned.push(v);
    });
    expect(runs).toEqual([0, 1, 2]);
    expect(cleaned).toEqual([0, 1]);
    off();
    expect(cleaned).toEqual([0, 1, 2]);
  });

  test("a first run's writes run other effects after it, not inside it", () => {
    const b = signal(0);
    const log = [];
    effect(() => { log.push(`E2 ${b.value}`); });
    effect(() => { log.push('E1 start'); b.value = 1; log.push('E1 end'); });
    expect(log).toEqual(['E2 0', 'E1 start', 'E1 end', 'E2 1']);
  });

  test('an effect created inside a batch first runs at once; its writes wait for the batch', () => {
    const b = signal(0);
    const log = [];
    effect(() => { log.push(`E2 ${b.value}`); });
    batch(() => {
      effect(() => { log.push('E1'); b.value = 1; });
      log.push('batch end');
    });
    expect(log).toEqual(['E2 0', 'E1', 'batch end', 'E2 1']);
  });

  test('runs now and on change; glitch-free across a diamond', () => {
    const a = signal(1);
    const double = computed(() => a.value * 2);
    const triple = computed(() => a.value * 3);
    const seen = [];
    effect(() => { seen.push([a.value, double.value, triple.value]); });
    a.value = 2;
    expect(seen).toEqual([[1, 2, 3], [2, 4, 6]]);   // never [2, 2, 3] or a double run
  });

  test('effects run in scheduling order, once per change', () => {
    const s = signal(0);
    const order = [];
    effect(() => { s.value; order.push('first'); });
    effect(() => { s.value; order.push('second'); });
    effect(() => { s.value; order.push('third'); });
    order.length = 0;
    s.value = 1;
    expect(order).toEqual(['first', 'second', 'third']);
  });

  test('cleanup runs before each re-run and on dispose; dispose stops it', () => {
    const s = signal(1);
    const log = [];
    const dispose = effect(() => {
      const v = s.value;
      log.push(`run ${v}`);
      return () => log.push(`cleanup ${v}`);
    });
    s.value = 2;
    dispose();
    s.value = 3;
    dispose();   // idempotent
    expect(log).toEqual(['run 1', 'cleanup 1', 'run 2', 'cleanup 2']);
  });

  test('a write inside an effect re-runs dependants after it, in the same flush', () => {
    const source = signal(1);
    const mirror = signal(0);
    const seen = [];
    effect(() => { mirror.value = source.value * 100; });
    effect(() => { seen.push(mirror.value); });
    source.value = 2;
    expect(seen).toEqual([100, 200]);
  });

  test('an effect that keeps re-triggering itself is stopped with an error', () => {
    const s = signal(0);
    expect(() => {
      effect(() => { s.value = s.value + 1; });
      s.value = 100;
    }).toThrow(/cycle/);
  });

  test('a throwing effect does not stop the others; the error surfaces after the flush', () => {
    const s = signal(0);
    const after = vi.fn();
    effect(() => { if (s.value === 1) throw new Error('boom'); });
    effect(() => { after(s.value); });
    expect(() => { s.value = 1; }).toThrow('boom');
    expect(after).toHaveBeenLastCalledWith(1);
  });

  test('untracked reads do not subscribe', () => {
    const a = signal(1), b = signal(1);
    const runs = vi.fn();
    effect(() => { a.value; untracked(() => b.value); runs(); });
    b.value = 2;
    expect(runs).toHaveBeenCalledTimes(1);
    a.value = 2;
    expect(runs).toHaveBeenCalledTimes(2);
  });

  test('disposing inside its own run cleans up and never runs again', () => {
    const s = signal(0);
    const runs = vi.fn();
    const cleanup = vi.fn();
    let dispose = null;
    dispose = effect(() => {
      runs(s.value);
      if (s.value === 1) dispose();
      return cleanup;
    });
    s.value = 1;
    expect(cleanup).toHaveBeenCalledTimes(2);   // before the second run, and on its own dispose
    s.value = 2;
    expect(runs).toHaveBeenCalledTimes(2);
  });
});

describe('batch', () => {
  test('defers effects to the end and runs each once', () => {
    const a = signal(1), b = signal(1);
    const seen = [];
    effect(() => { seen.push(a.value + b.value); });
    const result = batch(() => {
      a.value = 2;
      b.value = 3;
      expect(seen).toEqual([2]);
      return 'done';
    });
    expect(result).toBe('done');
    expect(seen).toEqual([2, 5]);
  });

  test('nested batches flush only at the outermost end', () => {
    const s = signal(0);
    const seen = vi.fn();
    effect(() => seen(s.value));
    batch(() => {
      batch(() => { s.value = 1; });
      expect(seen).toHaveBeenCalledTimes(1);
      s.value = 2;
    });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenLastCalledWith(2);
  });

  test('a throwing batch still flushes what it wrote and rethrows', () => {
    const s = signal(0);
    const seen = vi.fn();
    effect(() => seen(s.value));
    expect(() => batch(() => { s.value = 5; throw new Error('fail'); })).toThrow('fail');
    expect(seen).toHaveBeenLastCalledWith(5);
  });

  test('a batch whose writes cancel out runs nothing', () => {
    const s = signal(1);
    const seen = vi.fn();
    effect(() => seen(s.value));
    batch(() => { s.value = 2; s.value = 1; });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('no leaks', () => {
  test('a disposed effect releases its computed, which then stops listening upstream', () => {
    const s = signal(0);
    const fn = vi.fn(() => s.value * 2);
    const c = computed(fn);
    const dispose = effect(() => { c.value; });
    expect(fn).toHaveBeenCalledTimes(1);
    s.value = 1;
    expect(fn).toHaveBeenCalledTimes(2);   // live: recomputed for the effect
    dispose();
    for (let i = 2; i < 200; i++) s.value = i;
    expect(fn).toHaveBeenCalledTimes(2);   // released: nothing upstream holds it
    expect(c.value).toBe(398);              // still correct on demand
  });

  test('dependencies an effect stops reading are dropped', () => {
    const flag = signal(true), a = signal(0), b = signal(0);
    const runs = vi.fn();
    effect(() => { runs(); return flag.value ? a.value : b.value; });
    flag.value = false;
    expect(runs).toHaveBeenCalledTimes(2);
    a.value = 1;                     // no longer read
    expect(runs).toHaveBeenCalledTimes(2);
    b.value = 1;
    expect(runs).toHaveBeenCalledTimes(3);
  });

  test('subscribe/off pairs leave no listener behind', () => {
    const s = signal(0);
    const c = computed(() => s.value + 1);
    const spies = Array.from({length: 50}, () => vi.fn());
    const offs = spies.map(spy => c.subscribe(spy));
    offs.forEach(off => off());
    s.value = 1;
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });
});

describe('store', () => {
  test('has the §2.2 slices with their initial values', () => {
    expect(store.session.peek()).toEqual({user: null, admin: false, status: 'active', online: true});
    expect(store.config.peek()).toBeNull();
    expect(store.account.peek()).toBeNull();
    expect(store.library.songs.peek()).toBeInstanceOf(Map);
    expect(store.library.loaded.peek()).toBe(false);
    for (const key of ['jobs', 'uploads', 'devices', 'setlists']) expect(store.library[key].peek()).toEqual([]);
    expect(store.processor.peek()).toEqual({phase: 'web'});
    expect(store.update.peek()).toEqual({status: 'idle'});
    expect(store.stage.peek()).toBeNull();
    expect(store.pendingAccount.peek()).toBeNull();
    expect(store.prefs.peek().v).toBe(1);   // defaults (no storage in this environment)
    expect(store.prefs).toBe(store.prefs);  // one signal
  });
});
