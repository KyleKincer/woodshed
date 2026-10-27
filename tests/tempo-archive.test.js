// @vitest-environment node
import {expect, test} from 'vitest';
import {zipSync, strToU8} from 'fflate';
import {importTempoArchive, extractZipChart, applyChartMetadata, MAX_TEMPO_ARCHIVE_BYTES} from '../src/js/tempo-archive.js';
import {parseTempoFile, importTempoFile, MAX_TEMPO_FILE_BYTES} from '../src/js/tempo-import.js';
import {compile, timeAt} from '../shared/song-map.ts';

const chart = strToU8('[Song]\n{\nResolution = 192\nOffset = 0\n}\n[SyncTrack]\n{\n0 = B 120000\n768 = B 100000\n}\n[ExpertDrums]\n{\n0 = N 0 0\n96 = N 1 0\n192 = N 2 0\n192 = N 66 0\n}');
const file = (bytes, name = 'song.zip', reads = []) => ({name, size: bytes.length, slice(start, end) { reads.push([start, end]); return new Blob([bytes.slice(start, end)]); }});
const zip = (files, options = {}) => zipSync(files, options);
const at = (result, q) => timeAt(compile(result.map), q);
const signatureAt = (bytes, signature) => { for (let i = 0; i + 4 <= bytes.length; i++) if (new DataView(bytes.buffer, bytes.byteOffset + i, 4).getUint32(0, true) === signature) return i; throw Error('fixture signature absent'); };
const set32 = (bytes, offset, value) => new DataView(bytes.buffer, bytes.byteOffset).setUint32(offset, value, true);

test('imports a nested Chorus ZIP, applies song.ini delay and keeps drum notes', async () => {
  const archive = zip({'Artist - Song/notes.chart': chart, 'Artist - Song/song.ini': strToU8('[Song]\ndelay = 125\n'), 'Artist - Song/song.opus': new Uint8Array(4096)});
  const result = await importTempoArchive(file(archive), {duration: 10});
  expect(result.format).toBe('chart'); expect(result.drums.hits).toHaveLength(3);
  expect(at(result, 0)).toBeCloseTo(.125); expect(at(result, 4)).toBeCloseTo(2.125);
  expect(result.warnings.join(' ')).toContain('0.125 s audio delay');
});

test('the ordinary file picker import routes ZIP packages through the archive reader', async () => {
  const archive = new File([zip({'notes.chart':chart})], 'Chorus song.ZIP');
  const result = await importTempoFile(archive, {duration:10});
  expect(result.format).toBe('chart'); expect(result.drums.hits).toHaveLength(3);
});

test('reads a large local ZIP selectively and never inflates its audio entries', async () => {
  const archive = zip({'song.opus': [new Uint8Array(512 * 1024), {level: 0}], 'notes.chart': chart, 'song.ini': strToU8('[song]\n')});
  const reads = [], result = await extractZipChart(file(archive, 'song.zip', reads));
  expect(result.bytes).toEqual(chart);
  expect(reads.reduce((sum, [a, b]) => sum + b - a, 0)).toBeLessThan(70000);
  expect(reads.every(([a, b]) => b - a < 66000)).toBe(true);
});

test('prefers notes.chart when a single song also contains notes.mid and accepts case-insensitive names', async () => {
  const result = await extractZipChart(file(zip({'Folder/NOTES.CHART': chart, 'Folder/notes.mid': strToU8('unused MIDI'), 'Folder/SONG.INI': strToU8('[Song]\nDelay=-50')})));
  expect(result.name).toBe('notes.chart'); expect(result.bytes).toEqual(chart); expect(result.metadata.delay).toBe('-50');
});

test('rejects multi-song packages, missing charts, unsafe paths and encrypted chart entries', async () => {
  await expect(extractZipChart(file(zip({'A/notes.chart': chart, 'B/notes.chart': chart})))).rejects.toThrow('multiple songs');
  await expect(extractZipChart(file(zip({'song.opus': new Uint8Array(5)})))).rejects.toThrow('no notes');
  await expect(extractZipChart(file(zip({'../notes.chart': chart})))).rejects.toThrow('unsafe');
  const encrypted = zip({'notes.chart': chart}); encrypted[signatureAt(encrypted, 0x02014b50) + 8] |= 1;
  await expect(extractZipChart(file(encrypted))).rejects.toThrow('encrypted');
});

