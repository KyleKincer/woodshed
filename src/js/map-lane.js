// The tempo lane: a bar ruler over a tempo curve, drawn on one canvas that
// lines up with the waveform. Steady spans are steps, ramps are slopes, and a
// span that disagrees with its neighbours is drawn in the warning colour,
// which is usually a miscounted bar.
import {number, compare} from '../../shared/notation.ts';
import {pulseOf, sameMeter} from '../../shared/song-map.ts';

export const RULER = 22;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const trim = (bpm) => (Math.round(bpm * 10) / 10).toFixed(1).replace(/\.0$/, '');

/** Song-wide tempo segments in quarter notes per minute, clipped to the recording. */
export function segments(songMap, duration) {
  const c = songMap.compiled, first = c.pins[0], last = c.pins[c.pins.length - 1], out = [];
  if (first.time > 0) out.push({t0: 0, t1: Math.min(first.time, duration), q0: c.head * 60, q1: c.head * 60, kind: 'head'});
  c.spans.forEach((s, i) => { if (s.t0 < duration) out.push({t0: s.t0, t1: Math.min(s.t1, duration), q0: s.v0 * 60, q1: s.v1 * 60, kind: s.ramp ? 'ramp' : 'steady', span: s, index: i}); });
  if (last.time < duration) out.push({t0: last.time, t1: duration, q0: c.tail * 60, q1: c.tail * 60, kind: 'tail'});
  // A steady span that disagrees with the spans on both sides by more than 6% is suspect.
  out.forEach((seg, i) => {
    if (seg.kind !== 'steady' || seg.span.p1 - seg.span.p0 < 0.99) return;
    const around = [out[i - 1]?.q1, out[i + 1]?.q0].filter(Number.isFinite);
    if (around.length === 2 && around.every((ref) => Math.abs(seg.q0 / ref - 1) > 0.06)) seg.suspect = true;
  });
  return out;
}

/** A readable tempo range that ignores outliers (gaps between sections, miscounts). */
export function tempoRange(segs) {
  if (!segs.length) return {lo: 100, hi: 140};
  const weighted = segs.map((s) => ({q: (s.q0 + s.q1) / 2, w: Math.max(1e-3, s.t1 - s.t0)})).sort((a, b) => a.q - b.q);
  const total = weighted.reduce((n, s) => n + s.w, 0);
  let acc = 0, median = weighted[0].q;
  for (const s of weighted) { acc += s.w; if (acc >= total / 2) { median = s.q; break; } }
  const inRange = segs.filter((s) => Math.max(s.q0, s.q1) <= median * 1.5 && Math.min(s.q0, s.q1) >= median / 1.5);
  let lo = Math.min(...inRange.map((s) => Math.min(s.q0, s.q1))), hi = Math.max(...inRange.map((s) => Math.max(s.q0, s.q1)));
  if (!Number.isFinite(lo)) { lo = median; hi = median; }
  const pad = Math.max(4, (hi - lo) * 0.18);
  return {lo: Math.max(1, lo - pad), hi: hi + pad};
}

