// ST11's states: the Stems surface inside the real Stage (/__harness/stems; tests/harness/stage/stems.harness.js),
// a real song session over the fixture's synthetic stems. Every state runs with fx-audio=manual.
//   st11-stems-rail          laptop: the 40 px toolbar, the bar ruler, four rows split equally (≥ 72 px) with
//                            168 px headers, 32 px M/S, the 120 px fader with its %, waveforms drawn, axe
//   st11-stems-band          iPad: 128 px headers, 44 px M/S, no fader (the Mix sheet has it), targets
//   st11-stems-mix           drums OUT (struck through, hatched), bass SOLO (accent ring), the others outlines; every
//                            word (and, on the laptop, the 120 px fader and its %) lies inside its header
//   st11-stems-unmapped      times on the ruler, no Grid control, no "Bar" anywhere on the surface
//   st11-stems-keys          = − \ Z G ⇧S F through the dispatcher ('stage.stems' scope): F is Follow, not Focus
//   st11-stems-mouse         click cues to the nearest beat; a drag makes a bar-snapped loop; its edge resizes it
//   st11-stems-wheel         playing: the wheel zooms at the cursor and pauses Follow; the 56 px pill (view.followResume)
//                            resumes it; paused again, Pause hides the pill
//   st11-stems-follow        playing with a 16 s window: Follow pages the playhead back to 10 %
//   st11-stems-zoom          prefs.stems.zoom: = then a reload opens at the same zoom, around the cue
//   st11-stems-viewport      the strip's viewport bracket shows the window; dragging it moves the window
//   st11-stems-grid          8 s window, Grid: Beat: beats and bars drawn; at Fit only bars (≥ 6 px rule)
//   st11-stems-touch         iPad: tap cues; long-press then drag loops; a pinch zooms; two fingers pan
'use strict';

const {checkAxe} = require('../probes/probe-axe.cjs');
const {checkTargets} = require('../probes/probe-targets.cjs');

const PEERS = ['src/stage/stage.js', 'src/stage/hud.js', 'src/stage/controls.js', 'src/stage/strip.js'];
const STEMS = (query = '') => `/__harness/stems?place=stage&fx-audio=manual${query ? `&${query}` : ''}`;
const LAPTOP = {devices: ['laptop'], requires: PEERS};
const IPAD = {devices: ['ipad'], requires: PEERS};
const BOTH = {requires: PEERS};

async function ready(page, t) {
  await t.loadPhase('ready');
  await page.waitForSelector('section.stems canvas[data-peaks-ready]', {state: 'attached', timeout: 30_000});
  await page.evaluate(() => document.fonts.ready);
}

/** Runs in the page: the surface's boxes and state. */
function facts() {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {x: r.x, y: r.y, w: r.width, h: r.height};
  };
  const root = document.querySelector('section.stems');
  const heads = [...root.querySelectorAll('.stems-head')];
  return {
    root: box(root),
    toolbar: box(root.querySelector('.stems-toolbar')),
    ruler: box(root.querySelector('.stems-ruler')),
    lanes: box(root.querySelector('.stems-lanes')),
    heads: heads.map((el) => ({...box(el), name: el.querySelector('.stems-name').textContent, state: el.dataset.state,
      word: el.querySelector('.stems-word').textContent, wordBox: box(el.querySelector('.stems-word')),
      fader: box(el.querySelector('.stems-head-level:not([hidden]) .ui-slider-control')),
      value: (() => { const v = el.querySelector('.stems-level:not([hidden])'); return v && v.offsetParent ? v.textContent : null; })(),
      valueBox: box(el.querySelector('.stems-level:not([hidden])')),
      ms: [...el.querySelectorAll('.stems-ms')].map(box)})),
    marks: [...root.querySelectorAll('.stems-mark')].map((m) => m.textContent),
    t0: Number(root.dataset.t0), t1: Number(root.dataset.t1),
    grid: root.querySelector('canvas').dataset.gridDrawn ?? null,
    ruler: root.dataset.ruler,
    pill: !root.querySelector('.stems-pill').hidden,
    followBox: box(root.querySelector('.stems-follow')),
  };
}

