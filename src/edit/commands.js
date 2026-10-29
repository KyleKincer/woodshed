// The shared Edit commands (architecture §3.4, scope E; spec §5.0): Done (the layered Esc), the
// posture tabs, and the Electron Edit menu's Undo / Redo routed to the posture's stack. Importing
// this module registers them on the app registry (main.js and registry CI do);
// defineEditCommands() registers them on any registry (tests).
//
// Definitions are eager and cheap (D46): every `run` goes through the 'edit' context that the Edit
// frame (src/edit/edit.js) or the bulk Details posture bar provides while mounted:
//   edit = {tab, tabs, bulk, setTab(tab), done(), escape(), undo(), redo(), saveStatus}
//
//   edit.done       Esc (scope E) runs edit.escape(): the layered Esc of §3.4 (Map: clear the typed
//                   bar → stop the preview → Keep my map → close Find → Done; Chart and Details: Done).
//                   Menus, sheets and the iPad panel sheets close before it (dispatcher rules 3 and 8),
//                   and the score's chart.clear runs first while the score has focus (rule 6).
//                   From the palette or a button it is Done at once.
//   edit.tab.<tab>  Map · Chart · Details (replaceState); checked on the open tab.
//   app.undo/redo   menu only (Electron Edit menu): a focused text field → document.execCommand,
//                   else the posture's stack: the Stage → practice.undo; Edit · Map → map.undo;
//                   Edit · Chart → chart.undo; Edit · Details has none.
//
// The entry origin. Done goes back in history when the entry before Edit is this song's Stage, else
// it replaces Edit with the song's Stage (§2.15). The router has no "previous entry", so this module
// follows the navigations (router.onLeave) from the first registry change after the router exists:
// the Stage and the Library both change command state when they mount, which is always before
// anyone can open Edit from them. A deep link or a reload has no origin (Done replaces).

import {registry as appRegistry} from '../app/commands.js';

const E = 'edit';
export const EDIT_TABS = Object.freeze(['map', 'chart', 'details']);
const EDIT_ROUTES = new Set(['edit', 'editFind']);

/** Titles and labels shared by the commands and the frame (spec §5.0, §3.4). */
export const COMMAND_COPY = Object.freeze({
  done: 'Done',
  tabs: Object.freeze({map: 'Map', chart: 'Chart', details: 'Details'}),
  undo: 'Undo',
  redo: 'Redo',
});

/** The undo / redo command of each stack the posture routes to (null: the posture has none). */
export const UNDO_COMMANDS = Object.freeze({
  stage: Object.freeze({undo: 'practice.undo', redo: 'practice.redo'}),
  map: Object.freeze({undo: 'map.undo', redo: 'map.redo'}),
  chart: Object.freeze({undo: 'chart.undo', redo: 'chart.redo'}),
  details: null,
});

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'submit', 'reset', 'hidden']);

/** True when `el` takes typed text (the dispatcher's rule 4 test). */
export function isTextField(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(String(el.type || 'text').toLowerCase());
  if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') return true;
  return !!el.closest?.('[data-text-input]');
}

/** The edit tab a context is on: the 'edit' context, else the route (bulk Details is 'details'). */
export function tabOf(c) {
  const tab = c?.edit?.tab ?? c?.route?.params?.tab ?? (c?.route?.name === 'bulkDetails' ? 'details' : null);
  return EDIT_TABS.includes(tab) ? tab : null;
}

