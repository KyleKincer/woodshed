// ST8a's harness (/__harness/loop): the Loop card and the Stage's menus on a real song session
// (tests/helpers/test-session.js in the browser over the fixture's synthetic stems), in a Stage
// frame like stage.js's: the music area (a press target for the bar menu), ST6's song strip (its
// long-press and right-click open the section menu), ST5's controls (a long-press on Loop opens
// the Loop card through the real sheets host) and an identity row with the ⋯ button (stage.menu).
// The app registry carries the transport and Stage commands and the dispatcher runs, so keys and
// command-bound rows behave as in the app.
// States: tests/fixture/states/ST8a.cjs (use fx-audio=manual so audio time moves only on request).
//
// Query:
//   layout=band|rail      default: rail on a wide viewport, band otherwise (layout.js's rule)
//   mapped=0              a song nobody mapped (times instead of bars)
//   part=1                a drum part (the ⋯ menu's Display ▸), on the Chart surface
//   stems=<a,b,…>         stem names (default: the rehearsal song's drums, bass, vocals, other)
//   scenario=             fresh (default) | looping (the Chorus loop, two spots, a marker) |
//                         bars (a 3-bar loop, bars 21–23) | timed (unmapped 0:31.2–0:41.0)
//   open=loop|stage|bar|section|spot|marker|loopBand|stem   open that card or menu once ready
// window.__loop = {ts, session, stage, open(kind, opts), menu (the open Menu handle), statuses}
import {registry} from '../../../src/app/commands.js';
import {startDispatcher} from '../../../src/app/dispatch.js';
import {effect, signal, readonly} from '../../../src/app/store.js';
import * as feedback from '../../../src/app/feedback.js';
import '../../../src/app/global-commands.js';
import '../../../src/stage/transport-commands.js';
import '../../../src/stage/commands.js';
import {mountStrip} from '../../../src/stage/strip.js';
import {mountControls} from '../../../src/stage/controls.js';
import {closeSheets, openSheet} from '../../../src/stage/sheets/host.js';
import {createPressRecognizer} from '../../../src/stage/press.js';
import {Menu} from '../../../src/ui/menu.js';
import {IconButton} from '../../../src/ui/button.js';
import {barMenu, loopBandMenu, markerMenu, sectionMenu, spotMenu, stageMenu, stemMenu} from '../../../src/stage/menus.js';
import {createTestSession, waitForLoad} from '../../helpers/test-session.js';
import {stemUrl} from '../../fixture/audio.js';
import {sectioned} from '../../fixtures/maps.js';
import {emptyScore} from '../../../shared/notation.ts';

