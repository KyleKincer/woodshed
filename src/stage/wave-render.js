// The one waveform renderer (architecture §2.14.13): a cached peak pyramid per
// stem, and the canvas drawing for stem rows (Stems surface, Edit · Map), the
// Road map's mini envelopes, the song strip's overview and the grid lines.
//
//   createPeaks(tracks, {base = 256}) → PeaksCache
//     Level k holds [min, max] pairs per (base × 2^k) samples, built lazily per
//     track (level 0 from computePeaksRange, each higher level from the one
//     below). range() answers any window exactly as computePeaksRange would —
//     same bins, same edges — but reads whole pyramid nodes for the inside of
//     each bin and raw samples only for its two partial ends, so zooming,
//     panning and the virtualised Road map rows never rescan a whole stem.
//     'mix' is the max-abs envelope across tracks (min of mins, max of maxes).
//
// Every draw function works in CSS pixels on a context the caller has sized;
// drawRows also sets the device-pixel transform itself. Colours come from the
// design tokens (readTokens), never literals: stem colours are given as a stem
// key ('drums'), a custom property ('--stem-drums') or an already-resolved colour.
// Muted ('out') is never drawn with opacity: a 1 px outline ghost plus a 45°
// hatch (spec §4.4B, §7.5); 'dim' (the others while a stem is soloed) is the
// outline alone.
import {computePeaksRange} from '../js/waveform.js';

export const DEFAULT_BASE = 256;
/** Envelopes use this fraction of the half-height (as the 1.9 waveform did). */
const AMPLITUDE = 0.92;
/** Non-primary stems in a Road map cell (spec §4.4B). */
export const SECONDARY_ALPHA = 0.55;
/** Grid line strength (spec §4.4D): beats (and subdivisions) and bars, as a fraction of --ink. */
export const GRID_ALPHA = Object.freeze({beat: 0.08, sub: 0.08, bar: 0.18});
export const STEM_KEYS = Object.freeze(['drums', 'bass', 'guitar', 'piano', 'vocals', 'other']);

// ------------------------------------------------------------------ peaks

function channels(buffer) {
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  return {ch0, ch1};
}

function createTrack(name, buffer, base) {
  const track = {name, buffer, levels: [], data: null};
  const raw = () => (track.data ??= channels(buffer));

  const level = k => {
    const {levels} = track;
    if (!levels.length) {
      const bins = Math.max(1, Math.ceil(buffer.length / base));
      levels.push(computePeaksRange(buffer, 0, buffer.length / buffer.sampleRate, bins, {samplesPerBin: base}));
    }
    while (levels.length <= k) {
      const below = levels[levels.length - 1], n = below.length / 2, size = Math.ceil(n / 2);
      const next = new Float32Array(size * 2);
      for (let j = 0; j < size; j++) {
        const a = 4 * j, b = a + 2;
        if (2 * j + 1 < n) {
          next[2 * j] = Math.min(below[a], below[b]);
          next[2 * j + 1] = Math.max(below[a + 1], below[b + 1]);
        } else {
          next[2 * j] = below[a];
          next[2 * j + 1] = below[a + 1];
        }
      }
      levels.push(next);
    }
    return levels[k];
  };

  // [min, max] over samples [a, b) into out[o], out[o + 1], with computePeaksRange's rules
  // (min starts at 1, max at -1; an empty window is [0, 0]).
  const scan = (a, b, acc) => {
    const {ch0, ch1} = raw();
    let min = acc[0], max = acc[1];
    if (ch1) {
      for (let i = a; i < b; i++) { const v = (ch0[i] + ch1[i]) * 0.5; if (v < min) min = v; if (v > max) max = v; }
    } else {
      for (let i = a; i < b; i++) { const v = ch0[i]; if (v < min) min = v; if (v > max) max = v; }
    }
    acc[0] = min; acc[1] = max;
  };
  const acc = [1, -1];
  const take = (lv, j) => {
    if (lv[2 * j] < acc[0]) acc[0] = lv[2 * j];
    if (lv[2 * j + 1] > acc[1]) acc[1] = lv[2 * j + 1];
  };
  const query = (a, b, out, o) => {
    acc[0] = 1; acc[1] = -1;
    if (b - a <= 2 * base) {
      scan(a, b, acc);
    } else {
      const lo0 = Math.ceil(a / base), hi0 = Math.floor(b / base);
      scan(a, lo0 * base, acc);
      scan(hi0 * base, b, acc);
      // Whole level-0 bins [lo0, hi0), as the fewest pyramid nodes (segment-tree walk).
      let lo = lo0, hi = hi0, k = 0;
      while (lo < hi) {
        const lv = level(k);
        if (lo & 1) take(lv, lo++);
        if (hi & 1) take(lv, --hi);
        lo >>= 1; hi >>= 1; k++;
      }
    }
    if (acc[0] > acc[1]) { out[o] = 0; out[o + 1] = 0; } else { out[o] = acc[0]; out[o + 1] = acc[1]; }
  };

  track.level = level;
  track.levelCount = () => {
    let n = Math.max(1, Math.ceil(buffer.length / base)), count = 1;
    while (n > 1) { n = Math.ceil(n / 2); count++; }
    return count;
  };
  /** computePeaksRange(buffer, t0, t1, bins), from the pyramid. */
  track.range = (t0, t1, bins, out = new Float32Array(bins * 2)) => {
    const sr = buffer.sampleRate;
    const start = Math.max(0, Math.floor(t0 * sr)), end = Math.min(buffer.length, Math.ceil(t1 * sr));
    const total = Math.max(1, end - start), spb = Math.max(1, total / bins);
    for (let x = 0; x < bins; x++) {
      const a = start + Math.floor(x * spb), b = Math.min(start + Math.floor((x + 1) * spb), end);
      if (a >= b) { out[2 * x] = 0; out[2 * x + 1] = 0; } else query(a, b, out, 2 * x);
    }
    return out;
  };
  /** One [min, max] pair per [t0, t1) window. */
  track.windows = (spans, out) => {
    const sr = buffer.sampleRate;
    spans.forEach(([t0, t1], i) => {
      const a = Math.max(0, Math.floor(t0 * sr)), b = Math.min(buffer.length, Math.ceil(t1 * sr));
      if (a >= b) { out[2 * i] = 0; out[2 * i + 1] = 0; } else query(a, b, out, 2 * i);
    });
    return out;
  };
  return track;
}

