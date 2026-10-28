// @vitest-environment happy-dom
// The Stage frame (architecture §2.14.10, §2.14.11, §3.2, §9.10 ST4; spec §4): the §3.2 commands,
// the sheets host, and the mounted view on a real session (tests/helpers/test-session.js): rail and
// band, the 150 ms relayout with the anchor kept, Distance, Focus, loading and errors, the resume
// chip and Start over, ?spot ?bar ?t ?set, leaving (hold, Esc, Back), the surface default rule and
// crossfade, the Library → Stage View Transition, the per-session platform services, store.stage,
// the status line (offers, undo feedback), the recording banner, glass and the copy table.
//
// stage.js imports ST5's hud.js and controls.js and ST6's strip.js (same-wave peers, §9.0). They
// are mocked here; the suites that import stage.js are skipped until the three files exist
// (Appendix C item 60) and run at integration I2a. The commands and the sheets host need no peer.
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest';

const hoisted = vi.hoisted(() => ({huds: [], controls: [], strips: [], decode: {codec: false}}));
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: (e) => !!e?.codecError}));
vi.mock('../src/stage/hud.js', () => ({
  mountHud: (el, opts) => {
    const cover = document.createElement('span');
    cover.className = 'test-hud-cover';
    cover.dataset.stageCover = '';
    el.append(cover);
    const hud = {el, opts, cover, setLayout: vi.fn(), setFocus: vi.fn(), destroy: vi.fn(() => cover.remove())};
    hoisted.huds.push(hud);
    return hud;
  },
}));
vi.mock('../src/stage/controls.js', () => ({
  CONTROL_SET: [],
  mountControls: (el, opts) => {
    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = 'Play';
    play.dataset.stageAnchor = 'play';
    const mix = document.createElement('button');
    mix.type = 'button';
    mix.textContent = 'Mix';
    mix.dataset.stageAnchor = 'mix';
    el.append(play, mix);
    const c = {el, opts, play, destroy: vi.fn(() => { play.remove(); mix.remove(); })};
    hoisted.controls.push(c);
    return c;
  },
}));
vi.mock('../src/stage/strip.js', () => ({
  mountStrip: (el, opts) => {
    const s = {el, opts, destroy: vi.fn()};
    hoisted.strips.push(s);
    return s;
  },
}));

import {createRegistry} from '../src/app/commands.js';
import {clock as appClock} from '../src/app/clock.js';
import {signal, store} from '../src/app/store.js';
import {prefs} from '../src/app/prefs.js';
import * as feedback from '../src/app/feedback.js';
import {defineGlobalCommands} from '../src/app/global-commands.js';
import {ApiError} from '../src/api/client.js';
import {defineTransportCommands} from '../src/stage/transport-commands.js';
import {
  DISPLAY_LAYOUTS, STAGE_COMMAND_IDS, addMarkerHere, defineStageCommands, openSpot, saveSpotHere, undoStep,
} from '../src/stage/commands.js';
import {POPOVER_WIDTH, SHEETS, closeSheets, openSheet, openSheetName, setSheetModules} from '../src/stage/sheets/host.js';
import {COPY, CONTROLS, loadingLabel, mixWord, resumeText} from '../src/stage/stage.copy.js';
import {SongMapStore} from '../src/js/song-map.js';
import {fakeStemcache, FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {installPopoverShim, restoreDomShims} from './helpers/dom.js';
import {sectioned} from './fixtures/maps.js';

const S = 'stage', EM = 'edit.map', L = 'library', E = 'edit';
const SECTIONS = SongMapStore.fromTempo(structuredClone(sectioned.tempo), sectioned.duration).sections;
const CHORUS = SECTIONS.find((s) => s.name === 'Chorus');

/** §3.2, row by row: [id, group, keys, scopes, pedal]. */
const TABLE = [
  ['marker.add', 'Practice', ['KeyS'], [S], true],
  ['spot.save', 'Practice', ['KeyB'], [S], true],
  ['spot.list', 'Practice', ['KeyJ'], [S], false],
  ['spot.open', 'Practice', [], [S], false],
  ['stage.menu', 'View', [], [S], false],
  ['song.resplit', 'Library', [], [S, L], false],
  ['map.detect', 'Map', [], [S, EM], false],
  ['map.find', 'Map', [], [S, EM], false],
  ['sections.suggest', 'Map', [], [S, EM], false],
  ['sections.keepAll', 'Map', [], [S, EM], false],
  ['sections.review', 'Map', [], [S, EM], false],
  ['view.cycle', 'View', ['KeyV'], [S], false],
  ['view.chart', 'View', [], [S], false],
  ['view.roadmap', 'View', [], [S], false],
  ['view.stems', 'View', [], [S], false],
  ['view.focus', 'View', ['KeyF'], [S], true],
  ['view.distance.near', 'View', [], [S], false],
  ['view.distance.stand', 'View', [], [S], false],
  ['view.distance.kit', 'View', [], [S], false],
  ['view.bigger', 'View', ['='], [S], false],
  ['view.smaller', 'View', ['-'], [S], false],
  ['view.followResume', 'View', [], [S], true],
  ['view.display', 'View', [], [S], false],
  ['view.followStyle', 'View', [], [S], false],
  ['stage.scrollUp', 'View', [], [S], true],
  ['stage.scrollDown', 'View', [], [S], true],
  ['stage.scrollTop', 'View', [], [S], true],
  ['stage.notes', 'Practice', [], [S], false],
  ['stage.tapBeat', 'Practice', [], [S], false],
  ['stage.getBars', 'Practice', [], [S], false],
  ['stage.share', 'App', [], [S], false],
  ['stage.startOver', 'Practice', [], [S], false],
  ['stage.leave', 'App', [], [S], false],
  ['stage.close', 'App', [], [], false],
  ['edit.open', 'Edit', ['KeyE'], [S], false],
  ['edit.map', 'Edit', [], [S, E], false],
  ['edit.chart', 'Edit', [], [S, E], false],
  ['edit.details', 'Edit', [], [S, E], false],
  ['practice.undo', 'Practice', ['Mod+KeyZ'], [S], false],
  ['practice.redo', 'Practice', ['Mod+Shift+KeyZ', 'Mod+KeyY'], [S], false],
  ['setlist.next', 'Navigate', ['Alt+ArrowDown'], [S], true],
  ['setlist.prev', 'Navigate', ['Alt+ArrowUp'], [S], true],
];

let clock, restoreAudio;
const cleanups = [];

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(Date.parse('2026-10-28T12:00:00Z'));
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
  installPopoverShim();
  feedback.resetFeedback();
  prefs.update((d) => {
    d.practice.distance = 'stand';
    d.practice.focus = false;
    d.practice.follow = {rail: 'scroll', band: 'page'};
    d.library.opened = [];
    d.chart.display.layout = null;
    d.edit.lastTab = 'map';
  });
  store.stage.value = null;
  hoisted.huds.length = 0;
  hoisted.controls.length = 0;
  hoisted.strips.length = 0;
  hoisted.decode.codec = false;
  document.documentElement.dataset.posture = 'stage';
  document.documentElement.dataset.place = 'stage';
});

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  closeSheets();
  setSheetModules(null);
  feedback.resetFeedback();
  document.body.replaceChildren();
  for (const k of ['place', 'posture', 'loadPhase', 'transportPhase']) delete document.documentElement.dataset[k];
  restoreDomShims();
  restoreAudio();
  vi.useRealTimers();
});

/** A session over in-memory persistence whose status lines go to the real status line. */
async function session(options = {}) {
  const ts = await createTestSession({clock, status: (text, opts) => feedback.status(text, opts), ...options});
  cleanups.push(() => ts.dispose());
  return ts;
}

/** A registry with the Stage and transport commands and a context for `ts`. */
function commandsBed(ts, {stage, desktop = false, router, later = {}} = {}) {
  const registry = createRegistry();
  defineStageCommands({registry, later});
  defineTransportCommands({registry, sheets: {}});
  if (ts) registry.provide('session', () => ts.session);
  if (stage) registry.provide('stage', () => stage);
  registry.provide('feedback', () => feedback);
  registry.provide('store', () => store);
  registry.provide('desktop', () => ({available: desktop}));
  const r = router ?? {navigate: vi.fn(), back: vi.fn(), setQuery: vi.fn()};
  registry.provide('router', () => r);
  return {registry, router: r, run: (id, args) => registry.run(id, {source: 'key', args}), state: (id, args) => registry.state(id, registry.context(args ? {args} : {}))};
}

// =====================================================================================================
// §3.2 commands