/** The command app.undo / app.redo runs in this context ('undo' | 'redo'), or null. */
export function undoTarget(c, which) {
  const posture = c?.posture ?? null;
  if (posture === 'stage') return UNDO_COMMANDS.stage[which];
  if (posture === 'edit') {
    const tab = tabOf(c);
    return tab ? UNDO_COMMANDS[tab]?.[which] ?? null : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The entry origin (see the header)

let origin = null;                 // {songId, fromStage}
const armed = new WeakSet();

/** Records one navigation (router.onLeave's (from, to)); exported for tests. */
export function noteNavigation(from, to) {
  if (!to || !EDIT_ROUTES.has(to.name)) return;
  const id = to.params?.songId;
  if (!id) return;
  // A tab switch, or Find opening and closing, keeps the origin of the Edit entry.
  if (from && EDIT_ROUTES.has(from.name) && from.params?.songId === id && origin?.songId === id) return;
  origin = {songId: id, fromStage: from?.name === 'stage' && from.params?.songId === id};
}

/** True when the history entry before this song's Edit is its Stage. */
export function cameFromStage(songId) {
  return !!origin && origin.songId === String(songId) && origin.fromStage;
}

/** Follows the router's navigations (idempotent per router). Returns true when armed. */
export function armEditOrigin(router) {
  if (!router || typeof router.onLeave !== 'function') return false;
  if (armed.has(router)) return true;
  armed.add(router);
  router.onLeave((from, to) => noteNavigation(from, to));
  return true;
}

/** Forgets the origin (tests). */
export function resetEditOrigin() { origin = null; }

// ---------------------------------------------------------------------------------------------------------------
// The definitions

const hasEdit = (c) => !!c?.edit && typeof c.edit.done === 'function';

/**
 * Registers the shared Edit commands on `registry`. Returns off(). `document` is where app.undo
 * finds the focused text field (tests pass their own).
 */
export function defineEditCommands({registry = appRegistry, document: doc = globalThis.document} = {}) {
  const focusedTextField = () => isTextField(doc?.activeElement ?? null);

  function undoDef(which) {
    const title = which === 'undo' ? COMMAND_COPY.undo : COMMAND_COPY.redo;
    return {
      id: `app.${which}`, title, group: 'App', icon: which === 'undo' ? 'undo-2' : 'redo-2',
      menu: {label: title, electron: 'Edit'},
      palette: {hidden: true},
      when: (c) => {
        if (focusedTextField()) return true;
        const target = undoTarget(c, which);
        return !!target && registry.isEnabled(target);
      },
      run: (c) => {
        if (focusedTextField()) {
          try { doc.execCommand?.(which); } catch { /* the field keeps its own history */ }
          return;
        }
        const target = undoTarget(c, which);
        if (target) registry.run(target, {source: c.source ?? 'menu', event: c.event ?? undefined});
      },
    };
  }

  const tabDef = (tab) => ({
    id: `edit.tab.${tab}`, title: COMMAND_COPY.tabs[tab], group: 'Edit', scopes: [E],
    icon: tab === 'details' ? 'pencil' : tab === 'chart' ? 'drum' : 'grid-3x3',
    menu: {label: COMMAND_COPY.tabs[tab], radio: 'editTab'},
    palette: {keywords: ['edit', 'tab', tab]},
    when: (c) => hasEdit(c) && typeof c.edit.setTab === 'function' && (c.edit.tabs ?? EDIT_TABS).includes(tab),
    checked: (c) => c?.edit?.tab === tab,
    run: (c) => { void c.edit.setTab(tab); },
  });

  const off = registry.registerMany([
    {
      id: 'edit.done', title: COMMAND_COPY.done, group: 'Edit', keys: ['Escape'], scopes: [E], icon: 'chevron-left',
      palette: {keywords: ['done', 'leave', 'back', 'close', 'stage']},
      when: hasEdit,
      run: (c) => {
        if (c.source === 'key' && typeof c.edit.escape === 'function') void c.edit.escape();
        else void c.edit.done();
      },
    },
    ...EDIT_TABS.map(tabDef),
    undoDef('undo'),
    undoDef('redo'),
  ]);

  // Follow the router once it exists (see the header).
  let offArm = null;
  const tryArm = () => {
    let router = null;
    try { router = registry.context().router; } catch { /* no context yet */ }
    if (armEditOrigin(router)) { offArm?.(); offArm = null; }
  };
  offArm = registry.onChange(tryArm);
  tryArm();
  return () => { offArm?.(); off(); };
}

/** The ids defined here (registry CI and tests). */
export const EDIT_COMMAND_IDS = Object.freeze(['edit.done', ...EDIT_TABS.map((t) => `edit.tab.${t}`), 'app.undo', 'app.redo']);

defineEditCommands();
