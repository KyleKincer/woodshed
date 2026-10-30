// Edit · Chart commands (architecture §3.4 scopes Ec and Ecs, spec §5.2 and §7.2, D18, D45, D48, D56).
// Importing this module registers them on the app registry (main.js and registry CI do);
// defineChartCommands({registry}) registers them on any registry (tests).
//
// Definitions are eager and cheap (D46): this module imports only the registry, keys.js and the
// pure notation model. Every `run` reaches the editor through the command context:
//   chart   c.chart, the mounted Edit · Chart workspace (src/edit/chart/chart-edit.js provides
//           src/js/notation/editor.js's workspace): run(action, ...args), state()
// Nothing here runs while Edit · Chart is not mounted (`when` is false without c.chart).
//
// Scopes: 'edit.chart' (Ec) holds the posture's keys; 'edit.chart.score' (Ecs) is the focus and
// stop scope of the score and lanes surface (D45): while the surface has focus only its own
// bindings and the pass-through keys (Space, ⇧Space, Enter, Esc, PageUp/PageDown, ⌘K, ?, and E
// when no drum letter uses it) reach anything, so drum letters win and `,`, C, K and L never reach
// the posture there (D18). ⌘Z and ⌘⇧Z/⌘Y are bound in both scopes so undo works with the surface
// focused too (one def in two scopes of a chain is not shadowing).
//
// Drum letters: one `chart.piece.<kitId>` command per KIT piece, bound to the physical key
// (KeyStrings on e.code, D56): `prefs.edit.chart.keys[kitId]`, else the KIT default letter; an
// empty string means the user cleared it (no key, no default). setDrumKeys(keys) re-registers the
// 27 commands with new keys (Edit · Chart calls it on mount and when Drum keys… saves). The
// family is declared with registerDynamic so registry CI expands it.
//
// Arguments: chart.view {view: 'score'|'lanes'}, chart.partLayout {layout: 'combined'|'split'},
// chart.listen {mode: 'recording'|'notation'|'both'}, chart.paging {paging: 'pages'|'scroll'}.

import {registry as appRegistry} from '../../app/commands.js';
import {canonical, label as keyLabel} from '../../app/keys.js';
import {KIT} from '../../../shared/notation.ts';

export const EC = 'edit.chart';
export const ECS = 'edit.chart.score';
const ERASE = Object.freeze(['Backspace', 'Delete']);
const UNDO_KEYS = Object.freeze(['Mod+KeyZ']);
const REDO_KEYS = Object.freeze(['Mod+Shift+KeyZ', 'Mod+KeyY']);

/** Step keys (D18): digit → written value. 1 = 1/64 … 5 = 1/4; 6 and 7 are unbound. */
export const STEP_DIGITS = Object.freeze([1, 2, 3, 4, 5]);
export const STEP_VALUE = Object.freeze({1: 64, 2: 32, 3: 16, 4: 8, 5: 4});
export const STEP_LABEL = Object.freeze({1: '1/64', 2: '1/32', 3: '1/16', 4: '1/8', 5: '1/4'});
export const VIEWS = Object.freeze(['score', 'lanes']);
export const PART_LAYOUTS = Object.freeze(['combined', 'split']);
export const LISTEN_MODES = Object.freeze(['recording', 'notation', 'both']);
export const PAGING = Object.freeze(['pages', 'scroll']);

