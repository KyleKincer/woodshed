// ED5's states: Edit · Chart (src/edit/chart/chart-edit.js) on its harness (/__harness/chart-edit: a
// real song session with the demo drum part, 64 bars of 4/4 at 120 bpm on the 8-section rehearsal
// map), in the app theme (?place=edit). The page reaches ED4's src/edit/drum-import.js (Part ▾ →
// Drum part from file…), so every state lists it in opts.requires; the posture-frame states also
// need ED2's src/edit/edit.js.
//   ed5-chart-score         score: engraved 16-bar page, toolbar rows 44 px (52 coarse), Undo/Redo text
//                           only at ≥ 1200 px, key-cap hints hidden until keyboard use; laptop: inspector
//                           tabs Kit · Properties · Listen in a 320 px column; iPad portrait: score on
//                           top, the toolbar, inspector buttons and the 4 × 7 kit bank of 56 px pads
//                           docked below; axe; targets
//   ed5-chart-lanes         lanes: labels aligned with the rows, Grid ▾ and Fit shown
//   ed5-chart-tab-*         laptop: each inspector tab (kit, properties, listen)
//   ed5-chart-sheet         iPad portrait: Properties opens as a sheet; Esc closes it
//   ed5-chart-edit-menu     Edit ▾ with every item and its shortcut
//   ed5-chart-part-menu     Part ▾ with every item
//   ed5-chart-drum-keys     Drum keys…: a reserved key (N) is refused inline
//   ed5-chart-bank          iPad: a pad writes at the cursor; Skip and ▸ step the cursor
//   ed5-chart-keys          keyboard (D18): drum letters and digits in the score; key-cap hints after
//                           keyboard use; Esc clears, PageDown pages
//   ed5-chart-status-*      the save status without a posture bar (saving, local, conflict + Review,
//                           offline + Retry)
//   ed5-chart-new           a song with no chart: Edit · Chart opens an empty part to write
//   ed5-chart-frame         the Edit posture (ED2) on Chart: posture bar 48 px with a 2 px --edit top
//                           border and "Editing drum chart", the save status there with Review
'use strict';

const {checkAxe} = require('../probes/probe-axe.cjs');
const {checkTargets} = require('../probes/probe-targets.cjs');

const PEER = ['src/edit/drum-import.js'];
const FRAME = [...PEER, 'src/edit/edit.js'];
const HARNESS = (query = '') => `/__harness/chart-edit?place=edit&fx-audio=manual${query ? `&${query}` : ''}`;
const LAPTOP = {devices: ['laptop']};
const IPAD = {devices: ['ipad']};

/** Waits for the workspace and its first engraving (or the lanes) and the fonts. */
async function ready(page, {lanes = false} = {}) {
  await page.waitForSelector('.chart-edit[data-state=ready]', {timeout: 30_000});
  if (lanes) await page.waitForSelector('.notation-lanes svg.lanes', {timeout: 30_000});
  else await page.waitForFunction(() => document.querySelectorAll('.notation-score .score-engraving svg text').length > 4, null, {timeout: 30_000});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
}

const hits = (page) => page.evaluate(() => window.__chartEdit.ts.session.notation.part.score.bars.reduce((n, b) => n + b.hits.length, 0));
const chartState = (page) => page.evaluate(() => {
  const s = window.__chartEdit.workspace().state();
  return {range: s.range, step: s.step, selected: s.selectedCount, piece: s.piece.id, tab: s.inspectorTab, barRange: s.barRange};
});
const box = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el || el.hidden) return null;
  const r = el.getBoundingClientRect();
  return {x: r.x, y: r.y, w: r.width, h: r.height};
}, selector);

/** The menu items as [name, aria-keyshortcuts]. */
const menuItems = (page) => page.evaluate(() => [...document.querySelectorAll('.ui-menu [role^=menuitem]')].map((row) => [
  (row.getAttribute('aria-labelledby') ? document.getElementById(row.getAttribute('aria-labelledby'))?.textContent : row.textContent)?.trim(),
  row.getAttribute('aria-keyshortcuts'),
]));

