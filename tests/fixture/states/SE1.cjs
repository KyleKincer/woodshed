// SE1's states: the Settings frame and the Practice, Instruments, Pedals & keys, Appearance, This device
// and Account sections (architecture §9.10 SE1, §10.4 "SE1 … every section, web and desktop"; spec §6.2).
//
// The app on the fixture database:
//   se1-app-index           /settings: on a laptop it becomes /settings/practice (replace); on iPad portrait
//                           the list of sections, a row opens the detail page, "‹ Settings" (and Back)
//                           return to the list with the row focused
//   se1-app-practice        Practice: the 200 px nav and ≤ 720 px content (laptop) or the detail page
//                           (iPad); targets; focus rings; account and device rows
//   se1-app-practice-save   Stay, 2 bars, Kit: "Saved"; the account change reaches the database and the
//                           device change ws.prefs; both survive a reload
//   se1-app-instruments     the picker with the stem mapping; Guitar saves the profile
//   se1-app-pedals          View keyboard shortcuts opens the ? sheet
//   se1-app-appearance      Theme Dark applies at once (html[data-theme]); Stage Match theme
//   se1-app-device          This device on the web: install steps, wake lock, media keys, version, Licenses
//   se1-app-device-desktop  fx-desktop=1 fx-update=ready: the desktop version, Check for updates, the
//                           update line; no install row
//   se1-app-account         email, Google account, Sign out; fx-admin=1 adds Administration
//   se1-app-nav             laptop: the nav replaces the URL and keeps focus; the nav lists every section
//                           in spec order and Tab moves along it (Appearance, Plan & storage, This device);
//                           Back leaves Settings
// The harness (/__harness/settings), with an in-memory settings.patch:
//   se1-save-failed         a failed save reverts the control: "Couldn't save · Retry"; Retry saves it
//   se1-custom-count-in     a custom count-in (3 beats): the length stepper and Bars | Beats
//   se1-license             a licence in its Dialog
//   se1-device-unsupported  no wake lock (the Auto-Lock tip), no media keys, an iPad's install steps
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');

const app = (path, query = '') => `${path}?fx-reset=1${query ? `&${query}` : ''}`;
const HARNESS = '/__harness/settings';
const SECTION_PAGE = {ready: 'settingsPage'};
/** The Settings nav on the web once every section is built (spec §6.2). */
const NAV_ORDER = ['practice', 'instruments', 'pedals', 'processing', 'appearance', 'plan', 'device', 'account'];

async function expectTargets(t, page, where = 'page') {
  const problems = await checkTargets(page);
  t.expect(!problems.length, `targets (${where}): ${JSON.stringify(problems.slice(0, 6))}`);
}

async function expectFocus(t, page, stops = 24) {
  const problems = await walkFocus(page, {stops});
  t.expect(!problems.length, `focus rings: ${JSON.stringify(problems.slice(0, 4))}`);
}

/** Runs in the page: the frame's geometry. */
function frameFacts() {
  const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return {x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height)}; };
  const root = document.querySelector('.settings');
  return {
    layout: root?.dataset.layout, view: root?.dataset.view, path: location.pathname,
    nav: box(document.querySelector('.settings-nav')), content: box(document.querySelector('.settings-content')),
    current: document.querySelector('.settings-nav-link[aria-current=page]')?.dataset.section ?? null,
    heading: document.querySelector('.settings-content h1, .settings-content h2')?.textContent ?? null,
    back: !!document.querySelector('.settings-back'),
    rows: [...document.querySelectorAll('.settings-list .settings-nav-link')].map(box),
    scrollers: document.querySelectorAll('[data-scroller]').length,
    title: document.title,
    focused: document.activeElement?.textContent?.trim().slice(0, 40) ?? null,
  };
}

/** Runs in the page: [{row, scope, tag}] for every visible settings row. */
function rowFacts() {
  return [...document.querySelectorAll('.settings-row[data-row]')].filter(el => el.checkVisibility())
    .map(el => ({row: el.dataset.row, scope: el.dataset.scope, tag: el.querySelector('.settings-scope')?.textContent ?? null}));
}

