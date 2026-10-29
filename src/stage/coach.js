// First Stage coach marks (architecture §2.19, spec §6.6 item 5): non-blocking callouts anchored to
// the Stage's own controls, once per account, each dismissed by doing the thing it points at.
//
//   startStageCoach({stage, session, account, registry, document, CoachMark}) → off()
//     stage     the 'stage' context (stage.js): `anchors` (play, mix from the controls; strip,
//               getBars from the strip), `layout` and `focus` signals
//     session   the song session (transport, map, position, readOnly)
//     account, registry, document, CoachMark   the app's by default (tests pass their own)
//
// The steps (STEPS), in order; at most one mark shows at a time, the first unseen one that fits:
//   1 · Play    "Space or ▶ plays from your loop. Enter starts again with a count-in."
//               done when the transport plays or counts in (any way: Space, Enter, ▶, a pedal)
//   2 · strip   "Tap a section to jump there. Double-tap to loop it."   (a song with sections)
//               done when a press on the strip, or a key while it has focus (L loops the focused
//               segment), moves the cue, the loop or a pending jump
//   3 · Mix     "Drums OUT takes your part out of the mix. You play it."   (your part has a stem;
//               the label is the Mix control's own: `Drums`, else `Mine`) done when your part goes
//               out, or a stem is muted or soloed (the Mix sheet)
//   4 · bars    "No bar grid yet, so times are in seconds. [Get bars]"   the first time a song has
//               no bars (not on a read-only Shared Stage); done when Get bars opens (the mark's
//               button, the strip's chip, the palette, a pedal): checked after every click and
//               every SHEET_POLL_MS while the mark is up
// Play and Mix marks sit left of the rail, level with their control's row, and above it in the dock; the strip and
// bars marks sit above the strip (step 4 points at its "No bar grid · Get bars →" tray).
// Steps 1–3 read `1 of 3 · Skip`; Skip ends the whole tour. Step 4 has no counter and a
// `Not now`. A step's mark waits for its anchor (Mix is not on the Focus mini rail; the strip is
// not shown in Focus on the band) and is never shown while playing (the CoachMark primitive hides
// it until the transport stops).
//
// State: `account.onboarding.coach`, a bitmask (bits 1, 2, 4, 8 for steps 1–4). Nothing shows until
// the account has loaded, so a returning user never sees a flash of marks. A step done before then
// (or whose save failed) is kept for this Stage and written once the account can take it; a
// failed write is not retried for the same value. Calling startStageCoach again for a Stage that
// already runs one returns that coach's off().

import '../styles/views/stage/coach.css';
import {account as appAccount} from '../app/account.js';
import {registry as appRegistry} from '../app/commands.js';
import {now} from '../app/clock.js';
import {effect, untracked} from '../app/store.js';
import {Button} from '../ui/button.js';
import {CoachMark as UiCoachMark} from '../ui/coachmark.js';
import {h} from '../ui/h.js';
import {openSheetName} from './sheets/host.js';
import {mixState} from './controls.js';

/** Every string the coach marks show (spec §6.6 item 5). */
export const COPY = Object.freeze({
  play: [{strong: 'Space'}, ' or ▶ plays from your loop. ', {strong: 'Enter'}, ' starts again with a count-in.'],
  strip: ['Tap a section to jump there. Double-tap to loop it.'],
  mix: (part) => [{strong: `${part} OUT`}, ' takes your part out of the mix. You play it.'],
  bars: ['No bar grid yet, so times are in seconds.'],
  getBars: 'Get bars',
  skip: 'Skip',
  notNow: 'Not now',
});

/** The steps in the order they are offered. `tour` steps share the `i of 3` counter and Skip. */
export const STEPS = Object.freeze([
  {id: 'play', bit: 1, anchor: 'play', tour: 1},
  {id: 'strip', bit: 2, anchor: 'strip', tour: 2},
  {id: 'mix', bit: 4, anchor: 'mix', tour: 3},
  {id: 'bars', bit: 8, anchor: 'getBars', tour: null},
].map(Object.freeze));
export const TOUR_SIZE = 3;
/** The tour's bits (steps 1–3): Skip sets them all. */
export const TOUR_BITS = 1 | 2 | 4;
export const ALL_BITS = 15;
/** How long after a press on the strip a cue, loop or jump change still counts as the strip's. */
export const STRIP_WINDOW_MS = 1500;
/** While step 4 shows, how often it looks for the Get bars sheet (it can open without a click: a key, a pedal). */
export const SHEET_POLL_MS = 400;

