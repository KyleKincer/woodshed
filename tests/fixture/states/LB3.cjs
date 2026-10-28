// LB3's states (architecture §10.4 "LB3": selection bar, bulk delete dialog, card menu web/desktop with Select,
// re-split dialog, setlist page, add-to-setlist with the Undo toast; §11.4).
//
// The app on the fixture database (`/`): LB1a's home already finds card-menu.js by its contract path, so the ⋯ button,
// right-click and long-press open LB3's menu on the real Library:
//   lb3-card-menu-desktop        the menu on the desktop app: every item (Select first once home renders selection), Re-split enabled
//   lb3-card-menu-web            the web: right-click (laptop) / long-press (iPad sheet); Re-split shows its reason
//   lb3-add-to-setlist-undo      Add to setlist ▸ Warm-ups → the 8 s Undo toast; Undo takes the song back out
//   lb3-new-setlist              Add to setlist ▸ New setlist… → name → the list exists with the song (Setlists row)
//   lb3-pin-undo                 Pin → the Pinned row and the Undo toast; Undo unpins
//   lb3-delete-song              Delete… → the Dialog copy → the song leaves the database
//   lb3-resplit-dialog           Re-split… → the dialog (cost line, Stems, Quality) → a re-split job for the song
//   lb3-resplit-wrong-device     D38: an upload from another computer is refused inline
//   lb3-setlist-page             /set/set-friday: header, rows, targets, focus ring walk; touch recorded
//   lb3-setlist-reorder-keys     ⌥↓ on a row saves the new order (database) and keeps focus
//   lb3-setlist-drag             dragging a handle (mouse on the laptop, a finger on the iPad) saves the new order
//   lb3-setlist-remove-undo      ✕ then the 8 s Undo puts the song back in its place
//   lb3-setlist-rename           the inline rename (captured), Enter saves
//   lb3-setlist-play             Play from the top → /s/glasshouse?set=set-friday (the Stage loads)
//   lb3-setlist-missing / -empty the edge states
// The harness (/__harness/library-selection; selection needs home.js's wiring, an I2b handoff, so it runs on real
// cards wired the same way):
//   lb3-selection-bar            three selected: the floating bar, targets; Esc ends selection
//   lb3-selection-keys           ⌘/Ctrl-click, Shift-click range, ⌘A, ⌫ → the Dialog, Esc
//   lb3-selection-cap            ⌘A over 120 songs: "100 selected" and "Up to 100 at a time"
//   lb3-selection-menu           the card menu of a selected card is the selection menu
//   lb3-selection-touch          iPad: long-press a card → Select → tap another → 2 selected
//   lb3-selection-list           selected rows in the list layout
//   lb3-bulk-delete-dialog       the bulk Dialog (captured)
//   lb3-bulk-delete-partial      one song fails on the server: the partial-failure toast and its Details
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');
const {longPressOpens} = require('../probes/probe-touch.cjs');

const NOW = 'fx-now=2026-10-28T12:00:00Z';
const app = (query = '') => `/?fx-reset=1&${NOW}${query ? `&${query}` : ''}`;
const setlist = (id = 'set-friday', query = '') => `/set/${id}?fx-reset=1&${NOW}${query ? `&${query}` : ''}`;
const harness = (query = '') => `/__harness/library-selection?fx-reset=1&${NOW}${query ? `&${query}` : ''}`;
const APP = {ready: 'library'};
// Share… shows its disabled reason "Not built yet" until SH1's share dialog lands (wave 3a, D2).
const SHARE_PENDING = {structure: {placeholder: true}};
const SET = {ready: 'setlist'};
const DARK = {themes: ['dark']};

async function expectTargets(t, page) {
  const targets = await checkTargets(page);
  t.expect(!targets.length, `targets: ${JSON.stringify(targets.slice(0, 6))}`);
}

