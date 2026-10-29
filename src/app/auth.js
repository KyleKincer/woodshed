// Auth core (architecture §2.23). Ported from src/js/auth.js without any rendering:
// main.js (S1) decides what to show, ON1 renders the sign-in card, startup.js owns
// the #startup status. This module never touches the document.
//
//   const {user, status} = await initialize();          // throws AuthError
//   const {user} = await initialize({optional: true});  // Shared Stage: never throws
//   client()      the authenticated ConvexClient (src/api/client.js), null when signed out
//   signIn()      starts Google OAuth (the page navigates away); desktop stashes the route
//   signOut()     flushes the active session, then ends the Convex Auth session (never throws)
//   onChange(fn)  ({user, status}) after any change: sign-in, sign-out (here or in
//                 another tab), a lost session, a live users.me update (status, name…)
//   user()        the signed-in User, or null
//
// Errors are AuthError {kind, message, code?}:
//   'config'   VITE_CONVEX_URL is missing, or an unknown provider was asked for
//   'network'  the session or the account could not be loaded, or the backend did not
//              answer in time (code 'timeout'): the fatal boot card with Retry
//   'oauth'    a sign-in problem the sign-in card shows: the OAuth flow error codes
//              (access_denied, expired, invalid_flow, oauth_error, rejected), plus
//              'unverified' (the backend refused the stored session) and
//              'start_failed' (Google sign-in could not be started)
//
// Signed out is not an error: initialize() resolves {user: null, status: null}. In
// required mode a pending OAuth flow error (or an unverified session) is thrown as
// AuthError{kind: 'oauth'} so the sign-in card can show it; optional mode resolves
// {user: null, status: null, error} instead and never throws.

import {AuthClient, defaultStorage} from '@convex-dev/auth/browser';
// Alpha.1 exposes its framework-neutral OAuth setup through this entry point; only
// oauth() is used.
import {oauth} from '@convex-dev/auth/providers/oauth/react';
import {ConvexClient, ConvexHttpClient} from 'convex/browser';
import {ConvexError} from 'convex/values';
import {api} from '../../convex/_generated/api';
import {stashIntendedRoute} from './router.js';

// The session module is wave 1a; resolving it by glob keeps a missing file harmless (D2).
const SESSION_MODULES = import.meta.glob('../stage/session.js');

/** The OAuth parameters the auth library appends to the callback redirect. */
export const OAUTH_PARAMS = ['convexAuthCode', 'convexAuthError'];

/** Sign-in copy, keyed by today's OAuth flow error codes (src/js/auth.js), plus our own. */
export const OAUTH_MESSAGES = Object.freeze({
  access_denied: 'Sign-in was canceled. You can try again.',
  expired: 'This sign-in link expired. Please sign in again.',
  invalid_flow: 'Sign-in must finish in the same browser where it started. Please try again here.',
  oauth_error: 'Google sign-in could not finish. Please try again.',
  unverified: 'Your session could not be verified. Sign in again.',
  start_failed: 'Could not start Google sign-in. Check your connection and try again.',
  fallback: 'Sign-in could not finish. Please try again.',
});

const MESSAGES = Object.freeze({
  config: 'Set VITE_CONVEX_URL in .env.local and restart the website.',
  provider: 'That sign-in provider is not available.',
  network: 'Woodshed could not reach its server. Check your connection and try again.',
  account: 'Your account could not be loaded.',
});

const PROVIDERS = Object.freeze({
  google: {providerName: 'google', startSignIn: api.auth.startSignInGoogle, completeSignIn: api.auth.completeSignInGoogle},
});

