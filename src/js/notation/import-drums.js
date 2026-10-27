// Turn imported percussion onsets into an editable drum part. Sources give
// *when* each hit sounds (and, for Guitar Pro, how it is played); written
// rhythm is derived later by shared/engrave.ts, so MIDI note gates and
// authored durations are never treated as notation.
import {KIT, fraction, number, id, starts, musicalStarts, extent, toTime, validateTimeline, validateScore, compare, add, MAX_HITS, MAX_HITS_PER_BAR, MAX_TUPLETS_PER_BAR} from '../../../shared/notation.ts';
import {rhythmCells} from '../../../shared/engrave.ts';
import {toTimeline} from '../../../shared/song-map.ts';

// Exact General MIDI → kit piece. Choke and edge articulations share a MIDI
// note with the plain hit, so only the first (plain) piece claims a note.
const exactKit = new Map();
for (const piece of KIT) if (!exactKit.has(piece.midi) && !/Choke|Edge|halfHat/.test(piece.id)) exactKit.set(piece.midi, piece);
// GM timbral variants the kit can reasonably group. Reported to the user.
const variants = new Map([[35, 'kick'], [59, 'ride'], [40, 'snare'], [31, 'crossStick'], [33, 'crossStick'], [34, 'snare']]);
const kitFor = midi => exactKit.get(midi) || KIT.find(item => item.id === variants.get(midi));
const byId = new Map(KIT.map(k => [k.id, k]));
// Guitar Pro articulation ids, including chokes, edges and half-open hi-hat.
const byGp = new Map(KIT.map(k => [k.gp, k]));

// Grids per rhythm cell, simplest first. A cell is a counted beat.
const GRIDS = [1, 2, 4, 3, 8, 6, 16, 12, 5, 7, 10, 24, 32, 20, 28, 14, 9];
// Exact sources (notation exports) must land exactly; performances are
// snapped to the simplest grid within these tolerances, in quarter notes.
const TOLERANCES = [1e-6, 0.03, 0.06];

/** Choose one grid for every onset in a cell (all voices together). */
function cellGrid(length, rel, forced) {
  const L = number(length);
  const errors = s => rel.map(r => { const u = L / s; return Math.abs(r - Math.round(r / u) * u); });
  if (forced) return forced;
  const usable = GRIDS.filter(s => L / s >= 1 / 32 - 1e-9);
  for (const tolerance of TOLERANCES) {
    const s = usable.find(s => Math.max(0, ...errors(s)) <= tolerance);
    if (s) return s;
  }
  return usable.reduce((best, s) => Math.max(...errors(s)) < Math.max(...errors(best)) ? s : best, usable[0]);
}

/**
 * `hits`: {q, midi, velocity, instrument?, gp?, accent?, heavy?, ghost?, flam?, drag?, roll?, sticking?}[]
 *   in quarter-note coordinates from bar 1.
 * `timing`: the chosen SongMapData or Timeline, with IDs matching the song.
 * `options.tuplets`: {q, length, count}[] explicit tuplets from notation sources.
 * No existing score or timing object is changed. A caller must explicitly
 * adopt the returned draft through the active notation editor/store.
 */
