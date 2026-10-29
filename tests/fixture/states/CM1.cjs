// CM1's states: the first Stage coach marks (src/stage/coach.js; architecture §2.19, spec §6.6
// item 5) on the real app over the fixture database. The seed's account has finished the marks
// (onboarding.coach 15), so each state first resets the bitmask through window.fixture.update,
// then starts the coach on the mounted Stage: `startStageCoach` returns the running coach when the
// Stage already started one (I3a wires it into stage.js), so these states hold before and after.
//   cm1-coach-play      step 1 on Play: "Space or ▶ plays from your loop. Enter starts again with a
//                       count-in.", `1 of 3 · Skip`, in the top layer left of the rail level with Play's
//                       row (laptop) and above Play in the dock (iPad), covering no control, focus untouched; axe
//   cm1-coach-tour      Space plays (no mark while playing), Stop shows step 2 on the strip; a tap on a
//                       section shows step 3 on Mix ("Mine OUT …": the seed plays drums and bass); Mix
//                       takes the part out: no mark,
//                       onboarding.coach 7 in the database
//   cm1-coach-skip      Skip ends the tour in one write (7); after a reload nothing shows
//   cm1-coach-bars      an unmapped song (quiet): "No bar grid yet, so times are in seconds. [Get bars]",
//                       no counter, `Not now`, above the strip's Get bars tray; [Get bars] opens the
//                       Get bars sheet and writes 15; axe
'use strict';

const {checkAxe} = require('../probes/probe-axe.cjs');

const PEERS = ['src/stage/hud.js', 'src/stage/controls.js', 'src/stage/strip.js', 'src/stage/sheets/get-bars.js'];
const NOW = 'fx-now=2026-10-28T12:00:00Z';
const app = (song) => `/s/${song}?fx-reset=1&fx-audio=manual&${NOW}`;
const OPTS = {requires: PEERS, ready: 'stage', themes: ['dark']};
const MARK = '.ui-coachmark.stage-coach';

/** Resets the account's coach bitmask, waits for the Stage, then starts (or finds) its coach. */
async function begin(page, t, coach = 0) {
  await t.loadPhase('ready');
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((value) => window.fixture.update((db) => { db.settings.onboarding = {...db.settings.onboarding, coach: value}; }), coach);
  await page.waitForFunction((value) => window.__woodshed.store.account.value?.onboarding?.coach === value, coach, {timeout: 5000});
  await page.evaluate(async () => {
    const [{startStageCoach}, {registry}] = await Promise.all([import('/src/stage/coach.js'), import('/src/app/commands.js')]);
    const ctx = registry.context();
    window.__cm1 = startStageCoach({stage: ctx.stage, session: ctx.session});
  });
}

/** The open coach mark: {step, body, counter, skip, box, anchor} (null when none is open). */
const openMark = (page) => page.evaluate((sel) => {
  const el = [...document.querySelectorAll(sel)].find((m) => m.matches(':popover-open') || m.hasAttribute('data-layer-fallback'));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const step = el.querySelector('.ui-coachmark-step');
  const skip = el.querySelector('.ui-coachmark-skip');
  return {
    step: el.dataset.coachStep,
    body: el.querySelector('.ui-coachmark-body').textContent.replace(/\s+/g, ' ').trim(),
    strong: [...el.querySelectorAll('.ui-coachmark-body strong')].map((s) => s.textContent),
    counter: step.hidden ? '' : step.textContent,
    skip: skip.hidden ? '' : skip.textContent,
    box: {x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom},
  };
}, MARK);

const waitMark = (page, step) => page.waitForFunction(({sel, id}) => [...document.querySelectorAll(sel)]
  .some((m) => m.dataset.coachStep === id && m.matches(':popover-open')), {sel: MARK, id: step}, {timeout: 5000});
