// B4: source lookups for the Add sheet (architecture §6.10 CPA,
// maps/companion-desktop.md §16.1). The companion answers
//   GET /resolve?url=…   → {kind: 'url'|'spotify', query?, candidates}
//   GET /search?q=…&n=5  → {query, provider: 'youtube'|'soundcloud', candidates}
// with yt-dlp in metadata-only mode, so the user can confirm the exact
// recording before anything is downloaded.
//
// Everything here takes its effects as arguments (spawn, fetch, timers, clock),
// so companion/lookup.test.mjs runs it without Python, Convex or the network.
import { spawn as nodeSpawn } from 'node:child_process';
import YTDLP_ARGS from './ytdlp-args.json' with { type: 'json' };

/** @typedef {'youtube'|'soundcloud'|'other'} Provider */
/**
 * @typedef {{url: string, id: string, title: string, channel: string, duration: number|null,
 *   thumbnail: string|null, provider: Provider, live: boolean}} Candidate
 */

export const BASE_ARGS = Object.freeze([...YTDLP_ARGS.base]);
export const LOOKUP_ARGS = Object.freeze([...YTDLP_ARGS.lookup]);
export const TIMEOUT_MS = 20_000;
export const CACHE_SIZE = 50;
export const CACHE_TTL_MS = 10 * 60_000;
export const MAX_URL = 2000;
export const MAX_QUERY = 200;
export const MAX_RESULTS = 5;
/** SoundCloud search returns previews (< 90 s) and full-album rips or mixes (> 12 min); see pipeline.py download_candidates. */
export const SOUNDCLOUD_WINDOW = Object.freeze({ min: 90, max: 720 });

/** HTTP status per lookup error code (§6.10). `aborted` never reaches a client: its connection is gone. */
export const STATUS = Object.freeze({
  invalid: 400,
  unavailable: 404,
  not_found: 404,
  lookup_busy: 409,
  playlist: 422,
  aborted: 499,
  lookup_unavailable: 502,
  bot_check: 503,
  timeout: 504,
});

export class LookupError extends Error {
  /**
   * @param {keyof typeof STATUS} code
   * @param {string} message
   * @param {{detail?: string}} [extra]
   */
  constructor(code, message, { detail } = {}) {
    super(message);
    this.name = 'LookupError';
    this.code = code;
    this.status = STATUS[code] ?? 502;
    if (detail) this.detail = detail;
  }
}

// ---------------------------------------------------------------- yt-dlp failures

// YouTube's automated-traffic refusal (pipeline.py BOT_CHECK). "Sign in to
// confirm your age" is an age gate, not a bot check: retrying elsewhere or
// later will not help, so it counts as unavailable.
export const BOT_CHECK = /not a bot|sign in to confirm(?! your age)/i;
const UNAVAILABLE = /private video|video is private|video unavailable|is not available|available in your (?:country|region)|geo.?restrict|has been removed|members-only|account .* terminated|confirm your age|age.?restricted|premieres in|live event will begin|copyright (?:claim|grounds)/i;
const NO_FORMATS = /requested format is not available|no video formats found/i;
const NOT_FOUND = /unsupported url|http error 404|\b404\b.*not found|not found|does not exist|no such (?:track|video|user)/i;

/** The last `ERROR:` line of a yt-dlp stderr, without its prefixes. */
export function errorLine(stderr) {
  const lines = String(stderr ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const error = [...lines].reverse().find(l => /^ERROR:/i.test(l)) ?? lines.at(-1) ?? '';
  return error.replace(/^ERROR:\s*/i, '').replace(/^\[[^\]]+\]\s*[^:\s]*:\s*/, '').trim();
}

