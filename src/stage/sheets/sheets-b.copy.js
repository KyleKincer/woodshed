// Copy and controls for the Stage's Spots list, Notes card, Tap the beat sheet and Get bars popover
// (architecture §9.0 "Copy and controls tables", §2.14.11, §4.6; spec §4.4C, §4.7, §5.1.3). Pure: no
// DOM and no imports beyond shared formatters, so the sheets, the tests and the harness read it freely.
//
//   COPY       every user-visible string of sheets/{spots,notes,tap-beat,get-bars}.js
//   CONTROLS   [{sheet, role, name, command?, when?}]: the sheets' own controls (the table-driven test
//              renders each sheet and finds every row by role and accessible name)
//   formatDownbeat(seconds)   'm:ss.ss' (the Tap the beat result: "first downbeat 0:00.41")

import {formatClock} from '../../../shared/practice.ts';

const pct = (rate) => `${Math.round((Number(rate) || 0) * 100)}%`;
const times = (n) => (n === 1 ? '1 time' : `${n} times`);
const taps = (n) => (n === 1 ? '1 tap' : `${n} taps`);

/** Seconds as 'm:ss.ss', rounded to the hundredth: 0.413 → '0:00.41', 72.5 → '1:12.50'. */
export function formatDownbeat(seconds) {
  const hundredths = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 100));
  const whole = Math.floor(hundredths / 100);
  return `${formatClock(whole)}.${String(hundredths % 100).padStart(2, '0')}`;
}

export const COPY = Object.freeze({
  // ---- Spots list (spec §4.7: "name · bars 41–48 · 85% · practised 2 days ago · 14 times · ▶") ----
  spots: Object.freeze({
    list: 'Saved spots',
    emptyTitle: 'No spots yet',
    emptyBody: 'Loop a passage and save it as a spot to come back to it at the same speed.',
    save: 'Save spot',
    bars: (x, y) => {
      const name = (n) => (n === null ? 'pickup' : String(n));
      if (x === y) return x === null ? 'pickup' : `bar ${x}`;
      return x === null ? `pickup–bar ${y}` : `bars ${name(x)}–${name(y)}`;
    },
    rate: pct,
    practised: (when, passes) => {
      const n = Math.max(0, Math.floor(Number(passes) || 0));
      if (when && n) return `practised ${when} · ${times(n)}`;
      if (when) return `practised ${when}`;
      if (n) return times(n);
      return 'not practised yet';
    },
    active: 'Looping now',
    play: (name) => `Play ${name}`,
    more: (name) => `More for ${name}`,
    actions: (name) => `Actions for ${name}`,
    rename: 'Rename',
    update: 'Update from current',
    delete: 'Delete',
    nameLabel: 'Spot name',
    renamed: (from, to) => `Renamed ${from} to ${to}`,
    updated: (name, rate) => `Updated ${name} · ${pct(rate)}`,
    needsLoop: 'Turn on a loop to update a spot from it.',
    deleted: (name) => `Deleted spot ${name}`,
    undo: 'Undo',
    describeRename: (from, to) => `rename spot ${from} → ${to}`,
    describeUpdate: (name) => `update spot ${name}`,
    describeDelete: (name) => `delete spot ${name}`,
    describeRestore: (name) => `restore spot ${name}`,
    restored: (name) => `Restored spot ${name}`,
    readOnly: 'Spots you change here stay on this device.',
  }),

  // ---- Notes card (spec §4.7: practice notes, key, tuning and tags; 17 px) ----
  notes: Object.freeze({
    region: 'Song notes',
    empty: 'No notes for this song yet.',
    editHint: 'Add notes, key, tuning and tags in Edit details.',
    edit: 'Edit details',
    key: 'Key',
    tuning: 'Tuning',
    tags: 'Tags',
    spotNote: (name) => `Spot · ${name}`,
  }),

  // ---- Tap the beat (spec §5.1.3, architecture §4.6) ----
  tap: Object.freeze({
    intro: 'Play the song and tap every beat for 2 bars.',
    pad: 'Tap',
    padLabel: 'Tap the beat',
    padHint: 'T or Space',
    waiting: 'Waiting for taps',
    notPlaying: 'Press Play, then tap along.',
    live: (bpm, n) => (Number.isFinite(bpm) ? `≈ ${bpm} bpm · ${taps(n)}` : taps(n)),
    tooFew: 'Tap at least 4 beats.',
    result: (bpm, meter, downbeat) => `${bpm} bpm · ${meter} · first downbeat ${formatDownbeat(downbeat)}`,
    replaces: 'This replaces the song’s bar grid. You can undo it.',
    useIt: 'Use it',
    tryAgain: 'Try again',
    openEditor: 'Open map editor',
    label: 'Tap the beat',
    applied: (bpm) => `Bars from your taps · ${bpm} bpm`,
    refused: 'Couldn’t use these bars right now.',
    undo: 'Undo',
  }),

  // ---- Get bars (spec §4.4C, §5.1.1) ----
  getBars: Object.freeze({
    unmapped: 'No bar grid yet, so times are in seconds.',
    mapped: 'Replace this song’s bar grid. Every change can be undone.',
    tap: 'Tap the beat…',
    tapBody: 'Play the song and tap along. Works on every device.',
    detect: 'Detect beats',
    detectBody: 'Listens to the recording and places every bar and beat. About 30 s on this computer.',
    detectGeneric: 'Listens to the recording and places every bar and beat.',
    detectRemote: (name) => `Listens to the recording and places every bar and beat. Runs on ${name}.`,
    detectRemoteUnnamed: 'Listens to the recording and places every bar and beat. Runs on your computer.',
    getDesktop: 'Get Woodshed for desktop',
    find: 'Find a chart…',
    findBody: 'Search Chorus Encore and the Harmonix set, or import a file.',
    starting: 'Starting…',
    found: 'Beat grid found',
    retry: 'Try again',
    progress: 'Finding bars',
  }),
});

