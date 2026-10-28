// @vitest-environment happy-dom
// The Loop card (src/stage/sheets/loop.js; architecture §2.14.11, spec §4.7, D17) on a real song
// session (tests/helpers/test-session.js) with the real §3.1/§3.2 commands on an isolated registry:
// the controls table, the range line, edge nudges by unit, move by length, the pass options, Call &
// response's reason, Trainer…, Save as spot… and Clear. Sizes and colours are Playwright states
// (tests/fixture/states/ST8a.cjs).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {createRegistry} from '../src/app/commands.js';
import {clock as appClock} from '../src/app/clock.js';
import {defineTransportCommands, COPY as TRANSPORT_COPY} from '../src/stage/transport-commands.js';
import {defineStageCommands} from '../src/stage/commands.js';
import {COPY, CONTROLS, nudgeUnit, render} from '../src/stage/sheets/loop.js';
import {closeSheets, openSheet, openSheetName} from '../src/stage/sheets/host.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {installPopoverShim, keydown, restoreDomShims} from './helpers/dom.js';
import {sectioned, tempoOf} from './fixtures/maps.js';

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
  closeSheets();
  for (const off of current.splice(0).reverse()) await off();
  document.body.replaceChildren();
  restoreDomShims();
  restoreAudio();
  vi.useRealTimers();
});

