// The local processor (companion/server.mjs) as the renderer sees it at
// http://127.0.0.1:47831 (architecture §6.10, §11.2). fetch and XMLHttpRequest
// calls to that origin are answered here; everything else goes to the network.
// Every route checks the bearer token like the real server.
//   GET  /status             {name, connected, deviceId, userId, busy, accepting, job, modelsReady, version}
//   POST /connect            the device identity
//   POST /upload             XHR with upload progress events (fetch works too, without progress)
//   GET  /resolve?url=…      {kind: 'url'|'spotify', query?, candidates}  (playlist → 422)
//   GET  /search?q=…&n=5     {query, provider, candidates}
//   GET  /legacy · POST /import · POST /export-originals
// Switches:
//   fx-companion=offline   connected: false (not paired)
//   fx-companion=busy      busy with job-run (Splitting · 46%)
//   fx-companion=firstrun  no separation model downloaded yet (modelsReady all false)
//   fx-companion=down      the processor is not running: every request fails like a refused connection
//   fx-lookup=slow|fail    lookups take 2.5 s | every lookup fails with bot_check (503)
//   fx-upload=slow|fail    uploads take 10 s | the connection drops half way (an XHR network error)
//   fx-legacy=1            /legacy finds an old library
// Lookup inputs also steer the answer: a search containing "zzz" finds nothing, "botcheck"
// → 503 bot_check, "timeout" → 504, "soundcloud" → provider soundcloud; a URL with "list=" or
// "/playlist" → 422 playlist, "unavailable" → 404, anything that is not http(s) or spotify → 400.
// Controls (window.fixture.companion): calls() [{method, path, query}], uploads() [{filename, size, auth}].
export const ORIGIN = 'http://127.0.0.1:47831';
export const PORT = 47831;
export const TOKEN = 'f'.repeat(64);

const MODELS = ['htdemucs', 'htdemucs_ft', 'htdemucs_6s', 'mdx_extra'];

function videoId(seed) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `fx${h.toString(36).padStart(9, '0').slice(0, 9)}`;
}
const candidate = (title, channel, duration, {provider = 'youtube', live = false} = {}) => {
  const id = videoId(`${title}|${channel}`);
  return {url: provider === 'soundcloud' ? `https://soundcloud.com/${channel.toLowerCase().replace(/\W+/g, '-')}/${id}` : `https://www.youtube.com/watch?v=${id}`,
    id, title, channel, duration, thumbnail: provider === 'youtube' ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null, provider, live};
};

/** The search results for `q` (≤ n), shaped like companion/lookup.mjs. */
export function searchResults(q, n = 5, provider = 'youtube') {
  const words = q.trim().replace(/\s+/g, ' ');
  const title = words.replace(/\b\w/g, c => c.toUpperCase());
  const list = [
    candidate(`${title} (Official Audio)`, 'Northbound', 214, {provider}),
    candidate(`${title} (Live at the Grange)`, 'Northbound', 251, {provider, live: false}),
    candidate(`${title} — drum cover`, 'Stickwork Weekly', 220, {provider}),
    candidate(`${title} (Lyrics)`, 'Lyric Vault', 213, {provider}),
    candidate(`${title} [live stream]`, 'Northbound', null, {provider, live: true}),
  ];
  return list.slice(0, Math.max(1, Math.min(5, n)));
}

