// Drive the full-app fixture and capture every screen/state.
//   NODE_PATH=/opt/node-tools/node_modules node capture.cjs <laptop|ipad> <light|dark> [filter-regex]
const {chromium} = require('playwright');
const path = require('path');
const BASE = process.env.FIXTURE_URL || 'http://127.0.0.1:5190';
const OUT = path.resolve(__dirname, '../shots');
const [device = 'laptop', theme = 'light', filter = ''] = process.argv.slice(2);
const VIEWPORTS = {laptop: {width: 1440, height: 900}, ipad: {width: 820, height: 1180}};
const TOKEN = 'a3f1'.repeat(16);

const COVER_SVG = (hue) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 250"><rect width="250" height="250" fill="hsl(${hue} 45% 40%)"/><circle cx="125" cy="125" r="70" fill="hsl(${hue} 60% 75%)"/></svg>`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ready(page) { await page.waitForFunction(() => ['ready', 'signin', 'download'].includes(document.documentElement.dataset.startup), null, {timeout: 20000}); await sleep(400); }
async function playerReady(page) {
  await page.waitForFunction(() => document.querySelector('#player-root .player') && !document.querySelector('#player-root .player.is-loading') && !document.querySelector('#player-root [aria-busy="true"]'), null, {timeout: 60000});
  await sleep(900);
}
async function chartReady(page) { await page.waitForSelector('.chart:not([hidden]) svg, .chart:not([hidden]) .notation-empty, .chart:not([hidden]) .chart-empty, .chart:not([hidden]) h2', {timeout: 30000}); await sleep(1200); }
async function editorReady(page) { await page.waitForSelector('.notation-workspace:not([hidden]) .notation-heading', {timeout: 30000}); await sleep(1500); }
async function openSong(page, id, q = '') { await page.goto(`${BASE}/?song=${id}${q}`); await ready(page); await playerReady(page); }
async function cardMenu(page, title) { await page.click(`.card-menu[aria-label="Actions for ${title}"]`); await sleep(250); }
async function menuItem(page, label) { await page.click(`.ctx-menu .ctx-item:text-is("${label}")`); await sleep(500); }
async function key(page, k) { await page.keyboard.press(k); await sleep(250); }

const S = [];
const add = (name, fn, opts = {}) => S.push({name, fn, ...opts});

// ---------- sign-in / startup ----------
add('auth-signin', async p => { await p.goto(`${BASE}/?fx-auth=signedout`); await ready(p); });
add('auth-signin-error-expired', async p => { await p.goto(`${BASE}/?fx-auth=signedout&fx-signinError=expired`); await ready(p); });
add('auth-signin-opening-google', async p => { await p.goto(`${BASE}/?fx-auth=signedout`); await ready(p); await p.click('.google-signin'); await sleep(150); });
add('startup-loading-skeleton', async p => { await p.goto(`${BASE}/?fx-library=slow`); await sleep(2500); });
add('startup-boot-failed', async p => { await p.goto(`${BASE}/?fx-auth=fail`); await p.waitForSelector('#signin .setup-card h2', {timeout: 15000}); await sleep(300); });
add('auth-account-suspended', async p => { await p.goto(`${BASE}/?fx-auth=suspended`); await p.waitForSelector('#signin .setup-card h2', {timeout: 15000}); await sleep(300); });

// ---------- library ----------
for (const view of ['songs-grid', 'songs-list', 'albums-grid', 'albums-list', 'artists-grid', 'artists-list'])
  add(`library-${view}`, async p => { await p.goto(`${BASE}/?fx-view=${view}`); await ready(p); await p.evaluate(() => window.fixture.freezeJobs()); }, {fullPage: true});
