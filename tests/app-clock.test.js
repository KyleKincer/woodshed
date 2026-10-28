import {afterEach, expect, test, vi} from 'vitest';
import clockDefault, {advance, clock, now, reset, set} from '../src/app/clock.js';

afterEach(() => { reset(); vi.useRealTimers(); });

test('now() reads the real clock by default', () => {
  const before = Date.now();
  const t = now();
  expect(t).toBeGreaterThanOrEqual(before);
  expect(t).toBeLessThanOrEqual(Date.now());
  expect(clockDefault).toBe(clock);
  expect(clock.now).toBe(now);
});

test('fake timers apply without wiring because Date.now() is read at call time', () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']});
  vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
  expect(now()).toBe(Date.parse('2026-10-28T12:00:00Z'));
  vi.advanceTimersByTime(250);
  expect(now()).toBe(Date.parse('2026-10-28T12:00:00Z') + 250);
  set();   // the mandated reset (§11.3) keeps following the faked Date
  expect(now()).toBe(Date.parse('2026-10-28T12:00:00Z') + 250);
});

test('set(ms | Date | ISO) freezes the clock and advance() moves it', () => {
  set(1000);
  expect(now()).toBe(1000);
  expect(now()).toBe(1000);
  advance(25);
  expect(now()).toBe(1025);
  set(new Date('2026-01-02T03:04:05.000Z'));
  expect(now()).toBe(Date.parse('2026-01-02T03:04:05.000Z'));
  set('2026-10-28T09:00:00Z');   // the fixture's fx-now form
  expect(now()).toBe(Date.parse('2026-10-28T09:00:00Z'));
  advance(-500);
  expect(now()).toBe(Date.parse('2026-10-28T09:00:00Z') - 500);
});

test('set(value, {ticking}) starts at an instant and runs with real time', () => {
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(50_000);
  set(10, {ticking: true});
  expect(now()).toBe(10);
  vi.setSystemTime(50_400);
  expect(now()).toBe(410);
});

test('set(fn) installs a custom source; set() and reset() restore the real clock', () => {
  let t = 7;
  set(() => t);
  expect(now()).toBe(7);
  t = 9;
  expect(now()).toBe(9);
  advance(1);
  expect(now()).toBe(10);
  set();
  expect(Math.abs(now() - Date.now())).toBeLessThan(50);
  set(5);
  reset();
  expect(Math.abs(now() - Date.now())).toBeLessThan(50);
});

test('bad input throws instead of silently corrupting time', () => {
  expect(() => set('not a date')).toThrow(TypeError);
  expect(() => advance(Number.NaN)).toThrow(TypeError);
  expect(Object.isFrozen(clock)).toBe(true);
});
