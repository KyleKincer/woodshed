// ST5's states: the Stage HUD and the control set on the HUD harness (/__harness/hud), a real song
// session laid out like the Stage frame (band on the iPad, rail on the laptop). Every state runs with
// fx-audio=manual. Probes: computed type per Distance (probe-readouts: Position 44/56/72 band and
// 52/64/84 rail, Section 32/40/52, Next 17, Speed 40 + 15, the Loop line 17/20, lamps 18/20 × Distance),
// control geometry (the 700 px dock, 64 px controls with Play 96 × 80 and 12 px gaps; 56 px rail rows
// with Play 72), targets, the focus ring, the Stage's 15 px type floor, axe, and the dims while playing.
//   st5-hud-band / st5-hud-rail                 the Chorus loop at 75% with drums out (☼ ⎍ `1 ready` on the rail)
//   st5-hud-band-near / -kit, st5-hud-rail-near / -kit    Distance: type scales, controls never do
//   st5-hud-count-in                            the count-in plate over the music, `✕ Count`, lamps counting
//   st5-hud-playing                             identity at 40%, controls at 70%, readouts at 100%
//   st5-hud-trainer                             the trainer line (rail: bars and trainer; band: trainer)
//   st5-hud-focus-band / st5-hud-focus-mini     Focus: no identity row (band); the 120 px mini rail
//   st5-hud-unmapped                            markers as regions, no lamps, Lead-in, Click "Needs a bar grid"
//   st5-hud-loading                             the Play ring, then "Play when ready"
//   st5-hud-shared / st5-hud-setlist            the read-only identity row; the set line
//   st5-hud-pickup / st5-hud-seven              `Pickup · 3`; 7/8 lamps grouped 2+2+3
//   st5-hud-speed-drag                          dragging the speed value: ±1% per 12 px, one undo step
//   st5-hud-slim                                Edit's slim transport (controls 'slim')
'use strict';

const {checkReadouts} = require('../probes/probe-readouts.cjs');
const {checkTargets} = require('../probes/probe-targets.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');
const {checkAxe} = require('../probes/probe-axe.cjs');

const HUD = (query = '') => `/__harness/hud?fx-audio=manual${query ? `&${query}` : ''}`;
const BAND = {devices: ['ipad'], themes: ['dark']};
const RAIL = {devices: ['laptop'], themes: ['dark']};
const D = {near: 0.8, stand: 1, kit: 1.3};
const max15 = (px) => Math.max(15, Math.round(px * 1000) / 1000);

async function ready(page, t) {
  await t.loadPhase('ready');
  await page.evaluate(() => document.fonts.ready);
}

/** The §4.3/§4.11 type of the readouts at a Distance (probe-readouts rows). */
function readoutRows(layout, distance) {
  const d = D[distance];
  const rail = layout === 'rail';
  const position = {band: {near: 44, stand: 56, kit: 72}, rail: {near: 52, stand: 64, kit: 84}}[layout][distance];
  const section = {near: 32, stand: 40, kit: 52}[distance];
  const lamp = (rail ? 20 : 18) * d;
  return [
    {name: 'Section 40/700 (× Distance)', selector: '.hud-section', font: {size: section, weight: 700}},
    {name: 'Next 17', selector: '.hud-next .ui-readout-value', font: {size: max15(17 * d)}},
    {name: 'Position tabular mono', selector: '.hud-pos-main', font: {size: position, weight: 800}},
    {name: 'Position time 15', selector: '.hud-pos-sub', font: {size: max15(15 * d)}},
    {name: 'Speed 40', selector: '.hud-speed .ui-readout-value', font: {size: 40 * d, weight: 800}},
    {name: 'Speed bpm 15', selector: '.hud-speed .ui-readout-sub', font: {size: max15(15 * d)}},
    {name: 'Loop line', selector: '.hud-loop-line1', font: {size: max15((rail ? 20 : 17) * d), weight: 600}},
    {name: 'Loop range', selector: '.hud-loop-line2', font: {size: max15(15 * d)}, optional: !rail},
    {name: 'Mix pill 15/700', selector: '.hud-mix', font: {size: max15(15 * d), weight: 700}},
    {name: 'Identity 15', selector: '.hud-title', font: {size: max15(15 * d), weight: 700}, optional: true},
    {name: 'Beat lamp', selector: '.ui-beat-lamp[data-kind=beat]', box: {w: lamp, h: lamp}, tolerance: 0.6},
  ];
}