export function createCompanion(win, fx = {}) {
  const calls = [], uploads = [];
  let uploadIds = 0;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const lookupDelay = () => delay(fx.lookup === 'slow' ? 2500 : 300);

  function status() {
    const connected = fx.companion !== 'offline';
    const busy = fx.companion === 'busy';
    return {name: 'Studio MacBook', connected, deviceId: connected ? 'dev1' : null, userId: connected ? 'user1' : null, busy, accepting: true,
      job: busy ? {id: 'job-run', stage: 'separate', percent: 46} : null,
      modelsReady: Object.fromEntries(MODELS.map(m => [m, fx.companion !== 'firstrun'])), version: '2.0.0'};
  }
  const fail = (status, code, error) => ({status, body: {error, code}});

  async function resolve(url) {
    await lookupDelay();
    if (fx.lookup === 'fail') return fail(503, 'bot_check', 'YouTube asked for a sign-in check.');
    if (!url || url.length > 2000 || !/^(https?:|spotify:)/i.test(url)) return fail(400, 'invalid', 'Paste a link to one song.');
    if (/[?&]list=|\/playlist/i.test(url)) return fail(422, 'playlist', 'This is a playlist link. Paste a link to one song.');
    if (/unavailable/i.test(url)) return fail(404, 'unavailable', 'This video is unavailable.');
    if (/^spotify:|open\.spotify\.com/i.test(url)) {
      const query = 'Glasshouse Northbound';
      return {status: 200, body: {kind: 'spotify', query, candidates: searchResults(query)}};
    }
    const id = /[?&]v=([\w-]{6,})/.exec(url)?.[1] ?? videoId(url);
    return {status: 200, body: {kind: 'url', candidates: [{url, id, title: 'Glasshouse (Official Audio)', channel: 'Northbound', duration: 128, thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, provider: /soundcloud/i.test(url) ? 'soundcloud' : /youtu/i.test(url) ? 'youtube' : 'other', live: false}]}};
  }

  async function search(q, n) {
    await lookupDelay();
    if (fx.lookup === 'fail' || /botcheck/i.test(q)) return fail(503, 'bot_check', 'YouTube and SoundCloud are both asking for a sign-in check.');
    if (!q || q.length > 200 || !(n >= 1 && n <= 5)) return fail(400, 'invalid', 'Type 1–200 characters.');
    if (/timeout/i.test(q)) return fail(504, 'timeout', 'The search took too long.');
    const provider = /soundcloud/i.test(q) ? 'soundcloud' : 'youtube';
    return {status: 200, body: {query: q, provider, candidates: /zzz/i.test(q) ? [] : searchResults(q, n, provider)}};
  }

  /** Answer one request: {status, body} (body JSON-serialisable). Throws a TypeError when the processor is down. */
  async function handle({method = 'GET', url, headers = {}}) {
    const parsed = new URL(url);
    const path = parsed.pathname;
    calls.push({method, path, query: Object.fromEntries(parsed.searchParams)});
    if (fx.companion === 'down') { await delay(20); throw new TypeError('Failed to fetch'); }
    const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
    if (auth !== `Bearer ${TOKEN}`) return fail(401, 'invalid', 'Unauthorized');
    if (path === '/status' && method === 'GET') { await delay(30); return {status: 200, body: status()}; }
    if (path === '/connect' && method === 'POST') { await delay(30); return {status: 200, body: {deviceId: 'dev1', userId: 'user1', name: 'Studio MacBook'}}; }
    if (path === '/upload' && method === 'POST') { await delay(300); return {status: 200, body: {id: `up-${++uploadIds}`}}; }
    if (path === '/resolve' && method === 'GET') return resolve(parsed.searchParams.get('url') ?? '');
    if (path === '/search' && method === 'GET') return search(parsed.searchParams.get('q') ?? '', Number(parsed.searchParams.get('n') ?? 5));
    if (path === '/legacy' && method === 'GET') return {status: 200, body: fx.legacy === '1' ? [{directory: '~/Library/Application Support/woodshed', count: 48}] : []};
    if (path === '/import' && method === 'POST') return {status: 200, body: {count: 20, skipped: 0, remaining: 28}};
    if (path === '/export-originals' && method === 'POST') { await delay(400); return {status: 200, body: {count: 48, directory: '~/Downloads/Woodshed-originals-2026-10-28'}}; }
    return fail(404, 'invalid', 'Not found');
  }

  // ---- fetch ---------------------------------------------------------------------
  const realFetch = win.fetch.bind(win);
  win.fetch = async function fetch(input, init = {}) {
    const url = String(input?.url ?? input);
    if (!url.startsWith(ORIGIN)) return realFetch(input, init);
    const headers = Object.fromEntries(new win.Headers(init.headers ?? input?.headers ?? {}).entries());
    const method = (init.method ?? input?.method ?? 'GET').toUpperCase();
    if (init.signal?.aborted) throw new win.DOMException('The operation was aborted.', 'AbortError');
    if (method === 'POST' && new URL(url).pathname === '/upload') uploads.push({filename: decodeURIComponent(headers['x-filename'] ?? ''), size: init.body?.size ?? init.body?.length ?? 0, auth: !!headers.authorization, via: 'fetch'});
    const answer = handle({method, url, headers});
    const abort = init.signal ? new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new win.DOMException('The operation was aborted.', 'AbortError')), {once: true})) : null;
    const {status, body} = await (abort ? Promise.race([answer, abort]) : answer);
    return new win.Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
  };

  // ---- XMLHttpRequest uploads with progress ---------------------------------------------
  const NativeXHR = win.XMLHttpRequest;
  const fake = new WeakMap();
  class FixtureXMLHttpRequest extends NativeXHR {
    open(method, url, ...rest) {
      const absolute = new URL(String(url), win.location.href).href;
      if (!absolute.startsWith(ORIGIN)) { fake.delete(this); return super.open(method, url, ...rest); }
      const state = {method: String(method).toUpperCase(), url: absolute, headers: {}, readyState: 1, status: 0, responseText: '', aborted: false, timer: null, responseHeaders: {}};
      fake.set(this, state);
      for (const [key, get] of Object.entries({readyState: () => state.readyState, status: () => state.status, statusText: () => (state.status === 200 ? 'OK' : state.status ? 'Error' : ''),
        responseText: () => state.responseText, response: () => (this.responseType === 'json' ? (state.responseText ? JSON.parse(state.responseText) : null) : state.responseText), responseURL: () => (state.readyState === 4 ? state.url : '')}))
        Object.defineProperty(this, key, {configurable: true, get});
      this.dispatchEvent(new win.Event('readystatechange'));
    }
    setRequestHeader(name, value) { const state = fake.get(this); if (!state) return super.setRequestHeader(name, value); state.headers[name.toLowerCase()] = String(value); }
    getResponseHeader(name) { const state = fake.get(this); if (!state) return super.getResponseHeader(name); return state.readyState === 4 ? state.responseHeaders[name.toLowerCase()] ?? null : null; }
    getAllResponseHeaders() { const state = fake.get(this); if (!state) return super.getAllResponseHeaders(); return state.readyState === 4 ? Object.entries(state.responseHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join('') : ''; }
    abort() {
      const state = fake.get(this);
      if (!state) return super.abort();
      if (state.readyState === 4 || state.aborted) return;
      state.aborted = true; clearTimeout(state.timer);
      state.readyState = 4; state.status = 0;
      this.dispatchEvent(new win.Event('readystatechange'));
      this.upload.dispatchEvent(new win.ProgressEvent('abort'));
      this.dispatchEvent(new win.ProgressEvent('abort'));
      this.dispatchEvent(new win.ProgressEvent('loadend'));
      state.readyState = 0;
    }
    send(body = null) {
      const state = fake.get(this);
      if (!state) return super.send(body);
      const total = body?.size ?? body?.byteLength ?? body?.length ?? 0;
      const isUpload = state.method === 'POST' && new URL(state.url).pathname === '/upload';
      if (isUpload) uploads.push({filename: decodeURIComponent(state.headers['x-filename'] ?? ''), size: total, auth: state.headers.authorization === `Bearer ${TOKEN}`, via: 'xhr'});
      const finish = async () => {
        let answer;
        try { answer = await handle({method: state.method, url: state.url, headers: state.headers}); }
        catch { answer = null; }
        if (state.aborted) return;
        state.readyState = 4;
        if (!answer) { state.status = 0; this.dispatchEvent(new win.Event('readystatechange')); this.dispatchEvent(new win.ProgressEvent('error')); this.dispatchEvent(new win.ProgressEvent('loadend')); return; }
        state.status = answer.status; state.responseText = JSON.stringify(answer.body); state.responseHeaders = {'content-type': 'application/json'};
        this.dispatchEvent(new win.Event('readystatechange'));
        this.dispatchEvent(new win.ProgressEvent('load', {lengthComputable: true, loaded: state.responseText.length, total: state.responseText.length}));
        this.dispatchEvent(new win.ProgressEvent('loadend'));
      };
      this.dispatchEvent(new win.ProgressEvent('loadstart'));
      if (!isUpload) { finish(); return; }
      // Upload progress in 10 steps; fx-upload=fail stops half way with a server error.
      const steps = 10, duration = fx.upload === 'slow' ? 10_000 : 1200, failAt = fx.upload === 'fail' ? 5 : Infinity;
      this.upload.dispatchEvent(new win.ProgressEvent('loadstart', {lengthComputable: true, loaded: 0, total}));
      let i = 0;
      const tick = () => {
        if (state.aborted) return;
        i++;
        if (i > failAt) {
          // The connection drops half way: a network error, as when the processor quits.
          state.readyState = 4; state.status = 0;
          this.upload.dispatchEvent(new win.ProgressEvent('error'));
          this.upload.dispatchEvent(new win.ProgressEvent('loadend'));
          this.dispatchEvent(new win.Event('readystatechange'));
          this.dispatchEvent(new win.ProgressEvent('error'));
          this.dispatchEvent(new win.ProgressEvent('loadend'));
          return;
        }
        const loaded = Math.round(total * i / steps);
        this.upload.dispatchEvent(new win.ProgressEvent('progress', {lengthComputable: true, loaded, total}));
        if (i < steps) { state.timer = setTimeout(tick, duration / steps); return; }
        this.upload.dispatchEvent(new win.ProgressEvent('load', {lengthComputable: true, loaded: total, total}));
        this.upload.dispatchEvent(new win.ProgressEvent('loadend', {lengthComputable: true, loaded: total, total}));
        state.readyState = 2; this.dispatchEvent(new win.Event('readystatechange'));
        finish();
      };
      state.timer = setTimeout(tick, duration / steps);
    }
  }
  win.XMLHttpRequest = FixtureXMLHttpRequest;

  return {
    status,
    handle,
    calls: () => structuredClone(calls),
    uploads: () => structuredClone(uploads),
  };
}
