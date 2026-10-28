// Settings (architecture §2.17, §9.10 SE1; spec §6.2, §1.2): the place at /settings and
// /settings/:section, and the pieces every section shares.
//
//   mount(el, match, ctx) → Promise<{update(match), unmount()}>      the route view (§2.3 Mounting)
//
// Layout (dimensions as inputs, §0.1): `settingsLayout(width)` is 'split' for a laptop or iPad
// landscape window (a 200 px section nav plus content ≤ 720 px) and 'stack' at iPad portrait widths
// and below (a list of sections, then a detail page). The window's width decides, and a resize that
// crosses the line re-renders in the other layout.
//
// Routes (the router remounts between `settings` and `settingsPage`, and calls update() between two
// sections of `settingsPage`):
//   /settings               split: replaced by the first section · stack: the list
//   /settings/:section      split: nav + that section · stack: the detail page with "‹ Settings"
//   an unknown section      replaced by /settings
// History and Back (spec §1.2): on a laptop a section change replaces the URL, so Back leaves
// Settings for the Library; on iPad portrait the list pushes the detail page, so Back returns to the
// list. The detail page's "‹ Settings" goes back when the list opened it, else replaces the URL with
// the list (a deep link). List and nav links carry data-focus-key, so Back refocuses the section.
//
// Sections are modules under ./sections/ (resolved through import.meta.glob: SE2's Processing and
// Plan & storage appear once their files exist, D2 applied to later-wave modules, Appendix C item 58).
// Each default-exports {id, title, desktopOnly?, render(el, ctx) → {destroy()}}. A section marked
// desktopOnly in settings.copy.js SECTIONS is not listed on the web. `ctx` is the view's context with
// the app modules filled in: {router, account, prefs, platform, desktop, install, store, registry,
// feedback, layout, headingId, window}. Tests and harnesses pass their own account, prefs, platform,
// desktop, install, store, registry and `sectionModules`.
//
// Shared by the sections (spec §6.2: "every control saves on change and shows an inline Saved;
// failure shows Couldn't save · [Retry]"; D40's account vs device split):
//   createSaver({focus}) → {el, run(fn) → Promise<boolean>, state, destroy()}
//       run() calls fn (sync or async). Success shows "Saved" (fades after 2 s); a throw or a
//       rejection shows "Couldn't save · [Retry]" (role=alert), and Retry runs the same fn again.
//       Only the latest run reports. `focus()` names where focus goes when Retry disappears.
//   settingRow({row, label, hint, scope, controls, saver, labelId}) → {el, labelId, hintId}
//       a labelled group (role=group named by its visible label, data-row=<row>); scope 'account',
//       'device' (adds the "This device" tag) or 'info' (facts, nothing saved); the hint is linked
//       from the group with aria-describedby (`${labelId}-hint`, so a control made first can point
//       at it too). A row without a label (a toggle names itself) is a plain block.
//   desktopNote(items) → Element     "These need Woodshed for desktop: … [Get it ↗]" (web only)

import '../styles/views/settings/frame.css';
import {h} from '../ui/h.js';
import {Button, uid} from '../ui/button.js';
import {icon} from '../ui/icon.js';
import {FADE_MS, SAVED_MS} from '../ui/field.js';
import {account as appAccount} from '../app/account.js';
import {prefs as appPrefs} from '../app/prefs.js';
import {install as appInstall, platform as appPlatform} from '../app/platform.js';
import {desktop as appDesktop} from '../app/desktop.js';
import {store as appStore} from '../app/store.js';
import {registry as appRegistry} from '../app/commands.js';
import {COPY, SECTIONS} from './settings.copy.js';

/** Section modules by path ('./sections/practice.js'); lazy, so the nav needs only their names. */
export const SECTION_MODULES = import.meta.glob('./sections/*.js');

/** At or below this window width Settings is a list, then a detail page (iPad portrait is 820). */
export const STACK_MAX_WIDTH = 899;

/** 'split' (section nav beside the content) or 'stack' (list → detail) for a window width. */
export function settingsLayout(width) {
  return Number.isFinite(width) && width > 0 && width <= STACK_MAX_WIDTH ? 'stack' : 'split';
}

