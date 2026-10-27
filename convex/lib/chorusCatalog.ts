import type { TempoCandidate } from './tempoCatalog';
import { searchTempoCatalog } from './tempoCatalog';

/** Chorus Encore's public catalog API, also used by its official Bridge client.
 * https://github.com/Geomitron/Bridge/tree/master/src-angular/app/core/services
 * Only catalog metadata is requested here. Chart loading uses byte ranges.
 */
export const CHORUS_API = 'https://api.enchor.us/search';
export const CHORUS_FILES = 'https://files.enchor.us';
export const CHORUS_SITE = 'https://www.enchor.us';
const md5Pattern = /^[a-f0-9]{32}$/;

export function chorusHash(id: string): string | null {
  const hash = id.startsWith('chorus:') ? id.slice(7) : '';
  return md5Pattern.test(hash) ? hash : null;
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const text = (value: unknown, max = 500): string => typeof value === 'string' ? value.slice(0, max).trim() : '';

export function parseChorusCandidates(value: unknown): TempoCandidate[] {
  const response = object(value);
  if (!Array.isArray(response?.data)) throw new Error('Invalid Chorus catalog response.');
  const seen = new Set<string>();
  return response.data.slice(0, 25).flatMap(raw => {
    const row = object(raw);
    if (!row) return [];
    const hash = text(row.md5), title = text(row.chartName) || text(row.name), artist = text(row.artist);
    if (!md5Pattern.test(hash) || !title || !artist || seen.has(hash)) return [];
    const milliseconds = row.song_length;
    const duration = typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds > 0
      && milliseconds <= 86400000 ? milliseconds / 1000 : 0;
    const notesData = object(row.notesData), instruments = notesData?.instruments;
    const hasDrums = Array.isArray(instruments) ? instruments.includes('drums')
      : ['diff_drums', 'diff_drums_real'].some(key => typeof row[key] === 'number' && (row[key] as number) >= 0);
    const chartHash = text(row.chartHash, 100), charter = text(row.charter);
    const sourceUrl = /^[A-Za-z0-9_=-]{16,100}$/.test(chartHash)
      ? `${CHORUS_SITE}/chart/${encodeURIComponent(chartHash)}` : `${CHORUS_SITE}/?hash=${hash}`;
    seen.add(hash);
    return [{ id: `chorus:${hash}`, title, artist, album: text(row.chartAlbum) || text(row.album),
      source: 'chorus' as const, duration, sourceUrl, hasDrums, ...(charter ? { charter } : {}) }];
  });
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error('Chorus is temporarily unavailable.');
  const maximum = 2 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel(); throw new Error('Chorus returned too much catalog data.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Chorus returned no catalog data.');
  let received = 0, data = ''; const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      received += value.byteLength;
      if (received > maximum) throw new Error('Chorus returned too much catalog data.');
      data += decoder.decode(value, { stream: true });
    }
    return JSON.parse(data + decoder.decode());
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
}

export async function searchChorus(query: string, duration?: number, fetcher: typeof fetch = fetch): Promise<TempoCandidate[]> {
  const response = await fetcher(CHORUS_API, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ search: query, per_page: 20, page: 1, instrument: null, difficulty: null,
      drumType: null, drumsReviewed: false, sort: null, source: 'api' }),
  });
  return searchTempoCatalog(parseChorusCandidates(await responseJson(response)), query, duration);
}
