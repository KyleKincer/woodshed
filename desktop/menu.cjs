'use strict';
// The native application menu (architecture §2.20, §6.11 item 3, D41).
//
// The renderer sends a MenuSpec built from the command registry; main
// validates it, merges it with the main-owned items (macOS app menu, Edit
// roles, zoom, Help) and installs it. Clicking an item sends
// `desktop:command` {id, source: 'menu'}. Only Mod (CmdOrCtrl) accelerators
// are ever registered; plain keys stay with the renderer's dispatcher.

const MENUS = Object.freeze(['file', 'edit', 'view', 'transport', 'help']);
const MENU_LABELS = Object.freeze({ file: 'File', edit: 'Edit', view: 'View', transport: 'Transport', help: 'Help' });
const ID_PATTERN = /^[a-z][a-zA-Z0-9.-]{0,63}$/;
const ITEM_TYPES = new Set(['normal', 'separator', 'checkbox', 'radio']);
const LIMITS = Object.freeze({ menus: 6, items: 60, label: 80 });
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Accelerator allow-list: CmdOrCtrl first, then optional distinct extra
// modifiers, then one key. Anything without CmdOrCtrl is a plain key (D41).
const MOD = new Set(['CmdOrCtrl', 'CommandOrControl']);
const EXTRA_MODIFIERS = Object.freeze({ Shift: 'Shift', Alt: 'Alt', Option: 'Alt', Ctrl: 'Ctrl', Control: 'Ctrl' });
const KEY_PATTERN = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Return|Enter|Escape|Backspace|Delete|Tab|Up|Down|Left|Right|Home|End|PageUp|PageDown|Plus|[,./\\[\];'`=-])$/;

/** Canonical form for collision checks ('Mod+Shift+Z'), or null when not allowed. */
function canonicalAccelerator(value) {
  if (typeof value !== 'string' || value.length > 48) return null;
  const parts = value.split('+');
  if (parts.length < 2) return null;
  const key = parts.pop();
  if (!MOD.has(parts.shift())) return null;
  const modifiers = new Set();
  for (const part of parts) {
    const canonical = Object.hasOwn(EXTRA_MODIFIERS, part) ? EXTRA_MODIFIERS[part] : null;
    if (!canonical || modifiers.has(canonical)) return null;
    modifiers.add(canonical);
  }
  if (!KEY_PATTERN.test(key)) return null;
  const order = ['Ctrl', 'Alt', 'Shift'].filter(m => modifiers.has(m));
  return ['Mod', ...order, key === 'Enter' ? 'Return' : key].join('+');
}

const isAccelerator = value => canonicalAccelerator(value) !== null;

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateItem(item, nested) {
  if (!isPlainObject(item)) return null;
  if (item.type === 'separator') return { type: 'separator' };
  const type = item.type === undefined ? 'normal' : item.type;
  if (!ITEM_TYPES.has(type)) return null;
  if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) return null;
  if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > LIMITS.label || CONTROL_CHARS.test(item.label)) return null;
  if (item.enabled !== undefined && typeof item.enabled !== 'boolean') return null;
  if (item.checked !== undefined && typeof item.checked !== 'boolean') return null;
  const out = { id: item.id, label: item.label, type, enabled: item.enabled !== false };
  if (item.accelerator !== undefined && item.accelerator !== null) {
    if (!isAccelerator(item.accelerator)) return null;
    out.accelerator = item.accelerator;
  }
  if (type === 'checkbox' || type === 'radio') out.checked = item.checked === true;
  if (item.submenu !== undefined) {
    if (nested || type !== 'normal' || !Array.isArray(item.submenu) || item.submenu.length > LIMITS.items) return null;
    const submenu = [];
    for (const child of item.submenu) {
      const valid = validateItem(child, true);
      if (!valid) return null;
      submenu.push(valid);
    }
    delete out.accelerator;
    out.submenu = submenu;
  }
  return out;
}

/**
 * Validates a renderer MenuSpec. Unknown keys are dropped; any violation
 * rejects the whole spec (main then keeps the previous menu).
 * @returns {Array<{menu: string, items: object[]}>|null}
 */
