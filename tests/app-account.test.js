// Account settings client (architecture §2.4, BK4): src/api/settings.js, src/app/account.js
// and the fixture's settings handlers (tests/fixture/db/settings.js).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

vi.hoisted(() => {
  globalThis.__FX_DB_MANUAL_BOOT__ = true;
  // prefs.js (behind store.pendingAccount) reads ws.prefs from localStorage.
  const map = new Map();
  globalThis.localStorage = {
    getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); }, clear: () => map.clear(), key: i => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
});

const fake = vi.hoisted(() => ({auth: null}));
// src/app/auth.js arrives with AU1 (wave 0B); Vitest matches the mock by the importer's raw specifier until then.
vi.mock('../src/app/auth.js', () => ({client: () => fake.auth}));
vi.mock('../app/auth.js', () => ({client: () => fake.auth}));

import {ConvexError} from 'convex/values';
import {signal, effect} from '../src/app/store.js';
import {ApiError} from '../src/api/client.js';
import * as settingsApi from '../src/api/settings.js';
import {ONBOARDING_KEYS, PINS_FULL, account, createAccount, pendingPatch, startAccount} from '../src/app/account.js';
import {INSTRUMENTS as PROFILE_INSTRUMENTS} from '../src/app/profile.js';
import {DEFAULT_SETTINGS, INSTRUMENTS, MAX_PINS, withDefaults} from '../convex/lib/presets.ts';

const dbIndex = await import('./fixture/db/index.js');
const {DEMO_TOKEN} = await import('./fixture/db/seed.js');
const runtime = await import('./fixture/db/runtime.js');

const CATALOGUE = {presets: {balanced: {id: 'balanced'}}, defaultPreset: 'balanced', models: [], stemModes: {}, bitrates: []};

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

/** A settings API whose config subscription and patch calls the test drives by hand. */
function fakeApi() {
  const api = {
    push: null, error: null, calls: [], pending: [],
    subscribeConfig: vi.fn((onValue, onError) => { api.push = onValue; api.error = onError; return api.off; }),
    off: vi.fn(),
    patch: vi.fn(change => { const d = deferred(); api.calls.push(change); api.pending.push(d); return d.promise; }),
    /** Settle the oldest outstanding patch. */
    resolve(value = null) { api.pending.shift().resolve(value); return flush(); },
    reject(err) { api.pending.shift().reject(err); return flush(); },
  };
  return api;
}

function fakeStore({pending = null} = {}) {
  return {config: signal(null), account: signal(null), pendingAccount: signal(pending)};
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const coded = (code, message = 'x') => new ConvexError({code, message});

describe('src/api/settings.js', () => {
  beforeEach(() => {
    fake.auth = {query: vi.fn(async () => 'q'), mutation: vi.fn(async () => 'm'), action: vi.fn(), onUpdate: vi.fn(() => vi.fn())};
  });

  test('config, subscribeConfig, patch and demo call settings:* on the authenticated client', async () => {
    expect(await settingsApi.config()).toBe('q');
    expect(fake.auth.query).toHaveBeenLastCalledWith('settings:config', {});
    expect(await settingsApi.demo()).toBe('q');
    expect(fake.auth.query).toHaveBeenLastCalledWith('settings:demo', {});
    expect(await settingsApi.patch({autoBeats: false})).toBe('m');
    expect(fake.auth.mutation).toHaveBeenLastCalledWith('settings:patch', {patch: {autoBeats: false}});
    const onValue = vi.fn();
    const off = settingsApi.subscribeConfig(onValue);
    expect(fake.auth.onUpdate).toHaveBeenCalledWith('settings:config', {}, onValue, undefined);
    expect(typeof off).toBe('function');
  });

  test('a coded failure comes out as an ApiError', async () => {
    fake.auth.mutation.mockRejectedValueOnce(coded('pins_full', 'Up to 12 pins'));
    const err = await settingsApi.patch({pins: []}).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('pins_full');
  });
});

describe('account.value and the config subscription', () => {
  test('the defaults until the first config; then store.config holds the catalogue and store.account the settings', () => {
    const store = fakeStore(), api = fakeApi();
    const acc = createAccount({store, api, toast: vi.fn()});
    expect(acc.value.value).toEqual(withDefaults(null));
    expect(acc.loaded.value).toBe(false);
    const off = acc.start();
    expect(api.subscribeConfig).toHaveBeenCalledTimes(1);
    api.push({settings: {...withDefaults(null), autoBeats: false, pins: ['s1']}, ...CATALOGUE});
    expect(store.config.value).toEqual(CATALOGUE);
    expect(store.account.value.autoBeats).toBe(false);
    expect(acc.loaded.value).toBe(true);
    expect(acc.value.value.autoBeats).toBe(false);
    expect(acc.pins.value).toEqual(['s1']);
    expect(acc.profile.value).toEqual(DEFAULT_SETTINGS.profile);
    expect(off).toBe(api.off);
  });

  test('value is read-only, and accessors notify only on a real change', () => {
    const store = fakeStore(), api = fakeApi();
    const acc = createAccount({store, api, toast: vi.fn()});
    expect(() => { acc.value.value = {}; }).toThrow(TypeError);
    const seen = [];
    const dispose = effect(() => { seen.push(acc.profile.value.instruments.join(',')); });
    acc.start();
    api.push({settings: withDefaults(null), ...CATALOGUE});
    api.push({settings: {...withDefaults(null), autoBeats: false}, ...CATALOGUE});   // profile unchanged
    api.push({settings: {...withDefaults(null), profile: {instruments: ['bass'], primary: 'bass', openWithMyPart: 'in'}}, ...CATALOGUE});
    dispose();
    expect(seen).toEqual(['', 'bass']);
  });

  test('a subscription error goes to onError', () => {
    const store = fakeStore(), api = fakeApi();
    const acc = createAccount({store, api, toast: vi.fn()});
    const onError = vi.fn();
    acc.start({onError});
    api.error(new ApiError({code: 'account_suspended'}));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({code: 'account_suspended'}));
  });
});

