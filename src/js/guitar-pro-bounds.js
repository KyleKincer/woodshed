// Bound Guitar Pro containers before handing score data to the third-party
// reader. GPX uses a sector filesystem; GP7/8 uses ZIP. Neither is extracted to
// disk, and no backing-track audio is played or uploaded.
import {Inflate} from 'fflate';

export const MAX_GP_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 128;
const invalid = detail => { throw new Error(`Could not read this Guitar Pro file: ${detail}.`); };
const u16 = (b, p) => b[p] + b[p + 1] * 256;
const u32 = (b, p) => b[p] + b[p + 1] * 256 + b[p + 2] * 65536 + b[p + 3] * 16777216;
const tag = b => String.fromCharCode(...b.subarray(0, 4));
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); crcTable[i] = c >>> 0; }
function crcStep(crc, bytes) { for (const b of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 255]; return crc; }

function checkZip(bytes) {
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (u32(bytes, p) === 0x06054b50 && p + 22 + u16(bytes, p + 20) === bytes.length) { end = p; break; }
  }
  if (end < 0) invalid('missing ZIP directory');
  const count = u16(bytes, end + 10), size = u32(bytes, end + 12), start = u32(bytes, end + 16);
  if (u16(bytes, end + 4) || u16(bytes, end + 6) || u16(bytes, end + 8) !== count) invalid('multi-volume ZIP is unsupported');
  if (!count || count > MAX_ENTRIES || size > 1024 * 1024 || start + size !== end) invalid('ZIP directory is too large or invalid');
  // Check the whole declared budget before inflating any entry.
  let scan = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (scan + 46 > end || u32(bytes, scan) !== 0x02014b50) invalid('truncated ZIP directory');
    total += u32(bytes, scan + 24);
    if (total > MAX_GP_EXPANDED_BYTES) invalid('expanded score exceeds 32 MiB');
    scan += 46 + u16(bytes, scan + 28) + u16(bytes, scan + 30) + u16(bytes, scan + 32);
  }
  if (scan !== end) invalid('inconsistent ZIP directory');
  let p = start, localEnd = 0, foundScore = false;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || u32(bytes, p) !== 0x02014b50) invalid('truncated ZIP directory');
    const flags = u16(bytes, p + 8), method = u16(bytes, p + 10), expectedCrc = u32(bytes, p + 16);
    const compressed = u32(bytes, p + 20), original = u32(bytes, p + 24), nameLength = u16(bytes, p + 28);
    const next = p + 46 + nameLength + u16(bytes, p + 30) + u16(bytes, p + 32), at = u32(bytes, p + 42);
    if (next > end || u16(bytes, p + 34) || flags & 1 || ![0, 8].includes(method)) invalid('unsupported ZIP entry');
    // The alphaTab reader walks local entries sequentially. Verify that those
    // headers describe exactly the same sequence as the central directory.
    if (at !== localEnd || at + 30 > start || u32(bytes, at) !== 0x04034b50 || u16(bytes, at + 6) !== flags || u16(bytes, at + 8) !== method) invalid('ZIP headers disagree');
    const localNameLength = u16(bytes, at + 26), extra = u16(bytes, at + 28);
    const dataStart = at + 30 + localNameLength + extra, dataEnd = dataStart + compressed;
    if (localNameLength !== nameLength || dataEnd > start) invalid('ZIP entry is out of bounds');
    for (let n = 0; n < nameLength; n++) if (bytes[at + 30 + n] !== bytes[p + 46 + n]) invalid('ZIP filenames disagree');
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));
    if (name.split('/').at(-1) === 'score.gpif') { if (foundScore) invalid('multiple score files'); foundScore = true; }
    if (!(flags & 8) && (u32(bytes, at + 14) !== expectedCrc || u32(bytes, at + 18) !== compressed || u32(bytes, at + 22) !== original)) invalid('ZIP sizes disagree');
    let received = 0, crc = 0xffffffff;
    const consume = chunk => {
      received += chunk.length;
      if (received > original) invalid('expanded ZIP entry exceeds its declared size');
      crc = crcStep(crc, chunk);
    };
    if (method === 0) consume(bytes.subarray(dataStart, dataEnd));
    else {
      const stream = new Inflate(consume);
      // Limit each inflate allocation even when a size header is dishonest.
      if (!compressed) invalid('empty compressed ZIP entry');
      for (let q = dataStart; q < dataEnd; q += 512) stream.push(bytes.subarray(q, Math.min(q + 512, dataEnd)), q + 512 >= dataEnd);
    }
    if (received !== original || ((crc ^ 0xffffffff) >>> 0) !== expectedCrc) invalid('ZIP entry length or checksum disagrees');
    localEnd = dataEnd;
    if (flags & 8) {
      if (u32(bytes, localEnd) === 0x08074b50) localEnd += 4;
      // Guitar Pro's writer reverses the two length fields in its ZIP data
      // descriptors. The directory and actual inflate/CRC remain authoritative.
      const first = u32(bytes, localEnd + 4), second = u32(bytes, localEnd + 8);
      if (localEnd + 12 > start || u32(bytes, localEnd) !== expectedCrc || !((first === compressed && second === original) || (first === original && second === compressed))) invalid('invalid ZIP data descriptor');
      localEnd += 12;
    }
    p = next;
  }
  if (p !== end || localEnd !== start || !foundScore) invalid('missing or inconsistent Guitar Pro score data');
  return bytes;
}

