// @vitest-environment happy-dom
// ST2: src/stage/wave-render.js — the peak pyramid (exactly computePeaksRange), perBar, the
// token reader, the hatch cache and the recorded draw calls of drawGrid, drawRows,
// drawEnvelopeStack and drawStripWave on createRecordingContext().
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

vi.mock('../src/js/waveform.js', async importOriginal => {
  const real = await importOriginal();
  return {...real, computePeaksRange: vi.fn(real.computePeaksRange)};
});

import {computePeaksRange} from '../src/js/waveform.js';
import {
  clearHatchCache, createPeaks, drawEnvelopeStack, drawGrid, drawRows, drawStripWave, GRID_ALPHA, hatch,
  invalidateTokens, readTokens, SECONDARY_ALPHA,
} from '../src/stage/wave-render.js';
import {gridTicks} from '../src/stage/grid.js';
import {mapStore, sectioned} from './fixtures/maps.js';
import {createRecordingContext, installCanvasShim, restoreDomShims} from './helpers/dom.js';

// ---------------------------------------------------------------- fixtures

/** Deterministic noise in [-1, 1) with occasional transients past ±1 (clipping, as real stems do). */
function noise(length, seed) {
  const out = new Float32Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const v = (s / 2 ** 32) * 2 - 1;
    out[i] = i % 997 === 0 ? v * 1.4 : v * (0.2 + 0.8 * Math.abs(Math.sin(i / 3000)));
  }
  return out;
}

function fakeBuffer({length, sampleRate = 8000, channels = 2, seed = 1}) {
  const data = Array.from({length: channels}, (_, c) => noise(length, seed * 31 + c));
  const getChannelData = vi.fn(c => data[c]);
  return {sampleRate, length, numberOfChannels: channels, duration: length / sampleRate, getChannelData, data};
}

