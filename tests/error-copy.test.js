// @vitest-environment happy-dom
// src/app/error-copy.js (architecture §2.10, spec §3.6, §6.1) and the codec copy.
import {describe, expect, test, vi, afterEach} from 'vitest';
import {existsSync} from 'node:fs';
import {describeError, copyFor, legacyJobCode, LABELS, TARGETS, ROWS, SENTENCES, CONTEXTS, RENDERER_CODES, LOOKUP_CODES} from '../src/app/error-copy.js';
import {CODES, JOB_ERROR_CODES} from '../convex/lib/errors.ts';
import {registry} from '../src/app/commands.js';
import {codecErrorMessage} from '../src/js/stemcache.js';

// src/api/jobs.js arrives with BK2 (wave 0B); error-copy.js finds it through import.meta.glob.
const apiJobs = vi.hoisted(() => ({retry: vi.fn(async () => null), dismiss: vi.fn(async () => null)}));
vi.mock('../src/api/jobs.js', () => apiJobs);
const JOBS_BUILT = existsSync(`${process.cwd()}/src/api/jobs.js`);

const TARGET_SET = new Set(['jobs.retry', 'jobs.retryFast', 'add.search', 'add.pick', 'processor.restart', 'settings.plan', 'jobs.dismiss']);

function harness({available = true} = {}) {
  const jobs = {retry: vi.fn(async () => null), dismiss: vi.fn(async () => null)};
  const router = {navigate: vi.fn()};
  const desktop = {available, restartProcessor: vi.fn(async () => ({port: 1, token: 't'}))};
  return {jobs, router, desktop};
}

const failedJob = (errorCode, extra = {}) => ({jobId: 'job1', status: 'error', errorCode, error: `raw ${errorCode} text`, meta: {title: 'Harbor Lights'}, source: {type: 'search', value: 'harbor lights ada moreno'}, ...extra});

/** Runs an action and reports which §2.10 target it reached. */
async function reached(action, deps) {
  deps.jobs.retry.mockClear(); deps.jobs.dismiss.mockClear(); deps.router.navigate.mockClear(); deps.desktop.restartProcessor.mockClear();
  await action.run();
  const hits = [];
  for (const [args] of deps.jobs.retry.mock.calls) hits.push(args.preset === 'fast' ? 'jobs.retryFast' : 'jobs.retry');
  if (deps.jobs.dismiss.mock.calls.length) hits.push('jobs.dismiss');
  for (const [path] of deps.router.navigate.mock.calls) {
    if (path.startsWith('/add?q=') || path === '/add') hits.push('add.search');
    else if (path === '/add?pick=1') hits.push('add.pick');
    else if (path === '/settings/plan') hits.push('settings.plan');
    else hits.push(`navigate:${path}`);
  }
  if (deps.desktop.restartProcessor.mock.calls.length) hits.push('processor.restart');
  return hits;
}

// Spec §3.6, row by row: the input that produces it and the exact copy.
const SPEC_ROWS = [
  {row: 'botCheckPending', input: () => failedJob('bot_check', {retryAt: 1_900_000_000_000, attempts: 1}),
    sentence: 'YouTube asked for a sign-in check. Woodshed will try again in a few minutes.', primary: 'Try now', secondary: 'Upload a file instead'},
  {row: 'botCheckBlocked', input: () => failedJob('bot_check', {attempts: 3}),
    sentence: 'YouTube blocked this download.', primary: 'Search for another version', secondary: 'Upload a file instead'},
  {row: 'unavailable', input: () => failedJob('unavailable'),
    sentence: 'This video isn’t available. It may be private, removed or blocked in your region.', primary: 'Search for another version', secondary: 'Dismiss'},
  {row: 'processorOffline', input: () => ({code: 'processor_offline', message: 'connect ECONNREFUSED 127.0.0.1'}), context: 'add',
    sentence: 'Woodshed’s processor isn’t running on this computer.', primary: 'Restart processor', secondary: undefined},
  {row: 'unreadable', input: () => failedJob('unreadable', {source: {type: 'upload', value: 'notes.mp3'}}),
    sentence: 'This file couldn’t be read as audio.', primary: 'Choose another file', secondary: 'Dismiss'},
  {row: 'diskFull', input: () => failedJob('disk_full'),
    sentence: 'This computer is out of space for processing.', primary: undefined, secondary: 'Dismiss', detailsFirst: true},
  {row: 'storageFull', input: () => failedJob('storage_full', {data: {usedBytes: 2e9, limitBytes: 2e9}}),
    sentence: 'Your cloud storage is full (2.0 of 2.0 GB).', primary: 'Manage storage', secondary: 'Dismiss'},
  {row: 'accountPaused', input: () => failedJob('account_paused'),
    sentence: 'Adding songs is paused on this account.', primary: 'Plan & storage', secondary: undefined},
  {row: 'separationFailed', input: () => failedJob('separation_failed'),
    sentence: 'Splitting failed on this computer.', primary: 'Try again', secondary: 'Try Fast quality'},
  {row: 'unknown', input: () => failedJob('unknown'),
    sentence: 'Something went wrong while adding this song.', primary: 'Try again', secondary: 'Dismiss'},
];

