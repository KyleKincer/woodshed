// ED3's states: the Edit · Map main area and inspector (/__harness/map; tests/harness/edit/map.harness.js)
// on a real song session over the fixture's synthetic stems and a real Edit · Map session. Every state
// runs with fx-audio=manual. view.js imports ED4's Find a chart panel statically (a same-wave peer, §9.0),
// so every state requires it.
//   ed3-map-mapped        laptop and iPad: the 40 px toolbar, the 24 px ruler with bar numbers and the 4/4 chip,
//                         the 32 px sections lane (eight blocks), the 96 px tempo lane, four stem rows with M/S,
//                         the strip; the inspector (320 px column on the laptop, 45% sheet on iPad portrait); axe
//   ed3-map-unmapped      Get a map: times on the ruler, no section or tempo lane, no "Bar" in the main area, the
//                         web with no paired computer reads "Needs Woodshed for desktop"
//   ed3-map-detect        desktop, unmapped: [Detect] runs (the busy button), the job finishes server-side, the
//                         inspector becomes the full one and the status line says "Beat grid found · Undo"
//   ed3-map-detect-mapped desktop, mapped: Tools → Detect beats replaces the map as one map-stack step; Undo
//                         (Mod+Z) puts the old map back
//   ed3-map-suggestion    a section suggestion (D47): dashed blocks with [Keep all] [Review]
//   ed3-map-review        ?review=sections: ✓/✕ per block, drop one, [Apply 4] keeps four sections as one step
//   ed3-map-markers       "You have 3 markers. [Turn them into sections]": one step; Mod+Z brings the markers back
//   ed3-map-keys          D19 through the dispatcher: digits + Enter go to a bar and never mute a stem, E
//                         focuses Meter → Beats, = − \ zoom, G grid, ⇧S snap
//   ed3-map-pins          the tempo lane: the amber suspect span and four pins; a pin's 24 px hit column; a
//                         mouse drag moves a pin as one undo step
//   ed3-map-bar           ?bar=41 selects bar 41 and shows it
//   ed3-map-find          ?find=1: Find a chart in the inspector's place
'use strict';

const {checkAxe} = require('../probes/probe-axe.cjs');
const {checkTargets} = require('../probes/probe-targets.cjs');

const REQUIRES = ['src/edit/map/find-panel.js'];
const PAGE = (query = '') => `/__harness/map?fx-audio=manual${query ? `&${query}` : ''}`;
const LAPTOP = {devices: ['laptop'], requires: REQUIRES};
const BOTH = {requires: REQUIRES};

async function ready(page) {
  await page.waitForFunction(() => !!window.__map && !!document.querySelector('section.map-view'), null, {timeout: 30_000});
  await page.waitForSelector('section.map-view .map-rows-canvas[data-peaks-ready]', {state: 'attached', timeout: 30_000});
  await page.evaluate(() => document.fonts.ready);
}