const radio = (page, group, name) => page.getByRole('radiogroup', {name: group, exact: true}).getByRole('radio', {name, exact: true});
const checked = (page, group) => page.getByRole('radiogroup', {name: group, exact: true}).locator('[aria-checked=true]').textContent();
const saved = (page, row) => page.locator(`[data-row="${row}"] .settings-save[role=status]`).textContent();

async function checkRows(t, page, expected) {
  const rows = await page.evaluate(rowFacts);
  for (const [row, scope] of Object.entries(expected)) {
    const r = rows.find(x => x.row === row);
    t.expect(r && r.scope === scope && (r.tag === 'This device') === (scope === 'device'), `row ${row} is ${scope} ${JSON.stringify(r)}`);
  }
}

module.exports = [
  // ------------------------------------------------------------------ the app
  {
    name: 'se1-app-index',
    url: app('/settings'),
    opts: {ready: false},
    async fn(page, t) {
      if (t.device === 'laptop') {
        await page.waitForSelector('html[data-view-ready=settingsPage]');
        const f = await page.evaluate(frameFacts);
        t.expect(f.path === '/settings/practice' && f.layout === 'split' && f.current === 'practice', `laptop: /settings → Practice ${JSON.stringify(f)}`);
        const idx = await page.evaluate(() => history.state.idx);
        t.expect(idx === 0, `replaced, not pushed (idx ${idx})`);
        return;
      }
      await page.waitForSelector('html[data-view-ready=settings]');
      const f = await page.evaluate(frameFacts);
      t.expect(f.layout === 'stack' && f.view === 'list' && f.rows.length >= 6, `iPad: the list ${JSON.stringify(f)}`);
      t.expect(f.rows.every(r => r.h >= 56), `list rows ≥ 56 px ${JSON.stringify(f.rows)}`);
      t.expect(f.title === 'Settings — Woodshed' && f.scrollers === 1, `title and one scroller ${JSON.stringify(f)}`);
      await expectTargets(t, page, 'list');
      await t.capture('list');
      await page.getByRole('link', {name: /This device/}).click();
      await page.waitForSelector('html[data-view-ready=settingsPage]');
      const d = await page.evaluate(frameFacts);
      t.expect(d.path === '/settings/device' && d.view === 'detail' && d.back && d.heading === 'This device', `the detail page ${JSON.stringify(d)}`);
      await page.getByRole('button', {name: 'Settings', exact: true}).click();
      await page.waitForSelector('html[data-view-ready=settings]');
      const back = await page.evaluate(() => ({path: location.pathname, focus: document.activeElement?.dataset?.focusKey ?? null}));
      t.expect(back.path === '/settings' && back.focus === 'settings:device', `"‹ Settings" went back and refocused the row ${JSON.stringify(back)}`);
      await page.getByRole('link', {name: /Appearance/}).click();
      await page.waitForSelector('html[data-view-ready=settingsPage]');
      await page.goBack();
      await page.waitForSelector('html[data-view-ready=settings]');
      t.expect((await page.evaluate(() => location.pathname)) === '/settings', 'browser Back returns to the list');
    },
  },
  {
    name: 'se1-app-practice',
    url: app('/settings/practice'),
    opts: {...SECTION_PAGE, fullPage: true},
    async fn(page, t) {
      const f = await page.evaluate(frameFacts);
      if (t.device === 'laptop') {
        t.expect(f.layout === 'split' && f.nav.w === 200 && f.content.w <= 720 && f.content.w >= 600, `200 px nav + ≤ 720 px content ${JSON.stringify(f)}`);
        t.expect(f.current === 'practice' && f.heading === 'Practice', 'Practice is current');
      } else {
        t.expect(f.layout === 'stack' && f.view === 'detail' && f.back && f.heading === 'Practice', `the detail page ${JSON.stringify(f)}`);
      }
      t.expect(f.title === 'Practice — Settings — Woodshed', `title ${f.title}`);
      await checkRows(t, page, {stop: 'account', countIn: 'account', click: 'account', eachPassCount: 'account', keepPitch: 'account',
        wake: 'account', distance: 'device', follow: 'device', edgeFlash: 'device'});
      t.expect((await checked(page, 'When Stop is pressed')) === 'Return to cue', 'Stop default');
      t.expect((await checked(page, 'Default click')) === 'During count-in only', 'click default');
      await expectTargets(t, page);
      if (t.theme === 'light') await expectFocus(t, page);
    },
  },
  {
    name: 'se1-app-practice-save',
    url: app('/settings/practice'),
    opts: {...SECTION_PAGE, themes: ['dark']},
    async fn(page, t) {
      await radio(page, 'When Stop is pressed', 'Stay').click();
      await radio(page, 'Default count-in', '2 bars').click();
      await radio(page, 'Distance', 'Kit').click();
      await page.waitForFunction(() => document.querySelector('[data-row=countIn] .settings-save[role=status]')?.textContent === 'Saved');
      t.expect((await saved(page, 'stop')) === 'Saved' && (await saved(page, 'distance')) === 'Saved', 'each row says Saved');
      const db = await page.evaluate(() => window.fixture.db().settings.practice);
      t.expect(db.stop === 'stay' && db.countIn.on === true && db.countIn.length === 2 && db.countIn.unit === 'bars', `the account default reached the database ${JSON.stringify(db)}`);
      const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('ws.prefs')).practice.distance);
      t.expect(prefs === 'kit', `Distance is this device's (${prefs})`);
      await t.capture('saved');
      await page.reload();
      await page.waitForSelector('html[data-view-ready=settingsPage]');
      t.expect((await checked(page, 'When Stop is pressed')) === 'Stay', 'Stay after a reload');
      t.expect((await checked(page, 'Default count-in')) === '2 bars', '2 bars after a reload');
      t.expect((await checked(page, 'Distance')) === 'Kit', 'Kit after a reload');
    },
  },
  {
    name: 'se1-app-instruments',
    url: app('/settings/instruments'),
    opts: SECTION_PAGE,
    async fn(page, t) {
      const group = await page.evaluate(() => {
        const chips = document.querySelector('.onboarding-instruments-chips');
        return document.getElementById(chips.getAttribute('aria-labelledby'))?.textContent;
      });
      t.expect(group === 'Instruments', `the chips are labelled by the section heading (${group})`);
      await page.getByRole('button', {name: 'Guitar', exact: true}).click();
      await page.waitForFunction(() => document.querySelector('.settings-instruments .settings-save[role=status]')?.textContent === 'Saved');
      const profile = await page.evaluate(() => window.fixture.db().settings.profile);
      const before = await page.evaluate(() => window.__woodshed.store.account.peek().profile);
      t.expect(profile.instruments.includes('guitar') && profile.primary === (before.primary ?? 'guitar'), `the profile saved ${JSON.stringify(profile)}`);
      const mapping = await page.locator('.onboarding-instruments-mapping').textContent();
      t.expect(/Guitar/.test(mapping), `the stem mapping in plain words (${mapping})`);
      await expectTargets(t, page);
    },
  },
  {
    name: 'se1-app-pedals',
    url: app('/settings/pedals'),
    opts: SECTION_PAGE,
    async fn(page, t) {
      await expectTargets(t, page);
      await page.getByRole('button', {name: /View keyboard shortcuts/}).click();
      await page.waitForSelector('.app-shortcuts, [data-shortcuts-sheet], dialog[open], [popover]:popover-open');
      await t.capture('sheet');
    },
  },
  {
    name: 'se1-app-appearance',
    url: app('/settings/appearance'),
    opts: SECTION_PAGE,
    async fn(page, t) {
      t.expect((await checked(page, 'Stage')) === 'Always dark', 'Stage defaults to Always dark');
      await checkRows(t, page, {theme: 'device', stage: 'device'});
      const before = await page.evaluate(() => document.documentElement.dataset.theme);
      const target = t.theme === 'dark' ? 'Light' : 'Dark';
      await radio(page, 'Theme', target).click();
      await page.waitForFunction(want => document.documentElement.dataset.theme === want, target.toLowerCase());
      t.expect((await saved(page, 'theme')) === 'Saved', 'Saved');
      t.expect(before !== target.toLowerCase(), 'the theme changed at once');
      await radio(page, 'Theme', 'System').click();
      await radio(page, 'Stage', 'Match theme').click();
      const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('ws.prefs')));
      t.expect(prefs.theme === 'system' && prefs.stage === 'match', `prefs ${prefs.theme}/${prefs.stage}`);
      await expectTargets(t, page);
    },
  },
  {
    name: 'se1-app-device',
    url: app('/settings/device'),
    opts: {...SECTION_PAGE, fullPage: true},
    async fn(page, t) {
      await checkRows(t, page, {install: 'info', wakeLock: 'info', mediaKeys: 'info', announceSections: 'device', version: 'info', licenses: 'info'});
      const text = await page.locator('.settings-section').innerText();
      t.expect(/Woodshed \d+\.\d+\.\d+ · web app/.test(text), 'the web version');
      t.expect(!/Check for updates/.test(text), 'no Check for updates on the web');
      t.expect(/Media keys\s+(Supported|Not supported)/.test(text), 'media keys');
      if (t.device === 'ipad') t.expect(text.includes('In Safari, tap Share, then Add to Home Screen.'), 'iPad install steps');
      await page.getByRole('button', {name: 'Announce sections while playing'}).click();
      const announce = await page.evaluate(() => JSON.parse(localStorage.getItem('ws.prefs')).practice.announceSections);
      t.expect(announce === true, 'Announce sections is a device pref');
      await expectTargets(t, page);
    },
  },
  {
    name: 'se1-app-device-desktop',
    url: app('/settings/device', 'fx-desktop=1&fx-update=ready'),
    opts: SECTION_PAGE,
    async fn(page, t) {
      await page.waitForFunction(() => /Woodshed for desktop 2\.0\.0/.test(document.querySelector('[data-row=version]')?.textContent ?? ''));
      const text = await page.locator('.settings-section').innerText();
      t.expect(text.includes('Update ready — Restart to install'), 'the update line');
      t.expect(!(await page.locator('[data-row=install]').count()), 'no install row in the desktop app');
      t.expect(text.includes('Woodshed for desktop keeps the display on'), 'wake lock on desktop');
      await page.getByRole('button', {name: 'Check for updates'}).click();
      await page.waitForFunction(() => window.fixture.desktop.calls().some(c => c.method === 'update'));
      const calls = await page.evaluate(() => window.fixture.desktop.calls().filter(c => c.method === 'update').map(c => c.args));
      t.expect(JSON.stringify(calls) === '[["show"]]', `desktop.update('show') ${JSON.stringify(calls)}`);
      await expectTargets(t, page);
    },
  },
  {
    name: 'se1-app-account',
    url: app('/settings/account', 'fx-admin=1'),
    opts: SECTION_PAGE,
    async fn(page, t) {
      const text = await page.locator('.settings-section').innerText();
      t.expect(/@/.test(text) && text.includes('Signed in with Google'), `email and Google account (${text})`);
      t.expect(await page.getByRole('button', {name: 'Sign out'}).isVisible(), 'Sign out');
      t.expect(await page.getByRole('button', {name: 'Administration'}).isVisible(), 'Administration for an admin');
      await expectTargets(t, page);
    },
  },
  {
    name: 'se1-app-nav',
    url: app('/settings/practice'),
    opts: {...SECTION_PAGE, devices: ['laptop'], themes: ['light']},
    async fn(page, t) {
      await page.getByRole('link', {name: 'Appearance'}).click();
      await page.waitForFunction(() => document.querySelector('.settings-content h2')?.textContent === 'Appearance' && document.querySelector('[data-row=theme]'));
      const f = await page.evaluate(() => ({path: location.pathname, idx: history.state.idx, focus: document.activeElement?.dataset?.section}));
      t.expect(f.path === '/settings/appearance' && f.idx === 0 && f.focus === 'appearance', `replaced, focus kept on the nav ${JSON.stringify(f)}`);
      // I2b-26: every section is built, so the nav lists all eight in spec §6.2 order and Plan & storage
      // (SE2's plan.js) sits between Appearance and This device.
      const order = await page.evaluate(() => [...document.querySelectorAll('.settings-nav .settings-nav-link')].map(a => a.dataset.section));
      t.expect(JSON.stringify(order) === JSON.stringify(NAV_ORDER), `the nav in spec order ${JSON.stringify(order)}`);
      const stops = [];
      for (let i = 0; i < 2; i++) {
        await page.keyboard.press('Tab');
        stops.push(await page.evaluate(() => document.activeElement?.dataset?.section));
      }
      t.expect(stops.join() === 'plan,device', `Tab moves along the nav (${stops.join(', ')})`);
    },
  },

  // ------------------------------------------------------------------ the harness
  {
    name: 'se1-save-failed',
    url: `${HARNESS}?section=practice&fail=1`,
    async fn(page, t) {
      await radio(page, 'When Stop is pressed', 'Stay').click();
      const alert = page.locator('[data-row=stop] [role=alert]');
      await alert.waitFor({state: 'visible'});
      t.expect((await alert.innerText()).replace(/\s+/g, ' ').includes('Couldn’t save · Retry'), 'Couldn’t save · Retry');
      t.expect((await checked(page, 'When Stop is pressed')) === 'Return to cue', 'the control reverted');
      await t.capture('failed');
      await alert.getByRole('button', {name: 'Retry'}).click();
      await page.waitForFunction(() => document.querySelector('[data-row=stop] .settings-save[role=status]')?.textContent === 'Saved');
      t.expect((await checked(page, 'When Stop is pressed')) === 'Stay', 'Retry saved it');
      const patches = await page.evaluate(() => window.__settings.patches);
      t.expect(patches.length === 2, `two patches ${JSON.stringify(patches)}`);
    },
  },
  {
    name: 'se1-custom-count-in',
    url: `${HARNESS}?section=practice&countIn=1,3,beats`,
    async fn(page, t) {
      t.expect((await checked(page, 'Default count-in')) === 'Custom', 'Custom');
      const value = await page.getByRole('spinbutton', {name: 'Count-in length'}).getAttribute('aria-valuetext');
      t.expect(value === '3 beats', `3 beats (${value})`);
      t.expect((await checked(page, 'Count in')) === 'Beats', 'Beats');
      await expectTargets(t, page);
    },
  },
  {
    name: 'se1-license',
    url: `${HARNESS}?section=device`,
    async fn(page, t) {
      await page.getByRole('button', {name: 'Atkinson Hyperlegible Next'}).click();
      const dialog = page.getByRole('dialog', {name: 'Atkinson Hyperlegible Next'});
      await dialog.waitFor();
      await page.waitForFunction(() => /SIL Open Font License/.test(document.querySelector('.settings-license-text')?.textContent ?? ''));
      await dialog.getByRole('button', {name: 'Close'}).focus();
    },
  },
  {
    name: 'se1-device-unsupported',
    url: `${HARNESS}?section=device&nowake=1&nomedia=1&install=ios`,
    async fn(page, t) {
      const text = await page.locator('.settings-section').innerText();
      t.expect(text.includes('Not supported in this browser.') && text.includes('Set Auto-Lock to Never while practising.'), 'the wake-lock fallback tip');
      t.expect(/Media keys\s+Not supported/.test(text), 'media keys not supported');
      t.expect(text.includes('In Safari, tap Share, then Add to Home Screen.'), 'iPad install steps');
    },
  },
];