const noMark = (page) => page.waitForFunction((sel) => ![...document.querySelectorAll(sel)].some((m) => m.matches(':popover-open')), MARK, {timeout: 5000});
const stored = (page) => page.evaluate(() => window.fixture.db().settings?.onboarding?.coach ?? null);
const waitStored = (page, value) => page.waitForFunction((v) => window.fixture.db().settings?.onboarding?.coach === v, value, {timeout: 5000});
const boxOf = (page, selector) => page.$eval(selector, (el) => {
  const r = el.getBoundingClientRect();
  return {x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom};
});
/** The control cells the open mark covers (it must cover none). */
const covered = (page) => page.evaluate((sel) => {
  const mark = [...document.querySelectorAll(sel)].find((m) => m.matches(':popover-open'));
  if (!mark) return [];
  const a = mark.getBoundingClientRect();
  return [...document.querySelectorAll('.stage-controls .ctl')].filter((c) => {
    const b = c.getBoundingClientRect();
    return b.width > 0 && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  }).map((c) => c.dataset.ctl);
}, MARK);
/** The gap between two boxes (0 when they touch or overlap). */
const gap = (a, b) => Math.max(0, Math.max(a.x, b.x) - Math.min(a.right, b.right), Math.max(a.y, b.y) - Math.min(a.bottom, b.bottom));

