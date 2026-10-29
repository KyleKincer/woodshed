// PD1's states: pedal mode, Learn my pedal, profiles and Custom, background shortcuts and MIDI pedals in Settings →
// Pedals & keys, and pedals driving the Stage in the app (architecture §9 PD1, §10.4 captures "PD1"; spec §6.2, §7.5).
//
// The harness (/__harness/pedals; tests/harness/settings/pedals.harness.js):
//   pd1-pedals-empty        nothing learned: every row (device-scoped), the empty mapping, the desktop note, MIDI
//   pd1-pedals-learn        Learn my pedal: press and hold the left pedal (B), tap the right one (PageDown) twice;
//                           Done saves both, pedal mode turns on and the table shows Tap and Hold or double-tap
//   pd1-pedals-mode-cancel  Pedal mode with nothing learned opens the learn dialog; Esc cancels and it stays off
//   pd1-pedals-custom       Custom: a menu per cell (pedal commands only); Right pedal hold → Start trainer saves
//   pd1-pedals-desktop      desktop, macOS: Background shortcuts on, one accelerator taken by another app, then
//                           the Accessibility button asks with promptAccessibility
//   pd1-pedals-midi         Add a MIDI pedal: the virtual pad's note 49 is heard, Save binds it to Start again;
//                           Remove unbinds it
//   pd1-pedals-no-midi      a browser without Web MIDI: no MIDI row
// The app on the fixture database:
//   pd1-app-pedals          /settings/pedals with two learned pedals: the section in the real app
//   pd1-app-stage-pedal     /s/glasshouse in pedal mode: the right pedal (N) plays and stops, the left pedal (B)
//                           runs Again, not its key's Save spot; with pedal mode off, B is a key again
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');

const HARNESS = '/__harness/pedals';
const NOW = 'fx-now=2026-10-29T12:00:00Z';
const enc = value => encodeURIComponent(JSON.stringify(value));
const harness = (query = '') => `${HARNESS}${query ? `?${query}` : ''}`;
const app = (path, query = '') => `${path}?fx-reset=1&${NOW}${query ? `&${query}` : ''}`;

const TWO = {enabled: true, profile: 'practice', custom: {}, pedals: [
  {slot: 'left', code: 'KeyB', canHold: true}, {slot: 'right', code: 'KeyN', canHold: true},
]};

async function expectTargets(t, page, where = 'page') {
  const problems = await checkTargets(page);
  t.expect(!problems.length, `targets (${where}): ${JSON.stringify(problems.slice(0, 6))}`);
}

async function expectFocus(t, page, stops = 20) {
  const problems = await walkFocus(page, {stops});
  t.expect(!problems.length, `focus rings: ${JSON.stringify(problems.slice(0, 4))}`);
}

/** Runs in the page: [{row, scope, tag}] for every visible settings row. */
function rowFacts() {
  return [...document.querySelectorAll('.settings-row[data-row]')].filter(el => el.checkVisibility())
    .map(el => ({row: el.dataset.row, scope: el.dataset.scope, tag: el.querySelector('.settings-scope')?.textContent ?? null}));
}

/** Runs in the page: the mapping table as [[pedal, tap, hold]] plus its header. */
function tableFacts() {
  const table = document.querySelector('.pedals-table');
  if (!table) return null;
  const text = el => el?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  return {
    profile: table.dataset.profile,
    head: [...table.querySelectorAll('thead th')].map(text),
    rows: [...table.querySelectorAll('tbody tr')].map(tr => [tr.dataset.slot, ...[...tr.querySelectorAll('td')].map(td => {
      const select = td.querySelector('select');
      return select ? select.selectedOptions[0]?.textContent ?? '' : text(td);
    })]),
  };
}

const prompt = page => page.locator('.pedals-learn-prompt').textContent();
const waitPrompt = (page, text) => page.waitForFunction(want => document.querySelector('.pedals-learn-prompt')?.textContent === want, text);
const savedIn = (page, row) => page.waitForFunction(r => document.querySelector(`[data-row="${r}"] .settings-save[role=status]`)?.textContent === 'Saved', row);

