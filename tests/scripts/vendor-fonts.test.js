// @vitest-environment node
// scripts/vendor-fonts.mjs and src/styles/fonts.css (architecture §7.3, D33).
import {cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {FAMILIES, plan, unicodeRanges, vendorFonts} from '../../scripts/vendor-fonts.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const scratch = [];
const tempDir = prefix => { const d = mkdtempSync(path.join(tmpdir(), prefix)); scratch.push(d); return d; };
afterAll(() => { for (const d of scratch) rmSync(d, {recursive: true, force: true}); });

describe('vendor-fonts', () => {
  it('copies the four upright woff2 files and the two OFL texts', () => {
    expect(plan().map(p => p.to).sort()).toEqual([
      'public/licenses/atkinson-hyperlegible-mono.txt',
      'public/licenses/atkinson-hyperlegible-next.txt',
      'src/styles/fonts/atkinson-hyperlegible-mono-latin-ext-wght-normal.woff2',
      'src/styles/fonts/atkinson-hyperlegible-mono-latin-wght-normal.woff2',
      'src/styles/fonts/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2',
      'src/styles/fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2',
    ]);
    expect(plan().some(p => /italic/.test(p.to))).toBe(false);
  });

  it('the committed files equal the pinned packages (--check)', async () => {
    const results = await vendorFonts({root, check: true});
    expect(results.filter(r => r.status !== 'unchanged').map(r => r.to)).toEqual([]);
    expect(readdirSync(path.join(root, 'src/styles/fonts')).sort()).toEqual(plan().filter(p => p.to.endsWith('.woff2')).map(p => p.label).sort());
  });

  it('is idempotent: a second run writes nothing', async () => {
    const tmp = tempDir('ws-fonts-');
    for (const f of FAMILIES) cpSync(path.join(root, 'node_modules', f.pkg), path.join(tmp, 'node_modules', f.pkg), {recursive: true});
    const first = await vendorFonts({root: tmp});
    expect(first.every(r => r.status === 'written')).toBe(true);
    const second = await vendorFonts({root: tmp});
    expect(second.every(r => r.status === 'unchanged')).toBe(true);
    for (const r of plan()) expect(readFileSync(path.join(tmp, r.to)).equals(readFileSync(path.join(tmp, r.from)))).toBe(true);
    // A changed file is reported by --check and restored by a normal run.
    writeFileSync(path.join(tmp, 'public/licenses/atkinson-hyperlegible-next.txt'), 'stale');
    expect((await vendorFonts({root: tmp, check: true})).filter(r => r.status === 'differs').map(r => r.label)).toEqual(['atkinson-hyperlegible-next.txt']);
    expect((await vendorFonts({root: tmp})).filter(r => r.status === 'written').length).toBe(1);
  });

  it('refuses a package at another version', async () => {
    const tmp = tempDir('ws-fonts-ver-');
    for (const f of FAMILIES) cpSync(path.join(root, 'node_modules', f.pkg), path.join(tmp, 'node_modules', f.pkg), {recursive: true});
    const meta = path.join(tmp, 'node_modules', FAMILIES[0].pkg, 'package.json');
    writeFileSync(meta, JSON.stringify({...JSON.parse(readFileSync(meta, 'utf8')), version: '9.9.9'}));
    await expect(vendorFonts({root: tmp})).rejects.toThrow(/expects 5\.3\.0/);
  });

  it('the licence files are the SIL OFL texts', () => {
    for (const f of FAMILIES) {
      const text = readFileSync(path.join(root, 'public/licenses', `${f.slug}.txt`), 'utf8');
      expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(text).toContain(f.family);
    }
  });
});

describe('fonts.css', () => {
  const fontsCss = readFileSync(path.join(root, 'src/styles/fonts.css'), 'utf8');
  const faces = [...fontsCss.matchAll(/@font-face\s*{([^}]*)}/g)].map(m => m[1]);
  const prop = (face, name) => new RegExp(`${name}:\\s*([^;]+);`).exec(face)?.[1].trim();

  it('has four @font-face rules, one per vendored file, matching the token families', () => {
    expect(faces).toHaveLength(4);
    const families = new Set(faces.map(f => prop(f, 'font-family')));
    expect(families).toEqual(new Set(["'Atkinson Hyperlegible Next'", "'Atkinson Hyperlegible Mono'"]));
    const tokens = readFileSync(path.join(root, 'src/styles/tokens.css'), 'utf8');
    expect(tokens).toMatch(/--font-ui: 'Atkinson Hyperlegible Next',/);
    expect(tokens).toMatch(/--font-mono: 'Atkinson Hyperlegible Mono',/);
  });

  it('each face is variable 200–800, swap, upright woff2 from ./fonts/', () => {
    for (const face of faces) {
      expect(prop(face, 'font-weight')).toBe('200 800');
      expect(prop(face, 'font-display')).toBe('swap');
      expect(prop(face, 'font-style')).toBe('normal');
      const src = /src:\s*url\('\.\/fonts\/([^']+)'\) format\('woff2'\);/.exec(face);
      expect(src, face).not.toBeNull();
      expect(existsSync(path.join(root, 'src/styles/fonts', src[1]))).toBe(true);
    }
  });

  it('copies the packages’ unicode-range values verbatim', async () => {
    const ranges = await unicodeRanges(root);
    expect(Object.keys(ranges)).toHaveLength(4);
    for (const face of faces) {
      const file = /\.\/fonts\/([^']+)'/.exec(face)[1];
      expect(prop(face, 'unicode-range'), file).toBe(ranges[file]);
    }
  });
});

describe('a throwaway vite build of a page importing main.css', () => {
  it('emits dist/assets/atkinson-*.woff2 and keeps the layer order', async () => {
    const {build} = await import('vite');
    const tmp = tempDir('ws-fonts-build-');
    writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./main.js"></script></body></html>\n');
    writeFileSync(path.join(tmp, 'main.js'), `import ${JSON.stringify(path.join(root, 'src/styles/main.css'))};\n`);
    mkdirSync(path.join(tmp, 'dist'));
    await build({root: tmp, configFile: false, logLevel: 'silent', build: {outDir: path.join(tmp, 'dist'), emptyOutDir: true}});
    const assets = readdirSync(path.join(tmp, 'dist/assets'));
    const fonts = assets.filter(f => /^atkinson-.*\.woff2$/.test(f));
    expect(fonts).toHaveLength(4);
    for (const slug of ['next-latin', 'next-latin-ext', 'mono-latin', 'mono-latin-ext']) expect(fonts.some(f => f.startsWith(`atkinson-hyperlegible-${slug}-wght-normal-`)), slug).toBe(true);
    const cssFile = assets.find(f => f.endsWith('.css'));
    const built = readFileSync(path.join(tmp, 'dist/assets', cssFile), 'utf8');
    for (const f of fonts) expect(built).toContain(`/assets/${f}`);
    const order = [...built.matchAll(/@layer\s*([\w-]+)/g)].map(m => m[1]).filter((n, i, a) => a.indexOf(n) === i);
    expect(order).toEqual(['reset', 'tokens', 'base', 'primitives', 'layout', 'views', 'utilities']);
  }, 60_000);
});
