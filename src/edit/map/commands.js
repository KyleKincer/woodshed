// Edit · Map commands (architecture §3.4 scope Em = 'edit.map'; D19, D20, D46; maps/mapedit.md
// §5.3, §11.4 "Key conflicts"). Importing this module registers them on the app registry (main.js
// and registry CI do); defineMapCommands({registry}) registers them on any registry (tests).
//
// Definitions are eager and cheap (D46): this module imports only the registry and the copy table.
// Every `run` reaches its work through the command context:
//   map       c.map, the MapSession (src/edit/map/session.js) Edit provides while the Map tab is open
//   mapView   c.mapView, the mounted map view (src/edit/map/view.js): zoom, grid, snap, the inspector
//             fields (focusMeter for E, applyFocused for Enter)
//   session   c.session (read-only songs refuse every map edit)
//   transport c.transport (the playhead for S)
//
// D19: digits + Enter go to a bar (stems mute through the row M/S buttons here); E focuses the
// inspector's Meter → Beats stepper; Space stays Play/Stop (taps are D and T); Enter goes to the
// typed bar or applies the focused inspector field, never Again; ⌫ deletes a typed digit, else
// unpins, and never clears the loop.
// D20: while Find a chart auditions, every map-mutating command (and map.undo / map.redo) is
// disabled through `when: c => !c.map.auditioning`; navigation, zoom, grid and snap stay live.
import {registry as appRegistry} from '../../app/commands.js';
import {COPY, MAP_COMMANDS as C, MAP_SCOPE} from './map.copy.js';

const EM = MAP_SCOPE;
const T = COPY.commands;

/** The digits family (map.digit.0 … map.digit.9): "Go to bar", typed (D19). */
const DIGITS = Object.freeze(Array.from({length: 10}, (_, n) => n));
export const DIGIT_IDS = Object.freeze(DIGITS.map((n) => `map.digit.${n}`));

/** Every id this module registers (registry CI and the tests). */
export const MAP_COMMAND_IDS = Object.freeze([
  C.undo, C.redo, C.prevBar, C.nextBar, C.prevBeat, C.nextBeat, C.prevPin, C.nextPin,
  ...DIGIT_IDS, C.goOrApply, C.first, C.last,
  C.pinDownbeat, C.pinBeat, C.unpin, C.nudgeBack, C.nudgeFwd, C.nudgeBackFine, C.nudgeFwdFine,
  C.renumberBack, C.renumberFwd, C.renumberBeatBack, C.renumberBeatFwd,
  C.beatsDown, C.beatsUp, C.beatsDownBar, C.beatsUpBar, C.tailDown, C.tailUp, C.tailDownFine, C.tailUpFine,
  C.editBar, C.ramp, C.preview, C.double, C.halve, C.addSection, C.grid, C.snap,
  C.zoomIn, C.zoomOut, C.fit, C.zoomSelection, C.tapAlong, C.calibrate, C.markersToSections,
]);

// ---------------------------------------------------------------------------------------------------------------
// Context readers (safe on a context with nothing provided)

const peek = (v) => (v && typeof v === 'object' && typeof v.peek === 'function' ? v.peek() : v);

/** The MapSession of the open Map tab, or null. */
export const mapOf = (c) => (c?.map && typeof c.map === 'object' && typeof c.map.select === 'function' ? c.map : null);
/** The mounted map view, or null. */
export const viewOf = (c) => (c?.mapView && typeof c.mapView === 'object' ? c.mapView : null);
const sessionOf = (c) => (c?.session && typeof c.session === 'object' ? c.session : null);
const songMap = (c) => sessionOf(c)?.map ?? null;
/** The song's map is a real map (bars exist; unmapped songs have no bar commands, §2.14.4). */
const real = (c) => !!songMap(c)?.isReal;
const auditioning = (c) => !!peek(mapOf(c)?.auditioning);
const readOnly = (c) => !!sessionOf(c)?.readOnly;

/** A map session is open (navigation). */
const open = (c) => !!mapOf(c);
/** A map session is open on a real map (bar navigation). */
const mappedOpen = (c) => open(c) && real(c);
/** Map edits are allowed: open, writable, not auditioning (D20). */
const editable = (c) => open(c) && !readOnly(c) && !auditioning(c);
/** Edits that need bars to exist. */
const mappedEditable = (c) => editable(c) && real(c);
const spanOf = (c) => peek(mapOf(c)?.span) ?? null;
const digitsOf = (c) => String(peek(mapOf(c)?.digits) ?? '');
const view = (name, ...args) => (c) => { viewOf(c)?.[name]?.(...args); };
const viewHas = (name) => (c) => typeof viewOf(c)?.[name] === 'function';

