// The one network seam for the new app (architecture §2.1). Every wrapper in
// src/api/*.js is a one-line call through these functions; every failure comes
// out as an ApiError whose `code` is the ConvexError data.code (§6.1), else
// 'unknown'. User-facing copy comes only from src/app/error-copy.js.
//
// Function names are 'module:function' strings ('songs:get'), which the Convex
// client accepts directly.

import {ConvexClient} from 'convex/browser';
import {client as authClient} from '../app/auth.js';

export class ApiError extends Error {
  /**
   * @param {{code?: string, message?: string, data?: object, raw?: unknown}} init
   */
  constructor({code = 'unknown', message = 'Something went wrong.', data = {}, raw = null} = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.data = data;
    this.raw = raw;
  }
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isConvexError = err => !!err && typeof err === 'object' && (err.name === 'ConvexError' || 'data' in err);

/** Normalises anything thrown by Convex (or the network) into an ApiError. Idempotent. */
export function toApiError(err) {
  if (err instanceof ApiError) return err;
  if (isConvexError(err)) {
    const data = err.data;
    if (isObject(data)) {
      return new ApiError({
        code: typeof data.code === 'string' && data.code ? data.code : 'unknown',
        message: typeof data.message === 'string' && data.message ? data.message : String(err.message || 'Something went wrong.'),
        data: {...data},
        raw: err,
      });
    }
    if (typeof data === 'string') return new ApiError({message: data, raw: err});
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Something went wrong.';
  return new ApiError({message: message || 'Something went wrong.', raw: err});
}

function authenticated() {
  const c = authClient();
  if (!c) throw new ApiError({code: 'not_signed_in', message: 'Not signed in.'});
  return c;
}

async function call(kind, name, args) {
  let c;
  try { c = authenticated(); } catch (err) { throw toApiError(err); }
  try {
    return await c[kind](name, args ?? {});
  } catch (err) {
    throw toApiError(err);
  }
}

/** Runs a query once on the authenticated client. */
export function query(name, args = {}) { return call('query', name, args); }

/** Runs a mutation on the authenticated client. */
export function mutation(name, args = {}) { return call('mutation', name, args); }

/** Runs an action on the authenticated client. */
export function action(name, args = {}) { return call('action', name, args); }

function subscribeOn(c, name, args, onValue, onError) {
  const unsubscribe = c.onUpdate(name, args ?? {}, onValue, onError ? err => onError(toApiError(err)) : undefined);
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    unsubscribe();
  };
}

/** Subscribes to a query (convex.onUpdate). Returns off(); calling it twice is harmless. */
export function subscribe(name, args, onValue, onError) {
  return subscribeOn(authenticated(), name, args, onValue, onError);
}

let shared = null;

/** The unauthenticated client for the Shared Stage: one per page until close(). */
export function publicClient() {
  if (shared) return shared.api;
  const url = import.meta.env?.VITE_CONVEX_URL;
  if (!url) throw new ApiError({code: 'unknown', message: 'The Woodshed backend is not configured (VITE_CONVEX_URL).'});
  const c = new ConvexClient(url);
  const api = Object.freeze({
    async query(name, args = {}) {
      try { return await c.query(name, args ?? {}); } catch (err) { throw toApiError(err); }
    },
    /** Runs an action with no account (`shareAudio:playback` for /share/:token visitors, §2.18). */
    async action(name, args = {}) {
      try { return await c.action(name, args ?? {}); } catch (err) { throw toApiError(err); }
    },
    subscribe(name, args, onValue, onError) { return subscribeOn(c, name, args, onValue, onError); },
    async close() {
      if (shared?.client === c) shared = null;
      await c.close();
    },
  });
  shared = {client: c, api};
  return api;
}
