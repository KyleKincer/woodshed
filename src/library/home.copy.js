// Copy and controls of the Library home (spec §2.2–2.4 and §2.7; architecture §9.0 copy tables).
// home.js, cards.js, continue.js, first-run.js and setlists.js read their strings from here;
// tests/library-home.test.js renders every CONTROLS row and checks its role and accessible name.

export const COPY = Object.freeze({
  // sections
  continue: 'Continue',
  setlists: 'Setlists',
  pinned: 'Pinned',
  library: 'Library',
  libraryCount: (shown, total) => (shown === total ? String(total) : `${shown} of ${total}`),
  libraryCountLabel: (shown, total) => (shown === total ? `${total} ${total === 1 ? 'song' : 'songs'}` : `${shown} of ${total} songs`),
  adding: 'Adding',
  songsDivider: 'Songs',   // closes the Adding group when Group is None

  // Continue
  resume: 'Resume',
  resumeLabel: title => `Resume ${title}`,
  startOver: 'Start from top',
  startOverLabel: title => `Start ${title} from the top`,
  spots: 'Spots',
  recents: 'Recently practised',

  // header controls
  filterGroup: 'Filter songs',
  filters: Object.freeze({chart: 'Has chart', mapped: 'Mapped', spots: 'Has spots', review: 'Needs review', processing: 'Processing', failed: 'Failed'}),
  filterWithCount: (label, n) => `${label} ${n}`,
  sort: 'Sort',
  sortButton: label => `Sort: ${label}`,
  sorts: Object.freeze({practised: 'Recently practised', added: 'Recently added', title: 'Title', artist: 'Artist', album: 'Album', duration: 'Duration', bpm: 'BPM', key: 'Key'}),
  reverse: 'Reverse order',
  select: 'Select',
  group: 'Group',
  groupButton: label => (label ? `Group: ${label}` : 'Group'),
  groups: Object.freeze({none: 'None', album: 'Album', artist: 'Artist'}),
  view: 'View',
  grid: 'Grid',
  list: 'List',
  drillArtist: name => `Artist: ${name}`,
  drillAlbum: name => `Album: ${name}`,
  removeDrill: label => `Remove ${label}`,
  unknownAlbum: 'Unknown album',
  unknownArtist: 'Unknown artist',
  groupCount: n => `${n} ${n === 1 ? 'song' : 'songs'}`,

  // list view
  listLabel: 'Songs',
  columns: Object.freeze({title: 'Title', album: 'Album', key: 'Key', bpm: 'BPM', duration: 'Length', practised: 'Practised'}),

  // cards
  more: title => `More for ${title}`,
  openArtist: name => `Show songs by ${name}`,
  openAlbum: name => `Show songs from ${name}`,
  newSong: 'New',
  job: (title, line) => `${title}, ${line}`,
  tryAgain: 'Try again',
  details: 'Details',
  jobDetails: title => `Details for ${title}`,
  setlistCount: n => `${n} ${n === 1 ? 'song' : 'songs'}`,

  // edge states
  noResultsTitle: 'No matches',
  noResults: q => ['No songs match “', {strong: q}, '”.'],
  clearSearch: 'Clear search',
  addAsNew: q => `Add “${q}” as a new song`,
  emptyFilter: Object.freeze({
    chart: 'No songs with a drum chart yet. Find one from a song’s Edit · Map, or write one in Edit · Chart.',
    mapped: 'No mapped songs yet. Open a song and get bars from its Edit · Map, or tap the beat.',
    spots: 'No saved spots yet. Loop the hard part on the Stage and save it as a spot.',
    review: 'Nothing needs review. Every song’s details look right.',
    processing: 'Nothing is processing right now.',
    failed: 'Nothing has failed.',
  }),
  emptyDrill: label => `No songs match ${label} with this filter.`,   // a drill-down plus a filter chip
  emptyArtist: name => `No songs by ${name}.`,                       // a drill-down alone
  emptyAlbum: name => `No songs on ${name}.`,
  emptyTitle: 'Nothing here yet',
  showAll: 'Show all',
  loading: 'Loading your library…',
  stillConnecting: 'Still connecting…',
  retry: 'Retry',

  // first run (spec §2.7)
  demoTitle: 'Try the example song',
  demoBody: 'A full band with a drum chart, sections and a tempo map. Your part starts muted so you can play along.',
  openExample: 'Open example',
  addFirstTitle: 'Add your first song',
  addFirstBody: 'Paste a YouTube, SoundCloud or Spotify link, search by name, or drop audio files.',
  addSong: 'Add song',
  webAddTitle: 'Add songs from your computer',
  webAddBody: 'Woodshed splits songs into stems on your Mac or PC. Your library syncs here automatically.',
  getDesktop: 'Get Woodshed for desktop',
  newTab: '(opens in a new tab)',
  alreadyHave: 'I already have it',
  alreadyHaveBody: 'Open Woodshed on your computer and sign in with this account.',
});

