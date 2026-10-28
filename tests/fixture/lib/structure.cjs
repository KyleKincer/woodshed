// Structural checks run by the runner on every state (architecture §11.4):
//   overflow     no horizontal overflow of html, body or any [data-scroller]
//   overlap      no two visible, hit-testable interactive targets overlap
//   clip         no clipped label: scrollWidth > clientWidth on buttons, chips and readouts
//   placeholder  no unexpected "Not built yet" (D2)
// The page side only measures (`collect`, run through page.evaluate); the
// verdicts are pure functions of those measurements (`analyse`), tested
// without a browser. An element opts out of one check with
// data-structure-allow="overlap|clip|overflow" (space-separated); a state opts
// out with opts.structure = {skip: ['clip'], allowClip: [selector], ignore: [selector], placeholder: true}.
'use strict';

const CHECKS = ['overflow', 'overlap', 'clip', 'placeholder'];
const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=slider], [role=switch], [role=checkbox], [role=radio], [role=spinbutton], [contenteditable=""], [contenteditable=true], [tabindex]:not([tabindex="-1"])';
const LABELLED = 'button, [role=button], [role=tab], [role=menuitem], [role=option], [data-chip], .chip, [class*="chip"], [data-readout], .readout, [class*="readout"]';
const PLACEHOLDER_TEXT = 'Not built yet';

/** Runs in the page: measurements only. Must stay self-contained (it is serialised). */
function collect({interactive, labelled, ignore = [], allowClip = [], placeholderText}) {
  const allows = (el, what) => !!el.closest(`[data-structure-allow~="${what}"]`);
  const within = (el, selectors) => selectors.some(sel => { try { return !!el.closest(sel); } catch { return false; } });
  const ignored = el => within(el, ignore);
  const label = el => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.id || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 60);
  const path = el => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
      let part = e.tagName.toLowerCase();
      if (e.id) part += `#${e.id}`;
      else if (e.classList.length) part += `.${[...e.classList].slice(0, 2).join('.')}`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const visible = el => {
    if (el.checkVisibility && !el.checkVisibility({opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true})) return false;
    if (el.closest('[inert]')) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  };
  const overflow = [];
  const doc = document.documentElement, body = document.body;
  if (doc.scrollWidth > doc.clientWidth + 1) overflow.push({target: 'html', scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth});
  if (body && body.scrollWidth > body.clientWidth + 1 && getComputedStyle(body).overflowX !== 'visible') overflow.push({target: 'body', scrollWidth: body.scrollWidth, clientWidth: body.clientWidth});
  for (const el of document.querySelectorAll('[data-scroller]')) {
    if (!visible(el) || allows(el, 'overflow') || ignored(el)) continue;
    if (el.scrollWidth > el.clientWidth + 1) overflow.push({target: path(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth});
  }

  const vw = innerWidth, vh = innerHeight;
  const targets = [];
  const all = [...document.querySelectorAll(interactive)];
  for (const el of all) {
    if (!visible(el) || ignored(el) || allows(el, 'overlap')) continue;
    const r = el.getBoundingClientRect();
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(vw, r.right), y1 = Math.min(vh, r.bottom);
    if (x1 - x0 < 1 || y1 - y0 < 1) continue;
    // Hit-testable: the element (or something inside it) is on top at its middle or one of
    // its quarter points, so a target hidden under a modal is skipped but a partly covered one is not.
    const onTop = (x, y) => { const hit = document.elementFromPoint(x, y); return !!hit && (el === hit || el.contains(hit) || (hit.contains(el) && hit.tagName === 'LABEL')); };
    const xs = [x0 + (x1 - x0) / 4, (x0 + x1) / 2, x1 - (x1 - x0) / 4], ys = [y0 + (y1 - y0) / 4, (y0 + y1) / 2, y1 - (y1 - y0) / 4];
    if (!xs.some(x => ys.some(y => onTop(x, y)))) continue;
    targets.push({el, rect: {x: r.left, y: r.top, w: r.width, h: r.height}});
  }
  const nested = [];
  for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
    const a = targets[i].el, b = targets[j].el;
    if (a.contains(b) || b.contains(a)) nested.push([i, j]);
  }
  const clipped = [];
  for (const el of document.querySelectorAll(labelled)) {
    if (!visible(el) || ignored(el) || allows(el, 'clip') || within(el, allowClip)) continue;
    if (el.scrollWidth > el.clientWidth + 1) clipped.push({label: label(el), path: path(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth});
  }
  let placeholder = false;
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length || !(el.textContent || '').includes(placeholderText)) continue;
    if (visible(el)) { placeholder = true; break; }
  }
  return {
    overflow,
    targets: targets.map((t, i) => ({i, label: label(t.el), path: path(t.el), rect: t.rect})),
    nested,
    clipped,
    placeholder,
  };
}

/** Intersection area of two {x, y, w, h} rects (0 when they only touch). */
function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 1 && h > 1 ? w * h : 0;
}

/** Pairs of overlapping targets, skipping nested pairs ([[i, j], …] indexes into `targets`). */
function findOverlaps(targets, nested = []) {
  const skip = new Set(nested.map(([i, j]) => `${Math.min(i, j)}:${Math.max(i, j)}`));
  const out = [];
  for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
    if (skip.has(`${i}:${j}`)) continue;
    const area = overlapArea(targets[i].rect, targets[j].rect);
    if (area) out.push({a: targets[i], b: targets[j], area: Math.round(area)});
  }
  return out;
}

/** The problems in one measurement, as strings. `opts` is the state's opts.structure. */
function analyse(data, opts = {}) {
  const skip = new Set(opts.skip ?? []);
  const problems = [];
  if (!skip.has('overflow')) for (const o of data.overflow) problems.push(`overflow: ${o.target} is ${o.scrollWidth}px wide in ${o.clientWidth}px`);
  if (!skip.has('overlap')) for (const o of findOverlaps(data.targets, data.nested)) problems.push(`overlap: "${o.a.label}" (${o.a.path}) and "${o.b.label}" (${o.b.path}) share ${o.area}px²`);
  if (!skip.has('clip')) for (const c of data.clipped) problems.push(`clip: "${c.label}" (${c.path}) needs ${c.scrollWidth}px, has ${c.clientWidth}px`);
  if (!skip.has('placeholder') && !opts.placeholder && data.placeholder) problems.push(`placeholder: "${PLACEHOLDER_TEXT}" is on screen`);
  return problems;
}

/** Measure the page and return the problems ([] when the state is clean). */
async function checkStructure(page, opts = {}) {
  for (const k of opts.skip ?? []) if (!CHECKS.includes(k)) throw new Error(`structure: unknown check ${JSON.stringify(k)} (known: ${CHECKS.join(', ')})`);
  const data = await page.evaluate(collect, {interactive: INTERACTIVE, labelled: LABELLED, ignore: opts.ignore ?? [], allowClip: opts.allowClip ?? [], placeholderText: PLACEHOLDER_TEXT});
  return analyse(data, opts);
}

module.exports = {CHECKS, INTERACTIVE, LABELLED, PLACEHOLDER_TEXT, collect, overlapArea, findOverlaps, analyse, checkStructure};
