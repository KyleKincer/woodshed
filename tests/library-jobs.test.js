// @vitest-environment happy-dom
// LB1b: the jobs view-model (architecture §2.16, spec §2.8, §3.4, §3.5), the Jobs chip (spec §2.1) and the Jobs
// popover with its footer (spec §2.8, §3.3, §6.5). Behaviour, structure, roles and names only (happy-dom);
// geometry and targets are checked by the LB1b fixture states.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {signal, store as appStore} from '../src/app/store.js';
import {installPopoverShim, restoreDomShims} from './helpers/dom.js';

vi.mock('../src/api/media.js', () => ({signKeys: vi.fn(async keys => Object.fromEntries(keys.map(k => [k, `https://cdn.example/${k}`])))}));

const jobsModule = await import('../src/library/jobs.js');
const {
  createJobsModel, openJobsPopover, mountJobsChip, estimateRemaining, formatElapsed, formatEta, formatMB, settingsLine, sourceLink,
  stagesFor, aheadOf, deviceFor, closeJobsPopover, ETA_AFTER_MS, ETA_STALL_MS, TICK_MS, CONTROLS, jobsModel, sharedJobsModel,
} = jobsModule;
const {ACTIONS, CHIP, LINES, POPOVER, STAGES} = await import('../src/library/jobs.copy.js');

const T0 = Date.parse('2026-10-28T12:00:00Z');
const MIN = 60_000;
let t, ticks, models, mounts;

const now = () => t;
const timer = {
  set: vi.fn(fn => { ticks.push(fn); return ticks.length; }),
  clear: vi.fn(id => { ticks[id - 1] = null; }),
};
const tick = (ms = TICK_MS) => { t += ms; for (const fn of ticks) fn?.(); };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function fakeStore() {
  return {
    library: {songs: signal(new Map()), loaded: signal(true), jobs: signal([]), uploads: signal([]), devices: signal([]), setlists: signal([])},
    processor: signal({phase: 'web'}),
    stage: signal(null),
    account: signal(null),
    config: signal(null),
  };
}

function fakeApi() {
  return {
    get: vi.fn(async () => null),
    cancel: vi.fn(async () => true),
    dismiss: vi.fn(async () => true),
    retry: vi.fn(async () => null),
    markApplied: vi.fn(async () => null),
  };
}

function fakeDesktop(over = {}) {
  const offs = [];
  return {
    available: false,
    refreshStatus: vi.fn(async () => {}),
    watchStatus: vi.fn(() => { const off = vi.fn(); offs.push(off); return off; }),
    restartProcessor: vi.fn(async () => {}),
    retryPairing: vi.fn(async () => {}),
    offs,
    ...over,
  };
}

const DEVICES = [
  {deviceId: 'dev1', name: 'Kyle’s MacBook', lastSeenAt: T0 - 10_000, state: 'busy', currentJobId: 'run'},
  {deviceId: 'dev2', name: 'MacBook Pro', lastSeenAt: T0 - 3 * 864e5, state: 'offline', currentJobId: null},
];

const job = over => ({
  jobId: 'run', kind: 'separate', songId: null, label: 'Harbor Lights — Ada Moreno', status: 'running', stage: 'separate', percent: 46,
  message: 'Separating stems… (Apple GPU, pass 2/4)', error: null, meta: {title: 'Harbor Lights', artist: 'Ada Moreno'}, deviceId: 'dev1',
  createdAt: T0 - 4 * MIN, startedAt: T0 - 102_000, updatedAt: T0, attempts: 1, errorCode: null, retryAt: null, chainedFrom: null, confirmed: true,
  source: {type: 'url', value: 'https://www.youtube.com/watch?v=harbor01', filename: null},
  settingsSummary: {preset: 'balanced', stemMode: 'full', model: 'htdemucs_ft'}, ...over,
});

let s, api, desktop, router, notify;
function model(over = {}) {
  const m = createJobsModel({store: s, api, desktop, now, timer, router, notify, ...over});
  models.push(m);
  return m;
}
const byId = (m, id) => m.items.peek().find(i => i.id === id);

beforeEach(() => {
  t = T0;
  ticks = [];
  models = [];
  mounts = [];
  s = fakeStore();
  s.library.devices.value = DEVICES;
  api = fakeApi();
  desktop = fakeDesktop();
  router = {navigate: vi.fn()};
  notify = vi.fn();
  timer.set.mockClear();
  timer.clear.mockClear();
});

afterEach(() => {
  closeJobsPopover();
  for (const m of mounts.splice(0)) m.destroy?.() ?? m.close?.();
  for (const m of models.splice(0)) m.destroy();
  restoreDomShims();
  document.body.replaceChildren();
});

// ----------------------------------------------------------------------------------------- pure helpers

