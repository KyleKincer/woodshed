// @vitest-environment happy-dom
// The Speed, Click and Mix sheets (src/stage/sheets/{speed,click,mix}.js; spec §4.7; architecture
// §2.14.3, §2.14.11, D14, D28, D30, D37, D59) on real song sessions (tests/helpers/test-session.js):
// the spec §4.7 control tables as a table test (every CONTROLS row by role and accessible name),
// then each sheet's behaviour: presets (D59 closes on the band only), ±1 and the 25% floor, keep
// pitch per song, the trainer UI driven through real passes, the count-in choices and Custom
// 1–16 bars/beats, every pass, the D14 click modes, accent, volume, pre-roll, the edge flash pref,
// "At the cue", the unmapped Lead-in and "Needs a bar grid", the Edit map footer, Minus me / I play
// (the inline InstrumentPicker writing the profile) / Only me / Full mix, the Mute·Solo switch,
// StemPads in canonical order, Chart playback, and the no-stem copy on the desktop and the web.
// Computed sizes and the presented sheets are Playwright states (tests/fixture/states/ST7.cjs).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {createRegistry} from '../src/app/commands.js';
import {COPY as TC, defineTransportCommands} from '../src/stage/transport-commands.js';
import {clock as appClock} from '../src/app/clock.js';
import {signal} from '../src/app/store.js';
import {emptyScore} from '../shared/notation.ts';
import {render as renderSpeed, trainsOnText, bpmText, draftOf, snapDraft, sheetLayout} from '../src/stage/sheets/speed.js';
import {render as renderClick, countInChoice, atCueText} from '../src/stage/sheets/click.js';
import {render as renderMix, mixNotes, padState} from '../src/stage/sheets/mix.js';
import {COPY, CONTROLS, PRESETS, COUNT_IN_CHOICES, TRAINER_RANGE} from '../src/stage/sheets/sheets-a.copy.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession} from './helpers/test-session.js';
import {installPopoverShim, keydown, restoreDomShims} from './helpers/dom.js';
import {sevenEight} from './fixtures/maps.js';
import {speedText} from '../src/stage/hud.js';

/** A stored tempo of `count` bars in `num`/`den` (ids m0…), one pin at 0:00 plus `pins`, tail `qpm`. */
const tempoOf = ({count = 8, num = 4, den = 4, grouping, qpm = 120, pins = []} = {}) => ({songMap: {version: 1, origin: 'edited', tailQpm: qpm,
  pins: [{position: {n: 0, d: 1}, time: 0}, ...pins],
  measures: Array.from({length: count}, (_, i) => ({id: `m${i}`, numerator: num, denominator: den, length: {n: 4 * num, d: den}, label: '',
    ...(grouping ? {grouping} : {})}))}});

const S = COPY.speed, C = COPY.click, M = COPY.mix;

// ---------------------------------------------------------------------------------------------------------------
// helpers

/** The accessible name: aria-labelledby, aria-label, else the text without aria-hidden or hidden parts. */
function nameOf(el) {
  const by = el.getAttribute('aria-labelledby');
  if (by) return by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
  const label = el.getAttribute('aria-label');
  if (label) return label.trim();
  const walk = (node) => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || node.getAttribute('aria-hidden') === 'true' || node.hidden) return '';
    return [...node.childNodes].map(walk).join('');
  };
  return walk(el).replace(/\s+/g, ' ').trim();
}
const ROLE = {
  button: 'button:not([role]), [role=button]', group: '[role=group]', radiogroup: '[role=radiogroup]', radio: '[role=radio]',
  spinbutton: '[role=spinbutton]', slider: '[role=slider]',
};
const visible = (el) => !el.closest('[hidden]');
const all = (root, role, name) => [...root.querySelectorAll(ROLE[role])].filter(visible).filter((el) => name === undefined || nameOf(el) === name);
const byRole = (root, role, name) => all(root, role, name)[0] ?? null;
const must = (root, role, name) => {
  const el = byRole(root, role, name);
  if (!el) throw new Error(`no visible ${role} named ${JSON.stringify(name)}; have ${all(root, role).map(nameOf).join(' | ')}`);
  return el;
};
const pressed = (el) => el.getAttribute('aria-pressed') === 'true';
const checked = (el) => el.getAttribute('aria-checked') === 'true';
const disabled = (el) => el.getAttribute('aria-disabled') === 'true';
const loop = (fields = {}) => ({on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none', ...fields});
const practice = (fields = {}) => ({v: 2, cue: 0, rate: 1, tracks: [], minusMe: false, trainer: null, spots: [], markers: [], ...fields, loop: loop(fields.loop)});

/**
 * Stand-ins for the Stage commands the sheets bind (commands.js is ST4's). The transport commands
 * are the real ones (transport-commands.js) on the test registry, with the session and transport
 * provided as the Stage does; every successful registry run is recorded.
 */
const STANDINS = [['edit.map', 'Edit map', 'Edit'], ['stage.tapBeat', 'Tap the beat…', 'Practice'], ['stage.getBars', 'Get bars…', 'Practice'],
  ['song.resplit', 'Re-split…', 'Library']];

let clock, restoreAudio, current = [];

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(Date.parse('2026-10-28T12:00:00Z'));
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
  installPopoverShim();
});

afterEach(async () => {
  for (const off of current.splice(0)) await off();
  document.body.replaceChildren();
  restoreDomShims();
  restoreAudio();
  vi.useRealTimers();
});

/** A fake account whose patches reach the test session's account (the transport follows the profile). */
function fakeAccount(ts, profile) {
  const value = signal({profile});
  const account = {
    value, patches: [], fail: false,
    async patch(partial) {
      account.patches.push(structuredClone(partial));
      if (account.fail) throw new Error('offline');
      value.value = {...value.peek(), ...partial};
      ts.setAccount(partial);
    },
  };
  return account;
}

/**
 * One sheet mounted in a stand-in Sheet body (`data-presentation` bottom = band, popover = rail)
 * on a real session. Returns the session, the sheet, the recorded command runs and close calls.
 */
