// @vitest-environment node
// scripts/prepare-desktop.mjs licence list (architecture §7.3): the packaged app
// ships both OFL font licences, Academico, Bravura and Harmonix Set next to the
// existing ones, and THIRD-PARTY-NOTICES.txt names them.
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const script = readFileSync(path.join(root, 'scripts/prepare-desktop.mjs'), 'utf8');

const copyList = () => {
  const m = /for\(const \[source,name\] of \[(\['public\/licenses[\s\S]*?\])\]\)\{\s*try\{await copyFile\(source,path\.join\('build\/licenses',name\)\)/.exec(script);
  if (!m) throw new Error('licence copy list not found');
  return [...m[1].matchAll(/\['([^']+)','([^']+)'\]/g)].map(x => ({source: x[1], name: x[2]}));
};
const notices = () => /writeFile\('build\/THIRD-PARTY-NOTICES\.txt',`([\s\S]*?)`\)/.exec(script)[1];

describe('prepare-desktop licences', () => {
  const REQUIRED = {
    'public/licenses/atkinson-hyperlegible-next.txt': /Atkinson Hyperlegible Next/,
    'public/licenses/atkinson-hyperlegible-mono.txt': /Atkinson Hyperlegible Mono/,
    'public/licenses/academico.txt': /Academico/,
    'public/licenses/bravura.txt': /Bravura/,
    'public/licenses/harmonix-set.txt': /Harmonix Set/,
    'public/licenses/lucide.txt': /Lucide/,
    'public/licenses/alphatab.txt': /alphaTab/,
    'public/licenses/signalsmith-stretch.txt': /Signalsmith Stretch/,
  };

  it('copies every app licence into build/licenses under a unique name', () => {
    const list = copyList();
    const sources = list.map(e => e.source);
    for (const file of Object.keys(REQUIRED)) expect(sources, file).toContain(file);
    const names = list.map(e => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every listed public licence exists in the repository', () => {
    for (const {source} of copyList()) if (source.startsWith('public/')) expect(existsSync(path.join(root, source)), source).toBe(true);
  });

  it('THIRD-PARTY-NOTICES.txt names each of them', () => {
    const text = notices();
    for (const [file, rx] of Object.entries(REQUIRED)) expect(text, file).toMatch(rx);
    expect(text).toMatch(/SIL Open Font License 1\.1/);
  });
});
