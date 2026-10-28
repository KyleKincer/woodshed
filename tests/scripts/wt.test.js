// @vitest-environment node
// scripts/wt.mjs on a scratch repository (architecture §9.0, §11.1).
import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {execFileSync, spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {wavePlan, byId, branchName, envFileText, PORT_BASE} from '../../scripts/wt.mjs';
import {loadPackages} from '../../scripts/check-ownership.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WT = path.join(repoRoot, 'scripts/wt.mjs');
const OWN = path.join(repoRoot, 'scripts/check-ownership.mjs');

const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
function write(file, text) { mkdirSync(path.dirname(file), {recursive: true}); writeFileSync(file, text); }

const PACKAGES = [
  {id: 'A1', wave: 'P', kind: 'package', title: 'Alpha', owns: ['src/a/**', 'shared.txt'], deps: []},
  {id: 'B1', wave: 'P', kind: 'package', title: 'Beta', owns: ['src/b/**'], deps: []},
  {id: 'C10', wave: 'P', kind: 'package', title: 'Gamma', owns: ['src/c/**'], deps: []},
  {id: 'C2', wave: 'P', kind: 'package', title: 'Delta', owns: ['src/d/**', 'shared.txt'], deps: []},
  {id: 'E1', wave: '0A', kind: 'package', title: 'Epsilon', owns: ['src/e/**'], deps: ['A1']},
  {id: 'I0A', wave: '0A', kind: 'integration', title: 'Integration I0A', owns: [], deps: ['E1']},
  {id: 'VF9', wave: '0A', kind: 'verification', title: 'Verification', owns: ['tests/flows/**'], deps: ['I0A']},
];

function run(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [WT, ...args], {cwd, encoding: 'utf8', env: {...process.env, ...env}});
  return {status: r.status, out: `${r.stdout}${r.stderr}`};
}

describe('wt.mjs helpers', () => {
  it('orders ids naturally', () => {
    expect(['C10', 'A1', 'C2', 'B1'].sort(byId)).toEqual(['A1', 'B1', 'C2', 'C10']);
    expect(['F4b', 'F4a', 'F10', 'F2'].sort(byId)).toEqual(['F2', 'F4a', 'F4b', 'F10']);
  });
  it('names branches ux2/<wave>/<ID>', () => expect(branchName('0B', 'ST3')).toBe('ux2/0B/ST3'));
  it('plans a wave: its packages in ID order, no integration, no post-integration verification', () => {
    expect(wavePlan(PACKAGES, 'P', []).map(p => p.branch)).toEqual(['ux2/P/A1', 'ux2/P/B1', 'ux2/P/C2', 'ux2/P/C10']);
    expect(wavePlan(PACKAGES, '0A', []).map(p => p.id)).toEqual(['E1']);
    expect(() => wavePlan(PACKAGES, '7q', [])).toThrow(/unknown wave/);
  });
  it('plans a follow-up wave from the branches that exist', () => {
    expect(wavePlan(PACKAGES, 'Px', ['ux2/Px/C2', 'ux2/P/A1', 'ux2/Px/A1']).map(p => p.branch)).toEqual(['ux2/Px/A1', 'ux2/Px/C2']);
  });
  it('plans the real waves from docs/ux2/packages.json', () => {
    const real = loadPackages(repoRoot);
    expect(wavePlan(real, 'P', []).map(p => p.id)).toEqual(['FX0', 'P0']);
    expect(wavePlan(real, '1b', []).map(p => p.id)).toEqual(['CPC', 'LB1a', 'LB1b', 'ON1', 'ST1c']);
    expect(wavePlan(real, '4', []).map(p => p.id)).toEqual(['V1', 'VF4']);
  });
  it('writes KEY=value lines', () => expect(envFileText({A: '1', B: 'x'})).toBe('A=1\nB=x\n'));
});

