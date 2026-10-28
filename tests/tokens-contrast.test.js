// @vitest-environment node
// Tokens (architecture §7.2, spec §8.3): the three colour sets match the
// contract table (or a recorded adjustment), meet the WCAG ratios in every set,
// and the Stage size tokens resolve to the contract values for each layout and
// Distance through the real cascade of tokens.css.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {parse, stripComments} from '../scripts/check-css.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tokensCss = readFileSync(path.join(root, 'src/styles/tokens.css'), 'utf8');
const architecture = readFileSync(path.join(root, 'docs/ux2/architecture.md'), 'utf8');

const SET_SELECTORS = {
  paper: ':root',
  night: ':root[data-theme=dark]',
  stage: ':root[data-place=stage][data-stage-theme=dark]',
};

/**
 * Values that failed the contrast test and were adjusted by the smallest HSL
 * lightness change that passes (§7.2). Each is recorded in tokens.css.
 */
const ADJUSTED = {
  'paper --now': {spec: '#c25700', value: '#b85200'},
};

const norm = v => v.trim().replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').toLowerCase();

// ---------- tokens.css as rules ----------

/** Top-level and @media rules: [{selectors: string[], media: string|null, decls: Map, order}]. */
function rulesOf(css) {
  const out = [];
  let order = 0;
  const visit = (items, media) => {
    for (const it of items) {
      if (it.type !== 'rule') continue;
      if (it.prelude.startsWith('@media')) { visit(it.children, it.prelude.slice(6).trim()); continue; }
      if (it.prelude.startsWith('@')) continue;
      const decls = new Map();
      for (const d of it.children) if (d.type === 'decl') decls.set(d.prop, d.value);
      out.push({selectors: it.prelude.split(',').map(s => s.trim()), media, decls, order: order++});
    }
  };
  visit(parse(stripComments(css)), null);
  return out;
}
const RULES = rulesOf(tokensCss);

/** The declarations of the rule whose whole selector is `selector` (no media), merged in order. */
function declsFor(selector, media = null) {
  const merged = new Map();
  for (const r of RULES) if (r.media === media && r.selectors.length === 1 && r.selectors[0] === selector) for (const [k, v] of r.decls) merged.set(k, v);
  return merged;
}

const COLOUR_TOKENS = name => !/^--(s\d|r-|h-|hit-|z-|shadow-|motion-|ease|font-|fs-|fw-|distance|lamp|rail-w|icon-)/.test(name);
function colourSet(name) {
  const decls = declsFor(SET_SELECTORS[name]);
  return new Map([...decls].filter(([k]) => COLOUR_TOKENS(k)));
}

// ---------- the contract table (§7.2) ----------

function contractTable() {
  const start = architecture.indexOf('### 7.2 Tokens');
  const end = architecture.indexOf('### 7.3 Fonts');
  const section = architecture.slice(start, end);
  const rows = {};
  for (const line of section.split('\n')) {
    const m = /^\| `(--[\w-]+)` \| (.+?) \| (.+?) \| (.+?) \|$/.exec(line.trim());
    if (!m) continue;
    const clean = v => v.replace(/\s*\(never used on the Stage\)/, '').trim();
    const paper = clean(m[2]);
    const night = clean(m[3]) === 'same' ? paper : clean(m[3]);
    const stage = clean(m[4]) === 'same' ? night : clean(m[4]);
    rows[m[1]] = {paper, night, stage};
  }
  const block = /\*\*Set-independent tokens:\*\*\s*```css\n([\s\S]*?)```/.exec(section)[1];
  const independent = new Map();
  const coarse = new Map();
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\/\*.*?\*\//g, '').trim();
    const target = line.startsWith('@media (pointer: coarse)') ? coarse : independent;
    for (const m of line.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) target.set(m[1], m[2].trim());
  }
  return {rows, independent, coarse};
}
const CONTRACT = contractTable();

// ---------- WCAG ----------

