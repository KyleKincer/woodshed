// companion/server.mjs: progress throttling, job error codes, /status (§6.10 CPB items 1–4, 6, 9).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import {
  CodedError, PROGRESS_INTERVAL_MS, SETUP_HINT, SEPARATION_MODELS,
  acceleratorOf, checkpointsDir, convexCode, createProgressThrottle, demucsRemoteDirs, errorText, jobErrorCode,
  jobMetaOf, modelFiles, modelsReady, parseModelSignatures, parseRemoteFiles, processorFailure, progressEvent, startCompanion, statusBody,
} from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const settle = () => new Promise(resolve => setImmediate(resolve));

function fakeTimers() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    get pending() { return timers.size; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].fn(); await settle();
      }
      now = end; await settle();
    },
  };
}

function throttle(options = {}) {
  const clock = fakeTimers();
  const sent = [];
  const logs = [];
  const t = createProgressThrottle({
    send: event => { sent.push({ at: clock.now(), ...event }); return Promise.resolve(true); },
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, log: (...a) => logs.push(a.join(' ')),
    ...options,
  });
  return { clock, sent, logs, t };
}

// ---------------------------------------------------------------- throttle (item 2)

test('the first event and every stage change go out at once', async () => {
  const { sent, t } = throttle();
  t.push({ stage: 'download', percent: 5, message: 'Downloading audio…' });
  t.push({ stage: 'separate', percent: 0, message: 'Loading model…' });
  t.push({ stage: 'finalize', percent: 90, message: 'Encoding sync copies locally…' });
  await settle();
  assert.deepEqual(sent.map(e => e.stage), ['download', 'separate', 'finalize']);
});

test('within a stage at most one event per 2 s, with a trailing flush of the latest', async () => {
  const { clock, sent, t } = throttle();
  t.push({ stage: 'download', percent: 5, message: 'Downloading audio…' });
  await settle();
  for (const percent of [10, 20, 30]) { await clock.advance(400); t.push({ stage: 'download', percent, message: 'Downloading audio…' }); }
  await settle();
  assert.deepEqual(sent.map(e => e.percent), [5]);
  await clock.advance(PROGRESS_INTERVAL_MS - 1200);
  assert.deepEqual(sent.map(e => [e.at, e.percent]), [[0, 5], [2000, 30]]);
  // Quiet for longer than the interval: the next event goes straight out.
  await clock.advance(5000);
  t.push({ stage: 'download', percent: 80, message: 'Downloading audio…' });
  await settle();
  assert.deepEqual(sent.at(-1), { at: 7000, stage: 'download', percent: 80, message: 'Downloading audio…' });
  assert.equal(clock.pending, 0);
});

test('a message change at percent 0 goes out at once; at other percents it waits', async () => {
  const { clock, sent, t } = throttle();
  t.push({ stage: 'separate', percent: 0, message: 'Loading model…' });
  await clock.advance(100);
  t.push({ stage: 'separate', percent: 0, message: 'Downloading the separation model (first run)…' });
  await clock.advance(100);
  t.push({ stage: 'separate', percent: 0.4, message: 'GPU unavailable; continuing on CPU…' });
  await clock.advance(100);
  t.push({ stage: 'separate', percent: 40, message: 'Separating stems… (CPU, pass 1/1)' });
  await settle();
  assert.deepEqual(sent.map(e => e.message), ['Loading model…', 'Downloading the separation model (first run)…', 'GPU unavailable; continuing on CPU…']);
});

test('flush sends the pending event before the job’s final call and resolves after every send', async () => {
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { t, clock } = throttle({ send: async event => { if (event.percent === 5) await gate; order.push(event.percent); return true; } });
  t.push({ stage: 'detect', percent: 5, message: 'Fetching audio…' });
  t.push({ stage: 'detect', percent: 20, message: 'Building a mix locally…' });
  t.push({ stage: 'detect', percent: 95, message: 'Saving bars…' });
  const flushed = t.flush().then(() => order.push('flushed'));
  await settle();
  assert.deepEqual(order, []);
  release();
  await flushed;
  assert.deepEqual(order, [5, 95, 'flushed']);
  assert.equal(clock.pending, 0);
});

