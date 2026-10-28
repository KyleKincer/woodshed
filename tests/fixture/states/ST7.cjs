// ST7's states: the Speed, Click and Mix sheets on their harness (/__harness/sheets-a), opened
// through the real sheets host on a real song session in a Stage frame stand-in: a bottom sheet on
// the band (iPad), a 360 px popover left of the rail control on the rail (laptop). Every state runs
// with fx-audio=manual. The harness imports ST4's Stage commands (src/stage/commands.js, merged at
// I2a); no state needs a wave 2b peer.
//   st7-sheet-speed-band      value 56 + bpm, ten 56 px presets in two rows of five, −1 / +1, Keep pitch, the
//                             trainer; tapping 75 applies 75% and closes the sheet (D59); axe, targets
//   st7-sheet-speed-rail      the 360 px popover left of the Speed control; a preset tap keeps it open
//   st7-sheet-trainer         steppers → Start trainer on a two-bar loop → each wrap steps → "Trainer done — 100%"
//   st7-sheet-click-mapped    count-in choices, Custom 1–16 bars | beats, every pass, the D14 click modes,
//                             accent, volume, pre-roll, the edge flash, "At the cue", the Edit map footer; axe
//   st7-sheet-click-unmapped  Lead-in 2 s and "Needs a bar grid" with [Tap the beat] [Get bars]; no click controls
//   st7-sheet-mix-band        Minus me: Drums · I play ▾ · Only me · Full mix, Tap to: Mute · Solo, 120×168 pads
//                             three per row in canonical order; Out is hatched with OUT; Chart playback; axe
//   st7-sheet-mix-rail        160×96 pads two per row inside the 360 px popover; Solo mode; the inline picker
//   st7-sheet-mix-fallback    guitar on a four-stem song: "Muting 'Other' instead" with [Re-split with 6 stems] on
//                             the desktop, the web line without it
'use strict';

const {checkAxe} = require('../probes/probe-axe.cjs');
const {checkTargets} = require('../probes/probe-targets.cjs');

const SHEETS = (query = '') => `/__harness/sheets-a?fx-audio=manual${query ? `&${query}` : ''}`;
const REQUIRES = ['src/stage/commands.js'];
const BAND = {devices: ['ipad'], requires: REQUIRES};
const RAIL = {devices: ['laptop'], requires: REQUIRES};

async function ready(page, t) {
  await t.loadPhase('ready');
  await page.evaluate(() => document.fonts.ready);
}

/** Waits for the open sheet's content (the host loads the module, then renders). */
const sheetOpen = (page, name) => page.waitForSelector(`.ui-sheet[data-sheet="${name}"] [data-sheet-content="${name}"]`, {timeout: 10_000});
const snap = (page) => page.evaluate(() => window.__sheets.session.transport.snapshot.peek());
const box = (page, selector) => page.$eval(selector, (el) => {
  const r = el.getBoundingClientRect();
  return {x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom};
});
const font = (page, selector) => page.$eval(selector, (el) => {
  const cs = getComputedStyle(el);
  return {size: cs.fontSize, weight: cs.fontWeight, color: cs.color};
});
const tokenColour = (page, name) => page.evaluate((token) => {
  const probe = document.createElement('div');
  probe.style.color = `var(${token})`;
  document.querySelector('.ui-sheet').append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}, name);

async function axe(page, t, name) {
  const problems = await checkAxe(page, {include: [`.ui-sheet[data-sheet="${name}"]`]});
  t.expect(!problems.length, problems.join('; '));
}
async function targets(page, t) {
  const small = await checkTargets(page);
  t.expect(!small.length, `targets too small: ${JSON.stringify(small.slice(0, 5))}`);
}

