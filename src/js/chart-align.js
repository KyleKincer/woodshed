// Lining an imported chart up with the recording (Import a chart, src/edit/map/find-panel.js).
//
// A chart from a file (a Guitar Pro tab, a MIDI drum part) brings its own bars and tempo, but nothing in it
// says where its bar 1 falls in the recording, and a tab's tempo is usually a round number (115 for a take
// at 114.7), so a chart that starts in time is a beat late by the end. The recording's drum stem says where
// the hits really are: alignChart finds the start and the speed that put the most of the chart's hits on
// the stem's onsets, and, where the recording's tempo moves (a take without a click), a bar-by-bar map that
// follows it.
//
//   alignChart({map, hits, strength, onsets, duration, yieldEvery}) → Promise<fit | null>
//     map       the chart's own SongMapData (its times start at its q 0)
//     hits      [{q, midi}] the chart's drum hits, in the map's quarter notes
//     strength  onsetStrength(stem) (src/js/onsets.js); onsets: detectOnsets(stem), to count the matches
//     null when there is nothing to match (no hits, no strength curve).
//   fit: {offset, stretch, matched, total, quality, bpm, chartBpm, follow}
//     offset, stretch  fitMap's arguments: every time of the chart's map × stretch, then + offset seconds
//     matched / total  the chart's hit times (simultaneous hits count once) with a recording onset within
//                      MATCH_SEC, of all of them
//     quality          'good' | 'check' | 'poor' (poor: the hits don't follow the recording; leave it alone)
//     bpm, chartBpm    the first tempo, fitted and as the chart writes it
//     follow           {map, matched, drift} | null: a map with a pin on every bar that follows the
//                      recording where its tempo moves (null when a steady tempo already fits)
//   fitMap(map, {offset, stretch}) → SongMapData    the chart's map stretched, then shifted (pins before 0 s
//                                                   become one pin at 0 s, as a shifted map does)
//   followShift(follow, seconds) → SongMapData      a follow map moved by a manual nudge
import {compile, measureStarts, positionAt, timeAt, validateSongMap} from '../../shared/song-map.ts';
import {KIT, fraction, number} from '../../shared/notation.ts';
import {nearestOnset} from './onsets.js';

/** A chart hit counts as heard when a recording onset is this close (seconds). */
export const MATCH_SEC = 0.03;
/** The speeds tried: the chart's tempo × 1/stretch, for stretch within this much of 1. */
export const STRETCH_RANGE = 0.08;
/** A follow map is offered when some bar sits this far (seconds) from the steady fit. */
export const DRIFT_SEC = 0.025;

const COARSE_HZ = 100;
// How strongly each piece shows in a drum stem's onsets: shells and crashes clearly, hats and rides less.
const WEIGHT = new Map(KIT.map(k => [k.midi, k.family === 'drum' || k.id === 'kick' ? 1
  : /crash|china|splash/.test(k.id) ? 0.9 : k.id === 'openHat' ? 0.7 : k.id === 'pedalHat' ? 0.3 : 0.5]));
const qFraction = q => { const d = 960 * 64; return fraction(Math.round(q * d), d); };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** The chart's map with every time × stretch, then + offset seconds. */
export function fitMap(map, {offset = 0, stretch = 1} = {}) {
  const next = structuredClone(map);
  next.pins = next.pins.map(p => ({...p, time: p.time * stretch}));
  if (next.tailQpm) next.tailQpm /= stretch;
  return shiftMap(next, offset);
}

/** A follow map moved by `seconds` (a manual nudge after the fit). */
export function followShift(map, seconds) { return shiftMap(structuredClone(map), seconds); }

