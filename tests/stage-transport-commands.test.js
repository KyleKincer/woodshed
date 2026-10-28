// @vitest-environment happy-dom
// Transport, loop, speed, click, mix and navigation commands (architecture §3.1, D45, D46) on a
// real session (tests/helpers/test-session.js: real SongMapStore, Metronome, MultitrackEngine
// over tests/helpers/fake-audio.js, transport, practice state and undo). Each case runs the
// command through a registry, as a key, pedal, palette row or button would; the keyboard cases
// go through the real dispatcher.
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {createRegistry, registry as appRegistry} from '../src/app/commands.js';
import {canonical} from '../src/app/keys.js';
import {setSurfaceScope, startDispatcher} from '../src/app/dispatch.js';
import {clock as appClock} from '../src/app/clock.js';
import {defineGlobalCommands} from '../src/app/global-commands.js';
import {PROFILES} from '../src/app/pedals.js';
import {PARSED_ONLY} from '../src/app/palette.js';
import {COPY, defineTransportCommands, isMapped, snapshotOf, stemLabel, transportOf} from '../src/stage/transport-commands.js';
import {checkSourceText} from '../scripts/check-source.mjs';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {createFakeSession} from './helpers/fake-session.js';
import {ALLOWED_SHADOWS, REACHABLE_CHAINS, isAllowedShadow} from './registry-shadows.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = 'stage', E = 'edit', EM = 'edit.map', EC = 'edit.chart', SF = ['stage.strip', 'stage.bars'];
const ERASE = ['Backspace', 'Delete'];

/** §3.1, row by row: [id, group, keys, scopes, flags]. */
const TABLE = [
  ['transport.playStop', 'Transport', ['Space'], [S, E], {pedal: true, global: true}],
  ['transport.pause', 'Transport', ['Shift+Space'], [S, E], {pedal: true}],
  ['transport.again', 'Transport', ['Enter'], [S, EC], {pedal: true, global: true}],
  ['transport.stop', 'Transport', [], [], {pedal: true, global: true}],
  ['transport.loopToggle', 'Loop', ['KeyL'], [S], {pedal: true, global: true}],
  ['transport.loopSection', 'Loop', ['Shift+KeyL'], [S], {pedal: true}],
  ['focus.play', 'Transport', ['Enter'], SF, {}],
  ['focus.loop', 'Loop', ['KeyL'], SF, {}],
  ['loop.in', 'Loop', ['KeyI'], [S, EM], {}],
  ['loop.inExact', 'Loop', ['Shift+KeyI'], [S, EM], {}],
  ['loop.out', 'Loop', ['KeyO'], [S, EM], {}],
  ['loop.outExact', 'Loop', ['Shift+KeyO'], [S, EM], {}],
  ['loop.clear', 'Loop', ERASE, [S], {}],
  ['loop.moveBack', 'Loop', ['Shift+['], [S], {}],
  ['loop.moveFwd', 'Loop', ['Shift+]'], [S], {}],
  ['loop.card', 'Loop', [], [S, E], {}],
  ['loop.eachPass', 'Loop', [], [S, E], {}],
  ['loop.playTimes', 'Loop', [], [S], {}],
  ['loop.between', 'Loop', [], [S], {}],
  ['nav.prevSection', 'Navigate', ['[', 'PageUp'], [S, EM], {pedal: true}],
  ['nav.nextSection', 'Navigate', [']', 'PageDown'], [S, EM], {pedal: true, global: true}],
  ['nav.barBack', 'Navigate', ['ArrowLeft'], [S], {pedal: true, repeat: true}],
  ['nav.barFwd', 'Navigate', ['ArrowRight'], [S], {pedal: true, repeat: true}],
  ['nav.beatBack', 'Navigate', ['Shift+ArrowLeft'], [S], {repeat: true}],
  ['nav.beatFwd', 'Navigate', ['Shift+ArrowRight'], [S], {repeat: true}],
  ['cue.nudgeBack', 'Navigate', ['Alt+ArrowLeft'], [S], {repeat: true}],
  ['cue.nudgeFwd', 'Navigate', ['Alt+ArrowRight'], [S], {repeat: true}],
  ['cue.nudgeBackFine', 'Navigate', ['Alt+Shift+ArrowLeft'], [S], {repeat: true}],
  ['cue.nudgeFwdFine', 'Navigate', ['Alt+Shift+ArrowRight'], [S], {repeat: true}],
  ['nav.home', 'Navigate', ['Home'], [S], {}],
  ['nav.end', 'Navigate', ['End'], [S], {}],
  ['nav.goTo', 'Navigate', [], [S, E], {}],
  ['speed.down', 'Speed', [','], [S, EC], {pedal: true, repeat: true}],
  ['speed.up', 'Speed', ['.'], [S, EC], {pedal: true, repeat: true}],
  ['speed.downFine', 'Speed', ['Shift+,'], [S, EC], {repeat: true}],
  ['speed.upFine', 'Speed', ['Shift+.'], [S, EC], {repeat: true}],
  ['speed.toggle100', 'Speed', ['`'], [S, EC], {pedal: true}],
  ['speed.set', 'Speed', [], [S, E], {}],
  ['speed.sheet', 'Speed', [], [S, E], {}],
  ['trainer.toggle', 'Speed', [], [S], {pedal: true}],
  ['click.countIn', 'Click', ['KeyC'], [S, E], {pedal: true}],
  ['click.toggle', 'Click', ['KeyK'], [S, E], {pedal: true}],
  ['click.mode', 'Click', [], [S, E], {}],
  ['click.sheet', 'Click', [], [S, E], {}],
  ['mix.minusMe', 'Mix', ['KeyM'], [S, EM], {pedal: true}],
  ['mix.onlyMe', 'Mix', ['Shift+KeyM'], [S, EM], {pedal: true}],
  ['mix.full', 'Mix', ['Digit0'], [S], {pedal: true}],
  ['mix.sheet', 'Mix', [], [S, E], {}],
  ['mix.chartAudio', 'Mix', [], [S, E], {}],
];
const NINE = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const DYNAMIC = [
  ...NINE.map((n) => [`mix.mute.${n}`, 'Mix', [`Digit${n}`], [S], {}]),
  ...NINE.map((n) => [`mix.solo.${n}`, 'Mix', [`Shift+Digit${n}`], [S], {}]),
];
const WITH_ARGS = ['loop.playTimes', 'loop.between', 'click.mode', 'mix.chartAudio'];

