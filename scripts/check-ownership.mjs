#!/usr/bin/env node
// Package ownership check (architecture §9.0, §11.1).
//
//   node scripts/check-ownership.mjs <ID> [--base <ref>] [--allow-peers] [--allow <glob>]... [--json]
//
// Compares every path the package changed against the globs it owns in
// docs/ux2/packages.json. Changed paths are the union of
//   git diff --name-only <base>...HEAD   (committed on the package branch)
//   git diff --name-only HEAD            (staged and unstaged edits)
//   git ls-files --others --exclude-standard   (new, untracked files)
// so the check works both before and after the package commits.
//
// A path is allowed when it matches one of the package's `owns` globs (entries
// starting with "!" exclude), or it is
//   - a test file named after one of the package's own modules
//     (src/app/keys.js → tests/app-keys.test.js or tests/keys.test.js;
//      convex/songs.ts → convex/songs.test.ts; companion/sections.py → companion/test_sections.py),
//   - tests/harness/<sub>/<module>.harness.js for one of its modules (the same
//     <name> or <sub>-<name> forms as tests/<sub>/<name>.test.js),
//   - tests/fixture/states/<ID>.cjs.
// Any other path fails, and the report names the package that owns it.
// A naming rule never grants a path a same-wave peer owns, a path any package
// lists literally, or a name that fits modules of two packages of the same
// wave (see namedConflict): parallel packages can never both change one file.
//
// The base is --base, else WT_BASE from .env.worktree (written by scripts/wt.mjs),
// else HEAD (only the uncommitted changes are checked).
// --allow-peers: paths owned by another package of the same wave are reported
//   but do not fail (several packages sharing one working tree).
// --allow <glob>: a declared exception (for example a deleted test case of a
//   module scheduled for deletion, §9.0); reported as "declared".
// Glob matching is node:path matchesGlob, after brace expansion. As in that
// matcher, "*" and "**" never match a path segment that starts with ".".
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const WAVES = ['P', '0A', '0B', '1a', '1b', '2a', '2b', '3a', '3b', '4'];
export const KINDS = ['package', 'integration', 'verification'];
export const PACKAGES_PATH = 'docs/ux2/packages.json';

// ---------- globs ----------

/** Expands {a,b} groups (nested allowed) into a list of plain patterns. */
export function expandBraces(pattern) {
  let depth = 0, start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0) {
      const body = pattern.slice(start + 1, i);
      const parts = [];
      let d = 0, from = 0;
      for (let j = 0; j < body.length; j++) {
        if (body[j] === '{') d++;
        else if (body[j] === '}') d--;
        else if (body[j] === ',' && d === 0) { parts.push(body.slice(from, j)); from = j + 1; }
      }
      parts.push(body.slice(from));
      if (parts.length < 2) continue; // "{x}" is literal
      const head = pattern.slice(0, start), tail = pattern.slice(i + 1);
      return parts.flatMap(p => expandBraces(head + p + tail));
    }
  }
  return [pattern];
}

