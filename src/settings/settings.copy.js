// Copy and controls for Settings (architecture §2.17, §9.10 SE1; spec §6.2, §4.2, §8.4): the frame
// (section nav on laptops, list → detail on iPad portrait) and the sections SE1 builds (Practice,
// Instruments, Pedals & keys, Appearance, This device, Account). Processing and Plan & storage are
// SE2's; their titles are here because the frame lists every section in spec order.
//
// Strings only (plus the SECTIONS and CONTROLS tables), so command and test modules may import it.

/** Every Settings section in spec §6.2 order. `scope` says where the section's values live. */
export const SECTIONS = Object.freeze([
  {id: 'practice', title: 'Practice', summary: 'Stop, count-in, click, distance, screen wake'},
  {id: 'instruments', title: 'Instruments', summary: 'What you play and how songs open'},
  {id: 'pedals', title: 'Pedals & keys', summary: 'Keyboard shortcuts'},
  {id: 'processing', title: 'Processing', summary: 'The processor, stems and quality'},
  {id: 'appearance', title: 'Appearance', summary: 'Theme and the Stage'},
  {id: 'plan', title: 'Plan & storage', summary: 'Usage, plan, export'},
  {id: 'device', title: 'This device', summary: 'Install, screen wake, media keys, version'},
  {id: 'account', title: 'Account', summary: 'Email, Google account, sign out'},
].map(Object.freeze));

export const SECTION_IDS = Object.freeze(SECTIONS.map(s => s.id));
export const SECTION_TITLES = Object.freeze(Object.fromEntries(SECTIONS.map(s => [s.id, s.title])));

/** Licence files in public/licenses (by basename) → the name shown on its button. */
export const LICENSE_NAMES = Object.freeze({
  'atkinson-hyperlegible-next': 'Atkinson Hyperlegible Next',
  'atkinson-hyperlegible-mono': 'Atkinson Hyperlegible Mono',
  lucide: 'Lucide icons',
  alphatab: 'alphaTab',
  vexflow: 'VexFlow',
  bravura: 'Bravura',
  academico: 'Academico',
  'signalsmith-stretch': 'Signalsmith Stretch',
  'harmonix-set': 'Harmonix Set',
});

