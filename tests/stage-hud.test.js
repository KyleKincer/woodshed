// @vitest-environment happy-dom
// The Stage HUD (src/stage/hud.js; architecture §2.14.10, §4.4; spec §4.3, §4.10, §4.13): the §4.4
// text rules as a table (mapped, unmapped, pickup, 7/8), then the mounted HUD on a real session
// (tests/helpers/test-session.js): the section crossfade, the frame-bus cadence, the count-in plate
// and its lamps (silent counts too), the speed colour and drag, the identity row (☼, ⎍, `1 ready`,
// read-only variant, set line, hold-to-leave), the readout double-tap, announcements, and the
// unmapped "never says Bar" rule. Computed sizes are Playwright probes (tests/fixture/states/ST5.cjs).
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {createRegistry} from '../src/app/commands.js';
import {clock as appClock} from '../src/app/clock.js';
import {signal} from '../src/app/store.js';
import {createPositionModel} from '../src/stage/position.js';
import {defineTransportCommands} from '../src/stage/transport-commands.js';
import {COPY, CONTROLS, DOUBLE_TAP_MS, SECTION_FADE_MS, SPEED_DRAG_PX, countUnit, loopText, mixText, mountHud, nextText,
  plateText, positionText, sectionText, speedText} from '../src/stage/hud.js';
import {HUD_CONTROLS} from '../src/stage/hud.copy.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {installPopoverShim, pointer, restoreDomShims} from './helpers/dom.js';
import {mapStore, pickup, sectioned, sevenEight, unmapped} from './fixtures/maps.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------------------------
// helpers

/** A map and position model over a map fixture (unmapped: the 1.9 placeholder, which is not a real map). */
function model(fixture, {markers = []} = {}) {
  const map = mapStore(fixture);
  const practice = {value: signal({markers})};
  return {map, position: createPositionModel({map, practice})};
}

const MARKERS = [{id: 'm1', t: 4, label: 'Marker 1', updatedAt: 1}, {id: 'm2', t: 20, label: 'bridge?', updatedAt: 1}];
const loopSnap = (loop, extra = {}) => ({loop: {on: true, eachPassCount: true, playTimes: 0, between: 'none', role: null, ...loop}, pass: 0, passTarget: null, trainer: null, ...extra});
const track = (name, fields = {}) => ({name, volume: 1, muted: false, soloed: false, ...fields});
const mixSnap = (tracks) => ({mix: {tracks, minusMe: false, onlyMe: false, mine: ['drums']}});

/** The accessible name of an element (aria-label, else its text). */
function nameOf(el) {
  const label = el.getAttribute('aria-label');
  if (label) return label.trim();
  return el.textContent.replace(/\s+/g, ' ').trim();
}
const ROLE = {button: 'button, [role=button]', group: '[role=group]', img: '[role=img]'};
const byRole = (root, role, name, {match = 'exact'} = {}) => [...root.querySelectorAll(ROLE[role])]
  .filter((el) => !el.closest('[hidden]'))
  .find((el) => (match === 'prefix' ? nameOf(el).startsWith(name) : nameOf(el) === name)) ?? null;

const STAGE_DEFS = [
  ['stage.leave', 'Back to Library', 'App'], ['stage.notes', 'Notes', 'Practice'], ['stage.menu', 'More…', 'View'],
  ['view.focus', 'Focus (resumes Follow if paused)', 'View'], ['setlist.prev', 'Previous song in set', 'Navigate'],
  ['setlist.next', 'Next song in set', 'Navigate'],
];

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

/**
 * A mounted HUD on a real session, with the transport commands and stand-in definitions for the
 * Stage's own ids (stage.js and commands.js are ST4's): each run is recorded in `ran`.
 */
async function bed({hud: hudOptions = {}, stageCtx = {}, ...options} = {}) {
  const ts = await createTestSession({clock, ...options});
  const reg = createRegistry();
  const offTransport = defineTransportCommands({registry: reg, sheets: {}});
  const ran = [];
  const opened = [];
  const offStage = reg.registerMany(STAGE_DEFS.map(([id, title, group]) => ({id, title, group, run: (c) => { ran.push({id, args: c.args}); }})));
  const stage = {anchors: new Map(), openSheet: (name) => { opened.push(name); return {close() {}}; }, ...stageCtx};
  reg.provide('session', () => ts.session);
  reg.provide('transport', () => ts.session.transport);
  reg.provide('stage', () => stage);
  const host = document.createElement('div');
  const music = document.createElement('div');
  document.body.append(host, music);
  const statuses = [];
  const announced = [];
  const navigated = [];
  const prefValues = {};
  const ready = signal([]);
  const hud = mountHud(host, {
    session: ts.session, stage, registry: reg, plateHost: music, jobs: {ready},
    status: (text, opts) => statuses.push({text, ...opts}),
    announce: (text, opts) => announced.push({text, ...opts}),
    prefs: {get: (k) => prefValues[k]},
    navigate: (path) => navigated.push(path),
    ...hudOptions,
  });
  current.push(async () => { hud.destroy(); offStage(); offTransport(); await ts.dispose(); });
  vi.advanceTimersByTime(60);   // the registry's state recompute (50 ms) reaches the command buttons
  return {ts, reg, hud, host, music, ran, opened, stage, statuses, announced, navigated, prefValues, ready,
    q: (sel) => host.querySelector(sel), text: () => host.textContent.replace(/\s+/g, ' ')};
}

// ---------------------------------------------------------------------------------------------------------------

