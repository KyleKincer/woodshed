// Verification VF1 (architecture §10.3): probes, flows and spec checks on the merged wave-1
// tree. A states module for the runner (§11.4), loaded with --state-file:
//   npm run fixture:capture -- --state-file tests/fixture/flows/VF1.cjs --strict-requires
// Every route that exists after I1b is probed at laptop 1440×900 and iPad 820×1180 (touch,
// fx-platform=ipad) in both themes:
//   vf1-probe-<route>      targets (fine ≥ 24, coarse ≥ 44), readouts (spec sizes), the type floor
//                          (12 px; 14 px for control text on iPad except 12/600 caps overlines;
//                          spec §8.1), and
//                          captures of every scroll position (visual review)
//   vf1-axe-<route>        axe-core 4.10.3, WCAG 2.0–2.2 A/AA + best practice (probe-axe.cjs)
//   vf1-focus-<route>      the focus ring on every Tab stop (laptop; probe-focus.cjs)
// for the routes library (/), signin (fx-auth=signedout), welcome (/welcome) and download
// (/download); the same probes on the Jobs popover, the review popover, the avatar menu, the
// palette (⌘K with a query) and the ? sheet over the Library (vf1-jobs-popover, vf1-review-popover,
// vf1-avatar-menu, vf1-app-palette, vf1-app-shortcuts), and on the shell's fatal and paused
// screens and its export-only and offline banners (vf1-shell-*). Then:
//   vf1-touch-card-menu    long-press (500 ms) on every song card and list row → onMenu, a
//                          shorter press is a tap, job cards never ask for a menu (probe-touch.cjs)
//   vf1-touch-app-card     in the app a tap on a card opens the song
//   vf1-flow-back-*        Back from the Stage refocuses the opened card (mouse, keyboard with a
//                          visible ring, iPad tap with the scroll position kept, and the Stage's
//                          own ‹ "Back to Library", the HUD's HoldButton: a button, a plain click
//                          while stopped)
//   vf1-flow-intended-*    the intended route survives sign-in (web: the OAuth return URL is the
//                          route; desktop: ws.intendedRoute brings the reload at / back to it)
//   vf1-flow-prefs-tabs    Library prefs sync across two tabs (storage event, both ways), the URL
//                          mirrors the view state, and the synced prefs drive the next Library
//   vf1-spec-cover-veil    processing and re-splitting covers render at 55% (measured in pixels)
//   vf1-spec-recents-line  a compact recent shows one state line (spec §2.2)
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');
const {longPressOpens, shortPressDoesNotOpen} = require('../probes/probe-touch.cjs');
const {checkAxe} = require('../probes/probe-axe.cjs');
const {checkReadouts} = require('../probes/probe-readouts.cjs');
const {decodePng, fitAlpha, parseRgb} = require('./png.cjs');
const {CONTROL, textFacts, typeProblems, veilProblems, recentsProblems} = require('./vf1-checks.cjs');

const NOW = 'fx-now=2026-10-28T12:00:00Z';
const LIBRARY = ['src/library/home.js', 'src/library/jobs.js', 'src/library/review-chip.js'];
const ONBOARDING = ['src/onboarding/signin.js', 'src/onboarding/welcome.js'];
const DOWNLOAD = ['src/download/download.js'];
const PLACEHOLDER_OK = {placeholder: true};

const ROUTES = {
  library: {url: `/?fx-reset=1&${NOW}`, ready: 'library', requires: LIBRARY},
  signin: {url: `/?fx-auth=signedout&fx-reset=1&${NOW}`, ready: false, wait: 'html[data-startup=signin]', requires: ONBOARDING},
  welcome: {url: `/?fx-account=new&fx-reset=1&${NOW}`, ready: 'welcome', requires: ONBOARDING},
  download: {url: `/download?fx-reset=1&${NOW}`, ready: 'download', requires: DOWNLOAD},
};

