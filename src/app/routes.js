// The route table (architecture §2.3, spec §1.2). Views are resolved by their contract path through
// import.meta.glob, never imported directly (D2): a contract path with no file yet resolves to
// src/app/placeholder.js ("Not built yet"), so `vite build` never meets an unresolved import and no
// integration edits this table when a view lands.
//
//   routes        pattern → view loader, place, chrome, posture, session flag, guard, modal parent
//   bootRoutes    matched by main.js before auth; each hands over to its module's boot(match)
//   redirects     legacy URLs, applied with replaceState before the first mount
//   view(path)    the loader for a contract path (the placeholder when the file does not exist)
//   matchBootRoute(pathname)  {name, path, params, route} for /download and /share/:token, else null

const VIEWS = import.meta.glob(['../library/home.js', '../library/add-sheet.js', '../onboarding/welcome.js', '../stage/stage.js',
  '../edit/edit.js', '../edit/details/details.js', '../settings/settings.js', '../settings/admin/admin.js', '../settings/admin/account.js',
  '../library/setlist-page.js', '../download/download.js', '../share/shared-stage.js']);

const placeholder = () => import('./placeholder.js');

/** The loader of the view at a contract path; a path with no file yet loads the placeholder (D2). */
export function view(path, views = VIEWS) {
  return views[path] ?? placeholder;
}

const isAdmin = s => !!s?.admin;

export const routes = Object.freeze([
  {name: 'library',      path: '/',                          place: 'library',  chrome: 'topbar', view: view('../library/home.js')},
  {name: 'add',          path: '/add',                       place: 'library',  chrome: 'topbar', modalOver: 'library', view: view('../library/add-sheet.js')},
  {name: 'welcome',      path: '/welcome',                   place: 'library',  chrome: 'none',   view: view('../onboarding/welcome.js')},
  {name: 'stage',        path: '/s/:songId',                 place: 'stage',    chrome: 'none',   posture: 'stage', session: true, view: view('../stage/stage.js')},
  {name: 'edit',         path: '/s/:songId/edit/:tab',       place: 'edit',     chrome: 'none',   posture: 'edit',  session: true, tabs: ['map', 'chart', 'details'], view: view('../edit/edit.js')},
  {name: 'editFind',     path: '/s/:songId/edit/map/find',   place: 'edit',     chrome: 'none',   posture: 'edit',  session: true, view: view('../edit/edit.js'), params: {tab: 'map', find: true}},
  {name: 'bulkDetails',  path: '/edit/details',              place: 'edit',     chrome: 'none',   posture: 'edit',  view: view('../edit/details/details.js')},
  {name: 'settings',     path: '/settings',                  place: 'settings', chrome: 'topbar', view: view('../settings/settings.js')},
  {name: 'settingsPage', path: '/settings/:section',         place: 'settings', chrome: 'topbar', view: view('../settings/settings.js')},
  {name: 'admin',        path: '/admin',                     place: 'admin',    chrome: 'topbar', guard: isAdmin, view: view('../settings/admin/admin.js')},
  {name: 'adminAccount', path: '/admin/accounts/:id',        place: 'admin',    chrome: 'topbar', guard: isAdmin, view: view('../settings/admin/account.js')},
  {name: 'setlist',      path: '/set/:id',                   place: 'library',  chrome: 'topbar', view: view('../library/setlist-page.js')},
].map(Object.freeze));

export const bootRoutes = Object.freeze([
  {name: 'download', path: '/download',     boot: view('../download/download.js')},
  {name: 'share',    path: '/share/:token', boot: view('../share/shared-stage.js')},   // the Shared Stage checks the token (/^[a-f0-9]{64}$/)
].map(Object.freeze));

export const redirects = Object.freeze([
  {from: url => url.pathname === '/' && url.searchParams.has('song'), to: url => `/s/${encodeURIComponent(url.searchParams.get('song'))}`},
  {from: url => url.pathname === '/billing', to: url => `/settings/plan${url.search}`},   // keeps ?checkout=success
].map(Object.freeze));

/** Splits a pattern or a path into segments; a trailing slash is ignored ('/share/x/' is '/share/x'). */
const segments = path => String(path).split('/').filter(Boolean);

/** The boot route for a pathname: {name, path, params, route}, or null (the app boots). */
export function matchBootRoute(pathname, table = bootRoutes) {
  const parts = segments(pathname);
  for (const route of table) {
    const pattern = segments(route.path);
    if (pattern.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pattern.length && ok; i++) {
      let part;
      try { part = decodeURIComponent(parts[i]); } catch { ok = false; break; }
      if (pattern[i].startsWith(':')) params[pattern[i].slice(1)] = part;
      else ok = pattern[i] === part;
    }
    if (ok) return {name: route.name, path: pathname, params, route};
  }
  return null;
}