describe('wt.mjs on a scratch repository', () => {
  let tmp, repo, root, fakeNpmLog, fakeNpm;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'ws-wt-'));
    repo = path.join(tmp, 'woodshed');
    root = path.join(tmp, 'woodshed-wt');
    git(tmp, 'init', '-q', '-b', 'main', repo);
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) git(repo, 'config', k, v);
    write(path.join(repo, 'docs/ux2/packages.json'), JSON.stringify({packages: PACKAGES}, null, 2));
    write(path.join(repo, '.gitignore'), 'node_modules/\n.env*\n');
    write(path.join(repo, 'shared.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    // A stand-in for npm that records how it was called.
    fakeNpmLog = path.join(tmp, 'npm-calls.log');
    fakeNpm = path.join(tmp, 'fake-npm');
    write(fakeNpm, `#!/bin/sh\necho "$PWD $*" >> "${fakeNpmLog}"\nmkdir -p node_modules && echo installed > node_modules/marker\n`);
    chmodSync(fakeNpm, 0o755);
  });
  afterAll(() => {
    spawnSync('git', ['worktree', 'prune'], {cwd: repo});
    rmSync(tmp, {recursive: true, force: true});
  });

  it('create adds the worktree and branch, runs npm ci --prefer-offline and writes .env.worktree', () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const r = run(repo, ['create', 'A1'], {WT_NPM: fakeNpm});
    expect(r.out).toContain('created');
    expect(r.status).toBe(0);
    const dir = path.join(root, 'A1');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ux2/P/A1');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(base);
    expect(readFileSync(fakeNpmLog, 'utf8').trim()).toBe(`${dir} ci --prefer-offline`);
    expect(existsSync(path.join(dir, 'node_modules/marker'))).toBe(true);
    const env = readFileSync(path.join(dir, '.env.worktree'), 'utf8');
    expect(env).toContain('WT_ID=A1\n');
    expect(env).toContain('WT_BRANCH=ux2/P/A1\n');
    expect(env).toContain(`WT_BASE=${base}\n`);
    expect(env).toContain(`FIXTURE_PORT=${PORT_BASE + 0}\n`);
    expect(env).toContain('VITEST_MAX_WORKERS=2\n');
    expect(git(dir, 'status', '--porcelain')).toBe(''); // .env.worktree and node_modules stay ignored
  });

  it('gives each package its own fixture port', () => {
    for (const id of ['B1', 'C2', 'C10']) expect(run(repo, ['create', id, '--no-install']).status).toBe(0);
    const port = id => /FIXTURE_PORT=(\d+)/.exec(readFileSync(path.join(root, id, '.env.worktree'), 'utf8'))[1];
    expect([port('A1'), port('B1'), port('C10'), port('C2')]).toEqual(['5200', '5201', '5202', '5203']);
    expect(readFileSync(fakeNpmLog, 'utf8').trim().split('\n')).toHaveLength(1); // --no-install skipped npm
  });

  it('refuses an unknown package, an existing worktree and an existing branch', () => {
    expect(run(repo, ['create', 'ZZ9', '--no-install']).out).toMatch(/unknown package/);
    const again = run(repo, ['create', 'A1', '--no-install']);
    expect(again.status).toBe(2);
    expect(again.out).toMatch(/already exists/);
    expect(run(repo, ['create', 'A1', '--no-install', '--bogus']).status).toBe(2);
    expect(run(repo, []).status).toBe(2);
  });

  it('check-ownership runs inside a worktree from .env.worktree', () => {
    const dir = path.join(root, 'A1');
    write(path.join(dir, 'src/a/one.js'), 'export default 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'A1 work');
    const ok = spawnSync(process.execPath, [OWN], {cwd: dir, encoding: 'utf8'});
    expect(ok.stdout).toContain('check-ownership A1 (wave P)');
    expect(ok.status).toBe(0);
    write(path.join(dir, 'src/b/stray.js'), '\n');
    const bad = spawnSync(process.execPath, [OWN], {cwd: dir, encoding: 'utf8'});
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/UNOWNED\s+src\/b\/stray\.js\s+\(owned by B1 \(wave P\)\)/);
    rmSync(path.join(dir, 'src/b'), {recursive: true});
  });

  it('merge merges the wave in ID order with --no-ff and skips what is already merged', () => {
    for (const [id, file] of [['B1', 'src/b/two.js'], ['C2', 'src/d/four.js'], ['C10', 'src/c/three.js']]) {
      const dir = path.join(root, id);
      write(path.join(dir, file), `${id}\n`);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', `${id} work`);
    }
    const dry = run(repo, ['merge', 'P', '--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.out).toMatch(/ux2\/P\/A1\n\s+ux2\/P\/B1\n\s+ux2\/P\/C2\n\s+ux2\/P\/C10/);
    const r = run(repo, ['merge', 'P']);
    expect(r.out).toContain('merged ux2/P/C10');
    expect(r.status).toBe(0);
    const merges = git(repo, 'log', '--merges', '--format=%P|%s', 'main').split('\n').reverse();
    expect(merges.map(m => m.split('|')[1])).toEqual([
      'Merge ux2/P/A1 (A1: Alpha) into main', 'Merge ux2/P/B1 (B1: Beta) into main',
      'Merge ux2/P/C2 (C2: Delta) into main', 'Merge ux2/P/C10 (C10: Gamma) into main',
    ]);
    for (const m of merges) expect(m.split('|')[0].split(' ')).toHaveLength(2); // real merge commits
    for (const f of ['src/a/one.js', 'src/b/two.js', 'src/c/three.js', 'src/d/four.js']) expect(existsSync(path.join(repo, f)), f).toBe(true);
    const again = run(repo, ['merge', 'P']);
    expect(again.status).toBe(0);
    expect(again.out.match(/already merged/g)).toHaveLength(4);
  });

  it('merge stops at the first conflict, prints it and leaves the merge in progress', () => {
    const tip = git(repo, 'rev-parse', 'HEAD');
    for (const id of ['A1', 'C2']) {
      const dir = path.join(root, id);
      git(dir, 'merge', '-q', '--ff-only', tip);
      write(path.join(dir, 'shared.txt'), `${id} edit\n`);
      git(dir, 'commit', '-q', '-am', `${id} edits shared.txt`);
    }
    const r = run(repo, ['merge', 'P']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('merged ux2/P/A1');
    expect(r.out).toMatch(/CONFLICT merging ux2\/P\/C2 into main:\n\s+shared\.txt/);
    expect(r.out).not.toContain('ux2/P/C10 (already merged)'); // stopped before C10
    expect(existsSync(path.join(repo, '.git/MERGE_HEAD'))).toBe(true);
    expect(run(repo, ['merge', 'P']).out).toMatch(/already in progress|uncommitted changes/);
    git(repo, 'merge', '--abort');
  });

  it('merge refuses missing branches unless skipped, and a dirty tree', () => {
    expect(run(repo, ['merge', '0A']).out).toMatch(/missing branches: ux2\/0A\/E1/);
    expect(run(repo, ['merge', '0A', '--skip', 'E1']).out).toMatch(/nothing to merge/);
    write(path.join(repo, 'shared.txt'), 'dirty\n');
    expect(run(repo, ['merge', 'P']).out).toMatch(/uncommitted changes/);
    git(repo, 'checkout', '--', 'shared.txt');
  });

  it('merges a follow-up wave from its ticket branches', () => {
    expect(run(repo, ['create', 'B1', '--wave', 'Px', '--no-install']).out).toMatch(/already exists/); // B1's worktree is still there
    expect(run(repo, ['remove', 'B1']).status).toBe(0);
    expect(run(repo, ['create', 'B1', '--wave', 'Px', '--no-install']).status).toBe(0);
    const dir = path.join(root, 'B1');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ux2/Px/B1');
    write(path.join(dir, 'src/b/ticket.js'), 'fix\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'ticket');
    const r = run(repo, ['merge', 'Px']);
    expect(r.out).toContain('merged ux2/Px/B1');
    expect(r.status).toBe(0);
  });

  it('remove deletes a merged worktree and its branch, and refuses an unmerged one without --force', () => {
    expect(run(repo, ['remove', 'B1']).status).toBe(0);
    expect(existsSync(path.join(root, 'B1'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'ux2/Px/B1')).toBe('');
    const unmerged = run(repo, ['remove', 'C2']); // C2's conflicting commit was never merged
    expect(unmerged.status).toBe(2);
    expect(unmerged.out).toMatch(/not merged/);
    const forced = run(repo, ['remove', 'C2', '--force']);
    expect(forced.status).toBe(0);
    expect(forced.out).toContain('kept unmerged branch ux2/P/C2');
    expect(git(repo, 'branch', '--list', 'ux2/P/C2')).not.toBe('');
    expect(run(repo, ['remove', 'C2']).out).toMatch(/no worktree/);
  });

  it('list shows the remaining worktrees with their ports', () => {
    const r = run(repo, ['list']);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/A1\s+ux2\/P\/A1\s+FIXTURE_PORT=5200/);
    expect(r.out).not.toMatch(/B1/);
  });
});