describe('helpers', () => {
  test('formatElapsed is m:ss, h:mm:ss from an hour', () => {
    expect(formatElapsed(102_000)).toBe('1:42');
    expect(formatElapsed(5_000)).toBe('0:05');
    expect(formatElapsed(3600_000 + 61_000)).toBe('1:01:01');
    expect(formatElapsed(-5)).toBe('0:00');
  });

  test('formatEta has a card and a popover style', () => {
    expect(formatEta(2 * MIN, {style: 'card'})).toBe('~2 min');
    expect(formatEta(2 * MIN, {style: 'popover'})).toBe('about 2 min left');
    expect(formatEta(30_000, {style: 'card'})).toBe('<1 min');
    expect(formatEta(30_000, {style: 'popover'})).toBe('less than a minute left');
    expect(formatEta(65 * MIN, {style: 'popover'})).toBe('about 1 h 5 min left');
    expect(formatEta(null)).toBeNull();
  });

  test('formatMB rounds whole megabytes from 10 MB and keeps one decimal below', () => {
    expect(formatMB(12.4e6)).toBe('12');
    expect(formatMB(31.2e6)).toBe('31');
    expect(formatMB(2.46e6)).toBe('2.5');
    expect(formatMB(0)).toBe('0');
  });

  test('settingsLine names the preset and the stems (spec §2.8)', () => {
    expect(settingsLine({preset: 'balanced', stemMode: 'full', model: 'htdemucs_ft'})).toBe('Balanced · 4 stems');
    expect(settingsLine({preset: 'fast', stemMode: 'six', model: 'htdemucs_6s'})).toBe('Fast · 6 stems');
    expect(settingsLine({preset: 'studio', stemMode: 'drums'})).toBe('Studio · Drums + rest');
    expect(settingsLine({preset: 'custom', stemMode: 'vocals'})).toBe('Custom · Vocals + rest');
    expect(settingsLine(null)).toBeNull();
  });

  test('sourceLink shortens http(s) links and ignores searches and uploads', () => {
    expect(sourceLink({type: 'url', value: 'https://www.youtube.com/watch?v=x'})).toEqual({label: 'youtube.com/…', url: 'https://www.youtube.com/watch?v=x'});
    expect(sourceLink({type: 'spotify', value: 'https://open.spotify.com/track/1'})?.label).toBe('open.spotify.com/…');
    expect(sourceLink({type: 'url', value: 'https://soundcloud.com/'})?.label).toBe('soundcloud.com');
    expect(sourceLink({type: 'search', value: 'harbor lights'})).toBeNull();
    expect(sourceLink({type: 'upload', value: 'up-1', filename: 'a.wav'})).toBeNull();
    expect(sourceLink({type: 'url', value: 'javascript:alert(1)'})).toBeNull();
  });

  test('stagesFor gives every job kind its stepper (spec §2.8)', () => {
    const labels = x => x.stages.map(st => st.label);
    expect(labels(stagesFor('separate', 'separate'))).toEqual([STAGES.fetch, STAGES.split, STAGES.finish, STAGES.ready]);
    expect(stagesFor('separate', 'separate').current).toBe('split');
    expect(stagesFor('separate', 'queued').current).toBeNull();
    expect(stagesFor('separate', 'finalize').current).toBe('finish');
    expect(labels(stagesFor('separate', 'download', {sourceType: 'upload'}))[0]).toBe(STAGES.prepare);
    expect(labels(stagesFor('upload'))).toEqual([STAGES.upload, STAGES.split, STAGES.finish, STAGES.ready]);
    expect(labels(stagesFor('beats', 'detect'))).toEqual([STAGES.bars, STAGES.ready]);
    expect(labels(stagesFor('sections', 'detect'))).toEqual([STAGES.sections, STAGES.ready]);
    expect(labels(stagesFor('import', 'finalize'))).toEqual([STAGES.copy, STAGES.finish, STAGES.ready]);
    expect(stagesFor('import', 'finalize').current).toBe('finish');
  });

  test('aheadOf counts running and older queued jobs on the same computer', () => {
    const jobs = [job({jobId: 'a'}), job({jobId: 'b', status: 'queued', stage: 'queued', createdAt: T0 - 3 * MIN}),
      job({jobId: 'c', status: 'queued', stage: 'queued', createdAt: T0 - 2 * MIN}), job({jobId: 'd', status: 'queued', stage: 'queued', deviceId: 'dev2'})];
    expect(aheadOf(jobs[2], jobs)).toBe(2);
    expect(aheadOf(jobs[1], jobs)).toBe(1);
    expect(aheadOf(jobs[3], jobs)).toBe(0);
    expect(aheadOf(jobs[0], jobs)).toBe(0);
  });

  test('deviceFor reads the name and presence; the local computer follows the processor', () => {
    expect(deviceFor('dev1', {devices: DEVICES, at: T0})).toEqual({id: 'dev1', name: 'Kyle’s MacBook', online: true, local: false});
    expect(deviceFor('dev2', {devices: DEVICES, at: T0}).online).toBe(false);
    const processor = {phase: 'offline', deviceId: 'dev1', name: 'Studio MacBook'};
    expect(deviceFor('dev1', {devices: DEVICES, processor, desktopAvailable: true, at: T0})).toEqual({id: 'dev1', name: 'Studio MacBook', online: false, local: true});
    expect(deviceFor(null, {devices: DEVICES, at: T0})).toBeNull();
  });

  test('estimateRemaining waits 15 s, follows a moving rate and hides an unstable one (spec §3.4)', () => {
    const steady = [[0, 10], [5000, 11], [10_000, 12], [15_000, 13], [20_000, 14]];
    expect(estimateRemaining(steady.slice(0, 3), 10_000)).toBeNull();               // seen for under 15 s
    expect(ETA_AFTER_MS).toBe(15_000);
    const eta = estimateRemaining(steady, 20_000);                                  // 1% per 5 s, 86% left
    expect(eta).toBeCloseTo(86 * 5000, -2);
    expect(estimateRemaining(steady, 20_000 + ETA_STALL_MS + 1)).toBeNull();      // nothing moved for too long
    const jumpy = [[0, 10], [5000, 10.2], [10_000, 10.4], [15_000, 30], [20_000, 50]];
    expect(estimateRemaining(jumpy, 20_000)).toBeNull();                            // the newer half is far faster
    const slowing = [[0, 10], [5000, 20], [10_000, 30], [15_000, 30.5], [20_000, 31]];
    expect(estimateRemaining(slowing, 20_000)).toBeNull();                          // … or far slower
    expect(estimateRemaining([[0, 10], [20_000, 10]], 20_000)).toBeNull();          // no progress
  });
});

// ----------------------------------------------------------------------------------------- the model