describe('the Stage commands (§3.2)', () => {
  test('every §3.2 row is registered with its group, keys, scopes and pedal flag; nothing else', () => {
    const registry = createRegistry();
    defineStageCommands({registry});
    for (const [id, group, keys, scopes, pedal] of TABLE) {
      const def = registry.get(id);
      expect(def, id).toBeTruthy();
      expect(def.group, id).toBe(group);
      expect([...def.keys], id).toEqual(keys);
      expect([...def.scopes], id).toEqual(scopes);
      expect(def.pedal, id).toBe(pedal);
      expect(typeof def.title === 'function' || !!def.title, id).toBe(true);
    }
    expect(registry.all().map((d) => d.id).sort()).toEqual(TABLE.map((r) => r[0]).sort());
    expect([...STAGE_COMMAND_IDS].sort()).toEqual(TABLE.map((r) => r[0]).sort());
  });

  test('S on an unmapped song adds "Marker {n}" at the playhead: one undo step and a status line with Rename', async () => {
    const ts = await session({mapped: false});
    const b = commandsBed(ts);
    ts.transport.cue(31.2);
    expect(b.state('marker.add').title).toBe(COPY.commands.markerAdd);
    expect(b.run('marker.add')).toBe(true);
    const markers = ts.value.markers.filter((m) => !m.deleted);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({t: 31.2, label: 'Marker 1'});
    expect(feedback.statusLine.peek()).toBeNull();   // no line attached: status falls back to a toast
    expect(feedback.toastState().visible).toMatchObject({message: 'Marker 1 added', action: COPY.rename});
    expect(ts.undo.canUndo.peek()).toBe(true);
    undoStep({session: ts.session, feedback}, 'undo');
    expect(ts.value.markers.filter((m) => !m.deleted)).toHaveLength(0);
  });

  test('S on a mapped song labels the bar under the playhead "Section {n}" as one practice-undo step', async () => {
    const ts = await session({tempo: {songMap: {...structuredClone(sectioned.tempo.songMap), measures: sectioned.tempo.songMap.measures.map((m) => ({...m, label: ''}))}}});
    const b = commandsBed(ts);
    ts.transport.cue(5);   // bar 3
    expect(b.state('marker.add').title).toBe(COPY.commands.sectionAdd);
    b.run('marker.add');
    expect(ts.map.sections.map((s) => s.name)).toContain('Section 1');
    expect(ts.map.bars[2].label).toBe('Section 1');
    expect(feedback.toastState().visible?.message).toBe('Section 1 added');
    ts.undo.undo();
    expect(ts.map.bars[2].label).toBe('');
  });

  test('S on a bar that already starts a section changes nothing and says so', async () => {
    const ts = await session();
    const b = commandsBed(ts);
    ts.transport.cue(CHORUS.t0 + 0.2);
    const before = JSON.stringify(ts.map.data);
    b.run('marker.add');
    expect(JSON.stringify(ts.map.data)).toBe(before);
    expect(feedback.toastState().visible?.message).toBe(`Bar ${CHORUS.startBar + 1} already starts Chorus`);
  });

  test('B saves the loop as a spot at the current speed and makes it active; spot.open loops it with its speed', async () => {
    const ts = await session();
    const b = commandsBed(ts);
    ts.transport.loopRange(CHORUS.t0, CHORUS.t1, {snap: 'bar'});
    ts.transport.setSpeed(0.8, {coalesce: false});
    const id = saveSpotHere({session: ts.session, feedback});
    const spot = ts.value.spots.find((s) => s.id === id);
    expect(spot).toMatchObject({name: 'Chorus', a: CHORUS.t0, b: CHORUS.t1, rate: 0.8});
    expect(ts.practice.activeSpotId.peek()).toBe(id);
    expect(feedback.toastState().visible?.message).toBe('Saved spot Chorus · 80%');
    ts.transport.clearLoop();
    ts.transport.setSpeed(1, {coalesce: false});
    expect(b.state('spot.open', {id}).title).toBe('Open spot Chorus');
    expect(b.run('spot.open', {id})).toBe(true);
    expect(ts.snapshot.loop).toMatchObject({on: true, a: CHORUS.t0, b: CHORUS.t1});
    expect(ts.snapshot.rate).toBe(0.8);
    expect(ts.snapshot.cue).toBe(CHORUS.t0);
    expect(ts.practice.activeSpotId.peek()).toBe(id);
    expect(openSpot({session: ts.session, feedback}, 'gone')).toBe(false);
  });

  test('B without a loop saves the region around the playhead (the section)', async () => {
    const ts = await session();
    ts.transport.cue(CHORUS.t0 + 3);
    const id = saveSpotHere({session: ts.session, feedback});
    expect(ts.value.spots.find((s) => s.id === id)).toMatchObject({name: 'Chorus', a: CHORUS.t0, b: CHORUS.t1});
  });

  test('Undo shows "Undid: …" with Redo as a toast when stopped and in the status line while playing', async () => {
    const ts = await session();
    const b = commandsBed(ts);
    ts.transport.setSpeed(0.85, {coalesce: false});
    b.run('practice.undo');
    expect(feedback.toastState().visible).toMatchObject({message: 'Undid: speed 100% → 85%', action: COPY.redo});
    b.run('practice.redo');
    expect(feedback.toastState().visible).toMatchObject({message: 'Redid: speed 100% → 85%', action: COPY.undo});
    const offLine = feedback.attachStatusLine();
    await ts.play();
    expect(['playing', 'counting']).toContain(ts.snapshot.phase);
    b.run('practice.undo');
    expect(feedback.statusLine.peek()).toMatchObject({text: 'Undid: speed 100% → 85%', key: 'undo'});
    offLine();
  });

  test('Undo with nothing to undo is disabled with a reason', async () => {
    const ts = await session();
    const b = commandsBed(ts);
    expect(b.state('practice.undo')).toMatchObject({visible: true, enabled: false, reason: COPY.nothingToUndo});
    expect(b.state('practice.redo')).toMatchObject({enabled: false, reason: COPY.nothingToRedo});
  });

  test('Re-split: web shows the desktop reason; desktop runs LB3’s dialog for the session’s song or args.songId', async () => {
    const ts = await session();
    expect(commandsBed(ts).state('song.resplit')).toMatchObject({visible: true, enabled: false, reason: COPY.resplitDesktop});
    const openResplitDialog = vi.fn();
    const b = commandsBed(ts, {desktop: true, later: {'../library/resplit-dialog.js': async () => ({openResplitDialog})}});
    expect(b.state('song.resplit')).toMatchObject({enabled: true, reason: null});
    b.run('song.resplit');
    await settle();
    expect(openResplitDialog).toHaveBeenCalledWith(expect.objectContaining({songId: ts.id}));
    const lib = commandsBed(null, {desktop: true, later: {'../library/resplit-dialog.js': async () => ({openResplitDialog})}});
    lib.run('song.resplit', {songId: 'lowtide'});
    await settle();
    expect(openResplitDialog).toHaveBeenLastCalledWith(expect.objectContaining({songId: 'lowtide'}));
    expect(commandsBed(null, {desktop: true}).state('song.resplit')?.visible).toBe(false);
  });

  test('Detect beats takes its disabled reason from the detect flow; Find a chart opens Edit · Map Find', async () => {
    const ts = await session();
    const b = commandsBed(ts);
    expect(b.state('map.detect')).toMatchObject({visible: true, enabled: false});
    expect(b.state('map.detect').reason).toBe(ts.detect.canDetect.peek().reason);
    b.run('map.find');
    expect(b.router.navigate).toHaveBeenCalledWith(`/s/${ts.id}/edit/map/find`);
    const desk = await session({desktop: true});
    expect(commandsBed(desk).state('map.detect')).toMatchObject({enabled: true});
  });

  test('section suggestions: Suggest only when mapped without sections; Keep all / Review only with a suggestion', async () => {
    const plain = await session({tempo: {songMap: {...structuredClone(sectioned.tempo.songMap), measures: sectioned.tempo.songMap.measures.map((m) => ({...m, label: ''}))}},
      sectionSuggestion: {jobId: 'j1', createdAt: 1, sections: [{t0: 16, label: 'Verse', confidence: 0.8}, {t0: 32, label: 'Chorus', confidence: 0.7}]}});
    const b = commandsBed(plain);
    expect(b.state('sections.suggest').visible).toBe(true);
    expect(b.state('sections.keepAll').enabled).toBe(true);
    b.run('sections.review');
    expect(plain.navigations).toContain(`/s/${encodeURIComponent(plain.id)}/edit/map?review=sections`);
    b.run('sections.keepAll');
    expect(plain.map.sections.map((s) => s.name)).toEqual(expect.arrayContaining(['Verse', 'Chorus']));
    const full = await session();
    expect(commandsBed(full).state('sections.suggest').visible).toBe(false);
    expect(commandsBed(full).state('sections.keepAll').visible).toBe(false);
  });

  test('E opens Edit on the last tab (prefs.edit.lastTab); the tab commands open their tab', async () => {
    const ts = await session();
    const b = commandsBed(ts);
    prefs.set('edit.lastTab', 'chart');
    b.run('edit.open');
    expect(b.router.navigate).toHaveBeenLastCalledWith(`/s/${ts.id}/edit/chart`);
    b.run('edit.details');
    expect(b.router.navigate).toHaveBeenLastCalledWith(`/s/${ts.id}/edit/details`);
  });

  test('read-only (shared) sessions disable Edit, Share, the map and detection commands, Tap the beat, Get bars and Re-split', async () => {
    const ts = await session({shared: {token: 'a'.repeat(64)}});
    const stage = {session: ts.session, share() {}, openSheet() {}, shareAvailable: signal(true)};
    const b = commandsBed(ts, {stage, desktop: true, later: {'../library/resplit-dialog.js': async () => ({})}});
    for (const id of ['edit.open', 'edit.map', 'edit.chart', 'edit.details', 'stage.share', 'map.detect', 'map.find', 'sections.suggest',
      'stage.tapBeat', 'stage.getBars', 'song.resplit']) {
      expect(b.state(id).enabled, id).toBe(false);
    }
    // Markers and spots stay on this device (spec §4.13).
    expect(b.state('marker.add').enabled).toBe(true);
    expect(b.state('spot.save').enabled).toBe(true);
    expect(b.state('marker.add').title).toBe(COPY.commands.markerAdd);
    addMarkerHere({session: ts.session, feedback});
    expect(ts.value.markers.filter((m) => !m.deleted)).toHaveLength(1);
  });

  test('view commands act on the Stage: radios, Distance, zoom titles per surface, Focus with D25, display and follow style', async () => {
    const ts = await session();
    const surface = signal('chart'), distance = signal('stand'), focus = signal(false), following = signal(true);
    const display = signal(null), followStyle = signal('scroll');
    const stage = {
      session: ts.session, surface, distance, focus, following, display, followStyle,
      setSurface: vi.fn((k) => { surface.value = k; }), cycleSurface: vi.fn(), toggleFocus: vi.fn(), setDistance: vi.fn(),
      zoom: vi.fn(), resumeFollow: vi.fn(), setDisplay: vi.fn(), setFollowStyle: vi.fn(), scrollBy: vi.fn(), scrollTop: vi.fn(),
    };
    const b = commandsBed(ts, {stage});
    expect(b.state('view.chart').checked).toBe(true);
    b.run('view.stems');
    expect(stage.setSurface).toHaveBeenCalledWith('stems');
    expect(b.state('view.stems').checked).toBe(true);
    surface.value = 'wave';
    expect(b.state('view.roadmap').checked).toBe(true);
    expect(b.state('view.bigger').title).toBe(COPY.commands.biggerWave);
    surface.value = 'stems';
    expect(b.state('view.smaller').title).toBe(COPY.commands.smallerStems);
    b.run('view.bigger');
    expect(stage.zoom).toHaveBeenCalledWith(1);
    expect(b.state('view.distance.stand').checked).toBe(true);
    b.run('view.distance.kit');
    expect(stage.setDistance).toHaveBeenCalledWith('kit');
    b.run('view.cycle');
    expect(stage.cycleSurface).toHaveBeenCalled();
    // F: Focus, unless Follow is paused (then F resumes it).
    expect(b.state('view.focus').title).toBe(COPY.commands.focus);
    b.run('view.focus');
    expect(stage.toggleFocus).toHaveBeenCalledTimes(1);
    following.value = false;
    expect(b.state('view.focus').title).toBe(COPY.commands.focusResume);
    expect(b.state('view.followResume').enabled).toBe(true);
    b.run('view.focus');
    expect(stage.resumeFollow).toHaveBeenCalledTimes(1);
    expect(stage.toggleFocus).toHaveBeenCalledTimes(1);
    b.run('view.followStyle', {style: 'page'});
    expect(stage.setFollowStyle).toHaveBeenCalledWith('page');
    expect(b.state('view.followStyle', {style: 'scroll'}).checked).toBe(true);
    b.run('stage.scrollDown');
    b.run('stage.scrollUp');
    b.run('stage.scrollTop');
    expect(stage.scrollBy.mock.calls).toEqual([[1], [-1]]);
    expect(stage.scrollTop).toHaveBeenCalled();
    expect(DISPLAY_LAYOUTS).toEqual(['combined', 'split']);
  });

  test('setlist commands step through the set; at an end they are disabled with a reason', async () => {
    const ts = await session();
    const setlist = signal({id: 'set-1', name: 'Friday', index: 0, count: 2, prev: null, next: {id: 'b', title: 'B'}});
    const stage = {session: ts.session, setlist, goSetlist: vi.fn()};
    const b = commandsBed(ts, {stage});
    expect(b.state('setlist.prev')).toMatchObject({visible: true, enabled: false, reason: COPY.setStart});
    b.run('setlist.next');
    expect(stage.goSetlist).toHaveBeenCalledWith(1);
    setlist.value = null;
    expect(b.state('setlist.next').visible).toBe(false);
  });
});

