#!/usr/bin/env node
// Package worktrees (architecture §9.0, §11.1).
//
//   node scripts/wt.mjs create <ID> [--base <ref>] [--wave <wave>] [--no-install]
//       git worktree add <root>/<ID> -b ux2/<wave>/<ID> <base>, then
//       npm ci --prefer-offline in it (never npm install), and writes
//       .env.worktree with WT_ID, WT_WAVE, WT_BRANCH, WT_BASE,
//       FIXTURE_PORT (5200 + the package's index in packages.json) and
//       VITEST_MAX_WORKERS=2. --wave names a follow-up wave such as 0Ax.
//   node scripts/wt.mjs merge <wave> [--skip <ID>]... [--dry-run]
//       merges ux2/<wave>/<ID> for every package of the wave, in ID order,
//       into the current branch with --no-ff; stops at the first conflict,
//       prints it and leaves the merge in progress. For a follow-up wave
//       (<wave>x) it merges whichever ux2/<wave>x/* branches exist.
//   node scripts/wt.mjs remove <ID> [--force] [--keep-branch]
//       removes the worktree once its branch is merged into HEAD and deletes
//       the merged branch. --force removes an unmerged or dirty worktree and
//       keeps an unmerged branch.
//   node scripts/wt.mjs list
//
// <root> is $WT_ROOT, else ../woodshed-wt next to the main checkout.
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, writeFileSync, appendFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {loadPackages, validatePackages, readWorktreeEnv, WAVES} from './check-ownership.mjs';

export const PORT_BASE = 5200;

class UsageError extends Error {}

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts}).trim();
}
function gitOk(cwd, args) {
  return spawnSync('git', args, {cwd, stdio: 'ignore'}).status === 0;
}

export const byId = (a, b) => a.localeCompare(b, 'en', {numeric: true});
export const branchName = (wave, id) => `ux2/${wave}/${id}`;

/** The checkout we are in, and the main checkout (shared by every worktree). */
export function locate(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const common = path.resolve(top, git(top, ['rev-parse', '--git-common-dir']));
  const main = path.dirname(common);
  return {top, common, main, root: path.resolve(process.env.WT_ROOT || path.join(main, '..', 'woodshed-wt'))};
}

function packagesAt(top) {
  const packages = loadPackages(top);
  const problems = validatePackages(packages);
  if (problems.length) throw new UsageError(`docs/ux2/packages.json is invalid:\n  ${problems.join('\n  ')}`);
  return packages;
}

function worktrees(cwd) {
  const out = [];
  let cur = null;
  for (const line of git(cwd, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) out.push(cur = {path: path.resolve(line.slice(9))});
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
  }
  return out;
}

