// @vitest-environment happy-dom
// SE2: Settings → Processing and Settings → Plan & storage (architecture §2.17, §2.11, §6.5, §6.6,
// D40, D47, §9.12 SE2; spec §6.2, §6.3, §6.5): the controls as tables (desktop and web), the account
// rows saving on change with "Saved" / "Couldn't save · [Retry]", the processor status and restart, the
// old-library import and the original-audio export, the paired computers on the web (rename, remove)
// with the one desktop note; the usage meter and the 5 largest songs, the Free and Plus cards priced
// from monthlyCents/annualCents, notices, ?checkout=success, the billing subscription closed on
// unmount, the library export (picker inside the click, progress, cancel, the 100 MB note) and the
// playback cache.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {SECTION_MODULES, sectionPath} from '../src/settings/settings.js';
import {COPY as FRAME_COPY, SECTION_TITLES} from '../src/settings/settings.copy.js';
import processing, {
  COPY as PC, CONTROLS as PROCESSING_CONTROLS, ROWS as PROCESSING_ROWS, QUALITY_CHOICES,
  ORIGINALS_TIMEOUT_MS, companionErrorDetails, companionErrorText, importErrorText, isMissingPath, defaultLayout, deviceStatus, effectiveQuality, estimateText, importResultText, originalsText,
  platformName, qualityChoice, webProcessorText,
} from '../src/settings/sections/processing.js';
import plan, {
  COPY as LC, CONTROLS as PLAN_CONTROLS, ROWS as PLAN_ROWS, exportFailedText, formatBytes, formatPrice, initialInterval,
  currentPlan, largestSongs, paymentFailing, planNotices, planPrice, resetExport, runningExport, usageFraction, usageText,
} from '../src/settings/sections/plan.js';
import {createAccount} from '../src/app/account.js';
import {normalizePrefs} from '../src/app/prefs.js';
import {signal} from '../src/app/store.js';
import {ApiError} from '../src/api/client.js';
import {PROCESSOR_COPY} from '../src/app/desktop.js';
import {EXPORT_COPY} from '../src/js/export.js';
import {mergeSettings, withDefaults, PRESETS, MODELS, BITRATES, STEM_MODES, DEFAULT_PRESET} from '../convex/lib/presets.ts';

// ---------------------------------------------------------------------------------------------
// accessibility helpers (the rules of tests/settings-sections-a.test.js, plus labels for fields)

const collapse = s => s.replace(/\s+/g, ' ').trim();
const isHidden = el => !!el.closest('[hidden], [aria-hidden=true]');
const textOf = node => {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1 || node.hidden || node.getAttribute('aria-hidden') === 'true') return '';
  return ` ${[...node.childNodes].map(textOf).join('')} `;
};
function accName(el) {
  if (el.hasAttribute('aria-label')) return collapse(el.getAttribute('aria-label'));
  if (el.hasAttribute('aria-labelledby')) {
    return collapse(el.getAttribute('aria-labelledby').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' '));
  }
  if (el.id && el.matches('input, select, textarea')) {
    const label = el.ownerDocument.querySelector(`label[for="${el.id}"]`);
    if (label) return collapse(label.textContent);
  }
  return collapse(textOf(el));
}
const roleOf = el => el.getAttribute('role') ?? (el.matches('a[href]') ? 'link' : el.matches('button') ? 'button'
  : el.matches('select') ? 'combobox' : el.matches('input, textarea') ? 'textbox' : null);
const CONTROL_SELECTOR = 'a[href], button, input, select, textarea, [role=button], [role=radio], [role=checkbox], [role=link], [role=spinbutton], [role=switch], [role=radiogroup]';
const exposed = root => [...root.querySelectorAll(CONTROL_SELECTOR)].filter(el => !isHidden(el));
const describeAll = root => exposed(root).map(el => `${roleOf(el)}:${accName(el)}`);
function find(root, role, name, group = null) {
  const scope = group ? findGroup(root, group) : root;
  const found = exposed(scope).filter(el => roleOf(el) === role && accName(el) === name);
  if (found.length !== 1) throw new Error(`expected one ${role} "${name}", found ${found.length}: ${describeAll(scope).join(' | ')}`);
  return found[0];
}
const has = (root, role, name) => exposed(root).some(el => roleOf(el) === role && accName(el) === name);
function findGroup(root, name) {
  const found = [...root.querySelectorAll('[role=radiogroup]')].filter(el => !isHidden(el) && accName(el) === name);
  if (found.length !== 1) throw new Error(`expected one radiogroup "${name}", found ${found.length}`);
  return found[0];
}
const checkedIn = (root, group) => accName(findGroup(root, group).querySelector('[aria-checked=true]'));
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const rowEl = (root, key) => root.querySelector(`[data-row="${key}"]`);
const rowText = (root, key) => collapse(textOf(rowEl(root, key)));
const savedIn = row => row.querySelector('.settings-save[role=status]')?.textContent ?? '';
const failedIn = row => row.querySelector('.settings-save[role=alert]');
const choose = (select, value) => {
  const i = [...select.options].findIndex(o => o.textContent === value);
  if (i < 0) throw new Error(`no option ${value}`);
  select.value = String(i);
  select.dispatchEvent(new Event('change', {bubbles: true}));
};

// ---------------------------------------------------------------------------------------------
// fakes

function fakeAccount(settings = {}) {
  const store = {config: signal(null), account: signal(withDefaults(settings)), pendingAccount: signal(null)};
  const patches = [];
  let fail = 0;
  const api = {
    subscribeConfig: () => () => {},
    patch: vi.fn(async partial => {
      patches.push(JSON.parse(JSON.stringify(partial)));
      if (fail > 0) { fail -= 1; throw new ApiError({code: 'network', message: 'offline'}); }
      const merged = mergeSettings(withDefaults(store.account.peek()), partial);
      store.account.value = merged;
      return merged;
    }),
  };
  return {account: createAccount({store, api, toast: () => {}}), store, patches,
    stored: () => store.account.peek(),
    remote(change) { store.account.value = mergeSettings(withDefaults(store.account.peek()), change); },
    failNext(n = 1) { fail = n; }};
}

function fakePrefs(initial = {}) {
  const sig = signal(normalizePrefs(initial));
  return {value: sig, get: path => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), sig.value), set: vi.fn()};
}

function fakeDesktop(phase = 'ready', extra = {}) {
  const processor = signal({phase, name: 'Studio MacBook', deviceId: 'dev1', job: null, firstRun: false, ...extra});
  const unwatch = vi.fn();
  return {
    available: true, processor,
    watchStatus: vi.fn(() => unwatch), unwatch,
    restartProcessor: vi.fn(async () => ({port: 1})),
    retryPairing: vi.fn(async () => ({})),
    info: vi.fn(async () => ({version: '2.0.0'})),
  };
}

function fakeCompanion({libraries = [], importResult = {count: 20, skipped: 0, remaining: 28}, originals = {count: 48, directory: '~/Downloads/Woodshed-originals'}} = {}) {
  const mod = {
    legacyLibraries: vi.fn(async () => libraries),
    importLegacy: vi.fn(async () => importResult),
    desktopStatus: vi.fn(async () => ({connected: true, deviceId: 'dev-local'})),
    request: vi.fn(async () => originals),
  };
  return {mod, load: vi.fn(async () => mod)};
}

function fakeFeedback() {
  return {
    toast: vi.fn(),
    confirm: vi.fn(async () => true),
    form: vi.fn(async () => null),
  };
}

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const DEVICES = [
  {deviceId: 'dev1', name: 'Studio MacBook', platform: 'darwin-arm64', appVersion: '2.0.0', lastSeenAt: NOW - 20e3, state: 'busy', currentJobId: 'job-run', queued: 2},
  {deviceId: 'dev2', name: 'DESKTOP-4F2K9', platform: 'win32-x64', appVersion: '1.9.0', lastSeenAt: NOW - 3 * 86_400_000, state: 'offline', currentJobId: null, queued: 0},
];

const STATUS = Object.freeze({enabled: true, access: 'free', status: null, interval: null, periodEnd: null, cancelAtPeriodEnd: false,
  graceEndsAt: null, hasCustomer: false, cleanupPending: false, usedBytes: 412e6, limitBytes: 1e9, freeBytes: 1e9, proBytes: 25e9,
  monthlyCents: 200, annualCents: 2000});

function fakeBilling(status = STATUS) {
  let listener = null, onError = null;
  const off = vi.fn();
  return {
    subscribeStatus: vi.fn((cb, err) => { listener = cb; onError = err; if (status) queueMicrotask(() => cb({...status})); return off; }),
    checkout: vi.fn(async () => 'https://checkout.stripe.test/s/1'),
    portal: vi.fn(async () => 'https://billing.stripe.test/p/1'),
    push(value) { listener?.(value); },
    fail(err) { onError?.(err); },
    off,
  };
}
function fakeStorage(value = {usedBytes: 412e6, limitBytes: 1e9, appFull: false}) {
  let listener = null;
  const off = vi.fn();
  return {subscribeUsage: vi.fn(cb => { listener = cb; queueMicrotask(() => cb(value)); return off; }), push: v => listener?.(v), off};
}

