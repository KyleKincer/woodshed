// History API router (architecture §2.3; spec §1.2).
//
//   const router = createRouter({routes, redirects, outlet, ctx});
//   await router.start();
//
// - Views are resolved through each route's `view()` loader and export
//   `mount(el, match, ctx) → {update(match), unmount()}` (either may be async).
//   The same route name with the same view module (and the same song for session
//   routes) gets update(match); anything else unmounts, then mounts. A mount that
//   throws leaves an empty outlet and html[data-view-error=<route name>].
// - `modalOver: '<route name>'` keeps that parent view mounted underneath and
//   mounts the modal view into an overlay outlet; Back closes it.
// - `session: true` routes get ctx.session from getSession(songId) (ctx.getSession,
//   else src/stage/session.js); leaving the song or session routes disposes it
//   after the old view unmounts.
// - A failed `guard(store.session)` replaces the URL with `/` and toasts.
// - Root attributes on every mount: html[data-place], [data-posture],
//   style.colorScheme and theme-color, then window `woodshed:place`; after the
//   mount resolves, html[data-view-ready=<route name>] (removed when the next
//   navigation starts).
// - history.state = {ws: 1, key, idx, scroll, focus, data}. Before leaving, the
//   [data-scroller] scrollTop and the focused [data-focus-key] are saved; Back and
//   Forward restore both after the mount resolves.
// - onLeave hooks run on every navigation away (from, to) and on pagehide and
//   visibilitychange → hidden (to = null). They never block navigation.
//
// Storage: only sessionStorage['ws.intendedRoute'] (guard §7.6).

import {signal, readonly} from './store.js';
import {now} from './clock.js';

export const INTENDED_ROUTE_KEY = 'ws.intendedRoute';
export const GUARD_TOAST = 'Administration is for admins.';

// The session module is wave 1a; resolving it by glob keeps a missing file harmless (D2).
const SESSION_MODULES = import.meta.glob('../stage/session.js');

// ---------- intended route (sign-in round trip) ----------

/** Remembers the current path + query so sign-in can return to it (desktop OAuth). */
export function stashIntendedRoute(win = globalThis.window) {
  try { win.sessionStorage.setItem(INTENDED_ROUTE_KEY, win.location.pathname + win.location.search); } catch { /* session only */ }
}

/** Returns the stashed route once (and deletes it), or null. */
export function takeIntendedRoute(win = globalThis.window) {
  try {
    const value = win.sessionStorage.getItem(INTENDED_ROUTE_KEY);
    win.sessionStorage.removeItem(INTENDED_ROUTE_KEY);
    return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : null;
  } catch {
    return null;
  }
}

// ---------- matching ----------

function compile(pattern) {
  const segments = pattern.split('/').filter(Boolean);
  return segments.map(s => (s.startsWith(':') ? {param: s.slice(1)} : {literal: s}));
}

function matchPath(compiled, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== compiled.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    const seg = compiled[i];
    let part;
    try { part = decodeURIComponent(parts[i]); } catch { return null; }
    if (seg.literal !== undefined) { if (seg.literal !== part) return null; }
    else params[seg.param] = part;
  }
  return params;
}

const queryOf = url => Object.fromEntries(url.searchParams.entries());

const pathOf = url => url.pathname + url.search + url.hash;

let keySeq = 0;
const newKey = () => `${now().toString(36)}.${(++keySeq).toString(36)}`;

const isOurs = st => !!st && typeof st === 'object' && st.ws === 1 && typeof st.key === 'string';

/**
 * @param {{routes: object[], redirects?: object[], outlet: Element, ctx?: object,
 *          modalOutlet?: Element, window?: Window, assign?: (href: string) => void}} options
 */
