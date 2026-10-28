// @vitest-environment happy-dom
// The fixture's jobs handlers (tests/fixture/db/jobs.js, BK2) mirror
// convex/jobs.ts: the row and detail shapes, listing, the creation rules and
// coded errors, detection dedupe, retry, and the applied-detection offer.
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

globalThis.__FX_DB_MANUAL_BOOT__ = true;
const {boot, call} = await import('../db/index.js');
const runtime = await import('../db/runtime.js');
const {jobRowValidator, jobDetailValidator} = await import('../../../convex/jobs.ts');

const NOW = Date.parse('2026-10-28T09:00:00Z');
const store = () => ({map: new Map(), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, String(v)); }, removeItem(k) { this.map.delete(k); }});
const start = (search = '') => boot({search, store: store(), now: NOW});
const errorOf = promise => promise.then(() => null, error => error.data ?? {message: error.message});
const codeOf = async promise => (await errorOf(promise))?.code ?? null;
const rowKeys = Object.keys(jobRowValidator.fields).sort();
const detailKeys = Object.keys(jobDetailValidator.fields).sort();
const raw = id => runtime.db.jobs.find(j => j.jobId === id);
const separation = (extra = {}) => ({deviceId: 'dev1', source: {type: 'search', value: 'marisol vega satellites'}, settings: {preset: 'fast'}, label: 'marisol vega satellites', ...extra});

beforeEach(() => start());
afterEach(() => vi.useRealTimers());

describe('rows', () => {
  it('listActive returns live and failed jobs as server rows, sorted by createdAt', async () => {
    const rows = await call('query', 'jobs:listActive');
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(rowKeys);
    expect(rows.every(r => ['queued', 'running', 'error'].includes(r.status))).toBe(true);
    for (let i = 1; i < rows.length; i++) expect(rows[i].createdAt).toBeGreaterThanOrEqual(rows[i - 1].createdAt);
    expect(rows.find(r => r.jobId === 'job-run')).toMatchObject({kind: 'separate', deviceId: 'dev1', confirmed: true, settingsSummary: {preset: 'balanced', stemMode: 'full', model: 'htdemucs_ft'}, source: {type: 'url', filename: null}});
    expect(rows.find(r => r.jobId === 'job-bot')).toMatchObject({status: 'error', errorCode: 'bot_check', retryAt: expect.any(Number)});
    expect(rows.find(r => r.jobId === 'job-beats')).toMatchObject({kind: 'beats', chainedFrom: 'job-done-quiet', settingsSummary: null});
    expect(rows.find(r => r.jobId === 'job-import')).toMatchObject({kind: 'import', source: null, settingsSummary: null});
    expect(rows.find(r => r.jobId === 'job-q')).toMatchObject({confirmed: false, startedAt: null});
    expect(rows.some(r => r.jobId === 'job-detect-nightbus')).toBe(false);
  });

  it('get returns the detail, with a result only for a done detection', async () => {
    const done = await call('query', 'jobs:get', {jobId: 'job-detect-nightbus'});
    expect(Object.keys(done).sort()).toEqual(detailKeys);
    expect(done.result.beats.length).toBeGreaterThan(100);
    expect(await call('query', 'jobs:get', {jobId: 'job-beats'})).toMatchObject({status: 'running', result: null, appliedAt: null});
    expect(await call('query', 'jobs:get', {jobId: 'nope'})).toBeNull();
  });
});

describe('latestDetection and markApplied (D44)', () => {
  it('offers the unapplied user detection once', async () => {
    expect(await call('query', 'jobs:latestDetection', {songId: 'nightbus'})).toMatchObject({jobId: 'job-detect-nightbus', appliedAt: null});
    expect(await call('mutation', 'jobs:markApplied', {jobId: 'job-detect-nightbus'})).toBeNull();
    expect(raw('job-detect-nightbus').appliedAt).toEqual(expect.any(Number));
    expect(await call('query', 'jobs:latestDetection', {songId: 'nightbus'})).toBeNull();
  });

  it('never offers a chained detection, or a song without one', async () => {
    expect(await call('query', 'jobs:latestDetection', {songId: 'velvet'})).toBeNull();
    expect(await call('query', 'jobs:latestDetection', {songId: 'quiet'})).toBeNull();
    expect(await call('query', 'jobs:latestDetection', {songId: 'missing'})).toBeNull();
  });

  it('markApplied refuses anything but a done beats job', async () => {
    expect(await codeOf(call('mutation', 'jobs:markApplied', {jobId: 'job-beats'}))).toBe('invalid');
    expect(await codeOf(call('mutation', 'jobs:markApplied', {jobId: 'job-done-quiet'}))).toBe('invalid');
    expect(await codeOf(call('mutation', 'jobs:markApplied', {jobId: 'nope'}))).toBe('not_found');
  });
});

