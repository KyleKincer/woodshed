// @vitest-environment happy-dom
// The first Stage coach marks (src/stage/coach.js; architecture §2.19, spec §6.6 item 5): steps 1–3
// (Play, strip, Mix) as `i of 3 · Skip`, step 4 (the first song with no bars) with [Get bars], each
// dismissed by doing the thing, never shown while playing, nothing before the account loads, and
// the account.onboarding.coach bitmask (bits 1, 2, 4, 8) written through the real account
// controller (src/app/account.js) over an in-memory settings API.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

let sheetOpen = null;
vi.mock('../src/stage/sheets/host.js', () => ({openSheetName: () => sheetOpen}));

import {createAccount} from '../src/app/account.js';
import {createRegistry} from '../src/app/commands.js';
import {signal} from '../src/app/store.js';
import {ALL_BITS, COPY, SHEET_POLL_MS, STEPS, STRIP_WINDOW_MS, TOUR_BITS, coachMask, nextStep, partLabel, startStageCoach} from '../src/stage/coach.js';
import {mergeSettings, withDefaults} from '../convex/lib/presets.ts';
import {CoachMark} from '../src/ui/coachmark.js';
import {createFakeSession} from './helpers/fake-session.js';
import {sevenEight, tempoOf} from './fixtures/maps.js';
import {installPopoverShim, isPopoverOpen, pointer, restoreDomShims, tap} from './helpers/dom.js';

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

let offs = [];

/** The real account controller over an in-memory settings API (settings.patch merges and echoes). */
function makeAccount({coach, loaded = true, fail = false} = {}) {
  const settings = loaded ? withDefaults({onboarding: coach === undefined ? {whatDoYouPlay: 'done'} : {whatDoYouPlay: 'done', coach}}) : null;
  const store = {config: signal(null), account: signal(settings), pendingAccount: signal(null)};
  const patches = [];
  const api = {
    subscribeConfig: () => () => {},
    patch: vi.fn(async (partial) => {
      patches.push(partial);
      if (fail) throw Object.assign(new Error('offline'), {code: 'network'});
      const merged = mergeSettings(withDefaults(store.account.peek()), partial);
      store.account.value = merged;
      return merged;
    }),
  };
  const account = createAccount({store, api, toast: () => {}});
  return {account, store, api, patches, coach: () => account.onboarding.peek()?.coach};
}

/** A Stage stand-in: the 'stage' context's anchors Map (as stage.js and controls.js fill it) and signals. */
function makeStage({mix = true, strip = true} = {}) {
  const root = document.createElement('div');
  root.className = 'stage';
  const controls = document.createElement('div');
  controls.setAttribute('data-stage-anchor', 'controls');
  // The rail's control set (controls.js): [loop|mix][again|play] cells.
  const set = document.createElement('div');
  set.className = 'ctl-set';
  set.setAttribute('role', 'toolbar');
  set.dataset.variant = 'rail';
  const cell = (id, child) => {
    const c = document.createElement('div');
    c.className = 'ctl';
    c.dataset.ctl = id;
    if (child) c.append(child);
    set.append(c);
    return c;
  };
  const play = document.createElement('button');
  play.textContent = 'Play';
  play.dataset.variant = 'primary';   // Button's own data-variant
  const mixEl = document.createElement('div');
  mixEl.className = 'ctl-mix';
  const loopCell = cell('loop');
  cell('mix', mixEl);
  const againCell = cell('again');
  cell('play', play);
  controls.append(set);
  const stripEl = document.createElement('div');
  stripEl.setAttribute('data-stage-anchor', 'strip');
  const segment = document.createElement('div');
  segment.className = 'strip-seg';
  stripEl.append(segment);
  root.append(stripEl, controls);
  document.body.append(root);
  if (!strip) stripEl.hidden = true;
  const anchors = new (class extends Map {
    get(name) {
      const own = super.get(name);
      if (own?.isConnected) return own;
      const marked = root.querySelector(`[data-stage-anchor="${name}"]`);
      if (marked) return marked;
      if (name === 'getBars' || name === 'strip') return stripEl;
      return controls;
    }
  })();
  anchors.set('play', play);
  if (mix) anchors.set('mix', mixEl);
  return {anchors, layout: signal('rail'), focus: signal(false), surface: signal('chart'), els: {root, play, mix: mixEl, strip: stripEl, segment, controls, again: againCell, loop: loopCell}};
}

