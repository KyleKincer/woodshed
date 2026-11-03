// Every icon the source names literally (icon: 'x', iconEnd: 'x', icon('x')) is in the sprite. A name the sprite
// lacks draws an empty 20 px box: a blank gap in a button, a menu row or the command palette.
import {readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const sprite = readFileSync(path.join(ROOT, 'src/styles/icons.svg'), 'utf8');
const have = new Set([...sprite.matchAll(/id="i-([a-z0-9-]+)"/g)].map((m) => m[1]));

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
  });
}

const NAMED = /\b(?:icon|iconEnd)\s*:\s*'([a-z0-9-]+)'|\bicon\(\s*'([a-z0-9-]+)'/g;

describe('icon names', () => {
  it('every literal icon name in src is in the sprite', () => {
    const missing = [];
    for (const file of files(path.join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(NAMED)) {
        const name = m[1] ?? m[2];
        if (!have.has(name)) missing.push(`${path.relative(ROOT, file)}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
