/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, test, vi } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { fetchTempoText, parseCsv, parseHarmonixCatalog, searchTempoCatalog,
  HARMONIX_BASE, validHarmonixId } from './lib/tempoCatalog';
import { CHORUS_API } from './lib/chorusCatalog';
const { extractChart } = vi.hoisted(() => ({ extractChart: vi.fn() }));
vi.mock('../shared/sng', () => ({ extractSngChart: extractChart }));
const modules = import.meta.glob('./**/*.ts');
const csv = 'File,Title,Artist,Release,Duration,BPM,Ratio Bars in 4,Time Signature,Genre,MusicBrainz Id,Acoustid Id\n'
  + '0001_12step,"1, 2 Step",Ciara,Goodies,142.47,113,100,4|4,R&B,,\n'
  + '0002_other,Other Song,Other Artist,Album,200,120,100,4|4,Rock,,\n'
  + '0003_other,Other Song,Other Artist,Live,250,121,100,4|4,Rock,,\n';
afterEach(() => { vi.unstubAllGlobals(); extractChart.mockReset(); });

test('catalog parsing preserves quoted titles, releases and escaped quotes', () => {
  expect(parseCsv('a,b\r\n"one, two","say ""yes"""\r\n')).toEqual([
    ['a', 'b'], ['one, two', 'say "yes"'],
  ]);
  expect(parseHarmonixCatalog(csv)[0]).toMatchObject({
    title: '1, 2 Step', artist: 'Ciara', duration: 142.47, bpm: 113, meter: { numerator: 4, denominator: 4 },
  });
  expect(() => parseHarmonixCatalog('not a catalog')).toThrow('unavailable');
  expect(() => parseCsv('a,"unfinished')).toThrow('incomplete');
});
test('catalog meter hints preserve declared compound meters without guessing missing or unsupported values', () => {
  expect(parseHarmonixCatalog(csv.replaceAll('4|4', '6|8'))[0].meter)
    .toEqual({ numerator: 6, denominator: 8 });
  expect(parseHarmonixCatalog(csv.replaceAll('4|4', ''))[0]).not.toHaveProperty('meter');
  expect(parseHarmonixCatalog(csv.replaceAll('4|4', '7|3'))[0]).not.toHaveProperty('meter');
  expect(parseHarmonixCatalog(csv.replaceAll('4|4', '4|4;3|4'))[0]).not.toHaveProperty('meter');
});
test('song and artist matching ignores punctuation; alternatives rank by duration', () => {
  const catalog = parseHarmonixCatalog(csv);
  expect(searchTempoCatalog(catalog, 'Ciara 1 2 step')).toHaveLength(1);
  expect(searchTempoCatalog(catalog, 'Other Song', 245).map(c => c.id)).toEqual(['0003_other', '0002_other']);
  expect(searchTempoCatalog(catalog, 'unrelated')).toEqual([]);
  expect(searchTempoCatalog(catalog, 'a')).toEqual([]);
  expect(searchTempoCatalog(Array.from({ length: 100 }, () => catalog[0]), 'Ciara')).toHaveLength(20);
});
test('provider fetch stops oversized streams even without Content-Length', async () => {
  const cancelled = vi.fn();
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel: cancelled,
  }));
  await expect(fetchTempoText('https://example.test', vi.fn(async () => response))).rejects.toThrow('too large');
  expect(cancelled).toHaveBeenCalled();
  await expect(fetchTempoText('https://example.test', vi.fn(async () => new Response('', { status: 503 })))).rejects.toThrow('unavailable');
});
test('unauthenticated and suspended users cannot make provider requests', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const t = convexTest(schema, modules);
  await expect(t.action(api.tempoSources.search, { query: 'Ciara' })).rejects.toThrow('Not signed in');
  await expect(t.action(api.tempoSources.load, { id: '0001_12step' })).rejects.toThrow('Not signed in');
  await t.run(ctx => ctx.db.insert('accountControls', { userId: 'alice', status: 'suspended', notes: '' }));
  await expect(t.withIdentity({ subject: 'alice' }).action(api.tempoSources.search, { query: 'Ciara' })).rejects.toThrow('suspended');
  await expect(t.withIdentity({ subject: 'alice' }).action(api.tempoSources.load, { id: '0001_12step' })).rejects.toThrow('suspended');
  expect(fetcher).not.toHaveBeenCalled();
});
test('chosen maps use pinned, catalog-owned URLs and reject arbitrary paths', async () => {
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (url === `${HARMONIX_BASE}/metadata.csv`) return new Response(csv);
    if (url === CHORUS_API) return Response.json({ data: [] });
    if (url === `${HARMONIX_BASE}/beats_and_downbeats/0001_12step.txt`) return new Response('1.0\t1\t1\n1.5\t2\t1\n');
    throw new Error(`Unexpected provider request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const alice = convexTest(schema, modules).withIdentity({ subject: 'alice' });
  for (const id of ['../LICENSE', 'https://example.test', '0001_12step?x=y']) {
    expect(validHarmonixId(id)).toBe(false);
    await expect(alice.action(api.tempoSources.load, { id })).rejects.toThrow('Invalid');
  }
  expect(fetcher).not.toHaveBeenCalled();
  const { candidates, warnings } = await alice.action(api.tempoSources.search, { query: 'Ciara' });
  expect(candidates).toHaveLength(1); expect(warnings).toEqual([]);
  expect(candidates[0].meter).toEqual({ numerator: 4, denominator: 4 });
  const map = await alice.action(api.tempoSources.load, { id: candidates[0].id });
  if (map.format !== 'beats') throw new Error('Expected beat annotations.');
  expect(map.text).toContain('1.0\t1\t1');
  expect(map.sourceUrl).toContain('/blob/64abeb509429e73d74559fb98e621dac866efea1/');
  await expect(alice.action(api.tempoSources.load, { id: '9999_missing' })).rejects.toThrow('unavailable');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
test('a failed provider leaves working source matches available and reports missing results', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    if (url === `${HARMONIX_BASE}/metadata.csv`) return new Response(csv);
    if (url === CHORUS_API) return new Response('', { status: 503 });
    throw new Error('Unexpected network request');
  }));
  const alice = convexTest(schema, modules).withIdentity({ subject: 'alice' });
  const result = await alice.action(api.tempoSources.search, { query: 'Ciara' });
  expect(result.candidates.some(c => c.source === 'harmonix')).toBe(true);
  expect(result.warnings).toEqual(['Chorus Encore could not be searched. Its matches may be missing.']);
});
test('selected Chorus maps return only bounded chart bytes using fixed provider URLs', async () => {
  extractChart.mockResolvedValue({ name: 'notes.mid', bytes: new Uint8Array([77, 84, 104, 100]), metadata: { delay: '250' } });
  const alice = convexTest(schema, modules).withIdentity({ subject: 'alice' });
  const map = await alice.action(api.tempoSources.load, { id: 'chorus:84d283cd46bb52714c2c7ca1481253c6' });
  expect(map).toMatchObject({ format: 'midi', metadata: { delay: '250' } });
  expect(extractChart).toHaveBeenCalledWith('https://files.enchor.us/84d283cd46bb52714c2c7ca1481253c6.sng');
  extractChart.mockResolvedValue({ name: 'notes.chart', bytes: new Uint8Array(901 * 1024), metadata: {} });
  await expect(alice.action(api.tempoSources.load, { id: 'chorus:84d283cd46bb52714c2c7ca1481253c6' })).rejects.toThrow('too large');
});
