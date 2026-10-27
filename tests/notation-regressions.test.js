// @vitest-environment node
// Regressions from the independent review of drum notation version 2.
import {describe, it, expect} from 'vitest';
import * as at from '@coderline/alphatab';
import {fraction, emptyScore, validateBar, validateScore, ScoreEditor, upgradeScore, number} from '../shared/notation.ts';
import {engraveBar} from '../shared/engrave.ts';
import {buildAlphaTabScore} from '../src/js/notation/alphatab-score.js';
import {importDrumHits} from '../src/js/notation/import-drums.js';

let n = 0;
const hit = (offset, instrument = 'snare', extra = {}) => ({id: `r${n++}`, offset, instrument, voice: ['kick', 'pedalHat'].includes(instrument) ? 2 : 1, accent: false, ghost: false, flam: false, sticking: '', velocity: .8, ...extra});
const measure = (numerator, denominator, extra = {}) => ({id: 'm', numerator, denominator, length: fraction(4 * numerator, denominator), label: '', ...extra});
const shape = voice => voice.beats.map(b => `${b.rest ? 'r' : 'n'}${b.value}${'.'.repeat(b.dots)}`).join(' ');

describe('drum notation review regressions', () => {
  it('writes beat groups of five and seven and odd bar remainders', () => {
    const fiveTwo = measure(7, 8, {grouping: [5, 2]});
    expect(shape(engraveBar({hits: [hit(fraction(0), 'crash')]}, fiveTwo).voices[0])).toBe('n4. r4 r4');
    expect(() => validateBar({measureId: 'm', coverage: 'reviewed', hits: []}, {measures: [fiveTwo]})).not.toThrow();
    const short = measure(4, 4, {length: fraction(21, 8)});
    expect(() => validateBar({measureId: 'm', coverage: 'progress', hits: [hit(fraction(0))]}, {measures: [short]})).not.toThrow();
  });

  it('writes an empty full bar in an odd meter as one bar rest', () => {
    const [voice] = engraveBar({hits: []}, measure(5, 4)).voices;
    expect(voice.beats).toHaveLength(1);
    expect(voice.beats[0]).toMatchObject({rest: true, measureRest: true, value: 1});
  });

  it('gives every bar its own beaming so a grouped bar does not leak into later bars', () => {
    const score = emptyScore(8, 120);
    score.timeline.measures[0] = {...score.timeline.measures[0], numerator: 7, denominator: 8, length: fraction(7, 2), grouping: [2, 2, 3]};
    const {score: out} = buildAlphaTabScore(at, score);
    expect([...out.masterBars[0].beamingRules.groups.get(at.model.Duration.Eighth)]).toEqual([2, 2, 3]);
    expect([...out.masterBars[1].beamingRules.groups.get(at.model.Duration.Eighth)]).toEqual([2, 2, 2, 2]);
    expect([...out.masterBars[1].beamingRules.groups.get(at.model.Duration.Sixteenth)]).toEqual([4, 4, 4, 4]);
  });

  it('keeps a flam that shares a beat with a drag', () => {
    const score = emptyScore(4, 120);
    score.bars = [{measureId: score.timeline.measures[0].id, coverage: 'progress', hits: [hit(fraction(0), 'snare', {drag: true}), hit(fraction(0), 'floorTom', {flam: true})]}];
    const {score: out} = buildAlphaTabScore(at, score);
    const graces = out.tracks[0].staves[0].bars[0].voices[0].beats.filter(b => b.graceType !== at.model.GraceType.None);
    expect(graces).toHaveLength(2);
    expect(graces.at(-1).notes.map(note => note.percussionArticulation).sort()).toEqual([38, 43]);
  });

  it('snaps a slightly late or early performance to the simple grid', () => {
    const timing = emptyScore(8, 120).timeline, note = (q, midi = 42) => ({q, midi, velocity: .7});
    const {score} = importDrumHits([note(0), note(.54), note(1), note(1.45), note(2.035), note(3)], timing);
    expect(score.bars[0].hits.map(h => number(h.offset))).toEqual([0, .5, 1, 1.5, 2, 3]);
    expect(engraveBar(score.bars[0], timing.measures[0]).voices[0].beats.every(b => b.value <= 8)).toBe(true);
  });

  it('applies a one-voice Guitar Pro tuplet only to that voice', () => {
    const timing = emptyScore(8, 120).timeline;
    const hits = [{q: 0, midi: 38, velocity: .7}, {q: 1 / 3, midi: 38, velocity: .7}, {q: 2 / 3, midi: 38, velocity: .7}, {q: 0, midi: 36, velocity: .7}, {q: .5, midi: 36, velocity: .7}];
    const {score, warnings} = importDrumHits(hits, timing, {source: 'guitar-pro', tuplets: [{q: 0, length: 1, count: 3, voice: 1}]});
    expect(score.bars[0].hits.filter(h => h.instrument === 'kick').map(h => number(h.offset))).toEqual([0, .5]);
    expect(warnings.join(' ')).not.toContain('rounded');
    validateScore(score);
  });

  it('opens version 1 parts whose positions only the old importer could store', () => {
    const score = emptyScore(8, 120), id = score.timeline.measures[0].id;
    const v1 = (offset, i) => ({id: `v${i}`, offset, duration: fraction(1, 96), instrument: 'closedHat', voice: 1, value: 64, dotted: false, tuplet: 3, accent: false, ghost: false, flam: false, sticking: '', velocity: .7});
    const legacy = {...score, version: 1, bars: [{measureId: id, coverage: 'progress', hits: [fraction(0), fraction(49, 96), fraction(97, 96), fraction(1, 40)].map(v1)}]};
    const editor = new ScoreEditor(legacy);
    expect(editor.score.bars[0].hits.map(h => number(h.offset))).toEqual([0, .5, 1]);
    expect(upgradeScore(legacy).bars[0].hits).toHaveLength(3);
  });
});
