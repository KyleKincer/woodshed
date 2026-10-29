// @vitest-environment happy-dom
// Edit · Map lanes (src/edit/map/lane.js and sections.js; architecture §2.15, D20, D23, D47; spec §5.1
// "bar ruler with meter chips", "sections lane (32 px, editable blocks)", "tempo lane (96 px): flat
// steps, ramps, amber-striped suspect spans; pins are 12 px diamonds with 24 px hit areas (44 on
// coarse)", "Markers → sections"; maps/mapedit.md §5.6, §6). Each lane is mounted on its own over a
// real song session (tests/helpers/test-session.js) and the real map session, wired as Edit wires it.
// Canvases are recording contexts; sizes and pixels are Playwright states (tests/fixture/states/ED3.cjs).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {createRegistry} from '../src/app/commands.js';
import {clock as appClock} from '../src/app/clock.js';
import {signal} from '../src/app/store.js';
import {defineStageCommands} from '../src/stage/commands.js';
import {clearHatchCache} from '../src/stage/wave-render.js';
import {tempoGeometry} from '../src/js/map-lane.js';
import {SongMapStore} from '../src/js/song-map.js';
import {fraction} from '../shared/notation.ts';
import {clockText, createMapSession} from '../src/edit/map/session.js';
import {LANE_PX, createRuler, createTempoLane, drawTempoLane, lineName, timeMarks} from '../src/edit/map/lane.js';
import {createMarkersBanner, createSectionsLane} from '../src/edit/map/sections.js';
import {COPY, MAP_COMMANDS as C} from '../src/edit/map/map.copy.js';
import {defineMapCommands} from '../src/edit/map/commands.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {createRecordingContext, installCanvasShim, installPopoverShim, keydown, pointer, restoreDomShims, setRect} from './helpers/dom.js';
import {legacySongMap, pickup} from './fixtures/maps.js';

let clock, restoreAudio;
const current = [];

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(Date.parse('2026-10-28T12:00:00Z'));
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
  installPopoverShim();
  installCanvasShim();
  clearHatchCache();
});

afterEach(async () => {
  for (const off of current.splice(0).reverse()) await off();
  document.body.replaceChildren();
  restoreDomShims();
  restoreAudio();
  vi.useRealTimers();
});

/** A song session and its map session (the hooks Edit passes, §2.15 and Appendix C item 50). */
async function songBed(options = {}) {
  const ts = await createTestSession({clock, ...options});
  const engine = ts.session.engine;
  const statuses = [];
  const hooks = {
    suspendSaves: (on, opts) => ts.session.suspendSaves?.(on, opts),
    pauseMapSync: (on) => ts.session.notation?.setMapSyncPaused?.(!!on),
    status: (text, opts) => statuses.push({text, ...opts}),
    rename: () => {},
    loop: {
      get: () => ({loop: {...engine.loop}, gap: engine.loopGap}),
      set: (value) => { const l = value?.loop; if (l && Number.isFinite(l.a) && Number.isFinite(l.b)) engine.setLoop(!!l.enabled, l.a, l.b); },
    },
    markers: {
      list: () => (ts.session.practice.value.peek().markers ?? []).filter((m) => !m.deleted),
      tombstone: (ids, deleted = true) => {
        const set = new Set(ids ?? []);
        ts.session.practice.patch((p) => { for (const m of p.markers) if (set.has(m.id)) m.deleted = !!deleted; });
      },
    },
  };
  const prefs = {get: () => undefined, set: () => {}};
  const mapSession = createMapSession({engine, metronome: ts.session.metronome, map: ts.session.map, prefs, hooks});
  ts.session.mapEditor.value = mapSession;
  const host = document.createElement('div');
  document.body.append(host);
  current.push(async () => { mapSession.destroy(); ts.session.mapEditor.value = null; await ts.dispose(); });
  return {ts, session: ts.session, map: ts.session.map, mapSession, statuses, host};
}

// ---------------------------------------------------------------------------------------------------------------

