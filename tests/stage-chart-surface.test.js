// @vitest-environment happy-dom
// The Chart surface (src/stage/surfaces/chart-surface.js; architecture §2.14.12, spec §4.4A, §4.9,
// §4.11, D54) on a real song session with a real drum part (tests/helpers/test-session.js): the
// SongMapStore, transport, practice state and notation session are real. The alphaTab chart
// (src/js/notation/chart.js, ST3) is replaced by a recording stand-in with the same API, so these
// tests assert what the surface asks of the chart; engraving, sizes and colours are Playwright
// states (tests/fixture/states/ST9.cjs). Keys go through the real dispatcher.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));
vi.mock('../src/js/notation/score-view.js', () => ({createScoreView: () => { throw new Error('the chart stand-in never engraves'); }}));

const fake = vi.hoisted(() => {
  const charts = [];
  const SCALE_MIN = 0.8, SCALE_MAX = 2;
  /** A recording stand-in for chart.js createChart (§2.14.12 API). */
  function createChart(options) {
    const {host} = options;
    const calls = [];
    const record = (name, ...args) => calls.push([name, ...args]);
    const scoreHost = document.createElement('div');
    scoreHost.className = 'chart-score';
    const scroller = document.createElement('div');
    scroller.className = 'chart-scroll';
    scroller.append(scoreHost);
    host.classList.add('chart');
    host.hidden = true;
    host.replaceChildren(scroller);
    const state = {
      scale: options.scale, floors: {...options.fonts}, followStyle: options.followStyle, followAnchor: options.followAnchor,
      glass: !!options.glass, follow: true, visible: false, layout: options.display?.layout ?? null,
      barsPerRow: options.display?.barsPerRow ?? -1, revision: 0, loop: null,
    };
    const chart = {
      host, options, calls, state, relayoutMs: 40, anchorIndex: 0,
      relayout() { state.revision += 1; options.onRelayout?.({ms: chart.relayoutMs, bars: 64}); },
      setVisible(on) { state.visible = !!on; host.hidden = !on; record('setVisible', !!on); if (on && !state.revision) state.revision = 1; },
      tick(t) { record('tick', t); },
      refresh() { record('refresh'); },
      destroy() { record('destroy'); host.replaceChildren(); chart.destroyed = true; },
      setScale(v) { const n = Math.min(SCALE_MAX, Math.max(SCALE_MIN, v)); record('setScale', n); if (n !== state.scale) { state.scale = n; chart.relayout(); } },
      previewScale(f, at) { record('previewScale', f, at); },
      // Like chart.js: setDisplay and setFonts each relayout once when they change anything.
      setDisplay(next) {
        record('setDisplay', next);
        let changed = false;
        if ('layout' in next && next.layout !== state.layout) { state.layout = next.layout; changed = true; }
        if ('barsPerRow' in next && next.barsPerRow !== state.barsPerRow) { state.barsPerRow = next.barsPerRow; changed = true; }
        if (changed && state.revision) chart.relayout();
      },
      setFonts(next) {
        record('setFonts', next);
        const changed = next.barNumber !== state.floors.barNumber || next.marker !== state.floors.marker;
        state.floors = {...next};
        if (changed) chart.relayout();
      },
      // Like chart.js (ST3, I2b-2): scale, floors and bars per system in one relayout; true when one started.
      configure(next, opts) {
        record('configure', next, opts);
        let changed = false;
        if ('scale' in next) { const n = Math.min(SCALE_MAX, Math.max(SCALE_MIN, next.scale)); if (n !== state.scale) { state.scale = n; changed = true; } }
        if ('fonts' in next) {
          if (next.fonts.barNumber !== state.floors.barNumber || next.fonts.marker !== state.floors.marker) changed = true;
          state.floors = {...next.fonts};
        }
        if ('barsPerRow' in next && next.barsPerRow !== state.barsPerRow) { state.barsPerRow = next.barsPerRow; changed = true; }
        if (!changed || !state.revision) return false;
        chart.relayout();
        return true;
      },
      setFollowStyle(style, {anchor} = {}) { record('setFollowStyle', style, anchor); state.followStyle = style; if (anchor) state.followAnchor = anchor; },
      setFollow(on) { record('setFollow', !!on); if (state.follow !== !!on) { state.follow = !!on; options.onFollowChange(!!on); } },
      setLoopRange(range) { record('setLoopRange', range); state.loop = range; },
      setGlass(on) { record('setGlass', !!on); state.glass = !!on; },
      reveal(t, o) { record('reveal', t, o); },
      anchorBar() { return chart.anchorIndex; },
      barAtPoint() { return null; },
      // Test controls: what the chart would report.
      userScroll() { if (state.follow) { state.follow = false; options.onFollowChange(false); } },
    };
    Object.defineProperty(chart, 'state', {get: () => ({...state, floors: {...state.floors}})});
    chart.raw = state;
    charts.push(chart);
    return chart;
  }
  const fake = {charts, fail: null};
  fake.createChart = (options) => {
    if (fake.fail) { const err = fake.fail; fake.fail = null; throw err; }
    return createChart(options);
  };
  return fake;
});
vi.mock('../src/js/notation/chart.js', async (importOriginal) => ({...(await importOriginal()), createChart: fake.createChart}));

