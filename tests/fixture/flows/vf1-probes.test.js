// @vitest-environment node
// The verification probes' pure parts without a browser (architecture §10.3, §11.5):
// probe-axe's verdict and pinned source, probe-readouts' table validation and verdict,
// probe-perf's ratio rule, frame statistics and requires gating, and the shape of
// tests/fixture/flows/VF1.cjs. The flows themselves run in Chromium through
//   npm run fixture:capture -- --state-file tests/fixture/flows/VF1.cjs --strict-requires
import {describe, it, expect} from 'vitest';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const axe = require('../probes/probe-axe.cjs');
const readouts = require('../probes/probe-readouts.cjs');
const perf = require('../probes/probe-perf.cjs');
const {validateStates} = require('../lib/runner.cjs');
const checks = require('./vf1-checks.cjs');

describe('probe-axe.cjs', () => {
  const node = (target, summary = '') => ({target, html: '<x>', summary});
  it('reports every violation node and the reviewed incomplete rules only', () => {
    const problems = axe.axeProblems({
      violations: [{id: 'color-contrast', impact: 'serious', help: 'Elements must meet contrast', nodes: [node('.a', 'Fix: 3.1:1'), node('.b')]}],
      incomplete: [
        {id: 'aria-prohibited-attr', impact: 'serious', help: 'Permitted ARIA', nodes: [node('.lib-count', 'aria-label on a span')]},
        {id: 'color-contrast', impact: 'serious', help: 'Contrast', nodes: [node('.over-image')]},
      ],
    });
    expect(problems).toEqual([
      'axe violation: color-contrast (serious) Elements must meet contrast at .a (Fix: 3.1:1)',
      'axe violation: color-contrast (serious) Elements must meet contrast at .b',
      'axe needs review: aria-prohibited-attr (serious) Permitted ARIA at .lib-count (aria-label on a span)',
    ]);
  });
  it('is clean for a clean result and honours a custom review list', () => {
    expect(axe.axeProblems({violations: [], incomplete: []})).toEqual([]);
    expect(axe.axeProblems({incomplete: [{id: 'aria-prohibited-attr', impact: null, help: 'h', nodes: [node('.x')]}]}, {review: []})).toEqual([]);
  });
  it('loads the pinned axe-core and refuses another version', () => {
    expect(axe.axeSource()).toContain(`axe v${axe.AXE_VERSION}`);
    expect(axe.TAGS).toEqual(expect.arrayContaining(['wcag2aa', 'wcag22aa']));
  });
});

describe('probe-readouts.cjs', () => {
  const rows = [
    {name: 'title', selector: '.t', font: {size: 28, weight: 700}},
    {name: 'resume', selector: '.r', box: {h: 48}},
    {name: 'dock', selector: '.d', box: {maxW: 700}, optional: true},
    {name: 'lines', selector: '.l', all: true, font: {minSize: 13}},
  ];
  it('validates the table', () => {
    expect(() => readouts.validateRows([])).toThrow(/non-empty/);
    expect(() => readouts.validateRows([{name: 'x', selector: '.x'}])).toThrow(/neither font nor box/);
    expect(() => readouts.validateRows([{name: 'x', selector: '.x', font: {sise: 2}}])).toThrow(/unknown font key sise/);
    expect(() => readouts.validateRows([{name: 'x', selector: '.x', box: {h: '48'}}])).toThrow(/must be a number/);
    expect(readouts.validateRows(rows)).toBe(rows);
  });
  it('passes matching values within the tolerance', () => {
    const measured = [
      {items: [{label: 'Low Tide', size: 28, weight: 700, w: 300, h: 32}]},
      {items: [{label: 'Resume', size: 16, weight: 600, w: 120, h: 48.3}]},
      {items: []},
      {items: [{label: 'a', size: 13, weight: 400, w: 1, h: 1}, {label: 'b', size: 14, weight: 400, w: 1, h: 1}]},
    ];
    expect(readouts.readoutProblems(measured, rows)).toEqual([]);
  });
  it('names every value outside its expectation and a missing required element', () => {
    const measured = [
      {items: [{label: 'Low Tide', size: 24, weight: 600, w: 300, h: 32}]},
      {items: []},
      {items: [{label: 'dock', size: 16, weight: 400, w: 760, h: 64}]},
      {items: [{label: 'b', size: 12, weight: 400, w: 1, h: 1}]},
    ];
    expect(readouts.readoutProblems(measured, rows)).toEqual([
      'readout: title "Low Tide" font-size is 24px, expected 28px',
      'readout: title "Low Tide" font-weight is 600, expected 700',
      'readout: resume: nothing visible matches .r',
      'readout: dock "dock" width is 760px, expected ≤ 700px',
      'readout: lines "b" font-size is 12px, expected ≥ 13px',
    ]);
    expect(readouts.readoutProblems([{error: 'bad'}], [{name: 'x', selector: '::nope', box: {h: 1}}])).toEqual(['readout: x: bad selector ::nope (bad)']);
  });
});