export function createRouter({routes, redirects = [], outlet, ctx = {}, modalOutlet = null, window: win = globalThis.window,
  assign = href => win.location.assign(href)} = {}) {
  if (!Array.isArray(routes) || !routes.length) throw new TypeError('createRouter: routes required');
  if (!outlet) throw new TypeError('createRouter: outlet required');
  const doc = outlet.ownerDocument;
  const root = doc.documentElement;
  const table = routes.map(route => ({route, compiled: compile(route.path)}));
  const byName = new Map(routes.map(r => [r.name, r]));

  const current = signal(null);
  const leaveHooks = new Set();
  const scrollMemory = new Map();   // entry key → {scroll, focus}, for entries we left through popstate
  let base = null;                  // {match, module, instance}
  let modal = null;                 // {match, module, instance}
  let session = null;               // {songId, value}
  let started = false;
  let running = null;
  let wanted = null;
  let pendingQuery = null, queryTimer = null;
  let overlay = modalOutlet;
  let lastKey = null;               // history key of the entry the views currently show

  // ---------- helpers ----------

  function match(url, state = null) {
    for (const {route, compiled} of table) {
      const params = matchPath(compiled, url.pathname);
      if (!params) continue;
      if (route.tabs && params.tab !== undefined && !route.tabs.includes(params.tab)) continue;
      return {name: route.name, path: url.pathname, params: {...params, ...(route.params || {})}, query: queryOf(url), state, route};
    }
    return null;
  }

  function applyRedirects(url) {
    for (let hops = 0; hops < 5; hops++) {
      const rule = redirects.find(r => r.from(url));
      if (!rule) break;
      url = new URL(rule.to(url), url.origin);
    }
    return url;
  }

  const here = () => new URL(win.location.href);
  const entry = () => (isOurs(win.history.state) ? win.history.state : null);
  const makeEntry = (data, idx) => ({ws: 1, key: newKey(), idx, scroll: 0, focus: null, data: data ?? null});

  function scroller() { return outlet.querySelector('[data-scroller]'); }

  function captureView() {
    const sc = scroller();
    const active = doc.activeElement;
    const keyed = active && active !== doc.body ? active.closest?.('[data-focus-key]') : null;
    return {scroll: sc ? sc.scrollTop : 0, focus: keyed ? keyed.getAttribute('data-focus-key') : null};
  }

  function saveCurrentEntry() {
    const st = entry();
    if (!st || !current.peek()) return;
    const view = captureView();
    scrollMemory.set(st.key, view);
    try { win.history.replaceState({...st, ...view}, '', pathOf(here())); } catch { /* state too large or blocked */ }
  }

  function restoreView(st) {
    if (!st) return;
    const saved = scrollMemory.get(st.key) ?? {scroll: st.scroll, focus: st.focus};
    const sc = scroller();
    if (sc && Number.isFinite(saved.scroll)) sc.scrollTop = saved.scroll;
    if (saved.focus) {
      const target = [...outlet.querySelectorAll('[data-focus-key]')].find(el => el.getAttribute('data-focus-key') === saved.focus);
      target?.focus?.({preventScroll: true});
    }
  }

  function callLeave(from, to) {
    if (!from) return;
    for (const fn of [...leaveHooks]) {
      try {
        const result = fn(from, to);
        if (result && typeof result.then === 'function') result.then(undefined, err => console.error('[router] onLeave failed', err));
      } catch (err) {
        console.error('[router] onLeave failed', err);
      }
    }
  }

  function setRootAttributes(m) {
    const {place, posture} = m.route;
    if (place) root.dataset.place = place; else delete root.dataset.place;
    if (posture) root.dataset.posture = posture; else delete root.dataset.posture;
    const dark = (place === 'stage' && root.dataset.stageTheme === 'dark') || root.dataset.theme === 'dark';
    root.style.colorScheme = dark ? 'dark' : 'light';
    const appearance = win.woodshedAppearance;
    if (appearance && typeof appearance.refresh === 'function') {
      appearance.refresh();
      root.style.colorScheme = dark ? 'dark' : 'light';
    } else {
      const bg = win.getComputedStyle?.(root)?.getPropertyValue?.('--bg')?.trim();
      if (bg) doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
    }
    win.dispatchEvent(new win.CustomEvent('woodshed:place', {detail: {place: place ?? null, posture: posture ?? null}}));
  }

  async function load(route) {
    const mod = await route.view();
    return mod && typeof mod.mount !== 'function' && mod.default && typeof mod.default.mount === 'function' ? mod.default : mod;
  }

  const songOf = m => (m && m.route.session ? m.params.songId ?? null : null);

  async function unmountLayer(layer, el) {
    try { await layer.instance?.unmount?.(); }
    catch (err) { console.error(`[router] unmount of ${layer.match.name} failed`, err); }
    el.replaceChildren();
  }

  function sessionApi() {
    const loader = SESSION_MODULES['../stage/session.js'];
    return {
      async get(id) {
        if (typeof ctx.getSession === 'function') return ctx.getSession(id);
        return loader ? (await loader()).getSession(id) : null;
      },
      async dispose(id) {
        if (typeof ctx.disposeSession === 'function') return ctx.disposeSession(id);
        if (loader) return (await loader()).disposeSession(id);
      },
    };
  }

  async function settleSession(nextSongId) {
    if (session && session.songId !== nextSongId) {
      const id = session.songId;
      session = null;
      try { await sessionApi().dispose(id); } catch (err) { console.error('[router] disposeSession failed', err); }
    }
    if (nextSongId && !session) session = {songId: nextSongId, value: await sessionApi().get(nextSongId)};
    return nextSongId ? session.value : undefined;
  }

  function viewCtx(sessionValue) {
    const out = {...ctx, router};
    delete out.getSession;
    delete out.disposeSession;
    if (sessionValue !== undefined) out.session = sessionValue;
    return out;
  }

  function overlayOutlet() {
    if (overlay) return overlay;
    overlay = doc.createElement('div');
    overlay.setAttribute('data-modal-outlet', '');
    if (outlet.parentNode) outlet.after(overlay); else doc.body.appendChild(overlay);
    return overlay;
  }

  async function mountInto(el, m, mod, sessionValue) {
    setRootAttributes(m);
    let instance;
    try {
      instance = await mod.mount(el, m, viewCtx(sessionValue));
    } catch (err) {
      el.replaceChildren();   // never leave a half-built view for the next one to mount beside
      throw err;
    }
    return {match: m, module: mod, instance: instance || {}};
  }

  async function showBase(m, {keep = false} = {}) {
    const mod = await load(m.route);
    const reusable = base && base.module === mod && base.match.name === m.name && songOf(base.match) === songOf(m);
    if (reusable) {
      if (keep) return;
      setRootAttributes(m);
      await base.instance.update?.(m);
      base.match = m;
      return;
    }
    if (base) { const old = base; base = null; await unmountLayer(old, outlet); }
    const sessionValue = await settleSession(songOf(m));
    base = await mountInto(outlet, m, mod, sessionValue);
  }

  async function showModal(m) {
    const parentRoute = byName.get(m.route.modalOver);
    if (!parentRoute) throw new Error(`router: modalOver names an unknown route ${m.route.modalOver}`);
    const parent = base && base.match.route === parentRoute ? base.match
      : {name: parentRoute.name, path: parentRoute.path, params: {...(parentRoute.params || {})}, query: {}, state: null, route: parentRoute};
    await showBase(parent, {keep: true});
    const mod = await load(m.route);
    const el = overlayOutlet();
    if (modal && modal.module === mod && modal.match.name === m.name) {
      setRootAttributes(m);
      await modal.instance.update?.(m);
      modal.match = m;
      return;
    }
    if (modal) { const old = modal; modal = null; await unmountLayer(old, el); }
    modal = await mountInto(el, m, mod, undefined);
  }

  function guardOk(route) {
    if (typeof route.guard !== 'function') return true;
    try { return !!route.guard(ctx.store?.session?.peek?.() ?? {}); } catch { return false; }
  }

  async function transition({restore}) {
    root.removeAttribute('data-view-ready');
    delete root.dataset.viewError;
    let st = entry();
    let m = match(here(), st?.data ?? null);
    if (!m) {
      // An in-app URL we do not know: go home.
      win.history.replaceState(makeEntry(null, st?.idx ?? 0), '', '/');
      st = entry();
      m = match(here(), null);
    } else if (!guardOk(m.route)) {
      win.history.replaceState(makeEntry(null, st?.idx ?? 0), '', '/');
      st = entry();
      m = match(here(), null);
      try { ctx.feedback?.toast?.(GUARD_TOAST); } catch (err) { console.error(err); }
    }
    if (!st) { win.history.replaceState(makeEntry(null, 0), '', pathOf(here())); st = entry(); }
    current.value = m;
    try {
      if (m.route.modalOver) {
        await showModal(m);
      } else {
        if (modal) { const old = modal; modal = null; await unmountLayer(old, overlayOutlet()); }
        await showBase(m);
      }
    } catch (err) {
      console.error(`[router] could not show ${m.name}`, err);
      root.dataset.viewError = m.name;
      return;
    }
    if (wanted) return;   // superseded while mounting; the next transition finishes the job
    if (restore) restoreView(st);
    root.dataset.viewReady = m.name;
  }

  function schedule({restore = false} = {}) {
    wanted = {restore: restore || !!wanted?.restore};
    if (!running) {
      running = (async () => {
        try {
          while (wanted) {
            const next = wanted;
            wanted = null;
            await transition(next);
          }
        } finally {
          running = null;
        }
      })();
    }
    return running;
  }

  function flushQuery() {
    clearTimeout(queryTimer);
    queryTimer = null;
    if (!pendingQuery) return;
    const patch = pendingQuery;
    pendingQuery = null;
    const url = here();
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') url.searchParams.delete(k);
      else url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    win.history.replaceState(win.history.state, '', pathOf(url));
    const m = current.peek();
    if (m) current.value = {...m, query: queryOf(url)};
  }

  const isEditSwitch = (from, to) => !!from && from.route.posture === 'edit' && to.route.posture === 'edit'
    && !!from.params.songId && from.params.songId === to.params.songId;

  // ---------- listeners ----------

  function onPopState() {
    // The URL has already moved to another entry: a debounced query patch meant for the entry we
    // left cannot be applied there any more, and must not land on this one.
    clearTimeout(queryTimer);
    queryTimer = null;
    pendingQuery = null;
    const from = current.peek();
    const left = base || modal ? lastKey : null;
    if (left) scrollMemory.set(left, captureView());
    const to = match(here(), entry()?.data ?? null);
    if (!from || !to || from.path !== to.path) callLeave(from, to);
    lastKey = entry()?.key ?? null;
    schedule({restore: true});
  }

  function onPageHide() {
    flushQuery();
    saveCurrentEntry();
    callLeave(current.peek(), null);
  }

  function onVisibility() {
    if (doc.visibilityState === 'hidden') callLeave(current.peek(), null);
  }

  // ---------- public ----------

  const router = {
    current: readonly(current),

    start() {
      if (started) return running ?? Promise.resolve();
      started = true;
      try { if ('scrollRestoration' in win.history) win.history.scrollRestoration = 'manual'; } catch { /* read-only */ }
      const intended = takeIntendedRoute(win);
      let url = intended ? new URL(intended, win.location.origin) : here();
      url = applyRedirects(url);
      const st = entry();
      // A stashed route replaces this entry with a fresh one; a reload keeps its entry (and its scroll).
      const keep = st && !intended ? st : null;
      win.history.replaceState(keep ?? makeEntry(null, st?.idx ?? 0), '', pathOf(url));
      lastKey = entry().key;
      win.addEventListener('popstate', onPopState);
      win.addEventListener('pagehide', onPageHide);
      doc.addEventListener('visibilitychange', onVisibility);
      return schedule({restore: !!keep});
    },

    navigate(to, {replace = false, state} = {}) {
      flushQuery();
      let url;
      try { url = new URL(String(to), win.location.href); } catch { return Promise.resolve(); }
      if (url.origin !== win.location.origin) { assign(url.href); return Promise.resolve(); }
      url = applyRedirects(url);
      const target = match(url, state ?? null);
      if (!target) { assign(url.href); return Promise.resolve(); }   // boot routes (/share, /download) load the page
      const from = current.peek();
      if (!replace && (pathOf(url) === pathOf(here()) || isEditSwitch(from, target))) replace = true;
      if (!from || from.path !== target.path) callLeave(from, target);
      saveCurrentEntry();
      const idx = entry()?.idx ?? 0;
      const next = makeEntry(state, replace ? idx : idx + 1);
      if (replace) win.history.replaceState(next, '', pathOf(url));
      else win.history.pushState(next, '', pathOf(url));
      lastKey = next.key;
      return schedule({restore: false});
    },

    back({fallback = '/'} = {}) {
      const st = entry();
      if (st && st.idx > 0) { flushQuery(); win.history.back(); return; }
      return router.navigate(fallback);
    },

    setQuery(patch, {debounceMs = 0} = {}) {
      pendingQuery = {...(pendingQuery || {}), ...patch};
      if (debounceMs > 0) {
        clearTimeout(queryTimer);
        queryTimer = setTimeout(flushQuery, debounceMs);
      } else {
        flushQuery();
      }
    },

    href(name, params = {}, query = {}) {
      const route = byName.get(name);
      if (!route) throw new Error(`router.href: unknown route ${name}`);
      const path = route.path.replace(/:(\w+)/g, (_, k) => {
        const v = params[k] ?? route.params?.[k];
        if (v == null) throw new Error(`router.href: ${name} needs :${k}`);
        return encodeURIComponent(String(v));
      });
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query || {})) {
        if (v == null || v === '') continue;
        qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
      }
      const search = qs.toString();
      return search ? `${path}?${search}` : path;
    },

    onLeave(fn) {
      leaveHooks.add(fn);
      return () => leaveHooks.delete(fn);
    },

    stashIntendedRoute: () => stashIntendedRoute(win),
    takeIntendedRoute: () => takeIntendedRoute(win),

    link(el) {
      const onClick = e => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const a = e.target?.closest?.('a[href]');
        if (!a || !el.contains(a)) return;
        if ((a.getAttribute('target') && a.getAttribute('target') !== '_self') || a.hasAttribute('download')) return;
        if (a.hasAttribute('data-native')) return;
        let url;
        try { url = new URL(a.getAttribute('href'), win.location.href); } catch { return; }
        if (url.origin !== win.location.origin || !match(applyRedirects(url))) return;
        e.preventDefault();
        router.navigate(pathOf(url));
      };
      el.addEventListener('click', onClick);
      return () => el.removeEventListener('click', onClick);
    },

    /** Resolves when the current transition (if any) has finished. */
    settled() { return running ?? Promise.resolve(); },

    /** Removes the listeners and unmounts the views (tests, hot reload). */
    async stop() {
      win.removeEventListener('popstate', onPopState);
      win.removeEventListener('pagehide', onPageHide);
      doc.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(queryTimer);
      await (running ?? Promise.resolve());
      if (modal) { const old = modal; modal = null; await unmountLayer(old, overlayOutlet()); }
      if (base) { const old = base; base = null; await unmountLayer(old, outlet); }
      if (session) { const id = session.songId; session = null; await sessionApi().dispose(id); }
      started = false;
    },
  };
  return router;
}
