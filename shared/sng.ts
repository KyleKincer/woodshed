/**
 * Read only chart bytes from an SNG v1 package, using HTTP byte ranges.
 * Format: https://github.com/mdsitton/SngFileFormat#sng-file-specification
 * The caller must restrict URLs to its trusted chart host before calling.
 * Audio, artwork and other bundled files are never requested.
 */
export const MAX_SNG_CHART_BYTES = 750 * 1024;
const MAX_SECTION_BYTES = 512 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_FILES = 1024;
const RANGE_ERROR = 'This chart host does not support bounded downloads. Download the chart and import its notes.chart or notes.mid file instead.';
function invalid(detail: string): never { throw new Error(`Invalid SNG chart package: ${detail}.`); }

class Reader {
  offset = 0;
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  need(count: number) { if (!Number.isSafeInteger(count) || count < 0 || this.offset + count > this.bytes.length) invalid('truncated header or index'); }
  byte() { this.need(1); return this.bytes[this.offset++]; }
  uint32() { this.need(4); const result = this.view.getUint32(this.offset, true); this.offset += 4; return result; }
  uint64() {
    this.need(8);
    const result = this.view.getUint32(this.offset, true) + this.view.getUint32(this.offset + 4, true) * 4294967296;
    this.offset += 8;
    if (!Number.isSafeInteger(result) || result > MAX_ARCHIVE_BYTES) invalid('section or file is too large');
    return result;
  }
  string(length: number) {
    this.need(length);
    let value: string;
    try { value = new TextDecoder('utf-8', {fatal: true}).decode(this.bytes.subarray(this.offset, this.offset + length)); }
    catch { return invalid('invalid UTF-8 text'); }
    this.offset += length;
    if (value.includes('\0')) invalid('text contains a null byte');
    return value;
  }
  signedString() {
    this.need(4); const length = this.view.getInt32(this.offset, true); this.offset += 4;
    return this.string(length);
  }
}

type Options = {signal?: AbortSignal; maxChartBytes?: number; timeoutMs?: number};
type Extracted = {name: string; bytes: Uint8Array; metadata: Record<string, string>};

