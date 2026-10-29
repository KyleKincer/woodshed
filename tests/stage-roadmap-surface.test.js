// @vitest-environment happy-dom
// The Road map and the Wave page (src/stage/surfaces/roadmap-surface.js; architecture §2.14.12,
// spec §4.4B/C) on a real song session (tests/helpers/test-session.js: SongMapStore, Metronome and
// MultitrackEngine over tests/helpers/fake-audio.js, transport, position, practice state). Gestures
// go through the real press recogniser (pointer events), the stage.bars commands through a real
// registry. Rendered geometry, colours and the shimmer are Playwright states (tests/fixture/states/ST10.cjs).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));
// The envelope drawing is recorded (it still runs, onto the recording canvas context).
vi.mock('../src/stage/wave-render.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {...mod, drawEnvelopeStack: vi.fn(mod.drawEnvelopeStack)};
});

import {createRegistry} from '../src/app/commands.js';
import {startDispatcher} from '../src/app/dispatch.js';
import {clock as appClock} from '../src/app/clock.js';
import {signal} from '../src/app/store.js';
import {defineTransportCommands} from '../src/stage/transport-commands.js';
import {drawEnvelopeStack, SECONDARY_ALPHA} from '../src/stage/wave-render.js';
import {readFrame} from '../src/stage/frame.js';
import {COPY, CONTROLS, FOLLOW_IDLE_MS, OVERSCAN, SCROLL_GUARD_MS, createRoadmapSurface, stemsOf} from '../src/stage/surfaces/roadmap-surface.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {contextOf, flushFrames, installCanvasShim, installFrameShim, installResizeObserverShim, keydown, pointer, restoreDomShims, triggerResize} from './helpers/dom.js';
import {pickup, sectioned, tempoOf} from './fixtures/maps.js';

let clock, restoreAudio, current = [];

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(Date.parse('2026-10-28T12:00:00Z'));
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
  installCanvasShim();
  installResizeObserverShim();
  installFrameShim();   // requestAnimationFrame runs only through flushFrames()
  drawEnvelopeStack.mockClear();
});

afterEach(async () => {
  for (const off of current.splice(0).reverse()) await off();
  document.body.replaceChildren();
  restoreDomShims();
  restoreAudio();
  vi.useRealTimers();
});

/** A v2 practice blob. */
function practiceOf(fields = {}) {
  return {v: 2, cue: 0, rate: 1, tracks: [], minusMe: false, trainer: null, spots: [], markers: [], ...fields,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none', ...(fields.loop ?? {})}};
}

const frac = (n, d = 1) => ({n, d});

/** 32 bars at 120 qpm, then 100 qpm (a tempo change at bar 33); the Bridge (bars 41–48) in 7/8 2+2+3. */
function meterTempo() {
  const tempo = tempoOf(sectioned);
  const m = tempo.songMap;
  m.pins = [{position: frac(0), time: 0}, {position: frac(128), time: 64}];
  m.tailQpm = 100;
  for (let i = 40; i < 48; i++) Object.assign(m.measures[i], {numerator: 7, denominator: 8, length: frac(7, 2), grouping: [2, 2, 3]});
  return tempo;
}

/** A device-prefs stand-in (get/set by path), so no test leaks a row length into the next. */
function memPrefs(initial = {}) {
  const values = {...initial};
  return {values, get: (k) => values[k] ?? null, set: (k, v) => { values[k] = v; }};
}

/**
 * A session, a registry with the transport commands and a mounted surface sized to `width` ×
 * `height` (the scroller). The scroller's scrollTop and scrollTo are recorded (happy-dom has no layout).
 */
async function bed({width = 1176, height = 800, layout = 'rail', distance = 'stand', followStyle, prefs = memPrefs(), ...options} = {}) {
  const ts = await createTestSession({clock, ...options});
  const reg = createRegistry();
  const offTransport = defineTransportCommands({registry: reg});
  reg.provide('session', () => ts.session);
  reg.provide('transport', () => ts.session.transport);
  const host = document.createElement('div');
  document.body.append(host);
  const log = {activate: [], edits: [], follow: [], scrolls: []};
  const stage = {layout: signal(layout), distance: signal(distance), followStyle: signal(followStyle ?? (layout === 'rail' ? 'scroll' : 'page'))};
  const surface = createRoadmapSurface(host, {
    session: ts.session, stage, layout, distance, registry: reg, prefs,
    onActivate: (e) => log.activate.push(e),
    onLoopEdit: (e) => log.edits.push(e),
    onFollowChange: (on) => log.follow.push(on),
  });
  const el = surface.el.querySelector('.roadmap');   // the scroller ([data-scroller])
  let top = 0;
  Object.defineProperty(el, 'scrollTop', {configurable: true, get: () => top, set: (v) => { top = Math.max(0, v); }});
  el.scrollTo = ({top: t, behavior}) => { log.scrolls.push({top: t, behavior}); top = Math.max(0, t); el.dispatchEvent(new window.Event('scroll')); };
  triggerResize(el, {x: 0, y: 0, width, height});
  current.push(async () => { surface.destroy(); offTransport(); await ts.dispose(); });
  const b = {
    ts, reg, surface, el, host, log, stage, prefs,
    get top() { return top; },
    /** A manual scroll (no programmatic guard). */
    userScroll(t) { top = t; el.dispatchEvent(new window.Event('scroll')); flushFrames(1); },
    rows: () => [...el.querySelectorAll('.roadmap-row')],
    cells: () => [...el.querySelectorAll('[role=gridcell]')],
    cell: (bar) => el.querySelector(`.roadmap-cell[data-bar="${bar}"]`),
    frame: (position, {playing = false, counting = false} = {}) => {
      const map = ts.session.map;
      surface.frame({now: 0, position, playing, counting, bar: map.isReal ? map.barBeatAt(position) : null});
    },
  };
  return b;
}

/** Every visible string and every accessible attribute under root. */
function strings(root) {
  const out = [root.textContent];
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const name of ['aria-label', 'aria-valuetext', 'title', 'aria-description', 'aria-roledescription']) {
      const v = el.getAttribute(name);
      if (v) out.push(v);
    }
  }
  return out;
}

const translateX = (el) => Number(/translateX\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? NaN);
const num = (v) => parseFloat(v);

function mouseDrag(target, from, to, {altKey = false} = {}) {
  pointer(target, 'pointerdown', {x: from.x, y: from.y, pointerType: 'mouse', altKey});
  for (let i = 1; i <= 6; i++) pointer(target, 'pointermove', {x: from.x + (to.x - from.x) * i / 6, y: from.y + (to.y - from.y) * i / 6, pointerType: 'mouse', altKey});
  pointer(target, 'pointerup', {x: to.x, y: to.y, pointerType: 'mouse', altKey});
}

/** The content-box centre of bar `i`'s cell (the content sits at 0,0 in happy-dom). */
function cellCentre(b, i) {
  const row = b.surface.model.rows.find((r) => r.first <= i && i <= r.last);
  const cell = row.cells.find((c) => c.bar === i);
  return {x: cell.x + cell.w / 2, y: row.band.y + row.band.h / 2};
}

// ---------------------------------------------------------------------------------------------------------------

