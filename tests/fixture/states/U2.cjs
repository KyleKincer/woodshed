// U2's states: the overlay primitives on the harness page /__harness/overlays (tests/harness/ui/overlays.harness.js).
//   u2-overview           every in-flow primitive (toasts, statuses, banners) and the triggers; target sizes
//   u2-menu               roving focus, a submenu (popover on laptop, drill-in sheet with 56 px rows on iPad), type-ahead,
//                         Esc innermost first, focus return
//   u2-contextmenu        right-click at the pointer and Shift+F10 (laptop); a 600 ms touch long-press → sheet (iPad)
//   u2-popover-anchor     the four corners with CSS anchor positioning: inside the viewport, beside the anchor, bottom
//                         corners flipped above
//   u2-popover-fallback   the same with fx-nofeature=anchor,popover (place() and the fallback layer)
//   u2-sheet-band         iPad band layout: a bottom sheet ≤ 60% high; one generous CDP swipe dismisses it
//   u2-sheet-rail         laptop rail layout: a 360 px popover left of its control; Esc returns focus
//   u2-sheet-modal        a modal bottom sheet (<dialog>): Tab stays inside, the backdrop tap closes it
//   u2-dialog             a form dialog: field validation, an async error inline, success closes, focus returns;
//                         a danger confirm starts on Cancel
//   u2-coach              a coach mark beside its anchor, not focused
//   u2-toast              a toast in the bottom-centre region
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');

const H = '/__harness/overlays';
// With an overlay open, the page behind it (the content column and the corner triggers) is partly covered by design:
// the structural checks then look at the overlay's own targets.
const BEHIND = {structure: {ignore: ['#ov-content', '[data-corner]']}};

/** The visible box of the first match (null when hidden). */
const box = (page, selector) => page.locator(selector).first().boundingBox();
const activeText = page => page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
const activeId = page => page.evaluate(() => document.activeElement?.id ?? '');
const viewport = page => page.evaluate(() => ({w: document.documentElement.clientWidth, h: window.innerHeight}));
/** Waits for the element's running animations (an overlay grows from its anchor) before it is measured. */
const settle = locator => locator.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => null))));
const inside = (b, v) => b && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= v.w + 0.5 && b.y + b.height <= v.h + 0.5;

async function expectTargets(t, rules = []) {
  const problems = await checkTargets(t.page, {rules});
  t.expect(!problems.length, `targets: ${problems.join('; ')}`);
}

async function menuFlow(page, t) {
  const sheet = t.device === 'ipad';
  if (sheet) await (await t.touch()).tap(page.locator('#ov-menu')); else await page.click('#ov-menu');
  const root = page.locator('.ui-menu').first();
  await root.waitFor();
  t.expect(await root.getAttribute('data-presentation') === (sheet ? 'sheet' : 'popover'), `presentation is ${sheet ? 'sheet' : 'popover'}`);
  t.expect((await activeText(page)).startsWith('Start again (with count-in)'), 'the first item has focus');
  if (!sheet) t.expect(await page.locator('.ui-menu-item', {hasText: 'Focus'}).locator('kbd').textContent() === 'F', 'a command item shows its key-cap');
  const reason = page.locator('.ui-menu-reason', {hasText: 'Re-split from Woodshed for desktop.'});
  t.expect(await reason.isVisible(), 'the disabled reason is visible');
  if (sheet) {
    const rows = await page.locator('.ui-menu-item').evaluateAll(list => list.map(r => r.getBoundingClientRect().height));
    t.expect(rows.every(h => h >= 55.5), `sheet rows are 56 px (${rows.join(', ')})`);
  }
  await page.keyboard.press('ArrowDown');
  t.expect((await activeText(page)).startsWith('View'), '↓ moves to View');
  await page.keyboard.press('ArrowRight');
  const sub = page.locator('.ui-menu[aria-label="View"]');
  await sub.waitFor();
  t.expect((await activeText(page)).startsWith('Chart'), '→ opens the submenu on its first item');
  if (sheet) {
    t.expect(!(await root.isVisible()), 'the sheet drills in');
    t.expect(await sub.locator('.ui-menu-back').isVisible(), 'a Back row leads out');
  } else {
    await settle(sub);
    const rowBox = await box(page, '.ui-menu-item[aria-haspopup=menu]');
    const subBox = await sub.boundingBox();
    t.expect(subBox.x >= rowBox.x + rowBox.width - 1 || subBox.x + subBox.width <= rowBox.x + 1, 'the submenu opens beside its row');
  }
  await t.capture('submenu');
  await page.keyboard.press('Escape');
  await sub.waitFor({state: 'detached'});
  t.expect((await activeText(page)).startsWith('View'), 'Esc closes only the submenu and refocuses its row');
  t.expect(await root.isVisible(), 'the menu stays open');
  await page.keyboard.press('s');
  t.expect((await activeText(page)).startsWith('Spots'), 'type-ahead finds Spots…');
  await page.keyboard.press('Escape');
  await root.waitFor({state: 'detached'});
  t.expect(await activeId(page) === 'ov-menu', 'focus returns to the trigger');
  // Leave the menu open for the capture and the structural checks.
  await page.focus('#ov-menu');
  await page.keyboard.press('Enter');
  await page.locator('.ui-menu').first().waitFor();
  await expectTargets(t, sheet ? [{selector: '.ui-menu[data-presentation=sheet] .ui-menu-item', min: 56}] : []);
}