/** Titles and menu labels (spec §5.2, architecture §3.4). */
export const COPY = Object.freeze({
  undo: 'Undo notation',
  redo: 'Redo notation',
  undoMenu: 'Undo',
  redoMenu: 'Redo',
  pagePrev: 'Previous 16 bars',
  pageNext: 'Next 16 bars',
  loopSelection: 'Loop selection',
  write: 'Write note',
  piece: name => `Write ${name}`,
  cursorBack: 'Step back',
  cursorFwd: 'Step forward',
  extendBack: 'Extend selection back',
  extendFwd: 'Extend selection forward',
  pieceUp: 'Previous piece',
  pieceDown: 'Next piece',
  moveBack: 'Move notes earlier',
  moveFwd: 'Move notes later',
  barStart: 'Bar start',
  barEnd: 'Bar end',
  skip: 'Skip',
  step: n => `Step ${STEP_LABEL[n]}`,
  finer: 'Finer step',
  coarser: 'Coarser step',
  dot: 'Dotted',
  dotReason: 'Not with a tuplet.',
  tuplet: 'Cycle tuplet',
  accent: 'Accent',
  heavy: 'Heavy accent',
  ghost: 'Ghost note',
  delete: 'Delete selected notes',
  deleteReason: 'Select notes or bars first.',
  copy: 'Copy',
  paste: 'Paste',
  repeat: 'Repeat bars…',
  selectBar: 'Select bar',
  selectAll: 'Select all bars',
  clearPart: 'Clear drum chart…',
  clearPartReason: 'The drum chart is already empty.',
  clear: 'Clear selection',
  paging: 'Pages · Continuous',
  pages: 'Pages',
  scroll: 'Continuous',
  moveDialog: 'Move notes…',
  tupletDialog: 'Tuplet on this beat…',
  review: 'Mark bars reviewed',
  barMeter: 'Bar meter & label…',
  align: 'Align in tempo map…',
  export: 'Export .woodshed.json',
  print: 'Print',
  openPart: 'Open .woodshed.json part…',
  importDrums: 'Drum part from file (Guitar Pro, MIDI, Clone Hero)…',
  drumKeys: 'Drum keys…',
  noteList: 'Note list',
  allLanes: 'Show every kit piece',
  allLanesReason: 'Switch to Lanes to show every kit piece.',
  shortcuts: 'Keyboard shortcuts',
  view: 'Score · Lanes',
  score: 'Score',
  lanes: 'Lanes',
  partLayout: 'Part layout',
  combined: 'Together',
  split: 'Hands & feet',
  listen: 'Listen to',
  recording: 'Recording',
  notation: 'Notation',
  both: 'Both',
  playCursor: 'Play from cursor',
  fit: 'Fit',
  fitReason: 'Fit works in Lanes.',
  follow: 'Follow playback',
  retrySave: 'Retry saving',
  resolve: 'Review saved version',
  drumKeysTaken: (keys) => `Each pad needs its own letter. ${keys} ${keys.includes(',') || keys.includes(' and ') ? 'are' : 'is'} kept for the score's own keys.`,
  drumKeysDuplicate: (letter, a, b) => `${letter} is set for both ${a} and ${b}. Each pad needs its own letter.`,
  drumKeysLetter: name => `${name}: use one letter, A to Z.`,
});

/** The ids this module registers (registry CI and the tests); chart.piece.<kitId> and chart.step.N expand. */
export const CHART_COMMAND_IDS = Object.freeze([
  'chart.undo', 'chart.redo', 'chart.pagePrev', 'chart.pageNext', 'chart.loopSelection', 'chart.paging',
  'chart.write', 'chart.cursorBack', 'chart.cursorFwd', 'chart.extendBack', 'chart.extendFwd', 'chart.pieceUp', 'chart.pieceDown',
  'chart.moveBack', 'chart.moveFwd', 'chart.barStart', 'chart.barEnd', 'chart.skip', 'chart.finer', 'chart.coarser',
  'chart.dot', 'chart.tuplet', 'chart.accent', 'chart.heavy', 'chart.ghost', 'chart.delete', 'chart.copy', 'chart.paste',
  'chart.repeat', 'chart.selectBar', 'chart.selectAll', 'chart.clear', 'chart.clearPart',
  'chart.moveDialog', 'chart.tupletDialog', 'chart.review', 'chart.barMeter', 'chart.align', 'chart.export', 'chart.print',
  'chart.openPart', 'chart.importDrums', 'chart.drumKeys', 'chart.noteList', 'chart.allLanes', 'chart.shortcuts', 'chart.view',
  'chart.partLayout', 'chart.listen', 'chart.playCursor', 'chart.fit', 'chart.follow', 'chart.retrySave', 'chart.resolve',
]);
export const PIECE_IDS = Object.freeze(KIT.map(k => `chart.piece.${k.id}`));
export const STEP_IDS = Object.freeze(STEP_DIGITS.map(n => `chart.step.${n}`));

