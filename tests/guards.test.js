// @vitest-environment node
// Guards (architecture §7.6, §10.1): scripts/check-css.mjs and
// scripts/check-source.mjs pass on the repository, and every rule catches its
// violation (positive fixture) and accepts the sanctioned form (negative
// fixture), each at its activation point.
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import * as css from '../scripts/check-css.mjs';
import * as source from '../scripts/check-source.mjs';

const root = path.resolve(import.meta.dirname, '..');
const rules = list => list.map(v => v.rule);

describe('the repository passes both guards', () => {
  it('check-css: no violations', () => {
    const v = css.checkCss({root});
    expect(v.map(css.format)).toEqual([]);
  });
  it('check-source: no violations', () => {
    const v = source.checkSource({root});
    expect(v.map(source.format)).toEqual([]);
  });
  it('the CLIs exit 0 on the repository', () => {
    expect(spawnSync(process.execPath, ['scripts/check-css.mjs'], {cwd: root, encoding: 'utf8'}).status).toBe(0);
    expect(spawnSync(process.execPath, ['scripts/check-source.mjs'], {cwd: root, encoding: 'utf8'}).status).toBe(0);
  });
});

// ---------- CSS ----------

const view = 'src/styles/views/library/home.css';
const prim = 'src/styles/primitives/button.css';
const base = 'src/styles/base.css';
const inViews = body => `@layer views {\n${body}\n}\n`;
const cssCheck = (file, text) => rules(css.checkCssText(file, text));

