// Copy and control tables of the Speed, Click and Mix sheets (spec §4.7; architecture §2.14.11,
// §9.0 "Copy and controls tables"). Pure: strings, small formatters and the CONTROLS table only.
//
//   COPY       every user-visible string of sheets/{speed,click,mix}.js
//   CONTROLS   [{sheet, context, role, name, command?}]: the controls each sheet renders, by context
//              (the table-driven test renders every row, finds it by role and accessible name and,
//              for a `command` row, checks that activating it runs that registry command; registry CI
//              reads the same column). A radio row runs its command when it is not already chosen.
//
// Contexts: 'mapped' (a song with a real map), 'unmapped', 'custom' (the Click sheet's Custom
// count-in), 'stems' (the rehearsal song's four stems), 'part' (a drum part exists), 'no-part'
// (no stem matches the profile), 'fallback-desktop' / 'fallback-web' (the instrument fell back to
// Other), 'running' (the trainer runs), 'any' (every context).

/** Speed presets in percent (spec §4.7; unchanged by E1, D30). */
export const PRESETS = Object.freeze([50, 60, 70, 75, 80, 85, 90, 100, 110, 125]);
/** The Click sheet's count-in choices (spec §4.7: Off · 1 bar · 2 bars · 2 beats · Custom). */
export const COUNT_IN_CHOICES = Object.freeze([
  Object.freeze({value: 'off', label: 'Off'}),
  Object.freeze({value: '1-bars', label: '1 bar', length: 1, unit: 'bars'}),
  Object.freeze({value: '2-bars', label: '2 bars', length: 2, unit: 'bars'}),
  Object.freeze({value: '2-beats', label: '2 beats', length: 2, unit: 'beats'}),
  Object.freeze({value: 'custom', label: 'Custom'}),
]);
/** The custom count-in range (today's range, spec §4.7). */
export const COUNT_IN_RANGE = Object.freeze({min: 1, max: 16});
/** Trainer stepper ranges, in percent (start/end follow the 25–150% speed range, D30). */
export const TRAINER_RANGE = Object.freeze({
  rate: Object.freeze({min: 25, max: 150, step: 5}),
  step: Object.freeze({min: 1, max: 25, step: 1}),
  passes: Object.freeze({min: 1, max: 32, step: 1}),   // shared/practice.ts trainerOf keeps 1–32
});

