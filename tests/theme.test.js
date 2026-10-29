// @vitest-environment node
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {Window} from 'happy-dom';
import {expect, test, vi} from 'vitest';

const source = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');
const PAPER = '#f6f5f0', NIGHT = '#121615', STAGE = '#08090a';

function boot({path = '/', dark = false, entries = {}, blocked = false} = {}) {
  const window = new Window({url: `https://woodshed.test${path}`});
  const document = window.document;
  document.head.innerHTML = '<meta name="theme-color" content="#174bd1">';
  const media = new window.EventTarget();
  media.matches = dark;
  window.matchMedia = () => media;
  window.woodshedDesktop = {setTheme: vi.fn(async () => {})};
  const map = new Map(Object.entries(entries));
  const storage = blocked
    ? {getItem() { throw Error('Blocked'); }, setItem() { throw Error('Blocked'); }, removeItem() { throw Error('Blocked'); }}
    : {getItem: vi.fn(k => (map.has(k) ? map.get(k) : null)), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn()};
  const listen = vi.spyOn(window, 'addEventListener');
  const events = [];
  window.addEventListener('woodshed:theme', e => events.push(e.detail));
  vm.runInNewContext(source, {window, document, localStorage: storage, CustomEvent: window.CustomEvent});
  const root = document.documentElement;
  const os = value => { media.matches = value; media.dispatchEvent(new window.Event('change')); };
  const meta = () => document.querySelector('meta[name="theme-color"]').getAttribute('content');
  return {window, document, root, storage, listen, events, os, meta, appearance: window.woodshedAppearance};
}

const prefsJson = p => JSON.stringify({v: 1, ...p});

test('reads ws.prefs first: theme, stage and library layout', () => {
  const {root, meta, appearance} = boot({entries: {
    'ws.prefs': prefsJson({theme: 'dark', stage: 'match', library: {layout: 'list'}}),
    'ws.theme': 'light', 'ws.view': JSON.stringify({layout: 'grid'}),
  }});
  expect(root.dataset.theme).toBe('dark');
  expect(root.dataset.stageTheme).toBe('dark');      // a dark theme makes a 'match' Stage dark too
  expect(root.dataset.libraryLayout).toBe('list');
  expect(root.style.colorScheme).toBe('dark');
  expect(meta()).toBe(NIGHT);
  expect(appearance.preference).toBe('dark');
  expect(appearance.stage).toBe('match');
});

test('falls back to the legacy ws.theme / ws.view keys when ws.prefs is absent', () => {
  const {root, meta} = boot({entries: {'ws.theme': 'light', 'ws.view': JSON.stringify({group: 'albums', layout: 'list'})}, dark: true});
  expect(root.dataset.theme).toBe('light');
  expect(root.dataset.libraryLayout).toBe('list');
  expect(root.dataset.stageTheme).toBe('dark');      // Stage is dark by default
  expect(meta()).toBe(PAPER);
});

test('system follows the OS and tracks live changes', () => {
  const {root, os, meta} = boot({dark: true});
  expect(root.dataset.theme).toBe('dark');
  expect(meta()).toBe(NIGHT);
  os(false);
  expect(root.dataset.theme).toBe('light');
  expect(root.style.colorScheme).toBe('light');
  expect(meta()).toBe(PAPER);
});

test('pre-paints data-place=stage for /s/:id and /share/:token deep links only', () => {
  for (const path of ['/s/abc', '/s/abc/', `/share/${'a'.repeat(64)}`]) {
    const {root, meta} = boot({path, entries: {'ws.prefs': prefsJson({theme: 'light'})}});
    expect(root.dataset.place, path).toBe('stage');
    expect(root.dataset.stageTheme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(meta(), path).toBe(STAGE);
  }
  for (const path of ['/', '/s/abc/edit/map', '/settings', '/add']) {
    const {root, meta} = boot({path, entries: {'ws.prefs': prefsJson({theme: 'light'})}});
    expect(root.dataset.place, path).toBeUndefined();
    expect(meta(), path).toBe(PAPER);
  }
});

test('a light theme with Stage "match" keeps the Stage on paper', () => {
  const {root, meta} = boot({path: '/s/abc', entries: {'ws.prefs': prefsJson({theme: 'light', stage: 'match'})}});
  expect(root.dataset.place).toBe('stage');
  expect(root.dataset.stageTheme).toBe('light');
  expect(root.style.colorScheme).toBe('light');
  expect(meta()).toBe(PAPER);
});

test('theme-color per set, and refresh() follows the root attributes the router sets', () => {
  const {root, meta, appearance} = boot({entries: {'ws.prefs': prefsJson({theme: 'light'})}});
  expect(meta()).toBe(PAPER);
  root.dataset.place = 'stage';
  expect(appearance.refresh()).toBe('stage');
  expect(meta()).toBe(STAGE);
  root.dataset.place = 'library';
  appearance.apply({theme: 'dark'});
  expect(meta()).toBe(NIGHT);
  appearance.apply({theme: 'light'});
  expect(meta()).toBe(PAPER);
});

test('apply() paints, dispatches woodshed:theme, and never persists or calls the desktop', () => {
  const {root, storage, window, events, appearance} = boot();
  appearance.apply({theme: 'dark'});
  expect(root.dataset.theme).toBe('dark');
  appearance.apply({stage: 'match', theme: 'light'});
  expect(root.dataset.stageTheme).toBe('light');
  appearance.apply({theme: 'bogus', stage: 'bogus'});   // ignored values keep the current ones
  expect(appearance.preference).toBe('light');
  expect(appearance.stage).toBe('match');
  expect(events.at(-1)).toEqual({preference: 'light', theme: 'light', stage: 'match'});
  expect(events.length).toBe(4);   // initial paint + three applies
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(storage.removeItem).not.toHaveBeenCalled();
  expect(window.woodshedDesktop.setTheme).not.toHaveBeenCalled();
  expect(appearance.set).toBeUndefined();
  expect(Object.isFrozen(appearance)).toBe(true);
});

test('no storage writes and no storage listener: ws.theme changes in another tab are ignored', () => {
  const {root, storage, window, listen} = boot({entries: {'ws.theme': 'light'}});
  expect(listen.mock.calls.map(c => c[0])).not.toContain('storage');
  window.dispatchEvent(new window.StorageEvent('storage', {key: 'ws.theme', newValue: 'dark'}));
  expect(root.dataset.theme).toBe('light');
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(storage.removeItem).not.toHaveBeenCalled();
});

test('unavailable storage or garbage values still paint a working page', () => {
  const blocked = boot({blocked: true, dark: true});
  expect(blocked.root.dataset.theme).toBe('dark');
  blocked.appearance.apply({theme: 'light'});
  expect(blocked.root.dataset.theme).toBe('light');
  const garbage = boot({entries: {'ws.prefs': '{nope', 'ws.theme': 'sepia', 'ws.view': '[1]'}});
  expect(garbage.root.dataset.theme).toBe('light');
  expect(garbage.root.dataset.libraryLayout).toBe('grid');
  const wrongTypes = boot({entries: {'ws.prefs': prefsJson({theme: 7, stage: 'x', library: 'list'})}, dark: true});
  expect(wrongTypes.root.dataset.theme).toBe('dark');
  expect(wrongTypes.appearance.stage).toBe('dark');
  expect(wrongTypes.root.dataset.libraryLayout).toBe('grid');
});

test('/download keeps its startup marker', () => {
  expect(boot({path: '/download'}).root.dataset.startup).toBe('download');
});
