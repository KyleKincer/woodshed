// @vitest-environment node
// The Playwright runner (architecture §11.4): arguments, state modules,
// planning, URLs, verdicts and ports without a browser; then one real run of
// the runner itself (its own Vite server, Chromium) with a passing and a
// failing state, which must exit non-zero and write the passing capture.
import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {createRequire} from 'node:module';
import {mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const runner = require('../lib/runner.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const PLAYWRIGHT = '/opt/node-tools/node_modules';
const hasPlaywright = existsSync(path.join(PLAYWRIGHT, 'playwright/package.json')) && process.platform !== 'win32';

let dir;
const write = (name, text) => { const file = path.join(dir, name); writeFileSync(file, text); return file; };
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'fx-runner-')); });
afterAll(() => rmSync(dir, {recursive: true, force: true}));

describe('arguments', () => {
  it('parses lists, regexes, paths and flags', () => {
    const args = runner.parseArgs(['--states', 'U1,U2', '--devices=ipad', '--themes', 'dark', '--filter', '^menu', '--state-file', 'a.cjs', '--state-file=b.cjs', '--url', 'http://127.0.0.1:5300/', '--jobs', '2', '--list']);
    expect(args).toMatchObject({states: ['U1', 'U2'], devices: ['ipad'], themes: ['dark'], url: 'http://127.0.0.1:5300', jobs: 2, list: true});
    expect(args.filter.test('menu-open')).toBe(true);
    expect(args.stateFiles).toEqual([path.resolve('a.cjs'), path.resolve('b.cjs')]);
  });
  it('refuses unknown options, devices, themes, a missing value and too many jobs', () => {
    expect(() => runner.parseArgs(['--colour', 'x'])).toThrow(runner.SetupError);
    expect(() => runner.parseArgs(['--devices', 'phone'])).toThrow(/Unknown device phone/);
    expect(() => runner.parseArgs(['--themes', 'sepia'])).toThrow(/Unknown theme sepia/);
    expect(() => runner.parseArgs(['--states'])).toThrow(/needs a value/);
    expect(() => runner.parseArgs(['--jobs', '9'])).toThrow(/--jobs must be 1–4/);
    expect(() => runner.parseArgs(['FX1'])).toThrow(/Unexpected argument/);
  });
  it('--strict-requires is a flag', () => {
    expect(runner.parseArgs(['--strict-requires', '--states', 'U1'])).toMatchObject({strictRequires: true, states: ['U1']});
    expect(runner.parseArgs([]).strictRequires).toBeUndefined();
  });
});

