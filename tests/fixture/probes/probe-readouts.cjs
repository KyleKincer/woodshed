// Readout probe (architecture §10.4, §11.5): computed type and box sizes, table-driven.
// The Stage's Distance tables (Position 52/64/84 rail, 44/56/72 band; Section 32/40/52;
// dock width ≤ 700 px) are rows of this probe once the HUD exists (VF2); from wave 1 on
// the Library's spec sizes (§2.1–2.4) are rows too. States call
//   const {checkReadouts} = require('../probes/probe-readouts.cjs');
//   const problems = await checkReadouts(page, [
//     {name: 'hero title', selector: '.lib-hero-title', font: {size: 28, weight: 700}},
//     {name: 'Resume', selector: '.lib-hero-resume', box: {h: 48}},
//     {name: 'dock', selector: '.stage-dock', box: {maxW: 700}},
//   ]);
// A row: {name, selector, all = false (every visible match, else the first visible one),
//   optional = false (no visible match is not a problem), tolerance = 0.5 (px),
//   font: {size, weight, minSize, maxSize}, box: {w, h, minW, minH, maxW, maxH}}.
// Numbers are CSS px (weight is the numeric font-weight). The page side only
// measures (`measureReadouts`); the verdict (`readoutProblems`) is pure.
// The CLI measures one URL against a JSON rows file (exit 1 on a problem, 2 on a setup error):
//   NODE_PATH=/opt/node-tools/node_modules node tests/fixture/probes/probe-readouts.cjs --url <full url> --rows <rows.json> [--device laptop|ipad]
'use strict';

const FONT_KEYS = ['size', 'weight', 'minSize', 'maxSize'];
const BOX_KEYS = ['w', 'h', 'minW', 'minH', 'maxW', 'maxH'];

/** Throws on a malformed table (a typo must not pass silently). */
function validateRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new TypeError('probe-readouts: rows must be a non-empty array');
  for (const [i, row] of rows.entries()) {
    const at = `row ${i}${row?.name ? ` (${row.name})` : ''}`;
    if (!row || typeof row.name !== 'string' || !row.name) throw new TypeError(`probe-readouts: ${at} needs a name`);
    if (typeof row.selector !== 'string' || !row.selector) throw new TypeError(`probe-readouts: ${at} needs a selector`);
    if (!row.font && !row.box) throw new TypeError(`probe-readouts: ${at} checks neither font nor box`);
    for (const [group, keys] of [['font', FONT_KEYS], ['box', BOX_KEYS]]) {
      if (!row[group]) continue;
      for (const [k, v] of Object.entries(row[group])) {
        if (!keys.includes(k)) throw new TypeError(`probe-readouts: ${at}: unknown ${group} key ${k}`);
        if (!Number.isFinite(v)) throw new TypeError(`probe-readouts: ${at}: ${group}.${k} must be a number`);
      }
    }
  }
  return rows;
}

/** Runs in the page: for every row, the visible matches' computed font and box. */
function measureReadouts(rows) {
  const visible = el => {
    if (el.checkVisibility && !el.checkVisibility({opacityProperty: false, visibilityProperty: true})) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  };
  return rows.map(row => {
    let found = [];
    try { found = [...document.querySelectorAll(row.selector)].filter(visible); } catch (error) { return {name: row.name, error: String(error.message || error)}; }
    if (!row.all) found = found.slice(0, 1);
    return {
      name: row.name,
      items: found.map(el => {
        const cs = getComputedStyle(el), r = el.getBoundingClientRect();
        const label = (el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
        return {label, size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) || 400, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10};
      }),
    };
  });
}

/** Pure verdict: one problem string per value outside its row's expectation. */
function readoutProblems(measured, rows) {
  const problems = [];
  for (const [i, row] of rows.entries()) {
    const m = measured[i] ?? {items: []};
    if (m.error) { problems.push(`readout: ${row.name}: bad selector ${row.selector} (${m.error})`); continue; }
    if (!m.items.length) { if (!row.optional) problems.push(`readout: ${row.name}: nothing visible matches ${row.selector}`); continue; }
    const tol = row.tolerance ?? 0.5;
    for (const it of m.items) {
      const say = (what, got, want) => problems.push(`readout: ${row.name} "${it.label}" ${what} is ${got}, expected ${want}`);
      const f = row.font ?? {}, b = row.box ?? {};
      if (f.size !== undefined && Math.abs(it.size - f.size) > tol) say('font-size', `${it.size}px`, `${f.size}px`);
      if (f.minSize !== undefined && it.size + tol < f.minSize) say('font-size', `${it.size}px`, `≥ ${f.minSize}px`);
      if (f.maxSize !== undefined && it.size - tol > f.maxSize) say('font-size', `${it.size}px`, `≤ ${f.maxSize}px`);
      if (f.weight !== undefined && it.weight !== f.weight) say('font-weight', it.weight, f.weight);
      if (b.w !== undefined && Math.abs(it.w - b.w) > tol) say('width', `${it.w}px`, `${b.w}px`);
      if (b.h !== undefined && Math.abs(it.h - b.h) > tol) say('height', `${it.h}px`, `${b.h}px`);
      if (b.minW !== undefined && it.w + tol < b.minW) say('width', `${it.w}px`, `≥ ${b.minW}px`);
      if (b.minH !== undefined && it.h + tol < b.minH) say('height', `${it.h}px`, `≥ ${b.minH}px`);
      if (b.maxW !== undefined && it.w - tol > b.maxW) say('width', `${it.w}px`, `≤ ${b.maxW}px`);
      if (b.maxH !== undefined && it.h - tol > b.maxH) say('height', `${it.h}px`, `≤ ${b.maxH}px`);
    }
  }
  return problems;
}

/** Measure the page against `rows`; problem strings ([] when every readout matches). */
async function checkReadouts(page, rows) {
  validateRows(rows);
  const plain = rows.map(({name, selector, all}) => ({name, selector, all: !!all}));
  return readoutProblems(await page.evaluate(measureReadouts, plain), rows);
}

async function cli(argv) {
  const fs = require('node:fs');
  const {chromium} = require('playwright');
  const arg = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const url = arg('url'), file = arg('rows'), device = arg('device') ?? 'laptop';
  if (!url || !file) throw new Error('--url and --rows are required');
  const rows = validateRows(JSON.parse(fs.readFileSync(file, 'utf8')));
  const coarse = device === 'ipad';
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({viewport: coarse ? {width: 820, height: 1180} : {width: 1440, height: 900}, hasTouch: coarse});
    const page = await context.newPage();
    await page.goto(url, {waitUntil: 'load'});
    await page.waitForSelector('html[data-view-ready]', {state: 'attached', timeout: 30_000}).catch(() => {});
    const problems = await checkReadouts(page, rows);
    console.log(JSON.stringify({url, device, problems}, null, 1));
    return problems.length ? 1 : 0;
  } finally { await browser.close(); }
}

if (require.main === module) cli(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e.message); process.exit(2); });

module.exports = {validateRows, measureReadouts, readoutProblems, checkReadouts};
