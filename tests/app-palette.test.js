// @vitest-environment happy-dom
// src/app/palette.js: every parsing rule of §2.8 (bar, time, speed, the bare number, loop ranges and names, count,
// trainer, only/minus/mute, sections/spots/markers, `re-split` and the other title commands, song titles), ranking
// (group order, tiers, frecency, the 200-entry cap), the ⌘Enter variants, disabledReason rows, the Shared Stage
// switches, custom providers, and the overlay itself (modal, combobox/listbox roles, keys, band top sheet).
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {parse, stripComments} from '../scripts/check-css.mjs';
import * as clock from '../src/app/clock.js';
import {createRegistry} from '../src/app/commands.js';
import {openOverlays, startDispatcher} from '../src/app/dispatch.js';
import {LIVE_SETTLE_MS, resetFeedback} from '../src/app/feedback.js';
import {setPlatform} from '../src/app/keys.js';
import {
  BUILTIN_PROVIDERS, GROUPS, GROUP_LABELS, TIER, bumpFrecency, configurePalette, frecencyScore, matchTier, normalizeText,
  openPalette, paletteItems, tenths, paletteLayout, parseQuery, rankItems, recordUse, registerProvider,
} from '../src/app/palette.js';
import {FRECENCY_CAP, prefs} from '../src/app/prefs.js';
import {signal, store} from '../src/app/store.js';
import {mapStore, pickup, sectioned, unmapped} from './fixtures/maps.js';
import {installPopoverShim, keydown, restoreDomShims} from './helpers/dom.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const DAY = 86_400_000;

let reg, ran, transport, router, session, songs, offs;

function makeTransport(tracks) {
  const calls = [];
  const snap = signal({mix: {tracks}});
  const record = name => (...args) => { calls.push([name, ...args]); };
  return {
    calls, snapshot: snap,
    jump: record('jump'), loopRange: record('loopRange'), loopBars: record('loopBars'), setCountIn: record('setCountIn'),
    setSoloed: record('setSoloed'), setMuted: record('setMuted'),
  };
}

function makeSession(fixture, practice = {}) {
  return {
    id: 'gh', readOnly: false, shareToken: null, map: mapStore(fixture),
    practice: {value: signal({spots: [], markers: [], trainer: {start: 0.7, end: 1, step: 0.05, passes: 2}, ...practice})},
  };
}

const command = (id, extra = {}) => ({id, title: id, group: 'App', run: (c, args) => ran.push([id, args ?? null]), ...extra});

function registerCommands() {
  reg.registerMany([
    command('nav.goTo', {title: 'Go to bar or time…', group: 'Navigate', when: c => !!c.session}),
    command('speed.set', {title: 'Set speed…', group: 'Speed', when: c => !!c.session}),
    command('spot.open', {title: 'Open spot', group: 'Practice', when: c => !!c.session}),
    command('trainer.toggle', {title: 'Start / stop trainer', group: 'Speed', when: c => !!c.session}),
    command('mix.minusMe', {title: 'Minus me', group: 'Mix', keys: ['KeyM'], scopes: ['stage'], when: c => !!c.session}),
    command('mix.onlyMe', {title: 'Only me', group: 'Mix', keys: ['Shift+KeyM'], scopes: ['stage'], when: c => !!c.session}),
    command('song.resplit', {title: 'Re-split…', group: 'Library', disabledReason: () => 'Re-split from Woodshed for desktop.'}),
    command('stage.tapBeat', {title: 'Tap the beat…', group: 'Practice', when: c => !!c.session}),
    command('edit.map', {title: 'Edit map', group: 'Edit', when: c => !!c.session}),
    command('stage.share', {title: 'Share…', group: 'App', when: c => !!c.session}),
    command('transport.again', {title: 'Start again', group: 'Transport', keys: ['Enter'], scopes: ['stage'],
      palette: {keywords: ['repeat', 'restart', 'from the top']}}),
    command('transport.loopToggle', {title: 'Loop', group: 'Loop', keys: ['KeyL'], scopes: ['stage']}),
    command('app.hidden', {title: 'Secret thing', palette: {hidden: true}}),
    command('app.never', {title: 'Never shown', when: () => false}),
    command('nav.library', {title: 'Library', group: 'App'}),
    command('nav.settings', {title: 'Settings…', group: 'App'}),
    command('nav.settings.audio', {title: 'Settings: Audio', group: 'App'}),
    command('library.add', {title: 'Add song…', group: 'Library', keys: ['KeyN'], scopes: ['library']}),
  ]);
}

const titles = (q, opts) => paletteItems(q, {registry: reg, ...opts}).map(i => i.title);
const items = q => paletteItems(q, {registry: reg});
const find = (q, title) => items(q).find(i => i.title === title);
const run = (item, mod = false) => item.run(reg.context({source: 'palette'}), {mod});