describe('account.patch: optimistic, merged, reverted on error', () => {
  let store, api, acc;
  beforeEach(() => {
    store = fakeStore(); api = fakeApi();
    acc = createAccount({store, api, toast: vi.fn()});
    acc.start();
    api.push({settings: withDefaults(null), ...CATALOGUE});
  });

  test('applies at once with the server’s deep merge, sends only the partial, and keeps the value when confirmed', async () => {
    const done = acc.patch({practice: {stop: 'stay'}});
    expect(api.calls).toEqual([{practice: {stop: 'stay'}}]);
    expect(acc.value.value.practice).toEqual({...DEFAULT_SETTINGS.practice, stop: 'stay'});
    await api.resolve();
    await done;
    // Confirmed but not yet delivered by the subscription: still shown, no flicker back.
    expect(acc.value.value.practice.stop).toBe('stay');
    api.push({settings: {...withDefaults(null), practice: {...DEFAULT_SETTINGS.practice, stop: 'stay'}}, ...CATALOGUE});
    expect(acc.value.value.practice.stop).toBe('stay');
    // The overlay is gone: a later change from another device shows through.
    api.push({settings: {...withDefaults(null), practice: {...DEFAULT_SETTINGS.practice, stop: 'cue'}}, ...CATALOGUE});
    expect(acc.value.value.practice.stop).toBe('cue');
  });

  test('a confirmed patch the subscription already delivered leaves no overlay behind', async () => {
    const done = acc.patch({autoBeats: false});
    api.push({settings: {...withDefaults(null), autoBeats: false}, ...CATALOGUE});
    await api.resolve();
    await done;
    api.push({settings: {...withDefaults(null), autoBeats: true}, ...CATALOGUE});
    expect(acc.value.value.autoBeats).toBe(true);
  });

  test('a failure reverts exactly that patch and throws the ApiError', async () => {
    const first = acc.patch({autoBeats: false}).catch(e => e);
    const second = acc.patch({notifyReady: false});
    expect(acc.value.value).toMatchObject({autoBeats: false, notifyReady: false});
    await api.reject(coded('invalid', 'Choose a bitrate.'));
    const err = await first;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('invalid');
    expect(acc.value.value).toMatchObject({autoBeats: true, notifyReady: false});
    await api.resolve();
    await second;
    expect(acc.value.value.notifyReady).toBe(false);
  });

  test('a network failure reverts too and still throws an ApiError', async () => {
    const done = acc.patch({profile: {instruments: ['keys'], primary: 'keys', openWithMyPart: 'out'}}).catch(e => e);
    expect(acc.profile.value.instruments).toEqual(['keys']);
    await api.reject(new Error('Connection lost'));
    const err = await done;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('unknown');
    expect(acc.profile.value).toEqual(DEFAULT_SETTINGS.profile);
  });

  test('later patches see earlier ones, so the in-flight order wins', async () => {
    acc.patch({practice: {countIn: {on: true, length: 2, unit: 'bars'}}});
    acc.patch({practice: {wake: 30}});
    expect(acc.value.value.practice).toMatchObject({countIn: {on: true, length: 2, unit: 'bars'}, wake: 30, stop: 'cue'});
    await api.resolve(); await api.resolve();
  });

  test('rejects anything but an object', async () => {
    await expect(acc.patch(null)).rejects.toThrow(TypeError);
    expect(api.calls).toEqual([]);
  });
});

