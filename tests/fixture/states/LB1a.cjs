// LB1a's states: Library home, cards and Continue (architecture §10.3 "LB1a" captures, §11.4).
//
// The app on the fixture database (`/`), with LB1b's jobs.js and review-chip.js (same-wave peers, §9.0, listed
// in opts.requires: skipped until they merge, run with --strict-requires at I1b):
//   lb1a-home                    Continue (hero, recents), Setlists, Pinned, the grid: geometry, targets, focus
//   lb1a-home-adding             the "Adding" group and every processing state, re-splitting, working, failed
//   lb1a-home-list               the list view: a table, 56/64 px rows, iPad drops Album and BPM
//   lb1a-home-group-album        grouped by album (sticky 40 px headers, Unknown album last)
//   lb1a-home-group-artist       grouped by artist
//   lb1a-home-filters            each filter chip in turn (captured), the conditional Processing/Failed chips
//   lb1a-home-drilldown          an artist drill-down chip, removed again
//   lb1a-home-no-results-desktop / -web-online / -web-offline    [Add "q" as a new song →] only with a way to add
//   lb1a-home-empty-filter       an empty filter with [Show all]
//   lb1a-home-loading            the 8-card skeleton in the grid geometry
//   lb1a-home-still-connecting   "Still connecting… [Retry]" after 8 s
//   lb1a-home-first-run-web / -desktop     the Demo and Add cards
//   lb1a-home-search-enter       / then type then Enter opens the top result; Back refocuses the opened card
//   lb1a-home-keys               roving arrows, Home/End, E → Edit · Details
// The harness (/__harness/home):
//   lb1a-cards / lb1a-cards-list every card state side by side (no peers); long-press → onMenu (touch)
//   lb1a-home-flip               a finished job's card FLIPs (260 ms) to its sorted place; none under reduced motion
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');
const {longPressOpens, shortPressDoesNotOpen} = require('../probes/probe-touch.cjs');

const PEERS = ['src/library/jobs.js', 'src/library/review-chip.js'];
const NOW = 'fx-now=2026-10-28T12:00:00Z';
const app = (query = '') => `/?fx-reset=1&${NOW}${query ? `&${query}` : ''}`;
const APP = {requires: PEERS, ready: 'library'};
// Routes of later packages (the Stage, the Add sheet) still render the placeholder in wave 1.
const PLACEHOLDER_OK = {placeholder: true};
const prefs = obj => `fx-prefs=${encodeURIComponent(JSON.stringify(obj))}`;

async function expectTargets(t, page) {
  const targets = await checkTargets(page);
  t.expect(!targets.length, `targets: ${JSON.stringify(targets.slice(0, 6))}`);
}

/** Runs in the page: the scroller to the top of a selector. */
function scrollTo(selector) {
  const el = document.querySelector(selector);
  const scroller = document.querySelector('[data-scroller]');
  if (el && scroller) scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
}

/** Runs in the page: grid columns (distinct left edges of the first row of cards) and cover geometry. */
function gridFacts() {
  const cards = [...document.querySelectorAll('.lib-grid > .lib-card')];
  const top = cards.length ? Math.round(cards[0].getBoundingClientRect().top) : 0;
  const firstRow = cards.filter(c => Math.abs(Math.round(c.getBoundingClientRect().top) - top) <= 1);
  const covers = cards.slice(0, 6).map(c => c.querySelector('.lib-card-cover').getBoundingClientRect());
  const cs = cards[0] ? getComputedStyle(cards[0].querySelector('.lib-card-cover')) : null;
  return {
    columns: firstRow.length, width: covers[0] ? Math.round(covers[0].width) : 0,
    square: covers.every(r => Math.abs(r.width - r.height) <= 1), radius: cs?.borderTopLeftRadius,
    contentVisibility: cards[0] ? getComputedStyle(cards[0]).contentVisibility : null,
    // Paint containment between the cover link and the grid would clip its 3 px focus ring (spec §8.4).
    clipsRing: (() => {
      const link = cards[0]?.querySelector('.lib-open-cover');
      for (let n = link?.parentElement; n && !n.classList.contains('lib-grid'); n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.contentVisibility === 'auto' || cs.contentVisibility === 'hidden' || /paint|content|strict/.test(cs.contain)) return n.className;
      }
      return null;
    })(),
    more: document.querySelectorAll('.lib-grid .lib-more').length,
  };
}

