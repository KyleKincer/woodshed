// Edit · Details · Match (spec §5.3, architecture §6.9; ported from src/js/song-metadata.js:191-323):
// the status line, [Yes, this is right] → metadata.confirm, [Find another match] with inline results,
// Albums / covers, the field-diff review with checkboxes → metadata.update with `match` (G4: one
// save that records the match), [Try again] → metadataLookup.retry, and the MusicBrainz attribution.
//
//   createLookup({songId, metadata, mode: 'match'|'cover', query(), review(), onApply(changes, match), onCover(candidate), onClose()})
//     → {el, open({run}), openReview(candidate), close(), isOpen(), destroy()}
//     The inline search: Title and Artist pre-filled from the page and run on open, results with a
//     cover thumbnail, Review (match) or Use this cover (cover), Albums / covers (the releases of
//     a recording). A generation counter drops stale answers; lookup errors are a warn line in the
//     panel, and every field stays editable.
//   createMatchSection({songId, metadata, getSong(), review(), onApplied(keys), announce(text)})
//     → {el, heading, update(song), openSearch(), destroy()}
//   diffRows(candidate, {values, locks, changed}) → [{key, label, from, to, checked}]
//   releaseCover(releaseId, size) → the Cover Art Archive URL

import {Button} from '../../ui/button.js';
import {TextField} from '../../ui/field.js';
import {h} from '../../ui/h.js';
import {icon} from '../../ui/icon.js';
import {InlineStatus} from '../../ui/status.js';
import {setArtwork} from '../../js/artwork.js';
import {IDENTITY_KEYS, LABELS, LIMITS, MBID, sameValue, statusLine} from '../../../shared/metadata.ts';
import {COPY} from './details.copy.js';
import {check, errorText} from './fields.js';

const MB_URL = 'https://musicbrainz.org';
const CAA_URL = 'https://coverartarchive.org';

/** The Cover Art Archive image of a release (250 for result thumbnails, 500 for a chosen cover). */
export const releaseCover = (releaseId, size = 250) => `${CAA_URL}/release/${encodeURIComponent(releaseId)}/front-${size}`;

const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const duration = (sec) => (sec > 0 ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : '');

/** The review's rows: identity fields the candidate has, that differ from the page and pass validation. */
export function diffRows(candidate, {values = {}, locks = new Set(), changed = new Set()} = {}) {
  const rows = [];
  for (const key of IDENTITY_KEYS) {
    const to = str(candidate?.[key]);
    if (!to) continue;
    const ok = check(key, to);
    if ('error' in ok) continue;
    const from = str(values[key]);
    if (sameValue(key, from, ok.value)) continue;
    rows.push({key, label: LABELS[key], from, to: ok.value, checked: !locks.has(key) && !changed.has(key)});
  }
  return rows;
}

/** The match a candidate records (MBIDs only). */
function matchOf(candidate) {
  const recordingId = str(candidate?.recordingId);
  if (!MBID.test(recordingId)) return null;
  const releaseId = str(candidate?.releaseId);
  return MBID.test(releaseId) ? {recordingId, releaseId} : {recordingId};
}

/** A small cover thumbnail over the fallback sleeve; a failed image just leaves the sleeve. */
function thumb(c, seed) {
  const el = h('div', {class: 'details-thumb', attrs: {'aria-hidden': 'true'}});
  setArtwork(el, {id: seed, title: c.title, artist: c.artist, album: c.album}, MBID.test(str(c.releaseId)) ? releaseCover(c.releaseId) : null);
  const img = el.querySelector('img');
  if (img) { img.loading = 'lazy'; img.draggable = false; }
  return el;
}

function attribution() {
  const link = (href, text) => h('a', {href, target: '_blank', rel: 'noopener noreferrer', class: 'details-attribution-link'}, text);
  return h('p', {class: 'details-attribution'},
    `${COPY.attributionLead} `, link(MB_URL, COPY.musicBrainz), ` ${COPY.attributionMid} `, link(CAA_URL, COPY.coverArtArchive), '.');
}

// ---------------------------------------------------------------------------------------------------------------
// The inline lookup

