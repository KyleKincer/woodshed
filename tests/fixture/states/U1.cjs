// U1's states: the action and input primitives on their harness (/__harness/actions).
//   u1-actions      buttons, icon buttons, toggles, hold buttons, the dock sizes; targets probe
//   u1-inputs       segmented, chips, steppers, slider, fader, fields; targets probe
//   u1-pads         stem pads (band and rail) on the Stage tokens; targets probe
//   u1-focus        every focus stop shows the focus ring (laptop)
//   u1-keys         real keys through the dispatcher: a focused slider, stepper and segmented
//                   group consume only their keys; Space and digits reach the registry; a command
//                   button follows the registry live (laptop)
//   u1-pointer      mouse: long-press, hold-to-leave with the ring, the hint on a short press, the
//                   stepper's hold-to-repeat, a slider drag (laptop)
//   u1-touch        touch: a pad tap mutes, a double tap resets the level, a long-press solos, a
//                   vertical drag sets the level (iPad, CDP touch)
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');

const BASE = '/__harness/actions';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = page => page.evaluate(() => [...window.__u1.log]);
const until = async (page, fn, arg, ms = 3000) => {
  try { await page.waitForFunction(fn, arg, {timeout: ms}); return true; } catch { return false; }
};

/** Target sizes (spec §8.2): fine ≥ 24, coarse ≥ 44; the dock controls ≥ their dock tokens. */
async function targets(page, t) {
  const rules = [
    {selector: '[data-stage-layout=band] .ui-button[data-size=dock]', min: 64},
    {selector: '[data-stage-layout=band] .ui-button[data-size=play]', min: 80},
  ];
  const problems = await checkTargets(page, {rules});
  t.expect(!problems.length, `targets:\n${problems.join('\n')}`);
}