describe('copy and controls (§9.0 table)', () => {
  test.each(CONTROLS.map((row) => [row.role, row.name, row]))('%s "%s" renders with that role and name', async (role, name, row) => {
    const b = await bed(row.context === 'unmapped' ? {mapped: false} : {});
    if (row.context === 'followPaused') {
      vi.advanceTimersByTime(SCROLL_GUARD_MS + 10);
      b.userScroll(400);
      const buttons = [...b.surface.el.querySelectorAll('button')].filter((n) => n.textContent.includes(name) && !n.closest('[hidden]'));
      expect(buttons).toHaveLength(1);
      buttons[0].click();
      expect(b.surface.following).toBe(true);
      expect(buttons[0].closest('[hidden]')).not.toBeNull();
      return;
    }
    const named = [...b.el.querySelectorAll(`[role=${role}]`)].filter((n) => n.getAttribute('aria-label') === name);
    expect(named, `${role} named ${name}`).toHaveLength(1);
  });

  test('copy reads as the spec writes it', () => {
    expect(COPY.barsRange(13, 20)).toBe('bars 13–20');
    expect(COPY.barsRange(13, 13)).toBe('bar 13');
    expect(COPY.barsRange(null, 4)).toBe('pickup–bar 4');
    expect(COPY.meter(7, 8, '2+2+3')).toBe('7/8 (2+2+3)');
    expect(COPY.meter(3, 4, '')).toBe('3/4');
    expect(COPY.tempo('♩', 96)).toBe('♩=96');
    expect(COPY.spotFlag('Bridge walk-up')).toBe('◆ Bridge walk-up');
    expect(COPY.cell([COPY.bar(13), 'Chorus', null, '96 bpm'])).toBe('Bar 13, Chorus, 96 bpm');
    expect(COPY.span('0:40', '0:50')).toBe('0:40 to 0:50');
  });
});

