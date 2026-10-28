// @vitest-environment happy-dom
// The Stage control set (src/stage/controls.js; architecture §2.14.10, spec §4.6, D14): CONTROL_SET,
// the dock / rail / mini / slim renderings as a table (role, accessible name, command), Play's
// loading ring, "Play when ready" and `✕ Count`, long-press and the Mix ⌃ zone, Count-in and Click
// per D14 (mapped and unmapped), the Speed stepper, anchors and the playing dim. Sizes (the 700 px
// dock, 56/72 px rail rows) are Playwright probes on the HUD harness (tests/fixture/states/ST5.cjs).
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {createRegistry} from '../src/app/commands.js';
import {clock as appClock} from '../src/app/clock.js';
import {defineTransportCommands} from '../src/stage/transport-commands.js';
import {CONTROLS, CONTROL_SET, COPY, LAYOUT, LONG_PRESS_MS, VARIANTS, countInState, mixState, mountControls, playState} from '../src/stage/controls.js';
import {CONTROL_ROWS} from '../src/stage/hud.copy.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {installPopoverShim, pointer, restoreDomShims} from './helpers/dom.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function nameOf(el) {
  const label = el.getAttribute('aria-label');
  if (label) return label.trim();
  const text = el.querySelector?.('.ui-button-text');
  return (text ?? el).textContent.replace(/\s+/g, ' ').trim();
}
const SELECTOR = {button: 'button, [role=button]', spinbutton: '[role=spinbutton]', toolbar: '[role=toolbar]'};
const byRole = (root, role, name, {match = 'exact'} = {}) => [...root.querySelectorAll(SELECTOR[role])]
  .find((el) => (match === 'prefix' ? nameOf(el).startsWith(name) : nameOf(el) === name)) ?? null;

const FRESH = (fields = {}) => ({v: 2, cue: 32, rate: 1, loop: {on: false, a: 0, b: 0}, tracks: [], minusMe: false, trainer: null, spots: [], markers: [], ...fields});

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

/** Controls on a real session with the transport commands and a recording Stage sheet host. */
async function bed({variant = 'dock', stage: withStage = true, ...options} = {}) {
  const ts = await createTestSession({clock, ...options});
  const reg = createRegistry();
  const off = defineTransportCommands({registry: reg, sheets: {}});
  const opened = [];
  const anchors = new Map();
  const stage = {anchors, openSheet: (name, {anchor} = {}) => { opened.push({name, anchor}); return {close() {}}; }};
  reg.provide('session', () => ts.session);
  reg.provide('transport', () => ts.session.transport);
  if (withStage) reg.provide('stage', () => stage);
  const runs = [];
  const run = reg.run;
  reg.run = (id, opts) => { runs.push(id); return run(id, opts); };
  const host = document.body.appendChild(document.createElement('div'));
  const controls = mountControls(host, {session: ts.session, variant, stage: withStage ? stage : null, registry: reg});
  current.push(async () => { controls.destroy(); off(); await ts.dispose(); });
  vi.advanceTimersByTime(60);   // the registry recompute reaches the command buttons
  return {ts, reg, host, controls, opened, anchors, runs, q: (s) => host.querySelector(s), all: (s) => [...host.querySelectorAll(s)]};
}

const longPress = (el) => {
  pointer(el, 'pointerdown', {pointerType: 'touch', pointerId: 9});
  vi.advanceTimersByTime(LONG_PRESS_MS);
  pointer(el, 'pointerup', {pointerType: 'touch', pointerId: 9});
  el.click();   // the click a long-press leaves behind is swallowed
};

// ---------------------------------------------------------------------------------------------------------------

