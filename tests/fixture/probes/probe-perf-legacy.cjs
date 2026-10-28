// 1.9 performance baseline probe (package FX0). Measures the pristine 1.9 app
// in the full-app fixture and writes tests/fixture/baselines/legacy/perf.json,
// which later ratio checks (probe-perf.cjs in VF2, ST9, ED7) compare with:
// each 2.0 measurement must be ≤ 1.15 × the median recorded here, measured in
// the same container. Re-record it there with this probe, unchanged, against a
// pristine worktree of 820f4db (see tests/fixture/baselines/legacy/manifest.json).
//
// Metrics (each the median of --runs runs after --warmup discarded runs; every
// run uses a fresh browser context; laptop viewport 1440×900, light):
//   openToPlayMs  navigation start of /?song=glasshouse&fx-jobs=0&fx-practice=chart
//                 → #play enabled with the player no longer busy or loading.
//   relayout64Ms  tests/fixture/harness/score-geometry.html?seconds=128 (64 bars
//                 of demoScore at 120 bpm, 1200 px wide): view.setScale(1.2) from
//                 1.0 → the score view's render callback (alphaTab render
//                 finished). This is the gated number. paintMs (the same plus 2
//                 animation frames, quantised to vsync) is kept as a secondary
//                 field only. The harness page carries no instrumentation.
//   frameCostMs        Glasshouse on the practice chart, playing for --seconds
//   frameCostTracksMs  (10 s), resp. on the practice tracks view (the 1.9
//                 waveform view, the road map's predecessor): main-thread task
//                 time per animation frame (CDP Performance TaskDuration delta ÷
//                 requestAnimationFrame callbacks). The run also records rAF
//                 intervals and long-animation-frame entries; those are a
//                 secondary check (the LoAF count should stay 0), not a ratio.
//
// Usage:
//   NODE_PATH=/opt/node-tools/node_modules node tests/fixture/probes/probe-perf-legacy.cjs [options]
//   --root <dir>      repository whose fixture to start (default: this one)
//   --port <n>        port for that server (default: a free port)
//   --url <base>      use a running fixture server instead (then pass --commit)
//   --runs 5 --warmup 1 --seconds 10   (integers ≥ 1, ≥ 0, number > 0)
//   --metrics openToPlay,relayout64,frameCost,frameCostTracks   subset to measure
//   --quiet-load 0.5  1-minute load average above which the result is marked
//                     provisional (validity.provisional in the output)
//   --out <file>      default tests/fixture/baselines/legacy/perf.json
//   --self-test       check the argument and statistics helpers without a browser
// Run it with nothing else busy in the container: the numbers are ratios'
// denominators. Exit codes: 0 written, 1 a run failed or timed out (nothing
// written), 2 setup failure (bad arguments, server or browser did not start).
'use strict';
const os = require('node:os');
const path = require('node:path');
const {parseArgs, numberArg, SetupError, withTimeout, startServer, gitCommit, writeJson, harnessReady, HARNESS, REPO} = require('./probe-geometry.cjs');

const DEFAULT_OUT = path.resolve(__dirname, '../baselines/legacy/perf.json');
const LAPTOP = {width: 1440, height: 900};
const SONG_URL = '/?song=glasshouse&fx-jobs=0&fx-practice=chart';
const VIEWS = {
  chart: {url: SONG_URL, ready: '.chart:not([hidden]) .score-engraving svg', label: 'the practice chart'},
  tracks: {url: '/?song=glasshouse&fx-jobs=0&fx-practice=tracks', ready: '#tracks .track-wave canvas', label: 'the practice tracks (waveform) view'},
};
const ALL = ['openToPlay', 'relayout64', 'frameCost', 'frameCostTracks'];
const RENDER_TIMEOUT = 60000;

/** Median of finite numbers; NaN for an empty list. */
const median = values => {
  if (!values.length) return NaN;
  const sorted = values.slice().sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = value => Math.round(value * 100) / 100;

// Installed before any app script: records when Play becomes usable, and every
// long animation frame from the start of the page.
function instrument() {
  window.__fx0 = {openReadyAt: null, loaf: []};
  const usable = () => {
    const root = document.getElementById('player-root');
    const play = document.getElementById('play');
    return !!(root && play && !play.disabled && !root.hasAttribute('aria-busy') && !root.querySelector('.player.is-loading'));
  };
  const check = () => {
    if (window.__fx0.openReadyAt == null && usable()) { window.__fx0.openReadyAt = performance.now(); observer.disconnect(); }
  };
  const observer = new MutationObserver(check);
  observer.observe(document, {subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'aria-busy', 'class']});
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries())
        window.__fx0.loaf.push({startTime: entry.startTime, duration: entry.duration, blockingDuration: entry.blockingDuration ?? 0});
    }).observe({type: 'long-animation-frame', buffered: true});
  } catch { window.__fx0.loafUnsupported = true; }
}

