// The Library place (route `library`, `/`; spec §2.1–2.4 and §2.7, architecture §2.16):
// Continue, Setlists, Pinned, then the Library header (count, filter chips, drill-down chips,
// Sort ▾, Group ▾, ▦/☰) and the grid or list. Calm and artwork-first, built to resume.
//
//   mount(el, match, ctx) → {update(match), unmount()}
//
// View state {q, sort, group, filter, artist, album, layout} is read from the URL, then prefs.library
// (sort, group, filter and the layout; ?layout=list, grid by default); changes are mirrored to the URL (replace, 400 ms) and to
// prefs.library. A new search never resets the sort. The top bar's search field belongs to the
// Library while it is mounted (ctx.topbar.setSearch): typing filters live, Enter opens the top
// result, ↓ moves into the grid.
//
// Rendering: one keyed list (reconcileList) per layout holds the "Adding" group (jobs for songs
// that do not exist yet), the group headers and the cards, so a store tick never rebuilds or
// moves the focused card. The grid is one Tab stop with roving arrows (data-consume-keys); Home
// and End are library.first/last. A card whose job finishes moves to its sorted position with a
// 260 ms FLIP (--motion-slow; none under reduced motion). Rows use content-visibility: auto.
//
// Edge states: the first run (no songs: the Demo card from settings.demo and the Add card), an
// 8-card skeleton while the library loads ("Still connecting… [Retry]" after 8 s), no search
// results ([Clear search], and [Add "q" as a new song →] on the desktop app or with an online
// paired computer, B5), and the empty filter ([Show all]). Sort, Group and the filter chips appear
// from 6 songs. The offline, codec and export-only banners are the shell's (S1).
//
// Context: ctx {router, store, registry, platform, desktop, topbar}. While mounted the view
// provides the registry's 'library' context ({selecting, exitSelection, focusedSongId, …}) the
// library commands (src/library/commands.js) and app.escape read.
// Peers: LB1b's shared jobs model (sharedJobsModel: job view-models per song and for new songs) and ReviewChip.
// The card menu (card-menu.js, LB3, a later wave) resolves by its contract path; until it exists
// cards have no ⋯ button and long-press opens nothing.

import '../styles/views/library/home.css';
import {h, reconcileList} from '../ui/h.js';
import {Button} from '../ui/button.js';
import {Chip, ChipGroup} from '../ui/chip.js';
import {Menu} from '../ui/menu.js';
import {Segmented} from '../ui/segmented.js';
import {Skeleton} from '../ui/skeleton.js';
import {EmptyState} from '../ui/empty.js';
import {batch, effect, signal, store as appStore, untracked} from '../app/store.js';
import {prefs as appPrefs} from '../app/prefs.js';
import {account as appAccount} from '../app/account.js';
import {registry as appRegistry} from '../app/commands.js';
import {now as clockNow} from '../app/clock.js';
import {platform as appPlatform} from '../app/platform.js';
import {desktop as appDesktop} from '../app/desktop.js';
import * as settingsApi from '../api/settings.js';
import {onlineDevices, RECHECK_MS} from '../api/devices.js';
import {sharedJobsModel} from './jobs.js';
import {selectionClick, selectionContext, sharedSelection} from './selection.js';
import {ReviewChip} from './review-chip.js';
import {COPY} from './home.copy.js';
import {
  CONDITIONAL_FILTERS, FILTERS, FIRST_RUN_MIN, GROUPS, SORTS, addingJobsOf, defaultSort, filterSongs, fold, groupSongs,
  isFailed, isNew, jobCounts, matches, parseSort, queryOf, sortSongs, sortValue, viewState,
} from './library-model.js';
import {CompactCard, Cover, JobCard, JobRow, SongCard, SongRow, nameCover} from './cards.js';
import {ContinueSection} from './continue.js';
import {mountSetlistsRow} from './setlists.js';
import {mountFirstRun} from './first-run.js';
import {artistLabel, initialsOf} from './song-labels.js';

export const QUERY_DEBOUNCE_MS = 400;
export const STILL_CONNECTING_MS = 8000;
export const SKELETON_CARDS = 8;
export const FLIP_MEMORY_MS = 10_000;
const ARROWS = 'ArrowLeft ArrowRight ArrowUp ArrowDown';

// Later-wave module (LB3), resolved by its contract path like main.js's starters (Appendix C item 58).
const LATER = import.meta.glob('./card-menu.js');

/** The app's one jobs model (LB1b), shared with the top bar's Jobs chip and the Jobs popover. */
const jobs = () => sharedJobsModel();

/** Opens the Add sheet at most once per page load after the desktop processor's first run. */
let firstRunAddOpened = false;
const isPlainClick = e => !e || (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey);
const isTextInput = el => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? '') || !!el.closest?.('[data-text-input]'));
const URL_RE = /^https?:\/\/\S+$/i;

/** A monotonic clock read at render time (the FLIP's memory window); the 30 s `tick` is too coarse. */
const monotonic = () => globalThis.performance?.now?.() ?? clockNow();

function motionMs(doc, platform) {
  if (platform?.reducedMotion?.peek?.()) return 0;
  const raw = doc.defaultView?.getComputedStyle?.(doc.documentElement)?.getPropertyValue?.('--motion-slow')?.trim() ?? '';
  const m = /^([\d.]+)\s*(ms|s)?$/.exec(raw);
  if (!m) return 260;
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1);
}

