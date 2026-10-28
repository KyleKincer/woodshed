// Structural checks run by the runner on every state (architecture §11.4):
//   overflow     no horizontal overflow of html, body or any [data-scroller]
//   overlap      no two visible, hit-testable interactive targets overlap, over the whole
//                page: targets below the fold are hit-tested after scrolling the window to
//                them (the scroll position is restored). Targets scrolled out of an inner
//                scroll container are clipped to it, so they are not compared.
//                opts.structure.viewportOnly = true checks the visible viewport only.
//   clip         no clipped label: scrollWidth > clientWidth on buttons, tabs, options, chips
//                and readouts. A chip or readout is [data-chip], [data-readout], or a class that
//                is `chip`/`readout`, ends in `-chip`/`_chip`/`-readout`/`_readout`, or is a
//                modifier of one (`chip--on`); containers such as `chips` or `chip-row` are not.
//   placeholder  no unexpected "Not built yet" (D2): any visible text node containing it,
//                whatever markup surrounds it
// The page side only measures (`collect`, run through page.evaluate); the
// verdicts are pure functions of those measurements (`analyse`), tested
// without a browser. An element opts out of one check with
// data-structure-allow="overlap|clip|overflow" (space-separated); a state opts
// out with opts.structure = {skip: ['clip'], allowClip: [selector], ignore: [selector], placeholder: true, viewportOnly: true}.
'use strict';

const CHECKS = ['overflow', 'overlap', 'clip', 'placeholder'];
const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=slider], [role=switch], [role=checkbox], [role=radio], [role=spinbutton], [contenteditable=""], [contenteditable=true], [tabindex]:not([tabindex="-1"])';
const LABELLED = 'button, [role=button], [role=tab], [role=menuitem], [role=option], [data-chip], [data-readout], [class*="chip"], [class*="readout"]';
/** Class tokens that name a chip or a readout itself (not a container of them). */
const LABEL_CLASS = '^(?:[\\w-]*[-_])?(?:chip|readout)(?:--[\\w-]+)?$';
const PLACEHOLDER_TEXT = 'Not built yet';