describe('createSeparation', () => {
  it('stores meta and confirmed, returns only the job id, and is claimed after 1.5 s', async () => {
    vi.useFakeTimers({now: NOW});
    const result = await call('mutation', 'jobs:createSeparation', separation({confirmed: true, meta: {title: ' Satellites ', thumbnail: 'https://i.ytimg.com/x.jpg', duration: 201}}));
    expect(Object.keys(result)).toEqual(['jobId']);
    expect(raw(result.jobId)).toMatchObject({status: 'queued', deviceId: 'dev1', confirmed: true, meta: {title: 'Satellites', thumbnail: 'https://i.ytimg.com/x.jpg', duration: 201}, settings: {preset: 'fast'}});
    const row = (await call('query', 'jobs:listActive')).find(r => r.jobId === result.jobId);
    expect(row).toMatchObject({status: 'queued', settingsSummary: {preset: 'fast', stemMode: 'full', model: 'htdemucs'}});
    vi.advanceTimersByTime(1600);
    expect(raw(result.jobId)).toMatchObject({status: 'running', stage: 'download', meta: {title: 'Satellites'}});
  });

  it('validates meta, settings, labels and the computer', async () => {
    expect(await errorOf(call('mutation', 'jobs:createSeparation', separation({meta: {thumbnail: 'http://i.ytimg.com/x.jpg'}})))).toMatchObject({code: 'invalid', field: 'meta.thumbnail'});
    expect(await errorOf(call('mutation', 'jobs:createSeparation', separation({meta: {title: 'x'.repeat(301)}})))).toMatchObject({code: 'invalid', field: 'meta.title'});
    expect(await errorOf(call('mutation', 'jobs:createSeparation', separation({settings: {stemMode: 'eight'}})))).toMatchObject({code: 'invalid', field: 'settings.stemMode'});
    expect(await errorOf(call('mutation', 'jobs:createSeparation', separation({label: 'x'.repeat(501)})))).toMatchObject({code: 'invalid', field: 'label'});
    expect(await codeOf(call('mutation', 'jobs:createSeparation', separation({deviceId: 'dev9'})))).toBe('device_unpaired');
    runtime.db.devices.find(d => d.id === 'dev2').revoked = true;
    runtime.db.devices.find(d => d.id === 'dev2').revokedBy = 'admin';
    expect(await codeOf(call('mutation', 'jobs:createSeparation', separation({deviceId: 'dev2'})))).toBe('device_revoked_admin');
  });

  it('a re-split of an uploaded song runs only where the file is (D38)', async () => {
    const resplit = deviceId => call('mutation', 'jobs:createSeparation', {deviceId, settings: {}, label: 'untitled_jam_03.wav', replaceSongId: 'jam03'});
    expect(await errorOf(resplit('dev2'))).toMatchObject({code: 'resplit_wrong_device', deviceName: 'Studio MacBook'});
    const {jobId} = await resplit('dev1');
    expect(raw(jobId)).toMatchObject({songId: 'jam03', source: {type: 'upload', value: 'local1'}, deviceId: 'dev1'});
  });

  it('the per-computer queue cap, and export-only accounts', async () => {
    for (let i = 0; i < 20; i++) runtime.db.jobs.push({jobId: `filler-${i}`, kind: 'separate', status: 'queued', stage: 'queued', percent: 0, label: 'x', deviceId: 'dev2', createdAt: NOW, updatedAt: NOW});
    expect(await codeOf(call('mutation', 'jobs:createSeparation', separation({deviceId: 'dev2'})))).toBe('queue_full');
    start('?fx-auth=export_only');
    expect(await codeOf(call('mutation', 'jobs:createSeparation', separation()))).toBe('account_export_only');
    expect(await codeOf(call('mutation', 'jobs:createBeatDetection', {songId: 'quiet'}))).toBe('account_export_only');
  });
});

