// The /download page (architecture §2.3 bootRoutes, §9.6 DL1; spec §1.2): 1.9's download page
// (src/js/desktop.js renderDownload) on the 2.0 primitives and tokens.
//
//   boot(match, deps?) → Promise<View>       bootRoutes entry: main.js hands /download over to it
//                                             before auth; renders into #app, sets the document
//                                             title and html[data-view-ready=download]
//   mountDownload(el, deps?) → View          renders the page into `el` (harnesses, tests)
//   View = {el, ready: Promise<state>, state(), reload(), destroy()}
//   deps = {fetch, sources, timeoutMs, navigator, desktopApp, origin, reducedMotion}
//          (defaults: the window's fetch, RELEASE_SOURCES, 10 s, the browser's navigator,
//          platform.isDesktopApp, location.origin, the reduced-motion preference)
//   linkTarget({href, newTab, desktopApp, origin}) → {target, rel, inPlace}
//   isSameOrigin(href, origin) → boolean
//
// Logic kept from 1.9: detectPlatform() picks the recommended installer; fetchRelease() tries
// /api/downloads and then the bundled /downloads.json (each with its own timeout); a complete
// outage shows "Downloads couldn't load…" with Try again. Mobile, ChromeOS and ARM Linux get the
// web player as the primary. The page root carries data-release-state (loading | ready |
// unavailable) for tests and the fixture.
//
// New-tab links (spec §1.2's ↗): on the web they open a new tab. Inside the desktop app the main
// process denies every window.open and opens only https URLs externally (desktop/main.cjs), so a
// same-origin new-tab link would silently do nothing: there it navigates in place, without the
// new-tab icon and text. External https links keep their new tab (main opens them in the browser).
//
// html and body never scroll (D26): the page is its own [data-scroller]. Its links are <a> elements;
// the primary ones wear the Button primitive's classes (.ui-button, data-variant, data-size).

import '../styles/primitives/button.css';
import '../styles/views/download/download.css';
import {h} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {InlineStatus} from '../ui/status.js';
import {Skeleton} from '../ui/skeleton.js';
import {platform as appPlatform} from '../app/platform.js';
import {detectPlatform, fetchRelease, formatSize, RELEASE_SOURCES} from '../js/download-release.js';
import {COPY, LINKS, PLACEHOLDER_ROWS, PLATFORM_ORDER, PLATFORMS} from './download.copy.js';

export const RELEASE_STATES = Object.freeze(['loading', 'ready', 'unavailable']);
const SECTION_ID = 'all-downloads';

