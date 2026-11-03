// @vitest-environment node
// src/js/video-align.js: a playthrough video lined up with the recording. The "recording" is noise bursts at a
// groove's hit times; the "video" holds the same recording later or earlier (a talking intro, a cut intro), with
// the player's own kit hits on top and some level change, so the offset can be checked against the truth.
import {describe, expect, test} from 'vitest';
import {alignVideo, mixdown} from '../src/js/video-align.js';
import {onsetStrength} from '../src/js/onsets.js';

const RATE = 16000;

function random(seed) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
}

/** A mono buffer with a decaying burst at each {t, amp} and a noise floor. */
function buffer(hits, duration, seed = 3) {
  const rnd = random(seed), data = new Float32Array(Math.ceil(duration * RATE));
  for (let i = 0; i < data.length; i++) data[i] = (rnd() - 0.5) * 0.004;
  for (const {t, amp} of hits) {
    const at0 = Math.round(t * RATE);
    for (let i = 0; i < RATE * 0.04 && at0 + i < data.length; i++) if (at0 + i >= 0) data[at0 + i] += (rnd() - 0.5) * amp * Math.exp(-i / (RATE * 0.008));
  }
  return {sampleRate: RATE, length: data.length, numberOfChannels: 1, getChannelData: () => data};
}

/** 70 s of a slightly irregular groove (so no two bars are identical): the recording's hits. */
function groove(seed = 7) {
  const rnd = random(seed), hits = [];
  let t = 0.5;
  while (t < 70) {
    hits.push({t, amp: rnd() < 0.3 ? 0.9 : 0.35});
    t += 0.25 * (1 + Math.floor(rnd() * 3)) + (rnd() - 0.5) * 0.01;
  }
  return hits;
}

function check(offset, {extraSeed = 11} = {}) {
  const hits = groove();
  const song = buffer(hits, 72);
  const rnd = random(extraSeed);
  // The video: the recording shifted by `offset`, quieter, with 25% of the hits doubled by the live kit, and talk.
  const shifted = hits.map(h => ({t: h.t + offset, amp: h.amp * 0.6}));
  const kit = hits.filter(() => rnd() < 0.25).map(h => ({t: h.t + offset + 0.004, amp: 0.5}));
  const talk = Array.from({length: 40}, () => ({t: rnd() * Math.max(1, offset), amp: 0.2}));
  const video = buffer([...shifted, ...kit, ...talk], 72 + Math.max(0, offset), extraSeed);
  return alignVideo({song: onsetStrength(song), video: onsetStrength(video)});
}

describe('alignVideo', () => {
  test('a video that starts with a talking intro: the offset to the millisecond', () => {
    for (const offset of [14.3, 3.007, 0]) {
      const fit = check(offset);
      expect(fit.quality, `${offset}`).toBe('good');
      expect(Math.abs(fit.offset - offset), `${offset}: ${fit.offset}`).toBeLessThan(0.004);
    }
  }, 30000);

  test('a part played exactly on a grid (a programmed drum track), shifted by half a coarse step', () => {
    const rnd = random(7), hits = [];
    for (let t = 0.3; t < 30; t += 0.25 * (1 + Math.floor(rnd() * 3))) hits.push({t, amp: 0.8});
    const fit = alignVideo({song: onsetStrength(buffer(hits, 31)), video: onsetStrength(buffer(hits.map(h => ({...h, t: h.t + 3.25})), 35, 9))});
    expect(fit.offset).toBeCloseTo(3.25, 2);
  }, 30000);

  test('a video that cuts the recording\'s intro: a negative offset', () => {
    const fit = check(-2.1);
    expect(fit.offset).toBeCloseTo(-2.1, 2);
  }, 30000);

  test('audio that is not this recording is "poor"', () => {
    const song = buffer(groove(7), 72);
    const other = buffer(groove(99).map(h => ({...h, t: h.t * 1.07})), 80, 5);
    const fit = alignVideo({song: onsetStrength(song), video: onsetStrength(other)});
    expect(fit.quality).not.toBe('good');
  }, 30000);

  test('nothing to match', () => {
    expect(alignVideo({song: null, video: null})).toBeNull();
  });

  test('mixdown sums stems to one mono buffer at the given rate', () => {
    const a = {sampleRate: 8000, length: 8, numberOfChannels: 1, getChannelData: () => Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1])};
    const b = {sampleRate: 16000, length: 8, numberOfChannels: 2, getChannelData: () => Float32Array.from([2, 2, 2, 2, 2, 2, 2, 2])};
    const m = mixdown([a, b], 8000);
    expect(m.length).toBe(8);
    expect(Array.from(m.getChannelData(0)).slice(0, 4)).toEqual([3, 3, 3, 3]);
    expect(Array.from(m.getChannelData(0)).slice(4)).toEqual([1, 1, 1, 1]);
  });
});
