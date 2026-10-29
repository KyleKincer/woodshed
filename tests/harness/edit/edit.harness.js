// ED2's harness (/__harness/edit): the Edit frame (src/edit/edit.js) mounted full-window on a real
// song session (tests/helpers/test-session.js `createTestSession`, browser-safe: silent stems on the
// page's AudioContext) with the app registry, the dispatcher, feedback and platform. Load it with
// ?place=edit so the app theme applies, as the router does for /s/:id/edit/:tab. The rehearsal song
// (64 bars, 8 sections) unless told otherwise.
//
// The name is "edit", not "frame": tests/harness/stage/frame.harness.js (ST4) already serves
// /__harness/frame, and the harness host refuses a basename defined twice.
//
// Query:
//   tab=map|chart|details   the open tab (default map); find=1 opens Edit · Map with Find a chart
//   views=real              the real tab views (ED3, ED5, ED6); by default each tab shows a neutral
//                           stand-in view, so the frame's own geometry is measured on its own
//   mapped=0                a song nobody mapped
//   ipad=1                  platform.isIPad (the landscape hint on Map in portrait)
//   bulk=N                  the bulk Details posture bar for N songs over a long page
// window.__edit = {ts, view, router, registry, run(id, args)} for the states (tests/fixture/states/ED2.cjs).
//
// edit.js imports ED3's map/view.js, ED5's chart/chart-edit.js and ED6's details/details.js (same-wave
// peers): every state declares them in opts.requires.
import {registry} from '/src/app/commands.js';
import '/src/app/global-commands.js';
import '/src/stage/transport-commands.js';
import '/src/stage/commands.js';
import '/src/edit/commands.js';
import {startDispatcher} from '/src/app/dispatch.js';
import * as feedback from '/src/app/feedback.js';
import {platform} from '/src/app/platform.js';
import {store} from '/src/app/store.js';
import {createTestSession} from '/tests/helpers/test-session.js';

/** A recording router: Edit only ever navigates, goes back or replaces (Done, tabs, Find). */
function recordingRouter() {
  const hooks = new Set();
  return {
    calls: [],
    navigate(to, opts) { this.calls.push(['navigate', to, opts ?? null]); return Promise.resolve(); },
    back(opts) { this.calls.push(['back', opts ?? null]); return Promise.resolve(); },
    setQuery(patch) { this.calls.push(['setQuery', patch]); },
    onLeave(fn) { hooks.add(fn); return () => hooks.delete(fn); },
    link: () => () => {},
    hooks,
  };
}

/** The neutral stand-in views: rows of text that fill the tab panel and the inspector. */
function standInViews(h) {
  const rows = (n, label) => Array.from({length: n}, (_, i) => h('p', {class: 'edit-harness-row'}, `${label} ${i + 1}`));
  const style = (el) => { el.style.margin = '0'; el.style.padding = 'var(--s4)'; return el; };
  return {
    map: () => ({
      mountMapView(el, {inspectorEl}) {
        const lanes = style(h('div', {class: 'edit-harness-lanes', dataset: {harnessView: 'map'}}, ...rows(24, 'Lane row')));
        const inspector = style(h('div', {class: 'edit-harness-inspector'}, h('p', {}, 'BAR 41'), ...rows(30, 'Inspector row')));
        el.append(lanes);
        inspectorEl?.append(inspector);
        return {destroy() { lanes.remove(); inspector.remove(); }};
      },
    }),
    chart: () => ({
      mount(el) {
        const score = style(h('div', {class: 'edit-harness-chart', dataset: {harnessView: 'chart'}}, ...rows(12, 'System')));
        el.append(score);
        return {destroy() { score.remove(); }};
      },
    }),
    details: () => ({
      mount(el) {
        const page = style(h('div', {class: 'edit-harness-details', dataset: {harnessView: 'details'}}, ...rows(16, 'Field')));
        el.append(page);
        return {update() {}, unmount() { page.remove(); }};
      },
    }),
  };
}

export default async function mount(el, {query, h}) {
  const ipad = query.get('ipad') === '1';
  const harnessPlatform = ipad ? {...platform, isIPad: true, isIOS: true} : platform;
  const router = recordingRouter();
  registry.provide('router', () => router);
  registry.provide('feedback', () => feedback);
  registry.provide('store', () => store);
  registry.provide('platform', () => harnessPlatform);
  registry.provide('desktop', () => ({available: false}));
  startDispatcher({platform: harnessPlatform});
  document.documentElement.dataset.place = 'edit';
  document.documentElement.dataset.posture = 'edit';

  const edit = await import('/src/edit/edit.js');
  const host = h('div', {class: 'edit-harness'});
  host.style.position = 'fixed';
  host.style.inset = '0';
  el.append(host);

  const bulk = Number(query.get('bulk'));
  if (Number.isFinite(bulk) && bulk > 0) {
    const page = h('div', {class: 'edit-harness-bulk-page', attrs: {'data-scroller': ''}});
    page.style.height = '100%';
    page.style.overflow = 'auto';
    host.append(page);
    const bar = edit.mountBulkPostureBar(page, {count: bulk, router, registry, platform: harnessPlatform});
    const body = h('div', {class: 'edit-harness-bulk-body'}, ...Array.from({length: 40}, (_, i) => h('p', {}, `Field ${i + 1} · Apply to ${bulk} songs`)));
    body.style.padding = 'var(--s5)';
    page.append(body);
    window.__edit = {bar, router, registry, run: (id, args) => registry.run(id, {source: 'key', args})};
    return window.__edit;
  }

  const ts = await createTestSession({
    mapped: query.get('mapped') !== '0',
    load: false,
    status: (text, options) => feedback.status(text, options),
  });
  const tab = ['map', 'chart', 'details'].includes(query.get('tab')) ? query.get('tab') : 'map';
  const find = query.get('find') === '1' && tab === 'map';
  const match = find
    ? {name: 'editFind', path: `/s/${ts.id}/edit/map/find`, params: {songId: ts.id, tab: 'map', find: true}, query: {}}
    : {name: 'edit', path: `/s/${ts.id}/edit/${tab}`, params: {songId: ts.id, tab}, query: {}};
  const editDeps = query.get('views') === 'real' ? {} : {views: standInViews(h)};
  const view = await edit.mount(host, match, {router, store, registry, feedback, platform: harnessPlatform, session: ts.session, editDeps});
  await ts.ready();
  window.__edit = {ts, view, router, registry, run: (id, args) => registry.run(id, {source: 'key', args})};
  return window.__edit;
}
