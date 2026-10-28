// The local processor's companion (architecture §6.10 CPA, CPB).
//
// A loopback HTTP server for the desktop renderer (pairing, /status, uploads,
// B4 lookups, legacy import) and the worker loop: it subscribes to
// `worker.next`, claims a job, runs process.py (or the frozen processor) on
// it, forwards its progress to Convex, syncs the result and reports presence
// (B5). Jobs are resumable: an update or a restart just stops the processor,
// and the next launch resumes the `running` job (D12).
//
// The pure parts (error codes, the progress throttle, /status, metadata) are
// exported for companion/server.test.mjs; importing this module starts nothing.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs, createReadStream, createWriteStream, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConvexClient } from 'convex/browser';
import { anyApi as api } from 'convex/server';
import { createLookup, createLookupRoutes, createYtDlp, ytDlpCommand } from './lookup.mjs';
import { createHeartbeat } from './heartbeat.mjs';

// ---------------------------------------------------------------- job error codes

/** A companion-side failure with its job error code (§6.1): source_missing, storage_full, account_paused, sync_failed, … */
export class CodedError extends Error {
  /**
   * @param {string} code a convex/lib/errors.ts JOB_ERROR_CODES value
   * @param {string} message the raw text (shown behind Details)
   * @param {{detail?: string}} [extra]
   */
  constructor(code, message, { detail } = {}) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

/** Coded Convex errors (convex/lib/errors.ts `fail`) that name a job error code. */
const CONVEX_TO_JOB_CODE = Object.freeze({
  storage_full_user: 'storage_full',
  storage_full_app: 'storage_full',
  account_suspended: 'account_paused',
  account_export_only: 'account_paused',
});

/** The `code` of a coded Convex error (`ConvexError.data.code`), else null. */
export function convexCode(error) {
  const data = error?.data;
  return data && typeof data === 'object' && typeof data.code === 'string' ? data.code : null;
}

/** The job error code for any failure in a job: coded, Convex-coded, a full disk, else unknown. */
export function jobErrorCode(error) {
  if (error instanceof CodedError) return error.code;
  const convex = convexCode(error);
  if (convex) return CONVEX_TO_JOB_CODE[convex] ?? 'unknown';
  if (error?.code === 'ENOSPC' || /\bENOSPC\b|no space left on device/i.test(String(error?.message ?? ''))) return 'disk_full';
  return 'unknown';
}

/** The raw failure text stored as `job.error` (Details): the message, then any detail. */
export function errorText(error) {
  const data = error?.data;
  const message = (data && typeof data === 'object' && typeof data.message === 'string' ? data.message : null)
    ?? String(error?.message ?? error ?? 'Unknown error');
  return error?.detail ? `${message}\n${error.detail}` : message;
}

// ---------------------------------------------------------------- progress

export const PROGRESS_INTERVAL_MS = 2000;

/**
 * Forwards processor progress to Convex (§6.10 CPB item 2). An event goes out
 * at once on a stage change and on a message change at percent 0; within a
 * stage, at most one event per `intervalMs`, with a trailing flush so the
 * last event of a burst is never lost. `flush()` sends what is pending and
 * resolves once every send has settled (call it before the job's final call).
 * Sends are sequential, in push order.
 *
 * @param {{send: (event: {stage: string, percent: number, message?: string, meta?: object}) => Promise<unknown>,
 *   now?: () => number, setTimeout?: typeof globalThis.setTimeout, clearTimeout?: typeof globalThis.clearTimeout,
 *   intervalMs?: number, log?: (...args: unknown[]) => void}} options
 */
export function createProgressThrottle({
  send,
  now = Date.now,
  setTimeout: after = globalThis.setTimeout,
  clearTimeout: cancelAfter = globalThis.clearTimeout,
  intervalMs = PROGRESS_INTERVAL_MS,
  log = (...args) => console.error(...args),
}) {
  let sent = null;        // the last event handed to send
  let latest = null;      // the last event pushed
  let pending = null;     // pushed but not yet sent
  let sentAt = -Infinity;
  let timer = null;
  let chain = Promise.resolve();
  let seed = null;        // the claimed job's own stage, percent and message
  let heldMeta = null;    // meta that arrived before any progress, with nothing to ride on

  function withHeldMeta(event) {
    if (!heldMeta) return event;
    const out = { ...event, meta: heldMeta };
    heldMeta = null;
    return out;
  }

  function dispatch(event) {
    if (timer !== null) { cancelAfter(timer); timer = null; }
    pending = null;
    sent = event;
    sentAt = now();
    chain = chain.then(() => send(event)).catch(error => log('Progress update:', error?.message ?? String(error)));
    return chain;
  }

  function schedule() {
    if (timer !== null) return;
    timer = after(() => { timer = null; if (pending) void dispatch(pending); }, Math.max(0, sentAt + intervalMs - now()));
  }

  return {
    /** A progress event from the processor (or the companion itself). */
    push(event) {
      latest = event;
      if (heldMeta) { void dispatch(withHeldMeta(event)); return; }
      const atZero = Math.floor(Number(event.percent) || 0) === 0;
      if (!sent || event.stage !== sent.stage || (atZero && event.message !== sent.message) || now() - sentAt >= intervalMs) {
        void dispatch(event);
        return;
      }
      pending = event;
      schedule();
    },
    /**
     * The claimed job's stored stage, percent and message: what an early meta
     * rides on before the processor reports anything, so a resumed job keeps
     * its place (worker.progress writes stage, percent and message every time).
     */
    seed(event) { seed = event ?? null; },
    /**
     * Early metadata (B4): sent at once, with the latest (else the claimed)
     * stage, percent and message; with neither, it rides on the next event.
     */
    pushMeta(meta) {
      const base = latest ?? seed;
      if (!base) { heldMeta = meta; return; }
      latest = { stage: base.stage, percent: base.percent, ...(base.message !== undefined ? { message: base.message } : {}) };
      void dispatch({ ...latest, meta });
    },
    /** Sends anything pending; resolves when every send has settled. Never rejects. */
    flush() {
      if (pending) void dispatch(withHeldMeta(pending));
      return chain;
    },
    /** Drops anything pending (the job is gone). */
    cancel() {
      if (timer !== null) { cancelAfter(timer); timer = null; }
      pending = null;
      heldMeta = null;
    },
    get latest() { return latest; },
  };
}

/** A processor progress line, validated; null when it is not one. */
export function progressEvent(line) {
  if (!line || typeof line.stage !== 'string' || !line.stage) return null;
  const percent = Number(line.percent);
  return {
    stage: line.stage.slice(0, 30),
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
    ...(typeof line.message === 'string' ? { message: line.message.slice(0, 300) } : {}),
  };
}

/**
 * `worker.progress`'s `meta` (jobMetaValidator: title, channel, duration,
 * thumbnail) from the processor's `{"meta": {title, artist, uploader, duration,
 * thumbnail}}` line; null when nothing usable is in it. `provider` is never
 * forwarded: job.meta.provider is the Add sheet's Candidate vocabulary
 * ('youtube'|'soundcloud'|'other'), and yt-dlp's extractor_key belongs only on
 * the result (songs.provider).
 */
export function jobMetaOf(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const text = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : undefined);
  const out = {
    title: text(meta.title),
    channel: text(meta.uploader) ?? text(meta.artist),
    duration: typeof meta.duration === 'number' && Number.isFinite(meta.duration) && meta.duration > 0 ? meta.duration : undefined,
    thumbnail: typeof meta.thumbnail === 'string' && /^https:\/\/\S+$/i.test(meta.thumbnail) && meta.thumbnail.length <= 2000 ? meta.thumbnail : undefined,
  };
  const clean = Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined));
  return Object.keys(clean).length ? clean : null;
}

