// Export song: one song's stems, backing track, tempo map and drum chart as a ZIP for other apps (a DAW,
// Guitar Pro, another player). The files themselves come from song-files.js; this module gathers them from
// the open session and streams the archive.
//
//   exportOptions(session) → {title, artist, base, sampleRate, frames, seconds, stems: [{name, channels, mine}],
//                             mine, backingName, canBacking, mapped, hasChart, loaded, original: bool}
//     What this song can export. `mine` is the account's part (Minus me); the backing track is every other stem.
//   estimateBytes(options, choices) → number             the archive's approximate size
//   exportSong(session, choices, {onProgress, signal, window, api, alphaTab}) → Promise<{name, bytes}>
//     choices: {stems: [names], format: 'wav'|'original', backing, tempoMap, drumMidi, guitarPro}
//     onProgress(text, {done, total})
//
// Audio comes from the session's engine, already decoded and sample-aligned: WAVs need no download. With a
// bar grid, every WAV starts with the same silence (song-files.js alignment) so the song's bar 1 lands on a
// bar line of the MIDI files; separate exports of one song therefore always line up with each other.
// 'original' streams the stems as stored (Opus in WebM) through the same signed fetch as the library export.
// The save picker opens synchronously, inside the click, before any wait (browsers need the gesture);
// without one the archive is built in memory, up to FALLBACK_LIMIT bytes. A failure or a cancel leaves no
// archive reported as saved.
import {Zip, ZipPassThrough} from 'fflate';
import {DEFAULT_API as LIBRARY_API, safeName} from '../js/export.js';
import {now} from '../app/clock.js';
import {alignment, drumChartMidi, guitarProFile, mixdown, readme, tempoMapMidi, wavChunks} from './song-files.js';

/** Without a save picker the archive is built in memory, up to this size. */
export const FALLBACK_LIMIT = 1_000_000_000;

export const COPY = Object.freeze({
  stem: (name, i, n) => `Writing ${name} (${i} of ${n})…`,
  backing: 'Mixing the backing track…',
  midi: 'Writing the tempo map and chart…',
  finishing: 'Finishing the archive…',
  notLoaded: 'The audio is still loading. Try again in a moment.',
  nothing: 'Choose at least one thing to export.',
  tooLarge: 'This browser can only save exports up to 1 GB, and this one is larger. Choose fewer stems or Original files, or export from Chrome or Edge on a computer, or from Woodshed for desktop.',
  stemFailed: name => `Couldn’t download the ${name} stem. Check your connection and try again.`,
  backingName: names => `Backing track (no ${names.join(' + ')}).wav`,
});

const encoder = new TextEncoder();
const peek = v => (v && typeof v.peek === 'function' ? v.peek() : v);
const channelsOf = buffer => Array.from({length: Math.min(2, buffer.numberOfChannels)}, (_, c) => buffer.getChannelData(c));

export function exportOptions(session) {
  const song = peek(session.song) ?? {};
  const tracks = session.engine?.tracks ?? [];
  const mine = (peek(session.transport?.snapshot)?.mix?.mine ?? []).filter(name => tracks.some(t => t.name === name));
  const stems = tracks.map(t => ({name: t.name, channels: Math.min(2, t.buffer?.numberOfChannels ?? 2), mine: mine.includes(t.name)}));
  const sampleRate = tracks[0]?.buffer?.sampleRate ?? 48000;
  const frames = Math.max(0, ...tracks.map(t => t.buffer?.length ?? 0));
  const title = song.title || 'Untitled', artist = song.artist || '';
  return {
    title, artist, base: safeName([artist, title].filter(Boolean).join(' - ')),
    sampleRate, frames, seconds: frames / sampleRate, stems, mine,
    backingName: mine.length ? COPY.backingName(mine) : null,
    canBacking: mine.length > 0 && stems.length > mine.length,
    mapped: !!session.map?.isReal,
    hasChart: !!peek(session.notation?.hasNotation),
    loaded: peek(session.load)?.phase === 'ready' && tracks.length > 0,
    original: (song.stems ?? []).some(s => s?.key),
    // The silence every WAV starts with (song-files.js alignment), so the estimate can count it.
    padSeconds: session.map?.isReal && frames ? alignment(session.map.serialize(), frames / sampleRate).padSeconds : 0,
  };
}

