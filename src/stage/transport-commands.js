// Transport, loop, speed, click, mix and navigation commands (architecture §3.1, spec §7.2).
// Importing this module registers them on the app registry (main.js and registry CI do);
// defineTransportCommands({registry}) registers them on any registry (tests).
//
// Definitions are eager and cheap (D46): this module imports only the registry and pure
// helpers. Every `run` reaches its work through the command context:
//   transport  c.transport, else c.session.transport (the Stage and Edit provide them)
//   session    c.session (mapped or not, the drum part for Chart playback)
//   focused    c.focused, the focused strip segment, bar-list row or Road map bar (focus.play,
//              focus.loop; D45): {kind: 'section'|'marker'|'bar', t0, t1, label, bar?}
//   stage      c.stage.openSheet(name, {anchor}) and c.stage.anchors (stage.js, §2.14.10)
// Outside the Stage (Edit's slim transport) the sheet commands open the sheet through
// src/stage/sheets/host.js (`openSheet(name, {session, anchor})`, §2.14.11), loaded on first
// use. A sheet's anchor is `args.anchor`, else `stage.anchors.get(<sheet name>)`.
//
// Commands with arguments are hidden from the palette's command list, except nav.goTo,
// speed.set and spot.open, which the palette reaches through parsed rows (S2):
//   nav.goTo {t, label?}                  seconds; cues when stopped, a quantized jump while playing
//   speed.set {rate}                      0.25–1.5
//   trainer.toggle {start, end, step, passes}   fractions; (re)starts the trainer with that configuration
//   loop.playTimes {n}, loop.between {mode}, loop.eachPass {on?}, click.mode {mode},
//   mix.chartAudio {level}
// Toggle and radio commands answer `checked` from the transport snapshot; a radio command
// reads `c.args` when the caller evaluates it with arguments (registry.state(id,
// registry.context({args}))).
//
// mix.minusMe / mix.onlyMe open the Mix sheet when no stem matches the player's instruments
// (the transport then emits 'mix-sheet' {reason: 'no-part'} and returns false, D37).
// mix.mute.N / mix.solo.N (N = 1…9) address stems in canonical order (`toggleMuteAt(N − 1)`).
// Background shortcuts (`global: true`) are transport.playStop, transport.again,
// transport.loopToggle, transport.stop and nav.nextSection (§3.5).

import {registry as appRegistry} from '../app/commands.js';
import {MIN_RATE, MAX_RATE} from '../../shared/practice.ts';

// Later-wave module, resolved by contract path (D2; Appendix C item 58): the sheets host (ST4).
const SHEETS = import.meta.glob('./sheets/host.js');
const SHEETS_PATH = './sheets/host.js';

const S = 'stage';
const E = 'edit';
const EM = 'edit.map';
const EC = 'edit.chart';
const SF = Object.freeze(['stage.strip', 'stage.bars']);
const ERASE = Object.freeze(['Backspace', 'Delete']);

export const STEM_KEYS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9]);
export const PLAY_TIMES = Object.freeze([0, 2, 4, 8]);
export const BETWEEN = Object.freeze(['none', 'rest', 'call']);
export const CLICK_MODES = Object.freeze(['off', 'countin', 'always']);
export const CHART_AUDIO = Object.freeze(['off', 'quiet', 'loud']);
/** Cue nudges in milliseconds (spec §7.2: ⌥←/→ 50 ms, ⌥⇧ 10 ms). */
export const NUDGE_MS = Object.freeze({coarse: 50, fine: 10});
/** Speed steps in percent (spec §4.6: , . ±5, ⇧ ±1). */
export const SPEED_STEP = Object.freeze({coarse: 5, fine: 1});
const EPS = 1e-6;