function song(id, title, mb, extra = {}) {
  return {id, title, artist: `${title} Band`, stems: [{name: 'drums', key: `${id}/drums.webm`, bytes: mb * 1e6 / 2}, {name: 'bass', key: `${id}/bass.webm`, bytes: mb * 1e6 / 2}], ...extra};
}

let host;
const opened = [];
beforeEach(() => {
  host = document.createElement('div');
  document.body.replaceChildren(host);
});
afterEach(() => {
  for (const handle of opened.splice(0)) handle.destroy();
  resetExport();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** Renders a section the way the frame does (heading + body), with the given ctx. */
function open(def, ctx) {
  const heading = document.createElement('h2');
  heading.id = 'settings-heading-test';
  heading.textContent = def.title;
  const body = document.createElement('div');
  host.replaceChildren(heading, body);
  const handle = def.render(body, {layout: 'split', headingId: heading.id, window, ...ctx});
  opened.push(handle);
  return {body, handle};
}

function processingEnv({context = 'desktop', settings = {}, phase = 'ready', processorExtra = {}, prefs = {}, companion = fakeCompanion(), devices = DEVICES} = {}) {
  const acct = fakeAccount(settings);
  const desktop = context === 'desktop' ? fakeDesktop(phase, processorExtra) : {available: false};
  const store = {
    config: signal({presets: PRESETS, models: MODELS, bitrates: BITRATES, stemModes: STEM_MODES, defaultPreset: DEFAULT_PRESET}),
    processor: desktop.processor ?? signal({phase: 'web'}),
    library: {devices: signal(devices), songs: signal(new Map())},
  };
  const feedback = fakeFeedback();
  const devicesApi = {rename: vi.fn(async () => null), revoke: vi.fn(async () => null)};
  let clock = NOW;
  const ctx = {
    account: acct.account, prefs: fakePrefs(prefs), store, desktop, feedback, devicesApi,
    platform: {isDesktopApp: context === 'desktop', isIPad: false, features: {}},
    companion: companion.load, now: () => clock,
  };
  return {ctx, acct, desktop, store, feedback, devicesApi, companion, advance(ms) { clock += ms; }};
}

function planEnv({status = STATUS, usage, songs = [], platform = {isIPad: false}, picker = true, query = {}, cache} = {}) {
  const billing = fakeBilling(status);
  const storage = fakeStorage(usage);
  const feedback = fakeFeedback();
  const exporter = vi.fn(async onProgress => {
    onProgress(EXPORT_COPY.gathering, {phase: 'gather', done: 0, total: 0});
    onProgress(EXPORT_COPY.song(1, 2, 'A'), {phase: 'song', done: 0, total: 2, title: 'A'});
    onProgress(EXPORT_COPY.done(2), {phase: 'done', done: 2, total: 2});
    return {songs: 2, bytes: 100};
  });
  const cacheApi = cache ?? {supported: () => true, size: vi.fn(async () => 412e6), clear: vi.fn(async () => 7)};
  const location = {assign: vi.fn()};
  const router = {navigate: vi.fn(), current: signal({name: 'settingsPage', path: '/settings/plan', params: {section: 'plan'}, query})};
  const win = picker ? Object.assign(Object.create(window), {showSaveFilePicker: vi.fn()}) : Object.assign(Object.create(window), {showSaveFilePicker: undefined});
  const store = {library: {songs: signal(new Map(songs.map(s => [s.id, s]))), devices: signal([])}, session: signal({status: 'active'})};
  const ctx = {store, platform, router, feedback, billingApi: billing, storageApi: storage, exporter, cache: cacheApi, location,
    formatDate: ms => new Date(ms).toISOString().slice(0, 10), window: win};
  return {ctx, billing, storage, feedback, exporter, cache: cacheApi, location, router, store};
}

// ---------------------------------------------------------------------------------------------

describe('section modules', () => {
  test.each([['processing', processing], ['plan', plan]])('%s default-exports {id, title, render} and the frame finds it', async (id, def) => {
    expect(def).toMatchObject({id, title: SECTION_TITLES[id]});
    expect(def.render).toBeTypeOf('function');
    expect((await SECTION_MODULES[sectionPath(id)]()).default).toBe(def);
    expect(def.desktopOnly).toBeUndefined();   // shown on the web too (processor status + devices; the plan)
  });
});

describe('Processing: spec §6.2 controls as a table (role + accessible name; nothing else)', () => {
  const expectedFor = contexts => PROCESSING_CONTROLS.filter(c => contexts.includes(c.context));

  test('desktop, processor ready', async () => {
    const e = processingEnv();
    const {body} = open(processing, e.ctx);
    await flush();
    const rows = expectedFor(['desktop']);
    for (const row of rows) expect(find(body, row.role, row.name, row.group ?? null)).toBeTruthy();
    expect(describeAll(body)).toHaveLength(rows.length);
  });

  test('desktop, pairing failed: Try again joins Restart processor', async () => {
    const e = processingEnv({phase: 'pair-failed', processorExtra: {message: PROCESSOR_COPY.pairFailed}});
    const {body} = open(processing, e.ctx);
    const rows = expectedFor(['desktop', 'pairFailed']);
    for (const row of rows) expect(find(body, row.role, row.name, row.group ?? null)).toBeTruthy();
    expect(describeAll(body)).toHaveLength(rows.length);
  });

  test('desktop, after a scan that found no old library: the folder field', async () => {
    const e = processingEnv({companion: fakeCompanion({libraries: []})});
    const {body} = open(processing, e.ctx);
    find(body, 'button', PC.importLegacy.find).click();
    await flush();
    const rows = expectedFor(['desktop', 'legacyNone']);
    for (const row of rows) expect(find(body, row.role, row.name, row.group ?? null)).toBeTruthy();
    expect(describeAll(body)).toHaveLength(rows.length);
  });

  test('web: the desktop note and each computer’s Rename and Remove; no desktop-only control', () => {
    const e = processingEnv({context: 'web'});
    const {body} = open(processing, e.ctx);
    const rows = expectedFor(['web']);
    for (const row of rows) expect(find(body, row.role, row.name)).toBeTruthy();
    for (const d of DEVICES) {
      find(body, 'button', PC.devices.renameName(d.name));
      find(body, 'button', PC.devices.removeName(d.name));
    }
    expect(describeAll(body)).toHaveLength(rows.length + DEVICES.length * 2);
    for (const row of expectedFor(['desktop'])) expect(has(body, row.role, row.name)).toBe(false);
  });

  test.each([
    ['desktop', ['desktop']],
    ['web', ['web']],
  ])('%s rows carry their scope (D40: processing settings are the account’s)', (context, contexts) => {
    const e = processingEnv({context});
    const {body} = open(processing, e.ctx);
    const rows = PROCESSING_ROWS.filter(r => contexts.includes(r.context));
    const shown = [...body.querySelectorAll('.settings-row[data-row]')].map(el => el.dataset.row);
    expect(shown).toEqual(rows.map(r => r.row));
    for (const r of rows) {
      const el = rowEl(body, r.row);
      expect(el.dataset.scope).toBe(r.scope);
      expect(el.querySelector('.settings-scope')).toBeNull();   // nothing here is kept per device
      if (r.label) expect(collapse(textOf(el))).toContain(r.label);
    }
  });
});

describe('Processing on the desktop', () => {
  test('the processor status follows desktop.processor; /status is polled while the section is open', async () => {
    const e = processingEnv();
    const {body, handle} = open(processing, e.ctx);
    const line = () => collapse(body.querySelector('.settings-processor').textContent);
    expect(line()).toBe(PROCESSOR_COPY.ready);
    expect(rowText(body, 'processor')).toContain(PC.processor.thisComputer('Studio MacBook'));
    expect(e.desktop.watchStatus).toHaveBeenCalledTimes(1);
    e.desktop.processor.value = {phase: 'busy', name: 'Studio MacBook', job: {id: 'j', stage: 'separate', percent: 46}, firstRun: false};
    expect(line()).toBe('Splitting 1 · 46%');
    e.desktop.processor.value = {phase: 'starting', firstRun: true, job: null};
    expect(line()).toBe(PROCESSOR_COPY.firstRun);
    e.desktop.processor.value = {phase: 'offline', job: null};
    expect(line()).toBe(PROCESSOR_COPY.offline);
    expect(body.querySelector('.settings-processor').dataset.state).toBe('off');
    expect(find(body, 'button', PC.processor.restart).dataset.variant).toBe('primary');
    expect(has(body, 'button', PC.processor.tryAgain)).toBe(false);
    e.desktop.processor.value = {phase: 'pair-failed', message: PROCESSOR_COPY.pairFailed, job: null};
    expect(line()).toBe(PROCESSOR_COPY.pairFailed);
    find(body, 'button', PC.processor.tryAgain).click();
    expect(e.desktop.retryPairing).toHaveBeenCalledTimes(1);
    handle.destroy();
    opened.length = 0;
    expect(e.desktop.unwatch).toHaveBeenCalledTimes(1);
  });

  test('Restart processor restarts it, busy meanwhile; a failure says so', async () => {
    const e = processingEnv({phase: 'offline'});
    const {body} = open(processing, e.ctx);
    let release;
    e.desktop.restartProcessor.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const button = find(body, 'button', PC.processor.restart);
    button.click();
    expect(e.desktop.restartProcessor).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(collapse(button.textContent)).toContain(PC.processor.restarting);
    release({});
    await flush();
    expect(button.getAttribute('aria-busy')).toBeNull();
    e.desktop.restartProcessor.mockRejectedValueOnce(new Error('spawn failed'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    button.click();
    await flush();
    expect(rowText(body, 'processor')).toContain(PC.processor.restartFailed);
  });

  test('Default stems: the Add default (profile.js addDefaults); a choice is written with addDefaultsSaved', async () => {
    const e = processingEnv({settings: {profile: {instruments: ['guitar'], primary: 'guitar', openWithMyPart: 'in'}}});
    const {body} = open(processing, e.ctx);
    expect(checkedIn(body, PC.stems.label)).toBe(PC.stems.six);   // guitar → six (no saved choice)
    expect(rowEl(body, 'stemMode').querySelector('.settings-warning').hidden).toBe(true);
    find(body, 'radio', PC.stems.full, PC.stems.label).click();
    await flush();
    expect(e.acct.patches.at(-1)).toEqual({stemMode: 'full', addDefaultsSaved: true});
    expect(checkedIn(body, PC.stems.label)).toBe(PC.stems.full);
    expect(savedIn(rowEl(body, 'stemMode'))).toBe(FRAME_COPY.saved);
    // Full band takes the guitar out of its own track: the row says so (spec §3.2).
    const warning = rowEl(body, 'stemMode').querySelector('.settings-warning');
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toBe('Your guitar won’t be a separate track with this layout.');
    // A stored two-part split is never shown as the default (it is not one).
    e.acct.remote({stemMode: 'drums', addDefaultsSaved: true});
    expect(checkedIn(body, PC.stems.label)).toBe(PC.stems.six);
  });

  test('Quality: one segmented control; a preset writes preset; Custom keeps the current mix and opens Advanced', async () => {
    const e = processingEnv({prefs: {jobStats: {studio: {secPerMin: 45, n: 3}}}});
    const {body} = open(processing, e.ctx);
    expect(checkedIn(body, PC.quality.label)).toBe(PC.quality.balanced);
    const hint = () => rowEl(body, 'quality').querySelector('.settings-row-hint').textContent;
    expect(hint()).toBe(PRESETS.balanced.description);
    const details = body.querySelector('details.settings-advanced');
    expect(details.open).toBe(false);
    find(body, 'radio', PC.quality.studio, PC.quality.label).click();
    await flush();
    expect(e.acct.patches.at(-1)).toEqual({preset: 'studio'});
    expect(hint()).toBe(`${PRESETS.studio.description} ${PC.quality.estimate(3)}`);
    find(body, 'radio', PC.quality.custom, PC.quality.label).click();
    await flush();
    expect(e.acct.patches.at(-1)).toEqual({preset: 'custom', custom: {model: 'htdemucs_ft', shifts: 10, overlap: 0.5}});
    expect(details.open).toBe(true);
    expect(hint()).toBe(PC.quality.customHint);
    // QUALITY_CHOICES is the whole control: no slider.
    expect(body.querySelectorAll('[role=slider], input[type=range]')).toHaveLength(0);
    expect(QUALITY_CHOICES).toEqual(['fast', 'balanced', 'studio', 'custom']);
  });

  test('Advanced: model, passes and overlap make the quality Custom from the effective values', async () => {
    const e = processingEnv({settings: {preset: 'fast'}});
    const {body} = open(processing, e.ctx);
    const passes = find(body, 'spinbutton', PC.advanced.passes);
    expect(passes.getAttribute('aria-valuenow')).toBe('0');
    find(body, 'button', PC.advanced.morePasses).click();
    await flush();
    expect(e.acct.patches.at(-1)).toEqual({preset: 'custom', custom: {model: 'htdemucs', shifts: 1, overlap: 0.25}});
    expect(checkedIn(body, PC.quality.label)).toBe(PC.quality.custom);
    find(body, 'button', PC.advanced.moreOverlap).click();
    await flush();
    expect(e.acct.patches.at(-1).custom).toEqual({model: 'htdemucs', shifts: 1, overlap: 0.3});
    expect(find(body, 'spinbutton', PC.advanced.overlap).getAttribute('aria-valuetext')).toBe('0.30');
    choose(find(body, 'combobox', PC.advanced.model), 'With piano & guitar');
    await flush();
    expect(e.acct.patches.at(-1)).toEqual({preset: 'custom', custom: {model: 'htdemucs_6s', shifts: 1, overlap: 0.3}});
    expect(savedIn(rowEl(body, 'advanced'))).toBe(FRAME_COPY.saved);
  });

  test('a six-stem default with a non-6-stem custom model says which model it uses', () => {
    const e = processingEnv({settings: {stemMode: 'six', preset: 'custom', custom: {model: 'htdemucs', shifts: 1, overlap: 0.25}}});
    const {body} = open(processing, e.ctx);
    expect(collapse(textOf(body.querySelector('details.settings-advanced')))).toContain(PC.advanced.sixNote);
  });

  test('Audio bitrate and the three switches write their account keys', async () => {
    const e = processingEnv();
    const {body} = open(processing, e.ctx);
    const bitrate = find(body, 'combobox', PC.bitrate.label);
    expect(bitrate.options[bitrate.selectedIndex].textContent).toBe(BITRATES.find(b => b.id === 192).label);
    choose(bitrate, BITRATES.find(b => b.id === 256).label);
    await flush();
    expect(e.acct.patches.at(-1)).toEqual({bitrate: 256});
    for (const [key, label] of [['notifyReady', PC.notify.label], ['autoBeats', PC.autoBeats.label], ['autoSections', PC.autoSections.label]]) {
      const toggle = find(body, 'button', label);
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      toggle.click();
      await flush();
      expect(e.acct.patches.at(-1)).toEqual({[key]: false});
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(savedIn(rowEl(body, key))).toBe(FRAME_COPY.saved);
    }
  });

  test('controls follow a change made elsewhere (another device, a revert)', () => {
    const e = processingEnv();
    const {body} = open(processing, e.ctx);
    e.acct.remote({preset: 'fast', autoSections: false, bitrate: 128, stemMode: 'six'});
    expect(checkedIn(body, PC.quality.label)).toBe(PC.quality.fast);
    expect(find(body, 'button', PC.autoSections.label).getAttribute('aria-pressed')).toBe('false');
    const bitrate = find(body, 'combobox', PC.bitrate.label);
    expect(bitrate.options[bitrate.selectedIndex].textContent).toBe(BITRATES[0].label);
    expect(checkedIn(body, PC.stems.label)).toBe(PC.stems.six);
  });

  test('a failed save reverts the control and offers Retry, which saves it', async () => {
    const e = processingEnv();
    const {body} = open(processing, e.ctx);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    e.acct.failNext();
    find(body, 'button', PC.autoBeats.label).click();
    await flush();
    const row = rowEl(body, 'autoBeats');
    const alert = failedIn(row);
    expect(alert.hidden).toBe(false);
    expect(collapse(alert.textContent.replace('·', ' · '))).toBe('Couldn’t save · Retry');
    expect(find(body, 'button', PC.autoBeats.label).getAttribute('aria-pressed')).toBe('true');   // reverted
    alert.querySelector('button').click();
    await flush();
    expect(e.acct.patches).toEqual([{autoBeats: false}, {autoBeats: false}]);
    expect(savedIn(row)).toBe(FRAME_COPY.saved);
    expect(e.acct.stored().autoBeats).toBe(false);
  });

  test('Import an old library: the scan finds one; Import queues it and says what happened', async () => {
    const companion = fakeCompanion({libraries: [{directory: '~/Library/Application Support/woodshed', count: 48}]});
    const e = processingEnv({companion});
    const {body} = open(processing, e.ctx);
    find(body, 'button', PC.importLegacy.find).click();
    await flush();
    expect(companion.mod.legacyLibraries).toHaveBeenCalledTimes(1);
    expect(rowText(body, 'importLegacy')).toContain(PC.importLegacy.found(48, '~/Library/Application Support/woodshed'));
    find(body, 'button', PC.importLegacy.importFound(48)).click();
    await flush();
    expect(companion.mod.importLegacy).toHaveBeenCalledWith('~/Library/Application Support/woodshed');
    expect(rowText(body, 'importLegacy')).toContain(importResultText({count: 20, skipped: 0, remaining: 28}));
    expect(rowEl(body, 'importLegacy').querySelector('[role=status]').textContent).toContain('Added 20 songs to Jobs.');
  });

  test('Import an old library: several libraries are named apart; a typed folder imports; failures read as sentences', async () => {
    const companion = fakeCompanion({libraries: [{directory: '/a', count: 3}, {directory: '/b', count: 1}]});
    const e = processingEnv({companion});
    const {body} = open(processing, e.ctx);
    find(body, 'button', PC.importLegacy.find).click();
    await flush();
    find(body, 'button', PC.importLegacy.importFoundIn(3, '/a'));
    find(body, 'button', PC.importLegacy.importFoundIn(1, '/b')).click();
    await flush();
    expect(companion.mod.importLegacy).toHaveBeenLastCalledWith('/b');

    companion.mod.legacyLibraries.mockResolvedValueOnce([]);
    find(body, 'button', PC.importLegacy.find).click();
    await flush();
    expect(rowText(body, 'importLegacy')).toContain(PC.importLegacy.none);
    const folder = find(body, 'textbox', PC.importLegacy.folder);
    folder.value = '  /Users/kyle/old-woodshed ';
    companion.mod.importLegacy.mockRejectedValueOnce(Object.assign(new Error('Import queue full. Import more after these finish.'), {code: 'unknown'}));
    find(body, 'button', PC.importLegacy.importFolder).click();
    await flush();
    expect(companion.mod.importLegacy).toHaveBeenLastCalledWith('/Users/kyle/old-woodshed');
    const alert = rowEl(body, 'importLegacy').querySelector('[role=alert]');
    // An uncoded processor failure: the row's own sentence; the processor's words behind Details.
    expect(collapse(alert.textContent)).toBe(PC.importLegacy.failed);
    const details = rowEl(body, 'importLegacy').querySelector('details.settings-error-details');
    expect(details.hidden).toBe(false);
    expect(details.open).toBe(false);
    expect(details.querySelector('summary').textContent).toBe(PC.details);
    expect(details.querySelector('pre').textContent).toBe('Import queue full. Import more after these finish.');

    // A mistyped folder: ENOENT on library.json reads as a plain sentence, nothing behind Details.
    companion.mod.importLegacy.mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file or directory, open '/Users/kyle/old-woodshd/library.json'"), {code: 'unknown'}));
    find(body, 'button', PC.importLegacy.importFolder).click();
    await flush();
    expect(collapse(rowEl(body, 'importLegacy').querySelector('[role=alert]').textContent)).toBe(PC.importLegacy.notFound);
    expect(rowText(body, 'importLegacy')).not.toContain('ENOENT');
    expect(details.hidden).toBe(true);
    companion.mod.importLegacy.mockRejectedValueOnce(Object.assign(new Error('Unrecognized library.json.'), {code: 'unknown'}));
    find(body, 'button', PC.importLegacy.importFolder).click();
    await flush();
    expect(collapse(rowEl(body, 'importLegacy').querySelector('[role=alert]').textContent)).toBe(PC.importLegacy.unrecognized);
  });

  test('Export original audio asks the processor and reports where the files went', async () => {
    const companion = fakeCompanion();
    const e = processingEnv({companion});
    const {body} = open(processing, e.ctx);
    find(body, 'button', PC.exportOriginals.button).click();
    await flush();
    // Pairing first (as localRequest checks it), then a bound long enough for copying gigabytes.
    expect(companion.mod.desktopStatus).toHaveBeenCalledTimes(1);
    expect(companion.mod.request).toHaveBeenCalledWith('/export-originals', {method: 'POST', body: {}, timeoutMs: ORIGINALS_TIMEOUT_MS});
    expect(ORIGINALS_TIMEOUT_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(rowText(body, 'exportOriginals')).toContain(PC.exportOriginals.done(48, '~/Downloads/Woodshed-originals'));
    companion.mod.desktopStatus.mockRejectedValueOnce(Object.assign(new Error('x'), {code: 'processor_offline'}));
    find(body, 'button', PC.exportOriginals.button).click();
    await flush();
    expect(collapse(rowEl(body, 'exportOriginals').querySelector('[role=alert]').textContent)).toMatch(/^The original audio couldn’t be exported\. Woodshed’s processor isn’t running on this computer\./);
    expect(companion.mod.request).toHaveBeenCalledTimes(1);
    expect(rowEl(body, 'exportOriginals').querySelector('details.settings-error-details').hidden).toBe(true);
  });

  test('Export original audio on a computer that has never split a song (no jobs folder) says there is none', async () => {
    const companion = fakeCompanion();
    const e = processingEnv({companion});
    const {body} = open(processing, e.ctx);
    companion.mod.request.mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file or directory, scandir '/Users/kyle/Library/Application Support/Woodshed/accounts/u1/jobs'"), {code: 'unknown'}));
    find(body, 'button', PC.exportOriginals.button).click();
    await flush();
    expect(rowText(body, 'exportOriginals')).toContain(PC.exportOriginals.empty);
    expect(rowText(body, 'exportOriginals')).not.toMatch(/ENOENT|couldn’t be exported/);
    // Any other uncoded failure: one sentence, the raw words behind Details.
    companion.mod.request.mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied, mkdir \'/Users/kyle/Downloads/x\''), {code: 'unknown'}));
    find(body, 'button', PC.exportOriginals.button).click();
    await flush();
    expect(collapse(rowEl(body, 'exportOriginals').querySelector('[role=alert]').textContent)).toBe(PC.exportOriginals.failed);
    expect(rowEl(body, 'exportOriginals').querySelector('details.settings-error-details pre').textContent).toMatch(/^EACCES/);
  });
});

describe('Processing on the web (B5)', () => {
  test('the processor line, each paired computer and the one desktop note (spec §6.2 copy exactly)', () => {
    const e = processingEnv({context: 'web'});
    const {body} = open(processing, e.ctx);
    expect(rowText(body, 'processor')).toBe(`${PC.web.label} ${PC.web.busy('Studio MacBook')}`);
    const items = [...body.querySelectorAll('.settings-device')];
    expect(items.map(li => li.dataset.state)).toEqual(['busy', 'offline']);
    expect(collapse(textOf(items[0]))).toContain('Studio MacBook Online · splitting a song Mac · Woodshed 2.0.0 2 songs waiting');
    expect(collapse(textOf(items[1]))).toContain('DESKTOP-4F2K9 Offline · last seen 3 days ago Windows · Woodshed 1.9.0');
    const note = body.querySelector('.settings-desktop-note');
    expect(collapse(note.textContent)).toBe('These need Woodshed for desktop: Import an old library, Export original audio, Processing. Get it ↗');
    expect(note.querySelector('a').getAttribute('href')).toBe('/download');
    // Desktop-only rows are never shown disabled: they are not there at all.
    for (const row of ['stemMode', 'quality', 'advanced', 'bitrate', 'importLegacy', 'exportOriginals']) expect(rowEl(body, row)).toBeNull();
  });

  test('online is re-evaluated every 30 s with the clock (D11)', () => {
    vi.useFakeTimers();
    const e = processingEnv({context: 'web', devices: [{...DEVICES[0], state: 'idle', lastSeenAt: NOW - 140e3}]});
    const {body} = open(processing, e.ctx);
    expect(rowText(body, 'processor')).toContain(PC.web.online('Studio MacBook'));
    e.advance(30e3);
    vi.advanceTimersByTime(30e3);
    expect(rowText(body, 'processor')).toContain(PC.web.offline('Studio MacBook'));
    expect(body.querySelector('.settings-device').dataset.state).toBe('offline');
  });

  test('before devices.list answers: "Checking your computers…", never "no computer" (the store starts empty)', () => {
    const e = processingEnv({context: 'web', devices: []});
    let answer = null, off = vi.fn();
    e.ctx.devicesApi.subscribeList = vi.fn(onValue => { answer = onValue; return off; });
    const {body, handle} = open(processing, e.ctx);
    expect(e.ctx.devicesApi.subscribeList).toHaveBeenCalledTimes(1);
    expect(rowText(body, 'processor')).toContain(PC.web.loading);
    expect(rowText(body, 'processor')).not.toContain(PC.web.none);
    expect(rowEl(body, 'devices').hidden).toBe(true);
    answer(DEVICES);
    expect(rowText(body, 'processor')).toContain(PC.web.busy('Studio MacBook'));
    expect(body.querySelectorAll('.settings-device')).toHaveLength(2);
    answer([]);
    expect(rowText(body, 'processor')).toContain(PC.web.none);
    handle.destroy();
    expect(off).toHaveBeenCalledTimes(1);

    // The store already has the list: no extra subscription, no loading line.
    const ready = processingEnv({context: 'web'});
    ready.ctx.devicesApi.subscribeList = vi.fn(() => () => {});
    const shown = open(processing, ready.ctx).body;
    expect(ready.ctx.devicesApi.subscribeList).not.toHaveBeenCalled();
    expect(rowText(shown, 'processor')).not.toContain(PC.web.loading);

    // The store's first answer also ends the loading line; a failed subscription falls back to the store.
    const late = processingEnv({context: 'web', devices: []});
    let fail = null;
    late.ctx.devicesApi.subscribeList = vi.fn((onValue, onError) => { fail = onError; return () => {}; });
    const lateBody = open(processing, late.ctx).body;
    expect(rowText(lateBody, 'processor')).toContain(PC.web.loading);
    late.store.library.devices.value = [DEVICES[1]];
    expect(rowText(lateBody, 'processor')).toContain(PC.web.offline('DESKTOP-4F2K9'));
    const failing = processingEnv({context: 'web', devices: []});
    failing.ctx.devicesApi.subscribeList = vi.fn((onValue, onError) => { fail = onError; return () => {}; });
    const failBody = open(processing, failing.ctx).body;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fail(new ApiError({code: 'network'}));
    expect(rowText(failBody, 'processor')).toContain(PC.web.none);
  });

  test('no paired computer: the line says how songs get split, and the list is not shown', () => {
    const e = processingEnv({context: 'web', devices: []});
    const {body} = open(processing, e.ctx);
    expect(rowText(body, 'processor')).toContain(PC.web.none);
    expect(rowEl(body, 'devices').hidden).toBe(true);
  });

  test('Rename opens a form; the name reaches devices.rename; an invalid name shows at the field', async () => {
    const e = processingEnv({context: 'web'});
    const {body} = open(processing, e.ctx);
    find(body, 'button', PC.devices.renameName('Studio MacBook')).click();
    await flush();
    const form = e.feedback.form.mock.calls[0][0];
    expect(form.title).toBe(PC.devices.renameName('Studio MacBook'));
    expect(form.fields).toEqual([expect.objectContaining({name: 'name', label: PC.devices.nameField, required: true, maxLength: 80, value: 'Studio MacBook'})]);
    await form.onSubmit({name: 'Kit room iMac'});
    expect(e.devicesApi.rename).toHaveBeenCalledWith({deviceId: 'dev1', name: 'Kit room iMac'});
    e.devicesApi.rename.mockRejectedValueOnce(new ApiError({code: 'invalid', message: 'Enter a name of 1–80 characters.', data: {field: 'name'}}));
    await expect(form.onSubmit({name: ' '})).rejects.toMatchObject({field: 'name', message: 'Enter a name of 1–80 characters.'});
    e.devicesApi.rename.mockRejectedValueOnce(new ApiError({code: 'network'}));
    await expect(form.onSubmit({name: 'x'})).rejects.toMatchObject({message: PC.devices.failed});
    // A rename that lands updates the row in place (the list is keyed).
    const item = body.querySelector('.settings-device');
    e.store.library.devices.value = [{...DEVICES[0], name: 'Kit room iMac'}, DEVICES[1]];
    expect(body.querySelector('.settings-device')).toBe(item);
    find(body, 'button', PC.devices.renameName('Kit room iMac'));
  });

  test('Remove asks first, then revokes and says so; Cancel does nothing; a failure is shown', async () => {
    const e = processingEnv({context: 'web'});
    const {body} = open(processing, e.ctx);
    e.feedback.confirm.mockResolvedValueOnce(false);
    find(body, 'button', PC.devices.removeName('DESKTOP-4F2K9')).click();
    await flush();
    expect(e.feedback.confirm).toHaveBeenCalledWith({title: PC.devices.removeTitle('DESKTOP-4F2K9'), body: PC.devices.removeBody, confirmLabel: PC.devices.removeConfirm, danger: true});
    expect(e.devicesApi.revoke).not.toHaveBeenCalled();
    find(body, 'button', PC.devices.removeName('DESKTOP-4F2K9')).click();
    await flush();
    expect(e.devicesApi.revoke).toHaveBeenCalledWith({deviceId: 'dev2'});
    expect(e.feedback.toast).toHaveBeenCalledWith(PC.devices.removed('DESKTOP-4F2K9'), {tone: 'ok', key: 'device-removed'});
    expect(document.activeElement).toBe(body.querySelector('.settings-devices'));
    e.store.library.devices.value = [DEVICES[0]];
    expect(body.querySelectorAll('.settings-device')).toHaveLength(1);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    e.devicesApi.revoke.mockRejectedValueOnce(new ApiError({code: 'network'}));
    find(body, 'button', PC.devices.removeName('Studio MacBook')).click();
    await flush();
    expect(rowText(body, 'devices')).toContain(PC.devices.failed);
  });
});

describe('Processing helpers', () => {
  test('qualityChoice and effectiveQuality', () => {
    expect(qualityChoice({preset: 'fast'})).toBe('fast');
    expect(qualityChoice({preset: 'custom'})).toBe('custom');
    expect(qualityChoice({preset: 'nonsense'})).toBe('balanced');
    expect(effectiveQuality({preset: 'studio'})).toEqual({model: 'htdemucs_ft', shifts: 10, overlap: 0.5});
    expect(effectiveQuality({preset: 'custom', custom: {model: 'mdx_extra', shifts: 3, overlap: 0.4}})).toEqual({model: 'mdx_extra', shifts: 3, overlap: 0.4});
    expect(effectiveQuality({preset: 'custom', custom: {}})).toEqual({model: 'htdemucs_ft', shifts: 2, overlap: 0.25});
  });

  test('defaultLayout never answers a two-part split', () => {
    expect(defaultLayout({instruments: ['drums']}, {})).toBe('full');
    expect(defaultLayout({instruments: ['keys']}, {})).toBe('six');
    expect(defaultLayout({instruments: ['keys']}, {stemMode: 'full', addDefaultsSaved: true})).toBe('full');
    expect(defaultLayout({instruments: []}, {stemMode: 'bass', addDefaultsSaved: true})).toBe('full');
  });

  test.each([
    [{balanced: {secPerMin: 30, n: 2}}, 'balanced', PC.quality.estimate(2)],
    [{balanced: {secPerMin: 10, n: 1}}, 'balanced', PC.quality.estimate(1)],
    [{fast: {secPerMin: 5, n: 1}}, 'fast', 'Under a minute for a 4-minute song on this computer.'],
    [{balanced: {secPerMin: 30, n: 0}}, 'balanced', ''],
    [{}, 'studio', ''],
    [null, 'studio', ''],
  ])('estimateText(%j, %s)', (stats, preset, text) => {
    expect(estimateText(stats, preset)).toBe(text);
  });

  test('platformName, deviceStatus and webProcessorText', () => {
    expect([platformName('darwin-arm64'), platformName('win32-x64'), platformName('linux-x64'), platformName(null)]).toEqual(['Mac', 'Windows', 'Linux', '']);
    expect(deviceStatus({lastSeenAt: null}, NOW)).toEqual({state: 'never', text: PC.devices.never});
    expect(deviceStatus({lastSeenAt: NOW - 1000, state: 'idle'}, NOW)).toEqual({state: 'online', text: PC.devices.online});
    expect(deviceStatus({lastSeenAt: NOW - 1000, state: 'busy'}, NOW)).toEqual({state: 'busy', text: PC.devices.busy});
    expect(deviceStatus({lastSeenAt: NOW - 1000, state: 'offline'}, NOW).state).toBe('offline');
    expect(deviceStatus({lastSeenAt: NOW - 151e3, state: 'idle'}, NOW).text).toBe('Offline · last seen 2 min ago');
    expect(webProcessorText([], NOW)).toEqual({state: 'none', text: PC.web.none});
    expect(webProcessorText([DEVICES[1]], NOW)).toEqual({state: 'offline', text: PC.web.offline('DESKTOP-4F2K9')});
    const idle = {...DEVICES[1], deviceId: 'dev3', name: 'Laptop', state: 'idle', lastSeenAt: NOW - 5e3};
    expect(webProcessorText([DEVICES[0], idle], NOW)).toEqual({state: 'online', text: PC.web.online('Laptop')});
  });

  test('importResultText, originalsText and companionErrorText', () => {
    expect(importResultText({count: 20, skipped: 3, remaining: 25})).toBe('Added 20 songs to Jobs. Your old files are kept. 3 were already in your library. When they finish, import again for the other 25.');
    expect(importResultText({count: 1, skipped: 0, remaining: 0})).toBe('Added 1 song to Jobs. Your old files are kept.');
    expect(importResultText({count: 0, skipped: 9, remaining: 0})).toBe(PC.importLegacy.nothingNew);
    expect(originalsText({count: 1, directory: '/x'})).toBe('Copied 1 file to /x.');
    expect(originalsText({count: 0})).toBe(PC.exportOriginals.empty);
    expect(companionErrorText({code: 'unknown', message: ''}, 'Lead.')).toBe('Lead.');
    expect(companionErrorText(new Error('Disk is read-only.'), 'Lead.')).toBe('Lead.');
    expect(companionErrorDetails(new Error('Disk is read-only.'))).toBe('Disk is read-only.');
    expect(companionErrorDetails(Object.assign(new Error('x'), {code: 'processor_offline'}))).toBe('');
    expect(companionErrorText(Object.assign(new Error('x'), {code: 'processor_offline'}), 'Lead.')).toMatch(/^Lead\. Woodshed’s processor/);
    expect(isMissingPath(new Error("ENOENT: no such file or directory, scandir '/x/jobs'"))).toBe(true);
    expect(isMissingPath(Object.assign(new Error('ENOENT'), {code: 'processor_offline'}))).toBe(false);
    expect(importErrorText(new Error("ENOENT: no such file or directory, open '/x/library.json'"))).toBe(PC.importLegacy.notFound);
    expect(importErrorText(new SyntaxError('Unexpected token } in JSON at position 4'))).toBe(PC.importLegacy.unrecognized);
    expect(importErrorText(new Error('Busy.'))).toBe(PC.importLegacy.failed);
  });
});

// ---------------------------------------------------------------------------------------------

describe('Plan & storage: controls as a table (role + accessible name; nothing else)', () => {
  const expectedFor = contexts => PLAN_CONTROLS.filter(c => contexts.includes(c.context));
  test.each([
    ['free', STATUS, ['all', 'free']],
    ['paid with a billing customer', {...STATUS, access: 'paid', status: 'active', interval: 'month', hasCustomer: true}, ['all', 'customer']],
    ['grace with a billing customer', {...STATUS, access: 'grace', graceEndsAt: NOW + 9 * 86_400_000, hasCustomer: true}, ['all', 'free', 'customer']],
  ])('%s', async (_, status, contexts) => {
    const songs = [song('a', 'Alpha', 60), song('b', 'Bravo', 30)];
    const e = planEnv({status, songs});
    const {body} = open(plan, e.ctx);
    await flush();
    const rows = expectedFor(contexts);
    for (const row of rows) expect(find(body, row.role, row.name, row.group ?? null)).toBeTruthy();
    for (const s of songs) find(body, 'link', s.title);
    expect(describeAll(body)).toHaveLength(rows.length + songs.length);
  });

  test('while an export runs: Cancel export', async () => {
    const e = planEnv();
    e.exporter.mockImplementationOnce((onProgress, {signal}) => new Promise((resolve, reject) => {
      onProgress(EXPORT_COPY.gathering, {phase: 'gather', done: 0, total: 0});
      signal.addEventListener('abort', () => reject(new DOMException('The export was canceled.', 'AbortError')));
    }));
    const {body} = open(plan, e.ctx);
    await flush();
    find(body, 'button', LC.export.button).click();
    // The export button stays, busy: its name is the busy text while it runs.
    const rows = expectedFor(['all', 'free', 'exporting']).filter(r => r.name !== LC.export.button);
    for (const row of rows) expect(find(body, row.role, row.name, row.group ?? null)).toBeTruthy();
    expect(find(body, 'button', LC.export.exporting).getAttribute('aria-busy')).toBe('true');
    expect(describeAll(body)).toHaveLength(rows.length + 1);
  });

  test('rows and their scope: the playback cache is this device’s (D40)', async () => {
    const e = planEnv();
    const {body} = open(plan, e.ctx);
    await flush();
    expect([...body.querySelectorAll('.settings-row[data-row]')].map(el => el.dataset.row)).toEqual(PLAN_ROWS.map(r => r.row));
    for (const r of PLAN_ROWS) {
      expect(rowEl(body, r.row).dataset.scope).toBe(r.scope);
      expect(!!rowEl(body, r.row).querySelector('.settings-scope')).toBe(r.scope === 'device');
      expect(rowText(body, r.row)).toContain(r.label);
    }
  });
});

describe('Plan & storage: usage', () => {
  test('the meter reads "0.4 of 1.0 GB" and follows storage.usage; the largest 5 songs link to them', async () => {
    const songs = [song('a', 'Alpha', 60), song('b', 'Bravo', 30), song('c', 'Charlie', 90), song('d', 'Delta', 10),
      song('e', 'Echo', 45), song('f', 'Foxtrot', 5), song('g', 'Golf', 0, {stems: []})];
    const e = planEnv({songs});
    const {body} = open(plan, e.ctx);
    await flush();
    const meter = body.querySelector('[role=meter]');
    expect(accName(meter)).toBe(LC.usage.label);
    expect(meter.getAttribute('aria-valuetext')).toBe('0.4 of 1.0 GB');
    expect(meter.getAttribute('aria-valuenow')).toBe('41');
    expect(rowText(body, 'usage')).toContain('0.4 of 1.0 GB');
    const items = [...body.querySelectorAll('.settings-largest-item')].map(li => collapse(textOf(li)));
    expect(items).toEqual(['Charlie Charlie Band 90 MB', 'Alpha Alpha Band 60 MB', 'Echo Echo Band 45 MB', 'Bravo Bravo Band 30 MB', 'Delta Delta Band 10 MB']);
    const link = find(body, 'link', 'Charlie');
    expect(link.getAttribute('href')).toBe('/s/c');
    link.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
    expect(e.router.navigate).toHaveBeenCalledWith('/s/c');
    e.storage.push({usedBytes: 1.25e9, limitBytes: 1e9, appFull: false});
    expect(meter.getAttribute('aria-valuetext')).toBe('1.3 of 1.0 GB');
    expect(meter.dataset.full).toBe('true');
    expect(rowText(body, 'usage')).toContain(LC.usage.overLimit);
    e.storage.push({usedBytes: 2e8, limitBytes: 25e9, appFull: true});
    expect(rowText(body, 'usage')).toContain(LC.usage.appFull);
    e.store.library.songs.value = new Map();
    expect(body.querySelector('.settings-largest-block').hidden).toBe(true);
  });
});

describe('Plan & storage: the plan', () => {
  test('Free and Plus cards priced from monthlyCents/annualCents; Monthly | Yearly switches the Plus price', async () => {
    const e = planEnv({status: {...STATUS, monthlyCents: 300, annualCents: 3000, freeBytes: 5e8, proBytes: 5e10}});
    const {body} = open(plan, e.ctx);
    await flush();
    const card = id => collapse(textOf(body.querySelector(`.settings-plan[data-plan=${id}]`)));
    expect(checkedIn(body, LC.plan.interval)).toBe(LC.plan.yearly);
    expect(card('free')).toContain('Free Your plan $0');
    expect(card('free')).toContain('500 MB of cloud storage');
    expect(card('free')).toContain('About 20 songs with four stems.');
    expect(card('plus')).toContain('$2.50 / month $30 billed yearly. Save $6 a year. 50 GB of cloud storage');
    find(body, 'radio', LC.plan.monthly, LC.plan.interval).click();
    expect(card('plus')).toContain('$3 / month $3 billed monthly.');
    expect(body.querySelector('.settings-plan[data-plan=free]').dataset.current).toBe('true');
  });

  test('Get Plus opens checkout for the chosen interval; a failure is shown; nothing runs twice', async () => {
    const e = planEnv();
    const {body} = open(plan, e.ctx);
    await flush();
    find(body, 'radio', LC.plan.monthly, LC.plan.interval).click();
    let resolve;
    e.billing.checkout.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const button = find(body, 'button', LC.plan.getPlus);
    button.click();
    button.click();
    expect(e.billing.checkout).toHaveBeenCalledTimes(1);
    expect(e.billing.checkout).toHaveBeenCalledWith({interval: 'month'});
    expect(collapse(button.textContent)).toContain(LC.plan.opening);
    resolve('https://checkout.stripe.test/s/2');
    await flush();
    expect(e.location.assign).toHaveBeenCalledWith('https://checkout.stripe.test/s/2');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    e.billing.checkout.mockRejectedValueOnce(new ApiError({message: 'Upgrades are not available yet.'}));
    button.click();
    await flush();
    expect(rowEl(body, 'plans').querySelector('[role=alert]').textContent).toContain(LC.plan.checkoutFailed);
  });

  test('upgrades switched off: Get Plus is disabled with its reason', async () => {
    const e = planEnv({status: {...STATUS, enabled: false}});
    const {body} = open(plan, e.ctx);
    await flush();
    const button = find(body, 'button', LC.plan.getPlus);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const reason = document.getElementById(button.getAttribute('aria-describedby'));
    expect(reason.textContent).toBe(LC.plan.disabled);
    expect(button.contains(reason)).toBe(true);   // visible, outside the name
    button.click();
    expect(e.billing.checkout).not.toHaveBeenCalled();
  });

  test('Plus with a billing customer: Your plan, no Get Plus, Manage subscription opens the portal', async () => {
    const e = planEnv({status: {...STATUS, access: 'paid', status: 'active', interval: 'month', periodEnd: NOW + 200 * 86_400_000, hasCustomer: true, usedBytes: 3.8e9, limitBytes: 25e9}});
    const {body} = open(plan, e.ctx);
    await flush();
    expect(checkedIn(body, LC.plan.interval)).toBe(LC.plan.monthly);
    expect(body.querySelector('.settings-plan[data-plan=plus]').dataset.current).toBe('true');
    expect(has(body, 'button', LC.plan.getPlus)).toBe(false);
    find(body, 'button', LC.plan.manage).click();
    await flush();
    expect(e.billing.portal).toHaveBeenCalledTimes(1);
    expect(e.location.assign).toHaveBeenCalledWith('https://billing.stripe.test/p/1');
  });

  test.each([
    ['grace', {access: 'grace', status: 'canceled', graceEndsAt: Date.UTC(2026, 10, 6), hasCustomer: true}, 'grace',
      'Your Plus plan has ended. By 2026-11-06, export your library or trim it to the free 1 GB to keep the songs you want; after that, the oldest songs over the limit are removed.'],
    ['cancel at period end', {access: 'paid', status: 'active', cancelAtPeriodEnd: true, periodEnd: Date.UTC(2026, 10, 9), hasCustomer: true}, 'ending',
      'Your Plus plan ends on 2026-11-09. Manage your subscription to keep it.'],
    // billingData.applySync writes a past_due/unpaid Plus account as access 'grace' (with graceEndsAt).
    ['a failed payment (the server’s shape)', {access: 'grace', status: 'past_due', graceEndsAt: Date.UTC(2026, 10, 6), hasCustomer: true}, 'pastDue',
      'Your last payment didn’t go through. Update your payment details in Manage subscription by 2026-11-06 to keep Plus.'],
    ['an unpaid subscription', {access: 'grace', status: 'unpaid', graceEndsAt: Date.UTC(2026, 10, 6), hasCustomer: true}, 'pastDue', LC.plan.pastDueBy('2026-11-06')],
    ['a failed payment without a grace date', {access: 'paid', status: 'past_due', hasCustomer: true}, 'pastDue', LC.plan.pastDue],
  ])('notice: %s', async (_, change, key, text) => {
    const e = planEnv({status: {...STATUS, ...change}});
    const {body} = open(plan, e.ctx);
    await flush();
    const notice = body.querySelector(`[data-notice=${key}]`);
    expect(collapse(textOf(notice))).toContain(text);
    expect(body.querySelectorAll('[data-notice]')).toHaveLength(1);
    e.billing.push({...STATUS});
    expect(body.querySelectorAll('[data-notice]')).toHaveLength(0);
  });

  test('a failed payment keeps Plus as Your plan: Manage subscription, never Get Plus (a second subscription)', async () => {
    const failing = {...STATUS, access: 'grace', status: 'past_due', graceEndsAt: Date.UTC(2026, 10, 6), hasCustomer: true};
    expect(paymentFailing(failing)).toBe(true);
    expect(currentPlan(failing)).toBe('plus');
    expect(planNotices(failing, {format: () => 'D'}).map(n => n.key)).toEqual(['pastDue']);
    expect(paymentFailing({...failing, status: 'canceled'})).toBe(false);
    expect(currentPlan({...failing, status: 'canceled'})).toBe('free');
    expect(paymentFailing({...failing, access: 'free'})).toBe(false);
    const e = planEnv({status: failing});
    const {body} = open(plan, e.ctx);
    await flush();
    expect(body.querySelector('[data-notice=grace]')).toBeNull();
    expect(body.querySelector('.settings-plan[data-plan=plus]').dataset.current).toBe('true');
    expect(body.querySelector('.settings-plan[data-plan=free]').dataset.current).toBe('false');
    expect(has(body, 'button', LC.plan.getPlus)).toBe(false);
    expect(has(body, 'button', LC.plan.manage)).toBe(true);
  });

  test('?checkout=success toasts once when the section opens (the query stays)', async () => {
    const e = planEnv({query: {checkout: 'success'}});
    open(plan, e.ctx);
    expect(e.feedback.toast).toHaveBeenCalledWith(LC.plan.checkoutSuccess, {tone: 'ok', key: 'checkout-success'});
    expect(e.router.navigate).not.toHaveBeenCalled();
    const quiet = planEnv();
    open(plan, quiet.ctx);
    expect(quiet.feedback.toast).not.toHaveBeenCalled();
  });

  test('the plan loading and failing: a status line, then Try again subscribes again', async () => {
    const e = planEnv({status: null});
    const {body} = open(plan, e.ctx);
    expect(rowText(body, 'plans')).toContain(LC.plan.loading);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    e.billing.fail(new ApiError({code: 'network'}));
    const alert = rowEl(body, 'plans').querySelector('[role=alert]');
    expect(alert.textContent).toContain(LC.plan.failed);
    alert.querySelector('button').click();
    expect(e.billing.off).toHaveBeenCalledTimes(1);
    expect(e.billing.subscribeStatus).toHaveBeenCalledTimes(2);
    e.billing.push({...STATUS});
    expect(rowEl(body, 'plans').querySelector('.settings-plan-body').hidden).toBe(false);
  });

  test('closing the section closes the billing and usage subscriptions (maps/shell.md S9)', async () => {
    const e = planEnv();
    const {handle} = open(plan, e.ctx);
    await flush();
    handle.destroy();
    opened.length = 0;
    expect(e.billing.off).toHaveBeenCalledTimes(1);
    expect(e.storage.off).toHaveBeenCalledTimes(1);
  });
});

describe('Plan & storage: export and cache', () => {
  test('Export library calls the exporter inside the click, shows progress, then the result', async () => {
    const e = planEnv();
    let progress;
    e.exporter.mockImplementationOnce((onProgress, {signal}) => {
      progress = onProgress;
      expect(signal).toBeInstanceOf(AbortSignal);
      return new Promise(() => {});
    });
    const {body} = open(plan, e.ctx);
    await flush();
    const button = find(body, 'button', LC.export.button);
    button.click();
    expect(e.exporter).toHaveBeenCalledTimes(1);   // synchronously: the save picker opens inside the gesture
    expect(button.getAttribute('aria-busy')).toBe('true');
    progress(EXPORT_COPY.song(1, 4, 'Alpha'), {phase: 'song', done: 1, total: 4, title: 'Alpha'});
    expect(rowText(body, 'export')).toContain('Exporting 1/4: Alpha');
    expect(body.querySelector('.settings-export-running [role=progressbar]').getAttribute('aria-valuenow')).toBe('25');
    button.click();
    expect(e.exporter).toHaveBeenCalledTimes(1);   // one export at a time

    resetExport();   // the export belongs to the page: cancel it before starting another
    const done = planEnv();
    const second = open(plan, done.ctx).body;
    await flush();
    find(second, 'button', LC.export.button).click();
    await flush();
    expect(collapse(second.querySelector('[data-row=export] [role=status]:not(.settings-export-progress)').textContent)).toBe(EXPORT_COPY.done(2));
    expect(second.querySelector('.settings-export-running').hidden).toBe(true);
  });

  test('Cancel export aborts it; a cancelled save picker says nothing; failures read as sentences', async () => {
    const e = planEnv();
    e.exporter.mockImplementationOnce((onProgress, {signal}) => new Promise((resolve, reject) => {
      onProgress(EXPORT_COPY.gathering, {phase: 'gather', done: 0, total: 0});
      signal.addEventListener('abort', () => reject(new DOMException('The export was canceled.', 'AbortError')));
    }));
    const {body} = open(plan, e.ctx);
    await flush();
    find(body, 'button', LC.export.button).click();
    find(body, 'button', LC.export.cancel).click();
    await flush();
    expect(rowText(body, 'export')).toContain(LC.export.canceled);

    e.exporter.mockRejectedValueOnce(new DOMException('The user aborted a request.', 'AbortError'));
    find(body, 'button', LC.export.button).click();
    await flush();
    expect(rowEl(body, 'export').querySelector('.ui-inline-status:not([hidden]), [role=alert]')).toBeNull();

    e.exporter.mockRejectedValueOnce(new Error(EXPORT_COPY.tooLarge));
    find(body, 'button', LC.export.button).click();
    await flush();
    expect(collapse(rowEl(body, 'export').querySelector('[role=alert]').textContent)).toBe(`${LC.export.failed} ${EXPORT_COPY.tooLarge}`);
    expect(exportFailedText(new TypeError('x is undefined'))).toBe(`${LC.export.failed} ${LC.export.tryAgain}`);
    expect(exportFailedText(new ApiError({code: 'network'}))).toMatch(/^The export didn’t finish\. /);
  });

  test('a layout rebuild (iPad rotated) or leaving Settings never cancels the export; the next section shows it', async () => {
    const e = planEnv();
    let progress, finish, aborted = false;
    e.exporter.mockImplementationOnce((onProgress, {signal}) => {
      progress = onProgress;
      signal.addEventListener('abort', () => { aborted = true; });
      return new Promise(resolve => { finish = resolve; });
    });
    const first = open(plan, e.ctx);
    await flush();
    find(first.body, 'button', LC.export.button).click();
    progress(EXPORT_COPY.song(2, 4, 'Bravo'), {phase: 'song', done: 2, total: 4, title: 'Bravo'});
    first.handle.destroy();             // the frame rebuilds on a stack/split change
    expect(aborted).toBe(false);
    expect(runningExport()).not.toBeNull();
    const second = open(plan, e.ctx).body;
    await flush();
    expect(rowText(second, 'export')).toContain('Exporting 2/4: Bravo');
    expect(find(second, 'button', LC.export.exporting).getAttribute('aria-busy')).toBe('true');
    expect(second.querySelector('.settings-export-running [role=progressbar]').getAttribute('aria-valuenow')).toBe('50');
    progress(EXPORT_COPY.song(3, 4, 'Charlie'), {phase: 'song', done: 3, total: 4, title: 'Charlie'});
    expect(rowText(second, 'export')).toContain('Exporting 3/4: Charlie');
    find(second, 'button', LC.export.exporting).click();   // still one export at a time
    expect(e.exporter).toHaveBeenCalledTimes(1);
    for (const handle of opened.splice(0)) handle.destroy();   // left Settings while it finished
    finish({songs: 4, bytes: 1});
    await flush();
    expect(runningExport()).toBeNull();
    const third = open(plan, e.ctx).body;
    await flush();
    expect(collapse(third.querySelector('[data-row=export] [role=status]:not(.settings-export-progress)').textContent)).toBe(EXPORT_COPY.done(4));
    expect(has(third, 'button', LC.export.button)).toBe(true);
  });

  test('Cancel in a rebuilt section cancels the export; signing out (or another account) cancels it too', async () => {
    const listeners = new Set();
    let user = {_id: 'u1'};
    const auth = {user: () => user, onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); }};
    const e = planEnv();
    e.ctx.auth = auth;
    const hanging = (onProgress, {signal}) => new Promise((resolve, reject) => {
      onProgress(EXPORT_COPY.gathering, {phase: 'gather', done: 0, total: 0});
      signal.addEventListener('abort', () => reject(new DOMException('The export was canceled.', 'AbortError')));
    });
    e.exporter.mockImplementationOnce(hanging).mockImplementationOnce(hanging).mockImplementationOnce(hanging);
    const first = open(plan, e.ctx);
    await flush();
    find(first.body, 'button', LC.export.button).click();
    first.handle.destroy();
    const second = open(plan, e.ctx).body;
    find(second, 'button', LC.export.cancel).click();
    await flush();
    expect(rowText(second, 'export')).toContain(LC.export.canceled);
    expect(runningExport()).toBeNull();

    find(second, 'button', LC.export.button).click();
    expect(listeners.size).toBe(1);
    for (const fn of listeners) fn({user: {_id: 'u1'}, status: {}});   // a live users.me update: keeps going
    await flush();
    expect(runningExport()).not.toBeNull();
    user = null;
    for (const fn of [...listeners]) fn({user: null, status: null});
    await flush();
    expect(runningExport()).toBeNull();
    expect(listeners.size).toBe(0);
    expect(rowText(second, 'export')).toContain(LC.export.canceled);

    user = {_id: 'u1'};
    find(second, 'button', LC.export.button).click();
    for (const fn of [...listeners]) fn({user: {_id: 'u2'}, status: {}});
    await flush();
    expect(runningExport()).toBeNull();
  });

  test.each([
    ['iPad', {isIPad: true}, LC.export.limitIPad],
    ['another browser without a save picker', {isIPad: false}, LC.export.limitBrowser],
  ])('the 100 MB note on %s', async (_, platform, text) => {
    const e = planEnv({platform, picker: false});
    const {body} = open(plan, e.ctx);
    expect(rowText(body, 'export')).toContain(text);
    const withPicker = planEnv({platform});
    const other = open(plan, withPicker.ctx).body;
    expect(rowText(other, 'export')).not.toContain('100 MB');
  });

  test('Playback cache: "412 MB · Clear", Clear empties it and measures again', async () => {
    const e = planEnv();
    const {body} = open(plan, e.ctx);
    await flush();
    expect(rowEl(body, 'cache').querySelector('.settings-cache').textContent).toBe('412 MB·Clear');
    e.cache.size.mockResolvedValueOnce(0);
    find(body, 'button', LC.cache.clearName).click();
    await flush();
    expect(e.cache.clear).toHaveBeenCalledTimes(1);
    expect(rowText(body, 'cache')).toContain('0 MB');
    expect(rowText(body, 'cache')).toContain(LC.cache.cleared);
  });

  test('Playback cache unsupported, or failing to clear', async () => {
    const e = planEnv({cache: {supported: () => false, size: vi.fn(), clear: vi.fn()}});
    const {body} = open(plan, e.ctx);
    await flush();
    expect(rowText(body, 'cache')).toContain(LC.cache.unsupported);
    expect(has(body, 'button', LC.cache.clearName)).toBe(false);
    const f = planEnv({cache: {supported: () => true, size: vi.fn(async () => 5e6), clear: vi.fn(async () => { throw new Error('quota'); })}});
    const other = open(plan, f.ctx).body;
    await flush();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    find(other, 'button', LC.cache.clearName).click();
    await flush();
    expect(rowText(other, 'cache')).toContain(LC.cache.failed);
  });
});

