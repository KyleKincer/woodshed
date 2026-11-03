// Lining a playthrough video up with the recording (the Stage's Playthrough video sheet, src/stage/sheets/video.js).
//
// A playthrough is usually played over the studio track, so the video's audio holds the recording, often with
// a talking intro or a count-in first and the player's own kit on top. alignVideo finds the one offset that best
// lines the two up (the recording's tempo is trusted: nothing is stretched), by cross-correlating their onset
// strengths: every hit of both, at once.
//
//   alignVideo({song, video}) → {offset, quality, confidence} | null
//     song, video   onsetStrength() curves (src/js/onsets.js) of the recording's mix and of the video's audio
//     offset        seconds: videoTime = songTime + offset (shared/video.ts)
//     quality       'good' | 'check' | 'poor': how clearly one offset beats every other one
//     confidence    how far the best match stands above all the others (standard deviations; ≈ 8 for a clear match)
//     null when either curve is empty.
//
//   mixdown(buffers, rate?) → {sampleRate, length, numberOfChannels: 1, getChannelData}
//     several decoded stems summed to one mono buffer at `rate` (the song's "mix" for onsetStrength)

const COARSE_HZ = 50;
const FINE_HZ = 400;
const SECOND_PEAK_GAP = 0.5;

/** In-place radix-2 FFT of (re, im); `inverse` for the inverse transform (unscaled). */
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** A strength curve at `hz` (the max of each step), mean removed and scaled by a high percentile. */
function resample(strength, hz) {
  const step = strength.rate / hz, n = Math.max(1, Math.floor(strength.values.length / step));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let max = 0;
    for (let j = Math.floor(i * step), end = Math.min(strength.values.length, Math.floor((i + 1) * step)); j < end; j++) max = Math.max(max, strength.values[j]);
    out[i] = max;
  }
  const sorted = Float64Array.from(out).sort();
  const top = sorted[Math.floor(n * 0.98)] || 1;
  let mean = 0;
  for (let i = 0; i < n; i++) { out[i] = Math.min(1, out[i] / top); mean += out[i]; }
  mean /= n;
  for (let i = 0; i < n; i++) out[i] -= mean;
  return out;
}

/** A triangle smoothing (two box passes of half-width w): a hit between two steps still counts in full. */
function smooth(src, w) {
  const box = (x) => {
    const out = new Float64Array(x.length);
    let sum = 0;
    for (let i = -w; i < x.length + w; i++) {
      if (i + w < x.length) sum += x[i + w];
      if (i - w - 1 >= 0) sum -= x[i - w - 1];
      if (i >= 0 && i < x.length) out[i] = sum / (2 * w + 1);
    }
    return out;
  };
  return w > 0 ? box(box(src)) : src;
}

/** c[L] = Σ a[i] · b[i + L] for every lag L in (−a.length, b.length), by FFT. Returns {values, zero} (index of L = 0). */
function crossCorrelate(a, b) {
  let n = 1;
  while (n < a.length + b.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(a); br.set(b);
  fft(ar, ai); fft(br, bi);
  // conj(A) · B
  for (let k = 0; k < n; k++) {
    const r = ar[k] * br[k] + ai[k] * bi[k], i = ar[k] * bi[k] - ai[k] * br[k];
    ar[k] = r; ai[k] = i;
  }
  fft(ar, ai, true);
  // Lags 0…b.length−1 sit at the front, negative lags wrap to the end.
  const values = new Float64Array(a.length + b.length - 1), zero = a.length - 1;
  for (let lag = -(a.length - 1); lag < b.length; lag++) values[zero + lag] = ar[(lag + n) % n] / n;
  return {values, zero};
}

/** The curve's value at time t (linear between steps; 0 outside). */
function at(curve, hz, start, t) {
  const x = (t - start) * hz;
  if (x < 0 || x >= curve.length - 1) return 0;
  const i = Math.floor(x), f = x - i;
  return curve[i] * (1 - f) + curve[i + 1] * f;
}

/** See the header. */
export function alignVideo({song, video} = {}) {
  if (!song?.values?.length || !video?.values?.length) return null;
  const a = smooth(resample(song, COARSE_HZ), 1), b = smooth(resample(video, COARSE_HZ), 1);
  const {values, zero} = crossCorrelate(a, b);
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  let second = -Infinity;
  const gap = Math.round(SECOND_PEAK_GAP * COARSE_HZ);
  for (let i = 0; i < values.length; i++) if (Math.abs(i - best) > gap && values[i] > second) second = values[i];
  const peak = values[best];
  // Video time of song time t: t + (lag / hz) − song.start + video.start.
  const coarse = (best - zero) / COARSE_HZ - song.start + video.start;

  // To the millisecond, within one coarse step either side, on finer curves.
  const fa = resample(song, Math.min(FINE_HZ, song.rate)), fb = resample(video, Math.min(FINE_HZ, video.rate));
  const ha = Math.min(FINE_HZ, song.rate), hb = Math.min(FINE_HZ, video.rate);
  let offset = coarse, bestFine = -Infinity;
  const stride = Math.max(1, Math.floor(fa.length / 20000));
  for (let o = coarse - 1 / COARSE_HZ; o <= coarse + 1 / COARSE_HZ + 1e-9; o += 0.001) {
    let v = 0;
    for (let i = 0; i < fa.length; i += stride) v += fa[i] * at(fb, hb, video.start, song.start + i / ha + o);
    if (v > bestFine) { bestFine = v; offset = o; }
  }
  let mean = 0, sq = 0;
  for (const x of values) { mean += x; sq += x * x; }
  mean /= values.length;
  const sd = Math.sqrt(Math.max(1e-12, sq / values.length - mean * mean));
  const z = (peak - mean) / sd;
  // The best lag against every other one (music repeats, so the next bar also scores: the spread of all lags is the
  // honest yardstick), and against the next best peak more than half a second away.
  const confidence = Math.round(z * 10) / 10, lead = second > 0 ? peak / second : Infinity;
  // Measured: the same recording leads its runner-up about 2× at z ≈ 8; other audio about 1.1× at z ≈ 4.
  const quality = lead >= 1.4 && z >= 6 ? 'good' : lead >= 1.15 && z >= 5 ? 'check' : 'poor';
  return {offset: Math.round(offset * 1000) / 1000, quality, confidence};
}

/** Decoded buffers summed to one mono buffer at `rate` (nearest-sample resampling is enough for onsets). */
export function mixdown(buffers, rate = 22050) {
  const list = (buffers ?? []).filter(b => b?.length && b.sampleRate > 0);
  const length = Math.max(0, ...list.map(b => Math.floor(b.length * rate / b.sampleRate)));
  const data = new Float32Array(length);
  for (const b of list) {
    const ratio = b.sampleRate / rate;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const src = b.getChannelData(c), gain = 1 / b.numberOfChannels;
      for (let i = 0; i < length; i++) {
        const j = Math.floor(i * ratio);
        if (j < src.length) data[i] += src[j] * gain;
      }
    }
  }
  return {sampleRate: rate, length, numberOfChannels: 1, getChannelData: () => data, duration: length / rate};
}
