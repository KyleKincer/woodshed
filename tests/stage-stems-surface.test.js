// @vitest-environment happy-dom
// The Stems surface (src/stage/surfaces/stems-surface.js; architecture §2.14.12 and §3.3, spec §4.4D)
// on a real song session (tests/helpers/test-session.js: SongMapStore, Metronome and MultitrackEngine
// over tests/helpers/fake-audio.js, transport, position, practice state, undo). Gestures go through the
// real press recogniser, pinch recogniser and loop handles (pointer and wheel events); keys go through
// the real dispatcher. Sizes, colours and the 168/128 px headers are Playwright states
// (tests/fixture/states/ST11.cjs); here the canvas is a recording context.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {createRegistry} from '../src/app/commands.js';
import {activeScopeChain, setSurfaceScope, startDispatcher} from '../src/app/dispatch.js';
import {clock as appClock} from '../src/app/clock.js';
import {signal} from '../src/app/store.js';
import {clearHatchCache} from '../src/stage/wave-render.js';
import {
  COMMAND_IDS, CONTROLS, COPY, FOLLOW_IDLE_MS, FOLLOW_LINE, GRID_MIN_PX, MIN_SPAN, SCOPE, ZOOM_SAVE_MS,
  clampView, createStemsSurface, defineStemsCommands, loopView, rowState, rowWord, rulerMarks, stemsCommandDefs, timeLabel, zoomView,
} from '../src/stage/surfaces/stems-surface.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {contextOf, installCanvasShim, installPopoverShim, installResizeObserverShim, keydown, pointer, restoreDomShims, setRect, triggerResize} from './helpers/dom.js';

const LEFT = 168, TOP = 64, WIDTH = 800, HEIGHT = 400;
const DURATION = 128;   // the rehearsal song: 64 bars of 2 s at 120 bpm, 4/4

let clock, restoreAudio, current = [];
/** Animation frames for the surface's redraws, run by frame() (deterministic under fake timers). */
const frames = new Map();
let frameId = 0;
const raf = (fn) => { frames.set(++frameId, fn); return frameId; };
const caf = (id) => { frames.delete(id); };

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(Date.parse('2026-10-28T12:00:00Z'));
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
  installPopoverShim();
  installCanvasShim();
  installResizeObserverShim();
  clearHatchCache();
  frames.clear();
});

afterEach(async () => {
  for (const off of current.splice(0).reverse()) await off();
  setSurfaceScope(null);
  document.body.replaceChildren();
  delete document.documentElement.dataset.place;
  delete document.documentElement.dataset.posture;
  restoreDomShims();
  restoreAudio();
  vi.useRealTimers();
});

/** A v2 practice blob. */
function practiceOf(fields = {}) {
  return {v: 2, cue: 0, rate: 1, tracks: [], minusMe: false, trainer: null, spots: [], markers: [], ...fields,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none', ...(fields.loop ?? {})}};
}

/** Device prefs over a signal (prefs.js's shape: value, get(path), set(path, v)). */
function fakePrefs(stems = {}) {
  const value = signal({stems: {grid: 'bar', snap: true, follow: true, zoom: null, ...stems}});
  const writes = [];
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  return {
    value, writes,
    get: (path) => getPath(value.peek(), path),
    set(path, v) {
      writes.push([path, v]);
      const next = structuredClone(value.peek());
      const keys = path.split('.');
      let o = next;
      for (const k of keys.slice(0, -1)) o = o[k] ??= {};
      o[keys[keys.length - 1]] = v;
      value.value = next;
    },
  };
}

const laptop = () => ({isIPad: false, coarse: signal(false)});
const ipad = () => ({isIPad: true, coarse: signal(true)});

/** A session, an isolated registry, and a mounted surface with a measured lanes box. */
async function bed({prefs = fakePrefs(), platform = laptop(), stage = null, dispatcher = false, beforeMount = null, ...options} = {}) {
  const ts = await createTestSession({clock, ...options});
  const reg = createRegistry();
  beforeMount?.(reg);
  reg.provide('session', () => ts.session);
  reg.provide('transport', () => ts.session.transport);
  const host = document.createElement('div');
  document.body.append(host);
  const activations = [], edits = [], follows = [], scopes = [];
  let stop = null;
  if (dispatcher) {
    document.documentElement.dataset.place = 'stage';
    document.documentElement.dataset.posture = 'stage';
    stop = startDispatcher({registry: reg, platform: 'win'});
  }
  const surface = createStemsSurface(host, {
    session: ts.session, stage, registry: reg, prefs, platform, layout: 'rail', distance: 'stand',
    raf, caf,
    onActivate: (e) => activations.push(e),
    onLoopEdit: (e) => edits.push(e),
    onFollowChange: (on) => follows.push(on),
    status: () => {},
    ...(dispatcher ? {} : {setSurfaceScope: (name) => scopes.push(name)}),
  });
  const root = host.querySelector('section.stems');
  const lanes = root.querySelector('.stems-lanes');
  setRect(lanes, {x: LEFT, y: TOP, width: WIDTH, height: HEIGHT});
  triggerResize(lanes);
  current.push(async () => { surface.destroy(); stop?.(); await ts.dispose(); });
  return {
    ts, reg, surface, host, root, lanes, prefs, activations, edits, follows, scopes,
    get snap() { return ts.snapshot; },
    canvas: root.querySelector('canvas.stems-canvas'),
    heads: () => [...root.querySelectorAll('.stems-head')],
    xOf: (t) => LEFT + ((t - surface.view.t0) / surface.view.span) * WIDTH,
  };
}

function frame() {
  const batch = [...frames.values()];
  frames.clear();
  for (const fn of batch) fn(0);
}

function mouseClick(el, x, y = TOP + 50, extra = {}) {
  pointer(el, 'pointerdown', {x, y, pointerType: 'mouse', ...extra});
  pointer(el, 'pointerup', {x, y, pointerType: 'mouse', ...extra});
}

function mouseDrag(el, from, to, y = TOP + 50) {
  pointer(el, 'pointerdown', {x: from, y, pointerType: 'mouse'});
  for (let i = 1; i <= 6; i++) pointer(el, 'pointermove', {x: from + (to - from) * i / 6, y, pointerType: 'mouse'});
  pointer(el, 'pointerup', {x: to, y, pointerType: 'mouse'});
}

function wheel(el, {clientX = 0, clientY = TOP + 50, shiftKey = false, ctrlKey = false, metaKey = false, altKey = false, ...init}) {
  const event = new window.WheelEvent('wheel', {bubbles: true, cancelable: true, deltaMode: 0, ...init});
  // happy-dom's WheelEvent drops the MouseEvent fields (coordinates and modifiers).
  for (const [name, value] of Object.entries({clientX, clientY, shiftKey, ctrlKey, metaKey, altKey})) Object.defineProperty(event, name, {value});
  el.dispatchEvent(event);
  return event;
}

/** Every visible string and every accessible attribute under root. */
function strings(root) {
  const out = [root.textContent];
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const name of ['aria-label', 'aria-valuetext', 'title', 'aria-description']) {
      const v = el.getAttribute(name);
      if (v) out.push(v);
    }
  }
  return out;
}