describe('state modules', () => {
  it('validate names, urls, fn and options', () => {
    const v = states => () => runner.validateStates(states, 'x.cjs');
    expect(v({})).toThrow(/must export an array/);
    expect(v([{name: 'Bad Name', url: '/'}])).toThrow(/name must be lower-case/);
    expect(v([{name: 'ok', url: 'relative'}])).toThrow(/url must be a path/);
    expect(v([{name: 'ok', url: '/', fn: 'nope'}])).toThrow(/fn must be a function/);
    expect(v([{name: 'ok', url: '/', opts: {colour: 1}}])).toThrow(/unknown option colour/);
    expect(v([{name: 'ok', url: '/', opts: {devices: ['phone']}}])).toThrow(/unknown device phone/);
    expect(v([{name: 'ok', url: '/', opts: {devices: ['ipad'], themes: ['dark'], structure: false, capture: false, allow: [/x/]}}])).not.toThrow();
  });
  it('opts.requires is an array of repo-relative contract paths', () => {
    const v = requires => () => runner.validateStates([{name: 'ok', url: '/', opts: {requires}}], 'x.cjs');
    expect(v(['src/ui/tooltip.js', 'src/ui/kbd.js'])).not.toThrow();
    expect(v([])).not.toThrow();
    expect(v('src/ui/tooltip.js')).toThrow(/requires must be an array/);
    for (const bad of ['', '/abs/x.js', '../out.js', './src/x.js', 'src//x.js', 'src\\x.js', 7]) expect(v([bad]), String(bad)).toThrow(/is not a repo-relative path/);
  });
  it('missingRequires lists the files that do not exist; requiresResult skips, or fails when strict', () => {
    const state = {name: 'needs-peer', file: path.join(repo, 'tests/fixture/states/X.cjs'), opts: {requires: ['package.json', 'src/ui/not-merged-yet.js']}};
    expect(runner.missingRequires(state)).toEqual(['src/ui/not-merged-yet.js']);
    expect(runner.missingRequires({opts: {}})).toEqual([]);
    expect(runner.missingRequires(state, dir)).toEqual(['package.json', 'src/ui/not-merged-yet.js']);
    const run = {state, device: 'laptop', theme: 'dark'};
    expect(runner.requiresResult(run, ['src/ui/not-merged-yet.js'])).toMatchObject({state: 'needs-peer', ok: true, skipped: true, missing: ['src/ui/not-merged-yet.js'], reasons: ['requires: src/ui/not-merged-yet.js is missing']});
    expect(runner.requiresResult(run, ['src/ui/not-merged-yet.js'], {strict: true})).toMatchObject({ok: false, skipped: false, reasons: ['requires: src/ui/not-merged-yet.js is missing (--strict-requires)']});
  });
  it('load --state-file and states/<ID>.cjs, and refuse duplicate names and missing files', () => {
    const a = write('a.cjs', "module.exports = [{name: 'one', url: '/'}];");
    const b = write('b.cjs', "module.exports = {states: [{name: 'two', url: '/x', opts: {devices: ['laptop']}}]};");
    const dup = write('dup.cjs', "module.exports = [{name: 'one', url: '/'}];");
    const loaded = runner.loadStates({stateFiles: [a, b]});
    expect(loaded.map(s => [s.name, s.file])).toEqual([['one', a], ['two', b]]);
    expect(loaded[0].opts).toEqual({});
    expect(() => runner.loadStates({stateFiles: [a, dup]})).toThrow(/State one is defined in/);
    expect(() => runner.loadStates({states: ['NOPE']})).toThrow(/No states file tests\/fixture\/states\/NOPE.cjs/);
    expect(runner.loadStates({states: ['FX1']}).map(s => s.name)).toContain('fx1-harness-smoke');
    const only = mkdtempSync(path.join(dir, 'states-'));
    writeFileSync(path.join(only, 'Z.cjs'), "module.exports = [{name: 'zed', url: '/'}];");
    writeFileSync(path.join(only, 'A.cjs'), "module.exports = [{name: 'ay', url: '/'}];");
    writeFileSync(path.join(only, 'notes.txt'), 'not a state');
    expect(runner.loadStates({}, only).map(s => s.name)).toEqual(['ay', 'zed']);
  });
  it('plan crosses states with devices and themes, within both restrictions', () => {
    const states = [{name: 'a', opts: {}}, {name: 'b', opts: {devices: ['ipad'], themes: ['dark']}}, {name: 'c', opts: {}}];
    const ids = runs => runs.map(r => `${r.state.name}:${r.device}-${r.theme}`);
    expect(ids(runner.plan(states))).toEqual(['a:laptop-light', 'a:laptop-dark', 'a:ipad-light', 'a:ipad-dark', 'b:ipad-dark', 'c:laptop-light', 'c:laptop-dark', 'c:ipad-light', 'c:ipad-dark']);
    expect(ids(runner.plan(states, {devices: ['laptop'], themes: ['dark'], filter: /^[ab]$/}))).toEqual(['a:laptop-dark']);
  });
  it('urls: relative to the base, with fx-platform=ipad on the iPad unless set', () => {
    expect(runner.stateUrl('http://127.0.0.1:5210', '/__harness/x?theme=dark', 'ipad')).toBe('http://127.0.0.1:5210/__harness/x?theme=dark&fx-platform=ipad');
    expect(runner.stateUrl('http://127.0.0.1:5210', '/?fx-platform=mac', 'ipad')).toBe('http://127.0.0.1:5210/?fx-platform=mac');
    expect(runner.stateUrl('http://127.0.0.1:5210', '/s/glasshouse', 'laptop')).toBe('http://127.0.0.1:5210/s/glasshouse');
    expect(runner.DEVICES.ipad).toMatchObject({viewport: {width: 820, height: 1180}, hasTouch: true});
    expect(runner.DEVICES.laptop.viewport).toEqual({width: 1440, height: 900});
    expect(runner.shotName('menu-open', 'ipad', 'dark')).toBe('menu-open--ipad-dark.png');
    expect(runner.shotName('menu-open', 'ipad', 'dark', 'after')).toBe('menu-open-after--ipad-dark.png');
  });
});

describe('verdicts', () => {
  it('any error, failure or structural problem fails the run unless the state allows the error', () => {
    expect(runner.verdict({})).toEqual({ok: true, reasons: []});
    expect(runner.verdict({errors: ['console error: boom']})).toEqual({ok: false, reasons: ['console error: boom']});
    expect(runner.verdict({errors: ['console error: boom', 'HTTP 404: GET /x']}, ['boom', /404/]).ok).toBe(true);
    expect(runner.verdict({failure: 'timed out after 10 ms', problems: ['clip: x']}).reasons).toEqual(['failed: timed out after 10 ms', 'structure: clip: x']);
    expect(runner.allowed('page error: x is undefined', [/is undefined$/])).toBe(true);
  });
});

describe('ports', () => {
  it('FIXTURE_PORT from the environment, then .env.worktree, then 5190', () => {
    expect(runner.basePort({FIXTURE_PORT: '5299'}, dir)).toBe(5299);
    expect(runner.basePort({}, dir)).toBe(5190);
    writeFileSync(path.join(dir, '.env.worktree'), 'WT_ID=X\nFIXTURE_PORT=5288\n');
    expect(runner.basePort({}, dir)).toBe(5288);
  });
  it('the first free port from the base is used', async () => {
    const taken = net.createServer();
    await new Promise(resolve => taken.listen(0, '127.0.0.1', resolve));
    const port = taken.address().port;
    try {
      expect(await runner.portIsFree(port)).toBe(false);
      expect(await runner.freePortFrom(port)).toBeGreaterThan(port);
    } finally { await new Promise(resolve => taken.close(resolve)); }
  });
});

