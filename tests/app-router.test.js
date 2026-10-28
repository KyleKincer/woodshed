// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {GUARD_TOAST, INTENDED_ROUTE_KEY, createRouter, stashIntendedRoute, takeIntendedRoute} from '../src/app/router.js';
import {signal} from '../src/app/store.js';

// The router falls back to src/stage/session.js when ctx.getSession is absent; the real
// module needs a signed-in client, so the fallback is exercised against this stand-in.
const sessionModule = vi.hoisted(() => ({
  getSession: null,
  disposeSession: null,
}));
vi.mock('../src/stage/session.js', () => ({
  getSession: (...args) => sessionModule.getSession(...args),
  disposeSession: (...args) => sessionModule.disposeSession(...args),
}));

const root = document.documentElement;
let log, router, outlet, sessions, store, feedback, assign;

function view(name, {render} = {}) {
  return {
    mount: vi.fn(async (el, match, ctx) => {
      log.push(`mount ${name}${ctx.session ? ` (${ctx.session.id})` : ''}`);
      el.replaceChildren(...(render ? render(match) : [Object.assign(document.createElement('h1'), {textContent: name})]));
      const instance = {
        update: vi.fn(async m => { log.push(`update ${name} ${m.name}`); }),
        unmount: vi.fn(async () => { log.push(`unmount ${name}`); }),
        ctx,
      };
      views[name].instances.push(instance);
      return instance;
    }),
    instances: [],
  };
}

// The Library renders a scroller with focusable cards, like home.js.
const libraryRender = () => {
  const scroller = document.createElement('div');
  scroller.setAttribute('data-scroller', '');
  for (const id of ['a', 'b', 'c']) {
    const card = document.createElement('button');
    card.dataset.focusKey = `song:${id}`;
    card.textContent = id;
    scroller.append(card);
  }
  return [scroller];
};

let views;
const load = name => () => Promise.resolve(views[name]);
let editLoader;

function makeRoutes() {
  editLoader = load('edit');
  const settingsLoader = load('settings');
  return [
    {name: 'library', path: '/', place: 'library', chrome: 'topbar', view: load('library')},
    {name: 'add', path: '/add', place: 'library', chrome: 'topbar', modalOver: 'library', view: load('add')},
    {name: 'stage', path: '/s/:songId', place: 'stage', chrome: 'none', posture: 'stage', session: true, view: load('stage')},
    {name: 'edit', path: '/s/:songId/edit/:tab', place: 'edit', chrome: 'none', posture: 'edit', session: true, tabs: ['map', 'chart', 'details'], view: editLoader},
    {name: 'editFind', path: '/s/:songId/edit/map/find', place: 'edit', chrome: 'none', posture: 'edit', session: true, view: editLoader, params: {tab: 'map', find: true}},
    {name: 'settings', path: '/settings', place: 'settings', chrome: 'topbar', view: settingsLoader},
    {name: 'settingsPage', path: '/settings/:section', place: 'settings', chrome: 'topbar', view: settingsLoader},
    {name: 'admin', path: '/admin', place: 'admin', chrome: 'topbar', guard: s => s.admin, view: load('admin')},
  ];
}

const redirects = [
  {from: url => url.pathname === '/' && url.searchParams.has('song'), to: url => `/s/${url.searchParams.get('song')}`},
  {from: url => url.pathname === '/billing', to: url => `/settings/plan${url.search}`},
];

function make(extra = {}) {
  router = createRouter({routes: makeRoutes(), redirects, outlet, assign, ctx: {
    store, feedback, registry: {}, platform: {}, desktop: {},
    getSession: async id => { log.push(`getSession ${id}`); return {id}; },
    disposeSession: async id => { log.push(`disposeSession ${id}`); },
    ...extra,
  }});
  return router;
}

function at(path) { history.replaceState(null, '', path); }
const here = () => location.pathname + location.search;