/** The accessible name of an element (aria-label, else aria-labelledby, else its text). */
function nameOf(el) {
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
  const by = el.getAttribute('aria-labelledby');
  if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  return (el.querySelector('.ui-button-label')?.textContent ?? el.textContent).trim();
}
const ROLE_OF = (el) => el.getAttribute('role') ?? ({BUTTON: 'button', SECTION: 'region'})[el.tagName] ?? null;
function byRole(root, role, name) {
  return [root, ...root.querySelectorAll('*')].filter((el) => ROLE_OF(el) === role && !el.closest('[hidden]') && nameOf(el) === name);
}

// ---------------------------------------------------------------------------------------------------------------

describe('pure helpers', () => {
  test('clampView keeps the window inside the song as a whole and at least MIN_SPAN wide', () => {
    expect(clampView({t0: -5, span: 10}, 100)).toEqual({t0: 0, span: 10});
    expect(clampView({t0: 95, span: 10}, 100)).toEqual({t0: 90, span: 10});
    expect(clampView({t0: 10, span: 0.01}, 100)).toEqual({t0: 10, span: MIN_SPAN});
    expect(clampView({t0: 10, span: 500}, 100)).toEqual({t0: 0, span: 100});
    expect(clampView({t0: 3, span: 4}, 0)).toEqual({t0: 0, span: 0});
  });

  test('zoomView keeps the anchor time at the same place on screen', () => {
    const v = zoomView({t0: 20, span: 40}, {at: 30, factor: 0.5}, 128);
    expect(v.span).toBe(20);
    expect((30 - v.t0) / v.span).toBeCloseTo((30 - 20) / 40, 9);
    expect(zoomView({t0: 0, span: 128}, {at: 64, factor: 2}, 128)).toEqual({t0: 0, span: 128});
  });

  test('loopView leaves a 5% margin either side', () => {
    expect(loopView({a: 32, b: 48}, 128)).toEqual({t0: 31.2, span: expect.closeTo(17.6, 9)});
  });

  test('rowState and rowWord: OUT is muted, SOLO is soloed, the rest are outlines while anything is soloed', () => {
    expect(rowState({muted: false, soloed: false}, false)).toBe('on');
    expect(rowState({muted: true, soloed: false}, false)).toBe('out');
    expect(rowState({muted: false, soloed: true}, true)).toBe('solo');
    expect(rowState({muted: false, soloed: false}, true)).toBe('dim');
    expect(rowState({muted: true, soloed: false}, true)).toBe('out');
    expect(rowState({muted: true, soloed: true}, true)).toBe('solo');
    expect(rowWord({muted: true}, false)).toBe('OUT');
    expect(rowWord({soloed: true}, true)).toBe('SOLO');
    expect(rowWord({}, true)).toBe('');
  });

  test('timeLabel: m:ss, tenths below a one-second step', () => {
    expect(timeLabel(75, 5)).toBe('1:15');
    expect(timeLabel(1.5, 0.5)).toBe('0:01.5');
  });

  test('rulerMarks: unmapped times keep 64 px apart and never say "bar"', () => {
    const marks = rulerMarks({map: null, t0: 0, span: 128, width: 800});
    expect(marks.every((m) => m.kind === 'time')).toBe(true);
    expect(marks.map((m) => m.label).slice(0, 3)).toEqual(['0:00', '0:15', '0:30']);
    for (let i = 1; i < marks.length; i++) expect(marks[i].x - marks[i - 1].x).toBeGreaterThanOrEqual(64);
    expect(marks.some((m) => /bar/i.test(m.label))).toBe(false);
  });
});

