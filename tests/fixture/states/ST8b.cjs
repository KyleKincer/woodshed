// ST8b's states: the Spots list, the Notes card, Tap the beat and the Get bars popover, opened
// through the real Stage frame (/__harness/sheets-b; tests/harness/stage/sheets-b.harness.js) on a
// real song session. Every state runs with fx-audio=manual. The surfaces are wave-2b peers (ST9,
// ST10, ST11) that may not have merged, so the frame may still show their "Not built yet" note
// (structure.placeholder); nothing else in these pages needs a missing module.
//   st8b-spots-rail         laptop: J's list is a 360 px popover left of the rail; rows ≥ 56 px with
//                           "bars 41–42 · 85% · practised 2 days ago · 14 times"; selecting a spot loops
//                           it at its speed and closes; axe
//   st8b-spots-band         iPad: a bottom sheet; a sideways swipe opens the row's tray and Delete
//                           removes the spot with an Undo toast
//   st8b-spots-passes       open a 2-bar spot, play three passes: its row reads 3 more times
//   st8b-spots-empty        no spots: the empty note and Save spot
//   st8b-notes-card         the Notes card at the music's top right, 320 px, 17 px notes; non-modal:
//                           Space still plays while it is open
//   st8b-tap-pad            the 160×160 pad; Play, then T taps at 120 bpm; the live tempo; Stop gives
//                           the result; [Use it] maps the song (one undo step)
//   st8b-getbars-web        web without a computer: Detect disabled with its reason, the download link
//   st8b-getbars-online     web with a paired computer online: Detect runs there and shows its progress
'use strict';

const {checkAxe} = require('../probes/probe-axe.cjs');

const PAGE = (query = '') => `/__harness/sheets-b?place=stage&fx-audio=manual${query ? `&${query}` : ''}`;
const OPTS = {structure: {placeholder: true}};
const LAPTOP = {...OPTS, devices: ['laptop']};
const IPAD = {...OPTS, devices: ['ipad']};

async function ready(page, t, sheet) {
  await t.loadPhase('ready');
  await page.evaluate(() => document.fonts.ready);
  if (sheet) await page.waitForSelector(`[data-sheet-body="${sheet}"]`, {state: 'visible', timeout: 10000});
}

const box = (page, selector) => page.$eval(selector, (el) => {
  const r = el.getBoundingClientRect();
  return {x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom};
});

const snap = (page) => page.evaluate(() => {
  const s = window.__sheetsB.session.transport.snapshot.peek();
  return {phase: s.phase, cue: s.cue, rate: s.rate, loop: s.loop};
});

const spotsOf = (page) => page.evaluate(() => window.__sheetsB.session.practice.value.peek().spots.map((s) => ({...s})));

