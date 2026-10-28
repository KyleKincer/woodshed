// @vitest-environment happy-dom
// The Stage's menus (src/stage/menus.js; architecture §2.14.11, spec §4.5, §4.9, §7.7) on a real
// song session (tests/helpers/test-session.js) with the real §3.1/§3.2 commands on an isolated
// registry. Items are resolved and opened through the real Menu primitive (src/ui/menu.js), so
// labels, key-caps, checked states and disabled reasons are the ones a user sees.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {createRegistry} from '../src/app/commands.js';
import {clock as appClock} from '../src/app/clock.js';
import {signal, readonly} from '../src/app/store.js';
import {Menu, resolveItem} from '../src/ui/menu.js';
import {defineTransportCommands} from '../src/stage/transport-commands.js';
import {defineStageCommands} from '../src/stage/commands.js';
import {mountStrip} from '../src/stage/strip.js';
import {
  COPY, CONTROLS, UNDO_TOAST_MS, addMarkerAt, barMenu, instrumentForStem, loopBandMenu, loopLength, makeMine, markerMenu,
  saveSpot, sectionMenu, spotMenu, spotRangeAt, stageMenu, stemMenu, turnMarkerIntoSection,
} from '../src/stage/menus.js';
import {COPY as STAGE_COPY} from '../src/stage/stage.copy.js';
import {COPY as TRANSPORT_COPY} from '../src/stage/transport-commands.js';
import {emptyScore} from '../shared/notation.ts';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {installCanvasShim, installPopoverShim, installResizeObserverShim, pointer, restoreDomShims, setRect, triggerResize} from './helpers/dom.js';
import {sectioned, tempoOf} from './fixtures/maps.js';

let clock, restoreAudio, current = [];

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(Date.parse('2026-10-28T12:00:00Z'));
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
  installPopoverShim();
  installCanvasShim();
  installResizeObserverShim();
});

afterEach(async () => {
  for (const off of current.splice(0).reverse()) await off();
  document.body.replaceChildren();
  delete document.documentElement.dataset.place;
  restoreDomShims();
  restoreAudio();
  vi.useRealTimers();
});