export const COPY = Object.freeze({
  title: 'Settings',
  documentTitle: 'Settings — Woodshed',
  sectionDocumentTitle: section => `${section} — Settings — Woodshed`,
  navLabel: 'Settings sections',
  /** The detail page's way back to the list (iPad portrait). */
  back: 'Settings',
  /** Marks a row whose value is kept on this device only (D40). */
  thisDevice: 'This device',
  loading: 'Loading…',
  loadFailed: 'This section couldn’t open.',
  loadRetry: 'Try again',

  // Every control saves on change (spec §6.2).
  saved: 'Saved',
  saveFailed: 'Couldn’t save',
  retry: 'Retry',

  // On the web, desktop-only rows collapse into one note (spec §6.2, §2.17).
  desktopNote: items => `These need Woodshed for desktop: ${items.join(', ')}.`,
  desktopGet: 'Get it ↗',
  desktopHref: '/download',

  practice: Object.freeze({
    stop: Object.freeze({
      label: 'When Stop is pressed',
      cue: 'Return to cue',
      stay: 'Stay',
      hint: 'Return to cue goes back to where you started playing. Stay leaves the playhead where you stopped.',
    }),
    countIn: Object.freeze({
      label: 'Default count-in',
      off: 'Off',
      oneBar: '1 bar',
      twoBars: '2 bars',
      twoBeats: '2 beats',
      custom: 'Custom',
      length: 'Count-in length',
      shorter: 'Shorter count-in',
      longer: 'Longer count-in',
      unit: 'Count in',
      bars: 'Bars',
      beats: 'Beats',
      format: (n, unit) => `${n} ${unit === 'beats' ? (n === 1 ? 'beat' : 'beats') : (n === 1 ? 'bar' : 'bars')}`,
      hint: 'For songs whose count-in you haven’t changed. Songs without a bar grid use a 2 s lead-in instead.',
    }),
    click: Object.freeze({
      label: 'Default click',
      off: 'Off',
      countin: 'During count-in only',
      always: 'Always',
      hint: 'With Off, a count-in still counts on the beat lamps, silently.',
    }),
    eachPassCount: Object.freeze({
      label: 'Count in every loop pass',
      hint: 'Each pass of a loop starts with the count-in, not just the first.',
    }),
    keepPitch: Object.freeze({
      label: 'Keep pitch by default',
      hint: 'Slowing a song down keeps it in tune. You can change it per song in Speed.',
    }),
    distance: Object.freeze({
      label: 'Distance',
      near: 'Near',
      stand: 'Stand',
      kit: 'Kit',
      hint: 'How far you are from the screen. It scales the readouts and the chart; controls never scale.',
    }),
    follow: Object.freeze({
      label: 'Follow style',
      rail: 'With the side panel',
      band: 'With the bottom dock',
      railGroup: 'Follow style with the side panel',
      bandGroup: 'Follow style with the bottom dock',
      scroll: 'Scroll',
      page: 'Page',
      hint: 'Scroll keeps the playing line near the top. Page turns half a screen at a time, like a page-turner.',
    }),
    wake: Object.freeze({
      label: 'Keep screen awake',
      options: Object.freeze({5: '5 min', 10: '10 min', 30: '30 min', always: 'Always'}),
      hint: 'While a song is open: during playback and for this long after you stop, or always.',
    }),
    edgeFlash: Object.freeze({
      label: 'Flash screen edges on downbeats',
      hint: 'A glow at the edges of the screen on each downbeat, as well as the beat lamps.',
    }),
  }),

  instruments: Object.freeze({
    intro: 'Woodshed can take your part out of the mix so you can play it, and picks the right stems when you add songs.',
  }),

  pedals: Object.freeze({
    shortcuts: 'View keyboard shortcuts',
    hint: 'Every key and what it does where you are. Press ? anywhere to see them.',
  }),

  appearance: Object.freeze({
    theme: Object.freeze({label: 'Theme', system: 'System', light: 'Light', dark: 'Dark'}),
    stage: Object.freeze({
      label: 'Stage',
      match: 'Match theme',
      dark: 'Always dark',
      hint: 'The Stage is where you practise. Always dark keeps it calm on a music stand.',
    }),
    motion: 'Reduce motion follows your system setting.',
    motionOn: 'Reduce motion is on in your system settings.',
    motionOff: 'Reduce motion is off in your system settings.',
  }),

  device: Object.freeze({
    install: Object.freeze({
      label: 'Install as app',
      button: 'Install Woodshed',
      installed: 'Woodshed is installed on this device.',
      ios: 'In Safari, tap Share, then Add to Home Screen.',
      chromium: 'Use your browser’s menu: Install Woodshed (or Add to Home screen).',
      none: 'This browser can’t install Woodshed. Safari on iPad, or Chrome or Edge on a computer, can.',
      dismissed: 'Not installed. You can install Woodshed any time from here.',
    }),
    wake: Object.freeze({
      label: 'Keep screen awake',
      supported: 'Supported in this browser.',
      desktop: 'Supported. Woodshed for desktop keeps the display on.',
      unsupported: 'Not supported in this browser.',
      tip: 'Set Auto-Lock to Never while practising.',
    }),
    mediaKeys: Object.freeze({
      label: 'Media keys',
      supported: 'Supported',
      unsupported: 'Not supported',
    }),
    announce: Object.freeze({
      label: 'Announce sections while playing',
      hint: 'Screen readers hear the name of each section as playback reaches it.',
    }),
    version: Object.freeze({
      label: 'Version',
      web: version => `Woodshed ${version} · web app`,
      desktop: version => `Woodshed for desktop ${version}`,
    }),
    updates: Object.freeze({
      button: 'Check for updates',
      checking: 'Checking for updates…',
      available: version => (version ? `Update ${version} is available.` : 'An update is available.'),
      downloading: percent => `Downloading update ${percent}%`,
      ready: 'Update ready — Restart to install',
      current: 'Woodshed is up to date.',
      error: 'Couldn’t check for updates.',
    }),
    licenses: Object.freeze({
      label: 'Licenses',
      hint: 'The fonts, icons and libraries Woodshed uses, and their licenses.',
      close: 'Close',
      loading: 'Loading…',
      failed: 'This license couldn’t be shown.',
    }),
  }),

  account: Object.freeze({
    email: 'Email',
    google: 'Google account',
    signedIn: name => (name ? `Signed in with Google as ${name}` : 'Signed in with Google'),
    signOut: 'Sign out',
    admin: 'Administration',
    adminHint: 'Accounts, storage and policy.',
  }),
});

/**
 * Every control each section shows, as [{section, context, role, name, group?}]. The table-driven
 * test renders each section in each context, finds every row by role and accessible name (inside the
 * radiogroup named `group` when given), and checks the section shows no other control.
 *   context 'all'        every variant (web and desktop, admin or not)
 *   context 'web'        only in a browser · 'desktop' only in Woodshed for desktop
 *   context 'admin'      only for administrators
 *   context 'custom'     Practice with a custom count-in
 *   context 'prompt'     This device when the browser offers its install prompt
 * Instruments shows the InstrumentPicker (its controls are ON1's CONTROLS, context 'picker').
 */
const P = COPY.practice;
const radios = (section, group, names, context = 'all') => [
  {section, context, role: 'radiogroup', name: group},
  ...names.map(name => ({section, context, role: 'radio', name, group})),
];
const licenseRows = Object.values(LICENSE_NAMES).map(name => ({section: 'device', context: 'all', role: 'button', name}));

