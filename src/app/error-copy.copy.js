// Error copy (spec §3.6, architecture §2.10, §6.1). Strings only: describeError()
// in error-copy.js chooses a row and binds its actions.
//
// Every action label below resolves to one target in TARGETS (§2.10's action
// table); tests/error-copy.test.js checks each row against it.

/** Action labels, exactly as spec §3.6 writes them. */
export const LABELS = Object.freeze({
  tryAgain: 'Try again',
  tryFast: 'Try Fast quality',
  tryNow: 'Try now',
  searchAnother: 'Search for another version',
  uploadInstead: 'Upload a file instead',
  chooseFile: 'Choose another file',
  restartProcessor: 'Restart processor',
  plan: 'Plan & storage',
  manageStorage: 'Manage storage',
  dismiss: 'Dismiss',
});

/**
 * The §2.10 action targets. Each label maps to exactly one target; "Choose another
 * file" opens the same picker as "Upload a file instead", and "Manage storage" opens
 * the same Settings page as "Plan & storage".
 *   jobs.retry           api.jobs.retry({jobId})
 *   jobs.retryFast       api.jobs.retry({jobId, preset: 'fast'})
 *   add.search           router.navigate('/add?q=…'), the old job dismissed once the new one is submitted
 *   add.pick             router.navigate('/add?pick=1')
 *   processor.restart    desktop.restartProcessor()
 *   settings.plan        router.navigate('/settings/plan')
 *   jobs.dismiss         api.jobs.dismiss({jobId})
 */
export const TARGETS = Object.freeze({
  [LABELS.tryAgain]: 'jobs.retry',
  [LABELS.tryFast]: 'jobs.retryFast',
  [LABELS.tryNow]: 'jobs.retry',
  [LABELS.searchAnother]: 'add.search',
  [LABELS.uploadInstead]: 'add.pick',
  [LABELS.chooseFile]: 'add.pick',
  [LABELS.restartProcessor]: 'processor.restart',
  [LABELS.plan]: 'settings.plan',
  [LABELS.manageStorage]: 'settings.plan',
  [LABELS.dismiss]: 'jobs.dismiss',
});

/** Where the navigation targets go. */
export const ROUTES = Object.freeze({
  add: '/add',
  pick: '/add?pick=1',
  plan: '/settings/plan',
});

/**
 * Spec §3.6, every row. `primary`/`secondary` are LABELS values; `details: true`
 * marks a row whose spec action is `Details` (the disclosure every error has),
 * so the UI opens Details as the first affordance.
 * `{used}`/`{limit}` are filled from the storage numbers when known.
 */
export const ROWS = Object.freeze({
  botCheckPending: {
    cause: 'YouTube bot check, auto-retry pending',
    sentence: 'YouTube asked for a sign-in check. Woodshed will try again in a few minutes.',
    primary: LABELS.tryNow, secondary: LABELS.uploadInstead,
  },
  botCheckBlocked: {
    cause: 'Bot check, retries exhausted',
    sentence: 'YouTube blocked this download.',
    primary: LABELS.searchAnother, secondary: LABELS.uploadInstead,
  },
  unavailable: {
    cause: 'Private, removed or region-locked',
    sentence: 'This video isn’t available. It may be private, removed or blocked in your region.',
    primary: LABELS.searchAnother, secondary: LABELS.dismiss,
  },
  processorOffline: {
    cause: 'Processor offline at submit (inline)',
    sentence: 'Woodshed’s processor isn’t running on this computer.',
    primary: LABELS.restartProcessor, details: true,
  },
  unreadable: {
    cause: 'Unreadable file',
    sentence: 'This file couldn’t be read as audio.',
    primary: LABELS.chooseFile, secondary: LABELS.dismiss,
  },
  diskFull: {
    cause: 'Disk full (local)',
    sentence: 'This computer is out of space for processing.',
    secondary: LABELS.dismiss, details: true,
  },
  storageFull: {
    cause: 'Cloud storage full',
    sentence: 'Your cloud storage is full ({used} of {limit} GB).',
    sentenceNoNumbers: 'Your cloud storage is full.',
    primary: LABELS.manageStorage, secondary: LABELS.dismiss,
  },
  accountPaused: {
    cause: 'Account paused',
    sentence: 'Adding songs is paused on this account.',
    primary: LABELS.plan,
  },
  separationFailed: {
    cause: 'Separation crash or OOM',
    sentence: 'Splitting failed on this computer.',
    primary: LABELS.tryAgain, secondary: LABELS.tryFast,
  },
  unknown: {
    cause: 'Unknown',
    sentence: 'Something went wrong while adding this song.',
    primary: LABELS.tryAgain, secondary: LABELS.dismiss,
  },
});