describe('CONTROL_SET (§2.14.10)', () => {
  test('is the contract\'s table, row for row', () => {
    expect(CONTROL_SET.map((r) => ({...r}))).toEqual([
      {id: 'again', command: 'transport.again'},
      {id: 'play', command: 'transport.playStop', longPress: 'transport.pause'},
      {id: 'loop', command: 'transport.loopToggle', longPress: 'loop.card'},
      {id: 'speed', kind: 'stepper', dec: 'speed.down', inc: 'speed.up', value: 'speed.sheet', valueLongPress: 'speed.toggle100'},
      {id: 'countIn', command: 'click.countIn', longPress: 'click.sheet'},
      {id: 'click', command: 'click.toggle', longPress: 'click.sheet', variants: ['rail', 'slim']},
      {id: 'mix', command: 'mix.minusMe', caret: 'mix.sheet', longPress: 'mix.sheet'},
      {id: 'pause', command: 'transport.pause', variants: ['slim']},
    ]);
  });

  test('every command it names is a §3.1 transport command', () => {
    const reg = createRegistry();
    defineTransportCommands({registry: reg, sheets: {}});
    const ids = CONTROL_SET.flatMap((r) => ['command', 'longPress', 'dec', 'inc', 'value', 'valueLongPress', 'caret'].map((k) => r[k]).filter(Boolean));
    for (const id of ids) expect(reg.get(id), id).toBeTruthy();
    for (const row of CONTROLS) expect(reg.get(row.command), row.command).toBeTruthy();
  });

  test('variant rows: only `variants` limits a row; the dock has no Click and only slim has Pause', () => {
    expect(LAYOUT.dock).toEqual(['again', 'play', 'loop', 'speed', 'countIn', 'mix']);
    expect(LAYOUT.rail).toEqual(['speed', 'countIn', 'click', 'loop', 'mix', 'again', 'play']);
    expect(LAYOUT.mini).toEqual(['speed', 'play']);
    for (const v of VARIANTS) {
      for (const id of LAYOUT[v]) {
        const row = CONTROL_SET.find((r) => r.id === id);
        if (row?.variants) expect(row.variants, `${id} in ${v}`).toContain(v);
      }
    }
  });
});

describe('the renderings (table)', () => {
  test.each(VARIANTS)('%s: every row has its role and accessible name and runs its command', async (variant) => {
    const b = await bed({variant, practice: FRESH()});
    expect(b.q('[role=toolbar]').getAttribute('aria-label')).toBe('Transport');
    expect(b.all('.ctl').map((el) => el.dataset.ctl)).toEqual(LAYOUT[variant]);
    for (const row of CONTROL_ROWS.filter((r) => r.variant === variant)) {
      const el = byRole(b.host, row.role, row.name, {match: row.match});
      expect(el, `${variant}: ${row.role} "${row.name}"`).toBeTruthy();
      b.runs.length = 0;
      if (row.role === 'spinbutton') el.click();
      else if (el.classList.contains('ui-stepper-button')) el.click();
      else el.click();
      await settle();
      expect(b.runs, `${variant}: ${row.name}`).toContain(row.command);
      // Stop what a click started (Again and Play), so later rows see a stopped transport.
      if (b.ts.snapshot.phase !== 'stopped') { b.ts.transport.stop(); await settle(); }
    }
  });
});

