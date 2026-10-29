// src/library/library-model.js (architecture §2.16, spec §2.2–2.4): filter, sort, group, search, the New dot,
// Continue picks and the URL/prefs view state.
import {describe, expect, it} from 'vitest';
import {
  CONDITIONAL_FILTERS, FILTERS, FIRST_RUN_MIN, GROUPS, NEW_WINDOW_MS, SORTS, continuePicks, defaultSort, filterSongs, fold, groupSongs,
  addingJobsOf, isFailed, isNew, jobCounts, matches, parseSort, passesFilter, queryOf, sortSongs, sortValue, viewState,
} from '../src/library/library-model.js';

const DAY = 864e5;
const NOW = Date.UTC(2026, 9, 28, 12);
const song = (id, extra = {}) => ({id, title: id, artist: '', uploader: '', album: '', albumArtist: '', genre: '', tags: [], addedAt: NOW - DAY,
  mapSummary: {real: false, sections: []}, hasChart: false, reviewMetadata: false, practiceSummary: null, lastPracticedAt: null, ...extra});

const library = [
  song('glasshouse', {title: 'Glasshouse', artist: 'Northbound', album: 'Weather Systems', trackNumber: '3', duration: 128, hasChart: true,
    musicalKey: 'A minor', mapSummary: {real: true, bpm: 120, sections: ['Intro', 'Verse', 'Chorus', 'Bridge']}, addedAt: NOW - 2 * DAY}),
  song('lowtide', {title: 'Low Tide Static', artist: 'Northbound', album: 'Weather Systems', trackNumber: '7', duration: 92,
    mapSummary: {real: true, bpm: 104, sections: ['Verse', 'Chorus']}, practiceSummary: {rate: 0.9, minusMe: true, spotCount: 3, spots: []},
    lastPracticedAt: NOW - DAY, addedAt: NOW - 3 * DAY}),
  song('lanterns', {title: 'Paper Lanterns', artist: 'Marisol Vega', album: 'Paper Lanterns', duration: 75, musicalKey: 'E major',
    mapSummary: {real: true, bpm: 92, sections: []}, lastPracticedAt: NOW - 3 * DAY, addedAt: NOW - 5 * DAY, tags: ['pop']}),
  song('shuffle', {title: 'Sunday Shuffle', uploader: 'BluesLessonsChannel', duration: 312, genre: 'Blues', tags: ['backing track'],
    mapSummary: {real: false, bpm: 120, sections: []}, addedAt: NOW - 20 * DAY}),
  song('jam03', {title: 'untitled_jam_03.wav', duration: 148, reviewMetadata: true, addedAt: NOW - 14 * DAY}),
  song('velvet', {title: 'Velvet Arc', artist: 'Marisol Vega', album: 'Satellites', duration: 244, mapSummary: {real: true, bpm: 100, sections: []},
    addedAt: NOW - 22 * DAY, coverKey: 'covers/satellites.png'}),
];

describe('constants', () => {
  it('match the contract', () => {
    expect(FILTERS).toEqual(['chart', 'mapped', 'spots', 'review', 'processing', 'failed']);
    expect(SORTS).toEqual(['practised', 'added', 'title', 'artist', 'album', 'duration', 'bpm', 'key']);
    expect(GROUPS).toEqual(['none', 'album', 'artist']);
    expect(CONDITIONAL_FILTERS).toEqual(['processing', 'failed']);
    expect(FIRST_RUN_MIN).toBe(6);
    expect(NEW_WINDOW_MS).toBe(30 * DAY);
  });
});

describe('defaultSort', () => {
  it("is 'practised' once any song has lastPracticedAt, else 'added'", () => {
    expect(defaultSort(library)).toBe('practised');
    expect(defaultSort(library.map(s => ({...s, lastPracticedAt: null})))).toBe('added');
    expect(defaultSort(new Map(library.map(s => [s.id, s])))).toBe('practised');
    expect(defaultSort([])).toBe('added');
  });
});

