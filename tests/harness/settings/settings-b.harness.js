// SE2's harness (/__harness/settings-b): the Settings view (src/settings/settings.js) on its real section
// modules, with Processing and Plan & storage given fakes the fixture cannot stage: failing saves, every
// processor phase, a frozen or failing export, an unsupported cache, a plan that fails to load. States:
// tests/fixture/states/SE2.cjs.
//   ?section=processing|plan     the section to open (default processing)
//   desktop=1                    Woodshed for desktop (else a browser)
//   phase=ready|busy|starting|firstrun|pairing|offline|pair-failed   the processor (desktop)
//   fail=N                       the first N settings.patch calls fail (offline)
//   settings=<json>              stored account settings, merged over the defaults
//   legacy=none|one|many         what the old-library scan finds (desktop; default one)
//   importFail=1|missing         /import fails with an uncoded processor message (raw text behind Details),
//                                or ENOENT on <folder>/library.json (a mistyped folder)
//   originals=done|nojobs        /export-originals copies 48 files, or answers ENOENT (no jobs folder yet)
//   devices=mixed|none|online    the paired computers (web; default mixed: one busy, one offline)
//   devicesLoad=slow             devices.list answers after 800 ms (the store's list starts empty)
//   status=free|plus|cancel|grace|pastdue|disabled|loading|error   the billing status (plan; default free)
//   usage=normal|over|appfull    storage.usage
//   export=done|progress|toolarge|fail   what Export library does (default done after 600 ms)
//   picker=0 · ipad=1            no save picker (the 100 MB note) · an iPad
//   cache=<bytes>|unsupported    the playback cache (default 412 MB)
//   checkout=success             the Stripe return query
// window.__settingsB = {patches, calls, settings(), setPhase(phase), setDevices(list), pushStatus(change), view}.
import {signal} from '/src/app/store.js';
import {ApiError} from '/src/api/client.js';
import {createAccount} from '/src/app/account.js';
import {createRegistry} from '/src/app/commands.js';
import {PROCESSOR_COPY} from '/src/app/desktop.js';
import {feedback} from '/src/app/feedback.js';
import {BITRATES, DEFAULT_PRESET, MODELS, PRESETS, STEM_MODES, mergeSettings, withDefaults} from '/convex/lib/presets.ts';
import {EXPORT_COPY} from '/src/js/export.js';
import {SECTION_MODULES, mount, sectionPath} from '/src/settings/settings.js';

const DAY = 86_400_000;

const PHASES = {
  ready: {phase: 'ready'},
  busy: {phase: 'busy', job: {id: 'job-run', stage: 'separate', percent: 46}},
  starting: {phase: 'starting'},
  firstrun: {phase: 'starting', firstRun: true},
  pairing: {phase: 'pairing'},
  offline: {phase: 'offline'},
  'pair-failed': {phase: 'pair-failed', message: PROCESSOR_COPY.pairFailed},
};

function devicesFor(mode, now) {
  if (mode === 'none') return [];
  const dev1 = {deviceId: 'dev1', name: 'Studio MacBook', platform: 'darwin-arm64', appVersion: '2.0.0', lastSeenAt: now - 20e3, state: 'busy', currentJobId: 'job-run', queued: 2};
  const dev2 = {deviceId: 'dev2', name: 'DESKTOP-4F2K9', platform: 'win32-x64', appVersion: '1.9.0', lastSeenAt: now - 3 * DAY, state: 'offline', currentJobId: null, queued: 0};
  return mode === 'online' ? [{...dev1, state: 'idle', currentJobId: null, queued: 0}, {...dev2, state: 'idle', lastSeenAt: now - 30e3}] : [dev1, dev2];
}

const BASE_STATUS = {enabled: true, access: 'free', status: null, interval: null, periodEnd: null, cancelAtPeriodEnd: false, graceEndsAt: null,
  hasCustomer: false, cleanupPending: false, usedBytes: 412e6, limitBytes: 1e9, freeBytes: 1e9, proBytes: 25e9, monthlyCents: 200, annualCents: 2000};