/**
 * The sheets' own controls. `when` names the state the row needs: 'spot' (a spot exists),
 * 'owner' (a writable song), 'result' (a finished tap), 'web' (no desktop, no paired computer),
 * 'menu' (a row's ⋯ menu open), 'tray' (a row's swipe tray open), 'rename' (a row being renamed),
 * 'failed' (a detection that failed).
 */
export const CONTROLS = Object.freeze([
  {sheet: 'spots', role: 'list', name: COPY.spots.list, when: 'spot'},
  {sheet: 'spots', role: 'button', name: 'Bridge walk-up', when: 'spot'},
  {sheet: 'spots', role: 'button', name: COPY.spots.more('Bridge walk-up'), when: 'spot'},
  {sheet: 'spots', role: 'button', name: COPY.spots.save, command: 'spot.save'},
  {sheet: 'spots', role: 'menuitem', name: COPY.spots.rename, when: 'menu'},
  {sheet: 'spots', role: 'menuitem', name: COPY.spots.update, when: 'menu'},
  {sheet: 'spots', role: 'menuitem', name: COPY.spots.delete, when: 'menu'},
  {sheet: 'spots', role: 'button', name: COPY.spots.rename, when: 'tray'},
  {sheet: 'spots', role: 'button', name: COPY.spots.update, when: 'tray'},
  {sheet: 'spots', role: 'button', name: COPY.spots.delete, when: 'tray'},
  {sheet: 'spots', role: 'textbox', name: COPY.spots.nameLabel, when: 'rename'},
  {sheet: 'notes', role: 'region', name: COPY.notes.region},
  {sheet: 'notes', role: 'button', name: COPY.notes.edit, command: 'edit.details', when: 'owner'},
  {sheet: 'tapBeat', role: 'button', name: COPY.tap.padLabel},
  {sheet: 'tapBeat', role: 'button', name: 'Play', command: 'transport.playStop'},
  {sheet: 'tapBeat', role: 'button', name: COPY.tap.useIt, when: 'result'},
  {sheet: 'tapBeat', role: 'button', name: COPY.tap.tryAgain, when: 'result'},
  {sheet: 'tapBeat', role: 'button', name: COPY.tap.openEditor, command: 'edit.map', when: 'result'},
  {sheet: 'getBars', role: 'button', name: COPY.getBars.tap, command: 'stage.tapBeat'},
  {sheet: 'getBars', role: 'button', name: COPY.getBars.detect, command: 'map.detect'},
  {sheet: 'getBars', role: 'button', name: COPY.getBars.find, command: 'map.find'},
  {sheet: 'getBars', role: 'link', name: COPY.getBars.getDesktop, when: 'web'},
  {sheet: 'getBars', role: 'button', name: COPY.getBars.retry, when: 'failed'},
]);
