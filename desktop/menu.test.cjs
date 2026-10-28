const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateMenuSpec, buildTemplate, fallbackTemplate, createMenuController, canonicalAccelerator, isAccelerator, LIMITS,
} = require('./menu.cjs');

const goodSpec = () => [
  { menu: 'file', items: [{ id: 'library.add', label: 'Add Songs…', enabled: true }, { id: 'stage.close', label: 'Close Song', enabled: true }] },
  {
    menu: 'view',
    items: [
      { id: 'view.chart', label: 'Chart', type: 'radio', checked: true, enabled: true },
      { id: 'view.roadmap', label: 'Road map', type: 'radio', checked: false, enabled: true },
      { type: 'separator' },
      { id: 'stage.focus', label: 'Focus', type: 'checkbox', checked: false, enabled: true },
      {
        id: 'view.distance', label: 'Distance', enabled: true,
        submenu: [
          { id: 'view.distance.near', label: 'Near', type: 'radio', checked: true, enabled: true },
          { id: 'view.distance.stand', label: 'Stand', type: 'radio', checked: false, enabled: true },
        ],
      },
    ],
  },
  {
    menu: 'transport',
    items: [
      { id: 'transport.playStop', label: 'Play/Stop', enabled: true },
      { id: 'transport.again', label: 'Again', enabled: false },
      { id: 'mix.minusMe', label: 'Minus me', accelerator: 'CmdOrCtrl+Shift+M', enabled: true },
    ],
  },
];

function flatten(template) {
  const out = [];
  const walk = items => {
    for (const item of items) {
      out.push(item);
      if (Array.isArray(item.submenu)) walk(item.submenu);
    }
  };
  walk(template);
  return out;
}
const find = (template, id) => flatten(template).find(item => item.id === id);
const menuNamed = (template, label) => template.find(menu => menu.label === label);
const opts = (extra = {}) => ({ isMac: true, isPackaged: true, send: () => {}, openUpdates: () => {}, openLicenses: () => {}, ...extra });

test('a valid spec passes and unknown keys are dropped', () => {
  const spec = goodSpec();
  spec[0].items[0].evil = 'x';
  spec[0].extra = 1;
  const valid = validateMenuSpec(spec);
  assert.ok(valid);
  assert.deepEqual(Object.keys(valid[0]), ['menu', 'items']);
  assert.equal(valid[0].items[0].evil, undefined);
  assert.equal(valid[1].items[4].submenu.length, 2);
  assert.equal(valid[2].items[2].accelerator, 'CmdOrCtrl+Shift+M');
});

test('bad ids are rejected', () => {
  for (const id of ['', 'Transport.play', '1abc', 'a b', 'a_b', 'x'.repeat(65), 42, undefined, 'a/b']) {
    const spec = goodSpec();
    spec[2].items[0].id = id;
    assert.equal(validateMenuSpec(spec), null, String(id));
  }
  const spec = goodSpec();
  spec[2].items[0].id = 'a' + 'b'.repeat(63);
  assert.ok(validateMenuSpec(spec), '64-character id is allowed');
});

test('bad accelerators are rejected and plain keys are never accepted', () => {
  for (const accelerator of ['Space', 'L', 'Shift+L', 'Alt+Left', 'Control+Alt+Space', 'CmdOrCtrl', 'CmdOrCtrl+Shift+Shift+K', 'CmdOrCtrl+Hyper+K',
    'CmdOrCtrl+KK', 'CmdOrCtrl+k', 'Cmd+K', 'CmdOrCtrl+K;rm', 42, 'CmdOrCtrl+F25']) {
    const spec = goodSpec();
    spec[2].items[0].accelerator = accelerator;
    assert.equal(validateMenuSpec(spec), null, String(accelerator));
  }
  for (const accelerator of ['CmdOrCtrl+K', 'CmdOrCtrl+Shift+Z', 'CmdOrCtrl+Alt+Shift+Return', 'CmdOrCtrl+,', 'CmdOrCtrl+F5', 'CmdOrCtrl+Plus', 'CommandOrControl+[']) {
    assert.ok(isAccelerator(accelerator), accelerator);
  }
  assert.equal(canonicalAccelerator('CmdOrCtrl+Shift+Alt+Enter'), 'Mod+Alt+Shift+Return');
});

test('depth beyond one submenu level is rejected', () => {
  const spec = goodSpec();
  spec[1].items[4].submenu[0] = { id: 'view.deeper', label: 'Deeper', submenu: [{ id: 'view.deepest', label: 'Deepest' }] };
  assert.equal(validateMenuSpec(spec), null);
  const checkboxParent = goodSpec();
  checkboxParent[1].items[4].type = 'checkbox';
  assert.equal(validateMenuSpec(checkboxParent), null, 'a submenu parent is a normal item');
});

