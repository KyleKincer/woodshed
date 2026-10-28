// LB2b's states: the Add sheet (spec §3.1–3.3 and §3.6, architecture §9.12, §10.4). Harness states mount the real
// sheet over the fixture database (/__harness/add, see tests/harness/library/add.harness.js); the flows run the
// full app (`/add` modal over the Library). Desktop states (fx-desktop=1: B4 lookups, files, the local processor)
// run on the laptop only; web states run on the laptop (a centred 640 px dialog) and the iPad (a 90% bottom sheet).
//   lb2b-desktop-candidates   free text → 3–5 radio rows (thumbnail 96×54, badges, durations), the first chosen; geometry
//   lb2b-fallback             B4 fails (fx-lookup=fail): the honest single-result line
//   lb2b-web-single           web / iPad: always the single-result line; dialog vs bottom sheet, Paste on iPad
//   lb2b-spotify              a Spotify link: the lead line, then candidates
//   lb2b-files                three dropped files: two rows with size and duration, notes.pdf flagged; "Add 2 files"
//   lb2b-file-title           one file with its title override typed in
//   lb2b-duplicate            a link already in the library: "Already in your library" [Open it] [Add another version]
//   lb2b-defaults             Change expanded with this computer's Quality estimates and the removes-my-stem warning
//   lb2b-error-offline        the processor is down at submit: inline error [Restart processor] [Details], input kept
//   lb2b-error-playlist       a playlist link: inline error, Add blocked
//   lb2b-error-paused         an export-only account: "Adding songs is paused on this account." [Plan & storage]
//   lb2b-explainer            web without a paired computer: the explainer, download, links, example
//   lb2b-picker-online        B5: "Your Studio MacBook will split this · ● Online ▾" with the computer menu open
//   lb2b-picker-offline       B5: every computer offline: "… is offline. Songs you add start when it's back."
//   lb2b-adding               full app: Add song → type → ↓ → Enter: back on the Library, the new card focused and
//                             ringed under "Adding", the toast "Adding … · Undo"; Undo cancels the job
//   lb2b-another              full app: ⇧↵ adds and keeps the sheet open; Esc closes it to the Library
//   lb2b-web-submit           full app on the web: the job goes to the paired computer, unconfirmed (D43)
//   lb2b-pick                 full app: /add?pick=1 focuses Choose files…
'use strict';

const NOW = 'fx-now=2026-10-28T12:00:00Z';
const H = '/__harness/add';
const LAPTOP = ['laptop'];

/** Runs in the page: the sheet's geometry and state. */
function sheetFacts() {
  const el = document.querySelector('dialog.lib-add');
  if (!el) return null;
  const box = n => { if (!n) return null; const r = n.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; };
  const omnibox = el.querySelector('.lib-add-omnibox');
  const rows = [...el.querySelectorAll('[role=radio].lib-add-candidate')];
  return {
    open: el.open,
    presentation: el.dataset.presentation,
    mode: el.dataset.mode,
    box: box(el),
    omnibox: box(omnibox),
    inputFont: getComputedStyle(el.querySelector('.lib-add-input')).fontSize,
    titleFont: getComputedStyle(el.querySelector('.lib-add-title')).fontSize,
    titleWeight: getComputedStyle(el.querySelector('.lib-add-title')).fontWeight,
    rows: rows.map(r => ({checked: r.getAttribute('aria-checked'), h: Math.round(r.getBoundingClientRect().height),
      thumb: box(r.querySelector('.lib-add-thumb')), badges: [...r.querySelectorAll('.lib-add-badge')].map(b => b.textContent)})),
    text: el.innerText,
    focus: document.activeElement?.className ?? null,
    grabber: !!el.querySelector('.lib-add-grabber') && getComputedStyle(el.querySelector('.lib-add-grabber')).display !== 'none',
    error: el.querySelector('.lib-add-error')?.innerText ?? null,
    submitDisabled: el.querySelector('.lib-add-submit')?.getAttribute('aria-disabled') === 'true',
    submitLabel: el.querySelector('.lib-add-submit')?.innerText.trim() ?? null,
  };
}

const facts = page => page.evaluate(sheetFacts);