function makeRegistry() {
  const registry = createRegistry();
  const ran = [];
  registry.register({id: 'stage.getBars', title: 'Get bars…', group: 'Practice', scopes: ['stage'],
    run: () => { ran.push('stage.getBars'); sheetOpen = 'getBars'; }});
  return {registry, ran};
}

function start({session = createFakeSession(), stage = makeStage(), account = makeAccount(), registry = makeRegistry()} = {}) {
  const off = startStageCoach({stage, session, account: account.account, registry: registry.registry});
  offs.push(off);
  return {off, session, stage, account, registry};
}

const marks = () => [...document.querySelectorAll('.ui-coachmark')];
const shown = () => marks().filter((el) => isPopoverOpen(el));
const markText = (el) => el.querySelector('.ui-coachmark-body').textContent;
const stepText = (el) => {
  const s = el.querySelector('.ui-coachmark-step');
  return s.hidden ? '' : s.textContent;
};

beforeEach(() => {
  installPopoverShim();
  sheetOpen = null;
  offs = [];
});

afterEach(() => {
  for (const off of offs) off();
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreDomShims();
  document.body.replaceChildren();
});

describe('pure', () => {
  test('STEPS: ids, bits and anchors in spec order', () => {
    expect(STEPS.map((s) => [s.id, s.bit, s.anchor, s.tour])).toEqual([
      ['play', 1, 'play', 1], ['strip', 2, 'strip', 2], ['mix', 4, 'mix', 3], ['bars', 8, 'getBars', null],
    ]);
    expect(TOUR_BITS).toBe(7);
    expect(ALL_BITS).toBe(15);
  });

  test.each([
    [0, {play: true, strip: true, mix: true, bars: false}, 'play'],
    [1, {play: true, strip: true, mix: true, bars: false}, 'strip'],
    [1, {play: true, strip: false, mix: true, bars: true}, 'mix'],
    [3, {play: true, strip: true, mix: true, bars: false}, 'mix'],
    [7, {play: true, strip: true, mix: true, bars: true}, 'bars'],
    [7, {play: true, strip: true, mix: true, bars: false}, null],
    [5, {play: true, strip: false, mix: true, bars: false}, null],
    [0, {play: false, strip: false, mix: false, bars: true}, 'bars'],
    [15, {play: true, strip: true, mix: true, bars: true}, null],
  ])('nextStep(%i, %o) → %s', (mask, available, id) => {
    expect(nextStep(mask, available)?.id ?? null).toBe(id);
  });

  test('coachMask reads stored values as a whole number 0–15', () => {
    expect([undefined, null, -1, 2.5, '3', 0, 5, 15, 31].map(coachMask)).toEqual([0, 0, 0, 0, 0, 0, 5, 15, 15]);
  });

  test('partLabel is the Mix control’s own label for your part', () => {
    expect(partLabel({mix: {mine: ['drums']}})).toBe('Drums');
    expect(partLabel({mix: {mine: ['bass', 'other']}})).toBe('Mine');
  });

  test('startStageCoach needs a stage and a session', () => {
    expect(() => startStageCoach({session: createFakeSession()})).toThrow(TypeError);
    expect(() => startStageCoach({stage: makeStage()})).toThrow(TypeError);
  });
});