export const sectionPath = id => `./sections/${id}.js`;

/** The sections that exist (their module is present) and apply here, in spec order. */
export function availableSections({modules = SECTION_MODULES, desktopApp = false} = {}) {
  return SECTIONS.filter(s => typeof modules[sectionPath(s.id)] === 'function' && (!s.desktopOnly || desktopApp));
}

/** History state the list puts on the detail page it opens, so "‹ Settings" can go back to it. */
export const FROM_LIST = 'settings-list';

// ---------------------------------------------------------------------------------------------
// Shared section pieces

/** Inline "Saved" / "Couldn't save · [Retry]" for one setting. See the header. */
export function createSaver({focus = null, timers = globalThis} = {}) {
  const savedText = h('span', {class: 'settings-save-text'});
  const saved = h('span', {class: 'settings-save', role: 'status', dataset: {tone: 'ok'}}, savedText);
  const retry = h('button', {type: 'button', class: 'settings-save-retry'}, COPY.retry);
  const failed = h('span', {class: 'settings-save', role: 'alert', dataset: {tone: 'error'}, hidden: true},
    h('span', {class: 'settings-save-icon', 'aria-hidden': 'true'}, icon('alert-circle', {size: 20})),
    h('span', {class: 'settings-save-text'}, COPY.saveFailed), h('span', {class: 'settings-save-sep', 'aria-hidden': 'true'}, '·'), retry);
  const el = h('span', {class: 'settings-saver'}, saved, failed);
  let seq = 0, lastFailed = null, state = 'idle', fadeTimer = null, clearTimer = null, destroyed = false;

  const clearTimers = () => {
    timers.clearTimeout(fadeTimer);
    timers.clearTimeout(clearTimer);
    fadeTimer = clearTimer = null;
  };

  function show(next) {
    clearTimers();
    state = next;
    if (failed.contains(el.ownerDocument.activeElement) && next !== 'failed') focus?.()?.focus?.({preventScroll: true});
    failed.hidden = next !== 'failed';
    saved.removeAttribute('data-fading');
    savedText.textContent = next === 'saved' ? COPY.saved : '';
    if (next === 'saved') {
      fadeTimer = timers.setTimeout(() => {
        saved.setAttribute('data-fading', '');
        clearTimer = timers.setTimeout(() => {
          savedText.textContent = '';
          saved.removeAttribute('data-fading');
          state = 'idle';
        }, FADE_MS);
      }, SAVED_MS);
    }
  }

  function run(fn) {
    const mine = ++seq;
    lastFailed = null;
    let result;
    try { result = fn(); } catch (err) { result = Promise.reject(err); }
    return Promise.resolve(result).then(
      () => {
        if (mine === seq && !destroyed) show('saved');
        return true;
      },
      err => {
        console.warn('[settings] a setting was not saved:', err?.message ?? err);
        if (mine === seq && !destroyed) {
          lastFailed = fn;
          show('failed');
        }
        return false;
      });
  }

  retry.addEventListener('click', () => { if (lastFailed) run(lastFailed); });

  return {
    el,
    run,
    get state() { return state; },
    destroy() {
      destroyed = true;
      clearTimers();
      el.remove();
    },
  };
}

/** A labelled settings row. See the header. */
export function settingRow({row = null, label = null, hint = null, scope = 'account', controls = [], saver = null, labelId = null, className = ''} = {}) {
  const id = labelId ?? uid('settings-row');
  const hintId = hint ? `${id}-hint` : null;
  const labelEl = label ? h('div', {class: 'settings-row-label', id}, label) : null;
  const tag = scope === 'device' ? h('span', {class: 'settings-scope'}, COPY.thisDevice) : null;
  const head = labelEl || tag ? h('div', {class: 'settings-row-head'}, labelEl, tag) : null;
  const list = Array.isArray(controls) ? controls : [controls];
  const el = h('div', {
    class: ['settings-row', className],
    role: labelEl ? 'group' : null,
    'aria-labelledby': labelEl ? id : null,
    'aria-describedby': hintId,
    dataset: {scope, row},
  },
  head,
  h('div', {class: 'settings-row-control'}, list.map(c => c?.el ?? c), saver?.el ?? null),
  hint ? h('p', {class: 'settings-row-hint', id: hintId}, hint) : null);
  return {el, labelId: labelEl ? id : null, hintId};
}