/** Runs in the page: the visible menu rows' names, with their disabled state and reason. */
function menuRows() {
  const menus = [...document.querySelectorAll('[role=menu]')].filter(m => m.checkVisibility());
  const menu = menus.at(-1);
  if (!menu) return null;
  return [...menu.querySelectorAll('[role^=menuitem]')].map(row => ({
    name: document.getElementById(row.getAttribute('aria-labelledby'))?.textContent ?? row.textContent,
    disabled: row.getAttribute('aria-disabled') === 'true',
    reason: row.getAttribute('aria-describedby') ? document.getElementById(row.getAttribute('aria-describedby'))?.textContent : null,
    keys: row.getAttribute('aria-keyshortcuts'),
  }));
}

const card = (page, title) => page.locator('.lib-grid .lib-card', {has: page.locator('.lib-title-text', {hasText: new RegExp(`^${title}$`)})}).first();

/** Opens a Library card's menu with its ⋯ button (a touch tap on the iPad). */
async function openCardMenu(page, t, title) {
  const target = card(page, title);
  await target.scrollIntoViewIfNeeded();
  const more = target.locator('.lib-more');
  if (t.device === 'ipad') await (await t.touch()).tap(more);
  else await more.click();
  await page.waitForFunction(() => [...document.querySelectorAll('[role=menu]')].some(m => m.checkVisibility()));
}

/** Activates a visible menu row by name (Enter on the focused row works on both presentations). */
async function chooseRow(page, name) {
  const row = page.locator('[role=menu] [role^=menuitem]').filter({hasText: name}).last();
  await row.waitFor({state: 'visible'});
  await row.click();
}

const db = page => page.evaluate(() => window.fixture.db());
const toastText = page => page.evaluate(() => [...document.querySelectorAll('.ui-toast')].filter(n => n.checkVisibility()).map(n => n.textContent).join(' | '));
const waitToast = (page, text) => page.waitForFunction(want => [...document.querySelectorAll('.ui-toast')].some(n => n.checkVisibility() && n.textContent.includes(want)), text);
const clickToastAction = async (page, label) => page.locator('.ui-toast').getByRole('button', {name: label}).click();

// Select (D49) is offered while the view renders the selection (its bar is mounted): home.js's wiring is an I2b
// handoff, so the app's menu starts with Practice until it lands, then with Select.
const hostsSelection = page => page.evaluate(() => !!document.querySelector('[data-testid=selection-bar]'));
const CARD_MENU = ['Select', 'Practice', 'Edit details…', 'Edit chart', 'Edit map', 'Unpin', 'Share…', 'Add to setlist', 'Re-split…', 'Open original source', 'Delete…'];

