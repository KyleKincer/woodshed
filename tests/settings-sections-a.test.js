// @vitest-environment happy-dom
// SE1: the Settings sections Practice, Instruments, Pedals & keys, Appearance, This device and Account
// (architecture §2.17, §2.4, §2.5, D13, D14, D40, §9.10 SE1; spec §6.2, §4.2, §8.4): spec §6.2's rows
// and controls as tables, the account vs device split, save on change with "Saved" / "Couldn't save ·
// [Retry]", and each section following the stored values.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {COPY, CONTROLS, LICENSE_NAMES, ROWS, SECTION_TITLES} from '../src/settings/settings.copy.js';
import {SECTION_MODULES, mount, sectionPath} from '../src/settings/settings.js';
import practice, {countInChoice, countInFor} from '../src/settings/sections/practice.js';
import instruments from '../src/settings/sections/instruments.js';
import pedals from '../src/settings/sections/pedals.js';
import appearance from '../src/settings/sections/appearance.js';
import device, {LICENSE_FILES, installText, licenses, updateText} from '../src/settings/sections/device.js';
import account from '../src/settings/sections/account.js';
import {CONTROLS as ONBOARDING_CONTROLS} from '../src/onboarding/onboarding.copy.js';
import {createAccount} from '../src/app/account.js';
import {createRegistry} from '../src/app/commands.js';
import {normalizePrefs, PREFS_DEFAULTS} from '../src/app/prefs.js';
import {signal} from '../src/app/store.js';
import {ApiError} from '../src/api/client.js';
import {mergeSettings, withDefaults} from '../convex/lib/presets.ts';
import {readdirSync, readFileSync} from 'node:fs';
import {version as packageVersion} from '../package.json';

const SECTIONS = {practice, instruments, pedals, appearance, device, account};

// ---------------------------------------------------------------------------------------------
// accessibility helpers (the same rules as tests/onboarding.test.js)

const collapse = s => s.replace(/\s+/g, ' ').trim();
const isHidden = el => !!el.closest('[hidden], [aria-hidden=true]');
function accName(el) {
  if (el.hasAttribute('aria-label')) return collapse(el.getAttribute('aria-label'));
  if (el.hasAttribute('aria-labelledby')) {
    return collapse(el.getAttribute('aria-labelledby').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' '));
  }
  const walk = node => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || node.hidden || node.getAttribute('aria-hidden') === 'true') return '';
    return ` ${[...node.childNodes].map(walk).join('')} `;
  };
  return collapse(walk(el));
}
const roleOf = el => el.getAttribute('role') ?? (el.matches('a[href]') ? 'link' : el.matches('button') ? 'button'
  : el.matches('select') ? 'combobox' : el.matches('input, textarea') ? 'textbox' : null);
const CONTROL_SELECTOR = 'a[href], button, input, select, textarea, [role=button], [role=radio], [role=checkbox], [role=link], [role=spinbutton], [role=switch]';
const exposedControls = root => [...root.querySelectorAll(CONTROL_SELECTOR)].filter(el => !isHidden(el));
function find(root, role, name, group = null) {
  const scope = group ? findGroup(root, group) : root;
  const found = exposedControls(scope).filter(el => roleOf(el) === role && accName(el) === name);
  if (found.length !== 1) throw new Error(`expected one ${role} "${name}"${group ? ` in "${group}"` : ''}, found ${found.length}: ${exposedControls(scope).map(e => `${roleOf(e)}:${accName(e)}`).join(' | ')}`);
  return found[0];
}
function findGroup(root, name) {
  const found = [...root.querySelectorAll('[role=radiogroup]')].filter(el => !isHidden(el) && accName(el) === name);
  if (found.length !== 1) throw new Error(`expected one radiogroup "${name}", found ${found.length}`);
  return found[0];
}
const checkedIn = (root, group) => accName(findGroup(root, group).querySelector('[aria-checked=true]'));
const pressed = (root, name) => find(root, 'button', name).getAttribute('aria-pressed');
const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const rowEl = (root, key) => root.querySelector(`[data-row="${key}"]`);
/** Visible text with element boundaries as spaces (hidden parts skipped). */
const visibleText = node => {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1 || node.hidden || node.getAttribute('aria-hidden') === 'true') return '';
  return ` ${[...node.childNodes].map(visibleText).join('')} `;
};
const rowText = (root, key) => collapse(visibleText(rowEl(root, key)));
const savedIn = row => row.querySelector('.settings-save[role=status]').textContent;

// ---------------------------------------------------------------------------------------------
// fakes