// ---------------------------------------------------------------- processor exit

export const SETUP_HINT = 'Run npm run companion:setup first.';

/**
 * The failure for a processor that exited non-zero. The processor's own
 * `{"error", "code"}` line wins; otherwise the code comes from the stage (a
 * kill while separating is the split failing). The developer hint appears only
 * when no packaged processor is configured (`!WOODSHED_PROCESSOR`), and the
 * stderr tail goes to the raw text (Details), never as the sentence.
 */
export function processorFailure({ exitCode = null, signal = null, errorEvent = null, stderr = '', stage = null, packaged = false }) {
  const tail = String(stderr || '').trim().slice(-3000);
  if (errorEvent?.error) {
    const code = typeof errorEvent.code === 'string' && errorEvent.code ? errorEvent.code : 'unknown';
    return new CodedError(code, String(errorEvent.error));
  }
  const how = signal ? `was stopped (${signal})` : `exited (${exitCode})`;
  const message = `Processor ${how}.${packaged ? '' : ` ${SETUP_HINT}`}`;
  const code = stage === 'separate' && (signal || (typeof exitCode === 'number' && exitCode < 0)) ? 'separation_failed' : 'unknown';
  return new CodedError(code, message, { detail: tail || undefined });
}

// ---------------------------------------------------------------- /status