function statusFor(mode, now) {
  switch (mode) {
    case 'plus': return {...BASE_STATUS, access: 'paid', status: 'active', interval: 'year', periodEnd: now + 200 * DAY, hasCustomer: true};
    case 'cancel': return {...BASE_STATUS, access: 'paid', status: 'active', interval: 'month', periodEnd: now + 12 * DAY, cancelAtPeriodEnd: true, hasCustomer: true};
    case 'grace': return {...BASE_STATUS, access: 'grace', status: 'canceled', graceEndsAt: now + 9 * DAY, hasCustomer: true};
    case 'pastdue': return {...BASE_STATUS, access: 'grace', status: 'past_due', interval: 'month', periodEnd: now + 3 * DAY, graceEndsAt: now + 14 * DAY, hasCustomer: true};
    case 'disabled': return {...BASE_STATUS, enabled: false};
    default: return {...BASE_STATUS};
  }
}

const SONGS = [
  ['harbor', 'Harbor Lights', 'Ada Moreno', 96], ['glasshouse', 'Glasshouse', 'Northbound', 88], ['velvet', 'Velvet Arc', 'Marisol Vega', 74],
  ['nightbus', 'Night Bus', 'The Tidewater Collective', 61], ['lowtide', 'Low Tide', 'Northbound', 52], ['quiet', 'Quiet Hours', 'Northbound', 30],
].map(([id, title, artist, mb]) => ({id, title, artist, stems: ['drums', 'bass', 'vocals', 'other'].map(name => ({name, key: `${id}/${name}`, bytes: mb * 1e6 / 4}))}));

