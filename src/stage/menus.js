// The Stage's menus (architecture §2.14.11, spec §4.5, §4.9, §7.7): MenuItem[] builders for the
// Menu primitive (src/ui/menu.js). Every builder is pure apart from reading the session; the
// items it returns act when chosen.
//
//   stageMenu(session, stage, opts?)          the identity-row ⋯ menu (stage.menu): View ▸ · Display ▸ (a part exists)
//                                             · Follow ▸ (Chart, mapped Road map) · Focus · Distance ▸ · ── · Spots… · Notes · Tap the beat…
//                                             · Get bars… (unmapped) / Detect beats (mapped) · Suggest sections (mapped, no
//                                             sections) · ── · Share… · Edit map · Edit drum chart · Edit details · Re-split…
//                                             · ── · Keyboard shortcuts
//   barMenu(session, {t, bar}, opts?)         the music surfaces' long-press / right-click menu (spec §4.9)
//   sectionMenu(session, region, opts?)       the strip's (and the sections lane's) menu; opts {t, rename}
//   spotMenu(session, spot, opts?)            Open · Rename… · Update from current · Delete; opts {rename, onOpen}
//   markerMenu(session, marker, opts?)        Rename… · Delete · Turn into section (mapped); opts {rename}
//   loopBandMenu(session, opts?)              Save as spot · Count in every pass ✓ · ◀ Move · Move ▶ · Zoom to loop · Clear;
//                                             opts {zoomToLoop} (else the Stems surface's stems.zoomLoop while it is registered)
//   stemMenu(session, stem, opts?)            Mute · Solo · Reset level · This is my instrument
//   saveSpot(session, {a, b, name, rate?}, opts?) → id|null      one practice-undo step (the Loop card shares it)
//   boundUndo(session, entry?, opts?) → {isLatest(), run()}       an Undo (toast, status line) that only undoes its own step
//   askSpotName / spotRangeAt / secondsLoopAt / turnReason / instrumentForStem / COPY / CONTROLS
//
// Items that have a registry command are command-bound (`command`, plus `args` for radios): the
// Menu takes the label, key-cap, enabled state, checked state and disabledReason from the
// registry. A radio whose state depends on its arguments (Display, Follow, Between passes) gets a
// `checked` getter evaluated with those arguments. Items that act at a time other than the
// playhead (the bar and section menus) run their own action through the transport.
//
// `opts` (all optional): registry (default: the app's), feedback (default: the registry
// context's, else the app's), account (for "This is my instrument"; default: the app's).
// Labels for unmapped songs never say "bar" (architecture §2.14.4).

import {registry as appRegistry} from '../app/commands.js';
import {feedback as appFeedback} from '../app/feedback.js';
import {account as appAccount} from '../app/account.js';
import {INSTRUMENTS} from '../app/profile.js';
import {sectionsFromMarkers} from '../../shared/song-map.ts';
import {MAX_NAME, MAX_SPOTS} from '../../shared/practice.ts';
import {COPY as STAGE_COPY} from './stage.copy.js';
import {COPY as TRANSPORT_COPY, stemLabel} from './transport-commands.js';

const EPS = 1e-6;
/** A spot "is" the loop when both edges agree within 1 ms (§2.14.1 spot counters). */
const SAME_EDGE = 1e-3;
/** Unmapped "Loop … from here" length in seconds. */
export const UNMAPPED_LOOP_SEC = 10;
/** The Undo toast after deleting a spot (spec §7.8). */
export const UNDO_TOAST_MS = 8000;
/** Instruments for the stems Woodshed splits (D37, inverted): piano → keys. */
const STEM_INSTRUMENT = Object.freeze({drums: 'drums', bass: 'bass', guitar: 'guitar', piano: 'keys', vocals: 'vocals', other: 'other'});
const INSTRUMENT_LABELS = Object.freeze({drums: 'Drums', bass: 'Bass', guitar: 'Guitar', keys: 'Keys', vocals: 'Vocals', other: 'Other'});