test('meta goes out at once with the latest stage, percent and message', async () => {
  const { clock, sent, t } = throttle();
  t.push({ stage: 'download', percent: 5, message: 'Downloading audio…' });
  await clock.advance(300);
  t.push({ stage: 'download', percent: 100, message: 'Ready' });
  t.pushMeta({ title: 'Harbor Lights', channel: 'Ada Moreno' });
  await settle();
  assert.deepEqual(sent.at(-1), { at: 300, stage: 'download', percent: 100, message: 'Ready', meta: { title: 'Harbor Lights', channel: 'Ada Moreno' } });
  await clock.advance(5000);
  assert.equal(sent.length, 2, 'the pending event rode on the meta send');
});

test('a failed send is logged and later sends still go out; cancel drops the pending event', async () => {
  let n = 0;
  const { clock, logs, t } = throttle({ send: () => (++n === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(true)) });
  t.push({ stage: 'download', percent: 1 });
  t.push({ stage: 'separate', percent: 1 });
  await t.flush();
  assert.equal(n, 2);
  assert.match(logs[0], /Progress update: offline/);
  t.push({ stage: 'separate', percent: 2 });
  t.cancel();
  await clock.advance(5000);
  assert.equal(n, 2);
});

test('processor progress lines are validated and clamped', () => {
  assert.deepEqual(progressEvent({ stage: 'separate', percent: 140.5, message: 'x' }), { stage: 'separate', percent: 100, message: 'x' });
  assert.deepEqual(progressEvent({ stage: 'detect', percent: 'n/a' }), { stage: 'detect', percent: 0 });
  assert.equal(progressEvent({ complete: true }), null);
  assert.equal(progressEvent({ stage: '' }), null);
});

// ---------------------------------------------------------------- error codes (items 1, 3)

test('companion-side failures carry their job error code', () => {
  assert.equal(jobErrorCode(new CodedError('source_missing', 'Original file unavailable locally. Add the file again.')), 'source_missing');
  assert.equal(jobErrorCode(new CodedError('sync_failed', 'Sync upload failed (500). Your local files are safe.')), 'sync_failed');
  const convex = (code, message) => new ConvexError({ code, message });
  assert.equal(jobErrorCode(convex('storage_full_user', 'Your cloud library is full.')), 'storage_full');
  assert.equal(jobErrorCode(convex('storage_full_app', 'Cloud storage is currently full.')), 'storage_full');
  assert.equal(jobErrorCode(convex('account_suspended', 'Your account is suspended.')), 'account_paused');
  assert.equal(jobErrorCode(convex('account_export_only', 'Your account is in export-only mode.')), 'account_paused');
  assert.equal(jobErrorCode(convex('device_unpaired', 'Companion is not paired.')), 'unknown');
  assert.equal(convexCode(convex('invalid', 'Invalid upload manifest.')), 'invalid');
  assert.equal(jobErrorCode(Object.assign(new Error('write failed'), { code: 'ENOSPC' })), 'disk_full');
  assert.equal(jobErrorCode(new Error('ENOSPC: no space left on device, write')), 'disk_full');
  assert.equal(jobErrorCode(new Error('boom')), 'unknown');
});

test('the stored error is the raw text: the coded message, then any detail', () => {
  assert.equal(errorText(new ConvexError({ code: 'storage_full_user', message: 'Your cloud library is full.' })), 'Your cloud library is full.');
  assert.equal(errorText(new CodedError('unknown', 'Processor exited (1).', { detail: 'Traceback…' })), 'Processor exited (1).\nTraceback…');
});

test('a processor failure: its own error line wins, else the exit, with the developer hint only unpackaged', () => {
  const own = processorFailure({ exitCode: 1, errorEvent: { error: 'yt-dlp exited with code 1\nERROR: Video unavailable', code: 'unavailable' }, stderr: 'noise', stage: 'download' });
  assert.equal(own.code, 'unavailable');
  assert.equal(own.message, 'yt-dlp exited with code 1\nERROR: Video unavailable');
  assert.equal(own.detail, undefined);

  const packaged = processorFailure({ exitCode: 1, stderr: 'Traceback (most recent call last):\n  …\nSegmentation fault', stage: 'finalize', packaged: true });
  assert.equal(packaged.code, 'unknown');
  assert.equal(packaged.message, 'Processor exited (1).');
  assert.ok(!packaged.message.includes(SETUP_HINT));
  assert.match(errorText(packaged), /Segmentation fault/, 'the stderr tail is in the raw text');

  const dev = processorFailure({ exitCode: 1, stderr: '', stage: 'download', packaged: false });
  assert.equal(dev.message, `Processor exited (1). ${SETUP_HINT}`);

  const killed = processorFailure({ exitCode: null, signal: 'SIGKILL', stage: 'separate', packaged: true });
  assert.equal(killed.code, 'separation_failed');
  assert.equal(killed.message, 'Processor was stopped (SIGKILL).');
  assert.equal(processorFailure({ exitCode: 1, errorEvent: { error: 'x' } }).code, 'unknown');
});