/** The control geometry: never scales with Distance (spec §4.6, §4.11). */
function controlRows(layout) {
  if (layout === 'band') {
    return [
      {name: 'dock 700', selector: '.ctl-set[data-variant=dock]', box: {w: 700, maxW: 700}},
      {name: 'Again 72', selector: '[data-ctl=again]', box: {w: 72, h: 64}},
      {name: 'Play 96 × 80', selector: '[data-ctl=play]', box: {w: 96, h: 80}},
      {name: 'Loop 72', selector: '[data-ctl=loop]', box: {w: 72, h: 64}},
      {name: 'Speed 184', selector: '[data-ctl=speed]', box: {w: 184, h: 64}},
      {name: 'Count-in 80', selector: '[data-ctl=countIn]', box: {w: 80, h: 64}},
      {name: 'Mix 104', selector: '[data-ctl=mix]', box: {w: 104, h: 64}},
      {name: 'Mix ⌃ zone 44', selector: '.ctl-mix-caret', box: {w: 44}},
      {name: 'control labels 15/600', selector: '.ctl-set .ui-button-label', all: true, font: {size: 15, weight: 600}},
    ];
  }
  return [
    {name: 'rail speed row 56', selector: '[data-ctl=speed]', box: {h: 56}},
    {name: 'rail rows 56', selector: '[data-ctl=countIn], [data-ctl=click], [data-ctl=loop], [data-ctl=mix]', all: true, box: {h: 56}},
    {name: 'rail Play row 72', selector: '[data-ctl=play], [data-ctl=again]', all: true, box: {h: 72}},
    {name: 'Mix ⌃ zone 44', selector: '.ctl-mix-caret', box: {w: 44}},
    {name: 'control labels 15/600', selector: '.ctl-set .ui-button-label', all: true, font: {size: 15, weight: 600}},
  ];
}

/** Runs in the page: visible text below 15 px inside the Stage frame (spec §4.11: never below 15). */
function smallText() {
  const frame = document.querySelector('[data-testid=stage-frame]');
  const out = [];
  const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.data.trim()) continue;
    const el = node.parentElement;
    if (!el || !el.checkVisibility?.({opacityProperty: false, visibilityProperty: true})) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 14.95) out.push(`${node.data.trim().slice(0, 30)} (${size}px)`);
  }
  return out;
}

/** Runs in the page: controls that do not fill their cell (each control is its cell's width). */
function unfilled() {
  return [...document.querySelectorAll('.ctl')].flatMap((cell) => {
    const inner = cell.firstElementChild;
    if (!inner) return [];
    const a = cell.getBoundingClientRect(), b = inner.getBoundingClientRect();
    return Math.abs(a.width - b.width) > 1 || Math.abs(a.left - b.left) > 1 ? [`${cell.dataset.ctl} ${Math.round(b.width)} of ${Math.round(a.width)}`] : [];
  });
}

/** Runs in the page: horizontal gaps around Play in the dock. */
function playGaps() {
  const box = (s) => document.querySelector(s).getBoundingClientRect();
  const again = box('[data-ctl=again]'), play = box('[data-ctl=play]'), loop = box('[data-ctl=loop]');
  return {left: Math.round(play.left - again.right), right: Math.round(loop.left - play.right)};
}

async function common(page, t, layout, {distance = 'stand', focusStops = 0, axe = false} = {}) {
  const problems = [
    ...await checkReadouts(page, readoutRows(layout, distance)),
    ...await checkReadouts(page, controlRows(layout)),
  ];
  t.expect(!problems.length, problems.join('\n'));
  const small = await page.evaluate(smallText);
  t.expect(!small.length, `text below 15 px: ${small.join(', ')}`);
  const loose = await page.evaluate(unfilled);
  t.expect(!loose.length, `controls not filling their cells: ${loose.join(', ')}`);
  const play = layout === 'band' ? 80 : 72;
  const targets = await checkTargets(page, {rules: [{selector: '[data-ctl=play] > .ui-button', min: play}]});
  t.expect(!targets.length, targets.join('\n'));
  if (layout === 'band') {
    const gaps = await page.evaluate(playGaps);
    t.expect(gaps.left >= 12 && gaps.right >= 12, `gaps around Play ${JSON.stringify(gaps)}`);
  }
  if (focusStops) {
    const focus = await walkFocus(page, {stops: focusStops});
    t.expect(!focus.length, focus.join('\n'));
  }
  if (axe) {
    const violations = await checkAxe(page, {include: ['[data-testid=stage-frame]']});
    t.expect(!violations.length, violations.join('\n'));
  }
}

