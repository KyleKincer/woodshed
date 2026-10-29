// Pure verdicts for the VF1 spec checks (tests/fixture/flows/VF1.cjs), kept apart from the
// browser code so vf1-probes.test.js can exercise them in Node.
'use strict';

/**
 * Spec §8.1: 12 px anywhere, 14 px in coarse-pointer chrome; overlines (12/600 caps) are allowed at 12.
 * "Chrome" is read as the controls a finger operates (buttons, links, menu items, tabs, options,
 * fields): the spec itself sets some content text at 12 on every device (the Jobs popover's
 * `job.message` "in 12 --ink-3", §2.8), so the coarse floor does not apply to prose.
 */
const TYPE_FLOOR = 12, COARSE_FLOOR = 14;
/** The cover veil renders the art at 55% (spec §2.4). The pixel fit is exact in practice. */
const VEIL_ALPHA = 0.55, VEIL_TOLERANCE = 0.02;

const isOverline = f => f.transform === 'uppercase' && f.weight >= 600 && f.size >= TYPE_FLOOR;

/** The type floor for one text fact: {size, weight, transform, control} on a fine or coarse device. */
function typeFloor(fact, {coarse = false} = {}) {
  return coarse && fact.control && !isOverline(fact) ? COARSE_FLOOR : TYPE_FLOOR;
}

/** What counts as coarse-pointer chrome: text inside a control. */
const CONTROL = 'button, a[href], input, select, textarea, summary, [role=button], [role=link], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=option], [role=radio], [role=checkbox], [role=switch]';

/** Problems for the text facts textFacts() collects in the page (spec §8.1). */
function typeProblems(facts, {coarse = false} = {}) {
  const out = [];
  for (const f of facts) {
    const floor = typeFloor(f, {coarse});
    if (f.size < floor) out.push(`type below ${floor}px: ${f.size}px "${f.text}" (${f.cls})`);
  }
  return [...new Set(out)];
}

/**
 * Runs in the page: size, weight and case of every visible text node outside the Stage.
 * [data-volatile] text is included (the mask only matters to captures).
 */
function textFacts(control = CONTROL) {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !n.textContent.trim() || el.closest('[aria-hidden=true], .sr-only, .visually-hidden, svg')) continue;
    if (el.checkVisibility && !el.checkVisibility({visibilityProperty: true, opacityProperty: true})) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    out.push({size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) || 400, transform: cs.textTransform,
      control: !!el.closest(control), text: n.textContent.trim().slice(0, 30), cls: String(el.className || el.tagName)});
  }
  return out;
}

/**
 * The cover-veil verdict from [{key, state, alpha|null, missing?}]: every measured alpha within
 * ±VEIL_TOLERANCE of 55%, and at least one processing (job:) and one re-splitting (song:) card measured.
 */
function veilProblems(measured) {
  const problems = [];
  for (const m of measured) {
    if (m.missing) problems.push(`${m.key} has no .lib-card-cover to measure`);
    else if (m.alpha != null && Math.abs(m.alpha - VEIL_ALPHA) > VEIL_TOLERANCE + 1e-9)
      problems.push(`${m.key} (${m.state}) renders its cover at ${Math.round(m.alpha * 100)}%, expected 55%`);
  }
  const ok = prefix => measured.some(m => m.key.startsWith(prefix) && m.alpha != null && !m.missing);
  if (!ok('job:')) problems.push('veil not measurable: no processing (job:) card gave an alpha');
  if (!ok('song:')) problems.push('veil not measurable: no re-splitting (song:) card gave an alpha');
  return problems;
}

/** The compact recents verdict (spec §2.2) from [{title, text, lines, missing?}]. */
function recentsProblems(recents) {
  return recents.flatMap(r => {
    if (r.missing) return [`"${r.title}" has no .lib-compact-line state line`];
    const shown = r.text.replace(/\n/g, '⏎');
    return [
      ...(r.lines > 1 || /\n/.test(r.text) ? [`"${r.title}" shows its state on ${r.lines} lines ("${shown}"); spec §2.2 wants one state line`] : []),
      ...(/·/.test(r.text) && /practised/.test(r.text) ? [] : [`"${r.title}" state line "${shown}" is not joined with " · " like the hero's`]),
    ];
  });
}

module.exports = {TYPE_FLOOR, COARSE_FLOOR, CONTROL, VEIL_ALPHA, VEIL_TOLERANCE, typeFloor, typeProblems, textFacts, veilProblems, recentsProblems};
