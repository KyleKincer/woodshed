// Copy and controls for the /download page (architecture §9.6 DL1; spec §1.2 and §3.3).
// The page is 1.9's download page (src/js/desktop.js renderDownload) on the 2.0 primitives and
// tokens; its sentences are kept, the lead is spec §3.3's panel sentence, and the platform-detected
// primary uses spec §3.3's label ("Download for macOS (Apple Silicon)").

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

  eyebrow: 'Woodshed for desktop',
  title: 'Download Woodshed',
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

/**
 * The page's controls (role and accessible name) once the release has loaded on a Mac on the web.
 * The table-driven test renders the page and finds each row by role and name.
 */
export const CONTROLS = Object.freeze([
  {role: 'link', name: COPY.brand},
  {role: 'link', name: `${COPY.openApp} ${COPY.newTab}`},
  {role: 'link', name: PLATFORMS.mac.primary},
  {role: 'link', name: COPY.otherPlatforms},
  {role: 'link', name: /^Download Woodshed for macOS, DMG installer, \d+ MB$/},
  {role: 'link', name: /^Download Woodshed for macOS, ZIP archive, \d+ MB$/},
  {role: 'link', name: /^Download Woodshed for Windows, EXE installer, \d+ MB$/},
  {role: 'link', name: /^Download Woodshed for Linux, AppImage, \d+ MB$/},
  {role: 'link', name: `${COPY.releaseNotes} ${COPY.newTab}`},
  {role: 'link', name: `${COPY.source} ${COPY.newTab}`},
]);
