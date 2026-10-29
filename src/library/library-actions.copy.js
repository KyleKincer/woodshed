// Copy and controls for the Library's actions (architecture §2.16, §9.0; spec §2.5, §2.6, §3.7, §7.8): the card menu
// and the selection menu, selection mode and its floating bar, the bulk delete Dialog, pins, "Add to setlist ▸", the
// Re-split dialog and the setlist page (/set/:id). Strings only; card-menu.js, selection.js, resplit-dialog.js and
// setlist-page.js read them, and the table-driven tests render every CONTROLS row with its role and accessible name.

/** The Undo window of a pin, an unpin, an add to a setlist and a removal from one (spec §7.8). */
export const UNDO_MS = 8000;
/** Selection mode's cap (spec §2.6), worded COPY.cap. The bulk Details route takes at most this many ids (D34). */
export const MAX_SELECTION = 100;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quoted = title => `“${title || 'Untitled'}”`;

export const COPY = Object.freeze({
  // ---- the card menu (spec §2.5; Select first, D49) ----
  select: 'Select',
  practice: 'Practice',
  editDetails: 'Edit details…',
  editChart: 'Edit chart',
  editMap: 'Edit map',
  pin: 'Pin',
  unpin: 'Unpin',
  share: 'Share…',
  addToSetlist: 'Add to setlist',
  newSetlist: 'New setlist…',
  resplit: 'Re-split…',
  openSource: 'Open original source',
  delete: 'Delete…',
  /** Disabled reasons, shown under the item (Menu `reason`). */
  needsDesktop: 'Needs Woodshed for desktop',
  pausedAccount: 'Paused on this account',
  notBuilt: 'Not built yet',
  inSetlist: 'Already in this list',
  setlistFull: 'This list is full',
  setlistsFull: 'You have 100 setlists',

  // ---- the selection menu: the card menu of a selected card while selecting (spec §7.7) ----
  editDetailsMany: n => (n === 1 ? 'Edit details…' : `Edit details of ${n} songs…`),
  pinMany: n => (n === 1 ? 'Pin' : `Pin ${n} songs`),
  unpinMany: n => (n === 1 ? 'Unpin' : `Unpin ${n} songs`),
  resplitMany: n => (n === 1 ? 'Re-split…' : `Re-split ${n} songs…`),
  deleteMany: n => (n === 1 ? 'Delete…' : `Delete ${n} songs…`),
  deselect: 'Deselect',
  done: 'Done',

  // ---- selection mode and its floating bar (spec §2.6) ----
  barLabel: 'Selected songs',
  selected: n => `${n} selected`,
  noneSelected: 'Select songs',
  barEditDetails: 'Edit details',
  barPin: 'Pin',
  barUnpin: 'Unpin',
  barResplit: 'Re-split',
  barDelete: 'Delete',
  barDone: 'Done',
  cap: `Up to ${MAX_SELECTION} at a time`,
  /** Announced when selection mode starts and ends. */
  selectingOn: 'Selecting songs. Press Escape when you’re done.',
  selectingOff: 'Done selecting',

  // ---- delete (spec §2.6, the bulk Dialog; one song from the card menu) ----
  deleteTitleOne: title => `Delete ${quoted(title)}?`,
  deleteTitle: n => `Delete ${n} songs?`,
  deleteBodyOne: 'Its stems and chart are removed from your library. Shared links stop working.',
  deleteBody: 'Their stems and charts are removed from your library. Shared links stop working.',
  deleteConfirmOne: 'Delete song',
  deleteConfirm: n => `Delete ${n} songs`,
  deleting: (i, n) => `Deleting ${i} of ${n}…`,
  deletedOne: title => `Deleted ${quoted(title)}`,
  deleted: n => `Deleted ${plural(n, 'song')}`,
  deletePartial: (done, total) => `Deleted ${done} of ${total} songs. ${plural(total - done, 'song')} couldn’t be deleted.`,
  deleteFailedOne: title => `${quoted(title)} couldn’t be deleted.`,
  deleteFailedNamed: titles => `Not deleted: ${titles.join(', ')}.`,
  details: 'Details',

  // ---- pins (8 s Undo toast, spec §7.8) ----
  pinnedOne: title => `Pinned ${quoted(title)}`,
  pinned: n => `Pinned ${plural(n, 'song')}`,
  unpinnedOne: title => `Unpinned ${quoted(title)}`,
  unpinned: n => `Unpinned ${plural(n, 'song')}`,
  pinsRoom: (max, room) => (room <= 0 ? `Up to ${max} pins` : `Up to ${max} pins: there’s room for ${plural(room, 'more song')}`),
  undo: 'Undo',

  // ---- add to setlist (8 s Undo toast) ----
  setlistRow: (name, count) => `${name} · ${plural(count, 'song')}`,
  newSetlistTitle: 'New setlist',
  newSetlistBody: n => (n === 1 ? 'The song is added to the new list.' : `The ${n} songs are added to the new list.`),
  newSetlistName: 'Name',
  newSetlistPlaceholder: 'Thursday rehearsal',
  newSetlistSubmit: 'Create',
  addedOne: (title, name) => `Added ${quoted(title)} to ${name}`,
  added: (n, name) => `Added ${plural(n, 'song')} to ${name}`,
  alreadyIn: name => `Already in ${name}`,
  createdWith: (name, n) => `Created ${name} with ${plural(n, 'song')}`,

  // ---- the Re-split dialog (spec §3.7) ----
  resplitTitle: title => `Re-split ${title || 'Untitled'}`,
  resplitTitleMany: n => `Re-split ${n} songs`,
  stems: 'Stems',
  quality: 'Quality',
  stemModes: Object.freeze({full: '4 stems', six: '6 stems', drums: 'Drums + rest', vocals: 'Vocals + rest', bass: 'Bass + rest'}),
  presets: Object.freeze({fast: 'Fast', balanced: 'Balanced', studio: 'Studio', custom: 'Custom'}),
  thisComputer: 'this computer',
  /** "Runs on MacBook Pro · about 4 min at Balanced · replaces the stems; your loops, map, spots and chart are kept." */
  cost: ({device, minutes, quality, many = false}) =>
    `Runs on ${device} · ${minutes ? `about ${minutes} min at ${quality}` : `${quality} quality`} · `
    + (many ? 'replaces their stems; your loops, maps, spots and charts are kept.' : 'replaces the stems; your loops, map, spots and chart are kept.'),
  resplitConfirm: 'Re-split',
  resplitCancel: 'Cancel',
  resplitStartedOne: title => `Re-splitting ${quoted(title)}`,
  resplitStarted: n => `Re-splitting ${plural(n, 'song')}`,
  resplitPartial: (done, total) => `Re-splitting ${done} of ${total} songs.`,
  resplitNotStarted: titles => `Not started: ${titles.join(', ')}.`,
  resplitQueueFull: 'The queue is full: process the queued songs before adding more.',
  resplitGone: 'This song is no longer in your library.',

  // ---- the setlist page (/set/:id) ----
  backToLibrary: 'Library',
  setlistKicker: 'Setlist',
  setlistCount: n => plural(n, 'song'),
  setlistLength: seconds => {
    const m = Math.round((Number(seconds) || 0) / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  },
  play: 'Play from the top',
  rename: 'Rename',
  renameLabel: 'Setlist name',
  renameSave: 'Save',
  renameCancel: 'Cancel',
  deleteSetlist: 'Delete setlist…',
  deleteSetlistTitle: name => `Delete ${quoted(name)}?`,
  deleteSetlistBody: 'The list goes away. Its songs stay in your library.',
  deleteSetlistConfirm: 'Delete setlist',
  deletedSetlist: name => `Deleted ${quoted(name)}`,
  songsLabel: name => `Songs in ${name}`,
  position: (i, n) => `${i} of ${n}`,
  moveHandle: title => `Move ${title || 'Untitled'}`,
  moveHint: 'Drag, or press Alt+Up / Alt+Down',
  moveUp: 'Move up',
  moveDown: 'Move down',
  moved: (title, i, n) => `${title || 'Untitled'} moved to ${i} of ${n}`,
  removeSong: (title, name) => `Remove ${title || 'Untitled'} from ${name}`,
  removedOne: (title, name) => `Removed ${quoted(title)} from ${name}`,
  openSong: title => `Practise ${title || 'Untitled'}`,
  emptyTitle: 'No songs in this list yet',
  emptyBody: 'Add songs from a song’s ⋯ menu in the Library: Add to setlist.',
  emptyAction: 'Go to the Library',
  missingTitle: 'This setlist isn’t here',
  missingBody: 'It was deleted, or it belongs to another account.',
  missingAction: 'Back to the Library',
  loading: 'Loading the setlist…',
  readOnly: 'Changing setlists is paused on this account.',
  untitled: 'Untitled setlist',
});

/**
 * Every control these modules render, with its role and accessible name (§9.0; the table-driven tests render each row).
 * `where`: the surface. `title` is the sample song ("Harbor Lights"), `name` the sample list ("Friday at the Grange").
 */
const T = 'Harbor Lights';
const N = 'Friday at the Grange';
export const CONTROLS = Object.freeze([
  // card menu (desktop, a song with a chart and an http source; spec §2.5)
  {where: 'card-menu', role: 'menuitem', name: COPY.select},
  {where: 'card-menu', role: 'menuitem', name: COPY.practice},
  {where: 'card-menu', role: 'menuitem', name: COPY.editDetails},
  {where: 'card-menu', role: 'menuitem', name: COPY.editChart},
  {where: 'card-menu', role: 'menuitem', name: COPY.editMap},
  {where: 'card-menu', role: 'menuitem', name: COPY.pin},
  {where: 'card-menu', role: 'menuitem', name: COPY.share},
  {where: 'card-menu', role: 'menuitem', name: COPY.addToSetlist},
  {where: 'card-menu', role: 'menuitem', name: COPY.resplit},
  {where: 'card-menu', role: 'menuitem', name: COPY.openSource},
  {where: 'card-menu', role: 'menuitem', name: COPY.delete},
  // "Add to setlist ▸" (the submenu)
  {where: 'setlist-submenu', role: 'menuitem', name: COPY.setlistRow(N, 5)},
  {where: 'setlist-submenu', role: 'menuitem', name: COPY.newSetlist},
  // the floating bar (spec §2.6)
  {where: 'bar', role: 'toolbar', name: COPY.barLabel},
  {where: 'bar', role: 'button', name: COPY.barEditDetails},
  {where: 'bar', role: 'button', name: COPY.barPin},
  {where: 'bar', role: 'button', name: COPY.barResplit},
  {where: 'bar', role: 'button', name: COPY.barDelete},
  {where: 'bar', role: 'button', name: COPY.barDone},
  // the bulk delete Dialog
  {where: 'delete-dialog', role: 'dialog', name: COPY.deleteTitle(3)},
  {where: 'delete-dialog', role: 'button', name: 'Cancel'},
  {where: 'delete-dialog', role: 'button', name: COPY.deleteConfirm(3)},
  // the Re-split dialog (spec §3.7)
  {where: 'resplit-dialog', role: 'dialog', name: COPY.resplitTitle(T)},
  {where: 'resplit-dialog', role: 'radiogroup', name: COPY.stems},
  {where: 'resplit-dialog', role: 'radiogroup', name: COPY.quality},
  {where: 'resplit-dialog', role: 'button', name: COPY.resplitCancel},
  {where: 'resplit-dialog', role: 'button', name: COPY.resplitConfirm},
  // the setlist page
  {where: 'setlist-page', role: 'link', name: COPY.backToLibrary},
  {where: 'setlist-page', role: 'button', name: COPY.play},
  {where: 'setlist-page', role: 'button', name: COPY.rename},
  {where: 'setlist-page', role: 'button', name: COPY.deleteSetlist},
  {where: 'setlist-page', role: 'list', name: COPY.songsLabel(N)},
  {where: 'setlist-page', role: 'link', name: COPY.openSong(T)},
  {where: 'setlist-page', role: 'button', name: COPY.moveHandle(T)},
  {where: 'setlist-page', role: 'button', name: COPY.removeSong(T, N)},
]);