describe('opts.requires, end to end (no browser: every run is decided by its requires)', () => {
  const runCli = (args, env = {}) => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(repo, 'tests/fixture/lib/runner.cjs'), ...args], {cwd: repo, env: {...process.env, NODE_PATH: '', ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let log = '';
    child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
    child.on('exit', code => resolve({code, log}));
  });
  it('skips a state whose contract file is missing and counts it; --strict-requires fails it', async () => {
    const states = write('requires.cjs', `module.exports = [
      {name: 'needs-peer', url: '/__harness/fixture-smoke', opts: {devices: ['laptop'], requires: ['src/ui/not-merged-yet.js']}},
    ];`);
    const report = path.join(dir, 'requires-report.json');
    const skipped = await runCli(['--state-file', states, '--report', report]);
    expect(skipped.code, skipped.log).toBe(0);
    expect(skipped.log).toMatch(/^skip needs-peer laptop-light/m);
    expect(skipped.log).toMatch(/0\/2 passed, 2 skipped \(opts.requires\)/);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({strictRequires: false, runs: 2, failed: 0, skipped: 2,
      results: [{state: 'needs-peer', ok: true, skipped: true, missing: ['src/ui/not-merged-yet.js']}, {theme: 'dark', skipped: true}]});
    const strict = await runCli(['--state-file', states, '--report', report, '--strict-requires']);
    expect(strict.code, strict.log).toBe(1);
    expect(strict.log).toMatch(/^FAIL needs-peer laptop-light[^\n]*\n {2}- requires: src\/ui\/not-merged-yet.js is missing \(--strict-requires\)/m);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({strictRequires: true, runs: 2, failed: 2, skipped: 0});
    const list = await runCli(['--state-file', states, '--list']);
    expect(list.log).toMatch(/needs-peer\t\/__harness\/fixture-smoke\t\S+\trequires missing: src\/ui\/not-merged-yet.js/);
  }, 60_000);
});

describe.runIf(hasPlaywright)('a real run', () => {
  it('starts its own fixture, captures a passing state, and exits 1 for a failing one', async () => {
    const states = write('real.cjs', `module.exports = [
      {name: 'real-pass', url: '/__harness/fixture-smoke', opts: {devices: ['laptop'], themes: ['dark']},
        async fn(page, t) { t.expect(await page.getByRole('heading', {level: 1}).textContent() === 'Fixture', 'heading'); }},
      {name: 'real-fail', url: '/__harness/fixture-smoke?demo=clip', opts: {devices: ['laptop'], themes: ['dark']},
        async fn(page) { await page.evaluate(() => console.error('deliberate')); }},
      {name: 'real-allowed', url: '/__harness/fixture-smoke', opts: {devices: ['laptop'], themes: ['dark'], capture: false, allow: ['deliberate']},
        async fn(page) { await page.evaluate(() => console.error('deliberate')); }},
      {name: 'real-clock', url: '/__harness/fixture-smoke', opts: {devices: ['laptop'], themes: ['dark'], capture: false, installClock: true}},
      {name: 'real-requires-met', url: '/__harness/fixture-smoke', opts: {devices: ['laptop'], themes: ['dark'], capture: false, requires: ['tests/fixture/lib/runner.cjs']}},
      {name: 'real-requires-missing', url: '/__harness/fixture-smoke', opts: {devices: ['laptop'], themes: ['dark'], requires: ['src/ui/not-merged-yet.js']}},
    ];`);
    const out = path.join(dir, 'out');
    const child = spawn(process.execPath, [path.join(repo, 'tests/fixture/lib/runner.cjs'), '--state-file', states, '--out', out], {
      cwd: repo, env: {...process.env, NODE_PATH: PLAYWRIGHT, FIXTURE_PORT: '5390'}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
    const code = await new Promise(resolve => child.on('exit', resolve));
    expect(code, log).toBe(1);
    const report = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
    const byName = Object.fromEntries(report.results.map(r => [r.state, r]));
    expect(report).toMatchObject({runs: 6, failed: 2, skipped: 1});
    expect(byName['real-requires-met']).toMatchObject({ok: true});
    expect(byName['real-requires-met'].skipped).toBeUndefined();
    expect(byName['real-requires-missing']).toMatchObject({ok: true, skipped: true, shots: []});
    expect(byName['real-pass']).toMatchObject({ok: true, shots: [expect.stringContaining('real-pass--laptop-dark.png')]});
    expect(existsSync(path.join(out, 'real-pass--laptop-dark.png'))).toBe(true);
    expect(byName['real-fail'].reasons).toEqual(expect.arrayContaining([expect.stringContaining('console error: deliberate'), expect.stringMatching(/^structure: clip: /)]));
    expect(byName['real-allowed'].ok).toBe(true);
    expect(byName['real-clock'].reasons[0]).toMatch(/installClock needs fx-audio=manual/);
    expect(log).toMatch(/3\/6 passed, 1 skipped/);
  }, 180_000);
});
