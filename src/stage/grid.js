// Grid ticks and snapping for the Stems surface and Edit · Map (architecture
// §2.14.13). Pure: `map` is a SongMapStore (its `bars`, `timeAt`, `positionAt`,
// `barIndexAt`, `barBeatAt` and `snapTime`), or null for an unmapped song.
//
// Divisions (the Stems toolbar's `Grid: Bar · Beat · ½ · ¼`):
//   bar      bar lines
//   beat     plus every counted beat (the meter's grouping: 7/8 2+2+3 has three)
//   half     plus one subdivision level: a one-unit beat splits in two (4/4 → eighths);
//            a grouped beat splits into its units (6/8 → eighths, 7/8 2+2+3 → eighths)
//   quarter  plus two levels: each of those halves again (4/4 → sixteenths, 6/8 → sixteenths)
// A pickup bar's start is a counted beat, not a bar line.
//
// Unmapped songs have no grid: gridTicks returns [] and snapTime rounds to 0.1 s
// (spec §4.8: "a loop snapped to bars, or 0.1 s unmapped").

export const DIVISIONS = Object.freeze(['bar', 'beat', 'half', 'quarter']);
export const UNMAPPED_STEP = 0.1;
const EPS = 1e-9;

function checkDivision(division) {
  if (!DIVISIONS.includes(division)) throw new TypeError(`Unknown grid division: ${division}`);
}

/** Quarter-note length of a bar's meter unit. */
const unitQ = bar => 4 / bar.denominator;

/** Subdivision steps (quarters) of one counted beat of `units` meter units. */
function subSteps(units, unit, division) {
  if (division === 'half') return units === 1 ? unit / 2 : unit;
  if (division === 'quarter') return (units === 1 ? unit / 2 : unit) / 2;
  return 0;
}

/**
 * Musical positions of one bar's lines, in quarters from the bar start: [{q, kind}], in order.
 * Counted beats follow the bar's groups (as SongMapStore#_onsets does: truncated at the bar's end).
 */
function barLines(bar, division) {
  const length = bar.q1 - bar.q0, unit = unitQ(bar), out = [{q: 0, kind: bar.pickup ? 'beat' : 'bar'}];
  if (division === 'bar') return out;
  let q = 0;
  for (const g of bar.groups) {
    if (q >= length - 1e-7) break;
    const beatLength = g * unit;
    if (q > 0) out.push({q, kind: 'beat'});
    const step = subSteps(g, unit, division);
    if (step > 0) {
      for (let s = q + step; s < Math.min(q + beatLength, length) - 1e-7; s += step) out.push({q: s, kind: 'sub'});
    }
    q += beatLength;
  }
  return out;
}

/**
 * Grid lines in [t0, t1] (media seconds): [{t, kind: 'bar'|'beat'|'sub'}], in time order. The end
 * of the last bar is a bar line too. Unmapped (`map` null) → [].
 */
export function gridTicks(map, t0, t1, division) {
  checkDivision(division);
  if (!map || !(t1 >= t0)) return [];
  const bars = map.bars;
  if (!bars?.length) return [];
  const out = [];
  const first = Math.max(0, map.barIndexAt(t0));
  const last = map.barIndexAt(t1);
  for (let i = first; i <= last && i < bars.length; i++) {
    const bar = bars[i];
    if (bar.t0 > t1 + EPS) break;
    for (const line of barLines(bar, division)) {
      const t = line.q === 0 ? bar.t0 : map.timeAt(bar.q0 + line.q);
      if (t >= t0 - EPS && t <= t1 + EPS) out.push({t, kind: line.kind});
    }
  }
  const end = bars[bars.length - 1].t1;
  if (last >= bars.length - 1 && end >= t0 - EPS && end <= t1 + EPS && (!out.length || out[out.length - 1].t < end - EPS)) out.push({t: end, kind: 'bar'});
  return out;
}

const pick = (t, down, up, mode) => {
  if (mode === 'floor') return down;
  if (mode === 'ceil') return up;
  return t - down <= up - t ? down : up;
};

/**
 * Snaps a time to the grid: the nearest (or floor / ceil) bar line, counted beat or subdivision.
 * 'bar' and 'beat' are SongMapStore#snapTime exactly (including the extrapolated grid before bar 0
 * and `t` itself past the end); subdivisions split the counted beat around `t`. Unmapped → 0.1 s.
 */
export function snapTime(map, t, division, {mode = 'nearest'} = {}) {
  checkDivision(division);
  if (!['nearest', 'floor', 'ceil'].includes(mode)) throw new TypeError(`Unknown snap mode: ${mode}`);
  if (!map) {
    const n = t / UNMAPPED_STEP;
    const k = mode === 'floor' ? Math.floor(n + EPS) : mode === 'ceil' ? Math.ceil(n - EPS) : Math.round(n);
    return Math.max(0, Math.round(k * UNMAPPED_STEP * 1e6) / 1e6);
  }
  if (division === 'bar' || division === 'beat') return map.snapTime(t, division, {mode});
  const down = map.snapTime(t, 'beat', {mode: 'floor'});
  const up = map.snapTime(t, 'beat', {mode: 'ceil'});
  if (Math.abs(up - down) < EPS) return down;
  // The counted beat that contains t: its meter units decide the subdivision.
  const bars = map.bars;
  const info = map.barBeatAt(down + 1e-6);
  const ref = info.before ? (bars[0].pickup && bars[1] ? bars[1] : bars[0]) : bars[info.index];
  const units = info.groups?.[info.groupIndex] ?? 1;
  const step = subSteps(units, unitQ(ref), division);
  const qDown = map.positionAt(down), qUp = map.positionAt(up);
  const points = [down];
  for (let q = qDown + step; q < qUp - 1e-7; q += step) points.push(map.timeAt(q));
  points.push(up);
  const below = points.filter(p => p <= t + 1e-6), above = points.filter(p => p >= t - 1e-6);
  const lo = below.length ? Math.max(...below) : down, hi = above.length ? Math.min(...above) : up;
  return pick(t, lo, hi, mode);
}