function decompressGpx(bytes) {
  if (bytes.length < 8) invalid('truncated GPX header');
  const size = u32(bytes, 4);
  if (size < 4 || size > MAX_GP_EXPANDED_BYTES) invalid('expanded GPX exceeds 32 MiB');
  // GP6's final literal token can extend a byte beyond the nominal length.
  const output = new Uint8Array(size + 3); let bit = 64, used = 0;
  const endOfInput = Symbol('end of GPX input');
  const read = (count, reversed = false) => {
    if (bit + count > bytes.length * 8) throw endOfInput;
    let result = 0;
    for (let i = 0; i < count; i++, bit++) {
      const value = (bytes[bit >> 3] >> (7 - (bit & 7))) & 1;
      result += value * 2 ** (reversed ? i : count - i - 1);
    }
    return result;
  };
  try { while (used < size) {
    if (read(1)) {
      const width = read(4), distance = read(width, true), length = Math.min(distance, read(width, true));
      if (!length || distance > used || used + length > size + 3) invalid('invalid GPX compression reference');
      output.set(output.subarray(used - distance, used - distance + length), used); used += length;
    } else {
      const length = read(2, true);
      // Zero-byte literal blocks are legal; each still consumes input bits.
      if (used + length > size + 3) invalid('GPX compression exceeds its declared size');
      for (let i = 0; i < length; i++) output[used++] = read(8);
    }
  } } catch (error) {
    // GP6 can omit up to three zero bytes at the end of its final sector.
    // Only unused sector padding may be restored; file bytes must be present.
    if (error !== endOfInput) throw error;
    if (size - used > 3) invalid('truncated GPX compression');
  }
  if (tag(output) !== 'BCFS') invalid('invalid GPX filesystem header');
  return {bytes:output.subarray(0, Math.max(size, used)), available:used};
}

function checkGpx(bytes, available = bytes.length) {
  const data = bytes.subarray(4), sectorSize = 4096;
  if (data.length > MAX_GP_EXPANDED_BYTES) invalid('expanded GPX exceeds 32 MiB');
  let offset = sectorSize, count = 0, foundScore = false;
  const seen = new Set();
  while (offset + 4 <= data.length) {
    if (seen.has(offset)) invalid('cyclic GPX filesystem');
    seen.add(offset);
    if (u32(data, offset) === 2) {
      if (++count > MAX_ENTRIES || offset + sectorSize > data.length) invalid('invalid GPX directory');
      const size = u32(data, offset + 140);
      if (size > MAX_GP_EXPANDED_BYTES) invalid('GPX file exceeds 32 MiB');
      let nameEnd = offset + 4;
      while (nameEnd < offset + 131 && data[nameEnd]) nameEnd++;
      const name = new TextDecoder().decode(data.subarray(offset + 4, nameEnd));
      if (name === 'score.gpif') { if (foundScore) invalid('multiple GPX score files'); foundScore = true; }
      let last = offset, sectors = 0, pointer = offset + 148;
      for (; pointer + 4 <= offset + sectorSize; pointer += 4) {
        const sector = u32(data, pointer);
        if (!sector) break;
        const position = sector * sectorSize;
        if (position + sectorSize > data.length || position === offset || ++sectors > Math.ceil(size / sectorSize)) invalid('invalid GPX file sector');
        if (position + Math.min(sectorSize, size - (sectors - 1) * sectorSize) > available - 4) invalid('truncated GPX file data');
        last = position;
      }
      if (pointer + 4 > offset + sectorSize || sectors * sectorSize < size) invalid('truncated GPX file');
      // Match the library's sector traversal, while guaranteeing termination.
      offset = last;
    }
    offset += sectorSize;
  }
  if (!foundScore) invalid('missing score.gpif in GPX');
  return bytes;
}

/** Return bounded input; compressed GPX is normalized to its BCFS form. */
export function preflightGuitarPro(bytes) {
  const signature = tag(bytes);
  if (signature === 'PK\x03\x04') return checkZip(bytes);
  if (signature === 'BCFZ') { const decoded = decompressGpx(bytes); return checkGpx(decoded.bytes, decoded.available); }
  if (signature === 'BCFS') return checkGpx(bytes);
  return bytes; // GP3–5 have no compressed container; the score reader checks them.
}
