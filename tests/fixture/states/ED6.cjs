// ED6's states: Edit · Details (architecture §9 ED6, §10.5 "ED6" captures; spec §5.3). The app on the
// fixture database: the Details tab of the Edit frame (/s/:id/edit/details) and the bulk page
// (/edit/details?ids=…) with its posture bar.
//
//   ed6-single        Glasshouse (matched): Song, Practice, Artwork and Match; "Matched on MusicBrainz",
//                     attribution ≥ 12 px; laptop: two columns, iPad portrait: one; targets
//   ed6-saved         Genre edited and blurred: inline "Saved", Revert; Revert puts the old value back
//   ed6-field-error   Year "21" + Tab: the inline error under the field, aria-invalid, nothing saved
//   ed6-uncertain     Counting Stars Backwards (uncertain, with a suggestion): "Not sure this is right",
//                     [Yes, this is right], [Find another match]; Find another → results, then Review →
//                     the field-diff review with checkboxes (extra capture "-review")
//   ed6-unavailable   a lookup that could not reach MusicBrainz: "Couldn't reach MusicBrainz" [Try again]
//   ed6-match-hash    /s/counting/edit/details#match: the Match section is scrolled in and focused
//   ed6-bulk          three songs: "Editing details · 3 songs", Done only; shared values and "Multiple
//                     values — unchanged"; Genre → Apply to 3 songs → "Applied to 3 songs" and Revert
// Cover Art Archive thumbnails are served by a route (the fixture has no network).
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');

const NOW = 'fx-now=2026-10-28T12:00:00Z';
const app = (path, query = '') => `${path}?fx-reset=1&${NOW}${query ? `&${query}` : ''}`;
const SINGLE = {ready: 'edit'};
const BULK = {ready: 'bulkDetails'};

const SLEEVE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#6b7f8e"/><circle cx="5" cy="5" r="3" fill="#d9df84"/></svg>';
async function serveCovers(page) {
  await page.route('https://coverartarchive.org/**', (route) => route.fulfill({status: 200, contentType: 'image/svg+xml', body: SLEEVE}));
}

async function expectTargets(t, page) {
  const problems = await checkTargets(page);
  t.expect(!problems.length, `targets: ${JSON.stringify(problems.slice(0, 6))}`);
}

/** Runs in the page: the page's facts. */
function facts() {
  const box = (el) => {
    if (!el || (el.checkVisibility && !el.checkVisibility())) return null;
    const r = el.getBoundingClientRect();
    return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
  };
  const field = (key) => document.querySelector(`.details-field[data-key="${key}"]`);
  const value = (key) => field(key)?.querySelector('input, textarea')?.value ?? null;
  const attribution = document.querySelector('.details-match .details-attribution');
  return {
    label: document.querySelector('.edit-label')?.textContent ?? null,
    headings: [...document.querySelectorAll('.details h2')].map((n) => n.textContent),
    values: Object.fromEntries(['title', 'artist', 'album', 'year', 'genre', 'notes'].map((k) => [k, value(k)])),
    tags: [...(field('tags')?.querySelectorAll('.ui-chip') ?? [])].map((n) => n.textContent.trim()),
    status: document.querySelector('.details-match-text')?.textContent ?? null,
    matchState: document.querySelector('.details-match')?.dataset.state ?? null,
    attributionPx: attribution ? parseFloat(getComputedStyle(attribution).fontSize) : null,
    main: box(document.querySelector('.details-main')),
    aside: box(document.querySelector('.details-aside')),
    overflowX: document.documentElement.scrollWidth > innerWidth,
  };
}

const field = (page, label) => page.getByRole('textbox', {name: label, exact: true});

