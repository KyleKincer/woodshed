#!/usr/bin/env node
// Source guard (architecture §7.6, §0.1; run by tests/guards.test.js under npm test).
//
//   node scripts/check-source.mjs [--json]   scan src/**/*.js, exit 1 on any violation
//   node scripts/check-source.mjs --orphans  list src/js modules no entry point reaches (wave 4, V1)
//
// Rules (id: what it forbids):
//   dialogs     alert(, confirm( or prompt( (feedback.confirm is the dialog)
//   keyboard    keydown/keyup listeners on window or document (also an injected win/doc,
//               ownerDocument, defaultView) outside src/app/dispatch.js
//   storage     localStorage / sessionStorage outside src/app/prefs.js, src/app/router.js
//               (sessionStorage get/set/removeItem of ws.intendedRoute only, by literal or a
//               const holding it) and src/js/notation/store.js
//   backend     importing src/js/backend.js (§0.1; deleted at integration I3a)
//   inner-html  innerHTML = with an interpolated string in src/{app,ui,stage,edit,library,
//               settings,share,onboarding} (use h())
//   inline-z    setting z-index in inline styles (.zIndex =, zIndex: in a style object,
//               'z-index' in style text); reading .zIndex is fine
//   commands    a */commands.js or transport-commands.js importing anything but
//               src/app/commands.js, src/app/keys.js and PURE_HELPERS (D46; dynamic
//               import() is how heavy work loads)
//   clock       Date.now( or performance.now( in the new top-level directories outside
//               src/app/clock.js
//   reserved    a command binding a browser/OS-reserved key (§2.6 rule 10)
//   colour      colour literals (#hex, rgb(), hsl(), color-mix()) in source; colours are tokens
//
// Activation (§9.2 F1): until integration I3a the rules cover only the new top-level
// directories (NEW_DIRS). I3a sets ACTIVATION.sourceScope = 'all', which extends them
// to src/js (the inner-html and clock rules keep their own directory lists).
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ACTIVATION = {
  /** 'new' until integration I3a, then 'all'. */
  sourceScope: 'new',
};

export const NEW_DIRS = ['app', 'ui', 'stage', 'edit', 'library', 'settings', 'share', 'onboarding', 'download', 'api'].map(d => `src/${d}`);
export const INNER_HTML_DIRS = ['app', 'ui', 'stage', 'edit', 'library', 'settings', 'share', 'onboarding'].map(d => `src/${d}`);

export const DISPATCHER = 'src/app/dispatch.js';
export const CLOCK = 'src/app/clock.js';
export const BACKEND = 'src/js/backend.js';

/** Who may touch web storage, and which kind (§0.1). IndexedDB is not covered. */
export const STORAGE_ALLOWED = {
  'src/app/prefs.js': ['localStorage', 'sessionStorage'],
  'src/app/router.js': ['sessionStorage'],
  'src/js/notation/store.js': ['localStorage', 'sessionStorage'],
};

/** The one sessionStorage key src/app/router.js may use (§0.1, §7.6). */
export const ROUTER_SESSION_KEY = 'ws.intendedRoute';
export const ROUTER = 'src/app/router.js';

/**
 * Modules a commands module may import statically besides the registry and keys
 * (D46): pure helpers with no DOM, no audio and no network. Integrations amend
 * this list (§9.0); every `*.copy.js` strings table is also allowed.
 */
export const PURE_HELPERS = [
  'src/app/commands.js',
  'src/app/keys.js',
  'src/app/clock.js',
  'src/app/profile.js',
  'src/app/error-copy.js',
  'src/stage/glass.js',
  'src/stage/grid.js',
  'src/stage/surfaces/roadmap-layout.js',
  'src/library/library-model.js',
  'src/library/add-model.js',
  'shared/song-map.ts',
  'shared/practice.ts',
  'shared/metadata.ts',
  'shared/notation.ts',
];

/** §2.6 rule 10: no def may bind these (symbol aliases included). */
export const RESERVED_KEYS = [
  'Mod+KeyN', 'Mod+KeyW', 'Mod+KeyT', 'Mod+Comma', 'Mod+,',
  ...Array.from({length: 10}, (_, d) => `Mod+Digit${d}`),
  'Mod+=', 'Mod++', 'Mod+-', 'Mod+−', 'Mod+Equal', 'Mod+Minus',
];

