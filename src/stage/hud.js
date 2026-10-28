// The Stage HUD (architecture §2.14.10, §4.4; spec §4.3, §4.10, §4.13): the identity row,
// the readouts (Section, Next, Position, beat lamps, Speed, Loop, Mix) and the count-in plate.
// The status line (role=status) is the Stage frame's (stage.js renders S2's statusLine there,
// together with the resume chip and the detection and markers offers); the HUD only writes to it.
//
//   mountHud(el, {session, stage, registry, plateHost, wake, pedal, setlist, jobs, navigate,
//                 status, announce, prefs, now}) → {el, setLayout(l), setFocus(on), actionSlot, cover, refresh(), destroy()}
//     session    the song Session (§2.14.1)
//     stage      the 'stage' command context (stage.js), optional; read for plateHost,
//                wakeLock.held / wakeHeld, pedalMode, setlist and leaveHint()
//     registry   the command registry (default: the app registry)
//     plateHost  where the count-in plate overlays (the top of the music area); default
//                stage.plateHost, else inside `el`
//     wake       ReadonlySignal<boolean>: the screen wake lock is held (☼); default stage.wakeLock.held
//     pedal      ReadonlySignal<boolean>: pedal mode is on (⎍); default stage.pedalMode
//     setlist    ReadonlySignal<{id, name, index /* 0-based */, count, next: {title}|null}|null>: the
//                `?set=` context (the HUD set line with setlist.prev / setlist.next); default stage.setlist
//     jobs       the Jobs model (`ready`: songs finished this session and not opened since; the
//                `1 ready` chip); default src/library/jobs.js sharedJobsModel()
//     navigate   (path) → void for the `1 ready` menu; default the 'router' context's navigate
//   setLayout('rail'|'band')  the readout arrangement (layout.js decides; the HUD never measures)
//   setFocus(on)              band: hides the identity row; rail: the 120 px mini rail
//                             (Section, Position, lamps; the mini controls carry Speed and Play)
//   actionSlot                the read-only identity row's action slot (SH1 fills it:
//                             "Add to my library" / "Sign in to keep a copy")
//   cover                     the identity cover element (view-transition-name cover-<songId>)
//
// Text rules are §4.4 exactly; the pure builders below are exported for the table test. Readout
// text repaints from the frame bus at ≤ 30 Hz, the lamps at 60 Hz (and on each count-in beat,
// including silent counts), and everything once on each transport, map or practice change (the
// bus idles while stopped). While playing the identity row dims to 40% (hud.css); nothing in the
// HUD moves or resizes: readouts have fixed min widths in ch.
import '../styles/views/stage/hud.css';
import '../styles/views/stage/count-in.css';
import {registry as appRegistry} from '../app/commands.js';
import {now as clockNow} from '../app/clock.js';
import {announce as appAnnounce, status as appStatus} from '../app/feedback.js';
import {prefs as appPrefs} from '../app/prefs.js';
import {effect, untracked} from '../app/store.js';
import {BeatLamps} from '../ui/beat-lamps.js';
import {Button, IconButton} from '../ui/button.js';
import {Chip} from '../ui/chip.js';
import {h} from '../ui/h.js';
import {HoldButton} from '../ui/hold-button.js';
import {icon} from '../ui/icon.js';
import {Menu} from '../ui/menu.js';
import {Readout} from '../ui/readout.js';
import {Cover, nameCover} from '../library/cards.js';
import {sharedJobsModel} from '../library/jobs.js';
import {formatClock} from '../../shared/practice.ts';
import {readFrame} from './frame.js';
import {formatTenths} from './position.js';
import {stemLabel} from './transport-commands.js';
import {COPY, HUD_CONTROLS} from './hud.copy.js';

export {COPY};
export const CONTROLS = HUD_CONTROLS;

/** Section crossfade (spec §4.3): the --motion-enter token, 160 ms. */
export const SECTION_FADE_MS = 160;
/** Dragging the speed value: 1% per 12 px (architecture §2.14.10). */
export const SPEED_DRAG_PX = 12;
/** Two taps within this make a double-tap on the readouts (Focus, §3.2 view.focus). */
export const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 10;
const EDGE_EPS = 0.01;
const SECTION_EPS = 0.01;

const read = (sig) => (sig && typeof sig === 'object' && 'value' in sig ? (typeof sig.peek === 'function' ? sig.peek() : sig.value) : sig);
const track = (sig) => (sig && typeof sig === 'object' && 'value' in sig ? sig.value : sig);
const pct = (rate) => Math.round((Number.isFinite(rate) ? rate : 1) * 100);
const isPlaying = (phase) => phase === 'playing' || phase === 'counting';