describe('the bar ruler', () => {
  test('mapped: bar numbers with the meter chip on bar 1, section labels, the selected bar; a click picks a time', async () => {
    const b = await songBed();
    const picks = [];
    const ruler = createRuler(b.host, {map: b.map, onPick: (t) => picks.push(t)});
    current.push(() => ruler.destroy());
    setRect(ruler.el, {x: 100, y: 0, width: 640, height: LANE_PX.ruler});
    ruler.render({t0: 0, span: 128, width: 640}, {mapped: true, selected: 10});
    expect(ruler.el.getAttribute('aria-hidden')).toBe('true');
    expect(ruler.el.dataset.ruler).toBe('bars');
    const marks = [...ruler.el.querySelectorAll('.map-mark')];
    expect(marks[0].querySelector('.map-mark-number').textContent).toBe('1');
    expect(marks[0].querySelector('.map-meter').textContent).toBe('4/4');
    expect(marks[0].querySelector('.map-mark-label').textContent).toBe('Intro');
    expect(ruler.el.querySelectorAll('.map-meter')).toHaveLength(1);
    expect(ruler.el.querySelector('.map-mark[data-selected]').dataset.bar).toBe('10');
    expect(marks[1].style.getPropertyValue('--x')).toMatch(/px$/);
    pointer(ruler.el, 'pointerdown', {x: 100 + 160, y: 10});
    expect(picks).toEqual([32]);
    pointer(ruler.el, 'pointerdown', {x: 300, y: 10, button: 2});
    expect(picks).toHaveLength(1);
  });

  test('unmapped: times (m:ss), never bars', async () => {
    const b = await songBed({mapped: false, duration: 90});
    const ruler = createRuler(b.host, {map: b.map});
    current.push(() => ruler.destroy());
    ruler.render({t0: 0, span: 90, width: 600}, {mapped: false});
    expect(ruler.el.dataset.ruler).toBe('time');
    const texts = [...ruler.el.querySelectorAll('.map-mark-number')].map((n) => n.textContent);
    expect(texts[0]).toBe('0:00');
    expect(texts).toContain('0:30');
    expect(ruler.el.querySelector('.map-meter')).toBeNull();
    expect(ruler.el.textContent).not.toMatch(/bar/i);
  });

  test('timeMarks keep ≥ 64 px between labels at a round step; tenths below a second', () => {
    const coarse = timeMarks({t0: 0, span: 120, width: 600, duration: 120});
    expect(coarse.map((m) => m.t)).toEqual([0, 15, 30, 45, 60, 75, 90, 105, 120]);
    const fine = timeMarks({t0: 10, span: 4, width: 800, duration: 120});
    expect(fine[0]).toMatchObject({t: 10, x: 0});
    expect(fine[1].text).toBe('0:10.5');
    expect(timeMarks({t0: 0, span: 0, width: 600})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('the tempo lane', () => {
  // legacySongMap: bar 1 pinned at 1.0 s and bar 5 at 9.0 s (120 bpm), 30 s; 600 px → 20 px a second.
  const WIDTH = 600;
  async function laneBed(options = {}) {
    const b = await songBed({tempo: structuredClone(legacySongMap.tempo), duration: 30, ...options});
    let coarse = false;
    const draws = [];
    const lane = createTempoLane(b.host, {session: b.session, mapSession: b.mapSession, coarse: () => coarse, requestDraw: () => draws.push(1)});
    current.push(() => lane.destroy());
    setRect(lane.canvas, {x: 0, y: 0, width: WIDTH, height: LANE_PX.tempo});
    const view = {t0: 0, span: 30, width: WIDTH};
    const render = () => lane.render(view, {mapped: b.map.isReal});
    render();
    const pinAt = (i) => lane.hits()[i];
    return {...b, lane, render, draws, pinAt, setCoarse: (on) => { coarse = on; }};
  }

  test('draws the curve, both 12 px pins and the selection; the canvas says how many pins and suspect spans', async () => {
    const b = await laneBed();
    const drawn = b.render();
    expect(LANE_PX.tempo).toBe(96);
    expect(b.lane.canvas.dataset.pins).toBe('2');
    expect(b.lane.canvas.dataset.suspect).toBe('0');
    expect(drawn.pins).toBe(2);
    expect(drawn.labels).toContain('120');
    expect(b.pinAt(0)).toMatchObject({x: 20});
    expect(b.pinAt(1)).toMatchObject({x: 180});
    // The guide values sit in the key column (DOM, not canvas).
    expect(b.lane.guides.querySelectorAll('.map-guide').length).toBeGreaterThan(0);
  });

  test('unmapped: nothing is drawn and no pins can be hit', async () => {
    const b = await laneBed({tempo: null, mapped: false});
    expect(b.render()).toBeNull();
    expect(b.lane.canvas.dataset.pins).toBe('0');
    expect(b.lane.hits()).toEqual([]);
  });

  test('drawTempoLane: amber stripes behind a suspect span, steps in accent, open spans dashed', () => {
    const map = new SongMapStore({version: 1, pins: [{position: fraction(0), time: 0}, {position: fraction(8), time: 4},
      {position: fraction(12), time: 5.6}, {position: fraction(20), time: 9.6}],
    measures: Array.from({length: 12}, (_, i) => ({id: 'm' + i, numerator: 4, denominator: 4, length: fraction(4), label: ''}))}, 24);
    const ctx = createRecordingContext();
    const geo = tempoGeometry(map, {t0: 0, span: 24, width: 480, height: 96});
    const colors = {ink: 'ink', ink2: 'ink2', ink3: 'ink3', accent: 'accent', accentFill: 'fill', accentSoft: 'soft', onAccent: 'on', now: 'now',
      warn: 'warn', line: 'line', lineStrong: 'strong', surface: 'surface', surface2: 'surface2', bg: 'bg', edit: 'edit', fontMono: 'mono', fontUi: 'ui'};
    const drawn = drawTempoLane(ctx, geo, {width: 480, height: 96, colors, selectedQ: fraction(8), cursorX: 80, cursorY: 40});
    expect(drawn.suspect).toBe(1);
    expect(drawn.pins).toBe(4);
    expect(drawn.selected).toBe(true);
    const strokes = ctx.setsOf('strokeStyle');
    expect(strokes).toContain('warn');
    expect(strokes).toContain('accent');
    expect(ctx.callsOf('setLineDash').some(([d]) => d.length === 2 && d[0] === 5)).toBe(true);   // the open tail
    expect(ctx.callsOf('createPattern').length).toBeGreaterThan(0);                            // the hatch
  });

  test('a pin drag moves the pin as one map step (2 ms inside its neighbours), says where, and Undo puts it back', async () => {
    const b = await laneBed();
    const pin = b.pinAt(1);
    const undo = b.map.undoStack.length;
    pointer(b.lane.canvas, 'pointerdown', {x: pin.x, y: pin.y, pointerId: 7});
    expect(b.lane.dragging).toBe(true);
    pointer(b.lane.canvas, 'pointermove', {x: pin.x + 1, y: pin.y, pointerId: 7});   // inside the 2 px slop
    expect(b.map.data.pins[1].time).toBe(9);
    pointer(b.lane.canvas, 'pointermove', {x: pin.x + 10, y: pin.y, pointerId: 7});
    pointer(b.lane.canvas, 'pointermove', {x: pin.x + 20, y: pin.y, pointerId: 7});
    expect(b.map.data.pins[1].time).toBeCloseTo(10, 6);
    expect(b.lane.el.querySelector('.map-tip').hidden).toBe(false);
    pointer(b.lane.canvas, 'pointerup', {x: pin.x + 20, y: pin.y, pointerId: 7});
    expect(b.lane.dragging).toBe(false);
    expect(b.map.undoStack.length).toBe(undo + 1);
    expect(b.map.data.origin).not.toBeUndefined();
    expect(b.mapSession.message.peek().tone).toBe('ok');
    // A drag the map refuses (four bars squeezed into 2 ms against the previous pin) keeps the last valid
    // place and says why, in the error tone; the view redraws on requestDraw.
    expect(b.draws.length).toBeGreaterThan(0);
    b.render();
    const again = b.pinAt(1);
    expect(again.x).toBeCloseTo(200, 6);
    const undo2 = b.map.undoStack.length;
    pointer(b.lane.canvas, 'pointerdown', {x: again.x, y: again.y, pointerId: 8});
    pointer(b.lane.canvas, 'pointermove', {x: 160, y: again.y, pointerId: 8});   // 8 s: fine
    pointer(b.lane.canvas, 'pointermove', {x: 0, y: again.y, pointerId: 8});     // 1.002 s: refused
    expect(b.mapSession.message.peek().tone).toBe('error');
    pointer(b.lane.canvas, 'pointerup', {x: 0, y: again.y, pointerId: 8});
    expect(b.map.data.pins[1].time).toBeCloseTo(8, 6);
    expect(b.map.undoStack.length).toBe(undo2 + 1);
    b.mapSession.undo();
    expect(b.map.data.pins[1].time).toBeCloseTo(10, 6);
    b.mapSession.undo();
    expect(b.map.data.pins[1].time).toBe(9);
  });

  test('a cancelled drag (pointercancel) restores the pin and leaves no undo step', async () => {
    const b = await laneBed();
    const pin = b.pinAt(1);
    const undo = b.map.undoStack.length;
    pointer(b.lane.canvas, 'pointerdown', {x: pin.x, y: pin.y, pointerId: 3});
    pointer(b.lane.canvas, 'pointermove', {x: pin.x + 40, y: pin.y, pointerId: 3});
    pointer(b.lane.canvas, 'pointercancel', {x: pin.x + 40, y: pin.y, pointerId: 3});
    expect(b.map.data.pins[1].time).toBe(9);
    expect(b.map.undoStack.length).toBe(undo);
  });

  test('hits: 24 px squares with a mouse, 44 px on coarse pointers and touch', async () => {
    const b = await laneBed();
    const pin = b.pinAt(1);
    pointer(b.lane.canvas, 'pointerdown', {x: pin.x + 16, y: pin.y + 16, pointerId: 1});
    expect(b.lane.dragging).toBe(false);   // missed: it selected the nearest line instead
    pointer(b.lane.canvas, 'pointerdown', {x: pin.x + 16, y: pin.y + 16, pointerId: 2, pointerType: 'touch'});
    expect(b.lane.dragging).toBe(true);
    pointer(b.lane.canvas, 'pointerup', {x: pin.x + 16, y: pin.y + 16, pointerId: 2, pointerType: 'touch'});
    b.setCoarse(true);
    pointer(b.lane.canvas, 'pointerdown', {x: pin.x - 18, y: pin.y - 18, pointerId: 4});
    expect(b.lane.dragging).toBe(true);
    pointer(b.lane.canvas, 'pointerup', {x: pin.x - 18, y: pin.y - 18, pointerId: 4});
  });

  test('a click off the pins selects the nearest line and, stopped, cues there', async () => {
    const b = await laneBed();
    pointer(b.lane.canvas, 'pointerdown', {x: 20 * 13.1, y: 80});
    expect(b.map.timeAt(b.mapSession.cursorQ.peek())).toBeCloseTo(13, 6);
    expect(b.ts.snapshot.cue).toBeCloseTo(13, 6);
  });

  test('double-click pins the nearest line where it is, and unpins a pinned one', async () => {
    const b = await laneBed();
    const event = (x) => b.lane.canvas.dispatchEvent(new window.MouseEvent('dblclick', {bubbles: true, clientX: x, clientY: 50}));
    event(20 * 17.05);
    expect(b.map.data.pins.some((p) => Math.abs(p.time - 17) < 1e-6)).toBe(true);
    expect(b.map.data.pins).toHaveLength(3);
    event(20 * 17.05);
    expect(b.map.data.pins).toHaveLength(2);
  });

  test('hover tips name the pin or the line; leaving hides the tip', async () => {
    const b = await laneBed();
    const pin = b.pinAt(1);
    const tip = b.lane.el.querySelector('.map-tip');
    pointer(b.lane.canvas, 'pointermove', {x: pin.x, y: pin.y});
    expect(tip.textContent).toBe(COPY.pinTip(lineName(b.map, pin.pin.position), clockText(9)));
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(b.lane.canvas.dataset.hover).toBe('pin');
    pointer(b.lane.canvas, 'pointermove', {x: 20 * 13, y: 80});
    expect(tip.textContent).toBe(COPY.lineTip('bar 7', '120'));
    b.lane.canvas.dispatchEvent(new window.PointerEvent('pointerleave', {bubbles: true}));
    expect(tip.hidden).toBe(true);
  });

  test('lane edits are refused while Find a chart auditions (D20) and on a read-only song', async () => {
    const b = await laneBed();
    b.mapSession.beginAudition();
    const pin = b.pinAt(1);
    pointer(b.lane.canvas, 'pointerdown', {x: pin.x, y: pin.y});
    expect(b.lane.dragging).toBe(false);
    expect(b.mapSession.message.peek()).toEqual({text: COPY.auditioning, tone: 'error'});
    b.lane.canvas.dispatchEvent(new window.MouseEvent('dblclick', {bubbles: true, clientX: 20 * 17, clientY: 50}));
    expect(b.map.data.pins).toHaveLength(2);
    b.mapSession.endAudition({commit: false});
    const shared = await laneBed({shared: {}});
    expect(shared.session.readOnly).toBe(true);
    const p = shared.pinAt(1);
    pointer(shared.lane.canvas, 'pointerdown', {x: p.x, y: p.y});
    expect(shared.lane.dragging).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('the sections lane', () => {
  // The default song: 64 bars of 4/4 at 120 bpm, eight sections of eight bars. 640 px → 5 px a second, 10 px a bar.
  async function sectionsBed(options = {}) {
    const b = await songBed(options);
    const registry = createRegistry();
    defineMapCommands({registry});
    defineStageCommands({registry, later: {}});
    registry.provide('session', () => b.session);
    registry.provide('transport', () => b.session.transport);
    registry.provide('map', () => b.mapSession);
    const lane = createSectionsLane(b.host, {session: b.session, mapSession: b.mapSession, registry});
    b.host.append(lane.bar);
    current.push(() => lane.destroy());
    setRect(lane.el, {x: 0, y: 0, width: 640, height: LANE_PX.sections});
    const view = {t0: 0, span: b.map.duration, width: 640};
    lane.render(view);
    return {...b, lane, registry, view};
  }
  const names = (lane) => [...lane.el.querySelectorAll('.map-section-name')].map((n) => n.textContent);

  test('one editable block per section, named with its bars; a name click selects its first bar and cues there', async () => {
    const b = await sectionsBed();
    expect(LANE_PX.sections).toBe(32);
    expect(b.lane.el.getAttribute('role')).toBe('group');
    expect(b.lane.el.getAttribute('aria-label')).toBe(COPY.sectionsLane);
    expect(b.lane.el.dataset.mode).toBe('sections');
    expect(names(b.lane)).toEqual(['Intro', 'Verse', 'Chorus', 'Verse 2', 'Chorus 2', 'Bridge', 'Chorus 3', 'Outro']);
    const verse = b.lane.el.querySelectorAll('.map-section-name')[1];
    expect(verse.getAttribute('aria-label')).toBe(COPY.sectionBlock('Verse', 9, 16));
    expect(verse.closest('.map-section').style.getPropertyValue('--x0')).toBe('80px');
    verse.click();
    expect(b.mapSession.span.peek().index).toBe(8);
    expect(b.ts.snapshot.cue).toBeCloseTo(16, 6);
  });

  test('rename inline: double-click (or F2) opens the field; Enter keeps the name (one map step), Esc cancels, empty removes it', async () => {
    const b = await sectionsBed();
    const undo = b.map.undoStack.length;
    b.lane.el.querySelectorAll('.map-section-name')[2].dispatchEvent(new window.MouseEvent('dblclick', {bubbles: true}));
    let field = b.lane.el.querySelector('.map-section-input');
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('aria-label')).toBe(COPY.renameField('Chorus'));
    expect(field.dataset.consumeKeys).toBe('Escape');
    field.value = 'Hook';
    keydown('Enter', {target: field});
    expect(b.map.measure(16).label).toBe('Hook');
    expect(b.map.undoStack.length).toBe(undo + 1);
    expect(names(b.lane)[2]).toBe('Hook');
    // F2 on the name; Esc cancels.
    const bridge = b.lane.el.querySelectorAll('.map-section-name')[5];
    keydown('F2', {target: bridge});
    field = b.lane.el.querySelector('.map-section-input');
    field.value = 'Nope';
    keydown('Escape', {target: field});
    expect(b.map.measure(40).label).toBe('Bridge');
    expect(b.lane.renaming).toBe(false);
    // An empty name removes the section.
    b.lane.rename(40);
    field = b.lane.el.querySelector('.map-section-input');
    field.value = '';
    keydown('Enter', {target: field});
    expect(names(b.lane)).not.toContain('Bridge');
  });

  test('a section start is a slider: ← → move it a bar (one map step each), Home / End clamp, Undo puts it back', async () => {
    const b = await sectionsBed();
    const handle = b.lane.el.querySelector('.map-boundary[data-from="8"]');
    expect(handle.getAttribute('role')).toBe('slider');
    expect(handle.getAttribute('aria-label')).toBe(COPY.boundary('Verse'));
    expect(handle.getAttribute('aria-valuetext')).toBe(COPY.boundaryValue('bar 9'));
    expect(handle.dataset.consumeKeys).toContain('ArrowLeft');
    // The first section starts the song: no handle.
    expect(b.lane.el.querySelector('.map-boundary[data-from="0"]')).toBeNull();
    handle.focus();
    keydown('ArrowRight', {target: handle});
    expect(b.map.sections[1]).toMatchObject({name: 'Verse', startBar: 9});
    expect(document.activeElement?.dataset.from).toBe('9');
    keydown('ArrowLeft', {target: document.activeElement});
    keydown('ArrowLeft', {target: document.activeElement});
    expect(b.map.sections[1].startBar).toBe(7);
    b.mapSession.undo(); b.mapSession.undo(); b.mapSession.undo();
    expect(b.map.sections[1].startBar).toBe(8);
  });

  test('a boundary drag snaps to the nearest bar on release (24 px handle)', async () => {
    const b = await sectionsBed();
    const handle = b.lane.el.querySelector('.map-boundary[data-from="16"]');
    pointer(handle, 'pointerdown', {x: 160, y: 10, pointerId: 5});
    expect(handle.hasAttribute('data-dragging')).toBe(true);
    pointer(handle, 'pointermove', {x: 196, y: 10, pointerId: 5});   // 39.2 s → bar index 20 (40 s)
    expect(handle.getAttribute('aria-valuetext')).toBe(COPY.boundaryValue('bar 21'));
    pointer(handle, 'pointerup', {x: 196, y: 10, pointerId: 5});
    expect(b.map.sections[2]).toMatchObject({name: 'Chorus', startBar: 20});
  });

  test('while auditioning (D20) or read-only, rename and boundary drags are refused', async () => {
    const b = await sectionsBed();
    b.mapSession.beginAudition();
    expect(b.lane.rename(8)).toBe(false);
    const handle = b.lane.el.querySelector('.map-boundary[data-from="8"]');
    pointer(handle, 'pointerdown', {x: 80, y: 10});
    expect(handle.hasAttribute('data-dragging')).toBe(false);
    expect(b.mapSession.message.peek()).toEqual({text: COPY.auditioning, tone: 'error'});
    b.mapSession.endAudition({commit: false});
  });

  test('a mapped song with no sections reads "No sections yet"; unmapped shows nothing', async () => {
    const b = await sectionsBed({tempo: structuredClone(pickup.tempo), duration: 20});
    expect(b.lane.el.dataset.mode).toBe('empty');
    expect(b.lane.el.textContent).toBe(COPY.noSections);
    const u = await sectionsBed({mapped: false});
    expect(u.lane.el.dataset.mode).toBe('unmapped');
    expect(u.lane.el.textContent).toBe('');
  });

  const SUGGESTION = {jobId: 'job-s', createdAt: 1, sections: [{t0: 0, label: 'Intro', confidence: 0.8}, {t0: 8.1, label: 'Verse', confidence: 0.7},
    {t0: 15.9, label: 'Chorus', confidence: 0.7}]};

  test('suggested sections (D47): dashed blocks with [Keep all] [Review]; Keep all adds them all as one map step', async () => {
    const b = await sectionsBed({tempo: structuredClone(pickup.tempo), duration: 20, sectionSuggestion: SUGGESTION});
    expect(b.lane.el.dataset.mode).toBe('suggestion');
    expect([...b.lane.el.querySelectorAll('.map-suggested')].map((n) => n.textContent)).toEqual(['Intro', 'Verse', 'Chorus']);
    expect(b.lane.bar.hidden).toBe(false);
    expect(b.lane.bar.querySelector('.map-sections-bar-text').textContent).toBe(COPY.suggestion);
    const buttons = [...b.lane.bar.querySelectorAll('button')].map((n) => n.textContent.trim());
    expect(buttons).toEqual([COPY.keepAll, COPY.review]);
    const undo = b.map.undoStack.length;
    await b.registry.run(C.keepAll, {source: 'pointer'});
    await settle();
    expect(b.map.sections.map((s) => s.name)).toEqual(['Intro', 'Verse', 'Chorus']);
    expect(b.map.undoStack.length).toBe(undo + 1);
    expect(b.ts.server.calls.dismissSectionSuggestion).toHaveLength(1);
  });

  test('the review: ✓/✕ per block, a name field, a draggable start, [Apply N] keeps the accepted ones as one step; Esc cancels', async () => {
    const b = await sectionsBed({tempo: structuredClone(pickup.tempo), duration: 20, sectionSuggestion: SUGGESTION});
    expect(b.lane.openReview()).toBe(true);
    expect(b.lane.el.dataset.mode).toBe('review');
    expect(b.lane.reviewing).toBe(true);
    expect(document.activeElement?.classList.contains('map-suggested-toggle')).toBe(true);
    const apply = () => [...b.lane.bar.querySelectorAll('button')].find((n) => n.classList.contains('map-review-apply'));
    expect(apply().textContent.trim()).toBe(COPY.applyReview(3));
    // ✕ on Verse.
    const drop = b.lane.el.querySelector(`[aria-label="${COPY.reject('Verse')}"]`);
    drop.click();
    expect(b.lane.el.querySelector(`[aria-label="${COPY.reject('Verse')}"]`).getAttribute('aria-pressed')).toBe('true');
    expect(b.lane.el.querySelector(`[aria-label="${COPY.accept('Verse')}"]`).getAttribute('aria-pressed')).toBe('false');
    expect(apply().textContent.trim()).toBe(COPY.applyReview(2));
    // Rename Chorus.
    const input = b.lane.el.querySelector(`[aria-label="${COPY.reviewLabel('Chorus')}"]`);
    input.value = 'Refrain';
    keydown('Enter', {target: input});
    expect(b.mapSession.review.peek().blocks.find((x) => x.label === 'Refrain')).toBeTruthy();
    // Move Refrain's start a bar later from its handle.
    const handle = b.lane.el.querySelector(`[aria-label="${COPY.reviewBoundary('Refrain')}"]`);
    const from = Number(handle.dataset.from);
    keydown('ArrowRight', {target: handle});
    expect(b.mapSession.review.peek().blocks.find((x) => x.label === 'Refrain').bar).toBe(from + 1);
    const undo = b.map.undoStack.length;
    apply().click();
    expect(b.map.sections.map((s) => s.name)).toEqual(['Intro', 'Refrain']);
    expect(b.map.sections[1].startBar).toBe(from + 1);
    expect(b.map.undoStack.length).toBe(undo + 1);
    expect(b.lane.reviewing).toBe(false);
    await settle();
    expect(b.ts.server.calls.dismissSectionSuggestion).toHaveLength(1);
  });

  test('Esc closes the review and changes nothing', async () => {
    const b = await sectionsBed({tempo: structuredClone(pickup.tempo), duration: 20, sectionSuggestion: SUGGESTION});
    b.lane.openReview();
    keydown('Escape', {target: b.lane.el.querySelector('.map-suggested-toggle')});
    expect(b.lane.reviewing).toBe(false);
    expect(b.map.hasSections).toBe(false);
    expect(b.lane.el.dataset.mode).toBe('suggestion');
    // With nothing to review, Review says so.
    const none = await sectionsBed();
    expect(none.lane.openReview()).toBe(false);
    expect(none.mapSession.message.peek().text).toBe(COPY.noSuggestion);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('the markers → sections banner', () => {
  const markers = [
    {id: 'mk1', t: 31.6, label: 'Big fill', updatedAt: 1},
    {id: 'mk2', t: 64.3, label: 'Key change', updatedAt: 1},
    {id: 'mk3', t: 90, label: 'Gone', updatedAt: 1, deleted: true},
  ];
  const practice = (fields = {}) => ({v: 2, cue: 0, rate: 1, tracks: [], minusMe: false, trainer: null, spots: [], markers: structuredClone(markers),
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none'}, ...fields});

  async function bannerBed(options = {}) {
    const b = await songBed({tempo: structuredClone(pickup.tempo), duration: 128, practice: practice(), ...options});
    const registry = createRegistry();
    defineMapCommands({registry});
    registry.provide('session', () => b.session);
    registry.provide('map', () => b.mapSession);
    const banner = createMarkersBanner(b.host, {session: b.session, registry});
    current.push(() => banner.destroy());
    vi.advanceTimersByTime(60);
    return {...b, banner, registry};
  }

  test('"You have 2 markers. [Turn them into sections] (snaps each to the nearest bar)": one map step that also tombstones them; Undo brings both back', async () => {
    const b = await bannerBed();
    expect(b.banner.el.hidden).toBe(false);
    expect(b.banner.el.textContent).toContain(COPY.markers(2));
    expect(b.banner.el.textContent).toContain(COPY.markersNote);
    const button = [...b.banner.el.querySelectorAll('button')].find((n) => n.textContent.trim() === COPY.markersAction);
    expect(button).toBeTruthy();
    button.click();
    await settle();
    expect(b.map.sections.map((s) => s.label).filter(Boolean)).toEqual(['Big fill', 'Key change']);
    expect(b.session.practice.value.peek().markers.filter((m) => !m.deleted)).toHaveLength(0);
    expect(b.banner.el.hidden).toBe(true);
    expect(b.statuses.at(-1)?.action?.label).toBeTruthy();   // the status line offers Undo
    b.mapSession.undo();
    expect(b.map.hasSections).toBe(false);
    expect(b.session.practice.value.peek().markers.filter((m) => !m.deleted).map((m) => m.id)).toEqual(['mk1', 'mk2']);
    expect(b.banner.el.hidden).toBe(false);
  });

  test('hidden when unmapped, read-only or without live markers', async () => {
    const unmapped = await bannerBed({tempo: null, mapped: false});
    expect(unmapped.banner.el.hidden).toBe(true);
    const none = await bannerBed({practice: practice({markers: []})});
    expect(none.banner.el.hidden).toBe(true);
    const shared = await bannerBed({shared: {}});
    expect(shared.banner.el.hidden).toBe(true);
  });
});
