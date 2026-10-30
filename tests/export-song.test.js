// @vitest-environment happy-dom
// src/export/export-song.js and export-dialog.js on a fake session: the options a song offers, the archive's
// files (WAVs padded to the shared timeline, the backing track, MIDI, Guitar Pro, README), the save picker
// opening before any wait, the in-memory fallback, Cancel, and the dialog's choices.
import {afterEach, describe, expect, test, vi} from 'vitest';
import {unzipSync, strFromU8} from 'fflate';
import {defaultSongMap, fromTimeline} from '../shared/song-map.ts';
import {alignment} from '../src/export/song-files.js';
import {COPY, estimateBytes, exportOptions, exportSong} from '../src/export/export-song.js';
import {COPY as DIALOG_COPY, openExportDialog} from '../src/export/export-dialog.js';
import {demoScore} from './fixtures/drum-score.js';

const sig = value => ({peek: () => value, value, subscribe: () => () => {}});
function buffer(seconds, rate = 8000, channels = 2, value = 0.25) {
  const data = Array.from({length: channels}, () => new Float32Array(Math.round(seconds * rate)).fill(value));
  return {sampleRate: rate, length: data[0].length, numberOfChannels: channels, duration: seconds, getChannelData: c => data[c]};
}
function session({mapped = true, chart = true, firstDownbeat = 0.7, mine = ['drums'], phase = 'ready'} = {}) {
  const score = chart ? demoScore(16, 120) : null;
  const map = chart ? fromTimeline(score.timeline, 16) : defaultSongMap(16, 120, 4, 4, firstDownbeat);
  return {
    song: sig({title: 'Glass/house', artist: 'Northbound', stems: [{name: 'drums', key: 'u/s/drums.webm'}, {name: 'bass', key: 'u/s/bass.webm'}, {name: 'other', key: 'u/s/other.webm'}]}),
    engine: {tracks: [
      {name: 'drums', buffer: buffer(16, 8000, 2, 0.5)}, {name: 'bass', buffer: buffer(16, 8000, 1, 0.25)}, {name: 'other', buffer: buffer(16, 8000, 2, 0.25)},
    ]},
    map: {isReal: mapped, serialize: () => structuredClone(map)},
    load: sig({phase}),
    notation: {hasNotation: sig(!!chart), contents: vi.fn(async () => ({has: !!chart})), part: chart ? {score} : null},
    transport: {snapshot: sig({mix: {mine}})},
  };
}
function picker() {
  const chunks = [];
  const writable = {write: vi.fn(async c => { chunks.push(c); }), close: vi.fn(async () => {}), abort: vi.fn(async () => {})};
  const handle = {createWritable: vi.fn(async () => writable)};
  const read = () => {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return unzipSync(out);
  };
  return {win: {showSaveFilePicker: vi.fn(async () => handle), document}, writable, handle, read};
}
const ALL = {stems: ['drums', 'bass', 'other'], format: 'wav', backing: true, tempoMap: true, drumMidi: true, guitarPro: true};

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('exportOptions', () => {
  test('stems, my part, the backing track and what the map and chart allow', () => {
    const o = exportOptions(session());
    expect(o).toMatchObject({title: 'Glass/house', artist: 'Northbound', base: 'Northbound - Glass_house', sampleRate: 8000,
      mine: ['drums'], backingName: 'Backing track (no drums).wav', canBacking: true, mapped: true, hasChart: true, loaded: true});
    expect(o.stems).toEqual([{name: 'drums', channels: 2, mine: true}, {name: 'bass', channels: 1, mine: false}, {name: 'other', channels: 2, mine: false}]);
    const bare = exportOptions(session({mapped: false, chart: false, mine: []}));
    expect(bare).toMatchObject({mapped: false, hasChart: false, canBacking: false, backingName: null, padSeconds: 0});
  });

  test('the estimate counts every WAV with its padding', () => {
    const s = session({chart: false});
    const o = exportOptions(s);
    expect(o.padSeconds).toBeCloseTo(1.3, 6);
    const frames = 16 * 8000 + Math.round(1.3 * 8000);
    expect(estimateBytes(o, {stems: ['drums'], format: 'wav'})).toBe(4096 + 44 + frames * 2 * 2);
    expect(estimateBytes(o, {stems: ['drums'], format: 'original'})).toBeLessThan(estimateBytes(o, {stems: ['drums'], format: 'wav'}));
  });
});

