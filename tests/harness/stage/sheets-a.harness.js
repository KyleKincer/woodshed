// ST7's harness (/__harness/sheets-a): the Speed, Click and Mix sheets opened through the real
// sheets host (src/stage/sheets/host.js: a bottom Sheet on the band, a 360 px popover left of the
// rail control on the rail) on a real song session (tests/helpers/test-session.js in the browser
// over the fixture's synthetic stems), in a Stage frame stand-in: band (music · dock with the
// Speed, Click and Mix controls) or rail (music · rail with them at the bottom). The app registry
// carries the transport and Stage commands (edit.map, stage.tapBeat, stage.getBars, song.resplit)
// and the dispatcher runs, so Esc and the registry keys behave as in the Stage.
// States: tests/fixture/states/ST7.cjs (use fx-audio=manual so audio time moves only on request).
//
// Query:
//   sheet=speed|click|mix   the sheet opened on load (default none: press a frame control)
//   layout=band|rail        default: rail on a wide viewport, band otherwise (layout.js's rule)
//   mapped=0                a song nobody mapped (Lead-in, "Needs a bar grid")
//   scenario=               fresh (default) | looping (the Chorus loop at 75%, drums out, count-in 2 bars)
//                           | trainer (a two-bar loop for a quick trainer run)
//   profile=drums|guitar|none|drums,bass   the account profile's instruments (default drums)
//   stems=a,b,…             stem names (default the rehearsal song's four)
//   part=1                  the song has a drum part (Chart playback)
//   desktop=1               Woodshed for desktop (Re-split with 6 stems)
//   shared=1                a read-only Shared Stage session
// window.__sheets = {ts, session, open(name), sheets: [names the Stage was asked to open], navigations, patches}
import {registry} from '../../../src/app/commands.js';
import {startDispatcher} from '../../../src/app/dispatch.js';
import {signal} from '../../../src/app/store.js';
import '../../../src/stage/transport-commands.js';
import '../../../src/stage/commands.js';
import {openSheet, closeSheets, setSheetModules} from '../../../src/stage/sheets/host.js';
import {render as renderSpeed} from '../../../src/stage/sheets/speed.js';
import {render as renderClick} from '../../../src/stage/sheets/click.js';
import {render as renderMix} from '../../../src/stage/sheets/mix.js';
import {emptyScore} from '../../../shared/notation.ts';
import {createTestSession, waitForLoad} from '../../helpers/test-session.js';
import {stemUrl} from '../../fixture/audio.js';
import {sectioned} from '../../fixtures/maps.js';

const PROFILES = {
  drums: ['drums'], guitar: ['guitar'], none: [], 'drums,bass': ['drums', 'bass'],
};

