// @vitest-environment node
// scripts/compare-shots.py (architecture §10.6, §11.4): pixel comparison of
// captures with baselines, per-state thresholds, diff images, the legacy
// side-by-side mode and the exit codes. Images are made with Pillow.
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(repo, 'scripts/compare-shots.py');
const hasPil = spawnSync('python3', ['-I', '-c', 'import PIL, numpy'], {encoding: 'utf8'}).status === 0;

let dir, out, base;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fx-shots-'));
  out = path.join(dir, 'out'); base = path.join(dir, 'base');
  mkdirSync(out); mkdirSync(base);
});
afterEach(() => rmSync(dir, {recursive: true, force: true}));

/** A 100×100 grey PNG with `changed` pixels painted white (row by row). */
function png(file, {changed = 0, size = 100} = {}) {
  const code = `import sys
from PIL import Image
w = int(sys.argv[3]); im = Image.new('RGB', (w, w), (90, 90, 90)); px = im.load()
for i in range(int(sys.argv[2])): px[i % w, i // w] = (255, 255, 255)
im.save(sys.argv[1])`;
  const r = spawnSync('python3', ['-I', '-c', code, file, String(changed), String(size)], {encoding: 'utf8'});
  if (r.status !== 0) throw new Error(r.stderr);
}
const run = (...args) => {
  const r = spawnSync('python3', ['-I', SCRIPT, '--out', out, '--baselines', base, ...args], {encoding: 'utf8'});
  const reportPath = path.join(out, 'compare-report.json');
  return {code: r.status, stdout: r.stdout, stderr: r.stderr, report: existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null};
};
const statuses = report => Object.fromEntries(report.results.map(r => [r.name, r.status]));

describe.runIf(hasPil)('compare-shots.py', () => {
  it('passes identical captures and differences within the threshold (0.15 % by default)', () => {
    png(path.join(base, 'menu--laptop-dark.png')); png(path.join(out, 'menu--laptop-dark.png'));
    png(path.join(base, 'sheet--ipad-light.png')); png(path.join(out, 'sheet--ipad-light.png'), {changed: 15});
    const {code, report} = run();
    expect(code).toBe(0);
    expect(statuses(report)).toEqual({'menu--laptop-dark.png': 'pass', 'sheet--ipad-light.png': 'pass'});
    expect(report.results.find(r => r.name === 'sheet--ipad-light.png')).toMatchObject({differing: 15, total: 10_000, ratio: .0015});
    expect(existsSync(path.join(out, 'diff/sheet--ipad-light.png'))).toBe(true);
  });
  it('fails a larger difference and writes a diff image with the changed pixels in red', () => {
    png(path.join(base, 'menu--laptop-dark.png')); png(path.join(out, 'menu--laptop-dark.png'), {changed: 300});
    const {code, report, stdout} = run();
    expect(code).toBe(1);
    expect(report.results[0]).toMatchObject({status: 'fail', differing: 300, ratio: .03});
    expect(stdout).toMatch(/fail\s+menu--laptop-dark\.png 3\.000%/);
    const pixel = spawnSync('python3', ['-I', '-c', 'import sys\nfrom PIL import Image\nim = Image.open(sys.argv[1]); print(im.getpixel((0, 0)), im.getpixel((99, 99)))', path.join(out, 'diff/menu--laptop-dark.png')], {encoding: 'utf8'}).stdout.trim();
    expect(pixel).toBe('(230, 30, 60) (197, 197, 197)');
  });
  it('per-state thresholds come from <baselines>/thresholds.json (first matching pattern)', () => {
    png(path.join(base, 'chart--laptop-dark.png')); png(path.join(out, 'chart--laptop-dark.png'), {changed: 150});
    writeFileSync(path.join(base, 'thresholds.json'), JSON.stringify({'^chart-': .02, '.*': 0}));
    expect(run().code).toBe(0);
    expect(run('--threshold', '0.001', '--thresholds', path.join(base, 'thresholds.json')).report.results[0].threshold).toBe(.02);
  });
  it('a pixel inside the tolerance is not a difference', () => {
    const code = `import sys\nfrom PIL import Image\nImage.new('RGB', (10, 10), (100, 100, 100)).save(sys.argv[1])\nImage.new('RGB', (10, 10), (110, 100, 100)).save(sys.argv[2])`;
    spawnSync('python3', ['-I', '-c', code, path.join(base, 'a--laptop-dark.png'), path.join(out, 'a--laptop-dark.png')]);
    expect(run().report.results[0].differing).toBe(0);
    expect(run('--pixel-tolerance', '5').report.results[0].differing).toBe(100);
  });
  it('fails a missing capture, a size change and a capture without a baseline (unless --allow-new)', () => {
    png(path.join(base, 'gone--laptop-dark.png'));
    png(path.join(base, 'resized--laptop-dark.png')); png(path.join(out, 'resized--laptop-dark.png'), {size: 80});
    png(path.join(out, 'brand-new--laptop-dark.png'));
    const {code, report} = run();
    expect(code).toBe(1);
    expect(statuses(report)).toEqual({'gone--laptop-dark.png': 'missing', 'resized--laptop-dark.png': 'size', 'brand-new--laptop-dark.png': 'new'});
    expect(statuses(run('--allow-new').report)['brand-new--laptop-dark.png']).toBe('new-allowed');
  });
  it('--curated keeps laptop-dark and ipad-light; --filter narrows by name', () => {
    for (const v of ['laptop-dark', 'laptop-light', 'ipad-light', 'ipad-dark']) { png(path.join(base, `x--${v}.png`)); png(path.join(out, `x--${v}.png`)); }
    expect(Object.keys(statuses(run('--curated').report)).sort()).toEqual(['x--ipad-light.png', 'x--laptop-dark.png']);
    expect(Object.keys(statuses(run('--filter', 'ipad-dark').report))).toEqual(['x--ipad-dark.png']);
  });
  it('--legacy writes baseline | capture | diff side by side for review and never fails', () => {
    png(path.join(base, 'transcribe-score--laptop-dark.png')); png(path.join(out, 'transcribe-score--laptop-dark.png'), {changed: 5000});
    const {code, report} = run('--legacy');
    expect(code).toBe(0);
    expect(report.mode).toBe('legacy');
    expect(report.results[0].status).toBe('review');
    const width = spawnSync('python3', ['-I', '-c', 'import sys\nfrom PIL import Image\nprint(Image.open(sys.argv[1]).size[0])', path.join(out, 'diff/transcribe-score--laptop-dark.png')], {encoding: 'utf8'}).stdout.trim();
    expect(width).toBe(String(3 * 100 + 2 * 8));
  });
  it('exits 2 on a setup error', () => {
    expect(run('--baselines', path.join(dir, 'nowhere')).code).toBe(2);
    expect(run('--threshold', '2').code).toBe(2);
    writeFileSync(path.join(base, 'thresholds.json'), '{bad');
    expect(run().code).toBe(2);
  });
  it('defaults to tests/fixture/baselines/2.0, or legacy/ with --legacy', () => {
    const r = spawnSync('python3', ['-I', SCRIPT, '--legacy', '--out', out, '--report', path.join(dir, 'r.json')], {encoding: 'utf8'});
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, 'r.json'), 'utf8')).baselines).toBe(path.join(repo, 'tests/fixture/baselines/legacy'));
    expect(JSON.parse(readFileSync(path.join(dir, 'r.json'), 'utf8')).results.every(x => x.status === 'missing')).toBe(true);
  });
});