// ---------------------------------------------------------------- meta (item 6)

test('processor meta maps onto worker.progress meta', () => {
  assert.deepEqual(jobMetaOf({ title: ' Harbor Lights ', artist: 'Ada Moreno', uploader: 'Ada Moreno - Topic', duration: 221.4, thumbnail: 'https://i.ytimg.com/x.jpg', provider: 'Youtube' }),
    { title: 'Harbor Lights', channel: 'Ada Moreno - Topic', duration: 221.4, thumbnail: 'https://i.ytimg.com/x.jpg', provider: 'Youtube' });
  assert.deepEqual(jobMetaOf({ title: 'Song', artist: 'Band', thumbnail: 'http://insecure/x.jpg', duration: -1 }), { title: 'Song', channel: 'Band' });
  assert.equal(jobMetaOf({ title: '  ' }), null);
  assert.equal(jobMetaOf(null), null);
});

// ---------------------------------------------------------------- /status (item 4)

function demucsRemote(root) {
  const remote = path.join(root, 'demucs', 'remote');
  mkdirSync(remote, { recursive: true });
  writeFileSync(path.join(remote, 'files.txt'), [
    '# MDX Models', 'e51eebcc-c1b80bdd.th', 'a1d90b5c-ae9d2452.th', '5d2d6c55-db83574e.th', 'cfa93e08-61801ae1.th',
    '# Hybrid Transformer models', '955717e8-8726e21a.th', 'f7e0c4bc-ba3fe64a.th', 'd12395a8-e57c48e6.th', '92cfc3b6-ef3bcb9c.th', '04573f0d-f3cf25b2.th',
    '# Experimental 6 sources model', '5c90dfd2-34c22ccb.th', '',
  ].join('\n'));
  writeFileSync(path.join(remote, 'htdemucs.yaml'), "models: ['955717e8']\n");
  writeFileSync(path.join(remote, 'htdemucs_ft.yaml'), "models: ['f7e0c4bc', 'd12395a8', '92cfc3b6', '04573f0d']\n");
  writeFileSync(path.join(remote, 'htdemucs_6s.yaml'), "models: ['5c90dfd2']\n");
  writeFileSync(path.join(remote, 'mdx_extra.yaml'), 'models:\n- e51eebcc\n- "a1d90b5c"\n- 5d2d6c55\n- cfa93e08\nsegment: 44\n');
  return remote;
}

test('Demucs remote lists parse', () => {
  assert.deepEqual(parseRemoteFiles('# c\n955717e8-8726e21a.th\n\n  f7e0c4bc-ba3fe64a.th \n'), ['955717e8-8726e21a.th', 'f7e0c4bc-ba3fe64a.th']);
  assert.deepEqual(parseModelSignatures("models: ['a', \"b\"]\nweights: [1, 1]"), ['a', 'b']);
  assert.deepEqual(parseModelSignatures('segment: 44\nmodels:\n  - a\n  - b\nother: 1'), ['a', 'b']);
  assert.deepEqual(parseModelSignatures('nothing: here'), []);
});

test('modelsReady checks the checkpoint directory against Demucs’ own file list', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cpb-models-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = modelFiles(demucsRemote(root));
  assert.deepEqual(Object.keys(files), [...SEPARATION_MODELS]);
  assert.deepEqual(files.mdx_extra, ['e51eebcc-c1b80bdd.th', 'a1d90b5c-ae9d2452.th', '5d2d6c55-db83574e.th', 'cfa93e08-61801ae1.th']);
  const checkpoints = path.join(root, 'torch', 'hub', 'checkpoints');
  assert.deepEqual(modelsReady(files, checkpoints), { htdemucs: false, htdemucs_ft: false, htdemucs_6s: false, mdx_extra: false });
  mkdirSync(checkpoints, { recursive: true });
  for (const name of ['955717e8-8726e21a.th', 'f7e0c4bc-ba3fe64a.th', 'd12395a8-e57c48e6.th', '92cfc3b6-ef3bcb9c.th']) writeFileSync(path.join(checkpoints, name), '');
  assert.deepEqual(modelsReady(files, checkpoints), { htdemucs: true, htdemucs_ft: false, htdemucs_6s: false, mdx_extra: false });
  writeFileSync(path.join(checkpoints, '04573f0d-f3cf25b2.th'), '');
  assert.equal(modelsReady(files, checkpoints).htdemucs_ft, true);
  // Unknown lists: readiness unknown, so nothing is claimed.
  assert.equal(modelFiles(path.join(root, 'missing')), null);
  assert.deepEqual(modelsReady(null, checkpoints), {});
});