describe('exportSong', () => {
  test('the archive: padded WAVs, the backing track, both MIDI files, the Guitar Pro chart and the README', async () => {
    const s = session({chart: false});
    const p = picker();
    const progress = [];
    const result = await exportSong(s, {...ALL, guitarPro: false, drumMidi: false}, {window: p.win, onProgress: t => progress.push(t)});
    expect(p.win.showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({suggestedName: 'Northbound - Glass_house.zip'}));
    expect(result.name).toBe('Northbound - Glass_house.zip');
    const files = p.read();
    const base = 'Northbound - Glass_house/';
    expect(Object.keys(files).sort()).toEqual([
      'Backing track (no drums).wav', 'README.txt', 'Stems/bass.wav', 'Stems/drums.wav', 'Stems/other.wav', 'Tempo map.mid',
    ].map(n => base + n).sort());
    const pad = Math.round(alignment(s.map.serialize(), 16).padSeconds * 8000);
    const drums = files[`${base}Stems/drums.wav`];
    const view = new DataView(drums.buffer, drums.byteOffset);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(40, true)).toBe((16 * 8000 + pad) * 4);
    expect(view.getInt16(44, true)).toBe(0);                                   // the padding
    expect(view.getInt16(44 + pad * 4, true)).toBe(Math.round(0.5 * 0x7fff));  // the recording starts after it
    expect(new DataView(files[`${base}Stems/bass.wav`].buffer, files[`${base}Stems/bass.wav`].byteOffset).getUint16(22, true)).toBe(1);
    const backing = files[`${base}Backing track (no drums).wav`];
    expect(new DataView(backing.buffer, backing.byteOffset).getInt16(44 + pad * 4, true)).toBe(Math.round(0.5 * 0x7fff)); // bass + other
    expect(strFromU8(files[`${base}README.txt`])).toContain('so the song\'s bar 1 is bar 2 in your DAW');
    expect(progress).toContain(COPY.stem('drums.wav', 1, 5));
    expect(p.writable.close).toHaveBeenCalled();
  });

  test('a chart adds Drum chart.mid and Drum chart.gp', async () => {
    const p = picker();
    await exportSong(session(), {stems: [], format: 'wav', backing: false, tempoMap: false, drumMidi: true, guitarPro: true}, {window: p.win});
    const names = Object.keys(p.read()).map(n => n.split('/').slice(1).join('/')).sort();
    expect(names).toEqual(['Drum chart.gp', 'Drum chart.mid', 'README.txt']);
  });

  test('the save picker opens before any wait; nothing to export or audio still loading refuse before it opens', async () => {
    const p = picker();
    const run = exportSong(session(), ALL, {window: p.win});
    expect(p.win.showSaveFilePicker).toHaveBeenCalledTimes(1);
    await run;
    const q = picker();
    await expect(exportSong(session(), {stems: [], format: 'wav'}, {window: q.win})).rejects.toThrow(COPY.nothing);
    await expect(exportSong(session({phase: 'loading'}), ALL, {window: q.win})).rejects.toThrow(COPY.notLoaded);
    expect(q.win.showSaveFilePicker).not.toHaveBeenCalled();
  });

  test('without a picker the archive downloads from memory', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const result = await exportSong(session(), {stems: ['bass'], format: 'wav'}, {window: {document}});
    expect(click).toHaveBeenCalled();
    expect(result.bytes).toBeGreaterThan(16 * 8000 * 2);
  });

  test('Original files stream the stored stems, unpadded', async () => {
    const p = picker();
    const api = {signKeys: vi.fn(async keys => Object.fromEntries(keys.map(k => [k, `https://r2/${k}`]))),
      fetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))};
    await exportSong(session({chart: false}), {stems: ['drums', 'bass'], format: 'original', tempoMap: true}, {window: p.win, api});
    const files = p.read();
    expect([...files['Northbound - Glass_house/Stems/drums.webm']]).toEqual([1, 2, 3]);
    expect(strFromU8(files['Northbound - Glass_house/README.txt'])).toContain('The original stems are not padded');
  });

  test('Cancel aborts the writer and reports AbortError', async () => {
    const p = picker();
    const controller = new AbortController();
    const run = exportSong(session(), ALL, {window: p.win, signal: controller.signal, onProgress: () => controller.abort()});
    await expect(run).rejects.toMatchObject({name: 'AbortError'});
    expect(p.writable.abort).toHaveBeenCalled();
    expect(p.writable.close).not.toHaveBeenCalled();
  });
});