function shiftMap(map, seconds) {
  const c = compile(map);
  if (map.pins.every(p => p.time + seconds >= 0)) {
    map.pins = map.pins.map(p => ({...p, time: p.time + seconds}));
  } else {
    // The recording starts inside the chart: keep the pins after 0 s and pin the chart's position at 0 s.
    if (!map.tailQpm) map.tailQpm = c.tail * 60;
    const q = positionAt(c, -seconds);
    map.pins = [{position: qFraction(q), time: 0}, ...map.pins.filter(p => p.time + seconds > 0.001 && number(p.position) > q + 1e-6)
      .map(p => ({...p, time: p.time + seconds}))];
  }
  validateSongMap(map);
  return map;
}

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

const score = (c, events, offset, stretch) => {
  let sum = 0;
  for (const e of events) sum += e.w * at(c, offset + stretch * e.t);
  return sum;
};

/** The best few offsets (at least 0.6 s apart) for one stretch on the coarse curve: a correlation over every whole step. */
function coarseSearch(c, events, stretch, lo, hi, keep = 8) {
  const steps = Math.max(1, Math.floor((hi - lo) * c.hz));
  const sums = new Float32Array(steps);
  for (const e of events) {
    const base = Math.round((lo + stretch * e.t - c.start) * c.hz);
    const from = Math.max(0, -base), to = Math.min(steps, c.values.length - base);
    for (let k = from; k < to; k++) sums[k] += e.w * c.values[base + k];
  }
  const peaks = [];
  for (let k = 0; k < steps; k++) {
    if ((k > 0 && sums[k - 1] > sums[k]) || (k + 1 < steps && sums[k + 1] > sums[k])) continue;
    peaks.push({offset: lo + k / c.hz, score: sums[k], stretch});
  }
  peaks.sort((a, b) => b.score - a.score);
  const out = [];
  for (const p of peaks) {
    if (out.some(o => Math.abs(o.offset - p.offset) < 0.6)) continue;
    out.push(p);
    if (out.length >= keep) break;
  }
  return out;
}

/** The best (offset, stretch) on a grid around a guess. */
function refine(c, events, guess, {offsetSpan, offsetStep, stretchSpan, stretchStep}) {
  let best = {...guess, score: -1};
  for (let s = guess.stretch - stretchSpan; s <= guess.stretch + stretchSpan + 1e-12; s += stretchStep) {
    for (let o = guess.offset - offsetSpan; o <= guess.offset + offsetSpan + 1e-12; o += offsetStep) {
      const v = score(c, events, o, s);
      if (v > best.score) best = {offset: o, stretch: s, score: v};
    }
  }
  return best;
}

function countMatched(onsets, events, offset, stretch, shift = 0) {
  let n = 0;
  for (const e of events) if (nearestOnset(onsets, offset + stretch * e.t + shift, MATCH_SEC) !== null) n++;
  return n;
}

/** The chart's hit times (simultaneous hits merged, the strongest weight kept), in its own seconds. */
function eventsOf(map, hits) {
  const c = compile(map), byQ = new Map();
  for (const h of hits) {
    if (!h || !Number.isFinite(h.q)) continue;
    const key = Math.round(h.q * 960);
    byQ.set(key, Math.max(byQ.get(key) ?? 0, WEIGHT.get(h.midi) ?? 0.5));
  }
  return [...byQ].sort((a, b) => a[0] - b[0]).map(([key, w]) => ({q: key / 960, t: timeAt(c, key / 960), w}));
}