/** Models whose readiness /status reports (the presets' models, spec §3.2). */
export const SEPARATION_MODELS = Object.freeze(['htdemucs', 'htdemucs_ft', 'htdemucs_6s', 'mdx_extra']);

/** demucs/remote/files.txt: the weight file names, one per line ("955717e8-8726e21a.th"); "#" lines are comments. */
export function parseRemoteFiles(text) {
  return String(text).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

/** The model signatures of a demucs/remote/<model>.yaml: `models: ['f7e0c4bc', …]` or a block list. */
export function parseModelSignatures(yaml) {
  const lines = String(yaml).split(/\r?\n/);
  const at = lines.findIndex(line => /^models\s*:/.test(line));
  if (at < 0) return [];
  const unquote = s => s.trim().replace(/^['"]|['"]$/g, '');
  const inline = /^models\s*:\s*\[(.*)\]\s*$/.exec(lines[at]);
  if (inline) return inline[1].split(',').map(unquote).filter(Boolean);
  const out = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (!item) break;
    out.push(unquote(item[1]));
  }
  return out.filter(Boolean);
}

/** torch.hub's checkpoint directory: $TORCH_HOME, else $XDG_CACHE_HOME/torch, else ~/.cache/torch; then hub/checkpoints. */
export function checkpointsDir(env = process.env, home = os.homedir()) {
  const torchHome = env.TORCH_HOME || path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'torch');
  return path.join(torchHome, 'hub', 'checkpoints');
}

/** Where the installed Demucs keeps its remote model lists: the frozen bundle, else the dev venv. */
export function demucsRemoteDirs({ processor, python, readdir = dir => readdirSync(dir) }) {
  const dirs = [];
  if (processor) {
    const bundle = path.dirname(processor);
    dirs.push(path.join(bundle, '_internal', 'demucs', 'remote'), path.join(bundle, 'demucs', 'remote'));
  }
  if (python) {
    const venv = path.dirname(path.dirname(python));
    dirs.push(path.join(venv, 'Lib', 'site-packages', 'demucs', 'remote'));
    let versions = [];
    try { versions = readdir(path.join(venv, 'lib')).filter(name => /^python3/.test(name)).sort().reverse(); } catch { /* no venv */ }
    for (const version of versions) dirs.push(path.join(venv, 'lib', version, 'site-packages', 'demucs', 'remote'));
  }
  return dirs;
}

/**
 * The weight files each model needs, from Demucs' own remote lists (never
 * hard-coded hashes): `{model: ['955717e8-8726e21a.th', …]}`. A model whose
 * list or files cannot be read is left out (its readiness is unknown).
 */
export function modelFiles(remoteDir, { models = SEPARATION_MODELS, readFile = file => readFileSync(file, 'utf8') } = {}) {
  let files;
  try { files = parseRemoteFiles(readFile(path.join(remoteDir, 'files.txt'))); } catch { return null; }
  const out = {};
  for (const model of models) {
    let signatures;
    try { signatures = parseModelSignatures(readFile(path.join(remoteDir, `${model}.yaml`))); } catch { continue; }
    const needed = signatures.map(sig => files.find(name => name.startsWith(`${sig}-`)));
    if (needed.length && needed.every(Boolean)) out[model] = needed;
  }
  return out;
}

/** `{model: bool}`: every weight file of the model is in the checkpoint directory. */
export function modelsReady(files, checkpoints, { readdir = dir => readdirSync(dir) } = {}) {
  if (!files) return {};
  let present;
  try { present = new Set(readdir(checkpoints)); } catch { present = new Set(); }
  return Object.fromEntries(Object.entries(files).map(([model, needed]) => [model, needed.every(name => present.has(name))]));
}

/** The /status body (§6.10 CPB item 4). */
export function statusBody({ name, identity, busy, accepting, current, modelsReady: ready, version }) {
  return {
    name,
    connected: !!identity,
    deviceId: identity?.deviceId ?? null,
    userId: identity?.userId ?? null,
    busy,
    accepting,
    job: current ? { id: current.id, stage: current.stage, percent: current.percent } : null,
    modelsReady: ready,
    version: version ?? null,
  };
}

/** The accelerator a separation ran on, from its separation-runtime.json: 'NVIDIA GPU' | 'Apple GPU' | 'CPU'. */
export function acceleratorOf(runtime) {
  const labels = { cuda: 'NVIDIA GPU', mps: 'Apple GPU', cpu: 'CPU' };
  const attempts = Array.isArray(runtime?.attempts) ? runtime.attempts : [];
  const device = runtime?.device ?? attempts[attempts.length - 1]?.device;
  return labels[device] ?? null;
}

// ---------------------------------------------------------------- the companion

const safe = value => String(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'untitled';

function limitBytes(max) {
  let size = 0;
  return new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(size > max ? new Error('File too large.') : null, chunk); } });
}