/** A brute-force reference: [min, max] of the mono mix over samples [a, b), computePeaksRange's rules. */
function bruteWindow(buffer, a, b) {
  let min = 1, max = -1;
  const [l, r] = buffer.data;
  for (let i = Math.max(0, a); i < Math.min(b, buffer.length); i++) {
    const v = r ? (l[i] + r[i]) * 0.5 : l[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min > max ? [0, 0] : [Math.fround(min), Math.fround(max)];
}

const near = (actual, expected, tol = 1e-6) => {
  expect(actual.length).toBe(expected.length);
  let worst = 0;
  for (let i = 0; i < actual.length; i++) worst = Math.max(worst, Math.abs(actual[i] - expected[i]));
  expect(worst).toBeLessThanOrEqual(tol);
};

beforeEach(() => {
  computePeaksRange.mockClear();
});

// ---------------------------------------------------------------- peaks

describe('createPeaks: the pyramid', () => {
  const buffer = fakeBuffer({length: 8000 * 9 + 123, seed: 7});   // 9 s plus a partial bin at the end
  const base = 256;

  test('level k holds [min, max] per base × 2^k samples, equal to computePeaksRange within 1e-6', () => {
    const peaks = createPeaks([{name: 'drums', buffer}], {base});
    const count = peaks.levelCount('drums');
    expect(count).toBe(Math.ceil(Math.log2(Math.ceil(buffer.length / base))) + 1);
    for (let k = 0; k < count; k++) {
      const size = base * 2 ** k, bins = Math.ceil(buffer.length / size);
      const level = peaks.level('drums', k);
      expect(level.length).toBe(bins * 2);
      near(level, computePeaksRange(buffer, 0, buffer.duration, bins, {samplesPerBin: size}));
      // And against a raw scan of the same samples (computePeaksRange's samplesPerBin is exact).
      for (const j of new Set([0, 1, Math.floor(bins / 2), bins - 1].filter(j => j < bins))) {
        const [mn, mx] = bruteWindow(buffer, j * size, (j + 1) * size);
        expect(level[2 * j]).toBeCloseTo(mn, 6);
        expect(level[2 * j + 1]).toBeCloseTo(mx, 6);
      }
    }
    expect(peaks.level('drums', count - 1).length).toBe(2);
  });

  test('range(name, t0, t1, bins) equals computePeaksRange for zoomed-out, zoomed-in, partial and out-of-range windows', () => {
    const peaks = createPeaks([{name: 'bass', buffer}], {base});
    const cases = [
      [0, buffer.duration, 1440], [0, buffer.duration, 7], [0, buffer.duration, 1],
      [1.2345, 6.789, 800], [2, 2.05, 300] /* < 1 sample per bin */, [3.3, 3.31, 2],
      [0.0001, 0.0002, 5], [8.9, 12, 64] /* past the end */, [-1, 0.5, 40] /* before 0 */, [10, 11, 16] /* wholly past */,
      [4.5, 4.5, 3] /* empty */,
    ];
    for (const [t0, t1, bins] of cases) near(peaks.range('bass', t0, t1, bins), computePeaksRange(buffer, t0, t1, bins));
  });

  test('mono and stereo buffers, and any base', () => {
    const mono = fakeBuffer({length: 20011, channels: 1, seed: 3});
    for (const b of [64, 100, 256, 1024]) {
      const peaks = createPeaks([{name: 'vocals', buffer: mono}], {base: b});
      for (const [t0, t1, bins] of [[0, mono.duration, 333], [0.3, 1.9, 1000], [1.1, 1.2, 9]]) {
        near(peaks.range('vocals', t0, t1, bins), computePeaksRange(mono, t0, t1, bins));
      }
    }
  });

  test('levels are built lazily, once per track, from computePeaksRange', () => {
    const a = fakeBuffer({length: 50000, seed: 11}), b = fakeBuffer({length: 40000, seed: 12});
    const peaks = createPeaks([{name: 'drums', buffer: a}, {name: 'bass', buffer: b}]);
    expect(computePeaksRange).not.toHaveBeenCalled();
    expect(a.getChannelData).not.toHaveBeenCalled();
    // Bins of at most 2 × base samples are read from the samples themselves: no pyramid yet.
    peaks.range('drums', 1, 4, 300);
    expect(computePeaksRange).not.toHaveBeenCalled();
    peaks.range('drums', 0, a.duration, 20);
    peaks.range('drums', 1, 4, 3);
    peaks.range('drums', 0, 2, 1);
    expect(computePeaksRange).toHaveBeenCalledTimes(1);
    expect(computePeaksRange.mock.calls[0][0]).toBe(a);
    expect(computePeaksRange.mock.calls[0][4]).toEqual({samplesPerBin: 256});
    expect(b.getChannelData).not.toHaveBeenCalled();
    peaks.range('bass', 0, b.duration, 2);
    expect(computePeaksRange).toHaveBeenCalledTimes(2);
  });

  test("'mix' is the max-abs envelope across tracks: min of mins, max of maxes", () => {
    const a = fakeBuffer({length: 30000, seed: 21}), b = fakeBuffer({length: 24000, seed: 22, channels: 1});
    const peaks = createPeaks([{name: 'drums', buffer: a}, {name: 'bass', buffer: b}]);
    for (const [t0, t1, bins] of [[0, a.duration, 200], [2.5, 3.6, 77]]) {
      const mix = peaks.range('mix', t0, t1, bins), pa = computePeaksRange(a, t0, t1, bins), pb = computePeaksRange(b, t0, t1, bins);
      const expected = new Float32Array(bins * 2);
      for (let i = 0; i < bins; i++) {
        expected[2 * i] = Math.min(pa[2 * i], pb[2 * i]);
        expected[2 * i + 1] = Math.max(pa[2 * i + 1], pb[2 * i + 1]);
      }
      near(mix, expected);
    }
  });

  test('perBar: one [min, max] per bar, from SongMapStore bars or boundaries', () => {
    const map = mapStore(sectioned, {duration: 9});   // 2 s bars at 120 bpm
    const peaks = createPeaks([{name: 'drums', buffer}]);
    const bars = map.bars;
    const out = peaks.perBar('drums', bars);
    expect(out.length).toBe(bars.length * 2);
    bars.forEach((bar, i) => {
      const [mn, mx] = bruteWindow(buffer, Math.floor(bar.t0 * buffer.sampleRate), Math.ceil(bar.t1 * buffer.sampleRate));
      expect(out[2 * i]).toBeCloseTo(mn, 6);
      expect(out[2 * i + 1]).toBeCloseTo(mx, 6);
    });
    near(peaks.perBar('drums', [0, 2, 4]), [...peaks.range('drums', 0, 2, 1), ...peaks.range('drums', 2, 4, 1)]);
    near(peaks.perBar('drums', [{start: 1, end: 3}]), peaks.range('drums', 1, 3, 1));
    near(peaks.perBar('mix', [[0, 2]]), peaks.range('mix', 0, 2, 1));
    expect(peaks.perBar('drums', []).length).toBe(0);
  });

  test('ready, names, duration; missing buffers and unknown names read as silence', () => {
    const a = fakeBuffer({length: 16000});
    const loading = createPeaks([{name: 'drums', buffer: a}, {name: 'bass', buffer: null}]);
    expect(loading.ready).toBe(false);
    expect(loading.names).toEqual(['drums', 'bass']);
    expect(loading.has('bass')).toBe(false);
    expect([...loading.range('bass', 0, 1, 4)]).toEqual(new Array(8).fill(0));
    expect([...loading.range('guitar', 0, 1, 2)]).toEqual([0, 0, 0, 0]);
    near(loading.range('mix', 0, 2, 10), loading.range('drums', 0, 2, 10));
    expect(() => loading.level('bass', 0)).toThrow(RangeError);
    expect(createPeaks([{name: 'drums', buffer: a}]).ready).toBe(true);
    expect(createPeaks([]).ready).toBe(false);
    expect(createPeaks([{name: 'drums', buffer: a}]).duration).toBe(2);
    expect(createPeaks([{name: 'drums', buffer: a}]).range('drums', 0, 1, 0).length).toBe(0);
  });
});

// ---------------------------------------------------------------- tokens and drawing

const TOKENS = {
  '--ink': '#ffffff', '--ink-3': '#9aa5a0', '--now': '#ffc14d', '--now-soft': '#2e220e', '--accent': '#9cbcff', '--loop': '#7fa6ff',
  '--loop-fill': '#334455', '--out': '#8b9692', '--line': '#2a302e', '--grid-beat': '#111111', '--grid-bar': '#222222',
  '--stem-drums': '#f2b294', '--stem-bass': '#9cd3b1', '--stem-guitar': '#e3baca', '--stem-piano': '#a1d6d1', '--stem-vocals': '#b3cbff', '--stem-other': '#ccd3dd',
};

function setTokens(values = TOKENS) {
  for (const [k, v] of Object.entries(values)) document.documentElement.style.setProperty(k, v);
  invalidateTokens();
}

beforeEach(() => { setTokens(); clearHatchCache(); });
afterEach(() => restoreDomShims());

describe('readTokens', () => {
  test('reads every canvas colour from the root tokens, cached until woodshed:theme or woodshed:place', () => {
    const t = readTokens();
    expect(t.ink).toBe('#ffffff');
    expect(t.ink3).toBe('#9aa5a0');
    expect(t.loopFill).toBe('#334455');
    expect(t.stem).toEqual({drums: '#f2b294', bass: '#9cd3b1', guitar: '#e3baca', piano: '#a1d6d1', vocals: '#b3cbff', other: '#ccd3dd'});
    expect(Object.keys(t).sort()).toEqual(['accent', 'gridBar', 'gridBeat', 'ink', 'ink3', 'line', 'loop', 'loopFill', 'now', 'nowSoft', 'out', 'stem']);
    expect(readTokens()).toBe(t);
    document.documentElement.style.setProperty('--ink', '#000000');
    expect(readTokens().ink).toBe('#ffffff');   // cached
    window.dispatchEvent(new CustomEvent('woodshed:theme', {detail: {theme: 'light'}}));
    expect(readTokens().ink).toBe('#000000');
    document.documentElement.style.setProperty('--ink', '#eeeeee');
    window.dispatchEvent(new CustomEvent('woodshed:place', {detail: {place: 'stage'}}));
    expect(readTokens().ink).toBe('#eeeeee');
    expect(document.body.querySelectorAll('span[aria-hidden]').length).toBe(0);   // the probe is removed
  });
});

describe('hatch', () => {
  test('builds a 45° tile once per colour and dpr and returns the cached CanvasPattern', () => {
    installCanvasShim();
    const ctx = createRecordingContext();
    const first = hatch(ctx, '#f2b294', {dpr: 1});
    expect(hatch(ctx, '#f2b294', {dpr: 1})).toBe(first);
    expect(ctx.callsOf('createPattern')).toHaveLength(1);
    expect(ctx.callsOf('createPattern')[0][1]).toBe('repeat');
    const tile = ctx.callsOf('createPattern')[0][0];
    expect(tile.tagName).toBe('CANVAS');
    expect(tile.width).toBe(6);
    const second = hatch(ctx, '#9cd3b1', {dpr: 1});
    expect(second).not.toBe(first);
    const sharp = hatch(ctx, '#f2b294', {dpr: 2});
    expect(sharp).not.toBe(first);
    expect(ctx.callsOf('createPattern')).toHaveLength(3);
    expect(ctx.callsOf('createPattern')[2][0].width).toBe(12);
    // Another context reuses the cache (patterns are not tied to a context).
    const other = createRecordingContext();
    expect(hatch(other, '#9cd3b1', {dpr: 1})).toBe(second);
    expect(other.callsOf('createPattern')).toHaveLength(0);
  });

  test('the tile is one diagonal plus its corner pieces, stroked in the colour', () => {
    installCanvasShim();
    const ctx = createRecordingContext();
    hatch(ctx, '#abcdef', {dpr: 1});
    const tile = ctx.callsOf('createPattern')[0][0];
    const tctx = tile.getContext('2d');
    expect(tctx.setsOf('strokeStyle')).toEqual(['#abcdef']);
    expect(tctx.callsOf('moveTo')).toEqual([[0, 6], [-3, 3], [3, 9]]);
    expect(tctx.callsOf('lineTo')).toEqual([[6, 0], [3, -3], [9, 3]]);
    expect(tctx.callsOf('stroke')).toHaveLength(1);
  });
});

describe('drawGrid', () => {
  const map = mapStore(sectioned);   // 2 s bars, 0.5 s beats

  test('beats at 8% ink and bars at 18%, one 1 px line per tick', () => {
    const ctx = createRecordingContext();
    const ticks = gridTicks(map, 0, 8, 'beat');
    const drawn = drawGrid(ctx, {ticks, t0: 0, t1: 8, w: 800, h: 120});
    expect(drawn).toEqual({bar: true, beat: true, sub: false});
    expect(ctx.setsOf('fillStyle')).toEqual(['#ffffff']);
    expect(ctx.setsOf('globalAlpha')).toEqual([GRID_ALPHA.beat, GRID_ALPHA.bar]);
    expect(GRID_ALPHA).toEqual({beat: 0.08, sub: 0.08, bar: 0.18});
    const rects = ctx.callsOf('fillRect');
    // 12 beats (0.5 s apart = 50 px) then 5 bars (0, 200, 400, 600, 800 → clamped to 799).
    expect(rects.slice(0, 12).map(r => r[0])).toEqual([50, 100, 150, 250, 300, 350, 450, 500, 550, 650, 700, 750]);
    expect(rects.slice(12).map(r => r[0])).toEqual([0, 200, 400, 600, 799]);
    for (const r of rects) expect(r.slice(1)).toEqual([0, 1, 120]);
    expect(ctx.callsOf('save')).toHaveLength(1);
    expect(ctx.callsOf('restore')).toHaveLength(1);
  });

  test('lines closer than 6 px are skipped: beats first, then bars; subdivisions need room too', () => {
    // 64 bars across 600 px: beats are 2.3 px apart, bars 9.4 px.
    let ctx = createRecordingContext();
    let drawn = drawGrid(ctx, {ticks: gridTicks(map, 0, 128, 'beat'), t0: 0, t1: 128, w: 600, h: 40});
    expect(drawn).toEqual({bar: true, beat: false, sub: false});
    expect(ctx.setsOf('globalAlpha')).toEqual([0.18]);
    expect(ctx.callsOf('fillRect')).toHaveLength(65);
    // 64 bars across 300 px: bars are 4.7 px apart → nothing.
    ctx = createRecordingContext();
    drawn = drawGrid(ctx, {ticks: gridTicks(map, 0, 128, 'beat'), t0: 0, t1: 128, w: 300, h: 40});
    expect(drawn).toEqual({bar: false, beat: false, sub: false});
    expect(ctx.calls).toHaveLength(0);
    // Exactly 6 px apart is drawn (≥ minPx); quarter subdivisions 3 px apart are not.
    ctx = createRecordingContext();
    drawn = drawGrid(ctx, {ticks: gridTicks(map, 0, 2, 'quarter'), t0: 0, t1: 2, w: 24, h: 10});
    expect(drawn).toEqual({bar: true, beat: true, sub: false});
    ctx = createRecordingContext();
    drawn = drawGrid(ctx, {ticks: gridTicks(map, 0, 2, 'quarter'), t0: 0, t1: 2, w: 96, h: 10});
    expect(drawn).toEqual({bar: true, beat: true, sub: true});
    expect(ctx.setsOf('globalAlpha')).toEqual([0.08, 0.08, 0.18]);
    // A custom minPx.
    ctx = createRecordingContext();
    expect(drawGrid(ctx, {ticks: gridTicks(map, 0, 8, 'beat'), t0: 0, t1: 8, w: 800, h: 10, minPx: 60})).toEqual({bar: true, beat: false, sub: false});
  });

  test('nothing to draw: no ticks, an empty window', () => {
    const ctx = createRecordingContext();
    expect(drawGrid(ctx, {ticks: [], t0: 0, t1: 8, w: 800, h: 10})).toEqual({bar: false, beat: false, sub: false});
    expect(drawGrid(ctx, {ticks: [{t: 1, kind: 'bar'}], t0: 2, t1: 2, w: 800, h: 10}).bar).toBe(false);
    expect(ctx.calls).toHaveLength(0);
  });
});

/** A buffer alternating +level, −level: every bin's [min, max] is [−level, level]. */
function flat(level, seconds = 2, sampleRate = 1000) {
  const length = seconds * sampleRate, ch = Float32Array.from({length}, (_, i) => (i % 2 ? -level : level));
  return {sampleRate, length, numberOfChannels: 1, duration: seconds, getChannelData: () => ch};
}

describe('drawRows', () => {
  test('sets the dpr transform, clears each row and draws one bin per device pixel in its state', () => {
    installCanvasShim();
    const peaks = createPeaks([{name: 'drums', buffer: flat(0.5)}, {name: 'bass', buffer: flat(0.25)}, {name: 'vocals', buffer: flat(0.1)}, {name: 'other', buffer: flat(0.3)}]);
    const ctx = createRecordingContext();
    const rangeSpy = vi.spyOn(peaks, 'range');
    drawRows(ctx, {rows: [
      {name: 'drums', color: 'drums', state: 'on', y: 0, h: 100},
      {name: 'bass', color: '--stem-bass', state: 'out', y: 100, h: 100},
      {name: 'vocals', color: 'vocals', state: 'solo', y: 200, h: 100},
      {name: 'other', state: 'dim', y: 300, h: 100},
    ], t0: 0, t1: 2, width: 200, dpr: 2, peaks});
    expect(ctx.callsOf('setTransform')).toEqual([[2, 0, 0, 2, 0, 0]]);
    expect(ctx.callsOf('clearRect')).toEqual([[0, 0, 200, 100], [0, 100, 200, 100], [0, 200, 200, 100], [0, 300, 200, 100]]);
    expect(rangeSpy.mock.calls.map(c => c.slice(1))).toEqual([[0, 2, 400], [0, 2, 400], [0, 2, 400], [0, 2, 400]]);
    // On and solo: filled in the stem colour; out: hatch inside the clipped envelope plus a 1 px outline; dim: the outline only.
    expect(ctx.setsOf('fillStyle')).toEqual(['#f2b294', expect.objectContaining({}), '#b3cbff']);
    expect(ctx.setsOf('strokeStyle')).toEqual(['#9cd3b1', '#ccd3dd']);
    expect(ctx.callsOf('fill')).toHaveLength(2);
    expect(ctx.callsOf('stroke')).toHaveLength(2);
    expect(ctx.callsOf('clip')).toHaveLength(1);
    expect(ctx.callsOf('fillRect')).toEqual([[0, 100, 200, 100]]);   // the hatch fill of the muted row
    // Muted is never shown with opacity.
    expect(ctx.setsOf('globalAlpha').every(a => a === 1)).toBe(true);
    // The envelope of the first row: max edge at mid − 0.5 × 50 × 0.92, min edge mirrored.
    const lines = ctx.callsOf('lineTo');
    expect(lines[0]).toEqual([0, 50 - 0.5 * 50 * 0.92]);
    expect(lines[1]).toEqual([0.5, 50 - 0.5 * 50 * 0.92]);
    expect(lines[800]).toEqual([200, 50 + 0.5 * 50 * 0.92]);
  });

  test('silence still draws a 1 px line; rows without peaks are only cleared', () => {
    const peaks = createPeaks([{name: 'drums', buffer: flat(0)}]);
    const ctx = createRecordingContext();
    drawRows(ctx, {rows: [{name: 'drums', color: 'drums', state: 'on', y: 0, h: 40}], t0: 0, t1: 2, width: 10, dpr: 1, peaks});
    const ys = new Set(ctx.callsOf('lineTo').map(([, y]) => y));
    expect([...ys].sort()).toEqual([19.5, 20.5]);
    const empty = createRecordingContext();
    drawRows(empty, {rows: [{name: 'drums', y: 0, h: 40}], t0: 0, t1: 2, width: 10, dpr: 1, peaks: null});
    expect(empty.callsOf('clearRect')).toHaveLength(1);
    expect(empty.callsOf('fill')).toHaveLength(0);
  });
});

describe('drawEnvelopeStack', () => {
  test('others first at 55%, muted ghosts at full opacity with the hatch, your instrument last and on top', () => {
    installCanvasShim();
    const peaks = createPeaks(['drums', 'bass', 'guitar', 'vocals'].map((name, i) => ({name, buffer: flat(0.2 + i * 0.1)})));
    const ctx = createRecordingContext();
    const order = [];
    const range = peaks.range;
    peaks.range = (name, ...rest) => { order.push(name); return range(name, ...rest); };
    drawEnvelopeStack(ctx, {x: 10, y: 20, w: 88, h: 40, t0: 0, t1: 2, peaks, stems: [
      {name: 'drums', color: 'drums', state: 'on', primary: true},
      {name: 'bass', color: 'bass', state: 'on'},
      {name: 'guitar', color: 'guitar', state: 'out'},
      {name: 'vocals', color: 'vocals', state: 'on'},
    ]});
    expect(order).toEqual(['bass', 'vocals', 'guitar', 'drums']);
    expect(ctx.setsOf('globalAlpha')).toEqual([SECONDARY_ALPHA, SECONDARY_ALPHA, 1, 1]);
    expect(SECONDARY_ALPHA).toBe(0.55);
    const fills = ctx.setsOf('fillStyle');
    expect(fills[0]).toBe('#9cd3b1');
    expect(fills[1]).toBe('#b3cbff');
    expect(typeof fills[2]).toBe('object');   // the hatch pattern of the muted guitar
    expect(fills[3]).toBe('#f2b294');
    expect(ctx.setsOf('strokeStyle')).toEqual(['#e3baca']);
    expect(ctx.callsOf('fillRect')).toEqual([[10, 20, 88, 40]]);
    // Symmetric envelopes inside the box.
    const ys = ctx.callsOf('lineTo').map(([, y]) => y);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...ys)).toBeLessThanOrEqual(60);
    const xs = ctx.callsOf('lineTo').map(([x]) => x);
    expect(Math.min(...xs)).toBe(10);
    expect(Math.max(...xs)).toBe(98);
  });

  test('a muted primary (Minus me) is drawn last as a ghost, so the hole you fill stays visible', () => {
    installCanvasShim();
    const peaks = createPeaks([{name: 'drums', buffer: flat(0.5)}, {name: 'bass', buffer: flat(0.5)}]);
    const ctx = createRecordingContext();
    drawEnvelopeStack(ctx, {x: 0, y: 0, w: 20, h: 20, t0: 0, t1: 2, peaks, stems: [
      {name: 'drums', color: 'drums', state: 'out', primary: true}, {name: 'bass', color: 'bass', state: 'on'}]});
    expect(ctx.setsOf('globalAlpha')).toEqual([SECONDARY_ALPHA, 1]);
    expect(ctx.setsOf('strokeStyle')).toEqual(['#f2b294']);
    expect(ctx.calls.filter(c => c.name === 'stroke').length).toBe(1);
    const lastFill = ctx.calls.filter(c => c.name === 'fill' || c.name === 'stroke').pop();
    expect(lastFill.name).toBe('stroke');
  });
});

describe('drawStripWave', () => {
  test('the mix over the whole song in --ink-3', () => {
    const peaks = createPeaks([{name: 'drums', buffer: flat(0.5, 4)}, {name: 'bass', buffer: flat(-0.25, 4)}]);
    const spy = vi.spyOn(peaks, 'range');
    const ctx = createRecordingContext();
    drawStripWave(ctx, {w: 300, h: 32, peaks, duration: 4});
    expect(spy).toHaveBeenCalledWith('mix', 0, 4, 300);
    expect(ctx.setsOf('fillStyle')).toEqual(['#9aa5a0']);
    expect(ctx.callsOf('fill')).toHaveLength(1);
    const none = createRecordingContext();
    drawStripWave(none, {w: 300, h: 32, peaks, duration: 0});
    expect(none.calls).toHaveLength(0);
  });
});
