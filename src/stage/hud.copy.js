// Copy and control tables for the Stage HUD (src/stage/hud.js) and the control set
// (src/stage/controls.js): spec §4.3, §4.4 (exact readout rules), §4.6, §4.10, §4.13,
// architecture §4.4 and §2.14.10. Strings only; the modules build the text from these.

export const COPY = Object.freeze({
  // ---- identity row (spec §4.3, §4.9, §4.13)
  back: 'Back to Library',
  holdToLeave: 'Hold to leave — playback will stop',
  notes: 'Notes',
  more: 'More…',
  sharedBy: (name) => `Shared by ${name}`,
  sharedByUnknown: 'Shared with you',
  wake: 'Screen stays awake',
  pedal: 'Pedal mode',
  ready: (n) => `${n} ready`,
  readyMenu: 'Ready to practise',
  openReady: (title) => `Open ${title}`,
  untitled: 'Untitled',
  setLine: (name, index, count) => `${name} · ${index} of ${count}`,
  setNext: (title) => `next: ${title}`,
  setPrev: 'Previous song in set',
  setNextLabel: 'Next song in set',
  setGroup: 'Setlist',

  // ---- readouts (architecture §4.4)
  nowPlaying: 'Now playing',
  section: 'Section',
  next: 'Next',
  position: 'Position',
  speed: 'Speed',
  loop: 'Loop',
  mix: 'Mix',
  separator: ' · ',
  percent: (pct) => `${pct}%`,
  bpm: (n) => `${n} bpm`,
  loopLine1: (name) => (name ? `LOOP · ${name}` : 'LOOP'),
  pass: (n) => `pass ${n}`,
  passOf: (n, of) => `pass ${n} of ${of}`,
  bars: (x, y) => `Bars ${x}–${y}`,
  bar: (x) => `Bar ${x}`,
  pickupBars: (y) => `Pickup–bar ${y}`,
  pickup: 'Pickup',
  trainer: (start, end, step, steps) => `Trainer ${start} → ${end}% · step ${step} of ${steps}`,
  trainerDone: (rate) => `Trainer done — ${rate}%`,
  listen: 'listen',
  youPlay: 'you play',
  out: 'OUT',
  solo: 'SOLO',
  mixWord: 'MIX',
  join: ' + ',
  loopOptions: 'Loop options…',
  speedDrag: 'Drag up or down to change the speed',

  // ---- count-in plate (spec §4.3)
  countAnnounce: (label) => label,

  // ---- controls (spec §4.6, architecture §2.14.10)
  again: 'Again',
  play: 'Play',
  stop: 'Stop',
  count: 'Count',
  cancelCount: 'Cancel count-in',
  pause: 'Pause',
  loopControl: 'Loop',
  countIn: 'Count-in',
  leadIn: 'Lead-in',
  leadInLength: '2 s',
  countLength: (n, unit) => `${n} ${unit === 'beats' ? (n === 1 ? 'beat' : 'beats') : (n === 1 ? 'bar' : 'bars')}`,
  click: 'Click',
  mixControl: 'Mix',
  mine: 'Mine',
  minusMe: 'Minus me',
  minusMeName: (visible) => `${visible} · Minus me`,
  mixSheet: 'Mix…',
  slower: 'Slower (−5%)',
  faster: 'Faster (+5%)',
  loading: (pct) => (Number.isFinite(pct) ? `Loading ${pct}%` : 'Loading…'),
  decoding: (i, n) => `Decoding ${i} of ${n}`,
  preparing: 'Preparing pitch-preserving playback',
  armed: 'Play when ready',
  loadError: 'Couldn’t load the audio for this song.',
  transport: 'Transport',
  speedChip: (pct) => `${pct}%`,
  loopChip: 'Loop',
});

/**
 * The HUD's interactive controls ([{role, name, command?, match}]): `match` 'exact' or 'prefix'
 * (a name that carries live state, e.g. the Loop line). Registry CI checks every `command`.
 */
export const HUD_CONTROLS = Object.freeze([
  {role: 'button', name: COPY.back, command: 'stage.leave', match: 'exact'},
  {role: 'button', name: COPY.notes, command: 'stage.notes', match: 'exact'},
  {role: 'button', name: COPY.more, command: 'stage.menu', match: 'exact'},
  {role: 'button', name: 'LOOP', command: 'loop.card', match: 'prefix'},
  {role: 'button', name: COPY.setPrev, command: 'setlist.prev', match: 'exact'},
  {role: 'button', name: COPY.setNextLabel, command: 'setlist.next', match: 'exact'},
  {role: 'button', name: COPY.ready(1), match: 'exact'},
].map(Object.freeze));

/**
 * The control set's rows per variant ([{variant, role, name, command, match}], spec §4.6). Names are
 * the accessible names in a fresh mapped session (count-in off, full mix, stopped, 100%).
 */
export const CONTROL_ROWS = Object.freeze([
  ...['dock', 'rail'].flatMap((variant) => [
    {variant, role: 'button', name: COPY.again, command: 'transport.again', match: 'exact'},
    {variant, role: 'button', name: COPY.play, command: 'transport.playStop', match: 'exact'},
    {variant, role: 'button', name: COPY.loopControl, command: 'transport.loopToggle', match: 'exact'},
    {variant, role: 'spinbutton', name: COPY.speed, command: 'speed.sheet', match: 'exact'},
    {variant, role: 'button', name: COPY.slower, command: 'speed.down', match: 'exact'},
    {variant, role: 'button', name: COPY.faster, command: 'speed.up', match: 'exact'},
    {variant, role: 'button', name: COPY.countIn, command: 'click.countIn', match: 'prefix'},
    {variant, role: 'button', name: COPY.minusMeName(COPY.mixControl), command: 'mix.minusMe', match: 'exact'},
    {variant, role: 'button', name: COPY.mixSheet, command: 'mix.sheet', match: 'exact'},
  ]),
  {variant: 'rail', role: 'button', name: COPY.click, command: 'click.toggle', match: 'exact'},
  {variant: 'mini', role: 'spinbutton', name: COPY.speed, command: 'speed.sheet', match: 'exact'},
  {variant: 'mini', role: 'button', name: COPY.slower, command: 'speed.down', match: 'exact'},
  {variant: 'mini', role: 'button', name: COPY.faster, command: 'speed.up', match: 'exact'},
  {variant: 'mini', role: 'button', name: COPY.play, command: 'transport.playStop', match: 'exact'},
  {variant: 'slim', role: 'button', name: COPY.again, command: 'transport.again', match: 'exact'},
  {variant: 'slim', role: 'button', name: COPY.play, command: 'transport.playStop', match: 'exact'},
  {variant: 'slim', role: 'button', name: COPY.pause, command: 'transport.pause', match: 'exact'},
  {variant: 'slim', role: 'button', name: COPY.loopChip, command: 'transport.loopToggle', match: 'exact'},
  {variant: 'slim', role: 'button', name: COPY.speed, command: 'speed.sheet', match: 'prefix'},
  {variant: 'slim', role: 'button', name: COPY.countIn, command: 'click.countIn', match: 'prefix'},
  {variant: 'slim', role: 'button', name: COPY.click, command: 'click.toggle', match: 'exact'},
  {variant: 'slim', role: 'button', name: COPY.minusMeName(COPY.mixControl), command: 'mix.minusMe', match: 'exact'},
  {variant: 'slim', role: 'button', name: COPY.mixSheet, command: 'mix.sheet', match: 'exact'},
].map(Object.freeze));