describe('the toolbar, ruler and rows', () => {
  test('every CONTROLS row renders with its role and accessible name (laptop, mapped)', async () => {
    const b = await bed();
    // 'paused' (the Follow pill) shows only while Follow is paused: checked in the wheel suite.
    for (const row of CONTROLS.filter((r) => r.context !== 'paused')) {
      const found = byRole(b.root, row.role, row.name);
      expect(found.length, `${row.role} "${row.name}"`).toBeGreaterThan(0);
      if (row.command) expect(b.reg.get(row.command), row.command).not.toBeNull();
    }
    expect(b.root.querySelector('.stems-toolbar').getAttribute('aria-label')).toBe(COPY.toolbar);
  });

  test('rows follow canonical stem order with key-caps 1…N, names 16/700 and no fader on an iPad', async () => {
    const b = await bed({stems: ['other', 'vocals', 'drums', 'bass']});
    expect(b.heads().map((h) => h.querySelector('.stems-name').textContent)).toEqual(['Drums', 'Bass', 'Vocals', 'Other']);
    expect(b.heads().map((h) => h.querySelector('kbd')?.dataset.keys)).toEqual(['Digit1', 'Digit2', 'Digit3', 'Digit4']);
    expect(b.heads().every((h) => !h.querySelector('.stems-head-level').hidden)).toBe(true);
    expect(b.root.hasAttribute('data-compact')).toBe(false);

    const tablet = await bed({platform: ipad()});
    expect(tablet.root.hasAttribute('data-compact')).toBe(true);
    expect(tablet.root.hasAttribute('data-coarse')).toBe(true);
    expect(byRole(tablet.root, 'slider', COPY.level('Drums'))).toHaveLength(0);
    expect(byRole(tablet.root, 'button', COPY.mute('Drums'))).toHaveLength(1);
  });

  test('M and S mute and solo through the transport; the words and states follow (OUT, SOLO, outlines)', async () => {
    const b = await bed();
    const [drums, bass] = b.heads();
    byRole(drums, 'button', COPY.mute('Drums'))[0].click();
    await settle();
    expect(b.snap.mix.tracks[0]).toMatchObject({name: 'drums', muted: true});
    expect(drums.dataset.state).toBe('out');
    expect(drums.querySelector('.stems-word').textContent).toBe('OUT');
    expect(byRole(drums, 'button', COPY.mute('Drums'))[0].getAttribute('aria-pressed')).toBe('true');
    byRole(bass, 'button', COPY.solo('Bass'))[0].click();
    await settle();
    expect(bass.dataset.state).toBe('solo');
    expect(bass.querySelector('.stems-word').textContent).toBe('SOLO');
    expect(b.heads()[2].dataset.state).toBe('dim');
    expect(b.heads()[2].querySelector('.stems-word').textContent).toBe('');
    b.ts.session.transport.fullMix();
    await settle();
    expect(b.heads().map((h) => h.dataset.state)).toEqual(['on', 'on', 'on', 'on']);
  });

  test('the laptop fader sets the stem level', async () => {
    const b = await bed();
    const slider = byRole(b.heads()[1], 'slider', COPY.level('Bass'))[0];
    slider.focus();
    slider.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Home', code: 'Home', bubbles: true, cancelable: true}));
    await settle();
    expect(b.snap.mix.tracks[1]).toMatchObject({name: 'bass', volume: 0});
  });

  test('the ruler numbers bars when mapped and shows times when not; no "Bar" anywhere on an unmapped song', async () => {
    const b = await bed();
    expect(b.root.dataset.ruler).toBe('bars');
    const labels = [...b.root.querySelectorAll('.stems-mark')].map((m) => m.textContent);
    // 64 bars of 12.5 px at Fit: every 4th bar is numbered (≥ 40 px apart).
    expect(labels.slice(0, 4)).toEqual(['1', '5', '9', '13']);

    const u = await bed({mapped: false});
    expect(u.root.dataset.ruler).toBe('time');
    const times = [...u.root.querySelectorAll('.stems-mark')].map((m) => m.textContent);
    expect(times[0]).toBe('0:00');
    expect(u.root.querySelector('.stems-grid-button')).toBeNull();
    for (const s of strings(u.root)) {
      expect(s).not.toMatch(/Bar/);
      expect(s).not.toMatch(/bar /);
    }
    expect(u.reg.state(COMMAND_IDS.grid).enabled).toBe(false);
  });
});

