// @vitest-environment happy-dom
// Edit · Map inspector (src/edit/map/inspector.js; architecture §2.15 `mountInspector`; spec §5.1
// "Inspector, selected bar or pin", §5.1.1 "Get a map"; maps/mapedit.md §11.4: every key-only map edit
// has a visible control; D19, D20). Mounted on its own over a real song session and the real map
// session, with an isolated registry holding the Em, Stage-map and transport commands, so every
// button runs the same command its key runs.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {createRegistry} from '../src/app/commands.js';
import {clock as appClock} from '../src/app/clock.js';
import {signal} from '../src/app/store.js';
import {defineStageCommands} from '../src/stage/commands.js';
import {defineTransportCommands} from '../src/stage/transport-commands.js';
import {MAP_SESSION_COPY, clockText, createMapSession} from '../src/edit/map/session.js';
import {mountInspector} from '../src/edit/map/inspector.js';
import {COPY, CONTROLS, MAPPING, MAP_COMMANDS as C} from '../src/edit/map/map.copy.js';
import {defineMapCommands} from '../src/edit/map/commands.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {installPopoverShim, keydown, restoreDomShims} from './helpers/dom.js';
import {legacySongMap, pickup} from './fixtures/maps.js';

let clock, restoreAudio;
const current = [];

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(Date.parse('2026-10-28T12:00:00Z'));
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
  installPopoverShim();
});

afterEach(async () => {
  for (const off of current.splice(0).reverse()) await off();
  document.body.replaceChildren();
  restoreDomShims();
  restoreAudio();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const ROLE_OF = (el) => el.getAttribute('role') ?? ({BUTTON: 'button', ASIDE: 'complementary', INPUT: 'textbox', A: 'link'})[el.tagName] ?? null;
function nameOf(el) {
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
  const by = el.getAttribute('aria-labelledby');
  if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  if (el.tagName === 'INPUT' && el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) return label.textContent.trim();
  }
  return (el.querySelector('.ui-button-label')?.textContent ?? el.textContent).trim();
}
const byRole = (root, role, name) => [root, ...root.querySelectorAll('*')].filter((el) => ROLE_OF(el) === role && !el.closest('[hidden]') && nameOf(el) === name);
function one(root, role, name) {
  const found = byRole(root, role, name);
  if (found.length !== 1) throw new Error(`expected one ${role} "${name}", found ${found.length}`);
  return found[0];
}
/** Types into a text field and commits it with Enter (TextField commits on Enter and on blur). */
function type(input, value) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new window.Event('input', {bubbles: true}));
  keydown('Enter', {target: input});
}

function fakePrefs() {
  const value = signal({edit: {map: {tapSnap: true, tapOffset: 0}}});
  const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  return {
    value,
    get: (path) => at(value.peek(), path),
    set(path, v) {
      const next = structuredClone(value.peek());
      const keys = path.split('.');
      let o = next;
      for (const k of keys.slice(0, -1)) o = o[k] ??= {};
      o[keys.at(-1)] = v;
      value.value = next;
    },
  };
}

function feedbackStub() {
  const line = signal(null);
  return {statusLine: line, attachStatusLine: () => () => {}, status: (text, opts = {}) => { line.value = {text, ...opts}; }};
}