export class AuthError extends Error {
  /** @param {{kind: 'config'|'network'|'oauth', message?: string, code?: string, cause?: unknown}} init */
  constructor({kind, message, code, cause} = {}) {
    super(message || MESSAGES.network);
    this.name = 'AuthError';
    this.kind = kind;
    if (code !== undefined) this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Maps an OAuth flow error ({code, message?}) to AuthError{kind: 'oauth'} with today's copy. */
export function oauthError(flowError) {
  const code = typeof flowError?.code === 'string' && flowError.code ? flowError.code : 'oauth_error';
  const own = typeof flowError?.message === 'string' && flowError.message ? flowError.message : '';
  return new AuthError({kind: 'oauth', code, message: own || OAUTH_MESSAGES[code] || OAUTH_MESSAGES.fallback});
}

const asNetwork = (err, message = MESSAGES.network, code = 'network') =>
  err instanceof AuthError ? err : new AuthError({kind: 'network', code, message, cause: err});

// ---------- module state ----------

let setup = null;          // Promise<{auth, transport, values}>, created once per page
let convex = null;         // the authenticated ConvexClient, only while signed in
let current = {user: null, status: null};
let connecting = null;     // in-flight connect(): shared by concurrent callers
let offMe = null;          // the live users.me subscription
let resolveSession = defaultResolveSession;
const CONNECT_TIMEOUT_MS = 20000;
let connectTimeoutMs = CONNECT_TIMEOUT_MS;
const listeners = new Set();

const win = () => globalThis.window;
const isDesktop = () => !!win()?.woodshedDesktop;

async function defaultResolveSession() {
  const load = SESSION_MODULES['../stage/session.js'];
  if (!load) return null;
  const mod = await load();
  return typeof mod.activeSession === 'function' ? mod.activeSession() : null;
}

/**
 * Integration and test seam. `activeSession: () => Session|null|Promise` replaces how
 * signOut() finds the session to flush (default: src/stage/session.js activeSession()).
 * `connectTimeoutMs` bounds how long initialize() waits for the backend (default 20 s)
 * before it throws AuthError{kind: 'network', code: 'timeout'}.
 */
export function configure({activeSession, connectTimeoutMs: ms} = {}) {
  resolveSession = typeof activeSession === 'function' ? async () => activeSession() : defaultResolveSession;
  connectTimeoutMs = Number.isFinite(ms) && ms > 0 ? ms : CONNECT_TIMEOUT_MS;
}

function emit() {
  const value = {user: current.user, status: current.status};
  for (const fn of [...listeners]) {
    try { fn(value); } catch (err) { queueMicrotask(() => { throw err; }); }
  }
}

function setCurrent(next) {
  const same = current.status === next.status && sameUser(current.user, next.user);
  current = next;
  if (!same) emit();
}

const sameUser = (a, b) => a === b || (!!a && !!b && a.id === b.id && a.name === b.name && a.email === b.email && a.image === b.image);

function toUser(me) {
  return Object.freeze({id: me.id, name: me.name ?? '', email: me.email ?? '', image: me.picture ?? me.image ?? null});
}

const statusOf = me => (me?.status === 'suspended' || me?.status === 'export_only' ? me.status : 'active');

// ---------- setup ----------

function convexUrl() {
  const url = import.meta.env?.VITE_CONVEX_URL;
  if (!url) throw new AuthError({kind: 'config', code: 'missing_url', message: MESSAGES.config});
  return url;
}

function ensureSetup() {
  if (setup) return setup;
  setup = (async () => {
    const url = convexUrl();
    // Auth mutations prove possession of their own flow and refresh secrets; keep
    // their transport independent of the authenticated realtime connection.
    const transport = new ConvexHttpClient(url);
    const auth = new AuthClient({
      mode: 'spa',
      storage: defaultStorage(),
      storageNamespace: url,
      authApi: {
        refreshSession: refreshToken => transport.mutation(api.auth.refreshSession, {refreshToken}),
        signOut: async refreshToken => { await transport.mutation(api.auth.signOut, {refreshToken}); },
      },
      ambientSignIns: {
        signIns: [oauth()],
        signInApi: {
          mutation: (ref, args) => transport.mutation(ref, args),
          action: (ref, args) => transport.action(ref, args),
        },
      },
    });
    try {
      await auth.init();   // also finishes an OAuth callback found in the URL
    } catch (err) {
      throw asNetwork(err);
    }
    stripOAuthParams();
    const values = auth.ambientSignInValues('oauth');
    auth.subscribe(() => onAuthState(auth));
    return {auth, transport, values};
  })();
  setup.catch(() => { setup = null; });
  return setup;
}

/** The library strips its callback params itself; this keeps the URL clean if it did not. */
function stripOAuthParams() {
  const w = win();
  if (!w?.location?.href || !w.history?.replaceState) return;
  let url;
  try { url = new URL(w.location.href); } catch { return; }
  if (!OAUTH_PARAMS.some(p => url.searchParams.has(p))) return;
  for (const p of OAUTH_PARAMS) url.searchParams.delete(p);
  w.history.replaceState(w.history.state, '', url.pathname + url.search + url.hash);
}

function settled(auth) {
  if (!auth.getSnapshot().isLoading) return Promise.resolve();
  return new Promise(resolve => {
    let off = () => {};
    let done = false;
    const check = () => {
      if (done || auth.getSnapshot().isLoading) return;
      done = true;
      off();
      resolve();
    };
    off = auth.subscribe(check);
    check();
  });
}

// ---------- connecting ----------

const CANCELLED = Symbol('cancelled');   // the session went away while connect() ran
const TIMED_OUT = Symbol('timed out');   // the backend did not answer in time (offline)
let abortConnect = null;                 // (reason) => void while connect() is in flight
let recheck = false;                     // a sign-out cancelled connect(): re-read the state after

function teardown() {
  abortConnect?.(CANCELLED);
  offMe?.();
  offMe = null;
  const c = convex;
  convex = null;
  if (c) Promise.resolve().then(() => c.close()).catch(() => {});
}

/** Lost the session (signed out here or in another tab, or the backend refused it). */
function signedOut() {
  teardown();
  setCurrent({user: null, status: null});
}

function onAuthState(auth) {
  const state = auth.getSnapshot();
  if (state.isLoading) return;
  if (!state.isAuthenticated) {
    // Also cancels an in-flight connect(), so it can never commit a stale user.
    if (connecting) recheck = true;
    if (current.user || convex || connecting) signedOut();
  } else if (!current.user && !connecting && setup) {
    // Signed in from another tab: adopt the session quietly (errors stay signed out).
    connect().catch(() => {});
  }
}

/**
 * Opens the authenticated client, waits for the backend's verdict, reads users.me.
 * Every await races teardown (resolves signed out) and a deadline (AuthError
 * {kind: 'network', code: 'timeout'}), so an unreachable backend or a sign-out
 * mid-way never leaves it pending or commits a user whose session is gone.
 */
function connect() {
  if (connecting) return connecting;
  let abortedWith = null;
  let abort;
  const aborted = new Promise(resolve => { abort = reason => { abortedWith ??= reason; resolve(); }; });
  abortConnect = abort;
  const timer = setTimeout(() => abort(TIMED_OUT), connectTimeoutMs);
  const step = async promise => {
    const value = await Promise.race([promise, aborted]);
    if (abortedWith) throw abortedWith;
    return value;
  };
  let c = null;
  const run = (async () => {
    try {
      const {auth} = await step(ensureSetup());
      if (!auth.getSnapshot().isAuthenticated) throw CANCELLED;
      c = new ConvexClient(convexUrl());
      convex = c;
      // Wait for the backend's verdict before any subscription starts.
      let first = true;
      const verified = await step(new Promise(resolve => {
        c.setAuth(auth.fetchAccessToken, ok => {
          if (first) { first = false; resolve(ok); return; }
          if (!ok && convex === c) signedOut();
        });
      }));
      if (!verified) {
        teardown();
        try { await auth.signOut(); } catch { /* the stored tokens are useless either way */ }
        throw new AuthError({kind: 'oauth', code: 'unverified', message: OAUTH_MESSAGES.unverified});
      }
      const me = await step(c.query(api.users.me, {}));
      if (!me) throw new AuthError({kind: 'network', code: 'account_unavailable', message: MESSAGES.account});
      // Nothing awaits from here on: the user is committed only for a live session.
      if (abortedWith || !auth.getSnapshot().isAuthenticated) throw CANCELLED;
      offMe = c.onUpdate(api.users.me, {}, next => {
        // A null row mid-session is transient (token refresh); sign-out comes from auth state.
        if (next && convex === c) setCurrent({user: toUser(next), status: statusOf(next)});
      }, () => {});
      setCurrent({user: toUser(me), status: statusOf(me)});
      return {user: current.user, status: current.status};
    } catch (err) {
      if (c && convex === c) teardown();
      if (err === CANCELLED) return {user: null, status: null};
      if (err === TIMED_OUT) throw new AuthError({kind: 'network', code: 'timeout', message: MESSAGES.network});
      throw asNetwork(err, MESSAGES.network);
    } finally {
      clearTimeout(timer);
      if (abortConnect === abort) abortConnect = null;
    }
  })();
  connecting = run;
  const settle = () => {
    if (connecting === run) connecting = null;
    if (!recheck) return;
    recheck = false;
    // A sign-out cancelled this run; a sign-in may have followed while it unwound.
    setup?.then(({auth}) => onAuthState(auth), () => {});
  };
  run.then(settle, settle);
  return run;
}

// ---------- public ----------

/**
 * Restores the session and reads the account status (users.me).
 * @returns {Promise<{user: User|null, status: 'active'|'export_only'|'suspended'|null, error?: AuthError}>}
 */
export async function initialize({optional = false} = {}) {
  try {
    if (current.user && convex) return {user: current.user, status: current.status};
    const {auth, values} = await ensureSetup();
    await settled(auth);
    if (!auth.getSnapshot().isAuthenticated) {
      const flowError = values?.get('flowError');
      if (flowError) throw oauthError(flowError);
      return {user: null, status: null};
    }
    const {user, status} = await connect();
    return {user, status};
  } catch (err) {
    const error = err instanceof AuthError ? err : asNetwork(err);
    if (optional) return {user: null, status: null, error};
    throw error;
  }
}

/** The authenticated client used by src/api/client.js, or null while signed out. */
export function client() {
  return current.user ? convex : null;
}

/** The signed-in user, or null. */
export function user() {
  return current.user;
}

/** Subscribes to {user, status} changes. Returns off(). */
export function onChange(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Starts OAuth sign-in. On success the page navigates to the provider and this
 * promise does not settle meaningfully; a failure throws AuthError{kind: 'oauth'}.
 */
export async function signIn(provider = 'google') {
  const refs = PROVIDERS[provider];
  if (!refs) throw new AuthError({kind: 'config', code: 'unknown_provider', message: MESSAGES.provider});
  let values;
  try {
    ({values} = await ensureSetup());
  } catch (err) {
    throw err instanceof AuthError ? err : asNetwork(err);
  }
  const w = win();
  const loc = w?.location;
  const desktop = isDesktop();
  // Desktop OAuth returns to /oauth/callback and reloads at '/': remember where we were.
  if (desktop) stashIntendedRoute(w);
  const redirectTo = loc
    ? (desktop ? `${loc.origin}/oauth/callback` : `${loc.origin}${loc.pathname}${loc.search}`)
    : undefined;
  try {
    const actions = values.get('actions');
    if (!actions?.signIn) throw new Error('OAuth sign-in is not registered.');
    await actions.signIn(refs, redirectTo ? {redirectTo} : {});
  } catch (err) {
    // The library records every start failure as a flow error ('oauth_error' unless the
    // backend threw a ConvexError), so only a ConvexError is a real rejection; anything
    // else (offline, a failed save of the flow) means sign-in could not start.
    if (err instanceof ConvexError) {
      const flowError = values.get('flowError');
      throw oauthError(flowError?.code === 'rejected' ? flowError : {code: 'rejected', message: typeof err.data === 'string' ? err.data : undefined});
    }
    throw new AuthError({kind: 'oauth', code: 'start_failed', message: OAUTH_MESSAGES.start_failed, cause: err});
  }
}

/**
 * Flushes the active session (final save), then ends this page's session. Never throws:
 * the library always erases the local tokens, and revoking the refresh token on the
 * server is best effort (an offline revoke is not reported).
 */
export async function signOut() {
  try {
    const session = await resolveSession();
    await session?.flush?.({final: true});
  } catch {
    // A failed final save must not trap the user signed in; the save path reports its own errors.
  }
  if (setup) {
    try {
      const {auth} = await setup;
      await auth.signOut();
    } catch {
      // Setup never finished, or storage refused the erase: nothing more this page can do.
    }
  }
  signedOut();
}
