#!/usr/bin/env node
// The Playwright runner for fixture states (architecture §11.4).
//
//   npm run fixture:capture -- [--states ID,…] [--devices laptop,ipad] [--themes light,dark]
//                              [--filter <regex>] [--state-file <path>]… [--url <base>]
//                              [--out <dir>] [--report <file>] [--jobs <n>] [--list]
//                              [--strict-requires]
//
// It starts Vite itself (tests/fixture/vite.config.mjs) on the first free port
// from FIXTURE_PORT (the environment, else .env.worktree, else 5190) unless
// --url names a running fixture, loads tests/fixture/states/<ID>.cjs (all of
// them without --states), runs every state × device × theme in a fresh browser
// context, writes tests/fixture/out/<state>--<device>-<theme>.png (gitignored)
// and out/report.json, and exits non-zero on any failed state, uncaught page
// error, console error, failed request or structural problem.
//
// Contract imports (§9.0): a state whose page reaches a same-wave peer module that has
// not merged yet lists it in opts.requires. While a listed file is missing the state is
// skipped, not run: each of its runs is reported as `skip` (ok, `skipped: true`,
// `missing: [paths]`), counted in report.json's `skipped`, and does not fail the exit
// code. --strict-requires (every integration run) fails such a run instead.
//
// A states module exports [{name, url, fn, opts}]:
//   name   lower-case letters, digits and dashes; unique across the loaded modules
//   url    a path on the fixture ('/__harness/<name>?…', '/?fx-desktop=1', …); on the
//          ipad device fx-platform=ipad is added unless the url sets fx-platform
//   fn     optional async (page, t) => {} run after the page is ready (t: the toolkit below)
//   opts   {devices, themes            restrict the variants (default: every device and theme)
//           ready                      route name to wait for in html[data-view-ready]; harness
//                                      urls wait for their own name; false: no wait
//           allow                      [string|RegExp] expected errors (matched against the message)
//           structure                  false, or lib/structure.cjs options {skip, ignore, allowClip, placeholder, viewportOnly}
//           capture                    false: a flow with no screenshot
//           fullPage, reducedMotion ('reduce'), timeout (ms, default 60000)
//           fixedTime                  page.clock.setFixedTime(ISO | ms) before loading
//           installClock               page.clock.install({time}) before loading; the url must
//                                      carry fx-audio=manual (§11.2's rule), else the state fails
//           requires                   [repo-relative path] contract files the page needs (see above)}
// The toolkit t: {base, device, theme, name, url, ready(route), waitAttr(selector, attr, value),
//   clockInstall ({time, before, after}: the installClock time and this process's Date.now()
//   just before and after page.clock.install; null without installClock),
//   loadPhase(phase = 'ready') (the Stage's data-load-phase), transportPhase(phase) (data-transport-phase),
//   rendered() (the chart's data-rendered), peaksReady() (data-peaks-ready),
//   idle() (window.__woodshed.idle()), advance(ms) (audio and page clock together),
//   touch() (lib/touch.cjs), counter(opts) (lib/count.cjs), structure(opts) (problems []),
//   capture(suffix, {fullPage}) (an extra screenshot), expect(condition, message), log(...)}.
// Captures mask [data-volatile] and disable animations. Requests that fail with
// net::ERR_ABORTED (cancelled by a navigation) are not errors.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {checkStructure} = require('./structure.cjs');
const {createTouch} = require('./touch.cjs');
const {createCounter} = require('./count.cjs');

const REPO = path.resolve(__dirname, '../../..');
const STATES_DIR = path.join(REPO, 'tests/fixture/states');
const DEFAULT_OUT = path.join(REPO, 'tests/fixture/out');
const DEFAULT_PORT = 5190;
const DEVICES = {
  laptop: {viewport: {width: 1440, height: 900}, deviceScaleFactor: 1, hasTouch: false, isMobile: false},
  ipad: {viewport: {width: 820, height: 1180}, deviceScaleFactor: 1, hasTouch: true, isMobile: false, platform: 'ipad'},
};
const THEMES = ['light', 'dark'];
const STATE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const OPTION_KEYS = new Set(['devices', 'themes', 'ready', 'allow', 'structure', 'capture', 'fullPage', 'reducedMotion', 'timeout', 'fixedTime', 'installClock', 'requires']);

