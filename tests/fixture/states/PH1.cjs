// PH1's states: the app on a phone (393×852, touch), and a phone on its side (852×393). Nothing is cut off, nothing
// sits on top of anything else.
//   ph1-stage        the Stage: every control in the dock is on screen (two rows); the section name is whole and
//                    the readouts don't overlap
//   ph1-landscape    a phone on its side: the music keeps at least a line of the chart (150 px)
//   ph1-mix          the Mix sheet fits the phone's width; Click & count-in's wrapped choice is a card
//   ph1-edit         Edit · Chart: the tabs clear Done; the toolbar is one row; every kit pad shows its whole name
//   ph1-library      the Library: the search folds to a magnifier and opens across the top bar on a tap
//   ph1-add          Add a song: the link field gets a whole line
'use strict';

const Q = 'fx-reset=1&fx-jobs=0&fx-now=2026-10-28T12:00:00Z&fx-platform=ipad';
const PHONE = {width: 393, height: 852};
const ON_PHONE = {devices: ['ipad'], themes: ['dark']};

const rect = (page, sel) => page.evaluate((s) => {
  const r = document.querySelector(s)?.getBoundingClientRect();
  return r ? {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)} : null;
}, sel);
const apart = (a, b) => a.x + a.w <= b.x + 1 || b.x + b.w <= a.x + 1 || a.y + a.h <= b.y + 1 || b.y + b.h <= a.y + 1;

module.exports = [
  {
    name: 'ph1-stage', url: `/s/lowtide?${Q}`, opts: {ready: 'stage', ...ON_PHONE},
    async fn(page, t) {
      await page.setViewportSize(PHONE);
      await t.loadPhase('ready');
      await page.waitForTimeout(400);
      const off = await page.evaluate(() => [...document.querySelectorAll('.stage-controls [data-ctl]')]
        .map((c) => ({id: c.dataset.ctl, r: c.getBoundingClientRect()}))
        .filter(({r}) => r.left < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1)
        .map(({id, r}) => `${id} ${Math.round(r.left)}–${Math.round(r.right)}`));
      t.expect(!off.length, `every control on screen (${off.join(', ')})`);
      const section = await page.evaluate(() => {
        const l = document.querySelector('.hud-section-layer:not([data-state=out])');
        return l ? {text: l.textContent, cut: l.scrollWidth > l.clientWidth + 1} : null;
      });
      t.expect(section && !section.cut, `the section name is whole (${JSON.stringify(section)})`);
      const cells = await Promise.all(['.hud-cell-section', '.hud-cell-position', '.hud-cell-speed', '.hud-cell-loop'].map((s) => rect(page, s)));
      const pairs = [[0, 1], [0, 2], [1, 2], [1, 3], [2, 3]].filter(([a, b]) => cells[a]?.w && cells[b]?.w && !apart(cells[a], cells[b]));
      t.expect(!pairs.length, `the readouts don't overlap (${JSON.stringify(cells)})`);
      await t.capture('stage');
    },
  },
  {
    name: 'ph1-landscape', url: `/s/glasshouse?${Q}`, opts: {ready: 'stage', ...ON_PHONE},
    async fn(page, t) {
      await page.setViewportSize({width: PHONE.height, height: PHONE.width});
      await t.loadPhase('ready');
      await page.waitForTimeout(400);
      const music = await rect(page, '.stage-music');
      t.expect(music.h >= 150, `the music keeps a line of the chart (${music.h} px)`);
      await t.capture('landscape');
    },
  },
  {
    name: 'ph1-mix', url: `/s/lowtide?${Q}`, opts: {ready: 'stage', ...ON_PHONE},
    async fn(page, t) {
      await page.setViewportSize(PHONE);
      await t.loadPhase('ready');
      await page.locator('.ctl-mix-caret').click();
      await page.waitForSelector('.sheet-mix', {timeout: 5_000});
      await page.waitForTimeout(500);
      const over = await page.evaluate(() => [...document.querySelectorAll('.sheet-mix, .sheet-mix > *, .sheet-mix-pads > *')]
        .filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.className));
      t.expect(!over.length, `the Mix sheet fits the width (${over.join(', ')})`);
      await t.capture('mix');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      await page.locator('[data-ctl=countIn] .ui-button').click({button: 'right'});
      await page.waitForSelector('.ui-segmented-options', {timeout: 5_000});
      await page.waitForTimeout(400);
      const wrapped = await page.evaluate(() => [...document.querySelectorAll('[data-sheet] .ui-segmented-options')].some((r) => r.hasAttribute('data-wrapped')));
      t.expect(wrapped, 'the wrapped Count-in choice is a card ([data-wrapped])');
      await t.capture('count-in');
    },
  },
  {
    name: 'ph1-edit', url: `/s/glasshouse/edit/chart?${Q}`, opts: {ready: 'edit', ...ON_PHONE},
    async fn(page, t) {
      await page.setViewportSize(PHONE);
      await page.waitForSelector('.chart-bank-pad', {timeout: 15_000});
      await page.waitForTimeout(500);
      const done = await rect(page, '.edit-done');
      const tabs = await page.evaluate(() => [...document.querySelectorAll('.edit-tabs [role=tab]')].map((e) => {
        const r = e.getBoundingClientRect();
        return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
      }));
      t.expect(tabs.length === 3 && tabs.every((r) => apart(r, done)), `the tabs clear Done (${JSON.stringify({done, tabs})})`);
      const bar = await rect(page, '.chart-toolbar');
      t.expect(bar.h <= 60, `the toolbar is one row (${bar.h} px)`);
      const cut = await page.evaluate(() => [...document.querySelectorAll('.chart-bank-pad .ui-button-label')]
        .filter((l) => l.scrollWidth > l.clientWidth + 1).map((l) => l.textContent));
      t.expect(!cut.length, `every pad shows its whole name (${cut.join(', ')})`);
      await t.capture('edit');
    },
  },
  {
    name: 'ph1-library', url: `/?${Q}`, opts: {ready: 'library', ...ON_PHONE},
    async fn(page, t) {
      await page.setViewportSize(PHONE);
      await page.waitForTimeout(400);
      const folded = await rect(page, '.shell-search');
      t.expect(folded.w <= 48, `the search folds to a magnifier (${folded.w} px)`);
      await t.capture('library');
      await page.locator('.shell-search-input').tap();
      await page.waitForTimeout(200);
      const open = await rect(page, '.shell-search'), bar = await rect(page, '.shell-topbar');
      t.expect(open.w >= bar.w - 2, `a tap opens it across the bar (${open.w} of ${bar.w})`);
      await t.capture('search');
    },
  },
  {
    name: 'ph1-add', url: `/add?${Q}`, opts: {ready: 'add', ...ON_PHONE},
    async fn(page, t) {
      await page.setViewportSize(PHONE);
      await page.waitForSelector('.lib-add-input', {timeout: 10_000});
      await page.waitForTimeout(300);
      const input = await rect(page, '.lib-add-input');
      t.expect(input.w >= 280, `the link field gets a whole line (${input.w} px)`);
      const choose = await page.evaluate(() => document.querySelector('.lib-add-choose')?.hidden);
      t.expect(choose === true, 'no dead Choose files… button on a touch screen');
      await t.capture('add');
    },
  },
];
