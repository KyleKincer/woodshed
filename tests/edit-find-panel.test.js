// @vitest-environment happy-dom
// ED4: the Find a chart panel (src/edit/map/find-panel.js; architecture §2.15, D20; spec §5.1.2). Every
// scenario of the 1.9 tests/tempo-sources.test.js is ported here onto the new panel, which runs on a real
// song session (tests/helpers/test-session.js: SongMapStore, Metronome, MultitrackEngine over fake audio,
// the transport, the practice undo stack, the notation session) and a real Edit · Map session
// (src/edit/map/session.js) wired the way Edit · Map wires it (session.mapEditor, suspended saves).
// Keys go through the real dispatcher and registry. Sizes and placement are Playwright states (ED4.cjs).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {createRegistry} from '../src/app/commands.js';
import {startDispatcher} from '../src/app/dispatch.js';
import {clock as appClock} from '../src/app/clock.js';
import {signal} from '../src/app/store.js';
import {ApiError} from '../src/api/client.js';
import {defineTransportCommands} from '../src/stage/transport-commands.js';
import {createMapSession, MAP_SESSION_COPY} from '../src/edit/map/session.js';
import {ACCEPT, COPY, CONTROLS, decodeSource, firstDownbeatQ, mountFindPanel, otherSourceLinks, rowMeta} from '../src/edit/map/find-panel.js';
import {fraction} from '../shared/notation.ts';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {demoScore} from './fixtures/drum-score.js';
import {keydown} from './helpers/dom.js';

/** The 1.9 test's map: ten 4/4 bars, two pins at `start` and `start + 2` (120 bpm). */
const data = (start = 1) => ({version: 1, measures: Array.from({length: 10}, (_, i) => ({id: 'bar-' + i, numerator: 4, denominator: 4, length: fraction(4), label: ''})),
  pins: [{position: fraction(0), time: start}, {position: fraction(4), time: start + 2}], tailQpm: 120});
const candidates = [{id: 'one', title: 'Studio', artist: 'Band', source: 'harmonix', duration: 20}, {id: 'two', title: 'Other edition', artist: 'Band', source: 'harmonix', duration: 23}];
const json = (v) => JSON.stringify(v);

let clock, restoreAudio, current = [];

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
});

afterEach(async () => {
  for (const off of current.splice(0).reverse()) await off();
  document.body.replaceChildren();
  delete document.documentElement.dataset.posture;
  delete document.documentElement.dataset.place;
  restoreAudio();
  vi.useRealTimers();
});

/** A tiny router: the editFind match, onLeave hooks, and a recorder. `leave(to)` runs the hooks like router.navigate. */
function fakeRouter(songId, query = {}) {
  const hooks = new Set();
  const match = (name, params = {}, extra = {}) => ({name, path: `/${name}`, params: {songId, ...params}, query: {}, route: {session: true, ...extra}});
  const router = {
    current: signal({name: 'editFind', path: `/s/${songId}/edit/map/find`, params: {songId, tab: 'map', find: true}, query, route: {session: true, posture: 'edit'}}),
    navigate: vi.fn(),
    onLeave(fn) { hooks.add(fn); return () => hooks.delete(fn); },
    leave(to) { for (const fn of [...hooks]) fn(router.current.peek(), to); },
    get hooks() { return hooks.size; },
    stage: () => match('stage'),
    editMap: () => match('edit', {tab: 'map'}),
    editChart: () => match('edit', {tab: 'chart'}),
    library: () => ({name: 'library', path: '/', params: {}, query: {}, route: {}}),
  };
  return router;
}

/**
 * A song session, Edit · Map's session wired like Edit · Map wires it, a registry with the transport
 * commands, and the panel. Options: tempo/duration/score (the song), search/load (the API), importFile,
 * query (the route query), confirm (the leave dialog's answer), mount (false: do not mount yet).
 */
async function bed({tempo = {songMap: data()}, duration = 20, score = null, title = 'Song', artist = 'Band', search, load, importFile,
  query = {}, confirm = async () => false, onClose, mount = true, session: sessionOptions = {}} = {}) {
  const ts = await createTestSession({clock, tempo, duration, title, artist, ...(score ? {score} : {}), ...sessionOptions});
  const registry = createRegistry();
  const offs = [defineTransportCommands({registry})];
  const router = fakeRouter(ts.id, query);
  const toasts = [];
  const feedback = {toast: vi.fn((text, opts = {}) => { toasts.push({text, ...opts}); }), status: vi.fn(), confirm: vi.fn(confirm)};
  offs.push(registry.provide('session', () => ts.session), registry.provide('transport', () => ts.session.transport),
    registry.provide('router', () => router), registry.provide('feedback', () => feedback),
    registry.provide('route', () => router.current.peek()));
  const statuses = [];
  const mapSession = createMapSession({engine: ts.engine, metronome: ts.metronome, map: ts.map, prefs: null, hooks: {
    suspendSaves: (on, opts) => ts.session.suspendSaves(on, opts),
    pauseMapSync: (on) => ts.session.notation.setMapSyncPaused(on),
    status: (text, opts) => statuses.push({text, ...opts}),
  }});
  ts.session.mapEditor.value = mapSession;
  const api = {search: search ?? vi.fn(async () => candidates), load: load ?? vi.fn(async ({id}) => ({format: 'beats', text: beatText(id === 'one' ? 2 : 3)}))};
  const host = document.createElement('div');
  document.body.append(host);
  const b = {ts, session: ts.session, map: ts.map, mapSession, registry, router, feedback, toasts, statuses, api, host, panel: null, onClose: onClose ?? vi.fn(),
    importFile: importFile ?? vi.fn()};
  b.mount = () => {
    b.panel = mountFindPanel(host, {session: ts.session, mapSession, onClose: b.onClose, api, router, feedback, registry, importFile: b.importFile});
    return b.panel;
  };
  current.push(async () => {
    b.panel?.destroy();
    mapSession.destroy();
    ts.session.mapEditor.value = null;
    for (const off of offs.reverse()) off();
    await ts.dispose();
  });
  if (mount) { b.mount(); await settle(); }
  return b;
}

