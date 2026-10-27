import { expect, test, vi } from 'vitest';
import { CHORUS_API, chorusHash, parseChorusCandidates, searchChorus } from './lib/chorusCatalog';

// Metadata shape recorded from Chorus's public API for the user's regression song.
const born = {
  name: 'Born In Dissonance', artist: 'Meshuggah', album: 'The Violent Sleep Of Reason',
  chartId: 426253, md5: '84d283cd46bb52714c2c7ca1481253c6',
  chartHash: '52_MXyyy0VPU0nzolIiSNDe_Cf-JEzBPW91cXNTeHDo=',
  song_length: 274231, charter: 'Zantor + Voxelated', diff_drums: -1,
  diff_drums_real: -1, notesData: { instruments: ['guitar'] },
};
test('Born in Dissonance normalizes into a selectable Chorus candidate', () => {
  const [candidate] = parseChorusCandidates({ data: [born] });
  expect(candidate).toMatchObject({ id: `chorus:${born.md5}`, title: born.name,
    artist: 'Meshuggah', source: 'chorus', duration: 274.231,
    charter: 'Zantor + Voxelated', hasDrums: false });
  expect(candidate.sourceUrl).toBe('https://www.enchor.us/chart/52_MXyyy0VPU0nzolIiSNDe_Cf-JEzBPW91cXNTeHDo%3D');
  expect(candidate).not.toHaveProperty('bpm');
});
test('alternative charts stay distinct, duplicates and unsafe identifiers are removed', () => {
  const alternatives = parseChorusCandidates({ data: [born, born,
    { ...born, md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', charter: 'Another charter', notesData: { instruments: ['drums'] } },
    { ...born, md5: '../../private' }, { name: 'incomplete' }] });
  expect(alternatives).toHaveLength(2);
  expect(alternatives[1]).toMatchObject({ charter: 'Another charter', hasDrums: true });
  expect(chorusHash(alternatives[0].id)).toBe(born.md5);
  for (const id of ['chorus:../../private', 'https://example.test', `chorus:${born.md5}?x=1`])
    expect(chorusHash(id)).toBeNull();
  expect(() => parseChorusCandidates({ data: 'unexpected' })).toThrow('Invalid');
});
test('catalog search uses public API and returns a matching recording near the user duration', async () => {
  const fetcher = vi.fn(async () => Response.json({ data: [born] }));
  const result = await searchChorus('Meshuggah Born in Dissonance', 272, fetcher);
  expect(result).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledWith(CHORUS_API, expect.objectContaining({ method: 'POST', redirect: 'error' }));
  const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(request[1].body as string)).toMatchObject({ search: 'Meshuggah Born in Dissonance',
    source: 'api', drumsReviewed: false, instrument: null });
});
test('upstream failures and oversized catalog responses fail without unbounded reads', async () => {
  await expect(searchChorus('Meshuggah', 272, vi.fn(async () => new Response('', { status: 503 })))).rejects.toThrow('unavailable');
  const cancelled = vi.fn();
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel: cancelled });
  await expect(searchChorus('Meshuggah', 272, vi.fn(async () => new Response(body)))).rejects.toThrow('too much');
  expect(cancelled).toHaveBeenCalled();
});
