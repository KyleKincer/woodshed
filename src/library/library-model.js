// The Library's model (architecture §2.16, spec §2.2–2.4): filters, sorts, groups, search, the
// Continue picks, the New dot and the view state read from the URL and prefs. Pure: no DOM, no
// storage; the clock and the device's opened list are arguments.
//
//   FILTERS, SORTS, GROUPS, LAYOUTS
//   FIRST_RUN_MIN                         Sort, Group, filters and Select show from 6 songs (spec §2.7)
//   defaultSort(songs)                    'practised' once any song has lastPracticedAt, else 'added'
//   parseSort('-title') → {key: 'title', reverse: true}; sortValue(key, reverse) → '-title'
//   matches(song, q)                      every search term is a case- and accent-folded substring of
//                                         title, uploader, artistLabel, album, albumArtist, genre, tags
//                                         or a section name (mapSummary.sections)
//   filterSongs(songs, {q, filter, artist, album, jobs})
//                                         jobs: Map<songId, JobVM> (a failed one has `failure`) for the
//                                         processing and failed filters
//   sortSongs(songs, sort)                stable; songs without the sort's value (no BPM, no key, no
//                                         album…) go last in both directions
//   groupSongs(songs, group)              [{key, label, cover, count, songs}]; Unknown album/artist last
//   isNew(song, {now, opened})            !lastPracticedAt && now − addedAt < 30 days && not opened here
//   continuePicks(songs)                  {hero, recents (≤ 3)} by lastPracticedAt
//   viewState(query, prefsLibrary, songs) the effective {q, sort, group, filter, artist, album, layout}
//   queryOf(state)                        the URL query for a view state (defaults dropped)

import {artistLabel} from './song-labels.js';

export const FILTERS = Object.freeze(['chart', 'mapped', 'spots', 'review', 'processing', 'failed']);   // 'review' = row.reviewMetadata (D43)
export const SORTS = Object.freeze(['practised', 'added', 'title', 'artist', 'album', 'duration', 'bpm', 'key']);
export const GROUPS = Object.freeze(['none', 'album', 'artist']);
export const LAYOUTS = Object.freeze(['grid', 'list']);
/** Filters shown only while something matches them (spec §2.2). */
export const CONDITIONAL_FILTERS = Object.freeze(['processing', 'failed']);
export const FIRST_RUN_MIN = 6;
export const NEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const RECENTS = 3;
export const UNKNOWN_KEY = '\u0000unknown';

const collator = new Intl.Collator(undefined, {sensitivity: 'base', numeric: true});

/** Lower case without accents, for search. */
export function fold(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLocaleLowerCase();
}

export function defaultSort(songs) {
  for (const song of iterate(songs)) if (Number.isFinite(song?.lastPracticedAt)) return 'practised';
  return 'added';
}

function* iterate(songs) {
  if (!songs) return;
  if (songs instanceof Map) yield* songs.values();
  else yield* songs;
}

/** '-title' → {key: 'title', reverse: true}; an unknown sort → null. */
export function parseSort(value) {
  if (typeof value !== 'string' || !value) return null;
  const reverse = value.startsWith('-');
  const key = reverse ? value.slice(1) : value;
  return SORTS.includes(key) ? {key, reverse} : null;
}

export const sortValue = (key, reverse = false) => (reverse ? `-${key}` : key);

function haystack(song) {
  const fields = [song.title, song.uploader, artistLabel(song), song.album, song.albumArtist, song.genre];
  if (Array.isArray(song.tags)) fields.push(...song.tags);
  const sections = song.mapSummary?.sections;
  if (Array.isArray(sections)) fields.push(...sections);
  return fields.filter(f => typeof f === 'string' && f).map(fold);
}

