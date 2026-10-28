// src/app/auth.js (architecture §2.23, AU1). Runs in the default edge-runtime
// environment on purpose: there is no `document`, so any DOM access fails the suite.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {getFunctionName} from 'convex/server';

const fx = vi.hoisted(() => {
  const state = {
    log: [],
    authClients: [],
    convexClients: [],
    http: [],
    // AuthClient behaviour
    authenticated: true,
    loadingAfterInit: false,
    initError: null,
    signOutError: null,
    stripOnInit: true,
    flowError: null,
    signInImpl: null,
    // ConvexClient behaviour
    verdict: true,
    me: {id: 'u1', name: 'Kyle Kincer', email: 'kyle@example.com', picture: 'https://img/k.png', status: 'active'},
    meError: null,
  };
  return state;
});

const fnName = ref => (typeof ref === 'string' ? ref : getFunctionName(ref));

vi.mock('@convex-dev/auth/browser', () => ({
  defaultStorage: () => ({kind: 'default-storage'}),
  AuthClient: class {
    constructor(config) {
      this.config = config;
      this.listeners = new Set();
      this.state = {isLoading: true, isAuthenticated: false, token: null};
      this.values = new Map([['flowError', null], ['actions', {signIn: (...args) => this.signInCall(...args)}]]);
      this.fetchAccessToken = async () => 'token';
      fx.authClients.push(this);
    }
    async init() {
      fx.log.push('auth.init');
      if (fx.initError) throw fx.initError;
      const w = globalThis.window;
      if (fx.stripOnInit && w?.location) {
        const url = new URL(w.location.href);
        if (url.searchParams.has('convexAuthCode') || url.searchParams.has('convexAuthError')) {
          url.searchParams.delete('convexAuthCode');
          url.searchParams.delete('convexAuthError');
          w.history.replaceState(w.history.state, '', url.toString());
        }
      }
      this.values.set('flowError', fx.flowError);
      this.set({isLoading: fx.loadingAfterInit, isAuthenticated: fx.loadingAfterInit ? false : fx.authenticated});
    }
    set(patch) { this.state = {...this.state, ...patch}; for (const fn of [...this.listeners]) fn(); }
    getSnapshot() { return this.state; }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    ambientSignInValues(id) {
      fx.log.push(`values ${id}`);
      return {get: key => this.values.get(key), subscribe: () => () => {}};
    }
    async signInCall(refs, options) {
      fx.log.push('actions.signIn');
      return fx.signInImpl ? fx.signInImpl.call(this, refs, options) : {redirect: new URL('https://accounts.example/o')};
    }
    async signOut() {
      fx.log.push('auth.signOut');
      if (fx.signOutError) throw fx.signOutError;
      this.set({isLoading: false, isAuthenticated: false});
    }
  },
}));

vi.mock('@convex-dev/auth/providers/oauth/react', () => ({oauth: () => ({id: 'oauth'})}));

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    constructor(url) {
      this.url = url;
      this.mutation = vi.fn(async (ref, args) => ({ref: fnName(ref), args}));
      this.action = vi.fn(async () => null);
      fx.http.push(this);
    }
  },
  ConvexClient: class {
    constructor(url) {
      this.url = url;
      this.updates = [];
      this.closed = false;
      fx.convexClients.push(this);
    }
    setAuth(fetchToken, onChange) {
      fx.log.push('convex.setAuth');
      this.fetchToken = fetchToken;
      this.authChange = onChange;
      queueMicrotask(() => onChange(fx.verdict));
    }
    async query(ref, args) {
      fx.log.push(`query ${fnName(ref)}`);
      if (fx.meError) throw fx.meError;
      return fx.me && {...fx.me, ...args};
    }
    onUpdate(ref, args, cb) {
      const sub = {name: fnName(ref), cb, off: vi.fn()};
      this.updates.push(sub);
      return sub.off;
    }
    async close() { this.closed = true; }
  },
}));

const ORIGIN = 'https://woodshed.test';

function makeWindow(path = '/s/song1?bar=12', {desktop = false} = {}) {
  const store = new Map();
  const w = {
    location: null,
    history: {
      state: {ws: 1, key: 'k1'},
      replaceState: vi.fn((state, _title, url) => {
        w.history.state = state;
        setHref(new URL(url, w.location.href).toString());
      }),
    },
    sessionStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { fx.log.push(`stash ${v}`); store.set(k, String(v)); },
      removeItem: k => store.delete(k),
    },
    store,
  };
  const setHref = href => {
    const u = new URL(href);
    w.location = {href: u.href, origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash};
  };
  setHref(ORIGIN + path);
  if (desktop) w.woodshedDesktop = {};
  return w;
}

