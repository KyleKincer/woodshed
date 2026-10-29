// @vitest-environment node
// P0 toolchain: pinned devDependencies, npm scripts, and fixture servers that
// run side by side (architecture §0.1, §9.1 P0, §11.2).
//
// The side-by-side check starts two fixture servers on two free ports. Set
// FIXTURE_PORTS=5191,5192 to run it on the contract's ports.
import {describe, it, expect, afterAll} from 'vitest';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
const cacheRoot = path.join(repo, 'tests/fixture/.vite-cache');
// The process-spawning checks use `npm` without a shell and POSIX process
// groups; the release workflow's Windows runner skips them.
const posix = process.platform !== 'win32';

const PINNED = {
  '@fontsource-variable/atkinson-hyperlegible-next': '5.3.0',
  '@fontsource-variable/atkinson-hyperlegible-mono': '5.3.0',
  'lucide-static': '1.62.0',
  'axe-core': '4.10.3',
};

describe('devDependencies (§0.1)', () => {
  it.each(Object.entries(PINNED))('%s is pinned exactly at %s in package.json and the lockfile', (name, version) => {
    expect(pkg.devDependencies[name]).toBe(version);
    expect(pkg.dependencies?.[name]).toBeUndefined();
    expect(lock.packages[''].devDependencies[name]).toBe(version);
    const entry = lock.packages[`node_modules/${name}`];
    expect(entry.version).toBe(version);
    expect(entry.dev).toBe(true);
    expect(entry.resolved).toMatch(new RegExp(`/-/${name.split('/').pop()}-${version.replace(/\./g, '\\.')}\\.tgz$`));
    expect(entry.integrity).toMatch(/^sha512-/);
  });

  it.each(Object.entries(PINNED))('%s resolves to %s in node_modules', (name, version) => {
    const installed = JSON.parse(readFileSync(path.join(repo, 'node_modules', name, 'package.json'), 'utf8'));
    expect(installed.version).toBe(version);
  });

  it('adds no runtime dependency and keeps the lockfile in step with package.json', () => {
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[''].dependencies).toEqual(pkg.dependencies);
    expect(lock.packages[''].devDependencies).toEqual(pkg.devDependencies);
  });

  it('ships what the styles system needs: variable woff2 files, the Lucide sprite and axe', () => {
    for (const face of ['next', 'mono']) {
      const dir = path.join(repo, `node_modules/@fontsource-variable/atkinson-hyperlegible-${face}/files`);
      expect(existsSync(path.join(dir, `atkinson-hyperlegible-${face}-latin-wght-normal.woff2`)), face).toBe(true);
    }
    expect(existsSync(path.join(repo, 'node_modules/lucide-static/sprite.svg'))).toBe(true);
    expect(existsSync(path.join(repo, 'node_modules/axe-core/axe.min.js'))).toBe(true);
  });

  it.runIf(posix)('npm ls finds the four packages at their pinned versions', () => {
    const r = spawnSync('npm', ['ls', ...Object.keys(PINNED), '--json'], {cwd: repo, encoding: 'utf8'});
    expect(r.status).toBe(0);
    const deps = JSON.parse(r.stdout).dependencies;
    for (const [name, version] of Object.entries(PINNED)) expect(deps[name].version, name).toBe(version);
  }, 60_000);
});

describe('npm scripts (§9.1 P0)', () => {
  it('caps vitest workers at VITEST_MAX_WORKERS, default 2', () => {
    expect(pkg.scripts.test).toBe('vitest run --maxWorkers=${VITEST_MAX_WORKERS:-2}');
  });
  it('runs the fixture on FIXTURE_PORT (no hard-coded port)', () => {
    expect(pkg.scripts.fixture).toBe('vite --config tests/fixture/vite.config.mjs');
  });
  it('defines fixture:capture, fixture:compare and check:ownership', () => {
    expect(pkg.scripts['fixture:capture']).toMatch(/node tests\/fixture\/lib\/runner\.cjs$/);
    expect(pkg.scripts['fixture:capture']).toContain('NODE_PATH=${NODE_PATH:-/opt/node-tools/node_modules}');
    expect(pkg.scripts['fixture:compare']).toBe('python3 -I scripts/compare-shots.py');
    expect(pkg.scripts['check:ownership']).toBe('node scripts/check-ownership.mjs');
    expect(existsSync(path.join(repo, 'scripts/check-ownership.mjs'))).toBe(true);
  });
  it('ignores the fixture output and the per-port Vite caches', () => {
    const ignore = readFileSync(path.join(repo, '.gitignore'), 'utf8').split('\n');
    expect(ignore).toContain('tests/fixture/out/');
    expect(ignore).toContain('tests/fixture/.vite-cache/');
    for (const f of ['tests/fixture/.vite-cache/5191/deps/x.js', 'tests/fixture/out/a.png', '.env.worktree']) {
      expect(spawnSync('git', ['check-ignore', '-q', f], {cwd: repo}).status, f).toBe(0);
    }
  });
});