describe('check-css rules', () => {
  const colourCases = [
    ['#hex', '.a { color: #fff; }'],
    ['#hex (8 digits)', '.a { background: #11223344; }'],
    ['rgb()', '.a { color: rgb(0 0 0); }'],
    ['rgba()', '.a { box-shadow: 0 0 2px rgba(0,0,0,.2); }'],
    ['hsl()', '.a { color: hsl(10 50% 50%); }'],
    ['hsla()', '.a { color: hsla(10, 50%, 50%, .5); }'],
    ['color-mix()', '.a { color: color-mix(in srgb, var(--ink) 50%, transparent); }'],
    ['white', '.a { color: white; }'],
    ['black', '.a { border: 1px solid black; }'],
    ['a literal inside a custom property', '.a { --x: #123456; }'],
  ];
  for (const [name, body] of colourCases) {
    it(`colour: flags ${name}`, () => expect(cssCheck(view, inViews(body))).toContain('colour'));
  }
  it('colour: allows tokens, transparent, currentColor, inherit, ids in selectors and white-space', () => {
    expect(cssCheck(view, inViews('#app .a { color: var(--ink); background: transparent; border-color: currentColor; fill: inherit; white-space: nowrap; transition: background-color var(--motion-fast); }'))).toEqual([]);
  });
  it('colour: tokens.css and fonts.css are exempt', () => {
    expect(css.checkCssText('src/styles/tokens.css', ':root { --bg: #f6f5f0; --x: rgb(0 0 0 / .4); }')).toEqual([]);
    expect(css.checkCssText('src/styles/fonts.css', "@font-face { font-family: 'X'; src: url('./a.woff2'); }")).toEqual([]);
  });

  it('z-index: flags numbers and calc', () => {
    expect(cssCheck(view, inViews('.a { z-index: 10; }'))).toEqual(['z-index']);
    expect(cssCheck(view, inViews('.a { z-index: calc(var(--z-sheet) + 1); }'))).toEqual(['z-index']);
  });
  it('z-index: allows var(--z-*) and auto', () => {
    expect(cssCheck(view, inViews('.a { z-index: var(--z-sheet); } .b { z-index: auto; }'))).toEqual([]);
  });

  it('radius: flags px radii, on the shorthand and longhands', () => {
    expect(cssCheck(view, inViews('.a { border-radius: 6px; }'))).toEqual(['radius']);
    expect(cssCheck(view, inViews('.a { border-top-left-radius: 50%; }'))).toEqual(['radius']);
    expect(cssCheck(view, inViews('.a { border-radius: var(--r-surface) var(--r-surface) 4px 4px; }'))).toEqual(['radius']);
  });
  it('radius: allows var(--r-*) and 0 (covers)', () => {
    expect(cssCheck(view, inViews('.a { border-radius: var(--r-pill); } .cover { border-radius: 0; } .s { border-radius: var(--r-surface) var(--r-surface) 0 0; }'))).toEqual([]);
  });

  it('important: flags !important outside reset.css and utilities.css', () => {
    expect(cssCheck(view, inViews('.a { display: none !important; }'))).toEqual(['important']);
    expect(cssCheck(base, '.a { display: none ! important; }')).toEqual(['important']);
  });
  it('important: allows it in reset.css and utilities.css', () => {
    expect(cssCheck('src/styles/reset.css', '[hidden] { display: none !important; }')).toEqual([]);
    expect(cssCheck('src/styles/utilities.css', '.sr-only { position: absolute !important; }')).toEqual([]);
  });

  it('font-size: flags px sizes, bare keywords and px in the shorthand', () => {
    expect(cssCheck(view, inViews('.a { font-size: 13px; }'))).toEqual(['font-size']);
    expect(cssCheck(view, inViews('.a { font-size: calc(var(--fs-14) + 2px); }'))).toEqual(['font-size']);
    expect(cssCheck(view, inViews('.a { font-size: small; }'))).toEqual(['font-size']);
    expect(cssCheck(view, inViews('.a { font: 600 14px/1.2 var(--font-ui); }'))).toEqual(['font-size']);
    expect(cssCheck(view, inViews('.a { font: var(--fs-14) system-ui; }'))).toEqual(['font-size']);
  });
  it('font-size: allows var(--fs-*), inherit, em, rem and %', () => {
    expect(cssCheck(view, inViews(`
      .a { font-size: var(--fs-stage-section); }
      .b { font-size: inherit; }
      .c { font-size: .875em; }
      .d { font-size: 1.25rem; }
      .e { font-size: 90%; }
      .f { font: var(--fs-16)/1.4 var(--font-ui); }
      .g { font: var(--fw-semibold) var(--fs-12)/1.2 var(--font-mono); }
      .h { font: inherit; }
      .i { font-size: calc(var(--fs-14) * 1.5); }
      .j { font: var(--fs-14)/20px var(--font-mono); }
      .k { font: var(--fw-bold) var(--fs-16)/24px var(--font-ui); }`))).toEqual([]);
  });

  it('font-family: flags literal families', () => {
    expect(cssCheck(view, inViews(".a { font-family: 'Inter', sans-serif; }"))).toEqual(['font-family']);
    expect(cssCheck(view, inViews('.a { font-family: ui-monospace, monospace; }'))).toEqual(['font-family']);
  });
  it('font-family: allows var(--font-ui) and var(--font-mono)', () => {
    expect(cssCheck(view, inViews('.a { font-family: var(--font-ui); } .b { font-family: var(--font-mono); }'))).toEqual([]);
  });

  it('layer: a primitive or view file must be one @layer block of its kind', () => {
    expect(cssCheck(prim, '.button { color: var(--ink); }')).toEqual(['layer']);
    expect(cssCheck(prim, '@layer views { .button { color: var(--ink); } }')).toEqual(['layer']);
    expect(cssCheck(view, '@layer views { .a { color: var(--ink); } }\n.b { color: var(--ink); }')).toEqual(['layer']);
    expect(cssCheck(view, "@import './x.css';\n@layer views { .a { color: var(--ink); } }")).toEqual(['layer']);
    expect(cssCheck('src/styles/views/notation/score-view.css', '.score { color: var(--ink); }')).toEqual(['layer']);
  });
  it('layer: accepts a single block with nested rules and comments', () => {
    expect(cssCheck(prim, '/* Button */\n@layer primitives {\n  .button { color: var(--ink); }\n  @media (pointer: coarse) { .button { min-height: var(--h-md); } }\n}\n')).toEqual([]);
    expect(cssCheck(view, inViews('.a { color: var(--ink); }'))).toEqual([]);
  });

  it('main: main.css starts with the §7.1 layer order', () => {
    expect(cssCheck('src/styles/main.css', "@layer reset, base, tokens, primitives, layout, views, utilities;\n@import './reset.css' layer(reset);")).toEqual(['main']);
    expect(cssCheck('src/styles/main.css', "/* app */\n@layer reset, tokens, base, primitives, layout, views, utilities;\n@import './reset.css' layer(reset);")).toEqual([]);
  });

  it('placement: a stylesheet under src/styles is a core file, a primitive or a view', () => {
    expect(cssCheck('src/styles/stage.css', '.a { color: var(--ink); }')).toEqual(['placement']);
    expect(cssCheck('src/styles/misc/x.css', '.a { color: var(--ink); }')).toEqual(['placement']);
    expect(cssCheck('src/styles/layout.css', '.a { color: var(--ink); }')).toEqual([]);
  });

  it('comments never trigger rules, strings never end a declaration', () => {
    expect(cssCheck(view, inViews('/* color: #fff; z-index: 3 !important */ .a { content: "a;b}#fff"; color: var(--ink); }'))).toEqual([]);
  });

  it('reports the line of a violation', () => {
    const [v] = css.checkCssText(view, '@layer views {\n  .a {\n    color: #000;\n  }\n}\n');
    expect(v).toMatchObject({file: view, line: 3, rule: 'colour'});
  });
});