add('library-songs-grid-viewport', async p => { await p.goto(`${BASE}/`); await ready(p); });
add('library-no-jobs-grid', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); });
add('library-search-results', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await p.fill('#lib-search', 'northbound'); await sleep(500); });
add('library-search-no-results', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await p.fill('#lib-search', 'zzzz'); await sleep(500); });
add('library-card-menu', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await cardMenu(p, 'Glasshouse'); });
add('library-list-row-menu', async p => { await p.goto(`${BASE}/?fx-jobs=0&fx-view=songs-list`); await ready(p); await cardMenu(p, 'Second Wind'); });
add('library-select-mode', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await p.click('.library-selection [data-select]'); await sleep(300); for (const t of ['Glasshouse', 'Low Tide Static', 'Quiet Hours']) { await p.check(`.song-select[aria-label="Select ${t}"]`); await sleep(150); } });
add('library-empty', async p => { await p.goto(`${BASE}/?fx-library=empty`); await ready(p); });
add('library-reprocessing-card-grid', async p => { await p.goto(`${BASE}/?fx-jobs=1`); await ready(p); await p.evaluate(() => window.fixture.freezeJobs()); await p.locator('[data-job="job-re"]').scrollIntoViewIfNeeded(); await sleep(300); });
add('library-account-menu', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await p.click('.account-trigger'); await sleep(300); });
add('library-account-menu-admin-desktop', async p => { await p.goto(`${BASE}/?fx-jobs=0&fx-admin=1&fx-desktop=1`); await ready(p); await p.click('.account-trigger'); await sleep(300); });
add('library-desktop-update-available', async p => { await p.goto(`${BASE}/?fx-jobs=0&fx-desktop=1&fx-update=available`); await ready(p); await sleep(800); });
add('library-desktop-update-downloading', async p => { await p.goto(`${BASE}/?fx-jobs=0&fx-desktop=1&fx-update=downloading`); await ready(p); await sleep(800); });
add('library-codec-banner', async p => { await p.addInitScript(() => { if (window.MediaSource) MediaSource.isTypeSupported = () => false; const orig = HTMLMediaElement.prototype.canPlayType; HTMLMediaElement.prototype.canPlayType = function (t) { return /opus/.test(t) ? '' : orig.call(this, t); }; }); await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); });
add('library-reprocess-dialog', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await cardMenu(p, 'Second Wind'); await menuItem(p, 'Reprocess…'); });
add('library-delete-confirm', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await cardMenu(p, 'Second Wind'); await menuItem(p, 'Delete'); });

