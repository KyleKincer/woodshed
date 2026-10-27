// Read only chart data from a local song package. Audio is neither decoded nor uploaded.
import {Inflate} from 'fflate';
import {extractSngChartFromReader} from '../../shared/sng.ts';
import {parseTempoFile, offsetTempoMap, MAX_TEMPO_FILE_BYTES} from './tempo-import.js';

export const MAX_TEMPO_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 1024 * 1024;
const MAX_INI_BYTES = 64 * 1024;
const invalid = detail => { throw new Error(`Could not read this ZIP song package: ${detail}.`); };
const decoder = new TextDecoder('utf-8', {fatal: true});
const u16 = (bytes, at) => bytes[at] + bytes[at + 1] * 256;
const u32 = (bytes, at) => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536 + bytes[at + 3] * 16777216;
const text = bytes => { try { return decoder.decode(bytes); } catch { return invalid('invalid UTF-8 chart text'); } };

function checkedFile(file) {
  if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size) || file.size <= 0)
    throw new Error('Choose a Chorus Encore .sng or .zip song package.');
  if (file.size > MAX_TEMPO_ARCHIVE_BYTES) throw new Error('Choose a song package smaller than 128 MiB, or extract and import its notes.chart or notes.mid file.');
}
async function read(file, start, length) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > file.size) invalid('a file entry is outside the archive');
  const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
  if (bytes.length !== length) invalid('the package is incomplete');
  return bytes;
}
function safePath(name) {
  const path = name.replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /[\x00-\x1f\x7f:]/.test(path) || path.split('/').some(part => part === '..')) invalid('unsafe chart filename');
  return path.split('/').filter(part => part && part !== '.').join('/');
}
function filename(bytes, flags) {
  if (flags & 0x800) return text(bytes);
  // Legacy ZIP filenames can use CP437. Basenames are ASCII; retaining each
  // byte distinctly preserves folder identity without guessing Unicode names.
  return Array.from(bytes, byte => String.fromCharCode(byte)).join('');
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let crc = i; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); crcTable[i] = crc >>> 0; }
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]; return (crc ^ 0xffffffff) >>> 0; }

/** song.ini delay is in milliseconds. .chart Offset is already read by its parser. */
export function applyChartMetadata(result, metadata = {}) {
  const raw = metadata.delay;
  if (raw === undefined || raw === '') return {...result, warnings: [...(result.warnings || [])]};
  const milliseconds = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 86400000) throw new Error('The song package contains an invalid audio delay. Import its notes file to align the map manually.');
  if (!milliseconds) return {...result, warnings: [...(result.warnings || [])]};
  return {...result, map: offsetTempoMap(result.map, milliseconds / 1000),
    warnings: [...(result.warnings || []), `The package's ${(milliseconds / 1000).toFixed(3)} s audio delay is included. Check alignment against your recording.`]};
}