class SetupError extends Error {}

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const out = {stateFiles: []};
  const list = v => String(v).split(',').map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new SetupError(`Unexpected argument ${arg}`);
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    const flag = name === 'list' || name === 'strict-requires';
    const value = flag ? true : inline ?? argv[++i];
    if (value === undefined) throw new SetupError(`--${name} needs a value`);
    switch (name) {
      case 'states': out.states = list(value); break;
      case 'devices': out.devices = list(value); break;
      case 'themes': out.themes = list(value); break;
      case 'filter': out.filter = new RegExp(value); break;
      case 'state-file': out.stateFiles.push(path.resolve(value)); break;
      case 'url': out.url = String(value).replace(/\/$/, ''); break;
      case 'out': out.out = path.resolve(value); break;
      case 'report': out.report = path.resolve(value); break;
      case 'jobs': out.jobs = Number(value); if (!Number.isInteger(out.jobs) || out.jobs < 1 || out.jobs > 4) throw new SetupError('--jobs must be 1–4'); break;
      case 'list': out.list = true; break;
      case 'strict-requires': out.strictRequires = true; break;
      default: throw new SetupError(`Unknown option --${name}`);
    }
  }
  for (const d of out.devices ?? []) if (!DEVICES[d]) throw new SetupError(`Unknown device ${d} (known: ${Object.keys(DEVICES).join(', ')})`);
  for (const t of out.themes ?? []) if (!THEMES.includes(t)) throw new SetupError(`Unknown theme ${t} (known: ${THEMES.join(', ')})`);
  return out;
}

// ---------------------------------------------------------------- states
function validateStates(states, file) {
  if (!Array.isArray(states)) throw new SetupError(`${file} must export an array of states`);
  for (const [i, s] of states.entries()) {
    const at = `${file} state ${i}${s?.name ? ` (${s.name})` : ''}`;
    if (!s || typeof s !== 'object') throw new SetupError(`${at}: not an object`);
    if (!STATE_NAME.test(s.name ?? '')) throw new SetupError(`${at}: name must be lower-case letters, digits and dashes`);
    if (typeof s.url !== 'string' || !/^(\/|https?:)/.test(s.url)) throw new SetupError(`${at}: url must be a path starting with /`);
    if (s.fn !== undefined && typeof s.fn !== 'function') throw new SetupError(`${at}: fn must be a function`);
    const opts = s.opts ?? {};
    if (typeof opts !== 'object') throw new SetupError(`${at}: opts must be an object`);
    for (const key of Object.keys(opts)) if (!OPTION_KEYS.has(key)) throw new SetupError(`${at}: unknown option ${key}`);
    for (const d of opts.devices ?? []) if (!DEVICES[d]) throw new SetupError(`${at}: unknown device ${d}`);
    for (const t of opts.themes ?? []) if (!THEMES.includes(t)) throw new SetupError(`${at}: unknown theme ${t}`);
    if (opts.requires !== undefined) {
      if (!Array.isArray(opts.requires)) throw new SetupError(`${at}: requires must be an array of repo-relative paths`);
      for (const p of opts.requires) {
        const bad = typeof p !== 'string' || !p || p.includes('\\') || path.posix.isAbsolute(p) || path.posix.normalize(p) !== p || p.startsWith('../') || p === '..';
        if (bad) throw new SetupError(`${at}: requires: ${JSON.stringify(p)} is not a repo-relative path (forward slashes, no ./ or ..)`);
      }
    }
  }
  return states;
}

/** The files in a state's opts.requires that do not exist under `root` (the repository). */
function missingRequires(state, root = REPO) {
  return (state.opts?.requires ?? []).filter(p => !fs.existsSync(path.join(root, p)));
}

/** The result of a run whose required files are missing: skipped, or failed with --strict-requires. */
function requiresResult({state, device, theme}, missing, {strict = false} = {}) {
  const base = {state: state.name, device, theme, file: path.relative(REPO, state.file), shots: [], missing, ms: 0};
  return strict
    ? {...base, ok: false, skipped: false, reasons: missing.map(p => `requires: ${p} is missing (--strict-requires)`)}
    : {...base, ok: true, skipped: true, reasons: missing.map(p => `requires: ${p} is missing`)};
}

