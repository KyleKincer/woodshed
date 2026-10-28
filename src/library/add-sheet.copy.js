// Copy and controls for the Add sheet (`/add`; spec §3.1–3.3 and §3.6, architecture §2.16, §9.12 LB2b).
// add-sheet.js reads every string from here. The error sentences and their actions come from
// src/app/error-copy.js (spec §3.6); the defaults line's words come from add-model.js (LB2a).
//
// CONTROLS lists every control the sheet can show, with its role, accessible name and the context
// that shows it (tests/library-add-sheet.test.js renders each context and checks every row).

/** Stem layouts as the Change panel names them (spec §3.2 item 4), in add-model.js STEM_MODES order. */
export const STEM_OPTIONS = Object.freeze([
  Object.freeze({value: 'full', label: 'Full band · 4'}),
  Object.freeze({value: 'six', label: 'Full band + guitar & piano · 6'}),
  Object.freeze({value: 'drums', label: 'Drums + rest'}),
  Object.freeze({value: 'vocals', label: 'Vocals + rest'}),
  Object.freeze({value: 'bass', label: 'Bass + rest'}),
]);

/** The Quality presets the panel offers (Custom stays in Settings → Processing). */
export const QUALITY_OPTIONS = Object.freeze([
  Object.freeze({value: 'fast', label: 'Fast'}),
  Object.freeze({value: 'balanced', label: 'Balanced'}),
  Object.freeze({value: 'studio', label: 'Studio'}),
]);

/** Where a candidate comes from, as its row names it. */
export const PROVIDERS = Object.freeze({youtube: 'YouTube', soundcloud: 'SoundCloud', other: 'Web'});

export const COPY = Object.freeze({
  title: 'Add a song',
  close: 'Close',

  // ---- the omnibox (spec §3.2 item 2)
  placeholder: 'Paste a link or search for a song',
  /** The desktop first run (architecture §2.19): shown once, while the library is empty. */
  placeholderFirst: 'Paste a link to your first song',
  omniboxLabel: 'Paste a link or search for a song',
  chooseFiles: 'Choose files…',
  paste: 'Paste',
  pasteFailed: 'Woodshed couldn’t read the clipboard. Paste with a long-press in the field instead.',
  hint: 'YouTube, SoundCloud and Spotify links · MP3, WAV, FLAC, M4A, AAC, OGG, Opus, AIFF, WMA',
  dropTarget: 'Drop to add files',

  // ---- the resolution area (spec §3.2 item 3)
  looking: 'Looking…',
  candidatesLabel: 'Choose a recording',
  urlFallback: 'We’ll fetch this link when you press Add',
  searchFallback: q => `Woodshed will search YouTube and use the top result for “${q}”. You can check it when it’s ready.`,
  spotifyLead: 'Spotify doesn’t allow downloads. We’ll find this song on YouTube:',
  spotifyFallback: 'Woodshed will search YouTube for this song and use the top result. You can check it when it’s ready.',
  noResults: q => `Nothing found for “${q}”. Try other words, or paste a link.`,
  candidateMeta: (channel, provider) => [channel, provider].filter(Boolean).join(' · '),
  liveStream: 'Live stream',

  // ---- files
  filesLabel: 'Files to add',
  removeFile: name => `Remove ${name}`,
  sizeMB: bytes => `${(bytes / 1e6 >= 10 ? Math.round(bytes / 1e6) : Math.round(bytes / 1e5) / 10)} MB`,
  durationUnknown: '–:––',
  titleField: 'Song title',
  titleHint: 'Leave it as it is to use the title stored in the file.',
  filesWeb: 'To add files, drop them into Woodshed on your computer.',
  filesInstead: 'The files above are added. Remove them to add a link or search instead.',

  // ---- duplicate (spec §3.2 item 3)
  duplicateLead: 'Already in your library:',
  duplicateName: (title, artist) => (artist ? `${title} — ${artist}` : title),
  openIt: 'Open it',
  addAnotherVersion: 'Add another version',

  // ---- defaults line (spec §3.2 item 4)
  change: 'Change',
  changeLabel: 'Change stems and quality',
  stemsLabel: 'Stems',
  qualityLabel: 'Quality',
  estimate: minutes => `~${minutes} min`,
  estimateNote: 'Estimates on this computer, from the songs it has split.',
  saveDefaults: 'Use these for future songs',
  qualityHint: 'Higher quality takes longer. You can re-split any song later.',
  customHint: 'Custom model, passes and overlap stay in Settings → Processing.',

  // ---- device line (spec §3.2 item 5, §3.3 B5)
  localDevice: 'Processing on this computer',
  processor: Object.freeze({
    ready: 'Ready', busy: 'Busy', starting: 'Starting…', firstRun: 'Setting up (first run, ~1 min)…', pairing: 'Connecting…',
    offline: 'Offline', 'pair-failed': 'Not connected',
  }),
  restartProcessor: 'Restart processor',
  remoteDevice: name => ['Your ', {strong: name}, ' will split this'],
  online: 'Online',
  offline: 'Offline',
  deviceOffline: name => `${name} is offline. Songs you add start when it’s back.`,
  chooseDevice: name => `Choose a computer (now ${name})`,
  deviceItem: (name, online) => `${name} · ${online ? 'Online' : 'Offline'}`,
  devicesMenu: 'Computers',

  // ---- footer and submit
  cancel: 'Cancel',
  submit: 'Add & split',
  submitFiles: n => `Add ${n} files`,
  addAnother: 'add another',
  busy: 'Adding…',
  added: title => `Added ${title}. Add another, or close this.`,

  // ---- after submit (spec §3.2 "After submit")
  toast: title => ['Adding ', {strong: title}],
  announce: title => `Adding ${title}`,
  filesTitle: n => `${n} files`,
  undo: 'Undo',
  undone: title => `Stopped adding ${title}`,
  undoFailed: 'Too late to undo: it’s already being processed. Cancel it from Jobs.',

  // ---- errors (spec §3.6; the sentences are error-copy.js's)
  details: 'Details',
  copyDetails: 'Copy',
  copied: 'Copied',

  // ---- the web explainer (spec §3.3, no paired processor)
  explainerStrong: 'Splitting happens on your computer.',
  explainerBody: 'Woodshed for Mac, Windows or Linux downloads songs and splits them into stems. Everything you add appears here and on your iPad automatically.',
  getDesktop: 'Get Woodshed for desktop',
  otherPlatforms: 'Other platforms',
  copyLink: 'Copy download link',
  linkCopied: 'Download link copied',
  shareLink: 'Share download link',
  shareTitle: 'Woodshed for desktop',
  shareText: 'Download Woodshed for desktop to add songs.',
  alreadyInstalled: 'Already installed? Open it and sign in.',
  meanwhile: 'Meanwhile:',
  openExample: 'Open the example song',
  newTab: '(opens in a new tab)',
});