function practice(fields = {}) {
  return {v: 2, cue: 0, rate: 1, tracks: [], minusMe: false, trainer: null, spots: [], markers: [], ...fields,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none', ...(fields.loop ?? {})}};
}

const SPOTS = [{id: 'spot-fill', name: 'Fill into the chorus', a: 28, b: 32, rate: 0.8, passes: 3, updatedAt: 1},
  {id: 'spot-bridge', name: 'Bridge groove', a: 80, b: 96, rate: 0.9, passes: 1, updatedAt: 1}];
const MARKERS = [{id: 'marker-flam', t: 41, label: 'Flam', updatedAt: 1}];
const SCENARIOS = {
  fresh: () => practice({cue: 20}),
  looping: () => practice({cue: 32, loop: {on: true, a: 32, b: 48}, spots: SPOTS, markers: MARKERS}),
  bars: () => practice({cue: 40, loop: {on: true, a: 40, b: 46}, spots: SPOTS, markers: MARKERS}),
  timed: () => practice({cue: 31.2, loop: {on: true, a: 31.2, b: 41}, markers: [{id: 'marker-1', t: 12, label: 'Groove', updatedAt: 1},
    {id: 'marker-2', t: 60, label: 'Big ending', updatedAt: 1}]}),
};

export default async function mount(el, {query, h}) {
  const wide = innerWidth / innerHeight >= 1.15 && innerWidth >= 1000;
  const layout = query.get('layout') === 'band' || query.get('layout') === 'rail' ? query.get('layout') : wide ? 'rail' : 'band';
  const mapped = query.get('mapped') !== '0';
  const withPart = query.get('part') === '1';
  const scenario = SCENARIOS[query.get('scenario')] ? query.get('scenario') : 'fresh';
  const stems = (query.get('stems') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const duration = sectioned.duration;
  const id = 'glasshouse';

  const ts = await createTestSession({
    id, title: 'Glasshouse', artist: 'Northbound',
    tempo: mapped ? structuredClone(sectioned.tempo) : null, mapped, duration,
    practice: SCENARIOS[scenario](),
    ...(stems.length ? {stems} : {}),
    ...(withPart ? {score: emptyScore(duration, 120)} : {}),
    media: {
      async signKeys(keys) {
        return Object.fromEntries(keys.map((key) => [key, stemUrl({id, duration, bpm: 120, offset: 0}, key.split('/').pop())]));
      },
    },
    load: false,
  });
  const session = ts.session;

  // The Stage frame (ST4's stage.js does this in the app).
  const root = document.documentElement;
  root.dataset.place = 'stage';
  root.dataset.posture = 'stage';
  root.dataset.stageTheme = root.dataset.stageTheme || 'dark';
  el.style.padding = '0';
  el.style.overflow = 'hidden';
  const css = (node, text) => { node.style.cssText = text; return node; };
  const note = (text) => css(h('p', {}, text), 'margin: 0; color: var(--ink-3); font: var(--fw-semibold) var(--fs-16)/1 var(--font-ui);');

  // ---- the 'stage' context: what stage.js provides that the menus and sheets read ----
  const surface = signal(withPart ? 'chart' : mapped ? 'roadmap' : 'wave');
  const distance = signal('stand');
  const focus = signal(false);
  const display = signal(null);
  const followStyle = signal(layout === 'rail' ? 'scroll' : 'page');
  const anchors = new Map();
  const statuses = [];
  const status = (text, options) => { statuses.push(text); feedback.status(text, options); };
  const stage = {
    session, layout: signal(layout), surface: readonly(surface), focus: readonly(focus), distance: readonly(distance),
    following: signal(true), display: readonly(display), followStyle: readonly(followStyle),
    menuAvailable: signal(true), shareAvailable: signal(false), anchors,
    setSurface: (kind) => { surface.value = kind === 'roadmap' && !mapped ? 'wave' : kind; },
    cycleSurface() {}, toggleFocus: () => { focus.value = !focus.peek(); }, setDistance: (d) => { distance.value = d; frame.dataset.distance = d; },
    zoom() {}, resumeFollow() {}, setDisplay: (v) => { display.value = v; }, setFollowStyle: (s) => { followStyle.value = s; },
    openSheet: (name, {anchor} = {}) => openSheet(name, {session, anchor: anchor ?? anchors.get(name) ?? null}),
    closeSheets,
    openMenu: (kind, options = {}) => open(kind === 'stage' ? 'stage' : kind, options),
    share() {}, startOver() {}, leave() {}, close() {}, scrollBy() {}, scrollTop() {}, batch: (fn) => fn(),
  };
  registry.provide('session', () => session);
  registry.provide('transport', () => session.transport);
  registry.provide('stage', () => stage);
  registry.provide('feedback', () => ({...feedback, status}));
  registry.provide('router', () => ({navigate: (path) => { frame.dataset.navigated = path; }}));
  startDispatcher({registry});

  // ---- the frame ----
  const frame = css(h('div', {class: 'stage st8a-frame', 'data-testid': 'stage-frame'}),
    'position: fixed; inset: 0; display: flex; background: var(--bg); color: var(--ink);');
  frame.dataset.stageLayout = layout;
  frame.dataset.distance = 'stand';
  const more = IconButton({command: 'stage.menu', label: 'More…', icon: 'ellipsis', size: 'lg', registry, dataset: {stageAnchor: 'menu'}});
  const identity = css(h('header', {class: 'st8a-identity', 'aria-label': 'Song'},
    css(h('h1', {}, 'Glasshouse'), 'margin: 0; font: var(--fw-bold) var(--fs-20)/1.2 var(--font-ui);'), more.el),
  'flex: none; display: flex; align-items: center; justify-content: space-between; gap: var(--s3); padding: var(--s2) var(--s4); border-bottom: 1px solid var(--line);');
  anchors.set('menu', more.el);
  const music = css(h('div', {class: 'st8a-music', 'data-testid': 'music', role: 'region', 'aria-label': 'Music'}, note('Music surface — long-press or right-click for the bar menu')),
    'flex: 1 1 auto; min-height: 0; display: grid; place-items: center; border: 1px dashed var(--line); touch-action: pan-y;');
  const notesHost = h('div', {'data-notes-host': ''});
  const slot = css(h('div', {class: 'st8a-strip-slot', 'data-stage-anchor': 'strip', 'data-testid': 'strip-slot'}),
    'flex: none; height: 56px; min-width: 0; border-top: 1px solid var(--line); background: var(--bg);');
  const controlsHost = css(h('div', {class: 'st8a-controls', 'data-stage-anchor': 'controls'}), 'flex: none;');
  if (layout === 'rail') {
    const column = css(h('div', {class: 'st8a-column'}, identity, music, slot), 'flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column;');
    const rail = css(h('aside', {'aria-label': 'Stage rail'}, note('Rail'), controlsHost),
      'flex: none; width: var(--rail-w); display: flex; flex-direction: column; justify-content: space-between; padding: var(--s3); box-sizing: border-box; background: var(--surface); border-left: 1px solid var(--line);');
    frame.append(column, rail, notesHost);
  } else {
    css(frame, `${frame.style.cssText} flex-direction: column;`);
    css(controlsHost, 'flex: none; padding: var(--s3) var(--s4); background: var(--surface); border-top: 1px solid var(--line);');
    frame.append(identity, music, slot, controlsHost, notesHost);
  }
  // The status line (stage.js renders S2's statusLine; one role=status per Stage).
  const statusEl = css(h('div', {class: 'st8a-status', role: 'status', 'aria-live': 'polite', 'aria-label': 'Status'}),
    'position: fixed; left: var(--s4); bottom: var(--s4); max-width: 50vw; color: var(--ink-2); font: var(--fs-16)/1.3 var(--font-ui); pointer-events: none;');
  feedback.attachStatusLine();
  effect(() => { statusEl.textContent = feedback.statusLine.value?.text ?? ''; });
  el.append(frame, statusEl);

  const strip = mountStrip(slot, {session, registry});
  const controls = mountControls(controlsHost, {session, variant: layout === 'rail' ? 'rail' : 'dock', stage, registry});
  session.frame.start();

  // The music: a press target standing in for a surface (seconds across its width).
  const timeAt = (clientX) => {
    const r = music.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / Math.max(1, r.width)) * duration));
  };
  const offPress = createPressRecognizer(music, {
    onMenu: (g) => open('bar', {t: timeAt(g.clientX), anchor: {x: g.clientX, y: g.clientY}}),
  });

  // ---- open a card or a menu ----
  let menu = null;
  function open(kind, options = {}) {
    menu?.close?.();
    menu = null;
    const anchor = options.anchor ?? anchors.get('menu');
    const p = session.practice.value.peek();
    const items = kind === 'stage' ? stageMenu(session, stage, {registry})
      : kind === 'bar' ? barMenu(session, {t: options.t ?? 41}, {registry})
        : kind === 'section' ? sectionMenu(session, options.region ?? session.position.regions()[2], {registry, t: options.t, rename: () => strip.rename(options.region ?? session.position.regions()[2])})
          : kind === 'spot' ? spotMenu(session, p.spots.find((s) => !s.deleted) ?? {id: null}, {registry})
            : kind === 'marker' ? markerMenu(session, p.markers.find((m) => !m.deleted) ?? {id: null}, {registry})
              : kind === 'loopBand' ? loopBandMenu(session, {registry})
                : kind === 'stem' ? stemMenu(session, options.stem ?? 'bass', {registry})
                  : null;
    if (kind === 'loop') return stage.openSheet('loop');
    if (!items?.length) return null;
    const label = kind === 'stage' ? 'More…' : kind === 'bar' ? 'Bar' : kind === 'section' ? (options.region ?? session.position.regions()[2])?.label ?? 'Section'
      : kind === 'loopBand' ? 'Loop' : kind === 'stem' ? 'Stem' : kind === 'spot' ? 'Spot' : 'Marker';
    menu = Menu.open(items, {anchor, label, registry, onClose: () => { menu = null; frame.dataset.menu = ''; }});
    frame.dataset.menu = kind;
    window.__loop.menu = menu;
    return menu;
  }

  window.__loop = {ts, session, stage, strip, controls, open, menu: null, statuses, offPress};
  await waitForLoad(session);
  frame.dataset.loadPhase = session.load.peek().phase;
  session.load.subscribe((l) => { frame.dataset.loadPhase = l.phase; });
  session.transport.snapshot.subscribe((s) => { frame.dataset.transportPhase = s.phase; });
  frame.dataset.transportPhase = session.transport.snapshot.peek().phase;
  const initial = query.get('open');
  if (initial) open(initial);
  return {ts, strip, controls};
}
