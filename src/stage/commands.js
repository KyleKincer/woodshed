// Stage commands (architecture §3.2, spec §7.2): view, surfaces, Focus, Distance, markers, spots,
// sheets, edit, leave, setlists, undo, and the Stage-reachable map and section commands whose
// work lives in Edit (D46). Importing this module registers them on the app registry (main.js
// and registry CI do); defineStageCommands({registry}) registers them on any registry (tests).
//
// Definitions are eager and cheap (D46): this module imports only the registry and pure copy.
// Every `run` reaches its work through the command context:
//   stage     c.stage, the mounted Stage (stage.js, §2.14.10): {session, layout, surface, focus,
//             distance, following, setlist, setSurface, cycleSurface, toggleFocus, setDistance,
//             zoom, resumeFollow, setDisplay, setFollowStyle, scrollBy, scrollTop, openSheet,
//             openMenu, share, startOver, leave, close, undo, redo, goSetlist, editTab, …}
//   session   c.session (the Stage provides it; Edit provides its own); null while the audio failed
//             to load, which disables the session's practice commands with the frame's reason
//   router, feedback, store, desktop   app providers (main.js)
// Signals are read with peek(); the Stage invalidates the registry when they change.
//
// Commands with arguments: spot.open {id}, view.display {layout: 'combined'|'split'|null},
// view.followStyle {style: 'scroll'|'page'}, song.resplit {songId} (the Library's card menu).
// Read-only (shared) sessions disable Edit, Share, the map and detection commands and Re-split.

import {registry as appRegistry} from '../app/commands.js';
import {COPY} from './stage.copy.js';

// Later-wave modules, resolved by contract path (D2; Appendix C item 58): LB3's Re-split dialog.
const LATER = import.meta.glob(['../library/resplit-dialog.js']);
const RESPLIT_PATH = '../library/resplit-dialog.js';

const S = 'stage';
const EM = 'edit.map';
const L = 'library';
const E = 'edit';
const C = COPY.commands;

export const SURFACE_ORDER = Object.freeze(['chart', 'roadmap', 'stems']);
export const DISPLAY_LAYOUTS = Object.freeze(['combined', 'split']);
export const FOLLOW_STYLES = Object.freeze(['scroll', 'page']);
export const EDIT_TABS = Object.freeze(['map', 'chart', 'details']);
/** The ids this module registers (registry CI and the tests). */
export const STAGE_COMMAND_IDS = Object.freeze([
  'marker.add', 'spot.save', 'spot.list', 'spot.open', 'stage.menu', 'song.resplit',
  'map.detect', 'map.find', 'sections.suggest', 'sections.keepAll', 'sections.review',
  'view.cycle', 'view.chart', 'view.roadmap', 'view.stems', 'view.focus',
  'view.distance.near', 'view.distance.stand', 'view.distance.kit', 'view.bigger', 'view.smaller', 'view.followResume',
  'view.display', 'view.followStyle', 'stage.scrollUp', 'stage.scrollDown', 'stage.scrollTop',
  'stage.notes', 'stage.tapBeat', 'stage.getBars', 'stage.share', 'stage.startOver', 'stage.leave', 'stage.close',
  'edit.open', 'edit.map', 'edit.chart', 'edit.details', 'practice.undo', 'practice.redo', 'setlist.next', 'setlist.prev',
]);

// ---------------------------------------------------------------------------------------------------------------
// Context readers (safe on a context with nothing provided)

const peek = (v) => (v && typeof v === 'object' && typeof v.peek === 'function' ? v.peek() : v);
const argOf = (c, name) => (c?.args && typeof c.args === 'object' ? c.args[name] : undefined);

