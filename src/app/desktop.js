// The desktop wrapper (architecture §2.11, maps/companion-desktop.md §16.5, §16.11):
// a feature-detected facade over window.woodshedDesktop (desktop/preload.cjs) and
// the processor status model. Every method is a no-op when the bridge is absent
// (the web app, the fixture without fx-desktop).
//
//   desktop.start()          after sign-in: track main's processor phase, pair this
//                            computer (companion.initializeLocalDesktop), mirror
//                            update state into store.update
//   desktop.processor        ReadonlySignal<ProcessorStatus> (also store.processor)
//   desktop.watchStatus()    poll the processor's /status every 5 s while a Jobs
//                            popover or Settings → Processing is visible; → off
//   desktop.refreshStatus()  read /status once (after submitting a job)
//
// ProcessorStatus = {phase: 'web'|'starting'|'pairing'|'ready'|'busy'|'offline'|'pair-failed',
//                    name, deviceId, job: {id, stage, percent}|null, firstRun, message?}
// At launch main may report phase 'starting' with info().companion null; pairing
// waits for the 'ready' processor-state event, and runs again after every
// restart (initializeLocalDesktop calls info() itself for the new {port, token}).

import {signal, computed, store} from './store.js';

export const STATUS_POLL_MS = 5000;

/** Spec §6.5 processor copy. */
export const PROCESSOR_COPY = Object.freeze({
  ready: 'Processor ready',
  starting: 'Starting…',
  firstRun: 'Starting… (first run, ~1 min)',
  firstRunLine: 'Setting up the processor (first run, ~1 min)…',
  pairing: 'Connecting…',
  offline: 'Offline — Restart',
  pairFailed: 'Couldn’t connect this computer to your account.',
  restart: 'Restart',
  tryAgain: 'Try again',
});

const STAGE_VERBS = Object.freeze({
  upload: 'Uploading', download: 'Fetching audio', separate: 'Splitting', finalize: 'Finishing', sync: 'Finishing',
  detect: 'Finding bars', beats: 'Finding bars', sections: 'Finding sections', queued: 'Waiting',
});

/** The account's separation model: the custom model, else the preset's (convex/lib/presets.ts resolveQuality). */
export function modelFor(account, config) {
  if (!account) return null;
  if (account.preset === 'custom') return account.custom?.model ?? null;
  const presets = config?.presets;
  const preset = presets?.[account.preset ?? config?.defaultPreset] ?? presets?.[config?.defaultPreset];
  return preset?.model ?? null;
}

const WEB = Object.freeze({phase: 'web', name: null, deviceId: null, job: null, firstRun: false});

/**
 * The processor state machine (pure). Inputs:
 *   available   the bridge exists
 *   main        main's processor state {phase: 'starting'|'ready'|'stopped'|'restarting', message?}
 *   pairing     'idle'|'pending'|'ok'|'failed', with pairError (the raw message)
 *   status      the last /status {name, connected, deviceId, busy, job, modelsReady} or null
 *   statusError true when the last /status request failed
 *   model       the separation model the account uses (first-run detection)
 */
export function processorStatus({available = true, main = null, pairing = 'idle', pairError = null, status = null, statusError = false, model = null} = {}) {
  if (!available) return WEB;
  const base = {name: status?.name ?? null, deviceId: status?.deviceId ?? null, job: status?.job ?? null, firstRun: false};
  const mainPhase = main?.phase ?? 'starting';
  if (mainPhase === 'stopped') return {...base, phase: 'offline', job: null, ...(main?.message ? {message: main.message} : {})};
  if (mainPhase === 'starting' || mainPhase === 'restarting') return {...base, phase: 'starting', job: null};
  if (pairing === 'failed') return {...base, phase: 'pair-failed', message: PROCESSOR_COPY.pairFailed, ...(pairError ? {details: pairError} : {})};
  if (pairing !== 'ok' || (!status && !statusError)) return {...base, phase: 'pairing'};
  if (statusError) return {...base, phase: 'offline', job: null};
  if (!status.connected) return {...base, phase: 'pair-failed', message: PROCESSOR_COPY.pairFailed};
  if (status.busy) {
    const ready = status.modelsReady;
    const missing = ready && (model ? ready[model] === false : Object.values(ready).length > 0 && Object.values(ready).every(v => !v));
    if (status.job?.stage === 'separate' && missing) return {...base, phase: 'starting', firstRun: true};
    return {...base, phase: 'busy'};
  }
  return {...base, phase: 'ready'};
}

