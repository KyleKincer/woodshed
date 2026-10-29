// src/app/auth.js (architecture §2.23, AU1). Runs in the default edge-runtime
// environment on purpose: there is no `document`, so any DOM access fails the suite.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {getFunctionName} from 'convex/server';
import {ConvexError} from 'convex/values';

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
    startImpl: null,       // the auth:startSignInGoogle mutation (the real oauth() calls it)
    // ConvexClient behaviour
    verdict: true,         // true | false | 'never' (offline: the verdict never arrives)
    meHold: null,          // a promise users.me waits on
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
      this.values = new Map();
      this.fetchAccessToken = async () => 'token';
      fx.authClients.push(this);
      // Run the real ambient sign-in setups, as the library's constructor does.
      const flowStore = new Map();
      const storage = {
        get: async k => (flowStore.has(k) ? flowStore.get(k) : null),
        set: async (k, v) => { flowStore.set(k, v); },
        remove: async k => { flowStore.delete(k); },
      };
      for (const {setup} of config.ambientSignIns?.signIns ?? []) {
        setup?.({client: this, values: {get: k => this.values.get(k), set: (k, v) => this.values.set(k, v)}, storage, signInApi: config.ambientSignIns.signInApi});
      }
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
    // Like the library: the server revoke is best effort and the local tokens are always erased.
    async signOut() {
      fx.log.push('auth.signOut');
      try { await this.config.authApi.signOut('refresh'); } catch { /* already signed out */ }
      this.set({isLoading: false, isAuthenticated: false, token: null});
    }
  },
}));

// The real oauth() setup, so sign-in failures carry the library's own flow errors.
vi.mock('@convex-dev/auth/providers/oauth/react', async () => {
  const {oauth} = await vi.importActual('@convex-dev/auth/providers/oauth/react');
  return {oauth};
});

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    constructor(url) {
      this.url = url;
      this.mutation = vi.fn(async (ref, args) => {
        const name = fnName(ref);
        if (name === 'auth:startSignInGoogle') {
          fx.log.push(`start ${args.redirectTo}`);
          return fx.startImpl ? fx.startImpl(args) : {redirect: 'https://accounts.example/o', state: 'st1'};
        }
        if (name === 'auth:signOut' && fx.signOutError) throw fx.signOutError;
        return {ref: name, args};
      });
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
      if (fx.verdict !== 'never') queueMicrotask(() => onChange(fx.verdict));
    }
    async query(ref, args) {
      fx.log.push(`query ${fnName(ref)}`);
      if (fx.meHold) await fx.meHold;
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
    flowError: null, startImpl: null, verdict: true, meError: null, meHold: null,
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
    fx.startImpl = async () => { throw new Error('offline'); };
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
    expect(config.ambientSignIns.signIns.map(s => s.id)).toEqual(['oauth']);
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

  test('an offline server revoke still signs out locally and never throws (the library swallows it)', async () => {
    await auth.initialize();
    const seen = [];
    auth.onChange(v => seen.push(v));
    fx.signOutError = new TypeError('Failed to fetch');
    await expect(auth.signOut()).resolves.toBeUndefined();
    expect(fnName(fx.http[0].mutation.mock.calls.at(-1)[0])).toBe('auth:signOut');
    expect(auth.user()).toBe(null);
    expect(auth.client()).toBe(null);
    expect(lastAuth().getSnapshot().isAuthenticated).toBe(false);
    expect(seen).toEqual([{user: null, status: null}]);
  });

  test('a library sign-out that throws (storage refused the erase) still ends this page’s session', async () => {
    await auth.initialize();
    lastAuth().signOut = async () => { throw new Error('QuotaExceededError'); };
    await expect(auth.signOut()).resolves.toBeUndefined();
    expect(auth.user()).toBe(null);
    expect(auth.client()).toBe(null);
  });

  test('before initialize it is a harmless no-op', async () => {
    await expect(auth.signOut()).resolves.toBeUndefined();
    expect(fx.authClients).toHaveLength(0);
  });
});

