// @vitest-environment happy-dom
// The song strip (src/stage/strip.js; architecture §2.14.10, spec §4.5) on a real session
// (tests/helpers/test-session.js: SongMapStore, Metronome and MultitrackEngine over
// tests/helpers/fake-audio.js, transport, position, practice state, undo, detect flow). Gestures go
// through the real press recogniser (pointer events); keys go through the real dispatcher.
// Geometry, colours and touch-action are Playwright states (tests/fixture/states/ST6.cjs).
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {createRegistry} from '../src/app/commands.js';
import {startDispatcher} from '../src/app/dispatch.js';
import {clock as appClock} from '../src/app/clock.js';
import {signal} from '../src/app/store.js';
import {defineTransportCommands} from '../src/stage/transport-commands.js';
import {COPY, CONTROLS, MIN_SEGMENT_PX, SPRING_MS, mountStrip, spanMapper, stripLayout} from '../src/stage/strip.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {contextOf, installCanvasShim, installPopoverShim, installResizeObserverShim, keydown, pointer, restoreDomShims, setRect, triggerResize} from './helpers/dom.js';
import {REHEARSAL_SECTIONS, pickup, sectioned, tempoOf} from './fixtures/maps.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HAS_MENUS = existsSync(join(ROOT, 'src/stage/menus.js'));
const WIDTH = 800;

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

/** The rehearsal map with every bar label cleared (mapped, no sections). */
function unlabelled() {
  const tempo = tempoOf(sectioned);
  for (const m of tempo.songMap.measures) m.label = '';
  return tempo;
}

/** The rehearsal map with a section every two bars: 32 sections of 4 s (they overflow 800 px). */
function manySections() {
  const tempo = tempoOf(sectioned);
  tempo.songMap.measures.forEach((m, i) => { m.label = i % 2 === 0 ? `Part ${i / 2 + 1}` : ''; });
  return tempo;
}

/** A session, a registry with the transport commands (+ the strip's chip commands) and a mounted strip. */
async function bed({width = WIDTH, viewport = null, onViewport, onScrub, ...options} = {}) {
  const ts = await createTestSession({clock, ...options});
  const reg = createRegistry();
  const offTransport = defineTransportCommands({registry: reg});
  const ran = [];
  // The Stage's definitions (src/stage/commands.js, ST4) are not this suite's subject: the chips
  // only need commands with those ids.
  reg.register({id: 'stage.getBars', title: 'Get bars…', group: 'Practice', run: () => { ran.push('stage.getBars'); }});
  reg.register({id: 'sections.keepAll', title: 'Keep suggested sections', group: 'Map',
    when: (c) => !!c.session?.detect?.suggestion?.peek?.(), run: (c) => { ran.push('sections.keepAll'); c.session.detect.keepAll(); }});
  reg.register({id: 'sections.review', title: 'Review suggested sections', group: 'Map',
    when: (c) => !!c.session?.detect?.suggestion?.peek?.(), run: (c) => { ran.push('sections.review'); c.session.detect.review(); }});
  reg.provide('session', () => ts.session);
  reg.provide('transport', () => ts.session.transport);
  const host = document.createElement('div');
  document.body.append(host);
  const strip = mountStrip(host, {session: ts.session, registry: reg, viewport, onViewport, onScrub});
  const nav = host.querySelector('nav.strip');
  const track = nav.querySelector('.strip-track');
  const slider = nav.querySelector('[role=slider]');
  setRect(track, {x: 0, y: 0, width, height: 56});
  setRect(nav.querySelector('.strip-content'), {x: 0, y: 0, width, height: 56});
  triggerResize(track);
  ts.session.frame.start();
  current.push(async () => { strip.destroy(); offTransport(); await ts.dispose(); });
  const b = {
    ts, reg, strip, host, nav, track, slider, ran,
    get snap() { return ts.snapshot; },
    segs: () => [...nav.querySelectorAll('.strip-seg')],
    labels: () => [...nav.querySelectorAll('.strip-seg-label')].map((n) => n.textContent),
  };
  return b;
}

const left = (el) => parseFloat(el.style.left);
const widthOf = (el) => parseFloat(el.style.width);
const translateX = (el) => Number(/translateX\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? NaN);

function mouseTap(target, x, y = 20) {
  pointer(target, 'pointerdown', {x, y, pointerType: 'mouse'});
  pointer(target, 'pointerup', {x, y, pointerType: 'mouse'});
}

function touchTap(target, x, y = 20, id = 7) {
  pointer(target, 'pointerdown', {x, y, pointerType: 'touch', pointerId: id});
  pointer(target, 'pointerup', {x, y, pointerType: 'touch', pointerId: id});
}

