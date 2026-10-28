// S2's states: the ⌘K palette, the ? sheet and toasts on /__harness/feedback (tests/harness/app/feedback.harness.js),
// over the rehearsal song (glasshouse: 64 mapped bars, 2 s each; Bridge at bar 37, Chorus 2 at bar 29).
//   s2-palette-empty      the empty palette: In this song (sections, spots), Commands, Songs, Navigation; 640 px top-centred
//                         on the laptop, 44 px rows and a 52 px input
//   s2-palette-bar        `57`: Go to bar 57 first (mapped), Speed 57% second; Enter goes to 1:52
//   s2-palette-speed      `75%`: Speed 75% → speed.set {rate: 0.75}
//   s2-palette-loop       `loop 41-48`: Loop bars 41–48 → transport.loopRange(80, 96)
//   s2-palette-resplit    `re-split`: the Re-split… row disabled with its visible reason; Enter runs nothing
//   s2-palette-songs      `glass` in the Library: song titles; Enter opens the Stage, ⌘Enter Details
//   s2-palette-band       the band layout (iPad): a full-width top sheet
//   s2-palette-keys       ⌘K / Ctrl+K opens it, typing filters, ↓ and Enter run the section; Esc returns focus
//   s2-shortcuts          the ? sheet: Here (the Stage chain) first, then Elsewhere; ? opens and closes it
//   s2-toasts             a toast bottom-centre; held while playing and released on stop; Undo clickable
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');

const H = '/__harness/feedback';
const STAGE = `${H}?place=stage`;
const viewport = page => page.evaluate(() => ({w: document.documentElement.clientWidth, h: window.innerHeight}));
const state = page => page.evaluate(() => window.__feedback.state());
const calls = page => page.evaluate(() => window.__feedback.calls);
const settle = locator => locator.evaluate(el => Promise.all(el.getAnimations({subtree: true}).map(a => a.finished.catch(() => null))));
const mod = t => (t.device === 'laptop' ? 'Control' : 'Meta');   // the Linux laptop gets Ctrl, fx-platform=ipad ⌘

async function expectTargets(t, rules = []) {
  const problems = await checkTargets(t.page, {rules});
  t.expect(!problems.length, `targets: ${problems.join('; ')}`);
}

async function paletteOpen(page) {
  const box = page.locator('dialog.app-palette .app-palette-box');
  await box.waitFor();
  await settle(box);
  return box;
}

async function emptyFlow(page, t) {
  const box = await paletteOpen(page);
  const s = await state(page);
  const groups = [...new Set(s.palette.items.map(i => i.group))];
  t.expect(JSON.stringify(groups) === JSON.stringify(['song', 'commands', 'songs', 'navigation']), `group order (${groups.join(', ')})`);
  const headings = await page.locator('.app-palette-heading').allTextContents();
  t.expect(headings[0] === 'In this song', `first heading is In this song (${headings.join(', ')})`);
  t.expect(await page.evaluate(() => document.activeElement?.classList.contains('app-palette-input')), 'the input has focus');
  const input = await page.locator('.app-palette-input').boundingBox();
  t.expect(Math.round(input.height) === 52, `the input is 52 px (${input.height})`);
  const rows = await page.locator('.app-palette-row').evaluateAll(list => list.slice(0, 8).map(r => r.getBoundingClientRect().height));
  t.expect(rows.every(hh => hh >= 43.5), `rows are at least 44 px (${rows.join(', ')})`);
  if (t.device === 'laptop') {
    const b = await box.boundingBox();
    const v = await viewport(page);
    t.expect(Math.abs(b.width - 640) <= 1, `640 px wide (${b.width})`);
    t.expect(Math.abs(b.x + b.width / 2 - v.w / 2) <= 1, 'centred');
    t.expect(b.y > 40 && b.y < v.h * 0.2, `near the top (${b.y})`);
    const list = await page.locator('.app-palette-list').evaluate(el => ({h: el.clientHeight, scroll: el.scrollHeight}));
    t.expect(list.h >= 8 * 44, `eight rows visible (${list.h})`);
  }
  await expectTargets(t);
}

const query = q => async (page, t) => {
  await paletteOpen(page);
  t.expect(await page.locator('.app-palette-input').inputValue() === q, `the query is ${q}`);
};

async function barFlow(page, t) {
  await query('57')(page, t);
  const s = await state(page);
  t.expect(s.palette.items[0]?.title === 'Go to bar 57' && s.palette.items[0].group === 'song', `first: Go to bar 57 (${s.palette.items[0]?.title})`);
  t.expect(s.palette.items[1]?.title === 'Speed 57%', `second: Speed 57% (${s.palette.items[1]?.title})`);
  t.expect(s.palette.active === 'Go to bar 57', 'the bar row is active');
  await t.capture('bar');
  await page.keyboard.press('Enter');
  await page.locator('dialog.app-palette').waitFor({state: 'detached'});
  const ran = await calls(page);
  t.expect(JSON.stringify(ran.at(-1)) === JSON.stringify(['nav.goTo', {t: 112}]), `nav.goTo {t: 112} (${JSON.stringify(ran)})`);
  await page.locator('#fb-palette').click();
  await paletteOpen(page);
}

