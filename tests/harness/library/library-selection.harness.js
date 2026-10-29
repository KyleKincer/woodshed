// LB3's harness (/__harness/library-selection): Library selection mode, the card menu and the Re-split dialog on the
// real modules, over the fixture database through the real client (auth.initialize, S1's startData and the account
// subscription fill the store as the app does). Add fx-desktop=1 for the desktop app.
//   ?part=library (default)   the library's songs as LB1a's real cards (or rows with layout=list), wired the way
//                             home.js wires them (handoff to I2b): ⌘/Ctrl-click and Shift-click select, a plain click
//                             toggles while selecting, ⋯ / right-click / long-press open cardMenuItems (Select first),
//                             the floating bar, and the 'library' command context (Esc, ⌘A, ⌫, library.select)
//     select=a,b,…            starts selecting with these song ids
//     extra=N                 adds N synthetic songs to the store only (not the database): ⌘A then meets the
//                             100 cap, and deleting one of them fails on the server (a partial-failure report)
//     menu=<songId>           opens that card's menu at its ⋯ button
//     fail=<songId>           the bar's songs.remove refuses that song (a server error), for the partial-failure report
//   ?part=resplit             opens the Re-split dialog (desktop): song=<id> (default glasshouse) or songs=a,b
//     stems=six               preselects a stem layout
// The router records navigation in window.__sel.router.log; window.__sel = {selection, store, router, bar, cards}.
import {effect, store} from '/src/app/store.js';

const user = {id: 'user1', name: 'Kyle Kincer', email: 'kyle@example.com', image: null};

function fakeRouter() {
  const log = [];
  return {log, navigate(to, opts) { log.push(['navigate', to, opts ?? null]); }, setQuery(patch) { log.push(['setQuery', patch]); }, back() { log.push(['back']); }};
}

/** Signs in on the fixture, starts the library and account subscriptions (main.js boot steps 3–6). */
async function startApp() {
  const [auth, {startData}, {desktop}, {account}] = await Promise.all([
    import('/src/app/auth.js'), import('/src/app/data.js'), import('/src/app/desktop.js'), import('/src/app/account.js'),
  ]);
  const {user: signedIn, status} = await auth.initialize();
  store.session.value = {user: signedIn ?? user, status: status ?? 'active', admin: false, online: true};
  startData();
  account.start();
  if (desktop.available) await desktop.start();
  await new Promise(resolve => {
    if (store.library.loaded.peek() && account.loaded.peek()) { resolve(); return; }
    const off = effect(() => { if (store.library.loaded.value && account.loaded.value) { queueMicrotask(() => off()); resolve(); } });
  });
  return {desktop, account};
}

function syntheticSong(i, now) {
  return {id: `extra-${i}`, title: `Practice loop ${i + 1}`, artist: 'Synthetic', album: '', albumArtist: '', uploader: '', duration: 60 + i,
    addedAt: now - i * 1000, stemMode: 'full', stems: [], coverKey: null, coverUrl: null, artwork: null, source: null, tags: [],
    metadataStatus: null, reviewMetadata: false, recordingUnconfirmed: false, suggestion: null, hasChart: false,
    mapSummary: null, lastPracticedAt: null, practiceSummary: null, hasSectionSuggestion: false};
}

