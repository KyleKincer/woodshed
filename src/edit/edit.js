// The Edit posture frame (architecture §2.15, spec §5.0, wireframe §10.10): everything the three Edit
// tabs share, around the tab's own view.
//
//   mount(el, match, ctx) → {update(match), unmount()}            the view of /s/:songId/edit/:tab and
//                                                                 /s/:songId/edit/map/find (route 'editFind')
//   mountBulkPostureBar(el, {count, router, registry}) → {el, saveStatus, set({count}), destroy()}
//                                                                 the bulk Details variant (/edit/details?ids=,
//                                                                 mounted by src/edit/details/details.js)
//   createEditMapSession(session, {prefs, feedback}) → {mapSession, hooks}
//                                                                 Edit · Map's MapSession over the song session
//   COPY, CONTROLS                                                the frame's strings and controls table (§9.0)
//
// The frame, top to bottom:
// - The posture bar (48 px, a 2 px --edit top border): ‹ Done, the song title (the page's h1), the
//   label "Editing map" / "Editing drum chart" / "Editing details", the tabs Map · Chart · Details
//   (each a link; a switch replaces the history entry), ↶ Undo ↷ Redo routed to the tab's stack
//   (map.undo / chart.undo; Details has none) and the save status slot (`edit.saveStatus`).
// - The tab's view (role=tabpanel; the place's one [data-scroller]) and the inspector container:
//   on the right at 320 px on a laptop or in iPad landscape; in iPad portrait (any band layout) a
//   docked bottom sheet of 45% that collapses to its 56 px header, which also carries the hint "Map
//   editing is roomier in landscape" on the Map tab of a touch device. Map always has an inspector;
//   Chart shows the container only while its view put something in it; Details has none.
// - The slim transport (56 px, slim-transport.js).
//
// Done and Esc (§3.4 edit.done): Done goes back to this song's Stage, by history when the entry
// before Edit is that Stage (router.back), else by replacing Edit with it. Esc is layered: on Map it
// first clears a typed bar number, then stops a preview, then closes Find a chart (closing Find is
// Keep my map, D20); then it is Done. Leaving in the middle of a Find a chart audition (Done, a tab
// switch, Back) is the Find panel's: it keeps my map and asks "Use this map?" (src/edit/map/find-panel.js).
//
// The shared session: Edit is not a new song session. The router keeps the session between the
// Stage, Edit and Find, so playback, loop, speed and mix carry across; Edit never stops the
// transport. While mounted, Edit provides the 'edit', 'session' and 'transport' command contexts
// (and 'map' while the Map tab is open), runs the session's frame bus, store.stage, the wake lock,
// the interruption watcher, the Media Session and the gesture-audio resume, like the Stage does.
// Edit · Map sets `session.mapEditor` to its MapSession (D23: map changes go on the map stack) and
// clears it when the tab closes. The theme is the app theme (html[data-place=edit]), never the
// Stage's tokens.
//
// Key-cap hints (spec §5.0): the root gets [data-kbd-hints] once the keyboard has been used inside
// Edit, and only on (hover: hover) and (pointer: fine); Kbd({hint: true}) caps show inside it.
//
// The 'edit' command context (src/edit/commands.js and the tabs read it):
//   {tab, tabs, bulk: false, songId, setTab(tab), done(), escape(), undo(), redo(),
//    saveStatus: Signal<{state: 'saving'|'saved'|'local'|'conflict'|'error'|'idle', text, action?: {label, run}}|null>,
//    inspector: {el, open: Signal<boolean>}, layout: ReadonlySignal<'wide'|'portrait'>}
//
// The tab views (imported by contract path; the frame mounts one at a time):
//   Map      src/edit/map/view.js          mountMapView(el, {session, mapSession, inspectorEl, find, review, query,
//                                          mapHooks, edit, registry, onCloseFind}) → {destroy}
//   Chart    src/edit/chart/chart-edit.js  mount(el, {session, query, inspectorEl, edit, registry}) → {destroy}
//   Details  src/edit/details/details.js   mount(el, match, {...ctx, edit, embedded: true}) → {update, unmount}
// `mapHooks.status(text, opts)` and `mapHooks.rename(barIndex)` are the map view's to replace (its
// inspector status line and the sections lane's inline rename); until it does, results go to
// feedback.status. Tests and harnesses pass `ctx.editDeps` ({views, createWakeLock, …}).

