// Export library (ZIP) (architecture §1 "export.js (changed: src/api)", §6.8, §9.12 SE2; spec §6.2,
// §6.3): the user's only copy of their cloud library outside Woodshed. Called from Settings → Plan &
// storage and from the paused-account page (src/app/fatal.js).
//
//   exportLibrary(onProgress?, {signal, api, window}) → Promise<{songs, bytes}>
//     onProgress(text, {phase: 'gather'|'song'|'finish'|'done', done, total, title})
//
// The archive:
//   manifest.json                     {version: 1, exportedAt, songs}: every song as songs.exportPage gives
//                                     it (metadata, map, practice as stored), in library order
//   settings.json                     the account settings (settings.config)
//   setlists.json                     {version: 1, setlists: [{id, name, songIds, updatedAt, lastOpenedAt}]}
//   <title>-<id>/<stem>.webm …        the synced stems and the cover, as stored (audio is already
//                                     compressed, so entries are stored, not deflated)
//   <title>-<id>/drums.woodshed.json  the drum chart, always upgraded to the current notation version
//
// The save picker opens synchronously, inside the click that called this (browsers require a user
// gesture), before any network wait. Browsers without showSaveFilePicker (Safari, iPad, Firefox) build
// the archive in memory and download it, which is limited to FALLBACK_LIMIT bytes (100 MB): a larger
// library is refused before anything is written. Every failure aborts the destination; nothing is
// reported as exported unless the whole archive was written. A signal aborts the export (AbortError) at
// once, even while a request or a download is stalled: it is passed to the audio fetch, cancels the body
// being read, and every wait races it.
// Thrown errors are either ApiErrors from src/api (coded) or plain Errors whose message is a sentence
// written for people (fatal.js and Plan & storage show those as they are). Cancelling the save picker
// rejects with the picker's AbortError.

import {Zip, ZipPassThrough} from 'fflate';
import {query} from '../api/client.js';
import * as songsApi from '../api/songs.js';
import * as settingsApi from '../api/settings.js';
import * as setlistsApi from '../api/setlists.js';
import {signKeys} from '../api/media.js';
import {upgradeScore} from '../../shared/notation.ts';
import {now} from '../app/clock.js';

export const ARCHIVE_NAME = 'Woodshed-library.zip';
/** songs.exportPage page size. */
export const PAGE_SIZE = 50;
/** Without a save picker the archive is built in memory, up to this size. */
export const FALLBACK_LIMIT = 100_000_000;

export const EXPORT_COPY = Object.freeze({
  gathering: 'Gathering your library…',
  song: (i, n, title) => `Exporting ${i}/${n}: ${title}`,
  finishing: 'Finishing the archive…',
  done: n => `Exported ${n} ${n === 1 ? 'song' : 'songs'}.`,
  tooLarge: 'This browser can only save an export of up to 100 MB, and your library is larger. Export from Chrome or Edge on a computer, or from Woodshed for desktop.',
  songFailed: title => `Couldn’t download the audio for ${title}. Check your connection and try again.`,
});

/** Where export.js reads the library (tests pass their own). */
export const DEFAULT_API = Object.freeze({
  exportPage: args => songsApi.exportPage(args),
  config: () => settingsApi.config(),
  setlists: () => setlistsApi.list(),
  notation: songId => query('notation:get', {songId}),
  signKeys: keys => signKeys(keys),
  // media-fetch.js's fetchMedia, plus the abort signal (fetchMedia takes no init yet): desktop streams
  // signed audio through its native HTTP client, the browser fetches R2 directly.
  fetch: async (url, {signal} = {}) => {
    const bridge = globalThis.window?.woodshedDesktop;
    return fetch(bridge?.mediaUrl ? await bridge.mediaUrl(url) : url, {signal: signal ?? undefined});
  },
});

const encoder = new TextEncoder();
const json = value => encoder.encode(JSON.stringify(value, null, 2));

/** A file or folder name: letters, digits, `._ -`; at most 100 characters; never empty. */
export const safeName = text => String(text ?? '').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 100) || 'song';

/** The folder a song's files go in: `<title>-<id>`. */
export const songFolder = song => `${safeName(song.title)}-${song.id}`;

/** The stored stem bytes of a list of songs (what the archive's audio adds up to, before covers). */
export function libraryBytes(songs) {
  let total = 0;
  for (const song of songs ?? []) for (const stem of song?.stems ?? []) total += Number(stem?.bytes) > 0 ? Number(stem.bytes) : 0;
  return total;
}

/** setlists.json from setlists.list rows. */
export function setlistsDocument(rows) {
  return {
    version: 1,
    setlists: (Array.isArray(rows) ? rows : []).map(row => ({
      id: row.id, name: row.name, songIds: Array.isArray(row.songIds) ? [...row.songIds] : [],
      updatedAt: row.updatedAt ?? null, lastOpenedAt: row.lastOpenedAt ?? null,
    })),
  };
}

/** The drum chart file for a song, or null when the song has none. */
export function notationDocument(song, notation) {
  if (!notation?.score) return null;
  // Stored parts can mix version 1 rows into a version 2 part; exports are always current.
  return {
    format: 'woodshed-notation', version: 2,
    song: {title: song.title, artist: song.artist, duration: song.duration},
    score: upgradeScore(notation.score),
  };
}