const opacity = (page, selector) => page.evaluate((s) => Number(getComputedStyle(document.querySelector(s)).opacity), selector);
const phase = (page) => page.evaluate(() => window.__hud.session.transport.snapshot.peek().phase);

module.exports = [
  {
    name: 'st5-hud-band', url: HUD('layout=band&scenario=looping'), opts: BAND,
    async fn(page, t) {
      await ready(page, t);
      await common(page, t, 'band', {focusStops: 14, axe: true});
      const text = await page.locator('.hud').innerText();
      t.expect(/Chorus/.test(text) && /next: Verse 2 · 8 bars/.test(text) && /LOOP · Chorus/.test(text) && /DRUMS OUT/.test(text), text);
    },
  },
  {
    name: 'st5-hud-rail', url: HUD('layout=rail&scenario=looping&wake=1&pedal=1&ready=1'), opts: RAIL,
    async fn(page, t) {
      await ready(page, t);
      await common(page, t, 'rail', {focusStops: 16, axe: true});
      t.expect(await page.getByRole('img', {name: 'Screen stays awake'}).isVisible(), '☼');
      t.expect(await page.getByRole('img', {name: 'Pedal mode'}).isVisible(), '⎍');
      t.expect(await page.getByRole('button', {name: '1 ready'}).isVisible(), '1 ready');
      // The music column keeps its width; the rail is --rail-w (264 at Stand).
      const rail = await page.locator('[data-testid=rail]').boundingBox();
      t.expect(Math.round(rail.width) === 264, `rail ${rail.width}`);
    },
  },
  ...['near', 'kit'].flatMap((distance) => [
    {
      name: `st5-hud-band-${distance}`, url: HUD(`layout=band&scenario=looping&distance=${distance}`), opts: BAND,
      async fn(page, t) { await ready(page, t); await common(page, t, 'band', {distance}); },
    },
    {
      name: `st5-hud-rail-${distance}`, url: HUD(`layout=rail&scenario=looping&distance=${distance}`), opts: RAIL,
      async fn(page, t) { await ready(page, t); await common(page, t, 'rail', {distance}); },
    },
  ]),
  {
    name: 'st5-hud-count-in', url: HUD('layout=band&scenario=countin&cue=32'), opts: BAND,
    async fn(page, t) {
      await ready(page, t);
      await page.getByRole('button', {name: 'Play', exact: true}).click();
      await t.transportPhase('counting');
      const number = () => page.locator('[data-testid=music] .stage-count-number').innerText();
      t.expect(await number() === '4', 'the count starts at 4');
      for (let i = 0; i < 20 && await number() === '4'; i++) await t.advance(100);
      const play = page.getByRole('button', {name: 'Cancel count-in'});
      t.expect(await play.isVisible(), 'Play reads ✕ Count');
      t.expect((await play.innerText()).trim() === 'Count', `Play label ${await play.innerText()}`);
      const plate = page.locator('[data-testid=music] .stage-count-plate');
      t.expect(await plate.isVisible(), 'the plate overlays the music');
      t.expect((await plate.locator('.stage-count-number').innerText()) === '3', 'counting down');
      t.expect((await plate.locator('.stage-count-label').innerText()) === 'Count-in · bar 17', 'plate label');
      const problems = await checkReadouts(page, [
        {name: 'count 120 --now', selector: '.stage-count-number', font: {size: 120, weight: 800}},
        {name: 'count label 17', selector: '.stage-count-label', font: {size: 17}},
      ]);
      t.expect(!problems.length, problems.join('\n'));
      const lit = await page.$$eval('.ui-beat-lamp', (dots) => dots.findIndex((d) => d.dataset.state === 'now'));
      t.expect(lit === 1, `the lamps count with the plate (${lit})`);
      const small = await page.evaluate(smallText);
      t.expect(!small.length, `text below 15 px: ${small.join(', ')}`);
    },
  },
  {
    name: 'st5-hud-playing', url: HUD('layout=rail&cue=32'), opts: RAIL,
    async fn(page, t) {
      await ready(page, t);
      await page.getByRole('button', {name: 'Play', exact: true}).click();
      await page.mouse.move(400, 400);   // hovering the controls lifts the dim
      await t.transportPhase('playing');
      await t.advance(1100);
      t.expect(await phase(page) === 'playing', 'playing');
      t.expect(Math.abs(await opacity(page, '.hud-identity') - 0.4) < 0.01, 'identity dims to 40%');
      t.expect(Math.abs(await opacity(page, '.ctl-set') - 0.7) < 0.01, 'controls dim to 70%');
      t.expect(await opacity(page, '.hud-readouts') === 1, 'readouts stay at 100%');
      t.expect(await page.getByRole('button', {name: 'Stop', exact: true}).isVisible(), 'Play reads Stop');
      const pos = await page.locator('.hud-pos-main').innerText();
      t.expect(/^17\s*·\s*[234]$/.test(pos.trim()), `position ${pos}`);
    },
  },
  {
    name: 'st5-hud-trainer', url: HUD('layout=rail&scenario=trainer'), opts: {devices: ['laptop', 'ipad'], themes: ['dark']},
    async fn(page, t) {
      await ready(page, t);
      const trainer = await page.locator('.hud-loop-trainer').innerText();
      t.expect(trainer === 'Trainer 70 → 100% · step 1 of 7', trainer);
      t.expect(await page.locator('.hud-loop-line2').isVisible(), 'the rail shows the bars line too');
    },
  },
  {
    name: 'st5-hud-trainer-band', url: HUD('layout=band&scenario=trainer'), opts: BAND,
    async fn(page, t) {
      await ready(page, t);
      t.expect(await page.locator('.hud-loop-trainer').isVisible(), 'trainer line');
      t.expect(!(await page.locator('.hud-loop-line2').isVisible()), 'the band shows the trainer instead of the bars line');
    },
  },
  {
    name: 'st5-hud-focus-band', url: HUD('layout=band&focus=1&scenario=looping'), opts: BAND,
    async fn(page, t) {
      await ready(page, t);
      t.expect(!(await page.locator('.hud-identity').isVisible()), 'Focus hides the identity row');
      t.expect(await page.locator('.hud-readouts').isVisible(), 'readouts stay');
    },
  },
  {
    name: 'st5-hud-focus-mini', url: HUD('layout=rail&focus=1&scenario=looping'), opts: RAIL,
    async fn(page, t) {
      await ready(page, t);
      const rail = await page.locator('[data-testid=rail]').boundingBox();
      t.expect(Math.round(rail.width) === 120, `mini rail ${rail.width}`);
      for (const s of ['.hud-identity', '.hud-cell-speed', '.hud-cell-loop', '.hud-next']) t.expect(!(await page.locator(s).isVisible()), `${s} hidden`);
      for (const s of ['.hud-section', '.hud-pos-main', '.ui-beat-lamps', '[data-ctl=speed]', '[data-ctl=play]']) t.expect(await page.locator(s).isVisible(), `${s} shown`);
      const small = await page.evaluate(smallText);
      t.expect(!small.length, `text below 15 px: ${small.join(', ')}`);
      const targets = await checkTargets(page);
      t.expect(!targets.length, targets.join('\n'));
      const box = await page.locator('.ctl-set').boundingBox();
      t.expect(box.width <= 120, `mini controls ${box.width}`);
    },
  },
  {
    name: 'st5-hud-unmapped', url: HUD('layout=band&mapped=0&scenario=marked'), opts: BAND,
    async fn(page, t) {
      await ready(page, t);
      const text = await page.locator('[data-testid=stage-frame]').innerText();
      t.expect(/Marker 1/.test(text) && /next: bridge\? · 0:08/.test(text), text);
      t.expect(!/Bar|bar /.test(await page.locator('.hud').innerText()), 'the HUD never says Bar');
      t.expect(!(await page.locator('.ui-beat-lamps').isVisible()), 'no lamps');
      t.expect((await page.locator('[data-ctl=countIn] .ui-button-label').innerText()) === 'Lead-in', 'Lead-in');
      const small = await page.evaluate(smallText);
      t.expect(!small.length, `text below 15 px: ${small.join(', ')}`);
    },
  },
  {
    name: 'st5-hud-unmapped-rail', url: HUD('layout=rail&mapped=0&scenario=marked'), opts: RAIL,
    async fn(page, t) {
      await ready(page, t);
      const click = page.locator('[data-ctl=click] button');
      t.expect((await click.getAttribute('aria-disabled')) === 'true', 'Click disabled');
      t.expect((await click.innerText()).includes('Needs a bar grid'), 'the reason shows');
      const small = await page.evaluate(smallText);
      t.expect(!small.length, `text below 15 px: ${small.join(', ')}`);
    },
  },
  {
    name: 'st5-hud-loading', url: HUD('layout=rail&load=hold'), opts: RAIL,
    async fn(page, t) {
      const play = page.locator('[data-ctl=play] button');
      t.expect((await play.getAttribute('data-mode')) === 'loading', 'loading');
      t.expect(await play.locator('.ctl-ring').isVisible(), 'the ring');
      await play.click();
      await page.waitForSelector('[data-ctl=play] button[data-armed]');
      t.expect((await play.getAttribute('aria-label')).endsWith('Play when ready'), await play.getAttribute('aria-label'));
    },
  },
  {
    name: 'st5-hud-shared', url: HUD('layout=band&scenario=shared'), opts: BAND,
    async fn(page, t) {
      await ready(page, t);
      t.expect((await page.locator('.hud-shared').innerText()) === 'Shared by Kyle K.', 'shared by');
      t.expect(await page.getByRole('button', {name: 'Add to my library'}).isVisible(), 'action slot');
    },
  },
  {
    name: 'st5-hud-setlist', url: HUD('layout=rail&scenario=setlist'), opts: RAIL,
    async fn(page, t) {
      await ready(page, t);
      t.expect((await page.locator('.hud-set-text').innerText()) === 'Friday gig · 2 of 5 · next: Second Wind', 'set line');
      t.expect(await page.getByRole('button', {name: 'Next song in set'}).isVisible(), 'next in set');
    },
  },
  {
    name: 'st5-hud-pickup', url: HUD('layout=rail&song=pickup&cue=0.6'), opts: RAIL,
    async fn(page, t) {
      await ready(page, t);
      const main = (await page.locator('.hud-pos-main').innerText()).replace(/\s+/g, ' ').trim();
      t.expect(main === 'Pickup · 3', main);
    },
  },
  {
    name: 'st5-hud-seven', url: HUD('layout=band&song=seven'), opts: BAND,
    async fn(page, t) {
      await ready(page, t);
      const groups = await page.$$eval('.ui-beat-lamps-group', (gs) => gs.map((g) => g.children.length));
      t.expect(JSON.stringify(groups) === '[2,2,3]', `7/8 lamps ${JSON.stringify(groups)}`);
    },
  },
  {
    name: 'st5-hud-speed-drag', url: HUD('layout=rail'), opts: {...RAIL, capture: false},
    async fn(page, t) {
      await ready(page, t);
      const box = await page.locator('.hud-speed .ui-readout-value').boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) await page.mouse.move(x, y - i * 6);
      await page.mouse.up();
      const facts = await page.evaluate(() => ({rate: window.__hud.ts.snapshot.rate, undo: window.__hud.ts.undo.size.undo}));
      t.expect(facts.rate === 1.03 && facts.undo === 1, JSON.stringify(facts));
      t.expect((await page.locator('.hud-speed').getAttribute('data-tone')) === 'ink', 'off 100% the value is --ink');
    },
  },
  {
    name: 'st5-hud-slim', url: HUD('variant=slim&scenario=looping'), opts: {devices: ['laptop', 'ipad'], themes: ['light', 'dark']},
    async fn(page, t) {
      await ready(page, t);
      const bar = await page.locator('.ctl-set[data-variant=slim]').boundingBox();
      t.expect(Math.round(bar.height) === 56, `slim ${bar.height}`);
      const targets = await checkTargets(page);
      t.expect(!targets.length, targets.join('\n'));
      const pos = (await page.locator('.ctl-pos-main').innerText()).replace(/\s+/g, ' ').trim();
      t.expect(pos === '17 · 1', pos);
    },
  },
];