import {createRegistry} from '../src/app/commands.js';
import {startDispatcher} from '../src/app/dispatch.js';
import {clock as appClock} from '../src/app/clock.js';
import {prefs} from '../src/app/prefs.js';
import {signal, readonly} from '../src/app/store.js';
import {defineTransportCommands} from '../src/stage/transport-commands.js';
import {SCALE_STEPS} from '../src/js/notation/chart.js';
import {
  COPY, CONTROLS, DENSE_HITS, FOLLOW_ANCHOR, IDLE_RESUME_MS, LIVE_RELAYOUT_MS, SETTLE_MS,
  barsPerSystem, createChartSurface, createRelayoutGate, followAnchorFor, fontsFor, isDense, scaleFor,
} from '../src/stage/surfaces/chart-surface.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {keydown, pointer, restoreDomShims} from './helpers/dom.js';
import {demoScore} from './fixtures/drum-score.js';

let clock, restoreAudio, current = [];

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(Date.parse('2026-10-28T12:00:00Z'));
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
  fake.charts.length = 0;
  prefs.update((d) => { d.practice.distance = 'stand'; d.chart = {display: {layout: null}, pinchScale: null, pinchDistance: null}; });
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

/** A ⌘/Ctrl wheel event (happy-dom's WheelEvent drops the modifier keys from its init). */
function ctrlWheel(deltaY) {
  const event = new WheelEvent('wheel', {bubbles: true, cancelable: true, deltaY, clientX: 10, clientY: 10});
  Object.defineProperty(event, 'ctrlKey', {value: true});
  Object.defineProperty(event, 'deltaY', {value: deltaY});
  Object.defineProperty(event, 'deltaMode', {value: 0});
  return event;
}

/** A light part: a few hits per bar (not dense). */
function sparseScore(seconds = 128) {
  const score = demoScore(seconds, 120);
  for (const bar of score.bars) bar.hits = bar.hits.slice(0, 3);
  return score;
}

/** The Stage's 'stage' context as the surface reads it. */
function stageApi({layout = 'rail', distance = 'stand', display = null, followStyle} = {}) {
  const sig = {layout: signal(layout), distance: signal(distance), display: signal(display), followStyle: signal(followStyle ?? (layout === 'rail' ? 'scroll' : 'page'))};
  return {layout: readonly(sig.layout), distance: readonly(sig.distance), display: readonly(sig.display), followStyle: readonly(sig.followStyle), sig};
}

/** A session with a drum part, the surface on it, and everything the Stage would pass. */
async function bed({score = demoScore(128, 120), layout = 'rail', distance = 'stand', readOnly = false, mapped = true, stageOpts = {}, session: sessionOpts = {}, router, surfaceOpts = {}} = {}) {
  const ts = await createTestSession({clock, ...(score ? {score} : {}), mapped, ...(readOnly ? {shared: {token: 'share-1'}} : {}), ...sessionOpts});
  await ts.session.notation.ready;
  const reg = createRegistry();
  const offTransport = defineTransportCommands({registry: reg});
  const ran = [];
  reg.register({id: 'map.find', title: 'Find a chart…', group: 'Map', run: () => { ran.push('map.find'); }});
  reg.register({id: 'edit.chart', title: 'Edit drum chart', group: 'Edit', run: () => { ran.push('edit.chart'); }});
  reg.provide('session', () => ts.session);
  reg.provide('transport', () => ts.session.transport);
  const stage = stageApi({layout, distance, ...stageOpts});
  const log = {activate: [], loopEdits: [], follows: [], statuses: []};
  const host = document.createElement('div');
  document.body.append(host);
  const surface = await createChartSurface(host, {
    session: ts.session, stage, layout, distance, registry: reg, router,
    onActivate: (e) => log.activate.push(e),
    onLoopEdit: (e) => { log.loopEdits.push(e); if (e.phase === 'commit') ts.session.transport.loopRange(e.a, e.b, {snap: 'none'}); },
    onFollowChange: (on) => log.follows.push(on),
    status: (text, options) => log.statuses.push([text, options]),
    ...surfaceOpts,
  });
  await settle();
  const chart = fake.charts.at(-1);
  current.push(async () => { surface?.destroy(); offTransport(); await ts.dispose(); });
  return {ts, reg, stage, host, surface, chart, log, ran, root: host.querySelector('.chart-surface'),
    calls: (name) => chart.calls.filter((c) => c[0] === name)};
}