beforeEach(() => {
  log = [];
  views = {library: view('library', {render: libraryRender}), add: view('add'), stage: view('stage'), edit: view('edit'),
    settings: view('settings'), admin: view('admin')};
  document.body.replaceChildren();
  outlet = document.createElement('main');
  document.body.append(outlet);
  for (const a of ['data-place', 'data-posture', 'data-view-ready', 'data-view-error', 'data-theme', 'data-stage-theme', 'style']) root.removeAttribute(a);
  store = {session: signal({user: {id: 'u'}, admin: false, status: 'active', online: true})};
  feedback = {toast: vi.fn()};
  assign = vi.fn();
  sessionStorage.clear();
  at('/');
});

afterEach(async () => {
  await router?.stop();
  router = null;
  delete window.woodshedAppearance;
  vi.restoreAllMocks();
});

describe('mounting and root attributes', () => {
  test('start() mounts the current route, sets root attributes, dispatches woodshed:place, then data-view-ready', async () => {
    const places = [];
    window.addEventListener('woodshed:place', e => places.push(e.detail), {once: true});
    make();
    expect(router.current.value).toBeNull();
    await router.start();
    expect(log).toEqual(['mount library']);
    expect(root.dataset.place).toBe('library');
    expect(root.hasAttribute('data-posture')).toBe(false);
    expect(root.style.colorScheme).toBe('light');
    expect(places).toEqual([{place: 'library', posture: null}]);
    expect(root.dataset.viewReady).toBe('library');
    const m = router.current.value;
    expect([m.name, m.path, m.params, m.query, m.route.place]).toEqual(['library', '/', {}, {}, 'library']);
    expect(history.state).toMatchObject({ws: 1, idx: 0, scroll: 0, focus: null});
    const ctx = views.library.instances[0].ctx;
    expect(ctx.router).toBe(router);
    expect(ctx.store).toBe(store);
    expect(ctx.getSession).toBeUndefined();
  });

  test('color-scheme is dark on a dark Stage or with a dark theme; theme-color goes through woodshedAppearance.refresh', async () => {
    window.woodshedAppearance = {refresh: vi.fn()};
    root.dataset.theme = 'light';
    root.dataset.stageTheme = 'dark';
    make();
    await router.start();
    expect(root.style.colorScheme).toBe('light');
    await router.navigate('/s/x');
    expect(root.dataset.place).toBe('stage');
    expect(root.dataset.posture).toBe('stage');
    expect(root.style.colorScheme).toBe('dark');
    expect(window.woodshedAppearance.refresh).toHaveBeenCalled();
    root.dataset.stageTheme = 'light';
    await router.navigate('/s/x/edit/map');
    expect(root.dataset.posture).toBe('edit');
    expect(root.style.colorScheme).toBe('light');
    root.dataset.theme = 'dark';
    await router.navigate('/settings');
    expect(root.style.colorScheme).toBe('dark');
  });

  test('data-view-ready is removed when the next navigation starts and set after its mount resolves', async () => {
    make();
    await router.start();
    let release;
    views.settings.mount.mockImplementationOnce(async el => { await new Promise(r => { release = r; }); el.textContent = 'S'; return {}; });
    const done = router.navigate('/settings');
    expect(root.hasAttribute('data-view-ready')).toBe(false);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(root.hasAttribute('data-view-ready')).toBe(false);
    release();
    await done;
    expect(root.dataset.viewReady).toBe('settings');
  });

  test('a superseded navigation never reports ready; the last one wins', async () => {
    make();
    await router.start();
    router.navigate('/settings');
    router.navigate('/s/one');
    await router.navigate('/s/two');
    expect(root.dataset.viewReady).toBe('stage');
    expect(router.current.value.params.songId).toBe('two');
    expect(outlet.textContent).toBe('stage');
    expect(log.filter(l => l.startsWith('mount')).at(-1)).toBe('mount stage (two)');
    expect(log).toContain('unmount library');
  });

  test('a failing mount is reported and marked, not left half-ready', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    views.settings.mount.mockRejectedValueOnce(new Error('broken view'));
    make();
    await router.start();
    await router.navigate('/settings');
    expect(error).toHaveBeenCalled();
    expect(root.dataset.viewError).toBe('settings');
    expect(root.hasAttribute('data-view-ready')).toBe(false);
    await router.navigate('/');
    expect(root.dataset.viewReady).toBe('library');
    expect(root.hasAttribute('data-view-error')).toBe(false);
  });

  test('a module with a default export is accepted', async () => {
    const routes = [{name: 'library', path: '/', place: 'library', view: () => Promise.resolve({default: {mount: el => { el.textContent = 'default'; return {}; }}})}];
    router = createRouter({routes, outlet});
    await router.start();
    expect(outlet.textContent).toBe('default');
  });
});

