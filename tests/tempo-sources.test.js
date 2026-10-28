// @vitest-environment happy-dom
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
vi.mock('../src/js/tempo-import.js', async () => ({...await vi.importActual('../src/js/tempo-import.js'), importTempoFile: vi.fn()}));
import {createTempoSources} from '../src/js/tempo-sources.js';
import {SongMapStore} from '../src/js/song-map.js';
import {fraction} from '../shared/notation.ts';
import {importTempoFile} from '../src/js/tempo-import.js';

const data = (start = 1) => ({version: 1, measures: Array.from({length: 10}, (_, i) => ({id: 'bar-' + i, numerator: 4, denominator: 4, length: fraction(4), label: ''})),
  pins: [{position: fraction(0), time: start}, {position: fraction(4), time: start + 2}], tailQpm: 120});
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
let panel, map, engine, search, load, close;
const candidates = [{id: 'one', title: 'Studio', artist: 'Band', source: 'harmonix', duration: 20}, {id: 'two', title: 'Other edition', artist: 'Band', source: 'harmonix', duration: 23}];
const el = (name) => document.querySelector(`[data-ts="${name}"]`);
const choose = async (index) => { document.querySelector(`[data-choice="${index}"]`).click(); await settle(); };
beforeEach(() => {
  document.body.innerHTML = '<div id="map-strip" class="map-inspector"><div id="source-root"></div></div>';
  map = new SongMapStore(data(), 20);
  engine = {duration: 20, editPosition: 6.5, getPosition: () => 6.5};
  search = vi.fn(async () => candidates);
  load = vi.fn(async (item) => ({map: data(item.id === 'one' ? 2 : 3), warnings: []}));
  close = vi.fn();
  panel = createTempoSources({root: document.getElementById('source-root'), song: {title: 'Song', artist: 'Band', duration: 20}, songMap: map, engine, search, load, onClose: close});
  importTempoFile.mockReset();
});
afterEach(() => panel?.destroy());

test('opening searches title and artist while leaving the current map untouched', async () => {
  const before = map.serialize();
  panel.open(); await settle();
  expect(search).toHaveBeenCalledWith({query: 'Band Song', duration: 20});
  expect(map.serialize()).toEqual(before);
  expect(document.querySelectorAll('[data-choice]')).toHaveLength(3);
  expect(document.getElementById('map-strip').classList.contains('is-sourcing')).toBe(true);
  expect(document.querySelector('a[href*="enchor.us"]').href).toContain('name=Song&artist=Band');
  expect(document.querySelector('a[href*="songsterr.com"]').href).toContain('pattern=Band+Song');
});

test('Chorus results show source, charter and drum availability before audition', async () => {
  search.mockResolvedValueOnce({candidates: [{id: 'chorus-one', title: 'Born in Dissonance', artist: 'Meshuggah', source: 'chorus', charter: 'Drum Charter', hasDrums: true, duration: 276}], warnings: []});
  panel.open(); await settle();
  expect(document.querySelector('.ts-search-scope').textContent).toBe('Search Chorus Encore and Harmonix Set');
  const choice = document.querySelector('[data-choice="1"]');
  expect(choice.textContent).toContain('Chorus Encore');
  expect(choice.textContent).toContain('Chart by Drum Charter');
  expect(choice.textContent).toContain('Drum chart');
  expect(choice.textContent).toContain('4:36');
  await choose(1);
  expect(el('detail').textContent).toContain('Chorus Encore · Chart by Drum Charter');
});

test('partial provider failures remain visible and never claim a complete empty search', async () => {
  search.mockResolvedValueOnce({candidates: [], warnings: ['Chorus Encore is temporarily unavailable.']});
  panel.open(); await settle();
  const message = document.querySelector('.ts-status').textContent;
  expect(message).toContain('Search incomplete');
  expect(message).toContain('Chorus Encore is temporarily unavailable');
  expect(message).toContain('You can still import');
  expect(message).not.toContain('No matches');
  expect(el('file').disabled).toBe(false);
  search.mockResolvedValueOnce({candidates: [{id: 'one', title: 'Studio', artist: 'Band', source: 'chorus'}], warnings: ['Harmonix Set is temporarily unavailable.']});
  document.querySelector('.ts-search').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); await settle();
  expect(document.querySelector('[data-choice="1"]').textContent).toContain('Studio');
  expect(document.querySelector('.ts-status').textContent).toContain('1 possible map');
  expect(document.querySelector('.ts-status').textContent).toContain('Harmonix Set is temporarily unavailable');
});

