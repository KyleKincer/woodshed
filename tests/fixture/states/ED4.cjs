// ED4's states: the Find a chart panel (src/edit/map/find-panel.js) in the inspector's place of an
// Edit · Map-shaped page (/__harness/find; tests/harness/edit/find.harness.js), on a real song session
// and a real Edit · Map session, with the fixture's tempo-source handlers (three Glasshouse
// candidates; "zzz" finds nothing). Every state runs with fx-audio=manual. The page reaches no
// unmerged module, so no state declares opts.requires.
//   ed4-find-results       laptop and iPad: the search is pre-filled ("Northbound Glasshouse") and runs
//                          at once; radio rows (Your map + 3) with source, Drum chart badge and duration;
//                          the panel is the 320 px rail (laptop) or the 45% bottom sheet (iPad portrait);
//                          Other sources link out, searched for the song; axe
//   ed4-find-audition      choose the live version: the map changes, the duration-mismatch warning
//                          shows; Space on the chosen row plays with the main transport (D35); ±10/±100,
//                          the offset field, Reset; Line up first downbeat with the cue
//   ed4-find-keep          an audition then Keep my map: the map, the undo stack and the saved tempo
//                          are exactly as before (no tempo save during or after the audition)
//   ed4-find-use           Use their map: one map-stack undo step, saved at once with origin 'imported'
//   ed4-find-keys          typing in the search field never reaches the registry; Esc there is Keep
//                          my map
//   ed4-find-leave         leaving for the Stage mid-audition asks "Use this map?"; Use it applies the
//                          map that was being tried
//   ed4-find-import        ?import=1 focuses Import a file…; a Clone Hero .chart with drums joins the
//                          rows and offers "Use map + drum chart (64 hits)", which writes the drum part
//                          and commits the map
//   ed4-find-has-chart     a song that already has a drum chart: the drum commit asks "Replace the drum
//                          chart?" (capture: replace); Cancel keeps the audition, Replace chart imports and commits
//   ed4-find-none          a search with no matches says so and keeps Import a file…
'use strict';

const {checkAxe} = require('../probes/probe-axe.cjs');

const PAGE = (query = '') => `/__harness/find?fx-audio=manual${query ? `&${query}` : ''}`;
const LAPTOP = {devices: ['laptop']};
const BOTH = {devices: ['laptop', 'ipad']};

/** A 16-bar Clone Hero chart at 120 bpm: kick on 1 and 3, snare on 2 and 4 (64 drum hits). */
function drumChart() {
  const notes = [];
  for (let bar = 0; bar < 16; bar++) {
    for (let beat = 0; beat < 4; beat++) notes.push(`  ${(bar * 4 + beat) * 192} = N ${beat % 2 ? 1 : 0} 0`);
  }
  return ['[Song]', '{', '  Resolution = 192', '  Offset = 0', '}', '[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}',
    '[ExpertDrums]', '{', ...notes, '}', ''].join('\n');
}
const CHART_FILE = {name: 'glasshouse-drums.chart', mimeType: 'text/plain', buffer: Buffer.from(drumChart(), 'utf8')};

/** The search has answered: its rows are in and the status says how many. */
async function searched(page, rows = 4) {
  await page.waitForFunction((n) => document.querySelectorAll('.find-row').length === n
    && !document.querySelector('.find-search-button[aria-busy="true"]'), rows, {timeout: 15000});
}

async function ready(page, rows = 4) {
  await page.waitForFunction(() => !!window.__find, null, {timeout: 15000});
  await page.evaluate(() => document.fonts.ready);
  await searched(page, rows);
}

/** Choose a result row by its candidate id (two rows can share a title) and wait until its map is live. */
async function choose(page, id) {
  await page.check(`.find-radio[value="${id}"]`);
  await page.waitForFunction((v) => {
    const row = document.querySelector(`.find-row[data-choice="${v}"]`);
    return row?.dataset.state === 'selected' && !document.querySelector('.find-row[aria-busy="true"]');
  }, id, {timeout: 15000});
}