/** The one web note for desktop-only rows (spec §6.2): "These need Woodshed for desktop: … [Get it ↗]". */
export function desktopNote(items) {
  return h('p', {class: 'settings-desktop-note'},
    h('span', {}, COPY.desktopNote(items)), ' ',
    h('a', {href: COPY.desktopHref, target: '_blank', rel: 'noopener', class: 'settings-desktop-link'}, COPY.desktopGet));
}

// ---------------------------------------------------------------------------------------------
// The view

const plainClick = e => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export async function mount(el, match, ctx = {}) {
  const doc = el.ownerDocument;
  const win = ctx.window ?? doc.defaultView;
  const env = {
    router: ctx.router ?? null,
    account: ctx.account ?? appAccount,
    prefs: ctx.prefs ?? appPrefs,
    platform: ctx.platform ?? appPlatform,
    desktop: ctx.desktop ?? appDesktop,
    install: ctx.install ?? appInstall,
    store: ctx.store ?? appStore,
    registry: ctx.registry ?? appRegistry,
    feedback: ctx.feedback ?? null,
    window: win,
  };
  const modules = ctx.sectionModules ?? SECTION_MODULES;
  const desktopApp = !!(env.platform?.isDesktopApp || env.desktop?.available);
  const sections = availableSections({modules, desktopApp});
  const previousTitle = doc.title;

  const scroller = h('div', {class: 'settings-scroller', attrs: {'data-scroller': true}});
  el.replaceChildren(scroller);

  let frame = null;         // {layout, view, root, links: Map<id, a>, body, heading}
  let section = null;       // {id, handle}
  let lastMatch = match;
  let loadSeq = 0;
  let destroyed = false;

  const measure = () => settingsLayout(Number(win?.innerWidth));
  const navigate = (to, opts) => env.router?.navigate?.(to, opts);

  function navList(layout) {
    const links = new Map();
    const items = sections.map(s => {
      const a = h('a', {
        href: `/settings/${s.id}`, class: 'settings-nav-link', dataset: {focusKey: `settings:${s.id}`, section: s.id},
        on: {click: e => onLink(e, s.id)},
      },
      h('span', {class: 'settings-nav-text'},
        h('span', {class: 'settings-nav-title'}, s.title),
        layout === 'stack' ? h('span', {class: 'settings-nav-summary'}, s.summary) : null),
      layout === 'stack' ? h('span', {class: 'settings-nav-chevron', 'aria-hidden': 'true'}, icon('chevron-right', {size: 20})) : null);
      links.set(s.id, a);
      return h('li', {class: 'settings-nav-item'}, a);
    });
    return {list: h('ul', {class: 'settings-nav-list', role: 'list'}, items), links};
  }

  function onLink(e, id) {
    if (!plainClick(e)) return;
    e.preventDefault();
    if (!frame) return;
    if (frame.layout === 'split') {
      if (section?.id !== id) navigate(`/settings/${id}`, {replace: true});
    } else {
      navigate(`/settings/${id}`, {state: {from: FROM_LIST}});
    }
  }

  function goBack() {
    if (lastMatch?.state?.from === FROM_LIST && env.router?.back) env.router.back({fallback: '/settings'});
    else navigate('/settings', {replace: true});
  }

  function build(layout, view) {
    destroySection();
    frame?.back?.destroy();
    const titleId = uid('settings-title');
    const headingId = uid('settings-heading');
    const root = h('div', {class: 'app-content settings', dataset: {layout, view}});
    const f = {layout, view, root, links: new Map(), body: null, heading: null, headingId, back: null};
    if (view === 'list') {
      const {list, links} = navList('stack');
      f.links = links;
      f.heading = h('h1', {class: 'settings-title', id: titleId, tabindex: '-1'}, COPY.title);
      root.append(h('nav', {class: 'settings-list', 'aria-labelledby': titleId}, f.heading, list));
    } else if (layout === 'split') {
      const {list, links} = navList('split');
      f.links = links;
      f.heading = h('h2', {class: 'settings-section-title', id: headingId, tabindex: '-1'});
      f.body = h('div', {class: 'settings-section-body'});
      root.append(
        h('nav', {class: 'settings-nav', 'aria-label': COPY.navLabel},
          h('h1', {class: 'settings-title', id: titleId}, COPY.title), list),
        h('section', {class: 'settings-content', 'aria-labelledby': headingId}, f.heading, f.body));
    } else {
      f.back = Button({label: COPY.back, icon: 'chevron-left', variant: 'quiet', className: 'settings-back', onClick: () => goBack()});
      f.heading = h('h1', {class: 'settings-section-title', id: headingId, tabindex: '-1'});
      f.body = h('div', {class: 'settings-section-body'});
      root.append(h('section', {class: 'settings-content', 'aria-labelledby': headingId}, f.back.el, f.heading, f.body));
    }
    scroller.replaceChildren(root);
    frame = f;
  }

  function destroySection() {
    loadSeq++;
    try { section?.handle?.destroy?.(); } catch (err) { console.error('[settings] a section failed to close', err); }
    section = null;
  }

  async function openSection(id) {
    destroySection();
    const token = loadSeq;
    const meta = sections.find(s => s.id === id);
    frame.heading.textContent = meta.title;
    for (const [key, a] of frame.links) {
      if (key === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    doc.title = COPY.sectionDocumentTitle(meta.title);
    frame.body.replaceChildren(h('p', {class: 'settings-loading', role: 'status'}, COPY.loading));
    let def;
    try {
      def = (await modules[sectionPath(id)]()).default;
    } catch (err) {
      if (token !== loadSeq || destroyed) return;
      console.error(`[settings] the ${id} section could not load`, err);
      const retry = Button({label: COPY.loadRetry, onClick: () => openSection(id)});
      frame.body.replaceChildren(h('div', {class: 'settings-load-error', role: 'alert'}, h('p', {}, COPY.loadFailed), retry.el));
      section = {id, handle: {destroy: () => retry.destroy()}};
      return;
    }
    if (token !== loadSeq || destroyed) return;
    if (def?.desktopOnly && !desktopApp) { navigate('/settings', {replace: true}); return; }
    frame.heading.textContent = def?.title ?? meta.title;
    frame.body.replaceChildren();
    const handle = def.render(frame.body, {...env, layout: frame.layout, headingId: frame.headingId});
    section = {id, handle};
  }

  async function show(m, {focus = false} = {}) {
    lastMatch = m;
    const requested = m?.params?.section ?? null;
    const layout = measure();
    if (requested && !sections.some(s => s.id === requested)) {
      navigate('/settings', {replace: true});
      return;
    }
    if (!requested && layout === 'split') {
      if (sections.length) navigate(`/settings/${sections[0].id}`, {replace: true});
      return;
    }
    const view = requested ? 'detail' : 'list';
    const rebuilt = !frame || frame.layout !== layout || frame.view !== view;
    if (rebuilt) build(layout, view);
    if (view === 'list') {
      doc.title = COPY.documentTitle;
      if (focus) frame.heading.focus({preventScroll: true});
      return;
    }
    if (rebuilt || section?.id !== requested) {
      const opening = openSection(requested);
      if (focus || (rebuilt && layout === 'stack')) frame.heading.focus({preventScroll: true});
      await opening;
    }
  }

  let resizeTimer = null;
  const onResize = () => {
    win.clearTimeout(resizeTimer);
    resizeTimer = win.setTimeout(() => {
      if (destroyed || !frame || measure() === frame.layout) return;
      const hadFocus = scroller.contains(doc.activeElement);
      void show(lastMatch, {focus: hadFocus});
    }, 150);
  };
  win?.addEventListener?.('resize', onResize);

  await show(match, {focus: true});

  return {
    update(m) { return show(m); },
    unmount() {
      destroyed = true;
      win?.removeEventListener?.('resize', onResize);
      win?.clearTimeout?.(resizeTimer);
      destroySection();
      frame?.back?.destroy();
      frame = null;
      scroller.remove();
      if (doc.title.endsWith(COPY.documentTitle)) doc.title = previousTitle;
    },
  };
}