const snap = (page) => page.evaluate(() => {
  const s = window.__stems.session.transport.snapshot.peek();
  return {phase: s.phase, cue: s.cue, loop: s.loop, mix: s.mix.tracks, position: window.__stems.session.transport.position()};
});

/** The client x of time t on the lanes (from the window the surface shows). */
const xOf = (f, t) => f.lanes.x + ((t - f.t0) / (f.t1 - f.t0)) * f.lanes.w;
const near = (a, b, tol) => Math.abs(a - b) <= tol;
/** Box `inner` lies inside box `outer` (half a pixel of rounding). */
const inside = (inner, outer) => !!inner && !!outer && inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5
  && inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5;
const view = (page) => page.evaluate(() => {
  const root = document.querySelector('section.stems');
  return {t0: Number(root.dataset.t0), t1: Number(root.dataset.t1)};
});
const pressedOf = (page, name) => page.getByRole('button', {name, exact: true}).getAttribute('aria-pressed');
async function play(page, t) {
  await page.evaluate(() => window.__stems.session.transport.play());
  await t.transportPhase('playing');
}
async function stop(page, t) {
  await page.evaluate(() => window.__stems.session.transport.stop());
  await t.transportPhase('stopped');
}
/** Every string on the surface: its text and its accessible attributes. */
const surfaceStrings = (page) => page.evaluate(() => {
  const root = document.querySelector('section.stems');
  const out = [root.textContent];
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const name of ['aria-label', 'aria-valuetext', 'title']) if (el.getAttribute(name)) out.push(el.getAttribute(name));
  }
  return out;
});