describe('probe-perf.cjs', () => {
  const doc = {metrics: {openToPlayMs: {median: 2492.3}, relayout64Ms: {median: 44.6}, frameCostMs: {median: 7.07}, frameCostTracksMs: {median: 6.33}}};
  it('compares each metric with its FX0 baseline at ≤ 1.15×', () => {
    expect(perf.compare('relayout64', [44, 45, 50, 46, 47], doc)).toMatchObject({median: 46, baseline: 44.6, ratio: 1.031, ok: true});
    const slow = perf.compare('relayout64', [60, 61, 62, 63, 64], doc);
    expect(slow).toMatchObject({median: 62, ok: false});
    expect(slow.reason).toMatch(/1\.39× the baseline 44\.6 \(max 1\.15×\)/);
    // Exactly at the limit passes; just above it fails, even when the rounded ratio reads 1.15.
    expect(perf.compare('relayout64', [23], {metrics: {relayout64Ms: {median: 20}}})).toMatchObject({ratio: 1.15, ok: true});
    expect(perf.compare('relayout64', [6.9], {metrics: {relayout64Ms: {median: 6}}})).toMatchObject({ratio: 1.15, ok: true});
    expect(perf.compare('relayout64', [51.31], doc)).toMatchObject({ratio: 1.15, ok: false});
    expect(perf.compare('frameRoadmap', [7.29], doc).ok).toBe(false);
    expect(perf.compare('frameChart', [], doc)).toMatchObject({ok: false, reason: 'no finite median'});
    expect(perf.compare('openToPlay', [100], {metrics: {}})).toMatchObject({ok: false, reason: 'the baseline has no openToPlayMs median'});
    expect(perf.compare('openToPlay', [3000], doc, 1.25).ok).toBe(true);
  });
  it('maps the 2.0 metrics onto the 1.9 baselines', () => {
    expect(perf.BASELINE_KEY).toEqual({openToPlay: 'openToPlayMs', relayout64: 'relayout64Ms', frameChart: 'frameCostMs', frameRoadmap: 'frameCostTracksMs'});
  });
  it('computes per-frame costs from CDP snapshots and the rAF sample', () => {
    const stats = perf.frameStats({frames: 500, elapsedMs: 9990, intervals: [16, 16, 40, 17], loaf: [{blockingDuration: 20}, {blockingDuration: 5}], loafUnsupported: false},
      {TaskDuration: 2, ScriptDuration: 1, LayoutDuration: 0}, {TaskDuration: 5.5, ScriptDuration: 1.5, LayoutDuration: 0.5});
    expect(stats).toMatchObject({frameCostMs: 7, scriptMsPerFrame: 1, layoutMsPerFrame: 1, slowFrames: 1, intervalMaxMs: 40, longAnimationFrames: 2, blockingMs: 25});
    expect(perf.frameStats({frames: 0, elapsedMs: 0, intervals: [], loaf: [], loafUnsupported: true}, {}, {}).longAnimationFrames).toBeNull();
  });
  it('skips a metric whose page is not built yet instead of measuring a placeholder', () => {
    expect(perf.missingFor('relayout64')).toEqual([]);
    expect(perf.missingFor('frameChart', '/nonexistent')).toEqual(['src/stage/stage.js', 'src/stage/surfaces/chart-surface.js']);
    expect(perf.readOptions({}).wanted).toEqual(perf.ALL);
    expect(() => perf.readOptions({metrics: 'nope'})).toThrow(/Unknown metric/);
  });
});

describe('flows/VF1.cjs', () => {
  it('is a valid states module with unique names', () => {
    const states = require('./VF1.cjs');
    expect(() => validateStates(states, 'tests/fixture/flows/VF1.cjs')).not.toThrow();
    const names = states.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every(n => n.startsWith('vf1-'))).toBe(true);
  });
});