function validateMenuSpec(spec) {
  if (!Array.isArray(spec) || spec.length > LIMITS.menus) return null;
  const seen = new Set();
  const out = [];
  for (const menu of spec) {
    if (!isPlainObject(menu) || !MENUS.includes(menu.menu) || seen.has(menu.menu)) return null;
    if (!Array.isArray(menu.items) || menu.items.length > LIMITS.items) return null;
    seen.add(menu.menu);
    const items = [];
    for (const item of menu.items) {
      const valid = validateItem(item, false);
      if (!valid) return null;
      items.push(valid);
    }
    out.push({ menu: menu.menu, items });
  }
  return out;
}

// Electron owns ⌘N, ⌘W and ⌘, (spec §7.4): the registry never binds them as
// keys, so main attaches them to their commands.
const FIXED_ACCELERATORS = Object.freeze({
  'library.add': 'CmdOrCtrl+N',
  'stage.close': 'CmdOrCtrl+W',
  'nav.settings': 'CmdOrCtrl+,',
});
// Items main builds itself; a registry item with one of these ids is skipped.
const MAIN_OWNED_IDS = new Set(['nav.settings', 'app.undo', 'app.redo', 'app.shortcuts']);
// Accelerators the main-owned items and roles use; registry items never take them.
const RESERVED = new Set([
  'Mod+N', 'Mod+W', 'Mod+,', 'Mod+T', 'Mod+Q', 'Mod+H', 'Mod+Alt+H', 'Mod+M',
  'Mod+Z', 'Mod+Shift+Z', 'Mod+Y', 'Mod+X', 'Mod+C', 'Mod+V', 'Mod+Alt+Shift+V', 'Mod+Shift+V', 'Mod+A',
  'Mod+0', 'Mod+Plus', 'Mod+=', 'Mod+-', 'Mod+Shift+=', 'Mod+Ctrl+F',
  'Mod+R', 'Mod+Shift+R', 'Mod+Alt+I', 'Mod+Shift+I',
  'Mod+1', 'Mod+2', 'Mod+3', 'Mod+4', 'Mod+5', 'Mod+6', 'Mod+7', 'Mod+8', 'Mod+9',
]);

const sep = () => ({ type: 'separator' });

function convert(item, ctx) {
  if (item.type === 'separator') return sep();
  const out = { id: item.id, label: item.label, enabled: item.enabled !== false };
  if (item.submenu) {
    out.submenu = item.submenu.map(child => convert(child, ctx));
    return out;
  }
  if (item.type === 'checkbox' || item.type === 'radio') {
    out.type = item.type;
    out.checked = item.checked === true;
  }
  const fixed = FIXED_ACCELERATORS[item.id];
  const accelerator = fixed ?? item.accelerator;
  const canonical = canonicalAccelerator(accelerator);
  if (canonical && (fixed || (!RESERVED.has(canonical) && !ctx.used.has(canonical)))) {
    out.accelerator = accelerator;
    ctx.used.add(canonical);
  }
  if (item.id === 'stage.close') out.enabled = out.enabled && ctx.songOpen;
  const { id } = item;
  out.click = () => ctx.send(id);
  return out;
}

function registryItems(byMenu, menu, ctx) {
  return (byMenu.get(menu) || [])
    .filter(item => item.type === 'separator' || !MAIN_OWNED_IDS.has(item.id))
    .map(item => convert(item, ctx));
}

function tidy(items) {
  const out = [];
  for (const item of items) {
    if (item.type === 'separator' && (out.length === 0 || out.at(-1).type === 'separator')) continue;
    out.push(item);
  }
  while (out.length && out.at(-1).type === 'separator') out.pop();
  return out;
}

function command(ctx, id, label, extra = {}) {
  return { id, label, click: () => ctx.send(id), ...extra };
}

/**
 * Builds the Electron template for a validated spec.
 * @param {Array<{menu: string, items: object[]}>} spec  validated (validateMenuSpec)
 * @param {{isMac: boolean, isPackaged: boolean, songOpen?: boolean, appName?: string, send: (id: string) => void, openUpdates: () => void, openLicenses: () => void}} options
 */