// =====================================================================================================
// the sheets host (§2.14.11)

describe('the sheets host', () => {
  function railStage() {
    const stage = document.body.appendChild(document.createElement('div'));
    stage.dataset.stageLayout = 'rail';
    const control = stage.appendChild(document.createElement('button'));
    control.dataset.stageAnchor = 'speed';
    const notes = stage.appendChild(document.createElement('div'));
    notes.dataset.notesHost = '';
    return {stage, control, notes};
  }

  test('a sheet of a later build shows "Not built yet"; the same sheet twice is one sheet', async () => {
    setSheetModules({});
    const a = openSheet('speed', {session: null});
    await settle();
    const el = document.querySelector('[data-sheet="speed"]');
    expect(el).toBeTruthy();
    expect(el.textContent).toContain(COPY.notBuilt);
    expect(el.querySelector('.ui-sheet-title').textContent).toBe(COPY.sheets.speed);
    expect(openSheet('speed', {session: null})).toBe(a);
    expect(document.querySelectorAll('[data-sheet="speed"]')).toHaveLength(1);
    expect(openSheetName()).toBe('speed');
  });

  test('a module renders into the sheet with {session, close}; another sheet closes the first and destroys its content', async () => {
    const destroy = vi.fn();
    const render = vi.fn((container, {close}) => { container.append(Object.assign(document.createElement('p'), {textContent: 'Speed body'})); return {destroy, close}; });
    setSheetModules({'./speed.js': async () => ({render}), './click.js': async () => ({render: () => ({destroy() {}})})});
    const session = {id: 'x'};
    openSheet('speed', {session});
    await settle();
    expect(render).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({session}));
    expect(document.querySelector('[data-sheet="speed"]').textContent).toContain('Speed body');
    openSheet('click', {session});
    await settle();
    expect(destroy).toHaveBeenCalled();
    expect(openSheetName()).toBe('click');
    // The sheet's own close() (a preset on the band, D59) closes it.
    render.mock.calls[0][1].close();
    closeSheets();
    expect(openSheetName()).toBeNull();
  });

  test('on the rail a sheet is a 360 px popover anchored left of its control; on the band a bottom sheet', async () => {
    setSheetModules({});
    const {control} = railStage();
    openSheet('speed', {anchor: control});
    expect(document.querySelector('[data-sheet="speed"]').dataset.presentation).toBe('popover');
    expect(POPOVER_WIDTH).toBe(360);
    closeSheets();
    document.querySelector('[data-stage-layout]').dataset.stageLayout = 'band';
    openSheet('speed', {});
    expect(document.querySelector('[data-sheet="speed"]').dataset.presentation).toBe('bottom');
  });

  test('without an anchor the Stage’s [data-stage-anchor=<name>] is used', () => {
    setSheetModules({});
    railStage();
    openSheet('speed', {});
    expect(document.querySelector('[data-sheet="speed"]').dataset.presentation).toBe('popover');
  });

  test('Notes is a non-modal card in the music’s notes host, closed by ✕ or Esc', async () => {
    setSheetModules({});
    const {notes} = railStage();
    const handle = openSheet('notes', {});
    const card = notes.querySelector('[data-sheet="notes"]');
    expect(card).toBeTruthy();
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.querySelector('h2').textContent).toBe(COPY.sheets.notes);
    expect(handle.open).toBe(true);
    card.querySelector('.stage-notes-close').click();
    expect(handle.open).toBe(false);
    expect(notes.querySelector('[data-sheet="notes"]')).toBeNull();
  });

  test('every sheet name is known; an unknown one throws', () => {
    expect(SHEETS).toEqual(['speed', 'click', 'mix', 'loop', 'spots', 'notes', 'tapBeat', 'getBars']);
    for (const name of SHEETS) expect(COPY.sheets[name], name).toBeTruthy();
    expect(() => openSheet('nope')).toThrow(RangeError);
  });
});