describe('the Export dialog', () => {
  const box = label => [...document.querySelectorAll('.export-check')].find(l => l.querySelector('.export-check-label').textContent === label)?.querySelector('input');

  test('offers every stem, the format, the backing track and the files the song can make', async () => {
    const closed = openExportDialog({session: session({chart: false})}, {exportSong: vi.fn()});
    await Promise.resolve();
    expect(document.querySelector('.ui-dialog-title, h2')?.textContent).toContain('Export Glass/house');
    for (const name of ['drums', 'bass', 'other']) expect(box(name).checked).toBe(true);
    expect(box('WAV').checked).toBe(true);
    expect(box('Backing track (no drums)').checked).toBe(true);
    expect(box(DIALOG_COPY.tempoMap).disabled).toBe(false);
    expect(box(DIALOG_COPY.drumMidi).disabled).toBe(true);
    expect(box(DIALOG_COPY.guitarPro).disabled).toBe(true);
    expect(document.body.textContent).toContain(DIALOG_COPY.needsChart);
    expect(document.querySelector('.export-size').textContent).toMatch(/^About \d+ MB$|^About under 1 MB$/);
    document.querySelector('dialog .ui-dialog-action')?.click();
    await closed;
  });

  test('Export runs with the chosen files and says where it saved; nothing chosen disables Export', async () => {
    const exportSong = vi.fn(async () => ({name: 'Northbound - Glass_house.zip', bytes: 10}));
    const closed = openExportDialog({session: session()}, {exportSong, feedback: {announce: vi.fn()}});
    await Promise.resolve();
    box('bass').click();
    box('Backing track (no drums)').click();
    document.querySelector('.export-go').click();
    expect(exportSong).toHaveBeenCalledWith(expect.anything(), {stems: ['drums', 'other'], format: 'wav', backing: false,
      tempoMap: true, drumMidi: true, guitarPro: true}, expect.objectContaining({signal: expect.any(AbortSignal)}));
    await vi.waitFor(() => expect(document.querySelector('.export-status').textContent).toContain('Saved Northbound - Glass_house.zip.'));
    for (const label of ['drums', 'other', DIALOG_COPY.tempoMap, DIALOG_COPY.drumMidi, DIALOG_COPY.guitarPro]) box(label).click();
    expect(document.querySelector('.export-go').getAttribute('aria-disabled') === 'true' || document.querySelector('.export-go').disabled).toBe(true);
    document.querySelector('dialog .ui-dialog-action')?.click();
    await closed;
  });

  test('a failure stays in the dialog; closing it cancels a running export', async () => {
    let signal;
    const exportSong = vi.fn((s, c, o) => { signal = o.signal; return new Promise(() => {}); });
    const closed = openExportDialog({session: session()}, {exportSong});
    await Promise.resolve();
    document.querySelector('.export-go').click();
    expect(document.querySelector('.export-cancel').hidden).toBe(false);
    document.querySelector('dialog .ui-dialog-action')?.click();
    await closed;
    expect(signal.aborted).toBe(true);
    const failing = openExportDialog({session: session()}, {exportSong: vi.fn(async () => { throw new Error('Disk full.'); })});
    await Promise.resolve();
    document.querySelector('.export-go').click();
    await vi.waitFor(() => expect(document.querySelector('.export-status').textContent).toContain('Disk full.'));
    document.querySelector('dialog .ui-dialog-action')?.click();
    await failing;
  });
});