/** Harmonix-style beat text: 120 bpm from `start`, four beats a bar, to 20 s. */
function beatText(start) {
  const rows = [];
  for (let i = 0, t = start; t < 19.8; i++, t += 0.5) rows.push(`${t.toFixed(3)}\t${(i % 4) + 1}`);
  return rows.join('\n');
}

/** A candidate result like decodeSource's: the 1.9 test's map shifted to start at `start`. */
const resultAt = (start, extra = {}) => ({map: data(start), format: 'beats', warnings: [], ...extra});

const $ = (sel, root = document) => root.querySelector(sel);
const radio = (id) => $(`input[type=radio][value="${id}"]`);
const status = () => $('.find-status');
const statusText = () => status().textContent.replace(/\s+/g, ' ').trim();
const button = (name) => [...document.querySelectorAll('button')].find((el) => nameOf(el) === name) ?? null;
const offsetInput = () => $('.find-offset input');

async function choose(id) {
  const r = radio(id);
  r.checked = true;
  r.dispatchEvent(new Event('change', {bubbles: true}));
  await settle();
}

/** The accessible name (enough for these controls): aria-labelledby, aria-label, a <label>, a legend, else the text. */
function textOf(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1 || node.getAttribute('aria-hidden') === 'true' || node.hidden) return '';
  return [...node.childNodes].map(textOf).join('');
}
function nameOf(el) {
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const by = el.getAttribute('aria-labelledby');
  if (by) return clean(by.split(/\s+/).map((id) => textOf(document.getElementById(id) ?? document.createElement('i'))).join(' '));
  const label = el.getAttribute('aria-label');
  if (label) return clean(label);
  if (el.id) { const l = document.querySelector(`label[for="${el.id}"]`); if (l) return clean(textOf(l)); }
  if (el.tagName === 'FIELDSET') { const legend = el.querySelector(':scope > legend'); if (legend) return clean(textOf(legend)); }
  return clean(textOf(el));
}
const ROLES = {
  region: 'section[aria-labelledby]', searchbox: 'input[type=search]', button: 'button', radiogroup: '[role=radiogroup]',
  radio: 'input[type=radio]', link: 'a[href]', group: 'fieldset:not([role])', spinbutton: 'input[type=number]',
};
const byRole = (root, role, name) => [...root.querySelectorAll(ROLES[role])].filter((el) => !el.closest('[hidden]')).find((el) => nameOf(el) === name) ?? null;

/* ------------------------------------------------------------------------------------------------ */

describe('opening (spec §5.1.2: pre-filled and auto-run)', () => {
  test('opening searches artist and title while leaving the current map untouched; Other sources link out', async () => {
    const b = await bed({mount: false});
    const before = b.map.snapshot();
    b.mount();
    await settle();
    expect(b.api.search).toHaveBeenCalledWith({query: 'Band Song', duration: 20});
    expect(json(b.map.snapshot())).toBe(json(before));
    expect(document.querySelectorAll('input[type=radio]')).toHaveLength(3);
    expect(radio('original').checked).toBe(true);
    expect($('input[type=search]').value).toBe('Band Song');
    expect(document.activeElement).toBe($('input[type=search]'));
    expect(statusText()).toBe(COPY.found(2));
    const [enchor, songsterr] = document.querySelectorAll('.find-others a');
    expect(enchor.href).toContain('name=Song&artist=Band');
    expect(songsterr.href).toContain('pattern=Band+Song');
    for (const a of [enchor, songsterr]) { expect(a.target).toBe('_blank'); expect(a.rel).toContain('noopener'); }
    expect(b.mapSession.auditioning.peek()).toBe(true);
  });

  test('the controls table: every row renders with its role and accessible name', async () => {
    const b = await bed();
    await choose('one');
    for (const row of CONTROLS) {
      const el = byRole(b.host, row.role, row.name);
      expect(el, `${row.role} "${row.name}"`).not.toBeNull();
    }
    // The drum commit appears only with a drum chart (below); its name carries the hit count.
    expect(COPY.useWithDrums(312)).toBe('Use map + drum chart (312 hits)');
    expect(COPY.useWithDrums(1)).toBe('Use map + drum chart (1 hit)');
    expect([...document.querySelectorAll('.find-commit button')].map(nameOf).filter(Boolean)).toEqual([COPY.useTheirs, COPY.keepMine]);
    // No separate Cancel (D20: Esc and Keep my map are the same).
    expect(button('Cancel')).toBeNull();
  });

  test('an empty query does not search; the status asks for a search or a file', async () => {
    const b = await bed({title: '', artist: ''});
    expect(b.api.search).not.toHaveBeenCalled();
    expect(statusText()).toBe(COPY.start);
    $('form.find-search').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await settle();
    expect(statusText()).toBe(COPY.emptyQuery);
  });

  test('?import=1 focuses Import a file… (the chart surface\'s "Import a file")', async () => {
    const b = await bed({query: {import: '1'}});
    expect(nameOf(document.activeElement)).toBe(COPY.importFile);
    expect(b.api.search).toHaveBeenCalled();
  });
});