describe('matches (search)', () => {
  it('finds title, uploader, artist label, album, album artist, genre, tags and section names', () => {
    const g = library[0];
    expect(matches(g, 'glass')).toBe(true);
    expect(matches(g, 'NORTHBOUND')).toBe(true);
    expect(matches(g, 'weather')).toBe(true);
    expect(matches(g, 'bridge')).toBe(true);               // a section name (mapSummary.sections)
    expect(matches(library[3], 'blueslessons')).toBe(true); // uploader
    expect(matches(library[3], 'blues')).toBe(true);        // genre
    expect(matches(library[3], 'backing')).toBe(true);      // tags
    expect(matches(song('x', {albumArtist: 'Various Artists'}), 'various')).toBe(true);
    expect(matches(g, 'zzzz')).toBe(false);
  });
  it('every term must match some field; case and accents fold', () => {
    expect(matches(library[0], 'northbound glass')).toBe(true);
    expect(matches(library[0], 'northbound velvet')).toBe(false);
    expect(matches(song('c', {title: 'Café Noir'}), 'cafe')).toBe(true);
    expect(fold('ÉCOLE')).toBe('ecole');
  });
  it('an empty query matches everything', () => {
    expect(matches(library[0], '')).toBe(true);
    expect(matches(library[0], '   ')).toBe(true);
  });
});

describe('filterSongs', () => {
  const ids = list => list.map(s => s.id);
  it('applies one filter chip', () => {
    expect(ids(filterSongs(library, {filter: 'chart'}))).toEqual(['glasshouse']);
    expect(ids(filterSongs(library, {filter: 'mapped'}))).toEqual(['glasshouse', 'lowtide', 'lanterns', 'velvet']);
    expect(ids(filterSongs(library, {filter: 'spots'}))).toEqual(['lowtide']);
    expect(ids(filterSongs(library, {filter: 'review'}))).toEqual(['jam03']);
  });
  it('processing and failed read the job view-models by song', () => {
    const jobs = new Map([['glasshouse', {id: 'j1', kind: 'separate', failure: null}], ['velvet', {id: 'j2', failure: {sentence: 'x'}}]]);
    expect(ids(filterSongs(library, {filter: 'processing', jobs}))).toEqual(['glasshouse']);
    expect(ids(filterSongs(library, {filter: 'failed', jobs}))).toEqual(['velvet']);
    expect(ids(filterSongs(library, {filter: 'failed'}))).toEqual([]);
    expect(passesFilter(library[0], 'failed', new Map([['glasshouse', {failed: true}]]))).toBe(true);
    expect(isFailed({failure: {}})).toBe(true);
    expect(isFailed({failure: null})).toBe(false);
  });
  it('drills down by artist label or album (case-folded), and combines with search', () => {
    expect(ids(filterSongs(library, {artist: 'marisol vega'}))).toEqual(['lanterns', 'velvet']);
    expect(ids(filterSongs(library, {album: 'Weather Systems'}))).toEqual(['glasshouse', 'lowtide']);
    expect(ids(filterSongs(library, {artist: 'BluesLessonsChannel'}))).toEqual(['shuffle']);
    expect(ids(filterSongs(library, {artist: 'Marisol Vega', q: 'velvet'}))).toEqual(['velvet']);
    expect(ids(filterSongs(library, {q: 'northbound', filter: 'spots'}))).toEqual(['lowtide']);
  });
  it('accepts a Map', () => {
    expect(filterSongs(new Map(library.map(s => [s.id, s])), {q: 'paper'}).map(s => s.id)).toEqual(['lanterns']);
  });
});

