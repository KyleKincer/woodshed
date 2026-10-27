import {describe, it, expect} from 'vitest';
import {fraction, validateBar, upgradeScore, emptyScore} from '../shared/notation.ts';
import {engraveBar, rhythmCells, writtenValue} from '../shared/engrave.ts';

const measure = (numerator = 4, denominator = 4, extra = {}) => ({id: 'm', numerator, denominator, length: fraction(4 * numerator, denominator), label: '', ...extra});
let n = 0;
const hit = (q, instrument = 'snare', extra = {}) => ({id: `h${n++}`, offset: typeof q === 'number' ? fraction(Math.round(q * 960), 960) : q, instrument, voice: ['kick', 'pedalHat'].includes(instrument) ? 2 : 1, accent: false, ghost: false, flam: false, sticking: '', velocity: .8, ...extra});
const bar = (hits, extra = {}) => ({measureId: 'm', coverage: 'progress', hits, ...extra});
const shape = voice => voice.beats.map(b => `${b.rest ? 'r' : 'n'}${b.value}${'.'.repeat(b.dots)}${b.tuplet ? `(${b.tuplet.n}:${b.tuplet.m})` : ''}`).join(' ');

describe('drum engraving', () => {
  it('writes a triplet-eighth groove as one bracketed triplet per beat', () => {
    const hits = [];
    for (let beat = 0; beat < 4; beat++) for (let k = 0; k < 3; k++) hits.push(hit(fraction(3 * beat + k, 3), 'china'));
    const [hands] = engraveBar(bar(hits), measure()).voices;
    expect(shape(hands)).toBe(Array(12).fill('n8(3:2)').join(' '));
    expect(new Set(hands.beats.map(b => b.tuplet.group)).size).toBe(4);
  });

  it('writes straight eighths with no tuplets', () => {
    const [hands] = engraveBar(bar([0, .5, 1, 1.5, 2, 2.5, 3, 3.5].map(q => hit(q, 'closedHat'))), measure()).voices;
    expect(shape(hands)).toBe(Array(8).fill('n8').join(' '));
  });

  it('keeps sparse bars sparse: a lone crash is a whole note', () => {
    const [hands] = engraveBar(bar([hit(0, 'crash')]), measure()).voices;
    expect(shape(hands)).toBe('n1');
  });

  it('merges half bars for kicks on one and three', () => {
    const voices = engraveBar(bar([hit(0, 'kick'), hit(2, 'kick')]), measure(), 'split').voices;
    expect(shape(voices[1])).toBe('n2 n2');
    expect(voices[0].beats.every(b => b.hidden)).toBe(true);
  });

  it('writes dotted-eighth/sixteenth and leading sixteenth rests', () => {
    expect(shape(engraveBar(bar([hit(0), hit(.75)]), measure(1, 4)).voices[0])).toBe('n8. n16');
    expect(shape(engraveBar(bar([hit(.25)]), measure(1, 4)).voices[0])).toBe('r16 n8.');
    expect(shape(engraveBar(bar([hit(.5)]), measure(1, 4)).voices[0])).toBe('r8 n8');
  });

  it('splits sixteenth triplets into per-half-beat triplets', () => {
    const hits = [hit(fraction(0)), hit(fraction(1, 6)), hit(fraction(1, 3)), hit(fraction(1, 2))];
    expect(shape(engraveBar(bar(hits), measure(1, 4)).voices[0])).toBe('n16(3:2) n16(3:2) n16(3:2) n8');
  });

  it('writes quintuplets and septuplets', () => {
    const five = [0, 1, 2, 3, 4].map(k => hit(fraction(k, 5)));
    expect(shape(engraveBar(bar(five), measure(1, 4)).voices[0])).toBe(Array(5).fill('n16(5:4)').join(' '));
    const seven = [0, 1, 2, 3, 4, 5, 6].map(k => hit(fraction(k, 7)));
    expect(shape(engraveBar(bar(seven), measure(1, 4)).voices[0])).toBe(Array(7).fill('n16(7:4)').join(' '));
  });

  it('writes compound meters in dotted-quarter beats', () => {
    const hits = [0, .5, 1, 1.5, 2, 2.5].map(q => hit(q, 'ride'));
    expect(shape(engraveBar(bar(hits), measure(6, 8)).voices[0])).toBe(Array(6).fill('n8').join(' '));
    expect(shape(engraveBar(bar([hit(0), hit(1.5)]), measure(6, 8)).voices[0])).toBe('n4. n4.');
    expect(shape(engraveBar(bar([hit(0), hit(.75)]), measure(3, 8, {grouping: [3]})).voices[0])).toBe('n8. n8.');
    expect(shape(engraveBar(bar([hit(0), hit(.75)]), measure(3, 8)).voices[0])).toBe('n8 r16 n16 r8');
  });

  it('honours an explicit quarter-note triplet across two beats', () => {
    const hits = [hit(fraction(0)), hit(fraction(2, 3)), hit(fraction(4, 3))];
    const spans = [{start: fraction(0), length: fraction(2), count: 3}];
    expect(rhythmCells(measure(), spans).map(c => c.forced)).toEqual([3, null, null]);
    expect(shape(engraveBar(bar(hits, {tuplets: spans}), measure()).voices[0])).toBe('n4(3:2) n4(3:2) n4(3:2) r2');
  });

  it('writes partial (pickup) bars over their real length only', () => {
    const pickup = measure(4, 4, {length: fraction(1)});
    expect(shape(engraveBar(bar([hit(fraction(1, 3)), hit(fraction(2, 3))]), pickup).voices[0])).toBe('r8(3:2) n8(3:2) n8(3:2)');
  });

  it('combines hands and feet into one rhythm by default, or splits them', () => {
    const hits = [hit(0, 'kick'), hit(fraction(1, 3), 'snare'), hit(fraction(2, 3), 'kick')];
    const split = engraveBar(bar(hits), measure(1, 4), 'split').voices;
    expect(shape(split[0])).toBe('r8(3:2) n8(3:2) r8(3:2)');
    expect(shape(split[1])).toBe('n8(3:2) r8(3:2) n8(3:2)');
    const [one] = engraveBar(bar(hits), measure(1, 4)).voices;
    expect(shape(one)).toBe('n8(3:2) n8(3:2) n8(3:2)');
  });

  it('groups simultaneous hits into one chord', () => {
    const [one] = engraveBar(bar([hit(0, 'crash'), hit(0, 'snare'), hit(0, 'kick')]), measure(1, 4), 'combined').voices;
    expect(one.beats).toHaveLength(1);
    expect(one.beats[0].hits.map(h => h.instrument)).toEqual(['crash', 'snare', 'kick']);
  });

  it('rejects onsets finer than the notation grid', () => {
    const m = measure();
    expect(() => validateBar(bar([hit(fraction(1, 64))]), {measures: [m]})).toThrow();
    expect(() => validateBar(bar([hit(fraction(1, 16))]), {measures: [m]})).not.toThrow();
  });

  it('knows written values', () => {
    expect(writtenValue(fraction(3, 2))).toEqual({value: 4, dots: 1});
    expect(writtenValue(fraction(1, 2))).toEqual({value: 8, dots: 0});
    expect(writtenValue(fraction(5, 4))).toBe(null);
  });

  it('upgrades version 1 parts, dropping authored durations and explicit rests', () => {
    const score = emptyScore(10, 120);
    const v1 = {...score, version: 1, bars: [{measureId: score.timeline.measures[0].id, coverage: 'progress', hits: [
      {id: 'a', offset: fraction(0), duration: fraction(1, 3), instrument: 'snare', voice: 1, value: 8, dotted: false, tuplet: 3, accent: true, ghost: false, flam: false, sticking: '', velocity: .7},
      {id: 'b', offset: fraction(1, 3), duration: fraction(2, 3), instrument: 'rest', voice: 1, value: 4, dotted: false, tuplet: 3, accent: false, ghost: false, flam: false, sticking: '', velocity: .7},
    ]}]};
    const up = upgradeScore(v1);
    expect(up.version).toBe(2);
    expect(up.bars[0].hits).toEqual([{id: 'a', offset: fraction(0), instrument: 'snare', voice: 1, accent: true, ghost: false, flam: false, sticking: '', velocity: .7}]);
  });
});