describe('Road map (mapped)', () => {
  test('a role=grid of bars in the stage.bars scope; 8 bars per row on the rail, with section headings', async () => {
    const b = await bed();
    expect(b.surface.kind).toBe('roadmap');
    expect(b.el.dataset.kind).toBe('roadmap');
    expect(b.el.hasAttribute('data-scroller')).toBe(true);
    const grid = b.el.querySelector('[role=grid]');
    expect(grid.dataset.scope).toBe('stage.bars');
    expect(grid.getAttribute('aria-label')).toBe('Bars');
    expect(grid.getAttribute('data-consume-keys')).toContain('ArrowDown');
    expect(grid.getAttribute('aria-rowcount')).toBe('8');
    const first = b.rows()[0];
    expect(first.getAttribute('role')).toBe('row');
    expect(first.querySelectorAll('[role=gridcell]')).toHaveLength(8);
    expect(first.querySelector('.roadmap-heading-name').textContent).toBe('Intro');
    expect(first.querySelector('.roadmap-heading-range').textContent).toBe('bars 1–8');
    expect(b.cell(0).getAttribute('aria-label')).toBe('Bar 1, Intro');
    expect(b.cell(1).getAttribute('aria-label')).toBe('Bar 2');
    expect(b.cell(8).getAttribute('aria-label')).toBe('Bar 9, Verse');
    expect(b.cell(0).querySelector('.roadmap-cell-number').textContent).toBe('1');
    // Cells are 88 px tall at Stand.
    expect(num(b.cell(0).style.height)).toBe(88);
    expect(num(b.cell(1).style.width)).toBe(Math.floor((1176 - 32) / 8));
  });

  test('the band shows 4 bars per row; Kit makes the cells 114 px', async () => {
    const b = await bed({width: 820, height: 860, layout: 'band'});
    expect(b.rows()[0].querySelectorAll('[role=gridcell]')).toHaveLength(4);
    expect(b.el.querySelector('[role=grid]').getAttribute('aria-rowcount')).toBe('16');
    b.surface.setDistance('kit');
    expect(num(b.cell(0).style.height)).toBe(114);
    b.surface.setLayout('rail');
    triggerResize(b.el, {x: 0, y: 0, width: 1176, height: 800});
    vi.advanceTimersByTime(20);
    expect(b.rows()[0].querySelectorAll('[role=gridcell]')).toHaveLength(8);
  });

  test('rows are virtualised: the visible ones plus 2 either side, following the scroll', async () => {
    const b = await bed({width: 820, height: 400, layout: 'band'});
    const rows = b.surface.model.rows;
    const shown = () => b.rows().map((r) => Number(r.dataset.row));
    // 400 px shows about three 124/88 px rows; plus the overscan below.
    expect(Math.min(...shown())).toBe(0);
    expect(Math.max(...shown())).toBeLessThanOrEqual(3 + OVERSCAN + 1);
    expect(b.el.querySelectorAll('canvas')).toHaveLength(b.rows().length);   // one canvas per row
    b.userScroll(rows[10].y);
    const now = shown();
    expect(Math.min(...now)).toBe(10 - OVERSCAN);
    expect(now).toContain(10);
    expect(now).not.toContain(0);
    expect(b.rows().length).toBeLessThanOrEqual(4 + 2 * OVERSCAN + 1);
  });

  test('meter and tempo chips on a change: "7/8 (2+2+3)" and "♩=100"', async () => {
    const tempo = meterTempo();
    const b = await bed({tempo, duration: 64 + (32 + 28 + 64) * 0.6, width: 820, layout: 'band'});
    const rows = b.surface.model.rows;
    b.userScroll(rows.find((r) => r.first === 32).y);
    const chips = (i) => [...(b.cell(i)?.querySelectorAll('.roadmap-chip') ?? [])].map((c) => c.textContent);
    expect(chips(32)).toEqual(['♩=100']);
    expect(b.cell(32).getAttribute('aria-label')).toBe('Bar 33, Chorus 2, 100 bpm');
    expect(chips(33)).toEqual([]);
    b.userScroll(rows.find((r) => r.first === 40).y);
    expect(chips(40)[0]).toBe('7/8 (2+2+3)');
    expect(b.cell(40).getAttribute('aria-label')).toContain('7/8 (2+2+3)');
    expect(chips(41)).toEqual([]);
  });

  test('stacked stem envelopes: your instrument on top at full strength, others at 55%, muted as outline + hatch', async () => {
    const b = await bed();
    await b.ts.ready();
    expect(b.ts.session.peaks.ready).toBe(true);
    b.ts.session.transport.minusMe(true);   // the drums (a drummer's profile) go out
    await settle();
    const calls = drawEnvelopeStack.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [ctx, args] = calls[calls.length - 1];
    expect(args.stems).toEqual([
      {name: 'drums', color: 'drums', state: 'out', primary: true},
      {name: 'bass', color: 'bass', state: 'on', primary: false},
      {name: 'vocals', color: 'vocals', state: 'on', primary: false},
      {name: 'other', color: 'other', state: 'on', primary: false},
    ]);
    // One cell's box: inside its 88 px cell, over that bar's time.
    const bar = b.ts.session.map.bars.find((x) => Math.abs(x.t0 - args.t0) < 1e-9);
    expect(bar).toBeTruthy();
    expect(args.t1).toBeCloseTo(bar.t1, 9);
    expect(args.h).toBeLessThan(88);
    // The recorded context: the muted stem is hatched (a pattern), the secondary stems at 55%.
    expect(contextOf(ctx.canvas)).toBeTruthy();
    const recs = [...b.el.querySelectorAll('canvas')].map((c) => contextOf(c)).filter(Boolean);
    const patterns = recs.flatMap((r) => r.setsOf('fillStyle')).filter((v) => v && typeof v === 'object');
    expect(patterns.length).toBeGreaterThan(0);
    expect(recs.flatMap((r) => r.setsOf('globalAlpha'))).toContain(SECONDARY_ALPHA);
    // Per cell the drums are painted last (on top): their outline stroke follows the others' fills.
    const rec = contextOf(ctx.canvas);
    const order = rec.calls.filter((c) => (c.name === 'fill' || c.name === 'stroke') && 'args' in c).map((c) => c.name);
    expect(order.slice(-4)).toEqual(['fill', 'fill', 'fill', 'stroke']);
  });

  test('stemsOf: solo dims the others; a muted primary stays primary (the hole you fill)', () => {
    expect(stemsOf({tracks: [{name: 'drums', muted: false, soloed: false}, {name: 'bass', muted: false, soloed: true}, {name: 'no_vocals', muted: true, soloed: false}], mine: ['drums']}))
      .toEqual([
        {name: 'drums', color: 'drums', state: 'dim', primary: true},
        {name: 'bass', color: 'bass', state: 'solo', primary: false},
        {name: 'no_vocals', color: 'other', state: 'out', primary: false},
      ]);
    expect(stemsOf(null)).toEqual([]);
  });

  test('before the peaks exist the cells shimmer; the canvases mark data-peaks-ready once drawn from them', async () => {
    const b = await bed({load: false});
    expect(b.el.hasAttribute('data-shimmer')).toBe(true);
    expect(b.el.hasAttribute('data-peaks-ready')).toBe(false);
    expect(b.el.querySelector('canvas').hasAttribute('data-peaks-ready')).toBe(false);
    // The bar grid (numbers and beat ticks) is there already.
    expect(b.cells().length).toBeGreaterThan(0);
    await b.ts.ready();
    await settle();
    expect(b.el.dataset.peaksReady).toBe('true');
    expect(b.el.hasAttribute('data-shimmer')).toBe(false);
    for (const canvas of b.el.querySelectorAll('canvas')) expect(canvas.dataset.peaksReady).toBe('true');
  });

  test('beat ticks are drawn grouping-aware along the bottom of each cell', async () => {
    const tempo = meterTempo();
    const b = await bed({tempo, duration: 64 + (32 + 28 + 64) * 0.6, width: 820, layout: 'band'});
    const rows = b.surface.model.rows;
    b.userScroll(rows.find((r) => r.first === 40).y);
    const canvas = b.cell(40).parentElement.querySelector('canvas');
    const rects = contextOf(canvas).callsOf('fillRect');
    // Four 7/8 bars × 7 units: 28 ticks, of which 12 counted (2 px wide).
    expect(rects.length).toBe(28);
    expect(rects.filter((r) => r[2] === 2)).toHaveLength(12);
  });

  test('the current bar: --now outline over its cell, data-now on the cell, a sweeping playhead and its beat lit', async () => {
    const b = await bed();
    b.frame(33.25, {playing: true});   // bar 17 (Chorus), beat 3 of 4… at 120 bpm: 1.25 s into the bar = beat 3 (0.25 in)
    const now = b.el.querySelector('.roadmap-now');
    expect(now.hidden).toBe(false);
    const centre = cellCentre(b, 16);
    const cell = b.cell(16);
    expect(num(now.style.left)).toBeCloseTo(num(cell.style.left), 6);
    expect(num(now.style.width)).toBeCloseTo(num(cell.style.width), 6);
    expect(cell.hasAttribute('data-now')).toBe(true);
    expect(b.cell(15).hasAttribute('data-now')).toBe(false);
    const playhead = b.el.querySelector('.roadmap-playhead');
    const w = num(cell.style.width);
    expect(translateX(playhead)).toBeCloseTo(num(cell.style.left) + (1.25 / 2) * w, 2);
    const beat = b.el.querySelector('.roadmap-beat');
    expect(beat.hidden).toBe(false);
    expect(translateX(beat)).toBeCloseTo(num(cell.style.left) + 0.5 * w, 2);   // beat 3 starts half way
    void centre;
    b.frame(34.5, {playing: true});   // bar 18
    expect(b.cell(16).hasAttribute('data-now')).toBe(false);
    expect(b.cell(17).hasAttribute('data-now')).toBe(true);
  });

  test('follow: the current row is held 30% down while playing; page style turns half a page past the middle', async () => {
    const b = await bed({width: 820, height: 800, layout: 'band', followStyle: 'scroll'});
    const rows = b.surface.model.rows;
    b.frame(rows[6].t0 + 0.5, {playing: true});
    expect(b.log.scrolls.at(-1)).toMatchObject({top: Math.round(rows[6].y - 0.3 * 800)});
    expect(b.log.follow).toEqual([]);   // programmatic: Follow stays on
    b.stage.followStyle.value = 'page';
    const before = b.log.scrolls.length;
    b.frame(rows[7].t0 + 0.5, {playing: true});   // row 7 is still above the middle
    expect(b.log.scrolls.length).toBe(before);
    const target = rows.find((r) => r.y - b.top > 400);
    b.frame(target.t0 + 0.1, {playing: true});
    expect(b.log.scrolls.at(-1).top).toBe(Math.round(b.top));
    expect(b.log.scrolls.at(-1).top).toBeGreaterThan(rows[6].y - 240 + 399);
  });

  test('a manual scroll pauses Follow; it resumes 8 s later while playing, on Play/Again, or setFollow(true)', async () => {
    const b = await bed({width: 820, height: 800, layout: 'band'});
    b.surface.setGlass(true);
    vi.advanceTimersByTime(SCROLL_GUARD_MS + 10);
    b.userScroll(900);
    expect(b.log.follow).toEqual([false]);
    expect(b.surface.following).toBe(false);
    const rows = b.surface.model.rows;
    b.frame(rows[1].t0, {playing: true});
    expect(b.top).toBe(900);   // no follow scroll while paused
    vi.advanceTimersByTime(FOLLOW_IDLE_MS - 100);
    expect(b.surface.following).toBe(false);
    vi.advanceTimersByTime(200);
    expect(b.log.follow).toEqual([false, true]);
    // Play (or Again) resumes at once: the transport's synchronous 'gesture'.
    vi.advanceTimersByTime(SCROLL_GUARD_MS + 10);
    b.userScroll(1200);
    expect(b.surface.following).toBe(false);
    void b.ts.session.transport.play();
    expect(b.surface.following).toBe(true);
    // setFollow(true) ('⤓ Back to playhead', F) reveals the playhead.
    vi.advanceTimersByTime(SCROLL_GUARD_MS + 10);
    b.userScroll(50);
    b.surface.setFollow(true);
    expect(b.surface.following).toBe(true);
  });

  test('reveal puts a time on the follow line; anchor() names the time and the bar', async () => {
    const b = await bed({width: 820, height: 800, layout: 'band', practice: practiceOf({cue: 81})});
    const rows = b.surface.model.rows;
    b.surface.reveal(81);
    const row = rows.find((r) => r.t0 <= 81 && 81 < r.t1);
    expect(b.top).toBe(Math.round(row.y - 240));
    expect(b.surface.anchor()).toEqual({time: 81, bar: 40});
    expect(b.surface.zoom(1)).toBe(false);   // = / − change the Wave page only
  });

  test('spot flags "◆ name" above their start bar; live markers are ticks', async () => {
    const b = await bed({practice: practiceOf({spots: [{id: 's1', name: 'Bridge walk-up', a: 81, b: 96, rate: 0.9, passes: 0, updatedAt: 1}],
      markers: [{id: 'm1', t: 41, label: 'Flam', updatedAt: 1}]})});
    const rows = b.surface.model.rows;
    expect(rows[5].flag).toBe(true);
    b.userScroll(rows[5].y);
    const flag = b.el.querySelector('.roadmap-flag[data-flag=spot]');
    expect(flag.textContent).toBe('◆ Bridge walk-up');
    expect(num(flag.style.left)).toBeCloseTo(num(b.cell(40).style.left), 6);   // 81 s is bar 41
    expect(b.cell(40).getAttribute('aria-label')).toBe('Bar 41, Bridge, spot Bridge walk-up');
    b.userScroll(rows[2].y);
    const tick = b.el.querySelector('.roadmap-marker');
    expect(tick.dataset.id).toBe('m1');
    // A new spot relayouts the rows (a flag lane appears).
    b.ts.session.practice.addSpot({name: 'Intro fill', a: 4, b: 8, rate: 1});
    await settle();
    expect(b.surface.model.rows[0].flag).toBe(true);
  });

  test('glass: a tap hands the Stage {kind, t, bar, beatTime}; double, long press and right-click too', async () => {
    const b = await bed();
    const at = cellCentre(b, 16);   // bar 17, half way: 33 s
    pointer(b.cell(16), 'pointerdown', {x: at.x, y: at.y, pointerType: 'mouse'});
    pointer(b.cell(16), 'pointerup', {x: at.x, y: at.y, pointerType: 'mouse'});
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'tap', bar: 17, pointerType: 'mouse'});
    expect(b.log.activate.at(-1).t).toBeCloseTo(33, 6);
    expect(b.log.activate.at(-1).beatTime).toBeCloseTo(33, 6);
    pointer(b.cell(16), 'pointerdown', {x: at.x, y: at.y, pointerType: 'mouse'});
    pointer(b.cell(16), 'pointerup', {x: at.x, y: at.y, pointerType: 'mouse'});
    expect(b.log.activate.at(-1).kind).toBe('double');
    vi.advanceTimersByTime(400);
    // A touch long press released without moving: the bar menu.
    pointer(b.cell(16), 'pointerdown', {x: at.x + 10, y: at.y, pointerType: 'touch', pointerId: 4});
    vi.advanceTimersByTime(360);
    pointer(b.cell(16), 'pointerup', {x: at.x + 10, y: at.y, pointerType: 'touch', pointerId: 4});
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'long', bar: 17, pointerType: 'touch'});
    vi.advanceTimersByTime(900);   // the browser's own contextmenu after a long press is swallowed for 800 ms
    b.cell(16).dispatchEvent(new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2}));
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'context', bar: 17});
  });

  test('a mouse drag across bars loops them, bar-snapped (preview, then commit); Alt snaps to beats', async () => {
    const b = await bed();
    const map = b.ts.session.map;
    mouseDrag(b.cell(9), cellCentre(b, 9), cellCentre(b, 12));
    const commit = b.log.edits.at(-1);
    expect(commit).toMatchObject({phase: 'commit', a: map.bars[9].t0, b: map.bars[12].t1});
    expect(b.log.edits.some((e) => e.phase === 'preview')).toBe(true);
    // The band shows the preview at once.
    expect(b.el.querySelector('.loop-band').hidden).toBe(false);
    const from = cellCentre(b, 9), to = cellCentre(b, 10);
    mouseDrag(b.cell(9), {x: from.x - 10, y: from.y}, {x: to.x + 10, y: to.y}, {altKey: true});
    const beats = b.log.edits.at(-1);
    expect(beats.phase).toBe('commit');
    expect(beats.a).toBeCloseTo(map.snapTime(beats.a, 'beat'), 9);
    expect(beats.a).toBeGreaterThan(map.bars[9].t0);
    expect(beats.b).toBeLessThan(map.bars[10].t1);
  });

  test('a touch long-press then drag loops while stopped, never while playing (glass)', async () => {
    const b = await bed();
    const map = b.ts.session.map;
    const a = cellCentre(b, 2), z = cellCentre(b, 5);
    pointer(b.cell(2), 'pointerdown', {x: a.x, y: a.y, pointerType: 'touch', pointerId: 9});
    vi.advanceTimersByTime(360);
    for (let i = 1; i <= 5; i++) pointer(b.cell(2), 'pointermove', {x: a.x + (z.x - a.x) * i / 5, y: a.y, pointerType: 'touch', pointerId: 9});
    pointer(b.cell(2), 'pointerup', {x: z.x, y: z.y, pointerType: 'touch', pointerId: 9});
    expect(b.log.edits.at(-1)).toMatchObject({phase: 'commit', a: map.bars[2].t0, b: map.bars[5].t1});
    const before = b.log.edits.length;
    b.surface.setGlass(true);
    pointer(b.cell(2), 'pointerdown', {x: a.x, y: a.y, pointerType: 'touch', pointerId: 10});
    vi.advanceTimersByTime(360);
    for (let i = 1; i <= 5; i++) pointer(b.cell(2), 'pointermove', {x: a.x + (z.x - a.x) * i / 5, y: a.y, pointerType: 'touch', pointerId: 10});
    pointer(b.cell(2), 'pointerup', {x: z.x, y: z.y, pointerType: 'touch', pointerId: 10});
    expect(b.log.edits.length).toBe(before);
  });

  test('loop handles show the loop (a --loop-fill band, two 44 px handles with grip dots) and follow setLoop', async () => {
    const b = await bed({practice: practiceOf({cue: 32, loop: {on: true, a: 32, b: 48}})});
    const bands = [...b.el.querySelectorAll('.loop-band')].filter((x) => !x.hidden);
    expect(bands.length).toBeGreaterThan(0);
    const handles = [...b.el.querySelectorAll('.loop-handle')].filter((x) => !x.hidden);
    expect(handles.map((x) => x.dataset.edge).sort()).toEqual(['a', 'b']);
    expect(handles.every((x) => x.querySelector('.loop-handle-grip'))).toBe(true);
    b.surface.setLoop(null);
    expect([...b.el.querySelectorAll('.loop-band')].every((x) => x.hidden)).toBe(true);
  });

  test('the stage.bars grid: arrows rove the bars (keyboard focus only); Enter plays, L loops the focused bar', async () => {
    const b = await bed({width: 820, layout: 'band'});
    const map = b.ts.session.map;
    // One tabbable cell: the bar at the cue.
    expect(b.cells().filter((c) => c.tabIndex === 0)).toHaveLength(1);
    b.cell(0).focus();
    expect(b.reg.context().focused).toMatchObject({kind: 'bar', t0: 0, t1: 2, bar: 1, label: 'Bar 1'});
    keydown({key: 'ArrowRight', code: 'ArrowRight'}, {target: document.activeElement});
    expect(document.activeElement).toBe(b.cell(1));
    keydown({key: 'ArrowDown', code: 'ArrowDown'}, {target: document.activeElement});
    expect(document.activeElement).toBe(b.cell(5));
    keydown({key: 'End', code: 'End'}, {target: document.activeElement});
    expect(document.activeElement).toBe(b.cell(7));
    keydown({key: 'Home', code: 'Home'}, {target: document.activeElement});
    expect(document.activeElement).toBe(b.cell(4));
    expect(b.cells().filter((c) => c.tabIndex === 0)).toEqual([b.cell(4)]);
    expect(b.reg.context().focused).toMatchObject({kind: 'bar', t0: map.bars[4].t0, t1: map.bars[4].t1, bar: 5});
    expect(b.reg.run('focus.loop', {source: 'key'})).toBe(true);
    expect(b.ts.snapshot.loop).toMatchObject({on: true, a: map.bars[4].t0, b: map.bars[4].t1});
    expect(b.reg.run('focus.play', {source: 'key'})).toBe(true);
    await settle();
    expect(['playing', 'counting']).toContain(b.ts.snapshot.phase);
    // A pointer press withdraws ctx.focused (Enter and L go back to Again and the loop toggle).
    pointer(b.cell(4), 'pointerdown', {x: 10, y: 10, pointerType: 'mouse'});
    expect(b.reg.context().focused ?? null).toBeNull();
    pointer(b.cell(4), 'pointerup', {x: 10, y: 10, pointerType: 'mouse'});
    // Leaving the grid withdraws it too.
    keydown({key: 'ArrowRight', code: 'ArrowRight'}, {target: document.activeElement});
    expect(b.reg.context().focused).toMatchObject({bar: 6});
    document.activeElement.blur();
    expect(b.reg.context().focused ?? null).toBeNull();
  });

  test('through the dispatcher: in the stage.bars scope Enter plays from the focused bar and L loops it', async () => {
    const b = await bed({width: 820, layout: 'band'});
    const map = b.ts.session.map;
    document.documentElement.dataset.place = 'stage';
    document.documentElement.dataset.posture = 'stage';
    const stop = startDispatcher({registry: b.reg, platform: 'win'});
    current.push(() => { stop(); delete document.documentElement.dataset.place; delete document.documentElement.dataset.posture; });
    b.cell(8).focus();
    keydown('ArrowRight', {target: document.activeElement});
    keydown('ArrowRight', {target: document.activeElement});
    expect(document.activeElement).toBe(b.cell(10));
    keydown('KeyL', {target: document.activeElement});
    expect(b.ts.snapshot.loop).toMatchObject({on: true, a: map.bars[10].t0, b: map.bars[10].t1});
    b.ts.session.transport.clearLoop();
    keydown('Enter', {target: document.activeElement});
    await settle();
    expect(b.ts.snapshot.phase).toBe('playing');
    expect(b.ts.session.transport.position()).toBeCloseTo(map.bars[10].t0, 1);
  });

  test('keyboard moves past the rendered rows render the target row and scroll it into view', async () => {
    const b = await bed({width: 820, height: 400, layout: 'band'});
    b.cell(0).focus();
    for (let i = 0; i < 12; i++) keydown({key: 'ArrowDown', code: 'ArrowDown'}, {target: document.activeElement});
    expect(document.activeElement).toBe(b.cell(48));
    const row = b.surface.model.rows[12];
    expect(b.top).toBeGreaterThan(0);
    expect(row.y + row.h).toBeLessThanOrEqual(b.top + 400 + 8);
  });

  test('destroy removes the surface and withdraws ctx.focused', async () => {
    const b = await bed();
    b.cell(0).focus();
    expect(b.reg.context().focused).toBeTruthy();
    b.surface.destroy();
    expect(b.host.querySelector('.roadmap')).toBeNull();
    expect(b.reg.context().focused ?? null).toBeNull();
  });
});