describe('sortSongs', () => {
  const ids = (sort, list = library) => sortSongs(list, sort).map(s => s.id);
  it('practised: most recent first, never-practised after by newest added', () => {
    expect(ids('practised')).toEqual(['lowtide', 'lanterns', 'glasshouse', 'jam03', 'shuffle', 'velvet']);
  });
  it('added: newest first', () => {
    expect(ids('added')).toEqual(['glasshouse', 'lowtide', 'lanterns', 'jam03', 'shuffle', 'velvet']);
  });
  it('title, numeric-aware and case-insensitive', () => {
    expect(ids('title')).toEqual(['glasshouse', 'lowtide', 'lanterns', 'shuffle', 'jam03', 'velvet']);
    expect(sortSongs([song('a', {title: 'Track 10'}), song('b', {title: 'track 9'})], 'title').map(s => s.id)).toEqual(['b', 'a']);
  });
  it('artist: by the artist label (uploader when no artist), then title; songs without one last', () => {
    expect(ids('artist')).toEqual(['shuffle', 'lanterns', 'velvet', 'glasshouse', 'lowtide', 'jam03']);
  });
  it('album: by album, then track number; Unknown last', () => {
    expect(ids('album')).toEqual(['lanterns', 'velvet', 'glasshouse', 'lowtide', 'shuffle', 'jam03']);   // no album: by title
  });
  it('duration ascends', () => {
    expect(ids('duration')).toEqual(['lanterns', 'lowtide', 'glasshouse', 'jam03', 'velvet', 'shuffle']);
  });
  it('BPM: mapped songs by their bar-1 tempo; songs without mapSummary.bpm (or unmapped) sort last', () => {
    expect(ids('bpm')).toEqual(['lanterns', 'velvet', 'lowtide', 'glasshouse', 'jam03', 'shuffle']);
  });
  it('key: songs without a key last', () => {
    expect(ids('key')).toEqual(['glasshouse', 'lanterns', 'lowtide', 'jam03', 'shuffle', 'velvet']);
  });
  it("'-<sort>' reverses the order but keeps missing values last", () => {
    expect(ids('-bpm')).toEqual(['glasshouse', 'lowtide', 'velvet', 'lanterns', 'jam03', 'shuffle']);
    expect(ids('-title')).toEqual(['velvet', 'jam03', 'shuffle', 'lanterns', 'lowtide', 'glasshouse']);
  });
  it('is stable for equal keys and does not mutate its input', () => {
    const same = [song('a', {title: 'X', addedAt: 1}), song('b', {title: 'X', addedAt: 1}), song('c', {title: 'X', addedAt: 1})];
    const copy = [...same];
    expect(sortSongs(same, 'title').map(s => s.id)).toEqual(['a', 'b', 'c']);
    expect(same).toEqual(copy);
  });
  it('an unknown sort falls back to added', () => {
    expect(ids('nonsense')).toEqual(ids('added'));
  });
  it('parseSort / sortValue', () => {
    expect(parseSort('-title')).toEqual({key: 'title', reverse: true});
    expect(parseSort('bpm')).toEqual({key: 'bpm', reverse: false});
    expect(parseSort('nope')).toBeNull();
    expect(parseSort(null)).toBeNull();
    expect(sortValue('album', true)).toBe('-album');
    expect(sortValue('album')).toBe('album');
  });
});

describe('groupSongs', () => {
  it("'none' is one group of everything", () => {
    const [g] = groupSongs(library, 'none');
    expect(g).toMatchObject({key: 'all', label: null, count: 6});
  });
  it('album groups in label order with Unknown album last, keeping the song order inside', () => {
    const groups = groupSongs(sortSongs(library, 'added'), 'album');
    expect(groups.map(g => g.label)).toEqual(['Paper Lanterns', 'Satellites', 'Weather Systems', 'Unknown album']);
    expect(groups[2].songs.map(s => s.id)).toEqual(['glasshouse', 'lowtide']);
    expect(groups[3]).toMatchObject({count: 2, cover: null});
    expect(groups[1].cover.id).toBe('velvet');
  });
  it('artist groups use the artist label; Unknown artist last', () => {
    const groups = groupSongs(library, 'artist');
    expect(groups.map(g => [g.label, g.count])).toEqual([['BluesLessonsChannel', 1], ['Marisol Vega', 2], ['Northbound', 2], ['Unknown artist', 1]]);
  });
  it('groups case-insensitively', () => {
    const groups = groupSongs([song('a', {album: 'Crossings'}), song('b', {album: 'crossings'})], 'album');
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Crossings');
  });
});

