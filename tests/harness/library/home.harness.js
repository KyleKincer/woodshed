// LB1a's harness (/__harness/home): the Library home's cards and the mounted view on synthetic data.
//   ?part=cards     every card state side by side, no peers needed: ready, New, processing at each stage
//                   (waiting, fetching, splitting, finishing, an upload), re-splitting, working (beats),
//                   failed, and the same as list rows; each card's onMenu records into window.__cards.menu
//                   (long-press, right-click, ⋯), opening a song into window.__cards.opened and a job into
//                   window.__cards.jobs. layout=list renders rows.
//   ?part=home      the real view (src/library/home.js) on the app store with synthetic songs, over a
//                   recording router and a top-bar stub (window.__home = {router, topbar, store, finish()}):
//                     songs=N        N synthetic songs (default 9)
//                     job=1          one new-song job in the "Adding" group; __home.finish() completes it
//                                    (the job leaves and its song arrives: the 260 ms FLIP)
// The home part imports LB1b's jobs.js and review-chip.js through home.js (same-wave peers): its states
// declare them in opts.requires.
import {COVERS} from '/tests/fixture/db/seed.js';

const DAY = 864e5;
const ART = Object.values(COVERS);
const ARTISTS = ['Northbound', 'Marisol Vega', 'The Ferry Hours', 'Ada Moreno', 'Kito & the Late Shift'];
const TITLES = ['Glasshouse', 'Low Tide Static', 'Paper Lanterns', 'Second Wind', 'Cobblestone', 'Night Bus', 'Velvet Arc', 'Harbor Lights',
  'Quiet Hours', 'Counting Stars Backwards', 'Tin Roof Rain', 'Undertow'];

function sampleSong(i, now) {
  const title = TITLES[i % TITLES.length] + (i >= TITLES.length ? ` ${Math.floor(i / TITLES.length) + 1}` : '');
  return {
    id: `h${i}`, title, artist: ARTISTS[i % ARTISTS.length], album: i % 3 ? `Album ${(i % 4) + 1}` : '', albumArtist: '', uploader: '',
    duration: 90 + (i * 37) % 260, addedAt: now - (i + 1) * 3 * DAY, stemMode: 'full',
    stems: Array.from({length: i % 5 === 0 ? 6 : 4}, (_, k) => ({name: ['drums', 'bass', 'vocals', 'other', 'guitar', 'piano'][k], key: `h${i}/${k}`})),
    coverKey: null, coverUrl: i % 4 === 3 ? null : ART[i % ART.length], artwork: null, source: null, year: '', genre: '', trackNumber: '',
    discNumber: '', musicalKey: ['A minor', 'E major', '', 'D'][i % 4], tuning: '', tags: [], metadataStatus: null, reviewMetadata: i === 4,
    recordingUnconfirmed: false, suggestion: null, hasChart: i % 3 === 0, mapSummary: {real: i % 2 === 0, bpm: 84 + i * 3, sections: ['Verse', 'Chorus']},
    lastPracticedAt: i < 3 ? now - (i + 1) * DAY : null, hasSectionSuggestion: false,
    practiceSummary: i < 3 ? {loopLabel: i === 0 ? 'Bridge loop' : undefined, rate: [0.85, 1, 0.9][i], minusMe: i === 0, spotCount: i === 0 ? 2 : 0,
      spots: i === 0 ? [{id: 's1', name: 'Bridge walk-up', rate: 0.85}, {id: 's2', name: 'Outro', rate: 0.7}] : []} : null,
  };
}

const stages = current => ['fetch', 'split', 'finish'].map((id, i, all) => ({id, label: id[0].toUpperCase() + id.slice(1),
  state: current == null ? 'pending' : i < all.indexOf(current) ? 'done' : id === current ? 'current' : 'pending'}));

function jobVM(id, extra) {
  return {id, kind: 'separate', songId: null, title: null, quoted: null, cover: null, stages: stages(null), percent: 0, line: '', ahead: 0,
    device: null, settingsLine: '', message: null, source: null, eta: null, failure: null, local: false, actions: [], ...extra};
}