describe('spec §3.6 rows', () => {
  test('the copy table holds every spec row', () => {
    expect(Object.keys(ROWS).sort()).toEqual(SPEC_ROWS.map(r => r.row).sort());
  });

  test.each(SPEC_ROWS)('$row', async ({row, input, context = 'job', sentence, primary, secondary, detailsFirst = false}) => {
    const deps = harness();
    const out = describeError(input(), {context, ...deps});
    expect(out.sentence).toBe(sentence);
    expect(out.primary?.label).toBe(primary);
    expect(out.secondary?.label).toBe(secondary);
    expect(out.detailsFirst).toBe(detailsFirst);
    expect(out.details).toMatch(/\S/);
    // Every action resolves to its §2.10 target, and running it reaches exactly that target.
    for (const action of [out.primary, out.secondary].filter(Boolean)) {
      expect(TARGET_SET.has(action.target)).toBe(true);
      expect(TARGETS[action.label]).toBe(action.target);
      expect(await reached(action, deps)).toEqual([action.target]);
    }
  });
});

describe('§2.10 action targets', () => {
  test('every label maps to one of the seven targets', () => {
    expect(Object.keys(TARGETS).sort()).toEqual(Object.values(LABELS).sort());
    for (const target of Object.values(TARGETS)) expect(TARGET_SET.has(target)).toBe(true);
  });

  test('Try again and Try Fast quality retry the job; Try now clears the bot-check wait the same way', async () => {
    const deps = harness();
    const sep = describeError(failedJob('separation_failed'), {...deps});
    await sep.primary.run();
    expect(deps.jobs.retry).toHaveBeenLastCalledWith({jobId: 'job1'});
    await sep.secondary.run();
    expect(deps.jobs.retry).toHaveBeenLastCalledWith({jobId: 'job1', preset: 'fast'});
    const bot = describeError(failedJob('bot_check', {retryAt: 5}), {...deps});
    await bot.primary.run();
    expect(deps.jobs.retry).toHaveBeenLastCalledWith({jobId: 'job1'});
  });

  test('Search for another version opens /add?q= with the title and hands the job over for dismissal', async () => {
    const deps = harness();
    const out = describeError(failedJob('unavailable'), {...deps});
    await out.primary.run();
    expect(deps.router.navigate).toHaveBeenCalledWith('/add?q=Harbor%20Lights', {state: {dismissJobId: 'job1'}});
    expect(deps.jobs.dismiss).not.toHaveBeenCalled();
    // Falls back to the song title, then the source value.
    const noMeta = describeError({...failedJob('unavailable'), meta: null}, {...deps, song: {title: 'Undertow & Co'}});
    await noMeta.primary.run();
    expect(deps.router.navigate).toHaveBeenLastCalledWith('/add?q=Undertow%20%26%20Co', {state: {dismissJobId: 'job1'}});
    const bare = describeError({...failedJob('unavailable'), meta: null}, {...deps});
    await bare.primary.run();
    expect(deps.router.navigate).toHaveBeenLastCalledWith(`/add?q=${encodeURIComponent('harbor lights ada moreno')}`, {state: {dismissJobId: 'job1'}});
  });

  test('Upload a file instead and Choose another file open /add?pick=1; Plan & storage and Manage storage open /settings/plan', async () => {
    const deps = harness();
    await describeError(failedJob('bot_check'), deps).secondary.run();
    await describeError(failedJob('unreadable'), deps).primary.run();
    await describeError(failedJob('account_paused'), deps).primary.run();
    await describeError(failedJob('storage_full'), deps).primary.run();
    expect(deps.router.navigate.mock.calls.map(c => c[0])).toEqual(['/add?pick=1', '/add?pick=1', '/settings/plan', '/settings/plan']);
  });

  test('Restart processor calls desktop.restartProcessor, and is absent outside the desktop app', async () => {
    const deps = harness();
    const out = describeError({code: 'processor_offline'}, {context: 'add', ...deps});
    await out.primary.run();
    expect(deps.desktop.restartProcessor).toHaveBeenCalledOnce();
    const web = describeError({code: 'processor_offline'}, {context: 'add', ...harness({available: false})});
    expect(web.primary).toBeUndefined();
    expect(web.sentence).toBe(ROWS.processorOffline.sentence);
  });

  test('job actions need a job id: an ApiError never offers Try again or Dismiss', () => {
    const deps = harness();
    const out = describeError({code: 'unknown', message: 'boom'}, {context: 'add', ...deps});
    expect(out.primary).toBeUndefined();
    expect(out.secondary).toBeUndefined();
    // A secondary whose primary cannot run here moves up.
    const paused = describeError({code: 'storage_full_user', message: 'full', data: {usedBytes: 1.5e9, limitBytes: 2e9}}, {context: 'add', ...deps});
    expect(paused.sentence).toBe('Your cloud storage is full (1.5 of 2.0 GB).');
    expect(paused.primary.label).toBe('Manage storage');
    expect(paused.secondary).toBeUndefined();
  });

  test.runIf(JOBS_BUILT)('jobs default to src/api/jobs.js, loaded when the action runs', async () => {
    const out = describeError(failedJob('separation_failed'), {router: harness().router});
    await out.secondary.run();
    expect(apiJobs.retry).toHaveBeenCalledWith({jobId: 'job1', preset: 'fast'});
    await describeError(failedJob('unavailable'), {router: harness().router}).secondary.run();
    expect(apiJobs.dismiss).toHaveBeenCalledWith({jobId: 'job1'});
  });

  test('the router defaults to the registry\'s router provider', async () => {
    const router = {navigate: vi.fn()};
    const off = registry.provide('router', () => router);
    try {
      const out = describeError(failedJob('account_paused'), {jobs: harness().jobs});
      await out.primary.run();
      expect(router.navigate).toHaveBeenCalledWith('/settings/plan', {});
    } finally {
      off();
    }
  });
});