/** The real account controller over an in-memory settings.patch; `fail` failures first. */
function fakeAccount({settings = {}, fail = 0} = {}) {
  const store = {config: signal(null), account: signal(withDefaults(settings)), pendingAccount: signal(null)};
  const patches = [];
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
  return {account: createAccount({store, api, toast: () => {}}), store, api, patches,
    /** Another device changed the settings. */
    remote(change) { store.account.value = mergeSettings(withDefaults(store.account.peek()), change); },
    failNext(n = 1) { fail = n; }};
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, path, value) {
  const root = JSON.parse(JSON.stringify(obj));
  const keys = path.split('.');
  let node = root;
  for (const k of keys.slice(0, -1)) node = node[k] ??= {};
  node[keys.at(-1)] = value;
  return root;
}
/** A prefs module over a signal, with the schema of src/app/prefs.js. */
function fakePrefs(initial = {}) {
  const sig = signal(normalizePrefs(initial));
  const writes = [];
  return {
    value: sig, writes,
    get: path => getPath(sig.value, path),
    set: vi.fn((path, value) => { writes.push([path, value]); sig.value = normalizePrefs(setPath(sig.peek(), path, value)); }),
    /** Another tab changed ws.prefs. */
    external(path, value) { sig.value = normalizePrefs(setPath(sig.peek(), path, value)); },
  };
}

function fakeRegistry(store) {
  const registry = createRegistry();
  const runs = [];
  registry.registerMany([
    {id: 'app.shortcuts', title: 'Keyboard shortcuts', group: 'App', keys: ['?'], scopes: ['global'], icon: 'keyboard', run: () => runs.push('app.shortcuts')},
    {id: 'app.signOut', title: 'Sign out', group: 'App', icon: 'log-out', run: () => runs.push('app.signOut')},
    {id: 'nav.admin', title: 'Administration', group: 'App', when: () => !!store.session.peek()?.admin, run: () => runs.push('nav.admin')},
  ]);
  return {registry, runs};
}

function env({context = 'web', settings, prefs: prefsInit, features = {wakeLock: true, mediaSession: true}, isIOS = false,
  install: installState = {canPrompt: false, installed: false, steps: 'chromium'}, update = {status: 'idle'}, admin = false,
  user = {id: 'u1', name: 'Kyle K.', email: 'kyle@example.com', image: null}, reducedMotion = false} = {}) {
  const desktopApp = context === 'desktop';
  const acct = fakeAccount({settings});
  const prefs = fakePrefs(prefsInit);
  const store = {session: signal({user, admin: admin || context === 'admin', status: 'active', online: true}), update: signal(update)};
  const {registry, runs} = fakeRegistry(store);
  const install = {state: signal(installState), prompt: vi.fn(async () => 'dismissed')};
  const desktop = {available: desktopApp, info: vi.fn(async () => ({version: '2.0.0'})), update: vi.fn(async () => ({status: 'current'}))};
  const platform = {isDesktopApp: desktopApp, isIOS, isIPad: isIOS, features: {...features}, reducedMotion: signal(reducedMotion)};
  return {acct, account: acct.account, prefs, store, registry, runs, install, desktop, platform};
}