async function speedFlow(page, t) {
  await query('75%')(page, t);
  const s = await state(page);
  t.expect(s.palette.items[0]?.title === 'Speed 75%', `Speed 75% (${s.palette.items[0]?.title})`);
  await t.capture('speed');
  await page.keyboard.press('Enter');
  const ran = await calls(page);
  t.expect(JSON.stringify(ran.at(-1)) === JSON.stringify(['speed.set', {rate: 0.75}]), `speed.set {rate: 0.75} (${JSON.stringify(ran)})`);
  await page.locator('#fb-palette').click();
  await paletteOpen(page);
}

async function loopFlow(page, t) {
  await query('loop 41-48')(page, t);
  const s = await state(page);
  t.expect(s.palette.items[0]?.title === 'Loop bars 41–48', `Loop bars 41–48 (${s.palette.items[0]?.title})`);
  await t.capture('loop');
  await page.keyboard.press('Enter');
  const ran = await calls(page);
  t.expect(JSON.stringify(ran.at(-1)) === JSON.stringify(['transport.loopRange', 80, 96, {label: 'Bars 41–48', snap: 'bar'}]),
    `loopRange(80, 96) (${JSON.stringify(ran)})`);
  await page.locator('#fb-palette').click();
  await paletteOpen(page);
}

async function resplitFlow(page, t) {
  await query('re-split')(page, t);
  const row = page.locator('.app-palette-row', {hasText: 'Re-split…'});
  t.expect(await row.getAttribute('aria-disabled') === 'true', 'the row is disabled');
  t.expect(await row.locator('.app-palette-reason').isVisible(), 'the reason is visible');
  t.expect((await row.locator('.app-palette-reason').textContent()) === 'Re-split from Woodshed for desktop.', 'the reason text');
  await page.keyboard.press('Enter');
  t.expect((await state(page)).palette.open, 'Enter on a disabled row keeps the palette open');
  t.expect(!(await calls(page)).some(c => c[0] === 'song.resplit'), 'nothing ran');
}

async function songsFlow(page, t) {
  await query('glass')(page, t);
  const s = await state(page);
  const songs = s.palette.items.filter(i => i.group === 'songs').map(i => i.title);
  t.expect(songs[0] === 'Glasshouse', `Glasshouse first (${songs.join(', ')})`);
  t.expect(!s.palette.items.some(i => i.group === 'song'), 'no In this song group without an open song');
  await page.keyboard.press(`${mod(t)}+Enter`);
  const last = (await calls(page)).at(-1);
  t.expect(JSON.stringify(last) === JSON.stringify(['router.navigate', '/s/glasshouse/edit/details']), `⌘Enter opens Details (${JSON.stringify(last)})`);
  await page.locator('#fb-palette').click();
  await paletteOpen(page);
  await page.locator('.app-palette-input').fill('glass');
  await page.keyboard.press('Enter');
  const open = (await calls(page)).at(-1);
  t.expect(JSON.stringify(open) === JSON.stringify(['router.navigate', '/s/glasshouse']), `Enter opens the Stage (${JSON.stringify(open)})`);
  await page.locator('#fb-palette').click();
  await paletteOpen(page);
  await page.locator('.app-palette-input').fill('glass');
}

async function bandFlow(page, t) {
  const box = await paletteOpen(page);
  t.expect(await page.locator('dialog.app-palette').getAttribute('data-layout') === 'band', 'band layout');
  const b = await box.boundingBox();
  const v = await viewport(page);
  t.expect(Math.abs(b.x) <= 1 && Math.abs(b.width - v.w) <= 1, `full width (${b.x}, ${b.width} of ${v.w})`);
  t.expect(Math.abs(b.y) <= 1, `at the top (${b.y})`);
  await expectTargets(t);
}

async function keysFlow(page, t) {
  await page.focus('#fb-shortcuts');
  await page.keyboard.press(`${mod(t)}+KeyK`);
  await paletteOpen(page);
  await page.keyboard.type('chorus');
  let s = await state(page);
  t.expect(s.palette.active === 'Chorus', `Chorus is active (${s.palette.active})`);
  await page.keyboard.press('ArrowDown');
  s = await state(page);
  t.expect(s.palette.active === 'Chorus 2', `↓ moves to Chorus 2 (${s.palette.active})`);
  await page.keyboard.press(`${mod(t)}+Enter`);
  await page.locator('dialog.app-palette').waitFor({state: 'detached'});
  const ran = await calls(page);
  t.expect(JSON.stringify(ran.at(-1)) === JSON.stringify(['transport.loopRange', 56, 72, {label: 'Chorus 2', snap: 'bar'}]),
    `⌘Enter loops Chorus 2 (${JSON.stringify(ran.at(-1))})`);
  t.expect(await page.evaluate(() => document.activeElement?.id) === 'fb-shortcuts', 'focus returns to where it was');
  await page.keyboard.press(`${mod(t)}+KeyK`);
  await paletteOpen(page);
  await page.keyboard.press('Escape');
  await page.locator('dialog.app-palette').waitFor({state: 'detached'});
  t.expect(await page.evaluate(() => document.activeElement?.id) === 'fb-shortcuts', 'Esc returns focus');
  await page.keyboard.press(`${mod(t)}+KeyK`);
  await paletteOpen(page);
}