describe('failed mounts', () => {
  test('a view that throws after rendering leaves an empty outlet; the next view mounts alone', async () => {
    views.stage = {mount: vi.fn(async el => {
      el.append(Object.assign(document.createElement('p'), {textContent: 'STAGE-PARTIAL'}));
      throw new Error('boom');
    }), instances: []};
    vi.spyOn(console, 'error').mockImplementation(() => {});
    at('/s/abc');
    make();
    await router.start();
    expect(root.dataset.viewError).toBe('stage');
    expect(outlet.textContent).toBe('');
    await router.navigate('/settings');
    expect(outlet.textContent).toBe('settings');
    expect(root.dataset.viewReady).toBe('settings');
    expect(root.hasAttribute('data-view-error')).toBe(false);
  });
});

describe('history rules', () => {
  test('push for place changes and opening a song; replace for Edit tab switches', async () => {
    make();
    await router.start();
    const length = history.length;
    await router.navigate('/s/song1');
    expect(history.length).toBe(length + 1);
    expect(history.state.idx).toBe(1);
    await router.navigate('/s/song1/edit/map');   // entering Edit pushes
    expect(history.length).toBe(length + 2);
    await router.navigate('/s/song1/edit/chart'); // a tab switch replaces
    expect(history.length).toBe(length + 2);
    expect(here()).toBe('/s/song1/edit/chart');
    await router.navigate('/s/song1/edit/map/find');
    expect(history.length).toBe(length + 2);
    expect(router.current.value.params).toEqual({songId: 'song1', tab: 'map', find: true});
    await router.navigate('/settings', {replace: true});
    expect(history.length).toBe(length + 2);
    await router.navigate('/settings');           // the same URL never stacks
    expect(history.length).toBe(length + 2);
  });

  test('same route name and same view gets update(); anything else unmounts then mounts (§2.3)', async () => {
    make();
    await router.start();
    await router.navigate('/s/s1/edit/map');
    await router.navigate('/s/s1/edit/chart');
    expect(views.edit.mount).toHaveBeenCalledTimes(1);
    expect(views.edit.instances[0].update).toHaveBeenCalledTimes(1);
    // editFind shares the edit view module but is another route name: remount, keeping the session.
    log.length = 0;
    await router.navigate('/s/s1/edit/map/find');
    expect(views.edit.mount).toHaveBeenCalledTimes(2);
    expect(log).toEqual(['unmount edit', 'mount edit (s1)']);
    expect(views.edit.instances[1].update).not.toHaveBeenCalled();
    await router.navigate('/settings');
    await router.navigate('/settings/plan');
    expect(views.settings.mount).toHaveBeenCalledTimes(2);
    expect(log.slice(-5)).toEqual(['unmount edit', 'disposeSession s1', 'mount settings', 'unmount settings', 'mount settings']);
    expect(router.current.value.params).toEqual({section: 'plan'});
    await router.navigate('/settings/account');
    expect(views.settings.mount).toHaveBeenCalledTimes(2);
    expect(log.at(-1)).toBe('update settings settingsPage');
  });

  test('an Edit tab outside the list does not match, and unknown paths go home', async () => {
    at('/s/x/edit/bogus');
    make();
    await router.start();
    expect(here()).toBe('/');
    expect(root.dataset.viewReady).toBe('library');
  });

  test('paths that are not app routes (boot routes, other origins) load the page instead', async () => {
    make();
    await router.start();
    await router.navigate('/download');
    await router.navigate(`/share/${'a'.repeat(64)}`);
    await router.navigate('https://elsewhere.test/x');
    expect(assign.mock.calls.map(c => c[0])).toEqual([
      `${location.origin}/download`, `${location.origin}/share/${'a'.repeat(64)}`, 'https://elsewhere.test/x']);
    expect(here()).toBe('/');
  });

  test('legacy redirects are applied with replace before the first mount', async () => {
    at('/?song=abc');
    make();
    const length = history.length;
    await router.start();
    expect(here()).toBe('/s/abc');
    expect(history.length).toBe(length);
    expect(log).toEqual(['getSession abc', 'mount stage (abc)']);
    await router.stop();
    log = [];
    at('/billing?checkout=success');
    make();
    await router.start();
    expect(here()).toBe('/settings/plan?checkout=success');
    expect(router.current.value).toMatchObject({name: 'settingsPage', params: {section: 'plan'}, query: {checkout: 'success'}});
  });

  test('navigate() applies the redirects too', async () => {
    make();
    await router.start();
    await router.navigate('/billing');
    expect(here()).toBe('/settings/plan');
  });

  test('navigate state is exposed on the match', async () => {
    make();
    await router.start();
    await router.navigate('/s/x', {state: {from: 'palette'}});
    expect(router.current.value.state).toEqual({from: 'palette'});
  });
});