let host;
const opened = [];
beforeEach(() => {
  host = document.createElement('main');
  document.body.append(host);
});
afterEach(() => {
  for (const handle of opened.splice(0)) handle.destroy();
  host.remove();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Renders one section on its own (with a heading for labelledBy), as the frame does. */
function render(id, e = env()) {
  const heading = Object.assign(document.createElement('h2'), {id: `heading-${id}`, textContent: SECTION_TITLES[id]});
  const body = document.createElement('div');
  host.replaceChildren(heading, body);
  const handle = SECTIONS[id].render(body, {...e, headingId: heading.id, layout: 'split', window});
  opened.push(handle);
  return {...e, body, handle};
}

// ---------------------------------------------------------------------------------------------

describe('section modules', () => {
  test.each(Object.keys(SECTIONS))('%s default-exports {id, title, render} and is found by the frame', async id => {
    expect(SECTIONS[id]).toMatchObject({id, title: SECTION_TITLES[id]});
    expect(SECTIONS[id].render).toBeTypeOf('function');
    expect((await SECTION_MODULES[sectionPath(id)]()).default).toBe(SECTIONS[id]);
  });
});

describe('spec §6.2 controls, as a table (role + accessible name; nothing else)', () => {
  const CONTEXTS = {
    web: ['all', 'web'], desktop: ['all', 'desktop'], admin: ['all', 'web', 'admin'], custom: ['all', 'web', 'custom'], prompt: ['all', 'web', 'prompt'],
  };
  const cases = [];
  for (const section of Object.keys(SECTIONS)) for (const ctx of ['web', 'desktop', 'admin']) cases.push([section, ctx]);
  cases.push(['practice', 'custom'], ['device', 'prompt']);

  test.each(cases)('%s (%s)', (section, context) => {
    const e = env({
      context: context === 'custom' || context === 'prompt' ? 'web' : context,
      settings: context === 'custom' ? {practice: {countIn: {on: true, length: 3, unit: 'beats'}}} : {},
      install: context === 'prompt' ? {canPrompt: true, installed: false, steps: 'chromium'} : undefined,
    });
    const {body} = render(section, e);
    const rows = section === 'instruments'
      ? ONBOARDING_CONTROLS.filter(r => r.context === 'picker').map(r => ({...r, section}))
      : CONTROLS.filter(r => r.section === section && CONTEXTS[context].includes(r.context));
    for (const r of rows) {
      if (r.role === 'radiogroup') expect(findGroup(body, r.name)).toBeTruthy();
      else expect(find(body, r.role, r.name, r.group ?? null)).toBeTruthy();
    }
    // Pedals & keys is a stub that PD1 completes in pedals.js: only its own controls must be there.
    if (section === 'pedals') return;
    const expected = rows.filter(r => r.role !== 'radiogroup').length;
    expect(exposedControls(body).map(el => `${roleOf(el)}:${accName(el)}`)).toHaveLength(expected);
  });

  test('every licence file in public/licenses has a named button', () => {
    const files = readdirSync('public/licenses').filter(f => f.endsWith('.txt')).map(f => f.replace(/\.txt$/, '')).sort();
    expect(Object.keys(LICENSE_NAMES).sort()).toEqual(files);
    expect(licenses().map(l => l.id)).toEqual(Object.keys(LICENSE_NAMES));
    expect(Object.keys(LICENSE_FILES)).toHaveLength(files.length);
  });
});

describe('rows and where they are kept (D40)', () => {
  test.each(ROWS.map(r => [r.section, r.row, r]))('%s → %s', (section, key, r) => {
    const e = env({context: r.context === 'admin' ? 'admin' : 'web'});
    const {body} = render(section, e);
    const row = rowEl(body, key);
    expect(row, `row ${key}`).not.toBeNull();
    expect(isHidden(row)).toBe(false);
    expect(row.dataset.scope).toBe(r.scope);
    if (r.label) expect(rowText(body, key)).toContain(r.label);
    // Only device rows carry the "This device" tag.
    expect(!!row.querySelector('.settings-scope')).toBe(r.scope === 'device');
    if (r.scope === 'device') expect(row.querySelector('.settings-scope').textContent).toBe(COPY.thisDevice);
  });

  test('Practice rows follow spec §6.2 order (Classic keys dropped)', () => {
    const {body} = render('practice', env());
    expect([...body.querySelectorAll('[data-row]')].map(r => r.dataset.row))
      .toEqual(['stop', 'countIn', 'click', 'eachPassCount', 'keepPitch', 'distance', 'follow', 'wake', 'edgeFlash']);
    expect(ROWS.filter(r => r.section === 'practice').map(r => r.row).sort())
      .toEqual(['click', 'countIn', 'distance', 'eachPassCount', 'edgeFlash', 'follow', 'keepPitch', 'stop', 'wake']);
  });

  test('account rows write only the account; device rows write only this device', async () => {
    const e = env();
    const {body} = render('practice', e);
    find(body, 'radio', 'Stay', COPY.practice.stop.label).click();
    find(body, 'radio', 'Always', COPY.practice.click.label).click();
    find(body, 'radio', '30 min', COPY.practice.wake.label).click();
    find(body, 'button', COPY.practice.eachPassCount.label).click();
    find(body, 'button', COPY.practice.keepPitch.label).click();
    await flush();
    expect(e.acct.patches).toEqual([
      {practice: {stop: 'stay'}}, {practice: {click: 'always'}}, {practice: {wake: 30}},
      {practice: {eachPassCount: false}}, {practice: {keepPitch: false}},
    ]);
    expect(e.prefs.writes).toEqual([]);
    find(body, 'radio', 'Kit', COPY.practice.distance.label).click();
    find(body, 'radio', 'Page', COPY.practice.follow.railGroup).click();
    find(body, 'radio', 'Scroll', COPY.practice.follow.bandGroup).click();
    find(body, 'button', COPY.practice.edgeFlash.label).click();
    await flush();
    expect(e.prefs.writes).toEqual([
      ['practice.distance', 'kit'], ['practice.follow.rail', 'page'], ['practice.follow.band', 'scroll'], ['practice.edgeFlash', true],
    ]);
    expect(e.acct.patches).toHaveLength(5);
    // The account value moved with the patches (the server merged them).
    expect(e.account.value.peek().practice).toMatchObject({stop: 'stay', click: 'always', wake: 30, eachPassCount: false, keepPitch: false});
  });
});

describe('Practice', () => {
  test('the defaults: Return to cue, count-in Off, click during count-in, every pass and keep pitch on, Stand, 10 min', () => {
    const {body} = render('practice');
    expect(checkedIn(body, COPY.practice.stop.label)).toBe('Return to cue');
    expect(checkedIn(body, COPY.practice.countIn.label)).toBe('Off');
    expect(checkedIn(body, COPY.practice.click.label)).toBe('During count-in only');
    expect(pressed(body, COPY.practice.eachPassCount.label)).toBe('true');
    expect(pressed(body, COPY.practice.keepPitch.label)).toBe('true');
    expect(checkedIn(body, COPY.practice.distance.label)).toBe('Stand');
    expect(checkedIn(body, COPY.practice.follow.railGroup)).toBe('Scroll');
    expect(checkedIn(body, COPY.practice.follow.bandGroup)).toBe('Page');
    expect(checkedIn(body, COPY.practice.wake.label)).toBe('10 min');
    expect(pressed(body, COPY.practice.edgeFlash.label)).toBe('false');
  });

  test.each([
    [{on: false, length: 1, unit: 'bars'}, 'off'], [{on: false, length: 4, unit: 'beats'}, 'off'],
    [{on: true, length: 1, unit: 'bars'}, 'oneBar'], [{on: true, length: 2, unit: 'bars'}, 'twoBars'],
    [{on: true, length: 2, unit: 'beats'}, 'twoBeats'], [{on: true, length: 1, unit: 'beats'}, 'custom'],
    [{on: true, length: 16, unit: 'bars'}, 'custom'], [undefined, 'off'],
  ])('countInChoice(%j) is %s', (countIn, choice) => {
    expect(countInChoice(countIn)).toBe(choice);
  });

  test.each([
    ['off', {on: true, length: 3, unit: 'beats'}, {on: false, length: 3, unit: 'beats'}],
    ['oneBar', {on: false, length: 3, unit: 'beats'}, {on: true, length: 1, unit: 'bars'}],
    ['twoBars', {on: false, length: 1, unit: 'bars'}, {on: true, length: 2, unit: 'bars'}],
    ['twoBeats', {on: false, length: 1, unit: 'bars'}, {on: true, length: 2, unit: 'beats'}],
    ['custom', {on: false, length: 5, unit: 'beats'}, {on: true, length: 5, unit: 'beats'}],
  ])('countInFor(%s, %j) writes the whole countIn %j', (choice, current, next) => {
    expect(countInFor(choice, current)).toEqual(next);
  });

  test('count-in presets write the whole countIn; Custom opens 1–16 bars or beats', async () => {
    const e = env();
    const {body} = render('practice', e);
    const group = COPY.practice.countIn.label;
    expect(rowEl(body, 'countIn').querySelector('.settings-countin-custom').hidden).toBe(true);
    find(body, 'radio', '2 bars', group).click();
    await flush();
    expect(e.acct.patches.at(-1)).toEqual({practice: {countIn: {on: true, length: 2, unit: 'bars'}}});
    find(body, 'radio', 'Custom', group).click();
    await flush();
    expect(e.acct.patches).toHaveLength(1);   // Custom keeps 2 bars: nothing to write yet
    expect(checkedIn(body, group)).toBe('Custom');
    const length = find(body, 'spinbutton', COPY.practice.countIn.length);
    expect(length.getAttribute('aria-valuetext')).toBe('2 bars');
    expect([length.getAttribute('aria-valuemin'), length.getAttribute('aria-valuemax')]).toEqual(['1', '16']);
    find(body, 'button', COPY.practice.countIn.longer).dispatchEvent(new MouseEvent('click', {bubbles: true}));
    await flush();
    const before = e.acct.patches.length;
    length.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true}));
    await flush();
    expect(e.acct.patches.length).toBeGreaterThan(before);
    expect(e.acct.patches.at(-1).practice.countIn).toMatchObject({on: true, unit: 'bars'});
    const len = e.acct.patches.at(-1).practice.countIn.length;
    expect(len).toBeGreaterThanOrEqual(3);
    find(body, 'radio', 'Beats', COPY.practice.countIn.unit).click();
    await flush();
    expect(e.acct.patches.at(-1)).toEqual({practice: {countIn: {on: true, length: len, unit: 'beats'}}});
    expect(find(body, 'spinbutton', COPY.practice.countIn.length).getAttribute('aria-valuetext')).toBe(`${len} beats`);
    // A custom length stays on Custom; Off closes it.
    expect(checkedIn(body, group)).toBe('Custom');
    find(body, 'radio', 'Off', group).click();
    await flush();
    expect(e.acct.patches.at(-1)).toEqual({practice: {countIn: {on: false, length: len, unit: 'beats'}}});
    expect(rowEl(body, 'countIn').querySelector('.settings-countin-custom').hidden).toBe(true);
  });

  test('a custom count-in changed elsewhere to a preset shows the preset; to another custom stays Custom', () => {
    const e = env({settings: {practice: {countIn: {on: true, length: 3, unit: 'beats'}}}});
    const {body} = render('practice', e);
    const group = COPY.practice.countIn.label;
    const panel = () => rowEl(body, 'countIn').querySelector('.settings-countin-custom');
    expect(checkedIn(body, group)).toBe('Custom');
    e.acct.remote({practice: {countIn: {on: true, length: 1, unit: 'bars'}}});
    expect(checkedIn(body, group)).toBe('1 bar');
    expect(panel().hidden).toBe(true);
    e.acct.remote({practice: {countIn: {on: true, length: 5, unit: 'bars'}}});
    expect(checkedIn(body, group)).toBe('Custom');
    expect(panel().hidden).toBe(false);
  });

  test('Custom picked on a preset-shaped value stays Custom while other settings change', async () => {
    const e = env({settings: {practice: {countIn: {on: true, length: 1, unit: 'bars'}}}});
    const {body} = render('practice', e);
    const group = COPY.practice.countIn.label;
    find(body, 'radio', 'Custom', group).click();
    await flush();
    e.acct.remote({practice: {stop: 'stay'}});
    expect(checkedIn(body, group)).toBe('Custom');
    expect(rowEl(body, 'countIn').querySelector('.settings-countin-custom').hidden).toBe(false);
  });

  test('Off → Custom that fails reverts to Off; a Retry that saves shows Custom again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = env();
    const {body} = render('practice', e);
    const group = COPY.practice.countIn.label;
    const panel = () => rowEl(body, 'countIn').querySelector('.settings-countin-custom');
    e.acct.failNext(1);
    find(body, 'radio', 'Custom', group).click();
    await flush();
    expect(checkedIn(body, group)).toBe('Off');
    expect(panel().hidden).toBe(true);
    rowEl(body, 'countIn').querySelector('.settings-save-retry').click();
    await flush();
    expect(e.acct.patches.at(-1)).toEqual({practice: {countIn: {on: true, length: 1, unit: 'bars'}}});
    expect(checkedIn(body, group)).toBe('Custom');
    expect(panel().hidden).toBe(false);
  });

  test('a stored custom count-in opens on Custom', () => {
    const {body} = render('practice', env({settings: {practice: {countIn: {on: true, length: 4, unit: 'beats'}}}}));
    expect(checkedIn(body, COPY.practice.countIn.label)).toBe('Custom');
    expect(find(body, 'spinbutton', COPY.practice.countIn.length).getAttribute('aria-valuenow')).toBe('4');
    expect(checkedIn(body, COPY.practice.countIn.unit)).toBe('Beats');
  });

  test('each change shows Saved in its own row', async () => {
    const e = env();
    const {body} = render('practice', e);
    find(body, 'radio', 'Stay', COPY.practice.stop.label).click();
    await flush();
    expect(savedIn(rowEl(body, 'stop'))).toBe('Saved');
    expect(savedIn(rowEl(body, 'click'))).toBe('');
    find(body, 'radio', 'Near', COPY.practice.distance.label).click();
    await flush();
    expect(savedIn(rowEl(body, 'distance'))).toBe('Saved');
  });

  test('a failed save reverts the control and offers Retry, which saves it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = env();
    const {body} = render('practice', e);
    e.acct.failNext(1);
    find(body, 'radio', 'Stay', COPY.practice.stop.label).click();
    await flush();
    const row = rowEl(body, 'stop');
    expect(checkedIn(body, COPY.practice.stop.label)).toBe('Return to cue');   // the optimistic value reverted
    const alert = row.querySelector('[role=alert]');
    expect(alert.hidden).toBe(false);
    expect(collapse(visibleText(alert))).toBe('Couldn’t save Retry');
    expect(collapse(alert.textContent)).toBe('Couldn’t save·Retry');
    find(row, 'button', 'Retry').click();
    await flush();
    expect(e.acct.patches).toEqual([{practice: {stop: 'stay'}}, {practice: {stop: 'stay'}}]);
    expect(checkedIn(body, COPY.practice.stop.label)).toBe('Stay');
    expect(alert.hidden).toBe(true);
    expect(savedIn(row)).toBe('Saved');
  });

  test('a failed toggle save reverts its pressed state', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = env();
    const {body} = render('practice', e);
    e.acct.failNext(1);
    find(body, 'button', COPY.practice.keepPitch.label).click();
    await flush();
    expect(pressed(body, COPY.practice.keepPitch.label)).toBe('true');
    expect(rowEl(body, 'keepPitch').querySelector('[role=alert]').hidden).toBe(false);
  });

  test('changes from another device and another tab show at once', () => {
    const e = env();
    const {body} = render('practice', e);
    e.acct.remote({practice: {stop: 'stay', wake: 'always', click: 'off', countIn: {on: true, length: 2, unit: 'beats'}, keepPitch: false}});
    expect(checkedIn(body, COPY.practice.stop.label)).toBe('Stay');
    expect(checkedIn(body, COPY.practice.wake.label)).toBe('Always');
    expect(checkedIn(body, COPY.practice.click.label)).toBe('Off');
    expect(checkedIn(body, COPY.practice.countIn.label)).toBe('2 beats');
    expect(pressed(body, COPY.practice.keepPitch.label)).toBe('false');
    e.prefs.external('practice.distance', 'near');
    e.prefs.external('practice.edgeFlash', true);
    expect(checkedIn(body, COPY.practice.distance.label)).toBe('Near');
    expect(pressed(body, COPY.practice.edgeFlash.label)).toBe('true');
  });

  test('destroy ends the subscriptions', () => {
    const e = env();
    const {body, handle} = render('practice', e);
    handle.destroy();
    opened.length = 0;
    expect(body.children).toHaveLength(0);
    expect(() => e.acct.remote({practice: {stop: 'stay'}})).not.toThrow();
  });
});

