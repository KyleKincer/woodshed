// The files Export song writes for other apps (DAWs, Guitar Pro, notation apps). Pure: no DOM, no network,
// no AudioContext, so every byte is unit-tested in Node.
//
//   alignment(mapData, duration) → {leadBars, leadQuarters, leadSeconds, padSeconds, numerator, denominator, qpm}
//     Every exported file shares one timeline that starts on a bar line, so a DAW's bar grid fits the audio:
//     `leadBars` whole bars of the song's first meter and tempo come before the song's bar 1, and the WAVs
//     start with `padSeconds` of silence so the recording's bar 1 lands exactly where the MIDI files put it.
//     When bar 1 already starts at 0 s there is no lead-in and no padding.
//   wavHeader(frames, channels, sampleRate) → Uint8Array          a 44-byte 16-bit PCM header
//   wavChunks(channels, sampleRate, {padFrames, chunkFrames}) → Generator<Uint8Array>
//     The header, then interleaved 16-bit PCM (`padFrames` of silence first), a chunk at a time.
//   mixdown(tracks) → Float32Array[]                               tracks: [[left, right?], …] summed; scaled
//                                                                   down to just under full scale if it would clip
//   tempoMapMidi(mapData, duration, {title}) → Uint8Array          SMF type 1 with one conductor track: tempo
//                                                                   (ramps in 16th-note steps), meters, sections
//   drumChartMidi(score, mapData, duration, {title}) → Uint8Array  the conductor track plus General MIDI drums
//                                                                   on channel 10, on the same timeline
//   tooSlowBar(mapData, duration) → index|null                     the first bar (measure index) slower than a
//                                                                   MIDI tempo can be; the MIDI drifts from there
//   mapSeconds(mapData) → number                                   where the map's last bar ends, in seconds
//   guitarProFile(at, score, {title, artist}) → Uint8Array         Guitar Pro 7 (.gp) through alphaTab (`at`);
//                                                                   it starts at the song's bar 1 (no lead-in)
//   readme(facts) → string                                         README.txt
import {KIT, fraction, number} from '../../shared/notation.ts';
import {compile, fullLength, measureStarts, pulseOf, sectionsOf, timeAt, velocityAt} from '../../shared/song-map.ts';
import {buildAlphaTabScore} from '../js/notation/alphatab-score.js';

/** MIDI ticks per quarter note. */
export const PPQ = 960;
/** Ramps become tempo steps this long (in quarter notes). */
export const RAMP_STEP_Q = 0.25;
/** A bar 1 this close to 0 s needs no lead-in. */
const ALIGN_EPS = 0.0005;
/** The slowest tempo a MIDI file can state: 0xFFFFFF µs (16.8 s) per quarter note. */
const MAX_US = 0xffffff;

const KIT_BY_ID = new Map(KIT.map(k => [k.id, k]));
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------------------------------------------
// The shared timeline

export function alignment(mapData, duration = Infinity) {
  const c = compile(mapData), first = mapData.measures[0];
  const numerator = first?.numerator ?? 4, denominator = first?.denominator ?? 4;
  const leadQuarters = number(fullLength({numerator, denominator}));
  const qps = velocityAt(c, 0), qpm = qps * 60;
  const leadSeconds = leadQuarters / qps;
  const t0 = timeAt(c, 0);
  if (Math.abs(t0) < ALIGN_EPS || !(leadSeconds > 0)) return {leadBars: 0, leadQuarters, leadSeconds, padSeconds: 0, numerator, denominator, qpm, bar1: t0, duration};
  // Enough whole bars to cover the audio before bar 1 (at least one when bar 1 starts before the audio does).
  const leadBars = t0 > 0 ? Math.max(1, Math.ceil(t0 / leadSeconds - 1e-9)) : 1;
  const padSeconds = Math.max(0, leadBars * leadSeconds - t0);
  return {leadBars, leadQuarters, leadSeconds, padSeconds, numerator, denominator, qpm, bar1: t0, duration};
}

// ---------------------------------------------------------------------------------------------------------------
// WAV