describe('pure rules', () => {
  test('a part is dense above 8 hits per notated bar; dense parts get 2 bars per system on the band and 4 on the rail', () => {
    const bar = (n) => ({hits: Array.from({length: n}, () => ({}))});
    expect(DENSE_HITS).toBe(8);
    expect(isDense({bars: [bar(8), bar(8)]})).toBe(false);
    expect(isDense({bars: [bar(9), bar(8)]})).toBe(true);
    expect(isDense({bars: [bar(12), bar(0), bar(0)]})).toBe(true);   // empty bars do not dilute the density
    expect(isDense(null)).toBe(false);
    expect(isDense(demoScore(128, 120))).toBe(true);
    expect(isDense(sparseScore())).toBe(false);
    expect(barsPerSystem({dense: true, layout: 'band'})).toBe(2);
    expect(barsPerSystem({dense: true, layout: 'rail'})).toBe(4);
    expect(barsPerSystem({dense: false, layout: 'rail'})).toBe(-1);
  });

  test('follow anchors, label floors and scales per Distance and layout (spec §4.4A, §4.11)', () => {
    expect(FOLLOW_ANCHOR).toEqual({band: 0.28, rail: 0.33});
    expect(followAnchorFor('band')).toBe(0.28);
    expect(followAnchorFor('rail')).toBe(0.33);
    const rows = [
      ['near', 'rail', 1.1, 11.2, 16], ['stand', 'rail', 1.3, 14, 20], ['kit', 'rail', 1.6, 18.2, 26],
      ['near', 'band', 1.0, 11.2, 16], ['stand', 'band', 1.2, 14, 20], ['kit', 'band', 1.5, 18.2, 26],
    ];
    for (const [distance, layout, scale, barNumber, marker] of rows) {
      expect(scaleFor({distance, layout, pinch: null})).toBeCloseTo(scale, 9);
      expect(fontsFor(distance).barNumber).toBeCloseTo(barNumber, 9);
      expect(fontsFor(distance).marker).toBeCloseTo(marker, 9);
    }
    expect(scaleFor({distance: 'kit', layout: 'rail', pinch: 0.9, pinchDistance: 'kit'})).toBe(0.9);
    expect(scaleFor({distance: 'kit', layout: 'rail', pinch: 3, pinchDistance: 'kit'})).toBe(2);
    expect(scaleFor({distance: 'kit', layout: 'rail', pinch: 0.5, pinchDistance: 'kit'})).toBe(0.8);
  });

  test('a pinch applies only at the Distance it was made at (I2b-3)', () => {
    expect(scaleFor({distance: 'stand', layout: 'rail', pinch: 1.8, pinchDistance: 'stand'})).toBe(1.8);
    expect(scaleFor({distance: 'kit', layout: 'rail', pinch: 1.8, pinchDistance: 'stand'})).toBeCloseTo(1.6, 9);
    expect(scaleFor({distance: 'near', layout: 'band', pinch: 1.8, pinchDistance: 'kit'})).toBeCloseTo(1.0, 9);
    // No Distance recorded (or not one of the three): not this Distance's pinch.
    for (const pinchDistance of [null, undefined, 'far', '']) {
      expect(scaleFor({distance: 'stand', layout: 'rail', pinch: 1.8, pinchDistance})).toBeCloseTo(1.3, 9);
    }
    // An unknown current Distance is Stand (layout.js distanceOf).
    expect(scaleFor({distance: 'huge', layout: 'rail', pinch: 1.8, pinchDistance: 'stand'})).toBe(1.8);
  });

  test('the D54 gate: live while the last two relayouts took ≤ 300 ms, else once 400 ms after the last request', () => {
    expect(LIVE_RELAYOUT_MS).toBe(300);
    expect(SETTLE_MS).toBe(400);
    const gate = createRelayoutGate();
    const applied = [];
    expect(gate.request(() => applied.push('a'))).toBe('now');
    gate.record(120); gate.record(310);
    expect(gate.live).toBe(false);
    expect(gate.request(() => applied.push('b'))).toBe('deferred');
    vi.advanceTimersByTime(300);
    expect(gate.request(() => applied.push('c'))).toBe('deferred');
    vi.advanceTimersByTime(399);
    expect(applied).toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(applied).toEqual(['a', 'c']);   // the steps coalesce into one apply
    gate.record(200);
    expect(gate.samples).toEqual([310, 200]);
    expect(gate.live).toBe(false);
    gate.record(250);
    expect(gate.live).toBe(true);
    expect(gate.request(() => applied.push('d'))).toBe('now');
    expect(applied).toEqual(['a', 'c', 'd']);
  });
});

describe('hosting the chart', () => {
  test('creates the chart lazily with the Distance scale, the label floors, the follow anchor and dense bars per system', async () => {
    const b = await bed({layout: 'rail', distance: 'stand'});
    const o = b.chart.options;
    expect(o.scale).toBeCloseTo(1.3, 9);
    expect(o.fonts).toEqual({barNumber: 14, marker: 20});
    expect(o.followAnchor).toBe(0.33);
    expect(o.followStyle).toBe('scroll');
    expect(o.display).toEqual({barsPerRow: 4});   // no layout key: the chart reads prefs chart.display.layout
    expect(o.part.hasNotation).toBe(true);
    expect(o.part.score).toBe(b.ts.session.notation.part.score);
    expect(b.surface.kind).toBe('chart');
    expect(b.root.querySelector('[data-scroller]')).toBe(b.chart.host.querySelector('.chart-scroll'));
    expect(b.chart.host.querySelector('.chart-score').hasAttribute('data-press-ignore')).toBe(true);
    expect(b.chart.state.visible).toBe(true);
    expect(b.root.dataset.state).toBe('chart');
  });

  test('band, Kit: 150 %, 18.2/26 px floors, the 0.28 anchor, Page follow and 2 bars per system', async () => {
    const b = await bed({layout: 'band', distance: 'kit'});
    const o = b.chart.options;
    expect(o.scale).toBeCloseTo(1.5, 9);
    expect(o.fonts.barNumber).toBeCloseTo(18.2, 9);
    expect(o.fonts.marker).toBeCloseTo(26, 9);
    expect(o.followAnchor).toBe(0.28);
    expect(o.followStyle).toBe('page');
    expect(o.display.barsPerRow).toBe(2);
  });

  test('a sparse part keeps automatic bars per system; a pinch override from this device wins over the Distance', async () => {
    prefs.update((d) => { d.chart.pinchScale = 1.45; d.chart.pinchDistance = 'stand'; });
    const b = await bed({score: sparseScore(), layout: 'rail'});
    expect(b.chart.options.display.barsPerRow).toBe(-1);
    expect(b.chart.options.scale).toBe(1.45);
  });

  test('a pinch made at another Distance (Settings, another surface) is ignored when the chart opens', async () => {
    prefs.update((d) => { d.chart.pinchScale = 1.45; d.chart.pinchDistance = 'kit'; });
    const b = await bed({layout: 'rail', distance: 'stand'});
    expect(b.chart.options.scale).toBeCloseTo(1.3, 9);
    expect(prefs.get('chart.pinchScale')).toBe(1.45);   // kept for Kit
  });

  test('frames move the playhead; while stopped, cue changes do too', async () => {
    const b = await bed();
    b.surface.frame({position: 12.5});
    expect(b.calls('tick').at(-1)).toEqual(['tick', 12.5]);
    b.ts.transport.cue(40);
    expect(b.calls('tick').at(-1)).toEqual(['tick', 40]);
  });

  test('setLoop, setGlass and reveal pass through; anchor() is the bar at the follow line', async () => {
    const b = await bed();
    b.surface.setLoop({a: 32, b: 48, aBar: 'x', bBar: 'y'});
    expect(b.calls('setLoopRange').at(-1)).toEqual(['setLoopRange', {a: 32, b: 48}]);
    b.surface.setLoop(null);
    expect(b.calls('setLoopRange').at(-1)).toEqual(['setLoopRange', null]);
    b.surface.setGlass(true);
    expect(b.chart.state.glass).toBe(true);
    b.surface.reveal(64, {smooth: true});
    expect(b.calls('reveal').at(-1)).toEqual(['reveal', 64, {smooth: true}]);
    b.chart.anchorIndex = 20;
    expect(b.surface.anchor()).toEqual({bar: 20, time: b.ts.session.map.bars[20].t0});
  });

  test('if the chart cannot be created, nothing is left in the Stage layer for its fallback to sit under', async () => {
    const ts = await createTestSession({clock, score: demoScore(128, 120)});
    await ts.session.notation.ready;
    current.push(() => ts.dispose());
    const host = document.createElement('div');
    document.body.append(host);
    fake.fail = new Error('alphaTab failed to start');
    await expect(createChartSurface(host, {session: ts.session, layout: 'band', registry: createRegistry()})).rejects.toThrow('alphaTab failed to start');
    expect(host.children).toHaveLength(0);
  });

  test('destroy() destroys the chart and removes the surface', async () => {
    const b = await bed();
    b.surface.destroy();
    expect(b.chart.destroyed).toBe(true);
    expect(b.host.querySelector('.chart-surface')).toBeNull();
    b.surface.destroy();   // idempotent
  });
});