/** Load the state modules: --state-file paths, else states/<ID>.cjs for --states, else every states/*.cjs. */
function loadStates({states: ids, stateFiles = []} = {}, dir = STATES_DIR) {
  let files = [...stateFiles];
  if (ids?.length) files.push(...ids.map(id => path.join(dir, `${id}.cjs`)));
  if (!files.length) files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.cjs')).sort().map(f => path.join(dir, f)) : [];
  const all = [], seen = new Map();
  for (const file of files) {
    if (!fs.existsSync(file)) throw new SetupError(`No states file ${path.relative(REPO, file)}`);
    const mod = require(file);
    const states = validateStates(Array.isArray(mod) ? mod : mod.states, path.relative(REPO, file) || file);
    for (const s of states) {
      if (seen.has(s.name)) throw new SetupError(`State ${s.name} is defined in ${seen.get(s.name)} and ${file}`);
      seen.set(s.name, file);
      all.push({...s, opts: s.opts ?? {}, file});
    }
  }
  return all;
}

/** Every (state, device, theme) to run, after the command-line and per-state restrictions. */
function plan(states, {devices, themes, filter} = {}) {
  const runs = [];
  for (const state of states) {
    if (filter && !filter.test(state.name)) continue;
    for (const device of Object.keys(DEVICES)) {
      if (devices && !devices.includes(device)) continue;
      if (state.opts.devices && !state.opts.devices.includes(device)) continue;
      for (const theme of THEMES) {
        if (themes && !themes.includes(theme)) continue;
        if (state.opts.themes && !state.opts.themes.includes(theme)) continue;
        runs.push({state, device, theme});
      }
    }
  }
  return runs;
}

function stateUrl(base, url, device) {
  const full = new URL(url, `${base}/`);
  const platform = DEVICES[device].platform;
  if (platform && !full.searchParams.has('fx-platform')) full.searchParams.set('fx-platform', platform);
  return full.href;
}

const shotName = (name, device, theme, suffix) => `${name}${suffix ? `-${suffix}` : ''}--${device}-${theme}.png`;

function allowed(message, allow = []) {
  return allow.some(a => (a instanceof RegExp ? a.test(message) : message.includes(a)));
}

/** Decide one run's outcome from what it collected. */
function verdict({errors = [], problems = [], failure = null}, allow = []) {
  const unexpected = errors.filter(e => !allowed(e, allow));
  const reasons = [...(failure ? [`failed: ${failure}`] : []), ...unexpected, ...problems.map(p => `structure: ${p}`)];
  return {ok: reasons.length === 0, reasons};
}

// ---------------------------------------------------------------- the server
function portIsFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function basePort(env = process.env, root = REPO) {
  if (env.FIXTURE_PORT) return Number(env.FIXTURE_PORT);
  const file = path.join(root, '.env.worktree');
  const m = fs.existsSync(file) && /^\s*FIXTURE_PORT\s*=\s*(\d+)\s*$/m.exec(fs.readFileSync(file, 'utf8'));
  return m ? Number(m[1]) : DEFAULT_PORT;
}

async function freePortFrom(start, tries = 100) {
  for (let port = start; port < start + tries && port <= 65535; port++) if (await portIsFree(port)) return port;
  throw new SetupError(`No free port in ${start}–${start + tries - 1}`);
}

function get(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.setTimeout(5000, () => { req.destroy(); resolve(0); });
  });
}

async function startServer({root = REPO, port, timeoutMs = 90_000} = {}) {
  const vite = path.join(root, 'node_modules/vite/bin/vite.js');
  const config = path.join(root, 'tests/fixture/vite.config.mjs');
  for (const f of [vite, config]) if (!fs.existsSync(f)) throw new SetupError(`Cannot start the fixture: ${f} is missing`);
  const chosen = await freePortFrom(port ?? basePort(process.env, root));
  const child = spawn(process.execPath, [vite, '--config', config, '--port', String(chosen), '--strictPort'], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, FIXTURE_PORT: String(chosen), BROWSER: 'none'},
  });
  let log = '';
  const keep = chunk => { log = (log + chunk).slice(-8000); };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  const base = `http://127.0.0.1:${chosen}`;
  const stop = async () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    const done = await Promise.race([exited.then(() => true), new Promise(r => setTimeout(() => r(false), 5000))]);
    if (!done) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new SetupError(`The fixture server exited (${child.exitCode}):\n${log}`);
    if (await get(`${base}/__harness/`) === 200) return {base, port: chosen, stop, log: () => log};
    await new Promise(r => setTimeout(r, 250));
  }
  await stop();
  throw new SetupError(`The fixture server did not answer on ${base} within ${timeoutMs} ms:\n${log}`);
}

