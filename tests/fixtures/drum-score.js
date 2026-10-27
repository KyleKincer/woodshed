// Synthetic drum parts for the development fixture and visual checks. They
// exercise the notation features real songs use, without copyrighted material.
import {emptyScore, fraction, kitPiece, id} from '../../shared/notation.ts';

const hit = (offset, instrument, extra = {}) => ({id: id(), offset, instrument, voice: kitPiece(instrument).voice, accent: false, ghost: false, flam: false, sticking: '', velocity: .78, ...extra});

/** Rock verse, triplet-feel chorus, sixteenth fill, half-time outro. */
export function demoScore(seconds = 64, bpm = 120) {
  const score = emptyScore(seconds, bpm);
  const m = score.timeline.measures;
  m[0].label = 'Intro'; if (m[4]) m[4].label = 'Verse'; if (m[12]) m[12].label = 'Chorus'; if (m[20]) m[20].label = 'Outro';
  score.bars = m.map((measure, bar) => {
    const hits = [];
    if (bar < 4) {
      // Intro: quarter-note ride, kick on 1 and 3, cross-stick on 2 and 4.
      for (let b = 0; b < 4; b++) { hits.push(hit(fraction(b), b === 0 && bar === 0 ? 'crash' : 'ride')); hits.push(hit(fraction(b), b % 2 ? 'crossStick' : 'kick')); }
    } else if (bar < 12) {
      // Verse: eighth hats, ghosted sixteenths, open hat on the and of 4.
      for (let s = 0; s < 8; s++) hits.push(hit(fraction(s, 2), s === 7 ? 'openHat' : 'closedHat', {accent: s % 2 === 0}));
      hits.push(hit(fraction(0), 'kick'), hit(fraction(3, 2), 'kick'), hit(fraction(5, 2), 'kick'));
      hits.push(hit(fraction(1), 'snare'), hit(fraction(3), 'snare', {flam: bar === 11}));
      hits.push(hit(fraction(7, 4), 'snare', {ghost: true, velocity: .3}), hit(fraction(11, 4), 'snare', {ghost: true, velocity: .3}));
      if (bar === 11) for (let s = 0; s < 4; s++) hits.push(hit(fraction(12 + s, 4), ['rackTom', 'tom3', 'floorTom', 'floorTom'][s], {sticking: s % 2 ? 'L' : 'R'}));
    } else if (bar < 20) {
      // Chorus: triplet feel with china accents and a double-kick pattern.
      for (let b = 0; b < 4; b++) for (let k = 0; k < 3; k++) {
        const q = fraction(3 * b + k, 3);
        if (k !== 1) hits.push(hit(q, k === 0 && b % 2 === 0 ? 'china' : 'ride', {accent: k === 0}));
        if (k !== 1 || b === 3) hits.push(hit(q, 'kick'));
        if (k === 0 && b % 2) hits.push(hit(q, 'snare', {accent: true}));
      }
      if (bar === 19) { hits.splice(0, hits.length); for (let s = 0; s < 12; s++) hits.push(hit(fraction(s, 3), ['snare', 'rackTom', 'tom3', 'floorTom'][Math.floor(s / 3)], {accent: s % 3 === 0})); }
    } else {
      // Outro: half-time with a splash and a final crash choke.
      hits.push(hit(fraction(0), bar === 20 ? 'splash' : 'crash'), hit(fraction(0), 'kick'), hit(fraction(2), 'snare'), hit(fraction(7, 2), 'kick'));
      for (let s = 1; s < 8; s++) hits.push(hit(fraction(s, 2), 'pedalHat'));
      if (bar === m.length - 1) return {measureId: measure.id, coverage: 'reviewed', hits: [hit(fraction(0), 'crashChoke'), hit(fraction(0), 'kick')]};
    }
    return {measureId: measure.id, coverage: bar < 4 ? 'reviewed' : 'progress', hits};
  });
  return score;
}