// ---------------------------------------------------------------------------------------------------------------
// The §4.4 text rules (pure apart from reading the map and the position model)

/** Position: mapped `{display} · {beat}` (or `Pickup · {beat}`) with `{m:ss} / {m:ss}`; unmapped `m:ss` and no sub. */
export function positionText(position, t) {
  const {main, sub} = position.label(t);
  const at = main.indexOf(COPY.separator);
  return at < 0
    ? {main, bar: main, beat: null, sub: null}
    : {main, bar: main.slice(0, at), beat: main.slice(at + COPY.separator.length), sub};
}

/** Section: the section (mapped) or marker region (unmapped) at t; null hides the readout. */
export function sectionText(position, t) {
  const region = position.regionAt(t);
  return region ? String(region.label ?? region.name ?? '') || null : null;
}

/** Next: `next: {name} · {n} bars`, the last-two-bars countdown in --now, or the unmapped `next: {label} · {m:ss}`. */
export function nextText(position, t) {
  const next = position.next(t);
  return next ? {text: next.text, imminent: !!next.imminent} : null;
}

/** The felt bpm at t (mapped), or null. */
function bpmAt(map, t) {
  if (!map?.isReal || typeof map.bpmAt !== 'function' || typeof map.positionAt !== 'function') return null;
  const bpm = map.bpmAt(map.positionAt(Math.max(0, t)));
  return Number.isFinite(bpm) && bpm > 0 ? bpm : null;
}

/** Speed: `75%` (in --ink-3 at exactly 100%), sub `{round(bpm at t × rate)} bpm` when mapped. */
export function speedText(snapshot, {map, t = 0} = {}) {
  const rate = Number.isFinite(snapshot?.rate) ? snapshot.rate : 1;
  const bpm = bpmAt(map, t);
  return {
    value: COPY.percent(pct(rate)),
    tone: pct(rate) === 100 ? 'ink-3' : 'ink',
    sub: bpm == null ? null : COPY.bpm(Math.round(bpm * rate)),
  };
}

/** Bars x–y of a loop range on a mapped song ('Bars 13–20', 'Bar 13', 'Pickup–bar 4'). */
function barsOfRange(map, a, b) {
  const bars = map.bars;
  if (!bars.length) return '';
  const index = (t) => (t < bars[0].t0 - EDGE_EPS ? -1 : map.barIndexAt(t));
  const first = index(a + EDGE_EPS);
  const last = Math.max(first, index(Math.max(a + 1e-6, b - EDGE_EPS)));
  const x = first < 0 ? null : bars[first].display;
  const y = last < 0 ? null : bars[last].display;
  if (x === y) return x === null ? COPY.pickup : COPY.bar(x);
  if (x === null) return COPY.pickupBars(y);
  return COPY.bars(x, y);
}

/** The section whose [t0, t1) equals [a, b) (within 10 ms), or null. */
function sectionEqual(map, a, b) {
  return (map.sections ?? []).find((s) => Math.abs(s.t0 - a) <= SECTION_EPS && Math.abs(s.t1 - b) <= SECTION_EPS) ?? null;
}

/**
 * Loop (hidden when off): line 1 `LOOP · {section}` when [a, b) is a section, else `LOOP`; line 2
 * `Bars {x}–{y} · pass {n}` (unmapped `{m:ss.s}–{m:ss.s} · pass {n}`) with `· listen` / `· you play`
 * during call & response; `trainer` is `Trainer {start} → {end}% · step {i} of {n}` (or the done line).
 * The pass count is the completed traversals; it shows once one has completed.
 */
export function loopText(snapshot, {map} = {}) {
  const loop = snapshot?.loop;
  if (!loop?.on || !(loop.b > loop.a)) return null;
  const mapped = !!map?.isReal;
  const section = mapped ? sectionEqual(map, loop.a, loop.b) : null;
  const line1 = COPY.loopLine1(section ? section.name : null);
  const range = mapped ? barsOfRange(map, loop.a, loop.b) : `${formatTenths(loop.a)}–${formatTenths(loop.b)}`;
  const parts = [range];
  const pass = Number.isFinite(snapshot.pass) ? snapshot.pass : 0;
  if (pass > 0) parts.push(Number.isFinite(snapshot.passTarget) ? COPY.passOf(pass, snapshot.passTarget) : COPY.pass(pass));
  if (loop.role === 'listen') parts.push(COPY.listen);
  else if (loop.role === 'play') parts.push(COPY.youPlay);
  const tr = snapshot.trainer;
  const trainer = !tr ? null : tr.done
    ? COPY.trainerDone(pct(tr.rate))
    : COPY.trainer(pct(tr.start), pct(tr.end), (tr.stepIndex ?? 0) + 1, tr.steps ?? 1);
  return {line1, line2: parts.join(COPY.separator), trainer};
}