module.exports = [
  // ------------------------------------------------------------------ the harness
  {
    name: 'pd1-pedals-empty',
    url: harness(),
    async fn(page, t) {
      const rows = await page.evaluate(rowFacts);
      const scope = Object.fromEntries(rows.map(r => [r.row, r]));
      for (const row of ['pedalMode', 'pedals', 'profile', 'mapping']) {
        t.expect(scope[row]?.scope === 'device' && scope[row].tag === 'This device', `${row} is this device's ${JSON.stringify(scope[row])}`);
      }
      t.expect(scope.shortcuts?.scope === 'info', 'View keyboard shortcuts');
      t.expect(!scope.background, 'no Background shortcuts row on the web');
      const text = (await page.locator('.settings-section').innerText()).replace(/\s+/g, ' ');
      t.expect(text.includes('No pedals learned yet.') && text.includes('Learn your pedals to see what each one does.'), 'nothing learned');
      t.expect(text.includes('These need Woodshed for desktop: Background shortcuts.'), 'the desktop note');
      const midi = await page.evaluate(() => 'requestMIDIAccess' in navigator);
      t.expect(!!scope.midi === midi, `MIDI pedals where Web MIDI exists (${midi})`);
      const pressed = await page.getByRole('button', {name: 'Pedal mode', exact: true}).getAttribute('aria-pressed');
      t.expect(pressed === 'false', 'pedal mode is off');
      t.expect(await page.getByRole('radiogroup', {name: 'Profile'}).locator('[aria-checked=true]').textContent() === 'Practice', 'Practice by default');
      await expectTargets(t, page);
      await expectFocus(t, page);
    },
  },
  {
    name: 'pd1-pedals-learn',
    url: harness(),
    opts: {fullPage: true},
    async fn(page, t) {
      await page.getByRole('button', {name: 'Learn my pedal'}).click();
      const dialog = page.getByRole('dialog', {name: 'Learn my pedal'});
      await dialog.waitFor();
      t.expect(await prompt(page) === 'Press the left pedal…', 'asks for the left pedal');
      await page.keyboard.press('b');
      await waitPrompt(page, 'Hold it for a second…');
      await page.keyboard.down('b');
      await page.waitForTimeout(750);
      await page.keyboard.up('b');
      await waitPrompt(page, 'Press the right pedal…');
      await page.keyboard.press('PageDown');
      await waitPrompt(page, 'Hold it for a second…');
      await page.keyboard.press('PageDown');                   // keydown and keyup at once: this pedal cannot hold
      await waitPrompt(page, 'Third pedal (or Done)…');
      const learned = await dialog.locator('.pedals-learn-item').allTextContents();
      t.expect(learned.length === 2 && /Left pedal · B · can hold/.test(learned[0]) && /Right pedal · .* · no hold/.test(learned[1]), `learned ${JSON.stringify(learned)}`);
      t.expect(!(await page.evaluate(() => window.__pedals.runs.length)), 'no command ran while learning');
      await t.capture('dialog');
      await dialog.getByRole('button', {name: 'Done'}).click();
      await dialog.waitFor({state: 'detached'});
      await savedIn(page, 'pedals');
      const saved = await page.evaluate(() => window.__pedals.prefs());
      t.expect(saved.enabled === true && JSON.stringify(saved.pedals) === JSON.stringify([
        {slot: 'left', code: 'KeyB', canHold: true}, {slot: 'right', code: 'PageDown', canHold: false},
      ]), `saved ${JSON.stringify(saved)}`);
      const table = await page.evaluate(tableFacts);
      t.expect(table && table.head.join('|') === 'Pedal|Tap|Hold or double-tap', `header ${JSON.stringify(table?.head)}`);
      t.expect(JSON.stringify(table.rows) === JSON.stringify([['left', 'Start again', 'Previous section'], ['right', 'Play / Stop', 'Next section']]), `rows ${JSON.stringify(table.rows)}`);
      t.expect(await page.getByRole('button', {name: 'Pedal mode', exact: true}).getAttribute('aria-pressed') === 'true', 'pedal mode is on');
      t.expect(await page.getByRole('button', {name: 'Learn again'}).isVisible(), 'Learn again');
      await expectTargets(t, page);
    },
  },
  {
    name: 'pd1-pedals-mode-cancel',
    url: harness(),
    opts: {capture: false},
    async fn(page, t) {
      await page.getByRole('button', {name: 'Pedal mode', exact: true}).click();
      const dialog = page.getByRole('dialog', {name: 'Learn my pedal'});
      await dialog.waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({state: 'detached'});
      t.expect(await page.getByRole('button', {name: 'Pedal mode', exact: true}).getAttribute('aria-pressed') === 'false', 'still off');
      const saved = await page.evaluate(() => window.__pedals.prefs());
      t.expect(saved.enabled === false && saved.pedals.length === 0, `nothing saved ${JSON.stringify(saved)}`);
      const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
      t.expect(focused === 'Pedal mode', `focus returns to the toggle (${focused})`);
    },
  },
  {
    name: 'pd1-pedals-custom',
    url: harness(`pedals=${enc(TWO)}`),
    async fn(page, t) {
      await page.getByRole('radiogroup', {name: 'Profile'}).getByRole('radio', {name: 'Custom'}).click();
      await page.waitForFunction(() => document.querySelector('.pedals-table')?.dataset.profile === 'custom');
      let table = await page.evaluate(tableFacts);
      t.expect(JSON.stringify(table.rows) === JSON.stringify([['left', 'Start again', 'Previous section'], ['right', 'Play / Stop', 'Next section']]), `Custom starts from Practice ${JSON.stringify(table.rows)}`);
      const menu = page.getByLabel('Right pedal: Hold');
      await menu.focus();
      const options = await menu.locator('option').allTextContents();
      t.expect(options[0] === 'Nothing' && options.includes('Start trainer') && options.includes('Minus me'), `pedal commands ${JSON.stringify(options)}`);
      await menu.selectOption({label: 'Start trainer'});
      await savedIn(page, 'mapping');
      const saved = await page.evaluate(() => window.__pedals.prefs());
      t.expect(saved.profile === 'custom' && saved.custom.right?.hold === 'trainer.toggle', `saved ${JSON.stringify(saved)}`);
      table = await page.evaluate(tableFacts);
      t.expect(table.rows[1][2] === 'Start trainer', 'the cell shows it');
      const focused = await page.evaluate(() => document.activeElement?.closest('[data-cell]')?.dataset.cell);
      t.expect(focused === 'right:hold', `focus stays on the menu (${focused})`);
      await page.getByLabel('Left pedal: Tap').selectOption({label: 'Nothing'});
      await page.waitForFunction(() => !JSON.parse(localStorage.getItem('ws.prefs')).pedals.custom.left?.tap);
      await expectTargets(t, page);
    },
  },
  {
    name: 'pd1-pedals-desktop',
    url: harness(`desktop=1&mac=1&taken=Control%2BAlt%2BL&pedals=${enc(TWO)}`),
    async fn(page, t) {
      const text = (await page.locator('.settings-section').innerText()).replace(/\s+/g, ' ');
      t.expect(!text.includes('These need Woodshed for desktop'), 'no desktop note in the desktop app');
      await page.getByRole('button', {name: 'Background shortcuts'}).click();
      await savedIn(page, 'background');
      const items = await page.evaluate(() => [...document.querySelectorAll('.pedals-bg-item')].map(li => ({ok: li.dataset.ok, text: li.textContent})));
      const failed = items.filter(i => i.ok === 'false');
      t.expect(items.length === 7 && failed.length === 1 && /Loop · ⌃⌥L/.test(failed[0].text) && /Another app is using it/.test(failed[0].text), `per-item results ${JSON.stringify(items)}`);
      t.expect(items.some(i => /Play \/ Stop · ⌃⌥Space\s*Ready/.test(i.text)), 'a registered shortcut is Ready');
      const allow = page.getByRole('button', {name: 'Allow Woodshed in System Settings → Privacy & Security → Accessibility'});
      t.expect(await allow.isVisible(), 'the Accessibility prompt');
      await t.capture('accessibility');
      await allow.click();
      await page.waitForFunction(() => document.querySelector('.pedals-bg-access')?.hidden === true);
      const calls = await page.evaluate(() => window.__pedals.calls.filter(c => c.method === 'setBackgroundShortcuts').map(c => c.args));
      t.expect(JSON.stringify(calls) === JSON.stringify([[true], [true, {promptAccessibility: true}]]), `calls ${JSON.stringify(calls)}`);
      await page.getByRole('button', {name: 'Background shortcuts'}).click();
      await page.waitForFunction(() => document.querySelector('.pedals-bg-list')?.hidden === true);
      await expectTargets(t, page);
    },
  },
  {
    name: 'pd1-pedals-midi',
    url: harness(),
    async fn(page, t) {
      t.expect(await page.evaluate(() => !!window.fixture?.midi), 'the virtual MIDI input');
      await page.getByRole('button', {name: 'Add a MIDI pedal'}).click();
      const dialog = page.getByRole('dialog', {name: 'Add a MIDI pedal'});
      await dialog.waitFor();
      t.expect(await prompt(page) === 'Hit the pad or press the pedal…', 'listening');
      await page.waitForFunction(() => window.fixture.midi.state().requests > 0);
      await page.evaluate(() => window.fixture.midi.note(49, 110));
      await waitPrompt(page, 'Heard Note 49 on Fixture Pad.');
      t.expect(await page.getByLabel('Runs').evaluate(s => s.selectedOptions[0]?.textContent) === 'Start again', 'Start again by default');
      await t.capture('heard');
      await dialog.getByRole('button', {name: 'Save'}).click();
      await dialog.waitFor({state: 'detached'});
      await savedIn(page, 'midi');
      const midi = await page.evaluate(() => window.__pedals.midi());
      t.expect(midi.enabled === true && JSON.stringify(midi.bindings) === JSON.stringify([{device: 'Fixture Pad', type: 'note', number: 49, command: 'transport.again'}]), `saved ${JSON.stringify(midi)}`);
      const items = await page.locator('.pedals-midi-item').allTextContents();
      t.expect(items.length === 1 && items[0].includes('Note 49 on Fixture Pad → Start again'), `listed ${JSON.stringify(items)}`);
      t.expect(/Devices: Fixture Pad/.test(await page.locator('.pedals-midi-devices').textContent()), 'the connected device');
      t.expect(await page.getByRole('button', {name: 'MIDI pedals'}).getAttribute('aria-pressed') === 'true', 'MIDI pedals on');
      await page.getByRole('button', {name: 'Remove Note 49 on Fixture Pad → Start again'}).click();
      await page.waitForFunction(() => window.__pedals.midi().bindings.length === 0);
      await expectTargets(t, page);
    },
  },
  {
    name: 'pd1-pedals-no-midi',
    url: harness(`nomidi=1&pedals=${enc(TWO)}`),
    opts: {devices: ['laptop'], capture: false},
    async fn(page, t) {
      const rows = (await page.evaluate(rowFacts)).map(r => r.row);
      t.expect(!rows.includes('midi') && rows.includes('mapping'), `rows ${JSON.stringify(rows)}`);
    },
  },

  // ------------------------------------------------------------------ the app
  {
    name: 'pd1-app-pedals',
    url: app('/settings/pedals', `fx-prefs=${enc({pedals: TWO})}`),
    opts: {ready: 'settingsPage'},
    async fn(page, t) {
      await page.waitForSelector('.pedals-table');
      const table = await page.evaluate(tableFacts);
      t.expect(table.rows.length === 2 && table.head.join('|') === 'Pedal|Tap|Hold', `the table ${JSON.stringify(table)}`);
      t.expect(table.rows[0][1] === 'Start again' && table.rows[1][1] === 'Play / Stop', `the app's command titles ${JSON.stringify(table.rows)}`);
      t.expect(await page.getByRole('button', {name: 'Pedal mode', exact: true}).getAttribute('aria-pressed') === 'true', 'pedal mode is on');
      await expectTargets(t, page);
    },
  },
  {
    name: 'pd1-app-stage-pedal',
    url: app('/s/glasshouse', `fx-prefs=${enc({pedals: TWO})}`),
    opts: {ready: 'stage', structure: {placeholder: true}, capture: false},
    async fn(page, t) {
      await t.loadPhase('ready');
      const playing = () => page.evaluate(() => window.__woodshed.store.stage.value?.playing === true);
      await page.keyboard.press('n');                          // the right pedal: Play
      await page.waitForFunction(() => window.__woodshed.store.stage.value?.playing === true, null, {timeout: 5000});
      await page.keyboard.press('n');                          // and Stop
      await page.waitForFunction(() => window.__woodshed.store.stage.value?.playing === false, null, {timeout: 5000});
      const spots = () => page.evaluate(() => (window.__woodshed.activeSession?.()?.practice.value?.spots ?? []).length);
      const before = await spots();
      await page.keyboard.press('b');                          // the left pedal: Again (plays from the cue), not Save spot
      await page.waitForFunction(() => window.__woodshed.store.stage.value?.playing === true, null, {timeout: 5000});
      t.expect(await spots() === before, 'B did not save a spot in pedal mode');
      await page.keyboard.press('n');
      await page.waitForFunction(() => window.__woodshed.store.stage.value?.playing === false, null, {timeout: 5000});
      t.expect(!(await playing()), 'stopped');
    },
  },
];