// =====================================================================================================
// the copy helpers

describe('copy', () => {
  test('the Play ring lines while loading (spec §4.12 step 3)', () => {
    expect(loadingLabel({phase: 'loading', loadedBytes: 62, totalBytes: 100})).toBe('Loading audio 62%');
    expect(loadingLabel({phase: 'loading', loadedBytes: 0, totalBytes: 0})).toBe('Loading audio');
    expect(loadingLabel({phase: 'decoding', decoded: 2, tracks: 4})).toBe('Decoding 3 of 4');
    expect(loadingLabel({phase: 'preparing'})).toBe('Preparing pitch-preserving playback');
    expect(loadingLabel({phase: 'signing'})).toBe(COPY.openingSong);
    expect(loadingLabel({phase: 'ready'})).toBe('');
  });

  test('the resume chip and the mix word (spec Appendix A)', () => {
    expect(resumeText({where: 'Chorus loop', rate: 0.75, mix: 'Drums out'})).toMatchObject({strong: 'Chorus loop', rest: '75% · Drums out', text: 'Back at Chorus loop · 75% · Drums out'});
    expect(resumeText({where: '1:12', rate: 1})).toMatchObject({text: 'Back at 1:12 · 100%'});
    expect(mixWord({minusMe: true, mine: ['drums']})).toBe('Drums out');
    expect(mixWord({onlyMe: true, mine: ['guitar', 'other']})).toBe('Only guitar & other');
    expect(mixWord({muted: ['bass']})).toBe('Bass out');
    expect(mixWord({})).toBe('');
  });
});

// =====================================================================================================
// the mounted Stage (needs ST5's and ST6's peers on disk; mocked above)

const PEERS = ['src/stage/hud.js', 'src/stage/controls.js', 'src/stage/strip.js'];
const missingPeers = PEERS.filter((p) => !existsSync(join(process.cwd(), p)));