/** Runs in the page: measurements only. Must stay self-contained (it is serialised). */
function collect({interactive, labelled, labelClass, ignore = [], allowClip = [], placeholderText, viewportOnly = false}) {
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
  // The visible part of `r` inside every clipping (overflow ≠ visible) ancestor of `el`, in viewport coordinates.
  const clipToAncestors = (el, r) => {
    let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.position === 'fixed') break;
      const clipX = cs.overflowX !== 'visible', clipY = cs.overflowY !== 'visible';
      if (!clipX && !clipY) continue;
      const b = a.getBoundingClientRect();
      if (clipX) { x0 = Math.max(x0, b.left); x1 = Math.min(x1, b.right); }
      if (clipY) { y0 = Math.max(y0, b.top); y1 = Math.min(y1, b.bottom); }
    }
    return {x0, y0, x1, y1};
  };
  // Hit-testable: the element (or something inside it) is on top at its middle or one of
  // its quarter points, so a target hidden under a modal is skipped but a partly covered one is not.
  const hitTestable = el => {
    const c = clipToAncestors(el, el.getBoundingClientRect());
    const x0 = Math.max(0, c.x0), y0 = Math.max(0, c.y0), x1 = Math.min(vw, c.x1), y1 = Math.min(vh, c.y1);
    if (x1 - x0 < 1 || y1 - y0 < 1) return false;
    const onTop = (x, y) => { const hit = document.elementFromPoint(x, y); return !!hit && (el === hit || el.contains(hit) || (hit.contains(el) && hit.tagName === 'LABEL')); };
    const xs = [x0 + (x1 - x0) / 4, (x0 + x1) / 2, x1 - (x1 - x0) / 4], ys = [y0 + (y1 - y0) / 4, (y0 + y1) / 2, y1 - (y1 - y0) / 4];
    return xs.some(x => ys.some(y => onTop(x, y)));
  };
  const scroller = document.scrollingElement || doc;
  const startX = scroller.scrollLeft, startY = scroller.scrollTop;
  const candidates = [];
  for (const el of document.querySelectorAll(interactive)) {
    if (!visible(el) || ignored(el) || allows(el, 'overlap')) continue;
    const r = el.getBoundingClientRect();
    const c = clipToAncestors(el, r);
    if (c.x1 - c.x0 < 1 || c.y1 - c.y0 < 1) continue;
    // Page coordinates, so targets measured at different scroll positions compare
    // (fixed targets stay in viewport coordinates: they are compared with what is under them now).
    let fixed = false;
    for (let a = el; a; a = a.parentElement) if (getComputedStyle(a).position === 'fixed') { fixed = true; break; }
    const dx = fixed ? 0 : startX, dy = fixed ? 0 : startY;
    candidates.push({el, fixed, rect: {x: c.x0 + dx, y: c.y0 + dy, w: c.x1 - c.x0, h: c.y1 - c.y0}, accepted: false});
  }
  // The viewport at the current scroll position first, then (unless viewportOnly) the rest of
  // the page one viewport at a time.
  const tested = new Set();
  const pass = () => {
    for (const t of candidates) if (!tested.has(t)) {
      const r = t.el.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      tested.add(t);
      t.accepted = hitTestable(t.el);
    }
  };
  pass();
  const instant = (left, top) => { scroller.scrollTo({left, top, behavior: 'instant'}); };
  if (!viewportOnly && candidates.some(t => !tested.has(t))) {
    const maxY = Math.max(0, scroller.scrollHeight - vh), maxX = Math.max(0, scroller.scrollWidth - vw);
    const steps = [];
    for (let y = 0; y <= maxY && steps.length < 60; y += Math.max(1, vh - 40)) steps.push(y);
    if (steps[steps.length - 1] !== maxY && steps.length < 61) steps.push(maxY);
    for (const y of steps) for (let x = 0; x <= maxX; x += Math.max(1, vw - 40)) {
      if (candidates.every(t => tested.has(t))) break;
      instant(x, y);
      pass();
    }
    instant(startX, startY);
  }
  const targets = candidates.filter(t => t.accepted);
  const nested = [];
  for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
    const a = targets[i].el, b = targets[j].el;
    if (a.contains(b) || b.contains(a)) nested.push([i, j]);
  }
  const clipped = [];
  const labelToken = new RegExp(labelClass);
  const isLabelled = el => el.matches('button, [role=button], [role=tab], [role=menuitem], [role=option], [data-chip], [data-readout]') || [...el.classList].some(c => labelToken.test(c));
  for (const el of document.querySelectorAll(labelled)) {
    if (!isLabelled(el) || !visible(el) || ignored(el) || allows(el, 'clip') || within(el, allowClip)) continue;
    if (el.scrollWidth > el.clientWidth + 1) clipped.push({label: label(el), path: path(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth});
  }
  // Every text node, so the text is found whatever markup surrounds it (an icon, a link, a code span).
  let placeholder = false;
  if (document.body && (document.body.textContent || '').includes(placeholderText)) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script, style, template, noscript')) continue;
      // The text may be split across nodes ("Not built" + "yet"): test the parent's whole text too.
      if (!(node.data.includes(placeholderText) || (parent.textContent || '').replace(/\s+/g, ' ').includes(placeholderText))) continue;
      if (visible(parent)) { placeholder = true; break; }
    }
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
  const data = await page.evaluate(collect, {interactive: INTERACTIVE, labelled: LABELLED, labelClass: LABEL_CLASS, ignore: opts.ignore ?? [], allowClip: opts.allowClip ?? [], placeholderText: PLACEHOLDER_TEXT, viewportOnly: !!opts.viewportOnly});
  return analyse(data, opts);
}

module.exports = {CHECKS, INTERACTIVE, LABELLED, LABEL_CLASS, PLACEHOLDER_TEXT, collect, overlapArea, findOverlaps, analyse, checkStructure};