/** Bars as [t0, t1) pairs: [{t0, t1}] (SongMapStore bars), [{start, end}], [[t0, t1]] or boundaries [b0, b1, …, bn]. */
function spansOf(bars) {
  if (!bars?.length) return [];
  if (typeof bars[0] === 'number') {
    const out = [];
    for (let i = 0; i + 1 < bars.length; i++) out.push([bars[i], bars[i + 1]]);
    return out;
  }
  return Array.from(bars, b => (Array.isArray(b) ? [b[0], b[1]] : [b.t0 ?? b.start, b.t1 ?? b.end]));
}

function combineInto(out, part) {
  for (let i = 0; i < out.length; i += 2) {
    if (part[i] < out[i]) out[i] = part[i];
    if (part[i + 1] > out[i + 1]) out[i + 1] = part[i + 1];
  }
}

/**
 * The peaks of a song's stems.
 *   tracks: [{name, buffer}] (an AudioBuffer-like: sampleRate, length, numberOfChannels, getChannelData);
 *           a track whose buffer is still missing makes `ready` false and reads as silence.
 * PeaksCache:
 *   ready                                   every track has its buffer
 *   names, base, duration                   stem names, samples per level-0 bin, longest buffer (s)
 *   range(name | 'mix', t0, t1, bins)       Float32Array(bins × 2) of [min, max], equal to computePeaksRange
 *   perBar(name | 'mix', bars)              Float32Array(bars × 2): one [min, max] per bar
 *   level(name, k), levelCount(name)        the pyramid itself (built on first use)
 *   has(name)
 * An unknown name reads as silence (all zeros).
 */