function easing(doc) {
  return doc.defaultView?.getComputedStyle?.(doc.documentElement)?.getPropertyValue?.('--ease')?.trim() || 'ease-out';
}

/** The job's song title for matching a finished job with the song that replaced its card. */
const jobName = job => fold(job?.title ?? '').trim();

export function mount(el, match, ctx = {}) {
  const doc = el.ownerDocument;
  const store = ctx.store ?? appStore;
  const registry = ctx.registry ?? appRegistry;
  const platform = ctx.platform ?? appPlatform;
  const desktop = ctx.desktop ?? appDesktop;
  const router = ctx.router ?? null;
  const topbar = ctx.topbar ?? null;
  const prefs = appPrefs;
  const account = appAccount;
  const model = jobs();
  const lib = store.library;

  const disposers = [];
  const primitives = [];
  const ac = new AbortController();
  const listen = (target, type, fn, opts = {}) => target.addEventListener(type, fn, {...opts, signal: ac.signal});
  const navigate = (...args) => router?.navigate?.(...args);

  // ---------- view state ----------

  const view = signal(viewState(match?.query ?? {}, prefs.value.peek()?.library ?? {}, lib.songs.peek()));
  const tick = signal(clockNow());
  const cardMenu = signal(null);   // card-menu.js once it exists (LB3)
  const demo = signal(null);
  const slow = signal(false);

  const effectiveSort = (state, songs) => (state.sortExplicit ? state.sort : defaultSort(songs));

  function setView(patch, {url = true, persist = true} = {}) {
    const next = {...view.peek(), ...patch};
    if ('sort' in patch) next.sortExplicit = true;
    view.value = next;
    if (persist && ('sort' in patch || 'group' in patch || 'filter' in patch || 'layout' in patch)) {
      prefs.update(d => {
        if ('sort' in patch) d.library.sort = next.sort;
        if ('group' in patch) d.library.group = next.group;
        if ('filter' in patch) d.library.filter = next.filter ?? null;
        if ('layout' in patch) d.library.layout = next.layout;
      });
    }
    if (url && router?.setQuery) router.setQuery(queryOf(next), {debounceMs: QUERY_DEBOUNCE_MS});
  }

  // ---------- frame ----------

  const scroller = h('div', {class: 'lib-scroller', attrs: {'data-scroller': ''}});
  const content = h('div', {class: 'app-content lib-home'});
  scroller.append(content);
  el.replaceChildren(scroller);

  const pageTitle = h('h1', {class: 'sr-only'}, COPY.library);
  const continueSection = ContinueSection({songs: [], now: tick.peek(), profile: null});
  const setlistsHost = h('div', {class: 'lib-setlists-host'});
  const setlistsRow = mountSetlistsRow(setlistsHost, {store});
  disposers.push(() => setlistsRow.destroy());

  // Pinned (D8)
  const pinnedTitle = h('h2', {class: 'lib-section-title', id: 'lib-pinned-title'}, COPY.pinned);
  const pinnedList = h('ul', {class: 'lib-shelf', attrs: {'aria-labelledby': pinnedTitle.id}});
  const pinnedSection = h('section', {class: 'lib-pinned', attrs: {'aria-labelledby': pinnedTitle.id}}, pinnedTitle, pinnedList);
  const pinnedCards = new Map();

  // Library header
  const libTitleText = h('span', {}, COPY.library);
  // The count: '12' on screen (hidden from assistive tech) and '12 songs' visually hidden, so the
  // heading reads 'Library 12 songs' without an aria-label on a generic span (VF1-2).
  const libCountShown = h('span', {attrs: {'aria-hidden': 'true'}});
  const libCountSpoken = h('span', {class: 'sr-only'});
  const libCount = h('span', {class: 'lib-count'}, libCountShown, libCountSpoken);
  const setLibCount = (shown, total) => {
    libCountShown.textContent = shown == null ? '' : COPY.libraryCount(shown, total);
    libCountSpoken.textContent = shown == null ? '' : COPY.libraryCountLabel(shown, total);
  };
  const libTitle = h('h2', {class: 'lib-library-title', id: 'lib-library-title'}, libTitleText, libCount);
  const filterHost = h('div', {class: 'lib-filters'});
  const filters = ChipGroup({label: COPY.filterGroup, options: [], value: null, className: 'lib-filter-chips',
    onChange: value => setView({filter: value ?? null})});
  primitives.push(filters);
  const drillHost = h('div', {class: 'lib-drills'});
  let drillChips = [];
  let drillKey = null;
  filterHost.append(filters.el, drillHost);
  const sortButton = Button({label: COPY.sortButton(COPY.sorts.added), iconEnd: 'chevron-down', variant: 'quiet', className: 'lib-sort-menu',
    attrs: {'aria-haspopup': 'menu', 'aria-expanded': 'false'}, onClick: () => openSortMenu()});
  const groupButton = Button({label: COPY.groupButton(null), iconEnd: 'chevron-down', variant: 'quiet', className: 'lib-group-menu',
    attrs: {'aria-haspopup': 'menu', 'aria-expanded': 'false'}, onClick: () => openGroupMenu()});
  const layoutToggle = Segmented({label: COPY.view, className: 'lib-layout', value: view.peek().layout,
    options: [{value: 'grid', label: COPY.grid, icon: 'layout-grid'}, {value: 'list', label: COPY.list, icon: 'list'}],
    onChange: value => setView({layout: value})});
  primitives.push(sortButton, groupButton, layoutToggle);
  const tools = h('div', {class: 'lib-tools'}, sortButton.el, groupButton.el);
  const toolbar = h('div', {class: 'lib-toolbar'}, tools, layoutToggle.el);
  const header = h('header', {class: 'lib-header'}, h('div', {class: 'lib-header-top'}, libTitle, toolbar), filterHost);
  const body = h('div', {class: 'lib-body'});
  const librarySection = h('section', {class: 'lib-library', attrs: {'aria-labelledby': libTitle.id}}, header, body);

  // The remote bar (2.1): a song open on another of the account's devices is one tap from a remote here.
  const remoteHost = h('div', {class: 'lib-remote-host'});
  content.append(pageTitle, remoteHost, continueSection.el, setlistsHost, pinnedSection, librarySection);
  let remoteBar = null;
  if (ctx.remoteBar !== false) {
    void import('../remote/remote-bar.js').then((m) => { if (!ac.signal.aborted) remoteBar = m.mountRemoteBar(remoteHost, {router}); })
      .catch((err) => console.warn('[library] the remote bar could not load', err));
  }

  // ---------- menus ----------

  let menu = null;
  function openMenu(button, items, label) {
    if (menu?.open) { menu.close('close'); return; }
    button.el.setAttribute('aria-expanded', 'true');
    menu = Menu({items, anchor: button.el, placement: 'bottom', label, registry,
      onClose: () => { button.el.setAttribute('aria-expanded', 'false'); menu = null; }});
  }

  function openSortMenu() {
    const state = view.peek();
    const current = parseSort(effectiveSort(state, lib.songs.peek())) ?? {key: 'added', reverse: false};
    const items = SORTS.map(key => ({id: `sort.${key}`, type: 'radio', label: COPY.sorts[key], checked: current.key === key,
      run: () => setView({sort: sortValue(key, false)})}));
    items.push({type: 'separator'}, {id: 'sort.reverse', type: 'checkbox', label: COPY.reverse, checked: current.reverse,
      run: () => setView({sort: sortValue(current.key, !current.reverse)})});
    // Select (LB3) appears once the selection model provides it (library.select's `when`).
    if (registry.isEnabled?.('library.select')) {
      items.push({type: 'separator'}, {id: 'library.select', label: registry.titleFor?.('library.select') || COPY.select,
        run: () => registry.run('library.select', {source: 'pointer'})});
    }
    openMenu(sortButton, items, COPY.sort);
  }

  function openGroupMenu() {
    const state = view.peek();
    openMenu(groupButton, GROUPS.map(g => ({id: `group.${g}`, type: 'radio', label: COPY.groups[g], checked: state.group === g,
      run: () => setView({group: g})})), COPY.group);
  }

  // ---------- opening ----------

  function openSong(song, cover = null) {
    if (!song) return;
    if (cover) nameCover(cover, song.id);
    navigate(`/s/${encodeURIComponent(song.id)}`);
  }

  function openJob(job, anchor) {
    registry.run('library.jobs', {source: 'pointer', args: {anchor: anchor ?? topbar?.jobsSlot ?? null, jobId: job?.id ?? null}});
  }

  function menuItemsFor(song, {anchor, event} = {}) {
    const mod = cardMenu.peek();
    if (!mod || typeof mod.cardMenuItems !== 'function') return null;
    return mod.cardMenuItems(song, {router, store, registry, anchor, event, desktop});
  }

  const loadMenu = LATER['./card-menu.js'];
  if (loadMenu) loadMenu().then(mod => { if (!ac.signal.aborted) cardMenu.value = mod; }, err => console.error('[library] card menu failed to load', err));

  // ---------- the body: one keyed list ----------

  let layoutBuilt = null;          // 'grid' | 'list'
  let container = null;            // the reconcile container
  let listTable = null;            // list layout: the role=table element
  const columnButtons = new Map(); // sort key → header button
  const entries = new Map();       // key → entry
  let order = [];                  // card keys in visual order
  let activeKey = null;
  let renderedOnce = false;
  let prevKeys = new Set();
  const departed = [];             // {rect, name, songId, at} job cards that just left
  const arrived = [];              // {key, name, id, at} song cards that just appeared

  function columnHeader(key, label, cls) {
    const btn = h('button', {class: 'lib-colsort', type: 'button'}, h('span', {}, label), h('span', {class: 'lib-colsort-mark', attrs: {'aria-hidden': 'true'}}));
    btn.addEventListener('click', () => {
      const cur = parseSort(effectiveSort(view.peek(), lib.songs.peek()));
      setView({sort: sortValue(key, cur?.key === key ? !cur.reverse : false)});
    });
    columnButtons.set(key, btn);
    return h('div', {class: ['lib-cell', 'lib-colhead', cls], attrs: {role: 'columnheader'}}, btn);
  }

  function buildLayout(layout) {
    for (const entry of entries.values()) entry.destroy?.();
    entries.clear();
    columnButtons.clear();
    order = [];
    activeKey = null;
    if (layout === 'list') {
      const head = h('div', {class: 'lib-row lib-row-head', attrs: {role: 'row'}},
        h('div', {class: 'lib-cell lib-col-thumb', attrs: {role: 'columnheader'}}, h('span', {class: 'sr-only'}, 'Cover')),
        columnHeader('title', COPY.columns.title, 'lib-col-title'),
        columnHeader('album', COPY.columns.album, 'lib-col-album'),
        columnHeader('key', COPY.columns.key, 'lib-col-key'),
        columnHeader('bpm', COPY.columns.bpm, 'lib-col-bpm'),
        columnHeader('duration', COPY.columns.duration, 'lib-col-duration'),
        columnHeader('practised', COPY.columns.practised, 'lib-col-practised'),
        h('div', {class: 'lib-cell lib-col-more', attrs: {role: 'columnheader'}}, h('span', {class: 'sr-only'}, 'More')));
      container = h('div', {class: 'lib-rows', attrs: {role: 'rowgroup', 'data-consume-keys': ARROWS}});
      listTable = h('div', {class: 'lib-list', attrs: {role: 'table', 'aria-label': COPY.listLabel}},
        h('div', {class: 'lib-rows-head', attrs: {role: 'rowgroup'}}, head), container);
      return listTable;
    }
    listTable = null;
    container = h('div', {class: 'lib-grid', attrs: {'data-consume-keys': ARROWS}});
    return container;
  }

  function headerEntry(item, layout) {
    const isDivider = item.type === 'divider';
    const label = h('span', {class: 'lib-group-label'});
    const count = h('span', {class: 'lib-group-count'});
    const disc = h('span', {class: 'lib-group-disc', attrs: {'aria-hidden': 'true'}});
    const cover = Cover({className: 'lib-group-cover'});
    const initials = h('span', {class: 'lib-group-initials'});
    disc.append(cover.el, initials);
    const inner = isDivider ? h('h3', {class: 'lib-divider-label'}, item.label) : h('h3', {class: 'lib-group-heading'}, disc, label, count);
    const el = layout === 'list'
      ? h('div', {class: ['lib-row', isDivider ? 'lib-divider' : 'lib-group-row'], attrs: {role: 'row'}},
        h('div', {class: 'lib-cell lib-group-cell', attrs: {role: 'cell', 'aria-colspan': '8'}}, inner))
      : h('div', {class: isDivider ? 'lib-divider' : 'lib-group'}, inner);
    const entry = {
      el, item, header: true,
      update(next) {
        entry.item = next;
        if (isDivider) return;
        const g = next.group;
        label.textContent = g.label;
        count.textContent = COPY.groupCount(g.count);
        disc.dataset.kind = g.cover ? 'cover' : 'initials';
        cover.el.hidden = !g.cover;
        initials.hidden = !!g.cover;
        if (g.cover) cover.set(g.cover, g.cover);
        else initials.textContent = initialsOf(g.label);
      },
      destroy() { if (entries.get(item.key) === entry) entries.delete(item.key); },
    };
    entry.update(item);
    entries.set(item.key, entry);
    return entry;
  }

  function songOpts(song, now, opened) {
    return {
      job: model.bySong.peek()?.get?.(song.id) ?? null,
      isNew: isNew(song, {now, opened}),
      selecting: selection.active.peek(), selected: selection.has(song.id), now,
      onOpen: (s, {event, cover}) => {
        // ⌘/Ctrl-click and Shift-click select; a plain click toggles while selecting (spec §2.6).
        if (selectionClick(selection, s.id, event)) return true;
        if (!isPlainClick(event)) return false;
        selection.clear();
        openSong(s, cover);
        return true;
      },
      onMenu: cardMenu.peek() ? menuItemsFor : undefined,
      onArtist: name => setView({artist: name, album: null}),
      onAlbum: name => setView({album: name, artist: null}),
      onReview: s => ReviewChip(s),
      onJob: (job, {anchor}) => openJob(job, anchor),
    };
  }

  const jobOpts = now => ({now, onJob: (job, {anchor}) => openJob(job, anchor)});

  function cardEntry(item, layout, now, opened) {
    const card = item.type === 'song'
      ? (layout === 'list' ? SongRow : SongCard)(item.song, songOpts(item.song, now, opened))
      : (layout === 'list' ? JobRow : JobCard)(item.job, jobOpts(now));
    const entry = {
      el: card.el, card, item,
      update(next) {
        entry.item = next;
        if (next.type === 'song') card.update(next.song, songOpts(next.song, tick.peek(), currentOpened()));
        else card.update(next.job, jobOpts(tick.peek()));
      },
      destroy() { if (entries.get(item.key) === entry) entries.delete(item.key); card.destroy(); },
    };
    entries.set(item.key, entry);
    return entry;
  }

  const currentOpened = () => prefs.value.peek()?.library?.opened ?? [];

  /** Before a render: where every working card and every job card is (any of them may finish now). */
  function snapshot() {
    const rects = new Map(), names = new Map(), songIds = new Map();
    for (const [key, entry] of entries) {
      if (entry.header) continue;
      const job = entry.item?.type === 'job' ? entry.item.job : null;
      if (job || (entry.el.dataset.state && entry.el.dataset.state !== 'ready')) rects.set(key, entry.el.getBoundingClientRect());
      if (job) { names.set(key, jobName(job)); songIds.set(key, job.songId ?? null); }
    }
    return {rects, names, songIds};
  }

  function flip(el, from) {
    const ms = motionMs(doc, platform);
    if (!ms || !from || typeof el.animate !== 'function') return;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left, dy = from.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate([{transform: `translate(${dx}px, ${dy}px)`}, {transform: 'translate(0, 0)'}], {duration: ms, easing: easing(doc)});
  }

  function settleFlips(before, items, at) {
    const keys = new Set(items.map(i => i.key));
    // Job cards that left: remember where they were, briefly.
    for (const key of prevKeys) {
      if (keys.has(key) || !key.startsWith('job:')) continue;
      const rect = before.rects.get(key);
      if (rect) departed.push({rect, name: before.names.get(key) ?? '', songId: before.songIds.get(key) ?? null, at});
    }
    // Songs that appeared after the first render.
    if (renderedOnce) {
      for (const item of items) {
        if (item.type === 'song' && !prevKeys.has(item.key)) arrived.push({key: item.key, id: item.song.id, name: fold(item.song.title ?? '').trim(), at});
      }
    }
    while (departed.length && at - departed[0].at > FLIP_MEMORY_MS) departed.shift();
    while (arrived.length && at - arrived[0].at > FLIP_MEMORY_MS) arrived.shift();
    // Pair each departed job with the song that replaced it: by song id, else by title.
    for (let i = departed.length - 1; i >= 0; i--) {
      const d = departed[i];
      const j = arrived.findIndex(a => (d.songId && a.id === d.songId) || (d.name && a.name === d.name));
      if (j < 0) continue;
      const entry = entries.get(arrived[j].key);
      if (entry) flip(entry.el, d.rect);
      departed.splice(i, 1);
      arrived.splice(j, 1);
    }
    // Songs whose own job (a re-split, beats) finished this tick.
    for (const [key, rect] of before.rects) {
      if (!key.startsWith('song:')) continue;
      const entry = entries.get(key);
      if (entry && entry.el.dataset.state === 'ready') flip(entry.el, rect);
    }
    prevKeys = keys;
    renderedOnce = true;
  }

  function setActiveKey(key) {
    if (key === activeKey && entries.get(key)) return;
    entries.get(activeKey)?.card?.setActive(false);
    activeKey = key;
    entries.get(key)?.card?.setActive(true);
  }

  function renderItems(items, layout, now, opened) {
    if (layoutBuilt !== layout || !container) {
      const root = buildLayout(layout);
      layoutBuilt = layout;
      bodyContent(root);
    }
    const before = snapshot();
    reconcileList(container, items, {
      key: item => item.key,
      create: item => (item.type === 'song' || item.type === 'job' ? cardEntry(item, layout, now, opened) : headerEntry(item, layout)),
    });
    order = items.filter(i => i.type === 'song' || i.type === 'job').map(i => i.key);
    if (!order.includes(activeKey)) { const next = order[0] ?? null; activeKey = null; setActiveKey(next); }
    else entries.get(activeKey)?.card?.setActive(true);
    settleFlips(before, items, monotonic());
    updateColumnMarks();
  }

  function updateColumnMarks() {
    if (!listTable) return;
    const cur = parseSort(effectiveSort(view.peek(), lib.songs.peek()));
    for (const [key, btn] of columnButtons) {
      const on = cur?.key === key;
      const mark = btn.querySelector('.lib-colsort-mark');
      const direction = on ? sortDirection(key, cur.reverse) : 'none';
      mark.textContent = direction === 'ascending' ? '▲' : direction === 'descending' ? '▼' : '';
      btn.parentElement.setAttribute('aria-sort', direction);
    }
  }

  // Natural directions: practised and added are newest first (descending); the rest ascend.
  const sortDirection = (key, reverse) => {
    const descending = key === 'practised' || key === 'added';
    return (descending !== reverse) ? 'descending' : 'ascending';
  };

  // ---------- body states ----------

  let bodyMode = null;      // 'loading' | 'first' | 'items' | 'empty'
  let firstRun = null;
  let edgeState = null;
  let skeleton = null;
  let slowNote = null;
  const itemsHost = h('div', {class: 'lib-items'});
  const edgeHost = h('div', {class: 'lib-edge'});

  function bodyContent(node) { itemsHost.replaceChildren(node); }

  function setMode(mode) {
    if (mode === bodyMode) return;
    bodyMode = mode;
    if (mode !== 'loading') { skeleton?.el.parentNode?.remove(); skeleton?.destroy(); skeleton = null; slowNote?.remove(); slowNote = null; body.removeAttribute('aria-busy'); }
    if (mode !== 'first') { firstRun?.destroy(); firstRun = null; }
    if (mode !== 'empty') { edgeState?.destroy(); edgeState = null; edgeHost.replaceChildren(); }
    if (mode !== 'items') {
      for (const entry of [...entries.values()]) entry.card?.destroy?.();
      entries.clear();
      layoutBuilt = null;
      container = null;
      itemsHost.replaceChildren();
      prevKeys = new Set();
    }
    body.replaceChildren(...(mode === 'items' ? [itemsHost] : mode === 'empty' ? [edgeHost] : []));
    body.dataset.mode = mode;
  }

  function showLoading() {
    setMode('loading');
    body.setAttribute('aria-busy', 'true');
    if (!skeleton) {
      skeleton = Skeleton({shape: 'card', count: SKELETON_CARDS, label: COPY.loading, className: 'lib-skeleton'});
      body.append(h('div', {class: 'lib-grid lib-skeleton-grid'}, skeleton.el));
    }
    if (slow.value && !slowNote) {
      const retry = Button({label: COPY.retry, variant: 'secondary', icon: 'refresh-cw', onClick: () => doc.defaultView?.location?.reload?.()});
      primitives.push(retry);
      slowNote = h('div', {class: 'lib-slow', attrs: {role: 'status'}}, h('span', {}, COPY.stillConnecting), retry.el);
      body.prepend(slowNote);
    }
  }

  function showFirstRun() {
    setMode('first');
    if (!firstRun) {
      firstRun = mountFirstRun(body, {demo: demo.peek(), desktop: !!desktop?.available, navigate});
    }
    firstRun.update({demo: demo.peek()});
  }

  function showEdge(kind, state) {
    const remote = kind === 'noResults' && canAddRemotely();
    const key = JSON.stringify([kind, state.q, state.filter, state.artist, state.album, remote]);
    if (edgeState?.key === key) return;
    edgeState?.destroy();
    let node;
    if (kind === 'noResults') {
      const q = state.q.trim();
      const parts = COPY.noResults(q).map(p => (typeof p === 'string' ? p : h('strong', {class: 'selectable'}, p.strong)));
      const actions = [{label: COPY.clearSearch, variant: 'secondary', onClick: () => clearSearch()}];
      if (remote) actions.push({label: COPY.addAsNew(q), variant: 'primary', iconEnd: 'arrow-right', onClick: () => navigate(`/add?q=${encodeURIComponent(q)}`)});
      node = EmptyState({title: COPY.noResultsTitle, body: parts, actions, headingLevel: 3, className: 'lib-empty'});
    } else {
      const drill = state.artist ? COPY.drillArtist(state.artist) : state.album ? COPY.drillAlbum(state.album) : null;
      const text = drill && state.filter ? COPY.emptyDrill(drill)
        : state.artist ? COPY.emptyArtist(state.artist)
          : state.album ? COPY.emptyAlbum(state.album)
            : COPY.emptyFilter[state.filter] ?? COPY.emptyFilter.chart;
      node = EmptyState({title: drill ? COPY.noResultsTitle : COPY.emptyTitle, body: text, headingLevel: 3, className: 'lib-empty',
        actions: [{label: COPY.showAll, variant: 'secondary', onClick: () => setView({filter: null, artist: null, album: null})}]});
    }
    edgeState = {key, destroy: () => node.destroy()};
    edgeHost.replaceChildren(node.el);
  }

  function canAddRemotely() {
    if (desktop?.available) return true;
    return onlineDevices(lib.devices.peek(), tick.peek()).length > 0;
  }

  function clearSearch() {
    if (topbar?.clearSearch && topbar.clearSearch()) return;
    setView({q: ''});
    topbar?.setSearch?.({value: '', onInput, onKeydown});
  }

  // ---------- render ----------

  /** New-song jobs (the "Adding" group) that the filter and search let through. */
  function addingJobs(state, songs) {
    if (state.artist || state.album) return [];
    const all = addingJobsOf(model.items.value ?? [], songs, {jobs: lib.jobs?.value});
    const byFilter = all.filter(j => (state.filter == null ? true : state.filter === 'processing' ? !isFailed(j) : state.filter === 'failed' ? isFailed(j) : false));
    const q = state.q.trim();
    return q ? byFilter.filter(j => matches({title: j.title ?? ''}, q)) : byFilter;
  }

  let visibleSongs = [];
  const selection = sharedSelection();
  selection.setOrder(() => visibleSongs.map(s => s.id));

  disposers.push(effect(() => {
    const state = view.value;
    const songsMap = lib.songs.value;
    const loaded = lib.loaded.value;
    const now = tick.value;
    const opened = prefs.value.value?.library?.opened ?? [];
    void cardMenu.value;
    void selection.ids.value;
    void selection.active.value;
    void lib.devices.value;
    void demo.value;
    const bySong = model.bySong.value ?? new Map();
    const items = model.items.value ?? [];

    // header
    const total = songsMap.size;
    const established = total >= FIRST_RUN_MIN;
    const sort = effectiveSort(state, songsMap);
    const sorted = parseSort(sort) ?? {key: 'added', reverse: false};
    untracked(() => {
      sortButton.set({label: COPY.sortButton(COPY.sorts[sorted.key])});
      groupButton.set({label: COPY.groupButton(state.group !== 'none' ? COPY.groups[state.group] : null)});
      layoutToggle.set({value: state.layout});
    });
    tools.hidden = !established;
    const counts = jobCounts({songs: songsMap, bySong, items});
    const options = FILTERS.filter(f => !CONDITIONAL_FILTERS.includes(f) || counts[f] > 0 || state.filter === f)
      .map(f => ({value: f, label: CONDITIONAL_FILTERS.includes(f) ? COPY.filterWithCount(COPY.filters[f], counts[f]) : COPY.filters[f]}));
    untracked(() => filters.set({options, value: state.filter ?? null}));
    filters.el.hidden = !established && !state.filter;
    renderDrills(state);
    filterHost.hidden = filters.el.hidden && !state.artist && !state.album;
    librarySection.dataset.established = established ? 'true' : 'false';

    // body
    if (!loaded) {
      setLibCount(null);
      untracked(showLoading);
      visibleSongs = [];
      return;
    }
    const adding = addingJobs(state, songsMap);
    if (total === 0 && !adding.length && !addingJobsOf(items, songsMap).length) {
      setLibCount(null);
      header.hidden = true;
      untracked(showFirstRun);
      visibleSongs = [];
      return;
    }
    header.hidden = false;
    const shown = filterSongs(songsMap, {q: state.q, filter: state.filter, artist: state.artist, album: state.album, jobs: bySong});
    const ordered = sortSongs(shown, sort);
    const groups = groupSongs(ordered, state.group);
    visibleSongs = groups.flatMap(g => g.songs);
    setLibCount(shown.length, total);

    const list = [];
    if (adding.length) {
      list.push({type: 'divider', key: 'divider:adding', label: COPY.adding});
      for (const job of adding) list.push({type: 'job', key: `job:${job.id}`, job});
      // Ungrouped, the songs need their own boundary, or they read as part of the Adding group.
      if (groups.length === 1 && groups[0].label == null && groups[0].songs.length) list.push({type: 'divider', key: 'divider:songs', label: COPY.songsDivider});
    }
    for (const g of groups) {
      if (g.label != null) list.push({type: 'group', key: `group:${g.key}`, group: g});
      for (const song of g.songs) list.push({type: 'song', key: `song:${song.id}`, song});
    }
    untracked(() => {
      if (!shown.length && !adding.length) {
        setMode('empty');
        showEdge(state.q.trim() ? 'noResults' : 'emptyFilter', state);
        return;
      }
      setMode('items');
      renderItems(list, state.layout, now, opened);
    });
  }));

  // Continue, pinned
  disposers.push(effect(() => {
    const songs = lib.songs.value;
    const now = tick.value;
    const profile = account.profile.value;
    const list = [...songs.values()];
    untracked(() => continueSection.update({songs: list, now, profile}));
  }));

  disposers.push(effect(() => {
    const songs = lib.songs.value;
    const pins = account.pins.value ?? [];
    const pinned = pins.map(id => songs.get(id)).filter(Boolean);
    pinnedSection.hidden = !pinned.length;
    untracked(() => {
      const keep = new Set(pinned.map(s => s.id));
      for (const [id, entry] of pinnedCards) if (!keep.has(id)) { entry.li.remove(); pinnedCards.delete(id); }
      pinned.forEach((song, i) => {
        let entry = pinnedCards.get(song.id);
        const line = artistLabel(song);
        if (!entry) {
          const card = CompactCard(song, {line, className: 'lib-pin'});
          card.el.addEventListener('click', e => { if (isPlainClick(e)) nameCover(card.cover, song.id); });
          entry = {card, li: h('li', {class: 'lib-shelf-item'}, card.el)};
          pinnedCards.set(song.id, entry);
        } else entry.card.update(song, {line});
        if (pinnedList.children[i] !== entry.li) pinnedList.insertBefore(entry.li, pinnedList.children[i] ?? null);
      });
    });
  }));

  // Drill-down chips: `Artist: Northbound ✕`
  function renderDrills(state) {
    const key = JSON.stringify([state.artist, state.album]);
    if (key === drillKey) return;
    drillKey = key;
    for (const chip of drillChips) chip.destroy();
    drillChips = [];
    const add = (label, clear) => {
      const chip = Chip({label, removable: true, tone: 'accent', removeLabel: COPY.removeDrill(label), className: 'lib-drill', onRemove: clear});
      drillChips.push(chip);
      drillHost.append(chip.el);
    };
    if (state.artist) add(COPY.drillArtist(state.artist), () => setView({artist: null}));
    if (state.album) add(COPY.drillAlbum(state.album), () => setView({album: null}));
    drillHost.hidden = !drillChips.length;
  }
  disposers.push(() => { for (const chip of drillChips) chip.destroy(); });

  // ---------- timers ----------

  const ticker = setInterval(() => { tick.value = clockNow(); }, RECHECK_MS);
  disposers.push(() => clearInterval(ticker));
  const slowTimer = setTimeout(() => { if (!lib.loaded.peek()) slow.value = true; }, STILL_CONNECTING_MS);
  disposers.push(() => clearTimeout(slowTimer));
  disposers.push(effect(() => {
    if (slow.value && !lib.loaded.value) untracked(showLoading);
  }));

  // settings.demo: the first-run Demo card (hidden when null).
  Promise.resolve().then(() => settingsApi.demo()).then(value => { if (!ac.signal.aborted) demo.value = value ?? null; }, () => {});

  // ---------- keyboard: roving focus ----------

  listen(body, 'focusin', e => {
    const card = e.target?.closest?.('[data-key]');
    const key = card?.dataset?.key;
    if (key && entries.get(key)?.card) setActiveKey(key);
  });

  function focusKey(key) {
    const entry = entries.get(key);
    if (!entry?.card) return false;
    setActiveKey(key);
    entry.card.focusTarget?.focus?.();
    return true;
  }

  function neighbour(fromKey, dir) {
    const i = order.indexOf(fromKey);
    if (i < 0) return order[0] ?? null;
    if (dir === 'prev') return order[Math.max(0, i - 1)];
    if (dir === 'next') return order[Math.min(order.length - 1, i + 1)];
    // up/down: the nearest card in the next row by geometry (the grid wraps by width)
    const rect = entries.get(fromKey).el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    let best = null, bestRow = null, bestDx = Infinity;
    for (const key of order) {
      if (key === fromKey) continue;
      const r = entries.get(key).el.getBoundingClientRect();
      const below = r.top > rect.top + 1, above = r.top < rect.top - 1;
      if ((dir === 'down' && !below) || (dir === 'up' && !above)) continue;
      const rowDist = Math.abs(r.top - rect.top);
      const dx = Math.abs(r.left + r.width / 2 - cx);
      if (bestRow == null || rowDist < bestRow - 1 || (Math.abs(rowDist - bestRow) <= 1 && dx < bestDx)) { best = key; bestRow = rowDist; bestDx = dx; }
    }
    return best;
  }

  listen(body, 'keydown', e => {
    if (!ARROWS.split(' ').includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (isTextInput(e.target)) return;
    const card = e.target?.closest?.('[data-key]');
    const key = card?.dataset?.key;
    if (!key || !entries.get(key)?.card) return;
    const list = layoutBuilt === 'list';
    let dir;
    if (e.key === 'ArrowLeft') dir = list ? null : 'prev';
    else if (e.key === 'ArrowRight') dir = list ? null : 'next';
    else if (e.key === 'ArrowUp') dir = list ? 'prev' : 'up';
    else dir = list ? 'next' : 'down';
    if (!dir) return;
    e.preventDefault();
    const next = neighbour(key, dir);
    if (next) focusKey(next);
  });

  // ---------- the search field ----------

  function onInput(value) {
    setView({q: value ?? ''});
  }

  function onKeydown(e) {
    if (e.isComposing) return;
    if (e.key === 'Enter' && view.peek().q.trim()) {
      const top = visibleSongs[0];
      if (!top) return;
      e.preventDefault();
      openSong(top, entries.get(`song:${top.id}`)?.card?.cover ?? null);
    } else if (e.key === 'ArrowDown') {
      const key = activeKey ?? order[0];
      if (key && focusKey(key)) e.preventDefault();
    }
  }

  topbar?.setSearch?.({value: view.peek().q, onInput, onKeydown});

  // ---------- ⌘V: a URL opens /add pre-filled (§3.5) ----------

  listen(doc, 'paste', e => {
    if (isTextInput(doc.activeElement) || isTextInput(e.target)) return;
    // A modal over the Library (the /add sheet, a dialog, a menu) keeps its own paste.
    if (e.target?.closest?.('[data-modal-outlet] > *, dialog, [popover]')) return;
    const text = e.clipboardData?.getData?.('text/plain') ?? e.clipboardData?.getData?.('text') ?? '';
    const url = String(text).trim();
    if (!URL_RE.test(url)) return;
    e.preventDefault();
    navigate(`/add?q=${encodeURIComponent(url)}`);
  });

  // ---------- the registry's 'library' context ----------

  const focusedSongId = () => {
    const key = doc.activeElement?.closest?.('[data-key]')?.dataset?.key;
    return key && key.startsWith('song:') && body.contains(doc.activeElement) ? key.slice(5) : null;
  };
  // Desktop first run (spec §6.6 item 6, §2.19): when the processor finishes setting up, open the Add sheet once.
  // The sheet itself marks onboarding.desktopFirstRun when it shows its first-song placeholder.
  if (desktop?.available && desktop.processor) {
    let sawFirstRun = false;
    disposers.push(effect(() => {
      const p = desktop.processor.value ?? {};
      if (p.firstRun) { sawFirstRun = true; return; }
      if (!sawFirstRun || firstRunAddOpened || !['ready', 'busy'].includes(p.phase)) return;
      if (!account.loaded.value || account.onboarding.value?.desktopFirstRun === true) return;
      firstRunAddOpened = true;
      untracked(() => navigate('/add'));
    }));
  }

  // Selection mode (spec §2.6): the floating bar lives at the end of the page; mounting it lets the card menu offer Select.
  const barHost = h('div', {class: 'lib-selbar-host'});
  content.append(barHost);
  const selBar = selection.mountBar(barHost, {router, store, desktop});
  const selCtx = selectionContext(selection, {deleteSelected: () => selBar.deleteSelected(), order: () => visibleSongs.map(s => s.id)});
  const libraryContext = {
    get selecting() { return selCtx.selecting; },
    exitSelection: () => selCtx.exitSelection(),
    select: () => selCtx.select(),
    selectAll: () => selCtx.selectAll(),
    deleteSelected: () => selCtx.deleteSelected(),
    get focusedSongId() { return focusedSongId(); },
    get layout() { return view.peek().layout; },
    openFocused() {
      const id = focusedSongId();
      if (id) openSong(lib.songs.peek().get(id), entries.get(`song:${id}`)?.card?.cover ?? null);
    },
    editFocused() {
      const id = focusedSongId();
      if (id) navigate(`/s/${encodeURIComponent(id)}/edit/details`);
    },
    focusFirst: () => (order.length ? focusKey(order[0]) : false),
    focusLast: () => (order.length ? focusKey(order[order.length - 1]) : false),
    toggleLayout: () => setView({layout: view.peek().layout === 'list' ? 'grid' : 'list'}),
    focusSearch: () => topbar?.focusSearch?.(),
  };
  const offProvider = registry.provide?.('library', () => libraryContext);
  if (offProvider) disposers.push(offProvider);

  // ---------- lifecycle ----------

  return {
    update(next) {
      const fresh = viewState(next?.query ?? {}, prefs.value.peek()?.library ?? {}, lib.songs.peek());
      const cur = view.peek();
      const same = ['q', 'sort', 'group', 'filter', 'artist', 'album', 'layout'].every(k => (fresh[k] ?? null) === (cur[k] ?? null));
      if (same && fresh.sortExplicit === cur.sortExplicit) return;
      batch(() => { view.value = fresh; });
      if (fresh.q !== cur.q) topbar?.setSearch?.({value: fresh.q, onInput, onKeydown});
    },
    unmount() {
      ac.abort();
      menu?.destroy?.();
      selBar.destroy();
      remoteBar?.destroy();
      for (const d of disposers.splice(0).reverse()) { try { d(); } catch (err) { console.error(err); } }
      for (const p of primitives) p.destroy?.();
      for (const entry of [...entries.values()]) entry.card?.destroy?.();
      entries.clear();
      firstRun?.destroy();
      edgeState?.destroy();
      skeleton?.destroy();
      continueSection.destroy();
      topbar?.setSearch?.(null);
      el.replaceChildren();
    },
  };
}