describe('the tour on a mapped song', () => {
  test('step 1 on Play: "1 of 3 · Skip", anchored, non-blocking; the spec copy with bold keys', async () => {
    const {stage} = start();
    await flush();
    const [el] = shown();
    expect(el).toBeTruthy();
    expect(el.dataset.coachStep).toBe('play');
    expect(el.dataset.testid).toBe('coach-play');
    expect(el.classList.contains('stage-coach')).toBe(true);
    expect(el.getAttribute('role')).toBe('status');
    expect(markText(el)).toBe('Space or ▶ plays from your loop. Enter starts again with a count-in.');
    expect([...el.querySelectorAll('strong')].map((s) => s.textContent)).toEqual(['Space', 'Enter']);
    expect(stepText(el)).toBe('1 of 3');
    expect(el.querySelector('.ui-coachmark-skip').textContent).toBe(COPY.skip);
    expect(document.activeElement).not.toBe(el.querySelector('.ui-coachmark-skip'));
  });

  test('playing dismisses step 1 (bit 1); step 2 waits for Stop, then the strip; then Mix', async () => {
    const {session, account, stage} = start();
    await flush();
    session.transport.set({phase: 'playing'});
    await flush();
    expect(account.coach()).toBe(1);
    expect(shown()).toHaveLength(0);                       // never while playing
    session.transport.set({phase: 'stopped'});
    await flush();
    const [strip] = shown();
    expect(strip.dataset.coachStep).toBe('strip');
    expect(markText(strip)).toBe('Tap a section to jump there. Double-tap to loop it.');
    expect(stepText(strip)).toBe('2 of 3');

    // A cue change that did not come from the strip is not the strip's.
    session.transport.set({cue: 12});
    await flush();
    expect(account.coach()).toBe(1);
    // A press on a section, then the cue it causes.
    pointer(stage.els.segment, 'pointerdown');
    session.transport.set({cue: 24});
    await flush();
    expect(account.coach()).toBe(3);

    const [mix] = shown();
    expect(mix.dataset.coachStep).toBe('mix');
    expect(markText(mix)).toBe('Drums OUT takes your part out of the mix. You play it.');
    expect(mix.querySelector('strong').textContent).toBe('Drums OUT');
    expect(stepText(mix)).toBe('3 of 3');
    session.transport.set({mix: {minusMe: true}});
    await flush();
    expect(account.coach()).toBe(7);
    expect(shown()).toHaveLength(0);
    expect(marks()).toHaveLength(0);
  });

  test('a strip press counts only inside its window', async () => {
    vi.useFakeTimers({toFake: ['Date', 'setTimeout', 'clearTimeout']});
    const {session, account, stage} = start({account: makeAccount({coach: 1})});
    await flush();
    pointer(stage.els.segment, 'pointerdown');
    vi.advanceTimersByTime(STRIP_WINDOW_MS + 10);
    session.transport.set({loop: {on: true, a: 8, b: 16}});
    await flush();
    expect(account.coach()).toBe(1);
    pointer(stage.els.segment, 'pointerdown');
    session.transport.set({loop: {on: true, a: 16, b: 24}});
    await flush();
    expect(account.coach()).toBe(3);
  });

  test('the keyboard path: a loop set while the strip has focus (L on the focused segment) does step 2', async () => {
    const {session, account, stage} = start({account: makeAccount({coach: 1})});
    await flush();
    session.transport.set({loop: {on: true, a: 8, b: 16}});      // focus elsewhere: not the strip's
    await flush();
    expect(account.coach()).toBe(1);
    stage.els.segment.tabIndex = 0;
    stage.els.segment.focus();
    session.transport.set({loop: {on: true, a: 16, b: 24}});
    await flush();
    expect(account.coach()).toBe(3);
  });

  test('a stem muted in the Mix sheet also does the Mix step; a song opening with your part out does not', async () => {
    const open = start({account: makeAccount({coach: 3}), session: createFakeSession({snapshot: {mix: {minusMe: true}}})});
    await flush();
    expect(open.account.coach()).toBe(3);
    expect(shown()[0].dataset.coachStep).toBe('mix');
    const tracks = open.session.transport.snapshot.peek().mix.tracks.map((t) => (t.name === 'bass' ? {...t, muted: true} : t));
    open.session.transport.set({mix: {tracks}});
    await flush();
    expect(open.account.coach()).toBe(7);
  });

  test('Skip ends the whole tour (bits 1, 2, 4) in one write', async () => {
    const {account} = start();
    await flush();
    tap(shown()[0].querySelector('.ui-coachmark-skip'));
    await flush();
    expect(account.coach()).toBe(TOUR_BITS);
    expect(account.patches).toEqual([{onboarding: {coach: 7}}]);
    expect(marks()).toHaveLength(0);
  });

  test('a finished account shows nothing; a song without sections skips step 2', async () => {
    start({account: makeAccount({coach: 15})});
    await flush();
    expect(marks()).toHaveLength(0);
    for (const off of offs.splice(0)) off();
    document.body.replaceChildren();

    const {account} = start({account: makeAccount({coach: 1}), session: createFakeSession({tempo: tempoOf(sevenEight), duration: sevenEight.duration})});
    await flush();
    expect(shown()[0].dataset.coachStep).toBe('mix');
    expect(account.coach()).toBe(1);
  });
});