beforeEach(() => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});
  vi.setSystemTime(NOW);
  clock.set();
  installPopoverShim();
  setPlatform('mac');
  prefs.set('palette.frecency', {});
  configurePalette();
  store.stage.value = null;
  ran = [];
  offs = [];
  reg = createRegistry();
  registerCommands();
  transport = makeTransport([
    {name: 'drums', volume: 1, muted: false, soloed: false}, {name: 'bass', volume: 1, muted: false, soloed: true},
    {name: 'vocals', volume: 1, muted: true, soloed: false}, {name: 'other', volume: 1, muted: false, soloed: false},
  ]);
  router = {navigate: vi.fn()};
  songs = signal(new Map([
    ['harbor', {id: 'harbor', title: 'Harbor Lights', artist: 'Ada Moreno', lastPracticedAt: NOW - 3 * DAY}],
    ['lighthouse', {id: 'lighthouse', title: 'Lighthouse Harbor', artist: 'Tidewater', lastPracticedAt: NOW - DAY}],
    ['hrbr', {id: 'hrbr', title: 'Hear Robbers', artist: 'X', lastPracticedAt: NOW - 10 * DAY}],
    ['velvet', {id: 'velvet', title: 'Velvet Arc', artist: 'Marisol Vega', lastPracticedAt: NOW - 2 * DAY}],
  ]));
  session = makeSession(sectioned, {
    spots: [
      {id: 'sp1', name: 'Bridge fill', a: 80, b: 84, rate: 0.75, passes: 3, updatedAt: NOW},
      {id: 'sp2', name: 'Old spot', a: 0, b: 4, rate: 1, passes: 0, updatedAt: NOW, deleted: true},
    ],
    markers: [{id: 'mk1', t: 31.2, label: 'Snare roll', updatedAt: NOW}],
  });
  offs.push(
    reg.provide('session', () => session),
    reg.provide('transport', () => transport),
    reg.provide('router', () => router),
    reg.provide('store', () => ({library: {songs}})),
  );
});

afterEach(() => {
  for (const off of offs) off();
  for (const d of document.querySelectorAll('dialog')) d.__uiClose?.();
  resetFeedback();
  configurePalette();
  setPlatform(null);
  store.stage.value = null;
  vi.useRealTimers();
  clock.reset();
  restoreDomShims();
  document.body.replaceChildren();
});

describe('text matching', () => {
  test('normalizeText folds case, accents, ellipses and dashes', () => {
    expect(normalizeText('Re-split…')).toBe('re-split');
    expect(normalizeText('  Café  Tacvba ')).toBe('cafe tacvba');
    expect(normalizeText('loop 41–48')).toBe('loop 41-48');
    expect(normalizeText('Share...')).toBe('share');
  });

  test('tiers: exact > prefix > word start > substring > fuzzy, else no match', () => {
    expect(matchTier('Re-split…', 're-split')).toBe(TIER.exact);
    expect(matchTier('Re-split…', 'resplit')).toBe(TIER.exact);
    expect(matchTier('Harbor Lights', 'harb')).toBe(TIER.prefix);
    expect(matchTier('Lighthouse Harbor', 'harb')).toBe(TIER.word);
    expect(matchTier('Tap the beat…', 'tap beat')).toBe(TIER.word);
    expect(matchTier('Neighbors', 'ghb')).toBe(TIER.substring);
    expect(matchTier('Hear Robbers', 'hrbr')).toBe(TIER.fuzzy);
    expect(matchTier('Velvet Arc', 'xyz')).toBe(null);
    expect(matchTier('Anything', '')).toBe(TIER.exact);
  });
});

describe('parseQuery', () => {
  test('bars, times and speeds', () => {
    expect(parseQuery('bar 57')).toMatchObject({bar: 57});
    expect(parseQuery('bar 57').speed).toBeUndefined();
    expect(parseQuery('b57')).toMatchObject({bar: 57});
    expect(parseQuery('57')).toMatchObject({bare: 57, bar: 57, speed: 57});
    expect(parseQuery('450')).toMatchObject({bare: 450, bar: 450});
    expect(parseQuery('450').speed).toBeUndefined();
    expect(parseQuery('1:12')).toMatchObject({time: 72});
    expect(parseQuery('0:31.5')).toMatchObject({time: 31.5});
    expect(parseQuery('75%')).toMatchObject({speed: 75, speedExplicit: true});
  });

  test('loop, count, trainer, only, minus, mute', () => {
    expect(parseQuery('loop 41-48').loop).toEqual({from: 41, to: 48, unit: 'number'});
    expect(parseQuery('loop 41 – 48').loop).toEqual({from: 41, to: 48, unit: 'number'});
    expect(parseQuery('loop 1:10-1:20').loop).toEqual({from: 70, to: 80, unit: 'time'});
    expect(parseQuery('loop chorus').loop).toEqual({name: 'chorus'});
    expect(parseQuery('count 2 bars').count).toEqual({length: 2, unit: 'bars'});
    expect(parseQuery('count 3 beats').count).toEqual({length: 3, unit: 'beats'});
    expect(parseQuery('count-in 1 bar').count).toEqual({length: 1, unit: 'bars'});
    expect(parseQuery('trainer 70 100').trainer).toEqual({start: 70, end: 100});
    expect(parseQuery('trainer 70 100 10').trainer).toEqual({start: 70, end: 100, step: 10});
    expect(parseQuery('only bass').only).toBe('bass');
    expect(parseQuery('minus').minus).toBe(true);
    expect(parseQuery('minus drums').minus).toBe('drums');
    expect(parseQuery('mute vocals').mute).toEqual({name: 'vocals', on: true});
    expect(parseQuery('unmute vocals').mute).toEqual({name: 'vocals', on: false});
  });
});