let clock, restoreAudio, current = [];

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(Date.parse('2026-10-28T12:00:00Z'));
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
});

afterEach(async () => {
  for (const off of current.splice(0)) await off();
  setSurfaceScope(null);
  document.body.replaceChildren();
  delete document.documentElement.dataset.place;
  delete document.documentElement.dataset.posture;
  restoreAudio();
  vi.useRealTimers();
});

/** A registry with the transport commands, providers for a real session and a recording Stage sheet host. */
async function bed({stage = true, sheets = {}, ...options} = {}) {
  const ts = await createTestSession({clock, ...options});
  const reg = createRegistry();
  const off = defineTransportCommands({registry: reg, sheets});
  const opened = [];
  const anchors = new Map([['mix', document.createElement('button')]]);
  reg.provide('session', () => ts.session);
  reg.provide('transport', () => ts.session.transport);
  if (stage) reg.provide('stage', () => ({openSheet: (name, opts) => { opened.push({name, ...opts}); return {close() {}}; }, anchors}));
  current.push(async () => { off(); await ts.dispose(); });
  const b = {
    ts, reg, opened, anchors,
    run: (id, args) => reg.run(id, {source: 'key', args}),
    state: (id, args) => reg.state(id, reg.context(args ? {args} : {})),
    get snap() { return ts.snapshot; },
  };
  return b;
}