describe('when the marks show', () => {
  test('nothing before the account loads; a step done meanwhile is written once it does', async () => {
    const acc = makeAccount({loaded: false});
    const {session} = start({account: acc});
    await flush();
    expect(marks()).toHaveLength(0);
    session.transport.set({phase: 'playing'});
    await flush();
    session.transport.set({phase: 'stopped'});
    await flush();
    expect(acc.api.patch).not.toHaveBeenCalled();
    acc.store.account.value = withDefaults({onboarding: {whatDoYouPlay: 'done', coach: 4}});
    await flush();
    expect(acc.patches).toEqual([{onboarding: {coach: 5}}]);
    expect(shown()[0].dataset.coachStep).toBe('strip');
  });

  test('never while playing: a Stage that opens playing shows step 1 only after Stop', async () => {
    const {session} = start({session: createFakeSession({snapshot: {phase: 'counting'}})});
    await flush();
    expect(shown()).toHaveLength(0);
    // Counting in is playing: step 1 is done already.
    session.transport.set({phase: 'stopped'});
    await flush();
    expect(shown()[0].dataset.coachStep).toBe('strip');
  });

  test('Mix waits for its control (the Focus mini rail has none) and returns with it', async () => {
    const stage = makeStage({mix: false});
    const {account} = start({stage, account: makeAccount({coach: 3})});
    await flush();
    expect(marks()).toHaveLength(0);
    stage.anchors.set('mix', stage.els.mix);
    stage.focus.value = true;
    await flush();
    expect(shown()[0].dataset.coachStep).toBe('mix');
    stage.anchors.delete('mix');
    stage.focus.value = false;
    await flush();
    expect(marks()).toHaveLength(0);
    expect(account.coach()).toBe(3);                       // taken down, not done
  });

  test('placement: left of the rail from the control’s row (Again beside Play, Loop beside Mix), above the dock; it follows a relayout', async () => {
    const stage = makeStage();
    const made = [];
    const updates = [];
    const spy = (props) => {
      made.push(props);
      const handle = CoachMark(props);
      const set = handle.set;
      return Object.assign(handle, {set(partial) { updates.push(partial); return set(partial); }});
    };
    const acc = makeAccount();
    const session = createFakeSession();
    offs.push(startStageCoach({stage, session, account: acc.account, registry: makeRegistry().registry, CoachMark: spy}));
    await flush();
    expect(made.map((p) => [p.dataset.coachStep, p.anchor, p.placement])).toEqual([['play', stage.els.again, 'left']]);
    stage.layout.value = 'band';
    await flush();
    expect(made).toHaveLength(1);
    expect(updates).toEqual([{anchor: stage.els.play, placement: 'top'}]);
    stage.layout.value = 'rail';
    await flush();
    acc.store.account.value = withDefaults({onboarding: {whatDoYouPlay: 'done', coach: 3}});
    await flush();
    expect(made.map((p) => [p.dataset.coachStep, p.anchor, p.placement])[1]).toEqual(['mix', stage.els.loop, 'left']);
  });

  test('step 4 points at the strip’s "No bar grid · Get bars →" tray when it shows', async () => {
    const stage = makeStage();
    const tray = document.createElement('div');
    tray.className = 'strip-tray';
    stage.els.strip.append(tray);
    const made = [];
    const spy = (props) => { made.push(props); return CoachMark(props); };
    offs.push(startStageCoach({stage, session: createFakeSession({mapped: false}), account: makeAccount({coach: 7}).account,
      registry: makeRegistry().registry, CoachMark: spy}));
    await flush();
    expect(made.map((p) => [p.dataset.coachStep, p.anchor, p.placement])).toEqual([['bars', tray, 'top']]);
    expect(shown()).toHaveLength(1);
  });

  test('a hidden strip (Focus on the band) is no anchor', async () => {
    start({stage: makeStage({strip: false}), account: makeAccount({coach: 1})});
    await flush();
    expect(shown()[0].dataset.coachStep).toBe('mix');
  });
});

