// Synthetic stems for the full-app fixture. Each stem is a mono 16-bit WAV
// with musical shape (sections, phrases, dynamics) so waveforms read like a
// real song. The drum stem of a song with a score is rendered from that score.
const RATE = 22050;

function rng(seed) { let s = seed % 2147483647 || 7; return () => ((s = s * 16807 % 2147483647) / 2147483647) * 2 - 1; }

function wav(samples) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, RATE, true); out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Blob([out.buffer], {type: 'audio/wav'});
}

// Section energy by bar: intro quiet, verse medium, chorus loud, outro fading.
function energy(bar, bars) {
  const f = bar / Math.max(1, bars);
  if (f < 0.125) return 0.45;
  if (f < 0.375) return 0.7;
  if (f < 0.625) return 1;
  if (f < 0.85) return 0.75;
  return 0.55 * (1 - (f - 0.85) / 0.15) + 0.15;
}

function addHit(pcm, t, kind, vel, noise) {
  const start = Math.round(t * RATE);
  const len = {kick: .35, snare: .25, closedHat: .06, pedalHat: .05, openHat: .3, ride: .5, crash: 1.2, china: 1, splash: .6, crashChoke: .25, crossStick: .08, rackTom: .35, tom3: .4, floorTom: .5}[kind] ?? .2;
  const n = Math.round(len * RATE);
  for (let i = 0; i < n && start + i < pcm.length; i++) {
    const x = i / RATE;
    let v = 0;
    if (kind === 'kick') v = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-x * 30)) * x) * Math.exp(-x * 9);
    else if (kind === 'snare') v = (noise() * .7 + Math.sin(2 * Math.PI * 190 * x) * .4) * Math.exp(-x * 16);
    else if (kind.includes('Hat')) v = noise() * .35 * Math.exp(-x * (kind === 'openHat' ? 9 : 60));
    else if (kind === 'crossStick') v = (noise() * .3 + Math.sin(2 * Math.PI * 900 * x) * .3) * Math.exp(-x * 60);
    else if (kind.includes('Tom') || kind === 'tom3') { const f = {rackTom: 160, tom3: 125, floorTom: 90}[kind]; v = Math.sin(2 * Math.PI * f * x) * Math.exp(-x * 7); }
    else v = noise() * .4 * Math.exp(-x * (kind === 'ride' ? 6 : 2.5)) + Math.sin(2 * Math.PI * 3200 * x) * .05 * Math.exp(-x * 4);
    pcm[start + i] += v * vel;
  }
}

/** Drum audio aligned to a Woodshed score (4/4 bars with linear anchors). */
export function drumsFromScore(score, seconds) {
  const pcm = new Float32Array(Math.ceil(seconds * RATE)), noise = rng(11);
  const [a0, a1] = score.timeline.anchors;
  const secPerQuarter = (a1.time - a0.time) / (a1.position.n / a1.position.d);
  const byId = new Map(score.bars.map(b => [b.measureId, b]));
  let q = 0;
  for (const m of score.timeline.measures) {
    const bar = byId.get(m.id);
    for (const h of bar?.hits || []) addHit(pcm, a0.time + (q + h.offset.n / h.offset.d) * secPerQuarter, h.instrument, (h.velocity ?? .8) * (h.accent ? 1 : .8), noise);
    q += m.length.n / m.length.d;
  }
  return pcm;
}

function drums(seconds, bpm, offset, seed) {
  const pcm = new Float32Array(Math.ceil(seconds * RATE)), noise = rng(seed), beat = 60 / bpm;
  const beats = Math.floor((seconds - offset) / beat), bars = Math.ceil(beats / 4);
  for (let i = 0; i < beats; i++) {
    const t = offset + i * beat, bar = Math.floor(i / 4), e = energy(bar, bars), b = i % 4;
    if (b === 0 || b === 2 || (e > .9 && b === 3)) addHit(pcm, t, 'kick', .9 * e + .1, noise);
    if (b === 1 || b === 3) addHit(pcm, t, 'snare', .8 * e + .1, noise);
    addHit(pcm, t, i % 32 === 0 ? 'crash' : e > .9 ? 'ride' : 'closedHat', .6 * e, noise);
    addHit(pcm, t + beat / 2, 'closedHat', .4 * e, noise);
    if (bar % 8 === 7 && b === 3) for (let k = 0; k < 4; k++) addHit(pcm, t + k * beat / 4, ['rackTom', 'tom3', 'floorTom', 'floorTom'][k], .7, noise);
  }
  return pcm;
}