const pct = (n) => `${Math.round(n)}%`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const COPY = Object.freeze({
  // ---- Speed sheet -------------------------------------------------------------------------------------------
  speed: Object.freeze({
    bpm: (n) => `${n} bpm`,
    presets: 'Speed presets',
    preset: (n) => pct(n),
    fine: 'Fine',
    slower: '−1%',
    faster: '+1%',
    keepPitch: 'Keep pitch',
    keepPitchHint: 'Saved with this song. The default for new songs is in Settings → Practice.',
    trainer: 'Trainer',
    start: 'Start',
    end: 'End',
    step: 'Step',
    passes: 'Passes per step',
    percent: (n) => pct(n),
    stepValue: (n) => `+${Math.round(n)}%`,
    passesValue: (n) => String(n),
    decrease: (what) => `Decrease ${what.toLowerCase()}`,
    increase: (what) => `Increase ${what.toLowerCase()}`,
    plan: (from, to, steps, passes) => `${pct(from)} → ${pct(to)} in ${plural(steps, 'step')}, ${plural(passes, 'pass', 'passes')} each`,
    startTrainer: 'Start trainer',
    stopTrainer: 'Stop trainer',
    trainsOn: (target) => `Trains on: ${target}`,
    wholeSong: 'the whole song',
    progress: (i, n, rate) => `Step ${i} of ${n} · ${pct(rate)}`,
    done: (rate) => `Trainer done — ${pct(rate)}`,
    pendingChanges: 'Changes apply the next time you start the trainer.',
  }),

  // ---- Click sheet -------------------------------------------------------------------------------------------
  click: Object.freeze({
    countIn: 'Count-in',
    customLength: 'Count-in length',
    customUnit: 'Count-in unit',
    bars: 'Bars',
    beats: 'Beats',
    lengthValue: (n) => String(n),
    everyPass: 'Count in every loop pass',
    everyPassHint: 'Counts in again before each pass while a loop is on.',
    click: 'Click',
    modes: Object.freeze({off: 'Off', countin: 'During count-in only', always: 'Always'}),
    silentCount: 'Click is off, so the count-in is silent: the lamps and the plate still count.',
    accent: 'Accent downbeats',
    volume: 'Click volume',
    volumeValue: (v) => String(Math.round(v * 100)),
    preRoll: 'Play the song during count-in',
    visual: 'Visual click',
    lampsAlways: 'The beat lamps always flash with the click.',
    edgeFlash: 'Flash screen edges on downbeats',
    edgeFlashHint: 'On this device.',
    atCue: (glyph, bpm, meter, source) => `At the cue: ${glyph} = ${bpm} · ${meter} · ${source}`,
    fromMap: 'from the map',
    meter: (numerator, denominator, grouping) => `${numerator}/${denominator}${grouping ? ` (${grouping})` : ''}`,
    // Unmapped (no bar grid).
    leadIn: 'Lead-in 2 s',
    leadInHint: 'Plays 2 s of the song before the start. No clicks: this song has no bar grid yet.',
    needsGrid: 'Needs a bar grid',
    needsGridHint: 'Tap the beat or find the bars, and the click follows the song.',
    tapBeat: 'Tap the beat',
    getBars: 'Get bars',
    // Footer.
    footer: 'Tempo & bars wrong?',
    editMap: 'Edit map',
  }),

  // ---- Mix sheet ---------------------------------------------------------------------------------------------
  mix: Object.freeze({
    minusMe: (stems) => (stems ? `Minus me: ${stems}` : 'Minus me'),
    iPlay: (instruments) => `I play: ${instruments || 'Choose'}`,
    iPlayPicker: 'What do you play?',
    onlyMe: 'Only me',
    fullMix: 'Full mix',
    choose: 'Choose what you play to use Minus me and Only me.',
    chooseShared: 'Minus me and Only me use what you play, which isn’t set yet.',
    noMatch: (instruments) => `This song has no ${instruments} part to mute.`,
    noMatchDesktop: 'Re-split it with 6 stems to get one.',
    noMatchWeb: 'Re-split it from Woodshed for desktop.',
    fallback: (instruments) => `This song wasn't split with a ${instruments} part. Muting 'Other' instead.`,
    fallbackWeb: 'Re-split it from Woodshed for desktop.',
    resplit: 'Re-split with 6 stems',
    saveFailed: 'Couldn’t save what you play. Try again.',
    tapTo: 'Tap to',
    mute: 'Mute',
    solo: 'Solo',
    soloHint: 'Long-press a pad, or Shift-click it, to solo.',
    stems: 'Stems',
    noStems: 'The stems are still loading.',
    chartAudio: 'Chart playback',
    chartLevels: Object.freeze({off: 'Off', quiet: 'Quiet', loud: 'Loud'}),
    join: (names) => names.join(' + '),
    list: (names) => names.join(', '),
  }),
});

const S = COPY.speed;
const C = COPY.click;
const M = COPY.mix;