import '../styles/views/edit/frame.css';
import {registry as appRegistry} from '../app/commands.js';
import {computed, effect, readonly, signal, store as appStore} from '../app/store.js';
import {prefs as appPrefs} from '../app/prefs.js';
import * as appFeedback from '../app/feedback.js';
import {createWakeLock, platform as appPlatform, startGestureAudio, startMediaSession, watchInterruptions} from '../app/platform.js';
import {h} from '../ui/h.js';
import {Button} from '../ui/button.js';
import {Kbd} from '../ui/kbd.js';
import {Tabs} from '../ui/tabs.js';
import {icon} from '../ui/icon.js';
import {createLayoutWatcher, stageLayout} from '../stage/layout.js';
import {closeSheets} from '../stage/sheets/host.js';
import {createMapSession} from './map/session.js';
import {mountSlimTransport} from './slim-transport.js';
import * as mapView from './map/view.js';
import * as chartView from './chart/chart-edit.js';
import * as detailsView from './details/details.js';
import {armEditOrigin, cameFromStage, COMMAND_COPY, EDIT_TABS, UNDO_COMMANDS} from './commands.js';

export const COPY = Object.freeze({
  done: COMMAND_COPY.done,
  labels: Object.freeze({map: 'Editing map', chart: 'Editing drum chart', details: 'Editing details'}),
  bulkLabel: (n) => `Editing details · ${n} ${n === 1 ? 'song' : 'songs'}`,
  tabs: COMMAND_COPY.tabs,
  tablist: 'Edit',
  undo: COMMAND_COPY.undo,
  redo: COMMAND_COPY.redo,
  inspector: 'Inspector',
  landscapeHint: 'Map editing is roomier in landscape',
  saving: 'Saving…',
  saved: 'Saved',
  notFoundTitle: 'Song not found',
  notFound: 'This song is no longer in your library.',
  readOnlyTitle: 'Editing is for your own songs',
  readOnly: 'Add this song to your library to edit its map, chart or details.',
  leave: 'Back to Library',
  tabFailed: (name) => `${name} couldn’t open.`,
  tryAgain: 'Try again',
  untitled: 'Untitled',
});

/** The frame's controls (role, accessible name, command), for the table test and registry CI (§9.0). */
export const CONTROLS = Object.freeze([
  {role: 'button', name: COPY.done, command: 'edit.done'},
  ...EDIT_TABS.map((tab) => ({role: 'tab', name: COPY.tabs[tab], command: `edit.tab.${tab}`})),
  {role: 'button', name: COPY.undo, command: UNDO_COMMANDS.map.undo, when: 'map'},
  {role: 'button', name: COPY.redo, command: UNDO_COMMANDS.map.redo, when: 'map'},
  {role: 'button', name: COPY.undo, command: UNDO_COMMANDS.chart.undo, when: 'chart'},
  {role: 'button', name: COPY.redo, command: UNDO_COMMANDS.chart.redo, when: 'chart'},
  {role: 'button', name: COPY.inspector, when: 'portrait'},
  {role: 'button', name: COPY.done, command: 'edit.done', variant: 'bulk'},
].map(Object.freeze));

/** The inspector's width on a laptop (px) and its share of the body in iPad portrait (%); the collapsed header (px). */
export const INSPECTOR = Object.freeze({width: 320, portraitPercent: 45, header: 56});
/** How often the Map tab's save status looks at the session's pending saves (ms). */
export const SAVE_POLL_MS = 250;

const PLAYING = new Set(['playing', 'counting']);
const peek = (v) => (v && typeof v.peek === 'function' ? v.peek() : v?.value ?? v ?? null);
const isTab = (t) => EDIT_TABS.includes(t);
const stagePath = (id) => `/s/${encodeURIComponent(id)}`;
const tabPath = (id, tab) => `/s/${encodeURIComponent(id)}/edit/${tab}`;

/** 'wide' (inspector on the right) or 'portrait' (bottom sheet), from the Stage's rail/band rule (spec §4.1, §5.0). */
export function editLayout({vw, vh} = {}) {
  return stageLayout({vw, vh}) === 'rail' ? 'wide' : 'portrait';
}

/** The tab a match opens: its :tab, Find opens Map, else Map. */
export function tabOfMatch(match) {
  const tab = match?.params?.tab;
  return isTab(tab) ? tab : 'map';
}

// ---------------------------------------------------------------------------------------------------------------
// Key-cap hints (spec §5.0): once the keyboard is used inside Edit, for the rest of the page's life.

let keyboardUsed = false;
/** Forgets keyboard use (tests). */
export function resetKeyboardHints() { keyboardUsed = false; }

function watchKeyboard(root, {platform, onUse}) {
  const mark = () => {
    if (keyboardUsed) return;
    keyboardUsed = true;
    onUse();
  };
  // Focus that lands on the root itself is the frame's own programmatic focus, not keyboard use.
  const onFocus = (e) => {
    const t = e.target;
    if (!t || t === root) return;
    try { if (t.matches?.(':focus-visible')) mark(); } catch { /* :focus-visible unsupported */ }
  };
  const onKey = (e) => { if (!e.isComposing) mark(); };
  root.addEventListener('keydown', onKey);
  root.addEventListener('focusin', onFocus);
  const fine = platform?.hoverFine;
  const offFine = fine?.subscribe?.(() => onUse()) ?? null;
  return () => {
    root.removeEventListener('keydown', onKey);
    root.removeEventListener('focusin', onFocus);
    offFine?.();
  };
}