async function bed({desktop = false, ...options} = {}) {
  const ts = await createTestSession({clock, desktop, ...options});
  const engine = ts.session.engine;
  const prefs = fakePrefs();
  const hooks = {
    suspendSaves: (on, opts) => ts.session.suspendSaves?.(on, opts),
    pauseMapSync: (on) => ts.session.notation?.setMapSyncPaused?.(!!on),
    status: () => {},
    loop: {
      get: () => ({loop: {...engine.loop}, gap: engine.loopGap}),
      set: (value) => { const l = value?.loop; if (l && Number.isFinite(l.a) && Number.isFinite(l.b)) engine.setLoop(!!l.enabled, l.a, l.b); },
    },
    markers: {list: () => [], tombstone: () => {}},
  };
  const mapSession = createMapSession({engine, metronome: ts.session.metronome, map: ts.session.map, prefs, hooks});
  ts.session.mapEditor.value = mapSession;
  const registry = createRegistry();
  defineMapCommands({registry});
  defineStageCommands({registry, later: {}});
  defineTransportCommands({registry, sheets: {}});
  const router = {calls: [], navigate(to, opts) { this.calls.push([to, opts ?? null]); }};
  registry.provide('session', () => ts.session);
  registry.provide('transport', () => ts.session.transport);
  registry.provide('map', () => mapSession);
  registry.provide('router', () => router);
  const feedback = feedbackStub();
  const host = document.createElement('div');
  document.body.append(host);
  const desktopModule = {available: !!desktop, processor: signal(desktop ? {phase: 'ready'} : {phase: 'web'})};
  const inspector = mountInspector(host, {session: ts.session, mapSession, registry, prefs, feedback, store: {library: ts.library}, desktop: desktopModule});
  // Commands evaluate `when` after a 50 ms settle (buttons enable then).
  vi.advanceTimersByTime(60);
  current.push(async () => { inspector.destroy(); mapSession.destroy(); ts.session.mapEditor.value = null; await ts.dispose(); });
  return {ts, session: ts.session, map: ts.session.map, mapSession, registry, router, prefs, feedback, inspector, el: inspector.el,
    refresh: () => { vi.advanceTimersByTime(60); }};
}
const bar = (b) => b.mapSession.span.peek().display;

// ---------------------------------------------------------------------------------------------------------------

describe('the mapping table (maps/mapedit.md §11.4)', () => {
  test('every mapped inspector control renders with its role and name, and each MAPPING row has its control', async () => {
    const b = await bed();
    b.mapSession.select(b.map.data.pins.at(-1).position);   // a pinned line on the open tail span
    const shown = CONTROLS.filter((r) => ['inspector', 'pinned', 'open', 'unsectioned'].includes(r.context) && r.context !== 'unsectioned');
    for (const row of shown) expect(byRole(b.el, row.role, row.name).length, `${row.role} "${row.name}"`).toBeGreaterThan(0);
    expect(b.el.getAttribute('aria-label')).toBe(COPY.inspector);
    const names = new Set([...b.el.querySelectorAll('*')].map(nameOf));
    for (const row of MAPPING.filter((r) => ![COPY.sectionsLane, COPY.snap, COPY.gridButton(COPY.divisions.beat), COPY.zoomIn, COPY.zoomOut, COPY.fit, COPY.zoomSelection].includes(r.name))) {
      expect(names.has(row.name), `${row.was} → ${row.name}`).toBe(true);
    }
  });
});

describe('Go to', () => {
  test('the header names the bar and beat; ◀ Bar / Bar ▶ step through map.prevBar / map.nextBar', async () => {
    const b = await bed();
    b.mapSession.goToBar(10);
    expect(b.el.querySelector('[data-testid=map-insp-bar]').textContent).toBe('BAR 10');
    one(b.el, 'button', COPY.nextBarName).click();
    expect(bar(b)).toBe(11);
    one(b.el, 'button', COPY.prevBarName).click();
    one(b.el, 'button', COPY.prevBarName).click();
    expect(bar(b)).toBe(9);
    b.mapSession.step(1, 'beat');
    expect(b.el.querySelector('.map-insp-sub').textContent).toBe(COPY.beatSub(2));
  });

  test('typed digits show in the field; Go and Enter go to the bar; ⏮ ⏭ jump between pins', async () => {
    const b = await bed({tempo: structuredClone(legacySongMap.tempo), duration: 30});
    const field = one(b.el, 'textbox', COPY.goToField);
    b.mapSession.typeDigit(1);
    b.mapSession.typeDigit(2);
    expect(field.value).toBe('12');
    b.mapSession.clearDigits();
    expect(field.value).toBe('');
    type(field, '7');
    expect(bar(b)).toBe(7);
    field.value = '3';
    one(b.el, 'button', COPY.go).click();
    expect(bar(b)).toBe(3);
    // Pins at bar 1 and bar 5.
    one(b.el, 'button', COPY.nextPinName).click();
    expect(bar(b)).toBe(5);
    one(b.el, 'button', COPY.prevPinName).click();
    expect(bar(b)).toBe(1);
    type(field, 'x');
    expect(b.mapSession.message.peek().text).toBe(COPY.noDigits);
  });
});