describe('drawing', () => {
  test('one row per stem on the canvas; a muted stem is drawn with the hatch, never opacity', async () => {
    const b = await bed();
    frame();
    expect(b.canvas.dataset.peaksReady).toBe('true');
    const ctx = contextOf(b.canvas);
    ctx.reset();
    b.ts.session.transport.setMuted('drums', true);
    await settle();
    frame();
    expect(ctx.callsOf('createPattern').length).toBeGreaterThan(0);
    const alphas = ctx.setsOf('globalAlpha');
    // Envelopes paint at alpha 1 (muted included); only grid lines are translucent.
    expect(alphas.every((a) => a === 1 || a === 0.08 || a === 0.18)).toBe(true);
  });

  test('grid lines: bars at 18% and beats at 8%, each only when ≥ 6 px apart', async () => {
    const b = await bed({prefs: fakePrefs({grid: 'beat'})});
    frame();
    // Fit: bars 12.5 px apart, beats 3.1 px: only bars.
    expect(b.canvas.dataset.gridDrawn).toBe('bar');
    b.surface.zoom(1); b.surface.zoom(1); b.surface.zoom(1);   // 16 s: beats 25 px
    frame();
    expect(b.canvas.dataset.gridDrawn.split(' ').sort()).toEqual(['bar', 'beat']);
    const ctx = contextOf(b.canvas);
    expect(ctx.setsOf('globalAlpha')).toEqual(expect.arrayContaining([0.08, 0.18]));
    expect(GRID_MIN_PX).toBe(6);
  });

  test('Grid ▾ chooses the division; Off draws no grid', async () => {
    const b = await bed();
    b.root.querySelector('.stems-grid-button').click();
    const off = [...document.querySelectorAll('[role=menuitemradio]')].find((el) => el.textContent.includes('Off'));
    expect(off).toBeTruthy();
    off.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
    await settle();
    frame();
    expect(b.prefs.get('stems.grid')).toBe('off');
    expect(b.canvas.dataset.gridDrawn).toBeUndefined();
    expect(nameOf(b.root.querySelector('.stems-grid-button'))).toBe(COPY.gridButton('Off'));
  });
});

