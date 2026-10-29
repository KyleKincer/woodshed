// Song cards and list rows (architecture §2.16, spec §2.4, §3.4).
//
//   SongCard(song, opts) / SongRow(song, opts) → {el, update(song, opts), setActive(on), focusTarget, cover, destroy()}
//   JobCard(job, opts)   / JobRow(job, opts)   → the same with update(job, opts), for a job whose song does not
//                                                exist yet (the Library's "Adding" group)
//   CompactCard(song, {line, href, label, className}) → {el, cover, update(song, more), destroy()}   (recents, pins)
//   Cover({className}) → {el, set(subject, seedSong)}                a square cover over the stable fallback sleeve
//   cardState(song, job) → 'ready' | 'processing' | 'resplitting' | 'working' | 'failed'
//   railOf(job)          → {value: 0..1|null, striped} for the 4 px cover rail
//   coverSource(x)       → {url} | {key} | null (R2 keys are signed in batches, one request per tick)
//   nameCover(coverEl, id)  view-transition-name: cover-<id> on the opened card's cover (one at a time)
//
// opts: {job: JobVM|null, selected, selecting, isNew, now,
//        onOpen(song, {event, cover}) → false leaves the click to the browser (⌘-click opens a tab),
//        onMenu(song, {anchor, event}) → MenuItem[]|null, onArtist(name), onAlbum(name),
//        onReview(song) → {el, update(song), destroy()} (home.js passes LB1b's ReviewChip),
//        onJob(job, {anchor})                               (the Jobs popover focused on that job)}
//
// - A grid card's open control is its cover (a link to /s/:id, named by the title), and its hit
//   area stretches over the whole card; the ⋯ button sits in its own cell beside the title, so it
//   never covers text. A list row's open control is the title. The focusable element carries
//   data-focus-key="song:<id>" ("job:<id>" for job cards), so Back from the Stage refocuses it
//   (router §2.3). Every control in a card is tabindex -1 until home.js makes the card the grid's
//   active one (setActive): the grid is one Tab stop with roving arrows.
// - Processing (a new song): cover at 55%, the rail on the cover's bottom edge, the stage line in
//   row 3, title and artist quieter; the card opens the Jobs popover on its job. Re-splitting (a
//   separate job on a song that already has stems): the same chrome, but title and artist at full
//   contrast, and the card still opens and plays the old stems. Working (beats, sections or an
//   import on an existing song): the rail and the stage line. Failed: the cover keeps its
//   identity; row 3 is the failure's sentence in --danger with [Try again] (the failure's primary
//   action when it has one: Try now, Try Fast quality…) and [Details].
// - Long-press (500 ms, bindContextMenu), right-click, Shift+F10 and the ContextMenu key call
//   onMenu (D49); the ⋯ button is shown only when onMenu is given (LB3 fills the menu).
// - "Is this right?" (row.reviewMetadata): the card mounts onReview(song) in row 3, updates it with
//   the song, and destroys it once the row no longer needs review.

import '../styles/views/library/cards.css';
import {h} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {ProgressRail} from '../ui/progress.js';
import {bindContextMenu, Menu} from '../ui/menu.js';
import {signKeys} from '../api/media.js';
import {toast} from '../app/feedback.js';
import {describeError} from '../app/error-copy.js';
import {setArtwork} from '../js/artwork.js';
import {COPY} from './home.copy.js';
import {artistLabel, formatDuration, metaLine, relativeTime} from './song-labels.js';

// ---------- covers ----------

const URL_RE = /^(https?:|data:|blob:)/i;

/** A cover's source: an R2 key to sign, a URL to use as is, or null (the fallback sleeve). */
export function coverSource(x) {
  if (!x) return null;
  if (typeof x === 'string') return URL_RE.test(x) ? {url: x} : {key: x};
  if (typeof x.url === 'string' && x.url) return {url: x.url};
  if (typeof x.coverKey === 'string' && x.coverKey) return {key: x.coverKey};
  if (typeof x.coverUrl === 'string' && x.coverUrl) return {url: x.coverUrl};
  if (typeof x.key === 'string' && x.key) return {key: x.key};
  return null;
}