describe('check-css activation: no CSS outside src/styles (enabled at I3a)', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ws-guard-css-'));
  afterAll(() => rmSync(tmp, {recursive: true, force: true}));
  const put = (rel, text) => { mkdirSync(path.dirname(path.join(tmp, rel)), {recursive: true}); writeFileSync(path.join(tmp, rel), text); };
  put('src/styles/base.css', 'body { color: var(--ink); }');
  put('src/js/notation/notation.css', '.n { color: #111; }');
  put('src/js/stray.css', '.s { color: var(--ink); }');

  it('when off (until I3a), stylesheets outside src/styles are not checked', () => {
    expect(css.checkCss({root: tmp, cssLocation: false})).toEqual([]);
  });
  it('when on, flags a stylesheet outside src/styles and exempts notation.css', () => {
    const v = css.checkCss({root: tmp, cssLocation: true, locationExempt: ['src/js/notation/notation.css']});
    expect(v.map(x => [x.file, x.rule])).toEqual([['src/js/stray.css', 'location']]);
    const all = css.checkCss({root: tmp, cssLocation: true, locationExempt: []});
    expect(all.map(x => x.file)).toEqual(['src/js/notation/notation.css', 'src/js/stray.css']);
  });
  it('a fixture tree reports each violating file', () => {
    put('src/styles/views/bad.css', '.bad { color: #fff; }');
    expect(css.checkCss({root: tmp, cssLocation: false}).map(x => [x.file, x.rule])).toEqual([
      ['src/styles/views/bad.css', 'colour'],
      ['src/styles/views/bad.css', 'layer'],
    ]);
  });
});

// ---------- source ----------

const src = (file, text, opts) => rules(source.checkSourceText(file, text, opts));
const LIB = 'src/library/home.js';