export default async function mountHarness(el, {query, h}) {
  const now = Date.now();
  const patches = [];
  const calls = [];
  const record = (name, args) => calls.push({name, args: JSON.parse(JSON.stringify(args ?? null))});
  let failures = Number(query.get('fail')) || 0;
  let saved = {};
  try { saved = JSON.parse(query.get('settings') || '{}'); } catch { saved = {}; }

  // ---- the account (createAccount over an in-memory settings.patch)
  const config = signal({presets: PRESETS, models: MODELS, bitrates: BITRATES, stemModes: STEM_MODES, defaultPreset: DEFAULT_PRESET});
  const accountStore = {config, account: signal(withDefaults(saved)), pendingAccount: signal(null)};
  const account = createAccount({store: accountStore, toast: () => {}, api: {
    subscribeConfig: () => () => {},
    async patch(partial) {
      patches.push(JSON.parse(JSON.stringify(partial)));
      await new Promise(resolve => setTimeout(resolve, 60));
      if (failures > 0) {
        failures -= 1;
        throw new ApiError({code: 'network', message: 'Woodshed could not reach its server.'});
      }
      const merged = mergeSettings(withDefaults(accountStore.account.peek()), partial);
      accountStore.account.value = merged;
      return merged;
    },
  }});

  // ---- desktop, processor, devices
  const desktopApp = query.get('desktop') === '1';
  const processor = signal({name: 'Studio MacBook', deviceId: 'dev1', job: null, firstRun: false, ...(PHASES[query.get('phase')] ?? PHASES.ready)});
  const setPhase = phase => { processor.value = {name: 'Studio MacBook', deviceId: 'dev1', job: null, firstRun: false, ...(PHASES[phase] ?? PHASES.ready)}; };
  const desktop = desktopApp ? {
    available: true,
    processor,
    watchStatus() { record('watchStatus'); return () => record('unwatchStatus'); },
    async restartProcessor() {
      record('restartProcessor');
      setPhase('starting');
      await new Promise(resolve => setTimeout(resolve, 500));
      setPhase('ready');
      return {port: 47831};
    },
    async retryPairing() { record('retryPairing'); await new Promise(resolve => setTimeout(resolve, 300)); setPhase('ready'); },
    info: async () => ({version: '2.0.0'}),
    update: async () => ({status: 'current'}),
  } : {available: false};
  const devicesSlow = query.get('devicesLoad') === 'slow';
  const devices = signal(devicesSlow ? [] : devicesFor(query.get('devices') || 'mixed', now));
  const songs = signal(new Map(SONGS.map(s => [s.id, s])));
  const legacyMode = query.get('legacy') || 'one';
  const companionModule = {
    async legacyLibraries() {
      record('legacy');
      await new Promise(resolve => setTimeout(resolve, 250));
      if (legacyMode === 'none') return [];
      if (legacyMode === 'many') return [{directory: '~/Library/Application Support/woodshed', count: 48}, {directory: '~/Music/Woodshed (2023)', count: 9}];
      return [{directory: '~/Library/Application Support/woodshed', count: 48}];
    },
    async importLegacy(directory) {
      record('import', {directory});
      await new Promise(resolve => setTimeout(resolve, 400));
      if (query.get('importFail') === '1') throw Object.assign(new Error('Import queue full. Import more after these finish.'), {code: 'unknown'});
      if (query.get('importFail') === 'missing') throw Object.assign(new Error(`ENOENT: no such file or directory, open '${directory}/library.json'`), {code: 'unknown'});
      return {count: 20, skipped: 0, remaining: 28};
    },
    async desktopStatus() {
      record('desktopStatus');
      return {connected: true, deviceId: 'dev-local', busy: false};
    },
    async request(route, {method, body, timeoutMs} = {}) {
      record('local', {route, method, body, timeoutMs});
      await new Promise(resolve => setTimeout(resolve, 400));
      if (query.get('originals') === 'nojobs') throw Object.assign(new Error('ENOENT: no such file or directory, scandir \'/Users/kyle/Library/Application Support/Woodshed/accounts/u1/jobs\''), {code: 'unknown'});
      return {count: 48, directory: '~/Downloads/Woodshed-originals-2026-10-28'};
    },
  };
  const devicesApi = {
    subscribeList(onValue) {
      record('subscribeList');
      let off = null;
      const t = setTimeout(() => {
        const list = devicesSlow && !devices.peek().length ? devicesFor(query.get('devices') || 'mixed', now) : devices.peek();
        onValue(list);
        off = devices.subscribe(value => onValue(value));
        if (devicesSlow) devices.value = list;
      }, devicesSlow ? 800 : 0);
      return () => { clearTimeout(t); off?.(); };
    },
    async rename({deviceId, name}) {
      record('rename', {deviceId, name});
      const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
      if (!clean || clean.length > 80) throw new ApiError({code: 'invalid', message: 'Enter a name of 1–80 characters.', data: {field: 'name'}});
      devices.value = devices.peek().map(d => (d.deviceId === deviceId ? {...d, name: clean} : d));
      return null;
    },
    async revoke({deviceId}) {
      record('revoke', {deviceId});
      devices.value = devices.peek().filter(d => d.deviceId !== deviceId);
      return null;
    },
  };

  // ---- billing, storage, export, cache
  const statusMode = query.get('status') || 'free';
  let statusListener = null;
  let status = statusFor(statusMode, now);
  const billingApi = {
    subscribeStatus(onValue, onError) {
      record('subscribeStatus');
      statusListener = onValue;
      if (statusMode === 'error') setTimeout(() => onError?.(new ApiError({code: 'network', message: 'offline'})), 50);
      else if (statusMode !== 'loading') setTimeout(() => onValue({...status}), 50);
      return () => { record('closeStatus'); statusListener = null; };
    },
    async checkout(args) { record('checkout', args); await new Promise(resolve => setTimeout(resolve, 300)); throw new ApiError({message: 'Upgrades are not available yet.'}); },
    async portal() { record('portal'); await new Promise(resolve => setTimeout(resolve, 300)); throw new ApiError({message: 'No billing account yet.'}); },
  };
  const usageMode = query.get('usage') || 'normal';
  const usage = usageMode === 'over' ? {usedBytes: 1.12e9, limitBytes: 1e9, appFull: false}
    : usageMode === 'appfull' ? {usedBytes: 412e6, limitBytes: 1e9, appFull: true}
      : {usedBytes: status.usedBytes, limitBytes: status.limitBytes, appFull: false};
  const storageApi = {subscribeUsage(onValue) { record('subscribeUsage'); setTimeout(() => onValue({...usage}), 30); return () => record('closeUsage'); }};
  const exportMode = query.get('export') || 'done';
  const exporter = (onProgress, {signal: abort}) => new Promise((resolve, reject) => {
    record('export');
    abort?.addEventListener('abort', () => reject(new DOMException('The export was canceled.', 'AbortError')));
    onProgress(EXPORT_COPY.gathering, {phase: 'gather', done: 0, total: 0});
    if (exportMode === 'toolarge') { setTimeout(() => reject(new Error(EXPORT_COPY.tooLarge)), 200); return; }
    setTimeout(() => {
      onProgress(EXPORT_COPY.song(3, 8, 'Velvet Arc'), {phase: 'song', done: 2, total: 8, title: 'Velvet Arc'});
      if (exportMode === 'fail') setTimeout(() => reject(new Error(EXPORT_COPY.songFailed('Velvet Arc'))), 200);
      else if (exportMode === 'done') setTimeout(() => resolve({songs: 8, bytes: 9e7}), 400);
    }, 200);
  });
  const cacheMode = query.get('cache');
  let cacheBytes = cacheMode && cacheMode !== 'unsupported' ? Number(cacheMode) : 412e6;
  const cache = {
    supported: () => cacheMode !== 'unsupported',
    size: async () => cacheBytes,
    clear: async () => { record('clearCache'); await new Promise(resolve => setTimeout(resolve, 200)); cacheBytes = 0; return 3; },
  };
  const location = {assign: url => record('assign', {url})};

  // ---- the platform
  const {platform: appPlatform} = await import('/src/app/platform.js');
  const platform = {...appPlatform, isDesktopApp: desktopApp, isIPad: query.get('ipad') === '1' || appPlatform.isIPad};
  const win = query.get('picker') === '0'
    ? new Proxy(window, {get: (target, key) => (key === 'showSaveFilePicker' ? undefined : Reflect.get(target, key, target))})
    : window;
  const extra = {companion: async () => companionModule, devicesApi, billingApi, storageApi, exporter, cache, location, window: win, feedback};

  // The frame passes its own ctx; the two sections under test get the fakes beside it.
  const withFakes = path => async () => {
    const def = (await SECTION_MODULES[path]()).default;
    return {default: {...def, render: (target, ctx) => def.render(target, {...ctx, ...extra})}};
  };
  const sectionModules = {
    ...SECTION_MODULES,
    [sectionPath('processing')]: withFakes(sectionPath('processing')),
    [sectionPath('plan')]: withFakes(sectionPath('plan')),
  };

  const session = signal({user: {id: 'u1', name: 'Kyle Kincer', email: 'kyle@example.com', image: null}, admin: false, status: 'active', online: true});
  const appStore = {session, update: signal({status: 'idle'}), config, processor, library: {songs, devices, jobs: signal([]), uploads: signal([]), setlists: signal([]), loaded: signal(true)}};
  const registry = createRegistry();
  registry.registerMany([
    {id: 'app.shortcuts', title: 'Keyboard shortcuts', group: 'App', keys: ['?'], scopes: ['global'], icon: 'keyboard', run: () => {}},
    {id: 'app.signOut', title: 'Sign out', group: 'App', icon: 'log-out', run: () => {}},
    {id: 'nav.admin', title: 'Administration', group: 'App', when: () => false, run: () => {}},
  ]);
  const prefsValue = signal({jobStats: {balanced: {secPerMin: 32, n: 4}, studio: {secPerMin: 95, n: 2}}});
  const prefs = {value: prefsValue, get: path => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), prefsValue.value), set: () => {}};

  const outlet = h('div', {class: 'app-main', style: {height: '100%'}});
  const frame = h('div', {class: 'app-frame', dataset: {chrome: 'topbar'}, style: {height: '100%'}}, outlet);
  el.style.padding = '0';
  el.replaceChildren(frame);

  const section = query.get('section') || 'processing';
  const checkout = query.get('checkout');
  const current = signal({name: 'settingsPage', path: `/settings/${section}`, params: {section}, query: checkout ? {checkout} : {}, state: null});
  let view = null;
  const router = {
    current,
    async navigate(to) {
      record('navigate', {to});
      if (!String(to).startsWith('/settings')) return;   // a song link: recorded only
      const id = String(to).replace(/^\/settings\/?/, '').split('?')[0];
      current.value = id
        ? {name: 'settingsPage', path: `/settings/${id}`, params: {section: id}, query: {}, state: null}
        : {name: 'settings', path: '/settings', params: {}, query: {}, state: null};
      await view.update(current.peek());
    },
    back() { return router.navigate('/settings'); },
  };
  const ctx = {router, account, prefs, store: appStore, registry, platform, desktop, install: {state: signal({canPrompt: false, installed: false, steps: 'none'}), prompt: async () => 'dismissed'}, feedback, sectionModules};
  window.__settingsB = {
    patches, calls, view: null,
    settings: () => JSON.parse(JSON.stringify(accountStore.account.peek())),
    setPhase,
    setDevices: list => { devices.value = list; },
    pushStatus: change => { status = {...status, ...change}; statusListener?.({...status}); },
  };
  view = await mount(outlet, current.peek(), ctx);
  window.__settingsB.view = view;
  return view;
}
