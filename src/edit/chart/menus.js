// Edit · Chart menus and the frame's copy (spec §5.2, maps/notation.md §12.3, architecture §3.4).
//
//   editMenu(state)          Edit ▾: Copy ⌘C, Paste ⌘V, Repeat bars… ⌘D, Select all bars (⌘A twice), Delete,
//                            Move notes… ⌥←/→, Tuplet on this beat…,
//                            Mark bars reviewed, Loop selection L, New line here ✓, Clear line breaks,
//                            Bar meter & label…, Align in tempo map…
//   partMenu(state)          Part ▾: Export .woodshed.json, Print, Open .woodshed.json part…, Import a chart from a file…,
//                            Clear drum chart…,
//                            Drum keys…, Note list ✓, Show every kit piece ✓ (Lanes only), Keyboard shortcuts ?
//   tupletMenu(state, run)   Tuplet ▾: Straight, Triplet, Quintuplet, Sextuplet, Septuplet
//   rollMenu(state, run)     Roll ▾: No roll, 1 slash, 2 slashes, 3 slashes
//   gridMenu(state, run)     Grid ▾ (Lanes): 1/4 … 1/64 and Triplet
//   sectionsMenu(sections, run)   Go to (the status bar's position): First bar ⌘Home, Previous section [,
//                            Next section ], Last bar ⌘End, then Intro · Bar 1, Verse · Bar 5, …
//
// Every item that has a command takes its label, key-cap, enabled state and disabled reason from the registry
// (src/ui/menu.js resolveItem); radio items with arguments carry their own `checked` (the registry evaluates
// `checked` without arguments). COPY holds the frame's strings; CONTROLS lists the toolbar's controls and
// STATUS_CONTROLS the status bar's (role, accessible name, command) for the table-driven test (§9.0).

import {COPY as COMMANDS} from './commands.js';

export const COPY = Object.freeze({
  toolbar: 'Chart tools',
  view: 'View',
  score: 'Score',
  lanes: 'Lanes',
  steps: 'Step',
  stepNames: Object.freeze({4: 'Quarter step', 8: 'Eighth step', 16: 'Sixteenth step', 32: '32nd step', 64: '64th step'}),
  dotted: 'Dotted',
  tuplet: 'Tuplet',
  tupletNames: Object.freeze({1: 'Straight', 3: 'Triplet', 5: 'Quintuplet', 6: 'Sextuplet', 7: 'Septuplet'}),
  articulation: 'Articulation',
  roll: 'Roll',
  rollNames: Object.freeze({0: 'No roll', 1: '1 slash', 2: '2 slashes', 3: '3 slashes'}),
  rollShort: n => `×${n}`,
  skip: 'Skip',
  writing: 'Writing',
  bars: (first, last) => (first === last ? `Bar ${first}` : `Bars ${first}–${last}`),
  barsOf: (first, last, total) => `${first === last ? `Bar ${first}` : `Bars ${first}–${last}`} of ${total}`,
  sections: 'Sections',
  goTo: 'Go to',
  sectionItem: (label, bar) => `${label} · Bar ${bar}`,
  sectionName: (label, first, last) => `${label}, ${first === last ? `bar ${first}` : `bars ${first} to ${last}`}`,
  allBars: (total) => (total === 1 ? 'Bar 1' : `Bars 1–${total}`),
  start: 'Start',
  menus: 'Menus',
  edit: 'Edit',
  part: 'Part',
  statusBar: 'Chart status',
  zoom: 'Zoom',
  zoomValue: z => `${Math.round(z * 100)}%`,
  zoomResetName: z => `${COMMANDS.zoomReset}, now ${Math.round(z * 100)}%`,
  followShort: 'Follow',
  grid: 'Grid',
  gridValue: v => `1/${v}`,
  triplet: 'Triplet',
  fit: 'Fit',
  follow: COMMANDS.follow,
  inspector: 'Inspector',
  tabs: Object.freeze({kit: 'Kit', properties: 'Properties', listen: 'Listen'}),
  kitBank: 'Kit pads',
  stepBack: 'Step back',
  stepForward: 'Step forward',
  opening: 'Opening the drum chart…',
  openFailed: 'The drum chart could not be opened.',
  tryAgain: 'Try again',
  noPart: 'This song has no drum part to edit.',
  readOnly: 'A shared song’s drum chart cannot be edited.',
  review: 'Review',
  retry: 'Retry',
  saveStatus: 'Save status',
  editor: 'Drum chart editor',
});