async function contextFlow(page, t) {
  const card = page.locator('#ov-card');
  const cardBox = await card.boundingBox();
  if (t.device === 'ipad') {
    const touch = await t.touch();
    await touch.longPress({x: cardBox.x + 60, y: cardBox.y + 20}, {ms: 650});
    const menu = page.locator('.ui-menu').first();
    await menu.waitFor();
    t.expect(await menu.getAttribute('data-presentation') === 'sheet', 'a long-press on a coarse pointer opens the sheet');
    t.expect(await page.locator('dialog.ui-menu-sheet').isVisible(), 'inside a modal sheet');
    await expectTargets(t, [{selector: '.ui-menu[data-presentation=sheet] .ui-menu-item', min: 56}]);
    return;
  }
  const at = {x: cardBox.x + 60, y: cardBox.y + 20};
  await page.mouse.click(at.x, at.y, {button: 'right'});
  const menu = page.locator('.ui-menu').first();
  await menu.waitFor();
  await settle(menu);
  const m = await menu.boundingBox();
  t.expect(Math.abs(m.x - at.x) <= 2 && m.y >= at.y && m.y - at.y <= 12, `the menu opens at the pointer (${m.x},${m.y} for ${at.x},${at.y})`);
  t.expect(await page.locator('.ui-menu').count() === 1, 'one menu');
  await page.keyboard.press('Escape');
  await menu.waitFor({state: 'detached'});
  await page.focus('#ov-card');
  await page.keyboard.press('Shift+F10');
  await page.locator('.ui-menu').first().waitFor();
  await settle(page.locator('.ui-menu').first());
  const k = await box(page, '.ui-menu');
  t.expect(k.y >= cardBox.y + cardBox.height, 'Shift+F10 opens below the focused card');
  t.expect((await activeText(page)) === 'Select', 'the first item has focus');
  await page.keyboard.press('Escape');
  t.expect(await activeId(page) === 'ov-card', 'focus returns to the card');
  await page.keyboard.press('ContextMenu');
  await page.locator('.ui-menu').first().waitFor();
}

