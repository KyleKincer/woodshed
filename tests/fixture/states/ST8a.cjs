// ST8a's states: the Loop card and the Stage's menus on their harness (/__harness/loop): a real
// song session in a Stage frame with ST6's strip and ST5's controls (rail on the laptop, the dock
// on the iPad). Every state runs with fx-audio=manual. The harness imports the Stage's commands
// (ST4), the strip (ST6) and the controls (ST5), all merged at I2a; no state needs a wave 2b peer.
//   st8a-loop-card-rail        laptop: the card as a 360 px popover left of the rail's Loop; the range line;
//                              Start ▶ by a bar, Alt by a beat; text ≥ 15 px; targets ≥ 44 px; axe
//   st8a-loop-card-band        iPad: a long-press on the dock's Loop opens the card as a bottom sheet;
//                              Count in every pass and Between passes by touch
//   st8a-loop-card-unmapped    unmapped: '0:31.2–0:41.0 (9.8 s)', no "bar" anywhere, Alt / Alt+Shift nudges
//   st8a-loop-card-call        no stem for the player: Call & response disabled with its visible reason
//   st8a-loop-card-spot        Save as spot…: the inline name pre-filled "Bars 21–23", Enter saves; Clear and Undo
//   st8a-menu-stage            laptop: the ⋯ menu's rows in order, key-caps, a View ▸ submenu of radios, axe
//   st8a-menu-stage-sheet      iPad: the ⋯ menu as a bottom sheet with 56 px rows; Distance ▸ drills in
//   st8a-menu-bar              right-click (laptop) / long-press (iPad) on the music: the bar menu; Loop this bar
//   st8a-menu-section-strip    a long-press and a right-click on a strip segment open the section menu with
//                              "Loop this section" and "Rename…" (forward.md, I2a-12); Rename… opens the strip's field
//   st8a-menu-loop-band        the loop-band menu: Count in every pass ✓, Move by the loop's length, Clear
//   st8a-menu-spot-marker-stem the spot (Delete → Undo toast), marker (Turn into section) and stem menus
'use strict';

const {checkAxe} = require('../probes/probe-axe.cjs');

const LOOP = (query = '') => `/__harness/loop?fx-audio=manual${query ? `&${query}` : ''}`;
const REQUIRES = ['src/stage/commands.js', 'src/stage/strip.js', 'src/stage/controls.js'];
const LAPTOP = {devices: ['laptop'], requires: REQUIRES};
const IPAD = {devices: ['ipad'], requires: REQUIRES};

async function ready(page, t) {
  await t.loadPhase('ready');
  await page.evaluate(() => document.fonts.ready);
}

const snap = (page) => page.evaluate(() => {
  const s = window.__loop.session.transport.snapshot.peek();
  return {phase: s.phase, cue: s.cue, loop: s.loop, rate: s.rate};
});

const close = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

/** The open Loop card (a sheet or popover): waits for it, returns its box. */
async function card(page) {
  await page.waitForSelector('.loop-card', {state: 'visible', timeout: 5000});
  return page.$eval('.loop-card', (el) => {
    const r = el.getBoundingClientRect();
    const layer = el.closest('[data-sheet]') ?? el.parentElement;
    const l = layer.getBoundingClientRect();
    return {x: r.x, y: r.y, w: r.width, h: r.height, layer: {x: l.x, y: l.y, w: l.width, h: l.height, bottom: l.bottom, right: l.right}};
  });
}

/** Every text-bearing element in `selector` whose computed font size is under `min` px. */
const smallText = (page, selector, min = 15) => page.$$eval(`${selector} *`, (els, floor) => els
  .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && el.getClientRects().length)
  .map((el) => ({text: el.textContent.trim().slice(0, 40), size: parseFloat(getComputedStyle(el).fontSize)}))
  .filter((x) => x.size < floor), min);

/** Visible controls in `selector` smaller than `min` px in either direction. */
const smallTargets = (page, selector, min = 44) => page.$$eval(`${selector} button, ${selector} [role=radio], ${selector} input`, (els, floor) => els
  .filter((el) => el.getClientRects().length)
  .map((el) => { const r = el.getBoundingClientRect(); return {name: el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 30), w: r.width, h: r.height}; })
  .filter((x) => x.w < floor - 0.5 || x.h < floor - 0.5), min);