test('the Demucs lists are found in a frozen bundle or a dev venv, and checkpoints follow torch.hub', () => {
  const frozen = demucsRemoteDirs({ processor: '/R/processor/woodshed-processor/woodshed-processor', readdir: () => [] });
  assert.equal(frozen[0], path.join('/R/processor/woodshed-processor', '_internal', 'demucs', 'remote'));
  const dev = demucsRemoteDirs({ python: '/c/.venv/bin/python', readdir: dir => (dir === path.join('/c/.venv', 'lib') ? ['python3.11', 'site.py'] : []) });
  assert.ok(dev.includes(path.join('/c/.venv', 'lib', 'python3.11', 'site-packages', 'demucs', 'remote')));
  assert.ok(dev.includes(path.join('/c/.venv', 'Lib', 'site-packages', 'demucs', 'remote')));
  assert.equal(checkpointsDir({ TORCH_HOME: '/u/models' }, '/home/k'), path.join('/u/models', 'hub', 'checkpoints'));
  assert.equal(checkpointsDir({ XDG_CACHE_HOME: '/x' }, '/home/k'), path.join('/x', 'torch', 'hub', 'checkpoints'));
  assert.equal(checkpointsDir({}, '/home/k'), path.join('/home/k', '.cache', 'torch', 'hub', 'checkpoints'));
});

test('the /status body', () => {
  const body = statusBody({
    name: 'Studio MacBook', identity: { deviceId: 'dev1', userId: 'user1' }, busy: true, accepting: true,
    current: { id: 'job1', stage: 'separate', percent: 46, child: {}, abort: {} }, modelsReady: { htdemucs: true }, version: '2.0.0',
  });
  assert.deepEqual(body, {
    name: 'Studio MacBook', connected: true, deviceId: 'dev1', userId: 'user1', busy: true, accepting: true,
    job: { id: 'job1', stage: 'separate', percent: 46 }, modelsReady: { htdemucs: true }, version: '2.0.0',
  });
  assert.deepEqual(statusBody({ name: 'x', identity: null, busy: false, accepting: false, current: null, modelsReady: {} }),
    { name: 'x', connected: false, deviceId: null, userId: null, busy: false, accepting: false, job: null, modelsReady: {}, version: null });
});

test('the accelerator comes from the last separation-runtime.json', () => {
  assert.equal(acceleratorOf({ attempts: [{ device: 'mps' }, { device: 'cpu' }], device: 'cpu' }), 'CPU');
  assert.equal(acceleratorOf({ attempts: [{ device: 'cuda' }] }), 'NVIDIA GPU');
  assert.equal(acceleratorOf({ attempts: [{ device: 'mps' }] }), 'Apple GPU');
  assert.equal(acceleratorOf({}), null);
});

// ---------------------------------------------------------------- the running companion

function startServer(env) {
  const child = spawn(process.execPath, [path.join(here, 'server.mjs')], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const port = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      out += chunk;
      const m = /listening on 127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', code => reject(new Error(`companion exited (${code}): ${out}`)));
  });
  return { child, port };
}

test('the companion serves /status with the 2.0 fields and stops cleanly on SIGTERM', { timeout: 20_000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cpb-companion-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const venv = path.join(root, 'venv');
  demucsRemote(path.join(venv, 'lib', 'python3.11', 'site-packages'));
  const checkpoints = path.join(root, 'models', 'hub', 'checkpoints');
  mkdirSync(checkpoints, { recursive: true });
  writeFileSync(path.join(checkpoints, '955717e8-8726e21a.th'), '');
  const data = path.join(root, 'data');
  const { child, port: started } = startServer({
    WOODSHED_DATA_DIR: data, WOODSHED_COMPANION_PORT: '0', WOODSHED_WEB_URL: 'http://localhost:5173',
    WOODSHED_DEVICE_NAME: 'Studio MacBook', WOODSHED_APP_VERSION: '2.0.0', TORCH_HOME: path.join(root, 'models'),
    WOODSHED_PYTHON: path.join(venv, 'bin', 'python'), WOODSHED_PROCESSOR: '',
  });
  t.after(() => child.kill('SIGKILL'));
  const port = await started;
  const { token } = JSON.parse(readFileSync(path.join(data, 'connection.json'), 'utf8'));
  assert.equal(statSync(path.join(data, 'connection.json')).mode & 0o777, 0o600);
  const headers = { Origin: 'http://localhost:5173', Authorization: `Bearer ${token}` };
  const status = await fetch(`http://127.0.0.1:${port}/status`, { headers });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    name: 'Studio MacBook', connected: false, deviceId: null, userId: null, busy: false, accepting: true, job: null,
    modelsReady: { htdemucs: true, htdemucs_ft: false, htdemucs_6s: false, mdx_extra: false }, version: '2.0.0',
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/status`, { headers: { ...headers, Authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/status`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  const unpaired = await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', headers });
  assert.deepEqual([unpaired.status, await unpaired.json()], [400, { error: 'Pair the companion in Settings first.' }]);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null });
});