function rgbOf(value) {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return [...m[1]].map(c => parseInt(c + c, 16));
  throw new Error(`not an opaque hex colour: ${value}`);
}
function luminance(value) {
  const [r, g, b] = rgbOf(value).map(c => c / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The ratios of §7.2.
const PAIRS = [
  ...['--ink', '--ink-2', '--ink-3'].flatMap(fg => ['--bg', '--surface'].map(bg => ({fg, bg, min: 4.5, why: 'text'}))),
  {fg: '--on-accent', bg: '--accent-fill', min: 4.5, why: 'text on filled buttons'},
  {fg: '--now', bg: '--bg', min: 4.5, why: 'count-in and next readouts are text'},
  {fg: '--danger', bg: '--bg', min: 4.5, why: 'the failed line is text'},
  ...['--accent', '--loop', '--warn', '--ok'].map(fg => ({fg, bg: '--bg', min: 3, why: 'non-text'})),
  {fg: '--focus-ring', bg: '--bg', min: 3, why: 'focus indicator'},
];

describe('tokens: colour sets', () => {
  it('the contract table parses (sanity)', () => {
    expect(Object.keys(CONTRACT.rows).length).toBe(32);
    expect(CONTRACT.rows['--bg']).toEqual({paper: '#f6f5f0', night: '#121615', stage: '#08090a'});
  });

  for (const set of Object.keys(SET_SELECTORS)) {
    it(`${set}: defines exactly the §7.2 tokens with the §7.2 values (or a recorded adjustment)`, () => {
      const actual = colourSet(set);
      expect([...actual.keys()].sort()).toEqual(Object.keys(CONTRACT.rows).sort());
      for (const [token, values] of Object.entries(CONTRACT.rows)) {
        const want = values[set];
        const got = actual.get(token);
        const adj = ADJUSTED[`${set} ${token}`];
        if (adj && norm(want) === norm(adj.spec)) expect(norm(got), `${set} ${token} (recorded adjustment of ${adj.spec})`).toBe(norm(adj.value));
        else expect(norm(got), `${set} ${token}`).toBe(norm(want));
      }
    });
  }

  it('every recorded adjustment is documented in tokens.css', () => {
    for (const [key, {spec, value}] of Object.entries(ADJUSTED)) {
      const [set, token] = key.split(' ');
      expect(tokensCss).toContain(`${set} ${token}  ${spec} → ${value}`);
    }
  });

  for (const set of Object.keys(SET_SELECTORS)) {
    describe(`${set}: WCAG contrast`, () => {
      const values = colourSet(set);
      for (const {fg, bg, min, why} of PAIRS) {
        it(`${fg} on ${bg} ≥ ${min} (${why})`, () => {
          const ratio = contrast(values.get(fg), values.get(bg));
          expect(ratio, `${set} ${fg} ${values.get(fg)} on ${bg} ${values.get(bg)} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
        });
      }
    });
  }

  it('an adjusted value would have failed: the spec value is below its minimum', () => {
    const paper = colourSet('paper');
    expect(contrast(ADJUSTED['paper --now'].spec, paper.get('--bg'))).toBeLessThan(4.5);
  });

  it('contrast() matches known WCAG values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });
});

describe('tokens: set-independent', () => {
  const rootDecls = declsFor(':root');
  it('every §7.2 set-independent token is defined on :root with its contract value', () => {
    expect(CONTRACT.independent.size).toBeGreaterThan(60);
    for (const [token, want] of CONTRACT.independent) expect(norm(rootDecls.get(token) ?? 'MISSING'), token).toBe(norm(want));
  });

  it('coarse pointers get the larger control heights and handles', () => {
    const coarse = declsFor(':root', '(pointer: coarse)');
    expect(CONTRACT.coarse.size).toBe(5);
    for (const [token, want] of CONTRACT.coarse) expect(coarse.get(token), token).toBe(want);
  });

  it('icon stroke is 1.75 on desk places and 2 on the Stage (§7.4)', () => {
    expect(rootDecls.get('--icon-stroke')).toBe('1.75');
    expect(declsFor(':root[data-place=stage]').get('--icon-stroke')).toBe('2');
  });

  it('Stage handles take a 44px hit area on fine pointers too (spec §8.2 Stage column)', () => {
    expect(rootDecls.get('--hit-handle')).toBe('24px');
    expect(declsFor(':root[data-place=stage]').get('--hit-handle')).toBe('44px');
  });

  it('only tokens.css and fonts.css hold colour literals (guard)', async () => {
    const {checkCss} = await import('../scripts/check-css.mjs');
    expect(checkCss({root}).filter(v => v.rule === 'colour')).toEqual([]);
  });
});

// ---------- Stage sizes through the cascade ----------

/** Specificity of a simple selector made of :root and attribute selectors. */
function specificity(sel) {
  return (sel.match(/\[[^\]]+\]/g) || []).length + (sel.includes(':root') ? 1 : 0);
}
/** Does a simple selector match an element with `attrs` (isRoot says whether it is <html>)? */
function matches(sel, attrs, isRoot) {
  if (!/^(:root)?(\[[^\]]+\])*$/.test(sel)) return false;
  if (sel.startsWith(':root') !== isRoot) return false;
  for (const [, name, value] of sel.matchAll(/\[([\w-]+)(?:=([\w-]+))?\]/g)) {
    if (!(name in attrs)) return false;
    if (value !== undefined && attrs[name] !== value) return false;
  }
  return true;
}
/** Computed custom properties of an element (media queries other than none are ignored). */
function computed(attrs, isRoot, inherited) {
  const winners = new Map(inherited ? [...inherited].map(([k, v]) => [k, {v, rank: [-1, -1]}]) : []);
  for (const r of RULES) {
    if (r.media) continue;
    const spec = Math.max(-1, ...r.selectors.filter(s => matches(s, attrs, isRoot)).map(specificity));
    if (spec < 0) continue;
    for (const [k, v] of r.decls) {
      const cur = winners.get(k);
      if (!cur || spec > cur.rank[0] || (spec === cur.rank[0] && r.order >= cur.rank[1])) winners.set(k, {v, rank: [spec, r.order]});
    }
  }
  // var() resolves against this element's own computed values.
  const raw = new Map([...winners].map(([k, {v}]) => [k, v]));
  const resolve = (v, depth = 0) => v.replace(/var\((--[\w-]+)\)/g, (_, name) => {
    if (depth > 10 || !raw.has(name)) throw new Error(`unresolved ${name}`);
    return resolve(raw.get(name), depth + 1);
  });
  const out = new Map();
  for (const [k, v] of raw) out.set(k, /var\(/.test(v) ? resolve(v) : v);
  return out;
}
/** Evaluates max()/min()/calc() over px numbers → a number of px. */
function px(value) {
  const expr = value.replace(/calc\(/g, '(').replace(/(\d*\.?\d+)px/g, '$1');
  if (!/^[\d.\s+*/()-]*(max|min)?[\d.\s+*/(),maxin-]*$/.test(expr)) throw new Error(`cannot evaluate ${value}`);
  return Math.round(Function(`const max = Math.max, min = Math.min; return (${expr});`)() * 1000) / 1000;
}
function stageTokens({layout, distance, narrow = false, place = 'stage'}) {
  const rootAttrs = {'data-place': place, 'data-stage-theme': 'dark'};
  const rootValues = computed(rootAttrs, true, null);
  const attrs = {'data-stage-layout': layout};
  if (distance) attrs['data-distance'] = distance;
  if (narrow) attrs['data-rail-narrow'] = '';
  return computed(attrs, false, rootValues);
}

describe('tokens: Stage sizes per layout and Distance (§7.2, §10.4 probe-readouts values)', () => {
  const D = {near: 0.8, stand: 1, kit: 1.3};
  const position = {band: {near: 44, stand: 56, kit: 72}, rail: {near: 52, stand: 64, kit: 84}};
  const section = {near: 32, stand: 40, kit: 52};
  const railW = {near: 232, stand: 264, kit: 312};
  for (const layout of ['band', 'rail']) {
    for (const distance of ['near', 'stand', 'kit']) {
      it(`${layout} · ${distance}`, () => {
        const t = stageTokens({layout, distance});
        const d = D[distance];
        expect(Number(t.get('--distance'))).toBe(d);
        expect(px(t.get('--fs-stage-position'))).toBe(position[layout][distance]);
        expect(px(t.get('--fs-stage-section'))).toBe(section[distance]);
        expect(px(t.get('--fs-stage-identity'))).toBeCloseTo(Math.max(15, 15 * d), 5);
        expect(px(t.get('--fs-stage-sub'))).toBeCloseTo(Math.max(15, 17 * d), 5);
        expect(px(t.get('--fs-stage-loop'))).toBeCloseTo(Math.max(15, (layout === 'rail' ? 20 : 17) * d), 5);
        expect(px(t.get('--fs-stage-speed'))).toBeCloseTo(40 * d, 5);
        expect(px(t.get('--fs-stage-count'))).toBeCloseTo(120 * d, 5);
        expect(px(t.get('--lamp'))).toBeCloseTo((layout === 'rail' ? 20 : 18) * d, 5);
        expect(px(t.get('--h-dock'))).toBe(layout === 'rail' ? 56 : 64);
        expect(px(t.get('--h-play'))).toBe(layout === 'rail' ? 72 : 80);
        expect(px(t.get('--rail-w'))).toBe(railW[distance]);
        // Controls never scale with Distance.
        expect(t.get('--h-md')).toBe('40px');
      });
    }
  }

  it('a Stage root with no data-distance is Stand', () => {
    const t = stageTokens({layout: 'rail'});
    expect(px(t.get('--fs-stage-position'))).toBe(64);
    expect(px(t.get('--fs-stage-section'))).toBe(40);
    expect(px(t.get('--rail-w'))).toBe(264);
  });

  it('a narrow rail is 32 px slimmer at every Distance', () => {
    for (const [distance, w] of Object.entries(railW)) expect(px(stageTokens({layout: 'rail', distance, narrow: true}).get('--rail-w')), distance).toBe(w - 32);
    expect(px(stageTokens({layout: 'rail', narrow: true}).get('--rail-w'))).toBe(232);
  });

  it('the stage colour set applies only on a dark Stage', () => {
    expect(computed({'data-place': 'stage', 'data-stage-theme': 'dark'}, true, null).get('--bg')).toBe('#08090a');
    expect(computed({'data-place': 'stage', 'data-stage-theme': 'light'}, true, null).get('--bg')).toBe('#f6f5f0');
    expect(computed({'data-place': 'stage', 'data-stage-theme': 'light', 'data-theme': 'dark'}, true, null).get('--bg')).toBe('#121615');
    expect(computed({'data-place': 'library', 'data-theme': 'dark'}, true, null).get('--bg')).toBe('#121615');
  });
});
