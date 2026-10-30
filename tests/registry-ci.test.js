// @vitest-environment happy-dom
// Registry CI (architecture §10.1). The checks run against the app-wide registry after importing every definition module
// listed below; integrations extend the lists as definition modules land (I1: global definitions and the ? sheet groups,
// I1b: Stage-transport and Library, I2a/I2b: Stage, Stems, CONTROL_SET, I3a: Edit, Map, Chart and the Electron menu sources). The self-tests at
// the bottom prove each check catches what it should.
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {createRegistry, GROUPS, ID_RE, registry} from '../src/app/commands.js';
import {activeScopeChain, setSurfaceScope, startDispatcher} from '../src/app/dispatch.js';
import {chordOffMac, isReserved} from '../src/app/keys.js';
import {KIT} from '../shared/notation.ts';
import {ALLOWED_SHADOWS, E, EC, ECS, EM, G, isAllowedShadow, L, REACHABLE_CHAINS, S, SF, SS} from './registry-shadows.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Modules whose import registers command definitions (e.g. () => import('../src/app/global-commands.js')). */
const DEFINITION_MODULES = [
  () => import('../src/app/global-commands.js'),
  () => import('../src/library/commands.js'),
  () => import('../src/stage/transport-commands.js'),
  () => import('../src/stage/commands.js'),
  // The Stems surface registers §3.3 on mount (I2b); defineStemsCommands() registers them once.
  () => import('../src/stage/surfaces/stems-surface.js').then(m => m.defineStemsCommands()),
  // Wave 3a (I3a): the Edit postures register on import.
  () => import('../src/edit/commands.js'),
  () => import('../src/edit/map/commands.js'),
  () => import('../src/edit/chart/commands.js'),
];
/** Modules exporting CONTROL_SET or CONTROLS tables whose command fields must exist (e.g. src/stage/controls.js). */
const CONTROL_MODULES = [
  () => import('../src/stage/controls.js'),
  () => import('../src/stage/hud.js'),
  () => import('../src/stage/stage.copy.js'),
  () => import('../src/stage/strip.js'),
  // Wave 2b (I2b): sheets, menus, surfaces, Library actions.
  () => import('../src/stage/sheets/sheets-a.copy.js'),
  () => import('../src/stage/sheets/sheets-b.copy.js'),
  () => import('../src/stage/sheets/loop.js'),
  () => import('../src/stage/menus.js'),
  () => import('../src/stage/surfaces/chart-surface.js'),
  () => import('../src/stage/surfaces/roadmap-surface.js'),
  () => import('../src/stage/surfaces/stems-surface.js'),
  () => import('../src/library/library-actions.copy.js'),
  // Wave 3a (I3a): Edit postures.
  () => import('../src/edit/edit.js'),
  () => import('../src/edit/chart/menus.js'),
  () => import('../src/edit/map/find-panel.js'),
  () => import('../src/edit/map/map.copy.js'),
];
/** Electron menu sources whose fixed command ids must exist (e.g. 'desktop/menu.cjs'). */
const ELECTRON_MENU_SOURCES = ['desktop/menu.cjs'];
/** The ? sheet's group order (S2's export; set at I1). */
const SHEET_GROUPS = (await import('../src/app/shortcuts-sheet.js')).SHEET_GROUPS;
/** Directories scanned for `command: '…'` references. */
const SCAN_DIRS = ['app', 'ui', 'stage', 'edit', 'library', 'settings', 'share', 'onboarding', 'download', 'api'].map(d => `src/${d}`);

// ---------------------------------------------------------------------------------------------------------------
// Checks. Each returns a list of problems (strings); an empty list passes.

/** Every id the registry knows, with every declared dynamic family expanded. */
function expandedIds(reg) {
  const ids = new Set(reg.all().map(d => d.id));
  for (const {ids: family} of reg.dynamicFamilies()) for (const id of family) ids.add(id);
  return ids;
}

function checkDefinitions(reg) {
  const problems = [];
  for (const def of reg.all()) {
    const titled = typeof def.title === 'function' || (typeof def.title === 'string' && def.title.trim());
    if (!titled) problems.push(`${def.id}: no title`);
    if (!GROUPS.includes(def.group)) problems.push(`${def.id}: group "${def.group}" is not a registry group`);
    for (const key of def.keys) if (isReserved(key)) problems.push(`${def.id}: binds the reserved key ${key}`);
  }
  return problems;
}