let queue = null;   // key → [resolve], signed together on the next microtask

/** The signed URL of an R2 key (null when it cannot be signed); keys asked for in one tick share one request. */
export function signedCover(key) {
  return new Promise(resolve => {
    if (!queue) {
      queue = new Map();
      queueMicrotask(async () => {
        const batch = queue;
        queue = null;
        let signed = {};
        try { signed = (await signKeys([...batch.keys()])) ?? {}; } catch { signed = {}; }
        for (const [k, waiters] of batch) for (const fn of waiters) fn(signed[k] ?? null);
      });
    }
    const waiters = queue.get(key) ?? [];
    waiters.push(resolve);
    queue.set(key, waiters);
  });
}

/** A square cover with the stable fallback sleeve underneath (radius 0, spec §2.4). */
export function Cover({className = ''} = {}) {
  const el = h('div', {class: ['lib-cover', className]});
  let shown = null;
  let token = 0;
  return {
    el,
    set(subject, seedSong) {
      const src = coverSource(subject);
      const id = src ? (src.url ? `u:${src.url}` : `k:${src.key}`) : `s:${seedSong?.id ?? ''}:${seedSong?.title ?? ''}`;
      if (id === shown) return;
      shown = id;
      const mine = ++token;
      const seed = {id: seedSong?.id, title: seedSong?.title, artist: seedSong?.artist, uploader: seedSong?.uploader, album: seedSong?.album};
      let resigned = false;
      const sign = () => signedCover(src.key).then(url => {
        if (token !== mine) return;
        if (url) paint(url);
        else if (shown === id) shown = null;   // not signed (a failed batch): the next render asks again
      });
      const paint = url => {
        const keep = [...el.children].filter(child => child.tagName !== 'IMG');   // the rail stays on the cover
        setArtwork(el, seed, url);
        const img = el.querySelector('img');
        if (img) {
          img.loading = 'lazy'; img.draggable = false; img.alt = '';
          // A signed URL can expire (6 h) before a lazy image below the fold loads: sign it again, once.
          if (src?.key) img.addEventListener('error', () => { if (token === mine && !resigned) { resigned = true; void sign(); } }, {once: true});
        }
        el.append(...keep);
      };
      if (src?.url) { paint(src.url); return; }
      paint(null);
      if (src?.key) void sign();
    },
  };
}

const safeIdent = id => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '_');

/** Names the opened card's cover for the Library → Stage View Transition; clears the previous one. */
export function nameCover(coverEl, id) {
  const doc = coverEl?.ownerDocument ?? globalThis.document;
  for (const el of doc?.querySelectorAll?.('[data-cover-named]') ?? []) {
    el.style.removeProperty('view-transition-name');
    delete el.dataset.coverNamed;
  }
  if (!coverEl) return;
  coverEl.style.setProperty('view-transition-name', `cover-${safeIdent(id)}`);
  coverEl.dataset.coverNamed = '';
}

// ---------- state ----------

const CURRENT = new Set(['current', 'active', 'running', 'failed', 'error']);
const QUEUE_STAGES = new Set(['queue', 'queued', 'wait', 'waiting']);
const FINISH_STAGES = new Set(['finish', 'finalize', 'finishing']);

export function cardState(song, job) {
  if (!job) return 'ready';
  if (job.failure || job.failed) return 'failed';
  if (!song) return 'processing';
  return job.kind === 'separate' ? 'resplitting' : 'working';
}

