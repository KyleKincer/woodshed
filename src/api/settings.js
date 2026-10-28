// Account settings and the preset catalogue (convex/settings.ts, architecture §6.5).
// One-line wrappers over src/api/client.js; every failure is an ApiError.

import {mutation, query, subscribe} from './client.js';

/** {settings, presets, defaultPreset, models, stemModes, bitrates}, once. */
export const config = () => query('settings:config');

/** Live settings.config; returns off(). */
export const subscribeConfig = (onValue, onError) => subscribe('settings:config', {}, onValue, onError);

/** Merges a partial change into the account settings on the server; resolves to the merged settings. */
export const patch = change => mutation('settings:patch', {patch: change});

/** The demo song's share token, {token} or null (B8, D7). */
export const demo = () => query('settings:demo');
