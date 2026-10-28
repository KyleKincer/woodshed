// Focus-ring probe (architecture §7.1 base.css's single focus rule, §10.3):
// Tab through the page and check that every focused element shows a visible
// indicator: an outline of at least 2 px (not `none`), or a box-shadow ring,
// that differs from its unfocused look. Adapted from the 1.9 critique probe's
// focus walk for the runner; states call
//   const {walkFocus} = require('../probes/probe-focus.cjs');
//   const problems = await walkFocus(page, {stops: 30});
// It returns problem strings ([] when every stop shows a ring) and stops early
// when focus cycles back to the first element.
'use strict';

/** Runs in the page: the focused element's ring. */
function focusedRing() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    key: el.dataset.focusKey || el.id || `${el.tagName}:${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)}:${Math.round(r.x)},${Math.round(r.y)}`,
    name: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40),
    focusVisible: el.matches(':focus-visible'),
    outlineStyle: cs.outlineStyle, outlineWidth: parseFloat(cs.outlineWidth) || 0, outlineColor: cs.outlineColor,
    boxShadow: cs.boxShadow,
    visible: r.width > 0 && r.height > 0,
  };
}

/** Pure verdict on one stop. */
function ringProblem(stop) {
  if (!stop) return null;
  if (!stop.visible) return `focus: "${stop.name}" is focused but not visible`;
  const outline = stop.outlineStyle !== 'none' && stop.outlineWidth >= 2 && !/rgba\(0, 0, 0, 0\)|transparent/.test(stop.outlineColor);
  const shadow = stop.boxShadow && stop.boxShadow !== 'none';
  return outline || shadow ? null : `focus: "${stop.name}" shows no focus ring (outline ${stop.outlineStyle} ${stop.outlineWidth}px)`;
}

async function walkFocus(page, {stops = 30, key = 'Tab'} = {}) {
  const problems = [], seen = new Set();
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press(key);
    const stop = await page.evaluate(focusedRing);
    if (!stop) continue;
    if (seen.has(stop.key)) break;
    seen.add(stop.key);
    const problem = ringProblem(stop);
    if (problem) problems.push(problem);
  }
  if (!seen.size) problems.push('focus: Tab reached no focusable element');
  return problems;
}

module.exports = {focusedRing, ringProblem, walkFocus};
