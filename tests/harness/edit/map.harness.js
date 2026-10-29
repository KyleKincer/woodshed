// ED3's harness (/__harness/map): the Edit · Map main area (src/edit/map/view.js: toolbar, ruler,
// sections lane, tempo lane, stem rows, markers banner, strip) with the inspector (inspector.js) or
// Find a chart (find-panel.js, ED4) in the inspector's place, on a real song session
// (tests/helpers/test-session.js over the fixture's synthetic stems) and a real Edit · Map session
// (src/edit/map/session.js) wired with the hooks Edit passes (§2.15, Appendix C item 50). The app
// registry with the Em, Stage and transport commands, the dispatcher (posture edit, tab map, so the
// `edit.map` scope is live), feedback and the platform are the app's.
// Laptop: the map view beside the 320 px inspector column. iPad portrait: the inspector is the 45%
// bottom sheet (`.edit[data-edit-layout=portrait]`). States: tests/fixture/states/ED3.cjs.
//
// Query:
//   mapped=0                a song nobody mapped (Get a map)
//   scenario=               sectioned (default: 64 bars of 4/4 at 120, eight sections) | plain (mapped, no sections)
//                           | suggestion (plain + a section suggestion, D47) | markers (plain + three markers)
//                           | pins (two pins, a ramp-free steady span and an amber suspect span)
//   review=sections         open the suggestion review in the sections lane
//   find=1                  Find a chart replaces the inspector
//   bar=<n>                 the route's ?bar=
//   desktop=1               the desktop app (Detect runs on this computer); devices=online|offline for the web
// window.__map = {ts, session, map, mapSession, view, registry, router, statuses, run(id, args), root(), inspector()}
import {registry} from '/src/app/commands.js';
import '/src/app/global-commands.js';
import '/src/stage/transport-commands.js';
import '/src/stage/commands.js';
import '/src/edit/map/commands.js';
import {startDispatcher} from '/src/app/dispatch.js';
import * as feedback from '/src/app/feedback.js';
import {platform} from '/src/app/platform.js';
import {prefs} from '/src/app/prefs.js';
import {signal, store} from '/src/app/store.js';
import {createMapSession} from '/src/edit/map/session.js';
import {mountMapView} from '/src/edit/map/view.js';
import {createTestSession} from '/tests/helpers/test-session.js';
import {sectioned} from '/tests/fixtures/maps.js';
import {stemUrl} from '/tests/fixture/audio.js';

const frac = (n, d = 1) => ({n, d});

/** The sectioned song without its labels (mapped, no sections). */
function plainTempo() {
  const tempo = structuredClone(sectioned.tempo);
  for (const m of tempo.songMap.measures) m.label = '';
  return tempo;
}

/** Two pins at 120 bpm with a bar that reads fast between them (a miscount: the amber suspect span). */
function pinsTempo() {
  const tempo = plainTempo();
  tempo.songMap.pins = [{position: frac(0), time: 0}, {position: frac(32), time: 16}, {position: frac(40), time: 19.2},
    {position: frac(72), time: 35.2}];
  return tempo;
}