describe('step 4: the first song with no bars', () => {
  test('"No bar grid yet…" [Get bars] with no counter; the button runs stage.getBars and ends it (bit 8)', async () => {
    const reg = makeRegistry();
    const {account} = start({session: createFakeSession({mapped: false}), account: makeAccount({coach: 7}), registry: reg});
    await flush();
    const [el] = shown();
    expect(el.dataset.coachStep).toBe('bars');
    expect(markText(el)).toBe('No bar grid yet, so times are in seconds. Get bars');
    expect(stepText(el)).toBe('');
    expect(el.querySelector('.ui-coachmark-skip').textContent).toBe(COPY.notNow);
    const button = el.querySelector('.stage-coach-action');
    expect(button.tagName).toBe('BUTTON');
    button.click();
    await flush();
    expect(reg.ran).toEqual(['stage.getBars']);
    expect(account.coach()).toBe(15);
    expect(marks()).toHaveLength(0);
  });

  test('Get bars opened elsewhere ends it: a press on the strip chip, a key, or a pedal (no press at all)', async () => {
    const chip = start({session: createFakeSession({mapped: false}), account: makeAccount({coach: 7})});
    await flush();
    expect(shown()[0].dataset.coachStep).toBe('bars');
    sheetOpen = 'getBars';
    chip.stage.els.strip.click();
    await flush();
    expect(chip.account.coach()).toBe(15);
    for (const off of offs.splice(0)) off();
    document.body.replaceChildren();
    sheetOpen = null;

    vi.useFakeTimers({toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date']});
    const pedal = start({session: createFakeSession({mapped: false}), account: makeAccount({coach: 7})});
    await flush();
    pedal.registry.registry.run('stage.getBars', {source: 'pedal'});
    await flush();
    expect(pedal.account.coach()).toBe(7);
    vi.advanceTimersByTime(SHEET_POLL_MS);
    await flush();
    expect(pedal.account.coach()).toBe(15);
    expect(marks()).toHaveLength(0);
  });

  test('Not now sets only bit 8; an unmapped song runs the tour first, without step 2', async () => {
    const {account, session} = start({session: createFakeSession({mapped: false})});
    await flush();
    expect(shown()[0].dataset.coachStep).toBe('play');
    session.transport.set({phase: 'playing'});
    await flush();
    session.transport.set({phase: 'stopped'});
    await flush();
    expect(shown()[0].dataset.coachStep).toBe('mix');
    session.transport.set({mix: {minusMe: true}});
    await flush();
    expect(account.coach()).toBe(5);
    expect(shown()[0].dataset.coachStep).toBe('bars');
    tap(shown()[0].querySelector('.ui-coachmark-skip'));
    await flush();
    expect(account.coach()).toBe(13);
    expect(marks()).toHaveLength(0);
  });

  test('not on a read-only Shared Stage', async () => {
    start({session: createFakeSession({mapped: false, readOnly: true}), account: makeAccount({coach: 7})});
    await flush();
    expect(marks()).toHaveLength(0);
  });
});

describe('lifecycle', () => {
  test('a failed save keeps the step done on this Stage, warns once and is not retried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const acc = makeAccount({fail: true});
    const {session} = start({account: acc});
    await flush();
    session.transport.set({phase: 'playing'});
    await flush(6);
    session.transport.set({phase: 'stopped'});
    await flush(6);
    expect(acc.api.patch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(acc.coach()).toBeUndefined();
    expect(shown()[0].dataset.coachStep).toBe('strip');
  });

  test('a second start for the same Stage returns the running coach’s off(); off() takes the mark down', async () => {
    const stage = makeStage();
    const account = makeAccount();
    const registry = makeRegistry();
    const session = createFakeSession();
    const a = startStageCoach({stage, session, account: account.account, registry: registry.registry});
    const b = startStageCoach({stage, session, account: account.account, registry: registry.registry});
    expect(b).toBe(a);
    await flush();
    expect(marks()).toHaveLength(1);
    a();
    expect(marks()).toHaveLength(0);
    session.transport.set({phase: 'playing'});
    await flush();
    expect(account.api.patch).not.toHaveBeenCalled();
    const c = startStageCoach({stage, session, account: account.account, registry: registry.registry});
    expect(c).not.toBe(a);
    offs.push(c);
  });
});
