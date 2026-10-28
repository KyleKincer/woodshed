// The Stage frame's copy and controls tables (architecture §9.0 "Copy and controls tables"; spec
// §4, Appendix A). Pure: no DOM, no imports beyond the shared clock formatter, so the commands
// module (D46) and the tests read it freely.
//
//   COPY       every user-visible string of stage.js, commands.js, review-banner.js and sheets/host.js
//   CONTROLS   the frame's own controls: [{where, role, name, command?}] (the table-driven test renders each)
//   loadingLabel(load)               the Play ring's line while the audio loads (spec §4.12 step 3)
//   resumeText({where, rate, mix})   the resume chip's parts (spec Appendix A)
//   mixWord({minusMe, onlyMe, mine, muted})   'Drums out' | 'Only drums' | 'Bass out' | ''

import {formatClock} from '../../shared/practice.ts';

const pct = (rate) => `${Math.round((Number(rate) || 0) * 100)}%`;
const titled = (name) => {
  const s = String(name ?? '');
  const labels = {drums: 'Drums', bass: 'Bass', guitar: 'Guitar', piano: 'Piano', vocals: 'Vocals', other: 'Other'};
  return labels[s.toLowerCase()] ?? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
};
const list = (names) => {
  const words = names.map(titled);
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} & ${words.at(-1)}`;
};

export const COPY = Object.freeze({
  region: 'Stage',
  music: 'Music',
  hudRegion: 'Now playing',
  transport: 'Transport',
  status: 'Status',
  // Leaving (spec §4.9).
  leave: 'Back to Library',
  close: 'Close Song',
  holdHint: 'Hold to leave — playback will stop',
  // Resume (spec §4.12, Appendix A).
  backAt: 'Back at',
  startOver: 'Start over',
  startedOver: 'Started over',
  // Loading (spec §4.12 step 3).
  loadingAudio: (percent) => (Number.isFinite(percent) ? `Loading audio ${percent}%` : 'Loading audio'),
  decoding: (n, of) => `Decoding ${n} of ${of}`,
  preparing: 'Preparing pitch-preserving playback',
  openingSong: 'Opening the song',
  // Load errors (spec §4.12, §3.6).
  loadFailed: 'Couldn’t load the audio for this song.',
  storageFailed: 'Couldn’t reach storage for this song’s audio.',
  missing: (names) => `Missing stem audio for ${list(names)}.`,
  codec: 'This browser can’t play Woodshed’s audio format. Use Chrome, Edge, Firefox or Safari 15 or later.',
  tryAgain: 'Try again',
  resplit: 'Re-split',
  resplitWeb: 'Re-split it from Woodshed for desktop.',
  details: 'Details',
  copyDetails: 'Copy',
  copied: 'Copied',
  notFound: 'This song isn’t here any more. It may have been deleted.',
  notFoundTitle: 'Song not found',
  controlsUnavailable: 'Playback is unavailable until the audio loads.',
  // Surfaces (spec §4.4).
  surfaces: Object.freeze({chart: 'Chart', roadmap: 'Road map', wave: 'Wave page', stems: 'Stems'}),
  notBuilt: 'Not built yet',
  surfaceLater: (name) => `The ${name} view arrives in a later build.`,
  sheetLater: 'This panel arrives in a later build.',
  // Glass (spec §4.9).
  playFromBar: (n) => `Play from bar ${n}`,
  playFromTime: (t) => `Play from ${formatClock(t)}`,
  // Undo (spec §4.14).
  redo: 'Redo',
  undo: 'Undo',
  nothingToUndo: 'Nothing to undo',
  nothingToRedo: 'Nothing to redo',
  // Markers, sections and spots (§4.5, Appendix A).
  markerAdded: (label) => `${label} added`,
  sectionAdded: (label) => `${label} added`,
  alreadyStarts: (bar, name) => `${bar === null ? 'The pickup' : `Bar ${bar}`} already starts ${name}`,
  rename: 'Rename',
  renameMarker: 'Rename marker',
  renameSection: 'Rename section',
  nameLabel: 'Name',
  save: 'Save',
  addSection: 'Add section',
  spotSaved: (name, rate) => `Saved spot ${name} · ${pct(rate)}`,
  spotMissing: 'That spot isn’t in this song any more.',
  spotsFull: 'This song already has 24 spots. Delete one to save another.',
  // Setlists (B3).
  setLine: (name, i, n) => `${name} · ${i} of ${n}`,
  setEnd: 'Last song in this set',
  setStart: 'First song in this set',
  // Read-only and later-build reasons.
  readOnly: 'Shared songs are read-only. Add it to your library to change it.',
  resplitDesktop: 'Re-split from Woodshed for desktop.',
  // The recording check (D43, spec §3.5).
  reviewQuestion: 'Is this the right recording?',
  reviewYes: 'Yes',
  reviewWrong: 'Wrong song — search again',
  reviewDelete: 'Delete this one',
  reviewDismiss: 'Not now',
  reviewThanks: 'Thanks — recording confirmed',
  reviewFailed: 'Couldn’t save that. Try again in a moment.',
  deleteTitle: (title) => `Delete “${title}”?`,
  deleteBody: 'Its stems and charts are removed from your library. Shared links stop working.',
  deleteConfirm: 'Delete song',
  deleteFailed: 'Couldn’t delete the song. Try again in a moment.',
  deleted: (title) => `Deleted ${title}`,
  // The detection offer's second action (D44).
  notNow: 'Not now',
  dismiss: 'Dismiss',
  // Sheets (§2.14.11).
  sheets: Object.freeze({
    speed: 'Speed & trainer', click: 'Click & count-in', mix: 'Mix', loop: 'Loop',
    spots: 'Spots', notes: 'Notes', tapBeat: 'Tap the beat', getBars: 'Get bars',
  }),
  // The accessible names of the music's target menus (spec §8 "Defined menus"); the others are "More…".
  menuLabels: Object.freeze({spot: 'Spot', marker: 'Marker', loopBand: 'Loop', stem: 'Stem'}),
  // Command titles (§3.2).
  commands: Object.freeze({
    markerAdd: 'Add marker at playhead',
    sectionAdd: 'Add section at playhead',
    markerAddGeneric: 'Add marker (section when mapped) at playhead',
    spotSave: 'Save spot',
    spotList: 'Spots',
    spotOpen: (name) => (name ? `Open spot ${name}` : 'Open spot'),
    menu: 'More…',
    resplit: 'Re-split…',
    detect: 'Detect beats',
    find: 'Find a chart…',
    suggest: 'Suggest sections',
    keepAll: 'Keep suggested sections',
    review: 'Review suggested sections',
    viewCycle: 'Next view',
    viewChart: 'Chart',
    viewRoadmap: 'Road map',
    viewStems: 'Stems',
    focus: 'Focus',
    focusResume: 'Back to playhead',
    distance: (name) => `Distance: ${name}`,
    bigger: 'Larger chart',
    smaller: 'Smaller chart',
    biggerWave: 'Longer rows',
    smallerWave: 'Shorter rows',
    biggerStems: 'Zoom in',
    smallerStems: 'Zoom out',
    followResume: 'Back to playhead',
    display: 'Display: Together / Hands & feet',
    followStyle: 'Follow: Scroll / Page',
    scrollUp: 'Scroll up one screen',
    scrollDown: 'Scroll down one screen',
    scrollTop: 'Scroll to top',
    notes: 'Notes',
    tapBeat: 'Tap the beat…',
    getBars: 'Get bars…',
    share: 'Share…',
    startOver: 'Start over',
    leave: 'Back to Library',
    close: 'Close Song',
    edit: 'Edit',
    editMap: 'Edit map',
    editChart: 'Edit drum chart',
    editDetails: 'Edit details',
    undo: 'Undo',
    redo: 'Redo',
    setNext: 'Next song in set',
    setPrev: 'Previous song in set',
  }),
  distances: Object.freeze({near: 'Near', stand: 'Stand', kit: 'Kit'}),
});

/** The frame's own controls (stage.js, review-banner.js): role and accessible name per state. */
export const CONTROLS = Object.freeze([
  {where: 'resume', role: 'button', name: COPY.startOver, command: 'stage.startOver'},
  {where: 'load-error', role: 'button', name: COPY.tryAgain},
  {where: 'load-error-missing', role: 'button', name: COPY.resplit, command: 'song.resplit'},
  {where: 'not-found', role: 'link', name: COPY.leave},
  {where: 'review', role: 'button', name: COPY.reviewYes},
  {where: 'review', role: 'button', name: COPY.reviewWrong},
  {where: 'review', role: 'button', name: COPY.reviewDelete},
  {where: 'review', role: 'button', name: COPY.reviewDismiss},
  {where: 'detect-offer', role: 'button', name: COPY.notNow},
  {where: 'surface', role: 'region', name: COPY.music},
  {where: 'status', role: 'status', name: COPY.status},
]);

/** The Play ring's line while the audio loads (spec §4.12 step 3), or '' once ready or failed. */
export function loadingLabel(load) {
  const phase = load?.phase;
  if (phase === 'song' || phase === 'signing') return COPY.openingSong;
  if (phase === 'loading') {
    const total = Number(load.totalBytes), done = Number(load.loadedBytes);
    return COPY.loadingAudio(total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : undefined);
  }
  if (phase === 'decoding') {
    const of = Math.max(1, Number(load.tracks) || 1);
    return COPY.decoding(Math.max(1, Math.min(of, (Number(load.decoded) || 0) + 1)), of);
  }
  if (phase === 'preparing') return COPY.preparing;
  return '';
}

/** 'Drums out' (Minus me), 'Only drums' (Only me), 'Bass out' (muted by hand), or '' for the full mix. */
export function mixWord({minusMe = false, onlyMe = false, mine = [], muted = []} = {}) {
  if (onlyMe && mine.length) return `Only ${list(mine).toLowerCase()}`;
  if (minusMe && mine.length) return `${list(mine)} out`;
  if (muted.length) return `${list(muted)} out`;
  return '';
}

/** The resume chip (spec Appendix A): "Back at **{where}** · {rate}% · {mix}". */
export function resumeText({where, rate = 1, mix = ''} = {}) {
  const rest = [pct(rate), mix].filter(Boolean).join(' · ');
  return {lead: COPY.backAt, strong: String(where ?? ''), rest, text: `${COPY.backAt} ${where} · ${rest}`};
}
