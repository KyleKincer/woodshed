// ST6's states: the song strip on its harness (/__harness/strip), a real song session in the
// Stage frame's 56 px slot (rail: under the music; band: above the dock). Every state runs with
// fx-audio=manual. The harness registers the Stage's commands (src/stage/commands.js, ST4), so
// every state lists it in requires until wave 2a merges; the menu state needs ST8a's menus.js.
//   st6-strip-sections        mapped: 8 proportional segments, alternating surfaces, the current one
//                             --now-soft with a 2 px progress fill, 15/600 labels, the 56 px band, axe
//   st6-strip-overflow        32 parts at the 56 px floor: the strip scrolls and keeps the current part in view
//   st6-strip-looping         the loop bracket (--loop), spot diamonds, a marker tick, the cue flag
//   st6-strip-pending         playing: a tap is a quantized jump `→ Verse 2`; tapping it again cancels; it lands
//   st6-strip-unmapped        the overview waveform with marker ticks and "No bar grid · Get bars →"; no "Bar"
//   st6-strip-suggested       suggested sections as dashed blocks, [Keep all] turns them into sections
//   st6-strip-scrub-touch     iPad: a stopped drag scrubs with `Bar 41 · Bridge`; touch-action none / pan-x
//   st6-strip-mouse-loop      a mouse drag across segments loops them; the bracket springs to the edges
//   st6-strip-keyboard        Tab to the slider, ←/→ rove, L loops and Enter plays the focused segment; focus ring
//   st6-strip-stems-viewport  the Stems viewport bracket, dragged to a new window
//   st6-strip-menu            a long-press and a right-click open the section menu (ST8a)
'use strict';

const {checkAxe} = require('../probes/probe-axe.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');

const STRIP = (query = '') => `/__harness/strip?fx-audio=manual${query ? `&${query}` : ''}`;
const REQUIRES = ['src/stage/commands.js'];
const RAIL = {devices: ['laptop'], requires: REQUIRES};
const BAND = {devices: ['ipad'], requires: REQUIRES};

async function ready(page, t) {
  await t.loadPhase('ready');
  await page.evaluate(() => document.fonts.ready);
}

const snap = (page) => page.evaluate(() => {
  const s = window.__strip.session.transport.snapshot.peek();
  return {phase: s.phase, cue: s.cue, loop: s.loop, pendingJump: s.pendingJump, position: window.__strip.session.transport.position()};
});

/** The strip's slider box and the x of time t on it (sections laid out by the strip itself). */
async function geometry(page) {
  return page.evaluate(() => {
    const slider = document.querySelector('.strip-slider');
    const r = slider.getBoundingClientRect();
    const segs = [...document.querySelectorAll('.strip-seg')].map((s) => {
      const b = s.getBoundingClientRect();
      return {x: b.x, w: b.width, label: s.querySelector('.strip-seg-label').textContent};
    });
    return {x: r.x, y: r.y, w: r.width, h: r.height, segs};
  });
}

const centreOf = (seg, y) => ({x: seg.x + seg.w / 2, y});

async function mouseDrag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (to.x - from.x) * i / 10, from.y);
  await page.mouse.up();
}

const styleOf = (page, selector, props) => page.$eval(selector, (el, list) => {
  const cs = getComputedStyle(el);
  return Object.fromEntries(list.map((p) => [p, cs.getPropertyValue(p)]));
}, props);

const tokenColour = (page, name) => page.evaluate((token) => {
  const probe = document.createElement('div');
  probe.style.color = `var(${token})`;
  document.querySelector('.strip').append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}, name);