async function exists(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

/**
 * Starts the companion: the HTTP server, the saved connection and the worker loop.
 * `createClient` and `exit` default to the real Convex client and process.exit;
 * `installSignals: false` leaves SIGINT/SIGTERM and Electron's parent port alone
 * (an embedding host, or a test, calls the returned shutdown()).
 */
export async function startCompanion({
  env = process.env, argv = process.argv,
  createClient = url => new ConvexClient(url),
  exit = code => process.exit(code),
  installSignals = true,
} = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const data = env.WOODSHED_DATA_DIR || path.join(os.homedir(), '.woodshed-companion');
  let port = Number(env.WOODSHED_COMPANION_PORT || 47831);
  const webOrigin = new URL(env.WOODSHED_WEB_URL || 'http://localhost:5173').origin;
  const origins = new Set([webOrigin]);
  const configFile = path.join(data, 'connection.json');
  const runtimeFile = path.join(data, 'processor.json');
  const packaged = !!env.WOODSHED_PROCESSOR;
  await fs.mkdir(data, { recursive: true, mode: 0o700 });
  let config;
  try { config = JSON.parse(await fs.readFile(configFile, 'utf8')); }
  catch { config = { token: crypto.randomBytes(32).toString('hex') }; }
  if (argv.includes('--reset-pairing')) config = { token: crypto.randomBytes(32).toString('hex') };
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  let accelerator = null;
  try { accelerator = JSON.parse(await fs.readFile(runtimeFile, 'utf8')).accelerator ?? null; } catch { /* first run */ }

  let acceptingJobs = true, shuttingDown = false;
  let client = null, identity = null, stopSubscription = null, busy = false, pending = null, current = null;
  const python = env.WOODSHED_PYTHON || path.join(here, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const childEnv = { ...env, PATH: `${path.dirname(python)}${path.delimiter}${env.PATH}`, PYTHONUNBUFFERED: '1', PYTORCH_ENABLE_MPS_FALLBACK: env.PYTORCH_ENABLE_MPS_FALLBACK || '1' };
  // B4 lookups (/resolve, /search) run yt-dlp beside any job; they never touch `busy`.
  const lookupRoutes = createLookupRoutes(createLookup({
    ytDlp: createYtDlp({ ...ytDlpCommand({ processor: env.WOODSHED_PROCESSOR, python }), env: childEnv }),
  }));
  const accountDir = () => path.join(data, 'accounts', crypto.createHash('sha256').update(`${config.convexUrl}:${identity.userId}`).digest('hex').slice(0, 24));
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

  // /status: model readiness from Demucs' own lists, located once.
  let weights;
  const readiness = () => {
    if (weights === undefined) {
      weights = null;
      for (const dir of demucsRemoteDirs({ processor: env.WOODSHED_PROCESSOR, python })) {
        const files = modelFiles(dir);
        if (files) { weights = files; break; }
      }
    }
    return modelsReady(weights, checkpointsDir(env));
  };

  // B5 presence. The heartbeat outlives a reconnect to the same deployment.
  const heartbeat = createHeartbeat({
    send: beat => (client ? client.mutation(api.worker.heartbeat, { token: config.token, ...beat }) : Promise.resolve(null)),
    describe: () => ({ appVersion: env.WOODSHED_APP_VERSION, platform: env.WOODSHED_PLATFORM || `${process.platform}-${process.arch}`, accelerator: accelerator ?? undefined }),
  });

  async function body(req, max = 16384) {
    const parts = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > max) throw new Error('Request too large.'); parts.push(chunk); }
    return JSON.parse(Buffer.concat(parts).toString() || '{}');
  }

  async function connect(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.convex\.cloud$/.test(parsed.hostname) || parsed.pathname !== '/') throw new Error('Expected a Convex deployment URL.');
    if (busy && config.convexUrl !== url) throw new Error('Wait for processing to finish before switching deployments.');
    const next = createClient(url);
    let who;
    try { who = await next.query(api.devices.identity, { token: config.token }); }
    catch (error) { await next.close(); throw error; }
    // Leaving a deployment: tell it this computer went offline first.
    if (heartbeat.running && config.convexUrl !== url) await heartbeat.stop();
    stopSubscription?.(); await client?.close();
    client = next; identity = who; config.convexUrl = url;
    await fs.mkdir(accountDir(), { recursive: true, mode: 0o700 });
    await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    heartbeat.start();
    if (current) heartbeat.jobStarted(current.id);
    stopSubscription = client.onUpdate(api.worker.next, { token: config.token }, job => {
      pending = job;
      // `next` returns the running job first, so anything else means ours was canceled or moved.
      if (current && (!job || job._id !== current.id)) killCurrent('canceled');
      void drain();
    }, error => { console.error('Companion connection:', error.message); killCurrent('disconnected'); });
  }

  /** Stops the current job's processor. An aborted job reports nothing: it was canceled, or it resumes on the next launch. */
  function killCurrent(reason) {
    if (!current) return;
    current.throttle?.cancel();
    if (!current.abort.signal.aborted) current.abort.abort(reason);
    const child = current.child;
    if (!child) return;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } }
  }

  async function download(url, destination, signal) {
    let response;
    try { response = await fetch(url, { signal }); }
    catch (error) { if (signal.aborted) throw error; throw new CodedError('sync_failed', `Download failed (${error.message}).`); }
    if (!response.ok || !response.body) throw new CodedError('sync_failed', `Download failed (${response.status}).`);
    // A body cut short or over the limit is a failed download too; a full disk stays disk_full, an abort stays silent.
    try { await pipeline(Readable.fromWeb(response.body), limitBytes(300_000_000), createWriteStream(destination)); }
    catch (error) {
      if (signal.aborted || error?.code === 'ENOSPC') throw error;
      throw new CodedError('sync_failed', `Download failed (${error?.message ?? String(error)}).`);
    }
  }

  /** A progress event for the current job: /status follows every one; Convex gets them throttled. */
  function report(run, event) {
    run.stage = event.stage; run.percent = event.percent;
    run.throttle.push(event);
  }

  function execute(job, root, run) {
    run.abort.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const executable = env.WOODSHED_PROCESSOR || python;
      const args = env.WOODSHED_PROCESSOR ? [root] : [path.join(here, 'process.py'), root];
      const child = spawn(executable, args, { env: childEnv, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      run.child = child;
      let buffer = '', stderr = '', errorEvent = null;
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (!event || typeof event !== 'object') continue;
          if (event.error) { errorEvent = event; continue; }
          if (event.meta) { const meta = jobMetaOf(event.meta); if (meta) run.throttle.pushMeta(meta); continue; }
          const progress = progressEvent(event);
          if (progress) report(run, progress);
        }
      });
      child.on('error', error => reject(new CodedError('unknown', `The processor could not start (${error.message}).${packaged ? '' : ` ${SETUP_HINT}`}`)));
      // 'close' fires after stdout ends, so every line is read; the last event then goes out before the result.
      child.on('close', (exitCode, signal) => {
        if (run.child === child) run.child = null;
        void run.throttle.flush().then(() => {
          if (exitCode === 0) resolve();
          else reject(processorFailure({ exitCode, signal, errorEvent, stderr, stage: run.stage, packaged }));
        });
      });
    });
  }

  async function prepareDetection(job, root, run) {
    const mix = job.chainedFrom ? path.join(accountDir(), 'jobs', safe(job.chainedFrom), 'source.wav') : null;
    // B6: a chained job reuses the separation's local source instead of the R2 stems.
    if (mix && await exists(mix)) { job.localMix = mix; return; }
    const stems = job.song?.stems;
    if (!Array.isArray(stems) || !stems.length) throw new CodedError('unknown', 'The song has no stems to analyse.');
    report(run, { stage: 'detect', percent: 5, message: 'Fetching audio…' });
    const urls = await client.action(api.media.signKeys, { token: config.token, keys: stems.map(s => s.key) });
    job.localStems = [];
    for (const [i, stem] of stems.entries()) {
      run.abort.signal.throwIfAborted();
      const dest = path.join(root, `input-${i}.audio`);
      if (!urls[stem.key]) throw new CodedError('sync_failed', 'Download failed (no signed URL).');
      await download(urls[stem.key], dest, run.abort.signal); job.localStems.push(dest);
    }
  }

  async function syncResult(job, root, run, result) {
    const files = [];
    for (const f of result.files) {
      const filePath = path.join(root, f.name);
      const hash = crypto.createHash('sha256');
      for await (const chunk of createReadStream(filePath)) hash.update(chunk);
      files.push({ name: f.name, bytes: (await fs.stat(filePath)).size, mime: f.mime, checksum: hash.digest('base64') });
    }
    report(run, { stage: 'sync', percent: 95, message: 'Syncing your library…' });
    await run.throttle.flush();
    run.abort.signal.throwIfAborted();
    const uploads = await client.action(api.blobs.prepare, { token: config.token, jobId: job._id, files });
    for (const file of uploads) {
      run.abort.signal.throwIfAborted();
      let response;
      try {
        response = await fetch(file.url, { signal: run.abort.signal, method: 'PUT', headers: { 'content-type': file.mime, 'content-length': String(file.bytes), 'x-amz-checksum-sha256': file.checksum }, body: createReadStream(path.join(root, file.name)), duplex: 'half' });
      } catch (error) {
        if (run.abort.signal.aborted) throw error;
        throw new CodedError('sync_failed', `Sync upload failed (${error.message}). Your local files are safe.`);
      }
      if (!response.ok) throw new CodedError('sync_failed', `Sync upload failed (${response.status}). Your local files are safe.`);
    }
    const { files: _files, ...meta } = result;
    const stems = result.files.filter(f => f.stem).map(f => { const u = uploads.find(u => u.name === f.name); return { name: f.stem, key: u.key, bytes: u.bytes, mime: u.mime }; });
    const coverKey = uploads.find(u => u.name === 'cover.jpg')?.key;
    let songId;
    try {
      songId = await client.action(api.blobs.complete, { token: config.token, jobId: job._id, result: { ...meta, stems, ...(coverKey ? { coverKey } : {}) } });
    } catch (error) {
      // A coded error keeps its code; anything else is the upload not verifying.
      if (convexCode(error)) throw error;
      throw new CodedError('sync_failed', errorText(error));
    }
    await fs.writeFile(path.join(root, 'synced.json'), JSON.stringify({ songId }));
  }

  async function runJob(queued, run) {
    const job = await client.mutation(api.worker.claim, { token: config.token, jobId: queued._id });
    run.throttle.seed(progressEvent(job));
    const root = path.join(accountDir(), 'jobs', safe(job._id));
    run.root = root;
    await fs.mkdir(root, { recursive: true });
    if (job.source?.type === 'upload' && job.kind !== 'beats' && job.kind !== 'sections') {
      if (!/^[a-f0-9-]{36}$/.test(job.source.value)) throw new CodedError('source_missing', 'Original file unavailable locally. Add the file again.');
      job.localSource = path.join(accountDir(), 'uploads', job.source.value);
    }
    if (job.kind === 'import') {
      let entries = {};
      try { entries = JSON.parse(await fs.readFile(path.join(accountDir(), 'imports.json'), 'utf8')); } catch { /* none on this computer */ }
      job.legacySong = entries[job.importMeta?.id];
      if (!job.legacySong) throw new CodedError('source_missing', 'Legacy files missing. Import from this computer again.');
    }
    if (job.kind === 'beats' || job.kind === 'sections') await prepareDetection(job, root, run);
    await fs.writeFile(path.join(root, 'job.json'), JSON.stringify(job));
    await execute(job, root, run);
    const result = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
    run.abort.signal.throwIfAborted();
    if (job.kind === 'beats') {
      await client.mutation(api.worker.beatsDone, { token: config.token, jobId: job._id, beats: result.beats, ...(Array.isArray(result.sections) ? { sections: result.sections } : {}) });
      return;
    }
    if (job.kind === 'sections') {
      await client.mutation(api.worker.sectionsDone, { token: config.token, jobId: job._id, sections: Array.isArray(result.sections) ? result.sections : [] });
      return;
    }
    await syncResult(job, root, run, result);
  }

  /** The accelerator of the separation that just ran (heartbeat `accelerator`, B5). */
  async function noteAccelerator(root) {
    if (!root) return;
    let label = null;
    try { label = acceleratorOf(JSON.parse(await fs.readFile(path.join(root, 'separation-runtime.json'), 'utf8'))); } catch { return; }
    if (!label || label === accelerator) return;
    accelerator = label;
    try { await fs.writeFile(runtimeFile, JSON.stringify({ accelerator })); } catch (error) { console.error('Processor state:', error.message); }
  }

  async function drain() {
    if (!acceptingJobs || busy || !pending || !client) return;
    const job = pending; pending = null; busy = true;
    const run = current = { id: job._id, child: null, abort: new AbortController(), stage: 'queued', percent: 0, root: null, throttle: null };
    run.throttle = createProgressThrottle({
      send: event => client.mutation(api.worker.progress, { token: config.token, jobId: job._id, ...event })
        .then(ok => { if (ok === false && current === run) killCurrent('canceled'); }),
    });
    heartbeat.jobStarted(job._id);
    try { await runJob(job, run); }
    catch (error) {
      if (run.abort.signal.aborted) console.error(`Job ${job._id} stopped (${run.abort.signal.reason}).`);
      else {
        console.error('Job failed:', error.message);
        await run.throttle.flush();
        try {
          await client.mutation(api.worker.progress, { token: config.token, jobId: job._id, stage: 'error', percent: 0, error: errorText(error).slice(0, 2000), errorCode: jobErrorCode(error) });
        } catch (report) { console.error('Error report:', report.message); }
      }
    } finally {
      await noteAccelerator(run.root);
      busy = false; current = null;
      heartbeat.jobEnded();
      if (pending?._id === job._id) pending = null;
      // Resolve next once after completion; no idle polling.
      if (acceptingJobs && client) {
        try { pending = await client.query(api.worker.next, { token: config.token }); } catch { /* the subscription delivers it */ }
        if (pending) setTimeout(() => void drain(), 100);
      }
    }
  }

  function legacyDirs() {
    return [path.join(os.homedir(), 'Library', 'Application Support', 'woodshed'), path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'woodshed'), path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'woodshed')];
  }
  async function readLegacy(dir) {
    const input = JSON.parse(await fs.readFile(path.join(dir, 'library.json'), 'utf8'));
    const songs = Array.isArray(input) ? input : input.songs;
    if (!Array.isArray(songs)) throw new Error('Unrecognized library.json.');
    return songs.map(song => {
      const songDir = path.join(dir, 'media', safe(song.id));
      return { ...song,
        stems: (song.stems || []).map(stem => ({ ...stem, path: stem.path ? path.resolve(dir, stem.path) : path.join(songDir, path.basename(stem.file)) })),
        ...(song.thumb ? { coverPath: path.join(songDir, path.basename(song.thumb)) } : song.coverPath ? { coverPath: path.resolve(dir, song.coverPath) } : {}) };
    });
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!['127.0.0.1:' + port, 'localhost:' + port].includes(req.headers.host) || !origin || !origins.has(origin)) { json(res, 403, { error: 'Untrusted origin.' }); return; }
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'authorization,content-type,x-filename', 'Access-Control-Allow-Private-Network': 'true' }); res.end(); return; }
    const expected = Buffer.from(`Bearer ${config.token}`), supplied = Buffer.from(req.headers.authorization || '');
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) { json(res, 401, { error: 'Invalid local processor credential.' }); return; }
    try {
      if (req.url === '/status' && req.method === 'GET') {
        json(res, 200, statusBody({ name: env.WOODSHED_DEVICE_NAME || os.hostname(), identity, busy, accepting: acceptingJobs, current, modelsReady: readiness(), version: env.WOODSHED_APP_VERSION }));
        return;
      }
      if (req.url === '/connect' && req.method === 'POST') { const input = await body(req); await connect(input.convexUrl); json(res, 200, identity); return; }
      // Lookups read no account data, so they sit before the pairing and identity checks.
      if (await lookupRoutes(req, res)) return;
      if (!client || !identity) throw new Error('Pair the companion in Settings first.');
      // Recheck revocation before any filesystem operation.
      await client.query(api.devices.identity, { token: config.token });
      if (req.url === '/upload' && req.method === 'POST') {
        const id = crypto.randomUUID(); const dir = path.join(accountDir(), 'uploads'); await fs.mkdir(dir, { recursive: true });
        const dest = path.join(dir, id);
        try { await pipeline(req, limitBytes(1_000_000_000), createWriteStream(dest, { flags: 'wx' })); } catch (error) { await fs.rm(dest, { force: true }); throw error; }
        json(res, 200, { id }); return;
      }
      if (req.url === '/export-originals' && req.method === 'POST') {
        const target = path.join(os.homedir(), 'Downloads', 'Woodshed-originals-' + new Date().toISOString().replace(/[:.]/g, '-'));
        let count = 0;
        async function copyAudio(from, to) {
          for (const e of await fs.readdir(from, { withFileTypes: true })) {
            const source = path.join(from, e.name), dest = path.join(to, e.name);
            if (e.isDirectory()) await copyAudio(source, dest);
            else if (/\.(wav|flac)$/.test(e.name)) { await fs.mkdir(to, { recursive: true }); await fs.copyFile(source, dest); count++; }
          }
        }
        const jobs = path.join(accountDir(), 'jobs');
        await copyAudio(jobs, target);
        json(res, 200, { directory: target, count }); return;
      }
      if (req.url === '/legacy' && req.method === 'GET') {
        const found = []; for (const dir of legacyDirs()) { try { const songs = await readLegacy(dir); found.push({ directory: dir, count: songs.length }); } catch { /* none there */ } }
        json(res, 200, found); return;
      }
      if (req.url === '/import' && req.method === 'POST') {
        const { directory } = await body(req); const songs = await readLegacy(directory);
        const file = path.join(accountDir(), 'imports.json'); let entries = {}; try { entries = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* first import */ }
        for (const s of songs) entries[String(s.id)] = s;
        await fs.writeFile(file, JSON.stringify(entries));
        let count = 0, skipped = 0;
        for (const s of songs) {
          if (count >= 20) break;
          const result = await client.mutation(api.worker.importSong, { token: config.token, legacyId: String(s.id), title: String(s.title || 'Imported song'), tempo: s.tempo ?? null, practice: s.practice ?? null });
          if (result.jobId) count++; else skipped++;
        }
        json(res, 200, { count, skipped, remaining: Math.max(0, songs.length - count - skipped) }); return;
      }
      json(res, 404, { error: 'Unknown endpoint.' });
    } catch (error) { json(res, 400, { error: error.message }); }
  });
  const ready = new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    port = server.address().port;
    resolve(port);
    if (installSignals && process.parentPort) { process.parentPort.postMessage({ port, token: config.token }); return; }
    console.log(`Woodshed companion listening on 127.0.0.1:${port}`);
    console.log('Open Woodshed for desktop and sign in to connect the local processor.');
    console.log(`Local originals and stems: ${data}`);
  }));
  if (config.convexUrl) connect(config.convexUrl).catch(error => console.error('Desktop processor connection:', error.message));

  /**
   * Stops for good (quit, or an app update). A running job is not canceled:
   * it stays `running`, process.py keeps what it finished, and the next
   * launch resumes it (`worker.next` returns it first, D12).
   */
  async function shutdown(){ // the brace stays on this line: lookup.test.mjs checks abortAll() comes first
    lookupRoutes.abortAll(); // B4: kill yt-dlp lookups now (lookup.mjs also kills any left on exit)
    if (shuttingDown) return;
    shuttingDown = true; acceptingJobs = false;
    killCurrent('shutdown');
    await heartbeat.stop();
    stopSubscription?.();
    try { await client?.close(); } catch { /* exiting anyway */ }
    server.close(); server.closeIdleConnections?.();
    exit(0);
  }
  if (installSignals) {
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown());
    process.parentPort?.on('message', event => {
      if (event.data?.type === 'quiesce') { acceptingJobs = false; process.parentPort.postMessage({ type: 'quiesced', busy }); }
      if (event.data?.type === 'resume') { acceptingJobs = true; void drain(); }
      if (event.data?.type === 'shutdown') void shutdown();
    });
  }
  return { server, ready, shutdown, token: config.token };
}

/** True when this file is the program (node companion/server.mjs, or Electron's utility process), not an import. */
function isMain() {
  if (process.parentPort) return true;
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) startCompanion().catch(error => { console.error('Woodshed companion could not start:', error.message); process.exit(1); });
