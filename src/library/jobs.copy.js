// Copy for the Jobs chip, the Jobs popover and the "Is this right?" chip (spec §2.1, §2.4, §2.8, §3.4,
// architecture §2.16). Strings only: src/library/jobs.js and src/library/review-chip.js choose and fill
// them. Error sentences and their actions are not here: they come from src/app/error-copy.js (§2.10).
//
// CONTROLS lists every control these views render, with its role and accessible name (the table test in
// tests/library-jobs.test.js and tests/library-review-chip.test.js renders each row).

/** Quotation marks around a search that has no title yet (spec §2.8: `"harbor lights ada moreno"`). */
export const quote = s => `“${s}”`;

/** The Jobs chip in the top bar (spec §2.1). */
export const CHIP = Object.freeze({
  splitting: n => `${n} splitting`,
  inProgress: n => `${n} in progress`,
  failed: n => `${n} failed`,
  found: n => (n === 1 ? 'Bars found' : `Bars found · ${n}`),
  offline: 'Processor offline',
  /** While the popover stays open after the last job has gone. */
  idle: 'Jobs',
});

/** StageStepper labels (spec §2.8 `Fetch ✓ — Split ● 46% — Finish — Ready`). */
export const STAGES = Object.freeze({
  fetch: 'Fetch',
  prepare: 'Prepare',
  upload: 'Upload',
  split: 'Split',
  finish: 'Finish',
  ready: 'Ready',
  bars: 'Find bars',
  sections: 'Find sections',
  copy: 'Copy',
  label: 'Progress',
});

/** What the processor is doing, as a verb (the card line's head and the popover's activity line). */
export const VERBS = Object.freeze({
  waiting: 'Waiting',
  uploading: 'Uploading',
  fetching: 'Fetching audio',
  preparing: 'Preparing audio',
  splitting: 'Splitting',
  finishing: 'Finishing',
  bars: 'Finding bars',
  sections: 'Finding sections',
  importing: 'Importing',
});

/** The card line (spec §3.4, 13 px) and the popover's activity line (spec §2.8). */
export const LINES = Object.freeze({
  waitingAhead: n => `Waiting · ${n} ahead`,
  waitingFor: name => `Waiting for ${name} (offline)`,
  percent: (verb, pct) => `${verb} · ${pct}%`,
  uploaded: (loaded, total) => `Uploading · ${loaded} of ${total} MB`,
  withEta: (line, eta) => `${line} · ${eta}`,
  on: (verb, device) => `${verb} on ${device}`,
  waitingOn: device => `Waiting for ${device}`,
  offlineOn: device => `${device} is offline. This starts when it’s back.`,
  pausedOn: device => `${device} is offline. This continues when it’s back.`,
  started: elapsed => `started ${elapsed} ago`,
  ahead: n => (n === 1 ? '1 song ahead of this one' : `${n} songs ahead of this one`),
  found: 'Bars found. Open the song to use them.',
  canceled: 'Canceled.',
});

/** Time left (spec §3.4: shown after 15 s from a moving rate, hidden when unstable). */
export const ETA = Object.freeze({
  card: minutes => (minutes < 1 ? '<1 min' : `~${minutes} min`),
  cardHours: (hours, minutes) => `~${hours} h ${minutes} min`,
  popover: minutes => (minutes < 1 ? 'less than a minute left' : `about ${minutes} min left`),
  popoverHours: (hours, minutes) => `about ${hours} h ${minutes} min left`,
});

/** The settings line (spec §2.8 `Balanced · 4 stems`). Preset names come from convex/lib/presets.ts. */
export const SETTINGS = Object.freeze({
  custom: 'Custom',
  stems: Object.freeze({full: '4 stems', six: '6 stems', drums: 'Drums + rest', vocals: 'Vocals + rest', bass: 'Bass + rest'}),
  join: ' · ',
});

/** Device names when the row has none. */
export const DEVICES = Object.freeze({
  thisComputer: 'this computer',
  yourComputer: 'your computer',
});

/** Row actions besides the error-copy ones (§2.10). */
export const ACTIONS = Object.freeze({
  cancel: 'Cancel',
  details: 'Details',
  copy: 'Copy',
  copied: 'Copied',
  openSong: 'Open song',
  notNow: 'Not now',
  dismiss: 'Dismiss',
});

/** The popover frame and footer (spec §2.8; the web footer follows §3.3). */
export const POPOVER = Object.freeze({
  title: 'Jobs',
  list: 'Jobs',
  empty: 'Nothing is processing.',
  emptyHint: 'Songs you add show their progress here.',
  source: label => `${label} ↗`,
  sourceName: label => `Open the source, ${label}, in a new tab`,
  detailsLabel: title => `Details for ${title}`,
  // Footer, desktop app.
  ready: name => `Processor ready · ${name}`,
  readyUnnamed: 'Processor ready',
  withName: (label, name) => `${label} · ${name}`,
  offline: 'Processor offline',
  restart: 'Restart processor',
  tryAgain: 'Try again',
  // Footer, web (the paired computer, B5).
  onlineDevice: name => `Your ${name} splits new songs · Online`,
  offlineDevice: name => `${name} is offline. Songs you add start when it’s back.`,
  noDevice: 'Splitting happens on your computer.',
  getDesktop: 'Get Woodshed for desktop ↗',
  getDesktopName: 'Get Woodshed for desktop (opens in a new tab)',
});

/** The "Is this right?" chip and its popover (spec §2.4, D43). */
export const REVIEW = Object.freeze({
  chip: 'Is this right?',
  title: 'Is this right?',
  current: 'Woodshed has these details for this song:',
  suggested: 'The closest match on MusicBrainz:',
  yes: 'Yes, that’s it',
  findAnother: 'Find another',
  saving: 'Saving…',
  unknownArtist: 'Unknown artist',
  cover: title => `Cover of ${title}`,
});

export const CONTROLS = Object.freeze([
  {role: 'button', name: '2 splitting', context: 'Jobs chip (live separations)'},
  {role: 'button', name: '1 failed', context: 'Jobs chip (a failure)'},
  {role: 'button', name: CHIP.offline, context: 'Jobs chip (desktop, processor offline)'},
  {role: 'dialog', name: POPOVER.title, context: 'Jobs popover'},
  {role: 'list', name: POPOVER.list, context: 'Jobs popover rows'},
  {role: 'button', name: ACTIONS.cancel, context: 'a live job'},
  {role: 'button', name: ACTIONS.details, context: 'every row'},
  {role: 'button', name: ACTIONS.copy, context: 'open Details'},
  {role: 'button', name: 'Try again', context: 'a failed separation (error copy)'},
  {role: 'button', name: 'Try now', context: 'a bot check with a retry pending (error copy)'},
  {role: 'button', name: ACTIONS.openSong, context: 'a found, unapplied detection'},
  {role: 'button', name: ACTIONS.notNow, context: 'a found, unapplied detection'},
  {role: 'link', name: POPOVER.sourceName('youtube.com/…'), context: 'a link-sourced job'},
  {role: 'button', name: POPOVER.restart, context: 'footer, desktop, processor offline'},
  {role: 'link', name: POPOVER.getDesktopName, context: 'footer, web, no paired computer'},
  {role: 'button', name: REVIEW.chip, context: 'Needs review chip'},
  {role: 'dialog', name: REVIEW.title, context: 'Needs review popover'},
  {role: 'button', name: REVIEW.yes, context: 'Needs review popover'},
  {role: 'button', name: REVIEW.findAnother, context: 'Needs review popover'},
]);