describe('Wave page (unmapped)', () => {
  test('rows of 10 s on the rail (8 on the band) with second ticks and a label every 5 s', async () => {
    const b = await bed({mapped: false, duration: 128});
    expect(b.surface.kind).toBe('wave');
    expect(b.el.dataset.kind).toBe('wave');
    expect(b.surface.seconds).toBe(10);
    expect(b.surface.model.rows).toHaveLength(13);
    const grid = b.el.querySelector('[role=grid]');
    expect(grid.getAttribute('aria-label')).toBe('Song timeline');
    expect(b.cells()[1].getAttribute('aria-label')).toBe('0:10 to 0:20');
    const labels = [...b.rows()[1].querySelectorAll('.roadmap-time')].map((n) => n.textContent);
    expect(labels).toEqual(['0:10', '0:15']);
    const canvas = b.rows()[1].querySelector('canvas');
    const ticks = contextOf(canvas).callsOf('fillRect');
    expect(ticks).toHaveLength(11);   // 0:10 … 0:20
    const band = await bed({mapped: false, duration: 128, width: 820, layout: 'band'});
    expect(band.surface.seconds).toBe(8);
  });

  test('= / − change the row length (4–30 s)', async () => {
    const b = await bed({mapped: false, duration: 128, width: 400, height: 300});
    expect(b.surface.zoom(1)).toBe(true);
    expect(b.surface.seconds).toBe(8);
    expect(b.surface.model.rows).toHaveLength(16);
    const seen = [];
    while (b.surface.zoom(1)) seen.push(b.surface.seconds);
    expect(seen).toEqual([6, 5, 4]);
    expect(b.surface.zoom(1)).toBe(false);
    while (b.surface.zoom(-1)) seen.push(b.surface.seconds);
    expect(seen.slice(3)).toEqual([5, 6, 8, 10, 12, 15, 20, 25, 30]);
    expect(b.surface.model.rows).toHaveLength(5);
  });

  test('a pinch (here ⌘/Ctrl + wheel) changes the row length once, on release', async () => {
    const b = await bed({mapped: false, duration: 128, width: 400, height: 300});
    const wheel = new window.Event('wheel', {bubbles: true, cancelable: true});
    for (const [k, v] of Object.entries({ctrlKey: true, metaKey: false, deltaY: -40, deltaMode: 0, clientX: 100, clientY: 100})) Object.defineProperty(wheel, k, {value: v});
    b.el.dispatchEvent(wheel);
    expect(b.surface.seconds).toBe(10);   // previewed as a transform until it commits
    vi.advanceTimersByTime(300);
    expect(b.surface.seconds).toBeLessThan(10);
    expect(b.surface.model.seconds).toBe(b.surface.seconds);
  });

  test('markers and spots fly as flags; the playhead sweeps the row; no bar outline and no lamps', async () => {
    const b = await bed({mapped: false, duration: 128, practice: practiceOf({cue: 20,
      markers: [{id: 'm1', t: 12, label: 'Groove', updatedAt: 1}], spots: [{id: 's1', name: 'The run', a: 13, b: 18, rate: 1, passes: 0, updatedAt: 1}]})});
    const flags = [...b.el.querySelectorAll('.roadmap-flag')].map((f) => f.textContent);
    expect(flags).toEqual(['⚑ Groove', '◆ The run']);
    b.frame(25, {playing: true});
    const playhead = b.el.querySelector('.roadmap-playhead');
    expect(playhead.hidden).toBe(false);
    const row = b.surface.model.rows[2];
    expect(translateX(playhead)).toBeCloseTo(row.band.x + 0.5 * row.band.w, 2);
    expect(b.el.querySelector('.roadmap-now').hidden).toBe(true);
    expect(b.el.querySelector('.roadmap-beat').hidden).toBe(true);
    expect(b.el.querySelector('[data-now]')).toBeNull();
  });

  test('a loop drag snaps to 0.1 s; the grid rows play and loop through stage.bars', async () => {
    const b = await bed({mapped: false, duration: 128});
    const row = b.surface.model.rows[1];
    const x = (t) => row.band.x + ((t - row.t0) / 10) * row.band.w;
    const y = row.band.y + 20;
    mouseDrag(b.cells()[1], {x: x(12.34), y}, {x: x(15.67), y});
    expect(b.log.edits.at(-1)).toMatchObject({phase: 'commit', a: 12.3, b: 15.7});
    vi.advanceTimersByTime(1100);   // a focus-in right after a press is the press's (no ctx.focused)
    b.cells()[1].focus();
    expect(b.reg.context().focused).toMatchObject({kind: 'marker', t0: 10, t1: 20, label: '0:10–0:20'});
    keydown({key: 'ArrowDown', code: 'ArrowDown'}, {target: document.activeElement});
    expect(b.reg.context().focused).toMatchObject({t0: 20, t1: 30});
    expect(b.reg.run('focus.loop', {source: 'key'})).toBe(true);
    expect(b.ts.snapshot.loop).toMatchObject({on: true, a: 20, b: 30});
  });

  test('no string the surface produces for an unmapped song says "Bar" (§2.14.4), and no lamps', async () => {
    const b = await bed({mapped: false, duration: 128, practice: practiceOf({cue: 40, loop: {on: true, a: 31.2, b: 41},
      markers: [{id: 'm1', t: 12, label: 'Groove', updatedAt: 1}], spots: [{id: 's1', name: 'The run', a: 52, b: 58, rate: 1, passes: 0, updatedAt: 1}]})});
    b.frame(44, {playing: true});
    b.cells()[2].focus();
    for (const s of strings(b.el)) {
      expect(s).not.toMatch(/Bar/);
      expect(s).not.toMatch(/bar /i);
    }
    expect(b.el.querySelector('.roadmap-cell-number')).toBeNull();
    expect(b.el.querySelector('[class*=lamp]')).toBeNull();
    expect(JSON.stringify(b.reg.context().focused)).not.toMatch(/bar/i);
  });

  test('the surface switches to the Road map when the song gains a bar grid', async () => {
    const b = await bed({mapped: false, duration: 128});
    expect(b.surface.kind).toBe('wave');
    b.ts.session.mapChange('Bars found', (m) => m.adopt(structuredClone(sectioned.tempo.songMap)));
    await settle();
    expect(b.surface.kind).toBe('roadmap');
    expect(b.el.dataset.kind).toBe('roadmap');
    expect(b.el.querySelector('[role=grid]').getAttribute('aria-label')).toBe('Bars');
    expect(b.cell(0).getAttribute('aria-label')).toBe('Bar 1, Intro');
  });
});