// ---------------------------------------------------------------- D12

test('no update cancellation remains: updates pause jobs (D12)', () => {
  const banned = ['cancel' + 'ForUpdate', 'update-' + 'cancellation'];
  const roots = ['companion', 'convex', 'desktop', 'src'].map(dir => path.join(here, '..', dir));
  const hits = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '_generated' || entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(c|m)?(js|ts)$|\.py$/.test(entry.name)) {
        const text = readFileSync(file, 'utf8');
        for (const word of banned) if (text.includes(word)) hits.push(`${path.relative(path.join(here, '..'), file)}: ${word}`);
      }
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------- the worker loop (items 1, 2, 6–10)

const FAKE_PROCESSOR = `#!/usr/bin/env node
// Stands in for process.py: follows the plan the test put in the claimed job (job.fake).
const fs = require('fs'), path = require('path');
const root = process.argv[2];
const job = JSON.parse(fs.readFileSync(path.join(root, 'job.json'), 'utf8'));
const plan = job.fake || {};
fs.writeFileSync(path.join(root, 'pid'), String(process.pid));
for (const [name, content] of Object.entries(plan.files || {})) fs.writeFileSync(path.join(root, name), typeof content === 'string' ? content : JSON.stringify(content));
for (const line of plan.lines || []) process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\\n');
if (plan.stderr) process.stderr.write(plan.stderr);
if (plan.result) fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(plan.result));
if (plan.hang) setInterval(() => {}, 1000);
else process.exitCode = plan.exit || 0;
`;

const DEPLOYMENT = 'https://happy-otter-123.convex.cloud';
const IDENTITY = { deviceId: 'dev1', userId: 'user1' };

function fakeConvex(handlers) {
  const calls = [];
  let subscription = null;
  const call = kind => async (ref, args) => {
    const name = getFunctionName(ref);
    calls.push({ kind, name, args });
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected ${kind} ${name}`);
    return handler(args);
  };
  return {
    calls,
    query: call('query'), mutation: call('mutation'), action: call('action'),
    onUpdate(ref, args, onResult, onError) {
      subscription = { onResult, onError };
      void Promise.resolve(handlers['worker:next'](args)).then(job => subscription?.onResult(job));
      return () => { subscription = null; };
    },
    close: async () => {},
    named: name => calls.filter(c => c.name === name),
  };
}

async function until(predicate, what, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Starts a companion wired to a fake Convex client and the fake processor, paired and connected. */
async function companion(t, { jobs, handlers = {} }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cpb-loop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const processor = path.join(root, 'woodshed-processor');
  writeFileSync(processor, FAKE_PROCESSOR, { mode: 0o755 });
  const queue = [...jobs];
  const client = fakeConvex({
    'devices:identity': () => IDENTITY,
    'worker:next': () => queue[0] ?? null,
    'worker:claim': ({ jobId }) => { const i = queue.findIndex(j => j._id === jobId); const [job] = queue.splice(i, 1); return { ...job, status: 'running', attempts: 1 }; },
    'worker:progress': () => true,
    'worker:heartbeat': () => null,
    'worker:beatsDone': () => null,
    'worker:sectionsDone': () => null,
    ...handlers,
  });
  const exits = [];
  const data = path.join(root, 'data');
  const app = await startCompanion({
    env: {
      ...process.env, WOODSHED_DATA_DIR: data, WOODSHED_COMPANION_PORT: '0', WOODSHED_WEB_URL: 'http://localhost:5173',
      WOODSHED_PROCESSOR: processor, WOODSHED_APP_VERSION: '2.0.0', WOODSHED_PLATFORM: 'linux-x64', TORCH_HOME: path.join(root, 'models'),
    },
    argv: [], createClient: () => client, exit: code => exits.push(code), installSignals: false,
  });
  const port = await app.ready;
  const accountDir = path.join(data, 'accounts', createHash('sha256').update(`${DEPLOYMENT}:${IDENTITY.userId}`).digest('hex').slice(0, 24));
  // Chained jobs find their separation's source here.
  for (const job of jobs) if (job.chainedFrom) { mkdirSync(path.join(accountDir, 'jobs', job.chainedFrom), { recursive: true }); writeFileSync(path.join(accountDir, 'jobs', job.chainedFrom, 'source.wav'), 'RIFF'); }
  const headers = { Origin: 'http://localhost:5173', Authorization: `Bearer ${app.token}` };
  const connected = await fetch(`http://127.0.0.1:${port}/connect`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ convexUrl: DEPLOYMENT }) });
  assert.equal(connected.status, 200);
  t.after(() => app.shutdown());
  const status = async () => (await fetch(`http://127.0.0.1:${port}/status`, { headers })).json();
  return { client, exits, app, accountDir, status, jobDir: id => path.join(accountDir, 'jobs', id) };
}

const progressOf = client => client.named('worker:progress').map(c => c.args);
const beatsOf = client => client.named('worker:heartbeat').map(({ args: { token, ...beat } }) => beat);

test('a chained beats job reuses the local source, flushes its last progress and reports bars with sections', { timeout: 20_000 }, async t => {
  const { client, jobDir } = await companion(t, { jobs: [{
    _id: 'job2', kind: 'beats', chainedFrom: 'job1', settings: { sections: true }, song: { duration: 12, stems: [{ key: 'stems/k1' }] },
    fake: {
      lines: [
        { stage: 'detect', percent: 20, message: 'Building a mix locally…' },
        { stage: 'detect', percent: 50, message: 'Finding bars…' },
        { stage: 'detect', percent: 95, message: 'Saving bars…' },
        'not json', { complete: true },
      ],
      result: { beats: [[0.5, 1], [1, 2]], sections: [{ t0: 0, label: 'Intro', confidence: 0.5 }] },
    },
  }] });
  const [done] = await until(() => client.named('worker:beatsDone').length && client.named('worker:beatsDone'), 'beatsDone');
  assert.deepEqual(done.args, { token: done.args.token, jobId: 'job2', beats: [[0.5, 1], [1, 2]], sections: [{ t0: 0, label: 'Intro', confidence: 0.5 }] });
  const job = JSON.parse(readFileSync(path.join(jobDir('job2'), 'job.json'), 'utf8'));
  assert.equal(job.localMix, path.join(jobDir('job1'), 'source.wav'));
  assert.equal(client.named('media:signKeys').length, 0, 'no stem download');
  const progress = progressOf(client);
  assert.deepEqual(progress[0], { token: progress[0].token, jobId: 'job2', stage: 'detect', percent: 20, message: 'Building a mix locally…' });
  assert.equal(progress.at(-1).percent, 95, 'the final event went out before the result');
  const order = client.calls.map(c => c.name);
  assert.ok(order.lastIndexOf('worker:progress') < order.indexOf('worker:beatsDone'));
  await until(() => beatsOf(client).at(-1)?.state === 'idle' && beatsOf(client).length >= 3, 'idle beat');
  assert.deepEqual(beatsOf(client).slice(0, 3), [
    { state: 'idle', appVersion: '2.0.0', platform: 'linux-x64' },
    { state: 'busy', currentJobId: 'job2' },
    { state: 'idle' },
  ]);
});

test('an unchained detection downloads the stems first, under "Fetching audio…"; a sections job reports through sectionsDone', { timeout: 20_000 }, async t => {
  const files = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'audio/webm' }); res.end(`audio of ${req.url}`); });
  await new Promise(resolve => files.listen(0, '127.0.0.1', resolve));
  t.after(() => files.close());
  const base = `http://127.0.0.1:${files.address().port}`;
  const { client, jobDir } = await companion(t, {
    jobs: [{ _id: 'job3', kind: 'sections', settings: {}, downbeats: [0, 2, 4], song: { duration: 8, stems: [{ key: 'a' }, { key: 'b' }] }, fake: { result: { sections: [] } } }],
    handlers: { 'media:signKeys': ({ keys }) => Object.fromEntries(keys.map(k => [k, `${base}/${k}`])) },
  });
  const [done] = await until(() => client.named('worker:sectionsDone').length && client.named('worker:sectionsDone'), 'sectionsDone');
  assert.deepEqual(done.args.sections, []);
  const progress = progressOf(client);
  assert.deepEqual([progress[0].stage, progress[0].percent, progress[0].message], ['detect', 5, 'Fetching audio…']);
  const job = JSON.parse(readFileSync(path.join(jobDir('job3'), 'job.json'), 'utf8'));
  assert.equal(job.localMix, undefined);
  assert.deepEqual(job.localStems.map(f => readFileSync(f, 'utf8')), ['audio of /a', 'audio of /b']);
});