function practiceOf(fields = {}) {
  return {v: 2, cue: 0, rate: 1, tracks: [], minusMe: false, trainer: null, spots: [], markers: [], ...fields,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none', ...(fields.loop ?? {})}};
}
const CHORUS = (fields = {}) => practiceOf({cue: 32, loop: {on: true, a: 32, b: 48}, ...fields});

function nameOf(el) {
  const label = el.getAttribute('aria-label');
  if (label) return label.trim();
  const by = el.getAttribute('aria-labelledby');
  if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  if (el.id) {
    const lab = document.querySelector(`label[for="${el.id}"]`);
    if (lab) return lab.textContent.trim();
  }
  const text = el.querySelector?.('.ui-button-label') ?? el.querySelector?.('.ui-segmented-label');
  return (text ?? el).textContent.replace(/\s+/g, ' ').trim();
}
const SELECTOR = {button: 'button', radiogroup: '[role=radiogroup]', radio: '[role=radio]', textbox: 'input[type=text], input:not([type])'};
const visible = (el) => !el.closest('[hidden]');
const all = (root, role) => [...root.querySelectorAll(SELECTOR[role])].filter((el) => el.getAttribute('role') === role || role === 'button' || role === 'textbox')
  .filter((el) => role !== 'button' || !el.getAttribute('role'))
  .filter(visible);
const byRole = (root, role, name) => all(root, role).find((el) => nameOf(el) === name) ?? null;

/** A session, the commands, a Stage stub and a recording feedback; the card rendered in a host. */
async function bed({stage: withStage = true, ...options} = {}) {
  const ts = await createTestSession({clock, ...options});
  const reg = createRegistry();
  const offT = defineTransportCommands({registry: reg, sheets: {}});
  const offS = defineStageCommands({registry: reg, later: {}});
  const sheets = [];
  const statuses = [];
  const fb = {status: vi.fn((text, o = {}) => statuses.push({text, ...o})), toast: vi.fn(), form: vi.fn()};
  reg.provide('session', () => ts.session);
  reg.provide('transport', () => ts.session.transport);
  if (withStage) reg.provide('stage', () => ({openSheet: (name) => { sheets.push(name); return {close() {}}; }, anchors: new Map()}));
  reg.provide('feedback', () => fb);
  const host = document.body.appendChild(document.createElement('div'));
  const close = vi.fn();
  const card = render(host, {session: ts.session, close, registry: reg, feedback: fb});
  current.push(async () => { card.destroy(); offS(); offT(); await ts.dispose(); });
  const b = {
    ts, reg, host, card, sheets, statuses, close,
    get snap() { return ts.snapshot; },
    get root() { return host.querySelector('.loop-card'); },
    range: () => host.querySelector('.loop-card-range').textContent,
    hint: () => { const el = host.querySelector('.loop-card-hint'); return el.hidden ? '' : el.textContent; },
    button: (name) => byRole(host, 'button', name),
    click(name, init = {}) {
      const el = b.button(name);
      if (!el) throw new Error(`no button ${name}`);
      el.dispatchEvent(new window.MouseEvent('click', {bubbles: true, cancelable: true, ...init}));
      return el;
    },
    radio: (group, name) => {
      const g = byRole(host, 'radiogroup', group);
      return [...g.querySelectorAll('[role=radio]')].find((el) => nameOf(el) === name);
    },
  };
  return b;
}

// ---------------------------------------------------------------------------------------------------------------

describe('the controls table (§9.0)', () => {
  const when = ({range, mapped, form}) => (w) => !w || w.split(' ').every((part) =>
    (part === 'range' ? range : part === 'mapped' ? mapped : part === 'unmapped' ? !mapped : part === 'form' ? form : part === 'noform' ? !form : false));

  for (const [label, options, flags] of [
    ['mapped, with a loop', {practice: CHORUS()}, {range: true, mapped: true}],
    ['unmapped, with a loop', {mapped: false, practice: practiceOf({cue: 31.2, loop: {on: true, a: 31.2, b: 41}})}, {range: true, mapped: false}],
    ['mapped, no loop', {}, {range: false, mapped: true}],
  ]) {
    test(`every row with its role and accessible name: ${label}`, async () => {
      const b = await bed(options);
      for (const form of flags.range ? [false, true] : [false]) {
        if (form) b.click(COPY.saveAsSpot);
        const rows = CONTROLS.filter((c) => when({...flags, form})(c.when));
        for (const c of rows) expect(byRole(b.host, c.role, c.name), `${c.role} "${c.name}"`).toBeTruthy();
        // Rows the table leaves out for this song are not there.
        for (const c of CONTROLS.filter((x) => !when({...flags, form})(x.when) && x.role === 'button')) {
          if (rows.some((r) => r.name === c.name)) continue;
          expect(byRole(b.host, c.role, c.name), `no ${c.role} "${c.name}"`).toBeNull();
        }
      }
    });
  }

  test('command rows are bound: key-caps and pressed states come from the registry', async () => {
    const b = await bed({practice: CHORUS()});
    expect(b.button(COPY.loop).getAttribute('aria-pressed')).toBe('true');
    expect(b.button(COPY.loop).getAttribute('aria-keyshortcuts')).toBe('L');
    expect(b.button(COPY.loopIn).getAttribute('aria-keyshortcuts')).toBe('I');
    expect(b.button(COPY.loopOut).getAttribute('aria-keyshortcuts')).toBe('O');
    expect(b.button(COPY.moveBackName('8 bars')).getAttribute('aria-keyshortcuts')).toBe('Shift+[');
    expect(b.button(COPY.moveFwdName('8 bars')).getAttribute('aria-keyshortcuts')).toBe('Shift+]');
    expect(b.button(COPY.eachPass).getAttribute('aria-pressed')).toBe('true');
    expect(b.button(COPY.saveAsSpot).getAttribute('aria-keyshortcuts')).toBe('B');
    expect(b.button(COPY.clear).getAttribute('aria-keyshortcuts')).toBe('Backspace');
  });
});

describe('the range line', () => {
  test('mapped: "Bars 17–24 · Chorus (8 bars)"; it follows the loop live', async () => {
    const b = await bed({practice: CHORUS()});
    expect(b.range()).toBe('Bars 17–24 · Chorus (8 bars)');
    expect(b.root.hasAttribute('data-on')).toBe(true);
    b.ts.transport.loopRange(40, 46, {snap: 'none'});
    await settle();
    expect(b.range()).toBe('Bars 21–23 (3 bars)');
    b.click(COPY.loop);
    expect(b.snap.loop.on).toBe(false);
    expect(b.hint()).toBe(COPY.loopOff);
    expect(b.root.hasAttribute('data-on')).toBe(false);
  });

  test('unmapped: "0:31.2–0:41.0 (9.8 s)", with no word "bar" anywhere on the card', async () => {
    const b = await bed({mapped: false, practice: practiceOf({cue: 31.2, loop: {on: true, a: 31.2, b: 41}})});
    expect(b.range()).toBe('0:31.2–0:41.0 (9.8 s)');
    expect(b.root.textContent.toLowerCase()).not.toMatch(/\bbars?\b/);
    expect([...b.root.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label')).join(' ').toLowerCase()).not.toMatch(/\bbars?\b/);
  });

  test('no loop yet: what L would do (section, 4 bars or 10 s), and In / Out at the playhead', async () => {
    const b = await bed();
    expect(b.range()).toBe(COPY.noLoop);
    expect(b.hint()).toBe(COPY.emptySections);
    expect(b.host.querySelector('.loop-card-edit').hidden).toBe(true);
    expect(b.button(COPY.clear)).toBeNull();
    b.ts.transport.cue(41);
    b.click(COPY.loopIn);
    expect(b.snap.loop).toMatchObject({on: true, a: 40, b: 42});
    expect(b.host.querySelector('.loop-card-edit').hidden).toBe(false);
    const tempo = tempoOf(sectioned);
    for (const m of tempo.songMap.measures) m.label = '';
    const plain = await bed({tempo});
    expect(plain.hint()).toBe(COPY.emptyPhrase);
    const u = await bed({mapped: false});
    expect(u.hint()).toBe(COPY.emptyUnmapped);
  });
});

describe('edge nudges (spec §4.7, transport rule 16)', () => {
  test('nudgeUnit: bar / beat mapped; 0.1 s, 50 ms, 10 ms unmapped', () => {
    expect(nudgeUnit(true)).toBe('bar');
    expect(nudgeUnit(true, {altKey: true})).toBe('beat');
    expect(nudgeUnit(true, {altKey: true, shiftKey: true})).toBe('beat');
    expect(nudgeUnit(false)).toBe('tenth');
    expect(nudgeUnit(false, {altKey: true})).toBe('50ms');
    expect(nudgeUnit(false, {altKey: true, shiftKey: true})).toBe('10ms');
  });

  test('mapped: by a bar, Alt by a beat; the edge values read bar · beat', async () => {
    const b = await bed({practice: CHORUS()});
    const values = () => [...b.host.querySelectorAll('.loop-card-edge-value')].map((n) => n.textContent);
    expect(values()).toEqual(['17 · 1', '25 · 1']);
    b.click(COPY.later(COPY.start, COPY.unitBar));
    expect(b.snap.loop).toMatchObject({a: 34, b: 48});
    b.click(COPY.later(COPY.start, COPY.unitBar), {altKey: true});
    expect(b.snap.loop.a).toBeCloseTo(34.5, 6);
    b.click(COPY.earlier(COPY.end, COPY.unitBar));
    expect(b.snap.loop.b).toBe(46);
    b.click(COPY.later(COPY.end, COPY.unitBar));
    expect(b.snap.loop.b).toBe(48);
    b.click(COPY.earlier(COPY.start, COPY.unitBar), {altKey: true});
    expect(b.snap.loop.a).toBe(34);
    expect(values()).toEqual(['18 · 1', '25 · 1']);
    // Each nudge is one undo step.
    b.ts.undo.undo();
    expect(b.snap.loop.a).toBeCloseTo(34.5, 6);
  });

  test('unmapped: 0.1 s, Alt 50 ms, Alt+Shift 10 ms; Alt+Enter on a focused nudge button uses the fine unit', async () => {
    const b = await bed({mapped: false, practice: practiceOf({cue: 31.2, loop: {on: true, a: 31.2, b: 41}})});
    const startLater = COPY.later(COPY.start, COPY.unitTenth);
    b.click(startLater);
    expect(b.snap.loop.a).toBeCloseTo(31.3, 6);
    b.click(startLater, {altKey: true});
    expect(b.snap.loop.a).toBeCloseTo(31.35, 6);
    b.click(startLater, {altKey: true, shiftKey: true});
    expect(b.snap.loop.a).toBeCloseTo(31.36, 6);
    const endEarlier = b.button(COPY.earlier(COPY.end, COPY.unitTenth));
    endEarlier.focus();
    keydown({key: 'Enter', code: 'Enter', altKey: true}, {target: endEarlier});
    expect(b.snap.loop.b).toBeCloseTo(40.95, 6);
    expect(b.host.querySelector('.loop-card-fine').textContent).toBe(COPY.fineUnmapped);
  });
});

describe('move by length, options, trainer', () => {
  test('◀ Move 8 bars / Move 8 bars ▶ shift the loop by its own length', async () => {
    const b = await bed({practice: CHORUS()});
    const fwd = b.button(COPY.moveFwdName('8 bars'));
    expect(fwd.querySelector('.ui-button-label').textContent).toBe('Move 8 bars');
    b.click(COPY.moveFwdName('8 bars'));
    expect(b.snap.loop).toMatchObject({a: 48, b: 64});
    b.click(COPY.moveBackName('8 bars'));
    b.click(COPY.moveBackName('8 bars'));
    expect(b.snap.loop).toMatchObject({a: 16, b: 32});
    const u = await bed({mapped: false, practice: practiceOf({loop: {on: true, a: 31.2, b: 41}})});
    u.click(COPY.moveFwdName('9.8 s'));
    expect(u.snap.loop.a).toBeCloseTo(41, 6);
    expect(u.snap.loop.b).toBeCloseTo(50.8, 6);
  });

  test('Count in every pass toggles; a note says when Count-in is off', async () => {
    const b = await bed({practice: CHORUS()});
    const note = b.host.querySelector('.loop-card-note');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(COPY.eachPassOff);
    b.click(COPY.eachPass);
    expect(b.snap.loop.eachPassCount).toBe(false);
    await vi.advanceTimersByTimeAsync(60);   // the registry re-evaluates checked states (debounced)
    expect(b.button(COPY.eachPass).getAttribute('aria-pressed')).toBe('false');
    b.ts.transport.toggleCountIn();
    await settle();
    expect(note.hidden).toBe(true);
  });

  test('Play N times then stop: Off · 2 · 4 · 8', async () => {
    const b = await bed({practice: CHORUS()});
    expect(b.radio(COPY.playTimes, 'Off').getAttribute('aria-checked')).toBe('true');
    b.radio(COPY.playTimes, '4').click();
    expect(b.snap.loop.playTimes).toBe(4);
    expect(b.radio(COPY.playTimes, '4').getAttribute('aria-checked')).toBe('true');
    b.ts.undo.undo();
    await settle();
    expect(b.snap.loop.playTimes).toBe(0);
    expect(b.radio(COPY.playTimes, 'Off').getAttribute('aria-checked')).toBe('true');
  });

  test('Between passes (D17): None · 1 bar rest · Call & response; 2 s rest unmapped', async () => {
    const b = await bed({practice: CHORUS()});
    b.radio(COPY.between, COPY.rest).click();
    expect(b.snap.loop.between).toBe('rest');
    b.radio(COPY.between, COPY.call).click();
    expect(b.snap.loop.between).toBe('call');
    b.radio(COPY.between, COPY.none).click();
    expect(b.snap.loop.between).toBe('none');
    const u = await bed({mapped: false, practice: practiceOf({loop: {on: true, a: 10, b: 20}})});
    expect(u.radio(COPY.between, COPY.restUnmapped)).toBeTruthy();
    expect(u.radio(COPY.between, COPY.rest)).toBeUndefined();
  });

  test('Call & response is disabled with its visible reason when no stem is the player’s', async () => {
    const b = await bed({stems: ['bass', 'vocals', 'other'], practice: CHORUS()});
    const call = b.radio(COPY.between, COPY.call);
    expect(call.getAttribute('aria-disabled')).toBe('true');
    call.click();
    expect(b.snap.loop.between).toBe('none');
    const reason = byRole(b.host, 'radiogroup', COPY.between).querySelector('.ui-segmented-reason');
    expect(reason.hidden).toBe(false);
    expect(reason.textContent).toBe(TRANSPORT_COPY.callNeedsPart);
    expect(call.getAttribute('aria-describedby')).toBe(reason.id);
    // Choosing an instrument the song has enables it.
    b.ts.setAccount({profile: {instruments: ['bass'], primary: 'bass', openWithMyPart: 'in'}});
    await settle();
    b.reg.invalidate?.();
    await vi.advanceTimersByTimeAsync(60);
    expect(b.radio(COPY.between, COPY.call).getAttribute('aria-disabled')).toBeNull();
  });

  test('Trainer… opens the Speed sheet, where the trainer lives', async () => {
    const b = await bed({practice: CHORUS()});
    b.click(COPY.trainer);
    expect(b.sheets).toEqual(['speed']);
  });
});

describe('Save as spot… and Clear', () => {
  test('Save as spot… opens an inline name pre-filled with the loop’s name; Enter saves it as the active spot', async () => {
    const b = await bed({practice: CHORUS()});
    b.click(COPY.saveAsSpot);
    const input = byRole(b.host, 'textbox', COPY.spotName);
    expect(input.value).toBe('Chorus');
    expect(document.activeElement).toBe(input);
    expect(b.button(COPY.saveAsSpot)).toBeNull();
    input.value = 'Chorus groove';
    keydown({key: 'Enter', code: 'Enter'}, {target: input});
    expect(b.ts.value.spots).toHaveLength(1);
    expect(b.ts.value.spots[0]).toMatchObject({name: 'Chorus groove', a: 32, b: 48, rate: 1});
    expect(b.ts.practice.activeSpotId.peek()).toBe(b.ts.value.spots[0].id);
    expect(b.statuses.at(-1).text).toBe('Saved spot Chorus groove · 100%');
    expect(byRole(b.host, 'textbox', COPY.spotName)).toBeNull();
    expect(document.activeElement).toBe(b.button(COPY.saveAsSpot));
    b.ts.undo.undo();
    expect(b.ts.value.spots.filter((s) => !s.deleted)).toHaveLength(0);
  });

  test('a bar range is pre-filled "Bars 21–23"; Esc and Cancel close without saving; an emptied name keeps the loop’s', async () => {
    const b = await bed({practice: practiceOf({cue: 40, loop: {on: true, a: 40, b: 46}})});
    b.click(COPY.saveAsSpot);
    let input = byRole(b.host, 'textbox', COPY.spotName);
    expect(input.value).toBe('Bars 21–23');
    keydown({key: 'Escape', code: 'Escape'}, {target: input});
    expect(byRole(b.host, 'textbox', COPY.spotName)).toBeNull();
    b.click(COPY.saveAsSpot);
    b.click(COPY.cancel);
    expect(byRole(b.host, 'textbox', COPY.spotName)).toBeNull();
    expect(b.ts.value.spots).toHaveLength(0);
    b.click(COPY.saveAsSpot);
    input = byRole(b.host, 'textbox', COPY.spotName);
    input.value = '   ';
    b.click(COPY.save);
    expect(b.ts.value.spots[0].name).toBe('Bars 21–23');
  });

  test('clearing the loop elsewhere closes the inline name', async () => {
    const b = await bed({practice: CHORUS()});
    b.click(COPY.saveAsSpot);
    b.ts.transport.clearLoop();
    await settle();
    expect(byRole(b.host, 'textbox', COPY.spotName)).toBeNull();
    expect(b.button(COPY.saveAsSpot)).toBeNull();
  });

  test('Clear loop is undoable: "Loop cleared" with Undo in the status line', async () => {
    const b = await bed({practice: CHORUS()});
    b.click(COPY.clear);
    expect(b.snap.loop.on).toBe(false);
    expect(b.range()).toBe(COPY.noLoop);
    const status = b.statuses.at(-1);
    expect(status.text).toBe(COPY.cleared);
    expect(status.action.label).toBe(COPY.undo);
    status.action.run();
    expect(b.snap.loop).toMatchObject({on: true, a: 32, b: 48});
    expect(b.range()).toBe('Bars 17–24 · Chorus (8 bars)');
  });
});

describe('in the sheets host', () => {
  test('openSheet("loop") renders the card in the Loop sheet; loop.card opens it from the Stage', async () => {
    const ts = await createTestSession({clock, practice: CHORUS()});
    current.push(() => ts.dispose());
    const handle = openSheet('loop', {session: ts.session});
    await settle();
    await vi.advanceTimersByTimeAsync(10);
    const sheet = document.querySelector('[data-sheet="loop"]');
    expect(sheet).toBeTruthy();
    expect(sheet.querySelector('.loop-card-range').textContent).toBe('Bars 17–24 · Chorus (8 bars)');
    expect(openSheetName()).toBe('loop');
    handle.close();
    expect(document.querySelector('.loop-card')).toBeNull();
  });

  test('destroy removes the card and stops following the transport', async () => {
    const b = await bed({practice: CHORUS()});
    b.card.destroy();
    expect(b.host.querySelector('.loop-card')).toBeNull();
    b.ts.transport.clearLoop();
    await settle();
    expect(b.host.children).toHaveLength(0);
  });

  test('without a session the card says there is no loop', () => {
    const host = document.body.appendChild(document.createElement('div'));
    const card = render(host, {session: null});
    expect(host.textContent).toBe(COPY.noLoop);
    card.destroy();
    expect(host.textContent).toBe('');
  });
});