export function createLookup({songId, metadata, mode = 'match', query = () => ({}), review = () => ({}), onApply, onCover, onClose, label}) {
  const disposables = [];
  const own = (x) => { disposables.push(x); return x; };
  let gen = 0;           // bumps on every run, close and destroy: an older answer is dropped
  let open = false;
  let lastResults = null;   // {candidates, recordingId, title} for Back from the review
  let destroyed = false;

  const titleField = own(TextField({label: COPY.searchTitle, size: 'sm', maxLength: LIMITS.search, autocomplete: 'off'}));
  const artistField = own(TextField({label: COPY.searchArtist, size: 'sm', maxLength: LIMITS.search, autocomplete: 'off'}));
  const searchButton = own(Button({label: COPY.search, icon: 'search', variant: 'primary', size: 'sm', className: 'details-search-go',
    onClick: () => { void run(); }}));
  const closeButton = own(Button({label: COPY.close, variant: 'quiet', size: 'sm', className: 'details-search-close', onClick: () => close()}));
  const onEnter = (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    void run();
  };
  titleField.input.addEventListener('keydown', onEnter);
  artistField.input.addEventListener('keydown', onEnter);

  const status = own(InlineStatus({tone: 'info', text: '', className: 'details-lookup-status'}));
  status.el.hidden = true;
  const crumbs = h('div', {class: 'details-crumbs'});
  crumbs.hidden = true;
  const results = h('ul', {class: 'details-results', attrs: {'aria-label': COPY.resultsLabel}});
  const reviewEl = h('div', {class: 'details-review'});
  reviewEl.hidden = true;
  const form = h('div', {class: 'details-search', attrs: {role: 'search'}}, titleField.el, artistField.el,
    h('div', {class: 'details-search-actions'}, searchButton.el, closeButton.el));
  const el = h('section', {class: 'details-lookup', dataset: {mode}, attrs: {'aria-label': label ?? (mode === 'cover' ? COPY.coverSearchTitle : COPY.findMatch)}},
    form, status.el, crumbs, results, reviewEl, mode === 'cover' ? attribution() : null);
  el.hidden = true;

  const rowParts = [];   // Buttons of the current rows and review
  const clearRows = () => { for (const p of rowParts.splice(0)) p.destroy(); };
  const say = (text, tone = 'info') => {
    status.el.hidden = !text;
    if (text) status.set({text, tone});
  };

  function showResults(candidates, {recordingId = null, title = ''} = {}) {
    clearRows();
    form.hidden = false;
    reviewEl.hidden = true;
    reviewEl.replaceChildren();
    results.hidden = false;
    lastResults = {candidates, recordingId, title};
    crumbs.hidden = !recordingId;
    if (recordingId) {
      const back = Button({label: COPY.allRecordings, icon: 'chevron-left', variant: 'quiet', size: 'sm', onClick: () => { void run(); }});
      rowParts.push(back);
      crumbs.replaceChildren(back.el, h('span', {class: 'details-crumbs-title'}, COPY.releasesOf(title)));
    } else {
      crumbs.replaceChildren();
    }
    say(candidates.length ? '' : COPY.noResults);
    results.replaceChildren(...candidates.map((c, i) => resultRow(c, i, recordingId)));
  }

  function resultRow(c, i, listingReleases) {
    const primaryText = listingReleases ? str(c.album) || str(c.title) : str(c.title);
    const line = [str(c.artist), listingReleases ? '' : str(c.album), str(c.year), duration(c.duration), str(c.disambiguation)]
      .filter(Boolean).join(' · ');
    const actions = [];
    const hasRelease = MBID.test(str(c.releaseId));
    if (mode === 'cover') {
      if (hasRelease) actions.push(Button({label: COPY.useCover, variant: 'secondary', size: 'sm', onClick: () => onCover?.(c)}));
    } else {
      actions.push(Button({label: COPY.review, variant: 'secondary', size: 'sm', onClick: () => { void loadReview(c, actions[0]); }}));
    }
    if (!listingReleases && MBID.test(str(c.recordingId)))
      actions.push(Button({label: COPY.releases, variant: 'quiet', size: 'sm', onClick: () => { void run(c.recordingId, primaryText); }}));
    rowParts.push(...actions);
    return h('li', {class: 'details-result', dataset: {index: i}},
      thumb(c, `${songId}:${c.recordingId ?? ''}:${c.releaseId ?? i}`),
      h('div', {class: 'details-result-text'},
        h('strong', {class: 'details-result-title'}, primaryText || COPY.empty),
        line ? h('span', {class: 'details-result-line'}, line) : null),
      h('div', {class: 'details-result-actions'}, ...actions.map((b) => b.el)));
  }

  async function run(recordingId = null, title = '') {
    if (destroyed) return;
    const mine = ++gen;
    const q = {title: titleField.value.trim(), artist: artistField.value.trim()};
    searchButton.set({busy: COPY.searching, disabled: true});
    results.setAttribute('aria-busy', 'true');
    say(COPY.searching);
    try {
      const args = {id: songId, title: q.title, artist: q.artist};
      if (recordingId) args.recordingId = recordingId;
      const found = await metadata.find(args);
      if (mine !== gen) return;
      showResults(Array.isArray(found) ? found : [], {recordingId, title});
    } catch (err) {
      if (mine !== gen) return;
      say(errorText(err), 'warn');
    } finally {
      if (mine === gen) {
        searchButton.set({busy: false, disabled: false});
        results.removeAttribute('aria-busy');
      }
    }
  }

  async function loadReview(candidate, button) {
    const mine = ++gen;
    button?.set({busy: COPY.loadingDetail, disabled: true});
    try {
      const args = {id: songId, recordingId: candidate.recordingId};
      if (MBID.test(str(candidate.releaseId))) args.releaseId = candidate.releaseId;
      const full = await metadata.detail(args);
      if (mine !== gen) return;
      showReview({...candidate, ...(full ?? {})});
    } catch (err) {
      if (mine !== gen) return;
      say(errorText(err), 'warn');
    } finally {
      if (mine === gen) button?.set({busy: false, disabled: false});
    }
  }

  /** The field-diff review (match mode). */
  function showReview(candidate) {
    clearRows();
    form.hidden = true;
    results.hidden = true;
    crumbs.hidden = true;
    say('');
    const ctx = review() ?? {};
    const rows = diffRows(candidate, ctx);
    const match = matchOf(candidate);
    const boxes = new Map();
    const list = h('ul', {class: 'details-diff'}, ...rows.map((r) => {
      const box = h('input', {type: 'checkbox', class: 'details-diff-check', checked: r.checked, dataset: {key: r.key}});
      boxes.set(r.key, box);
      return h('li', {class: 'details-diff-row'},
        h('label', {class: 'details-diff-label'}, box,
          h('span', {class: 'details-diff-text'},
            h('strong', {class: 'details-diff-name'}, r.label),
            h('span', {class: 'details-diff-change'},
              h('span', {class: 'details-diff-from'}, r.from || COPY.empty),
              h('span', {class: 'details-diff-arrow', attrs: {'aria-hidden': 'true'}}, '→'),
              h('span', {class: 'sr-only'}, ' to '),
              h('span', {class: 'details-diff-to'}, r.to)))));
    }));
    const apply = Button({label: rows.length ? COPY.useSelected : COPY.useMatch, variant: 'primary', size: 'sm', className: 'details-diff-apply',
      disabled: !match && !rows.length,
      onClick: async () => {
        const changes = {};
        for (const r of rows) if (boxes.get(r.key)?.checked) changes[r.key] = r.to;
        if (!match && !Object.keys(changes).length) return;
        apply.set({busy: COPY.saving, disabled: true});
        const mine = ++gen;
        try {
          await onApply?.(changes, match);
          if (mine !== gen || destroyed) return;
          close();
        } catch (err) {
          if (mine !== gen || destroyed) return;
          say(errorText(err), 'error');
          apply.set({busy: false, disabled: false});
        }
      }});
    const back = Button({label: COPY.back, variant: 'quiet', size: 'sm', onClick: () => {
      if (lastResults) showResults(lastResults.candidates, lastResults);
      else close();
    }});
    rowParts.push(apply, back);
    const who = [str(candidate.title), str(candidate.artist)].filter(Boolean).join(' — ');
    const heading = h('h3', {class: 'details-review-title', attrs: {tabindex: '-1'}}, COPY.reviewTitle);
    reviewEl.replaceChildren(
      h('div', {class: 'details-review-head'}, thumb(candidate, `${songId}:review`),
        h('div', {class: 'details-result-text'}, heading,
          who ? h('span', {class: 'details-result-line'}, [who, str(candidate.album), str(candidate.year)].filter(Boolean).join(' · ')) : null)),
      h('p', {class: 'details-review-intro'}, rows.length ? COPY.reviewIntro : COPY.reviewSame),
      rows.length ? list : null,
      h('div', {class: 'details-review-actions'}, apply.el, back.el));
    reviewEl.hidden = false;
    heading.focus({preventScroll: true});
  }

  function prefill() {
    const q = query() ?? {};
    titleField.set({value: str(q.title)});
    artistField.set({value: str(q.artist)});
    titleField.input.value = str(q.title);
    artistField.input.value = str(q.artist);
  }

  function close({focusBack = true} = {}) {
    if (!open) return;
    open = false;
    gen++;
    el.hidden = true;
    form.hidden = false;
    clearRows();
    results.replaceChildren();
    reviewEl.replaceChildren();
    lastResults = null;
    say('');
    onClose?.({focusBack});
  }

  return {
    el,
    isOpen: () => open,
    /** Opens the panel with the page's title and artist and runs the search. */
    open({run: autorun = true} = {}) {
      if (destroyed) return;
      if (!open) { open = true; el.hidden = false; }
      form.hidden = false;
      prefill();
      titleField.input.focus({preventScroll: true});
      if (autorun) void run();
    },
    /** Opens straight into the review of a known candidate (the stored suggestion). */
    openReview(candidate) {
      if (destroyed) return;
      if (!open) { open = true; el.hidden = false; }
      prefill();
      lastResults = null;
      gen++;
      showReview(candidate);
    },
    close,
    destroy() {
      destroyed = true;
      gen++;
      titleField.input.removeEventListener('keydown', onEnter);
      artistField.input.removeEventListener('keydown', onEnter);
      clearRows();
      for (const d of disposables.splice(0).reverse()) { try { d.destroy(); } catch { /* gone */ } }
      el.remove();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The Match section

const fold = (v) => str(v).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');

/** The stored suggestion, when it names another title, artist or album than the song's. */
function otherSuggestion(song) {
  const s = song?.metadataSuggestion;
  if (!s || typeof s !== 'object' || !str(s.title)) return null;
  const differs = ['title', 'artist', 'album'].some((k) => str(s[k]) && fold(s[k]) !== fold(song[k]));
  return differs ? s : null;
}

const TONE = {pending: 'info', matched: 'ok', suggestion: 'warn', noMatch: 'info', unavailable: 'warn'};

export function createMatchSection({songId, metadata, getSong, review, onApplied, announce = () => {}}) {
  const headingId = `details-match-${String(songId).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const heading = h('h2', {class: 'details-heading', id: headingId, attrs: {tabindex: '-1'}}, COPY.groups.match);
  const statusIcon = h('span', {class: 'details-match-icon', attrs: {'aria-hidden': 'true'}});
  const statusText = h('strong', {class: 'details-match-text'});
  const statusLineEl = h('div', {class: 'details-match-status', attrs: {role: 'status'}}, statusIcon, statusText);
  const body = h('p', {class: 'details-match-body'});
  const suggestionEl = h('div', {class: 'details-suggestion'});
  const note = InlineStatus({tone: 'info', text: '', className: 'details-match-note'});
  note.el.hidden = true;

  const yes = Button({label: COPY.yes, icon: 'check', variant: 'primary', size: 'sm', className: 'details-yes', onClick: () => { void confirmMatch(); }});
  const find = Button({label: COPY.findAnother, icon: 'search', variant: 'secondary', size: 'sm', className: 'details-find',
    onClick: () => openSearch()});
  const retry = Button({label: COPY.tryAgain, icon: 'refresh-cw', variant: 'secondary', size: 'sm', className: 'details-retry',
    onClick: () => { void runRetry(); }});
  const useSuggestion = Button({label: COPY.reviewSuggestion, variant: 'secondary', size: 'sm', className: 'details-use-suggestion',
    onClick: () => { const s = otherSuggestion(getSong()); if (s) lookup.openReview(s); }});
  const actions = h('div', {class: 'details-match-actions'}, yes.el, retry.el, find.el);

  const lookup = createLookup({
    songId, metadata, mode: 'match', label: COPY.findMatch,
    query: () => { const s = getSong() ?? {}; const v = review()?.values ?? {}; return {title: v.title ?? s.title, artist: v.artist ?? s.artist}; },
    review,
    onApply: async (changes, match) => {
      const args = {ids: [songId], changes};
      if (match) args.match = match;
      await metadata.update(args);
      onApplied?.(Object.keys(changes));
      say(COPY.applied, 'ok');
      announce(COPY.applied);
    },
    onClose: ({focusBack}) => { paint(); if (focusBack) find.el.focus({preventScroll: true}); },
  });

  const el = h('section', {class: 'details-section details-match', id: 'match', attrs: {'aria-labelledby': headingId}},
    heading, statusLineEl, body, suggestionEl, actions, note.el, lookup.el, attribution());

  let busy = false;
  let line = null;
  function say(text, tone = 'info') {
    note.el.hidden = !text;
    if (text) note.set({text, tone});
  }

  function paint() {
    const song = getSong();
    line = statusLine(song);
    const state = line?.state ?? 'none';
    el.dataset.state = state;
    statusText.textContent = line?.text ?? COPY.notLookedUp;
    statusIcon.dataset.tone = TONE[state] ?? 'info';
    statusIcon.replaceChildren(icon(state === 'matched' ? 'check' : state === 'pending' ? 'loader' : state === 'none' ? 'search'
      : state === 'unavailable' ? 'wifi-off' : 'info', {size: 20}));
    body.textContent = state === 'none' ? COPY.notLookedUpBody : '';
    body.hidden = state !== 'none';
    const s = state === 'suggestion' ? otherSuggestion(song) : null;
    suggestionEl.hidden = !s;
    if (s) {
      const what = [str(s.title), str(s.artist)].filter(Boolean).join(' — ');
      const more = [str(s.album), str(s.year)].filter(Boolean).join(' · ');
      suggestionEl.replaceChildren(
        thumb(s, `${songId}:suggestion`),
        h('div', {class: 'details-result-text'},
          h('span', {class: 'details-suggestion-lead'}, COPY.suggestion),
          h('strong', {class: 'details-result-title'}, what),
          more ? h('span', {class: 'details-result-line'}, more) : null),
        useSuggestion.el);
    } else {
      suggestionEl.replaceChildren();
    }
    // [Yes, this is right] while the lookup was not sure (with or without a suggestion), or an untitled upload.
    yes.el.hidden = !(state === 'suggestion' || state === 'noMatch' || (state === 'none' && song?.needsReview === true));
    retry.el.hidden = state !== 'unavailable';
    find.set({label: state === 'matched' || state === 'suggestion' || state === 'noMatch' ? COPY.findAnother : COPY.findMatch});
    find.el.hidden = lookup.isOpen();
    actions.hidden = [yes, retry, find].every((b) => b.el.hidden);
  }

  async function confirmMatch() {
    if (busy) return;
    busy = true;
    yes.set({busy: COPY.saving, disabled: true});
    say('');
    try {
      await metadata.confirm({id: songId});
      say(COPY.confirmed, 'ok');
      announce(COPY.confirmed);
    } catch (err) {
      say(errorText(err), 'error');
    } finally {
      busy = false;
      yes.set({busy: false, disabled: false});
    }
  }

  async function runRetry() {
    if (busy) return;
    busy = true;
    retry.set({busy: true, disabled: true});
    say('');
    try {
      await metadata.retry({id: songId});
    } catch (err) {
      say(errorText(err), 'warn');
    } finally {
      busy = false;
      retry.set({busy: false, disabled: false});
    }
  }

  function openSearch() {
    say('');
    lookup.open();
    paint();
  }

  paint();
  return {
    el, heading, lookup,
    update() { paint(); },
    openSearch,
    destroy() {
      lookup.destroy();
      for (const b of [yes, find, retry, useSuggestion, note]) b.destroy();
      el.remove();
    },
  };
}
