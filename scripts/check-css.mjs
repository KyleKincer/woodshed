#!/usr/bin/env node
// CSS guard (architecture §7.6; run by tests/guards.test.js under npm test).
//
//   node scripts/check-css.mjs [--json]      scan the repository, exit 1 on any violation
//
// Rules for every stylesheet under src/styles/ except tokens.css and fonts.css
// (the only files with colour literals and font families):
//   colour       no #hex, rgb(), rgba(), hsl(), hsla(), color-mix(), white or black
//                (transparent, currentColor and inherit are fine)
//   z-index      only var(--z-*) or auto
//   radius       border-radius (and its longhands) only var(--r-*) or 0
//   important    !important only in reset.css and utilities.css
//   font-size    font-size and the font shorthand only through var(--fs-*), inherit,
//                or em/%/rem; never px
//   font-family  only var(--font-ui) or var(--font-mono) (or inherit)
//   layer        a primitive file (src/styles/primitives/**) is exactly one
//                `@layer primitives { … }` block, a view file (src/styles/views/**)
//                exactly one `@layer views { … }` block
//   main         main.css starts with the layer order statement of §7.1
//   placement    a stylesheet directly under src/styles/ is one of the seven core files
//   location     no stylesheet outside src/styles/ (activates at integration I3a, see
//                ACTIVATION; src/js/notation/notation.css is exempt until ED5 deletes it)
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Activation points (§9.2 F1, §9.15 I3a). Integration I3a sets
 * `cssLocation: true`; ED5 deletes notation.css and I3a removes the exemption.
 */
export const ACTIVATION = {
  cssLocation: false,
};

/** Dated exemption for the location rule (D1): removed by I3a once ED5 has deleted the file. */
export const LOCATION_EXEMPT = ['src/js/notation/notation.css'];

export const STYLES_DIR = 'src/styles';
export const CORE_FILES = ['main.css', 'reset.css', 'tokens.css', 'fonts.css', 'base.css', 'layout.css', 'utilities.css'];
export const COLOUR_FILES = ['src/styles/tokens.css', 'src/styles/fonts.css'];
export const IMPORTANT_FILES = ['src/styles/reset.css', 'src/styles/utilities.css'];
export const LAYER_ORDER = '@layer reset, tokens, base, primitives, layout, views, utilities;';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'release', 'release-assets', 'artifacts', 'coverage', '.vite', '.vite-cache', 'out']);

// ---------- parsing ----------

/** Replaces comments with spaces (keeping newlines, so offsets and lines stay valid). */
export function stripComments(css) {
  let out = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      const j = endOfString(css, i);
      out += css.slice(i, j);
      i = j - 1;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const j = end < 0 ? css.length : end + 2;
      out += css.slice(i, j).replace(/[^\n]/g, ' ');
      i = j - 1;
    } else out += c;
  }
  return out;
}

function endOfString(s, i) {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === q || s[j] === '\n') return j + 1;
  }
  return s.length;
}

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

/**
 * Parses comment-free CSS into a tree:
 *   {type: 'rule', prelude, start, children}   a qualified rule or block at-rule
 *   {type: 'decl', prop, value, important, start}
 *   {type: 'statement', text, start}           @import, @layer a, b; …
 */
export function parse(css) {
  let i = 0;
  function block(depthEnd) {
    const items = [];
    while (i < css.length) {
      while (i < css.length && /\s/.test(css[i])) i++;
      if (i >= css.length) break;
      if (css[i] === '}') { if (depthEnd) { i++; return items; } i++; continue; }
      const start = i;
      let paren = 0;
      let stop = null;
      for (; i < css.length; i++) {
        const c = css[i];
        if (c === '"' || c === "'") { i = endOfString(css, i) - 1; continue; }
        if (c === '(') paren++;
        else if (c === ')') paren = Math.max(0, paren - 1);
        else if (paren === 0 && (c === '{' || c === ';' || c === '}')) { stop = c; break; }
      }
      const text = css.slice(start, i).trim();
      if (stop === '{') {
        i++;
        items.push({type: 'rule', prelude: text, start, children: block(true)});
      } else {
        if (stop === ';') i++;
        if (text) items.push(toDecl(text, start));
        // a '}' is handled at the top of the loop
      }
    }
    return items;
  }
  return block(false);
}

function toDecl(text, start) {
  if (text.startsWith('@')) return {type: 'statement', text, start};
  const colon = text.indexOf(':');
  if (colon < 0) return {type: 'statement', text, start};
  const prop = text.slice(0, colon).trim().toLowerCase();
  let value = text.slice(colon + 1).trim();
  const important = /!\s*important\s*$/i.test(value);
  if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
  return {type: 'decl', prop, value, important, start};
}