test('a processor failure reports its code and raw text; meta reaches the job early', { timeout: 20_000 }, async t => {
  const { client } = await companion(t, { jobs: [{
    _id: 'job4', kind: 'separate', source: { type: 'url', value: 'https://youtu.be/x' }, settings: { stemMode: 'full' }, quality: { model: 'htdemucs' },
    fake: {
      lines: [
        { stage: 'download', percent: 100, message: 'Ready' },
        { meta: { title: 'Harbor Lights', artist: 'Ada Moreno', uploader: '', duration: 221, thumbnail: 'https://i.ytimg.com/x.jpg', provider: 'Youtube' } },
        { error: 'yt-dlp exited with code 1\nERROR: [youtube] x: Video unavailable', code: 'unavailable' },
      ],
      stderr: 'Traceback noise', exit: 1,
    },
  }] });
  const failure = await until(() => progressOf(client).find(p => p.stage === 'error'), 'error report');
  assert.deepEqual(failure, { token: failure.token, jobId: 'job4', stage: 'error', percent: 0, error: 'yt-dlp exited with code 1\nERROR: [youtube] x: Video unavailable', errorCode: 'unavailable' });
  const meta = progressOf(client).find(p => p.meta);
  assert.deepEqual(meta.meta, { title: 'Harbor Lights', channel: 'Ada Moreno', duration: 221, thumbnail: 'https://i.ytimg.com/x.jpg', provider: 'Youtube' });
  assert.deepEqual([meta.stage, meta.percent, meta.message], ['download', 100, 'Ready']);
});

