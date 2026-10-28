// SE2's states: Settings → Processing and Settings → Plan & storage, web and desktop (architecture
// §9.12 SE2, §10.4 "SE2 … every section, web and desktop"; spec §6.2, §6.3, §6.5).
//
// The app on the fixture database:
//   se2-app-processing-desktop    fx-desktop=1: the processor line, Default stems, Quality, Advanced,
//                                 bitrate, the three switches, import, export originals; targets, focus;
//                                 Studio and Find bars automatically reach the database
//   se2-app-processing-restart    fx-processor=stopped: "Offline — Restart"; Restart processor restarts it
//   se2-app-processing-pairing    fx-companion=offline: the pairing failure with Try again
//   se2-app-processing-legacy     fx-legacy=1: Find old library → Import 48 songs → what was queued
//   se2-app-processing-nolegacy   no old library: the folder field; Export original audio reports the folder
//   se2-app-processing-web        a browser: the processor line, the paired computers, the one desktop note;
//                                 Rename (a Dialog) and Remove (a confirm) reach the database
//   se2-app-plan                  free: the meter, the 5 largest songs, Free/Plus priced from cents, Monthly |
//                                 Yearly, Get Plus failing calmly, the cache cleared
//   se2-app-plan-plus             fx-billing=plus: Your plan on Plus, Manage subscription, no Get Plus
//   se2-app-plan-notices          fx-billing=grace and =cancel: the notices; =disabled: Get Plus with its reason
//   se2-app-plan-checkout         /billing?checkout=success: the redirect keeps the query; the welcome toast
//   se2-app-plan-export           Export library with a save picker: progress, then Cancel export
//   se2-app-plan-export-nopicker  no save picker: the 100 MB note, then the library is too large for it
// The harness (/__harness/settings-b):
//   se2-save-failed               a failed save reverts the toggle: "Couldn't save · Retry"; Retry saves it
//   se2-processor-phases          every processor phase's line; first run and pairing failure captured
//   se2-custom-quality            Custom quality with Advanced open; a six-stem note
//   se2-legacy-many               two old libraries, each named apart; a failing import's sentence
//   se2-plan-states               loading, error → Try again; past due; over the limit; app full
//   se2-export-running            the export's progress rail and Cancel export
//   se2-export-ipad               the iPad 100 MB note; an export that fails reads as a sentence
//   se2-cache-unsupported         a browser with no playback cache
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');
const {checkAxe} = require('../probes/probe-axe.cjs');

const app = (path, query = '') => `${path}?fx-reset=1${query ? `&${query}` : ''}`;
const HARNESS = '/__harness/settings-b';
const PAGE = {ready: 'settingsPage'};
const ONE = {devices: ['laptop'], themes: ['light']};

async function expectTargets(t, page, where = 'page') {
  const problems = await checkTargets(page);
  t.expect(!problems.length, `targets (${where}): ${JSON.stringify(problems.slice(0, 6))}`);
}
/** axe over the section (the frame's nav is SE1's and checked by its states). */
async function expectAxe(t, page) {
  const problems = await checkAxe(page, {include: ['.settings-content']});
  t.expect(!problems.length, `axe: ${problems.slice(0, 4).join('; ')}`);
}
async function expectFocus(t, page, stops = 30) {
  const problems = await walkFocus(page, {stops});
  t.expect(!problems.length, `focus rings: ${JSON.stringify(problems.slice(0, 4))}`);
}