async function bed(kind, {presentation = 'bottom', profile = {instruments: ['drums'], primary: 'drums', openWithMyPart: 'in'},
  desktop = false, prefsValues = {}, sheet: sheetOptions = {}, ...options} = {}) {
  const ts = await createTestSession({clock, account: {profile}, ...options});
  const registry = createRegistry();
  const ran = [], runs = [];
  const offDefs = registry.registerMany(STANDINS.map(([id, title, group]) => ({id, title, group, run: () => {}})));
  const offTransport = defineTransportCommands({registry, sheets: {}});
  const offSession = registry.provide('session', () => ts.session);
  const offProvided = registry.provide('transport', () => ts.session.transport);
  const realRun = registry.run;
  registry.run = (id, opts) => {
    const ok = realRun(id, opts);
    if (ok) { ran.push(id); runs.push({id, args: opts?.args}); }
    return ok;
  };
  const host = document.createElement('section');
  host.className = 'ui-sheet';
  host.dataset.presentation = presentation;
  const body = document.createElement('div');
  host.append(body);
  document.body.append(host);
  const closes = [];
  const prefStore = {...prefsValues};
  const prefs = {value: signal(prefStore), get: (k) => prefStore[k], set: (k, v) => { prefStore[k] = v; prefs.value.value = {...prefStore}; }};
  const account = fakeAccount(ts, profile);
  const render = {speed: renderSpeed, click: renderClick, mix: renderMix}[kind];
  const handle = render(body, {session: ts.session, close: () => closes.push(kind), registry, prefs, account, desktop: {available: desktop}, ...sheetOptions});
  current.push(async () => { handle.destroy(); offDefs(); offTransport(); offSession?.(); offProvided?.(); await ts.dispose(); });
  vi.advanceTimersByTime(60);   // the registry's state recompute reaches command buttons
  return {ts, handle, body, ran, runs, registry, closes, prefStore, account, s: () => ts.snapshot, v: () => ts.value,
    q: (sel) => body.querySelector(sel), text: () => body.textContent.replace(/\s+/g, ' ')};
}

const click = async (el) => { el.click(); await Promise.resolve(); vi.advanceTimersByTime(1); };

// ---------------------------------------------------------------------------------------------------------------
// the control table

/** How to reach each context of the CONTROLS table. */
const CONTEXTS = {
  speed: {
    any: {},
    running: {after: (b) => b.ts.transport.startTrainer()},
  },
  click: {
    mapped: {},
    any: {},
    custom: {after: async (b) => click(must(b.body, 'radio', 'Custom'))},
    unmapped: {options: {mapped: false}},
  },
  mix: {
    stems: {},
    part: {options: {score: emptyScore(128, 120)}, after: async (b) => { await b.ts.notation.ready; }},
    'no-part': {options: {profile: {instruments: [], primary: null, openWithMyPart: 'in'}}},
    'fallback-desktop': {options: {profile: {instruments: ['guitar'], primary: 'guitar', openWithMyPart: 'in'}, desktop: true}},
  },
};