describe('Instruments', () => {
  test('the picker is labelled by the section heading, lists the stem mapping, and saves each change', async () => {
    const e = env();
    const {body} = render('instruments', e);
    const chips = body.querySelector('.onboarding-instruments-chips');
    expect(chips.getAttribute('aria-labelledby')).toBe('heading-instruments');
    expect(body.querySelector('.settings-intro').textContent).toBe(COPY.instruments.intro);
    find(body, 'button', 'Guitar').click();
    await flush();
    expect(e.acct.patches.at(-1)).toEqual({profile: {instruments: ['guitar'], primary: 'guitar', openWithMyPart: 'in'}});
    expect(savedIn(body)).toBe('Saved');
    expect(body.querySelector('.onboarding-instruments-mapping').hidden).toBe(false);
    expect(body.querySelector('.onboarding-instruments-mapping').textContent).toMatch(/Guitar/);
    find(body, 'button', 'Drums').click();
    find(body, 'radio', 'Start with my part out').click();
    await flush();
    expect(e.acct.patches.at(-1)).toEqual({profile: {instruments: ['guitar', 'drums'], primary: 'guitar', openWithMyPart: 'out'}});
    expect(e.account.profile.peek()).toEqual({instruments: ['guitar', 'drums'], primary: 'guitar', openWithMyPart: 'out'});
  });

  test('a failed save reverts the picker and Retry saves it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = env();
    const {body} = render('instruments', e);
    e.acct.failNext(1);
    find(body, 'button', 'Bass').click();
    await flush();
    expect(find(body, 'button', 'Bass').getAttribute('aria-pressed')).toBe('false');
    find(body, 'button', 'Retry').click();
    await flush();
    expect(e.account.profile.peek().instruments).toEqual(['bass']);
    expect(find(body, 'button', 'Bass Primary').getAttribute('aria-pressed')).toBe('true');
  });

  test('a profile chosen elsewhere (another device, /welcome) shows at once', () => {
    const e = env({settings: {profile: {instruments: ['keys'], primary: 'keys', openWithMyPart: 'in'}}});
    const {body} = render('instruments', e);
    expect(find(body, 'button', 'Keys Primary').getAttribute('aria-pressed')).toBe('true');
    e.acct.remote({profile: {instruments: ['vocals', 'keys'], primary: 'vocals', openWithMyPart: 'out'}});
    expect(find(body, 'button', 'Vocals Primary').getAttribute('aria-pressed')).toBe('true');
    expect(find(body, 'radio', 'Start with my part out').getAttribute('aria-checked')).toBe('true');
  });
});