/** Shared geometry checks for an open sheet. */
async function expectFrame(page, t, f) {
  t.expect(f && f.open, 'the sheet is an open dialog');
  // Measure once the entry animation (grow or slide-in) has finished.
  await page.waitForFunction(() => document.querySelector('dialog.lib-add')?.getAnimations().every(a => a.playState !== 'running'));
  f = await facts(page);
  const vp = page.viewportSize();
  if (t.device === 'ipad') {
    t.expect(f.presentation === 'sheet', `iPad: a bottom sheet (${f.presentation})`);
    t.expect(Math.abs(f.box.h - vp.height * 0.9) <= 2 && Math.abs(f.box.y + f.box.h - vp.height) <= 2,
      `iPad: 90% of the viewport, at the bottom (${JSON.stringify(f.box)})`);
    t.expect(f.grabber, 'iPad: a grabber');
  } else {
    t.expect(f.presentation === 'dialog', `laptop: a dialog (${f.presentation})`);
    t.expect(f.box.w === 640, `laptop: 640 px wide (${f.box.w})`);
    t.expect(Math.abs(f.box.x + f.box.w / 2 - vp.width / 2) <= 1, `laptop: centred (${JSON.stringify(f.box)})`);
  }
  t.expect(/^24px$/.test(f.titleFont) && Number(f.titleWeight) >= 700, `"Add a song" 24/700 (${f.titleFont}/${f.titleWeight})`);
  if (f.omnibox && f.mode !== 'explainer') {
    t.expect(f.omnibox.h >= 56, `the omnibox is 56 px tall (${f.omnibox.h})`);
    t.expect(f.inputFont === '18px', `18 px text (${f.inputFont})`);
  }
}