function popoverFlow({fallback}) {
  return async (page, t) => {
    const v = await viewport(page);
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      const trigger = page.locator(`#ov-${corner}`);
      await trigger.click();
      const pop = page.locator(`.ui-popover[aria-label="Popover ${corner}"]`);
      await pop.waitFor();
      await settle(pop);
      const a = await trigger.boundingBox();
      const b = await pop.boundingBox();
      const mode = await pop.getAttribute('data-anchor');
      t.expect(mode === (fallback ? 'js' : 'css'), `${corner}: positioned by ${fallback ? 'place()' : 'CSS anchor positioning'} (got ${mode})`);
      t.expect(await pop.evaluate(el => el.hasAttribute('popover')) === !fallback, `${corner}: ${fallback ? 'the fallback layer' : 'the top layer'}`);
      t.expect(inside(b, v), `${corner}: inside the viewport (${JSON.stringify(b)})`);
      if (corner.startsWith('top')) t.expect(b.y >= a.y + a.height && b.y - (a.y + a.height) <= 12, `${corner}: below the anchor`);
      else t.expect(b.y + b.height <= a.y && a.y - (b.y + b.height) <= 12, `${corner}: flipped above the anchor`);
      t.expect(b.x < a.x + a.width && b.x + b.width > a.x, `${corner}: overlaps the anchor's column`);
      t.expect(await activeText(page) === 'Retry', `${corner}: focus moves into the popover`);
      await page.keyboard.press('Escape');
      await pop.waitFor({state: 'detached'});
      t.expect(await activeId(page) === `ov-${corner}`, `${corner}: Esc returns focus to the anchor`);
    }
    await page.locator('#ov-bottom-right').click();
    await page.locator('.ui-popover').waitFor();
  };
}

async function sheetBandFlow(page, t) {
  const touch = await t.touch();
  await touch.tap(page.locator('#ov-sheet'));
  const sheet = page.locator('.ui-sheet');
  await sheet.waitFor();
  t.expect(await sheet.getAttribute('data-presentation') === 'bottom', 'band layout → a bottom sheet');
  await settle(sheet);
  const v = await viewport(page);
  const b = await sheet.boundingBox();
  t.expect(Math.abs(b.y + b.height - v.h) <= 1, 'it sits on the bottom edge');
  t.expect(b.height <= v.h * 0.6 + 1, `at most 60% high (${b.height})`);
  t.expect(await page.locator('.ui-sheet-grabber').isVisible(), 'a grabber');
  const close = await box(page, '.ui-sheet-close');
  t.expect(close.width >= 44 && close.height >= 44, '✕ is 44 px');
  await expectTargets(t);
  const head = await box(page, '.ui-sheet-head');
  const from = {x: head.x + head.width / 3, y: head.y + head.height / 2};
  await touch.drag(from, {x: from.x, y: Math.min(v.h - 2, from.y + b.height * 0.6)}, {steps: 14});
  await sheet.waitFor({state: 'detached', timeout: 5000});
  await page.locator('#ov-sheet').click();
  await sheet.waitFor();
}

async function sheetRailFlow(page, t) {
  await page.click('#ov-sheet');
  const sheet = page.locator('.ui-sheet');
  await sheet.waitFor();
  t.expect(await sheet.getAttribute('data-presentation') === 'popover', 'rail layout → an anchored popover');
  await settle(sheet);
  const a = await box(page, '#ov-sheet');
  const b = await sheet.boundingBox();
  t.expect(Math.abs(b.width - 360) <= 1, `360 px wide (${b.width})`);
  t.expect(b.x + b.width <= a.x + 1 && a.x - (b.x + b.width) <= 12, 'left of its control');
  t.expect(!(await page.locator('.ui-sheet-grabber').isVisible()), 'no grabber');
  await page.keyboard.press('Escape');
  await sheet.waitFor({state: 'detached'});
  t.expect(await activeId(page) === 'ov-sheet', 'Esc returns focus to the control');
  await page.click('#ov-sheet');
  await sheet.waitFor();
  await expectTargets(t);
}

async function sheetModalFlow(page, t) {
  await page.click('#ov-sheet-modal');
  const sheet = page.locator('dialog.ui-sheet');
  await sheet.waitFor();
  t.expect(await sheet.evaluate(el => el.matches(':modal')), 'a modal <dialog>');
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    t.expect(await page.evaluate(() => !!document.activeElement?.closest('dialog.ui-sheet')), 'Tab stays inside the modal sheet');
  }
  await page.mouse.click(20, 20);
  await sheet.waitFor({state: 'detached'});
  await page.click('#ov-sheet-modal');
  await sheet.waitFor();
}