describe('createJobsModel: rows', () => {
  test('a running split: stepper, card line, popover line, settings, message, source and Cancel', () => {
    s.library.jobs.value = [job()];
    const m = model();
    const vm = byId(m, 'run');
    expect(vm.kind).toBe('separate');
    expect(vm.title).toBe('Harbor Lights');
    expect(vm.quoted).toBe(false);
    expect(vm.stages.map(x => x.state)).toEqual(['done', 'current', 'pending', 'pending']);
    expect(vm.percent).toBe(46);
    expect(vm.line).toBe('Splitting · 46%');
    expect(vm.activity).toBe('Splitting on Kyle’s MacBook · started 1:42 ago');
    expect(vm.rail).toEqual({value: 0.46, striped: false});
    expect(vm.settingsLine).toBe('Balanced · 4 stems');
    expect(vm.message).toBe('Separating stems… (Apple GPU, pass 2/4)');
    expect(vm.source).toEqual({label: 'youtube.com/…', url: 'https://www.youtube.com/watch?v=harbor01'});
    expect(vm.device).toEqual({id: 'dev1', name: 'Kyle’s MacBook', online: true, local: false});
    expect(vm.actions.map(a => [a.label, a.tone])).toEqual([[ACTIONS.cancel, 'danger']]);
    expect(vm.failure).toBeNull();
  });

  test('a search without a title yet is quoted; the title replaces it once job.meta.title arrives', () => {
    s.library.jobs.value = [job({jobId: 'q', status: 'queued', stage: 'queued', meta: null, label: 'harbor lights ada moreno',
      source: {type: 'search', value: 'harbor lights ada moreno', filename: null}, createdAt: T0})];
    const m = model();
    expect(byId(m, 'q')).toMatchObject({title: 'harbor lights ada moreno', quoted: true, source: null});
    s.library.jobs.value = [job({jobId: 'q', status: 'queued', stage: 'queued', meta: {title: 'Harbor Lights'}, source: {type: 'search', value: 'harbor lights ada moreno'}})];
    expect(byId(m, 'q')).toMatchObject({title: 'Harbor Lights', quoted: false});
  });

  test('every stage has its card line (spec §3.4)', () => {
    s.library.jobs.value = [
      job({jobId: 'dl', stage: 'download', percent: 38}),
      job({jobId: 'up', stage: 'download', percent: 40, source: {type: 'upload', value: 'up-7', filename: 'take.wav'}, meta: null, label: 'take.wav'}),
      job({jobId: 'fin', stage: 'finalize', percent: 90}),
      job({jobId: 'beats', kind: 'beats', stage: 'detect', percent: 30, songId: 'quiet', settingsSummary: null, source: null}),
      job({jobId: 'sec', kind: 'sections', stage: 'detect', percent: 20, songId: 'lanterns', settingsSummary: null, source: null}),
      job({jobId: 'imp', kind: 'import', stage: 'finalize', percent: 60, label: 'Old Friends', meta: null, settingsSummary: null, source: null}),
    ];
    s.library.songs.value = new Map([['quiet', {id: 'quiet', title: 'Quiet Hours', artist: 'Northbound'}], ['lanterns', {id: 'lanterns', title: 'Paper Lanterns'}]]);
    const m = model();
    expect(byId(m, 'dl').line).toBe('Fetching audio · 38%');
    expect(byId(m, 'up')).toMatchObject({line: 'Preparing audio · 40%', title: 'take.wav', quoted: false});
    expect(byId(m, 'fin')).toMatchObject({line: 'Finishing', percent: null, rail: {value: null, striped: false}});
    expect(byId(m, 'beats')).toMatchObject({line: 'Finding bars · 30%', title: 'Quiet Hours', settingsLine: null, kind: 'beats'});
    expect(byId(m, 'beats').stages.map(x => x.label)).toEqual([STAGES.bars, STAGES.ready]);
    expect(byId(m, 'sec')).toMatchObject({line: 'Finding sections · 20%', title: 'Paper Lanterns', kind: 'sections'});
    expect(byId(m, 'imp')).toMatchObject({line: 'Finishing', title: 'Old Friends', kind: 'import'});
  });

  test('queued: the ahead count, or the offline computer it waits for', () => {
    s.library.jobs.value = [
      job({jobId: 'a'}),
      job({jobId: 'b', status: 'queued', stage: 'queued', createdAt: T0 - 2 * MIN}),
      job({jobId: 'c', status: 'queued', stage: 'queued', createdAt: T0 - MIN}),
      job({jobId: 'd', status: 'queued', stage: 'queued', deviceId: 'dev2', createdAt: T0}),
    ];
    const m = model();
    expect(byId(m, 'c')).toMatchObject({line: LINES.waitingAhead(2), ahead: 2, rail: {value: 0, striped: true}, activity: 'Waiting for Kyle’s MacBook'});
    expect(byId(m, 'c').stages.every(x => x.state === 'pending')).toBe(true);
    expect(byId(m, 'd')).toMatchObject({line: 'Waiting for MacBook Pro (offline)', activity: LINES.offlineOn('MacBook Pro')});
  });

  test('a running job on a computer that went offline reads as paused (D12)', () => {
    desktop.available = true;
    s.processor.value = {phase: 'offline', deviceId: 'dev1', name: 'Studio MacBook'};
    s.library.jobs.value = [job()];
    const m = model();
    expect(byId(m, 'run')).toMatchObject({line: 'Waiting for Studio MacBook (offline)', activity: LINES.pausedOn('Studio MacBook'), rail: {value: 0.46, striped: true}});
    s.processor.value = {phase: 'ready', deviceId: 'dev1', name: 'Studio MacBook'};
    expect(byId(m, 'run').line).toBe('Splitting · 46%');
  });

  test('failures: the §3.6 sentence and actions bound to the §2.10 targets', async () => {
    s.library.jobs.value = [
      job({jobId: 'bot', status: 'error', stage: 'download', errorCode: 'bot_check', retryAt: T0 + 5 * MIN, error: 'Sign in to confirm you’re not a bot'}),
      job({jobId: 'fail', status: 'error', stage: 'separate', errorCode: 'separation_failed', error: 'RuntimeError: no audio', updatedAt: T0 + 1}),
      job({jobId: 'old', status: 'error', stage: 'download', errorCode: null, error: 'ERROR: Private video', updatedAt: T0 - 1}),
    ];
    const m = model();
    const bot = byId(m, 'bot');
    expect(bot.line).toBe('YouTube asked for a sign-in check. Woodshed will try again in a few minutes.');
    expect(bot.actions.map(a => [a.label, a.tone])).toEqual([['Try now', 'primary'], ['Upload a file instead', 'quiet']]);
    expect(bot.stages.map(x => x.state)).toEqual(['failed', 'pending', 'pending', 'pending']);
    expect(bot.details).toContain('not a bot');
    await bot.actions[0].run();
    expect(api.retry).toHaveBeenCalledWith({jobId: 'bot'});
    expect(desktop.refreshStatus).toHaveBeenCalled();
    await bot.actions[1].run();
    expect(router.navigate).toHaveBeenCalledWith('/add?pick=1', {});

    const fail = byId(m, 'fail');
    expect(fail.line).toBe('Splitting failed on this computer.');
    expect(fail.actions.map(a => a.label)).toEqual(['Try again', 'Try Fast quality']);
    await fail.actions[1].run();
    expect(api.retry).toHaveBeenCalledWith({jobId: 'fail', preset: 'fast'});
    expect(byId(m, 'old').failure.code).toBe('unavailable');               // a 1.9 row without errorCode
    // Failures come first, newest first.
    expect(m.items.peek().map(i => i.id)).toEqual(['fail', 'bot', 'old']);
  });

  test('a failure reported as stage "error" (the companion) marks the step it failed in, from its code', () => {
    s.library.jobs.value = [
      job({jobId: 'split', status: 'error', stage: 'error', percent: 0, errorCode: 'separation_failed'}),
      job({jobId: 'disk', status: 'error', stage: 'error', percent: 0, errorCode: 'disk_full'}),
      job({jobId: 'bot', status: 'error', stage: 'error', percent: 0, errorCode: 'bot_check'}),
      job({jobId: 'sync', status: 'error', stage: 'error', percent: 0, errorCode: 'sync_failed'}),
      job({jobId: 'odd', status: 'error', stage: 'error', percent: 0, errorCode: 'unknown'}),
      job({jobId: 'legacy', status: 'error', stage: 'error', percent: 0, errorCode: null, error: 'ERROR: Private video'}),
      job({jobId: 'early', status: 'error', stage: 'queued', percent: 0, errorCode: 'separation_failed'}),
    ];
    const m = model();
    const states = id => byId(m, id).stages.map(x => `${x.label}:${x.state}`);
    expect(states('split')).toEqual(['Fetch:done', 'Split:failed', 'Finish:pending', 'Ready:pending']);
    expect(byId(m, 'split').line).toBe('Splitting failed on this computer.');
    expect(states('disk')).toEqual(['Fetch:done', 'Split:failed', 'Finish:pending', 'Ready:pending']);
    expect(states('bot')).toEqual(['Fetch:failed', 'Split:pending', 'Finish:pending', 'Ready:pending']);
    expect(states('sync')).toEqual(['Fetch:done', 'Split:done', 'Finish:failed', 'Ready:pending']);
    expect(states('odd')).toEqual(['Fetch:failed', 'Split:pending', 'Finish:pending', 'Ready:pending']);
    expect(states('legacy')).toEqual(['Fetch:failed', 'Split:pending', 'Finish:pending', 'Ready:pending']);
    expect(states('early')).toEqual(['Fetch:done', 'Split:failed', 'Finish:pending', 'Ready:pending']);
  });

  test('disk full: Details is the primary (spec §3.6), first in the row, with Dismiss after it', () => {
    s.library.jobs.value = [job({jobId: 'disk', status: 'error', stage: 'error', errorCode: 'disk_full', error: 'OSError: [Errno 28] No space left on device'})];
    const m = model();
    const vm = byId(m, 'disk');
    expect(vm.detailsFirst).toBe(true);
    expect(vm.actions.map(a => a.label)).toEqual(['Dismiss']);
    expect(byId(model(), 'disk').detailsFirst).toBe(true);
    installPopoverShim();
    openPopover(m);
    const buttons = [...document.querySelector('.lib-job[data-job-id="disk"] .lib-job-buttons').querySelectorAll('button')];
    expect(buttons.map(b => accName(b))).toEqual([ACTIONS.details, 'Dismiss']);
    expect(buttons[0].dataset.variant).toBe('primary');
    s.library.jobs.value = [job({jobId: 'disk', status: 'error', errorCode: 'separation_failed'})];
    const again = [...document.querySelector('.lib-job[data-job-id="disk"] .lib-job-buttons').querySelectorAll('button')];
    expect(again.map(b => accName(b)).at(-1)).toBe(ACTIONS.details);
    expect(again.at(-1).dataset.variant).toBe('quiet');
  });

  test('a first-run model or runtime download is "Setting up", with no split percent or ETA', () => {
    const DL = 'Downloading the separation model (first run)…';
    s.library.jobs.value = [job({percent: 10, message: DL})];
    const m = model();
    for (let i = 0; i < 40; i++) { tick(1000); s.library.jobs.value = [job({percent: 10 + 2 * (i + 1), message: DL})]; }
    let vm = byId(m, 'run');
    expect(vm.setup).toBe(true);
    expect(vm.line).toBe('Setting up · 90%');
    expect(vm.eta).toBeNull();
    expect(vm.percent).toBeNull();
    expect(vm.rail).toEqual({value: .9, striped: false});
    expect(vm.activity).toMatch(/^Setting up on Kyle’s MacBook/);
    expect(vm.message).toBe(DL);
    const NV = 'Preparing NVIDIA acceleration (one-time download)…';
    s.library.jobs.value = [job({percent: 40, message: NV})];
    expect(byId(m, 'run').line).toBe('Setting up · 40%');
    // The real split starts from 0: a split percent again, and the ETA history starts over.
    s.library.jobs.value = [job({percent: 1, message: 'Separating stems…'})];
    vm = byId(m, 'run');
    expect(vm.setup).toBe(false);
    expect(vm.line).toBe('Splitting · 1%');
    expect(vm.eta).toBeNull();
    tick(5000);
    s.library.jobs.value = [job({percent: 2, message: 'Separating stems…'})];
    expect(byId(m, 'run').eta).toBeNull();                          // not 15 s of the real split yet
  });

  test('desktop: the processor\'s first run reads as setting up for the local job', () => {
    desktop.available = true;
    s.processor.value = {phase: 'starting', firstRun: true, deviceId: 'dev1', name: 'Kyle’s MacBook'};
    s.library.jobs.value = [job({percent: 30, message: 'Loading model…'})];
    const m = model();
    expect(byId(m, 'run').line).toBe('Setting up · 30%');
    s.processor.value = {phase: 'busy', firstRun: false, deviceId: 'dev1', name: 'Kyle’s MacBook'};
    expect(byId(m, 'run').line).toBe('Splitting · 30%');
  });

  test('Cancel calls jobs.cancel; a failed action shows its error sentence', async () => {
    s.library.jobs.value = [job()];
    const m = model();
    await byId(m, 'run').actions[0].run();
    expect(api.cancel).toHaveBeenCalledWith({jobId: 'run'});
    api.cancel.mockRejectedValueOnce(Object.assign(new Error('job is done'), {code: 'job_not_failed'}));
    await byId(m, 'run').actions[0].run();
    expect(notify).toHaveBeenCalledWith(expect.any(String), {tone: 'error'});
  });

  test('a re-split is marked and bySong prefers it over a detection on the same song', () => {
    s.library.songs.value = new Map([['counting', {id: 'counting', title: 'Counting Stars Backwards', coverUrl: 'data:image/png;base64,AA'}]]);
    s.library.jobs.value = [
      job({jobId: 're', songId: 'counting', meta: null, percent: 71}),
      job({jobId: 'b', kind: 'beats', songId: 'counting', stage: 'detect', settingsSummary: null}),
    ];
    const m = model();
    expect(byId(m, 're')).toMatchObject({resplit: true, title: 'Counting Stars Backwards', cover: 'data:image/png;base64,AA'});
    expect(m.bySong.peek().get('counting').id).toBe('re');
    s.library.jobs.value = [job({jobId: 'b', kind: 'beats', songId: 'counting', stage: 'detect', settingsSummary: null})];
    expect(m.bySong.peek().get('counting').id).toBe('b');
  });

  test('uploads show real bytes, follow their progress signal and cancel through the handle', async () => {
    const progress = signal({loaded: 12.4e6, total: 31.2e6});
    const state = signal('uploading');
    const cancel = vi.fn(() => { state.value = 'canceled'; });
    s.library.uploads.value = [{id: 'u1', name: 'garage-take-4.wav', deviceId: 'dev1', progress, state, cancel}];
    const m = model();
    expect(byId(m, 'upload:u1')).toMatchObject({kind: 'upload', title: 'garage-take-4.wav', line: 'Uploading · 12 of 31 MB', percent: 40, rail: {striped: false}});
    expect(byId(m, 'upload:u1').rail.value).toBeCloseTo(12.4 / 31.2, 6);
    progress.value = {loaded: 20e6, total: 31.2e6};
    expect(byId(m, 'upload:u1').line).toBe('Uploading · 20 of 31 MB');
    await byId(m, 'upload:u1').actions[0].run();
    expect(cancel).toHaveBeenCalled();
    expect(byId(m, 'upload:u1')).toBeUndefined();                          // canceled uploads are not rows
    state.value = 'queued';
    expect(byId(m, 'upload:u1')).toBeUndefined();                          // queued: the job row takes over
  });

  test('a failed upload explains itself and Dismiss removes it', async () => {
    s.library.uploads.value = [{id: 'u2', name: 'notes.pdf', progress: {loaded: 0, total: 0}, state: 'error', error: {code: 'unreadable', message: 'not audio'}, cancel() {}}];
    const m = model();
    const vm = byId(m, 'upload:u2');
    expect(vm).toMatchObject({status: 'error', line: 'This file couldn’t be read as audio.'});
    expect(vm.actions.map(a => a.label)).toEqual(['Choose another file', ACTIONS.dismiss]);
    await vm.actions[1].run();
    expect(s.library.uploads.peek()).toEqual([]);
    expect(byId(m, 'upload:u2')).toBeUndefined();
  });

  test('the ETA appears after 15 s of a moving rate (card and popover)', () => {
    s.library.jobs.value = [job({percent: 40})];
    const m = model();
    expect(byId(m, 'run').eta).toBeNull();
    for (let i = 1; i <= 4; i++) {
      tick(5000);
      s.library.jobs.value = [job({percent: 40 + i})];
    }
    const vm = byId(m, 'run');
    expect(vm.eta).toBeGreaterThan(0);
    expect(vm.line).toMatch(/^Splitting · 44% · ~\d+ min$/);
    expect(vm.activity).toMatch(/ · about \d+ min left$/);
  });

  test('the clock ticks only while a job is live', () => {
    const m = model();
    m.items.value;   // eslint-disable-line no-unused-expressions
    expect(timer.set).not.toHaveBeenCalled();
    s.library.jobs.value = [job()];
    expect(timer.set).toHaveBeenCalledTimes(1);
    tick(1000);
    expect(byId(m, 'run').activity).toContain('started 1:43 ago');
    s.library.jobs.value = [];
    expect(timer.clear).toHaveBeenCalled();
  });
});

