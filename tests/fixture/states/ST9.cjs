// ST9's states: the Chart surface (src/stage/surfaces/chart-surface.js) in the real Stage on its
// harness (/__harness/chart-surface, a real song session with the demo drum part, 64 bars of 4/4 at
// 120 bpm on the 8-section rehearsal map), and the app on the fixture database. Every harness state
// runs with fx-audio=manual and the Stage tokens (?place=stage).
//   st9-chart                 rail / band: the chart fills the music area; dense part → 4 / 2 bars per
//                             system; bar numbers ≥ 14 px and section labels ≥ 20 px on screen; the
//                             chart's scroller is the surface's [data-scroller]; Stage dark tokens; axe; targets
//   st9-chart-near, -kit      Distance Near / Kit: the scale and the label floors (14 × d, 20 × d px)
//   st9-chart-follow          playing: a wheel scroll pauses Follow and shows ⤓ Back to playhead (56 px,
//                             bottom centre of the music); the pill, F and Again resume it
//   st9-chart-idle            playing, Follow paused: it resumes by itself after 8 s without touching the music
//   st9-chart-glass           iPad: a stopped tap cues the bar; a tap while playing shows the pill
//                             "▶ Play from bar 13" and never seeks; tapping the pill jumps there
//   st9-chart-mouse-loop      laptop: a mouse drag across bars 5–8 loops them (bar-snapped), answered on the chart
//   st9-chart-pinch           iPad: a two-finger pinch previews and commits one relayout at the new scale (stored per
//                             device, with the Distance it was made at)
//   st9-chart-zoom            = and − step the scale (1.3 → 1.45 → 1.3), one relayout each; a step is Stand's only:
//                             at Kit the Kit scale applies, back at Stand the step does again (prefs.chart.pinchDistance)
//   st9-chart-bars            keyboard: the bar list (stage.bars): ←/→ rove with a visible card, L loops
//                             the bar, Enter plays from it; axe on the surface
//   st9-chart-menu            right-click, Shift+F10 on the bar list and (iPad) a long-press open the bar
//                             menu (needs ST8a's src/stage/menus.js)
//   st9-chart-display         Display → Hands & feet (this device): one relayout into the split layout
//   st9-chart-empty           owner, no part: "No drum chart yet" [Find a chart] [Import a file] [Write one]
//   st9-chart-shared          shared, no part: "No drum chart was shared." and no actions
//   st9-chart-opening         the part never answers: "Opening the drum chart…" (aria-busy), no chart
//   st9-chart-error           the part fails to open: the error with Try again, which opens it
//   st9-chart-r1              R1 (D54): a Distance change to each Distance on the 64-bar part (median of 5;
//                             the sum of the chart's own timings of every relayout the change took) against
//                             FX0's relayout64Ms × 1.15; gated only in a quiet container
//   st9-chart-relayouts       a Distance change and a rail → band switch (dense part) are one chart.configure
//                             call each: exactly one relayout asked for and one engraving (I2b-5)
//   st9-app-chart             /s/glasshouse on the fixture: the Stage opens on the chart surface
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {checkAxe} = require('../probes/probe-axe.cjs');
const {checkTargets} = require('../probes/probe-targets.cjs');
const {median, validity} = require('../probes/probe-perf-legacy.cjs');

const HARNESS = (query = '') => `/__harness/chart-surface?place=stage&fx-audio=manual${query ? `&${query}` : ''}`;
const APP = (songPath, query = '') => `${songPath}?fx-reset=1&fx-jobs=0&fx-audio=manual&fx-now=2026-10-28T12:00:00Z${query ? `&${query}` : ''}`;
const MENUS = ['src/stage/menus.js'];
const BASELINE = path.resolve(__dirname, '../baselines/legacy/perf.json');
const MAX_RATIO = 1.15;
const QUIET_LOAD = 0.5;
const DISTANCE = {near: 0.8, stand: 1, kit: 1.3};
const SECTIONS = ['Intro', 'Verse', 'Chorus', 'Bridge', 'Outro'];

