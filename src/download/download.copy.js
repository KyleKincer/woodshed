// Copy and controls for the /download page (architecture §9.6 DL1; spec §1.2 and §3.3).
// The page is 1.9's download page (src/js/desktop.js renderDownload) on the 2.0 primitives and
// tokens; its sentences are kept and the platform-detected primary uses spec §3.3's label
// ("Download for macOS (Apple Silicon)"). The lead is ADAPTED from spec §3.3's Add-sheet panel: its
// first sentence is emphasised as there, but the last one says "in your library on every device,
// including iPad" instead of "here and on your iPad automatically", because /download is not the
// library ("here" would point at this page). This deviation is reported in the DL1 handoff.

/** Display names, keyed by detectPlatform() / normalizeRelease() platform keys. */
export const PLATFORMS = Object.freeze({
  mac: Object.freeze({
    name: 'macOS',
    requirement: 'Apple Silicon · M1 or newer',
    primary: 'Download for macOS (Apple Silicon)',
    detail: 'Requires Apple Silicon (M1 or newer)',
  }),
  windows: Object.freeze({
    name: 'Windows',
    requirement: '64-bit · Intel & AMD',
    primary: 'Download for Windows',
    detail: '64-bit installer',
  }),
  linux: Object.freeze({
    name: 'Linux',
    requirement: '64-bit · Intel & AMD',
    primary: 'Download for Linux',
    detail: '64-bit installer',
  }),
});

/** The platform cards, in page order. */
export const PLATFORM_ORDER = Object.freeze(['mac', 'windows', 'linux']);

/** Placeholder rows per card while the release loads (the installers each platform ships). */
export const PLACEHOLDER_ROWS = Object.freeze({mac: 2, windows: 1, linux: 1});

export const COPY = Object.freeze({
  documentTitle: 'Woodshed — Desktop app',
  navLabel: 'Main',
  brand: 'Woodshed',
  /** The link back into the app: a new tab on the web, in place inside the desktop app. */
  openApp: 'Open web player',
  openAppDesktop: 'Back to your library',
  newTab: '(opens in a new tab)',
  /** Inside the desktop app an external link opens in the system browser (desktop/permissions.cjs). */
  opensBrowser: '(opens in your browser)',

  eyebrow: 'Woodshed for desktop',
  title: 'Download Woodshed',
  /** The lead's emphasised opening (spec §3.3 sets it in bold); `lead` starts with it. */
  leadStrong: 'Splitting happens on your computer.',
  lead: 'Splitting happens on your computer. Woodshed for Mac, Windows or Linux downloads songs and splits them into stems. Everything you add appears in your library on every device, including iPad.',
  iconAlt: 'Woodshed app icon',
  tagline: 'Built for the shed.',

  /** The primary before the release is known, and where no installer fits (mobile, ChromeOS, ARM Linux). */
  primaryFallback: 'See all downloads',
  otherPlatforms: 'Other platforms',
  detailLoading: 'macOS · Windows · Linux',
  detailMobile: 'Practice in your browser. Add songs with the desktop app.',
  detailWeb: 'Choose your desktop installer below, or practice in your browser.',
  /** `${PLATFORMS[key].detail} · ${size} · v${version}` */
  detailReady: (key, size, version) => `${PLATFORMS[key].detail} · ${size} · v${version}`,

  loading: 'Finding available downloads…',
  started: 'Your download should start shortly. If it doesn’t, click the download again.',
  unavailable: 'Downloads couldn’t load. Check your connection and try again.',
  retry: 'Try again',

  allTitle: 'All downloads',
  versionUnknown: 'Desktop app',
  version: v => `Version ${v}`,
  recommended: 'Recommended',
  loadingInstallers: 'Loading installers…',
  fileUnavailable: 'Temporarily unavailable',
  /** The accessible name of an installer link. */
  fileLabel: (key, label, size) => `Download Woodshed for ${PLATFORMS[key].name}, ${label}, ${size}`,

  stepsTitle: 'Getting started',
  steps: Object.freeze([
    Object.freeze({
      number: '01',
      title: 'Install once.',
      body: 'Open the installer and follow the prompts. Audio separation and beat detection are built in. No extra developer tools needed.',
      hint: 'On macOS, drag Woodshed to Applications. Windows may show an unknown-publisher warning. On Linux, make the AppImage executable before opening it.',
    }),
    Object.freeze({
      number: '02',
      title: 'Bring your music.',
      body: 'Sign in with Google and add a song. Woodshed handles the download and separates the instruments on your computer. Processing models download on first use.',
    }),
    Object.freeze({
      number: '03',
      title: 'Make time to play.',
      body: 'Your library and practice settings sync to the web player, so you can pick up on your iPad or another computer.',
    }),
  ]),

  footerNote: 'Free & open source.',
  projectNavLabel: 'Project',
  releaseNotes: 'Release notes',
  source: 'View source',
});

