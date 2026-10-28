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

const song = {id: 's', title: 'Song', duration: 40, stems: [{name: 'drums', key: 'd'}], practice: {rate: 1}};
const key = (k, extra = {}) => { const e = new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true, ...extra}); document.body.dispatchEvent(e); return e; };
beforeEach(() => {
  document.body.innerHTML = '<div id="header-song"></div><div id="player-root"></div>';
  localStorage.clear(); state.engines = []; state.part = null; song.tempo = undefined;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {get: (t, k) => t[k] ?? (() => {}), set: (t, k, v) => { t[k] = v; return true; }});
  globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
});
afterEach(() => closePlayer());

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

