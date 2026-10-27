/** The Harmonix Set's human beat annotations, pinned for reproducible timing.
 * https://github.com/urinieto/harmonixset (MIT, copyright 2019 Oriol Nieto).
 * Audio/spectrograms have separate terms and are never requested here.
 */
export const HARMONIX_REVISION = '64abeb509429e73d74559fb98e621dac866efea1';
export const HARMONIX_BASE = `https://raw.githubusercontent.com/urinieto/harmonixset/${HARMONIX_REVISION}/dataset`;
export const HARMONIX_SOURCE = 'https://github.com/urinieto/harmonixset';

export type TempoCandidate = {
  id: string;
  title: string;
  artist: string;
  album: string;
  source: 'harmonix';
  duration: number;
  bpm: number;
  /** Declared catalog meter, not inferred from the beat intervals. */
  meter?: { numerator: number; denominator: number };
};

/** RFC 4180 fields: titles and releases can contain commas or escaped quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { row.push(field); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); if (row.some(Boolean)) rows.push(row);
      row = []; field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('The tempo catalog is incomplete. Try again later.');
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function validHarmonixId(id: string): boolean {
  return /^\d{4}_[a-z0-9]{1,100}$/.test(id);
}

export function parseHarmonixCatalog(text: string): TempoCandidate[] {
  const [header, ...rows] = parseCsv(text.replace(/^\uFEFF/, ''));
  if (!header || header[0] !== 'File' || header[1] !== 'Title' || header[2] !== 'Artist')
    throw new Error('The tempo catalog is unavailable. Try again later.');
  return rows.flatMap(row => {
    const duration = Number(row[4]), bpm = Number(row[5]);
    if (!validHarmonixId(row[0] ?? '') || !row[1] || !row[2] ||
      !Number.isFinite(duration) || duration <= 0 || duration > 86400 ||
      !Number.isFinite(bpm) || bpm <= 0 || bpm > 1000) return [];
    const signature = header[7] === 'Time Signature' ? /^(\d{1,2})\|(\d{1,2})$/.exec(row[7] ?? '') : null;
    const numerator = signature ? Number(signature[1]) : 0;
    const denominator = signature ? Number(signature[2]) : 0;
    const meter = numerator >= 1 && numerator <= 16 && [1, 2, 4, 8, 16].includes(denominator)
      ? { numerator, denominator } : undefined;
    return [{ id: row[0], title: row[1], artist: row[2], album: row[3] || '',
      source: 'harmonix' as const, duration, bpm, ...(meter ? { meter } : {}) }];
  });
}

function normalized(text: string): string {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function searchTempoCatalog(catalog: TempoCandidate[], query: string, duration?: number): TempoCandidate[] {
  const needle = normalized(query), tokens = needle.split(/\s+/).filter(Boolean);
  if (needle.length < 2) return [];
  return catalog.map(candidate => {
    const title = normalized(candidate.title), artist = normalized(candidate.artist);
    const haystack = `${title} ${artist}`;
    if (!tokens.every(token => haystack.includes(token))) return null;
    const textScore = (title === needle ? 100 : 0) + (artist === needle ? 50 : 0)
      + (haystack.includes(needle) ? 20 : 0);
    const durationDifference = duration === undefined ? 0 : Math.abs(candidate.duration - duration);
    return { candidate, textScore, durationDifference };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => b.textScore - a.textScore || a.durationDifference - b.durationDifference
      || a.candidate.artist.localeCompare(b.candidate.artist) || a.candidate.title.localeCompare(b.candidate.title))
    .slice(0, 20).map(entry => entry.candidate);
}

/** Enforce limits while reading, including responses without Content-Length. */
export async function fetchTempoText(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('The tempo source is unavailable. Try again later.');
  const maximum = 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum)
    throw new Error('The tempo source returned a file that is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The tempo source returned an empty file.');
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) throw new Error('The tempo source returned a file that is too large.');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return text;
}
