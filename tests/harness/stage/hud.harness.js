// ST5's harness (/__harness/hud): the Stage HUD and the control set on a real song session
// (tests/helpers/test-session.js in the browser: SongMapStore, Metronome, MultitrackEngine on the
// page's AudioContext over silent stems, transport, practice state, undo), laid out like the
// Stage frame: band (HUD band · music · dock) or rail (music · rail with readouts and controls).
// States: tests/fixture/states/ST5.cjs. Use fx-audio=manual so audio time moves only on request.
//
// Query:
//   layout=band|rail      default band
//   distance=near|stand|kit   default stand
//   focus=1               Focus (band: no identity row; rail: the 120 px mini rail + mini controls)
//   variant=slim          only the slim transport (Edit's), on a desk background
//   mapped=0              a song nobody mapped (no bar grid)
//   song=pickup|seven     the pickup or 7/8 (2+2+3) map instead of the rehearsal song
//   scenario=             fresh (default) | looping (Chorus loop, 75%, drums out, pass counter) |
//                         trainer (a trainer on the Bridge loop) | solo (bass solo) | countin (count-in on) |
//                         marked (unmapped markers) | shared (read-only, Shared by …) | setlist
//   load=hold             the audio never finishes loading (the Play ring; Play arms "Play when ready")
//   load=error            the audio fails to load (every control aria-disabled with the reason)
//   load=decoding|progress|preparing   the controls see a held load at that point ('Decoding 1 of 4',
//                         'Loading 62%', 'Preparing'); window.__hud.setLoad({...}) moves it (I2a-13)
//   ready=1               a `1 ready` chip (a song finished processing)
//   wake=1 / pedal=1      the ☼ and ⎍ indicators
//   cue=<s>               the cue (default 0)
// window.__hud = {ts, session, hud, controls, sheets: [names opened], calls: [Stage methods run]} for the states.
//
// The Stage's own commands (stage.leave, stage.notes, stage.menu, view.focus, setlist.prev/next) are
// ST4's src/stage/commands.js, imported here so the identity row's controls are live; the stand-in
// Stage object below records what they ask of the Stage. Every ST5 state lists that module in
// opts.requires (architecture §9.0: skipped until ST4 merges, strict at integration).
import {registry} from '../../../src/app/commands.js';
import '../../../src/stage/commands.js';
import {signal} from '../../../src/app/store.js';
import {mountHud} from '../../../src/stage/hud.js';
import {mountControls} from '../../../src/stage/controls.js';
import {createTestSession, waitForLoad} from '../../helpers/test-session.js';
import {pickup, sectioned, sevenEight} from '../../fixtures/maps.js';

/** The held load states (load=…): what the session's `load` signal reads at that point (session.js). */
const HELD_LOADS = Object.freeze({
  decoding: {phase: 'decoding', loadedBytes: 4, totalBytes: 4, decoded: 0, tracks: 4, error: null},
  progress: {phase: 'loading', loadedBytes: 62, totalBytes: 100, decoded: 0, tracks: 4, error: null},
  preparing: {phase: 'preparing', loadedBytes: 4, totalBytes: 4, decoded: 4, tracks: 4, error: null},
});

const SCENARIOS = {
  fresh: () => null,
  looping: () => practice({cue: 32, rate: 0.75, loop: {on: true, a: 32, b: 48}, minusMe: true,
    tracks: [{name: 'drums', volume: 1, muted: true, soloed: false}]}),
  trainer: () => practice({cue: 80, loop: {on: true, a: 80, b: 96},
    trainer: {start: 0.7, end: 1, step: 0.05, passes: 2}}),
  solo: () => practice({tracks: [{name: 'bass', volume: 1, muted: false, soloed: true}]}),
  countin: () => practice({click: {countIn: {on: true, length: 1, unit: 'bars'}, mode: 'countin', lastMode: 'countin', accent: true, volume: 0.7, preRoll: false}}),
  marked: () => practice({cue: 12, markers: [
    {id: 'm1', t: 4, label: 'Marker 1', updatedAt: 1}, {id: 'm2', t: 20, label: 'bridge?', updatedAt: 1},
  ]}),
  shared: () => null,
  setlist: () => null,
};

