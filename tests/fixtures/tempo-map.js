// A synthetic, unclicked drum performance: 8 bars of 4/4 accelerating from
// 96 to 112 BPM, one bar of 7/8, then 12 bars at 112 BPM.
import {openPlayer} from '../../src/js/player.js';
import {initializeInteractions} from '../../src/js/interactions.js';
import {MultitrackEngine} from '../../src/js/engine.js';
import {SongMapStore} from '../../src/js/song-map.js';
const subscribe = SongMapStore.prototype.subscribe;
SongMapStore.prototype.subscribe = function (...args) { window.fixtureMap ??= this; return subscribe.apply(this, args); };
const load = MultitrackEngine.prototype.loadStems;
MultitrackEngine.prototype.loadStems = function (...args) { window.fixtureEngine = this; return load.apply(this, args); };
initializeInteractions();
const rate = 22050, beats = [];
let t = 1.0;
for (let i = 0; i < 32; i++) { beats.push({time: t, accent: i % 4 === 0}); const bpm = 96 + 16 * i / 31; t += 60 / bpm; }
for (let i = 0; i < 7; i++) { beats.push({time: t, accent: i === 0, eighth: true}); t += 30 / 112; }
for (let i = 0; i < 48; i++) { beats.push({time: t, accent: i % 4 === 0}); t += 60 / 112; }
const seconds = Math.ceil(t + 2), pcm = new Float32Array(rate * seconds);
let seed = 7; const noise = () => ((seed = seed * 16807 % 2147483647) / 2147483647 - .5);
for (const b of beats) {
  const start = Math.round(b.time * rate);
  for (let i = 0; i < rate * .25; i++) {
    const x = i / rate;
    pcm[start + i] += (b.accent ? Math.sin(2 * Math.PI * 60 * x) * .9 * Math.exp(-x * 18) : 0) + noise() * (b.accent ? .25 : .5) * Math.exp(-x * 40);
  }
}
function wav(samples) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2)), str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true));
  return new Blob([out.buffer], {type: 'audio/wav'});
}
window.fixtureBeats = beats.filter(b => !b.eighth).map(b => b.time);
window.fixtureTruth = beats;
window.fixtureUrls = {'drums-key': URL.createObjectURL(wav(pcm))};
const song = {id: 'fixture', title: 'Drift', artist: 'Fixture band', duration: seconds, stems: [{name: 'drums', key: 'drums-key'}], practice: {rate: 1}, tempo: null};
openPlayer(song, {cacheNamespace: `fixture-${Date.now()}:`});

// Map the fixture the way a person would: three pins, a 7/8 bar and a ramp.
window.fixtureDemo = async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 100 && !(window.fixtureEngine?.duration && window.fixtureMap && document.querySelector('.map-lane')); i++) await wait(100);
  await wait(300);
  const E = window.fixtureEngine, T = beats.map((b) => b.time);
  const key = (k, o = {}) => document.body.dispatchEvent(new KeyboardEvent('keydown', {key: k, code: o.code, altKey: !!o.alt, metaKey: !!o.meta, shiftKey: !!o.shift, bubbles: true, cancelable: true}));
  if (document.getElementById('map-strip').hidden) key('M', {shift: true});
  E.seek(T[0]); key('d'); E.seek(T[39]); key('d'); key('ArrowLeft', {alt: true}); E.seek(T[32]); key('d');
  key('9'); key('Enter'); key('e');
  const form = document.querySelector('.map-editor');
  form.n.value = 7; form.d.value = '8'; form.querySelector('[name=scope][value=bar]').checked = true; form.label.value = 'Turnaround'; form.requestSubmit();
  key('Home'); key('r'); key('8'); key('Enter');
  return document.getElementById('map-note').textContent;
};
window.fixtureKey = (k, o = {}) => document.body.dispatchEvent(new KeyboardEvent('keydown', {key: k, code: o.code, altKey: !!o.alt, metaKey: !!o.meta, shiftKey: !!o.shift, bubbles: true, cancelable: true}));