describe('Pedals & keys (stub)', () => {
  test('View keyboard shortcuts runs app.shortcuts and shows its key', () => {
    const e = env();
    const {body} = render('pedals', e);
    const button = find(body, 'button', COPY.pedals.shortcuts);
    expect(button.getAttribute('aria-keyshortcuts')).toBe('?');
    expect(document.getElementById(button.getAttribute('aria-describedby').split(' ')[0]).textContent).toBe(COPY.pedals.hint);
    button.click();
    expect(e.runs).toEqual(['app.shortcuts']);
  });
});

describe('Appearance', () => {
  test('Theme and Stage are this device\'s prefs (Stage defaults to Always dark)', async () => {
    const e = env();
    const {body} = render('appearance', e);
    expect(checkedIn(body, 'Theme')).toBe('System');
    expect(checkedIn(body, 'Stage')).toBe('Always dark');
    expect(PREFS_DEFAULTS.stage).toBe('dark');
    find(body, 'radio', 'Dark', 'Theme').click();
    find(body, 'radio', 'Match theme', 'Stage').click();
    expect(e.prefs.writes).toEqual([['theme', 'dark'], ['stage', 'match']]);
    expect(e.acct.patches).toEqual([]);
    await flush();
    expect(savedIn(rowEl(body, 'theme'))).toBe('Saved');
    e.prefs.external('theme', 'light');
    expect(checkedIn(body, 'Theme')).toBe('Light');
  });

  test('the reduce-motion note follows the system', () => {
    const e = env({reducedMotion: true});
    const {body} = render('appearance', e);
    expect(rowText(body, 'motion')).toBe(`${COPY.appearance.motion} ${COPY.appearance.motionOn}`);
    e.platform.reducedMotion.value = false;
    expect(rowText(body, 'motion')).toBe(`${COPY.appearance.motion} ${COPY.appearance.motionOff}`);
  });
});

