import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {actionsFor, createClassifier, DOUBLE_MS, HOLD_MS, PROFILES, profileBindings, SETLIST_RIGHT_HOLD} from '../src/app/pedals.js';

const CODES = {PageUp: 'left', PageDown: 'right', KeyB: 'p3', KeyN: 'p4'};
const slotFor = e => CODES[e.code] ?? null;
const ev = (code, repeat = false) => ({code, repeat});

let fired;
function make({bindings = PROFILES.practice, canHold = () => true, ...opts} = {}) {
  fired = [];
  return createClassifier({
    slotFor,
    actionFor: actionsFor(bindings, {canHold}),
    canHold,
    fire: (id, info) => fired.push({id, ...info}),
    ...opts,
  });
}

beforeEach(() => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance']});
});
afterEach(() => vi.useRealTimers());

describe('timings', () => {
  it('uses 600 ms holds and 350 ms double-taps by default', () => {
    expect(HOLD_MS).toBe(600);
    expect(DOUBLE_MS).toBe(350);
  });
});

describe('hold-capable pedals', () => {
  it('a short press is a tap, fired on keyup', () => {
    const c = make();
    c.down(ev('PageDown'));
    vi.advanceTimersByTime(80);
    expect(fired).toEqual([]);
    c.up(ev('PageDown'));
    expect(fired).toEqual([{id: 'transport.playStop', slot: 'right', gesture: 'tap'}]);
  });

  it('a press of 600 ms fires hold at the threshold, and the keyup does nothing', () => {
    const c = make();
    c.down(ev('PageDown'));
    vi.advanceTimersByTime(599);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([{id: 'nav.nextSection', slot: 'right', gesture: 'hold'}]);
    vi.advanceTimersByTime(2000);
    c.up(ev('PageDown'));
    expect(fired).toHaveLength(1);
  });

  it('a press just under the threshold is still a tap', () => {
    const c = make();
    c.down(ev('PageUp'));
    vi.advanceTimersByTime(599);
    c.up(ev('PageUp'));
    vi.advanceTimersByTime(1000);
    expect(fired).toEqual([{id: 'transport.again', slot: 'left', gesture: 'tap'}]);
  });

  it('auto-repeat means hold, fired once', () => {
    const c = make();
    c.down(ev('PageUp'));
    vi.advanceTimersByTime(30);
    c.down(ev('PageUp', true));
    c.down(ev('PageUp', true));
    vi.advanceTimersByTime(1000);
    c.up(ev('PageUp'));
    expect(fired).toEqual([{id: 'nav.prevSection', slot: 'left', gesture: 'hold'}]);
  });

  it('honours custom timings', () => {
    const c = make({holdMs: 300});
    c.down(ev('PageDown'));
    vi.advanceTimersByTime(300);
    expect(fired.map(f => f.gesture)).toEqual(['hold']);
  });
});

describe('keydown fire when no hold action exists (the Play/Stop rule)', () => {
  it('fires tap on keydown, and auto-repeat or keyup add nothing', () => {
    const c = make({bindings: PROFILES.pageturn});
    c.down(ev('PageDown'));
    expect(fired).toEqual([{id: 'stage.scrollDown', slot: 'right', gesture: 'tap'}]);
    c.down(ev('PageDown', true));
    vi.advanceTimersByTime(1000);
    c.up(ev('PageDown'));
    expect(fired).toHaveLength(1);
  });

  it('third and fourth pedals fire at once', () => {
    const c = make();
    c.down(ev('KeyB'));
    c.down(ev('KeyN'));
    expect(fired.map(f => f.id)).toEqual(['transport.loopToggle', 'mix.minusMe']);
  });

  it('Play/Stop on a tap-only custom right pedal fires on keydown', () => {
    const c = make({bindings: profileBindings('custom', {custom: {right: {tap: 'transport.playStop'}}})});
    c.down(ev('PageDown'));
    expect(fired).toEqual([{id: 'transport.playStop', slot: 'right', gesture: 'tap'}]);
  });
});

describe('pedals that cannot hold: double-tap is the hold action', () => {
  const noHold = () => false;

  it('one press is a tap after the 350 ms window', () => {
    const c = make({canHold: noHold});
    c.down(ev('PageDown'));
    c.up(ev('PageDown'));
    vi.advanceTimersByTime(349);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([{id: 'transport.playStop', slot: 'right', gesture: 'tap'}]);
  });

  it('two presses inside the window are a double (the profile hold)', () => {
    const c = make({canHold: noHold});
    c.down(ev('PageDown'));
    c.up(ev('PageDown'));
    vi.advanceTimersByTime(200);
    c.down(ev('PageDown'));
    c.up(ev('PageDown'));
    vi.advanceTimersByTime(1000);
    expect(fired).toEqual([{id: 'nav.nextSection', slot: 'right', gesture: 'double'}]);
  });

  it('two presses further apart are two taps', () => {
    const c = make({canHold: noHold});
    c.down(ev('PageUp')); c.up(ev('PageUp'));
    vi.advanceTimersByTime(400);
    c.down(ev('PageUp')); c.up(ev('PageUp'));
    vi.advanceTimersByTime(400);
    expect(fired.map(f => `${f.id}:${f.gesture}`)).toEqual(['transport.again:tap', 'transport.again:tap']);
  });

  it('holding never fires a hold', () => {
    const c = make({canHold: noHold});
    c.down(ev('PageDown'));
    vi.advanceTimersByTime(2000);
    expect(fired).toEqual([]);
    c.up(ev('PageDown'));
    vi.advanceTimersByTime(350);
    expect(fired.map(f => f.gesture)).toEqual(['tap']);
  });

  it('a tap-only slot still fires on keydown', () => {
    const c = make({canHold: noHold});
    c.down(ev('KeyB'));
    expect(fired.map(f => f.id)).toEqual(['transport.loopToggle']);
  });
});