/** The mounted Stage, or null. */
export const stageOf = (c) => (c?.stage && typeof c.stage === 'object' ? c.stage : null);
/** The live session the practice commands act on (null while the audio failed to load). */
export const sessionOf = (c) => (c?.session && typeof c.session === 'object' ? c.session : null);
/** The song's session even while its audio failed (Edit details, Re-split, Share stay reachable). */
const songSession = (c) => sessionOf(c) ?? stageOf(c)?.session ?? null;
const writable = (s) => !!s && !s.readOnly;
const phaseOf = (c) => peek(sessionOf(c)?.transport?.snapshot)?.phase ?? null;
const playingOf = (c) => ['playing', 'counting'].includes(phaseOf(c));
const mapOf = (s) => s?.map ?? null;
const statusOf = (c) => (text, options) => c?.feedback?.status?.(text, options);
const songIdOf = (c) => argOf(c, 'songId') ?? songSession(c)?.id ?? null;
const surfaceOf = (c) => peek(stageOf(c)?.surface) ?? null;
const canStage = (method) => (c) => typeof stageOf(c)?.[method] === 'function';
const json = (v) => JSON.stringify(v ?? null);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** The current playhead (playing) or cue (stopped), in seconds. */
function hereOf(session) {
  const t = session?.transport?.position?.();
  return Number.isFinite(t) ? t : (peek(session?.transport?.snapshot)?.cue ?? 0);
}

/** Ask for a new name in a small form dialog (the status line's [Rename]). */
async function askName(c, {title, value}) {
  const form = c?.feedback?.form;
  if (typeof form !== 'function') return null;
  const result = await form({title, submitLabel: COPY.save, fields: [{name: 'name', label: COPY.nameLabel, kind: 'text', required: true, maxLength: 60, value}]});
  const name = typeof result?.name === 'string' ? result.name.trim() : '';
  return name || null;
}

// ---------------------------------------------------------------------------------------------------------------
// Markers and sections (spec §4.5, architecture §4.5)

/**
 * S: unmapped → a marker at the playhead; mapped → label the bar under it "Section {n}" (one undo
 * step). A shared (read-only) song keeps its map, so S adds a marker there (saved on this device).
 */
