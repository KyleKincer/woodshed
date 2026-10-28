// Accessibility probe (architecture §10.6, §11.5): injects axe-core 4.10.3 (the
// pinned devDependency, node_modules/axe-core/axe.min.js) into the page and runs
// it over the document (or `include`), WCAG 2.0/2.1/2.2 A and AA plus best
// practice. Every violation is a problem; an "incomplete" (needs review) result
// is a problem only for the rules in REVIEW_AS_VIOLATION, which axe can decide
// only partly but whose flagged nodes are real defects in this app (an aria-label
// on an element whose role prohibits naming is ignored by screen readers).
// States call
//   const {checkAxe} = require('../probes/probe-axe.cjs');
//   const problems = await checkAxe(page, {exclude: ['.lib-cover-art']});
//   t.expect(!problems.length, problems.join('; '));
// and the CLI checks one URL (prints JSON; exit 1 on a violation, 2 on a setup error):
//   NODE_PATH=/opt/node-tools/node_modules node tests/fixture/probes/probe-axe.cjs --url <full url> [--device laptop|ipad] [--theme light|dark]
// Options: include / exclude ([selector]), disable ([rule id]) for a rule a state
// deliberately waives (name the reason next to the call), tags (default TAGS),
// review (default REVIEW_AS_VIOLATION). Colour contrast is measured on the page
// as rendered, so run it after animations have settled.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../../..');
const AXE_PATH = path.join(REPO, 'node_modules/axe-core/axe.min.js');
const AXE_VERSION = '4.10.3';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const REVIEW_AS_VIOLATION = ['aria-prohibited-attr'];

let source = null;
/** axe-core's source, checked against the pinned version once per process. */
function axeSource(file = AXE_PATH) {
  if (source && file === AXE_PATH) return source;
  if (!fs.existsSync(file)) throw new Error(`probe-axe: ${path.relative(REPO, file)} is missing (axe-core@${AXE_VERSION} is a devDependency; run npm ci)`);
  const text = fs.readFileSync(file, 'utf8');
  const version = /axe v?(\d+\.\d+\.\d+)/.exec(text.slice(0, 400))?.[1];
  if (version !== AXE_VERSION) throw new Error(`probe-axe: expected axe-core ${AXE_VERSION}, found ${version ?? 'an unknown version'}`);
  if (file === AXE_PATH) source = text;
  return text;
}

/** Runs in the page: axe over the context, reduced to what the verdict needs. */
async function runAxe({include, exclude, tags, disable}) {
  const context = {};
  for (const s of include ?? []) if (!document.querySelector(s)) throw new Error(`probe-axe: nothing matches include ${s}`);
  if (include?.length) context.include = include.map(s => [s]);
  if (exclude?.length) context.exclude = exclude.map(s => [s]);
  const rules = Object.fromEntries((disable ?? []).map(id => [id, {enabled: false}]));
  const result = await window.axe.run(Object.keys(context).length ? context : document, {
    runOnly: {type: 'tag', values: tags}, rules, resultTypes: ['violations', 'incomplete'], iframes: false,
  });
  const slim = list => list.map(r => ({
    id: r.id, impact: r.impact, help: r.help,
    nodes: r.nodes.map(n => ({target: n.target.join(' '), html: n.html.slice(0, 160), summary: (n.failureSummary || '').replace(/\s+/g, ' ').trim().slice(0, 240)})),
  }));
  return {violations: slim(result.violations), incomplete: slim(result.incomplete), version: window.axe.version};
}

/** Pure verdict: problem strings for every violation, and for incomplete results of the `review` rules. */
function axeProblems({violations = [], incomplete = []}, {review = REVIEW_AS_VIOLATION} = {}) {
  const line = (kind, r) => r.nodes.map(n => `axe ${kind}: ${r.id} (${r.impact ?? 'n/a'}) ${r.help} at ${n.target}${n.summary ? ` (${n.summary})` : ''}`);
  return [
    ...violations.flatMap(r => line('violation', r)),
    ...incomplete.filter(r => review.includes(r.id)).flatMap(r => line('needs review', r)),
  ];
}

/** Inject axe (once per document) and return the problems ([] when the page is clean). */
async function checkAxe(page, {include = [], exclude = [], disable = [], tags = TAGS, review = REVIEW_AS_VIOLATION} = {}) {
  const has = await page.evaluate(() => !!window.axe?.run);
  if (!has) await page.addScriptTag({content: axeSource()});
  const result = await page.evaluate(runAxe, {include, exclude, tags, disable});
  if (result.version !== AXE_VERSION) throw new Error(`probe-axe: the page runs axe ${result.version}, expected ${AXE_VERSION}`);
  return axeProblems(result, {review});
}

async function cli(argv) {
  const {chromium} = require('playwright');
  const arg = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const url = arg('url'), device = arg('device') ?? 'laptop', theme = arg('theme') ?? 'light';
  if (!url) throw new Error('--url is required');
  const coarse = device === 'ipad';
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({viewport: coarse ? {width: 820, height: 1180} : {width: 1440, height: 900}, hasTouch: coarse, colorScheme: theme, reducedMotion: 'reduce'});
    const page = await context.newPage();
    await page.goto(url, {waitUntil: 'load'});
    await page.waitForSelector('html[data-view-ready], html[data-startup=signin]', {state: 'attached', timeout: 30_000}).catch(() => {});
    const problems = await checkAxe(page);
    console.log(JSON.stringify({url, device, theme, problems}, null, 1));
    return problems.length ? 1 : 0;
  } finally { await browser.close(); }
}

if (require.main === module) cli(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e.message); process.exit(2); });

module.exports = {AXE_PATH, AXE_VERSION, TAGS, REVIEW_AS_VIOLATION, axeSource, runAxe, axeProblems, checkAxe};
