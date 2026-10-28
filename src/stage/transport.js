// The transport (architecture §2.14.3): one façade over the engine, the
// metronome and the map that every control, key, pedal and menu goes through.
// It owns the cue model, Play/Stop/Again/Pause, the count-in policy (D14), the
// pass counter, Play N times, Count in every pass, Between passes (D17), the
// trainer, the quantized jump (D29), the smart loop toggle, loop editing and
// the mix (Minus me, D37).
//
// Where state lives:
// - The practice state (`practice.value`, §2.14.5) holds everything that is
//   saved: cue, rate, keep-pitch, loop and its options, the mix, click and
//   count-in (`practice.click`, D14/D51), chart audio and the trainer config.
//   Every mutation is a `practice.patch` plus an `undo.push` (rule 19), and
//   `sync()` brings the engine and metronome in line with the practice value,
//   so Undo, Redo, another device's change and a map re-anchor all reach the
//   audio the same way. `applied` records what the engine was last told.
// - Run-time state (the pass counter, the trainer's step, the pending jump,
//   the count-in plate, call & response roles) lives here.
// - `snapshot` (a signal) changes only on discrete changes; the playhead never
//   passes through it (`position()` reads the engine; the frame bus draws it).
// - The phase is derived from the engine's `state` events (rule 22), never
//   set optimistically.
//
// During a count-in the engine is never asked to seek, change speed, pitch or
// loop (it would end the count, §5.1); the transport restarts or cancels the
// count per the rule 21 table, or defers the change until the count ends.
//
// Session wiring (ST1b): pass `status` (feedback.status, §2.9), `notation` (the
// notation session or a getter, for chart audio), `resplit` (desktop only: the
// "Re-split with 6 stems" action) and `stems` (the song's stem names, used
// before the engine has loaded). Call `ready()` once `engine.loadStems` has
// resolved and `map.setDuration` ran (§2.14.1 step 7): the practice state is
// then applied to the engine and an armed Play starts.
import {signal, readonly} from '../app/store.js';
import * as profileModule from '../app/profile.js';
import {LABEL_REASONS} from '../js/song-map.js';
import {formatClock, MIN_RATE, MAX_RATE} from '../../shared/practice.ts';

/** Status-line and plate copy (spec §4.2, §4.3, §4.7, Appendix A). */
export const COPY = Object.freeze({
  playedTimes: (n) => `Played ${n} times`,
  trainerDone: (rate) => `Trainer done — ${percent(rate)}%`,
  trainerStopped: 'Trainer stopped',
  interrupted: 'Paused — audio was interrupted. Press Play to continue.',
  noPartFallback: (instruments) => `This song wasn't split with a ${instruments} part. Muting Other instead.`,
  resplitAction: 'Re-split with 6 stems',
  resplitWeb: 'Re-split it from Woodshed for desktop.',
  countInPlate: (display) => (display == null ? 'Count-in · pickup' : `Count-in · bar ${display}`),
  leadInPlate: (t) => `Lead-in · ${formatClock(t)}`,
});

/** Canonical stem order for mix keys and pads (rule 18). */
export const STEM_ORDER = Object.freeze(['drums', 'bass', 'guitar', 'piano', 'vocals', 'other']);
export const TRAINER_DEFAULT = Object.freeze({start: 0.7, end: 1, step: 0.05, passes: 2});
/** The unmapped count-in: a 2 s audible lead-in with no clicks (rule 2, D14). */
export const LEAD_IN_SEC = 2;
/** Unmapped loop edges set "the other side" this far away (rule 14). */
export const UNMAPPED_EDGE_SEC = 4;
/** A pass counts when it started within this of the loop start (rule 7). */
export const PASS_START_EPS = 0.05;
/** A quantized jump needs this beyond the engine's lookahead, else it takes the next downbeat (rule 12). */
export const JUMP_MARGIN = 0.03;
const MIN_LOOP = 0.02;
const NUDGE = {tenth: 0.1, '50ms': 0.05, '10ms': 0.01};
const CLICK_MODES = ['off', 'countin', 'always'];
const CHART_AUDIO = ['off', 'quiet', 'loud'];
const PLAY_TIMES = [0, 2, 4, 8];
const BETWEEN = ['none', 'rest', 'call'];
const EVENTS = new Set(['pass', 'trainer', 'jumped', 'ended', 'interrupted', 'count', 'gesture', 'mix-sheet']);
const EPS = 1e-6;
const SAME_TIME = 1e-6;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const json = (value) => JSON.stringify(value ?? null);
const roundRate = (rate) => Math.round(clamp(rate, MIN_RATE, MAX_RATE) * 100) / 100;
function percent(rate) { return Math.round((Number.isFinite(rate) ? rate : 1) * 100); }

/** Stem names in canonical order: the six standard stems, then any others in song order, then `no_*` (rule 18). */
export function canonicalStems(names) {
  const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n);
  const rank = (name) => {
    const lower = name.toLowerCase(), i = STEM_ORDER.indexOf(lower);
    if (i >= 0) return i;
    return lower.startsWith('no_') ? STEM_ORDER.length + 1 : STEM_ORDER.length;
  };
  return list.map((name, i) => ({name, i, r: rank(name)})).sort((x, y) => x.r - y.r || x.i - y.i).map((x) => x.name);
}

/** The trainer's rates: start, start + step, … up to and including end (the last value clamped, rule 11). */
export function trainerRates({start, end, step}) {
  const lo = roundRate(start), hi = roundRate(end), size = Math.max(0.01, Math.abs(step) || 0.05);
  const dir = hi >= lo ? 1 : -1, rates = [lo];
  for (let i = 1; i < 200; i++) {
    const next = Math.round((lo + dir * i * size) * 100) / 100;
    if (dir > 0 ? next >= hi - 1e-9 : next <= hi + 1e-9) break;
    rates.push(next);
  }
  if (rates[rates.length - 1] !== hi) rates.push(hi);
  return rates;
}

function normalTrainer(cfg) {
  const c = {...TRAINER_DEFAULT, ...(cfg && typeof cfg === 'object' ? cfg : {})};
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    start: roundRate(num(c.start, TRAINER_DEFAULT.start)),
    end: roundRate(num(c.end, TRAINER_DEFAULT.end)),
    step: clamp(Math.round(num(c.step, TRAINER_DEFAULT.step) * 100) / 100, 0.01, MAX_RATE - MIN_RATE),
    passes: clamp(Math.round(num(c.passes, TRAINER_DEFAULT.passes)), 1, 32),
  };
}

/** Plain AccountSettings from an object, a signal, the account module (`{value: signal}`) or a getter. */
function settingsOf(source) {
  let v = typeof source === 'function' ? source() : source;
  for (let i = 0; i < 3 && v && typeof v === 'object'; i++) {
    if (typeof v.peek === 'function') v = v.peek();
    else if (v.value && typeof v.value === 'object' && typeof v.value.peek === 'function') v = v.value.peek();
    else break;
  }
  return v && typeof v === 'object' ? v : {};
}