export function addMarkerHere(c) {
  const session = sessionOf(c);
  if (!session) return null;
  const status = statusOf(c);
  const t = hereOf(session);
  const map = mapOf(session);
  if (map?.isReal && writable(session)) {
    const index = map.barIndexAt(t);
    const bar = map.bars[index];
    const existing = map.sections.find((s) => s.startBar === index);
    if (!bar) return null;
    if (existing) { status(COPY.alreadyStarts(bar.display, existing.name), {key: 'marker'}); return null; }
    const label = `Section ${map.sections.length + 1}`;
    const result = session.mapChange(C.addSection, (m) => m.edit((d) => { d.measures[index].label = label; }, 'label'));
    if (!result) return null;
    status(COPY.sectionAdded(label), {key: 'marker', action: {label: COPY.rename, run: () => renameSection(c, session, index, label)}});
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
  status(COPY.markerAdded(marker?.label ?? ''), {key: 'marker', action: {label: COPY.rename, run: () => renameMarker(c, session, id)}});
  return {kind: 'marker', id, label: marker?.label};
}

async function renameMarker(c, session, id) {
  const practice = session.practice;
  const marker = practice.value.peek().markers.find((m) => m.id === id && !m.deleted);
  if (!marker) return;
  const name = await askName(c, {title: COPY.renameMarker, value: marker.label});
  if (!name || name === marker.label || session.disposed) return;
  const before = clone(practice.value.peek().markers);
  practice.renameMarker(id, name);
  const after = clone(practice.value.peek().markers);
  session.undo.push({key: 'markers', label: 'marker', describe: () => `rename ${marker.label} → ${name}`, from: before, to: after,
    apply: (v) => practice.patch({markers: clone(v)})});
}

async function renameSection(c, session, index, current) {
  const name = await askName(c, {title: COPY.renameSection, value: current});
  if (!name || name === current || session.disposed) return;
  session.mapChange(`rename ${current} → ${name}`, (m) => m.edit((d) => { if (d.measures[index]) d.measures[index].label = name; }, 'label'));
}

// ---------------------------------------------------------------------------------------------------------------
// Spots (spec §4.7, architecture §2.14.1 spot counters)

/** B: save the loop (or the region around the playhead) as a spot at the current speed; it becomes the active spot. */
export function saveSpotHere(c) {
  const session = sessionOf(c);
  if (!session) return null;
  const practice = session.practice;
  const snap = peek(session.transport.snapshot);
  const loop = snap?.loop;
  const live = practice.value.peek().spots.filter((s) => !s.deleted);
  if (live.length >= 24) { statusOf(c)(COPY.spotsFull, {key: 'spot'}); return null; }
  let a, b, name;
  if (loop && loop.b - loop.a > 1e-6) { a = loop.a; b = loop.b; name = loop.label; }
  else ({a, b, label: name} = session.position.loopDefault(hereOf(session)));
  const rate = snap?.rate ?? 1;
  const refs = {aBar: session.position.ref(a) ?? undefined, bBar: session.position.ref(b) ?? undefined};
  const before = clone(practice.value.peek().spots);
  const id = practice.addSpot({name: name || 'Spot', a, b, rate, passes: 0, ...refs});
  if (!id) return null;
  const after = clone(practice.value.peek().spots);
  session.undo.push({key: 'spots', label: 'spot', describe: () => `save spot ${name}`, from: before, to: after,
    apply: (v) => practice.patch({spots: clone(v)})});
  practice.activeSpotId.value = id;
  statusOf(c)(COPY.spotSaved(name, rate), {key: 'spot'});
  return id;
}

/** Open a spot: loop its range, set its speed (the loop sets the cue), make it the active spot. */
export function openSpot(c, id) {
  const session = sessionOf(c);
  if (!session) return false;
  const spot = session.practice.value.peek().spots.find((s) => s.id === id && !s.deleted);
  if (!spot) { statusOf(c)(COPY.spotMissing, {key: 'spot'}); return false; }
  const t = session.transport;
  const a = (spot.aBar && session.position.resolve(spot.aBar)) ?? spot.a;
  const b = (spot.bBar && session.position.resolve(spot.bBar)) ?? spot.b;
  t.loopRange(a, b, {label: spot.name, snap: 'none'});
  if (Number.isFinite(spot.rate)) t.setSpeed(spot.rate, {coalesce: false});
  session.practice.activeSpotId.value = spot.id;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Undo feedback (spec §4.14): a toast when stopped, the status line while playing

export function undoStep(c, which) {
  const session = sessionOf(c);
  if (!session) return null;
  const entry = which === 'redo' ? session.undo.redo() : session.undo.undo();
  const fb = c?.feedback;
  if (!entry) {
    fb?.status?.(which === 'redo' ? COPY.nothingToRedo : COPY.nothingToUndo, {key: 'undo'});
    return null;
  }
  const text = `${which === 'redo' ? 'Redid' : 'Undid'}: ${entry.describe()}`;
  const action = which === 'redo'
    ? {label: COPY.undo, run: () => undoStep(c, 'undo')}
    : {label: COPY.redo, run: () => undoStep(c, 'redo')};
  if (playingOf(c)) fb?.status?.(text, {action, key: 'undo'});
  else fb?.toast?.(text, {action, key: 'undo'});
  return entry;
}

// ---------------------------------------------------------------------------------------------------------------
// The definitions

/** Registers the §3.2 commands on `registry`. Returns off(). `later` maps later-wave contract paths to loaders. */
export function defineStageCommands({registry = appRegistry, later = LATER} = {}) {
  const hasSession = (c) => !!sessionOf(c);
  const hasStage = (c) => !!stageOf(c);
  const ownerSong = (c) => writable(songSession(c));
  const detectOf = (c) => songSession(c)?.detect ?? null;
  const canDetectReason = (c) => {
    const verdict = peek(detectOf(c)?.canDetect);
    return verdict && !verdict.ok ? verdict.reason ?? null : null;
  };
  const sheet = (name, extra = {}) => ({
    scopes: [S], ...extra,
    when: (c) => hasSession(c) && canStage('openSheet')(c) && (extra.when ? extra.when(c) : true),
    run: (c) => stageOf(c).openSheet(name, {anchor: argOf(c, 'anchor')}),
  });
  const surfaceRadio = (kind, title) => ({
    id: `view.${kind}`, title, group: 'View', scopes: [S], icon: kind === 'chart' ? 'music' : kind === 'stems' ? 'layers' : 'list',
    menu: {label: title, electron: 'View', radio: 'surface'},
    when: (c) => hasStage(c) && canStage('setSurface')(c),
    checked: (c) => {
      const s = surfaceOf(c);
      return kind === 'roadmap' ? s === 'roadmap' || s === 'wave' : s === kind;
    },
    run: (c) => stageOf(c).setSurface(kind),
  });
  const distanceRadio = (d) => ({
    id: `view.distance.${d}`, title: C.distance(COPY.distances[d]), group: 'View', scopes: [S],
    menu: {label: COPY.distances[d], electron: 'View', radio: 'distance'},
    palette: {keywords: ['distance', 'size', 'readable', COPY.distances[d].toLowerCase()]},
    when: canStage('setDistance'),
    checked: (c) => peek(stageOf(c)?.distance) === d,
    run: (c) => stageOf(c).setDistance(d),
  });
  const zoomTitle = (dir) => (c) => {
    const s = surfaceOf(c);
    if (s === 'wave') return dir > 0 ? C.biggerWave : C.smallerWave;
    if (s === 'stems') return dir > 0 ? C.biggerStems : C.smallerStems;
    return dir > 0 ? C.bigger : C.smaller;
  };
  const editTab = (tab, title) => ({
    id: `edit.${tab}`, title, group: 'Edit', scopes: [S, E], icon: tab === 'details' ? 'pencil' : tab === 'chart' ? 'drum' : 'grid-3x3',
    when: (c) => ownerSong(c) && !!c?.router,
    run: (c) => c.router.navigate(`/s/${encodeURIComponent(songSession(c).id)}/edit/${tab}`),
  });

  const defs = [
    // ---- markers and spots --------------------------------------------------------------------------------------
    {
      id: 'marker.add', group: 'Practice', keys: ['KeyS'], scopes: [S], pedal: true, icon: 'flag',
      title: (c) => {
        const s = sessionOf(c);
        if (!s) return C.markerAddGeneric;
        return mapOf(s)?.isReal && writable(s) ? C.sectionAdd : C.markerAdd;
      },
      palette: {keywords: ['marker', 'section', 'mark', 'flag']},
      when: hasSession,
      run: (c) => { addMarkerHere(c); },
    },
    {
      id: 'spot.save', title: C.spotSave, group: 'Practice', keys: ['KeyB'], scopes: [S], pedal: true, icon: 'bookmark',
      palette: {keywords: ['spot', 'bookmark', 'save loop']},
      when: hasSession,
      run: (c) => { saveSpotHere(c); },
    },
    {id: 'spot.list', title: C.spotList, group: 'Practice', keys: ['KeyJ'], icon: 'list', palette: {keywords: ['spots', 'bookmarks']},
      ...sheet('spots')},
    {
      id: 'spot.open', group: 'Practice', scopes: [S], icon: 'bookmark',
      title: (c) => {
        const id = argOf(c, 'id');
        const spot = id ? sessionOf(c)?.practice?.value?.peek?.()?.spots?.find((s) => s.id === id && !s.deleted) : null;
        return C.spotOpen(spot?.name);
      },
      palette: {hidden: true},
      when: (c) => hasSession(c) && typeof argOf(c, 'id') === 'string',
      run: (c) => { openSpot(c, argOf(c, 'id')); },
    },

    // ---- the ⋯ menu, re-split -----------------------------------------------------------------------------------
    {
      id: 'stage.menu', title: C.menu, group: 'View', scopes: [S], icon: 'ellipsis', palette: {hidden: true},
      when: (c) => typeof stageOf(c)?.openMenu === 'function' && peek(stageOf(c).menuAvailable) !== false,
      run: (c) => stageOf(c).openMenu('stage', {anchor: argOf(c, 'anchor')}),
    },
    {
      id: 'song.resplit', title: C.resplit, group: 'Library', scopes: [S, L], icon: 'refresh-cw',
      palette: {keywords: ['re-split', 'resplit', 'reprocess', 'stems', 'separate']},
      when: (c) => {
        if (argOf(c, 'songId')) return true;
        return writable(songSession(c));
      },
      disabledReason: (c) => {
        if (!c?.desktop?.available) return COPY.resplitDesktop;
        if (!later?.[RESPLIT_PATH]) return COPY.notBuilt;
        return null;
      },
      run: (c) => {
        const songId = songIdOf(c);
        const load = later?.[RESPLIT_PATH];
        if (!songId || !load) return;
        Promise.resolve().then(load).then((mod) => mod.openResplitDialog({songId, router: c.router, desktop: c.desktop}))
          .catch((err) => console.error('[stage] the Re-split dialog could not open', err));
      },
    },

    // ---- map and sections, defined here because the Stage reaches them (D46) --------------------------------------
    {
      id: 'map.detect', title: C.detect, group: 'Map', scopes: [S, EM], icon: 'wand-2', palette: {keywords: ['detect', 'beats', 'bars', 'grid', 'tempo']},
      when: (c) => ownerSong(c) && !!detectOf(c),
      disabledReason: canDetectReason,
      run: (c) => { void detectOf(c).start({kind: 'beats'}); },
    },
    {
      id: 'map.find', title: C.find, group: 'Map', scopes: [S, EM], icon: 'search', palette: {keywords: ['find', 'chart', 'tab', 'import', 'songsterr']},
      when: (c) => ownerSong(c) && !!c?.router,
      run: (c) => c.router.navigate(`/s/${encodeURIComponent(songSession(c).id)}/edit/map/find`),
    },
    {
      id: 'sections.suggest', title: C.suggest, group: 'Map', scopes: [S, EM], icon: 'sparkles', palette: {keywords: ['sections', 'suggest', 'verse', 'chorus']},
      when: (c) => {
        const s = songSession(c);
        return writable(s) && !!s.detect && !!mapOf(s)?.isReal && !mapOf(s).hasSections;
      },
      disabledReason: canDetectReason,
      run: (c) => { void detectOf(c).start({kind: 'sections'}); },
    },
    {
      id: 'sections.keepAll', title: C.keepAll, group: 'Map', scopes: [S, EM], icon: 'check',
      when: (c) => ownerSong(c) && !!peek(detectOf(c)?.suggestion),
      run: (c) => { detectOf(c).keepAll(); },
    },
    {
      id: 'sections.review', title: C.review, group: 'Map', scopes: [S, EM], icon: 'pencil',
      when: (c) => ownerSong(c) && !!peek(detectOf(c)?.suggestion),
      run: (c) => { detectOf(c).review(); },
    },

    // ---- view ---------------------------------------------------------------------------------------------------
    {
      id: 'view.cycle', title: C.viewCycle, group: 'View', keys: ['KeyV'], scopes: [S], icon: 'layout-grid',
      palette: {keywords: ['view', 'surface', 'switch view']},
      when: canStage('cycleSurface'),
      run: (c) => stageOf(c).cycleSurface(),
    },
    surfaceRadio('chart', C.viewChart),
    surfaceRadio('roadmap', C.viewRoadmap),
    surfaceRadio('stems', C.viewStems),
    {
      id: 'view.focus', group: 'View', keys: ['KeyF'], scopes: [S], pedal: true, icon: 'maximize-2',
      // D25: with Follow paused, F resumes it; otherwise it toggles Focus.
      title: (c) => (peek(stageOf(c)?.following) === false ? C.focusResume : C.focus),
      menu: {label: C.focus, electron: 'View'},
      palette: {keywords: ['focus', 'fullscreen', 'hide controls', 'distraction']},
      when: canStage('toggleFocus'),
      checked: (c) => !!peek(stageOf(c)?.focus),
      run: (c) => {
        const stage = stageOf(c);
        if (peek(stage.following) === false && typeof stage.resumeFollow === 'function') stage.resumeFollow();
        else stage.toggleFocus();
      },
    },
    distanceRadio('near'),
    distanceRadio('stand'),
    distanceRadio('kit'),
    {
      id: 'view.bigger', title: zoomTitle(1), group: 'View', keys: ['='], scopes: [S], repeat: true, icon: 'zoom-in',
      palette: {keywords: ['bigger', 'larger', 'zoom in']}, when: canStage('zoom'), run: (c) => stageOf(c).zoom(1),
    },
    {
      id: 'view.smaller', title: zoomTitle(-1), group: 'View', keys: ['-'], scopes: [S], repeat: true, icon: 'zoom-out',
      palette: {keywords: ['smaller', 'zoom out']}, when: canStage('zoom'), run: (c) => stageOf(c).zoom(-1),
    },
    {
      id: 'view.followResume', title: C.followResume, group: 'View', scopes: [S], pedal: true, icon: 'arrow-down-to-line',
      palette: {keywords: ['follow', 'playhead', 'back to playhead']},
      when: (c) => canStage('resumeFollow')(c) && peek(stageOf(c).following) === false,
      run: (c) => stageOf(c).resumeFollow(),
    },
    {
      id: 'view.display', title: C.display, group: 'View', scopes: [S], icon: 'layers', palette: {hidden: true},
      when: (c) => canStage('setDisplay')(c) && !!sessionOf(c)?.notation?.part,
      checked: (c) => {
        const layout = argOf(c, 'layout');
        const current = peek(stageOf(c)?.display) ?? null;
        return layout === undefined ? current != null : current === layout;
      },
      run: (c) => {
        const layout = argOf(c, 'layout');
        if (layout === null || DISPLAY_LAYOUTS.includes(layout)) stageOf(c).setDisplay(layout);
      },
    },
    {
      id: 'view.followStyle', title: C.followStyle, group: 'View', scopes: [S], icon: 'arrow-down-to-line', palette: {hidden: true},
      when: canStage('setFollowStyle'),
      checked: (c) => {
        const style = argOf(c, 'style');
        return style === undefined ? false : peek(stageOf(c)?.followStyle) === style;
      },
      run: (c) => {
        const style = argOf(c, 'style');
        if (FOLLOW_STYLES.includes(style)) stageOf(c).setFollowStyle(style);
      },
    },
    {id: 'stage.scrollUp', title: C.scrollUp, group: 'View', scopes: [S], pedal: true, icon: 'chevron-up',
      when: canStage('scrollBy'), run: (c) => stageOf(c).scrollBy(-1)},
    {id: 'stage.scrollDown', title: C.scrollDown, group: 'View', scopes: [S], pedal: true, icon: 'chevron-down',
      when: canStage('scrollBy'), run: (c) => stageOf(c).scrollBy(1)},
    {id: 'stage.scrollTop', title: C.scrollTop, group: 'View', scopes: [S], pedal: true, icon: 'arrow-left',
      when: canStage('scrollTop'), run: (c) => stageOf(c).scrollTop()},

    // ---- sheets -------------------------------------------------------------------------------------------------
    {id: 'stage.notes', title: C.notes, group: 'Practice', icon: 'sticky-note', palette: {keywords: ['notes', 'key', 'tuning', 'tags']},
      ...sheet('notes')},
    {id: 'stage.tapBeat', title: C.tapBeat, group: 'Practice', icon: 'hand', palette: {keywords: ['tap', 'tempo', 'bpm', 'beat']},
      ...sheet('tapBeat', {when: (c) => writable(sessionOf(c))})},
    {id: 'stage.getBars', title: C.getBars, group: 'Practice', icon: 'grid-3x3', palette: {keywords: ['bars', 'grid', 'map', 'tempo']},
      ...sheet('getBars', {when: (c) => writable(sessionOf(c))})},

    // ---- song ---------------------------------------------------------------------------------------------------
    {
      id: 'stage.share', title: C.share, group: 'App', scopes: [S], icon: 'share-2', palette: {keywords: ['share', 'link', 'send']},
      when: (c) => ownerSong(c) && canStage('share')(c) && peek(stageOf(c).shareAvailable) !== false,
      run: (c) => stageOf(c).share(),
    },
    {
      id: 'stage.startOver', title: C.startOver, group: 'Practice', scopes: [S], icon: 'rotate-ccw',
      palette: {keywords: ['start over', 'reset', 'from the top', 'clear loop']},
      when: (c) => hasSession(c) && canStage('startOver')(c),
      run: (c) => stageOf(c).startOver(),
    },
    {
      id: 'stage.leave', title: C.leave, group: 'App', scopes: [S], icon: 'chevron-left',
      palette: {keywords: ['back', 'library', 'leave', 'close']},
      when: canStage('leave'),
      run: (c) => stageOf(c).leave({source: c.source}),
    },
    {
      id: 'stage.close', title: C.close, group: 'App', icon: 'x', menu: {label: C.close, electron: 'File'}, palette: {hidden: true},
      when: canStage('close'),
      run: (c) => stageOf(c).close(),
    },

    // ---- edit ---------------------------------------------------------------------------------------------------
    {
      id: 'edit.open', title: C.edit, group: 'Edit', keys: ['KeyE'], scopes: [S], icon: 'pencil',
      palette: {keywords: ['edit', 'map', 'chart', 'details']},
      when: (c) => ownerSong(c) && !!c?.router,
      run: (c) => {
        const last = peek(c.store?.prefs)?.edit?.lastTab;
        const tab = EDIT_TABS.includes(last) ? last : 'map';
        c.router.navigate(`/s/${encodeURIComponent(songSession(c).id)}/edit/${tab}`);
      },
    },
    editTab('map', C.editMap),
    editTab('chart', C.editChart),
    editTab('details', C.editDetails),

    // ---- undo ---------------------------------------------------------------------------------------------------
    {
      id: 'practice.undo', title: C.undo, group: 'Practice', keys: ['Mod+KeyZ'], scopes: [S], icon: 'undo-2',
      when: hasSession,
      disabledReason: (c) => (peek(sessionOf(c)?.undo?.canUndo) === false ? COPY.nothingToUndo : null),
      run: (c) => { undoStep(c, 'undo'); },
    },
    {
      id: 'practice.redo', title: C.redo, group: 'Practice', keys: ['Mod+Shift+KeyZ', 'Mod+KeyY'], scopes: [S], icon: 'redo-2',
      when: hasSession,
      disabledReason: (c) => (peek(sessionOf(c)?.undo?.canRedo) === false ? COPY.nothingToRedo : null),
      run: (c) => { undoStep(c, 'redo'); },
    },

    // ---- setlists (B3) ------------------------------------------------------------------------------------------
    {
      id: 'setlist.next', title: C.setNext, group: 'Navigate', keys: ['Alt+ArrowDown'], scopes: [S], pedal: true, icon: 'chevron-down',
      when: (c) => canStage('goSetlist')(c) && !!peek(stageOf(c).setlist),
      disabledReason: (c) => (peek(stageOf(c)?.setlist)?.next ? null : COPY.setEnd),
      run: (c) => stageOf(c).goSetlist(1),
    },
    {
      id: 'setlist.prev', title: C.setPrev, group: 'Navigate', keys: ['Alt+ArrowUp'], scopes: [S], pedal: true, icon: 'chevron-up',
      when: (c) => canStage('goSetlist')(c) && !!peek(stageOf(c).setlist),
      disabledReason: (c) => (peek(stageOf(c)?.setlist)?.prev ? null : COPY.setStart),
      run: (c) => stageOf(c).goSetlist(-1),
    },
  ];

  return registry.registerMany(defs);
}

/** The ids of the radio groups (menus build them as radios). */
export const RADIO_GROUPS = Object.freeze({
  surface: Object.freeze(['view.chart', 'view.roadmap', 'view.stems']),
  distance: Object.freeze(['view.distance.near', 'view.distance.stand', 'view.distance.kit']),
});

/** True when `a` and `b` describe the same JSON value (exported for the tests). */
export const sameValue = (a, b) => json(a) === json(b);

defineStageCommands();
