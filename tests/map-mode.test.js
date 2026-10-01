// @vitest-environment happy-dom
import {beforeEach, afterEach, expect, test, vi} from 'vitest';
const state = vi.hoisted(() => ({engines: [], part: null}));
vi.mock('../src/js/backend.js', () => ({onSong: vi.fn(() => () => {}), signKeys: vi.fn(async () => ({d: 'test.wav'})), savePractice: vi.fn(async () => {}), saveTempo: vi.fn(async () => {}),
  getNotation: vi.fn(async () => state.part), getSharedNotation: vi.fn(async () => null)}));
vi.mock('../src/js/waveform.js', () => ({computePeaksRange: () => [], drawWaveform: () => {}}));
vi.mock('../src/js/engine.js', () => ({MultitrackEngine: class {
  rate = 1; preservePitch = true; duration = 40; playing = false; paused = false; loop = {enabled: false, a: 0, b: 40}; revision = 0; editPosition = 0; pos = 0;
  tracks = [{name: 'drums', color: '#aaa', volume: 1, muted: false, soloed: false}];
  ctx = {currentTime: 0, createGain: () => ({gain: {}, connect() {}, disconnect() {}}), destination: {}};
  constructor() { state.engines.push(this); }
  async loadStems() { return {duration: 40, tracks: this.tracks}; }
  getPosition = () => this.pos; getPositionAt = () => this.pos; tickEnd = () => {}; destroy = vi.fn();
  seek(t) { this.pos = t; this.editPosition = t; }
  play = vi.fn(async () => { this.playing = true; }); pause = vi.fn(() => { this.playing = false; }); stop = vi.fn(() => { this.playing = false; });
  setSpeed() {} setPreservePitch() {} setLoop(enabled, a, b) { this.loop = {enabled, a, b}; }
  setVolume() {} toggleMute() {} toggleSolo() {} beatsBetween() { return []; }
}}));
import {openPlayer, closePlayer} from '../src/js/player.js';
import {fraction} from '../shared/notation.ts';

const song = {id: 's', title: 'Song', duration: 40, stems: [{name: 'drums', key: 'd'}], practice: {rate: 1}};
const key = (k, extra = {}) => { const e = new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true, ...extra}); document.body.dispatchEvent(e); return e; };
const note = () => document.getElementById('map-note').textContent;
const cell = (name) => document.querySelector(`[data-cell="${name}"]`).textContent;
beforeEach(() => {
  document.body.innerHTML = '<div id="header-song"></div><div id="player-root"></div>';
  localStorage.clear(); state.engines = []; state.part = null; song.tempo = undefined;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {get: (t, k) => t[k] ?? (() => {}), set: (t, k, v) => { t[k] = v; return true; }});
  globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
});
afterEach(() => closePlayer());

test('Shift+M maps with the keyboard: pin, renumber, meter, undo, and Esc restores the click', async () => {
  const backend = await import('../src/js/backend.js');
  await openPlayer(song); const engine = state.engines[0];
  expect(key('M', {shiftKey: true}).defaultPrevented).toBe(true);
  expect(document.getElementById('map-strip').hidden).toBe(false);
  expect(document.querySelector('.map-lane').hidden).toBe(false);
  expect(note()).toMatch(/New map: stop on the first downbeat and press D/);
  expect(document.querySelector('[data-map="pin"]').textContent).toMatch(/Pin here/);
  expect(document.getElementById('metro-btn').classList.contains('on')).toBe(true);
  engine.seek(1); key('d');
  expect(note()).toMatch(/Pinned bar 1 at 0:01\.000/);
  engine.seek(31.3); key('d');                 // default 120 BPM guesses bar 16
  expect(note()).toMatch(/Pinned bar 16 .* 118\.81 BPM/);
  key('ArrowLeft', {altKey: true});            // it was really bar 15
  expect(note()).toMatch(/bar 16 is now bar 15 · 110\.89 BPM/);
  key('9'); key('Enter');
  expect(cell('bar')).toBe('9');
  key('ArrowDown', {shiftKey: true});          // a single 3/4 bar
  expect(note()).toMatch(/Bar 9 is 3\/4 for this bar · pinned bar lines stayed put/); // only downbeats are pinned
  expect(cell('meter')).toBe('3/4');
  key('z', {metaKey: true});
  expect(note()).toBe('Undone.');
  key('Escape');
  expect(document.getElementById('map-strip').hidden).toBe(true);
  expect(document.getElementById('metro-btn').classList.contains('on')).toBe(false);
  closePlayer();
  const saved = backend.saveTempo.mock.lastCall[1];
  expect(saved.songMap.pins.map(p => p.time)).toEqual([1, 31.3]);
  expect(saved.songMap.pins[1].position).toEqual(fraction(56));
  expect(saved.detected[0]).toEqual({time: 1, downbeat: true});
});

test('arrows walk bars and beats, digits jump, and keys do not leak to the player while mapping', async () => {
  await openPlayer(song); const engine = state.engines[0];
  key('M', {shiftKey: true});
  key('ArrowRight'); expect(engine.pos).toBeCloseTo(2);
  key('ArrowRight', {shiftKey: true}); expect(engine.pos).toBeCloseTo(2.5);
  key('ArrowLeft'); expect(engine.pos).toBeCloseTo(2);
  key('1'); key('2'); key('Enter'); expect(engine.pos).toBeCloseTo(22);
  expect(engine.play).not.toHaveBeenCalled();  // Enter went to the bar jump, not pause/resume
  const mute = document.querySelector('.tbtn.mute');
  key('1'); key('Escape');                     // digits are a bar number here, never a stem mute
  expect(mute.classList.contains('on')).toBe(false);
});