let auth;

async function load() {
  vi.resetModules();
  auth = await import('../src/app/auth.js');
  return auth;
}

const lastAuth = () => fx.authClients.at(-1);
const lastConvex = () => fx.convexClients.at(-1);
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(async () => {
  Object.assign(fx, {
    log: [], authClients: [], convexClients: [], http: [],
    authenticated: true, loadingAfterInit: false, initError: null, signOutError: null, stripOnInit: true,
    flowError: null, signInImpl: null, verdict: true, meError: null,
    me: {id: 'u1', name: 'Kyle Kincer', email: 'kyle@example.com', picture: 'https://img/k.png', status: 'active'},
  });
  vi.stubEnv('VITE_CONVEX_URL', 'https://example.convex.cloud');
  delete globalThis.window;
  await load();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete globalThis.window;
});

describe('no DOM access', () => {
  test('the module loads, initializes, signs in and out with document (and window) undefined', async () => {
    expect(typeof document).toBe('undefined');
    expect(typeof globalThis.window).toBe('undefined');
    const r = await auth.initialize();
    expect(r.user.id).toBe('u1');
    await auth.signOut();
    expect(auth.user()).toBe(null);
    fx.signInImpl = async () => { throw new Error('offline'); };
    await expect(auth.signIn()).rejects.toMatchObject({kind: 'oauth', code: 'start_failed'});
  });
});

describe('initialize: signed in', () => {
  test('restores the session, waits for the backend verdict, then reads users.me', async () => {
    const r = await auth.initialize();
    expect(r).toEqual({user: {id: 'u1', name: 'Kyle Kincer', email: 'kyle@example.com', image: 'https://img/k.png'}, status: 'active'});
    expect(auth.user()).toEqual(r.user);
    expect(fx.log.slice(0, 4)).toEqual(['auth.init', 'values oauth', 'convex.setAuth', 'query users:me']);
    expect(auth.client()).toBe(lastConvex());
    expect(lastConvex().url).toBe('https://example.convex.cloud');
    expect(lastConvex().fetchToken).toBe(lastAuth().fetchAccessToken);
    expect(lastConvex().updates.map(s => s.name)).toEqual(['users:me']);
  });

  test('the AuthClient is spa mode, namespaced by the URL, with an HTTP transport for auth mutations', async () => {
    await auth.initialize();
    const {config} = lastAuth();
    expect(config.mode).toBe('spa');
    expect(config.storageNamespace).toBe('https://example.convex.cloud');
    expect(config.storage).toEqual({kind: 'default-storage'});
    expect(config.ambientSignIns.signIns).toEqual([{id: 'oauth'}]);
    const http = fx.http[0];
    await config.authApi.refreshSession('r1');
    expect(http.mutation).toHaveBeenLastCalledWith(expect.anything(), {refreshToken: 'r1'});
    expect(fnName(http.mutation.mock.calls.at(-1)[0])).toBe('auth:refreshSession');
    await config.authApi.signOut('r2');
    expect(fnName(http.mutation.mock.calls.at(-1)[0])).toBe('auth:signOut');
    await config.ambientSignIns.signInApi.action('a:b', {x: 1});
    expect(http.action).toHaveBeenCalledWith('a:b', {x: 1});
  });

  test('a session that is still loading after init is awaited', async () => {
    fx.loadingAfterInit = true;
    let done = false;
    const p = auth.initialize().then(r => { done = true; return r; });
    await flush();
    expect(done).toBe(false);
    lastAuth().set({isLoading: false, isAuthenticated: true});
    expect((await p).user.id).toBe('u1');
  });

  test.each([
    ['active', 'active'],
    ['export_only', 'export_only'],
    ['suspended', 'suspended'],
    [undefined, 'active'],
    ['weird', 'active'],
  ])('status %s reads as %s (never thrown; main.js decides)', async (raw, expected) => {
    fx.me = {...fx.me, status: raw};
    const r = await auth.initialize();
    expect(r.status).toBe(expected);
    expect(r.user).not.toBe(null);
  });

  test('concurrent and repeated calls share one AuthClient, one client and one users.me read', async () => {
    const [a, b] = await Promise.all([auth.initialize(), auth.initialize({optional: true})]);
    const c = await auth.initialize();
    expect(a.user).toBe(b.user);
    expect(c.user).toBe(a.user);
    expect(fx.authClients).toHaveLength(1);
    expect(fx.convexClients).toHaveLength(1);
    expect(fx.log.filter(l => l === 'query users:me')).toHaveLength(1);
  });

  test('a missing name, email or picture becomes an empty string or null', async () => {
    fx.me = {id: 'u2', status: 'active'};
    expect((await auth.initialize()).user).toEqual({id: 'u2', name: '', email: '', image: null});
  });
});

