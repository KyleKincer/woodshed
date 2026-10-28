// ST9's harness (/__harness/chart-surface): the Stage (src/stage/stage.js) on the Chart surface
// (src/stage/surfaces/chart-surface.js), full window, over a real song session with a real drum
// part (tests/helpers/test-session.js `createTestSession` with demoScore: 64 bars of 4/4 at 120 bpm
// on the rehearsal map, 8 sections). Load it with ?place=stage so the Stage tokens apply.
//
// Query:
//   part=dense (default) | sparse | none      the drum part (none: the owner's empty state)
//   shared=1          a read-only Shared Stage session with no part ("No drum chart was shared.")
//   opening=1         the part never answers ("Opening the drum chart…")
//   error=1           the part fails to open until Try again
//   distance=near|stand|kit, focus=1, follow=scroll|page, display=split|combined, pinch=1.45   device prefs
//   cue=40            cue (seconds) · loop=17-24 bars (1-based, inclusive)
// window.__chartSurface = {ts, view, router, registry, run(id, args), stage(), chart(), relayout(fn)}
// for tests/fixture/states/ST9.cjs. relayout(fn) runs fn (a Distance change, a zoom step) and
// resolves with the relayouts it caused: the chart's timing of each (ms), as D54 samples them.
import {registry} from '/src/app/commands.js';
import '/src/app/global-commands.js';
import '/src/stage/transport-commands.js';
import '/src/stage/commands.js';
import {startDispatcher} from '/src/app/dispatch.js';
import * as feedback from '/src/app/feedback.js';
import {platform} from '/src/app/platform.js';
import {prefs} from '/src/app/prefs.js';
import {store} from '/src/app/store.js';
import {createTestSession} from '/tests/helpers/test-session.js';
import {demoScore} from '/tests/fixtures/drum-score.js';

const SECONDS = 128;
const BAR = 2;   // seconds per bar on the rehearsal map

function scoreFor(kind) {
  if (kind === 'none') return null;
  const score = demoScore(SECONDS, 120);
  if (kind === 'sparse') for (const bar of score.bars) bar.hits = bar.hits.slice(0, 3);
  return score;
}

function practiceFor(query) {
  const loop = /^(\d+)-(\d+)$/.exec(query.get('loop') || '');
  const cue = Number(query.get('cue'));
  const a = loop ? (Number(loop[1]) - 1) * BAR : 0;
  const b = loop ? Number(loop[2]) * BAR : 0;
  return {
    v: 2, surface: 'chart', cue: loop ? a : Number.isFinite(cue) ? cue : 0, rate: 1,
    loop: {on: !!loop, a, b, eachPassCount: true, playTimes: 0, between: 'none'},
    tracks: [], minusMe: false, trainer: null, spots: [], markers: [],
  };
}

export default async function mount(el, {query, h}) {
  const distance = query.get('distance');
  const follow = query.get('follow');
  const display = query.get('display');
  const pinch = Number(query.get('pinch'));
  prefs.update((d) => {
    d.practice.distance = ['near', 'stand', 'kit'].includes(distance) ? distance : 'stand';
    d.practice.focus = query.get('focus') === '1';
    if (follow === 'scroll' || follow === 'page') d.practice.follow = {rail: follow, band: follow};
    d.chart = {display: {layout: display === 'split' || display === 'combined' ? display : null}, pinchScale: Number.isFinite(pinch) && pinch > 0 ? pinch : null};
  });
  const shared = query.get('shared') === '1';
  const score = shared ? null : scoreFor(query.get('part') || 'dense');
  let failing = query.get('error') === '1';
  const openPart = query.get('opening') === '1'
    ? () => new Promise(() => {})
    : failing
      ? async (options) => {
        if (failing) { failing = false; throw new Error('The drum part could not be reached (harness).'); }
        return (await import('/src/js/notation/part.js')).openPart(options);
      }
      : undefined;
  const ts = await createTestSession({
    score, practice: practiceFor(query), load: false, openPart,
    ...(shared ? {shared: {token: 'harness-share'}, hasChart: false} : {}),
    ...(query.get('part') === 'none' ? {hasChart: false} : {}),
    status: (text, options) => feedback.status(text, options),
  });

  const router = {
    calls: [],
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
  registry.provide('desktop', () => ({available: false}));
  startDispatcher({platform});
  document.documentElement.dataset.posture = 'stage';

  const stage = await import('/src/stage/stage.js');
  const host = h('div', {class: 'chart-surface-harness'});
  host.style.position = 'fixed';
  host.style.inset = '0';
  el.append(host);
  const view = await stage.mount(host, {name: 'stage', path: `/s/${ts.id}`, params: {songId: ts.id}, query: {}},
    {router, store, registry, feedback, platform, session: ts.session});
  if (query.get('opening') !== '1') await ts.ready();

  const chart = () => document.querySelector('.chart-surface .chart');
  const surfaceRoot = () => document.querySelector('.chart-surface');
  /**
   * Runs fn (a Distance change, a zoom step) and resolves, once 600 ms pass with no relayout, with the
   * relayouts it caused: the chart's own timings (ms each, the surface's data-relayout-ms) in order.
   */
  function relayout(fn) {
    return new Promise((resolve) => {
      const target = surfaceRoot();
      const records = [];
      let quiet = null;
      const done = () => {
        observer.disconnect();
        records.push(...observer.takeRecords());
        // Each record holds the value before it: the values written are the next record's old value, then the current one.
        const values = records.map((r, i) => (i + 1 < records.length ? records[i + 1].oldValue : target.dataset.relayoutMs));
        resolve(values.map(Number).filter(Number.isFinite));
      };
      const observer = new MutationObserver((list) => {
        records.push(...list);
        clearTimeout(quiet);
        quiet = setTimeout(done, 600);
      });
      observer.observe(target, {attributes: true, attributeFilter: ['data-relayout-ms'], attributeOldValue: true});
      fn();
      quiet = setTimeout(done, 3000);
    });
  }

  window.__chartSurface = {
    ts, view, router, registry, relayout,
    run: (id, args) => registry.run(id, {source: 'key', args}),
    stage: () => registry.context().stage,
    chart,
  };
  return window.__chartSurface;
}
