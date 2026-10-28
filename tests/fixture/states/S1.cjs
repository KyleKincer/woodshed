// S1's states: the app shell's chrome (architecture §10.3 "S1" captures, §11.4).
//
// The shell harness (/__harness/shell) — every chrome state, 4 variants each:
//   s1-shell-topbar          the top bar: heights 56/60, search 40/48, avatar 36/44, the ⌘K hint, targets, focus
//   s1-shell-avatar-web      the avatar menu on the web (Get the desktop app)
//   s1-shell-avatar-desktop  … on the desktop app (App updates, ⌘, on Settings)
//   s1-shell-avatar-admin    … for an administrator (Administration)
//   s1-shell-avatar-update   … with an update ready (the avatar dot, "Update ready — Restart to install")
//   s1-shell-banners         the offline, export-only and codec banners (in flow; Dismiss)
//   s1-shell-fatal           the fatal boot card with Details open
//   s1-shell-paused          the paused-account page
//   s1-shell-signin          the sign-in card (placeholder until ON1) · s1-shell-signin-error with an OAuth error
//   s1-shell-startup         the boot status after 8 s: "Still connecting… [Retry]"
// The app on the fixture database (boot order §2.3.1 end to end):
//   s1-app-library           boots to the Library place with the top bar; the dev handle
//   s1-app-signin            signed out → the sign-in card · s1-app-signin-error with fx-signinError=expired
//   s1-app-welcome           first run (fx-account=new) → /welcome
//   s1-app-fatal             users:me fails → the fatal card; Retry boots again
//   s1-app-paused            a suspended account → the paused page
//   s1-app-export-only       an export-only account → the Library with the banner
//   s1-app-offline           going offline shows the banner; coming back removes it
//   s1-app-stage-no-banners  an export-only account, offline, on the Stage: no banners (full-bleed)
//   s1-app-share-boot        /share/<token> and /download/: the boot status leaves once the page is up
//   s1-app-admin             an administrator's /admin deep link passes its guard; a non-admin's goes home
//   s1-app-keys              ⌘K opens the palette, ? the shortcut sheet, Esc clears the search, / stays native
//   s1-app-redirects         /billing?checkout=success → /settings/plan?checkout=success
// The top bar and every app state import S2's palette, ? sheet and feedback, and the app loads ST1b's session
// module (same-wave peers, §9.0): they declare them in opts.requires.
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');

const SHELL = '/__harness/shell';
const S2 = ['src/app/palette.js', 'src/app/shortcuts-sheet.js'];
const APP = ['src/app/feedback.js', ...S2, 'src/stage/session.js'];
// The Library, Settings and Admin views are later packages: their routes show the placeholder until then.
const PLACEHOLDER_OK = {placeholder: true};

/** Runs in the page: the top bar's geometry. */
function topbarFacts() {
  const box = sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y)}; };
  const bar = document.querySelector('.app-topbar');
  const cs = bar ? getComputedStyle(bar) : null;
  const kbd = document.querySelector('.shell-search-kbd');
  return {
    coarse: matchMedia('(pointer: coarse)').matches,
    bar: box('.app-topbar'), barContent: cs ? parseFloat(cs.height) : null,
    search: box('.shell-search-input'), avatar: box('.shell-avatar'), add: box('.shell-add'), wordmark: box('.shell-wordmark'),
    wordmarkFont: getComputedStyle(document.querySelector('.shell-wordmark')).fontWeight,
    kbdVisible: !!kbd && kbd.checkVisibility(),
    dot: document.querySelector('.shell-avatar-dot')?.checkVisibility() ?? false,
    avatarLabel: document.querySelector('.shell-avatar')?.getAttribute('aria-label'),
  };
}

/** Runs in the page: the open menu's row labels. */
function menuFacts() {
  const menu = document.querySelector('[role=menu]');
  if (!menu) return null;
  return {
    labels: [...menu.querySelectorAll('.ui-menu-label')].map(n => n.textContent),
    kbds: [...menu.querySelectorAll('[role=menuitem]')].map(n => n.getAttribute('aria-keyshortcuts')),
    focused: document.activeElement?.closest('[role=menu]') === menu,
  };
}