/** The rail for a job: waiting → empty and striped; finishing → indeterminate (a shimmer); else its percent. */
export function railOf(job) {
  if (!job) return null;
  const stages = Array.isArray(job.stages) ? job.stages : [];
  const current = stages.find(s => CURRENT.has(s?.state)) ?? null;
  const stage = String(current?.id ?? job.stage ?? '').toLowerCase();
  const waiting = QUEUE_STAGES.has(stage) || (!current && stages.length > 0 && stages.every(s => s?.state === 'pending'));
  if (waiting) return {value: 0, striped: true};
  if (FINISH_STAGES.has(stage)) return {value: null, striped: false};
  const pct = Number(job.percent);
  return Number.isFinite(pct) ? {value: Math.max(0, Math.min(1, pct / 100)), striped: false} : {value: null, striped: false};
}

/** A job's title; `quoted` (a search with no metadata title yet) shows the query in quotes (spec §2.8). */
const jobTitle = job => {
  const t = job?.title ? String(job.title) : '';
  return t && job?.quoted === true ? `“${t}”` : t;
};
/**
 * A failed card's inline action: the failure's primary action (Try again, Try now, Try Fast quality…),
 * run through the job's own action of the same target or label when it has one (LB1b guards those:
 * an error toast, and the processor refresh after a retry), else the job's Try again.
 */
const retryOf = job => {
  const primary = job?.failure?.primary;
  const actions = Array.isArray(job?.actions) ? job.actions.filter(a => a?.label && typeof a.run === 'function') : [];
  if (primary?.label) {
    const own = actions.find(a => (primary.target && a.target === primary.target) || a.label === primary.label);
    if (own) return own;
    if (typeof primary.run === 'function') return primary;
  }
  return actions.find(a => a.label === COPY.tryAgain) ?? null;
};
/** Runs an action; a failure that reaches here becomes an error toast, never an unhandled rejection. */
function runAction(action) {
  const fail = err => toast(describeError(err, {context: 'job'}).sentence, {tone: 'error'});
  try {
    const out = action?.run?.();
    if (out && typeof out.then === 'function') out.then(undefined, fail);
  } catch (err) { fail(err); }
}
const isPlainClick = e => e && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

let seq = 0;

// ---------- shared card plumbing ----------

/**
 * The parts cards and rows share. `kind` 'card': the open control is the cover; 'row': the title.
 * Returns the elements for the layout to place, plus render/setActive/destroy.
 */