describe('results', () => {
  test('Chorus results show source, charter, drum chart and duration before the audition', async () => {
    const b = await bed({search: vi.fn(async () => ({candidates: [{id: 'chorus-one', title: 'Born in Dissonance', artist: 'Meshuggah', source: 'chorus',
      charter: 'Drum Charter', hasDrums: true, duration: 276}], warnings: []}))});
    expect($('.find-scope').textContent).toBe(COPY.scope);
    const row = radio('chorus-one').closest('.find-row');
    expect(row.textContent).toContain('Chorus Encore');
    expect(row.textContent).toContain('Chart by Drum Charter');
    expect(row.querySelector('.find-badge').hidden).toBe(false);
    expect(row.querySelector('.find-badge').textContent).toBe(COPY.drumBadge);
    expect(row.textContent).toContain('4:36');
    expect(nameOf(radio('chorus-one'))).toBe('Born in Dissonance');
    b.api.load.mockResolvedValueOnce({format: 'beats', text: beatText(1)});
    await choose('chorus-one');
    expect($('.find-current-detail').textContent).toContain('Chorus Encore · Chart by Drum Charter');
    expect(rowMeta({id: 'x', artist: 'A', source: 'harmonix'})).toBe('A · Harmonix Set');
  });

  test('partial provider failures stay visible and never claim a complete empty search', async () => {
    const search = vi.fn().mockResolvedValueOnce({candidates: [], warnings: ['Chorus Encore is temporarily unavailable.']});
    const b = await bed({search});
    expect(statusText()).toContain('Search incomplete');
    expect(statusText()).toContain('Chorus Encore is temporarily unavailable');
    expect(statusText()).toContain('You can still import');
    expect(statusText()).not.toContain('No matches');
    expect(status().getAttribute('role')).toBe('alert');
    expect(button(COPY.importFile).getAttribute('aria-disabled')).toBeNull();
    search.mockResolvedValueOnce({candidates: [{id: 'one', title: 'Studio', artist: 'Band', source: 'chorus'}], warnings: ['Harmonix Set is temporarily unavailable.']});
    $('form.find-search').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await settle();
    expect(radio('one').closest('.find-row').textContent).toContain('Studio');
    expect(statusText()).toContain('1 possible map');
    expect(statusText()).toContain('Harmonix Set is temporarily unavailable');
    expect(b.mapSession.auditioning.peek()).toBe(true);
  });

  test('no matches says so and keeps import; a failed search keeps import too', async () => {
    const b = await bed({search: vi.fn(async () => ({candidates: [], warnings: []}))});
    expect(statusText()).toBe(COPY.none);
    b.api.search.mockRejectedValueOnce(new ApiError({message: 'Network unavailable'}));
    $('form.find-search').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await settle();
    expect(statusText()).toBe(COPY.unavailable('Network unavailable'));
    expect(button(COPY.importFile).getAttribute('aria-disabled')).toBeNull();
  });

  test('a coded API error reads through error-copy', async () => {
    const b = await bed({search: vi.fn(async () => { throw new ApiError({code: 'not_signed_in', message: 'raw'}); })});
    expect(statusText().startsWith('Search unavailable.')).toBe(true);
    expect(statusText()).not.toContain('raw');
    expect(b.mapSession.auditioning.peek()).toBe(true);
  });

  test('a search keeps Your map, imported files and the chosen row, and adds new candidates once', async () => {
    const b = await bed();
    await choose('one');
    b.api.search.mockResolvedValueOnce([candidates[0], {id: 'three', title: 'Third', artist: 'Band', source: 'chorus', duration: 20}]);
    $('form.find-search').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await settle();
    expect([...document.querySelectorAll('input[type=radio]')].map((r) => r.value)).toEqual(['original', 'one', 'three']);
    expect(radio('one').checked).toBe(true);
  });
});