/** External destinations (opened in a new tab; on the desktop app main opens https links externally). */
export const LINKS = Object.freeze({
  app: '/',
  releaseNotes: 'https://github.com/KyleKincer/woodshed/releases',
  source: 'https://github.com/KyleKincer/woodshed',
});

const newTab = name => `${name} ${COPY.newTab}`;
const inBrowser = name => `${name} ${COPY.opensBrowser}`;
const FILE_ROWS = Object.freeze([
  /^Download Woodshed for macOS, DMG installer, \d+ MB$/,
  /^Download Woodshed for macOS, ZIP archive, \d+ MB$/,
  /^Download Woodshed for Windows, EXE installer, \d+ MB$/,
  /^Download Woodshed for Linux, AppImage, \d+ MB$/,
]);

/**
 * The contexts the CONTROLS table covers. `ready`, `loading` and `unavailable` are a Mac on the
 * web with the release loaded, still loading and not loadable; `mobile` is an iPad on the web with
 * the release loaded; `desktop` is a Mac inside the desktop app with the release loaded.
 */
export const CONTROL_CONTEXTS = Object.freeze(['ready', 'loading', 'unavailable', 'mobile', 'desktop']);

/**
 * The page's controls per context: [{context, role, name, count?}] (count defaults to 1). The
 * table-driven test renders each context, finds every row by computed role and accessible name, and
 * checks that the context has no control outside its rows.
 */
export const CONTROLS = Object.freeze([
  ...[
    {role: 'link', name: COPY.brand},
    {role: 'link', name: newTab(COPY.openApp)},
    {role: 'link', name: PLATFORMS.mac.primary},
    {role: 'link', name: COPY.otherPlatforms},
    ...FILE_ROWS.map(name => ({role: 'link', name})),
    {role: 'link', name: newTab(COPY.releaseNotes)},
    {role: 'link', name: newTab(COPY.source)},
  ].map(row => ({context: 'ready', ...row})),
  ...[
    {role: 'link', name: COPY.brand},
    {role: 'link', name: newTab(COPY.openApp)},
    {role: 'link', name: COPY.primaryFallback},
    {role: 'link', name: newTab(COPY.releaseNotes)},
    {role: 'link', name: newTab(COPY.source)},
  ].map(row => ({context: 'loading', ...row})),
  ...[
    {role: 'link', name: COPY.brand},
    {role: 'link', name: newTab(COPY.openApp)},
    {role: 'link', name: COPY.primaryFallback},
    {role: 'button', name: COPY.retry},
    {role: 'link', name: newTab(COPY.releaseNotes)},
    {role: 'link', name: newTab(COPY.source)},
  ].map(row => ({context: 'unavailable', ...row})),
  ...[
    {role: 'link', name: COPY.brand},
    // The header link and the primary: same name, same destination.
    {role: 'link', name: newTab(COPY.openApp), count: 2},
    {role: 'link', name: COPY.primaryFallback},
    ...FILE_ROWS.map(name => ({role: 'link', name})),
    {role: 'link', name: newTab(COPY.releaseNotes)},
    {role: 'link', name: newTab(COPY.source)},
  ].map(row => ({context: 'mobile', ...row})),
  ...[
    {role: 'link', name: COPY.brand},
    {role: 'link', name: COPY.openAppDesktop},
    {role: 'link', name: PLATFORMS.mac.primary},
    {role: 'link', name: COPY.otherPlatforms},
    ...FILE_ROWS.map(name => ({role: 'link', name})),
    {role: 'link', name: inBrowser(COPY.releaseNotes)},
    {role: 'link', name: inBrowser(COPY.source)},
  ].map(row => ({context: 'desktop', ...row})),
].map(Object.freeze));