test('a separation syncs its stems with checksums and completes with where it landed', { timeout: 20_000 }, async t => {
  const puts = [];
  const bucket = http.createServer(async (req, res) => {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    puts.push({ url: req.url, headers: req.headers, body: Buffer.concat(parts).toString() });
    res.writeHead(200); res.end();
  });
  await new Promise(resolve => bucket.listen(0, '127.0.0.1', resolve));
  t.after(() => bucket.close());
  const quality = { model: 'htdemucs_6s', shifts: 1, overlap: 0.25, format: 'opus' };
  const { client, jobDir, status } = await companion(t, {
    jobs: [{
      _id: 'job5', kind: 'separate', source: { type: 'search', value: 'harbor lights' }, settings: { stemMode: 'full' }, quality,
      fake: {
        files: { 'drums.webm': 'drum bytes', 'separation-runtime.json': { attempts: [{ device: 'mps' }], device: 'mps' } },
        lines: [{ stage: 'finalize', percent: 90, message: 'Encoding sync copies locally…' }],
        result: { title: 'Harbor Lights', uploader: 'Ada', artist: 'Ada Moreno', album: '', duration: 221, stemMode: 'full', quality,
          resolvedUrl: 'https://www.youtube.com/watch?v=x', provider: 'Youtube', files: [{ name: 'drums.webm', stem: 'drums', mime: 'audio/webm' }] },
      },
    }],
    handlers: {
      'blobs:prepare': ({ files }) => files.map(f => ({ ...f, key: `r2/${f.name}`, url: `http://127.0.0.1:${bucket.address().port}/${f.name}` })),
      'blobs:complete': () => 'song1',
    },
  });
  const [complete] = await until(() => client.named('blobs:complete').length && client.named('blobs:complete'), 'complete');
  const [prepare] = client.named('blobs:prepare');
  const checksum = createHash('sha256').update('drum bytes').digest('base64');
  assert.deepEqual(prepare.args.files, [{ name: 'drums.webm', bytes: 10, mime: 'audio/webm', checksum }]);
  assert.equal(puts[0].body, 'drum bytes');
  assert.equal(puts[0].headers['x-amz-checksum-sha256'], checksum);
  assert.deepEqual(complete.args.result, {
    title: 'Harbor Lights', uploader: 'Ada', artist: 'Ada Moreno', album: '', duration: 221, stemMode: 'full', quality,
    resolvedUrl: 'https://www.youtube.com/watch?v=x', provider: 'Youtube', stems: [{ name: 'drums', key: 'r2/drums.webm', bytes: 10, mime: 'audio/webm' }],
  });
  const order = client.calls.map(c => c.name === 'worker:progress' ? `progress:${c.args.stage}` : c.name);
  assert.ok(order.indexOf('progress:sync') < order.indexOf('blobs:prepare'));
  await until(() => existsSync(path.join(jobDir('job5'), 'synced.json')), 'synced.json');
  assert.deepEqual(JSON.parse(readFileSync(path.join(jobDir('job5'), 'synced.json'), 'utf8')), { songId: 'song1' });
  // The accelerator the split ran on rides on the next beat (B5).
  await until(() => beatsOf(client).find(b => b.accelerator), 'accelerator beat');
  assert.deepEqual(beatsOf(client).find(b => b.accelerator), { state: 'idle', appVersion: '2.0.0', platform: 'linux-x64', accelerator: 'Apple GPU' });
  assert.equal((await status()).busy, false);
});