function applyHints(root, platform) {
  const fine = platform?.hoverFine ? !!peek(platform.hoverFine) : false;
  root.toggleAttribute('data-kbd-hints', keyboardUsed && fine);
}

/** A key-cap that shows only as a hint (inside [data-kbd-hints]). */
function hintCap(keys) {
  const k = Kbd({keys, hint: true, className: 'edit-hint-cap'});
  k.el.setAttribute('aria-hidden', 'true');
  return k;
}

// ---------------------------------------------------------------------------------------------------------------
// The posture bar

/**
 * Builds a posture bar. `variant` 'song' has the title, tabs and Undo / Redo; 'bulk' only Done and
 * the label (the label is then the page's h1). Returns {el, setTab, setTitle, setLabel, destroy}.
 */
function createPostureBar({variant = 'song', title = '', label = '', tab = null, tabs = EDIT_TABS, onTab, hrefFor, saveStatus, registry}) {
  const parts = [];
  // Done runs edit.done (src/edit/commands.js registers it on import), which calls the 'edit' context's done().
  const done = Button({label: COPY.done, icon: 'chevron-left', variant: 'quiet', size: 'sm', command: 'edit.done', registry,
    className: 'edit-done'});
  const doneCap = hintCap('Escape');
  done.el.append(doneCap.el);
  parts.push(done, doneCap);

  const labelEl = h(variant === 'bulk' ? 'h1' : 'span', {class: 'edit-label'}, label);
  const titleEl = variant === 'bulk' ? null : h('h1', {class: 'edit-title selectable'}, title || COPY.untitled);
  const lead = h('div', {class: 'edit-bar-lead'}, done.el, titleEl, labelEl);

  let tabsEl = null, undo = null, redo = null, undoCap = null, redoCap = null;
  if (variant === 'song') {
    tabsEl = Tabs({
      id: 'edit-tabs', variant: 'posture', label: COPY.tablist, value: tab,
      tabs: tabs.map((t) => ({id: t, label: COPY.tabs[t], href: hrefFor?.(t), controls: 'edit-panel'})),
      onChange: (t) => onTab?.(t),
      className: 'edit-tabs',
    });
    undo = Button({label: COPY.undo, icon: 'undo-2', variant: 'quiet', size: 'sm', registry, className: 'edit-undo',
      attrs: {'aria-label': COPY.undo}});
    redo = Button({label: COPY.redo, icon: 'redo-2', variant: 'quiet', size: 'sm', registry, className: 'edit-redo',
      attrs: {'aria-label': COPY.redo}});
    undoCap = hintCap('Mod+KeyZ');
    redoCap = hintCap('Mod+Shift+KeyZ');
    undo.el.append(undoCap.el);
    redo.el.append(redoCap.el);
    parts.push(tabsEl, undo, redo, undoCap, redoCap);
  }

  // The save status slot: the tab's own saves (Chart's notation saves, Map's tempo saves).
  const statusText = h('span', {class: 'edit-save-text'});
  const statusActions = h('span', {class: 'edit-save-actions'});
  const statusEl = h('div', {class: 'edit-save', attrs: {role: 'status', 'aria-live': 'polite'}, dataset: {state: 'idle'}},
    statusText, statusActions);
  let actionButton = null;
  const offStatus = saveStatus?.subscribe ? effectOn(saveStatus, (s) => {
    actionButton?.destroy();
    actionButton = null;
    statusText.textContent = s?.text ?? '';
    statusEl.dataset.state = s?.state ?? 'idle';
    if (s?.action?.label && typeof s.action.run === 'function') {
      actionButton = Button({label: s.action.label, variant: 'secondary', size: 'sm', className: 'edit-save-action',
        onClick: () => s.action.run()});
      statusActions.replaceChildren(actionButton.el);
    } else {
      statusActions.replaceChildren();
    }
  }) : null;

  const trail = h('div', {class: 'edit-bar-trail'}, undo?.el, redo?.el, statusEl);
  const el = h('header', {class: 'edit-bar', dataset: {variant}}, lead, tabsEl?.el, trail);

  function setUndo(ids) {
    if (!undo) return;
    const has = !!ids;
    undo.el.hidden = !has;
    redo.el.hidden = !has;
    undo.set({command: ids?.undo ?? undefined, label: COPY.undo});
    redo.set({command: ids?.redo ?? undefined, label: COPY.redo});
  }

  return {
    el,
    setTab(t) {
      tabsEl?.set({value: t});
      setUndo(UNDO_COMMANDS[t] ?? null);
    },
    setTitle(text) { if (titleEl) titleEl.textContent = text || COPY.untitled; },
    setLabel(text) { labelEl.textContent = text; },
    focusTab() { tabsEl?.focus(); },
    tabId: (t) => tabsEl?.tabId(t) ?? null,
    destroy() {
      offStatus?.();
      actionButton?.destroy();
      for (const p of parts.reverse()) { try { p.destroy?.(); } catch { /* already gone */ } }
      el.remove();
    },
  };
}