describe('the pointer model', () => {
  test('a mouse click activates a tap at the nearest beat (Snap on, spec §4.9), even while playing', async () => {
    const b = await bed();
    mouseClick(b.lanes, b.xOf(64.6));
    expect(b.activations.at(-1)).toMatchObject({kind: 'tap', pointerType: 'mouse', t: 64.5, beatTime: 64.5, bar: 33});
    // A finer grid (¼ of a beat) is the tap's division; Bar or Off grids still cue to beats.
    b.prefs.set('stems.grid', 'quarter');
    mouseClick(b.lanes, b.xOf(64.6));
    expect(b.activations.at(-1).t).toBeCloseTo(64.625, 6);
    b.prefs.set('stems.grid', 'off');
    mouseClick(b.lanes, b.xOf(65.3));
    expect(b.activations.at(-1).t).toBe(65.5);
    b.prefs.set('stems.grid', 'bar');
    b.prefs.set('stems.snap', false);
    mouseClick(b.lanes, b.xOf(64.64));
    expect(b.activations.at(-1).t).toBeCloseTo(64.64, 1);
    await b.ts.play();
    b.surface.setGlass(true);
    mouseClick(b.lanes, b.xOf(80));
    expect(b.activations.at(-1)).toMatchObject({kind: 'tap', pointerType: 'mouse'});
  });

  test('a mouse drag past 8 px makes a loop snapped out to bar lines (preview, then commit)', async () => {
    const b = await bed();
    mouseDrag(b.lanes, b.xOf(17), b.xOf(47));
    const phases = b.edits.map((e) => e.phase);
    expect(phases).toContain('preview');
    expect(b.edits.at(-1)).toMatchObject({phase: 'commit', a: 16, b: 48, aBar: 9, bBar: 24});
    expect(b.activations).toHaveLength(0);
  });

  test('touch, stopped: tap cues; a 350 ms long-press then drag loops; a long-press released opens the menu', async () => {
    const b = await bed();
    pointer(b.lanes, 'pointerdown', {x: b.xOf(40), y: TOP + 50, pointerType: 'touch', pointerId: 3});
    pointer(b.lanes, 'pointerup', {x: b.xOf(40), y: TOP + 50, pointerType: 'touch', pointerId: 3});
    expect(b.activations.at(-1)).toMatchObject({kind: 'tap', pointerType: 'touch', t: 40});

    pointer(b.lanes, 'pointerdown', {x: b.xOf(33), y: TOP + 50, pointerType: 'touch', pointerId: 4});
    vi.advanceTimersByTime(360);
    for (let i = 1; i <= 5; i++) pointer(b.lanes, 'pointermove', {x: b.xOf(33 + i * 3), y: TOP + 50, pointerType: 'touch', pointerId: 4});
    pointer(b.lanes, 'pointerup', {x: b.xOf(48), y: TOP + 50, pointerType: 'touch', pointerId: 4});
    expect(b.edits.at(-1)).toMatchObject({phase: 'commit', a: 32, b: 48});

    const before = b.activations.length;
    pointer(b.lanes, 'pointerdown', {x: b.xOf(60), y: TOP + 50, pointerType: 'touch', pointerId: 5});
    vi.advanceTimersByTime(360);
    pointer(b.lanes, 'pointerup', {x: b.xOf(60), y: TOP + 50, pointerType: 'touch', pointerId: 5});
    expect(b.activations.length).toBe(before + 1);
    expect(b.activations.at(-1).kind).toBe('long');
  });

  test('touch while playing never makes a loop (glass); right-click is the bar menu', async () => {
    const b = await bed();
    await b.ts.play();
    b.surface.setGlass(true);
    pointer(b.lanes, 'pointerdown', {x: b.xOf(33), y: TOP + 50, pointerType: 'touch', pointerId: 6});
    vi.advanceTimersByTime(360);
    pointer(b.lanes, 'pointermove', {x: b.xOf(45), y: TOP + 50, pointerType: 'touch', pointerId: 6});
    pointer(b.lanes, 'pointerup', {x: b.xOf(45), y: TOP + 50, pointerType: 'touch', pointerId: 6});
    expect(b.edits).toHaveLength(0);
    b.lanes.dispatchEvent(new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: b.xOf(20), clientY: TOP + 50, button: 2, detail: 1}));
    expect(b.activations.at(-1)).toMatchObject({kind: 'context', bar: 11});
  });

  test('the bar menu acts on the bar under the pointer: right-click and long-press late in bar 11 report bar 11', async () => {
    const b = await bed();
    b.lanes.dispatchEvent(new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: b.xOf(21.8), clientY: TOP + 50, button: 2, detail: 1}));
    expect(b.activations.at(-1).kind).toBe('context');
    expect(b.activations.at(-1).bar).toBe(11);
    expect(b.activations.at(-1).t).toBeCloseTo(21.8, 1);
    expect(b.activations.at(-1).t).toBeLessThan(22);
    pointer(b.lanes, 'pointerdown', {x: b.xOf(21.8), y: TOP + 50, pointerType: 'touch', pointerId: 9});
    vi.advanceTimersByTime(360);
    pointer(b.lanes, 'pointerup', {x: b.xOf(21.8), y: TOP + 50, pointerType: 'touch', pointerId: 9});
    expect(b.activations.at(-1).kind).toBe('long');
    expect(b.activations.at(-1).bar).toBe(11);
    expect(b.activations.at(-1).t).toBeLessThan(22);
  });

  test('loop handles drag an edge (resize) and the band (move) with the mouse', async () => {
    const b = await bed();
    b.surface.setLoop({a: 32, b: 48});
    const handle = b.lanes.querySelector('.loop-handle[data-edge=b]');
    expect(handle).toBeTruthy();
    pointer(handle, 'pointerdown', {x: b.xOf(48), y: TOP + 20, pointerType: 'mouse'});
    pointer(handle, 'pointermove', {x: b.xOf(52), y: TOP + 20, pointerType: 'mouse'});
    pointer(handle, 'pointermove', {x: b.xOf(55.8), y: TOP + 20, pointerType: 'mouse'});
    pointer(handle, 'pointerup', {x: b.xOf(55.8), y: TOP + 20, pointerType: 'mouse'});
    expect(b.edits.at(-1)).toMatchObject({phase: 'commit', a: 32, b: 56});
    b.surface.setLoop({a: 32, b: 56});
    // Inside the band: a mouse drag moves the whole loop by bars.
    const band = b.lanes.querySelector('.loop-band');
    pointer(band, 'pointerdown', {x: b.xOf(40), y: TOP + 20, pointerType: 'mouse'});
    pointer(band, 'pointermove', {x: b.xOf(44), y: TOP + 20, pointerType: 'mouse'});
    pointer(band, 'pointermove', {x: b.xOf(48.2), y: TOP + 20, pointerType: 'mouse'});
    pointer(band, 'pointerup', {x: b.xOf(48.2), y: TOP + 20, pointerType: 'mouse'});
    expect(b.edits.at(-1)).toMatchObject({phase: 'commit', a: 40, b: 64});
    expect(b.activations).toHaveLength(0);
  });

  test('two fingers: a pinch zooms about the fingers and a pan moves the window; while playing it pauses Follow', async () => {
    const b = await bed();
    b.surface.reveal(40);
    b.surface.zoom(1);   // 64 s
    await b.ts.play();
    b.surface.frame({position: b.ts.session.transport.position(), playing: true});
    const span = b.surface.view.span;
    const y = TOP + 50;
    pointer(b.lanes, 'pointerdown', {x: 400, y, pointerType: 'touch', pointerId: 11});
    pointer(b.lanes, 'pointerdown', {x: 500, y, pointerType: 'touch', pointerId: 12, isPrimary: false});
    pointer(b.lanes, 'pointermove', {x: 600, y, pointerType: 'touch', pointerId: 12, isPrimary: false});
    pointer(b.lanes, 'pointerup', {x: 600, y, pointerType: 'touch', pointerId: 12, isPrimary: false});
    pointer(b.lanes, 'pointerup', {x: 400, y, pointerType: 'touch', pointerId: 11});
    expect(b.surface.view.span).toBeCloseTo(span / 2, 6);
    expect(b.follows).toEqual([false]);
    expect(b.surface.following).toBe(false);
    vi.advanceTimersByTime(ZOOM_SAVE_MS + 10);
    expect(b.prefs.get('stems.zoom')).toBeCloseTo(span / 2, 2);
  });
});

