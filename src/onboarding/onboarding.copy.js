// Copy and controls for first run (architecture §2.19, §9.8 ON1; spec §6.6.1–6.6.3):
// the sign-in card, the /welcome "What do you play?" screen and the InstrumentPicker that
// Settings → Instruments and the Mix sheet share.
//
// The sign-in error sentences are not here: they are today's OAuth copy, owned by the auth core
// (src/app/auth.js OAUTH_MESSAGES), and signin.js maps an AuthError{kind: 'oauth'} onto them.
// Strings only (plus the CONTROLS table), so command and test modules may import this file.

/** The instruments, in chip order, with their labels (keys are profile.js INSTRUMENTS). */
export const INSTRUMENT_LABELS = Object.freeze({
  drums: 'Drums',
  bass: 'Bass',
  guitar: 'Guitar',
  keys: 'Keys',
  vocals: 'Vocals',
  other: 'Other',
});

/** The badge ChipGroup (src/ui/chip.js) puts on the `primary` chip. */
export const PRIMARY_BADGE = 'Primary';

export const COPY = Object.freeze({
  wordmark: 'Woodshed',

  // §6.6.1 the sign-in card (centred 400 px card; no theme picker: the theme follows the system).
  signin: Object.freeze({
    documentTitle: 'Sign in — Woodshed',
    title: 'Practise along with any song',
    /** The three lines, each with a 20 px icon (sprite names). */
    lines: Object.freeze([
      Object.freeze({icon: 'layers', text: 'Split any song into drums, bass, vocals and more'}),
      Object.freeze({icon: 'repeat', text: 'Loop the hard part, slow it down, take your part out'}),
      Object.freeze({icon: 'file-music', text: 'Read drum charts that follow the recording'}),
    ]),
    linesLabel: 'What Woodshed does',
    continue: 'Continue with Google',
    /** The button's busy text while Google opens (today's "Opening Google…"). */
    opening: 'Opening Google…',
    finePrint: 'New here? This creates your free account. Adding songs uses the free desktop app (Mac, Windows, Linux). Practising works everywhere, including iPad.',
  }),

  // §6.6.2 "What do you play?" (one screen, skippable).
  welcome: Object.freeze({
    documentTitle: 'What do you play? — Woodshed',
    title: 'What do you play?',
    body: 'Woodshed can take your part out of the mix so you can play it, and picks the right stems when you add songs.',
    continue: 'Continue',
    saving: 'Saving…',
    /** Continue's visible reason while nothing is chosen (Skip is the other way on). */
    chooseFirst: 'Choose what you play, or skip',
    skip: 'Skip',
    /** Spec §6.2's save failure: "Couldn't save · [Retry]". */
    saveFailed: 'Couldn’t save',
    retry: 'Retry',
  }),

  // The InstrumentPicker (§2.19): 56 px chips, the first tapped is primary (ChipGroup's
  // "Primary" badge), then the open-with-my-part choice.
  picker: Object.freeze({
    label: 'What do you play?',
    openWithLabel: 'When you open a song:',
    hearEverything: 'Hear everything',
    partOut: 'Start with my part out',
    mappingLabel: 'Which stems are your part',
  }),
});

/**
 * Every control each screen shows, as [{context, role, name}]. The table-driven test renders each
 * context, finds every row by role and accessible name, and checks the context has no other control.
 *   signin        the sign-in card (with or without an error: the error is a status, not a control)
 *   welcome       /welcome with nothing chosen
 *   welcome-fail  /welcome with Drums chosen, after a failed save (the status line's Retry)
 *   picker        the InstrumentPicker on its own (Settings → Instruments)
 * A chip's name is its label; the primary chip's name also carries the ChipGroup badge ("Drums Primary").
 */
const pickerRows = (context, primary = null) => [
  ...Object.entries(INSTRUMENT_LABELS).map(([key, name]) => ({context, role: 'button', name: key === primary ? `${name} ${PRIMARY_BADGE}` : name})),
  {context, role: 'radio', name: COPY.picker.hearEverything},
  {context, role: 'radio', name: COPY.picker.partOut},
];

export const CONTROLS = Object.freeze([
  {context: 'signin', role: 'button', name: COPY.signin.continue},
  ...pickerRows('welcome'),
  {context: 'welcome', role: 'button', name: COPY.welcome.continue},
  {context: 'welcome', role: 'button', name: COPY.welcome.skip},
  ...pickerRows('welcome-fail', 'drums'),
  {context: 'welcome-fail', role: 'button', name: COPY.welcome.retry},
  {context: 'welcome-fail', role: 'button', name: COPY.welcome.continue},
  {context: 'welcome-fail', role: 'button', name: COPY.welcome.skip},
  ...pickerRows('picker'),
].map(Object.freeze));

export const CONTROL_CONTEXTS = Object.freeze(['signin', 'welcome', 'welcome-fail', 'picker']);