export function createPeaks(tracks = [], {base = DEFAULT_BASE} = {}) {
  const size = Math.max(1, Math.round(base));
  const list = tracks.map(({name, buffer}) => ({name, track: buffer ? createTrack(name, buffer, size) : null}));
  const byName = new Map(list.map(entry => [entry.name, entry]));
  const live = () => list.filter(entry => entry.track);

  const range = (name, t0, t1, bins) => {
    const n = Math.max(0, Math.floor(bins));
    const out = new Float32Array(n * 2);
    if (!n) return out;
    if (name === 'mix') {
      const tracksNow = live();
      if (!tracksNow.length) return out;
      tracksNow[0].track.range(t0, t1, n, out);
      const part = new Float32Array(n * 2);
      for (let i = 1; i < tracksNow.length; i++) combineInto(out, tracksNow[i].track.range(t0, t1, n, part));
      return out;
    }
    const entry = byName.get(name);
    return entry?.track ? entry.track.range(t0, t1, n, out) : out;
  };

  const perBar = (name, bars) => {
    const spans = spansOf(bars);
    const out = new Float32Array(spans.length * 2);
    if (!spans.length) return out;
    if (name === 'mix') {
      const tracksNow = live();
      if (!tracksNow.length) return out;
      tracksNow[0].track.windows(spans, out);
      const part = new Float32Array(spans.length * 2);
      for (let i = 1; i < tracksNow.length; i++) combineInto(out, tracksNow[i].track.windows(spans, part));
      return out;
    }
    const entry = byName.get(name);
    return entry?.track ? entry.track.windows(spans, out) : out;
  };

  const trackOf = name => {
    const entry = byName.get(name);
    if (!entry?.track) throw new RangeError(`No peaks for track ${String(name)}`);
    return entry.track;
  };

  return {
    get ready() { return list.length > 0 && list.every(entry => entry.track); },
    get names() { return list.map(entry => entry.name); },
    get base() { return size; },
    get duration() { return live().reduce((d, {track}) => Math.max(d, track.buffer.length / track.buffer.sampleRate), 0); },
    has: name => !!byName.get(name)?.track,
    range,
    perBar,
    level: (name, k) => trackOf(name).level(k),
    levelCount: name => trackOf(name).levelCount(),
  };
}

// ------------------------------------------------------------------ tokens

const TOKEN_VARS = Object.freeze({
  ink: '--ink', ink3: '--ink-3', now: '--now', nowSoft: '--now-soft', accent: '--accent', loop: '--loop',
  loopFill: '--loop-fill', out: '--out', line: '--line', gridBeat: '--grid-beat', gridBar: '--grid-bar',
});

let tokenCache = null;
let tokenListening = false;

/** Forgets the cached tokens (also done on window `woodshed:theme` and `woodshed:place`). */
export function invalidateTokens() { tokenCache = null; }

function listenForTheme() {
  if (tokenListening || typeof window === 'undefined' || !window.addEventListener) return;
  tokenListening = true;
  window.addEventListener('woodshed:theme', invalidateTokens);
  window.addEventListener('woodshed:place', invalidateTokens);
}

/**
 * The colours the canvases draw with, resolved from the tokens on the root element (D3: the
 * Stage set applies there too): {ink, ink3, now, nowSoft, accent, loop, loopFill, out, line,
 * gridBeat, gridBar, stem: {drums, bass, guitar, piano, vocals, other}}. Each value is resolved
 * through a hidden probe's computed colour, so var() and color-mix() arrive as plain colours a
 * canvas accepts. Cached until the theme or the place changes.
 */
export function readTokens() {
  listenForTheme();
  if (tokenCache) return tokenCache;
  if (typeof document === 'undefined' || !document.documentElement) {
    return {...Object.fromEntries(Object.keys(TOKEN_VARS).map(k => [k, ''])), stem: Object.fromEntries(STEM_KEYS.map(k => [k, '']))};
  }
  const root = document.documentElement;
  const rootStyle = getComputedStyle(root);
  const parent = document.body ?? root;
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
  parent.append(probe);
  const resolve = variable => {
    const raw = rootStyle.getPropertyValue(variable).trim();
    probe.style.color = '';
    probe.style.color = `var(${variable})`;
    const computed = getComputedStyle(probe).color?.trim() ?? '';
    // Without a layout engine (tests) the probe may not resolve; the raw token value still works.
    return computed && !computed.includes('var(') && raw ? computed : raw;
  };
  try {
    const out = {};
    for (const [key, variable] of Object.entries(TOKEN_VARS)) out[key] = resolve(variable);
    out.stem = Object.fromEntries(STEM_KEYS.map(k => [k, resolve(`--stem-${k}`)]));
    tokenCache = Object.freeze({...out, stem: Object.freeze(out.stem)});
  } finally {
    probe.remove();
  }
  return tokenCache;
}

/** A stem key ('drums'), a custom property ('--stem-drums') or a colour → a colour for the canvas. */
export function resolveColor(color, fallbackName) {
  const tokens = readTokens();
  if (color && tokens.stem[color] !== undefined) return tokens.stem[color];
  if (typeof color === 'string' && color.startsWith('--')) {
    const key = color.replace(/^--stem-/, '');
    if (tokens.stem[key] !== undefined) return tokens.stem[key];
    const camel = Object.entries(TOKEN_VARS).find(([, v]) => v === color)?.[0];
    if (camel) return tokens[camel];
    return typeof document !== 'undefined' ? getComputedStyle(document.documentElement).getPropertyValue(color).trim() : '';
  }
  if (color) return color;
  return tokens.stem[fallbackName] ?? tokens.stem.other;
}