// Spec sizes per route (§2.1–2.4, §8.1–8.2): [fine, coarse] where they differ.
const fc = (coarse, fine, touch) => (coarse ? touch : fine);
const READOUTS = {
  library: coarse => [
    {name: 'top bar', selector: '.app-topbar', box: {h: fc(coarse, 56, 60)}},
    {name: 'wordmark', selector: '.shell-wordmark', font: {size: 18, weight: 800}},
    {name: 'search', selector: '.shell-search-input', box: {h: fc(coarse, 40, 48), maxW: 520}},
    {name: 'Add song', selector: '.shell-add', box: {h: fc(coarse, 40, 48)}},
    {name: 'avatar', selector: '.shell-avatar', box: {w: fc(coarse, 36, 44), h: fc(coarse, 36, 44)}},
    {name: 'hero cover', selector: '.lib-hero-cover', box: {w: fc(coarse, 160, 128), h: fc(coarse, 160, 128)}},
    {name: 'hero title', selector: '.lib-hero-title', font: {size: 28, weight: 700}},
    {name: 'hero artist', selector: '.lib-hero-artist', font: {size: 16}},
    {name: 'hero state line', selector: '.lib-hero-state', font: {size: 16}},
    {name: 'Resume', selector: '.lib-hero-resume', box: {h: fc(coarse, 48, 56)}},
    {name: 'compact cover', selector: '.lib-recent .lib-compact-cover', all: true, box: {w: 64, h: 64}},
    {name: 'Library heading', selector: '.lib-library-title', font: {size: 20, weight: 700}},
    {name: 'card title', selector: '.lib-grid .lib-card-title', all: true, font: {size: 16, weight: 600}},
    {name: 'card meta', selector: '.lib-grid .lib-meta', all: true, font: {size: fc(coarse, 13, 14)}},
  ],
  signin: () => [
    {name: 'Continue with Google', selector: '.onb-signin button, [class*=signin] button', box: {minH: 40}},
  ],
  welcome: coarse => [
    {name: 'welcome heading', selector: 'h1', font: {minSize: 20}},
    {name: 'instrument chips', selector: '[role=group] button, [role=radiogroup] [role=radio]', all: true, box: {minH: fc(coarse, 32, 44)}, optional: true},
  ],
  download: () => [
    {name: 'download heading', selector: 'h1', font: {minSize: 20}},
  ],
};

/** Runs in the page: every [data-scroller] position needed to see the whole place. */
function scrollStops() {
  const s = document.querySelector('[data-scroller]') ?? document.scrollingElement;
  const stops = [];
  for (let top = 0; top < s.scrollHeight - 1; top += Math.max(200, s.clientHeight - 80)) stops.push(top);
  return stops.slice(0, 6);
}

async function waitRoute(page, route) {
  if (route.wait) await page.waitForSelector(route.wait, {state: 'attached', timeout: 30_000});
  // Fonts and entrance animations settle before anything is measured.
  await settle(page);
}

function routeStates(key) {
  const route = ROUTES[key];
  const base = {requires: route.requires, ready: route.ready};
  return [
    {
      name: `vf1-probe-${key}`, url: route.url,
      opts: {...base, capture: false},
      async fn(page, t) {
        await waitRoute(page, route);
        const coarse = t.device === 'ipad';
        const problems = [
          ...await checkTargets(page),
          ...await checkReadouts(page, READOUTS[key](coarse)),
          ...typeProblems(await page.evaluate(textFacts, CONTROL), {coarse: t.device === 'ipad'}),
        ];
        // Visual review: every scroll position of the place.
        const stops = await page.evaluate(scrollStops);
        for (const [i, top] of stops.entries()) {
          await page.evaluate(y => { const s = document.querySelector('[data-scroller]') ?? document.scrollingElement; s.scrollTop = y; }, top);
          problems.push(...await checkTargets(page));
          await t.capture(i ? `at${i}` : '');
        }
        t.expect(!problems.length, [...new Set(problems)].join('; '));
      },
    },
    {
      name: `vf1-axe-${key}`, url: route.url,
      opts: {...base, capture: false, reducedMotion: 'reduce'},
      async fn(page, t) {
        await waitRoute(page, route);
        const problems = await checkAxe(page);
        t.expect(!problems.length, problems.join('; '));
      },
    },
    {
      name: `vf1-focus-${key}`, url: route.url,
      opts: {...base, devices: ['laptop'], capture: false},
      async fn(page, t) {
        await waitRoute(page, route);
        const problems = await walkFocus(page, {stops: 80});
        t.expect(!problems.length, problems.join('; '));
      },
    },
  ];
}

/** Opens the Jobs popover from the top bar chip. */
async function openJobs(page) {
  await page.locator('.lib-jobs-chip').click();
  await page.waitForSelector('[popover]:popover-open, [data-layer-fallback]', {state: 'visible'});
  await settle(page);
}

/** Fonts loaded and every running animation (an overlay's entrance) finished: measure the resting layout. */
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming?.().iterations !== Infinity).map(a => a.finished.catch(() => {})));
  });
}