describe('check-source rules', () => {
  it('dialogs: flags alert, confirm, prompt and window.confirm', () => {
    expect(src(LIB, "alert('x');")).toEqual(['dialogs']);
    expect(src(LIB, "if (confirm('Delete?')) go();")).toEqual(['dialogs']);
    expect(src(LIB, "const n = prompt('Name');")).toEqual(['dialogs']);
    expect(src(LIB, "window.confirm('x');")).toEqual(['dialogs']);
    expect(src(LIB, "globalThis.alert('x');")).toEqual(['dialogs']);
    expect(src(LIB, "if (window?.confirm('x')) go();")).toEqual(['dialogs']);
    expect(src(LIB, "self?.prompt('x');")).toEqual(['dialogs']);
  });
  it('dialogs: allows feedback.confirm, an imported confirm, definitions, comments and strings', () => {
    expect(src(LIB, "await feedback.confirm({title: 'Delete?'});")).toEqual([]);
    expect(src(LIB, "import {confirm} from '../app/feedback.js';\nawait confirm({title: 'x'});")).toEqual([]);
    expect(src('src/app/feedback.js', 'export async function confirm(opts) { return opts; }\nconst api = { confirm(o) { return o; } };')).toEqual([]);
    expect(src(LIB, "// never alert('x')\nconst s = 'confirm(';\n/* prompt( */")).toEqual([]);
  });

  it('keyboard: flags keydown/keyup on window, document and an injected win/doc', () => {
    expect(src(LIB, "window.addEventListener('keydown', onKey);")).toEqual(['keyboard']);
    expect(src(LIB, 'document.addEventListener("keyup", onKey, true);')).toEqual(['keyboard']);
    expect(src(LIB, "win.addEventListener('keydown', onKey);")).toEqual(['keyboard']);
    expect(src(LIB, "el.ownerDocument.addEventListener('keydown', onKey);")).toEqual(['keyboard']);
    expect(src(LIB, 'document.onkeydown = onKey;')).toEqual(['keyboard']);
  });
  it('keyboard: flags a bare addEventListener, window.document / self.document and optional chaining', () => {
    expect(src(LIB, "addEventListener('keydown', onKey);")).toEqual(['keyboard']);
    expect(src(LIB, "const off = () => addEventListener('keyup', f);")).toEqual(['keyboard']);
    expect(src(LIB, "window.document.addEventListener('keyup', f);")).toEqual(['keyboard']);
    expect(src(LIB, "self.document.addEventListener('keydown', f);")).toEqual(['keyboard']);
    expect(src(LIB, "globalThis.document.body.addEventListener('keydown', f);")).toEqual(['keyboard']);
    expect(src(LIB, "window?.addEventListener('keydown', f);")).toEqual(['keyboard']);
    expect(src(LIB, "el.ownerDocument?.addEventListener('keydown', f);")).toEqual(['keyboard']);
    expect(src(LIB, 'window.document.onkeyup = f;')).toEqual(['keyboard']);
  });
  it('keyboard: a method named addEventListener or a member call is not the bare form', () => {
    expect(src(LIB, "this.addEventListener('keydown', f);\nhost.addEventListener('keyup', f);\nconst s = \"addEventListener('keydown'\";")).toEqual([]);
  });
  it('keyboard: allows element listeners, other events and the dispatcher itself', () => {
    expect(src(LIB, "el.addEventListener('keydown', onKey);\nwindow.addEventListener('resize', f);")).toEqual([]);
    expect(src('src/app/dispatch.js', "window.addEventListener('keydown', onKey, true);\nwindow.addEventListener('keyup', onUp, true);")).toEqual([]);
  });

  it('storage: flags web storage outside prefs.js and router.js', () => {
    expect(src(LIB, "localStorage.getItem('ws.view');")).toEqual(['storage']);
    expect(src(LIB, "globalThis.sessionStorage.setItem('k', 'v');")).toEqual(['storage']);
    expect(src('src/app/router.js', "localStorage.setItem('x', 'y');")).toEqual(['storage']);
  });
  it('storage: allows prefs.js (local), router.js (session) and IndexedDB', () => {
    expect(src('src/app/prefs.js', "localStorage.getItem('ws.prefs');")).toEqual([]);
    expect(src('src/app/router.js', "sessionStorage.getItem('ws.intendedRoute');")).toEqual([]);
    expect(src(LIB, "indexedDB.open('woodshed');\n// localStorage is not used here")).toEqual([]);
  });
  it('storage: router.js may use sessionStorage only for ws.intendedRoute', () => {
    const router = 'src/app/router.js';
    expect(src(router, "sessionStorage.setItem('ws.anything', x);")).toEqual(['storage']);
    expect(src(router, "const KEY = 'ws.other';\nsessionStorage.getItem(KEY);")).toEqual(['storage']);
    expect(src(router, 'sessionStorage.getItem(key);')).toEqual(['storage']);
    expect(src(router, 'sessionStorage.clear();')).toEqual(['storage']);
    expect(src(router, "sessionStorage['ws.intendedRoute'] = x;")).toEqual(['storage']);
    expect(src(router, [
      "const KEY = 'ws.intendedRoute';",
      'sessionStorage.setItem(KEY, path);',
      "const back = globalThis.sessionStorage?.getItem('ws.intendedRoute');",
      'sessionStorage.removeItem("ws.intendedRoute");',
      "if (typeof sessionStorage === 'undefined') return;",
    ].join('\n'))).toEqual([]);
  });

  it('backend: flags importing src/js/backend.js, statically or dynamically', () => {
    expect(src(LIB, "import {listSongs} from '../js/backend.js';")).toEqual(['backend']);
    expect(src('src/stage/surfaces/chart-surface.js', "const b = await import('../../js/backend.js');")).toEqual(['backend']);
    expect(src(LIB, "export {x} from '/src/js/backend.js';")).toEqual(['backend']);
  });
  it('backend: allows src/api modules and other kernel modules', () => {
    expect(src(LIB, "import * as songs from '../api/songs.js';\nimport {createEngine} from '../js/engine.js';")).toEqual([]);
  });

  it('inner-html: flags interpolated innerHTML in the view directories', () => {
    expect(src(LIB, 'el.innerHTML = `<b>${title}</b>`;')).toEqual(['inner-html']);
    expect(src('src/ui/menu.js', "el.innerHTML = '<li>' + label + '</li>';")).toEqual(['inner-html']);
    expect(src('src/stage/hud.js', 'el.innerHTML += item;')).toEqual(['inner-html']);
  });
  it('inner-html: allows clearing, a static string, a plain variable, and src/download and src/api', () => {
    expect(src(LIB, "el.innerHTML = '';\nsprite.innerHTML = SPRITE;\nel.innerHTML = '<p>Static</p>';")).toEqual([]);
    expect(src('src/download/download.js', 'el.innerHTML = `<b>${x}</b>`;')).toEqual([]);
    expect(src(LIB, 'if (el.innerHTML === `${x}`) go();')).toEqual([]);
  });
  it('inner-html: flags a right-hand side that starts on the next line', () => {
    expect(src(LIB, 'el.innerHTML =\n  `<b>${name}</b>`;\n')).toEqual(['inner-html']);
    expect(src(LIB, "el.innerHTML =\n  '<b>' + name;\n")).toEqual(['inner-html']);
    expect(src(LIB, "el.innerHTML =\n\n    '<b>' +\n    name;\n")).toEqual(['inner-html']);
    expect(src(LIB, "el.innerHTML =\n  '';\nlog('a' + b);\n")).toEqual([]);
  });

  it('inline-z: flags z-index in inline styles', () => {
    expect(src(LIB, 'el.style.zIndex = 5;')).toEqual(['inline-z']);
    expect(src(LIB, "el.style.setProperty('z-index', '5');")).toEqual(['inline-z']);
    expect(src(LIB, "h('div', {style: {zIndex: 3}});")).toEqual(['inline-z']);
    expect(src(LIB, "el.style.cssText = 'position: absolute; z-index: 3';")).toEqual(['inline-z']);
  });
  it('inline-z: allows classes and other inline styles', () => {
    expect(src(LIB, "el.classList.add('is-raised');\nel.style.transform = 'translateX(4px)';\n// z-index lives in CSS")).toEqual([]);
  });
  it('inline-z: flags compound assignment and Object.assign styles, allows reads', () => {
    expect(src(LIB, 'el.style.zIndex += 1;')).toEqual(['inline-z']);
    expect(src(LIB, 'Object.assign(el.style, {position: "fixed", zIndex: 9});')).toEqual(['inline-z']);
    expect(src(LIB, 'const z = getComputedStyle(el).zIndex;\nif (el.style.zIndex === "") go();')).toEqual([]);
  });

  it('commands: a commands module may not import views, sessions or packages statically', () => {
    expect(src('src/stage/commands.js', "import {register} from '../app/commands.js';\nimport {openSheet} from './sheets/host.js';")).toEqual(['commands']);
    expect(src('src/edit/map/commands.js', "import {getSession} from '../../stage/session.js';")).toEqual(['commands']);
    expect(src('src/stage/transport-commands.js', "import * as alphaTab from '@coderline/alphatab';")).toEqual(['commands']);
    expect(src('src/library/commands.js', "export {x} from './home.js';")).toEqual(['commands']);
  });
  it('commands: allows the registry, keys, pure helpers, copy tables and dynamic import()', () => {
    expect(src('src/stage/commands.js', [
      "import {register, registerDynamic} from '../app/commands.js';",
      "import {parseKey} from '../app/keys.js';",
      "import {hasRealMap} from '../../shared/song-map.ts';",
      "import {gridTicks} from './grid.js';",
      "import COPY from './stage.copy.js';",
      "register({id: 'stage.share', run: async c => (await import('../share/share-dialog.js')).open(c)});",
    ].join('\n'))).toEqual([]);
    expect(src('src/edit/chart/commands.js', "import {KIT} from '../../../shared/notation.ts';")).toEqual([]);
    // Non-commands modules are not restricted.
    expect(src('src/stage/stage.js', "import {openSheet} from './sheets/host.js';")).toEqual([]);
  });

  it('clock: flags Date.now() and performance.now() outside src/app/clock.js', () => {
    expect(src('src/app/pedals.js', 'const t = Date.now();')).toEqual(['clock']);
    expect(src('src/stage/frame.js', 'const t = performance.now();')).toEqual(['clock']);
  });
  it('clock: allows clock.js, now(), audio time, new Date() and mentions in comments', () => {
    expect(src('src/app/clock.js', 'export const now = () => Date.now();')).toEqual([]);
    expect(src('src/stage/undo.js', "import {now} from '../app/clock.js';\nconst t = now() + ctx.currentTime;\nconst d = new Date(t); // not Date.now()")).toEqual([]);
  });

  it('reserved: flags reserved browser/OS keys in a command definition', () => {
    for (const key of ['Mod+KeyN', 'Mod+KeyW', 'Mod+KeyT', 'Mod+Comma', 'Mod+Digit1', 'Mod+Digit9', 'Mod+Digit0', 'Mod+=', 'Mod+-']) {
      expect(src('src/app/global-commands.js', `register({id: 'x.y', title: 'X', group: 'App', keys: ['${key}']});`), key).toEqual(['reserved']);
    }
  });
  it('reserved: allows ordinary bindings', () => {
    expect(src('src/app/global-commands.js', "register({id: 'palette.open', keys: ['Mod+KeyK', 'Shift+Space', 'Mod+Shift+KeyN']});")).toEqual([]);
  });
  it('reserved: a "]" key string does not end the keys array', () => {
    expect(src('src/stage/commands.js', "register({id: 'a.b', keys: [']', 'Mod+KeyW'], run() {}});")).toEqual(['reserved']);
    expect(src('src/stage/commands.js', "register({id: 'a.b', keys: ['[', ']', 'Mod+[']});\nregister({id: 'a.c', key: 'Mod+KeyT'});")).toEqual(['reserved']);
    expect(src('src/stage/commands.js', "register({id: 'a.b', keys: [']', '['], title: 'Mod+KeyW'});")).toEqual([]);
  });

  it('colour: flags colour literals in strings', () => {
    expect(src('src/stage/wave-render.js', "ctx.fillStyle = '#ff8800';")).toEqual(['colour']);
    expect(src('src/stage/wave-render.js', 'ctx.strokeStyle = `rgba(0, 0, 0, ${a})`;')).toEqual(['colour']);
    expect(src('src/ui/fader.js', "const c = 'color-mix(in srgb, red 5%, blue)';")).toEqual(['colour']);
    expect(src('src/ui/a.js', "const c = '#333';\nconst d = 'border: 1px solid #111';\nconst g = 'linear-gradient(#fff, #000)';")).toEqual(['colour', 'colour', 'colour']);
  });
  it('colour: sees multi-line template literals', () => {
    expect(src('src/ui/a.js', 'el.style.cssText = `\n  color: #ff0000;\n`;\n')).toEqual(['colour']);
    expect(src('src/ui/a.js', 'const css = `\n  .a { width: ${w}px; }\n  .b { background: rgb(0 0 0); }\n`;')).toEqual(['colour']);
  });
  it('colour: allows url(#id), /#fragments and numbered prose', () => {
    expect(src('src/ui/a.js', [
      "const u = 'https://x.y/#abc';",
      "el.setAttribute('mask', 'url(#fade)');",
      "const s = 'Take #123';",
      'const t = `Bar #120 of ${n}`;',
      "const e = '&#123;';",
    ].join('\n'))).toEqual([]);
  });
  it('colour: allows token reads, icon ids and URL fragments', () => {
    expect(src('src/stage/wave-render.js', "const ink = getComputedStyle(root).getPropertyValue('--ink');\nuse.setAttribute('href', '#i-play');\nrouter.navigate('/s/1/edit/details#match');")).toEqual([]);
  });

  it('reports line numbers', () => {
    const [v] = source.checkSourceText(LIB, "const a = 1;\n\nalert('x');\n");
    expect(v).toMatchObject({file: LIB, line: 3, rule: 'dialogs'});
  });

  it('the lexer keeps code, strings, templates, regexes and comments apart', () => {
    const {code, bare} = source.lex("const r = /\\/\\/'/g; // c\nconst s = `a${b + '`'}c`; /* x */ const t = 'u';\n");
    expect(code).not.toContain('// c');
    expect(code).not.toContain('/* x */');
    expect(bare).toContain('${b + \' \'}');
    expect(bare).toContain("const t = ' '");
    expect(code.length).toBe(bare.length);
  });
});