describe('Play', () => {
  test.each([
    ['stopped', {phase: 'stopped'}, {phase: 'ready'}, {mode: 'stopped', icon: 'play', label: 'Play', name: 'Play'}],
    ['playing', {phase: 'playing'}, {phase: 'ready'}, {mode: 'playing', icon: 'square', label: 'Stop', name: 'Stop'}],
    ['counting: ✕ Count', {phase: 'counting'}, {phase: 'ready'}, {mode: 'counting', icon: 'x', label: 'Count', name: 'Cancel count-in'}],
    ['paused', {phase: 'paused'}, {phase: 'ready'}, {mode: 'stopped', icon: 'play', label: 'Play', name: 'Play'}],
    ['signing', {phase: 'loading'}, {phase: 'signing'}, {mode: 'loading', label: 'Loading', sublabel: null, name: 'Loading…', ring: null}],
    ['loading 62%', {phase: 'loading'}, {phase: 'loading', loadedBytes: 62, totalBytes: 100}, {mode: 'loading', label: 'Loading', sublabel: '62%', name: 'Loading 62%', ring: 0.62}],
    ['decoding 3 of 4', {phase: 'loading'}, {phase: 'decoding', decoded: 2, tracks: 4}, {mode: 'loading', label: 'Decoding', sublabel: '3 of 4', name: 'Decoding 3 of 4', ring: 0.5}],
    ['preparing', {phase: 'loading'}, {phase: 'preparing', decoded: 4, tracks: 4}, {mode: 'loading', label: 'Preparing', sublabel: null, name: 'Preparing pitch-preserving playback', ring: null}],
    ['armed', {phase: 'loading', armed: true}, {phase: 'loading', loadedBytes: 1, totalBytes: 4}, {mode: 'loading', label: 'Loading', name: 'Loading 25% · Play when ready', armed: true}],
    ['load error', {phase: 'loading'}, {phase: 'error', error: {kind: 'storage'}}, {mode: 'error', reason: COPY.loadError}],
  ])('playState: %s', (_, snap, load, expected) => {
    expect(playState(snap, load)).toMatchObject(expected);
  });

  test('reads ✕ Count while counting, Stop while playing, and Play again after', async () => {
    const b = await bed({practice: FRESH({click: {countIn: {on: true, length: 1, unit: 'bars'}, mode: 'countin', accent: true, volume: 0.7, preRoll: false}})});
    const play = () => b.q('[data-ctl=play] button');
    expect(nameOf(play())).toBe('Play');
    play().click();
    await settle();
    expect(b.ts.snapshot.phase).toBe('counting');
    expect(play().getAttribute('aria-label')).toBe('Cancel count-in');
    expect(play().querySelector('.ui-button-label').textContent).toBe('Count');
    expect(play().querySelector('use').getAttribute('href')).toBe('#i-x');
    expect(play().dataset.mode).toBe('counting');
    await b.ts.advance(2.2);
    expect(b.ts.snapshot.phase).toBe('playing');
    expect(nameOf(play())).toBe('Stop');
    expect(play().querySelector('use').getAttribute('href')).toBe('#i-square');
    play().click();
    await settle();
    expect(nameOf(play())).toBe('Play');
  });

  test('while audio loads Play shows the ring and arms "Play when ready"; it starts on load', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const b = await bed({load: false, media: {signKeys: async (keys) => { await gate; return Object.fromEntries(keys.map((k) => [k, `https://stems.invalid/${k}`])); }}});
    const play = b.q('[data-ctl=play] button');
    expect(play.dataset.mode).toBe('loading');
    expect(play.querySelector('.ctl-ring').hidden).toBe(false);
    expect(play.getAttribute('aria-label')).toBe('Loading…');
    play.click();
    await settle();
    expect(b.ts.snapshot.armed).toBe(true);
    expect(play.hasAttribute('data-armed')).toBe(true);
    expect(play.getAttribute('aria-label')).toBe('Loading… · Play when ready');
    release();
    await b.ts.ready();
    await settle();
    expect(['counting', 'playing']).toContain(b.ts.snapshot.phase);
    expect(play.querySelector('.ctl-ring').hidden).toBe(true);
  });

  test('a load error disables Play with the reason (described, shown in the music area by the Stage)', async () => {
    const b = await bed({media: {signKeys: async () => { throw new Error('storage down'); }}});
    expect(b.ts.session.load.peek().phase).toBe('error');
    const play = b.q('[data-ctl=play] button');
    expect(play.getAttribute('aria-disabled')).toBe('true');
    const reason = document.getElementById(play.getAttribute('aria-describedby'));
    expect(reason.textContent).toBe(COPY.loadError);
    play.click();
    await settle();
    expect(b.ts.snapshot.armed).toBe(false);
  });

  test('long-press Play pauses; long-press again continues', async () => {
    const b = await bed({practice: FRESH()});
    const play = b.q('[data-ctl=play] button');
    play.click();
    await settle();
    expect(b.ts.snapshot.phase).toBe('playing');
    longPress(play);
    await settle();
    expect(b.ts.snapshot.phase).toBe('paused');
    expect(b.runs).toContain('transport.pause');
  });
});

