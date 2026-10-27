// Convert a Woodshed drum score into an alphaTab model. Pure: no DOM, no
// rendering, so the conversion is unit-tested in Node. Written rhythm comes
// from shared/engrave.ts; alphaTab only lays out and draws it.
import {kitPiece, number, starts, toTime, compare} from '../../../shared/notation.ts';
import {engraveBar, rhythmCells} from '../../../shared/engrave.ts';

const DURATION = {1: 'Whole', 2: 'Half', 4: 'Quarter', 8: 'Eighth', 16: 'Sixteenth', 32: 'ThirtySecond', 64: 'SixtyFourth'};
const ROLL = {1: 'Eighth', 2: 'Sixteenth', 3: 'ThirtySecond'};

/** Quarter-note BPM over a bar, from the alignment timeline. */
export function barTempo(timeline, index) {
  const positions = starts(timeline), q = positions[index], length = number(timeline.measures[index].length);
  const seconds = toTime(timeline, q + length) - toTime(timeline, q);
  return seconds > 0 ? 60 * length / seconds : 0;
}

/**
 * Tempo markings a reader can use: the opening tempo, and later changes that
 * hold for at least two bars. Beat-tracked recordings drift by a few BPM
 * every bar; those are not markings.
 */
export function tempoMarks(timeline) {
  const count = timeline.measures.length, tempos = timeline.measures.map((_, i) => barTempo(timeline, i));
  const marks = new Map();
  let current = Math.round(tempos[0] || 120);
  marks.set(0, current);
  for (let i = 1; i < count; i++) {
    const next = Math.round(tempos[i]), hold = i + 1 < count ? Math.round(tempos[i + 1]) : next;
    if (Math.abs(next - current) >= 4 && Math.abs(hold - next) < 3) { current = next; marks.set(i, current); }
  }
  return marks;
}

/** Bars whose notes and tuplets repeat the previous bar exactly. */
export function repeatedBars(score) {
  const sig = new Map();
  for (const bar of score.bars) sig.set(bar.measureId, bar.hits.length ? JSON.stringify([
    bar.hits.map(h => [h.offset.n / h.offset.d, h.instrument, h.accent, h.ghost, h.flam, !!h.heavy, !!h.drag, h.roll || 0, h.sticking, h.voice]).sort(),
    (bar.tuplets || []).map(t => [t.start.n / t.start.d, t.length.n / t.length.d, t.count, t.voice || 0]),
  ]) : '');
  const repeated = new Set(), measures = score.timeline.measures;
  for (let i = 1; i < measures.length; i++) {
    const a = sig.get(measures[i - 1].id), b = sig.get(measures[i].id);
    if (a && a === b && compare(measures[i - 1].length, measures[i].length) === 0) repeated.add(i);
  }
  return repeated;
}

/**
 * Build an alphaTab Score.
 * @param at alphaTab module
 * @param score Woodshed score (version 2)
 * @param options.layout 'split' | 'combined' (defaults to the score's own)
 * @param options.range [first, last] measure indices to include (inclusive)
 * @param options.simile draw repeated bars as one-bar repeat signs
 * @returns {{score, beats: Map<alphaTabBeat, {index, beat}>, bars: number[], noteHits: Map<alphaTabNote, hit>}}
 */
