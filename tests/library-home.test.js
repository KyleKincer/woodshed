// @vitest-environment happy-dom
// The Library home and its parts (architecture §2.16, §3.5; spec §2.1–2.4 and §2.7): cards and rows (states, the
// rail, opening, the menu hooks, roving tabindex), Continue, the Setlists row, the first run, the library
// commands, the CONTROLS table, and the mounted view (URL and prefs mirroring, filters, sort, group, drill-down,
// the first-run threshold, the keyed reconcile, the FLIP, edge states, search, paste, the 'library' context).
//
// home.js imports LB1b's jobs.js and review-chip.js (same-wave peers, §9.0). They are mocked here; the suites that
// import home.js are skipped until both files exist (Appendix C item 60), and run at integration I1b.
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {installPopoverShim, restoreDomShims, setRect} from './helpers/dom.js';

const peers = vi.hoisted(() => ({items: null, reviews: []}));

vi.mock('../src/library/jobs.js', async () => {
  const {computed, signal} = await import('../src/app/store.js');
  const items = signal([]);
  peers.items = items;
  // LB1b's shape: `items` also holds found, unapplied detections (status 'done'), which bySong leaves out.
  const model = {
    items,
    bySong: computed(() => new Map(items.value.filter(j => j.songId && j.status !== 'done').map(j => [j.songId, j]))),
    chip: computed(() => null),
    ready: computed(() => []),
  };
  return {createJobsModel: () => model, sharedJobsModel: () => model};
});
vi.mock('../src/library/review-chip.js', () => ({
  ReviewChip: song => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'test-review';
    el.textContent = 'Is this right?';
    const chip = {el, song, update: vi.fn(), destroy: vi.fn()};
    peers.reviews.push(chip);
    return chip;
  },
}));
vi.mock('../src/api/media.js', () => ({
  signKeys: vi.fn(async keys => Object.fromEntries(keys.map(k => [k, `https://cdn.test/${k}`]))),
}));
vi.mock('../src/api/settings.js', () => ({
  demo: vi.fn(async () => null),
  subscribeConfig: () => () => {},
  patch: vi.fn(async change => change),
  config: vi.fn(async () => null),
}));

const {COPY, CONTROLS, COMMANDS} = await import('../src/library/home.copy.js');
const cards = await import('../src/library/cards.js');
const {ContinueSection} = await import('../src/library/continue.js');
const {mountSetlistsRow} = await import('../src/library/setlists.js');
const {mountFirstRun} = await import('../src/library/first-run.js');
const {defineLibraryCommands, LIBRARY_COMMAND_IDS} = await import('../src/library/commands.js');
const {createRegistry} = await import('../src/app/commands.js');
const {signal, store} = await import('../src/app/store.js');
const {prefs} = await import('../src/app/prefs.js');
const settingsApi = await import('../src/api/settings.js');
const mediaApi = await import('../src/api/media.js');

const DAY = 864e5;
const NOW = Date.now();
const tick = () => new Promise(r => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 4; i++) await tick(); };

// ---------- fixtures ----------

const stems = n => Array.from({length: n}, (_, i) => ({name: ['drums', 'bass', 'vocals', 'other', 'guitar', 'piano'][i], key: `k${i}`}));
function song(id, extra = {}) {
  return {id, title: id, artist: '', album: '', albumArtist: '', uploader: '', duration: 120, addedAt: NOW - 40 * DAY, stemMode: 'full',
    stems: stems(4), coverKey: null, coverUrl: null, artwork: null, source: null, year: '', genre: '', trackNumber: '', discNumber: '',
    musicalKey: '', tuning: '', tags: [], metadataStatus: null, reviewMetadata: false, recordingUnconfirmed: false, suggestion: null,
    hasChart: false, mapSummary: {real: false, sections: []}, lastPracticedAt: null, practiceSummary: null, hasSectionSuggestion: false, ...extra};
}
const LIBRARY = [
  song('glasshouse', {title: 'Glasshouse', artist: 'Northbound', album: 'Weather Systems', duration: 128, hasChart: true, addedAt: NOW - 2 * DAY,
    mapSummary: {real: true, bpm: 120, sections: ['Intro', 'Bridge']}, coverKey: 'covers/weather.png', musicalKey: 'A minor'}),
  song('lowtide', {title: 'Low Tide Static', artist: 'Northbound', album: 'Weather Systems', duration: 92, addedAt: NOW - 3 * DAY,
    mapSummary: {real: true, bpm: 104, sections: []}, lastPracticedAt: NOW - DAY, coverKey: 'covers/weather.png',
    practiceSummary: {loopLabel: 'Chorus loop', rate: 0.9, minusMe: true, spotCount: 3,
      spots: [{id: 'sp1', name: 'Chorus fill', rate: 0.8}, {id: 'sp2', name: 'Verse groove', rate: 0.9}, {id: 'sp3', name: 'Outro tag', rate: 1}]}}),
  song('lanterns', {title: 'Paper Lanterns', artist: 'Marisol Vega', album: 'Paper Lanterns', duration: 75, stems: stems(6), addedAt: NOW - 5 * DAY,
    lastPracticedAt: NOW - 3 * DAY, practiceSummary: {rate: 1, minusMe: false, spotCount: 0, spots: []}, coverUrl: 'data:image/svg+xml,lanterns'}),
  song('jam03', {title: 'untitled_jam_03.wav', duration: 148, reviewMetadata: true}),
  song('shuffle', {title: 'Sunday Shuffle', uploader: 'BluesLessonsChannel', duration: 312}),
  song('velvet', {title: 'Velvet Arc', artist: 'Marisol Vega', album: 'Satellites', duration: 244, mapSummary: {real: true, bpm: 100, sections: []}}),
];

function jobVM(id, extra = {}) {
  return {id, kind: 'separate', songId: null, title: null, quoted: false, cover: null, coverKey: null, stages: [], percent: 0, line: '', ahead: 0, device: null,
    settingsLine: '', message: null, source: null, eta: null, failure: null, local: false, actions: [], ...extra};
}