function practice(fields) {
  return {v: 2, cue: 0, rate: 1, loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none'},
    tracks: [], minusMe: false, trainer: null, spots: [], markers: [], ...fields,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none', ...(fields.loop ?? {})}};
}

const tempoFor = (song) => (song === 'pickup' ? pickup : song === 'seven' ? sevenEight : sectioned);

export default async function mount(el, {query, h}) {
  const layout = query.get('layout') === 'rail' ? 'rail' : 'band';
  const distance = ['near', 'stand', 'kit'].includes(query.get('distance')) ? query.get('distance') : 'stand';
  const focus = query.get('focus') === '1';
  const slim = query.get('variant') === 'slim';
  const mapped = query.get('mapped') !== '0';
  const scenario = SCENARIOS[query.get('scenario')] ? query.get('scenario') : 'fresh';
  const song = tempoFor(query.get('song'));
  const cue = Number(query.get('cue')) || 0;

  const stored = SCENARIOS[scenario]();
  const startPractice = stored ?? (cue ? practice({cue}) : null);
  if (startPractice && cue) startPractice.cue = cue;

  const ts = await createTestSession({
    id: 'glasshouse', title: 'Glasshouse', artist: 'Northbound',
    tempo: mapped ? structuredClone(song.tempo) : null, mapped, duration: song.duration,
    practice: startPractice,
    song: {musicalKey: 'A minor', tuning: 'Standard', notes: 'Watch the flam into the chorus.', ...(scenario === 'shared' ? {ownerName: 'Kyle K.'} : {})},
    shared: scenario === 'shared' ? {token: 'harness-share'} : null,
    // load=hold: the stems are never signed, so the audio stays loading (the Play ring).
    ...(HELD_LOADS[query.get('load')] || query.get('load') === 'hold' ? {media: {signKeys: () => new Promise(() => {})}} : {}),
    ...(query.get('load') === 'error' ? {media: {signKeys: async () => { throw new Error('harness: storage down'); }}} : {}),
    load: false,
  });
  // load=decoding|progress|preparing: the audio is held (as load=hold) and the controls read a load
  // state the harness sets, so a state can capture Play mid-decode (the real phases pass in a blink).
  const heldLoad = HELD_LOADS[query.get('load')] ? signal({...HELD_LOADS[query.get('load')]}) : null;
  const session = heldLoad ? Object.create(ts.session, {load: {value: heldLoad}}) : ts.session;

  // The Stage frame (ST4's stage.js does this in the app): Stage tokens on the root, a music area
  // the count-in plate overlays, and the 'session' / 'transport' / 'stage' command contexts.
  const root = document.documentElement;
  root.dataset.place = 'stage';
  root.dataset.stageTheme = root.dataset.stageTheme || 'dark';
  el.style.padding = '0';
  el.style.overflow = 'hidden';
  const sheets = [];
  const anchors = new Map();
  const wake = signal(query.get('wake') === '1');
  const pedal = signal(query.get('pedal') === '1');
  const setlist = signal(scenario === 'setlist' ? {id: 'set-1', name: 'Friday gig', index: 1, count: 5, prev: {title: 'Low Tide'}, next: {title: 'Second Wind'}} : null);
  const ready = signal(query.get('ready') === '1' ? [{id: 'lowtide', title: 'Low Tide'}] : []);
  const calls = [];
  const focusSig = signal(focus);
  const stage = {
    session, layout, anchors, wakeLock: {held: wake}, pedalMode: pedal, setlist, focus: focusSig, menuAvailable: true,
    openSheet(name) { sheets.push(name); frame.dataset.sheet = name; return {close() {}}; },
    closeSheets() {},
    openMenu(name) { calls.push(`openMenu:${name}`); return {close() {}}; },
    leave() { calls.push('leave'); },
    toggleFocus() { calls.push('toggleFocus'); focusSig.value = !focusSig.peek(); },
    goSetlist(dir) { calls.push(`goSetlist:${dir}`); },
  };
  registry.provide('session', () => session);
  registry.provide('transport', () => session.transport);
  registry.provide('stage', () => stage);

  const frame = h('div', {class: 'st5-frame', 'data-testid': 'stage-frame'});
  frame.dataset.stageLayout = layout;
  frame.dataset.distance = distance;
  if (focus) frame.dataset.focus = '';
  if (layout === 'rail' && innerWidth < 1280) frame.dataset.railNarrow = '';
  const music = h('div', {class: 'st5-music', 'data-testid': 'music'},
    h('p', {class: 'st5-music-note'}, 'Music surface'));
  const css = (node, text) => { node.style.cssText = text; return node; };
  css(frame, 'position: fixed; inset: 0; display: flex; background: var(--bg); color: var(--ink);');
  css(music, 'position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; display: grid; place-items: center; background: var(--bg); border: 1px dashed var(--line);');
  music.firstChild.style.cssText = 'color: var(--ink-3); font: var(--fw-semibold) var(--fs-16)/1 var(--font-ui);';

  let hud = null, controls = null;
  if (slim) {
    root.dataset.place = '';
    delete root.dataset.place;
    css(frame, 'position: fixed; inset: 0; display: flex; flex-direction: column; justify-content: flex-end; background: var(--bg); color: var(--ink);');
    const bar = css(h('div', {'data-testid': 'slim'}), 'border-top: 1px solid var(--line); background: var(--surface);');
    frame.append(music, bar);
    controls = mountControls(bar, {session, variant: 'slim', stage});
  } else if (layout === 'band') {
    css(frame, `${frame.style.cssText} flex-direction: column;`);
    const top = css(h('div', {'data-testid': 'hud-band'}), 'flex: none; background: var(--surface); border-bottom: 1px solid var(--line);');
    const dock = css(h('div', {'data-testid': 'dock'}), `flex: none; background: var(--surface); border-top: 1px solid var(--line);${focus ? ' display: none;' : ''}`);
    frame.append(top, music, dock);
    hud = mountHud(top, {session, stage, plateHost: music, jobs: {ready}});
    controls = mountControls(dock, {session, variant: 'dock', stage});
  } else {
    const rail = css(h('aside', {'data-testid': 'rail', 'aria-label': 'Stage rail'}),
      `flex: none; width: ${focus ? '120px' : 'var(--rail-w)'}; display: flex; flex-direction: column; justify-content: space-between; background: var(--surface); border-left: 1px solid var(--line); overflow: hidden;`);
    const top = h('div', {'data-testid': 'hud-rail'});
    const bottom = h('div', {'data-testid': 'rail-controls'});
    rail.append(top, bottom);
    frame.append(music, rail);
    hud = mountHud(top, {session, stage, plateHost: music, jobs: {ready}});
    controls = mountControls(bottom, {session, variant: focus ? 'mini' : 'rail', stage});
  }
  hud?.setLayout(layout);
  hud?.setFocus(focus);
  if (scenario === 'shared' && hud) hud.actionSlot.append(h('button', {type: 'button', class: 'ui-button', dataset: {size: 'sm'}}, 'Add to my library'));
  el.append(frame);
  session.frame.start();

  window.__hud = {ts, session, hud, controls, sheets, calls, stage, wake, pedal, setlist, ready,
    setLoad: (l) => { if (heldLoad) heldLoad.value = {...heldLoad.peek(), ...l}; }};
  if (query.get('load') !== 'hold' && !heldLoad) {
    await waitForLoad(session);
    if (scenario === 'trainer') session.transport.startTrainer();
  }
  frame.dataset.loadPhase = session.load.peek().phase;
  session.load.subscribe((l) => { frame.dataset.loadPhase = l.phase; });
  session.transport.snapshot.subscribe((s) => { frame.dataset.transportPhase = s.phase; });
  frame.dataset.transportPhase = session.transport.snapshot.peek().phase;
  return {ts, hud, controls};
}