describe('createJobsModel: chip', () => {
  test('splitting, in progress, failed and nothing', async () => {
    const m = model();
    expect(m.chip.peek()).toBeNull();
    s.library.jobs.value = [job({jobId: 'a'}), job({jobId: 'b'})];
    expect(m.chip.peek()).toEqual({text: '2 splitting', tone: 'neutral', icon: 'loader'});
    // Queued jobs are not splitting: only queued ones are "waiting", a mix is "in progress".
    s.library.jobs.value = [job({jobId: 'a', status: 'queued', stage: 'queued'}), job({jobId: 'b', status: 'queued', stage: 'queued', deviceId: 'dev2'})];
    expect(m.chip.peek()).toEqual({text: '2 waiting', tone: 'neutral', icon: 'loader'});
    s.library.jobs.value = [job({jobId: 'a'}), job({jobId: 'b', status: 'queued', stage: 'queued'})];
    expect(m.chip.peek().text).toBe('2 in progress');
    s.library.jobs.value = [job({jobId: 'a'}), job({jobId: 'c', kind: 'beats', stage: 'detect', songId: 'x'})];
    expect(m.chip.peek().text).toBe('2 in progress');
    s.library.jobs.value = [job({jobId: 'f', status: 'error', errorCode: 'separation_failed'})];
    expect(m.chip.peek()).toEqual({text: '1 failed', tone: 'warn', icon: 'alert-triangle'});
    s.library.jobs.value = [job({jobId: 'a'}), job({jobId: 'f', status: 'error', errorCode: 'separation_failed'})];
    expect(m.chip.peek().text).toBe('1 failed');                                  // one message, the most urgent
    s.library.jobs.value = [];
    expect(m.chip.peek()).toBeNull();
  });

  test('desktop: a stopped processor reads "Processor offline", even with no jobs', () => {
    desktop.available = true;
    s.processor.value = {phase: 'offline', deviceId: 'dev1', name: 'Studio MacBook'};
    const m = model();
    expect(m.chip.peek()).toEqual({text: CHIP.offline, tone: 'danger', icon: 'wifi-off'});
    s.processor.value = {phase: 'ready', deviceId: 'dev1', name: 'Studio MacBook'};
    expect(m.chip.peek()).toBeNull();
  });
});

