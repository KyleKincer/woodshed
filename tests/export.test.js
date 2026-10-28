// SE2: src/js/export.js on src/api (architecture §1, §6.8, §9.12 SE2; spec §6.2, §6.3). The library
// ZIP streams stems, covers and charts with manifest.json, settings.json and setlists.json; the save
// picker opens before the first await (inside the click); without a picker the archive is limited to
// 100 MB; a failure or an abort leaves no half-written archive reported as done.
import {afterEach, describe, expect, test, vi} from 'vitest';
import {strFromU8, unzipSync} from 'fflate';
import {
  ARCHIVE_NAME, DEFAULT_API, EXPORT_COPY, FALLBACK_LIMIT, PAGE_SIZE, exportLibrary, libraryBytes, notationDocument, safeName,
  setlistsDocument, songFolder,
} from '../src/js/export.js';
import {durationOf, emptyScore, fraction} from '../shared/notation.ts';
import * as clock from '../src/app/clock.js';

afterEach(() => {
  vi.restoreAllMocks();
  clock.reset();
});

function destination() {
  const chunks = [];
  const writable = {write: vi.fn(async c => { chunks.push(c); }), close: vi.fn(async () => {}), abort: vi.fn(async () => {})};
  const handle = {createWritable: vi.fn(async () => writable)};
  const bytes = () => {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
  };
  return {writable, handle, read: () => unzipSync(bytes())};
}

function api({songs = [], pages = null, settings = {bitrate: 192}, setlists = [], notation = {}, urls = null, audio = new Uint8Array([10, 20, 30, 40])} = {}) {
  const pageList = pages ?? [songs];
  let call = 0;
  return {
    exportPage: vi.fn(async ({paginationOpts}) => {
      const i = call++;
      return {page: pageList[i] ?? [], isDone: i >= pageList.length - 1, continueCursor: `c${i + 1}`, numItems: paginationOpts.numItems};
    }),
    config: vi.fn(async () => ({settings})),
    setlists: vi.fn(async () => setlists),
    notation: vi.fn(async songId => notation[songId] ?? null),
    signKeys: vi.fn(async keys => urls ?? Object.fromEntries(keys.map(k => [k, `https://media.test/${k}`]))),
    fetch: vi.fn(async () => new Response(audio)),
  };
}

const PRACTICE = {v: 2, cue: 0, rate: 1, loop: {on: true, a: 1, b: 2, eachPassCount: true, playTimes: 0, between: 'none'}, tracks: [], minusMe: false, trainer: null, spots: [], markers: []};
const SONG = {id: 'song1', title: 'Practice', duration: 20, practice: PRACTICE, stems: [{name: 'drums', key: 'users/owner/drums.webm', bytes: 4}], coverKey: null};