describe('glass: the chart gestures reach the Stage', () => {
  test('taps, doubles, long-presses and right-clicks become onActivate with the time, the bar number and the pointer', async () => {
    const b = await bed();
    b.chart.options.onBarActivate({kind: 'tap', index: 20, barId: 'm', q: 80.5, time: 40.25, beatTime: 40, pointerType: 'touch', glass: true, clientX: 300, clientY: 200});
    expect(b.log.activate.at(-1)).toEqual({kind: 'tap', t: 40.25, bar: 21, beatTime: 40, index: 20, pointerType: 'touch', clientX: 300, clientY: 200});
    b.chart.options.onBarActivate({kind: 'context', index: 0, q: 0, time: 0, beatTime: 0, pointerType: 'mouse', clientX: 1, clientY: 2});
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'context', t: 0, bar: 1, pointerType: 'mouse'});
  });

  test('every loop commit is answered with setLoopRange from the transport', async () => {
    const b = await bed();
    b.chart.options.onLoopEdit({a: 32, b: 40, phase: 'preview'});
    expect(b.calls('setLoopRange')).toHaveLength(1);   // the initial loop only
    b.chart.options.onLoopEdit({a: 32, b: 40, aBar: 'a', bBar: 'b', phase: 'commit'});
    expect(b.log.loopEdits.map((e) => e.phase)).toEqual(['preview', 'commit']);
    await Promise.resolve();
    expect(b.calls('setLoopRange').at(-1)).toEqual(['setLoopRange', {a: 32, b: 40}]);
  });

  test('Shift+F10 and the ContextMenu key open the bar menu for the playing bar (press.js)', async () => {
    const b = await bed();
    b.ts.transport.cue(41);
    b.root.querySelector('[data-scroller]').tabIndex = -1;
    b.root.querySelector('[data-scroller]').focus();
    keydown('Shift+F10', {target: b.root.querySelector('[data-scroller]')});
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'context', t: 40, bar: 21, pointerType: 'mouse', keyboard: true});
    keydown('ContextMenu', {target: b.root.querySelector('[data-scroller]')});
    expect(b.log.activate).toHaveLength(2);
  });

  test('the menu keys on the surface\'s own buttons (the pill, Try again, the empty actions) open no bar menu', async () => {
    const b = await bed();
    b.chart.userScroll();
    const pillButton = b.root.querySelector('.chart-surface-follow button');
    pillButton.focus();
    keydown('Shift+F10', {target: pillButton});
    keydown('ContextMenu', {target: pillButton});
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    const action = document.createElement('button');
    empty.append(action);
    b.root.querySelector('.chart').append(empty);
    action.focus();
    keydown('Shift+F10', {target: action});
    expect(b.log.activate).toHaveLength(0);
  });

  test('a pointer contextmenu on the music is left to the chart (no second menu)', async () => {
    const b = await bed();
    const score = b.root.querySelector('.chart-score');
    score.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100, detail: 1}));
    expect(b.log.activate).toHaveLength(0);
  });
});