describe('createJobsModel: what finished', () => {
  test('a split that leaves the list done is ready until its song is opened', async () => {
    s.library.songs.value = new Map([['harbor', {id: 'harbor', title: 'Harbor Lights'}]]);
    s.library.jobs.value = [job()];
    const m = model();
    expect(m.ready.peek()).toEqual([]);
    api.get.mockResolvedValueOnce({...job(), status: 'done', stage: 'done', songId: 'harbor', appliedAt: null, result: null});
    s.library.jobs.value = [];
    await flush();
    expect(api.get).toHaveBeenCalledWith({jobId: 'run'});
    expect(m.ready.peek().map(x => x.id)).toEqual(['harbor']);
    s.stage.value = {songId: 'harbor'};
    expect(m.ready.peek()).toEqual([]);
  });

  test('canceled jobs and jobs never seen live are not ready', async () => {
    s.library.jobs.value = [job()];
    const m = model();
    api.get.mockResolvedValueOnce({...job(), status: 'canceled', songId: 'harbor'});
    s.library.jobs.value = [];
    await flush();
    expect(m.ready.peek()).toEqual([]);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  test('a user detection that finishes unapplied becomes a row: Open song, Not now', async () => {
    s.library.songs.value = new Map([['glass', {id: 'glass', title: 'Glasshouse', artist: 'Northbound'}]]);
    const live = job({jobId: 'beats-glass', kind: 'beats', stage: 'detect', percent: 50, songId: 'glass', settingsSummary: null, source: null});
    s.library.jobs.value = [live];
    const m = model();
    api.get.mockResolvedValueOnce({...live, status: 'done', stage: 'done', percent: 100, appliedAt: null, result: {beats: []}});
    s.library.jobs.value = [];
    await flush();
    const vm = byId(m, 'beats-glass');
    expect(vm).toMatchObject({status: 'done', kind: 'beats', title: 'Glasshouse', line: LINES.found});
    expect(vm.stages.map(x => x.state)).toEqual(['done', 'current']);
    expect(vm.actions.map(a => [a.label, a.tone])).toEqual([[ACTIONS.openSong, 'primary'], [ACTIONS.notNow, 'quiet']]);
    expect(m.chip.peek()).toEqual({text: 'Bars found', tone: 'accent', icon: 'sparkles'});
    expect(m.bySong.peek().has('glass')).toBe(false);
    await vm.actions[0].run();
    expect(router.navigate).toHaveBeenCalledWith('/s/glass');
    await vm.actions[1].run();
    expect(api.markApplied).toHaveBeenCalledWith({jobId: 'beats-glass'});
    expect(byId(m, 'beats-glass')).toBeUndefined();
  });

  test('applied or chained detections are not offered; opening the song drops the offer', async () => {
    const live = job({jobId: 'b1', kind: 'beats', stage: 'detect', songId: 'glass', settingsSummary: null});
    s.library.jobs.value = [live, {...live, jobId: 'b2', chainedFrom: 'x'}, {...live, jobId: 'b3', songId: 'other'}];
    const m = model();
    api.get.mockImplementation(async ({jobId}) => ({...live, jobId, status: 'done', appliedAt: jobId === 'b1' ? T0 : null, result: {beats: []},
      chainedFrom: jobId === 'b2' ? 'x' : null, songId: jobId === 'b3' ? 'other' : 'glass'}));
    s.library.jobs.value = [];
    await flush();
    expect(m.items.peek().map(i => i.id)).toEqual(['b3']);
    s.stage.value = {songId: 'other'};
    expect(m.items.peek()).toEqual([]);
  });
});

describe('createJobsModel: what finished on the open song', () => {
  const beatsLive = () => job({jobId: 'b1', kind: 'beats', stage: 'detect', songId: 'song1', settingsSummary: null, source: null});
  const doneOf = (j, over = {}) => ({...j, status: 'done', stage: 'done', percent: 100, appliedAt: null, result: {beats: [[0, 1]]}, ...over});

  test('a detection that finishes on the open song is not offered, even after going back to the Library', async () => {
    s.library.songs.value = new Map([['song1', {id: 'song1', title: 'Song One'}]]);
    s.stage.value = {songId: 'song1'};
    const live = beatsLive();
    s.library.jobs.value = [live];
    const m = model();
    api.get.mockResolvedValueOnce(doneOf(live));
    s.library.jobs.value = [];
    await flush();
    s.stage.value = null;
    expect(m.chip.peek()).toBeNull();
    expect(m.items.peek()).toEqual([]);
  });

  test('the song being opened when the job vanished counts, even if the reply comes after leaving it', async () => {
    s.library.songs.value = new Map([['song1', {id: 'song1', title: 'Song One'}]]);
    s.stage.value = {songId: 'song1'};
    const live = beatsLive();
    s.library.jobs.value = [live];
    const m = model();
    let reply;
    api.get.mockImplementationOnce(() => new Promise(r => { reply = r; }));
    s.library.jobs.value = [];
    s.stage.value = null;
    reply(doneOf(live));
    await flush();
    expect(m.items.peek()).toEqual([]);
  });

  test('a split that finishes while its song is open is not "ready"', async () => {
    s.library.songs.value = new Map([['song1', {id: 'song1', title: 'Song One'}]]);
    s.stage.value = {songId: 'song1'};
    const live = job({songId: 'song1'});
    s.library.jobs.value = [live];
    const m = model();
    api.get.mockResolvedValueOnce(doneOf(live, {kind: 'separate', result: null}));
    s.library.jobs.value = [];
    await flush();
    s.stage.value = null;
    expect(m.ready.peek()).toEqual([]);
  });

  test('a done detection without a result is not offered', async () => {
    const live = beatsLive();
    s.library.jobs.value = [live];
    const m = model();
    api.get.mockResolvedValueOnce(doneOf(live, {result: null}));
    s.library.jobs.value = [];
    await flush();
    expect(m.chip.peek()).toBeNull();
  });

  test('a found detection leaves once applied elsewhere (jobs.get follows it)', async () => {
    s.library.songs.value = new Map([['song1', {id: 'song1', title: 'Song One'}]]);
    const subs = new Map();
    const off = vi.fn();
    api.subscribeJob = vi.fn(({jobId}, onValue) => { subs.set(jobId, onValue); return off; });
    const live = beatsLive();
    s.library.jobs.value = [live];
    const m = model();
    api.get.mockResolvedValueOnce(doneOf(live));
    s.library.jobs.value = [];
    await flush();
    expect(m.chip.peek()?.text).toBe('Bars found');
    expect(api.subscribeJob).toHaveBeenCalledWith({jobId: 'b1'}, expect.any(Function), expect.any(Function));
    subs.get('b1')(doneOf(live));                                  // unchanged: still offered
    expect(m.chip.peek()?.text).toBe('Bars found');
    subs.get('b1')(doneOf(live, {appliedAt: T0 + 1}));
    expect(m.chip.peek()).toBeNull();
    expect(m.items.peek()).toEqual([]);
    expect(off).toHaveBeenCalled();
  });

  // I1b-2: one jobs.listUnappliedDetections subscription across every song replaces the per-song
  // latestDetection probe of the 12 most recent songs (architecture §6.4, Appendix C item 78).
  const detection = (songId, over = {}) => ({
    jobId: `det-${songId}`, kind: 'beats', status: 'done', songId, label: `Song ${songId}`, chainedFrom: null, appliedAt: null,
    result: {beats: [[0, 1]]}, deviceId: null, createdAt: T0 - MIN, startedAt: T0 - 2 * MIN, ...over,
  });
  function unappliedFeed() {
    const feed = {onValue: null, off: vi.fn()};
    api.subscribeUnappliedDetections = vi.fn((onValue, onError) => { feed.onValue = onValue; feed.onError = onError; return feed.off; });
    return feed;
  }
  const songsOf = n => new Map(Array.from({length: n}, (_, i) => [`s${i}`, {id: `s${i}`, title: `Song ${i}`, addedAt: T0 - i * MIN, lastPracticedAt: null}]));

  test('unapplied detections from before this session come from one listUnappliedDetections subscription, on every song', async () => {
    s.library.loaded.value = false;
    s.library.songs.value = songsOf(20);
    s.stage.value = {songId: 's3'};
    api.latestDetection = vi.fn(async () => null);
    const feed = unappliedFeed();
    const m = model();
    await flush();
    expect(api.subscribeUnappliedDetections).not.toHaveBeenCalled();     // waits for the library (signed in)
    s.library.loaded.value = true;
    expect(api.subscribeUnappliedDetections).toHaveBeenCalledTimes(1);
    expect(api.subscribeUnappliedDetections).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
    feed.onValue([
      detection('s19'),                                                    // the oldest song: the old probe never asked it
      detection('s3'),                                                     // open: its Stage offers it
      detection('s2'),
      detection('s5', {chainedFrom: 'job-split'}),                         // chained: applied by the split itself
      detection('s6', {appliedAt: T0 - MIN}),
      detection('s7', {result: null}),
    ]);
    expect(m.items.peek().map(i => i.id)).toEqual(['det-s19', 'det-s2']);
    const row = byId(m, 'det-s19');
    expect(row).toMatchObject({kind: 'beats', status: 'done', songId: 's19', title: 'Song 19', line: LINES.found});
    expect(row.actions.map(a => a.label)).toEqual([ACTIONS.openSong, ACTIONS.notNow]);
    expect(m.chip.peek()?.text).toBe(CHIP.found(2));
    expect(api.latestDetection).not.toHaveBeenCalled();                    // no per-song probe any more
    s.library.songs.value = new Map([...songsOf(20), ['x', {id: 'x', title: 'X'}]]);
    s.library.loaded.value = false;
    s.library.loaded.value = true;
    expect(api.subscribeUnappliedDetections).toHaveBeenCalledTimes(1);   // subscribed once
    await row.actions[0].run();
    expect(router.navigate).toHaveBeenCalledWith('/s/s19');
    m.destroy();
    expect(feed.off).toHaveBeenCalled();
    expect(jobsModule.DETECTION_PROBE_MAX).toBeUndefined();
  });

  test('a listed detection leaves when the list drops it, and Not now or opening its song keeps it gone', async () => {
    s.library.songs.value = songsOf(4);
    const feed = unappliedFeed();
    const m = model();
    feed.onValue([detection('s0'), detection('s1'), detection('s2')]);
    expect(m.items.peek().map(i => i.id)).toEqual(['det-s0', 'det-s1', 'det-s2']);
    feed.onValue([detection('s0'), detection('s2')]);                      // applied elsewhere
    expect(m.items.peek().map(i => i.id)).toEqual(['det-s0', 'det-s2']);
    await byId(m, 'det-s0').actions.find(a => a.label === ACTIONS.notNow).run();
    expect(api.markApplied).toHaveBeenCalledWith({jobId: 'det-s0'});
    expect(m.items.peek().map(i => i.id)).toEqual(['det-s2']);
    feed.onValue([detection('s0'), detection('s2')]);                      // a value from before markApplied landed
    expect(m.items.peek().map(i => i.id)).toEqual(['det-s2']);
    s.stage.value = {songId: 's2'};                                         // opening the song: the Stage offers it
    expect(m.items.peek()).toEqual([]);
    s.stage.value = null;
    feed.onValue([detection('s2'), detection('s3')]);
    expect(m.items.peek().map(i => i.id)).toEqual(['det-s3']);
    feed.onValue(null);
    expect(m.items.peek()).toEqual([]);
    expect(m.chip.peek()).toBeNull();
    feed.onError?.(new Error('offline'));                                   // an error is not thrown at the client
  });

  test('a detection seen live this session and listed is one row, followed by jobs.get', async () => {
    s.library.songs.value = new Map([['song1', {id: 'song1', title: 'Song One'}]]);
    const subs = new Map();
    api.subscribeJob = vi.fn(({jobId}, onValue) => { subs.set(jobId, onValue); return vi.fn(); });
    const feed = unappliedFeed();
    const live = beatsLive();
    s.library.jobs.value = [live];
    const m = model();
    api.get.mockResolvedValueOnce(doneOf(live));
    s.library.jobs.value = [];
    await flush();
    feed.onValue([doneOf(live)]);
    expect(m.items.peek().map(i => i.id)).toEqual(['b1']);
    feed.onValue([]);                                                       // a capped list may drop it: jobs.get still follows it
    expect(m.items.peek().map(i => i.id)).toEqual(['b1']);
    subs.get('b1')(doneOf(live, {appliedAt: T0 + 1}));
    expect(m.items.peek()).toEqual([]);
  });

  test('without the subscription it asks listUnappliedDetections once; a failure or signed-out client offers nothing', async () => {
    s.library.songs.value = songsOf(2);
    api.listUnappliedDetections = vi.fn(async () => [detection('s1')]);
    const m = model();
    await flush();
    await flush();
    expect(api.listUnappliedDetections).toHaveBeenCalledTimes(1);
    expect(m.items.peek().map(i => i.id)).toEqual(['det-s1']);
    api.listUnappliedDetections = vi.fn(async () => { throw new Error('not signed in'); });
    const m2 = model();
    await flush();
    await flush();
    expect(m2.items.peek()).toEqual([]);
    delete api.listUnappliedDetections;
    api.subscribeUnappliedDetections = vi.fn(() => { throw new Error('not signed in'); });
    s.library.loaded.value = false;
    const m3 = model();
    s.library.loaded.value = true;
    expect(m3.items.peek()).toEqual([]);
    expect(api.subscribeUnappliedDetections).toHaveBeenCalled();
  });
});

test('jobsModel is the shared model', () => {
  expect(jobsModel.items).toBe(sharedJobsModel().items);
  expect(jobsModel.ready).toBe(sharedJobsModel().ready);
  sharedJobsModel().destroy();
});

// ----------------------------------------------------------------------------------------- views

const visibleText = el => {
  if (el.closest('[aria-hidden=true]')) return '';
  const clone = el.cloneNode(true);
  for (const n of clone.querySelectorAll('[aria-hidden=true]')) n.remove();
  return clone.textContent.replace(/\s+/g, ' ').trim();
};
const accName = el => el.getAttribute('aria-label')
  ?? (el.getAttribute('aria-labelledby') ? el.getAttribute('aria-labelledby').split(/\s+/).map(id => visibleText(document.getElementById(id))).join(' ') : visibleText(el));
const roleOf = el => el.getAttribute('role') ?? (el.matches('a[href]') ? 'link' : el.matches('button') ? 'button' : el.matches('ul, ol') ? 'list' : null);
const byRole = (role, name) => [...document.querySelectorAll('a[href], button, ul, ol, [role]')]
  .filter(el => !el.closest('[hidden]') && roleOf(el) === role && (name === undefined || accName(el) === name));

function mountChip(over = {}) {
  installPopoverShim();
  const slot = document.createElement('div');
  slot.className = 'shell-jobs';
  document.body.append(slot);
  const m = over.model ?? model();
  const chip = mountJobsChip(slot, {model: m, store: s, desktop, now});
  mounts.push(chip);
  return {slot, m, chip};
}
const openPopover = (m, opts = {}) => {
  const handle = openJobsPopover({model: m, store: s, desktop, now, ...opts});
  mounts.push({close: () => handle.close()});
  return handle;
};

describe('Jobs chip', () => {
  test('present only when there is something to show; a click toggles the popover', () => {
    const {slot, m} = mountChip();
    expect(slot.children).toHaveLength(0);
    s.library.jobs.value = [job({jobId: 'a'}), job({jobId: 'b'})];
    const button = slot.querySelector('button');
    expect(accName(button)).toBe('2 splitting');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.dataset.tone).toBe('neutral');
    button.click();
    expect(byRole('dialog', POPOVER.title)).toHaveLength(1);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.click();
    expect(byRole('dialog', POPOVER.title)).toHaveLength(0);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    s.library.jobs.value = [];
    expect(slot.children).toHaveLength(0);
    expect(m.chip.peek()).toBeNull();
  });

  test('pressing the chip closes a popover anchored elsewhere (a card) instead of reopening it', () => {
    const {slot, m} = mountChip();
    s.library.jobs.value = [job()];
    const card = document.createElement('div');
    document.body.append(card);
    openJobsPopover({anchor: card, model: m, store: s, desktop, now});
    const button = slot.querySelector('button');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
    button.dispatchEvent(new PointerEvent('pointerup', {bubbles: true}));
    button.click();
    expect(byRole('dialog', POPOVER.title)).toHaveLength(0);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // The next press opens it again.
    button.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
    button.click();
    expect(byRole('dialog', POPOVER.title)).toHaveLength(1);
  });

  test('stays (as "Jobs") while the popover is open after the last job leaves', () => {
    const {slot} = mountChip();
    s.library.jobs.value = [job()];
    slot.querySelector('button').click();
    s.library.jobs.value = [];
    expect(accName(slot.querySelector('button'))).toBe(CHIP.idle);
    expect(document.querySelector('.lib-jobs-empty').hidden).toBe(false);
  });
});

describe('Jobs popover', () => {
  test('rows for every kind with the stepper, lines, source and actions; reconciled in place', () => {
    s.library.songs.value = new Map([['quiet', {id: 'quiet', title: 'Quiet Hours'}]]);
    s.library.jobs.value = [
      job(),
      job({jobId: 'b', kind: 'beats', stage: 'detect', songId: 'quiet', settingsSummary: null, source: null}),
      job({jobId: 'q', status: 'queued', stage: 'queued', createdAt: T0}),
      job({jobId: 'f', status: 'error', errorCode: 'separation_failed', error: 'boom'}),
    ];
    const m = model();
    openPopover(m);
    const list = byRole('list', POPOVER.list)[0];
    const rows = [...list.children];
    expect(rows.map(r => r.dataset.jobId)).toEqual(['f', 'run', 'b', 'q']);
    const run = rows[1];
    expect(accName(run)).toBe('Harbor Lights');
    expect(run.querySelector('.ui-stage-stepper').getAttribute('aria-label')).toBe(STAGES.label);
    expect(run.querySelector('.lib-job-activity').textContent).toBe('Splitting on Kyle’s MacBook · started 1:42 ago');
    expect(run.querySelector('.lib-job-settings').textContent).toBe('Balanced · 4 stems');
    expect(run.querySelector('.lib-job-message').textContent).toContain('pass 2/4');
    const link = run.querySelector('a.lib-job-source');
    expect(link.getAttribute('href')).toBe('https://www.youtube.com/watch?v=harbor01');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(accName(link)).toBe(POPOVER.sourceName('youtube.com/…'));
    expect(rows[3].querySelector('.lib-job-ahead').textContent).toBe('2 songs ahead of this one');
    expect(rows[0].querySelector('.lib-job-activity').dataset.tone).toBe('danger');
    // Updates reuse the row nodes.
    s.library.jobs.value = [job({percent: 60}), ...s.library.jobs.peek().slice(1)];
    expect(list.children[1]).toBe(run);
    expect(run.querySelector('.ui-stage-stepper-percent:not([hidden])').textContent).toBe('60%');
  });

  test('Details discloses the raw text, selectable, with Copy', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true});
    s.library.jobs.value = [job({jobId: 'f', status: 'error', errorCode: 'separation_failed', error: 'RuntimeError: separation stopped'})];
    openPopover(model());
    const details = byRole('button', ACTIONS.details)[0];
    expect(details.getAttribute('aria-expanded')).toBe('false');
    const region = document.getElementById(details.getAttribute('aria-controls'));
    expect(region.hidden).toBe(true);
    details.click();
    expect(details.getAttribute('aria-expanded')).toBe('true');
    expect(region.hidden).toBe(false);
    const pre = region.querySelector('pre');
    expect(pre.textContent).toBe('RuntimeError: separation stopped');
    expect(pre.classList.contains('selectable')).toBe(true);
    byRole('button', ACTIONS.copy)[0].click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('RuntimeError: separation stopped');
    expect(byRole('button', ACTIONS.copied)).toHaveLength(1);
    delete navigator.clipboard;
  });

  test('an action button runs once at a time', async () => {
    let release;
    api.retry.mockImplementation(() => new Promise(r => { release = r; }));
    s.library.jobs.value = [job({jobId: 'f', status: 'error', errorCode: 'separation_failed'})];
    openPopover(model());
    const tryAgain = byRole('button', 'Try again')[0];
    tryAgain.click();
    tryAgain.click();
    await flush();
    expect(api.retry).toHaveBeenCalledTimes(1);
    expect(tryAgain.getAttribute('aria-busy')).toBe('true');
    release();
    await flush();
    expect(tryAgain.getAttribute('aria-busy')).not.toBe('true');
  });

  test('opens focused on a job; a second open refocuses instead of opening another', () => {
    s.library.jobs.value = [job(), job({jobId: 'q', status: 'queued', stage: 'queued'})];
    const m = model();
    const handle = openPopover(m, {focusJobId: 'q'});
    expect(document.activeElement?.dataset.jobId).toBe('q');
    const again = openJobsPopover({model: m, store: s, desktop, now, focusJobId: 'run'});
    expect(again).toBe(handle);
    expect(document.activeElement?.dataset.jobId).toBe('run');
    expect(document.querySelectorAll('.lib-jobs-popover')).toHaveLength(1);
  });

  test('desktop footer: "Processor ready · <name>", Restart when offline; the status is polled while open', async () => {
    desktop.available = true;
    s.processor.value = {phase: 'ready', name: 'MacBook Pro', deviceId: 'dev1'};
    const handle = openPopover(model());
    expect(desktop.watchStatus).toHaveBeenCalledTimes(1);
    const footer = document.querySelector('.lib-jobs-footer');
    expect(footer.querySelector('.lib-jobs-footer-text').textContent).toBe('Processor ready · MacBook Pro');
    expect(byRole('button', POPOVER.restart)).toHaveLength(0);
    s.processor.value = {phase: 'busy', name: 'MacBook Pro', deviceId: 'dev1', job: {id: 'run', stage: 'separate', percent: 46}};
    expect(footer.querySelector('.lib-jobs-footer-text').textContent).toBe('Splitting 1 · 46% · MacBook Pro');
    s.processor.value = {phase: 'offline', name: 'MacBook Pro', deviceId: 'dev1'};
    expect(footer.querySelector('.lib-jobs-footer-text').textContent).toBe(POPOVER.offline);
    expect(footer.dataset.state).toBe('off');
    byRole('button', POPOVER.restart)[0].click();
    await flush();
    expect(desktop.restartProcessor).toHaveBeenCalled();
    handle.close();
    expect(desktop.offs[0]).toHaveBeenCalled();
  });

  test('web footer: the paired computer online, offline, or none', () => {
    const m = model();
    let handle = openPopover(m);
    expect(desktop.watchStatus).not.toHaveBeenCalled();
    const text = () => document.querySelector('.lib-jobs-footer-text').textContent;
    expect(text()).toBe(POPOVER.onlineDevice('Kyle’s MacBook'));
    s.library.devices.value = [DEVICES[1]];
    expect(text()).toBe(POPOVER.offlineDevice('MacBook Pro'));
    s.library.devices.value = [];
    expect(text()).toBe(POPOVER.noDevice);
    const link = byRole('link', POPOVER.getDesktopName)[0];
    expect(link.getAttribute('href')).toBe('/download');
    expect(link.target).toBe('_blank');
    handle.close();
    handle = null;
  });

  test('a row that leaves while focused hands focus to the row in its place, then to the popover', () => {
    s.library.jobs.value = [job({jobId: 'a'}), job({jobId: 'b'})];
    openPopover(model());
    document.querySelector('.lib-job[data-job-id="a"] .lib-job-action').focus();
    s.library.jobs.value = [job({jobId: 'b'})];
    expect(document.activeElement?.dataset.jobId).toBe('b');
    s.library.jobs.value = [];
    expect(document.activeElement?.classList.contains('lib-jobs-popover')).toBe(true);
  });

  test('Escape closes it (non-modal, D36)', () => {
    s.library.jobs.value = [job()];
    const handle = openPopover(model());
    expect(handle.open).toBe(true);
    handle.close('escape');
    expect(document.querySelector('.lib-jobs-popover')).toBeNull();
  });
});