describe('In this song', () => {
  test('a bare number on a mapped song: Go to bar N first, then Speed N%', () => {
    const list = items('57');
    expect(list.slice(0, 2).map(i => [i.group, i.title])).toEqual([['song', 'Go to bar 57'], ['commands', 'Speed 57%']]);
    run(list[0]);
    expect(ran).toEqual([['nav.goTo', {t: 112}]]);
    run(list[0], true);
    expect(transport.calls).toEqual([['loopBars', 112, 1]]);
    expect(list[0].modLabel).toBe('Loop');
    run(list[1]);
    expect(ran[1]).toEqual(['speed.set', {rate: 0.57}]);
  });

  test('a bare number on an unmapped song: Speed N% first, then Go to 0:N', () => {
    session = makeSession(unmapped);
    const list = items('25');
    expect(list.slice(0, 2).map(i => [i.group, i.title])).toEqual([['commands', 'Speed 25%'], ['song', 'Go to 0:25']]);
    run(list[1]);
    expect(ran).toEqual([['nav.goTo', {t: 25}]]);
  });

  test('bar 57 / b57 offer only the bar; a missing bar is a disabled row; bare numbers ≥ 400 are bars only', () => {
    expect(titles('bar 57')).toEqual(['Go to bar 57']);
    expect(titles('b57')).toEqual(['Go to bar 57']);
    const missing = find('bar 99', 'Go to bar 99');
    expect(missing.disabled).toBe('This song has 64 bars.');
    expect(titles('450')).toEqual(['Go to bar 450']);
    expect(find('450', 'Go to bar 450').disabled).toBe('This song has 64 bars.');
    // A bare number < 400 always offers both: a missing bar is listed disabled (the bar first when mapped).
    expect(titles('99')).toEqual(['Go to bar 99', 'Speed 99%']);
    expect(find('99', 'Go to bar 99').disabled).toBe('This song has 64 bars.');
    expect(find('99', 'Speed 99%').disabled).toBeUndefined();
  });

  test('a bare number < 400 offers both rows even when one is out of range; the invalid one is disabled', () => {
    // Mapped (64 bars): 10 is a bar but not a speed; 200 is neither.
    expect(titles('10')).toEqual(['Go to bar 10', 'Speed 10%']);
    expect(find('10', 'Speed 10%').disabled).toBe('Speed goes from 25% to 150%.');
    expect(find('10', 'Go to bar 10').disabled).toBeUndefined();
    expect(titles('200')).toEqual(['Go to bar 200', 'Speed 200%']);
    expect(find('200', 'Go to bar 200').disabled).toBe('This song has 64 bars.');
    expect(find('200', 'Speed 200%').disabled).toBe('Speed goes from 25% to 150%.');
    // Unmapped (0:30): the speed first; a time past the end is disabled.
    session = makeSession(unmapped);
    expect(titles('57')).toEqual(['Speed 57%', 'Go to 0:57']);
    expect(find('57', 'Go to 0:57').disabled).toBe('This song is 0:30 long.');
    expect(find('57', 'Speed 57%').disabled).toBeUndefined();
  });

  test('times with a fraction round to tenths before formatting (12.96 s reads 0:13.0)', () => {
    expect(tenths(12.96)).toBe('0:13.0');
    expect(tenths(12.94)).toBe('0:12.9');
    expect(tenths(59.97)).toBe('1:00.0');
    expect(tenths(12)).toBe('0:12');
    session = makeSession(unmapped);
    expect(titles('0:12.96')).toEqual(['Go to 0:13.0']);
    run(find('loop 0:10.96-0:12.96', 'Loop 0:11.0–0:13.0'));
    expect(transport.calls).toEqual([['loopRange', 10.96, 12.96, {label: '0:11.0–0:13.0', snap: 'none'}]]);
  });

  test('display bar numbers skip a pickup', () => {
    session = makeSession(pickup);
    run(find('bar 1', 'Go to bar 1'));
    expect(ran).toEqual([['nav.goTo', {t: 1.5}]]);
  });

  test('1:12 goes to a time; past the end is disabled', () => {
    run(find('1:12', 'Go to 1:12'));
    expect(ran).toEqual([['nav.goTo', {t: 72}]]);
    expect(find('9:00', 'Go to 9:00').disabled).toBe('This song is 2:08 long.');
  });

  test('section names cue on Enter (nav.goTo) and loop on ⌘Enter', () => {
    const list = items('chorus').filter(i => i.group === 'song');
    expect(list.map(i => i.title)).toEqual(['Chorus', 'Chorus 2', 'Chorus 3']);
    expect(list[0].subtitle).toBe('Section · bars 17–24');
    run(list[1]);
    expect(ran).toEqual([['nav.goTo', {t: 64}]]);
    run(list[1], true);
    expect(transport.calls).toEqual([['loopRange', 64, 80, {label: 'Chorus 2', snap: 'bar'}]]);
  });

  test('spots (live only) open through spot.open; markers cue and loop to the next marker or the end', () => {
    expect(titles('old spot')).not.toContain('Old spot');
    const spot = find('bridge', 'Bridge fill');
    expect(spot).toMatchObject({group: 'song', subtitle: 'Spot · 75%', icon: 'diamond'});
    run(spot);
    expect(ran).toEqual([['spot.open', {id: 'sp1'}]]);
    const marker = find('snare', 'Snare roll');
    expect(marker.subtitle).toBe('Marker · 0:31');
    run(marker);
    expect(ran[1]).toEqual(['nav.goTo', {t: 31.2}]);
    run(marker, true);
    expect(transport.calls).toEqual([['loopRange', 31.2, 128, {label: 'Snare roll', snap: 'bar'}]]);
  });

  test('without a session there is no In this song group', () => {
    session = null;
    expect(items('57').filter(i => i.group === 'song')).toEqual([]);
    expect(items('chorus').filter(i => i.group === 'song')).toEqual([]);
  });
});

