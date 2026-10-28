// 2.0 performance probe (architecture §11.5; used by the verification packages and the
// ST9/ED7 acceptance). Run it with nothing else busy in the container: every number is a
// ratio to FX0's tests/fixture/baselines/legacy/perf.json, recorded in the same container
// by probe-perf-legacy.cjs, and passes at ≤ 1.15 × that baseline's median.
//
// Metrics (each the median of --runs runs after --warmup discarded runs; a fresh browser
// context per run; laptop 1440×900, light):
//   openToPlay      navigation start of /s/glasshouse?fx-jobs=0 → the Stage root reports
//                   data-load-phase="ready" and transport.playStop is enabled
//                   (window.__woodshed.commands.isEnabled).          baseline openToPlayMs
//   relayout64      FX0's score-geometry harness (64 bars of demoScore at 120 bpm, 1200 px):
//                   setScale(1.2) from 1.0 → the score view's render callback.
//                   It measures the score view the chart surface hosts.  baseline relayout64Ms
//   frameChart      the Stage on the chart surface (view.chart), playing for --seconds:
//   frameRoadmap    resp. on the road map (view.roadmap, the tracks view's successor):
//                   CDP Performance TaskDuration delta ÷ requestAnimationFrame callbacks,
//                   plus rAF intervals and long-animation-frame entries (secondary).
//                                                     baselines frameCostMs, frameCostTracksMs
// A metric whose page does not exist yet (the files in REQUIRES are missing, as before the
// Stage lands at I2b) is reported as skipped with the missing files, never measured against a
// placeholder; --strict-requires fails it instead (integrations and verification after I2b).
//
// Usage:
//   NODE_PATH=/opt/node-tools/node_modules node tests/fixture/probes/probe-perf.cjs [options]
//   --url <base>          a running fixture (default: start one from FIXTURE_PORT or a free port)
//   --runs 5 --warmup 1 --seconds 10
//   --metrics openToPlay,relayout64,frameChart,frameRoadmap
//   --baseline <file>     default tests/fixture/baselines/legacy/perf.json
//   --max-ratio 1.15      --quiet-load 0.5 (as probe-perf-legacy: above it the result is provisional)
//   --out <file>          the JSON report (default tests/fixture/out/perf.json)
//   --strict-requires     a metric whose page is missing fails
//   --self-test           the pure helpers, no browser
// Exit codes: 0 every measured metric within its ratio; 1 a ratio exceeded, a run failed or a
// page reported an error; 2 a setup failure.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {parseArgs, numberArg, SetupError, withTimeout, startServer, gitCommit, writeJson, harnessReady, HARNESS, REPO} = require('./probe-geometry.cjs');
const {median, validity} = require('./probe-perf-legacy.cjs');

const LAPTOP = {width: 1440, height: 900};
const DEFAULT_BASELINE = path.resolve(__dirname, '../baselines/legacy/perf.json');
const DEFAULT_OUT = path.resolve(__dirname, '../out/perf.json');
const STAGE_URL = '/s/glasshouse?fx-jobs=0&fx-reset=1';
const MAX_RATIO = 1.15;
const RENDER_TIMEOUT = 60_000;
const ALL = ['openToPlay', 'relayout64', 'frameChart', 'frameRoadmap'];
const BASELINE_KEY = {openToPlay: 'openToPlayMs', relayout64: 'relayout64Ms', frameChart: 'frameCostMs', frameRoadmap: 'frameCostTracksMs'};
const VALUE_KEY = {openToPlay: 'openToPlayMs', relayout64: 'relayout64Ms', frameChart: 'frameCostMs', frameRoadmap: 'frameCostMs'};
const REQUIRES = {
  openToPlay: ['src/stage/stage.js'],
  relayout64: [HARNESS, 'tests/fixture/harness/score-geometry.js'],
  frameChart: ['src/stage/stage.js', 'src/stage/surfaces/chart-surface.js'],
  frameRoadmap: ['src/stage/stage.js', 'src/stage/surfaces/roadmap-surface.js'],
};
const SURFACES = {
  frameChart: {command: 'view.chart', ready: '[data-rendered]:not([data-rendered="false"])', label: 'the Stage chart surface'},
  frameRoadmap: {command: 'view.roadmap', ready: '[data-peaks-ready]:not([data-peaks-ready="false"])', label: 'the Stage road map'},
};