const pct = (rate) => `${Math.round((Number.isFinite(rate) ? rate : 1) * 100)}%`;
const finite = (v) => Number.isFinite(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const peek = (v) => (v && typeof v === 'object' && typeof v.peek === 'function' ? v.peek() : v ?? null);

/** Menu labels and reasons (spec §4.5, §4.9, §7.7; architecture §2.14.11). */
export const COPY = Object.freeze({
  // ⋯ menu
  view: 'View',
  display: 'Display',
  together: 'Together',
  handsFeet: 'Hands & feet',
  follow: 'Follow',
  scroll: 'Scroll',
  page: 'Page',
  distance: 'Distance',
  spots: 'Spots…',
  shortcuts: 'Keyboard shortcuts',
  // bar menu
  playFromHere: 'Play from here',
  cueHere: 'Cue here',
  loopBar: 'Loop this bar',
  loopSection: 'Loop this section',
  loopPart: 'Loop this part',
  loopFour: 'Loop 4 bars from here',
  loopSeconds: `Loop ${UNMAPPED_LOOP_SEC} s from here`,
  saveSpotHere: 'Save spot here…',
  addMarker: 'Add marker here',
  addSection: 'Add section here',
  // section menu
  extendLoop: 'Extend loop to here',
  saveAsSpot: 'Save as spot…',
  rename: 'Rename…',
  editSections: 'Edit sections in Map',
  editMap: 'Edit map',
  // spot, marker, loop band and stem menus
  open: 'Open',
  update: 'Update from current',
  delete: 'Delete',
  turnInto: 'Turn into section',
  saveSpot: 'Save as spot',
  moveBack: (len) => `◀ Move ${len}`,
  moveFwd: (len) => `Move ${len} ▶`,
  zoomToLoop: 'Zoom to loop',
  clear: 'Clear',
  mute: 'Mute',
  solo: 'Solo',
  resetLevel: 'Reset level',
  mine: 'This is my instrument',
  // dialogs and results
  saveSpotTitle: 'Save spot',
  renameSpotTitle: 'Rename spot',
  renameSectionTitle: STAGE_COPY.renameSection,
  renameMarkerTitle: STAGE_COPY.renameMarker,
  nameLabel: STAGE_COPY.nameLabel,
  save: STAGE_COPY.save,
  undo: STAGE_COPY.undo,
  spotSaved: STAGE_COPY.spotSaved,
  spotsFull: STAGE_COPY.spotsFull,
  spotUpdated: (name, rate) => `Updated spot ${name} · ${pct(rate)}`,
  spotDeleted: (name) => `Deleted spot ${name}`,
  markerAdded: STAGE_COPY.markerAdded,
  sectionAdded: STAGE_COPY.sectionAdded,
  markerDeleted: (label) => `Deleted ${label}`,
  turnedInto: (label) => `${label} is now a section`,
  nowMine: (instrument) => `${instrument} is now your instrument`,
  mineFailed: 'Couldn’t save your instrument. Try again in a moment.',
  undoStale: 'Something else changed since then. Use Undo (⌘Z) to step back.',
  // reasons (visible, spec §7.7)
  readOnly: STAGE_COPY.readOnly,
  notBuilt: STAGE_COPY.notBuilt,
  noSections: TRANSPORT_COPY.noSections,
  noRegions: TRANSPORT_COPY.noRegions,
  alreadyStarts: STAGE_COPY.alreadyStarts,
  insideLoop: 'This is already inside the loop.',
  noLoop: 'Set a loop first.',
  levelFull: 'Already at 100%.',
  noInstrument: 'This stem isn’t one instrument.',
  alreadyMine: 'Already your instrument.',
  signInForMine: 'Sign in to set your instrument.',
  noPartBefore: 'There is no part before the first marker.',
});

// ---------------------------------------------------------------------------------------------------------------
// Readers

const registryOf = (opts) => opts?.registry ?? appRegistry;

function feedbackOf(opts) {
  if (opts?.feedback) return opts.feedback;
  let fb = null;
  try { fb = registryOf(opts).context().feedback ?? null; } catch { fb = null; }
  return fb ?? appFeedback;
}

const snapOf = (session) => peek(session?.transport?.snapshot) ?? {};
const loopOf = (session) => snapOf(session).loop ?? null;
const hasRange = (loop) => !!loop && finite(loop.a) && finite(loop.b) && loop.b - loop.a > EPS;
const playingOf = (session) => ['playing', 'counting'].includes(snapOf(session).phase);
/** The song has a real map (bars, beats and sections mean something). */
export const isMapped = (session) => !!session?.map?.isReal;
const writable = (session) => !!session && !session.readOnly;
const readOnlyReason = (session) => (session?.readOnly ? COPY.readOnly : null);

/** The playhead (playing) or the cue (stopped). */
function hereOf(session) {
  const t = session?.transport?.position?.();
  return finite(t) ? t : (snapOf(session).cue ?? 0);
}

/** A loop's length for "Move …": "8 bars" when its edges sit on bar lines, else "9.8 s". */
export function loopLength(session, loop = loopOf(session)) {
  if (!hasRange(loop)) return '';
  const seconds = `${(Math.round((loop.b - loop.a) * 10) / 10).toFixed(1)} s`;
  const map = session?.map;
  if (!isMapped(session) || !Array.isArray(map?.bars)) return seconds;
  const bars = map.bars;
  const first = bars.findIndex((bar) => Math.abs(bar.t0 - loop.a) <= 0.01);
  if (first < 0) return seconds;
  for (let j = first; j < bars.length; j++) {
    if (Math.abs(bars[j].t1 - loop.b) <= 0.01) {
      const n = j - first + 1;
      return `${n} bar${n === 1 ? '' : 's'}`;
    }
    if (bars[j].t1 > loop.b + 0.01) break;
  }
  return seconds;
}

/** The time a bar menu acts on: the nearest beat on a mapped song, the pressed time otherwise. */
function beatAt(session, t) {
  if (!isMapped(session)) return t;
  const snapped = session.position?.snap?.(t, 'beat');
  return finite(snapped) ? snapped : t;
}

/** The range "Save spot here…" saves: the loop when it holds t, else the section or marker region at t, else the default loop. */
export function spotRangeAt(session, t) {
  const loop = loopOf(session);
  if (loop?.on && hasRange(loop) && t >= loop.a - EPS && t <= loop.b + EPS) return {a: loop.a, b: loop.b, name: loop.label || null};
  const position = session.position;
  const region = isMapped(session) && !session.map.hasSections ? null : position.regionAt(t);
  if (region && region.t1 - region.t0 > EPS) return {a: region.t0, b: region.t1, name: region.label};
  const d = position.loopDefault(t);
  return {a: d.a, b: d.b, name: d.label};
}

/** The instrument a stem stands for ("This is my instrument"), or null (no_* and two-part stems). */
export function instrumentForStem(name) {
  return STEM_INSTRUMENT[String(name ?? '').toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Actions shared by the menus and the Loop card

/** Ask for a name in a small form (pre-filled); resolves the trimmed name or null. */
export async function askName(feedback, {title, value}) {
  if (typeof feedback?.form !== 'function') return null;
  const result = await feedback.form({title, submitLabel: COPY.save,
    fields: [{name: 'name', label: COPY.nameLabel, kind: 'text', required: true, maxLength: MAX_NAME, value: value ?? ''}]});
  const name = typeof result?.name === 'string' ? result.name.trim() : '';
  return name || null;
}

/** "Save spot…": ask for the name, then save the range as a spot. Resolves the spot id or null. */
export async function askSpotName(session, range, opts = {}) {
  const feedback = feedbackOf(opts);
  if (liveSpots(session).length >= MAX_SPOTS) { feedback.status?.(COPY.spotsFull, {key: 'spot'}); return null; }
  const name = await askName(feedback, {title: COPY.saveSpotTitle, value: range.name ?? ''});
  if (!name || session.disposed) return null;
  return saveSpot(session, {...range, name}, {...opts, feedback});
}

const liveSpots = (session) => (session?.practice?.value?.peek?.()?.spots ?? []).filter((s) => !s.deleted);

/**
 * Save [a, b) as a spot named `name` at `rate` (default: the current speed), as one practice-undo
 * step. It becomes the active spot when it is the loop (its passes then count). Returns the id or null.
 */
export function saveSpot(session, {a, b, name, rate} = {}, opts = {}) {
  const feedback = feedbackOf(opts);
  if (!session || session.disposed || !finite(a) || !finite(b) || b - a <= EPS) return null;
  const practice = session.practice;
  if (liveSpots(session).length >= MAX_SPOTS) { feedback.status?.(COPY.spotsFull, {key: 'spot'}); return null; }
  const label = String(name ?? '').trim().slice(0, MAX_NAME) || 'Spot';
  const speed = finite(rate) ? rate : (snapOf(session).rate ?? 1);
  const refs = {};
  const aBar = session.position?.ref?.(a), bBar = session.position?.ref?.(b);
  if (aBar) refs.aBar = aBar;
  if (bBar) refs.bBar = bBar;
  const before = clone(practice.value.peek().spots);
  const id = practice.addSpot({name: label, a, b, rate: speed, passes: 0, ...refs});
  if (!id) return null;
  const after = clone(practice.value.peek().spots);
  session.undo.push({key: 'spots', label: 'spot', describe: () => `save spot ${label}`, from: before, to: after,
    apply: (v) => practice.patch({spots: clone(v)})});
  const loop = loopOf(session);
  if (loop?.on && Math.abs(loop.a - a) <= SAME_EDGE && Math.abs(loop.b - b) <= SAME_EDGE) practice.activeSpotId.value = id;
  feedback.status?.(COPY.spotSaved(label, speed), {key: 'spot'});
  return id;
}

/** A marker at `t` (unmapped or shared), or a section starting at the bar under `t` (mapped, owner): one undo step. */
export function addMarkerAt(session, t, opts = {}) {
  const feedback = feedbackOf(opts);
  if (!session || session.disposed || !finite(t)) return null;
  const map = session.map;
  if (isMapped(session) && writable(session)) {
    const index = map.barIndexAt(t);
    const bar = map.bars[index];
    if (!bar) return null;
    const existing = map.sections.find((s) => s.startBar === index);
    if (existing) { feedback.status?.(COPY.alreadyStarts(bar.display, existing.name), {key: 'marker'}); return null; }
    const label = `Section ${map.sections.length + 1}`;
    const result = session.mapChange(`add ${label}`, (m) => m.edit((d) => { if (d.measures[index]) d.measures[index].label = label; }, 'label'));
    if (!result) return null;
    feedback.status?.(COPY.sectionAdded(label), {key: 'marker'});
    return {kind: 'section', index, label};
  }
  const practice = session.practice;
  const before = clone(practice.value.peek().markers);
  const id = practice.addMarker({t});
  if (!id) return null;
  const after = clone(practice.value.peek().markers);
  const marker = after.find((m) => m.id === id);
  session.undo.push({key: 'markers', label: 'marker', describe: () => `add ${marker?.label ?? 'marker'}`, from: before, to: after,
    apply: (v) => practice.patch({markers: clone(v)})});
  feedback.status?.(COPY.markerAdded(marker?.label ?? ''), {key: 'marker'});
  return {kind: 'marker', id, label: marker?.label};
}

/** Practice fields that change without an undo step (play stamps, the scroll anchor, the surface, pass counts). */
const VOLATILE_KEYS = ['lastAt', 'anchorBar', 'anchorTime', 'surface'];

/** What the undo stack and the state it guards look like now: equal prints mean no newer step was pushed or undone. */
function undoPrint(session) {
  const p = {...(session?.practice?.value?.peek?.() ?? {})};
  for (const key of VOLATILE_KEYS) delete p[key];
  if (Array.isArray(p.spots)) p.spots = p.spots.map(({passes, lastAt, ...rest}) => rest);
  return `${session?.undo?.size ?? 0}|${session?.map?.revision ?? ''}|${JSON.stringify(p)}`;
}

/**
 * An Undo bound to the step just pushed (`entry`, or the stack's top right now): it undoes only while that
 * step is still the latest one (a toast must never undo a newer change, spec §7.8). With the session's
 * `undo.top` hook the check is exact; without it, the step counts as the latest while neither the stack
 * nor the practice state or map it covers has changed since (every undoable change patches one of them).
 */
export function boundUndo(session, entry = null, opts = {}) {
  const stack = session?.undo;
  const exact = !!stack && 'top' in stack;
  const target = entry ?? (exact ? stack.top : null);
  const print = undoPrint(session);
  const isLatest = () => {
    if (!session || session.disposed) return false;
    if (exact && target) return stack.top === target;
    return undoPrint(session) === print;
  };
  return {
    isLatest,
    run({source = 'pointer'} = {}) {
      if (!isLatest()) { feedbackOf(opts).status?.(COPY.undoStale, {key: 'undo'}); return false; }
      return registryOf(opts).run('practice.undo', {source});
    },
  };
}

/** Undo feedback after a destructive menu action: a toast when stopped, the status line while playing (spec §4.14, §7.8). */
function offerUndo(session, text, opts, {durationMs, entry} = {}) {
  const feedback = feedbackOf(opts);
  const step = boundUndo(session, entry, opts);
  const action = {label: COPY.undo, run: () => step.run()};
  if (playingOf(session)) feedback.status?.(text, {action, key: 'undo', ...(durationMs ? {durationMs} : {})});
  else feedback.toast?.(text, {action, key: 'undo', ...(durationMs ? {durationMs} : {})});
}

async function renameSection(session, region, opts) {
  const name = await askName(feedbackOf(opts), {title: COPY.renameSectionTitle, value: region.label});
  if (!name || name === region.label || session.disposed) return;
  const index = region.startBar;
  session.mapChange(`rename ${region.label} → ${name}`,
    (m) => m.edit((d) => { if (d.measures[index]) d.measures[index].label = name; }, 'label'));
}

async function renameMarker(session, marker, opts) {
  const practice = session.practice;
  const live = practice.value.peek().markers.find((m) => m.id === marker.id && !m.deleted);
  if (!live) return;
  const name = await askName(feedbackOf(opts), {title: COPY.renameMarkerTitle, value: live.label});
  if (!name || name === live.label || session.disposed) return;
  const from = live.label;
  practice.renameMarker(marker.id, name);
  session.undo.push({key: 'markers', label: 'marker', describe: () => `marker ${from} → ${name}`, from, to: name,
    apply: (value) => practice.renameMarker(marker.id, value)});
}

function deleteMarker(session, marker, opts) {
  const practice = session.practice;
  const before = clone(practice.value.peek().markers);
  const live = before.find((m) => m.id === marker.id && !m.deleted);
  if (!live) return false;
  practice.deleteMarker(marker.id);
  const after = clone(practice.value.peek().markers);
  const entry = session.undo.push({key: 'markers', label: 'marker', describe: () => `delete ${live.label}`, from: before, to: after,
    apply: (v) => practice.patch({markers: clone(v)})});
  offerUndo(session, COPY.markerDeleted(live.label), opts, {entry});
  return true;
}

/** The index of the listed bar whose start is nearest `t` (the bar a marker turns into a section at). */
function nearestBarIndex(map, t) {
  const bars = map?.bars ?? [];
  if (!bars.length || !finite(t)) return -1;
  let best = 0;
  for (let i = 1; i < bars.length; i++) if (Math.abs(bars[i].t0 - t) < Math.abs(bars[best].t0 - t)) best = i;
  return best;
}

/** Why a marker cannot become a section: the bar nearest it already starts a named section (else null). */
export function turnReason(session, marker) {
  if (!isMapped(session)) return null;
  if (session.readOnly) return COPY.readOnly;
  const map = session.map;
  const index = nearestBarIndex(map, marker?.t);
  const existing = index < 0 ? null : (map.sections ?? []).find((s) => s.startBar === index && String(s.label ?? '').trim() !== '');
  return existing ? COPY.alreadyStarts(map.bars[index]?.display ?? null, existing.name) : null;
}

/** A marker becomes a section at its nearest bar line; the map change and the marker's removal are one undo step (D23). */
export function turnMarkerIntoSection(session, marker, opts = {}) {
  if (!isMapped(session) || !writable(session)) return false;
  const practice = session.practice;
  const live = practice.value.peek().markers.find((m) => m.id === marker.id && !m.deleted);
  if (!live) return false;
  const reason = turnReason(session, live);
  if (reason) { feedbackOf(opts).status?.(reason, {key: 'marker'}); return false; }
  const map = session.map;
  const {change, converted} = sectionsFromMarkers(map.data, [live], map.duration);
  if (!converted.length) return false;
  const markersBefore = clone(practice.value.peek().markers);
  const result = session.mapChange(`turn ${live.label} into a section`, (m) => m.edit(change, 'sections'));
  if (!result) return false;
  practice.patch((p) => { p.markers = p.markers.filter((m) => m.id !== live.id); });
  const markersAfter = clone(practice.value.peek().markers);
  const restore = () => practice.patch({markers: clone(markersBefore)});
  const redo = () => practice.patch({markers: clone(markersAfter)});
  if (result.entry) session.undo.amend(result.entry, {undo: restore, redo});
  else session.undo.pushAction({key: 'markers', label: 'marker', describe: () => `turn ${live.label} into a section`, undo: restore, redo});
  feedbackOf(opts).status?.(COPY.turnedInto(live.label), {key: 'marker'});
  return true;
}

async function renameSpot(session, spot, opts) {
  const practice = session.practice;
  const live = practice.value.peek().spots.find((s) => s.id === spot.id && !s.deleted);
  if (!live) return;
  const name = await askName(feedbackOf(opts), {title: COPY.renameSpotTitle, value: live.name});
  if (!name || name === live.name || session.disposed) return;
  const before = clone(practice.value.peek().spots);
  practice.updateSpot(spot.id, {name});
  const after = clone(practice.value.peek().spots);
  session.undo.push({key: 'spots', label: 'spot', describe: () => `rename spot ${live.name} → ${name}`, from: before, to: after,
    apply: (v) => practice.patch({spots: clone(v)})});
}

/** "Update from current": the spot takes the current speed, and the loop's range when a loop is on. */
export function updateSpotFromCurrent(session, spot, opts = {}) {
  const practice = session.practice;
  const live = practice.value.peek().spots.find((s) => s.id === spot.id && !s.deleted);
  if (!live) return false;
  const snap = snapOf(session), loop = snap.loop;
  const fields = {rate: snap.rate ?? 1};
  if (loop?.on && hasRange(loop)) {
    fields.a = loop.a;
    fields.b = loop.b;
    fields.aBar = session.position?.ref?.(loop.a) ?? null;
    fields.bBar = session.position?.ref?.(loop.b) ?? null;
  }
  const before = clone(practice.value.peek().spots);
  practice.updateSpot(spot.id, fields);
  const after = clone(practice.value.peek().spots);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  session.undo.push({key: 'spots', label: 'spot', describe: () => `update spot ${live.name}`, from: before, to: after,
    apply: (v) => practice.patch({spots: clone(v)})});
  if (loop?.on && hasRange(loop)) practice.activeSpotId.value = spot.id;
  feedbackOf(opts).status?.(COPY.spotUpdated(live.name, fields.rate), {key: 'spot'});
  return true;
}

function deleteSpot(session, spot, opts) {
  const practice = session.practice;
  const before = clone(practice.value.peek().spots);
  const live = before.find((s) => s.id === spot.id && !s.deleted);
  if (!live) return false;
  const wasActive = peek(practice.activeSpotId) === spot.id;
  practice.deleteSpot(spot.id);
  const after = clone(practice.value.peek().spots);
  // Undo brings the spot back as it was, active again when it was (its passes keep counting, §2.14.1).
  const entry = session.undo.pushAction({key: 'spots', label: 'spot', describe: () => `delete spot ${live.name}`,
    undo: () => { practice.patch({spots: clone(before)}); if (wasActive) practice.activeSpotId.value = spot.id; },
    redo: () => practice.patch({spots: clone(after)})});
  offerUndo(session, COPY.spotDeleted(live.name), opts, {durationMs: UNDO_TOAST_MS, entry});
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// The ⋯ menu (stage.menu)

const SEPARATOR = Object.freeze({type: 'separator'});

/** The last Edit tab (E opens it, `edit.open`): 'map' | 'chart' | 'details'. */
function lastEditTab(reg) {
  let tab = null;
  try { tab = peek(reg.context().store?.prefs)?.edit?.lastTab ?? null; } catch { tab = null; }
  return ['map', 'chart', 'details'].includes(tab) ? tab : 'map';
}

/** The Display layout the chart shows: the device choice, else the part's own, else Together. */
function displayLayout(session, stage) {
  return peek(stage?.display) ?? session?.notation?.part?.score?.layout ?? 'combined';
}

/** Whether the surface kind shown follows the playhead by rows (and so takes stage.followStyle). */
function followsByRows(surface, mapped) {
  return surface === 'chart' || (surface === 'roadmap' && mapped);
}

export function stageMenu(session, stage, opts = {}) {
  const reg = registryOf(opts);
  const mapped = isMapped(session);
  const readOnly = readOnlyReason(session);
  const surface = peek(stage?.surface);
  const hasPart = !!session?.notation?.part;
  const editKey = lastEditTab(reg);
  const editItem = (tab) => ({command: `edit.${tab}`, ...(tab === editKey ? {kbd: 'KeyE'} : {})});
  const items = [
    {type: 'submenu', label: COPY.view, icon: 'layout-grid', items: [
      {command: 'view.chart', type: 'radio'},
      {command: 'view.roadmap', type: 'radio', label: mapped ? STAGE_COPY.surfaces.roadmap : STAGE_COPY.surfaces.wave},
      {command: 'view.stems', type: 'radio'},
    ]},
  ];
  if (hasPart) {
    items.push({type: 'submenu', label: COPY.display, icon: 'layers', items: [
      {command: 'view.display', type: 'radio', label: COPY.together, args: {layout: 'combined'},
        get checked() { return displayLayout(session, stage) === 'combined'; }},
      {command: 'view.display', type: 'radio', label: COPY.handsFeet, args: {layout: 'split'},
        get checked() { return displayLayout(session, stage) === 'split'; }},
    ]});
  }
  // Follow ▸ is for the surfaces that follow by rows: the Chart and the mapped Road map (spec §4.4B). The Wave page
  // (an unmapped song's Road map) and Stems scroll by time, so they have no follow style to choose.
  if (followsByRows(surface, mapped)) {
    items.push({type: 'submenu', label: COPY.follow, icon: 'arrow-down-to-line', items: [
      {command: 'view.followStyle', type: 'radio', label: COPY.scroll, args: {style: 'scroll'},
        get checked() { return peek(stage?.followStyle) === 'scroll'; }},
      {command: 'view.followStyle', type: 'radio', label: COPY.page, args: {style: 'page'},
        get checked() { return peek(stage?.followStyle) === 'page'; }},
    ]});
  }
  items.push(
    {command: 'view.focus', type: 'checkbox'},
    {type: 'submenu', label: COPY.distance, icon: 'maximize-2', items: [
      {command: 'view.distance.near', type: 'radio'},
      {command: 'view.distance.stand', type: 'radio'},
      {command: 'view.distance.kit', type: 'radio'},
    ]},
    SEPARATOR,
    {command: 'spot.list', label: COPY.spots},
    {command: 'stage.notes'},
    {command: 'stage.tapBeat', ...(readOnly ? {reason: readOnly} : {})},
    mapped ? {command: 'map.detect', ...(readOnly ? {reason: readOnly} : {})} : {command: 'stage.getBars', ...(readOnly ? {reason: readOnly} : {})},
  );
  if (mapped && !session.map.hasSections) items.push({command: 'sections.suggest', ...(readOnly ? {reason: readOnly} : {})});
  const shareReason = readOnly ?? (peek(stage?.shareAvailable) === false ? COPY.notBuilt : null);
  items.push(
    SEPARATOR,
    {command: 'stage.share', ...(shareReason ? {reason: shareReason} : {})},
    // A shared song has no Edit (spec §4.13): the three Edit rows are left out, not disabled.
    ...(readOnly ? [] : [editItem('map'), editItem('chart'), editItem('details')]),
    {command: 'song.resplit', ...(readOnly ? {reason: readOnly} : {})},
    SEPARATOR,
    {command: 'app.shortcuts', label: COPY.shortcuts},
  );
  return items;
}

// ---------------------------------------------------------------------------------------------------------------
// The bar menu (music surfaces, spec §4.9)

/** "Loop 10 s from here": 10 s from t, moved back (never shortened) when the song ends sooner. */
export function secondsLoopAt(session, t) {
  const duration = session?.map?.duration || session?.transport?.duration?.() || 0;
  const end = duration > 0 ? duration : t + UNMAPPED_LOOP_SEC;
  const a = Math.max(0, Math.min(t, end - UNMAPPED_LOOP_SEC));
  return {a, b: Math.min(a + UNMAPPED_LOOP_SEC, end)};
}

/** The region at t; before an unmapped song's first marker, the part from 0:00 up to it. */
function regionOrLeadIn(session, t) {
  const position = session.position;
  const region = position.regionAt(t);
  if (region || isMapped(session)) return region;
  const first = (position.regions?.() ?? []).sort((x, y) => x.t0 - y.t0)[0];
  if (!first || t >= first.t0 || first.t0 <= EPS) return null;
  return {kind: 'marker', label: null, t0: 0, t1: first.t0};
}

export function barMenu(session, {t} = {}, opts = {}) {
  if (!session?.transport || !finite(t)) return [];
  const transport = session.transport;
  const mapped = isMapped(session);
  const at = beatAt(session, t);
  const region = mapped && !session.map.hasSections ? null : regionOrLeadIn(session, t);
  const regionReason = region ? null : mapped ? COPY.noSections
    : (session.position.regions?.() ?? []).length ? COPY.noPartBefore : COPY.noRegions;
  const loopRegion = () => {
    if (region) transport.loopRange(region.t0, region.t1, {snap: 'none', ...(region.label ? {label: region.label} : {})});
  };
  let addReason = null;
  if (mapped && writable(session)) {
    const index = session.map.barIndexAt(t);
    const starts = session.map.sections.find((s) => s.startBar === index);
    if (starts) addReason = COPY.alreadyStarts(session.map.bars[index]?.display ?? null, starts.name);
  }
  const items = [
    {id: 'play', label: COPY.playFromHere, icon: 'play', run: () => { void transport.playFrom(at); }},
    {id: 'cue', label: COPY.cueHere, icon: 'flag', run: () => transport.cue(at)},
  ];
  if (mapped) {
    items.push(
      {id: 'loop-bar', label: COPY.loopBar, icon: 'repeat-1', run: () => transport.loopBars(t, 1)},
      {id: 'loop-region', label: COPY.loopSection, icon: 'repeat', ...(regionReason ? {reason: regionReason} : {}), run: loopRegion},
      {id: 'loop-four', label: COPY.loopFour, icon: 'repeat', run: () => transport.loopBars(t, 4)},
    );
  } else {
    items.push(
      {id: 'loop-region', label: COPY.loopPart, icon: 'repeat', ...(regionReason ? {reason: regionReason} : {}), run: loopRegion},
      {id: 'loop-seconds', label: COPY.loopSeconds, icon: 'repeat',
        run: () => { const r = secondsLoopAt(session, t); transport.loopRange(r.a, r.b, {snap: 'none'}); }},
    );
  }
  items.push(
    SEPARATOR,
    {id: 'save-spot', label: COPY.saveSpotHere, icon: 'bookmark', run: () => { void askSpotName(session, spotRangeAt(session, t), opts); }},
    {id: 'add-marker', label: mapped && writable(session) ? COPY.addSection : COPY.addMarker, icon: 'flag',
      ...(addReason ? {reason: addReason} : {}), run: () => { addMarkerAt(session, t, opts); }},
  );
  return items;
}

// ---------------------------------------------------------------------------------------------------------------
// The section menu (the strip, the sections lane; spec §4.5)

export function sectionMenu(session, region, opts = {}) {
  if (!session?.transport || !region || !finite(region.t0)) return [];
  const transport = session.transport;
  const isSection = region.kind === 'section';
  const mapped = isMapped(session);
  const t = finite(opts.t) ? opts.t : region.t0;
  const loop = loopOf(session);
  const inside = hasRange(loop) && t >= loop.a - EPS && t <= loop.b + EPS;
  const renameReason = isSection && (session.readOnly || !mapped || !Number.isInteger(region.startBar)) ? COPY.readOnly : null;
  const end = finite(region.t1) && region.t1 > region.t0 ? region.t1 : null;
  const rename = () => {
    if (typeof opts.rename === 'function' && opts.rename() !== false) return;
    if (isSection) void renameSection(session, region, opts);
    else void renameMarker(session, region, opts);
  };
  return [
    {id: 'play', label: COPY.playFromHere, icon: 'play', run: () => { void transport.playFrom(region.t0); }},
    {id: 'loop', label: isSection ? COPY.loopSection : COPY.loopPart, icon: 'repeat',
      ...(end === null ? {reason: COPY.noRegions} : {}),
      run: () => { if (end !== null) transport.loopRange(region.t0, end, {snap: 'none', label: region.label}); }},
    {id: 'extend', label: COPY.extendLoop, icon: 'arrow-right', ...(inside ? {reason: COPY.insideLoop} : {}),
      run: () => transport.extendLoopTo(t)},
    {id: 'save-spot', label: COPY.saveAsSpot, icon: 'bookmark', ...(end === null ? {reason: COPY.noRegions} : {}),
      run: () => { if (end !== null) void askSpotName(session, {a: region.t0, b: end, name: region.label}, opts); }},
    SEPARATOR,
    {id: 'rename', label: COPY.rename, icon: 'pencil', ...(renameReason ? {reason: renameReason} : {}), run: rename},
    // A shared song has no Edit (spec §4.13).
    ...(session.readOnly ? [] : [{command: 'edit.map', label: mapped ? COPY.editSections : COPY.editMap}]),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Spot, marker, loop-band and stem menus (spec §7.7)

export function spotMenu(session, spot, opts = {}) {
  if (!session?.practice || !spot?.id) return [];
  const reg = registryOf(opts);
  // spot.open takes its id as an argument (its `when` needs it), so the row runs it with the id.
  return [
    {id: 'open', label: COPY.open, icon: 'bookmark',
      run: ({source} = {}) => {
        // The spot may have gone since the menu was built (another device, the Spots list, undo): onOpen only on success.
        if (!liveSpots(session).some((s) => s.id === spot.id)) return;
        reg.run('spot.open', {source: source ?? 'pointer', args: {id: spot.id}});
        if (peek(session.practice.activeSpotId) === spot.id) opts.onOpen?.(spot);
      }},
    {id: 'rename', label: COPY.rename, icon: 'pencil',
      run: () => { if (typeof opts.rename === 'function' && opts.rename() !== false) return; void renameSpot(session, spot, opts); }},
    {id: 'update', label: COPY.update, icon: 'refresh-cw', run: () => { updateSpotFromCurrent(session, spot, opts); }},
    SEPARATOR,
    {id: 'delete', label: COPY.delete, icon: 'trash-2', danger: true, run: () => { deleteSpot(session, spot, opts); }},
  ];
}

export function markerMenu(session, marker, opts = {}) {
  if (!session?.practice || !marker?.id) return [];
  const items = [
    {id: 'rename', label: COPY.rename, icon: 'pencil',
      run: () => { if (typeof opts.rename === 'function' && opts.rename() !== false) return; void renameMarker(session, marker, opts); }},
    {id: 'delete', label: COPY.delete, icon: 'trash-2', danger: true, run: () => { deleteMarker(session, marker, opts); }},
  ];
  if (isMapped(session)) {
    const reason = turnReason(session, marker);
    items.push({id: 'turn', label: COPY.turnInto, icon: 'flag', ...(reason ? {reason} : {}),
      run: () => { turnMarkerIntoSection(session, marker, opts); }});
  }
  return items;
}

/** The Stems surface's command (§3.3); it exists only while that surface is mounted. */
const STEMS_ZOOM_LOOP = 'stems.zoomLoop';

export function loopBandMenu(session, opts = {}) {
  if (!session?.transport) return [];
  const reg = registryOf(opts);
  const length = loopLength(session);
  const items = [
    {command: 'spot.save', label: COPY.saveSpot},
    {command: 'loop.eachPass', type: 'checkbox'},
    {command: 'loop.moveBack', label: COPY.moveBack(length)},
    {command: 'loop.moveFwd', label: COPY.moveFwd(length)},
  ];
  if (typeof opts.zoomToLoop === 'function') items.push({id: 'zoom', label: COPY.zoomToLoop, icon: 'zoom-in', kbd: 'KeyZ', run: () => opts.zoomToLoop()});
  else if (reg.get(STEMS_ZOOM_LOOP)) items.push({command: STEMS_ZOOM_LOOP, label: COPY.zoomToLoop});
  items.push(SEPARATOR, {command: 'loop.clear', label: COPY.clear});
  return items;
}

export function stemMenu(session, stem, opts = {}) {
  const name = typeof stem === 'string' ? stem : stem?.name;
  const tracks = snapOf(session).mix?.tracks ?? [];
  const index = tracks.findIndex((track) => track.name === name);
  if (!session?.transport || index < 0) return [];
  const transport = session.transport;
  const track = tracks[index];
  const n = index + 1;
  const keyed = n <= 9;
  const instrument = instrumentForStem(name);
  const mine = (snapOf(session).mix?.mine ?? []).includes(name);
  // The profile lives in the account: a visitor who is not signed in (the Shared Stage) cannot set it.
  const signedIn = opts.signedIn ?? (peek((opts.account ?? appAccount)?.loaded) !== false);
  const items = [
    keyed ? {command: `mix.mute.${n}`, label: COPY.mute, type: 'checkbox'}
      : {id: 'mute', label: COPY.mute, type: 'checkbox', checked: !!track.muted, run: () => transport.setMuted(name, !track.muted)},
    keyed ? {command: `mix.solo.${n}`, label: COPY.solo, type: 'checkbox'}
      : {id: 'solo', label: COPY.solo, type: 'checkbox', checked: !!track.soloed, run: () => transport.setSoloed(name, !track.soloed)},
    {id: 'reset', label: COPY.resetLevel, icon: 'volume-2', ...(Math.abs((track.volume ?? 1) - 1) < 1e-6 ? {reason: COPY.levelFull} : {}),
      run: () => transport.setVolume(name, 1, {coalesce: false})},
    SEPARATOR,
    {id: 'mine', label: COPY.mine, type: 'checkbox', checked: mine,
      ...(!instrument ? {reason: COPY.noInstrument} : mine ? {reason: COPY.alreadyMine} : !signedIn ? {reason: COPY.signInForMine} : {}),
      run: () => { void makeMine(instrument, opts); }},
  ];
  return items;
}

/** "This is my instrument": the stem's instrument becomes the profile's primary (and joins the instruments). */
export async function makeMine(instrument, opts = {}) {
  if (!INSTRUMENTS.includes(instrument)) return false;
  const account = opts.account ?? appAccount;
  const feedback = feedbackOf(opts);
  const profile = peek(account.profile) ?? peek(account.value)?.profile ?? {instruments: [], primary: null, openWithMyPart: 'in'};
  const instruments = [instrument, ...(profile.instruments ?? []).filter((i) => i !== instrument)].slice(0, INSTRUMENTS.length);
  try {
    await account.patch({profile: {...profile, instruments, primary: instrument}});
  } catch (err) {
    console.warn('[menus] the profile could not be saved', err);
    feedback.toast?.(COPY.mineFailed, {tone: 'error'});
    return false;
  }
  feedback.status?.(COPY.nowMine(INSTRUMENT_LABELS[instrument]), {key: 'mine'});
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// The controls table (§9.0): every menu's rows, with the role and accessible name the Menu renders.
// `when` names the song the row needs: 'mapped' | 'unmapped' | 'part' (a drum part) | 'follows' (the
// Chart, or the mapped Road map: a surface that follows by rows) | 'sections-missing' (mapped without sections) | 'owner' (not a shared song: Edit is hidden there,
// spec §4.13), space-separated when a row needs several; rows without it are always present. `via` names the command
// a plain row runs itself (it is not command-bound).

const row = (menu, role, name, extra = {}) => Object.freeze({menu, role, name, ...extra});
export const CONTROLS = Object.freeze([
  row('stage', 'menuitem', COPY.view),
  row('stage', 'menuitemradio', STAGE_COPY.commands.viewChart, {command: 'view.chart', parent: COPY.view}),
  row('stage', 'menuitemradio', STAGE_COPY.surfaces.roadmap, {command: 'view.roadmap', parent: COPY.view, when: 'mapped'}),
  row('stage', 'menuitemradio', STAGE_COPY.surfaces.wave, {command: 'view.roadmap', parent: COPY.view, when: 'unmapped'}),
  row('stage', 'menuitemradio', STAGE_COPY.commands.viewStems, {command: 'view.stems', parent: COPY.view}),
  row('stage', 'menuitem', COPY.display, {when: 'part'}),
  row('stage', 'menuitemradio', COPY.together, {command: 'view.display', parent: COPY.display, when: 'part'}),
  row('stage', 'menuitemradio', COPY.handsFeet, {command: 'view.display', parent: COPY.display, when: 'part'}),
  row('stage', 'menuitem', COPY.follow, {when: 'follows'}),
  row('stage', 'menuitemradio', COPY.scroll, {command: 'view.followStyle', parent: COPY.follow, when: 'follows'}),
  row('stage', 'menuitemradio', COPY.page, {command: 'view.followStyle', parent: COPY.follow, when: 'follows'}),
  row('stage', 'menuitemcheckbox', STAGE_COPY.commands.focus, {command: 'view.focus', kbd: 'KeyF'}),
  row('stage', 'menuitem', COPY.distance),
  row('stage', 'menuitemradio', STAGE_COPY.distances.near, {command: 'view.distance.near', parent: COPY.distance}),
  row('stage', 'menuitemradio', STAGE_COPY.distances.stand, {command: 'view.distance.stand', parent: COPY.distance}),
  row('stage', 'menuitemradio', STAGE_COPY.distances.kit, {command: 'view.distance.kit', parent: COPY.distance}),
  row('stage', 'menuitem', COPY.spots, {command: 'spot.list', kbd: 'KeyJ'}),
  row('stage', 'menuitem', STAGE_COPY.commands.notes, {command: 'stage.notes'}),
  row('stage', 'menuitem', STAGE_COPY.commands.tapBeat, {command: 'stage.tapBeat'}),
  row('stage', 'menuitem', STAGE_COPY.commands.getBars, {command: 'stage.getBars', when: 'unmapped'}),
  row('stage', 'menuitem', STAGE_COPY.commands.detect, {command: 'map.detect', when: 'mapped'}),
  row('stage', 'menuitem', STAGE_COPY.commands.suggest, {command: 'sections.suggest', when: 'sections-missing'}),
  row('stage', 'menuitem', STAGE_COPY.commands.share, {command: 'stage.share'}),
  row('stage', 'menuitem', STAGE_COPY.commands.editMap, {command: 'edit.map', when: 'owner'}),
  row('stage', 'menuitem', STAGE_COPY.commands.editChart, {command: 'edit.chart', when: 'owner'}),
  row('stage', 'menuitem', STAGE_COPY.commands.editDetails, {command: 'edit.details', when: 'owner'}),
  row('stage', 'menuitem', STAGE_COPY.commands.resplit, {command: 'song.resplit'}),
  row('stage', 'menuitem', COPY.shortcuts, {command: 'app.shortcuts', kbd: '?'}),

  row('bar', 'menuitem', COPY.playFromHere),
  row('bar', 'menuitem', COPY.cueHere),
  row('bar', 'menuitem', COPY.loopBar, {when: 'mapped'}),
  row('bar', 'menuitem', COPY.loopSection, {when: 'mapped'}),
  row('bar', 'menuitem', COPY.loopFour, {when: 'mapped'}),
  row('bar', 'menuitem', COPY.loopPart, {when: 'unmapped'}),
  row('bar', 'menuitem', COPY.loopSeconds, {when: 'unmapped'}),
  row('bar', 'menuitem', COPY.saveSpotHere),
  row('bar', 'menuitem', COPY.addSection, {when: 'mapped'}),
  row('bar', 'menuitem', COPY.addMarker, {when: 'unmapped'}),

  row('section', 'menuitem', COPY.playFromHere),
  row('section', 'menuitem', COPY.loopSection, {when: 'mapped'}),
  row('section', 'menuitem', COPY.loopPart, {when: 'unmapped'}),
  row('section', 'menuitem', COPY.extendLoop),
  row('section', 'menuitem', COPY.saveAsSpot),
  row('section', 'menuitem', COPY.rename),
  row('section', 'menuitem', COPY.editSections, {command: 'edit.map', when: 'mapped owner'}),
  row('section', 'menuitem', COPY.editMap, {command: 'edit.map', when: 'unmapped owner'}),

  // Open runs spot.open with the spot's id itself (`via`): the row is not command-bound (no key-cap, no registry state).
  row('spot', 'menuitem', COPY.open, {via: 'spot.open'}),
  row('spot', 'menuitem', COPY.rename),
  row('spot', 'menuitem', COPY.update),
  row('spot', 'menuitem', COPY.delete),

  row('marker', 'menuitem', COPY.rename),
  row('marker', 'menuitem', COPY.delete),
  row('marker', 'menuitem', COPY.turnInto, {when: 'mapped'}),

  row('loopBand', 'menuitem', COPY.saveSpot, {command: 'spot.save', kbd: 'KeyB'}),
  row('loopBand', 'menuitemcheckbox', TRANSPORT_COPY.eachPass, {command: 'loop.eachPass'}),
  row('loopBand', 'menuitem', COPY.moveBack('8 bars'), {command: 'loop.moveBack', kbd: 'Shift+[', when: 'mapped'}),
  row('loopBand', 'menuitem', COPY.moveFwd('8 bars'), {command: 'loop.moveFwd', kbd: 'Shift+]', when: 'mapped'}),
  row('loopBand', 'menuitem', COPY.clear, {command: 'loop.clear', kbd: 'Backspace'}),

  row('stem', 'menuitemcheckbox', COPY.mute, {command: 'mix.mute.1', kbd: 'Digit1'}),
  row('stem', 'menuitemcheckbox', COPY.solo, {command: 'mix.solo.1', kbd: 'Shift+Digit1'}),
  row('stem', 'menuitem', COPY.resetLevel),
  row('stem', 'menuitemcheckbox', COPY.mine),
]);

/** For the tests and the ? sheet: a stem's display name. */
export {stemLabel};