function checkDynamicFamilies(reg) {
  const problems = [];
  for (const {template, ids} of reg.dynamicFamilies()) {
    for (const id of ids) if (!reg.get(id)) problems.push(`${template}: ${id} is declared but not registered`);
  }
  return problems;
}

const KNOWN_SCOPES = new Set(REACHABLE_CHAINS.flat());
/** Names that belong to the chains; anything else is an overlay scope (palette, menus, dialogs). */
const CHAIN_NAME_RE = /^(stage|edit|library|global|settings?|admin)/;

/**
 * The defs bound in a scope, grouped by the chord they press off macOS: 'Ctrl+X' and 'Mod+X' are one chord there, so the
 * two spellings cannot hide a clash. Keys are reported in their folded ('Mod+') form.
 */
function chordBindings(reg, scope) {
  const out = new Map();
  for (const key of reg.bindingsFor(scope).keys()) {
    const chord = chordOffMac(key);
    const list = out.get(chord) ?? [];
    for (const def of reg.defsFor(scope, key)) if (!list.includes(def)) list.push(def);
    out.set(chord, list);
  }
  return out;
}

function checkScopes(reg) {
  const problems = [];
  for (const scope of reg.boundScopes()) {
    if (!KNOWN_SCOPES.has(scope) && CHAIN_NAME_RE.test(scope)) problems.push(`unknown scope "${scope}"`);
    for (const [key, defs] of chordBindings(reg, scope)) {
      if (defs.length > 1) problems.push(`${scope}: ${key} is bound twice (${defs.map(d => d.id).join(', ')})`);
    }
  }
  return problems;
}

/**
 * For each chain and key, the bindings from inner to outer; each binding must be allowed to shadow the next one out
 * (Ecs over E and E over G make Ecs over G). One def bound in several scopes of a chain counts once, at its innermost.
 */
function checkShadowing(reg, {chains = REACHABLE_CHAINS, allowed = ALLOWED_SHADOWS} = {}) {
  const problems = new Set();
  for (const chain of chains) {
    const byScope = new Map(chain.map(scope => [scope, chordBindings(reg, scope)]));
    const keys = new Set([...byScope.values()].flatMap(m => [...m.keys()]));
    for (const key of keys) {
      const layers = [];
      for (const scope of chain) {
        const def = byScope.get(scope).get(key)?.[0];
        if (def && !layers.some(l => l.def === def)) layers.push({scope, def});
      }
      for (let i = 0; i + 1 < layers.length; i++) {
        const [inner, outer] = [layers[i], layers[i + 1]];
        if (!isAllowedShadow({inner: inner.scope, outer: outer.scope, key, innerDef: inner.def}, allowed)) {
          problems.add(`${key}: ${inner.def.id} (${inner.scope}) shadows ${outer.def.id} (${outer.scope}) without an entry in registry-shadows.js`);
        }
      }
    }
  }
  return [...problems];
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
}

/** Command ids referenced as `command: '…'` (or a template literal) in source text. */
function commandReferences(src) {
  const out = [];
  const re = /\bcommand\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const m of stripComments(src).matchAll(re)) out.push({id: m[2], template: m[1] === '`' && m[2].includes('${')});
  return out;
}