describe('togglePin and markOnboarding', () => {
  let store, api, acc, toast;
  const withPins = pins => api.push({settings: {...withDefaults(null), pins}, ...CATALOGUE});
  beforeEach(() => {
    store = fakeStore(); api = fakeApi(); toast = vi.fn();
    acc = createAccount({store, api, toast});
    acc.start();
  });

  test('pins and unpins by patching the whole list', async () => {
    withPins(['a', 'b']);
    const add = acc.togglePin('c');
    expect(api.calls.at(-1)).toEqual({pins: ['a', 'b', 'c']});
    expect(acc.pins.value).toEqual(['a', 'b', 'c']);
    await api.resolve(); await add;
    const remove = acc.togglePin('a');
    expect(api.calls.at(-1)).toEqual({pins: ['b', 'c']});
    await api.resolve(); await remove;
    expect(acc.pins.value).toEqual(['b', 'c']);
  });

  test(`a ${MAX_PINS + 1}th pin toasts "${PINS_FULL}" and sends nothing; unpinning still works when full`, async () => {
    const full = Array.from({length: MAX_PINS}, (_, i) => `s${i}`);
    withPins(full);
    await acc.togglePin('extra');
    expect(PINS_FULL).toBe('Up to 12 pins');
    expect(toast).toHaveBeenCalledWith('Up to 12 pins', {key: 'pins-full'});
    expect(api.calls).toEqual([]);
    expect(acc.pins.value).toEqual(full);
    const unpin = acc.togglePin('s3');
    expect(api.calls).toEqual([{pins: full.filter(id => id !== 's3')}]);
    await api.resolve(); await unpin;
  });

  test('the server’s pins_full (another device filled the last slot) also toasts; other errors throw', async () => {
    withPins(['a']);
    const first = acc.togglePin('b');
    await api.reject(coded('pins_full', 'Up to 12 pins'));
    await first;
    expect(toast).toHaveBeenCalledWith(PINS_FULL, {key: 'pins-full'});
    expect(acc.pins.value).toEqual(['a']);
    const second = acc.togglePin('c').catch(e => e);
    await api.reject(coded('not_owner', 'You can pin only your own songs.'));
    expect(await second).toMatchObject({code: 'not_owner'});
    await expect(acc.togglePin('')).rejects.toThrow(TypeError);
  });

  test('a deleted song the server drops from pins leaves no ghost pin, with or without a push', async () => {
    withPins(['a']);
    // Server stores nothing new (the row already says ['a']), so the subscription stays silent.
    const quiet = acc.togglePin('gone');
    expect(acc.pins.value).toEqual(['a', 'gone']);
    await api.resolve(withDefaults({pins: ['a']})); await quiet;
    expect(acc.pins.value).toEqual(['a']);
    expect(acc.value.value.pins).toEqual(['a']);
    // Convex delivers the (normalised) query value before the mutation resolves.
    const pushed = acc.togglePin('gone-too');
    withPins(['a']);
    await api.resolve(withDefaults({pins: ['a']})); await pushed;
    expect(acc.pins.value).toEqual(['a']);
    // The next pin builds on the server's list, not the ghost.
    const next = acc.togglePin('b');
    expect(api.calls.at(-1)).toEqual({pins: ['a', 'b']});
    await api.resolve(withDefaults({pins: ['a', 'b']})); await next;
  });

  test('a confirmed patch takes the server’s normalised values, and a newer push still shows through', async () => {
    const done = acc.patch({profile: {instruments: ['bass', 'bass'], primary: 'drums', openWithMyPart: 'in'}});
    await api.resolve(withDefaults({profile: {instruments: ['bass'], primary: 'bass', openWithMyPart: 'in'}})); await done;
    // Not delivered yet: the overlay holds what the server stored, not what was sent.
    expect(acc.profile.value).toEqual({instruments: ['bass'], primary: 'bass', openWithMyPart: 'in'});
    api.push({settings: {...withDefaults(null), profile: {instruments: ['keys'], primary: 'keys', openWithMyPart: 'out'}}, ...CATALOGUE});
    expect(acc.profile.value).toEqual({instruments: ['keys'], primary: 'keys', openWithMyPart: 'out'});
  });

  test('a commit delivered mid-flight then overtaken by another device does not mask the newer value', async () => {
    withPins([]);
    const done = acc.togglePin('a');
    withPins(['a']);          // this patch's commit
    withPins(['a', 'z']);     // another device, before the mutation resolves
    await api.resolve(withDefaults({pins: ['a']})); await done;
    expect(acc.pins.value).toEqual(['a', 'z']);
  });

  test('markOnboarding patches one onboarding key', async () => {
    expect(ONBOARDING_KEYS).toEqual(['whatDoYouPlay', 'coach', 'desktopFirstRun']);
    const done = acc.markOnboarding('coach', 5);
    expect(api.calls.at(-1)).toEqual({onboarding: {coach: 5}});
    expect(acc.onboarding.value).toEqual({coach: 5});
    await api.resolve(); await done;
    acc.markOnboarding('whatDoYouPlay', 'skipped');
    expect(acc.value.value.onboarding).toEqual({coach: 5, whatDoYouPlay: 'skipped'});
    await api.resolve();
    await expect(acc.markOnboarding('tour', true)).rejects.toThrow(TypeError);
  });
});