const hasWildcard = p => /[*?[]/.test(p);

/** True when `file` (repo-relative, forward slashes) matches the glob. */
export function matchGlob(file, glob) {
  return expandBraces(glob).some(g => (hasWildcard(g) ? path.posix.matchesGlob(file, g) : file === g));
}

/** Applies an `owns` list: any positive glob matches and no "!" glob does. */
export function ownsPath(owns, file) {
  let hit = false;
  for (const g of owns) {
    if (g.startsWith('!')) { if (matchGlob(file, g.slice(1))) return false; }
    else if (!hit && matchGlob(file, g)) hit = true;
  }
  return hit;
}

/** Concrete sample paths a glob stands for (used by the overlap check). */
export function samplePaths(glob) {
  const out = new Set();
  for (const g of expandBraces(glob)) {
    if (!hasWildcard(g)) { out.add(g); continue; }
    const variants = [
      g.replace(/\*\*/g, '__s__').replace(/\*/g, '__s__').replace(/\?/g, 's').replace(/\[[^\]]*\]/g, 's'),
      g.replace(/\/\*\*\//g, '/').replace(/\*\*/g, '__s__/__s__').replace(/\*/g, '__t__').replace(/\?/g, 's').replace(/\[[^\]]*\]/g, 's'),
    ];
    for (const v of variants) if (path.posix.matchesGlob(v, g)) out.add(v);
  }
  return [...out];
}

// ---------- packages.json ----------

export function loadPackages(root) {
  const file = path.join(root, PACKAGES_PATH);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(data) ? data : data.packages;
}

/** Structural validation; returns a list of problems (empty when valid). */
export function validatePackages(packages) {
  const problems = [];
  const ids = new Map();
  packages.forEach((p, i) => {
    const at = p && p.id ? p.id : `#${i}`;
    if (!p || typeof p !== 'object') { problems.push(`${at}: not an object`); return; }
    if (typeof p.id !== 'string' || !/^[A-Z][A-Za-z0-9]*$/.test(p.id)) problems.push(`${at}: bad id`);
    if (ids.has(p.id)) problems.push(`${at}: duplicate id`);
    ids.set(p.id, p);
    if (!WAVES.includes(p.wave)) problems.push(`${at}: unknown wave ${JSON.stringify(p.wave)}`);
    if (!KINDS.includes(p.kind)) problems.push(`${at}: unknown kind ${JSON.stringify(p.kind)}`);
    if (typeof p.title !== 'string' || !p.title.trim()) problems.push(`${at}: missing title`);
    if (!Array.isArray(p.owns) || p.owns.some(g => typeof g !== 'string' || !g || g.startsWith('/') || g.includes('\\'))) problems.push(`${at}: owns must be relative forward-slash globs`);
    if (!Array.isArray(p.deps)) problems.push(`${at}: deps must be an array`);
    else if (new Set(p.deps).size !== p.deps.length) problems.push(`${at}: duplicate deps`);
    if (p.kind === 'package' && Array.isArray(p.owns) && !p.owns.some(g => !g.startsWith('!'))) problems.push(`${at}: a package must own something`);
  });
  for (const p of packages) {
    for (const d of p.deps || []) {
      const dep = ids.get(d);
      if (!dep) { problems.push(`${p.id}: unknown dep ${d}`); continue; }
      const a = WAVES.indexOf(p.wave), b = WAVES.indexOf(dep.wave);
      const ok = p.kind === 'package' ? b < a : b <= a;
      if (!ok) problems.push(`${p.id}: dep ${d} (wave ${dep.wave}) is not before wave ${p.wave}`);
    }
  }
  return problems;
}

/**
 * Overlaps between packages of the same wave: a path that two packages'
 * globs both own. Candidates are every sample of every glob plus `extraPaths`
 * (for example the repository's tracked files). Integrations own nothing.
 */
export function findOverlaps(packages, extraPaths = []) {
  const overlaps = [];
  for (const wave of WAVES) {
    const peers = packages.filter(p => p.wave === wave && p.kind !== 'integration' && p.owns.length);
    if (peers.length < 2) continue;
    const candidates = new Set(extraPaths);
    for (const p of peers) for (const g of p.owns) if (!g.startsWith('!')) for (const s of samplePaths(g)) candidates.add(s);
    for (const file of candidates) {
      const owners = peers.filter(p => ownsPath(p.owns, file)).map(p => p.id);
      if (owners.length > 1) overlaps.push({wave, file, owners});
    }
  }
  return overlaps;
}

// ---------- test files named after a package's modules ----------

const TEST_RE = /\.test\.[cm]?[jt]s$/;
const isTestFile = f => TEST_RE.test(f) || /(^|\/)test_[^/]+\.py$/.test(f) || /\.harness\.js$/.test(f);

/** The names a module's tests may carry: "keys", "app-keys", "edit-map-view", … */
export function moduleTestNames(file) {
  const ext = path.posix.extname(file);
  if (!/^\.(js|mjs|cjs|ts|py)$/.test(ext) || isTestFile(file)) return [];
  const base = path.posix.basename(file, ext).replace(/\.d$/, '');
  let dirs = path.posix.dirname(file).split('/').filter(s => s && s !== '.');
  if (dirs[0] === 'src') dirs = dirs.slice(1);
  if (dirs[0] === 'js') dirs = dirs.slice(1);
  const names = [base];
  for (let k = 1; k <= dirs.length; k++) names.push([...dirs.slice(dirs.length - k), base].join('-'));
  return names;
}

/**
 * Modules (concrete paths) a package owns: the literal entries of its globs and
 * every known path its globs match. Test files are not modules.
 */
export function ownedModules(pkg, knownPaths) {
  const mods = new Set();
  for (const g of pkg.owns) {
    if (g.startsWith('!')) continue;
    for (const e of expandBraces(g)) if (!hasWildcard(e) && ownsPath(pkg.owns, e)) mods.add(e);
  }
  for (const f of knownPaths) if (ownsPath(pkg.owns, f)) mods.add(f);
  return [...mods].filter(f => !isTestFile(f));
}

/** Why `file` is allowed for `pkg` through the naming rules, or null. */
export function namedAllowance(pkg, file, modules) {
  if (file === `tests/fixture/states/${pkg.id}.cjs`) return 'state';
  // tests/harness/<sub>/<name>.harness.js matches the module names "<name>" and "<sub>-<name>".
  const harness = /^tests\/harness\/(?:(.+)\/)?([^/]+)\.harness\.js$/.exec(file);
  if (harness) {
    const keys = new Set([harness[2], [...(harness[1] ? harness[1].split('/') : []), harness[2]].join('-')]);
    return modules.some(mod => moduleTestNames(mod).some(n => keys.has(n))) ? 'harness' : null;
  }
  // <dir>/<name>.test.<ext> and <dir>/test_<name>.py.
  const m = /^(?:(.*)\/)?(?:([^/]+)\.test\.[cm]?[jt]s|test_([^/]+)\.py)$/.exec(file);
  if (!m) return null;
  const dir = m[1] || '.', name = m[2] || m[3];
  if (dir !== 'tests' && !dir.startsWith('tests/')) {
    // Co-located with the module (convex/songs.test.ts, companion/test_sections.py).
    return modules.some(mod => path.posix.dirname(mod) === dir && moduleTestNames(mod)[0] === name) ? 'module test' : null;
  }
  // tests/<sub>/<name>.test.js matches the module names "<name>" and "<sub>-<name>".
  const sub = dir.split('/').slice(1);
  const keys = new Set([name, [...sub, name].join('-')]);
  return modules.some(mod => moduleTestNames(mod).some(n => keys.has(n))) ? 'module test' : null;
}

// ---------- git ----------

function git(root, args) {
  return execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
}
const lines = s => s.split('\n').map(l => l.trim()).filter(Boolean);

export function repoRoot(cwd = process.cwd()) {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

export function readWorktreeEnv(root) {
  const file = path.join(root, '.env.worktree');
  const env = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

export function changedPaths(root, base = 'HEAD') {
  const out = new Set();
  if (base !== 'HEAD') for (const f of lines(git(root, ['diff', '--name-only', '--no-renames', `${base}...HEAD`]))) out.add(f);
  for (const f of lines(git(root, ['diff', '--name-only', '--no-renames', 'HEAD']))) out.add(f);
  for (const f of lines(git(root, ['ls-files', '--others', '--exclude-standard']))) out.add(f);
  return [...out].sort();
}

// ---------- the check ----------

/** True when `file` is a literal (wildcard-free) entry of the package's owns, not excluded. */
export function claimsLiterally(pkg, file) {
  return ownsPath(pkg.owns, file) &&
    pkg.owns.some(g => !g.startsWith('!') && expandBraces(g).some(e => !hasWildcard(e) && e === file));
}

/**
 * Why the naming rules may NOT grant `file` to `pkg` although they match it,
 * or null when the allowance stands. The rules never grant
 *   - a path a package of the same wave owns through its globs,
 *   - a path any package names literally in its owns (whatever its wave),
 *   - a path that fits the module names of another package of the same wave
 *     (tests/commands.test.js when three peers each have a commands.js):
 *     each peer then uses a longer, unique name (tests/edit-map-commands.test.js).
 * So two packages of one wave can never both be allowed one path.
 */
export function namedConflict(packages, pkg, file, modulesOf) {
  const others = packages.filter(p => p.id !== pkg.id && p.kind !== 'integration');
  const owners = others.filter(p => ownsPath(p.owns, file) && (p.wave === pkg.wave || claimsLiterally(p, file)));
  if (owners.length) return `owned by ${owners.map(p => `${p.id} (wave ${p.wave})`).join(', ')}`;
  const rivals = others.filter(p => p.wave === pkg.wave && namedAllowance(p, file, modulesOf(p)));
  if (rivals.length) return `named after modules of ${[pkg.id, ...rivals.map(p => p.id)].sort().join(', ')} in wave ${pkg.wave}; use a longer, unique test name`;
  return null;
}

/** Memoised ownedModules over the given known paths. */
export function modulesFor(knownPaths) {
  const cache = new Map();
  return p => { if (!cache.has(p.id)) cache.set(p.id, ownedModules(p, knownPaths)); return cache.get(p.id); };
}

/**
 * Whether `pkg` may change `file` on its own account: {status: 'owned'},
 * {status: 'named', detail}, or {status: null, conflict} (conflict says why a
 * matching naming rule was refused, else it is null).
 */
export function allowance(packages, pkg, file, modulesOf) {
  if (ownsPath(pkg.owns, file)) return {status: 'owned', conflict: null};
  const why = namedAllowance(pkg, file, modulesOf(pkg));
  const conflict = why ? namedConflict(packages, pkg, file, modulesOf) : null;
  return why && !conflict ? {status: 'named', detail: why, conflict} : {status: null, conflict};
}

/**
 * Classifies each changed path. Returns {ok, rows: [{file, status, detail}]}
 * where status is owned | named | declared | peer | unowned.
 */
export function checkOwnership({packages, id, files, knownPaths = [], allowPeers = false, allow = []}) {
  const pkg = packages.find(p => p.id === id);
  if (!pkg) throw new Error(`unknown package ${id}`);
  const modulesOf = modulesFor([...knownPaths, ...files]);
  const rows = files.map(file => {
    const {status, detail: why, conflict} = allowance(packages, pkg, file, modulesOf);
    if (status) return why ? {file, status, detail: why} : {file, status};
    if (allow.some(g => matchGlob(file, g))) return {file, status: 'declared'};
    const owners = packages.filter(p => p.id !== id && p.kind !== 'integration' && ownsPath(p.owns, file));
    const peers = owners.filter(p => p.wave === pkg.wave);
    if (allowPeers && peers.length) return {file, status: 'peer', detail: peers.map(p => p.id).join(', ')};
    const detail = conflict || (owners.length ? `owned by ${owners.map(p => `${p.id} (wave ${p.wave})`).join(', ')}` : 'no package owns it');
    return {file, status: 'unowned', detail};
  });
  return {ok: rows.every(r => r.status !== 'unowned'), pkg, rows};
}

function parseArgs(argv) {
  const opts = {allow: [], allowPeers: false, json: false};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') opts.base = argv[++i];
    else if (a.startsWith('--base=')) opts.base = a.slice(7);
    else if (a === '--allow') opts.allow.push(argv[++i]);
    else if (a.startsWith('--allow=')) opts.allow.push(a.slice(8));
    else if (a === '--allow-peers') opts.allowPeers = true;
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  opts.id = rest[0];
  if (rest.length > 1) throw new Error(`unexpected argument ${rest[1]}`);
  return opts;
}

export function main(argv = process.argv.slice(2), {cwd = process.cwd(), log = console.log, error = console.error} = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { error(e.message); return 2; }
  if (opts.help) { log('usage: node scripts/check-ownership.mjs <ID> [--base <ref>] [--allow-peers] [--allow <glob>]... [--json]'); return 0; }
  const root = repoRoot(cwd);
  const env = readWorktreeEnv(root);
  const id = opts.id || env.WT_ID;
  if (!id) { error('usage: node scripts/check-ownership.mjs <ID> (no WT_ID in .env.worktree)'); return 2; }
  const packages = loadPackages(root);
  const problems = validatePackages(packages);
  if (problems.length) { error(`${PACKAGES_PATH} is invalid:\n  ${problems.join('\n  ')}`); return 2; }
  const pkg = packages.find(p => p.id === id);
  if (!pkg) { error(`unknown package ${id}`); return 2; }
  if (pkg.kind === 'integration') { log(`${id} is an integration; integrations merge every branch and are not ownership-checked.`); return 0; }
  const base = opts.base || env.WT_BASE || 'HEAD';
  let files;
  try { files = changedPaths(root, base); } catch (e) { error(`git failed: ${e.stderr || e.message}`); return 2; }
  const knownPaths = lines(git(root, ['ls-files']));
  const result = checkOwnership({packages, id, files, knownPaths, allowPeers: opts.allowPeers, allow: opts.allow});
  if (opts.json) { log(JSON.stringify({id, base, ok: result.ok, rows: result.rows}, null, 2)); return result.ok ? 0 : 1; }
  log(`check-ownership ${id} (wave ${pkg.wave}) against ${base}: ${files.length} changed path(s)`);
  for (const r of result.rows) {
    const tag = {owned: 'ok      ', named: 'ok      ', declared: 'declared', peer: 'peer    ', unowned: 'UNOWNED '}[r.status];
    log(`  ${tag} ${r.file}${r.detail ? `  (${r.detail})` : ''}`);
  }
  const bad = result.rows.filter(r => r.status === 'unowned').length;
  log(bad ? `FAIL: ${bad} path(s) outside ${id}'s ownership` : `OK: every path belongs to ${id}`);
  return result.ok ? 0 : 1;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(self).href) {
  process.exitCode = main();
}