describe('pinch and size', () => {
  test('a two-finger pinch previews with a transform and commits one size change (80–200 %), stored for this device and Distance', async () => {
    const b = await bed();
    const el = b.root;
    pointer(el, 'pointerdown', {pointerType: 'touch', pointerId: 1, x: 100, y: 100, isPrimary: true});
    pointer(el, 'pointerdown', {pointerType: 'touch', pointerId: 2, x: 200, y: 100, isPrimary: false});
    pointer(el, 'pointermove', {pointerType: 'touch', pointerId: 2, x: 250, y: 100});
    const preview = b.calls('previewScale').at(-1);
    expect(preview[1]).toBeCloseTo(1.5, 6);
    expect(preview[2]).toEqual({clientX: 150, clientY: 100});
    pointer(el, 'pointermove', {pointerType: 'touch', pointerId: 2, x: 400, y: 100});
    expect(b.calls('previewScale').at(-1)[1]).toBeCloseTo(2 / 1.3, 6);   // clamped at 200 %
    pointer(el, 'pointerup', {pointerType: 'touch', pointerId: 2, x: 400, y: 100});
    expect(b.calls('previewScale').at(-1)).toEqual(['previewScale', null, undefined]);
    expect(b.calls('configure')).toHaveLength(1);
    expect(b.chart.state.scale).toBe(2);
    expect(b.calls('setScale')).toHaveLength(0);
    expect(prefs.get('chart.pinchScale')).toBe(2);
    expect(prefs.get('chart.pinchDistance')).toBe('stand');
  });

  test('⌘-wheel zooms when stopped; with a mouse while playing it does nothing (and the page does not zoom)', async () => {
    const b = await bed();
    await b.ts.play();
    expect(b.ts.snapshot.phase).toBe('playing');
    const wheel = ctrlWheel(-50);
    b.root.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(b.calls('previewScale')).toHaveLength(0);
    b.ts.transport.stop();
    const zoom = ctrlWheel(-50);
    b.root.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(true);
    expect(b.calls('previewScale')).toHaveLength(1);
    vi.advanceTimersByTime(300);
    expect(b.chart.state.scale).toBeGreaterThan(1.3);
    expect(prefs.get('chart.pinchScale')).toBe(b.chart.state.scale);
    expect(prefs.get('chart.pinchDistance')).toBe('stand');
  });

  test('=/− step through the scale steps and store the step for this device, at this Distance', async () => {
    const b = await bed({distance: 'kit', layout: 'rail'});
    b.surface.zoom(1);
    expect(b.chart.state.scale).toBe(1.8);
    expect(prefs.get('chart.pinchScale')).toBe(1.8);
    expect(prefs.get('chart.pinchDistance')).toBe('kit');
    b.surface.zoom(-1);
    b.surface.zoom(-1);
    expect(b.chart.state.scale).toBe(1.45);
    expect(b.calls('configure').map((c) => c[1].scale)).toEqual([1.8, 1.6, 1.45]);
    expect(SCALE_STEPS).toContain(1.45);
  });

  test('a Distance change is one chart.configure call: the floors, the Distance scale and bars per system in one relayout (I2b-5)', async () => {
    const b = await bed({layout: 'rail'});
    const before = b.chart.raw.revision;
    b.surface.setDistance('kit');
    expect(b.calls('configure')).toHaveLength(1);
    const [, next, opts] = b.calls('configure')[0];
    expect(next.scale).toBeCloseTo(1.6, 9);
    expect(next.fonts.barNumber).toBeCloseTo(18.2, 9);
    expect(next.fonts.marker).toBeCloseTo(26, 9);
    expect(next.barsPerRow).toBe(4);
    expect(opts).toEqual({anchor: true});
    expect(b.calls('setScale')).toHaveLength(0);
    expect(b.calls('setFonts')).toHaveLength(0);
    expect(b.calls('setDisplay')).toHaveLength(0);
    expect(b.chart.raw.revision - before).toBe(1);
    expect(b.root.dataset.relayouts).toBe('1');
    expect(b.log.statuses).toEqual([]);
  });

  test('a pinch is kept per Distance: ignored at another, applied again on going back (I2b-3)', async () => {
    const b = await bed({layout: 'rail', distance: 'stand'});
    b.surface.zoom(1);
    expect(b.chart.state.scale).toBe(1.45);
    b.stage.sig.distance.value = 'kit';
    b.surface.setDistance('kit');
    expect(b.chart.state.scale).toBeCloseTo(1.6, 9);
    expect(prefs.get('chart.pinchScale')).toBe(1.45);
    expect(prefs.get('chart.pinchDistance')).toBe('stand');
    b.surface.setDistance('stand');
    expect(b.chart.state.scale).toBe(1.45);
    // A pinch at Kit replaces Stand's: one override, for the Distance it was made at.
    b.surface.setDistance('kit');
    b.surface.zoom(1);
    expect(b.chart.state.scale).toBe(1.8);
    expect(prefs.get('chart.pinchDistance')).toBe('kit');
    b.surface.setDistance('stand');
    expect(b.chart.state.scale).toBeCloseTo(1.3, 9);
  });

  test('D54: after a relayout over 300 ms, Distance steps apply once on release (400 ms after the last) with "Resizing…"', async () => {
    const b = await bed({layout: 'rail'});
    b.chart.relayoutMs = 60;
    const scales = () => b.calls('configure').map((c) => c[1].scale);
    b.surface.zoom(1);           // live: one fast sample
    expect(scales()).toEqual([1.45]);
    b.chart.relayoutMs = 450;
    vi.advanceTimersByTime(1000);
    b.surface.zoom(1);           // still live (the last two were 60 ms), measured at 450 ms
    expect(scales()).toEqual([1.45, 1.6]);
    const before = b.chart.calls.length;
    b.surface.setDistance('near');
    expect(b.log.statuses.at(-1)).toEqual([COPY.resizing, {key: 'chart-resize'}]);
    expect(b.chart.calls.length).toBe(before);
    vi.advanceTimersByTime(200);
    b.surface.setDistance('kit');
    vi.advanceTimersByTime(399);
    expect(b.calls('configure')).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(b.calls('configure')).toHaveLength(3);   // the two steps coalesce into one change
    expect(b.calls('configure')[2][1].fonts.barNumber).toBeCloseTo(18.2, 9);
    expect(scales().at(-1)).toBeCloseTo(1.6, 9);   // Stand's pinch does not apply at Kit
    // Fast relayouts again: once the last two are ≤ 300 ms, changes are live.
    b.chart.relayoutMs = 60;
    b.surface.setDistance('near');
    vi.advanceTimersByTime(400);
    b.surface.setDistance('stand');
    vi.advanceTimersByTime(1000);
    b.surface.setDistance('kit');
    expect(scales().slice(-3)).toEqual([1.1, 1.6, 1.6]);   // back at Stand, its pinch (1.6) applies again
    expect(b.calls('setScale')).toHaveLength(0);
    expect(b.calls('setFonts')).toHaveLength(0);
  });

  test('a layout switch moves the follow line, the dense bars per system and the Distance scale in place', async () => {
    const b = await bed({layout: 'rail'});
    b.surface.setLayout('band');
    expect(b.calls('setFollowStyle').at(-1)).toEqual(['setFollowStyle', 'scroll', 0.28]);
    expect(b.calls('configure')).toHaveLength(1);
    expect(b.calls('configure')[0][1]).toMatchObject({barsPerRow: 2, scale: 1.2});
    expect(b.calls('setDisplay')).toHaveLength(0);
    expect(b.calls('setScale')).toHaveLength(0);
  });

  test('a pinch during a deferred Distance change keeps the new Distance\'s label floors', async () => {
    const b = await bed({layout: 'rail'});
    b.chart.relayoutMs = 450;
    b.surface.zoom(1);
    b.surface.zoom(1);           // two slow size changes: D54 now defers
    b.surface.setDistance('kit');
    expect(b.log.statuses.at(-1)).toEqual([COPY.resizing, {key: 'chart-resize'}]);
    pointer(b.root, 'pointerdown', {pointerType: 'touch', pointerId: 1, x: 100, y: 100, isPrimary: true});
    pointer(b.root, 'pointerdown', {pointerType: 'touch', pointerId: 2, x: 200, y: 100, isPrimary: false});
    pointer(b.root, 'pointermove', {pointerType: 'touch', pointerId: 2, x: 300, y: 100});
    pointer(b.root, 'pointerup', {pointerType: 'touch', pointerId: 2, x: 300, y: 100});
    vi.advanceTimersByTime(2000);
    expect(b.chart.state.floors.barNumber).toBeCloseTo(18.2, 9);
    expect(b.chart.state.floors.marker).toBeCloseTo(26, 9);
    expect(b.calls('configure').filter((c) => c[1].fonts.barNumber > 18)).toHaveLength(1);   // the pinch's change, at Kit's floors
    expect(b.chart.state.scale).toBe(prefs.get('chart.pinchScale'));
    expect(prefs.get('chart.pinchDistance')).toBe('kit');
    expect(b.chart.state.scale).toBeGreaterThan(1.6);
  });

  test('D54 judges a size change as a whole: a further relayout soon after it is summed into its sample', async () => {
    const b = await bed({layout: 'rail'});
    b.chart.relayoutMs = 200;    // each relayout is under 300 ms, the change is not
    const before = b.chart.raw.revision;
    b.surface.setDistance('kit');
    expect(b.chart.raw.revision - before).toBe(1);
    expect(b.root.dataset.relayoutMs).toBe('200');
    expect(b.root.dataset.relayouts).toBe('1');
    b.chart.relayout();              // e.g. an engraving the change caused on its own
    expect(b.root.dataset.relayoutMs).toBe('400');
    expect(b.root.dataset.relayouts).toBe('2');
    expect(b.log.statuses).toEqual([]);
    b.surface.setDistance('near');   // the last change took 400 ms: deferred
    expect(b.log.statuses.at(-1)).toEqual([COPY.resizing, {key: 'chart-resize'}]);
    expect(b.chart.state.scale).toBe(1.6);
    // Release (the Distance menu closing) applies it at once instead of after 400 ms.
    b.surface.commitSize();
    expect(b.chart.state.scale).toBe(1.1);
    expect(b.chart.state.floors.barNumber).toBeCloseTo(11.2, 9);
    expect(b.root.dataset.relayouts).toBe('1');   // a new change: its own sample
    vi.advanceTimersByTime(1000);
    expect(b.calls('configure').map((c) => c[1].scale)).toEqual([1.6, 1.1]);
    // Past BATCH_IDLE_MS a relayout is a change of its own.
    vi.advanceTimersByTime(1000);
    b.chart.relayout();
    expect(b.root.dataset.relayouts).toBe('1');
    expect(b.root.dataset.relayoutMs).toBe('200');
  });

  test('a dense layout switch is one size change, and its follow line moves once, at the new layout', async () => {
    const b = await bed({layout: 'rail'});
    const before = b.chart.raw.revision;
    const followCalls = b.calls('setFollowStyle').length;
    // The Stage updates its layout (and so its follow style) before it calls setLayout.
    b.stage.sig.layout.value = 'band';
    b.stage.sig.followStyle.value = 'page';
    expect(b.calls('setFollowStyle')).toHaveLength(followCalls);   // not with the rail's 0.33
    b.surface.setLayout('band');
    expect(b.calls('setFollowStyle').slice(followCalls)).toEqual([['setFollowStyle', 'page', 0.28]]);
    expect(b.chart.state.barsPerRow).toBe(2);
    expect(b.chart.state.scale).toBe(1.2);
    expect(b.chart.raw.revision - before).toBe(1);   // bars per system and the scale: one configure call
    expect(b.calls('configure')).toHaveLength(1);
    expect(b.root.dataset.relayouts).toBe('1');
    expect(b.root.dataset.relayoutMs).toBe('40');
  });

  test('a layout or Distance change made while the chart module loads is applied when the chart is created', async () => {
    prefs.update((d) => { d.chart.pinchScale = 0.9; d.chart.pinchDistance = 'stand'; });
    const b = await bed({layout: 'band', distance: 'kit', surfaceOpts: {layout: 'rail', distance: 'stand'}});
    expect(b.chart.options.scale).toBe(1.5);   // Stand's pinch does not apply at Kit
    expect(b.chart.options.followAnchor).toBe(0.28);
    expect(b.chart.options.display.barsPerRow).toBe(2);
    expect(b.chart.options.fonts.barNumber).toBeCloseTo(18.2, 9);
    expect(prefs.get('chart.pinchScale')).toBe(0.9);   // kept for Stand
  });

  test('the Display (Together · Hands & feet) and Follow style are this device\'s, from the Stage', async () => {
    const b = await bed({layout: 'rail'});
    b.stage.sig.display.value = 'split';
    expect(b.calls('setDisplay').at(-1)).toEqual(['setDisplay', {layout: 'split'}]);
    b.stage.sig.display.value = null;
    expect(b.calls('setDisplay').at(-1)).toEqual(['setDisplay', {layout: null}]);
    b.stage.sig.followStyle.value = 'page';
    expect(b.calls('setFollowStyle').at(-1)).toEqual(['setFollowStyle', 'page', 0.33]);
  });
});