test('align bar 1 to selected audio position, including maps shifted before zero', async () => {
  panel.open(); await settle(); await choose(1);
  el('align').click();
  expect(map.timeAt(0)).toBe(6.5);
  expect(document.getElementById('tempo-source-offset').value).toBe('4500');
  map.edit(draft=>{draft.pins[0].time+=.1;});
  el('align').click();
  expect(map.timeAt(0)).toBe(6.5);
  const input = document.getElementById('tempo-source-offset');
  input.value = '-3000'; input.dispatchEvent(new Event('change'));
  expect(map.timeAt(0)).toBe(-1);
  expect(map.data.pins.every((pin) => pin.time >= 0)).toBe(true);
  expect(map.timeAt(4)).toBe(1);
  el('align').click();
  expect(map.timeAt(0)).toBe(6.5);
});

test('keep preserves the chosen timing as a normal undoable map and preserves bar IDs', async () => {
  const original = map.serialize();
  const ids = map.data.measures.map((m) => m.id);
  panel.open(); await settle(); await choose(1);
  expect(map.data.measures.map((m) => m.id)).toEqual(ids.slice(0, map.data.measures.length));
  el('keep').click();
  expect(map.timeAt(0)).toBe(2);
  expect(panel.isOpen()).toBe(false);
  map.undo();
  expect(map.serialize()).toEqual(original);
});

test('notation guards refuse an incompatible candidate without changing the map', async () => {
  const before = map.serialize();
  map.setGuard('notation', (timeline) => { if (timeline.measures[0].numerator !== 4) throw Error('Bar 1 has drum notes that would no longer fit.'); });
  load.mockImplementation(async () => {
    const next = data(2); next.measures[0].numerator = 3; next.measures[0].length = fraction(3);
    return {map: next, warnings: []};
  });
  panel.open(); await settle(); await choose(1);
  expect(map.serialize()).toEqual(before);
  expect(document.querySelector('.ts-status').textContent).toMatch(/Bar 1 has drum notes/);
  expect(el('current').textContent).toBe('Your map');
});

test('late load and search responses cannot mutate a closed panel or a later choice', async () => {
  let resolveLoad;
  load.mockImplementationOnce(() => new Promise((resolve) => { resolveLoad = resolve; }));
  const original = map.serialize();
  panel.open(); await settle();
  document.querySelector('[data-choice="1"]').click();
  el('cancel').click();
  resolveLoad({map: data(8), warnings: []}); await settle();
  expect(map.serialize()).toEqual(original);
  panel.open(); await settle();
  let resolveOld;
  load.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  document.querySelector('[data-choice="1"]').click();
  await choose(2);
  resolveOld({map: data(8), warnings: []}); await settle();
  expect(map.timeAt(0)).toBe(3);
});

test('a failed search keeps local import available; input keys never reach player bindings', async () => {
  search.mockRejectedValueOnce(Error('Network unavailable'));
  panel.open(); await settle();
  expect(document.querySelector('.ts-status').textContent).toMatch(/You can still import a file/);
  expect(el('file').disabled).toBe(false);
  const leaked = vi.fn(); document.body.addEventListener('keydown', leaked);
  document.querySelector('[name=query]').dispatchEvent(new KeyboardEvent('keydown', {key: 'M', bubbles: true}));
  document.getElementById('tempo-source-offset').dispatchEvent(new KeyboardEvent('keydown', {key: '1', bubbles: true}));
  expect(leaked).not.toHaveBeenCalled();
  document.body.removeEventListener('keydown', leaked);
});

test('file import exposes drum notation explicitly and failures leave the audition open', async () => {
  panel.destroy();
  const importDrums = vi.fn().mockRejectedValueOnce(Error('Existing transcription must be kept.')).mockResolvedValueOnce(undefined);
  panel = createTempoSources({root: document.getElementById('source-root'), song: {title: 'Song'}, songMap: map, engine, search, load, onImportDrums: importDrums});
  const drums = {hits: [{q: 0, midi: 36, durationQ: .25, velocity: .8}], source: 'midi', warnings: []};
  importTempoFile.mockResolvedValueOnce({map: data(2), format: 'midi', warnings: ['Check the MIDI recording version.'], drums});
  panel.open(); await settle();
  const file = new File(['midi'], 'song.mid');
  const fileInput = document.querySelector('[type=file]');
  Object.defineProperty(fileInput, 'files', {configurable: true, value: [file]});
  fileInput.dispatchEvent(new Event('change')); await settle();
  expect(el('drums').hidden).toBe(false);
  expect(el('detail').textContent).toMatch(/1 drum hit available/);
  document.querySelector('[data-shift="100"]').click();
  el('drums').click(); await settle();
  expect(importDrums.mock.calls[0][0].map.pins[0].time).toBeCloseTo(2.1);
  expect(importDrums.mock.calls[0][0].drums).toEqual(drums);
  expect(panel.isOpen()).toBe(true);
  expect(document.querySelector('.ts-status').textContent).toMatch(/Existing transcription/);
  el('drums').click(); await settle();
  expect(panel.isOpen()).toBe(false);
  expect(map.timeAt(0)).toBeCloseTo(2.1);
});