describe('the wheel (as 1.9)', () => {
  test('vertical zooms at the cursor; Shift and horizontal pan; ⌘/Ctrl zooms', async () => {
    const b = await bed();
    b.surface.zoom(1);   // 64 s from 0
    const at = b.xOf(20);
    const event = wheel(b.lanes, {deltaY: -200, clientX: at});
    expect(event.defaultPrevented).toBe(true);
    expect(b.surface.view.span).toBeLessThan(64);
    expect(b.xOf(20)).toBeCloseTo(at, 3);

    vi.advanceTimersByTime(300);   // a new wheel gesture
    const t0 = b.surface.view.t0, span = b.surface.view.span;
    wheel(b.lanes, {deltaY: 80, shiftKey: true, clientX: at});
    expect(b.surface.view.span).toBeCloseTo(span, 9);
    expect(b.surface.view.t0).toBeCloseTo(t0 + (80 / WIDTH) * span, 6);

    vi.advanceTimersByTime(300);
    wheel(b.lanes, {deltaX: -40, clientX: at});
    expect(b.surface.view.t0).toBeLessThan(t0 + (80 / WIDTH) * span);

    vi.advanceTimersByTime(300);
    const before = b.surface.view.span;
    wheel(b.lanes, {deltaY: -50, ctrlKey: true, clientX: at});
    expect(b.surface.view.span).toBeLessThan(before);
  });

  test('wheel use while playing pauses Follow (the Stage shows Back to playhead); stopped it does not', async () => {
    const b = await bed();
    wheel(b.lanes, {deltaY: -100, clientX: b.xOf(10)});
    expect(b.follows).toEqual([]);
    await b.ts.play();
    b.surface.frame({position: 0, playing: true});
    vi.advanceTimersByTime(300);
    wheel(b.lanes, {deltaY: -100, clientX: b.xOf(10)});
    expect(b.follows).toEqual([false]);
    expect(b.surface.following).toBe(false);
    // The Follow pill (CONTROLS 'paused'): Back to playhead resumes Follow and pages to the playhead.
    const [pill] = byRole(b.root, 'button', COPY.backToPlayhead);
    expect(pill).toBeTruthy();
    pill.click();
    expect(b.surface.following).toBe(true);
    expect(b.follows).toEqual([false, true]);
    expect(byRole(b.root, 'button', COPY.backToPlayhead)).toHaveLength(0);
    wheel(b.lanes, {deltaY: -100, clientX: b.xOf(10)});
    b.surface.setFollow(true);   // the Stage's view.followResume
    expect(b.surface.following).toBe(true);
    expect(byRole(b.root, 'button', COPY.backToPlayhead)).toHaveLength(0);
  });
});