describe('sessions', () => {
  test('Stage ↔ Edit with the same song keeps one session; leaving disposes it after the view unmounts', async () => {
    make();
    await router.start();
    await router.navigate('/s/s1');
    await router.navigate('/s/s1/edit/map');
    await router.navigate('/s/s1');
    expect(log.filter(l => l.startsWith('getSession'))).toEqual(['getSession s1']);
    expect(views.edit.instances[0].ctx.session).toEqual({id: 's1'});
    log = [];
    await router.navigate('/');
    expect(log).toEqual(['unmount stage', 'disposeSession s1', 'mount library']);
  });

  test('another song disposes the previous session and opens the new one', async () => {
    make();
    await router.start();
    await router.navigate('/s/s1');
    log = [];
    await router.navigate('/s/s2');
    expect(log).toEqual(['unmount stage', 'disposeSession s1', 'getSession s2', 'mount stage (s2)']);
  });

  test('without ctx.getSession the router opens and disposes sessions through src/stage/session.js', async () => {
    const opened = {id: 's1', from: 'session.js'};
    sessionModule.getSession = vi.fn(async id => { log.push(`module getSession ${id}`); return opened; });
    sessionModule.disposeSession = vi.fn(async id => { log.push(`module disposeSession ${id}`); });
    router = createRouter({routes: makeRoutes(), outlet, ctx: {store}});
    await router.start();
    await router.navigate('/s/s1');
    expect(sessionModule.getSession).toHaveBeenCalledWith('s1');
    expect(views.stage.instances[0].ctx.session).toBe(opened);
    expect(views.stage.instances[0].ctx).not.toHaveProperty('getSession');
    expect(root.dataset.viewReady).toBe('stage');
    log = [];
    await router.navigate('/');
    expect(sessionModule.disposeSession).toHaveBeenCalledWith('s1');
    expect(log).toEqual(['unmount stage', 'module disposeSession s1', 'mount library']);
  });
});