/** Classify a failed yt-dlp run from its stderr: bot_check | unavailable | not_found | lookup_unavailable. */
export function classifyFailure(stderr) {
  const text = String(stderr ?? '');
  if (BOT_CHECK.test(text)) return 'bot_check';
  // Format selection failed (n-challenge / EJS solver failure, SABR-only answers): the
  // video exists, the lookup could not finish. LOOKUP_ARGS has --ignore-no-formats-error,
  // so this only reaches here from an older yt-dlp or a changed args file.
  if (NO_FORMATS.test(text)) return 'lookup_unavailable';
  if (UNAVAILABLE.test(text)) return 'unavailable';
  if (NOT_FOUND.test(text)) return 'not_found';
  return 'lookup_unavailable';
}

const FAILURE_MESSAGE = {
  bot_check: 'YouTube asked for a sign-in check.',
  unavailable: 'This video isn’t available.',
  not_found: 'Nothing playable was found at that link.',
  lookup_unavailable: 'The lookup could not run.',
};

export function failureFrom(stderr, exitCode) {
  const code = classifyFailure(stderr);
  const line = errorLine(stderr);
  const detail = String(stderr ?? '').slice(-2000) || `yt-dlp exited (${exitCode}).`;
  return new LookupError(code, line && code !== 'lookup_unavailable' ? line : FAILURE_MESSAGE[code] + (line ? ` ${line}` : ''), { detail });
}

// ---------------------------------------------------------------- yt-dlp runner

/** The yt-dlp command: frozen builds run `WOODSHED_PROCESSOR --module yt_dlp`, dev runs `python -m yt_dlp`. */
export function ytDlpCommand({ processor, python }) {
  return processor ? { command: processor, prefix: ['--module', 'yt_dlp'] } : { command: python, prefix: ['-m', 'yt_dlp'] };
}

/**
 * Live lookup children. yt-dlp runs in its own process group, so it would outlive the
 * companion: every child still running when the process exits is killed (contract:
 * the child dies with its request).
 */
const live = new Set();
let exitHookInstalled = false;
function track(child, kill) {
  const entry = { child, kill };
  live.add(entry);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', killAllLookupChildren);
  }
  return () => live.delete(entry);
}

/** Kill every running lookup child (also runs on process exit). */
export function killAllLookupChildren() {
  for (const entry of [...live]) {
    live.delete(entry);
    try { entry.kill(entry.child); } catch { /* best effort */ }
  }
}

/** Kill a child and its descendants (yt-dlp starts node for YouTube's JS challenge). */
export function killTree(child, { platform = process.platform, spawn = nodeSpawn } = {}) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
  if (platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return; } catch { /* fall through */ }
  } else if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); return; } catch { /* not a group leader: fall through */ }
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

const abortError = signal =>
  signal?.reason instanceof LookupError ? signal.reason : new LookupError('aborted', 'The lookup was canceled.');

/**
 * `ytDlp(args, {signal}) → Promise<object>`: runs yt-dlp, resolves its JSON stdout,
 * rejects a LookupError classified from stderr. Aborting `signal` kills the child
 * and rejects with the signal's LookupError reason (timeout, lookup_busy) when it has one.
 */
export function createYtDlp({ command, prefix = [], env = process.env, spawn = nodeSpawn, kill = killTree, platform = process.platform, maxOutput = 32 * 1024 * 1024 }) {
  return function ytDlp(args, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError(signal)); return; }
      let child;
      try {
        child = spawn(command, [...prefix, ...args], { env, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        reject(new LookupError('lookup_unavailable', 'The processor could not start a lookup.', { detail: error.message }));
        return;
      }
      const untrack = track(child, kill);
      const out = [];
      let outBytes = 0, stderr = '', settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      child.on('exit', untrack);
      const onAbort = () => { kill(child); finish(reject, abortError(signal)); };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', chunk => {
        outBytes += chunk.length;
        if (outBytes > maxOutput) {
          kill(child);
          finish(reject, new LookupError('lookup_unavailable', 'The lookup returned too much data.'));
        } else out.push(chunk);
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
      child.on('error', error => {
        untrack();
        finish(reject, new LookupError('lookup_unavailable',
          error.code === 'ENOENT' ? 'The processor is not installed on this computer.' : 'The processor could not start a lookup.', { detail: error.message }));
      });
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) { finish(reject, failureFrom(stderr, code)); return; }
        try { finish(resolve, JSON.parse(Buffer.concat(out).toString('utf8'))); }
        catch { finish(reject, new LookupError('lookup_unavailable', 'The lookup returned unreadable data.', { detail: stderr.slice(-2000) })); }
      });
    });
  };
}