module.exports = [
  // ------------------------------------------------------------------ the card menu (the app)
  {
    name: 'lb3-card-menu-desktop',
    url: app('fx-desktop=1'),
    opts: {...APP, ...SHARE_PENDING},
    async fn(page, t) {
      await openCardMenu(page, t, 'Glasshouse');
      const rows = await page.evaluate(menuRows);
      const hosted = await hostsSelection(page);
      const want = hosted ? CARD_MENU : CARD_MENU.slice(1);
      t.expect(JSON.stringify(rows.map(r => r.name)) === JSON.stringify(want), `the card menu items ${JSON.stringify(rows.map(r => r.name))}`);
      const byName = Object.fromEntries(rows.map(r => [r.name, r]));
      t.expect(!byName['Re-split…'].disabled, 'Re-split is enabled on the desktop app');
      if (t.device === 'laptop') {
        t.expect(byName.Practice.keys === 'Enter' && byName['Edit details…'].keys === 'E', `shortcut hints ${byName.Practice.keys} ${byName['Edit details…'].keys}`);
        const first = hosted ? 'Select' : 'Practice';
        t.expect(await page.evaluate(name => document.activeElement?.textContent.includes(name), first), `focus starts on ${first}`);
      }
    },
  },
  {
    name: 'lb3-card-menu-web',
    url: app(),
    opts: {...APP, ...SHARE_PENDING},
    async fn(page, t) {
      const target = card(page, 'Low Tide Static');
      await target.scrollIntoViewIfNeeded();
      if (t.device === 'ipad') {
        const res = await longPressOpens(page, target.locator('.lib-card-cover'), {ms: 500, touch: await t.touch()});
        t.expect(res.ok, 'a 500 ms long-press opens the card menu');
      } else {
        await target.locator('.lib-card-cover').click({button: 'right'});
        await page.waitForSelector('[role=menu]');
      }
      const rows = await page.evaluate(menuRows);
      const resplit = rows.find(r => r.name === 'Re-split…');
      t.expect(resplit?.disabled && resplit.reason === 'Needs Woodshed for desktop', `web Re-split ${JSON.stringify(resplit)}`);
      if (await hostsSelection(page)) t.expect(rows[0].name === 'Select', 'Select is first (D49)');
      else t.expect(rows.every(r => r.name !== 'Select'), 'no Select while nothing renders the selection');
      if (t.device === 'ipad') t.expect(await page.locator('.ui-menu[data-presentation=sheet]').count() > 0, 'coarse pointers get the menu as a sheet');
    },
  },
  {
    name: 'lb3-add-to-setlist-undo',
    url: app('fx-desktop=1'),
    opts: {...APP, ...DARK},
    async fn(page, t) {
      await openCardMenu(page, t, 'Glasshouse');
      await chooseRow(page, 'Add to setlist');
      await page.waitForFunction(() => [...document.querySelectorAll('[role=menu]')].filter(m => m.checkVisibility()).some(m => m.textContent.includes('Warm-ups')));
      const sub = await page.evaluate(menuRows);
      const friday = sub.find(r => r.name.startsWith('Friday at the Grange'));
      t.expect(friday?.disabled && friday.reason === 'Already in this list', `a list that has the song ${JSON.stringify(friday)}`);
      await t.capture('submenu');
      await chooseRow(page, 'Warm-ups');
      await waitToast(page, 'Added “Glasshouse” to Warm-ups');
      let lists = (await db(page)).setlists;
      t.expect(lists.find(l => l.id === 'set-warmup').songIds.join() === 'shuffle,quiet,glasshouse', 'the song was appended');
      await t.capture('toast');
      await clickToastAction(page, 'Undo');
      await page.waitForFunction(() => window.fixture.db().setlists.find(l => l.id === 'set-warmup').songIds.join() === 'shuffle,quiet');
      lists = (await db(page)).setlists;
      t.expect(lists.find(l => l.id === 'set-warmup').songIds.join() === 'shuffle,quiet', 'Undo took exactly that song back out');
    },
  },
  {
    name: 'lb3-new-setlist',
    url: app(),
    opts: {...APP, ...DARK, devices: ['laptop']},
    async fn(page, t) {
      await openCardMenu(page, t, 'Second Wind');
      await chooseRow(page, 'Add to setlist');
      await chooseRow(page, 'New setlist…');
      const dialog = page.locator('dialog.ui-dialog');
      await dialog.waitFor();
      await dialog.getByLabel('Name').fill('Thursday rehearsal');
      await t.capture('dialog');
      await dialog.getByRole('button', {name: 'Create'}).click();
      await waitToast(page, 'Created Thursday rehearsal with 1 song');
      const made = (await db(page)).setlists.find(l => l.name === 'Thursday rehearsal');
      t.expect(made && made.songIds.join() === 'secondwind', `the new list ${JSON.stringify(made)}`);
      await page.waitForFunction(() => [...document.querySelectorAll('.lib-set-name')].some(n => n.textContent === 'Thursday rehearsal'));
    },
  },
  {
    name: 'lb3-pin-undo',
    url: app(),
    opts: {...APP, ...DARK},
    async fn(page, t) {
      await openCardMenu(page, t, 'Second Wind');
      await chooseRow(page, 'Pin');
      await waitToast(page, 'Pinned “Second Wind”');
      await page.waitForFunction(() => window.fixture.db().settings.pins.includes('secondwind'));
      await page.waitForFunction(() => [...document.querySelectorAll('.lib-pinned .lib-compact-title')].some(n => n.textContent === 'Second Wind'));
      await t.capture('toast');
      await clickToastAction(page, 'Undo');
      await page.waitForFunction(() => !window.fixture.db().settings.pins.includes('secondwind'));
      t.expect((await db(page)).settings.pins.join() === 'glasshouse,lowtide,nightbus', 'Undo restored the pins');
    },
  },
  {
    name: 'lb3-delete-song',
    url: app(),
    opts: APP,
    async fn(page, t) {
      await openCardMenu(page, t, 'Cobblestone');
      await chooseRow(page, 'Delete…');
      const dialog = page.locator('dialog.ui-dialog');
      await dialog.waitFor();
      t.expect(await dialog.locator('.ui-dialog-title').textContent() === 'Delete “Cobblestone”?', 'the title');
      t.expect(await dialog.locator('.ui-dialog-body').textContent() === 'Its stems and chart are removed from your library. Shared links stop working.', 'the body');
      await t.capture('dialog');
      await dialog.getByRole('button', {name: 'Delete song'}).click();
      await page.waitForFunction(() => !window.fixture.db().songs.some(s => s.id === 'cobblestone'));
      await waitToast(page, 'Deleted “Cobblestone”');
    },
  },
  {
    name: 'lb3-resplit-dialog',
    url: app('fx-desktop=1&fx-prefs=' + encodeURIComponent(JSON.stringify({jobStats: {balanced: {secPerMin: 55, n: 6}}}))),
    opts: APP,
    async fn(page, t) {
      await openCardMenu(page, t, 'Glasshouse');
      await chooseRow(page, 'Re-split…');
      const dialog = page.locator('dialog.ui-dialog');
      await dialog.waitFor();
      t.expect(await dialog.locator('.ui-dialog-title').textContent() === 'Re-split Glasshouse', 'the title');
      const cost = await dialog.locator('.lib-resplit-cost').textContent();
      t.expect(cost === 'Runs on Studio MacBook · about 2 min at Balanced · replaces the stems; your loops, map, spots and chart are kept.', `cost line: ${cost}`);
      t.expect(await dialog.getByRole('radiogroup', {name: 'Stems'}).getByRole('radio', {name: '4 stems'}).getAttribute('aria-checked') === 'true', 'the song’s 4 stems');
      await t.capture('dialog');
      await dialog.getByRole('radio', {name: '6 stems'}).click();
      await dialog.getByRole('button', {name: 'Re-split'}).click();
      await dialog.waitFor({state: 'detached'});
      const job = (await db(page)).jobs.find(j => j.songId === 'glasshouse' && j.kind === 'separate' && j.status !== 'done');
      t.expect(job && job.settings.stemMode === 'six', `the re-split job ${JSON.stringify(job?.settings)}`);
      await waitToast(page, 'Re-splitting “Glasshouse”');
    },
  },
  {
    name: 'lb3-resplit-wrong-device',
    url: app('fx-desktop=1'),
    opts: {...APP, ...DARK},
    async fn(page, t) {
      await page.evaluate(() => window.fixture.update(d => { d.songs.find(s => s.id === 'jam03').originDeviceId = 'dev2'; }));
      await openCardMenu(page, t, 'untitled_jam_03.wav');
      await chooseRow(page, 'Re-split…');
      const dialog = page.locator('dialog.ui-dialog');
      await dialog.getByRole('button', {name: 'Re-split'}).click();
      const error = dialog.locator('.ui-dialog-error');
      await error.waitFor({state: 'visible'});
      const text = await error.textContent();
      t.expect(text === 'Re-split this song on DESKTOP-4F2K9, which has the original file.', `D38 error: ${text}`);
    },
  },

  // ------------------------------------------------------------------ the setlist page
  {
    name: 'lb3-setlist-page',
    url: setlist(),
    opts: SET,
    async fn(page, t) {
      const names = await page.locator('.set-song-title').allTextContents();
      t.expect(names.join() === 'Glasshouse,Low Tide Static,Second Wind,Night Bus,Velvet Arc', `rows ${names}`);
      t.expect(await page.locator('h1').textContent() === 'Friday at the Grange', 'the heading');
      await page.waitForFunction(() => window.fixture.db().setlists.find(l => l.id === 'set-friday').lastOpenedAt > Date.parse('2026-10-28T11:59:00Z'));
      await expectTargets(t, page);
      if (t.device === 'laptop') {
        const focus = await walkFocus(page, {stops: 20});
        t.expect(!focus.length, focus.join('; '));
      }
    },
  },
  {
    name: 'lb3-setlist-reorder-keys',
    url: setlist(),
    opts: {...SET, ...DARK, devices: ['laptop']},
    async fn(page, t) {
      const handle = page.getByRole('button', {name: 'Move Glasshouse', exact: true});
      await handle.focus();
      await page.keyboard.press('Alt+ArrowDown');
      await page.keyboard.press('Alt+ArrowDown');
      await page.waitForFunction(() => window.fixture.db().setlists.find(l => l.id === 'set-friday').songIds.join() === 'lowtide,secondwind,glasshouse,nightbus,velvet');
      t.expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Move Glasshouse', 'focus stays on the moved row');
      const names = await page.locator('.set-song-title').allTextContents();
      t.expect(names[2] === 'Glasshouse', `rows ${names}`);
    },
  },
  {
    name: 'lb3-setlist-drag',
    url: setlist(),
    opts: {...SET, ...DARK},
    async fn(page, t) {
      const handle = page.getByRole('button', {name: 'Move Glasshouse', exact: true});
      const box = await handle.boundingBox();
      const rowH = await page.locator('.set-row').first().evaluate(el => el.offsetHeight);
      const from = {x: box.x + box.width / 2, y: box.y + box.height / 2};
      const to = {x: from.x, y: from.y + rowH * 2 + 4};
      if (t.device === 'ipad') {
        const touch = await t.touch();
        await touch.drag(from, to, {steps: 14});
      } else {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        for (let i = 1; i <= 14; i++) await page.mouse.move(from.x, from.y + ((to.y - from.y) * i) / 14);
        await page.mouse.up();
      }
      await page.waitForFunction(() => window.fixture.db().setlists.find(l => l.id === 'set-friday').songIds.join() === 'lowtide,secondwind,glasshouse,nightbus,velvet');
      t.expect(await page.locator('.set-row[data-dragging]').count() === 0, 'the drag ended');
    },
  },
  {
    name: 'lb3-setlist-remove-undo',
    url: setlist(),
    opts: {...SET},
    async fn(page, t) {
      await page.getByRole('button', {name: 'Remove Second Wind from Friday at the Grange'}).click();
      await waitToast(page, 'Removed “Second Wind” from Friday at the Grange');
      await page.waitForFunction(() => window.fixture.db().setlists.find(l => l.id === 'set-friday').songIds.join() === 'glasshouse,lowtide,nightbus,velvet');
      await t.capture('toast');
      await clickToastAction(page, 'Undo');
      await page.waitForFunction(() => window.fixture.db().setlists.find(l => l.id === 'set-friday').songIds.join() === 'glasshouse,lowtide,secondwind,nightbus,velvet');
      const names = await page.locator('.set-song-title').allTextContents();
      t.expect(names[2] === 'Second Wind', `back in its place: ${names}`);
    },
  },
  {
    name: 'lb3-setlist-rename',
    url: setlist(),
    opts: {...SET},
    async fn(page, t) {
      await page.getByRole('button', {name: 'Rename'}).click();
      const input = page.getByLabel('Setlist name');
      await input.fill('Saturday at the Grange');
      await t.capture('editing');
      await input.press('Enter');
      await page.waitForFunction(() => window.fixture.db().setlists.find(l => l.id === 'set-friday').name === 'Saturday at the Grange');
      t.expect(await page.locator('h1').textContent() === 'Saturday at the Grange', 'the heading follows');
    },
  },
  {
    name: 'lb3-setlist-play',
    url: setlist(),
    opts: {...SET, ...DARK, devices: ['laptop'], capture: false, structure: {placeholder: true}},   // the Stage's surfaces arrive in this wave
    async fn(page, t) {
      await page.getByRole('button', {name: 'Play from the top'}).click();
      await t.ready('stage');
      const url = new URL(page.url());
      t.expect(url.pathname === '/s/glasshouse' && url.searchParams.get('set') === 'set-friday', `the Stage URL ${page.url()}`);
    },
  },
  {
    name: 'lb3-setlist-missing',
    url: setlist('set-999'),
    opts: SET,
    async fn(page, t) {
      t.expect(await page.locator('.set-page').getAttribute('data-state') === 'missing', 'the missing state');
      t.expect(await page.getByRole('heading', {name: 'This setlist isn’t here'}).count() === 1, 'its heading');
    },
  },
  {
    name: 'lb3-setlist-empty',
    url: setlist('set-warmup'),
    opts: {...SET, devices: ['laptop']},
    async fn(page, t) {
      await page.evaluate(() => window.fixture.update(d => { d.setlists.find(l => l.id === 'set-warmup').songIds = []; }));
      await page.waitForFunction(() => document.querySelector('.set-page')?.dataset.state === 'empty');
      t.expect(await page.getByRole('button', {name: 'Play from the top'}).getAttribute('aria-disabled') === 'true', 'Play is disabled');
    },
  },

  // ------------------------------------------------------------------ selection (the harness)
  {
    name: 'lb3-selection-bar',
    url: harness('fx-desktop=1&select=glasshouse,lowtide,secondwind'),
    opts: {},
    async fn(page, t) {
      const bar = page.getByRole('toolbar', {name: 'Selected songs'});
      await bar.waitFor();
      t.expect(await bar.locator('.lib-selbar-count').textContent() === '3 selected', 'the count');
      for (const name of ['Edit details', 'Re-split', 'Delete', 'Done']) t.expect(await bar.getByRole('button', {name}).count() === 1, `${name} on the bar`);
      t.expect(await bar.getByRole('button', {name: /^(Pin|Unpin)$/}).count() === 1, 'Pin on the bar');
      const box = await bar.boundingBox();
      const vp = page.viewportSize();
      t.expect(Math.round(box.height) >= 56, `the bar is 56 px tall (${box.height})`);
      t.expect(Math.abs(box.x + box.width / 2 - vp.width / 2) <= 2, 'the bar is centred');
      await expectTargets(t, page);
      await t.capture();
      if (t.device === 'laptop') {
        await page.locator('body').click({position: {x: 5, y: 5}});
        await page.keyboard.press('Escape');
        await bar.waitFor({state: 'hidden'});
      }
    },
  },
  {
    name: 'lb3-selection-keys',
    url: harness(),
    opts: {devices: ['laptop'], ...DARK, capture: false},
    async fn(page, t) {
      const cover = title => card(page, title).locator('.lib-card-cover');
      await cover('Glasshouse').click({modifiers: ['ControlOrMeta']});
      await cover('Night Bus').click({modifiers: ['Shift']});
      const count = () => page.evaluate(() => window.__sel.selection.count.peek());
      t.expect(await count() === 4, `Shift-click ranges Glasshouse → Night Bus (${await count()})`);
      await cover('Paper Lanterns').click();
      t.expect(await count() === 5, 'a plain click toggles while selecting');
      t.expect(await page.evaluate(() => window.__sel.router.log.length) === 0, 'nothing opened');
      await page.keyboard.press('ControlOrMeta+KeyA');
      t.expect(await count() === 12, `⌘A selects every visible song (${await count()})`);
      await page.keyboard.press('Backspace');
      const dialog = page.locator('dialog.ui-dialog');
      await dialog.waitFor();
      t.expect(await dialog.locator('.ui-dialog-title').textContent() === 'Delete 12 songs?', 'the bulk Dialog');
      await page.keyboard.press('Escape');
      await dialog.waitFor({state: 'detached'});
      await page.keyboard.press('Escape');
      await page.getByRole('toolbar', {name: 'Selected songs'}).waitFor({state: 'hidden'});
      t.expect(await count() === 0, 'Esc ended selection');
    },
  },
  {
    name: 'lb3-selection-cap',
    url: harness('extra=120&select=glasshouse'),
    opts: {devices: ['laptop'], ...DARK},
    async fn(page, t) {
      await page.locator('body').click({position: {x: 5, y: 5}});
      await page.keyboard.press('ControlOrMeta+KeyA');
      const bar = page.getByRole('toolbar', {name: 'Selected songs'});
      await page.waitForFunction(() => document.querySelector('.lib-selbar-count')?.textContent === '100 selected');
      t.expect(await bar.locator('.lib-selbar-cap').textContent() === 'Up to 100 at a time', 'the cap note');
      t.expect(await bar.locator('.lib-selbar-cap').isVisible(), 'the cap note shows');
    },
  },
  {
    name: 'lb3-selection-menu',
    url: harness('fx-desktop=1&select=glasshouse,nightbus'),
    opts: {devices: ['laptop']},
    async fn(page, t) {
      await card(page, 'Night Bus').locator('.lib-card-cover').click({button: 'right'});
      await page.waitForSelector('[role=menu]');
      const rows = (await page.evaluate(menuRows)).map(r => r.name);
      t.expect(JSON.stringify(rows) === JSON.stringify(['Edit details of 2 songs…', 'Unpin 2 songs', 'Add to setlist', 'Re-split 2 songs…', 'Deselect', 'Done', 'Delete 2 songs…']),
        `the selection menu ${JSON.stringify(rows)}`);
    },
  },
  {
    name: 'lb3-selection-touch',
    url: harness(),
    opts: {devices: ['ipad']},
    async fn(page, t) {
      const touch = await t.touch();
      const res = await longPressOpens(page, card(page, 'Glasshouse').locator('.lib-card-cover'), {ms: 500, touch});
      t.expect(res.ok, 'a long-press opens the card menu');
      await chooseRow(page, 'Select');
      await page.getByRole('toolbar', {name: 'Selected songs'}).waitFor();
      await touch.tap(card(page, 'Night Bus').locator('.lib-card-cover'));
      await page.waitForFunction(() => document.querySelector('.lib-selbar-count')?.textContent === '2 selected');
      t.expect(await page.evaluate(() => window.__sel.router.log.length) === 0, 'the tap selected instead of opening');
    },
  },
  {
    name: 'lb3-selection-list',
    url: harness('layout=list&select=glasshouse,lowtide'),
    opts: {},
    async fn(page, t) {
      t.expect(await page.locator('.lib-row[data-selected]').count() === 2, 'two selected rows');
    },
  },
  {
    name: 'lb3-bulk-delete-dialog',
    url: harness('select=glasshouse,lowtide,secondwind'),
    opts: {},
    async fn(page, t) {
      await page.getByRole('toolbar', {name: 'Selected songs'}).getByRole('button', {name: 'Delete'}).click();
      const dialog = page.locator('dialog.ui-dialog');
      await dialog.waitFor();
      t.expect(await dialog.locator('.ui-dialog-title').textContent() === 'Delete 3 songs?', 'the title');
      t.expect(await dialog.locator('.ui-dialog-body').textContent() === 'Their stems and charts are removed from your library. Shared links stop working.', 'the body');
      t.expect(await dialog.getByRole('button', {name: 'Delete 3 songs'}).count() === 1, 'the confirm label');
    },
  },
  {
    name: 'lb3-bulk-delete-partial',
    url: harness('select=cobblestone,velvet&fail=velvet'),
    opts: {...DARK},
    async fn(page, t) {
      await page.getByRole('toolbar', {name: 'Selected songs'}).getByRole('button', {name: 'Delete'}).click();
      await page.locator('dialog.ui-dialog').getByRole('button', {name: 'Delete 2 songs'}).click();
      await waitToast(page, 'Deleted 1 of 2 songs.');
      t.expect(!(await db(page)).songs.some(s => s.id === 'cobblestone'), 'Cobblestone was deleted');
      const text = await toastText(page);
      t.expect(text.includes('Not deleted: Velvet Arc.'), `the report names what stayed: ${text}`);
      t.expect(await page.evaluate(() => window.__sel.selection.list().join()) === 'velvet', 'what failed stays selected');
      await t.capture('toast');
      await clickToastAction(page, 'Details');
      await page.locator('dialog.ui-dialog .lib-fail-list').waitFor();
    },
  },
];
