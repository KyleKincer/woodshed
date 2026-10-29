// ST3's states: the chrome-less chart (src/js/notation/chart.js) and the score
// view (score-view.js) on the chart harness (tests/harness/notation/chart.harness.js),
// in Chromium. Engraving geometry against the 1.9 baseline is FX0's
// probe-geometry.cjs, run separately and unchanged.
//   st3-chart            the desk chart: a loop, the playing bar; tokens from the desk theme
//   st3-chart-stage      the always-dark Stage: glyphs, bar numbers and staff lines from the Stage tokens
//   st3-chart-floors     bar numbers ≥ 14 px × d and section labels ≥ 20 px × d at every Distance and scale
//   st3-chart-handles    the loop handles: 44 px × system-height hit areas, a mouse drag commits a bar-snapped loop,
//                        the brackets spring to the bar line; half strength while playing
//   st3-chart-gestures   mouse click, double-click and right-click emit tap/double/context and never seek
//   st3-chart-touch      touch tap, 350 ms long-press, long-press-drag loop; glass: no touch loops
//   st3-chart-follow     page follow turns half a viewport when the playing system crosses the middle; scroll
//                        follow holds the system at the follow line; a manual wheel pauses Follow
//   st3-chart-scale      setScale relayouts once (reported), keeps the anchor bar, and the font floors follow
//   st3-chart-configure  configure({scale, fonts, barsPerRow}) is one engraving and one report (I2b-2); a width
//                        change followed within RESIZE_SETTLE_MS by a configure is one engraving too
//   st3-chart-empty      the empty state and its three actions
//   st3-chart-shared     the shared empty state
'use strict';

const H = '/__harness/chart';
const LABELS = ['Intro', 'Verse', 'Chorus', 'Outro'];

/** In the page: the engraved label sizes and colours. */
function readLabels(labels) {
  const texts = [...document.querySelectorAll('.score-engraving text')];
  const ui = texts.filter(t => !/alphaTab/.test(getComputedStyle(t).fontFamily));
  const size = t => parseFloat(getComputedStyle(t).fontSize);
  const barNumbers = ui.filter(t => /^\d+\s*$/.test(t.textContent));
  const markers = ui.filter(t => labels.includes(t.textContent.trim()));
  const glyph = texts.find(t => /alphaTab/.test(getComputedStyle(t).fontFamily));
  const host = document.querySelector('[data-rendered]');
  const token = name => getComputedStyle(host).getPropertyValue(name).trim().toLowerCase();
  // Staff lines: alphaTab's long, thin rects (or paths) in the engraving.
  const staff = [...document.querySelectorAll('.score-engraving rect')].find(r => { const b = r.getBBox(); return b.width > 100 && b.height <= 2; });
  return {
    staffFill: staff?.getAttribute('fill')?.toLowerCase(),
    barNumbers: barNumbers.map(size), markers: markers.map(size),
    barNumberFill: barNumbers[0]?.getAttribute('fill')?.toLowerCase(), glyphFill: glyph?.getAttribute('fill')?.toLowerCase(),
    ink: token('--ink'), ink2: token('--ink-2'), ink3: token('--ink-3'), family: ui[0] ? getComputedStyle(ui[0]).fontFamily : '',
  };
}

/** In the page: client coordinates of the left edge of bar `index` on the row through `y` (scanning barAtPoint). */
function barEdgeX({index, y}) {
  const chart = window.__chartHarness.chart;
  for (let x = 0; x < innerWidth; x += 2) if (chart.barAtPoint(x, y)?.index === index) return x;
  return null;
}