describe('check-source activation: new directories until I3a', () => {
  const legacy = "window.addEventListener('keydown', onKey);\nlocalStorage.setItem('a', 'b');\nalert('x');";
  it("scope 'new' (until I3a) ignores src/js", () => {
    expect(['new', 'all']).toContain(source.ACTIVATION.sourceScope);
    expect(src('src/js/player.js', legacy, {scope: 'new'})).toEqual([]);
    expect(source.inScope('src/js/player.js', 'new')).toBe(false);
    for (const d of ['app', 'ui', 'stage', 'edit', 'library', 'settings', 'share', 'onboarding', 'download', 'api']) expect(source.inScope(`src/${d}/x.js`, 'new'), d).toBe(true);
  });
  it("scope 'all' (I3a) extends the rules to src/js", () => {
    expect(src('src/js/player.js', legacy, {scope: 'all'})).toEqual(['dialogs', 'keyboard', 'storage']);
  });
  it("scope 'all' keeps the exemptions: notation/store.js storage, artwork and score-view colours", () => {
    expect(src('src/js/notation/store.js', "localStorage.getItem('x');", {scope: 'all'})).toEqual([]);
    expect(src('src/js/artwork.js', "const palette = ['#112233'];", {scope: 'all'})).toEqual([]);
    expect(src('src/js/notation/score-view.js', "const ink = '#111111';", {scope: 'all'})).toEqual([]);
  });
  it('the inner-html and clock rules keep their own directories under any scope', () => {
    expect(src('src/js/notation/editor.js', 'el.innerHTML = `<b>${x}</b>`;\nconst t = Date.now();', {scope: 'all'})).toEqual([]);
  });
  it('files outside src are never scanned', () => {
    expect(src('tests/x.test.js', "alert('x');", {scope: 'all'})).toEqual([]);
  });
});

