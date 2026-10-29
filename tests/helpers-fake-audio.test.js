// @vitest-environment node
// The Web Audio fake (tests/helpers/fake-audio.js, architecture §11.3) must reject what Chromium
// rejects: AudioParam's automation methods take WebIDL `float`/`double` arguments, which throw a
// TypeError on NaN and ±Infinity. Ticket I2b-29: the fake used to record
// `setValueAtTime(…, Infinity)`, so I2b-1 passed every unit test and threw in the browser.
import {describe, expect, test} from 'vitest';
import {FakeAudioContext, FakeAudioParam} from './helpers/fake-audio.js';

const NON_FINITE = [Infinity, -Infinity, NaN, undefined, 'soon'];

// [method, finite arguments]; each argument position is replaced by every NON_FINITE value.
const METHODS = [
  ['setValueAtTime', [0.5, 1]],
  ['linearRampToValueAtTime', [0.5, 1]],
  ['exponentialRampToValueAtTime', [0.5, 1]],
  ['setTargetAtTime', [0.5, 1, 0.1]],
  ['cancelScheduledValues', [1]],
];

const cases = METHODS.flatMap(([method, args]) => args.flatMap((_, i) => NON_FINITE.map((bad) => {
  const call = [...args];
  call[i] = bad;
  return [method, i, String(bad), call];
})));

describe('FakeAudioParam argument checks', () => {
  test.each(cases)('%s throws TypeError when argument %i is %s', (method, _i, _label, call) => {
    const param = new FakeAudioParam(1);
    param.setValueAtTime(0.25, 0);
    const events = [...param.events], calls = [...param.calls];
    expect(() => param[method](...call)).toThrow(TypeError);
    expect(() => param[method](...call)).toThrow(/non-finite/);
    // Nothing is recorded or cancelled by a rejected call.
    expect(param.events).toEqual(events);
    expect(param.calls).toEqual(calls);
    expect(param.valueAt(2)).toBe(0.25);
  });

  test.each(METHODS)('%s still accepts finite arguments', (method, args) => {
    const param = new FakeAudioParam(1);
    expect(param[method](...args)).toBe(param);
    expect(param.calls.at(-1)).toEqual([method, ...args]);
  });

  test('numeric strings convert like WebIDL ToNumber', () => {
    const param = new FakeAudioParam(1);
    expect(() => param.setValueAtTime('0.5', '1')).not.toThrow();
  });

  test('a GainNode from FakeAudioContext rejects an Infinity time (the I2b-1 failure)', () => {
    const ctx = new FakeAudioContext();
    const gain = ctx.createGain();
    expect(() => gain.gain.setValueAtTime(1, Infinity)).toThrow(TypeError);
    expect(() => gain.gain.linearRampToValueAtTime(0, Infinity)).toThrow(TypeError);
    expect(() => gain.gain.setTargetAtTime(0, 1, Infinity)).toThrow(TypeError);
    expect(() => gain.gain.cancelScheduledValues(NaN)).toThrow(TypeError);
    expect(gain.gain.events).toEqual([]);
  });
});
