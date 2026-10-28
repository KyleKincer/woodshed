// Beat detection and section suggestions for one song session (architecture
// §2.14.1 detect.js, D44, D47, B5).
//
//   createDetectFlow({session, ...deps}) → DetectFlow
//
// Where a detection runs (`canDetect`):
// - desktop: this computer's processor once it is ready (or busy), with the
//   local companion's deviceId (from /status) so the job goes to this computer;
// - otherwise (the web, or a desktop whose processor is not running): the
//   most recently seen online paired computer (store.library.devices, B5);
// - else a reason. Shared (read-only) songs and export-only accounts never
//   detect (D10).
//
// One applier per case (D44):
// - unmapped song: `worker.beatsDone` writes the map itself and stamps the job
//   `appliedAt`; the session sees the map through its external-change path
//   (`songs.get`), which shows "Beat grid found · Undo" when this session
//   started the job (`claimServerResult()`), else "Bars found · Undo";
// - mapped song: the server keeps only `job.result`; this flow applies it
//   through `session.mapChange` (one practice-undo step, or one map-stack step
//   while Edit · Map is mounted, D23) and calls `jobs.markApplied`.
// - `resume()` on open follows a live detection for the song and offers a
//   finished, unapplied one: "Bars found while you were away · [Use them]"
//   ([Use them] applies it; [Not now] marks it applied too, so it is offered once).
//
// Suggestions (D47): `song.sectionSuggestion` shows while the map is real and
// has no sections. Keep all → one map change ('sections' labels) plus
// `songs.dismissSectionSuggestion`; dismiss → only the latter; review → Edit ·
// Map with the suggestion review open.
import {signal, computed, readonly, effect, store as appStore} from '../app/store.js';
import {now as clockNow} from '../app/clock.js';
import {describeError} from '../app/error-copy.js';
import {registry} from '../app/commands.js';
import {desktop as appDesktop} from '../app/desktop.js';
import {status as feedbackStatus} from '../app/feedback.js';
import * as jobsApi from '../api/jobs.js';
import * as songsApi from '../api/songs.js';
import {isOnline, RECHECK_MS} from '../api/devices.js';
import {applySuggestion} from '../../shared/song-map.ts';

export const COPY = Object.freeze({
  finding: (percent) => `Finding bars · ${percent}%`,
  findingSections: (percent) => `Finding sections · ${percent}%`,
  waiting: 'Waiting to find bars',
  waitingSections: 'Waiting to find sections',
  found: 'Beat grid found',
  foundElsewhere: 'Bars found',
  away: 'Bars found while you were away',
  useThem: 'Use them',
  notNow: 'Not now',
  undo: 'Undo',
  detectLabel: 'Detect beats',
  awayLabel: 'Use the bars found while you were away',
  sectionsFound: 'Sections suggested',
  keepAllLabel: 'Add suggested sections',
  sectionsAdded: (n) => (n === 1 ? 'Added 1 section' : `Added ${n} sections`),
  noneAdded: 'No sections added: every suggested bar already has a label.',
  needsDesktop: 'Needs Woodshed for desktop running on one of your computers.',
  processorStarting: 'Woodshed’s processor is starting.',
  processorOffline: 'Woodshed’s processor isn’t running on this computer.',
  readOnly: 'Add this song to your library to find its bars.',
  exportOnly: 'Finding bars is paused on this account.',
  needsMap: 'Needs a bar grid first.',
  auditioning: 'Finish with Find a chart first: Use their map or Keep my map.',
  busy: 'Wait for Finding bars to finish first.',
  busySections: 'Wait for Finding sections to finish first.',
});

const KINDS = Object.freeze(['beats', 'sections']);
const LIVE = new Set(['queued', 'running']);
const IDLE = Object.freeze({phase: 'idle'});

const isLiveJob = (job) => LIVE.has(job?.status);
const jobIdOf = (job) => job?.jobId ?? job?.id ?? job?._id ?? null;
const peekSignal = (value) => (value && typeof value === 'object' && 'value' in value
  ? (typeof value.peek === 'function' ? value.peek() : value.value) : !!value);