/** The accessible name of an element, for the roles this view uses. */
function nameOf(el) {
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) return labelledby.split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').trim();
  const label = el.getAttribute('aria-label');
  if (label) return label.trim();
  return el.textContent.replace(/\s+/g, ' ').trim();
}
const ROLE_SELECTORS = {
  button: 'button, [role=button]', link: 'a[href], [role=link]', group: '[role=group]', radiogroup: '[role=radiogroup]',
  radio: '[role=radio]', table: '[role=table]', menuitemradio: '[role=menuitemradio]',
};
const byRole = (root, role, name) => [...root.querySelectorAll(ROLE_SELECTORS[role])]
  .filter(el => (role !== 'button' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button'))
  .find(el => (name instanceof RegExp ? name.test(nameOf(el)) : nameOf(el) === name)) ?? null;

function setSongs(list) {
  store.library.songs.value = new Map(list.map(s => [s.id, s]));
  store.library.loaded.value = true;
}

function resetStore() {
  store.library.songs.value = new Map();
  store.library.loaded.value = false;
  store.library.jobs.value = [];
  store.library.devices.value = [];
  store.library.setlists.value = [];
  store.account.value = null;
  prefs.update(d => { d.library = {layout: 'grid', group: 'none', sort: null, filter: null, opened: []}; });
  peers.items && (peers.items.value = []);
  peers.reviews.length = 0;
}

beforeEach(() => {
  installPopoverShim();
  document.body.replaceChildren();
  resetStore();
});
afterEach(() => {
  restoreDomShims();
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

// =====================================================================================================
// cards.js

describe('SongCard / SongRow', () => {
  const host = () => document.body.appendChild(document.createElement('div'));

  it('a ready card: the cover link opens /s/:id, named by the title; artist; meta line; focus key', () => {
    const card = cards.SongCard(LIBRARY[0], {now: NOW});
    host().append(card.el);
    const link = card.el.querySelector('a.lib-open');
    expect(link.getAttribute('href')).toBe('/s/glasshouse');
    expect(nameOf(link)).toBe('Glasshouse');
    expect(link.dataset.focusKey).toBe('song:glasshouse');
    expect(link.contains(card.cover)).toBe(true);
    expect(card.el.dataset.state).toBe('ready');
    expect(card.el.querySelector('.lib-artist').textContent).toBe('Northbound');
    expect(card.el.querySelector('.lib-meta-text').textContent).toBe('2:08 · Chart · Mapped');
    expect(card.el.querySelector('.lib-more')).toBeNull();     // no onMenu yet (LB3)
    expect(card.el.querySelector('.lib-new-dot').hidden).toBe(true);
  });

  it('the New dot and its spoken prefix', () => {
    const card = cards.SongCard(LIBRARY[0], {isNew: true});
    expect(card.el.querySelector('.lib-new-dot').hidden).toBe(false);
    expect(nameOf(card.focusTarget)).toBe('New, Glasshouse');
    card.update(LIBRARY[0], {isNew: false});
    expect(nameOf(card.focusTarget)).toBe('Glasshouse');
  });

  it('onOpen takes a plain click (and names the cover for the View Transition through home); false leaves it native', () => {
    const onOpen = vi.fn(() => true);
    const card = cards.SongCard(LIBRARY[0], {onOpen});
    host().append(card.el);
    const click = new MouseEvent('click', {bubbles: true, cancelable: true, button: 0});
    card.focusTarget.dispatchEvent(click);
    expect(onOpen).toHaveBeenCalledWith(LIBRARY[0], expect.objectContaining({cover: card.cover}));
    expect(click.defaultPrevented).toBe(true);
    onOpen.mockReturnValue(false);
    const meta = new MouseEvent('click', {bubbles: true, cancelable: true, button: 0, metaKey: true});
    card.focusTarget.dispatchEvent(meta);
    expect(meta.defaultPrevented).toBe(false);
  });

  it('without onOpen a plain click names the cover view-transition-name: cover-<id>, one cover at a time', () => {
    const a = cards.SongCard(LIBRARY[0]);
    const b = cards.SongCard(LIBRARY[1]);
    host().append(a.el, b.el);
    a.focusTarget.addEventListener('click', e => e.preventDefault());
    b.focusTarget.addEventListener('click', e => e.preventDefault());
    a.focusTarget.click();
    expect(a.cover.style.getPropertyValue('view-transition-name')).toBe('cover-glasshouse');
    b.focusTarget.click();
    expect(a.cover.style.getPropertyValue('view-transition-name')).toBe('');
    expect(b.cover.style.getPropertyValue('view-transition-name')).toBe('cover-lowtide');
  });

  it('the artist drills down', () => {
    const onArtist = vi.fn();
    const card = cards.SongCard(LIBRARY[0], {onArtist});
    const artist = card.el.querySelector('.lib-artist');
    expect(nameOf(artist)).toBe(COPY.openArtist('Northbound'));
    artist.click();
    expect(onArtist).toHaveBeenCalledWith('Northbound');
    const anon = cards.SongCard(song('x'), {onArtist});
    expect(anon.el.querySelector('.lib-artist').hidden).toBe(true);
  });

  it('onMenu: the ⋯ button in its own cell opens the items; right-click and Shift+F10 call onMenu too', () => {
    const onMenu = vi.fn(() => [{id: 'm.one', label: 'Practice', run: vi.fn()}]);
    const card = cards.SongCard(LIBRARY[0], {onMenu});
    host().append(card.el);
    const more = card.el.querySelector('.lib-more');
    expect(more.parentElement.classList.contains('lib-card-body')).toBe(true);
    expect(nameOf(more)).toBe(COPY.more('Glasshouse'));
    more.click();
    expect(onMenu).toHaveBeenCalledWith(LIBRARY[0], expect.objectContaining({anchor: more}));
    expect(document.querySelector('[role=menu]')).not.toBeNull();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    document.querySelector('[role=menu]').closest('[popover]')?.remove();
    onMenu.mockClear();
    card.el.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40}));
    expect(onMenu).toHaveBeenCalledTimes(1);
    onMenu.mockClear();
    card.focusTarget.dispatchEvent(new KeyboardEvent('keydown', {key: 'F10', shiftKey: true, bubbles: true, cancelable: true}));
    expect(onMenu).toHaveBeenCalledTimes(1);
    card.destroy();
  });

  it('a touch long-press (500 ms) calls onMenu (D49)', () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const onMenu = vi.fn(() => null);
    const card = cards.SongCard(LIBRARY[0], {onMenu});
    host().append(card.el);
    card.el.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, pointerType: 'touch', isPrimary: true, pointerId: 3, clientX: 10, clientY: 10}));
    vi.advanceTimersByTime(499);
    expect(onMenu).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onMenu).toHaveBeenCalledTimes(1);
  });

  it('review: mounts onReview(song) while row.reviewMetadata, updates it, and destroys it after', () => {
    const chip = {el: document.createElement('button'), update: vi.fn(), destroy: vi.fn()};
    chip.el.textContent = 'Is this right?';
    const onReview = vi.fn(() => chip);
    const jam = LIBRARY[3];
    const card = cards.SongCard(jam, {onReview});
    expect(onReview).toHaveBeenCalledWith(jam);
    expect(card.el.querySelector('.lib-review').contains(chip.el)).toBe(true);
    card.update({...jam, title: 'Jam'}, {onReview});
    expect(chip.update).toHaveBeenCalled();
    expect(onReview).toHaveBeenCalledTimes(1);
    card.update({...jam, reviewMetadata: false}, {onReview});
    expect(chip.destroy).toHaveBeenCalled();
    expect(card.el.querySelector('.lib-review').hidden).toBe(true);
  });

  it('roving: every control is tabindex -1 until the card is active', () => {
    const card = cards.SongCard(LIBRARY[0], {onMenu: () => [], onArtist: () => {}});
    const focusables = () => [...card.el.querySelectorAll('a, button')].filter(el => !el.hidden && !el.closest('[hidden]'));
    expect(focusables().every(el => el.tabIndex === -1)).toBe(true);
    card.setActive(true);
    expect(focusables().every(el => el.tabIndex === 0)).toBe(true);
    card.setActive(false);
    expect(focusables().every(el => el.tabIndex === -1)).toBe(true);
  });

  it('processing (a new song): job card with the rail and stage line; it opens the Jobs popover', () => {
    const onJob = vi.fn();
    const job = jobVM('j1', {title: 'Harbor Lights', percent: 46, line: 'Splitting · 46% · ~2 min', cover: 'covers/harbor.png',
      stages: [{id: 'fetch', label: 'Fetch', state: 'done'}, {id: 'split', label: 'Split', state: 'current'}]});
    const card = cards.JobCard(job, {onJob});
    host().append(card.el);
    expect(card.el.dataset.state).toBe('processing');
    expect(card.focusTarget.tagName).toBe('BUTTON');
    expect(card.focusTarget.dataset.focusKey).toBe('job:j1');
    expect(nameOf(card.focusTarget)).toBe('Harbor Lights, Splitting · 46% · ~2 min');
    const rail = card.el.querySelector('.lib-rail');
    expect(rail).not.toBeNull();
    expect(card.cover.contains(rail)).toBe(true);
    expect(rail.getAttribute('aria-valuenow') ?? rail.querySelector('.ui-progress-rail-fill').style.getPropertyValue('--progress')).toMatch(/46|0\.46/);
    card.focusTarget.click();
    expect(onJob).toHaveBeenCalledWith(job, {anchor: card.focusTarget});
  });

  it("a search job with no metadata title yet shows its query in quotes (LB1b: title is the query, quoted: true)", () => {
    const card = cards.JobCard(jobVM('j2', {title: 'harbor lights ada moreno', quoted: true, line: 'Waiting · 2 ahead'}));
    expect(card.el.querySelector('.lib-title-text').textContent).toBe('“harbor lights ada moreno”');
    card.update(jobVM('j2', {title: 'Harbor Lights', quoted: false, line: 'Fetching'}));
    expect(card.el.querySelector('.lib-title-text').textContent).toBe('Harbor Lights');
  });

  it("a job card's cover: an R2 coverKey is signed; the URL in cover is used as is", async () => {
    const keyed = cards.JobCard(jobVM('jk', {title: 'Harbor Lights', cover: null, coverKey: 'covers/new.png'}));
    const url = cards.JobCard(jobVM('ju', {title: 'Undertow', cover: 'https://i.ytimg.com/u.jpg', coverKey: null}));
    await flush();
    expect(keyed.cover.querySelector('img')?.getAttribute('src')).toBe('https://cdn.test/covers/new.png');
    expect(url.cover.querySelector('img')?.getAttribute('src')).toBe('https://i.ytimg.com/u.jpg');
  });

  it("the rail: the job's own rail when it has one (paused offline: striped; first-run setup: its percent)", () => {
    const paused = cards.JobCard(jobVM('jp', {title: 'A', percent: 40, stages: [{id: 'split', state: 'current'}], rail: {value: 0.4, striped: true}}));
    const rail = paused.el.querySelector('.lib-rail');
    expect(rail.dataset.striped).toBe('');
    const setup = cards.JobCard(jobVM('js', {title: 'B', percent: null, stages: [{id: 'split', state: 'current'}], rail: {value: 0.3, striped: false}}));
    const fill = setup.el.querySelector('.lib-rail');
    expect(fill.getAttribute('aria-valuenow') ?? fill.querySelector('.ui-progress-rail-fill')?.style.getPropertyValue('--progress')).toMatch(/30|0\.3/);
  });

  it('re-splitting: processing chrome on an existing song that still opens the song', () => {
    const job = jobVM('j3', {songId: 'velvet', kind: 'separate', percent: 71, line: 'Splitting · 71%'});
    const card = cards.SongCard(LIBRARY[5], {job});
    expect(card.el.dataset.state).toBe('resplitting');
    expect(card.focusTarget.getAttribute('href')).toBe('/s/velvet');
    expect(card.el.querySelector('.lib-meta-text').textContent).toBe('Splitting · 71%');
    expect(card.el.querySelector('.lib-rail')).not.toBeNull();
    card.update(LIBRARY[5], {job: null});
    expect(card.el.dataset.state).toBe('ready');
    expect(card.el.querySelector('.lib-rail')).toBeNull();
    const beats = cards.SongCard(LIBRARY[5], {job: jobVM('j4', {songId: 'velvet', kind: 'beats', percent: 30, line: 'Finding bars · 30%'})});
    expect(beats.el.dataset.state).toBe('working');
  });

  it('failed: the sentence in the danger tone with [Try again] and [Details]', () => {
    const retry = vi.fn();
    const onJob = vi.fn();
    const job = jobVM('j5', {title: 'Paper Boats', failure: {sentence: 'Couldn’t split this song.'}, actions: [{label: 'Try again', run: retry}]});
    const card = cards.JobCard(job, {onJob});
    expect(card.el.dataset.state).toBe('failed');
    const meta = card.el.querySelector('.lib-meta');
    expect(meta.dataset.tone).toBe('danger');
    expect(meta.textContent).toContain('Couldn’t split this song.');
    expect(card.el.querySelector('.lib-rail')).toBeNull();
    byRole(card.el, 'button', COPY.tryAgain).click();
    expect(retry).toHaveBeenCalled();
    byRole(card.el, 'button', COPY.jobDetails('Paper Boats')).click();
    expect(onJob).toHaveBeenCalledWith(job, expect.objectContaining({anchor: expect.any(HTMLElement)}));
    const noRetry = cards.JobCard(jobVM('j6', {title: 'X', failure: {sentence: 'Nope'}}));
    expect(noRetry.el.querySelector('.lib-fail-action').hidden).toBe(true);
    const tryNow = vi.fn();
    const bot = cards.JobCard(jobVM('j7', {title: 'Undertow', failure: {sentence: 'YouTube wants a sign-in check.', primary: {label: 'Try now', run: tryNow}}}));
    byRole(bot.el, 'button', 'Try now').click();
    expect(tryNow).toHaveBeenCalled();
  });

  it("Try again runs the job's guarded action of the failure's primary target, not the raw one", () => {
    const raw = vi.fn(async () => { throw new Error('network'); });
    const guarded = vi.fn(async () => undefined);
    const job = jobVM('jg', {title: 'Undertow', failure: {sentence: 'Couldn’t split this song.', primary: {label: 'Try again', target: 'jobs.retry', run: raw}},
      actions: [{label: 'Try again', target: 'jobs.retry', run: guarded}, {label: 'Cancel', run: vi.fn()}]});
    const card = cards.JobCard(job);
    byRole(card.el, 'button', COPY.tryAgain).click();
    expect(guarded).toHaveBeenCalledTimes(1);
    expect(raw).not.toHaveBeenCalled();
  });

  it('a retry that rejects becomes an error toast, not an unhandled rejection', async () => {
    const {toastState} = await import('../src/app/feedback.js');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const run = vi.fn(async () => { throw new Error('network'); });
      const card = cards.JobCard(jobVM('jr', {title: 'Undertow', failure: {sentence: 'Couldn’t split this song.', primary: {label: 'Try again', run}}}));
      byRole(card.el, 'button', COPY.tryAgain).click();
      await flush();
      expect(run).toHaveBeenCalled();
      const state = toastState();
      expect([state.visible, ...state.queued].some(t => t?.tone === 'error')).toBe(true);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('railOf: waiting is empty and striped, finishing is indeterminate, else the percent', () => {
    expect(cards.railOf(jobVM('a', {stage: 'queued'}))).toEqual({value: 0, striped: true});
    expect(cards.railOf(jobVM('a', {stages: [{id: 'fetch', state: 'pending'}, {id: 'split', state: 'pending'}]}))).toEqual({value: 0, striped: true});
    expect(cards.railOf(jobVM('a', {stages: [{id: 'finish', state: 'current'}], percent: 90}))).toEqual({value: null, striped: false});
    expect(cards.railOf(jobVM('a', {stages: [{id: 'split', state: 'current'}], percent: 46}))).toEqual({value: 0.46, striped: false});
    expect(cards.railOf(null)).toBeNull();
  });

  it('covers: R2 keys are signed together; URLs are used as they are', async () => {
    const a = cards.SongCard(LIBRARY[0]);
    const b = cards.SongCard(LIBRARY[1]);
    const c = cards.SongCard(LIBRARY[2]);
    await flush();
    expect(mediaApi.signKeys).toHaveBeenCalledTimes(1);
    expect(mediaApi.signKeys).toHaveBeenCalledWith(['covers/weather.png']);
    expect(a.cover.querySelector('img').getAttribute('src')).toBe('https://cdn.test/covers/weather.png');
    expect(b.cover.querySelector('img').getAttribute('src')).toBe('https://cdn.test/covers/weather.png');
    expect(c.cover.querySelector('img').getAttribute('src')).toBe('data:image/svg+xml,lanterns');
    expect(cards.coverSource('covers/x.png')).toEqual({key: 'covers/x.png'});
    expect(cards.coverSource('https://i.ytimg.com/x.jpg')).toEqual({url: 'https://i.ytimg.com/x.jpg'});
    expect(cards.coverSource(null)).toBeNull();
  });

  it('a cover whose signing failed asks again on the next render; a broken signed image is signed once more', async () => {
    mediaApi.signKeys.mockRejectedValueOnce(new Error('offline'));
    const card = cards.SongCard(LIBRARY[0]);
    await flush();
    expect(card.cover.querySelector('img')).toBeNull();
    card.update(LIBRARY[0], {});
    await flush();
    expect(mediaApi.signKeys).toHaveBeenCalledTimes(2);
    const img = card.cover.querySelector('img');
    expect(img.getAttribute('src')).toBe('https://cdn.test/covers/weather.png');
    img.dispatchEvent(new Event('error'));
    await flush();
    expect(mediaApi.signKeys).toHaveBeenCalledTimes(3);
    expect(card.cover.querySelector('img')?.getAttribute('src')).toBe('https://cdn.test/covers/weather.png');
    card.cover.querySelector('img').dispatchEvent(new Event('error'));
    await flush();
    expect(mediaApi.signKeys).toHaveBeenCalledTimes(3);   // once
  });

  it('a list row: the title link, album drill-down, key, BPM, length and practised columns', () => {
    const onAlbum = vi.fn();
    const row = cards.SongRow(LIBRARY[1], {onAlbum, now: NOW});
    host().append(row.el);
    expect(row.el.getAttribute('role')).toBe('row');
    expect(row.focusTarget.classList.contains('lib-open-title')).toBe(true);
    expect(row.focusTarget.getAttribute('href')).toBe('/s/lowtide');
    expect(row.el.querySelector('.lib-col-bpm').textContent).toBe('104');
    expect(row.el.querySelector('.lib-col-duration').textContent).toBe('1:32');
    expect(row.el.querySelector('.lib-col-practised').textContent).toBe('yesterday');
    expect(row.el.querySelector('.lib-meta').hidden).toBe(true);
    byRole(row.el, 'button', COPY.openAlbum('Weather Systems')).click();
    expect(onAlbum).toHaveBeenCalledWith('Weather Systems');
    expect([...row.el.querySelectorAll('[role=cell]')]).toHaveLength(8);
  });
});

