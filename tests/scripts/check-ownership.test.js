// @vitest-environment node
// scripts/check-ownership.mjs and docs/ux2/packages.json (architecture §9.0, §11.1).
import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  WAVES, expandBraces, matchGlob, ownsPath, samplePaths, loadPackages, validatePackages,
  findOverlaps, moduleTestNames, ownedModules, namedAllowance, checkOwnership, allowance, modulesFor,
} from '../../scripts/check-ownership.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(repo, 'scripts/check-ownership.mjs');
const packages = loadPackages(repo);
const byId = Object.fromEntries(packages.map(p => [p.id, p]));
const tracked = execFileSync('git', ['ls-files'], {cwd: repo, encoding: 'utf8'}).split('\n').filter(Boolean);

// ---------- §9 of the contract, parsed independently of packages.json ----------

const ROOT_PATH = /^(src|tests|convex|companion|desktop|scripts|shared|public|docs|build)\/|^(index\.html|package\.json|package-lock\.json|vercel\.json|\.gitignore)$/;
function parseContract() {
  const doc = readFileSync(path.join(repo, 'docs/ux2/architecture.md'), 'utf8');
  const section = doc.slice(doc.indexOf('### 9.1 Wave P'), doc.indexOf('### 9.19 Owner gates'));
  const rows = [];
  let wave = null;
  for (const line of section.split('\n')) {
    let m;
    if ((m = /^### 9\.\d+ Wave (\S+):/.exec(line))) { wave = m[1]; continue; }
    if ((m = /^### 9\.\d+ Integration (.*)$/.exec(line))) {
      for (const id of m[1].match(/\b(I\d[A-Za-z]*|VF\d)\b/g)) rows.push({id, wave, kind: id.startsWith('VF') ? 'verification' : 'integration'});
      continue;
    }
    if ((m = /^\| \*\*([A-Za-z0-9]+)\*\* \| ([^|]*) \| ([^|]*) \| ([^|]*) \|/.exec(line))) {
      const tokens = [...m[3].matchAll(/`([^`]+)`/g)].map(x => x[1])
        .filter(t => ROOT_PATH.test(t) && !/[<…]/.test(t) && !t.endsWith('/'));
      rows.push({id: m[1], wave, kind: m[1].startsWith('VF') ? 'verification' : 'package', title: m[2].trim(), tokens, deps: m[4].trim()});
    }
  }
  return rows;
}
const contract = parseContract();
const INTEGRATION_OF = {'0A': 'I0A', '0B': 'I0B', '1a': 'I1', '1b': 'I1b', '2a': 'I2a', '2b': 'I2b', '3a': 'I3a', '3b': 'I3b'};
function contractDeps(row) {
  if (row.kind === 'integration') return contract.filter(r => r.wave === row.wave && r.kind === 'package').map(r => r.id);
  if (row.deps === undefined) return [INTEGRATION_OF[row.wave]]; // VF1–VF3 follow their wave's integration
  if (row.deps === '—') return [];
  return [...new Set(row.deps.split(',').map(s => s.trim()).flatMap(d =>
    d === 'P' ? contract.filter(r => r.wave === 'P').map(r => r.id) : INTEGRATION_OF[d] ? [INTEGRATION_OF[d]] : [d]))];
}

describe('docs/ux2/packages.json', () => {
  it('is structurally valid', () => {
    expect(validatePackages(packages)).toEqual([]);
  });

  it('contains every package, integration and verification run in §9, in the right wave', () => {
    expect(contract.length).toBeGreaterThan(70);
    expect(packages.map(p => p.id)).toEqual(contract.map(r => r.id));
    for (const row of contract) {
      expect(byId[row.id], row.id).toBeDefined();
      expect(byId[row.id].wave, row.id).toBe(row.wave);
      expect(byId[row.id].kind, row.id).toBe(row.kind);
      if (row.title) expect(byId[row.id].title, row.id).toBe(row.title);
    }
  });

  it('records the deps column of §9', () => {
    for (const row of contract) expect([...byId[row.id].deps].sort(), row.id).toEqual(contractDeps(row).sort());
  });

  it('owns every path the Owns column names', () => {
    const missing = [];
    for (const row of contract.filter(r => r.tokens)) {
      const pkg = byId[row.id];
      for (const token of row.tokens) {
        for (const t of expandBraces(token)) {
          const covered = /[*?]/.test(t)
            ? pkg.owns.includes(t) || pkg.owns.some(g => !g.startsWith('!') && samplePaths(g).some(s => matchGlob(s, t)))
            : ownsPath(pkg.owns, t);
          if (!covered) missing.push(`${row.id}: ${t}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('has no overlapping globs within a wave', () => {
    expect(findOverlaps(packages, tracked)).toEqual([]);
  });

  it('gives integrations no files and every package something', () => {
    for (const p of packages) {
      if (p.kind === 'integration') expect(p.owns, p.id).toEqual([]);
      else expect(p.owns.filter(g => !g.startsWith('!')).length, p.id).toBeGreaterThan(0);
    }
  });

  it('keeps FX0’s baselines and harness out of FX1', () => {
    for (const f of ['tests/fixture/baselines/legacy/score-geometry.json', 'tests/fixture/harness/score-geometry.html',
      'tests/fixture/harness/score-geometry.js', 'tests/fixture/probes/probe-geometry.cjs', 'tests/fixture/probes/probe-perf-legacy.cjs']) {
      expect(ownsPath(byId.FX0.owns, f), f).toBe(true);
      expect(ownsPath(byId.FX1.owns, f), f).toBe(false);
    }
    expect(ownsPath(byId.FX1.owns, 'tests/fixture/db/songs.js')).toBe(true);
    expect(ownsPath(byId.BK1.owns, 'tests/fixture/db/songs.js')).toBe(true);
  });
});

describe('validatePackages and findOverlaps', () => {
  const base = () => [
    {id: 'A1', wave: 'P', kind: 'package', title: 'A', owns: ['src/a/**'], deps: []},
    {id: 'B1', wave: '0A', kind: 'package', title: 'B', owns: ['src/b/{x,y}.js'], deps: ['A1']},
    {id: 'I0A', wave: '0A', kind: 'integration', title: 'I', owns: [], deps: ['B1']},
  ];
  it('accepts a valid list', () => expect(validatePackages(base())).toEqual([]));
  it.each([
    ['duplicate id', l => l.push({...l[0]}), /duplicate id/],
    ['unknown wave', l => { l[0].wave = '9z'; }, /unknown wave/],
    ['unknown kind', l => { l[0].kind = 'misc'; }, /unknown kind/],
    ['missing title', l => { l[0].title = ''; }, /missing title/],
    ['absolute glob', l => { l[0].owns = ['/etc/x']; }, /relative/],
    ['empty package', l => { l[1].owns = ['!src/b/x.js']; }, /must own something/],
    ['unknown dep', l => { l[1].deps = ['Z9']; }, /unknown dep Z9/],
    ['duplicate dep', l => { l[1].deps = ['A1', 'A1']; }, /duplicate deps/],
    ['dep not earlier', l => { l[0].deps = ['B1']; }, /not before wave/],
  ])('rejects %s', (_, mutate, re) => {
    const l = base();
    mutate(l);
    expect(validatePackages(l).join('\n')).toMatch(re);
  });
  it('lets an integration depend on its own wave', () => {
    expect(validatePackages(base()).some(p => p.startsWith('I0A'))).toBe(false);
  });
  it('finds a glob/literal overlap and a glob/glob overlap within a wave only', () => {
    const l = [
      {id: 'A1', wave: '0A', kind: 'package', title: 'A', owns: ['tests/fixture/**', '!tests/fixture/keep/**'], deps: []},
      {id: 'B1', wave: '0A', kind: 'package', title: 'B', owns: ['tests/fixture/db/{songs,jobs}.js'], deps: []},
      {id: 'C1', wave: '0A', kind: 'package', title: 'C', owns: ['tests/fixture/keep/*.json'], deps: []},
      {id: 'D1', wave: '0B', kind: 'package', title: 'D', owns: ['tests/fixture/**'], deps: []},
      {id: 'E1', wave: '0B', kind: 'package', title: 'E', owns: ['src/**/*.css'], deps: []},
      {id: 'F1', wave: '0B', kind: 'package', title: 'F', owns: ['src/styles/views/*.css'], deps: []},
    ];
    const found = findOverlaps(l).map(o => `${o.wave} ${o.owners.join('+')} ${o.file}`);
    expect(found).toContain('0A A1+B1 tests/fixture/db/songs.js');
    expect(found).toContain('0A A1+B1 tests/fixture/db/jobs.js');
    expect(found.some(f => f.startsWith('0A') && f.includes('C1'))).toBe(false); // excluded by "!"
    expect(found.some(f => f.startsWith('0B E1+F1 src/styles/views/'))).toBe(true);
    expect(found.some(f => f.includes('D1'))).toBe(false); // D1 is alone with tests/ in 0B
  });
});

describe('glob helpers', () => {
  it('expands braces, nested and repeated', () => {
    expect(expandBraces('src/app/{keys,commands}.js')).toEqual(['src/app/keys.js', 'src/app/commands.js']);
    expect(expandBraces('a/{b,c{d,e}}/{x,y}.js')).toEqual(['a/b/x.js', 'a/b/y.js', 'a/cd/x.js', 'a/cd/y.js', 'a/ce/x.js', 'a/ce/y.js']);
    expect(expandBraces('public/icon-{180,192,512}.png')).toHaveLength(3);
    expect(expandBraces('plain.js')).toEqual(['plain.js']);
  });
  it('matches literals exactly and wildcards with matchesGlob', () => {
    expect(matchGlob('src/styles/fonts/a.woff2', 'src/styles/fonts/*')).toBe(true);
    expect(matchGlob('src/styles/fonts/x/a.woff2', 'src/styles/fonts/*')).toBe(false);
    expect(matchGlob('tests/fixture/a/b/c.js', 'tests/fixture/**')).toBe(true);
    expect(matchGlob('src/app/keys.js', 'src/app/{keys,commands}.js')).toBe(true);
    expect(matchGlob('src/app/keys.jsx', 'src/app/{keys,commands}.js')).toBe(false);
    expect(matchGlob('.gitignore', '.gitignore')).toBe(true);
  });
  it('applies "!" exclusions after the positive globs', () => {
    const owns = ['tests/fixture/**', '!tests/fixture/baselines/legacy/**'];
    expect(ownsPath(owns, 'tests/fixture/db/seed.js')).toBe(true);
    expect(ownsPath(owns, 'tests/fixture/baselines/legacy/a.png')).toBe(false);
    expect(ownsPath(['!a/**'], 'a/b')).toBe(false);
  });
  it('samples concrete paths that the glob itself matches', () => {
    for (const g of ['tests/fixture/**', 'src/styles/primitives/*.css', 'tests/harness/**/x.harness.js', 'a/{b,c}/*.js']) {
      const samples = samplePaths(g);
      expect(samples.length, g).toBeGreaterThan(0);
      for (const s of samples) expect(matchGlob(s, g), `${s} ~ ${g}`).toBe(true);
    }
  });
});

describe('test files named after a package’s modules', () => {
  it('derives the names a module’s tests may carry', () => {
    expect(moduleTestNames('src/app/keys.js')).toEqual(['keys', 'app-keys']);
    expect(moduleTestNames('src/edit/map/view.js')).toEqual(['view', 'map-view', 'edit-map-view']);
    expect(moduleTestNames('src/js/notation/chart.js')).toEqual(['chart', 'notation-chart']);
    expect(moduleTestNames('convex/songs.ts')).toEqual(['songs', 'convex-songs']);
    expect(moduleTestNames('tests/app-keys.test.js')).toEqual([]);
    expect(moduleTestNames('src/styles/tokens.css')).toEqual([]);
  });
  const allowed = (id, file) => namedAllowance(byId[id], file, ownedModules(byId[id], tracked));
  it.each([
    ['F3', 'tests/app-keys.test.js', 'module test'],
    ['F3', 'tests/keys.test.js', 'module test'],
    ['ED3', 'tests/edit-map-view.test.js', 'module test'],
    ['BK1', 'convex/songs.test.ts', 'module test'],
    ['DT1', 'desktop/menu.test.cjs', 'module test'],
    ['CPA', 'companion/lookup.test.mjs', 'module test'],
    ['CPC', 'companion/test_sections.py', 'module test'],
    ['P0', 'tests/scripts/wt.test.js', 'module test'],
    ['ST6', 'tests/harness/stage/strip.harness.js', 'harness'],
    ['U1', 'tests/fixture/states/U1.cjs', 'state'],
  ])('%s may change %s (%s)', (id, file, kind) => expect(allowed(id, file)).toBe(kind));
  it.each([
    ['F3', 'tests/app-store.test.js'],
    ['F3', 'tests/fixture/states/F2.cjs'],
    ['BK1', 'convex/jobs.test.ts'],
    ['BK1', 'tests/jobs.test.js'],
    ['ST6', 'tests/harness/stage/hud.harness.js'],
    ['CPC', 'convex/test_sections.py'],
  ])('%s may not change %s', (id, file) => expect(allowed(id, file)).toBe(null));
});

describe('naming rules never let two packages of one wave change one path', () => {
  const check = (id, file) => checkOwnership({packages, id, files: [file], knownPaths: tracked}).rows[0];
  it.each([
    ['BK3', 'convex/admin.test.ts', 'owned by BK1 (wave 0B)'], // BK3 owns convex/admin.ts; BK1 owns the test
    ['ED2', 'tests/commands.test.js', 'named after modules of ED2, ED3, ED5 in wave 3a'],
    ['ED3', 'tests/commands.test.js', 'named after modules of ED2, ED3, ED5 in wave 3a'],
    ['ED5', 'tests/commands.test.js', 'named after modules of ED2, ED3, ED5 in wave 3a'],
    ['ED3', 'tests/harness/edit/commands.harness.js', 'named after modules of ED2, ED3, ED5 in wave 3a'],
    ['U2', 'tests/position.test.js', 'named after modules of ST0, U2 in wave 0B'],
    ['ST0', 'tests/position.test.js', 'named after modules of ST0, U2 in wave 0B'],
    ['BK1', 'tests/storage.test.js', 'named after modules of BK1, BK3 in wave 0B'],
    ['SE1', 'tests/account.test.js', 'named after modules of SE1, SE3 in wave 2a'],
    ['SE3', 'tests/account.test.js', 'named after modules of SE1, SE3 in wave 2a'],
    ['BK2', 'tests/harness/library/jobs.harness.js', 'owned by LB1b (wave 1b)'], // listed literally by a later package
    ['ST0', 'tests/harness/stage/frame.harness.js', 'owned by ST4 (wave 2a)'],
  ])('%s may not change %s', (id, file, detail) => {
    const row = check(id, file);
    expect(row.status).toBe('unowned');
    expect(row.detail).toContain(detail);
  });
  it.each([
    ['BK1', 'convex/admin.test.ts', 'owned'],
    ['ED3', 'tests/edit-map-commands.test.js', 'named'],
    ['ED3', 'tests/harness/edit/map-commands.harness.js', 'named'],
    ['ED5', 'tests/chart-commands.test.js', 'named'],
    ['F3', 'tests/fixture/states/F3.cjs', 'named'], // FX1's tests/fixture/** leaves the per-package states alone
    ['FX1', 'tests/fixture/states/FX1.cjs', 'named'],
  ])('%s may still change %s (%s)', (id, file, status) => expect(check(id, file).status).toBe(status));
  it('lets FX1 own no other package’s states file', () => {
    expect(ownsPath(byId.FX1.owns, 'tests/fixture/states/F3.cjs')).toBe(false);
    expect(check('FX1', 'tests/fixture/states/F3.cjs').status).toBe('unowned');
  });

  it('a glob of a later wave does not block a naming rule; a same-wave glob or any literal entry does', () => {
    const l = [
      {id: 'A1', wave: '0A', kind: 'package', title: 'A', owns: ['src/a/keys.js', 'src/a/menu.js'], deps: []},
      {id: 'B1', wave: '0A', kind: 'package', title: 'B', owns: ['tests/b-*.test.js', 'src/b/x.js'], deps: []},
      {id: 'C1', wave: '0B', kind: 'package', title: 'C', owns: ['tests/*.test.js', 'tests/a-menu.test.js'], deps: []},
      {id: 'D1', wave: '0A', kind: 'package', title: 'D', owns: ['src/d/keys.js'], deps: []},
    ];
    const st = (id, file) => checkOwnership({packages: l, id, files: [file]}).rows[0];
    expect(st('A1', 'tests/a-keys.test.js').status).toBe('named'); // C1's tests/*.test.js is a later wave
    expect(st('A1', 'tests/a-menu.test.js')).toMatchObject({status: 'unowned', detail: 'owned by C1 (wave 0B)'});
    expect(st('A1', 'tests/keys.test.js')).toMatchObject({status: 'unowned', detail: expect.stringMatching(/A1, D1 in wave 0A/)});
    expect(st('D1', 'tests/d-keys.test.js').status).toBe('named');
    l[0].owns.push('src/b-thing.js');
    expect(st('A1', 'tests/b-thing.test.js')).toMatchObject({status: 'unowned', detail: 'owned by B1 (wave 0A)'});
  });

  it('holds for every wave over every name the rules would grant', () => {
    const mods = modulesFor(tracked);
    const shared = [];
    let candidates = 0;
    for (const wave of WAVES) {
      const peers = packages.filter(p => p.wave === wave && p.kind !== 'integration');
      const names = new Set();
      for (const p of peers) {
        for (const m of mods(p)) {
          const forms = moduleTestNames(m);
          if (!forms.length) continue;
          const dir = path.posix.dirname(m);
          for (const n of forms) { names.add(`tests/${n}.test.js`); names.add(`tests/harness/x/${n}.harness.js`); }
          names.add(`${dir}/${forms[0]}.test.${m.endsWith('.ts') ? 'ts' : 'js'}`);
          names.add(`${dir}/test_${forms[0]}.py`);
          const segs = forms[forms.length - 1].split('-');
          for (let k = 1; k < segs.length; k++) {
            names.add(`tests/${segs.slice(0, k).join('/')}/${segs.slice(k).join('-')}.test.js`);
            names.add(`tests/harness/${segs.slice(0, k).join('/')}/${segs.slice(k).join('-')}.harness.js`);
          }
        }
        names.add(`tests/fixture/states/${p.id}.cjs`);
      }
      for (const file of names) {
        candidates++;
        const ok = peers.filter(p => allowance(packages, p, file, mods).status).map(p => p.id);
        if (ok.length > 1) shared.push(`${wave} ${file}: ${ok.join(', ')}`);
      }
    }
    expect(candidates).toBeGreaterThan(1000);
    expect(shared).toEqual([]);
  }, 60_000);
});

describe('checkOwnership', () => {
  it('classifies owned, named, declared, peer and unowned paths', () => {
    const files = ['src/app/keys.js', 'tests/app-keys.test.js', 'tests/old-ui.test.js', 'src/app/store.js', 'src/js/engine.js', 'README.md'];
    const strict = checkOwnership({packages, id: 'F3', files, knownPaths: tracked, allow: ['tests/old-ui.test.js']});
    const status = Object.fromEntries(strict.rows.map(r => [r.file, r]));
    expect(status['src/app/keys.js'].status).toBe('owned');
    expect(status['tests/app-keys.test.js'].status).toBe('owned');
    expect(status['tests/old-ui.test.js'].status).toBe('declared');
    expect(status['src/app/store.js']).toMatchObject({status: 'unowned', detail: 'owned by F2 (wave 0A)'});
    expect(status['README.md']).toMatchObject({status: 'unowned', detail: 'no package owns it'});
    expect(strict.ok).toBe(false);
    const peers = checkOwnership({packages, id: 'F3', files: files.filter(f => f !== 'README.md'), knownPaths: tracked, allowPeers: true, allow: ['tests/old-ui.test.js']});
    expect(peers.rows.find(r => r.file === 'src/app/store.js')).toMatchObject({status: 'peer', detail: 'F2'});
    expect(peers.rows.find(r => r.file === 'src/js/engine.js')).toMatchObject({status: 'peer', detail: 'F4a'});
    expect(peers.ok).toBe(true);
    // A path a later-wave package owns is never a peer.
    const later = checkOwnership({packages, id: 'F3', files: ['src/stage/hud.js'], allowPeers: true});
    expect(later.rows[0]).toMatchObject({status: 'unowned', detail: 'owned by ST5 (wave 2a)'});
  });
  it('throws for an unknown package', () => {
    expect(() => checkOwnership({packages, id: 'NOPE', files: []})).toThrow(/unknown package/);
  });
});

// ---------- the CLI on a scratch repository ----------

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
}
function scratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-own-'));
  const r = path.join(dir, 'repo');
  mkdirSync(path.join(r, 'docs/ux2'), {recursive: true});
  sh(dir, 'git', ['init', '-q', '-b', 'main', r]);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) sh(r, 'git', ['config', k, v]);
  writeFileSync(path.join(r, 'docs/ux2/packages.json'), JSON.stringify({packages: [
    {id: 'A1', wave: 'P', kind: 'package', title: 'Alpha', owns: ['src/a/**'], deps: []},
    {id: 'B1', wave: 'P', kind: 'package', title: 'Beta', owns: ['src/b/{one,two}.js'], deps: []},
    {id: 'C1', wave: '0A', kind: 'package', title: 'Gamma', owns: ['src/c.js'], deps: ['A1']},
    {id: 'I0A', wave: '0A', kind: 'integration', title: 'Integration', owns: [], deps: ['C1']},
  ]}, null, 2));
  mkdirSync(path.join(r, 'src/a'), {recursive: true});
  writeFileSync(path.join(r, 'src/a/x.js'), 'export const x = 1;\n');
  writeFileSync(path.join(r, 'README.md'), 'scratch\n');
  sh(r, 'git', ['add', '-A']);
  sh(r, 'git', ['commit', '-q', '-m', 'base']);
  return {dir, repo: r};
}
const run = (cwd, args) => spawnSync(process.execPath, [SCRIPT, ...args], {cwd, encoding: 'utf8'});

// The CLI blocks spawn git on a scratch repository; the release workflow's
// Windows runner skips them (Linux and macOS cover them).
describe.skipIf(process.platform === 'win32')('check-ownership CLI', () => {
  let s;
  beforeAll(() => { s = scratchRepo(); });
  afterAll(() => rmSync(s.dir, {recursive: true, force: true}));

  it('passes when every changed path is owned, including untracked files and named tests', () => {
    writeFileSync(path.join(s.repo, 'src/a/x.js'), 'export const x = 2;\n');
    mkdirSync(path.join(s.repo, 'tests'), {recursive: true});
    writeFileSync(path.join(s.repo, 'tests/a-x.test.js'), '\n');
    const r = run(s.repo, ['A1']);
    expect(r.stdout).toContain('OK: every path belongs to A1');
    expect(r.status).toBe(0);
  });

  it('flags an unowned path and names its owner', () => {
    mkdirSync(path.join(s.repo, 'src/b'), {recursive: true});
    writeFileSync(path.join(s.repo, 'src/b/one.js'), '\n');
    writeFileSync(path.join(s.repo, 'README.md'), 'changed\n');
    const r = run(s.repo, ['A1']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/UNOWNED\s+README\.md\s+\(no package owns it\)/);
    expect(r.stdout).toMatch(/UNOWNED\s+src\/b\/one\.js\s+\(owned by B1 \(wave P\)\)/);
    expect(r.stdout).toContain('FAIL: 2 path(s)');
  });

  it('reports same-wave peers without failing under --allow-peers, and honours --allow', () => {
    const r = run(s.repo, ['A1', '--allow-peers', '--allow', 'README.md']);
    expect(r.stdout).toMatch(/peer\s+src\/b\/one\.js\s+\(B1\)/);
    expect(r.stdout).toMatch(/declared\s+README\.md/);
    expect(r.status).toBe(0);
    const json = JSON.parse(run(s.repo, ['A1', '--json']).stdout);
    expect(json.ok).toBe(false);
    expect(json.rows.find(x => x.file === 'README.md').status).toBe('unowned');
  });

  it('checks committed changes against --base and WT_BASE', () => {
    rmSync(path.join(s.repo, 'src/b'), {recursive: true});
    sh(s.repo, 'git', ['checkout', '-q', '--', 'README.md']);
    const base = sh(s.repo, 'git', ['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(s.repo, 'src/c.js'), '\n');
    sh(s.repo, 'git', ['add', 'src/c.js']);
    sh(s.repo, 'git', ['commit', '-q', '-m', 'c']);
    rmSync(path.join(s.repo, 'tests'), {recursive: true});
    sh(s.repo, 'git', ['checkout', '-q', '--', 'src/a/x.js']);
    expect(run(s.repo, ['C1']).stdout).toContain('0 changed path(s)');
    const r = run(s.repo, ['C1', '--base', base]);
    expect(r.stdout).toMatch(/ok\s+src\/c\.js/);
    expect(r.status).toBe(0);
    expect(run(s.repo, ['A1', '--base', base]).status).toBe(1);
    writeFileSync(path.join(s.repo, '.env.worktree'), `WT_ID=C1\nWT_BASE=${base}\n`);
    writeFileSync(path.join(s.repo, '.git/info/exclude'), '.env.worktree\n');
    const fromEnv = run(s.repo, []);
    expect(fromEnv.stdout).toContain(`check-ownership C1 (wave 0A) against ${base}`);
    expect(fromEnv.status).toBe(0);
  });

  it('refuses unknown packages and skips integrations', () => {
    expect(run(s.repo, ['ZZ']).status).toBe(2);
    const r = run(s.repo, ['I0A']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/integration/);
    expect(run(s.repo, ['A1', '--bogus']).status).toBe(2);
  });

  it('refuses an invalid packages.json', () => {
    const file = path.join(s.repo, 'docs/ux2/packages.json');
    const good = readFileSync(file, 'utf8');
    writeFileSync(file, JSON.stringify({packages: [{id: 'A1', wave: 'nope', kind: 'package', title: 'x', owns: ['a'], deps: []}]}));
    try {
      const r = run(s.repo, ['A1']);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/unknown wave/);
    } finally { writeFileSync(file, good); }
  });
});

it('lists every wave in order', () => {
  expect(WAVES).toEqual(['P', '0A', '0B', '1a', '1b', '2a', '2b', '3a', '3b', '4']);
});
