// LB1b's states: the Jobs chip and popover and the "Is this right?" chip (architecture §10.3 "LB1a/LB1b"
// captures: review chip + popover, Jobs chip and popover — every job kind, bot-check retry pending, offline
// device, footer variants). Every state runs the real modules on the fixture database through
// /__harness/jobs (tests/harness/library/jobs.harness.js); job creep is frozen (fx-jobs=frozen) so captures
// are stable, and the moving texts carry data-volatile.
//   lb1b-jobs-chip            the chip in the top bar: text, tone, height, targets
//   lb1b-jobs-popover         every job kind (split, upload-sourced, finishing, re-split, beats, sections,
//                             import, queued with its ahead count, queued on an offline computer, bot check
//                             with Try now, failed split), the web footer (the paired computer online)
//   lb1b-jobs-desktop         the desktop footer "Processor ready · Studio MacBook"
//   lb1b-jobs-offline         the desktop with the processor stopped: the chip, Restart processor, back to ready
//   lb1b-jobs-actions         Details and Copy, Try now on the bot check, Cancel on a queued job
//   lb1b-jobs-focus           opened from a processing card: focus lands on that job's row
//   lb1b-jobs-found           a detection that finished during the session: Bars found, Not now, then empty
//   lb1b-jobs-found-seeded    the seed's unapplied detection from before the session (job-detect-nightbus,
//                             via jobs.latestDetection), offered after a reload; Open song opens it
//   lb1b-jobs-uploads         an upload in progress (real bytes) and a failed upload (Dismiss)
//   lb1b-jobs-web-offline     the web footer when the paired computer is offline
//   lb1b-jobs-web-none        the web footer with no paired computer (Get Woodshed for desktop)
//   lb1b-review-popover       the chip on the songs that need review and the popover; Yes clears the chip
//   lb1b-review-suggest       a suggestion for another recording: Yes applies it (title changes)
//   lb1b-review-find          Find another opens Edit · Details at #match
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');

const H = '/__harness/jobs';
const BASE = 'fx-reset=1&fx-jobs=frozen&fx-now=2026-10-28T12:00:00Z';

/** Waits for the finite animations (the popover's 160 ms grow) to end, so sizes are measured at rest. */
async function settle(page) {
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter(a => Number.isFinite(a.effect?.getComputedTiming?.().endTime ?? Infinity))
    .map(a => a.finished.catch(() => {}))));
}

async function expectTargets(t, page) {
  await settle(page);
  const problems = await checkTargets(page);
  t.expect(!problems.length, `targets: ${JSON.stringify(problems)}`);
}

/** Runs in the page: the chip and the open popover's rows. */
function facts() {
  const chip = document.querySelector('.lib-jobs-chip');
  const pop = document.querySelector('.lib-jobs-popover');
  const rows = pop ? [...pop.querySelectorAll('.lib-job')].map(li => ({
    id: li.dataset.jobId, kind: li.dataset.kind, status: li.dataset.status,
    title: li.querySelector('.lib-job-title')?.textContent ?? '',
    activity: li.querySelector('.lib-job-activity')?.textContent ?? '',
    ahead: li.querySelector('.lib-job-ahead:not([hidden])')?.textContent ?? '',
    settings: li.querySelector('.lib-job-settings:not([hidden])')?.textContent ?? '',
    source: li.querySelector('.lib-job-source:not([hidden])')?.textContent ?? '',
    stages: [...li.querySelectorAll('.ui-stage-stepper-stage')].map(s => `${s.querySelector('.ui-stage-stepper-label').textContent}:${s.dataset.state}`),
    actions: [...li.querySelectorAll('.lib-job-actions .ui-button')].map(b => b.querySelector('.ui-button-label')?.textContent ?? b.textContent),
  })) : null;
  const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; };
  return {
    chip: chip ? {text: chip.querySelector('.ui-button-label')?.textContent, tone: chip.dataset.tone, expanded: chip.getAttribute('aria-expanded'), box: rect(chip)} : null,
    popover: pop ? {box: rect(pop), vw: innerWidth, vh: innerHeight, role: pop.getAttribute('role'), label: document.getElementById(pop.getAttribute('aria-labelledby'))?.textContent} : null,
    rows,
    footer: document.querySelector('.lib-jobs-footer-text')?.textContent ?? null,
    footerButtons: [...document.querySelectorAll('.lib-jobs-footer .ui-button:not([hidden])')].map(b => b.textContent.trim()),
    footerLink: document.querySelector('.lib-jobs-footer-link:not([hidden])')?.textContent ?? null,
    active: document.activeElement?.closest('.lib-job')?.dataset.jobId ?? null,
  };
}