describe('every code', () => {
  const ALL = [...new Set([...CODES, ...JOB_ERROR_CODES, ...RENDERER_CODES, ...LOOKUP_CODES])];

  test('§6.1 codes and job codes are all known here', () => {
    expect(CODES).toContain('artwork_expired');
    expect(JOB_ERROR_CODES).toContain('beats_unavailable');
  });

  test.each(ALL.flatMap(code => CONTEXTS.flatMap(context => [['api', code, context], ['job', code, context]])))(
    '%s %s in %s: a sentence, valid actions and details', async (kind, code, context) => {
      const deps = harness();
      const input = kind === 'job' ? failedJob(code) : {code, message: `raw ${code}`, data: {}};
      const out = describeError(input, {context, ...deps});
      expect(out.code).toBe(code);
      expect(typeof out.sentence).toBe('string');
      expect(out.sentence.length).toBeGreaterThan(8);
      expect(out.sentence).not.toMatch(/\{\w+\}|undefined|null/);
      expect(out.sentence).not.toMatch(/FLAC|Retry the desktop connection/);
      expect(out.details).toBe(kind === 'job' ? `raw ${code} text` : `raw ${code}`);
      for (const action of [out.primary, out.secondary].filter(Boolean)) {
        expect(TARGET_SET.has(action.target)).toBe(true);
        expect(await reached(action, deps)).toEqual([action.target]);
      }
      // A secondary always has a primary before it, except where Details is the spec primary.
      if (out.secondary) expect(out.primary !== undefined || out.detailsFirst).toBe(true);
    });

  test('§2.10 additions', () => {
    const deps = harness();
    expect(describeError(failedJob('beats_unavailable'), {context: 'detect', ...deps}).sentence).toBe('Bar detection isn’t installed on this computer.');
    expect(describeError({code: 'resplit_wrong_device', data: {deviceName: 'MacBook Pro'}}, {context: 'resplit', ...deps}).sentence)
      .toBe('Re-split this song on MacBook Pro, which has the original file.');
    expect(describeError({code: 'resplit_wrong_device'}, {context: 'resplit', device: 'Studio PC', ...deps}).sentence)
      .toBe('Re-split this song on Studio PC, which has the original file.');
    const exportOnly = describeError({code: 'account_export_only', message: 'Your account is in export-only mode.'}, {context: 'add', ...deps});
    expect(exportOnly.sentence).toBe('Adding songs is paused on this account.');
    expect(exportOnly.primary.label).toBe('Plan & storage');
    expect(exportOnly.details).toBe('Your account is in export-only mode.');
  });

  test('unknown errors read per context; anything thrown is accepted', () => {
    expect(describeError(new Error('socket hang up'), {context: 'save'})).toMatchObject({code: 'unknown', sentence: 'Your change couldn’t be saved.', details: 'socket hang up'});
    expect(describeError('plain text', {context: 'share'})).toMatchObject({sentence: 'Sharing didn’t work.', details: 'plain text'});
    expect(describeError(null, {context: 'load'})).toMatchObject({sentence: 'This song couldn’t be loaded.', details: 'No further details.'});
    expect(describeError({code: 'not_found'}, {context: 'share'}).sentence).toBe(SENTENCES.missingShare);
    expect(describeError({code: 'mystery_code'}, {context: 'nonsense'}).sentence).toBe(ROWS.unknown.sentence);
  });

  test('copyFor is pure and covers the bot-check split', () => {
    expect(copyFor('bot_check', {kind: 'job', retryAt: 1})).toMatchObject({primary: LABELS.tryNow});
    expect(copyFor('bot_check', {kind: 'job'})).toMatchObject({primary: LABELS.searchAnother});
    expect(copyFor('bot_check', {kind: 'api', context: 'add'})).toMatchObject({primary: LABELS.uploadInstead});
  });
});