// ------------------------------------------------------------------ hatch

const hatchCache = new Map();
const HATCH_CACHE_LIMIT = 64;

function tileCanvas(size) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    return c;
  }
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(size, size);
  return null;
}

/**
 * The 45° hatch for muted stems, as a CanvasPattern in `color`. Cached per colour and device
 * pixel ratio (the tile is drawn in device pixels and scaled back, so lines stay 1 px crisp on a
 * context scaled by dpr). Returns `color` itself when no canvas is available.
 */
export function hatch(ctx, color, {dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1, spacing = 6} = {}) {
  const key = `${color}|${dpr}`;
  const cached = hatchCache.get(key);
  if (cached) return cached;
  const size = Math.max(2, Math.round(spacing * dpr));
  const tile = tileCanvas(size);
  const tctx = tile?.getContext('2d');
  if (!tctx) return color;
  tctx.clearRect(0, 0, size, size);
  tctx.strokeStyle = color;
  tctx.lineWidth = Math.max(1, Math.round(dpr));
  tctx.lineCap = 'square';
  tctx.beginPath();
  // One diagonal plus the two corner pieces, so the tile repeats seamlessly.
  tctx.moveTo(0, size); tctx.lineTo(size, 0);
  tctx.moveTo(-size / 2, size / 2); tctx.lineTo(size / 2, -size / 2);
  tctx.moveTo(size / 2, size * 1.5); tctx.lineTo(size * 1.5, size / 2);
  tctx.stroke();
  const pattern = ctx.createPattern(tile, 'repeat');
  if (!pattern) return color;
  if (dpr !== 1 && typeof pattern.setTransform === 'function' && typeof DOMMatrix === 'function') {
    pattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
  }
  if (hatchCache.size >= HATCH_CACHE_LIMIT) hatchCache.delete(hatchCache.keys().next().value);
  hatchCache.set(key, pattern);
  return pattern;
}

/** Drops every cached hatch pattern (tests; a context loss). */
export function clearHatchCache() { hatchCache.clear(); }

// ------------------------------------------------------------------ envelopes

/**
 * Traces an envelope as one closed path: the max edge left to right, the min edge back. Each bin
 * is a flat step `w / bins` wide; silence keeps a 1 px line so the stem stays visible.
 */
function tracePath(ctx, data, {x, y, w, h, symmetric = false}) {
  const bins = data.length / 2;
  const mid = y + h / 2, amp = (h / 2) * AMPLITUDE, step = w / bins;
  const top = i => {
    const v = symmetric ? Math.max(Math.abs(data[2 * i]), Math.abs(data[2 * i + 1])) : data[2 * i + 1];
    return Math.min(mid - v * amp, mid - 0.5);
  };
  const bottom = i => {
    const v = symmetric ? -Math.max(Math.abs(data[2 * i]), Math.abs(data[2 * i + 1])) : data[2 * i];
    return Math.max(mid - v * amp, mid + 0.5);
  };
  ctx.beginPath();
  ctx.moveTo(x, top(0));
  for (let i = 0; i < bins; i++) {
    const t = top(i);
    ctx.lineTo(x + i * step, t);
    ctx.lineTo(x + (i + 1) * step, t);
  }
  for (let i = bins - 1; i >= 0; i--) {
    const b = bottom(i);
    ctx.lineTo(x + (i + 1) * step, b);
    ctx.lineTo(x + i * step, b);
  }
  ctx.closePath();
}