const abortError = signal => (signal?.reason instanceof Error && signal.reason.name === 'AbortError'
  ? signal.reason
  : new DOMException('The export was canceled.', 'AbortError'));
const check = signal => { if (signal?.aborted) throw abortError(signal); };

/** `promise`, or an AbortError as soon as the signal fires: a stalled request never holds Cancel up. */
function until(signal, promise) {
  if (!signal) return promise;
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Streams the library into a ZIP. See the header. */
export async function exportLibrary(onProgress = () => {}, {signal = null, api = DEFAULT_API, window: win = globalThis.window} = {}) {
  const say = (text, detail) => {
    try { onProgress(text, detail); } catch (err) { console.error('[export] a progress listener failed', err); }
  };
  // The picker must open inside the gesture: it is called before the first await.
  const picking = typeof win?.showSaveFilePicker === 'function'
    ? win.showSaveFilePicker({suggestedName: ARCHIVE_NAME, types: [{description: 'ZIP archive', accept: {'application/zip': ['.zip']}}]})
    : null;
  const handle = picking ? await picking : null;
  check(signal);

  say(EXPORT_COPY.gathering, {phase: 'gather', done: 0, total: 0});
  const songs = [];
  let cursor = null, page;
  do {
    page = await until(signal, api.exportPage({paginationOpts: {numItems: PAGE_SIZE, cursor}}));
    songs.push(...(page?.page ?? []));
    cursor = page?.continueCursor ?? null;
    check(signal);
  } while (page && !page.isDone);
  const [config, lists] = await until(signal, Promise.all([api.config(), api.setlists()]));
  check(signal);

  if (!handle && libraryBytes(songs) > FALLBACK_LIMIT) throw new Error(EXPORT_COPY.tooLarge);

  const writer = handle ? await until(signal, handle.createWritable()) : null;
  const chunks = [];
  let outputBytes = 0, chain = Promise.resolve();
  let finishedResolve, finishedReject;
  const finished = new Promise((resolve, reject) => { finishedResolve = resolve; finishedReject = reject; });
  // Mark the rejection handled at once: downloads are still in flight when a write fails.
  finished.catch(() => {});
  const zip = new Zip((error, chunk, final) => {
    if (error) { finishedReject(error); return; }
    outputBytes += chunk.length;
    chain = chain.then(async () => {
      if (writer) await writer.write(chunk);
      else {
        if (outputBytes > FALLBACK_LIMIT) throw new Error(EXPORT_COPY.tooLarge);
        chunks.push(chunk);
      }
    });
    chain.catch(finishedReject);
    if (final) chain.then(finishedResolve, finishedReject);
  });
  async function add(name, bytes) {
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    entry.push(bytes, true);
    await until(signal, chain);
  }
  /** Streams one response body into an entry; an abort cancels the body at once, even mid-read. */
  async function stream(name, response) {
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    const reader = response.body.getReader();
    const onAbort = () => { reader.cancel(abortError(signal)).catch(() => {}); };
    signal?.addEventListener('abort', onAbort, {once: true});
    try {
      while (true) {
        check(signal);
        const {value, done} = await until(signal, reader.read());
        if (done) break;
        entry.push(value);
        await until(signal, chain);
      }
    } catch (err) {
      reader.cancel().catch(() => {});
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    entry.push(new Uint8Array(), true);
    await until(signal, chain);
  }

  try {
    await add('manifest.json', json({version: 1, exportedAt: new Date(now()).toISOString(), songs}));
    await add('settings.json', json(config?.settings ?? {}));
    await add('setlists.json', json(setlistsDocument(lists)));
    for (const [i, song] of songs.entries()) {
      check(signal);
      say(EXPORT_COPY.song(i + 1, songs.length, song.title), {phase: 'song', done: i, total: songs.length, title: song.title});
      const folder = songFolder(song);
      const chart = notationDocument(song, await until(signal, api.notation(song.id)));
      check(signal);
      if (chart) await add(`${folder}/drums.woodshed.json`, json(chart));
      const keys = [...(song.stems ?? []).map(s => s.key), ...(song.coverKey ? [song.coverKey] : [])].filter(Boolean);
      const urls = keys.length ? await until(signal, api.signKeys(keys)) : {};
      for (const key of keys) {
        check(signal);
        const response = urls[key] ? await until(signal, api.fetch(urls[key], {signal})) : null;
        if (!response?.ok || !response.body) throw new Error(EXPORT_COPY.songFailed(song.title));
        await stream(`${folder}/${safeName(key.split('/').pop())}`, response);
      }
    }
    check(signal);
    say(EXPORT_COPY.finishing, {phase: 'finish', done: songs.length, total: songs.length});
    zip.end();
    await until(signal, finished);
    if (writer) await writer.close();
    else {
      const url = URL.createObjectURL(new Blob(chunks, {type: 'application/zip'}));
      const a = win.document.createElement('a');
      a.href = url;
      a.download = ARCHIVE_NAME;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    say(EXPORT_COPY.done(songs.length), {phase: 'done', done: songs.length, total: songs.length});
    return {songs: songs.length, bytes: outputBytes};
  } catch (error) {
    zip.terminate();
    await writer?.abort().catch(() => {});
    throw error;
  }
}