async function shortcutsFlow(page, t) {
  const dialog = page.locator('dialog.app-shortcuts');
  await dialog.waitFor();
  await settle(dialog);
  const first = await dialog.locator('.app-shortcuts-section').first();
  t.expect((await first.getAttribute('data-section')) === 'here', 'Here comes first');
  t.expect((await first.locator('h3').textContent()) === 'Here: Stage', 'the Stage chain');
  t.expect(await dialog.locator('[data-section=elsewhere][data-scope=library]').count() === 1, 'the Library block is under Elsewhere');
  const palette = dialog.locator('[data-command-id="app.palette"] kbd').first();
  const cap = await palette.textContent();
  t.expect(cap === (t.device === 'laptop' ? 'Ctrl+K' : '⌘K'), `the palette key-cap (${cap})`);
  t.expect(await palette.isVisible(), 'key-caps are shown on every device in the sheet');
  await t.capture('open');
  await page.keyboard.press('?');
  await dialog.waitFor({state: 'detached'});
  await page.focus('#fb-palette');
  await page.keyboard.press('?');
  await page.locator('dialog.app-shortcuts').waitFor();
  await settle(page.locator('dialog.app-shortcuts'));
  await expectTargets(t);
}

async function toastFlow(page, t) {
  const toast = page.locator('.ui-toast-region .ui-toast');
  await toast.waitFor();
  await settle(toast);
  const v = await viewport(page);
  const b = await toast.boundingBox();
  t.expect(Math.abs(b.x + b.width / 2 - v.w / 2) <= 2, 'bottom-centre');
  t.expect(v.h - (b.y + b.height) >= 16 && v.h - (b.y + b.height) <= 120, `above the bottom edge (${v.h - (b.y + b.height)})`);
  await page.evaluate(() => window.__feedback.play(true));
  await toast.waitFor({state: 'detached'});
  t.expect((await state(page)).toast.held, 'held while playing');
  await page.locator('#fb-toast').click();
  t.expect(await page.locator('.ui-toast-region .ui-toast').count() === 0, 'a new toast queues while playing');
  await page.evaluate(() => window.__feedback.play(false));
  await page.locator('.ui-toast-region .ui-toast').first().waitFor();
  const s = await state(page);
  t.expect(s.toast.visible?.message === 'Adding Harbor Lights' && s.toast.queued.length === 1, 'released in order on stop');
  if (t.device === 'ipad') await (await t.touch()).tap(page.locator('.ui-toast-action')); else await page.locator('.ui-toast-action').click();
  t.expect((await calls(page)).some(c => c[0] === 'toast.undo'), 'Undo ran');
  await page.locator('.ui-toast-region .ui-toast', {hasText: 'Harbor Lights is ready'}).waitFor();
  await settle(page.locator('.ui-toast-region .ui-toast'));
}

module.exports = [
  {name: 's2-palette-empty', url: `${STAGE}&demo=palette`, fn: emptyFlow},
  {name: 's2-palette-bar', url: `${STAGE}&demo=palette&q=57`, fn: barFlow},
  {name: 's2-palette-speed', url: `${STAGE}&demo=palette&q=${encodeURIComponent('75%')}`, fn: speedFlow},
  {name: 's2-palette-loop', url: `${STAGE}&demo=palette&q=${encodeURIComponent('loop 41-48')}`, fn: loopFlow},
  {name: 's2-palette-resplit', url: `${STAGE}&demo=palette&q=re-split`, fn: resplitFlow},
  {name: 's2-palette-songs', url: `${H}?song=none&demo=palette&q=glass`, fn: songsFlow},
  {name: 's2-palette-band', url: `${STAGE}&layout=band&demo=palette`, fn: bandFlow, opts: {devices: ['ipad']}},
  {name: 's2-palette-keys', url: STAGE, fn: keysFlow, opts: {devices: ['laptop']}},
  {name: 's2-shortcuts', url: `${STAGE}&demo=shortcuts`, fn: shortcutsFlow, opts: {devices: ['laptop']}},
  {name: 's2-toasts', url: `${STAGE}&demo=toast`, fn: toastFlow},
];
