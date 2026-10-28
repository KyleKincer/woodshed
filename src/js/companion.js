// The renderer's client for the local processor (companion/server.mjs) on
// 127.0.0.1 (architecture §6.10 CPA). Credentials come only from the desktop
// preload bridge (window.woodshedDesktop.info()), never from web storage or
// the URL. Account authorization still happens in devices.pair.
//
// Every failure is a CompanionError, shaped like the API client's ApiError
// ({code, message, data, raw}), so src/app/error-copy.js reads both the same way:
//   processor_offline  no desktop bridge, the processor is not running, did not answer, or is not paired
//   timeout            no answer within timeoutMs (or the companion's own 504)
//   aborted            the caller's signal fired (name 'AbortError')
//   <server code>      the companion's {error, code}: bot_check, unavailable, not_found, playlist, invalid, lookup_busy, …
//   unknown            anything else
import { convex } from './auth.js';
import { anyApi as api } from 'convex/server';

const DEFAULT_PORT = 47831;
const DEFAULT_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 600_000;
const START_WAIT_MS = 120_000;
const STARTING_PHASES = new Set(['starting', 'restarting']);
const PROVIDERS = new Set(['youtube', 'soundcloud', 'other']);

let origin = `http://127.0.0.1:${DEFAULT_PORT}`;
let token = '';
let ready = false;
let starting = null;
let initialization = null;

export class CompanionError extends Error {
  /** @param {{code?: string, message?: string, status?: number, data?: object, raw?: unknown}} init */
  constructor({ code = 'unknown', message = 'The local processor request failed.', status = 0, data = {}, raw = null } = {}) {
    super(message);
    this.name = code === 'aborted' ? 'AbortError' : 'CompanionError';
    this.code = code;
    this.status = status;
    this.data = data;
    this.raw = raw;
  }
}

const offline = (message, raw = null) => new CompanionError({ code: 'processor_offline', message, raw });
const noDesktop = () => offline('Open Woodshed for desktop to process songs on this computer.');
const notReady = raw => offline('The local processor is not ready. Restart Woodshed.', raw);
const notPaired = () => offline('Woodshed’s processor isn’t connected to your account yet.');
const abortedError = signal => new CompanionError({ code: 'aborted', message: 'The request was canceled.', raw: signal?.reason ?? null });
const timeoutError = raw => new CompanionError({ code: 'timeout', message: 'The local processor took too long to answer.', raw });
const bridge = () => (typeof window === 'undefined' ? undefined : window.woodshedDesktop);

export const isDesktopApp = () => !!bridge();

/** Adopt {port, token} from the bridge's info().companion. */
function adopt(companion) {
  if (!companion || !Number.isInteger(companion.port) || !/^[a-f0-9]{64}$/.test(companion.token ?? '')) return false;
  origin = `http://127.0.0.1:${companion.port}`;
  token = companion.token;
  return true;
}

/**
 * The bridge's info() once the processor has started. At launch main answers
 * `companion: null` with `processor.phase === 'starting'` (DT1); wait for its
 * `ready` processor-state event, then ask again for {port, token}.
 */
async function startedInfo(desktop) {
  let off = () => {};
  const started = new Promise((resolve, reject) => {
    if (typeof desktop.onProcessorState !== 'function') return;
    off = desktop.onProcessorState(state => {
      if (state?.phase === 'ready') resolve();
      else if (state?.phase === 'stopped') reject(offline(state.message || 'The local processor stopped.'));
    });
  });
  started.catch(() => {});
  let timer;
  try {
    const info = await desktop.info();
    if (info?.companion || !STARTING_PHASES.has(info?.processor?.phase) || typeof desktop.onProcessorState !== 'function') return info;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(offline('The local processor did not start. Restart Woodshed.')), START_WAIT_MS); });
    await Promise.race([started, late]);
    return await desktop.info();
  } finally {
    clearTimeout(timer);
    off();
  }
}

/** Make sure {origin, token} are known, reading them from the bridge when they are not (→ that info). */
async function endpoint() {
  const desktop = bridge();
  if (!desktop) throw noDesktop();
  if (token) return undefined;
  starting ??= startedInfo(desktop).finally(() => { starting = null; });
  let info;
  try { info = await starting; } catch (error) { throw error instanceof CompanionError ? error : notReady(error); }
  if (!adopt(info?.companion)) throw notReady();
  return info;
}

function combine(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return { combined: timeout, timeout };
  if (typeof AbortSignal.any === 'function') return { combined: AbortSignal.any([signal, timeout]), timeout };
  const controller = new AbortController();
  for (const source of [signal, timeout]) {
    if (source.aborted) controller.abort(source.reason);
    else source.addEventListener('abort', () => controller.abort(source.reason), { once: true });
  }
  return { combined: controller.signal, timeout };
}