async function dialogFlow(page, t) {
  await page.click('#ov-form');
  const dialog = page.locator('dialog.ui-dialog');
  await dialog.waitFor();
  t.expect(await dialog.evaluate(el => el.matches(':modal')), 'a modal <dialog>');
  t.expect(await page.evaluate(() => document.activeElement?.name) === 'title', 'focus starts in the first field');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  const fieldError = page.locator('.ui-dialog-field-error', {hasText: 'Title is required.'});
  await fieldError.waitFor();
  t.expect(await page.locator('[name=title][aria-invalid=true]').count() === 1, 'the field is marked invalid');
  await page.keyboard.type('Harbor Lights (live)');
  await page.keyboard.press('Enter');
  const error = page.locator('.ui-dialog-error[role=alert]', {hasText: 'The server said no. Try again.'});
  await error.waitFor();
  t.expect(await dialog.isVisible(), 'the dialog stays open on an error');
  await t.capture('error');
  await page.keyboard.press('Enter');
  await dialog.waitFor({state: 'detached'});
  t.expect(await activeId(page) === 'ov-form', 'focus returns to Rename…');
  await page.click('#ov-confirm');
  await dialog.waitFor();
  t.expect(await activeText(page) === 'Cancel', 'a danger confirm starts on Cancel');
  await expectTargets(t);
}

async function coachFlow(page, t) {
  const coach = page.locator('.ui-coachmark');
  await coach.waitFor();
  await settle(coach);
  const a = await box(page, '#ov-play');
  const b = await coach.boundingBox();
  t.expect(b.y >= a.y + a.height || b.y + b.height <= a.y || b.x >= a.x + a.width || b.x + b.width <= a.x, 'beside its anchor, not over it');
  t.expect(await coach.locator('.ui-coachmark-step').textContent() === '1 of 3', '1 of 3');
  t.expect(await page.evaluate(() => !document.activeElement?.closest('.ui-coachmark')), 'it does not take focus');
}

async function toastFlow(page, t) {
  const toast = page.locator('.ui-toast-region .ui-toast');
  await toast.waitFor();
  await settle(toast);
  const v = await viewport(page);
  const b = await toast.boundingBox();
  t.expect(Math.abs(b.x + b.width / 2 - v.w / 2) <= 2, 'bottom-centre');
  t.expect(v.h - (b.y + b.height) >= 16 && v.h - (b.y + b.height) <= 40, 'above the bottom edge');
}

module.exports = [
  {name: 'u2-overview', url: H, fn: async (page, t) => expectTargets(t)},
  {name: 'u2-menu', url: H, fn: menuFlow, opts: BEHIND},
  {name: 'u2-contextmenu', url: H, fn: contextFlow, opts: BEHIND},
  {name: 'u2-popover-anchor', url: H, fn: popoverFlow({fallback: false}), opts: BEHIND},
  {name: 'u2-popover-fallback', url: `${H}?fx-nofeature=anchor,popover`, fn: popoverFlow({fallback: true}), opts: BEHIND},
  {name: 'u2-sheet-band', url: `${H}?layout=band`, fn: sheetBandFlow, opts: {devices: ['ipad'], ...BEHIND}},
  {name: 'u2-sheet-rail', url: `${H}?layout=rail`, fn: sheetRailFlow, opts: {devices: ['laptop'], ...BEHIND}},
  {name: 'u2-sheet-modal', url: H, fn: sheetModalFlow, opts: BEHIND},
  {name: 'u2-dialog', url: H, fn: dialogFlow, opts: BEHIND},
  {name: 'u2-coach', url: `${H}?demo=coach`, fn: coachFlow, opts: BEHIND},
  {name: 'u2-toast', url: `${H}?demo=toast`, fn: toastFlow, opts: BEHIND},
];