describe('pendingAccount (the prefs migration’s account carry-over, §2.5)', () => {
  test('applied once, after the first config, and cleared on success', async () => {
    const pending = {practice: {stop: 'stay', keepPitch: false}};
    const store = fakeStore({pending}), api = fakeApi();
    const acc = createAccount({store, api, toast: vi.fn()});
    acc.start();
    expect(api.patch).not.toHaveBeenCalled();
    api.push({settings: withDefaults(null), ...CATALOGUE});
    expect(api.calls).toEqual([pending]);
    expect(acc.value.value.practice).toMatchObject({stop: 'stay', keepPitch: false});
    api.push({settings: withDefaults(null), ...CATALOGUE});   // a second config does not apply it again
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(store.pendingAccount.value).toEqual(pending);       // not before success
    await api.resolve();
    expect(store.pendingAccount.value).toBeNull();
  });

  test('a failed patch keeps it, and the next boot applies it', async () => {
    const pending = {practice: {stop: 'stay'}};
    const store = fakeStore({pending});
    const api1 = fakeApi();
    createAccount({store, api: api1, toast: vi.fn()}).start();
    api1.push({settings: withDefaults(null), ...CATALOGUE});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await api1.reject(new Error('offline'));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(store.pendingAccount.value).toEqual(pending);
    // Next boot.
    const store2 = {...fakeStore(), pendingAccount: store.pendingAccount};
    const api2 = fakeApi();
    createAccount({store: store2, api: api2, toast: vi.fn()}).start();
    api2.push({settings: withDefaults(null), ...CATALOGUE});
    expect(api2.calls).toEqual([pending]);
    await api2.resolve();
    expect(store2.pendingAccount.value).toBeNull();
  });

  test('nothing pending → no patch; nothing valid → cleared without a patch', async () => {
    const api = fakeApi();
    createAccount({store: fakeStore(), api, toast: vi.fn()}).start();
    api.push({settings: withDefaults(null), ...CATALOGUE});
    expect(api.patch).not.toHaveBeenCalled();
    const store = fakeStore({pending: {practice: {stop: 'return', keepPitch: 'no'}, theme: 'dark'}});
    const api2 = fakeApi();
    createAccount({store, api: api2, toast: vi.fn()}).start();
    api2.push({settings: withDefaults(null), ...CATALOGUE});
    expect(api2.patch).not.toHaveBeenCalled();
    expect(store.pendingAccount.value).toBeNull();
    expect(pendingPatch({practice: {stop: 'cue', keepPitch: true, wake: 5}})).toEqual({practice: {stop: 'cue', keepPitch: true}});
    expect(pendingPatch(null)).toBeNull();
  });

  test('the app singleton applies ws.prefs’ carry-over through settings:patch and clears it in ws.prefs', async () => {
    localStorage.clear();
    localStorage.setItem('ws.stopBehavior', 'stay');
    localStorage.setItem('ws.preservePitch', '0');
    let push = null;
    fake.auth = {
      query: vi.fn(), action: vi.fn(),
      mutation: vi.fn(async (name, {patch}) => ({...withDefaults(null), ...patch})),
      onUpdate: vi.fn((name, args, onValue) => { push = onValue; return () => {}; }),
    };
    const off = startAccount();
    expect(fake.auth.onUpdate).toHaveBeenCalledWith('settings:config', {}, expect.any(Function), expect.any(Function));
    push({settings: withDefaults(null), ...CATALOGUE});
    expect(fake.auth.mutation).toHaveBeenCalledWith('settings:patch', {patch: {practice: {stop: 'stay', keepPitch: false}}});
    await flush(); await flush();
    expect(JSON.parse(localStorage.getItem('ws.prefs')).pendingAccount).toBeNull();
    expect(account.value.value.practice).toMatchObject({stop: 'stay', keepPitch: false});
    off();
  });
});