/** Library command titles and palette keywords (src/library/commands.js, architecture §3.5). */
export const COMMANDS = Object.freeze({
  add: 'Add song…',
  addKeywords: ['new', 'import', 'split', 'link', 'upload', 'youtube'],
  search: 'Search',
  openFocused: 'Open song',
  editFocused: 'Edit details',
  deleteSelected: 'Delete selected…',
  selectAll: 'Select all visible',
  select: 'Select',
  first: 'First card',
  last: 'Last card',
  view: 'Grid / list',
  viewKeywords: ['layout', 'grid', 'list', 'view'],
});

/**
 * The Library's controls: role, accessible name and the context the test renders them in
 * (`library`: a library of 6+ songs; `continue`: a practised song; `grid`/`list`: a card or row;
 * `failed`: a failed new-song job; `noResults`: a search with no match on the desktop app;
 * `emptyFilter`; `slow`: the library still loading after 8 s; `firstRunDesktop`/`firstRunWeb`).
 */
export const CONTROLS = Object.freeze([
  {context: 'library', role: 'group', name: COPY.filterGroup},
  {context: 'library', role: 'button', name: COPY.filters.chart},
  {context: 'library', role: 'button', name: COPY.filters.mapped},
  {context: 'library', role: 'button', name: COPY.filters.spots},
  {context: 'library', role: 'button', name: COPY.filters.review},
  {context: 'library', role: 'button', name: COPY.sortButton(COPY.sorts.practised)},
  {context: 'library', role: 'button', name: COPY.groupButton(null)},
  {context: 'library', role: 'radiogroup', name: COPY.view},
  {context: 'library', role: 'radio', name: COPY.grid},
  {context: 'library', role: 'radio', name: COPY.list},
  {context: 'continue', role: 'link', name: COPY.resumeLabel('Low Tide Static')},
  {context: 'continue', role: 'link', name: COPY.startOverLabel('Low Tide Static')},
  {context: 'grid', role: 'link', name: 'Glasshouse'},
  {context: 'grid', role: 'button', name: COPY.openArtist('Northbound')},
  {context: 'grid', role: 'button', name: COPY.more('Glasshouse')},
  {context: 'list', role: 'table', name: COPY.listLabel},
  {context: 'list', role: 'button', name: COPY.columns.title},
  {context: 'failed', role: 'button', name: COPY.tryAgain},
  {context: 'failed', role: 'button', name: COPY.jobDetails('Paper Boats')},
  {context: 'noResults', role: 'button', name: COPY.clearSearch},
  {context: 'noResults', role: 'button', name: COPY.addAsNew('zzzz')},
  {context: 'emptyFilter', role: 'button', name: COPY.showAll},
  {context: 'slow', role: 'button', name: COPY.retry},
  {context: 'firstRunDesktop', role: 'button', name: COPY.openExample},
  {context: 'firstRunDesktop', role: 'button', name: COPY.addSong},
  {context: 'firstRunWeb', role: 'link', name: `${COPY.getDesktop} ${COPY.newTab}`},
  {context: 'firstRunWeb', role: 'button', name: COPY.alreadyHave},
]);