/** See the header. */
export async function alignChart({map, hits, strength, onsets = [], duration, yieldEvery = 4} = {}) {
  if (!map?.pins?.length || !Array.isArray(hits) || !hits.length || !strength?.values?.length) return null;
  const events = eventsOf(map, hits);
  if (events.length < 4) return null;
  const length = Number.isFinite(duration) && duration > 0 ? duration : strength.values.length / strength.rate;
  const coarse = curve(strength, COARSE_HZ, 6), fine = curve(strength, Math.min(strength.rate, 400), 4);
  const first = events[0].t;

  // 1. Where does the chart start, and roughly how fast is it? Its first 16 seconds (at least 32 hit
  //    times) against every offset that puts its first hit between `lead` seconds before the recording
  //    (an intro the recording cuts) and 60% of the way through it, at each stretch on a 1% grid. The
  //    opening is short enough that a take whose tempo wanders still holds one speed through it.
  const lead = Math.min(10, (events.at(-1).t - first) / 4);
  const opening = events.filter(e => e.t <= first + 16);
  if (opening.length < 32) opening.push(...events.slice(opening.length, 32));
  let candidates = [], n = 0;
  for (let s = 1 - STRETCH_RANGE; s <= 1 + STRETCH_RANGE + 1e-9; s += 0.01) {
    const lo = -lead - s * first, hi = length * 0.6 - s * first;
    candidates.push(...coarseSearch(coarse, opening, s, lo, hi));
    if (++n % yieldEvery === 0) await tick();
  }
  // Songs repeat their sections, so the opening can fit a later repeat just as well. The whole chart
  // ranks the best 40 openings (at least 0.6 s apart, so near-copies of one repeat an 8th note apart
  // don't crowd out the rest; where a take's tempo bends, the true opening can score a little below a
  // copy in a steadier part): shifted onto a repeat, the chart runs past the end and mismatches the
  // sections between. Each one's speed is refined a little first, so the end of the song still lines up.
  candidates.sort((a, b) => b.score - a.score);
  const ranked = [];
  for (const c of candidates) {
    if (ranked.some(o => Math.abs(o.offset - c.offset) < 0.6)) continue;
    const whole = refine(coarse, events, c, {offsetSpan: 0.05, offsetStep: 0.01, stretchSpan: 0.008, stretchStep: 0.002});
    ranked.push({...c, whole: whole.score});
    if (ranked.length >= 40) break;
    if (++n % yieldEvery === 0) await tick();
  }
  ranked.sort((a, b) => b.whole - a.whole);

  // 2. Lock on to the opening, then walk the chart bar by bar (track()), for the best eight starts: the
  //    one whose walk hears the most of the chart wins (a take whose tempo wanders can make a repeat
  //    rank first above; walking it misses the fills). The steady fit is the line through the bars heard.
  let lock = null, bars = null, heardWeight = -1;
  for (const c of ranked.slice(0, 8)) {
    const tryLock = refine(fine, opening, c, {offsetSpan: 0.03, offsetStep: 0.002, stretchSpan: 0.012, stretchStep: 0.001});
    const tryBars = await track(map, events, fine, onsets, tryLock, yieldEvery);
    const weight = tryBars.reduce((sum, b) => sum + (b.heard ? b.weight : 0), 0);
    if (weight > heardWeight) { lock = tryLock; bars = tryBars; heardWeight = weight; }
  }
  const heardBars = bars.filter(b => b.heard);
  let fitLine = line(heardBars.map(b => ({x: b.t, y: b.time, w: b.weight}))) ?? {offset: lock.offset, stretch: lock.stretch};
  const close = heardBars.filter(b => Math.abs(b.time - (fitLine.offset + fitLine.stretch * b.t)) < 0.04);
  if (close.length >= 2) fitLine = line(close.map(b => ({x: b.t, y: b.time, w: b.weight}))) ?? fitLine;
  fitLine.stretch = clamp(fitLine.stretch, 1 - STRETCH_RANGE - 0.01, 1 + STRETCH_RANGE + 0.01);

  // 3. Polish on the fine curve with every hit.
  let best = refine(fine, events, fitLine, {offsetSpan: 0.03, offsetStep: 0.002, stretchSpan: 0.002, stretchStep: 0.0002});
  await tick();
  best = refine(fine, events, best, {offsetSpan: 0.002, offsetStep: 0.0005, stretchSpan: 0.0002, stretchStep: 0.00002});

  const matched = countMatched(onsets, events, best.offset, best.stretch);
  const chartBpm = (compile(map).spans[0]?.v0 ?? compile(map).tail) * 60;
  const fit = {offset: best.offset, stretch: best.stretch, matched, total: events.length, chartBpm, bpm: chartBpm / best.stretch, follow: null};
  fit.follow = followMap(map, events, onsets, fit, bars);
  // What a wrong alignment would match by chance in a busy part (a 32nd-note blast leaves no gaps).
  const chance = Math.max(countMatched(onsets, events, best.offset, best.stretch, 0.047), countMatched(onsets, events, best.offset, best.stretch, -0.061));
  const heard = Math.max(matched, fit.follow?.matched ?? 0);
  const ratio = heard / events.length, lift = (heard - chance) / events.length;
  fit.quality = ratio >= 0.55 && lift >= 0.2 ? 'good' : ratio >= 0.35 && lift >= 0.1 ? 'check' : 'poor';
  if (fit.quality === 'poor') fit.follow = null;
  return fit;
}

