// Copy for sharing (spec §6.1, §4.13; architecture §2.18): the Share dialog, the Shared Stage's
// identity action, its status lines and its unavailable page, and the demo entry point.
// Error sentences come from src/app/error-copy.js (context 'share').

export const COPY = Object.freeze({
  // ---- the Share dialog (spec §6.1)
  title: (name) => `Share ${name}`,
  untitled: 'this song',
  body: 'Anyone with the link can listen and practise along. They can save their own copy.',
  includes: 'What the link includes',
  includeMap: 'Sections and tempo map',
  includeChart: 'Drum chart',
  noChart: 'This song has no drum chart yet.',
  checking: 'Checking for a link…',
  create: 'Create link',
  creating: 'Creating link…',
  linkLabel: 'Link',
  copy: 'Copy link',
  copied: 'Copied ✓',
  copiedAnnounce: 'Link copied',
  copyFailed: 'Select the link and copy it.',
  replaces: 'A new link replaces the old one.',
  stop: 'Stop sharing',
  stopTitle: 'Stop sharing?',
  stopBody: 'The link stops working for everyone.',
  stopConfirm: 'Stop sharing',
  stopped: 'Sharing stopped.',
  updated: 'Link updated.',
  exportOnly: 'New links are paused on this account. An existing link can still be copied or stopped.',
  done: 'Done',

  // ---- the Shared Stage (spec §4.13)
  documentTitle: 'Shared song · Woodshed',
  songTitle: (title) => `${title} · Shared on Woodshed`,
  add: 'Add to my library',
  adding: 'Adding…',
  addingStatus: 'Adding the song to your library…',
  open: 'Open in my library',
  signIn: 'Sign in to keep a copy',
  signingIn: 'Opening sign-in…',
  localNotice: 'Changes stay on this device until you add the song to your library.',
  linkStopped: 'This link was stopped. You can keep practising until you leave the page.',
  audioChanged: 'The person who shared this song changed its audio.',
  reload: 'Reload',

  // ---- the unavailable and error pages
  missingBody: 'It may have been stopped, or the song was removed. Ask the person who shared it for a new link.',
  failedTitle: 'Couldn’t open this song.',
  failedBody: 'Check your connection and try again.',
  retry: 'Try again',
  home: 'Open Woodshed',

  // ---- the demo (D7, B8)
  demoMissing: 'The example song isn’t available right now.',
});