function parseSongIni(value) {
  const metadata = {}; let section = '';
  for (const raw of value.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || /^[;#]/.test(line)) continue;
    if (/^\[.*\]$/.test(line)) { section = line.slice(1, -1).trim().toLowerCase(); continue; }
    if (section !== 'song') continue;
    const match = /^([^=]+)=(.*)$/.exec(line); if (!match) continue;
    const key = match[1].trim().toLowerCase();
    if (['delay', 'chart_offset', 'pro_drums', 'five_lane_drums'].includes(key)) metadata[key] = match[2].trim();
  }
  return metadata;
}

/** Parse the central directory first, then read/inflate only notes and song.ini. */
export async function extractZipChart(file) {
  checkedFile(file);
  const tailStart = Math.max(0, file.size - 65557), tail = await read(file, tailStart, file.size - tailStart);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50 && i + 22 + u16(tail, i + 20) === tail.length) { end = i; break; }
  }
  if (end < 0) invalid('missing ZIP directory');
  const count = u16(tail, end + 10), size = u32(tail, end + 12), start = u32(tail, end + 16);
  if (u16(tail, end + 4) || u16(tail, end + 6) || u16(tail, end + 8) !== count) invalid('multi-volume ZIP files are not supported');
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) invalid('ZIP64 packages are not supported; extract the notes file first');
  if (!count) throw new Error('This ZIP contains no notes.chart or notes.mid file. Choose a single-song chart download.');
  if (count > 4096 || size > MAX_DIRECTORY_BYTES || start + size > tailStart + end) invalid('the ZIP directory is too large or out of bounds');
  const directory = await read(file, start, size), entries = []; let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > directory.length || u32(directory, p) !== 0x02014b50) invalid('malformed ZIP directory');
    const flags = u16(directory, p + 8), method = u16(directory, p + 10), crc = u32(directory, p + 16);
    const compressed = u32(directory, p + 20), original = u32(directory, p + 24), length = u16(directory, p + 28), extra = u16(directory, p + 30), comment = u16(directory, p + 32), offset = u32(directory, p + 42);
    const next = p + 46 + length + extra + comment;
    if (next > directory.length || u16(directory, p + 34)) invalid('truncated or multi-volume ZIP entry');
    const name = filename(directory.subarray(p + 46, p + 46 + length), flags);
    const basename = name.replace(/\\/g, '/').split('/').at(-1).toLowerCase();
    if (['notes.chart', 'notes.mid', 'notes.midi', 'song.ini'].includes(basename)) {
      const path = safePath(name), folder = path.slice(0, path.lastIndexOf('/') + 1);
      if (flags & 1) invalid('encrypted chart files are not supported');
      if (![0, 8].includes(method)) invalid('the chart uses an unsupported compression method');
      if (compressed === 0xffffffff || original === 0xffffffff || offset === 0xffffffff) invalid('ZIP64 chart files are not supported');
      entries.push({path, basename, folder, flags, method, crc, compressed, original, offset});
    }
    p = next;
  }
  if (p !== directory.length) invalid('extra ZIP directory data');
  const charts = entries.filter(entry => entry.basename !== 'song.ini');
  if (!charts.length) throw new Error('This ZIP contains no notes.chart or notes.mid file. Choose a single-song chart download.');
  const folders = new Set(charts.map(entry => entry.folder.toLowerCase()));
  if (folders.size > 1) throw new Error('This ZIP contains multiple songs. Choose a single-song package, or extract it and import one notes.chart or notes.mid file.');
  const preferred = charts.filter(entry => entry.basename === 'notes.chart');
  const choices = preferred.length ? preferred : charts;
  if (choices.length !== 1) throw new Error('This ZIP contains multiple chart files. Extract it and choose the notes file you want to import.');
  async function extract(entry, maximum) {
    if (entry.original > maximum || entry.compressed > MAX_TEMPO_FILE_BYTES) invalid('the selected chart or metadata file is too large');
    const local = await read(file, entry.offset, 30);
    if (u32(local, 0) !== 0x04034b50 || u16(local, 6) !== entry.flags || u16(local, 8) !== entry.method) invalid('the local file header disagrees with the directory');
    const nameLength = u16(local, 26), extraLength = u16(local, 28);
    const localName = filename(await read(file, entry.offset + 30, nameLength), entry.flags);
    if (safePath(localName) !== entry.path) invalid('the chart filename changed inside the package');
    const dataStart = entry.offset + 30 + nameLength + extraLength;
    if (dataStart + entry.compressed > start) invalid('the chart overlaps the ZIP directory');
    const compressed = await read(file, dataStart, entry.compressed);
    let bytes;
    if (entry.method === 0) {
      if (compressed.length !== entry.original) invalid('the chart length is inconsistent');
      bytes = compressed;
    } else {
      const parts = []; let received = 0;
      // Small compressed chunks bound the size of any one inflate allocation,
      // including a deflate bomb with a dishonest uncompressed-size header.
      const stream = new Inflate((chunk) => {
        received += chunk.length;
        if (received > entry.original || received > maximum) invalid('the chart exceeds its declared size');
        parts.push(chunk);
      });
      for (let i = 0; i < compressed.length; i += 512) stream.push(compressed.subarray(i, i + 512), i + 512 >= compressed.length);
      if (received !== entry.original) invalid('the decompressed chart is incomplete');
      bytes = new Uint8Array(received); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
    }
    if (crc32(bytes) !== entry.crc) invalid('the chart checksum does not match');
    return bytes;
  }
  const chosen = choices[0], ini = entries.filter(entry => entry.basename === 'song.ini' && entry.folder.toLowerCase() === chosen.folder.toLowerCase());
  if (ini.length > 1) invalid('duplicate song.ini files');
  const metadata = ini.length ? parseSongIni(text(await extract(ini[0], MAX_INI_BYTES))) : {};
  return {name: chosen.basename, bytes: await extract(chosen, MAX_TEMPO_FILE_BYTES), metadata};
}

export async function importTempoArchive(file, options = {}) {
  checkedFile(file);
  const extension = String(file.name || '').split('.').at(-1).toLowerCase();
  const extracted = extension === 'sng'
    ? await extractSngChartFromReader((start, end) => read(file, start, end - start), file.size, {maxChartBytes: MAX_TEMPO_FILE_BYTES})
    : extension === 'zip' ? await extractZipChart(file) : null;
  if (!extracted) throw new Error('Choose a Chorus Encore .sng or .zip package.');
  return applyChartMetadata(parseTempoFile(extracted.bytes, {...options, name: extracted.name}), extracted.metadata);
}