describe('isNew', () => {
  const fresh = song('n', {addedAt: NOW - 2 * DAY});
  it('is true for an unpractised song added in the last 30 days and not opened on this device', () => {
    expect(isNew(fresh, {now: NOW, opened: []})).toBe(true);
    expect(isNew(fresh, {now: NOW, opened: ['n']})).toBe(false);
    expect(isNew({...fresh, lastPracticedAt: NOW - DAY}, {now: NOW})).toBe(false);
    expect(isNew({...fresh, addedAt: NOW - 30 * DAY}, {now: NOW})).toBe(false);
    expect(isNew(fresh, {now: NaN})).toBe(false);
    expect(isNew(null, {now: NOW})).toBe(false);
  });
});

describe('continuePicks', () => {
  it('the most recently practised is the hero; up to three recents follow', () => {
    const many = [...library, song('a', {lastPracticedAt: NOW - 5 * DAY}), song('b', {lastPracticedAt: NOW - 6 * DAY}), song('c', {lastPracticedAt: NOW - 7 * DAY})];
    const {hero, recents} = continuePicks(many);
    expect(hero.id).toBe('lowtide');
    expect(recents.map(s => s.id)).toEqual(['lanterns', 'a', 'b']);
  });
  it('is empty when nothing was practised', () => {
    expect(continuePicks([song('x')])).toEqual({hero: null, recents: []});
  });
});

describe('viewState and queryOf', () => {
  it('the URL wins over prefs; prefs fill sort, group, filter and layout; the default sort rule applies last', () => {
    expect(viewState({}, {layout: 'list', group: 'album', sort: 'title', filter: 'chart'}, library))
      .toEqual({q: '', sort: 'title', sortExplicit: true, group: 'album', filter: 'chart', artist: null, album: null, layout: 'list'});
    expect(viewState({sort: '-bpm', group: 'artist', filter: 'review', q: 'glass', artist: 'Northbound'}, {sort: 'title', group: 'album'}, library))
      .toMatchObject({q: 'glass', sort: '-bpm', group: 'artist', filter: 'review', artist: 'Northbound'});
    expect(viewState({}, {}, library)).toMatchObject({sort: 'practised', sortExplicit: false, group: 'none', filter: null, layout: 'grid'});
    expect(viewState({}, {}, [])).toMatchObject({sort: 'added'});
  });
  it('ignores unknown values', () => {
    expect(viewState({sort: 'x', group: 'y', filter: 'z'}, {layout: 'tiles'}, [])).toMatchObject({sort: 'added', group: 'none', filter: null, layout: 'grid'});
  });
  it('the layout is read from the URL before prefs, like sort (VF1-3)', () => {
    expect(viewState({layout: 'list'}, {layout: 'grid'}, library)).toMatchObject({layout: 'list'});
    expect(viewState({layout: 'grid'}, {layout: 'list'}, library)).toMatchObject({layout: 'grid'});
    expect(viewState({layout: 'tiles'}, {layout: 'list'}, library)).toMatchObject({layout: 'list'});
    expect(viewState({}, {layout: 'list'}, library)).toMatchObject({layout: 'list'});
  });
  it('queryOf drops defaults (null removes the key) and mirrors the layout as ?layout=list (grid is null)', () => {
    expect(queryOf({q: '', sort: 'practised', sortExplicit: false, group: 'none', filter: null, artist: null, album: null, layout: 'grid'}))
      .toEqual({q: null, sort: null, group: null, filter: null, artist: null, album: null, layout: null});
    expect(queryOf({q: 'glass', sort: 'title', sortExplicit: true, group: 'album', filter: 'chart', artist: 'Northbound', album: null, layout: 'list'}))
      .toEqual({q: 'glass', sort: 'title', group: 'album', filter: 'chart', artist: 'Northbound', album: null, layout: 'list'});
    // round trip
    const state = viewState({layout: 'list', sort: 'title'}, {}, library);
    expect(viewState(queryOf(state), {}, library)).toEqual(state);
  });
});