describe('slots and reset', () => {
  it('ignores keys without a slot', () => {
    const c = make();
    expect(c.down(ev('KeyQ'))).toBe(false);
    expect(c.up(ev('KeyQ'))).toBe(false);
    expect(c.down(ev('PageDown'))).toBe(true);
    expect(fired).toEqual([]);
  });

  it('a keyup without its keydown does nothing', () => {
    const c = make();
    expect(c.up(ev('PageDown'))).toBe(true);
    expect(fired).toEqual([]);
  });

  it('slots are independent', () => {
    const c = make();
    c.down(ev('PageUp'));
    vi.advanceTimersByTime(300);
    c.down(ev('PageDown'));
    vi.advanceTimersByTime(300);
    c.up(ev('PageDown'));
    expect(fired.map(f => `${f.slot}:${f.gesture}`)).toEqual(['left:hold', 'right:tap']);
  });

  it('reset cancels pending holds and double-tap windows', () => {
    const c = make({canHold: s => s !== 'left'});
    c.down(ev('PageDown'));
    c.down(ev('PageUp')); c.up(ev('PageUp'));
    c.reset();
    vi.advanceTimersByTime(5000);
    expect(fired).toEqual([]);
  });

  it('needs its callbacks', () => {
    expect(() => createClassifier({slotFor})).toThrow(TypeError);
  });
});

describe('profiles (spec §7.5)', () => {
  it('match the spec table', () => {
    expect(PROFILES).toEqual({
      practice: {left: {tap: 'transport.again', hold: 'nav.prevSection'}, right: {tap: 'transport.playStop', hold: 'nav.nextSection'},
        p3: {tap: 'transport.loopToggle'}, p4: {tap: 'mix.minusMe'}},
      navigate: {left: {tap: 'nav.prevSection', hold: 'transport.loopToggle'}, right: {tap: 'nav.nextSection', hold: 'transport.playStop'},
        p3: {tap: 'transport.loopToggle'}, p4: {tap: 'mix.minusMe'}},
      pageturn: {left: {tap: 'stage.scrollUp', hold: 'stage.scrollTop'}, right: {tap: 'stage.scrollDown'}},
    });
    expect(Object.isFrozen(PROFILES.practice.left)).toBe(true);
  });

  it('in a setlist the practice right hold is the next song', () => {
    expect(profileBindings('practice', {inSetlist: true}).right).toEqual({tap: 'transport.playStop', hold: SETLIST_RIGHT_HOLD});
    expect(profileBindings('navigate', {inSetlist: true}).right.hold).toBe('transport.playStop');
    expect(profileBindings('practice').right.hold).toBe('nav.nextSection');
    expect(PROFILES.practice.right.hold).toBe('nav.nextSection');                // the table itself is never changed
  });

  it('unknown profiles fall back to practice', () => {
    expect(profileBindings('nope')).toEqual(profileBindings('practice'));
  });

  it('custom bindings keep only pedal commands', () => {
    const pedal = new Set(['transport.again', 'trainer.toggle']);
    const b = profileBindings('custom', {custom: {left: {tap: 'transport.again', hold: 'nav.goTo'}, right: {tap: 'nav.goTo'},
      p3: {hold: 'trainer.toggle'}}, isPedalCommand: id => pedal.has(id)});
    expect(b).toEqual({left: {tap: 'transport.again'}, p3: {hold: 'trainer.toggle'}});
  });

  it('actionsFor maps hold to double for pedals that cannot hold', () => {
    const a = actionsFor(PROFILES.practice, {canHold: s => s === 'left'});
    expect(a('left', 'hold')).toBe('nav.prevSection');
    expect(a('left', 'double')).toBe(null);
    expect(a('right', 'hold')).toBe(null);
    expect(a('right', 'double')).toBe('nav.nextSection');
    expect(a('right', 'tap')).toBe('transport.playStop');
    expect(a('p4', 'hold')).toBe(null);
    expect(a('nope', 'tap')).toBe(null);
    expect(a('left', 'swipe')).toBe(null);
  });
});
