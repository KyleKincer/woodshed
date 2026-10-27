// Turn imported percussion onsets into an editable draft. The source's note
// lengths are MIDI playback gates, so written durations are inferred from the
// next onset in each voice instead of pretending those gates are notation.
import {KIT, fraction, number, durationOf, id, starts, musicalStarts, extent, toTime, validateTimeline, validateScore, MAX_HITS, MAX_HITS_PER_BAR} from '../../../shared/notation.ts';
import {toTimeline} from '../../../shared/song-map.ts';

const exactKit = new Map(KIT.map(item => [item.midi, item]));
// GM timbral variants that the smaller Woodshed kit can reasonably group.
// These are reported explicitly; other percussion instruments are skipped.
const variants = new Map([
  [35, 'kick'], [40, 'snare'], [41, 'floorTom'], [45, 'floorTom'],
  [47, 'rackTom'], [50, 'rackTom'], [55, 'crash'], [57, 'crash'], [59, 'ride'],
]);
const durationChoices = [];
for (const value of [4, 8, 16, 32, 64]) for (const dotted of [false, true]) for (const tuplet of [1, 3, 5, 7]) {
  const duration = durationOf(value, dotted, tuplet);
  if (number(duration) <= 1) durationChoices.push({value, dotted, tuplet, duration});
}
durationChoices.sort((a, b) => number(b.duration) - number(a.duration) || a.tuplet - b.tuplet || Number(a.dotted) - Number(b.dotted));

/** Nearest readable rhythmic position, retaining straight and 3/5/7 tuplets. */
function snappedPosition(q) {
  let best = null, distance = Infinity;
  for (const denominator of [16, 24, 40, 56, 96]) {
    const candidate = fraction(Math.round(q * denominator), denominator), d = Math.abs(number(candidate) - q);
    if (d < distance - 1e-10 || (Math.abs(d - distance) < 1e-10 && candidate.d < best.d)) { best = candidate; distance = d; }
  }
  return best;
}
const kitFor = midi => exactKit.get(midi) || KIT.find(item => item.id === variants.get(midi));

/**
 * `hits`: {q, midi, velocity, durationQ?}[] in quarter-note coordinates.
 * `timing`: the chosen SongMapData or Timeline, with IDs matching the song.
 * No existing score or timing object is changed. A caller must explicitly
 * adopt the returned draft through the active notation editor/store.
 */
export function importDrumHits(hits, timing, {title = 'Imported drums', source = 'midi', duration} = {}) {
  if (!Array.isArray(hits)) throw new Error('The file does not contain a drum-note list.');
  if (hits.length > MAX_HITS) throw new Error(`This drum part exceeds ${MAX_HITS.toLocaleString()} hits. Import a shorter passage.`);
  const timeline = timing?.pins ? toTimeline(structuredClone(timing)) : structuredClone(timing);
  if (!timeline) throw new Error('Choose a tempo map before importing drum notation.');
  validateTimeline(timeline);
  const positions = starts(timeline), exactStarts = musicalStarts(timeline), end = extent(timeline), barSlots = new Map(), unsupported = new Set(), grouped = new Set();
  let malformed = 0, outside = 0, duplicates = 0, quantized = 0, unrepresentable = 0;
  const candidates = [];
  for (const raw of hits) {
    if (!raw || !Number.isFinite(raw.q) || !Number.isInteger(raw.midi) || raw.midi < 0 || raw.midi > 127 || !Number.isFinite(raw.velocity) || raw.velocity <= 0 || raw.velocity > 1) { malformed++; continue; }
    const kit = kitFor(raw.midi);
    if (!kit) { unsupported.add(raw.midi); continue; }
    if (!exactKit.has(raw.midi)) grouped.add(raw.midi);
    // Avoid huge integer products before creating musical fractions.
    if (raw.q < 0 || raw.q >= end) { outside++; continue; }
    const q = snappedPosition(raw.q), value = number(q);
    if (value < 0 || value >= end || toTime(timeline, value) < -1e-8 || (Number.isFinite(duration) && toTime(timeline, value) >= duration)) { outside++; continue; }
    let bar = 0;
    // A binary lookup keeps large imports fast.
    let low = 0, high = positions.length - 1;
    while (low <= high) { const mid = (low + high) >> 1; if (positions[mid] <= value + 1e-9) { bar = mid; low = mid + 1; } else high = mid - 1; }
    // Subtract exact accumulated bar lengths, retaining mixed-meter fractions.
    const start = exactStarts[bar];
    const exactOffset = fraction(q.n * start.d - start.n * q.d, q.d * start.d);
    if (Math.abs(value - raw.q) > 1e-7) quantized++;
    const slot = `${bar}:${number(exactOffset)}:${kit.id}`;
    const existing = barSlots.get(slot);
    if (existing) { duplicates++; existing.velocity = Math.max(existing.velocity, raw.velocity); continue; }
    const entry = {bar, q: value, offset: exactOffset, kit, velocity: raw.velocity};
    barSlots.set(slot, entry); candidates.push(entry);
  }
  candidates.sort((a, b) => a.bar - b.bar || a.q - b.q || a.kit.id.localeCompare(b.kit.id));
  const bars = new Map();
  // Voice onset boundaries keep simultaneous instruments on the same stem
  // duration and avoid a sustained MIDI cymbal creating overlapping notation.
  const voiceOnsets = new Map();
  for (const hit of candidates) {
    const key = `${hit.bar}:${hit.kit.voice}`;
    if (!voiceOnsets.has(key)) voiceOnsets.set(key, []);
    const onsets = voiceOnsets.get(key);
    if (onsets.at(-1) !== hit.q) onsets.push(hit.q);
  }
  for (const hit of candidates) {
    const measure = timeline.measures[hit.bar], onsets = voiceOnsets.get(`${hit.bar}:${hit.kit.voice}`);
    let low = 0, high = onsets.length;
    while (low < high) { const mid = (low + high) >> 1; if (onsets[mid] <= hit.q + 1e-9) low = mid + 1; else high = mid; }
    const next = onsets[low] ?? positions[hit.bar] + number(measure.length);
    const available = next - hit.q;
    const written = durationChoices.find(choice => number(choice.duration) <= available + 1e-9);
    if (!written) { unrepresentable++; continue; }
    let bar = bars.get(measure.id);
    if (!bar) { bar = {measureId: measure.id, coverage: 'progress', hits: []}; bars.set(measure.id, bar); }
    if (bar.hits.length >= MAX_HITS_PER_BAR) throw new Error(`Bar ${hit.bar + 1} exceeds ${MAX_HITS_PER_BAR} drum hits. Import a shorter or simpler part.`);
    bar.hits.push({id: id(), offset: hit.offset, instrument: hit.kit.id, voice: hit.kit.voice,
      ...structuredClone(written), accent: false, ghost: false, flam: false, sticking: '', velocity: Math.max(0.05, hit.velocity)});
  }
  const score = {version: 1, title: String(title || 'Imported drums').trim().slice(0, 100) || 'Imported drums', timeline, bars: [...bars.values()]};
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
  if (unrepresentable) warnings.push(`${unrepresentable} drum hit${unrepresentable === 1 ? ' was' : 's were'} too close to another beat or bar line to represent and ${unrepresentable === 1 ? 'was' : 'were'} skipped.`);
  if (importedCount) warnings.push('Written durations were inferred from drum onsets. Imported bars are drafts; check them before marking them reviewed.');
  return {score, warnings, importedCount, skippedCount};
}