// ---------------------------------------------------------------- arguments

/** yt-dlp args for a flat search: one request, no per-video page fetches. */
export function searchArgs(provider, query, n) {
  const key = provider === 'soundcloud' ? 'scsearch' : 'ytsearch';
  return [...BASE_ARGS, ...LOOKUP_ARGS, '--flat-playlist', '--', `${key}${n}:${query}`];
}

/**
 * yt-dlp args for a full extraction of one page. `--flat-playlist` keeps a collection
 * page (channel, album, user page, list-only watch URL) from resolving every entry: it
 * comes back at once as `_type: playlist` (→ 422). A single video is extracted as before.
 */
export function resolveArgs(url) {
  return [...BASE_ARGS, ...LOOKUP_ARGS, '--flat-playlist', '--', url];
}

// ---------------------------------------------------------------- mapping

const str = v => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const httpUrl = v => {
  if (typeof v !== 'string' || v.length > MAX_URL) return null;
  try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; }
};
const httpsUrl = v => { const u = httpUrl(v); return u && u.startsWith('https:') ? u : null; };
const seconds = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** youtube | soundcloud | other, from an extractor key ('Youtube', 'Soundcloud', 'BandcampTrack', …). */
export function providerOf(extractor) {
  const key = str(extractor).toLowerCase();
  if (key.startsWith('youtube')) return 'youtube';
  if (key.startsWith('soundcloud')) return 'soundcloud';
  return 'other';
}

/** The largest https thumbnail at most 480 px wide; YouTube falls back to its mqdefault still. */
export function pickThumbnail(info, provider, id) {
  const list = (Array.isArray(info?.thumbnails) ? info.thumbnails : [])
    .map(t => ({ url: httpsUrl(t?.url), width: typeof t?.width === 'number' ? t.width : null }))
    .filter(t => t.url);
  const fitting = list.filter(t => t.width !== null && t.width <= 480).sort((a, b) => b.width - a.width);
  if (fitting.length) return fitting[0].url;
  if (provider === 'youtube' && YOUTUBE_ID.test(id)) return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  return httpsUrl(info?.thumbnail) ?? list.find(t => t.width === null)?.url ?? null;
}

const isLive = info => info?.live_status === 'is_live' || info?.is_live === true;
const channelOf = info =>
  str(info?.artist) || (Array.isArray(info?.artists) ? info.artists.map(str).filter(Boolean).join(', ') : '') ||
  str(info?.channel) || str(info?.uploader) || str(info?.creator);

/**
 * One flat search entry → a Candidate, or null when it cannot be offered
 * (no id or title, not a video, an upcoming stream, outside SoundCloud's duration window).
 * @returns {Candidate|null}
 */
export function mapFlatEntry(entry, provider) {
  if (!entry || typeof entry !== 'object') return null;
  const id = str(entry.id);
  const title = str(entry.track) || str(entry.title);
  if (!id || !title || entry.live_status === 'is_upcoming') return null;
  const duration = seconds(entry.duration);
  let url;
  if (provider === 'youtube') {
    if (!YOUTUBE_ID.test(id) || (entry.ie_key && providerOf(entry.ie_key) !== 'youtube')) return null;
    url = `https://www.youtube.com/watch?v=${id}`;
  } else {
    url = httpUrl(entry.webpage_url) ?? httpUrl(entry.url);
    if (!url) return null;
    if (duration !== null && !(duration > SOUNDCLOUD_WINDOW.min && duration < SOUNDCLOUD_WINDOW.max)) return null;
  }
  return {
    url, id, title,
    channel: str(entry.channel) || str(entry.uploader) || channelOf(entry),
    duration,
    thumbnail: pickThumbnail(entry, provider, id),
    provider,
    live: isLive(entry),
  };
}

