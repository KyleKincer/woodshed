// Structural checks run by the runner on every state (architecture §11.4):
//   overflow     no horizontal overflow of html, body or any [data-scroller]
//   overlap      no two visible, hit-testable interactive targets overlap, over the whole
//                page: targets below the fold are hit-tested after scrolling the window, and
//                every [data-scroller] (D26: where a place's content scrolls), to them (every
//                scroll position is restored). Targets compare within their frame (the window,
//                one [data-scroller], or fixed); across frames only as they were on screen at
//                the start. Targets clipped by a non-scroller container (a chip row) are clipped.
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
  const root = document.scrollingElement || doc;
  const scrolls = (el, axis) => {
    const cs = getComputedStyle(el), o = axis === 'y' ? cs.overflowY : cs.overflowX;
    return (o === 'auto' || o === 'scroll' || o === 'overlay') && (axis === 'y' ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1);
  };
  // The scrollers the scan steps through besides the window: every visible [data-scroller] that
  // can scroll (D26: html and body never scroll, so a place's content scrolls in its scroller).
  const inner = viewportOnly ? [] : [...document.querySelectorAll('[data-scroller]')].filter(el => el !== root && visible(el) && !ignored(el) && (scrolls(el, 'y') || scrolls(el, 'x')));
  // The scrollers that move `el` when they scroll, innermost first: its [data-scroller] ancestors
  // below the first fixed element, then the window when nothing fixed is in between.
  const movers = el => {
    const out = [];
    for (let a = el; a; a = a.parentElement) {
      if (a !== el && inner.includes(a)) out.push(a);
      if (getComputedStyle(a).position === 'fixed') return out;
    }
    out.push(root);
    return out;
  };
  // The visible part of `r` inside every clipping (overflow ≠ visible) ancestor of `el` (below
  // `upTo`, when given, and up to the first fixed one), in viewport coordinates.
  const clipToAncestors = (el, r, upTo = null) => {
    let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    for (let a = el.parentElement; a && a !== upTo && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const clipX = cs.overflowX !== 'visible', clipY = cs.overflowY !== 'visible';
      if (clipX || clipY) {
        const b = a.getBoundingClientRect();
        if (clipX) { x0 = Math.max(x0, b.left); x1 = Math.min(x1, b.right); }
        if (clipY) { y0 = Math.max(y0, b.top); y1 = Math.min(y1, b.bottom); }
      }
      // A fixed element clips what it holds; its own ancestors do not clip it.
      if (cs.position === 'fixed') break;
    }
    return {x0, y0, x1, y1};
  };
  const inViewport = c => ({x0: Math.max(0, c.x0), y0: Math.max(0, c.y0), x1: Math.min(vw, c.x1), y1: Math.min(vh, c.y1)});
  const empty = c => c.x1 - c.x0 < 1 || c.y1 - c.y0 < 1;
  // Hit-testable: the element (or something inside it) is on top at its middle or one of
  // its quarter points, so a target hidden under a modal is skipped but a partly covered one is not.
  const hitTestable = el => {
    const {x0, y0, x1, y1} = inViewport(clipToAncestors(el, el.getBoundingClientRect()));
    if (x1 - x0 < 1 || y1 - y0 < 1) return false;
    const onTop = (x, y) => { const hit = document.elementFromPoint(x, y); return !!hit && (el === hit || el.contains(hit) || (hit.contains(el) && hit.tagName === 'LABEL')); };
    const xs = [x0 + (x1 - x0) / 4, (x0 + x1) / 2, x1 - (x1 - x0) / 4], ys = [y0 + (y1 - y0) / 4, (y0 + y1) / 2, y1 - (y1 - y0) / 4];
    return xs.some(x => ys.some(y => onTop(x, y)));
  };
  const start = new Map([root, ...inner].map(s => [s, [s.scrollLeft, s.scrollTop]]));
  const frameOf = m => (m === undefined ? 'fixed' : m === root ? 'window' : `scroller:${inner.indexOf(m)}`);
  const candidates = [];
  for (const el of document.querySelectorAll(interactive)) {
    if (!visible(el) || ignored(el) || allows(el, 'overlap')) continue;
    const m = movers(el);
    // Clipped away by a container that scrolls with it (a chip row, a collapsed panel): never on screen.
    if (empty(clipToAncestors(el, el.getBoundingClientRect(), m[0]))) continue;
    candidates.push({el, movers: m, frame: frameOf(m[0]), accepted: false, rect: null, view: null});
  }
  // Each target is measured the first time it is on screen, in its frame's coordinates (where it
  // would be with every scroller back at its starting position, unclipped by those scrollers), so
  // targets of one frame measured at different scroll positions compare. Targets of different
  // frames (the window, a [data-scroller], fixed) compare only as they were on screen at the start.
  const tested = new Set();
  const pass = first => {
    for (const t of candidates) if (!tested.has(t)) {
      const r = t.el.getBoundingClientRect();
      const c = inViewport(clipToAncestors(t.el, r));
      if (empty(c)) continue;
      tested.add(t);
      t.accepted = hitTestable(t.el);
      const s = clipToAncestors(t.el, r, t.movers[0]);
      let dx = 0, dy = 0;
      for (const m of t.movers) { const [x0, y0] = start.get(m); dx += m.scrollLeft - x0; dy += m.scrollTop - y0; }
      t.rect = {x: s.x0 + dx, y: s.y0 + dy, w: s.x1 - s.x0, h: s.y1 - s.y0};
      if (first) t.view = {x: c.x0, y: c.y0, w: c.x1 - c.x0, h: c.y1 - c.y0};
    }
  };
  // The viewport at the current scroll position first, then (unless viewportOnly) the rest of the
  // page one screenful at a time: the window, and within each position every on-screen scroller
  // it holds (a scroller inside something fixed is stepped at each window position); every
  // scroll position is restored.
  pass(true);
  const done = () => candidates.every(t => tested.has(t));
  if (!viewportOnly && !done()) {
    const parent = new Map(inner.map(s => [s, movers(s)[0] ?? root]));
    const positions = (max, page) => {
      const out = [];
      for (let p = 0; p <= max && out.length < 60; p += Math.max(1, page - 40)) out.push(p);
      if (out[out.length - 1] !== max) out.push(max);
      return out;
    };
    const onScreen = el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw; };
    let budget = 600;
    const sweep = s => {
      const isRoot = s === root;
      const maxY = isRoot ? Math.max(0, root.scrollHeight - vh) : scrolls(s, 'y') ? s.scrollHeight - s.clientHeight : 0;
      const maxX = isRoot ? Math.max(0, root.scrollWidth - vw) : scrolls(s, 'x') ? s.scrollWidth - s.clientWidth : 0;
      const kids = inner.filter(k => parent.get(k) === s);
      steps: for (const y of positions(maxY, isRoot ? vh : s.clientHeight)) for (const x of positions(maxX, isRoot ? vw : s.clientWidth)) {
        if (done() || budget-- <= 0) break steps;
        s.scrollTo({left: x, top: y, behavior: 'instant'});
        pass(false);
        for (const k of kids) if (!done() && onScreen(k)) sweep(k);
      }
      const [x0, y0] = start.get(s);
      s.scrollTo({left: x0, top: y0, behavior: 'instant'});
    };
    sweep(root);
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
    targets: targets.map((t, i) => ({i, label: label(t.el), path: path(t.el), rect: t.rect, frame: t.frame, view: t.view})),
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

/** Pairs of overlapping targets, skipping nested pairs ([[i, j], …] indexes into `targets`).
 *  Targets of one frame (`frame`: 'window', 'fixed', 'scroller:N') compare by `rect`; targets of
 *  different frames compare by `view` (where they were on screen at the start), when both have one. */
function findOverlaps(targets, nested = []) {
  const skip = new Set(nested.map(([i, j]) => `${Math.min(i, j)}:${Math.max(i, j)}`));
  const out = [];
  for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
    if (skip.has(`${i}:${j}`)) continue;
    const a = targets[i], b = targets[j];
    const area = a.frame === b.frame ? overlapArea(a.rect, b.rect) : a.view && b.view ? overlapArea(a.view, b.view) : 0;
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