// ---------- the fixture's Vite config ----------

let configSeq = 0;
async function loadConfig(env, argv) {
  const saved = {env: process.env.FIXTURE_PORT, argv: process.argv};
  if (env === undefined) delete process.env.FIXTURE_PORT; else process.env.FIXTURE_PORT = env;
  if (argv) process.argv = [...process.argv.slice(0, 2), ...argv];
  try {
    const url = `${pathToFileURL(path.join(repo, 'tests/fixture/vite.config.mjs')).href}?load=${++configSeq}`;
    return (await import(/* @vite-ignore */ url)).default;
  } finally {
    if (saved.env === undefined) delete process.env.FIXTURE_PORT; else process.env.FIXTURE_PORT = saved.env;
    process.argv = saved.argv;
  }
}

describe('tests/fixture/vite.config.mjs', () => {
  const worktreeEnv = existsSync(path.join(repo, '.env.worktree'));
  it.skipIf(worktreeEnv)('defaults to port 5190 with strictPort and a per-port cache', async () => {
    const c = await loadConfig(undefined, []);
    expect(c.server.port).toBe(5190);
    expect(c.server.strictPort).toBe(true);
    expect(c.cacheDir).toBe(path.join(cacheRoot, '5190'));
  });
  it('takes the port from FIXTURE_PORT', async () => {
    const c = await loadConfig('5191', []);
    expect(c.server.port).toBe(5191);
    expect(c.cacheDir).toBe(path.join(cacheRoot, '5191'));
  });
  it('lets --port on the command line win, cache included', async () => {
    expect((await loadConfig('5191', ['--port', '5195'])).cacheDir).toBe(path.join(cacheRoot, '5195'));
    expect((await loadConfig(undefined, ['--port=5196'])).server.port).toBe(5196);
  });
  it('rejects a malformed port', async () => {
    await expect(loadConfig('51x', [])).rejects.toThrow(/bad port/);
  });
});

// ---------- two fixture servers side by side ----------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); });
  });
}

const children = [];
function startFixture(port) {
  // `npm run fixture` exactly as a developer runs it, in its own process group
  // so the whole group (npm, sh, vite) is stopped by PID afterwards.
  const child = spawn('npm', ['run', 'fixture', '--silent'], {
    cwd: repo, detached: true, env: {...process.env, FIXTURE_PORT: String(port)}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', d => { child.output += d; });
  child.stderr.on('data', d => { child.output += d; });
  child.exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  children.push(child);
  return child;
}
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch { return false; } };
async function stop(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  await child.exited;
  // npm exits before Vite does; wait until the whole group is gone so nothing
  // writes to the cache after the cleanup.
  for (let i = 0; i < 100 && groupAlive(child.pid); i++) await new Promise(r => setTimeout(r, 100));
  if (groupAlive(child.pid)) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
}
async function waitForPage(port, child, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture on ${port} exited: ${child.output}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return res.text();
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`fixture on ${port} did not answer: ${child.output}`);
}

describe.runIf(posix)('fixture servers', () => {
  const createdCaches = [];
  afterAll(async () => {
    await Promise.all(children.map(stop));
    for (const dir of createdCaches) rmSync(dir, {recursive: true, force: true});
  });

  it('start side by side on two FIXTURE_PORTs, each with its own cache, and strictPort refuses a taken port', async () => {
    const ports = process.env.FIXTURE_PORTS
      ? process.env.FIXTURE_PORTS.split(',').map(Number)
      : [await freePort(), await freePort()];
    expect(new Set(ports).size).toBe(2);
    for (const p of ports) if (!existsSync(path.join(cacheRoot, String(p)))) createdCaches.push(path.join(cacheRoot, String(p)));
    const [a, b] = ports.map(startFixture);
    const [pageA, pageB] = await Promise.all([waitForPage(ports[0], a), waitForPage(ports[1], b)]);
    for (const page of [pageA, pageB]) {
      expect(page).toContain('<div');
      expect(page).toMatch(/preamble\.js/); // the fixture plugin, not a bare Vite server
    }
    // A third server on a taken port fails instead of drifting to another one.
    const c = startFixture(ports[0]);
    const code = await Promise.race([c.exited, new Promise(r => setTimeout(() => r('timeout'), 30_000))]);
    expect(code).not.toBe('timeout');
    expect(code).not.toBe(0);
    expect(c.output).toMatch(/already in use|EADDRINUSE/i);
    // Both originals are still serving.
    for (const p of ports) expect((await fetch(`http://127.0.0.1:${p}/`)).ok).toBe(true);
    await Promise.all([stop(a), stop(b)]);
    for (const p of ports) expect(existsSync(path.join(cacheRoot, String(p))), `cache for ${p}`).toBe(true);
  }, 120_000);
});