describe('spec §4.7 control tables', () => {
  const rows = CONTROLS.map((row) => [`${row.sheet} · ${row.context} · ${row.role} "${row.name}"`, row]);
  test.each(rows)('%s', async (_, row) => {
    const ctx = CONTEXTS[row.sheet][row.context];
    expect(ctx, `a way to reach ${row.sheet}/${row.context}`).toBeTruthy();
    const b = await bed(row.sheet, ctx.options ?? {});
    if (ctx.after) { await ctx.after(b); await b.ts.settle(); }
    const el = must(b.body, row.role, row.name);
    expect(el).toBeTruthy();
    if (row.command && !(row.role === 'radio' && checked(el))) {
      await click(el);
      expect(b.ran).toContain(row.command);
    }
  });

  test('every context in the table is reachable and every sheet has rows', () => {
    for (const row of CONTROLS) expect(CONTEXTS[row.sheet]?.[row.context], `${row.sheet}/${row.context}`).toBeTruthy();
    expect(new Set(CONTROLS.map((r) => r.sheet))).toEqual(new Set(['speed', 'click', 'mix']));
    expect(CONTROLS.filter((r) => r.sheet === 'speed' && r.role === 'button').map((r) => r.name)).toEqual(expect.arrayContaining(PRESETS.map((n) => `${n}%`)));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Speed

describe('Speed sheet', () => {
  test('the value and its bpm (tempo at the playhead × rate); 100% reads --ink-3', async () => {
    const b = await bed('speed', {practice: practice({rate: 0.75})});
    expect(b.q('.sheet-speed-value').textContent).toBe('75%');
    expect(b.q('.sheet-speed-value').dataset.at100).toBe('false');
    expect(b.q('.sheet-speed-bpm').textContent).toBe('90 bpm');
    b.ts.transport.setSpeed(1);
    await b.ts.settle();
    expect(b.q('.sheet-speed-value').textContent).toBe('100%');
    expect(b.q('.sheet-speed-value').dataset.at100).toBe('true');
    expect(b.q('.sheet-speed-bpm').textContent).toBe('120 bpm');
  });

  test('the bpm is the tempo at the playhead, the same reading as the HUD, on a tempo ramp', async () => {
    // A ramp from quarter 8 (4 s) to quarter 24 (10 s): the bar-start tempo and the playhead tempo differ.
    const tempo = tempoOf({count: 12, pins: [{position: {n: 8, d: 1}, time: 4, ramp: true}, {position: {n: 24, d: 1}, time: 10}]});
    const b = await bed('speed', {tempo, duration: 40});
    const map = b.ts.map;
    for (const t of [1, 4.5, 6, 9, 12]) {
      const hud = speedText({rate: 0.8}, {map, t}).sub;
      expect(bpmText(b.ts.session, 0.8, t), `t=${t}`).toBe(hud);
      expect(bpmText(b.ts.session, 1, t)).toBe(`${Math.round(map.bpmAt(map.positionAt(t)))} bpm`);
    }
    const inside = map.bars[map.barIndexAt(4.5)];
    expect(Math.round(map.bpmAt(map.positionAt(4.5)))).not.toBe(Math.round(inside.bpm));   // the case the bar start got wrong
  });

  test('an unmapped song shows no bpm', async () => {
    const b = await bed('speed', {mapped: false});
    expect(b.q('.sheet-speed-bpm').hidden).toBe(true);
    expect(bpmText(b.ts.session, 1, 10)).toBe('');
  });

  test.each(PRESETS)('preset %i%% applies the speed as one undo step', async (n) => {
    const b = await bed('speed', {presentation: 'popover'});
    const before = b.s().rate;
    await click(must(b.body, 'button', `${n}%`));
    expect(b.s().rate).toBe(n / 100);
    expect(pressed(must(b.body, 'button', `${n}%`))).toBe(true);
    expect(all(b.body, 'button').filter((el) => el.closest('.sheet-speed-presets') && pressed(el))).toHaveLength(1);
    if (n !== 100) {
      b.ts.undo.undo();
      expect(b.ts.snapshot.rate).toBe(before);
    }
  });

  test('D59: on the band a preset tap applies and closes the sheet; in the rail popover it stays open', async () => {
    const band = await bed('speed', {presentation: 'bottom'});
    await click(must(band.body, 'button', '75%'));
    expect(band.s().rate).toBe(0.75);
    expect(band.closes).toEqual(['speed']);
    const rail = await bed('speed', {presentation: 'popover'});
    await click(must(rail.body, 'button', '75%'));
    expect(rail.s().rate).toBe(0.75);
    expect(rail.closes).toEqual([]);
    expect(sheetLayout(rail.body)).toBe('rail');
    expect(sheetLayout(band.body)).toBe('band');
    expect(sheetLayout(rail.body, 'band')).toBe('band');
  });

  test('±1, Keep pitch and the trainer never close the band sheet', async () => {
    const b = await bed('speed', {presentation: 'bottom'});
    await click(must(b.body, 'button', S.faster));
    await click(must(b.body, 'button', S.keepPitch));
    await click(must(b.body, 'button', S.startTrainer));
    expect(b.closes).toEqual([]);
  });

  test('fine −1 / +1 step by 1%; the floor is 25% (D30) and the ceiling 150%, each disabled with its reason', async () => {
    const b = await bed('speed', {practice: practice({rate: 0.27})});
    const slower = must(b.body, 'button', S.slower);
    await click(slower);
    expect(b.s().rate).toBe(0.26);
    await click(slower);
    expect(b.s().rate).toBe(0.25);
    expect(disabled(slower)).toBe(true);
    expect(slower.textContent).toContain(TC.slowest);
    await click(slower);
    expect(b.s().rate).toBe(0.25);
    await click(must(b.body, 'button', S.faster));
    expect(b.s().rate).toBe(0.26);
    expect(disabled(slower)).toBe(false);
    b.ts.transport.setSpeed(1.49);
    await b.ts.settle();
    const faster = must(b.body, 'button', S.faster);
    await click(faster);
    expect(b.s().rate).toBe(1.5);
    expect(disabled(faster)).toBe(true);
    expect(faster.textContent).toContain(TC.fastest);
  });

  test('Keep pitch is stored with the song and is one undo step; it starts from the device default', async () => {
    const b = await bed('speed');
    const toggle = must(b.body, 'button', S.keepPitch);
    expect(pressed(toggle)).toBe(true);   // the account default (keepPitch true)
    expect(b.v().keepPitch).toBeUndefined();
    await click(toggle);
    expect(b.v().keepPitch).toBe(false);
    expect(b.s().keepPitch).toBe(false);
    expect(pressed(toggle)).toBe(false);
    b.ts.undo.undo();
    await b.ts.settle();
    expect(b.v().keepPitch).toBeUndefined();
    expect(pressed(toggle)).toBe(true);
    expect(toggle.getAttribute('aria-describedby')).toBeTruthy();
    expect(b.text()).toContain(S.keepPitchHint);
  });

  test('the trainer steppers start from the song\'s saved trainer, else the default 70 → 100%, +5%, 2 passes', async () => {
    const fresh = await bed('speed');
    expect(draftOf(fresh.ts.session, fresh.s())).toEqual({start: 70, end: 100, step: 5, passes: 2});
    expect(must(fresh.body, 'spinbutton', S.start).getAttribute('aria-valuetext')).toBe('70%');
    expect(must(fresh.body, 'spinbutton', S.step).getAttribute('aria-valuetext')).toBe('+5%');
    expect(fresh.q('.sheet-speed-plan').textContent).toBe('70% → 100% in 7 steps, 2 passes each');
    const saved = await bed('speed', {practice: practice({trainer: {start: 0.6, end: 0.9, step: 0.1, passes: 3}})});
    expect(must(saved.body, 'spinbutton', S.start).getAttribute('aria-valuenow')).toBe('60');
    expect(must(saved.body, 'spinbutton', S.end).getAttribute('aria-valuenow')).toBe('90');
    expect(must(saved.body, 'spinbutton', S.passes).getAttribute('aria-valuenow')).toBe('3');
    expect(saved.q('.sheet-speed-plan').textContent).toBe('60% → 90% in 4 steps, 3 passes each');
  });

  test('"Trains on": the loop when on, else the current section, else the whole song; unmapped never says bar', async () => {
    const looped = await bed('speed', {practice: practice({cue: 32, loop: {on: true, a: 32, b: 48}})});
    expect(looped.q('.sheet-speed-trains-on').textContent).toBe('Trains on: Chorus (bars 17–24)');
    looped.ts.transport.loopRange(32, 36, {snap: 'none'});
    await looped.ts.settle();
    expect(looped.q('.sheet-speed-trains-on').textContent).toBe('Trains on: Bars 17–18');
    const section = await bed('speed', {practice: practice({cue: 50})});
    expect(section.q('.sheet-speed-trains-on').textContent).toBe('Trains on: Verse 2 (bars 25–32)');
    const plain = await bed('speed', {mapped: false, practice: practice({cue: 50})});
    expect(plain.q('.sheet-speed-trains-on').textContent).toBe(`Trains on: ${S.wholeSong}`);
    const plainLoop = await bed('speed', {mapped: false, practice: practice({cue: 31.2, loop: {on: true, a: 31.2, b: 41}})});
    expect(trainsOnText(plainLoop.ts.session, plainLoop.s())).toBe('0:31.2–0:41.0');
    expect(plainLoop.text()).not.toMatch(/Bar|bar /);
  });

  test('the trainer on a real session: steppers → Start (the current section becomes the loop, D28) → steps at each wrap → "Trainer done — 100%"', async () => {
    const b = await bed('speed', {practice: practice({cue: 2})});
    const step = (name, key, times = 1) => { for (let i = 0; i < times; i++) keydown(key, {target: must(b.body, 'spinbutton', name)}); };
    step(S.start, 'ArrowUp', 2);      // 70 → 80
    step(S.step, 'ArrowUp', 5);       // +5 → +10
    step(S.passes, 'ArrowDown');      // 2 → 1
    expect(b.q('.sheet-speed-plan').textContent).toBe('80% → 100% in 3 steps, 1 pass each');
    expect(b.q('.sheet-speed-trains-on').textContent).toBe('Trains on: Intro (bars 1–8)');
    expect(b.q('.sheet-speed-progress').hidden).toBe(true);
    await click(must(b.body, 'button', S.startTrainer));
    expect(b.s().trainer).toMatchObject({start: 0.8, end: 1, step: 0.1, passes: 1, stepIndex: 0, steps: 3});
    expect(b.s().loop).toMatchObject({on: true, a: 0, b: 16});
    expect(b.s().rate).toBe(0.8);
    expect(b.q('.sheet-speed-progress').textContent).toBe('Step 1 of 3 · 80%');
    expect(byRole(b.body, 'button', S.stopTrainer)).toBeTruthy();
    expect(b.q('.sheet-speed-value').textContent).toBe('80%');
    await b.ts.play();
    await b.ts.advance(16 / 0.8 + 0.2);
    expect(b.q('.sheet-speed-progress').textContent).toBe('Step 2 of 3 · 90%');
    expect(b.q('.sheet-speed-value').textContent).toBe('90%');
    await b.ts.advance(16 / 0.9 + 0.2);
    expect(b.s().trainer.done).toBe(true);
    expect(b.q('.sheet-speed-progress').textContent).toBe('Trainer done — 100%');
    expect(b.q('.sheet-speed-progress').dataset.done).toBe('true');
    expect(b.q('.sheet-speed-value').textContent).toBe('100%');
    // Stopping the trainer from the sheet.
    await click(must(b.body, 'button', S.stopTrainer));
    expect(b.s().trainer).toBeNull();
    expect(b.q('.sheet-speed-progress').hidden).toBe(true);
    expect(byRole(b.body, 'button', S.startTrainer)).toBeTruthy();
  });

  test('stepper changes while the trainer runs wait for the next start, and say so', async () => {
    const b = await bed('speed', {practice: practice({cue: 32, loop: {on: true, a: 32, b: 48}})});
    await click(must(b.body, 'button', S.startTrainer));
    const pending = [...b.body.querySelectorAll('.sheet-speed-hint')].find((el) => el.textContent === S.pendingChanges);
    expect(pending.hidden).toBe(true);
    keydown('ArrowUp', {target: must(b.body, 'spinbutton', S.end)});
    expect(b.s().trainer.end).toBe(1);
    expect(pending.hidden).toBe(false);
    await click(must(b.body, 'button', S.stopTrainer));
    await click(must(b.body, 'button', S.startTrainer));
    expect(b.s().trainer.end).toBe(1.05);
    expect(pending.hidden).toBe(true);
  });

  test('a trainer started elsewhere (the palette) shows its own configuration', async () => {
    const b = await bed('speed', {practice: practice({cue: 32, loop: {on: true, a: 32, b: 48}})});
    b.ts.transport.startTrainer({start: 0.5, end: 0.8, step: 0.1, passes: 4});
    await b.ts.settle();
    expect(must(b.body, 'spinbutton', S.start).getAttribute('aria-valuenow')).toBe('50');
    expect(must(b.body, 'spinbutton', S.passes).getAttribute('aria-valuenow')).toBe('4');
    expect(b.q('.sheet-speed-progress').textContent).toBe('Step 1 of 4 · 50%');
  });

  test('an off-grid saved trainer (72%, 20 passes) is snapped: steppers, plan line and Start agree', async () => {
    const b = await bed('speed', {practice: practice({cue: 32, loop: {on: true, a: 32, b: 48}, trainer: {start: 0.72, end: 1, step: 0.05, passes: 20}})});
    const start = must(b.body, 'spinbutton', S.start), passes = must(b.body, 'spinbutton', S.passes);
    expect(start.getAttribute('aria-valuenow')).toBe('70');
    expect(passes.getAttribute('aria-valuenow')).toBe('20');   // 1–32, as practice.ts keeps it
    expect(draftOf(b.ts.session, b.s())).toEqual({start: 70, end: 100, step: 5, passes: 20});
    expect(b.q('.sheet-speed-plan').textContent).toBe('70% → 100% in 7 steps, 20 passes each');
    await click(must(b.body, 'button', S.startTrainer));
    expect(b.s().trainer).toMatchObject({start: 0.7, end: 1, step: 0.05, passes: 20});
    expect(b.runs.at(-1)).toEqual({id: 'trainer.toggle', args: {start: 0.7, end: 1, step: 0.05, passes: 20}});
    expect(snapDraft({start: 151, end: 24, step: 40, passes: 99})).toEqual({start: TRAINER_RANGE.rate.max, end: TRAINER_RANGE.rate.min,
      step: TRAINER_RANGE.step.max, passes: TRAINER_RANGE.passes.max});
  });

  test('a palette trainer off the grid (62 → 90, +3%): the sheet shows the snapped draft and says the next start differs', async () => {
    const b = await bed('speed', {practice: practice({cue: 32, loop: {on: true, a: 32, b: 48}})});
    b.ts.transport.startTrainer({start: 0.62, end: 0.9, step: 0.03});
    await b.ts.settle();
    const start = must(b.body, 'spinbutton', S.start);
    expect(start.getAttribute('aria-valuenow')).toBe('60');
    expect(b.q('.sheet-speed-plan').textContent).toMatch(/^60% → 90%/);
    const pending = [...b.body.querySelectorAll('.sheet-speed-hint')].find((el) => el.textContent === S.pendingChanges);
    expect(pending.hidden).toBe(false);
    await click(must(b.body, 'button', S.stopTrainer));
    await click(must(b.body, 'button', S.startTrainer));
    expect(b.s().trainer).toMatchObject({start: 0.6, end: 0.9, step: 0.03});
    expect(start.getAttribute('aria-valuenow')).toBe('60');
    expect(pending.hidden).toBe(true);
  });

  test('presets, ±1 and Start / Stop run their §3.1 commands with args', async () => {
    const b = await bed('speed', {presentation: 'popover', practice: practice({cue: 32, loop: {on: true, a: 32, b: 48}})});
    await click(must(b.body, 'button', '85%'));
    await click(must(b.body, 'button', S.faster));
    await click(must(b.body, 'button', S.slower));
    await click(must(b.body, 'button', S.startTrainer));
    await click(must(b.body, 'button', S.stopTrainer));
    expect(b.runs).toEqual([
      {id: 'speed.set', args: {rate: 0.85}}, {id: 'speed.upFine', args: undefined}, {id: 'speed.downFine', args: undefined},
      {id: 'trainer.toggle', args: {start: 0.7, end: 1, step: 0.05, passes: 2}}, {id: 'trainer.toggle', args: undefined},
    ]);
    expect(must(b.body, 'button', S.faster).getAttribute('aria-keyshortcuts')).toBeTruthy();
  });

  test('a manual speed change stops the trainer (rule 11) and the sheet follows', async () => {
    const b = await bed('speed', {presentation: 'popover', practice: practice({cue: 32, loop: {on: true, a: 32, b: 48}})});
    await click(must(b.body, 'button', S.startTrainer));
    await click(must(b.body, 'button', '90%'));
    expect(b.s().trainer).toBeNull();
    expect(byRole(b.body, 'button', S.startTrainer)).toBeTruthy();
  });

  test('destroy removes the sheet and stops following the session', async () => {
    const b = await bed('speed');
    const el = b.q('.sheet-speed');
    b.handle.destroy();
    expect(el.isConnected).toBe(false);
    expect(() => b.ts.transport.setSpeed(0.8)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Click

describe('Click sheet', () => {
  test.each([
    [{on: false, length: 1, unit: 'bars'}, {}, 'off'],
    [{on: true, length: 1, unit: 'bars'}, {}, '1-bars'],
    [{on: true, length: 2, unit: 'bars'}, {}, '2-bars'],
    [{on: true, length: 2, unit: 'beats'}, {}, '2-beats'],
    [{on: true, length: 3, unit: 'bars'}, {}, 'custom'],
    [{on: true, length: 1, unit: 'beats'}, {}, 'custom'],
    [{on: true, length: 2, unit: 'bars'}, {custom: true}, 'custom'],
    [{on: false, length: 4, unit: 'bars'}, {custom: true}, 'off'],
  ])('countInChoice(%j, %j) → %s', (countIn, opts, want) => {
    expect(countInChoice(countIn, opts)).toBe(want);
  });

  test.each(COUNT_IN_CHOICES.filter((c) => c.length))('count-in "$label" sets on, length and unit as one undo step', async (choice) => {
    const b = await bed('click');
    await click(must(b.body, 'radio', choice.label));
    expect(b.s().countIn).toEqual({on: true, length: choice.length, unit: choice.unit});
    expect(b.v().click.countIn).toEqual({on: true, length: choice.length, unit: choice.unit});
    expect(checked(must(b.body, 'radio', choice.label))).toBe(true);
    b.ts.undo.undo();
    await b.ts.settle();
    expect(b.s().countIn.on).toBe(false);
    expect(checked(must(b.body, 'radio', 'Off'))).toBe(true);
  });

  test('Off turns the count-in off; the length is kept', async () => {
    const b = await bed('click', {practice: practice({click: {countIn: {on: true, length: 2, unit: 'beats'}, mode: 'countin', accent: true, volume: 0.7, preRoll: false}})});
    expect(checked(must(b.body, 'radio', '2 beats'))).toBe(true);
    await click(must(b.body, 'radio', 'Off'));
    expect(b.s().countIn).toEqual({on: false, length: 2, unit: 'beats'});
  });

  test('Custom: 1–16 bars or beats (today\'s range), shown while chosen', async () => {
    const b = await bed('click');
    expect(byRole(b.body, 'spinbutton', C.customLength)).toBeNull();
    await click(must(b.body, 'radio', 'Custom'));
    expect(b.s().countIn.on).toBe(true);
    const length = must(b.body, 'spinbutton', C.customLength);
    expect(length.getAttribute('aria-valuemin')).toBe('1');
    expect(length.getAttribute('aria-valuemax')).toBe('16');
    keydown('ArrowUp', {target: length});
    keydown('ArrowUp', {target: length});
    expect(b.s().countIn).toMatchObject({on: true, length: 3, unit: 'bars'});
    keydown('End', {target: length});
    expect(b.s().countIn.length).toBe(16);
    keydown('ArrowUp', {target: length});
    expect(b.s().countIn.length).toBe(16);
    keydown('Home', {target: length});
    expect(b.s().countIn.length).toBe(1);
    await click(must(b.body, 'radio', C.beats));
    expect(b.s().countIn).toEqual({on: true, length: 1, unit: 'beats'});
    // Custom stays chosen even when the values equal a preset (2 bars).
    await click(must(b.body, 'radio', C.bars));
    keydown('ArrowUp', {target: length});
    expect(b.s().countIn).toEqual({on: true, length: 2, unit: 'bars'});
    expect(checked(must(b.body, 'radio', 'Custom'))).toBe(true);
    // A preset closes Custom.
    await click(must(b.body, 'radio', '1 bar'));
    expect(byRole(b.body, 'spinbutton', C.customLength)).toBeNull();
  });

  test('a stored custom count-in (3 bars) opens on Custom', async () => {
    const b = await bed('click', {practice: practice({click: {countIn: {on: true, length: 3, unit: 'bars'}, mode: 'countin', accent: true, volume: 0.7, preRoll: false}})});
    expect(checked(must(b.body, 'radio', 'Custom'))).toBe(true);
    expect(must(b.body, 'spinbutton', C.customLength).getAttribute('aria-valuenow')).toBe('3');
  });

  test('Count in every loop pass (default on) toggles the loop option', async () => {
    const b = await bed('click');
    const toggle = must(b.body, 'button', C.everyPass);
    expect(pressed(toggle)).toBe(true);
    await click(toggle);
    expect(b.s().loop.eachPassCount).toBe(false);
    expect(pressed(toggle)).toBe(false);
  });

  test.each([['Off', 'off'], ['During count-in only', 'countin'], ['Always', 'always']])('Click "%s" sets mode %s (D14)', async (label, mode) => {
    const b = await bed('click', {practice: practice({click: {countIn: {on: false, length: 1, unit: 'bars'}, mode: mode === 'always' ? 'off' : 'always', accent: true, volume: 0.7, preRoll: false}})});
    const group = must(b.body, 'radiogroup', C.click);
    await click(must(group, 'radio', label));
    expect(b.s().click.mode).toBe(mode);
    expect(checked(must(group, 'radio', label))).toBe(true);
  });

  test('Off with the count-in on: the sheet explains the silent count (D14)', async () => {
    const b = await bed('click');
    const note = [...b.body.querySelectorAll('.sheet-click-note')].find((el) => el.textContent === C.silentCount);
    expect(note.hidden).toBe(true);
    // 'Off' exists twice (count-in and click): pick the click group's.
    const clickOff = [...b.body.querySelectorAll('.sheet-click-mode [role=radio]')].find((el) => nameOf(el) === 'Off');
    await click(must(b.body, 'radio', '1 bar'));
    await click(clickOff);
    expect(b.s().countIn.on).toBe(true);
    expect(b.s().click.mode).toBe('off');
    expect(note.hidden).toBe(false);
  });

  test('accent, volume (0–100) and pre-roll write practice.click', async () => {
    const b = await bed('click');
    const accent = must(b.body, 'button', C.accent);
    expect(pressed(accent)).toBe(true);
    await click(accent);
    expect(b.s().click.accent).toBe(false);
    const volume = must(b.body, 'slider', C.volume);
    expect(volume.getAttribute('aria-valuetext') ?? b.q('.sheet-click-volume').textContent).toContain('70');
    keydown('ArrowDown', {target: volume});
    expect(b.s().click.volume).toBeCloseTo(0.69, 5);
    keydown('Home', {target: volume});
    expect(b.s().click.volume).toBe(0);
    const preRoll = must(b.body, 'button', C.preRoll);
    expect(pressed(preRoll)).toBe(false);
    await click(preRoll);
    expect(b.s().click.preRoll).toBe(true);
    expect(b.v().click).toMatchObject({accent: false, volume: 0, preRoll: true});
  });

  test('the edge flash is a device pref (practice.edgeFlash), not practice', async () => {
    const b = await bed('click', {prefsValues: {'practice.edgeFlash': false}});
    const toggle = must(b.body, 'button', C.edgeFlash);
    expect(pressed(toggle)).toBe(false);
    await click(toggle);
    expect(b.prefStore['practice.edgeFlash']).toBe(true);
    expect(b.v().edgeFlash).toBeUndefined();
    expect(b.text()).toContain(C.lampsAlways);
  });

  test('"At the cue" is read-only and follows the cue and the map', async () => {
    const b = await bed('click');
    expect(b.q('.sheet-click-at-cue').textContent).toBe('At the cue: ♩ = 120 · 4/4 · from the map');
    expect(atCueText(null, 0)).toBe('');
  });

  test('"At the cue" pairs the felt tempo with its own note value: ♪ in 7/8 (2+2+3), ♩. in 6/8', async () => {
    // ♩ = 120 in 7/8 grouped 2+2+3 is felt in eighths (♪ = 240); a plain ♩ beside 240 would be wrong.
    const seven = await bed('click', {tempo: structuredClone(sevenEight.tempo), duration: sevenEight.duration});
    expect(seven.ts.map.bars[0].qpm).toBe(120);
    expect(seven.q('.sheet-click-at-cue').textContent).toBe('At the cue: ♪ = 240 · 7/8 (2+2+3) · from the map');
    // 6/8 at ♩ = 120 is felt in dotted quarters: ♩. = 80.
    const six = await bed('click', {tempo: tempoOf({num: 6, den: 8}), duration: 30});
    expect(six.q('.sheet-click-at-cue').textContent).toMatch(/^At the cue: ♩\. = 80 · 6\/8/);
    expect(six.q('.sheet-click-at-cue').textContent).not.toContain('♩ = ');
  });

  test('the footer "Tempo & bars wrong? Edit map →" runs edit.map and closes the sheet', async () => {
    const b = await bed('click');
    expect(b.q('.sheet-click-footer').textContent).toContain(C.footer);
    await click(must(b.body, 'button', C.editMap));
    expect(b.ran).toEqual(['edit.map']);
    expect(b.closes).toEqual(['click']);
  });

  test('unmapped: Lead-in 2 s and "Needs a bar grid" with [Tap the beat] [Get bars]; no click controls, no "bar"', async () => {
    const b = await bed('click', {mapped: false});
    const leadIn = must(b.body, 'button', C.leadIn);
    expect(pressed(leadIn)).toBe(false);
    await click(leadIn);
    expect(b.s().countIn.on).toBe(true);
    for (const name of [C.accent, C.preRoll, C.edgeFlash]) expect(byRole(b.body, 'button', name)).toBeNull();
    expect(byRole(b.body, 'radiogroup', C.click)).toBeNull();
    expect(byRole(b.body, 'radiogroup', C.countIn)).toBeNull();
    expect(byRole(b.body, 'slider', C.volume)).toBeNull();
    expect(b.q('.sheet-click-at-cue').hidden).toBe(true);
    expect(b.q('.sheet-click-footer').hidden).toBe(true);
    expect(b.q('.sheet-click-needs-grid').hidden).toBe(false);
    expect(b.q('.sheet-click-needs-grid').textContent).toContain(C.needsGrid);
    await click(must(b.body, 'button', C.tapBeat));
    await click(must(b.body, 'button', C.getBars));
    expect(b.ran).toEqual(['stage.tapBeat', 'stage.getBars']);
    const visibleText = [...b.body.querySelectorAll('*')].filter((el) => visible(el) && el.children.length === 0).map((el) => el.textContent).join(' ');
    expect(visibleText).not.toMatch(/\b[Bb]ars? \d|Pickup/);
  });

  test('a song that becomes mapped switches the sheet to the click controls', async () => {
    const b = await bed('click', {mapped: false});
    b.ts.session.mapChange('Tap the beat', (m) => m.replaceFromBeats(Array.from({length: 64}, (_, i) => ({time: i * 0.5, downbeat: i % 4 === 0})), 'detect'));
    await b.ts.settle();
    expect(b.ts.map.isReal).toBe(true);
    expect(byRole(b.body, 'radiogroup', C.click)).toBeTruthy();
    expect(b.q('.sheet-click-needs-grid').hidden).toBe(true);
  });

  test('a shared (read-only) song keeps the practice controls but offers no map editing', async () => {
    const mapped = await bed('click', {shared: {token: 'share-1'}});
    expect(mapped.q('.sheet-click-footer').hidden).toBe(true);
    expect(byRole(mapped.body, 'radio', '2 bars')).toBeTruthy();
    const plain = await bed('click', {shared: {token: 'share-2'}, mapped: false});
    expect(byRole(plain.body, 'button', C.tapBeat)).toBeNull();
    expect(byRole(plain.body, 'button', C.getBars)).toBeNull();
    expect(plain.text()).toContain(C.needsGrid);
    // No copy that points to the hidden Tap the beat / Get bars.
    const shown = [...plain.body.querySelectorAll('p')].filter(visible).map((el) => el.textContent);
    expect(shown).not.toContain(C.needsGridHint);
  });

  test('the Click choices run click.mode {mode}; checked and disabled come from the registry', async () => {
    const b = await bed('click');
    const group = must(b.body, 'radiogroup', C.click);
    expect(checked(must(group, 'radio', C.modes.countin))).toBe(true);
    await click(must(group, 'radio', C.modes.always));
    expect(b.runs.at(-1)).toEqual({id: 'click.mode', args: {mode: 'always'}});
    expect(b.s().click.mode).toBe('always');
    expect(checked(must(group, 'radio', C.modes.always))).toBe(true);
    for (const m of ['off', 'countin', 'always']) {
      const st = b.registry.state('click.mode', b.registry.context({args: {mode: m}}));
      expect(checked(must(group, 'radio', C.modes[m]))).toBe(!!st.checked);
    }
    // Count in every loop pass is loop.eachPass.
    await click(must(b.body, 'button', C.everyPass));
    expect(b.runs.at(-1)).toEqual({id: 'loop.eachPass', args: undefined});
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Mix

describe('Mix sheet', () => {
  const padNames = (b) => [...b.body.querySelectorAll('.sheet-mix-pads .ui-stem-pad')].map((el) => el.getAttribute('aria-label'));
  const pad = (b, stem) => b.body.querySelector(`.ui-stem-pad[data-stem="${stem}"]`);

  test('pure helpers: pad state and the no-stem notes', () => {
    expect(padState({muted: false, soloed: false})).toBe('on');
    expect(padState({muted: true, soloed: false})).toBe('out');
    expect(padState({muted: true, soloed: true})).toBe('solo');
    const four = ['drums', 'bass', 'vocals', 'other'];
    expect(mixNotes({instruments: []}, four)).toEqual({kind: 'choose'});
    expect(mixNotes({instruments: ['drums']}, four)).toBeNull();
    expect(mixNotes({instruments: ['guitar']}, four)).toEqual({kind: 'fallback', instruments: 'guitar'});
    expect(mixNotes({instruments: ['guitar', 'keys']}, four)).toEqual({kind: 'fallback', instruments: 'guitar or keys'});
    expect(mixNotes({instruments: ['bass']}, ['drums', 'no_drums'])).toEqual({kind: 'missing', instruments: 'bass'});
  });

  test('stem pads in canonical order (drums, bass, guitar, piano, vocals, other) with key-caps 1–6', async () => {
    const b = await bed('mix', {stems: ['other', 'vocals', 'piano', 'bass', 'guitar', 'drums']});
    expect(padNames(b)).toEqual(['Drums', 'Bass', 'Guitar', 'Piano', 'Vocals', 'Other']);
    const caps = [...b.body.querySelectorAll('.ui-stem-pad-main')].map((el) => el.getAttribute('aria-keyshortcuts'));
    expect(caps).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  test('a two-part song shows its pair', async () => {
    const b = await bed('mix', {stems: ['no_drums', 'drums']});
    expect(padNames(b)).toEqual(['Drums', 'No drums']);
  });

  test('band pads are band-sized, the rail popover\'s rail-sized', async () => {
    const band = await bed('mix', {presentation: 'bottom'});
    expect(pad(band, 'drums').dataset.size).toBe('band');
    const rail = await bed('mix', {presentation: 'popover'});
    expect(pad(rail, 'drums').dataset.size).toBe('rail');
    expect(rail.q('.sheet-mix').dataset.layout).toBe('rail');
  });

  test('Tap to: Mute · Solo — a pad tap mutes, or solos in Solo mode; Shift-click always solos', async () => {
    const b = await bed('mix');
    await click(must(b.body, 'button', 'Mute Bass'));
    expect(b.s().mix.tracks.find((t) => t.name === 'bass').muted).toBe(true);
    expect(pad(b, 'bass').dataset.state).toBe('out');
    await click(must(b.body, 'radio', M.solo));
    expect(byRole(b.body, 'button', 'Solo Vocals')).toBeTruthy();
    await click(must(b.body, 'button', 'Solo Vocals'));
    expect(b.s().mix.tracks.find((t) => t.name === 'vocals').soloed).toBe(true);
    expect(pad(b, 'vocals').dataset.state).toBe('solo');
    await click(must(b.body, 'radio', M.mute));
    const other = must(b.body, 'button', 'Mute Other');
    other.dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey: true}));
    expect(b.s().mix.tracks.find((t) => t.name === 'other').soloed).toBe(true);
    expect(b.text()).toContain(M.soloHint);
  });

  test('a pad\'s level slider sets the stem volume (coalesced undo per stem)', async () => {
    const b = await bed('mix');
    const level = must(b.body, 'slider', 'Drums level');
    keydown('ArrowDown', {target: level});
    keydown('ArrowDown', {target: level});
    expect(b.s().mix.tracks.find((t) => t.name === 'drums').volume).toBeCloseTo(0.98, 5);
    b.ts.undo.undo();
    await b.ts.settle();
    expect(b.s().mix.tracks.find((t) => t.name === 'drums').volume).toBe(1);
  });

  test('Minus me: Drums mutes my stems; Only me solos them; Full mix resets mute, solo and levels as one undo step', async () => {
    const b = await bed('mix');
    const minus = must(b.body, 'button', 'Minus me: Drums');
    expect(minus.getAttribute('aria-keyshortcuts')).toBe('M');
    await click(minus);
    expect(b.s().mix.minusMe).toBe(true);
    expect(pressed(minus)).toBe(true);
    expect(pad(b, 'drums').dataset.state).toBe('out');
    const only = must(b.body, 'button', M.onlyMe);
    await click(only);
    expect(b.s().mix.onlyMe).toBe(true);
    expect(b.s().mix.minusMe).toBe(false);
    expect(pad(b, 'drums').dataset.state).toBe('solo');
    b.ts.transport.setVolume('bass', 0.4);
    await b.ts.settle();
    await click(must(b.body, 'button', M.fullMix));
    expect(b.s().mix.tracks.every((t) => !t.muted && !t.soloed && t.volume === 1)).toBe(true);
    expect(b.s().mix.onlyMe).toBe(false);
    expect(b.q('.sheet-mix-full').dataset.full).toBe('true');
    b.ts.undo.undo();
    await b.ts.settle();
    expect(b.s().mix.onlyMe).toBe(true);
    expect(b.s().mix.tracks.find((t) => t.name === 'bass').volume).toBe(0.4);
  });

  test('I play: Drums ▾ opens the InstrumentPicker inline (no open-with choice) and writes the profile', async () => {
    const b = await bed('mix');
    const iPlay = must(b.body, 'button', 'I play: Drums');
    expect(iPlay.getAttribute('aria-expanded')).toBe('false');
    expect(b.q('.sheet-mix-picker').hidden).toBe(true);
    await click(iPlay);
    expect(iPlay.getAttribute('aria-expanded')).toBe('true');
    expect(b.q('.sheet-mix-picker').hidden).toBe(false);
    expect(byRole(b.body, 'radio', 'Hear everything')).toBeNull();
    await click(must(b.body, 'button', 'Bass'));
    await b.ts.settle();
    expect(b.account.patches.at(-1)).toEqual({profile: {instruments: ['drums', 'bass'], primary: 'drums', openWithMyPart: 'in'}});
    expect(byRole(b.body, 'button', 'I play: Drums, Bass')).toBeTruthy();
    expect(byRole(b.body, 'button', 'Minus me: Drums + Bass')).toBeTruthy();
    await click(must(b.body, 'button', 'Minus me: Drums + Bass'));
    expect(b.s().mix.tracks.filter((t) => t.muted).map((t) => t.name)).toEqual(['drums', 'bass']);
  });

  test('a failed profile save says so and shows the saved profile again', async () => {
    const b = await bed('mix');
    b.account.fail = true;
    await click(must(b.body, 'button', 'I play: Drums'));
    await click(must(b.body, 'button', 'Bass'));
    await b.ts.settle();
    const alert = b.body.querySelector('[role=alert]');
    expect(alert && visible(alert)).toBe(true);
    expect(alert.textContent).toContain(M.saveFailed);
    expect(pressed(must(b.body, 'button', 'Bass'))).toBe(false);
    expect(byRole(b.body, 'button', 'I play: Drums')).toBeTruthy();
  });

  test('no instrument chosen: Minus me and Only me are unavailable, the picker is open with the reason', async () => {
    const b = await bed('mix', {profile: {instruments: [], primary: null, openWithMyPart: 'in'}});
    const minus = must(b.body, 'button', 'Minus me');
    expect(disabled(minus)).toBe(true);
    expect(disabled(must(b.body, 'button', M.onlyMe))).toBe(true);
    expect(minus.getAttribute('aria-describedby')).toContain(b.q('.sheet-mix-note').id);
    expect(b.q('.sheet-mix-note').textContent).toContain(M.choose);
    expect(b.q('.sheet-mix-picker').hidden).toBe(false);
    await click(must(b.body, 'button', 'Drums'));
    await b.ts.settle();
    expect(disabled(must(b.body, 'button', 'Minus me: Drums'))).toBe(false);
    expect(b.q('.sheet-mix-note').hidden).toBe(true);
  });

  test('the transport\'s no-part path (M with no matching stem) leaves the sheet as it is', async () => {
    const b = await bed('mix', {profile: {instruments: ['bass'], primary: 'bass', openWithMyPart: 'in'}, stems: ['drums', 'no_drums']});
    expect(b.ts.transport.minusMe()).toBe(false);
    expect(b.ts.of('mix-sheet')).toHaveLength(1);
    expect(b.q('.sheet-mix-note-text').textContent).toBe(`${M.noMatch('bass')} ${M.noMatchWeb}`);
    expect(b.s().mix.tracks.some((t) => t.muted)).toBe(false);
  });

  test.each([
    ['desktop', true, `${M.fallback('guitar')}`, true],
    ['web', false, `${M.fallback('guitar')} ${M.fallbackWeb}`, false],
  ])('no stem for your instrument on the %s', async (_, desktop, line, resplit) => {
    const b = await bed('mix', {desktop, profile: {instruments: ['guitar'], primary: 'guitar', openWithMyPart: 'in'}});
    expect(b.q('.sheet-mix-note-text').textContent).toBe(line);
    expect(b.q('.sheet-mix-note-text').textContent).toContain('This song wasn\'t split with a guitar part. Muting \'Other\' instead.');
    expect(!!byRole(b.body, 'button', M.resplit)).toBe(resplit);
    expect(byRole(b.body, 'button', 'Minus me: Other')).toBeTruthy();
    if (resplit) {
      await click(must(b.body, 'button', M.resplit));
      expect(b.ran).toEqual(['song.resplit']);
    }
  });

  test('Chart playback Off · Quiet · Loud appears with a drum part and sets practice.chartAudio', async () => {
    const none = await bed('mix');
    expect(byRole(none.body, 'radiogroup', M.chartAudio)).toBeNull();
    const b = await bed('mix', {score: emptyScore(128, 120)});
    await b.ts.notation.ready;
    await b.ts.settle();
    const group = must(b.body, 'radiogroup', M.chartAudio);
    expect(checked(must(group, 'radio', 'Off'))).toBe(true);
    await click(must(group, 'radio', 'Quiet'));
    expect(b.s().mix.chartAudio).toBe('quiet');
    expect(b.v().chartAudio).toBe('quiet');
    await click(must(group, 'radio', 'Loud'));
    expect(b.s().mix.chartAudio).toBe('loud');
  });

  test('a shared (read-only) song keeps the mix but neither the picker nor Re-split', async () => {
    const b = await bed('mix', {shared: {token: 'share-3'}, desktop: true, profile: {instruments: ['guitar'], primary: 'guitar', openWithMyPart: 'in'}});
    expect(byRole(b.body, 'button', 'I play: Guitar')).toBeNull();
    expect(byRole(b.body, 'button', M.resplit)).toBeNull();
    expect(b.q('.sheet-mix-note-text').textContent).toBe(M.fallback('guitar'));
    await click(must(b.body, 'button', 'Mute Bass'));
    expect(b.s().mix.tracks.find((t) => t.name === 'bass').muted).toBe(true);
  });

  test('a shared song\'s no-stem note keeps the plain fact: no Re-split sentence, no "choose" prompt', async () => {
    const missing = await bed('mix', {shared: {token: 'share-4'}, desktop: true, stems: ['drums', 'no_drums'],
      profile: {instruments: ['bass'], primary: 'bass', openWithMyPart: 'in'}});
    expect(missing.q('.sheet-mix-note-text').textContent).toBe(M.noMatch('bass'));
    expect(missing.text()).not.toContain(M.noMatchDesktop);
    expect(byRole(missing.body, 'button', M.resplit)).toBeNull();
    const web = await bed('mix', {shared: {token: 'share-5'}, profile: {instruments: ['guitar'], primary: 'guitar', openWithMyPart: 'in'}});
    expect(web.q('.sheet-mix-note-text').textContent).toBe(M.fallback('guitar'));
    expect(web.text()).not.toContain(M.fallbackWeb);
    const none = await bed('mix', {shared: {token: 'share-6'}, profile: {instruments: [], primary: null, openWithMyPart: 'in'}});
    expect(none.q('.sheet-mix-note-text').textContent).toBe(M.chooseShared);
    expect(none.text()).not.toContain(M.choose);
    expect(byRole(none.body, 'group', M.iPlayPicker)).toBeNull();
  });

  test('Minus me, Only me, Full mix and Chart playback run their §3.1 commands; key-caps come from the commands', async () => {
    const b = await bed('mix', {score: emptyScore(128, 120)});
    await b.ts.notation.ready;
    await b.ts.settle();
    const minus = must(b.body, 'button', M.minusMe('Drums'));
    expect(minus.getAttribute('aria-keyshortcuts')).toBe('M');
    await click(minus);
    await click(must(b.body, 'button', M.onlyMe));
    await click(must(b.body, 'button', M.fullMix));
    await click(must(must(b.body, 'radiogroup', M.chartAudio), 'radio', 'Loud'));
    expect(b.runs.map((r) => r.id)).toEqual(['mix.minusMe', 'mix.onlyMe', 'mix.full', 'mix.chartAudio']);
    expect(b.runs.at(-1).args).toEqual({level: 'loud'});
    expect(checked(must(must(b.body, 'radiogroup', M.chartAudio), 'radio', 'Loud'))).toBe(true);
  });

  test('destroy removes every pad', async () => {
    const b = await bed('mix');
    const pads = [...b.body.querySelectorAll('.ui-stem-pad')];
    expect(pads).toHaveLength(4);
    b.handle.destroy();
    expect(pads.every((p) => !p.isConnected)).toBe(true);
  });
});