describe('long-press, right-click and the ⌃ zone', () => {
  test.each([
    ['Loop', '[data-ctl=loop] button', 'loop.card', 'loop'],
    ['Count-in', '[data-ctl=countIn] button', 'click.sheet', 'click'],
    ['Mix main zone', '.ctl-mix-main', 'mix.sheet', 'mix'],
  ])('%s: a 500 ms long-press runs %s', async (_, selector, command, sheet) => {
    const b = await bed({practice: FRESH()});
    const el = b.q(selector);
    const before = JSON.stringify(b.ts.snapshot);
    longPress(el);
    await settle();
    expect(b.runs).toContain(command);
    expect(b.opened.map((o) => o.name)).toEqual([sheet]);
    expect(JSON.stringify(b.ts.snapshot)).toBe(before);   // the tap command did not also run
  });

  test.each([
    ['Loop', '[data-ctl=loop] button', 'loop'],
    ['Click (rail)', '[data-ctl=click] button', 'click'],
    ['Mix main zone', '.ctl-mix-main', 'mix'],
  ])('%s: right-click (and Shift+F10 / ContextMenu) opens its sheet', async (_, selector, sheet) => {
    const b = await bed({variant: 'rail', practice: FRESH()});
    const event = new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2});
    b.q(selector).dispatchEvent(event);
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(b.opened.map((o) => o.name)).toEqual([sheet]);
  });

  test('right-click on the Speed value is its long-press: 100% ↔ the last speed', async () => {
    const b = await bed({variant: 'rail', practice: FRESH({rate: 0.8, lastRate: 0.8})});
    const event = new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2});
    b.q('[role=spinbutton]').dispatchEvent(event);
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(b.runs).toContain('speed.toggle100');
    expect(b.ts.snapshot.rate).toBe(1);
  });

  test('the Speed value long-press toggles 100% ↔ the last speed', async () => {
    const b = await bed({practice: FRESH({rate: 0.75, lastRate: 0.75})});
    longPress(b.q('[role=spinbutton]'));
    await settle();
    expect(b.ts.snapshot.rate).toBe(1);
    expect(b.runs).toContain('speed.toggle100');
  });

  test('the ⌃ zone opens the Mix sheet anchored to the Mix control', async () => {
    const b = await bed({practice: FRESH()});
    byRole(b.host, 'button', 'Mix…').click();
    await settle();
    expect(b.opened).toEqual([{name: 'mix', anchor: b.q('.ctl-mix')}]);
  });
});

describe('Count-in and Click (D14)', () => {
  test('Count-in toggles countIn.on, lit with its length; Click toggles always ↔ the last mode', async () => {
    const b = await bed({variant: 'rail', practice: FRESH()});
    const countIn = b.q('[data-ctl=countIn] button');
    const click = b.q('[data-ctl=click] button');
    expect(countIn.getAttribute('aria-pressed')).toBe('false');
    expect(countIn.querySelector('.ui-button-sublabel').textContent).toBe('1 bar');
    countIn.click();
    await settle();
    expect(b.ts.snapshot.countIn.on).toBe(true);
    expect(countIn.getAttribute('aria-pressed')).toBe('true');
    expect(b.ts.snapshot.click.mode).toBe('countin');
    click.click();
    await settle();
    expect(b.ts.snapshot.click.mode).toBe('always');
    expect(click.getAttribute('aria-pressed')).toBe('true');
    click.click();
    await settle();
    expect(b.ts.snapshot.click.mode).toBe('countin');
    expect(click.getAttribute('aria-pressed')).toBe('false');
  });

  test('the count-in length follows the song\'s setting (bars or beats)', () => {
    expect(countInState({countIn: {on: true, length: 2, unit: 'bars'}}, {mapped: true})).toEqual({label: 'Count-in', sublabel: '2 bars', pressed: true});
    expect(countInState({countIn: {on: false, length: 1, unit: 'beats'}}, {mapped: true})).toEqual({label: 'Count-in', sublabel: '1 beat', pressed: false});
    expect(countInState({countIn: {on: true, length: 4, unit: 'beats'}}, {mapped: true}).sublabel).toBe('4 beats');
  });

  test('unmapped: Count-in is the 2 s Lead-in; Click is disabled with "Needs a bar grid"', async () => {
    const b = await bed({variant: 'rail', mapped: false});
    const countIn = b.q('[data-ctl=countIn] button');
    expect(countIn.querySelector('.ui-button-label').textContent).toBe('Lead-in');
    expect(countIn.querySelector('.ui-button-sublabel').textContent).toBe('2 s');
    const click = b.q('[data-ctl=click] button');
    expect(click.getAttribute('aria-disabled')).toBe('true');
    expect(click.querySelector('.ui-button-reason').textContent).toBe('Needs a bar grid');
    click.click();
    await settle();
    expect(b.ts.snapshot.click.mode).not.toBe('always');
    countIn.click();
    await settle();
    expect(b.ts.snapshot.countIn.on).toBe(true);
  });
});