describe('modal routes', () => {
  test('/add mounts over a still-mounted Library; Back closes it', async () => {
    make();
    await router.start();
    await router.navigate('/add?q=hello');
    expect(views.library.instances[0].unmount).not.toHaveBeenCalled();
    const overlay = document.querySelector('[data-modal-outlet]');
    expect(overlay.textContent).toBe('add');
    expect(outlet.querySelector('[data-scroller]')).not.toBeNull();
    expect(root.dataset.viewReady).toBe('add');
    expect(root.dataset.place).toBe('library');
    expect(router.current.value.query).toEqual({q: 'hello'});
    log = [];
    history.back();
    await router.settled();
    expect(here()).toBe('/');
    expect(log).toEqual(['unmount add', 'update library library']);
    expect(overlay.childNodes).toHaveLength(0);
    expect(root.dataset.viewReady).toBe('library');
  });

  test('a deep link to /add mounts the Library underneath first', async () => {
    at('/add');
    make();
    await router.start();
    expect(log).toEqual(['mount library', 'mount add']);
  });

  test('leaving /add for a song unmounts both layers', async () => {
    make();
    await router.start();
    await router.navigate('/add');
    log = [];
    await router.navigate('/s/new');
    expect(log).toEqual(['unmount add', 'unmount library', 'getSession new', 'mount stage (new)']);
  });

  test('a provided modalOutlet is used', async () => {
    const modalOutlet = document.createElement('section');
    document.body.append(modalOutlet);
    router = createRouter({routes: makeRoutes(), outlet, modalOutlet, ctx: {store}});
    await router.start();
    await router.navigate('/add');
    expect(modalOutlet.textContent).toBe('add');
  });
});

describe('scroll and focus restoration', () => {
  test('Back from the Stage restores the Library scroll and refocuses the opened card', async () => {
    make();
    await router.start();
    const scroller = outlet.querySelector('[data-scroller]');
    scroller.scrollTop = 320;
    outlet.querySelector('[data-focus-key="song:b"]').focus();
    await router.navigate('/s/b');
    expect(history.state.scroll).toBe(0);
    history.back();
    await router.settled();
    expect(here()).toBe('/');
    const fresh = outlet.querySelector('[data-scroller]');
    expect(fresh).not.toBe(scroller);            // remounted…
    expect(fresh.scrollTop).toBe(320);           // …and restored
    expect(document.activeElement).toBe(outlet.querySelector('[data-focus-key="song:b"]'));
    expect(history.state).toMatchObject({scroll: 320, focus: 'song:b'});
  });

  test('Forward restores the entry we left with Back (from memory)', async () => {
    make();
    await router.start();
    await router.navigate('/settings');
    const sc = document.createElement('div');
    sc.setAttribute('data-scroller', '');
    outlet.append(sc);
    sc.scrollTop = 75;
    history.back();
    await router.settled();
    views.settings.mount.mockImplementation(async el => {
      const s = document.createElement('div');
      s.setAttribute('data-scroller', '');
      el.replaceChildren(s);
      return {};
    });
    history.forward();
    await router.settled();
    expect(here()).toBe('/settings');
    expect(outlet.querySelector('[data-scroller]').scrollTop).toBe(75);
  });

  test('pagehide saves the scroll and focus into the current entry (reload restores it)', async () => {
    make();
    await router.start();
    outlet.querySelector('[data-scroller]').scrollTop = 42;
    outlet.querySelector('[data-focus-key="song:c"]').focus();
    window.dispatchEvent(new Event('pagehide'));
    expect(history.state).toMatchObject({scroll: 42, focus: 'song:c'});
    await router.stop();
    make();
    await router.start();   // a reload keeps the entry and restores it
    expect(outlet.querySelector('[data-scroller]').scrollTop).toBe(42);
    expect(document.activeElement?.dataset.focusKey).toBe('song:c');
  });
});

describe('guards', () => {
  test('a failed guard replaces the URL with / and toasts', async () => {
    make();
    await router.start();
    const length = history.length;
    await router.navigate('/admin');
    expect(here()).toBe('/');
    expect(feedback.toast).toHaveBeenCalledWith(GUARD_TOAST);
    expect(GUARD_TOAST).toBe('Administration is for admins.');
    expect(views.admin.mount).not.toHaveBeenCalled();
    expect(history.length).toBe(length + 1);
    expect(root.dataset.viewReady).toBe('library');
  });

  test('a deep link works once store.session says admin (set before start, boot step 4)', async () => {
    at('/admin');
    store.session.value = {...store.session.peek(), admin: true};
    make();
    await router.start();
    expect(root.dataset.viewReady).toBe('admin');
    expect(feedback.toast).not.toHaveBeenCalled();
  });
});