describe('the audition (D20)', () => {
  test('trying maps changes only the live map; Your map restores the pre-audition data exactly (origin kept)', async () => {
    const b = await bed();
    const original = b.map.snapshot();
    expect(original.origin).toBe('edited');
    await choose('one');
    expect(b.map.timeAt(0)).toBe(2);
    expect(b.map.data.origin).toBe('imported');
    expect(radio('one').checked).toBe(true);
    expect($('.find-current-name').textContent).toBe('Studio');
    expect(statusText()).toBe(COPY.loaded);
    // An offset on one candidate is remembered when you come back to it.
    $('[data-shift="100"]').click();
    expect(b.map.timeAt(0)).toBeCloseTo(2.1);
    await choose('two');
    expect(b.map.timeAt(0)).toBe(3);
    await choose('one');
    expect(b.map.timeAt(0)).toBeCloseTo(2.1);
    expect(offsetInput().value).toBe('100');
    await choose('original');
    expect(json(b.map.snapshot())).toBe(json(original));
    expect(b.map.data.origin).toBe('edited');
    expect(statusText()).toBe(COPY.original);
    expect(b.api.load).toHaveBeenCalledTimes(2);   // each source downloads once
  });

  test('no tempo or notation saves during the audition; map edits, map.undo and Stage map changes are refused', async () => {
    const b = await bed({tempo: {songMap: data()}});
    const saves = b.ts.server.calls.saveTempo.length;
    const partSaves = b.ts.partSaves.length;
    await choose('one');
    $('[data-shift="10"]').click();
    await choose('two');
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(b.ts.server.calls.saveTempo.length).toBe(saves);
    expect(b.ts.partSaves.length).toBe(partSaves);
    expect(b.ts.notation.mapSyncPaused).toBe(true);
    // Every other map edit is refused while the audition lasts.
    expect(b.mapSession.canUndo.peek()).toBe(false);
    expect(b.mapSession.canRedo.peek()).toBe(false);
    expect(b.mapSession.undo()).toBe(false);
    expect(b.mapSession.message.peek().text).toBe(MAP_SESSION_COPY.auditionLocked);
    expect(b.mapSession.addSectionAt(4)).toBeFalsy();
    expect(b.session.mapChange('Add section', (m) => m.edit((d) => { d.measures[2].label = 'X'; }, 'label'))).toBeNull();
    expect(b.map.data.measures[2].label).toBe('');
    // Transport and mix stay live: nothing is inert.
    expect(document.querySelector('[inert]')).toBeNull();
  });

  test('Keep my map: the map, both undo stacks and the saved tempo are exactly as before', async () => {
    const b = await bed();
    // Something on the map stack first, so "unchanged" is meaningful.
    b.mapSession.endAudition({commit: false});
    b.panel.destroy();
    b.mapSession.setLabel(3, 'Bridge');
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    const saved = b.ts.server.calls.saveTempo.length;
    const before = b.map.snapshot(), undo = json(b.map.undoStack), redo = json(b.map.redoStack);
    b.mount();
    await settle();
    await choose('two');
    $('[data-shift="-100"]').click();
    button(COPY.keepMine).click();
    await settle();
    expect(json(b.map.snapshot())).toBe(json(before));
    expect(json(b.map.undoStack)).toBe(undo);
    expect(json(b.map.redoStack)).toBe(redo);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(b.ts.server.calls.saveTempo.length).toBe(saved);
    expect(b.mapSession.auditioning.peek()).toBe(false);
    expect(b.onClose).toHaveBeenCalledWith({result: 'mine'});
    expect(b.ts.notation.mapSyncPaused).toBe(false);
  });

  test('Esc anywhere in the panel is Keep my map, including in the search field (through the dispatcher)', async () => {
    const b = await bed();
    const stop = startDispatcher({registry: b.registry});
    current.push(stop);
    document.documentElement.dataset.posture = 'edit';
    const before = b.map.snapshot();
    await choose('one');
    $('input[type=search]').focus();
    keydown('Escape');
    await settle();
    expect(json(b.map.snapshot())).toBe(json(before));
    expect(b.onClose).toHaveBeenCalledWith({result: 'mine'});
  });

  test('Use their map is one undoable map step that keeps bar ids, saved at once', async () => {
    const b = await bed();
    const original = b.map.snapshot();
    const ids = b.map.data.measures.map((m) => m.id);
    const depth = b.map.undoStack.length;
    const saved = b.ts.server.calls.saveTempo.length;
    await choose('one');
    expect(b.map.data.measures.map((m) => m.id)).toEqual(ids.slice(0, b.map.data.measures.length));
    $('[data-shift="10"]').click();
    await choose('two');
    await choose('one');
    button(COPY.useTheirs).click();
    await settle();
    expect(b.map.timeAt(0)).toBeCloseTo(2.01);
    expect(b.map.undoStack.length).toBe(depth + 1);          // every try is one step, not one each
    expect(b.mapSession.auditioning.peek()).toBe(false);
    expect(b.onClose).toHaveBeenCalledWith({result: 'theirs'});
    await settle();
    expect(b.ts.server.calls.saveTempo.length).toBe(saved + 1);
    expect(b.ts.server.calls.saveTempo.at(-1).tempo.songMap.origin).toBe('imported');
    expect(b.mapSession.message.peek().text).toBe(MAP_SESSION_COPY.usingTheirs);
    b.mapSession.undo();
    expect(json(b.map.snapshot())).toBe(json(original));
  });

  test('Use their map waits for a choice; with no onClose it returns to Edit · Map', async () => {
    const b = await bed({mount: false});
    b.onClose = undefined;
    b.panel = mountFindPanel(b.host, {session: b.session, mapSession: b.mapSession, api: b.api, router: b.router, feedback: b.feedback, registry: b.registry});
    await settle();
    const use = button(COPY.useTheirs);
    expect(use.getAttribute('aria-disabled')).toBe('true');
    expect(use.textContent).toContain(COPY.chooseFirst);
    use.click();
    expect(b.mapSession.auditioning.peek()).toBe(true);
    await choose('one');
    expect(button(COPY.useTheirs).getAttribute('aria-disabled')).toBeNull();
    button(COPY.useTheirs).click();
    expect(b.router.navigate).toHaveBeenCalledWith(`/s/${b.ts.id}/edit/map`, {replace: true});
  });

  test('notation guards refuse an incompatible candidate without changing the map', async () => {
    const b = await bed({load: vi.fn(async () => ({format: 'beats', text: '0\t1\n0.5\t2\n1\t3\n1.5\t1\n2\t2\n2.5\t3\n3\t1'}))});
    const before = b.map.snapshot();
    b.map.setGuard('notation', (timeline) => { if (timeline.measures[0].numerator !== 4) throw Error('Bar 1 has drum notes that would no longer fit.'); });
    current.push(() => b.map.setGuard('notation', null));
    await choose('one');
    expect(json(b.map.snapshot())).toBe(json(before));
    expect(statusText()).toMatch(/Bar 1 has drum notes/);
    expect(status().getAttribute('role')).toBe('alert');
    expect($('.find-current-name').textContent).toBe(COPY.yourMap);
    expect(radio('original').checked).toBe(true);
  });

  test('late load and search answers never change a closed panel or a later choice', async () => {
    let resolveLoad;
    const load = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveLoad = resolve; }));
    const b = await bed({load});
    const original = b.map.snapshot();
    void choose('one');
    await settle();
    expect(radio('one').closest('.find-row').dataset.state).toBe('loading');
    expect(radio('one').closest('.find-row').getAttribute('aria-busy')).toBe('true');
    button(COPY.keepMine).click();
    resolveLoad({format: 'beats', text: beatText(8)});
    await settle();
    expect(json(b.map.snapshot())).toBe(json(original));
    b.panel.destroy();

    b.mount();
    await settle();
    let resolveOld;
    load.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    load.mockImplementationOnce(async () => ({format: 'beats', text: beatText(3)}));
    void choose('one');
    await settle();
    await choose('two');
    resolveOld({format: 'beats', text: beatText(8)});
    await settle();
    expect(b.map.timeAt(0)).toBe(3);
    expect(radio('two').checked).toBe(true);

    // A search answer after the panel closed is ignored too.
    let resolveSearch;
    b.api.search.mockImplementationOnce(() => new Promise((resolve) => { resolveSearch = resolve; }));
    $('form.find-search').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await settle();
    expect(statusText()).toBe(COPY.searching);
    b.panel.destroy();
    resolveSearch({candidates: [{id: 'late', title: 'Late', source: 'chorus'}], warnings: []});
    await settle();
    expect(document.querySelector('input[value=late]')).toBeNull();
  });

  test('a late download cannot replace a map being lined up', async () => {
    let resolveLoad;
    const b = await bed();
    await choose('one');
    b.api.load.mockImplementationOnce(() => new Promise((resolve) => { resolveLoad = resolve; }));
    void choose('two');
    await settle();
    // While it downloads, the row the user chose shows as chosen and busy.
    expect(radio('two').checked).toBe(true);
    expect(radio('two').closest('.find-row').dataset.state).toBe('loading');
    $('[data-shift="100"]').click();
    // Lining up the map being heard cancels the download: its row is no longer busy or chosen.
    expect(radio('one').checked).toBe(true);
    expect(radio('two').checked).toBe(false);
    expect(radio('two').closest('.find-row').hasAttribute('aria-busy')).toBe(false);
    resolveLoad({format: 'beats', text: beatText(8)});
    await settle();
    expect(b.map.timeAt(0)).toBeCloseTo(2.1);
    expect(radio('one').checked).toBe(true);
  });

  test('a failed download puts the choice back on the map being heard', async () => {
    const b = await bed();
    await choose('one');
    b.api.load.mockRejectedValueOnce(new Error('This tempo map is unavailable. Try another match.'));
    await choose('two');
    expect(statusText()).toBe('This tempo map is unavailable. Try another match.');
    expect(radio('one').checked).toBe(true);
    expect(radio('two').checked).toBe(false);
    expect(b.map.timeAt(0)).toBe(2);
  });

  test('destroying the panel mid-audition keeps your map', async () => {
    const b = await bed();
    const before = b.map.snapshot();
    await choose('one');
    b.panel.destroy();
    expect(json(b.map.snapshot())).toBe(json(before));
    expect(b.mapSession.auditioning.peek()).toBe(false);
    expect(b.host.childElementCount).toBe(0);
    expect(b.router.hooks).toBe(0);
  });

  test('a duration mismatch over 2 s warns that it may be another performance', async () => {
    const b = await bed();
    await choose('two');
    expect($('.find-warnings').hidden).toBe(false);
    expect($('.find-warnings').textContent).toContain(COPY.mismatch(3, true));
    await choose('one');
    expect($('.find-warnings').textContent).not.toContain('seconds longer');
  });
});