describe('frames from the session', () => {
  test('readFrame(session) drives the surface like the Stage frame bus', async () => {
    const b = await bed({practice: practiceOf({cue: 50})});
    b.surface.frame(readFrame(b.ts.session));
    expect(b.cell(25).hasAttribute('data-now')).toBe(true);   // 50 s: bar 26 (index 25)
  });
});

describe('relayouts keep the current bar, keyboard focus and the device row length', () => {
  /** The geometry of bar i's cell in the current model. */
  const cellBox = (b, i) => {
    const row = b.surface.model.rows.find((r) => r.first <= i && i <= r.last);
    const cell = row.cells.find((c) => c.bar === i);
    return {left: cell.x, width: cell.w, top: row.band.y, height: row.band.h};
  };
  const boxOf = (el) => ({left: num(el.style.left), width: num(el.style.width), top: num(el.style.top), height: num(el.style.height)});

  test('the --now outline follows a Distance change and a new flag lane while stopped', async () => {
    const b = await bed({width: 820, height: 860, layout: 'band'});
    b.frame(33.25);   // stopped in bar 17 (index 16)
    const now = b.el.querySelector('.roadmap-now');
    const playhead = b.el.querySelector('.roadmap-playhead');
    expect(boxOf(now)).toEqual(cellBox(b, 16));
    b.surface.setDistance('kit');
    expect(boxOf(now)).toEqual(cellBox(b, 16));
    expect(boxOf(now).height).toBe(114);
    expect(num(playhead.style.top)).toBe(cellBox(b, 16).top);
    // A spot in row 0 adds a flag lane: every row below moves down.
    const before = cellBox(b, 16).top;
    b.ts.session.practice.addSpot({name: 'Fill', a: 4, b: 8, rate: 1});
    await settle();
    expect(cellBox(b, 16).top).toBeGreaterThan(before);
    expect(boxOf(now)).toEqual(cellBox(b, 16));
    expect(num(playhead.style.top)).toBe(cellBox(b, 16).top);
  });

  test('a focused bar keeps keyboard focus (and ctx.focused) across Distance, a new spot and a map revision', async () => {
    const b = await bed({width: 820, layout: 'band'});
    b.cell(0).focus();
    keydown({key: 'ArrowRight', code: 'ArrowRight'}, {target: document.activeElement});
    expect(document.activeElement).toBe(b.cell(1));
    b.surface.setDistance('kit');
    expect(document.activeElement).toBe(b.cell(1));
    expect(b.reg.context().focused).toMatchObject({kind: 'bar', label: 'Bar 2'});
    keydown({key: 'ArrowRight', code: 'ArrowRight'}, {target: document.activeElement});
    expect(document.activeElement).toBe(b.cell(2));
    b.ts.session.practice.patch({spots: [{id: 's1', name: 'Fill', a: 4, b: 8, rate: 1, passes: 0, updatedAt: 1}]});
    await settle();
    expect(b.surface.model.rows[0].flag).toBe(true);
    expect(document.activeElement).toBe(b.cell(2));
    expect(b.reg.context().focused).toMatchObject({label: 'Bar 3'});
    b.ts.session.mapChange('Section', (m) => m.adopt(structuredClone(sectioned.tempo.songMap)));
    await settle();
    expect(document.activeElement).toBe(b.cell(2));
    keydown({key: 'ArrowRight', code: 'ArrowRight'}, {target: document.activeElement});
    expect(document.activeElement).toBe(b.cell(3));
  });

  test('a cell focused by a press stays focused across a relayout, still without ctx.focused', async () => {
    const b = await bed({width: 820, layout: 'band'});
    pointer(b.cell(3), 'pointerdown', {x: 10, y: 10, pointerType: 'mouse'});
    b.cell(3).focus();
    pointer(b.cell(3), 'pointerup', {x: 10, y: 10, pointerType: 'mouse'});
    expect(b.reg.context().focused ?? null).toBeNull();
    vi.advanceTimersByTime(1100);
    b.surface.setDistance('near');
    expect(document.activeElement).toBe(b.cell(3));
    expect(b.reg.context().focused ?? null).toBeNull();
  });

  test('Wave page: = keeps focus on the row now holding the focused row\'s start; a bar grid moves it to that bar', async () => {
    const b = await bed({mapped: false, duration: 128});
    const row = (i) => b.el.querySelector(`.roadmap-wavecell[data-row="${i}"]`);
    row(3).focus();
    expect(b.reg.context().focused).toMatchObject({t0: 30, t1: 40, label: '0:30–0:40'});
    expect(b.surface.zoom(1)).toBe(true);   // 8 s rows: 30 s is in row 3, 0:24–0:32
    expect(document.activeElement).toBe(row(3));
    expect(b.reg.context().focused).toMatchObject({t0: 24, t1: 32});
    keydown({key: 'ArrowDown', code: 'ArrowDown'}, {target: document.activeElement});
    expect(document.activeElement).toBe(row(4));
    b.ts.session.mapChange('Bars found', (m) => m.adopt(structuredClone(sectioned.tempo.songMap)));
    await settle();
    expect(b.surface.kind).toBe('roadmap');
    expect(document.activeElement).toBe(b.cell(16));   // 32 s: bar 17
    expect(b.reg.context().focused).toMatchObject({kind: 'bar', bar: 17});
  });

  test('a tap past a short row\'s last cell does nothing (no cue at the next section)', async () => {
    const tempo = tempoOf(sectioned);
    tempo.songMap.measures[2].label = 'Verse A';   // a 2-bar Intro: row 0 holds two cells of eight
    const b = await bed({tempo});
    const row = b.surface.model.rows[0];
    expect(row.cells).toHaveLength(2);
    const y = row.band.y + row.band.h / 2, x = row.band.x + row.band.w + 300;
    const target = b.rows()[0];
    pointer(target, 'pointerdown', {x, y, pointerType: 'mouse'});
    pointer(target, 'pointerup', {x, y, pointerType: 'mouse'});
    target.dispatchEvent(new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2}));
    expect(b.log.activate).toEqual([]);
    vi.advanceTimersByTime(400);
    const at = cellCentre(b, 1);
    pointer(b.cell(1), 'pointerdown', {x: at.x, y: at.y, pointerType: 'mouse'});
    pointer(b.cell(1), 'pointerup', {x: at.x, y: at.y, pointerType: 'mouse'});
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'tap', bar: 2});
    expect(b.log.activate.at(-1).beatTime).toBeLessThan(b.ts.session.map.bars[2].t0);
  });

  test('a silent map.setDuration (the decoded length) rebuilds the rows', async () => {
    const b = await bed({mapped: false, duration: 128});
    expect(b.surface.model.rows).toHaveLength(13);
    b.ts.session.map.setDuration(200);
    b.frame(5);
    expect(b.surface.model.rows).toHaveLength(20);
    // While loading: the load signal's change after the session's own setDuration rebuilds them.
    const c = await bed({mapped: false, duration: 128, load: false});
    c.ts.session.map.setDuration(200);
    const before = c.surface.model;
    await c.ts.ready();
    await settle();
    expect(c.surface.model).not.toBe(before);
    expect(c.surface.model.rows).toHaveLength(Math.ceil(c.ts.session.map.duration / 10 - 1e-6));
  });

  test('the Wave page row length is the device pref roadmap.waveRowSec (= / − and pinches write it)', async () => {
    const prefs = memPrefs();
    const b = await bed({mapped: false, duration: 128, prefs});
    expect(b.surface.seconds).toBe(10);
    b.surface.zoom(-1);
    expect(prefs.values['roadmap.waveRowSec']).toBe(12);
    b.surface.destroy();
    const host = document.createElement('div');
    document.body.append(host);
    const again = createRoadmapSurface(host, {session: b.ts.session, layout: 'band', prefs, registry: b.reg});
    current.push(() => again.destroy());
    expect(again.seconds).toBe(12);   // not the band's 8: the device's own choice
    again.setLayout('rail');
    expect(again.seconds).toBe(12);
    // With no stored length, the layout's default follows the layout.
    const fresh = createRoadmapSurface(host, {session: b.ts.session, layout: 'band', prefs: memPrefs(), registry: b.reg});
    current.push(() => fresh.destroy());
    expect(fresh.seconds).toBe(8);
    fresh.setLayout('rail');
    expect(fresh.seconds).toBe(10);
    // A stored value off the steps snaps to the nearest one.
    const odd = createRoadmapSurface(host, {session: b.ts.session, layout: 'band', prefs: memPrefs({'roadmap.waveRowSec': 11}), registry: b.reg});
    current.push(() => odd.destroy());
    expect([10, 12]).toContain(odd.seconds);
  });

  test('a pickup in 3/4 shows its meter chip on the first full bar', async () => {
    const measures = Array.from({length: 12}, (_, i) => ({id: `w${i}`, numerator: 3, denominator: 4, length: i === 0 ? frac(1) : frac(3), label: ''}));
    const tempo = {songMap: {version: 1, origin: 'edited', tailQpm: 120, pins: [{position: frac(0), time: 0.5}], measures}};
    const b = await bed({tempo, duration: 18, width: 820, layout: 'band'});
    expect(b.ts.session.map.bars[0].pickup).toBe(true);
    const chips = (i) => [...(b.cell(i)?.querySelectorAll('.roadmap-chip') ?? [])].map((c) => c.textContent);
    expect(chips(0)).toEqual([]);
    expect(chips(1)).toEqual(['3/4']);
    expect(b.cell(1).getAttribute('aria-label')).toContain('3/4');
    expect(chips(2)).toEqual([]);
    // A 4/4 pickup: plain, no chip anywhere.
    const plain = await bed({tempo: tempoOf(pickup), duration: 20, width: 820, layout: 'band'});
    expect(plain.el.querySelectorAll('.roadmap-chip')).toHaveLength(0);
  });
});