describe('Commands', () => {
  test('75 / 75% → Speed 75%; out of range is a disabled row', () => {
    run(find('75%', 'Speed 75%'));
    expect(ran).toEqual([['speed.set', {rate: 0.75}]]);
    expect(titles('75%')).toEqual(['Speed 75%']);
    expect(find('200%', 'Speed 200%').disabled).toBe('Speed goes from 25% to 150%.');
    expect(find('10', 'Speed 10%').disabled).toBe('Speed goes from 25% to 150%.');
  });

  test('loop 41-48 loops bars on a mapped song and seconds on an unmapped one', () => {
    run(find('loop 41-48', 'Loop bars 41–48'));
    expect(transport.calls).toEqual([['loopRange', 80, 96, {label: 'Bars 41–48', snap: 'bar'}]]);
    expect(find('loop 60-70', 'Loop bars 60–70').disabled).toBe('This song has 64 bars.');
    session = makeSession(unmapped);
    transport.calls.length = 0;
    run(find('loop 4-8', 'Loop 0:04–0:08'));
    expect(transport.calls).toEqual([['loopRange', 4, 8, {label: '0:04–0:08', snap: 'none'}]]);
    run(find('loop 0:10-0:12.5', 'Loop 0:10–0:12.5'));
    expect(transport.calls[1]).toEqual(['loopRange', 10, 12.5, {label: '0:10–0:12.5', snap: 'none'}]);
    expect(find('loop 20-40', 'Loop 0:20–0:40').disabled).toBe('This song is 0:30 long.');
  });

  test('loop <section> loops that section, best match first', () => {
    const list = items('loop chorus').filter(i => i.group === 'commands' && i.title.startsWith('Loop '));
    expect(list.map(i => i.title)).toEqual(['Loop Chorus', 'Loop Chorus 2', 'Loop Chorus 3']);
    run(list[2]);
    expect(transport.calls).toEqual([['loopRange', 96, 112, {label: 'Chorus 3', snap: 'bar'}]]);
  });

  test('loop <name> keeps one row per region when markers share a label, told apart by their times', () => {
    session = makeSession(unmapped, {markers: [
      {id: 'a', t: 2, label: 'Verse', updatedAt: NOW}, {id: 'b', t: 10, label: 'Verse', updatedAt: NOW},
      {id: 'c', t: 20, label: 'End', updatedAt: NOW}]});
    const list = items('loop verse').filter(i => i.title === 'Loop Verse');
    expect(list.map(i => [i.id, i.subtitle])).toEqual([['q:loop:marker:a', '0:02–0:10'], ['q:loop:marker:b', '0:10–0:20']]);
    run(list[1]);
    expect(transport.calls).toEqual([['loopRange', 10, 20, {label: 'Verse', snap: 'none'}]]);
    expect(items('loop chorus').find(i => i.title === 'Loop Chorus')).toBe(undefined);
    session = makeSession(sectioned);
    expect(find('loop chorus', 'Loop Chorus')).toMatchObject({id: 'q:loop:section:2', subtitle: 'bars 17–24'});
  });

  test('count 2 bars / beats sets the count-in; out of range is disabled', () => {
    run(find('count 2 bars', 'Count in 2 bars'));
    run(find('count 3 beats', 'Count in 3 beats'));
    expect(transport.calls).toEqual([
      ['setCountIn', {on: true, length: 2, unit: 'bars'}], ['setCountIn', {on: true, length: 3, unit: 'beats'}]]);
    expect(find('count 20 bars', 'Count in 20 bars').disabled).toBe('A count-in is 1 to 16 bars.');
  });

  test('trainer 70 100 [step] runs trainer.toggle with the configuration', () => {
    const row = find('trainer 70 100', 'Trainer 70% → 100%');
    expect(row.subtitle).toBe('+5% every 2 passes');
    run(row);
    run(find('trainer 60 90 10', 'Trainer 60% → 90%'));
    expect(ran).toEqual([
      ['trainer.toggle', {start: 0.7, end: 1, step: 0.05, passes: 2}],
      ['trainer.toggle', {start: 0.6, end: 0.9, step: 0.1, passes: 2}],
    ]);
    expect(find('trainer 100 70', 'Trainer 100% → 70%').disabled).toMatch(/goes up/);
  });

  test('only / minus / mute act on stems; only me and minus run the profile commands', () => {
    run(find('only drums', 'Only Drums'));
    expect(transport.calls).toEqual([['setSoloed', 'bass', false], ['setSoloed', 'drums', true]]);
    transport.calls.length = 0;
    run(find('minus bass', 'Mute Bass'));
    run(find('mute drums', 'Mute Drums'));
    run(find('unmute vocals', 'Unmute Vocals'));
    expect(transport.calls).toEqual([['setMuted', 'bass', true], ['setMuted', 'drums', true], ['setMuted', 'vocals', false]]);
    // `mute` never toggles: a stem already muted is a disabled Mute row (and `unmute` of an unmuted one likewise).
    expect(titles('mute vocals')).toEqual(['Mute Vocals']);
    expect(find('mute vocals', 'Mute Vocals').disabled).toBe('Vocals is already muted.');
    expect(find('unmute drums', 'Unmute Drums').disabled).toBe('Drums is not muted.');
    expect(titles('only me')[0]).toBe('Only me');
    expect(titles('minus')[0]).toBe('Minus me');
    expect(titles('only keys')).toEqual([]);
  });

  test('registry commands by title, menu label and keywords; re-split shows its disabledReason', () => {
    const resplit = find('re-split', 'Re-split…');
    expect(resplit).toMatchObject({group: 'commands', disabled: 'Re-split from Woodshed for desktop.'});
    expect(find('resplit', 'Re-split…')).toBeTruthy();
    expect(titles('tap the beat')[0]).toBe('Tap the beat…');
    expect(titles('edit map')[0]).toBe('Edit map');
    expect(titles('share')[0]).toBe('Share…');
    const again = find('restart', 'Start again');
    expect(again.keys).toBe('Enter');
    run(again);
    expect(ran).toEqual([['transport.again', null]]);
  });

  test('hidden, never-enabled and args-only commands are not listed by title', () => {
    expect(titles('secret')).toEqual([]);
    expect(titles('never')).toEqual([]);
    expect(titles('go to bar or time')).toEqual([]);
    expect(titles('set speed')).toEqual([]);
  });
});