export function envFileText(env) {
  return `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

function create(cwd, id, opts, log) {
  const {top, common, root} = locate(cwd);
  const packages = packagesAt(top);
  const index = packages.findIndex(p => p.id === id);
  if (index < 0) throw new UsageError(`unknown package ${id}`);
  const pkg = packages[index];
  const wave = opts.wave || pkg.wave;
  if (!/^[0-9A-Za-z]+x?$/.test(wave)) throw new UsageError(`bad wave ${wave}`);
  const branch = branchName(wave, id);
  const dir = path.join(root, id);
  if (existsSync(dir)) throw new UsageError(`${dir} already exists (node scripts/wt.mjs remove ${id})`);
  if (gitOk(top, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) throw new UsageError(`branch ${branch} already exists`);
  let base;
  try { base = git(top, ['rev-parse', '--verify', `${opts.base || 'HEAD'}^{commit}`]); }
  catch { throw new UsageError(`unknown base ${opts.base}`); }
  mkdirSync(root, {recursive: true});
  git(top, ['worktree', 'add', dir, '-b', branch, base]);
  const env = {
    WT_ID: id, WT_WAVE: wave, WT_BRANCH: branch, WT_BASE: base,
    FIXTURE_PORT: String(PORT_BASE + index), VITEST_MAX_WORKERS: '2',
  };
  writeFileSync(path.join(dir, '.env.worktree'), envFileText(env));
  if (!gitOk(dir, ['check-ignore', '-q', '.env.worktree'])) {
    appendFileSync(path.join(common, 'info', 'exclude'), '\n.env.worktree\n');
  }
  log(`created ${dir} on ${branch} from ${base.slice(0, 12)} (FIXTURE_PORT=${env.FIXTURE_PORT})`);
  if (!opts.install) return 0;
  const npm = process.env.WT_NPM || 'npm';
  log(`${npm} ci --prefer-offline`);
  const r = spawnSync(npm, ['ci', '--prefer-offline'], {cwd: dir, stdio: 'inherit', shell: process.platform === 'win32'});
  if (r.status !== 0) {
    log(`npm ci failed in ${dir}; fix it there or run node scripts/wt.mjs remove ${id} --force`);
    return r.status || 1;
  }
  return 0;
}

export function wavePlan(packages, wave, branches) {
  const followUp = /x$/.test(wave) && WAVES.includes(wave.slice(0, -1));
  if (!followUp && !WAVES.includes(wave)) throw new UsageError(`unknown wave ${wave}`);
  if (followUp) {
    const prefix = `ux2/${wave}/`;
    return branches.filter(b => b.startsWith(prefix)).map(b => ({id: b.slice(prefix.length), branch: b})).sort((a, b) => byId(a.id, b.id));
  }
  // Verification runs after the wave's integration (VF1–VF3) are not part of the wave's merge.
  const integrations = new Set(packages.filter(p => p.wave === wave && p.kind === 'integration').map(p => p.id));
  return packages.filter(p => p.wave === wave && p.kind !== 'integration' && !p.deps.some(d => integrations.has(d)))
    .map(p => ({id: p.id, title: p.title, branch: branchName(wave, p.id)}))
    .sort((a, b) => byId(a.id, b.id));
}

function merge(cwd, wave, opts, log) {
  const {top} = locate(cwd);
  const packages = packagesAt(top);
  const branches = git(top, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/ux2/']).split('\n').filter(Boolean);
  const plan = wavePlan(packages, wave, branches).filter(p => !opts.skip.includes(p.id));
  if (!plan.length) throw new UsageError(`nothing to merge for wave ${wave}`);
  const missing = plan.filter(p => !branches.includes(p.branch));
  const into = git(top, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (opts.dryRun) {
    log(`would merge into ${into}:`);
    for (const p of plan) {
      const state = missing.includes(p) ? ' (missing)' : gitOk(top, ['merge-base', '--is-ancestor', p.branch, 'HEAD']) ? ' (already merged)' : '';
      log(`  ${p.branch}${state}`);
    }
    return missing.length ? 1 : 0;
  }
  if (missing.length) throw new UsageError(`missing branches: ${missing.map(p => p.branch).join(', ')} (use --skip <ID> for a package with no branch)`);
  if (git(top, ['status', '--porcelain', '--untracked-files=no'])) throw new UsageError('the working tree has uncommitted changes; commit or discard them first');
  if (existsSync(path.resolve(top, git(top, ['rev-parse', '--git-path', 'MERGE_HEAD'])))) throw new UsageError('a merge is already in progress');
  for (const p of plan) {
    if (gitOk(top, ['merge-base', '--is-ancestor', p.branch, 'HEAD'])) { log(`skip   ${p.branch} (already merged)`); continue; }
    const message = `Merge ${p.branch}${p.title ? ` (${p.id}: ${p.title})` : ''} into ${into}`;
    const r = spawnSync('git', ['merge', '--no-ff', '--no-edit', '-m', message, p.branch], {cwd: top, encoding: 'utf8'});
    if (r.status !== 0) {
      const conflicts = git(top, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
      log(`CONFLICT merging ${p.branch} into ${into}:`);
      for (const f of conflicts) log(`  ${f}`);
      if (!conflicts.length) log((r.stderr || r.stdout || '').trim());
      log('The merge is left in progress: resolve and commit, or run git merge --abort. Re-run this command to continue with the remaining branches.');
      return 1;
    }
    log(`merged ${p.branch}`);
  }
  return 0;
}

function remove(cwd, id, opts, log) {
  const {top, root} = locate(cwd);
  const dir = path.join(root, id);
  const wt = worktrees(top).find(w => w.path === path.resolve(dir));
  if (!wt) throw new UsageError(`no worktree at ${dir}`);
  if (path.resolve(top) === wt.path) throw new UsageError('run remove from another checkout, not from the worktree itself');
  const merged = wt.branch ? gitOk(top, ['merge-base', '--is-ancestor', wt.branch, 'HEAD']) : false;
  if (!merged && !opts.force) throw new UsageError(`${wt.branch || wt.head} is not merged into HEAD (use --force to remove anyway)`);
  const args = ['worktree', 'remove', ...(opts.force ? ['--force'] : []), dir];
  const r = spawnSync('git', args, {cwd: top, encoding: 'utf8'});
  if (r.status !== 0) throw new UsageError(`git worktree remove failed: ${(r.stderr || '').trim()} (use --force for a dirty worktree)`);
  log(`removed ${dir}`);
  if (wt.branch && !opts.keepBranch) {
    if (merged) { git(top, ['branch', '-d', wt.branch]); log(`deleted branch ${wt.branch}`); }
    else log(`kept unmerged branch ${wt.branch}`);
  }
  return 0;
}

function list(cwd, log) {
  const {top, root} = locate(cwd);
  for (const w of worktrees(top)) {
    if (path.dirname(w.path) !== root) continue;
    const env = readWorktreeEnv(w.path);
    log(`${path.basename(w.path).padEnd(6)} ${String(w.branch || w.head).padEnd(22)} FIXTURE_PORT=${env.FIXTURE_PORT || '?'}  ${w.path}`);
  }
  return 0;
}

export function parseArgs(argv) {
  const [cmd, arg, ...rest] = argv;
  const opts = {install: true, skip: [], force: false, keepBranch: false, dryRun: false};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = () => { const v = rest[++i]; if (v === undefined) throw new UsageError(`${a} needs a value`); return v; };
    if (a === '--base') opts.base = value();
    else if (a === '--wave') opts.wave = value();
    else if (a === '--skip') opts.skip.push(value());
    else if (a === '--no-install') opts.install = false;
    else if (a === '--force') opts.force = true;
    else if (a === '--keep-branch') opts.keepBranch = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new UsageError(`unknown option ${a}`);
  }
  return {cmd, arg, opts};
}

const USAGE = 'usage: node scripts/wt.mjs create <ID> [--base <ref>] [--wave <wave>] [--no-install]\n' +
  '       node scripts/wt.mjs merge <wave> [--skip <ID>]... [--dry-run]\n' +
  '       node scripts/wt.mjs remove <ID> [--force] [--keep-branch]\n' +
  '       node scripts/wt.mjs list';

export function main(argv = process.argv.slice(2), {cwd = process.cwd(), log = console.log, error = console.error} = {}) {
  try {
    const {cmd, arg, opts} = parseArgs(argv);
    if (cmd === 'list') return list(cwd, log);
    if (!arg || !['create', 'merge', 'remove'].includes(cmd)) { error(USAGE); return 2; }
    if (cmd === 'create') return create(cwd, arg, opts, log);
    if (cmd === 'merge') return merge(cwd, arg, opts, log);
    return remove(cwd, arg, opts, log);
  } catch (e) {
    if (e instanceof UsageError) { error(e.message); return 2; }
    error(e.stderr ? String(e.stderr).trim() : e.message);
    return 1;
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(self).href) {
  process.exitCode = main();
}