describe('Align', () => {
  test('align is disabled with its reason until a map is chosen', async () => {
    await bed();
    expect($('.find-align-controls').disabled).toBe(true);
    expect($('.find-reason').hidden).toBe(false);
    expect($('.find-reason').textContent).toBe(COPY.alignReason);
    await choose('one');
    expect($('.find-align-controls').disabled).toBe(false);
    expect($('.find-reason').hidden).toBe(true);
  });

  test('line up the first downbeat with the cue, including maps shifted before zero; offsets and Reset', async () => {
    const b = await bed();
    b.session.transport.cue(6.5);
    await choose('one');
    button(COPY.lineUp).click();
    expect(b.map.timeAt(0)).toBeCloseTo(6.5, 6);
    expect(offsetInput().value).toBe('4500');
    button(COPY.lineUp).click();   // from the source map, not the shifted one
    expect(b.map.timeAt(0)).toBeCloseTo(6.5, 6);
    const input = offsetInput();
    input.value = '-3000';
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    expect(b.map.timeAt(0)).toBeCloseTo(-1, 6);
    expect(b.map.data.pins.every((pin) => pin.time >= 0)).toBe(true);
    expect(b.map.timeAt(4)).toBeCloseTo(1, 6);
    expect(statusText()).toBe(COPY.offsetMoved(-3000));
    button(COPY.lineUp).click();
    expect(b.map.timeAt(0)).toBeCloseTo(6.5, 6);
    button(COPY.reset).click();
    expect(b.map.timeAt(0)).toBe(2);
    expect(offsetInput().value).toBe('0');
    for (const ms of [-100, -10, 10, 100]) expect(byRole(b.host, 'button', COPY.shiftLabel(ms))).not.toBeNull();
  });

  test('a pickup: the first downbeat is bar 1, after the pickup', async () => {
    const pickup = data(0);
    pickup.measures[0].length = fraction(2);
    expect(firstDownbeatQ(pickup)).toBe(2);
    expect(firstDownbeatQ(data(0))).toBe(0);
  });

  test('an offset out of range is refused and the field shows the current offset', async () => {
    const b = await bed();
    await choose('one');
    const input = offsetInput();
    input.value = '99999999';
    input.dispatchEvent(new Event('blur'));
    expect(statusText()).toBe(COPY.offsetRange);
    expect(b.map.timeAt(0)).toBe(2);
    expect(offsetInput().value).toBe('0');
  });
});

