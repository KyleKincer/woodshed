#!/usr/bin/env node
// Vendors the UI fonts (architecture §7.3, D33).
//
//   node scripts/vendor-fonts.mjs            copy what differs, report what changed
//   node scripts/vendor-fonts.mjs --check    exit 1 when a committed file differs from the package
//
// Copies the four upright woff2 files of the pinned fontsource packages
// (@fontsource-variable/atkinson-hyperlegible-{next,mono}@5.3.0) from
// node_modules/<pkg>/files/ into src/styles/fonts/, and writes each package's
// OFL text to public/licenses/atkinson-hyperlegible-{next,mono}.txt. The copies
// are committed, so builds never depend on the packages. Italics are not
// shipped. Running it twice changes nothing (files are written only when their
// bytes differ).
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FAMILIES = [
  {pkg: '@fontsource-variable/atkinson-hyperlegible-next', version: '5.3.0', slug: 'atkinson-hyperlegible-next', family: 'Atkinson Hyperlegible Next'},
  {pkg: '@fontsource-variable/atkinson-hyperlegible-mono', version: '5.3.0', slug: 'atkinson-hyperlegible-mono', family: 'Atkinson Hyperlegible Mono'},
];
export const SUBSETS = ['latin', 'latin-ext'];

/** Every file the script owns: {from, to, label} with paths relative to `root`. */
export function plan() {
  const out = [];
  for (const f of FAMILIES) {
    for (const subset of SUBSETS) {
      const name = `${f.slug}-${subset}-wght-normal.woff2`;
      out.push({from: `node_modules/${f.pkg}/files/${name}`, to: `src/styles/fonts/${name}`, label: name});
    }
    out.push({from: `node_modules/${f.pkg}/LICENSE`, to: `public/licenses/${f.slug}.txt`, label: `${f.slug}.txt`});
  }
  return out;
}

async function readOrNull(file) {
  try { return await readFile(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** Checks the pinned package versions so a stray upgrade cannot slip in. */
export async function checkVersions(root = ROOT) {
  for (const f of FAMILIES) {
    const meta = JSON.parse(await readFile(path.join(root, 'node_modules', f.pkg, 'package.json'), 'utf8'));
    if (meta.version !== f.version) throw new Error(`${f.pkg} is ${meta.version}; vendor-fonts expects ${f.version}`);
  }
}

/**
 * Copies (or, with check, compares) every planned file.
 * Returns [{label, to, status: 'unchanged'|'written'|'differs'}].
 */
export async function vendorFonts({root = ROOT, check = false} = {}) {
  await checkVersions(root);
  const results = [];
  for (const item of plan()) {
    const source = await readOrNull(path.join(root, item.from));
    if (!source) throw new Error(`missing ${item.from}; run npm ci`);
    const target = path.join(root, item.to);
    const current = await readOrNull(target);
    if (current && current.equals(source)) { results.push({...item, status: 'unchanged'}); continue; }
    if (check) { results.push({...item, status: 'differs'}); continue; }
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, source);
    results.push({...item, status: 'written'});
  }
  return results;
}

/**
 * The @font-face unicode-range per woff2 file name, read from the packages'
 * index.css (fonts.css copies them verbatim; a test compares the two).
 */
export async function unicodeRanges(root = ROOT) {
  const ranges = {};
  for (const f of FAMILIES) {
    const css = await readFile(path.join(root, 'node_modules', f.pkg, 'index.css'), 'utf8');
    for (const block of css.match(/@font-face\s*{[^}]*}/g) || []) {
      const file = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(block)?.[1];
      const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1].trim();
      if (file && range) ranges[file] = range;
    }
  }
  return ranges;
}

export async function main(argv = process.argv.slice(2), {log = console.log, error = console.error} = {}) {
  const check = argv.includes('--check');
  let results;
  try { results = await vendorFonts({check}); } catch (e) { error(`vendor-fonts: ${e.message}`); return 2; }
  for (const r of results) log(`  ${r.status.padEnd(9)} ${r.to}`);
  const differs = results.filter(r => r.status === 'differs').length;
  const written = results.filter(r => r.status === 'written').length;
  if (check) { log(differs ? `vendor-fonts --check: ${differs} file(s) differ; run npm run vendor:fonts` : 'vendor-fonts --check: up to date'); return differs ? 1 : 0; }
  log(written ? `vendor-fonts: wrote ${written} file(s)` : 'vendor-fonts: up to date');
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