test('the server’s instrument list is the profile’s', () => {
  expect([...INSTRUMENTS]).toEqual([...PROFILE_INSTRUMENTS]);
});

describe('fixture settings handlers (tests/fixture/db/settings.js)', () => {
  class MemoryStorage {
    constructor() { this.map = new Map(); }
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
    setItem(k, v) { this.map.set(k, String(v)); }
    removeItem(k) { this.map.delete(k); }
  }
  const NOW = Date.parse('2026-10-28T09:00:00Z');
  const call = dbIndex.call;
  beforeEach(() => { dbIndex.boot({search: '', store: new MemoryStorage(), now: NOW}); });
  afterEach(() => { dbIndex.stopJobCreep(); });

  test('save is gone; patch merges like the server and validates with its rules', async () => {
    expect(dbIndex.handlers['settings:save']).toBeUndefined();
    const merged = await call('mutation', 'settings:patch', {patch: {practice: {wake: 30}, onboarding: {coach: 3}}});
    expect(merged.practice).toMatchObject({wake: 30, stop: 'cue', countIn: {on: false, length: 1, unit: 'bars'}});
    expect(merged.onboarding).toEqual({whatDoYouPlay: 'done', coach: 3, desktopFirstRun: true});
    expect(merged).not.toHaveProperty('format');
    expect((await call('query', 'settings:config', {})).settings.practice.wake).toBe(30);
    await expect(call('mutation', 'settings:patch', {patch: {practice: {click: 'sometimes'}}})).rejects.toMatchObject({data: {code: 'invalid', field: 'practice.click'}});
    await expect(call('mutation', 'settings:patch', {patch: {pins: Array.from({length: 13}, (_, i) => `x${i}`)}})).rejects.toMatchObject({data: {code: 'pins_full'}});
    expect((await call('mutation', 'settings:patch', {patch: {pins: ['glasshouse', 'nope', 'glasshouse', 'lowtide']}})).pins).toEqual(['glasshouse', 'lowtide']);
  });

  test('fx-account=new starts from the defaults and patch creates the row', async () => {
    dbIndex.boot({search: '?fx-account=new', store: new MemoryStorage(), now: NOW});
    expect(runtime.db.settings).toBeNull();
    await call('mutation', 'settings:patch', {patch: {profile: {instruments: ['guitar'], primary: 'guitar', openWithMyPart: 'out'}, onboarding: {whatDoYouPlay: 'done'}}});
    expect(runtime.db.settings.profile).toEqual({instruments: ['guitar'], primary: 'guitar', openWithMyPart: 'out'});
    expect(runtime.db.settings.practice).toEqual(DEFAULT_SETTINGS.practice);
  });

  test('demo serves db.demoToken when it is 64 hex characters', async () => {
    expect(await call('query', 'settings:demo', {})).toEqual({token: DEMO_TOKEN});
    runtime.db.demoToken = 'not-a-token';
    expect(await call('query', 'settings:demo', {})).toBeNull();
    runtime.db.demoToken = null;
    expect(await call('query', 'settings:demo', {})).toBeNull();
  });

  test('the account client over the fixture: optimistic, then confirmed by the lagging subscription', async () => {
    const store = fakeStore();
    const acc = createAccount({
      store, toast: vi.fn(),
      api: {
        subscribeConfig: (onValue, onError) => dbIndex.subscribe('settings:config', {}, onValue, onError),
        patch: change => call('mutation', 'settings:patch', {patch: change}),
      },
    });
    const off = acc.start();
    await vi.waitFor(() => expect(acc.loaded.value).toBe(true));
    expect(acc.pins.value).toEqual(['glasshouse', 'lowtide', 'nightbus']);
    const seen = [];
    const dispose = effect(() => { seen.push(acc.pins.value.length); });
    await acc.togglePin('quiet');
    await vi.waitFor(() => expect(store.account.value.pins).toContain('quiet'));
    expect(acc.pins.value).toEqual(['glasshouse', 'lowtide', 'nightbus', 'quiet']);
    expect(seen).toEqual([3, 4]);   // never flickered back to 3
    await expect(acc.patch({stemMode: 'four'})).rejects.toMatchObject({code: 'invalid'});
    expect(acc.value.value.stemMode).toBe('full');
    dispose(); off();
  });
});