describe('This device', () => {
  test.each([
    [{installed: true, steps: 'none', canPrompt: false}, COPY.device.install.installed],
    [{installed: false, steps: 'ios', canPrompt: false}, COPY.device.install.ios],
    [{installed: false, steps: 'chromium', canPrompt: false}, COPY.device.install.chromium],
    [{installed: false, steps: 'chromium', canPrompt: true}, null],
    [{installed: false, steps: 'none', canPrompt: false}, COPY.device.install.none],
    [null, COPY.device.install.none],
  ])('installText(%j)', (state, text) => {
    expect(installText(state)).toBe(text);
  });

  test('Install Woodshed opens the browser prompt; a dismissal says so; installing updates the row', async () => {
    const e = env({install: {canPrompt: true, installed: false, steps: 'chromium'}});
    const {body} = render('device', e);
    find(body, 'button', COPY.device.install.button).click();
    await flush();
    expect(e.install.prompt).toHaveBeenCalledTimes(1);
    expect(rowText(body, 'install')).toContain(COPY.device.install.dismissed);
    e.install.state.value = {canPrompt: false, installed: true, steps: 'none'};
    expect(rowText(body, 'install')).toContain(COPY.device.install.installed);
    expect(exposedControls(rowEl(body, 'install'))).toHaveLength(0);
  });

  test('iPad steps: Share → Add to Home Screen', () => {
    const {body} = render('device', env({isIOS: true, install: {canPrompt: false, installed: false, steps: 'ios'}}));
    expect(rowText(body, 'install')).toContain(COPY.device.install.ios);
  });

  test('no install row in Woodshed for desktop', () => {
    const {body} = render('device', env({context: 'desktop'}));
    expect(rowEl(body, 'install')).toBeNull();
  });

  test.each([
    ['web, supported', {context: 'web', features: {wakeLock: true, mediaSession: true}}, COPY.device.wake.supported, false],
    ['web, unsupported', {context: 'web', features: {wakeLock: false, mediaSession: true}}, COPY.device.wake.unsupported, true],
    ['iPad, supported', {context: 'web', isIOS: true, features: {wakeLock: true, mediaSession: true}}, COPY.device.wake.supported, true],
    ['desktop', {context: 'desktop', features: {wakeLock: false, mediaSession: true}}, COPY.device.wake.desktop, false],
  ])('wake lock: %s', (_, options, line, tip) => {
    const {body} = render('device', env(options));
    expect(rowText(body, 'wakeLock')).toContain(line);
    expect(rowText(body, 'wakeLock').includes('Set Auto-Lock to Never while practising.')).toBe(tip);
  });

  test.each([[true, 'Supported'], [false, 'Not supported']])('media keys (mediaSession %s): %s, and no promise about headset buttons', (supported, text) => {
    const {body} = render('device', env({features: {wakeLock: true, mediaSession: supported}}));
    expect(rowText(body, 'mediaKeys')).toBe(`Media keys ${text}`);
    expect(body.textContent).not.toMatch(/headset|headphone/i);
  });

  test('Announce sections while playing is a device pref, off by default', () => {
    const e = env();
    const {body} = render('device', e);
    expect(pressed(body, COPY.device.announce.label)).toBe('false');
    find(body, 'button', COPY.device.announce.label).click();
    expect(e.prefs.writes).toEqual([['practice.announceSections', true]]);
    expect(pressed(body, COPY.device.announce.label)).toBe('true');
    expect(rowEl(body, 'announceSections').dataset.scope).toBe('device');
  });

  test('version: the web build, or the desktop app\'s from desktop.info()', async () => {
    const web = render('device', env());
    expect(rowText(web.body, 'version')).toBe(`Version Woodshed ${packageVersion} · web app`);
    expect(rowText(web.body, 'version')).not.toContain(COPY.device.updates.button);
    const e = env({context: 'desktop'});
    const {body} = render('device', e);
    await flush();
    expect(e.desktop.info).toHaveBeenCalled();
    expect(rowText(body, 'version')).toContain('Woodshed for desktop 2.0.0');
  });

  test.each([
    [{status: 'checking'}, COPY.device.updates.checking], [{status: 'available', version: '2.0.1'}, 'Update 2.0.1 is available.'],
    [{status: 'downloading', percent: 40.4}, 'Downloading update 40%'], [{status: 'ready'}, 'Update ready — Restart to install'],
    [{status: 'current'}, COPY.device.updates.current], [{status: 'error'}, COPY.device.updates.error], [{status: 'idle'}, ''], [null, ''],
  ])('updateText(%j)', (state, text) => {
    expect(updateText(state)).toBe(text);
  });

  test('Check for updates (desktop) runs the native flow and shows the state', async () => {
    const e = env({context: 'desktop', update: {status: 'downloading', percent: 40}});
    const {body} = render('device', e);
    expect(rowText(body, 'version')).toContain('Downloading update 40%');
    find(body, 'button', COPY.device.updates.button).click();
    await flush();
    expect(e.desktop.update).toHaveBeenCalledWith('show');
    expect(rowText(body, 'version')).toContain(COPY.device.updates.current);
    e.store.update.value = {status: 'ready', version: '2.0.1'};
    expect(rowText(body, 'version')).toContain('Update ready — Restart to install');
  });

  test('a licence opens in a Dialog from its ?raw import', async () => {
    const {body} = render('device');
    find(body, 'button', 'Atkinson Hyperlegible Next').click();
    const dialog = document.querySelector('dialog.ui-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('.ui-dialog-title').textContent).toBe('Atkinson Hyperlegible Next');
    const text = dialog.querySelector('.settings-license-text');
    expect(text.textContent).toBe(COPY.device.licenses.loading);
    await vi.waitFor(() => expect(text.textContent).not.toBe(COPY.device.licenses.loading));
    expect(text.textContent).toBe(readFileSync('public/licenses/atkinson-hyperlegible-next.txt', 'utf8'));
    expect(text.textContent).toContain('SIL Open Font License, Version 1.1');
    expect(text.getAttribute('tabindex')).toBe('0');
  });

  test('a licence that cannot load says so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = env();
    const {body} = render('device', {...e, licenseFiles: {'/x/licenses/broken.txt': () => Promise.reject(new Error('gone'))}});
    find(body, 'button', 'broken').click();
    await vi.waitFor(() => expect(document.querySelector('.settings-license-text').textContent).toBe(COPY.device.licenses.failed));
  });
});