describe('check-source --orphans (wave 4)', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ws-guard-orphans-'));
  afterAll(() => rmSync(tmp, {recursive: true, force: true}));
  const put = (rel, text) => { mkdirSync(path.dirname(path.join(tmp, rel)), {recursive: true}); writeFileSync(path.join(tmp, rel), text); };
  put('index.html', '<script src="/theme-init.js"></script><script type="module" src="/src/app/main.js"></script>');
  put('src/app/main.js', "import '../styles/main.css';\nimport {a} from '../js/a.js';\nconst v = import.meta.glob(['../library/*.js']);\nconst w = new URL('../js/worklet.js', import.meta.url);\nimport('../js/lazy.js');");
  put('src/library/home.js', "import {b} from '../js/b.js';");
  put('src/js/a.js', "export * from './c.js';");
  put('src/js/b.js', 'export const b = 1;');
  put('src/js/c.js', 'export const c = 1;');
  put('src/js/lazy.js', 'export const l = 1;');
  put('src/js/worklet.js', 'export const w = 1;');
  put('src/js/orphan.js', "import {x} from './orphan-dep.js';");
  put('src/js/orphan-dep.js', "import {y} from './orphan.js';");

  it('lists modules nothing reaches, including import cycles', () => {
    expect(source.findOrphans({root: tmp})).toEqual(['src/js/orphan-dep.js', 'src/js/orphan.js']);
  });
  it('the CLI flag prints them and exits 1', () => {
    let out = '';
    const code = source.main(['--orphans'], {root: tmp, log: s => { out += `${s}\n`; }});
    expect(code).toBe(1);
    expect(out).toContain('src/js/orphan.js');
  });
});

describe('the guard CLIs report and fail', () => {
  it('check-source exits 1 and names the file and rule', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'ws-guard-cli-'));
    try {
      mkdirSync(path.join(tmp, 'src/app'), {recursive: true});
      writeFileSync(path.join(tmp, 'src/app/x.js'), "alert('x');\n");
      let err = '';
      expect(source.main([], {root: tmp, log: () => {}, error: s => { err += s; }})).toBe(1);
      expect(err).toContain('src/app/x.js:1  [dialogs]');
      mkdirSync(path.join(tmp, 'src/styles/views'), {recursive: true});
      writeFileSync(path.join(tmp, 'src/styles/views/v.css'), '@layer views { .a { z-index: 9; } }\n');
      err = '';
      expect(css.main([], {root: tmp, log: () => {}, error: s => { err += s; }})).toBe(1);
      expect(err).toContain('src/styles/views/v.css:1  [z-index]');
    } finally { rmSync(tmp, {recursive: true, force: true}); }
  });
});