/** Sentences for the §2.10 additions and the remaining §6.1 and job codes. */
export const SENTENCES = Object.freeze({
  beatsUnavailable: 'Bar detection isn’t installed on this computer.',
  resplitWrongDevice: 'Re-split this song on {device}, which has the original file.',
  retryWrongDevice: 'Try this song again on {device}, which has the original file.',
  otherDevice: 'the computer that added it',
  sourceMissing: 'The original file isn’t on this computer any more. Add it again.',
  notFound: 'Woodshed couldn’t find this song. Try another link or search.',
  playlist: 'This link is a playlist. Add one song at a time.',
  syncFailed: 'Something went wrong while adding this song. Your local files are safe.',
  notSignedIn: 'You’re signed out. Sign in again to continue.',
  suspended: 'This account is suspended.',
  missing: 'This isn’t here any more. It may have been deleted.',
  missingShare: 'This link doesn’t work any more.',
  notOwner: 'This belongs to another account.',
  invalid: 'Woodshed couldn’t use that. Check it and try again.',
  deviceUnpaired: 'This computer isn’t connected to your account.',
  deviceRevoked: 'This computer was disconnected from your account by an administrator.',
  deviceOtherAccount: 'This computer is connected to a different Woodshed account.',
  deviceLimit: 'You’ve connected the most computers an account can have. Remove one in Settings first.',
  queueFull: 'Too many songs are waiting. Add more once these finish.',
  appStorageFull: 'Woodshed’s cloud storage is full right now. Try again later.',
  resplitNoSource: 'This song can’t be split again. Its original audio is gone.',
  jobLive: 'This song is still being processed.',
  jobNotFailed: 'Only songs that failed can be tried again.',
  practiceTooLarge: 'This song has too much practice data to save. Remove some markers or notes.',
  setlistLimit: 'You have the most setlists an account can have.',
  setlistFull: 'This setlist is full.',
  pinsFull: 'Up to 12 pins.',
  lookupUnavailable: 'Finding songs isn’t available right now. Try again later.',
  lookupBusy: 'Woodshed is still looking. Try again in a moment.',
  lookupTimeout: 'Looking that up took too long. Try again.',
  lookupInvalid: 'That isn’t a link or a search Woodshed can use.',
  artworkExpired: 'That cover upload took too long. Upload it again.',
  codec: 'This browser can’t play Woodshed’s audio format. Use Chrome, Edge, Firefox or Safari 15 or later.',
  offline: 'You’re offline. Woodshed will reconnect when you’re back online.',
});

/** The "Something went wrong" sentence per describeError context. */
export const UNKNOWN_BY_CONTEXT = Object.freeze({
  add: ROWS.unknown.sentence,
  job: ROWS.unknown.sentence,
  resplit: 'Something went wrong while re-splitting this song.',
  load: 'This song couldn’t be loaded.',
  save: 'Your change couldn’t be saved.',
  share: 'Sharing didn’t work.',
  detect: 'Finding bars didn’t work.',
});

/** Details text when the error carried no message at all. */
export const NO_DETAILS = 'No further details.';