/** True when `href` resolves to `origin` (relative URLs always do). */
export function isSameOrigin(href, origin) {
  try {
    return new URL(href, origin).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/**
 * How a link opens. A new-tab link gets target=_blank (rel noopener; external links also
 * noreferrer), except a same-origin one inside the desktop app, which navigates in place.
 */
export function linkTarget({href, newTab = false, desktopApp = false, origin}) {
  if (!newTab) return {target: null, rel: null, inPlace: true};
  const same = isSameOrigin(href, origin);
  if (same && desktopApp) return {target: null, rel: null, inPlace: true};
  return {target: '_blank', rel: same ? 'noopener' : 'noopener noreferrer', inPlace: false};
}

const defaultOrigin = () => globalThis.location?.origin ?? 'http://localhost';
const prefersReducedMotion = () => {
  try {
    return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** Renders the download page into `el`. See the header. */
export function mountDownload(el, deps = {}) {
  const env = {
    fetch: deps.fetch,
    sources: deps.sources ?? RELEASE_SOURCES,
    timeoutMs: deps.timeoutMs ?? 10000,
    desktopApp: deps.desktopApp ?? !!appPlatform?.isDesktopApp,
    origin: deps.origin ?? defaultOrigin(),
    reducedMotion: deps.reducedMotion ?? prefersReducedMotion,
  };
  const detected = detectPlatform(deps.navigator ?? globalThis.navigator ?? {});
  const installable = Object.hasOwn(PLATFORMS, detected);

  /** A link, styled as a Button when `variant` is given. */
  function link({href, label, newTab = false, variant = null, size = 'md', iconName = null, className = null, attrs = {}, on = {}}) {
    const how = linkTarget({href, newTab, desktopApp: env.desktopApp, origin: env.origin});
    const content = [];
    if (iconName) content.push(icon(iconName, {size: 20}));
    const text = h('span', {class: variant ? 'ui-button-label' : 'download-link-label'}, label);
    content.push(variant ? h('span', {class: 'ui-button-text'}, text) : text);
    if (!how.inPlace) {
      const ext = icon('external-link', {size: 20});
      ext.classList.add('download-link-ext');
      content.push(ext, h('span', {class: 'sr-only'}, ` ${COPY.newTab}`));
    }
    return h('a', {
      href,
      class: [variant ? 'ui-button' : 'download-link', className],
      dataset: variant ? {variant, size} : {},
      attrs: {target: how.target, rel: how.rel, ...attrs},
      on,
    }, content);
  }

  const releaseStatus = InlineStatus({tone: 'info', text: COPY.loading, className: 'download-status'});

  // The jump to the platform cards: scroll there and move focus to the section heading (no hash).
  const allTitle = h('h2', {class: 'download-section-title', id: `${SECTION_ID}-title`, tabIndex: -1}, COPY.allTitle);
  const jump = e => {
    e.preventDefault();
    section.scrollIntoView?.({behavior: env.reducedMotion() ? 'auto' : 'smooth', block: 'start'});
    allTitle.focus({preventScroll: true});
  };

  const started = () => setStatus({tone: 'info', text: COPY.started});

  // Hero
  const primarySlot = h('div', {class: 'download-primary'});
  const detail = h('p', {class: 'download-detail'}, COPY.detailLoading);
  const hero = h('section', {class: 'download-hero', 'aria-labelledby': 'download-title'},
    h('div', {class: 'download-hero-copy'},
      h('p', {class: 'download-eyebrow'}, COPY.eyebrow),
      h('h1', {class: 'download-title', id: 'download-title'}, COPY.title),
      h('p', {class: 'download-lead selectable'}, COPY.lead),
      primarySlot,
      detail,
      releaseStatus.el),
    h('figure', {class: 'download-art'},
      h('img', {src: '/woodshed-icon.svg', width: 160, height: 160, alt: COPY.iconAlt, class: 'download-art-icon', attrs: {decoding: 'async'}}),
      h('figcaption', {class: 'download-art-caption'}, COPY.tagline)));

  function setPrimary(release) {
    const nodes = [];
    if (!installable) {
      nodes.push(link({href: LINKS.app, label: COPY.openApp, newTab: true, variant: 'primary', size: 'lg', className: 'download-primary-link'}));
      nodes.push(link({href: `#${SECTION_ID}`, label: COPY.primaryFallback, className: 'download-secondary-link', on: {click: jump}}));
    } else if (release) {
      const file = release.downloads[detected][0];
      nodes.push(link({
        href: file.url, label: PLATFORMS[detected].primary, variant: 'primary', size: 'lg', iconName: 'download',
        className: 'download-primary-link', attrs: {download: file.name}, on: {click: started},
      }));
      nodes.push(link({href: `#${SECTION_ID}`, label: COPY.otherPlatforms, className: 'download-secondary-link', on: {click: jump}}));
    } else {
      nodes.push(link({href: `#${SECTION_ID}`, label: COPY.primaryFallback, variant: 'primary', size: 'lg', iconName: 'arrow-down-to-line',
        className: 'download-primary-link', on: {click: jump}}));
    }
    primarySlot.replaceChildren(...nodes);
  }

  function setDetail(release) {
    if (!installable) detail.textContent = detected === 'mobile' ? COPY.detailMobile : COPY.detailWeb;
    else if (release) {
      const file = release.downloads[detected][0];
      detail.textContent = COPY.detailReady(detected, formatSize(file.size), release.version);
    } else detail.textContent = COPY.detailLoading;
  }

  // Platform cards
  const version = h('span', {class: 'download-version'}, COPY.versionUnknown);
  const cards = {};
  for (const key of PLATFORM_ORDER) {
    const titleId = `download-platform-${key}`;
    const files = h('div', {class: 'download-files'});
    const badge = h('span', {class: 'download-badge', hidden: true}, COPY.recommended);
    const card = h('article', {class: 'download-platform', dataset: {platform: key}, 'aria-labelledby': titleId},
      h('div', {class: 'download-platform-head'},
        h('h3', {class: 'download-platform-name', id: titleId}, PLATFORMS[key].name, badge),
        h('p', {class: 'download-platform-req'}, PLATFORMS[key].requirement)),
      files);
    cards[key] = {card, files, badge};
  }
  const platforms = h('div', {class: 'download-platforms'}, PLATFORM_ORDER.map(key => cards[key].card));
  const section = h('section', {class: 'download-all', id: SECTION_ID, 'aria-labelledby': allTitle.id},
    h('div', {class: 'download-section-head'}, allTitle, version),
    platforms);

  function showCards(release, state) {
    if (state === 'loading') platforms.setAttribute('aria-busy', 'true');
    else platforms.removeAttribute('aria-busy');
    for (const key of PLATFORM_ORDER) {
      const {card, files, badge} = cards[key];
      const recommended = state === 'ready' && key === detected;
      card.toggleAttribute('data-recommended', recommended);
      badge.hidden = !recommended;
      if (state === 'loading') {
        files.replaceChildren(Skeleton({shape: 'text', count: PLACEHOLDER_ROWS[key], label: COPY.loadingInstallers}).el);
      } else if (state === 'unavailable') {
        files.replaceChildren(h('p', {class: 'download-file-unavailable'}, COPY.fileUnavailable));
      } else {
        files.replaceChildren(h('ul', {class: 'download-file-list', role: 'list'}, release.downloads[key].map(file => {
          const size = formatSize(file.size);
          const a = h('a', {
            class: 'download-file', href: file.url,
            attrs: {download: file.name, 'aria-label': COPY.fileLabel(key, file.label, size)},
            on: {click: started},
          },
          h('span', {class: 'download-file-label'}, file.label),
          h('span', {class: 'download-file-size tabular'}, size),
          icon('download', {size: 20}));
          return h('li', {class: 'download-file-item'}, a);
        })));
      }
    }
    version.textContent = state === 'ready' ? COPY.version(release.version) : COPY.versionUnknown;
  }

  // Steps and footer
  const steps = h('section', {class: 'download-steps', 'aria-labelledby': 'download-steps-title'},
    h('h2', {class: 'sr-only', id: 'download-steps-title'}, COPY.stepsTitle),
    h('ol', {class: 'download-step-list', role: 'list'}, COPY.steps.map(step => h('li', {class: 'download-step'},
      h('span', {class: 'download-step-number', 'aria-hidden': 'true'}, step.number),
      h('h3', {class: 'download-step-title'}, step.title),
      h('p', {class: 'download-step-body selectable'}, step.body),
      step.hint ? h('p', {class: 'download-step-hint selectable'}, step.hint) : null))));

  const footer = h('footer', {class: 'download-footer'},
    h('span', {class: 'download-footer-note'}, COPY.footerNote),
    h('nav', {class: 'download-footer-links', 'aria-label': COPY.projectNavLabel},
      link({href: LINKS.releaseNotes, label: COPY.releaseNotes, newTab: true}),
      link({href: LINKS.source, label: COPY.source, newTab: true})));

  const nav = h('header', {class: 'download-nav'},
    h('nav', {class: 'download-nav-inner', 'aria-label': COPY.navLabel},
      link({href: LINKS.app, label: COPY.brand, className: 'download-brand'}),
      link({href: LINKS.app, label: env.desktopApp ? COPY.openAppDesktop : COPY.openApp, newTab: true, className: 'download-open-app'})));

  const root = h('div', {class: 'download-page', dataset: {scroller: '', releaseState: 'loading', platform: detected}},
    h('div', {class: 'download-content'},
      nav,
      h('main', {class: 'download-main'}, hero, section, steps),
      footer));
  el.replaceChildren(root);

  // Loading
  let state = 'loading';
  let controller = null;
  let destroyed = false;
  let refocus = false;

  function setStatus({tone, text, action = null}) {
    releaseStatus.el.hidden = !text;
    releaseStatus.set({tone, text: text ?? '', action});
  }

  function setState(next, release = null) {
    state = next;
    root.dataset.releaseState = next;
    setPrimary(next === 'ready' ? release : null);
    setDetail(next === 'ready' ? release : null);
    showCards(release, next);
    if (next === 'loading') setStatus({tone: 'info', text: COPY.loading});
    else if (next === 'unavailable') setStatus({tone: 'error', text: COPY.unavailable, action: {label: COPY.retry, run: retry}});
    else setStatus({tone: 'info', text: ''});
  }

  // Try again hides itself while loading, so focus would drop to <body>: put it back where the
  // result is (the primary download, or Try again once more).
  function restoreFocus() {
    if (!refocus) return;
    refocus = false;
    const doc = el.ownerDocument;
    const active = doc.activeElement;
    const lost = !active || active === doc.body || !root.contains(active) || !!active.closest('[hidden]');
    if (!lost) return;
    const target = state === 'ready' ? primarySlot.querySelector('a') : releaseStatus.el.querySelector('.ui-status-action');
    target?.focus();
  }

  function retry() {
    refocus = true;
    return load();
  }

  async function load() {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    setState('loading');
    try {
      const release = await fetchRelease({
        ...(env.fetch ? {fetch: env.fetch} : {}), sources: env.sources, timeoutMs: env.timeoutMs, signal: mine.signal,
      });
      if (destroyed || mine.signal.aborted) return state;
      setState('ready', release);
    } catch (error) {
      if (destroyed || mine.signal.aborted) return state;
      setState('unavailable');
    }
    restoreFocus();
    return state;
  }

  const ready = load();

  return {
    el: root,
    ready,
    state: () => state,
    reload: load,
    destroy() {
      destroyed = true;
      controller?.abort();
      releaseStatus.destroy();
      root.remove();
    },
  };
}

/** bootRoutes entry (§2.3, §2.3.1 step 2): the page needs no auth, account or data. */
export async function boot(match, deps = {}) {
  const doc = globalThis.document;
  const el = deps.root ?? doc.getElementById('app') ?? doc.body;
  doc.title = COPY.documentTitle;
  const view = mountDownload(el, deps);
  doc.documentElement.dataset.viewReady = 'download';
  return view;
}