// ---------- add song ----------
add('add-song-web-needs-desktop', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await p.click('#add-btn'); await sleep(400); });
add('add-song-modal', async p => { await p.goto(`${BASE}/?fx-jobs=0&fx-desktop=1`); await ready(p); await p.click('#add-btn'); await sleep(400); });
add('add-song-modal-filled', async p => { await p.goto(`${BASE}/?fx-jobs=0&fx-desktop=1`); await ready(p); await p.click('#add-btn'); await p.fill('#add-url', 'https://www.youtube.com/watch?v=harbor-lights'); await p.selectOption('#add-preset', 'studio'); await p.dispatchEvent('#add-preset', 'change'); await sleep(300); });
add('add-song-preset-menu-custom', async p => { await p.goto(`${BASE}/?fx-jobs=0&fx-desktop=1`); await ready(p); await p.click('#add-btn'); await p.selectOption('#add-preset', 'custom'); await p.dispatchEvent('#add-preset', 'change'); await p.fill('#add-url', 'ada moreno harbor lights'); await sleep(300); });
add('add-song-submitted-queued', async p => { await p.goto(`${BASE}/?fx-jobs=0&fx-desktop=1`); await ready(p); await p.click('#add-btn'); await p.fill('#add-url', 'ada moreno harbor lights'); await p.click('#add-go'); await sleep(700); });
add('add-song-submitted-downloading', async p => { await p.goto(`${BASE}/?fx-jobs=0&fx-desktop=1`); await ready(p); await p.click('#add-btn'); await p.fill('#add-url', 'https://www.youtube.com/watch?v=harbor-lights'); await p.click('#add-go'); await sleep(2600); });
add('add-song-error-processor-offline', async p => { await p.goto(`${BASE}/?fx-jobs=0&fx-desktop=1&fx-companion=offline`); await ready(p); await sleep(500); await p.click('#add-btn'); await p.fill('#add-url', 'https://www.youtube.com/watch?v=harbor-lights'); await p.click('#add-go'); await sleep(900); });
add('add-song-drop-overlay', async p => { await p.goto(`${BASE}/?fx-jobs=0&fx-desktop=1`); await ready(p); await p.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'take1.wav', {type: 'audio/wav'})); window.dispatchEvent(new DragEvent('dragenter', {dataTransfer: dt, bubbles: true})); }); await sleep(300); });
add('add-song-modal-drop-hover', async p => { await p.goto(`${BASE}/?fx-jobs=0&fx-desktop=1`); await ready(p); await p.click('#add-btn'); await p.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'take1.wav', {type: 'audio/wav'})); document.getElementById('file-drop').dispatchEvent(new DragEvent('dragover', {dataTransfer: dt, bubbles: true, cancelable: true})); }); await sleep(300); });
add('add-song-file-uploading', async p => { await p.goto(`${BASE}/?fx-jobs=0&fx-desktop=1`); await ready(p); await p.click('#add-btn'); await p.setInputFiles('#add-file-input', {name: 'rehearsal-2026-10-12.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(4096)}); await sleep(350); });

// ---------- song metadata ----------
const routeCovers = async p => { let h = 0; await p.route(/coverartarchive\.org/, r => r.fulfill({contentType: 'image/svg+xml', body: COVER_SVG((h += 67) % 360)})); };
add('metadata-edit-song', async p => { await routeCovers(p); await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await cardMenu(p, 'Glasshouse'); await menuItem(p, 'Edit song…'); await sleep(400); });
add('metadata-edit-song-scrolled', async p => { await routeCovers(p); await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await cardMenu(p, 'Glasshouse'); await menuItem(p, 'Edit song…'); await p.evaluate(() => { const b = document.querySelector('.metadata-body'); if (b) b.scrollTop = b.scrollHeight; }); await p.fill('#metadata-tuning', 'Drop D'); await sleep(300); });
add('metadata-find-matches', async p => { await routeCovers(p); await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await cardMenu(p, 'Glasshouse'); await menuItem(p, 'Edit song…'); await p.click('[data-find]'); await sleep(1200); });
add('metadata-review-match', async p => { await routeCovers(p); await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await cardMenu(p, 'Glasshouse'); await menuItem(p, 'Edit song…'); await p.click('[data-find]'); await sleep(1100); await p.click('.metadata-match [data-review]'); await sleep(800); });
add('metadata-choose-cover', async p => { await routeCovers(p); await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await cardMenu(p, 'Glasshouse'); await menuItem(p, 'Edit song…'); await p.click('[data-cover]'); await sleep(1100); await p.click('.metadata-match [data-releases]'); await sleep(1100); });
add('metadata-untagged-upload', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await cardMenu(p, 'untitled_jam_03.wav'); await menuItem(p, 'Edit song…'); await sleep(400); });
add('metadata-bulk-edit', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await p.click('.library-selection [data-select]'); for (const t of ['Glasshouse', 'Low Tide Static', 'Quiet Hours']) await p.check(`.song-select[aria-label="Select ${t}"]`); await p.click('.library-selection [data-edit]'); await sleep(400); await p.fill('#metadata-genre', 'Indie rock'); await sleep(200); });

// ---------- settings / billing / admin ----------
add('settings', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await p.click('.account-settings'); await sleep(900); }, {fullPage: true});
add('settings-advanced-open', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await p.click('.account-settings'); await sleep(600); await p.click('#custom-section summary'); await p.locator('#custom-section').scrollIntoViewIfNeeded(); await sleep(400); });
add('settings-desktop', async p => { await p.goto(`${BASE}/?fx-jobs=0&fx-desktop=1`); await ready(p); await p.click('.account-settings'); await sleep(900); await p.click('#library-management-title'); await p.evaluate(() => document.querySelector('#view-settings details.management-item')?.setAttribute('open', '')); await p.locator('#library-management-title').scrollIntoViewIfNeeded(); await sleep(300); });
for (const b of ['free', 'plus', 'cancel', 'grace', 'disabled'])
  add(`billing-${b}`, async p => { await p.goto(`${BASE}/billing?fx-jobs=0&fx-billing=${b}`); await ready(p); await sleep(700); }, {fullPage: true});
add('billing-checkout-error', async p => { await p.goto(`${BASE}/billing?fx-jobs=0`); await ready(p); await sleep(500); await p.click('#billing-checkout'); await sleep(1400); });
add('admin', async p => { await p.goto(`${BASE}/admin?fx-jobs=0&fx-admin=1`); await ready(p); await sleep(800); await p.click('.admin-user[data-id="user2"]'); await sleep(600); }, {fullPage: true});
add('download-page', async p => { await p.goto(`${BASE}/download`); await sleep(2500); }, {fullPage: true});