function templateMatcher(text) {
  const parts = text.split(/\$\{[^}]*\}/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('[A-Za-z0-9-]+')}$`);
}

function checkReferences(reg, refs) {
  const ids = expandedIds(reg);
  const problems = [];
  for (const {id, template, where} of refs) {
    const ok = template ? [...ids].some(x => templateMatcher(id).test(x)) : ids.has(id);
    if (!ok) problems.push(`${where}: command "${id}" is not registered`);
  }
  return problems;
}

// `via` (ST8a's menus): a row that runs that command itself rather than binding it; it must still exist (I2b).
const CONTROL_FIELDS = ['command', 'longPress', 'dec', 'inc', 'value', 'valueLongPress', 'caret', 'via'];

/** Command ids in a CONTROL_SET / CONTROLS table. */
function controlCommands(table) {
  return (table ?? []).flatMap(row => CONTROL_FIELDS.map(f => row?.[f]).filter(v => typeof v === 'string' && ID_RE.test(v)));
}

/** Command ids named in an Electron menu source: id: '…', command: '…' and send('…') forms. */
function menuReferences(src) {
  const out = new Set();
  const re = /\b(?:id|command)\s*:\s*['"]([^'"]+)['"]|\bsendCommand\(\s*['"]([^'"]+)['"]/g;
  for (const m of stripComments(src).matchAll(re)) {
    const id = m[1] ?? m[2];
    if (ID_RE.test(id)) out.add(id);
  }
  return [...out];
}

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.js$/.test(name) ? [path] : [];
  });
}

function sourceReferences() {
  return SCAN_DIRS.flatMap(d => walk(join(ROOT, d))).flatMap(file =>
    commandReferences(readFileSync(file, 'utf8')).map(ref => ({...ref, where: relative(ROOT, file).split(sep).join('/')})));
}

function runAll(reg, refs = []) {
  return [...checkDefinitions(reg), ...checkDynamicFamilies(reg), ...checkScopes(reg), ...checkShadowing(reg),
    ...checkReferences(reg, refs)];
}

// ---------------------------------------------------------------------------------------------------------------
// The app registry

describe('registry CI: the app registry', () => {
  it('loads every definition module, then passes every check', async () => {
    for (const load of DEFINITION_MODULES) await load();
    const refs = sourceReferences();
    for (const load of CONTROL_MODULES) {
      const mod = await load();
      for (const id of controlCommands([...(mod.CONTROL_SET ?? []), ...(mod.CONTROLS ?? [])])) refs.push({id, where: 'CONTROL_SET'});
    }
    for (const file of ELECTRON_MENU_SOURCES) {
      for (const id of menuReferences(readFileSync(join(ROOT, file), 'utf8'))) refs.push({id, where: file});
    }
    expect(runAll(registry, refs)).toEqual([]);
  });

  it('the ? sheet groups equal the registry groups', () => {
    if (SHEET_GROUPS !== null) expect(SHEET_GROUPS).toEqual(GROUPS);
    const used = new Set(registry.all().map(d => d.group));
    for (const group of used) expect(GROUPS).toContain(group);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Primitive `command` props (I0B): Button, IconButton and Toggle (src/ui/button.js, toggle.js) and MenuItem
// (src/ui/menu.js) resolve `command` through the registry, so every literal id passed to them anywhere in src/** must
// exist. The source scan above reads every `command:` literal; these checks keep it pointed at the primitives.

/** The primitives that take a registry `command` prop, by module. A new one must be added here (and scanned). */
const COMMAND_PRIMITIVES = {'src/ui/button.js': ['Button', 'IconButton'], 'src/ui/toggle.js': ['Toggle'], 'src/ui/menu.js': ['MenuItem']};

describe('registry CI: primitive command props', () => {
  it('every src/ui module that reads a command prop is a listed command primitive, inside the scanned directories', () => {
    const readers = walk(join(ROOT, 'src/ui'))
      .filter(file => /\b(?:p|props|item|r)\.command\b/.test(stripComments(readFileSync(file, 'utf8'))))
      .map(file => relative(ROOT, file).split(sep).join('/')).sort();
    expect(readers).toEqual(Object.keys(COMMAND_PRIMITIVES).sort());
    for (const file of readers) expect(SCAN_DIRS.some(d => file.startsWith(`${d}/`)), file).toBe(true);
  });

  it('the scan finds command ids in every primitive call form', () => {
    const src = [
      'const play = Button({',
      "  label: 'Play',",
      "  command: 'transport.playStop',",
      '});',
      'IconButton({icon: "loop", command: "transport.loopToggle"});',
      'Toggle({label: `Mute ${n}`, command: `mix.mute.${n}`});',
      "Menu({items: [{label: 'Loop', command: 'loop.clear'}, {type: 'separator'}, {command: 'nav.home', kbd: true}]});",
      'Button({command}); // a variable: resolved at run time, not scanned',
    ].join('\n');
    expect(commandReferences(src).map(r => r.id)).toEqual(['transport.playStop', 'transport.loopToggle', 'mix.mute.${n}',
      'loop.clear', 'nav.home']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The contract key table (§3): every keyed command with its scopes. It must pass with exactly the listed shadows.

/** chart.piece.<kitId> for every KIT id, bound to its default letter (the choke pieces have none). */
const KIT_LETTERS = Object.fromEntries(KIT.map(k => [k.id, k.key ? `Key${k.key.toUpperCase()}` : null]));
const ERASE = ['Backspace', 'Delete'];
const CONTRACT = [
  // §3.1
  ['transport.playStop', ['Space'], [S, E]], ['transport.pause', ['Shift+Space'], [S, E]], ['transport.again', ['Enter'], [S, EC]],
  ['transport.loopToggle', ['KeyL'], [S]], ['transport.loopSection', ['Shift+KeyL'], [S]],
  ['focus.play', ['Enter'], SF], ['focus.loop', ['KeyL'], SF],
  ['loop.in', ['KeyI'], [S, EM]], ['loop.inExact', ['Shift+KeyI'], [S, EM]], ['loop.out', ['KeyO'], [S, EM]],
  ['loop.outExact', ['Shift+KeyO'], [S, EM]], ['loop.clear', ERASE, [S]], ['loop.moveBack', ['Shift+['], [S]],
  ['loop.moveFwd', ['Shift+]'], [S]], ['nav.prevSection', ['[', 'PageUp'], [S, EM]], ['nav.nextSection', [']', 'PageDown'], [S, EM]],
  ['nav.barBack', ['ArrowLeft'], [S]], ['nav.barFwd', ['ArrowRight'], [S]], ['nav.beatBack', ['Shift+ArrowLeft'], [S]],
  ['nav.beatFwd', ['Shift+ArrowRight'], [S]], ['cue.nudgeBack', ['Alt+ArrowLeft'], [S]], ['cue.nudgeFwd', ['Alt+ArrowRight'], [S]],
  ['cue.nudgeBackFine', ['Alt+Shift+ArrowLeft'], [S]], ['cue.nudgeFwdFine', ['Alt+Shift+ArrowRight'], [S]],
  ['nav.home', ['Home'], [S]], ['nav.end', ['End'], [S]],
  ['speed.down', [','], [S, EC]], ['speed.up', ['.'], [S, EC]], ['speed.downFine', ['Shift+,'], [S, EC]],
  ['speed.upFine', ['Shift+.'], [S, EC]], ['speed.toggle100', ['`'], [S, EC]],
  ['click.countIn', ['KeyC'], [S, E]], ['click.toggle', ['KeyK'], [S, E]],
  ['mix.minusMe', ['KeyM'], [S, EM]], ['mix.onlyMe', ['Shift+KeyM'], [S, EM]], ['mix.full', ['Digit0'], [S]],
  // §3.2
  ['marker.add', ['KeyS'], [S]], ['spot.save', ['KeyB'], [S]], ['spot.list', ['KeyJ'], [S]], ['view.cycle', ['KeyV'], [S]],
  ['view.focus', ['KeyF'], [S]], ['view.bigger', ['='], [S]], ['view.smaller', ['-'], [S]], ['edit.open', ['KeyE'], [S]],
  ['practice.undo', ['Mod+KeyZ'], [S]], ['practice.redo', ['Mod+Shift+KeyZ', 'Mod+KeyY'], [S]],
  ['setlist.next', ['Alt+ArrowDown'], [S]], ['setlist.prev', ['Alt+ArrowUp'], [S]],
  // §3.3
  ['stems.zoomIn', ['='], [SS]], ['stems.zoomOut', ['-'], [SS]], ['stems.fit', ['\\'], [SS]], ['stems.zoomLoop', ['KeyZ'], [SS]],
  ['stems.grid', ['KeyG'], [SS]], ['stems.snap', ['Shift+KeyS'], [SS]], ['stems.follow', ['KeyF'], [SS]],
  // §3.4
  ['edit.done', ['Escape'], [E]], ['map.undo', ['Mod+KeyZ'], [EM]], ['map.redo', ['Mod+Shift+KeyZ', 'Mod+KeyY'], [EM]],
  ['map.prevBar', ['ArrowLeft'], [EM]], ['map.nextBar', ['ArrowRight'], [EM]], ['map.prevBeat', ['Shift+ArrowLeft'], [EM]],
  ['map.nextBeat', ['Shift+ArrowRight'], [EM]], ['map.prevPin', ['Mod+ArrowLeft'], [EM]], ['map.nextPin', ['Mod+ArrowRight'], [EM]],
  ['map.goOrApply', ['Enter'], [EM]], ['map.first', ['Home'], [EM]], ['map.last', ['End'], [EM]],
  ['map.pinDownbeat', ['KeyD'], [EM]], ['map.pinBeat', ['KeyT'], [EM]], ['map.unpin', ERASE, [EM]],
  ['map.nudgeBack', [','], [EM]], ['map.nudgeFwd', ['.'], [EM]], ['map.nudgeBackFine', ['Shift+,'], [EM]],
  ['map.nudgeFwdFine', ['Shift+.'], [EM]], ['map.renumberBack', ['Alt+ArrowLeft'], [EM]], ['map.renumberFwd', ['Alt+ArrowRight'], [EM]],
  ['map.renumberBeatBack', ['Alt+Shift+ArrowLeft'], [EM]], ['map.renumberBeatFwd', ['Alt+Shift+ArrowRight'], [EM]],
  ['map.beatsDown', ['ArrowDown'], [EM]], ['map.beatsUp', ['ArrowUp'], [EM]], ['map.beatsDownBar', ['Shift+ArrowDown'], [EM]],
  ['map.beatsUpBar', ['Shift+ArrowUp'], [EM]], ['map.tailDown', ['Alt+ArrowDown'], [EM]], ['map.tailUp', ['Alt+ArrowUp'], [EM]],
  ['map.tailDownFine', ['Alt+Shift+ArrowDown'], [EM]], ['map.tailUpFine', ['Alt+Shift+ArrowUp'], [EM]],
  ['map.editBar', ['KeyE'], [EM]], ['map.ramp', ['KeyR'], [EM]], ['map.preview', ['KeyP'], [EM]], ['map.double', ['*'], [EM]],
  ['map.halve', ['/'], [EM]], ['map.addSection', ['KeyS'], [EM]], ['map.grid', ['KeyG'], [EM]], ['map.snap', ['Shift+KeyS'], [EM]],
  ['map.zoomIn', ['='], [EM]], ['map.zoomOut', ['-'], [EM]], ['map.fit', ['\\'], [EM]], ['map.zoomSelection', ['KeyZ'], [EM]],
  ['chart.undo', ['Mod+KeyZ'], [EC]], ['chart.redo', ['Mod+Shift+KeyZ', 'Mod+KeyY'], [EC]],
  ['chart.pagePrev', ['[', 'PageUp'], [EC]], ['chart.pageNext', [']', 'PageDown'], [EC]], ['chart.loopSelection', ['KeyL'], [EC]],
  ['chart.write', ['KeyN'], [ECS]], ['chart.cursorBack', ['ArrowLeft'], [ECS]], ['chart.cursorFwd', ['ArrowRight'], [ECS]],
  ['chart.extendBack', ['Shift+ArrowLeft'], [ECS]], ['chart.extendFwd', ['Shift+ArrowRight'], [ECS]],
  ['chart.pieceUp', ['ArrowUp'], [ECS]], ['chart.pieceDown', ['ArrowDown'], [ECS]], ['chart.moveBack', ['Alt+ArrowLeft'], [ECS]],
  ['chart.moveFwd', ['Alt+ArrowRight'], [ECS]], ['chart.barStart', ['Home'], [ECS]], ['chart.barEnd', ['End'], [ECS]],
  ['chart.skip', ['KeyR'], [ECS]], ['chart.finer', ['='], [ECS]], ['chart.coarser', ['-'], [ECS]], ['chart.dot', ['.'], [ECS]],
  ['chart.tuplet', ['/'], [ECS]], ['chart.accent', ['KeyA'], [ECS]], ['chart.heavy', ['Shift+KeyA'], [ECS]],
  ['chart.ghost', ['KeyG'], [ECS]], ['chart.delete', ERASE, [ECS]], ['chart.copy', ['Mod+KeyC'], [ECS]],
  ['chart.paste', ['Mod+KeyV'], [ECS]], ['chart.repeat', ['Mod+KeyD'], [ECS]], ['chart.selectBar', ['Mod+KeyA'], [ECS]],
  ['chart.clear', ['Escape'], [ECS]],
  // §3.5
  ['app.palette', ['Mod+KeyK'], [G]], ['app.shortcuts', ['?'], [G]], ['app.escape', ['Escape'], [G]],
  ['library.add', ['KeyN'], [L]], ['library.search', ['/'], [L]], ['library.openFocused', ['Enter'], [L]],
  ['library.editFocused', ['KeyE'], [L]], ['library.deleteSelected', ERASE, [L]], ['library.selectAll', ['Mod+KeyA'], [L]],
  ['library.first', ['Home'], [L]], ['library.last', ['End'], [L]],
];
const STEMS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function contractRegistry() {
  const reg = createRegistry();
  const group = id => ({transport: 'Transport', focus: 'Transport', loop: 'Loop', nav: 'Navigate', cue: 'Navigate', speed: 'Speed',
    click: 'Click', mix: 'Mix', marker: 'Practice', spot: 'Practice', view: 'View', edit: 'Edit', practice: 'Practice',
    setlist: 'Navigate', stems: 'View', map: 'Map', chart: 'Chart', app: 'App', library: 'Library'})[id.split('.')[0]];
  reg.registerMany(CONTRACT.map(([id, keys, scopes]) => ({id, title: id, group: group(id), keys, scopes, run: () => {}})));
  const run = () => {};
  reg.registerDynamic({id: 'mix.mute.{n}', title: 'Mute {n}', group: 'Mix', keys: ['Digit{n}'], scopes: [S], run}, STEMS);
  reg.registerDynamic({id: 'mix.solo.{n}', title: 'Solo {n}', group: 'Mix', keys: ['Shift+Digit{n}'], scopes: [S], run}, STEMS);
  reg.registerDynamic({id: 'map.digit.{n}', title: 'Type {n}', group: 'Map', keys: ['Digit{n}'], scopes: [EM], run}, [0, ...STEMS]);
  reg.registerDynamic({id: 'chart.step.{n}', title: 'Step {n}', group: 'Chart', keys: ['Digit{n}'], scopes: [ECS], run}, [1, 2, 3, 4, 5]);
  reg.registerMany(Object.entries(KIT_LETTERS).map(([kit, key]) => ({id: `chart.piece.${kit}`, title: `Write ${kit}`, group: 'Chart',
    keys: key ? [key] : [], scopes: [ECS], run})));
  reg.registerDynamic('chart.piece.{n}', Object.keys(KIT_LETTERS));
  return reg;
}