describe('§4.4 text rules (table)', () => {
  const mapped = model(sectioned);
  const withPickup = model(pickup);
  const bare = model(unmapped);
  const marked = model(unmapped, {markers: MARKERS});

  test.each([
    ['mapped bar 17 beat 1', mapped, 32, '17 · 1', '0:32 / 2:08'],
    ['mapped bar 17 beat 4', mapped, 33.6, '17 · 4', '0:33 / 2:08'],
    ['mapped bar 64, the last beat', mapped, 127.9, '64 · 4', '2:07 / 2:08'],
    ['inside a two-beat pickup: beats count from the bar end', withPickup, 0.6, 'Pickup · 3', '0:00 / 0:20'],
    ['the pickup\'s last beat', withPickup, 1.1, 'Pickup · 4', '0:01 / 0:20'],
    ['before the pickup (counted backwards)', withPickup, 0.1, 'Pickup · 2', '0:00 / 0:20'],
    ['bar 1 after a pickup', withPickup, 1.6, '1 · 1', '0:01 / 0:20'],
    ['unmapped: m:ss (floor), no sub', bare, 12.9, '0:12', null],
  ])('Position: %s', (_, m, t, main, sub) => {
    const p = positionText(m.position, t);
    expect(p.main).toBe(main);
    expect(p.sub).toBe(sub);
    if (main.includes(' · ')) expect(`${p.bar} · ${p.beat}`).toBe(main);
    else expect(p.beat).toBeNull();
  });

  test.each([
    ['mapped: the section', mapped, 33, 'Chorus'],
    ['mapped: a duplicate name is numbered', mapped, 70, 'Chorus 2'],
    ['mapped without sections: hidden', withPickup, 5, null],
    ['unmapped: the marker region', marked, 12, 'Marker 1'],
    ['unmapped: before the first marker, hidden', marked, 2, null],
    ['unmapped without markers: hidden', bare, 12, null],
  ])('Section: %s', (_, m, t, expected) => {
    expect(sectionText(m.position, t)).toBe(expected);
  });

  test.each([
    ['more than 2 bars: bars to go', mapped, 32, {text: 'next: Verse 2 · 8 bars', imminent: false}],
    ['3 bars to go', mapped, 42, {text: 'next: Verse 2 · 3 bars', imminent: false}],
    ['2 bars: counts down in bars · beats', mapped, 44, {text: 'Verse 2 in 1 · 4', imminent: true}],
    ['1 bar: beats only', mapped, 46, {text: 'Verse 2 in 4', imminent: true}],
    ['the last beat', mapped, 47.6, {text: 'Verse 2 in 1', imminent: true}],
    ['the last section: hidden', mapped, 120, null],
    ['mapped without sections: hidden', withPickup, 5, null],
    ['unmapped: the next marker and the time to it', marked, 12, {text: 'next: bridge? · 0:08', imminent: false}],
    ['unmapped after the last marker: hidden', marked, 25, null],
  ])('Next: %s', (_, m, t, expected) => {
    expect(nextText(m.position, t)).toEqual(expected);
  });

  test.each([
    ['75%: --ink, 90 bpm', mapped.map, {rate: 0.75}, {value: '75%', tone: 'ink', sub: '90 bpm'}],
    ['exactly 100%: --ink-3', mapped.map, {rate: 1}, {value: '100%', tone: 'ink-3', sub: '120 bpm'}],
    ['101%: --ink', mapped.map, {rate: 1.01}, {value: '101%', tone: 'ink', sub: '121 bpm'}],
    ['25% floor', mapped.map, {rate: 0.25}, {value: '25%', tone: 'ink', sub: '30 bpm'}],
    ['unmapped: no bpm', bare.map, {rate: 0.8}, {value: '80%', tone: 'ink', sub: null}],
  ])('Speed: %s', (_, map, snap, expected) => {
    expect(speedText(snap, {map, t: 10})).toEqual(expected);
  });

  test.each([
    ['a section loop', mapped.map, loopSnap({a: 32, b: 48}), {line1: 'LOOP · Chorus', line2: 'Bars 17–24', trainer: null}],
    ['with completed passes', mapped.map, loopSnap({a: 32, b: 48}, {pass: 3}), {line1: 'LOOP · Chorus', line2: 'Bars 17–24 · pass 3', trainer: null}],
    ['play N times', mapped.map, loopSnap({a: 32, b: 48, playTimes: 4}, {pass: 1, passTarget: 4}), {line1: 'LOOP · Chorus', line2: 'Bars 17–24 · pass 1 of 4', trainer: null}],
    ['call & response, listen', mapped.map, loopSnap({a: 32, b: 48, between: 'call', role: 'listen'}, {pass: 2}), {line1: 'LOOP · Chorus', line2: 'Bars 17–24 · pass 2 · listen', trainer: null}],
    ['call & response, you play', mapped.map, loopSnap({a: 32, b: 48, between: 'call', role: 'play'}), {line1: 'LOOP · Chorus', line2: 'Bars 17–24 · you play', trainer: null}],
    ['not a section', mapped.map, loopSnap({a: 34, b: 40}), {line1: 'LOOP', line2: 'Bars 18–20', trainer: null}],
    ['one bar', mapped.map, loopSnap({a: 34, b: 36}), {line1: 'LOOP', line2: 'Bar 18', trainer: null}],
    ['from the pickup', withPickup.map, loopSnap({a: 0.5, b: 3.5}), {line1: 'LOOP', line2: 'Pickup–bar 1', trainer: null}],
    ['trainer', mapped.map, loopSnap({a: 80, b: 96}, {trainer: {start: 0.7, end: 1, step: 0.05, passes: 2, stepIndex: 2, steps: 7, passInStep: 0, rate: 0.8, done: false}}),
      {line1: 'LOOP · Bridge', line2: 'Bars 41–48', trainer: 'Trainer 70 → 100% · step 3 of 7'}],
    ['trainer done', mapped.map, loopSnap({a: 80, b: 96}, {trainer: {start: 0.7, end: 1, step: 0.05, passes: 2, stepIndex: 6, steps: 7, passInStep: 0, rate: 1, done: true}}),
      {line1: 'LOOP · Bridge', line2: 'Bars 41–48', trainer: 'Trainer done — 100%'}],
    ['unmapped', bare.map, loopSnap({a: 31.2, b: 41}, {pass: 2}), {line1: 'LOOP', line2: '0:31.2–0:41.0 · pass 2', trainer: null}],
  ])('Loop: %s', (_, map, snap, expected) => {
    expect(loopText(snap, {map})).toEqual(expected);
  });

  test('Loop: hidden when off or empty', () => {
    expect(loopText(loopSnap({on: false, a: 32, b: 48}), {map: mapped.map})).toBeNull();
    expect(loopText(loopSnap({a: 0, b: 0}), {map: mapped.map})).toBeNull();
  });

  test.each([
    ['the full mix: hidden', [track('drums'), track('bass')], null],
    ['one muted stem', [track('drums', {muted: true}), track('bass')], {text: 'DRUMS OUT', kind: 'out'}],
    ['two muted stems', [track('drums', {muted: true}), track('bass', {muted: true}), track('vocals')], {text: 'DRUMS + BASS OUT', kind: 'out'}],
    ['three muted: no single word', [track('drums', {muted: true}), track('bass', {muted: true}), track('vocals', {muted: true})], {text: 'MIX', kind: 'mix'}],
    ['a solo', [track('drums'), track('bass', {soloed: true})], {text: 'BASS SOLO', kind: 'solo'}],
    ['a solo wins over mutes', [track('drums', {muted: true}), track('bass', {soloed: true})], {text: 'BASS SOLO', kind: 'solo'}],
    ['levels only', [track('drums'), track('bass', {volume: 0.5})], {text: 'MIX', kind: 'mix'}],
    ['a two-part stem', [track('vocals'), track('no_vocals', {muted: true})], {text: 'NO VOCALS OUT', kind: 'out'}],
  ])('Mix: %s', (_, tracks, expected) => {
    expect(mixText(mixSnap(tracks))).toEqual(expected);
  });

  test.each([
    ['mapped', {current: 3, of: 4, label: 'Count-in · bar 17'}, {number: '3', label: 'Count-in · bar 17'}],
    ['unmapped lead-in', {current: 2, of: 2, label: 'Lead-in · 0:31'}, {number: '2', label: 'Lead-in · 0:31'}],
    ['not counting', null, null],
  ])('Count-in plate: %s', (_, countdown, expected) => {
    expect(plateText(countdown)).toEqual(expected);
  });

  test.each([
    ['4/4 first count', {current: 4, of: 4}, {groups: [1, 1, 1, 1]}, 0],
    ['4/4 last count', {current: 1, of: 4}, {groups: [1, 1, 1, 1]}, 3],
    ['two bars of 4/4 wrap to the downbeat', {current: 4, of: 8}, {groups: [1, 1, 1, 1]}, 0],
    ['7/8 (2+2+3): the third counted beat', {current: 1, of: 3}, {groups: [2, 2, 3]}, 4],
  ])('Lamps during a count: %s', (_, countdown, bar, unit) => {
    expect(countUnit(countdown, bar)).toBe(unit);
  });

  // The counted beats end at the target: `current` counts back from it through the plan's beats.
  const plan = (...units) => units.map((unit) => ({unit}));
  test.each([
    ['"2 beats" in 4/4: beats 3 and 4', [{current: 2, of: 2}, {current: 1, of: 2}], plan(2, 3), [2, 3]],
    ['a cue on beat 3, one bar', [4, 3, 2, 1].map((current) => ({current, of: 4})), plan(2, 3, 0, 1), [2, 3, 0, 1]],
    ['a loop-gap count the gap start cut to its last two', [{current: 2, of: 2}, {current: 1, of: 2}], plan(0, 1, 2, 3), [2, 3]],
    ['7/8 (2+2+3), two counts', [{current: 2, of: 2}, {current: 1, of: 2}], plan(2, 4), [2, 4]],
  ])('Lamps follow the count-in plan: %s', (_, counts, beats, units) => {
    expect(counts.map((c) => countUnit(c, {groups: [1, 1, 1, 1]}, beats))).toEqual(units);
  });

  test('without a plan the counts run back from the downbeat (a "2 beats" count lights 3 and 4)', () => {
    expect([2, 1].map((current) => countUnit({current, of: 2}, {groups: [1, 1, 1, 1]}))).toEqual([2, 3]);
    expect([3, 2, 1].map((current) => countUnit({current, of: 3}, {groups: [2, 2, 3]}))).toEqual([0, 2, 4]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('the mounted HUD', () => {
  test('Stage semantics and the readouts of a fresh mapped session (§4.4)', async () => {
    const b = await bed({practice: {v: 2, cue: 32, rate: 1, loop: {on: false, a: 0, b: 0}, tracks: [], minusMe: false, trainer: null, spots: [], markers: []}});
    expect(b.q('h1').textContent).toBe('Glasshouse');
    expect(byRole(b.host, 'group', COPY.nowPlaying)).toBeTruthy();
    expect(b.q('.hud-section').getAttribute('aria-label')).toBe('Section');
    expect(b.q('.hud-section').textContent).toBe('Chorus');
    expect(b.q('.hud-next .ui-readout-value').textContent).toBe('next: Verse 2 · 8 bars');
    expect(b.q('.hud-next').dataset.tone).toBe('ink');
    expect(b.q('.hud-pos-bar').textContent).toBe('17');
    expect(b.q('.hud-pos-beat').textContent).toBe('1');
    expect(b.q('.hud-pos-sep').getAttribute('aria-hidden')).toBe('true');
    expect(b.q('.hud-pos-sub').textContent).toBe('0:32 / 2:08');
    expect(b.q('.hud-position').getAttribute('aria-label')).toBe('Position 17 · 1, 0:32 / 2:08');
    expect(b.q('.hud-speed .ui-readout-value').textContent).toBe('100%');
    expect(b.q('.hud-speed .ui-readout-sub').textContent).toBe('120 bpm');
    expect(b.q('.hud-loop').hidden).toBe(true);
    expect(b.q('.hud-mix').hidden).toBe(true);
    expect(b.q('.ui-beat-lamps').hidden).toBe(false);
    expect(b.q('.ui-beat-lamps').querySelectorAll('.ui-beat-lamp')).toHaveLength(4);
    expect(b.q('.ui-beat-lamp[data-state=now]')).toBeTruthy();
    expect(b.music.querySelector('.stage-count-plate').hidden).toBe(true);
    expect(b.q('.stage-count-plate')).toBeNull();
    // The plate overlays the music host, not the HUD.
    expect(b.music.querySelector('.stage-count-plate')).toBeTruthy();
    // The cover carries the shared view-transition name (the Library → Stage transition).
    expect(b.hud.cover.style.getPropertyValue('view-transition-name')).toBe(`cover-${b.ts.id}`);
  });

  test('the speed value is --ink-3 at exactly 100% and --ink otherwise', async () => {
    const b = await bed();
    const speed = b.q('.hud-speed');
    expect(speed.dataset.tone).toBe('ink-3');
    b.ts.transport.setSpeed(0.75);
    await settle();
    expect(speed.dataset.tone).toBe('ink');
    expect(speed.querySelector('.ui-readout-value').textContent).toBe('75%');
    expect(speed.querySelector('.ui-readout-sub').textContent).toBe('90 bpm');
    b.ts.transport.setSpeed(1);
    await settle();
    expect(speed.dataset.tone).toBe('ink-3');
  });

  test('a section change crossfades over 160 ms (two layers; the old one leaves and is cleared)', async () => {
    const b = await bed();
    const layers = () => [...b.host.querySelectorAll('.hud-section-layer')];
    expect(layers().map((l) => l.textContent)).toEqual(['Intro', '']);
    b.ts.transport.cue(48);
    await settle();
    const [a, c] = layers();
    expect(c.textContent).toBe('Verse 2');
    expect(c.dataset.state).toBe('in');
    expect(c.hasAttribute('aria-hidden')).toBe(false);
    expect(a.textContent).toBe('Intro');
    expect(a.dataset.state).toBe('out');
    expect(a.getAttribute('aria-hidden')).toBe('true');
    vi.advanceTimersByTime(SECTION_FADE_MS - 1);
    expect(a.textContent).toBe('Intro');
    vi.advanceTimersByTime(1);
    expect(a.textContent).toBe('');
    expect(a.hasAttribute('data-state')).toBe(false);
    expect(c.hasAttribute('data-state')).toBe(false);
    // The crossfade uses the 160 ms motion token, so reduced motion makes it instant.
    const css = readFileSync(join(ROOT, 'src/styles/views/stage/hud.css'), 'utf8');
    expect(css).toMatch(/\[data-state=in\][^}]*var\(--motion-enter\)/);
    expect(SECTION_FADE_MS).toBe(160);
  });

  test('text repaints from the frame bus at ≤ 30 Hz, the lamps at 60 Hz', async () => {
    const ts = await createTestSession({clock});
    const calls = [];
    const real = ts.session.frame.subscribe.bind(ts.session.frame);
    ts.session.frame.subscribe = (fn, opts) => { calls.push(opts?.hz); return real(fn, opts); };
    const reg = createRegistry();
    defineTransportCommands({registry: reg, sheets: {}});
    const host = document.body.appendChild(document.createElement('div'));
    const hud = mountHud(host, {session: ts.session, registry: reg, jobs: {ready: signal([])}, announce: () => {}});
    current.push(async () => { hud.destroy(); await ts.dispose(); });
    expect(calls.sort()).toEqual([30, 60]);

    // Playing: the frames move the position and the lit lamp.
    ts.session.frame.start();
    await ts.play();
    await ts.advance(1.1);
    const pos = () => `${host.querySelector('.hud-pos-bar').textContent} · ${host.querySelector('.hud-pos-beat').textContent}`;
    expect(pos()).toMatch(/^1 · [23]$/);
    const lit = [...host.querySelectorAll('.ui-beat-lamp')].findIndex((d) => d.dataset.state === 'now');
    expect(lit).toBeGreaterThan(0);
    await ts.advance(2);
    expect(pos()).toMatch(/^2 · /);
  });

  test('the count-in plate counts down over the music, the lamps count with it (a silent count too), announced once', async () => {
    const b = await bed({practice: {v: 2, cue: 32, rate: 1, loop: {on: false, a: 0, b: 0}, tracks: [], minusMe: false, trainer: null, spots: [], markers: [],
      click: {countIn: {on: true, length: 1, unit: 'bars'}, mode: 'off', accent: true, volume: 0.7, preRoll: false}}});
    b.ts.session.frame.start();
    await b.ts.play();
    expect(b.ts.snapshot.phase).toBe('counting');
    const plate = b.music.querySelector('.stage-count-plate');
    expect(plate.hidden).toBe(false);
    expect(plate.getAttribute('aria-hidden')).toBe('true');
    expect(plate.querySelector('.stage-count-label').textContent).toBe('Count-in · bar 17');
    const first = plate.querySelector('.stage-count-number').textContent;
    expect(first).toBe('4');
    const litUnit = () => [...b.host.querySelectorAll('.ui-beat-lamp')].findIndex((d) => d.dataset.state === 'now');
    expect(litUnit()).toBe(0);
    expect(b.host.querySelector('.hud').hasAttribute('data-playing')).toBe(true);
    await b.ts.advance(0.6);
    expect(plate.querySelector('.stage-count-number').textContent).toBe('3');
    expect(litUnit()).toBe(1);
    await b.ts.advance(0.5);
    expect(plate.querySelector('.stage-count-number').textContent).toBe('2');
    expect(litUnit()).toBe(2);
    expect(b.announced.filter((a) => a.key === 'stage-count-in')).toEqual([{text: 'Count-in · bar 17', key: 'stage-count-in'}]);
    await b.ts.advance(1.2);
    expect(b.ts.snapshot.phase).toBe('playing');
    expect(plate.hidden).toBe(true);
  });

  test.each([
    ['"2 beats" from a downbeat (bar 17)', 32, {length: 2, unit: 'beats'}],
    ['one bar from beat 3 (a mid-bar cue)', 33, {length: 1, unit: 'bars'}],
  ])('during a count-in the lamps light the counted beats\' own units: %s', async (_, cue, length) => {
    const b = await bed({practice: {v: 2, cue, rate: 1, loop: {on: false, a: 0, b: 0}, tracks: [], minusMe: false, trainer: null, spots: [], markers: [],
      click: {countIn: {on: true, ...length}, mode: 'off', accent: true, volume: 0.7, preRoll: false}}});
    const expected = b.ts.session.metronome.countInPlanAt(cue).beats.map((x) => x.unit);
    b.ts.session.frame.start();
    await b.ts.play();
    expect(b.ts.snapshot.phase).toBe('counting');
    const litUnit = () => [...b.host.querySelectorAll('.ui-beat-lamp')].findIndex((d) => d.dataset.state === 'now');
    const seen = new Map();   // current → the lit lamp
    for (let i = 0; i < 60 && b.ts.snapshot.phase === 'counting'; i++) {
      const c = b.ts.snapshot.countdown;
      if (c && !seen.has(c.current)) seen.set(c.current, litUnit());
      await b.ts.advance(0.05);
    }
    expect([...seen.keys()]).toEqual(expected.map((_, i) => expected.length - i));
    expect([...seen.values()]).toEqual(expected);
    expect(expected).toEqual(cue === 32 ? [2, 3] : [2, 3, 0, 1]);   // not 0, 1, … from the first count
  });

  test('a loop-gap count (each pass, a loop from beat 3) lights the counted beats\' own units', async () => {
    const b = await bed({practice: {v: 2, cue: 33, rate: 1, loop: {on: true, a: 33, b: 37, eachPassCount: true, playTimes: 0, between: 'none'},
      tracks: [], minusMe: false, trainer: null, spots: [], markers: [],
      click: {countIn: {on: true, length: 1, unit: 'bars'}, mode: 'off', accent: true, volume: 0.7, preRoll: false}}});
    const expected = b.ts.session.metronome.countInPlanAt(33).beats.map((x) => x.unit);
    expect(expected).toEqual([2, 3, 0, 1]);
    b.ts.session.frame.start();
    await b.ts.play();
    const litUnit = () => [...b.host.querySelectorAll('.ui-beat-lamp')].findIndex((d) => d.dataset.state === 'now');
    // Past the first count-in and the first pass, into the gap before the second.
    for (let i = 0; i < 200 && (b.ts.snapshot.phase === 'counting' || !b.ts.snapshot.countdown); i++) await b.ts.advance(0.05);
    expect(b.ts.snapshot.phase).toBe('playing');
    const seen = new Map();
    for (let i = 0; i < 60 && b.ts.snapshot.countdown; i++) {
      const c = b.ts.snapshot.countdown;
      if (!seen.has(c.current)) seen.set(c.current, litUnit());
      await b.ts.advance(0.05);
    }
    expect([...seen.keys()]).toEqual([4, 3, 2, 1]);
    expect([...seen.values()]).toEqual(expected);
  });

  test('dragging the speed value changes it ±1% per 12 px with pointer capture, as one undo step', async () => {
    const b = await bed();
    const speed = b.q('.hud-speed');
    const captured = [];
    speed.setPointerCapture = (id) => captured.push(id);
    speed.releasePointerCapture = () => {};
    pointer(speed, 'pointerdown', {y: 200, pointerId: 7});
    expect(captured).toEqual([7]);
    pointer(speed, 'pointermove', {y: 200 - SPEED_DRAG_PX, pointerId: 7});
    expect(b.ts.snapshot.rate).toBe(1.01);
    vi.advanceTimersByTime(300);
    pointer(speed, 'pointermove', {y: 200 - 3 * SPEED_DRAG_PX - 5, pointerId: 7});
    expect(b.ts.snapshot.rate).toBe(1.03);
    vi.advanceTimersByTime(300);
    pointer(speed, 'pointermove', {y: 200 + 2 * SPEED_DRAG_PX, pointerId: 7});
    expect(b.ts.snapshot.rate).toBe(0.98);
    pointer(speed, 'pointerup', {y: 200 + 2 * SPEED_DRAG_PX, pointerId: 7});
    await settle();
    expect(b.ts.undo.size.undo).toBe(1);
    b.ts.undo.undo();
    await settle();
    expect(b.ts.snapshot.rate).toBe(1);
    // A drag never counts as a tap on the readouts (no Focus).
    expect(b.ran.map((r) => r.id)).not.toContain('view.focus');
  });

  test('☼ and ⎍ follow the wake-lock and pedal-mode signals', async () => {
    const wake = signal(false), pedal = signal(false);
    const b = await bed({hud: {wake, pedal}});
    expect(byRole(b.host, 'img', COPY.wake)).toBeNull();
    wake.value = true;
    expect(byRole(b.host, 'img', COPY.wake)).toBeTruthy();
    pedal.value = true;
    expect(byRole(b.host, 'img', COPY.pedal)).toBeTruthy();
    wake.value = false;
    expect(byRole(b.host, 'img', COPY.wake)).toBeNull();
  });

  test('the stage context\'s wakeHeld signal drives ☼ when no wake signal is passed', async () => {
    const wakeHeld = signal(true);
    const b = await bed({stageCtx: {wakeHeld}});
    expect(byRole(b.host, 'img', COPY.wake)).toBeTruthy();
  });

  test('the `1 ready` chip reads jobsModel.ready, skips the open song and opens a ready one', async () => {
    const b = await bed();
    expect(byRole(b.host, 'button', '1 ready')).toBeNull();
    b.ready.value = [{id: b.ts.id, title: 'Glasshouse'}];
    expect(b.q('.hud-ready').hidden).toBe(true);
    b.ready.value = [{id: b.ts.id, title: 'Glasshouse'}, {id: 'lowtide', title: 'Low Tide'}];
    const chip = byRole(b.host, 'button', '1 ready');
    expect(chip).toBeTruthy();
    chip.click();
    const item = [...document.querySelectorAll('[role=menuitem]')].find((el) => el.textContent.includes('Open Low Tide'));
    expect(item).toBeTruthy();
    item.click();
    vi.advanceTimersByTime(10);
    expect(b.navigated).toEqual(['/s/lowtide']);
    b.ready.value = [{id: 'a', title: 'A'}, {id: 'b', title: 'B'}];
    expect(byRole(b.host, 'button', '2 ready')).toBeTruthy();
  });

  test('‹ leaves at once when stopped and needs a 600 ms hold while playing (a tap shows the hint)', async () => {
    const b = await bed();
    const back = byRole(b.host, 'button', COPY.back);
    expect(back).toBeTruthy();
    back.click();
    expect(b.ran.map((r) => r.id)).toEqual(['stage.leave']);
    await b.ts.play();
    pointer(back, 'pointerdown', {pointerId: 3});
    vi.advanceTimersByTime(200);
    pointer(back, 'pointerup', {pointerId: 3});
    back.click();
    expect(b.statuses.map((s) => s.text)).toEqual([COPY.holdToLeave]);
    expect(b.ran).toHaveLength(1);
    pointer(back, 'pointerdown', {pointerId: 4});
    vi.advanceTimersByTime(600);
    expect(b.ran.map((r) => r.id)).toEqual(['stage.leave', 'stage.leave']);
  });

  test('a tap while playing uses the Stage\'s own hint when it has one', async () => {
    const hints = [];
    const b = await bed({stageCtx: {leaveHint: () => hints.push('hint')}});
    await b.ts.play();
    byRole(b.host, 'button', COPY.back).click();
    expect(hints).toEqual(['hint']);
    expect(b.statuses).toEqual([]);
  });

  test('double-tapping the readouts runs view.focus; single taps do nothing', async () => {
    const b = await bed();
    const readouts = b.q('.hud-readouts');
    const tapAt = (x, y) => { pointer(readouts, 'pointerdown', {x, y}); pointer(readouts, 'pointerup', {x, y}); };
    tapAt(10, 10);
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 50);
    tapAt(10, 10);
    expect(b.ran).toEqual([]);
    vi.advanceTimersByTime(100);
    tapAt(12, 11);
    expect(b.ran.map((r) => r.id)).toEqual(['view.focus']);
  });

  test('a speed drag that ends in pointercancel does not eat the next tap (the next double-tap still focuses)', async () => {
    const b = await bed();
    const speed = b.q('.hud-speed');
    const readouts = b.q('.hud-readouts');
    speed.setPointerCapture = () => {};
    speed.releasePointerCapture = () => {};
    pointer(speed, 'pointerdown', {y: 200, pointerId: 7});
    pointer(speed, 'pointermove', {y: 200 - 2 * SPEED_DRAG_PX, pointerId: 7});
    pointer(speed, 'pointercancel', {y: 200 - 2 * SPEED_DRAG_PX, pointerId: 7});
    expect(b.ts.snapshot.rate).toBe(1.02);
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 50);
    const tapAt = (x, y) => { pointer(readouts, 'pointerdown', {x, y}); pointer(readouts, 'pointerup', {x, y}); };
    tapAt(10, 10);
    vi.advanceTimersByTime(100);
    tapAt(10, 10);
    expect(b.ran.map((r) => r.id)).toEqual(['view.focus']);
  });

  test('a completed speed drag is not a tap on the readouts (no Focus from drag + tap)', async () => {
    const b = await bed();
    const speed = b.q('.hud-speed');
    speed.setPointerCapture = () => {};
    speed.releasePointerCapture = () => {};
    pointer(speed, 'pointerdown', {x: 10, y: 200, pointerId: 7});
    pointer(speed, 'pointermove', {x: 10, y: 200 - 2 * SPEED_DRAG_PX, pointerId: 7});
    pointer(speed, 'pointerup', {x: 10, y: 200 - 2 * SPEED_DRAG_PX, pointerId: 7});
    vi.advanceTimersByTime(100);
    const readouts = b.q('.hud-readouts');
    pointer(readouts, 'pointerdown', {x: 10, y: 176});
    pointer(readouts, 'pointerup', {x: 10, y: 176});
    expect(b.ran.map((r) => r.id)).toEqual([]);
  });

  test('the Loop line shows the loop and opens the Loop card (loop.card)', async () => {
    const b = await bed({practice: {v: 2, cue: 32, rate: 0.75, loop: {on: true, a: 32, b: 48}, tracks: [{name: 'drums', volume: 1, muted: true, soloed: false}],
      minusMe: true, trainer: null, spots: [], markers: []}});
    const loop = byRole(b.host, 'button', 'LOOP', {match: 'prefix'});
    expect(loop.querySelector('.hud-loop-line1').textContent).toBe('LOOP · Chorus');
    expect(loop.querySelector('.hud-loop-line2').textContent).toBe('Bars 17–24');
    loop.click();
    expect(b.opened).toEqual(['loop']);
    expect(b.q('.hud-mix').hidden).toBe(false);
    expect(b.q('.hud-mix-word').textContent).toBe('DRUMS OUT');
    expect(b.q('.hud-mix').dataset.kind).toBe('out');
  });

  test('read-only (shared): "Shared by …" and the action slot SH1 fills', async () => {
    const b = await bed({shared: {token: 't-1'}, song: {ownerName: 'Kyle K.'}});
    expect(b.ts.session.readOnly).toBe(true);
    expect(b.q('.hud-shared').hidden).toBe(false);
    expect(b.q('.hud-shared').textContent).toBe('Shared by Kyle K.');
    expect(b.hud.actionSlot.hidden).toBe(false);
    b.hud.actionSlot.append(Object.assign(document.createElement('button'), {textContent: 'Add to my library'}));
    expect(byRole(b.host, 'button', 'Add to my library')).toBeTruthy();
    expect(b.q('.hud').hasAttribute('data-read-only')).toBe(true);
  });

  test('the owner\'s identity row has no shared line; key and tuning chips only when set', async () => {
    const b = await bed({song: {musicalKey: 'E minor', tuning: ''}});
    expect(b.q('.hud-shared').hidden).toBe(true);
    expect(b.hud.actionSlot.hidden).toBe(true);
    const chips = [...b.host.querySelectorAll('.hud-meta .ui-chip')];
    expect(chips.filter((c) => !c.hidden).map((c) => c.textContent)).toEqual(['E minor']);
  });

  test('the set line: name, position in the set, the next song, and setlist.prev / setlist.next', async () => {
    const setlist = signal(null);
    const b = await bed({hud: {setlist}});
    expect(b.q('.hud-set').hidden).toBe(true);
    setlist.value = {id: 'set-1', name: 'Friday gig', index: 1, count: 5, prev: {id: 'a', title: 'A'}, next: {id: 'b', title: 'Second Wind'}};
    expect(b.q('.hud-set').hidden).toBe(false);
    expect(b.q('.hud-set-text').textContent).toBe('Friday gig · 2 of 5 · next: Second Wind');
    byRole(b.host, 'button', COPY.setNextLabel).click();
    byRole(b.host, 'button', COPY.setPrev).click();
    expect(b.ran.map((r) => r.id)).toEqual(['setlist.next', 'setlist.prev']);
  });

  test('trainer steps are announced; sections only when Announce sections is on', async () => {
    const b = await bed({practice: {v: 2, cue: 32, rate: 1, loop: {on: true, a: 32, b: 34}, tracks: [], minusMe: false,
      trainer: {start: 0.7, end: 0.8, step: 0.05, passes: 1}, spots: [], markers: []}});
    b.ts.session.frame.start();
    b.ts.transport.startTrainer();
    await b.ts.play();
    await b.ts.advance(3.2);
    const trainer = b.announced.filter((a) => a.key === 'stage-trainer').map((a) => a.text);
    expect(trainer[0]).toBe('Trainer 70 → 80% · step 2 of 3');
    expect(b.announced.some((a) => a.key === 'stage-section')).toBe(false);
  });

  test('a section change while playing is announced when the device pref is on', async () => {
    const b = await bed({practice: {v: 2, cue: 46, rate: 1, loop: {on: false, a: 0, b: 0}, tracks: [], minusMe: false, trainer: null, spots: [], markers: []}});
    b.prefValues['practice.announceSections'] = true;
    b.ts.session.frame.start();
    await b.ts.play();
    await b.ts.advance(2.5);
    expect(b.announced.filter((a) => a.key === 'stage-section').map((a) => a.text)).toEqual(['Verse 2']);
  });

  test('setLayout and setFocus set the attributes the CSS arranges; the mini rail uses small lamps', async () => {
    const b = await bed();
    const root = b.q('.hud');
    expect(root.dataset.layout).toBe('band');
    b.hud.setLayout('rail');
    expect(root.dataset.layout).toBe('rail');
    expect(b.q('.ui-beat-lamps').dataset.size).toBe('md');
    b.hud.setFocus(true);
    expect(root.hasAttribute('data-focus')).toBe(true);
    expect(b.q('.ui-beat-lamps').dataset.size).toBe('sm');
    b.hud.setLayout('band');
    expect(b.q('.ui-beat-lamps').dataset.size).toBe('md');
  });

  test('while playing the identity row dims to 40% (CSS) and the readouts stay at 100%', async () => {
    const b = await bed();
    await b.ts.play();
    expect(b.q('.hud').hasAttribute('data-playing')).toBe(true);
    const css = readFileSync(join(ROOT, 'src/styles/views/stage/hud.css'), 'utf8');
    expect(css).toMatch(/\.hud\[data-playing\] \.hud-identity \{ opacity: \.4; \}/);
    expect(css).not.toMatch(/\.hud\[data-playing\] \.hud-readouts[^{]*\{[^}]*opacity/);
    b.ts.transport.stop();
    await settle();
    expect(b.q('.hud').hasAttribute('data-playing')).toBe(false);
  });

  test('7/8 (2+2+3): seven lamps in three groups (D15)', async () => {
    const b = await bed({tempo: structuredClone(sevenEight.tempo), duration: sevenEight.duration});
    const lamps = b.q('.ui-beat-lamps');
    expect(lamps.querySelectorAll('.ui-beat-lamp')).toHaveLength(7);
    expect(lamps.querySelectorAll('.ui-beat-lamps-group')).toHaveLength(3);
    expect(lamps.querySelector('[data-kind=downbeat]')).toBeTruthy();
  });

  test('the ⋯ button is the menu\'s anchor while mounted; destroy removes the HUD and the plate and stops painting', async () => {
    const b = await bed();
    expect(b.stage.anchors.get('menu')).toBe(byRole(b.host, 'button', COPY.more));
    expect(b.host.querySelector('[data-anchor]')).toBeNull();
    b.hud.destroy();
    expect(b.stage.anchors.has('menu')).toBe(false);
    expect(b.host.children).toHaveLength(0);
    expect(b.music.querySelector('.stage-count-plate')).toBeNull();
    b.ts.transport.cue(48);
    await settle();
    expect(b.host.textContent).toBe('');
  });

  test('the HUD renders no status line of its own (the Stage frame\'s role=status line is the only one)', async () => {
    const b = await bed();
    expect(b.host.querySelector('[role=status], [aria-live]')).toBeNull();
    expect(b.music.querySelector('[role=status]')).toBeNull();
  });

  test('destroy removes the menu anchor from a map whose get() skips detached nodes (stage.js\'s AnchorMap)', async () => {
    class AnchorMap extends Map {
      constructor(fallback) { super(); this.fallback = fallback; }
      get(name) { const own = super.get(name); return own?.isConnected ? own : this.fallback; }
    }
    const anchors = new AnchorMap(document.createElement('div'));
    const b = await bed({stageCtx: {anchors}});
    expect(Map.prototype.get.call(anchors, 'menu')).toBe(byRole(b.host, 'button', COPY.more));
    b.host.remove();   // the Stage frame went first
    b.hud.destroy();
    expect(anchors.size).toBe(0);
  });
});

describe('an unmapped song never says "Bar" (§2.14.4, §10.4)', () => {
  test('stopped, with markers, a loop, a count and playing', async () => {
    const b = await bed({mapped: false, duration: 60, practice: {v: 2, cue: 12, rate: 0.8, loop: {on: true, a: 10, b: 24}, tracks: [], minusMe: false,
      trainer: null, spots: [], markers: MARKERS, click: {countIn: {on: true, length: 1, unit: 'bars'}, mode: 'countin', accent: true, volume: 0.7, preRoll: false}}});
    const scan = () => {
      const text = `${b.host.textContent} ${b.music.textContent}`;
      expect(text).not.toMatch(/Bar|bar /);
    };
    expect(b.q('.ui-beat-lamps').hidden).toBe(true);
    expect(b.q('.hud-pos-sub').hidden).toBe(true);
    expect(b.q('.hud-section').textContent).toBe('Marker 1');
    expect(b.q('.hud-loop-line2').textContent).toBe('0:10.0–0:24.0');
    scan();
    b.ts.session.frame.start();
    await b.ts.play();
    expect(b.ts.snapshot.phase).toBe('counting');
    expect(b.music.querySelector('.stage-count-label').textContent).toBe('Lead-in · 0:10');
    scan();
    await b.ts.advance(3);
    scan();
  });
});

describe('controls table (HUD_CONTROLS)', () => {
  test('every row renders with its role and accessible name and runs its command', async () => {
    const setlist = signal({id: 's', name: 'Set', index: 0, count: 2, prev: null, next: {id: 'x', title: 'X'}});
    const b = await bed({hud: {setlist}, practice: {v: 2, cue: 32, rate: 1, loop: {on: true, a: 32, b: 48}, tracks: [], minusMe: false, trainer: null, spots: [], markers: []}});
    b.ready.value = [{id: 'lowtide', title: 'Low Tide'}];
    expect(CONTROLS).toBe(HUD_CONTROLS);
    for (const row of HUD_CONTROLS) {
      const el = byRole(b.host, row.role, row.name, {match: row.match});
      expect(el, row.name).toBeTruthy();
      if (row.command === 'loop.card') continue;   // checked above (the Stage opens the sheet)
      if (!row.command) continue;
      el.click();
      expect(b.ran.map((r) => r.id), row.name).toContain(row.command);
    }
  });
});