// =====================================================================================================
// continue.js, setlists.js, first-run.js

describe('ContinueSection', () => {
  it('a clock tick or a store update keeps keyboard focus on a spot chip (chips update in place)', () => {
    const profile = {instruments: ['drums'], primary: 'drums'};
    const section = ContinueSection({songs: LIBRARY, now: NOW, profile});
    document.body.append(section.el);
    const chip = section.el.querySelector('.lib-spot-chip');
    chip.focus();
    expect(document.activeElement).toBe(chip);
    section.update({songs: LIBRARY.map(s => ({...s})), now: NOW + 30_000, profile});
    expect(document.activeElement).toBe(chip);
    const renamed = LIBRARY.map(s => (s.id === 'lowtide' ? {...s, practiceSummary: {...s.practiceSummary,
      spots: [{id: 'sp1', name: 'Chorus fill (2)', rate: 0.8}, ...s.practiceSummary.spots.slice(1)]}} : s));
    section.update({songs: renamed, now: NOW + 60_000, profile});
    expect(document.activeElement).toBe(chip);
    expect(chip.textContent).toContain('Chorus fill (2)');
    section.update({songs: LIBRARY.map(s => (s.id === 'lowtide' ? {...s, practiceSummary: {...s.practiceSummary, spots: s.practiceSummary.spots.slice(1)}} : s)), now: NOW, profile});
    expect(section.el.querySelectorAll('.lib-spot-chip')).toHaveLength(2);
    expect(chip.isConnected).toBe(false);
  });

  it('the hero: title, artist, state line, Resume, Start from top and up to 3 spot chips', () => {
    const section = ContinueSection({songs: LIBRARY, now: NOW, profile: {instruments: ['drums'], primary: 'drums'}});
    document.body.append(section.el);
    expect(section.el.hidden).toBe(false);
    const hero = section.el.querySelector('.lib-hero');
    expect(hero.querySelector('.lib-hero-title').textContent).toBe('Low Tide Static');
    expect(hero.querySelector('.lib-hero-artist').textContent).toBe('Northbound');
    expect(hero.querySelector('.lib-hero-state').textContent).toBe('Chorus loop · 90% · Drums out · practised yesterday');
    const resume = byRole(hero, 'link', COPY.resumeLabel('Low Tide Static'));
    expect(resume.getAttribute('href')).toBe('/s/lowtide');
    expect(byRole(hero, 'link', COPY.startOverLabel('Low Tide Static')).getAttribute('href')).toBe('/s/lowtide?t=0');
    const spots = [...hero.querySelectorAll('.lib-spot-chip')];
    expect(spots.map(a => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Chorus fill · 80%', '/s/lowtide?spot=sp1'], ['Verse groove · 90%', '/s/lowtide?spot=sp2'], ['Outro tag · 100%', '/s/lowtide?spot=sp3']]);
  });

  it('recents: up to three compact cards after the hero, most recent first', () => {
    const more = [...LIBRARY, song('a', {title: 'A', lastPracticedAt: NOW - 4 * DAY}), song('b', {title: 'B', lastPracticedAt: NOW - 5 * DAY}),
      song('c', {title: 'C', lastPracticedAt: NOW - 6 * DAY})];
    const section = ContinueSection({songs: more, now: NOW});
    const recents = [...section.el.querySelectorAll('.lib-recent')];
    expect(recents.map(a => a.querySelector('.lib-compact-title').textContent)).toEqual(['Paper Lanterns', 'A', 'B']);
    expect(recents[0].getAttribute('href')).toBe('/s/lanterns');
    expect(nameOf(recents[0])).toBe('Paper Lanterns, 100% · practised 3 days ago');
    // VF1-1: one state line in the hero's format (stateLine, joined with ' · '), never two lines
    const lines = recents.map(a => a.querySelector('.lib-compact-line').textContent);
    expect(lines[0]).toBe('100% · practised 3 days ago');
    expect(lines.slice(1)).toEqual(['practised 4 days ago', 'practised 5 days ago']);
    for (const text of lines) expect(text).not.toMatch(/\n/);
    // a later update reuses the nodes
    const first = recents[0];
    section.update({songs: more, now: NOW});
    expect(section.el.querySelector('.lib-recent')).toBe(first);
  });

  it('a compact card keeps its line on one line, ellipsized (VF1-1)', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/views/library/cards.css'), 'utf8');
    const rule = css.match(/\.lib-compact-line\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).not.toMatch(/pre-line|line-clamp/);
  });

  it('is hidden when nothing was practised; opening names the cover', () => {
    const section = ContinueSection({songs: [song('x')], now: NOW});
    expect(section.el.hidden).toBe(true);
    section.update({songs: LIBRARY, now: NOW});
    expect(section.el.hidden).toBe(false);
    document.body.append(section.el);
    const resume = section.el.querySelector('.lib-hero-resume');
    resume.addEventListener('click', e => e.preventDefault());
    resume.click();
    expect(section.el.querySelector('.lib-hero-cover').style.getPropertyValue('view-transition-name')).toBe('cover-lowtide');
  });
});

describe('mountSetlistsRow (read-only, BK6)', () => {
  it('reads store.library.setlists: one card per list opening /set/:id; hidden while none exist', () => {
    setSongs(LIBRARY);
    const host = document.body.appendChild(document.createElement('div'));
    const row = mountSetlistsRow(host, {store});
    const section = host.querySelector('.lib-setlists');
    expect(section.hidden).toBe(true);
    store.library.setlists.value = [
      {id: 'set-friday', name: 'Friday at the Grange', count: 5, songIds: ['glasshouse', 'lowtide', 'lanterns', 'velvet', 'shuffle'], updatedAt: NOW},
      {id: 'set-warmup', name: 'Warm-ups', count: 1, songIds: ['shuffle'], updatedAt: NOW - DAY},
    ];
    expect(section.hidden).toBe(false);
    const links = [...host.querySelectorAll('a.lib-set-card')];
    expect(links.map(a => [a.getAttribute('href'), nameOf(a)])).toEqual([
      ['/set/set-friday', 'Friday at the Grange, 5 songs'], ['/set/set-warmup', 'Warm-ups, 1 song']]);
    expect(links[0].querySelectorAll('.lib-set-tile')).toHaveLength(4);
    store.library.setlists.value = [store.library.setlists.peek()[1]];
    expect(host.querySelectorAll('a.lib-set-card')).toHaveLength(1);
    expect(host.querySelector('a.lib-set-card')).toBe(links[1]);
    row.destroy();
    expect(host.querySelector('.lib-setlists')).toBeNull();
  });
});

describe('mountFirstRun', () => {
  const TOKEN = 'dec0'.repeat(16);

  it('desktop: the Demo card (from settings.demo) and "Add your first song"', () => {
    const navigate = vi.fn();
    const host = document.body.appendChild(document.createElement('div'));
    const view = mountFirstRun(host, {demo: {token: TOKEN}, desktop: true, navigate});
    expect(host.textContent).toContain(COPY.demoTitle);
    expect(host.textContent).toContain(COPY.demoBody);
    expect(host.textContent).toContain(COPY.addFirstTitle);
    byRole(host, 'button', COPY.openExample).click();
    expect(navigate).toHaveBeenCalledWith(`/share/${TOKEN}`);
    byRole(host, 'button', COPY.addSong).click();
    expect(navigate).toHaveBeenCalledWith('/add');
    view.destroy();
    expect(host.children).toHaveLength(0);
  });

  it('web and iPad: Get Woodshed for desktop ↗ (new tab) and I already have it, which reveals the hint', () => {
    const host = document.body.appendChild(document.createElement('div'));
    mountFirstRun(host, {demo: null, desktop: false});
    expect(host.textContent).toContain(COPY.webAddTitle);
    expect(host.textContent).toContain(COPY.webAddBody);
    const link = byRole(host, 'link', `${COPY.getDesktop} ${COPY.newTab}`);
    expect(link.getAttribute('href')).toBe('/download');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
    const already = byRole(host, 'button', COPY.alreadyHave);
    const hint = host.querySelector('.lib-first-hint');
    expect(hint.hidden).toBe(true);
    already.click();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(COPY.alreadyHaveBody);
    expect(already.getAttribute('aria-expanded')).toBe('true');
  });

  it('the Demo card is hidden without a token (D7), and shows once one arrives', () => {
    const host = document.body.appendChild(document.createElement('div'));
    const view = mountFirstRun(host, {demo: null, desktop: true});
    const demoCard = host.querySelector('.lib-first-demo');
    expect(demoCard.hidden).toBe(true);
    view.update({demo: {token: 'not-a-token'}});
    expect(demoCard.hidden).toBe(true);
    view.update({demo: {token: TOKEN}});
    expect(demoCard.hidden).toBe(false);
  });
});

// =====================================================================================================
// commands.js

describe('library commands (§3.5, scope L)', () => {
  function setup(library = {}) {
    const registry = createRegistry();
    defineLibraryCommands({registry});
    const router = {navigate: vi.fn()};
    const topbar = {focusSearch: vi.fn()};
    registry.provide('router', () => router);
    registry.provide('topbar', () => topbar);
    const offLibrary = registry.provide('library', () => library);
    return {registry, router, topbar, offLibrary};
  }

  it('defines every id with its keys in the library scope and no reserved key', () => {
    const {registry} = setup();
    expect(LIBRARY_COMMAND_IDS.every(id => registry.get(id))).toBe(true);
    const keys = Object.fromEntries(LIBRARY_COMMAND_IDS.map(id => [id, registry.get(id).keys]));
    expect(keys).toEqual({
      'library.add': ['KeyN'], 'library.search': ['/'], 'library.openFocused': ['Enter'], 'library.editFocused': ['KeyE'],
      'library.deleteSelected': ['Backspace', 'Delete'], 'library.selectAll': ['Mod+KeyA'], 'library.select': [],
      'library.first': ['Home'], 'library.last': ['End'], 'library.view': [],
    });
    for (const id of LIBRARY_COMMAND_IDS) {
      const def = registry.get(id);
      expect(def.group).toBe('Library');
      if (def.keys.length) expect(def.scopes).toEqual(['library']);
    }
    expect(registry.get('library.add').title).toBe(COMMANDS.add);
  });

  it('library.add opens /add; library.search focuses the top-bar field', () => {
    const {registry, router, topbar} = setup();
    expect(registry.run('library.add')).toBe(true);
    expect(router.navigate).toHaveBeenCalledWith('/add');
    expect(registry.run('library.search')).toBe(true);
    expect(topbar.focusSearch).toHaveBeenCalled();
  });

  it('focused-card commands need a focused card', () => {
    const lib = {focusedSongId: null, openFocused: vi.fn(), editFocused: vi.fn(), focusFirst: vi.fn(), focusLast: vi.fn(), toggleLayout: vi.fn(), layout: 'grid'};
    const {registry} = setup(lib);
    expect(registry.isEnabled('library.editFocused')).toBe(false);
    lib.focusedSongId = 'glasshouse';
    expect(registry.run('library.editFocused')).toBe(true);
    expect(lib.editFocused).toHaveBeenCalled();
    expect(registry.run('library.openFocused')).toBe(true);
    expect(registry.run('library.first')).toBe(true);
    expect(registry.run('library.last')).toBe(true);
    expect(lib.focusFirst).toHaveBeenCalled();
    expect(lib.focusLast).toHaveBeenCalled();
    expect(registry.isChecked('library.view')).toBe(false);
    registry.run('library.view');
    expect(lib.toggleLayout).toHaveBeenCalled();
  });

  it('selection commands wait for selection mode (LB3) and its actions', () => {
    const lib = {selecting: false, deleteSelected: vi.fn(), selectAll: vi.fn()};
    const {registry} = setup(lib);
    expect(registry.isEnabled('library.deleteSelected')).toBe(false);
    expect(registry.isEnabled('library.selectAll')).toBe(false);
    expect(registry.isEnabled('library.select')).toBe(false);
    lib.selecting = true;
    expect(registry.run('library.deleteSelected')).toBe(true);
    expect(registry.run('library.selectAll')).toBe(true);
    expect(lib.deleteSelected).toHaveBeenCalled();
    expect(lib.selectAll).toHaveBeenCalled();
  });

  it('nothing runs when the Library is not mounted', () => {
    const {registry, offLibrary} = setup({focusFirst: vi.fn()});
    offLibrary();
    expect(registry.isEnabled('library.first')).toBe(false);
    expect(registry.isEnabled('library.view')).toBe(false);
  });
});

// =====================================================================================================
// the mounted view (needs LB1b's peers on disk; mocked above)

const PEERS = ['src/library/jobs.js', 'src/library/review-chip.js'];
const missingPeers = PEERS.filter(p => !existsSync(join(process.cwd(), p)));

describe.skipIf(missingPeers.length)('Library home (mounted)', () => {
  let home, view, ctx, el, registry;
  const TOKEN = 'dec0'.repeat(16);

  async function mountHome({query = {}, desktop = false, songs = LIBRARY, loaded = true} = {}) {
    home ??= await import('../src/library/home.js');
    registry = createRegistry();
    defineLibraryCommands({registry});
    const jobsCalls = [];
    registry.register({id: 'library.jobs', title: 'Jobs', group: 'Library', run: c => jobsCalls.push(c.args)});
    const router = {navigate: vi.fn(), setQuery: vi.fn()};
    const topbar = {setSearch: vi.fn(), focusSearch: vi.fn(), clearSearch: vi.fn(() => false), jobsSlot: document.createElement('div')};
    ctx = {router, topbar, registry, store, platform: {reducedMotion: signal(false)}, desktop: {available: desktop}, jobsCalls};
    if (songs) store.library.songs.value = new Map(songs.map(s => [s.id, s]));
    store.library.loaded.value = loaded;
    el = document.body.appendChild(document.createElement('div'));
    view = home.mount(el, {name: 'library', path: '/', params: {}, query}, ctx);
    await flush();
    return view;
  }
  const search = () => ctx.topbar.setSearch.mock.calls.at(-1)[0];
  const cardsShown = () => [...el.querySelectorAll('[data-key^="song:"], [data-key^="job:"]')].map(n => n.dataset.key);
  // Loading home.js instantiates the mocked jobs model (peers.items), so a test may seed jobs before it mounts.
  beforeAll(async () => { home ??= await import('../src/library/home.js'); });

  afterEach(async () => { await view?.unmount(); view = null; });

  it('renders Continue, Pinned and the Library with every song, artwork-first, sorted by recent practice', async () => {
    store.account.value = {pins: ['glasshouse', 'gone'], profile: {instruments: ['drums'], primary: 'drums', openWithMyPart: 'in'}};
    await mountHome();
    expect(el.querySelector('[data-scroller]')).not.toBeNull();
    expect(el.querySelector('.lib-continue').hidden).toBe(false);
    expect(el.querySelector('.lib-hero-state').textContent).toBe('Chorus loop · 90% · Drums out · practised yesterday');
    const pinned = el.querySelector('.lib-pinned');
    expect(pinned.hidden).toBe(false);
    expect([...pinned.querySelectorAll('.lib-compact-title')].map(n => n.textContent)).toEqual(['Glasshouse']);
    expect(cardsShown()).toEqual(['song:lowtide', 'song:lanterns', 'song:glasshouse', 'song:jam03', 'song:shuffle', 'song:velvet']);
    // VF1-2: '6' on screen (aria-hidden) and '6 songs' visually hidden; no aria-label on the generic span
    const count = el.querySelector('.lib-count');
    expect(count.hasAttribute('aria-label')).toBe(false);
    expect(count.querySelector('[aria-hidden="true"]').textContent).toBe('6');
    expect(count.querySelector('.sr-only').textContent).toBe('6 songs');
    const heading = el.querySelector('#lib-library-title');
    const spoken = [...heading.childNodes].map(function text(n) {
      if (n.nodeType === 3) return n.textContent;
      if (n.getAttribute('aria-hidden') === 'true') return '';
      return [...n.childNodes].map(text).join(' ');
    }).join(' ').replace(/\s+/g, ' ').trim();
    expect(spoken).toBe('Library 6 songs');
    expect(ctx.topbar.setSearch).toHaveBeenCalledWith(expect.objectContaining({value: ''}));
  });

  it('the New dot follows prefs.library.opened', async () => {
    await mountHome();
    const card = () => el.querySelector('[data-key="song:glasshouse"]');
    expect(card().hasAttribute('data-new')).toBe(true);
    prefs.update(d => { d.library.opened.push('glasshouse'); });
    await flush();
    expect(card().hasAttribute('data-new')).toBe(false);
  });

  it('a filter chip mirrors to the URL (replace, 400 ms) and prefs.library; tapping it again clears it', async () => {
    await mountHome();
    byRole(el, 'button', COPY.filters.chart).click();
    expect(cardsShown()).toEqual(['song:glasshouse']);
    expect(ctx.router.setQuery).toHaveBeenLastCalledWith(expect.objectContaining({filter: 'chart'}), {debounceMs: 400});
    expect(prefs.value.peek().library.filter).toBe('chart');
    byRole(el, 'button', COPY.filters.chart).click();
    expect(cardsShown()).toHaveLength(6);
    expect(ctx.router.setQuery).toHaveBeenLastCalledWith(expect.objectContaining({filter: null}), {debounceMs: 400});
    expect(prefs.value.peek().library.filter).toBeNull();
  });

  it('review filters on row.reviewMetadata; Processing and Failed chips show only when something matches', async () => {
    await mountHome();
    expect(byRole(el, 'button', /^Processing/)).toBeNull();
    expect(byRole(el, 'button', /^Failed/)).toBeNull();
    peers.items.value = [jobVM('j1', {songId: 'velvet', percent: 10, line: 'Splitting · 10%'}),
      jobVM('j2', {title: 'Paper Boats', failure: {sentence: 'Couldn’t split this song.'}})];
    await flush();
    expect(byRole(el, 'button', COPY.filterWithCount(COPY.filters.processing, 1))).not.toBeNull();
    byRole(el, 'button', COPY.filterWithCount(COPY.filters.failed, 1)).click();
    expect(cardsShown()).toEqual(['job:j2']);
    byRole(el, 'button', COPY.filterWithCount(COPY.filters.failed, 1)).click();
    byRole(el, 'button', COPY.filterWithCount(COPY.filters.processing, 1)).click();
    expect(cardsShown()).toEqual(['song:velvet']);
    byRole(el, 'button', COPY.filterWithCount(COPY.filters.processing, 1)).click();
    byRole(el, 'button', COPY.filters.review).click();
    expect(cardsShown()).toEqual(['song:jam03']);
    expect(el.querySelector('[data-key="song:jam03"] .test-review')).not.toBeNull();
  });

  it("the Processing count is what the Processing filter shows: a found, unapplied detection (status done) is not processing", async () => {
    await mountHome();
    peers.items.value = [jobVM('jd', {kind: 'beats', songId: 'velvet', status: 'done', line: 'Bars found'})];
    await flush();
    expect(byRole(el, 'button', /^Processing/)).toBeNull();
    peers.items.value = [jobVM('jd', {kind: 'beats', songId: 'velvet', status: 'done', line: 'Bars found'}),
      jobVM('j1', {songId: 'glasshouse', status: 'running', percent: 10, line: 'Splitting · 10%'}),
      jobVM('j2', {title: 'Harbor Lights', status: 'queued', line: 'Waiting'})];
    await flush();
    byRole(el, 'button', COPY.filterWithCount(COPY.filters.processing, 2)).click();
    expect(cardsShown()).toEqual(['job:j2', 'song:glasshouse']);
  });

  it('the URL drives the first view; prefs fill what the URL lacks; a new search never resets the sort', async () => {
    prefs.update(d => { d.library.sort = 'title'; d.library.group = 'album'; });
    await mountHome({query: {q: 'northbound'}});
    expect(search().value).toBe('northbound');
    expect(el.querySelectorAll('.lib-group')).toHaveLength(1);
    expect(cardsShown()).toEqual(['song:glasshouse', 'song:lowtide']);
    search().onInput('marisol');
    expect(cardsShown()).toEqual(['song:lanterns', 'song:velvet']);
    expect(ctx.router.setQuery).toHaveBeenLastCalledWith({q: 'marisol', sort: 'title', group: 'album', filter: null, artist: null, album: null, layout: null}, {debounceMs: 400});
    expect(el.querySelector('.lib-sort-menu').textContent).toContain(COPY.sortButton(COPY.sorts.title));
  });

  it('Sort ▾ and Group ▾ menus change the order and the grouping, and persist', async () => {
    await mountHome();
    el.querySelector('.lib-sort-menu').click();
    byRole(document.body, 'menuitemradio', COPY.sorts.duration).click();
    await flush();
    expect(cardsShown()).toEqual(['song:lanterns', 'song:lowtide', 'song:glasshouse', 'song:jam03', 'song:velvet', 'song:shuffle']);
    expect(prefs.value.peek().library.sort).toBe('duration');
    el.querySelector('.lib-group-menu').click();
    byRole(document.body, 'menuitemradio', COPY.groups.artist).click();
    await flush();
    expect([...el.querySelectorAll('.lib-group .lib-group-label')].map(n => n.textContent))
      .toEqual(['BluesLessonsChannel', 'Marisol Vega', 'Northbound', COPY.unknownArtist]);
    expect([...el.querySelectorAll('.lib-group .lib-group-count')].map(n => n.textContent)).toEqual(['1 song', '2 songs', '2 songs', '1 song']);
    expect(el.querySelector('.lib-group-menu').textContent).toContain(COPY.groupButton(COPY.groups.artist));
    expect(prefs.value.peek().library.group).toBe('artist');
  });

  it('drill-down: clicking an artist adds a removable chip', async () => {
    await mountHome();
    el.querySelector('[data-key="song:velvet"] .lib-artist').click();
    expect(cardsShown()).toEqual(['song:lanterns', 'song:velvet']);
    expect(ctx.router.setQuery).toHaveBeenLastCalledWith(expect.objectContaining({artist: 'Marisol Vega'}), {debounceMs: 400});
    const remove = byRole(el, 'button', COPY.removeDrill(COPY.drillArtist('Marisol Vega')));
    expect(remove).not.toBeNull();
    remove.click();
    expect(cardsShown()).toHaveLength(6);
    expect(byRole(el, 'button', COPY.removeDrill(COPY.drillArtist('Marisol Vega')))).toBeNull();
  });

  it('Sort, Group and the filter chips appear only from 6 songs', async () => {
    await mountHome({songs: LIBRARY.slice(0, 5)});
    expect(el.querySelector('.lib-tools').hidden).toBe(true);
    expect(el.querySelector('.lib-filter-chips').hidden).toBe(true);
    expect(el.querySelector('.lib-layout')).not.toBeNull();
    setSongs(LIBRARY);
    await flush();
    expect(el.querySelector('.lib-tools').hidden).toBe(false);
    expect(el.querySelector('.lib-filter-chips').hidden).toBe(false);
  });

  it('the keyed reconcile keeps the focused card node across store ticks', async () => {
    await mountHome();
    const link = el.querySelector('[data-key="song:glasshouse"] a.lib-open');
    link.focus();
    expect(document.activeElement).toBe(link);
    setSongs(LIBRARY.map(s => ({...s, title: s.id === 'lanterns' ? 'Paper Lanterns (live)' : s.title, duration: s.duration + 1})));
    await flush();
    expect(document.activeElement).toBe(link);
    expect(el.querySelector('[data-key="song:glasshouse"] a.lib-open')).toBe(link);
    expect(el.querySelector('[data-key="song:lanterns"] .lib-title-text').textContent).toBe('Paper Lanterns (live)');
    // a re-sort moves the others around the focused card without recreating it
    setSongs([...LIBRARY].reverse().map(s => ({...s, lastPracticedAt: null})));
    await flush();
    expect(document.activeElement).toBe(link);
  });

  it('roving focus: one Tab stop; arrows move between cards; Home/End through the commands', async () => {
    await mountHome();
    const tabbable = () => [...el.querySelectorAll('.lib-grid a.lib-open')].filter(a => a.tabIndex === 0);
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0].dataset.focusKey).toBe('song:lowtide');
    tabbable()[0].focus();
    tabbable()[0].dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true, cancelable: true}));
    expect(document.activeElement.dataset.focusKey).toBe('song:lanterns');
    expect(tabbable().map(a => a.dataset.focusKey)).toEqual(['song:lanterns']);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft', bubbles: true, cancelable: true}));
    expect(document.activeElement.dataset.focusKey).toBe('song:lowtide');
    expect(el.querySelector('.lib-grid').getAttribute('data-consume-keys')).toBe('ArrowLeft ArrowRight ArrowUp ArrowDown');
    expect(registry.run('library.last')).toBe(true);
    expect(document.activeElement.dataset.focusKey).toBe('song:velvet');
    expect(registry.run('library.first')).toBe(true);
    expect(document.activeElement.dataset.focusKey).toBe('song:lowtide');
  });

  it('ArrowDown in a grid moves to the nearest card in the next row (geometry from the layout)', async () => {
    await mountHome();
    const cardsEls = [...el.querySelectorAll('.lib-grid .lib-card')];
    cardsEls.forEach((c, i) => setRect(c, {x: (i % 3) * 200, y: Math.floor(i / 3) * 300, width: 190, height: 280}));
    cardsEls[1].querySelector('a.lib-open').focus();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, cancelable: true}));
    expect(document.activeElement).toBe(cardsEls[4].querySelector('a.lib-open'));
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true, cancelable: true}));
    expect(document.activeElement).toBe(cardsEls[1].querySelector('a.lib-open'));
  });

  it('the list view: a table with sortable column headers', async () => {
    await mountHome();
    byRole(el, 'radio', COPY.list).click();
    await flush();
    expect(prefs.value.peek().library.layout).toBe('list');
    // VF1-3: the layout is mirrored to the URL as ?layout=list, like sort
    expect(ctx.router.setQuery).toHaveBeenLastCalledWith(expect.objectContaining({layout: 'list'}), {debounceMs: 400});
    const table = byRole(el, 'table', COPY.listLabel);
    expect(table).not.toBeNull();
    expect(table.querySelectorAll('.lib-rows > .lib-row')).toHaveLength(6);
    const title = byRole(table, 'button', COPY.columns.title);
    title.click();
    await flush();
    expect(title.parentElement.getAttribute('aria-sort')).toBe('ascending');
    expect(cardsShown()[0]).toBe('song:glasshouse');
    title.click();
    await flush();
    expect(title.parentElement.getAttribute('aria-sort')).toBe('descending');
    expect(cardsShown()[0]).toBe('song:velvet');
    expect(ctx.router.setQuery).toHaveBeenLastCalledWith(expect.objectContaining({sort: '-title'}), {debounceMs: 400});
  });

  it('a card opens the Stage with the cover named for the View Transition; ⌘-click stays native', async () => {
    await mountHome();
    const card = el.querySelector('[data-key="song:glasshouse"]');
    card.querySelector('a.lib-open').click();
    expect(ctx.router.navigate).toHaveBeenCalledWith('/s/glasshouse');
    expect(card.querySelector('.lib-card-cover').style.getPropertyValue('view-transition-name')).toBe('cover-glasshouse');
    ctx.router.navigate.mockClear();
    const meta = new MouseEvent('click', {bubbles: true, cancelable: true, button: 0, metaKey: true});
    card.querySelector('a.lib-open').dispatchEvent(meta);
    expect(ctx.router.navigate).not.toHaveBeenCalled();
    expect(meta.defaultPrevented).toBe(false);
  });

  it('Enter in the search field opens the top result; ↓ moves into the grid', async () => {
    await mountHome();
    search().onInput('glass');
    const enter = new KeyboardEvent('keydown', {key: 'Enter', cancelable: true});
    search().onKeydown(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(ctx.router.navigate).toHaveBeenCalledWith('/s/glasshouse');
    const down = new KeyboardEvent('keydown', {key: 'ArrowDown', cancelable: true});
    search().onKeydown(down);
    expect(document.activeElement.dataset.focusKey).toBe('song:glasshouse');
    search().onInput('');
    ctx.router.navigate.mockClear();
    search().onKeydown(new KeyboardEvent('keydown', {key: 'Enter', cancelable: true}));
    expect(ctx.router.navigate).not.toHaveBeenCalled();
  });

  it('no results: [Clear search], and [Add "q" as a new song →] on the desktop app', async () => {
    await mountHome({query: {q: 'zzzz'}, desktop: true});
    expect(el.textContent).toContain('No songs match “zzzz”.');
    byRole(el, 'button', COPY.addAsNew('zzzz')).click();
    expect(ctx.router.navigate).toHaveBeenCalledWith('/add?q=zzzz');
    byRole(el, 'button', COPY.clearSearch).click();
    expect(ctx.topbar.clearSearch).toHaveBeenCalled();
    expect(cardsShown()).toHaveLength(6);
  });

  it('no results on the web: the Add action needs an online paired computer (B5)', async () => {
    await mountHome({query: {q: 'zzzz'}});
    expect(byRole(el, 'button', COPY.addAsNew('zzzz'))).toBeNull();
    await view.unmount();
    store.library.devices.value = [{deviceId: 'dev1', name: 'Studio MacBook', state: 'idle', lastSeenAt: Date.now() - 20_000}];
    await mountHome({query: {q: 'zzzz'}});
    expect(byRole(el, 'button', COPY.addAsNew('zzzz'))).not.toBeNull();
    await view.unmount();
    store.library.devices.value = [{deviceId: 'dev2', name: 'PC', state: 'offline', lastSeenAt: Date.now() - 20_000}];
    await mountHome({query: {q: 'zzzz'}});
    expect(byRole(el, 'button', COPY.addAsNew('zzzz'))).toBeNull();
  });

  it('no results: the Add action appears once a paired computer comes online, and goes when it leaves', async () => {
    await mountHome({query: {q: 'zzzz'}});
    expect(byRole(el, 'button', COPY.addAsNew('zzzz'))).toBeNull();
    store.library.devices.value = [{deviceId: 'dev1', name: 'Studio MacBook', state: 'idle', lastSeenAt: Date.now() - 20_000}];
    await flush();
    expect(byRole(el, 'button', COPY.addAsNew('zzzz'))).not.toBeNull();
    store.library.devices.value = [];
    await flush();
    expect(byRole(el, 'button', COPY.addAsNew('zzzz'))).toBeNull();
  });

  it('a drill-down without a filter chip says so plainly', async () => {
    await mountHome({query: {artist: 'Nobody'}});
    expect(el.textContent).toContain(COPY.emptyArtist('Nobody'));
    expect(el.textContent).not.toContain('with this filter');
    await view.unmount();
    await mountHome({query: {album: 'Nowhere'}});
    expect(el.textContent).toContain(COPY.emptyAlbum('Nowhere'));
  });

  it('an empty filter offers [Show all]', async () => {
    await mountHome({query: {filter: 'spots', artist: 'Marisol Vega'}});
    expect(el.textContent).toContain(COPY.emptyDrill(COPY.drillArtist('Marisol Vega')));
    byRole(el, 'button', COPY.showAll).click();
    await flush();
    expect(cardsShown()).toHaveLength(6);
    await view.unmount();
    await mountHome({query: {filter: 'spots'}, songs: LIBRARY.filter(s => s.id !== 'lowtide')});
    expect(el.textContent).toContain(COPY.emptyFilter.spots);
  });

  it('loading: an 8-card skeleton, then "Still connecting… [Retry]" after 8 s', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']});
    home ??= await import('../src/library/home.js');
    store.library.loaded.value = false;
    const registry2 = createRegistry();
    ctx = {router: {navigate: vi.fn(), setQuery: vi.fn()}, topbar: {setSearch: vi.fn()}, registry: registry2, store, platform: {reducedMotion: signal(false)}, desktop: {available: false}};
    el = document.body.appendChild(document.createElement('div'));
    view = home.mount(el, {name: 'library', query: {}}, ctx);
    const body = el.querySelector('.lib-body');
    expect(body.getAttribute('aria-busy')).toBe('true');
    expect(body.querySelectorAll('.ui-skeleton-item')).toHaveLength(8);
    expect(body.textContent).not.toContain(COPY.stillConnecting);
    vi.advanceTimersByTime(7999);
    expect(body.textContent).not.toContain(COPY.stillConnecting);
    vi.advanceTimersByTime(1);
    expect(body.textContent).toContain(COPY.stillConnecting);
    expect(byRole(body, 'button', COPY.retry)).not.toBeNull();
    setSongs(LIBRARY);
    expect(body.getAttribute('aria-busy')).toBeNull();
    expect(body.textContent).not.toContain(COPY.stillConnecting);
    expect(cardsShown()).toHaveLength(6);
  });

  it('first run: no songs → the Demo card from settings.demo and the Add card', async () => {
    settingsApi.demo.mockResolvedValueOnce({token: TOKEN});
    await mountHome({songs: []});
    expect(el.querySelector('.lib-first-run')).not.toBeNull();
    expect(el.querySelector('.lib-first-demo').hidden).toBe(false);
    expect(el.querySelector('.lib-header').hidden).toBe(true);
    byRole(el, 'button', COPY.openExample).click();
    expect(ctx.router.navigate).toHaveBeenCalledWith(`/share/${TOKEN}`);
    setSongs(LIBRARY);
    await flush();
    expect(el.querySelector('.lib-first-run')).toBeNull();
    expect(cardsShown()).toHaveLength(6);
  });

  it('the "Adding" group holds jobs for songs that do not exist yet; a job card opens the Jobs popover', async () => {
    peers.items.value = [jobVM('j-new', {title: 'Harbor Lights', percent: 46, line: 'Splitting · 46%'}),
      jobVM('j-re', {songId: 'velvet', percent: 71, line: 'Splitting · 71%'})];
    await mountHome();
    expect(el.querySelector('.lib-divider').textContent).toBe(COPY.adding);
    expect(cardsShown()[0]).toBe('job:j-new');
    expect(el.querySelector('[data-key="song:velvet"]').dataset.state).toBe('resplitting');
    el.querySelector('[data-key="job:j-new"] .lib-open').click();
    expect(ctx.jobsCalls.at(-1)).toMatchObject({jobId: 'j-new'});
    // ungrouped, a Songs divider closes the Adding group; grouped, the group headers do
    const order = () => [...el.querySelectorAll('.lib-grid > *')].map(n => n.dataset.key ?? n.textContent);
    expect(order().slice(0, 3)).toEqual([COPY.adding, 'job:j-new', COPY.songsDivider]);
    view.update({name: 'library', query: {group: 'artist'}});
    await flush();
    expect(el.textContent).not.toContain(COPY.songsDivider);
  });

  it('the FLIP pairs a job with its song only within 10 s, measured at render time', async () => {
    let at = 1000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => at);
    try {
      peers.items.value = [jobVM('j-new', {title: 'Harbor Lights', percent: 90, line: 'Finishing'})];
      await mountHome();
      setRect(el.querySelector('[data-key="job:j-new"]'), {x: 0, y: 0, width: 190, height: 280});
      const animate = vi.fn();
      HTMLElement.prototype.animate = animate;
      peers.items.value = [];       // the job leaves (cancelled, say)
      await flush();
      at += 11_000;                 // well within one 30 s tick of the view's clock
      const proto = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect');
      HTMLElement.prototype.getBoundingClientRect = function () {
        return this.dataset?.key === 'song:harbor' ? {x: 600, y: 300, left: 600, top: 300, width: 190, height: 280, right: 790, bottom: 580} : {x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0};
      };
      try {
        setSongs([...LIBRARY, song('harbor', {title: 'Harbor Lights', addedAt: NOW})]);
        await flush();
      } finally {
        if (proto) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', proto);
        else delete HTMLElement.prototype.getBoundingClientRect;
      }
      expect(animate).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      delete HTMLElement.prototype.animate;
    }
  });

  it('done → the card FLIPs to its sorted position (260 ms, none under reduced motion)', async () => {
    peers.items.value = [jobVM('j-new', {title: 'Harbor Lights', percent: 90, line: 'Finishing'}),
      jobVM('j-re', {songId: 'velvet', percent: 71, line: 'Splitting · 71%'})];
    await mountHome();
    const jobCard = el.querySelector('[data-key="job:j-new"]');
    setRect(jobCard, {x: 0, y: 0, width: 190, height: 280});
    const velvet = el.querySelector('[data-key="song:velvet"]');
    let velvetRect = {x: 400, y: 600, width: 190, height: 280};
    velvet.getBoundingClientRect = () => ({...velvetRect, left: velvetRect.x, top: velvetRect.y, right: velvetRect.x + 190, bottom: velvetRect.y + 280});
    const animations = [];
    HTMLElement.prototype.animate = function animate(frames, options) { animations.push({el: this, frames, options}); return {cancel() {}}; };
    // the re-split finishes: the same card, moved
    velvetRect = {x: 400, y: 600, width: 190, height: 280};
    peers.items.value = [peers.items.peek()[0]];
    await flush();
    // the snapshot was taken at (400, 600) and the card is still there: nothing to animate
    expect(animations).toHaveLength(0);
    // the new song arrives and its job leaves: its card flies from the job card's place
    const harbor = song('harbor', {title: 'Harbor Lights', addedAt: NOW});
    const proto = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect');
    HTMLElement.prototype.getBoundingClientRect = function () {
      return this.dataset?.key === 'song:harbor' ? {x: 600, y: 300, left: 600, top: 300, width: 190, height: 280, right: 790, bottom: 580} : {x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0};
    };
    try {
      peers.items.value = [];
      setSongs([...LIBRARY, harbor]);
      await flush();
    } finally {
      if (proto) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', proto);
      else delete HTMLElement.prototype.getBoundingClientRect;
    }
    const flipped = animations.find(a => a.el.dataset.key === 'song:harbor');
    expect(flipped).toBeDefined();
    expect(flipped.frames[0].transform).toBe('translate(-600px, -300px)');
    expect(flipped.options.duration).toBe(260);
    delete HTMLElement.prototype.animate;
  });

  it('no FLIP under reduced motion', async () => {
    peers.items.value = [jobVM('j-new', {title: 'Harbor Lights', percent: 90, line: 'Finishing'})];
    await mountHome();
    ctx.platform.reducedMotion.value = true;
    const animate = vi.fn();
    HTMLElement.prototype.animate = animate;
    setRect(el.querySelector('[data-key="job:j-new"]'), {x: 0, y: 0, width: 190, height: 280});
    peers.items.value = [];
    setSongs([...LIBRARY, song('harbor', {title: 'Harbor Lights', addedAt: NOW})]);
    await flush();
    expect(animate).not.toHaveBeenCalled();
    delete HTMLElement.prototype.animate;
  });

  it('⌘V with a URL opens /add pre-filled; text inputs keep their paste', async () => {
    await mountHome();
    const paste = text => {
      const e = new Event('paste', {bubbles: true, cancelable: true});
      e.clipboardData = {getData: () => text};
      document.body.dispatchEvent(e);
      return e;
    };
    expect(paste('https://www.youtube.com/watch?v=abc').defaultPrevented).toBe(true);
    expect(ctx.router.navigate).toHaveBeenCalledWith(`/add?q=${encodeURIComponent('https://www.youtube.com/watch?v=abc')}`);
    ctx.router.navigate.mockClear();
    paste('just words');
    expect(ctx.router.navigate).not.toHaveBeenCalled();
    const input = document.body.appendChild(document.createElement('input'));
    input.focus();
    paste('https://example.com/song');
    expect(ctx.router.navigate).not.toHaveBeenCalled();
  });

  it("provides the 'library' context while mounted, and hands the search field back on unmount", async () => {
    await mountHome();
    const lib = () => registry.context().library;
    expect(lib().selecting).toBe(false);
    expect(lib().focusedSongId).toBeNull();
    el.querySelector('[data-key="song:velvet"] a.lib-open').focus();
    expect(lib().focusedSongId).toBe('velvet');
    expect(registry.run('library.editFocused')).toBe(true);
    expect(ctx.router.navigate).toHaveBeenCalledWith('/s/velvet/edit/details');
    expect(lib().layout).toBe('grid');
    registry.run('library.view');
    await flush();
    expect(el.querySelector('[role=table]')).not.toBeNull();
    await view.unmount();
    view = null;
    expect(registry.context().library).toBeFalsy();
    expect(ctx.topbar.setSearch).toHaveBeenLastCalledWith(null);
    expect(el.children).toHaveLength(0);
  });

  it('update(match) applies a new query (Back and Forward between Library entries)', async () => {
    await mountHome();
    view.update({name: 'library', query: {q: 'velvet'}});
    await flush();
    expect(cardsShown()).toEqual(['song:velvet']);
    expect(search().value).toBe('velvet');
    view.update({name: 'library', query: {}});
    await flush();
    expect(cardsShown()).toHaveLength(6);
  });

  it('?layout=list wins over prefs on mount and on update; grid clears it from the URL (VF1-3)', async () => {
    await mountHome({query: {layout: 'list'}});
    expect(el.querySelector('[role=table]')).not.toBeNull();
    expect(registry.context().library.layout).toBe('list');
    view.update({name: 'library', query: {}});
    await flush();
    expect(el.querySelector('[role=table]')).toBeNull();
    view.update({name: 'library', query: {layout: 'list', sort: 'title'}});
    await flush();
    expect(el.querySelector('[role=table]')).not.toBeNull();
    byRole(el, 'radio', COPY.grid).click();
    await flush();
    expect(el.querySelector('[role=table]')).toBeNull();
    expect(prefs.value.peek().library.layout).toBe('grid');
    expect(ctx.router.setQuery).toHaveBeenLastCalledWith(expect.objectContaining({layout: null, sort: 'title'}), {debounceMs: 400});
    registry.run('library.view');
    await flush();
    expect(ctx.router.setQuery).toHaveBeenLastCalledWith(expect.objectContaining({layout: 'list'}), {debounceMs: 400});
  });
});

