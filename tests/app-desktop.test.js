// src/app/desktop.js (architecture §2.11, maps/companion-desktop.md §16.5, §16.11).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {signal} from '../src/app/store.js';
import {createDesktop, processorStatus, processorLabel, modelFor, PROCESSOR_COPY, STATUS_POLL_MS} from '../src/app/desktop.js';
import {installDesktopBridge} from './fixture/fakes/desktop-bridge.js';

const STATUS = {name: 'Studio MacBook', connected: true, deviceId: 'dev1', userId: 'user1', busy: false, accepting: true, job: null,
  modelsReady: {htdemucs: true, htdemucs_ft: true, htdemucs_6s: true, mdx_extra: true}, version: '2.0.0'};
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function setup({fx = {}, status = STATUS, init} = {}) {
  const win = {console};
  const fixture = installDesktopBridge(win, fx);
  const companion = {
    initializeLocalDesktop: vi.fn(init ?? (async () => ({companion: {port: 47831}}))),
    status: vi.fn(async () => (typeof status === 'function' ? status() : status)),
  };
  const processor = signal({phase: 'web'});
  const update = signal({status: 'idle'});
  const desktop = createDesktop({
    bridge: win.woodshedDesktop, processor, update, model: () => 'htdemucs_ft', companion: async () => companion,
  });
  return {desktop, fixture, companion, processor, update, bridge: win.woodshedDesktop};
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('processor state machine', () => {
  const ready = {phase: 'ready'};
  const cases = [
    ['no bridge → web', {available: false}, {phase: 'web', name: null, deviceId: null, job: null, firstRun: false}],
    ['main starting → starting', {main: {phase: 'starting'}}, {phase: 'starting', firstRun: false}],
    ['before any main state → starting', {}, {phase: 'starting'}],
    ['main restarting → starting', {main: {phase: 'restarting'}, pairing: 'ok', status: STATUS}, {phase: 'starting', job: null}],
    ['main stopped → offline, with main\'s message', {main: {phase: 'stopped', exitCode: 1, message: 'Local processor exited.'}}, {phase: 'offline', message: 'Local processor exited.'}],
    ['main ready, not paired yet → pairing', {main: ready, pairing: 'idle'}, {phase: 'pairing'}],
    ['pairing in flight → pairing', {main: ready, pairing: 'pending'}, {phase: 'pairing'}],
    ['paired, waiting for /status → pairing', {main: ready, pairing: 'ok'}, {phase: 'pairing'}],
    ['pairing threw → pair-failed', {main: ready, pairing: 'failed', pairError: 'Device limit reached.'},
      {phase: 'pair-failed', message: PROCESSOR_COPY.pairFailed, details: 'Device limit reached.'}],
    ['/status says not connected → pair-failed', {main: ready, pairing: 'ok', status: {...STATUS, connected: false}}, {phase: 'pair-failed'}],
    ['/status failing → offline', {main: ready, pairing: 'ok', status: STATUS, statusError: true}, {phase: 'offline', job: null}],
    ['connected and idle → ready', {main: ready, pairing: 'ok', status: STATUS}, {phase: 'ready', name: 'Studio MacBook', deviceId: 'dev1', job: null, firstRun: false}],
    ['busy → busy with the job', {main: ready, pairing: 'ok', status: {...STATUS, busy: true, job: {id: 'j', stage: 'download', percent: 38}}},
      {phase: 'busy', job: {id: 'j', stage: 'download', percent: 38}}],
    ['first job splitting without the model → starting (first run)',
      {main: ready, pairing: 'ok', model: 'htdemucs_ft', status: {...STATUS, busy: true, job: {id: 'j', stage: 'separate', percent: 0}, modelsReady: {...STATUS.modelsReady, htdemucs_ft: false}}},
      {phase: 'starting', firstRun: true, job: {id: 'j', stage: 'separate', percent: 0}}],
    ['splitting with the model ready → busy',
      {main: ready, pairing: 'ok', model: 'htdemucs_ft', status: {...STATUS, busy: true, job: {id: 'j', stage: 'separate', percent: 46}, modelsReady: {...STATUS.modelsReady, htdemucs: false}}},
      {phase: 'busy', firstRun: false}],
    ['model unknown, no model downloaded → first run',
      {main: ready, pairing: 'ok', status: {...STATUS, busy: true, job: {id: 'j', stage: 'separate', percent: 0}, modelsReady: {htdemucs: false, htdemucs_ft: false}}},
      {phase: 'starting', firstRun: true}],
    ['downloading (not splitting) without models → busy',
      {main: ready, pairing: 'ok', model: 'htdemucs_ft', status: {...STATUS, busy: true, job: {id: 'j', stage: 'download', percent: 5}, modelsReady: {htdemucs_ft: false}}},
      {phase: 'busy'}],
  ];
  test.each(cases)('%s', (_, input, expected) => {
    expect(processorStatus({available: true, ...input})).toMatchObject(expected);
  });

  test('every phase is reachable', () => {
    const phases = new Set(cases.map(([, input]) => processorStatus({available: true, ...input}).phase));
    expect([...phases].sort()).toEqual(['busy', 'offline', 'pair-failed', 'pairing', 'ready', 'starting', 'web']);
  });

  test('labels per spec §6.5', () => {
    expect(processorLabel({phase: 'ready'})).toBe('Processor ready');
    expect(processorLabel({phase: 'busy', job: {stage: 'separate', percent: 46.4}})).toBe('Splitting 1 · 46%');
    expect(processorLabel({phase: 'busy', job: {stage: 'download', percent: 38}})).toBe('Fetching audio · 38%');
    expect(processorLabel({phase: 'busy', job: null})).toBe('Splitting 1 · 0%');
    expect(processorLabel({phase: 'starting', firstRun: true})).toBe('Starting… (first run, ~1 min)');
    expect(processorLabel({phase: 'starting', firstRun: false})).toBe('Starting…');
    expect(processorLabel({phase: 'offline'})).toBe('Offline — Restart');
    expect(processorLabel({phase: 'pair-failed'})).toBe('Couldn’t connect this computer to your account.');
    expect(processorLabel({phase: 'pairing'})).toBe('Connecting…');
    expect(processorLabel({phase: 'web'})).toBeNull();
  });

  test('the account\'s model: custom, the preset\'s, else the default preset\'s', () => {
    const config = {defaultPreset: 'balanced', presets: {balanced: {model: 'htdemucs_ft'}, fast: {model: 'htdemucs'}}};
    expect(modelFor({preset: 'fast'}, config)).toBe('htdemucs');
    expect(modelFor({preset: 'custom', custom: {model: 'htdemucs_6s'}}, config)).toBe('htdemucs_6s');
    expect(modelFor({preset: 'gone'}, config)).toBe('htdemucs_ft');
    expect(modelFor(null, config)).toBeNull();
    expect(modelFor({preset: 'fast'}, null)).toBeNull();
  });
});

describe('without the bridge', () => {
  test('every method is a no-op', async () => {
    const processor = signal({phase: 'starting'});
    const desktop = createDesktop({bridge: null, processor, update: signal({status: 'idle'}), companion: async () => { throw new Error('never'); }});
    expect(desktop.available).toBe(false);
    expect(desktop.processor.value.phase).toBe('web');
    expect(await desktop.start()).toMatchObject({phase: 'web'});
    expect(await desktop.info()).toBeNull();
    expect(await desktop.notify({title: 't', body: 'b', route: '/'})).toBe(false);
    expect(await desktop.setBackgroundShortcuts(true)).toEqual({registered: [], failed: []});
    expect(await desktop.mediaUrl('https://x/y')).toBe('https://x/y');
    expect(await desktop.restartProcessor()).toBeNull();
    expect(await desktop.retryPairing()).toMatchObject({phase: 'web'});
    expect(await desktop.refreshStatus()).toMatchObject({phase: 'web'});
    await desktop.setTheme('dark');
    await desktop.update('show');
    expect(() => { desktop.setActivity({playing: true}); desktop.registerMenu([]); }).not.toThrow();
    for (const on of ['onUpdate', 'onCommand', 'onNavigate', 'onFlushRequest', 'onFullScreen']) {
      const off = desktop[on](() => {});
      expect(typeof off).toBe('function');
      off();
    }
    const unwatch = desktop.watchStatus();
    unwatch();
    desktop.stop();
  });
});

describe('with the bridge', () => {
  test('start pairs once the processor is ready, reads /status and mirrors updates', async () => {
    const {desktop, fixture, companion, processor, update} = setup({fx: {update: 'ready'}});
    expect(desktop.available).toBe(true);
    expect(processor.value.phase).toBe('starting');
    const started = desktop.start();
    expect(desktop.start()).toBe(started);
    await started;
    expect(companion.initializeLocalDesktop).toHaveBeenCalledTimes(1);
    expect(companion.status).toHaveBeenCalledTimes(1);
    expect(processor.value).toMatchObject({phase: 'ready', name: 'Studio MacBook', deviceId: 'dev1'});
    expect(desktop.processor.value).toBe(processor.value);
    expect(update.value).toMatchObject({status: 'ready'});
    fixture.updateState({status: 'downloading', percent: 40});
    expect(update.value).toMatchObject({status: 'downloading', percent: 40});
    fixture.openUpdates();
    await flush();
    expect(fixture.calls().filter(c => c.method === 'update').map(c => c.args)).toEqual([['show']]);
    desktop.stop();
    expect(fixture.listenerCounts()).toMatchObject({processor: 0, update: 0, openUpdates: 0});
  });

  test('at launch main is starting with no companion: pairing waits for the ready event', async () => {
    const {desktop, fixture, companion, processor} = setup({fx: {processor: 'starting'}});
    await desktop.start();
    expect(processor.value.phase).toBe('starting');
    expect(companion.initializeLocalDesktop).not.toHaveBeenCalled();
    fixture.processorState({phase: 'ready'});
    expect(processor.value.phase).toBe('pairing');
    await flush();
    expect(companion.initializeLocalDesktop).toHaveBeenCalledTimes(1);
    expect(processor.value.phase).toBe('ready');
  });

  test('stopped → offline; ready again → paired again', async () => {
    const {desktop, fixture, companion, processor} = setup();
    await desktop.start();
    fixture.processorState({phase: 'stopped', exitCode: 1, message: 'Local processor exited.'});
    expect(processor.value).toMatchObject({phase: 'offline', message: 'Local processor exited.'});
    fixture.processorState({phase: 'ready'});
    await flush();
    expect(companion.initializeLocalDesktop).toHaveBeenCalledTimes(2);
    expect(processor.value.phase).toBe('ready');
  });

  test('Restart processor: restarting → starting, then paired once more', async () => {
    const {desktop, fixture, companion, processor} = setup();
    await desktop.start();
    vi.useFakeTimers();
    const phases = [];
    const off = processor.subscribe(v => phases.push(v.phase));
    const restarted = desktop.restartProcessor();
    await vi.advanceTimersByTimeAsync(300);
    expect(await restarted).toEqual({port: 47831, token: 'f'.repeat(64)});
    off();
    expect(phases).toEqual(['starting', 'pairing', 'ready']);
    expect(companion.initializeLocalDesktop).toHaveBeenCalledTimes(2);
    expect(fixture.calls().filter(c => c.method === 'restartProcessor')).toHaveLength(1);
  });

  test('restart during pending pairing re-pairs against the new processor', async () => {
    let port = 1;
    const paired = [];
    let release;
    const {desktop, fixture, companion, processor} = setup({fx: {processor: 'starting'}, init: async () => {
      const p = port;
      if (p === 1) await new Promise(r => { release = r; });
      paired.push(p);
    }});
    await desktop.start();
    fixture.processorState({phase: 'ready'});
    await flush();
    expect(companion.initializeLocalDesktop).toHaveBeenCalledTimes(1);
    fixture.processorState({phase: 'restarting'});
    fixture.processorState({phase: 'starting'});
    port = 2;
    fixture.processorState({phase: 'ready'});
    expect(processor.value.phase).toBe('pairing');
    release();
    await flush(30);
    expect(companion.initializeLocalDesktop).toHaveBeenCalledTimes(2);
    expect(paired).toEqual([1, 2]);
    expect(processor.value.phase).toBe('ready');
  });

  test('a stale pairing failure after a restart is discarded; the new process pairs', async () => {
    let calls = 0, reject;
    const {desktop, fixture, companion, processor} = setup({fx: {processor: 'starting'}, init: async () => {
      calls++;
      if (calls === 1) await new Promise((_, rj) => { reject = rj; });
    }});
    await desktop.start();
    fixture.processorState({phase: 'ready'});
    await flush();
    fixture.processorState({phase: 'stopped', exitCode: 1});
    fixture.processorState({phase: 'ready'});
    reject(new Error('ECONNREFUSED'));
    await flush(30);
    expect(companion.initializeLocalDesktop).toHaveBeenCalledTimes(2);
    expect(processor.value.phase).toBe('ready');
  });

  test('a pairing failure surfaces as pair-failed; Try again re-runs it', async () => {
    let fail = true;
    const {desktop, companion, processor} = setup({init: async () => { if (fail) throw new Error('Device limit reached.'); }});
    await desktop.start();
    expect(processor.value).toMatchObject({phase: 'pair-failed', message: 'Couldn’t connect this computer to your account.', details: 'Device limit reached.'});
    expect(companion.status).not.toHaveBeenCalled();
    fail = false;
    await desktop.retryPairing();
    expect(companion.initializeLocalDesktop).toHaveBeenCalledTimes(2);
    expect(processor.value.phase).toBe('ready');
    // Concurrent retries share one attempt.
    const a = desktop.retryPairing(), b = desktop.retryPairing();
    expect(a).toBe(b);
    await a;
    expect(companion.initializeLocalDesktop).toHaveBeenCalledTimes(3);
  });

  test('watchStatus polls every 5 s while watched; failures read as offline', async () => {
    vi.useFakeTimers();
    let next = STATUS;
    const {desktop, companion, processor} = setup({status: () => { if (next instanceof Error) throw next; return next; }});
    await desktop.start();
    expect(companion.status).toHaveBeenCalledTimes(1);
    const off1 = desktop.watchStatus();
    const off2 = desktop.watchStatus();
    await flush();
    expect(companion.status).toHaveBeenCalledTimes(2);
    next = {...STATUS, busy: true, job: {id: 'j', stage: 'separate', percent: 46}};
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(companion.status).toHaveBeenCalledTimes(3);
    expect(processor.value).toMatchObject({phase: 'busy', job: {percent: 46}});
    expect(processorLabel(processor.value)).toBe('Splitting 1 · 46%');
    next = new Error('connect ECONNREFUSED');
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(processor.value.phase).toBe('offline');
    off1();
    off1();
    next = STATUS;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(processor.value.phase).toBe('ready');
    off2();
    const calls = companion.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 3);
    expect(companion.status).toHaveBeenCalledTimes(calls);
  });

  test('first run: the separation model is still downloading', async () => {
    const {desktop, processor} = setup({status: {...STATUS, busy: true, job: {id: 'j', stage: 'separate', percent: 0},
      modelsReady: {htdemucs: false, htdemucs_ft: false, htdemucs_6s: false, mdx_extra: false}}});
    await desktop.start();
    expect(processor.value).toMatchObject({phase: 'starting', firstRun: true});
    expect(processorLabel(processor.value)).toBe('Starting… (first run, ~1 min)');
  });

  test('the passthroughs reach the bridge', async () => {
    const {desktop, fixture} = setup({fx: {shortcuts: 'fail'}});
    desktop.setActivity({playing: true, songOpen: true});
    expect(fixture.activity()).toEqual({playing: true, songOpen: true});
    expect(await desktop.notify({title: 'Harbor Lights is ready to practise', body: '', route: '/s/abc'})).toBe(true);
    expect(fixture.notifications()).toHaveLength(1);
    desktop.registerMenu([{menu: 'Transport', items: [{id: 'transport.playStop', label: 'Play'}]}]);
    expect(fixture.menu()).toEqual([{menu: 'Transport', items: [{id: 'transport.playStop', label: 'Play'}]}]);
    const commands = [], routes = [], full = [];
    const offs = [desktop.onCommand(c => commands.push(c)), desktop.onNavigate(r => routes.push(r)), desktop.onFullScreen(on => full.push(on))];
    fixture.command('transport.playStop', 'global');
    fixture.navigate('/s/abc');
    fixture.fullScreen(true);
    expect([commands, routes, full]).toEqual([[{id: 'transport.playStop', source: 'global'}], ['/s/abc'], [true]]);
    const flushed = vi.fn(async () => {});
    const offFlush = desktop.onFlushRequest(flushed);
    expect(await fixture.flush()).toMatchObject({flushed: true});
    expect(flushed).toHaveBeenCalledTimes(1);
    for (const off of [...offs, offFlush]) off();
    expect(fixture.listenerCounts()).toMatchObject({command: 0, navigate: 0, fullScreen: 0, flush: 0});
    expect(await desktop.setBackgroundShortcuts(true)).toMatchObject({registered: [], failed: ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack']});
    await desktop.setTheme('dark');
    expect(await desktop.mediaUrl('https://r2/x')).toBe('https://r2/x');
    expect(await desktop.info()).toMatchObject({version: '2.0.0', companion: {port: 47831}});
    const methods = fixture.calls().map(c => c.method);
    expect(methods).toEqual(expect.arrayContaining(['setActivity', 'notify', 'registerMenu', 'setBackgroundShortcuts', 'setTheme', 'mediaUrl', 'info']));
  });

  test('a notify failure resolves false', async () => {
    const bridge = {notify: vi.fn(async () => { throw new Error('invalid'); })};
    const desktop = createDesktop({bridge, processor: signal({}), update: signal({}), companion: async () => ({})});
    expect(await desktop.notify({title: 'x'})).toBe(false);
  });
});

beforeEach(() => vi.useRealTimers());