module.exports = [
  {
    name: 'ed5-chart-score', url: HARNESS(), opts: {requires: PEER},
    async fn(page, t) {
      await ready(page);
      const f = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.chart-toolbar > .chart-tool-group:not([hidden]), .chart-toolbar > .chart-tool-writing')]
          .map((el) => Math.round(el.getBoundingClientRect().height));
        const undo = document.querySelector('.chart-tool-history button');
        const hint = document.querySelector('.chart-tool-step kbd[data-hint]');
        const inspector = document.querySelector('.chart-edit-harness-inspector');
        const surface = document.querySelector('.notation-surface');
        return {
          rows, undoText: getComputedStyle(undo.querySelector('.ui-button-text')).display !== 'none', undoName: undo.getAttribute('aria-label'),
          hintShown: !!hint && getComputedStyle(hint).display !== 'none' && !hint.hidden,
          range: document.querySelector('.chart-tool-range-text').textContent,
          tabs: [...document.querySelectorAll('.chart-edit-inspector [role=tab]')].map((x) => x.textContent.trim()),
          inspectorW: inspector ? Math.round(inspector.getBoundingClientRect().width) : null,
          focused: document.activeElement === surface, scope: surface.dataset.scope,
          bank: [...document.querySelectorAll('.chart-bank-row')].map((r) => r.querySelectorAll('button').length),
          padH: [...document.querySelectorAll('.chart-bank-pad')].map((b) => Math.round(b.getBoundingClientRect().height)),
          bankHidden: document.querySelector('.chart-edit-bank').hidden,
          layout: document.querySelector('.chart-edit').dataset.layout,
          pages: window.__chartEdit.workspace().state().range,
        };
      });
      const rowH = t.device === 'ipad' ? 52 : 44;
      t.expect(f.rows.length && f.rows.every((h) => h === rowH), `toolbar rows are ${rowH} px (got ${f.rows})`);
      t.expect(f.undoText === (t.device === 'laptop') && f.undoName === 'Undo', `Undo shows text only at ≥ 1200 px, and keeps its name (${JSON.stringify(f)})`);
      t.expect(!f.hintShown, 'key-cap hints stay hidden before keyboard use');
      t.expect(f.range === 'Bars 1–16' && f.pages.first === 0 && f.pages.last === 15, `16-bar pages (got ${f.range})`);
      t.expect(f.focused && f.scope === 'edit.chart.score', 'the score has focus, in the edit.chart.score scope');
      if (t.device === 'laptop') {
        t.expect(f.layout === 'wide' && f.inspectorW === 320, `the inspector column is 320 px (got ${f.inspectorW})`);
        t.expect(f.tabs.join(' · ') === 'Kit · Properties · Listen', `inspector tabs (got ${f.tabs})`);
        t.expect(f.bankHidden, 'no kit bank on a laptop');
      } else {
        t.expect(f.layout === 'portrait' && !f.tabs.length, 'iPad portrait: no inspector column');
        t.expect(!f.bankHidden && f.bank.join() === '7,7,7,7', `the kit bank is 4 × 7 (got ${f.bank})`);
        t.expect(f.padH.length === 28 && f.padH.every((h) => h === 56), `pads are 56 px (got ${[...new Set(f.padH)]})`);
        const order = await page.evaluate(() => {
          const y = (sel) => document.querySelector(sel).getBoundingClientRect().y;
          return {score: y('.chart-edit-main'), tools: y('.chart-toolbar'), panels: y('.chart-edit-panels'), bank: y('.chart-edit-bank'),
            bankBottom: document.querySelector('.chart-edit-bank').getBoundingClientRect().bottom, vh: innerHeight};
        });
        t.expect(order.score < order.tools && order.tools < order.panels && order.panels < order.bank && Math.abs(order.bankBottom - order.vh) < 1,
          `score on top, then the toolbar, the inspector buttons and the kit bank docked at the bottom (${JSON.stringify(order)})`);
      }
      const problems = await checkAxe(page, {include: ['.chart-edit-harness']});
      t.expect(!problems.length, problems.join('; '));
      const small = await checkTargets(page);
      t.expect(!small.length, `targets: ${JSON.stringify(small.slice(0, 6))}`);
    },
  },
  {
    name: 'ed5-chart-lanes', url: HARNESS('view=lanes'), opts: {requires: PEER},
    async fn(page, t) {
      await ready(page, {lanes: true});
      const f = await page.evaluate(() => {
        const labels = [...document.querySelectorAll('.notation-lane-label')].map((b) => {
          const r = b.getBoundingClientRect();
          return {name: b.textContent.trim(), mid: r.y + r.height / 2};
        });
        const rows = [...document.querySelectorAll('.notation-lanes .lane-row')].map((p) => {
          const r = p.getBoundingClientRect();
          return r.y + r.height / 2;
        });
        return {labels, rows, grid: !document.querySelector('.chart-tool-lanes').hidden,
          fit: !!document.querySelector('.chart-tool-fit'), hits: document.querySelectorAll('.lane-hit').length};
      });
      t.expect(f.labels.length === f.rows.length && f.labels.every((l, i) => Math.abs(l.mid - f.rows[i]) <= 1.5),
        `lane labels align with their rows (${JSON.stringify(f.labels.slice(0, 3))} vs ${JSON.stringify(f.rows.slice(0, 3))})`);
      t.expect(f.grid && f.fit, 'Grid ▾ and Fit show in Lanes');
      t.expect(f.hits > 100, `the page's hits are drawn (${f.hits})`);
      const problems = await checkAxe(page, {include: ['.chart-edit-harness']});
      t.expect(!problems.length, problems.join('; '));
    },
  },
  ...['kit', 'properties', 'listen'].map((tab) => ({
    name: `ed5-chart-tab-${tab}`, url: HARNESS(`tab=${tab}`), opts: {...LAPTOP, requires: PEER},
    async fn(page, t) {
      await ready(page);
      const f = await page.evaluate((id) => ({
        selected: document.querySelector('.chart-edit-inspector [role=tab][aria-selected=true]')?.textContent.trim(),
        shown: [...document.querySelectorAll('.chart-edit-inspector [role=tabpanel]')].filter((p) => !p.hidden).map((p) => p.id),
        recorded: [...document.querySelectorAll('[data-recorded]')].map((b) => [b.textContent.trim(), b.getAttribute('aria-pressed')]),
        layout: [...document.querySelectorAll('[data-layout]')].filter((b) => b.closest('.chart-edit-inspector')).map((b) => b.textContent.trim()),
        tab: id,
      }), tab);
      t.expect(f.shown.join() === `chart-edit-panel-${tab}`, `only the ${tab} panel shows (${f.shown})`);
      t.expect(f.selected?.toLowerCase() === tab, `the ${tab} tab is selected (${f.selected})`);
      if (tab === 'listen') t.expect(JSON.stringify(f.recorded) === JSON.stringify([['In', 'true'], ['Out', 'false']]), `Recorded drums: In · Out (${JSON.stringify(f.recorded)})`);
      if (tab === 'properties') t.expect(f.layout.join(' · ') === 'Together · Hands & feet', `part layout footer (${f.layout})`);
      if (tab === 'listen') {
        await page.locator('[data-recorded=out]').click();
        const muted = await page.evaluate(() => window.__chartEdit.ts.session.transport.snapshot.peek().mix.tracks.find((x) => x.name === 'drums').muted);
        t.expect(muted === true, 'Out mutes the drums stem in the session mix (the Mix sheet’s switch)');
        await page.evaluate(() => window.__chartEdit.ts.session.transport.setMuted('drums', false));
        await page.waitForFunction(() => document.querySelector('[data-recorded=in]').getAttribute('aria-pressed') === 'true');
      }
      const problems = await checkAxe(page, {include: ['.chart-edit-harness-inspector']});
      t.expect(!problems.length, problems.join('; '));
    },
  })),
  {
    name: 'ed5-chart-sheet', url: HARNESS(), opts: {...IPAD, requires: PEER},
    async fn(page, t) {
      await ready(page);
      await page.locator('.chart-edit-panel-button', {hasText: 'Properties'}).click();
      await page.waitForSelector('dialog.chart-edit-sheet[open]');
      await page.waitForTimeout(300);
      const f = await page.evaluate(() => ({
        title: document.querySelector('dialog.chart-edit-sheet .ui-sheet-title')?.textContent,
        layout: !!document.querySelector('dialog.chart-edit-sheet [data-layout=split]'),
      }));
      t.expect(f.title === 'Properties' && f.layout, `the Properties sheet (${JSON.stringify(f)})`);
      await t.capture('open');
      const problems = await checkAxe(page, {include: ['dialog.chart-edit-sheet']});
      t.expect(!problems.length, problems.join('; '));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog.chart-edit-sheet[open]'));
    },
  },
  {
    name: 'ed5-chart-edit-menu', url: HARNESS(), opts: {requires: PEER, themes: ['light']},
    async fn(page, t) {
      await ready(page);
      await page.locator('[data-menu=edit]').click();
      await page.waitForSelector('.ui-menu [role^=menuitem]');
      await page.waitForTimeout(250);
      const items = await menuItems(page);
      const expected = [['Copy', 'Control+C'], ['Paste', 'Control+V'], ['Repeat bars…', 'Control+D'], ['Select all bars', 'Control+A'],
        ['Delete selected notes', 'Backspace'], ['Move notes…', 'Alt+ArrowLeft'],
        ['Tuplet on this beat…', null], ['Mark bars reviewed', null], ['Loop selection', 'L'], ['Bar meter & label…', null], ['Align in tempo map…', null]];
      const norm = (list) => JSON.stringify(list.map(([n, k]) => [n, k ? k.replace(/^Meta\+/, 'Control+') : null]));
      t.expect(norm(items) === norm(expected), `Edit ▾ items and shortcuts (${JSON.stringify(items)})`);
    },
  },
  {
    name: 'ed5-chart-part-menu', url: HARNESS(), opts: {requires: PEER, themes: ['light']},
    async fn(page, t) {
      await ready(page);
      await page.locator('[data-menu=part]').click();
      await page.waitForSelector('.ui-menu [role^=menuitem]');
      await page.waitForTimeout(250);
      const names = (await menuItems(page)).map(([n]) => n);
      t.expect(names.join(' | ') === ['Export .woodshed.json', 'Print', 'Open .woodshed.json part…', 'Drum part from file (Guitar Pro, MIDI, Clone Hero)…',
        'Clear drum chart…', 'Drum keys…', 'Note list', 'Show every kit piece', 'Keyboard shortcuts'].join(' | '), `Part ▾ items (${names.join(' | ')})`);
    },
  },
  {
    name: 'ed5-chart-drum-keys', url: HARNESS(), opts: {requires: PEER, themes: ['light']},
    async fn(page, t) {
      await ready(page);
      await page.evaluate(() => window.__chartEdit.run('chart.drumKeys'));
      await page.waitForSelector('dialog[open] input[name=crash]');
      await page.fill('dialog[open] input[name=crash]', 'N');
      await page.locator('dialog[open] button[type=submit]').click();
      await page.waitForSelector('dialog[open] [role=alert]:not([hidden])');
      const error = await page.textContent('dialog[open] [role=alert]');
      t.expect(/kept for the score/.test(error), `a reserved key is refused inline (${error})`);
      await t.capture('error');
      const problems = await checkAxe(page, {include: ['dialog[open]']});
      t.expect(!problems.length, problems.join('; '));
    },
  },
  {
    name: 'ed5-chart-bank', url: HARNESS(), opts: {...IPAD, requires: PEER},
    async fn(page, t) {
      await ready(page);
      const touch = await t.touch();
      const before = await hits(page);
      const pad = await box(page, '.chart-bank-pad[data-kit=cowbell]');
      await touch.tap({x: pad.x + pad.w / 2, y: pad.y + pad.h / 2});
      await page.waitForTimeout(200);
      t.expect((await hits(page)) === before + 1, 'a pad writes at the cursor');
      const s0 = await chartState(page);
      const skip = await box(page, '.chart-bank-skip');
      await touch.tap({x: skip.x + skip.w / 2, y: skip.y + skip.h / 2});
      const fwd = await box(page, '.chart-bank-step:last-child');
      await touch.tap({x: fwd.x + fwd.w / 2, y: fwd.y + fwd.h / 2});
      await page.waitForTimeout(200);
      const s1 = await chartState(page);
      t.expect(s1.piece === 'cowbell' && (await hits(page)) === before + 1, `Skip and ▸ move without writing (${JSON.stringify([s0, s1])})`);
    },
  },
  {
    name: 'ed5-chart-keys', url: HARNESS(), opts: {...LAPTOP, requires: PEER, capture: false},
    async fn(page, t) {
      await ready(page);
      const before = await hits(page);
      await page.keyboard.press('KeyS');
      t.expect((await hits(page)) === before + 1, 'S writes a snare in the score');
      await page.keyboard.press('Digit5');
      t.expect((await chartState(page)).step.value === 4, '5 is the quarter step (D18)');
      const hint = await page.evaluate(() => document.querySelector('.chart-tool-step kbd[data-hint]')?.dataset.keys);
      t.expect(hint === 'Digit5', 'the first step cap reads 5');
      await page.keyboard.press('Escape');
      t.expect((await chartState(page)).selected === 0, 'Esc clears the selection');
      await page.keyboard.press('PageDown');
      t.expect((await chartState(page)).range.first === 16, 'PageDown shows the next 16 bars');
      await page.keyboard.press('Comma');
      t.expect((await hits(page)) === before + 1, ', does nothing in the score');
      await page.keyboard.press('Control+KeyZ');
      t.expect((await hits(page)) === before, '⌘Z / Ctrl+Z undoes in the score');
    },
  },
  ...[['saving', 'Saving…', null], ['local', 'Saved on this device', null], ['conflict', 'Another version exists', 'Review'],
    ['offline', 'Waiting for connection', 'Retry']].map(([status, text, action]) => ({
    name: `ed5-chart-status-${status}`, url: HARNESS(`status=${status}`), opts: {...LAPTOP, requires: PEER, themes: ['light']},
    async fn(page, t) {
      await ready(page);
      const f = await page.evaluate(() => {
        const el = document.querySelector('.chart-tool-save');
        const button = el.querySelector('button');
        return {text: el.textContent, action: button && !button.hidden ? button.textContent.trim() : null};
      });
      t.expect(f.text.includes(text) && f.action === action, `status "${text}" with ${action ?? 'no action'} (${JSON.stringify(f)})`);
    },
  })),
  {
    name: 'ed5-chart-new', url: HARNESS('part=none'), opts: {requires: PEER, devices: ['laptop'], themes: ['light']},
    async fn(page, t) {
      await page.waitForSelector('.chart-edit[data-state=ready]', {timeout: 30_000});
      await page.waitForTimeout(400);
      t.expect((await hits(page)) === 0, 'an empty part opens');
      await page.keyboard.press('KeyK');
      t.expect((await hits(page)) === 1, 'K writes the first kick');
    },
  },
  {
    name: 'ed5-chart-frame', url: HARNESS('frame=edit'), opts: {requires: FRAME, themes: ['light']},
    async fn(page, t) {
      await ready(page);
      const f = await page.evaluate(() => {
        const bar = document.querySelector('.edit-bar');
        const r = bar?.getBoundingClientRect();
        return {h: r ? Math.round(r.height) : null, border: bar ? getComputedStyle(bar).borderTopWidth : null, text: bar?.textContent ?? ''};
      });
      t.expect(f.h === 48 && f.border === '2px', `posture bar 48 px with a 2 px top border (${JSON.stringify(f)})`);
      t.expect(f.text.includes('Editing drum chart'), 'the label reads "Editing drum chart"');
      await page.evaluate(() => window.__chartEdit.setStatus('conflict'));
      await page.waitForTimeout(200);
      const bar = await page.evaluate(() => document.body.textContent.includes('Another version exists'));
      t.expect(bar, 'the save status shows in the posture bar');
      await t.capture('conflict');
    },
  },
];