/** Titles, menu labels and disabled reasons (spec §3.1, §4.6, §4.7). */
export const COPY = Object.freeze({
  play: 'Play',
  stop: 'Stop',
  cancelCount: 'Cancel count-in',
  playStop: 'Play / Stop',
  pause: 'Pause',
  pauseContinue: 'Pause / continue',
  continue: 'Continue',
  again: 'Start again',
  stopOnly: 'Stop',
  loop: 'Loop',
  loopSection: 'Loop this section',
  playFromHere: 'Play from here',
  loopThis: 'Loop this',
  loopIn: 'Loop in at playhead',
  loopInExact: 'Loop in (unsnapped)',
  loopOut: 'Loop out at playhead',
  loopOutExact: 'Loop out (unsnapped)',
  clearLoop: 'Clear loop',
  moveBack: 'Move loop back by its length',
  moveFwd: 'Move loop forward by its length',
  loopCard: 'Loop options…',
  eachPass: 'Count in every pass',
  playTimes: 'Play N times then stop',
  between: 'Between passes',
  prevSection: 'Previous section',
  nextSection: 'Next section',
  prevMarker: 'Previous marker',
  nextMarker: 'Next marker',
  barBack: 'Back a bar',
  barFwd: 'Forward a bar',
  beatBack: 'Back a beat',
  beatFwd: 'Forward a beat',
  secondsBack: (s) => `Back ${s} s`,
  secondsFwd: (s) => `Forward ${s} s`,
  nudgeBack: (ms) => `Nudge cue −${ms} ms`,
  nudgeFwd: (ms) => `Nudge cue +${ms} ms`,
  home: 'Go to song start',
  homeLoop: 'Go to loop start',
  end: 'Go to song end',
  endLoop: 'Go to loop end',
  goTo: 'Go to bar or time…',
  goToTime: 'Go to time…',
  slower: (pct) => `Slower (−${pct}%)`,
  faster: (pct) => `Faster (+${pct}%)`,
  speed100: 'Speed 100%',
  speedBack: (pct) => `Speed ${pct}%`,
  speedToggle: 'Speed 100% ↔ last',
  setSpeed: 'Set speed…',
  speedSheet: 'Speed & trainer…',
  startTrainer: 'Start trainer',
  stopTrainer: 'Stop trainer',
  countIn: 'Count-in',
  leadIn: 'Lead-in 2 s',
  click: 'Click',
  clickMode: 'Click: Off / During count-in / Always',
  clickSheet: 'Click & count-in…',
  minusMe: 'Minus me',
  onlyMe: 'Only me',
  fullMix: 'Full mix',
  mute: (stem) => `Mute ${stem}`,
  solo: (stem) => `Solo ${stem}`,
  muteN: (n) => `Mute stem ${n}`,
  soloN: (n) => `Solo stem ${n}`,
  mixSheet: 'Mix…',
  chartAudio: 'Chart playback',
  // Disabled reasons (visible in the palette, menus and buttons).
  needsGrid: 'Needs a bar grid',
  slowest: `Already at the slowest speed (${Math.round(MIN_RATE * 100)}%).`,
  fastest: `Already at the fastest speed (${Math.round(MAX_RATE * 100)}%).`,
  speedRange: `Speed goes from ${Math.round(MIN_RATE * 100)}% to ${Math.round(MAX_RATE * 100)}%.`,
  at100: 'Already at 100%.',
  noRegions: 'Add a marker (S) to jump between parts of this song.',
  noSections: 'Add a section (S) to jump between parts of this song.',
  callNeedsPart: 'Call & response needs a stem for your instrument. Choose what you play in Settings → Instruments.',
});

const STEM_LABELS = Object.freeze({drums: 'Drums', bass: 'Bass', guitar: 'Guitar', piano: 'Piano', vocals: 'Vocals', other: 'Other'});

/** A stem's display name: 'drums' → 'Drums', 'no_vocals' → 'No vocals'. */
export function stemLabel(name) {
  const s = String(name ?? '');
  return STEM_LABELS[s.toLowerCase()] ?? s.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
}

// ---------------------------------------------------------------------------------------------------------------
// Context readers (pure apart from the reads; safe on a context with nothing provided)

const read = (sig) => (sig && typeof sig === 'object' && typeof sig.peek === 'function' ? sig.peek() : sig?.value ?? null);

/** The transport the command acts on: the provided one, else the session's. */
export function transportOf(c) {
  const t = c?.transport ?? c?.session?.transport ?? null;
  return t && typeof t === 'object' ? t : null;
}

/** The transport snapshot (TransportState), or null. */
export function snapshotOf(c) {
  const s = read(transportOf(c)?.snapshot);
  return s && typeof s === 'object' ? s : null;
}

/** True unless the session says the song has no real map (no session: mapped, so nothing is refused). */
export function isMapped(c) {
  const session = c?.session;
  if (!session) return true;
  if (session.map && 'isReal' in session.map) return !!session.map.isReal;
  const sig = session.position?.mapped;
  return sig ? !!read(sig) : true;
}