const box = (page, selector) => page.$eval(selector, (el) => {
  const r = el.getBoundingClientRect();
  return {x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom};
});
const statusText = (page) => page.$eval('.find-status', (el) => el.textContent.replace(/\s+/g, ' ').trim());
const offsetValue = (page) => page.$eval('.find-offset input', (el) => el.value);
const facts = (page) => page.evaluate(() => {
  const f = window.__find;
  return {json: f.mapJson(), original: f.original, undo: f.undoDepth(), saves: f.saves(), closes: f.closes.map((c) => c.result),
    auditioning: f.mapSession.auditioning.peek(), origin: f.map.snapshot().origin ?? null};
});

module.exports = [
  {
    name: 'ed4-find-results', url: PAGE(), opts: BOTH,
    async fn(page, t) {
      await ready(page);
      t.expect(await page.getByRole('searchbox', {name: 'Song or artist'}).inputValue() === 'Northbound Glasshouse', 'the search is pre-filled with artist and title');
      t.expect(/^3 possible maps\./.test(await statusText(page)), `the search ran at once (${await statusText(page)})`);
      const radios = await page.getByRole('radio').count();
      t.expect(radios === 4, `Your map and three results (got ${radios})`);
      t.expect(await page.getByRole('radio', {name: 'Your map', exact: true}).isChecked(), 'Your map is chosen at first');
      const rows = await page.$$eval('.find-row', (els) => els.map((el) => ({
        title: el.querySelector('.find-row-title').textContent, meta: el.querySelector('.find-row-meta').textContent,
        time: el.querySelector('.find-row-time').hidden ? '' : el.querySelector('.find-row-time').textContent, h: el.getBoundingClientRect().height})));
      t.expect(rows[1].meta === 'Northbound · Weather Systems · Harmonix Set' && rows[1].time === '2:08', `a Harmonix row (${JSON.stringify(rows[1])})`);
      t.expect(rows[2].meta.includes('Chorus Encore · Chart by Rhythmatic'), `a Chorus row names its charter (${rows[2].meta})`);
      for (const r of rows) t.expect(r.h >= 44, `rows are at least 44 px (got ${r.h})`);
      const panel = await box(page, '.find-panel');
      if (t.device === 'laptop') {
        t.expect(Math.round(panel.w) === 320, `the panel is the 320 px rail (got ${panel.w})`);
        t.expect(Math.round(panel.right) === 1440, `at the right edge (right ${panel.right})`);
      } else {
        const vh = await page.evaluate(() => window.innerHeight);
        t.expect(Math.abs(panel.h - vh * 0.45) < 2 && Math.round(panel.bottom) === vh, `the 45% bottom sheet (h ${panel.h}, bottom ${panel.bottom})`);
      }
      // The commit row stays in view under the scrolling body.
      const commit = await box(page, '.find-commit');
      t.expect(commit.bottom <= panel.bottom + 1 && commit.y >= panel.y, 'the commit row is inside the panel');
      await page.getByText('Other sources', {exact: true}).click();
      const enchor = await page.getByRole('link', {name: 'Chorus Encore (opens in a new tab)'}).getAttribute('href');
      const songsterr = await page.getByRole('link', {name: 'Songsterr (opens in a new tab)'}).getAttribute('href');
      t.expect(enchor === 'https://www.enchor.us/?name=Glasshouse&artist=Northbound', `enchor.us searched for the song (${enchor})`);
      t.expect(songsterr === 'https://www.songsterr.com/?pattern=Northbound+Glasshouse', `Songsterr searched for the song (${songsterr})`);
      const problems = await checkAxe(page, {include: ['.find-panel']});
      t.expect(!problems.length, problems.join('; '));
    },
  },
  {
    name: 'ed4-find-audition', url: PAGE(), opts: LAPTOP,
    async fn(page, t) {
      await ready(page);
      t.expect(await page.$eval('.find-align-controls', (el) => el.disabled), 'Align waits for a choice');
      await choose(page, 'ch-2');
      let f = await facts(page);
      t.expect(f.auditioning && f.json !== f.original, 'the live map is the one being tried');
      const warning = await page.$eval('.find-warnings', (el) => (el.hidden ? '' : el.textContent));
      t.expect(warning.includes('This version is 7.5 seconds longer than your recording.'), `the duration-mismatch warning (${warning})`);
      t.expect(await page.$eval('.find-current-name', (el) => el.textContent) === 'Glasshouse (Live at the Grange)', 'Listening to names the choice');
      // Space on the chosen row: the main transport plays it (D35), and the row stays chosen.
      await page.getByRole('radio', {name: 'Glasshouse (Live at the Grange)', exact: true}).focus();
      await page.keyboard.press('Space');
      await page.waitForFunction(() => window.__find.session.transport.snapshot.peek().phase === 'playing', null, {timeout: 10000});
      await page.keyboard.press('Space');
      await page.waitForFunction(() => window.__find.session.transport.snapshot.peek().phase !== 'playing', null, {timeout: 10000});
      t.expect(await page.getByRole('radio', {name: 'Glasshouse (Live at the Grange)', exact: true}).isChecked(), 'Space did not change the choice');
      // Offsets.
      await page.getByRole('button', {name: 'Move the map 10 ms later'}).click();
      await page.getByRole('button', {name: 'Move the map 100 ms later'}).click();
      t.expect(await offsetValue(page) === '110', `+10 then +100 (got ${await offsetValue(page)})`);
      await page.getByRole('button', {name: 'Move the map 100 ms earlier'}).click();
      t.expect(await offsetValue(page) === '10', `−100 (got ${await offsetValue(page)})`);
      const field = page.getByRole('spinbutton', {name: 'Offset (ms)'});
      await field.fill('-250');
      await field.press('Enter');
      t.expect(await offsetValue(page) === '-250' && (await statusText(page)).includes('250 ms earlier than the source map.'), 'the typed offset');
      await page.getByRole('button', {name: 'Reset', exact: true}).click();
      t.expect(await offsetValue(page) === '0', 'Reset');
      // Line up the first downbeat with the cue.
      await page.evaluate(() => window.__find.session.transport.cue(12.5));
      await page.waitForFunction(() => Math.abs(window.__find.session.transport.snapshot.peek().cue - 12.5) < 1e-6, null, {timeout: 5000});
      await page.getByRole('button', {name: 'Line up first downbeat with the cue'}).click();
      const at = await page.evaluate(() => window.__find.map.timeAt(0));
      t.expect(Math.abs(at - 12.5) < 1e-3, `bar 1 is on the cue (got ${at})`);
      f = await facts(page);
      t.expect(f.undo === 0 && f.saves.length === 0, `nothing saved or stacked while auditioning (${f.undo}, ${f.saves.length})`);
      await t.capture('aligned');
    },
  },
  {
    name: 'ed4-find-keep', url: PAGE(), opts: LAPTOP,
    async fn(page, t) {
      await ready(page);
      await choose(page, 'ch-2');
      await page.getByRole('button', {name: 'Move the map 100 ms later'}).click();
      await choose(page, 'hx-1');
      // A negative check: longer than the 400 ms tempo-save debounce, and no save may come.
      await page.waitForTimeout(900);
      let f = await facts(page);
      t.expect(f.saves.length === 0, `no tempo save during the audition (got ${f.saves.length})`);
      await page.getByRole('button', {name: 'Keep my map', exact: true}).click();
      await page.waitForFunction(() => window.__find.closes.length === 1, null, {timeout: 5000});
      await page.waitForTimeout(900);
      f = await facts(page);
      t.expect(JSON.stringify(f.closes) === '["mine"]', `closed as Keep my map (${f.closes})`);
      t.expect(!f.auditioning && f.json === f.original, 'the map is exactly as before');
      t.expect(f.undo === 0, `the undo stack is unchanged (${f.undo})`);
      t.expect(f.saves.length === 0, `the saved tempo is unchanged: nothing was saved (${f.saves.length})`);
      t.expect(await page.$eval('.find-panel', (el) => el.dataset.state) === 'ended', 'the panel is done');
    },
  },
  {
    name: 'ed4-find-use', url: PAGE(), opts: LAPTOP,
    async fn(page, t) {
      await ready(page);
      t.expect(await page.getByRole('button', {name: 'Use their map'}).getAttribute('aria-disabled') === 'true', 'Use their map waits for a choice');
      await choose(page, 'hx-1');
      await page.getByRole('button', {name: 'Use their map'}).click();
      await page.waitForFunction(() => window.__find.saves().length > 0, null, {timeout: 5000});
      const f = await facts(page);
      t.expect(JSON.stringify(f.closes) === '["theirs"]', `closed as Use their map (${f.closes})`);
      t.expect(!f.auditioning && f.json !== f.original && f.origin === 'imported', `their map, origin imported (${f.origin})`);
      t.expect(f.undo === 1, `one map-stack undo step (${f.undo})`);
      t.expect(f.saves.at(-1).origin === 'imported', `saved at once (${JSON.stringify(f.saves)})`);
      await page.evaluate(() => window.__find.mapSession.undo());
      t.expect(await page.evaluate(() => window.__find.mapJson() === window.__find.original), 'Undo restores your map');
    },
  },
  {
    name: 'ed4-find-keys', url: PAGE(), opts: LAPTOP,
    async fn(page, t) {
      await ready(page);
      await choose(page, 'hx-1');
      const field = page.getByRole('searchbox', {name: 'Song or artist'});
      await field.click();
      await field.press('End');
      await page.keyboard.type(' MD1');
      t.expect(await field.inputValue() === 'Northbound Glasshouse MD1', `typing stays in the field (${await field.inputValue()})`);
      t.expect(await page.evaluate(() => window.__find.probe.length) === 0, 'M, D and 1 never reached the registry');
      await page.keyboard.press('Space');
      t.expect(await page.evaluate(() => window.__find.session.transport.snapshot.peek().phase) !== 'playing', 'Space types a space in the field');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.__find.closes.length === 1, null, {timeout: 5000});
      const f = await facts(page);
      t.expect(JSON.stringify(f.closes) === '["mine"]' && f.json === f.original, 'Esc in the field is Keep my map');
    },
  },
  {
    name: 'ed4-find-leave', url: PAGE(), opts: LAPTOP,
    async fn(page, t) {
      await ready(page);
      await choose(page, 'hx-1');
      const tried = await page.evaluate(() => window.__find.mapJson());
      await page.evaluate(() => window.__find.leave('stage'));
      const dialog = page.getByRole('dialog', {name: 'Use this map?'});
      await dialog.waitFor({state: 'visible', timeout: 5000});
      t.expect(await page.evaluate(() => window.__find.mapJson() === window.__find.original), 'the audition ended as Keep my map before asking');
      t.expect(await dialog.getByRole('button', {name: 'Keep my map'}).isVisible(), 'the dialog offers Keep my map');
      await t.capture('asking');
      await dialog.getByRole('button', {name: 'Use it'}).click();
      await page.waitForFunction(() => window.__find.mapJson() !== window.__find.original, null, {timeout: 5000});
      const f = await facts(page);
      const sameBars = await page.evaluate((json) => JSON.stringify(JSON.parse(json).pins) === JSON.stringify(window.__find.map.snapshot().pins), tried);
      t.expect(sameBars && f.origin === 'imported', 'Use it applied the map that was being tried');
    },
  },
  {
    name: 'ed4-find-import', url: PAGE('import=1'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page);
      const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
      t.expect(focused === 'Import a file…', `?import=1 focuses Import a file… (focused: ${focused})`);
      const accept = await page.$eval('input[type=file]', (el) => el.accept);
      t.expect(accept === '.gp3,.gp4,.gp5,.gpx,.gp,.sng,.zip,.mid,.midi,.chart,.txt,.tsv,.lab,.csv', `every format (${accept})`);
      await page.setInputFiles('input[type=file]', CHART_FILE);
      await page.waitForFunction(() => document.querySelectorAll('.find-row').length === 5, null, {timeout: 10000});
      t.expect(await page.getByRole('radio', {name: 'glasshouse-drums.chart', exact: true}).isChecked(), 'the file is tried at once');
      const drums = page.getByRole('button', {name: 'Use map + drum chart (64 hits)'});
      await drums.waitFor({state: 'visible', timeout: 5000});
      t.expect(await drums.getAttribute('aria-disabled') !== 'true', 'the drum commit is available');
      t.expect(await page.$eval('.find-row[data-state=selected] .find-badge', (el) => !el.hidden), 'the file row has the Drum chart badge');
      await t.capture('file');
      await drums.click();
      await page.waitForFunction(() => window.__find.closes.length === 1, null, {timeout: 10000});
      const f = await facts(page);
      t.expect(JSON.stringify(f.closes) === '["drums"]' && f.origin === 'imported' && f.undo === 1, `the map is committed (${JSON.stringify(f)})`);
      const hits = await page.evaluate(() => window.__find.partHits());
      t.expect(hits === 64, `the drum part has the chart's 64 hits (got ${hits})`);
    },
  },
  {
    name: 'ed4-find-has-chart', url: PAGE('chart=1'), opts: LAPTOP,
    async fn(page, t) {
      await ready(page);
      await page.setInputFiles('input[type=file]', CHART_FILE);
      const drums = page.getByRole('button', {name: 'Use map + drum chart (64 hits)'});
      await drums.waitFor({state: 'visible', timeout: 10000});
      t.expect(await drums.getAttribute('aria-disabled') !== 'true', 'the drum commit is available');
      const before = await page.evaluate(() => window.__find.partHits());
      await drums.click();
      const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
      await dialog.getByRole('button', {name: 'Replace chart'}).waitFor({timeout: 10000});
      const body = await dialog.textContent();
      t.expect(/Replace the drum chart\?/.test(body) && body.includes(`The current chart (${before.toLocaleString('en-US')} notes`)
        && body.includes('replaced by 64 notes from glasshouse-drums.chart'), `the confirm names both charts (${body.replace(/\s+/g, ' ')})`);
      await t.capture('replace');
      await dialog.getByRole('button', {name: 'Cancel'}).click();
      await page.waitForTimeout(300);
      t.expect(await page.evaluate(() => window.__find.partHits()) === before, 'Cancel leaves the chart alone');
      t.expect(await page.evaluate(() => window.__find.closes.length) === 0 && await page.evaluate(() => window.__find.mapSession.auditioning.peek()),
        'and the audition stays open');
      await drums.click();
      await dialog.getByRole('button', {name: 'Replace chart'}).click();
      await page.waitForFunction(() => window.__find.closes.length === 1, null, {timeout: 10000});
      t.expect(await page.evaluate(() => window.__find.partHits()) === 64, 'Replace chart imports the file\'s 64 hits');
      t.expect(await page.evaluate(() => window.__find.closes[0]?.result) === 'drums', 'and commits the map with them');
    },
  },
  {
    name: 'ed4-find-none', url: PAGE(), opts: LAPTOP,
    async fn(page, t) {
      await ready(page);
      const field = page.getByRole('searchbox', {name: 'Song or artist'});
      await field.fill('zzz');
      await page.getByRole('button', {name: 'Search', exact: true}).click();
      await page.waitForFunction(() => document.querySelector('.find-status')?.textContent.includes('No matches'), null, {timeout: 10000});
      t.expect(await statusText(page) === 'No matches in Chorus Encore or the Harmonix Set. Import a file, or try another title.', `the empty result (${await statusText(page)})`);
      t.expect(await page.getByRole('radio').count() === 1, 'only Your map remains');
      t.expect(await page.getByRole('button', {name: 'Import a file…'}).isEnabled(), 'Import a file… stays available');
    },
  },
];