describe('onLeave', () => {
  test('runs on navigation (from, to), on pagehide and on hidden (to = null); never blocks', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    make();
    await router.start();
    await router.navigate('/s/s1');
    const calls = [];
    const off = router.onLeave((from, to) => { calls.push([from.name, to?.name ?? null]); });
    router.onLeave(() => { throw new Error('sync failure'); });
    router.onLeave(() => Promise.reject(new Error('async failure')));
    router.onLeave(() => new Promise(() => {}));   // never settles: must not hold navigation
    await router.navigate('/');
    expect(calls).toEqual([['stage', 'library']]);
    expect(root.dataset.viewReady).toBe('library');
    window.dispatchEvent(new Event('pagehide'));
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
    expect(calls).toEqual([['stage', 'library'], ['library', null], ['library', null]]);
    await Promise.resolve();
    expect(error).toHaveBeenCalled();
    off();
    await router.navigate('/settings');
    expect(calls).toHaveLength(3);
  });

  test('runs on popstate (browser Back) before the views change', async () => {
    make();
    await router.start();
    await router.navigate('/s/s1');
    const calls = [];
    router.onLeave((from, to) => calls.push([from.path, to.path, outlet.textContent]));
    history.back();
    await router.settled();
    expect(calls).toEqual([['/s/s1', '/', 'stage']]);
  });
});

describe('back()', () => {
  test('history.back() when the previous entry is ours, else navigate(fallback)', async () => {
    at('/s/deep');
    make();
    await router.start();
    const spy = vi.spyOn(history, 'back');
    await router.back();
    expect(spy).not.toHaveBeenCalled();
    expect(here()).toBe('/');
    await router.navigate('/settings');
    router.back();
    await router.settled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(here()).toBe('/');
    await router.stop();
    at('/settings/plan');
    make();
    await router.start();
    await router.back({fallback: '/settings'});
    expect(here()).toBe('/settings');
  });
});