test('limits, menu names, types and labels are enforced', () => {
  assert.equal(validateMenuSpec('nope'), null);
  assert.equal(validateMenuSpec(Array.from({ length: LIMITS.menus + 1 }, () => ({ menu: 'file', items: [] }))), null);
  assert.equal(validateMenuSpec([{ menu: 'window', items: [] }]), null);
  assert.equal(validateMenuSpec([{ menu: 'file', items: [] }, { menu: 'file', items: [] }]), null, 'duplicate menus');
  const many = Array.from({ length: LIMITS.items + 1 }, (_, i) => ({ id: `x.item${i}`, label: `Item ${i}` }));
  assert.equal(validateMenuSpec([{ menu: 'transport', items: many }]), null);
  assert.ok(validateMenuSpec([{ menu: 'transport', items: many.slice(0, LIMITS.items) }]));
  for (const patch of [{ type: 'submenu' }, { label: '' }, { label: 'x'.repeat(81) }, { label: 'a\nb' }, { enabled: 'yes' }, { checked: 1 }]) {
    const spec = goodSpec();
    Object.assign(spec[2].items[0], patch);
    assert.equal(validateMenuSpec(spec), null, JSON.stringify(patch));
  }
});

test('plain keys are never registered as accelerators', () => {
  // Even an unvalidated spec cannot smuggle a plain-key accelerator into the template.
  const template = buildTemplate([{ menu: 'transport', items: [
    { id: 'transport.playStop', label: 'Play/Stop', type: 'normal', enabled: true, accelerator: 'Space' },
    { id: 'transport.loopToggle', label: 'Loop', type: 'normal', enabled: true, accelerator: 'L' },
  ] }], opts());
  for (const item of flatten(template)) {
    if (item.accelerator !== undefined) assert.ok(isAccelerator(item.accelerator), `${item.label}: ${item.accelerator}`);
    assert.notEqual(item.registerAccelerator, true);
  }
  assert.equal(find(template, 'transport.playStop').accelerator, undefined);
  assert.equal(find(template, 'transport.loopToggle').accelerator, undefined);
});

test('⌘W (Close Song) is disabled without a song and enabled with one', () => {
  const spec = validateMenuSpec(goodSpec());
  const closed = find(buildTemplate(spec, opts({ songOpen: false })), 'stage.close');
  assert.equal(closed.accelerator, 'CmdOrCtrl+W');
  assert.equal(closed.enabled, false);
  assert.equal(find(buildTemplate(spec, opts({ songOpen: true })), 'stage.close').enabled, true);
  const fallback = find(fallbackTemplate(opts()), 'stage.close');
  assert.equal(fallback.enabled, false, 'the fallback menu also owns ⌘W');
  // A renderer that disables the command keeps it disabled.
  const disabled = validateMenuSpec(goodSpec());
  disabled[0].items[1].enabled = false;
  assert.equal(find(buildTemplate(disabled, opts({ songOpen: true })), 'stage.close').enabled, false);
});

test('Electron owns ⌘N, ⌘W and ⌘, and main-owned accelerators win', () => {
  const spec = validateMenuSpec([
    { menu: 'file', items: [{ id: 'library.add', label: 'Add Songs…' }] },
    { menu: 'transport', items: [
      { id: 'transport.steal', label: 'Steal undo', accelerator: 'CmdOrCtrl+Z' },
      { id: 'transport.first', label: 'First', accelerator: 'CmdOrCtrl+K' },
      { id: 'transport.second', label: 'Second', accelerator: 'CmdOrCtrl+K' },
    ] },
  ]);
  const template = buildTemplate(spec, opts());
  assert.equal(find(template, 'library.add').accelerator, 'CmdOrCtrl+N');
  assert.equal(find(template, 'nav.settings').accelerator, 'CmdOrCtrl+,');
  assert.equal(find(template, 'app.undo').accelerator, 'CmdOrCtrl+Z');
  assert.equal(find(template, 'transport.steal').accelerator, undefined);
  assert.equal(find(template, 'transport.first').accelerator, 'CmdOrCtrl+K');
  assert.equal(find(template, 'transport.second').accelerator, undefined, 'duplicates keep the first');
});

