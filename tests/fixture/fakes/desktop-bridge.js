// window.woodshedDesktop fake for fx-desktop=1: every method of the final
// preload bridge (architecture §2.20, maps/companion-desktop.md §16.11), frozen
// like contextBridge's object. Every on*() returns `off`.
//   fx-update=available|downloading|ready   info().update.status (else 'idle')
//   fx-processor=starting|ready|stopped|restarting   main's processor phase (else 'ready';
//                                           'stopped' when fx-companion=down)
//   fx-shortcuts=fail                       setBackgroundShortcuts reports every key as failed
// Controls (window.fixture.desktop):
//   calls()                 every bridge call, [{method, args}]
//   menu()                  the last registerMenu spec (null before the first), menus() all of them
//   activity()              the last setActivity payload;  notifications(): every notify payload
//   command(id, source)     send a menu or global-shortcut command to onCommand listeners
//   navigate(route)         as a notification click does (onNavigate)
//   flush({timeoutMs})      ask onFlushRequest listeners to flush, like the quit guard: {flushed, timedOut}
//   fullScreen(on)          onFullScreen;  openUpdates(): onOpenUpdates
//   updateState(state)      push an update state to onUpdate listeners (and info().update)
//   processorState(state)   push {phase, …} to onProcessorState listeners (and info().processor)
//   setNotifyResult(shown)  what notify() resolves to (default true: the window was not focused)
import {PORT, TOKEN} from './companion.js';

const PLATFORM_ID = {mac: 'darwin-arm64', ipad: 'darwin-arm64', win: 'win32-x64'};
const SHORTCUTS = ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack'];
const MENU_IDS = /^[a-z][a-zA-Z0-9.-]{0,63}$/;

export function installDesktopBridge(win, fx = {}) {
  const calls = [], menus = [], notifications = [], activities = [];
  const listeners = {update: new Set(), openUpdates: new Set(), processor: new Set(), command: new Set(), navigate: new Set(), flush: new Set(), fullScreen: new Set()};
  let update = {status: fx.update || 'idle', percent: 40, version: '2.0.1'};
  let processor = {phase: fx.processor || (fx.companion === 'down' ? 'stopped' : 'ready')};
  let notifyResult = true;
  const platform = PLATFORM_ID[fx.platform] ?? 'darwin-arm64';

  const record = (method, args) => calls.push({method, args: structuredClone(args)});
  const on = (set, method) => cb => {
    record(method, []);
    if (typeof cb !== 'function') throw new TypeError(`woodshedDesktop.${method} needs a function`);
    set.add(cb);
    return () => set.delete(cb);
  };
  const emit = (set, payload) => { for (const cb of [...set]) cb(payload); };

  const bridge = Object.freeze({
    info: async () => { record('info', []); return {version: '2.0.0', platform, companion: fx.companion === 'down' ? null : {port: PORT, token: TOKEN}, update: {...update}, processor: {...processor}}; },
    update: async action => { record('update', [action]); return {...update}; },
    onUpdate: on(listeners.update, 'onUpdate'),
    onOpenUpdates: on(listeners.openUpdates, 'onOpenUpdates'),
    setTheme: async theme => { record('setTheme', [theme]); },
    mediaUrl: url => { record('mediaUrl', [url]); return url; },
    onProcessorState: on(listeners.processor, 'onProcessorState'),
    restartProcessor: async () => {
      record('restartProcessor', []);
      processor = {phase: 'restarting'}; emit(listeners.processor, {...processor});
      await new Promise(resolve => setTimeout(resolve, 300));
      processor = {phase: 'ready'}; emit(listeners.processor, {...processor});
      return {port: PORT, token: TOKEN};
    },
    registerMenu: spec => {
      record('registerMenu', [spec]);
      if (!Array.isArray(spec)) throw new TypeError('registerMenu needs an array of menus');
      const ids = spec.flatMap(m => (m.items ?? []).flatMap(i => [i, ...(i.submenu ?? [])])).filter(i => i.type !== 'separator').map(i => i.id);
      const bad = ids.filter(id => !MENU_IDS.test(String(id)));
      if (bad.length) win.console.error(`[fixture] registerMenu: invalid menu ids ${JSON.stringify(bad)}`);
      menus.push(structuredClone(spec));
    },
    onCommand: on(listeners.command, 'onCommand'),
    setActivity: activity => { record('setActivity', [activity]); activities.push(structuredClone(activity)); },
    setBackgroundShortcuts: async enabled => {
      record('setBackgroundShortcuts', [enabled]);
      if (!enabled) return {registered: [], failed: []};
      const failed = fx.shortcuts === 'fail';
      return {registered: failed ? [] : [...SHORTCUTS], failed: failed ? [...SHORTCUTS] : [], ...(platform.startsWith('darwin') ? {accessibility: failed ? 'needed' : 'granted'} : {})};
    },
    notify: async payload => { record('notify', [payload]); notifications.push(structuredClone(payload)); return notifyResult; },
    onNavigate: on(listeners.navigate, 'onNavigate'),
    onFlushRequest: on(listeners.flush, 'onFlushRequest'),
    onFullScreen: on(listeners.fullScreen, 'onFullScreen'),
  });
  win.woodshedDesktop = bridge;

  return {
    calls: () => structuredClone(calls),
    menu: () => (menus.length ? structuredClone(menus[menus.length - 1]) : null),
    menus: () => structuredClone(menus),
    activity: () => (activities.length ? structuredClone(activities[activities.length - 1]) : null),
    notifications: () => structuredClone(notifications),
    command(id, source = 'menu') { emit(listeners.command, {id, source}); return listeners.command.size; },
    navigate(route) { emit(listeners.navigate, route); return listeners.navigate.size; },
    async flush({timeoutMs = 3000} = {}) {
      const all = Promise.all([...listeners.flush].map(cb => Promise.resolve().then(cb)));
      let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
      const result = await Promise.race([all.then(() => 'done'), timeout]);
      clearTimeout(timer);
      return {flushed: result === 'done', timedOut: result === 'timeout', listeners: listeners.flush.size};
    },
    fullScreen(on) { emit(listeners.fullScreen, !!on); },
    openUpdates() { emit(listeners.openUpdates, undefined); },
    updateState(state) { update = {...update, ...state}; emit(listeners.update, {...update}); },
    processorState(state) { processor = {...state}; emit(listeners.processor, {...processor}); },
    setNotifyResult(shown) { notifyResult = !!shown; },
    listenerCounts: () => Object.fromEntries(Object.entries(listeners).map(([k, v]) => [k, v.size])),
  };
}