// ---------------------------------------------------------------------------------------------------------------
// Drum keys (D56): KeyStrings on e.code

/** 'q' → 'KeyQ'; anything but one ASCII letter → null. */
export function letterToKeyString(ch) {
  return typeof ch === 'string' && /^[a-z]$/i.test(ch) ? `Key${ch.toUpperCase()}` : null;
}

/** 'KeyQ' → 'Q'; anything else → ''. */
export function keyStringLetter(key) {
  const m = /^Key([A-Z])$/.exec(String(key ?? ''));
  return m ? m[1] : '';
}

/**
 * The KeyString a kit piece writes with: the stored key (a KeyString; '' means the user cleared it), else the
 * KIT default letter (none for the chokes). `keys` is prefs.edit.chart.keys.
 */
export function drumKeyFor(kit, keys = {}) {
  if (!kit) return '';
  const stored = keys?.[kit.id];
  if (typeof stored === 'string') {
    if (stored === '') return '';
    // A KeyString ('KeyQ'), or a bare letter a 1.9 export may still hold ('q').
    return letterToKeyString(keyStringLetter(stored) || stored) ?? '';
  }
  return letterToKeyString(kit.key) ?? '';
}

/** {kitId: KeyString|''} for every KIT piece. */
export function drumKeyMap(keys = {}) {
  return Object.fromEntries(KIT.map(k => [k.id, drumKeyFor(k, keys)]));
}

/** The label a pad shows for its key ('S'), through the keyboard layout map when keys.js has one (D56). */
export function drumKeyLabel(key) {
  return key ? keyLabel(key) : '';
}

/**
 * Keys the score's own commands bind (every key bound in 'edit.chart.score' except the drum letters, D18), as
 * {KeyString: title}. Drum keys may not take any of them.
 */
export function reservedScoreKeys(registry = appRegistry) {
  const out = {};
  for (const [key, def] of registry.bindingsFor(ECS)) {
    if (def.id.startsWith('chart.piece.')) continue;
    out[canonical(key)] = typeof def.title === 'function' ? def.id : def.title;
  }
  return out;
}

/**
 * Validates a Drum keys dialog result: `letters` is {kitId: 'q'|'Q'|''}. Returns {keys} (KeyStrings, '' for none)
 * or {error, kitId?}. Every letter must be one A–Z, unique, and not one the score binds (reserved, D18).
 */
export function validateDrumKeys(letters, {reserved = {}} = {}) {
  const keys = {};
  const seen = new Map();
  for (const kit of KIT) {
    const raw = String(letters?.[kit.id] ?? '').trim();
    if (!raw) { keys[kit.id] = ''; continue; }
    const key = letterToKeyString(raw);
    if (!key) return {error: COPY.drumKeysLetter(kit.name), kitId: kit.id};
    if (Object.hasOwn(reserved, key)) {
      const taken = Object.keys(reserved).filter(k => /^Key[A-Z]$/.test(k)).map(keyStringLetter).sort();
      const list = taken.length > 1 ? `${taken.slice(0, -1).join(', ')} and ${taken.at(-1)}` : taken[0] ?? keyStringLetter(key);
      return {error: COPY.drumKeysTaken(list), kitId: kit.id};
    }
    if (seen.has(key)) return {error: COPY.drumKeysDuplicate(keyStringLetter(key), seen.get(key).name, kit.name), kitId: kit.id};
    seen.set(key, kit);
    keys[kit.id] = key;
  }
  return {keys};
}

// ---------------------------------------------------------------------------------------------------------------
// Context readers (safe on a context with nothing provided)

const argOf = (c, name) => (c?.args && typeof c.args === 'object' ? c.args[name] : undefined);
/** The mounted Edit · Chart workspace, or null. */
export const chartOf = c => (c?.chart && typeof c.chart === 'object' && typeof c.chart.run === 'function' ? c.chart : null);
/** The workspace's state snapshot, or null. */
export const chartState = c => {
  const chart = chartOf(c);
  try { return chart ? chart.state() : null; } catch { return null; }
};
const hasChart = c => !!chartOf(c);
const act = (action, ...args) => c => { chartOf(c)?.run(action, ...args); };