async function cardsPart(el, h, query) {
  const [cards] = await Promise.all([import('/src/library/cards.js'), import('/src/styles/views/library/home.css')]);
  const now = Date.now();
  const menu = [], opened = [], jobs = [];
  const onMenu = (song, {event}) => { menu.push({id: song.id, type: event?.type ?? 'click'}); return [{id: 'harness.practice', label: 'Practice', run() {}}]; };
  const base = {now, onMenu, onArtist() {}, onOpen: song => { opened.push(song.id); return true; }};
  const jobBase = {now, onJob: job => { jobs.push(job.id); }};
  const list = query.get('layout') === 'list';
  const Song = list ? cards.SongRow : cards.SongCard;
  const Job = list ? cards.JobRow : cards.JobCard;
  const songs = Array.from({length: 4}, (_, i) => sampleSong(i, now));
  const items = [
    Song(songs[0], base),
    Song({...songs[1], lastPracticedAt: null, addedAt: now - DAY}, {...base, isNew: true}),
    Job(jobVM('w', {quoted: 'marisol vega satellites live', line: 'Waiting · 2 ahead', stages: stages(null)}), jobBase),
    Job(jobVM('f', {title: 'Lighthouse Keeper', cover: ART[1], line: 'Fetching audio · 38%', percent: 38, stages: stages('fetch')}), jobBase),
    Job(jobVM('s', {title: 'Harbor Lights', cover: ART[5], line: 'Splitting · 46% · ~2 min', percent: 46, stages: stages('split')}), jobBase),
    Job(jobVM('z', {title: 'Tin Roof Rain', cover: ART[0], line: 'Finishing', percent: 90, stages: stages('finish')}), jobBase),
    Job(jobVM('u', {kind: 'upload', title: 'rehearsal-2026-10-12.wav', line: 'Uploading · 12 of 31 MB', percent: 39, stages: stages('fetch')}), jobBase),
    Song(songs[2], {...base, job: jobVM('r', {songId: songs[2].id, percent: 71, line: 'Splitting · 71%', stages: stages('split')})}),
    Song(songs[3], {...base, job: jobVM('b', {songId: songs[3].id, kind: 'beats', percent: 30, line: 'Finding bars · 30%', stages: stages('split')})}),
    Job(jobVM('x', {title: 'Paper Boats', cover: ART[2], failure: {sentence: 'Couldn’t split this song.'}, actions: [{label: 'Try again', run() {}}]}), jobBase),
  ];
  items[0].setActive(true);
  const grid = list
    ? h('div', {class: 'lib-list', role: 'table', 'aria-label': 'Songs'}, h('div', {class: 'lib-rows', role: 'rowgroup'}, items.map(c => c.el)))
    : h('div', {class: 'lib-grid'}, items.map(c => c.el));
  el.append(h('div', {class: 'app-content lib-home'}, grid));
  window.__cards = {menu, opened, jobs, items};
}

async function homePart(el, h, query) {
  const [{mount}, {store, signal}, {registry}] = await Promise.all([
    import('/src/library/home.js'), import('/src/app/store.js'), import('/src/app/commands.js'), import('/src/library/commands.js'),
  ]);
  const now = Date.now();
  const n = Number(query.get('songs') ?? 9);
  const songs = Array.from({length: n}, (_, i) => sampleSong(i, now));
  const log = [];
  const router = {
    log, current: signal({name: 'library'}),
    navigate: to => { log.push(['navigate', to]); },
    setQuery: (patch, opts) => { log.push(['setQuery', patch, opts?.debounceMs ?? 0]); },
    href: () => '/',
  };
  let searchHandlers = null;
  const topbar = {
    jobsSlot: h('div'), setSearch: handlers => { searchHandlers = handlers; }, focusSearch() {}, clearSearch: () => false,
    get search() { return searchHandlers; },
  };
  registry.provide('router', () => router);
  registry.provide('topbar', () => topbar);
  const job = query.get('job') === '1'
    ? {jobId: 'hj1', kind: 'separate', songId: null, label: 'Harbor Lights — Ada Moreno', status: 'running', stage: 'finalize', percent: 92,
      message: 'Encoding…', error: null, meta: {title: 'Harbor Lights', artist: 'Ada Moreno'}, deviceId: null, createdAt: now - 60_000,
      startedAt: now - 50_000, updatedAt: now, attempts: 1, errorCode: null, retryAt: null, chainedFrom: null, confirmed: true,
      source: {type: 'url', value: 'https://www.youtube.com/watch?v=harbor'}, settingsSummary: {preset: 'balanced', stemMode: 'full', model: 'htdemucs_ft'}}
    : null;
  store.library.jobs.value = job ? [job] : [];
  store.library.songs.value = new Map(songs.map(s => [s.id, s]));
  store.library.loaded.value = true;
  el.style.padding = '0';
  el.style.overflow = 'hidden';
  const outlet = h('div', {class: 'shell-outlet', style: {height: '100vh', display: 'grid'}});
  el.append(outlet);
  const view = mount(outlet, {name: 'library', path: '/', params: {}, query: Object.fromEntries(new URLSearchParams(query.get('q') ? `q=${query.get('q')}` : ''))},
    {router, topbar, store, registry});
  window.__home = {
    view, router, topbar, store,
    /** The job finishes: it leaves listActive and its song (newest) arrives. */
    finish() {
      store.library.jobs.value = [];
      const harbor = {...sampleSong(7, now), id: 'harbor', title: 'Harbor Lights', artist: 'Ada Moreno', addedAt: Date.now(), lastPracticedAt: null, practiceSummary: null};
      store.library.songs.value = new Map([...store.library.songs.peek(), ['harbor', harbor]]);
    },
  };
  return view;
}

export default async function mount(el, {query, h}) {
  if ((query.get('part') ?? 'home') === 'cards') return cardsPart(el, h, query);
  return homePart(el, h, query);
}