describe('Follow and ⤓ Back to playhead', () => {
  const pillOf = (b) => b.root.querySelector('.chart-surface-follow');

  test('a manual scroll shows the 56 px pill; tapping it resumes Follow', async () => {
    const b = await bed();
    expect(pillOf(b).hidden).toBe(true);
    b.chart.userScroll();
    expect(pillOf(b).hidden).toBe(false);
    expect(b.log.follows).toEqual([false]);
    const button = pillOf(b).querySelector('button');
    expect(button.textContent).toContain(COPY.followResume);
    button.click();
    expect(b.chart.state.follow).toBe(true);
    expect(pillOf(b).hidden).toBe(true);
    expect(b.log.follows).toEqual([false, true]);
  });

  test('while playing, 8 s without touching the music resumes Follow; touching it restarts the wait', async () => {
    const b = await bed();
    await b.ts.play();
    b.surface.setGlass(true);
    b.chart.userScroll();
    vi.advanceTimersByTime(IDLE_RESUME_MS - 1000);
    b.root.dispatchEvent(new Event('wheel', {bubbles: true}));
    vi.advanceTimersByTime(IDLE_RESUME_MS - 1);
    expect(b.chart.state.follow).toBe(false);
    b.surface.setGlass(true);   // the Stage calls it on every transport change: the wait is not restarted
    vi.advanceTimersByTime(1);
    expect(b.chart.state.follow).toBe(true);
    expect(pillOf(b).hidden).toBe(true);
  });

  test('stopped, Follow stays paused while the reader browses (no idle resume)', async () => {
    const b = await bed();
    b.chart.userScroll();
    vi.advanceTimersByTime(IDLE_RESUME_MS * 2);
    expect(b.chart.state.follow).toBe(false);
  });

  test('Play and Again resume Follow (the transport gesture); F does through the Stage (setFollow)', async () => {
    const b = await bed();
    b.chart.userScroll();
    await b.ts.play();
    expect(b.chart.state.follow).toBe(true);
    b.chart.userScroll();
    b.ts.transport.again();
    expect(b.chart.state.follow).toBe(true);
    b.chart.userScroll();
    b.surface.setFollow(true);
    expect(b.chart.state.follow).toBe(true);
    expect(pillOf(b).hidden).toBe(true);
  });
});