describe('Plan & storage helpers', () => {
  test.each([[0, '0 MB'], [412e6, '412 MB'], [1e9, '1 GB'], [1.25e9, '1.3 GB'], [25e9, '25 GB'], [-5, '0 MB'], [undefined, '0 MB']])('formatBytes(%s) = %s', (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });
  test.each([[1.2e9, 2e9, '1.2 of 2.0 GB'], [412e6, 1e9, '0.4 of 1.0 GB'], [120e6, 250e6, '120 of 250 MB'], [0, 0, '0 of 0 MB']])('usageText(%s, %s)', (u, l, text) => {
    expect(usageText(u, l)).toBe(text);
  });
  test('usageFraction, formatPrice, planPrice, initialInterval', () => {
    expect([usageFraction(5, 10), usageFraction(20, 10), usageFraction(5, 0)]).toEqual([0.5, 1, 0]);
    expect([formatPrice(200), formatPrice(167), formatPrice(2000), formatPrice(5)]).toEqual(['$2', '$1.67', '$20', '$0.05']);
    expect(planPrice({monthlyCents: 200, annualCents: 2000}, 'year')).toEqual({price: '$1.67', cadence: '$20 billed yearly. Save $4 a year.'});
    expect(planPrice({monthlyCents: 200, annualCents: 2400}, 'year')).toEqual({price: '$2', cadence: '$24 billed yearly.'});
    expect(planPrice({monthlyCents: 200, annualCents: 2000}, 'month')).toEqual({price: '$2', cadence: '$2 billed monthly.'});
    expect([initialInterval({interval: 'month'}), initialInterval({interval: null}), initialInterval(null)]).toEqual(['month', 'year', 'year']);
  });
  test('largestSongs sums stem bytes, skips songs without stored audio, takes the top 5', () => {
    const list = largestSongs(new Map([['a', song('a', 'A', 10)], ['b', song('b', 'B', 20)], ['z', {id: 'z', title: 'Z', stems: []}]]));
    expect(list.map(s => [s.id, s.bytes])).toEqual([['b', 20e6], ['a', 10e6]]);
    expect(largestSongs(Array.from({length: 9}, (_, i) => song(`s${i}`, `S${i}`, i + 1)))).toHaveLength(5);
  });
  test('planNotices: none for a plain free plan', () => {
    expect(planNotices(STATUS)).toEqual([]);
    expect(planNotices(null)).toEqual([]);
  });
});