function createParts(kind, {song, job, opts}) {
  let s = song, j = job, o = opts;
  const ac = new AbortController();
  const on = (el, type, fn) => el.addEventListener(type, fn, {signal: ac.signal});
  const id = `lib-c${++seq}`;

  const subject = () => (s ? `song:${s.id}` : `job:${j?.id}`);
  const title = () => (s ? s.title || 'Untitled' : jobTitle(j) || 'Untitled');

  const cover = Cover({className: kind === 'row' ? 'lib-thumb' : 'lib-card-cover'});
  const newDot = h('span', {class: 'lib-new-dot', attrs: {'aria-hidden': 'true'}});
  const titleText = h('span', {class: 'lib-title-text', id: `${id}-title`});
  const meta = h('p', {class: 'lib-meta', id: `${id}-meta`});
  const metaText = h('span', {class: 'lib-meta-text'});
  const tryBtn = h('button', {class: 'lib-fail-action', type: 'button'}, COPY.tryAgain);
  const detailsBtn = h('button', {class: 'lib-fail-action', type: 'button'}, COPY.details);
  const actions = h('span', {class: 'lib-fail-actions'}, tryBtn, detailsBtn);
  meta.append(metaText, actions);
  const artistBtn = h('button', {class: 'lib-artist', type: 'button'});
  const artistText = h('span', {class: 'lib-artist-text'});
  artistBtn.append(artistText);
  const reviewSlot = h('span', {class: 'lib-review'});
  const extra = [];   // more focusables a layout adds (the row's album button)

  const open = s
    ? h('a', {class: ['lib-open', kind === 'card' ? 'lib-open-cover' : 'lib-open-title'], id: `${id}-open`, attrs: {'aria-describedby': meta.id, draggable: 'false'}})
    : h('button', {class: ['lib-open', kind === 'card' ? 'lib-open-cover' : 'lib-open-title'], id: `${id}-open`, type: 'button', attrs: {'aria-describedby': meta.id}});
  if (kind === 'card') open.append(cover.el);
  else open.append(h('span', {class: 'lib-row-title-line'}, newDot, titleText));

  let review = null, rail = null, moreBtn = null, menu = null, active = false, offMenu = () => {};

  on(open, 'click', e => {
    if (!s) { e.preventDefault(); o.onJob?.(j, {anchor: open}); return; }
    if (typeof o.onOpen === 'function') {
      if (o.onOpen(s, {event: e, cover: cover.el}) !== false) e.preventDefault();
      return;
    }
    if (isPlainClick(e)) nameCover(cover.el, s.id);
  });
  on(artistBtn, 'click', () => { const name = s ? artistLabel(s) : ''; if (name) o.onArtist?.(name); });
  on(tryBtn, 'click', () => runAction(retryOf(j)));
  on(detailsBtn, 'click', () => o.onJob?.(j, {anchor: detailsBtn}));

  const menuItems = (event, anchor) => (s && typeof o.onMenu === 'function' ? o.onMenu(s, {anchor, event}) ?? null : null);

  function ensureMore(parent) {
    const want = !!s && typeof o.onMenu === 'function';
    if (want && !moreBtn) {
      moreBtn = h('button', {class: 'lib-more', type: 'button', attrs: {'aria-haspopup': 'menu', 'aria-expanded': 'false'}}, icon('ellipsis', {size: 20}));
      on(moreBtn, 'click', e => {
        if (menu?.open) { menu.close('close'); return; }
        const items = menuItems(e, moreBtn);
        if (!Array.isArray(items) || !items.length) return;
        moreBtn.setAttribute('aria-expanded', 'true');
        menu = Menu({items, anchor: moreBtn, placement: 'bottom', label: COPY.more(title()),
          onClose: () => { moreBtn?.setAttribute('aria-expanded', 'false'); menu = null; }});
      });
      parent.append(moreBtn);
    } else if (!want && moreBtn) {
      moreBtn.remove();
      moreBtn = null;
    }
    if (moreBtn) moreBtn.setAttribute('aria-label', COPY.more(title()));
  }

  const focusables = () => [open, artistBtn, tryBtn, detailsBtn, moreBtn, ...extra,
    ...(review ? review.el.querySelectorAll('button, a[href], [tabindex]') : [])].filter(Boolean);
  function setActive(on) {
    active = !!on;
    for (const el of focusables()) el.tabIndex = active ? 0 : -1;
  }

  function render(root, moreParent) {
    const state = cardState(s, j);
    root.dataset.state = state;
    root.dataset.key = subject();
    if (j?.kind) root.dataset.jobKind = j.kind; else delete root.dataset.jobKind;
    if (o.selecting) root.dataset.selecting = ''; else delete root.dataset.selecting;
    if (o.selected) root.dataset.selected = ''; else delete root.dataset.selected;
    open.dataset.focusKey = subject();

    const t = title();
    if (titleText.textContent !== t) titleText.textContent = t;
    const fresh = !!s && !!o.isNew;
    newDot.hidden = !fresh;
    root.toggleAttribute('data-new', fresh);
    const failed = state === 'failed';
    const line = failed ? (j.failure?.sentence ?? j.message ?? '') : j ? (j.line ?? '') : metaLine(s);
    const name = s
      ? `${fresh ? `${COPY.newSong}, ` : ''}${t}${o.selecting ? (o.selected ? ', selected' : ', not selected') : ''}`
      : COPY.job(t, line);
    open.setAttribute('aria-label', name);
    if (s) open.setAttribute('href', `/s/${encodeURIComponent(s.id)}`);

    // row 2: the artist drills down
    const artist = s ? artistLabel(s) : '';
    artistText.textContent = artist;
    artistBtn.hidden = !artist;
    if (artist) { artistBtn.setAttribute('aria-label', COPY.openArtist(artist)); artistBtn.title = artist; }
    else { artistBtn.removeAttribute('aria-label'); artistBtn.removeAttribute('title'); }

    // row 3: the meta line, the stage line, or the failure
    if (metaText.textContent !== line) metaText.textContent = line;
    meta.dataset.tone = failed ? 'danger' : 'quiet';
    actions.hidden = !failed;
    const retry = failed ? retryOf(j) : null;
    tryBtn.hidden = !retry;
    if (retry && tryBtn.textContent !== retry.label) tryBtn.textContent = retry.label;
    detailsBtn.setAttribute('aria-label', COPY.jobDetails(t));

    // the cover: the song's art, else the job's (a URL in `cover`, an R2 key in `coverKey`)
    cover.set(s ?? j?.cover ?? (j?.coverKey ? {key: j.coverKey} : null), s ?? {id: j?.id, title: jobTitle(j)});

    // the rail on the cover's bottom edge: the job's own (queued, paused offline, setup, upload), else from its stages
    const r = state === 'failed' || state === 'ready' ? null : (j?.rail && typeof j.rail === 'object' ? j.rail : railOf(j));
    if (r && !rail) { rail = ProgressRail({className: 'lib-rail', ...r}); cover.el.append(rail.el); }
    else if (r) rail.set(r);
    else if (rail) { rail.destroy(); rail = null; }

    // "Is this right?"
    const wantsReview = !!s && s.reviewMetadata === true;
    if (wantsReview && !review && typeof o.onReview === 'function') {
      const chip = o.onReview(s);
      if (chip?.el) { review = chip; reviewSlot.append(chip.el); }
    } else if (wantsReview && review) review.update?.(s);
    else if (!wantsReview && review) { review.destroy?.(); review.el.remove(); review = null; }
    reviewSlot.hidden = !review;

    ensureMore(moreParent);
    setActive(active);
  }

  return {
    open, cover, newDot, titleText, meta, artistBtn, reviewSlot, extra,
    get song() { return s; },
    get job() { return j; },
    get opts() { return o; },
    set(song2, job2, opts2) { s = song2; j = job2; o = opts2; },
    render, setActive,
    bindMenu(root) { offMenu = bindContextMenu(root, event => menuItems(event, open), {label: COPY.more(title())}); },
    destroy() {
      ac.abort();
      offMenu();
      menu?.destroy?.();
      rail?.destroy();
      review?.destroy?.();
    },
  };
}