const round = value => Math.round(value * 100) / 100;

/** The files a metric needs that do not exist under `root`. */
function missingFor(metric, root = REPO) {
  return (REQUIRES[metric] ?? []).filter(p => !fs.existsSync(path.join(root, p)));
}

/** Pure verdict for one metric: {median, baseline, ratio, ok, reason}. */
function compare(metric, values, baselineDoc, maxRatio = MAX_RATIO) {
  const base = baselineDoc?.metrics?.[BASELINE_KEY[metric]]?.median;
  const med = round(median(values));
  if (!Number.isFinite(med)) return {median: null, baseline: base ?? null, ratio: null, ok: false, reason: 'no finite median'};
  if (!Number.isFinite(base) || base <= 0) return {median: med, baseline: null, ratio: null, ok: false, reason: `the baseline has no ${BASELINE_KEY[metric]} median`};
  const ratio = Math.round(med / base * 1000) / 1000;
  const ok = ratio <= maxRatio;
  return {median: med, baseline: base, ratio, ok, reason: ok ? null : `${metric} median ${med} is ${ratio}× the baseline ${base} (max ${maxRatio}×)`};
}

// Installed before any app script: when the Stage first becomes playable, and every long
// animation frame from the start of the page.
function instrument() {
  window.__perf = {openReadyAt: null, loaf: []};
  const playable = () => {
    const root = document.querySelector('[data-load-phase]');
    if (!root || root.getAttribute('data-load-phase') !== 'ready') return false;
    try { return !!window.__woodshed?.commands?.isEnabled('transport.playStop'); } catch { return false; }
  };
  let observer = null;
  const check = () => {
    if (window.__perf.openReadyAt == null && playable()) { window.__perf.openReadyAt = performance.now(); observer?.disconnect(); }
  };
  observer = new MutationObserver(check);
  observer.observe(document, {subtree: true, childList: true, attributes: true, attributeFilter: ['data-load-phase', 'disabled', 'aria-disabled']});
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries())
        window.__perf.loaf.push({startTime: entry.startTime, duration: entry.duration, blockingDuration: entry.blockingDuration ?? 0});
    }).observe({type: 'long-animation-frame', buffered: true});
  } catch { window.__perf.loafUnsupported = true; }
}

