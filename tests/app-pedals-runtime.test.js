// @vitest-environment happy-dom
// Pedal mode and MIDI pedals at runtime (architecture §2.7, §9 PD1; spec §7.5): startPedals and learn on the real
// dispatcher and a registry, and startMidi / learnMidi on the fixture's virtual MIDI input (tests/fixture/fakes/midi.js).
// The classifier's own timing rules are F3's (tests/app-pedals.test.js); here they run end to end through key events.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createRegistry} from '../src/app/commands.js';
import {startDispatcher} from '../src/app/dispatch.js';
import {clock as appClock} from '../src/app/clock.js';
import {prefs as appPrefs} from '../src/app/prefs.js';
import {signal} from '../src/app/store.js';
import {
  HOLD_MS, DOUBLE_MS, LEARN_PROMPTS, PEDAL_SOURCE, isPedalMode, learn, pedalCommands, pedalConfig, pedalMode, startPedals,
} from '../src/app/pedals.js';
import {
  CC_THRESHOLD, MIDI_SOURCE, TRIGGER_GAP_MS, bindingFor, learnMidi, midiConfig, midiState, parseMidi, resetMidiForTests,
  startMidi, triggerLabel,
} from '../src/app/midi.js';
import {installMidi} from './fixture/fakes/midi.js';