/** A non-2xx companion answer → CompanionError with the server's code when it sent one. */
function answerError(status, body) {
  const { error, code, ...data } = body && typeof body === 'object' ? body : {};
  const fallback = status === 504 ? 'timeout' : status === 401 ? 'processor_offline' : 'unknown';
  return new CompanionError({
    code: typeof code === 'string' && code ? code : fallback,
    message: typeof error === 'string' && error ? error : `The local processor request failed (${status}).`,
    status,
    data,
  });
}

async function send(path, { method, body, signal, timeoutMs }) {
  if (signal?.aborted) throw abortedError(signal);
  const blob = typeof Blob !== 'undefined' && body instanceof Blob;
  const verb = (method ?? (body === undefined ? 'GET' : 'POST')).toUpperCase();
  const withBody = body !== undefined && verb !== 'GET' && verb !== 'HEAD';
  const headers = { authorization: `Bearer ${token}` };
  if (withBody) headers['content-type'] = blob ? 'application/octet-stream' : 'application/json';
  const { combined, timeout } = combine(signal, timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response, result;
  try {
    response = await fetch(origin + path, { method: verb, headers, body: withBody ? (blob ? body : JSON.stringify(body)) : undefined, signal: combined });
    result = await response.json().catch(error => { if (combined.aborted) throw error; return undefined; });
  } catch (error) {
    if (signal?.aborted) throw abortedError(signal);
    if (timeout.aborted) throw timeoutError(error);
    token = '';  // the processor may have restarted on a new port: read the bridge again next time
    throw offline('Woodshed’s processor isn’t answering on this computer.', error);
  }
  if (!response.ok) {
    if (response.status === 401) token = '';
    throw answerError(response.status, result);
  }
  if (result === undefined) throw new CompanionError({ message: 'The local processor sent an unreadable answer.', status: response.status });
  return result;
}

/**
 * One request to the companion. JSON in and out; a Blob body is sent as-is.
 * `signal` and `timeoutMs` (default 30 s) both abort it.
 * @param {string} path  e.g. '/status', '/search?q=…'
 * @param {{method?: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number}} [options]
 */
export async function request(path, { method, body, signal, timeoutMs } = {}) {
  if (signal?.aborted) throw abortedError(signal);
  await endpoint();
  return send(path, { method, body, signal, timeoutMs });
}

/** GET /status → {name, connected, deviceId, userId, busy, …}. Needs no pairing. */
export function status({ signal } = {}) {
  return request('/status', { method: 'GET', signal, timeoutMs: STATUS_TIMEOUT_MS });
}

// ---------------------------------------------------------------- B4 lookups

const text = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const urlOf = (v, protocols) => {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try { return protocols.includes(new URL(v).protocol) ? v : null; } catch { return null; }
};
const thumbnailOf = v => (typeof v === 'string' && /^data:image\//.test(v) ? v : urlOf(v, ['https:']));

/** A companion candidate, checked field by field; null when it cannot be offered. */
export function normalizeCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = urlOf(raw.url, ['https:', 'http:']);
  const id = text(raw.id, 200);
  const title = text(raw.title);
  if (!url || !id || !title) return null;
  return {
    url, id, title,
    channel: text(raw.channel),
    duration: typeof raw.duration === 'number' && Number.isFinite(raw.duration) && raw.duration > 0 ? raw.duration : null,
    thumbnail: thumbnailOf(raw.thumbnail),
    provider: PROVIDERS.has(raw.provider) ? raw.provider : 'other',
    live: raw.live === true,
  };
}

const candidatesOf = list => (Array.isArray(list) ? list.map(normalizeCandidate).filter(Boolean) : null);
const malformed = () => new CompanionError({ message: 'The local processor sent an unexpected lookup answer.' });

/** Parse a /resolve answer → {kind: 'url'|'spotify', query?, candidates}. */
export function parseResolveResult(body) {
  const candidates = candidatesOf(body?.candidates);
  if (!candidates || (body.kind !== 'url' && body.kind !== 'spotify')) throw malformed();
  const query = text(body.query, 200);
  return { kind: body.kind, ...(query ? { query } : {}), candidates };
}

/** Parse a /search answer → {query, provider: 'youtube'|'soundcloud', candidates}. */
export function parseSearchResult(body) {
  const candidates = candidatesOf(body?.candidates);
  if (!candidates || (body.provider !== 'youtube' && body.provider !== 'soundcloud')) throw malformed();
  return { query: text(body.query, 200), provider: body.provider, candidates };
}

/** B4: what a pasted link points at (one candidate; Spotify → search candidates). A playlist rejects with code 'playlist'. */
export async function resolveSource(url, { signal } = {}) {
  return parseResolveResult(await request(`/resolve?url=${encodeURIComponent(url)}`, { method: 'GET', signal }));
}

/** B4: up to n candidates for a typed query (YouTube, else SoundCloud on a bot check). */
export async function searchSources(q, { n = 5, signal } = {}) {
  return parseSearchResult(await request(`/search?q=${encodeURIComponent(q)}&n=${encodeURIComponent(n)}`, { method: 'GET', signal }));
}

// ---------------------------------------------------------------- uploads

/**
 * Upload a file to the companion with real progress (XHR POST /upload).
 * `onProgress({loaded, total})` fires on every upload progress event and once at the end.
 * @param {File|Blob} file
 * @param {{signal?: AbortSignal, onProgress?: (p: {loaded: number, total: number}) => void, timeoutMs?: number}} [options]
 * @returns {Promise<{id: string}>}
 */
export async function uploadXHR(file, { signal, onProgress, timeoutMs = UPLOAD_TIMEOUT_MS } = {}) {
  if (signal?.aborted) throw abortedError(signal);
  await endpoint();
  if (signal?.aborted) throw abortedError(signal);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const total = file?.size ?? 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => { finish(reject, abortedError(signal)); xhr.abort(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.open('POST', `${origin}/upload`);
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file?.name ?? 'upload'));
    xhr.upload.addEventListener('progress', event => {
      if (!settled) onProgress?.({ loaded: event.loaded, total: event.lengthComputable && event.total ? event.total : total });
    });
    xhr.addEventListener('load', () => {
      let body;
      try { body = JSON.parse(xhr.responseText); } catch { body = undefined; }
      if (xhr.status < 200 || xhr.status >= 300) {
        if (xhr.status === 401) token = '';
        finish(reject, answerError(xhr.status, body));
        return;
      }
      if (!body || typeof body.id !== 'string' || !body.id) {
        finish(reject, new CompanionError({ message: 'The local processor sent an unexpected upload answer.', status: xhr.status }));
        return;
      }
      if (!settled) onProgress?.({ loaded: total, total });
      finish(resolve, { id: body.id });
    });
    xhr.addEventListener('error', () => {
      if (!settled) token = '';
      finish(reject, offline('The upload to Woodshed’s processor was interrupted.'));
    });
    xhr.addEventListener('timeout', () => finish(reject, timeoutError(null)));
    xhr.addEventListener('abort', () => finish(reject, abortedError(signal)));
    xhr.send(file);
  });
}