describe('signIn (driving the real oauth() setup)', () => {
  test('web: returns to the same path and query, without stashing a route', async () => {
    globalThis.window = makeWindow('/share/abc?save=1');
    fx.authenticated = false;
    await auth.initialize({optional: true});
    await auth.signIn();
    expect(fx.log).toContain(`start ${ORIGIN}/share/abc?save=1`);
    expect(globalThis.window.location.href).toBe('https://accounts.example/o');
    expect(globalThis.window.store.size).toBe(0);
    expect(fx.authClients).toHaveLength(1);
  });

  test('passes the Google refs and the redirect (web)', async () => {
    globalThis.window = makeWindow('/s/song1?bar=12');
    let got;
    fx.startImpl = async args => { got = args; return {redirect: 'https://accounts.example/o', state: 'st1'}; };
    await auth.signIn('google');
    const [ref] = fx.http[0].mutation.mock.calls.find(([r]) => fnName(r) === 'auth:startSignInGoogle');
    expect(fnName(ref)).toBe('auth:startSignInGoogle');
    expect(got).toEqual({redirectTo: `${ORIGIN}/s/song1?bar=12`});
    expect(globalThis.window.store.size).toBe(0);
  });

  test('desktop: stashes the intended route first, then redirects through /oauth/callback', async () => {
    globalThis.window = makeWindow('/s/song1/edit/map?bar=3', {desktop: true});
    await auth.signIn();
    expect(globalThis.window.store.get('ws.intendedRoute')).toBe('/s/song1/edit/map?bar=3');
    expect(fx.log).toContain(`start ${ORIGIN}/oauth/callback`);
    expect(fx.log.indexOf('stash /s/song1/edit/map?bar=3')).toBeLessThan(fx.log.indexOf(`start ${ORIGIN}/oauth/callback`));
  });

  test('a network failure starting sign-in is start_failed, although the library records oauth_error', async () => {
    globalThis.window = makeWindow('/');
    const raw = new TypeError('Failed to fetch');
    fx.startImpl = async () => { throw raw; };
    const err = await auth.signIn().catch(e => e);
    expect(lastAuth().values.get('flowError')).toMatchObject({code: 'oauth_error'});
    expect(err).toMatchObject({kind: 'oauth', code: 'start_failed', message: 'Could not start Google sign-in. Check your connection and try again.'});
    expect(err.cause).toBe(raw);
  });

  test('a backend ConvexError is a rejection carrying its message', async () => {
    globalThis.window = makeWindow('/');
    fx.startImpl = async () => { throw new ConvexError('This account is not allowed.'); };
    await expect(auth.signIn()).rejects.toMatchObject({kind: 'oauth', code: 'rejected', message: 'This account is not allowed.'});
    fx.startImpl = async () => { throw new ConvexError({reason: 'x'}); };
    await expect(auth.signIn()).rejects.toMatchObject({kind: 'oauth', code: 'rejected', message: auth.OAUTH_MESSAGES.fallback});
  });

  test('missing configuration surfaces as AuthError{kind: config}', async () => {
    vi.stubEnv('VITE_CONVEX_URL', '');
    await load();
    await expect(auth.signIn()).rejects.toMatchObject({kind: 'config'});
  });
});

describe('races with connect()', () => {
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

  test('signOut() while users.me is in flight: initialize resolves signed out, nothing stale is committed', async () => {
    const hold = deferred();
    fx.meHold = hold.promise;
    const seen = [];
    auth.onChange(v => seen.push(v));
    const init = auth.initialize();
    await vi.waitFor(() => expect(fx.log).toContain('query users:me'));
    await auth.signOut();
    hold.resolve();
    expect(await init).toEqual({user: null, status: null});
    expect(auth.user()).toBe(null);
    expect(auth.client()).toBe(null);
    expect(lastConvex().updates).toHaveLength(0);
    await flush();
    expect(lastConvex().closed).toBe(true);
    expect(seen).toEqual([]);
  });

  test('another tab signs in, then out, while the adopt is in flight: stays signed out', async () => {
    fx.authenticated = false;
    await auth.initialize();
    const hold = deferred();
    fx.meHold = hold.promise;
    const seen = [];
    auth.onChange(v => seen.push(v));
    lastAuth().set({isLoading: false, isAuthenticated: true});
    await vi.waitFor(() => expect(fx.log).toContain('query users:me'));
    lastAuth().set({isLoading: false, isAuthenticated: false});
    hold.resolve();
    await flush();
    await flush();
    expect(auth.user()).toBe(null);
    expect(auth.client()).toBe(null);
    expect(seen).toEqual([]);
  });

  test('a sign-out then a sign-in during connect is picked up once the cancelled run unwinds', async () => {
    const hold = deferred();
    fx.meHold = hold.promise;
    const init = auth.initialize();
    await vi.waitFor(() => expect(fx.log).toContain('query users:me'));
    lastAuth().set({isLoading: false, isAuthenticated: false});
    lastAuth().set({isLoading: false, isAuthenticated: true});
    expect(await init).toEqual({user: null, status: null});
    fx.meHold = null;
    hold.resolve();
    await vi.waitFor(() => expect(auth.user()?.id).toBe('u1'));
    expect(auth.client()).toBe(lastConvex());
    expect(fx.convexClients).toHaveLength(2);
    expect(fx.convexClients[0].closed).toBe(true);
  });

  test('an unreachable backend times out as AuthError{kind: network} and Retry starts a fresh connect', async () => {
    auth.configure({connectTimeoutMs: 30});
    fx.verdict = 'never';
    const err = await auth.initialize().catch(e => e);
    expect(err).toMatchObject({kind: 'network', code: 'timeout', message: 'Woodshed could not reach its server. Check your connection and try again.'});
    expect(auth.client()).toBe(null);
    await flush();
    expect(fx.convexClients[0].closed).toBe(true);
    expect((await auth.initialize({optional: true})).error).toMatchObject({kind: 'network', code: 'timeout'});
    fx.verdict = true;
    expect((await auth.initialize()).user.id).toBe('u1');
    expect(fx.convexClients).toHaveLength(3);
    expect(fx.authClients).toHaveLength(1);
  });

  test('users.me that never answers also times out', async () => {
    auth.configure({connectTimeoutMs: 30});
    fx.meHold = new Promise(() => {});
    await expect(auth.initialize()).rejects.toMatchObject({kind: 'network', code: 'timeout'});
  });

  test('a sign-out while the verdict hangs does not wedge the module: a later sign-in is adopted', async () => {
    fx.verdict = 'never';
    const init = auth.initialize();
    await vi.waitFor(() => expect(fx.log).toContain('convex.setAuth'));
    await auth.signOut();
    expect(await init).toEqual({user: null, status: null});
    fx.verdict = true;
    const seen = [];
    auth.onChange(v => seen.push(v));
    lastAuth().set({isLoading: false, isAuthenticated: true});
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].user.id).toBe('u1');
    expect((await auth.initialize()).user.id).toBe('u1');
  });
});