export const CONTROLS = Object.freeze([
  ...radios('practice', P.stop.label, [P.stop.cue, P.stop.stay]),
  ...radios('practice', P.countIn.label, [P.countIn.off, P.countIn.oneBar, P.countIn.twoBars, P.countIn.twoBeats, P.countIn.custom]),
  {section: 'practice', context: 'custom', role: 'spinbutton', name: P.countIn.length},
  {section: 'practice', context: 'custom', role: 'button', name: P.countIn.shorter},
  {section: 'practice', context: 'custom', role: 'button', name: P.countIn.longer},
  ...radios('practice', P.countIn.unit, [P.countIn.bars, P.countIn.beats], 'custom'),
  ...radios('practice', P.click.label, [P.click.off, P.click.countin, P.click.always]),
  {section: 'practice', context: 'all', role: 'button', name: P.eachPassCount.label},
  {section: 'practice', context: 'all', role: 'button', name: P.keepPitch.label},
  ...radios('practice', P.distance.label, [P.distance.near, P.distance.stand, P.distance.kit]),
  ...radios('practice', P.follow.railGroup, [P.follow.scroll, P.follow.page]),
  ...radios('practice', P.follow.bandGroup, [P.follow.scroll, P.follow.page]),
  ...radios('practice', P.wake.label, Object.values(P.wake.options)),
  {section: 'practice', context: 'all', role: 'button', name: P.edgeFlash.label},

  {section: 'pedals', context: 'all', role: 'button', name: COPY.pedals.shortcuts},

  ...radios('appearance', COPY.appearance.theme.label,
    [COPY.appearance.theme.system, COPY.appearance.theme.light, COPY.appearance.theme.dark]),
  ...radios('appearance', COPY.appearance.stage.label, [COPY.appearance.stage.match, COPY.appearance.stage.dark]),

  {section: 'device', context: 'prompt', role: 'button', name: COPY.device.install.button},
  {section: 'device', context: 'all', role: 'button', name: COPY.device.announce.label},
  {section: 'device', context: 'desktop', role: 'button', name: COPY.device.updates.button},
  ...licenseRows,

  {section: 'account', context: 'all', role: 'button', name: COPY.account.signOut},
  {section: 'account', context: 'admin', role: 'button', name: COPY.account.admin},
].map(Object.freeze));

/**
 * The spec §6.2 rows each SE1 section shows, as [{section, row, label, scope, path}]: `row` is the
 * row's data-row, `label` its visible label (or the name of the toggle or button that names it),
 * `scope` where the value is kept (D40): 'account' rows follow the account to every device,
 * 'device' rows are this device's prefs (they carry the "This device" tag), 'info' rows show facts
 * and keep nothing. `path` is the account settings or prefs path the row writes.
 */
export const ROWS = Object.freeze([
  {section: 'practice', row: 'stop', label: P.stop.label, scope: 'account', path: 'practice.stop'},
  {section: 'practice', row: 'countIn', label: P.countIn.label, scope: 'account', path: 'practice.countIn'},
  {section: 'practice', row: 'click', label: P.click.label, scope: 'account', path: 'practice.click'},
  {section: 'practice', row: 'eachPassCount', label: P.eachPassCount.label, scope: 'account', path: 'practice.eachPassCount'},
  {section: 'practice', row: 'keepPitch', label: P.keepPitch.label, scope: 'account', path: 'practice.keepPitch'},
  {section: 'practice', row: 'wake', label: P.wake.label, scope: 'account', path: 'practice.wake'},
  {section: 'practice', row: 'distance', label: P.distance.label, scope: 'device', path: 'practice.distance'},
  {section: 'practice', row: 'follow', label: P.follow.label, scope: 'device', path: 'practice.follow'},
  {section: 'practice', row: 'edgeFlash', label: P.edgeFlash.label, scope: 'device', path: 'practice.edgeFlash'},
  {section: 'instruments', row: 'profile', label: null, scope: 'account', path: 'profile'},
  {section: 'pedals', row: 'shortcuts', label: COPY.pedals.shortcuts, scope: 'info', path: null},
  {section: 'appearance', row: 'theme', label: COPY.appearance.theme.label, scope: 'device', path: 'theme'},
  {section: 'appearance', row: 'stage', label: COPY.appearance.stage.label, scope: 'device', path: 'stage'},
  {section: 'appearance', row: 'motion', label: null, scope: 'info', path: null},
  {section: 'device', row: 'install', label: COPY.device.install.label, scope: 'info', path: null, context: 'web'},
  {section: 'device', row: 'wakeLock', label: COPY.device.wake.label, scope: 'info', path: null},
  {section: 'device', row: 'mediaKeys', label: COPY.device.mediaKeys.label, scope: 'info', path: null},
  {section: 'device', row: 'announceSections', label: COPY.device.announce.label, scope: 'device', path: 'practice.announceSections'},
  {section: 'device', row: 'version', label: COPY.device.version.label, scope: 'info', path: null},
  {section: 'device', row: 'licenses', label: COPY.device.licenses.label, scope: 'info', path: null},
  {section: 'account', row: 'email', label: COPY.account.email, scope: 'info', path: null},
  {section: 'account', row: 'google', label: COPY.account.google, scope: 'info', path: null},
  {section: 'account', row: 'signOut', label: COPY.account.signOut, scope: 'info', path: null},
  {section: 'account', row: 'admin', label: COPY.account.admin, scope: 'info', path: null, context: 'admin'},
].map(Object.freeze));