const PLAYING = new Set(['playing', 'counting']);
/** The rail's two-column rows (controls.js LAYOUT.rail): the cell that starts Play's and Mix's row. */
const RAIL_ROW_START = Object.freeze({play: 'again', mix: 'loop'});
const running = new WeakMap();
const peek = (v) => (v && typeof v.peek === 'function' ? v.peek() : v);
const read = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const isElement = (v) => !!v && typeof v === 'object' && v.nodeType === 1;
const stepById = (id) => STEPS.find((s) => s.id === id) ?? null;

/** A whole number 0–15 from a stored `onboarding.coach` (anything else reads as 0). */
export function coachMask(value) {
  return Number.isInteger(value) && value >= 0 ? value & ALL_BITS : 0;
}

/**
 * The step to show (pure): the first in STEPS order whose bit is not in `mask` and that
 * `available[id]` allows, or null when none fits now.
 */
export function nextStep(mask, available = {}) {
  const m = coachMask(mask);
  for (const step of STEPS) if (!(m & step.bit) && available[step.id]) return step;
  return null;
}

/** The Mix control's label for your part (`Drums`, else `Mine`), as the control itself shows it. */
export function partLabel(snapshot) {
  const mix = snapshot?.mix ?? {};
  return mixState({mix: {...mix, minusMe: true}}).label;
}

/** Renders COPY rich text: strings and {strong} runs. */
function rich(parts) {
  return parts.map((p) => (typeof p === 'string' ? p : h('strong', p.strong)));
}

/** True when a Stage anchor is in the page and not hidden (Focus hides the strip on the band). */
function visible(el) {
  if (!isElement(el) || !el.isConnected) return false;
  if (el.closest('[hidden]')) return false;
  if (typeof el.checkVisibility === 'function') {
    try { return el.checkVisibility(); } catch { return true; }
  }
  return true;
}

/**
 * The element for `name` in the Stage's anchors Map: its own entry, else the Stage's marked
 * `[data-stage-anchor=<name>]` element. The Map's last fallback (the controls area) is not a step's
 * anchor, so a control that is not mounted (Mix on the Focus mini rail) reads as none.
 */
function ownAnchor(anchors, name) {
  if (!anchors || typeof anchors.get !== 'function') return null;
  const own = anchors instanceof Map ? Map.prototype.get.call(anchors, name) : null;
  if (isElement(own) && own.isConnected) return own;
  const got = anchors.get(name);
  if (!isElement(got)) return null;
  return got.getAttribute('data-stage-anchor') === 'controls' && name !== 'controls' ? null : got;
}

const stripKey = (s) => JSON.stringify([s?.cue ?? null, s?.loop?.on ?? false, s?.loop?.a ?? null, s?.loop?.b ?? null, s?.pendingJump?.t ?? null]);
// The muted and soloed stems only: the track list itself can fill in as the audio loads.
const mixKey = (s) => JSON.stringify((s?.mix?.tracks ?? []).filter((t) => t.muted || t.soloed).map((t) => [t.name, !!t.muted, !!t.soloed]));