/** Weighted least squares y = offset + stretch·x; null without two distinct anchors. */
function line(points) {
  if (points.length < 2) return null;
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) { sw += p.w; sx += p.w * p.x; sy += p.w * p.y; sxx += p.w * p.x * p.x; sxy += p.w * p.x * p.y; }
  const det = sw * sxx - sx * sx;
  if (Math.abs(det) < 1e-9) return null;
  const stretch = (sw * sxy - sx * sy) / det;
  return {offset: (sy - stretch * sx) / sw, stretch};
}

/**
 * The bar tracker: each bar's downbeat is predicted from the one before at the current speed, then searched
 * within ±60 ms (and the speed within ±1.5%) over that bar and the next, preferring the prediction (busy
 * parts repeat every 16th note, so a lag one note off scores nearly as well). A bar counts as heard when
 * most of its hits land on onsets; the speed follows heard bars slowly and carries through the rest.
 * → [{index, t (chart seconds of its downbeat), time (recording seconds), heard, weight}]
 */
async function track(map, events, fine, onsets, lock, yieldEvery) {
  const starts = measureStarts(map.measures).map(number), c = compile(map);
  const ends = [...starts.slice(1), starts.at(-1) + number(map.measures.at(-1).length)];
  const out = [];
  let speed = lock.stretch, e0 = 0, n = 0, last = null, coasting = 0;
  const recent = [];
  for (let b = 0; b < starts.length; b++) {
    const t = timeAt(c, starts[b]);
    const from = last ?? {t: 0, time: lock.offset};
    const predicted = from.time + speed * (t - from.t);
    while (e0 < events.length && events[e0].q < starts[b]) e0++;
    // After bars it could not hear (a break, a sparse passage) the search widens to find the lock again,
    // over four bars instead of two (a steady groove looks the same an 8th note later; a fill doesn't),
    // and asks for more of the hits to land.
    const lost = last ? t - last.t : 0;
    const relock = coasting > 0 || lost > 6;
    // The first bars come from the opening's straight line, which a take whose tempo bends misses at
    // its ends: they are searched a little wider until two bars have been heard.
    const settling = !relock && recent.length < 2;
    const reach = relock ? clamp(0.1 + 0.025 * lost, 0.1, 0.6) : settling ? 0.1 : 0.06;
    const sigma = relock ? reach : settling ? 0.08 : 0.03;
    const window = [];
    for (let i = e0; i < events.length && events[i].q < ends[Math.min(starts.length - 1, b + (relock ? 3 : 1))]; i++) window.push(events[i]);
    let bar = {index: b, t, time: predicted, heard: false, weight: 0};
    if (window.length >= 6) {
      let best = {v: -1};
      // A section can change speed outright: re-locking also tries the speed within ±5%.
      const spread = relock ? 0.05 : 0.015;
      const dStep = relock ? 0.004 : 0.002, sStep = relock ? 0.01 : 0.005;
      for (let s = speed * (1 - spread); s <= speed * (1 + spread) + 1e-9; s += speed * sStep) {
        for (let d = -reach; d <= reach + 1e-9; d += dStep) {
          let v = 0;
          for (const e of window) v += e.w * at(fine, predicted + d + s * (e.t - t));
          v *= Math.exp(-(d * d) / (2 * sigma * sigma));
          if (v > best.v) best = {v, d, s};
        }
      }
      const time = predicted + best.d;
      let hit = 0;
      for (const e of window) if (nearestOnset(onsets, time + best.s * (e.t - t), MATCH_SEC) !== null) hit++;
      if (hit >= Math.max(5, window.length * (relock ? 0.7 : 0.6))) {
        bar = {index: b, t, time, heard: true, weight: window.length};
        // The speed: the line through the last four bars heard (a re-lock's jump starts the count again).
        if (relock) { recent.length = 0; speed = best.s; }
        recent.push({x: t, y: time, w: 1});
        if (recent.length > 4) recent.shift();
        const local = recent.length >= 3 ? line(recent) : null;
        if (local) speed = clamp(local.stretch, lock.stretch * 0.85, lock.stretch * 1.15);
      }
    }
    out.push(bar);
    if (bar.heard) { last = bar; coasting = 0; } else if (window.length >= 6) coasting++;
    if (++n % (yieldEvery * 8) === 0) await tick();
  }
  return out;
}

