// @vitest-environment happy-dom
// S1: src/app/routes.js (architecture §2.3, D2) and the placeholder view it falls back to.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {bootRoutes, matchBootRoute, redirects, routes, view} from '../src/app/routes.js';
import * as placeholder from '../src/app/placeholder.js';
import {createRouter} from '../src/app/router.js';
import {signal} from '../src/app/store.js';
import {openOverlays, startDispatcher} from '../src/app/dispatch.js';
import {keydown} from './helpers/dom.js';

const root = document.documentElement;

describe('the route table (§2.3)', () => {
  // name, path, place, chrome, extras — exactly the contract's table.
  const TABLE = [
    ['library', '/', 'library', 'topbar', {}],
    ['add', '/add', 'library', 'topbar', {modalOver: 'library'}],
    ['welcome', '/welcome', 'library', 'none', {}],
    ['stage', '/s/:songId', 'stage', 'none', {posture: 'stage', session: true}],
    ['edit', '/s/:songId/edit/:tab', 'edit', 'none', {posture: 'edit', session: true, tabs: ['map', 'chart', 'details']}],
    ['editFind', '/s/:songId/edit/map/find', 'edit', 'none', {posture: 'edit', session: true, params: {tab: 'map', find: true}}],
    ['bulkDetails', '/edit/details', 'edit', 'none', {posture: 'edit'}],
    ['settings', '/settings', 'settings', 'topbar', {}],
    ['settingsPage', '/settings/:section', 'settings', 'topbar', {}],
    ['admin', '/admin', 'admin', 'topbar', {guard: true}],
    ['adminAccount', '/admin/accounts/:id', 'admin', 'topbar', {guard: true}],
    ['setlist', '/set/:id', 'library', 'topbar', {}],
  ];

  test.each(TABLE)('%s → %s', (name, path, place, chrome, extras) => {
    const route = routes.find(r => r.name === name);
    expect(route).toBeDefined();
    expect([route.path, route.place, route.chrome]).toEqual([path, place, chrome]);
    expect(typeof route.view).toBe('function');
    for (const [key, value] of Object.entries(extras)) {
      if (key === 'guard') {
        expect(route.guard({admin: true})).toBe(true);
        expect(route.guard({admin: false})).toBe(false);
        expect(route.guard({})).toBe(false);
      } else expect(route[key]).toEqual(value);
    }
  });

  test('the table has exactly these routes, in this order, and is frozen', () => {
    expect(routes.map(r => r.name)).toEqual(TABLE.map(r => r[0]));
    expect(Object.isFrozen(routes)).toBe(true);
    expect(Object.isFrozen(routes[0])).toBe(true);
  });

  test('Stage, Edit and Find share the session flag; Edit and Find share one view loader', () => {
    const by = Object.fromEntries(routes.map(r => [r.name, r]));
    expect(by.edit.view).toBe(by.editFind.view);
    expect(by.settings.view).toBe(by.settingsPage.view);
    expect(routes.filter(r => r.session).map(r => r.name)).toEqual(['stage', 'edit', 'editFind']);
  });
});

describe('view(path): the placeholder fallback (D2)', () => {
  test('a contract path with no file resolves to src/app/placeholder.js', async () => {
    const load = view('../library/no-such-view.js');
    const mod = await load();
    expect(mod.mount).toBe(placeholder.mount);
    expect(mod.boot).toBe(placeholder.boot);
  });

  test('a path the glob found resolves to its own loader', () => {
    const own = () => Promise.resolve({mount() {}});
    expect(view('../library/home.js', {'../library/home.js': own})).toBe(own);
    expect(view('../library/home.js', {})).not.toBe(own);
  });
});

describe('boot routes and redirects', () => {
  test.each([
    ['/download', 'download', {}],
    ['/download/', 'download', {}],
    [`/share/${'a'.repeat(64)}`, 'share', {token: 'a'.repeat(64)}],
    [`/share/${'b'.repeat(64)}/`, 'share', {token: 'b'.repeat(64)}],
    ['/share/not-a-token', 'share', {token: 'not-a-token'}],
  ])('%s boots %s', (path, name, params) => {
    const m = matchBootRoute(path);
    expect(m.name).toBe(name);
    expect(m.params).toEqual(params);
    expect(m.route).toBe(bootRoutes.find(r => r.name === name));
  });

  test.each(['/', '/s/abc', '/settings', '/downloads', '/share', '/share/a/b', '/admin'])('%s is an app route, not a boot route', path => {
    expect(matchBootRoute(path)).toBeNull();
  });

  test.each([
    ['/?song=abc', '/s/abc'],
    ['/billing', '/settings/plan'],
    ['/billing?checkout=success', '/settings/plan?checkout=success'],
  ])('%s redirects to %s', (from, to) => {
    const url = new URL(from, 'https://woodshed.test');
    const rule = redirects.find(r => r.from(url));
    expect(rule.to(url)).toBe(to);
  });

  test.each(['/', '/s/x', '/settings/plan', '/?q=song'])('%s is not redirected', path => {
    const url = new URL(path, 'https://woodshed.test');
    expect(redirects.some(r => r.from(url))).toBe(false);
  });
});