function api(parts, el, render, {job = false} = {}) {
  return {
    el,
    get focusTarget() { return parts.open; },
    get cover() { return parts.cover.el; },
    update(next, nextOpts = parts.opts) {
      if (job) parts.set(null, next, nextOpts);
      else parts.set(next, nextOpts.job ?? null, nextOpts);
      render();
    },
    setActive: on => parts.setActive(on),
    destroy() { parts.destroy(); el.remove(); },
  };
}

// ---------- grid card ----------

function buildCard(song, job, opts) {
  const parts = createParts('card', {song, job, opts});
  // The body is a grid: the title and the artist on the left, ⋯ in its own cell beside both, then the meta line.
  const body = h('div', {class: 'lib-card-body'}, h('div', {class: 'lib-card-title'}, parts.newDot, parts.titleText), parts.artistBtn,
    parts.meta, parts.reviewSlot);
  const el = h('article', {class: 'lib-card', attrs: {'aria-labelledby': parts.titleText.id}}, parts.open, body);
  parts.bindMenu(el);
  const render = () => parts.render(el, body);
  render();
  parts.setActive(false);
  return {parts, el, render};
}

export function SongCard(song, opts = {}) {
  if (!song?.id) throw new TypeError('SongCard: song.id required');
  const {parts, el, render} = buildCard(song, opts.job ?? null, opts);
  return api(parts, el, render);
}

export function JobCard(job, opts = {}) {
  if (!job?.id) throw new TypeError('JobCard: job.id required');
  const {parts, el, render} = buildCard(null, job, opts);
  return api(parts, el, render, {job: true});
}

