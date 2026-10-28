import {describe, expect, test} from 'vitest';
import {pressPolicy, POLICY, GESTURES, ACTIONS, pointerKind} from '../src/stage/glass.js';

// Spec §4.9 / architecture §2.14.8, row by row:
// [gesture, stopped mouse, stopped touch, stopped pen, playing touch, playing pen, playing mouse]
const TABLE = [
  ['tap',      'cue',      'cue',      'cue',      'pill',   'pill',   'seek'],
  ['double',   'playFrom', 'playFrom', 'playFrom', 'jump',   'jump',   'jump'],
  ['long',     'menu',     'menu',     'menu',     'menu',   'menu',   'menu'],
  ['context',  'menu',     'menu',     'menu',     'menu',   'menu',   'menu'],
  ['longDrag', 'loopDrag', 'loopDrag', 'loopDrag', 'scroll', 'scroll', 'none'],
  ['drag',     'loopDrag', 'scroll',   'scroll',   'scroll', 'scroll', 'loopDrag'],
  ['wheel',    'scroll',   'scroll',   'scroll',   'scroll', 'scroll', 'scroll'],
  ['pinch',    'zoom',     'zoom',     'zoom',     'zoom',   'zoom',   'none'],
];

describe('pressPolicy follows the glass table', () => {
  test.each(TABLE)('%s', (gesture, stoppedMouse, stoppedTouch, stoppedPen, playingTouch, playingPen, playingMouse) => {
    expect(pressPolicy({pointerType: 'mouse', playing: false, gesture})).toBe(stoppedMouse);
    expect(pressPolicy({pointerType: 'touch', playing: false, gesture})).toBe(stoppedTouch);
    expect(pressPolicy({pointerType: 'pen', playing: false, gesture})).toBe(stoppedPen);
    expect(pressPolicy({pointerType: 'touch', playing: true, gesture})).toBe(playingTouch);
    expect(pressPolicy({pointerType: 'pen', playing: true, gesture})).toBe(playingPen);
    expect(pressPolicy({pointerType: 'mouse', playing: true, gesture})).toBe(playingMouse);
  });

  test('the table covers every gesture and only returns known actions', () => {
    expect(TABLE.map(([g]) => g).sort()).toEqual([...GESTURES].sort());
    expect(Object.keys(POLICY).sort()).toEqual([...GESTURES].sort());
    for (const gesture of GESTURES) for (const pointerType of ['mouse', 'touch', 'pen']) for (const playing of [false, true])
      expect(ACTIONS).toContain(pressPolicy({pointerType, playing, gesture}));
  });

  test('a stray touch while playing never seeks, loops or navigates', () => {
    for (const gesture of ['tap', 'drag', 'longDrag', 'wheel', 'long', 'context'])
      for (const pointerType of ['touch', 'pen'])
        expect(['seek', 'loopDrag', 'cue', 'playFrom']).not.toContain(pressPolicy({pointerType, playing: true, gesture}));
  });

  test('unknown pointer types read as touch; unknown gestures do nothing', () => {
    expect(pointerKind('')).toBe('touch');
    expect(pointerKind(undefined)).toBe('touch');
    expect(pressPolicy({pointerType: '', playing: true, gesture: 'tap'})).toBe('pill');
    expect(pressPolicy({pointerType: 'mouse', playing: true, gesture: 'swipe'})).toBe('none');
    expect(pressPolicy({pointerType: 'mouse', playing: false, gesture: 'toString'})).toBe('none');
    expect(pressPolicy()).toBe('none');
  });

  test('the table is frozen', () => {
    expect(Object.isFrozen(POLICY)).toBe(true);
    expect(Object.isFrozen(POLICY.drag.stopped)).toBe(true);
  });
});
