// Library registry entries (architecture §3.5, scope L). Definitions are eager (D46): this module
// imports only the registry and pure helpers; every `run` reaches the view through the 'library'
// context home.js provides while it is mounted ({selecting, exitSelection, focusedSongId, layout,
// openFocused, editFocused, focusFirst, focusLast, toggleLayout}; selection mode adds select,
// selectAll and deleteSelected, LB3) and the 'router' and 'topbar' providers main.js sets.
//
// Arrow keys in the Library are the grid's roving focus (data-consume-keys); ⌘V is a paste
// listener on the view; Esc (clear the search, then exit selection) is app.escape.
// defineLibraryCommands({registry}) registers them on any registry (tests); importing the module
// registers them on the app registry (main.js's eager glob, registry CI).

import {registry as appRegistry} from '../app/commands.js';
import {COMMANDS} from './home.copy.js';

const L = ['library'];
const lib = c => c.library ?? null;
const has = name => c => typeof lib(c)?.[name] === 'function';
const selecting = c => !!lib(c)?.selecting;

export const LIBRARY_COMMAND_IDS = Object.freeze(['library.add', 'library.search', 'library.openFocused', 'library.editFocused',
  'library.deleteSelected', 'library.selectAll', 'library.select', 'library.first', 'library.last', 'library.view']);

export function defineLibraryCommands({registry = appRegistry} = {}) {
  return registry.registerMany([
    {id: 'library.add', title: COMMANDS.add, group: 'Library', keys: ['KeyN'], scopes: L, icon: 'plus',
      palette: {keywords: COMMANDS.addKeywords}, run: c => c.router?.navigate?.('/add')},
    {id: 'library.search', title: COMMANDS.search, group: 'Library', keys: ['/'], scopes: L, icon: 'search',
      when: c => typeof c.topbar?.focusSearch === 'function', palette: {hidden: true}, run: c => c.topbar.focusSearch()},
    {id: 'library.openFocused', title: COMMANDS.openFocused, group: 'Library', keys: ['Enter'], scopes: L, icon: 'play',
      when: c => !!lib(c)?.focusedSongId && has('openFocused')(c), palette: {hidden: true}, run: c => lib(c).openFocused()},
    {id: 'library.editFocused', title: COMMANDS.editFocused, group: 'Library', keys: ['KeyE'], scopes: L, icon: 'pencil',
      when: c => !!lib(c)?.focusedSongId && has('editFocused')(c), palette: {hidden: true}, run: c => lib(c).editFocused()},
    {id: 'library.deleteSelected', title: COMMANDS.deleteSelected, group: 'Library', keys: ['Backspace', 'Delete'], scopes: L, icon: 'trash-2',
      when: c => selecting(c) && has('deleteSelected')(c), run: c => lib(c).deleteSelected()},
    {id: 'library.selectAll', title: COMMANDS.selectAll, group: 'Library', keys: ['Mod+KeyA'], scopes: L, icon: 'check',
      when: c => selecting(c) && has('selectAll')(c), run: c => lib(c).selectAll()},
    {id: 'library.select', title: COMMANDS.select, group: 'Library', icon: 'check', when: has('select'), run: c => lib(c).select()},
    {id: 'library.first', title: COMMANDS.first, group: 'Library', keys: ['Home'], scopes: L, when: has('focusFirst'),
      palette: {hidden: true}, run: c => lib(c).focusFirst()},
    {id: 'library.last', title: COMMANDS.last, group: 'Library', keys: ['End'], scopes: L, when: has('focusLast'),
      palette: {hidden: true}, run: c => lib(c).focusLast()},
    {id: 'library.view', title: COMMANDS.view, group: 'Library', icon: 'layout-grid', when: has('toggleLayout'),
      checked: c => lib(c)?.layout === 'list', palette: {keywords: COMMANDS.viewKeywords}, run: c => lib(c).toggleLayout()},
  ]);
}

defineLibraryCommands();