describe('Meter', () => {
  test('the Beats stepper: each step is one map edit (↑ on the spinbutton, until the next change)', async () => {
    const b = await bed();
    b.mapSession.goToBar(5);
    const spin = b.el.querySelector('.map-beats [role=spinbutton]');
    const undo = b.map.undoStack.length;
    keydown('ArrowUp', {target: spin});
    expect(b.map.measure(4).numerator).toBe(5);
    expect(b.map.measure(20).numerator).toBe(5);   // until the next change
    expect(b.map.undoStack.length).toBe(undo + 1);
    expect(spin.getAttribute('aria-valuenow')).toBe('5');
  });

  test('Unit, Groups, Apply to and Keep in place apply together with [Apply] as one edit ("Edit bar", every field kept)', async () => {
    const b = await bed();
    b.mapSession.goToBar(9);
    const spin = b.el.querySelector('.map-beats [role=spinbutton]');
    keydown('ArrowUp', {target: spin}); keydown('ArrowUp', {target: spin}); keydown('ArrowUp', {target: spin});
    expect(b.map.measure(8).numerator).toBe(7);
    one(b.el, 'radio', '8').click();
    const groups = one(b.el, 'textbox', COPY.groups);
    groups.value = '2+2+3';
    groups.dispatchEvent(new window.Event('input', {bubbles: true}));
    one(b.el, 'radio', COPY.applyThis).click();
    one(b.el, 'radio', COPY.keepLines).click();
    const undo = b.map.undoStack.length;
    one(b.el, 'button', COPY.apply).click();
    expect(b.map.measure(8)).toMatchObject({numerator: 7, denominator: 8});
    expect(b.map.bars[8].groups).toEqual([2, 2, 3]);
    expect(b.map.measure(9).denominator).toBe(4);   // This bar only
    expect(b.map.undoStack.length).toBe(undo + 1);
    expect(b.mapSession.message.peek().tone).toBe('ok');
  });

  test('Enter in Groups applies the form; applyFocused (Enter, D19) applies the focused field', async () => {
    const b = await bed();
    b.mapSession.goToBar(3);
    const groups = one(b.el, 'textbox', COPY.groups);
    groups.focus();
    groups.value = '3+1';
    groups.dispatchEvent(new window.Event('input', {bubbles: true}));
    keydown('Enter', {target: groups});
    expect(b.map.bars[2].groups).toEqual([3, 1]);
    // E focuses Meter → Beats; Enter there applies the form.
    expect(b.inspector.focusMeter()).toBe(true);
    expect(document.activeElement).toBe(b.el.querySelector('.map-beats [role=spinbutton]'));
    expect(b.inspector.applyFocused()).toBeTruthy();
    // Focus outside the inspector: nothing to apply.
    document.activeElement.blur();
    expect(b.inspector.applyFocused()).toBe(false);
  });

  test('Pickup length shows only where it applies (bar 1 of a song with a pickup)', async () => {
    const b = await bed({tempo: structuredClone(pickup.tempo), duration: 20});
    b.mapSession.select(b.map.barStart(0));
    const field = one(b.el, 'textbox', COPY.pickup);
    expect(field.value).toBe('2');
    b.mapSession.goToBar(4);
    expect(byRole(b.el, 'textbox', COPY.pickup)).toHaveLength(0);
  });
});