test('untouched legacy maps save unchanged; edits save a song map with exact decimal tempo', async () => {
  const backend = await import('../src/js/backend.js');
  song.tempo = {map: [{t: 0.5, bpm: 97, beatsPerBar: 4, unit: 4}], countIn: false};
  await openPlayer(song);
  document.getElementById('m-countin').click();
  closePlayer();
  expect(backend.saveTempo.mock.lastCall[1]).toMatchObject({map: [{t: 0.5, bpm: 97, beatsPerBar: 4, unit: 4}], countIn: true});
  expect(backend.saveTempo.mock.lastCall[1].songMap).toBeUndefined();
  await openPlayer(song); const engine = state.engines.at(-1);
  key('M', {shiftKey: true}); engine.seek(20.4); key('d');
  closePlayer();
  const map = backend.saveTempo.mock.lastCall[1].songMap;
  expect(map.pins.at(-1).time).toBe(20.4);
  expect(document.getElementById('player-root').textContent).not.toMatch(/NaN/);
});

test('an existing drum part becomes the song map and protects its notes from meter changes', async () => {
  const timeline = {version: 1, measures: Array.from({length: 20}, (_, i) => ({id: 'm' + i, numerator: 4, denominator: 4, length: fraction(4), label: ''})),
    anchors: [{position: fraction(0), time: 0.25}, {position: fraction(4), time: 2.25}]};
  const hit = {id: 'h', offset: fraction(3), duration: fraction(1), instrument: 'snare', voice: 1, value: 4, dotted: false, tuplet: 1, accent: false, ghost: false, flam: false, sticking: '', velocity: .75};
  state.part = {score: {version: 1, title: 'Drums', timeline, bars: [{measureId: 'm0', coverage: 'progress', hits: [hit]}]}, revision: 3};
  await openPlayer(song);
  await new Promise(resolve => setTimeout(resolve, 0));
  key('M', {shiftKey: true});
  key('Home');
  expect(cell('pin')).toMatch(/0:00\.250/); // the part's own downbeat
  key('ArrowDown', {shiftKey: true});
  expect(note()).toMatch(/Bar 1 has drum notes that would no longer fit/);
  key('ArrowRight'); key('ArrowDown', {shiftKey: true});
  expect(note()).toMatch(/Bar 2 is 3\/4/);
});

test('the key sheet and menu open from the keyboard without swallowing map keys', async () => {
  await openPlayer(song); const engine = state.engines[0];
  key('M', {shiftKey: true});
  key('?');
  expect(document.querySelector('.mi-keys').hidden).toBe(false);
  expect(document.querySelector('.mi-keys').textContent).toMatch(/Wrong bar number\? Move the pin/);
  key('ArrowRight');                         // still reaches map mode with the sheet open
  expect(engine.pos).toBeCloseTo(2);
  key('Escape');
  expect(document.querySelector('.mi-keys').hidden).toBe(true);
  expect(document.getElementById('map-strip').hidden).toBe(false);
  document.querySelector('[data-map="more"]').click();
  const menu = document.querySelector('.mi-menu');
  expect(menu.hidden).toBe(false);
  expect(menu.querySelector('[data-map="ramp"]').disabled).toBe(true);   // no span between two pins yet
  expect(menu.querySelector('[data-map="snap"]').getAttribute('aria-checked')).toBe('true');
  key('Escape');
  expect(menu.hidden).toBe(true);
});

test('E edits the bar in place: meter, groups and scope, Esc cancels', async () => {
  await openPlayer(song);
  key('M', {shiftKey: true}); key('3'); key('Enter'); key('e');
  const panel = document.getElementById('map-strip'), form = panel.querySelector('.map-editor');
  expect(panel.classList.contains('is-editing')).toBe(true);
  expect(document.activeElement).toBe(form.n);
  form.n.value = '7'; form.d.value = '8'; form.grouping.value = '2+2+3'; form.querySelector('[name=scope][value=bar]').checked = true;
  form.querySelector('[type=submit]').click();
  expect(panel.classList.contains('is-editing')).toBe(false);
  expect(cell('meter')).toBe('7/8');
  expect(cell('meter-sub')).toBe('2+2+3');
  key('ArrowRight');
  expect(cell('meter')).toBe('4/4');          // only bar 3 changed
  key('e'); form.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  expect(panel.classList.contains('is-editing')).toBe(false);
  key('e'); form.n.value = '5'; form.grouping.value = '2+2'; form.querySelector('[type=submit]').click();
  expect(note()).toMatch(/Groups must add up to 5/);
});

test('on a map tapped on every beat, 4/4 → 3/4 re-bars without moving a single beat', async () => {
  // Every beat pinned at 0.5 s steps, the way a tap-along pass leaves the map.
  song.tempo = {source: 'detected', detected: Array.from({length: 60}, (_, i) => ({time: 0.5 + i * 0.5, downbeat: i % 4 === 0}))};
  await openPlayer(song);
  key('M', {shiftKey: true}); key('3'); key('Enter');
  const before = document.querySelector('[data-cell="pin"]').textContent;
  key('ArrowDown', {shiftKey: true});
  expect(note()).toMatch(/Bar 3 is 3\/4 for this bar · beats stayed put, later bar lines moved/);
  expect(cell('meter')).toBe('3/4');
  expect(document.querySelector('[data-cell="pin"]').textContent).toBe(before);
  key('ArrowRight');                          // bar 4 now starts on what was bar 3 beat 4
  expect(cell('pin')).toMatch(/0:06\.000/);
  key('e');
  expect(document.querySelector('input[name="keep"][value="beats"]').checked).toBe(true);
});
