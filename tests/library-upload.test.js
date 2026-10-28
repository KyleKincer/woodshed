// @vitest-environment happy-dom
// LB2a: file uploads (architecture §2.16, spec §3.2/§3.4): real XHR progress, cancel before createSeparation
// (the S1 bug), the device id fetched once per batch, error mapping for describeError, and the entries the Jobs
// model (LB1b) reads from store.library.uploads.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

vi.mock('../src/api/jobs.js', () => ({createSeparation: vi.fn(), cancel: vi.fn()}));
vi.mock('../src/js/companion.js', () => ({requireCompanion: vi.fn(), uploadXHR: vi.fn()}));

const jobs = await import('../src/api/jobs.js');
const companion = await import('../src/js/companion.js');
const {store} = await import('../src/app/store.js');
const {CANCEL_RETRY_MS, MAX_UPLOAD_BYTES, COPY, startUpload, startUploads, uploadDevice, uploadError} = await import('../src/library/upload.js');
const {describeError} = await import('../src/app/error-copy.js');

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); };
const file = (name, size = 31_200_000) => ({name, size, type: 'audio/wav'});
const SETTINGS = {preset: 'balanced', stemMode: 'full'};
const abortError = () => Object.assign(new Error('The request was canceled.'), {code: 'aborted', name: 'AbortError'});

/** A controllable uploadXHR: each call is recorded with its file, signal and progress callback. */
let uploads;
function controlUploads() {
  uploads = [];
  companion.uploadXHR.mockImplementation((f, {signal, onProgress}) => new Promise((resolve, reject) => {
    const call = {file: f, signal, onProgress, resolve: id => resolve({id}), reject};
    signal?.addEventListener('abort', () => reject(abortError()), {once: true});
    uploads.push(call);
  }));
}

let jobSeq;
beforeEach(() => {
  store.library.uploads.value = [];
  jobSeq = 0;
  controlUploads();
  companion.requireCompanion.mockReset().mockResolvedValue('dev-local');
  jobs.createSeparation.mockReset().mockImplementation(async () => ({jobId: `job-${++jobSeq}`}));
  jobs.cancel.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  store.library.uploads.value = [];
});

const entries = () => store.library.uploads.peek();

describe('one upload', () => {
  test('real bytes, then the job; the entry leaves the list once the job exists', async () => {
    const h = startUpload(file('garage-take-4.wav'), {settings: SETTINGS});
    expect(h.state.value).toBe('uploading');
    expect(h.progress.value).toEqual({loaded: 0, total: 31_200_000});
    expect(entries()).toEqual([h]);
    expect(h).toMatchObject({name: 'garage-take-4.wav', title: null});

    await flush();
    expect(companion.requireCompanion).toHaveBeenCalledTimes(1);
    expect(h.deviceId).toBe('dev-local');
    expect(uploads).toHaveLength(1);
    uploads[0].onProgress({loaded: 12_400_000, total: 31_200_000});
    expect(h.progress.value).toEqual({loaded: 12_400_000, total: 31_200_000});
    uploads[0].onProgress({loaded: 40_000_000, total: 0});    // a progress event without a total: the file size
    expect(h.progress.value).toEqual({loaded: 31_200_000, total: 31_200_000});
    expect(jobs.createSeparation).not.toHaveBeenCalled();

    uploads[0].resolve('3f0e8a52-1111-4222-8333-944455556666');
    await expect(h.promise).resolves.toEqual({jobId: 'job-1'});
    expect(jobs.createSeparation).toHaveBeenCalledWith({
      source: {type: 'upload', value: '3f0e8a52-1111-4222-8333-944455556666', filename: 'garage-take-4.wav'},
      deviceId: 'dev-local', settings: SETTINGS, label: 'garage-take-4.wav',
    });
    expect(h.state.value).toBe('queued');
    expect(h.jobId).toBe('job-1');
    expect(entries()).toEqual([]);
  });

  test('a title override travels as the job meta title; the label stays the file name', async () => {
    const h = startUpload(file('take 4 FINAL (2).wav'), {settings: SETTINGS, deviceId: 'dev-9', title: '  Harbor   Lights  '});
    expect(h.title).toBe('Harbor Lights');
    await flush();
    expect(companion.requireCompanion).not.toHaveBeenCalled();     // the caller passed the device
    uploads[0].resolve('u-1');
    await h.promise;
    expect(jobs.createSeparation).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'dev-9', label: 'take 4 FINAL (2).wav', meta: {title: 'Harbor Lights'},
    }));
  });

  test('long names are cut to the server limits', async () => {
    const name = `${'x'.repeat(600)}.wav`;
    const h = startUpload(file(name), {settings: SETTINGS, deviceId: 'd', title: 'y'.repeat(400)});
    await flush();
    uploads[0].resolve('u');
    await h.promise;
    const args = jobs.createSeparation.mock.calls[0][0];
    expect(args.label).toHaveLength(500);
    expect(args.source.filename).toHaveLength(500);
    expect(args.meta.title).toHaveLength(300);
  });

  test('a file over 1 GB fails at once without sending a byte', async () => {
    const h = startUpload(file('huge.wav', MAX_UPLOAD_BYTES + 1), {settings: SETTINGS, deviceId: 'd'});
    await expect(h.promise).rejects.toMatchObject({code: 'unknown', message: COPY.tooLarge});
    expect(companion.uploadXHR).not.toHaveBeenCalled();
    expect(h.state.value).toBe('error');
    expect(entries()).toEqual([h]);
  });
});