describe('Mix', () => {
  test('the main zone is Minus me: `Drums` over `OUT` while your part is out, else `Mix`', async () => {
    const b = await bed({practice: FRESH()});
    const main = b.q('.ctl-mix-main');
    expect(main.getAttribute('aria-label')).toBe('Mix · Minus me');
    expect(main.getAttribute('aria-pressed')).toBe('false');
    main.click();
    await settle();
    expect(b.ts.snapshot.mix.minusMe).toBe(true);
    expect(main.querySelector('.ui-button-label').textContent).toBe('Drums');
    expect(main.querySelector('.ui-button-sublabel').textContent).toBe('OUT');
    expect(main.getAttribute('aria-label')).toBe('Drums OUT · Minus me');
    expect(main.getAttribute('aria-pressed')).toBe('true');
    main.click();
    await settle();
    expect(main.getAttribute('aria-label')).toBe('Mix · Minus me');
  });

  test('with no stem for your instrument, Minus me opens the Mix sheet', async () => {
    const b = await bed({practice: FRESH(), account: {profile: {instruments: [], primary: null, openWithMyPart: 'in'}}});
    b.q('.ctl-mix-main').click();
    await settle();
    expect(b.opened.map((o) => o.name)).toEqual(['mix']);
    expect(b.ts.snapshot.mix.minusMe).toBe(false);
  });

  test('mixState names several instruments "Mine"', () => {
    expect(mixState({mix: {minusMe: true, mine: ['guitar', 'vocals']}})).toEqual({label: 'Mine', sublabel: 'OUT', pressed: true, name: 'Mine OUT · Minus me'});
  });
});

describe('Speed stepper', () => {
  test('− and + run speed.down / speed.up (±5%); the arrow keys ±1%; Page keys ±5%; Home 25%', async () => {
    const b = await bed({practice: FRESH()});
    const value = b.q('[role=spinbutton]');
    expect(value.getAttribute('aria-valuetext')).toBe('100%');
    byRole(b.host, 'button', COPY.slower).click();
    await settle();
    expect(b.ts.snapshot.rate).toBe(0.95);
    expect(value.getAttribute('aria-valuenow')).toBe('95');
    byRole(b.host, 'button', COPY.faster).click();
    await settle();
    expect(b.ts.snapshot.rate).toBe(1);
    const key = (k) => value.dispatchEvent(new window.KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true}));
    key('ArrowUp');
    await settle();
    expect(b.ts.snapshot.rate).toBe(1.01);
    key('PageDown');
    await settle();
    expect(b.ts.snapshot.rate).toBe(0.96);
    key('Home');
    await settle();
    expect(b.ts.snapshot.rate).toBe(0.25);
    expect(byRole(b.host, 'button', COPY.slower).getAttribute('aria-disabled')).toBe('true');
    expect(b.runs).toEqual(expect.arrayContaining(['speed.down', 'speed.up', 'speed.upFine', 'speed.down', 'speed.set']));
    expect(value.getAttribute('data-consume-keys')).toContain('ArrowUp');
  });

  test('tapping the value opens the Speed sheet anchored to the stepper', async () => {
    const b = await bed({practice: FRESH()});
    b.q('[role=spinbutton]').click();
    await settle();
    expect(b.opened).toEqual([{name: 'speed', anchor: b.q('.ui-stepper')}]);
  });

  test('the value follows the transport (keys, the trainer, undo)', async () => {
    const b = await bed({practice: FRESH()});
    b.ts.transport.setSpeed(0.7);
    await settle();
    expect(b.q('[role=spinbutton]').textContent).toBe('70%');
    b.ts.undo.undo();
    await settle();
    expect(b.q('[role=spinbutton]').textContent).toBe('100%');
  });
});