module.exports = [
  {
    name: 'cm1-coach-play',
    url: app('glasshouse'),
    opts: OPTS,
    async fn(page, t) {
      await begin(page, t);
      await waitMark(page, 'play');
      const m = await openMark(page);
      t.expect(m.body === 'Space or ▶ plays from your loop. Enter starts again with a count-in.', `step 1 copy (${m.body})`);
      t.expect(JSON.stringify(m.strong) === '["Space","Enter"]', `bold keys (${m.strong})`);
      t.expect(m.counter === '1 of 3' && m.skip === 'Skip', `"1 of 3 · Skip" (${m.counter} · ${m.skip})`);
      // Left of the rail level with Play's row (from Again), above Play in the dock; it covers no control.
      const near = await boxOf(page, t.device === 'laptop' ? '.ctl[data-ctl="again"]' : '.ctl[data-ctl="play"]');
      t.expect(gap(m.box, near) <= 16, `anchored by Play (gap ${gap(m.box, near)})`);
      const side = t.device === 'laptop' ? m.box.right <= near.x + 1 && m.box.y < near.bottom : m.box.bottom <= near.y + 1;
      t.expect(side, `beside the controls (${JSON.stringify({mark: m.box, near})})`);
      const over = await covered(page);
      t.expect(!over.length, `covers no control (${over})`);
      t.expect(m.box.x >= 0 && m.box.y >= 0 && m.box.right <= page.viewportSize().width && m.box.bottom <= page.viewportSize().height, `inside the viewport (${JSON.stringify(m.box)})`);
      const focus = await page.evaluate((sel) => !!document.activeElement?.closest(sel), MARK);
      t.expect(!focus, 'the mark takes no focus');
      const layer = await page.$eval(MARK, (el) => getComputedStyle(el).zIndex);
      t.expect(layer === '70' || layer === 'auto', `--z-coachmark or the top layer (${layer})`);
      const problems = await checkAxe(page, {include: [MARK]});
      t.expect(!problems.length, problems.join('; '));
    },
  },
  {
    name: 'cm1-coach-tour',
    url: app('glasshouse'),
    opts: {...OPTS, devices: ['laptop']},
    async fn(page, t) {
      await begin(page, t);
      await waitMark(page, 'play');
      await page.keyboard.press('Space');
      await t.transportPhase('playing');
      await noMark(page);
      await waitStored(page, 1);
      await t.advance(500);
      t.expect(!(await openMark(page)), 'no mark while playing');
      await page.keyboard.press('Space');
      await t.transportPhase('stopped');
      await waitMark(page, 'strip');
      const strip = await openMark(page);
      t.expect(strip.body === 'Tap a section to jump there. Double-tap to loop it.' && strip.counter === '2 of 3', `step 2 (${JSON.stringify(strip)})`);
      const stripBox = await boxOf(page, '.stage-strip');
      t.expect(gap(strip.box, stripBox) <= 16, `step 2 next to the strip (gap ${gap(strip.box, stripBox)})`);
      await t.capture('strip');
      const seg = await page.$$eval('.strip-seg', (els) => els.map((s) => {
        const r = s.getBoundingClientRect();
        return {x: r.x + r.width / 2, y: r.y + r.height / 2};
      }));
      await page.mouse.click(seg[2].x, seg[2].y);
      await waitMark(page, 'mix');
      await waitStored(page, 3);
      const mix = await openMark(page);
      // The part is named as the Mix control names it: the seed's profile plays drums and bass, so `Mine`.
      const mine = await page.evaluate(() => window.__woodshed.activeSession().transport.snapshot.mix.mine);
      const part = mine.length === 1 ? 'Drums' : 'Mine';
      t.expect(JSON.stringify(mine) === '["drums","bass"]', `the seed's part (${mine})`);
      t.expect(mix.body === `${part} OUT takes your part out of the mix. You play it.` && mix.counter === '3 of 3', `step 3 (${JSON.stringify(mix)})`);
      t.expect(JSON.stringify(mix.strong) === `["${part} OUT"]`, `bold ${part} OUT (${mix.strong})`);
      const loopBox = await boxOf(page, '.ctl[data-ctl="loop"]');
      t.expect(gap(mix.box, loopBox) <= 16 && mix.box.right <= loopBox.x + 1, `step 3 left of the rail, level with Mix's row (gap ${gap(mix.box, loopBox)})`);
      const over = await covered(page);
      t.expect(!over.length, `step 3 covers no control (${over})`);
      await t.capture('mix');
      await page.locator('.ctl-mix-main').click();
      await noMark(page);
      await waitStored(page, 7);
    },
  },
  {
    name: 'cm1-coach-skip',
    url: app('glasshouse'),
    opts: {...OPTS, devices: ['laptop'], capture: false},
    async fn(page, t) {
      await begin(page, t);
      await waitMark(page, 'play');
      await page.locator(`${MARK} .ui-coachmark-skip`).click();
      await noMark(page);
      await waitStored(page, 7);
      await page.reload();
      await t.ready('stage');
      await t.loadPhase('ready');
      await page.evaluate(async () => {
        const [{startStageCoach}, {registry}] = await Promise.all([import('/src/stage/coach.js'), import('/src/app/commands.js')]);
        const ctx = registry.context();
        window.__cm1 = startStageCoach({stage: ctx.stage, session: ctx.session});
      });
      await page.waitForTimeout(300);
      t.expect(!(await openMark(page)), 'the tour stays finished after a reload');
      t.expect((await stored(page)) === 7, 'onboarding.coach 7');
    },
  },
  {
    name: 'cm1-coach-bars',
    url: app('quiet'),
    opts: OPTS,
    async fn(page, t) {
      await begin(page, t, 7);
      await waitMark(page, 'bars');
      const m = await openMark(page);
      t.expect(m.body === 'No bar grid yet, so times are in seconds. Get bars', `step 4 copy (${m.body})`);
      t.expect(m.counter === '' && m.skip === 'Not now', `no counter, Not now (${m.counter} · ${m.skip})`);
      const tray = await boxOf(page, '.strip-tray');
      t.expect(gap(m.box, tray) <= 16 && m.box.bottom <= tray.y + 1, `above the strip's Get bars tray (gap ${gap(m.box, tray)})`);
      const problems = await checkAxe(page, {include: [MARK]});
      t.expect(!problems.length, problems.join('; '));
      await t.capture('bars');
      await page.locator(`${MARK} .stage-coach-action`).click();
      await page.waitForSelector('.ui-sheet[data-sheet="getBars"]', {timeout: 5000});
      await noMark(page);
      await waitStored(page, 15);
    },
  },
];
