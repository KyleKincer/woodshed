// @vitest-environment happy-dom
import {describe, expect, it, vi} from 'vitest';
import {createRegistry} from '../src/app/commands.js';
import {signal} from '../src/app/store.js';
import {buildMenuSpec, startDesktopMenu} from '../src/app/desktop-menu.js';

function setup() {
  const registry = createRegistry();
  const ran = [];
  registry.register({id: 'transport.again', title: 'Start again', group: 'Transport', keys: ['Enter'], scopes: ['stage'],
    menu: {label: 'Start again', electron: 'Transport'}, run: () => ran.push('again')});
  registry.register({id: 'nav.settings', title: 'Settings', group: 'App', run: () => ran.push('settings')});
  registry.register({id: 'app.undo', title: 'Undo', group: 'App', menu: {electron: 'Edit'}, run: () => ran.push('undo')});
  registry.register({id: 'stage.focus', title: 'Focus', group: 'View', keys: ['KeyF'], scopes: ['stage'], checked: () => false,
    menu: {label: 'Focus', electron: 'View'}, run: () => {}});
  const handlers = {};
  const desktop = {
    available: true,
    registerMenu: vi.fn(),
    setActivity: vi.fn(),
    onCommand: (cb) => { handlers.command = cb; return () => {}; },
    onNavigate: (cb) => { handlers.navigate = cb; return () => {}; },
    onFlushRequest: (cb) => { handlers.flush = cb; return () => {}; },
  };
  const store = {stage: signal(null)};
  return {registry, ran, desktop, handlers, store};
}

describe('desktop menu (renderer side)', () => {
  it('builds a MenuSpec from menu.electron defs with only Mod/Ctrl accelerators', () => {
    const {registry} = setup();
    const spec = buildMenuSpec(registry);
    // app.undo is built by desktop/menu.cjs itself, so it is never sent (no duplicate Undo).
    expect(spec.map(m => m.menu)).toEqual(['view', 'transport']);
    const again = spec.find(m => m.menu === 'transport').items[0];
    expect(again).toMatchObject({id: 'transport.again', label: 'Start again', enabled: true});
    expect(again.accelerator).toBeUndefined();   // Enter is a plain key: never registered natively (D41)
    expect(spec.find(m => m.menu === 'view').items[0]).toMatchObject({id: 'stage.focus', type: 'checkbox', checked: false});
  });

  it('runs menu commands through the registry, follows navigation, flushes before quit and reports activity', async () => {
    const {registry, ran, desktop, handlers, store} = setup();
    const router = {navigate: vi.fn()};
    const flush = vi.fn(async () => {});
    const stop = startDesktopMenu({router, registry, desktop, store, activeSession: async () => ({flush})});
    expect(desktop.registerMenu).toHaveBeenCalledTimes(1);
    handlers.command({id: 'app.undo', source: 'menu'});
    handlers.command({id: 'nav.settings'});
    expect(ran).toEqual(['undo', 'settings']);
    handlers.navigate('/settings');
    handlers.navigate('https://evil.example/');
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith('/settings');
    await handlers.flush();
    expect(flush).toHaveBeenCalledWith({final: true});
    expect(desktop.setActivity).toHaveBeenLastCalledWith({playing: false, songOpen: false});
    store.stage.value = {songId: 's1', playing: true};
    expect(desktop.setActivity).toHaveBeenLastCalledWith({playing: true, songOpen: true});
    stop();
  });

  it('does nothing outside the desktop app', () => {
    const {registry, store} = setup();
    const stop = startDesktopMenu({registry, store, desktop: {available: false}});
    expect(typeof stop).toBe('function');
    stop();
  });
});

describe('the real registry', () => {
  it("produces a MenuSpec that desktop/menu.cjs accepts", async () => {
    const {createRequire} = await import('node:module');
    const {validateMenuSpec} = createRequire(import.meta.url)('../desktop/menu.cjs');
    for (const load of [
      () => import('../src/app/global-commands.js'), () => import('../src/library/commands.js'),
      () => import('../src/stage/transport-commands.js'), () => import('../src/stage/commands.js'),
      () => import('../src/edit/commands.js'), () => import('../src/edit/map/commands.js'), () => import('../src/edit/chart/commands.js'),
    ]) await load();
    const {registry} = await import('../src/app/commands.js');
    const spec = buildMenuSpec(registry);
    expect(spec.length).toBeGreaterThan(0);
    expect(validateMenuSpec(spec)).not.toBeNull();
  });
});