describe('registry CI: the §3 contract table', () => {
  it('passes with exactly the listed shadows', () => {
    expect(runAll(contractRegistry())).toEqual([]);
  });

  it('declares chart.piece.<kitId> for every KIT id', () => {
    const reg = contractRegistry();
    const family = reg.dynamicFamilies().find(f => f.template === 'chart.piece.{n}');
    expect(family.ids).toEqual(KIT.map(k => `chart.piece.${k.id}`));
    expect(KIT.length).toBeGreaterThanOrEqual(27);
    for (const k of KIT) expect(reg.get(`chart.piece.${k.id}`), k.id).toBeTruthy();
  });

  it('every allowed shadow entry is needed', () => {
    const reg = contractRegistry();
    for (const entry of ALLOWED_SHADOWS) {
      const without = ALLOWED_SHADOWS.filter(e => e !== entry);
      expect(checkShadowing(reg, {allowed: without}).length, entry.why).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The dispatcher resolves keys only through the listed chains

describe('registry CI: reachable chains', () => {
  let stop;
  afterEach(() => {
    stop?.();
    setSurfaceScope(null);
    document.body.replaceChildren();
    delete document.documentElement.dataset.place;
    delete document.documentElement.dataset.posture;
  });

  it('every chain the dispatcher produces is checked', () => {
    const reg = createRegistry();
    stop = startDispatcher({registry: reg, platform: 'win'});
    const seen = [];
    const at = (place, posture, {route, focus, surface} = {}) => {
      document.documentElement.dataset.place = place;
      if (posture) document.documentElement.dataset.posture = posture; else delete document.documentElement.dataset.posture;
      const off = route ? reg.provide('route', route) : () => {};
      setSurfaceScope(surface ?? null);
      document.body.replaceChildren();
      if (focus) {
        const host = document.createElement('div');
        host.dataset.scope = focus;
        const target = document.createElement('button');
        host.append(target);
        document.body.append(host);
        target.focus();
      }
      seen.push(activeScopeChain());
      off();
    };
    for (const focus of [null, ...SF]) for (const surface of [null, SS]) at('stage', 'stage', {focus, surface});
    for (const tab of ['map', 'chart', 'details']) at('edit', 'edit', {route: {name: 'edit', params: {tab}}});
    at('edit', 'edit', {route: {name: 'bulkDetails', params: {}}});
    at('edit', 'edit', {route: {name: 'edit', params: {tab: 'chart'}}, focus: ECS});
    for (const place of ['library', 'settings', 'admin']) at(place, null);
    const listed = REACHABLE_CHAINS.map(c => c.join(' > '));
    for (const chain of seen) expect(listed).toContain(chain.join(' > '));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Self-tests: each check catches its failure

describe('registry CI: self-tests', () => {
  const base = {group: 'Transport', run: () => {}};

  it('flags unlisted shadowing in a chain, and accepts listed pairs', () => {
    const reg = createRegistry();
    reg.register({...base, id: 'transport.again', title: 'Again', keys: ['Enter'], scopes: [S]});
    reg.register({...base, id: 'focus.play', title: 'Play here', keys: ['Enter'], scopes: SF});
    expect(checkShadowing(reg)).toEqual([]);
    reg.register({...base, id: 'app.quit', title: 'Quit', group: 'App', keys: ['KeyQ'], scopes: [G]});
    reg.register({...base, id: 'transport.quick', title: 'Quick', keys: ['KeyQ'], scopes: [S]});
    expect(checkShadowing(reg)).toEqual([
      'KeyQ: transport.quick (stage) shadows app.quit (global) without an entry in registry-shadows.js',
    ]);
  });

  it('one def bound in two scopes of a chain is not shadowing', () => {
    const reg = createRegistry();
    reg.register({...base, id: 'transport.playStop', title: 'Play', keys: ['Space'], scopes: [EC, E]});
    expect(checkShadowing(reg)).toEqual([]);
  });

  it('keys a stop scope blocks without binding them are not shadowing', () => {
    const reg = createRegistry();
    reg.register({...base, id: 'click.countIn', title: 'Count-in', group: 'Click', keys: ['KeyC'], scopes: [E]});
    reg.register({...base, id: 'chart.write', title: 'Write', group: 'Chart', keys: ['KeyN'], scopes: [ECS]});
    expect(runAll(reg)).toEqual([]);
  });

  it('drum letters may shadow only from chart.piece commands', () => {
    const reg = createRegistry();
    reg.register({...base, id: 'click.countIn', title: 'Count-in', group: 'Click', keys: ['KeyC'], scopes: [E]});
    reg.register({...base, id: 'chart.piece.crash', title: 'Crash', group: 'Chart', keys: ['KeyC'], scopes: [ECS]});
    expect(checkShadowing(reg)).toEqual([]);
    reg.unregister('chart.piece.crash');
    reg.register({...base, id: 'chart.cymbal', title: 'Cymbal', group: 'Chart', keys: ['KeyC'], scopes: [ECS]});
    expect(checkShadowing(reg)).toHaveLength(1);
  });

  it('flags a key bound twice in one scope', () => {
    const reg = createRegistry();
    reg.register({...base, id: 'a.one', title: 'One', keys: ['KeyX'], scopes: [L]});
    reg.register({...base, id: 'a.two', title: 'Two', keys: ['KeyX'], scopes: [L]});
    expect(checkScopes(reg)).toEqual(['library: KeyX is bound twice (a.one, a.two)']);
  });

  it('flags unknown chain scopes but allows overlay scopes', () => {
    const reg = createRegistry();
    reg.register({...base, id: 'a.one', title: 'One', keys: ['KeyX'], scopes: ['stage.stem', 'setting', 'admin.x', 'stagex']});
    reg.register({...base, id: 'palette.next', title: 'Next', group: 'App', keys: ['ArrowDown'], scopes: ['palette']});
    reg.register({...base, id: 'a.two', title: 'Two', keys: ['KeyY'], scopes: ['settings', 'admin']});
    expect(checkScopes(reg)).toEqual(['unknown scope "stage.stem"', 'unknown scope "setting"', 'unknown scope "admin.x"',
      'unknown scope "stagex"']);
  });

  it('treats Ctrl+ and Mod+ as one chord: a clash in a scope and shadowing across scopes', () => {
    const reg = createRegistry();
    reg.register({...base, id: 'a.one', title: 'One', keys: ['Mod+Alt+KeyX'], scopes: [L]});
    reg.register({...base, id: 'a.two', title: 'Two', keys: ['Ctrl+Alt+KeyX'], scopes: [L]});
    expect(checkScopes(reg)).toEqual(['library: Mod+Alt+KeyX is bound twice (a.one, a.two)']);
    const chain = createRegistry();
    chain.register({...base, id: 'app.bg', title: 'Background', group: 'App', keys: ['Ctrl+Alt+Space'], scopes: [G]});
    chain.register({...base, id: 'transport.bg', title: 'Stage', keys: ['Mod+Alt+Space'], scopes: [S]});
    expect(checkShadowing(chain)).toEqual([
      'Mod+Alt+Space: transport.bg (stage) shadows app.bg (global) without an entry in registry-shadows.js',
    ]);
  });

  it('flags declared dynamic ids that are not registered', () => {
    const reg = createRegistry();
    reg.registerDynamic('mix.mute.{n}', [1, 2]);
    reg.register({...base, id: 'mix.mute.1', title: 'Mute 1', group: 'Mix'});
    expect(checkDynamicFamilies(reg)).toEqual(['mix.mute.{n}: mix.mute.2 is declared but not registered']);
  });

  it('scans command references, matching template ids against the expanded set', () => {
    const src = [
      "Button({command: 'transport.again'});",
      'const items = [{label: "Mute", command: `mix.mute.${n}`}, {command: "nav.missing"}];',
      '// Button({command: \'commented.out\'})',
      '/* {command: "also.commented"} */',
      'const pieces = kit.map(k => ({command: `chart.piece.${k.id}`}));',
    ].join('\n');
    const refs = commandReferences(src);
    expect(refs).toEqual([
      {id: 'transport.again', template: false}, {id: 'mix.mute.${n}', template: true}, {id: 'nav.missing', template: false},
      {id: 'chart.piece.${k.id}', template: true},
    ]);
    const reg = createRegistry();
    reg.register({...base, id: 'transport.again', title: 'Again'});
    reg.registerDynamic({...base, id: 'mix.mute.{n}', title: 'Mute {n}', group: 'Mix'}, [1, 2]);
    expect(checkReferences(reg, refs.map(r => ({...r, where: 'x.js'})))).toEqual([
      'x.js: command "nav.missing" is not registered',
      'x.js: command "chart.piece.${k.id}" is not registered',
    ]);
  });

  it('reads CONTROL_SET command fields', () => {
    expect(controlCommands([
      {id: 'play', command: 'transport.playStop', longPress: 'transport.pause'},
      {id: 'speed', kind: 'stepper', dec: 'speed.down', inc: 'speed.up', value: 'speed.sheet', valueLongPress: 'speed.toggle100'},
      {id: 'mix', command: 'mix.minusMe', caret: 'mix.sheet', variants: ['rail']},
    ])).toEqual(['transport.playStop', 'transport.pause', 'speed.down', 'speed.up', 'speed.sheet', 'speed.toggle100', 'mix.minusMe',
      'mix.sheet']);
  });

  it('reads Electron menu command ids', () => {
    expect(menuReferences("{label: 'Settings…', id: 'nav.settings'}, {role: 'quit'}, sendCommand('app.shortcuts'), {id: 'file'}"))
      .toEqual(['nav.settings', 'app.shortcuts']);
  });

  it('flags reserved keys and missing groups on definitions that bypass validation', () => {
    const fake = {all: () => [{id: 'x.y', title: '', group: 'Nope', keys: ['Mod+KeyN', 'Ctrl+KeyW']}]};
    expect(checkDefinitions(fake)).toEqual(['x.y: no title', 'x.y: group "Nope" is not a registry group',
      'x.y: binds the reserved key Mod+KeyN', 'x.y: binds the reserved key Ctrl+KeyW']);
  });

  it('the contract table catches a stray binding', () => {
    const reg = contractRegistry();
    reg.register({...base, id: 'transport.stray', title: 'Stray', keys: ['KeyC'], scopes: [EC]});
    expect(runAll(reg)).toEqual([
      'KeyC: transport.stray (edit.chart) shadows click.countIn (edit) without an entry in registry-shadows.js',
    ]);
  });
});