module.exports = [
  {
    name: 'lb2b-desktop-candidates',
    url: `${H}?fx-reset=1&fx-desktop=1&${NOW}&q=harbor%20lights`,
    opts: {devices: LAPTOP},
    async fn(page, t) {
      const f = await facts(page);
      await expectFrame(page, t, f);
      t.expect(f.rows.length >= 3 && f.rows.length <= 5, `3–5 candidate rows (${f.rows.length})`);
      t.expect(f.rows[0].checked === 'true' && f.rows.slice(1).every(r => r.checked === 'false'), 'the first is chosen');
      t.expect(f.rows.every(r => r.h >= 72), `rows are at least 72 px (${f.rows.map(r => r.h)})`);
      t.expect(f.rows.filter(r => r.thumb).every(r => r.thumb.w === 96 && r.thumb.h === 54), `thumbnails are 96×54 (${JSON.stringify(f.rows[0].thumb)})`);
      t.expect(f.rows[0].badges.includes('Official') && f.rows[2].badges.includes('Cover'), `badges from the titles (${JSON.stringify(f.rows.map(r => r.badges))})`);
      t.expect(f.text.includes('Split for drums · Balanced quality · 4 stems'), 'the defaults line');
      t.expect(/Processing on this computer · ?\s*Ready/.test(f.text), 'the device line reads Ready');
      await page.keyboard.press('ArrowDown');
      const after = await facts(page);
      t.expect(after.rows[1].checked === 'true', '↓ moves the choice');
      await page.keyboard.press('ArrowUp');
    },
  },
  {
    name: 'lb2b-fallback',
    url: `${H}?fx-reset=1&fx-desktop=1&fx-lookup=fail&${NOW}&q=harbor%20lights`,
    opts: {devices: LAPTOP},
    async fn(page, t) {
      const f = await facts(page);
      await expectFrame(page, t, f);
      t.expect(f.rows.length === 0, 'no candidate rows');
      t.expect(f.text.includes('Woodshed will search YouTube and use the top result for “harbor lights”. You can check it when it’s ready.'), 'the single-result line');
      t.expect(!f.error && !f.submitDisabled, 'no error; Add & split stays available');
    },
  },
  {
    name: 'lb2b-web-single',
    url: `${H}?fx-reset=1&${NOW}&q=harbor%20lights`,
    async fn(page, t) {
      const f = await facts(page);
      await expectFrame(page, t, f);
      t.expect(f.mode === 'web' && f.rows.length === 0, 'web: no lookups, no rows');
      t.expect(f.text.includes('Woodshed will search YouTube and use the top result for “harbor lights”.'), 'the single-result line');
      t.expect(f.text.includes('To add files, drop them into Woodshed on your computer.'), 'files are disabled, with the reason');
      const paste = await page.getByRole('button', {name: 'Paste', exact: true}).count();
      t.expect(t.device === 'ipad' ? paste === 1 : paste === 0, `Paste only on iPad (${paste})`);
      if (t.device === 'ipad') {
        const h = await page.locator('.lib-add-submit').evaluate(n => n.getBoundingClientRect().height);
        t.expect(h >= 56, `iPad: a 56 px primary button (${h})`);
      }
    },
  },
  {
    name: 'lb2b-spotify',
    url: `${H}?fx-reset=1&fx-desktop=1&${NOW}&q=${encodeURIComponent('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')}`,
    opts: {devices: LAPTOP},
    async fn(page, t) {
      const f = await facts(page);
      await expectFrame(page, t, f);
      t.expect(f.text.includes('Spotify doesn’t allow downloads. We’ll find this song on YouTube:'), 'the Spotify lead line');
      t.expect(f.rows.length >= 3, `then candidates (${f.rows.length})`);
    },
  },
  {
    name: 'lb2b-files',
    url: `${H}?fx-reset=1&fx-desktop=1&${NOW}&files=${encodeURIComponent('Harbor Lights.mp3,garage-take-4.wav,notes.pdf')}&duration=221`,
    opts: {devices: LAPTOP},
    async fn(page, t) {
      const f = await facts(page);
      await expectFrame(page, t, f);
      const rows = await page.locator('.lib-add-file').allInnerTexts();
      t.expect(rows.length === 2 && rows.every(r => /MB · 3:41/.test(r)), `two rows with size and duration (${JSON.stringify(rows)})`);
      t.expect(f.text.includes('notes.pdf isn’t audio. Woodshed accepts MP3, WAV, FLAC, M4A, AAC, OGG, Opus, AIFF and WMA.'), 'notes.pdf is flagged');
      t.expect(f.submitLabel === 'Add 2 files', `"Add 2 files" (${f.submitLabel})`);
      t.expect(await page.getByRole('button', {name: 'Remove notes.pdf'}).count() === 1, 'each file has ✕');
    },
  },
  {
    name: 'lb2b-file-title',
    url: `${H}?fx-reset=1&fx-desktop=1&${NOW}&files=${encodeURIComponent('garage-take-4.wav')}&duration=200`,
    opts: {devices: LAPTOP},
    async fn(page, t) {
      const field = page.getByRole('textbox', {name: 'Song title'});
      t.expect(await field.inputValue() === 'garage-take-4', 'the title starts from the file name');
      await field.fill('Garage Groove');
      t.expect((await facts(page)).submitLabel === 'Add & split', 'one file: Add & split');
    },
  },
  {
    name: 'lb2b-duplicate',
    url: `${H}?fx-reset=1&fx-desktop=1&${NOW}&q=${encodeURIComponent('https://www.youtube.com/watch?v=fixture01')}`,
    opts: {devices: LAPTOP},
    async fn(page, t) {
      await page.waitForSelector('.lib-add-duplicate');
      const f = await facts(page);
      t.expect(f.text.includes('Already in your library: Glasshouse — Northbound'), 'the duplicate notice');
      t.expect(await page.getByRole('button', {name: 'Open it'}).count() === 1 && await page.getByRole('button', {name: 'Add another version'}).count() === 1,
        'Open it and Add another version');
    },
  },
  {
    name: 'lb2b-defaults',
    url: `${H}?fx-reset=1&fx-desktop=1&${NOW}&q=harbor%20lights&change=1&stats=1`,
    opts: {devices: LAPTOP, fullPage: false},
    async fn(page, t) {
      const quality = await page.getByRole('radiogroup', {name: 'Quality'}).getByRole('radio').allInnerTexts();
      t.expect(quality.some(q => /~\d+ min/.test(q)), `Quality estimates from this computer (${JSON.stringify(quality)})`);
      t.expect(await page.getByRole('checkbox', {name: 'Use these for future songs'}).count() === 1, 'the save box');
      await page.getByRole('radiogroup', {name: 'Stems'}).getByRole('radio', {name: 'Bass + rest'}).click();
      const f = await facts(page);
      t.expect(f.text.includes('Your drums won’t be a separate track with this layout.'), 'the removes-my-stem warning');
      t.expect(f.text.includes('Split for drums · Balanced quality · 2 stems'), `the line follows the choice (${f.text.match(/Split for[^\n]*/)?.[0]})`);
    },
  },
  {
    name: 'lb2b-error-offline',
    url: `${H}?fx-reset=1&fx-desktop=1&fx-companion=down&${NOW}&q=harbor%20lights&submit=1`,
    opts: {devices: LAPTOP},
    async fn(page, t) {
      await page.waitForSelector('.lib-add-error');
      const f = await facts(page);
      t.expect(f.error.includes('Woodshed’s processor isn’t running on this computer.'), `the inline sentence (${f.error})`);
      t.expect(await page.locator('.lib-add-error').getByRole('button', {name: 'Restart processor'}).count() === 1, 'Restart processor');
      await page.locator('.lib-add-error').getByRole('button', {name: 'Details'}).click();
      t.expect(await page.locator('.lib-add-error pre').isVisible(), 'Details opens the raw text');
      t.expect(await page.locator('.lib-add-input').inputValue() === 'harbor lights', 'the input is kept');
      t.expect(!(await page.evaluate(() => window.fixture.db().jobs.some(j => j.label === 'harbor lights'))), 'no job was made');
    },
  },
  {
    name: 'lb2b-error-playlist',
    url: `${H}?fx-reset=1&fx-desktop=1&${NOW}&q=${encodeURIComponent('https://www.youtube.com/playlist?list=PLx')}`,
    opts: {devices: LAPTOP},
    async fn(page, t) {
      await page.waitForSelector('.lib-add-error');
      const f = await facts(page);
      t.expect(f.error.includes('This link is a playlist. Add one song at a time.'), `the playlist sentence (${f.error})`);
      t.expect(f.submitDisabled, 'Add is blocked');
    },
  },
  {
    name: 'lb2b-error-paused',
    url: `${H}?fx-reset=1&${NOW}&paused=1&q=harbor`,
    async fn(page, t) {
      const f = await facts(page);
      t.expect(f.text.includes('Adding songs is paused on this account.'), 'the paused sentence');
      t.expect(await page.getByRole('button', {name: 'Plan & storage'}).count() === 1, 'Plan & storage');
      t.expect(f.submitDisabled, 'Add is disabled');
    },
  },
  {
    name: 'lb2b-explainer',
    url: `${H}?fx-reset=1&fx-devices=none&${NOW}`,
    async fn(page, t) {
      const f = await facts(page);
      await expectFrame(page, t, f);
      t.expect(f.mode === 'explainer', `the explainer (${f.mode})`);
      t.expect(f.text.includes('Splitting happens on your computer.'), 'the lead');
      t.expect(await page.getByRole('link', {name: /Other platforms/}).count() === 1, 'Other platforms');
      t.expect(await page.getByRole('button', {name: 'Copy download link'}).count() === 1, 'Copy download link');
      const share = await page.getByRole('button', {name: 'Share download link'}).count();
      t.expect(t.device === 'ipad' ? share === 1 : share === 0, `Share download link on iPad only (${share})`);
      t.expect(await page.getByRole('button', {name: 'Open the example song'}).count() === 1, 'Open the example song');
    },
  },
  {
    name: 'lb2b-picker-online',
    url: `${H}?fx-reset=1&${NOW}&menu=1`,
    // The computer menu opens inside the modal dialog (popover.js pushModalHost); structure.cjs compares two targets in
    // different open overlays as if they were one layer, so the form behind the menu is left out (FX1 ticket).
    opts: {structure: {ignore: ['.lib-add-form']}},
    async fn(page, t) {
      const line = (await page.locator('.lib-add-device').innerText()).replace(/\s+/g, ' ');
      t.expect(/Your Studio MacBook will split this · Online/.test(line), `the B5 line (${line})`);
      const items = await page.getByRole('menuitemradio').allInnerTexts();
      t.expect(items.length === 2 && /Online/.test(items[0]) && /Offline/.test(items[1]), `the computer menu (${JSON.stringify(items)})`);
    },
  },
  {
    name: 'lb2b-picker-offline',
    url: `${H}?fx-reset=1&fx-devices=offline&${NOW}&q=harbor`,
    async fn(page, t) {
      const line = await page.locator('.lib-add-device').innerText();
      t.expect(/is offline\. Songs you add start when it’s back\./.test(line), `the offline line (${line})`);
      t.expect(!(await facts(page)).submitDisabled, 'adding still works (it queues)');
    },
  },
  {
    name: 'lb2b-adding',
    url: `/?fx-reset=1&fx-desktop=1&${NOW}`,
    opts: {ready: 'library', devices: LAPTOP},
    async fn(page, t) {
      await page.getByRole('button', {name: 'Add song'}).first().click();
      await t.ready('add');
      t.expect((await page.evaluate(() => document.activeElement?.className)).includes('lib-add-input'), 'the omnibox has focus');
      await page.keyboard.type('harbor lights');
      await page.waitForSelector('.lib-add-candidate');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => location.pathname === '/' && !document.querySelector('dialog.lib-add'));
      await page.waitForSelector('[data-add-ring]');
      const after = await page.evaluate(() => {
        const job = window.fixture.db().jobs.at(-1);
        const active = document.activeElement;
        const card = active?.closest('.lib-card, .lib-row');
        const divider = [...document.querySelectorAll('*')].find(n => n.children.length === 0 && /^adding$/i.test(n.textContent.trim()));
        return {job, focus: active?.dataset?.focusKey ?? null, ring: card?.hasAttribute('data-add-ring') ?? false,
          toast: document.querySelector('.ui-toast')?.innerText ?? null, divider: !!divider,
          live: document.querySelector('.app-live-host')?.textContent ?? ''};
      });
      t.expect(after.job.confirmed === true && after.job.source.type === 'url' && after.job.meta?.title?.includes('Live at the Grange'),
        `the chosen candidate is queued, confirmed (${JSON.stringify(after.job)})`);
      t.expect(after.focus === `job:${after.job.jobId}`, `focus moved to the new card (${after.focus})`);
      t.expect(after.ring, 'the new card is ringed');
      t.expect(after.divider, 'under the "Adding" divider');
      t.expect(/Adding Harbor Lights \(Live at the Grange\)/.test(after.toast ?? '') && /Undo/.test(after.toast ?? ''), `the toast (${after.toast})`);
      await page.waitForFunction(() => document.querySelector('.app-live-host')?.textContent.includes('Adding Harbor Lights'));
      await t.capture('toast');
      await page.locator('.ui-toast').getByRole('button', {name: 'Undo'}).click();
      await page.waitForFunction(id => window.fixture.db().jobs.find(j => j.jobId === id)?.status === 'canceled', after.job.jobId);
      t.expect(true, 'Undo cancels the job');
    },
  },
  {
    name: 'lb2b-another',
    url: `/add?fx-reset=1&fx-desktop=1&${NOW}`,
    opts: {ready: 'add', devices: LAPTOP, capture: false},
    async fn(page, t) {
      const before = await page.evaluate(() => window.fixture.db().jobs.length);
      await page.keyboard.type('https://www.youtube.com/watch?v=abc123');
      await page.waitForSelector('.lib-add-candidate');
      await page.keyboard.press('Shift+Enter');
      await page.waitForFunction(n => window.fixture.db().jobs.length === n + 1, before);
      const f = await facts(page);
      t.expect(f && f.open, 'the sheet stays open');
      t.expect(await page.locator('.lib-add-input').inputValue() === '', 'cleared for the next song');
      t.expect(f.text.includes('Add another, or close this.'), 'a note says it was added');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => location.pathname === '/' && !document.querySelector('dialog.lib-add'));
      t.expect(await page.evaluate(() => document.documentElement.dataset.place) === 'library', 'Esc closes it to the Library');
    },
  },
  {
    name: 'lb2b-web-submit',
    url: `/add?fx-reset=1&${NOW}&q=${encodeURIComponent('night bus kito')}`,
    opts: {ready: 'add', devices: LAPTOP, capture: false},
    async fn(page, t) {
      await page.getByRole('button', {name: 'Add & split'}).click();
      await page.waitForFunction(() => location.pathname === '/');
      const job = await page.evaluate(() => window.fixture.db().jobs.at(-1));
      t.expect(job.deviceId === 'dev1' && job.confirmed === false && job.source.type === 'search', `queued on the paired computer, unconfirmed (${JSON.stringify(job)})`);
    },
  },
  {
    name: 'lb2b-pick',
    url: `/?fx-reset=1&fx-desktop=1&${NOW}`,
    opts: {ready: 'library', devices: LAPTOP},
    async fn(page, t) {
      // "Upload a file instead" on the bot-checked job (Jobs popover) → /add?pick=1: inside that click the picker opens.
      const chooser = page.waitForEvent('filechooser', {timeout: 10_000});
      await page.locator('.shell-jobs button').first().click();
      await page.getByRole('button', {name: 'Upload a file instead'}).first().click();
      await t.ready('add');
      const fc = await chooser;
      t.expect(fc.isMultiple(), 'the file picker opened at once (multiple files)');
      const focus = await page.evaluate(() => document.activeElement?.textContent?.trim());
      t.expect(focus === 'Choose files…', `Choose files… has focus (${focus})`);
      t.expect(await page.evaluate(() => location.search) === '?pick=1', 'the URL is /add?pick=1');
      await fc.setFiles([{name: 'Harbor Lights.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(4096)}]);
      await page.waitForSelector('.lib-add-file');
      t.expect(await page.getByRole('textbox', {name: 'Song title'}).inputValue() === 'Harbor Lights', 'the chosen file is listed with its title');
    },
  },
];
