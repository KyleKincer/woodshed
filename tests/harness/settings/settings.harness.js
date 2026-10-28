// SE1's harness (/__harness/settings): the Settings view (src/settings/settings.js) on its real section
// modules, with the account controller (createAccount) over an in-memory settings.patch, so states can
// make saves fail and watch "Couldn't save · [Retry]". States: tests/fixture/states/SE1.cjs.
//   ?section=<id>        the section to open (default practice); section= (empty) opens /settings
//   fail=N               the first N settings.patch calls fail (offline)
//   countIn=on,len,unit  the stored count-in default, e.g. countIn=1,3,beats (custom)
//   admin=1              an administrator (Account shows Administration)
//   install=prompt|ios|installed|none   the PWA install state This device shows (default chromium, no prompt)
//   nowake=1             no Screen Wake Lock in this browser · nomedia=1 no Media Session
// It mounts the view through a small router of its own: navigate() between two sections updates the
// view (as the app router does for settingsPage), anything else remounts it; back() returns to the
// previous entry. window.__settings = {navigations, patches, settings(), view, back()}.
import {signal} from '/src/app/store.js';
import {ApiError} from '/src/api/client.js';
import {createAccount} from '/src/app/account.js';
import {createRegistry} from '/src/app/commands.js';
import {mergeSettings, withDefaults} from '/convex/lib/presets.ts';
import {mount} from '/src/settings/settings.js';

const INSTALL = {
  chromium: {canPrompt: false, installed: false, steps: 'chromium'},
  prompt: {canPrompt: true, installed: false, steps: 'chromium'},
  ios: {canPrompt: false, installed: false, steps: 'ios'},
  installed: {canPrompt: false, installed: true, steps: 'none'},
  none: {canPrompt: false, installed: false, steps: 'none'},
};

export default async function mountHarness(el, {query, h}) {
  const patches = [], navigations = [];
  let failures = Number(query.get('fail')) || 0;
  const saved = {};
  const countIn = query.get('countIn');
  if (countIn) {
    const [on, length, unit] = countIn.split(',');
    saved.practice = {countIn: {on: on === '1', length: Number(length), unit}};
  }
  const store = {config: signal(null), account: signal(withDefaults(saved)), pendingAccount: signal(null)};
  const api = {
    subscribeConfig: () => () => {},
    async patch(partial) {
      patches.push(JSON.parse(JSON.stringify(partial)));
      await new Promise(resolve => setTimeout(resolve, 60));
      if (failures > 0) {
        failures -= 1;
        throw new ApiError({code: 'network', message: 'Woodshed could not reach its server.'});
      }
      const merged = mergeSettings(withDefaults(store.account.peek()), partial);
      store.account.value = merged;
      return merged;
    },
  };
  const account = createAccount({store, api, toast: () => {}});

  const admin = query.get('admin') === '1';
  const session = signal({user: {id: 'u1', name: 'Kyle Kincer', email: 'kyle@example.com', image: null}, admin, status: 'active', online: true});
  const appStore = {session, update: signal({status: 'idle'})};
  const registry = createRegistry();
  const runs = [];
  registry.registerMany([
    {id: 'app.shortcuts', title: 'Keyboard shortcuts', group: 'App', keys: ['?'], scopes: ['global'], icon: 'keyboard', run: () => runs.push('app.shortcuts')},
    {id: 'app.signOut', title: 'Sign out', group: 'App', icon: 'log-out', run: () => runs.push('app.signOut')},
    {id: 'nav.admin', title: 'Administration', group: 'App', when: () => !!session.peek().admin, run: () => runs.push('nav.admin')},
  ]);
  const install = {state: signal(INSTALL[query.get('install')] ?? INSTALL.chromium), prompt: async () => 'dismissed'};
  const {platform: appPlatform} = await import('/src/app/platform.js');
  const features = {...appPlatform.features};
  if (query.get('nowake') === '1') features.wakeLock = false;
  if (query.get('nomedia') === '1') features.mediaSession = false;
  const platform = {...appPlatform, features};

  const outlet = h('div', {class: 'app-main', style: {height: '100%'}});
  const frame = h('div', {class: 'app-frame', dataset: {chrome: 'topbar'}, style: {height: '100%'}}, outlet);
  el.style.padding = '0';
  el.replaceChildren(frame);

  const entries = [];
  let view = null;
  const matchOf = (path, state) => {
    const section = path.replace(/^\/settings\/?/, '') || null;
    return section
      ? {name: 'settingsPage', path, params: {section}, query: {}, state}
      : {name: 'settings', path: '/settings', params: {}, query: {}, state};
  };
  /** Shows `next` coming from `from` (both matches): update between two sections, else remount. */
  async function show(next, from) {
    if (view && from?.name === 'settingsPage' && next.name === 'settingsPage') await view.update(next);
    else {
      await view?.unmount();
      view = await mount(outlet, next, ctx);
    }
    window.__settings.view = view;
  }
  const router = {
    navigate(to, {replace = false, state = null} = {}) {
      navigations.push({to, replace, state});
      const next = matchOf(to, state);
      const from = entries.at(-1) ?? null;
      if (replace && entries.length) entries[entries.length - 1] = next;
      else entries.push(next);
      return show(next, from);
    },
    back({fallback = '/settings'} = {}) {
      navigations.push({back: true});
      if (entries.length < 2) return router.navigate(fallback);
      const from = entries.pop();
      return show(entries.at(-1), from);
    },
  };
  const ctx = {router, account, store: appStore, registry, install, platform, desktop: {available: false}};
  window.__settings = {navigations, patches, runs, settings: () => JSON.parse(JSON.stringify(store.account.peek())), view: null, back: () => router.back()};

  const section = query.has('section') ? query.get('section') : 'practice';
  const path = section ? `/settings/${section}` : '/settings';
  entries.push(matchOf(path, null));
  view = await mount(outlet, entries[0], ctx);
  window.__settings.view = view;
  return view;
}
