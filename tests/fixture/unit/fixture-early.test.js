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

function run(search, {local = {}, session = {}, RealDate = Date, navType, historyLength} = {}) {
  const win = {
    location: {search},
    localStorage: local instanceof MemoryStorage ? local : new MemoryStorage(local),
    sessionStorage: session instanceof MemoryStorage ? session : new MemoryStorage(session),
    console: {error: vi.fn(), warn: vi.fn()}, Date: RealDate, URLSearchParams, JSON, Object, Array, Reflect, isFinite, String,
  };
  if (navType) win.performance = {getEntriesByType: type => (type === 'navigation' ? [{type: navType}] : [])};
  if (historyLength) win.history = {length: historyLength};
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
    expect(win.sessionStorage.toJSON()).toEqual({keep: '1', 'fx-switches': '{}', 'fx-early': expect.any(String)});
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
  it('fx-prefs with a legacy-key switch is a console error (the migration would never run)', () => {
    for (const legacy of ['fx-view=albums-list', 'fx-practice=chart', 'fx-overview=1', 'fx-notation=lanes']) {
      const win = run(`?fx-prefs=${encodeURIComponent('{"theme":"dark"}')}&${legacy}`);
      expect(win.console.error).toHaveBeenCalledWith(expect.stringContaining('fx-prefs cannot be combined with fx-view'));
    }
    expect(run('?fx-view=albums-list').console.error).not.toHaveBeenCalled();
    expect(run(`?fx-prefs=${encodeURIComponent('{"theme":"dark"}')}`).console.error).not.toHaveBeenCalled();
  });

  describe('switches stick for the tab', () => {
    it('a URL with fx-* parameters stores them (without fx-reset); a URL with none uses them', () => {
      const session = new MemoryStorage();
      run('?fx-desktop=1&fx-platform=ipad&fx-reset=1&song=x', {session});
      expect(JSON.parse(session.getItem('fx-switches'))).toEqual({desktop: '1', platform: 'ipad'});
      const later = run('?song=x', {session, historyLength: 3});
      expect(later.__FIXTURE_EARLY__.fx).toEqual({desktop: '1', platform: 'ipad'});
      expect(later.__FIXTURE_EARLY__.sticky).toBe(true);
    });
    it('a URL with other switches replaces them; fx-reset=1 alone clears them', () => {
      const session = new MemoryStorage();
      run('?fx-desktop=1&fx-library=empty', {session});
      expect(run('?fx-jobs=0', {session}).__FIXTURE_EARLY__.fx).toEqual({jobs: '0'});
      run('?fx-reset=1', {session, historyLength: 2});
      expect(JSON.parse(session.getItem('fx-switches'))).toEqual({});
      expect(run('', {session}).__FIXTURE_EARLY__.fx).toEqual({});
    });
    it('fx-now from the stored map still shifts Date on every load', () => {
      const session = new MemoryStorage();
      run('?fx-now=2026-10-28T09:00:00Z', {session});
      const later = run('', {session, navType: 'reload'});
      expect(Math.abs(later.Date.now() - Date.parse('2026-10-28T09:00:00Z'))).toBeLessThan(1000);
    });
  });

  describe('storage switches act once per navigation', () => {
    const PREFS = `fx-prefs=${encodeURIComponent('{"theme":"dark"}')}`;
    it('a reload or back/forward does not reset the db or re-merge prefs', () => {
      const local = new MemoryStorage(), session = new MemoryStorage();
      run(`?fx-reset=1&${PREFS}`, {local, session});
      expect(JSON.parse(local.getItem('ws.prefs')).theme).toBe('dark');
      local.setItem('ws.prefs', '{"v":1,"theme":"light"}');
      session.setItem('fx-db', '{"saved":true}');
      for (const navType of ['reload', 'back_forward']) {
        const again = run(`?fx-reset=1&${PREFS}`, {local, session, navType, historyLength: 4});
        expect(again.__FIXTURE_EARLY__.applied).toBe(false);
      }
      expect(local.getItem('ws.prefs')).toBe('{"v":1,"theme":"light"}');
      expect(session.getItem('fx-db')).toBe('{"saved":true}');
    });
    it('a tab opened from this one (same signature, fresh history) does not apply them again', () => {
      const local = new MemoryStorage(), session = new MemoryStorage();
      run(`?fx-reset=1&${PREFS}`, {local, session});
      session.setItem('fx-db', '{"saved":true}');
      const tab = new MemoryStorage(session.toJSON());
      expect(run(`?fx-reset=1&${PREFS}`, {local, session: tab, navType: 'navigate', historyLength: 1}).__FIXTURE_EARLY__.applied).toBe(false);
      expect(tab.getItem('fx-db')).toBe('{"saved":true}');
    });
    it('a new navigation in the same tab applies them again; legacy keys are not rewritten on a reload', () => {
      const local = new MemoryStorage(), session = new MemoryStorage();
      run('?fx-reset=1', {local, session});
      session.setItem('fx-db', '{"saved":true}');
      expect(run('?fx-reset=1', {local, session, navType: 'navigate', historyLength: 3}).__FIXTURE_EARLY__.applied).toBe(true);
      expect(session.getItem('fx-db')).toBeNull();
      run('?fx-view=albums-list', {local, session, historyLength: 4});
      local.removeItem('ws.view');
      run('?fx-view=albums-list', {local, session, navType: 'reload', historyLength: 4});
      expect(local.getItem('ws.view')).toBeNull();
      run('', {local, session, historyLength: 5});
      expect(local.getItem('ws.view')).toBeNull();
    });
  });
  it('unavailable storage is a warning, not a failure', () => {
    const refuse = () => { throw new Error('SecurityError'); };
    const blocked = {length: 0, key: () => null, getItem: refuse, setItem: refuse, removeItem: refuse};
    const win = {location: {search: '?fx-reset=1'}, localStorage: blocked, sessionStorage: blocked, console: {error: vi.fn(), warn: vi.fn()}, Date, URLSearchParams, JSON, Object, Array, Reflect, isFinite, String};
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