module.exports = [
  {
    name: 'ed6-single',
    url: app('/s/glasshouse/edit/details'),
    opts: SINGLE,
    async fn(page, t) {
      await page.waitForSelector('.details-match[data-state]');
      const f = await page.evaluate(facts);
      t.expect(f.label === 'Editing details', `the posture label (${f.label})`);
      t.expect(JSON.stringify(f.headings) === '["Song","Practice","Artwork","Match"]', `sections (${JSON.stringify(f.headings)})`);
      t.expect(f.values.title === 'Glasshouse' && f.values.artist === 'Northbound' && f.values.year === '2021', `values (${JSON.stringify(f.values)})`);
      t.expect(JSON.stringify(f.tags) === '["drums","setlist"]', `tags as chips (${JSON.stringify(f.tags)})`);
      t.expect(f.status === 'Matched on MusicBrainz' && f.matchState === 'matched', `status (${f.status})`);
      t.expect(f.attributionPx >= 12, `attribution ≥ 12 px (${f.attributionPx})`);
      t.expect(!f.overflowX, 'no sideways scroll');
      if (t.device === 'laptop') t.expect(f.aside && f.main && f.aside.x > f.main.x && Math.abs(f.aside.y - f.main.y) < 2, `two columns (${JSON.stringify({main: f.main, aside: f.aside})})`);
      else t.expect(f.aside && f.main && f.aside.y > f.main.y, `one column on iPad portrait (${JSON.stringify({main: f.main, aside: f.aside})})`);
      await expectTargets(t, page);
    },
  },
  {
    name: 'ed6-saved',
    url: app('/s/glasshouse/edit/details'),
    opts: SINGLE,
    async fn(page, t) {
      const genre = field(page, 'Genre');
      await genre.fill('Post-rock');
      await genre.press('Tab');
      await page.waitForFunction(() => document.querySelector('.details-field[data-key=genre] .ui-field-status')?.textContent === 'Saved');
      const stored = await page.evaluate(() => window.fixture.db().songs.find((s) => s.id === 'glasshouse'));
      t.expect(stored.genre === 'Post-rock' && stored.metadataLocks.includes('genre'), `saved and locked (${stored.genre}, ${JSON.stringify(stored.metadataLocks)})`);
      const revert = page.getByRole('button', {name: 'Revert genre'});
      t.expect(await revert.isVisible(), 'Revert is offered for the saved field');
      t.expect(!(await page.getByRole('button', {name: 'Revert title'}).isVisible()), 'no Revert on untouched fields');
      await t.capture('saved');
      await revert.click();
      await page.waitForFunction(() => window.fixture.db().songs.find((s) => s.id === 'glasshouse').genre === 'Indie rock');
      const after = await page.evaluate(() => window.fixture.db().songs.find((s) => s.id === 'glasshouse'));
      t.expect(!after.metadataLocks.includes('genre'), `Revert unlocked the field (${JSON.stringify(after.metadataLocks)})`);
      t.expect(await genre.inputValue() === 'Indie rock', 'the field shows the old value');
      await page.waitForFunction(() => document.querySelector('[aria-label="Revert genre"]')?.hidden === true);
    },
  },
  {
    name: 'ed6-field-error',
    url: app('/s/glasshouse/edit/details'),
    opts: SINGLE,
    async fn(page, t) {
      const year = field(page, 'Year');
      await year.fill('21');
      await year.press('Tab');
      await page.waitForSelector('.details-field[data-key=year] .ui-field-error:not([hidden])');
      const facts = await page.evaluate(() => {
        const input = document.querySelector('.details-field[data-key=year] input');
        return {invalid: input.getAttribute('aria-invalid'), error: document.querySelector('.details-field[data-key=year] .ui-field-error').textContent,
          stored: window.fixture.db().songs.find((s) => s.id === 'glasshouse').year};
      });
      t.expect(facts.invalid === 'true' && facts.error === 'Use a four-digit release year.', `inline error (${JSON.stringify(facts)})`);
      t.expect(facts.stored === '2021', 'nothing was saved');
    },
  },
  {
    name: 'ed6-uncertain',
    url: app('/s/counting/edit/details'),
    opts: SINGLE,
    async fn(page, t) {
      await serveCovers(page);
      await page.waitForSelector('.details-match[data-state=suggestion]');
      const f = await page.evaluate(facts);
      t.expect(f.status === 'Not sure this is right', `status (${f.status})`);
      t.expect(await page.getByRole('button', {name: 'Yes, this is right'}).isVisible(), 'Yes, this is right');
      await page.getByRole('button', {name: 'Find another match'}).click();
      await page.waitForSelector('.details-match .details-result');
      const results = await page.locator('.details-match .details-result').count();
      t.expect(results === 3, `three results (${results})`);
      await expectTargets(t, page);
      await page.locator('.details-match .details-result').first().getByRole('button', {name: 'Review'}).click();
      await page.waitForSelector('.details-match .details-review:not([hidden]) .details-diff-row');
      const rows = await page.locator('.details-diff-row').evaluateAll((els) => els.map((e) => ({
        name: e.querySelector('.details-diff-name').textContent, checked: e.querySelector('input').checked})));
      t.expect(rows.length >= 2 && rows.every((r) => r.checked), `the field-diff review (${JSON.stringify(rows)})`);
      await page.locator('.details-match .details-review').scrollIntoViewIfNeeded();
      await t.capture('review');
      await page.getByRole('button', {name: 'Use selected details'}).click();
      await page.waitForSelector('.details-match[data-state=matched]');
      const stored = await page.evaluate(() => window.fixture.db().songs.find((s) => s.id === 'counting'));
      t.expect(stored.metadataStatus === 'matched' && !!stored.metadataRecordingId && stored.album === 'Weather Systems',
        `applied with the match (${stored.metadataStatus}, ${stored.album})`);
      await page.locator('.details-match').scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'ed6-unavailable',
    url: app('/s/lowtide/edit/details'),
    opts: SINGLE,
    async fn(page, t) {
      await page.evaluate(() => window.fixture.update((db) => { db.songs.find((s) => s.id === 'lowtide').metadataStatus = 'unavailable'; }));
      await page.waitForSelector('.details-match[data-state=unavailable]');
      const f = await page.evaluate(facts);
      t.expect(f.status === 'Couldn’t reach MusicBrainz' || f.status === "Couldn't reach MusicBrainz", `status (${f.status})`);
      t.expect(await page.getByRole('button', {name: 'Try again'}).isVisible(), 'Try again');
      await page.locator('.details-match').scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'ed6-match-hash',
    url: `${app('/s/counting/edit/details')}#match`,
    opts: {...SINGLE, devices: ['ipad'], themes: ['light'], capture: false},
    async fn(page, t) {
      await page.waitForSelector('.details-match[data-state]');
      const f = await page.evaluate(() => {
        const r = document.querySelector('.details-match').getBoundingClientRect();
        return {top: r.top, vh: innerHeight, focused: document.activeElement?.closest?.('.details-match') != null};
      });
      t.expect(f.top >= 0 && f.top < f.vh - 160 && f.focused, `Match is in view and focused (${JSON.stringify(f)})`);
    },
  },
  {
    name: 'ed6-bulk',
    url: app('/edit/details', 'ids=glasshouse,lowtide,secondwind'),
    opts: BULK,
    async fn(page, t) {
      await page.waitForSelector('.details[data-mode=bulk] .details-field');
      const head = await page.evaluate(() => ({
        h1: [...document.querySelectorAll('h1')].map((n) => n.textContent),
        tabs: document.querySelectorAll('[role=tab]').length,
        done: !!document.querySelector('.edit-bulk .edit-done'),
        artist: document.querySelector('.details-field[data-key=artist] input').value,
        titlePlaceholder: document.querySelector('.details-field[data-key=title] input').placeholder,
      }));
      t.expect(head.h1.length === 1 && head.h1[0] === 'Editing details · 3 songs' && head.tabs === 0 && head.done, `the bulk bar (${JSON.stringify(head)})`);
      t.expect(head.titlePlaceholder === 'Multiple values — unchanged' && head.artist === '', `mixed values (${JSON.stringify(head)})`);
      const genre = field(page, 'Genre');
      await genre.fill('Indie');
      await page.locator('.details-field[data-key=genre]').getByRole('button', {name: 'Apply to 3 songs'}).click();
      await page.waitForSelector('.details-field[data-key=genre] .details-applied:not(:empty)');
      const genres = await page.evaluate(() => window.fixture.db().songs.filter((s) => ['glasshouse', 'lowtide', 'secondwind'].includes(s.id)).map((s) => s.genre));
      t.expect(genres.every((g) => g === 'Indie'), `applied to every song (${JSON.stringify(genres)})`);
      t.expect(await page.getByRole('button', {name: 'Revert genre on every song'}).isVisible(), 'Revert after Apply');
      await expectTargets(t, page);
    },
  },
];