/** `[[time, beatInBar], …]` (worker.beatsDone) → `[{time, downbeat}]` (SongMapStore.replaceFromBeats). */
export function beatsOf(result) {
  const list = Array.isArray(result?.beats) ? result.beats : [];
  return list
    .map((b) => (Array.isArray(b) ? {time: +b[0], downbeat: Math.round(+b[1]) === 1} : {time: +b?.time, downbeat: !!b?.downbeat}))
    .filter((b) => Number.isFinite(b.time));
}

/** The status-line text while a job runs. */
export function lineFor(job, kind = job?.kind) {
  const sections = kind === 'sections';
  if (job?.status === 'queued') return sections ? COPY.waitingSections : COPY.waiting;
  const percent = Math.max(0, Math.min(100, Math.round(Number.isFinite(job?.percent) ? job.percent : 0)));
  return sections ? COPY.findingSections(percent) : COPY.finding(percent);
}

/**
 * Where a detection would run (pure).
 * @returns {{ok: boolean, reason?: string, deviceId?: string}}
 */
export function detectTarget({readOnly = false, accountStatus = 'active', desktopAvailable = false, processor = null, devices = [], now = 0}) {
  if (readOnly) return {ok: false, reason: COPY.readOnly};
  if (accountStatus === 'export_only' || accountStatus === 'suspended') return {ok: false, reason: COPY.exportOnly};
  if (desktopAvailable && (processor?.phase === 'ready' || processor?.phase === 'busy')) {
    return processor.deviceId ? {ok: true, deviceId: processor.deviceId} : {ok: true};
  }
  const online = (Array.isArray(devices) ? devices : []).find((d) => isOnline(d, now));
  if (online) return {ok: true, deviceId: online.deviceId};
  if (desktopAvailable) {
    const phase = processor?.phase;
    return {ok: false, reason: phase === 'starting' || phase === 'pairing' ? COPY.processorStarting : COPY.processorOffline};
  }
  return {ok: false, reason: COPY.needsDesktop};
}