function practice(fields = {}) {
  return {v: 2, cue: 0, rate: 1, tracks: [], minusMe: false, trainer: null, spots: [], markers: [], surface: 'chart', ...fields,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none', ...(fields.loop ?? {})}};
}

const SUGGESTION = {jobId: 'job-sections', createdAt: 1, sections: [
  {t0: 0, label: 'Intro', confidence: 0.8}, {t0: 16.1, label: 'Verse', confidence: 0.7}, {t0: 47.8, label: 'Chorus', confidence: 0.74},
  {t0: 64, label: 'Verse', confidence: 0.6}, {t0: 96.2, label: 'Chorus', confidence: 0.7}]};
const MARKERS = [{id: 'mk1', t: 15.6, label: 'Verse', updatedAt: 1}, {id: 'mk2', t: 48.4, label: 'Chorus', updatedAt: 1},
  {id: 'mk3', t: 80.1, label: 'Bridge', updatedAt: 1}];

const SCENARIOS = {
  sectioned: () => ({tempo: structuredClone(sectioned.tempo)}),
  plain: () => ({tempo: plainTempo()}),
  suggestion: () => ({tempo: plainTempo(), sectionSuggestion: structuredClone(SUGGESTION)}),
  markers: () => ({tempo: plainTempo(), practice: practice({markers: structuredClone(MARKERS)})}),
  pins: () => ({tempo: pinsTempo()}),
};

export default async function mount(el, {query, h}) {
  const id = 'glasshouse';
  const duration = 128;
  const mapped = query.get('mapped') !== '0';
  const scenario = SCENARIOS[query.get('scenario')] ? query.get('scenario') : 'sectioned';
  const options = mapped ? SCENARIOS[scenario]() : {tempo: null, mapped: false};
  const desktop = query.get('desktop') === '1';
  const devices = ['online', 'offline'].includes(query.get('devices')) ? query.get('devices') : [];
  const statuses = [];
  const ts = await createTestSession({
    id, title: 'Glasshouse', artist: 'Northbound', duration, practice: practice(), ...options, desktop, devices,
    media: {
      async signKeys(keys) {
        return Object.fromEntries(keys.map((key) => [key, stemUrl({id, duration, bpm: 120, offset: 0}, key.split('/').pop())]));
      },
    },
    load: false,
    status: (text, opts) => { statuses.push({text, ...(opts ?? {})}); feedback.status(text, opts); },
  });

  const find = query.get('find') === '1';
  const routeQuery = {};
  if (query.has('bar')) routeQuery.bar = query.get('bar');
  if (query.get('review') === 'sections') routeQuery.review = 'sections';
  const router = {
    calls: [],
    current: signal({name: find ? 'editFind' : 'edit', path: `/s/${id}/edit/map${find ? '/find' : ''}`, params: {songId: id, tab: 'map', ...(find ? {find: true} : {})},
      query: routeQuery, route: {session: true, posture: 'edit', params: {tab: 'map', ...(find ? {find: true} : {})}}}),
    navigate(to, opts) { this.calls.push(['navigate', to, opts ?? null]); },
    back(opts) { this.calls.push(['back', opts ?? null]); },
    setQuery(patch) { this.calls.push(['setQuery', patch]); },
    onLeave: () => () => {},
    link: () => () => {},
  };
  registry.provide('router', () => router);
  registry.provide('feedback', () => feedback);
  registry.provide('store', () => store);
  registry.provide('platform', () => platform);
  registry.provide('session', () => ts.session);
  registry.provide('transport', () => ts.session.transport);
  registry.provide('route', () => router.current.peek());
  registry.provide('edit', () => ({tab: 'map', done() {}, escape() {}}));
  registry.provide('desktop', () => ({available: desktop}));
  startDispatcher({platform});
  document.documentElement.dataset.place = 'edit';
  document.documentElement.dataset.posture = 'edit';

  // An Edit-shaped page: the map view (the posture's one scroller) and the inspector's place.
  const portrait = window.innerWidth < 1000 && window.innerHeight > window.innerWidth;
  const main = h('div', {class: 'map-harness-main', dataset: {scroller: ''}, style: {minHeight: '0', minWidth: '0', overflow: 'auto', background: 'var(--bg)'}});
  const inspector = h('div', {class: 'map-harness-inspector', style: {minHeight: '0', minWidth: '0', overflow: 'auto', background: 'var(--surface)',
    ...(portrait ? {borderTop: '1px solid var(--line)'} : {borderLeft: '1px solid var(--line)'})}});
  const page = h('div', {class: 'edit map-harness', dataset: {editLayout: portrait ? 'portrait' : 'laptop'}, style: {
    position: 'fixed', inset: '0', display: 'grid', background: 'var(--bg)', color: 'var(--ink)',
    ...(portrait ? {gridTemplateRows: '55fr 45fr'} : {gridTemplateColumns: 'minmax(0, 1fr) 320px'}),
  }}, main, inspector);
  el.append(page);

  await ts.ready();
  const engine = ts.session.engine;
  const hooks = {
    suspendSaves: (on, opts) => ts.session.suspendSaves(on, opts),
    pauseMapSync: (on) => ts.session.notation.setMapSyncPaused(on),
    status: (text, opts) => feedback.status(text, opts),
    rename: () => false,
    loop: {
      get: () => ({loop: {...engine.loop}, gap: engine.loopGap}),
      set: (value) => { const l = value?.loop; if (l && Number.isFinite(l.a) && Number.isFinite(l.b)) engine.setLoop(!!l.enabled, l.a, l.b); },
    },
    markers: {
      list: () => (ts.session.practice.value.peek().markers ?? []).filter((m) => !m.deleted),
      tombstone: (ids, deleted = true) => {
        const set = new Set(ids ?? []);
        ts.session.practice.patch((p) => { for (const m of p.markers) if (set.has(m.id)) m.deleted = !!deleted; });
      },
    },
  };
  const mapSession = createMapSession({engine, metronome: ts.session.metronome, map: ts.session.map, prefs, hooks});
  ts.session.mapEditor.value = mapSession;
  registry.provide('map', () => mapSession);

  const view = mountMapView(main, {
    session: ts.session, mapSession, inspectorEl: inspector, find, review: routeQuery.review === 'sections', query: routeQuery, mapHooks: hooks,
    onCloseFind: () => router.calls.push(['closeFind']),
    // Where Detect runs: the same desktop the song session's detect flow sees (the app's in the app).
    desktop: {available: desktop, processor: signal(desktop ? {phase: 'ready', deviceId: 'this-device'} : {phase: 'web'})},
    store: {library: ts.library},
  });
  document.documentElement.dataset.viewReady = 'map';

  window.__map = {
    ts, session: ts.session, map: ts.session.map, mapSession, view, registry, router, statuses,
    run: (cmd, args) => registry.run(cmd, {source: 'key', args}),
    root: () => document.querySelector('section.map-view'),
    inspector: () => document.querySelector('aside.map-inspector'),
  };
  return window.__map;
}