module.exports = [
  {
    name: 'st8b-spots-rail', url: PAGE('sheet=spots'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t, 'spots');
      const sheet = await page.$('[data-sheet="spots"]');
      t.expect(await sheet.getAttribute('data-presentation') === 'popover', 'a rail popover');
      const s = await box(page, '[data-sheet="spots"]');
      const rail = await box(page, '.stage-controls');
      t.expect(Math.round(s.w) === 360, `360 px wide (got ${s.w})`);
      t.expect(s.right <= rail.x + 1, `left of the rail (sheet right ${s.right}, rail x ${rail.x})`);
      const rows = await page.$$eval('.spots-row', (els) => els.map((el) => ({h: el.querySelector('.spots-main').getBoundingClientRect().height,
        name: el.querySelector('.spots-name').textContent, detail: el.querySelector('.spots-detail').textContent.replace(/\s+/g, ' ').trim()})));
      t.expect(rows.length === 3, `three rows (got ${rows.length})`);
      t.expect(JSON.stringify(rows.map((r) => r.name)) === JSON.stringify(['Fill into the chorus', 'Bridge walk-up', 'Outro build']), `song order (${rows.map((r) => r.name)})`);
      for (const r of rows) t.expect(r.h >= 56, `rows are ≥ 56 px (got ${r.h})`);
      t.expect(rows[1].detail === 'bars 41–42 · 85% · practised 2 days ago · 14 times', `detail (got ${rows[1].detail})`);
      const nameSize = await page.$eval('.spots-name', (el) => getComputedStyle(el).fontSize);
      t.expect(parseFloat(nameSize) >= 15, `names at the Stage floor or above (got ${nameSize})`);
      const problems = await checkAxe(page, {include: ['[data-sheet="spots"]']});
      t.expect(!problems.length, problems.join('; '));
      await t.capture('open');
      await page.getByRole('button', {name: 'Bridge walk-up', exact: true}).click();
      await page.waitForSelector('[data-sheet="spots"]', {state: 'detached', timeout: 5000});
      const s2 = await snap(page);
      t.expect(s2.loop.on && Math.abs(s2.loop.a - 80) < 1e-3 && Math.abs(s2.loop.b - 84) < 1e-3, `the spot is looped (${JSON.stringify(s2.loop)})`);
      t.expect(Math.abs(s2.rate - 0.85) < 1e-6 && Math.abs(s2.cue - 80) < 1e-3, `speed and cue (${s2.rate}, ${s2.cue})`);
    },
  },
  {
    name: 'st8b-spots-band', url: PAGE('sheet=spots'), opts: IPAD,
    async fn(page, t) {
      await ready(page, t, 'spots');
      const presentation = await page.$eval('[data-sheet="spots"]', (el) => el.dataset.presentation);
      t.expect(presentation === 'bottom', `a bottom sheet on the band (${presentation})`);
      const row = page.locator('.spots-row[data-spot-id="spot-outro"] .spots-main');
      const b = await row.boundingBox();
      const touch = await t.touch();
      await touch.drag({x: b.x + b.width - 40, y: b.y + b.height / 2}, {x: b.x + b.width - 160, y: b.y + b.height / 2 + 2}, {steps: 10});
      await page.waitForSelector('.spots-row[data-spot-id="spot-outro"][data-revealed] .spots-tray', {state: 'visible', timeout: 3000});
      await t.capture('tray');
      await touch.tap(page.locator('.spots-row[data-spot-id="spot-outro"] .spots-tray').getByRole('button', {name: 'Delete'}));
      await page.waitForSelector('.spots-row[data-spot-id="spot-outro"]', {state: 'detached', timeout: 3000});
      const spots = await spotsOf(page);
      t.expect(spots.find((s) => s.id === 'spot-outro')?.deleted === true, 'the spot is a tombstone');
      const toast = page.getByText('Deleted spot Outro build');
      await toast.waitFor({state: 'visible', timeout: 3000});
      t.expect(await page.getByRole('button', {name: 'Undo'}).count() >= 1, 'the toast offers Undo');
      await t.capture('toast');
      // The toast region sits over the bottom sheet on the band (reported to I2b); dismiss it so the
      // final capture's structure check sees the sheet alone.
      await page.locator('.ui-toast').getByRole('button', {name: 'Dismiss'}).click();
      await page.locator('.ui-toast').waitFor({state: 'detached', timeout: 3000});
    },
  },
  {
    name: 'st8b-spots-passes', url: PAGE('sheet=spots'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t, 'spots');
      await page.getByRole('button', {name: 'Bridge walk-up', exact: true}).click();
      await page.waitForSelector('[data-sheet="spots"]', {state: 'detached', timeout: 5000});
      await page.evaluate(() => window.__sheetsB.session.transport.play());
      await t.transportPhase('playing');
      // 2 bars at 85% = 4 / 0.85 s a pass; three passes and a little more.
      await t.advance(Math.ceil((4 / 0.85) * 3 * 1000) + 300);
      const passes = await page.evaluate(() => window.__sheetsB.session.practice.value.peek().spots.find((s) => s.id === 'spot-bridge').passes);
      t.expect(passes === 17, `three more passes (14 → ${passes})`);
      await page.evaluate(() => window.__sheetsB.open('spots'));
      await page.waitForSelector('[data-sheet-body="spots"]', {state: 'visible'});
      const detail = await page.$eval('.spots-row[data-spot-id="spot-bridge"] .spots-detail', (el) => el.textContent.replace(/\s+/g, ' ').trim());
      t.expect(/practised just now · 17 times$/.test(detail), `the row counts them (${detail})`);
      const active = await page.$eval('.spots-row[data-spot-id="spot-bridge"]', (el) => el.hasAttribute('data-active'));
      t.expect(active, 'the looping spot is marked active');
    },
  },
  {
    name: 'st8b-spots-empty', url: PAGE('sheet=spots&spots=0'), opts: {...OPTS, themes: ['dark']},
    async fn(page, t) {
      await ready(page, t, 'spots');
      t.expect(await page.getByText('No spots yet').isVisible(), 'the empty title');
      t.expect(await page.getByRole('button', {name: /^Save spot/}).isVisible(), 'Save spot');
    },
  },
  {
    name: 'st8b-notes-card', url: PAGE('sheet=notes'), opts: OPTS,
    async fn(page, t) {
      await ready(page, t, 'notes');
      const card = await box(page, '.stage-notes-card');
      const music = await box(page, '.stage-main');
      t.expect(Math.round(card.w) === 320 || card.w <= music.w, `320 px wide (got ${card.w})`);
      t.expect(Math.abs(music.right - card.right) <= 24 && card.y - music.y <= 24, `at the music's top right (${JSON.stringify(card)} in ${JSON.stringify(music)})`);
      const size = await page.$eval('.notes-text', (el) => getComputedStyle(el).fontSize);
      t.expect(size === '17px', `17 px notes at Stand (got ${size})`);
      const tags = await page.$$eval('.notes-tag', (els) => els.map((el) => el.textContent));
      t.expect(JSON.stringify(tags) === JSON.stringify(['drums', 'setlist']), `tags (${tags})`);
      const modal = await page.$eval('.stage-notes-card', (el) => el.getAttribute('aria-modal'));
      t.expect(modal === null, 'non-modal');
      const problems = await checkAxe(page, {include: ['.stage-notes-card']});
      t.expect(!problems.length, problems.join('; '));
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press('Space');
      await t.transportPhase('playing');
      t.expect(await page.$('.stage-notes-card') !== null, 'the card stays open while playing');
    },
  },
  {
    name: 'st8b-tap-pad', url: PAGE('sheet=tapBeat&mapped=0'), opts: OPTS,
    async fn(page, t) {
      await ready(page, t, 'tapBeat');
      const pad = await box(page, '.tap-pad');
      t.expect(Math.round(pad.w) === 160 && Math.round(pad.h) === 160, `160×160 pad (got ${pad.w}×${pad.h})`);
      const focused = await page.evaluate(() => document.activeElement?.classList.contains('tap-pad'));
      t.expect(focused, 'the pad has focus');
      await page.locator('[data-sheet-body="tapBeat"]').getByRole('button', {name: 'Play', exact: true}).click();
      await t.transportPhase('playing');
      await page.locator('.tap-pad').focus();
      await t.advance(1000);
      for (let i = 0; i < 6; i++) {
        if (i) await t.advance(500);
        await page.keyboard.press(i % 2 ? 'Space' : 'KeyT');
      }
      const phase = await page.evaluate(() => document.documentElement.dataset.transportPhase);
      t.expect(phase === 'playing', `Space on the pad taps, it does not stop the song (${phase})`);
      const live = await page.$eval('.tap-live', (el) => el.textContent);
      t.expect(live === '≈ 120 bpm · 6 taps', `live tempo (got ${live})`);
      await t.capture('tapping');
      await page.locator('[data-sheet-body="tapBeat"]').getByRole('button', {name: 'Stop', exact: true}).click();
      await page.waitForSelector('.tap-result:not([hidden])', {timeout: 3000});
      const line = await page.$eval('.tap-result-line', (el) => el.textContent);
      t.expect(/^120 bpm · 4\/4 · first downbeat 0:0\d\.\d\d$/.test(line), `the result (got ${line})`);
      const undoBefore = await page.evaluate(() => window.__sheetsB.session.undo.size.undo);
      await page.getByRole('button', {name: 'Use it'}).click();
      await page.waitForSelector('[data-sheet="tapBeat"]', {state: 'detached', timeout: 3000});
      const after = await page.evaluate(() => ({real: window.__sheetsB.session.map.isReal, origin: window.__sheetsB.session.map.data.origin,
        undo: window.__sheetsB.session.undo.size.undo}));
      t.expect(after.real && after.origin === 'tapped', `the song is mapped from the taps (${JSON.stringify(after)})`);
      t.expect(after.undo === undoBefore + 1, `one undo step (${undoBefore} → ${after.undo})`);
    },
  },
  {
    name: 'st8b-getbars-web', url: PAGE('sheet=getBars&mapped=0'), opts: OPTS,
    async fn(page, t) {
      await ready(page, t, 'getBars');
      const detect = page.locator('[data-sheet-body="getBars"]').getByRole('button', {name: 'Detect beats'});
      t.expect(await detect.getAttribute('aria-disabled') === 'true', 'Detect is disabled');
      const reason = await detect.locator('.ui-button-reason').textContent();
      t.expect(reason === 'Needs Woodshed for desktop running on one of your computers.', `the reason is visible (${reason})`);
      t.expect(await detect.locator('.ui-button-reason').isVisible(), 'the reason is on screen');
      t.expect(await page.getByRole('link', {name: 'Get Woodshed for desktop'}).isVisible(), 'the download link');
      const problems = await checkAxe(page, {include: ['[data-sheet="getBars"]']});
      t.expect(!problems.length, problems.join('; '));
    },
  },
  {
    name: 'st8b-getbars-online', url: PAGE('sheet=getBars&mapped=0&devices=online'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t, 'getBars');
      const body = await page.$eval('.getbars-option:nth-child(2) .getbars-body', (el) => el.textContent);
      t.expect(body.endsWith('Runs on Studio Mac.'), `runs on the paired computer (${body})`);
      const detect = page.locator('[data-sheet-body="getBars"]').getByRole('button', {name: 'Detect beats'});
      t.expect(await detect.getAttribute('aria-disabled') === null, 'Detect is enabled');
      // dispatchEvent, not click(): anchored to the full-width strip, the rail popover's CSS-anchor fit
      // flips between 360 and 248 px in Chromium (a sheet-host/position.js seam, reported to I2b), so
      // Playwright never sees the button "stable".
      await detect.dispatchEvent('click');
      await page.waitForSelector('.getbars[data-detecting] .getbars-progress-line', {state: 'visible', timeout: 3000});
      const line = await page.$eval('.getbars-progress-line', (el) => el.textContent);
      t.expect(line === 'Waiting to find bars' || /^Finding bars · \d+%$/.test(line), `the progress line (${line})`);
      const created = await page.evaluate(() => window.__sheetsB.ts.server.calls.createBeatDetection.at(-1));
      t.expect(created?.deviceId === 'device-online', `sent to the paired computer (${JSON.stringify(created)})`);
    },
  },
];