export function buildAlphaTabScore(at, score, {layout = score.layout || 'combined', range = null, simile = false, title = ''} = {}) {
  const M = at.model, measures = score.timeline.measures;
  const first = range ? range[0] : 0, last = range ? range[1] : measures.length - 1;
  const out = new M.Score();
  out.title = title;
  const track = new M.Track();
  out.addTrack(track);
  track.name = '';
  track.shortName = '';
  track.playbackInfo.primaryChannel = 9;
  track.playbackInfo.secondaryChannel = 9;
  const staff = new M.Staff();
  track.addStaff(staff);
  staff.isPercussion = true;
  staff.showTablature = false;
  staff.showStandardNotation = true;
  // Articulations are GP7 ids; the default alphaTab list resolves them.
  track.percussionArticulations = [];
  const marks = tempoMarks(score.timeline);

  const repeated = simile ? repeatedBars(score) : new Set();
  const barsById = new Map(score.bars.map(b => [b.measureId, b]));
  const beats = new Map(), noteHits = new Map(), bars = [];

  for (let index = first; index <= last; index++) {
    const measure = measures[index], bar = barsById.get(measure.id);
    const master = new M.MasterBar();
    master.timeSignatureNumerator = measure.numerator;
    master.timeSignatureDenominator = measure.denominator;
    if (index === 0 && compare(measure.length, {n: 4 * measure.numerator, d: measure.denominator}) < 0) master.isAnacrusis = true;
    if (measure.label) { master.section = new M.Section(); master.section.text = measure.label; master.section.marker = ''; }
    const tempo = marks.get(index) ?? (index === first ? Math.round(barTempo(score.timeline, index)) : null);
    if (tempo) master.tempoAutomations.push(M.Automation.buildTempoAutomation(false, 0, tempo, 2, true));
    // Every bar gets its own rules: alphaTab carries a bar's rules into all
    // later bars that have none. Beams follow the engraver's rhythm cells.
    const cells = rhythmCells(measure), rules = new M.BeamingRules();
    for (const [duration, per] of [[M.Duration.Eighth, 8], [M.Duration.Sixteenth, 16], [M.Duration.ThirtySecond, 32]]) {
      const sizes = cells.map(c => number(c.length) * per / 4);
      if (sizes.every(n => Number.isInteger(n) && n >= 1)) rules.groups.set(duration, sizes);
    }
    master.beamingRules = rules;
    out.addMasterBar(master);
    const atBar = new M.Bar();
    staff.addBar(atBar);
    atBar.clef = M.Clef.Neutral;
    bars.push(index);

    // alphaTab chains beats across bars per voice index, so every bar carries
    // the same voices; unused ones hold one invisible spacer.
    const voices = Array.from({length: layout === 'split' ? 2 : 1}, () => { const voice = new M.Voice(); atBar.addVoice(voice); return voice; });
    const blank = voice => { const beat = new M.Beat(); beat.isEmpty = true; beat.duration = M.Duration.Whole; voice.addBeat(beat); };
    const transcribed = bar && (bar.hits.length || bar.coverage === 'reviewed');
    if (!transcribed) { voices.forEach(blank); continue; }  // untranscribed bars stay blank, not rests
    if (repeated.has(index) && index > first) { atBar.simileMark = M.SimileMark.Simple; voices.forEach(blank); continue; }
    const engraved = engraveBar(bar, measure, layout);
    const direction = i => layout === 'split' ? (i === 0 ? at.rendering.BeamDirection.Up : at.rendering.BeamDirection.Down) : null;
    voices.forEach((voice, voiceIndex) => {
      const v = engraved.voices[voiceIndex];
      if (!v) { blank(voice); return; }
      for (const written of v.beats) {
        const graceHits = written.hits.filter(h => h.flam || h.drag);
        if (graceHits.length) {
          const graces = graceHits.some(h => h.drag) ? 2 : 1;
          for (let g = 0; g < graces; g++) {
            const grace = new M.Beat();
            grace.graceType = M.GraceType.BeforeBeat;
            grace.duration = graces === 1 ? M.Duration.Eighth : M.Duration.Sixteenth;
            // With a drag on the beat, single flams share the grace nearest the note.
            for (const hit of graceHits.filter(h => graces === 1 || h.drag || g === graces - 1)) {
              const note = new M.Note();
              note.percussionArticulation = kitPiece(hit.instrument).gp;
              grace.addNote(note);
            }
            if (direction(voiceIndex) !== null) grace.preferredBeamDirection = direction(voiceIndex);
            voice.addBeat(grace);
          }
        }
        const beat = new M.Beat();
        beat.duration = M.Duration[DURATION[written.value]];
        beat.dots = written.dots;
        if (written.tuplet) { beat.tupletNumerator = written.tuplet.n; beat.tupletDenominator = written.tuplet.m; }
        if (written.hidden) beat.isEmpty = true;
        if (direction(voiceIndex) !== null) beat.preferredBeamDirection = direction(voiceIndex);
        const roll = Math.max(0, ...written.hits.map(h => h.roll || 0));
        if (roll) beat.tremoloSpeed = M.Duration[ROLL[roll]];
        const sticking = [...new Set(written.hits.map(h => h.sticking).filter(Boolean))].join('');
        // Sticking reads below the staff, as in method books.
        if (sticking) beat.lyrics = [sticking];
        for (const hit of written.hits) {
          const note = new M.Note();
          note.percussionArticulation = kitPiece(hit.instrument).gp;
          if (hit.heavy) note.accentuated = M.AccentuationType.Heavy;
          else if (hit.accent) note.accentuated = M.AccentuationType.Normal;
          note.isGhost = !!hit.ghost;
          beat.addNote(note);
          noteHits.set(note, hit);
        }
        beat.dynamics = M.DynamicValue.MF;
        voice.addBeat(beat);
        beats.set(beat, {index, beat: written, voice: v.voice});
      }
    });
  }
  out.finish(new at.Settings());
  return {score: out, beats, bars, noteHits};
}