function buildTemplate(spec, { isMac, isPackaged, songOpen = false, appName = 'Woodshed', send, openUpdates, openLicenses }) {
  const ctx = { send, songOpen, used: new Set() };
  const byMenu = new Map((spec || []).map(menu => [menu.menu, menu.items]));
  const settings = command(ctx, 'nav.settings', 'Settings…', { accelerator: FIXED_ACCELERATORS['nav.settings'] });
  const template = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => openUpdates() },
        sep(),
        settings,
        sep(),
        { role: 'services' },
        sep(),
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        sep(),
        { role: 'quit' },
      ],
    });
  }

  const file = registryItems(byMenu, 'file', ctx);
  if (!file.some(item => item.id === 'stage.close')) {
    file.push(convert({ id: 'stage.close', label: 'Close Song', type: 'normal', enabled: true }, ctx));
  }
  if (!isMac) file.push(sep(), settings, sep(), { role: 'quit', label: 'Exit' });
  template.push({ label: MENU_LABELS.file, submenu: tidy(file) });

  const editExtra = registryItems(byMenu, 'edit', ctx);
  template.push({
    label: MENU_LABELS.edit,
    submenu: tidy([
      command(ctx, 'app.undo', 'Undo', { accelerator: 'CmdOrCtrl+Z' }),
      command(ctx, 'app.redo', 'Redo', { accelerator: 'CmdOrCtrl+Shift+Z' }),
      sep(),
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'selectAll' },
      ...(editExtra.length ? [sep(), ...editExtra] : []),
    ]),
  });

  template.push({
    label: MENU_LABELS.view,
    submenu: tidy([
      ...registryItems(byMenu, 'view', ctx),
      sep(),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      sep(),
      { role: 'togglefullscreen' },
      ...(isPackaged ? [] : [sep(), { role: 'reload' }, { role: 'toggleDevTools' }]),
    ]),
  });

  const transport = tidy(registryItems(byMenu, 'transport', ctx));
  if (transport.length) template.push({ label: MENU_LABELS.transport, submenu: transport });

  const helpExtra = registryItems(byMenu, 'help', ctx);
  template.push({
    label: MENU_LABELS.help,
    ...(isMac ? { role: 'help' } : {}),
    submenu: tidy([
      command(ctx, 'app.shortcuts', 'Keyboard Shortcuts'),
      { label: 'Licenses', click: () => openLicenses() },
      ...(isMac ? [] : [sep(), { label: 'Check for Updates…', click: () => openUpdates() }]),
      ...(helpExtra.length ? [sep(), ...helpExtra] : []),
    ]),
  });

  return template;
}

/** The menu installed at startup, before the renderer registers its spec. */
function fallbackTemplate(options) {
  return buildTemplate([], options);
}

/**
 * Owns the installed menu: keeps the last valid spec and rebuilds on a new
 * spec or a songOpen change.
 * @param {{Menu: typeof Electron.Menu, isMac: boolean, isPackaged: boolean, appName?: string, send: (id) => void, openUpdates: () => void, openLicenses: () => void}} options
 */
function createMenuController({ Menu, ...options }) {
  let spec = [];
  let songOpen = false;
  const template = () => buildTemplate(spec, { ...options, songOpen });
  function install() {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template()));
  }
  return {
    install,
    template,
    /** @returns {boolean} false when the spec was rejected (the previous menu stays). */
    setSpec(raw) {
      const valid = validateMenuSpec(raw);
      if (!valid) return false;
      spec = valid;
      install();
      return true;
    },
    setSongOpen(on) {
      const next = on === true;
      if (next === songOpen) return;
      songOpen = next;
      install();
    },
    get songOpen() {
      return songOpen;
    },
  };
}

module.exports = {
  MENUS,
  LIMITS,
  FIXED_ACCELERATORS,
  canonicalAccelerator,
  isAccelerator,
  validateMenuSpec,
  buildTemplate,
  fallbackTemplate,
  createMenuController,
};