describe.skipIf(missingPeers.length)('the mounted Stage', () => {
  let stage;
  beforeAll(async () => { stage = await import('../src/stage/stage.js'); });

  function setViewport(width, height) {
    Object.defineProperty(window, 'innerWidth', {value: width, configurable: true, writable: true});
    Object.defineProperty(window, 'innerHeight', {value: height, configurable: true, writable: true});
  }

  /** Fake surfaces for the later-wave modules (one recorder per created surface). */
  function fakeLater(log, extra = {}) {
    const make = (kind, factory, path) => [path, async () => ({
      [factory]: (host, opts) => {
        const el = document.createElement('div');
        el.dataset.testSurface = kind;
        const scroller = document.createElement('div');
        scroller.dataset.scroller = '';
        scroller.scrollBy = vi.fn();
        scroller.scrollTo = vi.fn();
        el.append(scroller);
        host.append(el);
        const s = {el, scroller, kind: kind === 'roadmap' && !opts.session.map.isReal ? 'wave' : kind, opts, frame: vi.fn(), setLoop: vi.fn(), setGlass: vi.fn(),
          setFollow: vi.fn(), reveal: vi.fn(), anchor: vi.fn(() => ({time: 12.5, bar: 7})), zoom: vi.fn(), setLayout: vi.fn(), setDistance: vi.fn(),
          destroy: vi.fn(() => el.remove())};
        log.push(s);
        return s;
      },
    })];
    return Object.fromEntries([
      make('chart', 'createChartSurface', './surfaces/chart-surface.js'),
      make('roadmap', 'createRoadmapSurface', './surfaces/roadmap-surface.js'),
      make('stems', 'createStemsSurface', './surfaces/stems-surface.js'),
      ...Object.entries(extra),
    ]);
  }

  async function mountStage({ts, sessionOptions = {}, query = {}, vw = 1440, vh = 900, later, platform: platformOver = {}, router: routerOver, sessionError} = {}) {
    setViewport(vw, vh);
    ts ??= await session(sessionOptions);
    const registry = createRegistry();
    defineStageCommands({registry, later: {}});
    defineTransportCommands({registry, sheets: {}});
    const platform = {isIPad: false, isIOS: false, features: {viewTransition: false}, reducedMotion: signal(false), coarse: signal(false), ...platformOver};
    defineGlobalCommands({registry, store, platform, openPalette: vi.fn(), openShortcuts: vi.fn(), signOut: vi.fn(), later: {}});
    const router = routerOver ?? {navigate: vi.fn(), back: vi.fn(), setQuery: vi.fn(), onLeave: vi.fn(() => () => {}), link: vi.fn(() => () => {})};
    registry.provide('router', () => router);
    registry.provide('feedback', () => feedback);
    registry.provide('store', () => store);
    registry.provide('desktop', () => ({available: false}));
    const surfacesLog = [];
    const wake = {held: signal(false), update: vi.fn(), destroy: vi.fn(), release: vi.fn()};
    const offs = {interruptions: vi.fn(), media: vi.fn(), gesture: vi.fn()};
    const menuOpen = vi.fn(() => ({close() {}}));
    const setlistRows = new Map();
    const deps = {
      createWakeLock: vi.fn(() => wake),
      watchInterruptions: vi.fn(() => offs.interruptions),
      startMediaSession: vi.fn(() => offs.media),
      startGestureAudio: vi.fn(() => offs.gesture),
      setlists: {subscribeGet: vi.fn(({id}, onValue) => { queueMicrotask(() => onValue(setlistRows.get(id) ?? null)); return () => {}; })},
      later: later ?? fakeLater(surfacesLog),
      prefs,
      Menu: {open: menuOpen},
    };
    const el = document.body.appendChild(document.createElement('div'));
    const ctx = {router, store, registry, feedback, platform, session: ts?.session, sessionError, stageDeps: deps};
    const view = await stage.mount(el, {name: 'stage', path: `/s/${ts?.id}`, params: {songId: ts?.id}, query}, ctx);
    await settle();
    let unmounted = false;
    const unmount = async () => { if (!unmounted) { unmounted = true; await view.unmount(); } };
    cleanups.push(unmount);
    const root = el.querySelector('.stage');
    return {
      ts, view, el, root, registry, router, platform, deps, wake, offs, menuOpen, setlistRows, surfacesLog, unmount, ctx,
      get api() { return registry.context().stage; },
      get surface() { return surfacesLog.at(-1); },
      run: (id, args) => registry.run(id, {source: 'key', args}),
      state: (id, args) => registry.state(id, registry.context(args ? {args} : {})),
      statusText: () => el.querySelector('.stage-status').textContent.replace(/\s+/g, ' ').trim(),
      statusButton: (name) => [...el.querySelectorAll('.stage-status button')].find((b) => b.textContent.trim() === name),
      async resize(w, h) { setViewport(w, h); window.dispatchEvent(new Event('resize')); },
    };
  }

  test('mounts the frame: HUD, the Music region, strip, controls and the status line; providers and root attributes', async () => {
    const b = await mountStage();
    expect(b.root).toBeTruthy();
    expect(b.root.getAttribute('data-stage-layout')).toBe('rail');
    expect(b.root.getAttribute('data-distance')).toBe('stand');
    const music = b.el.querySelector('[role="region"][aria-label="Music"]');
    expect(music).toBeTruthy();
    expect(b.el.querySelector('.stage-status').getAttribute('role')).toBe('status');
    expect(hoisted.huds).toHaveLength(1);
    expect(hoisted.huds[0].opts.session).toBe(b.ts.session);
    expect(hoisted.huds[0].opts.stage).toBe(b.api);
    expect(hoisted.huds[0].setLayout).toHaveBeenCalledWith('rail');
    expect(hoisted.controls.at(-1).opts).toMatchObject({session: b.ts.session, variant: 'rail'});
    expect(hoisted.strips).toHaveLength(1);
    expect(document.documentElement.dataset.loadPhase).toBe('ready');
    expect(document.documentElement.dataset.transportPhase).toBe('stopped');
    expect(b.registry.context().session).toBe(b.ts.session);
    expect(b.registry.context().transport).toBe(b.ts.transport);
    for (const key of ['layout', 'surface', 'setSurface', 'toggleFocus', 'setDistance', 'openSheet', 'closeSheets', 'statusLine', 'leave', 'scrollBy', 'scrollTop', 'anchors']) {
      expect(b.api, key).toHaveProperty(key);
    }
    expect(b.api.anchors).toBeInstanceOf(Map);
    expect(b.api.anchors.get('play').textContent).toBe('Play');
    expect(b.api.anchors.get('mix').textContent).toBe('Mix');
    expect(b.api.anchors.get('speed')).toBe(b.el.querySelector('.stage-controls'));
    expect(b.api.anchors.get('getBars')).toBe(b.el.querySelector('.stage-strip'));
  });

  test('820×1180 is the band with the dock', async () => {
    const b = await mountStage({vw: 820, vh: 1180});
    expect(b.root.getAttribute('data-stage-layout')).toBe('band');
    expect(hoisted.controls.at(-1).opts.variant).toBe('dock');
  });

  test('a resize or rotation relayouts once, 150 ms after it settles, with the anchor kept', async () => {
    const b = await mountStage();
    const surface = b.surface;
    surface.reveal.mockClear();
    await b.resize(820, 1180);
    vi.advanceTimersByTime(100);
    await b.resize(820, 1180);
    vi.advanceTimersByTime(149);
    expect(b.root.getAttribute('data-stage-layout')).toBe('rail');
    vi.advanceTimersByTime(1);
    expect(b.root.getAttribute('data-stage-layout')).toBe('band');
    expect(hoisted.huds[0].setLayout).toHaveBeenLastCalledWith('band');
    expect(hoisted.controls.at(-1).opts.variant).toBe('dock');
    expect(surface.setLayout).toHaveBeenCalledWith('band');
    vi.advanceTimersByTime(50);
    expect(surface.reveal).toHaveBeenCalledWith(12.5);
    expect(store.stage.peek().layout).toBe('band');
  });

  test('a rail below 1280 px is the narrow rail', async () => {
    const b = await mountStage({vw: 1200, vh: 800});
    expect(b.root.hasAttribute('data-rail-narrow')).toBe(true);
  });

  test('Distance: one relayout with the anchor kept, saved per device', async () => {
    const b = await mountStage();
    b.surface.reveal.mockClear();
    b.run('view.distance.kit');
    expect(b.root.getAttribute('data-distance')).toBe('kit');
    expect(prefs.get('practice.distance')).toBe('kit');
    expect(b.surface.setDistance).toHaveBeenCalledWith('kit');
    vi.advanceTimersByTime(50);
    expect(b.surface.reveal).toHaveBeenCalledWith(12.5);
    expect(b.state('view.distance.kit').checked).toBe(true);
    // Settings → Practice changes it too.
    prefs.set('practice.distance', 'near');
    expect(b.root.getAttribute('data-distance')).toBe('near');
  });

  test('Focus on the band hides chrome by height only; the 72 px reveal zone shows the dock for 5 s; Esc leaves Focus', async () => {
    const b = await mountStage({vw: 820, vh: 1180});
    const controlsBefore = hoisted.controls.length;
    b.run('view.focus');
    expect(b.root.hasAttribute('data-focus')).toBe(true);
    expect(prefs.get('practice.focus')).toBe(true);
    expect(hoisted.huds[0].setFocus).toHaveBeenLastCalledWith(true);
    expect(hoisted.controls.length).toBe(controlsBefore);   // the dock is hidden, not remounted
    expect(store.stage.peek().focus).toBe(true);
    const zone = b.el.querySelector('.stage-reveal');
    zone.dispatchEvent(new Event('pointerdown'));
    expect(b.root.hasAttribute('data-reveal')).toBe(true);
    vi.advanceTimersByTime(4999);
    expect(b.root.hasAttribute('data-reveal')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(b.root.hasAttribute('data-reveal')).toBe(false);
    expect(b.run('app.escape')).toBe(true);
    expect(b.root.hasAttribute('data-focus')).toBe(false);
  });

  test('Focus on the rail collapses to the mini rail: controls remount as "mini", once, with the anchor kept', async () => {
    const b = await mountStage();
    b.surface.reveal.mockClear();
    b.run('view.focus');
    expect(hoisted.controls.at(-1).opts.variant).toBe('mini');
    expect(hoisted.controls.at(-2).destroy).toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(b.surface.reveal).toHaveBeenCalledTimes(1);
    b.run('view.focus');
    expect(hoisted.controls.at(-1).opts.variant).toBe('rail');
  });

  test('D25: with Follow paused F resumes it instead of toggling Focus', async () => {
    const b = await mountStage();
    b.surface.opts.onFollowChange(false);
    expect(b.state('view.focus').title).toBe(COPY.commands.focusResume);
    b.run('view.focus');
    expect(b.surface.setFollow).toHaveBeenLastCalledWith(true);
    expect(b.root.hasAttribute('data-focus')).toBe(false);
  });

  test('interactive loading: the controls are live and the root says the load phase', async () => {
    const ts = await session({load: false});
    const b = await mountStage({ts});
    expect(['signing', 'loading', 'decoding', 'preparing', 'ready']).toContain(document.documentElement.dataset.loadPhase);
    expect(b.el.querySelector('.stage-controls').hasAttribute('aria-disabled')).toBe(false);
    expect(b.registry.isEnabled('transport.playStop')).toBe(true);
    expect(b.api.loadLabel.peek()).toBe(loadingLabel(ts.session.load.peek()));
    await ts.ready();
    await settle();
    expect(document.documentElement.dataset.loadPhase).toBe('ready');
  });

  test('a storage error shows in the music area; the controls are aria-disabled with the reason; Try again retries', async () => {
    let fail = true;
    const media = {signKeys: vi.fn(async (keys) => { if (fail) throw new Error('storage down'); return Object.fromEntries(keys.map((k) => [k, `https://stems.invalid/${k}`])); })};
    const b = await mountStage({sessionOptions: {media}});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(document.documentElement.dataset.loadPhase).toBe('error');
    const panel = b.el.querySelector('.stage-error');
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain(COPY.storageFailed);
    expect(panel.querySelector('details pre').textContent).toBe('storage down');
    const controls = b.el.querySelector('.stage-controls');
    expect(controls.getAttribute('aria-disabled')).toBe('true');
    const card = document.getElementById(controls.getAttribute('aria-describedby'));
    expect(card.textContent).toContain(COPY.storageFailed);
    expect(b.el.querySelector('.stage-surfaces').hidden).toBe(true);
    expect(b.registry.context().session).toBeNull();
    expect(b.registry.isEnabled('transport.playStop')).toBe(false);
    expect(b.registry.isEnabled('marker.add')).toBe(false);
    expect(b.registry.isEnabled('edit.details')).toBe(true);
    fail = false;
    [...panel.querySelectorAll('button')].find((x) => x.textContent.trim() === COPY.tryAgain).click();
    await b.ts.ready();
    await settle();
    expect(document.documentElement.dataset.loadPhase).toBe('ready');
    expect(panel.hidden).toBe(true);
    expect(controls.hasAttribute('aria-disabled')).toBe(false);
    expect(b.registry.isEnabled('transport.playStop')).toBe(true);
  });

  test('missing stems name the stems and offer Re-split (desktop; on the web its reason shows)', async () => {
    const media = {signKeys: vi.fn(async () => ({}))};
    const b = await mountStage({sessionOptions: {media}});
    const panel = b.el.querySelector('.stage-error');
    expect(panel.textContent).toContain(COPY.loadFailed);
    expect(panel.textContent).toContain('Missing stem audio for Drums, Bass, Vocals & Other.');
    const resplit = [...panel.querySelectorAll('button')].find((x) => x.textContent.includes(COPY.resplit));
    expect(resplit).toBeTruthy();
    expect(resplit.getAttribute('aria-disabled')).toBe('true');
  });

  test('a codec error gives the browser advice and no Try again', async () => {
    fakeStemcache.fetchStem.mockRejectedValueOnce(Object.assign(new Error('decode'), {codecError: true}));
    const b = await mountStage();
    const panel = b.el.querySelector('.stage-error');
    expect(panel.textContent).toContain(COPY.codec);
    expect([...panel.querySelectorAll('button')].some((x) => x.textContent.trim() === COPY.tryAgain)).toBe(false);
  });

  test('a deleted song (getSession rejected with not_found) renders "Song not found" with a way back', async () => {
    const b = await mountStage({ts: null, sessionError: new ApiError({code: 'not_found', message: 'gone'})});
    expect(b.el.querySelector('h1').textContent).toBe(COPY.notFoundTitle);
    expect(b.el.textContent).toContain(COPY.notFound);
    const link = b.el.querySelector('a[href="/"]');
    expect(link.textContent).toBe(COPY.leave);
    expect(b.router.link).toHaveBeenCalled();
    expect(document.documentElement.dataset.loadPhase).toBe('error');
  });

  test('resume: the saved surface and anchor, then "Back at **Chorus loop** · 75% · Drums out [Start over]" for 4 s', async () => {
    const practice = {v: 2, cue: CHORUS.t0, rate: 0.75, surface: 'stems', anchorTime: 40, anchorBar: 20,
      loop: {on: true, a: CHORUS.t0, b: CHORUS.t1, eachPassCount: true, playTimes: 0, between: 'none'},
      tracks: [{name: 'drums', volume: 1, muted: true, soloed: false}], minusMe: true, trainer: null, spots: [], markers: []};
    const b = await mountStage({sessionOptions: {practice}});
    expect(b.surface.el.dataset.testSurface).toBe('stems');
    expect(b.surface.reveal).toHaveBeenCalledWith(40, {smooth: false});
    expect(b.statusText()).toContain('Back at Chorus loop · 75% · Drums out');
    expect(b.el.querySelector('.stage-status-strong').textContent).toBe('Chorus loop');
    expect(b.statusButton(COPY.startOver)).toBeTruthy();
    vi.advanceTimersByTime(3999);
    expect(b.statusText()).toContain('Back at');
    vi.advanceTimersByTime(1);
    expect(b.statusText()).not.toContain('Back at');
  });

  test('[Start over] is cue 0, loop off, 100% as one undo step', async () => {
    const practice = {v: 2, cue: CHORUS.t0, rate: 0.75, loop: {on: true, a: CHORUS.t0, b: CHORUS.t1, eachPassCount: true, playTimes: 0, between: 'none'},
      tracks: [], minusMe: false, trainer: null, spots: [], markers: []};
    const b = await mountStage({sessionOptions: {practice}});
    b.statusButton(COPY.startOver).click();
    expect(b.ts.snapshot).toMatchObject({cue: 0, rate: 1});
    expect(b.ts.snapshot.loop.on).toBe(false);
    expect(b.statusText()).toContain(COPY.startedOver);
    b.ts.undo.undo();
    expect(b.ts.snapshot.rate).toBe(0.75);
    expect(b.ts.snapshot.loop.on).toBe(true);
    expect(b.ts.undo.canUndo.peek()).toBe(false);
  });

  test('a fresh song shows no resume chip; the chip shows once per session', async () => {
    const plain = await mountStage();
    expect(plain.statusText()).toBe('');
    await plain.unmount();
    const practice = {v: 2, cue: 30, rate: 0.9, loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none'},
      tracks: [], minusMe: false, trainer: null, spots: [], markers: []};
    const ts = await session({practice});
    const first = await mountStage({ts});
    expect(first.statusText()).toContain('Back at Verse · 90%');
    await first.unmount();
    const again = await mountStage({ts});
    expect(again.statusText()).not.toContain('Back at');
  });

  test('?bar=13 cues bar 13; ?t=83.2 cues the time; ?spot= opens the spot and drops itself from the URL', async () => {
    const byBar = await mountStage({query: {bar: '13'}});
    expect(byBar.ts.snapshot.cue).toBeCloseTo(24, 6);
    await byBar.unmount();
    const byTime = await mountStage({query: {t: '83.2'}});
    expect(byTime.ts.snapshot.cue).toBeCloseTo(83.2, 6);
    await byTime.unmount();
    const practice = {v: 2, cue: 0, rate: 1, loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none'}, tracks: [], minusMe: false, trainer: null,
      spots: [{id: 'sp1', name: 'Bridge fill', a: 80, b: 96, rate: 0.7, passes: 0, updatedAt: 1}], markers: []};
    const bySpot = await mountStage({sessionOptions: {practice}, query: {spot: 'sp1'}});
    expect(bySpot.ts.snapshot.loop).toMatchObject({on: true, a: 80, b: 96});
    expect(bySpot.ts.snapshot.rate).toBe(0.7);
    expect(bySpot.ts.practice.activeSpotId.peek()).toBe('sp1');
    expect(bySpot.router.setQuery).toHaveBeenCalledWith({spot: null});
    // update(match) applies a later query change.
    bySpot.view.update({query: {t: '10'}});
    expect(bySpot.ts.snapshot.cue).toBeCloseTo(10, 6);
  });

  test('Stop writes ?bar= (mapped) with replace, never while playing', async () => {
    const b = await mountStage();
    b.ts.transport.cue(CHORUS.t0);
    await b.ts.play();
    await b.ts.advance(1);
    expect(b.router.setQuery).not.toHaveBeenCalled();
    b.ts.transport.stop();
    await settle();
    expect(b.router.setQuery).toHaveBeenCalledWith({bar: CHORUS.startBar + 1, t: null});
  });

  test('Stop on an unmapped song writes ?t=', async () => {
    const b = await mountStage({sessionOptions: {mapped: false}});
    b.ts.transport.cue(31.2);
    await b.ts.play();
    b.ts.transport.stop();
    await settle();
    expect(b.router.setQuery).toHaveBeenCalledWith({t: 31.2, bar: null});
  });

  test('?set= gives the setlist context; Alt+↓ goes to the next song in the set with replace', async () => {
    const ts = await session({id: 'glass'});
    store.library.songs.value = new Map([['glass', {id: 'glass', title: 'Glasshouse'}], ['low', {id: 'low', title: 'Low Tide Static'}]]);
    const b = await mountStage({ts, query: {set: 'set-1'}});
    b.setlistRows.set('set-1', {id: 'set-1', name: 'Friday at the Grange', songIds: ['first', 'glass', 'low']});
    b.view.update({query: {set: 'set-2'}});
    b.view.update({query: {set: 'set-1'}});
    await settle();
    expect(b.api.setlist.peek()).toMatchObject({id: 'set-1', name: 'Friday at the Grange', index: 1, count: 3, prev: {id: 'first'}, next: {id: 'low', title: 'Low Tide Static'}});
    expect(b.run('setlist.next')).toBe(true);
    expect(b.router.navigate).toHaveBeenCalledWith('/s/low?set=set-1', {replace: true});
    store.library.songs.value = new Map();
  });

  test('a stale ?set= (the list was deleted) gives no context', async () => {
    const b = await mountStage({query: {set: 'gone'}});
    await settle();
    expect(b.api.setlist.peek()).toBeNull();
    expect(b.state('setlist.next').visible).toBe(false);
  });

  test('leaving: Back to Library stops playback and goes back (the Library refocuses the card); the hold hint', async () => {
    const b = await mountStage();
    await b.ts.play();
    b.api.leaveHint();
    expect(b.statusText()).toContain(COPY.holdHint);
    b.run('stage.leave');
    await settle();
    expect(b.ts.snapshot.phase).toBe('stopped');
    expect(b.router.back).toHaveBeenCalledWith({fallback: '/'});
  });

  test('Esc while playing says "Stop playback first (Space)" and never navigates; stopped it leaves; on an iPad it does not', async () => {
    const b = await mountStage();
    await b.ts.play();
    await settle();
    b.run('app.escape');
    expect(b.statusText()).toContain('Stop playback first (Space)');
    expect(b.router.back).not.toHaveBeenCalled();
    b.ts.transport.stop();
    await settle();
    b.run('app.escape');
    expect(b.router.back).toHaveBeenCalledTimes(1);
    await b.unmount();
    const ipad = await mountStage({vw: 820, vh: 1180, platform: {isIPad: true, isIOS: true}});
    expect(ipad.state('app.escape').visible).toBe(false);
    expect(ipad.router.back).not.toHaveBeenCalled();
  });

  test('store.stage follows the Stage (playing stays true while counting in) and clears on unmount', async () => {
    const b = await mountStage({sessionOptions: {account: {practice: {countIn: {on: true, length: 1, unit: 'bars'}}}}});
    expect(store.stage.peek()).toEqual({songId: b.ts.id, layout: 'rail', surface: 'roadmap', playing: false, focus: false});
    await b.ts.transport.play();
    await settle();
    expect(b.ts.snapshot.phase).toBe('counting');
    expect(store.stage.peek().playing).toBe(true);
    expect(b.root.hasAttribute('data-playing')).toBe(true);
    await b.unmount();
    expect(store.stage.peek()).toBeNull();
  });

  test('the wake lock, the interruption watcher, the Media Session and gesture audio run while mounted', async () => {
    const b = await mountStage();
    expect(b.deps.watchInterruptions).toHaveBeenCalledWith(expect.objectContaining({engine: b.ts.engine, transport: b.ts.transport}));
    expect(b.deps.startMediaSession).toHaveBeenCalledWith(expect.objectContaining({transport: b.ts.transport, session: b.ts.session}));
    expect(b.deps.startGestureAudio).toHaveBeenCalledWith(expect.objectContaining({transport: b.ts.transport, engine: b.ts.engine}));
    expect(b.wake.update).toHaveBeenLastCalledWith({stageOpen: true, playing: false});
    expect(b.api.wakeHeld).toBe(b.wake.held);
    await b.ts.play();
    await settle();
    expect(b.wake.update).toHaveBeenLastCalledWith({stageOpen: true, playing: true});
    await b.unmount();
    expect(b.offs.interruptions).toHaveBeenCalled();
    expect(b.offs.media).toHaveBeenCalled();
    expect(b.offs.gesture).toHaveBeenCalled();
    expect(b.wake.destroy).toHaveBeenCalled();
  });

  test('prefs.library.opened records the song once, newest last', async () => {
    prefs.set('library.opened', ['a', 'b']);
    const ts = await session({id: 'a'});
    await mountStage({ts});
    expect(prefs.get('library.opened')).toEqual(['b', 'a']);
  });

  test('the surface default: Chart when the song has a chart, switched once when the part answers without notation', async () => {
    const b = await mountStage({sessionOptions: {hasChart: true}});
    expect(b.surfacesLog[0].el.dataset.testSurface).toBe('chart');
    await b.ts.notation.ready;
    await settle();
    expect(b.ts.notation.hasNotation.peek()).toBe(false);
    expect(b.surface.el.dataset.testSurface).toBe('roadmap');
    expect(b.surfacesLog).toHaveLength(2);
    expect(b.ts.value.surface).toBeUndefined();   // the default is not saved as a choice
  });

  test('an explicit choice is kept: the part answering does not switch it', async () => {
    const practice = {v: 2, cue: 0, rate: 1, surface: 'chart', loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none'}, tracks: [], minusMe: false, trainer: null, spots: [], markers: []};
    const b = await mountStage({sessionOptions: {hasChart: true, practice}});
    await b.ts.notation.ready;
    await settle();
    expect(b.surfacesLog).toHaveLength(1);
    expect(b.surface.el.dataset.testSurface).toBe('chart');
  });

  test('switching surfaces crossfades: the new one is revealed at the old anchor, the old one leaves after --motion-slow', async () => {
    const b = await mountStage();
    const old = b.surface;
    b.run('view.stems');
    await settle();
    const next = b.surface;
    expect(next).not.toBe(old);
    expect(next.reveal).toHaveBeenCalledWith(12.5, {smooth: false});
    const layers = [...b.el.querySelectorAll('.stage-surface')];
    expect(layers).toHaveLength(2);
    expect(layers[0].hasAttribute('data-leaving')).toBe(true);
    vi.advanceTimersByTime(50);
    expect(layers[1].hasAttribute('data-entering')).toBe(false);
    expect(old.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(stage.SURFACE_FADE_MS);
    expect(old.destroy).toHaveBeenCalled();
    expect(b.el.querySelectorAll('.stage-surface')).toHaveLength(1);
    expect(b.ts.value.surface).toBe('stems');
    expect(store.stage.peek().surface).toBe('stems');
  });

  test('with reduced motion the switch is immediate', async () => {
    const b = await mountStage({platform: {reducedMotion: signal(true)}});
    const old = b.surface;
    b.run('view.chart');
    await settle();
    expect(old.destroy).toHaveBeenCalled();
    expect(b.el.querySelector('[data-entering]')).toBeNull();
  });

  test('a surface of a later build renders "Not built yet" inside the frame', async () => {
    const b = await mountStage({later: {}});
    const placeholder = b.el.querySelector('.stage-surface-later');
    expect(placeholder).toBeTruthy();
    expect(placeholder.textContent).toContain(COPY.notBuilt);
    expect(placeholder.textContent).toContain('Road map');
  });

  test('V cycles Chart → Road map → Stems', async () => {
    const b = await mountStage();
    b.run('view.cycle');
    await settle();
    expect(b.surface.el.dataset.testSurface).toBe('stems');
    b.run('view.cycle');
    await settle();
    expect(b.surface.el.dataset.testSurface).toBe('chart');
  });

  test('glass: a stopped tap cues; a touch tap while playing shows the pill (tap it to jump); a mouse click seeks; long-press opens the bar menu', async () => {
    const menus = {'./menus.js': async () => ({barMenu: vi.fn(() => [{label: 'Play from here'}])})};
    const log = [];
    const b = await mountStage({later: {...fakeLater(log), ...menus}});
    const s = log.at(-1);
    s.opts.onActivate({kind: 'tap', t: 20.3, beatTime: 20.5, bar: 11, pointerType: 'touch', clientX: 100, clientY: 100});
    expect(b.ts.snapshot.cue).toBeCloseTo(20.5, 6);
    await b.ts.play();
    await settle();
    const jump = vi.spyOn(b.ts.transport, 'jump');
    const seek = vi.spyOn(b.ts.transport, 'seek');
    s.opts.onActivate({kind: 'tap', t: 44, bar: 23, pointerType: 'touch', clientX: 120, clientY: 300});
    expect(seek).not.toHaveBeenCalled();
    const pill = b.el.querySelector('[data-glass-pill]');
    expect(pill.textContent.replace(/\s+/g, ' ').trim()).toBe('▶ Play from bar 23');
    pill.click();
    expect(jump).toHaveBeenCalledWith(44, {label: 'Play from bar 23'});
    expect(b.el.querySelector('[data-glass-pill]')).toBeNull();
    s.opts.onActivate({kind: 'tap', t: 50, bar: 26, pointerType: 'touch'});
    vi.advanceTimersByTime(3000);
    expect(b.el.querySelector('[data-glass-pill]')).toBeNull();
    s.opts.onActivate({kind: 'tap', t: 60, pointerType: 'mouse'});
    expect(seek).toHaveBeenCalledWith(60);
    s.opts.onActivate({kind: 'long', t: 61, bar: 31, pointerType: 'touch', clientX: 5, clientY: 6});
    await settle();
    expect(b.menuOpen).toHaveBeenCalledWith([{label: 'Play from here'}], expect.objectContaining({anchor: {x: 5, y: 6}}));
  });

  test('a committed loop drag on the music sets the loop', async () => {
    const b = await mountStage();
    b.surface.opts.onLoopEdit({a: 32, b: 48, phase: 'commit'});
    expect(b.ts.snapshot.loop).toMatchObject({on: true, a: 32, b: 48});
    b.surface.opts.onLoopEdit({a: 0, b: 8, phase: 'preview'});
    expect(b.ts.snapshot.loop.a).toBe(32);
  });

  test('the status line renders feedback.status, its action, and the detection offer’s [Use them] [Not now]', async () => {
    const ts = await session();
    const offer = signal({jobId: 'j9', beats: [0, 0.5]});
    const dismissOffer = vi.fn();
    ts.session.detect = {...ts.session.detect, offer, dismissOffer};
    const b = await mountStage({ts});
    const run = vi.fn();
    feedback.status('Bars found while you were away', {action: {label: 'Use them', run}, key: 'detect-offer', durationMs: 10000});
    expect(b.statusText()).toContain('Bars found while you were away');
    b.statusButton(COPY.notNow).click();
    expect(dismissOffer).toHaveBeenCalled();
    expect(b.statusText()).toBe('');
    feedback.status('Bars found while you were away', {action: {label: 'Use them', run}, key: 'detect-offer'});
    b.statusButton('Use them').click();
    expect(run).toHaveBeenCalled();
    expect(b.statusText()).toBe('');
  });

  test('the markers offer (not real → real) renders in the status line with its action', async () => {
    const practice = {v: 2, cue: 0, rate: 1, loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none'}, tracks: [], minusMe: false, trainer: null, spots: [],
      markers: [{id: 'm1', t: 16, label: 'Verse', updatedAt: 1}, {id: 'm2', t: 32, label: 'Chorus', updatedAt: 1}]};
    const b = await mountStage({sessionOptions: {mapped: false, practice}});
    b.ts.session.mapChange('Bars found', (m) => m.adopt(structuredClone(sectioned.tempo.songMap)));
    expect(b.statusText()).toContain('Turn 2 markers into sections');
    expect(b.statusButton('Turn into sections')).toBeTruthy();
  });

  test('the recording banner shows once per session, above the music', async () => {
    const ts = await session({recordingUnconfirmed: true, song: {provider: 'YouTube', source: {type: 'search', value: 'q'}}});
    const first = await mountStage({ts});
    const banner = first.el.querySelector('.stage-banners .stage-review');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('Is this the right recording?');
    [...banner.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === COPY.reviewDismiss).click();
    await first.unmount();
    const second = await mountStage({ts});
    expect(second.el.querySelector('.stage-review')).toBeNull();
  });

  test('sheet commands open through the host, anchored to the Stage’s controls', async () => {
    setSheetModules({});
    const b = await mountStage();
    b.run('spot.list');
    expect(openSheetName()).toBe('spots');
    expect(document.querySelector('[data-sheet="spots"]').dataset.presentation).toBe('popover');
    b.run('mix.sheet');
    expect(openSheetName()).toBe('mix');
    b.run('stage.notes');
    expect(b.el.querySelector('.stage-notes-host [data-sheet="notes"]')).toBeTruthy();
    await b.unmount();
    expect(openSheetName()).toBeNull();
  });

  test('the ⋯ menu waits for ST8a’s menus.js; with it, stage.menu opens stageMenu at the HUD', async () => {
    const plain = await mountStage();
    expect(plain.state('stage.menu').visible).toBe(false);
    await plain.unmount();
    const stageMenu = vi.fn(() => [{label: 'Focus'}]);
    const log = [];
    const b = await mountStage({later: {...fakeLater(log), './menus.js': async () => ({stageMenu})}});
    expect(b.state('stage.menu').enabled).toBe(true);
    b.run('stage.menu');
    await settle();
    expect(stageMenu).toHaveBeenCalledWith(b.ts.session, b.api);
    expect(b.menuOpen).toHaveBeenCalled();
  });

  test('Share flushes, then opens SH1’s dialog', async () => {
    const openShareDialog = vi.fn();
    const log = [];
    const b = await mountStage({later: {...fakeLater(log), '../share/share-dialog.js': async () => ({openShareDialog})}});
    const flush = vi.spyOn(b.ts.session, 'flush');
    b.run('stage.share');
    await settle();
    expect(flush).toHaveBeenCalledWith({final: true});
    expect(openShareDialog).toHaveBeenCalledWith(expect.objectContaining({session: b.ts.session}));
  });

  test('scrolling commands scroll the surface’s scroller', async () => {
    const b = await mountStage();
    b.run('stage.scrollDown');
    expect(b.surface.scroller.scrollBy).toHaveBeenCalled();
    b.run('stage.scrollTop');
    expect(b.surface.scroller.scrollTo).toHaveBeenCalledWith({top: 0, behavior: 'smooth'});
  });

  test('unmount saves the anchor, flushes, tears everything down and clears the root attributes', async () => {
    const b = await mountStage();
    const flush = vi.spyOn(b.ts.session, 'flush');
    await b.unmount();
    expect(b.ts.value.anchorTime).toBe(12.5);
    expect(b.ts.value.anchorBar).toBe(7);
    expect(flush).toHaveBeenCalledWith({final: true});
    expect(hoisted.huds[0].destroy).toHaveBeenCalled();
    expect(hoisted.strips[0].destroy).toHaveBeenCalled();
    expect(b.el.querySelector('.stage')).toBeNull();
    expect(document.documentElement.dataset.loadPhase).toBeUndefined();
    expect(document.documentElement.dataset.transportPhase).toBeUndefined();
    expect(b.registry.context().stage).toBeFalsy();
  });

  describe('the Library → Stage View Transition', () => {
    function libraryCover(id) {
      const cover = document.body.appendChild(document.createElement('div'));
      cover.className = 'lib-card-cover';
      cover.style.setProperty('view-transition-name', `cover-${id}`);
      cover.dataset.coverNamed = '';
      return cover;
    }
    function fakeTransitions() {
      const calls = [];
      document.startViewTransition = vi.fn((update) => {
        const done = Promise.resolve().then(update);
        const t = {updateCallbackDone: done, finished: done.then(() => {}), ready: done};
        calls.push(t);
        return t;
      });
      cleanups.push(() => { delete document.startViewTransition; });
      return calls;
    }
    function hookRouter() {
      let hook = null;
      const router = {navigate: vi.fn(), back: vi.fn(), setQuery: vi.fn(), link: vi.fn(() => () => {}), onLeave: vi.fn((fn) => { hook = fn; return () => {}; })};
      return {router, leave: (from, to) => hook(from, to)};
    }

    test('opening a card keeps its cover as the ghost; the Stage morphs it into the identity cover', async () => {
      const calls = fakeTransitions();
      const ts = await session({id: 'glass'});
      const {router, leave} = hookRouter();
      const platform = {features: {viewTransition: true}, reducedMotion: signal(false)};
      stage.armStageEntry(router, {platform, document});
      const cover = libraryCover('glass');
      leave({name: 'library'}, {name: 'stage', params: {songId: 'glass'}});
      const ghost = document.querySelector('.stage-entry-ghost');
      expect(ghost).toBeTruthy();
      expect(ghost.style.getPropertyValue('view-transition-name')).toBe('cover-glass');
      expect(cover.style.getPropertyValue('view-transition-name')).toBe('');
      cover.remove();   // the router unmounts the Library
      const b = await mountStage({ts, router, platform});
      expect(document.startViewTransition).toHaveBeenCalledTimes(1);
      expect(document.querySelector('.stage-entry-ghost')).toBeNull();
      expect(b.root).toBeTruthy();
      await calls[0].finished;
      await settle();
      expect(hoisted.huds[0].cover.style.getPropertyValue('view-transition-name')).toBe('');
    });

    test('no View Transitions (or another place): no ghost, and the Stage simply appears', async () => {
      const ts = await session({id: 'glass'});
      const {router, leave} = hookRouter();
      stage.armStageEntry(router, {platform: {features: {viewTransition: false}, reducedMotion: signal(false)}, document});
      libraryCover('glass');
      leave({name: 'library'}, {name: 'stage', params: {songId: 'glass'}});
      expect(document.querySelector('.stage-entry-ghost')).toBeNull();
      const b = await mountStage({ts, router});
      expect(b.root).toBeTruthy();
    });

    test('reduced motion: no transition', async () => {
      fakeTransitions();
      const ts = await session({id: 'glass'});
      const {router, leave} = hookRouter();
      const platform = {features: {viewTransition: true}, reducedMotion: signal(true)};
      stage.armStageEntry(router, {platform, document});
      libraryCover('glass');
      leave({name: 'library'}, {name: 'stage', params: {songId: 'glass'}});
      expect(document.querySelector('.stage-entry-ghost')).toBeNull();
      await mountStage({ts, router, platform});
      expect(document.startViewTransition).not.toHaveBeenCalled();
    });

    test('an unused ghost leaves after 4 s', async () => {
      fakeTransitions();
      const {router, leave} = hookRouter();
      stage.armStageEntry(router, {platform: {features: {viewTransition: true}, reducedMotion: signal(false)}, document});
      libraryCover('x');
      leave({name: 'library'}, {name: 'stage', params: {songId: 'x'}});
      expect(document.querySelector('.stage-entry-ghost')).toBeTruthy();
      vi.advanceTimersByTime(stage.ENTRY_WAIT_MS);
      expect(document.querySelector('.stage-entry-ghost')).toBeNull();
    });
  });

  test('surfaceDefault: Chart only with notation (or, before the part answers, a chart)', () => {
    expect(stage.surfaceDefault({hasChart: true}, true)).toBe('chart');
    expect(stage.surfaceDefault({hasChart: true}, false)).toBe('roadmap');
    expect(stage.surfaceDefault({hasChart: true}, null)).toBe('chart');
    expect(stage.surfaceDefault({hasChart: false}, null)).toBe('roadmap');
  });

  test('CONTROLS: every row renders with its role and accessible name', async () => {
    const practice = {v: 2, cue: 30, rate: 0.9, loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none'}, tracks: [], minusMe: false, trainer: null, spots: [], markers: []};
    const ts = await session({practice, recordingUnconfirmed: true, song: {provider: 'YouTube'}});
    ts.session.detect = {...ts.session.detect, offer: signal({jobId: 'j'}), dismissOffer: vi.fn()};
    const ok = await mountStage({ts});
    const missingMedia = {signKeys: vi.fn(async () => ({}))};
    const failed = await mountStage({sessionOptions: {media: missingMedia}});
    const lost = await mountStage({ts: null, sessionError: new ApiError({code: 'not_found'})});
    const roleOf = (el) => el.getAttribute('role') ?? ({BUTTON: 'button', A: 'link'}[el.tagName] ?? null);
    const nameOf = (el) => (el.getAttribute('aria-label') ?? el.textContent).replace(/\s+/g, ' ').trim();
    const find = (root, row) => [...root.querySelectorAll('button, a, [role]')].find((el) => roleOf(el) === row.role && nameOf(el).startsWith(row.name));
    const hosts = {
      resume: ok.el, review: ok.el, 'detect-offer': ok.el, surface: ok.el, status: ok.el,
      'load-error': failed.el, 'load-error-missing': failed.el, 'not-found': lost.el,
    };
    feedback.status('Bars found while you were away', {action: {label: 'Use them', run() {}}, key: 'detect-offer'});
    for (const row of CONTROLS.filter((r) => r.where !== 'resume')) {
      expect(find(hosts[row.where], row), `${row.where}: ${row.role} "${row.name}"`).toBeTruthy();
    }
    expect(CONTROLS.find((r) => r.where === 'resume').name).toBe(COPY.startOver);
  });

  test('CONTROLS resume row: the chip’s Start over is a button with that name', async () => {
    const practice = {v: 2, cue: 30, rate: 0.9, loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none'}, tracks: [], minusMe: false, trainer: null, spots: [], markers: []};
    const b = await mountStage({sessionOptions: {practice}});
    const row = CONTROLS.find((r) => r.where === 'resume');
    const el = b.statusButton(row.name);
    expect(el?.tagName).toBe('BUTTON');
  });
});