test('rejects oversized selections and a deflate bomb with a dishonest declared size', async () => {
  const oversized = zip({'notes.chart': chart}); set32(oversized, signatureAt(oversized, 0x02014b50) + 24, MAX_TEMPO_FILE_BYTES + 1);
  await expect(extractZipChart(file(oversized))).rejects.toThrow('too large');
  const bomb = zip({'notes.chart': new Uint8Array(2 * 1024 * 1024)}); set32(bomb, signatureAt(bomb, 0x02014b50) + 24, 16);
  await expect(extractZipChart(file(bomb))).rejects.toThrow('exceeds its declared size');
  await expect(importTempoArchive({name:'huge.zip', size:MAX_TEMPO_ARCHIVE_BYTES + 1, slice(){throw Error('must not read');}})).rejects.toThrow('128 MiB');
});

test('rejects malformed, truncated, ZIP64 and corrupted local data', async () => {
  await expect(extractZipChart(file(new Uint8Array(64)))).rejects.toThrow('ZIP directory');
  const archive = zip({'notes.chart': [chart, {level: 0}]});
  const corrupt = archive.slice(); corrupt[30 + strToU8('notes.chart').length + 3] ^= 1;
  await expect(extractZipChart(file(corrupt))).rejects.toThrow('checksum');
  const zip64 = archive.slice(); set32(zip64, zip64.length - 22 + 12, 0xffffffff);
  await expect(extractZipChart(file(zip64))).rejects.toThrow('ZIP64');
  await expect(extractZipChart(file(archive.subarray(0, archive.length - 1)))).rejects.toThrow('ZIP directory');
});

test('applies only song.ini delay, without mutating the original map or doubling chart offset metadata', () => {
  const original = parseTempoFile(chart, {name:'notes.chart', duration:10});
  const before = structuredClone(original.map);
  const result = applyChartMetadata(original, {delay:'250', chart_offset:'4.5'});
  expect(at(result, 0)).toBe(.25); expect(original.map).toEqual(before);
  expect(()=>applyChartMetadata(original, {delay:'not a number'})).toThrow('invalid audio delay');
});

test('reads an SNG with File.slice, preserving source timing without reading audio', async () => {
  const join = (...parts) => { const bytes = new Uint8Array(parts.reduce((n,p)=>n+p.length,0)); let at=0; for(const p of parts){bytes.set(p,at);at+=p.length;}return bytes; };
  const uint32 = n => {const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n,true);return b;};
  const uint64 = n => join(uint32(n), uint32(0));
  const string = value => join(uint32(strToU8(value).length), strToU8(value));
  const metadata = join(uint64(1), string('delay'), string('25'));
  const mask = Uint8Array.from({length:16},(_,i)=>i+1), audioLength = 100000;
  const name = strToU8('notes.chart'), audioName = strToU8('song.opus');
  const indexLength = 8 + 1 + audioName.length + 16 + 1 + name.length + 16;
  const dataStart = 34 + metadata.length + 8 + indexLength + 8, chartStart = dataStart + audioLength;
  const index = join(uint64(2), new Uint8Array([audioName.length]), audioName, uint64(audioLength), uint64(dataStart), new Uint8Array([name.length]), name, uint64(chart.length), uint64(chartStart));
  const prefix = join(strToU8('SNGPKG'), uint32(1), mask, uint64(metadata.length), metadata, uint64(index.length), index, uint64(audioLength + chart.length));
  const masked = chart.map((b,i)=>b ^ mask[i%16] ^ (i&255));
  const bytes = join(prefix, new Uint8Array(audioLength), masked), reads = [];
  const result = await importTempoArchive(file(bytes, 'song.sng', reads), {duration:10});
  expect(at(result, 0)).toBeCloseTo(.025); expect(result.drums.hits).toHaveLength(3);
  expect(reads).toHaveLength(4); expect(reads.every(([a,b])=>b <= dataStart || a >= chartStart)).toBe(true);
});