module.exports = [
  {name: 'u1-actions', url: `${BASE}?part=actions`, fn: targets, opts: {fullPage: true}},
  {name: 'u1-inputs', url: `${BASE}?part=inputs`, fn: targets, opts: {fullPage: true}},
  {name: 'u1-pads', url: `${BASE}?part=pads&place=stage`, fn: targets, opts: {fullPage: true}},
  {
    name: 'u1-focus',
    url: `${BASE}`,
    opts: {devices: ['laptop'], themes: ['light', 'dark'], capture: false},
    async fn(page, t) {
      const problems = await walkFocus(page, {stops: 120});
      t.expect(!problems.length, `focus:\n${problems.join('\n')}`);
    },
  },
  {
    name: 'u1-keys',
    url: `${BASE}`,
    opts: {devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      const volume = page.getByRole('slider', {name: 'Volume'});
      await volume.focus();
      const before = await volume.getAttribute('aria-valuenow');
      await page.keyboard.press('Space');
      await page.keyboard.press('Digit1');
      await page.keyboard.press('PageUp');
      t.expect(await volume.getAttribute('aria-valuenow') === before, 'Space, 1 and PageUp leave the focused slider alone');
      const ran = await log(page);
      t.expect(['cmd:transport.playStop', 'cmd:mix.mute.1', 'cmd:section.prev'].every(id => ran.includes(id)), `Space, 1 and PageUp reach the registry (${ran})`);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Shift+ArrowRight');
      t.expect(await volume.getAttribute('aria-valuenow') === '0.71', `arrows move the slider (${await volume.getAttribute('aria-valuenow')})`);
      await page.keyboard.press('End');
      t.expect(await volume.getAttribute('aria-valuetext') === '100%', 'End goes to the maximum');

      const beats = page.getByRole('spinbutton', {name: 'Beats'});
      await beats.focus();
      await page.keyboard.press('PageUp');
      await page.keyboard.press('ArrowDown');
      t.expect(await beats.getAttribute('aria-valuenow') === '13', `a focused stepper takes PageUp and arrows (${await beats.getAttribute('aria-valuenow')})`);
      const sections = (await log(page)).filter(x => x === 'cmd:section.prev').length;
      t.expect(sections === 1, 'PageUp on the stepper did not reach the registry');

      const mute = page.getByRole('radiogroup', {name: 'Tap to'}).first().getByRole('radio', {name: 'Mute'});
      await mute.focus();
      await page.keyboard.press('ArrowRight');
      const solo = page.getByRole('radiogroup', {name: 'Tap to'}).first().getByRole('radio', {name: 'Solo'});
      t.expect(await solo.getAttribute('aria-checked') === 'true', 'arrows move the segmented choice');
      t.expect(await page.evaluate(() => document.activeElement?.textContent) === 'Solo', 'focus follows the choice');

      const loop = page.getByRole('button', {name: 'Loop', exact: true}).first();
      t.expect(await loop.getAttribute('aria-pressed') === 'false', 'the Loop command button starts unpressed');
      t.expect(await loop.getAttribute('aria-keyshortcuts') === 'L', 'aria-keyshortcuts comes from keys[0]');
      await page.locator('body').focus();
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('KeyL');
      t.expect(await until(page, () => [...document.querySelectorAll('button[aria-keyshortcuts="L"]')].some(b => b.getAttribute('aria-pressed') === 'true')),
        'L runs the command and the button shows it pressed (registry onChange)');
      const countIn = page.getByRole('button', {name: /^Count-in/});
      await countIn.click();
      t.expect(await until(page, () => [...document.querySelectorAll('button[aria-keyshortcuts="C"]')].some(b => b.getAttribute('aria-pressed') === 'true')), 'a command toggle runs with a click');
      const resplit = page.getByRole('button', {name: 'Re-split…'});
      t.expect(await resplit.getAttribute('aria-disabled') === 'true', 'a command with a disabled reason is disabled');
      t.expect((await resplit.textContent()).includes('Re-split from Woodshed for desktop.'), 'its reason is visible');
      await resplit.click({force: true});
      t.expect(!(await log(page)).includes('cmd:song.resplit'), 'a disabled command button never runs');
    },
  },
  {
    name: 'u1-pointer',
    url: `${BASE}?part=actions`,
    opts: {devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      const press = async (locator, ms) => {
        const box = await locator.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await sleep(ms);
        await page.mouse.up();
      };
      const long = page.getByRole('button', {name: 'Hold me'});
      await press(long, 650);
      let ran = await log(page);
      t.expect(ran.includes('longpress:long') && !ran.includes('click:long'), `a 500 ms press long-presses and drops the click (${ran})`);
      await long.click();
      t.expect((await log(page)).includes('click:long'), 'a click still clicks');

      const hold = page.getByRole('button', {name: 'Library'});
      await hold.click();
      t.expect((await log(page)).includes('hold:activate'), 'stopped: the hold button acts on a click');
      await page.getByRole('button', {name: 'Playing'}).click();
      await press(hold, 150);
      ran = await log(page);
      t.expect(ran.filter(x => x === 'hold:hint').length === 1 && ran.filter(x => x === 'hold:activate').length === 1, `playing: a short press only hints (${ran})`);
      // U3's ProgressRing: hidden at rest, shown and part-filled mid-hold, and the only ring there.
      const ringState = el => {
        const ring = el.querySelector('.ui-hold-icon > .ui-progress-ring');
        const fillEl = ring?.querySelector('.ui-progress-ring-fill');
        const fill = fillEl ? Number.parseFloat(fillEl.getAttribute('stroke-dasharray')) / 100 : NaN;
        return {holding: el.hasAttribute('data-holding'), ring: !!ring, rings: el.querySelectorAll('.ui-hold-icon > :not(.ui-icon)').length,
          visible: ring ? getComputedStyle(ring).visibility : 'none', fill};
      };
      const rest = await hold.evaluate(ringState);
      t.expect(rest.ring && rest.visible === 'hidden', `no ring shows at rest (${JSON.stringify(rest)})`);
      t.expect(rest.rings === 1, `the ProgressRing is the only ring (${JSON.stringify(rest)})`);
      const box = await hold.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await sleep(300);
      const midHold = await hold.evaluate(ringState);
      t.expect(midHold.holding, 'the button shows the hold while it runs');
      t.expect(midHold.visible === 'visible', `the ring shows mid-hold (${midHold.visible})`);
      t.expect(midHold.fill > 0.2 && midHold.fill < 0.8, `the ring is part-filled mid-hold (${midHold.fill})`);
      await sleep(450);
      await page.mouse.up();
      ran = await log(page);
      t.expect(ran.filter(x => x === 'hold:activate').length === 2, `a 600 ms hold acts (${ran})`);

      const plus = page.getByRole('button', {name: 'Increase Speed'});
      await press(plus, 400 + 80 * 4 + 40);
      const speed = await page.getByRole('spinbutton', {name: 'Speed'}).getAttribute('aria-valuetext');
      t.expect(['95%', '100%', '105%'].includes(speed), `holding + repeats (got ${speed})`);
      await page.getByRole('spinbutton', {name: 'Speed'}).click();
      t.expect((await log(page)).includes('speed:open'), 'tapping the speed value opens its sheet');
    },
  },
  {
    name: 'u1-slider-drag',
    url: `${BASE}?part=inputs`,
    opts: {devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      const volume = page.getByRole('slider', {name: 'Volume'});
      const box = await volume.boundingBox();
      await page.mouse.move(box.x + 10, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2, {steps: 6});
      await page.mouse.move(box.x + box.width + 200, box.y + 300, {steps: 3});   // capture keeps the drag
      await page.mouse.up();
      t.expect(await volume.getAttribute('aria-valuetext') === '100%', `a drag past the end clamps (${await volume.getAttribute('aria-valuetext')})`);
      t.expect((await log(page)).filter(x => x.startsWith('volume:')).length === 1, 'one change on release');
      const fader = page.getByRole('slider', {name: 'Drums level'});
      const fb = await fader.boundingBox();
      await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2);
      await page.mouse.dblclick(fb.x + fb.width / 4, fb.y + fb.height / 2);
      t.expect(await fader.getAttribute('aria-valuetext') === '100%', 'a double click resets the fader');
      const tags = page.getByRole('textbox', {name: 'Tags'});
      await tags.click();
      await page.keyboard.type('Soul,');
      await page.keyboard.type('Gospel');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Backspace');
      t.expect((await log(page)).includes('tags:Funk+Live+Soul'), `comma commits, Backspace removes the last (${await log(page)})`);
      await page.keyboard.press('Space');
      t.expect(!(await log(page)).includes('cmd:transport.playStop'), 'a text field keeps Space');
    },
  },
  {
    name: 'u1-touch',
    url: `${BASE}?part=pads&place=stage`,
    opts: {devices: ['ipad'], themes: ['dark'], capture: false},
    async fn(page, t) {
      const touch = await t.touch();
      const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
      t.expect(coarse, 'the iPad device has a coarse pointer');
      const drums = page.getByRole('group', {name: 'Drums'}).first();
      const main = drums.getByRole('button', {name: 'Mute Drums'});
      await touch.tap(main);
      t.expect(await until(page, () => window.__u1.log.includes('pad:drums:toggle')), 'a tap mutes after the double-tap window');
      t.expect(await main.getAttribute('aria-pressed') === 'true', 'the pad shows OUT');

      const bass = page.getByRole('group', {name: 'Bass'}).first();
      await touch.doubleTap(bass.getByRole('button', {name: 'Mute Bass'}), {gapMs: 80});
      t.expect(await until(page, () => window.__u1.log.includes('pad:bass:level:100')), 'a double tap sets 100%');
      await sleep(400);
      t.expect(!(await log(page)).includes('pad:bass:toggle'), 'a double tap never flips the mute');

      const piano = page.getByRole('group', {name: 'Piano'}).first();
      await touch.longPress(piano.getByRole('button', {name: 'Mute Piano'}), {ms: 650});
      t.expect(await until(page, () => window.__u1.log.includes('pad:piano:solo')), 'a long-press solos');
      t.expect(await piano.getAttribute('data-state') === 'solo', 'the pad shows SOLO');

      const vocals = page.getByRole('group', {name: 'Vocals'}).first();
      const vb = await vocals.boundingBox();
      await touch.drag({x: vb.x + vb.width / 2, y: vb.y + vb.height * 0.8}, {x: vb.x + vb.width / 2, y: vb.y + vb.height * 0.3}, {steps: 10});
      t.expect(await until(page, () => window.__u1.log.some(x => x.startsWith('pad:vocals:level:'))), 'a vertical drag sets the level');
      const level = await vocals.getByRole('slider', {name: 'Vocals level'}).getAttribute('aria-valuetext');
      t.expect(level === '100%', `dragging up raises the level (${level})`);
      await sleep(400);
      t.expect(!(await log(page)).includes('pad:vocals:toggle'), 'a drag never toggles');
    },
  },
];