/** Paints one traced envelope in its state. */
function paint(ctx, data, box, {color, state = 'on', alpha = 1, dpr = 1, symmetric = false}) {
  if (!data.length) return;
  ctx.save();
  ctx.globalAlpha = state === 'out' ? 1 : alpha;   // muted is never shown with opacity
  tracePath(ctx, data, {...box, symmetric});
  if (state === 'out') {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = hatch(ctx, color, {dpr});
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.restore();
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.stroke();
  } else if (state === 'dim') {
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Stem rows (Stems surface, Edit · Map): one waveform per row, full width.
 *   rows: [{name, color, state: 'on'|'out'|'solo'|'dim', y, h}]   (CSS px; color: stem key, --token or colour)
 *   t0, t1: the visible window (s); width: CSS px; dpr: device pixel ratio; peaks: a PeaksCache
 * Sets the device-pixel transform, clears each row's band and draws one bin per device pixel.
 */
export function drawRows(ctx, {rows = [], t0, t1, width, dpr = 1, peaks}) {
  const bins = Math.max(1, Math.round(width * dpr));
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const row of rows) {
    ctx.clearRect(0, row.y, width, row.h);
    if (!peaks || row.h <= 0) continue;
    const data = peaks.range(row.name, t0, t1, bins);
    paint(ctx, data, {x: 0, y: row.y, w: width, h: row.h}, {color: resolveColor(row.color, row.name), state: row.state ?? 'on', dpr});
  }
  ctx.restore();
}

/**
 * A Road map bar cell's mini waveform: stacked stem envelopes over one box, your instrument
 * (`primary`) on top at full opacity, the others under it at 55%; muted stems as outline ghosts
 * with the hatch (so the hole you fill stays visible).
 *   stems: [{name, color, state, primary}]
 */
export function drawEnvelopeStack(ctx, {x, y, w, h, t0, t1, stems = [], peaks, dpr = 1}) {
  if (!peaks || w <= 0 || h <= 0) return;
  const bins = Math.max(1, Math.round(w * dpr));
  const box = {x, y, w, h};
  const rank = s => (s.primary ? 2 : s.state === 'out' ? 1 : 0);
  const order = stems.map((s, i) => ({s, i})).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i);
  for (const {s} of order) {
    const data = peaks.range(s.name, t0, t1, bins);
    paint(ctx, data, box, {color: resolveColor(s.color, s.name), state: s.state ?? 'on', alpha: s.primary ? 1 : SECONDARY_ALPHA, dpr, symmetric: true});
  }
}

/** The song strip's waveform (unmapped songs): the mix over the whole song, in --ink-3. */
export function drawStripWave(ctx, {w, h, peaks, duration, dpr = 1, color}) {
  if (!peaks || !(duration > 0) || w <= 0 || h <= 0) return;
  const data = peaks.range('mix', 0, duration, Math.max(1, Math.round(w * dpr)));
  paint(ctx, data, {x: 0, y: 0, w, h}, {color: color ? resolveColor(color) : readTokens().ink3, state: 'on', dpr});
}

// ------------------------------------------------------------------ grid

/** The smallest pixel gap between consecutive ticks of the given kinds (Infinity with fewer than two). */
function minGap(ticks, kinds, px) {
  let last = null, gap = Infinity;
  for (const tick of ticks) {
    if (!kinds.includes(tick.kind)) continue;
    const x = px(tick.t);
    if (last !== null) gap = Math.min(gap, Math.abs(x - last));
    last = x;
  }
  return gap;
}

/**
 * Grid lines from grid.js#gridTicks: beats (and subdivisions) at 8% --ink, bars at 18%. A kind is
 * drawn only when its lines are at least `minPx` apart (subdivisions are measured against every
 * line, beats against beats and bars, bars against bars), which removes the "blue barcode".
 * Returns which kinds were drawn: {bar, beat, sub}.
 */
export function drawGrid(ctx, {ticks = [], t0, t1, w, h, minPx = 6, y = 0}) {
  const drawn = {bar: false, beat: false, sub: false};
  const span = t1 - t0;
  if (!(span > 0) || !(w > 0) || !ticks.length) return drawn;
  const px = t => ((t - t0) / span) * w;
  const has = kind => ticks.some(tick => tick.kind === kind);
  drawn.bar = has('bar') && minGap(ticks, ['bar'], px) >= minPx;
  drawn.beat = has('beat') && minGap(ticks, ['bar', 'beat'], px) >= minPx;
  drawn.sub = has('sub') && (drawn.beat || !has('beat')) && minGap(ticks, ['bar', 'beat', 'sub'], px) >= minPx;
  if (!drawn.bar && !drawn.beat && !drawn.sub) return drawn;
  const {ink} = readTokens();
  ctx.save();
  ctx.fillStyle = ink;
  for (const kind of ['sub', 'beat', 'bar']) {
    if (!drawn[kind]) continue;
    ctx.globalAlpha = GRID_ALPHA[kind];
    for (const tick of ticks) {
      if (tick.kind !== kind || tick.t < t0 || tick.t > t1) continue;
      ctx.fillRect(Math.min(w - 1, Math.max(0, Math.round(px(tick.t)))), y, 1, h);
    }
  }
  ctx.restore();
  return drawn;
}