describe('initialize: signed out', () => {
  test.each([false, true])('optional=%s resolves {user: null, status: null} and opens no realtime client', async optional => {
    fx.authenticated = false;
    expect(await auth.initialize({optional})).toEqual({user: null, status: null});
    expect(auth.user()).toBe(null);
    expect(auth.client()).toBe(null);
    expect(fx.convexClients).toHaveLength(0);
  });

  test('a later call re-reads the auth state (nothing signed-out is cached)', async () => {
    fx.authenticated = false;
    await auth.initialize();
    lastAuth().state = {isLoading: false, isAuthenticated: true};
    expect((await auth.initialize()).user.id).toBe('u1');
    expect(fx.authClients).toHaveLength(1);
  });
});

describe('OAuth error mapping (today’s copy keys)', () => {
  test.each([
    ['access_denied', 'Sign-in was canceled. You can try again.'],
    ['expired', 'This sign-in link expired. Please sign in again.'],
    ['invalid_flow', 'Sign-in must finish in the same browser where it started. Please try again here.'],
    ['oauth_error', 'Google sign-in could not finish. Please try again.'],
    ['rejected', 'Sign-in could not finish. Please try again.'],
    ['something_new', 'Sign-in could not finish. Please try again.'],
  ])('flow error %s → AuthError{kind: oauth} with today’s message', async (code, message) => {
    fx.authenticated = false;
    fx.flowError = {code};
    const err = await auth.initialize().catch(e => e);
    expect(err).toBeInstanceOf(auth.AuthError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({name: 'AuthError', kind: 'oauth', code, message});
  });

  test('a message carried by the flow error wins over the table', async () => {
    fx.authenticated = false;
    fx.flowError = {code: 'rejected', message: 'This account is not allowed.'};
    await expect(auth.initialize()).rejects.toMatchObject({kind: 'oauth', code: 'rejected', message: 'This account is not allowed.'});
  });

  test('optional mode never throws: the error rides on the result', async () => {
    fx.authenticated = false;
    fx.flowError = {code: 'expired'};
    const r = await auth.initialize({optional: true});
    expect(r.user).toBe(null);
    expect(r.error).toMatchObject({kind: 'oauth', code: 'expired', message: auth.OAUTH_MESSAGES.expired});
  });

  test('oauthError() is exported for the sign-in card', () => {
    expect(auth.oauthError({code: 'access_denied'})).toMatchObject({kind: 'oauth', code: 'access_denied', message: auth.OAUTH_MESSAGES.access_denied});
    expect(auth.oauthError(null)).toMatchObject({kind: 'oauth', code: 'oauth_error'});
  });

  test('OAuth callback params are stripped (history state kept) even if the library left them', async () => {
    fx.stripOnInit = false;
    globalThis.window = makeWindow('/s/song1?convexAuthCode=abc&bar=12&convexAuthError=x#h');
    const state = globalThis.window.history.state;
    await auth.initialize();
    expect(globalThis.window.history.replaceState).toHaveBeenCalledWith(state, '', '/s/song1?bar=12#h');
    expect(globalThis.window.location.search).toBe('?bar=12');
  });

  test('a clean URL is left alone', async () => {
    globalThis.window = makeWindow('/?q=x');
    await auth.initialize();
    expect(globalThis.window.history.replaceState).not.toHaveBeenCalled();
  });
});

describe('AuthError kinds', () => {
  test('config: VITE_CONVEX_URL missing (optional mode returns it)', async () => {
    vi.stubEnv('VITE_CONVEX_URL', '');
    await load();
    await expect(auth.initialize()).rejects.toMatchObject({kind: 'config', code: 'missing_url'});
    expect((await auth.initialize({optional: true})).error).toMatchObject({kind: 'config'});
    expect(fx.authClients).toHaveLength(0);
  });

  test('config: an unknown provider', async () => {
    await expect(auth.signIn('github')).rejects.toMatchObject({kind: 'config', code: 'unknown_provider'});
  });

  test('network: users.me fails; a retry works with the same AuthClient', async () => {
    const raw = new Error('[CONVEX Q(users:me)] Connection lost while action was in flight');
    fx.meError = raw;
    const err = await auth.initialize().catch(e => e);
    expect(err).toMatchObject({kind: 'network', code: 'network'});
    expect(err.cause).toBe(raw);
    expect(auth.client()).toBe(null);
    expect(lastConvex().closed).toBe(true);
    fx.meError = null;
    expect((await auth.initialize()).user.id).toBe('u1');
    expect(fx.authClients).toHaveLength(1);
  });

  test('network: users.me returns no account', async () => {
    fx.me = null;
    await expect(auth.initialize()).rejects.toMatchObject({kind: 'network', code: 'account_unavailable', message: 'Your account could not be loaded.'});
  });

  test('network: restoring the session fails; the next call starts over', async () => {
    fx.initError = new TypeError('Failed to fetch');
    await expect(auth.initialize()).rejects.toMatchObject({kind: 'network'});
    fx.initError = null;
    expect((await auth.initialize()).user.id).toBe('u1');
    expect(fx.authClients).toHaveLength(2);
  });

  test('oauth/unverified: the backend refuses the stored session → signed out, shown on the sign-in card', async () => {
    fx.verdict = false;
    const err = await auth.initialize().catch(e => e);
    expect(err).toMatchObject({kind: 'oauth', code: 'unverified', message: 'Your session could not be verified. Sign in again.'});
    expect(fx.log).toContain('auth.signOut');
    expect(auth.client()).toBe(null);
    expect((await auth.initialize({optional: true})).user).toBe(null);
  });
});

describe('onChange', () => {
  test('fires on sign-in, on live users.me changes only, and stops after off()', async () => {
    const seen = [];
    const off = auth.onChange(v => seen.push(v));
    await auth.initialize();
    expect(seen).toEqual([{user: expect.objectContaining({id: 'u1'}), status: 'active'}]);
    const sub = lastConvex().updates[0];
    sub.cb({...fx.me});                       // identical: no event
    sub.cb(null);                             // transient null: ignored
    expect(seen).toHaveLength(1);
    sub.cb({...fx.me, status: 'suspended'});
    sub.cb({...fx.me, status: 'suspended', name: 'Kyle K.'});
    expect(seen.slice(1).map(v => [v.status, v.user.name])).toEqual([['suspended', 'Kyle Kincer'], ['suspended', 'Kyle K.']]);
    expect(auth.user().name).toBe('Kyle K.');
    off();
    sub.cb({...fx.me, status: 'export_only'});
    expect(seen).toHaveLength(3);
  });

  test('a sign-out in another tab clears the user and the client', async () => {
    await auth.initialize();
    const seen = [];
    auth.onChange(v => seen.push(v));
    const c = lastConvex();
    lastAuth().set({isLoading: false, isAuthenticated: false});
    expect(seen).toEqual([{user: null, status: null}]);
    expect(auth.client()).toBe(null);
    expect(c.updates[0].off).toHaveBeenCalled();
    await flush();
    expect(c.closed).toBe(true);
  });

  test('a session the backend later rejects reads as signed out', async () => {
    await auth.initialize();
    const seen = [];
    auth.onChange(v => seen.push(v));
    lastConvex().authChange(true);
    expect(seen).toEqual([]);
    lastConvex().authChange(false);
    expect(seen).toEqual([{user: null, status: null}]);
  });

  test('a sign-in in another tab is adopted', async () => {
    fx.authenticated = false;
    await auth.initialize();
    const seen = [];
    auth.onChange(v => seen.push(v));
    lastAuth().set({isLoading: false, isAuthenticated: true});
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].user.id).toBe('u1');
    expect(auth.client()).toBe(lastConvex());
  });

  test('a throwing listener does not stop the others', async () => {
    const seen = [];
    const onError = vi.fn();
    const prior = globalThis.queueMicrotask;
    globalThis.queueMicrotask = fn => prior(() => { try { fn(); } catch (e) { onError(e); } });
    try {
      auth.onChange(() => { throw new Error('boom'); });
      auth.onChange(v => seen.push(v));
      await auth.initialize();
      await flush();
    } finally {
      globalThis.queueMicrotask = prior;
    }
    expect(seen).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({message: 'boom'}));
  });
});