/** Runs fn(value) now and on every change of `sig`; returns off. */
function effectOn(sig, fn) {
  fn(sig.peek());
  return sig.subscribe((v) => fn(v));
}

/**
 * The bulk Details posture bar (spec §5.3, §2.15): "Editing details · {n} songs", Done only (no tabs,
 * no slim transport); Done and Esc go back to the Library selection (router.back, fallback '/').
 * Provides the 'edit' command context while mounted, so edit.done (Esc) works there too.
 */
export function mountBulkPostureBar(el, {count = 0, router = null, registry = appRegistry, platform = appPlatform} = {}) {
  if (!el) throw new TypeError('mountBulkPostureBar: el is required');
  const saveStatus = signal(null);
  let n = Math.max(0, Math.round(Number(count) || 0));
  let leaving = false;
  let timer = null;
  const done = () => {
    if (leaving) return;
    leaving = true;
    timer = setTimeout(() => { leaving = false; }, 1500);
    if (router?.back) return router.back({fallback: '/'});
    return router?.navigate?.('/');
  };
  const api = Object.freeze({
    get tab() { return 'details'; },
    tabs: Object.freeze([]),
    bulk: true,
    songId: null,
    done,
    escape: done,
    undo: () => false,
    redo: () => false,
    saveStatus,
  });
  // Provided before the bar is built, so Done is enabled from its first paint.
  const offProvide = registry.provide('edit', () => api);
  const bar = createPostureBar({variant: 'bulk', label: COPY.bulkLabel(n), saveStatus, registry});
  const root = h('div', {class: 'edit-bulk', dataset: {tab: 'details'}}, bar.el);
  el.append(root);
  // Key-cap hints: keyboard use anywhere in the page the bar heads (the host `el`).
  const offKeys = watchKeyboard(el, {platform, onUse: () => applyHints(root, platform)});
  applyHints(root, platform);
  return {
    el: root,
    saveStatus,
    set({count: next} = {}) {
      if (next === undefined) return;
      n = Math.max(0, Math.round(Number(next) || 0));
      bar.setLabel(COPY.bulkLabel(n));
    },
    destroy() {
      clearTimeout(timer);
      offKeys();
      offProvide();
      bar.destroy();
      root.remove();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Edit · Map's MapSession over the song session (§2.15 createMapSession; hooks per Appendix C item 50)

/**
 * The MapSession of Edit · Map, wired to the song session: tempo saves and the notation map sync
 * pause for a Find a chart audition (D20); Preview restores the engine's loop exactly (no undo
 * step, no save); markers → sections tombstones the converted markers in practice without a
 * practice-undo entry (the map step's linked undo revives them). `hooks.status` and
 * `hooks.rename` are the map view's to replace.
 */
export function createEditMapSession(session, {prefs = appPrefs, feedback = appFeedback, create = createMapSession} = {}) {
  const engine = session.engine;
  const hooks = {
    suspendSaves: (on, opts) => session.suspendSaves?.(on, opts),
    pauseMapSync: (on) => session.notation?.setMapSyncPaused?.(!!on),
    status: (text, opts) => feedback.status?.(text, opts),
    rename: () => {},
    loop: {
      get: () => ({loop: {...engine.loop}, gap: engine.loopGap}),
      set: (value) => {
        const l = value?.loop;
        if (!l || !Number.isFinite(l.a) || !Number.isFinite(l.b)) return;
        engine.setLoop(!!l.enabled, l.a, l.b, {gapSec: value.gap?.sec ?? 0, gap: value.gap?.mode ?? 'silent'});
      },
    },
    markers: {
      list: () => (session.practice.value.peek().markers ?? []).filter((m) => !m.deleted),
      tombstone: (ids, deleted = true) => {
        const set = new Set(ids ?? []);
        if (!set.size) return;
        session.practice.patch((p) => {
          for (const m of p.markers) if (set.has(m.id)) m.deleted = !!deleted;
        });
      },
    },
  };
  const mapSession = create({engine, metronome: session.metronome, map: session.map, prefs, hooks});
  return {mapSession, hooks};
}

// ---------------------------------------------------------------------------------------------------------------
// The views a song posture cannot open

function mountNotice(el, {title, body, router, href = '/', linkText = COPY.leave}) {
  const titleId = 'edit-notice-title';
  const link = h('a', {class: 'edit-notice-link', href}, linkText);
  const root = h('div', {class: 'edit edit-notice', dataset: {editLayout: 'wide'}},
    h('div', {class: 'edit-notice-card', attrs: {role: 'alert', 'aria-labelledby': titleId}},
      h('h1', {class: 'edit-notice-title', id: titleId}, title),
      h('p', {class: 'edit-notice-body'}, body),
      link));
  const onLink = (e) => {
    if (!router || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.navigate?.(href, {replace: true});
  };
  link.addEventListener('click', onLink);
  el.replaceChildren(root);
  return {
    update() {},
    unmount() { link.removeEventListener('click', onLink); root.remove(); },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The view

// Namespace objects: details.js imports mountBulkPostureBar from this module, and a namespace is
// safe to hold across that cycle (it is read only when a tab opens).
const DEFAULT_VIEWS = Object.freeze({
  map: () => mapView,
  chart: () => chartView,
  details: () => detailsView,
});

const DEPS = Object.freeze({
  views: DEFAULT_VIEWS,
  createWakeLock, watchInterruptions, startMediaSession, startGestureAudio,
  prefs: appPrefs,
  createMapSession,
});

export async function mount(el, match, ctx = {}) {
  const guard = {teardown: null};
  try {
    return await mountEdit(el, match, ctx, guard);
  } catch (err) {
    try { guard.teardown?.(); } catch (cleanupErr) { console.error('[edit] cleanup after a failed mount failed', cleanupErr); }
    throw err;
  }
}

async function mountEdit(el, match, ctx, guard) {
  const deps = {...DEPS, ...(ctx.editDeps ?? {}), views: {...DEFAULT_VIEWS, ...(ctx.editDeps?.views ?? {})}};
  const registry = ctx.registry ?? appRegistry;
  const store = ctx.store ?? appStore;
  const feedback = ctx.feedback ?? appFeedback;
  const platform = ctx.platform ?? appPlatform;
  const router = ctx.router ?? null;
  const prefs = deps.prefs;
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (router) armEditOrigin(router);

  const session = ctx.session;
  if (!session || ctx.sessionError) {
    return mountNotice(el, {title: COPY.notFoundTitle, body: COPY.notFound, router});
  }
  if (session.readOnly) {
    return mountNotice(el, {title: COPY.readOnlyTitle, body: COPY.readOnly, router, href: stagePath(session.id), linkText: COPY.done});
  }

  const songId = session.id;
  const transport = session.transport;
  const offs = [];
  const cleanup = (fn) => { if (typeof fn === 'function') offs.push(fn); return fn; };
  let unmounted = false, torndown = false;

  // ---------------- state ----------------
  const measure = () => ({vw: win?.innerWidth ?? 0, vh: win?.innerHeight ?? 0});
  const layout = signal(editLayout(measure()));
  const tab = signal(tabOfMatch(match));
  const find = signal(match?.name === 'editFind' || match?.params?.find === true);
  const saveStatus = signal(null);
  const inspectorOpen = signal(true);          // portrait: the sheet is expanded
  const inspectorFilled = signal(false);       // Chart: the view put something in the inspector
  const playing = computed(() => PLAYING.has(transport.snapshot.value.phase));
  let current = null;        // {tab, view, mapSession, offs}
  let tabSeq = 0;
  let query = {...(match?.query ?? {})};

  // ---------------- DOM ----------------
  const songTitle = () => session.song.peek()?.title || COPY.untitled;
  let bar = null;            // the posture bar: built once the providers are in (below)
  const panel = h('section', {class: 'edit-main', id: 'edit-panel', attrs: {role: 'tabpanel', tabindex: '-1'}, dataset: {scroller: ''}});
  const inspectorBody = h('div', {class: 'edit-inspector-body', id: 'edit-inspector-body'});
  const toggle = h('button', {type: 'button', class: 'edit-inspector-toggle',
    attrs: {'aria-expanded': 'true', 'aria-controls': 'edit-inspector-body'}},
    h('span', {class: 'edit-inspector-grabber', attrs: {'aria-hidden': 'true'}}),
    h('span', {class: 'edit-inspector-name'}, COPY.inspector),
    icon('chevron-down', {size: 20}));
  const hint = h('p', {class: 'edit-inspector-hint'}, icon('info', {size: 16}), h('span', {}, COPY.landscapeHint));
  const inspectorHead = h('div', {class: 'edit-inspector-head'}, toggle, hint);
  const inspector = h('aside', {class: 'edit-inspector', attrs: {'aria-label': COPY.inspector}}, inspectorHead, inspectorBody);
  const body = h('div', {class: 'edit-body'}, panel, inspector);
  const transportHost = h('div', {class: 'edit-transport'});
  const root = h('div', {class: 'edit', attrs: {tabindex: '-1'}, dataset: {songId}}, body, transportHost);

  // ---------------- the 'edit' API ----------------
  const api = {
    get tab() { return tab.peek(); },
    tabs: EDIT_TABS,
    bulk: false,
    songId,
    setTab: (t) => setTab(t),
    done: () => done(),
    escape: () => escape(),
    undo: () => runUndo('undo'),
    redo: () => runUndo('redo'),
    saveStatus,
    inspector: Object.freeze({el: inspectorBody, open: readonly(inspectorOpen)}),
    layout: readonly(layout),
    get find() { return find.peek(); },
    closeFind: () => closeFind(),
  };

  // ---------------- providers (before the controls are built, so they paint enabled) ----------------
  cleanup(registry.provide('edit', () => (unmounted ? undefined : api)));
  cleanup(registry.provide('session', () => (unmounted ? undefined : session)));
  cleanup(registry.provide('transport', () => (unmounted ? undefined : transport)));

  function teardown() {
    if (torndown) return;
    torndown = true;
    unmounted = true;
    tabSeq++;
    closeTab();
    try { closeSheets(); } catch (err) { console.error('[edit] sheet cleanup failed', err); }
    for (const off of offs.splice(0).reverse()) { try { off(); } catch (err) { console.error('[edit] cleanup failed', err); } }
    try { bar?.destroy(); } catch (err) { console.error('[edit] posture bar cleanup failed', err); }
    registry.invalidate();
    root.remove();
  }
  guard.teardown = teardown;

  bar = createPostureBar({
    variant: 'song', title: songTitle(), label: COPY.labels[tab.peek()], tab: tab.peek(), registry, saveStatus,
    onTab: (t) => { void setTab(t); }, hrefFor: (t) => tabPath(songId, t),
  });
  root.prepend(bar.el);

  // ---------------- layout and the inspector ----------------
  function paintFrame() {
    const t = tab.peek();
    root.dataset.editLayout = layout.peek();
    root.dataset.tab = t;
    root.toggleAttribute('data-find', find.peek());
    const shown = t === 'map' || (t === 'chart' && inspectorFilled.peek());
    const portrait = layout.peek() === 'portrait';
    const open = !portrait || inspectorOpen.peek();
    inspector.hidden = !shown;
    root.dataset.inspector = !shown ? 'none' : open ? 'open' : 'collapsed';
    inspectorBody.hidden = shown && !open;
    toggle.setAttribute('aria-expanded', String(open));
    hint.hidden = !(portrait && t === 'map' && (platform.isIPad || !!peek(platform.coarse)));
  }
  cleanup(effect(() => { layout.value; tab.value; find.value; inspectorOpen.value; inspectorFilled.value; paintFrame(); }));
  toggle.addEventListener('click', () => { inspectorOpen.value = !inspectorOpen.peek(); });

  const watcher = createLayoutWatcher({measure, onChange: (next) => { layout.value = next.layout === 'rail' ? 'wide' : 'portrait'; }});
  const onResize = () => watcher.schedule();
  win?.addEventListener?.('resize', onResize);
  win?.addEventListener?.('orientationchange', onResize);
  cleanup(() => {
    watcher.destroy();
    win?.removeEventListener?.('resize', onResize);
    win?.removeEventListener?.('orientationchange', onResize);
  });

  // Chart shows the inspector only while its view filled it.
  const filled = () => { inspectorFilled.value = inspectorBody.childElementCount > 0; };
  if (typeof win?.MutationObserver === 'function') {
    const mo = new win.MutationObserver(filled);
    mo.observe(inspectorBody, {childList: true});
    cleanup(() => mo.disconnect());
  }

  // ---------------- key-cap hints ----------------
  cleanup(watchKeyboard(root, {platform, onUse: () => applyHints(root, platform)}));
  applyHints(root, platform);

  // ---------------- the title follows the song ----------------
  cleanup(session.song.subscribe?.(() => bar.setTitle(songTitle())));

  // ---------------- tabs ----------------
  function closeTab() {
    const c = current;
    current = null;
    if (!c) return;
    try {
      if (c.view?.unmount) void c.view.unmount();
      else c.view?.destroy?.();
    } catch (err) { console.error(`[edit] the ${c.tab} view cleanup failed`, err); }
    for (const off of c.offs.splice(0).reverse()) { try { off(); } catch (err) { console.error('[edit] cleanup failed', err); } }
    if (c.mapSession) {
      try { c.mapSession.destroy(); } catch (err) { console.error('[edit] the map session cleanup failed', err); }
      if (session.mapEditor?.peek?.() === c.mapSession) session.mapEditor.value = null;
    }
    saveStatus.value = null;
    panel.replaceChildren();
    inspectorBody.replaceChildren();
    inspectorFilled.value = false;
  }

  /** Map: "Saving…" after a map change, "Saved" once the session has nothing pending. */
  function watchMapSaves(mapSession) {
    let timer = null;
    const poll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (session.disposed) return;
        if (session.pending || peek(mapSession.auditioning)) poll();
        else saveStatus.value = {state: 'saved', text: COPY.saved};
      }, SAVE_POLL_MS);
    };
    const off = session.map.subscribe((reason) => {
      if (reason === 'load' || peek(mapSession.auditioning)) return;
      saveStatus.value = {state: 'saving', text: COPY.saving};
      poll();
    });
    return () => { off?.(); clearTimeout(timer); };
  }

  function showError(t, err) {
    console.error(`[edit] the ${t} tab could not open`, err);
    const retry = Button({label: COPY.tryAgain, variant: 'primary', className: 'edit-tab-retry', onClick: () => { void showTab(t); }});
    const card = h('div', {class: 'edit-tab-error', attrs: {role: 'alert'}},
      h('p', {class: 'edit-tab-error-title'}, COPY.tabFailed(COPY.tabs[t])),
      err?.message ? h('p', {class: 'edit-tab-error-body selectable'}, String(err.message)) : null,
      retry.el);
    current?.offs.push(() => retry.destroy());
    panel.replaceChildren(card);
  }

  async function showTab(t, {focusPanel = false} = {}) {
    if (unmounted || !isTab(t)) return;
    const seq = ++tabSeq;
    closeTab();
    tab.value = t;
    bar.setTab(t);
    bar.setLabel(COPY.labels[t]);
    panel.setAttribute('aria-labelledby', bar.tabId(t) ?? '');
    if (prefs.get('edit.lastTab') !== t) prefs.set('edit.lastTab', t);
    const entry = {tab: t, view: null, mapSession: null, offs: []};
    current = entry;

    if (t === 'map') {
      const {mapSession, hooks} = createEditMapSession(session, {prefs, feedback, create: deps.createMapSession});
      entry.mapSession = mapSession;
      entry.hooks = hooks;
      session.mapEditor.value = mapSession;
      entry.offs.push(registry.provide('map', () => (current === entry ? mapSession : undefined)));
      entry.offs.push(watchMapSaves(mapSession));
      for (const s of [mapSession.canUndo, mapSession.canRedo, mapSession.auditioning, mapSession.digits]) {
        if (s?.subscribe) entry.offs.push(s.subscribe(() => registry.invalidate()));
      }
    }
    registry.invalidate();

    let mod;
    try {
      mod = await deps.views[t]();
    } catch (err) {
      if (seq === tabSeq && !unmounted) showError(t, err);
      return;
    }
    if (seq !== tabSeq || unmounted) return;
    try {
      entry.view = await openView(t, mod, entry);
    } catch (err) {
      if (seq === tabSeq && !unmounted) showError(t, err);
      return;
    }
    if (seq !== tabSeq || unmounted) {
      try { entry.view?.unmount ? void entry.view.unmount() : entry.view?.destroy?.(); } catch { /* superseded */ }
      return;
    }
    applyQuery(query);
    if (focusPanel) panel.focus({preventScroll: true});
    registry.invalidate();
  }

  function openView(t, mod, entry) {
    if (t === 'map') {
      if (typeof mod.mountMapView !== 'function') throw new TypeError('src/edit/map/view.js has no mountMapView');
      return mod.mountMapView(panel, {
        session, mapSession: entry.mapSession, inspectorEl: inspectorBody, find: find.peek(),
        review: query.review === 'sections', query: {...query}, mapHooks: entry.hooks, edit: api, registry,
        onCloseFind: () => closeFind(),
      });
    }
    if (t === 'chart') {
      if (typeof mod.mount !== 'function') throw new TypeError('src/edit/chart/chart-edit.js has no mount');
      return mod.mount(panel, {session, query: {...query}, inspectorEl: inspectorBody, edit: api, registry});
    }
    if (typeof mod.mount !== 'function') throw new TypeError('src/edit/details/details.js has no mount');
    const detailsMatch = {...(match ?? {}), name: 'edit', params: {songId, tab: 'details'}, query: {...query}};
    return mod.mount(panel, detailsMatch, {...ctx, session, edit: api, embedded: true, registry, feedback, platform, router});
  }

  /** ?bar=N on Map selects bar N (display number); the views get the rest of the query. */
  function applyQuery(q) {
    const c = current;
    if (!c) return;
    if (c.tab === 'map' && c.mapSession && q.bar !== undefined && session.map.isReal) {
      const n = Number(q.bar);
      if (Number.isFinite(n)) c.mapSession.goToBar(n);
    }
  }

  // ---------------- tab switches, Find, Done, Esc ----------------
  // A Find a chart audition in progress settles itself when the route changes (the Find panel's
  // router.onLeave: Keep my map, then "Use this map?" when the session stays open, D20).
  async function setTab(t) {
    if (unmounted || !isTab(t)) return;
    if (t === tab.peek() && !find.peek()) return;
    if (router?.navigate) { await router.navigate(tabPath(songId, t), {replace: true}); return; }
    find.value = false;
    query = {};
    await showTab(t);
  }

  async function closeFind() {
    if (!find.peek() || unmounted) return;
    if (router?.navigate) { await router.navigate(tabPath(songId, 'map'), {replace: true}); return; }
    find.value = false;
    await showTab('map');
  }

  let leaving = false;
  async function done() {
    if (leaving || unmounted || !router) return;
    leaving = true;
    const timer = setTimeout(() => { leaving = false; }, 1500);
    cleanup(() => clearTimeout(timer));
    const path = stagePath(songId);
    if (cameFromStage(songId) && router.back) await router.back({fallback: path});
    else await router.navigate?.(path, {replace: true});
  }

  /** The layered Esc (§3.4): returns what it did ('digits' | 'preview' | 'find' | 'audition' | 'done'). */
  function escape() {
    const c = current;
    const ms = c?.tab === 'map' ? c.mapSession : null;
    if (ms) {
      if (peek(ms.digits)) { ms.clearDigits(); return 'digits'; }
      if (peek(ms.previewing)) { void ms.togglePreview(); return 'preview'; }
    }
    if (find.peek()) { void closeFind(); return 'find'; }
    if (ms && peek(ms.auditioning)) { ms.endAudition({commit: false}); return 'audition'; }
    void done();
    return 'done';
  }

  function runUndo(which) {
    const ids = UNDO_COMMANDS[tab.peek()];
    if (!ids) return false;
    return registry.run(ids[which], {source: 'pointer'});
  }

  // ---------------- registry state follows the song, undo, loading and the transport ----------------
  for (const s of [session.song, session.undo?.canUndo, session.undo?.canRedo, session.load, transport.snapshot].filter((x) => x?.subscribe)) {
    cleanup(s.subscribe(() => registry.invalidate()));
  }

  // ---------------- html[data-load-phase] and [data-transport-phase] (as on the Stage; the fixture waits on them) ----------------
  const html = doc.documentElement;
  cleanup(effect(() => { html.dataset.transportPhase = transport.snapshot.value.phase; }));
  cleanup(effect(() => { const phase = session.load?.value?.phase; if (phase) html.dataset.loadPhase = phase; }));
  cleanup(() => { delete html.dataset.transportPhase; delete html.dataset.loadPhase; });

  // ---------------- store.stage and the per-session platform services ----------------
  cleanup(effect(() => {
    store.stage.value = {songId, layout: layout.value === 'wide' ? 'rail' : 'band', surface: null, playing: playing.value, focus: false};
  }));
  cleanup(() => { if (store.stage.peek()?.songId === songId) store.stage.value = null; });
  const wake = deps.createWakeLock();
  cleanup(effect(() => { wake.update?.({stageOpen: true, playing: playing.value}); }));
  cleanup(() => wake.destroy?.() ?? wake.release?.());
  cleanup(deps.watchInterruptions({engine: session.engine, transport, platform}));
  cleanup(deps.startMediaSession({transport, session}));
  cleanup(deps.startGestureAudio({transport, engine: session.engine}));
  session.frame?.start?.();
  cleanup(() => session.frame?.stop?.());

  // ---------------- build ----------------
  el.replaceChildren(root);
  const slim = mountSlimTransport(transportHost, {session, registry});
  cleanup(() => slim.destroy());
  paintFrame();
  // Keys reach Edit (and its key-cap hints) even before anything inside is focused.
  if (!doc.activeElement || doc.activeElement === doc.body || !root.contains(doc.activeElement)) root.focus({preventScroll: true});
  await showTab(tab.peek());

  return {
    update(next) {
      if (unmounted) return;
      const nextTab = tabOfMatch(next);
      const nextFind = next?.name === 'editFind' || next?.params?.find === true;
      query = {...(next?.query ?? {})};
      if (nextTab !== tab.peek() || nextFind !== find.peek()) {
        find.value = nextFind;
        void showTab(nextTab);
        return;
      }
      current?.view?.update?.({...next, query: {...query}});
      applyQuery(query);
    },
    unmount() {
      if (unmounted) return;
      teardown();
      if (!session.disposed) void session.flush({final: true});
    },
  };
}

export default mount;