/** A flat search result (`_type: playlist`) → at most n Candidates, unique by id. */
export function mapSearchResult(info, provider, n) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(info?.entries) ? info.entries : []) {
    const candidate = mapFlatEntry(entry, provider);
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    out.push(candidate);
    if (out.length >= n) break;
  }
  return out;
}

const PLAYLIST_MESSAGE = 'This is a playlist link. Paste a link to one song.';

/**
 * A full single-page extraction → one Candidate. A playlist (or multi-video page) is a 422.
 * @returns {Candidate}
 */
export function mapResolvedInfo(info, requestedUrl) {
  if (!info || typeof info !== 'object') throw new LookupError('not_found', 'Nothing playable was found at that link.');
  if (info._type === 'playlist' || info._type === 'multi_video' || Array.isArray(info.entries)) throw new LookupError('playlist', PLAYLIST_MESSAGE);
  if (info.live_status === 'is_upcoming') throw new LookupError('unavailable', 'This live event hasn’t started.');
  const id = str(info.id);
  if (!id) throw new LookupError('not_found', 'Nothing playable was found at that link.');
  const provider = providerOf(info.extractor_key ?? info.ie_key ?? info.extractor);
  return {
    url: httpUrl(info.webpage_url) ?? httpUrl(info.original_url) ?? requestedUrl,
    id,
    title: str(info.track) || str(info.title) || str(info.fulltitle) || id,
    channel: channelOf(info),
    duration: seconds(info.duration),
    thumbnail: pickThumbnail(info, provider, id),
    provider,
    live: isLive(info),
  };
}

// ---------------------------------------------------------------- input validation

const SPOTIFY_HOSTS = new Set(['open.spotify.com', 'play.spotify.com', 'spotify.link']);
const SPOTIFY_COLLECTIONS = new Set(['album', 'playlist']);

/**
 * Validate a /resolve input: ≤ 2000 chars, http(s): or spotify:.
 * → {kind: 'url', url} | {kind: 'spotify', url}  (url is what oEmbed accepts)
 * Known playlist shapes are rejected without a network call.
 */
export function parseResolveInput(raw) {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input || input.length > MAX_URL) throw new LookupError('invalid', 'Paste a link to one song.');
  const uri = /^spotify:(track|album|playlist|artist|episode|show|user):([A-Za-z0-9]+)$/i.exec(input);
  if (uri) return spotifyTarget(uri[1].toLowerCase(), `https://open.spotify.com/${uri[1].toLowerCase()}/${uri[2]}`);
  let url;
  try { url = new URL(input); } catch { throw new LookupError('invalid', 'Paste a link to one song.'); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) throw new LookupError('invalid', 'Paste a link to one song.');
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (SPOTIFY_HOSTS.has(host)) {
    if (host === 'spotify.link') return { kind: 'spotify', url: url.href };
    const parts = url.pathname.split('/').filter(Boolean).filter(p => !/^intl-[a-z-]+$/i.test(p) && p !== 'embed');
    return spotifyTarget((parts[0] ?? '').toLowerCase(), `https://open.spotify.com/${parts.join('/')}`);
  }
  const youtube = host === 'youtube.com' || host.endsWith('.youtube.com');
  if (youtube && url.pathname === '/playlist') throw new LookupError('playlist', PLAYLIST_MESSAGE);
  if (youtube && url.pathname === '/watch' && url.searchParams.get('list') && !url.searchParams.get('v')) throw new LookupError('playlist', PLAYLIST_MESSAGE);
  if (host === 'soundcloud.com' && /^\/[^/]+\/sets\/[^/]+/.test(url.pathname)) throw new LookupError('playlist', PLAYLIST_MESSAGE);
  return { kind: 'url', url: url.href };
}

function spotifyTarget(type, url) {
  if (type === 'track') return { kind: 'spotify', url };
  if (SPOTIFY_COLLECTIONS.has(type)) throw new LookupError('playlist', PLAYLIST_MESSAGE);
  throw new LookupError('invalid', 'Paste a link to one song.');
}