/** Waits for the first engraving (or the empty state) and the fonts. */
async function ready(page, t, {empty = false} = {}) {
  await t.loadPhase('ready');
  if (empty) await page.waitForSelector('.chart-surface .chart[data-rendered="empty"]', {state: 'attached', timeout: 30_000});
  else await page.waitForFunction(() => /^\d+$/.test(document.querySelector('.chart-surface .chart')?.dataset.rendered ?? ''), null, {timeout: 30_000});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

/** Runs in the page: the engraved bar numbers and section labels (alphaTab SVG text), with their on-screen size. */
function engravingFacts(sections) {
  const texts = [...document.querySelectorAll('.chart-surface .chart svg text')].map((el) => {
    const r = el.getBoundingClientRect();
    return {text: el.textContent.trim(), fs: parseFloat(getComputedStyle(el).fontSize), x: Math.round(r.x), y: Math.round(r.y)};
  });
  const numbers = texts.filter((x) => /^\d+$/.test(x.text)).map((x) => ({...x, n: Number(x.text)}));
  const labels = texts.filter((x) => sections.includes(x.text));
  const rows = new Map();
  for (const b of numbers) {
    const key = [...rows.keys()].find((y) => Math.abs(y - b.y) < 6) ?? b.y;
    rows.set(key, [...(rows.get(key) ?? []), b.n]);
  }
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
  };
  return {
    numbers: numbers.length, minNumber: Math.min(...numbers.map((b) => b.fs)),
    labels: labels.length, minLabel: Math.min(...labels.map((b) => b.fs)),
    perSystem: [...rows.values()].slice(0, 3).map((r) => r.length),
    music: box('.stage-music'), surface: box('.chart-surface'), scroller: box('.chart-surface [data-scroller]'),
    layout: document.querySelector('.stage')?.dataset.stageLayout,
  };
}

const snap = (page) => page.evaluate(() => {
  const s = window.__chartSurface.ts.session.transport.snapshot.peek();
  return {phase: s.phase, cue: s.cue, loop: s.loop, pendingJump: s.pendingJump, position: window.__chartSurface.ts.session.transport.position()};
});
const pillBox = (page) => page.evaluate(() => {
  const host = document.querySelector('.chart-surface-follow');
  if (!host || host.hidden) return null;
  const r = host.querySelector('button').getBoundingClientRect();
  const m = document.querySelector('.stage-music').getBoundingClientRect();
  return {x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, bottom: r.bottom, musicCx: m.x + m.width / 2, musicBottom: m.bottom, text: host.textContent};
});
const following = (page) => page.evaluate(() => document.querySelector('.chart-surface').hasAttribute('data-following'));
const prefOf = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem('ws.prefs') ?? '{}')?.chart?.[k] ?? null, key);
const revision = (page) => page.evaluate(() => Number(document.querySelector('.chart-surface .chart').dataset.rendered));
/** The on-screen size of the first engraved bar number (its engraving size × the chart scale). */
const barNumberPx = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll('.chart-surface .chart svg text')].find((x) => /^\d+$/.test(x.textContent.trim()));
  return el ? parseFloat(getComputedStyle(el).fontSize) : null;
});
/** Runs a Stage Distance change and waits for the engraving after `rev`. */
async function changeDistance(page, d, rev) {
  await page.evaluate((x) => window.__chartSurface.relayout(() => window.__chartSurface.stage().setDistance(x)), d);
  await page.waitForFunction((r) => Number(document.querySelector('.chart-surface .chart').dataset.rendered) > r, rev, {timeout: 10_000});
}

/** The page position of bar n's number (1-based), the anchor for pointer gestures on that bar. */
async function barPoint(page, n, {dy = 40} = {}) {
  return page.evaluate(({n, dy}) => {
    const el = [...document.querySelectorAll('.chart-surface .chart svg text')].find((x) => x.textContent.trim() === String(n));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {x: r.x + 40, y: r.y + dy};
  }, {n, dy});
}