describe('setQuery', () => {
  test('replaces the URL, removes null keys, keeps the history state and updates current', async () => {
    make();
    await router.start();
    const length = history.length;
    const key = history.state.key;
    router.setQuery({q: 'blue', sort: 'artist'});
    expect(here()).toBe('/?q=blue&sort=artist');
    router.setQuery({sort: null, filter: 'review'});
    expect(here()).toBe('/?q=blue&filter=review');
    expect(history.length).toBe(length);
    expect(history.state.key).toBe(key);
    expect(router.current.value.query).toEqual({q: 'blue', filter: 'review'});
    expect(views.library.instances[0].update).not.toHaveBeenCalled();
  });

  test('debounces and merges; a navigation flushes the pending write onto the old entry', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      make();
      await router.start();
      router.setQuery({q: 'b'}, {debounceMs: 400});
      router.setQuery({q: 'bl', group: 'album'}, {debounceMs: 400});
      expect(here()).toBe('/');
      vi.advanceTimersByTime(399);
      expect(here()).toBe('/');
      vi.advanceTimersByTime(1);
      expect(here()).toBe('/?q=bl&group=album');
      router.setQuery({q: 'blue'}, {debounceMs: 400});
      const done = router.navigate('/s/x');
      await done;
      history.back();
      await router.settled();
      expect(here()).toBe('/?q=blue&group=album');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a debounced write still pending at browser Back is dropped, not written onto the entry Back lands on', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      at('/s/abc');
      make();
      await router.start();
      await router.navigate('/');
      router.setQuery({q: 'foo'}, {debounceMs: 50});
      history.back();
      await router.settled();
      vi.advanceTimersByTime(80);
      expect(here()).toBe('/s/abc');
      expect(router.current.peek().query).toEqual({});
      expect(router.current.peek().name).toBe('stage');
    } finally {
      vi.useRealTimers();
    }
  });

  test('router.back() writes a pending debounced query onto the entry it leaves', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      make();
      await router.start();
      await router.navigate('/settings');
      router.setQuery({q: 'plan'}, {debounceMs: 400});
      router.back();
      await router.settled();
      vi.advanceTimersByTime(500);
      expect(here()).toBe('/');
      history.forward();
      await router.settled();
      expect(here()).toBe('/settings?q=plan');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('href and link', () => {
  test('href builds paths with encoded params and a clean query', () => {
    make();
    expect(router.href('stage', {songId: 'a b'})).toBe('/s/a%20b');
    expect(router.href('edit', {songId: 's1', tab: 'chart'})).toBe('/s/s1/edit/chart');
    expect(router.href('library', {}, {q: 'x', sort: null, filter: ''})).toBe('/?q=x');
    expect(router.href('editFind', {songId: 's1'})).toBe('/s/s1/edit/map/find');
    expect(() => router.href('stage')).toThrow(/songId/);
    expect(() => router.href('nope')).toThrow(/unknown route/);
  });

  test('link() routes plain same-origin clicks and lets everything else through', async () => {
    make();
    await router.start();
    const nav = document.createElement('nav');
    nav.innerHTML = '<a id="song" href="/s/s9"><span>Song</span></a><a id="dl" href="/download">Download</a>'
      + '<a id="ext" href="https://elsewhere.test/">Elsewhere</a><a id="tab" href="/settings" target="_blank">Tab</a>'
      + '<a id="native" href="/settings" data-native>Native</a>';
    document.body.append(nav);
    const off = router.link(nav);
    // Record whether the router took the click, then stop happy-dom from following the link for real.
    let routed = null;
    const stopNavigation = e => { routed = e.defaultPrevented; e.preventDefault(); };
    document.addEventListener('click', stopNavigation);
    const click = (id, init = {}) => {
      const a = document.getElementById(id);
      (a.firstElementChild ?? a).dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0, ...init}));
      return {defaultPrevented: routed};
    };
    expect(click('song', {metaKey: true}).defaultPrevented).toBe(false);
    expect(click('dl').defaultPrevented).toBe(false);
    expect(click('ext').defaultPrevented).toBe(false);
    expect(click('tab').defaultPrevented).toBe(false);
    expect(click('native').defaultPrevented).toBe(false);
    expect(click('song').defaultPrevented).toBe(true);
    await router.settled();
    expect(here()).toBe('/s/s9');
    off();
    expect(click('song').defaultPrevented).toBe(false);
    document.removeEventListener('click', stopNavigation);
  });
});

describe('intended route', () => {
  test('stash stores path + query in sessionStorage; take returns it once', () => {
    at('/s/s1?bar=57');
    stashIntendedRoute();
    expect(sessionStorage.getItem(INTENDED_ROUTE_KEY)).toBe('/s/s1?bar=57');
    expect(takeIntendedRoute()).toBe('/s/s1?bar=57');
    expect(takeIntendedRoute()).toBeNull();
    sessionStorage.setItem(INTENDED_ROUTE_KEY, '//evil.test/x');
    expect(takeIntendedRoute()).toBeNull();
    expect(sessionStorage.getItem(INTENDED_ROUTE_KEY)).toBeNull();
  });

  test('start() navigates to the stashed route once, with replace, and deletes the key', async () => {
    at('/s/s1/edit/chart');
    make();
    router.stashIntendedRoute();
    at('/');
    const length = history.length;
    await router.start();
    expect(here()).toBe('/s/s1/edit/chart');
    expect(history.length).toBe(length);
    expect(sessionStorage.getItem(INTENDED_ROUTE_KEY)).toBeNull();
    expect(router.takeIntendedRoute()).toBeNull();
  });

  test('blocked sessionStorage is harmless', () => {
    const spy = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(() => stashIntendedRoute()).not.toThrow();
    expect(takeIntendedRoute()).toBeNull();
    spy.mockRestore();
  });
});
