// Score geometry harness (package FX0). Engraves the synthetic drum part
// demoScore(seconds, bpm) through createScoreView() at a fixed width and
// publishes, on window.scoreGeometry:
//   ready        Promise of the first measurement (rejects on a render error)
//   measure()    geometry of the current engraving (shape below)
//   relayout(s)  set the engraving scale to s and time the relayout
// The page also sets <html data-rendered="true"> after every finished render
// and <html data-harness-error="…"> when engraving fails.
//
// Geometry shape (version 1):
//   {version, width, engravingWidth, scale, seconds, bpm, layout, barCount, hitCount,
//    barsPerSystem: [n, …], systems: [{y, bars: [index, …]}, …],
//    bars: [{index, system, x, y, w, h, lineTop, lineHeight}, …],
//    notes: [{key, bar, offset, instrument, x, y, w, h, dx, dy}, …]}
// A note's dx/dy are relative to its bar origin: the bar's left edge and the
// top staff line of its system (barBounds(index).x and .lineTop). `key` names
// a notehead independently of the random hit ids: bar, offset, instrument
// and its order among identical noteheads (left to right, top to bottom).
import {createScoreView} from '/src/js/notation/score-view.js';
import {demoScore} from '/tests/fixtures/drum-score.js';

const params = new URLSearchParams(location.search);
const numberParam = (name, fallback) => {
  const value = Number(params.get(name));
  return params.has(name) && Number.isFinite(value) && value > 0 ? value : fallback;
};
const config = {
  scale: numberParam('scale', 1),
  width: numberParam('width', 1200),
  seconds: numberParam('seconds', 64),
  bpm: numberParam('bpm', 120),
  layout: params.get('layout') || 'combined',
};

const status = document.getElementById('status');
const host = document.getElementById('score');
host.style.width = `${config.width}px`;

const score = demoScore(config.seconds, config.bpm);
const barOfMeasure = new Map(score.timeline.measures.map((measure, index) => [measure.id, index]));
const barOfHit = new Map();
for (const bar of score.bars) for (const hit of bar.hits) barOfHit.set(hit.id, barOfMeasure.get(bar.measureId));

const round = value => Math.round(value * 100) / 100;
const offsetText = offset => `${offset.n}/${offset.d}`;

let renders = 0;
let waiting = [];
const view = createScoreView(host, {
  scale: config.scale,
  onRender: () => {
    renders += 1;
    document.documentElement.dataset.rendered = 'true';
    document.documentElement.dataset.renderCount = String(renders);
    const settle = waiting;
    waiting = [];
    for (const resolve of settle) resolve();
  },
});
const nextRender = () => new Promise(resolve => waiting.push(resolve));
const frames = (count = 2) => new Promise(resolve => {
  const step = left => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
  step(count);
});

function measure() {
  const barCount = score.timeline.measures.length;
  const bars = [];
  for (let index = 0; index < barCount; index++) {
    const bounds = view.barBounds(index);
    if (!bounds) continue;
    bars.push({index, x: round(bounds.x), y: round(bounds.y), w: round(bounds.w), h: round(bounds.h),
      lineTop: round(bounds.lineTop ?? bounds.y), lineHeight: round(bounds.lineHeight ?? bounds.h)});
  }
  // Bars share a system when they share its top edge.
  const systems = [];
  for (const bar of bars) {
    const last = systems.at(-1);
    if (last && Math.abs(last.y - bar.y) < 0.5) last.bars.push(bar.index);
    else systems.push({y: bar.y, bars: [bar.index]});
  }
  systems.forEach((system, k) => { for (const index of system.bars) bars.find(b => b.index === index).system = k; });
  const barByIndex = new Map(bars.map(bar => [bar.index, bar]));

  const raw = [];
  for (const box of view.noteBoxes()) {
    const bar = barOfHit.get(box.hit?.id);
    const origin = barByIndex.get(bar);
    if (bar == null || !origin) continue;
    raw.push({bar, offset: offsetText(box.hit.offset), instrument: box.hit.instrument,
      x: box.x, y: box.y, w: box.w, h: box.h, dx: box.x - origin.x, dy: box.y - origin.lineTop});
  }
  raw.sort((a, b) => a.bar - b.bar || a.dx - b.dx || a.dy - b.dy || (a.instrument < b.instrument ? -1 : a.instrument > b.instrument ? 1 : 0));
  const seen = new Map();
  const notes = raw.map(note => {
    const base = `${note.bar}:${note.offset}:${note.instrument}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return {key: `${base}#${n}`, bar: note.bar, offset: note.offset, instrument: note.instrument,
      x: round(note.x), y: round(note.y), w: round(note.w), h: round(note.h), dx: round(note.dx), dy: round(note.dy)};
  });
  const engraving = host.querySelector('.score-engraving');
  return {
    version: 1,
    width: config.width,
    engravingWidth: engraving ? Math.round(engraving.getBoundingClientRect().width) : null,
    scale: config.scale,
    seconds: config.seconds,
    bpm: config.bpm,
    layout: config.layout,
    barCount,
    hitCount: barOfHit.size,
    barsPerSystem: systems.map(system => system.bars.length),
    systems,
    bars,
    notes,
  };
}

/** Change the engraving scale and time it: until alphaTab's render finishes, and until two frames later (painted). */
async function relayout(scale) {
  const done = nextRender();
  const start = performance.now();
  view.setScale(scale);
  await done;
  const renderMs = performance.now() - start;
  await frames(2);
  const paintMs = performance.now() - start;
  config.scale = scale;
  return {scale, renderMs: round(renderMs), paintMs: round(paintMs)};
}

// alphaTab reports layout and font failures through its error event.
const failure = new Promise((_, reject) => view.api.error?.on?.(error => reject(error instanceof Error ? error : new Error(String(error)))));

const ready = (async () => {
  const first = nextRender();
  const start = performance.now();
  view.setScore(score, {layout: config.layout});
  await Promise.race([first, failure]);
  if (document.fonts?.ready) await document.fonts.ready;
  await frames(2);
  const geometry = measure();
  const firstRenderMs = round(performance.now() - start);
  status.textContent = `Engraved ${geometry.barCount} bars in ${geometry.systems.length} systems at ${Math.round(config.scale * 100)}%.`;
  return {...geometry, firstRenderMs};
})();
ready.catch(error => {
  document.documentElement.dataset.harnessError = String(error?.message || error);
  status.textContent = `Engraving failed: ${error?.message || error}`;
});

window.scoreGeometry = {config, ready, measure, relayout, view};