describe('CONTROLS', () => {
  test.each(CONTROLS.filter(c => !/^Needs review/.test(c.context)).map(c => [c.context, c.role, c.name]))('%s: %s "%s" renders', async (context, role, name) => {
    installPopoverShim();
    desktop.available = /desktop/.test(context);
    if (desktop.available) s.processor.value = {phase: 'offline', name: 'Studio MacBook', deviceId: 'dev1'};
    if (/no paired computer/.test(context)) s.library.devices.value = [];
    s.library.songs.value = new Map([['glass', {id: 'glass', title: 'Glasshouse'}]]);
    const live = [job({jobId: 'a'}), job({jobId: 'b'})];
    if (/a failure|failed separation/.test(context)) s.library.jobs.value = [job({jobId: 'f', status: 'error', errorCode: 'separation_failed'})];
    else if (/bot check/.test(context)) s.library.jobs.value = [job({jobId: 'bot', status: 'error', errorCode: 'bot_check', retryAt: T0 + MIN})];
    else if (/found/.test(context)) {
      const beats = job({jobId: 'bg', kind: 'beats', stage: 'detect', songId: 'glass', settingsSummary: null});
      s.library.jobs.value = [beats];
      api.get.mockResolvedValueOnce({...beats, status: 'done', appliedAt: null, result: {beats: []}});
    } else s.library.jobs.value = live;
    const {slot, m} = mountChip();
    if (/found/.test(context)) { s.library.jobs.value = []; await flush(); }
    if (/chip/.test(context)) {
      expect(byRole(role, name)).toHaveLength(1);
      expect(slot.contains(byRole(role, name)[0])).toBe(true);
      return;
    }
    openPopover(m);
    if (role === 'button' && name === ACTIONS.copy) byRole('button', ACTIONS.details)[0].click();
    expect(byRole(role, name).length).toBeGreaterThanOrEqual(1);
  });
});