/**
 * Every control, by context (see the test): `desktop` (the desktop app), `candidates` (B4 rows), `files`,
 * `file` (one file), `duplicate`, `change` (the Change panel open), `web` (B5 with paired computers),
 * `explainer` (web without one), `ipad` (coarse pointers), `error`.
 */
export const CONTROLS = Object.freeze([
  {role: 'dialog', name: COPY.title, context: 'desktop'},
  {role: 'button', name: COPY.close, context: 'desktop'},
  {role: 'textbox', name: COPY.omniboxLabel, context: 'desktop'},
  {role: 'button', name: COPY.chooseFiles, context: 'desktop'},
  {role: 'button', name: COPY.changeLabel, context: 'desktop'},
  {role: 'button', name: COPY.cancel, context: 'desktop'},
  {role: 'button', name: COPY.submit, context: 'desktop'},
  {role: 'radiogroup', name: COPY.candidatesLabel, context: 'candidates'},
  {role: 'radio', name: 'Harbor Lights (Official Audio)', context: 'candidates', count: 3},
  {role: 'list', name: COPY.filesLabel, context: 'files'},
  {role: 'button', name: COPY.removeFile('Harbor Lights.mp3'), context: 'files'},
  {role: 'button', name: COPY.submitFiles(2), context: 'files'},
  {role: 'textbox', name: COPY.titleField, context: 'file'},
  {role: 'button', name: COPY.openIt, context: 'duplicate'},
  {role: 'button', name: COPY.addAnotherVersion, context: 'duplicate'},
  {role: 'radiogroup', name: COPY.stemsLabel, context: 'change'},
  {role: 'radiogroup', name: COPY.qualityLabel, context: 'change'},
  {role: 'checkbox', name: COPY.saveDefaults, context: 'change'},
  {role: 'button', name: COPY.chooseDevice('Studio MacBook'), context: 'web'},
  {role: 'button', name: COPY.paste, context: 'ipad'},
  {role: 'button', name: COPY.details, context: 'error'},
  {role: 'button', name: COPY.restartProcessor, context: 'error'},
  {role: 'link', name: `${COPY.getDesktop} ${COPY.newTab}`, context: 'explainer'},
  {role: 'link', name: `${COPY.otherPlatforms} ${COPY.newTab}`, context: 'explainer'},
  {role: 'button', name: COPY.copyLink, context: 'explainer'},
  {role: 'button', name: COPY.shareLink, context: 'explainer'},
  {role: 'button', name: COPY.openExample, context: 'explainer'},
]);