describe('Label and Tempo', () => {
  test('Label: Enter labels the bar (a section starts there); empty removes it', async () => {
    const b = await bed();
    b.mapSession.goToBar(13);
    const label = one(b.el, 'textbox', COPY.labelField);
    expect(label.value).toBe('');
    type(label, 'Solo');
    expect(b.map.measure(12).label).toBe('Solo');
    expect(b.map.sections.some((s) => s.name === 'Solo')).toBe(true);
    type(label, '');
    expect(b.map.measure(12).label).toBe('');
  });

  test('the ♩ field sets the tempo of an open span; ×2 / ÷2 scale; Tail [−] [+] step the tail tempo; Ramp toggles', async () => {
    const b = await bed({tempo: structuredClone(legacySongMap.tempo), duration: 30});
    b.mapSession.goToBar(8);   // after the last pin: the open tail
    const field = one(b.el, 'textbox', COPY.tempoField('♩'));
    expect(field.value).toBe('120.00');
    type(field, '96');
    expect(b.map.bpmAt(b.map.bars[8].q0)).toBeCloseTo(96, 6);
    one(b.el, 'button', COPY.tailUp).click();
    expect(b.map.bpmAt(b.map.bars[8].q0)).toBeCloseTo(97, 6);
    one(b.el, 'button', COPY.tailDown).click();
    one(b.el, 'button', COPY.tailDown).click();
    expect(b.map.bpmAt(b.map.bars[8].q0)).toBeCloseTo(95, 6);
    // A steady span between pins reads its tempo instead of a field.
    b.mapSession.goToBar(2);
    expect(byRole(b.el, 'textbox', COPY.tempoField('♩'))).toHaveLength(0);
    expect(b.el.querySelector('.map-tempo-value').textContent).toContain(COPY.tempoSteady('120'));
    one(b.el, 'button', COPY.doubleName).click();
    expect(b.map.bpmAt(b.map.bars[1].q0)).toBeCloseTo(240, 6);
    one(b.el, 'button', COPY.halveName).click();
    expect(b.map.bpmAt(b.map.bars[1].q0)).toBeCloseTo(120, 6);
    expect(one(b.el, 'button', COPY.ramp).getAttribute('aria-pressed')).toBe('false');
  });

  test('a refused edit lands in the status line in the error tone (the guards render there)', async () => {
    const b = await bed({tempo: structuredClone(legacySongMap.tempo), duration: 30});
    b.mapSession.goToBar(8);
    type(one(b.el, 'textbox', COPY.tempoField('♩')), '0');
    const status = b.el.querySelector('[data-testid=map-status]');
    expect(status.hidden).toBe(false);
    expect(status.dataset.tone).toBe('error');
    expect(status.textContent).toContain(MAP_SESSION_COPY.tempoNumber);
  });

  test('results that offer Undo (the app status line) show with their action while mounted', async () => {
    const b = await bed();
    let undone = 0;
    b.feedback.status('Beat grid found', {tone: 'ok', action: {label: 'Undo', run: () => { undone++; }}});
    const status = b.el.querySelector('[data-testid=map-status]');
    expect(status.textContent).toContain('Beat grid found');
    const undo = [...status.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Undo');
    undo.click();
    expect(undone).toBe(1);
    b.feedback.statusLine.value = null;
    expect(status.hidden).toBe(true);
  });
});

describe('Pin', () => {
  test('free → [Pin downbeat] pins the line at the playhead → "● Locked at …", nudges, renumber, [Unpin]', async () => {
    const b = await bed();
    const at = b.map.bars[11].t0 + 0.05;
    b.session.transport.cue(at);
    b.mapSession.goToBar(12);
    const state = b.el.querySelector('[data-testid=map-pin-state]');
    expect(state.dataset.pinned).toBe('false');
    expect(state.textContent).toContain(COPY.free);
    expect(byRole(b.el, 'button', COPY.unpin)).toHaveLength(0);
    b.session.transport.cue(at);
    one(b.el, 'button', COPY.pinDownbeat).click();
    b.refresh();
    expect(state.dataset.pinned).toBe('true');
    expect(state.textContent).toContain(COPY.lockedAt(clockText(at)));
    one(b.el, 'button', COPY.nudgeFwd10Name).click();
    one(b.el, 'button', COPY.nudgeBack1Name).click();
    expect(b.mapSession.span.peek().pin.time).toBeCloseTo(at + 0.009, 6);
    const renumber = one(b.el, 'textbox', COPY.renumber);
    expect(renumber.value).toBe(String(bar(b)));
    one(b.el, 'button', COPY.unpin).click();
    b.refresh();
    expect(state.dataset.pinned).toBe('false');
  });

  test('"This pin is bar [ ]" renumbers the pin (the bar line moves to the typed number)', async () => {
    const b = await bed({tempo: structuredClone(legacySongMap.tempo), duration: 30});
    b.mapSession.goToBar(5);   // the pin at 9.0 s
    const renumber = one(b.el, 'textbox', COPY.renumber);
    expect(renumber.value).toBe('5');
    type(renumber, '6');
    expect(b.map.timeAt(b.map.barStart(5))).toBeCloseTo(9, 6);
    expect(b.mapSession.message.peek().tone).toBe('ok');
  });
});

describe('Tools', () => {
  test('Snap taps to drum hits is a device pref; Preview is a toggle; Find a chart… opens Find', async () => {
    const b = await bed();
    const snapTaps = one(b.el, 'button', COPY.snapTaps);
    expect(snapTaps.getAttribute('aria-pressed')).toBe('true');
    snapTaps.click();
    expect(b.prefs.get('edit.map.tapSnap')).toBe(false);
    expect(one(b.el, 'button', COPY.preview).getAttribute('aria-pressed')).toBe('false');
    one(b.el, 'button', COPY.find).click();
    expect(b.router.calls.at(-1)[0]).toBe(`/s/${encodeURIComponent(b.session.id)}/edit/map/find`);
    // Sections exist: no Suggest sections.
    expect(byRole(b.el, 'button', COPY.suggest)).toHaveLength(0);
  });

  test('Detect beats runs map.detect (desktop) and shows the job line while it runs', async () => {
    const b = await bed({desktop: true});
    const detect = one(b.el, 'button', COPY.detect);
    detect.click();
    await settle();
    b.refresh();
    expect(b.ts.server.jobRows.some((j) => j.kind === 'beats')).toBe(true);
    expect(detect.getAttribute('aria-busy')).toBe('true');
  });

  test('while auditioning (D20), map-editing buttons are disabled', async () => {
    const b = await bed();
    b.mapSession.beginAudition();
    b.refresh();
    for (const name of [COPY.pinDownbeat, COPY.doubleName, COPY.tailUp, COPY.nudgeFwd10Name, COPY.tapAlong, COPY.calibrate]) {
      const button = one(b.el, 'button', name);
      expect(button.disabled || button.getAttribute('aria-disabled') === 'true', name).toBe(true);
    }
    expect(one(b.el, 'button', COPY.nextBarName).disabled).toBe(false);
    b.mapSession.endAudition({commit: false});
  });
});

describe('Get a map (unmapped, spec §5.1.1)', () => {
  test('the web with no paired computer: "Needs Woodshed for desktop [Get it ↗]", Tap along and Find a chart', async () => {
    const b = await bed({mapped: false});
    expect(b.el.dataset.mode).toBe('unmapped');
    expect(b.el.textContent).toContain(COPY.getMap);
    expect(b.el.textContent).toContain(COPY.needsDesktop);
    expect(one(b.el, 'link', COPY.getIt).getAttribute('href')).toBe('/download');
    expect(byRole(b.el, 'button', COPY.detectAction)).toHaveLength(0);
    expect(b.el.textContent).toContain(COPY.tapBody);
    one(b.el, 'button', COPY.tapAction);
    one(b.el, 'button', COPY.findAction).click();
    expect(b.router.calls).toHaveLength(1);
    // No bar position anywhere (the Get a map copy may explain what bars are, spec §5.1.1).
    expect(b.el.textContent).not.toMatch(/\bBar \d|BAR \d/);
    expect(b.el.querySelector('[data-testid=map-insp-bar]')).toBeNull();
  });

  test('desktop: [Detect] "About 30 s on this computer."; it starts a beats job', async () => {
    const b = await bed({mapped: false, desktop: true});
    expect(b.el.textContent).toContain(COPY.detectBody(COPY.detectHere));
    one(b.el, 'button', COPY.detectAction).click();
    await settle();
    expect(b.ts.server.jobRows.some((j) => j.kind === 'beats')).toBe(true);
  });

  test('the inspector switches to the full inspector when the song gets a map', async () => {
    const b = await bed({mapped: false, desktop: true});
    one(b.el, 'button', COPY.detectAction).click();
    await settle();
    const job = b.ts.server.jobRows.find((j) => j.kind === 'beats');
    b.ts.server.finishJob(job.jobId, {beats: Array.from({length: 120}, (_, i) => [0.25 + i * 0.5, (i % 4) + 1])});
    await settle();
    b.refresh();
    expect(b.map.isReal).toBe(true);
    expect(b.el.dataset.mode).toBe('mapped');
    one(b.el, 'button', COPY.pinDownbeat);
  });
});