// ---------- list row ----------

const cell = (cls, ...children) => h('div', {class: ['lib-cell', cls], attrs: {role: 'cell'}}, ...children);

function buildRow(song, job, opts) {
  const parts = createParts('row', {song, job, opts});
  const albumText = h('span', {class: 'lib-album-text'});
  const albumBtn = h('button', {class: 'lib-album', type: 'button'}, albumText);
  parts.extra.push(albumBtn);
  albumBtn.addEventListener('click', () => { const album = parts.song?.album?.trim(); if (album) parts.opts.onAlbum?.(album); });
  const name = h('div', {class: 'lib-row-name'}, parts.open, parts.artistBtn, parts.meta, parts.reviewSlot);
  const keyCell = cell('lib-col-key'), bpmCell = cell('lib-col-bpm'), durationCell = cell('lib-col-duration');
  const practisedCell = cell('lib-col-practised'), moreCell = cell('lib-col-more');
  const el = h('div', {class: 'lib-row', attrs: {role: 'row', 'aria-labelledby': parts.titleText.id}},
    cell('lib-col-thumb', parts.cover.el), cell('lib-col-title', name), cell('lib-col-album', albumBtn),
    keyCell, bpmCell, durationCell, practisedCell, moreCell);
  parts.bindMenu(el);

  function render() {
    parts.render(el, moreCell);
    const s = parts.song;
    const album = s?.album?.trim() ?? '';
    albumText.textContent = album;
    albumBtn.hidden = !album;
    if (album) { albumBtn.setAttribute('aria-label', COPY.openAlbum(album)); albumBtn.title = album; }
    else { albumBtn.removeAttribute('aria-label'); albumBtn.removeAttribute('title'); }
    keyCell.textContent = s?.musicalKey ?? '';
    bpmCell.textContent = s?.mapSummary?.real && Number.isFinite(s.mapSummary.bpm) ? String(Math.round(s.mapSummary.bpm)) : '';
    durationCell.textContent = s ? formatDuration(s.duration) : '';
    practisedCell.textContent = s ? relativeTime(s.lastPracticedAt, parts.opts.now) : '';
    // The columns carry a ready row's details; row 3 shows only a stage line or a failure.
    parts.meta.hidden = !!s && !parts.job;
  }
  render();
  parts.setActive(false);
  return {parts, el, render};
}

export function SongRow(song, opts = {}) {
  if (!song?.id) throw new TypeError('SongRow: song.id required');
  const {parts, el, render} = buildRow(song, opts.job ?? null, opts);
  return api(parts, el, render);
}

export function JobRow(job, opts = {}) {
  if (!job?.id) throw new TypeError('JobRow: job.id required');
  const {parts, el, render} = buildRow(null, job, opts);
  return api(parts, el, render, {job: true});
}

// ---------- compact card ----------

/** A compact card (Continue recents, Pinned): one link with a small cover, the title and a line. */
export function CompactCard(song, {line = '', href, className = '', label} = {}) {
  const cover = Cover({className: 'lib-compact-cover'});
  const titleEl = h('span', {class: 'lib-compact-title'});
  const lineEl = h('span', {class: 'lib-compact-line'});
  const el = h('a', {class: ['lib-compact', className], attrs: {draggable: 'false'}}, cover.el, h('span', {class: 'lib-compact-text'}, titleEl, lineEl));
  let current = {line, href, label};
  function update(next, more = {}) {
    current = {...current, ...more};
    titleEl.textContent = next.title || 'Untitled';
    lineEl.textContent = current.line ?? '';
    lineEl.hidden = !current.line;
    el.setAttribute('href', current.href ?? `/s/${encodeURIComponent(next.id)}`);
    el.dataset.focusKey = `compact:${next.id}`;
    if (current.label) el.setAttribute('aria-label', current.label); else el.removeAttribute('aria-label');
    cover.set(next, next);
  }
  update(song);
  return {el, cover: cover.el, update, destroy() { el.remove(); }};
}
