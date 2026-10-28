// @vitest-environment node
// tests/fixture/early.js, the classic script that runs before theme-init:
// fx-reset, fx-prefs, the legacy ws.* switches, fx-now and window.__FIXTURE__.
import {describe, it, expect, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../early.js', import.meta.url), 'utf8');

class MemoryStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  toJSON() { return Object.fromEntries(this.map); }
}

function run(search, {local = {}, session = {}, RealDate = Date} = {}) {
  const win = {
    location: {search}, localStorage: new MemoryStorage(local), sessionStorage: new MemoryStorage(session),
    console: {error: vi.fn(), warn: vi.fn()}, Date: RealDate, URLSearchParams, JSON, Object, Array, Reflect, isFinite,
  };
  win.window = win;
  vm.runInNewContext(SOURCE, win);
  return win;
}

describe('early.js', () => {
  it('marks the page as the fixture and records the switches', () => {
    const win = run('?fx-desktop=1&song=x');
    expect(win.__FIXTURE__).toBe(true);
    expect(win.__FIXTURE_EARLY__.fx).toEqual({desktop: '1'});
    expect(win.Date).toBe(Date);
  });
  it('fx-reset=1 clears the persisted db and every ws.* key, and nothing else', () => {
    const win = run('?fx-reset=1', {local: {'ws.prefs': '{}', 'ws.theme': 'dark', other: '1'}, session: {'fx-db': '{}', 'ws.intendedRoute': '/s/x', keep: '1'}});
    expect(win.localStorage.toJSON()).toEqual({other: '1'});
    expect(win.sessionStorage.toJSON()).toEqual({keep: '1'});
  });
  it('without fx-reset nothing is cleared (other tabs keep their prefs)', () => {
    const win = run('', {local: {'ws.prefs': '{"v":1}'}, session: {'fx-db': '{}'}});
    expect(win.localStorage.getItem('ws.prefs')).toBe('{"v":1}');
    expect(win.sessionStorage.getItem('fx-db')).toBe('{}');
  });
  it('fx-prefs deep-merges into ws.prefs and adds v: 1', () => {
    const json = encodeURIComponent(JSON.stringify({theme: 'dark', practice: {distance: 'kit'}}));
    const win = run(`?fx-prefs=${json}`, {local: {'ws.prefs': JSON.stringify({v: 1, theme: 'light', practice: {focus: true, distance: 'stand'}, stage: 'match'})}});
    expect(JSON.parse(win.localStorage.getItem('ws.prefs'))).toEqual({v: 1, theme: 'dark', practice: {focus: true, distance: 'kit'}, stage: 'match'});
    expect(JSON.parse(run(`?fx-prefs=${json}`).localStorage.getItem('ws.prefs'))).toEqual({theme: 'dark', practice: {distance: 'kit'}, v: 1});
  });
  it('a bad fx-prefs is reported as a console error and writes nothing', () => {
    for (const bad of ['{nope', '[1,2]', '"text"']) {
      const win = run(`?fx-prefs=${encodeURIComponent(bad)}`);
      expect(win.console.error).toHaveBeenCalledWith(expect.stringContaining('fx-prefs must be a JSON object'));
      expect(win.localStorage.getItem('ws.prefs')).toBeNull();
    }
  });
  it('fx-prefs runs after fx-reset, so a reset run can still seed prefs', () => {
    const win = run(`?fx-reset=1&fx-prefs=${encodeURIComponent('{"theme":"dark"}')}`, {local: {'ws.prefs': '{"v":1,"stage":"match"}'}});
    expect(JSON.parse(win.localStorage.getItem('ws.prefs'))).toEqual({theme: 'dark', v: 1});
  });
  it('writes the 1.9 keys for fx-view, fx-practice, fx-overview and fx-notation', () => {
    const win = run('?fx-view=artists-list&fx-practice=chart&fx-overview=1&fx-notation=lanes');
    expect(win.localStorage.toJSON()).toEqual({'ws.view': '{"group":"artists","layout":"list"}', 'ws.practice.view': 'chart', 'ws.overview': '1', 'ws.notation.layout': 'lanes'});
    expect(JSON.parse(run('?fx-view=albums').localStorage.getItem('ws.view'))).toEqual({group: 'albums', layout: 'grid'});
  });
  it('unavailable storage is a warning, not a failure', () => {
    const refuse = () => { throw new Error('SecurityError'); };
    const blocked = {length: 0, key: () => null, getItem: refuse, setItem: refuse, removeItem: refuse};
    const win = {location: {search: '?fx-reset=1'}, localStorage: blocked, sessionStorage: blocked, console: {error: vi.fn(), warn: vi.fn()}, Date, URLSearchParams, JSON, Object, Array, Reflect, isFinite};
    win.window = win;
    expect(() => vm.runInNewContext(SOURCE, win)).not.toThrow();
    expect(win.console.warn).toHaveBeenCalledWith('[fixture] storage is unavailable:', 'SecurityError');
    expect(win.__FIXTURE__).toBe(true);
  });

  describe('fx-now', () => {
    const target = Date.parse('2026-10-28T09:00:00Z');
    it('Date.now() and new Date() start at the given instant and keep flowing', () => {
      const win = run('?fx-now=2026-10-28T09:00:00Z');
      const FxDate = win.Date;
      expect(Math.abs(FxDate.now() - target)).toBeLessThan(1000);
      expect(Math.abs(new FxDate().getTime() - target)).toBeLessThan(1000);
      expect(win.__FIXTURE_EARLY__.now.target).toBe(target);
    });
    it('keeps everything else of Date: arguments, statics, instanceof, the call form', () => {
      const FxDate = run('?fx-now=2026-10-28T09:00:00Z').Date;
      expect(new FxDate(0).toISOString()).toBe('1970-01-01T00:00:00.000Z');
      expect(new FxDate(2020, 1, 3).getMonth()).toBe(1);
      expect(new FxDate('2021-05-06T00:00:00Z').getUTCDate()).toBe(6);
      expect(FxDate.UTC(2020, 0, 1)).toBe(Date.UTC(2020, 0, 1));
      expect(FxDate.parse('2020-01-01T00:00:00Z')).toBe(Date.parse('2020-01-01T00:00:00Z'));
      expect(new FxDate() instanceof Date).toBe(true);
      expect(typeof FxDate()).toBe('string');
      expect(FxDate()).toContain('2026');
      class Sub extends FxDate {}
      expect(new Sub(0) instanceof Sub).toBe(true);
    });
    it('a bad value is reported and leaves Date alone', () => {
      const win = run('?fx-now=yesterday');
      expect(win.Date).toBe(Date);
      expect(win.console.error).toHaveBeenCalledWith(expect.stringContaining('fx-now must be an ISO date'));
    });
  });
});
