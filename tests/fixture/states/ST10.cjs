// ST10's states: the Road map and the Wave page (architecture §9.12 ST10, spec §4.4B/C) inside the
// real Stage frame on /__harness/roadmap (tests/harness/stage/roadmap.harness.js: a real song session
// over the fixture's synthetic stems, the app registry and dispatcher). Every state runs with
// fx-audio=manual. The frame, HUD, controls and strip (wave 2a) are merged, so no state needs
// opts.requires; menus and sheets of wave 2b peers are not opened here.
//   st10-roadmap-rail          the rail: 8 bars a row, section headings 20/700 + "bars 9–16" 14 --ink-3,
//                              88 px cells with the 14 px bar number and the stacked envelopes drawn,
//                              the current bar's 3 px --now outline over a --now-soft cell, the loop's
//                              --loop-fill band with 44 px handles and 20 px grip dots, a spot flag above
//                              its start bar, a marker tick, the grid's roles (axe)
//   st10-roadmap-band          the band (iPad): 4 bars a row; a tempo chip "♩=100" and a meter chip
//                              "7/8 (2+2+3)" on their changes; the drums out (Minus me)
//   st10-roadmap-kit           Distance Kit: 114 px cells, 26 px headings
//   st10-roadmap-shimmer       before the peaks exist: shimmering cells, no data-peaks-ready
//   st10-roadmap-follow        playing: the current row held 30% down; a wheel scroll pauses Follow and
//                              shows "Back to playhead" (56 px, bottom centre); pressing it resumes
//   st10-roadmap-mouse-loop    a mouse drag across bars 10–13 loops them (bar-snapped)
//   st10-roadmap-touch         iPad: a long-press-drag loops bars 3–6 while stopped; playing, a tap shows
//                              the glass pill and never seeks
//   st10-roadmap-keyboard      the stage.bars grid: Tab-able cell, arrows rove, L loops, Enter plays; the focus ring
//   st10-wave-rail             the Wave page: 10 s rows, labels every 5 s, marker and spot flags; no "Bar"
//   st10-wave-band             iPad: 8 s rows; a pinch makes the rows shorter
//   st10-wave-zoom             = and − change the row length (8 s, then 12 s)
//   st10-wave-becomes-roadmap  the song gains a bar grid while open: the surface turns into the Road map
'use strict';

const {checkAxe} = require('../probes/probe-axe.cjs');

const RM = (query = '') => `/__harness/roadmap?place=stage&fx-audio=manual${query ? `&${query}` : ''}`;
const LAPTOP = {devices: ['laptop']};
const IPAD = {devices: ['ipad']};

async function ready(page, t, {peaks = true} = {}) {
  await t.loadPhase('ready');
  if (peaks) await page.waitForSelector('.roadmap[data-peaks-ready="true"]', {state: 'attached', timeout: 30_000});
  await page.evaluate(() => document.fonts.ready);
  // The Stage reveals the cue on the next frame after the surface opens.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const snap = (page) => page.evaluate(() => {
  const s = window.__roadmap.session.transport.snapshot.peek();
  return {phase: s.phase, cue: s.cue, loop: s.loop, position: window.__roadmap.session.transport.position()};
});

const tokenColour = (page, name) => page.evaluate((token) => {
  const probe = document.createElement('div');
  probe.style.color = `var(${token})`;
  document.querySelector('.roadmap').append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}, name);

const tokenBackground = (page, name) => page.evaluate((token) => {
  const probe = document.createElement('div');
  probe.style.background = `var(${token})`;
  document.querySelector('.roadmap').append(probe);
  const value = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return value;
}, name);

/** The client box of bar index i's cell (a rendered row). */
const cellBox = (page, i) => page.$eval(`.roadmap-cell[data-bar="${i}"]`, (el) => {
  const r = el.getBoundingClientRect();
  return {x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2};
});

/** Whether a canvas holds drawn (non-transparent) pixels. */
const drawnPixels = (page, selector) => page.$eval(selector, (canvas) => {
  const ctx = canvas.getContext('2d');
  const {data} = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
  return n;
});

