// ED4's harness (/__harness/find): the Find a chart panel (src/edit/map/find-panel.js) in the inspector's
// place of an Edit · Map-shaped page, on a real song session (tests/helpers/test-session.js over the
// fixture's synthetic stems) and a real Edit · Map session (src/edit/map/session.js) wired like Edit · Map
// wires it. The app registry (transport commands), dispatcher and feedback are live, the posture is
// `edit` (tab map), and the tempo sources are the fixture's handlers (tests/fixture/db/tempo-sources.js:
// three Glasshouse candidates; a query with "zzz" finds nothing).
// Laptop: the panel is the 320 px right column beside a main area. iPad portrait: the 45% bottom sheet.
// States: tests/fixture/states/ED4.cjs.
//
// Query:
//   import=1           the route query of the chart surface's "Import a file" (focuses Import a file…)
//   chart=1            the song already has a drum part
// window.__find = {ts, session, map, mapSession, panel, router, closes, original, leave(where), saves(), partHits(), probe}
//   leave('stage'|'chart'|'map'|'library') runs the router's leave hooks as a navigation there would
import {registry} from '/src/app/commands.js';
import '/src/app/global-commands.js';
import '/src/stage/transport-commands.js';
import {startDispatcher} from '/src/app/dispatch.js';
import * as feedback from '/src/app/feedback.js';
import {platform} from '/src/app/platform.js';
import {signal, store} from '/src/app/store.js';
import {createMapSession} from '/src/edit/map/session.js';
import {mountFindPanel} from '/src/edit/map/find-panel.js';
import {createTestSession} from '/tests/helpers/test-session.js';
import {demoScore} from '/tests/fixtures/drum-score.js';
import {stemUrl} from '/tests/fixture/audio.js';

export default async function mount(el, {fixture, query, h}) {
  const id = 'glasshouse';
  const duration = 128;
  const withChart = query.get('chart') === '1';
  const ts = await createTestSession({
    id, title: 'Glasshouse', artist: 'Northbound', duration,
    ...(withChart ? {score: demoScore(duration, 120)} : {}),
    media: {
      async signKeys(keys) {
        return Object.fromEntries(keys.map((key) => [key, stemUrl({id, duration, bpm: 120, offset: 0}, key.split('/').pop())]));
      },
    },
    load: false,
    status: (text, options) => feedback.status(text, options),
  });

  // The router: the editFind match, leave hooks (as router.navigate runs them) and a navigation log.
  const hooks = new Set();
  const closes = [];
  const routeQuery = {};
  if (query.get('import') === '1') routeQuery.import = '1';
  const route = (name, params = {}, extra = {}) => ({name, path: `/${name}`, params: {songId: id, ...params}, query: {}, route: {session: true, ...extra}});
  const router = {
    calls: [],
    current: signal({name: 'editFind', path: `/s/${id}/edit/map/find`, params: {songId: id, tab: 'map', find: true}, query: routeQuery,
      route: {session: true, posture: 'edit', params: {tab: 'map', find: true}}}),
    navigate(to, opts) { this.calls.push(['navigate', to, opts ?? null]); },
    back(opts) { this.calls.push(['back', opts ?? null]); },
    onLeave(fn) { hooks.add(fn); return () => hooks.delete(fn); },
    link: () => () => {},
  };
  const DESTINATIONS = {
    stage: () => route('stage', {}, {posture: 'stage'}),
    chart: () => route('edit', {tab: 'chart'}, {posture: 'edit'}),
    map: () => route('edit', {tab: 'map'}, {posture: 'edit'}),
    library: () => ({name: 'library', path: '/', params: {}, query: {}, route: {}}),
  };
  registry.provide('router', () => router);
  registry.provide('feedback', () => feedback);
  registry.provide('store', () => store);
  registry.provide('platform', () => platform);
  registry.provide('session', () => ts.session);
  registry.provide('transport', () => ts.session.transport);
  registry.provide('route', () => router.current.peek());
  registry.provide('desktop', () => ({available: false}));
  startDispatcher({platform});
  document.documentElement.dataset.place = 'edit';
  document.documentElement.dataset.posture = 'edit';

  // An Edit · Map-shaped page: the main area and the inspector's place.
  const portrait = window.innerWidth < 1000 && window.innerHeight > window.innerWidth;
  const main = h('div', {class: 'find-harness-main', style: {background: 'var(--bg)', borderRight: '1px solid var(--line)', minHeight: '0'}},
    h('p', {style: {padding: 'var(--s5)', color: 'var(--ink-3)'}}, 'Edit · Map'));
  const inspector = h('aside', {class: 'find-harness-inspector', 'aria-label': 'Inspector',
    style: {minHeight: '0', minWidth: '0', background: 'var(--surface)', borderTop: portrait ? '1px solid var(--line)' : '0'}});
  const page = h('div', {class: 'find-harness', dataset: {layout: portrait ? 'sheet' : 'rail'}, style: {
    position: 'fixed', inset: '0', display: 'grid', background: 'var(--bg)',
    ...(portrait ? {gridTemplateRows: '55fr 45fr'} : {gridTemplateColumns: 'minmax(0, 1fr) 320px'}),
  }}, main, inspector);
  el.append(page);

  await ts.ready();
  const mapSession = createMapSession({engine: ts.engine, metronome: ts.metronome, map: ts.map, prefs: null, hooks: {
    suspendSaves: (on, opts) => ts.session.suspendSaves(on, opts),
    pauseMapSync: (on) => ts.session.notation.setMapSyncPaused(on),
    status: (text, opts) => feedback.status(text, opts),
  }});
  ts.session.mapEditor.value = mapSession;
  if (withChart) await ts.session.notation.ready;
  const original = JSON.stringify(ts.map.snapshot());

  const api = {
    search: (args) => fixture.call('action', 'tempoSources:search', args),
    load: (args) => fixture.call('action', 'tempoSources:load', args),
  };
  const panel = mountFindPanel(inspector, {session: ts.session, mapSession, router, feedback, registry, api,
    onClose: (result) => { closes.push(result); }});

  const probe = [];
  registry.register({id: 'harness.probe', title: 'Probe', group: 'Mix', keys: ['KeyM', 'Digit1', 'KeyD'], scopes: ['edit', 'edit.map'],
    run: () => { probe.push('ran'); }});

  const handle = {
    ts, session: ts.session, map: ts.map, mapSession, panel, router, closes, original, probe,
    leave(where) {
      const to = DESTINATIONS[where]?.();
      if (!to) throw new Error(`leave: unknown destination ${where}`);
      if (where !== 'map') ts.session.mapEditor.value = null;
      for (const fn of [...hooks]) fn(router.current.peek(), to);
    },
    saves: () => ts.server.calls.saveTempo.map((c) => ({origin: c.tempo?.songMap?.origin ?? null})),
    partHits: () => ts.session.notation.part?.score?.bars.reduce((n, b) => n + b.hits.length, 0) ?? 0,
    mapJson: () => JSON.stringify(ts.map.snapshot()),
    undoDepth: () => ts.map.undoStack.length,
  };
  window.__find = handle;
  return handle;
}