/**
 * The bars where the tracker heard them, smoothed (a running median of three), as a pin on every bar.
 * Kept when some bar is more than DRIFT_SEC from the steady fit and the pinned bars match more of the
 * recording's onsets. Null otherwise.
 */
function followMap(map, events, onsets, fit, bars) {
  const exact = measureStarts(map.measures), c = compile(map);
  if (bars.filter(b => b.heard).length < 3) return null;
  // Unheard bars follow the steady fit's offset from their heard neighbours.
  const lag = bars.map(b => b.time - (fit.offset + fit.stretch * b.t));
  const heard = bars.map((b, i) => b.heard ? i : null).filter(i => i !== null);
  const filled = lag.map((d, i) => {
    if (bars[i].heard) return d;
    const before = heard.filter(k => k < i).at(-1), after = heard.find(k => k > i);
    if (before === undefined) return lag[after];
    if (after === undefined) return lag[before];
    return lag[before] + (lag[after] - lag[before]) * (i - before) / (after - before);
  });
  // A running median of three (at either end, the mean of the two).
  const smooth = filled.map((_, i) => {
    const near = filled.slice(Math.max(0, i - 1), i + 2).sort((a, b) => a - b);
    return near.length % 2 ? near[near.length >> 1] : (near[0] + near[1]) / 2;
  });
  const drift = Math.max(...smooth.map(Math.abs));
  if (drift < DRIFT_SEC) return null;
  const times = bars.map((b, i) => fit.offset + fit.stretch * b.t + smooth[i]);
  for (let i = 1; i < times.length; i++) times[i] = Math.max(times[i], times[i - 1] + 0.05);
  const n = times.length, lastQ = number(map.measures.at(-1).length);
  const lastSeconds = n > 1 ? (times[n - 1] - times[n - 2]) * lastQ / number(map.measures[n - 2].length) : fit.stretch * lastQ / Math.max(1e-6, c.tail);
  const raw = {...structuredClone(map), pins: exact.map((q, i) => ({position: q, time: times[i]})), tailQpm: clamp(lastQ / Math.max(0.05, lastSeconds) * 60, 10, 1000)};
  // Pins before the recording starts are folded into one at 0 s (the bars before it keep the first tempo).
  let follow;
  try { follow = followShift(raw, 0); } catch { return null; }
  const fc = compile(follow);
  let matched = 0;
  for (const e of events) if (nearestOnset(onsets, timeAt(fc, e.q), MATCH_SEC) !== null) matched++;
  if (matched <= fit.matched * 1.03) return null;
  return {map: follow, matched, drift};
}