describe('exportLibrary', () => {
  test('streams the stems, charts, manifest, settings and setlists into one archive', async () => {
    clock.set(Date.UTC(2026, 9, 28, 12));
    const dest = destination();
    const score = {...emptyScore(20), layout: 'split'};
    score.bars = [{measureId: score.timeline.measures[0].id, coverage: 'reviewed', hits: [], tuplets: [{start: fraction(0), length: fraction(1), count: 5}]}];
    const lib = api({songs: [{...SONG, coverKey: 'users/owner/cover.jpg'}], notation: {song1: {score, revision: 1}},
      setlists: [{id: 'set-1', name: 'Friday', count: 1, songIds: ['song1'], updatedAt: 5, lastOpenedAt: null}]});
    const win = {showSaveFilePicker: vi.fn(async () => dest.handle)};
    const progress = vi.fn();
    const result = await exportLibrary(progress, {api: lib, window: win});
    const archive = dest.read();
    expect(Object.keys(archive).sort()).toEqual(['Practice-song1/cover.jpg', 'Practice-song1/drums.webm', 'Practice-song1/drums.woodshed.json', 'manifest.json', 'setlists.json', 'settings.json']);
    expect(archive['Practice-song1/drums.webm']).toEqual(new Uint8Array([10, 20, 30, 40]));
    const manifest = JSON.parse(strFromU8(archive['manifest.json']));
    expect(manifest.version).toBe(1);
    expect(manifest.exportedAt).toBe('2026-10-28T12:00:00.000Z');
    expect(manifest.songs[0].practice).toEqual(PRACTICE);   // practice as stored, lossless
    expect(JSON.parse(strFromU8(archive['settings.json']))).toEqual({bitrate: 192});
    expect(JSON.parse(strFromU8(archive['setlists.json']))).toEqual({version: 1, setlists: [{id: 'set-1', name: 'Friday', songIds: ['song1'], updatedAt: 5, lastOpenedAt: null}]});
    expect(JSON.parse(strFromU8(archive['Practice-song1/drums.woodshed.json']))).toEqual({format: 'woodshed-notation', version: 2, song: {title: 'Practice', duration: 20}, score});
    expect(win.showSaveFilePicker).toHaveBeenCalledWith({suggestedName: ARCHIVE_NAME, types: [{description: 'ZIP archive', accept: {'application/zip': ['.zip']}}]});
    expect(lib.signKeys).toHaveBeenCalledWith(['users/owner/drums.webm', 'users/owner/cover.jpg']);
    expect(dest.writable.close).toHaveBeenCalledOnce();
    expect(dest.writable.abort).not.toHaveBeenCalled();
    expect(result.songs).toBe(1);
    expect(progress.mock.calls.map(c => c[0])).toEqual([EXPORT_COPY.gathering, EXPORT_COPY.song(1, 1, 'Practice'), EXPORT_COPY.finishing, EXPORT_COPY.done(1)]);
    expect(progress.mock.calls[1][1]).toEqual({phase: 'song', done: 0, total: 1, title: 'Practice'});
  });

  test('opens the save picker before any network wait (inside the click)', async () => {
    const dest = destination();
    const order = [];
    const lib = api({songs: []});
    lib.exportPage.mockImplementation(async () => { order.push('exportPage'); return {page: [], isDone: true, continueCursor: ''}; });
    const win = {showSaveFilePicker: vi.fn(() => { order.push('picker'); return Promise.resolve(dest.handle); })};
    const running = exportLibrary(() => {}, {api: lib, window: win});
    expect(order).toEqual(['picker']);   // synchronously, in the same task as the call
    await running;
    expect(order).toEqual(['picker', 'exportPage']);
  });

  test('pages through songs.exportPage until isDone', async () => {
    const dest = destination();
    const lib = api({pages: [[{...SONG, id: 'a', title: 'A', stems: []}], [{...SONG, id: 'b', title: 'B', stems: []}], [{...SONG, id: 'c', title: 'C', stems: []}]]});
    await exportLibrary(() => {}, {api: lib, window: {showSaveFilePicker: async () => dest.handle}});
    expect(lib.exportPage.mock.calls.map(c => c[0])).toEqual([
      {paginationOpts: {numItems: PAGE_SIZE, cursor: null}}, {paginationOpts: {numItems: PAGE_SIZE, cursor: 'c1'}}, {paginationOpts: {numItems: PAGE_SIZE, cursor: 'c2'}},
    ]);
    expect(JSON.parse(strFromU8(dest.read()['manifest.json'])).songs.map(s => s.id)).toEqual(['a', 'b', 'c']);
  });

  test('a failed download aborts the destination instead of reporting a complete export', async () => {
    const dest = destination();
    const lib = api({songs: [{id: 'song1', title: 'Missing', stems: [{key: 'audio', bytes: 4}]}]});
    lib.fetch.mockResolvedValue(new Response('missing', {status: 404}));
    await expect(exportLibrary(() => {}, {api: lib, window: {showSaveFilePicker: async () => dest.handle}})).rejects.toThrow(EXPORT_COPY.songFailed('Missing'));
    expect(dest.writable.abort).toHaveBeenCalledOnce();
    expect(dest.writable.close).not.toHaveBeenCalled();
  });

  test('a key the server does not sign fails the export too', async () => {
    const dest = destination();
    const lib = api({songs: [SONG], urls: {}});
    await expect(exportLibrary(() => {}, {api: lib, window: {showSaveFilePicker: async () => dest.handle}})).rejects.toThrow(/Couldn’t download the audio for Practice/);
    expect(lib.fetch).not.toHaveBeenCalled();
    expect(dest.writable.abort).toHaveBeenCalledOnce();
  });

  test('exported notation is always current, including version 1 parts and mixed rows', async () => {
    const dest = destination();
    const base = emptyScore(20), [first, second] = base.timeline.measures;
    const v1 = (id, instrument, offset = fraction(0)) => ({id, offset, duration: durationOf(4), instrument, voice: 1, value: 4, dotted: false, tuplet: 1, accent: true, ghost: false, flam: false, sticking: 'R', velocity: .9});
    const legacy = {measureId: first.id, coverage: 'reviewed', hits: [v1('snare', 'snare'), v1('rest', 'rest', fraction(1))]};
    const current = {measureId: second.id, coverage: 'progress', hits: [{id: 'kick', offset: fraction(1, 3), instrument: 'kick', voice: 2, accent: false, ghost: false, flam: false, sticking: '', velocity: .75, roll: 1}]};
    const lib = api({
      songs: [{id: 'old', title: 'Old', artist: 'Band', duration: 20, stems: []}, {id: 'mixed', title: 'Mixed', duration: 20, stems: []}],
      notation: {
        old: {score: {version: 1, title: 'Old drums', timeline: base.timeline, bars: [legacy]}, revision: 3},
        mixed: {score: {version: 2, title: 'Mixed drums', layout: 'split', timeline: base.timeline, bars: [legacy, current]}, revision: 4},
      },
    });
    await exportLibrary(() => {}, {api: lib, window: {showSaveFilePicker: async () => dest.handle}});
    const archive = dest.read(), read = name => JSON.parse(strFromU8(archive[name]));
    const upgraded = {measureId: first.id, coverage: 'reviewed', hits: [{id: 'snare', offset: fraction(0), instrument: 'snare', voice: 1, accent: true, ghost: false, flam: false, sticking: 'R', velocity: .9}]};
    expect(read('Old-old/drums.woodshed.json')).toEqual({format: 'woodshed-notation', version: 2, song: {title: 'Old', artist: 'Band', duration: 20}, score: {version: 2, title: 'Old drums', timeline: base.timeline, bars: [upgraded]}});
    expect(read('Mixed-mixed/drums.woodshed.json').score).toEqual({version: 2, title: 'Mixed drums', layout: 'split', timeline: base.timeline, bars: [upgraded, current]});
  });

  test('without a save picker: a library over 100 MB is refused before anything is written', async () => {
    const lib = api({songs: [{...SONG, stems: [{name: 'drums', key: 'k', bytes: FALLBACK_LIMIT + 1}]}]});
    const doc = {createElement: vi.fn()};
    await expect(exportLibrary(() => {}, {api: lib, window: {document: doc}})).rejects.toThrow(EXPORT_COPY.tooLarge);
    expect(lib.signKeys).not.toHaveBeenCalled();
    expect(doc.createElement).not.toHaveBeenCalled();
  });

  test('without a save picker: a small library downloads from memory', async () => {
    const lib = api({songs: [SONG]});
    const click = vi.fn();
    const a = {click};
    const doc = {createElement: vi.fn(() => a)};
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:zip');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.useFakeTimers({toFake: ['setTimeout']});
    try {
      const result = await exportLibrary(() => {}, {api: lib, window: {document: doc}});
      expect(result.songs).toBe(1);
      expect(doc.createElement).toHaveBeenCalledWith('a');
      expect(a).toMatchObject({href: 'blob:zip', download: ARCHIVE_NAME});
      expect(click).toHaveBeenCalledOnce();
      const blob = created.mock.calls[0][0];
      const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
      expect(Object.keys(archive)).toContain('setlists.json');
      vi.runAllTimers();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:zip');
    } finally {
      vi.useRealTimers();
    }
  });

  test('an abort stops the export and aborts the destination', async () => {
    const dest = destination();
    const controller = new AbortController();
    const lib = api({songs: [SONG, {...SONG, id: 'song2', title: 'Second'}]});
    lib.notation.mockImplementation(async songId => { if (songId === 'song2') controller.abort(); return null; });
    await expect(exportLibrary(() => {}, {api: lib, signal: controller.signal, window: {showSaveFilePicker: async () => dest.handle}})).rejects.toMatchObject({name: 'AbortError'});
    expect(dest.writable.abort).toHaveBeenCalledOnce();
    expect(dest.writable.close).not.toHaveBeenCalled();
    expect(lib.signKeys).toHaveBeenCalledTimes(1);
  });

  test('Cancel settles at once while a download stalls mid-body: the body is cancelled and the destination aborted', async () => {
    const dest = destination();
    const controller = new AbortController();
    const lib = api({songs: [SONG]});
    let cancelled = null, fetchSignal = null;
    lib.fetch.mockImplementation(async (url, {signal} = {}) => {
      fetchSignal = signal;
      let sent = false;
      return new Response(new ReadableStream({
        pull(c) { if (!sent) { sent = true; c.enqueue(new Uint8Array([1, 2])); return undefined; } return new Promise(() => {}); },
        cancel(reason) { cancelled = reason ?? true; },
      }));
    });
    const running = exportLibrary(() => {}, {api: lib, signal: controller.signal, window: {showSaveFilePicker: async () => dest.handle}});
    await vi.waitFor(() => expect(lib.fetch).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 20));
    controller.abort();
    await expect(running).rejects.toMatchObject({name: 'AbortError'});
    expect(fetchSignal).toBe(controller.signal);
    expect(cancelled).toBeTruthy();
    expect(dest.writable.abort).toHaveBeenCalledOnce();
    expect(dest.writable.close).not.toHaveBeenCalled();
  });

  test.each([
    ['songs.exportPage', lib => lib.exportPage],
    ['notation', lib => lib.notation],
    ['signKeys', lib => lib.signKeys],
    ['the audio fetch (before headers)', lib => lib.fetch],
  ])('Cancel settles at once while %s never answers', async (_, pick) => {
    const dest = destination();
    const controller = new AbortController();
    const lib = api({songs: [SONG]});
    const stalled = pick(lib);
    stalled.mockImplementation(() => new Promise(() => {}));
    const running = exportLibrary(() => {}, {api: lib, signal: controller.signal, window: {showSaveFilePicker: async () => dest.handle}});
    await vi.waitFor(() => expect(stalled).toHaveBeenCalled());
    controller.abort();
    await expect(running).rejects.toMatchObject({name: 'AbortError'});
    expect(dest.writable.close).not.toHaveBeenCalled();
  });

  test('DEFAULT_API.fetch passes the abort signal (and the desktop media URL) to fetch', async () => {
    const seen = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => { seen.push([url, init?.signal]); return new Response('x'); });
    const controller = new AbortController();
    await DEFAULT_API.fetch('https://r2.test/a.webm', {signal: controller.signal});
    expect(seen[0]).toEqual(['https://r2.test/a.webm', controller.signal]);
    const before = globalThis.window.woodshedDesktop;
    globalThis.window.woodshedDesktop = {mediaUrl: async url => `http://127.0.0.1:1/media?u=${encodeURIComponent(url)}`};
    try {
      await DEFAULT_API.fetch('https://r2.test/b.webm', {signal: controller.signal});
    } finally {
      globalThis.window.woodshedDesktop = before;
    }
    expect(seen[1]).toEqual([`http://127.0.0.1:1/media?u=${encodeURIComponent('https://r2.test/b.webm')}`, controller.signal]);
  });

  test('a cancelled save picker rejects with its AbortError and reads nothing', async () => {
    const lib = api({songs: [SONG]});
    const picker = vi.fn(async () => { throw new DOMException('The user aborted a request.', 'AbortError'); });
    await expect(exportLibrary(() => {}, {api: lib, window: {showSaveFilePicker: picker}})).rejects.toMatchObject({name: 'AbortError'});
    expect(lib.exportPage).not.toHaveBeenCalled();
  });

  test('a progress listener that throws does not break the export', async () => {
    const dest = destination();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await exportLibrary(() => { throw new Error('listener'); }, {api: api({songs: [SONG]}), window: {showSaveFilePicker: async () => dest.handle}});
    expect(result.songs).toBe(1);
  });

  test('DEFAULT_API reaches the server only through src/api', () => {
    expect(Object.keys(DEFAULT_API).sort()).toEqual(['config', 'exportPage', 'fetch', 'notation', 'setlists', 'signKeys']);
  });
});

describe('export helpers', () => {
  test('safeName, songFolder, libraryBytes', () => {
    expect(safeName('AC/DC: Live?')).toBe('AC_DC_ Live_');
    expect(safeName('')).toBe('song');
    expect(safeName('x'.repeat(150))).toHaveLength(100);
    expect(songFolder({id: 'k1', title: 'Night Bus'})).toBe('Night Bus-k1');
    expect(libraryBytes([{stems: [{bytes: 5}, {bytes: 7}]}, {stems: [{bytes: -1}, {}]}, {}])).toBe(12);
  });

  test('setlistsDocument keeps id, name, order and times', () => {
    expect(setlistsDocument([{id: 'a', name: 'A', count: 2, songIds: ['x', 'y']}])).toEqual({version: 1, setlists: [{id: 'a', name: 'A', songIds: ['x', 'y'], updatedAt: null, lastOpenedAt: null}]});
    expect(setlistsDocument(null)).toEqual({version: 1, setlists: []});
  });

  test('notationDocument is null without a chart', () => {
    expect(notationDocument({title: 'x'}, null)).toBeNull();
    expect(notationDocument({title: 'x'}, {score: null})).toBeNull();
  });
});