/** A v2 practice blob. */
function practiceOf(fields = {}) {
  return {v: 2, cue: 0, rate: 1, tracks: [], minusMe: false, trainer: null, spots: [], markers: [], ...fields,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none', ...(fields.loop ?? {})}};
}

/** The rehearsal map with every bar label cleared (mapped, no sections). */
function unlabelled() {
  const tempo = tempoOf(sectioned);
  for (const m of tempo.songMap.measures) m.label = '';
  return tempo;
}

/** A recording feedback: status, toast and a scripted form. */
function recorder() {
  const log = {statuses: [], toasts: [], forms: []};
  let answer = null;
  return {
    log,
    answer(value) { answer = value; },
    status: vi.fn((text, options = {}) => { log.statuses.push({text, ...options}); }),
    toast: vi.fn((text, options = {}) => { log.toasts.push({text, ...options}); return {dismiss() {}}; }),
    form: vi.fn(async (spec) => { log.forms.push(spec); return answer === null ? null : {name: answer}; }),
    confirm: vi.fn(async () => true),
  };
}

/**
 * A session, a registry with the §3.1/§3.2 commands, a Stage stub for the 'stage' context, and a
 * recording feedback, router and store.
 */
async function bed({surface = 'roadmap', stageOver = {}, desktop = false, lastTab = null, ...options} = {}) {
  const ts = await createTestSession({clock, ...(desktop ? {desktop: true} : {}), ...options});
  await ts.session.notation?.ready;
  const reg = createRegistry();
  const offTransport = defineTransportCommands({registry: reg, sheets: {}});
  const offStage = defineStageCommands({registry: reg, later: {}});
  const ran = [];
  reg.register({id: 'app.shortcuts', title: 'Keyboard shortcuts', group: 'App', keys: ['?'], scopes: ['global'], icon: 'keyboard',
    run: () => { ran.push('app.shortcuts'); }});
  const fb = recorder();
  const router = {navigate: vi.fn()};
  const prefs = signal({edit: lastTab ? {lastTab} : {}});
  const surfaceSig = signal(surface);
  const display = signal(null);
  const followStyle = signal('scroll');
  const distance = signal('stand');
  const focus = signal(false);
  const sheets = [];
  const stage = {
    session: ts.session,
    surface: readonly(surfaceSig), display: readonly(display), followStyle: readonly(followStyle), distance: readonly(distance),
    focus: readonly(focus), following: signal(true), shareAvailable: signal(true), menuAvailable: signal(true),
    setSurface: vi.fn((k) => { surfaceSig.value = k; }), cycleSurface: vi.fn(), toggleFocus: vi.fn(() => { focus.value = !focus.peek(); }),
    setDistance: vi.fn((d) => { distance.value = d; }), zoom: vi.fn(), resumeFollow: vi.fn(),
    setDisplay: vi.fn((v) => { display.value = v; }), setFollowStyle: vi.fn((s) => { followStyle.value = s; }),
    openSheet: vi.fn((name) => { sheets.push(name); return {close() {}}; }), closeSheets: vi.fn(),
    openMenu: vi.fn(), share: vi.fn(), startOver: vi.fn(), leave: vi.fn(), close: vi.fn(), scrollBy: vi.fn(), scrollTop: vi.fn(),
    anchors: new Map(), batch: (fn) => fn(),
    ...stageOver,
  };
  reg.provide('session', () => ts.session);
  reg.provide('transport', () => ts.session.transport);
  reg.provide('stage', () => stage);
  reg.provide('feedback', () => fb);
  reg.provide('router', () => router);
  reg.provide('store', () => ({prefs}));
  reg.provide('desktop', () => ({available: desktop}));
  current.push(async () => { offStage(); offTransport(); await ts.dispose(); });
  const opts = {registry: reg, feedback: fb};
  return {
    ts, reg, stage, fb, router, ran, sheets, opts, surfaceSig, display, followStyle,
    get snap() { return ts.snapshot; },
    /** Open items in a real Menu (popover) at a fixed point; returns the handle. */
    open(items, label = 'Menu') {
      const handle = Menu.open(items, {anchor: {x: 10, y: 10}, label, registry: reg, presentation: 'popover'});
      current.push(() => handle.destroy?.());
      return handle;
    },
  };
}

const resolved = (items, reg) => items.map((item) => resolveItem(item, reg));
const labels = (items, reg) => resolved(items, reg).filter((r) => r.type !== 'separator').map((r) => r.label);
const ROLE = {item: 'menuitem', submenu: 'menuitem', checkbox: 'menuitemcheckbox', radio: 'menuitemradio'};
/** Every row of a menu, nested submenus included: [{role, name, parent, kbd, disabled, reason, checked, command}]. */
function rowsOf(items, reg, parent = null) {
  const out = [];
  items.forEach((item) => {
    const r = resolveItem(item, reg);
    if (r.type === 'separator') return;
    out.push({role: ROLE[r.type], name: r.label, parent, kbd: r.kbd, disabled: r.disabled, reason: r.reason, checked: r.checked, command: r.command});
    if (r.type === 'submenu') out.push(...rowsOf(item.items, reg, r.label));
  });
  return out;
}
const find = (items, label) => items.find((item) => item.label === label);
const row = (rows, name, parent) => rows.find((r) => r.name === name && (parent === undefined || r.parent === parent));
/** Choose an item the way the Menu does: run its command (with args), then its run. */
function choose(b, items, label) {
  const item = items.find((i) => resolveItem(i, b.reg).label === label);
  if (!item) throw new Error(`no item ${label}`);
  const r = resolveItem(item, b.reg);
  if (r.disabled) return false;
  if (r.command) b.reg.run(r.command, {source: 'pointer', args: item.args});
  item.run?.({item, source: 'pointer'});
  return true;
}

/** The scenario predicates of CONTROLS' `when`. */
function scenario({mapped = true, part = false, chart = false, sectionsMissing = false, shared = false} = {}) {
  const one = (when) => {
    if (when === 'mapped') return mapped;
    if (when === 'unmapped') return !mapped;
    if (when === 'part') return part;
    if (when === 'chart') return chart;
    if (when === 'sections-missing') return mapped && sectionsMissing;
    if (when === 'owner') return !shared;
    return false;
  };
  return (when) => !when || when.split(/\s+/).every(one);
}

/** A table's rows match the menu's: role, name, and (when the table names them) command and key-cap; plain rows have neither. */
function expectTable(rows, wanted) {
  expect(rows.map((r) => [r.role, r.name])).toEqual(wanted.map((c) => [c.role, c.name]));
  for (const c of wanted) {
    const r = row(rows, c.name);
    expect(r.command ?? null, `${c.name} command`).toBe(c.command ?? null);
    expect(r.kbd ?? null, `${c.name} key-cap`).toBe(c.kbd ?? null);
  }
}

// ---------------------------------------------------------------------------------------------------------------

describe('the ⋯ menu (stageMenu, stage.menu)', () => {
  test('the CONTROLS table, row by row: mapped with a drum part on the Chart', async () => {
    const b = await bed({surface: 'chart', score: emptyScore(128, 120)});
    expect(b.ts.session.notation.part).toBeTruthy();
    const rows = rowsOf(stageMenu(b.ts.session, b.stage, b.opts), b.reg);
    const wanted = CONTROLS.filter((c) => c.menu === 'stage' && scenario({part: true, chart: true})(c.when));
    for (const c of wanted) {
      const r = row(rows, c.name, c.parent ?? null);
      expect(r, `${c.name} (${c.parent ?? 'top'})`).toBeTruthy();
      expect(r.role, c.name).toBe(c.role);
      if (c.command) expect(r.command, c.name).toBe(c.command);
      if (c.kbd) expect(r.kbd, c.name).toBe(c.kbd);
    }
    // Nothing else: every row is in the table.
    expect(rows.length).toBe(wanted.length);
    // The order of the top level (spec §2.14.11).
    expect(labels(stageMenu(b.ts.session, b.stage, b.opts), b.reg)).toEqual([
      'View', 'Display', 'Follow', 'Focus', 'Distance', 'Spots…', 'Notes', 'Tap the beat…', 'Detect beats',
      'Share…', 'Edit map', 'Edit drum chart', 'Edit details', 'Re-split…', 'Keyboard shortcuts']);
  });

  test('unmapped, no part, on the Wave page: Get bars… instead of Detect beats; no Display or Follow; "Wave page" in View', async () => {
    const b = await bed({mapped: false, surface: 'wave'});
    const items = stageMenu(b.ts.session, b.stage, b.opts);
    const rows = rowsOf(items, b.reg);
    const wanted = CONTROLS.filter((c) => c.menu === 'stage' && scenario({mapped: false})(c.when));
    expect(rows.map((r) => r.name).sort()).toEqual(wanted.map((c) => c.name).sort());
    expect(row(rows, 'Wave page', 'View').checked).toBe(true);
    expect(row(rows, 'Get bars…')).toBeTruthy();
    expect(row(rows, 'Detect beats')).toBeUndefined();
    expect(row(rows, 'Display')).toBeUndefined();
    expect(row(rows, 'Follow')).toBeUndefined();
  });

  test('mapped without sections offers Suggest sections; with sections it does not', async () => {
    const plain = await bed({tempo: unlabelled()});
    expect(labels(stageMenu(plain.ts.session, plain.stage, plain.opts), plain.reg)).toContain('Suggest sections');
    const b = await bed();
    expect(labels(stageMenu(b.ts.session, b.stage, b.opts), b.reg)).not.toContain('Suggest sections');
  });

  test('every item is command-bound with its key-cap; E sits on the Edit tab it opens', async () => {
    const b = await bed({lastTab: 'details'});
    const items = stageMenu(b.ts.session, b.stage, b.opts);
    const rows = rowsOf(items, b.reg);
    for (const r of rows.filter((x) => x.role !== 'menuitem' || !['View', 'Display', 'Follow', 'Distance'].includes(x.name))) {
      expect(r.command, r.name).toBeTruthy();
      expect(b.reg.get(r.command), r.name).toBeTruthy();
    }
    expect(row(rows, 'Focus').kbd).toBe('KeyF');
    expect(row(rows, 'Spots…').kbd).toBe('KeyJ');
    expect(row(rows, 'Keyboard shortcuts').kbd).toBe('?');
    expect(row(rows, 'Edit details').kbd).toBe('KeyE');
    expect(row(rows, 'Edit map').kbd).toBeNull();
    const fresh = await bed();
    const freshRows = rowsOf(stageMenu(fresh.ts.session, fresh.stage, fresh.opts), fresh.reg);
    expect(row(freshRows, 'Edit map').kbd).toBe('KeyE');
    expect(row(freshRows, 'Edit details').kbd).toBeNull();
  });

  test('disabled reasons come from the registry: Re-split on the web, Detect without a processor', async () => {
    const b = await bed();
    const rows = rowsOf(stageMenu(b.ts.session, b.stage, b.opts), b.reg);
    expect(row(rows, 'Re-split…')).toMatchObject({disabled: true, reason: STAGE_COPY.resplitDesktop});
    const verdict = b.ts.detect.canDetect.peek();
    expect(verdict.ok).toBe(false);
    expect(row(rows, 'Detect beats')).toMatchObject({disabled: true, reason: verdict.reason});
    const ready = await bed({desktop: true});
    expect(row(rowsOf(stageMenu(ready.ts.session, ready.stage, ready.opts), ready.reg), 'Detect beats').disabled).toBe(false);
  });

  test('a shared song: Edit is hidden (spec §4.13); share, re-split, tap and detect show the read-only reason', async () => {
    const b = await bed({shared: {token: 'share-1'}});
    const rows = rowsOf(stageMenu(b.ts.session, b.stage, b.opts), b.reg);
    for (const name of ['Share…', 'Re-split…', 'Tap the beat…', 'Detect beats']) {
      expect(row(rows, name), name).toMatchObject({disabled: true, reason: STAGE_COPY.readOnly});
    }
    for (const name of ['Edit map', 'Edit drum chart', 'Edit details']) expect(row(rows, name), name).toBeUndefined();
    const wanted = CONTROLS.filter((c) => c.menu === 'stage' && scenario({shared: true})(c.when));
    expect(rows.map((r) => r.name).sort()).toEqual(wanted.map((c) => c.name).sort());
    expect(row(rows, 'Spots…').disabled).toBe(false);
    expect(row(rows, 'Focus').disabled).toBe(false);
  });

  test('Share… explains itself while the share dialog is not built', async () => {
    const b = await bed({stageOver: {shareAvailable: signal(false)}});
    expect(row(rowsOf(stageMenu(b.ts.session, b.stage, b.opts), b.reg), 'Share…')).toMatchObject({disabled: true, reason: STAGE_COPY.notBuilt});
  });

  test('radios follow the Stage: View, Display (the part’s own layout until chosen), Follow, Distance', async () => {
    const b = await bed({surface: 'chart', score: emptyScore(128, 120)});
    let rows = rowsOf(stageMenu(b.ts.session, b.stage, b.opts), b.reg);
    expect(row(rows, 'Chart', 'View').checked).toBe(true);
    expect(row(rows, 'Road map', 'View').checked).toBe(false);
    expect(row(rows, 'Together', 'Display').checked).toBe(true);
    expect(row(rows, 'Hands & feet', 'Display').checked).toBe(false);
    expect(row(rows, 'Scroll', 'Follow').checked).toBe(true);
    expect(row(rows, 'Stand', 'Distance').checked).toBe(true);
    const items = stageMenu(b.ts.session, b.stage, b.opts);
    choose(b, find(items, 'Display').items, 'Hands & feet');
    expect(b.stage.setDisplay).toHaveBeenCalledWith('split');
    choose(b, find(items, 'Follow').items, 'Page');
    expect(b.stage.setFollowStyle).toHaveBeenCalledWith('page');
    choose(b, find(items, 'Distance').items, 'Kit');
    expect(b.stage.setDistance).toHaveBeenCalledWith('kit');
    choose(b, find(items, 'View').items, 'Stems');
    expect(b.stage.setSurface).toHaveBeenCalledWith('stems');
    rows = rowsOf(stageMenu(b.ts.session, b.stage, b.opts), b.reg);
    expect(row(rows, 'Hands & feet', 'Display').checked).toBe(true);
    expect(row(rows, 'Page', 'Follow')).toBeUndefined();   // Follow is the Chart's; Stems now shows
    expect(row(rows, 'Kit', 'Distance').checked).toBe(true);
    expect(row(rows, 'Stems', 'View').checked).toBe(true);
  });

  test('choosing items runs their commands: Focus, Spots…, Notes, Keyboard shortcuts, Edit map', async () => {
    const b = await bed();
    const items = stageMenu(b.ts.session, b.stage, b.opts);
    choose(b, items, 'Focus');
    expect(b.stage.toggleFocus).toHaveBeenCalled();
    choose(b, items, 'Spots…');
    choose(b, items, 'Notes');
    expect(b.sheets).toEqual(['spots', 'notes']);
    choose(b, items, 'Keyboard shortcuts');
    expect(b.ran).toEqual(['app.shortcuts']);
    choose(b, items, 'Edit map');
    expect(b.router.navigate).toHaveBeenCalledWith(`/s/${b.ts.id}/edit/map`);
  });

  test('in the real Menu: roles, submenus, key-caps (aria-keyshortcuts) and a visible reason', async () => {
    const b = await bed();
    const menu = b.open(stageMenu(b.ts.session, b.stage, b.opts), 'More…');
    const el = menu.el;
    expect(el.getAttribute('role')).toBe('menu');
    const named = (name) => [...el.querySelectorAll('.ui-menu-item')].find((r) => r.querySelector('.ui-menu-label')?.textContent === name);
    expect(named('View').getAttribute('aria-haspopup')).toBe('menu');
    expect(named('Focus').getAttribute('role')).toBe('menuitemcheckbox');
    expect(named('Focus').getAttribute('aria-keyshortcuts')).toBe('F');
    const resplit = named('Re-split…');
    expect(resplit.getAttribute('aria-disabled')).toBe('true');
    expect(resplit.querySelector('.ui-menu-reason').textContent).toBe(STAGE_COPY.resplitDesktop);
    expect(el.querySelectorAll('[role=separator]')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('the bar menu (barMenu, spec §4.9)', () => {
  test('the CONTROLS table: mapped and unmapped', async () => {
    const b = await bed();
    const rows = rowsOf(barMenu(b.ts.session, {t: 41, bar: 21}, b.opts), b.reg);
    const wanted = CONTROLS.filter((c) => c.menu === 'bar' && scenario({mapped: true})(c.when));
    expect(rows.map((r) => [r.role, r.name])).toEqual(wanted.map((c) => [c.role, c.name]));
    const u = await bed({mapped: false});
    const urows = rowsOf(barMenu(u.ts.session, {t: 41}, u.opts), u.reg);
    const uwanted = CONTROLS.filter((c) => c.menu === 'bar' && scenario({mapped: false})(c.when));
    expect(urows.map((r) => [r.role, r.name])).toEqual(uwanted.map((c) => [c.role, c.name]));
    for (const r of urows) expect(r.name.toLowerCase(), 'unmapped never says bar').not.toMatch(/\bbars?\b/);
  });

  test('mapped: play from the beat, cue the beat, loop this bar / section / 4 bars from here', async () => {
    const b = await bed();
    const items = barMenu(b.ts.session, {t: 41.2}, b.opts);   // bar 21 (40–42 s), nearest beat 41.0
    choose(b, items, 'Cue here');
    expect(b.snap.cue).toBeCloseTo(41, 6);
    choose(b, items, 'Loop this bar');
    expect(b.snap.loop).toMatchObject({on: true, a: 40, b: 42});
    choose(b, items, 'Loop this section');
    expect(b.snap.loop).toMatchObject({on: true, a: 32, b: 48, label: 'Chorus'});
    choose(b, items, 'Loop 4 bars from here');
    expect(b.snap.loop).toMatchObject({on: true, a: 40, b: 48});
    b.ts.transport.clearLoop();
    choose(b, items, 'Play from here');
    await settle();
    expect(['playing', 'counting']).toContain(b.snap.phase);
    expect(b.ts.transport.position()).toBeCloseTo(41, 1);
  });

  test('mapped without sections: Loop this section is disabled with the reason', async () => {
    const b = await bed({tempo: unlabelled()});
    const rows = rowsOf(barMenu(b.ts.session, {t: 41}, b.opts), b.reg);
    expect(row(rows, 'Loop this section')).toMatchObject({disabled: true, reason: TRANSPORT_COPY.noSections});
  });

  test('Save spot here… asks for the name (pre-filled) and saves the section around t as one undo step', async () => {
    const b = await bed();
    b.fb.answer('Chorus groove');
    choose(b, barMenu(b.ts.session, {t: 41}, b.opts), 'Save spot here…');
    await settle();
    expect(b.fb.log.forms[0].fields[0]).toMatchObject({name: 'name', value: 'Chorus', required: true});
    expect(b.ts.value.spots).toHaveLength(1);
    expect(b.ts.value.spots[0]).toMatchObject({name: 'Chorus groove', a: 32, b: 48, rate: 1});
    expect(b.fb.log.statuses.at(-1).text).toBe('Saved spot Chorus groove · 100%');
    b.ts.undo.undo();
    expect(b.ts.value.spots.filter((s) => !s.deleted)).toHaveLength(0);
  });

  test('Save spot here… inside the loop saves the loop, which becomes the active spot; Cancel saves nothing', async () => {
    const b = await bed({practice: practiceOf({loop: {on: true, a: 40, b: 44}, cue: 40})});
    b.fb.answer(null);
    choose(b, barMenu(b.ts.session, {t: 41}, b.opts), 'Save spot here…');
    await settle();
    expect(b.ts.value.spots).toHaveLength(0);
    b.fb.answer('Fill');
    choose(b, barMenu(b.ts.session, {t: 41}, b.opts), 'Save spot here…');
    await settle();
    expect(b.fb.log.forms[1].fields[0].value).toBe('Bars 21–22');
    const spot = b.ts.value.spots[0];
    expect(spot).toMatchObject({name: 'Fill', a: 40, b: 44});
    expect(b.ts.practice.activeSpotId.peek()).toBe(spot.id);
  });

  test('Add section here labels the bar under t (one undo step); at a section start it is disabled with the reason', async () => {
    const b = await bed();
    choose(b, barMenu(b.ts.session, {t: 41}, b.opts), 'Add section here');
    expect(b.ts.map.sections.find((s) => s.startBar === 20)?.name).toBe('Section 9');
    expect(b.fb.log.statuses.at(-1).text).toBe('Section 9 added');
    b.ts.undo.undo();
    expect(b.ts.map.sections.find((s) => s.startBar === 20)).toBeUndefined();
    const rows = rowsOf(barMenu(b.ts.session, {t: 32.5}, b.opts), b.reg);
    expect(row(rows, 'Add section here')).toMatchObject({disabled: true, reason: 'Bar 17 already starts Chorus'});
  });

  test('unmapped: cue at the time, loop 10 s from here, a marker at t; Loop this part needs markers', async () => {
    const b = await bed({mapped: false});
    let items = barMenu(b.ts.session, {t: 41.37}, b.opts);
    expect(row(rowsOf(items, b.reg), 'Loop this part')).toMatchObject({disabled: true, reason: TRANSPORT_COPY.noRegions});
    choose(b, items, 'Cue here');
    expect(b.snap.cue).toBeCloseTo(41.37, 6);
    choose(b, items, 'Loop 10 s from here');
    expect(b.snap.loop).toMatchObject({on: true});
    expect(b.snap.loop.a).toBeCloseTo(41.37, 6);
    expect(b.snap.loop.b).toBeCloseTo(51.37, 6);
    choose(b, items, 'Add marker here');
    expect(b.ts.value.markers).toHaveLength(1);
    expect(b.ts.value.markers[0].t).toBeCloseTo(41.37, 6);
    items = barMenu(b.ts.session, {t: 60}, b.opts);
    choose(b, items, 'Loop this part');
    expect(b.snap.loop.a).toBeCloseTo(41.37, 6);
    expect(b.snap.loop.b).toBeCloseTo(128, 3);
  });

  test('nothing for a press without a time', async () => {
    const b = await bed();
    expect(barMenu(b.ts.session, {}, b.opts)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('the section menu (sectionMenu, spec §4.5)', () => {
  const regionOf = (b, name) => b.ts.position.regions().find((r) => r.label === name);

  test('the CONTROLS table: a section, and a marker region on an unmapped song', async () => {
    const b = await bed();
    const rows = rowsOf(sectionMenu(b.ts.session, regionOf(b, 'Bridge'), {...b.opts, t: 85}), b.reg);
    expect(rows.map((r) => [r.role, r.name])).toEqual(
      CONTROLS.filter((c) => c.menu === 'section' && scenario({mapped: true})(c.when)).map((c) => [c.role, c.name]));
    const u = await bed({mapped: false, practice: practiceOf({markers: [{id: 'm1', t: 12, label: 'Groove', updatedAt: 1}]})});
    const urows = rowsOf(sectionMenu(u.ts.session, u.ts.position.regions()[0], u.opts), u.reg);
    expect(urows.map((r) => [r.role, r.name])).toEqual(
      CONTROLS.filter((c) => c.menu === 'section' && scenario({mapped: false})(c.when)).map((c) => [c.role, c.name]));
    for (const r of urows) expect(r.name.toLowerCase()).not.toMatch(/\bbars?\b/);
  });

  test('Play from here, Loop this section, Extend loop to here (disabled inside the loop)', async () => {
    const b = await bed();
    const bridge = regionOf(b, 'Bridge');   // 80–96
    choose(b, sectionMenu(b.ts.session, bridge, {...b.opts, t: 85}), 'Loop this section');
    expect(b.snap.loop).toMatchObject({on: true, a: 80, b: 96, label: 'Bridge'});
    const inside = rowsOf(sectionMenu(b.ts.session, bridge, {...b.opts, t: 85}), b.reg);
    expect(row(inside, 'Extend loop to here')).toMatchObject({disabled: true, reason: COPY.insideLoop});
    const outro = regionOf(b, 'Outro');   // 112–128
    choose(b, sectionMenu(b.ts.session, outro, {...b.opts, t: 113}), 'Extend loop to here');
    expect(b.snap.loop).toMatchObject({on: true, a: 80, b: 114});
    b.ts.transport.clearLoop();
    choose(b, sectionMenu(b.ts.session, outro, b.opts), 'Play from here');
    await settle();
    expect(b.ts.transport.position()).toBeCloseTo(112, 1);
  });

  test('Save as spot… pre-fills the section name', async () => {
    const b = await bed();
    b.fb.answer('Bridge');
    choose(b, sectionMenu(b.ts.session, regionOf(b, 'Bridge'), b.opts), 'Save as spot…');
    await settle();
    expect(b.fb.log.forms[0].fields[0].value).toBe('Bridge');
    expect(b.ts.value.spots[0]).toMatchObject({name: 'Bridge', a: 80, b: 96});
  });

  test('Rename… uses the caller’s inline field, else a form (one undo step); Edit sections in Map navigates', async () => {
    const b = await bed();
    const rename = vi.fn(() => true);
    choose(b, sectionMenu(b.ts.session, regionOf(b, 'Bridge'), {...b.opts, rename}), 'Rename…');
    expect(rename).toHaveBeenCalled();
    expect(b.fb.form).not.toHaveBeenCalled();
    b.fb.answer('Breakdown');
    choose(b, sectionMenu(b.ts.session, regionOf(b, 'Bridge'), b.opts), 'Rename…');
    await settle();
    expect(b.fb.log.forms[0].fields[0].value).toBe('Bridge');
    expect(b.ts.position.regions().map((r) => r.label)).toContain('Breakdown');
    b.ts.undo.undo();
    expect(b.ts.position.regions().map((r) => r.label)).toContain('Bridge');
    choose(b, sectionMenu(b.ts.session, regionOf(b, 'Bridge'), b.opts), 'Edit sections in Map');
    expect(b.router.navigate).toHaveBeenCalledWith(`/s/${b.ts.id}/edit/map`);
  });

  test('a shared song cannot rename sections or edit the map; marker regions rename locally', async () => {
    const b = await bed({shared: {token: 'share-2'}});
    const rows = rowsOf(sectionMenu(b.ts.session, regionOf(b, 'Bridge'), b.opts), b.reg);
    expect(row(rows, 'Rename…')).toMatchObject({disabled: true, reason: STAGE_COPY.readOnly});
    expect(row(rows, 'Edit sections in Map')).toBeUndefined();
    expect(rows.map((r) => [r.role, r.name])).toEqual(
      CONTROLS.filter((c) => c.menu === 'section' && scenario({mapped: true, shared: true})(c.when)).map((c) => [c.role, c.name]));
    expect(row(rows, 'Loop this section').disabled).toBe(false);
  });

  test('the strip opens it: a long-press and a right-click on a segment show Loop this section and Rename…', async () => {
    const b = await bed();
    const host = document.body.appendChild(document.createElement('div'));
    const strip = mountStrip(host, {session: b.ts.session, registry: b.reg});
    current.push(() => strip.destroy());
    const track = host.querySelector('.strip-track');
    const slider = host.querySelector('[role=slider]');
    setRect(track, {x: 0, y: 0, width: 800, height: 56});
    setRect(host.querySelector('.strip-content'), {x: 0, y: 0, width: 800, height: 56});
    triggerResize(track);
    const menuLabels = () => [...document.querySelectorAll('[role=menu] .ui-menu-label')].map((n) => n.textContent);
    pointer(slider, 'pointerdown', {x: 250, y: 20, pointerType: 'touch', pointerId: 2});
    vi.advanceTimersByTime(360);
    pointer(slider, 'pointerup', {x: 250, y: 20, pointerType: 'touch', pointerId: 2});
    await vi.advanceTimersByTimeAsync(10);
    expect(menuLabels()).toEqual(['Play from here', 'Loop this section', 'Extend loop to here', 'Save as spot…', 'Rename…', 'Edit sections in Map']);
    expect(document.querySelector('[role=menu]').getAttribute('aria-label')).toBe('Chorus');
    expect(b.snap.cue).toBe(0);
    document.querySelector('[role=menu] .ui-menu-item').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    await settle();
    // press.js swallows the browser's own contextmenu for 800 ms after a handled menu.
    await vi.advanceTimersByTimeAsync(900);
    slider.dispatchEvent(new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 650, clientY: 20, button: 2}));
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector('[role=menu]').getAttribute('aria-label')).toBe('Chorus 3');
    const loopRow = [...document.querySelectorAll('[role=menu] .ui-menu-item')].find((r) => r.textContent.includes('Loop this section'));
    loopRow.click();
    expect(b.snap.loop).toMatchObject({on: true, a: 96, b: 112});
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('spot, marker, loop-band and stem menus (spec §7.7)', () => {
  const SPOT = {id: 'spot-fill', name: 'Fill', a: 28, b: 32, rate: 0.8, passes: 3, updatedAt: 1};

  test('spotMenu: the table; Open sets loop, speed and the active spot', async () => {
    const b = await bed({practice: practiceOf({spots: [SPOT]})});
    const onOpen = vi.fn();
    const items = spotMenu(b.ts.session, SPOT, {...b.opts, onOpen});
    expectTable(rowsOf(items, b.reg), CONTROLS.filter((c) => c.menu === 'spot'));
    choose(b, items, 'Open');
    expect(b.snap.loop).toMatchObject({on: true, a: 28, b: 32});
    expect(b.snap.rate).toBe(0.8);
    expect(b.ts.practice.activeSpotId.peek()).toBe('spot-fill');
    expect(onOpen).toHaveBeenCalledWith(SPOT);
  });

  test('spotMenu: Rename… (form), Update from current (loop + speed), Delete with an 8 s Undo toast', async () => {
    const b = await bed({practice: practiceOf({spots: [SPOT], loop: {on: true, a: 40, b: 48}, cue: 40, rate: 0.9})});
    b.fb.answer('Big fill');
    choose(b, spotMenu(b.ts.session, SPOT, b.opts), 'Rename…');
    await settle();
    expect(b.ts.value.spots[0].name).toBe('Big fill');
    choose(b, spotMenu(b.ts.session, SPOT, b.opts), 'Update from current');
    expect(b.ts.value.spots[0]).toMatchObject({a: 40, b: 48, rate: 0.9});
    expect(b.fb.log.statuses.at(-1).text).toBe('Updated spot Big fill · 90%');
    choose(b, spotMenu(b.ts.session, SPOT, b.opts), 'Delete');
    expect(b.ts.value.spots.filter((s) => !s.deleted)).toHaveLength(0);
    const toast = b.fb.log.toasts.at(-1);
    expect(toast).toMatchObject({text: 'Deleted spot Big fill', durationMs: UNDO_TOAST_MS});
    toast.action.run();
    expect(b.ts.value.spots.filter((s) => !s.deleted).map((s) => s.name)).toEqual(['Big fill']);
  });

  test('markerMenu: Rename…, Delete (undoable), and on a mapped song Turn into section as one undo step', async () => {
    const markers = [{id: 'mk', t: 41, label: 'Flam', updatedAt: 1}];
    const u = await bed({mapped: false, practice: practiceOf({markers})});
    const uitems = markerMenu(u.ts.session, markers[0], u.opts);
    expect(labels(uitems, u.reg)).toEqual(['Rename…', 'Delete']);
    choose(u, uitems, 'Delete');
    expect(u.ts.value.markers.filter((m) => !m.deleted)).toHaveLength(0);
    expect(u.fb.log.toasts.at(-1).text).toBe('Deleted Flam');
    u.fb.log.toasts.at(-1).action.run();
    expect(u.ts.value.markers.map((m) => m.label)).toEqual(['Flam']);

    const b = await bed({practice: practiceOf({markers})});
    const items = markerMenu(b.ts.session, markers[0], b.opts);
    expectTable(rowsOf(items, b.reg), CONTROLS.filter((c) => c.menu === 'marker'));
    choose(b, items, 'Turn into section');
    expect(b.ts.map.sections.find((s) => s.startBar === 20)?.name).toBe('Flam');
    expect(b.ts.value.markers.filter((m) => !m.deleted)).toHaveLength(0);
    b.ts.undo.undo();
    expect(b.ts.map.sections.find((s) => s.startBar === 20)).toBeUndefined();
    expect(b.ts.value.markers.map((m) => m.label)).toEqual(['Flam']);
    b.ts.undo.redo();
    expect(b.ts.map.sections.find((s) => s.startBar === 20)?.name).toBe('Flam');
    expect(b.ts.value.markers.filter((m) => !m.deleted)).toHaveLength(0);
  });

  test('loopBandMenu: command-bound rows with key-caps, Move by the loop’s length, Zoom to loop when a surface offers it', async () => {
    const b = await bed({practice: practiceOf({loop: {on: true, a: 32, b: 48}, cue: 32})});
    const rows = rowsOf(loopBandMenu(b.ts.session, b.opts), b.reg);
    expect(rows.map((r) => [r.role, r.name])).toEqual(
      CONTROLS.filter((c) => c.menu === 'loopBand').map((c) => [c.role, c.name]));
    for (const c of CONTROLS.filter((x) => x.menu === 'loopBand')) {
      expect(row(rows, c.name).command).toBe(c.command);
      expect(row(rows, c.name).kbd).toBe(c.kbd ?? null);
    }
    expect(row(rows, TRANSPORT_COPY.eachPass).checked).toBe(true);
    const zoom = vi.fn();
    const zoomed = loopBandMenu(b.ts.session, {...b.opts, zoomToLoop: zoom});
    expect(labels(zoomed, b.reg)).toContain('Zoom to loop');
    choose(b, zoomed, 'Zoom to loop');
    expect(zoom).toHaveBeenCalled();
    b.reg.register({id: 'stems.zoomLoop', title: 'Zoom to loop', group: 'View', keys: ['KeyZ'], scopes: ['stage.stems'], run: zoom});
    expect(row(rowsOf(loopBandMenu(b.ts.session, b.opts), b.reg), 'Zoom to loop')).toMatchObject({command: 'stems.zoomLoop', kbd: 'KeyZ'});
    choose(b, loopBandMenu(b.ts.session, b.opts), 'Move 8 bars ▶');
    expect(b.snap.loop).toMatchObject({a: 48, b: 64});
    choose(b, loopBandMenu(b.ts.session, b.opts), 'Clear');
    expect(b.snap.loop.on).toBe(false);
    b.ts.undo.undo();
    expect(b.snap.loop).toMatchObject({on: true, a: 48, b: 64});
  });

  test('loopLength: whole bars on a mapped song, seconds otherwise', async () => {
    const b = await bed();
    expect(loopLength(b.ts.session, {a: 32, b: 48})).toBe('8 bars');
    expect(loopLength(b.ts.session, {a: 32, b: 34})).toBe('1 bar');
    expect(loopLength(b.ts.session, {a: 32.5, b: 40})).toBe('7.5 s');
    const u = await bed({mapped: false});
    expect(loopLength(u.ts.session, {a: 31.2, b: 41})).toBe('9.8 s');
    expect(loopBandMenu(u.ts.session, u.opts).map((i) => i.label).filter(Boolean).join(' ').toLowerCase()).not.toMatch(/\bbars?\b/);
  });

  test('stemMenu: Mute and Solo are the keyed mix commands; Reset level; This is my instrument', async () => {
    const account = {profile: signal({instruments: ['drums'], primary: 'drums', openWithMyPart: 'in'}), patch: vi.fn(async () => {})};
    const b = await bed({practice: practiceOf({tracks: [{name: 'bass', volume: 0.5, muted: false, soloed: false}]})});
    const items = stemMenu(b.ts.session, 'bass', {...b.opts, account});
    const rows = rowsOf(items, b.reg);
    // The table's example is the first stem; bass is the second, so its keyed commands end in 2.
    expectTable(rows, CONTROLS.filter((c) => c.menu === 'stem').map((c) => (c.command
      ? {...c, command: c.command.replace(/1$/, '2'), kbd: c.kbd.replace(/1$/, '2')} : c)));
    expect(row(rows, 'Mute')).toMatchObject({command: 'mix.mute.2', kbd: 'Digit2', checked: false});
    expect(row(rows, 'Solo')).toMatchObject({command: 'mix.solo.2', kbd: 'Shift+Digit2'});
    choose(b, items, 'Mute');
    expect(b.snap.mix.tracks.find((t) => t.name === 'bass').muted).toBe(true);
    choose(b, items, 'Reset level');
    expect(b.snap.mix.tracks.find((t) => t.name === 'bass').volume).toBe(1);
    expect(row(rowsOf(stemMenu(b.ts.session, 'bass', b.opts), b.reg), 'Reset level')).toMatchObject({disabled: true, reason: COPY.levelFull});
    choose(b, items, 'This is my instrument');
    await settle();
    expect(account.patch).toHaveBeenCalledWith({profile: {instruments: ['bass', 'drums'], primary: 'bass', openWithMyPart: 'in'}});
    expect(b.fb.log.statuses.at(-1).text).toBe('Bass is now your instrument');
    expect(row(rowsOf(stemMenu(b.ts.session, 'drums', b.opts), b.reg), 'This is my instrument')).toMatchObject({checked: true, disabled: true, reason: COPY.alreadyMine});
  });

  test('stemMenu: a two-part stem is not an instrument; a failed save says so', async () => {
    const b = await bed({stems: ['drums', 'no_drums']});
    expect(row(rowsOf(stemMenu(b.ts.session, 'no_drums', b.opts), b.reg), 'This is my instrument')).toMatchObject({disabled: true, reason: COPY.noInstrument});
    expect(instrumentForStem('piano')).toBe('keys');
    expect(instrumentForStem('no_drums')).toBeNull();
    const account = {profile: signal({instruments: [], primary: null, openWithMyPart: 'in'}), patch: vi.fn(async () => { throw new Error('offline'); })};
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await makeMine('guitar', {...b.opts, account})).toBe(false);
    warn.mockRestore();
    expect(b.fb.log.toasts.at(-1)).toMatchObject({text: COPY.mineFailed, tone: 'error'});
    expect(stemMenu(b.ts.session, 'piano', b.opts)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('review fixes (ST8a fix pass)', () => {
  const SPOT = {id: 's1', name: 'Fill', a: 28, b: 32, rate: 0.8, passes: 3, updatedAt: 1};

  test('the Undo on a delete toast never undoes a newer change; it works again once that change is undone', async () => {
    const b = await bed({practice: practiceOf({spots: [SPOT]})});
    choose(b, spotMenu(b.ts.session, SPOT, b.opts), 'Delete');
    const toast = b.fb.log.toasts.at(-1);
    b.ts.transport.setLoopOptions({playTimes: 4});
    toast.action.run();
    expect(b.snap.loop.playTimes).toBe(4);
    expect(b.ts.value.spots.filter((s) => !s.deleted)).toHaveLength(0);
    expect(b.fb.log.statuses.at(-1).text).toBe(COPY.undoStale);
    b.ts.undo.undo();   // the newer change
    expect(b.snap.loop.playTimes).toBe(0);
    toast.action.run();
    expect(b.ts.value.spots.filter((s) => !s.deleted).map((s) => s.id)).toEqual(['s1']);
  });

  test('the marker delete toast is bound to its own step too', async () => {
    const markers = [{id: 'mk', t: 41, label: 'Flam', updatedAt: 1}];
    const u = await bed({mapped: false, practice: practiceOf({markers})});
    choose(u, markerMenu(u.ts.session, markers[0], u.opts), 'Delete');
    const toast = u.fb.log.toasts.at(-1);
    u.ts.transport.setSpeed(0.8);
    toast.action.run();
    expect(u.snap.rate).toBe(0.8);
    expect(u.ts.value.markers.filter((m) => !m.deleted)).toHaveLength(0);
  });

  test('deleting the active spot and undoing makes it active again', async () => {
    const b = await bed({practice: practiceOf({spots: [SPOT]})});
    choose(b, spotMenu(b.ts.session, SPOT, b.opts), 'Open');
    expect(b.ts.practice.activeSpotId.peek()).toBe('s1');
    choose(b, spotMenu(b.ts.session, SPOT, b.opts), 'Delete');
    expect(b.ts.practice.activeSpotId.peek()).toBeNull();
    b.ts.undo.undo();
    expect(b.ts.value.spots.filter((s) => !s.deleted).map((s) => s.id)).toEqual(['s1']);
    expect(b.ts.practice.activeSpotId.peek()).toBe('s1');
    b.ts.undo.redo();
    expect(b.ts.value.spots.filter((s) => !s.deleted)).toHaveLength(0);
  });

  test('Open on a spot deleted after the menu was built does nothing and does not call onOpen', async () => {
    const b = await bed({practice: practiceOf({spots: [SPOT]})});
    const onOpen = vi.fn();
    const items = spotMenu(b.ts.session, SPOT, {...b.opts, onOpen});
    b.ts.practice.deleteSpot('s1');
    choose(b, items, 'Open');
    expect(onOpen).not.toHaveBeenCalled();
    expect(b.snap.loop.on).toBe(false);
  });

  test('Turn into section next to a named section is disabled with the reason and changes nothing', async () => {
    const marker = {id: 'mk', t: 32.3, label: 'Marker 1', updatedAt: 1};
    const b = await bed({practice: practiceOf({markers: [marker]})});
    const before = b.ts.map.sections.map((s) => s.name);
    expect(row(rowsOf(markerMenu(b.ts.session, marker, b.opts), b.reg), 'Turn into section'))
      .toMatchObject({disabled: true, reason: 'Bar 17 already starts Chorus'});
    expect(turnMarkerIntoSection(b.ts.session, marker, b.opts)).toBe(false);
    expect(b.ts.map.sections.map((s) => s.name)).toEqual(before);
    expect(b.ts.value.markers.filter((m) => !m.deleted)).toHaveLength(1);
  });

  test('Loop 10 s from here near the end moves back to keep 10 s', async () => {
    const b = await bed({mapped: false});
    choose(b, barMenu(b.ts.session, {t: 127.99}, b.opts), 'Loop 10 s from here');
    expect(b.snap.loop.on).toBe(true);
    expect(b.snap.loop.a).toBeCloseTo(118, 3);
    expect(b.snap.loop.b).toBeCloseTo(128, 3);
  });

  test('Loop this part before the first marker loops from the start up to it', async () => {
    const b = await bed({mapped: false, practice: practiceOf({markers: [{id: 'm1', t: 20, label: 'Verse', updatedAt: 1}]})});
    const items = barMenu(b.ts.session, {t: 5}, b.opts);
    expect(row(rowsOf(items, b.reg), 'Loop this part').disabled).toBe(false);
    choose(b, items, 'Loop this part');
    expect(b.snap.loop).toMatchObject({on: true, a: 0});
    expect(b.snap.loop.b).toBeCloseTo(20, 6);
  });

  test('This is my instrument needs a signed-in account', async () => {
    const b = await bed({practice: practiceOf({tracks: [{name: 'bass', volume: 1, muted: false, soloed: false}]})});
    const account = {loaded: signal(false), profile: signal({instruments: [], primary: null, openWithMyPart: 'in'}), patch: vi.fn(async () => {})};
    const r = row(rowsOf(stemMenu(b.ts.session, 'bass', {...b.opts, account}), b.reg), 'This is my instrument');
    expect(r).toMatchObject({disabled: true, reason: COPY.signInForMine});
    const shared = await bed({shared: {token: 'share-3'}});
    expect(row(rowsOf(stemMenu(shared.ts.session, 'bass', {...shared.opts, account}), shared.reg), 'This is my instrument'))
      .toMatchObject({disabled: true, reason: COPY.signInForMine});
    account.loaded.value = true;
    expect(row(rowsOf(stemMenu(b.ts.session, 'bass', {...b.opts, account}), b.reg), 'This is my instrument').disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('shared actions', () => {
  test('saveSpot: the 24-spot limit, bar refs on mapped songs, and one undo step', async () => {
    const spots = Array.from({length: 24}, (_, i) => ({id: `s${i}`, name: `S${i}`, a: i, b: i + 1, rate: 1, passes: 0, updatedAt: 1}));
    const full = await bed({practice: practiceOf({spots})});
    expect(saveSpot(full.ts.session, {a: 40, b: 48, name: 'X'}, full.opts)).toBeNull();
    expect(full.fb.log.statuses.at(-1).text).toBe(STAGE_COPY.spotsFull);
    const b = await bed();
    const id = saveSpot(b.ts.session, {a: 40, b: 48, name: '  Groove  '}, b.opts);
    const spot = b.ts.value.spots.find((s) => s.id === id);
    expect(spot).toMatchObject({name: 'Groove', a: 40, b: 48});
    expect(spot.aBar).toBeTruthy();
    expect(saveSpot(b.ts.session, {a: 40, b: 40, name: 'empty'}, b.opts)).toBeNull();
  });

  test('spotRangeAt: the loop holding t, else the region, else the default loop', async () => {
    const b = await bed({practice: practiceOf({loop: {on: true, a: 40, b: 44}, cue: 40})});
    expect(spotRangeAt(b.ts.session, 41)).toMatchObject({a: 40, b: 44});
    expect(spotRangeAt(b.ts.session, 85)).toMatchObject({a: 80, b: 96, name: 'Bridge'});
    const plain = await bed({tempo: unlabelled()});
    expect(spotRangeAt(plain.ts.session, 41)).toMatchObject({a: 40, b: 48});
  });

  test('addMarkerAt on a shared mapped song adds a local marker; turnMarkerIntoSection refuses there', async () => {
    const b = await bed({shared: {token: 'share-3'}});
    const added = addMarkerAt(b.ts.session, 41, b.opts);
    expect(added).toMatchObject({kind: 'marker'});
    expect(turnMarkerIntoSection(b.ts.session, {id: added.id}, b.opts)).toBe(false);
  });
});