/** Runs in the page: the art veil over a card's cover, and the page colour behind the card. */
function veilFacts(key) {
  const card = document.querySelector(`[data-key="${key}"]`);
  const cover = card?.querySelector('.lib-card-cover');
  if (!cover) return null;
  let opacity = 1;
  for (let n = cover; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
  let behind = null;
  for (let n = card; n && !behind; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor;
    if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) behind = bg;
  }
  const r = cover.getBoundingClientRect();
  return {state: card.dataset.state, opacity, behind: behind ?? getComputedStyle(document.body).backgroundColor, rect: {x: r.x, y: r.y, w: r.width, h: r.height}};
}

module.exports = [
  ...Object.keys(ROUTES).flatMap(routeStates),

  // ------------------------------------------------------------------ overlays over the Library
  {
    name: 'vf1-jobs-popover',
    url: ROUTES.library.url,
    opts: {requires: LIBRARY, ready: 'library', capture: false},
    async fn(page, t) {
      await openJobs(page);
      await t.capture();
      const problems = [
        ...await checkTargets(page),
        ...typeProblems(await page.evaluate(textFacts, CONTROL), {coarse: t.device === 'ipad'}),
        ...await checkAxe(page, {include: ['[popover]:popover-open']}),
      ];
      const rows = await page.evaluate(() => {
        const pop = document.querySelector('[popover]:popover-open');
        const list = pop?.querySelector('[data-scroller], ul, ol');
        return {count: pop?.querySelectorAll('.lib-job').length ?? 0, scrolls: !!list && list.scrollHeight > list.clientHeight + 1,
          fits: pop ? pop.getBoundingClientRect().bottom <= innerHeight + 1 && pop.getBoundingClientRect().right <= innerWidth + 1 : false};
      });
      t.expect(rows.count >= 9, `the popover lists every job (${rows.count})`);
      t.expect(rows.fits, 'the popover fits the viewport');
      if (t.device === 'laptop') {
        const focus = await walkFocus(page, {stops: 40});
        problems.push(...focus);
      }
      t.expect(!problems.length, problems.join('; '));
    },
  },
  {
    name: 'vf1-avatar-menu',
    url: ROUTES.library.url,
    opts: {requires: LIBRARY, ready: 'library', capture: false},
    async fn(page, t) {
      await page.locator('.shell-avatar').click();
      await page.waitForSelector('[role=menu]', {state: 'visible'});
      await settle(page);
      await t.capture();
      const problems = [...await checkTargets(page), ...await checkAxe(page, {include: ['[role=menu]']})];
      t.expect(!problems.length, problems.join('; '));
    },
  },

  {
    name: 'vf1-review-popover',
    url: ROUTES.library.url,
    opts: {requires: LIBRARY, ready: 'library', capture: false},
    async fn(page, t) {
      const chip = page.getByRole('button', {name: /Is this right\?/}).first();
      await chip.scrollIntoViewIfNeeded();
      await chip.click();
      await page.waitForSelector('[popover]:popover-open, [data-layer-fallback]', {state: 'visible'});
      await settle(page);
      await t.capture();
      const problems = [...await checkTargets(page), ...await checkAxe(page, {include: ['[popover]:popover-open']}),
        ...typeProblems(await page.evaluate(textFacts, CONTROL), {coarse: t.device === 'ipad'})];
      t.expect(!problems.length, problems.join('; '));
    },
  },

  // ------------------------------------------------------------------ the shell's other screens and banners (S1)
  ...[
    {key: 'fatal', url: `/?fx-auth=fail&fx-reset=1&${NOW}`, wait: '.shell-fatal'},
    {key: 'paused', url: `/?fx-auth=suspended&fx-reset=1&${NOW}`, wait: '.shell-paused'},
    {key: 'export-only', url: `/?fx-auth=export_only&fx-reset=1&${NOW}`, wait: '[data-banner=export-only]', axe: ['[data-banner=export-only]']},
    {key: 'offline', url: ROUTES.library.url, wait: '[data-view-ready=library]', offline: true, axe: ['[data-banner=offline]']},
  ].map(screen => ({
    name: `vf1-shell-${screen.key}`, url: screen.url,
    opts: {requires: LIBRARY, ready: false, capture: false, structure: PLACEHOLDER_OK},
    async fn(page, t) {
      await page.waitForSelector(screen.wait, {state: 'attached', timeout: 30_000});
      if (screen.offline) {
        await page.evaluate(() => dispatchEvent(new Event('offline')));
        await page.waitForSelector('[data-banner=offline]', {state: 'visible'});
      }
      await settle(page);
      await t.capture();
      // Over the Library only the banner is the shell's (vf1-axe-library covers the rest).
      const problems = [...await checkTargets(page), ...await checkAxe(page, {include: screen.axe ?? []}),
        ...typeProblems(await page.evaluate(textFacts, CONTROL), {coarse: t.device === 'ipad'})];
      if (t.device === 'laptop') problems.push(...await walkFocus(page, {stops: 40}));
      t.expect(!problems.length, problems.join('; '));
    },
  })),

  {
    name: 'vf1-app-palette',
    url: ROUTES.library.url,
    opts: {requires: LIBRARY, ready: 'library', capture: false},
    async fn(page, t) {
      // Opened from the keyboard as a user does (⌘K on the iPad's keyboard, Ctrl+K elsewhere).
      await page.keyboard.press(t.device === 'ipad' ? 'Meta+KeyK' : 'Control+KeyK');
      const input = page.getByRole('combobox').or(page.locator('[role=dialog] input'));
      await input.first().waitFor({state: 'visible'});
      await page.keyboard.type('glass');
      await page.getByRole('option').first().waitFor({state: 'visible'});
      await settle(page);
      await t.capture();
      const problems = [...await checkTargets(page), ...await checkAxe(page, {include: ['dialog[open], [role=dialog]']}),
        ...typeProblems(await page.evaluate(textFacts, CONTROL), {coarse: t.device === 'ipad'})];
      t.expect(!problems.length, problems.join('; '));
    },
  },
  {
    name: 'vf1-app-shortcuts',
    url: ROUTES.library.url,
    opts: {requires: LIBRARY, ready: 'library', capture: false},
    async fn(page, t) {
      await page.evaluate(() => window.__woodshed.commands.run('app.shortcuts'));
      await page.getByRole('dialog', {name: 'Keyboard shortcuts'}).waitFor({state: 'visible'});
      await settle(page);
      await t.capture();
      const problems = [...await checkTargets(page), ...await checkAxe(page, {include: ['dialog[open], [role=dialog]']})];
      t.expect(!problems.length, problems.join('; '));
    },
  },

  // ------------------------------------------------------------------ touch
  {
    name: 'vf1-touch-card-menu',
    url: '/__harness/home?part=cards',
    opts: {devices: ['ipad'], capture: false},
    async fn(page, t) {
      const touch = await t.touch();
      const songs = await page.evaluate(() => [...document.querySelectorAll('.lib-grid > .lib-card')].filter(c => c.dataset.key?.startsWith('song:')).map(c => c.dataset.key));
      t.expect(songs.length >= 4, `song cards in the harness (${songs})`);
      for (const key of songs) {
        const before = await page.evaluate(() => window.__cards.menu.length);
        const opened = await longPressOpens(page, page.locator(`[data-key="${key}"] .lib-card-cover`), {ms: 500, touch});
        t.expect(opened.ok, `a 500 ms long-press on ${key} opens its menu`);
        const calls = await page.evaluate(n => window.__cards.menu.slice(n), before);
        t.expect(calls.length === 1 && `song:${calls[0].id}` === key, `onMenu once for ${key} (${JSON.stringify(calls)})`);
        t.expect((await page.evaluate(() => window.__cards.opened.length)) === 0, `the long-press on ${key} did not also open the song`);
        await page.keyboard.press('Escape');
        await page.waitForSelector('[role=menu]', {state: 'detached'});
      }
      const jobs = await page.evaluate(() => [...document.querySelectorAll('.lib-grid > .lib-card')].filter(c => c.dataset.key?.startsWith('job:')).map(c => c.dataset.key));
      t.expect(jobs.length >= 2, `job cards in the harness (${jobs})`);
      const counts = () => page.evaluate(() => ({menu: window.__cards.menu.length, jobs: window.__cards.jobs.length, opened: window.__cards.opened.length}));
      for (const key of jobs.slice(0, 2)) {
        const before = await counts();
        // A long-press on a job card is not a song gesture: no menu appears within the probe's
        // window (longPressOpens waits withinMs after release), no onMenu, no onOpen.
        const menu = await longPressOpens(page, page.locator(`[data-key="${key}"] .lib-card-cover`), {ms: 550, touch});
        t.expect(!menu.ok, `a job card (${key}) opens no song menu`);
        const after = await counts();
        t.expect(after.menu === before.menu && after.opened === before.opened, `a long-press on ${key} asks for no song menu and opens no song (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
        // A job card defines no long-press (spec §7.6 gives the card menu to song cards), so its
        // button activates on release as any button does; logged, not judged.
        t.log(`${key}: onJob ${after.jobs - before.jobs}× after the long-press`);
      }
      const short = await shortPressDoesNotOpen(page, page.locator(`[data-key="${songs[1]}"] .lib-card-cover`), {ms: 500, touch});
      t.expect(short.ok, 'a shorter press opens no menu');
      const tapped = await page.evaluate(() => window.__cards.opened);
      t.expect(tapped.length === 1 && `song:${tapped[0]}` === songs[1], `a short press is a tap that opens the song (${tapped})`);
    },
  },
  {
    name: 'vf1-touch-card-menu-list',
    url: '/__harness/home?part=cards&layout=list',
    opts: {devices: ['ipad'], capture: false},
    async fn(page, t) {
      const touch = await t.touch();
      const rows = await page.evaluate(() => [...document.querySelectorAll('.lib-row')].filter(r => r.dataset.key?.startsWith('song:')).map(r => r.dataset.key));
      t.expect(rows.length >= 4, `song rows in the harness (${rows})`);
      for (const key of rows) {
        const before = await page.evaluate(() => window.__cards.menu.length);
        const opened = await longPressOpens(page, page.locator(`[data-key="${key}"] .lib-thumb`), {ms: 500, touch});
        t.expect(opened.ok, `a 500 ms long-press on the row ${key} opens its menu`);
        const calls = await page.evaluate(n => window.__cards.menu.slice(n), before);
        t.expect(calls.length === 1 && `song:${calls[0].id}` === key, `onMenu once for the row ${key} (${JSON.stringify(calls)})`);
        await page.keyboard.press('Escape');
        await page.waitForSelector('[role=menu]', {state: 'detached'});
      }
    },
  },
  {
    name: 'vf1-touch-app-card',
    url: ROUTES.library.url,
    opts: {requires: LIBRARY, ready: 'library', devices: ['ipad'], structure: PLACEHOLDER_OK, capture: false},
    async fn(page, t) {
      // Until LB3's card menu exists the app passes no onMenu, so a long-press is the platform's own
      // link gesture (the harness states above cover long-press → onMenu); a tap opens the song.
      const touch = await t.touch();
      const cover = page.locator('[data-key="song:glasshouse"] .lib-card-cover');
      await cover.scrollIntoViewIfNeeded();
      await touch.tap(cover);
      await t.ready('stage');
      t.expect((await page.evaluate(() => location.pathname)) === '/s/glasshouse', 'a tap opens the song');
    },
  },

  // ------------------------------------------------------------------ Back refocuses the card
  {
    name: 'vf1-flow-back-mouse',
    url: ROUTES.library.url,
    opts: {requires: LIBRARY, ready: 'library', devices: ['laptop'], structure: PLACEHOLDER_OK, capture: false},
    async fn(page, t) {
      await page.locator('[data-key="song:glasshouse"] .lib-open-cover').click();
      await t.ready('stage');
      await page.goBack();
      await t.ready('library');
      const focus = await page.waitForFunction(() => {
        const a = document.activeElement;
        return a && a !== document.body ? {inCard: !!a.closest('[data-key="song:glasshouse"]'), key: a.dataset.focusKey ?? null, visible: a.checkVisibility()} : null;
      }, null, {timeout: 5000}).then(h => h.jsonValue(), () => null);
      t.expect(focus?.inCard && focus.visible, `Back refocuses Glasshouse's card (${JSON.stringify(focus)})`);
      const inView = await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
      t.expect(inView, 'the refocused card is in view');
    },
  },
  {
    name: 'vf1-flow-back-keys',
    url: ROUTES.library.url,
    opts: {requires: LIBRARY, ready: 'library', devices: ['laptop'], structure: PLACEHOLDER_OK},
    async fn(page, t) {
      // Put keyboard focus on Night Bus's card: focus it, step out and back in with the keyboard so the
      // ring is :focus-visible as after real keyboard navigation.
      await page.locator('[data-key="song:nightbus"] .lib-open-cover').focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const start = await page.evaluate(() => ({key: document.activeElement?.dataset.focusKey, visible: document.activeElement?.matches(':focus-visible')}));
      t.expect(start.key === 'song:nightbus' && start.visible, `Night Bus focused from the keyboard (${JSON.stringify(start)})`);
      await page.keyboard.press('Enter');
      await t.ready('stage');
      t.expect((await page.evaluate(() => location.pathname)) === '/s/nightbus', 'Enter opens the focused song');
      await page.goBack();   // the browser's Back (Alt+← is browser chrome, not page input)
      await t.ready('library');
      const back = await page.waitForFunction(() => document.activeElement?.dataset?.focusKey === 'song:nightbus'
        ? {visible: document.activeElement.matches(':focus-visible')} : null, null, {timeout: 5000}).then(h => h.jsonValue(), () => null);
      t.expect(!!back, 'Back refocuses Night Bus');
      t.expect(back?.visible, 'the refocused card shows its focus ring after a keyboard round trip');
    },
  },
  {
    name: 'vf1-flow-back-tap',
    url: ROUTES.library.url,
    opts: {requires: LIBRARY, ready: 'library', devices: ['ipad'], structure: PLACEHOLDER_OK, capture: false},
    async fn(page, t) {
      const open = page.locator('[data-key="song:secondwind"] .lib-open-cover');
      await open.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => document.querySelector('[data-scroller]')?.scrollTop ?? 0);
      await (await t.touch()).tap(open);
      await t.ready('stage');
      await page.goBack();
      await t.ready('library');
      const key = await page.waitForFunction(() => document.activeElement?.closest?.('[data-key]')?.dataset.key ?? null, null, {timeout: 5000})
        .then(h => h.jsonValue(), () => null);
      t.expect(key === 'song:secondwind', `Back after a tap refocuses the card (${key})`);
      const after = await page.evaluate(() => document.querySelector('[data-scroller]')?.scrollTop ?? 0);
      t.expect(Math.abs(after - before) <= 2, `Back restores the Library's scroll position (${before} → ${after})`);
    },
  },

  {
    name: 'vf1-flow-back-link',
    url: ROUTES.library.url,
    opts: {requires: [...LIBRARY, 'src/stage/hud.js'], ready: 'library', devices: ['laptop'], structure: PLACEHOLDER_OK, capture: false},
    async fn(page, t) {
      // The Stage's own visible Back control, not the browser's: the HUD's ‹ (a HoldButton, so role
      // button; stopped, a plain click runs stage.leave). It is a Back too, so it returns through
      // history and refocuses the card as page.goBack() does.
      await page.locator('[data-key="song:glasshouse"] .lib-open-cover').click();
      await t.ready('stage');
      const idx = await page.evaluate(() => history.state?.idx ?? null);
      const back = page.getByRole('button', {name: 'Back to Library', exact: true});
      t.expect((await back.count()) === 1, `the Stage shows exactly one ‹ "Back to Library" button (${await back.count()})`);
      await back.click();
      await t.ready('library');
      const focus = await page.waitForFunction(() => {
        const a = document.activeElement;
        return a && a !== document.body ? {inCard: !!a.closest('[data-key="song:glasshouse"]'), visible: a.checkVisibility()} : null;
      }, null, {timeout: 5000}).then(h => h.jsonValue(), () => null);
      const after = await page.evaluate(() => ({idx: history.state?.idx ?? null, active: document.activeElement?.tagName}));
      t.expect(focus?.inCard && focus.visible, `"Back to Library" refocuses Glasshouse's card (${JSON.stringify(focus ?? after)})`);
      t.expect(idx != null && after.idx === idx - 1, `"Back to Library" goes back in history, not forward (idx ${idx} → ${after.idx})`);
    },
  },

  // ------------------------------------------------------------------ the intended route survives sign-in
  {
    name: 'vf1-flow-intended-web',
    url: `/settings/plan?fx-auth=signedout&fx-reset=1&${NOW}`,
    opts: {requires: ONBOARDING, ready: false, devices: ['laptop'], themes: ['light'], structure: PLACEHOLDER_OK, capture: false},
    async fn(page, t) {
      await page.waitForSelector('html[data-startup=signin]');
      // Drop the switches from the address bar (as a real visitor's URL), keeping them for the tab.
      await page.evaluate(() => history.replaceState(history.state, '', '/settings/plan?from=mail'));
      await page.reload();
      await page.waitForSelector('html[data-startup=signin]');
      const at = await page.evaluate(() => location.pathname + location.search);
      t.expect(at === '/settings/plan?from=mail', `the sign-in screen keeps the intended route in the address bar (${at}), the web OAuth return URL`);
      // The provider returns to that URL signed in.
      await page.evaluate(() => sessionStorage.setItem('fx-switches', JSON.stringify({now: '2026-10-28T12:00:00Z'})));
      await page.reload();
      await t.ready('settingsPage');
      const after = await page.evaluate(() => location.pathname + location.search);
      t.expect(after.startsWith('/settings/plan') && after.includes('from=mail'), `signed in at the intended route (${after})`);
    },
  },
  {
    name: 'vf1-flow-intended-desktop',
    url: `/s/glasshouse?bar=9&fx-auth=signedout&fx-desktop=1&fx-reset=1&${NOW}`,
    opts: {requires: ONBOARDING, ready: false, devices: ['laptop'], themes: ['dark'], structure: PLACEHOLDER_OK, capture: false},
    async fn(page, t) {
      await page.waitForSelector('html[data-startup=signin]');
      await page.evaluate(() => history.replaceState(history.state, '', '/s/glasshouse?bar=9'));
      await page.reload();
      await page.waitForSelector('html[data-startup=signin]');
      await page.getByRole('button', {name: 'Continue with Google'}).click();
      // The fixture's OAuth cannot start (an alert), but the route was stashed first.
      await page.getByRole('alert').waitFor();
      const stashed = await page.evaluate(() => sessionStorage.getItem('ws.intendedRoute'));
      t.expect(stashed === '/s/glasshouse?bar=9', `the desktop sign-in stashes the route (${stashed})`);
      // Electron's OAuth return reloads the app at / signed in.
      await page.evaluate(() => sessionStorage.setItem('fx-switches', JSON.stringify({desktop: '1', now: '2026-10-28T12:00:00Z'})));
      await page.goto(`${t.base}/`);
      await t.ready('stage');
      const at = await page.evaluate(() => location.pathname + location.search);
      t.expect(at === '/s/glasshouse?bar=9', `back at the intended route after sign-in (${at})`);
      t.expect((await page.evaluate(() => sessionStorage.getItem('ws.intendedRoute'))) === null, 'the stash is used once');
    },
  },

  // ------------------------------------------------------------------ prefs across two tabs
  {
    name: 'vf1-flow-prefs-tabs',
    url: ROUTES.library.url,
    opts: {requires: LIBRARY, ready: 'library', devices: ['laptop'], capture: false},
    async fn(page, t) {
      // Every expectation is checked, and all failures are reported together.
      const issues = [];
      const check = (condition, message) => { if (!condition) issues.push(message); };
      const other = await page.context().newPage();
      const errors = [];
      other.on('pageerror', e => errors.push(e.message));
      other.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await other.goto(`${t.base}/`);
      await other.waitForSelector('html[data-view-ready=library]', {state: 'attached'});
      const layoutOf = p => p.evaluate(() => (document.querySelector('.lib-list') ? 'list' : document.querySelector('.lib-grid') ? 'grid' : null));
      const sortOf = p => p.evaluate(() => [...document.querySelectorAll('button')].find(b => /^Sort/.test(b.textContent.trim()))?.textContent.trim() ?? null);
      const libraryPrefs = p => p.evaluate(() => {
        const v = window.__woodshed.store.prefs;
        const value = typeof v?.peek === 'function' ? v.peek() : v?.value;
        return {layout: value?.library?.layout, sort: value?.library?.sort};
      });
      check((await layoutOf(other)) === 'grid', 'the second tab starts on the grid');
      // Change layout and sort in the first tab through the Library's own controls.
      await page.getByRole('radio', {name: 'List'}).click();
      await page.getByRole('button', {name: /^Sort/}).click();
      await page.getByRole('menuitemradio', {name: 'Title'}).click();
      await page.waitForFunction(() => !!document.querySelector('.lib-list'));
      // The URL mirrors the view state (replace, debounced 400 ms; spec §2.3, Appendix C item 79).
      await page.waitForFunction(() => /[?&]sort=title/.test(location.search), null, {timeout: 3000}).catch(() => {});
      const url = await page.evaluate(() => location.search);
      check(/[?&]sort=title/.test(url), `the first tab mirrors the sort in its URL (${url})`);
      check(/[?&]layout=list/.test(url), `the first tab mirrors the layout in its URL (${url})`);
      // The second tab's prefs follow through the storage event, without a reload.
      const synced = await other.waitForFunction(() => {
        const v = window.__woodshed.store.prefs;
        const value = typeof v?.peek === 'function' ? v.peek() : v?.value;
        return value?.library?.layout === 'list' && value?.library?.sort === 'title';
      }, null, {timeout: 5000}).then(() => true, () => false);
      check(synced, `the second tab's prefs follow (${JSON.stringify(await libraryPrefs(other))})`);
      // A change in the second tab reaches the first.
      await other.evaluate(() => localStorage.setItem('ws.prefs', JSON.stringify({...JSON.parse(localStorage.getItem('ws.prefs')), library: {...JSON.parse(localStorage.getItem('ws.prefs')).library, group: 'artist'}})));
      const back = await page.waitForFunction(() => {
        const v = window.__woodshed.store.prefs;
        const value = typeof v?.peek === 'function' ? v.peek() : v?.value;
        return value?.library?.group === 'artist';
      }, null, {timeout: 5000}).then(() => true, () => false);
      check(back, 'the first tab follows a change written by the second');
      // A fresh Library in the second tab opens with the synced view (no view state in its URL).
      await other.goto(`${t.base}/`);
      await other.waitForSelector('html[data-view-ready=library]', {state: 'attached'});
      check((await layoutOf(other)) === 'list' && /Title/.test(await sortOf(other) ?? ''), `the synced prefs drive the next Library (${await layoutOf(other)}, ${await sortOf(other)})`);
      await other.close();
      check(!errors.length, `the second tab logged no error (${errors.join('; ')})`);
      t.expect(!issues.length, issues.join('; '));
    },
  },

  // ------------------------------------------------------------------ spec checks (orchestrator observations)
  {
    name: 'vf1-spec-cover-veil',
    url: ROUTES.library.url,
    opts: {requires: LIBRARY, ready: 'library', capture: false},
    async fn(page, t) {
      const keys = await page.evaluate(() => [...document.querySelectorAll('.lib-grid > .lib-card')]
        .filter(c => c.dataset.state === 'processing' || c.dataset.state === 'resplitting').map(c => c.dataset.key));
      t.expect(keys.some(k => k.startsWith('job:')) && keys.some(k => k.startsWith('song:')), `processing and re-splitting cards in the seed (${keys})`);
      const measured = [];
      for (const key of keys) {
        await page.locator(`[data-key="${key}"] .lib-card-cover`).scrollIntoViewIfNeeded();
        const facts = await page.evaluate(veilFacts, key);
        if (!facts) { measured.push({key, missing: true}); continue; }
        const inset = 8, rail = 8;
        const clip = {x: facts.rect.x + inset, y: facts.rect.y + inset, width: facts.rect.w - 2 * inset, height: facts.rect.h - 2 * inset - rail};
        const shown = decodePng(await page.screenshot({clip, animations: 'disabled'}));
        await page.addStyleTag({content: `[data-key="${key}"] .lib-card-cover::after, [data-key="${key}"] .lib-card-cover::before { display: none !important; } [data-key="${key}"] .lib-card-cover { opacity: 1 !important; }`});
        const art = decodePng(await page.screenshot({clip, animations: 'disabled'}));
        // null when the art is too close to the page colour to measure; veilProblems() needs at
        // least one measured processing and one measured re-splitting card.
        measured.push({key, state: facts.state, alpha: fitAlpha(shown, art, parseRgb(facts.behind))});
      }
      t.log(measured.map(m => `${m.key} ${m.missing ? 'no cover' : `${m.state} ${m.alpha == null ? 'n/a' : m.alpha.toFixed(2)}`}`).join(', '));
      const problems = veilProblems(measured);
      t.expect(!problems.length, problems.join('; '));
    },
  },
  {
    name: 'vf1-spec-recents-line',
    url: ROUTES.library.url,
    opts: {requires: LIBRARY, ready: 'library', capture: false},
    async fn(page, t) {
      const recents = await page.evaluate(() => [...document.querySelectorAll('.lib-recent')].map(r => {
        const title = r.querySelector('.lib-compact-title')?.textContent ?? r.dataset.key ?? '?';
        const line = r.querySelector('.lib-compact-line');
        if (!line) return {title, missing: true};
        const cs = getComputedStyle(line);
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
        return {title, text: line.textContent, lines: Math.round(line.getBoundingClientRect().height / lh), size: parseFloat(cs.fontSize)};
      }));
      t.expect(recents.length >= 1, 'the seed has a compact recent');
      const problems = recentsProblems(recents);
      t.expect(!problems.length, problems.join('; '));
    },
  },
];