describe('keys (spec §5.1.2: only the panel\'s own keys while its field has focus)', () => {
  test('typing never reaches the registry; Space on the panel\'s buttons and rows plays (audition with the main transport)', async () => {
    const b = await bed();
    const stop = startDispatcher({registry: b.registry});
    current.push(stop);
    document.documentElement.dataset.posture = 'edit';
    const leaked = vi.fn();
    current.push(b.registry.register({id: 'test.mute', title: 'Mute', group: 'Mix', keys: ['KeyM', 'Digit1'], scopes: ['edit', 'edit.map'], run: leaked}));
    const playStop = vi.spyOn(b.session.transport, 'playStop');
    const search = $('input[type=search]');
    search.focus();
    expect(keydown('KeyM').defaultPrevented).toBe(false);
    expect(keydown('Space').defaultPrevented).toBe(false);
    await choose('one');
    offsetInput().focus();
    keydown('Digit1');
    expect(leaked).not.toHaveBeenCalled();
    expect(playStop).not.toHaveBeenCalled();
    button(COPY.importFile).focus();
    expect(keydown('Space').defaultPrevented).toBe(true);
    expect(playStop).toHaveBeenCalledTimes(1);
    radio('one').focus();
    keydown('Space');
    expect(playStop).toHaveBeenCalledTimes(2);
    // Arrow keys stay with the radio rows.
    expect($('.find-results').getAttribute('data-consume-keys')).toContain('ArrowDown');
    expect(b.mapSession.auditioning.peek()).toBe(true);
  });

  test('the Play / Stop button is the main transport\'s command', async () => {
    const b = await bed();
    const playStop = vi.spyOn(b.session.transport, 'playStop');
    byRole(b.host, 'button', COPY.play).click();
    expect(playStop).toHaveBeenCalledTimes(1);
    expect(byRole(b.host, 'button', COPY.play).getAttribute('aria-keyshortcuts')).toBe('Space');
  });
});