// ---------------------------------------------------------------- one run
async function runOne(browser, base, {state, device, theme}, {out}) {
  const {opts} = state;
  const started = Date.now();
  const errors = [];
  const result = {state: state.name, device, theme, file: path.relative(REPO, state.file), shots: []};
  const spec = DEVICES[device];
  const context = await browser.newContext({
    viewport: spec.viewport, deviceScaleFactor: spec.deviceScaleFactor, hasTouch: spec.hasTouch, isMobile: spec.isMobile,
    colorScheme: theme, reducedMotion: opts.reducedMotion ?? 'no-preference', locale: 'en-US', timezoneId: 'UTC',
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(`page error: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console error: ${m.text()}${m.location()?.url ? ` (${m.location().url})` : ''}`); });
  page.on('requestfailed', r => { const why = r.failure()?.errorText ?? ''; if (!/ERR_ABORTED/.test(why)) errors.push(`request failed: ${r.method()} ${r.url()} ${why}`); });
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`); });

  const url = stateUrl(base, state.url, device);
  const capture = async (suffix, {fullPage = !!opts.fullPage} = {}) => {
    fs.mkdirSync(out, {recursive: true});
    const file = path.join(out, shotName(state.name, device, theme, suffix));
    await page.screenshot({path: file, fullPage, animations: 'disabled', caret: 'hide', mask: [page.locator('[data-volatile]')], maskColor: '#7f7f7f'});
    result.shots.push(path.relative(REPO, file));
    return file;
  };
  let touch = null;
  const t = {
    base, device, theme, name: state.name, url, page, clockInstall: null,
    ready: (route, {timeout = 30_000} = {}) => page.waitForSelector(`html[data-view-ready="${route}"]`, {state: 'attached', timeout}),
    waitAttr: (selector, attr, value, {timeout = 30_000} = {}) => page.waitForSelector(`${selector}[${attr}="${value}"]`, {state: 'attached', timeout}),
    loadPhase: (phase = 'ready', opts) => t.waitAttr('', 'data-load-phase', phase, opts),
    transportPhase: (phase, opts) => t.waitAttr('', 'data-transport-phase', phase, opts),
    rendered: ({timeout = 30_000} = {}) => page.waitForSelector('[data-rendered]:not([data-rendered="false"])', {state: 'attached', timeout}),
    peaksReady: ({timeout = 30_000} = {}) => page.waitForSelector('[data-peaks-ready]:not([data-peaks-ready="false"])', {state: 'attached', timeout}),
    idle: () => page.evaluate(async () => {
      if (!window.__woodshed?.idle) throw new Error('window.__woodshed is not installed (src/app/dev-handle.js)');
      return window.__woodshed.idle();
    }),
    async advance(ms) {
      if (!opts.installClock) return page.evaluate(n => window.fixture.advance(n), ms);
      for (let left = ms; left > 0; left -= 25) {
        const step = Math.min(25, left);
        await page.evaluate(s => window.fixture.audio.step(s), step / 1000);
        await page.clock.runFor(step);
      }
      return page.evaluate(() => window.fixture.audio.time());
    },
    touch: async () => (touch ??= await createTouch(page)),
    counter: async (counterOpts = {}) => createCounter(page, {...counterOpts, touch: counterOpts.mode === 'keys' ? null : await t.touch()}),
    structure: structureOpts => checkStructure(page, structureOpts),
    capture,
    expect(condition, message) { if (!condition) throw new Error(`expectation failed: ${message}`); },
    log: (...args) => console.log(`  [${state.name} ${device}-${theme}]`, ...args),
  };

  let failure = null, problems = [];
  const timeout = opts.timeout ?? 60_000;
  let timer;
  try {
    await Promise.race([
      (async () => {
        if (opts.installClock !== undefined && opts.installClock !== false) {
          if (!/[?&]fx-audio=manual(&|$)/.test(url)) throw new Error('opts.installClock needs fx-audio=manual in the url (§11.2: never install the page clock with real-time audio)');
          const time = opts.installClock === true ? undefined : new Date(opts.installClock);
          const before = Date.now();
          await page.clock.install(time ? {time} : {});
          t.clockInstall = {time: time ? time.getTime() : before, before, after: Date.now()};
        }
        if (opts.fixedTime !== undefined) await page.clock.setFixedTime(new Date(opts.fixedTime));
        await page.goto(url, {waitUntil: 'load'});
        const harness = /^\/__harness\/([^/?#]+)/.exec(new URL(url).pathname)?.[1];
        const ready = opts.ready ?? harness ?? false;
        if (ready) {
          await page.waitForSelector(`html[data-view-ready="${ready}"], html[data-harness-error]`, {state: 'attached', timeout: 30_000});
          const harnessError = await page.evaluate(() => document.documentElement.dataset.harnessError);
          if (harnessError) throw new Error(`harness: ${harnessError}`);
        }
        if (state.fn) await state.fn(page, t);
        if (opts.structure !== false) problems = await checkStructure(page, opts.structure ?? {});
        if (opts.capture !== false) await capture();
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeout} ms`)), timeout); }),
    ]);
  } catch (error) {
    failure = error?.message ?? String(error);
  } finally {
    clearTimeout(timer);
    await touch?.detach?.().catch(() => {});
    await context.close().catch(() => {});
  }
  Object.assign(result, verdict({errors, problems, failure}, opts.allow), {ms: Date.now() - started});
  return result;
}

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(size, items.length)}, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