describe('stored jobs from before error codes', () => {
  test.each([
    ['ERROR: [youtube] abc: Sign in to confirm you’re not a bot', 'bot_check'],
    ['ERROR: Private video. Sign in if you\'ve been granted access', 'unavailable'],
    ['OSError: [Errno 28] No space left on device', 'disk_full'],
    ['Your cloud library is full. Upgrade in Plan & billing…', 'storage_full'],
    ['Your account is in export-only mode. Playback and library export remain available.', 'account_paused'],
    ['Original file is not on this computer. Add it again.', 'source_missing'],
    ['No audio could be downloaded.', 'not_found'],
    ['Sync upload failed (502). Your local files are safe.', 'sync_failed'],
    ['ModuleNotFoundError: No module named \'BeatNet\'', 'beats_unavailable'],
    ['MemoryError', 'separation_failed'],
    ['something else entirely', 'unknown'],
  ])('%s → %s', (error, code) => {
    expect(legacyJobCode(error)).toBe(code);
    expect(describeError({jobId: 'j', status: 'error', error}, harness()).code).toBe(code);
  });
});

describe('codec copy', () => {
  test('one sentence, without FLAC', () => {
    expect(codecErrorMessage).toBe('This browser can’t play Woodshed’s audio format. Use Chrome, Edge, Firefox or Safari 15 or later.');
    expect(codecErrorMessage).not.toMatch(/flac/i);
    expect(describeError({code: 'codec'}, {context: 'load'}).sentence).toBe(codecErrorMessage);
  });

  test('offline copy is the spec sentence', () => {
    expect(SENTENCES.offline).toBe('You’re offline. Songs you’ve opened recently can still play.');
    expect(describeError({code: 'offline'}, {context: 'load'}).sentence).toBe(SENTENCES.offline);
  });
});

afterEach(() => vi.restoreAllMocks());
