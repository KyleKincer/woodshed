// @vitest-environment node
// scripts/build-icons.mjs and src/styles/icons.svg (architecture §7.4, D32).
import {cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {CUSTOM, ICONS, buildSprite, generate, main, parseIcon, toSymbol} from '../../scripts/build-icons.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const sprite = readFileSync(path.join(root, 'src/styles/icons.svg'), 'utf8');
const symbols = [...sprite.matchAll(/<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g)].map(m => ({attrs: m[1], body: m[2], id: /id="([^"]+)"/.exec(m[1])[1]}));
const scratch = [];
afterAll(() => { for (const d of scratch) rmSync(d, {recursive: true, force: true}); });

const CONTRACT_ICONS = 'play, square, pause, rotate-ccw, repeat, repeat-1, gauge, timer, music, mic, mic-off, volume-2, volume-x, headphones, list-music, layers, layout-grid, list, search, plus, x, check, chevron-left, chevron-right, chevron-down, chevron-up, ellipsis, more-vertical, pencil, share-2, link, copy, trash-2, pin, pin-off, star, flag, diamond, bookmark, sticky-note, maximize-2, minimize-2, zoom-in, zoom-out, scan, grid-3x3, magnet, arrow-down-to-line, arrow-left, arrow-right, keyboard, settings, user, log-out, download, upload, refresh-cw, alert-triangle, alert-circle, info, loader, sun, moon, monitor, cpu, hard-drive, cloud, wifi-off, external-link, file-music, file-audio, folder-open, wand-2, sparkles, sliders-horizontal, footprints, hand, keyboard-music, guitar, piano, drum, undo-2, redo-2, gamepad-2'.split(', ');
// Names added after the §7.4 initial list, each with the ticket that asked for it.
// 'minus' (I0B-14): the U1 Stepper's − button, paired with 'plus'.
// 'smartphone', 'monitor-smartphone', 'qr-code' (2.1): the phone remote.
const ADDED_ICONS = ['minus', 'smartphone', 'monitor-smartphone', 'qr-code'];

describe('build-icons', () => {
  it('ICONS is the §7.4 initial list plus the ticketed additions, and CUSTOM the five custom glyphs', () => {
    expect([...ICONS].sort()).toEqual([...CONTRACT_ICONS, ...ADDED_ICONS].sort());
    expect([...CUSTOM].sort()).toEqual(['count-in', 'drum', 'metronome', 'minus-me', 'trainer']);
    expect(readdirSync(path.join(root, 'src/styles/icons-custom')).sort()).toEqual(CUSTOM.map(n => `${n}.svg`).sort());
  });

  it('the committed sprite is up to date', async () => {
    expect(await generate(root)).toBe(sprite);
    let out = '';
    expect(await main(['--check'], {root, log: s => { out += s; }, error: s => { out += s; }})).toBe(0);
    expect(out).toContain('up to date');
  });

  it('has one symbol per icon and custom glyph, with unique ids', () => {
    const ids = symbols.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const want = [...new Set([...ICONS, ...CUSTOM])].map(n => `i-${n}`).sort();
    expect([...ids].sort()).toEqual(want);
  });

  it('every symbol has the 24×24 viewBox and no width, height, stroke-width or class', () => {
    for (const s of symbols) {
      expect(s.attrs, s.id).toContain('viewBox="0 0 24 24"');
      expect(s.attrs, s.id).not.toMatch(/\s(width|height|stroke-width|class|xmlns)=/);
      expect(s.attrs, s.id).toContain('stroke="currentColor"');
      expect(s.body.trim().length, s.id).toBeGreaterThan(0);
      expect(s.body, s.id).not.toMatch(/<(script|style)|\son\w+=/i);
    }
    expect(sprite).not.toMatch(/<!-- @license/);
  });

  it('has the Lucide minus icon for the Stepper (I0B-14)', () => {
    const minus = symbols.filter(s => s.id === 'i-minus');
    expect(minus).toHaveLength(1);
    const lucide = parseIcon(readFileSync(path.join(root, 'node_modules/lucide-static/icons/minus.svg'), 'utf8'), 'minus');
    expect(minus[0].body).toBe(lucide.body);
    expect(symbols.some(s => s.id === 'i-plus')).toBe(true);
  });

  it('a custom glyph replaces the Lucide icon of the same name (drum)', () => {
    const drum = symbols.filter(s => s.id === 'i-drum');
    expect(drum).toHaveLength(1);
    const custom = parseIcon(readFileSync(path.join(root, 'src/styles/icons-custom/drum.svg'), 'utf8'), 'drum').body;
    expect(drum[0].body).toBe(custom);
  });

  it('a Lucide symbol keeps the icon’s paths exactly', () => {
    const lucide = parseIcon(readFileSync(path.join(root, 'node_modules/lucide-static/icons/play.svg'), 'utf8'), 'play');
    expect(symbols.find(s => s.id === 'i-play').body).toBe(lucide.body);
  });

  it('toSymbol strips the sizing attributes and keeps presentation attributes', () => {
    const svg = '<!-- c --><svg class="lucide" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n  <path d="M1 1h2" />\n</svg>';
    expect(toSymbol('t', svg)).toBe('<symbol id="i-t" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1h2"/></symbol>');
    expect(() => toSymbol('bad', '<svg viewBox="0 0 16 16"><path d="M0 0"/></svg>')).toThrow(/viewBox/);
    expect(() => toSymbol('bad', '<svg viewBox="0 0 24 24"><script>x()</script></svg>')).toThrow(/not allowed/);
    expect(() => buildSprite({icons: ['a', 'a'], customNames: [], read: () => svg})).toThrow(/twice/);
  });

  it('parseIcon keeps a space between attributes written on several lines', () => {
    const svg = '<svg viewBox="0 0 24 24">\n  <path\n    d="M1 1"\n    fill="none"\n  />\n  <circle\n    cx="12" cy="12" r="2"/>\n</svg>';
    expect(parseIcon(svg).body).toBe('<path d="M1 1" fill="none"/><circle cx="12" cy="12" r="2"/>');
  });

  it('is idempotent: a second run leaves the file untouched', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'ws-icons-'));
    scratch.push(tmp);
    mkdirSync(path.join(tmp, 'node_modules'), {recursive: true});
    cpSync(path.join(root, 'node_modules/lucide-static/package.json'), path.join(tmp, 'node_modules/lucide-static/package.json'));
    mkdirSync(path.join(tmp, 'node_modules/lucide-static/icons'), {recursive: true});
    for (const n of ICONS) cpSync(path.join(root, `node_modules/lucide-static/icons/${n}.svg`), path.join(tmp, `node_modules/lucide-static/icons/${n}.svg`));
    cpSync(path.join(root, 'src/styles/icons-custom'), path.join(tmp, 'src/styles/icons-custom'), {recursive: true});
    const logs = [];
    const opts = {root: tmp, log: s => logs.push(s), error: s => logs.push(s)};
    expect(await main([], opts)).toBe(0);
    const first = readFileSync(path.join(tmp, 'src/styles/icons.svg'), 'utf8');
    expect(first).toBe(sprite);
    expect(await main([], opts)).toBe(0);
    expect(logs.at(-1)).toContain('up to date');
    writeFileSync(path.join(tmp, 'src/styles/icons.svg'), 'stale');
    expect(await main(['--check'], opts)).toBe(1);
    expect(readFileSync(path.join(tmp, 'src/styles/icons.svg'), 'utf8')).toBe('stale');
  });
});