// ---------------------------------------------------------------- main
async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const states = loadStates(args);
  const runs = plan(states, args);
  if (args.list) {
    for (const s of states) {
      const missing = missingRequires(s);
      console.log(`${s.name}\t${s.url}\t${path.relative(REPO, s.file)}${missing.length ? `\trequires missing: ${missing.join(', ')}` : ''}`);
    }
    return 0;
  }
  if (!runs.length) throw new SetupError('No state matched the options');
  const out = args.out ?? DEFAULT_OUT;
  const strict = !!args.strictRequires;
  const results = new Array(runs.length), toRun = [];
  for (const [i, run] of runs.entries()) {
    const missing = missingRequires(run.state);
    if (missing.length) results[i] = requiresResult(run, missing, {strict});
    else toRun.push(i);
  }
  const say = r => console.log(`${r.skipped ? 'skip' : r.ok ? 'ok  ' : 'FAIL'} ${r.state} ${r.device}-${r.theme} (${r.ms} ms)${r.ok && !r.skipped ? '' : `\n  - ${r.reasons.join('\n  - ')}`}`);
  const finish = base => {
    const failed = results.filter(r => !r.ok), skipped = results.filter(r => r.skipped);
    const report = {base, at: new Date().toISOString(), strictRequires: strict, runs: results.length, failed: failed.length, skipped: skipped.length, results};
    fs.mkdirSync(path.dirname(args.report ?? path.join(out, 'report.json')), {recursive: true});
    fs.writeFileSync(args.report ?? path.join(out, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
    console.log(`${results.length - failed.length - skipped.length}/${results.length} passed${skipped.length ? `, ${skipped.length} skipped (opts.requires)` : ''}`);
    return failed.length ? 1 : 0;
  };
  for (const i of runs.keys()) if (results[i]) say(results[i]);
  // Every run skipped or failed by opts.requires: no server or browser needed.
  if (!toRun.length) return finish(args.url ?? null);
  let chromium;
  try { ({chromium} = require('playwright')); } catch { throw new SetupError('Playwright is missing: run with NODE_PATH=/opt/node-tools/node_modules (npm run fixture:capture does)'); }
  const server = args.url ? null : await startServer();
  const base = args.url ?? server.base;
  const cleanup = async () => { await server?.stop(); };
  const onSignal = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  let browser;
  try {
    browser = await chromium.launch();
    console.log(`fixture runner: ${toRun.length} run(s) on ${base}`);
    await pool(toRun, args.jobs ?? 1, async i => {
      const r = await runOne(browser, base, runs[i], {out});
      say(r);
      results[i] = r;
    });
    return finish(base);
  } finally {
    await browser?.close().catch(() => {});
    await cleanup();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
}

if (require.main === module) {
  main().then(code => process.exit(code), error => {
    console.error(error instanceof SetupError ? `fixture runner: ${error.message}` : error);
    process.exit(2);
  });
}

module.exports = {DEVICES, THEMES, SetupError, parseArgs, validateStates, loadStates, missingRequires, requiresResult, plan, stateUrl, shotName, allowed, verdict, basePort, freePortFrom, portIsFree, startServer, runOne, main};