/**
 * Stopped, a navigation's new selection becomes the transport's cue, so Play starts there (1.9's
 * select() moved the edit position; the transport keeps the cue in practice, §2.14.3 rule 1).
 * Playing, the map session has already sought without moving the cue (rule 23).
 */
export function cueSelection(c) {
  const m = mapOf(c), transport = c?.transport ?? sessionOf(c)?.transport, map = songMap(c);
  if (!m || !map || typeof transport?.cue !== 'function' || peek(m.previewing) || peek(m.tapping)) return;
  if (peek(transport.snapshot)?.phase !== 'stopped') return;
  const t = map.timeAt(peek(m.cursorQ));
  if (Number.isFinite(t) && Math.abs((peek(transport.snapshot)?.cue ?? NaN) - t) > 1e-6) transport.cue(t);
}

/** The playhead (stopped: the cue), for S. */
function playhead(c) {
  const t = c?.transport ?? sessionOf(c)?.transport;
  if (typeof t?.position === 'function') return t.position();
  return Number(peek(t?.snapshot)?.cue) || 0;
}

// ---------------------------------------------------------------------------------------------------------------
// The definitions (§3.4, Em rows, in table order)

/** The §3.4 Em definitions. */
export function mapCommandDefs() {
  const nav = (id, title, keys, run, extra = {}) => ({id, title, group: 'Map', keys, scopes: [EM], when: mappedOpen, run, ...extra});
  const edit = (id, title, keys, run, extra = {}) => ({id, title, group: 'Map', keys, scopes: [EM], when: mappedEditable, run, ...extra});
  const ms = (fn) => (c) => fn(mapOf(c), c);
  /** A navigation: run it, then cue the new selection when stopped. */
  const go = (fn) => (c) => { fn(mapOf(c), c); cueSelection(c); };

  return [
    {
      id: C.undo, title: T.undo, group: 'Map', keys: ['Mod+KeyZ'], scopes: [EM], icon: 'undo-2',
      when: (c) => editable(c) && !!peek(mapOf(c).canUndo),
      run: ms((m) => m.undo()),
    },
    {
      id: C.redo, title: T.redo, group: 'Map', keys: ['Mod+Shift+KeyZ', 'Mod+KeyY'], scopes: [EM], icon: 'redo-2',
      when: (c) => editable(c) && !!peek(mapOf(c).canRedo),
      run: ms((m) => m.redo()),
    },
    nav(C.prevBar, T.prevBar, ['ArrowLeft'], go((m) => m.step(-1, 'bar')), {repeat: true, icon: 'chevron-left'}),
    nav(C.nextBar, T.nextBar, ['ArrowRight'], go((m) => m.step(1, 'bar')), {repeat: true, icon: 'chevron-right'}),
    nav(C.prevBeat, T.prevBeat, ['Shift+ArrowLeft'], go((m) => m.step(-1, 'beat')), {repeat: true}),
    nav(C.nextBeat, T.nextBeat, ['Shift+ArrowRight'], go((m) => m.step(1, 'beat')), {repeat: true}),
    nav(C.prevPin, T.prevPin, ['Mod+ArrowLeft'], go((m) => m.step(-1, 'pin')), {icon: 'skip-back'}),
    nav(C.nextPin, T.nextPin, ['Mod+ArrowRight'], go((m) => m.step(1, 'pin')), {icon: 'skip-forward'}),
    {
      id: C.goOrApply, title: T.goOrApply, group: 'Map', keys: ['Enter'], scopes: [EM], icon: 'corner-down-left',
      // Enter never reaches Again in this posture (D19): with nothing typed it applies the focused field.
      when: open,
      run: (c) => {
        const m = mapOf(c);
        if (digitsOf(c)) { m.commitDigits(); cueSelection(c); }
        else viewOf(c)?.applyFocused?.();
      },
      palette: {hidden: true},
    },
    nav(C.first, T.first, ['Home'], go((m) => m.first()), {icon: 'chevrons-left'}),
    nav(C.last, T.last, ['End'], go((m) => m.last()), {icon: 'chevrons-right'}),
    // D and T: stopped they pin the nearest line at the playhead; playing they are one tap of a pass.
    edit(C.pinDownbeat, T.pinDownbeat, ['KeyD'], (c) => mapOf(c).pinDownbeat(c.event ?? undefined), {icon: 'pin'}),
    edit(C.pinBeat, T.pinBeat, ['KeyT'], (c) => mapOf(c).pinBeat(c.event ?? undefined), {icon: 'pin'}),
    {
      id: C.unpin, title: (c) => (digitsOf(c) ? T.deleteDigit : T.unpin), group: 'Map', keys: ['Backspace', 'Delete'], scopes: [EM],
      icon: 'pin-off',
      // ⌫ edits the typed bar number first; otherwise it unpins the selected line. It never clears the loop (D19).
      when: (c) => (open(c) && !!digitsOf(c)) || (mappedEditable(c) && !!spanOf(c)?.pin),
      run: (c) => {
        const m = mapOf(c);
        if (digitsOf(c)) m.backspaceDigit();
        else m.unpin();
      },
    },
    edit(C.nudgeBack, T.nudgeBack, [','], ms((m) => m.nudge(-0.01)), {repeat: true}),
    edit(C.nudgeFwd, T.nudgeFwd, ['.'], ms((m) => m.nudge(0.01)), {repeat: true}),
    edit(C.nudgeBackFine, T.nudgeBackFine, ['Shift+,'], ms((m) => m.nudge(-0.001)), {repeat: true}),
    edit(C.nudgeFwdFine, T.nudgeFwdFine, ['Shift+.'], ms((m) => m.nudge(0.001)), {repeat: true}),
    edit(C.renumberBack, T.renumberBack, ['Alt+ArrowLeft'], ms((m) => m.renumber(-1)), {repeat: true}),
    edit(C.renumberFwd, T.renumberFwd, ['Alt+ArrowRight'], ms((m) => m.renumber(1)), {repeat: true}),
    edit(C.renumberBeatBack, T.renumberBeatBack, ['Alt+Shift+ArrowLeft'], ms((m) => m.renumber(-1, {byBeat: true})), {repeat: true}),
    edit(C.renumberBeatFwd, T.renumberBeatFwd, ['Alt+Shift+ArrowRight'], ms((m) => m.renumber(1, {byBeat: true})), {repeat: true}),
    edit(C.beatsDown, T.beatsDown, ['ArrowDown'], ms((m) => m.changeBeats(-1)), {repeat: true, icon: 'minus'}),
    edit(C.beatsUp, T.beatsUp, ['ArrowUp'], ms((m) => m.changeBeats(1)), {repeat: true, icon: 'plus'}),
    edit(C.beatsDownBar, T.beatsDownBar, ['Shift+ArrowDown'], ms((m) => m.changeBeats(-1, {thisBar: true})), {repeat: true}),
    edit(C.beatsUpBar, T.beatsUpBar, ['Shift+ArrowUp'], ms((m) => m.changeBeats(1, {thisBar: true})), {repeat: true}),
    edit(C.tailDown, T.tailDown, ['Alt+ArrowDown'], ms((m) => m.tail(-1)), {repeat: true}),
    edit(C.tailUp, T.tailUp, ['Alt+ArrowUp'], ms((m) => m.tail(1)), {repeat: true}),
    edit(C.tailDownFine, T.tailDownFine, ['Alt+Shift+ArrowDown'], ms((m) => m.tail(-0.1)), {repeat: true}),
    edit(C.tailUpFine, T.tailUpFine, ['Alt+Shift+ArrowUp'], ms((m) => m.tail(0.1)), {repeat: true}),
    {
      id: C.editBar, title: T.editBar, group: 'Map', keys: ['KeyE'], scopes: [EM], icon: 'pencil',
      when: (c) => mappedEditable(c) && viewHas('focusMeter')(c),
      run: view('focusMeter'),
    },
    edit(C.ramp, T.ramp, ['KeyR'], ms((m) => m.toggleRamp()), {
      icon: 'trending-up', checked: (c) => !!spanOf(c)?.tempo?.ramp,
      disabledReason: (c) => (spanOf(c) && !spanOf(c).tempo?.rampAvailable ? COPY.rampUnavailable : null),
    }),
    {
      id: C.preview, title: T.preview, group: 'Map', keys: ['KeyP'], scopes: [EM], icon: 'repeat',
      when: (c) => mappedOpen(c) && !auditioning(c),
      checked: (c) => !!peek(mapOf(c)?.previewing),
      run: ms((m) => { void m.togglePreview(); }),
    },
    edit(C.double, T.double, ['*'], ms((m) => m.scale(2))),
    edit(C.halve, T.halve, ['/'], ms((m) => m.scale(0.5))),
    edit(C.addSection, T.addSection, ['KeyS'], (c) => mapOf(c).addSectionAt(playhead(c)), {icon: 'flag'}),
    {
      id: C.grid, title: T.grid, group: 'Map', keys: ['KeyG'], scopes: [EM], icon: 'grid-3x3',
      when: (c) => mappedOpen(c) && viewHas('toggleGrid')(c),
      checked: (c) => !!viewOf(c)?.gridOn?.(),
      run: view('toggleGrid'),
    },
    {
      id: C.snap, title: T.snap, group: 'Map', keys: ['Shift+KeyS'], scopes: [EM], icon: 'magnet',
      when: (c) => open(c) && viewHas('toggleSnap')(c),
      checked: (c) => !!viewOf(c)?.snapOn?.(),
      run: view('toggleSnap'),
    },
    {
      id: C.zoomIn, title: T.zoomIn, group: 'Map', keys: ['='], scopes: [EM], icon: 'zoom-in', repeat: true,
      when: (c) => open(c) && viewHas('zoom')(c), run: view('zoom', 1),
    },
    {
      id: C.zoomOut, title: T.zoomOut, group: 'Map', keys: ['-'], scopes: [EM], icon: 'zoom-out', repeat: true,
      when: (c) => open(c) && viewHas('zoom')(c), run: view('zoom', -1),
    },
    {
      id: C.fit, title: T.fit, group: 'Map', keys: ['\\'], scopes: [EM], icon: 'maximize-2',
      when: (c) => open(c) && viewHas('fit')(c), run: view('fit'),
    },
    {
      id: C.zoomSelection, title: T.zoomSelection, group: 'Map', keys: ['KeyZ'], scopes: [EM], icon: 'scan',
      when: (c) => mappedOpen(c) && viewHas('zoomSelection')(c), run: view('zoomSelection'),
    },
    {
      id: C.tapAlong, group: 'Map', scopes: [EM], icon: 'hand',
      // Tapping along (the transport plays) → the button stops; otherwise it starts the song.
      title: (c) => (viewOf(c)?.playing?.() ? COPY.stopTapping : T.tapAlong),
      when: (c) => editable(c) && !peek(mapOf(c).calibrating),
      run: ms((m) => { void m.tapAlong(); }),
    },
    {
      id: C.calibrate, title: T.calibrate, group: 'Map', scopes: [EM], icon: 'timer',
      when: (c) => editable(c) && !peek(mapOf(c).calibrating),
      run: ms((m) => { void m.startCalibration(); }),
    },
    {
      id: C.markersToSections, title: T.markersToSections, group: 'Map', scopes: [EM], icon: 'flag',
      when: (c) => mappedEditable(c) && liveMarkers(c) > 0,
      run: ms((m) => m.markersToSections()),
    },
  ];
}

/** The map.digit.{n} template (registerDynamic). */
function digitTemplate() {
  return {
    id: 'map.digit.{n}', title: (c, n) => T.digit(n), group: 'Map', keys: ['Digit{n}'], scopes: [EM],
    when: (c) => mappedOpen(c), palette: {hidden: true},
    run: (c, {n}) => { mapOf(c).typeDigit(n); },
  };
}

/** The live (not deleted) markers of the song's practice. */
function liveMarkers(c) {
  const practice = peek(sessionOf(c)?.practice?.value);
  return (practice?.markers ?? []).filter((m) => !m.deleted).length;
}

/**
 * Registers the Em commands (and the digits family) on `registry`. Returns off(). A registry that
 * already has them is left alone (one definition set per registry).
 */
export function defineMapCommands({registry = appRegistry} = {}) {
  if (registry.get(C.undo)) return () => {};
  const offMany = registry.registerMany(mapCommandDefs());
  const offDigits = registry.registerDynamic(digitTemplate(), DIGITS);
  return () => { offDigits(); offMany(); };
}

defineMapCommands();