/** Wheel over the music after the 900 ms programmatic-scroll guard (a manual scroll). */
async function wheelScroll(page) {
  await page.waitForTimeout(1000);
  const music = await page.locator('.chart-surface [data-scroller]').boundingBox();
  await page.mouse.move(music.x + music.width / 2, music.y + music.height / 2);
  await page.mouse.wheel(0, 240);
  await page.waitForFunction(() => !document.querySelector('.chart-surface').hasAttribute('data-following'), null, {timeout: 5_000});
}

const play = (page) => page.evaluate(() => window.__chartSurface.run('transport.playStop'));

async function distanceState(page, t, distance) {
  await ready(page, t);
  const f = await page.evaluate(engravingFacts, SECTIONS);
  const d = DISTANCE[distance];
  t.expect(f.minNumber >= 14 * d - 0.05, `bar numbers ≥ ${14 * d} px at ${distance} (got ${f.minNumber})`);
  t.expect(f.minLabel >= 20 * d - 0.05, `section labels ≥ ${20 * d} px at ${distance} (got ${f.minLabel})`);
  const scale = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.chart-surface .chart svg text')].find((x) => /^\d+$/.test(x.textContent.trim()));
    return parseFloat(getComputedStyle(el).fontSize);
  });
  const expectScale = {rail: {near: 1.1, stand: 1.3, kit: 1.6}, band: {near: 1, stand: 1.2, kit: 1.5}}[f.layout][distance];
  const engraving = Math.ceil(14 * d / expectScale - 1e-9);
  t.expect(Math.abs(scale - engraving * expectScale) < 0.11, `bar number ${engraving} px engraved × ${expectScale} (got ${scale})`);
}