async function newPage(browser, errors, {instrumented = true} = {}) {
  const context = await browser.newContext({viewport: LAPTOP, deviceScaleFactor: 1, colorScheme: 'light'});
  if (instrumented) await context.addInitScript(instrument);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 300)}`); });
  page.on('dialog', dialog => dialog.dismiss());
  return {context, page};
}

async function openSong(page, base, url = SONG_URL) {
  await page.goto(`${base}${url}`, {waitUntil: 'commit'});
  await page.waitForFunction(() => window.__fx0?.openReadyAt != null, null, {timeout: 90000, polling: 50});
  return page.evaluate(() => window.__fx0.openReadyAt);
}

async function measureOpen(browser, base, errors) {
  const {context, page} = await newPage(browser, errors);
  try { return {openToPlayMs: round(await openSong(page, base))}; } finally { await context.close(); }
}

async function measureRelayout(browser, base, errors) {
  // No init script here: the open-to-Play observer would watch every mutation
  // of the timed relayout, overhead a 2.0 probe would not have.
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

async function measureFrames(browser, base, errors, seconds, view = VIEWS.chart) {
  const {context, page} = await newPage(browser, errors);
  try {
    await openSong(page, base, view.url);
    // The chart engraves (and the waveforms draw) after the player is usable.
    await page.waitForSelector(view.ready, {timeout: 60000});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.click('#play');
    await page.waitForSelector('#play[aria-label="Stop"]', {timeout: 30000});
    // Let the first scheduled audio and the follow scroll settle before sampling.
    await page.waitForTimeout(500);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable', {timeDomain: 'timeTicks'});
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const before = await metrics();
    const sample = await withTimeout(page.evaluate(durationMs => new Promise(resolve => {
      const stamps = [];
      const start = performance.now();
      const loafFrom = window.__fx0.loaf.length;
      const tick = now => {
        stamps.push(now);
        if (now - start < durationMs) requestAnimationFrame(tick);
        else {
          const intervals = stamps.slice(1).map((t, i) => t - stamps[i]);
          const loaf = window.__fx0.loaf.slice(loafFrom).filter(e => e.startTime >= start);
          resolve({frames: stamps.length, elapsedMs: stamps.at(-1) - start, intervals, loaf, loafUnsupported: !!window.__fx0.loafUnsupported});
        }
      };
      requestAnimationFrame(tick);
    }), seconds * 1000), seconds * 1000 + 30000, `frame sampling did not finish within ${seconds + 30} s`);
    const after = await metrics();
    const stillPlaying = await page.evaluate(() => document.getElementById('play')?.getAttribute('aria-label') === 'Stop');
    await page.click('#play').catch(() => {});
    if (!stillPlaying) throw new Error('playback stopped before the sampling window ended');
    const delta = name => (after[name] ?? 0) - (before[name] ?? 0);
    const frames = Math.max(1, sample.frames);
    const sorted = sample.intervals.slice().sort((a, b) => a - b);
    const pct = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
    return {
      frameCostMs: round(delta('TaskDuration') * 1000 / frames),
      frames: sample.frames,
      elapsedMs: round(sample.elapsedMs),
      scriptMsPerFrame: round(delta('ScriptDuration') * 1000 / frames),
      layoutMsPerFrame: round(delta('LayoutDuration') * 1000 / frames),
      styleMsPerFrame: round(delta('RecalcStyleDuration') * 1000 / frames),
      intervalMedianMs: round(pct(0.5)),
      intervalP95Ms: round(pct(0.95)),
      intervalMaxMs: round(sorted.at(-1) ?? 0),
      slowFrames: sample.intervals.filter(i => i > 25).length,
      longAnimationFrames: sample.loafUnsupported ? null : sample.loaf.length,
      longAnimationFrameMs: sample.loafUnsupported ? null : round(sample.loaf.reduce((sum, e) => sum + e.duration, 0)),
      blockingMs: sample.loafUnsupported ? null : round(sample.loaf.reduce((sum, e) => sum + e.blockingDuration, 0)),
    };
  } finally { await context.close(); }
}

async function series(label, runs, warmup, fn) {
  const kept = [];
  for (let i = 0; i < warmup + runs; i++) {
    const result = await fn();
    const counted = i >= warmup;
    if (counted) kept.push(result);
    console.log(`${label} ${counted ? `run ${i - warmup + 1}/${runs}` : `warm-up ${i + 1}/${warmup}`}: ${JSON.stringify(result)}`);
  }
  return kept;
}

/** Names of metrics whose median is not a finite number (nothing may be written then). */
function nonFiniteMedians(metrics) {
  return Object.entries(metrics).filter(([, value]) => !Number.isFinite(value.median)).map(([name]) => name);
}

/** Whether the container was busy enough that the numbers are only provisional. */
function validity(loadBefore, loadAfter, threshold) {
  const peak = Math.max(loadBefore[0], loadAfter[0]);
  const provisional = peak > threshold;
  return {
    provisional,
    quietLoadThreshold: threshold,
    reason: provisional
      ? `1-minute load average reached ${round(peak)} (> ${threshold}): other work was running. Re-record with the manifest command in a quiet container before computing ratios.`
      : `1-minute load average stayed at or below ${threshold}.`,
  };
}

function selfTest() {
  const assert = require('node:assert/strict');
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])), 'an empty series has no median');
  assert.deepEqual(nonFiniteMedians({a: {median: 1}, b: {median: NaN}, c: {median: null}}), ['b', 'c']);
  assert.equal(validity([0.2], [0.4], 0.5).provisional, false);
  assert.equal(validity([0.2], [1.19], 0.5).provisional, true);
  assert.throws(() => readOptions({warmup: 'abc'}), SetupError, '--warmup abc is refused');
  assert.throws(() => readOptions({runs: '0'}), SetupError, '--runs 0 is refused');
  assert.throws(() => readOptions({seconds: '-3'}), SetupError, '--seconds -3 is refused');
  assert.throws(() => readOptions({metrics: 'frameCost,nope'}), SetupError, 'an unknown metric is refused');
  assert.deepEqual(readOptions({warmup: '0', runs: '3', metrics: 'relayout64'}).wanted, ['relayout64']);
  assert.equal(readOptions({warmup: '0'}).warmup, 0, '--warmup 0 is honoured');
  assert.deepEqual(readOptions({}), {runs: 5, warmup: 1, seconds: 10, quietLoad: 0.5, wanted: ALL});
  console.log('probe-perf-legacy self-test: all checks passed');
}

function readOptions(args) {
  const runs = numberArg(args, 'runs', 5, {min: 1, integer: true});
  const warmup = numberArg(args, 'warmup', 1, {min: 0, integer: true});
  const seconds = numberArg(args, 'seconds', 10, {min: 0.1});
  const quietLoad = numberArg(args, 'quiet-load', 0.5, {min: 0});
  const wanted = typeof args.metrics === 'string' ? args.metrics.split(',').map(s => s.trim()).filter(Boolean) : ALL;
  const unknown = wanted.filter(name => !ALL.includes(name));
  if (unknown.length || !wanted.length) throw new SetupError(`Unknown metric(s): ${unknown.join(', ') || '(none given)'}; choose from ${ALL.join(', ')}.`);
  return {runs, warmup, seconds, quietLoad, wanted};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) { selfTest(); return 0; }
  let options;
  try { options = readOptions(args); } catch (error) { if (!(error instanceof SetupError)) throw error; console.error(error.message); return 2; }
  const {runs, warmup, seconds, quietLoad, wanted} = options;
  const out = path.resolve(args.out || DEFAULT_OUT);
  const root = path.resolve(args.root || REPO);

  let chromium;
  try { ({chromium} = require('playwright')); } catch { console.error('Playwright is not resolvable; run with NODE_PATH=/opt/node-tools/node_modules.'); return 2; }
  let server = null;
  let base = typeof args.url === 'string' ? args.url.replace(/\/$/, '') : null;
  try {
    if (!base) { server = await startServer({root, port: args.port, probePath: HARNESS}); base = server.base; }
  } catch (error) { console.error(error.message); return 2; }

  const loadBefore = os.loadavg();
  let browser;
  try { browser = await chromium.launch({args: ['--autoplay-policy=no-user-gesture-required']}); } catch (error) {
    console.error(`Cannot launch Chromium: ${error.message}`);
    await server?.stop();
    return 2;
  }
  const errors = [];
  const details = {};
  const metrics = {};
  let failed = null;
  try {
    if (wanted.includes('openToPlay')) {
      details.openToPlay = await series('openToPlay', runs, warmup, () => measureOpen(browser, base, errors));
      metrics.openToPlayMs = {
        median: round(median(details.openToPlay.map(r => r.openToPlayMs))), unit: 'ms', runs: details.openToPlay.map(r => r.openToPlayMs),
        method: `navigation start of ${SONG_URL} to #play enabled with #player-root not aria-busy and .player not .is-loading (performance.now() in the page)`,
      };
    }
    if (wanted.includes('relayout64')) {
      details.relayout64 = await series('relayout64', runs, warmup, () => measureRelayout(browser, base, errors));
      metrics.relayout64Ms = {
        median: round(median(details.relayout64.map(r => r.relayout64Ms))), unit: 'ms', runs: details.relayout64.map(r => r.relayout64Ms),
        method: `${HARNESS}?seconds=128 (64 bars of demoScore(128, 120), 1200 px, no page instrumentation): view.setScale(1.2) from 1.0 until the score view's render callback (alphaTab renderFinished); paintMs (secondary, not gated) adds 2 animation frames`,
        paintMsMedian: round(median(details.relayout64.map(r => r.paintMs))),
      };
    }
    for (const [name, key, view] of [['frameCost', 'frameCostMs', VIEWS.chart], ['frameCostTracks', 'frameCostTracksMs', VIEWS.tracks]]) {
      if (!wanted.includes(name)) continue;
      details[name] = await series(name, runs, warmup, () => measureFrames(browser, base, errors, seconds, view));
      metrics[key] = {
        median: round(median(details[name].map(r => r.frameCostMs))), unit: 'ms per frame', runs: details[name].map(r => r.frameCostMs),
        method: `${view.url} playing on ${view.label} for ${seconds} s: CDP Performance TaskDuration delta divided by requestAnimationFrame callbacks (the ratio denominator). intervalP95Ms, longAnimationFrames and blockingMs are secondary checks, not ratios.`,
      };
      for (const field of ['intervalP95Ms', 'scriptMsPerFrame', 'longAnimationFrames', 'blockingMs'])
        if (details[name].every(r => r[field] != null)) metrics[key][field] = round(median(details[name].map(r => r[field])));
    }
  } catch (error) {
    failed = error;
  }
  const chromiumVersion = browser.version();
  await browser.close();
  await server?.stop();

  if (failed) {
    console.error(`A run failed: ${failed.message}`);
    for (const line of errors) console.error(`  ${line}`);
    return 1;
  }
  if (errors.length) {
    console.error('The pages reported errors; not writing a baseline:');
    for (const line of errors) console.error(`  ${line}`);
    return 1;
  }
  const broken = nonFiniteMedians(metrics);
  if (broken.length) { console.error(`No finite median for ${broken.join(', ')}; not writing a baseline.`); return 1; }
  const loadAfter = os.loadavg();
  const valid = validity(loadBefore, loadAfter, quietLoad);
  if (valid.provisional) console.warn(`Warning: ${valid.reason}`);
  writeJson(out, {
    probe: 'probe-perf-legacy', version: 1,
    source: {commit: typeof args.commit === 'string' ? args.commit : gitCommit(root), app: '1.9 full-app fixture (tests/fixture at 820f4db)'},
    recordedAt: new Date().toISOString(),
    environment: {
      chromium: chromiumVersion, node: process.version, platform: `${os.platform()} ${os.release()}`,
      cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? null, memoryGb: round(os.totalmem() / 2 ** 30),
      loadAverage: {before: loadBefore.map(round), after: loadAfter.map(round)}, viewport: LAPTOP, headless: true,
    },
    validity: valid,
    runs, warmup,
    rule: 'a 2.0 measurement passes when it is at most 1.15 × metrics.<name>.median from the same container',
    metrics,
    details,
  });
  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
  for (const [name, value] of Object.entries(metrics)) console.log(`  ${name}: median ${value.median} ${value.unit} (runs ${value.runs.join(', ')})`);
  return 0;
}

module.exports = {median, nonFiniteMedians, validity, readOptions, VIEWS, ALL};

if (require.main === module) {
  main().then(code => process.exit(code), error => { console.error(error?.stack || error); process.exit(2); });
}