// =====================================================================================================
// CONTROLS (architecture §9.0): every row renders with its role and accessible name

describe.skipIf(missingPeers.length)('CONTROLS', () => {
  async function render(context) {
    const home = await import('../src/library/home.js');
    const registry = createRegistry();
    defineLibraryCommands({registry});
    const ctx = {router: {navigate: vi.fn(), setQuery: vi.fn()}, topbar: {setSearch: vi.fn(), clearSearch: () => false}, registry, store,
      platform: {reducedMotion: signal(false)}, desktop: {available: context === 'noResults' || context === 'firstRunDesktop'}};
    let songs = LIBRARY, query = {};
    if (context === 'noResults') query = {q: 'zzzz'};
    if (context === 'emptyFilter') query = {filter: 'chart', artist: 'Marisol Vega'};
    if (context === 'firstRunDesktop' || context === 'firstRunWeb') songs = [];
    if (context === 'list') prefs.update(d => { d.library.layout = 'list'; });
    if (context === 'failed') peers.items.value = [jobVM('jf', {title: 'Paper Boats', failure: {sentence: 'Couldn’t split this song.'}, actions: [{label: 'Try again', run() {}}]})];
    if (context === 'slow') vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']});
    store.library.songs.value = new Map(songs.map(s => [s.id, s]));
    store.library.loaded.value = context !== 'slow';
    prefs.update(d => { d.library.opened = LIBRARY.map(s => s.id); });
    const el = document.body.appendChild(document.createElement('div'));
    const view = home.mount(el, {name: 'library', query}, ctx);
    if (context === 'slow') vi.advanceTimersByTime(8000);
    else await flush();
    if (context === 'grid') {
      // ⋯ appears once the card menu (LB3) exists; render one card with a menu hook for its row.
      const card = (await import('../src/library/cards.js')).SongCard(LIBRARY[0], {onMenu: () => [], onArtist() {}});
      el.append(card.el);
    }
    return {el, view};
  }

  for (const row of CONTROLS) {
    it(`${row.context}: ${row.role} "${row.name}"`, async () => {
      const {el, view} = await render(row.context);
      try {
        expect(byRole(el, row.role, row.name)).not.toBeNull();
      } finally {
        view.unmount();
      }
    });
  }
});