module.exports = [
  {
    name: 'st10-roadmap-rail', url: RM('scenario=looping'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t);
      const facts = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.roadmap-row')];
        const verse = rows.find((r) => r.querySelector('.roadmap-heading-name')?.textContent === 'Verse');
        const cells = [...verse.querySelectorAll('.roadmap-cell')].map((c) => c.getBoundingClientRect());
        const name = getComputedStyle(verse.querySelector('.roadmap-heading-name'));
        const range = verse.querySelector('.roadmap-heading-range');
        const number = getComputedStyle(verse.querySelector('.roadmap-cell-number'));
        return {
          cells: cells.map((r) => ({w: Math.round(r.width), h: Math.round(r.height)})),
          heading: {size: name.fontSize, weight: name.fontWeight, range: range.textContent, rangeSize: getComputedStyle(range).fontSize, rangeColour: getComputedStyle(range).color},
          number: number.fontSize,
          grid: {role: document.querySelector('.roadmap-grid').getAttribute('role'), label: document.querySelector('.roadmap-grid').getAttribute('aria-label'), scope: document.querySelector('.roadmap-grid').dataset.scope},
        };
      });
      t.expect(facts.cells.length === 8 && facts.cells.every((c) => c.h === 88), `8 cells of 88 px a row (got ${JSON.stringify(facts.cells)})`);
      t.expect(facts.heading.size === '20px' && facts.heading.weight === '700', `headings 20/700 (got ${JSON.stringify(facts.heading)})`);
      t.expect(facts.heading.range === 'bars 9–16' && facts.heading.rangeSize === '14px' && facts.heading.rangeColour === await tokenColour(page, '--ink-3'),
        `"bars 9–16" at 14 px in --ink-3 (got ${JSON.stringify(facts.heading)})`);
      t.expect(facts.number === '14px', `bar numbers 14 px (got ${facts.number})`);
      t.expect(facts.grid.role === 'grid' && facts.grid.label === 'Bars' && facts.grid.scope === 'stage.bars', `the bars grid (got ${JSON.stringify(facts.grid)})`);
      // The envelopes are drawn (synthetic stems) in every rendered row's canvas.
      const pixels = await drawnPixels(page, '.roadmap-row .roadmap-canvas[data-peaks-ready]');
      t.expect(pixels > 1000, `the stacked envelopes are drawn (${pixels} px)`);
      // The current bar: bar 17 at the cue (32 s).
      const now = await page.$eval('.roadmap-now', (el) => {
        const cs = getComputedStyle(el), r = el.getBoundingClientRect();
        return {w: cs.borderTopWidth, colour: cs.borderTopColor, x: r.x, width: r.width, hidden: el.hidden};
      });
      const bar17 = await cellBox(page, 16);
      t.expect(!now.hidden && now.w === '3px' && now.colour === await tokenColour(page, '--now'), `a 3 px --now outline (got ${JSON.stringify(now)})`);
      t.expect(Math.abs(now.x - bar17.x) < 1 && Math.abs(now.width - bar17.w) < 1, `over bar 17 (got ${JSON.stringify(now)} vs ${JSON.stringify(bar17)})`);
      const nowFill = await page.$eval('.roadmap-cell[data-bar="16"]', (el) => getComputedStyle(el).backgroundColor);
      t.expect(nowFill === await tokenBackground(page, '--now-soft'), `the current cell is --now-soft (got ${nowFill})`);
      // The loop (the Chorus, bars 17–24): a --loop-fill band and two handles.
      const loop = await page.evaluate(() => {
        const band = [...document.querySelectorAll('.loop-band')].find((b) => !b.hidden);
        const handles = [...document.querySelectorAll('.loop-handle')].filter((x) => !x.hidden).map((x) => {
          const r = x.getBoundingClientRect(), grip = x.querySelector('.loop-handle-grip').getBoundingClientRect(), edge = x.querySelector('.loop-handle-edge');
          return {w: Math.round(r.width), grip: Math.round(grip.width), edge: getComputedStyle(edge).width, edgeColour: getComputedStyle(edge).backgroundColor};
        });
        return {fill: band && getComputedStyle(band).backgroundColor, handles};
      });
      t.expect(loop.fill === await tokenBackground(page, '--loop-fill'), `the loop band is --loop-fill (got ${loop.fill})`);
      t.expect(loop.handles.length === 2 && loop.handles.every((h) => h.w === 44 && h.grip === 20 && h.edge === '3px'), `two 44 px handles with 20 px grips and 3 px edges (got ${JSON.stringify(loop.handles)})`);
      t.expect(loop.handles[0].edgeColour === await tokenBackground(page, '--loop'), `edges in --loop (got ${loop.handles[0].edgeColour})`);
      // The spot "Fill into the chorus" (28 s, bar 15) flies its flag above bar 15.
      const flag = await page.$eval('.roadmap-flag[data-flag=spot]', (el) => {
        const r = el.getBoundingClientRect();
        return {text: el.textContent, x: r.x, bottom: r.bottom};
      });
      const bar15 = await cellBox(page, 14);
      t.expect(flag.text === '◆ Fill into the chorus' && Math.abs(flag.x - bar15.x) < 1 && flag.bottom <= bar15.y + 0.5, `the spot flag above bar 15 (got ${JSON.stringify(flag)} vs ${JSON.stringify(bar15)})`);
      const tick = await page.$eval('.roadmap-marker', (el) => el.dataset.id);
      t.expect(tick === 'marker-flam', `the marker tick (got ${tick})`);
      const problems = await checkAxe(page, {include: ['.roadmap-grid']});
      t.expect(!problems.length, problems.join('; '));
    },
  },
  {
    name: 'st10-roadmap-band', url: RM('song=meter&scenario=minus&cue=82'), opts: IPAD,
    async fn(page, t) {
      await ready(page, t);
      const perRow = await page.$eval('.roadmap-row', (row) => row.querySelectorAll('.roadmap-cell').length);
      t.expect(perRow === 4, `4 bars a row on the band (got ${perRow})`);
      const chips = await page.$$eval('.roadmap-chip', (els) => els.map((el) => el.textContent));
      t.expect(chips.includes('7/8 (2+2+3)'), `the meter chip on the 7/8 Bridge (got ${chips})`);
      // Bar 33's row is two rows above the playing one: rendered (the overscan), just above the view.
      const tempo = await page.$$eval('.roadmap-cell[data-bar="32"] .roadmap-chip', (els) => els.map((el) => el.textContent));
      t.expect(JSON.stringify(tempo) === '["♩=100"]', `the tempo chip on bar 33 (got ${tempo})`);
      const label = await page.$eval('.roadmap-cell[data-bar="32"]', (el) => el.getAttribute('aria-label'));
      t.expect(label === 'Bar 33, Chorus 2, 100 bpm', `the tempo change named (got ${label})`);
      const muted = await page.evaluate(() => window.__roadmap.session.transport.snapshot.peek().mix.tracks.find((x) => x.name === 'drums').muted);
      t.expect(muted === true, 'the drums are out (Minus me): drawn as an outline with the hatch');
    },
  },
  {
    name: 'st10-roadmap-kit', url: RM('distance=kit'), opts: {devices: ['laptop'], themes: ['dark']},
    async fn(page, t) {
      await ready(page, t);
      const facts = await page.evaluate(() => ({
        h: Math.round(document.querySelector('.roadmap-cell').getBoundingClientRect().height),
        heading: getComputedStyle(document.querySelector('.roadmap-heading-name')).fontSize,
      }));
      t.expect(facts.h === 114 && facts.heading === '26px', `Kit: 114 px cells, 26 px headings (got ${JSON.stringify(facts)})`);
    },
  },
  {
    name: 'st10-roadmap-shimmer', url: RM('peaks=0'), opts: {devices: ['laptop'], themes: ['dark'], ready: 'roadmap'},
    async fn(page, t) {
      await page.waitForSelector('.roadmap[data-shimmer]', {state: 'attached', timeout: 30_000});
      const facts = await page.evaluate(() => ({
        peaks: document.querySelector('.roadmap').hasAttribute('data-peaks-ready'),
        animation: getComputedStyle(document.querySelector('.roadmap-cell')).animationName,
        cells: document.querySelectorAll('.roadmap-cell').length,
        numbers: document.querySelectorAll('.roadmap-cell-number').length,
        phase: document.documentElement.dataset.loadPhase,
      }));
      t.expect(!facts.peaks && facts.animation === 'roadmap-shimmer', `shimmering cells before the peaks (got ${JSON.stringify(facts)})`);
      t.expect(facts.cells > 8 && facts.numbers === facts.cells, `the bar grid is there already (got ${JSON.stringify(facts)})`);
      t.expect(facts.phase !== 'ready', `the audio is still loading (got ${facts.phase})`);
    },
  },
  {
    name: 'st10-roadmap-follow', url: RM(), opts: {devices: ['laptop'], themes: ['dark'], reducedMotion: 'reduce'},
    async fn(page, t) {
      await ready(page, t);
      await page.evaluate(() => window.__roadmap.session.transport.cue(40));
      await page.keyboard.press('Space');
      await t.transportPhase('playing');
      await t.advance(9000);
      const rowTop = () => page.evaluate(() => {
        const scroller = document.querySelector('.roadmap');
        const now = document.querySelector('.roadmap-now').getBoundingClientRect();
        const row = document.querySelector('.roadmap-cell[data-now]').closest('.roadmap-row').getBoundingClientRect();
        const s = scroller.getBoundingClientRect();
        return {row: (row.top - s.top) / scroller.clientHeight, inView: now.top >= s.top && now.bottom <= s.bottom};
      });
      let pos = await rowTop();
      t.expect(pos.inView && Math.abs(pos.row - 0.3) < 0.04, `the playing row is held 30% down (got ${JSON.stringify(pos)})`);
      // A manual scroll pauses Follow and shows "Back to playhead".
      await page.mouse.move(500, 400);
      await page.mouse.wheel(0, -600);
      await page.waitForSelector('.roadmap[data-follow-paused]', {state: 'attached', timeout: 3000});
      const pill = await page.getByRole('button', {name: /Back to playhead/}).boundingBox();
      const music = await page.$eval('.stage-music', (el) => { const r = el.getBoundingClientRect(); return {x: r.x, w: r.width, bottom: r.bottom}; });
      t.expect(pill && pill.height >= 56 && Math.abs(pill.x + pill.width / 2 - (music.x + music.w / 2)) < 2 && pill.y + pill.height <= music.bottom, `a 56 px pill at the bottom centre (got ${JSON.stringify(pill)})`);
      await t.capture('paused');
      await t.advance(2000);
      await page.getByRole('button', {name: /Back to playhead/}).click();
      await page.waitForFunction(() => !document.querySelector('.roadmap').hasAttribute('data-follow-paused'), null, {timeout: 3000});
      await t.advance(500);
      pos = await rowTop();
      t.expect(pos.inView && Math.abs(pos.row - 0.3) < 0.04, `Follow resumed at 30% (got ${JSON.stringify(pos)})`);
      await page.keyboard.press('Space');
    },
  },
  {
    name: 'st10-roadmap-mouse-loop', url: RM(), opts: {devices: ['laptop']},
    async fn(page, t) {
      await ready(page, t);
      const a = await cellBox(page, 9), b = await cellBox(page, 12);
      await page.mouse.move(a.cx, a.cy);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(a.cx + (b.cx - a.cx) * i / 10, a.cy + (b.cy - a.cy) * i / 10);
      await page.mouse.up();
      const s = await snap(page);
      t.expect(s.loop.on && s.loop.a === 18 && s.loop.b === 26, `bars 10–13 loop, bar-snapped (got ${JSON.stringify(s.loop)})`);
      t.expect(s.loop.label === 'Bars 10–13', `the loop's name (got ${s.loop.label})`);
      await page.waitForTimeout(200);
      const band = await page.evaluate(() => [...document.querySelectorAll('.loop-band')].filter((x) => !x.hidden).map((x) => Math.round(x.getBoundingClientRect().width)));
      t.expect(band.length === 1 && band[0] > 3 * 100, `one band across four cells (got ${band})`);
    },
  },
  {
    // The glass pill is an overlay at the touch point (spec §4.9): it covers the bar it offers.
    name: 'st10-roadmap-touch', url: RM(), opts: {...IPAD, structure: {ignore: ['.stage-pill']}},
    async fn(page, t) {
      await ready(page, t);
      const touch = await t.touch();
      const a = await cellBox(page, 2), b = await cellBox(page, 5);
      await touch.drag({x: a.cx, y: a.cy}, {x: b.cx, y: b.cy}, {holdMs: 450, steps: 12});
      let s = await snap(page);
      t.expect(s.loop.on && s.loop.a === 4 && s.loop.b === 12, `a long-press-drag loops bars 3–6 (got ${JSON.stringify(s.loop)})`);
      await page.evaluate(() => window.__roadmap.session.transport.clearLoop());
      await page.evaluate(() => window.__roadmap.session.transport.play());
      await t.transportPhase('playing');
      await t.advance(500);
      const before = await snap(page);
      const c = await cellBox(page, 6);
      await touch.tap({x: c.cx, y: c.cy});
      await page.waitForSelector('.stage-pill', {timeout: 3000});
      const pill = await page.$eval('.stage-pill', (el) => el.textContent.trim());
      t.expect(/Play from bar 7$/.test(pill), `the glass pill (got ${pill})`);
      s = await snap(page);
      t.expect(s.cue === before.cue && s.position >= before.position && s.position < before.position + 1, `a touch while playing never seeks (got ${JSON.stringify(s)} after ${JSON.stringify(before)})`);
      await t.capture('pill');
      await page.evaluate(() => window.__roadmap.session.transport.stop());
    },
  },
  {
    name: 'st10-roadmap-keyboard', url: RM(), opts: {devices: ['laptop']},
    async fn(page, t) {
      await ready(page, t);
      const tabbable = await page.$$eval('.roadmap-grid [tabindex="0"]', (els) => els.map((el) => el.dataset.bar));
      t.expect(JSON.stringify(tabbable) === '["0"]', `one tabbable cell, the bar at the cue (got ${tabbable})`);
      await page.keyboard.press('Shift');
      await page.focus('.roadmap-cell[data-bar="0"]');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowDown');
      const focused = await page.evaluate(() => ({bar: document.activeElement.dataset.bar, name: document.activeElement.getAttribute('aria-label'),
        outline: getComputedStyle(document.activeElement).outlineWidth, ring: getComputedStyle(document.activeElement).outlineColor}));
      t.expect(focused.bar === '10' && focused.name === 'Bar 11', `arrows rove to bar 11 (got ${JSON.stringify(focused)})`);
      t.expect(focused.outline === '3px' && focused.ring === await tokenColour(page, '--focus-ring'), `the focus ring (got ${JSON.stringify(focused)})`);
      await page.keyboard.press('KeyL');
      let s = await snap(page);
      t.expect(s.loop.on && s.loop.a === 20 && s.loop.b === 22, `L loops the focused bar (got ${JSON.stringify(s.loop)})`);
      await page.evaluate(() => window.__roadmap.session.transport.clearLoop());
      await page.keyboard.press('Enter');
      await t.transportPhase('playing');
      s = await snap(page);
      t.expect(s.position >= 20 && s.position < 21, `Enter plays from the focused bar (got ${JSON.stringify(s)})`);
      await page.keyboard.press('Space');
    },
  },
  {
    name: 'st10-wave-rail', url: RM('mapped=0&scenario=markers'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t);
      const facts = await page.evaluate(() => {
        const root = document.querySelector('.roadmap');
        const cells = [...root.querySelectorAll('.roadmap-wavecell')].map((c) => c.getAttribute('aria-label'));
        const strings = [root.textContent, ...[...root.querySelectorAll('*')].flatMap((el) => ['aria-label', 'title'].map((a) => el.getAttribute(a)).filter(Boolean))];
        return {kind: root.dataset.kind, grid: root.querySelector('[role=grid]').getAttribute('aria-label'), cells, flags: [...root.querySelectorAll('.roadmap-flag')].map((f) => f.textContent),
          labels: [...root.querySelectorAll('.roadmap-row')].slice(0, 3).map((r) => [...r.querySelectorAll('.roadmap-time')].map((x) => x.textContent)),
          bar: strings.filter((s) => /Bar|bar /.test(s)), numbers: root.querySelectorAll('.roadmap-cell-number').length};
      });
      t.expect(facts.kind === 'wave' && facts.grid === 'Song timeline', `the Wave page (got ${JSON.stringify(facts)})`);
      t.expect(facts.cells.includes('0:10 to 0:20') && facts.cells.includes('0:20 to 0:30'), `10 s rows (got ${facts.cells})`);
      t.expect(facts.labels.some((l) => JSON.stringify(l) === '["0:10","0:15"]'), `labels every 5 s (got ${JSON.stringify(facts.labels)})`);
      t.expect(facts.flags.includes('⚑ Groove') && facts.flags.includes('◆ The run'), `marker and spot flags (got ${facts.flags})`);
      t.expect(!facts.bar.length && !facts.numbers, `no "Bar" and no bar numbers when unmapped (got ${facts.bar})`);
      const pixels = await drawnPixels(page, '.roadmap-row .roadmap-canvas[data-peaks-ready]');
      t.expect(pixels > 1000, `the waveform is drawn (${pixels} px)`);
    },
  },
  {
    name: 'st10-wave-band', url: RM('mapped=0'), opts: IPAD,
    async fn(page, t) {
      await ready(page, t);
      const first = () => page.$eval('.roadmap-wavecell', (el) => el.getAttribute('aria-label'));
      const before = await page.$$eval('.roadmap-wavecell', (els) => els.map((el) => el.getAttribute('aria-label')));
      t.expect(before.includes('0:08 to 0:16'), `8 s rows on the band (got ${before})`);
      const touch = await t.touch();
      const box = await page.$eval('.roadmap', (el) => { const r = el.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
      await touch.pinch(box, {from: 80, to: 200, steps: 10});
      await page.waitForFunction(() => !document.querySelector('.roadmap-wavecell')?.getAttribute('aria-label')?.endsWith('0:08'), null, {timeout: 3000});
      const after = await page.$$eval('.roadmap-wavecell', (els) => els.map((el) => el.getAttribute('aria-label')));
      t.expect(after.some((x) => /^0:00 to 0:0[4-6]$/.test(x)), `a pinch makes the rows shorter (got ${after.slice(0, 3)}; first ${await first()})`);
    },
  },
  {
    name: 'st10-wave-zoom', url: RM('mapped=0'), opts: {devices: ['laptop'], themes: ['dark']},
    async fn(page, t) {
      await ready(page, t);
      const rows = () => page.$$eval('.roadmap-wavecell', (els) => els.map((el) => el.getAttribute('aria-label')));
      await page.keyboard.press('Equal');
      await page.waitForFunction(() => [...document.querySelectorAll('.roadmap-wavecell')].some((el) => el.getAttribute('aria-label') === '0:08 to 0:16'), null, {timeout: 3000});
      await page.keyboard.press('Minus');
      await page.keyboard.press('Minus');
      await page.waitForFunction(() => [...document.querySelectorAll('.roadmap-wavecell')].some((el) => el.getAttribute('aria-label') === '0:12 to 0:24'), null, {timeout: 3000});
      const list = await rows();
      t.expect(list.includes('0:12 to 0:24'), `12 s rows (got ${list})`);
    },
  },
  {
    name: 'st10-wave-becomes-roadmap', url: RM('mapped=0'), opts: {devices: ['laptop'], themes: ['dark']},
    async fn(page, t) {
      await ready(page, t);
      await page.evaluate(async () => {
        const {sectioned} = await import('/tests/fixtures/maps.js');
        window.__roadmap.session.mapChange('Bars found', (m) => m.adopt(structuredClone(sectioned.tempo.songMap)));
      });
      await page.waitForSelector('.roadmap[data-kind="roadmap"]', {state: 'attached', timeout: 3000});
      const label = await page.$eval('.roadmap-cell[data-bar="0"]', (el) => el.getAttribute('aria-label'));
      t.expect(label === 'Bar 1, Intro', `the Road map after the bar grid arrives (got ${label})`);
    },
  },
];