describe('flows/vf1-checks.cjs', () => {
  const fact = (size, extra) => ({size, weight: 400, transform: 'none', control: true, text: 't', cls: 'c', ...extra});
  it('holds 12 px everywhere and 14 px on coarse pointers, overlines excepted (spec §8.1)', () => {
    expect(checks.typeProblems([fact(12), fact(11.5)])).toEqual(['type below 12px: 11.5px "t" (c)']);
    expect(checks.typeProblems([fact(13)], {coarse: true})).toEqual(['type below 14px: 13px "t" (c)']);
    expect(checks.typeProblems([fact(14)], {coarse: true})).toEqual([]);
    // Prose outside a control keeps the 12 px floor on iPad (the Jobs popover's job.message, §2.8).
    expect(checks.typeProblems([fact(12, {control: false})], {coarse: true})).toEqual([]);
    expect(checks.typeProblems([fact(11, {control: false})], {coarse: true})).toEqual(['type below 12px: 11px "t" (c)']);
    // A 12/600 caps overline is allowed on iPad; 12 px caps at 400, or 11 px caps, are not.
    expect(checks.typeProblems([fact(12, {weight: 600, transform: 'uppercase'})], {coarse: true})).toEqual([]);
    expect(checks.typeProblems([fact(12, {transform: 'uppercase'})], {coarse: true})).toHaveLength(1);
    expect(checks.typeProblems([fact(11, {weight: 600, transform: 'uppercase'})])).toHaveLength(1);
  });
  it('fails the cover veil outside 55% ± 2% and when nothing was measured', () => {
    const ok = [{key: 'job:a', state: 'processing', alpha: 0.55}, {key: 'song:b', state: 'resplitting', alpha: 0.57}];
    expect(checks.veilProblems(ok)).toEqual([]);
    expect(checks.veilProblems([...ok, {key: 'job:c', state: 'processing', alpha: 0.60}])).toEqual(['job:c (processing) renders its cover at 60%, expected 55%']);
    expect(checks.veilProblems([...ok, {key: 'job:d', state: 'processing', alpha: 0.5}])).toHaveLength(1);
    expect(checks.veilProblems([{key: 'job:a', alpha: null}, {key: 'song:b', alpha: null}]))
      .toEqual(['veil not measurable: no processing (job:) card gave an alpha', 'veil not measurable: no re-splitting (song:) card gave an alpha']);
    expect(checks.veilProblems([...ok, {key: 'job:e', missing: true}])).toEqual(['job:e has no .lib-card-cover to measure']);
  });
  it('wants one " · " state line on every compact recent and names a recent without one', () => {
    expect(checks.recentsProblems([{title: 'A', text: '100% · practised 3 days ago', lines: 1}])).toEqual([]);
    expect(checks.recentsProblems([{title: 'A', text: '100%\npractised 3 days ago', lines: 2}])).toHaveLength(2);
    expect(checks.recentsProblems([{title: 'B', missing: true}])).toEqual(['"B" has no .lib-compact-line state line']);
  });
});

describe('flows/png.cjs', () => {
  const zlib = require('node:zlib');
  const png = require('./png.cjs');
  /** A PNG of `rows` (arrays of [r, g, b]) with one filter per row. */
  function encode(rows, filters) {
    const w = rows[0].length, h = rows.length;
    const raw = [];
    rows.forEach((row, y) => {
      const flat = row.flat(), prev = y ? rows[y - 1].flat() : flat.map(() => 0), f = filters[y];
      raw.push(f);
      flat.forEach((v, x) => {
        const a = x >= 3 ? flat[x - 3] : 0, b = prev[x], c = x >= 3 ? prev[x - 3] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
        raw.push((v - pred) & 0xff);
      });
    });
    const chunk = (type, body) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
      return Buffer.concat([len, Buffer.from(type, 'ascii'), body, Buffer.alloc(4)]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]);
  }
  const rows = [
    [[10, 20, 30], [200, 100, 50], [0, 255, 128]],
    [[40, 50, 60], [70, 80, 90], [100, 110, 120]],
    [[255, 0, 0], [0, 255, 0], [0, 0, 255]],
    [[1, 2, 3], [250, 251, 252], [128, 128, 128]],
    [[90, 9, 99], [33, 66, 99], [12, 34, 56]],
  ];
  it('decodes every scanline filter', () => {
    const img = png.decodePng(encode(rows, [0, 1, 2, 3, 4]));
    expect([img.width, img.height, img.channels]).toEqual([3, 5, 3]);
    expect([...img.data]).toEqual(rows.flat(2));
    expect(png.averageRgb(img, {x: 0, y: 2, w: 3, h: 1})).toEqual([85, 85, 85]);
  });
  it('refuses what it cannot read', () => {
    expect(() => png.decodePng(Buffer.from('not a png'))).toThrow(/not a PNG/);
  });
  it('fits the opacity of art composited over a flat colour', () => {
    const bg = [20, 20, 20];
    const art = png.decodePng(encode(rows, [0, 0, 0, 0, 0]));
    const veiled = rows.map(r => r.map(px => px.map((v, c) => Math.round(0.55 * v + 0.45 * bg[c]))));
    expect(png.fitAlpha(png.decodePng(encode(veiled, [0, 0, 0, 0, 0])), art, bg)).toBeCloseTo(0.55, 2);
    expect(png.fitAlpha(art, art, bg)).toBeCloseTo(1, 5);
    const flat = rows.map(r => r.map(() => [21, 20, 19]));
    const flatImg = png.decodePng(encode(flat, [0, 0, 0, 0, 0]));
    expect(png.fitAlpha(flatImg, flatImg, bg)).toBeNull();
    expect(png.parseRgb('rgba(18, 22, 21, 0.5)')).toEqual([18, 22, 21]);
    expect(png.effectiveAlpha([119, 20, 20], [200, 20, 20], [20, 20, 20])).toBeCloseTo(0.55, 2);
  });
});