// ---------------------------------------------------------------- pairing and paired-only routes

/**
 * Pair this computer's processor with the signed-in account (devices.pair),
 * then connect it to the deployment. Concurrent calls share one attempt; a
 * later call (Try again, or after a processor restart) re-reads {port, token}.
 */
export async function initializeLocalDesktop() {
  if (initialization) return initialization;
  initialization = (async () => {
    ready = false;
    if (!bridge()) throw noDesktop();
    token = '';
    const info = await endpoint();
    const local = await send('/status', { method: 'GET', timeoutMs: STATUS_TIMEOUT_MS });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    await convex.mutation(api.devices.pair, { tokenHash, name: local.name });
    await send('/connect', { method: 'POST', body: { convexUrl: import.meta.env.VITE_CONVEX_URL } });
    ready = true;
    return info;
  })();
  try { return await initialization; }
  finally { initialization = null; }
}

async function paired() {
  if (!bridge()) throw noDesktop();
  if (initialization) await initialization.catch(() => {});
  if (!ready) throw notPaired();
}

/** A route that needs a paired processor (/export-originals, /legacy, /import). */
export async function localRequest(route, body, method = 'POST') {
  await paired();
  return request(route, method === 'GET' ? { method } : { method, body: body ?? {} });
}

/** /status of the paired processor. */
export async function desktopStatus() {
  await paired();
  return status();
}

/** The paired device id, or a processor_offline error. The backend checks the account owns it for every job. */
export async function requireCompanion() {
  const info = await desktopStatus();
  if (!info.connected || !info.deviceId) throw notPaired();
  return info.deviceId;
}

export async function localUpload(file, options) {
  await paired();
  return uploadXHR(file, options);
}
export const legacyLibraries = () => localRequest('/legacy', null, 'GET');
export const importLegacy = directory => localRequest('/import', { directory });