async function newPage(browser, errors, {instrumented = true} = {}) {
  const context = await browser.newContext({viewport: LAPTOP, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC'});
  if (instrumented) await context.addInitScript(instrument);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 300)}`); });
  page.on('dialog', dialog => dialog.dismiss());
  return {context, page};
}

async function openStage(page, base) {
  await page.goto(`${base}${STAGE_URL}`, {waitUntil: 'commit'});
  await page.waitForFunction(() => window.__perf?.openReadyAt != null, null, {timeout: 90_000, polling: 50});
  return page.evaluate(() => window.__perf.openReadyAt);
}

async function measureOpen(browser, base, errors) {
  const {context, page} = await newPage(browser, errors);
  try { return {openToPlayMs: round(await openStage(page, base))}; } finally { await context.close(); }
}

async function measureRelayout(browser, base, errors) {
  const {context, page} = await newPage(browser, errors, {instrumented: false});
  try {
    const query = new URLSearchParams({scale: '1', width: '1200', seconds: '128', bpm: '120', layout: 'combined'});
    await page.goto(`${base}/${HARNESS}?${query}`, {waitUntil: 'load'});
    const geometry = await harnessReady(page, RENDER_TIMEOUT);
    if (geometry.barCount !== 64) throw new Error(`the relayout harness engraved ${geometry.barCount} bars, expected 64`);
    const result = await withTimeout(page.evaluate(() => window.scoreGeometry.relayout(1.2)), RENDER_TIMEOUT,
      `the relayout to 120% did not render within ${RENDER_TIMEOUT} ms`);
    return {relayout64Ms: result.renderMs, paintMs: result.paintMs, systemsBefore: geometry.barsPerSystem.length};
  } finally { await context.close(); }
}

async function measureFrames(browser, base, errors, seconds, surface) {
  const {context, page} = await newPage(browser, errors);
  try {
    await openStage(page, base);
    await page.evaluate(id => window.__woodshed.commands.run(id), surface.command);
    await page.waitForSelector(surface.ready, {state: 'attached', timeout: RENDER_TIMEOUT});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => window.__woodshed.commands.run('transport.playStop'));
    await page.waitForSelector('[data-transport-phase="playing"]', {state: 'attached', timeout: 30_000});
    await page.waitForTimeout(500);   // the first scheduled audio and the follow scroll settle
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable', {timeDomain: 'timeTicks'});
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const before = await metrics();
    const sample = await withTimeout(page.evaluate(durationMs => new Promise(resolve => {
      const stamps = [], start = performance.now(), loafFrom = window.__perf.loaf.length;
      const tick = now => {
        stamps.push(now);
        if (now - start < durationMs) { requestAnimationFrame(tick); return; }
        const intervals = stamps.slice(1).map((t, i) => t - stamps[i]);
        const loaf = window.__perf.loaf.slice(loafFrom).filter(e => e.startTime >= start);
        resolve({frames: stamps.length, elapsedMs: stamps.at(-1) - start, intervals, loaf, loafUnsupported: !!window.__perf.loafUnsupported});
      };
      requestAnimationFrame(tick);
    }), seconds * 1000), seconds * 1000 + 30_000, `frame sampling did not finish within ${seconds + 30} s`);
    const after = await metrics();
    const stillPlaying = await page.evaluate(() => document.querySelector('[data-transport-phase]')?.getAttribute('data-transport-phase') === 'playing');
    await page.evaluate(() => window.__woodshed.commands.run('transport.playStop')).catch(() => {});
    if (!stillPlaying) throw new Error('playback stopped before the sampling window ended');
    return frameStats(sample, before, after);
  } finally { await context.close(); }
}

/** Pure: per-frame costs from a rAF sample and two CDP Performance.getMetrics snapshots. */
function frameStats(sample, before, after) {
  const delta = name => (after[name] ?? 0) - (before[name] ?? 0);
  const frames = Math.max(1, sample.frames);
  const sorted = sample.intervals.slice().sort((a, b) => a - b);
  const pct = p => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  return {
    frameCostMs: round(delta('TaskDuration') * 1000 / frames),
    frames: sample.frames,
    elapsedMs: round(sample.elapsedMs),
    scriptMsPerFrame: round(delta('ScriptDuration') * 1000 / frames),
    layoutMsPerFrame: round(delta('LayoutDuration') * 1000 / frames),
    intervalP95Ms: round(pct(0.95)),
    intervalMaxMs: round(sorted.at(-1) ?? 0),
    slowFrames: sample.intervals.filter(i => i > 25).length,
    longAnimationFrames: sample.loafUnsupported ? null : sample.loaf.length,
    blockingMs: sample.loafUnsupported ? null : round(sample.loaf.reduce((sum, e) => sum + e.blockingDuration, 0)),
  };
}

async function series(label, runs, warmup, fn) {
  const kept = [];
  for (let i = 0; i < warmup + runs; i++) {
    const result = await fn();
    if (i >= warmup) kept.push(result);
    console.log(`${label} ${i >= warmup ? `run ${i - warmup + 1}/${runs}` : `warm-up ${i + 1}/${warmup}`}: ${JSON.stringify(result)}`);
  }
  return kept;
}

function readOptions(args) {
  const runs = numberArg(args, 'runs', 5, {min: 1, integer: true});
  const warmup = numberArg(args, 'warmup', 1, {min: 0, integer: true});
  const seconds = numberArg(args, 'seconds', 10, {min: 0.1});
  const quietLoad = numberArg(args, 'quiet-load', 0.5, {min: 0});
  const maxRatio = numberArg(args, 'max-ratio', MAX_RATIO, {min: 1});
  const wanted = typeof args.metrics === 'string' ? args.metrics.split(',').map(s => s.trim()).filter(Boolean) : ALL;
  const unknown = wanted.filter(name => !ALL.includes(name));
  if (unknown.length || !wanted.length) throw new SetupError(`Unknown metric(s): ${unknown.join(', ') || '(none given)'}; choose from ${ALL.join(', ')}.`);
  return {runs, warmup, seconds, quietLoad, maxRatio, wanted, strict: !!args['strict-requires']};
}

function selfTest() {
  const assert = require('node:assert/strict');
  const doc = {metrics: {openToPlayMs: {median: 2000}, relayout64Ms: {median: 40}, frameCostMs: {median: 7}, frameCostTracksMs: {median: 6}}};
  assert.deepEqual(compare('relayout64', [40, 44, 46], doc), {median: 44, baseline: 40, ratio: 1.1, ok: true, reason: null});
  const slow = compare('openToPlay', [2400, 2500, 2300], doc);
  assert.equal(slow.ok, false); assert.equal(slow.ratio, 1.2); assert.match(slow.reason, /1\.2× the baseline 2000/);
  assert.equal(compare('frameRoadmap', [6.9], doc).ratio, 1.15, 'the road map compares with the tracks view');
  assert.equal(compare('frameRoadmap', [6.9], doc).ok, true, 'exactly 1.15× passes');
  assert.equal(compare('frameChart', [], doc).ok, false, 'no runs fail');
  assert.match(compare('frameChart', [7], {metrics: {}}).reason, /no frameCostMs median/);
  const stats = frameStats({frames: 600, elapsedMs: 10000, intervals: [16, 17, 30, 16], loaf: [{blockingDuration: 12}], loafUnsupported: false},
    {TaskDuration: 1, ScriptDuration: 0.2, LayoutDuration: 0.1}, {TaskDuration: 5.2, ScriptDuration: 0.8, LayoutDuration: 0.4});
  assert.equal(stats.frameCostMs, 7); assert.equal(stats.scriptMsPerFrame, 1); assert.equal(stats.slowFrames, 1);
  assert.equal(stats.longAnimationFrames, 1); assert.equal(stats.blockingMs, 12); assert.equal(stats.intervalMaxMs, 30);
  assert.deepEqual(missingFor('relayout64'), [], 'FX0\'s harness is committed');
  assert.deepEqual(missingFor('openToPlay', '/nonexistent'), ['src/stage/stage.js']);
  assert.throws(() => readOptions({metrics: 'frameChart,nope'}), SetupError);
  assert.deepEqual(readOptions({}).wanted, ALL);
  assert.equal(readOptions({'strict-requires': true}).strict, true);
  console.log('probe-perf self-test: all checks passed');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args['self-test']) { selfTest(); return 0; }
  let options, baselineDoc;
  try {
    options = readOptions(args);
    const file = path.resolve(typeof args.baseline === 'string' ? args.baseline : DEFAULT_BASELINE);
    if (!fs.existsSync(file)) throw new SetupError(`No baseline at ${path.relative(process.cwd(), file)} (FX0 records it with probe-perf-legacy.cjs)`);
    baselineDoc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (!(error instanceof SetupError)) throw error; console.error(error.message); return 2; }
  const {runs, warmup, seconds, quietLoad, maxRatio, wanted, strict} = options;
  const out = path.resolve(typeof args.out === 'string' ? args.out : DEFAULT_OUT);

  const results = {};
  const toMeasure = [];
  for (const metric of wanted) {
    const missing = missingFor(metric);
    if (missing.length) results[metric] = {skipped: !strict, ok: !strict, missing, reason: `requires ${missing.join(', ')}`};
    else toMeasure.push(metric);
  }
  for (const [metric, r] of Object.entries(results)) console.log(`${r.ok ? 'skip' : 'FAIL'} ${metric}: ${r.reason}`);

  const errors = [], details = {};
  let failed = null, chromiumVersion = null, server = null, browser = null;
  const loadBefore = os.loadavg();
  if (toMeasure.length) {
    let chromium;
    try { ({chromium} = require('playwright')); } catch { console.error('Playwright is not resolvable; run with NODE_PATH=/opt/node-tools/node_modules.'); return 2; }
    let base = typeof args.url === 'string' ? args.url.replace(/\/$/, '') : null;
    try {
      if (!base) {
        const port = args.port ?? (process.env.FIXTURE_PORT ? Number(process.env.FIXTURE_PORT) : undefined);
        server = await startServer({root: REPO, port, probePath: HARNESS});
        base = server.base;
      }
      browser = await chromium.launch({args: ['--autoplay-policy=no-user-gesture-required']});
    } catch (error) { console.error(error.message); await server?.stop(); return 2; }
    try {
      for (const metric of toMeasure) {
        const run = {
          openToPlay: () => measureOpen(browser, base, errors),
          relayout64: () => measureRelayout(browser, base, errors),
          frameChart: () => measureFrames(browser, base, errors, seconds, SURFACES.frameChart),
          frameRoadmap: () => measureFrames(browser, base, errors, seconds, SURFACES.frameRoadmap),
        }[metric];
        details[metric] = await series(metric, runs, warmup, run);
        const values = details[metric].map(r => r[VALUE_KEY[metric]]);
        results[metric] = {skipped: false, runs: values, ...compare(metric, values, baselineDoc, maxRatio)};
        for (const field of ['paintMs', 'intervalP95Ms', 'longAnimationFrames', 'blockingMs'])
          if (details[metric].every(r => r[field] != null)) results[metric][`${field}Median`] = round(median(details[metric].map(r => r[field])));
      }
    } catch (error) { failed = error; }
    chromiumVersion = browser.version();
    await browser.close();
    await server?.stop();
  }
  const loadAfter = os.loadavg();
  const valid = validity(loadBefore, loadAfter, quietLoad);
  const report = {
    probe: 'probe-perf', version: 1, commit: gitCommit(REPO), recordedAt: new Date().toISOString(),
    environment: {chromium: chromiumVersion, node: process.version, cpus: os.cpus().length, loadAverage: {before: loadBefore.map(round), after: loadAfter.map(round)}, viewport: LAPTOP},
    validity: valid,
    baseline: {file: path.relative(REPO, path.resolve(typeof args.baseline === 'string' ? args.baseline : DEFAULT_BASELINE)), recordedAt: baselineDoc.recordedAt ?? null, provisional: !!baselineDoc.validity?.provisional},
    rule: `each metric's median ≤ ${maxRatio} × the baseline median`,
    runs, warmup, seconds, results, details,
    failure: failed ? failed.message : null, errors,
  };
  writeJson(out, report);
  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
  if (valid.provisional) console.warn(`Warning: ${valid.reason}`);
  if (report.baseline.provisional) console.warn('Warning: the baseline itself is marked provisional (recorded in a busy container); ratios are indicative until FX0 re-records it in a quiet one.');
  if (failed) { console.error(`A run failed: ${failed.message}`); for (const line of errors) console.error(`  ${line}`); return 1; }
  if (errors.length) { console.error('The pages reported errors:'); for (const line of errors) console.error(`  ${line}`); return 1; }
  let ok = true;
  for (const [metric, r] of Object.entries(results)) {
    if (r.skipped) continue;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${metric}: ${r.median ?? '—'} vs ${r.baseline ?? '—'} (${r.ratio ?? '—'}×)${r.reason ? ` — ${r.reason}` : ''}`);
    if (!r.ok) ok = false;
  }
  return ok ? 0 : 1;
}

module.exports = {ALL, REQUIRES, BASELINE_KEY, MAX_RATIO, STAGE_URL, missingFor, compare, frameStats, readOptions, instrument, main};

if (require.main === module) {
  main().then(code => process.exit(code), error => { console.error(error?.stack || error); process.exit(2); });
}