/** The toolbar's controls, left to right (role, accessible name, command when it runs one). */
export const CONTROLS = Object.freeze([
  {role: 'button', name: COPY.stepNames[4], command: 'chart.step.5'},
  {role: 'button', name: COPY.stepNames[8], command: 'chart.step.4'},
  {role: 'button', name: COPY.stepNames[16], command: 'chart.step.3'},
  {role: 'button', name: COPY.stepNames[32], command: 'chart.step.2'},
  {role: 'button', name: COPY.stepNames[64], command: 'chart.step.1'},
  {role: 'button', name: COPY.dotted, command: 'chart.dot'},
  {role: 'button', name: COPY.tuplet},
  {role: 'button', name: COMMANDS.accent, command: 'chart.accent'},
  {role: 'button', name: COMMANDS.heavy, command: 'chart.heavy'},
  {role: 'button', name: COMMANDS.ghost, command: 'chart.ghost'},
  {role: 'button', name: COMMANDS.flam, command: 'chart.flam'},
  {role: 'button', name: COMMANDS.drag, command: 'chart.drag'},
  {role: 'button', name: COPY.roll},
  {role: 'button', name: COMMANDS.stickingRight, command: 'chart.stickingRight'},
  {role: 'button', name: COMMANDS.stickingLeft, command: 'chart.stickingLeft'},
  {role: 'button', name: COPY.skip, command: 'chart.skip'},
  {role: 'button', name: COPY.grid},
  {role: 'button', name: COPY.fit, command: 'chart.fit'},
  {role: 'button', name: COPY.edit},
  {role: 'button', name: COPY.part},
]);

/** The status bar's controls, left to right (statusbar.js). */
export const STATUS_CONTROLS = Object.freeze([
  {role: 'button', name: COPY.goTo},
  {role: 'button', name: COPY.followShort, command: 'chart.follow'},
  {role: 'radiogroup', name: COPY.view},
  {role: 'radio', name: COPY.score, command: 'chart.view'},
  {role: 'radio', name: COPY.lanes, command: 'chart.view'},
  {role: 'button', name: COMMANDS.zoomOut, command: 'chart.zoomOut'},
  {role: 'button', name: COPY.zoomResetName(1), command: 'chart.zoomReset'},
  {role: 'button', name: COMMANDS.zoomIn, command: 'chart.zoomIn'},
]);

const sep = Object.freeze({type: 'separator'});

export function editMenu() {
  return [
    {command: 'chart.copy'},
    {command: 'chart.paste'},
    {command: 'chart.repeat'},
    sep,
    {command: 'chart.selectAll', kbd: 'Mod+KeyA'},
    {command: 'chart.delete'},
    sep,
    // ⌥← / ⌥→ move the selection by the step without the dialog; the menu shows the first of the pair.
    {command: 'chart.moveDialog', kbd: 'Alt+ArrowLeft'},
    {command: 'chart.tupletDialog'},
    {command: 'chart.review'},
    sep,
    {command: 'chart.loopSelection'},
    sep,
    {command: 'chart.lineBreak', type: 'checkbox'},
    {command: 'chart.clearLineBreaks'},
    sep,
    {command: 'chart.barMeter'},
    {command: 'chart.align'},
  ];
}

export function partMenu(state) {
  return [
    {command: 'chart.export'},
    {command: 'chart.print'},
    {command: 'chart.openPart'},
    {command: 'chart.importDrums'},
    {command: 'chart.clearPart'},
    sep,
    {command: 'chart.drumKeys'},
    {command: 'chart.noteList', type: 'checkbox', checked: !!state?.showList},
    {command: 'chart.allLanes', type: 'checkbox', checked: !!state?.allLanes},
    sep,
    {command: 'chart.shortcuts', kbd: '?'},
  ];
}

export function rollMenu(state, run) {
  return Object.entries(COPY.rollNames).map(([value, label]) => ({
    id: `roll-${value}`, type: 'radio', label, checked: (state?.expression?.roll || 0) === Number(value),
    run: () => run('setExpression', 'roll', Number(value)),
  }));
}

export function tupletMenu(state, run) {
  return Object.entries(COPY.tupletNames).map(([value, label]) => ({
    id: `tuplet-${value}`, type: 'radio', label, checked: state?.step.tuplet === Number(value),
    run: () => run('setTuplet', Number(value)),
  }));
}

export function gridMenu(state, run) {
  return [
    ...[4, 8, 16, 32, 64].map(v => ({
      id: `grid-${v}`, type: 'radio', label: COPY.gridValue(v), checked: state?.grid.value === v,
      run: () => run('setGrid', v, !!state?.grid.triplet),
    })),
    sep,
    {id: 'grid-triplet', type: 'checkbox', label: COPY.triplet, checked: !!state?.grid.triplet,
      run: () => run('setGrid', state?.grid.value ?? 16, !state?.grid.triplet)},
  ];
}

export function sectionsMenu(sections, run) {
  const list = (sections ?? []).map(s => ({
    id: s.id, label: COPY.sectionItem(s.label || COPY.start, s.bar + 1), run: () => run('goToBar', s.bar, {seek: true}),
  }));
  return [
    {command: 'chart.firstBar'},
    {command: 'chart.sectionPrev'},
    {command: 'chart.sectionNext'},
    {command: 'chart.lastBar'},
    ...(list.length ? [sep, ...list] : []),
  ];
}