/** Starts the coach marks for a mounted Stage. See the header. */
export function startStageCoach({stage, session, account = appAccount, registry = appRegistry, document: doc = globalThis.document,
  CoachMark = UiCoachMark} = {}) {
  if (!stage || typeof stage !== 'object') throw new TypeError('startStageCoach: stage is required');
  if (!session?.transport?.snapshot) throw new TypeError('startStageCoach: session is required');
  if (running.has(stage)) return running.get(stage);

  const transport = session.transport;
  const anchors = stage.anchors ?? null;
  const offs = [];
  let stopped = false;
  let localBits = 0;            // done on this Stage (written once the account can take them)
  let failedValue = null;       // a write that failed is not retried for the same value
  let inflightValue = null;     // the value being written
  let mark = null;              // {step, handle, anchor, extras: [destroy…]}
  let scheduled = false;

  const snap = () => peek(transport.snapshot) ?? {};
  const isPlaying = () => PLAYING.has(transport.snapshot.value?.phase);
  const loaded = () => !!peek(account.loaded);
  const stored = () => coachMask(peek(account.onboarding)?.coach);
  const mask = () => stored() | localBits;

  // ---------------- persistence ----------------
  function persist() {
    if (stopped || !loaded()) return;
    const have = stored();
    const want = have | localBits;
    if (want === have || want === failedValue || want === inflightValue) return;
    inflightValue = want;
    Promise.resolve(account.markOnboarding('coach', want)).then(() => {
      if (inflightValue === want) inflightValue = null;
    }, (err) => {
      if (inflightValue === want) inflightValue = null;
      failedValue = want;
      console.warn('[coach] could not save the coach marks:', err?.message ?? err);
    });
  }

  function complete(bits) {
    if (stopped) return;
    const before = mask();
    localBits |= bits;
    if (mask() === before) return;
    persist();
    schedule();
  }

  // ---------------- availability ----------------
  function anchorFor(step) {
    if (step.id === 'bars') {
      // An explicit getBars anchor, else the strip's "No bar grid · Get bars →" tray, else the strip.
      const own = anchors instanceof Map ? Map.prototype.get.call(anchors, 'getBars') : null;
      const strip = ownAnchor(anchors, 'strip');
      const tray = strip?.querySelector?.('.strip-tray:not([hidden])') ?? null;
      return [own, tray, strip].find((c) => visible(c)) ?? null;
    }
    const el = ownAnchor(anchors, step.anchor);
    if (!visible(el)) return null;
    // On the rail the mark sits left of the rail, level with the control's row: it points from the
    // row's first cell (Again beside Play, Loop beside Mix) so it covers no other control.
    const mate = RAIL_ROW_START[step.id];
    if (mate && peek(stage.layout) === 'rail') {
      const set = el.closest('[role="toolbar"][data-variant]');
      const first = set?.querySelector?.(`[data-ctl="${mate}"]`) ?? null;
      if (visible(first)) return first;
    }
    return el;
  }

  function availability() {
    const s = snap();
    const map = session.map;
    const mapped = !!map?.isReal;
    const out = {};
    for (const step of STEPS) {
      if (!anchorFor(step)) { out[step.id] = false; continue; }
      if (step.id === 'strip') out.strip = mapped && !!map?.hasSections;
      else if (step.id === 'mix') out.mix = Array.isArray(s.mix?.mine) && s.mix.mine.length > 0 && (s.mix?.tracks?.length ?? 0) > 1;
      else if (step.id === 'bars') out.bars = !mapped && !session.readOnly;
      else out[step.id] = true;
    }
    return out;
  }

  // ---------------- the mark ----------------
  /** Beside the rail's controls (so the mark never covers the rest of the rail), above the dock and the strip. */
  const placementFor = (step) => ((step.id === 'play' || step.id === 'mix') && peek(stage.layout) === 'rail' ? 'left' : 'top');

  function bodyFor(step) {
    if (step.id === 'play') return {body: rich(COPY.play)};
    if (step.id === 'strip') return {body: rich(COPY.strip)};
    if (step.id === 'mix') return {body: rich(COPY.mix(partLabel(snap())))};
    const button = Button({label: COPY.getBars, command: 'stage.getBars', registry, size: 'sm', variant: 'primary', className: 'stage-coach-action'});
    return {body: [...rich(COPY.bars), ' ', button.el], extras: [() => button.destroy()]};
  }

  function closeMark() {
    const m = mark;
    mark = null;
    if (!m) return;
    try { m.handle.destroy(); } catch (err) { console.warn('[coach] cleanup failed', err); }
    for (const fn of m.extras) { try { fn(); } catch (err) { console.warn('[coach] cleanup failed', err); } }
  }

  function openMark(step, anchor) {
    const {body, extras = []} = bodyFor(step);
    const tour = step.tour != null;
    const handle = CoachMark({
      anchor, body,
      step: tour ? {i: step.tour, n: TOUR_SIZE} : {i: 1, n: 1},
      skipLabel: tour ? COPY.skip : COPY.notNow,
      onSkip: () => complete(tour ? TOUR_BITS : step.bit),
      playing: isPlaying,
      placement: placementFor(step),
      className: 'stage-coach',
      dataset: {coachStep: step.id},
      testid: `coach-${step.id}`,
    });
    if (step.id === 'bars') {
      const poll = setInterval(checkGetBars, SHEET_POLL_MS);
      extras.push(() => clearInterval(poll));
    }
    mark = {step, handle, anchor, placement: placementFor(step), extras};
  }

  function evaluate() {
    scheduled = false;
    if (stopped) return;
    const step = loaded() ? nextStep(mask(), availability()) : null;
    if (mark && (!step || mark.step !== step)) {
      // Doing the thing ends the mark for good (done()); anything else (Focus took its anchor away,
      // the song changed) just takes it down until it fits again.
      if (mask() & mark.step.bit) mark.handle.done();
      closeMark();
    }
    if (!step) return;
    const anchor = anchorFor(step);
    const placement = placementFor(step);
    if (!mark) openMark(step, anchor);
    else if (mark.anchor !== anchor || mark.placement !== placement) {
      mark.anchor = anchor;
      mark.placement = placement;
      mark.handle.set({anchor, placement});
    }
  }

  function schedule() {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(evaluate);
  }

  // ---------------- doing the things ----------------
  // Changes count, not the state a song opens in (a song can open with your part already out).
  let lastMix = mixKey(snap());
  let lastOut = !!snap().mix?.minusMe;
  let lastStrip = stripKey(snap());
  let stripArmedUntil = 0;
  let stripBefore = null;
  const stripEl = () => ownAnchor(anchors, 'strip');
  const stripFocused = () => {
    const strip = stripEl();
    const active = doc?.activeElement ?? null;
    return !!strip && isElement(active) && strip.contains(active);
  };

  offs.push(effect(() => {
    const s = transport.snapshot.value ?? {};
    untracked(() => {
      if (PLAYING.has(s.phase)) complete(1);
      const mk = mixKey(s);
      const out = !!s.mix?.minusMe;
      if ((out && !lastOut) || mk !== lastMix) complete(4);
      lastMix = mk;
      lastOut = out;
      const key = stripKey(s);
      const pressed = stripBefore !== null && now() <= stripArmedUntil && key !== stripBefore;
      if (pressed || (key !== lastStrip && stripFocused())) {
        stripBefore = null;
        complete(2);
      }
      lastStrip = key;
      schedule();
    });
  }));

  // A press on the strip arms a short window for the cue / loop / jump it causes (a tap waits to
  // tell itself from a double-tap; a quantized jump lands later still, but its pending target is set at once).
  const armStrip = (event) => {
    const strip = stripEl();
    if (!strip || !isElement(event.target) || !strip.contains(event.target)) return;
    stripBefore = stripKey(snap());
    stripArmedUntil = now() + STRIP_WINDOW_MS;
  };
  // Get bars opens from the mark or the strip's chip (a click), or from a key, the palette or a pedal (the poll).
  const checkGetBars = () => queueMicrotask(() => {
    if (stopped) return;
    if (openSheetName() === 'getBars' && !session.map?.isReal) complete(8);
  });
  if (doc?.addEventListener) {
    const opts = {capture: true};
    const onAfter = () => checkGetBars();
    doc.addEventListener('pointerdown', armStrip, opts);
    doc.addEventListener('click', onAfter, opts);
    offs.push(() => {
      doc.removeEventListener('pointerdown', armStrip, opts);
      doc.removeEventListener('click', onAfter, opts);
    });
  }

  // ---------------- what decides the step ----------------
  offs.push(effect(() => {
    read(account.loaded);
    read(account.onboarding);
    read(stage.layout);
    read(stage.focus);
    read(stage.surface);
    read(session.position?.revision);
    untracked(() => { persist(); schedule(); });
  }));

  schedule();

  const off = () => {
    if (stopped) return;
    stopped = true;
    running.delete(stage);
    for (const fn of offs.splice(0)) { try { fn?.(); } catch (err) { console.warn('[coach] cleanup failed', err); } }
    closeMark();
  };
  running.set(stage, off);
  return off;
}

export default startStageCoach;

/** The step definitions by id (for tests and the fixture states). */
export {stepById};