/** Validate a /search input → {query, n}. */
export function parseSearchInput(q, n) {
  const query = typeof q === 'string' ? q.trim().replace(/\s+/g, ' ') : '';
  if (!query || query.length > MAX_QUERY) throw new LookupError('invalid', `Type 1–${MAX_QUERY} characters.`);
  const count = n === undefined || n === null || n === '' ? MAX_RESULTS : Number(n);
  if (!Number.isInteger(count) || count < 1 || count > MAX_RESULTS) throw new LookupError('invalid', `Ask for 1–${MAX_RESULTS} results.`);
  return { query, n: count };
}

// ---------------------------------------------------------------- cache

/** A small LRU with a TTL. Values are cloned in and out, so callers cannot mutate cached results. */
export function createLru({ max = CACHE_SIZE, ttlMs = CACHE_TTL_MS, now = Date.now } = {}) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      map.delete(key);
      if (now() - hit.at >= ttlMs) return undefined;
      map.set(key, hit);
      return structuredClone(hit.value);
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { at: now(), value: structuredClone(value) });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
    keys: () => [...map.keys()],
    clear: () => map.clear(),
  };
}

// ---------------------------------------------------------------- lookups

/**
 * The lookup service. `ytDlp` from createYtDlp; `fetch` for Spotify's oEmbed.
 * Each lookup has one deadline (`timeoutMs`, 20 s) across every child it runs.
 */
export function createLookup({ ytDlp, fetch = globalThis.fetch, cache = createLru(), timeoutMs = TIMEOUT_MS, setTimeout: setTimer = globalThis.setTimeout, clearTimeout: clearTimer = globalThis.clearTimeout } = {}) {
  async function withDeadline(signal, run) {
    const controller = new AbortController();
    const relay = () => controller.abort(signal.reason);
    if (signal?.aborted) relay();
    else signal?.addEventListener('abort', relay, { once: true });
    const timer = setTimer(() => controller.abort(new LookupError('timeout', 'The lookup took too long.')), timeoutMs);
    const aborted = new Promise((_, reject) => {
      const fail = () => reject(abortError(controller.signal));
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => {});
    // The run settles after the race when the deadline or an abort wins; never leave it unhandled.
    const work = run(controller.signal);
    work.catch(() => {});
    try {
      return await Promise.race([work, aborted]);
    } finally {
      clearTimer(timer);
      signal?.removeEventListener('abort', relay);
    }
  }

  const passThrough = error => error instanceof LookupError && (error.code === 'timeout' || error.code === 'aborted' || error.code === 'lookup_busy');

  /** YouTube first; on a bot check, SoundCloud (which draws none). */
  async function searchProviders(query, n, signal) {
    try {
      return { query, provider: 'youtube', candidates: mapSearchResult(await ytDlp(searchArgs('youtube', query, n), { signal }), 'youtube', n) };
    } catch (error) {
      if (!(error instanceof LookupError) || error.code !== 'bot_check') throw error;
      try {
        return { query, provider: 'soundcloud', candidates: mapSearchResult(await ytDlp(searchArgs('soundcloud', query, n), { signal }), 'soundcloud', n) };
      } catch (fallback) {
        if (passThrough(fallback)) throw fallback;
        throw new LookupError('bot_check', 'YouTube asked for a sign-in check, and SoundCloud could not be searched.',
          { detail: [error.detail, fallback.detail ?? fallback.message].filter(Boolean).join('\n') });
      }
    }
  }

  /**
   * Spotify's oEmbed title (+ artist) as a search query. A bad link (4xx, or no title)
   * is not_found; no connection, a 5xx or a 429 is lookup_unavailable, like yt-dlp's.
   */
  async function spotifyQuery(url, signal) {
    const down = detail => new LookupError('lookup_unavailable', 'Spotify could not be reached.', { detail });
    let response;
    try {
      response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, { signal, headers: { accept: 'application/json' } });
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      throw down(`Spotify oEmbed: ${error?.message ?? error}`);
    }
    if (response.status === 429 || response.status >= 500) throw down(`Spotify oEmbed answered ${response.status}.`);
    let body = null;
    if (response.ok) {
      try { body = await response.json(); } catch (error) {
        if (signal.aborted) throw abortError(signal);
        throw down(`Spotify oEmbed sent unreadable data: ${error?.message ?? error}`);
      }
    }
    const title = str(body?.title);
    if (!title) throw new LookupError('not_found', 'Could not resolve this Spotify link.');
    const author = str(body?.author_name);
    return `${title}${author && !title.toLowerCase().includes(author.toLowerCase()) ? ` ${author}` : ''}`.slice(0, MAX_QUERY).trim();
  }

  return {
    cache,
    /** @returns {Promise<{query: string, provider: 'youtube'|'soundcloud', candidates: Candidate[]}>} */
    async search(q, n, { signal } = {}) {
      const input = parseSearchInput(q, n);
      const key = `search:${input.n}:${input.query.toLowerCase()}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const result = await withDeadline(signal, s => searchProviders(input.query, input.n, s));
      cache.set(key, result);
      return result;
    },
    /** @returns {Promise<{kind: 'url'|'spotify', query?: string, candidates: Candidate[]}>} */
    async resolve(raw, { signal } = {}) {
      const target = parseResolveInput(raw);
      const key = `resolve:${target.url}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const result = await withDeadline(signal, async s => {
        if (target.kind === 'spotify') {
          const query = await spotifyQuery(target.url, s);
          const found = await searchProviders(query, MAX_RESULTS, s);
          return { kind: 'spotify', query, candidates: found.candidates };
        }
        return { kind: 'url', candidates: [mapResolvedInfo(await ytDlp(resolveArgs(target.url), { signal: s }), target.url)] };
      });
      cache.set(key, result);
      return result;
    },
  };
}

