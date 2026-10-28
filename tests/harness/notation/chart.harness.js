// The chart harness (/__harness/chart): src/js/notation/chart.js on the demo
// drum part, with a stand-in surface that does what chart-surface.js will do
// with the chart's events (stopped taps cue, loop commits are answered with
// setLoopRange). States and probes drive it through window.__chartHarness.
// Query parameters (all optional):
//   scale=1.3           engraving scale (default: the Distance default, spec §4.11; iPad below 1000 px wide)
//   distance=near|stand|kit   the label floors (14 / 20 px × 0.8, 1, 1.3) and [data-distance]
//   follow=scroll|page  anchor=0.33      follow style and line
//   layout=combined|split   rows=N       Display (this device)
//   seconds=64          demoScore(seconds, 120): 64 s is 32 bars of 4/4
//   loop=3-4            bars (1-based) to loop · at=12 the playing position in seconds
//   glass=1             playing (touch never draws loops; handles at half strength)
//   empty=1 · shared=1  the empty state, or the shared one
import {createChart, FONT_FLOORS} from '../../../src/js/notation/chart.js';
import {demoScore} from '../../fixtures/drum-score.js';
import {musicalStarts, number, toTime} from '../../../shared/notation.ts';

const DISTANCE = {near: 0.8, stand: 1, kit: 1.3};
// Spec §4.11: the chart scale per Distance, laptop and iPad portrait.
const CHART_SCALE = {laptop: {near: 1.1, stand: 1.3, kit: 1.6}, ipad: {near: 1, stand: 1.2, kit: 1.5}};

export default async function mount(el, {query, h}) {
  const num = (name, fallback) => { const v = Number(query.get(name)); return query.has(name) && Number.isFinite(v) && v > 0 ? v : fallback; };
  const distanceName = DISTANCE[query.get('distance')] ? query.get('distance') : 'stand';
  const d = DISTANCE[distanceName];
  const scale = num('scale', CHART_SCALE[window.innerWidth >= 1000 ? 'laptop' : 'ipad'][distanceName]);
  const empty = query.get('empty') === '1' || query.get('shared') === '1';
  const score = empty ? null : demoScore(num('seconds', 64), 120);
  const listeners = new Set();
  const part = {score, hasNotation: !!score, readOnly: query.get('shared') === '1', subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
  let position = num('at', 0);
  const engine = {getPosition: () => position};
  const log = {events: [], edits: [], follows: [], statuses: [], relayouts: [], actions: []};

  const status = h('p', {role: 'status', class: 'chart-harness-status'}, 'Ready');
  status.style.cssText = 'margin: 0 0 var(--s3); font: var(--fs-14)/1.4 var(--font-ui); color: var(--ink-3)';
  const music = h('section', {'aria-label': 'Drum chart', 'data-distance': distanceName});
  music.style.cssText = 'display: flex; flex-direction: column; flex: 1; min-height: 0; border: 1px solid var(--line); border-radius: var(--r-surface); overflow: hidden';
  const frame = h('div', {}, status, music);
  frame.style.cssText = 'display: flex; flex-direction: column; height: 100%; min-height: 0';
  el.style.overflow = 'hidden';
  el.append(frame);
  const say = text => { status.textContent = text; };

  const chart = createChart({
    host: music, part, engine, scale,
    display: {layout: query.get('layout') || null, barsPerRow: num('rows', -1)},
    followStyle: query.get('follow') === 'page' ? 'page' : 'scroll',
    followAnchor: num('anchor', 0.33),
    glass: query.get('glass') === '1',
    fonts: {barNumber: FONT_FLOORS.barNumber * d, marker: FONT_FLOORS.marker * d},
    onBarActivate(event) {
      log.events.push(event);
      if (event.kind === 'tap' && !event.glass) { position = event.beatTime; chart.tick(position); }
      say(`${event.kind} · bar ${event.index + 1} · ${event.pointerType}`);
    },
    onLoopEdit(edit) {
      log.edits.push(edit);
      if (edit.phase === 'commit') chart.setLoopRange({a: edit.a, b: edit.b});
      say(`loop ${edit.phase} · ${edit.a.toFixed(2)}–${edit.b.toFixed(2)} s`);
    },
    onFollowChange(following) { log.follows.push(following); say(following ? 'Following' : 'Follow paused'); },
    onStatus(text) { log.statuses.push(text); say(text); },
    onRelayout(info) { log.relayouts.push(info); },
    onEmpty: part.readOnly ? {} : {
      findChart: () => { log.actions.push('findChart'); say('Find a chart'); },
      importFile: () => { log.actions.push('importFile'); say('Import a file'); },
      write: () => { log.actions.push('write'); say('Write one'); },
    },
  });
  chart.setVisible(true);

  const barTime = bar => (score ? toTime(score.timeline, number(musicalStarts(score.timeline)[bar])) : 0);
  const loop = /^(\d+)-(\d+)$/.exec(query.get('loop') || '');
  if (loop && score) chart.setLoopRange({a: barTime(Number(loop[1]) - 1), b: barTime(Number(loop[2]))});
  if (score) chart.reveal(position);
  const set = t => { position = t; chart.tick(t); };

  window.__chartHarness = {chart, part, log, scale, distance: d, set, barTime, get position() { return position; }};
  if (score) {
    await new Promise(resolve => {
      const done = () => { if (/^\d+$/.test(music.dataset.rendered ?? '')) resolve(); else requestAnimationFrame(done); };
      done();
    });
    set(position);
  }
  return {unmount() { chart.destroy(); delete window.__chartHarness; el.replaceChildren(); }};
}