describe('signOut', () => {
  test('flushes the active session (final) first, then signs out and notifies', async () => {
    const session = {flush: vi.fn(async opts => { fx.log.push(`flush ${JSON.stringify(opts)}`); })};
    auth.configure({activeSession: () => session});
    await auth.initialize();
    const seen = [];
    auth.onChange(v => seen.push(v));
    fx.log.length = 0;
    await auth.signOut();
    expect(fx.log).toEqual(['flush {"final":true}', 'auth.signOut']);
    expect(seen).toEqual([{user: null, status: null}]);
    expect(auth.user()).toBe(null);
    expect(auth.client()).toBe(null);
  });

  test('a failed flush still signs out; no active session is fine', async () => {
    auth.configure({activeSession: () => ({flush: async () => { throw new Error('offline'); }})});
    await auth.initialize();
    await auth.signOut();
    expect(fx.log).toContain('auth.signOut');
    expect(auth.user()).toBe(null);
    await load();
    auth.configure({activeSession: () => null});
    await auth.initialize();
    await auth.signOut();
    expect(auth.user()).toBe(null);
  });

  test('without a session module (wave 1a) sign-out still works by default', async () => {
    await auth.initialize();
    await auth.signOut();
    expect(fx.log.at(-1)).toBe('auth.signOut');
  });

  test('a failed sign-out throws AuthError{kind: network} and keeps the user signed in', async () => {
    await auth.initialize();
    fx.signOutError = new Error('Network down');
    await expect(auth.signOut()).rejects.toMatchObject({kind: 'network', code: 'sign_out_failed'});
    expect(auth.user().id).toBe('u1');
    expect(auth.client()).not.toBe(null);
  });

  test('before initialize it is a harmless no-op', async () => {
    await expect(auth.signOut()).resolves.toBeUndefined();
    expect(fx.authClients).toHaveLength(0);
  });
});

