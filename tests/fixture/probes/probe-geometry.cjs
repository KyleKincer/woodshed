// Engraving geometry probe (package FX0; re-run unchanged by ST3, ED5, ED7
// and VF2). Loads the standalone harness tests/fixture/harness/score-geometry.html
// (demoScore(64, 120) through createScoreView at a fixed 1200 px width) at
// scales 1.0 and 1.2 and compares, per scale, with the recorded baseline:
//   - bars per system must be identical;
//   - every notehead must exist, in the same bar, within ±2 px of its
//     position relative to the bar origin (bar left edge, top staff line).
//
// Usage (Playwright from /opt/node-tools, never a package dependency):
//   NODE_PATH=/opt/node-tools/node_modules node tests/fixture/probes/probe-geometry.cjs [options]
// Options:
//   --record              write the baseline instead of comparing with it
//   --baseline <file>     default tests/fixture/baselines/legacy/score-geometry.json
//   --out <file>          comparison report (default tests/fixture/out/probe-geometry.json)
//   --url <base>          use a running fixture server instead of starting one
//   --root <dir>          repository whose fixture server to start (default: this one)
//   --port <n>            port for the server this probe starts (default: a free port)
//   --tolerance <px>      notehead position and size tolerance (default 2, or the baseline's)
//   --timeout <ms>        how long one engraving may take (default 60000)
//   --scales 1,1.2 --width 1200 --seconds 64 --bpm 120   (recording only; a
//                         comparison always uses the baseline's settings)
//   --self-test           check the comparison logic without a browser
// Exit codes: 0 match (or recorded); 1 mismatch, page error, harness render
// failure or render timeout (the server answered but the engraving is wrong or
// missing); 2 setup failure (bad arguments, no baseline, Playwright missing,
// the server could not start or does not serve the harness).
//
// Other probes can reuse the pieces: require('./probe-geometry.cjs') exports
// startServer, measureHarness (settings may carry `harness`, another page path,
// and `query`, extra URL parameters) and compareGeometry (pure, two
// measurements of one scale), so two live measurements can be compared.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const {spawn, execFileSync} = require('node:child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '../../..');
const HARNESS = 'tests/fixture/harness/score-geometry.html';
const DEFAULT_BASELINE = path.resolve(HERE, '../baselines/legacy/score-geometry.json');
const DEFAULT_REPORT = path.resolve(HERE, '../out/probe-geometry.json');
const VIEWPORT = {width: 1280, height: 900};

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument ${arg}`);
    const body = arg.slice(2), eq = body.indexOf('=');
    const name = eq < 0 ? body : body.slice(0, eq);
    const inline = eq < 0 ? null : body.slice(eq + 1);
    if (inline != null) out[name] = inline;
    else if (argv[i + 1] != null && !argv[i + 1].startsWith('--')) out[name] = argv[++i];
    else out[name] = true;
  }
  return out;
}

/** A failure before anything was measured: bad input or infrastructure (exit 2). */
class SetupError extends Error {}

/**
 * Read a numeric option. Absent → `fallback`; present but not a finite number
 * within [min, max] (or not an integer when `integer`) → SetupError.
 */
function numberArg(args, name, fallback, {min = -Infinity, max = Infinity, integer = false} = {}) {
  if (args[name] == null) return fallback;
  const text = typeof args[name] === 'string' ? args[name].trim() : '';
  const value = text === '' ? NaN : Number(text);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    throw new SetupError(`--${name} must be ${integer ? 'an integer' : 'a number'}${min > -Infinity ? ` ≥ ${min}` : ''}${max < Infinity ? ` ≤ ${max}` : ''}, got ${JSON.stringify(args[name])}`);
  return value;
}

/** Reject with `message` if `promise` has not settled within `ms`. */
function withTimeout(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// ------------------------------------------------------------ fixture server
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const {port} = server.address(); server.close(() => resolve(port)); });
  });
}

function portIsFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function httpStatus(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.setTimeout(2000, () => { req.destroy(); resolve(0); });
  });
}

const children = new Set();
const scratchCaches = new Set();
function killChild(child, signal) {
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
}
function removeCache(dir) { try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best effort */ } scratchCaches.delete(dir); }
process.on('exit', () => {
  for (const child of children) killChild(child, 'SIGKILL');
  for (const dir of [...scratchCaches]) removeCache(dir);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

/**
 * Start the fixture's Vite server for `root` on `port` (a free one by default)
 * and wait until it serves `probePath`. Returns {base, port, stop}. A per-port
 * Vite cache (tests/fixture/.vite-cache/<port>) that this call created is
 * removed again by stop(), so probe runs on random ports leave nothing behind.
 */
async function startServer({root = REPO, port, probePath = HARNESS, timeoutMs = 90000} = {}) {
  const config = path.join(root, 'tests/fixture/vite.config.mjs');
  const vite = path.join(root, 'node_modules/vite/bin/vite.js');
  for (const file of [config, vite, path.join(root, probePath)])
    if (!fs.existsSync(file)) throw new SetupError(`Cannot start the fixture: ${file} is missing${file.endsWith(probePath) ? ` (copy it from ${path.join(REPO, probePath)}; see tests/fixture/baselines/legacy/manifest.json)` : ''}`);
  const chosen = port == null || port === true ? await freePort() : Number(port);
  if (!Number.isInteger(chosen) || chosen < 1 || chosen > 65535) throw new SetupError(`Bad port ${JSON.stringify(port)}`);
  // Another server answering on the port would be measured instead of `root`.
  if (!await portIsFree(chosen)) throw new SetupError(`Port ${chosen} is already in use; stop that server or pass --url to use it.`);
  const cache = path.join(root, 'tests/fixture/.vite-cache', String(chosen));
  if (!fs.existsSync(cache)) scratchCaches.add(cache);
  const child = spawn(process.execPath, [vite, '--config', config, '--port', String(chosen), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, FIXTURE_PORT: String(chosen), BROWSER: 'none'},
  });
  children.add(child);
  let log = '';
  const keep = chunk => { log = (log + chunk).slice(-8000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = null;
  child.on('exit', code => { exited = code ?? 'signal'; children.delete(child); });
  const base = `http://127.0.0.1:${chosen}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited != null) { removeCache(cache); throw new SetupError(`The fixture server exited (${exited}):\n${log}`); }
    if (await httpStatus(`${base}/${probePath}`) === 200) break;
    if (Date.now() > deadline) { killChild(child, 'SIGKILL'); throw new SetupError(`The fixture server did not answer within ${timeoutMs} ms:\n${log}`); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const cleanup = () => { if (scratchCaches.has(cache)) removeCache(cache); };
  const stop = () => new Promise(resolve => {
    if (exited != null) { cleanup(); resolve(); return; }
    const force = setTimeout(() => killChild(child, 'SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(force); cleanup(); resolve(); });
    killChild(child, 'SIGTERM');
  });
  return {base, port: chosen, stop};
}

function gitCommit(root) {
  try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(); } catch { return null; }
}

// ---------------------------------------------------------------- harness
function harnessUrl(base, {scale, width, seconds, bpm, layout, harness = HARNESS, query: extra = {}}) {
  const query = new URLSearchParams({scale: String(scale), width: String(width), seconds: String(seconds), bpm: String(bpm), layout, ...extra});
  return `${base.replace(/\/$/, '')}/${harness}?${query}`;
}

const DEFAULT_RENDER_TIMEOUT = 60000;

/**
 * Wait for the harness on `page` (already navigated) to finish its first
 * engraving and resolve that measurement. Rejects when the engraving fails or
 * takes longer than `timeoutMs`, so a callback that never fires cannot hang.
 */
async function harnessReady(page, timeoutMs = DEFAULT_RENDER_TIMEOUT) {
  const started = Date.now();
  await page.waitForFunction(() => window.scoreGeometry || document.documentElement.dataset.harnessError, null, {timeout: timeoutMs})
    .catch(() => { throw new Error(`the harness did not start within ${timeoutMs} ms (window.scoreGeometry never appeared)`); });
  const left = Math.max(1000, timeoutMs - (Date.now() - started));
  return withTimeout(page.evaluate(() => window.scoreGeometry.ready), left,
    `the harness did not render within ${timeoutMs} ms (the score view never reported a finished render)`);
}

/**
 * Open a harness page in `browser` and resolve its first measurement. Page
 * errors are collected into `errors`. Throws SetupError when the server does
 * not serve the page, and a plain Error when it renders wrongly or too slowly.
 */
async function measureHarness(browser, base, settings, errors = [], {timeoutMs = DEFAULT_RENDER_TIMEOUT} = {}) {
  const context = await browser.newContext({viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: 'light'});
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 300)}`); });
  page.on('requestfailed', request => errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`));
  try {
    const url = harnessUrl(base, settings);
    let response;
    try { response = await page.goto(url, {waitUntil: 'load', timeout: timeoutMs}); } catch (error) { throw new SetupError(`Cannot load ${url}: ${error.message}`); }
    if (response && !response.ok()) throw new SetupError(`${url} answered HTTP ${response.status()}; is the harness served there?`);
    return await harnessReady(page, timeoutMs);
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------- comparison
/**
 * Compare one scale's geometry with its baseline. Pure.
 * @returns {{pass, barCount, barsPerSystem, notes, problems: string[]}}
 */
function compareGeometry(expected, actual, tolerance = 2) {
  const problems = [];
  const barCount = {expected: expected.barCount, actual: actual.barCount};
  if (expected.barCount !== actual.barCount) problems.push(`bar count ${actual.barCount}, expected ${expected.barCount}`);
  const bps = {expected: expected.barsPerSystem, actual: actual.barsPerSystem, equal: true};
  const systems = Math.max(expected.barsPerSystem.length, actual.barsPerSystem.length);
  for (let k = 0; k < systems; k++) {
    if (expected.barsPerSystem[k] === actual.barsPerSystem[k]) continue;
    bps.equal = false;
    bps.firstDifference = k;
    problems.push(`bars per system differ from system ${k + 1}: ${actual.barsPerSystem[k] ?? 'none'} bars, expected ${expected.barsPerSystem[k] ?? 'none'}`);
    break;
  }
  const byKey = new Map(actual.notes.map(note => [note.key, note]));
  const missing = [], outOfTolerance = [];
  let maxDx = 0, maxDy = 0, maxDw = 0, maxDh = 0;
  for (const note of expected.notes) {
    const other = byKey.get(note.key);
    if (!other) { missing.push(note.key); continue; }
    byKey.delete(note.key);
    const ddx = Math.abs(other.dx - note.dx), ddy = Math.abs(other.dy - note.dy);
    // Box size: a notehead engraved larger or smaller than the baseline fails
    // even when its origin stays put (missing sizes compare as equal).
    const ddw = Number.isFinite(note.w) && Number.isFinite(other.w) ? Math.abs(other.w - note.w) : 0;
    const ddh = Number.isFinite(note.h) && Number.isFinite(other.h) ? Math.abs(other.h - note.h) : 0;
    maxDx = Math.max(maxDx, ddx);
    maxDy = Math.max(maxDy, ddy);
    maxDw = Math.max(maxDw, ddw);
    maxDh = Math.max(maxDh, ddh);
    if (Math.max(ddx, ddy, ddw, ddh) > tolerance + 1e-6)
      outOfTolerance.push({key: note.key, expected: {dx: note.dx, dy: note.dy, w: note.w, h: note.h}, actual: {dx: other.dx, dy: other.dy, w: other.w, h: other.h},
        delta: {dx: round(other.dx - note.dx), dy: round(other.dy - note.dy), w: round(ddw ? other.w - note.w : 0), h: round(ddh ? other.h - note.h : 0)}});
  }
  const worstOf = d => Math.max(Math.abs(d.dx), Math.abs(d.dy), Math.abs(d.w), Math.abs(d.h));
  const extra = [...byKey.keys()];
  if (missing.length) problems.push(`${missing.length} notehead(s) missing, e.g. ${missing.slice(0, 5).join(', ')}`);
  if (extra.length) problems.push(`${extra.length} unexpected notehead(s), e.g. ${extra.slice(0, 5).join(', ')}`);
  outOfTolerance.sort((a, b) => worstOf(b.delta) - worstOf(a.delta));
  if (outOfTolerance.length) {
    const worst = outOfTolerance[0];
    problems.push(`${outOfTolerance.length} notehead(s) moved or resized more than ${tolerance} px relative to their bar origin, worst ${worst.key} by position (${worst.delta.dx}, ${worst.delta.dy}) size (${worst.delta.w}, ${worst.delta.h})`);
  }
  return {
    pass: problems.length === 0,
    barCount,
    barsPerSystem: bps,
    notes: {expected: expected.notes.length, actual: actual.notes.length, missing, extra, outOfTolerance: outOfTolerance.slice(0, 50), outOfToleranceCount: outOfTolerance.length, maxDx: round(maxDx), maxDy: round(maxDy), maxDw: round(maxDw), maxDh: round(maxDh), tolerance},
    problems,
  };
}

const round = value => Math.round(value * 100) / 100;

// ------------------------------------------------------------- JSON output
/** Indented JSON with leaf objects and arrays of primitives on one line, so baselines diff readably. */
function prettyJson(value, indent = '') {
  const leaf = v => v === null || typeof v !== 'object';
  if (leaf(value)) return JSON.stringify(value);
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every(leaf) || value.every(v => !Array.isArray(v) && v && typeof v === 'object' && Object.values(v).every(x => leaf(x) || (Array.isArray(x) && x.every(leaf)))))
      return value.every(leaf) ? JSON.stringify(value) : `[\n${value.map(v => inner + JSON.stringify(v)).join(',\n')}\n${indent}]`;
    return `[\n${value.map(v => inner + prettyJson(v, inner)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${prettyJson(v, inner)}`).join(',\n')}\n${indent}}`;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, prettyJson(value) + '\n');
}

// ---------------------------------------------------------------- self-test
function selfTest() {
  const assert = require('node:assert/strict');
  const geometry = (bps, notes) => ({barCount: bps.reduce((a, b) => a + b, 0), barsPerSystem: bps, notes});
  const note = (key, dx, dy, w = 9, h = 7) => ({key, dx, dy, w, h});
  const base = geometry([3, 2], [note('0:0/1:kick#0', 10, 40), note('0:1/1:snare#0', 50, 20), note('4:0/1:crash#0', 12, -14)]);
  assert.equal(compareGeometry(base, structuredClone(base)).pass, true, 'identical geometry passes');
  const within = structuredClone(base);
  within.notes[0].dx += 1.99; within.notes[2].dy -= 2;
  assert.equal(compareGeometry(base, within).pass, true, 'moves up to 2 px pass');
  const beyond = structuredClone(base);
  beyond.notes[1].dy += 2.01;
  const moved = compareGeometry(base, beyond);
  assert.equal(moved.pass, false, 'a move beyond 2 px fails');
  assert.equal(moved.notes.outOfToleranceCount, 1);
  assert.equal(moved.notes.outOfTolerance[0].key, '0:1/1:snare#0');
  const reflowed = geometry([2, 3], base.notes);
  const r = compareGeometry(base, reflowed);
  assert.equal(r.pass, false, 'different bars per system fail');
  assert.equal(r.barsPerSystem.firstDifference, 0);
  const fewer = geometry([3, 2], base.notes.slice(1).concat(note('0:0/1:kick#1', 10, 40)));
  const m = compareGeometry(base, fewer);
  assert.deepEqual(m.notes.missing, ['0:0/1:kick#0']);
  assert.deepEqual(m.notes.extra, ['0:0/1:kick#1']);
  assert.equal(m.pass, false, 'missing and extra noteheads fail');
  assert.equal(compareGeometry(base, geometry([3, 2, 1], base.notes)).pass, false, 'an extra system fails');
  assert.equal(compareGeometry(base, beyond, 3).pass, true, 'the tolerance is configurable');
  assert.equal(compareGeometry(base, beyond, 0).pass, false, 'a zero tolerance is honoured');
  const resized = structuredClone(base);
  resized.notes[2].w += 2.5;
  const big = compareGeometry(base, resized);
  assert.equal(big.pass, false, 'a notehead resized beyond 2 px fails');
  assert.equal(big.notes.outOfTolerance[0].key, '4:0/1:crash#0');
  assert.equal(big.notes.outOfTolerance[0].delta.w, 2.5);
  assert.equal(big.notes.maxDw, 2.5);
  const taller = structuredClone(base);
  taller.notes[0].h -= 3;
  assert.equal(compareGeometry(base, taller).pass, false, 'a notehead shrunk beyond 2 px fails');
  const slightly = structuredClone(base);
  slightly.notes[1].w += 1.5; slightly.notes[1].h -= 2;
  assert.equal(compareGeometry(base, slightly).pass, true, 'size changes up to 2 px pass');
  // Arguments.
  assert.deepEqual(parseArgs(['--url=http://h/?a=b', '--record', '--port', '5300']), {url: 'http://h/?a=b', record: true, port: '5300'}, '--name=value keeps every "="');
  assert.equal(numberArg({tolerance: '0'}, 'tolerance', 2, {min: 0}), 0, 'zero is a value, not "absent"');
  assert.equal(numberArg({}, 'tolerance', 2, {min: 0}), 2);
  for (const bad of ['abc', '', true, '-1', 'Infinity'])
    assert.throws(() => numberArg({tolerance: bad}, 'tolerance', 2, {min: 0}), SetupError, `rejects --tolerance ${bad}`);
  assert.throws(() => numberArg({runs: '1.5'}, 'runs', 5, {min: 1, integer: true}), SetupError, 'rejects a fractional count');
  console.log('probe-geometry self-test: all synchronous checks passed');
}

async function selfTestAsync() {
  const assert = require('node:assert/strict');
  selfTest();
  await assert.rejects(withTimeout(new Promise(() => {}), 50, 'never rendered'), /never rendered/, 'a promise that never settles times out');
  assert.equal(await withTimeout(Promise.resolve(7), 50, 'x'), 7, 'a settled promise passes through');
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 50, 'x'), /boom/, 'a rejection passes through');
  const json = prettyJson({a: [1, 2], b: [{x: 1}, {y: [2]}], c: {d: null}});
  assert.deepEqual(JSON.parse(json), {a: [1, 2], b: [{x: 1}, {y: [2]}], c: {d: null}}, 'prettyJson round-trips');
  console.log('probe-geometry self-test: all checks passed');
}

// --------------------------------------------------------------------- main
async function main() {
  try { return await run(parseArgs(process.argv.slice(2))); } catch (error) {
    if (!(error instanceof SetupError) && !/^Unexpected argument/.test(error?.message)) throw error;
    console.error(error.message);
    return 2;
  }
}

async function run(args) {
  if (args['self-test']) { await selfTestAsync(); return 0; }
  const record = !!args.record;
  const baselineFile = path.resolve(args.baseline || DEFAULT_BASELINE);
  const reportFile = path.resolve(args.out || DEFAULT_REPORT);
  const root = path.resolve(args.root || REPO);

  let baseline = null;
  if (!record) {
    if (!fs.existsSync(baselineFile)) { console.error(`No baseline at ${baselineFile}; record one with --record.`); return 2; }
    baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  }
  const settings = baseline ? baseline.settings : {
    width: numberArg(args, 'width', 1200, {min: 1}),
    seconds: numberArg(args, 'seconds', 64, {min: 1}),
    bpm: numberArg(args, 'bpm', 120, {min: 1}),
    layout: typeof args.layout === 'string' ? args.layout : 'combined',
    scales: String(args.scales || '1,1.2').split(',').map(text => numberArg({scale: text}, 'scale', null, {min: 0.01})),
  };
  const tolerance = numberArg(args, 'tolerance', baseline?.tolerancePx ?? 2, {min: 0});
  const timeoutMs = numberArg(args, 'timeout', DEFAULT_RENDER_TIMEOUT, {min: 1000});

  let chromium;
  try { ({chromium} = require('playwright')); } catch { console.error('Playwright is not resolvable; run with NODE_PATH=/opt/node-tools/node_modules.'); return 2; }

  let server = null;
  let base = typeof args.url === 'string' ? args.url : null;
  if (!base) { server = await startServer({root, port: args.port}); base = server.base; }

  let browser;
  try { browser = await chromium.launch(); } catch (error) { await server?.stop(); throw new SetupError(`Cannot launch Chromium: ${error.message}`); }
  const errors = [];
  const measured = {};
  try {
    for (const scale of settings.scales) {
      const geometry = await measureHarness(browser, base, {...settings, scale}, errors, {timeoutMs});
      delete geometry.firstRenderMs;
      measured[String(scale)] = geometry;
      console.log(`scale ${scale}: ${geometry.barCount} bars in ${geometry.barsPerSystem.length} systems [${geometry.barsPerSystem.join(' ')}], ${geometry.notes.length} noteheads, engraving ${geometry.engravingWidth} px`);
    }
  } catch (error) {
    // Exit 2 only when the page could not be served; a page that loaded but
    // failed to engrave (or never finished) is the regression this probe guards.
    const setup = error instanceof SetupError;
    console.error(`${setup ? 'Setup failed' : 'FAIL: the harness did not produce a measurement'}: ${error.message}`);
    for (const line of errors) console.error(`  ${line}`);
    await browser.close();
    await server?.stop();
    return setup ? 2 : 1;
  }
  const chromiumVersion = browser.version();
  await browser.close();
  await server?.stop();

  if (errors.length) {
    console.error('The harness reported errors:');
    for (const line of errors) console.error(`  ${line}`);
  }

  if (record) {
    if (errors.length) { console.error('Not recording a baseline from a page with errors.'); return 1; }
    for (const [scale, geometry] of Object.entries(measured))
      if (geometry.notes.length !== geometry.hitCount || geometry.bars.length !== geometry.barCount) {
        console.error(`Scale ${scale}: ${geometry.notes.length}/${geometry.hitCount} noteheads and ${geometry.bars.length}/${geometry.barCount} bars measured; not recording an incomplete baseline.`);
        return 1;
      }
    writeJson(baselineFile, {
      probe: 'probe-geometry', version: 1,
      harness: HARNESS,
      source: {commit: args.commit || gitCommit(root), note: typeof args.note === 'string' ? args.note : undefined},
      recordedAt: new Date().toISOString(),
      chromium: chromiumVersion,
      viewport: VIEWPORT,
      tolerancePx: tolerance,
      settings,
      origin: 'note dx/dy are relative to barBounds(index).x and barBounds(index).lineTop',
      scales: measured,
    });
    console.log(`Recorded ${path.relative(process.cwd(), baselineFile)}`);
    return 0;
  }

  const report = {probe: 'probe-geometry', baseline: path.relative(REPO, baselineFile), comparedAt: new Date().toISOString(), chromium: chromiumVersion, tolerancePx: tolerance, errors, scales: {}};
  let pass = errors.length === 0;
  for (const scale of settings.scales) {
    const result = compareGeometry(baseline.scales[String(scale)], measured[String(scale)], tolerance);
    report.scales[String(scale)] = result;
    pass = pass && result.pass;
    console.log(`scale ${scale}: ${result.pass ? 'match' : 'MISMATCH'} (bars per system ${result.barsPerSystem.equal ? 'identical' : 'differ'}; ${result.notes.expected} noteheads, max drift ${result.notes.maxDx} px x / ${result.notes.maxDy} px y, size ${result.notes.maxDw} px w / ${result.notes.maxDh} px h)`);
    for (const problem of result.problems) console.log(`  - ${problem}`);
  }
  report.pass = pass;
  writeJson(reportFile, report);
  console.log(`${pass ? 'PASS' : 'FAIL'}: geometry ${pass ? 'matches' : 'does not match'} ${path.relative(REPO, baselineFile)} (report: ${path.relative(process.cwd(), reportFile)})`);
  return pass ? 0 : 1;
}

module.exports = {parseArgs, numberArg, SetupError, withTimeout, startServer, freePort, gitCommit, compareGeometry, prettyJson, writeJson, harnessUrl, harnessReady, measureHarness, HARNESS, REPO, DEFAULT_RENDER_TIMEOUT};

if (require.main === module) {
  main().then(code => process.exit(code), error => { console.error(error?.stack || error); process.exit(2); });
}
