// Lining an imported chart up with the recording (Import a chart, src/edit/map/find-panel.js).
//
// A chart from a file (a Guitar Pro tab, a MIDI drum part) brings its own bars and tempo; what it can't know is
// where its bar 1 falls in the recording. alignChart finds that one offset: the shift that puts the most of the
// chart's drum hits on the recording's drum onsets, at the chart's own tempo (which it trusts and never changes).
//
//   alignChart({map, hits, strength, onsets, duration}) → Promise<fit | null>
//     map       the chart's own SongMapData (its times start at its q 0)
//     hits      [{q, midi}] the chart's drum hits, in the map's quarter notes
//     strength  onsetStrength(stem) (src/js/onsets.js); onsets: detectOnsets(stem), to count the matches
//     null when there is nothing to match (no hits, no strength curve).
//   fit: {offset, matched, total, quality}
//     offset           seconds to add to every time of the chart's map (offsetTempoMap's argument)
//     matched / total  the chart's hit times (simultaneous hits count once) with a recording onset within
//                      MATCH_SEC, of all of them
//     quality          'good' | 'check' | 'poor' (poor: the hits don't follow the recording; leave it alone)
import {compile, timeAt} from '../../shared/song-map.ts';
import {KIT} from '../../shared/notation.ts';
import {nearestOnset} from './onsets.js';

/** A chart hit counts as heard when a recording onset is this close (seconds). */
export const MATCH_SEC = 0.03;

const COARSE_HZ = 100;
// How strongly each piece shows in a drum stem's onsets: shells and crashes clearly, hats and rides less.
const WEIGHT = new Map(KIT.map(k => [k.midi, k.family === 'drum' || k.id === 'kick' ? 1
  : /crash|china|splash/.test(k.id) ? 0.9 : k.id === 'openHat' ? 0.7 : k.id === 'pedalHat' ? 0.3 : 0.5]));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** A strength curve resampled to `hz` (the max of each step), normalized and smoothed (half-width in steps). */
function curve(strength, hz, half) {
  const step = strength.rate / hz, n = Math.max(1, Math.floor(strength.values.length / step));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let max = 0;
    for (let j = Math.floor(i * step), end = Math.min(strength.values.length, Math.floor((i + 1) * step)); j < end; j++) max = Math.max(max, strength.values[j]);
    out[i] = max;
  }
  // Normalize by a high percentile so a loud passage can't outvote the rest of the song.
  const sorted = Float32Array.from(out).sort();
  const top = sorted[Math.floor(sorted.length * 0.98)] || 1;
  for (let i = 0; i < n; i++) out[i] = Math.min(1, out[i] / top);
  // A triangle (two box passes): a hit a few milliseconds off still scores.
  const box = (src) => {
    const dst = new Float32Array(n), w = Math.max(0, Math.round(half / 2));
    let sum = 0;
    for (let i = -w; i < n + w; i++) {
      if (i + w < n) sum += src[i + w];
      if (i - w - 1 >= 0) sum -= src[i - w - 1];
      if (i >= 0 && i < n) dst[i] = sum / (2 * w + 1);
    }
    return dst;
  };
  return {values: half > 0 ? box(box(out)) : out, hz, start: strength.start};
}

/** The curve at time t (linear between steps; 0 outside the recording). */
function at(c, t) {
  const x = (t - c.start) * c.hz;
  if (x < 0 || x >= c.values.length - 1) return 0;
  const i = Math.floor(x), f = x - i;
  return c.values[i] * (1 - f) + c.values[i + 1] * f;
}

const countMatched = (onsets, events, offset) => events.reduce((n, e) => n + (nearestOnset(onsets, offset + e.t, MATCH_SEC) !== null ? 1 : 0), 0);

/** See the header. */
export async function alignChart({map, hits, strength, onsets = [], duration} = {}) {
  if (!map?.pins?.length || !Array.isArray(hits) || !hits.length || !strength?.values?.length) return null;
  // The chart's hit times in its own seconds (simultaneous hits merged, the strongest weight kept).
  const c = compile(map), byQ = new Map();
  for (const h of hits) {
    if (!h || !Number.isFinite(h.q)) continue;
    const key = Math.round(h.q * 960);
    byQ.set(key, Math.max(byQ.get(key) ?? 0, WEIGHT.get(h.midi) ?? 0.5));
  }
  const events = [...byQ].sort((a, b) => a[0] - b[0]).map(([key, w]) => ({t: timeAt(c, key / 960), w}));
  if (events.length < 4) return null;
  const length = Number.isFinite(duration) && duration > 0 ? duration : strength.values.length / strength.rate;

  // 1. Every offset on a 10 ms grid that puts the chart's first hit between ten seconds before the recording
  //    (an intro it cuts) and 60% of the way through it, scored with every hit of the chart at once.
  const coarse = curve(strength, COARSE_HZ, 6), first = events[0].t;
  const lo = -Math.min(10, (events.at(-1).t - first) / 4) - first, hi = length * 0.6 - first;
  const steps = Math.max(1, Math.floor((hi - lo) * COARSE_HZ));
  const sums = new Float32Array(steps);
  for (const e of events) {
    const base = Math.round((lo + e.t - coarse.start) * COARSE_HZ);
    const from = Math.max(0, -base), to = Math.min(steps, coarse.values.length - base);
    for (let k = from; k < to; k++) sums[k] += e.w * coarse.values[base + k];
  }
  let k0 = 0;
  for (let k = 1; k < steps; k++) if (sums[k] > sums[k0]) k0 = k;
  await tick();

  // 2. To the millisecond on the full-resolution curve, within 30 ms of it.
  const fine = curve(strength, Math.min(strength.rate, 400), 4);
  let offset = lo + k0 / COARSE_HZ, best = -1;
  for (let o = offset - 0.03; o <= offset + 0.03 + 1e-9; o += 0.0005) {
    let v = 0;
    for (const e of events) v += e.w * at(fine, o + e.t);
    if (v > best) { best = v; offset = o; }
  }

  // How much of the chart lands, against what a wrong offset would land by chance in a busy part.
  const matched = countMatched(onsets, events, offset);
  const chance = Math.max(countMatched(onsets, events, offset + 0.047), countMatched(onsets, events, offset - 0.061));
  const ratio = matched / events.length, lift = (matched - chance) / events.length;
  const quality = ratio >= 0.55 && lift >= 0.2 ? 'good' : ratio >= 0.35 && lift >= 0.1 ? 'check' : 'poor';
  return {offset, matched, total: events.length, quality};
}