export function createTransport({engine, metronome, map, position, practice, undo, account, profile = profileModule,
  status = null, notation = null, resplit = null, stems = null} = {}) {
  if (!engine || !metronome || !map || !position || !practice) throw new TypeError('createTransport: engine, metronome, map, position and practice are required');

  // ---- run-time state ----------------------------------------------------------
  let ready = false;
  let destroyed = false;
  let armed = false;
  let engineState = {playing: false, counting: false, paused: false};
  let pass = 0;
  let eligible = false;
  let stopAtPending = false;           // Play N times asked the engine to stop at the next wrap
  let pendingJump = null;              // {t, when, label, clearsLoop}
  let jumpTimer = null;
  let countdown = null;
  let countTimer = null;
  let trainer = null;                  // {cfg, rates, stepIndex, passInStep, done, pending: {at, index}|null}
  let cr = null;                       // call & response: {role, pending: {at, role}|null, names}
  let pendingSync = false;             // a change waits for the running count to end
  let applied = {};
  let depth = 0;                       // inside a compound operation: snapshot refreshes wait
  let dirty = false;
  let syncing = false;
  const listeners = new Map();
  const snap = signal(null, {equals: (a, b) => json(a) === json(b)});

  const pv = () => practice.value.peek();
  const mapped = () => !!map.isReal;
  const ctxNow = () => engine.ctx.currentTime;
  const duration = () => Math.max(0, engine.duration || map.duration || 0);
  const clampTime = (t) => clamp(Number.isFinite(t) ? t : 0, 0, duration() || Infinity);
  const accountSettings = () => settingsOf(account);
  const accountPractice = () => {
    const p = accountSettings().practice;
    return p && typeof p === 'object' ? p : {};
  };
  const keepPitchOf = (p = pv()) => (typeof p.keepPitch === 'boolean' ? p.keepPitch : accountPractice().keepPitch !== false);
  const sayStatus = (text, options) => { try { status?.(text, options); } catch (error) { queueMicrotask(() => { throw error; }); } };
  const notationSession = () => (typeof notation === 'function' ? notation() : notation);

  function emit(type, payload) {
    const set = listeners.get(type);
    if (!set?.size) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }

  /** Run `fn` as one step: the snapshot refreshes once, at the end. */
  function hold(fn) {
    depth++;
    try { return fn(); } finally {
      depth--;
      if (!depth && dirty) refresh();
    }
  }

  // ---- derived settings ------------------------------------------------------
  /** The click and count-in settings: the song's `practice.click`, else the account defaults (D14). */
  function clickState(p = pv()) {
    const c = p.click;
    if (c) {
      const lastMode = c.lastMode ?? (c.mode === 'always' ? 'countin' : c.mode);
      return {countIn: {...c.countIn}, mode: c.mode, lastMode, accent: c.accent, volume: c.volume, preRoll: c.preRoll};
    }
    const a = accountPractice(), ci = a.countIn && typeof a.countIn === 'object' ? a.countIn : {};
    const mode = CLICK_MODES.includes(a.click) ? a.click : 'countin';
    return {
      countIn: {on: ci.on === true, length: clamp(Math.round(Number.isFinite(ci.length) ? ci.length : 1), 1, 16), unit: ci.unit === 'beats' ? 'beats' : 'bars'},
      mode, lastMode: mode === 'always' ? 'countin' : mode, accent: true, volume: 0.7, preRoll: false,
    };
  }

  function metronomeConfig(click) {
    return {countIn: click.countIn.on, countInLength: click.countIn.length, countInUnit: click.countIn.unit,
      mode: click.mode, accent: click.accent, volume: click.volume, audiblePreRoll: click.preRoll};
  }

  function stemNames() {
    if (engine.tracks?.length) return engine.tracks.map((t) => t.name);
    const given = typeof stems === 'function' ? stems() : stems;
    if (Array.isArray(given) && given.length) return given.map((s) => (typeof s === 'string' ? s : s?.name)).filter(Boolean);
    return pv().tracks.map((t) => t.name);
  }

  /** `{names, fallbacks, missing}` for the account profile on this song (D37). */
  function mine() {
    return profile.myStems(accountSettings().profile ?? {}, stemNames());
  }

  function mixTracks(p = pv()) {
    const byName = new Map(p.tracks.map((t) => [t.name, t]));
    return canonicalStems(stemNames()).map((name) => {
      const t = byName.get(name);
      return {name, volume: t ? t.volume : 1, muted: !!t?.muted, soloed: !!t?.soloed};
    });
  }

  /** A bar at `t` as a rest bar's length in media seconds (the metronome's rest-bar rule). */
  function restBarSec(t) {
    const bar = map.bars[map.barIndexAt(t)];
    return bar.units * (4 / bar.denominator) * (60 / bar.qpm);
  }

  /** The segmented-loop gap for a loop (rule 9, D17): count-in and rest bar, in media seconds. */
  function gapFor(loop, click) {
    const real = mapped();
    let count = 0, rest = 0;
    if (loop.eachPassCount && click.countIn.on) count = real ? metronome.countInPlanAt(loop.a).duration : LEAD_IN_SEC;
    if (loop.between === 'rest') rest = real ? restBarSec(loop.a) : LEAD_IN_SEC;
    const sec = count + rest;
    return {sec: sec > EPS ? sec : 0, mode: !real && count > 0 ? 'preroll' : 'silent'};
  }

  function wantedPlan(p = pv()) {
    const click = clickState(p), loop = p.loop;
    const on = loop.on && loop.b - loop.a >= MIN_LOOP;
    const gap = on ? gapFor(loop, click) : {sec: 0, mode: 'silent'};
    return {rate: p.rate, keepPitch: keepPitchOf(p), loop: {on, a: loop.a, b: loop.b}, gap};
  }
  const loopKey = (want) => (want.loop.on ? json([want.loop.a, want.loop.b, want.gap.sec, want.gap.mode]) : 'off');

  // ---- sync: practice → engine and metronome ---------------------------------
  function sync() {
    if (!ready || destroyed) return;
    if (syncing) { pendingSync = true; return; }
    syncing = true;
    try {
      hold(() => {
        const p = pv();
        const click = clickState(p), conf = metronomeConfig(click), confKey = json(conf);
        if (applied.click !== confKey) { applied.click = confKey; metronome.configure(conf); }
        applyMix(p);
        const level = p.chartAudio ?? 'off', ns = notationSession();
        if (ns && applied.chartAudio !== level) { applied.chartAudio = level; ns.setChartAudio?.(level); }
        engine.editPosition = p.cue;
        const want = wantedPlan(p);
        if (engine.countingIn) syncDuringCount(want);
        else applyPlan(want);
      });
    } finally {
      syncing = false;
    }
    if (pendingSync && !engine.countingIn) { pendingSync = false; sync(); }
  }

  function applyMix(p) {
    if (!engine.tracks?.length) return;
    for (const t of mixTracks(p)) {
      const key = json([t.volume, t.muted, t.soloed]);
      if (applied['mix:' + t.name] === key) continue;
      applied['mix:' + t.name] = key;
      engine.setVolume(t.name, t.volume);
      engine.setMuted(t.name, t.muted);
      engine.setSoloed(t.name, t.soloed);
    }
  }

  /** Apply rate, keep-pitch and loop to an engine that is not counting. */
  function applyPlan(want) {
    let rateChanged = false, loopChanged = false;
    if (applied.keepPitch !== want.keepPitch) {
      const first = applied.keepPitch === undefined;
      applied.keepPitch = want.keepPitch;
      engine.setPreservePitch(want.keepPitch);
      rateChanged = !first;
    }
    if (applied.rate !== want.rate) {
      const first = applied.rate === undefined;
      applied.rate = want.rate;
      engine.setSpeed(want.rate);
      rateChanged = rateChanged || !first;
    }
    const key = loopKey(want);
    if (applied.loop !== key) {
      const first = applied.loop === undefined;
      applied.loop = key;
      engine.setLoop(want.loop.on, want.loop.a, want.loop.b, {gapSec: want.gap.sec, gap: want.gap.mode});
      loopChanged = !first;
    }
    if (rateChanged && trainer && !trainerOwnsRate(want.rate)) stopTrainer({reason: 'manual'});
    if (loopChanged && trainer) stopTrainer({reason: 'manual'});
    if (rateChanged || loopChanged) {
      resetPasses();
      if (engine.playing) { crRestart(); trainerArm(); }
    }
  }

  /** Rule 21 for practice changes that arrive while counting. */
  function syncDuringCount(want) {
    const target = engine.countIn.target;
    const rateChanged = applied.rate !== want.rate || applied.keepPitch !== want.keepPitch;
    const loopChanged = applied.loop !== loopKey(want);
    const nextTarget = loopChanged && want.loop.on ? want.loop.a : target;
    if (rateChanged || Math.abs(nextTarget - target) > EPS) restartCount(nextTarget);
    else if (loopChanged) pendingSync = true;
  }

  function trainerOwnsRate(rate) {
    if (!trainer) return false;
    return Math.abs(trainer.rates[trainer.stepIndex] - rate) < 1e-9;
  }

  // ---- starting and stopping the engine ------------------------------------------
  /** Start playback at `target` (already the engine position), with the count-in policy of rule 2. */
  async function startEngine(target, {count = true, keepPasses = false} = {}) {
    const click = clickState();
    let options = {};
    if (count && click.countIn.on) {
      options = mapped()
        ? {countIn: metronome.countInPlanAt(target), audiblePreRoll: click.preRoll}
        : {countIn: {duration: LEAD_IN_SEC, beats: []}, audiblePreRoll: true};
    }
    const started = engine.play(options);
    // The engine starts synchronously unless the context has to resume first.
    if (engine.playing) { afterStart(keepPasses); await started; return; }
    await started;
    if (engine.playing && !destroyed) afterStart(keepPasses);
  }

  /**
   * Once the engine plays: the pass counter, the trainer and call & response start from
   * here. A continue in place keeps the pass count (a pause is not a reset, rule 7).
   */
  function afterStart(keepPasses = false) {
    if (!engine.playing) return;
    hold(() => {
      if (keepPasses) playTimesArm();
      else resetPasses();
      crRestart();
      trainerArm();
      updateCountdown();
      dirty = true;
    });
  }

  /** Stop the engine where `rest` says without moving the cue (the engine's `editPosition` is the cue's storage). */
  function stopEngine(rest) {
    const cue = pv().cue;
    engine.editPosition = Number.isFinite(rest) ? rest : cue;
    engine.stop({returnToEdit: true});
    engine.editPosition = cue;
  }

  /** "Restart the count" (rule 21): stop, then count in again at `target` with pass = 0. */
  function restartCount(target) {
    hold(() => {
      stopEngine(target);
      applyPlan(wantedPlan());
      engine.seek(target, {cue: false});
      engine.editPosition = pv().cue;
      void startEngine(target, {count: true});
    });
  }

  function clearStopAt() {
    if (!stopAtPending) return;
    stopAtPending = false;
    // A discontinuity clears it in the engine; a plan change (a loop edit that keeps the position) does not.
    if (engine.stopAtWhen != null) engine._clearStopAt?.();
  }

  /** Rule 7: any seek, stop, manual speed change, loop edit or jump starts the pass count again. */
  function resetPasses(pos = engine.playing ? engine.getPosition() : pv().cue) {
    const loop = pv().loop;
    pass = 0;
    eligible = loop.on && pos <= loop.a + PASS_START_EPS;
    clearStopAt();
    dirty = true;
  }

  /**
   * The next arrival at `b` after now. At a wrap the engine can report the wrap it is
   * emitting (its time rounds to just after now); then it is the one a pass later.
   */
  function upcomingWrap() {
    const at = engine.nextWrapAt();
    if (at == null || at > ctxNow() + SAME_TIME) return at;
    const loop = engine.loop, gap = engine.loopGap?.sec ?? 0;
    return at + ((loop.b - loop.a) + gap) / (engine.rate || 1);
  }

  // ---- engine events ------------------------------------------------------------------
  const offs = [];
  offs.push(engine.on('state', (state) => {
    const wasCounting = engineState.counting;
    engineState = {...state};
    hold(() => {
      if (wasCounting && !state.counting && state.playing) {
        if (pendingSync) { pendingSync = false; sync(); }
        trainerArm();
        crSchedule();
      }
      updateCountdown();
      if (!state.playing) { crReset(); checkJump(); }
      dirty = true;
    });
  }));
  offs.push(engine.on('wrap', (wrap) => onWrap(wrap)));
  offs.push(engine.on('gap', () => updateCountdown()));
  offs.push(engine.on('plan', () => hold(() => { checkJump(); crSchedule(); updateCountdown(); dirty = true; })));
  offs.push(engine.on('transport', () => hold(() => {
    checkJump();
    if (engine.playing) crRestart();
    updateCountdown();
    dirty = true;
  })));
  offs.push(engine.on('ended', ({reason}) => onEnded(reason)));

  function onWrap(wrap) {
    hold(() => {
      // A trainer step scheduled for this wrap lands now.
      let landed = false;
      if (trainer?.pending && Math.abs(wrap.when - trainer.pending.at) < SAME_TIME) {
        landed = true;
        const index = trainer.pending.index, rate = trainer.rates[index];
        trainer.pending = null;
        trainer.stepIndex = index;
        trainer.passInStep = 0;
        trainer.done = index >= trainer.rates.length - 1;
        applied.rate = rate;
        if (pv().rate !== rate) practice.patch({rate});
        emit('trainer', {stepIndex: index, rate, done: trainer.done});
        if (trainer.done) sayStatus(COPY.trainerDone(rate));
      }
      if (eligible) {
        pass++;
        emit('pass', {pass});
        if (trainer && !landed) trainer.passInStep++;
      }
      eligible = true;
      playTimesArm();
      trainerArm();
      if (cr) {
        if (cr.pending && Math.abs(wrap.when - cr.pending.at) < SAME_TIME) { cr.role = cr.pending.role; cr.pending = null; }
        crSchedule();
      }
      dirty = true;
    });
  }

  /** Rule 8: once `pass === N − 1`, stop at the next wrap. */
  function playTimesArm() {
    const loop = pv().loop;
    if (!engine.playing || engine.countingIn || stopAtPending || !loop.on || !(loop.playTimes > 0) || pass < loop.playTimes - 1) return;
    const at = upcomingWrap();
    if (at != null) { stopAtPending = true; engine.stopAt(at); }
  }

  function onEnded(reason) {
    hold(() => {
      const times = pv().loop.playTimes;
      stopAtPending = false;
      // The engine rests where it ended; the transport rests at the cue (rule 8).
      const cue = pv().cue;
      engine.editPosition = cue;
      engine.seek(cue, {cue: false});
      pass = 0;
      if (trainer) { trainer.pending = null; trainer.passInStep = 0; }
      pendingJump = null;
      if (reason === 'stopAt' && times > 0) sayStatus(COPY.playedTimes(times));
      practice.markStopped?.();
      dirty = true;
    });
    emit('ended', {reason});
  }

  // ---- count-in plate (`countdown`, 'count') -----------------------------------------------
  function plateLabel(target) {
    if (!mapped()) return COPY.leadInPlate(target);
    const bb = map.barBeatAt(target);
    return COPY.countInPlate(bb.pickup || bb.before ? null : bb.display);
  }

  /** The plate at audio time `now`, and when it next changes. Mapped counts follow the metronome's beats; lead-ins count seconds. */
  function countdownAt(now) {
    if (!engine.playing) return {value: null, next: null};
    const c = engine.countIn;
    if (c && now < c.endWhen - 1e-9) return countFrom(now, c.target, c.beats.length ? c.beats.map((b) => c.startWhen + b.offset / c.rate) : null, c.endWhen, c.rate, c.duration);
    for (const g of engine.gapsBetween?.(now, now + 1e-3) ?? []) {
      if (g.when > now + 1e-9 || now >= g.end - 1e-9) continue;
      const click = clickState();
      if (mapped()) {
        if (!metronome.countIn) return {value: null, next: null};
        const plan = metronome.countInPlanAt(g.target), rate = g.rate || 1;
        const times = plan.beats.map((b) => g.until - (plan.duration - b.offset) / rate).filter((t) => t >= g.when - 1e-9);
        if (!times.length) return {value: null, next: null};
        if (now < times[0] - 1e-9) return {value: null, next: times[0]};
        return countFrom(now, g.target, times, g.until, rate, plan.duration);
      }
      if (!(pv().loop.eachPassCount && click.countIn.on)) return {value: null, next: null};
      const rate = g.rate || 1, start = g.until - LEAD_IN_SEC / rate;
      if (now < start - 1e-9) return {value: null, next: start};
      return countFrom(now, g.target, null, g.until, rate, LEAD_IN_SEC);
    }
    return {value: null, next: null};
  }

  function countFrom(now, target, times, end, rate, length) {
    const label = plateLabel(target);
    if (times) {
      const n = times.length;
      let i = -1;
      while (i + 1 < n && times[i + 1] <= now + 1e-6) i++;
      return {value: {current: n - Math.max(0, i), of: n, label}, next: i + 1 < n ? times[i + 1] : end};
    }
    const of = Math.max(1, Math.ceil(length - 1e-9));
    const remaining = (end - now) * rate;
    const current = clamp(Math.ceil(remaining - 1e-6), 1, of);
    return {value: {current, of, label}, next: Math.min(end, end - (current - 1) / rate)};
  }

  function updateCountdown() {
    clearTimeout(countTimer);
    countTimer = null;
    if (destroyed) return;
    const now = ctxNow();
    const {value, next} = countdownAt(now);
    if (json(value) !== json(countdown)) {
      countdown = value;
      if (value) emit('count', {...value});
      dirty = true;
      if (!depth) refresh();
    }
    if (next != null && next > now) countTimer = setTimeout(updateCountdown, Math.max(0, (next - now) * 1000) + 1);
  }

  // ---- quantized jump (rule 12, D29) --------------------------------------------------------------
  function jumpEntry() {
    if (!pendingJump) return null;
    return engine.plan.find((s) => s.scheduled && s.seekOffset != null && Math.abs(s.when - pendingJump.when) < SAME_TIME) ?? null;
  }

  /** Land a pending jump that is due, or forget one the engine no longer holds. */
  function checkJump() {
    if (!pendingJump) return;
    const entry = jumpEntry();
    if (!entry || !engine.playing) { dropJump(); return; }
    const wait = pendingJump.when - ctxNow();
    if (wait > 1e-9) {
      // The wall clock ran ahead of audio time: look again when the jump is due.
      clearTimeout(jumpTimer);
      jumpTimer = setTimeout(checkJump, wait * 1000 + 1);
      return;
    }
    const jump = pendingJump;
    dropJump();
    hold(() => {
      if (jump.clearsLoop) {
        const p = pv();
        const from = {loop: p.loop, cue: p.cue}, loop = {...p.loop, on: false};
        applied.loop = 'off';
        practice.patch({loop});
        pushUndo({key: 'loop', label: 'loop', describe: () => `loop ${loopWord(from.loop)} → off`, from, to: {loop, cue: p.cue}, apply: applyLoopValue});
      }
      resetPasses(jump.t);
    });
    emit('jumped', {t: jump.t});
  }

  function dropJump() {
    clearTimeout(jumpTimer);
    jumpTimer = null;
    if (pendingJump) { pendingJump = null; dirty = true; if (!depth) refresh(); }
  }

  /** When a jump from `pos` lands (rule 12), or null when there is no downbeat or wrap to wait for. */
  function jumpWhen(pos) {
    const loop = applied.loop !== 'off' && pv().loop.on ? pv().loop : null;
    const now = ctxNow(), soon = now + engine.lookahead + JUMP_MARGIN;
    const wrapAt = loop ? upcomingWrap() : null;
    const period = loop ? ((loop.b - loop.a) + (engine.loopGap?.sec ?? 0)) / (engine.rate || 1) : 0;
    const wrapAfter = (t) => {
      if (wrapAt == null) return null;
      let w = wrapAt;
      while (w < t && period > 0) w += period;
      return w;
    };
    const downbeatWhen = (from) => {
      const nd = map.downbeatAfter(from, loop ? {within: [loop.a, loop.b]} : {});
      return nd ? {time: nd.time, when: engine.whenAt(nd.time)} : null;
    };
    let nd = downbeatWhen(pos);
    let when = nd?.when ?? null;
    if (loop && wrapAt != null && (when == null || wrapAt < when)) { when = wrapAt; nd = null; }
    if (when != null && when < soon) {
      if (nd) {
        const following = downbeatWhen(nd.time);
        when = following?.when ?? null;
        const w = wrapAfter(soon);
        if (loop && w != null && (when == null || w < when)) when = w;
      } else {
        // The wrap is too close: the first downbeat of the next pass, or the wrap after it.
        const first = downbeatWhen(loop.a);
        const w = wrapAfter(soon);
        when = first?.when != null && first.when >= soon && (w == null || first.when < w) ? first.when : w;
      }
    }
    return when;
  }

  function jump(t, {label = null} = {}) {
    const target = clampTime(t);
    if (!ready || !engine.playing) { cue(target); return null; }
    const p = pv();
    const outside = p.loop.on && (target < p.loop.a - EPS || target >= p.loop.b - EPS);
    if (engine.countingIn) {
      // Rule 21: cancel the count, cue at the target, then count in afresh there.
      hold(() => {
        stopEngine();
        countdown = null;
        if (outside) commitLoop({on: false}, {setCue: false});
        cue(target);
        void startEngine(target, {count: true});
      });
      return null;
    }
    return hold(() => {
      if (pendingJump) cancelJump();
      if (trainer) stopTrainer({reason: 'manual'});
      if (!mapped()) {
        if (outside) commitLoop({on: false}, {setCue: false});
        engine.seek(target, {cue: false});
        engine.editPosition = pv().cue;
        resetPasses(target);
        emit('jumped', {t: target});
        return null;
      }
      const when = jumpWhen(position_());
      if (when == null) {
        if (outside) commitLoop({on: false}, {setCue: false});
        engine.seek(target, {cue: false});
        engine.editPosition = pv().cue;
        resetPasses(target);
        emit('jumped', {t: target});
        return null;
      }
      const at = engine.seekAt(target, when, outside ? {loop: {enabled: false}} : {});
      if (at == null) return null;
      pendingJump = {t: target, when: at, label, clearsLoop: outside};
      clearTimeout(jumpTimer);
      jumpTimer = setTimeout(checkJump, Math.max(0, (at - ctxNow()) * 1000) + 1);
      dirty = true;
      return {t: target, when: at, label};
    });
  }

  function cancelJump() {
    if (!pendingJump) return false;
    const had = jumpEntry();
    dropJump();
    if (had && engine.playing) engine.cancelPending();
    return true;
  }

  /** Previous (dir −1) or next (dir +1) section or marker, as a quantized jump (stopped: a cue). */
  function goToRegion(dir) {
    const list = position.regions();
    if (!list.length) return null;
    const pos = position_();
    let i = -1;
    for (let k = 0; k < list.length; k++) if (list[k].t0 <= pos + EPS) i = k;
    let region;
    if (dir > 0) region = list.find((r) => r.t0 > pos + EPS) ?? null;
    else region = i > 0 ? list[i - 1] : list[0];
    if (!region) return null;
    jump(region.t0, {label: region.label});
    return region;
  }

  // ---- play / stop -------------------------------------------------------------------------------
  function play() {
    emit('gesture', {});
    return playNow();
  }

  function playNow() {
    if (destroyed) return Promise.resolve();
    if (!ready) { armed = true; refresh(); return Promise.resolve(); }
    if (engine.playing) return Promise.resolve();
    return hold(() => {
      armed = false;
      const p = pv(), loop = p.loop;
      if (engine.paused) {
        const at = engine.pausedAt;
        const moved = loop.on && (at < loop.a - EPS || at >= loop.b - EPS);
        if (moved) engine.pausedAt = loop.a;
        return startEngine(engine.pausedAt, {count: false, keepPasses: !moved});
      }
      const start = loop.on ? loop.a : p.cue;
      if (trainer) { trainer.passInStep = 0; trainer.pending = null; }
      engine.seek(start, {cue: false});
      engine.editPosition = p.cue;
      practice.markPlayed?.();
      return startEngine(start, {count: true});
    });
  }

  function stop() {
    if (destroyed) return;
    if (!ready) { if (armed) { armed = false; refresh(); } return; }
    if (!engine.playing && !engine.paused) return;
    hold(() => {
      const counting = engine.countingIn;
      const stay = !counting && accountPractice().stop === 'stay';
      if (stay) {
        engine.stop({returnToEdit: false});
        const at = engine.editPosition;
        if (Number.isFinite(at) && at !== pv().cue) practice.patch({cue: at});
        engine.editPosition = pv().cue;
      } else {
        stopEngine();
      }
      pass = 0;
      countdown = null;
      if (trainer) { trainer.pending = null; trainer.passInStep = 0; }
      dropJump();
      stopAtPending = false;
      dirty = true;
      sync();
      practice.markStopped?.();
    });
  }

  function playStop() {
    if (!ready) { if (armed) stop(); else return play(); return Promise.resolve(); }
    if (engine.playing) { stop(); return Promise.resolve(); }
    return play();
  }

  function pause() {
    if (!ready) return play();
    if (engine.countingIn) { stop(); return Promise.resolve(); }
    if (engine.playing) {
      hold(() => {
        engine.pause();
        stopAtPending = false;
        if (trainer) trainer.pending = null;
        dirty = true;
      });
      return Promise.resolve();
    }
    return play();
  }

  /** Play from `target` with the count-in policy, from any phase (Again, Play from here). The cue never moves. */
  function playAt(target) {
    if (!ready) { armed = true; refresh(); return Promise.resolve(); }
    const countOn = clickState().countIn.on;
    if (engine.countingIn) { restartCount(target); return Promise.resolve(); }
    if (engine.playing && !countOn) {
      hold(() => {
        engine.seek(target, {cue: false});
        engine.editPosition = pv().cue;
        resetPasses(target);
      });
      return Promise.resolve();
    }
    return hold(() => {
      armed = false;
      if (engine.playing) stopEngine(target);
      engine.seek(target, {cue: false});
      engine.editPosition = pv().cue;
      practice.markPlayed?.();
      return startEngine(target, {count: true});
    });
  }

  function again() {
    emit('gesture', {});
    const p = pv();
    const target = p.loop.on ? p.loop.a : (position.againTarget(position_()) ?? p.cue);
    return playAt(clampTime(target));
  }

  function playFrom(t) {
    emit('gesture', {});
    return playAt(clampTime(t));
  }

  function armPlayWhenReady() {
    emit('gesture', {});
    if (ready && !engine.playing) return playNow();
    if (!ready) { armed = true; refresh(); }
    return Promise.resolve();
  }

  function interrupt(reason = 'audio') {
    if (!ready || (!engine.playing && !engine.paused)) return false;
    hold(() => {
      engine.pause();
      const at = engine.pausedAt;
      if (Number.isFinite(at) && at !== pv().cue) practice.patch({cue: at});
      engine.editPosition = pv().cue;
      countdown = null;
      stopAtPending = false;
      dropJump();
      if (trainer) trainer.pending = null;
      dirty = true;
    });
    sayStatus(COPY.interrupted);
    void practice.flush?.({final: true});
    emit('interrupted', {reason});
    return true;
  }

  // ---- cue and seeking ----------------------------------------------------------------------------
  /** The playhead in media seconds (§2.14.3 `position()`). */
  function position_() {
    if (!ready) return pv().cue;
    if (engine.playing) return engine.getPosition();
    if (engine.paused) return engine.pausedAt;
    return pv().cue;
  }

  /** Cue at `t` (stopped semantics). While playing only the cue flag moves; a count is cancelled first (rule 21). */
  function cue(t, {snap = 'none'} = {}) {
    const at = clampTime(snap && snap !== 'none' ? position.snap(t, snap) : t);
    hold(() => {
      if (ready && engine.countingIn) stop();
      if (pv().cue !== at) practice.patch({cue: at});
      engine.editPosition = at;
      if (ready && !engine.playing) {
        engine.seek(at, {cue: true});
        pass = 0;
      }
      dirty = true;
    });
    return at;
  }

  /** A seek; it never moves the cue unless asked (rule 23). */
  function seek(t, {cue: moveCue = false} = {}) {
    const at = clampTime(t);
    if (!ready) { if (moveCue) cue(at); return at; }
    if (engine.countingIn) { cue(at); return at; }
    hold(() => {
      if (engine.playing) {
        engine.seek(at, {cue: moveCue});
        if (moveCue) practice.patch({cue: engine.editPosition});
        engine.editPosition = pv().cue;
        const loop = pv().loop;
        resetPasses(loop.on && at >= loop.b ? loop.a : at);
      } else if (engine.paused) {
        const loop = pv().loop;
        engine.pausedAt = loop.on && at >= loop.b ? loop.a : at;
        if (moveCue) practice.patch({cue: at});
        pass = 0;
      } else if (moveCue) {
        cue(at);
      } else {
        engine.pausedAt = at;
      }
      dirty = true;
    });
    return at;
  }

  /** Stopped: cue; otherwise seek. Steps, Home and End share this. */
  function moveTo(t) {
    if (!ready || (!engine.playing && !engine.paused)) return cue(t);
    return seek(t);
  }

  function step(kind, dir) { return moveTo(position.stepTarget(position_(), kind === 'beat' ? 'beat' : 'bar', dir < 0 ? -1 : 1)); }
  function nudgeCue(ms) { return cue(pv().cue + (Number.isFinite(ms) ? ms : 0) / 1000); }
  function home() { const loop = pv().loop; return moveTo(loop.on ? loop.a : 0); }
  function end() { const loop = pv().loop; return moveTo(loop.on ? loop.b : duration()); }

  // ---- loop -----------------------------------------------------------------------------------------
  function loopWord(loop) {
    return loop.on && loop.b - loop.a >= MIN_LOOP ? position.loopLabel(loop.a, loop.b) : 'off';
  }

  function applyLoopValue(value) {
    practice.patch({loop: value.loop, cue: value.cue});
  }

  /**
   * Set the loop (rule 1: setting a loop sets cue = a). `next` is merged into the current loop;
   * bar refs are taken on mapped songs. One undo step (key 'loop').
   */
  function commitLoop(next, {label = 'loop', setCue = true, undoable = true} = {}) {
    const p = pv(), end = duration();
    const loop = {...p.loop, ...next};
    let a = clamp(Number.isFinite(loop.a) ? loop.a : 0, 0, end || Infinity), b = clamp(Number.isFinite(loop.b) ? loop.b : 0, 0, end || Infinity);
    if (b < a) [a, b] = [b, a];
    loop.a = a; loop.b = b;
    if (loop.on && b - a < MIN_LOOP) return false;
    delete loop.aBar; delete loop.bBar;
    if (b - a >= MIN_LOOP && mapped()) {
      const ra = position.ref(a), rb = position.ref(b);
      if (ra) loop.aBar = ra;
      if (rb) loop.bBar = rb;
    }
    const cueAt = loop.on && setCue ? a : p.cue;
    const from = {loop: p.loop, cue: p.cue}, to = {loop, cue: cueAt};
    if (json(from) === json(to)) return false;
    hold(() => {
      if (trainer) stopTrainer({reason: 'manual'});
      if (practice.activeSpotId && practice.activeSpotId.peek?.() != null) practice.activeSpotId.value = null;
      practice.patch({loop, cue: cueAt});
      if (undoable) pushUndo({key: 'loop', label, describe: () => `loop ${loopWord(from.loop)} → ${loopWord(loop)}`, from, to, apply: applyLoopValue});
      resetPasses();
      dirty = true;
    });
    return true;
  }

  function hasRange(loop = pv().loop) { return loop.b - loop.a >= MIN_LOOP; }

  function toggleLoop() {
    const loop = pv().loop;
    if (hasRange(loop)) return commitLoop({on: !loop.on});
    const d = position.loopDefault(position_());
    return commitLoop({on: true, a: d.a, b: d.b});
  }

  function loopSection() {
    const t = position_();
    const region = mapped() ? (map.hasSections ? position.regionAt(t) : null) : position.regionAt(t);
    if (region) return commitLoop({on: true, a: region.t0, b: region.t1});
    const d = position.loopDefault(t);
    return commitLoop({on: true, a: d.a, b: d.b});
  }

  function loopRange(a, b, {label = 'loop', snap = 'bar'} = {}) {
    const s = (t) => (snap && snap !== 'none' ? position.snap(t, snap) : t);
    return commitLoop({on: true, a: s(Math.min(a, b)), b: s(Math.max(a, b))}, {label});
  }

  function loopBars(t, n = 4) {
    const count = Math.max(1, Math.round(n));
    if (!mapped()) {
      const a = clampTime(t);
      let b = a;
      for (let i = 0; i < count; i++) b = position.stepTarget(b, 'bar', 1);
      return commitLoop({on: true, a, b});
    }
    const index = map.barIndexAt(t);
    return commitLoop({on: true, a: map.barToTime(index), b: map.barToTime(index + count)});
  }

  /** The other loop edge one bar (mapped) or 4 s (unmapped) from `t`. */
  function edgeAway(t, dir) {
    if (mapped()) return position.stepTarget(t, 'bar', dir);
    return clampTime(t + dir * UNMAPPED_EDGE_SEC);
  }

  function edgeTime(exact) {
    const t = ready && (engine.playing || engine.paused) ? position_() : pv().cue;
    return exact ? clampTime(t) : position.snap(t, 'bar');
  }

  function loopIn({exact = false} = {}) {
    const loop = pv().loop, a = edgeTime(exact);
    let b = loop.b;
    if (!hasRange(loop) || b <= a + MIN_LOOP) b = edgeAway(a, 1);
    return commitLoop({on: true, a, b}, {label: 'loop in'});
  }

  function loopOut({exact = false} = {}) {
    const loop = pv().loop, b = edgeTime(exact);
    let a = loop.a;
    if (!hasRange(loop) || a >= b - MIN_LOOP) a = edgeAway(b, -1);
    return commitLoop({on: true, a, b}, {label: 'loop out'});
  }

  function moveLoop(dir) {
    const loop = pv().loop;
    if (!hasRange(loop)) return false;
    const length = loop.b - loop.a, end = duration();
    let a = loop.a + (dir < 0 ? -1 : 1) * length;
    a = clamp(a, 0, Math.max(0, end - length));
    return commitLoop({a, b: a + length}, {label: 'move loop'});
  }

  function extendLoopTo(t) {
    const loop = pv().loop, at = clampTime(t);
    if (!hasRange(loop)) {
      const from = position_();
      return loopRange(Math.min(from, at), Math.max(from, at));
    }
    if (at < loop.a) return commitLoop({on: true, a: mapped() ? map.snapTime(at, 'bar', {mode: 'floor'}) : at}, {label: 'extend loop'});
    if (at > loop.b) return commitLoop({on: true, b: mapped() ? map.snapTime(at + 1e-3, 'bar', {mode: 'ceil'}) : at}, {label: 'extend loop'});
    return false;
  }

  function nudgeLoopEdge(edge, dir, unit = 'bar') {
    const loop = pv().loop;
    if (!hasRange(loop)) return false;
    const key = edge === 'b' ? 'b' : 'a', sign = dir < 0 ? -1 : 1, from = loop[key];
    let t;
    if ((unit === 'bar' || unit === 'beat') && mapped()) t = position.stepTarget(from, unit, sign);
    else t = from + sign * (NUDGE[unit] ?? NUDGE.tenth);
    t = clampTime(Math.round(t * 1e6) / 1e6);
    const next = {[key]: t};
    const a = key === 'a' ? t : loop.a, b = key === 'b' ? t : loop.b;
    if (b - a < MIN_LOOP) return false;
    return commitLoop(next, {label: 'loop edge'});
  }

  function clearLoop() {
    const loop = pv().loop;
    if (!loop.on && !hasRange(loop)) return false;
    return commitLoop({on: false, a: 0, b: 0}, {label: 'clear loop', setCue: false});
  }

  function setLoopOptions({eachPassCount, playTimes, between} = {}) {
    const p = pv(), next = {};
    if (typeof eachPassCount === 'boolean') next.eachPassCount = eachPassCount;
    if (PLAY_TIMES.includes(playTimes)) next.playTimes = playTimes;
    if (BETWEEN.includes(between)) {
      if (between === 'call' && !mine().names.length) return false;
      next.between = between;
    }
    const loop = {...p.loop, ...next};
    if (json(loop) === json(p.loop)) return false;
    const from = {loop: p.loop, cue: p.cue}, to = {loop, cue: p.cue};
    hold(() => {
      practice.patch({loop});
      pushUndo({key: 'loop', label: 'loop options', describe: () => 'loop options', from, to, apply: applyLoopValue});
      if (next.playTimes !== undefined) clearStopAt();
      if (engine.playing) crRestart();
      dirty = true;
    });
    return true;
  }

  // ---- speed -------------------------------------------------------------------------------------------
  function speedValue(p = pv()) { return {rate: p.rate, lastRate: p.lastRate ?? null}; }

  function applySpeedValue(value) {
    practice.patch((draft) => {
      draft.rate = value.rate;
      if (value.lastRate == null) delete draft.lastRate;
      else draft.lastRate = value.lastRate;
    });
  }

  function setSpeed(rate, {coalesce = true} = {}) {
    if (!Number.isFinite(rate)) return false;
    const next = roundRate(rate), p = pv();
    if (next === p.rate) return false;
    const from = speedValue(p), to = {rate: next, lastRate: next !== 1 ? next : from.lastRate};
    hold(() => {
      if (trainer) stopTrainer({reason: 'manual'});
      applySpeedValue(to);
      pushUndo({key: 'speed', label: 'speed', describe: (f, t) => `speed ${percent(f.rate)}% → ${percent(t.rate)}%`, from, to, apply: applySpeedValue, coalesce});
      dirty = true;
    });
    return true;
  }

  function nudgeSpeed(pct) {
    const current = pv().rate;
    return setSpeed(Math.round(current * 100 + (Number.isFinite(pct) ? pct : 0)) / 100);
  }

  function toggleSpeed100() {
    const p = pv();
    if (p.rate !== 1) return setSpeed(1, {coalesce: false});
    if (p.lastRate && p.lastRate !== 1) return setSpeed(p.lastRate, {coalesce: false});
    return false;
  }

  function setKeepPitch(on) {
    const p = pv(), next = !!on, before = keepPitchOf(p);
    if (next === before) return false;
    const from = {keepPitch: p.keepPitch ?? null}, to = {keepPitch: next};
    const apply = (value) => practice.patch((draft) => {
      if (value.keepPitch == null) delete draft.keepPitch;
      else draft.keepPitch = value.keepPitch;
    });
    hold(() => {
      apply(to);
      pushUndo({key: 'keepPitch', label: 'keep pitch', describe: () => `keep pitch ${before ? 'on' : 'off'} → ${next ? 'on' : 'off'}`, from, to, apply});
      dirty = true;
    });
    return true;
  }

  // ---- trainer (rule 11) --------------------------------------------------------------------------------
  function startTrainer(cfg) {
    const p = pv();
    const c = normalTrainer(cfg ?? p.trainer ?? TRAINER_DEFAULT);
    const rates = trainerRates(c);
    return hold(() => {
      if (trainer) stopTrainer({reason: 'restart'});
      if (!p.loop.on) {
        // D28: the trainer's target range becomes the loop first, as one undo step.
        const t = position_();
        const section = mapped() && map.hasSections ? map.sectionAt(t) : null;
        const range = section ? [section.t0, section.t1] : [0, duration()];
        commitLoop({on: true, a: range[0], b: range[1]}, {label: 'trainer loop'});
      }
      trainer = {cfg: c, rates, stepIndex: 0, passInStep: 0, done: rates.length <= 1, pending: null};
      practice.patch({trainer: c, rate: rates[0]});
      emit('trainer', {stepIndex: 0, rate: rates[0], done: trainer.done});
      if (engine.playing && !engine.countingIn) { trainer.passInStep = 0; trainerArm(); }
      dirty = true;
      return true;
    });
  }

  function stopTrainer({reason = 'user'} = {}) {
    if (!trainer) return false;
    const pending = trainer.pending;
    trainer = null;
    if (pending && engine.playing && engine.plan.some((s) => s.scheduled && Math.abs(s.when - pending.at) < SAME_TIME)) engine.cancelPending();
    if (reason === 'manual') sayStatus(COPY.trainerStopped);
    dirty = true;
    if (!depth) refresh();
    return true;
  }

  /** Schedule the next step at the next wrap when it is due (rule 11), once playback runs. */
  function trainerArm() {
    if (!trainer || trainer.done || trainer.pending || !engine.playing || engine.countingIn) return;
    const next = trainer.stepIndex + 1;
    if (next >= trainer.rates.length) return;
    const passes = trainer.cfg.passes;
    if (passes > 1 && trainer.passInStep < passes - 1) return;
    const at = upcomingWrap();
    if (at == null || at <= ctxNow() + engine.lookahead) return;
    engine.setSpeed(trainer.rates[next], {at});
    trainer.pending = {at, index: next};
  }

  function trainerSnapshot() {
    if (!trainer) return null;
    const {cfg, rates, stepIndex, passInStep, done} = trainer;
    return {start: cfg.start, end: cfg.end, step: cfg.step, passes: cfg.passes, stepIndex, steps: rates.length, passInStep, rate: rates[stepIndex], done};
  }

  // ---- call & response (rule 10, D17) -----------------------------------------------------------------
  function crGains(role, names) { return Object.fromEntries(names.map((n) => [n, role === 'play' ? 0 : 1])); }

  function crWanted() {
    const loop = pv().loop;
    if (!engine.playing || !loop.on || loop.between !== 'call') return null;
    const names = mine().names;
    return names.length ? names : null;
  }

  /** At play start (and after a discontinuity): this pass listens, the next one plays. */
  function crRestart() {
    const names = crWanted();
    if (!names) { crReset(); return; }
    if (cr?.pending) engine.setTrackGains(crGains('listen', cr.names), {at: cr.pending.at});
    cr = {role: 'listen', pending: null, names};
    engine.setTrackGains(crGains('listen', names));
    crSchedule();
    dirty = true;
  }

  /** Keep the alternate gains scheduled at the next wrap, moving them when the plan moved the wrap. */
  function crSchedule() {
    if (!cr) return;
    if (!crWanted()) { crReset(); return; }
    // A switch whose wrap has come is the current role now (a plan event can precede the wrap event).
    if (cr.pending && cr.pending.at <= ctxNow() + 1e-9) { cr.role = cr.pending.role; cr.pending = null; }
    const at = upcomingWrap();
    if (cr.pending && at != null && Math.abs(cr.pending.at - at) < SAME_TIME) return;
    if (cr.pending) { engine.setTrackGains(crGains(cr.role, cr.names), {at: cr.pending.at}); cr.pending = null; }
    if (at == null) return;
    const role = cr.role === 'listen' ? 'play' : 'listen';
    engine.setTrackGains(crGains(role, cr.names), {at});
    cr.pending = {at, role};
  }

  function crReset() {
    if (!cr) return;
    // The engine restores every gain on pause and stop; while playing, restore them now.
    if (engine.playing) {
      if (cr.pending) engine.setTrackGains(crGains('listen', cr.names), {at: cr.pending.at});
      engine.setTrackGains(crGains('listen', cr.names));
    }
    cr = null;
    dirty = true;
  }

  // ---- click and count-in (D14) -----------------------------------------------------------------------
  function writeClick(change, label) {
    const p = pv(), before = clickState(p);
    const next = {...before, ...change, countIn: {...before.countIn, ...(change.countIn ?? {})}};
    next.countIn.length = clamp(Math.round(next.countIn.length), 1, 16);
    next.countIn.unit = next.countIn.unit === 'beats' ? 'beats' : 'bars';
    next.countIn.on = !!next.countIn.on;
    if (!CLICK_MODES.includes(next.mode)) next.mode = before.mode;
    if (next.mode !== 'always') next.lastMode = next.mode;
    next.volume = clamp(Number.isFinite(next.volume) ? next.volume : before.volume, 0, 1);
    next.accent = !!next.accent;
    next.preRoll = !!next.preRoll;
    if (json(next) === json(before)) return false;
    const from = {click: p.click ?? null}, to = {click: next};
    const apply = (value) => practice.patch((draft) => {
      if (value.click) draft.click = value.click;
      else delete draft.click;
    });
    const countWasOn = before.countIn.on;
    hold(() => {
      const counting = ready && engine.countingIn;
      const target = counting ? engine.countIn.target : null;
      apply(to);
      pushUndo({key: label === 'click volume' ? 'click.volume' : 'click', label, describe: () => describeClick(label, before, next), from, to, apply, coalesce: label === 'click volume'});
      // Rule 21: count-in off during a count ends it now and plays from the target.
      if (counting && countWasOn && !next.countIn.on) {
        stopEngine(target);
        applyPlan(wantedPlan());
        engine.seek(target, {cue: false});
        engine.editPosition = pv().cue;
        void startEngine(target, {count: false});
      }
      dirty = true;
    });
    return true;
  }

  function describeClick(label, before, next) {
    if (label === 'count-in') return `count-in ${before.countIn.on ? 'on' : 'off'} → ${next.countIn.on ? 'on' : 'off'}`;
    if (label === 'click') return `click ${before.mode} → ${next.mode}`;
    if (label === 'click volume') return `click volume ${percent(before.volume)}% → ${percent(next.volume)}%`;
    return label;
  }

  function setCountIn({on, length, unit} = {}) {
    const countIn = {};
    if (typeof on === 'boolean') countIn.on = on;
    if (Number.isFinite(length)) countIn.length = length;
    if (unit === 'bars' || unit === 'beats') countIn.unit = unit;
    return writeClick({countIn}, 'count-in');
  }
  function toggleCountIn() { return setCountIn({on: !clickState().countIn.on}); }
  function setClickMode(mode) { return CLICK_MODES.includes(mode) ? writeClick({mode}, 'click') : false; }
  function toggleClick() {
    const c = clickState();
    return writeClick({mode: c.mode === 'always' ? (c.lastMode ?? 'countin') : 'always'}, 'click');
  }
  function setAccent(on) { return writeClick({accent: !!on}, 'accent'); }
  function setClickVolume(v) { return Number.isFinite(v) ? writeClick({volume: v}, 'click volume') : false; }
  function setPreRoll(on) { return writeClick({preRoll: !!on}, 'pre-roll'); }

  // ---- mix (rule 18) ------------------------------------------------------------------------------------------
  function mixValue(p = pv()) { return {tracks: p.tracks, minusMe: !!p.minusMe, onlyMe: !!p.onlyMe}; }
  function applyMixValue(value) {
    practice.patch((draft) => {
      draft.tracks = value.tracks;
      draft.minusMe = value.minusMe;
      if (value.onlyMe) draft.onlyMe = true;
      else delete draft.onlyMe;
    });
  }

  function mixWord(value) {
    const tracks = value.tracks ?? [];
    const solo = tracks.filter((t) => t.soloed), out = tracks.filter((t) => t.muted);
    if (solo.length === 1 && !out.length) return `${solo[0].name} solo`;
    if (out.length === 1 && !solo.length) return `${out[0].name} out`;
    if (!solo.length && !out.length && tracks.every((t) => t.volume === 1)) return 'full mix';
    return 'mix';
  }

  /** Derive Minus me / Only me from the tracks, so a manual change keeps the flags honest. */
  function withFlags(tracks) {
    const names = mine().names, byName = new Map(tracks.map((t) => [t.name, t]));
    const minusMe = names.length > 0 && names.every((n) => byName.get(n)?.muted);
    const soloed = tracks.filter((t) => t.soloed).map((t) => t.name);
    const onlyMe = names.length > 0 && names.every((n) => byName.get(n)?.soloed) && soloed.every((n) => names.includes(n));
    return {tracks, minusMe, onlyMe};
  }

  function writeMix(tracks, {key = 'mix', label = 'mix', coalesce, flags = null, undoable = true} = {}) {
    const p = pv(), from = mixValue(p);
    const to = flags ? {tracks, ...flags} : withFlags(tracks);
    if (json(from) === json(to)) return false;
    hold(() => {
      applyMixValue(to);
      if (undoable) pushUndo({key, label, describe: (f, t) => (key.startsWith('level:') ? `${label} ${percent(trackOf(f, key.slice(6))?.volume ?? 1)}% → ${percent(trackOf(t, key.slice(6))?.volume ?? 1)}%` : `mix ${mixWord(f)} → ${mixWord(t)}`), from, to, apply: applyMixValue, coalesce});
      dirty = true;
    });
    return true;
  }
  const trackOf = (value, name) => (value.tracks ?? []).find((t) => t.name === name);

  function editTracks(fn) {
    const tracks = mixTracks().map((t) => ({...t}));
    fn(tracks);
    return tracks;
  }

  function setMuted(name, on) {
    if (!stemNames().includes(name)) return false;
    return writeMix(editTracks((ts) => { const t = ts.find((x) => x.name === name); t.muted = !!on; }), {label: `mute ${name}`});
  }
  function setSoloed(name, on) {
    if (!stemNames().includes(name)) return false;
    return writeMix(editTracks((ts) => { const t = ts.find((x) => x.name === name); t.soloed = !!on; }), {label: `solo ${name}`});
  }
  function setVolume(name, v, {coalesce = true} = {}) {
    if (!stemNames().includes(name) || !Number.isFinite(v)) return false;
    return writeMix(editTracks((ts) => { ts.find((x) => x.name === name).volume = clamp(v, 0, 1); }), {key: `level:${name}`, label: `${name} level`, coalesce});
  }
  /** `i` is the 0-based index in canonical stem order (`mix.mute.N` passes N − 1). */
  function toggleMuteAt(i) {
    const t = mixTracks()[i];
    return t ? setMuted(t.name, !t.muted) : false;
  }
  function toggleSoloAt(i) {
    const t = mixTracks()[i];
    return t ? setSoloed(t.name, !t.soloed) : false;
  }

  /**
   * Minus me: mute my stems (D37). With no matching stem, ask for the Mix sheet ('mix-sheet'
   * event) and return false. `{undoable: false}` is the session's "open with my part Out".
   */
  function minusMe(on, {undoable = true} = {}) {
    const {names, fallbacks} = mine();
    if (!names.length) { emit('mix-sheet', {reason: 'no-part'}); return false; }
    const want = typeof on === 'boolean' ? on : !pv().minusMe;
    const tracks = editTracks((ts) => {
      for (const t of ts) if (names.includes(t.name)) { t.muted = want; if (want) t.soloed = false; }
    });
    const changed = writeMix(tracks, {label: want ? 'Minus me' : 'my part in', undoable});
    if (want && changed && fallbacks.length) {
      const text = COPY.noPartFallback(fallbacks.join(' or '));
      if (typeof resplit === 'function') sayStatus(text, {action: {label: COPY.resplitAction, run: resplit}});
      else sayStatus(`${text} ${COPY.resplitWeb}`);
    }
    return want;
  }

  function onlyMe(on) {
    const {names} = mine();
    if (!names.length) { emit('mix-sheet', {reason: 'no-part'}); return false; }
    const want = typeof on === 'boolean' ? on : !pv().onlyMe;
    const tracks = editTracks((ts) => {
      for (const t of ts) {
        if (names.includes(t.name)) { t.soloed = want; if (want) t.muted = false; }
        else if (want) t.soloed = false;
      }
    });
    writeMix(tracks, {label: want ? 'Only me' : 'Only me off'});
    return want;
  }

  function fullMix() {
    const tracks = editTracks((ts) => { for (const t of ts) { t.volume = 1; t.muted = false; t.soloed = false; } });
    return writeMix(tracks, {label: 'Full mix', flags: {minusMe: false, onlyMe: false}});
  }

  function setChartAudio(level) {
    if (!CHART_AUDIO.includes(level)) return false;
    const p = pv(), before = p.chartAudio ?? 'off';
    if (before === level) return false;
    const apply = (value) => practice.patch({chartAudio: value});
    hold(() => {
      apply(level);
      pushUndo({key: 'mix', label: 'chart playback', describe: (f, t) => `chart playback ${f} → ${t}`, from: before, to: level, apply});
      dirty = true;
    });
    return true;
  }

  /** "Start over" (spec §4.12): cue 0, loop off, 100%, as one undo step. */
  function startOver() {
    const p = pv();
    const from = {cue: p.cue, loop: p.loop, rate: p.rate};
    const to = {cue: 0, loop: {...p.loop, on: false}, rate: 1};
    if (json(from) === json(to)) return false;
    const apply = (value) => practice.patch({cue: value.cue, loop: value.loop, rate: value.rate});
    hold(() => {
      if (trainer) stopTrainer({reason: 'user'});
      if (ready && (engine.playing || engine.paused)) stop();
      apply(to);
      if (ready) engine.seek(0, {cue: true});
      pushUndo({key: 'startOver', label: 'start over', describe: () => 'start over', from, to, apply});
      dirty = true;
    });
    return true;
  }

  // ---- undo -----------------------------------------------------------------------------------------------------
  function pushUndo(entry) {
    if (!undo || typeof undo.push !== 'function') return null;
    return undo.push(entry);
  }

  // ---- snapshot ----------------------------------------------------------------------------------------------------
  function phaseNow() {
    if (!ready) return 'loading';
    if (engineState.playing) return engineState.counting ? 'counting' : 'playing';
    return engineState.paused ? 'paused' : 'stopped';
  }

  function build() {
    const p = pv(), click = clickState(p), loop = p.loop;
    return {
      phase: phaseNow(), armed,
      cue: p.cue, rate: p.rate, lastRate: p.lastRate ?? null, keepPitch: keepPitchOf(p),
      loop: {
        on: loop.on, a: loop.a, b: loop.b, aBar: loop.aBar ?? null, bBar: loop.bBar ?? null,
        eachPassCount: loop.eachPassCount, playTimes: loop.playTimes, between: loop.between,
        label: hasRange(loop) ? position.loopLabel(loop.a, loop.b) : '',
        role: cr?.role ?? null,
      },
      pass, passTarget: loop.on && loop.playTimes > 0 ? loop.playTimes : null,
      countIn: {...click.countIn},
      click: {mode: click.mode, lastMode: click.lastMode, accent: click.accent, volume: click.volume, preRoll: click.preRoll},
      countdown: countdown ? {...countdown} : null,
      mix: {tracks: mixTracks(p), minusMe: !!p.minusMe, onlyMe: !!p.onlyMe, mine: mine().names, chartAudio: p.chartAudio ?? 'off'},
      trainer: trainerSnapshot(),
      pendingJump: pendingJump ? {t: pendingJump.t, when: pendingJump.when, label: pendingJump.label} : null,
    };
  }

  function refresh() {
    if (destroyed) return;
    if (depth) { dirty = true; return; }
    dirty = false;
    snap.value = build();
  }

  // ---- practice, map and readiness -------------------------------------------------------------------------
  const offPractice = practice.value.subscribe(() => { sync(); refresh(); });
  // Account changes (the profile, the practice defaults) reach the mix, the click defaults and the snapshot.
  const accountSource = account && typeof account === 'object'
    ? (typeof account.subscribe === 'function' ? account : (account.value && typeof account.value.subscribe === 'function' ? account.value : null))
    : null;
  const offAccount = accountSource ? accountSource.subscribe(() => { sync(); refresh(); }) : null;
  const offMap = typeof map.subscribe === 'function' ? map.subscribe((reason) => {
    if (!ready || destroyed) { refresh(); return; }
    if (engine.countingIn && !LABEL_REASONS.includes(reason)) restartCount(engine.countIn.target);
    else sync();
    refresh();
  }) : null;

  /** The engine has loaded (§2.14.1 step 7): apply the practice state, then start an armed Play. */
  function markReady() {
    if (ready || destroyed) return Promise.resolve();
    if (!engine.tracks?.length) return Promise.resolve();
    ready = true;
    applied = {};
    engineState = {playing: !!engine.playing, counting: !!engine.countingIn, paused: !!engine.paused};
    hold(() => {
      sync();
      if (!engine.playing && !engine.paused) engine.seek(pv().cue, {cue: true});
      dirty = true;
    });
    if (armed) return playNow();
    return Promise.resolve();
  }

  if (engine.tracks?.length) markReady();
  else refresh();

  function on(type, fn) {
    if (!EVENTS.has(type)) throw new TypeError(`Unknown transport event: ${type}`);
    let set = listeners.get(type);
    if (!set) listeners.set(type, set = new Set());
    set.add(fn);
    return () => { set.delete(fn); };
  }

  function destroy() {
    if (destroyed) return;
    crReset();
    destroyed = true;
    clearTimeout(countTimer);
    clearTimeout(jumpTimer);
    for (const off of offs) off?.();
    offPractice?.();
    offAccount?.();
    offMap?.();
    listeners.clear();
  }

  return {
    snapshot: readonly(snap),
    position: position_,
    playStop, play, stop, pause, again, playFrom,
    cue, seek, step, nudgeCue, home, end,
    jump, cancelJump, goToRegion,
    toggleLoop, loopSection, loopRange, loopBars, loopIn, loopOut,
    moveLoop, extendLoopTo, nudgeLoopEdge, clearLoop, setLoopOptions,
    setSpeed, nudgeSpeed, toggleSpeed100, setKeepPitch, startTrainer, stopTrainer: () => stopTrainer({reason: 'user'}),
    setCountIn, toggleCountIn, setClickMode, toggleClick, setAccent, setClickVolume, setPreRoll,
    setMuted, setSoloed, setVolume, toggleMuteAt, toggleSoloAt,
    minusMe, onlyMe, fullMix, setChartAudio, startOver,
    interrupt, armPlayWhenReady,
    /** The engine finished loading (§2.14.1 step 7). Idempotent. */
    ready: markReady,
    get isReady() { return ready; },
    on, destroy,
  };
}

export default createTransport;