/** The one-line processor label for the Jobs chip and Settings → Processing (spec §6.5); null on the web. */
export function processorLabel(s) {
  switch (s?.phase) {
    case 'starting': return s.firstRun ? PROCESSOR_COPY.firstRun : PROCESSOR_COPY.starting;
    case 'pairing': return PROCESSOR_COPY.pairing;
    case 'ready': return PROCESSOR_COPY.ready;
    case 'offline': return PROCESSOR_COPY.offline;
    case 'pair-failed': return PROCESSOR_COPY.pairFailed;
    case 'busy': {
      const pct = Math.max(0, Math.min(100, Math.round(Number(s.job?.percent) || 0)));
      const stage = s.job?.stage;
      if (!stage || stage === 'separate') return `Splitting 1 · ${pct}%`;
      return `${STAGE_VERBS[stage] ?? 'Working'} · ${pct}%`;
    }
    default: return null;
  }
}

const noop = () => {};
const noopOff = () => noop;

/**
 * Builds the wrapper (exported for tests; the app uses `desktop`).
 * `companion` loads src/js/companion.js ({initializeLocalDesktop, status}).
 */
export function createDesktop({
  bridge = globalThis.window?.woodshedDesktop ?? null,
  processor = store.processor, update = store.update,
  model = () => modelFor(store.account.value, store.config.value),
  companion = () => import('../js/companion.js'),
  timer = {set: (fn, ms) => globalThis.setInterval(fn, ms), clear: id => globalThis.clearInterval(id)},
} = {}) {
  const available = !!bridge;
  const has = name => available && typeof bridge[name] === 'function';
  const call = (name, ...args) => (has(name) ? bridge[name](...args) : undefined);
  const subscribe = name => cb => (has(name) ? bridge[name](cb) ?? noop : noop);

  const inputs = {available, main: null, pairing: 'idle', pairError: null, status: null, statusError: false};
  processor.value = processorStatus(inputs);
  const recompute = () => {
    const next = processorStatus({...inputs, model: model()});
    if (JSON.stringify(next) !== JSON.stringify(processor.peek())) processor.value = next;
  };

  let started = null, pairPromise = null, readyGen = 0, pairedGen = -1, watchers = 0, pollId = null, statusSeq = 0;
  const offs = [];

  async function refreshStatus() {
    if (!available || inputs.pairing !== 'ok') return processor.value;
    const seq = ++statusSeq;
    try {
      const mod = await companion();
      const next = await mod.status();
      if (seq !== statusSeq) return processor.value;
      inputs.status = next;
      inputs.statusError = false;
    } catch {
      if (seq !== statusSeq) return processor.value;
      inputs.statusError = true;
    }
    recompute();
    return processor.value;
  }

  function pair({force = false} = {}) {
    if (!available) return Promise.resolve(processor.value);
    if (pairPromise) return pairPromise;
    if (!force && inputs.pairing === 'ok' && pairedGen === readyGen) return Promise.resolve(processor.value);
    const gen = readyGen;
    inputs.pairing = 'pending';
    inputs.pairError = null;
    inputs.status = null;
    inputs.statusError = false;
    recompute();
    pairPromise = (async () => {
      let ok = false, error = null;
      try {
        const mod = await companion();
        await mod.initializeLocalDesktop();
        ok = true;
      } catch (err) {
        error = err;
      }
      pairPromise = null;
      if (gen !== readyGen) {
        // The processor restarted while this attempt ran: its port/token are
        // stale. Discard the result and pair with the new process instead.
        if (inputs.main?.phase === 'ready') return pair({force: true});
        recompute();
        return processor.value;
      }
      if (ok) {
        inputs.pairing = 'ok';
        pairedGen = gen;
      } else {
        inputs.pairing = 'failed';
        inputs.pairError = String(error?.message ?? error ?? '');
      }
      recompute();
      if (inputs.pairing === 'ok') await refreshStatus();
      return processor.value;
    })();
    return pairPromise;
  }

  function onMain(state) {
    const wasReady = inputs.main?.phase === 'ready';
    inputs.main = state && typeof state === 'object' ? state : {phase: 'starting'};
    if (inputs.main.phase !== 'ready') {
      inputs.pairing = 'idle';
      inputs.status = null;
      inputs.statusError = false;
    }
    recompute();
    if (inputs.main.phase === 'ready' && !wasReady) {
      readyGen++;
      if (pairPromise) {
        // An attempt for the previous process is still running; it re-pairs
        // when it settles. Show "Connecting…" meanwhile.
        inputs.pairing = 'pending';
        recompute();
      } else if (started) void pair();
    }
  }

  function startPolling() {
    if (pollId != null) return;
    pollId = timer.set(() => { void refreshStatus(); }, STATUS_POLL_MS);
  }
  function stopPolling() {
    if (pollId != null) timer.clear(pollId);
    pollId = null;
  }

  const api = {
    available,
    processor: computed(() => processor.value),

    /** Call once after sign-in (boot). Resolves when the first pairing attempt settles. */
    start() {
      if (!available) return Promise.resolve(processor.value);
      if (started) return started;
      offs.push(subscribe('onProcessorState')(onMain));
      offs.push(subscribe('onUpdate')(state => { if (state) update.value = state; }));
      offs.push(subscribe('onOpenUpdates')(() => { void call('update', 'show'); }));
      started = (async () => {
        let info = null;
        try { info = await call('info'); } catch { info = null; }
        if (info?.update) update.value = info.update;
        if (!inputs.main) onMain(info?.processor ?? {phase: info?.companion ? 'ready' : 'starting'});
        if (inputs.main?.phase === 'ready') await pair();
        return processor.value;
      })();
      return started;
    },

    /** Stop listening (tests, and a full sign-out). */
    stop() {
      for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
      stopPolling();
      watchers = 0;
      started = null;
    },

    watchStatus() {
      if (!available) return noop;
      watchers++;
      if (watchers === 1) { void refreshStatus(); startPolling(); }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        watchers--;
        if (watchers === 0) stopPolling();
      };
    },
    refreshStatus,

    info: () => (available ? Promise.resolve(call('info')) : Promise.resolve(null)),
    setTheme: theme => (available ? Promise.resolve(call('setTheme', theme)) : Promise.resolve()),
    mediaUrl: url => (has('mediaUrl') ? Promise.resolve(call('mediaUrl', url)) : Promise.resolve(url)),
    update: action => (available ? Promise.resolve(call('update', action)) : Promise.resolve(null)),
    onUpdate: available ? subscribe('onUpdate') : noopOff,

    async restartProcessor() {
      if (!has('restartProcessor')) return null;
      const result = await call('restartProcessor');
      if (inputs.main?.phase !== 'ready') onMain({phase: 'ready'});
      await pair();
      return result ?? null;
    },
    retryPairing: () => pair({force: true}),

    setActivity(payload) { call('setActivity', payload); },
    notify: payload => (has('notify') ? Promise.resolve(call('notify', payload)).then(Boolean, () => false) : Promise.resolve(false)),
    setBackgroundShortcuts: (on, options) => (has('setBackgroundShortcuts')
      ? Promise.resolve(call('setBackgroundShortcuts', on, options))
      : Promise.resolve({registered: [], failed: []})),
    registerMenu(spec) { call('registerMenu', spec); },
    onCommand: available ? subscribe('onCommand') : noopOff,
    onNavigate: available ? subscribe('onNavigate') : noopOff,
    onFlushRequest: available ? subscribe('onFlushRequest') : noopOff,
    onFullScreen: available ? subscribe('onFullScreen') : noopOff,
  };
  return api;
}

export const desktop = createDesktop();