test('macOS template: fixed app menu, Edit roles with custom undo, zoom, Help', () => {
  const sent = [];
  let updates = 0, licenses = 0;
  const template = buildTemplate(validateMenuSpec(goodSpec()), opts({ send: id => sent.push(id), openUpdates: () => updates++, openLicenses: () => licenses++ }));
  assert.deepEqual(template.map(menu => menu.label), ['Woodshed', 'File', 'Edit', 'View', 'Transport', 'Help']);
  const appMenu = template[0].submenu;
  assert.deepEqual(appMenu.filter(i => i.role).map(i => i.role), ['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit']);
  appMenu.find(i => i.label === 'Check for Updates…').click();
  assert.equal(updates, 1);
  const settings = appMenu.find(i => i.id === 'nav.settings');
  assert.equal(settings.label, 'Settings…');
  settings.click();
  const edit = menuNamed(template, 'Edit').submenu;
  assert.deepEqual(edit.filter(i => i.role).map(i => i.role), ['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll']);
  assert.ok(!edit.some(i => i.role === 'undo' || i.role === 'redo'), 'undo is the app stack, not a role');
  find(template, 'app.undo').click();
  find(template, 'app.redo').click();
  const view = menuNamed(template, 'View').submenu;
  assert.deepEqual(view.filter(i => i.role).map(i => i.role), ['resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']);
  const help = menuNamed(template, 'Help');
  assert.equal(help.role, 'help');
  assert.ok(!help.submenu.some(i => i.label === 'Check for Updates…'), 'macOS has it in the app menu');
  find(template, 'app.shortcuts').click();
  help.submenu.find(i => i.label === 'Licenses').click();
  assert.equal(licenses, 1);
  find(template, 'transport.playStop').click();
  find(template, 'view.distance.near').click();
  assert.deepEqual(sent, ['nav.settings', 'app.undo', 'app.redo', 'app.shortcuts', 'transport.playStop', 'view.distance.near']);
  assert.equal(find(template, 'view.distance').click, undefined, 'submenu parents do not run commands');
  assert.equal(find(template, 'view.chart').type, 'radio');
  assert.equal(find(template, 'view.chart').checked, true);
  assert.equal(find(template, 'transport.again').enabled, false);
  assert.ok(!flatten(template).some(i => i.role === 'close' || i.role === 'windowMenu'), '⌘W never closes the window');
});

test('Windows/Linux template: Settings and Exit in File, updates in Help, dev tools only unpackaged', () => {
  const packaged = buildTemplate(validateMenuSpec(goodSpec()), opts({ isMac: false }));
  assert.deepEqual(packaged.map(menu => menu.label), ['File', 'Edit', 'View', 'Transport', 'Help']);
  const file = menuNamed(packaged, 'File').submenu;
  assert.equal(file.find(i => i.id === 'nav.settings').accelerator, 'CmdOrCtrl+,');
  assert.deepEqual(file.at(-1), { role: 'quit', label: 'Exit' });
  assert.ok(menuNamed(packaged, 'Help').submenu.some(i => i.label === 'Check for Updates…'));
  assert.equal(menuNamed(packaged, 'Help').role, undefined);
  const roles = template => flatten(template).map(i => i.role).filter(Boolean);
  assert.ok(!roles(packaged).includes('reload') && !roles(packaged).includes('toggleDevTools'));
  const dev = buildTemplate(validateMenuSpec(goodSpec()), opts({ isMac: false, isPackaged: false }));
  assert.ok(roles(dev).includes('reload') && roles(dev).includes('toggleDevTools'));
});

test('registry items with main-owned ids are not duplicated; empty Transport is omitted', () => {
  const template = buildTemplate(validateMenuSpec([{ menu: 'file', items: [{ id: 'nav.settings', label: 'Settings…' }] }]), opts());
  assert.equal(flatten(template).filter(i => i.id === 'nav.settings').length, 1);
  assert.ok(!template.some(menu => menu.label === 'Transport'));
  for (const menu of template) {
    assert.notEqual(menu.submenu[0]?.type, 'separator', `${menu.label} starts with a separator`);
    assert.notEqual(menu.submenu.at(-1)?.type, 'separator', `${menu.label} ends with a separator`);
  }
});

test('the controller installs the fallback, keeps the previous menu on a bad spec and rebuilds on songOpen', () => {
  const installed = [];
  const Menu = { buildFromTemplate: template => ({ template }), setApplicationMenu: menu => installed.push(menu.template) };
  const sent = [];
  const controller = createMenuController({ Menu, ...opts({ send: id => sent.push(id) }) });
  controller.install();
  assert.equal(installed.length, 1);
  assert.equal(find(installed[0], 'transport.playStop'), undefined);
  assert.equal(controller.setSpec(goodSpec()), true);
  assert.equal(installed.length, 2);
  assert.ok(find(installed[1], 'transport.playStop'));
  assert.equal(controller.setSpec([{ menu: 'file', items: [{ id: 'BAD', label: 'x' }] }]), false);
  assert.equal(installed.length, 2, 'a rejected spec keeps the previous menu');
  assert.equal(find(installed[1], 'stage.close').enabled, false);
  controller.setSongOpen(true);
  assert.equal(installed.length, 3);
  assert.equal(find(installed[2], 'stage.close').enabled, true);
  assert.ok(find(installed[2], 'transport.playStop'), 'songOpen rebuilds from the last good spec');
  controller.setSongOpen(true);
  assert.equal(installed.length, 3, 'no rebuild without a change');
  find(installed[2], 'stage.close').click();
  assert.deepEqual(sent, ['stage.close']);
});
