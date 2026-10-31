#!/usr/bin/env node
// Cascade-layer order guard (architecture §7.1). The whole cascade is one statement,
// `@layer reset, tokens, base, primitives, layout, views, utilities;` (src/styles/main.css). A layer's
// place is fixed the first time the document meets its name, so the statement must come before every
// stylesheet. In production it would not on its own: the minifier drops it from the main bundle, and Vite
// links shared chunk stylesheets (icon, popover, menu…, all `@layer primitives`) *before* the main one,
// which made `primitives` the lowest layer, under `reset` (`* { margin: 0 }` then beat every dialog's
// `margin: auto`, and modals sat in the top-left corner). index.html therefore states the order itself,
// inline, ahead of anything Vite injects; this script checks that it does, in the source and in the build.
//
//   node scripts/check-layer-order.mjs [file.html …]   default: index.html, and dist/index.html when built
//   layerOrder(css) → ['reset', …]                      the first `@layer a, b, …;` statement in a stylesheet
//   checkHtml(html, order) → [problem, …]               [] when an inline <style> states exactly `order`
//                                                       before every <link rel=stylesheet>, <style> and module script
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function layerOrder(css) {
  const m = /@layer\s+([a-z-]+(?:\s*,\s*[a-z-]+)+)\s*;/i.exec(String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, ''));
  return m ? m[1].split(',').map(s => s.trim()) : [];
}

export function checkHtml(html, order) {
  const text = String(html ?? '');
  const tags = [...text.matchAll(/<(style)\b[^>]*>([\s\S]*?)<\/style>|<link\b[^>]*rel=["']?stylesheet[^>]*>|<script\b[^>]*type=["']?module[^>]*>/gi)];
  if (!tags.length) return ['no stylesheet, inline style or module script found'];
  const first = tags[0];
  if (first[1]?.toLowerCase() !== 'style') {
    return [`the first stylesheet-related element is ${first[0].slice(0, 80)}…, not the inline <style> stating the layer order`];
  }
  const stated = layerOrder(first[2]);
  if (!stated.length) return ['the first inline <style> does not state the layer order (@layer a, b, …;)'];
  if (stated.join(',') !== order.join(',')) return [`the inline layer order is ${stated.join(', ')}; src/styles/main.css says ${order.join(', ')}`];
  return [];
}

export function main(argv = process.argv.slice(2), {log = console.log, error = console.error} = {}) {
  const order = layerOrder(readFileSync(path.join(root, 'src/styles/main.css'), 'utf8'));
  if (!order.length) { error('check-layer-order: src/styles/main.css has no @layer order statement'); return 1; }
  const files = argv.length ? argv : ['index.html', ...(existsSync(path.join(root, 'dist/index.html')) ? ['dist/index.html'] : [])];
  let failed = 0;
  for (const file of files) {
    const problems = checkHtml(readFileSync(path.resolve(root, file), 'utf8'), order);
    for (const p of problems) error(`${file}: ${p}`);
    if (problems.length) failed++;
  }
  if (failed) { error(`check-layer-order: ${failed} file(s) let a stylesheet fix the cascade before the layer order statement`); return 1; }
  log(`check-layer-order: OK (${files.join(', ')})`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
