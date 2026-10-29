// PD1's harness (/__harness/pedals): Settings → Pedals & keys (src/settings/sections/pedals.js) in the real Settings
// view, with this device's real prefs (ws.prefs), the real dispatcher (Learn my pedal takes keys through it) and, when
// asked, a desktop bridge whose background shortcuts can partly fail. States: tests/fixture/states/PD1.cjs.
//   pedals=<json>       prefs.pedals to start from (e.g. two learned pedals); absent: nothing learned
//   midi=<json>         prefs.midi to start from
//   desktop=1           Woodshed for desktop: the Background shortcuts row
//   taken=<acc,…>       accelerators another app holds (setBackgroundShortcuts reports them failed)
//   mac=1               macOS: the media keys need the Accessibility permission until it is granted
//   nomidi=1            a browser without Web MIDI (no MIDI pedals row)
//   state=<json>        what desktop.info().backgroundShortcuts reports at first (e.g. {"enabled":true,…})
// window.__pedals = {calls: [{method, args}], prefs() → prefs.pedals, midi() → prefs.midi, runs: [command ids]}.
import {signal} from '/src/app/store.js';
import {createRegistry} from '/src/app/commands.js';
import {startDispatcher} from '/src/app/dispatch.js';
import {prefs} from '/src/app/prefs.js';
import {mount} from '/src/settings/settings.js';

const ACCELERATORS = ['Control+Alt+Space', 'Control+Alt+Return', 'Control+Alt+L', 'MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop'];

const json = (query, key) => {
  const raw = query.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

function fakeDesktop({taken, mac, initial, calls}) {
  let granted = false;
  return {
    available: true,
    async info() {
      calls.push({method: 'info', args: []});
      return {version: '2.0.0', platform: mac ? 'darwin-arm64' : 'win32-x64', backgroundShortcuts: initial ?? {enabled: false, registered: [], failed: []}};
    },
    async setBackgroundShortcuts(on, options) {
      calls.push({method: 'setBackgroundShortcuts', args: options ? [on, options] : [on]});
      await new Promise(resolve => setTimeout(resolve, 40));
      if (!on) return {registered: [], failed: []};
      if (options?.promptAccessibility) granted = true;
      const result = {registered: ACCELERATORS.filter(a => !taken.includes(a)), failed: ACCELERATORS.filter(a => taken.includes(a))};
      return mac ? {...result, accessibility: granted ? 'granted' : 'needed'} : result;
    },
    update: async () => ({status: 'current'}),
    watchStatus: () => () => {},
  };
}

export default async function mountHarness(el, {query, h}) {
  const calls = [], runs = [];
  const pedals = json(query, 'pedals');
  const midi = json(query, 'midi');
  prefs.update(d => {
    d.pedals = pedals ?? {enabled: false, profile: 'practice', pedals: [], custom: {}};
    d.midi = midi ?? {enabled: false, bindings: []};
  });

  const registry = createRegistry();
  const cmd = (id, title, group, extra = {}) => ({id, title, group, pedal: true, run: () => runs.push(id), ...extra});
  registry.registerMany([
    {id: 'app.shortcuts', title: 'Keyboard shortcuts', group: 'App', keys: ['?'], scopes: ['global'], icon: 'keyboard', run: () => runs.push('app.shortcuts')},
    cmd('transport.playStop', 'Play / Stop', 'Transport'),
    cmd('transport.again', 'Start again', 'Transport'),
    cmd('transport.loopToggle', 'Loop', 'Loop'),
    cmd('nav.prevSection', 'Previous section', 'Navigate'),
    cmd('nav.nextSection', 'Next section', 'Navigate'),
    cmd('trainer.toggle', 'Start trainer', 'Speed'),
    cmd('mix.minusMe', 'Minus me', 'Mix'),
    cmd('stage.scrollUp', 'Scroll up one screen', 'View'),
    cmd('stage.scrollDown', 'Scroll down one screen', 'View'),
    cmd('stage.scrollTop', 'Back to the top', 'View'),
  ]);
  startDispatcher({registry});

  const {platform: appPlatform} = await import('/src/app/platform.js');
  const desktopApp = query.get('desktop') === '1';
  const mac = query.get('mac') === '1';
  const features = {...appPlatform.features, midi: query.get('nomidi') === '1' ? false : !!appPlatform.features.midi};
  const platform = {...appPlatform, features, isDesktopApp: desktopApp, isMac: mac || (!desktopApp && appPlatform.isMac)};
  const taken = (query.get('taken') ?? '').split(',').filter(Boolean);
  const desktop = desktopApp ? fakeDesktop({taken, mac, initial: json(query, 'state'), calls}) : {available: false};

  const outlet = h('div', {class: 'app-main', style: {height: '100%'}});
  const frame = h('div', {class: 'app-frame', dataset: {chrome: 'topbar'}, style: {height: '100%'}}, outlet);
  el.style.padding = '0';
  el.replaceChildren(frame);

  const session = signal({user: {id: 'u1', name: 'Kyle Kincer', email: 'kyle@example.com', image: null}, admin: false, status: 'active', online: true});
  const store = {session, update: signal({status: 'idle'})};
  const router = {navigate: () => Promise.resolve(), back: () => Promise.resolve()};
  window.__pedals = {
    calls, runs,
    prefs: () => JSON.parse(JSON.stringify(prefs.get('pedals'))),
    midi: () => JSON.parse(JSON.stringify(prefs.get('midi'))),
  };
  return mount(outlet, {name: 'settingsPage', path: '/settings/pedals', params: {section: 'pedals'}, query: {}, state: null},
    {router, store, registry, platform, desktop, install: {state: signal({canPrompt: false, installed: false, steps: 'none'}), prompt: async () => 'dismissed'}});
}