describe('cancel (S1: no job after a cancel)', () => {
  test('while uploading: the XHR aborts and createSeparation never runs', async () => {
    const h = startUpload(file('a.wav'), {settings: SETTINGS});
    await flush();
    uploads[0].onProgress({loaded: 5, total: 10});
    await expect(h.cancel()).resolves.toBe(true);
    expect(uploads[0].signal.aborted).toBe(true);
    expect(h.state.value).toBe('canceled');
    expect(entries()).toEqual([]);
    await expect(h.promise).resolves.toBeNull();
    uploads[0].resolve('late');           // even a late answer creates nothing
    await flush();
    expect(jobs.createSeparation).not.toHaveBeenCalled();
    expect(jobs.cancel).not.toHaveBeenCalled();
  });

  test('while waiting for the device id', async () => {
    let answer;
    companion.requireCompanion.mockImplementation(() => new Promise(r => { answer = r; }));
    const h = startUpload(file('a.wav'), {settings: SETTINGS});
    await flush();
    await h.cancel();
    answer('dev-local');
    await flush();
    expect(companion.uploadXHR).not.toHaveBeenCalled();
    expect(jobs.createSeparation).not.toHaveBeenCalled();
  });

  test('while createSeparation is in flight: the job it returns is canceled at once', async () => {
    let created;
    jobs.createSeparation.mockImplementation(() => new Promise(r => { created = r; }));
    const h = startUpload(file('a.wav'), {settings: SETTINGS});
    await flush();
    uploads[0].resolve('u-1');
    await flush();
    expect(jobs.createSeparation).toHaveBeenCalledTimes(1);
    h.dismiss();                            // ignored: the upload is still live
    expect(entries()).toEqual([h]);
    const canceling = h.cancel();           // the answer waits for the job the in-flight call makes
    expect(h.state.value).toBe('canceled');
    expect(entries()).toEqual([]);
    created({jobId: 'job-late'});
    await flush();
    expect(jobs.cancel).toHaveBeenCalledWith({jobId: 'job-late'});
    await expect(canceling).resolves.toBe(true);
    await expect(h.promise).resolves.toBeNull();
  });

  test('while createSeparation is in flight and it then fails: no job, the cancel stands', async () => {
    let refuse;
    jobs.createSeparation.mockImplementation(() => new Promise((_, rej) => { refuse = rej; }));
    const h = startUpload(file('a.wav'), {settings: SETTINGS});
    await flush();
    uploads[0].resolve('u-1');
    await flush();
    const canceling = h.cancel();
    refuse(Object.assign(new Error('queue full'), {code: 'queue_full'}));
    await expect(canceling).resolves.toBe(true);
    await expect(h.promise).resolves.toBeNull();
    expect(jobs.cancel).not.toHaveBeenCalled();
    expect(h.state.value).toBe('canceled');
    expect(entries()).toEqual([]);
  });

  describe('a cancel that raced createSeparation, when jobs.cancel fails', () => {
    beforeEach(() => { vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']}); });
    afterEach(() => { vi.useRealTimers(); });

    async function raced() {
      let created;
      jobs.createSeparation.mockImplementation(() => new Promise(r => { created = r; }));
      const h = startUpload(file('a.wav'), {settings: SETTINGS});
      await vi.advanceTimersByTimeAsync(10);
      uploads[0].resolve('u-1');
      await vi.advanceTimersByTimeAsync(10);
      const canceling = h.cancel();
      created({jobId: 'job-late'});
      return {h, canceling};
    }

    test('it is tried again with backoff, and the cancel goes through', async () => {
      jobs.cancel.mockReset()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const {h, canceling} = await raced();
      await vi.advanceTimersByTimeAsync(CANCEL_RETRY_MS[0] + CANCEL_RETRY_MS[1] + 10);
      await expect(canceling).resolves.toBe(true);
      expect(jobs.cancel).toHaveBeenCalledTimes(3);
      await expect(h.promise).resolves.toBeNull();
      expect(h.state.value).toBe('canceled');
    });

    test('if it never goes through, cancel() says so and the handle is queued with its job', async () => {
      jobs.cancel.mockReset().mockRejectedValue(new Error('network'));
      const {h, canceling} = await raced();
      await vi.advanceTimersByTimeAsync(CANCEL_RETRY_MS.reduce((a, b) => a + b, 0) + 10);
      await expect(canceling).resolves.toBe(false);
      expect(jobs.cancel).toHaveBeenCalledTimes(CANCEL_RETRY_MS.length + 1);
      expect(h.state.value).toBe('queued');
      expect(h.jobId).toBe('job-late');
      await expect(h.promise).resolves.toEqual({jobId: 'job-late'});
      expect(entries()).toEqual([]);          // the job exists: its Jobs row (with Cancel) takes over
      jobs.cancel.mockReset().mockResolvedValue(true);
      await expect(h.cancel()).resolves.toBe(true);   // Undo can be tried again on the queued job
      expect(jobs.cancel).toHaveBeenCalledWith({jobId: 'job-late'});
    });
  });

  test('after the job exists: cancel is the Undo, jobs.cancel', async () => {
    const h = startUpload(file('a.wav'), {settings: SETTINGS});
    await flush();
    uploads[0].resolve('u-1');
    await h.promise;
    await expect(h.cancel()).resolves.toBe(true);
    expect(jobs.cancel).toHaveBeenCalledWith({jobId: 'job-1'});
    jobs.cancel.mockRejectedValueOnce(new Error('gone'));
    await expect(h.cancel()).resolves.toBe(false);
  });
});

describe('the settings a job runs with (add-model.js jobSettings)', () => {
  const sent = () => jobs.createSeparation.mock.calls.map(([args]) => args.settings);
  const STORED = {preset: 'studio', stemMode: 'drums', bitrate: 256};
  async function run(options) {
    const h = startUpload(file('a.wav'), {deviceId: 'dev-1', ...options});
    await flush();
    uploads.at(-1).resolve('u');
    await h.promise;
  }

  test('a stored two-part split (1.9) is never sent unless it was chosen', async () => {
    await run({settings: STORED, profile: {instruments: ['drums'], primary: 'drums'}});
    expect(sent().at(-1)).toEqual({...STORED, stemMode: 'full', preset: 'studio'});
    await run({settings: STORED, profile: {instruments: ['drums'], primary: 'drums'}, choice: {stemMode: 'drums'}});
    expect(sent().at(-1)).toMatchObject({stemMode: 'drums', preset: 'studio'});
  });

  test('guitar or keys means 6 stems; an unsaved legacy full is not a choice', async () => {
    await run({settings: {preset: 'balanced', stemMode: 'full'}, profile: {instruments: ['guitar'], primary: 'guitar'}});
    expect(sent().at(-1)).toMatchObject({stemMode: 'six', preset: 'balanced'});
    await run({settings: {preset: 'balanced', stemMode: 'full', addDefaultsSaved: true}, profile: {instruments: ['guitar'], primary: 'guitar'}});
    expect(sent().at(-1)).toMatchObject({stemMode: 'full'});
  });

  test('the Change choice of preset; no profile still drops a two-part default', async () => {
    await run({settings: STORED, choice: {preset: 'fast'}});
    expect(sent().at(-1)).toMatchObject({stemMode: 'full', preset: 'fast', bitrate: 256});
  });
});

describe('a batch', () => {
  test('the device id is fetched once; files upload one at a time, in order, and their jobs queue in order', async () => {
    const hs = startUploads([file('1.wav'), file('2.flac'), file('3.mp3')], {settings: SETTINGS});
    expect(hs.map(h => h.state.value)).toEqual(['uploading', 'uploading', 'uploading']);
    expect(entries()).toEqual(hs);
    await flush();
    expect(uploads.map(u => u.file.name)).toEqual(['1.wav']);
    uploads[0].resolve('u-1');
    await flush();
    expect(uploads.map(u => u.file.name)).toEqual(['1.wav', '2.flac']);
    uploads[1].resolve('u-2');
    await flush();
    uploads[2].resolve('u-3');
    await Promise.all(hs.map(h => h.promise));
    expect(companion.requireCompanion).toHaveBeenCalledTimes(1);
    expect(jobs.createSeparation.mock.calls.map(([a]) => a.source.value)).toEqual(['u-1', 'u-2', 'u-3']);
    expect(hs.map(h => h.jobId)).toEqual(['job-1', 'job-2', 'job-3']);
    expect(entries()).toEqual([]);
  });

  test('titles per file (array or Map); `title` applies only to a single file', async () => {
    const a = file('a.wav'), b = file('b.wav');
    let hs = startUploads([a, b], {settings: SETTINGS, deviceId: 'd', title: 'Ignored', titles: new Map([[b, 'Bee']])});
    expect(hs.map(h => h.title)).toEqual([null, 'Bee']);
    hs.forEach(h => h.cancel());
    hs = startUploads([a, b], {settings: SETTINGS, deviceId: 'd', titles: ['Ay', '']});
    expect(hs.map(h => h.title)).toEqual(['Ay', null]);
    hs.forEach(h => h.cancel());
    expect(startUploads([], {settings: SETTINGS})).toEqual([]);
    expect(startUploads(null, {settings: SETTINGS})).toEqual([]);
  });

  test('canceling the uploading file starts the next; canceling a waiting file skips it', async () => {
    const hs = startUploads([file('1.wav'), file('2.wav'), file('3.wav')], {settings: SETTINGS});
    await flush();
    await hs[1].cancel();                   // waiting: it never uploads
    expect(uploads).toHaveLength(1);        // and the third still waits for the first
    await hs[0].cancel();
    await flush();
    expect(uploads.map(u => u.file.name)).toEqual(['1.wav', '3.wav']);
    uploads[1].resolve('u-3');
    await hs[2].promise;
    expect(jobs.createSeparation).toHaveBeenCalledTimes(1);
    expect(jobs.createSeparation.mock.calls[0][0].source.value).toBe('u-3');
  });

  test('the next file uploads while the previous becomes a job', async () => {
    let created;
    jobs.createSeparation.mockImplementationOnce(() => new Promise(r => { created = r; }));
    const hs = startUploads([file('1.wav'), file('2.wav')], {settings: SETTINGS, deviceId: 'd'});
    await flush();
    uploads[0].resolve('u-1');
    await flush();
    expect(uploads).toHaveLength(2);
    created({jobId: 'job-a'});
    await expect(hs[0].promise).resolves.toEqual({jobId: 'job-a'});
  });

  test('without a processor every file fails with processor_offline, after one lookup; a retry asks again', async () => {
    const offline = Object.assign(new Error('Open Woodshed for desktop to process songs on this computer.'), {code: 'processor_offline'});
    companion.requireCompanion.mockRejectedValue(offline);
    const hs = startUploads([file('1.wav'), file('2.wav')], {settings: SETTINGS});
    await Promise.allSettled(hs.map(h => h.promise));
    await flush();
    expect(companion.requireCompanion).toHaveBeenCalledTimes(1);
    expect(hs.map(h => h.state.value)).toEqual(['error', 'error']);
    expect(hs[0].error.value).toMatchObject({code: 'processor_offline', message: offline.message});
    expect(describeError(hs[0].error.value, {context: 'add'}).sentence).toBe('Woodshed’s processor isn’t running on this computer.');
    expect(entries()).toEqual(hs);          // failed uploads stay until dismissed

    companion.requireCompanion.mockResolvedValue('dev-local');
    const again = hs[0].retry();
    expect(hs[0].state.value).toBe('uploading');
    expect(hs[0].error.value).toBeNull();
    await flush();
    expect(companion.requireCompanion).toHaveBeenCalledTimes(2);
    uploads[0].resolve('u-1');
    await expect(again).resolves.toEqual({jobId: 'job-1'});
    expect(hs[0].promise).toBe(again);
    expect(entries()).toEqual([hs[1]]);
    hs[1].dismiss();
    expect(entries()).toEqual([]);
  });
});

describe('failures', () => {
  test('a failed upload stays as an error entry; retry uploads the same file again (S2)', async () => {
    const h = startUpload(file('a.wav'), {settings: SETTINGS, deviceId: 'd'});
    await flush();
    uploads[0].reject(Object.assign(new Error('The upload to Woodshed’s processor was interrupted.'), {code: 'processor_offline'}));
    await expect(h.promise).rejects.toMatchObject({code: 'processor_offline'});
    expect(h.state.value).toBe('error');
    expect(h.retry).toBeTypeOf('function');
    const again = h.retry();
    await flush();
    expect(uploads).toHaveLength(2);
    expect(uploads[1].file).toBe(h.file);
    uploads[1].resolve('u-2');
    await expect(again).resolves.toEqual({jobId: 'job-1'});
    expect(h.retry()).toBe(again);           // nothing to retry once it worked
  });

  test('createSeparation refusals keep their code (queue full, paused account, unpaired device)', async () => {
    for (const code of ['queue_full', 'account_export_only', 'device_unpaired', 'storage_full_user']) {
      jobs.createSeparation.mockRejectedValueOnce(Object.assign(new Error(`refused: ${code}`), {code, data: {code}}));
      const h = startUpload(file(`${code}.wav`), {settings: SETTINGS, deviceId: 'd'});
      await flush();
      uploads.at(-1).resolve('u');
      await expect(h.promise).rejects.toMatchObject({code});
      expect(h.error.value.code).toBe(code);
      h.dismiss();
    }
    expect(entries()).toEqual([]);
  });

  test('dismiss and cancel on a failed entry remove it', async () => {
    const h = startUpload(file('big.wav', MAX_UPLOAD_BYTES * 2), {settings: SETTINGS, deviceId: 'd'});
    await h.promise.catch(() => {});
    await expect(h.cancel()).resolves.toBe(false);
    expect(entries()).toEqual([]);
  });

  test.each([
    // [label, thrown, mapped code | null]
    ['a cancel', {code: 'aborted', name: 'AbortError', message: 'The request was canceled.'}, null],
    ['an AbortError without a code', Object.assign(new Error('x'), {name: 'AbortError'}), null],
    ['processor offline', {code: 'processor_offline', message: 'not running'}, 'processor_offline'],
    ['timeout keeps its code', {code: 'timeout', message: 'slow'}, 'timeout'],
    ['companion 400: full disk', {code: 'unknown', message: 'ENOSPC: no space left on device, write'}, 'disk_full'],
    ['companion 400: not paired', {code: 'unknown', message: 'Pair the companion in Settings first.'}, 'processor_offline'],
    ['companion 400: revoked', {code: 'unknown', message: 'This computer was disconnected by an administrator.'}, 'device_revoked_admin'],
    ['companion 400: too large', {code: 'unknown', message: 'File too large.'}, 'unknown'],
    ['an API error code', {code: 'queue_full', message: 'Process the queued songs before adding more.', data: {code: 'queue_full'}}, 'queue_full'],
    ['a plain Error', new Error('boom'), 'unknown'],
    ['a string', 'boom', 'unknown'],
    ['nothing', null, 'unknown'],
  ])('uploadError: %s', (_, thrown, code) => {
    const mapped = uploadError(thrown);
    if (code === null) { expect(mapped).toBeNull(); return; }
    expect(mapped.code).toBe(code);
    expect(mapped.raw).toBe(thrown);
    expect(mapped).not.toHaveProperty('status');         // never read as a job row by describeError
    expect(describeError(mapped, {context: 'add'}).sentence).toBeTruthy();
  });

  test('a full disk reads as the Disk full row', () => {
    const copy = describeError(uploadError({code: 'unknown', message: 'no space left on device'}), {context: 'add'});
    expect(copy.sentence).toBe('This computer is out of space for processing.');
  });

  test('uploadDevice maps the lookup failure', async () => {
    companion.requireCompanion.mockRejectedValueOnce({code: 'unknown', message: 'Pair the companion in Settings first.'});
    await expect(uploadDevice()).rejects.toMatchObject({code: 'processor_offline'});
    companion.requireCompanion.mockResolvedValueOnce('dev-2');
    await expect(uploadDevice()).resolves.toBe('dev-2');
  });
});

describe('the Jobs model reads the entries (LB1b)', () => {
  test('an upload row with real bytes, and a failed one with its sentence and Dismiss', async () => {
    vi.doMock('../src/api/media.js', () => ({signKeys: vi.fn(async () => ({}))}));
    const {createJobsModel} = await import('../src/library/jobs.js');
    const model = createJobsModel({
      store, api: {get: vi.fn(), cancel: vi.fn(), dismiss: vi.fn(), retry: vi.fn(), markApplied: vi.fn()},
      desktop: {available: true, refreshStatus: vi.fn(), watchStatus: () => () => {}, restartProcessor: vi.fn()},
      now: () => Date.parse('2026-10-28T12:00:00Z'), timer: {set: () => 1, clear: () => {}}, notify: () => {},
    });
    const live = startUpload(file('garage-take-4.wav'), {settings: SETTINGS, deviceId: 'dev-local'});
    const bad = startUpload(file('huge.wav', MAX_UPLOAD_BYTES + 5), {settings: SETTINGS, deviceId: 'dev-local'});
    await bad.promise.catch(() => {});
    await flush();
    uploads[0].onProgress({loaded: 12_400_000, total: 31_200_000});
    const row = id => model.items.value.find(i => i.id === `upload:${id}`);
    expect(row(live.id)).toMatchObject({kind: 'upload', status: 'running', title: 'garage-take-4.wav', line: 'Uploading · 12 of 31 MB'});
    expect(row(bad.id)).toMatchObject({kind: 'upload', status: 'error'});
    await row(live.id).actions.find(a => a.label === 'Cancel').run();
    expect(live.state.value).toBe('canceled');
    expect(row(live.id)).toBeUndefined();
    await row(bad.id).actions.find(a => a.label === 'Dismiss').run();
    expect(entries()).toEqual([]);
    model.destroy();
  });
});