/** Files allowed to hold colour literals (§7.6 exemptions; outside the scope until I3a). */
export const COLOUR_EXEMPT = [
  'src/js/artwork.js',              // cover-art palettes (art data)
  'src/js/notation/score-view.js',  // alphaTab print colours (through --print-ink where possible)
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'release', 'coverage']);

// ---------- lexing ----------

const REGEX_PREV_CHARS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_PREV_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * Splits JS into same-length views:
 *   code   comments blanked (strings, templates and regexes kept)
 *   bare   comments and the contents of strings, template text and regexes blanked
 *          (quotes kept; template ${…} expressions kept as code)
 *   spans  [{from, to, kind}] for the contents of each string ('string'), template text
 *          run between backticks and ${…} ('template', newlines included) and regex ('regex')
 * Newlines are preserved, so offsets and line numbers match the source.
 */
export function lex(src) {
  const code = src.split('');
  const bare = src.split('');
  const blank = (arr, from, to) => { for (let k = from; k < to; k++) if (arr[k] !== '\n') arr[k] = ' '; };
  const spans = [];
  const literal = (from, to, kind) => { blank(bare, from, to); spans.push({from, to, kind}); };
  const stack = []; // template nesting: brace depth at each ${
  let depth = 0;
  let prevSig = '';   // last significant character outside strings/comments
  let prevWord = '';
  let i = 0;
  const n = src.length;
  function scanTemplate() {
    // at a template character (just after ` or after a closing } of ${…})
    const start = i;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { literal(start, i, 'template'); i++; prevSig = '`'; return; }
      if (c === '$' && src[i + 1] === '{') { literal(start, i, 'template'); i += 2; stack.push(depth); depth++; prevSig = '{'; return; }
      i++;
    }
    literal(start, n, 'template');
  }
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      const j = end < 0 ? n : end;
      blank(code, i, j); blank(bare, i, j); i = j; continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end < 0 ? n : end + 2;
      blank(code, i, j); blank(bare, i, j); i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      literal(i + 1, Math.min(j, n), 'string');
      i = j + 1; prevSig = c; prevWord = ''; continue;
    }
    if (c === '`') { i++; scanTemplate(); prevWord = ''; continue; }
    if (c === '/' && (prevSig === '' || REGEX_PREV_CHARS.has(prevSig) || REGEX_PREV_WORDS.has(prevWord))) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
        j++;
      }
      literal(i + 1, Math.min(j, n), 'regex');
      i = j + 1;
      while (i < n && /[a-z]/i.test(src[i])) i++;
      prevSig = '/'; prevWord = ''; continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      if (stack.length && depth - 1 === stack[stack.length - 1]) { depth--; stack.pop(); i++; scanTemplate(); continue; }
      depth--;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      prevWord = src.slice(i, j); prevSig = 'a'; i = j; continue;
    }
    if (!/\s/.test(c)) { prevSig = c; prevWord = ''; }
    i++;
  }
  return {code: code.join(''), bare: bare.join(''), spans};
}

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

// ---------- imports ----------