describe('Follow, the viewport and the zoom pref', () => {
  test('while playing, Follow pages the playhead back to the follow line; off, the window stays', async () => {
    const b = await bed({prefs: fakePrefs({zoom: 16})});
    expect(b.surface.view).toMatchObject({t0: 0, span: 16});
    await b.ts.play();
    b.surface.frame({position: 15, playing: true});
    expect(b.surface.view.t0).toBeCloseTo(15 - 16 * FOLLOW_LINE, 9);
    b.prefs.set('stems.follow', false);
    const t0 = b.surface.view.t0;
    b.surface.frame({position: 40, playing: true});
    expect(b.surface.view.t0).toBe(t0);
    const playhead = b.root.querySelector('.stems-playhead');
    expect(playhead.hidden).toBe(true);   // off screen
  });

  test('a new Play resumes a paused Follow', async () => {
    const b = await bed({prefs: fakePrefs({zoom: 16})});
    await b.ts.play();
    b.surface.frame({position: 1, playing: true});
    wheel(b.lanes, {deltaX: 300, clientX: b.xOf(5)});
    expect(b.surface.following).toBe(false);
    b.ts.session.transport.stop();
    await settle();
    b.surface.frame({position: 0, playing: false});
    await b.ts.play();
    expect(b.surface.following).toBe(true);
    expect(b.follows).toEqual([false, true]);
  });

  test('Play after Pause resumes a paused Follow', async () => {
    const b = await bed({prefs: fakePrefs({zoom: 16})});
    await b.ts.play();
    b.surface.frame({position: 1, playing: true});
    wheel(b.lanes, {deltaX: 300, clientX: b.xOf(5)});
    expect(b.surface.following).toBe(false);
    b.ts.session.transport.pause();
    await settle();
    b.surface.frame({position: 1, playing: false});
    await b.ts.play();
    await settle();
    expect(b.surface.following).toBe(true);
  });

  test('Again while playing resumes a paused Follow (the transport gesture)', async () => {
    const b = await bed({prefs: fakePrefs({zoom: 16})});
    await b.ts.play();
    b.surface.frame({position: 1, playing: true});
    wheel(b.lanes, {deltaX: 300, clientX: b.xOf(5)});
    expect(b.surface.following).toBe(false);
    await b.ts.session.transport.again();
    await settle();
    expect(b.surface.following).toBe(true);
    expect(b.follows).toEqual([false, true]);
  });

  test('a paused Follow resumes after 8 s without navigation; each navigation restarts the wait', async () => {
    const b = await bed({prefs: fakePrefs({zoom: 16})});
    await b.ts.play();
    b.surface.frame({position: 1, playing: true});
    wheel(b.lanes, {deltaX: 300, clientX: b.xOf(5)});
    expect(b.surface.following).toBe(false);
    vi.advanceTimersByTime(FOLLOW_IDLE_MS - 1000);
    wheel(b.lanes, {deltaX: 300, clientX: b.xOf(5)});
    vi.advanceTimersByTime(FOLLOW_IDLE_MS - 1000);
    expect(b.surface.following).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(b.surface.following).toBe(true);
    expect(b.follows).toEqual([false, true]);
    expect(b.root.querySelector('[data-follow-pill]').hidden).toBe(true);
  });

  test('the pill shows only while playing: Pause hides it, Stop clears the paused Follow', async () => {
    const b = await bed({prefs: fakePrefs({zoom: 16})});
    await b.ts.play();
    b.surface.frame({position: 1, playing: true});
    wheel(b.lanes, {deltaX: 300, clientX: b.xOf(5)});
    const pill = b.root.querySelector('[data-follow-pill]');
    expect(pill.hidden).toBe(false);
    b.ts.session.transport.pause();
    await settle();
    b.surface.setGlass(false);
    b.surface.frame({position: 1, playing: false});
    expect(pill.hidden).toBe(true);
    b.ts.session.transport.stop();
    await settle();
    expect(b.surface.following).toBe(true);
    expect(b.follows).toEqual([false, true]);
    expect(pill.hidden).toBe(true);
  });

  test('navigation that does not move the window (zoom out at Fit, pan at an end) leaves Follow on', async () => {
    const b = await bed();
    await b.ts.play();
    b.surface.frame({position: 0, playing: true});
    wheel(b.lanes, {deltaY: 100, clientX: b.xOf(10)});
    expect(b.surface.view).toMatchObject({t0: 0, t1: DURATION});
    expect(b.surface.following).toBe(true);
    wheel(b.lanes, {deltaY: -400, clientX: b.xOf(0)});   // zoom in at the start: moves, pauses
    expect(b.surface.following).toBe(false);
    b.surface.setFollow(true);
    expect(b.surface.view.t0).toBe(0);
    wheel(b.lanes, {deltaX: -300, clientX: b.xOf(5)});   // pan left at the start: nothing moves
    expect(b.surface.following).toBe(true);
  });

  test('in the Stage the pill runs view.followResume', async () => {
    const runs = [];
    const b = await bed({beforeMount: (reg) => reg.register({id: 'view.followResume', title: 'Back to playhead', group: 'View',
      scopes: ['stage'], run: () => runs.push('resume')})});
    await b.ts.play();
    b.surface.frame({position: 0, playing: true});
    wheel(b.lanes, {deltaY: -100, clientX: b.xOf(10)});
    expect(b.surface.following).toBe(false);
    const pill = b.root.querySelector('[data-follow-pill]');
    expect(pill.hidden).toBe(false);
    pill.click();
    expect(runs).toEqual(['resume']);
  });

  test('viewport: the visible window for the strip bracket; dragging the bracket moves the window', async () => {
    const b = await bed();
    expect(b.surface.viewport.value).toEqual({t0: 0, t1: DURATION});
    b.surface.zoom(1);
    expect(b.surface.viewport.value).toEqual({t0: 0, t1: 64});
    b.surface.viewport.value = {t0: 32, t1: 96};
    expect(b.surface.view).toMatchObject({t0: 32, span: 64});
    b.surface.viewport.value = {t0: 100, t1: 164};   // past the end: clamped as a whole
    expect(b.surface.view).toMatchObject({t0: 64, span: 64});
    expect(b.surface.viewport.peek()).toEqual({t0: 64, t1: 128});
  });

  test('prefs.stems.zoom: restored on open around the cue, saved after zooming, Fit stores null', async () => {
    const prefs = fakePrefs({zoom: 8});
    const b = await bed({prefs, practice: practiceOf({cue: 40})});
    expect(b.surface.view.span).toBe(8);
    expect(b.surface.view.t0).toBeCloseTo(40 - 8 * FOLLOW_LINE, 9);
    b.surface.zoom(-1);
    vi.advanceTimersByTime(ZOOM_SAVE_MS + 10);
    expect(prefs.get('stems.zoom')).toBe(16);
    b.reg.run(COMMAND_IDS.fit);
    vi.advanceTimersByTime(ZOOM_SAVE_MS + 10);
    expect(prefs.get('stems.zoom')).toBeNull();
    expect(b.surface.view).toMatchObject({t0: 0, span: DURATION});
  });

  test('anchor(): the playhead when on screen, with its bar index', async () => {
    const b = await bed({practice: practiceOf({cue: 41})});
    expect(b.surface.anchor()).toEqual({time: 41, bar: 20});
    const u = await bed({mapped: false, practice: practiceOf({cue: 12})});
    expect(u.surface.anchor()).toEqual({time: 12});
  });
});