/** Two or three round guide values inside the range. */
export function guides({lo, hi}) {
  const step = [1, 2, 5, 10, 20, 25, 50, 100].find((s) => (hi - lo) / s <= 3) || 200;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

export function drawLane(canvas, {songMap, view, timeToX, duration, cursorQ, hoverPin, color}) {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const x = (t) => timeToX(t), visible = (t) => t >= view.start - 1e-6 && t <= view.end + 1e-6;
  const segs = segments(songMap, duration), range = tempoRange(segs);
  const top = RULER + 12, bottom = h - 8;
  const y = (q) => bottom - (Math.min(Math.max(q, range.lo), range.hi) - range.lo) / (range.hi - range.lo) * (bottom - top);
  const starts = songMap.starts, measures = songMap.data.measures;
  const cursor = number(cursorQ), bar = songMap.barIndexAt(cursor);

  // Selected bar, across the whole lane.
  const barA = x(songMap.timeAt(starts[bar])), barB = x(songMap.timeAt(number(starts[bar]) + number(measures[bar].length)));
  ctx.fillStyle = color.selected; ctx.fillRect(barA, 0, barB - barA, h);

  // Guides behind the curve.
  ctx.strokeStyle = color.minor; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
  for (const g of guides(range)) { const gy = Math.round(y(g)) + 0.5; ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }
  ctx.setLineDash([]);

  // Bar ruler: ticks, numbers, meter chips and section labels.
  ctx.fillStyle = color.ruler; ctx.fillRect(0, 0, w, RULER);
  ctx.fillStyle = color.border; ctx.fillRect(0, RULER, w, 1);
  const inView = [];
  measures.forEach((m, i) => { const t = songMap.timeAt(starts[i]); if (visible(t) && t < duration) inView.push({i, m, t, px: x(t)}); });
  const average = inView.length > 1 ? (inView[inView.length - 1].px - inView[0].px) / (inView.length - 1) : w;
  const every = [1, 2, 4, 8, 16, 32, 64].find((n) => n * average >= 26) || 128;
  let right = -Infinity;
  for (const {i, m, px} of inView) {
    ctx.fillStyle = color.border; ctx.fillRect(Math.round(px), 0, 1, RULER);
    ctx.fillStyle = color.minor; ctx.fillRect(Math.round(px), RULER + 1, 1, h - RULER);
    const change = i > 0 && !sameMeter(m, measures[i - 1]), selected = i === bar;
    if (!(i % every === 0 || change || m.label || selected) || px + 3 < right) continue;
    let cx = px + 4;
    ctx.font = `${selected ? 700 : 500} 10px ${MONO}`; ctx.fillStyle = selected ? color.accent : color.muted;
    ctx.fillText(String(i + 1), cx, 15); cx += ctx.measureText(String(i + 1)).width + 5;
    if (change || i === 0) {
      const meter = `${m.numerator}/${m.denominator}`;
      ctx.font = `600 10px ${MONO}`;
      const mw = ctx.measureText(meter).width + 8;
      ctx.fillStyle = color.text; ctx.fillRect(cx, 5, mw, 13);
      ctx.fillStyle = color.paper; ctx.fillText(meter, cx + 4, 15); cx += mw + 5;
    }
    if (m.label) { ctx.font = `600 11px Arial, Helvetica, sans-serif`; ctx.fillStyle = color.text; ctx.fillText(m.label, cx, 15); cx += ctx.measureText(m.label).width + 4; }
    right = cx;
  }

  // Tempo curve: soft fill, then the line; suspect spans in the warning colour.
  const points = [];
  for (const s of segs) {
    if (s.t1 < view.start || s.t0 > view.end) continue;
    const a = Math.max(s.t0, view.start), b = Math.min(s.t1, view.end), path = [];
    if (s.kind === 'ramp') { const n = Math.max(2, Math.ceil((x(b) - x(a)) / 6)); for (let k = 0; k <= n; k++) { const t = a + (b - a) * k / n; path.push([x(t), y(songMap.qpmAt(t))]); } }
    else path.push([x(a), y(s.q0)], [x(b), y(s.q1)]);
    points.push({s, path});
  }
  ctx.beginPath();
  points.forEach(({path}, k) => path.forEach(([px, py], j) => (k === 0 && j === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py))));
  if (points.length) {
    const lastPath = points[points.length - 1].path, firstPath = points[0].path;
    ctx.lineTo(lastPath[lastPath.length - 1][0], bottom + 8); ctx.lineTo(firstPath[0][0], bottom + 8); ctx.closePath();
    ctx.fillStyle = color.fill; ctx.fill();
  }
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  points.forEach(({s, path}, k) => {
    const previous = points[k - 1]?.path;
    if (previous) { ctx.strokeStyle = color.connector; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(...previous[previous.length - 1]); ctx.lineTo(...path[0]); ctx.stroke(); }
    ctx.strokeStyle = s.suspect ? color.warn : s.kind === 'tail' || s.kind === 'head' ? color.open : color.accent;
    ctx.lineWidth = 2; ctx.setLineDash(s.kind === 'tail' || s.kind === 'head' ? [5, 4] : []);
    ctx.beginPath(); path.forEach(([px, py], j) => (j ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.stroke();
  });
  ctx.setLineDash([]);

  // The selected line runs under the pins and labels.
  const selectedTime = songMap.timeAt(cursorQ);
  if (visible(selectedTime)) { ctx.fillStyle = color.accent; ctx.fillRect(Math.round(x(selectedTime)) - 1, RULER + 1, 2, h - RULER - 1); }

  // Span tempos, in the felt pulse where it isn't a quarter note.
  ctx.font = `600 10px ${MONO}`; ctx.textAlign = 'center';
  for (const {s, path} of points) {
    const a = path[0][0], b = path[path.length - 1][0];
    if (b - a < 58) continue;
    const index = songMap.barIndexAt(songMap.positionAt((Math.max(s.t0, view.start) + Math.min(s.t1, view.end)) / 2)), pulse = pulseOf(measures[index]);
    const unit = pulse === 1 ? '' : songMap.pulseLabel(index), q0 = s.q0 / pulse, q1 = s.q1 / pulse;
    const text = unit + (s.kind === 'ramp' ? `${trim(q0)}→${trim(q1)}` : trim(q0)) + (s.kind === 'tail' ? ' →' : '');
    const ly = Math.max(RULER + 11, Math.min(...path.map((p) => p[1])) - 6);
    ctx.lineWidth = 3; ctx.strokeStyle = color.paper; ctx.strokeText(text, (a + b) / 2, ly);
    ctx.fillStyle = s.suspect ? color.warn : s.kind === 'tail' || s.kind === 'head' ? color.muted : color.text; ctx.fillText(text, (a + b) / 2, ly);
  }
  ctx.textAlign = 'left';

  // Pins sit on the curve at the start of the span they begin.
  const hits = [], shown = songMap.compiled.pins.filter((p) => visible(p.time));
  // Dense pins (a tapped or detected map) draw smaller so the curve stays readable.
  const dense = shown.length > 1 && (x(shown[shown.length - 1].time) - x(shown[0].time)) / (shown.length - 1) < 14;
  for (const p of shown) {
    const px = x(p.time), py = y(songMap.qpmAt(p.time + 1e-6)), selected = compare(p.position, cursorQ) === 0, size = selected ? 10 : dense ? 5 : 8;
    ctx.fillStyle = color.paper; ctx.fillRect(px - size / 2 - 2, py - size / 2 - 2, size + 4, size + 4);
    ctx.fillStyle = selected ? color.accentFill : color.text; ctx.fillRect(px - size / 2, py - size / 2, size, size);
    if (hoverPin && compare(hoverPin.position, p.position) === 0) { ctx.strokeStyle = color.accent; ctx.lineWidth = 1.5; ctx.strokeRect(px - size / 2 - 3.5, py - size / 2 - 3.5, size + 7, size + 7); }
    hits.push({pin: p, x: px, y: py});
  }
  // An unpinned selection shows where it sits on the curve.
  const t = selectedTime;
  if (visible(t) && !songMap.compiled.pins.some((p) => compare(p.position, cursorQ) === 0)) {
    const px = x(t), py = y(songMap.qpmAt(t));
    ctx.fillStyle = color.paper; ctx.fillRect(px - 6, py - 6, 12, 12);
    ctx.strokeStyle = color.accent; ctx.lineWidth = 2; ctx.strokeRect(px - 4, py - 4, 8, 8);
  }
  return {range, guides: guides(range).map((g) => ({value: g, y: y(g)})), hits, top};
}
