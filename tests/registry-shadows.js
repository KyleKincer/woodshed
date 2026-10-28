// Allowed key shadowing for registry CI (architecture §3 "Shadowing", §10.1). A key may be bound in more than one scope of
// a reachable chain only when the pair is listed here. Keys a stop scope blocks without binding them are not shadowing.

export const S = 'stage';
export const SS = 'stage.stems';            // surface mode (D24)
export const SF = ['stage.strip', 'stage.bars'];   // focus scopes (D45)
export const E = 'edit';
export const EM = 'edit.map';
export const EC = 'edit.chart';
export const ECS = 'edit.chart.score';      // focus, stop scope (D18)
export const ED = 'edit.details';
export const L = 'library';
export const G = 'global';

/**
 * Every scope chain the dispatcher can resolve a key through, innermost first: focus scopes, the surface scope, the
 * posture scopes, the place scope and 'global' (§2.6 rules 6 and 9).
 */
export const REACHABLE_CHAINS = Object.freeze([
  ...[null, ...SF].flatMap(focus => [null, SS].map(surface => [focus, surface, S, G].filter(Boolean))),
  [EM, E, G],
  [EC, E, G],
  [ECS, EC, E, G],
  [ED, E, G],
  [L, G],
  ['settings', G],
  ['admin', G],
].map(chain => Object.freeze(chain)));

const DIGITS = Array.from({length: 10}, (_, i) => `Digit${i}`);

/**
 * {inner, outer, keys?, innerCommand?, why}: a key bound in an `inner` scope may shadow the same key in an `outer` scope of
 * the same chain when it is in `keys`, or when the inner command's id matches `innerCommand` (the remappable drum letters).
 */
export const ALLOWED_SHADOWS = Object.freeze([
  {inner: SF, outer: [S], keys: ['Enter', 'KeyL'], why: 'focus.play and focus.loop act on the focused section, marker or bar (D45)'},
  {inner: [SS], outer: [S], keys: ['=', '-', 'KeyF'], why: 'the Stems surface zooms with = and - and toggles Follow with F (D25)'},
  {inner: [ECS], outer: [EC, E], keys: [...DIGITS, '.', '=', '-', 'Escape'], why: 'score entry: steps, dotted, finer/coarser, clear selection'},
  {inner: [ECS], outer: [EC, E], innerCommand: /^chart\.piece\./, why: 'drum letters win inside the score surface (D18)'},
  {inner: [E], outer: [G], keys: ['Escape'], why: 'edit.done before app.escape'},
  // S over G: none today.
].map(entry => Object.freeze({...entry, inner: Object.freeze([...entry.inner]), outer: Object.freeze([...entry.outer])})));

/** True when `innerDef` binding `key` in scope `inner` may shadow the binding in scope `outer`. */
export function isAllowedShadow({inner, outer, key, innerDef}, allowed = ALLOWED_SHADOWS) {
  return allowed.some(entry => entry.inner.includes(inner) && entry.outer.includes(outer) &&
    ((entry.keys?.includes(key)) || (entry.innerCommand?.test(innerDef?.id ?? '') ?? false)));
}
