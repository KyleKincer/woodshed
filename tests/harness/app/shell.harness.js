// S1's harness (/__harness/shell): the shell's chrome states on the real modules.
//   ?part=topbar     the app frame with the top bar over a sample place (the real global commands and app
//                    registry; the avatar menu reads store.session and the desktop bridge, so add
//                    fx-desktop=1 for the desktop menu):
//                      admin=1            an administrator (Administration in the menu)
//                      update=ready|downloading   store.update (the avatar dot, the App updates row)
//                      menu=1             opens the avatar menu
//                      q=<text>           text in the search field
//                      jobs=1             a sample node in the Jobs slot (LB1b's chip fills it in the app)
//   ?part=banners    the banners row over a sample place: offline=1, exportOnly=1, codec=1
//   ?part=fatal      the fatal boot card (open=1 opens Details)
//   ?part=paused     the paused-account page
//   ?part=signin     the placeholder sign-in card (error=1: an OAuth error)
//   ?part=startup    the boot status (slow=1: "Still connecting… [Retry]" at once)
// window.__shell = {topbar, router, store} for states.
import {signal, store} from '/src/app/store.js';
import {mountBanners, renderFatal, renderPaused} from '/src/app/fatal.js';
import {renderSignIn} from '/src/app/placeholder.js';
import {showStartup} from '/src/js/startup.js';

const user = {id: 'user1', name: 'Kyle Kincer', email: 'kyle@example.com', image: null};

/** The app frame (as main.js builds it) inside the harness element. */
function frame(el, h, {topbar = true} = {}) {
  el.style.padding = '0';
  el.style.overflow = 'hidden';
  const header = h('header', {hidden: !topbar});
  const banners = h('div', {class: 'shell-banners', hidden: true});
  const content = h('div', {attrs: {'data-scroller': true}},
    h('div', {class: 'app-content'},
      h('h1', {style: {fontSize: 'var(--fs-32)', paddingBlock: 'var(--s6) var(--s3)'}}, 'Library'),
      h('p', {style: {color: 'var(--ink-2)'}}, 'The place mounts here.')));
  const outlet = h('div', {class: 'shell-outlet'}, content);
  const main = h('main', {class: 'app-main shell-main'}, banners, outlet);
  const app = h('div', {class: 'app-frame', dataset: {chrome: topbar ? 'topbar' : 'none'}}, header, main);
  el.replaceChildren(app);
  return {app, header, banners, outlet};
}

/** A router for the top bar: records navigation, keeps the current route. */
function fakeRouter() {
  const current = signal({name: 'library'});
  const log = [];
  return {
    current, log,
    navigate(to) { log.push(['navigate', to]); },
    setQuery(patch) { log.push(['setQuery', patch]); },
    href: (name, params, query) => `/?q=${encodeURIComponent(query?.q ?? '')}`,
  };
}

async function topbarPart(el, h, query) {
  const [{mountTopbar}, {desktop}, {registry}] = await Promise.all([
    import('/src/app/topbar.js'), import('/src/app/desktop.js'), import('/src/app/commands.js'),
    import('/src/app/global-commands.js'),
  ]);
  store.session.value = {user, status: 'active', admin: query.get('admin') === '1', online: true};
  const update = query.get('update');
  store.update.value = update === 'ready' ? {status: 'ready', version: '2.0.1'} : update === 'downloading' ? {status: 'downloading', percent: 40} : {status: 'idle'};
  const router = fakeRouter();
  registry.provide('router', () => router);
  const f = frame(el, h);
  const topbar = mountTopbar(f.header, {router, store, desktop, registry});
  registry.provide('topbar', () => topbar);
  if (query.get('q')) topbar.setSearch({value: query.get('q'), onInput() {}});
  if (query.get('jobs') === '1') {
    topbar.setJobsSlot(h('button', {type: 'button', class: 'ui-button', dataset: {variant: 'quiet', size: 'md'}},
      h('span', {class: 'ui-button-text'}, h('span', {class: 'ui-button-label'}, '2 splitting'))));
  }
  if (query.get('menu') === '1') topbar.openAccountMenu();
  window.__shell = {topbar, router, store};
  return {topbar};
}

function bannersPart(el, h, query) {
  const f = frame(el, h, {topbar: false});
  const online = signal(query.get('offline') !== '1');
  const session = signal({user, status: query.get('exportOnly') === '1' ? 'export_only' : 'active'});
  const log = [];
  const banners = mountBanners(f.banners, {store: {session}, platform: {online}, codecSupported: query.get('codec') !== '1',
    navigate: path => log.push(path)});
  window.__shell = {banners, online, session, log};
  return {banners};
}

function centred(el, h) {
  el.style.padding = '0';
  const main = h('main', {class: 'app-main', style: {height: '100%'}});
  const app = h('div', {class: 'app-frame', dataset: {chrome: 'none'}}, main);
  el.replaceChildren(app);
  return main;
}

export default async function mount(el, {query, h}) {
  const part = query.get('part') ?? 'topbar';
  switch (part) {
    case 'topbar':
      return topbarPart(el, h, query);
    case 'banners':
      return bannersPart(el, h, query);
    case 'fatal': {
      const card = renderFatal(centred(el, h), {
        details: Object.assign(new Error('[CONVEX Q(users:me)] Connection lost while action was in flight'), {name: 'AuthError'}),
        onRetry: () => { window.__shell.retried = (window.__shell.retried ?? 0) + 1; },
      });
      if (query.get('open') === '1') card.el.querySelector('details').open = true;
      window.__shell = {card};
      return card;
    }
    case 'paused':
      return renderPaused(centred(el, h), {status: 'suspended'});
    case 'signin': {
      const error = query.get('error') === '1' ? {message: 'This sign-in link expired. Please sign in again.'} : null;
      const log = [];
      window.__shell = {log};
      return renderSignIn(centred(el, h), {error, signIn: async () => { log.push('signIn'); }});
    }
    case 'startup': {
      centred(el, h);
      document.documentElement.dataset.startup = 'loading';
      const retried = [];
      showStartup({slowMs: query.get('slow') === '1' ? 0 : 8000, onRetry: () => retried.push(1)});
      window.__shell = {retried};
      return null;
    }
    default:
      throw new Error(`shell harness: unknown part ${part}`);
  }
}