describe('the bar list (stage.bars, D45)', () => {
  test('focus starts at the playing bar; ←/→ Home End rove with Follow paused; Enter plays and L loops the bar', async () => {
    const b = await bed();
    document.documentElement.dataset.place = 'stage';
    document.documentElement.dataset.posture = 'stage';
    const stop = startDispatcher({registry: b.reg, platform: 'win'});
    current.push(() => stop());
    const list = b.root.querySelector('[role=listbox]');
    expect(list.hidden).toBe(false);
    expect(list.getAttribute('aria-label')).toBe('Bars');
    expect(list.dataset.scope).toBe('stage.bars');
    expect(list.getAttribute('data-consume-keys')).toBe('ArrowLeft ArrowRight Home End');
    b.ts.transport.cue(33);
    list.focus();
    const option = list.querySelector('[role=option]');
    expect(list.getAttribute('aria-activedescendant')).toBe(option.id);
    expect(option.textContent).toBe('Bar 17 · Chorus');
    expect(option.getAttribute('aria-posinset')).toBe('17');
    expect(option.getAttribute('aria-setsize')).toBe('64');
    expect(b.reg.context().focused).toMatchObject({kind: 'bar', t0: 32, t1: 34, label: 'Bar 17', bar: 17});
    keydown('ArrowRight', {target: list});
    expect(option.textContent).toBe('Bar 18 · Chorus');
    expect(b.calls('reveal').at(-1)).toEqual(['reveal', 34, {smooth: true}]);
    expect(b.chart.state.follow).toBe(false);
    keydown('End', {target: list});
    expect(option.textContent).toBe('Bar 64 · Outro');
    keydown('Home', {target: list});
    expect(option.textContent).toBe('Bar 1 · Intro');
    keydown('ArrowLeft', {target: list});
    expect(option.textContent).toBe('Bar 1 · Intro');
    keydown('ArrowRight', {target: list});
    keydown('KeyL', {target: list});
    expect(b.ts.snapshot.loop).toMatchObject({on: true, a: 2, b: 4});
    b.ts.transport.clearLoop();
    keydown('Enter', {target: list});
    await settle();
    expect(b.ts.snapshot.phase).toBe('playing');
    expect(b.ts.transport.position()).toBeCloseTo(2, 1);
    list.blur();
    expect(b.reg.context().focused).toBeNull();
  });

  test('the menu keys on the bar list open the focused bar\'s menu', async () => {
    const b = await bed();
    const list = b.root.querySelector('[role=listbox]');
    list.focus();
    keydown('ArrowRight', {target: list});
    keydown('Shift+F10', {target: list});
    expect(b.log.activate.at(-1)).toMatchObject({kind: 'context', t: 2, bar: 2, keyboard: true});
  });
});

