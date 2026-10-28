// Account settings (architecture §2.4): the live settings.config subscription,
// optimistic settings.patch, and the profile, pins and onboarding accessors.
//
//   account.value     withDefaults(settings) with every in-flight patch applied (read-only)
//   account.patch(p)  applies p at once; settings.patch merges it on the server; a failure
//                     reverts exactly that patch and throws the ApiError
//   startAccount()    boot step 5 (§2.3.1): subscribe settings.config → store.config and
//                     store.account; once the first config arrives, apply the prefs
//                     migration's account carry-over (store.pendingAccount, §2.5), which is
//                     cleared only when its patch succeeds (a failure keeps it for next boot)
//
// Defaults and the merge rule come from convex/lib/presets.ts, so the optimistic value is
// exactly what the server will store.

import {batch, computed, signal, store as appStore} from './store.js';
import {ApiError, toApiError} from '../api/client.js';
import * as settingsApi from '../api/settings.js';
import {MAX_PINS, STOP_MODES, mergeSettings, withDefaults} from '../../convex/lib/presets.ts';

export const PINS_FULL = `Up to ${MAX_PINS} pins`;
export const ONBOARDING_KEYS = Object.freeze(['whatDoYouPlay', 'coach', 'desktopFirstRun']);

// feedback.js arrives in wave 1a (S2); resolving it by glob keeps this module buildable before then.
const FEEDBACK = import.meta.glob('./feedback.js');

async function feedbackToast(message, options) {
  const load = FEEDBACK['./feedback.js'];
  if (!load) return;
  try { (await load()).toast(message, options); } catch (err) { console.error(err); }
}

const json = value => JSON.stringify(value ?? null);
const sameJson = (a, b) => json(a) === json(b);
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const isPlain = value => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The part of a prefs carry-over (`{practice: {stop?, keepPitch?}}`, prefs.js migrateLegacy)
 * that settings.patch accepts, or null when nothing valid is left.
 */
export function pendingPatch(pending) {
  const practice = isPlain(pending) && isPlain(pending.practice) ? pending.practice : {};
  const out = {};
  if (STOP_MODES.includes(practice.stop)) out.stop = practice.stop;
  if (typeof practice.keepPitch === 'boolean') out.keepPitch = practice.keepPitch;
  return Object.keys(out).length ? {practice: out} : null;
}

/**
 * Builds an account controller over a store ({config, account, pendingAccount} signals) and a
 * settings API ({subscribeConfig, patch}). `toast(message, options)` shows the pins-full notice.
 * The app uses the `account` singleton; tests build their own.
 */
export function createAccount({store = appStore, api = settingsApi, toast = feedbackToast} = {}) {
  // Patches applied on top of the server's settings, in the order they were made. An entry
  // leaves when its mutation fails (revert), or once the server's settings reflect it.
  const overlays = signal([]);

  const value = computed(
    () => overlays.value.reduce((acc, entry) => mergeSettings(acc, entry.patch), withDefaults(store.account.value)),
    {equals: sameJson},
  );
  const profile = computed(() => value.value.profile, {equals: sameJson});
  const pins = computed(() => value.value.pins, {equals: sameJson});
  const onboarding = computed(() => value.value.onboarding, {equals: sameJson});
  const loaded = computed(() => store.account.value != null);

  const remove = entry => { overlays.value = overlays.peek().filter(e => e !== entry); };
  const reflects = (settings, change) => {
    const base = withDefaults(settings);
    return sameJson(mergeSettings(base, change), base);
  };

  // A confirmed patch whose result the subscription has not delivered yet (the fixture, or a
  // slow socket) stays until the next server value, so the UI never flickers back.
  store.account.subscribe(() => {
    if (overlays.peek().some(e => e.settled)) overlays.value = overlays.peek().filter(e => !e.settled);
  });

  async function patch(partial) {
    if (!isPlain(partial)) throw new TypeError('account.patch expects an object');
    const entry = {patch: clone(partial), settled: false};
    overlays.value = [...overlays.peek(), entry];
    try {
      await api.patch(partial);
    } catch (err) {
      remove(entry);
      throw toApiError(err);
    }
    entry.settled = true;
    if (reflects(store.account.peek(), entry.patch)) remove(entry);
  }

  async function togglePin(songId) {
    if (typeof songId !== 'string' || !songId) throw new TypeError('togglePin expects a song id');
    const current = pins.peek();
    const pinned = current.includes(songId);
    if (!pinned && current.length >= MAX_PINS) {
      toast(PINS_FULL, {key: 'pins-full'});
      return;
    }
    try {
      await patch({pins: pinned ? current.filter(id => id !== songId) : [...current, songId]});
    } catch (err) {
      // Another device filled the last slot first.
      if (err instanceof ApiError && err.code === 'pins_full') { toast(PINS_FULL, {key: 'pins-full'}); return; }
      throw err;
    }
  }

  function markOnboarding(key, flag) {
    if (!ONBOARDING_KEYS.includes(key)) return Promise.reject(new TypeError(`Unknown onboarding key: ${key}`));
    return patch({onboarding: {[key]: flag}});
  }

  /** Applies store.pendingAccount through patch; clears it only on success. Resolves to true when applied. */
  async function applyPendingAccount() {
    const pending = store.pendingAccount.peek();
    if (pending == null) return false;
    const change = pendingPatch(pending);
    if (!change) { store.pendingAccount.value = null; return false; }   // nothing the account can take
    try {
      await patch(change);
    } catch (err) {
      console.warn('[account] the device settings carry-over will be retried next time:', err?.message ?? err);
      return false;
    }
    if (sameJson(store.pendingAccount.peek(), pending)) store.pendingAccount.value = null;
    return true;
  }

  /** Boot step 5. Returns off(), which ends the subscription. */
  function start({onError} = {}) {
    let first = true;
    return api.subscribeConfig(config => {
      if (!isPlain(config)) return;
      const {settings = null, ...catalogue} = config;
      batch(() => {
        store.config.value = catalogue;
        store.account.value = settings;
      });
      if (first) {
        first = false;
        applyPendingAccount();
      }
    }, err => (onError ? onError(err) : console.error('[account] settings.config failed:', err)));
  }

  return Object.freeze({value, profile, pins, onboarding, loaded, patch, togglePin, markOnboarding, applyPendingAccount, start});
}

export const account = createAccount();

/** Boot step 5 (§2.3.1) for the app's account. Returns off(). */
export const startAccount = options => account.start(options);
