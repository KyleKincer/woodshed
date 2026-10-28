// Target-size probe (spec §8 "Minimum hit targets", architecture §10.3–10.4):
// every visible interactive target is at least 24×24 CSS px on fine pointers
// and 44×44 on coarse ones (WCAG 2.2), unless a stricter minimum applies
// (rules: [{selector, min}], e.g. the dock ≥ 56 and Play ≥ 72). Inline links
// in running text and anything inside [data-target-exempt] or [inert] are exempt.
// Adapted from the 1.9 critique probe for the runner; states call
//   const {checkTargets} = require('../probes/probe-targets.cjs');
//   t.expect(!(await checkTargets(page, {rules})).length, 'targets');
// and the CLI measures one URL (prints JSON; exit 1 when a target is too small, 2 on a setup error):
//   NODE_PATH=/opt/node-tools/node_modules node tests/fixture/probes/probe-targets.cjs --url <full url> [--device laptop|ipad]
'use strict';

const SELECTOR = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=slider], [role=switch], [role=checkbox], [role=radio], [role=spinbutton], label:has(input[type=checkbox]), label:has(input[type=radio])';
const FINE = 24, COARSE = 44;

/** Runs in the page: every visible interactive target, its size, and the strictest rule it matches. */
function measure({selector, rules}) {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const targets = [];
  for (const el of document.querySelectorAll(selector)) {
    if (el.checkVisibility && !el.checkVisibility({opacityProperty: true, visibilityProperty: true})) continue;
    if (el.closest('[inert], [data-target-exempt]')) continue;
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.parentElement && /\S/.test(el.parentElement.textContent.replace(el.textContent, ''))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const ruleMin = Math.max(0, ...rules.filter(rule => { try { return el.matches(rule.selector); } catch { return false; } }).map(rule => rule.min));
    const name = (el.getAttribute('aria-label') || el.textContent || el.id || el.getAttribute('type') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
    targets.push({name, tag: el.tagName.toLowerCase(), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, x: Math.round(r.x), y: Math.round(r.y), ruleMin});
  }
  return {coarse, targets};
}

/** Pure verdict: the targets below their minimum (the pointer's, or a stricter rule's). */
function tooSmall({coarse, targets}, {min} = {}) {
  const base = min ?? (coarse ? COARSE : FINE);
  return targets.flatMap(t => {
    const need = Math.max(base, t.ruleMin ?? 0);
    return t.w + 0.05 < need || t.h + 0.05 < need ? [{...t, min: need}] : [];
  });
}

/** Problems as strings ([] when every target is large enough). */
async function checkTargets(page, {min, rules = []} = {}) {
  const data = await page.evaluate(measure, {selector: SELECTOR, rules});
  return tooSmall(data, {min}).map(s => `target: "${s.name}" (${s.tag} at ${s.x},${s.y}) is ${s.w}×${s.h}, needs ${s.min}×${s.min}`);
}

async function cli(argv) {
  const {chromium} = require('playwright');
  const arg = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const url = arg('url'), device = arg('device') ?? 'laptop';
  if (!url) throw new Error('--url is required');
  const coarse = device === 'ipad';
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({viewport: coarse ? {width: 820, height: 1180} : {width: 1440, height: 900}, hasTouch: coarse});
    const page = await context.newPage();
    await page.goto(url, {waitUntil: 'load'});
    await page.waitForSelector('html[data-view-ready]', {state: 'attached', timeout: 30_000}).catch(() => {});
    const problems = await checkTargets(page);
    console.log(JSON.stringify({url, device, problems}, null, 1));
    return problems.length ? 1 : 0;
  } finally { await browser.close(); }
}

if (require.main === module) cli(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e.message); process.exit(2); });

module.exports = {SELECTOR, FINE, COARSE, measure, tooSmall, checkTargets};
