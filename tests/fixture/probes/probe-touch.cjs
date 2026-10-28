// Touch probe (architecture §10.3–10.4): long-press menus and stray taps,
// driven through real CDP touch events (lib/touch.cjs). Adapted from the 1.9
// critique probe for the runner; states call
//   const {longPressOpens, tapDoesNotChange} = require('../probes/probe-touch.cjs');
//   await longPressOpens(page, page.getByRole('button', {name: 'Glasshouse'}), {ms: 500, opens: '[role=menu]'});
//   await tapDoesNotChange(page, {x, y}, () => window.__woodshed.activeSession().transport.position());
// Each returns {ok, …} and never throws for a failed expectation, so a state
// can collect several. The page must come from a context with hasTouch: true.
'use strict';

const {createTouch} = require('../lib/touch.cjs');

/** Long-press `target` for `ms`; ok when `opens` (a selector) becomes visible within `withinMs` after release. */
async function longPressOpens(page, target, {ms = 500, opens = '[role=menu]', withinMs = 1500, touch} = {}) {
  const driver = touch ?? await createTouch(page);
  try {
    await driver.longPress(target, {ms: ms + 50});
    const appeared = await page.locator(opens).first().waitFor({state: 'visible', timeout: withinMs}).then(() => true, () => false);
    return {ok: appeared, opens, ms};
  } finally { if (!touch) await driver.detach(); }
}

/** A long-press shorter than `ms` must not open `opens` (a plain tap stays a tap). */
async function shortPressDoesNotOpen(page, target, {ms = 500, opens = '[role=menu]', touch} = {}) {
  const driver = touch ?? await createTouch(page);
  try {
    await driver.longPress(target, {ms: Math.max(50, ms - 200)});
    const visible = await page.locator(opens).first().isVisible().catch(() => false);
    return {ok: !visible, opens, ms};
  } finally { if (!touch) await driver.detach(); }
}

/** Tap `target` and compare `read()` (run in the page) before and after: a stray tap must not change it. */
async function tapDoesNotChange(page, target, read, {settleMs = 300, touch} = {}) {
  const driver = touch ?? await createTouch(page);
  try {
    const before = await page.evaluate(read);
    await driver.tap(target);
    await page.waitForTimeout(settleMs);
    const after = await page.evaluate(read);
    return {ok: JSON.stringify(before) === JSON.stringify(after), before, after};
  } finally { if (!touch) await driver.detach(); }
}

module.exports = {longPressOpens, shortPressDoesNotOpen, tapDoesNotChange};
