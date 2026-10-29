// DL1's states: the /download page on its harness (/__harness/download), architecture §9.6 DL1, §10.3.
//   dl1-ready         the release loaded on a Mac laptop: the direct DMG primary, macOS recommended; plus
//                     captures of the platform cards and the footer; targets probe at each
//   dl1-ipad          the same on iPad: the web player primary (new tab), no recommended card
//   dl1-windows       laptop on Windows: the EXE primary, Windows recommended
//   dl1-linux         laptop on the container's Linux: the AppImage primary
//   dl1-chromeos      no installer fits: the web player primary and "choose below"
//   dl1-loading       the lookup pending: skeleton rows, the busy list, "Finding available downloads…"
//   dl1-fallback      /api/downloads fails, the bundled /downloads.json answers
//   dl1-unavailable   every lookup fails: the alert line, unavailable cards, Try again
//   dl1-retry         after an outage, Try again (keyboard) recovers and focus lands on the primary download
//   dl1-desktop       inside the desktop app: the way back into the app navigates in place (no target),
//                     external links keep target=_blank and say "(opens in your browser)"
//   dl1-settle-focus  the keyboard sits on the primary while loading; when the lookup settles focus
//                     moves to the new primary download instead of dropping to <body>
//   dl1-download      the empty status line is still a live region; clicking the primary says the download should start shortly; Other platforms
//                     moves focus to the platform heading without changing the URL
//   dl1-focus         every focus stop shows the focus ring (laptop, both themes)
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');

const BASE = '/__harness/download';
const READY = '.download-page[data-release-state="ready"]';

async function targets(page, t, where) {
  const problems = await checkTargets(page);
  t.expect(!problems.length, `targets (${where}):\n${problems.map(p => JSON.stringify(p)).join('\n')}`);
}

const primaryName = page => page.locator('.download-primary-link').evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
const recommended = page => page.locator('.download-platform[data-recommended]').evaluateAll(els => els.map(el => el.dataset.platform));

/** The release loaded: a Mac on the laptop, the web player on iPad. */
async function ready(page, t) {
  await page.waitForSelector(READY);
  const name = await primaryName(page);
  if (t.device === 'ipad') {
    t.expect(name.startsWith('Open web player'), `iPad primary is the web player (${name})`);
    t.expect((await recommended(page)).length === 0, 'no recommended card on iPad');
    t.expect(await page.locator('.download-primary-link').getAttribute('target') === '_blank', 'the web player opens a new tab');
  } else {
    t.expect(name === 'Download for macOS (Apple Silicon)', `Mac primary (${name})`);
    t.expect(/-mac-arm64\.dmg$/.test(await page.locator('.download-primary-link').getAttribute('href')), 'the primary is the DMG');
    t.expect(JSON.stringify(await recommended(page)) === '["mac"]', 'macOS is recommended');
  }
  t.expect(await page.locator('.download-file').count() === 4, 'four installers');
  t.expect(await page.getByRole('link', {name: /^Download Woodshed for Windows, EXE installer, \d+ MB$/}).count() === 1, 'the Windows installer link is named');
  await targets(page, t, 'top');
  await page.locator('#all-downloads').scrollIntoViewIfNeeded();
  await targets(page, t, 'cards');
  await t.capture('cards');
  await page.locator('.download-footer').scrollIntoViewIfNeeded();
  await targets(page, t, 'footer');
  await t.capture('footer');
  await page.locator('.download-page').evaluate(el => { el.scrollTop = 0; });
}

