// Global and navigation commands (architecture §3.5, scope G): the palette, the ? sheet, the layered
// Esc, the places, app updates, sign-out, and the Jobs and demo entry points. Importing this module
// registers them on the app registry (main.js and registry CI do); defineGlobalCommands() registers
// them on any registry (tests).
//
// Context the commands read (registry providers, set by main.js): router, feedback, topbar (the
// search field), stage (stage.js: toggleFocus), library (the Library: {selecting, exitSelection()}).
//
// app.escape, in order (spec §4.9, §3.5; overlays close before it, dispatcher rule 8; Edit uses
// edit.done, which shadows it in the edit scope):
//   Stage:   Focus on → leave Focus; playing → status "Stop playback first (Space)"; stopped and
//            not an iPad → stage.leave (on an iPad, ‹ leaves). Esc never navigates while playing.
//   Library: search text → clear it; selection mode → exit selection.
//   Anything else: no binding (the key stays native).

import {registry as appRegistry} from './commands.js';
import {signOut as authSignOut} from './auth.js';
import {desktop as appDesktop} from './desktop.js';
import {openPalette as appOpenPalette} from './palette.js';
import {platform as appPlatform} from './platform.js';
import {openShortcuts as appOpenShortcuts} from './shortcuts-sheet.js';
import {store as appStore} from './store.js';

// Modules of later waves, resolved by contract path (absent until built: their commands stay hidden).
const LATER = import.meta.glob(['../library/jobs.js', '../share/demo.js']);

export const SETTINGS_SECTIONS = Object.freeze(['practice', 'instruments', 'pedals', 'processing', 'appearance', 'plan', 'device', 'account']);
export const SECTION_TITLES = Object.freeze({
  practice: 'Practice', instruments: 'Instruments', pedals: 'Pedals & keys', processing: 'Processing',
  appearance: 'Appearance', plan: 'Plan & storage', device: 'This device', account: 'Account',
});

export const COPY = Object.freeze({
  palette: 'Command palette',
  shortcuts: 'Keyboard shortcuts',
  escape: 'Close / back',
  stopFirst: 'Stop playback first (Space)',
  library: 'Library',
  settings: 'Settings…',
  section: name => `Settings: ${name}`,
  plan: 'Plan & storage',
  admin: 'Administration',
  updates: 'App updates',
  updateReady: 'Update ready — Restart to install',
  updateDownloading: pct => `Downloading update ${pct}%`,
  download: 'Get the desktop app',
  signOut: 'Sign out',
  jobs: 'Jobs',
  demo: 'Open the example song',
});

/** The avatar menu and palette title of app.updates for a desktop update state (spec §6.5). */
export function updateTitle(update) {
  if (update?.status === 'ready') return COPY.updateReady;
  if (update?.status === 'downloading') {
    const pct = Math.max(0, Math.min(100, Math.round(Number(update.percent) || 0)));
    return COPY.updateDownloading(pct);
  }
  return COPY.updates;
}

/**
 * What Esc does in this context (see the header), or null when it does nothing. Pure apart from
 * the reads it makes.
 */
export function escapeAction(c, {store = appStore, platform = appPlatform, registry = appRegistry} = {}) {
  const posture = c?.posture ?? null;
  if (posture === 'stage') {
    const stage = store.stage.peek();
    if (stage?.focus && typeof c.stage?.toggleFocus === 'function') return () => c.stage.toggleFocus();
    if (stage?.playing) return () => c.feedback?.status?.(COPY.stopFirst);
    if (!platform.isIPad && registry.get('stage.leave')) {
      return () => registry.run('stage.leave', {source: c.source ?? 'key', event: c.event ?? undefined});
    }
    return null;
  }
  if (posture === 'edit') return null;
  if (c?.place === 'library') {
    if (c.topbar?.searchValue) return () => c.topbar.clearSearch();
    if (c.library?.selecting && typeof c.library.exitSelection === 'function') return () => c.library.exitSelection();
  }
  return null;
}