module.exports = [
  {
    name: 'st6-strip-sections', url: STRIP('cue=20'), opts: {requires: REQUIRES},
    async fn(page, t) {
      await ready(page, t);
      const g = await geometry(page);
      t.expect(Math.round(g.h) === 56 || Math.round(g.h) === 55, `the strip is 56 px tall (got ${g.h})`);
      t.expect(g.segs.length === 8, `eight segments (got ${g.segs.length})`);
      t.expect(JSON.stringify(g.segs.map((s) => s.label)) === JSON.stringify(['Intro', 'Verse', 'Chorus', 'Verse 2', 'Chorus 2', 'Bridge', 'Chorus 3', 'Outro']), `labels (got ${g.segs.map((s) => s.label)})`);
      for (const s of g.segs) t.expect(s.w >= 56 - 0.5 && Math.abs(s.w - g.w / 8) < 1, `equal sections share the width ≥ 56 px (got ${s.w} of ${g.w})`);
      const backgrounds = await page.$$eval('.strip-seg', (els) => els.map((el) => getComputedStyle(el).backgroundColor));
      const [surface, surface2, nowSoft] = [await tokenColour(page, '--surface'), await tokenColour(page, '--surface-2'), await tokenColour(page, '--now-soft')];
      t.expect(backgrounds[1] === nowSoft, `the current segment (Verse) is --now-soft (${backgrounds[1]} vs ${nowSoft})`);
      t.expect(backgrounds[0] === surface && backgrounds[2] === surface && backgrounds[3] === surface2 && backgrounds[5] === surface2, `segments alternate --surface / --surface-2 (${backgrounds})`);
      const label = await styleOf(page, '.strip-seg-label', ['font-size', 'font-weight']);
      t.expect(label['font-size'] === '15px' && label['font-weight'] === '600', `labels 15/600 (got ${JSON.stringify(label)})`);
      const progress = await page.$eval('.strip-seg[data-current] .strip-seg-progress', (el) => {
        const r = el.getBoundingClientRect(), seg = el.parentElement.getBoundingClientRect();
        return {h: r.height, w: r.width, segW: seg.width, bottom: seg.bottom - r.bottom, colour: getComputedStyle(el).backgroundColor};
      });
      t.expect(Math.round(progress.h) === 2 && Math.abs(progress.w - progress.segW * 0.25) < 1 && progress.bottom < 1, `2 px progress fill at 25% (got ${JSON.stringify(progress)})`);
      t.expect(progress.colour === await tokenColour(page, '--now'), `progress in --now (got ${progress.colour})`);
      const playhead = await page.$eval('.strip-playhead', (el) => ({w: el.getBoundingClientRect().width, colour: getComputedStyle(el).backgroundColor}));
      t.expect(Math.round(playhead.w) === 2 && playhead.colour === await tokenColour(page, '--now'), `2 px --now playhead (got ${JSON.stringify(playhead)})`);
      const nav = await page.$eval('nav.strip', (el) => ({label: el.getAttribute('aria-label'), scope: el.dataset.scope}));
      t.expect(nav.label === 'Sections' && nav.scope === 'stage.strip', `Sections nav in the stage.strip scope (got ${JSON.stringify(nav)})`);
      const text = await page.$eval('[role=slider]', (el) => el.getAttribute('aria-valuetext'));
      t.expect(text === 'Bar 11, beat 1, Verse', `aria-valuetext at the cue (got ${text})`);
      const problems = await checkAxe(page, {include: ['nav.strip']});
      t.expect(!problems.length, problems.join('; '));
    },
  },
  {
    name: 'st6-strip-overflow', url: STRIP('song=many'), opts: {themes: ['dark'], requires: REQUIRES},
    async fn(page, t) {
      await ready(page, t);
      const g = await geometry(page);
      t.expect(g.segs.length === 32, `32 parts (got ${g.segs.length})`);
      for (const s of g.segs) t.expect(Math.abs(s.w - 56) < 0.5, `each part sits at the 56 px floor (got ${s.w})`);
      const scroll = await page.$eval('.strip-track', (el) => ({sw: el.scrollWidth, cw: el.clientWidth}));
      t.expect(scroll.sw > scroll.cw + 100, `the strip scrolls (scrollWidth ${scroll.sw} > ${scroll.cw})`);
      await page.evaluate(() => window.__strip.session.transport.cue(124));
      await page.waitForFunction(() => {
        const track = document.querySelector('.strip-track'), cur = document.querySelector('.strip-seg[data-current]');
        if (!cur) return false;
        const a = track.getBoundingClientRect(), b = cur.getBoundingClientRect();
        return b.left >= a.left - 1 && b.right <= a.right + 1;
      }, null, {timeout: 3000});
      const current = await page.$eval('.strip-seg[data-current] .strip-seg-label', (el) => el.textContent);
      t.expect(current === 'Part 32', `the last part is current and in view (got ${current})`);
    },
  },
  {
    name: 'st6-strip-looping', url: STRIP('scenario=looping'), opts: {requires: REQUIRES},
    async fn(page, t) {
      await ready(page, t);
      const g = await geometry(page);
      const loop = await page.$eval('.strip-loop', (el) => {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        return {x: r.x, w: r.width, edge: cs.borderLeftColor, edgeW: cs.borderLeftWidth};
      });
      const chorus = g.segs[2];
      t.expect(Math.abs(loop.x - chorus.x) < 1 && Math.abs(loop.w - chorus.w) < 1, `the bracket spans the Chorus (${JSON.stringify(loop)} vs ${JSON.stringify(chorus)})`);
      t.expect(loop.edge === await tokenColour(page, '--loop') && loop.edgeW === '3px', `3 px --loop edges (got ${JSON.stringify(loop)})`);
      const spots = await page.$$eval('.strip-spot', (els) => els.map((el) => ({id: el.dataset.id, colour: getComputedStyle(el).backgroundColor})));
      t.expect(spots.length === 2 && spots.every((s) => s.colour), `two spot diamonds (got ${JSON.stringify(spots)})`);
      const ticks = await page.$$eval('.strip-tick', (els) => els.map((el) => el.dataset.id));
      t.expect(JSON.stringify(ticks) === '["marker-flam"]', `the marker tick on a mapped song (got ${ticks})`);
      const cue = await page.$eval('.strip-cue', (el) => getComputedStyle(el).borderTopColor);
      t.expect(cue === await tokenColour(page, '--accent'), `the cue flag in --accent (got ${cue})`);
    },
  },
  {
    name: 'st6-strip-pending', url: STRIP('cue=16'), opts: RAIL,
    async fn(page, t) {
      await ready(page, t);
      await page.evaluate(() => window.__strip.session.transport.play());
      await t.transportPhase('playing');
      await t.advance(600);
      const g = await geometry(page);
      const verse2 = centreOf(g.segs[3], g.y + g.h / 2);
      await page.mouse.click(verse2.x, verse2.y);
      let s = await snap(page);
      t.expect(s.pendingJump && s.pendingJump.t === 48, `a quantized jump is pending (got ${JSON.stringify(s.pendingJump)})`);
      const label = await page.$eval('.strip-seg[data-pending] .strip-seg-label', (el) => el.textContent);
      t.expect(label === '→ Verse 2', `the target reads → Verse 2 (got ${label})`);
      await t.capture('pending');
      await page.waitForTimeout(350);
      await page.mouse.click(verse2.x + 10, verse2.y);
      s = await snap(page);
      t.expect(s.pendingJump === null, `tapping it again cancels (got ${JSON.stringify(s.pendingJump)})`);
      await page.waitForTimeout(350);
      await page.mouse.click(verse2.x, verse2.y);
      await t.advance(2200);
      s = await snap(page);
      t.expect(s.pendingJump === null && s.position >= 48 && s.position < 50.5, `the jump landed on the downbeat (got ${JSON.stringify(s)})`);
      t.expect(s.cue === 16, `a jump never moves the cue (got ${s.cue})`);
    },
  },
  {
    name: 'st6-strip-unmapped', url: STRIP('mapped=0&scenario=markers'), opts: {requires: REQUIRES},
    async fn(page, t) {
      await ready(page, t);
      await t.peaksReady();
      const mode = await page.$eval('nav.strip', (el) => el.dataset.mode);
      t.expect(mode === 'wave', `the waveform (got ${mode})`);
      const ticks = await page.$$eval('.strip-tick', (els) => els.length);
      t.expect(ticks === 3, `three marker ticks (got ${ticks})`);
      const tray = await page.$eval('.strip-tray', (el) => el.textContent.replace(/\s+/g, ' ').trim());
      t.expect(/^No bar grid\s*·\s*Get bars$/.test(tray), `the chip reads "No bar grid · Get bars" (got ${tray})`);
      const strings = await page.$eval('nav.strip', (nav) => [nav.textContent, ...[...nav.querySelectorAll('*'), nav].flatMap((el) =>
        ['aria-label', 'aria-valuetext', 'title'].map((a) => el.getAttribute(a)).filter(Boolean))].map((s) => s.replaceAll('No bar grid', '')));
      t.expect(!strings.some((s) => /Bar|bar /.test(s)), `no "Bar" for an unmapped song (got ${strings.filter((s) => /Bar|bar /.test(s))})`);
      await page.getByRole('button', {name: 'Get bars'}).click();
      const sheets = await page.evaluate(() => window.__strip.sheets);
      t.expect(sheets.at(-1) === 'getBars', `Get bars opens the Get bars sheet (got ${sheets})`);
    },
  },
  {
    name: 'st6-strip-suggested', url: STRIP('song=plain&scenario=suggest'), opts: {requires: REQUIRES},
    async fn(page, t) {
      await ready(page, t);
      const blocks = await page.$$eval('.strip-suggest-block', (els) => els.map((el) => ({label: el.textContent, style: getComputedStyle(el).borderTopStyle})));
      t.expect(blocks.length === 6 && blocks.every((b) => b.style === 'dashed'), `six dashed suggestion blocks (got ${JSON.stringify(blocks)})`);
      await t.capture('suggested');
      await page.getByRole('button', {name: 'Keep all'}).click();
      await page.waitForSelector('nav.strip[data-mode=sections]', {timeout: 3000});
      const labels = await page.$$eval('.strip-seg-label', (els) => els.map((el) => el.textContent));
      t.expect(JSON.stringify(labels) === JSON.stringify(['Intro', 'Verse', 'Chorus', 'Bridge', 'Chorus 2', 'Outro']), `Keep all makes them sections (got ${labels})`);
    },
  },
  {
    name: 'st6-strip-scrub-touch', url: STRIP(), opts: {...BAND, capture: false},
    async fn(page, t) {
      await ready(page, t);
      const touchAction = () => page.$eval('.strip-slider', (el) => getComputedStyle(el).touchAction);
      t.expect(await touchAction() === 'none', `stopped: touch-action none (got ${await touchAction()})`);
      const g = await geometry(page);
      const bridge = g.segs[5];
      const from = {x: bridge.x - 30, y: g.y + g.h / 2}, to = {x: bridge.x + bridge.w * 0.06, y: g.y + g.h / 2};
      const touch = await t.touch();
      await touch.start([{...from, id: 0}]);
      for (let i = 1; i <= 8; i++) await touch.move([{x: from.x + (to.x - from.x) * i / 8, y: from.y, id: 0}]);
      await page.waitForFunction(() => document.querySelector('.strip-scrub')?.textContent === 'Bar 41 · Bridge', null, {timeout: 2000}).catch(() => {});
      const label = await page.$eval('.strip-scrub', (el) => ({hidden: el.hidden, text: el.textContent}));
      t.expect(!label.hidden && label.text === 'Bar 41 · Bridge', `the scrub label (got ${JSON.stringify(label)})`);
      await t.capture('scrub');
      await touch.end();
      const s = await snap(page);
      t.expect(s.cue === 80, `release cues the bar (got ${s.cue})`);
      const scrubs = await page.evaluate(() => window.__strip.scrubs.length);
      t.expect(scrubs > 0, 'onScrub reveals the scrub point on the music');
      await page.evaluate(() => window.__strip.session.transport.play());
      await t.transportPhase('playing');
      t.expect(await touchAction() === 'pan-x', `playing: touch-action pan-x (got ${await touchAction()})`);
      // While playing a tap is a quantized jump (touch too).
      const g2 = await geometry(page);
      await touch.tap(centreOf(g2.segs[6], g2.y + g2.h / 2));
      const s2 = await snap(page);
      t.expect(s2.pendingJump && s2.pendingJump.t === 96, `a touch tap while playing is a quantized jump (got ${JSON.stringify(s2.pendingJump)})`);
    },
  },
  {
    name: 'st6-strip-mouse-loop', url: STRIP(), opts: {...RAIL, capture: false},
    async fn(page, t) {
      await ready(page, t);
      const g = await geometry(page);
      const y = g.y + g.h / 2;
      await mouseDrag(page, {x: g.segs[1].x + 20, y}, {x: g.segs[2].x + g.segs[2].w - 30, y});
      const s = await snap(page);
      t.expect(s.loop.on && s.loop.a === 16 && s.loop.b === 48, `Verse + Chorus loop (got ${JSON.stringify(s.loop)})`);
      t.expect(await page.$eval('.strip-loop', (el) => el.hasAttribute('data-spring')), 'the bracket springs after the drag');
      await page.waitForFunction(() => !document.querySelector('.strip-loop').hasAttribute('data-spring'), null, {timeout: 2000});
      const loop = await page.$eval('.strip-loop', (el) => { const r = el.getBoundingClientRect(); return {x: r.x, w: r.width}; });
      t.expect(Math.abs(loop.x - g.segs[1].x) < 1 && Math.abs(loop.x + loop.w - (g.segs[2].x + g.segs[2].w)) < 1, `the bracket settles on the segment edges (${JSON.stringify(loop)})`);
      // A click inside the strip while stopped cues the segment start.
      await page.waitForTimeout(350);
      await page.mouse.click(g.segs[4].x + 30, y);
      t.expect((await snap(page)).cue === 64, 'a click cues the Chorus 2 start');
      // Double-click loops a section.
      await page.waitForTimeout(350);
      await page.mouse.dblclick(g.segs[5].x + 30, y);
      const s2 = await snap(page);
      t.expect(s2.loop.on && s2.loop.a === 80 && s2.loop.b === 96, `double-click loops the Bridge (got ${JSON.stringify(s2.loop)})`);
    },
  },
  {
    name: 'st6-strip-keyboard', url: STRIP('cue=23'), opts: {...RAIL, themes: ['dark']},
    async fn(page, t) {
      await ready(page, t);
      await page.focus('[role=slider]');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('role'));
      t.expect(focused === 'slider', `the slider has keyboard focus (got ${focused})`);
      await page.keyboard.press('ArrowRight');
      const text = await page.$eval('[role=slider]', (el) => el.getAttribute('aria-valuetext'));
      t.expect(text === 'Bar 17, beat 1, Chorus', `→ moves to the Chorus (got ${text})`);
      const ring = await page.$eval('.strip-focus', (el) => ({v: getComputedStyle(el).visibility, w: getComputedStyle(el).borderTopWidth}));
      t.expect(ring.v === 'visible' && ring.w === '3px', `the focused segment shows the ring (got ${JSON.stringify(ring)})`);
      await t.capture('focused');
      await page.keyboard.press('KeyL');
      let s = await snap(page);
      t.expect(s.loop.on && s.loop.a === 32 && s.loop.b === 48, `L loops the focused segment (got ${JSON.stringify(s.loop)})`);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await t.transportPhase('playing');
      s = await snap(page);
      t.expect(Math.abs(s.position - 32) < 0.5 || Math.abs(s.position - 48) < 0.5, `Enter plays from the focused segment (got ${s.position})`);
      const problems = await walkFocus(page, {stops: 4});
      t.expect(!problems.length, problems.join('; '));
    },
  },
  {
    name: 'st6-strip-stems-viewport', url: STRIP('scenario=stems'), opts: {...RAIL, themes: ['dark']},
    async fn(page, t) {
      await ready(page, t);
      const g = await geometry(page);
      const view = await page.$eval('.strip-viewport', (el) => { const r = el.getBoundingClientRect(); return {x: r.x, w: r.width, hidden: el.hidden}; });
      const want = g.segs[2].x;   // 32 s: the Chorus start
      t.expect(!view.hidden && Math.abs(view.x - want) < 1, `the viewport bracket marks 32–56 s (${JSON.stringify(view)})`);
      await mouseDrag(page, {x: view.x + view.w / 2, y: g.y + g.h / 2}, {x: view.x + view.w / 2 + g.segs[0].w, y: g.y + g.h / 2});
      const windows = await page.evaluate(() => window.__strip.windows);
      const last = windows.at(-1);
      t.expect(last && Math.abs(last.t0 - 48) < 0.3 && Math.abs(last.t1 - 72) < 0.3, `dragging moves the window by one section (got ${JSON.stringify(last)})`);
      const s = await snap(page);
      t.expect(!s.loop.on && s.cue === 40, `dragging the bracket neither loops nor cues (got ${JSON.stringify(s)})`);
    },
  },
  {
    name: 'st6-strip-menu', url: STRIP(), opts: {devices: ['ipad'], capture: false, requires: [...REQUIRES, 'src/stage/menus.js']},
    async fn(page, t) {
      await ready(page, t);
      const g = await geometry(page);
      const touch = await t.touch();
      await touch.longPress(centreOf(g.segs[2], g.y + g.h / 2), {ms: 500});
      await page.waitForSelector('[role=menu]', {timeout: 3000});
      const names = await page.$$eval('[role=menu] [role^=menuitem]', (els) => els.map((el) => el.textContent.trim()));
      t.expect(names.some((n) => /Loop this section/.test(n)) && names.some((n) => /Rename/.test(n)), `the section menu (got ${names})`);
    },
  },
];