module.exports = [
  {
    name: 'dl1-ready',
    url: `${BASE}?release=ok&fx-platform=mac`,
    opts: {devices: ['laptop']},
    fn: ready,
  },
  {
    name: 'dl1-ipad',
    url: `${BASE}?release=ok`,
    opts: {devices: ['ipad']},
    fn: ready,
  },
  {
    name: 'dl1-windows',
    url: `${BASE}?release=ok&fx-platform=win`,
    opts: {devices: ['laptop']},
    async fn(page, t) {
      await page.waitForSelector(READY);
      t.expect(await primaryName(page) === 'Download for Windows', 'Windows primary');
      t.expect(/-win-x64\.exe$/.test(await page.locator('.download-primary-link').getAttribute('href')), 'the primary is the EXE');
      t.expect(JSON.stringify(await recommended(page)) === '["windows"]', 'Windows is recommended');
    },
  },
  {
    name: 'dl1-linux',
    url: `${BASE}?release=ok`,
    opts: {devices: ['laptop'], themes: ['light']},
    async fn(page, t) {
      await page.waitForSelector(READY);
      t.expect(await primaryName(page) === 'Download for Linux', `Linux primary (${await primaryName(page)})`);
      t.expect(/\.AppImage$/.test(await page.locator('.download-primary-link').getAttribute('href')), 'the primary is the AppImage');
    },
  },
  {
    name: 'dl1-chromeos',
    url: `${BASE}?release=ok&ua=chromeos`,
    opts: {devices: ['laptop'], themes: ['light']},
    async fn(page, t) {
      await page.waitForSelector(READY);
      t.expect((await primaryName(page)).startsWith('Open web player'), 'web player primary');
      t.expect((await page.locator('.download-detail').textContent()).startsWith('Choose your desktop installer below'), 'the choose-below line');
    },
  },
  {
    name: 'dl1-loading',
    url: `${BASE}?release=slow`,
    async fn(page, t) {
      await page.waitForSelector('.download-page[data-release-state="loading"]');
      t.expect(await page.locator('.download-platforms').getAttribute('aria-busy') === 'true', 'the list is busy');
      t.expect(await page.locator('.ui-skeleton-item').count() === 4, 'one skeleton row per installer');
      t.expect(await page.getByRole('status').filter({hasText: 'Finding available downloads…'}).count() === 1, 'the loading status');
      await targets(page, t, 'loading');
    },
  },
  {
    name: 'dl1-fallback',
    url: `${BASE}?release=fallback&fx-platform=mac`,
    opts: {devices: ['laptop'], themes: ['dark'], capture: false},
    async fn(page, t) {
      await page.waitForSelector(READY);
      const calls = await page.evaluate(() => window.__dl1.calls);
      t.expect(JSON.stringify(calls) === '["/api/downloads","/downloads.json"]', `the bundled manifest answered (${calls})`);
      t.expect(await page.locator('.download-file').count() === 4, 'four installers');
    },
  },
  {
    name: 'dl1-unavailable',
    url: `${BASE}?release=fail`,
    async fn(page, t) {
      await page.waitForSelector('.download-page[data-release-state="unavailable"]');
      t.expect(await page.getByRole('alert').filter({hasText: 'Downloads couldn’t load. Check your connection and try again.'}).count() === 1, 'the outage alert');
      t.expect(await page.getByText('Temporarily unavailable').count() === 3, 'every card is unavailable');
      await targets(page, t, 'unavailable');
    },
  },
  {
    name: 'dl1-retry',
    url: `${BASE}?release=fail&fx-platform=mac`,
    opts: {devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      await page.waitForSelector('.download-page[data-release-state="unavailable"]');
      await page.evaluate(() => window.__dl1.heal());
      const retry = page.getByRole('button', {name: 'Try again'});
      await retry.focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector(READY);
      const focused = await page.evaluate(() => document.activeElement?.classList.contains('download-primary-link'));
      t.expect(focused, 'focus lands on the primary download after Try again');
    },
  },
  {
    name: 'dl1-desktop',
    url: `${BASE}?release=ok&fx-platform=mac&fx-desktop=1`,
    opts: {devices: ['laptop']},
    async fn(page, t) {
      await page.waitForSelector(READY);
      const back = page.getByRole('link', {name: 'Back to your library', exact: true});
      t.expect(await back.count() === 1, 'the way back is named for the desktop app');
      t.expect(await back.getAttribute('target') === null, 'it navigates in place');
      const sameOriginNewTab = await page.evaluate(() => [...document.querySelectorAll('a[target=_blank]')]
        .filter(a => new URL(a.href, location.href).origin === location.origin).map(a => a.textContent));
      t.expect(sameOriginNewTab.length === 0, `no same-origin new-tab links (${sameOriginNewTab})`);
      const notes = page.getByRole('link', {name: 'Release notes (opens in your browser)', exact: true});
      t.expect(await notes.count() === 1, 'external links say they open in the browser');
      t.expect(await notes.getAttribute('target') === '_blank', 'external links keep target=_blank (main opens them externally)');
      t.expect(await page.getByRole('link', {name: /opens in a new tab/}).count() === 0, 'nothing claims a new tab inside the app');
    },
  },
  {
    name: 'dl1-settle-focus',
    url: `${BASE}?release=slow&fx-platform=mac`,
    opts: {devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      await page.waitForSelector('.download-page[data-release-state="loading"]');
      await page.locator('.download-primary-link').focus();
      await page.evaluate(() => window.__dl1.answer());
      await page.waitForSelector(READY);
      const focused = await page.evaluate(() => {
        const a = document.activeElement;
        return a?.classList.contains('download-primary-link') ? a.textContent.replace(/\s+/g, ' ').trim() : a?.tagName;
      });
      t.expect(focused === 'Download for macOS (Apple Silicon)', `focus moved to the new primary (${focused})`);
    },
  },
  {
    name: 'dl1-download',
    url: `${BASE}?release=ok&fx-platform=mac`,
    opts: {devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      await page.waitForSelector(READY);
      const before = page.url();
      const region = await page.locator('.download-status').evaluate(el => ({role: el.getAttribute('role'), shown: getComputedStyle(el).display !== 'none' && !el.closest('[hidden]')}));
      t.expect(region.role === 'status' && region.shown, `the empty status line stays a live region (${JSON.stringify(region)})`);
      await page.locator('.download-primary-link').click();
      t.expect(await page.getByRole('status').filter({hasText: 'Your download should start shortly.'}).count() === 1, 'the started status');
      t.expect(page.url() === before, 'the installer click stayed on the page');
      await page.getByRole('link', {name: 'Other platforms', exact: true}).click();
      await page.waitForFunction(() => document.activeElement?.id === 'all-downloads-title');
      t.expect(page.url() === before, 'Other platforms leaves the URL alone');
      const inView = await page.locator('#all-downloads-title').evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
      t.expect(inView, 'the platform heading is scrolled into view');
    },
  },
  {
    name: 'dl1-focus',
    url: `${BASE}?release=ok&fx-platform=mac`,
    opts: {devices: ['laptop'], capture: false},
    async fn(page, t) {
      await page.waitForSelector(READY);
      const problems = await walkFocus(page, {stops: 40});
      t.expect(!problems.length, `focus:\n${problems.join('\n')}`);
    },
  },
];