describe('loop handles through the surface', () => {
  const handle = (b, edge) => [...b.el.querySelectorAll(`.loop-handle[data-edge=${edge}]`)].find((x) => !x.hidden);
  /** Drags a loop handle to (x, y) in steps; returns the commit. */
  function dragHandle(b, edge, to, mods = {}) {
    const el = handle(b, edge);
    const x0 = num(el.style.left) + 22, y0 = num(el.style.top) + 10;
    pointer(el, 'pointerdown', {x: x0, y: y0, pointerType: 'mouse', pointerId: 21, ...mods});
    for (let i = 1; i <= 4; i++) pointer(el, 'pointermove', {x: x0 + (to.x - x0) * i / 4, y: y0 + (to.y - y0) * i / 4, pointerType: 'mouse', pointerId: 21, ...mods});
    pointer(el, 'pointerup', {x: to.x, y: to.y, pointerType: 'mouse', pointerId: 21, ...mods});
    return b.log.edits.at(-1);
  }
  /** Content point at fraction f through bar i. */
  const inBar = (b, i, f) => {
    const row = b.surface.model.rows.find((r) => r.first <= i && i <= r.last);
    const cell = row.cells.find((c) => c.bar === i);
    return {x: cell.x + f * cell.w, y: row.band.y + row.band.h / 2};
  };

  test('an edge drag snaps to bar lines (Alt: beats, Shift: exact), previews, commits and springs for 120 ms', async () => {
    const b = await bed({practice: practiceOf({cue: 8, loop: {on: true, a: 8, b: 18}})});
    const map = b.ts.session.map;
    const root = b.el.querySelector('.loop-handles');
    const plain = dragHandle(b, 'b', inBar(b, 10, 0.7));
    expect(plain).toMatchObject({phase: 'commit', a: 8, b: map.bars[10].t1});
    expect(b.log.edits.some((e) => e.phase === 'preview')).toBe(true);
    expect(root.hasAttribute('data-spring')).toBe(true);
    vi.advanceTimersByTime(119);
    expect(root.hasAttribute('data-spring')).toBe(true);
    vi.advanceTimersByTime(2);
    expect(root.hasAttribute('data-spring')).toBe(false);
    b.surface.setLoop(plain);
    const beat = dragHandle(b, 'b', inBar(b, 11, 0.7), {altKey: true});   // 23.4 s → the beat at 23.5
    expect(beat.phase).toBe('commit');
    expect(beat.b).toBeCloseTo(23.5, 6);
    b.surface.setLoop(beat);
    const exact = dragHandle(b, 'b', inBar(b, 12, 0.7), {shiftKey: true});
    expect(exact.b).toBeCloseTo(25.4, 3);
    // The a edge snaps too (to the nearest bar line).
    b.surface.setLoop(exact);
    const a = dragHandle(b, 'a', inBar(b, 5, 0.4));
    expect(a).toMatchObject({phase: 'commit', a: map.bars[5].t0});
  });

  test('reduced motion: the handles jump (no spring)', async () => {
    vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener() {}, removeEventListener() {}}));
    current.push(() => vi.unstubAllGlobals());
    const b = await bed({practice: practiceOf({cue: 8, loop: {on: true, a: 8, b: 18}})});
    dragHandle(b, 'b', inBar(b, 10, 0.7));
    expect(b.el.querySelector('.loop-handles').hasAttribute('data-spring')).toBe(false);
  });

  test('Wave page: an edge drag snaps to 0.1 s', async () => {
    const b = await bed({mapped: false, duration: 128, practice: practiceOf({cue: 12, loop: {on: true, a: 12, b: 15}})});
    const row = b.surface.model.rows[1];
    const x = (t) => row.band.x + ((t - row.t0) / 10) * row.band.w;
    const commit = dragHandle(b, 'b', {x: x(17.34), y: row.band.y + 20});
    expect(commit).toMatchObject({phase: 'commit', a: 12, b: 17.3});
  });
});