describe('Songs and Navigation', () => {
  test('song titles rank prefix > word start > fuzzy; Enter opens the Stage, ⌘Enter Details', () => {
    const list = items('harb').filter(i => i.group === 'songs');
    expect(list.map(i => i.title)).toEqual(['Harbor Lights', 'Lighthouse Harbor', 'Hear Robbers']);
    expect(list.map(i => i.tier)).toEqual([TIER.prefix, TIER.word, TIER.fuzzy]);
    run(list[0]);
    run(list[0], true);
    expect(router.navigate.mock.calls).toEqual([['/s/harbor'], ['/s/harbor/edit/details']]);
    expect(list[0]).toMatchObject({subtitle: 'Ada Moreno', modLabel: 'Details'});
  });

  test('navigation commands sit in their own group, after the others', () => {
    const list = items('settings');
    expect(list.filter(i => i.group === 'navigation').map(i => i.title)).toEqual(['Settings…', 'Settings: Audio']);
    expect(list.filter(i => i.group === 'commands').map(i => i.title)).not.toContain('Settings…');
    const add = find('add song', 'Add song…');
    expect(add).toMatchObject({group: 'navigation', keys: 'KeyN'});
  });

  test('group order: In this song, Commands, Songs, Navigation', () => {
    reg.register(command('app.lightsOut', {title: 'Lights out', group: 'View'}));
    songs.value = new Map([...songs.peek(), ['lib', {id: 'lib', title: 'Library Song'}]]);
    session = makeSession(sectioned, {markers: [{id: 'm', t: 4, label: 'Li intro', updatedAt: NOW}]});
    const groups = [...new Set(items('li').map(i => i.group))];
    expect(groups).toEqual(['song', 'commands', 'songs', 'navigation']);
    expect(GROUPS.map(g => GROUP_LABELS[g])).toEqual(['In this song', 'Commands', 'Songs', 'Navigation']);
  });

  test('the empty query lists sections and spots, recent songs and navigation', () => {
    const list = items('');
    expect(list.filter(i => i.group === 'song').length).toBeGreaterThan(0);
    expect(list.filter(i => i.group === 'songs').map(i => i.title).slice(0, 2)).toEqual(['Lighthouse Harbor', 'Velvet Arc']);
    expect(list.some(i => i.group === 'navigation')).toBe(true);
  });

  test('a shared session, or configurePalette, turns songs and navigation off', () => {
    session = {...session, shareToken: 'a3f1'.repeat(16), readOnly: true};
    expect(items('harb').filter(i => i.group === 'songs')).toEqual([]);
    expect(items('settings').filter(i => i.group === 'navigation')).toEqual([]);
    session = {...session, shareToken: null};
    configurePalette({songs: false, navigation: false});
    expect(items('harb').filter(i => i.group === 'songs')).toEqual([]);
    expect(items('library').filter(i => i.group === 'navigation')).toEqual([]);
    expect(titles('chorus')[0]).toBe('Chorus');
  });
});