describe('states: opening, error, empty (owner and shared)', () => {
  test('"Opening the drum chart…" until the part answers, then the chart', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const ts = await createTestSession({clock, score: demoScore(128, 120), load: false,
      openPart: async (o) => { await gate; return (await import('../src/js/notation/part.js')).openPart(o); }});
    const host = document.createElement('div');
    document.body.append(host);
    const reg = createRegistry();
    const surface = await createChartSurface(host, {session: ts.session, layout: 'band', distance: 'stand', registry: reg});
    current.push(async () => { surface.destroy(); await ts.dispose(); });
    const root = host.querySelector('.chart-surface');
    expect(root.dataset.state).toBe('opening');
    expect(root.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('.chart-surface-note').textContent).toBe(COPY.opening);
    expect(fake.charts.at(-1).state.visible).toBe(false);
    release();
    await ts.session.notation.ready;
    await settle();
    expect(root.dataset.state).toBe('chart');
    expect(root.hasAttribute('aria-busy')).toBe(false);
    expect(fake.charts.at(-1).state.visible).toBe(true);
  });

  test('a part that cannot open shows the error with Try again', async () => {
    let fail = true;
    const ts = await createTestSession({clock, score: demoScore(128, 120), load: false,
      openPart: async (o) => { if (fail) throw new Error('offline'); return (await import('../src/js/notation/part.js')).openPart(o); }});
    await ts.session.notation.ready;
    const host = document.createElement('div');
    document.body.append(host);
    const surface = await createChartSurface(host, {session: ts.session, layout: 'band', registry: createRegistry()});
    current.push(async () => { surface.destroy(); await ts.dispose(); });
    await settle();
    const root = host.querySelector('.chart-surface');
    expect(root.dataset.state).toBe('error');
    expect(root.querySelector('.chart-surface-note-text').textContent).toBe(COPY.openFailed);
    fail = false;
    const retry = [...root.querySelectorAll('button')].find((el) => el.textContent.includes(COPY.tryAgain));
    retry.click();
    expect(root.dataset.state).toBe('opening');
    await settle();
    await settle();
    expect(root.dataset.state).toBe('chart');
    expect(fake.charts.at(-1).options.part.hasNotation).toBe(true);
  });

  test('owner, no chart: Find a chart · Import a file · Write one run map.find, the Find panel import and edit.chart', async () => {
    const router = {calls: [], navigate(to) { this.calls.push(to); }};
    const b = await bed({score: null, router});
    const actions = b.chart.options.onEmpty;
    expect(Object.keys(actions)).toEqual(['findChart', 'importFile', 'write']);
    actions.findChart();
    actions.write();
    actions.importFile();
    expect(b.ran).toEqual(['map.find', 'edit.chart']);
    expect(router.calls).toEqual([`/s/${encodeURIComponent(b.ts.session.id)}/edit/map/find?import=1`]);
    expect(b.chart.options.part.readOnly).toBe(false);
    expect(b.root.querySelector('[role=listbox]').hidden).toBe(true);
  });

  test('shared, no chart: no actions and the shared copy (the part reads read-only)', async () => {
    const b = await bed({score: null, readOnly: true});
    expect(b.chart.options.onEmpty).toEqual({});
    expect(b.chart.options.part.readOnly).toBe(true);
  });

  test('unmapped song with no part: nothing the surface renders says "Bar"', async () => {
    const b = await bed({score: null, mapped: false});
    expect(b.ts.session.map.isReal).toBe(false);
    b.chart.userScroll();
    const text = b.root.textContent;
    expect(text).not.toMatch(/Bar|bar /);
  });
});

describe('controls (§9.0)', () => {
  test('every control renders with its role and accessible name', async () => {
    const b = await bed();
    b.chart.userScroll();
    const named = (role, name) => [...b.root.querySelectorAll(role === 'button' ? 'button' : `[role=${role}]`)]
      .some((el) => (el.getAttribute('aria-label') ?? el.textContent).includes(name));
    for (const c of CONTROLS.filter((x) => ['Back to playhead', 'Bars'].includes(x.name))) expect(named(c.role, c.name)).toBe(true);
    // The empty-state actions are the chart's buttons; their names and commands match chart.js's EMPTY_ACTIONS.
    const {EMPTY_ACTIONS} = await import('../src/js/notation/chart.js');
    expect(CONTROLS.filter((c) => EMPTY_ACTIONS.some((a) => a.name === c.name)).map((c) => c.name)).toEqual(EMPTY_ACTIONS.map((a) => a.name));
    expect(CONTROLS.find((c) => c.name === 'Find a chart').command).toBe('map.find');
    expect(CONTROLS.find((c) => c.name === 'Write one').command).toBe('edit.chart');
    // Try again: the error state's button.
    expect(CONTROLS.find((c) => c.name === COPY.tryAgain).role).toBe('button');
  });
});