export function importDrumHits(hits, timing, {title = 'Imported drums', source = 'midi', duration, tuplets = []} = {}) {
  if (!Array.isArray(hits)) throw new Error('The file does not contain a drum-note list.');
  if (hits.length > MAX_HITS) throw new Error(`This drum part exceeds ${MAX_HITS.toLocaleString()} hits. Import a shorter passage.`);
  const timeline = timing?.pins ? toTimeline(structuredClone(timing)) : structuredClone(timing);
  if (!timeline) throw new Error('Choose a tempo map before importing drum notation.');
  validateTimeline(timeline);
  const positions = starts(timeline), exactStarts = musicalStarts(timeline), end = extent(timeline), unsupported = new Set(), grouped = new Set();
  let malformed = 0, outside = 0, duplicates = 0, quantized = 0;
  const barAt = value => { let bar = 0, low = 0, high = positions.length - 1; while (low <= high) { const mid = (low + high) >> 1; if (positions[mid] <= value + 1e-9) { bar = mid; low = mid + 1; } else high = mid - 1; } return bar; };

  // Explicit tuplets (Guitar Pro) become per-bar spans when they fit a bar.
  const spans = new Map();
  for (const t of Array.isArray(tuplets) ? tuplets : []) {
    if (!t || !Number.isFinite(t.q) || !Number.isFinite(t.length) || !Number.isInteger(t.count) || t.count < 2 || t.count > 16 || t.length <= 0) continue;
    const bar = barAt(t.q), start = t.q - positions[bar], measure = timeline.measures[bar];
    const startF = fraction(Math.round(start * 960), 960), lengthF = fraction(Math.round(t.length * 960), 960);
    if (Math.abs(number(startF) - start) > 1e-6 || compare(add(startF, lengthF), measure.length) > 0) continue;
    const list = spans.get(bar) || [];
    if (list.length < MAX_TUPLETS_PER_BAR && !list.some(s => compare(s.start, add(startF, lengthF)) < 0 && compare(startF, add(s.start, s.length)) < 0)) list.push({start: startF, length: lengthF, count: t.count});
    spans.set(bar, list);
  }

  // Resolve kit pieces and group raw onsets by bar.
  const byBar = new Map();
  for (const raw of hits) {
    if (!raw || !Number.isFinite(raw.q) || !Number.isInteger(raw.midi) || raw.midi < 0 || raw.midi > 127 || !Number.isFinite(raw.velocity) || raw.velocity <= 0 || raw.velocity > 1) { malformed++; continue; }
    const kit = byId.get(raw.instrument) || byGp.get(raw.gp) || kitFor(raw.midi);
    if (!kit) { unsupported.add(raw.midi); continue; }
    if (!raw.instrument && !byGp.has(raw.gp) && !exactKit.has(raw.midi)) grouped.add(raw.midi);
    if (raw.q < -1e-9 || raw.q >= end) { outside++; continue; }
    const bar = barAt(raw.q);
    if (!byBar.has(bar)) byBar.set(bar, []);
    byBar.get(bar).push({raw, kit, rel: Math.max(0, raw.q - positions[bar])});
  }

  // Snap each beat cell to one grid, so a beat never mixes 16ths and triplets
  // because of performance timing.
  const placed = [];
  for (const [bar, list] of byBar) {
    const measure = timeline.measures[bar], cells = rhythmCells(measure, spans.get(bar) || []);
    for (const cell of cells) {
      const start = number(cell.start), length = number(cell.length);
      const inside = list.filter(h => h.rel >= start - 1e-9 && h.rel < start + length - 1e-9);
      if (!inside.length) continue;
      const s = cellGrid(cell.length, inside.map(h => h.rel - start), cell.forced);
      for (const h of inside) {
        const steps = Math.round((h.rel - start) * s / length);
        if (Math.abs(steps * length / s - (h.rel - start)) > 1e-7) quantized++;
        const offset = add(cell.start, fraction(steps * cell.length.n, cell.length.d * s));
        placed.push({...h, bar, offset});
      }
    }
  }
  // A late hit can round onto the next downbeat.
  for (const h of placed) {
    if (compare(h.offset, timeline.measures[h.bar].length) >= 0) {
      const absolute = add(exactStarts[h.bar], h.offset);
      if (number(absolute) >= end - 1e-9) { h.drop = true; continue; }
      h.bar = barAt(number(absolute)); h.offset = fraction(absolute.n * exactStarts[h.bar].d - exactStarts[h.bar].n * absolute.d, absolute.d * exactStarts[h.bar].d);
    }
    const q = number(add(exactStarts[h.bar], h.offset));
    if (toTime(timeline, q) < -1e-8 || (Number.isFinite(duration) && toTime(timeline, q) >= duration)) h.drop = true;
  }

  const bars = new Map(), slots = new Map();
  for (const h of placed.sort((a, b) => a.bar - b.bar || compare(a.offset, b.offset))) {
    if (h.drop) { outside++; continue; }
    const slot = `${h.bar}:${h.offset.n}/${h.offset.d}:${h.kit.id}`, existing = slots.get(slot);
    if (existing) { duplicates++; existing.velocity = Math.max(existing.velocity, Math.max(.05, h.raw.velocity)); existing.accent ||= !!h.raw.accent; continue; }
    const measure = timeline.measures[h.bar];
    let bar = bars.get(measure.id);
    if (!bar) { bar = {measureId: measure.id, coverage: 'progress', hits: []}; bars.set(measure.id, bar); const list = spans.get(h.bar); if (list?.length) bar.tuplets = list.sort((a, b) => compare(a.start, b.start)); }
    if (bar.hits.length >= MAX_HITS_PER_BAR) throw new Error(`Bar ${h.bar + 1} exceeds ${MAX_HITS_PER_BAR} drum hits. Import a shorter or simpler part.`);
    const r = h.raw, hit = {id: id(), offset: h.offset, instrument: h.kit.id, voice: h.kit.voice,
      accent: !!(r.accent || r.heavy), ghost: !!r.ghost, flam: !!r.flam && !r.drag, sticking: ['L', 'R'].includes(r.sticking) ? r.sticking : '', velocity: Math.min(1, Math.max(0.05, r.velocity))};
    if (r.heavy) hit.heavy = true;
    if (r.drag) hit.drag = true;
    if ([1, 2, 3].includes(r.roll)) hit.roll = r.roll;
    bar.hits.push(hit); slots.set(slot, hit);
  }
  // Explicit tuplets that only restate the automatic beat grid, or that
  // cannot be written, are dropped; the automatic grid then applies.
  for (const bar of bars.values()) if (bar.tuplets) {
    const measure = timeline.measures.find(m => m.id === bar.measureId), cells = rhythmCells(measure);
    bar.tuplets = bar.tuplets.filter(span => {
      const cell = cells.find(c => compare(c.start, span.start) === 0 && compare(c.length, span.length) === 0);
      if (!cell) return true;
      const end = add(span.start, span.length), rel = bar.hits.filter(h => compare(h.offset, span.start) >= 0 && compare(h.offset, end) < 0).map(h => number(h.offset) - number(span.start));
      return cellGrid(span.length, rel, null) !== span.count;
    });
    if (!bar.tuplets.length) { delete bar.tuplets; continue; }
    try { validateScore({version: 2, title: 'check', timeline: {...timeline, measures: [measure]}, bars: [bar]}); }
    catch { delete bar.tuplets; }
  }
  const score = {version: 2, title: String(title || 'Imported drums').trim().slice(0, 100) || 'Imported drums', timeline, bars: [...bars.values()]};
  validateScore(score);
  const importedCount = score.bars.reduce((sum, bar) => sum + bar.hits.length, 0), skippedCount = hits.length - importedCount;
  const warnings = [];
  if (source === 'chart') warnings.push('Rhythm-game drum lanes are an approximate starting point; check the kit and missing hits against the recording.');
  if (unsupported.size) warnings.push(`Unsupported GM percussion notes were skipped: ${[...unsupported].sort((a, b) => a - b).join(', ')}.`);
  if (grouped.size) warnings.push(`GM drum variants were grouped into the Woodshed kit: ${[...grouped].sort((a, b) => a - b).map(midi => `${midi} → ${kitFor(midi).name}`).join(', ')}.`);
  if (quantized) warnings.push(`${quantized} note position${quantized === 1 ? ' was' : 's were'} rounded to the nearest rhythmic grid. Check expressive timing.`);
  if (duplicates) warnings.push(`${duplicates} duplicate drum hit${duplicates === 1 ? ' was' : 's were'} combined.`);
  if (outside) warnings.push(`${outside} drum hit${outside === 1 ? ' lies' : 's lie'} outside the recording or mapped bars and ${outside === 1 ? 'was' : 'were'} skipped.`);
  if (malformed) warnings.push(`${malformed} invalid drum event${malformed === 1 ? ' was' : 's were'} skipped.`);
  if (importedCount) warnings.push('Imported bars are drafts; check them against the recording before marking them reviewed.');
  return {score, warnings, importedCount, skippedCount};
}
