// @vitest-environment happy-dom
// ED4: drum import (src/edit/drum-import.js; architecture §2.15): a drum chart from a file or a Find a
// chart source becomes the song's drum part, on a real song session (tests/helpers/test-session.js) with
// its real notation session and in-memory part store.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {clock as appClock} from '../src/app/clock.js';
import {COPY, importDrumResult, previewDrumImport, replaceDialog} from '../src/edit/drum-import.js';
import {fraction} from '../shared/notation.ts';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession} from './helpers/test-session.js';
import {demoScore} from './fixtures/drum-score.js';

const bars = (n, numerator = 4) => ({version: 1, measures: Array.from({length: n}, (_, i) => ({id: 'bar-' + i, numerator, denominator: 4, length: fraction(numerator), label: ''})),
  pins: [{position: fraction(0), time: 0}, {position: fraction(4), time: 2}], tailQpm: 120});
const hits = (...qs) => qs.map((q, i) => ({q, midi: i % 2 ? 38 : 36, durationQ: 0.25, velocity: 0.8}));
const hitCount = (score) => score.bars.reduce((n, bar) => n + bar.hits.length, 0);

let clock, restoreAudio, current = [];
beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
});
afterEach(async () => {
  for (const off of current.splice(0).reverse()) await off();
  restoreAudio();
  vi.useRealTimers();
});

async function session(options = {}) {
  const ts = await createTestSession({clock, tempo: {songMap: bars(10)}, duration: 20, ...options});
  current.push(() => ts.dispose());
  return ts;
}

describe('previewDrumImport', () => {
  test('lays hits onto the bars of the given map without changing anything', () => {
    const map = bars(10);
    const before = JSON.stringify(map);
    const result = {map, drums: {hits: hits(0, 1, 4), source: 'midi', warnings: ['From the file.']}};
    const preview = previewDrumImport(result, {map, duration: 20});
    expect(preview.importedCount).toBe(3);
    expect(preview.skippedCount).toBe(0);
    expect(preview.score.bars[0].measureId).toBe('bar-0');
    expect(hitCount(preview.score)).toBe(3);
    expect(preview.warnings[0]).toBe('From the file.');
    expect(JSON.stringify(map)).toBe(before);
  });

  test('no drum hits is refused with its reason; hits past the recording are skipped and counted', () => {
    expect(() => previewDrumImport({map: bars(4)}, {map: bars(4), duration: 8})).toThrow(COPY.noDrums);
    expect(() => previewDrumImport({drums: {hits: []}}, {map: bars(4), duration: 8})).toThrow(COPY.noDrums);
    const preview = previewDrumImport({drums: {hits: hits(0, 1000), source: 'midi'}}, {map: bars(10), duration: 20});
    expect(preview.importedCount).toBe(1);
    expect(preview.skippedCount).toBe(1);
    expect(preview.warnings.join(' ')).toMatch(/outside the recording/);
  });
});

describe('importDrumResult', () => {
  test('imports into an empty part as the song\'s drum chart (saved by the part store)', async () => {
    const ts = await session();
    const out = await importDrumResult({drums: {hits: hits(0, 1, 2, 3), source: 'midi', warnings: []}}, {session: ts.session});
    expect(out.count).toBe(4);
    expect(out.skipped).toBe(0);
    expect(hitCount(ts.session.notation.part.score)).toBe(4);
    expect(ts.partSaves.length).toBeGreaterThan(0);
    expect(ts.session.notation.hasNotation.peek()).toBe(true);
  });

  test('a song that already has a drum chart refuses without a confirm, and the part is unchanged', async () => {
    const ts = await session({tempo: undefined, duration: undefined, score: demoScore(128, 120)});
    await ts.session.notation.ready;
    const before = hitCount(ts.session.notation.part.score);
    await expect(importDrumResult({drums: {hits: hits(0), source: 'midi'}}, {session: ts.session})).rejects.toMatchObject({code: 'HAS_NOTATION'});
    expect(hitCount(ts.session.notation.part.score)).toBe(before);
  });

  test('with confirmReplace it asks with the chart\'s counts: Cancel keeps the chart, Replace swaps it in one undo step', async () => {
    const ts = await session({tempo: undefined, duration: undefined, score: demoScore(128, 120)});
    await ts.session.notation.ready;
    const part = ts.session.notation.part;
    const before = hitCount(part.score);
    const no = vi.fn(async () => false);
    const canceled = await importDrumResult({drums: {hits: hits(0), source: 'midi'}}, {session: ts.session, confirmReplace: no, source: 'take2.mid'});
    expect(canceled).toMatchObject({canceled: true, replaced: false});
    expect(no).toHaveBeenCalledWith({notes: before, reviewed: expect.any(Number), incoming: 1, source: 'take2.mid'});
    expect(hitCount(part.score)).toBe(before);

    const done = await importDrumResult({drums: {hits: hits(0), source: 'midi'}}, {session: ts.session, confirmReplace: async () => true});
    expect(done).toMatchObject({count: 1, replaced: true});
    expect(hitCount(part.score)).toBe(1);
    part.editor.undo();
    expect(hitCount(part.score)).toBe(before);
  });

  test('replaceDialog asks "Replace the drum chart?" as a danger confirm with the counts and the source', async () => {
    const ask = vi.fn(async () => true);
    await expect(replaceDialog(ask)({notes: 1284, reviewed: 24, incoming: 1402, source: 'song.gp5'})).resolves.toBe(true);
    expect(ask).toHaveBeenCalledWith({title: COPY.replaceTitle, confirmLabel: COPY.replaceConfirm, danger: true,
      body: 'The current chart (1,284 notes, 24 bars reviewed) will be replaced by 1,402 notes from song.gp5, on its own bars. Your section names stay. Undo brings the current chart back.'});
    expect(COPY.replaceBody({notes: 1, reviewed: 0, incoming: 2, source: ''})).toBe(
      'The current chart (1 note) will be replaced by 2 notes, on its own bars. Your section names stay. Undo brings the current chart back.');
  });

  test('an empty part imports with no question', async () => {
    const ts = await session();
    const ask = vi.fn(async () => true);
    const done = await importDrumResult({drums: {hits: hits(0), source: 'midi'}}, {session: ts.session, confirmReplace: ask});
    expect(ask).not.toHaveBeenCalled();
    expect(done).toMatchObject({count: 1, replaced: false});
  });

  test('nothing inside the recording imports nothing; a shared song refuses', async () => {
    const ts = await session();
    await expect(importDrumResult({drums: {hits: hits(1000, 1001), source: 'midi'}}, {session: ts.session})).rejects.toThrow(COPY.noneInside);
    const shared = await session({shared: {token: 'share-1'}});
    await expect(importDrumResult({drums: {hits: hits(0), source: 'midi'}}, {session: shared.session})).rejects.toThrow(COPY.readOnly);
  });
});