// ---------- player: tracks ----------
add('player-loading', async p => { await p.goto(`${BASE}/?song=lanterns&fx-jobs=0&fx-practice=tracks&fx-media=slow`); await ready(p); await p.waitForSelector('.player-load-progress'); await sleep(1200); });
add('player-tracks-drums-song', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0&fx-practice=tracks'); });
add('player-tracks-6-stems', async p => { await openSong(p, 'lanterns', '&fx-jobs=0&fx-practice=tracks'); });
add('player-tracks-2-stems', async p => { await openSong(p, 'nightbus', '&fx-jobs=0&fx-practice=tracks'); });
add('player-loop-speed-muted-overview', async p => { await openSong(p, 'secondwind', '&fx-jobs=0&fx-practice=tracks&fx-overview=1'); });
add('player-zoomed-grid-quarter-snap', async p => { await openSong(p, 'secondwind', '&fx-jobs=0&fx-practice=tracks'); await p.selectOption('#grid-division', '4').catch(() => {}); await p.dispatchEvent('#grid-division', 'change').catch(() => {}); await p.mouse.click(10, 10); await key(p, '='); await key(p, '='); await key(p, 'Shift+S'); });
add('player-solo-and-volume', async p => { await openSong(p, 'lowtide', '&fx-jobs=0&fx-practice=tracks'); await p.click('.tbtn.solo[data-stem="bass"]'); await p.fill('.track-vol[data-stem="drums"]', '0.35'); await p.dispatchEvent('.track-vol[data-stem="drums"]', 'input'); await sleep(500); });
add('player-playing', async p => { await openSong(p, 'lowtide', '&fx-jobs=0&fx-practice=tracks'); await p.click('#play'); await sleep(2500); });
add('player-metronome-popover', async p => { await openSong(p, 'secondwind', '&fx-jobs=0&fx-practice=tracks'); await p.click('#metro-btn'); await sleep(300); await p.click('#m-onoff'); await p.check('#m-countin'); await sleep(300); });
add('player-detect-beats', async p => { await openSong(p, 'lowtide', '&fx-jobs=0&fx-practice=tracks&fx-desktop=1'); await p.click('#metro-btn'); await sleep(200); await p.click('#m-detect'); await sleep(500); });
add('player-load-error', async p => { await p.goto(`${BASE}/?song=lowtide&fx-jobs=0&fx-media=fail&fx-practice=tracks`); await ready(p); await p.waitForSelector('.player-load-error'); await sleep(300); });
add('player-help-tooltip-button', async p => { await openSong(p, 'lowtide', '&fx-jobs=0&fx-practice=tracks'); await p.hover('#help'); await sleep(1500); });

// ---------- tempo map ----------
add('tempo-map-mode', async p => { await openSong(p, 'secondwind', '&fx-jobs=0&fx-practice=tracks'); await p.click('#map-btn'); await sleep(800); });
add('tempo-map-drum-song', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0&fx-practice=tracks'); await p.click('#map-btn'); await sleep(800); });
add('tempo-map-more-menu', async p => { await openSong(p, 'secondwind', '&fx-jobs=0&fx-practice=tracks'); await p.click('#map-btn'); await sleep(500); await p.click('[data-map="more"]'); await sleep(300); });
add('tempo-map-all-keys', async p => { await openSong(p, 'secondwind', '&fx-jobs=0&fx-practice=tracks'); await p.click('#map-btn'); await sleep(500); await p.click('.mi-allkeys'); await sleep(300); });
add('tempo-map-edit-bar', async p => { await openSong(p, 'secondwind', '&fx-jobs=0&fx-practice=tracks'); await p.click('#map-btn'); await sleep(500); await p.click('[data-map="edit"]'); await sleep(400); });
add('tempo-map-default-unmapped', async p => { await openSong(p, 'lowtide', '&fx-jobs=0&fx-practice=tracks'); await p.click('#map-btn'); await sleep(800); });
add('tempo-sources-dialog', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0&fx-practice=tracks'); await p.click('#map-btn'); await sleep(500); await p.click('[data-map="sources"]'); await sleep(400); await p.click('.ts-search button[type=submit]').catch(() => {}); await sleep(900); });
add('tempo-sources-trying-map', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0&fx-practice=tracks'); await p.click('#map-btn'); await sleep(500); await p.click('[data-map="sources"]'); await sleep(400); await p.click('.ts-search button[type=submit]').catch(() => {}); await sleep(900); await p.click('.ts-choice[data-choice="2"]'); await sleep(1200); });

// ---------- drum chart ----------
add('chart-practice', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0'); await chartReady(p); });
add('chart-hands-feet', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0'); await chartReady(p); await p.click('button:text-is("Hands / feet")'); await sleep(1200); });
add('chart-chorus-loop-playing', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0'); await chartReady(p); await p.click('button:text-is("Chorus")'); await sleep(600); await p.click('button:text-is("Loop section")').catch(() => {}); await sleep(400); await p.click('#play'); await sleep(2500); });
add('chart-empty-state', async p => { await openSong(p, 'lowtide', '&fx-jobs=0'); await p.click('[data-practice-view="chart"]'); await chartReady(p); });

// ---------- transcribe ----------
add('transcribe-score', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0'); await p.click('[data-workspace="transcribe"]'); await editorReady(p); });
add('transcribe-lanes', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0&fx-notation=lanes'); await p.click('[data-workspace="transcribe"]'); await editorReady(p); });
add('transcribe-kit-panel', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0'); await p.click('[data-workspace="transcribe"]'); await editorReady(p); await p.click('[data-action="panel-kit"]'); await sleep(800); });
add('transcribe-properties-panel', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0'); await p.click('[data-workspace="transcribe"]'); await editorReady(p); await p.click('[data-action="panel-properties"]'); await sleep(800); });
add('transcribe-listen-panel', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0'); await p.click('[data-workspace="transcribe"]'); await editorReady(p); await p.click('[data-action="panel-mixer"]'); await sleep(800); });
add('transcribe-commands-menu', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0'); await p.click('[data-workspace="transcribe"]'); await editorReady(p); await p.click('.notation-menu summary'); await sleep(400); });
add('transcribe-shortcuts-dialog', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0'); await p.click('[data-workspace="transcribe"]'); await editorReady(p); await p.click('.notation-menu summary'); await sleep(200); await p.click('[data-action="shortcuts"]'); await sleep(500); });
add('transcribe-empty-song', async p => { await openSong(p, 'lowtide', '&fx-jobs=0'); await p.click('[data-workspace="transcribe"]'); await editorReady(p); });
add('transcribe-lanes-empty-song', async p => { await openSong(p, 'lowtide', '&fx-jobs=0&fx-notation=lanes'); await p.click('[data-workspace="transcribe"]'); await editorReady(p); });

// ---------- sharing ----------
add('share-dialog-active-link', async p => { await openSong(p, 'glasshouse', '&fx-jobs=0&fx-practice=tracks'); await p.click('.header-share-song'); await sleep(600); });
add('share-dialog-new', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await cardMenu(p, 'Paper Lanterns'); await menuItem(p, 'Share song…'); await sleep(400); });
add('share-dialog-created', async p => { await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); await cardMenu(p, 'Paper Lanterns'); await menuItem(p, 'Share song…'); await sleep(300); await p.click('#share-dialog [data-copy]'); await sleep(700); });
add('shared-song-signed-in', async p => { await p.goto(`${BASE}/share/${TOKEN}`); await ready(p); await playerReady(p); await sleep(1500); });
add('shared-song-signed-out', async p => { await p.goto(`${BASE}/share/${TOKEN}?fx-auth=signedout`); await ready(p); await playerReady(p); await sleep(1500); });
add('shared-song-already-saved', async p => { await p.goto(`${BASE}/share/${TOKEN}?fx-share=saved`); await ready(p); await playerReady(p); await sleep(1500); });
add('shared-song-tracks', async p => { await p.goto(`${BASE}/share/${TOKEN}?fx-practice=tracks`); await ready(p); await playerReady(p); await sleep(800); });
add('shared-song-unavailable', async p => { await p.goto(`${BASE}/share/${TOKEN}?fx-share=missing`); await sleep(2500); });

(async () => {
  const re = filter ? new RegExp(filter) : null;
  const browser = await chromium.launch({args: ['--autoplay-policy=no-user-gesture-required']});
  const results = [];
  for (const s of S) {
    if (re && !re.test(s.name)) continue;
    const context = await browser.newContext({viewport: VIEWPORTS[device], colorScheme: theme, deviceScaleFactor: 1, hasTouch: device === 'ipad', permissions: ['clipboard-read', 'clipboard-write']});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    page.on('dialog', d => d.accept());
    const file = path.join(OUT, `${s.name}--${device}-${theme}.png`);
    try {
      await s.fn(page);
      await page.screenshot({path: file, fullPage: !!s.fullPage});
      results.push(`ok   ${path.basename(file)}${errors.length ? '  [errors: ' + errors.slice(0, 2).join(' | ') + ']' : ''}`);
    } catch (e) {
      try { await page.screenshot({path: file.replace('.png', '.FAILED.png')}); } catch {}
      results.push(`FAIL ${s.name}: ${e.message.split('\n')[0]}`);
    }
    console.log(results.at(-1));
    await context.close();
  }
  await browser.close();
})();