describe('ranking and frecency', () => {
  test('frecencyScore halves every 14 days', () => {
    expect(frecencyScore({n: 4, at: NOW}, NOW)).toBe(4);
    expect(frecencyScore({n: 4, at: NOW - 14 * DAY}, NOW)).toBeCloseTo(2);
    expect(frecencyScore({n: 4, at: NOW - 28 * DAY}, NOW)).toBeCloseTo(1);
    expect(frecencyScore(undefined, NOW)).toBe(0);
  });

  test('within a group and tier, the higher frecency score comes first', () => {
    const list = [{id: 'a', group: 'commands', tier: 1, title: 'A'}, {id: 'b', group: 'commands', tier: 1, title: 'B'},
      {id: 'c', group: 'commands', tier: 0, title: 'C'}, {id: 'd', group: 'song', tier: 4, title: 'D'}];
    const ranked = rankItems(list, {frecency: {b: {n: 3, at: NOW}, a: {n: 5, at: NOW - 60 * DAY}}, at: NOW});
    expect(ranked.map(i => i.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  test('a used command climbs: running records `cmd:<id>` in prefs.palette.frecency', () => {
    reg.register(command('view.focus', {title: 'Focus', group: 'View'}));
    reg.register(command('view.follow', {title: 'Follow', group: 'View'}));
    const commands = () => items('fo').filter(i => i.group === 'commands').map(i => i.title).slice(0, 2);
    expect(commands()).toEqual(['Focus', 'Follow']);
    recordUse('cmd:view.follow');
    recordUse('cmd:view.follow');
    expect(prefs.get('palette.frecency')['cmd:view.follow']).toEqual({n: 2, at: NOW});
    expect(commands()).toEqual(['Follow', 'Focus']);
  });

  test('the frecency map is capped at 200 entries, dropping the lowest scores and never the one just used', () => {
    let map = {};
    for (let i = 0; i < FRECENCY_CAP; i++) map[`cmd:x${i}`] = {n: i + 1, at: NOW - DAY};
    map = bumpFrecency(map, 'cmd:new', NOW);
    expect(Object.keys(map)).toHaveLength(FRECENCY_CAP);
    expect(map['cmd:new']).toEqual({n: 1, at: NOW});
    expect(map['cmd:x0']).toBeUndefined();           // the lowest score went
    expect(map['cmd:x199']).toBeTruthy();
    expect(bumpFrecency({a: {n: 2, at: 0}}, 'a', NOW)).toEqual({a: {n: 3, at: NOW}});
  });

  test('parsed rows are not recorded; sections, spots, songs and commands are', async () => {
    const handle = openPalette({query: '57', registry: reg});
    keydown({key: 'Enter', code: 'Enter'}, {target: handle.el.querySelector('input')});
    expect(prefs.get('palette.frecency')).toEqual({});
    const again = openPalette({query: 'harbor lights', registry: reg});
    keydown({key: 'Enter', code: 'Enter'}, {target: again.el.querySelector('input')});
    expect(Object.keys(prefs.get('palette.frecency'))).toEqual(['song:harbor']);
  });
});

describe('providers', () => {
  test('a custom provider adds rows to its group; one with a built-in id replaces it; off restores', () => {
    expect(BUILTIN_PROVIDERS).toEqual(['builtin:song', 'builtin:commands', 'builtin:songs', 'builtin:navigation']);
    const off = registerProvider({id: 'setlists', group: 'songs',
      search: q => (matchTier('Friday set', q) != null && q ? [{id: 'set:1', title: 'Friday set', run() {}}] : [])});
    const offSongs = registerProvider({id: 'builtin:songs', group: 'songs', search: () => []});
    try {
      expect(items('fri').map(i => [i.group, i.title])).toEqual([['songs', 'Friday set']]);
      expect(items('harb').filter(i => i.group === 'songs')).toEqual([]);
    } finally {
      offSongs();
      off();
    }
    expect(items('harb').filter(i => i.group === 'songs')).toHaveLength(3);
    expect(items('fri').filter(i => i.title === 'Friday set')).toEqual([]);
    expect(() => registerProvider({id: 'x', group: 'nope', search() {}})).toThrow(RangeError);
  });

  test('a provider that throws is skipped', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const off = registerProvider({id: 'broken', group: 'commands', search: () => { throw new Error('boom'); }});
    expect(titles('share')[0]).toBe('Share…');
    expect(error).toHaveBeenCalled();
    off();
    error.mockRestore();
  });
});

describe('the overlay', () => {
  const input = h => h.el.querySelector('.app-palette-input');
  const options = h => [...h.el.querySelectorAll('[role=option]')];
  const activeOption = h => h.el.querySelector(`#${input(h).getAttribute('aria-activedescendant')}`);

  test('a modal dialog with a combobox, a grouped listbox and key-caps; Esc closes and returns focus', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const stop = startDispatcher({registry: reg});
    const handle = openPalette({query: 'loop', registry: reg});
    expect(handle.el.tagName).toBe('DIALOG');
    expect(handle.el.open).toBe(true);
    expect(openOverlays().at(-1)).toMatchObject({modal: true, scope: 'palette'});
    expect(document.activeElement).toBe(input(handle));
    expect(input(handle).getAttribute('role')).toBe('combobox');
    const list = handle.el.querySelector('[role=listbox]');
    expect(input(handle).getAttribute('aria-controls')).toBe(list.id);
    const group = list.querySelector('[role=group]');
    expect(document.getElementById(group.getAttribute('aria-labelledby')).textContent).toBe('Commands');
    const loop = options(handle).find(o => o.textContent.startsWith('Loop'));
    expect(loop.querySelector('kbd').textContent).toBe('L');
    expect(activeOption(handle).getAttribute('aria-selected')).toBe('true');
    keydown({key: 'Escape', code: 'Escape'});
    expect(handle.open).toBe(false);
    expect(handle.el.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(openOverlays()).toEqual([]);
    stop();
  });

  test('arrows move the active row; Enter runs it; ⌘Enter runs the variant', () => {
    let handle = openPalette({query: 'chorus', registry: reg});
    expect(activeOption(handle).textContent).toContain('Chorus');
    keydown({key: 'ArrowDown', code: 'ArrowDown'});
    expect(activeOption(handle).querySelector('.app-palette-title').textContent).toBe('Chorus 2');
    keydown({key: 'ArrowUp', code: 'ArrowUp'});
    keydown({key: 'ArrowUp', code: 'ArrowUp'});                  // stays on the first row
    expect(activeOption(handle).querySelector('.app-palette-title').textContent).toBe('Chorus');
    keydown({key: 'Enter', code: 'Enter'});
    expect(handle.open).toBe(false);
    expect(ran).toEqual([['nav.goTo', {t: 32}]]);
    handle = openPalette({query: 'chorus', registry: reg});
    keydown({key: 'Enter', code: 'Enter', metaKey: true});
    expect(transport.calls).toEqual([['loopRange', 32, 48, {label: 'Chorus', snap: 'bar'}]]);
  });

  test('aria-expanded follows whether the listbox has rows', () => {
    const handle = openPalette({registry: reg});
    expect(input(handle).getAttribute('aria-expanded')).toBe('true');
    input(handle).value = 'zzzz';
    input(handle).dispatchEvent(new window.Event('input', {bubbles: true}));
    expect(handle.el.querySelector('[role=listbox]').hidden).toBe(true);
    expect(input(handle).getAttribute('aria-expanded')).toBe('false');
    input(handle).value = 'chorus';
    input(handle).dispatchEvent(new window.Event('input', {bubbles: true}));
    expect(input(handle).getAttribute('aria-expanded')).toBe('true');
    handle.close();
  });

  test('a result count still waiting on its throttle is dropped when the palette closes', () => {
    const handle = openPalette({registry: reg});
    const polite = () => document.querySelector('[data-live=polite]');
    input(handle).value = 'a';
    input(handle).dispatchEvent(new window.Event('input', {bubbles: true}));
    vi.advanceTimersByTime(LIVE_SETTLE_MS);
    const first = polite().textContent;
    expect(first).toMatch(/results?$/);
    input(handle).value = 'chorus 2';
    input(handle).dispatchEvent(new window.Event('input', {bubbles: true}));   // within 800 ms: waits
    keydown({key: 'Enter', code: 'Enter'});
    expect(handle.open).toBe(false);
    vi.advanceTimersByTime(2000);
    // The region is still mounted (it moved out of the palette before it closed) and says nothing stale.
    expect(polite().isConnected).toBe(true);
    expect(polite().parentElement.parentElement).toBe(document.body);
    expect(polite().textContent).toBe(first);
  });

  test('every key-cap a render makes is destroyed by the next render and on close (no matchMedia listener leak)', () => {
    const real = globalThis.matchMedia;
    let added = 0, removed = 0;
    globalThis.matchMedia = query => {
      const mql = real ? real.call(globalThis, query) : {matches: false, addEventListener() {}, removeEventListener() {}};
      return {
        get matches() { return mql.matches; },
        addEventListener: (type, fn) => { added++; mql.addEventListener?.(type, fn); },
        removeEventListener: (type, fn) => { removed++; mql.removeEventListener?.(type, fn); },
      };
    };
    try {
      const handle = openPalette({query: 'loop', registry: reg});
      for (const q of ['m', 'mi', 'minus', 'chorus', '57', 'loop chorus', '']) {
        input(handle).value = q;
        input(handle).dispatchEvent(new window.Event('input', {bubbles: true}));
        expect(added - removed).toBe(handle.el.querySelectorAll('kbd.ui-kbd').length);
      }
      expect(added).toBeGreaterThan(3);
      handle.close();
      expect(removed).toBe(added);
    } finally {
      globalThis.matchMedia = real;
    }
  });

  test('typing re-ranks; a disabled row shows its reason, is skipped as the default and does not run', () => {
    const handle = openPalette({registry: reg});
    input(handle).value = 're-split';
    input(handle).dispatchEvent(new window.Event('input', {bubbles: true}));
    const row = options(handle).find(o => o.textContent.includes('Re-split…'));
    expect(row.getAttribute('aria-disabled')).toBe('true');
    const reason = row.querySelector('.app-palette-reason');
    expect(reason.textContent).toBe('Re-split from Woodshed for desktop.');
    expect(row.getAttribute('aria-describedby')).toBe(reason.id);
    row.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
    expect(handle.open).toBe(true);
    expect(ran).toEqual([]);
    vi.advanceTimersByTime(LIVE_SETTLE_MS);   // the live region moved into the palette, so it settles first
    expect(document.querySelector('[data-live=polite]').textContent).toBe('Re-split from Woodshed for desktop.');
    input(handle).value = 'zzzz';
    input(handle).dispatchEvent(new window.Event('input', {bubbles: true}));
    expect(handle.el.querySelector('.app-palette-empty').textContent).toBe('No matches for “zzzz”');
    expect(options(handle)).toEqual([]);
    handle.close();
  });

  test('a click runs the row (⌘-click the variant); re-opening returns the open handle; ⌘K toggles it closed', () => {
    const handle = openPalette({query: 'harbor', registry: reg});
    expect(openPalette({registry: reg})).toBe(handle);
    expect(openPalette({query: 'velvet', registry: reg})).toBe(handle);
    expect(input(handle).value).toBe('velvet');
    const row = options(handle).find(o => o.textContent.includes('Velvet Arc'));
    row.dispatchEvent(new window.MouseEvent('click', {bubbles: true, metaKey: true}));
    expect(router.navigate).toHaveBeenCalledWith('/s/velvet/edit/details');
    const again = openPalette({registry: reg});
    expect(again).not.toBe(handle);
    keydown({key: 'k', code: 'KeyK', metaKey: true}, {target: input(again)});
    expect(again.open).toBe(false);
  });

  test('a backdrop click closes it', () => {
    const handle = openPalette({registry: reg});
    handle.el.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
    expect(handle.open).toBe(false);
  });

  test('band layout: a full-width top sheet in the Stage band layout and on narrow screens', () => {
    expect(paletteLayout({stageLayout: 'band', width: 1400})).toBe('band');
    expect(paletteLayout({stageLayout: 'rail', width: 1400})).toBe('center');
    expect(paletteLayout({width: 600})).toBe('band');
    expect(paletteLayout({})).toBe('center');
    store.stage.value = {songId: 'gh', layout: 'band', playing: false};
    const handle = openPalette({registry: reg});
    expect(handle.el.dataset.layout).toBe('band');
    handle.close();
    store.stage.value = {songId: 'gh', layout: 'rail', playing: false};
    const rail = openPalette({registry: reg});
    expect(rail.el.dataset.layout).toBe(window.innerWidth < 720 ? 'band' : 'center');
    rail.close();
  });

  test('a registry state change re-renders and keeps the active row', async () => {
    let enabled = true;
    reg.register(command('view.zen', {title: 'Zen mode', group: 'View', disabledReason: () => (enabled ? null : 'Needs a song.')}));
    const handle = openPalette({query: 'zen', registry: reg});
    expect(options(handle)[0].getAttribute('aria-disabled')).toBe(null);
    enabled = false;
    reg.invalidate();
    vi.advanceTimersByTime(60);
    expect(options(handle)[0].getAttribute('aria-disabled')).toBe('true');
    handle.close();
  });
});

// VF1-4: the selected row's secondary text (the subtitle and the ⌘Enter modifier hint) sits on --accent-soft,
// where --ink-3 measured 4.46:1 (paper) and 4.3:1 (night). Resolve the colours palette.css gives them on the
// selected row through every token set of tokens.css and hold them to WCAG 1.4.3's 4.5:1.
describe('selected-row contrast (WCAG 1.4.3)', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const rulesOf = file => {
    const out = [];
    const visit = items => {
      for (const it of items) {
        if (it.type !== 'rule') continue;
        if (it.prelude.startsWith('@layer') || it.prelude.startsWith('@media')) { visit(it.children); continue; }
        if (it.prelude.startsWith('@')) continue;
        const decls = new Map();
        for (const d of it.children) if (d.type === 'decl') decls.set(d.prop, d.value.trim());
        out.push({prelude: it.prelude.replace(/\s+/g, ' ').trim(), decls});
      }
    };
    visit(parse(stripComments(readFileSync(path.join(root, file), 'utf8'))));
    return out;
  };
  const tokens = rulesOf('src/styles/tokens.css');
  const palette = rulesOf('src/styles/views/app/palette.css');
  const SETS = {
    paper: [':root'],
    night: [':root', ':root[data-theme=dark]'],
    stage: [':root', ':root[data-theme=dark]', ':root[data-place=stage][data-stage-theme=dark]'],
  };
  const tokenIn = (set, name) => {
    let value;
    for (const sel of SETS[set]) for (const r of tokens) if (r.prelude === sel && r.decls.has(name)) value = r.decls.get(name);
    if (!/^#[0-9a-f]{6}$/i.test(value ?? '')) throw new Error(`${set} ${name} is not an opaque hex colour: ${value}`);
    return value;
  };
  const luminance = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const SELECTED = '.app-palette-row[aria-selected=true]';
  // The last rule scoped to the selected row that colours `cls` (a descendant selector, plain or inside :is()).
  const selectedDecl = (cls, prop) => {
    let value = null;
    for (const r of palette) {
      if (!r.decls.has(prop)) continue;
      const scoped = r.prelude.split(/,(?![^(]*\))/).map(s => s.trim()).some(s => s === (cls ? `${SELECTED} ${cls}` : SELECTED)
        || (cls && s.startsWith(`${SELECTED} :is(`) && new RegExp(`\\${cls}(?![\\w-])`).test(s)));
      if (scoped) value = r.decls.get(prop);
    }
    return value;
  };
  const varName = v => /^var\((--[\w-]+)\)$/.exec(v ?? '')?.[1];

  test('the selection background is --accent-soft', () => {
    expect(varName(selectedDecl(null, 'background'))).toBe('--accent-soft');
  });

  for (const cls of ['.app-palette-sub', '.app-palette-mod']) {
    test(`${cls} on the selected row is at least 4.5:1 in paper, night and stage`, () => {
      const token = varName(selectedDecl(cls, 'color'));
      expect(token, `${SELECTED} ${cls} has no colour of its own`).toBeTruthy();
      for (const set of Object.keys(SETS)) {
        const ratio = contrast(tokenIn(set, token), tokenIn(set, '--accent-soft'));
        expect(ratio, `${set}: ${token} on --accent-soft`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