describe('Import a file… (every format and limit of importTempoFile)', () => {
  test('the picker accepts every format; the hint names them', async () => {
    await bed();
    const input = $('input[type=file]');
    expect(input.accept.split(',')).toEqual([...ACCEPT]);
    expect(input.accept.split(',')).toEqual(expect.arrayContaining(['.gp3', '.gp4', '.gp5', '.gpx', '.gp', '.sng', '.zip', '.mid', '.midi', '.chart', '.txt', '.tsv', '.lab', '.csv']));
    expect($('.find-import').textContent).toContain('Guitar Pro');
    expect($('.find-import').textContent).toContain('10 MB');
    expect($('.find-others').textContent).not.toContain('exported as MIDI first');
  });

  async function pick(file) {
    const input = $('input[type=file]');
    Object.defineProperty(input, 'files', {configurable: true, value: [file]});
    input.dispatchEvent(new Event('change'));
    await settle();
  }

  test('a file joins the rows, is tried at once and lines up like any source', async () => {
    const importFile = vi.fn(async () => resultAt(2, {format: 'guitar-pro', warnings: ['Timing follows score playback and repeats. Check alignment with the recording.']}));
    const b = await bed({importFile});
    const file = new File(['gp'], 'song.gp5');
    await pick(file);
    expect(importFile).toHaveBeenCalledWith(file, {duration: 20});
    expect($('.find-current-name').textContent).toBe('song.gp5');
    expect(radio('file-1').checked).toBe(true);
    expect(radio('file-1').closest('.find-row').textContent).toContain(COPY.importedSource);
    expect($('.find-warnings').textContent).toContain('score playback and repeats');
    expect(statusText()).toBe(COPY.fileLoaded);
    $('[data-shift="100"]').click();
    expect(b.map.timeAt(0)).toBeCloseTo(2.1);
  });

  test('a file the importer refuses shows why and leaves the map alone', async () => {
    const importFile = vi.fn(async () => { throw new Error('Choose a tempo file smaller than 10 MB.'); });
    const b = await bed({importFile});
    const before = b.map.snapshot();
    await pick(new File(['x'], 'huge.mid'));
    expect(statusText()).toBe('Choose a tempo file smaller than 10 MB.');
    expect(json(b.map.snapshot())).toBe(json(before));
    expect(document.querySelectorAll('input[type=radio]')).toHaveLength(3);
  });

  test('drum notation: preview, then a refusal keeps the audition open; a later success commits both', async () => {
    const drums = {hits: [{q: 0, midi: 36, durationQ: 0.25, velocity: 0.8}, {q: 1, midi: 38, durationQ: 0.25, velocity: 0.8}], source: 'midi', warnings: ['Check the MIDI recording version.']};
    const importFile = vi.fn(async () => resultAt(2, {format: 'midi', warnings: [], drums}));
    const b = await bed({importFile});
    const importScore = vi.spyOn(b.session.notation, 'importScore')
      .mockRejectedValueOnce(new Error('This song already has drum notation. Keep the tempo map alone; import drums into a song with an empty part.'));
    await pick(new File(['midi'], 'song.mid'));
    const drumsButton = $('.find-use-drums');
    expect(drumsButton.hidden).toBe(false);
    expect(nameOf(drumsButton)).toBe(COPY.useWithDrums(2));
    expect($('.find-warnings').textContent).toContain('Check the MIDI recording version.');
    expect(radio('file-1').closest('.find-row').querySelector('.find-badge').hidden).toBe(false);
    $('[data-shift="100"]').click();
    drumsButton.click();
    await settle();
    expect(importScore).toHaveBeenCalledTimes(1);
    expect(b.mapSession.auditioning.peek()).toBe(true);
    expect(statusText()).toMatch(/already has drum notation/);
    expect(b.onClose).not.toHaveBeenCalled();
    drumsButton.click();
    await vi.waitFor(() => expect(b.onClose).toHaveBeenCalled(), {timeout: 5000});
    expect(importScore).toHaveBeenCalledTimes(2);
    expect(b.mapSession.auditioning.peek()).toBe(false);
    expect(b.map.timeAt(0)).toBeCloseTo(2.1);
    expect(b.onClose).toHaveBeenCalledWith({result: 'drums'});
    expect(b.toasts.at(-1).text).toBe(COPY.drumsImported(2, 0));
  });

  test('a real import: the drum part is written against the map being tried, then the map is committed', async () => {
    const drums = {hits: [{q: 0, midi: 36, durationQ: 0.25, velocity: 0.8}, {q: 4, midi: 38, durationQ: 0.25, velocity: 0.8}], source: 'midi', warnings: []};
    const b = await bed({importFile: vi.fn(async () => resultAt(2, {format: 'midi', drums}))});
    await pick(new File(['midi'], 'song.mid'));
    $('.find-use-drums').click();
    await vi.waitFor(() => expect(b.onClose).toHaveBeenCalled(), {timeout: 5000});
    expect(b.onClose).toHaveBeenCalledWith({result: 'drums'});
    const part = b.session.notation.part;
    expect(part.score.bars.reduce((n, bar) => n + bar.hits.length, 0)).toBe(2);
    expect(b.ts.partSaves.length).toBeGreaterThan(0);
    expect(b.map.timeAt(0)).toBe(2);
  });

  test('a drum preview that places nothing disables the drum commit with its reason', async () => {
    const drums = {hits: [{q: 1000, midi: 36, durationQ: 0.25, velocity: 0.8}, {q: 1001, midi: 38, durationQ: 0.25, velocity: 0.8}], source: 'midi', warnings: ['Source drum velocities were approximate.']};
    await bed({importFile: vi.fn(async () => resultAt(2, {format: 'midi', drums}))});
    await pick(new File(['x'], 'song.mid'));
    const drumsButton = $('.find-use-drums');
    expect(drumsButton.getAttribute('aria-disabled')).toBe('true');
    expect(drumsButton.textContent).toContain(COPY.noDrumsInside);
    expect($('.find-warnings').textContent).toMatch(/Source drum velocities were approximate/);
    expect($('.find-warnings').textContent).toMatch(/outside the recording/);
  });

  test('a song that already has a drum chart offers only the map', async () => {
    const drums = {hits: [{q: 0, midi: 36, durationQ: 0.25, velocity: 0.8}], source: 'midi', warnings: []};
    const b = await bed({tempo: undefined, duration: undefined, score: demoScore(128, 120), importFile: vi.fn(async () => ({map: b.map.snapshot(), format: 'midi', warnings: [], drums}))});
    await b.session.notation.ready;
    await settle();
    await pick(new File(['x'], 'song.mid'));
    const drumsButton = $('.find-use-drums');
    expect(drumsButton.getAttribute('aria-disabled')).toBe('true');
    expect(drumsButton.textContent).toContain(COPY.hasNotation);
    expect(button(COPY.useTheirs).getAttribute('aria-disabled')).toBeNull();
  });
});