/** Static and dynamic import specifiers: [{spec, offset, dynamic}]. */
export function importsOf(src, lexed = lex(src)) {
  const {code, bare} = lexed;
  const out = [];
  const inCode = k => bare[k] === code[k] && code[k] !== ' ';
  const re = [
    {rx: /\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?(['"])([^'"\n]+)\1/g, dynamic: false},
    {rx: /\bexport\s*(?:\*\s*(?:as\s+[\w$]+\s*)?|\{[^}]*\}\s*)from\s*(['"])([^'"\n]+)\1/g, dynamic: false},
    {rx: /\bimport\s*\(\s*(['"`])([^'"`\n$]+)\1\s*\)/g, dynamic: true},
  ];
  for (const {rx, dynamic} of re) {
    for (const m of code.matchAll(rx)) {
      if (!inCode(m.index)) continue;
      if (!dynamic && /^import\s*\(/.test(m[0])) continue;
      out.push({spec: m[2], offset: m.index, dynamic});
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/** import.meta.glob patterns: [{pattern, offset}]. */
export function globsOf(src, lexed = lex(src)) {
  const out = [];
  for (const m of lexed.code.matchAll(/\bimport\.meta\.glob\s*\(\s*(\[[^\]]*\]|(['"])[^'"]+\2)/g)) {
    for (const s of m[1].matchAll(/(['"])([^'"]+)\1/g)) out.push({pattern: s[2], offset: m.index});
  }
  for (const m of lexed.code.matchAll(/\bnew\s+URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g)) out.push({pattern: m[2], offset: m.index, url: true});
  return out;
}

/** Resolves a specifier from `file` to a repo-relative path ('pkg:<name>' for packages). */
export function resolveSpec(file, spec, exists = () => true) {
  const clean = spec.replace(/[?#].*$/, '');
  let target;
  if (clean.startsWith('.')) target = path.posix.normalize(path.posix.join(path.posix.dirname(file), clean));
  else if (clean.startsWith('/')) target = clean.slice(1);
  else return `pkg:${clean}`;
  if (path.posix.extname(target)) return target;
  for (const ext of ['.js', '.ts', '.mjs', '/index.js']) if (exists(target + ext)) return target + ext;
  return `${target}.js`;
}

// ---------- rules ----------

const DOT = String.raw`\s*\??\.\s*`;
/** window/document (optionally window.document, self.document, …), an injected win/doc, or an ownerDocument/defaultView chain. */
const KEY_TARGET = String.raw`(?:(?:window|globalThis|self)${DOT})?(?:window|document|globalThis|self|win|doc)(?:${DOT}(?:documentElement|body))?`
  + String.raw`|[\w$.?]*\??\.(?:ownerDocument|defaultView)(?:\??\.(?:documentElement|body))?`;
const KEY_LISTENER = new RegExp(String.raw`(?<![\w$.])(${KEY_TARGET})${DOT}addEventListener\s*\(\s*(['"\x60])(keydown|keyup)\2`, 'g');

const isCommandsModule = file => /(^|\/)commands\.js$/.test(file) && file !== 'src/app/commands.js' || /(^|\/)transport-commands\.js$/.test(file);
const under = (file, dirs) => dirs.some(d => file === d || file.startsWith(`${d}/`));

/** The in-scope source files for a scope setting. */
export function inScope(file, scope = ACTIVATION.sourceScope) {
  if (!file.startsWith('src/') || !/\.(js|mjs)$/.test(file)) return false;
  return scope === 'all' ? true : under(file, NEW_DIRS);
}

/**
 * Checks one source file (repo-relative path). Returns [{file, line, rule, message}].
 * `scope` overrides the activation point; `exists(path)` resolves extension-less imports.
 */
export function checkSourceText(file, src, {scope = ACTIVATION.sourceScope, exists} = {}) {
  const out = [];
  if (!inScope(file, scope)) return out;
  const lexed = lex(src);
  const {code, bare} = lexed;
  const report = (offset, rule, message) => out.push({file, line: lineAt(src, offset), rule, message});

  // dialogs
  const imported = new Set();
  for (const m of bare.matchAll(/\bimport\s*\{([^}]*)\}\s*from/g)) for (const part of m[1].split(',')) {
    const local = part.trim().split(/\s+as\s+/).pop()?.trim();
    if (local) imported.add(local);
  }
  for (const m of bare.matchAll(/\b(alert|confirm|prompt)\s*\(/g)) {
    const name = m[1];
    const before = bare.slice(Math.max(0, m.index - 40), m.index);
    const member = /\.\s*$/.test(before);
    if (member && !/\b(window|globalThis|self|top|parent)\s*\??\.\s*$/.test(before)) continue; // obj.confirm(…), e.g. feedback.confirm
    if (!member) {
      if (/\b(function\*?|async)\s*$/.test(before) || /\bfunction\s*\*?\s*$/.test(before)) continue; // definition
      if (imported.has(name)) continue; // import {confirm} from '../app/feedback.js'
      // A method or function definition: `confirm(args) {`
      const close = matchParen(bare, m.index + m[0].length - 1);
      if (close > 0 && /^\s*\{/.test(bare.slice(close + 1, close + 40)) && !/[=(,:?]\s*$/.test(before)) continue;
    }
    report(m.index, 'dialogs', `${name}() is banned; use feedback.confirm() or a Dialog`);
  }

  // keyboard
  if (file !== DISPATCHER) {
    const keyMsg = (target, type) => `${target} ${type} listeners belong to src/app/dispatch.js; listen on your own element and mark data-consume-keys`;
    for (const m of code.matchAll(KEY_LISTENER)) {
      if (bare[m.index] !== code[m.index]) continue;
      report(m.index, 'keyboard', keyMsg(m[1], m[3]));
    }
    // A bare addEventListener(…) in module code is window's.
    for (const m of code.matchAll(/(?<![\w$.]\s*)\baddEventListener\s*\(\s*(['"`])(keydown|keyup)\1/g)) {
      if (bare[m.index] !== code[m.index]) continue;
      report(m.index, 'keyboard', keyMsg('window', m[2]));
    }
    for (const m of bare.matchAll(/(?<![\w$.])(?:(?:window|globalThis|self)\s*\??\.\s*)?(window|document|globalThis|self|win|doc)\s*\??\.\s*on(keydown|keyup)\s*=(?!=)/g)) {
      report(m.index, 'keyboard', `${m[1]}.on${m[2]} belongs to src/app/dispatch.js`);
    }
  }

  // storage
  const allowedStorage = STORAGE_ALLOWED[file] || [];
  for (const m of code.matchAll(/\b(localStorage|sessionStorage)\b/g)) {
    if (bare[m.index] !== code[m.index]) continue; // inside a string
    if (file === ROUTER && m[1] === 'sessionStorage') {
      const bad = routerSessionMisuse(src, code, m.index + m[0].length);
      if (bad) report(m.index, 'storage', `src/app/router.js uses sessionStorage only for '${ROUTER_SESSION_KEY}' (${bad})`);
      continue;
    }
    if (allowedStorage.includes(m[1])) continue;
    report(m.index, 'storage', `${m[1]} is touched only by src/app/prefs.js${m[1] === 'sessionStorage' ? ' and src/app/router.js' : ''}`);
  }

  // imports: backend, commands
  const fileExists = exists || (() => false);
  const imports = importsOf(src, lexed);
  for (const imp of imports) {
    const target = resolveSpec(file, imp.spec, fileExists);
    if (target === BACKEND) report(imp.offset, 'backend', `new code never imports src/js/backend.js; use src/api/*.js`);
  }
  if (isCommandsModule(file)) {
    for (const imp of imports) {
      if (imp.dynamic) continue;
      const target = resolveSpec(file, imp.spec, fileExists);
      if (PURE_HELPERS.includes(target) || /\.copy\.js$/.test(target)) continue;
      report(imp.offset, 'commands', `a commands module imports only src/app/commands.js, src/app/keys.js and pure helpers; load ${imp.spec} with import() inside run`);
    }
  }

  // inner-html
  if (under(file, INNER_HTML_DIRS)) {
    for (const m of bare.matchAll(/\b(innerHTML|outerHTML)\s*(\+?=)(?!=)/g)) {
      const rhs = rhsOf(code, bare, m.index + m[0].length);
      const interpolated = m[2] === '+=' || /`[^`]*\$\{/.test(rhs.code) || (/['"`]/.test(rhs.bare) && /\+/.test(rhs.bare));
      if (interpolated) report(m.index, 'inner-html', `${m[1]} with an interpolated string; build the DOM with h()`);
    }
  }

  // inline-z
  for (const m of bare.matchAll(/\.\s*zIndex\s*(?:[-+*/]?=(?!=))|\bzIndex\s*:/g)) report(m.index, 'inline-z', 'z-index in inline styles; use a class with var(--z-*)');
  for (const m of code.matchAll(/z-index/g)) {
    if (bare[m.index] === code[m.index]) continue; // only inside strings (style text)
    report(m.index, 'inline-z', 'z-index in inline styles; use a class with var(--z-*)');
  }

  // clock
  if (under(file, NEW_DIRS) && file !== CLOCK) {
    for (const m of bare.matchAll(/\b(Date|performance)\s*\.\s*now\s*\(/g)) report(m.index, 'clock', `${m[1]}.now() — use now() from src/app/clock.js (audio time is ctx.currentTime)`);
  }

  // reserved
  for (const m of bare.matchAll(/\b(keys|key)\s*:\s*(?=[\['"])/g)) {
    const at = m.index + m[0].length;
    // The value's extent in the bare view, where string contents are blanked, so a
    // ']' key string does not end the array.
    const end = bare[at] === '[' ? matchBracket(bare, at) : bare.indexOf(bare[at], at + 1);
    if (end < 0) continue;
    for (const sp of lexed.spans) {
      if (sp.kind !== 'string' || sp.from <= at || sp.to > end) continue;
      const key = src.slice(sp.from, sp.to);
      if (RESERVED_KEYS.includes(key)) report(m.index, 'reserved', `${key} is reserved by the browser or OS (§2.6 rule 10)`);
    }
  }

  // colour
  if (!COLOUR_EXEMPT.includes(file)) {
    for (const sp of lexed.spans) {
      if (sp.kind === 'regex') continue;
      const found = colourIn(src.slice(sp.from, sp.to));
      if (found) report(sp.from, 'colour', `colour literal ${found} in source; read the token (getComputedStyle) instead`);
    }
  }
  return out;
}

/**
 * The first colour literal in a string's text, or null. A #hex counts when it stands
 * at the start, after whitespace, ':' ',' or '(' (not url(#id)); an all-digit one
 * (#123, which prose uses for numbers) only as the whole string, after ':' ',' '('
 * or inside a 'property: …' declaration.
 */
export function colourIn(text) {
  const fn = /\b(rgba?|hsla?|color-mix)\(/.exec(text);
  if (fn) return `${fn[1]}(`;
  for (const m of text.matchAll(/(^|[\s:,(])#([0-9a-fA-F]{3,8})(?![\w-])/g)) {
    const hex = m[2];
    if (![3, 4, 6, 8].includes(hex.length)) continue;
    const before = text.slice(0, m.index + m[1].length);
    if (m[1] === '(' && /\burl\($/i.test(before)) continue;
    if (/^\d+$/.test(hex) && text.trim() !== `#${hex}` && !/[:,(]$/.test(m[1]) && !/[a-z-]+\s*:[^;:]*$/i.test(before)) continue;
    return `#${hex}`;
  }
  return null;
}

/** Why a sessionStorage use in router.js breaks the one-key rule, or '' when it is fine. */
function routerSessionMisuse(src, code, from) {
  const rest = code.slice(from, from + 200);
  const call = /^\s*\??\.\s*(getItem|setItem|removeItem)\s*\(\s*/.exec(rest);
  if (!call) {
    if (/\btypeof\s*$/.test(code.slice(Math.max(0, from - 40), from - 'sessionStorage'.length))) return '';
    return 'only getItem, setItem and removeItem';
  }
  const arg = rest.slice(call[0].length);
  const lit = /^(['"`])([^'"`$\\\n]*)\1/.exec(arg);
  if (lit) return lit[2] === ROUTER_SESSION_KEY ? '' : `key '${lit[2]}'`;
  const id = /^([A-Za-z_$][\w$]*)\s*[,)]/.exec(arg);
  if (id) {
    const decl = new RegExp(String.raw`\bconst\s+${id[1].replace(/\$/g, '\\$')}\s*=\s*(['"])([^'"\n]*)\1`).exec(code);
    if (decl) return decl[2] === ROUTER_SESSION_KEY ? '' : `key ${id[1]} = '${decl[2]}'`;
  }
  return `pass '${ROUTER_SESSION_KEY}' as a literal or a const`;
}

function matchBracket(text, open) {
  let d = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '[') d++;
    else if (text[k] === ']' && --d === 0) return k;
  }
  return -1;
}

function matchParen(text, open) {
  let d = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '(') d++;
    else if (text[k] === ')' && --d === 0) return k;
  }
  return -1;
}

/** The right-hand side of an assignment, up to the end of the statement. */
function rhsOf(code, bare, from) {
  let d = 0, k = from;
  for (; k < bare.length; k++) {
    const c = bare[k];
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) { if (d === 0) break; d--; }
    else if ((c === ';' || c === ',') && d === 0) break;
    else if (c === '\n' && d === 0 && bare.slice(from, k).trim() !== '' && !/[+?:|&]\s*$/.test(bare.slice(from, k)) && !/^\s*[+?:.]/.test(bare.slice(k + 1, k + 40))) break;
  }
  return {code: code.slice(from, k), bare: bare.slice(from, k)};
}

// ---------- the scan ----------

export function listFiles(root, dir, test) {
  const out = [];
  let entries;
  try { entries = readdirSync(path.join(root, dir), {withFileTypes: true}); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...listFiles(root, rel, test)); }
    else if (e.isFile() && test(rel)) out.push(rel);
  }
  return out.sort();
}

/** Scans src/**. Returns [{file, line, rule, message}]. */
export function checkSource({root = ROOT, scope = ACTIVATION.sourceScope} = {}) {
  const exists = p => existsSync(path.join(root, p));
  const out = [];
  for (const file of listFiles(root, 'src', f => /\.(js|mjs)$/.test(f))) {
    if (!inScope(file, scope)) continue;
    out.push(...checkSourceText(file, readFileSync(path.join(root, file), 'utf8'), {scope, exists}));
  }
  return out;
}

// ---------- orphans (V1, wave 4) ----------

/** Module script entries of the root HTML pages. */
export function htmlEntries(root) {
  const out = [];
  for (const f of readdirSync(root)) {
    if (!f.endsWith('.html')) continue;
    const html = readFileSync(path.join(root, f), 'utf8');
    for (const m of html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/g)) out.push(m[1].replace(/^\//, ''));
    for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*\btype=["']module["']/g)) out.push(m[1].replace(/^\//, ''));
  }
  return [...new Set(out)];
}

/**
 * Modules under src/js that nothing reaches from the HTML entry points through
 * static imports, dynamic import(), import.meta.glob and new URL(…, import.meta.url).
 */
export function findOrphans({root = ROOT, entries = htmlEntries(root)} = {}) {
  const exists = p => existsSync(path.join(root, p));
  const all = [...listFiles(root, 'src', f => /\.(js|mjs|ts)$/.test(f)), ...listFiles(root, 'shared', f => /\.(js|ts)$/.test(f))];
  const seen = new Set();
  const queue = entries.filter(exists);
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !/\.(js|mjs|ts)$/.test(file)) continue;
    seen.add(file);
    const src = readFileSync(path.join(root, file), 'utf8');
    const lexed = lex(src);
    for (const imp of importsOf(src, lexed)) {
      const t = resolveSpec(file, imp.spec, exists);
      if (!t.startsWith('pkg:') && exists(t)) queue.push(t);
    }
    for (const g of globsOf(src, lexed)) {
      const clean = g.pattern.replace(/[?#].*$/, '');
      const pattern = clean.startsWith('/') ? clean.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(file), clean));
      for (const f of all) if (path.posix.matchesGlob(f, pattern)) queue.push(f);
    }
  }
  return all.filter(f => f.startsWith('src/js/') && !/\.test\.[jt]s$/.test(f) && !seen.has(f));
}

export function format(v) { return `${v.file}:${v.line}  [${v.rule}] ${v.message}`; }

export function main(argv = process.argv.slice(2), {log = console.log, error = console.error, root = ROOT} = {}) {
  if (argv.includes('--orphans')) {
    const orphans = findOrphans({root});
    for (const f of orphans) log(f);
    log(orphans.length ? `check-source --orphans: ${orphans.length} unreachable module(s)` : 'check-source --orphans: none');
    return orphans.length ? 1 : 0;
  }
  const violations = checkSource({root});
  if (argv.includes('--json')) { log(JSON.stringify(violations, null, 2)); return violations.length ? 1 : 0; }
  for (const v of violations) error(format(v));
  log(violations.length ? `check-source: ${violations.length} violation(s)` : 'check-source: OK');
  return violations.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}