function* walk(items) {
  for (const it of items) {
    yield it;
    if (it.type === 'rule') yield* walk(it.children);
  }
}

// ---------- value checks ----------

/** Removes var(--name) references and quoted strings from a value (they cannot be literals). */
const withoutVarsAndStrings = v => v.replace(/(["'])(?:\\.|(?!\1).)*\1/g, ' ').replace(/var\(\s*--[\w-]+/g, ' var(');

export function colourLiteral(value) {
  const v = withoutVarsAndStrings(value);
  const hex = /(^|[^\w-])#([0-9a-f]{3,8})\b/i.exec(v);
  if (hex && [3, 4, 6, 8].includes(hex[2].length)) return `#${hex[2]}`;
  const fn = /\b(rgba?|hsla?|color-mix|hwb|lab|lch|oklab|oklch|color)\(/i.exec(v);
  if (fn) return `${fn[1]}(`;
  const kw = /(^|[^\w-])(white|black)(?![\w-])/i.exec(v);
  if (kw) return kw[2];
  return null;
}

const RADIUS_PROPS = /^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/;
const RADIUS_PART = /^(var\(--r-[\w-]+\)|0)$/;
export function radiusOk(value) {
  const parts = value.replace(/\s*\/\s*/g, ' ').trim().split(/\s+/);
  return parts.length > 0 && parts.every(p => RADIUS_PART.test(p));
}

export function zIndexOk(value) {
  return /^(var\(--z-[\w-]+\)|auto)$/.test(value.trim());
}

const SIZE_UNIT = /^-?(\d+\.?\d*|\.\d+)(em|rem|%)$/;
export function fontSizeOk(value) {
  const v = value.trim();
  if (/\d(\.\d+)?px\b/i.test(v) || /\b\d+(\.\d+)?(pt|pc|cm|mm|in|q|vw|vh|vmin|vmax|dvh|svh|lvh|cqw|cqh)\b/i.test(v)) return false;
  if (v === 'inherit' || SIZE_UNIT.test(v)) return true;
  if (/^var\(--fs-[\w-]+\)$/.test(v)) return true;
  // calc()/max()/min()/clamp() built only from --fs-* tokens and em/rem/% numbers.
  if (/^(calc|max|min|clamp)\(/.test(v)) {
    const rest = v.replace(/var\(--fs-[\w-]+\)/g, '').replace(/-?(\d+\.?\d*|\.\d+)(em|rem|%)?/g, '').replace(/\b(calc|max|min|clamp)\(/g, '').replace(/[()\s*+/,-]/g, '');
    return rest === '';
  }
  return false;
}

const FAMILY_OK = /^(var\(--font-(ui|mono)\)|inherit)$/;
export function fontFamilyOk(value) { return FAMILY_OK.test(value.trim()); }

/** The font shorthand: inherit, or a size from fontSizeOk (any line-height) and a family from var(--font-ui|mono). */
export function fontShorthandOk(value) {
  const v = value.trim();
  if (['inherit', 'initial', 'unset', 'revert', 'revert-layer'].includes(v)) return true;
  if (/["']/.test(v)) return false;
  // Only the size is checked for px (fontSizeOk below); a px line-height after '/' is allowed.
  if (!/var\(--font-(ui|mono)\)\s*$/.test(v)) return false;
  const beforeFamily = v.replace(/var\(--font-(ui|mono)\)\s*$/, '').trim();
  const tokens = beforeFamily.split(/\s+/).filter(Boolean);
  const sizeToken = tokens.map(t => t.split('/')[0]).reverse().find(t => /^var\(--fs-|^-?[\d.]+(em|rem|%)$|^inherit$/.test(t));
  if (!sizeToken) return false;
  // Everything before the size is style/variant/weight.
  const allowed = /^(normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00|var\(--fw-[\w-]+\)|var\(--fs-[\w-]+\)(\/[\w.()-]+)?|-?[\d.]+(em|rem|%)(\/[\w.()-]+)?)$/;
  return tokens.every(t => allowed.test(t)) && fontSizeOk(sizeToken);
}

// ---------- the check ----------

/** True when the file is a primitive or view stylesheet; returns the layer it must use. */
export function requiredLayer(file) {
  if (file.startsWith(`${STYLES_DIR}/primitives/`)) return 'primitives';
  if (file.startsWith(`${STYLES_DIR}/views/`)) return 'views';
  return null;
}

/**
 * Checks one stylesheet. `file` is repo-relative with forward slashes.
 * Returns [{file, line, rule, message}].
 */
export function checkCssText(file, text) {
  const out = [];
  const report = (offset, rule, message) => out.push({file, line: lineAt(text, offset), rule, message});
  const inStyles = file.startsWith(`${STYLES_DIR}/`);
  if (!inStyles) return out;
  const css = stripComments(text);
  const tree = parse(css);
  const colourExempt = COLOUR_FILES.includes(file);
  const importantOk = IMPORTANT_FILES.includes(file);

  for (const node of walk(tree)) {
    if (node.type !== 'decl') continue;
    const {prop, value, important, start} = node;
    if (important && !importantOk) report(start, 'important', `${prop}: !important is allowed only in reset.css and utilities.css`);
    if (prop.startsWith('--')) {
      if (!colourExempt) {
        const lit = colourLiteral(value);
        if (lit) report(start, 'colour', `${prop} uses the colour literal ${lit}; colours live in tokens.css`);
      }
      continue;
    }
    if (!colourExempt) {
      const lit = colourLiteral(value);
      if (lit) report(start, 'colour', `${prop} uses the colour literal ${lit}; use a token`);
    }
    if (prop === 'z-index' && !zIndexOk(value)) report(start, 'z-index', `z-index: ${value} — use var(--z-*) or auto`);
    if (RADIUS_PROPS.test(prop) && !radiusOk(value)) report(start, 'radius', `${prop}: ${value} — use var(--r-*) or 0`);
    if (!colourExempt) {
      if (prop === 'font-size' && !fontSizeOk(value)) report(start, 'font-size', `font-size: ${value} — use var(--fs-*), inherit, em, rem or %`);
      if (prop === 'font' && !fontShorthandOk(value)) report(start, 'font-size', `font: ${value} — the size must be var(--fs-*), inherit, em, rem or % and the family var(--font-ui|mono)`);
      if (prop === 'font-family' && !fontFamilyOk(value)) report(start, 'font-family', `font-family: ${value} — use var(--font-ui) or var(--font-mono)`);
    }
  }

  const layer = requiredLayer(file);
  if (layer) {
    const top = tree;
    const ok = top.length === 1 && top[0].type === 'rule' && new RegExp(`^@layer\\s+${layer}$`).test(top[0].prelude.trim());
    if (!ok) report(top[0]?.start ?? 0, 'layer', `the whole file must be one @layer ${layer} { … } block`);
  } else {
    const rel = file.slice(STYLES_DIR.length + 1);
    if (!rel.includes('/') && !CORE_FILES.includes(rel)) report(0, 'placement', `${rel} is not a core stylesheet; primitives go in src/styles/primitives/, views in src/styles/views/<area>/`);
    if (rel.includes('/') && !rel.startsWith('primitives/') && !rel.startsWith('views/')) report(0, 'placement', `stylesheets under src/styles/ live in primitives/ or views/`);
  }

  if (file === `${STYLES_DIR}/main.css`) {
    const first = css.trim().split(';')[0] + ';';
    if (first.replace(/\s+/g, ' ') !== LAYER_ORDER) report(0, 'main', `main.css must start with "${LAYER_ORDER}"`);
  }
  return out;
}

/** Every .css file under `dir` (repo-relative paths). */
export function listCss(root, dir = '.') {
  const out = [];
  const abs = path.join(root, dir);
  let entries;
  try { entries = readdirSync(abs, {withFileTypes: true}); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const rel = dir === '.' ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...listCss(root, rel)); }
    else if (e.isFile() && e.name.endsWith('.css')) out.push(rel);
  }
  return out.sort();
}

/**
 * Scans the repository. Options override the activation points (tests use them).
 * Returns [{file, line, rule, message}].
 */
export function checkCss({root = ROOT, cssLocation = ACTIVATION.cssLocation, locationExempt = LOCATION_EXEMPT} = {}) {
  const out = [];
  for (const file of listCss(root, STYLES_DIR)) out.push(...checkCssText(file, readFileSync(path.join(root, file), 'utf8')));
  if (cssLocation) {
    for (const file of listCss(root, 'src')) {
      if (file.startsWith(`${STYLES_DIR}/`) || locationExempt.includes(file)) continue;
      out.push({file, line: 1, rule: 'location', message: 'stylesheets live under src/styles/ (§7.1)'});
    }
  }
  return out;
}

export function format(v) { return `${v.file}:${v.line}  [${v.rule}] ${v.message}`; }

export function main(argv = process.argv.slice(2), {log = console.log, error = console.error, root = ROOT} = {}) {
  const violations = checkCss({root});
  if (argv.includes('--json')) { log(JSON.stringify(violations, null, 2)); return violations.length ? 1 : 0; }
  for (const v of violations) error(format(v));
  log(violations.length ? `check-css: ${violations.length} violation(s)` : 'check-css: OK');
  return violations.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}