// ---------------------------------------------------------------- HTTP routes

const ROUTES = { '/resolve': 'resolve', '/search': 'search' };

function send(res, status, body) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * `handle(req, res) → Promise<boolean>`: answers /resolve and /search (true), else false.
 * The caller has already checked host, origin and the bearer token. One lookup is in
 * flight per route: a new request aborts the previous one (409 lookup_busy), and a closed
 * request kills its child. `handle.abortAll()` aborts every in-flight lookup (shutdown).
 */
export function createLookupRoutes(lookup, { log = (...args) => console.error(...args) } = {}) {
  const inflight = { resolve: null, search: null };
  handle.abortAll = (reason = new LookupError('aborted', 'The processor is shutting down.')) => {
    for (const route of Object.keys(inflight)) inflight[route]?.abort(reason);
  };
  return handle;
  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = ROUTES[url.pathname];
    if (!route) return false;
    if (req.method !== 'GET') { send(res, 405, { error: 'Use GET.', code: 'invalid' }); return true; }
    inflight[route]?.abort(new LookupError('lookup_busy', 'A newer lookup replaced this one.'));
    const controller = new AbortController();
    inflight[route] = controller;
    res.on('close', () => { if (!res.writableFinished) controller.abort(new LookupError('aborted', 'The request was closed.')); });
    try {
      const result = route === 'resolve'
        ? await lookup.resolve(url.searchParams.get('url') ?? '', { signal: controller.signal })
        : await lookup.search(url.searchParams.get('q') ?? '', url.searchParams.get('n') ?? undefined, { signal: controller.signal });
      send(res, 200, result);
    } catch (error) {
      const coded = error instanceof LookupError ? error : new LookupError('lookup_unavailable', 'The lookup could not run.', { detail: error?.message });
      if (coded.code === 'lookup_unavailable') log(`Lookup ${route}:`, coded.message, coded.detail ?? '');
      send(res, coded.status, { error: coded.message, code: coded.code, ...(coded.detail ? { detail: coded.detail } : {}) });
    } finally {
      if (inflight[route] === controller) inflight[route] = null;
    }
    return true;
  }
}