// ---------------------------------------------------------------------------------------------------------------
// Definitions

/**
 * Registers the Edit · Chart commands on `registry`. Returns {off(), setDrumKeys(keys)}: setDrumKeys re-registers
 * the drum-letter commands with prefs.edit.chart.keys (KeyStrings; '' = none).
 */
export function defineChartCommands({registry = appRegistry, keys = {}} = {}) {
  const ec = def => ({group: 'Chart', when: hasChart, ...def, scopes: def.scopes ?? (def.keys ? [EC] : [])});
  const ecs = def => ({group: 'Chart', when: hasChart, ...def, scopes: [ECS]});
  const radio = (id, title, name, values, action, icon) => ec({
    id, title, icon, menu: {radio: true},
    checked: c => values.includes(argOf(c, name)) && chartState(c)?.[stateKey[name]] === argOf(c, name),
    palette: {hidden: true},
    run: (c, args) => { const v = args?.[name]; if (values.includes(v)) chartOf(c)?.run(action, v); },
  });
  const stateKey = {view: 'layout', layout: 'partLayout', mode: 'listenMode', paging: 'paging'};

  const defs = [
    // ---- posture (Ec) ------------------------------------------------------------------------------------------
    // Undo, Redo and the pagers are simply unavailable at the ends of their range (a disabled button, no reason text).
    ec({id: 'chart.undo', title: COPY.undo, keys: UNDO_KEYS, scopes: [EC, ECS], icon: 'undo-2', menu: {label: COPY.undoMenu},
      when: c => !!chartState(c)?.canUndo, run: act('undo')}),
    ec({id: 'chart.redo', title: COPY.redo, keys: REDO_KEYS, scopes: [EC, ECS], icon: 'redo-2', menu: {label: COPY.redoMenu},
      when: c => !!chartState(c)?.canRedo, run: act('redo')}),
    ec({id: 'chart.pagePrev', title: COPY.pagePrev, keys: ['[', 'PageUp'], scopes: [EC], icon: 'chevron-left',
      when: c => { const s = chartState(c); return !!s && s.range.first > 0; }, run: act('page-prev')}),
    ec({id: 'chart.pageNext', title: COPY.pageNext, keys: [']', 'PageDown'], scopes: [EC], icon: 'chevron-right',
      when: c => { const s = chartState(c); return !!s && s.range.last < s.range.total - 1; }, run: act('page-next')}),
    ec({id: 'chart.loopSelection', title: COPY.loopSelection, keys: ['KeyL'], scopes: [EC], icon: 'repeat', run: act('loop')}),
    radio('chart.paging', COPY.paging, 'paging', PAGING, 'paging'),

    // ---- the score surface (Ecs, focus and stop scope) -------------------------------------------------------
    ecs({id: 'chart.write', title: COPY.write, keys: ['KeyN'], run: act('write')}),
    ecs({id: 'chart.cursorBack', title: COPY.cursorBack, keys: ['ArrowLeft'], repeat: true, run: act('cursor', -1)}),
    ecs({id: 'chart.cursorFwd', title: COPY.cursorFwd, keys: ['ArrowRight'], repeat: true, run: act('cursor', 1)}),
    ecs({id: 'chart.extendBack', title: COPY.extendBack, keys: ['Shift+ArrowLeft'], repeat: true, run: act('cursor', -1, {extend: true})}),
    ecs({id: 'chart.extendFwd', title: COPY.extendFwd, keys: ['Shift+ArrowRight'], repeat: true, run: act('cursor', 1, {extend: true})}),
    ecs({id: 'chart.pieceUp', title: COPY.pieceUp, keys: ['ArrowUp'], repeat: true, run: act('piece-step', -1)}),
    ecs({id: 'chart.pieceDown', title: COPY.pieceDown, keys: ['ArrowDown'], repeat: true, run: act('piece-step', 1)}),
    ecs({id: 'chart.moveBack', title: COPY.moveBack, keys: ['Alt+ArrowLeft'], repeat: true, run: act('move', -1)}),
    ecs({id: 'chart.moveFwd', title: COPY.moveFwd, keys: ['Alt+ArrowRight'], repeat: true, run: act('move', 1)}),
    ecs({id: 'chart.barStart', title: COPY.barStart, keys: ['Home'], run: act('bar-start')}),
    ecs({id: 'chart.barEnd', title: COPY.barEnd, keys: ['End'], run: act('bar-end')}),
    ecs({id: 'chart.skip', title: COPY.skip, keys: ['KeyR'], icon: 'arrow-right', run: act('skip')}),
    ecs({id: 'chart.finer', title: COPY.finer, keys: ['='], run: act('finer')}),
    ecs({id: 'chart.coarser', title: COPY.coarser, keys: ['-'], run: act('coarser')}),
    ecs({id: 'chart.dot', title: COPY.dot, keys: ['.'], checked: c => !!chartState(c)?.step.dotted,
      disabledReason: c => (chartState(c)?.step.tuplet > 1 ? COPY.dotReason : null), run: act('dot')}),
    ecs({id: 'chart.tuplet', title: COPY.tuplet, keys: ['/'], run: act('tuplet-cycle')}),
    ecs({id: 'chart.accent', title: COPY.accent, keys: ['KeyA'], checked: c => !!chartState(c)?.expression.accent, run: act('accent')}),
    ecs({id: 'chart.heavy', title: COPY.heavy, keys: ['Shift+KeyA'], checked: c => !!chartState(c)?.expression.heavy, run: act('heavy')}),
    ecs({id: 'chart.ghost', title: COPY.ghost, keys: ['KeyG'], checked: c => !!chartState(c)?.expression.ghost, run: act('ghost')}),
    ecs({id: 'chart.delete', title: COPY.delete, keys: ERASE, icon: 'trash-2',
      disabledReason: c => (chartState(c) && !chartState(c).deletable ? COPY.deleteReason : null), run: act('delete')}),
    ecs({id: 'chart.copy', title: COPY.copy, keys: ['Mod+KeyC'], icon: 'copy', run: act('copy')}),
    ecs({id: 'chart.paste', title: COPY.paste, keys: ['Mod+KeyV'], run: act('paste')}),
    ecs({id: 'chart.repeat', title: COPY.repeat, keys: ['Mod+KeyD'], run: act('repeat')}),
    ecs({id: 'chart.selectBar', title: COPY.selectBar, keys: ['Mod+KeyA'], run: act('select-bar')}),
    // ⌘A twice selects every bar too; this is its menu and palette entry.
    ec({id: 'chart.selectAll', title: COPY.selectAll, run: act('select-all')}),
    // Esc clears only when there is something to clear; otherwise it passes through to Done (D18, §3.4 edit.done).
    ecs({id: 'chart.clear', title: COPY.clear, keys: ['Escape'], palette: {hidden: true},
      when: c => !!chartState(c)?.canClear, run: act('clear')}),

    // ---- menu-only (each shown with its shortcut where it has one) -------------------------------------------
    ec({id: 'chart.moveDialog', title: COPY.moveDialog, run: act('move-dialog')}),
    ec({id: 'chart.tupletDialog', title: COPY.tupletDialog, run: act('tuplet-dialog')}),
    ec({id: 'chart.review', title: COPY.review, icon: 'check', run: act('review')}),
    ec({id: 'chart.barMeter', title: COPY.barMeter, run: act('align')}),
    ec({id: 'chart.align', title: COPY.align, run: act('align-beat')}),
    ec({id: 'chart.export', title: COPY.export, icon: 'download', run: act('export')}),
    ec({id: 'chart.print', title: COPY.print, run: act('print')}),
    ec({id: 'chart.openPart', title: COPY.openPart, icon: 'folder-open', run: act('import')}),
    ec({id: 'chart.importDrums', title: COPY.importDrums, icon: 'file-music', run: act('drum-import')}),
    ec({id: 'chart.clearPart', title: COPY.clearPart, icon: 'trash-2',
      disabledReason: c => (chartState(c)?.empty ? COPY.clearPartReason : null), run: act('clear-part')}),
    ec({id: 'chart.drumKeys', title: COPY.drumKeys, icon: 'keyboard', run: act('drum-keys')}),
    ec({id: 'chart.noteList', title: COPY.noteList, icon: 'list', checked: c => !!chartState(c)?.showList, run: act('list')}),
    ec({id: 'chart.allLanes', title: COPY.allLanes, checked: c => !!chartState(c)?.allLanes,
      disabledReason: c => (chartState(c) && chartState(c).layout !== 'lanes' ? COPY.allLanesReason : null), run: act('all-lanes')}),
    ec({id: 'chart.shortcuts', title: COPY.shortcuts, icon: 'keyboard', run: () => {
      void import('../../app/shortcuts-sheet.js').then(m => m.openShortcuts({registry, chain: [ECS, EC, 'edit', 'global']}))
        .catch(err => console.warn('[chart] the shortcut sheet could not be opened', err));
    }}),
    radio('chart.view', COPY.view, 'view', VIEWS, 'view'),
    radio('chart.partLayout', COPY.partLayout, 'layout', PART_LAYOUTS, 'part-layout'),
    radio('chart.listen', COPY.listen, 'mode', LISTEN_MODES, 'listen'),
    ec({id: 'chart.playCursor', title: COPY.playCursor, icon: 'play', run: act('play-cursor')}),
    ec({id: 'chart.fit', title: COPY.fit, icon: 'scan',
      disabledReason: c => (chartState(c) && chartState(c).layout !== 'lanes' ? COPY.fitReason : null), run: act('fit')}),
    ec({id: 'chart.follow', title: COPY.follow, checked: c => !!chartState(c)?.follow, run: act('follow')}),
    ec({id: 'chart.retrySave', title: COPY.retrySave, icon: 'refresh-cw', when: c => chartState(c)?.recovery === 'retry', run: act('retry-save')}),
    ec({id: 'chart.resolve', title: COPY.resolve, when: c => chartState(c)?.recovery === 'resolve', run: act('resolve')}),
  ];

  const offMany = registry.registerMany(defs);
  const offSteps = registry.registerDynamic({
    id: 'chart.step.{n}', group: 'Chart', keys: ['Digit{n}'], scopes: [ECS],
    title: (c, n) => COPY.step(n),
    when: c => hasChart(c),
    checked: (c, n) => { const s = chartState(c)?.step; return !!s && s.value === STEP_VALUE[n] && s.tuplet === 1; },
    run: (c, {n}) => { chartOf(c)?.run('step', n); },
  }, STEP_DIGITS);

  let current = drumKeyMap(keys);
  let offPieces = registerPieces(current);
  const offFamily = registry.registerDynamic('chart.piece.{n}', KIT.map(k => k.id));

  function registerPieces(map) {
    return registry.registerMany(KIT.map(kit => ({
      id: `chart.piece.${kit.id}`, group: 'Chart', title: COPY.piece(kit.name), scopes: [ECS],
      keys: map[kit.id] ? [map[kit.id]] : [],
      when: hasChart,
      checked: c => chartState(c)?.piece?.id === kit.id,
      palette: {keywords: ['write', kit.short.toLowerCase()]},
      run: (c) => { chartOf(c)?.run('piece', kit.id); },
    })));
  }

  return {
    /** Re-registers the drum letters with prefs.edit.chart.keys (KeyStrings; '' = none). No-op when unchanged. */
    setDrumKeys(next = {}) {
      const map = drumKeyMap(next);
      if (KIT.every(k => map[k.id] === current[k.id])) return false;
      offPieces();
      current = map;
      offPieces = registerPieces(current);
      return true;
    },
    /** The drum-letter map now registered. */
    get drumKeys() { return {...current}; },
    off() { offPieces(); offFamily(); offSteps(); offMany(); },
  };
}

const appCommands = defineChartCommands();
/** Re-registers the app registry's drum-letter commands (Edit · Chart on mount and on Drum keys save). */
export const setDrumKeys = keys => appCommands.setDrumKeys(keys);