const buttonByName = (page, scope, name) => page.locator(`${scope} button`).filter({hasText: name}).first();
const named = (page, scope, name) => page.locator(`${scope} [aria-label="${name}"]`).first();
const menuLabels = (page) => page.$$eval('[role=menu]:not([hidden]) > .ui-menu-item .ui-menu-label', (els) => els.filter((e) => e.getClientRects().length).map((e) => e.textContent));
const menuRow = (page, label) => page.locator('[role=menu] .ui-menu-item').filter({has: page.locator('.ui-menu-label', {hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)})}).first();

module.exports = [
  {
    name: 'st8a-loop-card-rail', url: LOOP('scenario=looping'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t);
      await page.evaluate(() => window.__loop.open('loop'));
      const box = await card(page);
      const anchor = await page.evaluate(() => {
        const r = window.__loop.stage.anchors.get('loop').getBoundingClientRect();
        return {x: r.x, right: r.right, y: r.y};
      });
      t.expect(Math.abs(box.layer.w - 360) < 1.5, `the rail popover is 360 px wide (got ${box.layer.w})`);
      t.expect(box.layer.right <= anchor.x + 1, `it opens left of the rail's Loop control (popover right ${box.layer.right}, control left ${anchor.x})`);
      const range = await page.$eval('.loop-card-range', (el) => ({text: el.textContent, size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight}));
      t.expect(range.text === 'Bars 17–24 · Chorus (8 bars)', `the range line (got ${range.text})`);
      t.expect(range.size === '20px' && range.weight === '700', `the range line is 20/700 (got ${range.size}/${range.weight})`);
      const small = await smallText(page, '.loop-card');
      t.expect(!small.length, `every text on the card is at least 15 px (got ${JSON.stringify(small)})`);
      const tiny = await smallTargets(page, '.loop-card');
      t.expect(!tiny.length, `every control is at least 44 px (got ${JSON.stringify(tiny)})`);
      const fine = await page.$eval('.loop-card-fine', (el) => getComputedStyle(el).display);
      t.expect(fine !== 'none', 'the Alt hint shows with a mouse');
      await named(page, '.loop-card', 'Start a bar later').click();
      let s = await snap(page);
      t.expect(close(s.loop.a, 34) && close(s.loop.b, 48), `Start ▶ moves the start by a bar (got ${s.loop.a}–${s.loop.b})`);
      await page.keyboard.down('Alt');
      await named(page, '.loop-card', 'End a bar earlier').click();
      await page.keyboard.up('Alt');
      s = await snap(page);
      t.expect(close(s.loop.b, 47.5), `Alt+click moves by a beat (got end ${s.loop.b})`);
      const text = await page.$eval('.loop-card-range', (el) => el.textContent);
      t.expect(text === 'Bars 18–24 (6.5 bars)' || /^Bars 18–24/.test(text), `the range follows (got ${text})`);
      const problems = await checkAxe(page, {include: ['.loop-card']});
      t.expect(!problems.length, problems.join('; '));
    },
  },
  {
    name: 'st8a-loop-card-band', url: LOOP('scenario=looping'), opts: IPAD,
    async fn(page, t) {
      await ready(page, t);
      const loopCtl = await page.evaluate(() => {
        const r = window.__loop.stage.anchors.get('loop').getBoundingClientRect();
        return {x: r.x + r.width / 2, y: r.y + r.height / 2};
      });
      const touch = await t.touch();
      await touch.longPress(loopCtl, {ms: 700});
      const box = await card(page);
      const vh = await page.evaluate(() => innerHeight);
      t.expect(box.layer.bottom >= vh - 2, `the band opens a bottom sheet (sheet bottom ${box.layer.bottom}, viewport ${vh})`);
      const sheetName = await page.$eval('.loop-card', (el) => el.closest('[data-sheet]')?.dataset.sheet ?? null);
      t.expect(sheetName === 'loop', `it is the Loop sheet (got ${sheetName})`);
      let s = await snap(page);
      t.expect(s.loop.on && close(s.loop.a, 32), `the long-press did not toggle the loop (got ${JSON.stringify(s.loop)})`);
      const tiny = await smallTargets(page, '.loop-card');
      t.expect(!tiny.length, `every control is at least 44 px on touch (got ${JSON.stringify(tiny)})`);
      const fine = await page.$eval('.loop-card-fine', (el) => getComputedStyle(el).display);
      t.expect(fine === 'none', 'the Alt hint is hidden on touch');
      await page.locator('.loop-card [role=radiogroup]').nth(1).locator('[role=radio]', {hasText: '1 bar rest'}).tap();
      await page.locator('.loop-card button', {hasText: 'Count in every pass'}).tap();
      s = await snap(page);
      t.expect(s.loop.between === 'rest' && s.loop.eachPassCount === false, `between passes and count in every pass by touch (got ${JSON.stringify(s.loop)})`);
      const small = await smallText(page, '.loop-card');
      t.expect(!small.length, `every text on the card is at least 15 px (got ${JSON.stringify(small)})`);
    },
  },
  {
    name: 'st8a-loop-card-unmapped', url: LOOP('mapped=0&scenario=timed&open=loop'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t);
      await card(page);
      const range = await page.$eval('.loop-card-range', (el) => el.textContent);
      t.expect(range === '0:31.2–0:41.0 (9.8 s)', `the range in time (got ${range})`);
      const words = await page.$eval('.loop-card', (el) => [el.textContent, ...[...el.querySelectorAll('[aria-label]')].map((n) => n.getAttribute('aria-label'))].join(' '));
      t.expect(!/\bbars?\b/i.test(words), `no "bar" on an unmapped card (got ${words.match(/.{0,20}\bbars?\b.{0,20}/i)?.[0]})`);
      t.expect(await named(page, '.loop-card', 'Move 9.8 s forward').isVisible(), 'Move by the loop’s length in seconds');
      await named(page, '.loop-card', 'Start 0.1 s later').click();
      await page.keyboard.down('Alt');
      await named(page, '.loop-card', 'Start 0.1 s later').click();
      await page.keyboard.down('Shift');
      await named(page, '.loop-card', 'Start 0.1 s later').click();
      await page.keyboard.up('Shift');
      await page.keyboard.up('Alt');
      const s = await snap(page);
      t.expect(close(s.loop.a, 31.36), `0.1 s, then 50 ms (Alt), then 10 ms (Alt+Shift) (got ${s.loop.a})`);
      t.expect(await named(page, '.loop-card', 'Move 9.6 s forward').isVisible(), 'the Move length follows the loop');
    },
  },
  {
    name: 'st8a-loop-card-call', url: LOOP('scenario=looping&stems=bass,vocals,other&open=loop'), opts: {...LAPTOP, themes: ['dark']},
    async fn(page, t) {
      await ready(page, t);
      await card(page);
      const between = page.locator('.loop-card [role=radiogroup]').nth(1);
      const call = between.locator('[role=radio]', {hasText: 'Call & response'});
      t.expect(await call.getAttribute('aria-disabled') === 'true', 'Call & response is disabled without a stem for the player');
      await call.click({force: true});   // aria-disabled: it stays focusable and explains itself
      const reason = between.locator('.ui-segmented-reason');
      await reason.waitFor({state: 'visible', timeout: 2000});
      const r = await reason.evaluate((el) => ({text: el.textContent, size: getComputedStyle(el).fontSize}));
      t.expect(r.text.startsWith('Call & response needs a stem for your instrument'), `the visible reason (got ${r.text})`);
      t.expect(parseFloat(r.size) >= 15, `the reason is at least 15 px (got ${r.size})`);
      const s = await snap(page);
      t.expect(s.loop.between === 'none', `nothing changed (got ${s.loop.between})`);
    },
  },
  {
    name: 'st8a-loop-card-spot', url: LOOP('scenario=bars&open=loop'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t);
      await card(page);
      await buttonByName(page, '.loop-card', 'Save as spot…').click();
      const input = page.locator('.loop-card-form input');
      await input.waitFor({state: 'visible'});
      const value = await input.inputValue();
      t.expect(value === 'Bars 21–23', `pre-filled with the loop's name (got ${value})`);
      t.expect(await input.evaluate((el) => el === document.activeElement), 'the name field has focus');
      await t.capture('form');
      await input.fill('Fill into bar 21');
      await page.keyboard.press('Enter');
      const spots = await page.evaluate(() => window.__loop.session.practice.value.peek().spots.filter((s) => !s.deleted).map((s) => ({name: s.name, a: s.a, b: s.b})));
      t.expect(spots.some((s) => s.name === 'Fill into bar 21' && close(s.a, 40) && close(s.b, 46)), `the spot is saved over the loop (got ${JSON.stringify(spots)})`);
      t.expect(await page.locator('.loop-card-form').count() === 0, 'the inline field closes');
      await buttonByName(page, '.loop-card', 'Clear loop').click();
      let s = await snap(page);
      t.expect(!s.loop.on, 'Clear loop clears it');
      const range = await page.$eval('.loop-card-range', (el) => el.textContent);
      t.expect(range === 'No loop yet.', `the card shows no loop (got ${range})`);
      await page.keyboard.press('Control+KeyZ');
      s = await snap(page);
      t.expect(s.loop.on && close(s.loop.a, 40), `⌘Z / Ctrl+Z brings it back (got ${JSON.stringify(s.loop)})`);
      // The "Undid: …" toast (stopped) sits bottom-centre over the popover by design; dismiss it before the structure check.
      const dismiss = page.locator('.ui-toast-region .ui-toast-close');
      if (await dismiss.count()) await dismiss.first().click();
      await page.waitForFunction(() => !document.querySelector('.ui-toast-region .ui-toast'), null, {timeout: 3000});
    },
  },
  {
    name: 'st8a-menu-stage', url: LOOP('part=1'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t);
      await page.getByRole('button', {name: 'More…'}).click();
      await page.waitForSelector('[role=menu]', {state: 'visible'});
      const rows = await menuLabels(page);
      const want = ['View', 'Display', 'Follow', 'Focus', 'Distance', 'Spots…', 'Notes', 'Tap the beat…', 'Detect beats',
        'Share…', 'Edit map', 'Edit drum chart', 'Edit details', 'Re-split…', 'Keyboard shortcuts'];
      t.expect(JSON.stringify(rows) === JSON.stringify(want), `the ⋯ menu's rows (got ${JSON.stringify(rows)})`);
      const caps = await page.$$eval('[role=menu] .ui-menu-item', (els) => Object.fromEntries(els.map((el) => [el.querySelector('.ui-menu-label').textContent, el.getAttribute('aria-keyshortcuts')]).filter(([, k]) => k)));
      t.expect(caps.Focus === 'F' && caps['Spots…'] === 'J' && caps['Edit map'] === 'E' && caps['Keyboard shortcuts'] === '?', `key-caps (got ${JSON.stringify(caps)})`);
      const reason = await menuRow(page, 'Re-split…').locator('.ui-menu-reason').textContent();
      t.expect(reason === 'Re-split from Woodshed for desktop.', `Re-split shows its reason on the web (got ${reason})`);
      await menuRow(page, 'View').focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelectorAll('[role=menu]').length >= 2, null, {timeout: 3000});
      const radios = await page.$$eval('[role=menu] [role=menuitemradio]', (els) => els.map((el) => [el.textContent.trim(), el.getAttribute('aria-checked')]));
      t.expect(JSON.stringify(radios) === JSON.stringify([['Chart', 'true'], ['Road map', 'false'], ['Stems', 'false']]), `View ▸ radios (got ${JSON.stringify(radios)})`);
      await t.capture('view');
      const problems = await checkAxe(page, {include: ['[role=menu]']});
      t.expect(!problems.length, problems.join('; '));
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    },
  },
  {
    name: 'st8a-menu-stage-sheet', url: LOOP('scenario=looping'), opts: IPAD,
    async fn(page, t) {
      await ready(page, t);
      await page.getByRole('button', {name: 'More…'}).tap();
      await page.waitForSelector('.ui-menu-sheet [role=menu]', {state: 'visible'});
      const heights = await page.$$eval('.ui-menu-sheet [role=menu] .ui-menu-item', (els) => els.filter((e) => e.getClientRects().length).map((e) => e.getBoundingClientRect().height));
      t.expect(heights.length >= 12 && heights.every((hgt) => hgt >= 55.5), `56 px rows on the coarse sheet (got ${JSON.stringify(heights)})`);
      await menuRow(page, 'Distance').tap();
      await page.waitForFunction(() => [...document.querySelectorAll('.ui-menu-sheet [role=menuitemradio]')].some((e) => e.getClientRects().length));
      await menuRow(page, 'Kit').tap();
      const distance = await page.evaluate(() => window.__loop.stage.distance.peek());
      t.expect(distance === 'kit', `Distance ▸ Kit (got ${distance})`);
    },
  },
  {
    name: 'st8a-menu-bar', url: LOOP(), opts: {requires: REQUIRES, capture: true},
    async fn(page, t) {
      await ready(page, t);
      const box = await page.$eval('[data-testid=music]', (el) => { const r = el.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; });
      const at = {x: box.x + box.w * (41.2 / 128), y: box.y + box.h / 2};
      if (t.device === 'ipad') {
        const touch = await t.touch();
        await touch.longPress(at, {ms: 600});
      } else {
        await page.mouse.click(at.x, at.y, {button: 'right'});
      }
      await page.waitForSelector('[role=menu]', {state: 'visible'});
      const rows = await menuLabels(page);
      const want = ['Play from here', 'Cue here', 'Loop this bar', 'Loop this section', 'Loop 4 bars from here', 'Save spot here…', 'Add section here'];
      t.expect(JSON.stringify(rows) === JSON.stringify(want), `the bar menu (got ${JSON.stringify(rows)})`);
      await t.capture('open');
      if (t.device === 'ipad') await menuRow(page, 'Loop this bar').tap();
      else await menuRow(page, 'Loop this bar').click();
      const s = await snap(page);
      t.expect(s.loop.on && close(s.loop.b - s.loop.a, 2), `Loop this bar loops one 2 s bar (got ${JSON.stringify(s.loop)})`);
    },
  },
  {
    name: 'st8a-menu-section-strip', url: LOOP(), opts: {requires: REQUIRES},
    async fn(page, t) {
      await ready(page, t);
      const segs = await page.$$eval('.strip-seg', (els) => els.map((s) => { const r = s.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2, label: s.textContent.trim()}; }));
      const chorus = segs[2];
      if (t.device === 'ipad') {
        const touch = await t.touch();
        await touch.longPress(chorus, {ms: 500});
      } else {
        await page.mouse.click(chorus.x, chorus.y, {button: 'right'});
      }
      await page.waitForSelector('[role=menu]', {state: 'visible', timeout: 3000});
      const rows = await menuLabels(page);
      t.expect(rows.includes('Loop this section') && rows.includes('Rename…'), `the section menu (got ${JSON.stringify(rows)})`);
      t.expect(JSON.stringify(rows) === JSON.stringify(['Play from here', 'Loop this section', 'Extend loop to here', 'Save as spot…', 'Rename…', 'Edit sections in Map']), `in order (got ${JSON.stringify(rows)})`);
      const label = await page.$eval('[role=menu]', (el) => el.getAttribute('aria-label'));
      t.expect(label === 'Chorus', `named after the section (got ${label})`);
      let s = await snap(page);
      t.expect(close(s.cue, 20) && !s.loop.on, `opening the menu changes nothing (got ${JSON.stringify(s)})`);
      await t.capture('open');
      if (t.device === 'ipad') await menuRow(page, 'Rename…').tap();
      else await menuRow(page, 'Rename…').click();
      const field = page.locator('nav.strip input');
      await field.waitFor({state: 'visible', timeout: 2000});
      t.expect(await field.inputValue() === 'Chorus', 'Rename… opens the strip’s inline field');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(900);
      if (t.device === 'ipad') {
        const touch = await t.touch();
        await touch.longPress(segs[5], {ms: 500});
      } else {
        await page.mouse.click(segs[5].x, segs[5].y, {button: 'right'});
      }
      await page.waitForSelector('[role=menu]', {state: 'visible', timeout: 3000});
      if (t.device === 'ipad') await menuRow(page, 'Loop this section').tap();
      else await menuRow(page, 'Loop this section').click();
      s = await snap(page);
      t.expect(s.loop.on && close(s.loop.a, 80) && close(s.loop.b, 96), `Loop this section loops the Bridge (got ${JSON.stringify(s.loop)})`);
    },
  },
  {
    name: 'st8a-menu-loop-band', url: LOOP('scenario=looping&open=loopBand'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page, t);
      await page.waitForSelector('[role=menu]', {state: 'visible'});
      const rows = await page.$$eval('[role=menu] .ui-menu-item', (els) => els.map((el) => ({label: el.querySelector('.ui-menu-label').textContent,
        role: el.getAttribute('role'), checked: el.getAttribute('aria-checked'), key: el.getAttribute('aria-keyshortcuts')})));
      const labels = rows.map((r) => r.label);
      t.expect(JSON.stringify(labels) === JSON.stringify(['Save as spot', 'Count in every pass', '◀ Move 8 bars', 'Move 8 bars ▶', 'Clear']), `loop-band rows (got ${JSON.stringify(labels)})`);
      const each = rows.find((r) => r.label === 'Count in every pass');
      t.expect(each.role === 'menuitemcheckbox' && each.checked === 'true', `Count in every pass ✓ (got ${JSON.stringify(each)})`);
      t.expect(rows.find((r) => r.label === 'Save as spot').key === 'B' && rows.find((r) => r.label === 'Clear').key === 'Backspace', `key-caps (got ${JSON.stringify(rows)})`);
      await menuRow(page, 'Move 8 bars ▶').click();
      const s = await snap(page);
      t.expect(close(s.loop.a, 48) && close(s.loop.b, 64), `Move ▶ by the loop's length (got ${s.loop.a}–${s.loop.b})`);
    },
  },
  {
    name: 'st8a-menu-spot-marker-stem', url: LOOP('scenario=looping'), opts: {...LAPTOP, themes: ['dark']},
    async fn(page, t) {
      await ready(page, t);
      await page.evaluate(() => window.__loop.open('spot'));
      await page.waitForSelector('[role=menu]', {state: 'visible'});
      t.expect(JSON.stringify(await menuLabels(page)) === JSON.stringify(['Open', 'Rename…', 'Update from current', 'Delete']), 'the spot menu');
      await menuRow(page, 'Delete').click();
      const toast = page.locator('.ui-toast-region').getByRole('button', {name: 'Undo'});
      await toast.waitFor({state: 'visible', timeout: 3000});
      await t.capture('spot-undo');
      await toast.click();
      const spots = await page.evaluate(() => window.__loop.session.practice.value.peek().spots.filter((s) => !s.deleted).length);
      t.expect(spots === 2, `Undo brings the spot back (got ${spots} spots)`);

      await page.evaluate(() => window.__loop.open('marker'));
      await page.waitForSelector('[role=menu]', {state: 'visible'});
      t.expect(JSON.stringify(await menuLabels(page)) === JSON.stringify(['Rename…', 'Delete', 'Turn into section']), 'the marker menu');
      await menuRow(page, 'Turn into section').click();
      const sections = await page.evaluate(() => window.__loop.session.position.regions().map((r) => r.label));
      t.expect(sections.includes('Flam'), `the marker became a section (got ${JSON.stringify(sections)})`);

      await page.evaluate(() => window.__loop.open('stem', {stem: 'bass'}));
      await page.waitForSelector('[role=menu]', {state: 'visible'});
      const stem = await page.$$eval('[role=menu] .ui-menu-item', (els) => els.map((el) => [el.querySelector('.ui-menu-label').textContent, el.getAttribute('role'), el.getAttribute('aria-keyshortcuts')]));
      t.expect(JSON.stringify(stem.map((r) => r[0])) === JSON.stringify(['Mute', 'Solo', 'Reset level', 'This is my instrument']), `the stem menu (got ${JSON.stringify(stem)})`);
      t.expect(stem[0][2] === '2' && stem[1][2] === 'Shift+2', `bass is stem 2 (got ${JSON.stringify(stem)})`);
      await menuRow(page, 'Mute').click();
      const muted = await page.evaluate(() => window.__loop.session.transport.snapshot.peek().mix.tracks.find((x) => x.name === 'bass').muted);
      t.expect(muted, 'Mute mutes the bass');
    },
  },
];
