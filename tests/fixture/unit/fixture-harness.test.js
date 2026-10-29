// @vitest-environment node
// Harness discovery and pages (lib/harness.mjs) and the fixture's Vite plugin
// (vite.config.mjs): stub resolution, the injected scripts, /__fixture/early.js
// and /__harness/<name> (architecture §11.2).
import {describe, it, expect, vi, beforeAll, afterAll} from 'vitest';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {findHarnesses, harnessPage, harnessIndex, HARNESS_ROOTS} from '../lib/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, '..');
const repo = path.resolve(fixtureDir, '../..');

describe('findHarnesses', () => {
  let root;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'fx-harness-'));
    const file = (rel, text = 'export default async function mount() {}\n') => { mkdirSync(path.dirname(path.join(root, rel)), {recursive: true}); writeFileSync(path.join(root, rel), text); };
    file('tests/harness/ui/actions.harness.js');
    file('tests/harness/stage/deep/strip.harness.js');
    file('tests/harness/ui/overlays.js');
    file('tests/harness/a/twin.harness.js');
    file('tests/harness/b/twin.harness.js');
    file('tests/harness/ui/Bad_Name.harness.js');
    file('tests/harness/.hidden/secret.harness.js');
    file('tests/fixture/harness/fixture-smoke.harness.js');
    file('tests/fixture/harness/nested/ignored.harness.js');
  });
  afterAll(() => rmSync(root, {recursive: true, force: true}));

  it('finds tests/harness/** and tests/fixture/harness/*, keyed by basename', () => {
    const {harnesses} = findHarnesses(root);
    expect(Object.fromEntries(harnesses)).toEqual({
      actions: 'tests/harness/ui/actions.harness.js',
      strip: 'tests/harness/stage/deep/strip.harness.js',
      'fixture-smoke': 'tests/fixture/harness/fixture-smoke.harness.js',
    });
    expect(HARNESS_ROOTS).toEqual(['tests/harness', 'tests/fixture/harness']);
  });
  it('reports duplicate basenames and invalid names instead of picking one', () => {
    const {duplicates, invalid} = findHarnesses(root);
    expect(Object.fromEntries(duplicates)).toEqual({twin: ['tests/harness/a/twin.harness.js', 'tests/harness/b/twin.harness.js']});
    expect(invalid).toEqual(['tests/harness/ui/Bad_Name.harness.js']);
  });
  it('an empty repository has no harnesses', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'fx-harness-empty-'));
    expect(findHarnesses(empty).harnesses.size).toBe(0);
    rmSync(empty, {recursive: true, force: true});
  });
  it('the repository’s own harness is found', () => {
    expect(findHarnesses(repo).harnesses.get('fixture-smoke')).toBe('tests/fixture/harness/fixture-smoke.harness.js');
  });
});

describe('harness pages', () => {
  it('a harness page names the harness, has one scroller and loads the host', () => {
    const html = harnessPage('actions');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<html lang="en" data-harness="actions">');
    expect(html).toContain('<main id="harness" data-scroller aria-label="actions harness"></main>');
    expect(html).toContain('<script type="module" src="/tests/fixture/harness/host.js"></script>');
    expect(html).toContain('viewport-fit=cover');
    expect(harnessPage('<x>')).toContain('data-harness="&lt;x&gt;"');
  });
  it('the index lists harnesses and problems; an unknown name is called out', () => {
    const found = {harnesses: new Map([['actions', 'tests/harness/ui/actions.harness.js']]), duplicates: new Map([['twin', ['a.harness.js', 'b.harness.js']]]), invalid: ['Bad.harness.js']};
    const html = harnessIndex(found, {missing: 'nope'});
    expect(html).toContain('<a href="/__harness/actions">actions</a>');
    expect(html).toContain('No harness is named “nope”.');
    expect(html).toContain('“twin” is defined twice: a.harness.js, b.harness.js.');
    expect(html).toContain('Bad.harness.js: a harness name is lower-case letters, digits and dashes.');
    expect(harnessIndex({harnesses: new Map(), duplicates: new Map(), invalid: []})).toContain('No harness files yet.');
  });
});