module.exports = [
  {
    name: 'st9-chart', url: HARNESS(),
    async fn(page, t) {
      await ready(page, t);
      const f = await page.evaluate(engravingFacts, SECTIONS);
      t.expect(f.music && f.surface && f.music.w === f.surface.w && f.music.h === f.surface.h && f.music.y === f.surface.y,
        `the chart fills the music area (${JSON.stringify(f.music)} vs ${JSON.stringify(f.surface)})`);
      t.expect(f.scroller && f.scroller.w === f.surface.w, `the chart's scroller is the surface's [data-scroller] (${JSON.stringify(f.scroller)})`);
      const perSystem = t.device === 'laptop' ? 4 : 2;
      t.expect(f.layout === (t.device === 'laptop' ? 'rail' : 'band'), `layout ${f.layout}`);
      t.expect(f.perSystem.length >= 2 && f.perSystem.every((n) => n === perSystem), `a dense part: ${perSystem} bars per system (got ${f.perSystem})`);
      t.expect(f.minNumber >= 14 - 0.05, `bar numbers ≥ 14 px (got ${f.minNumber})`);
      t.expect(f.labels >= 1 && f.minLabel >= 20 - 0.05, `section labels ≥ 20 px (got ${f.minLabel}, ${f.labels})`);
      const style = await page.evaluate(() => {
        const scroller = document.querySelector('.chart-surface [data-scroller]');
        const probe = document.createElement('div');
        probe.style.background = 'var(--bg)';
        document.querySelector('.stage').append(probe);
        const bg = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {gutter: getComputedStyle(scroller).scrollbarGutter, chartBg: getComputedStyle(document.querySelector('.chart-surface .chart')).backgroundColor, bg,
          stageTheme: document.documentElement.dataset.stageTheme, pill: document.querySelector('.chart-surface-follow').hidden};
      });
      t.expect(style.gutter.startsWith('stable'), `scrollbar-gutter: stable (got ${style.gutter})`);
      t.expect(style.stageTheme === 'dark' && style.chartBg === style.bg, `the chart sits on the Stage's dark --bg (${style.chartBg} vs ${style.bg})`);
      t.expect(style.pill, 'no Back to playhead pill while following');
      const problems = await checkAxe(page, {include: ['.chart-surface']});
      t.expect(!problems.length, problems.join('; '));
      const small = await checkTargets(page);
      t.expect(!small.length, `targets: ${JSON.stringify(small.slice(0, 6))}`);
    },
  },
  // The rail's controls at Near (232 px) clip "Count-in 1 bar" by a few px: ST5's controls, reported in the handoff.
  {name: 'st9-chart-near', url: HARNESS('distance=near'), opts: {themes: ['dark'], structure: {ignore: ['.stage-controls']}}, fn: (page, t) => distanceState(page, t, 'near')},
  {name: 'st9-chart-kit', url: HARNESS('distance=kit'), opts: {themes: ['dark']}, fn: (page, t) => distanceState(page, t, 'kit')},
  {
    name: 'st9-chart-follow', url: HARNESS(), opts: {devices: ['laptop']},
    async fn(page, t) {
      await ready(page, t);
      await play(page);
      await t.transportPhase('playing');
      await wheelScroll(page);
      const pill = await pillBox(page);
      t.expect(pill && Math.round(pill.h) === 56, `⤓ Back to playhead is 56 px tall (got ${JSON.stringify(pill)})`);
      t.expect(Math.abs(pill.cx - pill.musicCx) < 1.5 && pill.bottom < pill.musicBottom && pill.musicBottom - pill.bottom < 80,
        `the pill sits at the bottom centre of the music (${JSON.stringify(pill)})`);
      t.expect(pill.text.includes('Back to playhead'), `the pill reads "Back to playhead" (${pill.text})`);
      await t.capture('paused');
      await page.locator('.chart-surface-follow button').click();
      t.expect(await following(page), 'the pill resumes Follow');
      t.expect(!(await pillBox(page)), 'the pill hides');
      await wheelScroll(page);
      await page.keyboard.press('KeyF');
      t.expect(await following(page), 'F resumes Follow (D25)');
      await wheelScroll(page);
      await page.evaluate(() => window.__chartSurface.run('transport.again'));
      t.expect(await following(page), 'Again resumes Follow');
      const view = await page.evaluate(() => window.__chartSurface.stage().following.peek());
      t.expect(view === true, 'the Stage hears Follow resume (stage.following)');
    },
  },
  {
    name: 'st9-chart-idle', url: HARNESS(), opts: {devices: ['laptop'], themes: ['dark'], capture: false, timeout: 60_000},
    async fn(page, t) {
      await ready(page, t);
      await play(page);
      await t.transportPhase('playing');
      await wheelScroll(page);
      await page.waitForTimeout(6000);
      t.expect(!(await following(page)), 'still paused after 6 s');
      await page.waitForFunction(() => document.querySelector('.chart-surface').hasAttribute('data-following'), null, {timeout: 4_000});
      t.expect(!(await pillBox(page)), 'Follow resumed by itself after 8 s idle; the pill hides');
    },
  },
  {
    name: 'st9-chart-glass', url: HARNESS(), opts: {devices: ['ipad']},
    async fn(page, t) {
      await ready(page, t);
      const touch = await t.touch();
      const bar9 = await barPoint(page, 9);
      await touch.tap(bar9);
      await page.waitForTimeout(400);
      let s = await snap(page);
      t.expect(s.phase === 'stopped' && s.cue >= 16 - 0.01 && s.cue < 18, `a stopped tap cues bar 9 (cue ${s.cue})`);
      await play(page);
      await t.transportPhase('playing');
      const bar13 = await barPoint(page, 13);
      const before = (await snap(page)).position;
      await touch.tap(bar13);
      const pill = await page.waitForSelector('.stage-pill', {timeout: 5_000});
      const label = (await pill.textContent()).replace(/\s+/g, ' ').trim();
      t.expect(label === '▶ Play from bar 13', `the glass pill (got "${label}")`);
      s = await snap(page);
      t.expect(Math.abs(s.position - before) < 0.5 && !s.pendingJump, `a tap while playing never seeks (${JSON.stringify(s)})`);
      await t.capture('pill');
      await touch.tap(page.locator('.stage-pill'));
      await page.waitForTimeout(100);
      s = await snap(page);
      t.expect(s.pendingJump && Math.abs(s.pendingJump.t - 24) < 2, `tapping the pill jumps to bar 13 (${JSON.stringify(s.pendingJump)})`);
    },
  },
  {
    name: 'st9-chart-mouse-loop', url: HARNESS(), opts: {devices: ['laptop']},
    async fn(page, t) {
      await ready(page, t);
      const from = await barPoint(page, 5), to = await barPoint(page, 8);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + (to.x - from.x) * i / 12, from.y + (to.y - from.y) * i / 12);
      await page.mouse.up();
      await page.waitForTimeout(300);
      const s = await snap(page);
      t.expect(s.loop.on && Math.abs(s.loop.a - 8) < 0.01 && Math.abs(s.loop.b - 16) < 0.01, `bars 5–8 loop (${JSON.stringify(s.loop)})`);
      const chartLoop = await page.evaluate(() => !!document.querySelector('.chart-surface .score-overlay [class*=loop], .chart-surface .score-overlay rect'));
      t.expect(chartLoop, 'the loop band is drawn on the chart');
    },
  },
  {
    name: 'st9-chart-pinch', url: HARNESS(), opts: {devices: ['ipad']},
    async fn(page, t) {
      await ready(page, t);
      const before = await revision(page);
      const box = await page.locator('.chart-surface [data-scroller]').boundingBox();
      const touch = await t.touch();
      await touch.pinch({x: box.x + box.width / 2, y: box.y + box.height / 3}, {from: 120, to: 180, steps: 10});
      await page.waitForFunction((r) => Number(document.querySelector('.chart-surface .chart').dataset.rendered) > r, before, {timeout: 10_000});
      await page.waitForTimeout(400);
      const after = await revision(page);
      const scale = await prefOf(page, 'pinchScale');
      t.expect(after === before + 1, `one relayout on release (${before} → ${after})`);
      t.expect(Math.abs(scale - 1.8) < 0.05, `the pinch scale 1.2 × 1.5 is stored for this device (${scale})`);
      t.expect(await prefOf(page, 'pinchDistance') === 'stand', `with the Distance it was made at (${await prefOf(page, 'pinchDistance')})`);
      const preview = await page.evaluate(() => document.querySelector('.chart-surface .chart-score').style.transform);
      t.expect(!preview, `the preview transform is cleared (${preview})`);
    },
  },
  {
    name: 'st9-chart-zoom', url: HARNESS(), opts: {devices: ['laptop'], themes: ['dark']},
    async fn(page, t) {
      await ready(page, t);
      const r0 = await revision(page);
      await page.keyboard.press('Equal');
      await page.waitForFunction((r) => Number(document.querySelector('.chart-surface .chart').dataset.rendered) > r, r0, {timeout: 10_000});
      t.expect(await prefOf(page, 'pinchScale') === 1.45, `= steps to 145% (${await prefOf(page, 'pinchScale')})`);
      const r1 = await revision(page);
      await page.keyboard.press('Minus');
      await page.waitForFunction((r) => Number(document.querySelector('.chart-surface .chart').dataset.rendered) > r, r1, {timeout: 10_000});
      t.expect(await prefOf(page, 'pinchScale') === 1.3, `− steps back to 130% (${await prefOf(page, 'pinchScale')})`);
      t.expect(await revision(page) === r1 + 1, 'one relayout per step');
      // The step belongs to Stand (I2b-3): Kit engraves at its own scale, Stand at the step again.
      const r2 = await revision(page);
      await page.keyboard.press('Equal');
      await page.waitForFunction((r) => Number(document.querySelector('.chart-surface .chart').dataset.rendered) > r, r2, {timeout: 10_000});
      t.expect(await prefOf(page, 'pinchDistance') === 'stand', `the step is stored for Stand (${await prefOf(page, 'pinchDistance')})`);
      const stepped = await barNumberPx(page);
      t.expect(Math.abs(stepped - 10 * 1.45) < 0.05, `bar numbers at 145% (${stepped} px)`);
      await changeDistance(page, 'kit', await revision(page));
      const kit = await barNumberPx(page);
      t.expect(Math.abs(kit - 12 * 1.6) < 0.05, `Kit engraves at its own 160%, not Stand's step (${kit} px)`);
      t.expect(await prefOf(page, 'pinchScale') === 1.45, `the step is kept for Stand (${await prefOf(page, 'pinchScale')})`);
      await changeDistance(page, 'stand', await revision(page));
      const back = await barNumberPx(page);
      t.expect(Math.abs(back - 10 * 1.45) < 0.05, `back at Stand the step applies again (${back} px)`);
    },
  },
  {
    name: 'st9-chart-bars', url: HARNESS('cue=32'), opts: {devices: ['laptop']},
    async fn(page, t) {
      await ready(page, t);
      await page.locator('.chart-bars').focus();
      await page.keyboard.press('ArrowRight');
      const card = await page.evaluate(() => {
        const el = document.querySelector('.chart-bars-card');
        const r = el.getBoundingClientRect();
        return {text: el.textContent, w: r.width, h: r.height, outline: getComputedStyle(el).outlineStyle,
          option: document.querySelector('.chart-bars [role=option]').textContent};
      });
      t.expect(card.option === 'Bar 18 · Chorus' && card.text.startsWith('Bar 18 · Chorus'), `the focused bar (${JSON.stringify(card)})`);
      t.expect(card.w > 100 && card.h > 30 && card.outline === 'solid', `the focus card is visible with a ring (${JSON.stringify(card)})`);
      await t.capture('focused');
      const problems = await checkAxe(page, {include: ['.chart-surface']});
      t.expect(!problems.length, problems.join('; '));
      await page.keyboard.press('KeyL');
      let s = await snap(page);
      t.expect(s.loop.on && Math.abs(s.loop.a - 34) < 0.01 && Math.abs(s.loop.b - 36) < 0.01, `L loops bar 18 (${JSON.stringify(s.loop)})`);
      await page.evaluate(() => window.__chartSurface.ts.session.transport.clearLoop());
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      await t.transportPhase('playing');
      s = await snap(page);
      t.expect(Math.abs(s.position - 32) < 0.5, `Enter plays from bar 17 (${s.position})`);
    },
  },
  {
    name: 'st9-chart-menu', url: HARNESS(), opts: {requires: MENUS},
    async fn(page, t) {
      await ready(page, t);
      const bar = await barPoint(page, 6);
      if (t.device === 'ipad') await (await t.touch()).longPress(bar, {ms: 600});
      else await page.mouse.click(bar.x, bar.y, {button: 'right'});
      const menu = await page.waitForSelector('[role=menu]', {timeout: 5_000});
      const items = await menu.evaluate((el) => [...el.querySelectorAll('[role^=menuitem]')].map((i) => i.textContent.replace(/\s+/g, ' ').trim()));
      t.expect(items.some((x) => x.startsWith('Loop this bar')), `the bar menu (${items})`);
      await t.capture('menu');
      await page.keyboard.press('Escape');
      await page.locator('.chart-bars').focus();
      await page.keyboard.press('Shift+F10');
      await page.waitForSelector('[role=menu]', {timeout: 5_000});
    },
  },
  {
    name: 'st9-chart-display', url: HARNESS(), opts: {devices: ['laptop'], themes: ['dark']},
    async fn(page, t) {
      await ready(page, t);
      const height = () => page.evaluate(() => document.querySelector('.chart-surface .chart-score').getBoundingClientRect().height);
      const h0 = await height();
      const r0 = await revision(page);
      await page.evaluate(() => window.__chartSurface.run('view.display', {layout: 'split'}));
      await page.waitForFunction((r) => Number(document.querySelector('.chart-surface .chart').dataset.rendered) > r, r0, {timeout: 10_000});
      await page.waitForTimeout(300);
      const layout = await page.evaluate(() => JSON.parse(localStorage.getItem('ws.prefs')).chart.display.layout);
      t.expect(layout === 'split', `Display is this device's (prefs chart.display.layout = ${layout})`);
      t.expect(await revision(page) === r0 + 1, 'one relayout');
      t.expect(await height() > h0 * 1.1, `Hands & feet engraves two staves (${h0} → ${await height()})`);
    },
  },
  {
    name: 'st9-chart-empty', url: HARNESS('part=none'),
    async fn(page, t) {
      await ready(page, t, {empty: true});
      const facts = await page.evaluate(() => ({
        title: document.querySelector('.chart-surface .chart-empty h2')?.textContent,
        buttons: [...document.querySelectorAll('.chart-surface .chart-empty button')].map((b) => b.textContent),
        bars: document.querySelector('.chart-bars').hidden,
      }));
      t.expect(facts.title === 'No drum chart yet', `owner copy (${facts.title})`);
      t.expect(JSON.stringify(facts.buttons) === JSON.stringify(['Find a chart', 'Import a file', 'Write one']), `actions (${facts.buttons})`);
      t.expect(facts.bars, 'no bar list without notation');
      const problems = await checkAxe(page, {include: ['.chart-surface']});
      t.expect(!problems.length, problems.join('; '));
      for (const name of ['Find a chart', 'Import a file', 'Write one']) await page.getByRole('button', {name}).click();
      const calls = await page.evaluate(() => window.__chartSurface.router.calls.filter((c) => c[0] === 'navigate').map((c) => c[1]));
      const id = await page.evaluate(() => encodeURIComponent(window.__chartSurface.ts.id));
      t.expect(JSON.stringify(calls) === JSON.stringify([`/s/${id}/edit/map/find`, `/s/${id}/edit/map/find?import=1`, `/s/${id}/edit/chart`]), `navigations (${calls})`);
    },
  },
  {
    name: 'st9-chart-shared', url: HARNESS('shared=1'),
    async fn(page, t) {
      await ready(page, t, {empty: true});
      const facts = await page.evaluate(() => ({
        title: document.querySelector('.chart-surface .chart-empty h2')?.textContent,
        buttons: document.querySelectorAll('.chart-surface .chart-empty button').length,
      }));
      t.expect(facts.title === 'No drum chart was shared.' && facts.buttons === 0, `shared copy, no actions (${JSON.stringify(facts)})`);
    },
  },
  {
    name: 'st9-chart-opening', url: HARNESS('opening=1'),
    async fn(page, t) {
      await page.waitForSelector('.chart-surface[data-state=opening]', {state: 'attached', timeout: 30_000});
      const facts = await page.evaluate(() => {
        const root = document.querySelector('.chart-surface');
        return {busy: root.getAttribute('aria-busy'), text: root.querySelector('.chart-surface-note').textContent, chart: root.querySelector('.chart').hidden};
      });
      t.expect(facts.busy === 'true' && facts.text === 'Opening the drum chart…' && facts.chart, `opening (${JSON.stringify(facts)})`);
    },
  },
  {
    name: 'st9-chart-error', url: HARNESS('error=1'), opts: {allow: [/drum part could not be (opened|reached)/i]},
    async fn(page, t) {
      await page.waitForSelector('.chart-surface[data-state=error]', {state: 'attached', timeout: 30_000});
      const text = await page.evaluate(() => document.querySelector('.chart-surface-note-text').textContent);
      t.expect(text === 'Couldn’t open the drum chart.', `the error (${text})`);
      await t.capture('error');
      await page.getByRole('button', {name: 'Try again'}).click();
      await page.waitForFunction(() => /^\d+$/.test(document.querySelector('.chart-surface .chart')?.dataset.rendered ?? ''), null, {timeout: 30_000});
      t.expect(await page.evaluate(() => document.querySelector('.chart-surface').dataset.state) === 'chart', 'Try again opens the part');
    },
  },
  {
    name: 'st9-chart-r1', url: HARNESS(), opts: {devices: ['laptop'], themes: ['light'], capture: false, timeout: 180_000},
    async fn(page, t) {
      await ready(page, t);
      const loadBefore = os.loadavg();
      const results = {};
      const RUNS = 5;
      for (const d of ['near', 'stand', 'kit']) {
        const other = d === 'stand' ? 'near' : 'stand';
        const samples = [], counts = [];
        for (let i = 0; i < RUNS + 1; i++) {
          await page.evaluate((x) => window.__chartSurface.relayout(() => window.__chartSurface.stage().setDistance(x)), other);
          const values = await page.evaluate((x) => window.__chartSurface.relayout(() => window.__chartSurface.stage().setDistance(x)), d);
          t.expect(values.length >= 1, `a Distance change to ${d} relayouts (got ${values})`);
          // data-relayout-ms is the change's running total, so the last value is the whole change (what
          // the user waits through and D54 samples); the first run is a warm-up.
          if (i > 0) {
            samples.push(values.at(-1));
            counts.push(await page.evaluate(() => Number(document.querySelector('.chart-surface').dataset.relayouts)));
          }
        }
        results[d] = {median: median(samples), runs: samples, relayouts: counts};
      }
      const loadAfter = os.loadavg();
      const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).metrics.relayout64Ms.median;
      const quiet = validity(loadBefore, loadAfter, QUIET_LOAD);
      for (const [d, r] of Object.entries(results)) {
        const ratio = Math.round(r.median / base * 1000) / 1000;
        t.log(`Distance change to ${d}: median ${r.median} ms (runs ${r.runs.join(', ')}; relayouts each ${r.relayouts.join(', ')}), ${ratio}× FX0's ${base} ms`);
        if (!quiet.provisional) t.expect(ratio <= MAX_RATIO + 1e-9, `R1: the relayout at ${d} is ${ratio}× the baseline (max ${MAX_RATIO}×)`);
      }
      if (quiet.provisional) t.log(quiet.reason);
    },
  },
  {
    name: 'st9-chart-relayouts', url: HARNESS(), opts: {devices: ['laptop'], themes: ['dark'], capture: false, timeout: 60_000},
    async fn(page, t) {
      await ready(page, t);
      const before = await revision(page);
      await page.evaluate(() => window.__chartSurface.relayout(() => window.__chartSurface.stage().setDistance('kit')));
      const distance = {engravings: await revision(page) - before,
        asked: await page.evaluate(() => Number(document.querySelector('.chart-surface').dataset.relayouts))};
      t.expect(distance.engravings === 1 && distance.asked === 1, `a Distance change is one relayout and one engraving (${JSON.stringify(distance)})`);
      const mid = await revision(page);
      const settled = page.evaluate(() => window.__chartSurface.relayout(() => {}));
      await page.setViewportSize({width: 820, height: 1180});
      await settled;
      await page.waitForFunction(() => document.querySelector('.stage')?.dataset.stageLayout === 'band', null, {timeout: 10_000});
      await page.evaluate(() => window.__chartSurface.relayout(() => {}));
      const layout = {engravings: await revision(page) - mid,
        asked: await page.evaluate(() => Number(document.querySelector('.chart-surface').dataset.relayouts))};
      t.expect(layout.engravings === 1 && layout.asked === 1, `a rail → band switch is one relayout and one engraving (${JSON.stringify(layout)})`);
      t.log(`engravings: Distance change ${distance.engravings} (surface asked ${distance.asked}); rail → band ${layout.engravings} (asked ${layout.asked}).`);
    },
  },
  {
    name: 'st9-app-chart', url: APP('/s/glasshouse'), opts: {ready: 'stage'},
    async fn(page, t) {
      await t.loadPhase('ready');
      await page.waitForFunction(() => /^\d+$/.test(document.querySelector('.chart-surface .chart')?.dataset.rendered ?? ''), null, {timeout: 30_000});
      const facts = await page.evaluate(() => ({
        surface: document.querySelector('.stage-surface')?.dataset.surface,
        status: document.querySelectorAll('.stage [role=status]').length,
        scroller: !!document.querySelector('.stage-surface [data-scroller].chart-scroll'),
      }));
      t.expect(facts.surface === 'chart' && facts.scroller, `the Stage opens on the chart surface (${JSON.stringify(facts)})`);
      t.expect(facts.status === 1, `exactly one role=status in the Stage (${facts.status})`);
    },
  },
];