/** Runs in the page: Continue's geometry. */
function continueFacts() {
  const box = sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; };
  const title = document.querySelector('.lib-hero-title');
  return {
    hero: box('.lib-hero'), cover: box('.lib-hero-cover'), resume: box('.lib-hero-resume'), recent: box('.lib-recent'),
    titleSize: title ? getComputedStyle(title).fontSize : null, titleWeight: title ? getComputedStyle(title).fontWeight : null,
    state: document.querySelector('.lib-hero-state')?.textContent ?? null,
    spots: [...document.querySelectorAll('.lib-spot-chip')].map(a => a.getAttribute('href')),
    setlists: [...document.querySelectorAll('.lib-set-card')].map(a => a.getAttribute('href')),
    pins: [...document.querySelectorAll('.lib-pinned .lib-compact-title')].map(n => n.textContent),
  };
}

const visibleText = sel => document.querySelector(sel)?.checkVisibility() ? document.querySelector(sel).textContent : null;

module.exports = [
  // ------------------------------------------------------------------ the app
  {
    name: 'lb1a-home',
    url: app(),
    opts: APP,
    async fn(page, t) {
      const coarse = t.device === 'ipad';
      const c = await page.evaluate(continueFacts);
      t.expect(c.state === 'Chorus loop · 90% · Drums out · practised yesterday', `the hero's state line (${c.state})`);
      t.expect(c.cover.w === (coarse ? 128 : 160), `hero cover ${c.cover.w} px (160 laptop, 128 iPad)`);
      t.expect(c.resume.h === (coarse ? 56 : 48), `Resume ${c.resume.h} px (48, 56 coarse)`);
      t.expect(c.titleSize === '28px' && c.titleWeight === '700', `hero title ${c.titleSize}/${c.titleWeight}`);
      t.expect(coarse ? c.recent.y > c.hero.y + c.hero.h - 1 : c.recent.x > c.hero.x + c.hero.w - 1,
        `recents sit ${coarse ? 'under' : 'beside'} the hero ${JSON.stringify({hero: c.hero, recent: c.recent})}`);
      t.expect(JSON.stringify(c.spots) === JSON.stringify(['/s/lowtide?spot=sp-lt-1', '/s/lowtide?spot=sp-lt-2', '/s/lowtide?spot=sp-lt-3']), `spot chips ${c.spots}`);
      t.expect(JSON.stringify(c.setlists) === JSON.stringify(['/set/set-friday', '/set/set-warmup']), `the Setlists row ${c.setlists}`);
      t.expect(JSON.stringify(c.pins) === JSON.stringify(['Glasshouse', 'Low Tide Static', 'Night Bus']), `the Pinned row ${c.pins}`);
      await page.evaluate(scrollTo, '.lib-library');
      const g = await page.evaluate(gridFacts);
      t.expect(g.columns === (coarse ? 3 : 6), `${g.columns} columns (6 at 1440, 3 on iPad portrait)`);
      t.expect(g.square && g.radius === '0px', `covers are square with radius 0 (${g.radius})`);
      t.expect(g.contentVisibility !== 'auto' && !g.clipsRing, `nothing clips the cover link's focus ring (${g.contentVisibility}, ${g.clipsRing})`);
      t.expect(g.more === 0, 'no ⋯ until the card menu exists (LB3)');
      if (coarse) {
        // The 12.9" iPad Pro in portrait (1024 wide) is an iPad portrait too: 3 columns, not 5.
        const size = page.viewportSize();
        await page.setViewportSize({width: 1024, height: 1366});
        const pro = await page.evaluate(gridFacts);
        t.expect(pro.columns === 3, `${pro.columns} columns on a 1024 px iPad in portrait`);
        await page.setViewportSize(size);
      }
      await page.evaluate(() => { document.querySelector('[data-scroller]').scrollTop = 0; });
      await expectTargets(t, page);
      if (!coarse) {
        const focus = await walkFocus(page, {stops: 24});
        t.expect(!focus.length, focus.join('; '));
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.evaluate(() => { document.querySelector('[data-scroller]').scrollTop = 0; });
      }
    },
  },
  {
    name: 'lb1a-home-adding',
    url: app(),
    opts: APP,
    async fn(page, t) {
      await page.evaluate(scrollTo, '.lib-divider');
      const facts = await page.evaluate(() => {
        const states = {};
        for (const card of document.querySelectorAll('.lib-grid > .lib-card')) states[card.dataset.key] = card.dataset.state;
        const rail = document.querySelector('[data-key="job:job-run"] .lib-rail');
        const cover = document.querySelector('[data-key="job:job-run"] .lib-card-cover');
        const r = rail?.getBoundingClientRect(), c = cover?.getBoundingClientRect();
        const failed = document.querySelector('[data-key="job:job-fail"] .lib-meta');
        const resplit = document.querySelector('[data-key="song:counting"] .lib-card-title');
        const processingTitle = document.querySelector('[data-key="job:job-run"] .lib-card-title');
        const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
        return {
          states, divider: document.querySelector('.lib-divider')?.textContent,
          rail: r && c ? {h: Math.round(r.height), bottom: Math.round(r.bottom) === Math.round(c.bottom), w: Math.round(r.width) === Math.round(c.width)} : null,
          failedColor: failed ? getComputedStyle(failed).color : null, danger: getComputedStyle(document.documentElement).getPropertyValue('--danger').trim(),
          resplitColor: resplit ? getComputedStyle(resplit).color : null, processingColor: processingTitle ? getComputedStyle(processingTitle).color : null, ink,
          veil: cover ? getComputedStyle(cover, '::after').opacity : null,
          striped: !!document.querySelector('[data-key="job:job-q"] .lib-rail[data-striped]'),
          dividers: [...document.querySelectorAll('.lib-grid > .lib-divider')].map(n => n.textContent),
          quotedTitle: document.querySelector('[data-key="job:job-q"] .lib-title-text')?.textContent ?? null,
          runCover: document.querySelector('[data-key="job:job-run"] .lib-card-cover img')?.getAttribute('src') ?? null,
        };
      });
      t.expect(facts.divider === 'Adding', `the "Adding" divider (${facts.divider})`);
      t.expect(JSON.stringify(facts.dividers) === JSON.stringify(['Adding', 'Songs']), `a Songs divider closes the Adding group (${facts.dividers})`);
      t.expect(/^“.+”$/.test(facts.quotedTitle ?? ''), `a search job without a title shows its query in quotes (${facts.quotedTitle})`);
      t.expect(!!facts.runCover, 'a job whose art is an R2 coverKey shows it, signed');
      const s = facts.states;
      t.expect(s['job:job-run'] === 'processing' && s['job:job-q'] === 'processing', `new-song jobs are processing cards ${JSON.stringify(s)}`);
      t.expect(s['job:job-fail'] === 'failed' && s['job:job-bot'] === 'failed', 'failed jobs are failed cards');
      t.expect(s['song:counting'] === 'resplitting', `a re-split keeps its song card (${s['song:counting']})`);
      t.expect(s['song:quiet'] === 'working' && s['song:lanterns'] === 'working', 'beats and sections jobs mark their songs');
      t.expect(facts.rail && facts.rail.h === 4 && facts.rail.bottom && facts.rail.w, `a 4 px rail on the cover's bottom edge ${JSON.stringify(facts.rail)}`);
      t.expect(facts.striped, 'a waiting job has an empty striped rail');
      t.expect(facts.veil === '0.45', `the processing cover is at 55% (veil ${facts.veil})`);
      t.expect(facts.failedColor !== null && facts.failedColor !== facts.processingColor, `the failure sentence is in --danger (${facts.failedColor})`);
      t.expect(facts.resplitColor !== facts.processingColor, 'a re-splitting title stays at full contrast while a new song is quieter');
      await expectTargets(t, page);
      await page.locator('[data-key="song:counting"] a.lib-open').waitFor();
      t.expect(await page.locator('[data-key="song:counting"] a.lib-open').getAttribute('href') === '/s/counting', 'a re-splitting card still opens the song');
    },
  },
  {
    name: 'lb1a-home-list',
    url: app(prefs({library: {layout: 'list'}})),
    opts: APP,
    async fn(page, t) {
      const coarse = t.device === 'ipad';
      await page.evaluate(scrollTo, '.lib-library');
      const facts = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.lib-rows > .lib-row[data-key^="song:"]')];
        const album = document.querySelector('.lib-rows .lib-col-album');
        return {
          table: !!document.querySelector('[role=table]'), heads: [...document.querySelectorAll('.lib-colsort')].filter(b => b.checkVisibility()).map(b => b.textContent.replace(/[▲▼]/g, '')),
          heights: rows.slice(0, 5).map(r => Math.round(r.getBoundingClientRect().height)),
          albumShown: album ? album.checkVisibility() : null, cv: rows[0] ? getComputedStyle(rows[0]).contentVisibility : null,
          sorted: document.querySelector('[aria-sort=descending]')?.textContent ?? null,
          artists: rows.filter(r => r.querySelector('.lib-artist:not([hidden])')?.checkVisibility()).length,
          withArtist: rows.filter(r => r.querySelector('.lib-artist:not([hidden])')).length,
        };
      });
      t.expect(facts.table, 'the list is a table');
      t.expect(facts.heights.every(h => h >= (coarse ? 64 : 56)), `rows are ${coarse ? 64 : 56} px or taller (${facts.heights})`);
      t.expect(facts.albumShown === !coarse, `Album and BPM columns ${coarse ? 'dropped on iPad' : 'shown on laptop'}`);
      t.expect(JSON.stringify(facts.heads) === JSON.stringify(coarse ? ['Title', 'Key', 'Length', 'Practised'] : ['Title', 'Album', 'Key', 'BPM', 'Length', 'Practised']), `headers ${facts.heads}`);
      t.expect(facts.cv === 'auto', `rows use content-visibility: auto (${facts.cv})`);
      t.expect(facts.withArtist > 0 && facts.artists === facts.withArtist, `every row's artist drills down, coarse too (${facts.artists}/${facts.withArtist})`);
      t.expect(/Practised/.test(facts.sorted ?? ''), `Practised is the sorted column (${facts.sorted})`);
      await expectTargets(t, page);
      await page.getByRole('button', {name: 'Title', exact: true}).click();
      const first = await page.evaluate(() => document.querySelector('.lib-rows > .lib-row[data-key^="song:"]').dataset.key);
      t.expect(first === 'song:cobblestone', `Title ▲ sorts A→Z (${first})`);
      t.expect(/sort=title/.test(await page.evaluate(() => new Promise(r => setTimeout(() => r(location.search), 500)))), 'the sort is in the URL');
    },
  },
  {
    name: 'lb1a-home-group-album',
    url: app('group=album&fx-jobs=0'),
    opts: APP,
    async fn(page, t) {
      await page.evaluate(scrollTo, '.lib-library');
      const facts = await page.evaluate(() => ({
        labels: [...document.querySelectorAll('.lib-group .lib-group-label')].map(n => n.textContent),
        height: Math.round(document.querySelector('.lib-group .lib-group-heading').getBoundingClientRect().height),
        sticky: getComputedStyle(document.querySelector('.lib-group')).position,
        disc: Math.round(document.querySelector('.lib-group-disc').getBoundingClientRect().width),
      }));
      t.expect(facts.labels.at(-1) === 'Unknown album', `Unknown album is last (${facts.labels})`);
      t.expect(facts.labels.includes('Weather Systems'), 'albums are groups');
      t.expect(facts.height === 40 && facts.sticky === 'sticky' && facts.disc === 32, `sticky 40 px headers with a 32 px disc ${JSON.stringify(facts)}`);
      await expectTargets(t, page);
    },
  },
  {
    name: 'lb1a-home-group-artist',
    url: app('group=artist&fx-jobs=0'),
    opts: APP,
    async fn(page, t) {
      await page.evaluate(scrollTo, '.lib-library');
      const labels = await page.evaluate(() => [...document.querySelectorAll('.lib-group .lib-group-label')].map(n => n.textContent));
      t.expect(labels.at(-1) === 'Unknown artist' && labels.includes('Northbound'), `artist groups (${labels})`);
      t.expect(await page.evaluate(() => document.querySelector('.lib-group-menu').textContent.includes('Group: Artist')), 'Group ▾ names the grouping');
    },
  },
  {
    name: 'lb1a-home-filters',
    url: app(),
    opts: {...APP, themes: ['light']},
    async fn(page, t) {
      await page.evaluate(scrollTo, '.lib-library');
      const chips = await page.evaluate(() => [...document.querySelectorAll('.lib-filter-chips .ui-chip-label')].map(n => n.textContent));
      t.expect(chips.length === 6 && /^Processing \d+$/.test(chips[4]) && /^Failed \d+$/.test(chips[5]), `six chips with counts (${chips})`);
      const expected = {'Has chart': ['song:glasshouse'], 'Needs review': ['song:jam03', 'song:counting']};
      for (const label of chips) {
        await page.getByRole('button', {name: label, exact: true}).click();
        await page.waitForTimeout(150);
        const keys = await page.evaluate(() => [...document.querySelectorAll('.lib-grid > [data-key]')].map(n => n.dataset.key));
        t.expect(keys.length > 0, `${label} shows something`);
        if (expected[label]) t.expect(expected[label].every(k => keys.includes(k)) && keys.length === expected[label].length, `${label}: ${keys}`);
        const n = /\s(\d+)$/.exec(label)?.[1];
        if (n) t.expect(keys.length === Number(n), `${label} counts what it shows (${keys.length}: ${keys})`);
        t.expect(await page.getByRole('button', {name: label, exact: true}).getAttribute('aria-pressed') === 'true', `${label} is pressed`);
        await t.capture(`filter-${label.replace(/\s*\d+$/, '').toLowerCase().replace(/\s+/g, '-')}`);
        await page.getByRole('button', {name: label, exact: true}).click();
      }
      await page.waitForTimeout(500);
      t.expect(!/filter=/.test(await page.evaluate(() => location.search)), 'tapping a chip again clears the filter (URL)');
    },
  },
  {
    name: 'lb1a-home-drilldown',
    url: app('artist=Northbound&fx-jobs=0'),
    opts: APP,
    async fn(page, t) {
      await page.evaluate(scrollTo, '.lib-library');
      const keys = await page.evaluate(() => [...document.querySelectorAll('.lib-grid > [data-key]')].map(n => n.dataset.key));
      t.expect(JSON.stringify(keys.sort()) === JSON.stringify(['song:glasshouse', 'song:lowtide', 'song:quiet']), `Northbound's songs (${keys})`);
      t.expect(await page.getByRole('button', {name: 'Remove Artist: Northbound'}).isVisible(), 'the drill-down chip');
      await expectTargets(t, page);
      await t.capture('chip');
      await page.getByRole('button', {name: 'Remove Artist: Northbound'}).click();
      await page.waitForTimeout(150);
      t.expect(await page.evaluate(() => document.querySelectorAll('.lib-grid > [data-key^="song:"]').length) === 12, 'removing it shows every song');
      await page.locator('[data-key="song:velvet"] .lib-artist').click();
      t.expect(await page.getByRole('button', {name: 'Remove Artist: Marisol Vega'}).isVisible(), 'clicking an artist drills down');
    },
  },
  {
    name: 'lb1a-home-no-results-desktop',
    url: app('q=zzzz&fx-desktop=1'),
    opts: {...APP, structure: PLACEHOLDER_OK},
    async fn(page, t) {
      await page.evaluate(scrollTo, '.lib-library');
      t.expect((await page.locator('.lib-empty').textContent()).includes('No songs match “zzzz”.'), 'the no-results sentence');
      t.expect(await page.inputValue('.shell-search-input') === 'zzzz', 'the search field holds the query');
      await expectTargets(t, page);
      await t.capture('shown');
      await page.getByRole('button', {name: 'Add “zzzz” as a new song'}).click();
      await page.waitForFunction(() => location.pathname === '/add');
      t.expect(await page.evaluate(() => location.search) === '?q=zzzz', 'it opens /add?q=zzzz');
    },
  },
  {
    name: 'lb1a-home-no-results-web-online',
    url: app('q=zzzz&fx-devices=online'),
    opts: APP,
    async fn(page, t) {
      await page.evaluate(scrollTo, '.lib-library');
      t.expect(await page.getByRole('button', {name: 'Add “zzzz” as a new song'}).isVisible(), 'an online paired computer can add it (B5)');
      await page.getByRole('button', {name: 'Clear search'}).click();
      await page.waitForTimeout(150);
      t.expect(await page.inputValue('.shell-search-input') === '', 'Clear search empties the field');
      t.expect(await page.evaluate(() => document.querySelectorAll('.lib-grid > [data-key^="song:"]').length) === 12, 'and shows every song');
    },
  },
  {
    name: 'lb1a-home-no-results-web-offline',
    url: app('q=zzzz&fx-devices=offline'),
    opts: APP,
    async fn(page, t) {
      await page.evaluate(scrollTo, '.lib-library');
      t.expect(!(await page.getByRole('button', {name: 'Add “zzzz” as a new song'}).count()), 'no Add action without an online computer');
      t.expect(await page.getByRole('button', {name: 'Clear search'}).isVisible(), '[Clear search] stays');
    },
  },
  {
    name: 'lb1a-home-empty-filter',
    url: app('filter=spots&artist=Marisol%20Vega'),
    opts: APP,
    async fn(page, t) {
      await page.evaluate(scrollTo, '.lib-library');
      t.expect((await page.locator('.lib-empty').textContent()).includes('No songs match Artist: Marisol Vega with this filter.'), 'the empty sentence');
      await expectTargets(t, page);
      await t.capture('shown');
      await page.getByRole('button', {name: 'Show all'}).click();
      await page.waitForTimeout(150);
      t.expect(await page.evaluate(() => document.querySelectorAll('.lib-grid > [data-key^="song:"]').length) === 12, '[Show all] clears the filter and the drill-down');
    },
  },
  {
    name: 'lb1a-home-loading',
    url: '/?fx-reset=1&fx-library=slow',
    opts: APP,
    async fn(page, t) {
      const facts = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.lib-skeleton-grid .ui-skeleton-item')];
        const top = items.length ? Math.round(items[0].getBoundingClientRect().top) : 0;
        return {count: items.length, columns: items.filter(i => Math.round(i.getBoundingClientRect().top) === top).length,
          busy: document.querySelector('.lib-body').getAttribute('aria-busy'), slow: document.querySelector('.lib-slow') != null};
      });
      t.expect(facts.count === 8 && facts.busy === 'true' && !facts.slow, `an 8-card skeleton ${JSON.stringify(facts)}`);
      t.expect(facts.columns === (t.device === 'ipad' ? 3 : 6), `in the grid geometry (${facts.columns} columns)`);
    },
  },
  {
    name: 'lb1a-home-still-connecting',
    url: '/?fx-reset=1&fx-library=slow&fx-audio=manual',
    opts: {...APP, installClock: true},
    async fn(page, t) {
      t.expect(!(await page.locator('.lib-slow').count()), 'nothing before 8 s');
      await t.advance(8100);
      await page.waitForSelector('.lib-slow');
      t.expect((await page.locator('.lib-slow').textContent()).includes('Still connecting…'), '"Still connecting…" after 8 s');
      t.expect(await page.getByRole('button', {name: 'Retry'}).isVisible(), 'with [Retry]');
      await expectTargets(t, page);
    },
  },
  {
    name: 'lb1a-home-first-run-web',
    url: '/?fx-reset=1&fx-library=empty',
    opts: APP,
    async fn(page, t) {
      // The seed has no demo token for an empty library; set one (the server's DEMO_SHARE_TOKEN) and load again.
      await page.evaluate(() => window.fixture.update(db => { db.demoToken = 'dec0'.repeat(16); }));
      await page.reload();
      await t.ready('library');
      await page.waitForSelector('.lib-first-demo:not([hidden])');
      t.expect(await page.getByRole('heading', {name: 'Try the example song'}).isVisible(), 'the Demo card');
      t.expect(await page.getByRole('heading', {name: 'Add songs from your computer'}).isVisible(), 'the web Add card');
      const link = page.getByRole('link', {name: /Get Woodshed for desktop/});
      t.expect(await link.getAttribute('target') === '_blank' && await link.getAttribute('href') === '/download', 'Get Woodshed for desktop opens /download in a new tab');
      t.expect(await page.evaluate(() => document.querySelector('.lib-header').hidden), 'no Library header on the first run');
      const side = await page.evaluate(() => { const [a, b] = [...document.querySelectorAll('.lib-first-card')].map(c => c.getBoundingClientRect()); return {sideBySide: Math.abs(a.top - b.top) < 1, stacked: b.top >= a.bottom}; });
      t.expect(t.device === 'ipad' ? side.stacked : side.sideBySide, `cards ${t.device === 'ipad' ? 'stacked' : 'side by side'} ${JSON.stringify(side)}`);
      await page.getByRole('button', {name: 'I already have it'}).click();
      t.expect(await page.getByText('Open Woodshed on your computer and sign in with this account.').isVisible(), 'I already have it reveals the hint');
      await expectTargets(t, page);
    },
  },
  {
    name: 'lb1a-home-first-run-desktop',
    url: '/?fx-reset=1&fx-library=empty&fx-desktop=1',
    opts: {...APP, structure: PLACEHOLDER_OK},
    async fn(page, t) {
      t.expect(await page.getByRole('heading', {name: 'Add your first song'}).isVisible(), 'the desktop Add card');
      t.expect(await page.locator('.lib-first-demo').isHidden(), 'no Demo card without a demo token (D7)');
      await expectTargets(t, page);
      await t.capture('shown');
      await page.locator('.lib-first-add').getByRole('button', {name: 'Add song'}).click();
      await page.waitForFunction(() => location.pathname === '/add');
    },
  },
  {
    name: 'lb1a-home-search-enter',
    url: app('fx-jobs=0'),
    opts: {...APP, devices: ['laptop'], themes: ['light'], capture: false, structure: PLACEHOLDER_OK},
    async fn(page, t) {
      // Appendix A: `/`, type, Enter opens the top result.
      await page.keyboard.press('/');
      t.expect(await page.evaluate(() => document.activeElement?.classList.contains('shell-search-input')), '/ focuses the search field');
      await page.keyboard.type('glasshouse');
      await page.waitForTimeout(100);
      const keys = await page.evaluate(() => [...document.querySelectorAll('.lib-grid > [data-key]')].map(n => n.dataset.key));
      t.expect(JSON.stringify(keys) === JSON.stringify(['song:glasshouse']), `typing filters live (${keys})`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => location.pathname === '/s/glasshouse');
      await page.goBack();
      await t.ready('library');
      // Back from the Stage refocuses the card that was opened.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.locator('[data-key="song:velvet"] a.lib-open').focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => location.pathname === '/s/velvet');
      await page.goBack();
      await t.ready('library');
      await page.waitForTimeout(100);
      const focused = await page.evaluate(() => document.activeElement?.dataset?.focusKey ?? null);
      t.expect(focused === 'song:velvet', `Back refocuses the opened card (${focused})`);
    },
  },
  {
    name: 'lb1a-home-keys',
    url: app('fx-jobs=0'),
    opts: {...APP, devices: ['laptop'], themes: ['light'], capture: false, structure: PLACEHOLDER_OK},
    async fn(page, t) {
      await page.locator('[data-key="song:lowtide"] a.lib-open').focus();
      const key = () => page.evaluate(() => document.activeElement?.dataset?.focusKey ?? null);
      await page.keyboard.press('ArrowRight');
      t.expect(await key() === 'song:lanterns', 'ArrowRight moves to the next card');
      await page.keyboard.press('ArrowDown');
      const down = await key();
      t.expect(down && down !== 'song:lanterns', `ArrowDown moves a row down (${down})`);
      await page.keyboard.press('End');
      t.expect(await key() === 'song:quiet', `End focuses the last card (${await key()})`);
      await page.keyboard.press('Home');
      t.expect(await key() === 'song:lowtide', 'Home focuses the first card');
      const tabStops = await page.evaluate(() => [...document.querySelectorAll('.lib-grid a.lib-open')].filter(a => a.tabIndex === 0).length);
      t.expect(tabStops === 1, `the grid is one Tab stop (${tabStops})`);
      await page.keyboard.press('KeyE');
      await page.waitForFunction(() => location.pathname === '/s/lowtide/edit/details');
    },
  },

  // ------------------------------------------------------------------ the harness
  {
    name: 'lb1a-cards',
    url: '/__harness/home?part=cards',
    async fn(page, t) {
      const facts = await page.evaluate(() => {
        const card = document.querySelector('[data-key="song:h0"]');
        const title = card.querySelector('.lib-card-title').getBoundingClientRect();
        const more = card.querySelector('.lib-more').getBoundingClientRect();
        return {overlap: more.left < title.right && title.left < more.right && more.top < title.bottom && title.top < more.bottom,
          states: [...document.querySelectorAll('.lib-grid > .lib-card')].map(c => c.dataset.state)};
      });
      t.expect(!facts.overlap, '⋯ sits in its own cell and never covers the title');
      t.expect(JSON.stringify(facts.states) === JSON.stringify(['ready', 'ready', 'processing', 'processing', 'processing', 'processing', 'processing', 'resplitting', 'working', 'failed']), `states ${facts.states}`);
      await expectTargets(t, page);
      if (t.device === 'ipad') {
        const opened = await longPressOpens(page, page.locator('[data-key="song:h0"] .lib-card-cover'), {ms: 500});
        t.expect(opened.ok, 'a 500 ms long-press opens the card menu through onMenu');
        const calls = await page.evaluate(() => window.__cards.menu);
        t.expect(calls.length === 1 && calls[0].id === 'h0', `onMenu was called once for h0 (${JSON.stringify(calls)})`);
        await page.keyboard.press('Escape');
        await page.waitForSelector('[role=menu]', {state: 'detached'});
        const short = await shortPressDoesNotOpen(page, page.locator('[data-key="song:h1"] .lib-card-cover'), {ms: 500});
        t.expect(short.ok, 'a shorter press opens no menu');
        const tapped = await page.evaluate(() => window.__cards.opened);
        t.expect(JSON.stringify(tapped) === JSON.stringify(['h1']), `a short press is a tap that opens the song (${tapped})`);
      } else {
        await page.locator('[data-key="song:h0"] .lib-card-cover').click({button: 'right'});
        await page.waitForSelector('[role=menu]');
        await page.keyboard.press('Escape');
        await page.waitForSelector('[role=menu]', {state: 'detached'});
        const focus = await walkFocus(page, {stops: 12});
        t.expect(!focus.length, focus.join('; '));
        await page.evaluate(() => document.activeElement?.blur?.());
      }
    },
  },
  {
    name: 'lb1a-cards-list',
    url: '/__harness/home?part=cards&layout=list',
    async fn(page, t) {
      await expectTargets(t, page);
      const heights = await page.evaluate(() => [...document.querySelectorAll('.lib-row')].map(r => Math.round(r.getBoundingClientRect().height)));
      t.expect(heights.every(h => h >= (t.device === 'ipad' ? 64 : 56)), `row heights ${heights}`);
    },
  },
  {
    name: 'lb1a-home-flip',
    url: '/__harness/home?part=home&job=1',
    opts: {requires: PEERS, themes: ['light'], capture: false},
    async fn(page, t) {
      await page.evaluate(() => { const d = document.querySelector('.lib-divider'); d?.scrollIntoView(); });
      const result = await page.evaluate(async () => {
        window.__home.finish();
        await new Promise(r => requestAnimationFrame(() => r()));
        const card = document.querySelector('[data-key="song:harbor"]');
        const anims = card ? card.getAnimations() : [];
        return {card: !!card, durations: anims.map(a => a.effect.getTiming().duration), divider: !!document.querySelector('.lib-divider')};
      });
      t.expect(result.card && !result.divider, 'the job left and its song arrived');
      t.expect(result.durations.includes(260), `the card FLIPs for 260 ms (${result.durations})`);
      // Let the flight land before the structure check (a card in flight overlaps whatever it passes).
      await page.evaluate(() => Promise.all((document.querySelector('[data-key="song:harbor"]')?.getAnimations() ?? []).map(a => a.finished)));
    },
  },
  {
    name: 'lb1a-home-flip-reduced',
    url: '/__harness/home?part=home&job=1',
    opts: {requires: PEERS, themes: ['light'], devices: ['laptop'], capture: false, reducedMotion: 'reduce'},
    async fn(page, t) {
      const durations = await page.evaluate(async () => {
        window.__home.finish();
        await new Promise(r => requestAnimationFrame(() => r()));
        return (document.querySelector('[data-key="song:harbor"]')?.getAnimations() ?? []).map(a => a.effect.getTiming().duration);
      });
      t.expect(!durations.length, `no FLIP under reduced motion (${durations})`);
    },
  },
];