describe('definitions (§3.1)', () => {
  test('every §3.1 row is registered with its group, keys, scopes, pedal, global and repeat flags; nothing else is', () => {
    const reg = createRegistry();
    defineTransportCommands({registry: reg});
    for (const [id, group, keys, scopes, flags] of [...TABLE, ...DYNAMIC]) {
      const def = reg.get(id);
      expect(def, id).toBeTruthy();
      expect(def.group, id).toBe(group);
      expect(def.keys, id).toEqual(keys.map((k) => canonical(k)));
      expect(def.scopes, id).toEqual(scopes);
      expect({pedal: def.pedal, global: def.global, repeat: def.repeat}, id)
        .toEqual({pedal: !!flags.pedal, global: !!flags.global, repeat: !!flags.repeat});
      expect(reg.titleFor(id), id).toBeTruthy();
    }
    expect(reg.all().map((d) => d.id).sort()).toEqual([...TABLE, ...DYNAMIC].map((r) => r[0]).sort());
    expect(reg.dynamicFamilies()).toEqual([
      {template: 'mix.mute.{n}', ids: NINE.map((n) => `mix.mute.${n}`)},
      {template: 'mix.solo.{n}', ids: NINE.map((n) => `mix.solo.${n}`)},
    ]);
  });

  test('only Play/Stop, Again, Loop, Stop and Next section run from background shortcuts (§3.5)', () => {
    const reg = createRegistry();
    defineTransportCommands({registry: reg});
    expect(reg.all().filter((d) => d.global).map((d) => d.id).sort())
      .toEqual(['nav.nextSection', 'transport.again', 'transport.loopToggle', 'transport.playStop', 'transport.stop']);
  });

  test('the Transport menu items (§3.1 "Transport menu") and the palette: argument commands are hidden, parsed rows reach the rest', () => {
    const reg = createRegistry();
    defineTransportCommands({registry: reg});
    expect(reg.all().filter((d) => d.menu?.electron === 'Transport').map((d) => d.id).sort())
      .toEqual(['click.countIn', 'click.toggle', 'mix.minusMe', 'transport.again', 'transport.loopToggle', 'transport.playStop']);
    for (const id of WITH_ARGS) expect(reg.get(id).palette?.hidden, id).toBe(true);
    for (const id of ['nav.goTo', 'speed.set']) {
      expect(reg.get(id).palette?.hidden, id).not.toBe(true);
      expect(PARSED_ONLY).toContain(id);
    }
    expect(reg.get('trainer.toggle').palette?.hidden).not.toBe(true);   // a toggle without arguments; the palette's `trainer 70 100` passes them
  });

  test('every pedal profile command of this module is pedal-eligible', () => {
    const reg = createRegistry();
    defineTransportCommands({registry: reg});
    const ids = Object.values(PROFILES).flatMap((p) => Object.values(p).flatMap((slot) => Object.values(slot)));
    for (const id of ids.filter((x) => reg.get(x))) expect(reg.get(id).pedal, id).toBe(true);
  });

  test('every icon exists in the sprite', () => {
    const sprite = readFileSync(join(ROOT, 'src/styles/icons.svg'), 'utf8');
    const reg = createRegistry();
    defineTransportCommands({registry: reg});
    for (const def of reg.all()) if (def.icon) expect(sprite.includes(`id="i-${def.icon}"`), `${def.id}: ${def.icon}`).toBe(true);
  });

  test('importing the module registers the commands on the app registry; off() removes them again', () => {
    expect(appRegistry.get('transport.playStop')).toBeTruthy();
    expect(appRegistry.get('mix.solo.9')).toBeTruthy();
    const reg = createRegistry();
    const off = defineTransportCommands({registry: reg});
    off();
    expect(reg.all()).toEqual([]);
    expect(reg.dynamicFamilies()).toEqual([]);
  });

  test('the module imports only the registry and pure helpers (D46 guard)', () => {
    const file = 'src/stage/transport-commands.js';
    const problems = checkSourceText(file, readFileSync(join(ROOT, file), 'utf8'), {exists: (p) => existsSync(join(ROOT, p))});
    expect(problems).toEqual([]);
  });

  test('with the global commands, no key is bound twice in a scope and every shadow is listed (registry CI rules)', () => {
    const reg = createRegistry();
    defineTransportCommands({registry: reg});
    defineGlobalCommands({registry: reg, store: {stage: {peek: () => null}, session: {peek: () => null}, update: {peek: () => null}},
      platform: {}, desktop: {available: false}, openPalette: () => {}, openShortcuts: () => {}, signOut: () => {}, later: {}, win: null});
    for (const scope of reg.boundScopes()) {
      for (const [key] of reg.bindingsFor(scope)) expect(reg.defsFor(scope, key).length, `${scope} ${key}`).toBe(1);
    }
    const problems = [];
    for (const chain of REACHABLE_CHAINS) {
      const keys = new Set(chain.flatMap((scope) => [...reg.bindingsFor(scope).keys()]));
      for (const key of keys) {
        const layers = [];
        for (const scope of chain) {
          const def = reg.bindingsFor(scope).get(key);
          if (def && !layers.some((l) => l.def === def)) layers.push({scope, def});
        }
        for (let i = 0; i + 1 < layers.length; i++) {
          if (!isAllowedShadow({inner: layers[i].scope, outer: layers[i + 1].scope, key, innerDef: layers[i].def}, ALLOWED_SHADOWS)) {
            problems.push(`${key}: ${layers[i].def.id} (${layers[i].scope}) over ${layers[i + 1].def.id} (${layers[i + 1].scope})`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('context readers', () => {
  test('the transport comes from the context, else from the session; no context means no transport', () => {
    const t = {snapshot: {peek: () => ({phase: 'playing'})}};
    expect(transportOf({transport: t})).toBe(t);
    expect(transportOf({session: {transport: t}})).toBe(t);
    expect(transportOf({})).toBeNull();
    expect(snapshotOf({transport: t}).phase).toBe('playing');
    expect(isMapped({})).toBe(true);
    expect(isMapped({session: {map: {isReal: false}}})).toBe(false);
    expect(stemLabel('drums')).toBe('Drums');
    expect(stemLabel('no_vocals')).toBe('No vocals');
  });

  test('without a transport every command is unavailable (hidden from the palette, keys stay native)', () => {
    const reg = createRegistry();
    defineTransportCommands({registry: reg});
    for (const def of reg.all()) expect(reg.state(def.id).visible, def.id).toBe(false);
    expect(reg.run('transport.playStop')).toBe(false);
  });

  test('a fake session (pure view tests) evaluates every command without throwing', () => {
    const reg = createRegistry();
    defineTransportCommands({registry: reg});
    const fake = createFakeSession();
    reg.provide('session', () => fake);
    expect(reg.state('transport.playStop').title).toBe('Play');
    fake.transport.set({phase: 'playing'});
    expect(reg.state('transport.playStop').title).toBe('Stop');
    expect(reg.run('transport.loopToggle')).toBe(true);
    expect(fake.transport.calls).toEqual([['toggleLoop']]);
    for (const def of reg.all()) expect(() => reg.state(def.id), def.id).not.toThrow();
  });
});

describe('play, stop, pause, again', () => {
  test('Play / Stop plays from the cue and stops; its title follows the phase', async () => {
    const b = await bed();
    expect(b.state('transport.playStop').title).toBe('Play');
    b.ts.transport.cue(10);
    expect(b.run('transport.playStop')).toBe(true);
    await settle();
    expect(b.snap.phase).toBe('playing');
    expect(b.state('transport.playStop').title).toBe('Stop');
    await b.ts.advance(1);
    expect(b.run('transport.playStop')).toBe(true);
    expect(b.snap.phase).toBe('stopped');
    expect(b.ts.transport.position()).toBe(10);
  });

  test('with count-in on, the title reads "Cancel count-in" while counting, and Play/Stop cancels the count', async () => {
    const b = await bed({practice: {v: 2, click: {countIn: {on: true, length: 1, unit: 'bars'}, mode: 'countin', accent: true, volume: 0.7, preRoll: false}}});
    b.run('transport.playStop');
    await settle();
    expect(b.snap.phase).toBe('counting');
    expect(b.state('transport.playStop').title).toBe(COPY.cancelCount);
    b.run('transport.playStop');
    expect(b.snap.phase).toBe('stopped');
  });

  test('Pause pauses in place and continues; Stop stops from any phase', async () => {
    const b = await bed();
    await b.ts.play();
    await b.ts.advance(2);
    b.run('transport.pause');
    expect(b.snap.phase).toBe('paused');
    expect(b.state('transport.pause').title).toBe(COPY.continue);
    b.run('transport.pause');
    await settle();
    expect(b.snap.phase).toBe('playing');
    b.run('transport.stop');
    expect(b.snap.phase).toBe('stopped');
  });

  test('Again starts at the current section from any phase and never moves the cue', async () => {
    const b = await bed();
    b.ts.transport.cue(3);
    await b.ts.play();
    await b.ts.advance(20);                     // in the Verse (bars 9–16, 16 s – 32 s) … position ≈ 23
    expect(b.run('transport.again')).toBe(true);
    await b.ts.advance(0.25);
    expect(b.ts.transport.position()).toBeGreaterThan(16);
    expect(b.ts.transport.position()).toBeLessThan(16.5);
    expect(b.snap.cue).toBe(3);
  });
});

describe('loop', () => {
  test('L toggles the smart loop (the current section) and reads checked; ⇧L loops the section', async () => {
    const b = await bed();
    b.ts.transport.cue(40);                     // Chorus: 32 s – 48 s
    expect(b.state('transport.loopToggle').checked).toBe(false);
    b.run('transport.loopToggle');
    expect(b.snap.loop).toMatchObject({on: true, a: 32, b: 48});
    expect(b.state('transport.loopToggle').checked).toBe(true);
    b.run('transport.loopToggle');
    expect(b.snap.loop.on).toBe(false);
    b.ts.transport.clearLoop();
    b.ts.transport.cue(100);
    b.run('transport.loopSection');
    expect(b.snap.loop).toMatchObject({on: true, a: 96, b: 112});   // Chorus 3
  });

  test('I / O set bar-snapped edges, ⇧I / ⇧O exact ones', async () => {
    const b = await bed();
    b.ts.transport.cue(20.7);
    b.run('loop.in');
    expect(b.snap.loop).toMatchObject({on: true, a: 20, b: 22});
    b.ts.transport.cue(27.3);
    b.run('loop.out');
    expect(b.snap.loop).toMatchObject({a: 20, b: 28});
    b.ts.transport.cue(21.3);
    b.run('loop.inExact');
    expect(b.snap.loop.a).toBeCloseTo(21.3, 6);
    b.ts.transport.cue(25.1);
    b.run('loop.outExact');
    expect(b.snap.loop.b).toBeCloseTo(25.1, 6);
  });

  test('⌫ clears the loop only when there is one; ⇧[ ⇧] move it by its length only when it has a range', async () => {
    const b = await bed();
    expect(b.state('loop.clear').visible).toBe(false);
    expect(b.state('loop.moveFwd').visible).toBe(false);
    b.ts.transport.loopRange(32, 48);
    expect(b.state('loop.clear').visible).toBe(true);
    b.run('loop.moveFwd');
    expect(b.snap.loop).toMatchObject({a: 48, b: 64});
    b.run('loop.moveBack');
    b.run('loop.moveBack');
    expect(b.snap.loop).toMatchObject({a: 16, b: 32});
    b.run('loop.clear');
    expect(b.snap.loop.on).toBe(false);
    expect(b.state('loop.clear').visible).toBe(false);
  });

  test('loop options: count in every pass toggles, Play N times takes {n}, Between passes takes {mode}', async () => {
    const b = await bed();
    b.ts.transport.loopRange(0, 16);
    const each = b.snap.loop.eachPassCount;
    b.run('loop.eachPass');
    expect(b.snap.loop.eachPassCount).toBe(!each);
    expect(b.state('loop.eachPass').checked).toBe(!each);
    b.run('loop.eachPass', {on: true});
    expect(b.snap.loop.eachPassCount).toBe(true);
    b.run('loop.playTimes', {n: 4});
    expect(b.snap.loop.playTimes).toBe(4);
    expect(b.state('loop.playTimes', {n: 4}).checked).toBe(true);
    expect(b.state('loop.playTimes', {n: 2}).checked).toBe(false);
    b.run('loop.playTimes', {n: 3});           // not an option: nothing changes
    expect(b.snap.loop.playTimes).toBe(4);
    b.run('loop.between', {mode: 'rest'});
    expect(b.snap.loop.between).toBe('rest');
    expect(b.state('loop.between', {mode: 'call'}).enabled).toBe(true);   // drums: the profile has a stem
    b.run('loop.between', {mode: 'call'});
    expect(b.snap.loop.between).toBe('call');
  });

  test('Call & response is disabled, with the reason, when no stem is yours (D17)', async () => {
    const b = await bed({stems: ['vocals', 'no_vocals'], account: {profile: {instruments: ['drums'], primary: 'drums'}}});
    b.ts.transport.loopRange(0, 16);
    expect(b.state('loop.between', {mode: 'call'})).toMatchObject({enabled: false, reason: COPY.callNeedsPart});
    expect(b.state('loop.between', {mode: 'rest'}).enabled).toBe(true);
    expect(b.run('loop.between', {mode: 'call'})).toBe(false);
    expect(b.snap.loop.between).toBe('none');
  });

  test('the Loop card opens through the Stage with the anchor; Edit (no Stage) opens it through the sheets host', async () => {
    const b = await bed();
    b.run('loop.card');
    b.run('mix.sheet');
    b.run('speed.sheet', {anchor: 'here'});
    b.run('click.sheet');
    expect(b.opened).toEqual([{name: 'loop', anchor: null}, {name: 'mix', anchor: b.anchors.get('mix')}, {name: 'speed', anchor: 'here'},
      {name: 'click', anchor: null}]);
    const hosted = [];
    const e = await bed({stage: false, sheets: {'./sheets/host.js': async () => ({openSheet: (name, opts) => hosted.push({name, ...opts})})}});
    e.run('speed.sheet');
    await settle();
    expect(hosted).toEqual([{name: 'speed', session: e.ts.session, anchor: null}]);
    const none = await bed({stage: false, sheets: {}});
    expect(none.state('speed.sheet').visible).toBe(false);
  });
});

describe('focus scopes (D45)', () => {
  test('focus.play plays from the focused item; focus.loop loops a section, a marker region or one bar', async () => {
    const b = await bed();
    let focused = {kind: 'section', t0: 64, t1: 80, label: 'Verse 2'};
    b.reg.provide('focused', () => focused);
    b.run('focus.loop');
    expect(b.snap.loop).toMatchObject({on: true, a: 64, b: 80});
    focused = {kind: 'bar', t0: 20, bar: 11};
    b.run('focus.loop');
    expect(b.snap.loop).toMatchObject({on: true, a: 20, b: 22});
    b.run('focus.play');
    await settle();
    expect(b.snap.phase).toBe('playing');
    expect(b.ts.transport.position()).toBeCloseTo(20, 1);
  });

  test('without a focused item the focus commands are unavailable', async () => {
    const b = await bed();
    expect(b.state('focus.play').visible).toBe(false);
    expect(b.state('focus.loop').visible).toBe(false);
  });
});

describe('navigation', () => {
  test('[ ] go to the previous and next section (a cue when stopped)', async () => {
    const b = await bed();
    b.ts.transport.cue(40);
    b.run('nav.nextSection');
    expect(b.snap.cue).toBe(48);
    b.run('nav.prevSection');
    expect(b.snap.cue).toBe(32);
    expect(b.state('nav.nextSection').title).toBe(COPY.nextSection);
  });

  test('unmapped: markers are the regions; with none the commands say how to add one', async () => {
    const b = await bed({mapped: false, duration: 60});
    expect(b.state('nav.nextSection')).toMatchObject({enabled: false, reason: COPY.noRegions, title: COPY.nextMarker});
    b.ts.practice.addMarker({t: 30, label: 'Solo'});
    expect(b.state('nav.nextSection').enabled).toBe(true);
    b.run('nav.nextSection');
    expect(b.snap.cue).toBe(30);
  });

  test('arrows step by bar and beat when mapped, 5 s and 1 s when not; ⌥ nudges the cue 50 ms, ⌥⇧ 10 ms', async () => {
    const b = await bed();
    b.ts.transport.cue(20);
    b.run('nav.barFwd');
    expect(b.snap.cue).toBe(22);
    b.run('nav.beatBack');
    expect(b.snap.cue).toBeCloseTo(21.5, 6);
    b.run('cue.nudgeFwd');
    expect(b.snap.cue).toBeCloseTo(21.55, 6);
    b.run('cue.nudgeBackFine');
    expect(b.snap.cue).toBeCloseTo(21.54, 6);
    const u = await bed({mapped: false, duration: 60});
    u.ts.transport.cue(20);
    expect(u.state('nav.barFwd').title).toBe(COPY.secondsFwd(5));
    u.run('nav.barFwd');
    expect(u.snap.cue).toBe(25);
    u.run('nav.beatBack');
    expect(u.snap.cue).toBe(24);
  });

  test('Home and End go to the loop edges when looping, else the song edges', async () => {
    const b = await bed();
    b.ts.transport.cue(50);
    b.run('nav.end');
    expect(b.snap.cue).toBe(128);
    expect(b.state('nav.home').title).toBe(COPY.home);
    b.run('nav.home');
    expect(b.snap.cue).toBe(0);
    b.ts.transport.loopRange(32, 48);
    expect(b.state('nav.home').title).toBe(COPY.homeLoop);
    b.ts.transport.cue(40);
    b.run('nav.end');
    expect(b.snap.cue).toBe(48);
  });

  test('nav.goTo {t} cues when stopped and makes a quantized jump while playing', async () => {
    const b = await bed();
    b.run('nav.goTo', {t: 57});
    expect(b.snap.cue).toBe(57);
    b.run('nav.goTo', {});                      // no time: nothing happens
    expect(b.snap.cue).toBe(57);
    b.ts.transport.cue(0);
    await b.ts.play();
    await b.ts.advance(1);
    b.run('nav.goTo', {t: 96, label: 'Chorus 3'});
    expect(b.snap.pendingJump).toMatchObject({t: 96, label: 'Chorus 3'});
    await b.ts.advance(2);
    expect(b.ts.transport.position()).toBeGreaterThan(96);
    expect(b.ts.transport.position()).toBeLessThan(97);
  });
});

describe('speed', () => {
  test(', . step 5%, ⇧ steps 1%; the limits disable the step with a reason', async () => {
    const b = await bed();
    b.run('speed.down');
    expect(b.snap.rate).toBe(0.95);
    b.run('speed.downFine');
    expect(b.snap.rate).toBe(0.94);
    b.run('speed.upFine');
    b.run('speed.up');
    expect(b.snap.rate).toBe(1);
    b.run('speed.set', {rate: 0.25});
    expect(b.state('speed.down')).toMatchObject({enabled: false, reason: COPY.slowest});
    expect(b.state('speed.downFine').enabled).toBe(false);
    b.run('speed.set', {rate: 1.5});
    expect(b.state('speed.up')).toMatchObject({enabled: false, reason: COPY.fastest});
    expect(b.run('speed.up')).toBe(false);
  });

  test('speed.set takes {rate}; outside 25–150% it is refused with the range', async () => {
    const b = await bed();
    expect(b.run('speed.set', {rate: 0.75})).toBe(true);
    expect(b.snap.rate).toBe(0.75);
    expect(b.state('speed.set', {rate: 2})).toMatchObject({enabled: false, reason: COPY.speedRange});
    expect(b.run('speed.set', {rate: 0.1})).toBe(false);
    expect(b.snap.rate).toBe(0.75);
  });

  test('` toggles 100% ↔ last; at 100% with no other speed it is disabled', async () => {
    const b = await bed();
    expect(b.state('speed.toggle100')).toMatchObject({enabled: false, reason: COPY.at100});
    b.run('speed.set', {rate: 0.8});
    expect(b.state('speed.toggle100').title).toBe(COPY.speed100);
    b.run('speed.toggle100');
    expect(b.snap.rate).toBe(1);
    expect(b.state('speed.toggle100').title).toBe(COPY.speedBack(80));
    b.run('speed.toggle100');
    expect(b.snap.rate).toBe(0.8);
  });

  test('trainer.toggle starts with the default or the given configuration and stops; title and checked follow', async () => {
    const b = await bed();
    b.ts.transport.loopRange(32, 48);
    expect(b.state('trainer.toggle')).toMatchObject({title: COPY.startTrainer, checked: false});
    b.run('trainer.toggle');
    expect(b.snap.trainer).toMatchObject({start: 0.7, end: 1, step: 0.05, passes: 2});
    expect(b.snap.rate).toBe(0.7);
    expect(b.state('trainer.toggle')).toMatchObject({title: COPY.stopTrainer, checked: true});
    b.run('trainer.toggle');
    expect(b.snap.trainer).toBeNull();
    b.run('trainer.toggle', {start: 0.6, end: 0.9, step: 0.1, passes: 1});
    expect(b.snap.trainer).toMatchObject({start: 0.6, end: 0.9, step: 0.1, passes: 1});
    b.run('trainer.toggle', {start: 0.5, end: 0.8});   // with a configuration it restarts, never stops
    expect(b.snap.trainer).toMatchObject({start: 0.5, end: 0.8});
    expect(b.snap.rate).toBe(0.5);
  });
});

describe('click and count-in (D14)', () => {
  test('C toggles the count-in; K toggles Always ↔ the last mode; click.mode sets one; checked follows', async () => {
    const b = await bed();
    expect(b.state('click.countIn')).toMatchObject({title: COPY.countIn, checked: false});
    b.run('click.countIn');
    expect(b.snap.countIn.on).toBe(true);
    expect(b.state('click.countIn').checked).toBe(true);
    b.run('click.toggle');
    expect(b.snap.click.mode).toBe('always');
    expect(b.state('click.toggle').checked).toBe(true);
    b.run('click.toggle');
    expect(b.snap.click.mode).toBe('countin');
    b.run('click.mode', {mode: 'off'});
    expect(b.snap.click.mode).toBe('off');
    expect(b.state('click.mode', {mode: 'off'}).checked).toBe(true);
    expect(b.state('click.mode', {mode: 'always'}).checked).toBe(false);
    b.run('click.mode', {mode: 'loud'});
    expect(b.snap.click.mode).toBe('off');
  });

  test('unmapped: Count-in is the 2 s lead-in; the Click says it needs a bar grid', async () => {
    const b = await bed({mapped: false, duration: 60});
    expect(b.state('click.countIn')).toMatchObject({title: COPY.leadIn, enabled: true});
    expect(b.state('click.toggle')).toMatchObject({enabled: false, reason: COPY.needsGrid});
    expect(b.state('click.mode', {mode: 'always'})).toMatchObject({enabled: false, reason: COPY.needsGrid});
    expect(b.run('click.toggle')).toBe(false);
    b.run('click.countIn');
    expect(b.snap.countIn.on).toBe(true);
  });
});

describe('mix (D37)', () => {
  test('M mutes your stems, ⇧M solos them, 0 restores the full mix; checked follows', async () => {
    const b = await bed();
    b.run('mix.minusMe');
    expect(b.snap.mix.tracks.find((t) => t.name === 'drums').muted).toBe(true);
    expect(b.state('mix.minusMe').checked).toBe(true);
    b.run('mix.onlyMe');
    expect(b.snap.mix.tracks.find((t) => t.name === 'drums')).toMatchObject({muted: false, soloed: true});
    expect(b.state('mix.onlyMe').checked).toBe(true);
    b.run('mix.full');
    expect(b.snap.mix.tracks.every((t) => !t.muted && !t.soloed && t.volume === 1)).toBe(true);
    expect(b.opened).toEqual([]);
  });

  test('Minus me with no stem of yours opens the Mix sheet', async () => {
    const b = await bed({stems: ['vocals', 'no_vocals']});
    b.run('mix.minusMe');
    expect(b.opened).toEqual([{name: 'mix', anchor: b.anchors.get('mix')}]);
    b.run('mix.onlyMe');
    expect(b.opened.map((o) => o.name)).toEqual(['mix', 'mix']);
    expect(b.snap.mix.tracks.every((t) => !t.muted && !t.soloed)).toBe(true);
  });

  test('turning Minus me off again does not open the Mix sheet', async () => {
    const b = await bed();
    b.run('mix.minusMe');
    b.run('mix.minusMe');
    expect(b.snap.mix.minusMe).toBe(false);
    expect(b.opened).toEqual([]);
  });

  test('1–9 mute and ⇧1–9 solo stems in canonical order; titles name the stem; beyond the stems they are unavailable', async () => {
    const b = await bed({stems: ['vocals', 'other', 'drums', 'bass']});
    expect(b.snap.mix.tracks.map((t) => t.name)).toEqual(['drums', 'bass', 'vocals', 'other']);
    expect(b.state('mix.mute.1').title).toBe('Mute Drums');
    expect(b.state('mix.solo.3').title).toBe('Solo Vocals');
    b.run('mix.mute.1');
    expect(b.snap.mix.tracks[0].muted).toBe(true);
    expect(b.state('mix.mute.1').checked).toBe(true);
    b.run('mix.mute.1');
    expect(b.snap.mix.tracks[0].muted).toBe(false);
    b.run('mix.solo.2');
    expect(b.snap.mix.tracks[1].soloed).toBe(true);
    expect(b.state('mix.solo.2').checked).toBe(true);
    expect(b.state('mix.mute.5').visible).toBe(false);
    expect(b.state('mix.mute.5').title).toBe(COPY.muteN(5));
  });

  test('Chart playback appears only when the song has a drum part, and sets the level', async () => {
    const b = await bed();
    expect(b.state('mix.chartAudio').visible).toBe(false);
    const levels = [];
    const t = b.ts.transport;
    const withPart = {...b.ts.session, notation: {part: {}}, transport: t};
    b.reg.provide('session', () => withPart);
    expect(b.state('mix.chartAudio', {level: 'quiet'})).toMatchObject({visible: true, checked: false});
    b.run('mix.chartAudio', {level: 'quiet'});
    levels.push(b.snap.mix.chartAudio);
    expect(b.state('mix.chartAudio', {level: 'quiet'}).checked).toBe(true);
    b.run('mix.chartAudio', {level: 'deafening'});
    levels.push(b.snap.mix.chartAudio);
    expect(levels).toEqual(['quiet', 'quiet']);
  });
});

describe('undo', () => {
  test('each command is one practice-undo step: Undo after M restores the mix, after L the loop', async () => {
    const b = await bed();
    b.run('mix.minusMe');
    b.ts.undo.undo();
    expect(b.snap.mix.tracks.find((t) => t.name === 'drums').muted).toBe(false);
    b.ts.transport.cue(40);
    b.run('transport.loopToggle');
    b.ts.undo.undo();
    expect(b.snap.loop.on).toBe(false);
    expect(b.snap.cue).toBe(40);
  });
});

describe('unmapped text never says "bar" (§2.14.4)', () => {
  test('every title on an unmapped song', async () => {
    const b = await bed({mapped: false, duration: 60});
    b.ts.practice.addMarker({t: 10, label: 'Intro riff'});
    for (const def of b.reg.all()) expect(b.reg.titleFor(def.id), def.id).not.toMatch(/\bbars?\b/i);
  });
});

describe('through the dispatcher', () => {
  function key(code, init = {}) {
    const keyFor = {Space: ' ', Enter: 'Enter', KeyL: 'l', KeyM: 'm', Digit1: '1', Comma: ',', BracketRight: ']'};
    const e = new KeyboardEvent('keydown', {bubbles: true, cancelable: true, code, key: init.key ?? keyFor[code] ?? code, ...init});
    (document.activeElement ?? document.body).dispatchEvent(e);
    document.body.dispatchEvent(new KeyboardEvent('keyup', {bubbles: true, cancelable: true, code, key: e.key}));
    return e;
  }

  test('Stage: Space plays, L loops, M mutes, 1 mutes stem 1, ] goes to the next section, Space stops', async () => {
    const b = await bed();
    document.documentElement.dataset.place = 'stage';
    document.documentElement.dataset.posture = 'stage';
    const stop = startDispatcher({registry: b.reg, platform: 'win'});
    current.push(() => stop());
    b.ts.transport.cue(40);
    key('KeyL');
    expect(b.snap.loop).toMatchObject({on: true, a: 32, b: 48});
    key('KeyM');
    expect(b.snap.mix.tracks[0]).toMatchObject({name: 'drums', muted: true});
    key('Digit1');
    expect(b.snap.mix.tracks[0].muted).toBe(false);
    expect(key('Space').defaultPrevented).toBe(true);
    await settle();
    expect(b.snap.phase).toBe('playing');
    key('Space');
    expect(b.snap.phase).toBe('stopped');
    b.ts.transport.clearLoop();
    key('BracketRight');
    expect(b.snap.cue).toBe(48);
  });

  test('a focused strip segment takes Enter (focus.play) and L (focus.loop) before the Stage', async () => {
    const b = await bed();
    document.documentElement.dataset.place = 'stage';
    document.documentElement.dataset.posture = 'stage';
    const stop = startDispatcher({registry: b.reg, platform: 'win'});
    current.push(() => stop());
    const nav = document.createElement('nav');
    nav.dataset.scope = 'stage.strip';
    const seg = document.createElement('button');
    nav.append(seg);
    document.body.append(nav);
    seg.focus();
    b.reg.provide('focused', () => ({kind: 'section', t0: 80, t1: 96, label: 'Bridge'}));
    key('KeyL');
    expect(b.snap.loop).toMatchObject({on: true, a: 80, b: 96});
    key('Enter');
    await settle();
    expect(b.snap.phase).toBe('playing');
    expect(b.ts.transport.position()).toBeCloseTo(80, 1);
  });

  test('Edit · Chart: Enter is Again and , is slower (scope edit.chart)', async () => {
    const b = await bed();
    document.documentElement.dataset.place = 'edit';
    document.documentElement.dataset.posture = 'edit';
    b.reg.provide('route', () => ({name: 'edit', params: {tab: 'chart'}}));
    const stop = startDispatcher({registry: b.reg, platform: 'win'});
    current.push(() => stop());
    key('Comma');
    expect(b.snap.rate).toBe(0.95);
    key('Enter');
    await settle();
    expect(b.snap.phase).toBe('playing');
  });
});