const row = (f, id) => f.rows?.find(r => r.id === id);

async function expectPopoverFits(t, page) {
  await settle(page);
  const f = await page.evaluate(facts);
  const p = f.popover;
  t.expect(p && p.role === 'dialog' && p.label === 'Jobs', `the popover is a dialog named Jobs (${JSON.stringify(p)})`);
  t.expect(p.box.x >= 0 && p.box.x + p.box.w <= p.vw && p.box.y >= 0 && p.box.y + p.box.h <= p.vh, `the popover fits the viewport ${JSON.stringify(p)}`);
  return f;
}

module.exports = [
  {
    name: 'lb1b-jobs-chip',
    url: `${H}?${BASE}`,
    async fn(page, t) {
      const f = await page.evaluate(facts);
      const coarse = t.device === 'ipad';
      t.expect(f.chip?.text === '2 failed', `chip text "${f.chip?.text}"`);
      t.expect(f.chip.tone === 'warn' && f.chip.expanded === 'false', `chip tone/expanded ${JSON.stringify(f.chip)}`);
      t.expect(Math.abs(f.chip.box.h - (coarse ? 48 : 40)) <= 1, `chip height ${f.chip.box.h}`);
      const order = await page.evaluate(() => ['.shell-search', '.lib-jobs-chip', '.shell-add', '.shell-avatar'].map(s => Math.round(document.querySelector(s).getBoundingClientRect().x)));
      t.expect(order[0] < order[1] && order[1] < order[2] && order[2] < order[3], `search, Jobs chip, Add song, avatar from left to right (${order})`);
      await expectTargets(t, page);
    },
  },
  {
    name: 'lb1b-jobs-popover',
    url: `${H}?${BASE}&open=1`,
    async fn(page, t) {
      // The seed's unapplied detection from before the session (latestDetection) joins the list last.
      await page.waitForSelector('.lib-job[data-job-id="job-detect-nightbus"]', {timeout: 8000});
      const f = await expectPopoverFits(t, page);
      const kinds = new Set(f.rows.map(r => r.kind));
      t.expect(['separate', 'beats', 'sections', 'import'].every(k => kinds.has(k)), `every job kind is listed (${[...kinds]})`);
      t.expect(f.rows.length === 13 && f.rows.at(-1).id === 'job-detect-nightbus', `12 jobs and the found detection last (${f.rows.map(r => r.id)})`);
      const run = row(f, 'job-run');
      t.expect(run.title === 'Harbor Lights' && run.settings === 'Balanced · 4 stems' && run.source === 'youtube.com/… ↗', `split row ${JSON.stringify(run)}`);
      t.expect(JSON.stringify(run.stages) === JSON.stringify(['Fetch:done', 'Split:current', 'Finish:pending', 'Ready:pending']), `stepper ${run.stages}`);
      t.expect(/^Splitting on Studio MacBook · started \d+:\d\d ago/.test(run.activity), `activity "${run.activity}"`);
      t.expect(JSON.stringify(run.actions) === '["Cancel"]', `actions ${run.actions}`);
      t.expect(row(f, 'job-up').stages[0] === 'Prepare:current', 'an uploaded file prepares instead of fetching');
      t.expect(row(f, 'job-re').title === 'Counting Stars Backwards', 're-split row names its song');
      t.expect(row(f, 'job-beats').stages.join() === 'Find bars:current,Ready:pending', `beats ${row(f, 'job-beats').stages}`);
      t.expect(row(f, 'job-sections').stages[0] === 'Find sections:current', 'sections row');
      t.expect(row(f, 'job-import').title === 'Old Friends', 'import row');
      const queued = row(f, 'job-q');
      t.expect(queued.title === '“marisol vega satellites live”' && /songs? ahead of this one$/.test(queued.ahead), `queued search ${JSON.stringify(queued)}`);
      t.expect(/is offline\. This starts when it’s back\.$/.test(row(f, 'job-q2').activity), `offline computer "${row(f, 'job-q2').activity}"`);
      const bot = row(f, 'job-bot');
      t.expect(bot.activity === 'YouTube asked for a sign-in check. Woodshed will try again in a few minutes.' && bot.actions.join() === 'Try now,Upload a file instead', `bot check ${JSON.stringify(bot)}`);
      const fail = row(f, 'job-fail');
      t.expect(fail.activity === 'Splitting failed on this computer.' && fail.actions.join() === 'Try again,Try Fast quality', `failed ${JSON.stringify(fail)}`);
      t.expect(f.footer === 'Your Studio MacBook splits new songs · Online', `web footer "${f.footer}"`);
      t.expect(f.chip.expanded === 'true', 'the chip reports the open popover');
      await expectTargets(t, page);
      if (t.device === 'laptop') {
        const focus = await walkFocus(page, {stops: 14});
        t.expect(!focus.length, focus.join('; '));
      }
    },
  },
  {
    name: 'lb1b-jobs-desktop',
    url: `${H}?${BASE}&open=1&fx-desktop=1&only=separate`,
    async fn(page, t) {
      await page.waitForFunction(() => document.querySelector('.lib-jobs-footer-text')?.textContent === 'Processor ready · Studio MacBook', null, {timeout: 5000})
        .catch(() => {});
      const f = await expectPopoverFits(t, page);
      t.expect(f.footer === 'Processor ready · Studio MacBook', `desktop footer "${f.footer}"`);
      t.expect(!f.footerButtons.length && !f.footerLink, 'no footer action while ready');
      await expectTargets(t, page);
    },
  },
  {
    name: 'lb1b-jobs-offline',
    url: `${H}?${BASE}&open=1&fx-desktop=1&fx-processor=stopped&only=beats`,
    async fn(page, t) {
      let f = await page.evaluate(facts);
      t.expect(f.chip?.text === 'Processor offline' && f.chip.tone === 'danger', `offline chip ${JSON.stringify(f.chip)}`);
      t.expect(f.footer === 'Processor offline' && f.footerButtons.join() === 'Restart processor', `offline footer ${JSON.stringify(f)}`);
      await expectTargets(t, page);
      await t.capture('offline');
      await page.getByRole('button', {name: 'Restart processor'}).click();
      await page.waitForFunction(() => /^Processor ready/.test(document.querySelector('.lib-jobs-footer-text')?.textContent ?? ''), null, {timeout: 5000});
      f = await page.evaluate(facts);
      t.expect(f.chip?.text === '1 in progress', `after the restart the chip shows the job (${f.chip?.text})`);
      t.expect(!f.footerButtons.length, 'Restart processor leaves once ready');
    },
  },
  {
    name: 'lb1b-jobs-actions',
    url: `${H}?${BASE}&open=1`,
    opts: {devices: ['laptop'], themes: ['light']},
    async fn(page, t) {
      const fail = page.locator('.lib-job[data-job-id="job-fail"]');
      const details = fail.getByRole('button', {name: 'Details'});
      await details.click();
      t.expect(await details.getAttribute('aria-expanded') === 'true', 'Details expands');
      const pre = fail.locator('pre.lib-job-details-text');
      t.expect(/separation stopped/.test(await pre.textContent()), 'Details shows the raw error');
      const mono = await pre.evaluate(el => getComputedStyle(el).fontFamily);
      t.expect(/Atkinson Hyperlegible Mono/.test(mono), `Details text is mono (${mono})`);
      t.expect(await fail.getByRole('button', {name: 'Copy'}).isVisible(), 'Copy is offered');
      await t.capture('details');
      await page.locator('.lib-job[data-job-id="job-bot"]').getByRole('button', {name: 'Try now'}).click();
      await page.waitForFunction(() => document.querySelector('.lib-job[data-job-id="job-bot"]')?.dataset.status !== 'error', null, {timeout: 5000});
      await page.locator('.lib-job[data-job-id="job-q"]').getByRole('button', {name: 'Cancel'}).click();
      await page.waitForSelector('.lib-job[data-job-id="job-q"]', {state: 'detached', timeout: 5000});
      const f = await page.evaluate(facts);
      t.expect(!row(f, 'job-q') && row(f, 'job-bot')?.status !== 'error', `Try now re-queued the bot check, Cancel removed the queued job ${JSON.stringify(f.rows.map(r => [r.id, r.status]))}`);
      t.expect(f.chip.text === '1 failed', `chip "${f.chip.text}"`);
    },
  },
  {
    name: 'lb1b-jobs-focus',
    url: `${H}?${BASE}&focus=job-fail`,
    opts: {themes: ['light']},
    async fn(page, t) {
      const f = await expectPopoverFits(t, page);
      t.expect(f.active === 'job-fail', `focus is on the failed job's row (${f.active})`);
    },
  },
  {
    name: 'lb1b-jobs-found',
    url: `${H}?${BASE}&open=1&found=1&only=none`,
    opts: {timeout: 90000},
    async fn(page, t) {
      let f = await expectPopoverFits(t, page);
      const found = row(f, 'beats-glasshouse');
      t.expect(found?.status === 'done' && found.actions.join() === 'Open song,Not now', `found detection ${JSON.stringify(found)}`);
      t.expect(found.activity === 'Bars found. Open the song to use them.', `found line "${found.activity}"`);
      t.expect(f.chip.text === 'Bars found' && f.chip.tone === 'accent', `chip ${JSON.stringify(f.chip)}`);
      await expectTargets(t, page);
      await t.capture('found');
      await page.locator('.lib-job[data-job-id="beats-glasshouse"]').getByRole('button', {name: 'Not now'}).click();
      await page.waitForSelector('.lib-job[data-job-id="beats-glasshouse"]', {state: 'detached', timeout: 5000});
      const applied = await page.evaluate(() => window.fixture.db().jobs.find(j => j.jobId === 'beats-glasshouse')?.appliedAt);
      t.expect(typeof applied === 'number', 'Not now marks the detection applied');
      f = await page.evaluate(facts);
      const empty = await page.evaluate(() => document.querySelector('.lib-jobs-empty-title')?.checkVisibility());
      t.expect(empty && f.chip?.text === 'Jobs', `the empty popover keeps its chip until it closes (${JSON.stringify(f.chip)})`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.lib-jobs-chip', {state: 'detached', timeout: 5000});
    },
  },
  {
    name: 'lb1b-jobs-found-seeded',
    url: `${H}?${BASE}&open=1&only=beats`,
    opts: {themes: ['light']},
    async fn(page, t) {
      await page.waitForSelector('.lib-job[data-job-id="job-detect-nightbus"]', {timeout: 8000});
      const f = await expectPopoverFits(t, page);
      const found = row(f, 'job-detect-nightbus');
      t.expect(found?.status === 'done' && found.title === 'Night Bus' && found.actions.join() === 'Open song,Not now', `seeded detection ${JSON.stringify(found)}`);
      t.expect(!row(f, 'job-beats-velvet'), 'the chained, server-applied detection is not offered');
      await page.locator('.lib-job[data-job-id="job-detect-nightbus"]').getByRole('button', {name: 'Open song'}).click();
      const log = await page.evaluate(() => window.__jobs.router.log);
      t.expect(log.some(([kind, to]) => kind === 'navigate' && to === '/s/nightbus'), `Open song navigates to the song (${JSON.stringify(log)})`);
    },
  },
  {
    name: 'lb1b-jobs-uploads',
    url: `${H}?${BASE}&open=1&uploads=1&only=import`,
    async fn(page, t) {
      const f = await expectPopoverFits(t, page);
      const up = row(f, 'upload:up-a');
      t.expect(up?.activity === 'Uploading · 12 of 31 MB' && up.stages[0] === 'Upload:current', `upload row ${JSON.stringify(up)}`);
      const bad = row(f, 'upload:up-b');
      t.expect(bad?.activity === 'This file couldn’t be read as audio.' && bad.actions.join() === 'Choose another file,Dismiss', `failed upload ${JSON.stringify(bad)}`);
      await expectTargets(t, page);
      await t.capture('uploads');
      await page.locator('.lib-job[data-job-id="upload:up-b"]').getByRole('button', {name: 'Dismiss'}).click();
      await page.waitForSelector('.lib-job[data-job-id="upload:up-b"]', {state: 'detached', timeout: 5000});
      await page.locator('.lib-job[data-job-id="upload:up-a"]').getByRole('button', {name: 'Cancel'}).click();
      await page.waitForSelector('.lib-job[data-job-id="upload:up-a"]', {state: 'detached', timeout: 5000});
    },
  },
  {
    name: 'lb1b-jobs-web-offline',
    url: `${H}?${BASE}&open=1&only=sections&fx-devices=offline`,
    async fn(page, t) {
      const f = await expectPopoverFits(t, page);
      t.expect(/ is offline\. Songs you add start when it’s back\.$/.test(f.footer ?? ''), `footer "${f.footer}"`);
    },
  },
  {
    name: 'lb1b-jobs-web-none',
    url: `${H}?${BASE}&open=1&only=import&fx-devices=none`,
    async fn(page, t) {
      const f = await expectPopoverFits(t, page);
      t.expect(f.footer === 'Splitting happens on your computer.' && f.footerLink === 'Get Woodshed for desktop ↗', `footer ${JSON.stringify([f.footer, f.footerLink])}`);
      const link = await page.evaluate(() => { const a = document.querySelector('.lib-jobs-footer-link'); return {href: a.getAttribute('href'), target: a.target}; });
      t.expect(link.href === '/download' && link.target === '_blank', `download link ${JSON.stringify(link)}`);
      await expectTargets(t, page);
    },
  },
  {
    name: 'lb1b-review-popover',
    url: `${H}?part=review&fx-reset=1&open=counting`,
    async fn(page, t) {
      const info = await page.evaluate(() => {
        const pop = document.querySelector('.lib-review-popover');
        const r = pop.getBoundingClientRect();
        return {chips: [...document.querySelectorAll('.lib-review-chip:not([hidden])')].length, role: pop.getAttribute('role'),
          label: document.getElementById(pop.getAttribute('aria-labelledby'))?.textContent, song: pop.querySelector('.lib-review-song').textContent,
          inView: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight};
      });
      t.expect(info.chips === 2, `two songs need review (${info.chips})`);
      t.expect(info.role === 'dialog' && info.label === 'Is this right?' && info.song === 'Counting Stars Backwards' && info.inView, `popover ${JSON.stringify(info)}`);
      await expectTargets(t, page);
      await t.capture('open');
      await page.getByRole('button', {name: 'Yes, that’s it'}).click();
      await page.waitForFunction(() => document.querySelector('[data-song-id="counting"] .lib-review-chip')?.hidden === true, null, {timeout: 5000});
      const status = await page.evaluate(() => window.fixture.db().songs.find(s => s.id === 'counting').metadataStatus);
      t.expect(status === 'matched', `confirmed (${status})`);
    },
  },
  {
    name: 'lb1b-review-suggest',
    url: `${H}?part=review&fx-reset=1&open=counting&suggest=1`,
    opts: {themes: ['dark']},
    async fn(page, t) {
      const lead = await page.locator('.lib-review-lead').textContent();
      t.expect(lead === 'The closest match on MusicBrainz:', `lead "${lead}"`);
      await page.getByRole('button', {name: 'Yes, that’s it'}).click();
      await page.waitForFunction(() => document.querySelector('[data-song-id="counting"] .lib-review-chip')?.hidden === true, null, {timeout: 5000});
      const song = await page.evaluate(() => { const s = window.fixture.db().songs.find(x => x.id === 'counting'); return {title: s.title, status: s.metadataStatus, rec: s.metadataRecordingId}; });
      t.expect(song.title === 'Counting Stars' && song.status === 'matched' && song.rec === 'b6a1c0de-0000-4000-8000-0000000000aa', `the suggestion was applied ${JSON.stringify(song)}`);
    },
  },
  {
    name: 'lb1b-review-find',
    url: `${H}?part=review&fx-reset=1&open=jam03`,
    opts: {devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      const artist = await page.locator('.lib-review-artist').textContent();
      t.expect(artist === 'Unknown artist', `artist "${artist}"`);
      await page.getByRole('button', {name: 'Find another'}).click();
      const nav = await page.evaluate(() => window.__jobs.router.log.at(-1));
      t.expect(nav?.[1] === '/s/jam03/edit/details#match', `Find another navigates (${JSON.stringify(nav)})`);
    },
  },
];