describe('the fixture’s Vite plugin', () => {
  let config, plugin;
  beforeAll(async () => {
    process.env.FIXTURE_PORT = '5299';
    config = (await import(/* @vite-ignore */ `${pathToFileURL(path.join(fixtureDir, 'vite.config.mjs')).href}?t=${Date.now()}`)).default;
    delete process.env.FIXTURE_PORT;
    plugin = config.plugins.find(p => p.name === 'woodshed-fixture');
  });

  it('resolves the Convex and auth packages to the stubs, except from inside the fixture', () => {
    const app = path.join(repo, 'src/js/auth.js');
    expect(plugin.resolveId('convex/browser', app)).toBe(path.join(fixtureDir, 'stubs/convex-browser.js'));
    expect(plugin.resolveId('@convex-dev/auth/browser', app)).toBe(path.join(fixtureDir, 'stubs/convex-auth.js'));
    expect(plugin.resolveId('@convex-dev/auth/providers/oauth/react', app)).toBe(path.join(fixtureDir, 'stubs/oauth.js'));
    expect(plugin.resolveId('convex/browser', path.join(fixtureDir, 'stubs/x.js'))).toBeUndefined();
    expect(plugin.resolveId('signalsmith-stretch', app)).toBeUndefined();
  });
  it('puts early.js and then preamble.js first in <head> of index.html and of harness pages only', () => {
    const {handler, order} = plugin.transformIndexHtml;
    expect(order).toBe('pre');
    const tags = handler('<html><head></head></html>', {filename: path.join(repo, 'index.html')});
    expect(tags).toEqual([
      {tag: 'script', attrs: {src: '/__fixture/early.js'}, injectTo: 'head-prepend'},
      {tag: 'script', attrs: {type: 'module', src: `/@fs${path.join(fixtureDir, 'preamble.js')}`}, injectTo: 'head-prepend'},
    ]);
    expect(handler(harnessPage('actions'), {filename: path.join(repo, '__harness/actions/index.html')})).toEqual(tags);
    expect(handler('<html></html>', {filename: path.join(repo, 'tests/fixture/harness/score-geometry.html')})).toBeUndefined();
  });

  function middleware() {
    let handle;
    const server = {middlewares: {use: fn => { handle = fn; }}, transformIndexHtml: vi.fn(async (url, html) => html.replace('<head>', '<head><!--transformed-->'))};
    plugin.configureServer(server);
    const request = url => new Promise(resolve => {
      const res = {statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { resolve({status: this.statusCode, headers: this.headers, body, next: false}); }};
      handle({url, originalUrl: url}, res, error => resolve({next: true, error}));
    });
    return {server, request};
  }
  it('serves /__fixture/early.js as an uncached classic script', async () => {
    const {request} = middleware();
    const r = await request('/__fixture/early.js?v=1');
    expect(r.headers['content-type']).toMatch(/^text\/javascript/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toBe(readFileSync(path.join(fixtureDir, 'early.js'), 'utf8'));
  });
  it('serves the harness list, each harness page (through Vite’s HTML transform) and a 404 for an unknown name', async () => {
    const {server, request} = middleware();
    const list = await request('/__harness/');
    expect(list.status).toBe(200);
    expect(list.body).toContain('/__harness/fixture-smoke');
    expect((await request('/__harness')).body).toContain('<h1>Harnesses</h1>');
    const page = await request('/__harness/fixture-smoke?theme=dark');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<!--transformed-->');
    expect(page.body).toContain('data-harness="fixture-smoke"');
    expect(server.transformIndexHtml).toHaveBeenCalledWith('/__harness/fixture-smoke?theme=dark', expect.stringContaining('data-harness="fixture-smoke"'), '/__harness/fixture-smoke?theme=dark');
    const missing = await request('/__harness/nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toContain('No harness is named “nope”.');
  });
  it('passes every other request on', async () => {
    const {request} = middleware();
    expect((await request('/src/app/main.js')).next).toBe(true);
    expect((await request('/__harnesses')).next).toBe(true);
  });
  it('keeps P0’s port and cache rules', () => {
    expect(config.server).toMatchObject({port: 5299, strictPort: true, host: '127.0.0.1'});
    expect(config.cacheDir).toBe(path.join(fixtureDir, '.vite-cache', '5299'));
    expect(config.root).toBe(repo);
  });
});