const hasTransport = (c) => !!transportOf(c);
const loopOf = (c) => snapshotOf(c)?.loop ?? null;
const hasRange = (loop) => !!loop && Number.isFinite(loop.a) && Number.isFinite(loop.b) && loop.b - loop.a > EPS;
const tracksOf = (c) => {
  const tracks = snapshotOf(c)?.mix?.tracks;
  return Array.isArray(tracks) ? tracks : [];
};
const trackAt = (c, n) => tracksOf(c)[n - 1] ?? null;
const rateOf = (c) => {
  const rate = snapshotOf(c)?.rate;
  return Number.isFinite(rate) ? rate : 1;
};
const pct = (rate) => Math.round(rate * 100);
const regionsOf = (c) => {
  const list = c?.session?.position?.regions?.();
  return Array.isArray(list) ? list : null;
};
const hasPart = (c) => !!c?.session?.notation?.part;
const argOf = (c, name) => (c?.args && typeof c.args === 'object' ? c.args[name] : undefined);

// ---------------------------------------------------------------------------------------------------------------
// The definitions

/**
 * Registers the §3.1 commands on `registry`. Returns off(). `sheets` maps the sheets host's
 * contract path to a loader (import.meta.glob form); tests pass their own.
 */
export function defineTransportCommands({registry = appRegistry, sheets = SHEETS} = {}) {
  /** Open a Stage sheet: the Stage's host when provided, else the sheets module (Edit's slim transport). */
  function openSheet(c, name) {
    const stage = c?.stage;
    const anchor = argOf(c, 'anchor') ?? stage?.anchors?.get?.(name) ?? null;
    if (typeof stage?.openSheet === 'function') return stage.openSheet(name, {anchor});
    const load = sheets?.[SHEETS_PATH];
    const session = c?.session;
    if (!load || !session) return undefined;
    return Promise.resolve().then(load).then((mod) => mod.openSheet(name, {session, anchor})).catch((err) => {
      console.warn(`[transport-commands] the ${name} sheet could not be opened`, err);
    });
  }
  const canOpenSheet = (c) => typeof c?.stage?.openSheet === 'function' || (!!c?.session && !!sheets?.[SHEETS_PATH]);

  /** Minus me / Only me; with no matching stem the transport asks for the Mix sheet (D37). */
  function mixMine(c, method, on) {
    const t = transportOf(c);
    let noPart = false;
    const off = typeof t.on === 'function' ? t.on('mix-sheet', () => { noPart = true; }) : null;
    try {
      t[method](typeof on === 'boolean' ? on : undefined);
    } finally {
      off?.();
    }
    if (noPart && on !== false) openSheet(c, 'mix');   // an explicit "off" never pops the sheet open
  }

  const transportDef = (def) => ({when: hasTransport, ...def});
  /** [ / ]: S adds a marker on an unmapped song and a section on a mapped one (§4.5), the regions they jump between. */
  const noRegionsReason = (c) => (regionsOf(c)?.length === 0 ? (isMapped(c) ? COPY.noSections : COPY.noRegions) : null);

  const defs = [
    // ---- play / stop --------------------------------------------------------------------------------------------
    transportDef({
      id: 'transport.playStop', group: 'Transport', keys: ['Space'], scopes: [S, E], pedal: true, global: true, icon: 'play',
      title: (c) => {
        const phase = snapshotOf(c)?.phase;
        if (phase === 'counting') return COPY.cancelCount;
        if (phase === 'playing') return COPY.stop;
        return phase ? COPY.play : COPY.playStop;
      },
      menu: {electron: 'Transport'},   // the label follows the title (Play · Stop · Cancel count-in)
      palette: {keywords: ['play', 'stop', 'start']},
      run: (c) => { void transportOf(c).playStop(); },
    }),
    transportDef({
      id: 'transport.pause', group: 'Transport', keys: ['Shift+Space'], scopes: [S, E], pedal: true, icon: 'pause',
      title: (c) => {
        const phase = snapshotOf(c)?.phase;
        if (phase === 'paused') return COPY.continue;
        return phase ? COPY.pause : COPY.pauseContinue;
      },
      palette: {keywords: ['pause', 'continue', 'resume', 'hold']},
      run: (c) => { void transportOf(c).pause(); },
    }),
    transportDef({
      id: 'transport.again', title: COPY.again, group: 'Transport', keys: ['Enter'], scopes: [S, EC], pedal: true, global: true,
      icon: 'rotate-ccw', menu: {label: COPY.again, electron: 'Transport'},
      palette: {keywords: ['again', 'repeat', 'restart', 'from the top']},
      run: (c) => { void transportOf(c).again(); },
    }),
    transportDef({
      id: 'transport.stop', title: COPY.stopOnly, group: 'Transport', pedal: true, global: true, icon: 'square',
      palette: {keywords: ['stop', 'halt']},
      run: (c) => { transportOf(c).stop(); },
    }),

    // ---- loop ---------------------------------------------------------------------------------------------------
    transportDef({
      id: 'transport.loopToggle', title: COPY.loop, group: 'Loop', keys: ['KeyL'], scopes: [S], pedal: true, global: true, icon: 'repeat',
      checked: (c) => !!loopOf(c)?.on, menu: {label: COPY.loop, electron: 'Transport'},
      palette: {keywords: ['loop', 'repeat section']},
      run: (c) => { transportOf(c).toggleLoop(); },
    }),
    transportDef({
      id: 'transport.loopSection', title: COPY.loopSection, group: 'Loop', keys: ['Shift+KeyL'], scopes: [S], pedal: true, icon: 'repeat-1',
      palette: {keywords: ['loop section', 'loop part']},
      run: (c) => { transportOf(c).loopSection(); },
    }),
    {
      id: 'focus.play', title: COPY.playFromHere, group: 'Transport', keys: ['Enter'], scopes: [...SF], icon: 'play',
      when: (c) => hasTransport(c) && Number.isFinite(c?.focused?.t0), palette: {hidden: true},
      run: (c) => { void transportOf(c).playFrom(c.focused.t0); },
    },
    {
      id: 'focus.loop', title: COPY.loopThis, group: 'Loop', keys: ['KeyL'], scopes: [...SF], icon: 'repeat',
      when: (c) => {
        const f = c?.focused;
        return hasTransport(c) && Number.isFinite(f?.t0) && (f.kind === 'bar' || (Number.isFinite(f.t1) && f.t1 > f.t0));
      },
      palette: {hidden: true},
      run: (c) => {
        const f = c.focused, t = transportOf(c);
        // A bar region carries its own lines; a bar without an end loops that one bar of the map.
        if (Number.isFinite(f.t1) && f.t1 > f.t0) t.loopRange(f.t0, f.t1, {snap: 'none'});
        else t.loopBars(f.t0, 1);
      },
    },
    transportDef({
      id: 'loop.in', title: COPY.loopIn, group: 'Loop', keys: ['KeyI'], scopes: [S, EM], icon: 'chevron-right',
      palette: {keywords: ['loop start', 'in point', 'set start']},
      run: (c) => { transportOf(c).loopIn(); },
    }),
    transportDef({
      id: 'loop.inExact', title: COPY.loopInExact, group: 'Loop', keys: ['Shift+KeyI'], scopes: [S, EM],
      palette: {keywords: ['loop start exact']},
      run: (c) => { transportOf(c).loopIn({exact: true}); },
    }),
    transportDef({
      id: 'loop.out', title: COPY.loopOut, group: 'Loop', keys: ['KeyO'], scopes: [S, EM], icon: 'chevron-left',
      palette: {keywords: ['loop end', 'out point', 'set end']},
      run: (c) => { transportOf(c).loopOut(); },
    }),
    transportDef({
      id: 'loop.outExact', title: COPY.loopOutExact, group: 'Loop', keys: ['Shift+KeyO'], scopes: [S, EM],
      palette: {keywords: ['loop end exact']},
      run: (c) => { transportOf(c).loopOut({exact: true}); },
    }),
    {
      id: 'loop.clear', title: COPY.clearLoop, group: 'Loop', keys: [...ERASE], scopes: [S], icon: 'x',
      when: (c) => hasTransport(c) && (!!loopOf(c)?.on || hasRange(loopOf(c))),
      palette: {keywords: ['remove loop', 'no loop']},
      run: (c) => { transportOf(c).clearLoop(); },
    },
    {
      id: 'loop.moveBack', title: COPY.moveBack, group: 'Loop', keys: ['Shift+['], scopes: [S], icon: 'arrow-left',
      when: (c) => hasTransport(c) && hasRange(loopOf(c)),
      run: (c) => { transportOf(c).moveLoop(-1); },
    },
    {
      id: 'loop.moveFwd', title: COPY.moveFwd, group: 'Loop', keys: ['Shift+]'], scopes: [S], icon: 'arrow-right',
      when: (c) => hasTransport(c) && hasRange(loopOf(c)),
      run: (c) => { transportOf(c).moveLoop(1); },
    },
    {
      id: 'loop.card', title: COPY.loopCard, group: 'Loop', scopes: [S, E], icon: 'repeat',
      when: (c) => hasTransport(c) && canOpenSheet(c), palette: {keywords: ['loop options', 'loop settings']},
      run: (c) => { openSheet(c, 'loop'); },
    },
    transportDef({
      id: 'loop.eachPass', title: COPY.eachPass, group: 'Loop', scopes: [S, E], icon: 'count-in',
      checked: (c) => !!loopOf(c)?.eachPassCount, palette: {keywords: ['count in every loop', 'count each pass']},
      run: (c) => {
        const on = argOf(c, 'on');
        transportOf(c).setLoopOptions({eachPassCount: typeof on === 'boolean' ? on : !loopOf(c)?.eachPassCount});
      },
    }),
    transportDef({
      id: 'loop.playTimes', title: COPY.playTimes, group: 'Loop', scopes: [S], palette: {hidden: true},
      checked: (c) => {
        const n = argOf(c, 'n'), current = loopOf(c)?.playTimes ?? 0;
        return n === undefined ? current > 0 : current === n;
      },
      run: (c) => {
        const n = argOf(c, 'n');
        if (PLAY_TIMES.includes(n)) transportOf(c).setLoopOptions({playTimes: n});
      },
    }),
    transportDef({
      id: 'loop.between', title: COPY.between, group: 'Loop', scopes: [S], palette: {hidden: true},
      disabledReason: (c) => (argOf(c, 'mode') === 'call' && !(snapshotOf(c)?.mix?.mine?.length) ? COPY.callNeedsPart : null),
      checked: (c) => {
        const mode = argOf(c, 'mode'), current = loopOf(c)?.between ?? 'none';
        return mode === undefined ? current !== 'none' : current === mode;
      },
      run: (c) => {
        const mode = argOf(c, 'mode');
        if (BETWEEN.includes(mode)) transportOf(c).setLoopOptions({between: mode});
      },
    }),

    // ---- navigation ---------------------------------------------------------------------------------------------
    transportDef({
      id: 'nav.prevSection', group: 'Navigate', keys: ['[', 'PageUp'], scopes: [S, EM], pedal: true, icon: 'chevron-left',
      title: (c) => (isMapped(c) ? COPY.prevSection : COPY.prevMarker),
      disabledReason: noRegionsReason,
      palette: {keywords: ['previous part', 'back a section']},
      run: (c) => { transportOf(c).goToRegion(-1); },
    }),
    transportDef({
      id: 'nav.nextSection', group: 'Navigate', keys: [']', 'PageDown'], scopes: [S, EM], pedal: true, global: true, icon: 'chevron-right',
      title: (c) => (isMapped(c) ? COPY.nextSection : COPY.nextMarker),
      disabledReason: noRegionsReason,
      palette: {keywords: ['next part', 'skip section']},
      run: (c) => { transportOf(c).goToRegion(1); },
    }),
    transportDef({
      id: 'nav.barBack', group: 'Navigate', keys: ['ArrowLeft'], scopes: [S], pedal: true, repeat: true, icon: 'arrow-left',
      title: (c) => (isMapped(c) ? COPY.barBack : COPY.secondsBack(5)),
      run: (c) => { transportOf(c).step('bar', -1); },
    }),
    transportDef({
      id: 'nav.barFwd', group: 'Navigate', keys: ['ArrowRight'], scopes: [S], pedal: true, repeat: true, icon: 'arrow-right',
      title: (c) => (isMapped(c) ? COPY.barFwd : COPY.secondsFwd(5)),
      run: (c) => { transportOf(c).step('bar', 1); },
    }),
    transportDef({
      id: 'nav.beatBack', group: 'Navigate', keys: ['Shift+ArrowLeft'], scopes: [S], repeat: true,
      title: (c) => (isMapped(c) ? COPY.beatBack : COPY.secondsBack(1)),
      run: (c) => { transportOf(c).step('beat', -1); },
    }),
    transportDef({
      id: 'nav.beatFwd', group: 'Navigate', keys: ['Shift+ArrowRight'], scopes: [S], repeat: true,
      title: (c) => (isMapped(c) ? COPY.beatFwd : COPY.secondsFwd(1)),
      run: (c) => { transportOf(c).step('beat', 1); },
    }),
    transportDef({
      id: 'cue.nudgeBack', title: COPY.nudgeBack(NUDGE_MS.coarse), group: 'Navigate', keys: ['Alt+ArrowLeft'], scopes: [S], repeat: true,
      run: (c) => { transportOf(c).nudgeCue(-NUDGE_MS.coarse); },
    }),
    transportDef({
      id: 'cue.nudgeFwd', title: COPY.nudgeFwd(NUDGE_MS.coarse), group: 'Navigate', keys: ['Alt+ArrowRight'], scopes: [S], repeat: true,
      run: (c) => { transportOf(c).nudgeCue(NUDGE_MS.coarse); },
    }),
    transportDef({
      id: 'cue.nudgeBackFine', title: COPY.nudgeBack(NUDGE_MS.fine), group: 'Navigate', keys: ['Alt+Shift+ArrowLeft'], scopes: [S], repeat: true,
      run: (c) => { transportOf(c).nudgeCue(-NUDGE_MS.fine); },
    }),
    transportDef({
      id: 'cue.nudgeFwdFine', title: COPY.nudgeFwd(NUDGE_MS.fine), group: 'Navigate', keys: ['Alt+Shift+ArrowRight'], scopes: [S], repeat: true,
      run: (c) => { transportOf(c).nudgeCue(NUDGE_MS.fine); },
    }),
    transportDef({
      id: 'nav.home', group: 'Navigate', keys: ['Home'], scopes: [S],
      title: (c) => (loopOf(c)?.on ? COPY.homeLoop : COPY.home), palette: {keywords: ['beginning', 'start of song']},
      run: (c) => { transportOf(c).home(); },
    }),
    transportDef({
      id: 'nav.end', group: 'Navigate', keys: ['End'], scopes: [S],
      title: (c) => (loopOf(c)?.on ? COPY.endLoop : COPY.end), palette: {keywords: ['end of song']},
      run: (c) => { transportOf(c).end(); },
    }),
    transportDef({
      id: 'nav.goTo', group: 'Navigate', scopes: [S, E], icon: 'arrow-right',
      title: (c) => (isMapped(c) ? COPY.goTo : COPY.goToTime),
      run: (c) => {
        const t = argOf(c, 't'), label = argOf(c, 'label');
        if (Number.isFinite(t)) transportOf(c).jump(t, {label: typeof label === 'string' ? label : null});
      },
    }),

    // ---- speed --------------------------------------------------------------------------------------------------
    transportDef({
      id: 'speed.down', title: COPY.slower(SPEED_STEP.coarse), group: 'Speed', keys: [','], scopes: [S, EC], pedal: true, repeat: true,
      icon: 'minus', disabledReason: (c) => (rateOf(c) <= MIN_RATE + EPS ? COPY.slowest : null),
      palette: {keywords: ['slower', 'speed down', 'tempo down']},
      run: (c) => { transportOf(c).nudgeSpeed(-SPEED_STEP.coarse); },
    }),
    transportDef({
      id: 'speed.up', title: COPY.faster(SPEED_STEP.coarse), group: 'Speed', keys: ['.'], scopes: [S, EC], pedal: true, repeat: true,
      icon: 'plus', disabledReason: (c) => (rateOf(c) >= MAX_RATE - EPS ? COPY.fastest : null),
      palette: {keywords: ['faster', 'speed up', 'tempo up']},
      run: (c) => { transportOf(c).nudgeSpeed(SPEED_STEP.coarse); },
    }),
    transportDef({
      id: 'speed.downFine', title: COPY.slower(SPEED_STEP.fine), group: 'Speed', keys: ['Shift+,'], scopes: [S, EC], repeat: true,
      disabledReason: (c) => (rateOf(c) <= MIN_RATE + EPS ? COPY.slowest : null),
      run: (c) => { transportOf(c).nudgeSpeed(-SPEED_STEP.fine); },
    }),
    transportDef({
      id: 'speed.upFine', title: COPY.faster(SPEED_STEP.fine), group: 'Speed', keys: ['Shift+.'], scopes: [S, EC], repeat: true,
      disabledReason: (c) => (rateOf(c) >= MAX_RATE - EPS ? COPY.fastest : null),
      run: (c) => { transportOf(c).nudgeSpeed(SPEED_STEP.fine); },
    }),
    transportDef({
      id: 'speed.toggle100', group: 'Speed', keys: ['`'], scopes: [S, EC], pedal: true, icon: 'gauge',
      title: (c) => {
        const s = snapshotOf(c);
        if (!s) return COPY.speedToggle;
        if (s.rate !== 1) return COPY.speed100;
        return Number.isFinite(s.lastRate) && s.lastRate !== 1 ? COPY.speedBack(pct(s.lastRate)) : COPY.speedToggle;
      },
      disabledReason: (c) => {
        const s = snapshotOf(c);
        return s && s.rate === 1 && !(Number.isFinite(s.lastRate) && s.lastRate !== 1) ? COPY.at100 : null;
      },
      palette: {keywords: ['100%', 'normal speed', 'full speed', 'last speed']},
      run: (c) => { transportOf(c).toggleSpeed100(); },
    }),
    transportDef({
      id: 'speed.set', title: COPY.setSpeed, group: 'Speed', scopes: [S, E], icon: 'gauge',
      disabledReason: (c) => {
        const rate = argOf(c, 'rate');
        return Number.isFinite(rate) && (rate < MIN_RATE - EPS || rate > MAX_RATE + EPS) ? COPY.speedRange : null;
      },
      run: (c) => {
        const rate = argOf(c, 'rate');
        if (Number.isFinite(rate)) transportOf(c).setSpeed(rate, {coalesce: false});
      },
    }),
    {
      id: 'speed.sheet', title: COPY.speedSheet, group: 'Speed', scopes: [S, E], icon: 'gauge',
      when: (c) => hasTransport(c) && canOpenSheet(c), palette: {keywords: ['speed', 'tempo', 'trainer', 'keep pitch']},
      run: (c) => { openSheet(c, 'speed'); },
    },
    transportDef({
      id: 'trainer.toggle', group: 'Speed', scopes: [S], pedal: true, icon: 'trainer',
      title: (c) => (snapshotOf(c)?.trainer ? COPY.stopTrainer : COPY.startTrainer),
      checked: (c) => !!snapshotOf(c)?.trainer,
      palette: {keywords: ['trainer', 'speed trainer', 'ramp up', 'gradually faster']},
      run: (c) => {
        const t = transportOf(c), args = c.args;
        const cfg = args && typeof args === 'object' && Number.isFinite(args.start) && Number.isFinite(args.end)
          ? {start: args.start, end: args.end, ...(Number.isFinite(args.step) ? {step: args.step} : {}), ...(Number.isFinite(args.passes) ? {passes: args.passes} : {})}
          : null;
        if (cfg) t.startTrainer(cfg);
        else if (snapshotOf(c)?.trainer) t.stopTrainer();
        else t.startTrainer();
      },
    }),

    // ---- click and count-in (D14) -------------------------------------------------------------------------------
    transportDef({
      id: 'click.countIn', group: 'Click', keys: ['KeyC'], scopes: [S, E], pedal: true, icon: 'count-in',
      title: (c) => (isMapped(c) ? COPY.countIn : COPY.leadIn),
      checked: (c) => !!snapshotOf(c)?.countIn?.on,
      menu: {electron: 'Transport'},   // the label follows the title (Count-in · Lead-in 2 s)
      palette: {keywords: ['count in', 'count-in', 'lead in', 'pre-roll']},
      run: (c) => { transportOf(c).toggleCountIn(); },
    }),
    transportDef({
      id: 'click.toggle', title: COPY.click, group: 'Click', keys: ['KeyK'], scopes: [S, E], pedal: true, icon: 'metronome',
      checked: (c) => snapshotOf(c)?.click?.mode === 'always', disabledReason: (c) => (isMapped(c) ? null : COPY.needsGrid),
      menu: {label: COPY.click, electron: 'Transport'}, palette: {keywords: ['click', 'metronome', 'click track']},
      run: (c) => { transportOf(c).toggleClick(); },
    }),
    transportDef({
      id: 'click.mode', title: COPY.clickMode, group: 'Click', scopes: [S, E], icon: 'metronome', palette: {hidden: true},
      disabledReason: (c) => (isMapped(c) ? null : COPY.needsGrid),
      checked: (c) => {
        const mode = argOf(c, 'mode'), current = snapshotOf(c)?.click?.mode;
        return mode === undefined ? current === 'always' : current === mode;
      },
      run: (c) => {
        const mode = argOf(c, 'mode');
        if (CLICK_MODES.includes(mode)) transportOf(c).setClickMode(mode);
      },
    }),
    {
      id: 'click.sheet', title: COPY.clickSheet, group: 'Click', scopes: [S, E], icon: 'metronome',
      when: (c) => hasTransport(c) && canOpenSheet(c), palette: {keywords: ['click settings', 'count-in settings', 'metronome']},
      run: (c) => { openSheet(c, 'click'); },
    },

    // ---- mix (D37) ----------------------------------------------------------------------------------------------
    transportDef({
      id: 'mix.minusMe', title: COPY.minusMe, group: 'Mix', keys: ['KeyM'], scopes: [S, EM], pedal: true, icon: 'minus-me',
      checked: (c) => !!snapshotOf(c)?.mix?.minusMe, menu: {label: COPY.minusMe, electron: 'Transport'},
      palette: {keywords: ['minus me', 'mute my part', 'mute me', 'play along']},
      run: (c) => mixMine(c, 'minusMe', argOf(c, 'on')),
    }),
    transportDef({
      id: 'mix.onlyMe', title: COPY.onlyMe, group: 'Mix', keys: ['Shift+KeyM'], scopes: [S, EM], pedal: true, icon: 'headphones',
      checked: (c) => !!snapshotOf(c)?.mix?.onlyMe, palette: {keywords: ['only me', 'solo my part']},
      run: (c) => mixMine(c, 'onlyMe', argOf(c, 'on')),
    }),
    transportDef({
      id: 'mix.full', title: COPY.fullMix, group: 'Mix', keys: ['Digit0'], scopes: [S], pedal: true, icon: 'layers',
      palette: {keywords: ['full mix', 'reset mix', 'unmute all']},
      run: (c) => { transportOf(c).fullMix(); },
    }),
    {
      id: 'mix.sheet', title: COPY.mixSheet, group: 'Mix', scopes: [S, E], icon: 'sliders-horizontal',
      when: (c) => hasTransport(c) && canOpenSheet(c), palette: {keywords: ['mix', 'mixer', 'stems', 'levels', 'volume']},
      run: (c) => { openSheet(c, 'mix'); },
    },
    {
      id: 'mix.chartAudio', title: COPY.chartAudio, group: 'Mix', scopes: [S, E], icon: 'drum', palette: {hidden: true},
      when: (c) => hasTransport(c) && hasPart(c),
      checked: (c) => {
        const level = argOf(c, 'level'), current = snapshotOf(c)?.mix?.chartAudio ?? 'off';
        return level === undefined ? current !== 'off' : current === level;
      },
      run: (c) => {
        const level = argOf(c, 'level');
        if (CHART_AUDIO.includes(level)) transportOf(c).setChartAudio(level);
      },
    },
  ];

  const offMany = registry.registerMany(defs);
  const offMute = registry.registerDynamic({
    id: 'mix.mute.{n}', group: 'Mix', keys: ['Digit{n}'], scopes: [S], icon: 'volume-x',
    title: (c, n) => {
      const track = trackAt(c, n);
      return track ? COPY.mute(stemLabel(track.name)) : COPY.muteN(n);
    },
    when: (c, n) => hasTransport(c) && !!trackAt(c, n),
    checked: (c, n) => !!trackAt(c, n)?.muted,
    palette: {keywords: ['mute']},
    run: (c, {n}) => { transportOf(c).toggleMuteAt(n - 1); },
  }, STEM_KEYS);
  const offSolo = registry.registerDynamic({
    id: 'mix.solo.{n}', group: 'Mix', keys: ['Shift+Digit{n}'], scopes: [S], icon: 'headphones',
    title: (c, n) => {
      const track = trackAt(c, n);
      return track ? COPY.solo(stemLabel(track.name)) : COPY.soloN(n);
    },
    when: (c, n) => hasTransport(c) && !!trackAt(c, n),
    checked: (c, n) => !!trackAt(c, n)?.soloed,
    palette: {keywords: ['solo']},
    run: (c, {n}) => { transportOf(c).toggleSoloAt(n - 1); },
  }, STEM_KEYS);
  return () => { offSolo(); offMute(); offMany(); };
}

defineTransportCommands();
