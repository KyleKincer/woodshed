// Focus-ring probe (architecture §7.1 base.css's single focus rule, §10.3):
// Tab through the page and check that every focused element shows a visible
// indicator: an outline of at least 2 px (not `none`), or a box-shadow ring,
// that differs from its unfocused look. The unfocused look is measured on the
// same element right after Tab moves focus away from it (nothing is blurred or
// re-focused by script, so menus and popovers stay as the keyboard left them).
// A resting shadow (a card, a raised button) is therefore not a ring.
// Adapted from the 1.9 critique probe's focus walk for the runner; states call
//   const {walkFocus} = require('../probes/probe-focus.cjs');
//   const problems = await walkFocus(page, {stops: 30});
// It returns problem strings ([] when every stop shows a ring) and stops early
// when focus cycles back to the first element.
'use strict';

/**
 * Runs in the page: the focused element's look, plus the look the previously
 * focused element has now that it lost focus (`prevRest`, null when unknown).
 */
function focusedRing() {
  const look = node => { const cs = getComputedStyle(node); return {outlineStyle: cs.outlineStyle, outlineWidth: parseFloat(cs.outlineWidth) || 0, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow}; };
  const el = document.activeElement;
  const prev = window.__fxFocusPrev;
  const focused = el && el !== document.body && el !== document.documentElement ? el : null;
  const prevRest = prev && prev !== focused && prev.isConnected ? look(prev) : null;
  window.__fxFocusPrev = focused;
  if (!focused) return prevRest ? {none: true, prevRest} : null;
  const r = focused.getBoundingClientRect();
  return {
    key: focused.dataset.focusKey || focused.id || `${focused.tagName}:${(focused.getAttribute('aria-label') || focused.textContent || '').trim().slice(0, 40)}:${Math.round(r.x)},${Math.round(r.y)}`,
    name: (focused.getAttribute('aria-label') || focused.textContent || focused.tagName).trim().replace(/\s+/g, ' ').slice(0, 40),
    focusVisible: focused.matches(':focus-visible'),
    ...look(focused),
    visible: r.width > 0 && r.height > 0,
    prevRest,
  };
}

const hasOutline = s => s.outlineStyle !== 'none' && s.outlineWidth >= 2 && !/rgba\(0, 0, 0, 0\)|transparent/.test(s.outlineColor);
const hasShadow = s => !!s.boxShadow && s.boxShadow !== 'none';

/**
 * Pure verdict on one stop. `rest` is the same element's unfocused look: when it is
 * known, an outline or shadow counts only when focus changed it.
 */
function ringProblem(stop, rest = null) {
  if (!stop) return null;
  if (!stop.visible) return `focus: "${stop.name}" is focused but not visible`;
  let outline = hasOutline(stop), shadow = hasShadow(stop);
  if (rest) {
    if (outline && hasOutline(rest) && rest.outlineStyle === stop.outlineStyle && rest.outlineWidth >= stop.outlineWidth && rest.outlineColor === stop.outlineColor) outline = false;
    if (shadow && rest.boxShadow === stop.boxShadow) shadow = false;
  }
  if (outline || shadow) return null;
  return rest && (hasOutline(stop) || hasShadow(stop))
    ? `focus: "${stop.name}" looks the same focused and unfocused (outline ${stop.outlineStyle} ${stop.outlineWidth}px, box-shadow ${stop.boxShadow})`
    : `focus: "${stop.name}" shows no focus ring (outline ${stop.outlineStyle} ${stop.outlineWidth}px)`;
}

async function walkFocus(page, {stops = 30, key = 'Tab'} = {}) {
  const problems = [], seen = new Set();
  let pending = null;
  const settle = step => {
    if (!pending) return;
    const problem = ringProblem(pending, step?.prevRest ?? null);
    if (problem) problems.push(problem);
    pending = null;
  };
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press(key);
    const stop = await page.evaluate(focusedRing);
    settle(stop);
    if (!stop || stop.none) continue;
    if (seen.has(stop.key)) break;
    seen.add(stop.key);
    pending = stop;
  }
  if (pending) {
    // The stop limit was reached on a focused element: one more Tab measures its unfocused look.
    await page.keyboard.press(key);
    settle(await page.evaluate(focusedRing));
  }
  if (!seen.size) problems.push('focus: Tab reached no focusable element');
  return problems;
}

module.exports = {focusedRing, ringProblem, walkFocus};