describe('signIn', () => {
  test('web: returns to the same path and query, without stashing a route', async () => {
    globalThis.window = makeWindow('/share/abc?save=1');
    fx.authenticated = false;
    await auth.initialize({optional: true});
    let got;
    fx.signInImpl = async (_refs, options) => { got = options; };
    await auth.signIn();
    expect(got).toEqual({redirectTo: `${ORIGIN}/share/abc?save=1`});
    expect(globalThis.window.store.size).toBe(0);
    expect(fx.authClients).toHaveLength(1);
  });

  test('passes the Google refs and the redirect (web)', async () => {
    globalThis.window = makeWindow('/s/song1?bar=12');
    let got;
    fx.signInImpl = async (refs, options) => { got = {refs, options}; };
    await auth.signIn('google');
    expect(got.refs.providerName).toBe('google');
    expect(fnName(got.refs.startSignIn)).toBe('auth:startSignInGoogle');
    expect(fnName(got.refs.completeSignIn)).toBe('auth:completeSignInGoogle');
    expect(got.options).toEqual({redirectTo: `${ORIGIN}/s/song1?bar=12`});
    expect(globalThis.window.store.size).toBe(0);
  });

  test('desktop: stashes the intended route first, then redirects through /oauth/callback', async () => {
    globalThis.window = makeWindow('/s/song1/edit/map?bar=3', {desktop: true});
    let got;
    fx.signInImpl = async (refs, options) => { got = options; };
    await auth.signIn();
    expect(globalThis.window.store.get('ws.intendedRoute')).toBe('/s/song1/edit/map?bar=3');
    expect(got).toEqual({redirectTo: `${ORIGIN}/oauth/callback`});
    expect(fx.log.indexOf('stash /s/song1/edit/map?bar=3')).toBeLessThan(fx.log.indexOf('actions.signIn'));
  });

  test('a failure with a flow error maps it; without one it is start_failed', async () => {
    fx.signInImpl = async function () { this.values.set('flowError', {code: 'oauth_error'}); throw new Error('x'); };
    await expect(auth.signIn()).rejects.toMatchObject({kind: 'oauth', code: 'oauth_error', message: auth.OAUTH_MESSAGES.oauth_error});
    const raw = new TypeError('Failed to fetch');
    fx.signInImpl = async function () { this.values.set('flowError', null); throw raw; };
    const err = await auth.signIn().catch(e => e);
    expect(err).toMatchObject({kind: 'oauth', code: 'start_failed', message: 'Could not start Google sign-in. Check your connection and try again.'});
    expect(err.cause).toBe(raw);
  });

  test('missing configuration surfaces as AuthError{kind: config}', async () => {
    vi.stubEnv('VITE_CONVEX_URL', '');
    await load();
    await expect(auth.signIn()).rejects.toMatchObject({kind: 'config'});
  });
});