describe('Account', () => {
  test('email, the Google account and Sign out; no Administration for other users', () => {
    const e = env();
    const {body} = render('account', e);
    expect(rowText(body, 'email')).toBe('Email kyle@example.com');
    expect(rowText(body, 'google')).toBe('Google account Signed in with Google as Kyle K.');
    expect(rowEl(body, 'admin').hidden).toBe(true);
    find(body, 'button', 'Sign out').click();
    expect(e.runs).toEqual(['app.signOut']);
  });

  test('administrators get the Administration link; the session is followed', () => {
    const e = env({context: 'admin'});
    const {body} = render('account', e);
    find(body, 'button', 'Administration').click();
    expect(e.runs).toEqual(['nav.admin']);
    e.store.session.value = {user: {id: 'u1', name: '', email: 'k@x.io'}, admin: false};
    expect(rowEl(body, 'admin').hidden).toBe(true);
    expect(rowText(body, 'email')).toBe('Email k@x.io');
    expect(rowText(body, 'google')).toBe('Google account Signed in with Google');
  });
});

describe('through the frame', () => {
  test('/settings/practice on the real section modules', async () => {
    const e = env();
    window.happyDOM.setViewport({width: 1440, height: 900});
    const view = await mount(host, {name: 'settingsPage', path: '/settings/practice', params: {section: 'practice'}, query: {}, state: null},
      {router: {navigate: vi.fn(), back: vi.fn()}, ...e});
    await flush();
    expect(host.querySelector('.settings-content h2').textContent).toBe('Practice');
    expect(findGroup(host, COPY.practice.stop.label)).toBeTruthy();
    await view.update({name: 'settingsPage', path: '/settings/instruments', params: {section: 'instruments'}, query: {}, state: null});
    await flush();
    const heading = host.querySelector('.settings-content h2');
    expect(host.querySelector('.onboarding-instruments-chips').getAttribute('aria-labelledby')).toBe(heading.id);
    view.unmount();
  });
});