describe('leaving mid-audition (D20)', () => {
  test('to the Stage: the audition ends as Keep my map at once, then "Use this map?" → Use it applies it as one practice-undo step', async () => {
    let answer;
    const b = await bed({confirm: () => new Promise((resolve) => { answer = resolve; })});
    const original = b.map.snapshot();
    await choose('one');
    const tried = b.map.snapshot();
    b.router.leave(b.router.stage());
    expect(json(b.map.snapshot())).toBe(json(original));
    expect(b.mapSession.auditioning.peek()).toBe(false);
    expect(b.onClose).not.toHaveBeenCalled();
    expect(b.feedback.confirm).toHaveBeenCalledWith({title: COPY.leaveTitle, body: COPY.leaveBody('Studio'), confirmLabel: COPY.leaveUse, cancelLabel: COPY.leaveKeep});
    // Edit · Map unmounts: map changes now go on the practice stack (D23).
    b.panel.destroy();
    b.mapSession.destroy();
    b.session.mapEditor.value = null;
    const depth = b.map.undoStack.length;
    answer(true);
    await settle();
    expect(json(b.map.snapshot())).toBe(json(tried));
    expect(b.map.undoStack.length).toBe(depth);
    expect(b.session.undo.canUndo.peek()).toBe(true);
    b.session.undo.undo();
    expect(json(b.map.snapshot())).toBe(json(original));
  });

  test('to another Edit tab: Keep my map in the dialog leaves your map', async () => {
    const b = await bed({confirm: async () => false});
    const original = b.map.snapshot();
    await choose('one');
    b.router.leave(b.router.editChart());
    await settle();
    expect(b.feedback.confirm).toHaveBeenCalledTimes(1);
    expect(json(b.map.snapshot())).toBe(json(original));
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(b.ts.server.calls.saveTempo.filter((c) => c.tempo.songMap.origin === 'imported')).toHaveLength(0);
  });

  test('to this song\'s Edit · Map (closing Find): Keep my map, no question', async () => {
    const b = await bed();
    const original = b.map.snapshot();
    await choose('one');
    b.router.leave(b.router.editMap());
    expect(b.feedback.confirm).not.toHaveBeenCalled();
    expect(json(b.map.snapshot())).toBe(json(original));
    expect(b.mapSession.auditioning.peek()).toBe(false);
  });

  test('to a place that closes the session: your map is kept and a toast says so', async () => {
    const b = await bed();
    const original = b.map.snapshot();
    await choose('one');
    b.router.leave(b.router.library());
    expect(b.feedback.confirm).not.toHaveBeenCalled();
    expect(json(b.map.snapshot())).toBe(json(original));
    expect(b.toasts.at(-1).text).toBe(COPY.leftKept);
  });

  test('hiding the page changes nothing; leaving with Your map chosen asks nothing', async () => {
    const b = await bed();
    await choose('one');
    b.router.leave(null);
    expect(b.mapSession.auditioning.peek()).toBe(true);
    await choose('original');
    b.router.leave(b.router.stage());
    expect(b.feedback.confirm).not.toHaveBeenCalled();
    expect(b.mapSession.auditioning.peek()).toBe(false);
  });

  test('leaving while the drum chart imports keeps that choice: the map is committed', async () => {
    let finish;
    const drums = {hits: [{q: 0, midi: 36, durationQ: 0.25, velocity: 0.8}], source: 'midi', warnings: []};
    const b = await bed({importFile: vi.fn(async () => resultAt(2, {format: 'midi', drums}))});
    vi.spyOn(b.session.notation, 'importScore').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const input = $('input[type=file]');
    Object.defineProperty(input, 'files', {configurable: true, value: [new File(['x'], 'song.mid')]});
    input.dispatchEvent(new Event('change'));
    await settle();
    $('.find-use-drums').click();
    await settle();
    expect($('.find-panel').getAttribute('aria-busy')).toBe('true');
    expect($('.find-controls').disabled).toBe(true);
    expect(button(COPY.keepMine).getAttribute('aria-disabled')).toBe('true');
    b.router.leave(b.router.stage());
    expect(b.mapSession.auditioning.peek()).toBe(false);
    expect(b.map.timeAt(0)).toBe(2);
    finish({count: 1, skipped: 0, notice: ''});
    await settle();
    expect(b.feedback.confirm).not.toHaveBeenCalled();
    expect(b.onClose).not.toHaveBeenCalled();
  });
});

describe('decodeSource and links', () => {
  test('Harmonix beats decode with the catalog meter; MIDI and chart bytes go through parseTempoFile', async () => {
    const beats = await decodeSource({format: 'beats', text: beatText(1), sourceUrl: 'https://example.invalid/hx'}, {duration: 20});
    expect(beats.map.measures.length).toBeGreaterThan(0);
    expect(beats.sourceUrl).toBe('https://example.invalid/hx');
    const chart = '[Song]\n{\n  Resolution = 192\n  Offset = 0\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n';
    const decoded = await decodeSource({format: 'chart', data: new TextEncoder().encode(chart).buffer, sourceUrl: 'https://example.invalid/ch',
      metadata: {delay: '250'}}, {duration: 20});
    expect(decoded.map.pins[0].time).toBeCloseTo(0.25);
    expect(decoded.warnings.join(' ')).toContain('audio delay');
    await expect(decodeSource(null)).rejects.toThrow(COPY.noTiming);
  });

  test('Other sources search for the song; without a title they open the sites', () => {
    expect(otherSourceLinks({title: 'Song', artist: 'Band'})).toEqual({
      enchor: 'https://www.enchor.us/?name=Song&artist=Band', songsterr: 'https://www.songsterr.com/?pattern=Band+Song'});
    expect(otherSourceLinks({})).toEqual({enchor: 'https://www.enchor.us/', songsterr: 'https://www.songsterr.com/'});
  });
});