function practice(fields = {}) {
  return {v: 2, cue: 0, rate: 1, tracks: [], minusMe: false, trainer: null, spots: [], markers: [], ...fields,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none', ...(fields.loop ?? {})}};
}

const SCENARIOS = {
  fresh: () => practice(),
  looping: () => practice({cue: 32, rate: 0.75, loop: {on: true, a: 32, b: 48}, minusMe: true,
    tracks: [{name: 'drums', volume: 1, muted: true, soloed: false}, {name: 'bass', volume: 0.6, muted: false, soloed: false}],
    click: {countIn: {on: true, length: 2, unit: 'bars'}, mode: 'countin', lastMode: 'countin', accent: true, volume: 0.7, preRoll: false}}),
  trainer: () => practice({cue: 32, loop: {on: true, a: 32, b: 36}}),
};

export default async function mount(el, {query, h}) {
  const wide = innerWidth / innerHeight >= 1.15 && innerWidth >= 1000;
  const layout = query.get('layout') === 'band' || query.get('layout') === 'rail' ? query.get('layout') : wide ? 'rail' : 'band';
  const mapped = query.get('mapped') !== '0';
  const scenario = SCENARIOS[query.get('scenario')] ? query.get('scenario') : 'fresh';
  const instruments = PROFILES[query.get('profile')] ?? PROFILES.drums;
  const profile = {instruments: [...instruments], primary: instruments[0] ?? null, openWithMyPart: 'in'};
  const stems = query.get('stems') ? query.get('stems').split(',').filter(Boolean) : undefined;
  const id = 'glasshouse';
  const duration = sectioned.duration;

  const ts = await createTestSession({
    id, title: 'Glasshouse', artist: 'Northbound', mapped, duration,
    practice: SCENARIOS[scenario](),
    account: {profile},
    ...(stems ? {stems} : {}),
    ...(query.get('part') === '1' ? {score: emptyScore(duration, 120)} : {}),
    ...(query.get('shared') === '1' ? {shared: {token: 'harness-share'}} : {}),
    media: {
      async signKeys(keys) {
        return Object.fromEntries(keys.map((key) => [key, stemUrl({id, duration, bpm: 120, offset: 0}, key.split('/').pop())]));
      },
    },
    load: false,
  });
  const session = ts.session;

  // The account the Mix sheet's picker writes: it reaches the test session's account (the transport follows it).
  const patches = [];
  const accountValue = signal({profile});
  const account = {
    value: accountValue,
    async patch(partial) {
      patches.push(structuredClone(partial));
      accountValue.value = {...accountValue.peek(), ...partial};
      ts.setAccount(partial);
    },
  };
  const desktop = {available: query.get('desktop') === '1'};
  setSheetModules({
    './speed.js': async () => ({render: (c, o) => renderSpeed(c, o)}),
    './click.js': async () => ({render: (c, o) => renderClick(c, o)}),
    './mix.js': async () => ({render: (c, o) => renderMix(c, {...o, account, desktop})}),
  });

  // The Stage frame stand-in (stage.js builds the real one).
  const root = document.documentElement;
  root.dataset.place = 'stage';
  root.dataset.posture = 'stage';
  root.dataset.stageTheme = root.dataset.stageTheme || 'dark';
  el.style.padding = '0';
  el.style.overflow = 'hidden';
  const css = (node, text) => { node.style.cssText = text; return node; };
  const note = (text) => css(h('p', {}, text), 'margin: 0; color: var(--ink-3); font: var(--fw-semibold) var(--fs-16)/1 var(--font-ui);');
  const frame = css(h('div', {class: 'st7-frame', 'data-testid': 'stage-frame'}), 'position: fixed; inset: 0; display: flex; background: var(--bg); color: var(--ink);');
  frame.dataset.stageLayout = layout;
  frame.dataset.distance = 'stand';
  const music = css(h('div', {class: 'st7-music', 'data-testid': 'music'}, note('Music surface')),
    'flex: 1 1 auto; min-height: 0; min-width: 0; display: grid; place-items: center; border: 1px dashed var(--line);');

  const sheets = [];
  const navigations = [];
  const anchors = new Map();
  const open = (name) => openSheet(name, {session, anchor: anchors.get(name) ?? null});
  const stage = {
    layout, anchors,
    openSheet(name, {anchor} = {}) {
      sheets.push(name);
      frame.dataset.sheet = name;
      if (name === 'speed' || name === 'click' || name === 'mix') return openSheet(name, {session, anchor: anchor ?? anchors.get(name)});
      closeSheets();   // another sheet (ST8b's) would open here: this one closes, one sheet at a time
      return {close() {}};
    },
    closeSheets,
  };
  registry.provide('session', () => session);
  registry.provide('transport', () => session.transport);
  registry.provide('stage', () => stage);
  registry.provide('router', () => ({navigate: (path) => { navigations.push(path); }}));
  registry.provide('desktop', () => desktop);
  startDispatcher({registry});

  const control = (name, label) => {
    const b = css(h('button', {type: 'button', class: 'st7-control', 'data-stage-anchor': name}, label),
      'min-width: 96px; min-height: 64px; padding: 0 16px; border: 1px solid var(--line); border-radius: var(--r-control); background: var(--surface-2); color: var(--ink); font: var(--fw-semibold) var(--fs-16)/1 var(--font-ui);');
    b.addEventListener('click', () => open(name));
    anchors.set(name, b);
    return b;
  };
  const controls = [control('speed', 'Speed'), control('click', 'Click'), control('mix', 'Mix')];
  if (layout === 'rail') {
    const rail = css(h('aside', {'aria-label': 'Stage rail'}, note('Readouts'), css(h('div', {}, ...controls), 'display: grid; gap: 8px;')),
      'flex: none; width: var(--rail-w); display: flex; flex-direction: column; justify-content: space-between; padding: 16px; background: var(--surface); border-left: 1px solid var(--line);');
    frame.append(music, rail);
  } else {
    css(frame, `${frame.style.cssText} flex-direction: column;`);
    const dock = css(h('div', {'data-testid': 'dock'}, ...controls),
      'flex: none; height: 88px; display: flex; gap: 12px; align-items: center; justify-content: center; background: var(--surface); border-top: 1px solid var(--line);');
    frame.append(music, dock);
  }
  el.append(frame);

  window.__sheets = {ts, session, open, sheets, navigations, patches};
  await waitForLoad(session);
  if (query.get('part') === '1') await session.notation.ready;
  frame.dataset.loadPhase = session.load.peek().phase;
  session.load.subscribe((l) => { frame.dataset.loadPhase = l.phase; });
  session.transport.snapshot.subscribe((s) => { frame.dataset.transportPhase = s.phase; });
  frame.dataset.transportPhase = session.transport.snapshot.peek().phase;
  session.frame.start();
  const initial = query.get('sheet');
  if (initial === 'speed' || initial === 'click' || initial === 'mix') open(initial);
  return {ts};
}