describe('detections', () => {
  it('a live detection the fixture created is reused, on the chosen computer', async () => {
    vi.useFakeTimers({now: NOW});
    const first = await call('mutation', 'jobs:createBeatDetection', {songId: 'velvet', deviceId: 'dev2'});
    expect(raw(first.jobId)).toMatchObject({deviceId: 'dev2', settings: {sections: true}, status: 'running'});
    expect(await call('mutation', 'jobs:createBeatDetection', {songId: 'velvet'})).toEqual(first);
    vi.advanceTimersByTime(1600);
    expect(raw(first.jobId).status).toBe('done');
    // Done, user-started and unapplied: offered (velvet's mapped, so the session applies it).
    expect(await call('query', 'jobs:latestDetection', {songId: 'velvet'})).toMatchObject({jobId: first.jobId});
  });

  it('settings.sections follows the account, and computer refusals are coded', async () => {
    runtime.db.settings.autoSections = false;
    const {jobId} = await call('mutation', 'jobs:createBeatDetection', {songId: 'quiet'});
    expect(raw(jobId)).toMatchObject({settings: {sections: false}, deviceId: 'dev1'});
    expect(await codeOf(call('mutation', 'jobs:createBeatDetection', {songId: 'velvet', deviceId: 'dev9'}))).toBe('device_unpaired');
    expect(await codeOf(call('mutation', 'jobs:createBeatDetection', {songId: 'missing'}))).toBe('not_found');
    start('?fx-devices=none');
    expect(await codeOf(call('mutation', 'jobs:createBeatDetection', {songId: 'quiet'}))).toBe('device_unpaired');
  });

  it('section detection needs a real map and is deduplicated', async () => {
    expect(await codeOf(call('mutation', 'jobs:createSectionDetection', {songId: 'quiet'}))).toBe('invalid');
    const first = await call('mutation', 'jobs:createSectionDetection', {songId: 'glasshouse'});
    expect(raw(first.jobId)).toMatchObject({kind: 'sections', songId: 'glasshouse', deviceId: 'dev1'});
    expect(await call('mutation', 'jobs:createSectionDetection', {songId: 'glasshouse'})).toEqual(first);
  });
});

describe('job card actions', () => {
  it('retry re-queues a failed job; with a preset it re-resolves the settings', async () => {
    await call('mutation', 'jobs:retry', {jobId: 'job-fail'});
    const j = raw('job-fail');
    expect(j).toMatchObject({status: 'queued', stage: 'queued', percent: 0, message: 'Resuming local files…'});
    for (const key of ['error', 'errorCode', 'retryAt']) expect(j[key]).toBeUndefined();
    await call('mutation', 'jobs:retry', {jobId: 'job-bot', preset: 'fast'});
    expect(raw('job-bot').settings).toMatchObject({preset: 'fast', model: 'htdemucs', shifts: 0});
    expect((await call('query', 'jobs:listActive')).find(r => r.jobId === 'job-bot').settingsSummary).toEqual({preset: 'fast', stemMode: 'full', model: 'htdemucs'});
  });

  it('retry refusals', async () => {
    expect(await codeOf(call('mutation', 'jobs:retry', {jobId: 'job-run'}))).toBe('job_not_failed');
    expect(await errorOf(call('mutation', 'jobs:retry', {jobId: 'job-fail', deviceId: 'dev2'}))).toMatchObject({code: 'retry_wrong_device', deviceName: 'Studio MacBook'});
    expect(await errorOf(call('mutation', 'jobs:retry', {jobId: 'job-fail', preset: 'ultra'}))).toMatchObject({code: 'invalid', field: 'preset'});
  });

  it('cancel and dismiss', async () => {
    expect(await codeOf(call('mutation', 'jobs:dismiss', {jobId: 'job-run'}))).toBe('job_live');
    expect(await call('mutation', 'jobs:cancel', {jobId: 'job-run'})).toBe(true);
    expect(await call('mutation', 'jobs:cancel', {jobId: 'job-run'})).toBe(false);
    expect(await call('mutation', 'jobs:dismiss', {jobId: 'job-run'})).toBe(true);
    expect(raw('job-run')).toBeUndefined();
    expect(await call('mutation', 'jobs:dismiss', {jobId: 'job-run'})).toBe(false);
  });
});