/** Runs in the page: boxes and state of the map view and inspector. */
function facts() {
  const box = (el) => {
    if (!el || el.closest('[hidden]')) return null;
    const r = el.getBoundingClientRect();
    return {x: r.x, y: r.y, w: r.width, h: r.height};
  };
  const root = document.querySelector('section.map-view');
  const insp = document.querySelector('aside.map-inspector');
  return {
    mapped: root.dataset.mapped,
    toolbar: box(root.querySelector('.map-toolbar')),
    ruler: box(root.querySelector('.map-cell-ruler')),
    sections: box(root.querySelector('.map-cell-sections')),
    tempo: box(root.querySelector('.map-cell-tempo')),
    rows: box(root.querySelector('.map-cell-rows')),
    rulerMode: root.querySelector('.map-ruler').dataset.ruler,
    marks: [...root.querySelectorAll('.map-mark-number')].map((n) => n.textContent),
    meters: [...root.querySelectorAll('.map-meter')].map((n) => n.textContent),
    blocks: [...root.querySelectorAll('.map-section-name')].map((n) => n.textContent),
    suggested: root.querySelectorAll('.map-suggested').length,
    sectionsMode: root.querySelector('.map-sections').dataset.mode,
    heads: [...root.querySelectorAll('.map-head')].map((el) => ({name: el.querySelector('.map-row-name').textContent, ms: [...el.querySelectorAll('.map-ms')].map(box)})),
    pins: Number(root.querySelector('.map-tempo-canvas').dataset.pins),
    suspect: Number(root.querySelector('.map-tempo-canvas').dataset.suspect ?? 0),
    t0: Number(root.dataset.t0), t1: Number(root.dataset.t1),
    inspector: box(insp), mode: insp?.dataset.mode ?? null,
    bar: insp?.querySelector('[data-testid=map-insp-bar]')?.textContent ?? null,
    status: (() => { const s = document.querySelector('[data-testid=map-status]'); return s && !s.hidden ? s.textContent.replace(/\s+/g, ' ').trim() : null; })(),
    strip: !!root.querySelector('.map-strip nav.strip'),
  };
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const state = (page) => page.evaluate(() => {
  const m = window.__map;
  return {json: JSON.stringify(m.map.snapshot()), undo: m.map.undoStack.length, bar: m.mapSession.span.peek().display,
    sections: m.map.sections.map((s) => s.name), markers: (m.session.practice.value.peek().markers ?? []).filter((x) => !x.deleted).length,
    tracks: m.session.transport.snapshot.peek().mix.tracks.map((t) => t.muted), origin: m.map.snapshot().origin ?? null,
    digits: m.mapSession.digits.peek()};
});
const button = (page, name) => page.getByRole('button', {name, exact: true});

module.exports = [
  {
    name: 'ed3-map-mapped', url: PAGE('scenario=sectioned'), opts: BOTH,
    async fn(page, t) {
      await ready(page);
      const f = await page.evaluate(facts);
      t.expect(f.mapped === 'true', 'a mapped song');
      const portrait = await page.evaluate(() => window.innerHeight > window.innerWidth);
      // 40 px on fine pointers; on iPad it grows to hold its 44 px targets.
      t.expect(portrait ? f.toolbar.h >= 44 && f.toolbar.h <= 46 : near(f.toolbar.h, 40, 0.5), `the toolbar is 40 px (44 coarse) (got ${f.toolbar.h})`);
      t.expect(near(f.ruler.h, 24, 0.5), `the ruler is 24 px (got ${f.ruler.h})`);
      t.expect(portrait ? near(f.sections.h, 45, 0.5) : near(f.sections.h, 32, 0.5), `the sections lane is 32 px (45 coarse, for 44 px targets) (got ${f.sections.h})`);
      t.expect(near(f.tempo.h, 96, 0.5), `the tempo lane is 96 px (got ${f.tempo.h})`);
      t.expect(f.rulerMode === 'bars' && f.marks[0] === '1' && f.meters[0] === '4/4', `bar numbers with the meter chip (got ${f.marks.slice(0, 3)} ${f.meters})`);
      t.expect(f.blocks.join() === 'Intro,Verse,Chorus,Verse 2,Chorus 2,Bridge,Chorus 3,Outro', `eight section blocks (got ${f.blocks})`);
      t.expect(f.heads.map((r) => r.name).join() === 'Drums,Bass,Vocals,Other', `four stem rows (got ${f.heads.map((r) => r.name)})`);
      t.expect(f.heads.every((r) => r.ms.length === 2), 'M and S on every row');
      t.expect(f.pins === 1, `one pin (got ${f.pins})`);
      t.expect(f.strip, 'the strip');
      t.expect(f.mode === 'mapped' && f.bar === 'BAR 1', `the inspector shows bar 1 (got ${f.mode} ${f.bar})`);
      if (portrait) {
        const vh = await page.evaluate(() => window.innerHeight);
        t.expect(f.inspector && f.inspector.y > vh * 0.45, `iPad portrait: the inspector is the bottom sheet (got y ${f.inspector?.y} of ${vh})`);
        const problems = await checkTargets(page);
        t.expect(!problems.length, `targets: ${JSON.stringify(problems.slice(0, 6))}`);
      } else {
        t.expect(f.inspector && near(f.inspector.w, 320, 1), `the 320 px inspector column (got ${f.inspector?.w})`);
      }
      const problems = await checkAxe(page, {include: ['section.map-view', 'aside.map-inspector']});
      t.expect(!problems.length, problems.join('; '));
    },
  },
  {
    name: 'ed3-map-unmapped', url: PAGE('mapped=0'), opts: BOTH,
    async fn(page, t) {
      await ready(page);
      const f = await page.evaluate(facts);
      t.expect(f.mapped === 'false' && f.rulerMode === 'time' && f.marks[0] === '0:00', `times on the ruler (got ${f.rulerMode} ${f.marks.slice(0, 3)})`);
      t.expect(!(f.sections?.h > 0) && !(f.tempo?.h > 0), `no sections or tempo lane without a map (got ${JSON.stringify([f.sections, f.tempo])})`);
      t.expect(f.mode === 'unmapped', `Get a map (got ${f.mode})`);
      const texts = await page.evaluate(() => {
        const root = document.querySelector('section.map-view').cloneNode(true);
        root.querySelector('.map-strip')?.remove();
        root.querySelectorAll('[hidden]').forEach((n) => n.remove());
        const out = [root.textContent];
        for (const el of root.querySelectorAll('*')) for (const a of ['aria-label', 'aria-valuetext', 'title']) if (el.getAttribute(a)) out.push(el.getAttribute(a));
        return out;
      });
      for (const text of texts) t.expect(!/\bbar\b/i.test(text), `no "bar" in the main area of an unmapped song (found in ${JSON.stringify(text.slice(0, 80))})`);
      const needs = page.locator('aside.map-inspector .map-getmap-needs');
      t.expect(await needs.isVisible() && (await needs.textContent()).startsWith('Needs Woodshed for desktop'), 'the web without a paired computer');
      t.expect(!(await button(page, 'Detect').isVisible()), 'no [Detect] without a computer to run it');
      t.expect(await page.getByRole('link', {name: 'Get it ↗'}).isVisible(), 'Get it ↗');
      t.expect(await button(page, 'Start tapping').isVisible() && await button(page, 'Find a chart…').isVisible(), 'Tap along and Find a chart');
    },
  },
  {
    name: 'ed3-map-detect', url: PAGE('mapped=0&desktop=1'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page);
      t.expect(await page.getByText('About 30 s on this computer', {exact: false}).isVisible(), 'Detect runs on this computer');
      await button(page, 'Detect').click();
      await page.waitForFunction(() => window.__map.ts.server.jobRows.some((j) => j.kind === 'beats'));
      await page.waitForFunction(() => document.querySelector('aside.map-inspector [aria-busy="true"]'));
      await t.capture('running');
      await page.evaluate(() => {
        const m = window.__map;
        const job = m.ts.server.jobRows.find((j) => j.kind === 'beats');
        m.ts.server.finishJob(job.jobId, {beats: Array.from({length: 250}, (_, i) => [0.3 + i * 0.5, (i % 4) + 1])});
      });
      await page.waitForFunction(() => document.querySelector('aside.map-inspector')?.dataset.mode === 'mapped', null, {timeout: 15_000});
      const f = await page.evaluate(facts);
      t.expect(f.mapped === 'true' && f.rulerMode === 'bars', 'the map switches bars on');
      const s = await state(page);
      t.expect(s.origin === 'detected', `origin detected (got ${s.origin})`);
      await t.capture('done');
    },
  },
  {
    name: 'ed3-map-detect-mapped', url: PAGE('scenario=sectioned&desktop=1'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page);
      const before = await state(page);
      await button(page, 'Detect beats').click();
      await page.waitForFunction(() => window.__map.ts.server.jobRows.some((j) => j.kind === 'beats'));
      await page.evaluate(() => {
        const m = window.__map;
        const job = m.ts.server.jobRows.find((j) => j.kind === 'beats');
        m.ts.server.finishJob(job.jobId, {beats: Array.from({length: 200}, (_, i) => [0.25 + i * 0.6, (i % 3) + 1])});
      });
      await page.waitForFunction((json) => JSON.stringify(window.__map.map.snapshot()) !== json, before.json, {timeout: 15_000});
      await page.waitForFunction(() => /Beat grid found/.test(document.querySelector('[data-testid=map-status]')?.textContent ?? ''));
      const f = await page.evaluate(facts);
      t.expect(/Beat grid found/.test(f.status) && /Undo/.test(f.status), `"Beat grid found · Undo" in the status line (got ${f.status})`);
      const after = await state(page);
      t.expect(after.undo === before.undo + 1, `one map-stack step (${before.undo} → ${after.undo})`);
      await page.mouse.click(5, 5);
      await page.keyboard.press('ControlOrMeta+KeyZ');
      await page.waitForFunction((json) => JSON.stringify(window.__map.map.snapshot()) === json, before.json, {timeout: 5_000});
    },
  },
  {
    name: 'ed3-map-suggestion', url: PAGE('scenario=suggestion'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page);
      const f = await page.evaluate(facts);
      t.expect(f.sectionsMode === 'suggestion' && f.suggested === 5, `five dashed blocks (got ${f.sectionsMode} ${f.suggested})`);
      const dashed = await page.$eval('.map-suggested', (el) => getComputedStyle(el).borderTopStyle);
      t.expect(dashed === 'dashed', `dashed (got ${dashed})`);
      const bar = page.getByTestId('map-sections-bar');
      t.expect(await bar.getByRole('button', {name: 'Keep all', exact: true}).isVisible() && await bar.getByRole('button', {name: 'Review', exact: true}).isVisible(),
        '[Keep all] [Review] under the lane');
      t.expect(await button(page, 'Suggest sections').isVisible(), 'Tools offers Suggest sections on a song without sections');
    },
  },
  {
    name: 'ed3-map-review', url: PAGE('scenario=suggestion&review=sections'), opts: BOTH,
    async fn(page, t) {
      await ready(page);
      let f = await page.evaluate(facts);
      t.expect(f.sectionsMode === 'review', `the review is open (got ${f.sectionsMode})`);
      t.expect(await button(page, 'Apply 5').isVisible(), 'Apply 5');
      await t.capture('open');
      await page.getByRole('button', {name: 'Drop Verse'}).first().click();
      t.expect(await button(page, 'Apply 4').isVisible(), 'Apply 4 after dropping one');
      const before = await state(page);
      await button(page, 'Apply 4').click();
      await page.waitForFunction(() => document.querySelector('.map-sections').dataset.mode === 'sections');
      const after = await state(page);
      t.expect(after.sections.length === 4 && after.sections[0] === 'Intro', `four sections kept (got ${after.sections})`);
      t.expect(after.undo === before.undo + 1, `one map step (${before.undo} → ${after.undo})`);
      f = await page.evaluate(facts);
      t.expect(f.blocks.length === 4, `the lane shows them (got ${f.blocks})`);
    },
  },
  {
    name: 'ed3-map-markers', url: PAGE('scenario=markers'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page);
      const banner = page.locator('[data-testid=map-markers-banner]');
      t.expect(await banner.isVisible(), 'the markers banner');
      const text = (await banner.textContent()).replace(/\s+/g, ' ');
      t.expect(text.includes('You have 3 markers.') && text.includes('(snaps each to the nearest bar)'), `the banner copy (got ${text})`);
      await t.capture('banner');
      await button(page, 'Turn them into sections').click();
      await page.waitForFunction(() => window.__map.map.sections.length > 0);
      let s = await state(page);
      t.expect(s.markers === 0 && s.sections.includes('Bridge'), `markers became sections (got ${s.sections}, ${s.markers} markers left)`);
      t.expect(!(await banner.isVisible()), 'the banner hides');
      await page.mouse.click(5, 5);
      await page.keyboard.press('ControlOrMeta+KeyZ');
      await page.waitForFunction(() => window.__map.map.sections.length === 0);
      s = await state(page);
      t.expect(s.markers === 3, `Undo brings the markers back (got ${s.markers})`);
    },
  },
  {
    name: 'ed3-map-keys', url: PAGE('scenario=sectioned'), opts: {...LAPTOP, themes: ['dark']},
    async fn(page, t) {
      await ready(page);
      await page.mouse.click(5, 5);
      await page.keyboard.press('Digit4');
      await page.keyboard.press('Digit1');
      let s = await state(page);
      t.expect(s.digits === '41' && s.tracks.every((m) => !m), `digits are typed, no stem muted (got ${s.digits} ${s.tracks})`);
      await page.keyboard.press('Enter');
      s = await state(page);
      t.expect(s.bar === 41 && s.digits === '', `Enter goes to bar 41 (got ${s.bar})`);
      await page.keyboard.press('ArrowRight');
      s = await state(page);
      t.expect(s.bar === 42, `→ steps a bar (got ${s.bar})`);
      await page.keyboard.press('KeyE');
      const focused = await page.evaluate(() => !!document.activeElement?.closest('.map-beats'));
      t.expect(focused, 'E focuses Meter → Beats');
      await page.mouse.click(5, 5);
      await page.keyboard.press('Equal');
      let f = await page.evaluate(facts);
      t.expect(near(f.t1 - f.t0, 64, 0.01), `= zooms in (got ${f.t0}–${f.t1})`);
      await page.keyboard.press('Backslash');
      f = await page.evaluate(facts);
      t.expect(near(f.t1 - f.t0, 128, 0.01), `\\ fits (got ${f.t0}–${f.t1})`);
      const grid = await page.evaluate(() => document.querySelector('section.map-view').dataset.grid);
      await page.keyboard.press('KeyG');
      const grid2 = await page.evaluate(() => document.querySelector('section.map-view').dataset.grid);
      t.expect(grid !== grid2 && [grid, grid2].includes('off'), `G toggles the grid (${grid} → ${grid2})`);
      const snap = await page.evaluate(() => window.__map.view.snapOn());
      await page.keyboard.press('Shift+KeyS');
      t.expect(await page.evaluate(() => window.__map.view.snapOn()) === !snap, '⇧S toggles Snap');
    },
  },
  {
    name: 'ed3-map-pins', url: PAGE('scenario=pins'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page);
      let f = await page.evaluate(facts);
      t.expect(f.pins === 4, `four pins (got ${f.pins})`);
      t.expect(f.suspect === 1, `one amber suspect span (got ${f.suspect})`);
      await t.capture('lane');
      // The pin at 16 s: hover finds it in a 24 px square around the diamond.
      const x = f.tempo.x + ((16 - f.t0) / (f.t1 - f.t0)) * f.tempo.w;
      const rows = [];
      for (let y = Math.ceil(f.tempo.y); y < f.tempo.y + f.tempo.h; y++) {
        await page.mouse.move(x + 10, y);
        if (await page.$eval('.map-tempo-canvas', (el) => el.dataset.hover === 'pin')) rows.push(y);
      }
      t.expect(rows.length >= 23 && rows.length <= 25, `a 24 px hit square 10 px off the pin (got ${rows.length} rows)`);
      const y = rows[Math.floor(rows.length / 2)];
      const before = await state(page);
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(x + i * 2, y);
      await page.mouse.up();
      const after = await state(page);
      t.expect(after.undo === before.undo + 1, `the drag is one undo step (${before.undo} → ${after.undo})`);
      const moved = await page.evaluate(() => window.__map.map.snapshot().pins[1].time);
      t.expect(moved > 16.05, `the pin moved right (got ${moved})`);
    },
  },
  {
    name: 'ed3-map-bar', url: PAGE('scenario=sectioned&bar=41'), opts: {...LAPTOP, capture: false},
    async fn(page, t) {
      await ready(page);
      const f = await page.evaluate(facts);
      t.expect(f.bar === 'BAR 41', `?bar=41 selects bar 41 (got ${f.bar})`);
      t.expect(f.t0 <= 80 && f.t1 >= 82, `bar 41 is in view (got ${f.t0}–${f.t1})`);
    },
  },
  {
    name: 'ed3-map-find', url: PAGE('scenario=sectioned&find=1'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page);
      const panel = await page.evaluate(() => !!document.querySelector('.map-harness-inspector .find-panel, .map-harness-inspector [class*=find]'));
      t.expect(panel, 'Find a chart is in the inspector place');
      t.expect(!(await page.$('aside.map-inspector')), 'the inspector is replaced');
    },
  },
];