test('a full cloud library fails the job as storage_full', { timeout: 20_000 }, async t => {
  const { client } = await companion(t, {
    jobs: [{ _id: 'job6', kind: 'separate', source: { type: 'url', value: 'https://youtu.be/x' }, settings: {}, quality: { model: 'htdemucs' },
      fake: { files: { 'drums.webm': 'x' }, result: { title: 'T', duration: 1, stemMode: 'full', quality: {}, files: [{ name: 'drums.webm', stem: 'drums', mime: 'audio/webm' }] } } }],
    handlers: { 'blobs:prepare': () => { throw new ConvexError({ code: 'storage_full_user', message: 'Your cloud library is full. Upgrade in Plan & billing.' }); } },
  });
  const failure = await until(() => progressOf(client).find(p => p.stage === 'error'), 'error report');
  assert.equal(failure.errorCode, 'storage_full');
  assert.equal(failure.error, 'Your cloud library is full. Upgrade in Plan & billing.');
});

test('an upload whose original is not on this computer fails as source_missing before the processor runs', { timeout: 20_000 }, async t => {
  const { client, jobDir } = await companion(t, { jobs: [{ _id: 'job7', kind: 'separate', source: { type: 'upload', value: '../../etc/passwd' }, settings: {}, quality: {} }] });
  const failure = await until(() => progressOf(client).find(p => p.stage === 'error'), 'error report');
  assert.equal(failure.errorCode, 'source_missing');
  assert.equal(existsSync(path.join(jobDir('job7'), 'pid')), false);
});

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a canceled job is stopped and reports nothing', { timeout: 20_000 }, async t => {
  const { client, jobDir } = await companion(t, {
    jobs: [{ _id: 'job8', kind: 'separate', source: { type: 'url', value: 'https://youtu.be/x' }, settings: {}, quality: {},
      fake: { lines: [{ stage: 'download', percent: 5, message: 'Downloading audio…' }], hang: true } }],
    handlers: { 'worker:progress': () => false },
  });
  const pidFile = path.join(jobDir('job8'), 'pid');
  await until(() => existsSync(pidFile), 'processor start');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await until(() => !alive(pid), 'processor stopped');
  await until(() => beatsOf(client).at(-1)?.state === 'idle', 'idle beat');
  assert.equal(progressOf(client).filter(p => p.stage === 'error').length, 0);
});

test('shutting down (quit or update) stops the processor, leaves the job running and reports offline (D12)', { timeout: 20_000 }, async t => {
  const { client, exits, app, jobDir } = await companion(t, { jobs: [{ _id: 'job9', kind: 'separate', source: { type: 'url', value: 'https://youtu.be/x' }, settings: {}, quality: {},
    fake: { lines: [{ stage: 'separate', percent: 40, message: 'Separating stems…' }], hang: true } }] });
  const pidFile = path.join(jobDir('job9'), 'pid');
  await until(() => existsSync(pidFile) && beatsOf(client).some(b => b.state === 'busy'), 'running job');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await app.shutdown();
  assert.deepEqual(exits, [0]);
  await until(() => !alive(pid), 'processor stopped');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(progressOf(client).filter(p => p.stage === 'error').length, 0, 'the job is not failed');
  assert.ok(!client.calls.some(c => /cancel/i.test(c.name)), 'nothing is canceled');
  assert.deepEqual(beatsOf(client).at(-1), { state: 'offline' });
});