/** Every whitespace-separated term of `q` is a substring of some searchable field. */
export function matches(song, q) {
  const terms = fold(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  if (!song) return false;
  const fields = haystack(song);
  return terms.every(term => fields.some(field => field.includes(term)));
}

const sameText = (a, b) => fold(a).trim() === fold(b).trim();

/** A job view-model (JobVM) or a bare {failed} flag that failed. */
export const isFailed = job => !!(job?.failure || job?.failed);

/** Job view-models that no longer show on a card (LB1b's found, unapplied detections are `done`). */
const SETTLED = new Set(['done', 'cancelled', 'canceled']);
const onCard = job => !!job && !SETTLED.has(job.status);

/** Whether a song passes a filter chip. `jobs` maps song ids to their live or failed job. */
export function passesFilter(song, filter, jobs = null) {
  switch (filter) {
    case 'chart': return song.hasChart === true;
    case 'mapped': return song.mapSummary?.real === true;
    case 'spots': return (song.practiceSummary?.spotCount ?? 0) > 0;
    case 'review': return song.reviewMetadata === true;
    case 'processing': { const job = jobs?.get?.(song.id); return onCard(job) && !isFailed(job); }
    case 'failed': { const job = jobs?.get?.(song.id); return onCard(job) && isFailed(job); }
    default: return true;
  }
}

export function filterSongs(songs, {q = '', filter = null, artist = null, album = null, jobs = null} = {}) {
  const out = [];
  for (const song of iterate(songs)) {
    if (!song) continue;
    if (filter && !passesFilter(song, filter, jobs)) continue;
    if (artist && !sameText(artistLabel(song), artist)) continue;
    if (album && !sameText(song.album, album)) continue;
    if (!matches(song, q)) continue;
    out.push(song);
  }
  return out;
}

// Each sort: the value read from a song (null = missing, always last) and its natural direction.
const NUM = (a, b) => a - b;
const TEXT = (a, b) => collator.compare(a, b);
const text = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = v => (Number.isFinite(v) ? v : null);
const SORT_KEYS = {
  practised: {value: s => num(s.lastPracticedAt), compare: (a, b) => b - a},
  added: {value: s => num(s.addedAt), compare: (a, b) => b - a},
  title: {value: s => text(s.title), compare: TEXT},
  artist: {value: s => text(artistLabel(s)), compare: TEXT},
  album: {value: s => text(s.album), compare: TEXT},
  duration: {value: s => num(s.duration), compare: NUM},
  bpm: {value: s => num(s.mapSummary?.real ? s.mapSummary.bpm : null), compare: NUM},
  key: {value: s => text(s.musicalKey), compare: TEXT},
};

/** disc × 1000 + track; a track without a disc number is on disc 1, so mixed rows share one scale. */
const trackNo = s => {
  const track = parseInt(String(s.trackNumber ?? ''), 10);
  if (!Number.isFinite(track)) return NaN;
  const disc = parseInt(String(s.discNumber ?? ''), 10);
  return (Number.isFinite(disc) ? disc : 1) * 1000 + track;
};

/** Ties: album order uses disc/track, then title; everything else the newest addition first. */
function tieBreak(a, b, key) {
  if (key === 'album') {
    const ta = trackNo(a), tb = trackNo(b);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    if (Number.isFinite(ta) !== Number.isFinite(tb)) return Number.isFinite(ta) ? -1 : 1;
  }
  if (key === 'artist' || key === 'album') {
    const t = collator.compare(a.title ?? '', b.title ?? '');
    if (t) return t;
  }
  return (num(b.addedAt) ?? 0) - (num(a.addedAt) ?? 0);
}

/** A new array in `sort` order ('-title' reverses); missing values last either way; stable. */
export function sortSongs(songs, sort) {
  const parsed = parseSort(sort) ?? {key: 'added', reverse: false};
  const {value, compare} = SORT_KEYS[parsed.key];
  const rows = [...iterate(songs)].filter(Boolean).map((song, index) => ({song, index, v: value(song)}));
  rows.sort((x, y) => {
    if (x.v == null || y.v == null) {
      if (x.v == null && y.v == null) return tieBreak(x.song, y.song, parsed.key) || x.index - y.index;
      return x.v == null ? 1 : -1;
    }
    const c = compare(x.v, y.v) * (parsed.reverse ? -1 : 1);
    return c || tieBreak(x.song, y.song, parsed.key) || x.index - y.index;
  });
  return rows.map(r => r.song);
}

const hasCover = s => !!(s?.coverUrl || s?.coverKey);

/** Groups in label order with Unknown last; songs keep their order inside each group. */
export function groupSongs(songs, group) {
  const list = [...iterate(songs)].filter(Boolean);
  if (group !== 'album' && group !== 'artist') return [{key: 'all', label: null, cover: null, count: list.length, songs: list}];
  const labelOf = group === 'album' ? s => text(s.album) : s => text(artistLabel(s));
  const groups = new Map();
  for (const song of list) {
    const label = labelOf(song);
    const key = label ? fold(label) : UNKNOWN_KEY;
    let g = groups.get(key);
    if (!g) { g = {key, label: label ?? (group === 'album' ? 'Unknown album' : 'Unknown artist'), unknown: !label, cover: null, count: 0, songs: []}; groups.set(key, g); }
    g.songs.push(song);
    g.count++;
    if (!g.cover && hasCover(song)) g.cover = song;
  }
  return [...groups.values()].sort((a, b) => (a.unknown !== b.unknown ? (a.unknown ? 1 : -1) : collator.compare(a.label, b.label)))
    .map(({unknown: _u, ...g}) => g);
}

export function isNew(song, {now, opened = []} = {}) {
  if (!song || Number.isFinite(song.lastPracticedAt)) return false;
  if (!Number.isFinite(song.addedAt) || !Number.isFinite(now) || now - song.addedAt >= NEW_WINDOW_MS) return false;
  return !(Array.isArray(opened) ? opened : []).includes(song.id);
}

/** The Continue hero and up to three recents, most recently practised first. */
export function continuePicks(songs) {
  const practised = sortSongs([...iterate(songs)].filter(s => Number.isFinite(s?.lastPracticedAt)), 'practised');
  return {hero: practised[0] ?? null, recents: practised.slice(1, 1 + RECENTS)};
}

const oneOf = (value, list) => (typeof value === 'string' && list.includes(value) ? value : null);
const textParam = value => (typeof value === 'string' && value.trim() ? value : null);

/**
 * The effective view state. The URL wins; prefs.library fills sort, group, filter and layout
 * (?layout=list; grid is the default and never in the URL); a missing sort takes the default rule. `artist`/`album` drill-downs and `q` live in the URL only.
 */
export function viewState(query = {}, prefsLibrary = {}, songs = []) {
  const sort = parseSort(query.sort) ? query.sort : parseSort(prefsLibrary?.sort) ? prefsLibrary.sort : defaultSort(songs);
  return {
    q: typeof query.q === 'string' ? query.q : '',
    sort,
    sortExplicit: !!(parseSort(query.sort) || parseSort(prefsLibrary?.sort)),
    group: oneOf(query.group, GROUPS) ?? oneOf(prefsLibrary?.group, GROUPS) ?? 'none',
    filter: query.filter !== undefined ? oneOf(query.filter, FILTERS) : oneOf(prefsLibrary?.filter, FILTERS),
    artist: textParam(query.artist),
    album: textParam(query.album),
    layout: oneOf(query.layout, LAYOUTS) ?? oneOf(prefsLibrary?.layout, LAYOUTS) ?? 'grid',
  };
}

/** The URL query for a view state: every key, null where it is the default (router.setQuery removes those). */
export function queryOf(state) {
  return {
    q: state.q ? state.q : null,
    sort: state.sortExplicit ? state.sort : null,
    group: state.group && state.group !== 'none' ? state.group : null,
    filter: state.filter ?? null,
    artist: state.artist ?? null,
    album: state.album ?? null,
    layout: state.layout === 'list' ? 'list' : null,
  };
}

/** Jobs that put a song in a new card: a split, an upload or an import whose song does not exist yet. */
export const NEW_SONG_KINDS = Object.freeze(['separate', 'upload', 'import']);

/**
 * The "Adding" group's jobs: live or failed new-song jobs whose song is not in `songs` yet, the new card at the front
 * (spec §3.2): uploads in progress first, then the jobs newest first by `createdAt` (read from the job view-model, or
 * from the raw `jobs` rows, store.library.jobs, by jobId), then anything without a time (a failed upload) in its order.
 */
export function addingJobsOf(items = [], songs = null, {jobs = null} = {}) {
  const ids = songs instanceof Map ? songs : new Set([...iterate(songs)].map(s => s?.id));
  const adding = (items ?? []).filter(j => onCard(j) && NEW_SONG_KINDS.includes(j.kind) && !(j.songId && ids.has(j.songId)));
  const created = new Map();
  for (const row of iterate(jobs)) if (row?.jobId != null && Number.isFinite(row.createdAt)) created.set(row.jobId, row.createdAt);
  const rank = j => (j.kind === 'upload' && j.status === 'running' ? 0 : createdAtOf(j, created) != null ? 1 : 2);
  return adding.map((job, i) => ({job, i})).sort((a, b) => {
    const ra = rank(a.job), rb = rank(b.job);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return (createdAtOf(b.job, created) - createdAtOf(a.job, created)) || a.i - b.i;
    return a.i - b.i;
  }).map(x => x.job);
}

function createdAtOf(job, created) {
  if (Number.isFinite(job.createdAt)) return job.createdAt;
  const at = job.jobId != null ? created.get(job.jobId) : undefined;
  return Number.isFinite(at) ? at : null;
}

/**
 * Counts behind the conditional chips: exactly what the Processing and Failed filters show, i.e.
 * songs whose job (bySong) is live or failed, plus the "Adding" group's new-song jobs.
 */
export function jobCounts({songs = null, bySong = null, items = []} = {}) {
  let processing = 0, failed = 0;
  const count = job => { if (isFailed(job)) failed++; else processing++; };
  for (const song of iterate(songs)) {
    const job = song ? bySong?.get?.(song.id) : null;
    if (onCard(job)) count(job);
  }
  for (const job of addingJobsOf(items, songs)) count(job);
  return {processing, failed};
}