export function estimateBytes(options, choices) {
  const byName = new Map(options.stems.map(s => [s.name, s]));
  const pad = choices.format === 'original' ? 0 : choices.padSeconds ?? options.padSeconds ?? 0;
  const frames = options.frames + Math.round(pad * options.sampleRate);
  let total = 4096;
  for (const name of choices.stems ?? []) {
    const stem = byName.get(name);
    if (!stem) continue;
    total += choices.format === 'original' ? options.seconds * 24_000 : 44 + frames * stem.channels * 2;
  }
  if (choices.backing && options.canBacking) total += 44 + frames * 2 * 2;
  return total;
}

const abortError = signal => (signal?.reason instanceof Error && signal.reason.name === 'AbortError'
  ? signal.reason : new DOMException('The export was canceled.', 'AbortError'));
const check = signal => { if (signal?.aborted) throw abortError(signal); };
function until(signal, promise) {
  if (!signal) return promise;
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(abortError(signal)); }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
/** Lets the page breathe between chunks (the dialog's progress and Cancel stay live). */
const breathe = () => new Promise(resolve => setTimeout(resolve, 0));

export async function exportSong(session, choices, {onProgress = () => {}, signal = null, window: win = globalThis.window,
  api = LIBRARY_API, alphaTab = () => import('@coderline/alphatab')} = {}) {
  const options = exportOptions(session);
  const name = `${options.base}.zip`;
  const say = (text, detail) => { try { onProgress(text, detail); } catch (err) { console.error('[export] a progress listener failed', err); } };
  const stems = options.stems.filter(s => choices.stems?.includes(s.name));
  const backing = !!choices.backing && options.canBacking;
  const tempoMap = !!choices.tempoMap && options.mapped;
  const drumMidi = !!choices.drumMidi && options.mapped && options.hasChart;
  const guitarPro = !!choices.guitarPro && options.hasChart;
  const original = choices.format === 'original' && options.original;
  // Everything up to the picker is synchronous: the picker must open inside the click's gesture.
  if (!stems.length && !backing && !tempoMap && !drumMidi && !guitarPro) throw new Error(COPY.nothing);
  if (!options.loaded && (stems.length || backing)) throw new Error(COPY.notLoaded);
  const mapData = options.mapped ? session.map.serialize() : null;
  const align = mapData ? alignment(mapData, options.seconds) : null;
  const padSeconds = align && !original ? align.padSeconds : 0;
  const padFrames = Math.round(padSeconds * options.sampleRate);
  const picking = typeof win?.showSaveFilePicker === 'function'
    ? win.showSaveFilePicker({suggestedName: name, types: [{description: 'ZIP archive', accept: {'application/zip': ['.zip']}}]})
    : null;
  if (!picking && estimateBytes(options, {...choices, stems: stems.map(s => s.name), backing, padSeconds}) > FALLBACK_LIMIT) throw new Error(COPY.tooLarge);
  const handle = picking ? await picking : null;
  check(signal);

  let score = null;
  if (drumMidi || guitarPro) {
    await until(signal, session.notation?.contents?.() ?? null);
    score = session.notation?.part?.score ?? null;
  }

  const writer = handle ? await until(signal, handle.createWritable()) : null;
  const chunks = [];
  let outputBytes = 0, chain = Promise.resolve(), finishedResolve, finishedReject;
  const finished = new Promise((resolve, reject) => { finishedResolve = resolve; finishedReject = reject; });
  finished.catch(() => {});
  const zip = new Zip((error, chunk, final) => {
    if (error) { finishedReject(error); return; }
    outputBytes += chunk.length;
    chain = chain.then(async () => {
      if (writer) await writer.write(chunk);
      else {
        if (outputBytes > FALLBACK_LIMIT) throw new Error(COPY.tooLarge);
        chunks.push(chunk);
      }
    });
    chain.catch(finishedReject);
    if (final) chain.then(finishedResolve, finishedReject);
  });
  const folder = options.base;
  async function add(path, bytes) {
    const entry = new ZipPassThrough(`${folder}/${path}`);
    zip.add(entry);
    entry.push(bytes, true);
    await until(signal, chain);
  }
  async function addWav(path, channels) {
    const entry = new ZipPassThrough(`${folder}/${path}`);
    zip.add(entry);
    let n = 0;
    for (const chunk of wavChunks(channels, options.sampleRate, {padFrames})) {
      check(signal);
      entry.push(chunk);
      if (++n % 4 === 0) { await until(signal, chain); await breathe(); }
    }
    entry.push(new Uint8Array(), true);
    await until(signal, chain);
  }
  async function addStream(path, response) {
    const entry = new ZipPassThrough(`${folder}/${path}`);
    zip.add(entry);
    const reader = response.body.getReader();
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
    }
    entry.push(new Uint8Array(), true);
    await until(signal, chain);
  }

  const total = stems.length + (backing ? 1 : 0) + 1;
  let done = 0;
  try {
    const date = new Date(now()).toISOString().slice(0, 10);
    await add('README.txt', encoder.encode(readme({
      title: options.title, artist: options.artist, date, sampleRate: options.sampleRate, original,
      stems: stems.map(s => s.name), backing: backing ? options.backingName : null,
      tempoMap, drumMidi, guitarPro: guitarPro && !!score, align,
    })));

    if (original && stems.length) {
      const song = peek(session.song) ?? {};
      const keys = new Map((song.stems ?? []).filter(s => s?.key).map(s => [s.name, s.key]));
      const urls = await until(signal, api.signKeys([...keys.values()]));
      for (const stem of stems) {
        say(COPY.stem(stem.name, ++done, total), {done: done - 1, total});
        const key = keys.get(stem.name);
        const response = key && urls?.[key] ? await until(signal, api.fetch(urls[key], {signal})) : null;
        if (!response?.ok || !response.body) throw new Error(COPY.stemFailed(stem.name));
        const ext = (key.split('.').pop() || 'webm').toLowerCase();
        await addStream(`Stems/${safeName(stem.name)}.${/^[a-z0-9]{1,5}$/.test(ext) ? ext : 'webm'}`, response);
      }
    } else {
      const tracks = new Map((session.engine?.tracks ?? []).map(t => [t.name, t]));
      for (const stem of stems) {
        say(COPY.stem(`${stem.name}.wav`, ++done, total), {done: done - 1, total});
        await addWav(`Stems/${safeName(stem.name)}.wav`, channelsOf(tracks.get(stem.name).buffer));
      }
    }
    if (backing) {
      say(COPY.backing, {done: done++, total});
      const tracks = (session.engine?.tracks ?? []).filter(t => !options.mine.includes(t.name)).map(t => channelsOf(t.buffer));
      await breathe();
      await addWav(options.backingName, mixdown(tracks));
    }
    if (tempoMap || drumMidi || guitarPro) {
      say(COPY.midi, {done: done++, total});
      const title = [options.artist, options.title].filter(Boolean).join(' – ');
      if (tempoMap) await add('Tempo map.mid', tempoMapMidi(mapData, options.seconds, {title}));
      if (drumMidi && score) await add('Drum chart.mid', drumChartMidi(score, mapData, options.seconds, {title}));
      if (guitarPro && score) {
        const at = await until(signal, alphaTab());
        await add('Drum chart.gp', guitarProFile(at, score, {title: options.title, artist: options.artist}));
      }
    }
    check(signal);
    say(COPY.finishing, {done: total, total});
    zip.end();
    await until(signal, finished);
    if (writer) await writer.close();
    else {
      const url = URL.createObjectURL(new Blob(chunks, {type: 'application/zip'}));
      const a = win.document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    return {name, bytes: outputBytes};
  } catch (error) {
    zip.terminate();
    await writer?.abort().catch(() => {});
    throw error;
  }
}