test('Guitar Pro files are selectable and use the same alignment and optional drum-import flow', async () => {
  panel.destroy();
  const importDrums = vi.fn(async () => {});
  panel = createTempoSources({root: document.getElementById('source-root'), song: {title: 'Song'}, songMap: map, engine, search, load, onImportDrums: importDrums});
  const fileInput = document.querySelector('[type=file]');
  expect(fileInput.accept.split(',')).toEqual(expect.arrayContaining(['.gp3', '.gp4', '.gp5', '.gpx', '.gp']));
  expect(document.querySelector('.ts-import').textContent).toContain('Guitar Pro');
  expect(document.querySelector('.ts-elsewhere').textContent).not.toContain('exported as MIDI first');
  const drums = {hits: [{q: 0, midi: 38, durationQ: .25, velocity: .8}], source: 'guitar-pro', warnings: []};
  importTempoFile.mockResolvedValueOnce({map: data(2), format: 'guitar-pro', warnings: ['Timing follows score playback and repeats. Check alignment with the recording.'], drums});
  panel.open(); await settle();
  const file = new File(['guitar-pro'], 'song.gp5');
  Object.defineProperty(fileInput, 'files', {configurable: true, value: [file]});
  fileInput.dispatchEvent(new Event('change')); await settle();
  expect(importTempoFile).toHaveBeenCalledWith(file, {duration: 20});
  expect(el('current').textContent).toBe('song.gp5');
  expect(el('warning').textContent).toContain('score playback and repeats');
  expect(el('drums').hidden).toBe(false);
  document.querySelector('[data-shift="100"]').click();
  el('drums').click(); await settle();
  expect(importDrums.mock.calls[0][0].map.pins[0].time).toBeCloseTo(2.1);
  expect(importDrums.mock.calls[0][0].drums).toEqual(drums);
  expect(panel.isOpen()).toBe(false);
});

test('drum import preview explains skipped notes before applying and disables empty drafts', async () => {
  panel.destroy();
  const previewDrums = vi.fn(() => ({importedCount: 0, skippedCount: 2, warnings: ['Two unsupported percussion notes were skipped.']}));
  panel = createTempoSources({root: document.getElementById('source-root'), song: {title: 'Song'}, songMap: map, engine, search, load, onImportDrums: vi.fn(), previewDrums});
  const drums = {hits: [{q: 0, midi: 1, durationQ: .25, velocity: .8}, {q: 1, midi: 2, durationQ: .25, velocity: .8}], source: 'midi', warnings: ['Source drum velocities were approximate.']};
  importTempoFile.mockResolvedValueOnce({map: data(2), format: 'midi', warnings: [], drums});
  panel.open(); await settle();
  const input = document.querySelector('[type=file]');
  Object.defineProperty(input, 'files', {configurable: true, value: [new File(['x'], 'song.mid')]});
  input.dispatchEvent(new Event('change')); await settle();
  expect(previewDrums).toHaveBeenCalled();
  expect(el('detail').textContent).toMatch(/0 drum hits ready to import · 2 skipped/);
  expect(el('warning').textContent).toMatch(/Source drum velocities were approximate/);
  expect(el('warning').textContent).toMatch(/Two unsupported percussion notes/);
  expect(el('drums').disabled).toBe(true);
});

test('audition uses the player callback without changing the map or stealing Space from inputs', async () => {
  panel.destroy();
  const play = vi.fn(async () => {});
  panel = createTempoSources({root: document.getElementById('source-root'), song: {title: 'Song'}, songMap: map, engine, search, load, play});
  const before = map.serialize();
  panel.open(); await settle();
  expect(el('play').hidden).toBe(false);
  el('play').click(); await settle();
  expect(play).toHaveBeenCalledTimes(1);
  document.querySelector('[name=query]').dispatchEvent(new KeyboardEvent('keydown', {key: ' ', bubbles: true}));
  expect(play).toHaveBeenCalledTimes(1);
  el('detail').dispatchEvent(new KeyboardEvent('keydown', {key: ' ', bubbles: true, cancelable: true}));
  expect(play).toHaveBeenCalledTimes(2);
  expect(map.serialize()).toEqual(before);
});
