// @vitest-environment node
// src/js/companion.js: the renderer's client for the local processor
// (architecture §6.10 CPA): bridge-only credentials, pairing, abort and timeout,
// coded errors, B4 resolve/search parsing and XHR upload progress.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const { mutation } = vi.hoisted(() => ({ mutation: vi.fn() }));
vi.mock('../src/js/auth.js', () => ({ convex: { mutation } }));

const token = 'a'.repeat(64);
const PORT = 12345;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const STATUS = { name: 'Studio MacBook', connected: true, deviceId: 'device', userId: 'user', busy: false };
const candidate = (over = {}) => ({ url: 'https://www.youtube.com/watch?v=hL7aQ2mR9sE', id: 'hL7aQ2mR9sE', title: 'Harbor Lights (Official Audio)',
  channel: 'Ada Moreno', duration: 221, thumbnail: 'https://i.ytimg.com/vi/hL7aQ2mR9sE/hqdefault.jpg', provider: 'youtube', live: false, ...over });

/** Routes fetch by path: `routes[path]` is a Response factory `(url, init) → Response | Promise`. */
function serve(routes) {
  const fetch = vi.fn(async (url, init = {}) => {
    const parsed = new URL(url);
    const route = routes[parsed.pathname];
    if (!route) return json(404, { error: 'Unknown endpoint.' });
    return route(parsed, init);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const defaultRoutes = () => ({ '/status': () => json(200, STATUS), '/connect': () => json(200, { deviceId: 'device', userId: 'user' }) });

function desktop(over = {}) {
  const bridge = { info: vi.fn(async () => ({ companion: { port: PORT, token }, update: { state: 'idle' } })), ...over };
  globalThis.window.woodshedDesktop = bridge;
  return bridge;
}

const load = () => import('../src/js/companion.js');
const codeOf = async promise => promise.then(() => 'resolved', error => error.code);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('VITE_CONVEX_URL', 'https://happy-otter-123.convex.cloud');
  vi.stubGlobal('window', {});
  // The client never touches web storage (credentials come only from the bridge).
  const forbidden = { get() { throw new Error('web storage touched'); } };
  vi.stubGlobal('sessionStorage', new Proxy({}, forbidden));
  vi.stubGlobal('localStorage', new Proxy({}, forbidden));
  serve(defaultRoutes());
  mutation.mockResolvedValue('device');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('module hygiene', () => {
  test('no desktop-setup gate, no ws.companion cleanup, no stale Settings copy', () => {
    const source = readFileSync(new URL('../src/js/companion.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/desktop\.js|showDesktopSetup/);
    expect(source).not.toMatch(/ws\.companion|sessionStorage|localStorage/);
    expect(source).not.toMatch(/Retry the desktop connection/);
  });
});

describe('in a browser (no desktop bridge)', () => {
  test('every call rejects processor_offline without touching the network', async () => {
    const local = await load();
    expect(local.isDesktopApp()).toBe(false);
    for (const call of [
      () => local.request('/status'), () => local.status(), () => local.resolveSource('https://youtu.be/x'), () => local.searchSources('harbor'),
      () => local.uploadXHR(new Blob(['x'])), () => local.localRequest('/export-originals', {}), () => local.requireCompanion(),
      () => local.importLegacy('/old'), () => local.initializeLocalDesktop(),
    ]) {
      const error = await call().catch(e => e);
      expect(error).toBeInstanceOf(local.CompanionError);
      expect(error.code).toBe('processor_offline');
      expect(error.message).toMatch('Open Woodshed for desktop');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('pairing', () => {
  test('registers the device with the signed-in account, then connects it', async () => {
    desktop();
    const local = await load();
    const info = await local.initializeLocalDesktop();
    expect(info.update).toEqual({ state: 'idle' });
    expect(mutation).toHaveBeenCalledWith(expect.anything(), { tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/), name: 'Studio MacBook' });
    const [hashArg] = mutation.mock.calls[0].slice(1);
    const expected = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('');
    expect(hashArg.tokenHash).toBe(expected);
    const connect = fetch.mock.calls.find(([url]) => url.endsWith('/connect'));
    expect(connect[0]).toBe(`${ORIGIN}/connect`);
    expect(JSON.parse(connect[1].body)).toEqual({ convexUrl: 'https://happy-otter-123.convex.cloud' });
    expect(connect[1].headers).toMatchObject({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
    await expect(local.requireCompanion()).resolves.toBe('device');
    expect(fetch).toHaveBeenCalledWith(`${ORIGIN}/status`, expect.objectContaining({ method: 'GET', headers: { authorization: `Bearer ${token}` } }));
  });

  test('a failed registration blocks paired routes', async () => {
    desktop();
    mutation.mockRejectedValue(new Error('This device belongs to another account'));
    const local = await load();
    await expect(local.initializeLocalDesktop()).rejects.toThrow('another account');
    for (const call of [() => local.localRequest('/export-originals', {}), () => local.importLegacy('/old'), () => local.legacyLibraries(), () => local.localUpload(new Blob(['x']))]) {
      const error = await call().catch(e => e);
      expect(error.code).toBe('processor_offline');
      expect(error.message).toMatch('isn’t connected to your account');
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('requireCompanion rejects when the processor reports it is not connected', async () => {
    desktop();
    serve({ ...defaultRoutes(), '/status': () => json(200, { ...STATUS, connected: false, deviceId: null }) });
    const local = await load();
    await local.initializeLocalDesktop();
    expect(await codeOf(local.requireCompanion())).toBe('processor_offline');
  });

  test('paired routes send JSON with the bearer token', async () => {
    desktop();
    serve({ ...defaultRoutes(), '/import': (_, init) => json(200, { count: 2, skipped: 0, remaining: 0, echo: JSON.parse(init.body) }), '/legacy': () => json(200, []) });
    const local = await load();
    await local.initializeLocalDesktop();
    await expect(local.importLegacy('/old')).resolves.toMatchObject({ count: 2, echo: { directory: '/old' } });
    await expect(local.legacyLibraries()).resolves.toEqual([]);
    const legacy = fetch.mock.calls.find(([url]) => url.endsWith('/legacy'));
    expect(legacy[1]).toMatchObject({ method: 'GET', body: undefined });
  });

  test('waits for the processor to start when info() has no companion yet', async () => {
    let emit;
    const bridge = desktop({
      info: vi.fn().mockResolvedValueOnce({ companion: null, processor: { phase: 'starting' } }).mockResolvedValue({ companion: { port: PORT, token }, processor: { phase: 'ready' } }),
      onProcessorState: vi.fn(cb => { emit = cb; return vi.fn(); }),
    });
    const local = await load();
    const pending = local.initializeLocalDesktop();
    await vi.waitFor(() => expect(bridge.info).toHaveBeenCalledTimes(1));
    expect(fetch).not.toHaveBeenCalled();
    emit({ phase: 'ready' });
    await expect(pending).resolves.toMatchObject({ companion: { port: PORT } });
    expect(bridge.info).toHaveBeenCalledTimes(2);
    expect(bridge.onProcessorState.mock.results[0].value).toHaveBeenCalled();
  });

  test('a processor that stops while starting fails the pairing', async () => {
    let emit;
    desktop({ info: vi.fn(async () => ({ companion: null, processor: { phase: 'starting' } })), onProcessorState: cb => { emit = cb; return () => {}; } });
    const local = await load();
    const pending = local.initializeLocalDesktop();
    await vi.waitFor(() => expect(emit).toBeTypeOf('function'));
    emit({ phase: 'stopped', message: 'The local processor stopped.' });
    const error = await pending.catch(e => e);
    expect([error.code, error.message]).toEqual(['processor_offline', 'The local processor stopped.']);
  });

  // While the processor starts (up to 2 min), each caller's own signal and timeout still bound its wait.
  function startingDesktop() {
    const listeners = [];
    const state = { started: false };
    const bridge = desktop({
      info: vi.fn(async () => (state.started ? { companion: { port: PORT, token }, processor: { phase: 'ready' } } : { companion: null, processor: { phase: 'starting' } })),
      onProcessorState: vi.fn(cb => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1); }),
    });
    const ready = () => { state.started = true; for (const cb of [...listeners]) cb({ phase: 'ready' }); };
    return { bridge, ready, listeners };
  }

  test('an abort while the processor is starting rejects at once; the start wait carries on', async () => {
    const { ready, listeners } = startingDesktop();
    serve({ ...defaultRoutes(), '/search': () => json(200, { query: 'harbor', provider: 'youtube', candidates: [candidate()] }) });
    const local = await load();
    const controller = new AbortController();
    const pending = local.searchSources('harbor', { signal: controller.signal });
    const other = local.status();
    await vi.waitFor(() => expect(listeners).toHaveLength(1));
    controller.abort();
    const error = await pending.catch(e => e);
    expect([error.code, error.name]).toEqual(['aborted', 'AbortError']);
    expect(fetch).not.toHaveBeenCalled();
    ready();
    await expect(other).resolves.toEqual(STATUS);
    await expect(local.searchSources('harbor')).resolves.toMatchObject({ provider: 'youtube' });
  });

  test('timeoutMs bounds the wait for a starting processor', async () => {
    startingDesktop();
    const local = await load();
    const started = Date.now();
    const error = await local.request('/status', { timeoutMs: 50 }).catch(e => e);
    expect(error.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('uploadXHR: an abort while the processor is starting rejects without opening an XHR', async () => {
    startingDesktop();
    const opened = vi.fn();
    vi.stubGlobal('XMLHttpRequest', class { constructor() { opened(); } });
    const local = await load();
    const controller = new AbortController();
    const pending = local.uploadXHR(new Blob(['x']), { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    expect(await codeOf(pending)).toBe('aborted');
    expect(await codeOf(local.uploadXHR(new Blob(['x']), { timeoutMs: 30 }))).toBe('timeout');
    expect(opened).not.toHaveBeenCalled();
  });

  test('no companion and not starting is processor_offline', async () => {
    desktop({ info: async () => ({ companion: null, processor: { phase: 'stopped' } }) });
    const local = await load();
    expect(await codeOf(local.initializeLocalDesktop())).toBe('processor_offline');
    expect(await codeOf(local.status())).toBe('processor_offline');
  });
});

describe('request', () => {
  test('lookups and status need no pairing: the endpoint comes from the bridge', async () => {
    const bridge = desktop();
    const local = await load();
    await expect(local.status()).resolves.toEqual(STATUS);
    await local.status();
    expect(bridge.info).toHaveBeenCalledTimes(1);
    expect(mutation).not.toHaveBeenCalled();
  });

  test('an external abort rejects with code aborted (AbortError)', async () => {
    desktop();
    serve({ '/search': (_, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) });
    const local = await load();
    const controller = new AbortController();
    const pending = local.searchSources('harbor', { signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    const error = await pending.catch(e => e);
    expect([error.code, error.name]).toEqual(['aborted', 'AbortError']);
    expect(await codeOf(local.searchSources('harbor', { signal: AbortSignal.abort() }))).toBe('aborted');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('no answer within timeoutMs rejects with code timeout', async () => {
    desktop();
    serve({ '/slow': (_, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) });
    const local = await load();
    const error = await local.request('/slow', { timeoutMs: 20 }).catch(e => e);
    expect(error.code).toBe('timeout');
    expect(error.name).toBe('CompanionError');
  });

  test('the default timeout is 30 s, combined with the caller signal', async () => {
    desktop();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const any = vi.spyOn(AbortSignal, 'any');
    const local = await load();
    const signal = new AbortController().signal;
    await local.request('/status', { signal });
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(any.mock.calls[0][0][0]).toBe(signal);
    expect(fetch.mock.calls[0][1].signal).toBe(any.mock.results[0].value);
  });

  test('a refused connection is processor_offline, and the next call re-reads the bridge', async () => {
    const bridge = desktop();
    const local = await load();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const error = await local.status().catch(e => e);
    expect([error.code, error.raw?.message]).toEqual(['processor_offline', 'Failed to fetch']);
    serve(defaultRoutes());
    await expect(local.status()).resolves.toEqual(STATUS);
    expect(bridge.info).toHaveBeenCalledTimes(2);
  });

  test('companion errors keep their code, status and message', async () => {
    desktop();
    serve({
      '/bot': () => json(503, { error: 'YouTube asked for a sign-in check.', code: 'bot_check', detail: 'ERROR: …' }),
      '/gateway': () => json(504, { error: 'The lookup took too long.' }),
      '/plain': () => json(400, { error: 'Pair the companion in Settings first.' }),
      '/html': () => new Response('<h1>oops</h1>', { status: 500 }),
      '/auth': () => json(401, { error: 'Invalid local processor credential.' }),
      '/garbled': () => new Response('not json', { status: 200 }),
    });
    const local = await load();
    const bot = await local.request('/bot').catch(e => e);
    expect(bot).toMatchObject({ code: 'bot_check', status: 503, message: 'YouTube asked for a sign-in check.', data: { detail: 'ERROR: …' } });
    expect(await local.request('/gateway').catch(e => e)).toMatchObject({ code: 'timeout', status: 504 });
    expect(await local.request('/plain').catch(e => e)).toMatchObject({ code: 'unknown', status: 400, message: 'Pair the companion in Settings first.' });
    expect(await local.request('/html').catch(e => e)).toMatchObject({ code: 'unknown', status: 500, message: 'The local processor request failed (500).' });
    expect(await local.request('/auth').catch(e => e)).toMatchObject({ code: 'processor_offline', status: 401 });
    expect(await local.request('/garbled').catch(e => e)).toMatchObject({ code: 'unknown', message: 'The local processor sent an unreadable answer.' });
  });

  test('a Blob body is sent as octet-stream, an object as JSON', async () => {
    desktop();
    serve({ '/echo': (_, init) => json(200, { ok: true, type: init.headers['content-type'] }) });
    const local = await load();
    const blob = new Blob(['abc']);
    await expect(local.request('/echo', { body: blob })).resolves.toEqual({ ok: true, type: 'application/octet-stream' });
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: blob });
    await expect(local.request('/echo', { method: 'POST', body: { a: 1 } })).resolves.toEqual({ ok: true, type: 'application/json' });
    expect(fetch.mock.calls[1][1].body).toBe('{"a":1}');
  });
});

describe('B4 lookups', () => {
  test('resolveSource encodes the URL and parses candidates', async () => {
    desktop();
    serve({ '/resolve': () => json(200, { kind: 'url', candidates: [candidate()] }) });
    const local = await load();
    const url = 'https://www.youtube.com/watch?v=hL7aQ2mR9sE&t=10';
    await expect(local.resolveSource(url)).resolves.toEqual({ kind: 'url', candidates: [candidate()] });
    expect(fetch.mock.calls[0][0]).toBe(`${ORIGIN}/resolve?url=${encodeURIComponent(url)}`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { authorization: `Bearer ${token}` } });
  });

  test('a Spotify resolve keeps its query; a playlist rejects with code playlist', async () => {
    desktop();
    serve({ '/resolve': url => url.searchParams.get('url').includes('playlist')
      ? json(422, { error: 'This is a playlist link. Paste a link to one song.', code: 'playlist' })
      : json(200, { kind: 'spotify', query: 'Harbor Lights', candidates: [candidate(), candidate({ id: 'Zp3kW8vYt0c', url: 'https://www.youtube.com/watch?v=Zp3kW8vYt0c' })] }) });
    const local = await load();
    const spotify = await local.resolveSource('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
    expect([spotify.kind, spotify.query, spotify.candidates.length]).toEqual(['spotify', 'Harbor Lights', 2]);
    const error = await local.resolveSource('https://open.spotify.com/playlist/37i9').catch(e => e);
    expect([error.code, error.status, error.message]).toEqual(['playlist', 422, 'This is a playlist link. Paste a link to one song.']);
  });

  test('searchSources sends q and n (default 5)', async () => {
    desktop();
    serve({ '/search': url => json(200, { query: url.searchParams.get('q'), provider: 'soundcloud', candidates: [candidate({ provider: 'soundcloud', thumbnail: null })] }) });
    const local = await load();
    const result = await local.searchSources('harbor & lights', { n: 3 });
    expect(result).toEqual({ query: 'harbor & lights', provider: 'soundcloud', candidates: [candidate({ provider: 'soundcloud', thumbnail: null })] });
    expect(fetch.mock.calls[0][0]).toBe(`${ORIGIN}/search?q=harbor%20%26%20lights&n=3`);
    await local.searchSources('harbor');
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get('n')).toBe('5');
  });

  test('candidates are checked field by field', async () => {
    const local = await load();
    expect(local.normalizeCandidate(candidate({ provider: 'vimeo', live: 'yes', duration: -1, channel: undefined, thumbnail: 'http://i.ytimg.com/x.jpg' })))
      .toEqual(candidate({ provider: 'other', live: false, duration: null, channel: '', thumbnail: null }));
    expect(local.normalizeCandidate(candidate({ thumbnail: 'data:image/svg+xml,%3Csvg%3E' })).thumbnail).toBe('data:image/svg+xml,%3Csvg%3E');
    expect(local.normalizeCandidate(candidate({ live: true, duration: null })).live).toBe(true);
    for (const bad of [candidate({ url: 'javascript:alert(1)' }), candidate({ title: '  ' }), candidate({ id: '' }), null, 'x'])
      expect(local.normalizeCandidate(bad)).toBeNull();
    const parsed = local.parseSearchResult({ query: 'q', provider: 'youtube', candidates: [candidate(), { title: 'broken' }] });
    expect(parsed.candidates).toHaveLength(1);
  });

  test('a malformed answer is an unknown error', async () => {
    const local = await load();
    for (const body of [null, {}, { kind: 'playlist', candidates: [] }, { kind: 'url', candidates: 'x' }])
      expect(() => local.parseResolveResult(body)).toThrow(expect.objectContaining({ code: 'unknown' }));
    for (const body of [null, { query: 'q', provider: 'bandcamp', candidates: [] }, { query: 'q', provider: 'youtube' }])
      expect(() => local.parseSearchResult(body)).toThrow(expect.objectContaining({ code: 'unknown' }));
    expect(local.parseResolveResult({ kind: 'url', candidates: [] })).toEqual({ kind: 'url', candidates: [] });
  });
});

describe('uploadXHR', () => {
  /** A scriptable XMLHttpRequest: each instance is pushed to `instances`; tests drive its events. */
  function fakeXHR() {
    const instances = [];
    class FakeXHR extends EventTarget {
      constructor() {
        super();
        this.upload = new EventTarget();
        this.headers = {};
        this.status = 0;
        this.responseText = '';
        this.timeout = 0;
        this.abort = vi.fn(() => this.dispatchEvent(new Event('abort')));
        instances.push(this);
      }
      open(method, url) { this.method = method; this.url = url; }
      setRequestHeader(name, value) { this.headers[name] = value; }
      send(body) { this.body = body; }
      progress(loaded, total) { const e = new Event('progress'); Object.assign(e, { loaded, total, lengthComputable: true }); this.upload.dispatchEvent(e); }
      respond(status, body) { this.status = status; this.responseText = typeof body === 'string' ? body : JSON.stringify(body); this.dispatchEvent(new Event('load')); }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    return instances;
  }
  const file = () => new File([new Uint8Array(1000)], 'Harbor Lights (demo) #2.wav', { type: 'audio/wav' });

  test('POSTs the file with the bearer token and an encoded filename, reporting progress', async () => {
    desktop();
    const xhrs = fakeXHR();
    const local = await load();
    const progress = [];
    const f = file();
    const pending = local.uploadXHR(f, { onProgress: p => progress.push(p) });
    await vi.waitFor(() => expect(xhrs[0]?.body).toBe(f));
    const xhr = xhrs[0];
    expect([xhr.method, xhr.url]).toEqual(['POST', `${ORIGIN}/upload`]);
    expect(xhr.headers).toEqual({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent('Harbor Lights (demo) #2.wav') });
    expect(xhr.timeout).toBeLessThanOrEqual(600_000);
    expect(xhr.timeout).toBeGreaterThan(599_000);
    xhr.progress(250, 1000);
    xhr.progress(1000, 1000);
    xhr.respond(200, { id: 'b1f0c5a2-6d3e-4f3a-9a7b-2c1d0e9f8a7b' });
    await expect(pending).resolves.toEqual({ id: 'b1f0c5a2-6d3e-4f3a-9a7b-2c1d0e9f8a7b' });
    expect(progress).toEqual([{ loaded: 250, total: 1000 }, { loaded: 1000, total: 1000 }, { loaded: 1000, total: 1000 }]);
  });

  test('a coded companion error, a dropped connection and a timeout', async () => {
    desktop();
    const xhrs = fakeXHR();
    const local = await load();
    const rejected = local.uploadXHR(file());
    await vi.waitFor(() => expect(xhrs).toHaveLength(1));
    xhrs[0].respond(400, { error: 'File too large.' });
    expect(await rejected.catch(e => e)).toMatchObject({ code: 'unknown', status: 400, message: 'File too large.' });

    const dropped = local.uploadXHR(file());
    await vi.waitFor(() => expect(xhrs).toHaveLength(2));
    xhrs[1].progress(400, 1000);
    xhrs[1].dispatchEvent(new Event('error'));
    expect(await codeOf(dropped)).toBe('processor_offline');

    const slow = local.uploadXHR(file(), { timeoutMs: 5000 });
    await vi.waitFor(() => expect(xhrs).toHaveLength(3));
    expect(xhrs[2].timeout).toBeLessThanOrEqual(5000);
    expect(xhrs[2].timeout).toBeGreaterThan(4000);
    xhrs[2].dispatchEvent(new Event('timeout'));
    expect(await codeOf(slow)).toBe('timeout');

    const odd = local.uploadXHR(file());
    await vi.waitFor(() => expect(xhrs).toHaveLength(4));
    xhrs[3].respond(200, 'ok');
    expect(await codeOf(odd)).toBe('unknown');
  });

  test('aborting the signal aborts the XHR and rejects AbortError', async () => {
    desktop();
    const xhrs = fakeXHR();
    const local = await load();
    const controller = new AbortController();
    const progress = vi.fn();
    const pending = local.uploadXHR(file(), { signal: controller.signal, onProgress: progress });
    await vi.waitFor(() => expect(xhrs).toHaveLength(1));
    controller.abort();
    const error = await pending.catch(e => e);
    expect([error.code, error.name]).toEqual(['aborted', 'AbortError']);
    expect(xhrs[0].abort).toHaveBeenCalled();
    xhrs[0].progress(10, 1000);
    expect(progress).not.toHaveBeenCalled();
    expect(await codeOf(local.uploadXHR(file(), { signal: AbortSignal.abort() }))).toBe('aborted');
    expect(xhrs).toHaveLength(1);
  });

  test('localUpload needs a paired processor, then uploads through XHR', async () => {
    desktop();
    const xhrs = fakeXHR();
    const local = await load();
    expect(await codeOf(local.localUpload(file()))).toBe('processor_offline');
    await local.initializeLocalDesktop();
    const pending = local.localUpload(file());
    await vi.waitFor(() => expect(xhrs).toHaveLength(1));
    xhrs[0].respond(200, { id: 'up-1' });
    await expect(pending).resolves.toEqual({ id: 'up-1' });
  });
});
