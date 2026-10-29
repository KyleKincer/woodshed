// ED5's harness (/__harness/chart-edit): Edit · Chart (src/edit/chart/chart-edit.js) over a real song
// session with a real drum part (tests/helpers/test-session.js `createTestSession` with demoScore: 64
// bars of 4/4 at 120 bpm on the rehearsal map, 8 sections), full window, in the app theme
// (?place=edit). The harness file is named after its module (chart-edit): /__harness/chart is ST3's.
//
// Two frames:
//   frame=bare (default)  chart-edit alone in a page frame that has what Edit gives it: the tab
//                         panel (the place's one [data-scroller]) and, when the window is wide (the
//                         Stage's rail rule), a 320 px inspector column on the right; in iPad portrait
//                         no inspector (each tab opens as a sheet). Without a posture bar the toolbar
//                         shows the save status.
//   frame=edit            the real Edit posture (src/edit/edit.js, ED2) on the Chart tab: the posture
//                         bar with its save status, the inspector container and the slim transport.
//                         States that use it list src/edit/edit.js in opts.requires.
// Query (all optional):
//   view=lanes            start in Lanes (prefs.edit.chart.view)
//   part=dense (default) | none     none: a song with no chart yet (Edit · Chart writes a new one)
//   tab=kit|properties|listen       the inspector tab
//   status=saved|saving|local|conflict|offline|storage-error   the part's save status (driven here)
//   bar=21                the ?bar= query (1-based)
//   keys=crash:,crash2:KeyX         prefs.edit.chart.keys entries (an empty value clears a key)
// window.__chartEdit = {ts, view, registry, router, workspace(), run(id, args), setStatus(s), log}
import {registry} from '/src/app/commands.js';
import '/src/app/global-commands.js';
import '/src/stage/transport-commands.js';
import '/src/stage/commands.js';
import {setDrumKeys} from '/src/edit/chart/commands.js';
import {startDispatcher} from '/src/app/dispatch.js';
import * as feedback from '/src/app/feedback.js';
import {platform} from '/src/app/platform.js';
import {prefs} from '/src/app/prefs.js';
import {signal, store} from '/src/app/store.js';
import {stageLayout} from '/src/stage/layout.js';
import {openPart as realOpenPart} from '/src/js/notation/part.js';
import {createTestSession} from '/tests/helpers/test-session.js';
import {demoScore} from '/tests/fixtures/drum-score.js';

const STATUSES = ['saved', 'saving', 'local', 'conflict', 'offline', 'storage-error'];

/** The part with its save status driven by the harness (the in-memory store reports 'fixture'). */
function withStatus(part, status) {
  const listeners = new Set();
  status.subscribe((s) => { for (const fn of listeners) fn(s); });
  return Object.create(part, {
    status: {get: () => status.peek()},
    onStatus: {value(fn) { listeners.add(fn); fn(status.peek()); return () => listeners.delete(fn); }},
    store: {value: {persist: async () => { status.value = 'saving'; }, flush: async () => { status.value = 'saved'; }}},
  });
}

function parseKeys(text) {
  const out = {};
  for (const pair of String(text ?? '').split(',').filter(Boolean)) {
    const [kit, key = ''] = pair.split(':');
    if (kit) out[kit] = key;
  }
  return out;
}

export default async function mount(el, {query, h}) {
  const view = query.get('view') === 'lanes' ? 'lanes' : 'score';
  const keys = parseKeys(query.get('keys'));
  prefs.update((d) => { d.edit.chart = {view, paging: 'pages', keys}; d.edit.lastTab = 'chart'; });
  setDrumKeys(keys);
  const status = signal(STATUSES.includes(query.get('status')) ? query.get('status') : 'saved');
  const log = {navigations: [], statuses: []};
  const none = query.get('part') === 'none';
  const ts = await createTestSession({
    score: none ? null : demoScore(128, 120), hasChart: !none, load: false,
    openPart: async (options) => withStatus(await realOpenPart(options), status),
    status: (text, options) => feedback.status(text, options),
  });

  const router = {
    calls: log.navigations,
    navigate(to, opts) { this.calls.push(['navigate', to, opts ?? null]); },
    back(opts) { this.calls.push(['back', opts ?? null]); },
    replace(to) { this.calls.push(['replace', to]); },
    setQuery(patch) { this.calls.push(['setQuery', patch]); },
    onLeave: () => () => {},
    link: () => () => {},
    current: signal({name: 'edit', params: {songId: ts.id, tab: 'chart'}, query: {}}),
  };
  registry.provide('router', () => router);
  registry.provide('feedback', () => feedback);
  registry.provide('store', () => store);
  registry.provide('platform', () => platform);
  registry.provide('session', () => ts.session);
  registry.provide('transport', () => ts.session.transport);
  startDispatcher({platform});
  document.documentElement.dataset.posture = 'edit';
  el.style.overflow = 'hidden';
  el.style.padding = '0';
  el.removeAttribute('data-scroller');

  const host = h('div', {class: 'chart-edit-harness'});
  host.style.cssText = 'position: fixed; inset: 0; display: flex; min-height: 0; background: var(--bg)';
  el.append(host);
  const bar = query.get('bar');
  let mounted;
  if (query.get('frame') === 'edit') {
    // By variable, so the page also loads while ED2's frame has not merged (those states list it in opts.requires).
    const EDIT_FRAME = '/src/edit/edit.js';
    const edit = await import(/* @vite-ignore */ EDIT_FRAME);
    mounted = await edit.mount(host, {name: 'edit', path: `/s/${ts.id}/edit/chart`, params: {songId: ts.id, tab: 'chart'}, query: bar ? {bar} : {}},
      {router, store, registry, feedback, platform, session: ts.session});
  } else {
    registry.provide('edit', () => ({tab: 'chart'}));
    const chartEdit = await import('/src/edit/chart/chart-edit.js');
    const wide = stageLayout({vw: window.innerWidth, vh: window.innerHeight}) === 'rail';
    const panel = h('div', {class: 'chart-edit-harness-panel', 'data-scroller': '', role: 'tabpanel', 'aria-label': 'Chart'});
    panel.style.cssText = 'flex: 1; min-width: 0; overflow: auto';
    const inspector = h('aside', {class: 'chart-edit-harness-inspector', 'aria-label': 'Inspector'});
    inspector.style.cssText = 'flex: 0 0 320px; overflow: auto; border-left: 1px solid var(--line); background: var(--surface)';
    host.append(panel);
    if (wide) host.append(inspector);
    mounted = chartEdit.mount(panel, {session: ts.session, query: bar ? {bar} : {}, inspectorEl: wide ? inspector : null, registry});
    await mounted.ready;
  }
  await ts.ready();
  const workspace = () => registry.context().chart ?? null;
  const tab = query.get('tab');
  if (tab && workspace()) workspace().run('setInspectorTab', tab);

  window.__chartEdit = {
    ts, view: mounted, registry, router, log, workspace,
    run: (id, args) => registry.run(id, {source: 'key', args}),
    setStatus: (s) => { status.value = s; },
  };
  return window.__chartEdit;
}
