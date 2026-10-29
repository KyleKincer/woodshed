// The renderer side of the Electron app menu (architecture §2.20, package DT2).
//
// startDesktopMenu({router}) → stop
//   - builds a MenuSpec from registry definitions that carry `menu.electron` and sends it with
//     desktop.registerMenu (re-sent, debounced 100 ms, when the registry or the Stage changes);
//   - runs menu clicks (desktop.onCommand) through the registry, so ⌘Z, ⌘, and Close Song work;
//   - follows desktop.onNavigate, flushes the open song before quit (desktop.onFlushRequest);
//   - reports {playing, songOpen} with desktop.setActivity (update prompts wait while playing; ⌘W enablement).
// Wake (keepAwake) is reported by platform.js. Outside the desktop app this does nothing.
import {registry as appRegistry} from './commands.js';
import {desktop as appDesktop} from './desktop.js';
import {accelerator} from './keys.js';
import {effect, store as appStore} from './store.js';

export const MENU_DEBOUNCE_MS = 100;
const MENUS = Object.freeze(['file', 'edit', 'view', 'transport', 'help']);
const ID_RE = /^[a-z][a-zA-Z0-9.-]{0,63}$/;
const MAX_ITEMS = 60;
/** Items desktop/menu.cjs builds itself (Edit → Undo/Redo, Help → Keyboard Shortcuts, Settings…); sending them would duplicate. */
const MAIN_OWNED = new Set(['app.undo', 'app.redo', 'app.shortcuts', 'nav.settings']);

/** The MenuSpec for every registered definition with `menu.electron` (only Mod/Ctrl accelerators, D41). */
export function buildMenuSpec(registry = appRegistry) {
  const byMenu = new Map(MENUS.map(m => [m, []]));
  for (const def of registry.all()) {
    const menu = String(def.menu?.electron ?? '').toLowerCase();
    if (!byMenu.has(menu) || !ID_RE.test(def.id) || MAIN_OWNED.has(def.id)) continue;
    // Commands that do not apply here (e.g. Transport with no song open) stay in the menu, disabled.
    const s = registry.state(def.id);
    if (!s) continue;
    const label = String(def.menu?.label ?? s.title ?? def.title ?? '').slice(0, 80);
    if (!label) continue;
    const item = {id: def.id, label, enabled: !!s.enabled};
    const key = (def.keys ?? []).map(k => { try { return accelerator(k); } catch { return null; } }).find(Boolean);
    if (key) item.accelerator = key;
    if (typeof def.checked === 'function') {
      item.type = def.menu?.radio ? 'radio' : 'checkbox';
      item.checked = !!s.checked;
    }
    const items = byMenu.get(menu);
    if (items.length < MAX_ITEMS) items.push(item);
  }
  return MENUS.filter(m => byMenu.get(m).length).map(m => ({menu: m, items: byMenu.get(m)}));
}

export function startDesktopMenu({router = null, registry = appRegistry, desktop = appDesktop, store = appStore,
  activeSession = null, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout} = {}) {
  if (!desktop?.available) return () => {};
  const offs = [];
  let timer = null;
  let lastSpec = '';
  const send = () => {
    timer = null;
    try {
      const spec = buildMenuSpec(registry);
      const json = JSON.stringify(spec);
      if (json === lastSpec) return;
      lastSpec = json;
      desktop.registerMenu(spec);
    } catch (err) { console.error('desktop menu:', err); }
  };
  const schedule = () => {
    if (timer != null) return;
    timer = setTimer(send, MENU_DEBOUNCE_MS);
  };

  send();
  offs.push(registry.onChange(schedule));
  offs.push(desktop.onCommand(({id, source} = {}) => {
    if (typeof id !== 'string') return;
    registry.run(id, {source: source === 'global' ? 'global' : 'menu'});
  }));
  offs.push(desktop.onNavigate((route) => {
    if (typeof route === 'string' && route.startsWith('/')) router?.navigate?.(route);
  }));
  offs.push(desktop.onFlushRequest(async () => {
    const getSession = activeSession ?? (async () => (await import('../stage/session.js')).activeSession?.());
    const session = await getSession();
    await session?.flush?.({final: true});
  }));

  let lastActivity = '';
  offs.push(effect(() => {
    const st = store.stage.value;
    const activity = {playing: !!st?.playing, songOpen: !!st};
    const key = JSON.stringify(activity);
    if (key !== lastActivity) {
      lastActivity = key;
      desktop.setActivity(activity);
    }
    schedule();
  }));

  return () => {
    if (timer != null) clearTimer(timer);
    for (const off of offs.splice(0).reverse()) { try { off?.(); } catch {} }
  };
}

export default startDesktopMenu;