const TIMERS = {toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']};

let current = [];
let runs;

beforeEach(() => {
  vi.useFakeTimers(TIMERS);
  vi.setSystemTime(Date.parse('2026-10-29T12:00:00Z'));
  appClock.set();
  runs = [];
});

afterEach(() => {
  for (const off of current.splice(0).reverse()) off();
  resetMidiForTests();
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** A registry with Stage-like commands that record their runs, the dispatcher on window, and prefs in a signal. */
function bed({pedals = {}, midi = {}, setlist = null, enabled = () => true, start = true} = {}) {
  const reg = createRegistry();
  const rec = id => c => runs.push({id, source: c.source});
  const cmd = (id, keys, extra = {}) => ({id, title: id, group: 'Transport', keys, scopes: ['stage'], pedal: true, when: () => enabled(id), run: rec(id), ...extra});
  reg.registerMany([
    cmd('transport.again', ['Enter']),
    cmd('transport.playStop', ['Space']),
    cmd('transport.loopToggle', ['KeyL']),
    cmd('nav.prevSection', ['[', 'PageUp'], {group: 'Navigate'}),
    cmd('nav.nextSection', [']', 'PageDown'], {group: 'Navigate'}),
    cmd('spot.save', ['KeyB'], {group: 'Practice'}),
    cmd('mix.minusMe', ['KeyM'], {group: 'Mix'}),
    cmd('setlist.next', ['Alt+ArrowDown'], {group: 'Navigate'}),
    cmd('trainer.toggle', [], {group: 'Speed'}),
    {id: 'app.notPedal', title: 'Not a pedal command', group: 'App', keys: ['KeyN'], scopes: ['stage'], run: rec('app.notPedal')},
  ]);
  reg.provide('posture', () => 'stage');
  reg.provide('stage', () => ({setlist: signal(setlist)}));
  const prefsSig = signal({pedals: {enabled: false, profile: 'practice', pedals: [], custom: {}, ...pedals}, midi: {enabled: false, bindings: [], ...midi}});
  const prefs = {value: prefsSig, set: (path, v) => { const [a, b] = path.split('.'); prefsSig.value = {...prefsSig.peek(), [a]: {...prefsSig.peek()[a], [b]: v}}; }};
  current.push(startDispatcher({target: window, registry: reg}));
  const fired = [];
  if (start) current.push(startPedals({registry: reg, prefs, onFire: (id, d) => fired.push({id, ...d})}));
  return {reg, prefs, prefsSig, fired};
}

const LEFT = {slot: 'left', code: 'KeyB', canHold: true};
const RIGHT = {slot: 'right', code: 'PageDown', canHold: true};

function key(type, code, extra = {}) {
  const keyOf = {KeyB: 'b', KeyN: 'n', KeyT: 't', PageDown: 'PageDown', PageUp: 'PageUp', Space: ' ', Enter: 'Enter', Escape: 'Escape', ShiftLeft: 'Shift', Tab: 'Tab'}[code] ?? code;
  const e = new KeyboardEvent(type, {code, key: keyOf, bubbles: true, cancelable: true, ...extra});
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}
const down = (code, extra) => key('keydown', code, extra);
const up = (code, extra) => key('keyup', code, extra);
async function press(code, ms = 80) {
  down(code);
  await vi.advanceTimersByTimeAsync(ms);
  return up(code);
}
const ids = () => runs.map(r => r.id);

describe('pedalConfig and pedal mode', () => {
  test('reads stored prefs.pedals one way: unknown profiles, bad or duplicate pedals and empty custom entries drop out', () => {
    expect(pedalConfig(undefined)).toEqual({enabled: false, profile: 'practice', pedals: [], custom: {}, on: false});
    const cfg = pedalConfig({
      enabled: true, profile: 'stomp',
      pedals: [RIGHT, {slot: 'left', code: 'KeyB'}, {slot: 'left', code: 'KeyC'}, {slot: 'p3', code: 'PageDown'}, {slot: 'p9', code: 'KeyD'}, {slot: 'p4', code: ''}, 'x'],
      custom: {left: {tap: 'transport.again', hold: 7}, right: {}, p3: 'nope'},
    });
    expect(cfg.profile).toBe('practice');
    expect(cfg.pedals).toEqual([{slot: 'left', code: 'KeyB', canHold: true}, RIGHT]);
    expect(cfg.custom).toEqual({left: {tap: 'transport.again'}});
    expect(cfg.on).toBe(true);
    expect(isPedalMode({enabled: true, pedals: []})).toBe(false);
    expect(isPedalMode({enabled: false, pedals: [LEFT]})).toBe(false);
  });

  test('pedalMode (the HUD’s ⎍) follows this device’s prefs', () => {
    appPrefs.set('pedals', {enabled: false, profile: 'practice', pedals: [LEFT, RIGHT], custom: {}});
    expect(pedalMode.value).toBe(false);
    appPrefs.set('pedals.enabled', true);
    expect(pedalMode.value).toBe(true);
    appPrefs.set('pedals.pedals', []);
    expect(pedalMode.value).toBe(false);
  });

  test('pedalCommands lists only commands marked pedal, by group and title', () => {
    const {reg} = bed({start: false});
    const list = pedalCommands(reg);
    expect(list.map(c => c.id)).not.toContain('app.notPedal');
    expect(list[0]).toMatchObject({group: 'Mix', id: 'mix.minusMe'});
    expect(list.map(c => c.id)).toContain('trainer.toggle');
  });
});

describe('pedal mode on the dispatcher', () => {
  test('without pedal mode the keys are ordinary: PageDown is next section, B saves a spot', async () => {
    bed({pedals: {pedals: [LEFT, RIGHT]}});
    await press('PageDown');
    await press('KeyB');
    expect(runs).toEqual([{id: 'nav.nextSection', source: 'key'}, {id: 'spot.save', source: 'key'}]);
  });

  test('in pedal mode a learned code belongs to the pedals, ahead of its keyboard binding (Practice profile)', async () => {
    const {fired} = bed({pedals: {enabled: true, pedals: [LEFT, RIGHT]}});
    const e = down('KeyB');
    expect(e.defaultPrevented).toBe(true);
    expect(runs).toEqual([]);                              // left has a hold action: the tap waits for the keyup
    await vi.advanceTimersByTimeAsync(80);
    expect(up('KeyB').defaultPrevented).toBe(true);
    expect(runs).toEqual([{id: 'transport.again', source: PEDAL_SOURCE}]);
    await press('PageDown');
    expect(ids()).toEqual(['transport.again', 'transport.playStop']);
    expect(fired.map(f => [f.id, f.slot, f.gesture])).toEqual([['transport.again', 'left', 'tap'], ['transport.playStop', 'right', 'tap']]);
    // An unlearned key is still a key.
    await press('KeyN');
    expect(runs.at(-1)).toEqual({id: 'app.notPedal', source: 'key'});
  });

  test('a hold fires at the threshold, before the keyup; auto-repeat is a hold at once', async () => {
    bed({pedals: {enabled: true, pedals: [LEFT, RIGHT]}});
    down('KeyB');
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ids()).toEqual(['nav.prevSection']);
    await vi.advanceTimersByTimeAsync(400);
    up('KeyB');
    expect(ids()).toEqual(['nav.prevSection']);
    down('PageDown');
    down('PageDown', {repeat: true});
    expect(ids()).toEqual(['nav.prevSection', 'nav.nextSection']);
    down('PageDown', {repeat: true});
    up('PageDown');
    expect(ids()).toEqual(['nav.prevSection', 'nav.nextSection']);
  });

  test('Play/Stop fires on keydown when no hold action is bound', async () => {
    bed({pedals: {enabled: true, profile: 'custom', pedals: [LEFT, RIGHT], custom: {right: {tap: 'transport.playStop'}}}});
    down('PageDown');
    expect(ids()).toEqual(['transport.playStop']);
    await vi.advanceTimersByTimeAsync(700);
    up('PageDown');
    expect(ids()).toEqual(['transport.playStop']);
  });

  test('a pedal that cannot hold gets double-tap (≤ 350 ms) for its hold action; a single tap waits out the window', async () => {
    bed({pedals: {enabled: true, pedals: [{...LEFT, canHold: false}, RIGHT]}});
    await press('KeyB', 40);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    await press('KeyB', 40);
    expect(ids()).toEqual(['nav.prevSection']);
    await press('KeyB', 40);
    await vi.advanceTimersByTimeAsync(DOUBLE_MS);
    expect(ids()).toEqual(['nav.prevSection', 'transport.again']);
    // Holding it does nothing more: there is no hold timer on such a pedal.
    down('KeyB');
    await vi.advanceTimersByTimeAsync(HOLD_MS * 2);
    up('KeyB');
    await vi.advanceTimersByTimeAsync(DOUBLE_MS);
    expect(ids()).toEqual(['nav.prevSection', 'transport.again', 'transport.again']);
  });

  test('in a setlist (?set=) the Practice profile’s right hold goes to the next song', async () => {
    bed({pedals: {enabled: true, pedals: [LEFT, RIGHT]}, setlist: {id: 's1', name: 'Thursday', index: 0, count: 5}});
    down('PageDown');
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    up('PageDown');
    expect(ids()).toEqual(['setlist.next']);
  });

  test('Navigate and Page turn profiles; Custom keeps only commands marked pedal', async () => {
    const {prefsSig} = bed({pedals: {enabled: true, profile: 'navigate', pedals: [LEFT, RIGHT, {slot: 'p3', code: 'KeyT', canHold: true}]}});
    await press('KeyB');
    await press('KeyT');
    expect(ids()).toEqual(['nav.prevSection', 'transport.loopToggle']);
    runs.length = 0;
    prefsSig.value = {...prefsSig.peek(), pedals: {...prefsSig.peek().pedals, profile: 'custom', custom: {left: {tap: 'app.notPedal'}, p3: {tap: 'trainer.toggle'}}}};
    await press('KeyB');                                   // left's only binding is not a pedal command: B is a key again
    await press('KeyT');
    expect(runs).toEqual([{id: 'spot.save', source: 'key'}, {id: 'trainer.toggle', source: PEDAL_SOURCE}]);
  });

  test('a learned key stays a key with a modifier, in a text field and where none of its commands can run', async () => {
    let stage = true;
    bed({pedals: {enabled: true, pedals: [LEFT, RIGHT]}, enabled: id => stage || id === 'spot.save'});
    const input = document.body.appendChild(document.createElement('input'));
    input.focus();
    expect(down('KeyB').defaultPrevented).toBe(false);
    up('KeyB');
    input.blur();
    down('KeyB', {ctrlKey: true});
    up('KeyB', {ctrlKey: true});
    expect(runs).toEqual([]);
    stage = false;                                         // e.g. the Library: no pedal command can run
    const e = down('PageDown');
    up('PageDown');
    expect(e.defaultPrevented).toBe(false);
    expect(runs).toEqual([]);
  });

  test('changing the pedals swaps the handler; a press in progress still ends cleanly; stop() removes it', async () => {
    const {prefsSig} = bed({pedals: {enabled: true, pedals: [LEFT, RIGHT]}});
    down('KeyB');
    prefsSig.value = {...prefsSig.peek(), pedals: {...prefsSig.peek().pedals, profile: 'navigate'}};
    await vi.advanceTimersByTimeAsync(HOLD_MS * 2);
    expect(up('KeyB').defaultPrevented).toBe(true);        // the keyup goes to the handler that took the keydown
    expect(runs).toEqual([]);                              // the old press was reset, not finished as a hold
    await press('KeyB');
    expect(ids()).toEqual(['nav.prevSection']);
    prefsSig.value = {...prefsSig.peek(), pedals: {...prefsSig.peek().pedals, enabled: false}};
    await press('KeyB');
    expect(runs.at(-1)).toEqual({id: 'spot.save', source: 'key'});
    prefsSig.value = {...prefsSig.peek(), pedals: {...prefsSig.peek().pedals, enabled: true}};
    current.pop()();                                       // stop()
    await press('KeyB');
    expect(runs.at(-1)).toEqual({id: 'spot.save', source: 'key'});
  });
});

describe('learn my pedal', () => {
  test('asks for each pedal, then a hold; records the code and whether it can hold; Done after two', async () => {
    const {prefsSig} = bed({pedals: {enabled: true, pedals: [LEFT, RIGHT]}});
    const prompts = [];
    const done = new AbortController();
    const result = learn({onPrompt: (text, d) => prompts.push([text, d.step, d.slot, d.learned.length]), done: done.signal});
    expect(prompts.at(-1)).toEqual([LEARN_PROMPTS.left, 'press', 'left', 0]);
    // Esc, Tab and bare modifiers are not learned (Esc stays the dialog's).
    for (const code of ['Escape', 'Tab', 'ShiftLeft']) await press(code, 20);
    down('KeyB', {ctrlKey: true});
    up('KeyB', {ctrlKey: true});
    expect(prompts).toHaveLength(1);
    await press('KeyT', 60);
    expect(prompts.at(-1)).toEqual([LEARN_PROMPTS.hold, 'hold', 'left', 0]);
    await press('KeyB', 900);                              // another key during the hold step is ignored
    expect(prompts).toHaveLength(2);
    await press('KeyT', 700);                              // held ≥ 600 ms: hold capable
    expect(prompts.at(-1)).toEqual([LEARN_PROMPTS.right, 'press', 'right', 1]);
    await press('KeyT', 20);                               // the left pedal again is not the right pedal
    expect(prompts).toHaveLength(3);
    await press('PageDown', 30);
    await press('PageDown', 30);                           // keydown and keyup together: cannot hold
    expect(prompts.at(-1)).toEqual([LEARN_PROMPTS.p3, 'press', 'p3', 2]);
    expect(runs).toEqual([]);                              // nothing ran while learning
    done.abort();
    await expect(result).resolves.toEqual({pedals: [{slot: 'left', code: 'KeyT', canHold: true}, {slot: 'right', code: 'PageDown', canHold: false}]});
    // learn() does not save; the runtime handler is back.
    expect(prefsSig.peek().pedals.pedals).toEqual([LEFT, RIGHT]);
    await press('KeyB');
    expect(runs).toEqual([{id: 'transport.again', source: PEDAL_SOURCE}]);
  });

  test('auto-repeat during the press or the hold counts as hold capable; four pedals finish by themselves', async () => {
    bed();
    const result = learn({});
    const codes = ['KeyA', 'KeyS', 'KeyD', 'KeyF'];
    for (const [i, code] of codes.entries()) {
      down(code);
      if (i === 0) down(code, {repeat: true});
      up(code);
      down(code);
      if (i === 1) down(code, {repeat: true});
      await vi.advanceTimersByTimeAsync(i === 2 ? HOLD_MS : 10);
      up(code);
    }
    await expect(result).resolves.toEqual({pedals: [
      {slot: 'left', code: 'KeyA', canHold: true}, {slot: 'right', code: 'KeyS', canHold: true},
      {slot: 'p3', code: 'KeyD', canHold: true}, {slot: 'p4', code: 'KeyF', canHold: false},
    ]});
  });

  test('Done before two pedals is ignored; the signal cancels with an AbortError and frees the keys', async () => {
    bed();
    const done = new AbortController(), cancel = new AbortController();
    const result = learn({signal: cancel.signal, done: done.signal});
    await press('KeyA', 10);
    await press('KeyA', 10);
    done.abort();
    cancel.abort();
    await expect(result).rejects.toMatchObject({name: 'AbortError'});
    await press('KeyB');
    expect(runs).toEqual([{id: 'spot.save', source: 'key'}]);
    await expect(learn({signal: cancel.signal})).rejects.toMatchObject({name: 'AbortError'});
  });

  test('a second learn() cancels the first', async () => {
    bed();
    const first = learn({});
    const second = learn({});
    await expect(first).rejects.toMatchObject({name: 'AbortError'});
    await press('KeyA', 10);
    await press('KeyA', 10);
    await press('KeyS', 10);
    await press('KeyS', 10);
    await press('KeyD', 10);
    await press('KeyD', 10);
    await press('KeyF', 10);
    await press('KeyF', 10);
    await expect(second).resolves.toMatchObject({pedals: [{code: 'KeyA'}, {code: 'KeyS'}, {code: 'KeyD'}, {code: 'KeyF'}]});
  });
});

describe('MIDI parsing and bindings', () => {
  test('parseMidi: note-on with velocity, any control change; note-off and short messages are not triggers', () => {
    expect(parseMidi([0x99, 49, 110])).toEqual({type: 'note', number: 49, value: 110, channel: 9});
    expect(parseMidi([0x90, 49, 0])).toBeNull();
    expect(parseMidi([0x80, 49, 0])).toBeNull();
    expect(parseMidi([0xB0, 64, 127])).toEqual({type: 'cc', number: 64, value: 127, channel: 0});
    expect(parseMidi([0xF8])).toBeNull();
    expect(parseMidi(new Uint8Array([0x90, 200, 1]))).toBeNull();
    expect(triggerLabel({type: 'cc', number: 64})).toBe('CC 64');
    expect(triggerLabel({type: 'note', number: 36})).toBe('Note 36');
  });

  test('midiConfig keeps well-formed bindings once; bindingFor prefers the named device', () => {
    const cfg = midiConfig({enabled: true, bindings: [
      {device: 'Pad', type: 'note', number: 49, command: 'transport.again'},
      {device: 'Pad', type: 'note', number: 49, command: 'mix.minusMe'},
      {type: 'note', number: 49, command: 'transport.playStop'},
      {type: 'aftertouch', number: 1, command: 'x'}, {type: 'cc', number: 300, command: 'x'}, {type: 'cc', number: 4},
    ]});
    expect(cfg.bindings).toEqual([
      {device: 'Pad', type: 'note', number: 49, command: 'transport.again'},
      {device: null, type: 'note', number: 49, command: 'transport.playStop'},
    ]);
    expect(cfg.on).toBe(true);
    expect(bindingFor(cfg.bindings, {device: 'Pad', type: 'note', number: 49}).command).toBe('transport.again');
    expect(bindingFor(cfg.bindings, {device: 'Other', type: 'note', number: 49}).command).toBe('transport.playStop');
    expect(bindingFor(cfg.bindings, {device: 'Pad', type: 'cc', number: 49})).toBeNull();
    expect(midiConfig({enabled: true, bindings: []}).on).toBe(false);
  });
});

describe('MIDI pedals on the virtual input', () => {
  const flush = () => vi.advanceTimersByTimeAsync(0);

  test('asks for access only once MIDI pedals are on; a pad runs its pedal command with source midi', async () => {
    const fx = installMidi(window);
    const {reg, prefsSig} = bed({start: false});
    const fired = [];
    current.push(startMidi({registry: reg, prefs: {value: prefsSig}, navigator: window.navigator, onFire: id => fired.push(id)}));
    await flush();
    expect(fx.state().requests).toBe(0);
    prefsSig.value = {...prefsSig.peek(), midi: {enabled: true, bindings: [
      {device: 'Fixture Pad', type: 'note', number: 49, command: 'transport.again'},
      {type: 'cc', number: 64, command: 'transport.playStop'},
      {type: 'note', number: 38, command: 'app.notPedal'},
      {device: 'Another Pad', type: 'note', number: 40, command: 'mix.minusMe'},
    ]}};
    await flush();
    expect(fx.state()).toMatchObject({requests: 1, sysexRequested: false});
    expect(midiState.peek()).toMatchObject({access: 'granted', inputs: [{id: 'fx-midi-1', name: 'Fixture Pad'}]});
    fx.note(49, 100);
    fx.note(49, 0);                                        // a note-off as velocity 0
    fx.noteOff(49);
    fx.note(38, 90);                                       // bound, but not a pedal command
    fx.note(40, 90);                                       // bound to another device
    expect(runs).toEqual([{id: 'transport.again', source: MIDI_SOURCE}]);
    fx.cc(64, 127);
    fx.cc(64, 127);                                        // still held: once
    fx.cc(64, 0);
    fx.cc(64, CC_THRESHOLD);
    await vi.advanceTimersByTimeAsync(TRIGGER_GAP_MS);
    fx.cc(64, 127);                                        // a switch that only sends 127, after a pause
    fx.cc(64, 20);
    expect(ids()).toEqual(['transport.again', 'transport.playStop', 'transport.playStop', 'transport.playStop']);
    expect(fired).toEqual(ids());
    prefsSig.value = {...prefsSig.peek(), midi: {...prefsSig.peek().midi, enabled: false}};
    fx.note(49, 100);
    expect(runs).toHaveLength(4);
  });

  test('inputs that disconnect and come back are followed', async () => {
    const fx = installMidi(window);
    const {reg, prefsSig} = bed({start: false, midi: {enabled: true, bindings: [{type: 'note', number: 36, command: 'transport.playStop'}]}});
    current.push(startMidi({registry: reg, prefs: {value: prefsSig}, navigator: window.navigator}));
    await flush();
    fx.disconnect();
    expect(midiState.peek().inputs).toEqual([]);
    fx.connect();
    expect(midiState.peek().inputs).toHaveLength(1);
    fx.note(36);
    expect(runs).toEqual([{id: 'transport.playStop', source: MIDI_SOURCE}]);
  });

  test('learnMidi resolves the first trigger and silences bindings while it listens; it can be cancelled', async () => {
    const fx = installMidi(window);
    const {reg, prefsSig} = bed({start: false, midi: {enabled: true, bindings: [{type: 'note', number: 36, command: 'transport.playStop'}]}});
    current.push(startMidi({registry: reg, prefs: {value: prefsSig}, navigator: window.navigator}));
    await flush();
    const heard = learnMidi({navigator: window.navigator});
    await flush();
    fx.cc(7, 10);                                          // below the threshold: not a trigger
    fx.note(36, 100);
    await expect(heard).resolves.toEqual({device: 'Fixture Pad', type: 'note', number: 36});
    expect(runs).toEqual([]);
    fx.note(36, 100);
    expect(runs).toEqual([{id: 'transport.playStop', source: MIDI_SOURCE}]);
    const stop = new AbortController();
    const cancelled = learnMidi({signal: stop.signal, navigator: window.navigator});
    stop.abort();
    await expect(cancelled).rejects.toMatchObject({name: 'AbortError'});
    fx.cc(64, 127);
    const again = learnMidi({navigator: window.navigator});
    await flush();
    fx.cc(64, 127);
    await expect(again).resolves.toEqual({device: 'Fixture Pad', type: 'cc', number: 64});
  });

  test('no Web MIDI, or access refused: learnMidi says which; midiState shows it', async () => {
    await expect(learnMidi({navigator: {}})).rejects.toMatchObject({code: 'unsupported'});
    expect(midiState.peek()).toMatchObject({supported: false, access: 'unsupported'});
    resetMidiForTests();
    const fx = installMidi(window);
    fx.deny();
    await expect(learnMidi({navigator: window.navigator})).rejects.toMatchObject({code: 'denied'});
    expect(midiState.peek().access).toBe('denied');
  });
});