module.exports = [
  {
    name: 'st11-stems-rail', url: STEMS('cue=20'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t);
      const f = await page.evaluate(facts);
      t.expect(near(f.toolbar.h, 40, 0.5), `the toolbar is 40 px (got ${f.toolbar.h})`);
      t.expect(f.ruler === 'bars' && f.marks[0] === '1', `bar numbers on the ruler (got ${f.ruler} ${f.marks.slice(0, 4)})`);
      t.expect(f.heads.length === 4 && f.heads.map((r) => r.name).join() === 'Drums,Bass,Vocals,Other', `four rows in canonical order (${f.heads.map((r) => r.name)})`);
      for (const r of f.heads) {
        t.expect(near(r.w, 168, 0.5), `a 168 px header (got ${r.w})`);
        t.expect(r.h >= 72 && near(r.h, f.heads[0].h, 1), `rows split equally, ≥ 72 px (got ${r.h})`);
        t.expect(r.ms.length === 2 && r.ms.every((b) => near(b.w, 32, 0.5) && near(b.h, 32, 0.5)), `32 px M/S (got ${JSON.stringify(r.ms)})`);
        t.expect(r.fader && near(r.fader.w, 120, 0.5) && inside(r.fader, r), `a 120 px fader inside its header (got ${JSON.stringify(r.fader)})`);
        t.expect(r.value === '100%' && inside(r.valueBox, r), `the fader's % value inside the header (got ${r.value} ${JSON.stringify(r.valueBox)})`);
      }
      t.expect(f.followBox && near(f.followBox.x + f.followBox.w, f.toolbar.x + f.toolbar.w - 12, 1.5),
        `Follow is right-aligned in the toolbar (got ${JSON.stringify(f.followBox)} in ${JSON.stringify(f.toolbar)})`);
      t.expect(near(f.t0, 0, 0.01) && near(f.t1, 128, 0.01), `opens at Fit (got ${f.t0}–${f.t1})`);
      t.expect(f.grid === 'bar', `at Fit only bar lines are drawn (got ${f.grid})`);
      const name = await page.$eval('.stems-name', (el) => {
        const cs = getComputedStyle(el);
        return {size: cs.fontSize, weight: cs.fontWeight};
      });
      t.expect(name.size === '16px' && name.weight === '700', `names 16/700 (got ${JSON.stringify(name)})`);
      const problems = await checkAxe(page, {include: ['section.stems']});
      t.expect(!problems.length, problems.join('; '));
    },
  },
  {
    name: 'st11-stems-band', url: STEMS('cue=20'), opts: IPAD,
    async fn(page, t) {
      await ready(page, t);
      const f = await page.evaluate(facts);
      for (const r of f.heads) {
        t.expect(near(r.w, 128, 0.5), `a 128 px header (got ${r.w})`);
        t.expect(r.ms.every((b) => near(b.w, 44, 0.5) && near(b.h, 44, 0.5)), `44 px M/S (got ${JSON.stringify(r.ms)})`);
        t.expect(!r.fader, 'no fader on the iPad (the Mix sheet has it)');
        t.expect(r.h >= 72, `rows ≥ 72 px (got ${r.h})`);
      }
      const problems = await checkTargets(page);
      t.expect(!problems.length, `targets: ${JSON.stringify(problems.slice(0, 6))}`);
    },
  },
  {
    name: 'st11-stems-mix', url: STEMS('scenario=mix'), opts: BOTH,
    async fn(page, t) {
      await ready(page, t);
      const f = await page.evaluate(facts);
      t.expect(f.heads.map((r) => r.state).join() === 'out,solo,dim,dim', `states (got ${f.heads.map((r) => r.state)})`);
      t.expect(f.heads[0].word === 'OUT' && f.heads[1].word === 'SOLO', `words (got ${f.heads.map((r) => r.word)})`);
      for (const r of f.heads.slice(0, 2)) {
        t.expect(inside(r.wordBox, r), `${r.name}'s ${r.word} lies inside its header (got ${JSON.stringify(r.wordBox)} in ${JSON.stringify({x: r.x, y: r.y, w: r.w, h: r.h})})`);
        if (r.fader) t.expect(inside(r.fader, r) && inside(r.valueBox, r), `${r.name}'s fader and % lie inside its header`);
      }
      const looks = await page.evaluate(() => {
        const [drums, bass] = document.querySelectorAll('.stems-head');
        const probe = document.createElement('span');
        probe.style.color = 'var(--accent)';
        drums.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        const word = getComputedStyle(drums.querySelector('.stems-word'));
        return {strike: word.textDecorationLine, hatch: getComputedStyle(drums.querySelector('.stems-color')).backgroundImage,
          ring: getComputedStyle(bass).boxShadow, accent, opacity: getComputedStyle(drums).opacity};
      });
      t.expect(looks.strike.includes('line-through'), `OUT is struck through (got ${looks.strike})`);
      t.expect(looks.hatch.includes('repeating-linear-gradient'), `the muted colour bar is hatched (got ${looks.hatch})`);
      t.expect(looks.opacity === '1', `muted is never opacity (got ${looks.opacity})`);
      t.expect(looks.ring.includes(looks.accent), `SOLO has an accent ring (got ${looks.ring} vs ${looks.accent})`);
    },
  },
  {
    name: 'st11-stems-unmapped', url: STEMS('mapped=0&cue=20'), opts: BOTH,
    async fn(page, t) {
      await ready(page, t);
      const f = await page.evaluate(facts);
      t.expect(f.ruler === 'time' && f.marks[0] === '0:00', `times on the ruler (got ${f.ruler} ${f.marks.slice(0, 3)})`);
      t.expect(!(await page.$('section.stems .stems-grid-button')), 'no Grid control without a bar grid');
      for (const text of await surfaceStrings(page)) t.expect(!/Bar|bar /.test(text), `no "Bar" on an unmapped song (found in ${JSON.stringify(text.slice(0, 80))})`);
      t.expect(f.grid === null, `no grid lines (got ${f.grid})`);
    },
  },
  {
    name: 'st11-stems-keys', url: STEMS('cue=40'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t);
      await page.mouse.click(5, 5);   // focus the page, nothing focused inside
      await page.keyboard.press('Equal');
      let v = await view(page);
      t.expect(near(v.t1 - v.t0, 64, 0.01), `= zooms in (got ${v.t0}–${v.t1})`);
      await page.keyboard.press('Minus');
      v = await view(page);
      t.expect(near(v.t1 - v.t0, 128, 0.01), `− zooms out (got ${v.t0}–${v.t1})`);
      await page.keyboard.press('Equal');
      await page.keyboard.press('Equal');
      await page.keyboard.press('Backslash');
      v = await view(page);
      t.expect(near(v.t1 - v.t0, 128, 0.01), `\\ fits (got ${v.t0}–${v.t1})`);
      await page.evaluate(() => window.__stems.session.transport.loopRange(32, 48, {snap: 'none'}));
      await page.keyboard.press('KeyZ');
      v = await view(page);
      t.expect(near(v.t0, 31.2, 0.01) && near(v.t1, 48.8, 0.01), `Z zooms to the loop with a margin (got ${v.t0}–${v.t1})`);
      await page.keyboard.press('KeyG');
      await page.waitForFunction(() => document.querySelector('.stems-grid-button')?.textContent.includes('Off'));
      await page.keyboard.press('KeyG');
      await page.waitForFunction(() => document.querySelector('.stems-grid-button')?.textContent.includes('Bar'));
      await page.keyboard.press('Shift+KeyS');
      await page.waitForFunction(() => [...document.querySelectorAll('section.stems button')].find((b) => b.textContent.trim() === 'Snap')?.getAttribute('aria-pressed') === 'false');
      await page.keyboard.press('KeyF');
      await page.waitForFunction(() => [...document.querySelectorAll('section.stems button')].find((b) => b.textContent.trim() === 'Follow')?.getAttribute('aria-pressed') === 'false');
      const focus = await page.evaluate(() => document.querySelector('.stage').hasAttribute('data-focus'));
      t.expect(!focus, 'F on the Stems surface is Follow, never Focus');
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ws.prefs')).stems);
      t.expect(stored.grid === 'bar' && stored.snap === false && stored.follow === false, `prefs.stems (got ${JSON.stringify(stored)})`);
    },
  },
  {
    name: 'st11-stems-mouse', url: STEMS('cue=4'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t);
      let f = await page.evaluate(facts);
      const y = f.lanes.y + 60;
      await page.mouse.click(xOf(f, 64.6), y);
      // Snap on, Grid: Bar: a click cues to the nearest beat (spec §4.9), not to the bar line.
      await page.waitForFunction(() => window.__stems.session.transport.snapshot.peek().cue === 64.5);
      // A drag makes a loop, snapped out to the bars it touches.
      await page.mouse.move(xOf(f, 17), y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(xOf(f, 17 + 3 * i), y);
      await page.mouse.up();
      let s = await snap(page);
      t.expect(s.loop.on && s.loop.a === 16 && s.loop.b === 48, `a bar-snapped loop (got ${JSON.stringify(s.loop)})`);
      // Its right edge resizes it.
      f = await page.evaluate(facts);
      const edge = xOf(f, 48);
      await page.mouse.move(edge, y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(edge + (xOf(f, 55.8) - edge) * i / 8, y);
      await page.mouse.up();
      s = await snap(page);
      t.expect(s.loop.a === 16 && s.loop.b === 56, `the edge resized it (got ${JSON.stringify(s.loop)})`);
      const band = await page.$eval('section.stems .loop-band', (el) => getComputedStyle(el).backgroundColor);
      t.expect(band && band !== 'rgba(0, 0, 0, 0)', `the loop band is filled (got ${band})`);
    },
  },
  {
    name: 'st11-stems-wheel', url: STEMS('cue=20&zoom=32'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t);
      let f = await page.evaluate(facts);
      const x = xOf(f, 24), y = f.lanes.y + 80;
      await play(page, t);
      await page.mouse.move(x, y);
      const before = await view(page);
      const at = before.t0 + ((x - f.lanes.x) / f.lanes.w) * (before.t1 - before.t0);
      await page.mouse.wheel(0, -200);
      await page.waitForFunction((s) => {
        const r = document.querySelector('section.stems').dataset;
        return Number(r.t1) - Number(r.t0) < s - 1;
      }, before.t1 - before.t0);
      const after = await view(page);
      const atAfter = after.t0 + ((x - f.lanes.x) / f.lanes.w) * (after.t1 - after.t0);
      t.expect(near(at, atAfter, 0.05), `zooms at the cursor (${at} → ${atAfter})`);
      f = await page.evaluate(facts);
      t.expect(f.pill, 'manual wheel use while playing pauses Follow and shows the pill');
      const pill = page.getByRole('button', {name: 'Back to playhead'});
      const box = await pill.boundingBox();
      t.expect(near(box.h ?? box.height, 56, 0.5), `a 56 px pill (got ${JSON.stringify(box)})`);
      const centre = box.x + box.width / 2;
      t.expect(near(centre, f.root.x + f.root.w / 2, 2), `bottom centre (got ${centre} in ${JSON.stringify(f.root)})`);
      await t.capture('paused');
      await pill.click();
      await page.waitForFunction(() => document.querySelector('section.stems .stems-pill').hidden);
      // The pill ran view.followResume: the Stage follows again, so the command is off.
      const resume = await page.evaluate(() => window.__stems.registry.state('view.followResume')?.enabled ?? null);
      t.expect(resume === false, `view.followResume is done (enabled: ${resume})`);
      // Paused again, then the transport pauses: the pill is only for the Playing columns (spec §4.9).
      await page.mouse.wheel(0, -200);
      await page.waitForFunction(() => !document.querySelector('section.stems .stems-pill').hidden);
      await page.evaluate(() => window.__stems.session.transport.pause());
      await t.transportPhase('paused');
      await page.waitForFunction(() => document.querySelector('section.stems .stems-pill').hidden);
      await stop(page, t);
    },
  },
  {
    name: 'st11-stems-follow', url: STEMS('cue=0&zoom=16'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t);
      let v = await view(page);
      t.expect(near(v.t0, 0, 0.01) && near(v.t1, 16, 0.01), `opens with the 16 s window (got ${v.t0}–${v.t1})`);
      await play(page, t);
      await t.advance(20_000);
      await page.waitForFunction(() => Number(document.querySelector('section.stems').dataset.t0) > 0);
      v = await view(page);
      const s = await snap(page);
      t.expect(s.position >= v.t0 && s.position <= v.t1, `the playhead stays in view (${s.position} in ${v.t0}–${v.t1})`);
      const playhead = await page.$eval('section.stems .stems-playhead', (el) => !el.hidden && getComputedStyle(el).visibility === 'visible');
      t.expect(playhead, 'the playhead line shows while playing');
      await stop(page, t);
    },
  },
  {
    name: 'st11-stems-zoom', url: STEMS('cue=40&zoom=fit'), opts: {...LAPTOP, themes: ['dark'], capture: false},
    async fn(page, t) {
      await ready(page, t);
      await page.mouse.click(5, 5);
      await page.keyboard.press('Equal');
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('ws.prefs') ?? '{}').stems?.zoom === 64, null, {timeout: 5000});
      await page.goto(t.url.replace('&zoom=fit', ''));
      await page.waitForSelector('html[data-view-ready="stems"]', {state: 'attached'});
      await ready(page, t);
      const v = await view(page);
      t.expect(near(v.t1 - v.t0, 64, 0.01) && v.t0 <= 40 && v.t1 >= 40, `the device's zoom is restored around the cue (got ${v.t0}–${v.t1})`);
    },
  },
  {
    name: 'st11-stems-viewport', url: STEMS('cue=40&zoom=16'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t);
      const before = await view(page);
      const bracket = await page.$eval('.strip-viewport', (el) => {
        const r = el.getBoundingClientRect(), s = document.querySelector('.strip-slider').getBoundingClientRect();
        return {x: r.x, w: r.width, y: r.y + r.height / 2, sx: s.x, sw: s.width, hidden: el.hidden};
      });
      t.expect(!bracket.hidden && near(bracket.w, bracket.sw * 16 / 128, 2), `the bracket spans the window (got ${JSON.stringify(bracket)})`);
      t.expect(near(bracket.x - bracket.sx, bracket.sw * before.t0 / 128, 2), `the bracket starts at the window (got ${bracket.x - bracket.sx})`);
      await page.mouse.move(bracket.x + bracket.w / 2, bracket.y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(bracket.x + bracket.w / 2 + 10 * i, bracket.y);
      await page.mouse.up();
      const after = await view(page);
      t.expect(near(after.t0 - before.t0, 100 / bracket.sw * 128, 1), `dragging the bracket moves the window (${before.t0} → ${after.t0})`);
      t.expect(near(after.t1 - after.t0, 16, 0.01), `the zoom is kept (got ${after.t1 - after.t0})`);
    },
  },
  {
    name: 'st11-stems-grid', url: STEMS('cue=40&zoom=8&grid=beat'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t);
      let f = await page.evaluate(facts);
      t.expect(f.grid === 'bar beat' || f.grid === 'beat bar', `beats and bars at 8 s (got ${f.grid})`);
      t.expect(f.marks.length >= 3 && f.marks.every((m) => /^\d+$/.test(m)), `bar numbers (got ${f.marks})`);
      await t.capture('beat');
      await page.mouse.click(5, 5);
      await page.keyboard.press('Backslash');
      await page.waitForFunction(() => document.querySelector('section.stems canvas').dataset.gridDrawn === 'bar');
      f = await page.evaluate(facts);
      t.expect(f.grid === 'bar', `at Fit beats are < 6 px apart: bars only (got ${f.grid})`);
    },
  },
  {
    name: 'st11-stems-touch', url: STEMS('cue=4'), opts: IPAD,
    async fn(page, t) {
      await ready(page, t);
      const touch = await t.touch();
      let f = await page.evaluate(facts);
      const y = f.lanes.y + 60;
      await touch.tap({x: xOf(f, 40.4), y});
      // A tap cues to the nearest beat (spec §4.9).
      await page.waitForFunction(() => window.__stems.session.transport.snapshot.peek().cue === 40.5);
      await touch.drag({x: xOf(f, 17), y}, {x: xOf(f, 47), y}, {holdMs: 450});
      await page.waitForFunction(() => window.__stems.session.transport.snapshot.peek().loop.on);
      const s = await snap(page);
      t.expect(s.loop.a === 16 && s.loop.b === 48, `a long-press drag loops the bars (got ${JSON.stringify(s.loop)})`);
      const before = await view(page);
      await touch.pinch({x: xOf(f, 100), y: y + 200}, {from: 80, to: 240});
      await page.waitForFunction((span) => {
        const r = document.querySelector('section.stems').dataset;
        return Number(r.t1) - Number(r.t0) < span - 1;
      }, before.t1 - before.t0);
      const zoomed = await view(page);
      t.expect(zoomed.t1 - zoomed.t0 < (before.t1 - before.t0) / 2, `a pinch zooms in (${before.t1 - before.t0} → ${zoomed.t1 - zoomed.t0})`);
      f = await page.evaluate(facts);
      await touch.pan({x: f.lanes.x + f.lanes.w / 2, y: y + 200}, {dx: -200, dy: 0});
      await page.waitForFunction((t0) => Number(document.querySelector('section.stems').dataset.t0) > t0 + 1, zoomed.t0);
      const panned = await view(page);
      t.expect(near(panned.t1 - panned.t0, zoomed.t1 - zoomed.t0, 0.5), `two fingers pan without zooming (got ${panned.t1 - panned.t0})`);
    },
  },
];