export function createDetectFlow({
  session,
  jobs = jobsApi,
  songs = songsApi,
  library = appStore.library,
  accountSession = appStore.session,
  desktop = appDesktop,
  status = feedbackStatus,
  navigate = (path) => registry.context().router?.navigate(path),
  clock = {now: clockNow},
  recheckMs = RECHECK_MS,
} = {}) {
  if (!session) throw new TypeError('createDetectFlow: session is required');
  const state = signal(IDLE);
  const offer = signal(null);              // {jobId, beats} for "Bars found while you were away"
  const dismissed = signal(null);          // a suggestion dismissed here (hidden before the server echoes)
  const tick = signal(0);                  // device presence is re-evaluated every recheckMs
  let watch = null;                        // {jobId, kind, off}
  let starting = null;
  let pendingResult = null;                // a mapped-song result that arrived during an audition
  let serverApplyExpected = false;         // this session started a beats job on an unmapped song
  let destroyed = false;
  const offs = [];

  const songId = () => session.id;
  const map = () => session.map;
  const timer = setInterval(() => { tick.value = tick.peek() + 1; }, recheckMs);

  const canDetect = computed(() => {
    tick.value;
    return detectTarget({
      readOnly: !!session.readOnly,
      accountStatus: accountSession?.value?.status ?? 'active',
      desktopAvailable: !!desktop?.available,
      processor: desktop?.processor?.value ?? null,
      devices: library?.devices?.value ?? [],
      now: clock.now(),
    });
  });

  const suggestion = computed(() => {
    const song = session.song.value;
    session.position?.revision?.value;     // re-read on every map change
    session.position?.mapped?.value;
    const s = song?.sectionSuggestion;
    const m = map();
    if (!s || !Array.isArray(s.sections) || !s.sections.length || !m?.isReal || m.hasSections) return null;
    if (dismissed.value && dismissed.value === (s.jobId ?? s.createdAt ?? true)) return null;
    return {sections: s.sections.map((b) => ({t0: b.t0, label: b.label, confidence: b.confidence}))};
  });

  const auditioning = () => peekSignal(session.mapEditor?.peek?.()?.auditioning);

  /* ---------- applying a result ---------- */

  function markApplied(jobId) {
    if (!jobId) return;
    Promise.resolve(jobs.markApplied({jobId})).catch((err) => console.warn('Could not mark the detection applied.', err));
  }

  /** Apply detected beats to a mapped song: one undo step on the right stack, then markApplied. */
  function applyBeats(jobId, beats, {label = COPY.detectLabel} = {}) {
    if (!beats.length) { markApplied(jobId); return false; }
    if (auditioning()) { pendingResult = {jobId, beats}; return false; }
    try {
      session.mapChange(label, (m) => m.replaceFromBeats(beats), {status: {text: COPY.found, undoLabel: COPY.undo}});
    } catch (err) {
      // A drum-part guard can refuse the new bars: keep the job unapplied so it is offered again.
      status(err?.message || String(err), {key: 'detect'});
      return false;
    }
    markApplied(jobId);
    return true;
  }

  // A result that waited for an audition to end is applied right after it.
  offs.push(effect(() => {
    const editor = session.mapEditor?.value;
    const flag = editor?.auditioning;
    const on = flag && typeof flag === 'object' && 'value' in flag ? flag.value : !!flag;
    if (!on && pendingResult) {
      const {jobId, beats} = pendingResult;
      pendingResult = null;
      queueMicrotask(() => { if (!destroyed) applyBeats(jobId, beats); });
    }
  }));

  /* ---------- watching a job ---------- */

  function stopWatching() {
    watch?.off?.();
    watch = null;
  }

  function onJob(jobId, kind, job) {
    if (destroyed || watch?.jobId !== jobId) return;
    if (!job) { stopWatching(); state.value = IDLE; return; }
    if (isLiveJob(job)) {
      state.value = {phase: 'running', jobId, kind, percent: Number.isFinite(job.percent) ? job.percent : 0, line: lineFor(job, kind)};
      return;
    }
    stopWatching();
    if (job.status === 'error' || job.status === 'failed' || job.status === 'canceled' || job.status === 'cancelled') {
      serverApplyExpected = false;
      state.value = {phase: 'error', jobId, kind, error: describeError({...job, jobId}, {context: 'detect'})};
      return;
    }
    // done
    state.value = {phase: 'done', jobId, kind, percent: 100};
    if (kind === 'sections') return;
    if (job.appliedAt != null) return;   // the server wrote the map (unmapped song); the external-change path shows it
    const beats = beatsOf(job.result);
    if (beats.length) applyBeats(jobId, beats);
  }

  function follow(jobId, kind) {
    if (watch?.jobId === jobId) return;
    stopWatching();
    const entry = {jobId, kind, off: null};
    watch = entry;
    state.value = {phase: 'running', jobId, kind, percent: 0, line: lineFor({status: 'queued'}, kind)};
    try {
      entry.off = jobs.subscribeJob({jobId}, (job) => onJob(jobId, kind, job), (err) => {
        if (watch !== entry) return;
        stopWatching();
        state.value = {phase: 'error', jobId, kind, error: describeError(err, {context: 'detect'})};
      });
    } catch (err) {
      watch = null;
      state.value = {phase: 'error', jobId, kind, error: describeError(err, {context: 'detect'})};
    }
  }

  /* ---------- the public flow ---------- */

  async function start({kind = 'beats'} = {}) {
    if (destroyed) return;
    if (!KINDS.includes(kind)) throw new TypeError(`Unknown detection kind: ${kind}`);
    const live = state.peek();
    if (starting) return starting;
    if (live.phase === 'running' || live.phase === 'starting') {
      if (live.kind === kind) return;
      // One detection at a time: the flow follows one job, and a second kind would drop the first one's result.
      status(live.kind === 'sections' ? COPY.busySections : COPY.busy, {key: 'detect'});
      return;
    }
    const target = canDetect.peek();
    if (!target.ok) { status(target.reason, {key: 'detect'}); return; }
    if (kind === 'sections' && !map()?.isReal) { status(COPY.needsMap, {key: 'detect'}); return; }
    if (auditioning()) { status(COPY.auditioning, {key: 'detect'}); return; }
    state.value = {phase: 'starting', kind};
    const args = {songId: songId(), ...(target.deviceId ? {deviceId: target.deviceId} : {})};
    starting = (async () => {
      try {
        const create = kind === 'sections' ? jobs.createSectionDetection : jobs.createBeatDetection;
        const result = await create(args);
        if (destroyed) return;
        const jobId = jobIdOf(result);
        if (!jobId) throw new Error('No detection job was created.');
        if (kind === 'beats' && !map()?.isReal) serverApplyExpected = true;
        follow(jobId, kind);
      } catch (err) {
        if (destroyed) return;
        state.value = {phase: 'error', kind, error: describeError(err, {context: 'detect'})};
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  /**
   * Try a failed detection again on its own device; a newer live detection (`job_live`) is
   * followed instead. No deviceId is sent: `jobs.retry` re-queues the job on the computer it
   * ran on and refuses any other id (`retry_wrong_device`, App. C item 26), while `canDetect`
   * names whichever computer is best now.
   */
  async function retry() {
    const failed = state.peek();
    if (failed.phase !== 'error' || !failed.jobId) return start({kind: failed.kind ?? 'beats'});
    const kind = failed.kind ?? 'beats';
    state.value = {phase: 'starting', kind, jobId: failed.jobId};
    try {
      await jobs.retry({jobId: failed.jobId});
      if (destroyed) return;
      if (kind === 'beats' && !map()?.isReal) serverApplyExpected = true;
      watch = null;
      follow(failed.jobId, kind);
    } catch (err) {
      if (destroyed) return;
      const live = err?.code === 'job_live' ? err?.data?.jobId : null;
      if (live) { follow(live, kind); return; }
      state.value = {phase: 'error', kind, jobId: failed.jobId, error: describeError(err, {context: 'detect'})};
    }
  }

  function useOffer() {
    const current = offer.peek();
    if (!current) return false;
    offer.value = null;
    return applyBeats(current.jobId, current.beats, {label: COPY.awayLabel});
  }

  function dismissOffer() {
    const current = offer.peek();
    if (!current) return;
    offer.value = null;
    markApplied(current.jobId);
  }

  /** On open (after the audio is ready): follow a live detection and offer a finished, unapplied one (D44). */
  async function resume() {
    if (destroyed || session.readOnly) return;
    const live = (library?.jobs?.peek?.() ?? []).find((j) => j?.songId === songId() && KINDS.includes(j.kind) && isLiveJob(j));
    if (live && !watch) follow(jobIdOf(live), live.kind);
    let job = null;
    try { job = await jobs.latestDetection({songId: songId()}); } catch (err) { console.warn('Could not read the latest detection.', err); return; }
    if (destroyed || !job || job.appliedAt != null) return;
    const beats = beatsOf(job.result);
    const jobId = jobIdOf(job);
    if (!beats.length || !jobId || !map()?.isReal) return;   // an unmapped song's result is written by the server
    if (watch?.jobId === jobId) return;
    offer.value = {jobId, beats};
    status(COPY.away, {action: {label: COPY.useThem, run: useOffer}, key: 'detect-offer', durationMs: 10000});
  }

  /** The external-change path asks whether a server-written map is this session's own detection. */
  function claimServerResult() {
    const own = serverApplyExpected;
    serverApplyExpected = false;
    return own;
  }

  function keepAll() {
    const s = suggestion.peek();
    if (!s || session.readOnly) return null;
    // mapChange refuses during a Find a chart audition: keep the suggestion for afterwards.
    if (auditioning()) { status(COPY.auditioning, {key: 'detect'}); return null; }
    let added = 0;
    const result = session.mapChange(COPY.keepAllLabel, (m) => {
      const {change, added: n} = applySuggestion(m.data, s, m.duration);
      added = n;
      if (n) m.edit(change, 'sections');
    }, {status: {text: () => COPY.sectionsAdded(added), undoLabel: COPY.undo}});
    if (!result) status(COPY.noneAdded, {key: 'detect'});
    dismiss();
    return result;
  }

  function dismiss() {
    const song = session.song.peek();
    const s = song?.sectionSuggestion;
    if (!s || session.readOnly) return;
    dismissed.value = s.jobId ?? s.createdAt ?? true;
    Promise.resolve(songs.dismissSectionSuggestion({id: songId()})).catch((err) => console.warn('Could not dismiss the section suggestion.', err));
  }

  function review() {
    navigate(`/s/${encodeURIComponent(songId())}/edit/map?review=sections`);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopWatching();
    clearInterval(timer);
    for (const off of offs) off?.();
    pendingResult = null;
  }

  return {
    state: readonly(state),
    canDetect,
    start, retry, resume,
    offer: readonly(offer), useOffer, dismissOffer,
    suggestion,
    keepAll, dismiss, review,
    claimServerResult,
    destroy,
  };
}

export default createDetectFlow;
