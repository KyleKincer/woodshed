// ST2's states: the waveform harness (/__harness/wave) end to end in Chromium.
//   st2-wave            captures the harness (desk tokens: paper / night) once peaks are drawn
//   st2-wave-stage      the same on the Stage set (data-place=stage, dark)
//   st2-handle-geometry handle hit areas are 44 px × row height (fine and coarse pointers)
//   st2-loop-mouse      mouse: drag an edge (bar snap + the 120 ms spring), Alt-drag (beats), Shift-drag (free),
//                       drag inside the band (move); a click inside the band changes nothing
//   st2-loop-touch      touch: drag an edge while stopped; while playing a touch does not drag it
//   st2-pinch           one CDP two-point pinch: live CSS transform, one commit on release, clamped at 200%
//   st2-press-touch     touch tap, double-tap, 350 ms long-press → menu, long-press drag
//   st2-press-mouse     mouse click, drag at once, right-click and Shift+F10 → menu
'use strict';

const WAVE = '/__harness/wave';

async function peaks(page, t) {
  for (const id of ['stems-canvas', 'cell-1', 'cell-4', 'strip']) {
    await t.waitAttr(`[data-testid="${id}"]`, 'data-peaks-ready', 'true');
  }
}

/** Centre of an element, in client px. */
async function centre(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} is not visible`);
  return {x: box.x + box.width / 2, y: box.y + box.height / 2, box};
}

/** The x of time t on the stems panel (16 s across the panel's width). */
async function timeX(page, seconds) {
  const {box} = await centre(page, '[data-testid="stems-panel"]');
  return box.x + (seconds / 16) * box.width;
}

const loopOf = page => page.evaluate(() => {
  const host = document.querySelector('[data-testid="stems-panel"]');
  return {a: Number(host.dataset.loopA), b: Number(host.dataset.loopB), phase: document.getElementById('st2-loop-phase').textContent};
});

/** The visible handle for an edge in the first row. */
const handle = (page, edge) => page.locator(`.loop-handle[data-edge="${edge}"]:not([hidden])`).first();

async function dragMouse(page, from, to, {modifier} = {}) {
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8);
  await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
}

const gestures = page => page.$$eval('[data-testid="press-log"] li', items => items.map(li => li.dataset.gesture));

module.exports = [
  {name: 'st2-wave', url: WAVE, fn: peaks},
  {name: 'st2-wave-stage', url: `${WAVE}?place=stage`, fn: peaks, opts: {themes: ['dark']}},
  {
    name: 'st2-handle-geometry', url: WAVE, opts: {themes: ['dark'], capture: false},
    async fn(page, t) {
      await peaks(page, t);
      const boxes = await page.$$eval('.loop-handle:not([hidden])', els => els.map(el => {
        const r = el.getBoundingClientRect(), grip = el.querySelector('.loop-handle-grip').getBoundingClientRect(), edge = el.querySelector('.loop-handle-edge').getBoundingClientRect();
        return {w: r.width, h: r.height, grip: [Math.round(grip.width), Math.round(grip.height)], edge: Math.round(edge.width), edgeCentre: Math.round(edge.left + edge.width / 2 - r.left)};
      }));
      t.expect(boxes.length === 8, `two handles in each of the 4 rows (got ${boxes.length})`);
      for (const b of boxes) {
        t.expect(Math.round(b.w) === 44, `hit area is 44 px wide (got ${b.w})`);
        t.expect(Math.round(b.h) === 72, `hit area is the row height, 72 px (got ${b.h})`);
        t.expect(b.grip[0] === 20 && b.grip[1] === 20, `grip dot is 20 px (got ${b.grip})`);
        t.expect(b.edge === 3, `edge is 3 px (got ${b.edge})`);
        t.expect(Math.abs(b.edgeCentre - 22) <= 1, `edge centred in the hit area (got ${b.edgeCentre})`);
      }
      const fill = await page.$eval('.loop-band', el => getComputedStyle(el).backgroundColor);
      t.expect(fill && fill !== 'rgba(0, 0, 0, 0)', `band painted with --loop-fill (got ${fill})`);
      await page.evaluate(() => window.__harness.mounted.setPlaying(true));
      const opacity = await page.$eval('.loop-handle:not([hidden])', el => getComputedStyle(el).opacity);
      t.expect(opacity === '0.5', `handles at 50% while playing (got ${opacity})`);
    },
  },
  {
    name: 'st2-loop-mouse', url: WAVE, opts: {devices: ['laptop']},
    async fn(page, t) {
      await peaks(page, t);
      let start = await loopOf(page);
      t.expect(start.a === 2 && start.b === 6, `initial loop 2–6 s (got ${JSON.stringify(start)})`);
      // Drag the end from 6 s to about 7.3 s: bar snap → 8 s, then the spring.
      const b = await centre(page, '.loop-handle[data-edge="b"]:not([hidden])');
      await dragMouse(page, b, {x: await timeX(page, 7.3), y: b.y});
      let loop = await loopOf(page);
      t.expect(loop.a === 2 && loop.b === 8 && loop.phase === 'Last edit: commit', `bar-snapped end (got ${JSON.stringify(loop)})`);
      t.expect(await page.$eval('.loop-handles', el => el.hasAttribute('data-spring')), 'the spring runs after the drag');
      await page.waitForFunction(() => !document.querySelector('.loop-handles').hasAttribute('data-spring'), null, {timeout: 2000});
      const settled = await handle(page, 'b').boundingBox();
      const want = await timeX(page, 8);
      t.expect(Math.abs(settled.x + settled.width / 2 - want) <= 1.5, `the handle settles on the bar line (${settled.x + settled.width / 2} vs ${want})`);
      // Alt-drag the start: beat snap (0.5 s).
      const a = await centre(page, '.loop-handle[data-edge="a"]:not([hidden])');
      await dragMouse(page, a, {x: await timeX(page, 2.8), y: a.y}, {modifier: 'Alt'});
      loop = await loopOf(page);
      t.expect(loop.a === 3 && loop.b === 8, `Alt snaps to beats (got ${JSON.stringify(loop)})`);
      // Shift-drag: no snapping.
      const a2 = await centre(page, '.loop-handle[data-edge="a"]:not([hidden])');
      await dragMouse(page, a2, {x: await timeX(page, 3.37), y: a2.y}, {modifier: 'Shift'});
      loop = await loopOf(page);
      t.expect(Math.abs(loop.a - 3.37) < 0.05 && loop.b === 8, `Shift does not snap (got ${JSON.stringify(loop)})`);
      // Drag inside the band: the loop moves and keeps its bar alignment.
      const inside = {x: await timeX(page, 5), y: a2.y};
      await dragMouse(page, inside, {x: await timeX(page, 7.1), y: a2.y});
      loop = await loopOf(page);
      t.expect(loop.a === 6 && loop.b === 10, `moved by two bars (got ${JSON.stringify(loop)})`);
      // A click inside the band is left to the surface: nothing changes.
      await page.mouse.click(await timeX(page, 8), a2.y);
      const after = await loopOf(page);
      t.expect(after.a === 6 && after.b === 10, `a click does not edit (got ${JSON.stringify(after)})`);
    },
  },
  {
    name: 'st2-loop-touch', url: WAVE, opts: {devices: ['ipad'], capture: false},
    async fn(page, t) {
      await peaks(page, t);
      const touch = await t.touch();
      const b = await centre(page, '.loop-handle[data-edge="b"]:not([hidden])');
      await touch.drag(b, {x: await timeX(page, 9.4), y: b.y}, {steps: 10});
      let loop = await loopOf(page);
      t.expect(loop.a === 2 && loop.b === 10, `touch drag resizes with bar snap (got ${JSON.stringify(loop)})`);
      await page.evaluate(() => window.__harness.mounted.setPlaying(true));
      const b2 = await centre(page, '.loop-handle[data-edge="b"]:not([hidden])');
      await touch.drag(b2, {x: await timeX(page, 13), y: b2.y}, {steps: 10});
      loop = await loopOf(page);
      t.expect(loop.b === 10, `while playing a touch does not drag the handle (got ${JSON.stringify(loop)})`);
    },
  },
  {
    name: 'st2-pinch', url: WAVE, opts: {devices: ['ipad']},
    async fn(page, t) {
      await peaks(page, t);
      await page.locator('[data-testid="pinch-pad"]').scrollIntoViewIfNeeded();
      const touch = await t.touch();
      const pad = await centre(page, '[data-testid="pinch-pad"]');
      // Watch the live transform during the gesture, and count commits.
      await page.evaluate(() => {
        const pad = document.querySelector('[data-testid="pinch-pad"]'), content = pad.firstElementChild;
        window.__st2 = {transforms: [], commits: 0};
        new MutationObserver(() => window.__st2.transforms.push(content.style.transform)).observe(content, {attributes: true, attributeFilter: ['style']});
        new MutationObserver(() => window.__st2.commits++).observe(pad, {attributes: true, attributeFilter: ['data-scale']});
      });
      await touch.pinch(pad, {from: 100, to: 150, steps: 10});
      const after = await page.evaluate(() => ({scale: Number(document.querySelector('[data-testid="pinch-pad"]').dataset.scale), ...window.__st2}));
      t.expect(Math.abs(after.scale - 1.8) < 0.02, `120% × 1.5 = 180% (got ${after.scale})`);
      t.expect(after.commits === 1, `one commit on release (got ${after.commits})`);
      t.expect(after.transforms.some(v => /scale\(1\.[1-9]/.test(v)), `a live CSS transform while pinching (${after.transforms.slice(0, 3)})`);
      t.expect(after.transforms.at(-1) === '', `the transform is cleared on release (${after.transforms.at(-1)})`);
      const label = await page.locator('[data-testid="pinch-content"]').textContent();
      t.expect(label.trim() === 'Chart 180%', `label updated (got ${label})`);
      // A second pinch clamps at 200%.
      await touch.pinch(pad, {from: 80, to: 200, steps: 10});
      const clamped = await page.evaluate(() => Number(document.querySelector('[data-testid="pinch-pad"]').dataset.scale));
      t.expect(clamped === 2, `clamped at 200% (got ${clamped})`);
    },
  },
  {
    name: 'st2-press-touch', url: WAVE, opts: {devices: ['ipad'], capture: false},
    async fn(page, t) {
      await peaks(page, t);
      await page.locator('[data-testid="press-pad"]').scrollIntoViewIfNeeded();
      const touch = await t.touch();
      const pad = await centre(page, '[data-testid="press-pad"]');
      await touch.tap(pad);
      await page.waitForTimeout(400);   // past the double-tap window
      await touch.doubleTap(pad, {gapMs: 80});
      await page.waitForTimeout(400);
      await touch.longPress(pad, {ms: 600});
      await page.waitForTimeout(100);
      await touch.drag(pad, {x: pad.x + 120, y: pad.y + 10}, {holdMs: 500, steps: 8});
      // Consecutive long-drag moves collapse to one entry.
      const seen = (await gestures(page)).filter((g, i, list) => !(g === 'longDrag' && list[i - 1] === 'longDrag'));
      const want = ['tap', 'tap', 'double', 'longStart', 'longEnd', 'menu', 'longStart', 'longDrag', 'longEnd'];
      t.expect(JSON.stringify(seen) === JSON.stringify(want), `touch gestures in order (got ${JSON.stringify(seen)})`);
      const all = await page.$$eval('[data-testid="press-log"] li', items => items.map(li => li.textContent));
      t.expect(all.some(s => /^longEnd · touch · dragged=true/.test(s)), `the long drag ends dragged (got ${JSON.stringify(all)})`);
      t.expect(all.some(s => /^menu · touch/.test(s)), `release without a drag opens the menu (got ${JSON.stringify(all)})`);
      t.expect(all.some(s => /^double · touch/.test(s)), `double-tap (got ${JSON.stringify(all)})`);
    },
  },
  {
    name: 'st2-press-mouse', url: WAVE, opts: {devices: ['laptop'], capture: false},
    async fn(page, t) {
      await peaks(page, t);
      await page.locator('[data-testid="press-pad"]').scrollIntoViewIfNeeded();
      const pad = await centre(page, '[data-testid="press-pad"]');
      await page.mouse.click(pad.x, pad.y);
      await page.waitForTimeout(400);
      await dragMouse(page, pad, {x: pad.x + 100, y: pad.y});
      await page.mouse.click(pad.x, pad.y, {button: 'right'});
      await page.locator('[data-testid="press-pad"]').focus();
      await page.keyboard.press('Shift+F10');
      const seen = await gestures(page);
      t.expect(JSON.stringify(seen) === JSON.stringify(['tap', 'dragStart', 'dragEnd', 'menu', 'menu']), `mouse gestures (got ${JSON.stringify(seen)})`);
      const texts = await page.$$eval('[data-testid="press-log"] li', items => items.map(li => li.textContent));
      t.expect(/keyboard/.test(texts.at(-1)), `Shift+F10 opens the menu from the keyboard (got ${texts.at(-1)})`);
    },
  },
];
