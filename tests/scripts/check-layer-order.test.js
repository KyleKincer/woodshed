// @vitest-environment node
// scripts/check-layer-order.mjs: index.html states the cascade-layer order inline, ahead of every stylesheet,
// exactly as src/styles/main.css declares it. Without it the production build linked chunk stylesheets
// (`@layer primitives`) before the main one and `primitives` became the lowest layer: every modal dialog
// lost `margin: auto` to the reset and sat in the top-left corner.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {checkHtml, layerOrder, main} from '../../scripts/check-layer-order.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const ORDER = ['reset', 'tokens', 'base', 'primitives', 'layout', 'views', 'utilities'];
const STYLE = `<style>@layer ${ORDER.join(', ')};</style>`;

describe('layerOrder', () => {
  it('reads the first order statement (comments ignored)', () => {
    expect(layerOrder(readFileSync(path.join(repo, 'src/styles/main.css'), 'utf8'))).toEqual(ORDER);
    expect(layerOrder('/* @layer a, b; */ @layer x{} @layer c, d;')).toEqual(['c', 'd']);
    expect(layerOrder('@layer views{.a{}}')).toEqual([]);
  });
});

describe('checkHtml', () => {
  it('passes the inline statement before the module script and the injected stylesheets', () => {
    expect(checkHtml(`<head>${STYLE}<script type="module" src="/a.js"></script><link rel="stylesheet" href="/icon.css"><link rel="stylesheet" href="/index.css"></head>`, ORDER)).toEqual([]);
  });

  it('fails when a stylesheet comes first (the production bug), when the statement is missing or when it disagrees', () => {
    expect(checkHtml(`<link rel="stylesheet" href="/icon.css">${STYLE}`, ORDER)[0]).toMatch(/first stylesheet-related element/);
    expect(checkHtml('<script type="module" src="/a.js"></script>', ORDER)[0]).toMatch(/first stylesheet-related element/);
    expect(checkHtml('<style>.a{}</style><script type="module"></script>', ORDER)[0]).toMatch(/does not state/);
    expect(checkHtml('<style>@layer reset, primitives, tokens;</style>', ORDER)[0]).toMatch(/main.css says/);
  });

  it('the repository index.html passes', () => {
    expect(checkHtml(readFileSync(path.join(repo, 'index.html'), 'utf8'), ORDER)).toEqual([]);
    let out = '';
    expect(main(['index.html'], {log: s => { out += s; }, error: s => { out += s; }})).toBe(0);
    expect(out).toContain('OK');
  });
});
