// Edit · Chart menus and the frame's copy (spec §5.2, maps/notation.md §12.3, architecture §3.4).
//
//   editMenu(state)          Edit ▾: Copy ⌘C, Paste ⌘V, Repeat bars… ⌘D, Select all bars (⌘A twice), Delete,
//                            Move notes… ⌥←/→, Tuplet on this beat…,
//                            Mark bars reviewed, Loop selection L, Bar meter & label…, Align in tempo map…
//   partMenu(state)          Part ▾: Export .woodshed.json, Print, Open .woodshed.json part…, Drum part from file…,
//                            Clear drum chart…,
//                            Drum keys…, Note list ✓, Show every kit piece ✓ (Lanes only), Keyboard shortcuts ?
//   viewMenu(state)          View ▾: Score · Lanes, Pages · Continuous (the modes the editor offers, D48), Follow playback
//   tupletMenu(state, run)   Tuplet ▾: Straight, Triplet, Quintuplet, Sextuplet, Septuplet
//   gridMenu(state, run)     Grid ▾ (Lanes): 1/4 … 1/64 and Triplet
//   sectionsMenu(sections, run)   the section jump menu: Intro · Bar 1, Verse · Bar 5, …
//
// Every item that has a command takes its label, key-cap, enabled state and disabled reason from the registry
// (src/ui/menu.js resolveItem); radio items with arguments carry their own `checked` (the registry evaluates
// `checked` without arguments). COPY holds the frame's strings; CONTROLS lists the toolbar's controls
// (role, accessible name, command) for the table-driven test (§9.0).

import {COPY as COMMANDS} from './commands.js';

export const COPY = Object.freeze({
  toolbar: 'Chart tools',
  view: 'View',
  viewOptions: 'View options',
  score: 'Score',
  lanes: 'Lanes',
  steps: 'Step',
  stepNames: Object.freeze({4: 'Quarter step', 8: 'Eighth step', 16: 'Sixteenth step', 32: '32nd step', 64: '64th step'}),
  stepLabels: Object.freeze({4: '♩ 1/4', 8: '♪ 1/8', 16: '1/16', 32: '1/32', 64: '1/64'}),
  dotted: 'Dotted',
  tuplet: 'Tuplet',
  tupletNames: Object.freeze({1: 'Straight', 3: 'Triplet', 5: 'Quintuplet', 6: 'Sextuplet', 7: 'Septuplet'}),
  skip: 'Skip',
  writing: 'Writing:',
  undo: 'Undo',
  redo: 'Redo',
  bars: (first, last) => (first === last ? `Bar ${first}` : `Bars ${first}–${last}`),
  barsOf: (first, last, total) => `${first === last ? `Bar ${first}` : `Bars ${first}–${last}`} of ${total}`,
  sections: 'Sections',
  sectionItem: (label, bar) => `${label} · Bar ${bar}`,
  edit: 'Edit',
  part: 'Part',
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
  importing: 'Importing the drum part…',
  imported: (count, skipped, replaced = false) => `${replaced ? 'Replaced the drum chart with' : 'Imported'} ${count} note${count === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped` : ''}. Undo restores the ${replaced ? 'previous chart' : 'empty part'}.`,
  importFailed: 'That file could not be imported.',
  importAccept: '.gp,.gp3,.gp4,.gp5,.gpx,.gp7,.mid,.midi,.chart,.json,.woodshed.json,.txt',
});

/** The toolbar's controls (role, accessible name, command when it runs one). */
export const CONTROLS = Object.freeze([
  {role: 'radiogroup', name: COPY.view},
  {role: 'radio', name: COPY.score, command: 'chart.view'},
  {role: 'radio', name: COPY.lanes, command: 'chart.view'},
  {role: 'button', name: COPY.viewOptions},
  {role: 'button', name: COPY.stepNames[4], command: 'chart.step.5'},
  {role: 'button', name: COPY.stepNames[8], command: 'chart.step.4'},
  {role: 'button', name: COPY.stepNames[16], command: 'chart.step.3'},
  {role: 'button', name: COPY.stepNames[32], command: 'chart.step.2'},
  {role: 'button', name: COPY.stepNames[64], command: 'chart.step.1'},
  {role: 'button', name: COPY.dotted, command: 'chart.dot'},
  {role: 'button', name: COPY.tuplet},
  {role: 'button', name: COPY.skip, command: 'chart.skip'},
  {role: 'button', name: COPY.undo, command: 'chart.undo'},
  {role: 'button', name: COPY.redo, command: 'chart.redo'},
  {role: 'button', name: COMMANDS.pagePrev, command: 'chart.pagePrev'},
  {role: 'button', name: COMMANDS.pageNext, command: 'chart.pageNext'},
  {role: 'button', name: COPY.sections},
  {role: 'button', name: COPY.edit},
  {role: 'button', name: COPY.part},
  {role: 'button', name: COPY.grid},
  {role: 'button', name: COPY.fit, command: 'chart.fit'},
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

export function viewMenu(state) {
  // Pages · Continuous (D48) appears once the workspace offers more than one paging mode.
  const modes = (state?.pagingModes ?? ['pages']).filter(m => m === 'pages' || m === 'scroll');
  const paging = modes.length > 1 ? [sep, ...modes.map(m => ({
    command: 'chart.paging', type: 'radio', label: COMMANDS[m], args: {paging: m}, checked: state?.paging === m,
  }))] : [];
  return [
    {command: 'chart.view', type: 'radio', label: COPY.score, args: {view: 'score'}, checked: state?.layout === 'score'},
    {command: 'chart.view', type: 'radio', label: COPY.lanes, args: {view: 'lanes'}, checked: state?.layout === 'lanes'},
    ...paging,
    sep,
    {command: 'chart.follow', type: 'checkbox', checked: !!state?.follow},
  ];
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
  return (sections ?? []).map(s => ({
    id: s.id, label: COPY.sectionItem(s.label, s.bar + 1), run: () => run('goToBar', s.bar),
  }));
}