describe('jobCounts / addingJobsOf', () => {
  const songs = new Map([['a', song('a')], ['b', song('b')], ['c', song('c')]]);
  it('counts what the Processing and Failed filters show: songs by their job, plus the new-song jobs', () => {
    const bySong = new Map([['a', {id: 'j1', songId: 'a', status: 'running', failure: null}], ['b', {id: 'j2', songId: 'b', status: 'error', failure: {sentence: 'x'}}]]);
    const items = [...bySong.values(), {id: 'j3', kind: 'separate', songId: null, status: 'queued'}, {id: 'j4', kind: 'upload', status: 'error', failure: {sentence: 'y'}}];
    expect(jobCounts({songs, bySong, items})).toEqual({processing: 2, failed: 2});
  });
  it("LB1b's found, unapplied detections (status done) are not processing", () => {
    const found = {id: 'jd', kind: 'beats', songId: 'c', status: 'done', failure: null};
    expect(jobCounts({songs, bySong: new Map(), items: [found]})).toEqual({processing: 0, failed: 0});
    // even if a model kept it in bySong, a done row is not on a card
    expect(jobCounts({songs, bySong: new Map([['c', found]]), items: [found]})).toEqual({processing: 0, failed: 0});
  });
  it('addingJobsOf: new-song kinds whose song does not exist yet, never settled ones', () => {
    const items = [{id: 'n', kind: 'separate', songId: null, status: 'running'}, {id: 'r', kind: 'separate', songId: 'a', status: 'running'},
      {id: 'b', kind: 'beats', songId: 'zz', status: 'running'}, {id: 'd', kind: 'import', songId: 'zz', status: 'done'}, null];
    expect(addingJobsOf(items, songs).map(j => j.id)).toEqual(['n']);
    expect(addingJobsOf(items, [song('a')]).map(j => j.id)).toEqual(['n']);
  });
  it('addingJobsOf puts the newest card first (spec §3.2): uploads in progress, then newest createdAt, then untimed', () => {
    const items = [
      {id: 'failed', jobId: 'jf', kind: 'separate', status: 'error', failure: {sentence: 'x'}},
      {id: 'old', jobId: 'jo', kind: 'separate', status: 'running'},
      {id: 'new', jobId: 'jn', kind: 'separate', status: 'queued'},
      {id: 'up', kind: 'upload', status: 'running'},
      {id: 'mid', kind: 'separate', status: 'running', createdAt: 150},
    ];
    const jobs = [{jobId: 'jo', createdAt: 100}, {jobId: 'jn', createdAt: 300}, {jobId: 'jf', createdAt: 50}];
    expect(addingJobsOf(items, songs, {jobs}).map(j => j.id)).toEqual(['up', 'new', 'mid', 'old', 'failed']);
    // without the raw rows only the view-model times count; the rest keep their order after them
    expect(addingJobsOf(items, songs).map(j => j.id)).toEqual(['up', 'mid', 'failed', 'old', 'new']);
  });
});

describe('album order', () => {
  it('a track without a disc number sorts as disc 1 (one scale for mixed rows)', () => {
    const rows = [song('t2', {album: 'X', discNumber: '1', trackNumber: '2'}), song('t5', {album: 'X', discNumber: '', trackNumber: '5'}),
      song('d2t1', {album: 'X', discNumber: '2', trackNumber: '1'}), song('t1', {album: 'X', trackNumber: '1'})];
    expect(sortSongs(rows, 'album').map(s => s.id)).toEqual(['t1', 't2', 't5', 'd2t1']);
  });
});