const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

async function expectTargets(t, page) {
  const targets = await checkTargets(page);
  t.expect(!targets.length, `targets: ${JSON.stringify(targets)}`);
}

async function expectMenu(t, page, labels) {
  await page.waitForSelector('[role=menu]');
  const facts = await page.evaluate(menuFacts);
  t.expect(JSON.stringify(facts.labels) === JSON.stringify(labels), `menu rows ${JSON.stringify(facts.labels)}`);
  t.expect(facts.focused, 'focus moved into the menu');
  return facts;
}

const WEB_MENU = ['kyle@example.com', 'Settings…', 'Plan & storage', 'Keyboard shortcuts', 'Get the desktop app', 'Sign out'];

module.exports = [
  // ------------------------------------------------------------------ the shell harness
  {
    name: 's1-shell-topbar',
    url: `${SHELL}?part=topbar&q=&jobs=1`,
    opts: {requires: S2},
    async fn(page, t) {
      const f = await page.evaluate(topbarFacts);
      const coarse = t.device === 'ipad';
      t.expect(f.coarse === coarse, 'pointer type follows the device');
      t.expect(near(f.barContent, coarse ? 60 : 56), `top bar ${f.barContent} px (56 fine, 60 coarse)`);
      t.expect(near(f.search.h, coarse ? 48 : 40) && f.search.w <= 520, `search ${JSON.stringify(f.search)}`);
      t.expect(near(f.avatar.h, coarse ? 44 : 36) && near(f.avatar.w, f.avatar.h), `avatar ${JSON.stringify(f.avatar)}`);
      t.expect(near(f.add.h, coarse ? 48 : 40), `Add song ${JSON.stringify(f.add)}`);
      t.expect(f.wordmarkFont === '800', `wordmark weight ${f.wordmarkFont}`);
      t.expect(f.kbdVisible === !coarse, `the ⌘K hint shows on fine pointers only (${f.kbdVisible})`);
      t.expect(f.wordmark.x < f.search.x && f.search.x < f.add.x && f.add.x < f.avatar.x, 'wordmark, search, Add, avatar from left to right');
      t.expect(!f.dot, 'no update dot');
      await expectTargets(t, page);
      if (!coarse) {
        const focus = await walkFocus(page, {stops: 12});
        t.expect(!focus.length, focus.join('; '));
        await page.evaluate(() => document.activeElement?.blur?.());
      }
    },
  },
  {
    name: 's1-shell-avatar-web',
    url: `${SHELL}?part=topbar&menu=1`,
    opts: {requires: S2},
    async fn(page, t) {
      const facts = await expectMenu(t, page, WEB_MENU);
      t.expect(facts.kbds[1] === null, 'Settings shows no ⌘, on the web');
      await expectTargets(t, page);
      await page.keyboard.press('Escape');
      await page.waitForSelector('[role=menu]', {state: 'detached'});
      const back = await page.evaluate(() => ({focused: document.activeElement?.classList.contains('shell-avatar'), expanded: document.querySelector('.shell-avatar').getAttribute('aria-expanded')}));
      t.expect(back.focused && back.expanded === 'false', `Esc closes the menu and returns focus to the avatar ${JSON.stringify(back)}`);
      await page.click('.shell-avatar');
      await page.getByRole('menuitem', {name: 'Plan & storage'}).click();
      const nav = await page.evaluate(() => window.__shell.router.log.at(-1));
      t.expect(JSON.stringify(nav) === JSON.stringify(['navigate', '/settings/plan']), `Plan & storage navigates (${JSON.stringify(nav)})`);
      await page.click('.shell-avatar');
      await page.waitForSelector('[role=menu]');
    },
  },
  {
    name: 's1-shell-avatar-desktop',
    url: `${SHELL}?part=topbar&menu=1&fx-desktop=1`,
    opts: {requires: S2},
    async fn(page, t) {
      const facts = await expectMenu(t, page, ['kyle@example.com', 'Settings…', 'Plan & storage', 'Keyboard shortcuts', 'App updates', 'Sign out']);
      t.expect(/^(Meta|Control)\+,$/.test(facts.kbds[1] ?? ''), `Settings carries ⌘, on the desktop app (${facts.kbds[1]})`);
    },
  },
  {
    name: 's1-shell-avatar-admin',
    url: `${SHELL}?part=topbar&menu=1&admin=1`,
    opts: {requires: S2},
    async fn(page, t) {
      await expectMenu(t, page, ['kyle@example.com', 'Settings…', 'Plan & storage', 'Keyboard shortcuts', 'Get the desktop app', 'Administration', 'Sign out']);
    },
  },
  {
    name: 's1-shell-avatar-update',
    url: `${SHELL}?part=topbar&menu=1&fx-desktop=1&update=ready`,
    opts: {requires: S2},
    async fn(page, t) {
      await expectMenu(t, page, ['kyle@example.com', 'Settings…', 'Plan & storage', 'Keyboard shortcuts', 'Update ready — Restart to install', 'Sign out']);
      const f = await page.evaluate(topbarFacts);
      t.expect(f.dot, 'the avatar dot marks the ready update');
      t.expect(f.avatarLabel === 'Account, update ready', `avatar name "${f.avatarLabel}"`);
      const dot = await page.evaluate(() => { const r = document.querySelector('.shell-avatar-dot').getBoundingClientRect(); return Math.round(r.width); });
      t.expect(dot === 8, `the dot is 8 px (${dot})`);
    },
  },
  {
    name: 's1-shell-banners',
    url: `${SHELL}?part=banners&offline=1&exportOnly=1&codec=1`,
    async fn(page, t) {
      const facts = await page.evaluate(() => [...document.querySelectorAll('.shell-banners > *')].map(b => ({kind: b.dataset.banner, role: b.getAttribute('role'), position: getComputedStyle(b).position})));
      t.expect(JSON.stringify(facts.map(f => f.kind)) === JSON.stringify(['offline', 'export-only', 'codec']), `banners ${JSON.stringify(facts)}`);
      t.expect(facts.every(f => f.position === 'static' || f.position === 'relative'), 'banners are in flow, never fixed');
      t.expect(facts.every(f => f.role === 'status'), 'banners are polite statuses');
      const geometry = await page.evaluate(() => {
        const banners = document.querySelector('.shell-banners').getBoundingClientRect();
        const content = document.querySelector('.shell-outlet h1').getBoundingClientRect();
        return {bannersBottom: Math.round(banners.bottom), contentTop: Math.round(content.top), left: Math.round(banners.left)};
      });
      t.expect(geometry.contentTop >= geometry.bannersBottom, `the view sits below the banners ${JSON.stringify(geometry)}`);
      await expectTargets(t, page);
      await t.capture('all');
      await page.getByRole('button', {name: 'Dismiss'}).click();
      const left = await page.evaluate(() => [...document.querySelectorAll('.shell-banners > *')].map(b => b.dataset.banner));
      t.expect(JSON.stringify(left) === JSON.stringify(['offline', 'export-only']), `Dismiss removes the codec banner (${left})`);
      await page.getByRole('button', {name: 'Plan & storage'}).click();
      const log = await page.evaluate(() => window.__shell.log);
      t.expect(log[0] === '/settings/plan', 'Plan & storage opens /settings/plan');
    },
  },
  {
    name: 's1-shell-fatal',
    url: `${SHELL}?part=fatal&open=1`,
    async fn(page, t) {
      const card = await page.evaluate(() => {
        const el = document.querySelector('.shell-fatal');
        const r = el.getBoundingClientRect();
        return {w: Math.round(r.width), cx: Math.round(r.x + r.width / 2), vw: innerWidth, role: el.getAttribute('role'),
          mono: getComputedStyle(el.querySelector('pre')).fontFamily, focused: document.activeElement?.textContent};
      });
      t.expect(card.w === Math.min(480, card.vw - 32), `the card is 480 px (${card.w})`);
      t.expect(Math.abs(card.cx - card.vw / 2) <= 1, 'the card is centred');
      t.expect(card.role === 'alert', 'the card is an alert');
      t.expect(/Atkinson Hyperlegible Mono/.test(card.mono), `details are mono (${card.mono})`);
      t.expect(card.focused === 'Retry', 'Retry has focus');
      await expectTargets(t, page);
      await page.getByRole('button', {name: 'Retry'}).click();
      t.expect(await page.evaluate(() => window.__shell.retried) === 1, 'Retry calls onRetry');
    },
  },
  {
    name: 's1-shell-paused',
    url: `${SHELL}?part=paused`,
    async fn(page, t) {
      for (const name of ['Manage billing', 'Export library', 'Sign out']) {
        t.expect(await page.getByRole('button', {name}).isVisible(), `${name} is shown`);
      }
      t.expect(await page.getByRole('heading', {name: 'Your account is paused'}).isVisible(), 'the title');
      await expectTargets(t, page);
    },
  },
  {
    name: 's1-shell-signin',
    url: `${SHELL}?part=signin`,
    opts: {structure: PLACEHOLDER_OK},
    async fn(page, t) {
      t.expect(!(await page.getByRole('alert').count()) || !(await page.getByRole('alert').isVisible()), 'no error without one');
      await page.getByRole('button', {name: 'Continue with Google'}).click();
      t.expect((await page.evaluate(() => window.__shell.log)).includes('signIn'), 'Continue with Google signs in');
      await expectTargets(t, page);
    },
  },
  {
    name: 's1-shell-signin-error',
    url: `${SHELL}?part=signin&error=1`,
    opts: {structure: PLACEHOLDER_OK},
    async fn(page, t) {
      const text = await page.getByRole('alert').textContent();
      t.expect(text.includes('This sign-in link expired. Please sign in again.'), `the OAuth error shows (${text})`);
    },
  },
  {
    name: 's1-shell-startup',
    url: `${SHELL}?part=startup&slow=1`,
    async fn(page, t) {
      await page.waitForSelector('#startup[data-slow=true]');
      const facts = await page.evaluate(() => {
        const el = document.getElementById('startup');
        const r = el.getBoundingClientRect();
        return {text: el.textContent, role: el.getAttribute('role'), position: getComputedStyle(el).position, bottomGap: Math.round(innerHeight - r.bottom),
          cx: Math.round(r.x + r.width / 2), vw: innerWidth};
      });
      t.expect(facts.text === 'Still connecting…Retry', `text "${facts.text}"`);
      t.expect(facts.role === 'status', 'a status');
      t.expect(Math.abs(facts.cx - facts.vw / 2) <= 1 && facts.bottomGap >= 24, `centred at the bottom ${JSON.stringify(facts)}`);
      await expectTargets(t, page);
      await page.getByRole('button', {name: 'Retry'}).click();
      t.expect((await page.evaluate(() => window.__shell.retried.length)) === 1, 'Retry runs');
    },
  },

  // ------------------------------------------------------------------ the app on the fixture
  {
    name: 's1-app-library',
    url: '/?fx-reset=1',
    opts: {requires: APP, ready: 'library', structure: PLACEHOLDER_OK},
    async fn(page, t) {
      const facts = await page.evaluate(() => ({
        chrome: document.getElementById('app').dataset.chrome, startup: document.documentElement.dataset.startup,
        status: !!document.getElementById('startup'), handle: typeof window.__woodshed?.idle === 'function',
        session: window.__woodshed.store.session.peek(), sprite: !!document.getElementById('i-play'),
        preload: document.querySelectorAll('link[rel=preload][as=font]').length, scrollers: document.querySelectorAll('[data-scroller]').length,
        songs: window.__woodshed.store.library.songs.peek().size, loaded: window.__woodshed.store.library.loaded.peek(),
        palette: window.__woodshed.commands.isEnabled('app.palette'),
      }));
      t.expect(facts.chrome === 'topbar' && facts.startup === 'ready' && !facts.status, `the frame is up ${JSON.stringify(facts)}`);
      t.expect(facts.handle && facts.session.user?.email && facts.session.status === 'active', 'the dev handle sees the session');
      t.expect(facts.sprite && facts.preload === 2, 'sprite and font preloads');
      t.expect(facts.scrollers === 1, 'one scroller');
      t.expect(facts.loaded && facts.songs > 0, `store.library filled (${facts.songs} songs)`);
      t.expect(facts.palette, 'global commands are registered');
      await expectTargets(t, page);
    },
  },
  {
    name: 's1-app-signin',
    url: '/?fx-auth=signedout&fx-reset=1',
    opts: {requires: APP, ready: false, structure: PLACEHOLDER_OK},
    async fn(page, t) {
      await page.waitForSelector('html[data-startup=signin]');
      t.expect(await page.getByRole('button', {name: 'Continue with Google'}).isVisible(), 'the sign-in card');
      t.expect(!(await page.locator('.app-topbar').count()), 'no top bar');
    },
  },
  {
    name: 's1-app-signin-error',
    url: '/?fx-auth=signedout&fx-signinError=expired&fx-reset=1',
    opts: {requires: APP, ready: false, structure: PLACEHOLDER_OK, devices: ['laptop'], themes: ['light']},
    async fn(page, t) {
      await page.waitForSelector('html[data-startup=signin]');
      const text = await page.getByRole('alert').textContent();
      t.expect(text.includes('This sign-in link expired.'), `the OAuth error (${text})`);
    },
  },
  {
    name: 's1-app-welcome',
    url: '/?fx-account=new&fx-reset=1',
    opts: {requires: APP, ready: 'welcome', structure: PLACEHOLDER_OK},
    async fn(page, t) {
      const facts = await page.evaluate(() => ({path: location.pathname, chrome: document.getElementById('app').dataset.chrome, idx: history.state.idx}));
      t.expect(facts.path === '/welcome' && facts.chrome === 'none' && facts.idx === 1, `pushed /welcome ${JSON.stringify(facts)}`);
    },
  },
  {
    name: 's1-app-fatal',
    url: '/?fx-auth=fail&fx-reset=1',
    opts: {requires: APP, ready: false, devices: ['laptop'], themes: ['light', 'dark']},
    async fn(page, t) {
      await page.waitForSelector('.shell-fatal');
      t.expect(await page.getByRole('heading', {name: 'Couldn’t open Woodshed'}).isVisible(), 'the fatal card');
      await page.getByText('Details').click();
      const raw = await page.locator('.shell-fatal pre').textContent();
      t.expect(raw.length > 0, `raw details (${raw})`);
      await t.capture('details');
      // Retry runs auth.initialize() again (still failing on this database): the card comes back.
      await page.getByRole('button', {name: 'Retry'}).click();
      await page.waitForSelector('#startup');
      await page.waitForSelector('.shell-fatal');
    },
  },
  {
    name: 's1-app-paused',
    url: '/?fx-auth=suspended&fx-reset=1',
    opts: {requires: APP, ready: false},
    async fn(page, t) {
      await page.waitForSelector('.shell-paused');
      t.expect(await page.getByRole('heading', {name: 'Your account is paused'}).isVisible(), 'the paused page');
      t.expect(!(await page.locator('.app-topbar').count()), 'no top bar, no Library');
    },
  },
  {
    name: 's1-app-export-only',
    url: '/?fx-auth=export_only&fx-reset=1',
    opts: {requires: APP, ready: 'library', structure: PLACEHOLDER_OK},
    async fn(page, t) {
      const text = await page.locator('[data-banner=export-only]').textContent();
      t.expect(text.includes('Adding songs is paused on this account.'), `the export-only banner (${text})`);
    },
  },
  {
    name: 's1-app-stage-no-banners',
    url: '/s/glasshouse?fx-auth=export_only&fx-reset=1',
    opts: {requires: APP, ready: 'stage', structure: PLACEHOLDER_OK, devices: ['laptop', 'ipad'], themes: ['light'], capture: false},
    async fn(page, t) {
      // The Stage is full-bleed (chrome 'none'): no top bar and none of the shell's banners, even offline.
      await page.evaluate(() => dispatchEvent(new Event('offline')));
      const facts = await page.evaluate(() => ({chrome: document.getElementById('app')?.dataset.chrome,
        banners: document.querySelectorAll('.shell-banners > *').length}));
      t.expect(facts.chrome === 'none', `chrome none (${facts.chrome})`);
      t.expect(facts.banners === 0, `no banners on the Stage (${facts.banners})`);
      await page.evaluate(() => dispatchEvent(new Event('online')));
    },
  },
  {
    name: 's1-app-share-boot',
    url: `/share/${'a'.repeat(64)}?fx-reset=1`,
    opts: {requires: APP, ready: false, structure: PLACEHOLDER_OK, devices: ['laptop', 'ipad'], themes: ['light'], capture: false},
    async fn(page, t) {
      // A boot route: once its module's boot() resolves, the "Opening Woodshed…" status leaves.
      await page.waitForSelector('html[data-view-ready]', {state: 'attached'});
      await page.waitForSelector('#startup', {state: 'detached'});
      t.expect(await page.evaluate(() => document.documentElement.dataset.startup) !== 'loading', 'the boot status is dismissed');
      await page.goto(`${t.base}/download/?fx-reset=1`);
      await page.waitForSelector('html[data-view-ready]', {state: 'attached'});
      await page.waitForSelector('#startup', {state: 'detached'});
    },
  },
  {
    name: 's1-app-offline',
    url: '/?fx-reset=1',
    opts: {requires: APP, ready: 'library', structure: PLACEHOLDER_OK, devices: ['laptop'], themes: ['light']},
    async fn(page, t) {
      await page.evaluate(() => dispatchEvent(new Event('offline')));
      await page.waitForSelector('[data-banner=offline]');
      t.expect(await page.evaluate(() => window.__woodshed.store.session.peek().online) === false, 'store.session.online follows');
      await t.capture('offline');
      await page.evaluate(() => dispatchEvent(new Event('online')));
      await page.waitForSelector('[data-banner=offline]', {state: 'detached'});
    },
  },
  {
    name: 's1-app-admin',
    url: '/admin?fx-admin=1&fx-reset=1',
    opts: {requires: APP, ready: 'admin', structure: PLACEHOLDER_OK, devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      t.expect(await page.evaluate(() => location.pathname) === '/admin', 'an administrator stays on /admin');
      await page.goto(`${t.base}/admin?fx-admin=0&fx-reset=1`);
      await t.ready('library');
      t.expect(await page.evaluate(() => location.pathname) === '/', 'a non-admin goes home');
    },
  },
  {
    name: 's1-app-keys',
    url: '/settings?fx-reset=1',
    opts: {requires: APP, ready: 'settings', structure: PLACEHOLDER_OK, devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      // Typing in the top bar's search outside the Library opens it filtered.
      await page.getByRole('searchbox', {name: 'Search songs'}).fill('glass');
      await t.ready('library');
      t.expect(await page.evaluate(() => location.search) === '?q=glass', 'the Library opens with ?q=glass');
      // Esc in the field blurs it; Esc again (app.escape) clears the search.
      await page.keyboard.press('Escape');
      t.expect(await page.evaluate(() => document.activeElement === document.body), 'Esc blurs the search field');
      await page.keyboard.press('Escape');
      t.expect(await page.getByRole('searchbox', {name: 'Search songs'}).inputValue() === '', 'Esc clears the search');
      // ⌘K and ? reach the registry from anywhere.
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
      t.expect(await page.evaluate(() => window.__woodshed.commands.isEnabled('app.palette')), 'app.palette is enabled');
      await page.keyboard.press(`${mod}+KeyK`);
      await page.keyboard.press('Escape');
      t.expect(await page.evaluate(() => window.__woodshed.commands.isEnabled('app.shortcuts')), 'app.shortcuts is enabled');
    },
  },
  {
    name: 's1-app-redirects',
    url: '/billing?checkout=success&fx-reset=1',
    opts: {requires: APP, ready: 'settingsPage', structure: PLACEHOLDER_OK, devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      const at = await page.evaluate(() => location.pathname + location.search);
      t.expect(at.startsWith('/settings/plan?checkout=success'), `redirected to ${at}`);
    },
  },
];