const radio = (page, group, name) => page.getByRole('radiogroup', {name: group, exact: true}).getByRole('radio', {name, exact: true});
const checked = (page, group) => page.getByRole('radiogroup', {name: group, exact: true}).locator('[aria-checked=true]').textContent();
const rowText = async (page, row) => (await page.locator(`[data-row="${row}"]`).innerText()).replace(/\s+/g, ' ').trim();
const waitRow = (page, row, text) => page.waitForFunction(([r, s]) => (document.querySelector(`[data-row="${r}"]`)?.textContent ?? '').replace(/\s+/g, ' ').includes(s), [row, text]);
const savedIn = (page, row) => page.waitForFunction(r => document.querySelector(`[data-row="${r}"] .settings-save[role=status]`)?.textContent === 'Saved', row);
const processorLine = page => page.locator('.settings-processor').innerText();
const waitProcessor = (page, text) => page.waitForFunction(s => document.querySelector('.settings-processor')?.textContent.includes(s), text);

/** Runs in the page: [{row, scope}] for every visible row. */
function rowFacts() {
  return [...document.querySelectorAll('.settings-row[data-row]')].filter(el => el.checkVisibility()).map(el => ({row: el.dataset.row, scope: el.dataset.scope}));
}

module.exports = [
  // ------------------------------------------------------------------ Processing, the app
  {
    name: 'se2-app-processing-desktop',
    url: app('/settings/processing', 'fx-desktop=1'),
    opts: {...PAGE, fullPage: true},
    async fn(page, t) {
      await page.waitForFunction(() => /Processor ready|Splitting/.test(document.querySelector('.settings-processor')?.textContent ?? ''));
      const rows = (await page.evaluate(rowFacts)).map(r => r.row);
      t.expect(JSON.stringify(rows) === JSON.stringify(['processor', 'stemMode', 'quality', 'advanced', 'bitrate', 'notifyReady', 'autoBeats', 'autoSections', 'importLegacy', 'exportOriginals']), `the desktop rows ${JSON.stringify(rows)}`);
      t.expect((await checked(page, 'Default stems')) === 'Full band · 4', 'Full band · 4 for a drums and bass profile');
      t.expect((await checked(page, 'Quality')) === 'Balanced', 'Balanced');
      const bitrate = await page.getByRole('combobox', {name: 'Audio bitrate'}).evaluate(s => s.options[s.selectedIndex].textContent);
      t.expect(bitrate === '160 kbps — smaller', `the stored bitrate (${bitrate})`);
      t.expect(!(await page.locator('.settings-desktop-note').count()), 'no web note in Woodshed for desktop');
      t.expect(!(await page.locator('[role=slider], input[type=range]').count()), 'one Quality control, no slider');
      await expectTargets(t, page);
      await expectAxe(t, page);
      if (t.theme === 'light') await expectFocus(t, page);
      await t.capture('open');
      if (t.device !== 'laptop' || t.theme !== 'light') return;
      await radio(page, 'Quality', 'Studio').click();
      await savedIn(page, 'quality');
      await page.getByRole('button', {name: 'Find bars automatically'}).click();
      await savedIn(page, 'autoBeats');
      const db = await page.evaluate(() => window.fixture.db().settings);
      t.expect(db.preset === 'studio' && db.autoBeats === false, `saved to the account ${JSON.stringify({preset: db.preset, autoBeats: db.autoBeats})}`);
      await page.locator('summary', {hasText: 'Advanced'}).click();
      await page.getByRole('button', {name: 'Fewer passes'}).click();
      await savedIn(page, 'advanced');
      const after = await page.evaluate(() => window.fixture.db().settings);
      t.expect(after.preset === 'custom' && JSON.stringify(after.custom) === JSON.stringify({model: 'htdemucs_ft', shifts: 9, overlap: 0.5}), `Fewer passes makes Studio Custom ${JSON.stringify(after.custom)}`);
      t.expect((await checked(page, 'Quality')) === 'Custom', 'Custom is chosen');
      await t.capture('custom');
    },
  },
  {
    name: 'se2-app-processing-restart',
    url: app('/settings/processing', 'fx-desktop=1&fx-processor=stopped'),
    opts: PAGE,
    async fn(page, t) {
      await waitProcessor(page, 'Offline — Restart');
      await t.capture('offline');
      await page.getByRole('button', {name: 'Restart processor'}).click();
      await page.waitForFunction(() => window.fixture.desktop.calls().some(c => c.method === 'restartProcessor'));
      await page.waitForFunction(() => !/Offline/.test(document.querySelector('.settings-processor')?.textContent ?? ''));
      t.expect(!/Offline/.test(await processorLine(page)), `restarted (${await processorLine(page)})`);
    },
  },
  {
    name: 'se2-app-processing-pairing',
    url: app('/settings/processing', 'fx-desktop=1&fx-companion=offline'),
    opts: {...PAGE, themes: ['dark']},
    async fn(page, t) {
      await waitProcessor(page, 'Couldn’t connect this computer to your account.');
      t.expect(await page.getByRole('button', {name: 'Try again'}).isVisible(), 'Try again');
      await expectTargets(t, page);
    },
  },
  {
    name: 'se2-app-processing-legacy',
    url: app('/settings/processing', 'fx-desktop=1&fx-legacy=1'),
    opts: {...PAGE, themes: ['light']},
    async fn(page, t) {
      await page.getByRole('button', {name: 'Find old library'}).click();
      await waitRow(page, 'importLegacy', '48 songs in ~/Library/Application Support/woodshed');
      await page.getByRole('button', {name: 'Import 48 songs'}).click();
      await waitRow(page, 'importLegacy', 'Added 20 songs to Jobs.');
      const text = await rowText(page, 'importLegacy');
      t.expect(text.includes('When they finish, import again for the other 28.'), `what was queued (${text})`);
      const calls = await page.evaluate(() => window.fixture.companion.calls().map(c => `${c.method} ${c.path}`));
      t.expect(calls.includes('GET /legacy') && calls.includes('POST /import'), `the processor was asked ${JSON.stringify(calls)}`);
      await t.capture('imported');
    },
  },
  {
    name: 'se2-app-processing-nolegacy',
    url: app('/settings/processing', 'fx-desktop=1'),
    opts: {...PAGE, themes: ['dark']},
    async fn(page, t) {
      await page.getByRole('button', {name: 'Find old library'}).click();
      await waitRow(page, 'importLegacy', 'No old library was found on this computer.');
      t.expect(await page.getByRole('textbox', {name: 'Old library folder'}).isVisible(), 'the folder field');
      await page.getByRole('button', {name: 'Export original audio'}).click();
      await waitRow(page, 'exportOriginals', 'Copied 48 files to ~/Downloads/Woodshed-originals-2026-10-28.');
      await expectTargets(t, page);
      await t.capture('folder');
    },
  },
  {
    name: 'se2-app-processing-web',
    url: app('/settings/processing'),
    opts: {...PAGE, fullPage: true},
    async fn(page, t) {
      await page.waitForSelector('.settings-device');
      const rows = (await page.evaluate(rowFacts)).map(r => r.row);
      t.expect(JSON.stringify(rows) === JSON.stringify(['processor', 'devices']), `the web rows ${JSON.stringify(rows)}`);
      const line = await processorLine(page);
      t.expect(/Studio MacBook is online/.test(line), `the processor line (${line})`);
      const items = await page.locator('.settings-device').allInnerTexts();
      t.expect(items.length === 2 && /Studio MacBook/.test(items[0]) && /Offline · last seen/.test(items[1]), `the paired computers ${JSON.stringify(items)}`);
      const note = (await page.locator('.settings-desktop-note').innerText()).replace(/\s+/g, ' ').trim();
      t.expect(note === 'These need Woodshed for desktop: Import an old library, Export original audio, Processing. Get it ↗', `the desktop note (${note})`);
      t.expect(!(await page.getByRole('radiogroup', {name: 'Quality'}).count()), 'no desktop-only control, not even disabled');
      await expectTargets(t, page);
      await expectAxe(t, page);
      if (t.theme === 'light') await expectFocus(t, page);
      await t.capture('web');
      if (t.device !== 'laptop' || t.theme !== 'light') return;
      await page.getByRole('button', {name: 'Rename DESKTOP-4F2K9'}).click();
      const dialog = page.getByRole('dialog', {name: 'Rename DESKTOP-4F2K9'});
      await dialog.waitFor();
      await t.capture('rename');
      await dialog.getByRole('textbox', {name: 'Name'}).fill('Kit room PC');
      await dialog.getByRole('button', {name: 'Save'}).click();
      await page.getByRole('button', {name: 'Rename Kit room PC'}).waitFor();
      const renamed = await page.evaluate(() => window.fixture.db().devices.find(d => d.id === 'dev2').displayName);
      t.expect(renamed === 'Kit room PC', `renamed in the database (${renamed})`);
      await page.getByRole('button', {name: 'Remove Kit room PC'}).click();
      const confirm = page.getByRole('dialog', {name: 'Remove Kit room PC?'});
      await confirm.waitFor();
      await confirm.getByRole('button', {name: 'Remove'}).click();
      await page.waitForFunction(() => document.querySelectorAll('.settings-device').length === 1);
      const revoked = await page.evaluate(() => window.fixture.db().devices.find(d => d.id === 'dev2').revoked);
      t.expect(revoked === true, 'removed (revoked) in the database');
    },
  },

  // ------------------------------------------------------------------ Plan & storage, the app
  {
    name: 'se2-app-plan',
    url: app('/settings/plan'),
    opts: {...PAGE, fullPage: true},
    async fn(page, t) {
      await waitRow(page, 'usage', '0.4 of 1.0 GB');
      await page.waitForSelector('.settings-plan-body:not([hidden])');
      const meter = await page.getByRole('meter', {name: 'Cloud storage'}).getAttribute('aria-valuetext');
      t.expect(meter === '0.4 of 1.0 GB', `the meter (${meter})`);
      const largest = await page.locator('.settings-largest-item').count();
      t.expect(largest === 5, `the 5 largest songs (${largest})`);
      const plus = (await page.locator('.settings-plan[data-plan=plus]').innerText()).replace(/\s+/g, ' ');
      t.expect(plus.includes('$1.67 / month') && plus.includes('$20 billed yearly. Save $4 a year.'), `Plus, yearly, from annualCents (${plus})`);
      t.expect(await page.locator('.settings-plan[data-plan=free] .settings-plan-badge').isVisible(), 'Free is your plan');
      await waitRow(page, 'cache', 'MB');
      await expectTargets(t, page);
      await expectAxe(t, page);
      if (t.theme === 'light') await expectFocus(t, page);
      await t.capture('free');
      if (t.device !== 'laptop' || t.theme !== 'light') return;
      await radio(page, 'Billing period', 'Monthly').click();
      t.expect((await page.locator('.settings-plan[data-plan=plus]').innerText()).includes('$2 billed monthly.'), 'Monthly');
      await page.getByRole('button', {name: 'Get Plus'}).click();
      await waitRow(page, 'plans', 'Checkout couldn’t open. Try again in a moment.');
      await page.getByRole('button', {name: 'Clear playback cache'}).click();
      await waitRow(page, 'cache', 'Cleared.');
      const link = page.getByRole('link', {name: 'Harbor Lights'});
      if (await link.count()) {
        await link.first().click();
        await page.waitForFunction(() => location.pathname.startsWith('/s/'));
      }
    },
  },
  {
    name: 'se2-app-plan-plus',
    url: app('/settings/plan', 'fx-billing=plus'),
    opts: PAGE,
    async fn(page, t) {
      await page.waitForSelector('.settings-plan-body:not([hidden])');
      await waitRow(page, 'usage', '3.8 of 25.0 GB');
      t.expect(await page.locator('.settings-plan[data-plan=plus] .settings-plan-badge').isVisible(), 'Plus is your plan');
      t.expect(await page.getByRole('button', {name: 'Manage subscription'}).isVisible(), 'Manage subscription');
      t.expect(!(await page.getByRole('button', {name: 'Get Plus'}).count()), 'no Get Plus');
      await expectTargets(t, page);
      await expectAxe(t, page);
    },
  },
  {
    name: 'se2-app-plan-notices',
    url: app('/settings/plan', 'fx-billing=grace'),
    opts: {...PAGE, themes: ['light']},
    async fn(page, t) {
      await page.waitForSelector('[data-notice=grace]');
      const grace = await page.locator('[data-notice=grace]').innerText();
      t.expect(/Your Plus plan has ended\. By .+, export your library/.test(grace), `the grace notice (${grace})`);
      await t.capture('grace');
      await page.goto(`${t.base}${app('/settings/plan', 'fx-billing=cancel')}`);
      await page.waitForSelector('[data-notice=ending]');
      t.expect(/Your Plus plan ends on .+\. Manage your subscription to keep it\./.test(await page.locator('[data-notice=ending]').innerText()), 'cancel at period end');
      await t.capture('ending');
      await page.goto(`${t.base}${app('/settings/plan', 'fx-billing=disabled')}`);
      await page.waitForSelector('.settings-plan-body:not([hidden])');
      const button = page.getByRole('button', {name: 'Get Plus'});
      t.expect((await button.getAttribute('aria-disabled')) === 'true', 'Get Plus disabled while upgrades are off');
      t.expect((await button.innerText()).includes('Upgrades are being set up.'), 'with its reason');
    },
  },
  {
    name: 'se2-app-plan-checkout',
    url: '/billing?checkout=success&fx-reset=1',
    opts: {...PAGE, ...ONE},
    async fn(page, t) {
      const at = await page.evaluate(() => location.pathname + location.search);
      t.expect(at.startsWith('/settings/plan?checkout=success'), `redirected with the query (${at})`);
      await page.waitForFunction(() => (document.querySelector('.ui-toast-region')?.textContent ?? '').includes('Welcome to Plus.'));
      await t.capture('toast');
    },
  },
  {
    name: 'se2-app-plan-export',
    url: app('/settings/plan'),
    opts: {...PAGE, ...ONE},
    async fn(page, t) {
      // A save picker that collects the archive in the page (the native one cannot be driven).
      await page.evaluate(() => {
        window.__export = {chunks: 0, bytes: 0, closed: false, aborted: false};
        window.showSaveFilePicker = async () => ({createWritable: async () => ({
          write: async c => { window.__export.chunks++; window.__export.bytes += c.length; },
          close: async () => { window.__export.closed = true; },
          abort: async () => { window.__export.aborted = true; },
        })});
      });
      await page.getByRole('button', {name: 'Export library (ZIP)'}).click();
      await page.waitForFunction(() => /Exporting \d+\/\d+/.test(document.querySelector('.settings-export-progress')?.textContent ?? ''));
      await page.waitForFunction(() => window.__export.bytes > 0);
      await t.capture('running');
      await page.getByRole('button', {name: 'Cancel export'}).click();
      await waitRow(page, 'export', 'Export canceled. Nothing was saved.');
      const state = await page.evaluate(() => window.__export);
      t.expect(state.aborted && !state.closed, `the half-written archive was aborted ${JSON.stringify(state)}`);
    },
  },
  {
    name: 'se2-app-plan-export-nopicker',
    url: app('/settings/plan', 'fx-platform=ipad'),
    opts: {...PAGE, devices: ['ipad'], themes: ['light']},
    async fn(page, t) {
      await page.evaluate(() => { delete Window.prototype.showSaveFilePicker; delete window.showSaveFilePicker; });
      // Re-open the section so it sees a browser without a save picker.
      await page.getByRole('button', {name: 'Settings', exact: true}).click();
      await page.getByRole('link', {name: /Plan & storage/}).click();
      await waitRow(page, 'export', 'On iPad, an export can be up to 100 MB.');
      await page.getByRole('button', {name: 'Export library (ZIP)'}).click();
      await waitRow(page, 'export', 'This browser can only save an export of up to 100 MB');
      await t.capture('too-large');
    },
  },

  // ------------------------------------------------------------------ the harness
  {
    name: 'se2-save-failed',
    url: `${HARNESS}?section=processing&desktop=1&fail=1`,
    opts: {themes: ['light']},
    async fn(page, t) {
      await page.getByRole('button', {name: 'Suggest sections automatically'}).click();
      const alert = page.locator('[data-row=autoSections] [role=alert]');
      await alert.waitFor({state: 'visible'});
      t.expect((await alert.innerText()).replace(/\s+/g, ' ').includes('Couldn’t save · Retry'), 'Couldn’t save · Retry');
      t.expect((await page.getByRole('button', {name: 'Suggest sections automatically'}).getAttribute('aria-pressed')) === 'true', 'the toggle reverted');
      await t.capture('failed');
      await alert.getByRole('button', {name: 'Retry'}).click();
      await savedIn(page, 'autoSections');
      const s = await page.evaluate(() => window.__settingsB.settings());
      t.expect(s.autoSections === false, 'Retry saved it');
    },
  },
  {
    name: 'se2-processor-phases',
    url: `${HARNESS}?section=processing&desktop=1`,
    opts: {themes: ['dark']},
    async fn(page, t) {
      const lines = {};
      for (const phase of ['ready', 'busy', 'starting', 'firstrun', 'pairing', 'offline', 'pair-failed']) {
        await page.evaluate(p => window.__settingsB.setPhase(p), phase);
        lines[phase] = (await processorLine(page)).trim();
        if (phase === 'firstrun' || phase === 'pair-failed') await t.capture(phase);
      }
      const want = {ready: 'Processor ready', busy: 'Splitting 1 · 46%', starting: 'Starting…', firstrun: 'Starting… (first run, ~1 min)', pairing: 'Connecting…', offline: 'Offline — Restart', 'pair-failed': 'Couldn’t connect this computer to your account.'};
      t.expect(JSON.stringify(lines) === JSON.stringify(want), `processor lines ${JSON.stringify(lines)}`);
      await page.getByRole('button', {name: 'Try again'}).click();
      await waitProcessor(page, 'Processor ready');
      const calls = await page.evaluate(() => window.__settingsB.calls.map(c => c.name));
      t.expect(calls.includes('watchStatus') && calls.includes('retryPairing'), `watched and retried ${JSON.stringify(calls)}`);
    },
  },
  {
    name: 'se2-custom-quality',
    url: `${HARNESS}?section=processing&desktop=1&settings=${encodeURIComponent(JSON.stringify({stemMode: 'six', preset: 'custom', custom: {model: 'htdemucs', shifts: 4, overlap: 0.35}, profile: {instruments: ['guitar'], primary: 'guitar', openWithMyPart: 'in'}}))}`,
    opts: {fullPage: true},
    async fn(page, t) {
      t.expect((await checked(page, 'Quality')) === 'Custom', 'Custom');
      t.expect(await page.locator('details.settings-advanced').evaluate(d => d.open), 'Advanced is open');
      t.expect((await page.getByRole('spinbutton', {name: 'Overlap'}).getAttribute('aria-valuetext')) === '0.35', 'overlap 0.35');
      t.expect((await rowText(page, 'advanced')).includes('Full band + guitar & piano always splits with the With piano & guitar model.'), 'the six-stem note');
      await radio(page, 'Default stems', 'Full band · 4').click();
      await waitRow(page, 'stemMode', 'Your guitar won’t be a separate track with this layout.');
      await expectTargets(t, page);
    },
  },
  {
    name: 'se2-legacy-many',
    url: `${HARNESS}?section=processing&desktop=1&legacy=many&importFail=1`,
    opts: ONE,
    async fn(page, t) {
      await page.getByRole('button', {name: 'Find old library'}).click();
      await page.getByRole('button', {name: 'Import 9 songs from ~/Music/Woodshed (2023)'}).waitFor();
      await t.capture('found');
      await page.getByRole('button', {name: 'Import 48 songs from ~/Library/Application Support/woodshed'}).click();
      await waitRow(page, 'importLegacy', 'The old library couldn’t be imported. Import queue full. Import more after these finish.');
    },
  },
  {
    name: 'se2-plan-states',
    url: `${HARNESS}?section=plan&status=error`,
    opts: {themes: ['light']},
    async fn(page, t) {
      await waitRow(page, 'plans', 'Your plan couldn’t load.');
      await t.capture('error');
      await page.goto(`${t.base}${HARNESS}?section=plan&status=pastdue&usage=over`);
      await page.waitForSelector('[data-notice=pastDue]');
      await waitRow(page, 'usage', 'Your library is over its storage limit.');
      t.expect((await page.getByRole('meter', {name: 'Cloud storage'}).getAttribute('aria-valuetext')) === '1.1 of 1.0 GB', 'over the limit');
      await t.capture('past-due');
      await page.goto(`${t.base}${HARNESS}?section=plan&usage=appfull&status=loading`);
      await waitRow(page, 'usage', 'Cloud storage is full for now');
      await waitRow(page, 'plans', 'Loading your plan…');
      await page.evaluate(() => window.__settingsB.pushStatus({}));
      await page.waitForSelector('.settings-plan-body:not([hidden])');
      // Leaving the section closes both subscriptions.
      if (t.device === 'ipad') await page.getByRole('button', {name: 'Settings', exact: true}).click();
      else await page.getByRole('link', {name: 'Practice'}).click();
      await page.waitForFunction(() => window.__settingsB.calls.some(c => c.name === 'closeStatus') && window.__settingsB.calls.some(c => c.name === 'closeUsage'));
    },
  },
  {
    name: 'se2-export-running',
    url: `${HARNESS}?section=plan&export=progress`,
    opts: {themes: ['dark']},
    async fn(page, t) {
      await page.getByRole('button', {name: 'Export library (ZIP)'}).click();
      await waitRow(page, 'export', 'Exporting 3/8: Velvet Arc');
      t.expect((await page.locator('.settings-export-running [role=progressbar]').getAttribute('aria-valuenow')) === '25', 'the rail at 2 of 8');
      await expectTargets(t, page);
      await t.capture('running');
      await page.getByRole('button', {name: 'Cancel export'}).click();
      await waitRow(page, 'export', 'Export canceled. Nothing was saved.');
    },
  },
  {
    name: 'se2-export-ipad',
    url: `${HARNESS}?section=plan&picker=0&ipad=1&export=fail`,
    opts: {devices: ['ipad']},
    async fn(page, t) {
      await waitRow(page, 'export', 'On iPad, an export can be up to 100 MB.');
      await page.getByRole('button', {name: 'Export library (ZIP)'}).click();
      await waitRow(page, 'export', 'The export didn’t finish. Couldn’t download the audio for Velvet Arc.');
      await t.capture('failed');
      await page.goto(`${t.base}${HARNESS}?section=plan&export=done`);
      await page.getByRole('button', {name: 'Export library (ZIP)'}).click();
      await waitRow(page, 'export', 'Exported 8 songs.');
    },
  },
  {
    name: 'se2-cache-unsupported',
    url: `${HARNESS}?section=plan&cache=unsupported`,
    opts: ONE,
    async fn(page, t) {
      await waitRow(page, 'cache', 'This browser doesn’t keep a playback cache.');
      t.expect(!(await page.getByRole('button', {name: 'Clear playback cache'}).count()), 'no Clear');
    },
  },
];