export function wavHeader(frames, channels, sampleRate) {
  const bytes = frames * channels * 2;
  const out = new Uint8Array(44), view = new DataView(out.buffer);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, bytes, true);
  return out;
}

const toInt16 = s => (s >= 1 ? 0x7fff : s <= -1 ? -0x8000 : s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff));

export function* wavChunks(channels, sampleRate, {padFrames = 0, chunkFrames = 1 << 16} = {}) {
  const count = channels.length, frames = channels[0]?.length ?? 0, total = padFrames + frames;
  yield wavHeader(total, count, sampleRate);
  for (let start = 0; start < total; start += chunkFrames) {
    const end = Math.min(total, start + chunkFrames);
    const out = new Uint8Array((end - start) * count * 2), view = new DataView(out.buffer);
    let at = 0;
    for (let f = start; f < end; f++) {
      const i = f - padFrames;
      for (let c = 0; c < count; c++, at += 2) view.setInt16(at, i < 0 ? 0 : toInt16(channels[c][i]), true);
    }
    yield out;
  }
}

export function mixdown(tracks) {
  const list = tracks.filter(t => t?.length);
  const width = Math.min(2, Math.max(1, ...list.map(t => t.length)));
  const frames = Math.max(0, ...list.map(t => t[0].length));
  const out = Array.from({length: width}, () => new Float32Array(frames));
  for (const track of list) {
    for (let c = 0; c < width; c++) {
      const src = track[Math.min(c, track.length - 1)], dst = out[c];
      for (let i = 0; i < src.length; i++) dst[i] += src[i];
    }
  }
  let peak = 0;
  for (const ch of out) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  if (peak > 0.999) {
    const scale = 0.999 / peak;
    for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] *= scale;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Standard MIDI files

function vlq(value) {
  let n = Math.max(0, Math.round(value));
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const meta = (type, data) => [0xff, type, ...vlq(data.length), ...data];
const textMeta = (type, text) => meta(type, [...encoder.encode(String(text).slice(0, 200))]);

/** One MTrk chunk from [{tick, order, data}] (sorted by tick, then order: lower first). */
function trackChunk(events) {
  const sorted = events.map((e, i) => ({...e, i})).sort((a, b) => a.tick - b.tick || (a.order ?? 0) - (b.order ?? 0) || a.i - b.i);
  const body = [];
  let last = 0;
  for (const e of sorted) {
    const tick = Math.max(last, Math.round(e.tick));
    body.push(...vlq(tick - last), ...e.data);
    last = tick;
  }
  body.push(0, 0xff, 0x2f, 0);
  return [...encoder.encode('MTrk'), ...u32(body.length), ...body];
}

function midiFile(tracks) {
  const head = [...encoder.encode('MThd'), ...u32(6), 0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255];
  return new Uint8Array([...head, ...tracks.flatMap(trackChunk)]);
}

/** The meter a MIDI time signature can state for a bar of `length` quarters (a pickup or a cut bar too). */
function meterOf(measure) {
  const length = number(measure.length);
  if (Math.abs(length - number(fullLength(measure))) < 1e-9) return {numerator: measure.numerator, denominator: measure.denominator};
  for (const denominator of [measure.denominator, 8, 16, 32, 64]) {
    const numerator = length * denominator / 4;
    if (Math.abs(numerator - Math.round(numerator)) < 1e-9 && numerator >= 1 && numerator <= 255) return {numerator: Math.round(numerator), denominator};
  }
  return {numerator: measure.numerator, denominator: measure.denominator};
}

const timeSignature = (tick, {numerator, denominator}, pulse = 1) =>
  ({tick, order: 0, data: meta(0x58, [numerator, Math.round(Math.log2(denominator)), Math.max(1, Math.round(24 * pulse)), 8])});
const tempoEvent = (tick, usPerQuarter) => {
  const us = Math.max(1, Math.min(MAX_US, Math.round(usPerQuarter)));
  return {tick, order: 1, data: meta(0x51, [(us >> 16) & 255, (us >> 8) & 255, us & 255])};
};

/** The conductor events (tempo, meters, sections, name) and where the song's bar 1 is, in ticks. */
function conductor(mapData, duration, {title = ''} = {}) {
  const align = alignment(mapData, duration), c = compile(mapData);
  const startTick = align.leadBars * align.leadQuarters * PPQ;
  const tickAt = q => startTick + q * PPQ;
  const events = [];
  // A tempo slower than MAX_US is clamped, so every later bar comes early: the README names the first such bar.
  let slowAt = null;
  const slow = (q, us) => { if (slowAt === null && Math.round(us) > MAX_US) slowAt = q; };
  if (title) events.push({tick: 0, order: -1, data: textMeta(0x03, title)});
  if (align.leadBars) {
    events.push(timeSignature(0, align, pulseOf({numerator: align.numerator, denominator: align.denominator, length: fullLength(align)})));
    slow(0, 60e6 / align.qpm);
    events.push(tempoEvent(0, 60e6 / align.qpm));
    events.push({tick: 0, order: 2, data: textMeta(0x06, 'Count-in')});
  }
  // Meters: the first bar, then wherever the stated meter changes.
  const starts = measureStarts(mapData.measures).map(number);
  let previous = align.leadBars ? `${align.numerator}/${align.denominator}` : '';
  mapData.measures.forEach((m, i) => {
    const meter = meterOf(m), key = `${meter.numerator}/${meter.denominator}`;
    if (key !== previous) events.push(timeSignature(tickAt(starts[i]), meter, pulseOf(m)));
    previous = key;
  });
  // Tempo: one event per steady stretch; ramps step every RAMP_STEP_Q quarters at the exact average tempo of
  // the step, so every step boundary lands at its real time.
  const end = starts.length ? starts[starts.length - 1] + number(mapData.measures[mapData.measures.length - 1].length) : 0;
  const firstPin = c.pins.length ? number(c.pins[0].position) : 0, lastPin = c.pins.length ? number(c.pins[c.pins.length - 1].position) : 0;
  const segments = [];
  if (firstPin > 0) segments.push({q0: 0, q1: Math.min(firstPin, end), ramp: false, qps: c.head});
  for (const s of c.spans) if (s.p1 > 0 && s.p0 < end) segments.push({q0: Math.max(0, s.p0), q1: Math.min(end, s.p1), ramp: s.ramp, qps: s.v0});
  if (lastPin < end) segments.push({q0: Math.max(0, lastPin), q1: end, ramp: false, qps: c.tail});
  let lastUs = align.leadBars ? Math.round(60e6 / align.qpm) : null;
  const push = (q, us) => {
    slow(q, us);
    const rounded = Math.round(us);
    if (rounded === lastUs) return;
    events.push(tempoEvent(tickAt(q), rounded));
    lastUs = rounded;
  };
  for (const seg of segments) {
    if (!(seg.q1 > seg.q0)) continue;
    if (!seg.ramp) { push(seg.q0, 1e6 / seg.qps); continue; }
    for (let q = seg.q0; q < seg.q1 - 1e-9; q += RAMP_STEP_Q) {
      const q1 = Math.min(seg.q1, q + RAMP_STEP_Q);
      push(q, 1e6 * (timeAt(c, q1) - timeAt(c, q)) / (q1 - q));
    }
  }
  if (lastUs === null) events.push(tempoEvent(tickAt(0), 1e6 / velocityAt(c, 0)));
  // Section markers.
  for (const section of sectionsOf(mapData, Number.isFinite(duration) ? duration : Infinity)) {
    if (section.label) events.push({tick: tickAt(starts[section.startBar]), order: 2, data: textMeta(0x06, section.name || section.label)});
  }
  let slowBar = null;
  if (slowAt !== null) { slowBar = 0; while (slowBar + 1 < starts.length && starts[slowBar + 1] <= slowAt + 1e-9) slowBar++; }
  return {events, startTick, tickAt, starts, endTick: tickAt(end), align, slowBar};
}

export function tooSlowBar(mapData, duration) {
  return conductor(mapData, duration).slowBar;
}

export function mapSeconds(mapData) {
  const last = mapData.measures.length - 1;
  if (last < 0) return 0;
  return timeAt(compile(mapData), number(measureStarts(mapData.measures)[last]) + number(mapData.measures[last].length));
}

export function tempoMapMidi(mapData, duration, {title = ''} = {}) {
  const {events, endTick} = conductor(mapData, duration, {title});
  events.push({tick: endTick, order: 9, data: textMeta(0x06, 'End')});
  return midiFile([events]);
}

const ROLL_TICKS = {1: PPQ / 2, 2: PPQ / 4, 3: PPQ / 8};
const NOTE_TICKS = PPQ / 8;

function velocityOf(hit) {
  let v = Number.isFinite(hit.velocity) ? hit.velocity : 0.75;
  if (hit.heavy) v = Math.max(v, 1);
  else if (hit.accent) v = Math.max(v, 0.92);
  if (hit.ghost) v = Math.min(v, 0.35);
  return Math.max(1, Math.min(127, Math.round(Math.max(0.02, Math.min(1, v)) * 127)));
}

/** [{tick, note, velocity}] for every written hit, with flam/drag graces and roll strokes. */
export function drumStrokes(score, mapData, tickAt, starts) {
  const index = new Map(mapData.measures.map((m, i) => [m.id, i]));
  const strokes = [];
  for (const bar of score?.bars ?? []) {
    const i = index.get(bar.measureId);
    if (i === undefined) continue;
    const barStart = starts[i], barEnd = barStart + number(mapData.measures[i].length);
    const hits = bar.hits.map(h => ({hit: h, kit: KIT_BY_ID.get(h.instrument), q: barStart + number(h.offset)}))
      .filter(h => h.kit && h.q < barEnd - 1e-9).sort((a, b) => a.q - b.q);
    hits.forEach(({hit, kit, q}, n) => {
      const tick = tickAt(q), velocity = velocityOf(hit);
      const graces = hit.drag ? 2 : hit.flam ? 1 : 0;
      // A grace before tick 0 (a flam on the first beat with no count-in) would stack on the main stroke: drop it.
      for (let g = graces; g >= 1; g--) {
        const at = tick - g * PPQ / 16;
        if (at >= 0) strokes.push({tick: at, note: kit.midi, velocity: Math.max(1, Math.round(velocity * 0.55))});
      }
      strokes.push({tick, note: kit.midi, velocity});
      const step = ROLL_TICKS[hit.roll];
      if (step) {
        const next = hits.slice(n + 1).find(h => h.hit.instrument === hit.instrument);
        const until = Math.min(next ? tickAt(next.q) : Infinity, tick + PPQ, tickAt(barEnd));
        for (let t = tick + step; t < until - 1e-6; t += step) strokes.push({tick: t, note: kit.midi, velocity: Math.max(1, Math.round(velocity * 0.8))});
      }
    });
  }
  return strokes.sort((a, b) => a.tick - b.tick);
}

export function drumChartMidi(score, mapData, duration, {title = ''} = {}) {
  const {events, endTick, tickAt, starts} = conductor(mapData, duration, {title});
  const strokes = drumStrokes(score, mapData, tickAt, starts);
  const drums = [{tick: 0, order: -1, data: textMeta(0x03, 'Drums')}];
  // Each stroke ends before the next stroke of the same note starts.
  const nextOn = new Map();
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i], next = nextOn.get(s.note);
    const off = Math.max(s.tick + 1, Math.min(s.tick + NOTE_TICKS, next === undefined ? Infinity : next - 1));
    drums.push({tick: s.tick, order: 1, data: [0x99, s.note, s.velocity]});
    drums.push({tick: off, order: 0, data: [0x89, s.note, 0]});
    nextOn.set(s.note, s.tick);
  }
  const last = Math.max(endTick, ...drums.map(e => e.tick));
  events.push({tick: last, order: 9, data: textMeta(0x06, 'End')});
  return midiFile([events, drums]);
}