function mouseDrag(target, from, to, {altKey = false} = {}) {
  pointer(target, 'pointerdown', {x: from, y: 20, pointerType: 'mouse', altKey});
  for (let i = 1; i <= 6; i++) pointer(target, 'pointermove', {x: from + (to - from) * i / 6, y: 20, pointerType: 'mouse', altKey});
  pointer(target, 'pointerup', {x: to, y: 20, pointerType: 'mouse', altKey});
}

/** Every visible string and every accessible attribute in the strip. */
function strings(root) {
  const out = [root.textContent];
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const name of ['aria-label', 'aria-valuetext', 'title', 'placeholder', 'aria-description']) {
      const v = el.getAttribute(name);
      if (v) out.push(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

describe('layout (pure, dimensions as inputs)', () => {
  test.each([
    ['equal spans share the width', [[0, 10], [10, 20], [20, 30], [30, 40]], 800, 56, [200, 200, 200, 200], 800],
    ['proportional to duration', [[0, 10], [10, 40]], 800, 56, [200, 600], 800],
    ['a short span is floored at 56 px and the rest share what is left', [[0, 1], [1, 51], [51, 101]], 400, 56, [56, 172, 172], 400],
    ['floors that do not fit overflow (the strip scrolls)', Array.from({length: 20}, (_, i) => [i, i + 1]), 800, 56, Array(20).fill(56), 1120],
    ['a cascade: pinning one span pushes another under the floor', [[0, 1], [1, 3], [3, 100]], 300, 56, [56, 56, 188], 300],
  ])('%s', (_, spans, width, minPx, widths, total) => {
    const {width: w, boxes} = stripLayout({spans: spans.map(([t0, t1]) => ({t0, t1})), width, minPx});
    expect(w).toBeCloseTo(total, 6);
    boxes.forEach((box, i) => expect(box.w).toBeCloseTo(widths[i], 6));
    let x = 0;
    for (const box of boxes) { expect(box.x).toBeCloseTo(x, 6); x += box.w; }
  });

  test('no spans, or zero width, never throws', () => {
    expect(stripLayout({spans: [], width: 300})).toEqual({width: 300, boxes: []});
    const {boxes} = stripLayout({spans: [{t0: 0, t1: 10}], width: 0, minPx: 0});
    expect(boxes).toEqual([{x: 0, w: 0}]);
  });

  test('spanMapper maps time to x piecewise and back', () => {
    const spans = [{t0: 0, t1: 1}, {t0: 1, t1: 51}];
    const {boxes} = stripLayout({spans, width: 400, minPx: 56});
    const m = spanMapper(spans, boxes);
    expect(m.toX(0)).toBe(0);
    expect(m.toX(0.5)).toBeCloseTo(28, 6);
    expect(m.toX(1)).toBeCloseTo(56, 6);
    expect(m.toX(26)).toBeCloseTo(56 + 344 / 2, 6);
    expect(m.toX(99)).toBeCloseTo(400, 6);
    for (const t of [0.25, 3, 20, 50]) expect(m.toT(m.toX(t))).toBeCloseTo(t, 6);
    expect(m.indexAt(0.99)).toBe(0);
    expect(m.indexAt(1)).toBe(1);
    expect(m.indexAt(400)).toBe(1);
  });
});

describe('copy and controls (§9.0 table)', () => {
  test.each(CONTROLS.map((row) => [row.role, row.name, row]))('%s "%s" renders with that role and name', async (role, name, row) => {
    const options = {
      always: {},
      unmapped: {mapped: false},
      suggestion: {tempo: unlabelled(), sectionSuggestion: {jobId: 'job-1', sections: [{t0: 0, label: 'Intro', confidence: 0.8}, {t0: 32, label: 'Verse', confidence: 0.7}]}},
      rename: {},
    }[row.context];
    const b = await bed(options);
    if (row.context === 'rename') expect(b.strip.rename(b.ts.position.regions()[2])).toBe(true);
    const selector = {navigation: 'nav', slider: '[role=slider]', group: '[role=group]', button: 'button', textbox: 'input[type=text]'}[role];
    const nodes = [...b.host.querySelectorAll(selector)];
    const named = nodes.filter((n) => (n.getAttribute('aria-label') ?? n.querySelector('.ui-button-label')?.textContent ?? n.textContent).trim() === name);
    expect(named, `${role} named ${name}`).toHaveLength(1);
    if (row.command) {
      named[0].click();
      expect(b.ran).toContain(row.command);
    }
  });

  test('copy reads as the spec writes it', () => {
    expect(COPY.pending('Verse 2')).toBe('→ Verse 2');
    expect(COPY.scrub(['Bar 41', 'Bridge'])).toBe('Bar 41 · Bridge');
    expect(COPY.valueMapped({bar: 'Bar 12', beat: 3, section: 'Chorus'})).toBe('Bar 12, beat 3, Chorus');
    expect(COPY.valueUnmapped({time: '1:12'})).toBe('1:12');
    expect(`${COPY.noGrid} · ${COPY.getBars} →`).toBe('No bar grid · Get bars →');
  });
});

describe('mapped with sections', () => {
  test('one segment per section, widths proportional, alternating, 15/600 labels; the slot is a Sections nav with a slider', async () => {
    const b = await bed();
    expect(b.nav.getAttribute('aria-label')).toBe('Sections');
    expect(b.nav.dataset.scope).toBe('stage.strip');
    expect(b.nav.dataset.consumeKeys).toBe('ArrowLeft ArrowRight Home End');
    expect(b.nav.dataset.mode).toBe('sections');
    expect(b.labels()).toEqual([...REHEARSAL_SECTIONS]);
    const segs = b.segs();
    segs.forEach((seg, i) => {
      expect(left(seg)).toBeCloseTo(i * 100, 6);
      expect(widthOf(seg)).toBeCloseTo(100, 6);
      expect(seg.dataset.alt).toBe(String(i % 2));
    });
    expect(b.nav.hasAttribute('data-overflow')).toBe(false);
    expect(b.slider.getAttribute('aria-valuemin')).toBe('0');
    expect(b.slider.getAttribute('aria-valuemax')).toBe('128');
    expect(b.nav.querySelector('.strip-tray').hidden).toBe(true);
  });

  test('segments overflow at the 56 px floor; the strip scrolls and keeps the current segment in view', async () => {
    const b = await bed({tempo: manySections()});
    expect(b.segs()).toHaveLength(32);
    for (const seg of b.segs()) expect(widthOf(seg)).toBeCloseTo(MIN_SEGMENT_PX, 6);
    expect(parseFloat(b.nav.querySelector('.strip-content').style.width)).toBeCloseTo(32 * 56, 6);
    expect(b.nav.hasAttribute('data-overflow')).toBe(true);
    const scrolls = [];
    b.track.scrollTo = (opts) => { scrolls.push(opts.left); b.track.scrollLeft = opts.left; };
    b.ts.transport.cue(100);   // Part 26 (100–104 s) at x 1400–1456
    await settle();
    expect(b.segs()[25].hasAttribute('data-current')).toBe(true);
    expect(scrolls.at(-1)).toBeCloseTo(1456 - WIDTH, 6);
    // A segment already in view does not scroll.
    b.ts.transport.cue(98);
    await settle();
    expect(scrolls).toHaveLength(1);
  });

  test('the current segment gets --now-soft (data-current) and a 2 px progress fill; the playhead follows while playing', async () => {
    const b = await bed({practice: practiceOf({cue: 20})});
    const segs = b.segs();
    expect(segs[1].hasAttribute('data-current')).toBe(true);
    expect(segs.filter((s) => s.hasAttribute('data-current'))).toHaveLength(1);
    const progress = segs[1].querySelector('.strip-seg-progress');
    expect(progress.style.transform).toBe('scaleX(0.25)');
    const playhead = b.nav.querySelector('.strip-playhead');
    expect(translateX(playhead)).toBeCloseTo(125, 6);
    expect(playhead.hasAttribute('data-volatile')).toBe(true);
    await b.ts.play();
    await b.ts.advance(2);
    expect(translateX(playhead)).toBeGreaterThan(130);
    expect(Number(/scaleX\(([\d.]+)\)/.exec(progress.style.transform)[1])).toBeGreaterThan(0.3);
  });

  test('stopped: a tap cues the segment start; a double-tap loops the section', async () => {
    const b = await bed();
    mouseTap(b.slider, 250);          // Chorus (32–48)
    expect(b.snap.cue).toBe(32);
    expect(b.snap.phase).toBe('stopped');
    await vi.advanceTimersByTimeAsync(400);
    touchTap(b.slider, 350);          // Verse 2 (48–64)
    touchTap(b.slider, 352);
    expect(b.snap.loop).toMatchObject({on: true, a: 48, b: 64});
    expect(b.snap.cue).toBe(48);
    const loop = b.nav.querySelector('.strip-loop');
    expect(loop.hidden).toBe(false);
    expect(left(loop)).toBeCloseTo(300, 6);
    expect(widthOf(loop)).toBeCloseTo(100, 6);
  });

  test('playing: a tap is a quantized jump that labels its target "→ Verse 2"; a tap on it again cancels', async () => {
    const b = await bed({practice: practiceOf({cue: 16})});
    await b.ts.play();
    await b.ts.advance(0.6);
    touchTap(b.slider, 350);          // Verse 2 at 48 s
    expect(b.snap.pendingJump).toMatchObject({t: 48, label: 'Verse 2'});
    const seg = b.segs()[3];
    expect(seg.hasAttribute('data-pending')).toBe(true);
    expect(seg.querySelector('.strip-seg-label').textContent).toBe('→ Verse 2');
    await vi.advanceTimersByTimeAsync(400);
    touchTap(b.slider, 340);          // the same segment: cancel
    expect(b.snap.pendingJump).toBeNull();
    expect(seg.hasAttribute('data-pending')).toBe(false);
    expect(seg.querySelector('.strip-seg-label').textContent).toBe('Verse 2');
    // A mouse click behaves the same; the jump lands on the next downbeat and the label clears.
    await vi.advanceTimersByTimeAsync(400);
    mouseTap(b.slider, 450);          // Chorus 2 at 64 s
    expect(b.snap.pendingJump).toMatchObject({t: 64, label: 'Chorus 2'});
    expect(b.snap.cue).toBe(16);
    await b.ts.advance(2.2);
    expect(b.snap.pendingJump).toBeNull();
    expect(b.ts.transport.position()).toBeGreaterThanOrEqual(64);
    expect(b.ts.transport.position()).toBeLessThan(66);
    expect(b.segs()[4].hasAttribute('data-current')).toBe(true);
    expect(b.labels()[4]).toBe('Chorus 2');
  });

  test('live markers on a mapped song show as ticks over the sections (until they are turned into sections)', async () => {
    const b = await bed({practice: practiceOf({markers: [{id: 'm1', t: 40, label: 'Fill', updatedAt: 1}, {id: 'm2', t: 90, label: 'x', updatedAt: 1, deleted: true}]})});
    const ticks = [...b.nav.querySelectorAll('.strip-tick')];
    expect(ticks).toHaveLength(1);
    expect(ticks[0].dataset.id).toBe('m1');
    expect(left(ticks[0])).toBeCloseTo(250, 6);
  });

  test('overlays: cue flag, spot diamonds, loop bracket, viewport bracket (dragging it reports a new window)', async () => {
    const viewport = signal({t0: 16, t1: 32});
    const windows = [];
    const b = await bed({
      viewport, onViewport: (v) => { windows.push(v); viewport.value = v; },
      practice: practiceOf({cue: 40, loop: {on: true, a: 64, b: 80},
        spots: [{id: 's1', name: 'Fill', a: 96, b: 112, rate: 0.8, passes: 0, updatedAt: 1}, {id: 's2', name: 'gone', a: 8, b: 12, rate: 1, passes: 0, updatedAt: 1, deleted: true}]}),
    });
    expect(translateX(b.nav.querySelector('.strip-cue'))).toBeCloseTo(250, 6);
    const spots = [...b.nav.querySelectorAll('.strip-spot')];
    expect(spots.map((s) => s.dataset.id)).toEqual(['s1']);
    expect(left(spots[0])).toBeCloseTo(600, 6);
    const loop = b.nav.querySelector('.strip-loop');
    expect([left(loop), widthOf(loop)]).toEqual([400, 100]);
    const view = b.nav.querySelector('.strip-viewport');
    expect(view.hidden).toBe(false);
    expect([left(view), widthOf(view)]).toEqual([100, 100]);
    expect(view.hasAttribute('data-press-ignore')).toBe(true);
    pointer(view, 'pointerdown', {x: 150, y: 20, pointerType: 'mouse'});
    pointer(view, 'pointermove', {x: 200, y: 20, pointerType: 'mouse'});
    pointer(view, 'pointerup', {x: 200, y: 20, pointerType: 'mouse'});
    expect(windows.at(-1)).toEqual({t0: 24, t1: 40});
    expect(left(view)).toBeCloseTo(150, 6);
    // Pressing the bracket is not a tap on the strip.
    expect(b.snap.cue).toBe(40);
    viewport.value = null;
    expect(view.hidden).toBe(true);
  });

  test('a mouse drag makes a loop across segments, and the bracket springs to the snapped edges', async () => {
    const b = await bed();
    mouseDrag(b.slider, 130, 270);    // Verse (16–32) → Chorus (32–48)
    expect(b.snap.loop).toMatchObject({on: true, a: 16, b: 48});
    const loop = b.nav.querySelector('.strip-loop');
    expect(loop.hasAttribute('data-spring')).toBe(true);
    expect([left(loop), widthOf(loop)]).toEqual([100, 200]);
    vi.advanceTimersByTime(SPRING_MS + 1);
    expect(loop.hasAttribute('data-spring')).toBe(false);
    // Dragging backwards works too, and is allowed while playing.
    await b.ts.play();
    mouseDrag(b.slider, 690, 520);
    expect(b.snap.loop).toMatchObject({on: true, a: 80, b: 112});
    expect(b.snap.phase).toBe('playing');
  });

  test('a touch long-press then drag makes a loop; a long-press released without a drag never cues', async () => {
    const b = await bed();
    pointer(b.slider, 'pointerdown', {x: 120, y: 20, pointerType: 'touch', pointerId: 3});
    vi.advanceTimersByTime(360);
    for (const x of [140, 200, 280]) pointer(b.slider, 'pointermove', {x, y: 22, pointerType: 'touch', pointerId: 3});
    pointer(b.slider, 'pointerup', {x: 280, y: 22, pointerType: 'touch', pointerId: 3});
    expect(b.snap.loop).toMatchObject({on: true, a: 16, b: 48});
    b.ts.transport.clearLoop();
    b.ts.transport.cue(0);
    pointer(b.slider, 'pointerdown', {x: 520, y: 20, pointerType: 'touch', pointerId: 4});
    vi.advanceTimersByTime(400);
    pointer(b.slider, 'pointerup', {x: 520, y: 20, pointerType: 'touch', pointerId: 4});
    await settle();
    expect(b.snap.cue).toBe(0);
    expect(b.snap.loop.on).toBe(false);
  });

  test('a stopped touch drag scrubs with a "Bar 41 · Bridge" label and cues the bar on release', async () => {
    const scrubs = [];
    const b = await bed({onScrub: (t) => scrubs.push(t)});
    pointer(b.slider, 'pointerdown', {x: 470, y: 20, pointerType: 'touch', pointerId: 5});
    pointer(b.slider, 'pointermove', {x: 490, y: 20, pointerType: 'touch', pointerId: 5});
    pointer(b.slider, 'pointermove', {x: 506, y: 20, pointerType: 'touch', pointerId: 5});   // 80.96 s: bar 41, Bridge
    const label = b.nav.querySelector('.strip-scrub');
    expect(label.hidden).toBe(false);
    expect(label.textContent).toBe('Bar 41 · Bridge');
    expect(b.nav.hasAttribute('data-scrubbing')).toBe(true);
    expect(scrubs.at(-1)).toBeCloseTo(80.96, 6);
    expect(translateX(b.nav.querySelector('.strip-playhead'))).toBeCloseTo(506, 6);
    expect(b.snap.cue).toBe(0);       // nothing is cued until the finger lifts
    pointer(b.slider, 'pointerup', {x: 506, y: 20, pointerType: 'touch', pointerId: 5});
    expect(b.snap.cue).toBe(80);
    expect(label.hidden).toBe(true);
    // A cancelled scrub cues nothing.
    pointer(b.slider, 'pointerdown', {x: 100, y: 20, pointerType: 'touch', pointerId: 6});
    pointer(b.slider, 'pointermove', {x: 140, y: 20, pointerType: 'touch', pointerId: 6});
    pointer(b.slider, 'pointercancel', {x: 140, y: 20, pointerType: 'touch', pointerId: 6});
    expect(b.snap.cue).toBe(80);
  });

  test('while playing a touch drag is left to the browser (it scrolls the strip): no scrub, no cue', async () => {
    const b = await bed();
    await b.ts.play();
    expect(b.nav.hasAttribute('data-playing')).toBe(true);
    pointer(b.slider, 'pointerdown', {x: 600, y: 20, pointerType: 'touch', pointerId: 5});
    pointer(b.slider, 'pointermove', {x: 640, y: 20, pointerType: 'touch', pointerId: 5});
    pointer(b.slider, 'pointerup', {x: 640, y: 20, pointerType: 'touch', pointerId: 5});
    expect(b.nav.querySelector('.strip-scrub').hidden).toBe(true);
    expect(b.snap.pendingJump).toBeNull();
    expect(b.snap.cue).toBe(0);
  });
});

describe('keyboard: the stage.strip focus scope (D45)', () => {
  test('aria-valuetext follows the position; ←/→ rove the segments; Enter plays and L loops the focused one', async () => {
    const b = await bed({practice: practiceOf({cue: 23})});
    expect(b.slider.getAttribute('aria-valuetext')).toBe('Bar 12, beat 3, Verse');
    expect(b.slider.getAttribute('aria-valuenow')).toBe('23');
    document.documentElement.dataset.place = 'stage';
    document.documentElement.dataset.posture = 'stage';
    const stop = startDispatcher({registry: b.reg, platform: 'win'});
    current.push(() => stop());
    b.slider.focus();
    expect(b.reg.context().focused).toMatchObject({kind: 'section', t0: 16, t1: 32, label: 'Verse'});
    keydown('ArrowRight', {target: b.slider});
    expect(b.slider.getAttribute('aria-valuetext')).toBe('Bar 17, beat 1, Chorus');
    expect(b.reg.context().focused).toMatchObject({kind: 'section', t0: 32, t1: 48, label: 'Chorus'});
    expect(b.nav.querySelector('.strip-focus').hidden).toBe(false);
    expect(left(b.nav.querySelector('.strip-focus'))).toBeCloseTo(200, 6);
    keydown('KeyL', {target: b.slider});
    expect(b.snap.loop).toMatchObject({on: true, a: 32, b: 48});
    keydown('End', {target: b.slider});
    expect(b.reg.context().focused.label).toBe('Outro');
    keydown('Home', {target: b.slider});
    keydown('ArrowLeft', {target: b.slider});
    expect(b.reg.context().focused.label).toBe('Intro');
    keydown('ArrowRight', {target: b.slider});
    keydown('ArrowRight', {target: b.slider});
    b.ts.transport.clearLoop();
    keydown('Enter', {target: b.slider});
    await settle();
    expect(b.snap.phase).toBe('playing');
    expect(b.ts.transport.position()).toBeCloseTo(32, 1);
    // Leaving the strip withdraws the focused item.
    b.slider.blur();
    expect(b.reg.context().focused ?? null).toBeNull();
  });

  test('← from inside a segment goes to its start first', async () => {
    const b = await bed({practice: practiceOf({cue: 40})});
    b.slider.focus();
    keydown('ArrowLeft', {target: b.slider});
    expect(b.reg.context().focused.label).toBe('Chorus');
    expect(b.slider.getAttribute('aria-valuetext')).toBe('Bar 17, beat 1, Chorus');
    keydown('ArrowLeft', {target: b.slider});
    expect(b.reg.context().focused.label).toBe('Verse');
  });

  test('mapped without sections the keys rove bars; a pickup reads "Pickup"', async () => {
    const b = await bed({tempo: tempoOf(pickup), duration: pickup.duration, practice: practiceOf({cue: 0.6})});
    expect(b.nav.dataset.mode).toBe('wave');
    expect(b.slider.getAttribute('aria-valuetext')).toMatch(/^Pickup, beat \d$/);
    b.slider.focus();
    expect(b.reg.context().focused).toMatchObject({kind: 'bar', label: 'Pickup', bar: null});
    keydown('ArrowRight', {target: b.slider});
    expect(b.reg.context().focused).toMatchObject({kind: 'bar', t0: 1.5, t1: 3.5, bar: 1, label: 'Bar 1'});
    expect(b.slider.getAttribute('aria-valuetext')).toBe('Bar 1, beat 1');
  });
});

describe('unmapped', () => {
  const markers = [{id: 'm1', t: 12, label: 'Groove', updatedAt: 1}, {id: 'm2', t: 60, label: 'Marker 2', updatedAt: 1}];

  test('the full-song waveform with marker ticks and the "No bar grid · Get bars →" chip', async () => {
    const b = await bed({mapped: false, practice: practiceOf({markers})});
    expect(b.nav.dataset.mode).toBe('wave');
    expect(b.nav.hasAttribute('data-mapped')).toBe(false);
    expect(b.segs()).toHaveLength(0);
    const canvas = b.nav.querySelector('canvas.strip-wave');
    expect(canvas.hidden).toBe(false);
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    const ticks = [...b.nav.querySelectorAll('.strip-tick')];
    expect(ticks.map((t) => t.dataset.id)).toEqual(['m1', 'm2']);
    expect(left(ticks[0])).toBeCloseTo(12 / 128 * WIDTH, 6);
    const tray = b.nav.querySelector('.strip-tray');
    expect(tray.hidden).toBe(false);
    expect(tray.textContent.replace(/\s+/g, ' ')).toContain('No bar grid');
    const get = [...tray.querySelectorAll('button')];
    expect(get).toHaveLength(1);
    get[0].click();
    expect(b.ran).toEqual(['stage.getBars']);
  });

  test('the waveform is drawn from the session peaks once they exist, and again on a theme change', async () => {
    const b = await bed({mapped: false});
    const canvas = b.nav.querySelector('canvas.strip-wave');
    setRect(b.slider, {x: 0, y: 0, width: WIDTH, height: 56});
    triggerResize(b.track);
    expect(b.ts.session.peaks.ready).toBe(true);
    expect(canvas.dataset.peaksReady).toBe('true');
    expect(canvas.style.width).toBe(`${WIDTH}px`);
    expect(canvas.style.height).toBe('56px');
    const ctx = contextOf(canvas);
    const fills = () => ctx.calls.filter((c) => c.name === 'fill').length;
    const before = fills();
    expect(before).toBeGreaterThan(0);
    window.dispatchEvent(new window.Event('woodshed:theme'));
    expect(fills()).toBeGreaterThan(before);
  });

  test('a read-only (shared) song shows "No bar grid" without the Get bars action', async () => {
    const b = await bed({mapped: false, shared: {token: 'share-1'}});
    const tray = b.nav.querySelector('.strip-tray');
    expect(tray.textContent).toContain('No bar grid');
    expect(tray.querySelectorAll('button')).toHaveLength(0);
  });

  test('no string the strip produces for an unmapped song says "Bar" (apart from the "No bar grid" chip)', async () => {
    const b = await bed({mapped: false, practice: practiceOf({cue: 72, markers, spots: [{id: 's1', name: 'Hook', a: 20, b: 30, rate: 1, passes: 0, updatedAt: 1}]})});
    const check = (label) => {
      const text = strings(b.nav).map((s) => s.replaceAll(COPY.noGrid, ''));
      for (const s of text) {
        expect(s, label).not.toMatch(/Bar/);
        expect(s, label).not.toMatch(/bar /);
      }
    };
    check('stopped');
    expect(b.slider.getAttribute('aria-valuetext')).toBe('1:12, Marker 2');
    b.slider.focus();
    keydown('ArrowRight', {target: b.slider});
    check('keyboard');
    pointer(b.slider, 'pointerdown', {x: 300, y: 20, pointerType: 'touch', pointerId: 9});
    pointer(b.slider, 'pointermove', {x: 340, y: 20, pointerType: 'touch', pointerId: 9});
    expect(b.nav.querySelector('.strip-scrub').textContent).toBe('0:54 · Groove');
    check('scrubbing');
    pointer(b.slider, 'pointerup', {x: 340, y: 20, pointerType: 'touch', pointerId: 9});
    expect(b.snap.cue).toBeCloseTo(340 / WIDTH * 128, 6);
    await b.ts.play();
    mouseTap(b.slider, 100);
    check('playing');
  });

  test('keys rove the marker regions (a leading "Start" before the first); without markers, 5 s steps', async () => {
    const b = await bed({mapped: false, practice: practiceOf({markers})});
    b.slider.focus();
    expect(b.reg.context().focused).toMatchObject({kind: 'marker', t0: 0, t1: 12, label: 'Start'});
    keydown('ArrowRight', {target: b.slider});
    expect(b.reg.context().focused).toMatchObject({kind: 'marker', t0: 12, t1: 60, label: 'Groove'});
    expect(b.slider.getAttribute('aria-valuetext')).toBe('0:12, Groove');
    const c = await bed({mapped: false});
    c.slider.focus();
    keydown('ArrowRight', {target: c.slider});
    keydown('ArrowRight', {target: c.slider});
    expect(c.reg.context().focused).toMatchObject({kind: 'marker', t0: 10, t1: 15, label: '0:10'});
    keydown('End', {target: c.slider});
    expect(c.reg.context().focused.t0).toBe(125);
  });

  test('stopped taps cue the tapped time; playing taps jump at once; a double-tap loops the marker region', async () => {
    const b = await bed({mapped: false, practice: practiceOf({markers})});
    mouseTap(b.slider, 200);                  // 32 s
    expect(b.snap.cue).toBeCloseTo(32, 6);
    await vi.advanceTimersByTimeAsync(400);
    touchTap(b.slider, 250);
    touchTap(b.slider, 251);                  // 40 s: inside Groove (12–60)
    expect(b.snap.loop).toMatchObject({on: true, a: 12, b: 60});
    b.ts.transport.clearLoop();
    await vi.advanceTimersByTimeAsync(400);
    await b.ts.play();
    touchTap(b.slider, 600);                  // 96 s
    expect(b.snap.pendingJump).toBeNull();
    expect(b.ts.transport.position()).toBeCloseTo(96, 1);
  });

  test('a mouse drag makes a loop snapped to 0.1 s', async () => {
    const b = await bed({mapped: false});
    mouseDrag(b.slider, 101, 203);
    expect(b.snap.loop.on).toBe(true);
    expect(b.snap.loop.a).toBeCloseTo(16.2, 6);
    expect(b.snap.loop.b).toBeCloseTo(32.5, 6);
  });
});

describe('suggested sections (D47)', () => {
  const suggestion = {jobId: 'job-9', createdAt: 1, sections: [
    {t0: 0, label: 'Intro', confidence: 0.6}, {t0: 16, label: 'Verse', confidence: 0.7}, {t0: 48, label: 'Chorus', confidence: 0.8},
  ]};

  test('drawn as dashed blocks with an inline [Keep all] [Review]; Keep all turns them into sections (one undo step)', async () => {
    const b = await bed({tempo: unlabelled(), sectionSuggestion: suggestion});
    expect(b.nav.dataset.mode).toBe('wave');
    const blocks = [...b.nav.querySelectorAll('.strip-suggest-block')];
    expect(blocks.map((n) => n.textContent)).toEqual(['Intro', 'Verse', 'Chorus']);
    expect([left(blocks[1]), widthOf(blocks[1])]).toEqual([100, 200]);
    expect(widthOf(blocks[2])).toBeCloseTo(500, 6);
    const tray = b.nav.querySelector('.strip-tray');
    expect(b.nav.dataset.tray).toBe('suggestion');
    expect(tray.getAttribute('role')).toBe('group');
    expect(tray.getAttribute('aria-label')).toBe('Suggested sections');
    expect(tray.textContent).toContain('Suggested');
    const [keep, review] = tray.querySelectorAll('button');
    review.click();
    expect(b.ts.navigations.at(-1)).toMatch(/\/edit\/map\?review=sections$/);
    keep.click();
    await settle();
    expect(b.ran).toEqual(['sections.review', 'sections.keepAll']);
    expect(b.nav.dataset.mode).toBe('sections');
    expect(b.labels()).toEqual(['Intro', 'Verse', 'Chorus']);
    expect(b.nav.querySelectorAll('.strip-suggest-block')).toHaveLength(0);
    expect(b.nav.querySelector('.strip-tray').hidden).toBe(true);
    b.ts.undo.undo();
    await settle();
    expect(b.ts.map.hasSections).toBe(false);
  });

  test('a song without a suggestion shows no blocks and no chip', async () => {
    const b = await bed({tempo: unlabelled()});
    expect(b.nav.querySelectorAll('.strip-suggest-block')).toHaveLength(0);
    expect(b.nav.querySelector('.strip-tray').hidden).toBe(true);
  });
});

describe('inline rename', () => {
  test('mapped: writes the bar label as one practice-undo step; Escape cancels', async () => {
    const b = await bed();
    const chorus = b.ts.position.regions()[2];
    expect(b.strip.rename(chorus)).toBe(true);
    const input = b.host.querySelector('input.strip-rename');
    expect(input.value).toBe('Chorus');
    expect(input.getAttribute('aria-label')).toBe('Rename Chorus');
    expect(document.activeElement).toBe(input);
    expect(b.nav.hasAttribute('data-renaming')).toBe(true);
    input.value = 'Hook';
    keydown('Enter', {target: input});
    await settle();
    expect(b.host.querySelector('input.strip-rename')).toBeNull();
    expect(b.labels()[2]).toBe('Hook');
    expect(b.ts.map.bars[16].label).toBe('Hook');
    expect(document.activeElement).toBe(b.slider);
    b.ts.undo.undo();
    await settle();
    expect(b.labels()[2]).toBe('Chorus');
    // Escape leaves the name alone.
    b.strip.rename(b.ts.position.regions()[0]);
    const again = b.host.querySelector('input.strip-rename');
    again.value = 'Count-off';
    keydown('Escape', {target: again});
    expect(b.labels()[0]).toBe('Intro');
  });

  test('unmapped: renames the marker (undoable); a read-only song cannot rename sections', async () => {
    const b = await bed({mapped: false, practice: practiceOf({markers: [{id: 'm1', t: 12, label: 'Groove', updatedAt: 1}]})});
    const region = b.ts.position.regions()[0];
    expect(b.strip.rename(region)).toBe(true);
    const input = b.host.querySelector('input.strip-rename');
    input.value = 'Big groove';
    input.blur();
    expect(b.ts.value.markers[0].label).toBe('Big groove');
    b.ts.undo.undo();
    expect(b.ts.value.markers[0].label).toBe('Groove');
    const shared = await bed({shared: {token: 'share-2'}});
    expect(shared.strip.rename(shared.ts.position.regions()[1])).toBe(false);
  });
});

describe('the section menu (menus.sectionMenu, ST8a)', () => {
  test.skipIf(HAS_MENUS)('before ST8a lands, a long-press or right-click opens nothing and changes nothing', async () => {
    const b = await bed();
    pointer(b.slider, 'pointerdown', {x: 250, y: 20, pointerType: 'touch', pointerId: 2});
    vi.advanceTimersByTime(400);
    pointer(b.slider, 'pointerup', {x: 250, y: 20, pointerType: 'touch', pointerId: 2});
    b.slider.dispatchEvent(new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 250, clientY: 20, button: 2}));
    await settle();
    expect(document.querySelector('[role=menu]')).toBeNull();
    expect(b.snap.cue).toBe(0);
  });

  test.runIf(HAS_MENUS)('a long-press (350 ms) and a right-click open sectionMenu(session, region) at the press point', async () => {
    const b = await bed();
    pointer(b.slider, 'pointerdown', {x: 250, y: 20, pointerType: 'touch', pointerId: 2});
    vi.advanceTimersByTime(360);
    pointer(b.slider, 'pointerup', {x: 250, y: 20, pointerType: 'touch', pointerId: 2});
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector('[role=menu]')).not.toBeNull();
  });
});

test('destroy removes the strip, its listeners and its focused provider', async () => {
  const b = await bed();
  b.slider.focus();
  expect(b.reg.context().focused).toBeTruthy();
  b.strip.destroy();
  expect(b.host.querySelector('nav')).toBeNull();
  expect(b.reg.context().focused ?? null).toBeNull();
  b.strip.destroy();
});