async function libraryPart(el, h, query) {
  const {desktop} = await startApp();
  const [cards, {registry}, {startDispatcher}, selectionMod, {cardMenuItems}, {sortSongs}] = await Promise.all([
    import('/src/library/cards.js'), import('/src/app/commands.js'), import('/src/app/dispatch.js'),
    import('/src/library/selection.js'), import('/src/library/card-menu.js'), import('/src/library/library-model.js'),
    import('/src/library/commands.js'), import('/src/app/global-commands.js'), import('/src/styles/views/library/home.css'),
  ]);
  const {sharedSelection, selectionClick, selectionContext} = selectionMod;
  const extra = Number(query.get('extra') ?? 0);
  if (extra > 0) {
    // The synthetic songs live in the store only: put them back whenever the database's list replaces it.
    const now = Date.now();
    const synthetic = Array.from({length: extra}, (_, i) => syntheticSong(i, now));
    effect(() => {
      const songs = store.library.songs.value;
      if (synthetic.every(s => songs.has(s.id))) return;
      queueMicrotask(() => {
        const map = new Map(store.library.songs.peek());
        for (const s of synthetic) map.set(s.id, s);
        store.library.songs.value = map;
      });
    });
  }

  const router = fakeRouter();
  registry.provide('router', () => router);
  document.documentElement.dataset.place = 'library';
  startDispatcher({registry});

  const list = query.get('layout') === 'list';
  const ordered = () => sortSongs([...store.library.songs.peek().values()], 'title');
  const selection = sharedSelection();
  selection.setOrder(() => ordered().map(s => s.id));

  const grid = list
    ? h('div', {class: 'lib-rows', attrs: {role: 'rowgroup'}})
    : h('div', {class: 'lib-grid'});
  const body = list ? h('div', {class: 'lib-list', attrs: {role: 'table', 'aria-label': 'Songs'}}, grid) : grid;
  const content = h('div', {class: 'app-content lib-home'}, h('h1', {class: 'lib-library-title'}, 'Library'), body);
  const scroller = h('div', {class: 'lib-scroller', attrs: {'data-scroller': ''}}, content);
  el.style.padding = '0';
  el.style.blockSize = '100vh';
  el.replaceChildren(scroller);

  const Card = list ? cards.SongRow : cards.SongCard;
  const entries = new Map();
  const optsFor = song => ({
    now: Date.now(),
    selecting: selection.active.peek(),
    selected: selection.has(song.id),
    onOpen: (s, {event}) => {
      if (selectionClick(selection, s.id, event)) return true;
      if (event && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)) return false;
      router.navigate(`/s/${encodeURIComponent(s.id)}`);
      return true;
    },
    onMenu: (s, {anchor, event}) => cardMenuItems(s, {router, store, registry, anchor, event, desktop}),
    onArtist() {}, onAlbum() {},
  });
  function render() {
    const songs = ordered();
    const keep = new Set(songs.map(s => s.id));
    for (const [id, card] of entries) if (!keep.has(id)) { card.destroy(); entries.delete(id); }
    songs.forEach((song, i) => {
      let card = entries.get(song.id);
      if (!card) { card = Card(song, optsFor(song)); entries.set(song.id, card); }
      else card.update(song, optsFor(song));
      if (grid.children[i] !== card.el) grid.insertBefore(card.el, grid.children[i] ?? null);
    });
    const first = entries.get(songs[0]?.id);
    for (const card of entries.values()) card.setActive(card === first);
  }
  effect(() => { void store.library.songs.value; void selection.ids.value; void selection.active.value; queueMicrotask(render); });
  render();

  const barHost = h('div', {class: 'lib-selbar-host'});
  content.append(barHost);
  const fail = query.get('fail');
  const songsApi = await import('/src/api/songs.js');
  const api = {
    remove: async ({id}) => {
      if (id === fail) throw Object.assign(new Error(`songs:remove refused ${id} (harness)`), {code: 'unknown'});
      return songsApi.remove({id});
    },
  };
  const bar = selection.mountBar(barHost, {router, store, desktop, api});
  registry.provide('library', () => ({
    ...selectionContext(selection, {deleteSelected: () => bar.deleteSelected(), order: () => ordered().map(s => s.id)}),
    get selecting() { return selection.active.peek(); },
  }));

  const select = query.get('select');
  if (select) for (const id of select.split(',')) selection.toggle(id);
  await new Promise(resolve => queueMicrotask(resolve));
  const menuFor = query.get('menu');
  if (menuFor) entries.get(menuFor)?.el.querySelector('.lib-more')?.click();
  window.__sel = {selection, store, router, bar, cards: entries};
}

async function resplitPart(el, h, query) {
  const {desktop} = await startApp();
  const [{openResplitDialog}, {registry}, {startDispatcher}] = await Promise.all([
    import('/src/library/resplit-dialog.js'), import('/src/app/commands.js'), import('/src/app/dispatch.js'),
  ]);
  startDispatcher({registry});
  const router = fakeRouter();
  const songIds = (query.get('songs') ?? query.get('song') ?? 'glasshouse').split(',');
  el.replaceChildren(h('div', {class: 'app-content'}, h('h1', {class: 'lib-library-title'}, 'Library')));
  const closed = openResplitDialog({songIds, router, desktop, stemMode: query.get('stems') ?? undefined});
  window.__sel = {store, router, closed};
}

export default async function mount(el, {query, h}) {
  const part = query.get('part') ?? 'library';
  if (part === 'resplit') return resplitPart(el, h, query);
  return libraryPart(el, h, query);
}