async function harnessReady(page, t) {
  await t.rendered();
  await page.waitForFunction(() => /^\d+$/.test(document.querySelector('[data-rendered]')?.dataset.rendered ?? ''));
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

module.exports = [
  {
    name: 'st3-chart',
    url: `${H}?at=17&loop=3-4`,
    async fn(page, t) {
      await harnessReady(page, t);
      const host = page.locator('[data-rendered]');
      t.expect(await host.getAttribute('data-rendered') === '1', 'the first engraving stamps data-rendered="1"');
      t.expect(await page.locator('.chart [role=toolbar], .chart button').count() === 0, 'the chart has no toolbar or buttons');
      t.expect(await page.getByRole('img', {name: /^Drum chart, 32 bars$/}).count() === 1, 'the engraving is one labelled image');
      const labels = await page.evaluate(readLabels, LABELS);
      t.expect(labels.glyphFill === labels.ink, `notes are drawn in --ink (${labels.glyphFill} vs ${labels.ink})`);
      t.expect(labels.barNumberFill === labels.ink2, `bar numbers are drawn in --ink-2 (${labels.barNumberFill} vs ${labels.ink2})`);
      t.expect(labels.staffFill === labels.ink3, `staff lines are drawn in --ink-3 (${labels.staffFill} vs ${labels.ink3})`);
      t.expect(/Atkinson Hyperlegible Next/.test(labels.family), `labels use --font-ui (${labels.family})`);
      const now = await page.evaluate(() => {
        const bar = document.querySelector('.score-now-bar'), line = document.querySelector('.score-playhead'), host = document.querySelector('[data-rendered]');
        const token = name => getComputedStyle(host).getPropertyValue(name).trim();
        return {barFill: getComputedStyle(bar).fill, lineStroke: getComputedStyle(line).stroke, width: getComputedStyle(line).strokeWidth, now: token('--now'), nowSoft: token('--now-soft'), gutter: getComputedStyle(document.querySelector('.chart-scroll')).scrollbarGutter};
      });
      t.expect(now.width === '3px', `the beat cursor is 3 px (${now.width})`);
      t.expect(now.gutter === 'stable', `.chart-scroll keeps a stable gutter (${now.gutter})`);
      const hex = rgb => '#' + rgb.match(/\d+/g).slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('');
      t.expect(hex(now.lineStroke) === now.now.toLowerCase() && hex(now.barFill) === now.nowSoft.toLowerCase(), `the playing bar uses --now-soft and the cursor --now (${now.barFill}, ${now.lineStroke})`);
      const edges = await page.locator('.score-loop-edge').evaluateAll(els => els.map(el => getComputedStyle(el).display));
      t.expect(edges.length === 2 && edges.every(d => d !== 'none'), 'the loop shows both edges');
    },
  },
  {
    name: 'st3-chart-stage',
    url: `${H}?place=stage&at=17&loop=3-4`,
    async fn(page, t) {
      await harnessReady(page, t);
      const labels = await page.evaluate(readLabels, LABELS);
      t.expect(labels.ink === '#ffffff', `the harness is on the Stage tokens (--ink ${labels.ink})`);
      t.expect(labels.glyphFill === '#ffffff', `notes are drawn in the Stage --ink, not the desk theme (${labels.glyphFill})`);
      t.expect(labels.barNumberFill === labels.ink2, `bar numbers in the Stage --ink-2 (${labels.barNumberFill})`);
      t.expect(labels.staffFill === labels.ink3, `staff lines in the Stage --ink-3 (${labels.staffFill})`);
      // A desk theme event changes nothing on the Stage: no re-engraving.
      const before = await page.locator('[data-rendered]').getAttribute('data-rendered');
      await page.evaluate(() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; window.dispatchEvent(new Event('woodshed:theme')); });
      await page.waitForTimeout(300);
      t.expect(await page.locator('[data-rendered]').getAttribute('data-rendered') === before, 'the always-dark Stage ignores app-theme changes');
    },
  },
  {
    name: 'st3-chart-floors',
    url: `${H}?distance=near`,
    opts: {themes: ['dark'], capture: false},
    async fn(page, t) {
      for (const [distance, d] of [['near', 0.8], ['stand', 1], ['kit', 1.3]]) {
        for (const scale of [null, 0.8, 1.2, 2]) {
          await page.goto(`${t.base}${H}?distance=${distance}${scale ? `&scale=${scale}` : ''}${t.device === 'ipad' ? '&fx-platform=ipad' : ''}`);
          await page.waitForSelector('html[data-view-ready=chart]');
          await harnessReady(page, t);
          const labels = await page.evaluate(readLabels, LABELS);
          const what = `${distance} at ${scale ?? 'its default scale'}`;
          t.expect(labels.barNumbers.length >= 2 && labels.markers.length >= 1, `${what}: bar numbers and section labels are engraved`);
          t.expect(Math.min(...labels.barNumbers) >= 14 * d - 0.01, `${what}: bar numbers ≥ ${14 * d} px (smallest ${Math.min(...labels.barNumbers)})`);
          t.expect(Math.min(...labels.markers) >= 20 * d - 0.01, `${what}: section labels ≥ ${20 * d} px (smallest ${Math.min(...labels.markers)})`);
        }
      }
    },
  },
  {
    name: 'st3-chart-handles',
    url: `${H}?loop=3-4`,
    opts: {devices: ['laptop']},
    async fn(page, t) {
      await harnessReady(page, t);
      const start = page.locator('.score-loop-edge[data-loop-edge=start] .score-loop-hit');
      const box = await start.boundingBox();
      const system = await page.evaluate(() => {
        const edge = document.querySelector('.score-loop-edge[data-loop-edge=start] .score-loop-hit').getBoundingClientRect();
        return {height: edge.height};
      });
      t.expect(box.width >= 44 - 0.5, `the handle hit area is 44 px wide (${box.width})`);
      t.expect(system.height >= 100, `the handle hit area is the system's height (${system.height})`);
      const y = box.y + box.height / 2;
      const bar2 = await page.evaluate(barEdgeX, {index: 1, y});
      t.expect(bar2 != null, 'bar 2 is on the first system');
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(bar2 + 30, y, {steps: 6});
      const dragging = await page.locator('.score-handles').evaluate(el => el.classList.contains('is-dragging'));
      t.expect(dragging, 'the brackets follow the pointer while dragging');
      await page.mouse.up();
      const log = await page.evaluate(() => window.__chartHarness.log);
      const commit = log.edits.at(-1);
      t.expect(commit?.phase === 'commit' && commit.a === 2 && commit.b === 8 && commit.aBar && commit.bBar, `a handle drag commits bars 2–4 (${JSON.stringify(commit)})`);
      t.expect(log.events.length === 0, 'a handle drag emits no tap');
      await page.waitForTimeout(300);   // --motion-fast spring
      const after = await start.boundingBox();
      // barEdgeX finds the line within locate()'s 2 px edge tolerance and its 2 px scan step.
      t.expect(Math.abs(after.x + after.width / 2 - bar2) <= 5, `the start bracket springs to the bar line, not the pointer (${after.x + after.width / 2} vs ${bar2}; the pointer was at ${bar2 + 30})`);
      await t.capture('dragged');
      await page.evaluate(() => window.__chartHarness.chart.setGlass(true));
      const opacity = await page.locator('.score-handles').evaluate(el => getComputedStyle(el).opacity);
      t.expect(opacity === '0.5', `handles are at half strength while playing (${opacity})`);
      const b = await start.boundingBox();
      await page.mouse.move(b.x + b.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 + 220, y, {steps: 6});
      await page.mouse.up();
      const playing = await page.evaluate(() => window.__chartHarness.log.edits.at(-1));
      t.expect(playing.phase === 'commit' && playing.a > 2, 'the mouse still moves handles while playing');
    },
  },
  {
    name: 'st3-chart-gestures',
    url: `${H}?at=0`,
    opts: {devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      await harnessReady(page, t);
      const engraving = await page.locator('.score-engraving').boundingBox();
      const y = engraving.y + 90;
      const x = await page.evaluate(barEdgeX, {index: 2, y});
      await page.mouse.click(x + 40, y);
      let log = await page.evaluate(() => window.__chartHarness.log);
      t.expect(log.events.at(-1)?.kind === 'tap' && log.events.at(-1).pointerType === 'mouse' && log.events.at(-1).index === 2, `a click emits a mouse tap on bar 3 (${JSON.stringify(log.events.at(-1))})`);
      await page.waitForTimeout(400);
      await page.mouse.dblclick(x + 40, y);
      log = await page.evaluate(() => window.__chartHarness.log);
      t.expect(log.events.filter(e => e.kind === 'double').length === 1, `a double-click emits one double (${log.events.map(e => e.kind)})`);
      await page.mouse.click(x + 40, y, {button: 'right'});
      log = await page.evaluate(() => window.__chartHarness.log);
      t.expect(log.events.at(-1)?.kind === 'context' && log.events.at(-1).index === 2, 'a right-click emits context');
      await page.mouse.move(x + 20, y);
      await page.mouse.down();
      await page.mouse.move(x + 500, y, {steps: 8});
      await page.mouse.up();
      log = await page.evaluate(() => window.__chartHarness.log);
      t.expect(log.edits.at(-1)?.phase === 'commit' && log.edits.at(-1).a === 4, `a mouse drag loops from bar 3 (${JSON.stringify(log.edits.at(-1))})`);
    },
  },
  {
    name: 'st3-chart-touch',
    url: `${H}?at=0`,
    opts: {devices: ['ipad'], themes: ['light'], capture: false},
    async fn(page, t) {
      await harnessReady(page, t);
      const touch = await t.touch();
      const engraving = await page.locator('.score-engraving').boundingBox();
      const y = engraving.y + 90;
      const x2 = await page.evaluate(barEdgeX, {index: 1, y});
      await touch.tap({x: x2 + 40, y});
      let log = await page.evaluate(() => window.__chartHarness.log);
      t.expect(log.events.at(-1)?.kind === 'tap' && log.events.at(-1).pointerType === 'touch', `a touch tap emits tap with pointerType touch (${JSON.stringify(log.events.at(-1))})`);
      await page.waitForTimeout(400);
      await touch.longPress({x: x2 + 40, y}, {ms: 500});
      log = await page.evaluate(() => window.__chartHarness.log);
      t.expect(log.events.at(-1)?.kind === 'long', `a 350 ms long-press emits long (${log.events.map(e => e.kind)})`);
      t.expect(log.statuses.includes('Drag across bars to loop them'), 'the long-press arms a loop drag with a hint');
      const x0 = await page.evaluate(barEdgeX, {index: 0, y});
      await touch.drag({x: x0 + 30, y}, {x: x2 + 120, y}, {holdMs: 450, steps: 10});
      log = await page.evaluate(() => window.__chartHarness.log);
      t.expect(log.edits.at(-1)?.phase === 'commit' && log.edits.at(-1).a === 0 && log.edits.at(-1).b === 4, `long-press then drag loops bars 1–2 (${JSON.stringify(log.edits.at(-1))})`);
      const edits = log.edits.length;
      await page.evaluate(() => window.__chartHarness.chart.setGlass(true));
      await touch.drag({x: x0 + 30, y}, {x: x2 + 120, y}, {holdMs: 450, steps: 10});
      log = await page.evaluate(() => window.__chartHarness.log);
      t.expect(log.edits.length === edits, 'while playing, touch never draws a loop');
      await touch.tap({x: x2 + 40, y});
      log = await page.evaluate(() => window.__chartHarness.log);
      t.expect(log.events.at(-1)?.kind === 'tap' && log.events.at(-1).glass === true, 'a touch tap while playing is flagged glass');
    },
  },
  {
    name: 'st3-chart-follow',
    url: `${H}?follow=page&seconds=160&anchor=0.28`,
    opts: {devices: ['laptop'], themes: ['dark'], capture: false},
    async fn(page, t) {
      await harnessReady(page, t);
      const turn = await page.evaluate(async () => {
        const harness = window.__chartHarness, scroller = document.querySelector('.chart-scroll');
        const frame = () => new Promise(r => requestAnimationFrame(r));
        for (let bar = 0; bar < 80; bar++) {
          const before = scroller.scrollTop;
          harness.set(harness.barTime(bar));
          await frame(); await frame();
          if (scroller.scrollTop !== before) {
            const started = performance.now();
            while (performance.now() - started < 600) await frame();
            return {bar, before, after: scroller.scrollTop, half: scroller.clientHeight / 2};
          }
        }
        return null;
      });
      t.expect(turn && Math.abs(turn.after - turn.before - turn.half) <= 1, `page follow turns half a viewport (${JSON.stringify(turn)})`);
      await page.evaluate(() => window.__chartHarness.chart.setFollowStyle('scroll', {anchor: 0.33}));
      await page.waitForTimeout(800);
      const held = await page.evaluate(() => {
        const harness = window.__chartHarness, scroller = document.querySelector('.chart-scroll');
        const now = document.querySelector('.score-now-bar').getBoundingClientRect(), box = scroller.getBoundingClientRect();
        return {fraction: (now.top - box.top) / scroller.clientHeight, follows: harness.log.follows.slice()};
      });
      t.expect(held.fraction > 0.2 && held.fraction < 0.45, `scroll follow holds the playing system near the 33 % line (${held.fraction})`);
      await page.waitForTimeout(1000);
      const box = await page.locator('.chart-scroll').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(200);
      const follows = await page.evaluate(() => window.__chartHarness.log.follows);
      t.expect(follows.at(-1) === false, `a manual wheel pauses Follow while stopped (${follows})`);
    },
  },
  {
    name: 'st3-chart-scale',
    url: `${H}?at=40`,
    opts: {devices: ['laptop'], themes: ['dark'], capture: false},
    async fn(page, t) {
      await harnessReady(page, t);
      const result = await page.evaluate(async () => {
        const {chart, log} = window.__chartHarness, host = document.querySelector('[data-rendered]'), scroller = document.querySelector('.chart-scroll');
        const nowTop = () => document.querySelector('.score-now-bar').getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        const anchor = chart.anchorBar(), before = nowTop(), revision = host.dataset.rendered, relayouts = log.relayouts.length;
        chart.setScale(1.6);
        const started = performance.now();
        while (host.dataset.rendered === revision && performance.now() - started < 10000) await new Promise(r => requestAnimationFrame(r));
        // alphaTab sizes its surface a few frames after the render; the chart restores the anchor then.
        for (let i = 0; i < 20; i++) await new Promise(r => requestAnimationFrame(r));
        return {anchor, after: chart.anchorBar(), before, top: nowTop(), reported: log.relayouts.slice(relayouts), revisions: [revision, host.dataset.rendered]};
      });
      t.expect(result.reported.length === 1 && result.reported[0].ms > 0 && result.reported[0].bars === 32, `one relayout is reported with its time (${JSON.stringify(result.reported)})`);
      t.expect(result.anchor === 20, `the playing bar (21) is the anchor (${result.anchor})`);
      t.expect(result.after === result.anchor, `the anchor bar stays at the follow line (${result.anchor} → ${result.after})`);
      // The system top keeps its fraction; the playing-bar band sits a scaled label height below it.
      t.expect(Math.abs(result.top - result.before) < 40, `the anchor bar keeps its screen position (${result.before} → ${result.top})`);
      const labels = await page.evaluate(readLabels, LABELS);
      t.expect(Math.min(...labels.barNumbers) >= 14 && Math.min(...labels.markers) >= 20, `the floors hold at 160 % (${Math.min(...labels.barNumbers)}, ${Math.min(...labels.markers)})`);
    },
  },
  {
    name: 'st3-chart-configure',
    url: `${H}?at=40`,
    opts: {devices: ['laptop'], themes: ['dark'], capture: false},
    async fn(page, t) {
      await harnessReady(page, t);
      const result = await page.evaluate(async () => {
        const {chart, log} = window.__chartHarness, host = document.querySelector('[data-rendered]');
        const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const revision = () => Number(host.dataset.rendered);
        // A Distance change to Kit on a dense part, as the surface asks for it: one call.
        let start = revision(), reported = log.relayouts.length;
        const started = chart.configure({scale: 1.6, fonts: {barNumber: 14 * 1.3, marker: 20 * 1.3}, barsPerRow: 2});
        await wait(600);
        await frames(10);
        const distance = {started, engravings: revision() - start, reported: log.relayouts.length - reported, state: chart.state};
        // The rail → band switch: the music column narrows, then the layout's sizes arrive 150 ms later.
        start = revision(); reported = log.relayouts.length;
        host.style.width = '760px';
        await wait(150);
        chart.configure({scale: 1.2, fonts: {barNumber: 14, marker: 20}, barsPerRow: 4});
        await wait(600);
        await frames(10);
        const layout = {engravings: revision() - start, reported: log.relayouts.length - reported, width: document.querySelector('.score-engraving svg')?.getBoundingClientRect().width ?? 0};
        // A width change on its own still re-engraves, once, after it settles.
        start = revision();
        host.style.width = '640px';
        await frames(2);
        host.style.width = '620px';
        await wait(700);
        await frames(10);
        const alone = {engravings: revision() - start, width: document.querySelector('.score-engraving svg')?.getBoundingClientRect().width ?? 0};
        return {distance, layout, alone};
      });
      const {distance, layout, alone} = result;
      t.expect(distance.started === true && distance.engravings === 1 && distance.reported === 1,
        `configure is one engraving and one onRelayout report (${JSON.stringify({...distance, state: undefined})})`);
      t.expect(distance.state.scale === 1.6 && distance.state.barsPerRow === 2, `configure took the scale and bars per system (${distance.state.scale}, ${distance.state.barsPerRow})`);
      t.expect(layout.engravings === 1 && layout.reported === 1, `a width change and a configure 150 ms later engrave once (${JSON.stringify(layout)})`);
      t.expect(layout.width > 0 && layout.width <= 762, `that engraving is at the new width (${layout.width})`);
      t.expect(alone.engravings === 1 && alone.width > 0 && alone.width <= 622, `a width change alone re-engraves once, at the settled width (${JSON.stringify(alone)})`);
      const labels = await page.evaluate(readLabels, LABELS);
      t.expect(Math.min(...labels.barNumbers) >= 14 && Math.min(...labels.markers) >= 20, `the floors hold (${Math.min(...labels.barNumbers)}, ${Math.min(...labels.markers)})`);
    },
  },
  {
    name: 'st3-chart-empty',
    url: `${H}?empty=1`,
    async fn(page, t) {
      await page.waitForSelector('[data-rendered=empty]');
      t.expect(await page.getByRole('heading', {name: 'No drum chart yet'}).count() === 1, 'the empty heading');
      const group = page.getByRole('group', {name: 'No drum chart yet'});
      for (const [name, action] of [['Find a chart', 'findChart'], ['Import a file', 'importFile'], ['Write one', 'write']]) {
        await group.getByRole('button', {name}).click();
        const actions = await page.evaluate(() => window.__chartHarness.log.actions);
        t.expect(actions.at(-1) === action, `${name} calls onEmpty.${action}`);
      }
    },
  },
  {
    name: 'st3-chart-shared',
    url: `${H}?shared=1`,
    opts: {themes: ['dark']},
    async fn(page, t) {
      await page.waitForSelector('[data-rendered=empty]');
      t.expect(await page.getByRole('heading', {name: 'No drum chart was shared.'}).count() === 1, 'the shared empty heading');
      t.expect(await page.locator('.chart button').count() === 0, 'a shared song offers no edits');
    },
  },
];