// ---------------------------------------------------------------------------------------------------------------
// Guitar Pro

export function guitarProFile(at, score, {title = '', artist = ''} = {}) {
  const {score: built} = buildAlphaTabScore(at, score, {title});
  built.artist = artist;
  // Only alphaTab's own importer sets these score-level layout fields; its GP7 writer reads them.
  built.defaultSystemsLayout ??= 3;
  built.systemsLayout ??= [];
  const track = built.tracks[0];
  if (track) { track.name = 'Drums'; track.shortName = 'Dr.'; }
  return new at.exporter.Gp7Exporter().export(built, new at.Settings());
}

// ---------------------------------------------------------------------------------------------------------------
// README.txt

const seconds = s => `${(Math.round(s * 1000) / 1000).toFixed(3)} s`;

/**
 * facts: {title, artist, date, sampleRate, stems: [names], backing: name|null, tempoMap: bool, drumMidi: bool,
 *         guitarPro: bool, original: bool, align, pickup: bool, slowBar: tooSlowBar's index|null}
 */
export function readme(f) {
  const lines = [];
  const name = [f.artist, f.title].filter(Boolean).join(' – ') || 'Song';
  lines.push(name, `Exported from Woodshed${f.date ? ` on ${f.date}` : ''}.`, '');
  if (f.stems?.length) {
    lines.push(f.original
      ? `Stems/  ${f.stems.length} stem${f.stems.length === 1 ? '' : 's'} as Woodshed stores them (Opus audio in WebM). They all start at the same moment.`
      : `Stems/  ${f.stems.length} stem${f.stems.length === 1 ? '' : 's'} (${f.stems.join(', ')}), 16-bit WAV at ${f.sampleRate} Hz, all the same length. Put every file at the very start of a session and they line up.`);
  }
  if (f.backing) lines.push(`${f.backing}  every stem except your part, mixed into one WAV.`);
  if (f.tempoMap) lines.push('Tempo map.mid  the song\'s bar grid: tempo, meter changes and section markers. Import it into your DAW (most DAWs ask whether to import the tempo; say yes) and the bars, the click and the grid follow the recording.');
  if (f.drumMidi) lines.push('Drum chart.mid  the drum part as General MIDI drums on channel 10, with the same tempo map.');
  if (f.guitarPro) lines.push('Drum chart.gp  the drum part for Guitar Pro 7 or later, and apps that open .gp files. It starts at the song\'s bar 1.');
  const a = f.align;
  if (a && (f.tempoMap || f.drumMidi)) {
    lines.push('', 'Timing');
    // A DAW counts a pickup as a bar of its own, between the count-in and the song's bar 1.
    const bar1 = a.leadBars + (f.pickup ? 2 : 1), pickup = f.pickup ? ', then the pickup' : '';
    if (a.leadBars && !f.original) {
      lines.push(`Everything shares one timeline. It starts with ${a.leadBars} count-in bar${a.leadBars === 1 ? '' : 's'} of ${a.numerator}/${a.denominator} at ${Math.round(a.qpm * 10) / 10} BPM${pickup}, so the song's bar 1 is bar ${bar1} in your DAW. The WAV files start with ${seconds(a.padSeconds)} of silence to match.`);
    } else if (a.leadBars) {
      lines.push(`The MIDI files start with ${a.leadBars} count-in bar${a.leadBars === 1 ? '' : 's'}${pickup}, so the song's bar 1 is bar ${bar1}. The original stems${f.backing ? ' and the backing track' : ''} are not padded: place them ${seconds(a.padSeconds)} after the start of the session.`);
    } else if (f.pickup) {
      lines.push('Everything shares one timeline: the pickup starts at 0:00, so the song\'s bar 1 is bar 2 in your DAW.');
    } else {
      lines.push('Everything shares one timeline: the song\'s bar 1 starts at 0:00.');
    }
    if (Number.isInteger(f.slowBar)) {
      const bar = f.pickup && f.slowBar === 0 ? 'The pickup' : `The song's bar ${f.slowBar + (f.pickup ? 0 : 1)}`;
      lines.push(`${bar} is too slow for a MIDI file (a quarter note there lasts more than 16.8 s). From there on, the MIDI files drift ahead of the audio.`);
    }
  }
  lines.push('');
  return lines.join('\r\n');
}

export {fraction};
