// @vitest-environment node
import {describe, it, expect} from 'vitest';
import * as at from '@coderline/alphatab';
import {fraction, emptyScore, validateScore} from '../shared/notation.ts';
import {buildAlphaTabScore, tempoMarks, repeatedBars} from '../src/js/notation/alphatab-score.js';

let n = 0;
const hit = (offset, instrument, extra = {}) => ({id: `h${n++}`, offset, instrument, voice: ['kick', 'pedalHat'].includes(instrument) ? 2 : 1, accent: false, ghost: false, flam: false, sticking: '', velocity: .8, ...extra});
function groove(bars = 4) {
  const score = emptyScore(bars * 2 - .01, 120);
  score.bars = score.timeline.measures.slice(0, 2).map(m => {
    const hits = [];
    for (let b = 0; b < 4; b++) for (let k = 0; k < 3; k++) {
      hits.push(hit(fraction(3 * b + k, 3), b === 0 && k === 0 ? 'china' : 'closedHat', {accent: k === 0}));
      if (k !== 1) hits.push(hit(fraction(3 * b + k, 3), 'kick'));
    }
    hits.push(hit(fraction(1), 'snare', {flam: true}), hit(fraction(3), 'snare', {ghost: true, sticking: 'R'}));
    return {measureId: m.id, coverage: 'progress', hits};
  });
  score.timeline.measures[0].label = 'Intro';
  validateScore(score);
  return score;
}

describe('alphaTab conversion', () => {
  it('builds a percussion score with sections, tuplets, graces and voices', () => {
    const score = groove();
    const {score: out, beats, bars, noteHits} = buildAlphaTabScore(at, score, {layout: 'split'});
    expect(out.masterBars).toHaveLength(score.timeline.measures.length);
    expect(out.masterBars[0].section.text).toBe('Intro');
    expect(out.tracks[0].staves[0].isPercussion).toBe(true);
    expect(bars).toEqual(score.timeline.measures.map((_, i) => i));
    const first = out.tracks[0].staves[0].bars[0];
    expect(first.voices).toHaveLength(2);
    const hands = first.voices[0].beats.filter(b => b.graceType === at.model.GraceType.None);
    expect(hands.every(b => b.tupletNumerator === 3 && b.tupletDenominator === 2)).toBe(true);
    expect(first.voices[0].beats.some(b => b.graceType === at.model.GraceType.BeforeBeat)).toBe(true);
    expect([...beats.values()].filter(b => b.index === 0)).toHaveLength(hands.length + first.voices[1].beats.length);
    expect(noteHits.size).toBe(score.bars.reduce((sum, b) => sum + b.hits.length, 0));
    // Untranscribed bars are blank, not rests.
    expect(out.tracks[0].staves[0].bars[3].voices[0].beats[0].isEmpty).toBe(true);
  });

  it('renders a bar range only', () => {
    const {score: out, bars} = buildAlphaTabScore(at, groove(), {range: [1, 2]});
    expect(out.masterBars).toHaveLength(2);
    expect(bars).toEqual([1, 2]);
  });

  it('marks repeated bars for simile notation', () => {
    const score = groove();
    expect([...repeatedBars(score)]).toEqual([1]);
  });

  it('marks only intentional tempo changes', () => {
    const score = emptyScore(60, 120);
    expect([...tempoMarks(score.timeline)]).toEqual([[0, 120]]);
  });
});