const go = path => c => c.router?.navigate?.(path);

/** Registers the §3.5 G commands on `registry`. Returns off(). Every dependency can be replaced (tests). */
export function defineGlobalCommands({
  registry = appRegistry, store = appStore, platform = appPlatform, desktop = appDesktop,
  openPalette = appOpenPalette, openShortcuts = appOpenShortcuts, signOut = authSignOut, later = LATER,
  win = globalThis.window,
} = {}) {
  const lazy = (path, name) => async (...args) => {
    const load = later[path];
    if (!load) return undefined;
    return (await load())[name](...args);
  };
  const openJobsPopover = lazy('../library/jobs.js', 'openJobsPopover');
  const openDemo = lazy('../share/demo.js', 'openDemo');

  const offMany = registry.registerMany([
    {id: 'app.palette', title: COPY.palette, group: 'App', keys: ['Mod+KeyK'], scopes: ['global'], icon: 'search',
      palette: {hidden: true}, run: () => openPalette()},
    {id: 'app.shortcuts', title: COPY.shortcuts, group: 'App', keys: ['?'], scopes: ['global'], icon: 'keyboard',
      palette: {keywords: ['keys', 'hotkeys', 'help']}, run: () => openShortcuts()},
    {id: 'app.escape', title: COPY.escape, group: 'App', keys: ['Escape'], scopes: ['global'], palette: {hidden: true},
      when: c => escapeAction(c, {store, platform, registry}) != null,
      run: c => escapeAction(c, {store, platform, registry})?.()},
    {id: 'nav.library', title: COPY.library, group: 'App', icon: 'layout-grid', palette: {keywords: ['home', 'songs']}, run: go('/')},
    {id: 'nav.settings', title: COPY.settings, group: 'App', icon: 'settings', palette: {keywords: ['preferences', 'options']},
      menu: {label: COPY.settings}, run: go('/settings')},
    {id: 'nav.plan', title: COPY.plan, group: 'App', icon: 'hard-drive', palette: {keywords: ['billing', 'storage', 'subscription']},
      run: go('/settings/plan')},
    {id: 'nav.admin', title: COPY.admin, group: 'App', icon: 'sliders-horizontal', when: () => !!store.session.peek()?.admin,
      run: go('/admin')},
    {id: 'app.updates', title: () => updateTitle(store.update.peek()), group: 'App', icon: 'download',
      when: () => !!desktop.available, palette: {keywords: ['update', 'version']}, run: () => desktop.update('show')},
    {id: 'app.download', title: COPY.download, group: 'App', icon: 'external-link', when: () => !desktop.available,
      palette: {keywords: ['desktop', 'mac', 'windows', 'install']}, run: () => { win?.open?.('/download', '_blank', 'noopener'); }},
    {id: 'app.signOut', title: COPY.signOut, group: 'App', icon: 'log-out', palette: {keywords: ['log out', 'logout']},
      run: () => signOut()},
    {id: 'library.jobs', title: COPY.jobs, group: 'Library', icon: 'list', when: () => !!later['../library/jobs.js'],
      run: c => openJobsPopover({anchor: c.args?.anchor ?? c.topbar?.jobsSlot ?? null, focusJobId: c.args?.jobId ?? null})},
    {id: 'library.demo', title: COPY.demo, group: 'Library', icon: 'play', when: () => !!later['../share/demo.js'],
      palette: {keywords: ['example', 'demo', 'try']}, run: c => openDemo(c.router)},
  ]);
  const offSections = registry.registerDynamic({
    id: 'nav.settings.{n}', title: (c, n) => COPY.section(SECTION_TITLES[n]), group: 'App', icon: 'settings',
    palette: {keywords: ['settings']}, run: (c, {n}) => c.router?.navigate?.(`/settings/${n}`),
  }, SETTINGS_SECTIONS);
  return () => { offSections(); offMany(); };
}

defineGlobalCommands();