module.exports = [
  {
    name: 'st7-sheet-speed-band', url: SHEETS('layout=band&sheet=speed&scenario=looping'), opts: BAND,
    async fn(page, t) {
      await ready(page, t);
      await sheetOpen(page, 'speed');
      const presentation = await page.$eval('.ui-sheet[data-sheet=speed]', (el) => el.dataset.presentation);
      t.expect(presentation === 'bottom', `a bottom sheet on the band (got ${presentation})`);
      const value = await font(page, '.sheet-speed-value');
      t.expect(value.size === '56px', `the value is 56 px (got ${value.size})`);
      const text = await page.$eval('.sheet-speed-readout', (el) => el.textContent.replace(/\s+/g, ' ').trim());
      t.expect(/^75%\s*90 bpm$/.test(text), `75% · 90 bpm (got ${text})`);
      const presets = await page.$$eval('.sheet-speed-preset', (els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return {label: el.textContent.trim(), y: Math.round(r.y), h: r.height, pressed: el.getAttribute('aria-pressed')};
      }));
      t.expect(presets.length === 10 && presets.every((p) => p.h >= 56 - 0.5), `ten 56 px presets (got ${JSON.stringify(presets)})`);
      const rows = [...new Set(presets.map((p) => p.y))];
      t.expect(rows.length === 2, `two rows of presets (got ${rows})`);
      t.expect(presets.find((p) => p.label === '75%')?.pressed === 'true', '75% is the pressed preset');
      await targets(page, t);
      await axe(page, t, 'speed');
      await t.capture('open');
      await page.getByRole('button', {name: '60%', exact: true}).click();
      await page.waitForSelector('.ui-sheet[data-sheet=speed]', {state: 'detached', timeout: 5000});
      const s = await snap(page);
      t.expect(s.rate === 0.6, `60% applied (got ${s.rate})`);
    },
  },
  {
    name: 'st7-sheet-speed-rail', url: SHEETS('layout=rail&sheet=speed'), opts: RAIL,
    async fn(page, t) {
      await ready(page, t);
      await sheetOpen(page, 'speed');
      const sheet = await box(page, '.ui-sheet[data-sheet=speed]');
      const anchor = await box(page, '[data-stage-anchor=speed]');
      const presentation = await page.$eval('.ui-sheet[data-sheet=speed]', (el) => el.dataset.presentation);
      t.expect(presentation === 'popover', `a popover on the rail (got ${presentation})`);
      t.expect(Math.abs(sheet.w - 360) < 1, `360 px wide (got ${sheet.w})`);
      t.expect(sheet.right <= anchor.x + 1, `left of the Speed control (${sheet.right} ≤ ${anchor.x})`);
      await page.getByRole('button', {name: '75%', exact: true}).click();
      t.expect((await snap(page)).rate === 0.75, '75% applied');
      t.expect(await page.$('.ui-sheet[data-sheet=speed]') !== null, 'the popover stays open (D59 is the band\'s)');
      await page.getByRole('button', {name: '−1%', exact: true}).click();
      t.expect((await snap(page)).rate === 0.74, '−1% → 74%');
      const bpm = await page.$eval('.sheet-speed-bpm', (el) => el.textContent);
      t.expect(bpm === '89 bpm', `the bpm follows (got ${bpm})`);
      const keep = page.getByRole('button', {name: 'Keep pitch', exact: true});
      await keep.click();
      t.expect((await snap(page)).keepPitch === false, 'Keep pitch off for this song');
      await targets(page, t);
      await axe(page, t, 'speed');
      await t.capture('open');
    },
  },
  {
    name: 'st7-sheet-trainer', url: SHEETS('layout=rail&sheet=speed&scenario=trainer'), opts: {...RAIL, themes: ['dark']},
    async fn(page, t) {
      await ready(page, t);
      await sheetOpen(page, 'speed');
      const start = page.getByRole('spinbutton', {name: 'Start', exact: true});
      await start.focus();
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      const step = page.getByRole('spinbutton', {name: 'Step', exact: true});
      await step.focus();
      for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
      const passes = page.getByRole('spinbutton', {name: 'Passes per step', exact: true});
      await passes.focus();
      await page.keyboard.press('ArrowDown');
      const plan = await page.$eval('.sheet-speed-plan', (el) => el.textContent);
      t.expect(plan === '80% → 100% in 3 steps, 1 pass each', `the plan (got ${plan})`);
      const on = await page.$eval('.sheet-speed-trains-on', (el) => el.textContent);
      t.expect(on === 'Trains on: Bars 17–18', `trains on the loop (got ${on})`);
      await page.getByRole('button', {name: 'Start trainer', exact: true}).click();
      let progress = await page.$eval('.sheet-speed-progress', (el) => el.textContent);
      t.expect(progress === 'Step 1 of 3 · 80%', `step 1 (got ${progress})`);
      await page.evaluate(() => window.__sheets.session.transport.play());
      await t.transportPhase('playing');
      await t.advance(Math.ceil((4 / 0.8 + 0.3) * 1000));
      progress = await page.$eval('.sheet-speed-progress', (el) => el.textContent);
      t.expect(progress === 'Step 2 of 3 · 90%', `step 2 at the wrap (got ${progress})`);
      await t.advance(Math.ceil((4 / 0.9 + 0.3) * 1000));
      await page.waitForSelector('.sheet-speed-progress[data-done=true]', {timeout: 5000});
      progress = await page.$eval('.sheet-speed-progress', (el) => el.textContent);
      t.expect(progress === 'Trainer done — 100%', `the done line (got ${progress})`);
      t.expect((await snap(page)).rate === 1, 'looping on at 100%');
      await t.capture('done');
      await page.evaluate(() => window.__sheets.session.transport.stop());
    },
  },
  {
    name: 'st7-sheet-click-mapped', url: SHEETS('sheet=click&scenario=looping'), opts: {requires: REQUIRES},
    async fn(page, t) {
      await ready(page, t);
      await sheetOpen(page, 'click');
      const countIn = page.getByRole('radiogroup', {name: 'Count-in', exact: true});
      t.expect(await countIn.getByRole('radio', {name: '2 bars', exact: true}).getAttribute('aria-checked') === 'true', '2 bars is chosen');
      await countIn.getByRole('radio', {name: 'Custom', exact: true}).click();
      const length = page.getByRole('spinbutton', {name: 'Count-in length', exact: true});
      await length.focus();
      await page.keyboard.press('End');
      t.expect((await snap(page)).countIn.length === 16, 'custom up to 16');
      await page.getByRole('radiogroup', {name: 'Count-in unit', exact: true}).getByRole('radio', {name: 'Beats', exact: true}).click();
      t.expect(JSON.stringify((await snap(page)).countIn) === JSON.stringify({on: true, length: 16, unit: 'beats'}), 'custom 16 beats');
      const click = page.getByRole('radiogroup', {name: 'Click', exact: true});
      await click.getByRole('radio', {name: 'Always', exact: true}).click();
      t.expect((await snap(page)).click.mode === 'always', 'Click Always (D14)');
      await page.getByRole('button', {name: 'Play the song during count-in', exact: true}).click();
      t.expect((await snap(page)).click.preRoll === true, 'pre-roll on');
      const cue = await page.$eval('.sheet-click-at-cue', (el) => el.textContent);
      t.expect(cue === 'At the cue: ♩ = 120 · 4/4 · from the map', `the at-the-cue line (got ${cue})`);
      const flash = page.getByRole('button', {name: 'Flash screen edges on downbeats', exact: true});
      t.expect(await flash.getAttribute('aria-pressed') === 'false', 'edge flash off by default');
      await t.capture('open');
      await targets(page, t);
      await axe(page, t, 'click');
      await page.getByRole('button', {name: 'Edit map', exact: true}).click();
      const navigations = await page.evaluate(() => window.__sheets.navigations);
      t.expect(navigations.at(-1) === '/s/glasshouse/edit/map', `Edit map navigates (got ${navigations})`);
      await page.waitForSelector('.ui-sheet[data-sheet=click]', {state: 'detached', timeout: 5000});
    },
  },
  {
    name: 'st7-sheet-click-unmapped', url: SHEETS('sheet=click&mapped=0'), opts: {requires: REQUIRES},
    async fn(page, t) {
      await ready(page, t);
      await sheetOpen(page, 'click');
      const leadIn = page.getByRole('button', {name: 'Lead-in 2 s', exact: true});
      await leadIn.click();
      t.expect((await snap(page)).countIn.on === true, 'the Lead-in is on');
      t.expect(await page.getByRole('radiogroup', {name: 'Click', exact: true}).count() === 0, 'no click modes without a bar grid');
      t.expect(await page.getByRole('slider', {name: 'Click volume', exact: true}).count() === 0, 'no click volume');
      const grid = await page.$eval('.sheet-click-needs-grid', (el) => el.textContent.replace(/\s+/g, ' ').trim());
      t.expect(grid.startsWith('Needs a bar grid'), `Needs a bar grid (got ${grid})`);
      await t.capture('open');
      await axe(page, t, 'click');
      await page.getByRole('button', {name: 'Get bars', exact: true}).click();
      const sheets = await page.evaluate(() => window.__sheets.sheets);
      t.expect(sheets.at(-1) === 'getBars', `Get bars asks the Stage for its sheet (got ${sheets})`);
    },
  },
  {
    name: 'st7-sheet-mix-band', url: SHEETS('layout=band&sheet=mix&scenario=looping&part=1'), opts: BAND,
    async fn(page, t) {
      await ready(page, t);
      await sheetOpen(page, 'mix');
      const minus = page.getByRole('button', {name: 'Minus me: Drums', exact: true});
      t.expect(await minus.getAttribute('aria-pressed') === 'true', 'Minus me is on (drums out)');
      const minusBox = await minus.boundingBox();
      t.expect(minusBox.height >= 56 - 0.5, `the 56 px Minus me toggle (got ${minusBox.height})`);
      const pads = await page.$$eval('.sheet-mix-pads .ui-stem-pad', (els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return {name: el.getAttribute('aria-label'), w: r.width, h: r.height, y: Math.round(r.y), state: el.dataset.state};
      }));
      t.expect(JSON.stringify(pads.map((p) => p.name)) === JSON.stringify(['Drums', 'Bass', 'Vocals', 'Other']), `canonical order (got ${pads.map((p) => p.name)})`);
      t.expect(pads.every((p) => Math.abs(p.w - 120) < 1 && p.h >= 168 - 0.5), `120×168 pads (got ${JSON.stringify(pads)})`);
      t.expect(pads[0].y === pads[2].y && pads[3].y > pads[0].y, `three per row (got ${pads.map((p) => p.y)})`);
      t.expect(pads[0].state === 'out', 'drums are out');
      const word = await page.$eval('.ui-stem-pad[data-stem=drums] .ui-stem-pad-word', (el) => ({text: el.textContent, line: getComputedStyle(el).textDecorationLine}));
      t.expect(word.text === 'OUT' && word.line.includes('line-through'), `OUT struck through (got ${JSON.stringify(word)})`);
      const chart = page.getByRole('radiogroup', {name: 'Chart playback', exact: true});
      await chart.getByRole('radio', {name: 'Quiet', exact: true}).click();
      t.expect((await snap(page)).mix.chartAudio === 'quiet', 'Chart playback Quiet');
      await targets(page, t);
      await axe(page, t, 'mix');
      await t.capture('open');
      await page.getByRole('button', {name: 'Full mix', exact: true}).click();
      const s = await snap(page);
      t.expect(s.mix.tracks.every((x) => !x.muted && !x.soloed && x.volume === 1), 'Full mix resets mute, solo and levels');
    },
  },
  {
    name: 'st7-sheet-mix-rail', url: SHEETS('layout=rail&sheet=mix&stems=drums,bass,guitar,piano,vocals,other'), opts: RAIL,
    async fn(page, t) {
      await ready(page, t);
      await sheetOpen(page, 'mix');
      const sheet = await box(page, '.ui-sheet[data-sheet=mix]');
      t.expect(Math.abs(sheet.w - 360) < 1, `the 360 px popover (got ${sheet.w})`);
      const pads = await page.$$eval('.sheet-mix-pads .ui-stem-pad', (els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return {name: el.getAttribute('aria-label'), w: r.width, h: r.height, y: Math.round(r.y), right: r.right};
      }));
      t.expect(pads.length === 6 && pads.every((p) => Math.abs(p.w - 160) < 1 && p.h >= 96 - 0.5), `160×96 pads (got ${JSON.stringify(pads)})`);
      t.expect(pads[0].y === pads[1].y && pads[2].y > pads[1].y, 'two per row');
      t.expect(pads.every((p) => p.right <= sheet.right + 0.5), 'the pads fit inside the popover');
      await page.getByRole('radiogroup', {name: 'Tap to', exact: true}).getByRole('radio', {name: 'Solo', exact: true}).click();
      await page.getByRole('button', {name: 'Solo Guitar', exact: true}).click();
      await page.waitForFunction(() => window.__sheets.session.transport.snapshot.peek().mix.tracks.find((x) => x.name === 'guitar').soloed, null, {timeout: 3000});
      const ring = await page.$eval('.ui-stem-pad[data-stem=guitar]', (el) => el.dataset.state);
      t.expect(ring === 'solo', `SOLO (got ${ring})`);
      await page.getByRole('button', {name: 'I play: Drums', exact: true}).click();
      await page.getByRole('button', {name: 'Guitar', exact: true}).click();
      await page.waitForFunction(() => window.__sheets.patches.length > 0, null, {timeout: 3000});
      const patch = await page.evaluate(() => window.__sheets.patches.at(-1));
      t.expect(JSON.stringify(patch.profile.instruments) === '["drums","guitar"]', `the profile is written (got ${JSON.stringify(patch)})`);
      await page.getByRole('button', {name: 'Minus me: Drums + Guitar', exact: true}).waitFor({timeout: 3000});
      await targets(page, t);
      await axe(page, t, 'mix');
      await t.capture('open');
    },
  },
  {
    name: 'st7-sheet-mix-fallback', url: SHEETS('layout=rail&sheet=mix&profile=guitar&desktop=1'), opts: {...RAIL, themes: ['dark']},
    async fn(page, t) {
      await ready(page, t);
      await sheetOpen(page, 'mix');
      const line = await page.$eval('.sheet-mix-note-text', (el) => el.textContent);
      t.expect(line === 'This song wasn\'t split with a guitar part. Muting \'Other\' instead.', `the desktop line (got ${line})`);
      t.expect(await page.getByRole('button', {name: 'Re-split with 6 stems', exact: true}).isVisible(), '[Re-split with 6 stems] on the desktop');
      await page.getByRole('button', {name: 'Minus me: Other', exact: true}).click();
      const s = await snap(page);
      t.expect(s.mix.tracks.find((x) => x.name === 'other').muted, 'Other is muted');
      await t.capture('desktop');
      await page.goto(`${t.base}${SHEETS('layout=rail&sheet=mix&profile=guitar')}`);
      await ready(page, t);
      await sheetOpen(page, 'mix');
      const web = await page.$eval('.sheet-mix-note-text', (el) => el.textContent);
      t.expect(web === 'This song wasn\'t split with a guitar part. Muting \'Other\' instead. Re-split it from Woodshed for desktop.', `the web line (got ${web})`);
      t.expect(await page.getByRole('button', {name: 'Re-split with 6 stems', exact: true}).count() === 0 ||
        !(await page.getByRole('button', {name: 'Re-split with 6 stems', exact: true}).isVisible()), 'no Re-split on the web');
    },
  },
];