describe('menu targets: spot flags, marker ticks and the loop band (I2b-15; spec §8 "Defined menus", §4.7)', () => {
  const rightClick = (target, {x, y}) => target.dispatchEvent(new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2}));
  function longPress(target, {x, y}, pointerId = 7) {
    pointer(target, 'pointerdown', {x, y, pointerType: 'touch', pointerId});
    vi.advanceTimersByTime(360);
    pointer(target, 'pointerup', {x, y, pointerType: 'touch', pointerId});
    vi.advanceTimersByTime(900);   // past the swallowed browser contextmenu
  }
  const rowOf = (b, i) => b.surface.model.rows.find((r) => r.first <= i && i <= r.last);
  const spotS1 = {id: 's1', name: 'Bridge walk-up', a: 81, b: 96, rate: 0.9, passes: 0, updatedAt: 1};
  const markerM1 = {id: 'm1', t: 41, label: 'Flam', updatedAt: 1};

  test('a right-click or a long press on a spot flag reports the spot (with onOpen), not the bar', async () => {
    const b = await bed({practice: practiceOf({spots: [spotS1]})});
    const row = rowOf(b, 40);
    b.userScroll(row.y);
    const flag = b.el.querySelector('.roadmap-flag[data-flag=spot]');
    const y = row.flagY + b.surface.model.metrics.flagH / 2;
    const x = num(flag.style.left) + 10;
    rightClick(flag, {x, y});
    const e = b.log.activate.at(-1);
    expect(e).toMatchObject({kind: 'context', target: {kind: 'spot', spot: {id: 's1', name: 'Bridge walk-up', a: 81, b: 96}}});
    expect(typeof e.target.onOpen).toBe('function');
    // A finger in the flag lane, a few px short of the flag's start (touch slop), off the flag element.
    longPress(b.rows().find((n) => n.contains(flag)), {x: num(flag.style.left) - 8, y});
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'long', pointerType: 'touch', target: {kind: 'spot', spot: {id: 's1'}}});
    // Well past the flag's text, the lane is the bar's again.
    rightClick(b.rows().find((n) => n.contains(flag)), {x: num(flag.style.left) + 600, y});
    expect(b.log.activate.at(-1).kind).toBe('context');
    expect(b.log.activate.at(-1).target).toBeUndefined();
    // A tap on the flag is still a tap (no target).
    vi.advanceTimersByTime(400);
    pointer(flag, 'pointerdown', {x, y, pointerType: 'mouse'});
    pointer(flag, 'pointerup', {x, y, pointerType: 'mouse'});
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'tap'});
    expect(b.log.activate.at(-1).target).toBeUndefined();
  });

  test('the spot menu\'s Open shows the spot\'s note in the Notes card (only when it has one)', async () => {
    const b = await bed({practice: practiceOf({spots: [{...spotS1, note: 'Ghost notes on the snare'}, {...spotS1, id: 's2', name: 'Plain', a: 20, b: 24}]})});
    const run = vi.fn();
    b.reg.register({id: 'stage.notes', title: 'Notes', group: 'Practice', run});
    const row = rowOf(b, 40);
    b.userScroll(row.y);
    const flag = b.el.querySelector('.roadmap-flag[data-id="s1"]');
    rightClick(flag, {x: num(flag.style.left) + 4, y: row.flagY + 4});
    const {target} = b.log.activate.at(-1);
    target.onOpen(target.spot);
    expect(run).toHaveBeenCalledTimes(1);
    b.userScroll(rowOf(b, 10).y);
    const plain = b.el.querySelector('.roadmap-flag[data-id="s2"]');
    rightClick(plain, {x: num(plain.style.left) + 4, y: rowOf(b, 10).flagY + 4});
    const t2 = b.log.activate.at(-1).target;
    expect(t2).toMatchObject({kind: 'spot', spot: {id: 's2'}});
    t2.onOpen(t2.spot);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('a marker tick reports the marker (with slop); a press off it is the bar\'s', async () => {
    const b = await bed({practice: practiceOf({markers: [markerM1]})});
    const row = rowOf(b, 20);
    b.userScroll(row.y);
    const tick = b.el.querySelector('.roadmap-marker');
    const x = num(tick.style.left) + 1, y = row.band.y + row.band.h / 2;
    rightClick(b.cell(20), {x: x + 3, y});
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'context', target: {kind: 'marker', marker: {id: 'm1', t: 41, label: 'Flam'}}});
    longPress(b.cell(20), {x: x - 10, y});
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'long', target: {kind: 'marker', marker: {id: 'm1'}}});
    rightClick(b.cell(20), {x: x + 30, y});
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'context', bar: 21});
    expect(b.log.activate.at(-1).target).toBeUndefined();
  });

  test('the loop band (and its edge handles) reports loopBand while a loop is on; a marker inside it wins', async () => {
    const b = await bed({practice: practiceOf({cue: 36, markers: [markerM1], loop: {on: true, a: 36, b: 44}})});
    const row = rowOf(b, 18);
    b.userScroll(row.y);
    const y = row.band.y + row.band.h / 2;
    const inside = cellCentre(b, 18);   // 37 s
    rightClick(b.cell(18), inside);
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'context', bar: 19, target: {kind: 'loopBand'}});
    longPress(b.cell(18), inside);
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'long', target: {kind: 'loopBand'}});
    // The a edge's handle (half of 44 px either side of the line).
    const edge = b.surface.model.rows.find((r) => r.first <= 18 && 18 <= r.last).cells.find((c) => c.bar === 18).x;
    rightClick(b.cell(17), {x: edge - 15, y});
    expect(b.log.activate.at(-1).target).toEqual({kind: 'loopBand'});
    // The marker at 41 s sits inside the loop: its tick wins.
    const tick = b.el.querySelector('.roadmap-marker');
    rightClick(b.cell(20), {x: num(tick.style.left) + 1, y});
    expect(b.log.activate.at(-1).target).toMatchObject({kind: 'marker', marker: {id: 'm1'}});
    // Outside the loop: the bar menu.
    rightClick(b.cell(16), cellCentre(b, 16));
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'context', bar: 17});
    expect(b.log.activate.at(-1).target).toBeUndefined();
    // Loop off: no band.
    b.ts.session.transport.toggleLoop();
    b.surface.setLoop(null);
    rightClick(b.cell(18), inside);
    expect(b.log.activate.at(-1).target).toBeUndefined();
  });

  test('Shift+F10 on a focused bar keeps the bar menu, even inside the loop', async () => {
    const b = await bed({practice: practiceOf({cue: 36, loop: {on: true, a: 36, b: 44}})});
    b.userScroll(rowOf(b, 18).y);
    b.cell(18).focus();
    keydown({key: 'F10', code: 'F10'}, {target: b.cell(18), shiftKey: true});
    const e = b.log.activate.at(-1);
    expect(e.kind).toBe('context');
    expect(e.target).toBeUndefined();
  });

  test('Wave page: marker and spot flags report their targets', async () => {
    const b = await bed({mapped: false, duration: 128, practice: practiceOf({
      markers: [{id: 'm1', t: 12, label: 'Groove', updatedAt: 1}], spots: [{id: 's1', name: 'The run', a: 15, b: 18, rate: 1, passes: 0, updatedAt: 1}]})});
    const marker = b.el.querySelector('.roadmap-flag[data-flag=marker]');
    const spot = b.el.querySelector('.roadmap-flag[data-flag=spot]');
    const row = b.surface.model.rows[1];
    rightClick(marker, {x: num(marker.style.left) + 4, y: row.flagY + 4});
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'context', target: {kind: 'marker', marker: {id: 'm1', label: 'Groove'}}});
    longPress(spot, {x: num(spot.style.left) + 4, y: row.flagY + 4});
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'long', target: {kind: 'spot', spot: {id: 's1', name: 'The run'}}});
  });

  test('the targets build ST8a\'s menus', async () => {
    const menus = await import('../src/stage/menus.js');
    const b = await bed({practice: practiceOf({spots: [spotS1], markers: [markerM1]})});
    const s = b.ts.session;
    expect(menus.spotMenu(s, {kind: 'spot', ...spotS1}).map((i) => i.id).filter(Boolean)).toEqual(['open', 'rename', 'update', 'delete']);
    const row = rowOf(b, 20);
    b.userScroll(row.y);
    const tick = b.el.querySelector('.roadmap-marker');
    rightClick(b.cell(20), {x: num(tick.style.left) + 1, y: row.band.y + 10});
    const {target} = b.log.activate.at(-1);
    expect(menus.markerMenu(s, target.marker).map((i) => i.id)).toEqual(expect.arrayContaining(['rename', 'delete']));
  });
});