const word = (name) => stemLabel(name).toUpperCase();

/**
 * Mix: `DRUMS OUT` (the muted instruments, up to two), `BASS SOLO`, `MIX` when the mix changed in a
 * way no word names; null for the full mix.
 */
export function mixText(snapshot) {
  const tracks = Array.isArray(snapshot?.mix?.tracks) ? snapshot.mix.tracks : [];
  const soloed = tracks.filter((t) => t.soloed);
  const muted = tracks.filter((t) => t.muted && !t.soloed);
  const levels = tracks.some((t) => Number.isFinite(t.volume) && Math.abs(t.volume - 1) > 1e-3);
  if (!soloed.length && !muted.length && !levels) return null;
  if (soloed.length) {
    return soloed.length <= 2 ? {text: `${soloed.map((t) => word(t.name)).join(COPY.join)} ${COPY.solo}`, kind: 'solo'} : {text: COPY.mixWord, kind: 'mix'};
  }
  if (muted.length && muted.length <= 2) return {text: `${muted.map((t) => word(t.name)).join(COPY.join)} ${COPY.out}`, kind: 'out'};
  return {text: COPY.mixWord, kind: 'mix'};
}

/** Count-in plate: the current number and `Count-in · bar {display}` / `Lead-in · {m:ss}`; null when not counting. */
export function plateText(countdown) {
  if (!countdown || !Number.isFinite(countdown.current)) return null;
  return {number: String(countdown.current), label: String(countdown.label ?? '')};
}

/**
 * The meter unit the lamps light for a count-in beat. The counted beats are the ones that end at the
 * target (the metronome's count-in plan), so the plate's `current` counts back from the target:
 * `beats` (that plan's `{unit}` beats, when known) gives the unit directly, `beats[length − current]`
 * (a loop-gap count whose start the gap cut keeps its last beats, so this holds there too). Without
 * the plan, the counts run back from a target on the bar's downbeat through the bar's groups.
 */
export function countUnit(countdown, bar, beats = null) {
  if (!countdown || !bar) return -1;
  const current = Math.max(1, Math.round(countdown.current ?? 1));
  if (Array.isArray(beats) && beats.length) {
    const beat = beats[beats.length - current];
    if (beat && Number.isFinite(beat.unit)) return beat.unit;
  }
  const groups = Array.isArray(bar.groups) && bar.groups.length ? bar.groups : [1];
  const starts = [];
  let unit = 0;
  for (const g of groups) { starts.push(unit); unit += g; }
  return starts[(starts.length - (current % starts.length)) % starts.length];
}

// ---------------------------------------------------------------------------------------------------------------
// mountHud