export async function extractSngChart(url: string, fetcher: typeof fetch = fetch, options: Options = {}): Promise<Extracted> {
  const maxChartBytes = options.maxChartBytes ?? MAX_SNG_CHART_BYTES;
  if (!Number.isSafeInteger(maxChartBytes) || maxChartBytes < 1 || maxChartBytes > 10 * 1024 * 1024) throw new Error('Invalid chart download size limit.');
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, {once: true});
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  let total: number | null = null, etag: string | null = null;

  const range = async (start: number, length: number) => {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 1 || length > Math.max(MAX_SECTION_BYTES + 8, maxChartBytes) || start + length > MAX_ARCHIVE_BYTES || (total !== null && start + length > total)) invalid('requested byte range is out of bounds');
    const response = await fetcher(url, {headers: {Range: `bytes=${start}-${start + length - 1}`, 'Accept-Encoding': 'identity'}, redirect: 'error', signal: controller.signal});
    const cancel = async () => { try { await response.body?.cancel(); } catch {} };
    if (response.status !== 206) { await cancel(); throw new Error(RANGE_ERROR); }
    const contentRange = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
    const contentLength = response.headers.get('content-length');
    const encoding = response.headers.get('content-encoding');
    if (!contentRange || Number(contentRange[1]) !== start || Number(contentRange[2]) !== start + length - 1 || !Number.isSafeInteger(Number(contentRange[3])) || Number(contentRange[3]) > MAX_ARCHIVE_BYTES || Number(contentRange[3]) < start + length || (total !== null && Number(contentRange[3]) !== total) || (contentLength !== null && Number(contentLength) !== length) || (encoding && encoding !== 'identity')) {
      await cancel(); invalid('server returned an inconsistent byte range');
    }
    total = Number(contentRange[3]);
    const currentEtag = response.headers.get('etag');
    if (etag && currentEtag && currentEtag !== etag) { await cancel(); invalid('package changed during download'); }
    etag ??= currentEtag;
    if (!response.body) invalid('missing response body');
    const reader = response.body.getReader(), bytes = new Uint8Array(length); let received = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array) || received + value.length > length) { await reader.cancel(); invalid('server exceeded the requested range'); }
        bytes.set(value, received); received += value.length;
      }
    } finally { reader.releaseLock(); }
    if (received !== length) invalid('incomplete byte range');
    return bytes;
  };

  try {
    const header = new Reader(await range(0, 34));
    if (header.string(6) !== 'SNGPKG') invalid('wrong file identifier');
    if (header.uint32() !== 1) throw new Error('This SNG package version is not supported. Import its notes.chart or notes.mid file instead.');
    const xorMask = header.bytes.slice(10, 26); header.offset = 26;
    const metadataLength = header.uint64();
    if (metadataLength < 8 || metadataLength > MAX_SECTION_BYTES) invalid('metadata section is too large or too short');
    // Include the following index-length field in this same bounded request.
    const metadataReader = new Reader(await range(34, metadataLength + 8));
    const metadataCount = metadataReader.uint64();
    if (metadataCount > 2048) invalid('too many metadata fields');
    const pairs: [string, string][] = [];
    for (let i = 0; i < metadataCount; i++) {
      const key = metadataReader.signedString(), value = metadataReader.signedString();
      if (!key || key.length > 1024) invalid('invalid metadata key');
      pairs.push([key, value]);
    }
    if (metadataReader.offset !== metadataLength) invalid('metadata section length does not match its fields');
    const indexLength = metadataReader.uint64();
    if (indexLength < 8 || indexLength > MAX_SECTION_BYTES) invalid('file index is too large or too short');
    const indexStart = 34 + metadataLength + 8;
    const index = new Reader(await range(indexStart, indexLength + 8));
    const fileCount = index.uint64();
    if (!fileCount || fileCount > MAX_FILES) invalid('invalid number of files');
    const files: {name: string; length: number; start: number}[] = [], names = new Set<string>();
    for (let i = 0; i < fileCount; i++) {
      const name = index.string(index.byte());
      if (!name || /[\x00-\x1f\x7f\\]/.test(name) || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.' || part === '')) invalid('unsafe file name');
      if (names.has(name.toLowerCase())) invalid('duplicate file names');
      names.add(name.toLowerCase());
      files.push({name, length: index.uint64(), start: index.uint64()});
    }
    if (index.offset !== indexLength) invalid('index length does not match its entries');
    const dataLength = index.uint64(), dataStart = indexStart + indexLength + 8;
    if (dataStart + dataLength !== total) invalid('file data length is inconsistent');
    let previousEnd = dataStart;
    for (const file of [...files].sort((a, b) => a.start - b.start)) {
      if (file.start < previousEnd || file.start + file.length > dataStart + dataLength) invalid('overlapping or out-of-bounds files');
      previousEnd = file.start + file.length;
    }
    const chart = files.find(file => file.name.toLowerCase() === 'notes.chart') ?? files.find(file => file.name.toLowerCase() === 'notes.mid');
    if (!chart) throw new Error('This package contains no notes.chart or notes.mid file. Try another chart.');
    if (!chart.length || chart.length > maxChartBytes) throw new Error(`This chart is too large to load online. Download it and import notes.chart or notes.mid instead.`);
    const bytes = await range(chart.start, chart.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= xorMask[i % 16] ^ (i & 0xff);
    return {name: chart.name, bytes, metadata: Object.fromEntries(pairs)};
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); controller.abort();
  }
}

/** The same bounded parser for a local File.slice reader; no network request is made. */
export async function extractSngChartFromReader(readRange: (start: number, endExclusive: number) => Promise<Uint8Array>, size: number, options: Options = {}): Promise<Extracted> {
  if (!Number.isSafeInteger(size) || size < 34 || size > MAX_ARCHIVE_BYTES) invalid('invalid package size');
  const fetcher: typeof fetch = async (_url, init) => {
    const requested = new Headers(init?.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/);
    if (!requested) invalid('missing byte range');
    const start = Number(requested[1]), end = Number(requested[2]) + 1;
    if (init?.signal?.aborted) throw new Error('Chart import was cancelled.');
    if (end > size) invalid('byte range exceeds package size');
    const bytes = await readRange(start, end);
    const stream = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(bytes); controller.close();}});
    return new Response(stream, {status: 206, headers: {'content-range': `bytes ${start}-${end - 1}/${size}`, 'content-length': String(bytes.length)}});
  };
  return extractSngChart('https://local.invalid/chart.sng', fetcher, options);
}