describe('the placeholder view', () => {
  let router, outlet, modalOutlet;

  beforeEach(() => {
    document.body.replaceChildren();
    outlet = document.createElement('main');
    modalOutlet = document.createElement('div');
    document.body.append(outlet, modalOutlet);
    for (const a of ['data-place', 'data-posture', 'data-view-ready']) root.removeAttribute(a);
    history.replaceState(null, '', '/');
  });
  afterEach(async () => {
    await router?.stop();
    router = null;
  });

  // The real table with every view on the placeholder (as before any view is built).
  const placeholderRoutes = () => routes.map(r => ({...r, view: () => import('../src/app/placeholder.js')}));
  const make = () => {
    router = createRouter({routes: placeholderRoutes(), redirects, outlet, modalOutlet,
      ctx: {store: {session: signal({admin: false})}, feedback: {toast: vi.fn()}, getSession: async id => ({id}), disposeSession: async () => {}}});
    return router;
  };

  test('each place mounts "Not built yet" with its title, inside one [data-scroller]', async () => {
    make();
    await router.start();
    expect(root.dataset.viewReady).toBe('library');
    expect(outlet.querySelectorAll('[data-scroller]')).toHaveLength(1);
    expect(outlet.textContent).toContain(placeholder.COPY.notBuilt);
    expect(outlet.querySelector('h1').textContent).toBe('Library');
    expect(outlet.querySelector('a')).toBeNull();   // no "Back to Library" on the Library itself
    await router.navigate('/s/song-1');
    expect(root.dataset.viewReady).toBe('stage');
    expect(outlet.querySelector('h1').textContent).toBe('Stage');
    const back = outlet.querySelector('a');
    expect(back.textContent).toBe(placeholder.COPY.back);
    expect(back.getAttribute('href')).toBe('/');
    await router.navigate('/settings/practice');
    await router.navigate('/settings/plan');   // same route name: update()
    expect(outlet.querySelector('h1').textContent).toBe('Settings');
    expect(outlet.querySelector('[data-placeholder]').dataset.placeholder).toBe('settingsPage');
  });

  // VF1-6 (§10.3): "Back to Library" is a Back, not a link to a new Library entry.
  test('"Back to Library" goes back through history and the opened card regains focus', async () => {
    // A Library with one focusable card, so the router has something to refocus on Back.
    const library = {mount(el) {
      const card = document.createElement('button');
      card.dataset.focusKey = 'song:song-1';
      const scroller = document.createElement('div');
      scroller.dataset.scroller = '';
      scroller.append(card);
      el.replaceChildren(scroller);
      return {update() {}, unmount() { scroller.remove(); }};
    }};
    router = createRouter({routes: placeholderRoutes().map(r => (r.name === 'library' ? {...r, view: async () => library} : r)),
      redirects, outlet, modalOutlet,
      ctx: {store: {session: signal({admin: false})}, feedback: {toast: vi.fn()}, getSession: async id => ({id}), disposeSession: async () => {}}});
    const unlink = router.link(outlet);   // main.js's link delegate must not turn it into a push
    try {
      await router.start();
      outlet.querySelector('[data-focus-key]').focus();
      await router.navigate('/s/song-1');
      const idx = history.state.idx;
      expect(idx).toBe(1);
      const navigate = vi.spyOn(router, 'navigate');
      const click = new MouseEvent('click', {bubbles: true, cancelable: true, button: 0});
      outlet.querySelector('a').dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(navigate).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(root.dataset.viewReady).toBe('library'));
      await router.settled();
      expect(location.pathname).toBe('/');
      expect(history.state.idx).toBe(idx - 1);
      expect(document.activeElement?.dataset.focusKey).toBe('song:song-1');
    } finally {
      unlink();
    }
  });

  test('"Back to Library" with no entry of ours behind it navigates to the Library (fallback)', async () => {
    history.replaceState(null, '', '/s/deep');
    make();
    await router.start();
    expect(root.dataset.viewReady).toBe('stage');
    const back = vi.spyOn(history, 'back');
    outlet.querySelector('a').click();
    await vi.waitFor(() => expect(root.dataset.viewReady).toBe('library'));
    expect(back).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/');
  });

  test('a modified click on "Back to Library" is left to the browser (new tab)', async () => {
    make();
    await router.start();
    await router.navigate('/s/song-1');
    const back = vi.spyOn(router, 'back');
    const click = new MouseEvent('click', {bubbles: true, cancelable: true, button: 0, metaKey: true});
    const link = outlet.querySelector('a');
    link.addEventListener('click', e => e.preventDefault(), {once: true});   // keep happy-dom from following it
    link.dispatchEvent(click);
    expect(back).not.toHaveBeenCalled();
  });

  test('a modal route (/add) mounts a modal panel over its parent; Esc and Close go back', async () => {
    const stop = startDispatcher();
    try {
      make();
      await router.start();
      const opener = outlet.querySelector('h1');
      await router.navigate('/add');
      const panel = modalOutlet.querySelector('[role=dialog]');
      expect(panel.getAttribute('aria-modal')).toBe('true');
      expect(document.getElementById(panel.getAttribute('aria-labelledby')).textContent).toBe('Add song');
      expect(outlet.querySelector('h1')).toBe(opener);   // the Library stays mounted underneath
      expect(document.activeElement.textContent).toBe(placeholder.COPY.close);
      expect(openOverlays().some(o => o.el === panel && o.modal)).toBe(true);
      const back = vi.spyOn(router, 'back').mockImplementation(() => {});
      keydown({key: 'Escape', code: 'Escape'});
      expect(back).toHaveBeenCalledWith({fallback: '/'});
      back.mockClear();
      document.activeElement.click();
      expect(back).toHaveBeenCalledTimes(1);
      await router.navigate('/');
      expect(modalOutlet.querySelector('[role=dialog]')).toBeNull();
      expect(openOverlays().some(o => o.el === panel)).toBe(false);
    } finally {
      stop();
    }
  });

  test('boot(match) renders a boot route as a page in #app', () => {
    const app = document.createElement('div');
    app.id = 'app';
    document.body.append(app);
    placeholder.boot(matchBootRoute('/download'));
    expect(app.dataset.chrome).toBe('none');
    expect(app.querySelector('h1').textContent).toBe('Get Woodshed for desktop');
    expect(root.dataset.viewReady).toBe('download');
  });

  test('CONTROLS: each control renders with its role and accessible name', async () => {
    make();
    await router.start();
    await router.navigate('/welcome');
    const roleOf = el => el.getAttribute('role') ?? {A: 'link', BUTTON: 'button'}[el.tagName];
    const named = (role, name) => [...document.querySelectorAll('a, button, [role]')]
      .some(el => roleOf(el) === role && (el.getAttribute('aria-label') ?? el.textContent).trim() === name);
    for (const row of placeholder.CONTROLS.filter(r => r.where === 'page')) expect(named(row.role, row.name), row.name).toBe(true);
    await router.navigate('/add');
    for (const row of placeholder.CONTROLS.filter(r => r.where === 'modal')) expect(named(row.role, row.name), row.name).toBe(true);
    const el = document.createElement('div');
    document.body.append(el);
    placeholder.renderSignIn(el, {signIn: vi.fn()});
    for (const row of placeholder.CONTROLS.filter(r => r.where === 'signin')) expect(named(row.role, row.name), row.name).toBe(true);
  });
});

describe('the placeholder sign-in card', () => {
  test('shows the OAuth error, runs signIn, and shows a failure inline', async () => {
    const el = document.createElement('div');
    document.body.replaceChildren(el);
    let fail;
    const signIn = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    const card = placeholder.renderSignIn(el, {error: {message: 'This sign-in link expired. Please sign in again.'}, signIn});
    const alert = el.querySelector('[role=alert]');
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain('This sign-in link expired.');
    expect(el.querySelector('h1').textContent).toBe(placeholder.COPY.signInTitle);
    const button = [...el.querySelectorAll('button')].find(b => b.textContent.includes(placeholder.COPY.signIn));
    button.click();
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(alert.hidden).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    fail(new Error('Could not start Google sign-in.'));
    await vi.waitFor(() => expect(alert.hidden).toBe(false));
    expect(alert.textContent).toContain('Could not start Google sign-in.');
    expect(button.hasAttribute('aria-busy')).toBe(false);
    card.destroy();
    expect(el.childElementCount).toBe(0);
  });

  test('without an error the alert stays hidden', () => {
    const el = document.createElement('div');
    placeholder.renderSignIn(el, {signIn: vi.fn()});
    expect(el.querySelector('[role=alert]').hidden).toBe(true);
  });
});