export function mountHud(el, {
  session, stage = null, registry = appRegistry, plateHost, wake, pedal, setlist, jobs, navigate,
  status = appStatus, announce = appAnnounce, prefs = appPrefs, now = clockNow,
} = {}) {
  if (!el) throw new TypeError('mountHud: el is required');
  if (!session?.transport) throw new TypeError('mountHud: session is required');
  const {transport, map, position} = session;
  const ac = new AbortController();
  const listen = {signal: ac.signal};
  const offs = [];
  const destroyers = [];
  let destroyed = false;

  const wakeSig = wake ?? stage?.wakeLock?.held ?? stage?.wakeHeld ?? null;
  const pedalSig = pedal ?? stage?.pedalMode ?? null;
  const setlistSig = setlist ?? stage?.setlist ?? null;
  let jobsModel = jobs ?? null;
  const getJobs = () => (jobsModel ??= sharedJobsModel());
  const go = navigate ?? ((path) => registry.context().router?.navigate?.(path));
  const runCommand = (id, extra = {}) => registry.run(id, {source: 'pointer', ...extra});
  const snap = () => transport.snapshot.peek();

  // ---- root ---------------------------------------------------------------------------------------------------
  const root = h('div', {class: 'hud', dataset: {layout: 'band'}});
  el.append(root);

  // ---- identity row (spec §4.3, §4.13) ------------------------------------------------------------------------
  const back = HoldButton({
    label: COPY.back, icon: 'chevron-left', iconOnly: true, variant: 'quiet', size: 'md', className: 'hud-back',
    requireHold: () => isPlaying(snap().phase),
    onActivate: () => runCommand('stage.leave'),
    // The Stage's own hint when it has one (stage.leaveHint), else the same copy through the status line.
    onTapWhileHold: () => (typeof stage?.leaveHint === 'function' ? stage.leaveHint() : status(COPY.holdToLeave, {key: 'leave'})),
  });
  destroyers.push(() => back.destroy());
  const cover = Cover({className: 'hud-cover'});
  cover.el.dataset.stageCover = '';
  const title = h('h1', {class: 'hud-title selectable'});
  const artist = h('p', {class: 'hud-artist selectable'});
  const keyChip = Chip({label: '', className: 'hud-chip'});
  const tuningChip = Chip({label: '', className: 'hud-chip'});
  destroyers.push(() => keyChip.destroy(), () => tuningChip.destroy());
  const sharedLine = h('p', {class: 'hud-shared'});
  const actionSlot = h('span', {class: 'hud-action-slot'});
  const notes = Button({label: COPY.notes, icon: 'sticky-note', size: 'sm', variant: 'quiet', command: 'stage.notes', registry, className: 'hud-notes'});
  destroyers.push(() => notes.destroy());
  const wakeIcon = h('span', {class: 'hud-indicator', role: 'img', 'aria-label': COPY.wake, title: COPY.wake, hidden: true}, icon('sun', {size: 20}));
  const pedalIcon = h('span', {class: 'hud-indicator', role: 'img', 'aria-label': COPY.pedal, title: COPY.pedal, hidden: true}, icon('footprints', {size: 20}));
  const readyChip = Button({label: COPY.ready(1), size: 'sm', variant: 'secondary', className: 'hud-ready', title: COPY.readyMenu});
  readyChip.el.hidden = true;
  destroyers.push(() => readyChip.destroy());
  const more = IconButton({label: COPY.more, icon: 'ellipsis', command: 'stage.menu', registry, size: 'md', className: 'hud-more'});
  // The ⋯ menu anchors to its button (the 'stage' context's anchors Map, while mounted).
  const anchors = stage?.anchors && typeof stage.anchors.set === 'function' ? stage.anchors : null;
  anchors?.set('menu', more.el);
  destroyers.push(() => {
    // The entry itself, past a get() override that skips detached nodes (stage.js's anchors map).
    const own = anchors instanceof Map ? Map.prototype.get.call(anchors, 'menu') : anchors?.get('menu');
    if (own === more.el) anchors.delete('menu');
  });
  destroyers.push(() => more.destroy());

  const setText = h('span', {class: 'hud-set-text'});
  const setPrev = IconButton({label: COPY.setPrev, icon: 'chevron-left', command: 'setlist.prev', registry, size: 'sm'});
  const setNext = IconButton({label: COPY.setNextLabel, icon: 'chevron-right', command: 'setlist.next', registry, size: 'sm'});
  destroyers.push(() => setPrev.destroy(), () => setNext.destroy());
  const setLine = h('div', {class: 'hud-set', role: 'group', 'aria-label': COPY.setGroup, hidden: true}, setPrev.el, setText, setNext.el);

  const identity = h('header', {class: 'hud-identity'},
    back.el,
    h('div', {class: 'hud-cover-box'}, cover.el),
    h('div', {class: 'hud-titles'}, title, artist),
    // One chip row (ORCH-1): key, tuning, the shared line and action slot, Notes, ☼, ⎍, `1 ready`. The band
    // lays the two groups out inline (.hud-chips is display: contents there); the rail wraps them as one
    // row under the title block (hud.css).
    h('div', {class: 'hud-chips'},
      h('div', {class: 'hud-meta'}, keyChip.el, tuningChip.el, sharedLine, actionSlot),
      h('div', {class: 'hud-tools'}, notes.el, wakeIcon, pedalIcon, readyChip.el)),
    more.el,
    setLine,
  );

  // ---- readouts -----------------------------------------------------------------------------------------------
  const sectionLayers = [h('span', {class: 'hud-section-layer'}), h('span', {class: 'hud-section-layer', 'aria-hidden': 'true'})];
  const sectionEl = h('div', {class: 'hud-section', role: 'group', 'aria-label': COPY.section, hidden: true}, ...sectionLayers);
  const next = Readout({label: COPY.next, size: 'sub', className: 'hud-next'});
  next.el.hidden = true;
  destroyers.push(() => next.destroy());

  const posBar = h('span', {class: 'hud-pos-bar'});
  const posSep = h('span', {class: 'hud-pos-sep', 'aria-hidden': 'true'}, COPY.separator.trim());
  const posBeat = h('span', {class: 'hud-pos-beat'});
  const posMain = h('span', {class: 'hud-pos-main'}, posBar, posSep, posBeat);
  const posSub = h('span', {class: 'hud-pos-sub', hidden: true, dataset: {volatile: true}});
  const posEl = h('div', {class: 'hud-position', role: 'group', 'aria-label': COPY.position, dataset: {volatile: true}}, posMain);
  const lamps = BeatLamps({units: 4, groups: [1, 1, 1, 1], className: 'hud-lamps'});
  destroyers.push(() => lamps.destroy());

  const speed = Readout({label: COPY.speed, size: 'speed', mono: true, minCh: 4, className: 'hud-speed'});
  speed.el.title = COPY.speedDrag;
  destroyers.push(() => speed.destroy());

  const loopLine1 = h('span', {class: 'hud-loop-line1'});
  const loopLine2 = h('span', {class: 'hud-loop-line2', dataset: {volatile: true}});
  const loopTrainer = h('span', {class: 'hud-loop-trainer', hidden: true});
  const loopEl = h('button', {type: 'button', class: 'hud-loop', title: COPY.loopOptions, hidden: true},
    loopLine1, loopLine2, loopTrainer);
  loopEl.addEventListener('click', (e) => {
    if (loopEl.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    runCommand('loop.card', {event: e});
  }, listen);

  const mixIcon = h('span', {class: 'hud-mix-icon', 'aria-hidden': 'true'});
  const mixWordEl = h('span', {class: 'hud-mix-word'});
  const mixEl = h('div', {class: 'hud-mix', role: 'group', 'aria-label': COPY.mix, hidden: true}, mixIcon, mixWordEl);

  const readouts = h('section', {class: 'hud-readouts', role: 'group', 'aria-label': COPY.nowPlaying},
    h('div', {class: 'hud-cell hud-cell-section'}, sectionEl, next.el),
    // The time sits beside the lamps on the band and under them on the rail.
    h('div', {class: 'hud-cell hud-cell-position'}, posEl, h('div', {class: 'hud-lamp-row'}, lamps.el, posSub)),
    h('div', {class: 'hud-cell hud-cell-speed'}, speed.el),
    h('div', {class: 'hud-cell hud-cell-loop'}, loopEl, mixEl),
  );
  root.append(identity, readouts);

  // ---- count-in plate (overlay at the top of the music; spec §4.3) -------------------------------------------
  const plateNumber = h('span', {class: 'stage-count-number'});
  const plateLabel = h('span', {class: 'stage-count-label'});
  const plate = h('div', {class: 'stage-count-plate', 'aria-hidden': 'true', hidden: true}, plateNumber, plateLabel);
  const plateParent = plateHost ?? stage?.plateHost ?? root;
  plateParent.append(plate);

  // ---- painting -----------------------------------------------------------------------------------------------
  let shownSection;            // undefined: nothing painted yet
  let activeLayer = 0;
  let fadeTimer = null;
  function paintSection(name) {
    if (name === shownSection) return;
    const first = shownSection === undefined;
    shownSection = name;
    sectionEl.hidden = !name;
    const incoming = sectionLayers[activeLayer ^ 1];
    const outgoing = sectionLayers[activeLayer];
    clearTimeout(fadeTimer);
    if (first || !name) {
      outgoing.textContent = name ?? '';
      outgoing.removeAttribute('data-state');
      incoming.textContent = '';
      incoming.removeAttribute('data-state');
      return;
    }
    incoming.textContent = name;
    incoming.dataset.state = 'in';
    incoming.removeAttribute('aria-hidden');
    outgoing.dataset.state = 'out';
    outgoing.setAttribute('aria-hidden', 'true');
    activeLayer ^= 1;
    fadeTimer = setTimeout(() => {
      fadeTimer = null;
      outgoing.textContent = '';
      outgoing.removeAttribute('data-state');
      incoming.removeAttribute('data-state');
    }, SECTION_FADE_MS);
  }

  let lastAnnouncedSection = null;
  function announceSection(name, playing) {
    if (!playing || !name || name === lastAnnouncedSection) { if (!playing) lastAnnouncedSection = name; return; }
    lastAnnouncedSection = name;
    let on = false;
    try { on = !!prefs?.get?.('practice.announceSections'); } catch { on = false; }
    if (on) announce(name, {key: 'stage-section'});
  }

  const textCache = {bar: null, beat: null, sub: null, mappedPos: null, name: null};
  function paintText(frame) {
    const t = frame.position;
    const s = snap();
    const name = sectionText(position, t);
    paintSection(name);
    announceSection(name, isPlaying(s.phase));

    const nx = nextText(position, t);
    next.el.hidden = !nx;
    if (nx) next.set({value: nx.text, tone: nx.imminent ? 'now' : 'ink'});

    const pos = positionText(position, t);
    if (pos.bar !== textCache.bar) { posBar.textContent = pos.bar; textCache.bar = pos.bar; }
    if (pos.beat !== textCache.beat) { posBeat.textContent = pos.beat ?? ''; textCache.beat = pos.beat; }
    const mappedPos = pos.beat != null;
    if (mappedPos !== textCache.mappedPos) {
      posSep.hidden = !mappedPos;
      posBeat.hidden = !mappedPos;
      posEl.dataset.mapped = String(mappedPos);
      textCache.mappedPos = mappedPos;
    }
    if (pos.sub !== textCache.sub) {
      posSub.textContent = pos.sub ?? '';
      posSub.hidden = !pos.sub;
      textCache.sub = pos.sub;
    }
    const posName = `${COPY.position} ${pos.main}${pos.sub ? `, ${pos.sub}` : ''}`;
    if (posName !== textCache.name) { posEl.setAttribute('aria-label', posName); textCache.name = posName; }

    const sp = speedText(s, {map, t});
    speed.set({value: sp.value, tone: sp.tone, sub: sp.sub ?? ''});
  }

  /** The beats of the count running at audio time `now`: the engine's count-in, or a loop gap's count. */
  function countBeats(at) {
    const engine = session.engine;
    if (!engine) return null;
    if (engine.countingIn && Array.isArray(engine.countIn?.beats)) return engine.countIn.beats;
    const t = Number.isFinite(at) ? at : engine.ctx?.currentTime ?? 0;
    for (const g of engine.gapsBetween?.(t, t + 1e-3) ?? []) {
      if (g.when > t + 1e-9 || t >= g.end - 1e-9) continue;
      return session.metronome?.countInPlanAt?.(g.target)?.beats ?? null;
    }
    return null;
  }

  let lampKey = '';
  let lastBeatKey = '';
  let lastCount = null;
  function paintLamps(frame) {
    const bar = frame.bar;
    const mapped = !!map.isReal && !!bar;
    if (lamps.el.hidden !== !mapped) lamps.el.hidden = !mapped;
    if (!mapped) return;
    const key = `${bar.units}:${bar.groups.join('+')}`;
    if (key !== lampKey) { lamps.set({units: bar.units, groups: bar.groups}); lampKey = key; lastBeatKey = ''; }
    const countdown = snap().countdown;
    if (countdown) {
      const countKey = `${countdown.of}:${countdown.current}`;
      lamps.frame(countUnit(countdown, bar, countBeats(frame.now)), countKey !== lastCount);
      lastCount = countKey;
      lastBeatKey = '';
      return;
    }
    lastCount = null;
    const beatKey = `${bar.index}:${bar.before ? 'b' : ''}${bar.groupIndex}`;
    lamps.frame(bar.unitIndex, beatKey !== lastBeatKey);
    lastBeatKey = beatKey;
  }

  function paintLoop(s) {
    const lt = loopText(s, {map});
    loopEl.hidden = !lt;
    if (!lt) return;
    if (loopLine1.textContent !== lt.line1) loopLine1.textContent = lt.line1;
    if (loopLine2.textContent !== lt.line2) loopLine2.textContent = lt.line2;
    loopTrainer.hidden = !lt.trainer;
    if (loopTrainer.textContent !== (lt.trainer ?? '')) loopTrainer.textContent = lt.trainer ?? '';
    loopEl.dataset.trainer = String(!!lt.trainer);
    const enabled = registry.state('loop.card')?.enabled;
    if (enabled) loopEl.removeAttribute('aria-disabled'); else loopEl.setAttribute('aria-disabled', 'true');
  }

  let mixKind = null;
  function paintMix(s) {
    const m = mixText(s);
    mixEl.hidden = !m;
    if (!m) return;
    if (mixWordEl.textContent !== m.text) mixWordEl.textContent = m.text;
    mixEl.dataset.kind = m.kind;
    if (m.kind !== mixKind) {
      mixIcon.replaceChildren(icon(m.kind === 'solo' ? 'headphones' : m.kind === 'out' ? 'minus-me' : 'sliders-horizontal', {size: 20}));
      mixKind = m.kind;
    }
  }

  let lastPlateKey = null;
  let lastTrainerStep = null;
  function paintPlate(s) {
    const p = plateText(s.countdown);
    plate.hidden = !p;
    if (!p) { lastPlateKey = null; return; }
    if (plateNumber.textContent !== p.number) plateNumber.textContent = p.number;
    if (plateLabel.textContent !== p.label) plateLabel.textContent = p.label;
    const key = `${s.countdown.of}:${p.label}`;
    if (lastPlateKey === null) announce(COPY.countAnnounce(p.label), {key: 'stage-count-in'});
    lastPlateKey = key;
  }

  function announceTrainer(s) {
    const tr = s.trainer;
    const stepKey = tr && !tr.done ? `${tr.stepIndex}` : null;
    if (stepKey !== null && lastTrainerStep !== null && stepKey !== lastTrainerStep) {
      announce(COPY.trainer(pct(tr.start), pct(tr.end), tr.stepIndex + 1, tr.steps), {key: 'stage-trainer'});
    }
    lastTrainerStep = stepKey;
  }

  function paintPhase(s) {
    const playing = isPlaying(s.phase);
    root.toggleAttribute('data-playing', playing);
    root.dataset.phase = s.phase;
  }

  function paintAll() {
    if (destroyed) return;
    const s = snap();
    const frame = readFrame(session);
    paintPhase(s);
    paintText(frame);
    paintLamps(frame);
    paintLoop(s);
    paintMix(s);
    paintPlate(s);
    announceTrainer(s);
  }

  // ---- identity painting --------------------------------------------------------------------------------------
  function paintIdentity(song) {
    const t = song?.title || COPY.untitled;
    if (title.textContent !== t) title.textContent = t;
    const a = song?.artist ?? '';
    artist.textContent = a;
    artist.hidden = !a;
    cover.set(song, song);
    if (session.id != null) nameCover(cover.el, session.id);
    const key = song?.musicalKey ?? '';
    keyChip.set({label: key});
    keyChip.el.hidden = !key;
    const tuning = song?.tuning ?? '';
    tuningChip.set({label: tuning});
    tuningChip.el.hidden = !tuning;
    const shared = !!session.readOnly;
    root.toggleAttribute('data-read-only', shared);
    sharedLine.hidden = !shared;
    actionSlot.hidden = !shared;
    if (shared) sharedLine.textContent = song?.ownerName ? COPY.sharedBy(song.ownerName) : COPY.sharedByUnknown;
  }

  let readySongs = [];
  function paintReady(list) {
    readySongs = (Array.isArray(list) ? list : []).filter((song) => song && song.id !== session.id);
    readyChip.el.hidden = !readySongs.length;
    if (readySongs.length) readyChip.set({label: COPY.ready(readySongs.length)});
  }
  let readyMenu = null;
  readyChip.set({onClick: () => {
    readyMenu?.close?.();
    readyMenu = Menu.open(readySongs.map((song) => ({
      id: `ready-${song.id}`, label: COPY.openReady(song.title || COPY.untitled), icon: 'play',
      run: () => go(`/s/${encodeURIComponent(song.id)}`),
    })), {anchor: readyChip.el, label: COPY.readyMenu, registry, placement: 'bottom'});
  }});
  destroyers.push(() => readyMenu?.destroy?.());

  function paintSetlist(value) {
    const v = value && typeof value === 'object' ? value : null;
    setLine.hidden = !v;
    root.toggleAttribute('data-setlist', !!v);
    if (!v) return;
    const index = Number.isFinite(v.index) ? v.index + 1 : 1;
    const count = Number.isFinite(v.count) ? v.count : index;
    const parts = [COPY.setLine(v.name ?? '', index, count)];
    if (v.next?.title) parts.push(COPY.setNext(v.next.title));
    setText.textContent = parts.join(COPY.separator);
  }

  // ---- effects ------------------------------------------------------------------------------------------------
  offs.push(effect(() => { const song = track(session.song); untracked(() => paintIdentity(song)); }));
  offs.push(effect(() => {
    track(transport.snapshot);
    track(position.revision);
    track(position.mapped);
    track(session.practice?.value);
    untracked(paintAll);
  }));
  if (wakeSig) offs.push(effect(() => { const on = !!track(wakeSig); untracked(() => { wakeIcon.hidden = !on; }); }));
  if (pedalSig) offs.push(effect(() => { const on = !!track(pedalSig); untracked(() => { pedalIcon.hidden = !on; }); }));
  if (setlistSig) offs.push(effect(() => { const v = track(setlistSig); untracked(() => paintSetlist(v)); }));
  else paintSetlist(null);
  offs.push(effect(() => {
    let list = [];
    try { list = track(getJobs()?.ready) ?? []; } catch { list = []; }
    untracked(() => paintReady(list));
  }));
  // The loop line's command availability follows registry changes (the stage context arriving).
  offs.push(registry.onChange?.((change) => {
    if (!change?.ids || change.ids.includes('loop.card')) paintLoop(snap());
  }) ?? null);

  // The frame bus: text at ≤ 30 Hz, lamps at 60 Hz. The bus idles while stopped; the effects above cover that.
  const bus = session.frame;
  if (bus?.subscribe) {
    offs.push(bus.subscribe((f) => { if (!destroyed) paintText(f); }, {hz: 30}));
    offs.push(bus.subscribe((f) => { if (!destroyed) paintLamps(f); }, {hz: 60}));
  }

  // ---- speed drag (±1% per 12 px, pointer capture, one undo step) -------------------------------------------
  // The drag is one gesture-bounded undo step (§2.14.10, ticket I2a-3): pointerdown opens
  // undo.beginGesture('speed') (I2a-1), every step passes it to transport.setSpeed(rate, {gesture})
  // (I2a-2), and pointerup / pointercancel / lost capture end it. So a pause past the 1 s coalescing
  // window mid-drag is still one step, and a +/− tap just before the drag stays its own step. The
  // session's undo always has beginGesture (§2.14.6); there is no coalescing-only fallback.
  let drag = null;
  const closeDrag = () => {
    if (!drag) return;
    try { drag.gesture.end(); } finally {
      drag = null;
      root.removeAttribute('data-speed-drag');
    }
  };
  speed.el.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    closeDrag();
    const gesture = session.undo.beginGesture('speed');
    drag = {id: e.pointerId, y: e.clientY, rate: snap().rate, steps: 0, moved: false, gesture};
    speed.el.setPointerCapture?.(e.pointerId);
  }, listen);
  speed.el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = drag.y - e.clientY;
    if (Math.abs(dy) > TAP_SLOP / 2) drag.moved = true;
    const steps = Math.trunc(dy / SPEED_DRAG_PX);
    if (steps === drag.steps) return;
    drag.steps = steps;
    root.setAttribute('data-speed-drag', '');
    transport.setSpeed(Math.round(drag.rate * 100 + steps) / 100, {coalesce: true, gesture: drag.gesture});
  }, listen);
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved && e.type === 'pointerup') suppressTap = true;   // the readouts' pointerup that follows clears it
    closeDrag();
    speed.el.releasePointerCapture?.(e.pointerId);
  };
  speed.el.addEventListener('pointerup', endDrag, listen);
  speed.el.addEventListener('pointercancel', endDrag, listen);
  speed.el.addEventListener('lostpointercapture', (e) => { if (drag && e.pointerId === drag.id) closeDrag(); }, listen);
  destroyers.push(closeDrag);

  // ---- double-tap the readouts → Focus (view.focus) -----------------------------------------------------------
  let suppressTap = false;
  let lastTap = null;
  let downAt = null;
  readouts.addEventListener('pointerdown', (e) => {
    suppressTap = false;   // never carried past the gesture that set it
    downAt = e.isPrimary ? {x: e.clientX, y: e.clientY} : null;
  }, listen);
  readouts.addEventListener('pointerup', (e) => {
    if (!e.isPrimary || !downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > TAP_SLOP;
    downAt = null;
    if (suppressTap || moved || e.target?.closest?.('button, a, [role=button]')) { suppressTap = false; lastTap = null; return; }
    const at = now();
    if (lastTap && at - lastTap.at <= DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) <= TAP_SLOP * 3) {
      lastTap = null;
      runCommand('view.focus', {event: e});
      return;
    }
    lastTap = {at, x: e.clientX, y: e.clientY};
  }, listen);

  // ---- layout and Focus ---------------------------------------------------------------------------------------
  // The mini rail (rail + Focus) uses the small lamps; everything else the HUD size.
  const syncLampSize = () => lamps.set({size: root.dataset.layout === 'rail' && root.hasAttribute('data-focus') ? 'sm' : 'md'});
  function setLayout(layout) {
    root.dataset.layout = layout === 'rail' ? 'rail' : 'band';
    syncLampSize();
  }
  function setFocus(on) {
    root.toggleAttribute('data-focus', !!on);
    syncLampSize();
  }

  paintAll();

  return {
    el: root,
    actionSlot,
    get cover() { return cover.el; },
    setLayout,
    setFocus,
    /** Repaints every readout from the session now (after a layout switch, or for tests). */
    refresh: paintAll,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(fadeTimer);
      ac.abort();
      for (const off of offs.splice(0)) { try { off?.(); } catch (err) { console.warn('[hud] cleanup failed', err); } }
      for (const fn of destroyers.splice(0)) { try { fn(); } catch (err) { console.warn('[hud] cleanup failed', err); } }
      plate.remove();
      root.remove();
    },
  };
}

export default mountHud;