describe('the §3.3 commands and the stage.stems scope', () => {
  test('defs: ids, keys, scope and groups as §3.3', () => {
    const defs = stemsCommandDefs();
    expect(defs.map((d) => [d.id, d.title, d.keys, d.scopes])).toEqual([
      ['stems.zoomIn', 'Zoom in', ['='], [SCOPE]], ['stems.zoomOut', 'Zoom out', ['-'], [SCOPE]],
      ['stems.fit', 'Fit', ['\\'], [SCOPE]], ['stems.zoomLoop', 'Zoom to loop', ['KeyZ'], [SCOPE]],
      ['stems.grid', 'Grid on/off', ['KeyG'], [SCOPE]], ['stems.snap', 'Snap', ['Shift+KeyS'], [SCOPE]],
      ['stems.follow', 'Follow', ['KeyF'], [SCOPE]],
    ]);
    expect(defs.every((d) => d.group === 'View')).toBe(true);
    const reg = createRegistry();
    const off = defineStemsCommands({registry: reg});
    expect(reg.state('stems.fit').enabled).toBe(false);   // no surface on screen
    off();
    expect(reg.get('stems.fit')).toBeNull();
  });

  test('registered and scoped while mounted; released on destroy', async () => {
    const b = await bed();
    expect(b.scopes).toEqual([SCOPE]);
    expect(b.reg.get(COMMAND_IDS.follow)).not.toBeNull();
    expect(b.reg.state(COMMAND_IDS.fit).enabled).toBe(true);
    b.surface.destroy();
    expect(b.scopes).toEqual([SCOPE, null]);
    expect(b.reg.get(COMMAND_IDS.follow)).toBeNull();
  });

  test('the Stage surface signal: the scope drops as soon as another surface is shown', async () => {
    const surface = signal('chart');
    const b = await bed({stage: {surface, layout: signal('rail')}});
    expect(b.scopes).toEqual([]);
    surface.value = 'stems';
    expect(b.scopes).toEqual([SCOPE]);
    surface.value = 'roadmap';
    expect(b.scopes).toEqual([SCOPE, null]);
    expect(b.reg.state(COMMAND_IDS.fit).enabled).toBe(false);
  });

  test('keys through the dispatcher: = - \\ Z G ⇧S F, with F shadowing the Stage\'s Focus', async () => {
    const b = await bed({dispatcher: true});
    const focused = [];
    b.reg.register({id: 'view.focus', title: 'Focus', group: 'View', keys: ['KeyF'], scopes: ['stage'], run: () => focused.push(1)});
    expect(activeScopeChain()).toContain(SCOPE);
    keydown('Equal');
    expect(b.surface.view.span).toBe(64);
    keydown('Minus');
    expect(b.surface.view.span).toBe(DURATION);
    keydown('Equal'); keydown('Equal');
    keydown('Backslash');
    expect(b.surface.view.span).toBe(DURATION);
    b.surface.setLoop({a: 32, b: 48});
    keydown('KeyZ');
    expect(b.surface.view).toMatchObject({t0: 31.2});
    keydown('KeyG');
    expect(b.prefs.get('stems.grid')).toBe('off');
    keydown('KeyG');
    expect(b.prefs.get('stems.grid')).toBe('bar');
    keydown('Shift+KeyS');
    expect(b.prefs.get('stems.snap')).toBe(false);
    keydown('KeyF');
    expect(b.prefs.get('stems.follow')).toBe(false);
    expect(focused).toEqual([]);
    vi.advanceTimersByTime(60);
    const follow = byRole(b.root, 'button', COPY.follow)[0];
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    expect(byRole(b.root, 'button', COPY.snap)[0].getAttribute('aria-pressed')).toBe('false');
  });

  test('F with Follow paused resumes it instead of turning it off', async () => {
    const b = await bed();
    await b.ts.play();
    b.surface.frame({position: 0, playing: true});
    wheel(b.lanes, {deltaY: -100, clientX: b.xOf(10)});
    expect(b.surface.following).toBe(false);
    b.reg.run(COMMAND_IDS.follow);
    expect(b.surface.following).toBe(true);
    expect(b.prefs.get('stems.follow')).toBe(true);
    expect(b.follows).toEqual([false, true]);
  });

  test('Zoom to loop is disabled without a loop', async () => {
    const b = await bed();
    expect(b.reg.state(COMMAND_IDS.zoomLoop).enabled).toBe(false);
    b.surface.setLoop({a: 8, b: 16});
    expect(b.reg.state(COMMAND_IDS.zoomLoop).enabled).toBe(true);
  });
});
