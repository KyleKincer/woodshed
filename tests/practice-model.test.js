import {describe, expect, test} from 'vitest';
import {
  PRACTICE_CAP, MAX_SPOTS, MAX_MARKERS, TOMBSTONE_DAYS,
  emptyPractice, upgradePractice, mergePractice, prunePractice, summarize, sanitizeForShare, formatClock,
} from '../shared/practice.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28);
const EMPTY_LOOP = {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none'};
const spot = (id, extra = {}) => ({id, name: `Spot ${id}`, a: 10, b: 20, rate: 1, passes: 0, updatedAt: 1000, ...extra});
const marker = (id, extra = {}) => ({id, t: 5, label: `Marker ${id}`, updatedAt: 1000, ...extra});
const v2 = (extra = {}) => ({...emptyPractice(), ...extra});
const size = value => JSON.stringify(value).length;

describe('emptyPractice', () => {
  test('has the contract defaults and is a fresh object every call', () => {
    expect(emptyPractice()).toEqual({v: 2, cue: 0, rate: 1, loop: EMPTY_LOOP, tracks: [], minusMe: false, trainer: null, spots: [], markers: []});
    const a = emptyPractice(); a.loop.on = true; a.spots.push(spot('x'));
    expect(emptyPractice().loop.on).toBe(false);
    expect(emptyPractice().spots).toEqual([]);
  });

  test('the cap constants', () => {
    expect(PRACTICE_CAP).toBe(32_768);
    expect([MAX_SPOTS, MAX_MARKERS, TOMBSTONE_DAYS]).toEqual([24, 64, 30]);
  });
});

describe('upgradePractice: v1 → v2', () => {
  test('{rate, loop, tracks: []} (the 1.9 saver without stems yet)', () => {
    const out = upgradePractice({rate: 0.75, loop: {enabled: true, a: 24, b: 40}, tracks: []});
    expect(out).toEqual(v2({rate: 0.75, loop: {...EMPTY_LOOP, on: true, a: 24, b: 40}}));
  });

  test('{rate: 1} (a rate-only blob)', () => {
    expect(upgradePractice({rate: 1})).toEqual(emptyPractice());
    expect(upgradePractice({rate: 1.25})).toEqual(v2({rate: 1.25}));
  });

  test('full v1 with grid: grid is dropped, tracks kept', () => {
    const raw = {
      loop: {enabled: false, a: 12.5, b: 30.25}, rate: 0.9,
      grid: {visible: true, snap: true, division: 2},
      tracks: [
        {name: 'drums', volume: 0.5, muted: true, soloed: false},
        {name: 'bass', volume: 1, muted: false, soloed: true},
        {name: 'other', volume: 0.8, muted: false, soloed: false},
        {name: 'vocals', volume: 0, muted: false, soloed: false},
      ],
    };
    const out = upgradePractice(raw, {duration: 200});
    expect(out).toEqual(v2({
      rate: 0.9, loop: {...EMPTY_LOOP, a: 12.5, b: 30.25},
      tracks: raw.tracks,
    }));
    expect(out).not.toHaveProperty('grid');
    expect(raw.grid).toEqual({visible: true, snap: true, division: 2}); // the input is untouched
  });

  test('v: 1 is read as v1; a v1 loop shorter than the engine minimum stays off', () => {
    expect(upgradePractice({v: 1, loop: {enabled: true, a: 3, b: 3.01}}).loop).toEqual({...EMPTY_LOOP, a: 3, b: 3.01});
  });

  test('v1 values are clamped: rate to 25–150%, volumes to 0..1, reversed loops swapped', () => {
    const out = upgradePractice({rate: 3, loop: {enabled: true, a: 40, b: 24}, tracks: [{name: 'drums', volume: 4}, {name: 'bass', volume: -1}]});
    expect(out.rate).toBe(1.5);
    expect(out.loop).toEqual({...EMPTY_LOOP, on: true, a: 24, b: 40});
    expect(out.tracks).toEqual([{name: 'drums', volume: 1, muted: false, soloed: false}, {name: 'bass', volume: 0, muted: false, soloed: false}]);
    expect(upgradePractice({rate: 0.1}).rate).toBe(0.25);
    expect(upgradePractice({rate: 0}).rate).toBe(1);
  });

  test('account defaults seed eachPassCount for loops that never stored one', () => {
    const defaults = {stop: 'cue', eachPassCount: false, keepPitch: true};
    expect(upgradePractice({rate: 1}, {defaults}).loop.eachPassCount).toBe(false);
    expect(upgradePractice(null, {defaults}).loop.eachPassCount).toBe(false);
    expect(upgradePractice(v2({loop: {on: false, a: 0, b: 0}}), {defaults}).loop.eachPassCount).toBe(false);
    expect(upgradePractice(v2({loop: {...EMPTY_LOOP, eachPassCount: true}}), {defaults}).loop.eachPassCount).toBe(true);
    // keepPitch and click stay absent: they apply from the account at read time (D14)
    expect(upgradePractice({rate: 1}, {defaults})).not.toHaveProperty('keepPitch');
    expect(upgradePractice({rate: 1}, {defaults})).not.toHaveProperty('click');
  });
});

describe('upgradePractice: legacy tempo click fields (D51)', () => {
  const base = {countIn: {on: false, length: 1, unit: 'bars'}, mode: 'countin', accent: true, volume: 0.7, preRoll: false};

  test.each([
    ['countIn', {countIn: true}, {countIn: {on: true, length: 1, unit: 'bars'}}],
    ['countInLength', {countInLength: 4}, {countIn: {on: false, length: 4, unit: 'bars'}}],
    ['countInUnit', {countInUnit: 'beats'}, {countIn: {on: false, length: 1, unit: 'beats'}}],
    ['enabled', {enabled: true}, {mode: 'always'}],
    ['enabled false', {enabled: false}, {mode: 'countin'}],
    ['accent', {accent: false}, {accent: false}],
    ['volume', {volume: 0.35}, {volume: 0.35}],
    ['audiblePreRoll', {audiblePreRoll: true}, {preRoll: true}],
  ])('%s', (_, fields, expected) => {
    const tempo = {songMap: {version: 1, measures: [], pins: []}, ...fields};
    expect(upgradePractice({rate: 1}, {legacyTempo: tempo}).click).toEqual({...base, ...expected});
  });

  test('every field at once, as 1.9 saved them', () => {
    const tempo = {accent: false, volume: 0.5, countIn: true, countInLength: 2, countInUnit: 'beats', audiblePreRoll: true, enabled: true,
      songMap: {}, source: 'detected', map: [], detected: []};
    expect(upgradePractice(null, {legacyTempo: tempo}).click).toEqual({
      countIn: {on: true, length: 2, unit: 'beats'}, mode: 'always', accent: false, volume: 0.5, preRoll: true,
    });
  });

  test('legacy values are clamped like the 1.9 metronome did', () => {
    const click = upgradePractice({}, {legacyTempo: {countInLength: 40, volume: 3, countInUnit: 'quarters'}}).click;
    expect(click.countIn).toEqual({on: false, length: 16, unit: 'bars'});
    expect(click.volume).toBe(1);
    expect(upgradePractice({}, {legacyTempo: {countInLength: 0}}).click.countIn.length).toBe(1);
  });

  test('a stored click is kept and the legacy fields are ignored', () => {
    const click = {countIn: {on: true, length: 2, unit: 'bars'}, mode: 'off', lastMode: 'off', accent: true, volume: 0.6, preRoll: false};
    expect(upgradePractice(v2({click}), {legacyTempo: {enabled: true, countIn: false}}).click).toEqual(click);
  });

  test('no legacy field (2.0 tempo, or no tempo) → click absent', () => {
    expect(upgradePractice({rate: 1}, {legacyTempo: {songMap: {}}})).not.toHaveProperty('click');
    expect(upgradePractice({rate: 1}, {legacyTempo: {source: 'detected', map: [], detected: [1, 2]}})).not.toHaveProperty('click');
    expect(upgradePractice({rate: 1}, {legacyTempo: null})).not.toHaveProperty('click');
    expect(upgradePractice({rate: 1}, {legacyTempo: 'tempo'})).not.toHaveProperty('click');
    expect(upgradePractice({rate: 1})).not.toHaveProperty('click');
  });
});

describe('upgradePractice: v2 sanitising', () => {
  const full = () => ({
    v: 2, lastAt: NOW, cue: 83.2, surface: 'roadmap', anchorBar: 13, anchorTime: 80,
    rate: 0.75, lastRate: 0.85, keepPitch: false,
    loop: {on: true, a: 24, b: 40, aBar: {id: 'm12', beat: 0}, bBar: {id: 'm20', beat: 0, frac: 0}, eachPassCount: false, playTimes: 4, between: 'call'},
    tracks: [{name: 'drums', volume: 0.5, muted: true, soloed: false}],
    minusMe: true, onlyMe: true, chartAudio: 'quiet',
    click: {countIn: {on: true, length: 2, unit: 'beats'}, mode: 'always', lastMode: 'countin', accent: false, volume: 0.4, preRoll: true},
    trainer: {start: 0.7, end: 1, step: 0.05, passes: 2},
    spots: [spot('s1', {aBar: {id: 'm4', beat: 1, frac: 0.5}, note: 'watch the fill', lastAt: NOW - DAY, passes: 14})],
    markers: [marker('k1', {deleted: true})],
  });

  test('a valid blob round-trips unchanged and upgrading is idempotent', () => {
    const raw = full();
    const out = upgradePractice(raw, {duration: 240});
    expect(out).toEqual(raw);
    expect(upgradePractice(out, {duration: 240})).toEqual(out);
    expect(out).not.toBe(raw);
    expect(out.loop).not.toBe(raw.loop);
  });

  test('unknown keys are dropped at every level', () => {
    const raw = full();
    Object.assign(raw, {grid: {visible: true}, extra: 1});
    raw.loop.enabled = true; raw.tracks[0].color = 'red'; raw.spots[0].junk = 'x'; raw.markers[0].junk = 1;
    raw.click.extra = true; raw.trainer.bogus = 1; raw.loop.aBar.extra = 2;
    expect(upgradePractice(raw, {duration: 240})).toEqual(full());
  });

  test('scalars are clamped to their ranges and bad enums are dropped', () => {
    const out = upgradePractice({
      v: 2, cue: 999, surface: 'piano', rate: 9, lastRate: 0.01, anchorBar: -3.5, anchorTime: -1, keepPitch: 'yes',
      loop: {on: true, a: -5, b: 40, eachPassCount: 'no', playTimes: 3, between: 'nap'},
      minusMe: 1, onlyMe: false, chartAudio: 'max', trainer: {start: 0.1, end: 9, step: 5, passes: 0.2},
      click: {countIn: {on: 'yes', length: 99, unit: 'x'}, mode: 'loud', lastMode: 'always', accent: 1, volume: -2, preRoll: 'no'},
    }, {duration: 180});
    expect(out).toEqual(v2({
      cue: 180, rate: 1.5, lastRate: 0.25, anchorBar: 0, anchorTime: 0,
      loop: {on: true, a: 0, b: 40, eachPassCount: true, playTimes: 0, between: 'none'},
      trainer: {start: 0.25, end: 1.5, step: 1.25, passes: 1},
      click: {countIn: {on: false, length: 16, unit: 'bars'}, mode: 'countin', accent: true, volume: 0, preRoll: false},
    }));
  });

  test('without a duration, times are only kept non-negative', () => {
    expect(upgradePractice({v: 2, cue: 999}).cue).toBe(999);
    expect(upgradePractice({v: 2, cue: -4}).cue).toBe(0);
    expect(upgradePractice({v: 2, cue: 30}, {duration: 0}).cue).toBe(30);
  });

  test('tracks: at most 8, unique names, names required', () => {
    const tracks = Array.from({length: 12}, (_, i) => ({name: `t${i % 10}`, volume: 0.5, muted: false, soloed: false}));
    tracks.splice(2, 0, {volume: 1}, 'drums', {name: ''});
    const out = upgradePractice({v: 2, tracks});
    expect(out.tracks.map(t => t.name)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
  });

  test('spots and markers: bad rows dropped, duplicates collapsed, strings capped', () => {
    const out = upgradePractice({v: 2, spots: [
      spot('a', {name: 'x'.repeat(100), note: 'n'.repeat(400)}),
      spot('a', {name: 'newer', updatedAt: 2000}),
      spot('b', {a: 'x'}), spot('', {}), null, 'spot', spot('c', {a: 30, b: 30}),
      spot('d', {name: '   ', a: 50, b: 40, rate: 0.1, passes: -3}),
      spot('e', {deleted: true, a: undefined, b: undefined, note: 'gone'}),
    ], markers: [marker('m', {label: 'y'.repeat(80)}), marker('n', {t: 'x'}), marker('o', {label: ''}), marker('p', {t: -2, updatedAt: -9})]});
    expect(out.spots).toEqual([
      spot('a', {name: 'newer', updatedAt: 2000}),
      spot('d', {name: 'Spot', a: 40, b: 50, rate: 0.25, passes: 0}),
      {id: 'e', name: 'Spot e', a: 0, b: 0, rate: 1, passes: 0, updatedAt: 1000, deleted: true},
    ]);
    expect(out.markers).toEqual([marker('m', {label: 'y'.repeat(60)}), marker('o', {label: 'Marker'}), marker('p', {t: 0, updatedAt: 0})]);
    const long = upgradePractice({v: 2, spots: [spot('a', {name: 'x'.repeat(100), note: 'n'.repeat(400)})]}).spots[0];
    expect(long.name).toHaveLength(60);
    expect(long.note).toHaveLength(280);
  });

  test('reads never drop live spots or markers by count, and keep recent tombstones', () => {
    const spots = Array.from({length: 30}, (_, i) => spot(`s${i}`, {updatedAt: i}))
      .concat(Array.from({length: 30}, (_, i) => spot(`d${i}`, {updatedAt: i, deleted: true})));
    const markers = Array.from({length: 70}, (_, i) => marker(`m${i}`, {updatedAt: 100 - i}));
    const out = upgradePractice({v: 2, spots, markers});
    expect(out.spots.filter(s => !s.deleted)).toHaveLength(30);
    expect(out.spots.filter(s => s.deleted)).toHaveLength(30);
    expect(out.markers.map(m => m.id)).toEqual(markers.map(m => m.id)); // input order kept
    expect(MAX_SPOTS).toBeLessThan(30);
    expect(MAX_MARKERS).toBeLessThan(70);
  });

  test('hostile lists are bounded by a safety cap far above anything a capped blob holds', () => {
    const spots = Array.from({length: 1500}, (_, i) => spot(`s${i}`, {updatedAt: i}));
    const out = upgradePractice({v: 2, spots});
    expect(out.spots).toHaveLength(1000);
    expect(out.spots.some(s => s.id === 's1499')).toBe(true);
    expect(out.spots.some(s => s.id === 's0')).toBe(false);
    // the smallest possible stored tombstone still leaves a capped blob under the safety bound
    const tiny = {id: 'a', t: 0, label: 'M', updatedAt: 0, deleted: true};
    expect(Math.floor(PRACTICE_CAP / JSON.stringify(tiny).length)).toBeLessThan(1000);
  });

  test('with a duration, loop, spot and marker times are clamped; collapsed loops turn off, collapsed spots go', () => {
    const out = upgradePractice({
      v: 2, cue: 500, loop: {on: true, a: 150, b: 500},
      spots: [spot('in', {a: 190, b: 260}), spot('past', {a: 300, b: 400}), spot('gone', {a: 300, b: 400, deleted: true})],
      markers: [marker('m', {t: 900})],
    }, {duration: 200});
    expect(out.cue).toBe(200);
    expect(out.loop).toMatchObject({on: true, a: 150, b: 200});
    expect(out.spots).toEqual([spot('in', {a: 190, b: 200}), spot('gone', {a: 200, b: 200, deleted: true})]);
    expect(out.markers).toEqual([marker('m', {t: 200})]);
    expect(upgradePractice({v: 2, loop: {on: true, a: 400, b: 500}}, {duration: 200}).loop).toMatchObject({on: false, a: 200, b: 200});
    expect(upgradePractice({loop: {enabled: true, a: 400, b: 500}}, {duration: 200}).loop).toMatchObject({on: false, a: 200, b: 200});
  });

  test('bar refs need an id and a beat', () => {
    const out = upgradePractice({v: 2, loop: {on: true, a: 1, b: 2, aBar: {id: 'm1'}, bBar: {id: 'm2', beat: 2.7, frac: 4}}});
    expect(out.loop).not.toHaveProperty('aBar');
    expect(out.loop.bBar).toEqual({id: 'm2', beat: 2, frac: 1});
  });
});

describe('upgradePractice: garbage never throws', () => {
  test.each([
    ['null', null], ['undefined', undefined], ['number', 42], ['string', '{"v":2}'], ['array', [1, 2]],
    ['boolean', true], ['unknown version', {v: 3, rate: 0.5}], ['v as string', {v: '2', rate: 0.5}],
  ])('%s → emptyPractice', (_, raw) => {
    expect(upgradePractice(raw)).toEqual(emptyPractice());
  });

  test('wrong types inside a v2 blob fall back field by field', () => {
    const out = upgradePractice({v: 2, cue: NaN, rate: Infinity, loop: 'on', tracks: {}, spots: 'many', markers: 7, trainer: [], click: 'always', lastAt: -1});
    expect(out).toEqual(emptyPractice());
  });

  test('wrong types inside a v1 blob fall back field by field', () => {
    expect(upgradePractice({loop: [1, 2], rate: '0.5', tracks: 'drums', grid: 5})).toEqual(emptyPractice());
  });

  test('throwing getters and odd options are survived', () => {
    const hostile = {v: 2, get loop() { throw new Error('boom'); }};
    expect(upgradePractice(hostile)).toEqual(emptyPractice());
    const proxy = new Proxy({}, {get() { throw new Error('nope'); }});
    expect(upgradePractice(proxy)).toEqual(emptyPractice());
    expect(upgradePractice({rate: 1}, {duration: NaN, legacyTempo: proxy, defaults: 'x'})).toEqual(emptyPractice());
  });

  test('random values never throw and always produce a valid shape', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const pick = list => list[Math.floor(rnd() * list.length)];
    const atoms = [null, undefined, 0, -1, 1e12, NaN, Infinity, '', 'x', true, false, [], {}];
    const value = depth => depth > 2 || rnd() < 0.4 ? pick(atoms)
      : rnd() < 0.3 ? Array.from({length: Math.floor(rnd() * 4)}, () => value(depth + 1))
      : Object.fromEntries(['v', 'loop', 'a', 'b', 'on', 'enabled', 'rate', 'tracks', 'spots', 'markers', 'id', 'name', 't', 'click', 'trainer', 'cue', 'updatedAt']
        .filter(() => rnd() < 0.4).map(k => [k, k === 'v' ? pick([1, 2, undefined]) : value(depth + 1)]));
    for (let i = 0; i < 500; i++) {
      const out = upgradePractice(value(0), {duration: pick([undefined, 100]), legacyTempo: value(1)});
      expect(out.v).toBe(2);
      expect(out.rate).toBeGreaterThanOrEqual(0.25);
      expect(out.rate).toBeLessThanOrEqual(1.5);
      expect(Array.isArray(out.spots) && Array.isArray(out.markers) && Array.isArray(out.tracks)).toBe(true);
      expect(upgradePractice(out, {duration: 100})).toEqual(upgradePractice(out, {duration: 100}));
    }
  });
});

describe('mergePractice', () => {
  test('spots and markers: union by id, newest updatedAt wins', () => {
    const local = v2({spots: [spot('a', {name: 'local a', updatedAt: 5}), spot('b', {updatedAt: 1})], markers: [marker('x', {updatedAt: 1})]});
    const server = v2({spots: [spot('a', {name: 'server a', updatedAt: 3}), spot('c', {updatedAt: 2})],
      markers: [marker('x', {label: 'Verse', updatedAt: 9}), marker('y')]});
    const out = mergePractice(local, server, new Set());
    expect(out.spots).toEqual([spot('a', {name: 'local a', updatedAt: 5}), spot('b', {updatedAt: 1}), spot('c', {updatedAt: 2})]);
    expect(out.markers).toEqual([marker('x', {label: 'Verse', updatedAt: 9}), marker('y')]);
  });

  test('tombstones win ties, from either side, and newer edits beat older tombstones', () => {
    const live = spot('a', {updatedAt: 5}), dead = spot('a', {updatedAt: 5, deleted: true});
    expect(mergePractice(v2({spots: [live]}), v2({spots: [dead]}), new Set()).spots).toEqual([dead]);
    expect(mergePractice(v2({spots: [dead]}), v2({spots: [live]}), new Set()).spots).toEqual([dead]);
    const revived = spot('a', {updatedAt: 6});
    expect(mergePractice(v2({spots: [revived]}), v2({spots: [dead]}), new Set()).spots).toEqual([revived]);
    const deadMarker = marker('m', {updatedAt: 2, deleted: true});
    expect(mergePractice(v2({markers: [marker('m', {updatedAt: 2})]}), v2({markers: [deadMarker]}), new Set()).markers).toEqual([deadMarker]);
  });

  test('top-level values: local when dirty, else the server', () => {
    const local = v2({cue: 10, rate: 0.75, keepPitch: false, loop: {...EMPTY_LOOP, on: true, a: 1, b: 2}, minusMe: true});
    const server = v2({cue: 50, rate: 1.1, surface: 'stems', loop: {...EMPTY_LOOP, on: true, a: 8, b: 9}, minusMe: false, chartAudio: 'loud'});
    const out = mergePractice(local, server, new Set(['rate', 'loop']));
    expect(out.rate).toBe(0.75);
    expect(out.loop).toEqual(local.loop);
    expect(out.cue).toBe(50);
    expect(out.minusMe).toBe(false);
    expect(out.surface).toBe('stems');
    expect(out.chartAudio).toBe('loud');
    expect(out).not.toHaveProperty('keepPitch'); // not dirty: the server (which has none) wins
    expect(mergePractice(local, server, new Set(['keepPitch', 'surface']))).toMatchObject({keepPitch: false});
    expect(mergePractice(local, server, new Set(['surface']))).not.toHaveProperty('surface'); // a dirty removal stays removed
  });

  test('lastAt is the larger of the two', () => {
    expect(mergePractice(v2({lastAt: 5}), v2({lastAt: 9}), new Set(['lastAt'])).lastAt).toBe(9);
    expect(mergePractice(v2({lastAt: 12}), v2({lastAt: 9}), new Set()).lastAt).toBe(12);
    expect(mergePractice(v2(), v2({lastAt: 3}), new Set()).lastAt).toBe(3);
    expect(mergePractice(v2(), v2(), new Set())).not.toHaveProperty('lastAt');
  });

  test('no server value → a copy of local; inputs are never mutated', () => {
    const local = v2({rate: 0.8, spots: [spot('a')]});
    const out = mergePractice(local, null, new Set());
    expect(out).toEqual(local);
    expect(out).not.toBe(local);
    expect(out.spots[0]).not.toBe(local.spots[0]);
    const server = v2({spots: [spot('a', {updatedAt: 9})]});
    const before = JSON.stringify([local, server]);
    const merged = mergePractice(local, server, new Set(['rate']));
    merged.spots[0].name = 'changed';
    expect(JSON.stringify([local, server])).toBe(before);
    expect(merged.v).toBe(2);
  });
  test('a raw 1.9 server value is upgraded first: the enabled loop and a local click survive', () => {
    const rawServer = {loop: {enabled: true, a: 10, b: 20}, rate: 0.8, grid: {snap: true}, tracks: [{name: 'drums', volume: 0.5, muted: false, soloed: false}]};
    const legacyTempo = {countIn: true, countInLength: 2};
    const local = upgradePractice(rawServer, {legacyTempo, defaults: {eachPassCount: false}});
    local.cue = 12;
    const merged = mergePractice(local, rawServer, new Set(['cue']));
    expect(merged).not.toHaveProperty('grid');
    expect(merged.loop).toEqual({on: true, a: 10, b: 20, eachPassCount: false, playTimes: 0, between: 'none'});
    expect(merged.cue).toBe(12);
    expect(merged.rate).toBe(0.8);
    expect(merged.click).toEqual(local.click);
    expect(merged.click.countIn).toEqual({on: true, length: 2, unit: 'bars'});
    expect(upgradePractice(merged)).toEqual(merged);
    expect(upgradePractice(merged).loop.on).toBe(true);
  });

  test('a server click wins when not dirty; unknown local keys are dropped', () => {
    const serverClick = {countIn: {on: false, length: 1, unit: 'bars'}, mode: 'always', accent: true, volume: 0.5, preRoll: false};
    const localClick = {...serverClick, mode: 'off'};
    const local = {...v2({click: localClick}), junk: 1};
    expect(mergePractice(local, v2({click: serverClick}), new Set()).click).toEqual(serverClick);
    expect(mergePractice(local, v2({click: serverClick}), new Set(['click'])).click).toEqual(localClick);
    expect(mergePractice(local, v2(), new Set(['junk']))).not.toHaveProperty('junk');
    expect(mergePractice(v2(), 'garbage', new Set())).toEqual(v2());
  });

  test('25+ recent tombstones survive a read and still beat an older live copy (no resurrection)', () => {
    const dead = Array.from({length: 30}, (_, i) => spot(`t${i}`, {updatedAt: NOW - i * 1000, deleted: true}));
    const server = upgradePractice({v: 2, spots: dead});
    expect(server.spots).toHaveLength(30);
    const stale = v2({spots: Array.from({length: 24}, (_, i) => spot(`t${i}`, {updatedAt: NOW - DAY}))});
    const merged = mergePractice(stale, server, new Set());
    expect(merged.spots.filter(s => !s.deleted)).toEqual([]);
    expect(prunePractice(merged, PRACTICE_CAP, NOW).value.spots.filter(s => !s.deleted)).toEqual([]);
  });

  test('a union over MAX_SPOTS keeps every live spot through prune and the next read', () => {
    const L = v2({spots: Array.from({length: 20}, (_, i) => spot(`l${i}`, {updatedAt: i}))});
    const S = v2({spots: Array.from({length: 20}, (_, i) => spot(`s${i}`, {updatedAt: i}))});
    const saved = prunePractice(mergePractice(L, S, new Set()), PRACTICE_CAP, NOW).value;
    expect(saved.spots).toHaveLength(40);
    expect(upgradePractice(saved).spots).toHaveLength(40);
    expect(upgradePractice(saved)).toEqual(saved);
  });
});

describe('prunePractice', () => {
  test('under the cap: unchanged, nothing counted', () => {
    const p = v2({spots: [spot('a', {note: 'x'})], markers: [marker('m')]});
    expect(prunePractice(p, PRACTICE_CAP, NOW)).toEqual({value: p, pruned: 0});
  });

  test('tombstones older than 30 days are always dropped silently; newer ones stay', () => {
    const p = v2({
      spots: [spot('old', {deleted: true, updatedAt: NOW - 31 * DAY}), spot('new', {deleted: true, updatedAt: NOW - 29 * DAY}), spot('live', {updatedAt: 0})],
      markers: [marker('old', {deleted: true, updatedAt: NOW - 40 * DAY}), marker('live', {updatedAt: 0})],
    });
    const {value, pruned} = prunePractice(p, PRACTICE_CAP, NOW);
    expect(value.spots.map(s => s.id)).toEqual(['new', 'live']);
    expect(value.markers.map(m => m.id)).toEqual(['live']);
    expect(pruned).toBe(0);
    expect(p.spots).toHaveLength(3); // input untouched
  });

  test('a 40 KB synthetic blob ends at or under 32,768 and keeps every live spot', () => {
    const p = v2({
      tracks: Array.from({length: 8}, (_, i) => ({name: `stem${i}`, volume: 0.5, muted: false, soloed: false})),
      spots: Array.from({length: 24}, (_, i) => spot(`spot-${i}-${'x'.repeat(30)}`, {name: 'n'.repeat(60), note: 'w'.repeat(280), updatedAt: NOW - i * DAY,
        aBar: {id: 'measure-a', beat: 1, frac: 0.25}, bBar: {id: 'measure-b', beat: 2, frac: 0.5}, lastAt: NOW}))
        .concat(Array.from({length: 100}, (_, i) => spot(`dead-${i}-${'y'.repeat(30)}`, {name: 'd'.repeat(60), deleted: true, updatedAt: NOW - (i % 50) * DAY}))),
      markers: Array.from({length: 64}, (_, i) => marker(`marker-${i}-${'z'.repeat(30)}`, {label: i % 2 ? 'Marker ' + i : 'Chorus take ' + i, updatedAt: NOW - i * 1000})),
    });
    expect(size(p)).toBeGreaterThan(40_000);
    const {value, pruned} = prunePractice(p, PRACTICE_CAP, NOW);
    expect(size(value)).toBeLessThanOrEqual(PRACTICE_CAP);
    expect(value.spots.filter(s => !s.deleted).map(s => s.id)).toEqual(p.spots.filter(s => !s.deleted).map(s => s.id));
    expect(pruned).toBeGreaterThan(0);
  });

  test('order: default-label markers (oldest first), then named markers, then spot notes', () => {
    const markers = [
      marker('named-old', {label: 'Verse', updatedAt: 1}),
      marker('default-new', {label: 'Marker 2', updatedAt: 50}),
      marker('default-old', {label: 'Marker 1', updatedAt: 10}),
      marker('named-new', {label: 'Bridge', updatedAt: 60}),
    ];
    const spots = [spot('s-new', {note: 'n'.repeat(200), updatedAt: 90}), spot('s-old', {note: 'o'.repeat(200), updatedAt: 5})];
    const p = v2({markers, spots});
    const full = size(p);
    const keep = (...ids) => size(v2({markers: markers.filter(m => ids.includes(m.id)), spots}));
    const step = cap => prunePractice(p, cap, NOW);

    let r = step(full - 1);
    expect(r.value.markers.map(m => m.id)).toEqual(['named-old', 'default-new', 'named-new']);
    expect(r.pruned).toBe(1);

    r = step(keep('named-old', 'default-new', 'named-new') - 1);
    expect(r.value.markers.map(m => m.id)).toEqual(['named-old', 'named-new']);
    expect(r.pruned).toBe(2);

    r = step(keep('named-old', 'named-new') - 1);
    expect(r.value.markers.map(m => m.id)).toEqual(['named-new']);
    expect(r.pruned).toBe(3);
    expect(r.value.spots.every(s => s.note)).toBe(true);

    r = step(size(v2({spots})) - 1);
    expect(r.value.markers).toEqual([]);
    expect(r.value.spots.find(s => s.id === 's-old')).not.toHaveProperty('note');
    expect(r.value.spots.find(s => s.id === 's-new').note).toHaveLength(200);
    expect(r.pruned).toBe(5);

    r = step(size(v2({spots: spots.map(({note, ...rest}) => rest)})));
    expect(r.value.spots.map(s => s.id)).toEqual(['s-new', 's-old']);
    expect(r.value.spots.some(s => s.note)).toBe(false);
    expect(r.pruned).toBe(6);
  });

  test('recent tombstones go only after everything else, and live spots never go', () => {
    const p = v2({spots: [spot('live', {note: 'n'}), spot('dead', {deleted: true, updatedAt: NOW - DAY})], markers: [marker('m')]});
    const r = prunePractice(p, 10, NOW);
    expect(r.value.spots.map(s => s.id)).toEqual(['live']);
    expect(r.value.markers).toEqual([]);
    expect(r.pruned).toBe(2);
  });

  test('the default "now" is the wall clock', () => {
    const p = v2({spots: [spot('ancient', {deleted: true, updatedAt: 0})]});
    expect(prunePractice(p).value.spots).toEqual([]);
  });
});

describe('summarize', () => {
  const sections = [
    {label: 'Intro', t0: 0, t1: 8},
    {label: 'Chorus', t0: 24, t1: 40},
    {label: 'Chorus', name: 'Chorus 2', t0: 56, t1: 72},
  ];
  const pickupBars = [{display: null, t0: 0, t1: 1}, ...Array.from({length: 40}, (_, i) => ({display: i + 1, t0: 1 + i * 2, t1: 3 + i * 2}))];
  const loop = (a, b, on = true) => ({...EMPTY_LOOP, on, a, b});

  test.each([
    ['a section exactly', loop(24, 40), {sections}, 'Chorus loop'],
    ['a section within 10 ms', loop(24.004, 39.995), {sections}, 'Chorus loop'],
    ['a duplicate section uses its display name', loop(56, 72), {sections}, 'Chorus 2 loop'],
    ['bars when the map has them', loop(25, 41), {sections, bars: pickupBars}, 'Bars 13–20 loop'],
    ['one bar', loop(25, 27), {sections, bars: pickupBars}, 'Bar 13 loop'],
    ['a loop off the bar lines names the bars it touches', loop(25.5, 30.2), {sections, bars: pickupBars}, 'Bars 13–15 loop'],
    ['from the pickup', loop(0, 9), {sections: [], bars: pickupBars}, 'Pickup–bar 4 loop'],
    ['the pickup alone', loop(0, 1), {sections: [], bars: pickupBars}, 'Pickup loop'],
    ['times when there are no bars', loop(31.2, 41), {sections}, '0:31–0:41 loop'],
    ['before the first bar → times', loop(0, 14), {sections: [], bars: pickupBars.slice(1)}, '0:00–0:14 loop'],
    ['past the last bar → times', loop(90, 100), {sections: [], bars: pickupBars}, '1:30–1:40 loop'],
    ['ending on the last bar line still names bars', loop(79, 81), {sections: [], bars: pickupBars}, 'Bar 40 loop'],
    ['the section list itself (sectionsOf form)', loop(24, 40), sections, 'Chorus loop'],
    ['a section list with a display name', loop(56, 72), sections, 'Chorus 2 loop'],
    ['a section list that does not match → times', loop(25, 41), sections, '0:25–0:41 loop'],
    ['times on an unmapped song', loop(65, 125.9), null, '1:05–2:05 loop'],
  ])('loop label: %s', (_, l, map, label) => {
    expect(summarize(v2({loop: l}), map).loopLabel).toBe(label);
  });

  test('no loop label while the loop is off', () => {
    const out = summarize(v2({loop: loop(24, 40, false)}), {sections});
    expect(out).not.toHaveProperty('loopLabel');
  });

  test('rate, minus me, surface and the live spot count', () => {
    const p = v2({rate: 0.75, minusMe: true, surface: 'roadmap', spots: [spot('a'), spot('b', {deleted: true}), spot('c')]});
    expect(summarize(p, null)).toEqual({rate: 0.75, minusMe: true, surface: 'roadmap', spotCount: 2,
      spots: [{id: 'a', name: 'Spot a', rate: 1}, {id: 'c', name: 'Spot c', rate: 1}]});
    expect(summarize(v2(), null)).toEqual({rate: 1, minusMe: false, spotCount: 0, spots: []});
  });

  test('top 3 spots: most recently practised first, then most recently updated', () => {
    const p = v2({spots: [
      spot('never-old', {updatedAt: 1}),
      spot('practised-1', {lastAt: 100, rate: 0.85}),
      spot('never-new', {updatedAt: 50}),
      spot('practised-3', {lastAt: 300}),
      spot('gone', {lastAt: 999, deleted: true}),
      spot('practised-2', {lastAt: 200, updatedAt: 1}),
    ]});
    expect(summarize(p, null).spots.map(s => s.id)).toEqual(['practised-3', 'practised-2', 'practised-1']);
    const q = v2({spots: [spot('never-old', {updatedAt: 1}), spot('never-new', {updatedAt: 50}), spot('practised', {lastAt: 5})]});
    expect(summarize(q, null).spots.map(s => s.id)).toEqual(['practised', 'never-new', 'never-old']);
    expect(summarize(p, null).spots[2]).toEqual({id: 'practised-1', name: 'Spot practised-1', rate: 0.85});
  });

  test('formatClock floors to m:ss', () => {
    expect([formatClock(0), formatClock(59.99), formatClock(60), formatClock(3725.4), formatClock(-3), formatClock(NaN)])
      .toEqual(['0:00', '0:59', '1:00', '62:05', '0:00', '0:00']);
  });
});

describe('sanitizeForShare', () => {
  test('drops spot notes and personal history; keeps loops, spots and markers', () => {
    const p = v2({
      lastAt: NOW, rate: 0.8, minusMe: true, onlyMe: true, surface: 'chart',
      loop: {...EMPTY_LOOP, on: true, a: 24, b: 40},
      spots: [spot('a', {note: 'my note', lastAt: NOW, passes: 14, aBar: {id: 'm12', beat: 0}}), spot('gone', {deleted: true})],
      markers: [marker('m'), marker('x', {deleted: true})],
    });
    const out = sanitizeForShare(p);
    expect(out).toEqual(v2({
      rate: 0.8, minusMe: false, surface: 'chart', loop: {...EMPTY_LOOP, on: true, a: 24, b: 40},
      spots: [spot('a', {aBar: {id: 'm12', beat: 0}})],
      markers: [marker('m')],
    }));
    expect(out).not.toHaveProperty('lastAt');
    expect(out.spots[0]).not.toHaveProperty('note');
    expect(p.spots[0].note).toBe('my note'); // input untouched
    expect(p.minusMe).toBe(true);
  });

  test('a shared blob upgrades back to itself', () => {
    const out = sanitizeForShare(upgradePractice({rate: 0.9, loop: {enabled: true, a: 1, b: 5}}));
    expect(upgradePractice(out)).toEqual(out);
  });
});