describe('slim (Edit\'s transport)', () => {
  test('⟲ ▶ ‖, bar.beat + time, the loop, speed and Mix chips', async () => {
    const b = await bed({variant: 'slim', practice: FRESH({rate: 0.75})});
    expect(byRole(b.host, 'button', 'Again')).toBeTruthy();
    expect(byRole(b.host, 'button', 'Pause')).toBeTruthy();
    expect(b.q('.ctl-pos-bar').textContent).toBe('17');
    expect(b.q('.ctl-pos-beat').textContent).toBe('1');
    expect(b.q('.ctl-pos-sub').textContent).toBe('0:32 / 2:08');
    const chip = byRole(b.host, 'button', 'Speed 75%');
    expect(chip).toBeTruthy();
    chip.click();
    await settle();
    expect(b.opened.map((o) => o.name)).toEqual(['speed']);
    b.ts.transport.cue(48);
    await settle();
    expect(b.q('.ctl-pos-bar').textContent).toBe('25');
    byRole(b.host, 'button', 'Pause').click();
    await settle();
    expect(b.runs).toContain('transport.pause');
  });

  test('unmapped: the time alone', async () => {
    const b = await bed({variant: 'slim', mapped: false, practice: FRESH({cue: 72})});
    expect(b.q('.ctl-pos-bar').textContent).toBe('1:12');
    expect(b.q('.ctl-pos-beat').hidden).toBe(true);
    expect(b.q('.ctl-pos-sub').hidden).toBe(true);
  });
});

describe('anchors, dim and lifecycle', () => {
  test('the controls are the sheets\' anchors while mounted (the stage\'s Map)', async () => {
    const b = await bed({variant: 'rail', practice: FRESH()});
    expect([...b.anchors.keys()].sort()).toEqual(['click', 'loop', 'mix', 'play', 'speed']);
    expect(b.anchors.get('play')).toBe(b.q('[data-ctl=play] button'));
    expect(b.anchors.get('click')).toBe(b.q('[data-ctl=click] button'));
    expect(b.anchors.get('mix')).toBe(b.q('.ctl-mix'));
    // Never [data-anchor]: that attribute positions overlays (position.css).
    expect(b.host.querySelector('[data-anchor]')).toBeNull();
    b.controls.destroy();
    expect(b.anchors.size).toBe(0);
    expect(b.host.children).toHaveLength(0);
  });

  test('the dock anchors Click sheets to Count-in (no Click control there)', async () => {
    const b = await bed({practice: FRESH()});
    expect(b.anchors.get('click')).toBe(b.q('[data-ctl=countIn] button'));
  });

  test('without a stage, the anchors come from the registry\'s stage context', async () => {
    const ts = await createTestSession({clock});
    const reg = createRegistry();
    const off = defineTransportCommands({registry: reg, sheets: {}});
    const anchors = new Map();
    reg.provide('stage', () => ({anchors, openSheet() {}}));
    reg.provide('session', () => ts.session);
    const host = document.body.appendChild(document.createElement('div'));
    const controls = mountControls(host, {session: ts.session, variant: 'dock', registry: reg});
    current.push(async () => { controls.destroy(); off(); await ts.dispose(); });
    expect(anchors.get('play')).toBe(host.querySelector('[data-ctl=play] button'));
  });

  test('while playing the controls dim to 70% (still live)', async () => {
    const b = await bed({practice: FRESH()});
    b.q('[data-ctl=play] button').click();
    await settle();
    expect(b.q('.ctl-set').hasAttribute('data-playing')).toBe(true);
    const css = readFileSync(join(ROOT, 'src/styles/views/stage/controls.css'), 'utf8');
    expect(css).toMatch(/\.ctl-set\[data-playing\] \{ opacity: \.7; \}/);
    b.q('[data-ctl=loop] button').click();
    await settle();
    expect(b.ts.snapshot.loop.on).toBe(true);
  });

  test('the dock\'s widths are the spec\'s: 72 · 96 · 72 · 184 · 80 · 104, 12 px gaps, 16 px padding (700 px)', () => {
    const css = readFileSync(join(ROOT, 'src/styles/views/stage/controls.css'), 'utf8');
    const width = (ctl) => Number(css.match(new RegExp(`data-variant=dock\\] \\[data-ctl=${ctl}\\] \\{ inline-size: (\\d+)px`))?.[1]);
    const widths = LAYOUT.dock.map(width);
    expect(widths).toEqual([72, 96, 72, 184, 80, 104]);
    expect(widths.reduce((a, b) => a + b, 0) + 5 * 12 + 2 * 16).toBe(700);
  });

  test('an unknown variant is refused', async () => {
    const ts = await createTestSession({clock});
    current.push(() => ts.dispose());
    expect(() => mountControls(document.createElement('div'), {session: ts.session, variant: 'wide'})).toThrow(RangeError);
  });
});