/** The controls each sheet renders (spec §4.7), as `{sheet, context, role, name, command?}` rows. */
export const CONTROLS = Object.freeze([
  // Speed
  ...PRESETS.map((n) => ({sheet: 'speed', context: 'any', role: 'button', name: S.preset(n), command: 'speed.set'})),
  {sheet: 'speed', context: 'any', role: 'group', name: S.presets},
  {sheet: 'speed', context: 'any', role: 'button', name: S.slower, command: 'speed.downFine'},
  {sheet: 'speed', context: 'any', role: 'button', name: S.faster, command: 'speed.upFine'},
  {sheet: 'speed', context: 'any', role: 'button', name: S.keepPitch},
  {sheet: 'speed', context: 'any', role: 'spinbutton', name: S.start},
  {sheet: 'speed', context: 'any', role: 'spinbutton', name: S.end},
  {sheet: 'speed', context: 'any', role: 'spinbutton', name: S.step},
  {sheet: 'speed', context: 'any', role: 'spinbutton', name: S.passes},
  {sheet: 'speed', context: 'any', role: 'button', name: S.startTrainer, command: 'trainer.toggle'},
  {sheet: 'speed', context: 'running', role: 'button', name: S.stopTrainer, command: 'trainer.toggle'},
  // Click (mapped)
  {sheet: 'click', context: 'mapped', role: 'radiogroup', name: C.countIn},
  ...COUNT_IN_CHOICES.map((c) => ({sheet: 'click', context: 'mapped', role: 'radio', name: c.label})),
  {sheet: 'click', context: 'custom', role: 'spinbutton', name: C.customLength},
  {sheet: 'click', context: 'custom', role: 'radiogroup', name: C.customUnit},
  {sheet: 'click', context: 'custom', role: 'radio', name: C.bars},
  {sheet: 'click', context: 'custom', role: 'radio', name: C.beats},
  {sheet: 'click', context: 'any', role: 'button', name: C.everyPass, command: 'loop.eachPass'},
  {sheet: 'click', context: 'mapped', role: 'radiogroup', name: C.click},
  ...Object.values(C.modes).map((name) => ({sheet: 'click', context: 'mapped', role: 'radio', name, command: 'click.mode'})),
  {sheet: 'click', context: 'mapped', role: 'button', name: C.accent},
  {sheet: 'click', context: 'mapped', role: 'slider', name: C.volume},
  {sheet: 'click', context: 'mapped', role: 'button', name: C.preRoll},
  {sheet: 'click', context: 'mapped', role: 'button', name: C.edgeFlash},
  {sheet: 'click', context: 'mapped', role: 'button', name: C.editMap, command: 'edit.map'},
  // Click (unmapped)
  {sheet: 'click', context: 'unmapped', role: 'button', name: C.leadIn},
  {sheet: 'click', context: 'unmapped', role: 'button', name: C.tapBeat, command: 'stage.tapBeat'},
  {sheet: 'click', context: 'unmapped', role: 'button', name: C.getBars, command: 'stage.getBars'},
  // Mix
  {sheet: 'mix', context: 'stems', role: 'button', name: M.minusMe('Drums'), command: 'mix.minusMe'},
  {sheet: 'mix', context: 'stems', role: 'button', name: M.iPlay('Drums')},
  {sheet: 'mix', context: 'stems', role: 'button', name: M.onlyMe, command: 'mix.onlyMe'},
  {sheet: 'mix', context: 'stems', role: 'button', name: M.fullMix, command: 'mix.full'},
  {sheet: 'mix', context: 'stems', role: 'radiogroup', name: M.tapTo},
  {sheet: 'mix', context: 'stems', role: 'radio', name: M.mute},
  {sheet: 'mix', context: 'stems', role: 'radio', name: M.solo},
  ...['Drums', 'Bass', 'Vocals', 'Other'].flatMap((stem) => [
    {sheet: 'mix', context: 'stems', role: 'group', name: stem},
    {sheet: 'mix', context: 'stems', role: 'button', name: `Mute ${stem}`},
    {sheet: 'mix', context: 'stems', role: 'slider', name: `${stem} level`},
  ]),
  {sheet: 'mix', context: 'part', role: 'radiogroup', name: M.chartAudio},
  ...Object.values(M.chartLevels).map((name) => ({sheet: 'mix', context: 'part', role: 'radio', name, command: 'mix.chartAudio'})),
  {sheet: 'mix', context: 'no-part', role: 'button', name: M.iPlay('Choose')},
  {sheet: 'mix', context: 'fallback-desktop', role: 'button', name: M.resplit, command: 'song.resplit'},
].map(Object.freeze));