const PROG = [[55, 82.4, 110, 138.6], [73.4, 110, 146.8, 185], [65.4, 98, 130.8, 164.8], [49, 73.4, 98, 123.5]];

function tonal(kind, seconds, bpm, offset, seed) {
  const pcm = new Float32Array(Math.ceil(seconds * RATE)), noise = rng(seed), beat = 60 / bpm;
  const beats = Math.floor((seconds - offset) / beat), bars = Math.ceil(beats / 4);
  const melody = [0, 2, 4, 7, 4, 2, 0, -3, 0, 4, 7, 9, 7, 4, 2, 0];
  for (let i = 0; i < beats; i++) {
    const t0 = offset + i * beat, bar = Math.floor(i / 4), e = energy(bar, bars), chord = PROG[bar % 4], b = i % 4;
    const start = Math.round(t0 * RATE);
    if (kind === 'bass') {
      const f = chord[0] * (b === 3 && bar % 2 ? 1.5 : 1);
      for (let k = 0; k < beat * RATE && start + k < pcm.length; k++) { const x = k / RATE; pcm[start + k] += (Math.sin(2 * Math.PI * f * x) * .7 + Math.sin(4 * Math.PI * f * x) * .2) * Math.exp(-x * 3) * e; }
    } else if (kind === 'vocals') {
      // Phrases of three bars with a breath, silent through the intro.
      if (bar < bars * .125 || bar % 4 === 3) continue;
      const step = melody[(i + seed) % melody.length], f = 220 * Math.pow(2, step / 12);
      for (let k = 0; k < beat * RATE && start + k < pcm.length; k++) { const x = k / RATE, vib = Math.sin(2 * Math.PI * 5.5 * x) * 3; const env = Math.min(1, x * 20) * Math.min(1, (beat - x) * 12); pcm[start + k] += (Math.sin(2 * Math.PI * (f + vib) * x) * .55 + Math.sin(4 * Math.PI * (f + vib) * x) * .15 + noise() * .02) * env * (e * .8 + .2); }
    } else if (kind === 'guitar') {
      for (let s = 0; s < 2; s++) { const st = start + Math.round(s * beat / 2 * RATE); for (let k = 0; k < beat / 2 * RATE && st + k < pcm.length; k++) { const x = k / RATE; let v = 0; for (const f of chord) v += Math.sign(Math.sin(2 * Math.PI * f * 2 * x)) * .08; pcm[st + k] += v * Math.exp(-x * 7) * e; } }
    } else if (kind === 'piano') {
      if (b !== 0 && b !== 2) continue;
      for (let k = 0; k < 2 * beat * RATE && start + k < pcm.length; k++) { const x = k / RATE; let v = 0; for (const f of chord) v += Math.sin(2 * Math.PI * f * 2 * x) * .18; pcm[start + k] += v * Math.exp(-x * 2.5) * (e * .7 + .3); }
    } else {
      // Pads: slow chords, swelling into the chorus.
      for (let k = 0; k < beat * RATE && start + k < pcm.length; k++) { const x = (start + k) / RATE; let v = 0; for (const f of chord.slice(1)) v += Math.sin(2 * Math.PI * f * x) * .12; pcm[start + k] += v * (e * .9) * (0.75 + 0.25 * Math.sin(2 * Math.PI * x / (beat * 4))); }
    }
  }
  return pcm;
}

const cache = new Map();
/** Blob URL for one stem of a fixture song. */
export function stemUrl(song, stem, score) {
  const key = `${song.id}/${stem}`;
  if (cache.has(key)) return cache.get(key);
  const seconds = song.duration, bpm = song.bpm || 120, offset = song.offset || 0, seed = [...song.id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const make = name => name === 'drums' ? (score ? drumsFromScore(score, seconds) : drums(seconds, bpm, offset, seed)) : tonal(name, seconds, bpm, offset, seed);
  let pcm;
  if (stem.startsWith('no_')) {
    const parts = ['drums', 'bass', 'vocals', 'other'].filter(p => p !== stem.slice(3));
    pcm = new Float32Array(Math.ceil(seconds * RATE));
    for (const p of parts) { const x = make(p); for (let i = 0; i < pcm.length; i++) pcm[i] += x[i] * .6; }
  } else pcm = make(stem);
  const url = URL.createObjectURL(wav(pcm));
  cache.set(key, url);
  return url;
}
