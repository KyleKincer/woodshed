// @vitest-environment happy-dom
// ST8b's sheets (architecture §2.14.11, §4.6, D22, D23, D44; spec §4.4C, §4.7, §5.1.3): the Spots list,
// the Notes card, Tap the beat and the Get bars popover, rendered on real song sessions
// (tests/helpers/test-session.js: SongMapStore, Metronome and MultitrackEngine over fake audio, the
// transport, position, practice state, undo and detect flow). Commands run through a registry with
// the real transport and Stage definitions; keys go through the real dispatcher. Sizes, colours and
// placement (the 160×160 pad, 17 px notes, the 320 px card) are Playwright states (ST8b.cjs).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('signalsmith-stretch', async () => ({default: (await import('./helpers/fake-audio.js')).fakeSignalsmith}));
vi.mock('../src/js/stemcache.js', async () => ({...(await import('./helpers/fake-audio.js')).fakeStemcache, isDecodeError: () => false}));

import {createRegistry} from '../src/app/commands.js';
import {startDispatcher} from '../src/app/dispatch.js';
import {clock as appClock} from '../src/app/clock.js';
import {signal} from '../src/app/store.js';
import {defineTransportCommands} from '../src/stage/transport-commands.js';
import {defineStageCommands} from '../src/stage/commands.js';
import {COPY as DETECT_COPY} from '../src/stage/detect.js';
import {closeSheets, openSheet} from '../src/stage/sheets/host.js';
import {closeAllMenus} from '../src/ui/menu.js';
import {COPY, CONTROLS, formatDownbeat} from '../src/stage/sheets/sheets-b.copy.js';
import * as spotsSheet from '../src/stage/sheets/spots.js';
import * as notesSheet from '../src/stage/sheets/notes.js';
import * as tapSheet from '../src/stage/sheets/tap-beat.js';
import * as getBarsSheet from '../src/stage/sheets/get-bars.js';
import {FAKE_TIMERS, createClock, installFakeAudio} from './helpers/fake-audio.js';
import {createTestSession, settle} from './helpers/test-session.js';
import {legacySongMap} from './fixtures/maps.js';
import {installPopoverShim, keydown, pointer, restoreDomShims} from './helpers/dom.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const DAY = 86_400_000;

let clock, restoreAudio, current = [];

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  vi.setSystemTime(NOW);
  appClock.set();
  restoreAudio = installFakeAudio();
  clock = createClock();
  installPopoverShim();
});

afterEach(async () => {
  closeAllMenus();
  closeSheets();
  for (const off of current.splice(0).reverse()) await off();
  document.body.replaceChildren();
  delete document.documentElement.dataset.place;
  delete document.documentElement.dataset.posture;
  restoreDomShims();
  restoreAudio();
  vi.useRealTimers();
});

/* ---------- helpers ---------- */

/** A v2 practice blob. */
function practiceOf(fields = {}) {
  return {v: 2, cue: 0, rate: 1, tracks: [], minusMe: false, trainer: null, spots: [], markers: [], ...fields,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none', ...(fields.loop ?? {})}};
}

const BRIDGE = {id: 'spot-bridge', name: 'Bridge walk-up', a: 80, b: 96, rate: 0.85, passes: 14, lastAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY};
const FILL = {id: 'spot-fill', name: 'Fill into the chorus', a: 28, b: 32, rate: 1, passes: 0, updatedAt: NOW - DAY};

/** The accessible name: aria-label, aria-labelledby, else the text without aria-hidden parts. */
function nameOf(el) {
  const label = el.getAttribute('aria-label');
  if (label) return label.trim();
  const by = el.getAttribute('aria-labelledby');
  if (by) return by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
  const walk = (node) => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || node.getAttribute('aria-hidden') === 'true' || node.hidden) return '';
    return [...node.childNodes].map(walk).join('');
  };
  return walk(el).replace(/\s+/g, ' ').trim();
}
const ROLE = {button: 'button, [role=button]', link: 'a[href]', list: 'ul, ol, [role=list]', region: '[role=region]', menuitem: '[role=menuitem]',
  textbox: 'input[type=text], textarea, [role=textbox]'};
const visible = (el) => !el.closest('[hidden]');
const byRole = (root, role, name) => [...root.querySelectorAll(ROLE[role])].filter(visible).find((el) => nameOf(el) === name) ?? null;
const allByRole = (root, role) => [...root.querySelectorAll(ROLE[role])].filter(visible);
const textOf = (el) => el.textContent.replace(/\s+/g, ' ').trim();

/**
 * A session, a registry with the transport and Stage commands, the providers the Stage gives them,
 * and recorders for the stage's openSheet, the router and feedback.
 */
async function bed({practice = null, stage: stageExtra = {}, ...options} = {}) {
  const ts = await createTestSession({clock, practice, ...options});
  const registry = createRegistry();
  const offs = [defineTransportCommands({registry}), defineStageCommands({registry, later: {}})];
  const opened = [];
  const navigations = [];
  const toasts = [];
  const statuses = [];
  const feedback = {
    toast: vi.fn((text, opts = {}) => { toasts.push({text, ...opts}); }),
    status: vi.fn((text, opts = {}) => { statuses.push({text, ...opts}); }),
  };
  const router = {navigate: vi.fn((path) => { navigations.push(path); })};
  const stage = {openSheet: (name) => { opened.push(name); return {close() {}}; }, batch: (fn) => fn(), ...stageExtra};
  offs.push(
    registry.provide('session', () => ts.session),
    registry.provide('transport', () => ts.session.transport),
    registry.provide('stage', () => stage),
    registry.provide('router', () => router),
    registry.provide('feedback', () => feedback),
  );
  document.documentElement.dataset.place = 'stage';
  document.documentElement.dataset.posture = 'stage';
  current.push(async () => { for (const off of offs.reverse()) off(); await ts.dispose(); });
  return {ts, session: ts.session, registry, opened, navigations, router, feedback, toasts, statuses, stage};
}

/** Renders one sheet module into a fresh container. */
function mountSheet(module, b, extra = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const close = vi.fn();
  const handle = module.render(container, {session: b.session, close, registry: b.registry, feedback: b.feedback, devices: b.ts.library.devices, ...extra});
  current.push(() => { handle.destroy(); container.remove(); });
  return {container, close, handle};
}

/** Lets registry invalidation (50 ms) and microtasks run. */
async function flush(ms = 60) {
  await settle();
  vi.advanceTimersByTime(ms);
  await settle();
}

/* ---------- copy ---------- */

describe('sheets-b copy', () => {
  test('formatDownbeat rounds to hundredths as m:ss.ss', () => {
    expect(formatDownbeat(0.413)).toBe('0:00.41');
    expect(formatDownbeat(72.5)).toBe('1:12.50');
    expect(formatDownbeat(59.996)).toBe('1:00.00');
    expect(formatDownbeat(NaN)).toBe('0:00.00');
  });

  test.each([
    ['2 days ago', 14, 'practised 2 days ago · 14 times'],
    ['yesterday', 1, 'practised yesterday · 1 time'],
    ['just now', 0, 'practised just now'],
    ['', 3, '3 times'],
    ['', 0, 'not practised yet'],
  ])('practised(%j, %i) → %j', (when, passes, out) => {
    expect(COPY.spots.practised(when, passes)).toBe(out);
  });

  test('spot ranges, the live tempo and the tap result', () => {
    expect(COPY.spots.bars(41, 48)).toBe('bars 41–48');
    expect(COPY.spots.bars(5, 5)).toBe('bar 5');
    expect(COPY.spots.bars(null, 2)).toBe('pickup–bar 2');
    expect(COPY.tap.live(92, 6)).toBe('≈ 92 bpm · 6 taps');
    expect(COPY.tap.live(null, 1)).toBe('1 tap');
    expect(COPY.tap.result(92, '4/4', 0.41)).toBe('92 bpm · 4/4 · first downbeat 0:00.41');
  });

  test('tapTempo fits the period over the tap index', () => {
    expect(tapSheet.tapTempo([1, 1.5, 2, 2.5])).toBe(120);
    expect(tapSheet.tapTempo([0, 0.652, 1.304, 1.956, 2.608])).toBe(92);
    expect(tapSheet.tapTempo([3])).toBeNull();
    expect(tapSheet.tapTempo([])).toBeNull();
  });
});

/* ---------- the controls table ---------- */

describe('CONTROLS (spec §4.7, §5.1.3, §4.4C): every row renders with its role and accessible name', () => {
  const MODULES = {spots: spotsSheet, notes: notesSheet, tapBeat: tapSheet, getBars: getBarsSheet};

  async function sheetFor(row) {
    const b = await bed({practice: practiceOf({spots: [BRIDGE]}), mapped: row.sheet !== 'getBars',
      ...(row.when === 'failed' ? {devices: 'online'} : {}),
      song: {notes: 'Watch the flam into the chorus.', musicalKey: 'A minor', tuning: 'Standard', tags: ['drums']}});
    const m = mountSheet(MODULES[row.sheet], b);
    await flush();
    if (row.when === 'tray') {
      const main = m.container.querySelector('.spots-main');
      const touch = {pointerType: 'touch', pointerId: 5, isPrimary: true};
      pointer(main, 'pointerdown', {...touch, x: 260, y: 30});
      for (const x of [240, 200, 180]) pointer(main, 'pointermove', {...touch, x, y: 31});
      pointer(main, 'pointerup', {...touch, x: 180, y: 31});
      await flush();
      return {b, root: m.container.querySelector('.spots-tray')};
    }
    if (row.when === 'rename') {
      m.handle.actions.startRename(BRIDGE.id);
      return {b, root: m.container};
    }
    if (row.when === 'failed') {
      byRole(m.container, 'button', COPY.getBars.detect).click();
      await flush();
      b.ts.server.failJob(b.ts.server.jobRows.at(-1).jobId, 'unknown', 'Detection failed.');
      await flush();
      return {b, root: m.container.querySelector('[role=alert]')};
    }
    if (row.when === 'menu') {
      byRole(m.container, 'button', COPY.spots.more(BRIDGE.name)).click();
      await flush();
      return {b, root: document.body};
    }
    if (row.when === 'result') {
      await b.ts.play();
      for (let i = 0; i < 4; i++) { if (i) await b.ts.advance(0.5); m.handle.tap(); }
      m.handle.finish();
    }
    return {b, root: m.container};
  }

  test.each(CONTROLS.map((row) => [row.sheet, row.role, row.name, row]))('%s: %s “%s”', async (_s, role, name, row) => {
    const {b, root} = await sheetFor(row);
    const el = byRole(root, role, name);
    expect(el, `${row.sheet} ${role} ${name}`).not.toBeNull();
    if (row.command) {
      expect(b.registry.get(row.command), row.command).not.toBeNull();
      const spy = vi.spyOn(b.registry, 'run');
      el.click();
      if (b.registry.state(row.command)?.enabled) expect(spy).toHaveBeenCalledWith(row.command, expect.objectContaining({source: 'pointer'}));
      else expect(spy).not.toHaveBeenCalledWith(row.command, expect.anything());
    }
  });
});

/* ---------- Spots ---------- */

describe('Spots list', () => {
  test('rows read name · bars 41–48 · 85% · practised 2 days ago · 14 times · ▶, in song order', async () => {
    const b = await bed({practice: practiceOf({spots: [BRIDGE, FILL]})});
    const {container} = mountSheet(spotsSheet, b);
    const list = byRole(container, 'list', COPY.spots.list);
    expect(list).not.toBeNull();
    const rows = [...list.children];
    expect(rows.map((r) => r.dataset.spotId)).toEqual(['spot-fill', 'spot-bridge']);
    const bridge = rows[1];
    expect(textOf(bridge.querySelector('.spots-detail'))).toBe('bars 41–48 · 85% · practised 2 days ago · 14 times');
    expect(textOf(rows[0].querySelector('.spots-detail'))).toBe('bars 15–16 · 100% · not practised yet');
    const open = byRole(bridge, 'button', BRIDGE.name);
    expect(open.getAttribute('aria-describedby')).toBe(bridge.querySelector('.spots-detail').id);
    expect(open.querySelector('.spots-play svg')).not.toBeNull();
    expect(byRole(container, 'button', COPY.spots.save).getAttribute('aria-keyshortcuts')).toBe('B');
  });

  test('an unmapped song reads the span in seconds and never says “Bar”', async () => {
    const b = await bed({mapped: false, practice: practiceOf({spots: [{...FILL, a: 31.2, b: 41}]})});
    const {container} = mountSheet(spotsSheet, b);
    expect(textOf(container.querySelector('.spots-detail'))).toBe('0:31.2–0:41.0 · 100% · not practised yet');
    expect(container.textContent).not.toMatch(/\bBar|bar /);
  });

  test('selecting a spot sets loop, speed and cue in one undo step, makes it active and closes', async () => {
    const b = await bed({practice: practiceOf({spots: [BRIDGE]})});
    const {container, close} = mountSheet(spotsSheet, b);
    byRole(container, 'button', BRIDGE.name).click();
    await flush();
    const snap = b.ts.snapshot;
    expect(snap.loop).toMatchObject({on: true, a: 80, b: 96});
    expect(snap.rate).toBe(0.85);
    expect(snap.cue).toBe(80);
    expect(b.session.practice.activeSpotId.peek()).toBe(BRIDGE.id);
    expect(close).toHaveBeenCalledTimes(1);
    expect(b.session.undo.size.undo).toBe(1);
    const reopened = mountSheet(spotsSheet, b);
    const row = reopened.container.querySelector('[data-spot-id="spot-bridge"]');
    expect(row.hasAttribute('data-active')).toBe(true);
    expect(textOf(row.querySelector('.spots-active'))).toBe(COPY.spots.active);
    expect(byRole(row, 'button', BRIDGE.name).getAttribute('aria-current')).toBe('true');
  });

  test('opening a spot and looping it 3 times shows 3 more passes (createTestSession)', async () => {
    const spot = {...BRIDGE, a: 80, b: 84, rate: 1};
    const b = await bed({practice: practiceOf({spots: [spot]})});
    mountSheet(spotsSheet, b).container.querySelector('.spots-open').click();
    await flush();
    const {container} = mountSheet(spotsSheet, b);
    const detail = () => textOf(container.querySelector('.spots-detail'));
    expect(detail()).toBe('bars 41–42 · 100% · practised 2 days ago · 14 times');
    await b.ts.play();
    await b.ts.advance(4 * 3 + 0.2);
    expect(b.ts.passes()).toBe(3);
    await flush();
    expect(detail()).toBe('bars 41–42 · 100% · practised just now · 17 times');
    expect(b.ts.value.spots[0].passes).toBe(17);
    expect(b.ts.value.spots[0].lastAt).toBeGreaterThan(NOW);
    // The pass counter is not an undo step: only the open is.
    expect(b.session.undo.size.undo).toBe(1);
  });

  test('right-click → Rename edits the name inline (Enter commits; one undo step)', async () => {
    const b = await bed({practice: practiceOf({spots: [BRIDGE]})});
    const {container} = mountSheet(spotsSheet, b);
    const row = container.querySelector('.spots-row');
    row.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40}));
    await flush();
    const items = allByRole(document.body, 'menuitem').map(nameOf);
    expect(items).toEqual([COPY.spots.rename, COPY.spots.update, COPY.spots.delete]);
    byRole(document.body, 'menuitem', COPY.spots.rename).click();
    await flush();
    const input = row.querySelector('.spots-rename-input');
    expect(row.hasAttribute('data-renaming')).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(BRIDGE.name);
    expect(input.getAttribute('data-consume-keys')).toContain('Escape');
    input.value = 'Bridge fill';
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true, cancelable: true}));
    await flush();
    expect(b.ts.value.spots[0].name).toBe('Bridge fill');
    expect(row.hasAttribute('data-renaming')).toBe(false);
    expect(textOf(row.querySelector('.spots-name'))).toBe('Bridge fill');
    expect(b.session.undo.size.undo).toBe(1);
    const entry = b.session.undo.undo();
    expect(entry.describe()).toBe('rename spot Bridge walk-up → Bridge fill');
    await flush();
    expect(b.ts.value.spots.find((s) => !s.deleted).name).toBe(BRIDGE.name);
  });

  test('Escape cancels a rename without a change', async () => {
    const b = await bed({practice: practiceOf({spots: [BRIDGE]})});
    const {container, handle} = mountSheet(spotsSheet, b);
    handle.actions.startRename(BRIDGE.id);
    const input = container.querySelector('.spots-rename-input');
    input.value = 'Nope';
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true, cancelable: true}));
    await flush();
    expect(b.ts.value.spots[0].name).toBe(BRIDGE.name);
    expect(b.session.undo.size.undo).toBe(0);
  });

  test('Update from current takes the loop and speed; disabled with a reason when no loop is on', async () => {
    const b = await bed({practice: practiceOf({spots: [BRIDGE]})});
    const {container} = mountSheet(spotsSheet, b);
    byRole(container, 'button', COPY.spots.more(BRIDGE.name)).click();
    await flush();
    const update = byRole(document.body, 'menuitem', COPY.spots.update);
    expect(update.getAttribute('aria-disabled')).toBe('true');
    expect(document.body.textContent).toContain(COPY.spots.needsLoop);
    closeAllMenus();
    b.session.transport.loopRange(20, 28, {snap: 'none'});
    b.session.transport.setSpeed(0.7, {coalesce: false});
    await flush();
    const undoBefore = b.session.undo.size.undo;
    byRole(container, 'button', COPY.spots.more(BRIDGE.name)).click();
    await flush();
    byRole(document.body, 'menuitem', COPY.spots.update).click();
    await flush();
    expect(b.ts.value.spots[0]).toMatchObject({a: 20, b: 28, rate: 0.7});
    expect(b.ts.value.spots[0].aBar).toBeTruthy();
    expect(b.session.practice.activeSpotId.peek()).toBe(BRIDGE.id);
    expect(b.session.undo.size.undo).toBe(undoBefore + 1);
    expect(b.statuses.at(-1).text).toBe(COPY.spots.updated(BRIDGE.name, 0.7));
    expect(textOf(container.querySelector('.spots-detail'))).toMatch(/^bars 11–14 · 70%/);
  });

  test('Delete shows an undo toast whose Undo brings the spot back', async () => {
    const b = await bed({practice: practiceOf({spots: [BRIDGE, FILL]})});
    const {container, handle} = mountSheet(spotsSheet, b);
    handle.actions.remove(BRIDGE.id);
    await flush();
    expect(container.querySelector('[data-spot-id="spot-bridge"]')).toBeNull();
    expect(b.ts.value.spots.find((s) => s.id === BRIDGE.id).deleted).toBe(true);
    const toast = b.toasts.at(-1);
    expect(toast.text).toBe(COPY.spots.deleted(BRIDGE.name));
    expect(toast.action.label).toBe(COPY.spots.undo);
    expect(toast.durationMs).toBe(spotsSheet.DELETE_TOAST_MS);
    expect(spotsSheet.DELETE_TOAST_MS).toBe(8000);
    toast.action.run();
    await flush();
    expect(b.ts.value.spots.find((s) => s.id === BRIDGE.id).deleted).toBeUndefined();
    expect(container.querySelector('[data-spot-id="spot-bridge"]')).not.toBeNull();
    // Undo ran through practice.undo, which reports "Undid: delete spot …" with Redo.
    expect(b.toasts.at(-1).text).toBe(`Undid: ${COPY.spots.describeDelete(BRIDGE.name)}`);
  });

  test('the Delete toast’s Undo undoes that delete even after a later step (and leaves the later step)', async () => {
    const b = await bed({practice: practiceOf({spots: [BRIDGE, FILL]})});
    const {container, handle} = mountSheet(spotsSheet, b);
    handle.actions.remove(BRIDGE.id);
    await flush();
    b.session.transport.setSpeed(0.7, {coalesce: false});
    await flush();
    expect(b.ts.snapshot.rate).toBe(0.7);
    const before = b.session.undo.size.undo;
    b.toasts.find((t) => t.key === 'spot-delete').action.run();
    await flush();
    expect(b.ts.value.spots.find((s) => s.id === BRIDGE.id).deleted).toBeUndefined();
    expect(container.querySelector('[data-spot-id="spot-bridge"]')).not.toBeNull();
    expect(b.ts.snapshot.rate).toBe(0.7);                 // the speed change is not what got undone
    expect(b.statuses.at(-1).text).toBe(COPY.spots.restored(BRIDGE.name));
    expect(b.session.undo.size.undo).toBe(before + 1);    // the restore is a step of its own
    // Cmd+Z now takes the restore back, then the speed change.
    expect(b.session.undo.undo().describe()).toBe(COPY.spots.describeRestore(BRIDGE.name));
    expect(b.ts.value.spots.find((s) => s.id === BRIDGE.id).deleted).toBe(true);
    b.session.undo.undo();
    await flush();
    expect(b.ts.snapshot.rate).toBe(1);
  });

  test('the Delete toast’s Undo does nothing when Cmd+Z already brought the spot back', async () => {
    const b = await bed({practice: practiceOf({spots: [BRIDGE]})});
    const {handle} = mountSheet(spotsSheet, b);
    handle.actions.remove(BRIDGE.id);
    b.session.undo.undo();
    await flush();
    expect(b.ts.value.spots[0].deleted).toBeUndefined();
    const size = b.session.undo.size;
    b.toasts.find((t) => t.key === 'spot-delete').action.run();
    await flush();
    expect(b.session.undo.size).toEqual(size);
    expect(b.ts.value.spots[0].deleted).toBeUndefined();
  });

  test('undoing a rename keeps passes earned since; other spots are untouched', async () => {
    const spot = {...BRIDGE, a: 80, b: 84, rate: 1};
    const b = await bed({practice: practiceOf({spots: [spot, FILL]})});
    const {handle} = mountSheet(spotsSheet, b);
    handle.actions.rename(spot.id, 'Bridge 2');
    handle.actions.open(spot.id);
    await flush();
    await b.ts.play();
    await b.ts.advance(4 * 3 + 0.2);
    await flush();
    expect(b.ts.value.spots.find((s) => s.id === spot.id).passes).toBe(17);
    b.session.undo.undo();   // the open
    b.session.undo.undo();   // the rename
    await flush();
    const after = b.ts.value.spots.find((s) => s.id === spot.id);
    expect(after.name).toBe(BRIDGE.name);
    expect(after.passes).toBe(17);
    expect(after.lastAt).toBeGreaterThan(NOW);
    b.session.undo.redo();   // the rename again
    expect(b.ts.value.spots.find((s) => s.id === spot.id)).toMatchObject({name: 'Bridge 2', passes: 17});
  });

  test('undoing Update from current puts back only the range and speed', async () => {
    const b = await bed({practice: practiceOf({spots: [BRIDGE]})});
    const {handle} = mountSheet(spotsSheet, b);
    b.session.transport.loopRange(20, 28, {snap: 'none'});
    await flush();
    handle.actions.updateFromCurrent(BRIDGE.id);
    b.session.practice.touchSpot(BRIDGE.id, {passes: 2});
    b.session.undo.undo();
    const after = b.ts.value.spots[0];
    expect(after).toMatchObject({a: 80, b: 96, rate: 0.85, passes: 16});
    expect(after.aBar).toBeUndefined();
  });

  test('undoing the delete of the active spot makes it active again, so its passes count', async () => {
    const spot = {...BRIDGE, a: 80, b: 84, rate: 1};
    const b = await bed({practice: practiceOf({spots: [spot]})});
    const {handle} = mountSheet(spotsSheet, b);
    handle.actions.open(spot.id);
    await flush();
    expect(b.session.practice.activeSpotId.peek()).toBe(spot.id);
    handle.actions.remove(spot.id);
    expect(b.session.practice.activeSpotId.peek()).toBeNull();
    b.toasts.find((t) => t.key === 'spot-delete').action.run();
    await flush();
    expect(b.session.practice.activeSpotId.peek()).toBe(spot.id);
    await b.ts.play();
    await b.ts.advance(4 * 2 + 0.2);
    await flush();
    expect(b.ts.value.spots[0].passes).toBe(16);
  });

  test('a spot starting in the lead-in before bar 1 reads pickup, as the loop label does', async () => {
    const b = await bed({tempo: legacySongMap.tempo, duration: legacySongMap.duration,
      practice: practiceOf({spots: [{...FILL, a: 0.2, b: 5}]})});
    const {container} = mountSheet(spotsSheet, b);
    expect(textOf(container.querySelector('.spots-range'))).toBe('pickup–bar 2');
    expect(b.session.position.loopLabel(0.2, 5)).toBe('Pickup–bar 2');
  });

  test.each([['Shift+F10', {key: 'F10', code: 'F10', shiftKey: true}], ['ContextMenu', {key: 'ContextMenu', code: 'ContextMenu'}]])(
    '%s on a focused row opens Rename / Update from current / Delete', async (_n, spec) => {
      const b = await bed({practice: practiceOf({spots: [BRIDGE]})});
      const {container} = mountSheet(spotsSheet, b);
      const open = byRole(container, 'button', BRIDGE.name);
      open.focus();
      keydown(spec, {target: open});
      await flush();
      expect(allByRole(document.body, 'menuitem').map(nameOf)).toEqual([COPY.spots.rename, COPY.spots.update, COPY.spots.delete]);
    });

  test('after a rename the context menu is labelled with the new name', async () => {
    const b = await bed({practice: practiceOf({spots: [BRIDGE]})});
    const {container, handle} = mountSheet(spotsSheet, b);
    handle.actions.rename(BRIDGE.id, 'Bridge fill');
    await flush();
    const open = byRole(container, 'button', 'Bridge fill');
    keydown({key: 'F10', code: 'F10', shiftKey: true}, {target: open});
    await flush();
    const menu = document.querySelector('[role=menu]');
    expect(menu.getAttribute('aria-label')).toBe(COPY.spots.actions('Bridge fill'));
  });

  test('a sideways swipe on touch opens the row’s action tray; its Delete removes the spot', async () => {
    const b = await bed({practice: practiceOf({spots: [BRIDGE]})});
    const {container, close} = mountSheet(spotsSheet, b);
    const row = container.querySelector('.spots-row');
    const main = row.querySelector('.spots-main');
    const touch = {pointerType: 'touch', pointerId: 7, isPrimary: true};
    pointer(main, 'pointerdown', {...touch, x: 260, y: 30});
    for (const x of [250, 230, 200, 180]) pointer(main, 'pointermove', {...touch, x, y: 32});
    pointer(main, 'pointerup', {...touch, x: 180, y: 32});
    row.querySelector('.spots-open').click();   // the click after the swipe is not a selection
    await flush();
    expect(close).not.toHaveBeenCalled();
    expect(row.hasAttribute('data-revealed')).toBe(true);
    const tray = row.querySelector('[role=group]');
    expect(nameOf(tray)).toBe(COPY.spots.actions(BRIDGE.name));
    expect(allByRole(tray, 'button').map(nameOf)).toEqual([COPY.spots.rename, COPY.spots.update, COPY.spots.delete]);
    byRole(tray, 'button', COPY.spots.delete).click();
    await flush();
    expect(b.ts.value.spots[0].deleted).toBe(true);
    expect(byRole(container, 'list', COPY.spots.list)).toBeNull();
    expect(textOf(container.querySelector('.spots-empty'))).toContain(COPY.spots.emptyTitle);
  });

  test('a vertical drag is a scroll, never a swipe', async () => {
    const b = await bed({practice: practiceOf({spots: [BRIDGE]})});
    const {container} = mountSheet(spotsSheet, b);
    const main = container.querySelector('.spots-main');
    const touch = {pointerType: 'touch', pointerId: 3, isPrimary: true};
    pointer(main, 'pointerdown', {...touch, x: 200, y: 30});
    pointer(main, 'pointermove', {...touch, x: 190, y: 80});
    pointer(main, 'pointermove', {...touch, x: 120, y: 90});
    pointer(main, 'pointerup', {...touch, x: 120, y: 90});
    await flush();
    expect(container.querySelector('.spots-row').hasAttribute('data-revealed')).toBe(false);
  });

  test('empty: the note and Save spot (B) saves the loop, and the list follows live', async () => {
    const b = await bed({practice: practiceOf({loop: {on: true, a: 32, b: 48}})});
    const {container} = mountSheet(spotsSheet, b);
    expect(byRole(container, 'list', COPY.spots.list)).toBeNull();
    expect(textOf(container.querySelector('.spots-empty'))).toBe(`${COPY.spots.emptyTitle}${COPY.spots.emptyBody}`);
    byRole(container, 'button', COPY.spots.save).click();
    await flush();
    const rows = container.querySelectorAll('.spots-row');
    expect(rows).toHaveLength(1);
    expect(textOf(rows[0].querySelector('.spots-name'))).toBe('Chorus');
    expect(textOf(rows[0].querySelector('.spots-detail'))).toBe('bars 17–24 · 100% · not practised yet');
    expect(rows[0].hasAttribute('data-active')).toBe(true);
  });

  test('a spot with a note shows it; a shared song says changes stay on this device', async () => {
    const b = await bed({shared: {token: 'tok'}, practice: practiceOf({spots: [{...BRIDGE, note: 'Ghost notes on the snare'}]})});
    const {container} = mountSheet(spotsSheet, b);
    expect(textOf(container.querySelector('.spots-note'))).toBe('Ghost notes on the snare');
    const shared = container.querySelector('.spots-shared');
    expect(shared.hidden).toBe(false);
    expect(textOf(shared)).toBe(COPY.spots.readOnly);
  });

  test('relative times refresh while the list stays open', async () => {
    const b = await bed({practice: practiceOf({spots: [{...BRIDGE, lastAt: NOW - 30_000}]})});
    const {container} = mountSheet(spotsSheet, b);
    expect(textOf(container.querySelector('.spots-practised'))).toBe('practised just now · 14 times');
    vi.advanceTimersByTime(spotsSheet.REFRESH_MS * 3);
    appClock.set();
    expect(textOf(container.querySelector('.spots-practised'))).toBe('practised 3 min ago · 14 times');
  });

  test('through the host (J): one sheet titled Spots', async () => {
    const b = await bed({practice: practiceOf({spots: [BRIDGE]})});
    const handle = openSheet('spots', {session: b.session});
    await flush();
    const sheet = document.querySelector('[data-sheet=spots]');
    expect(sheet).not.toBeNull();
    expect(sheet.querySelector('.ui-sheet-title').textContent).toBe('Spots');
    expect(sheet.querySelector('.spots-row')).not.toBeNull();
    handle.close();
    expect(document.querySelector('.spots')).toBeNull();
  });
});

/* ---------- Notes ---------- */

describe('Notes card', () => {
  const SONG = {notes: 'Watch the flam into the chorus.\nRide bell on the triplets.', musicalKey: 'A minor', tuning: 'Standard', tags: ['drums', 'setlist']};

  test('shows the practice notes, key, tuning and tags; an owner gets Edit details', async () => {
    const b = await bed({song: SONG});
    const {container, close} = mountSheet(notesSheet, b);
    await flush();
    expect(container.querySelector('.notes-text').textContent).toBe(SONG.notes);
    expect(container.querySelector('.notes-text').classList.contains('selectable')).toBe(true);
    const facts = [...container.querySelectorAll('.notes-fact-label')].map(textOf);
    expect(facts).toEqual(['Key', 'Tuning', 'Tags']);
    expect([...container.querySelectorAll('.notes-tag')].map(textOf)).toEqual(['drums', 'setlist']);
    expect(container.querySelector('.notes-empty').hidden).toBe(true);
    const edit = byRole(container, 'button', COPY.notes.edit);
    expect(edit).not.toBeNull();
    edit.click();
    expect(b.navigations).toEqual([`/s/${b.session.id}/edit/details`]);
    expect(close).toHaveBeenCalled();
  });

  test('follows the song live and says when there is nothing', async () => {
    const b = await bed({song: {notes: '', tags: []}});
    const {container} = mountSheet(notesSheet, b);
    await flush();
    expect(container.querySelector('.notes-empty').hidden).toBe(false);
    expect(container.querySelector('.notes-facts').hidden).toBe(true);
    b.ts.server.pushSong({notes: 'Count the bridge in 7.', tuning: 'Drop D'});
    await flush();
    expect(container.querySelector('.notes-text').textContent).toBe('Count the bridge in 7.');
    expect([...container.querySelectorAll('.notes-fact-value')].map(textOf)).toEqual(['Drop D']);
    expect(container.querySelector('.notes-empty').hidden).toBe(true);
  });

  test('the active spot’s note shows under the song’s notes', async () => {
    const b = await bed({song: SONG, practice: practiceOf({spots: [{...BRIDGE, note: 'Lead with the left'}]})});
    const {container} = mountSheet(notesSheet, b);
    expect(container.querySelector('.notes-spot').hidden).toBe(true);
    b.session.practice.activeSpotId.value = BRIDGE.id;
    await flush();
    expect(container.querySelector('.notes-spot').hidden).toBe(false);
    expect(textOf(container.querySelector('.notes-spot-label'))).toBe(COPY.notes.spotNote(BRIDGE.name));
    expect(textOf(container.querySelector('.notes-spot-text'))).toBe('Lead with the left');
  });

  test('a shared song has no Edit details', async () => {
    const b = await bed({shared: {token: 'tok'}, song: SONG});
    const {container} = mountSheet(notesSheet, b);
    await flush();
    expect(byRole(container, 'button', COPY.notes.edit)).toBeNull();
    expect(container.querySelector('.notes-text').textContent).toBe(SONG.notes);
  });

  test('through the host: a non-modal card in the music’s notes host, open until closed', async () => {
    const b = await bed({song: SONG});
    const stageRoot = document.createElement('div');
    stageRoot.dataset.stageLayout = 'rail';
    const host = document.createElement('div');
    host.setAttribute('data-notes-host', '');
    stageRoot.append(host);
    document.body.append(stageRoot);
    openSheet('notes', {session: b.session});
    await flush();
    const card = host.querySelector('.stage-notes-card');
    expect(card).not.toBeNull();
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.hasAttribute('aria-modal')).toBe(false);
    expect(card.querySelector('.notes-text').textContent).toBe(SONG.notes);
    // Playing does not close it, and the registry keys still reach the Stage (non-modal, D36).
    await b.ts.play();
    await b.ts.advance(1);
    expect(host.querySelector('.stage-notes-card')).toBe(card);
    closeSheets();
    expect(host.querySelector('.stage-notes-card')).toBeNull();
  });
});

/* ---------- Tap the beat ---------- */

describe('Tap the beat', () => {
  /** Mounts the sheet with the real dispatcher running. */
  async function tapBed(options = {}) {
    const b = await bed({mapped: false, ...options});
    const stop = startDispatcher({registry: b.registry});
    current.push(() => stop());
    const m = mountSheet(tapSheet, b);
    await settle();
    const pad = byRole(m.container, 'button', COPY.tap.padLabel);
    return {...b, ...m, pad, live: () => textOf(m.container.querySelector('.tap-live'))};
  }

  /** n taps on the pad by key, `gap` seconds apart (audio time). */
  async function tapKeys(t, n, {gap = 0.5, code = 'KeyT'} = {}) {
    for (let i = 0; i < n; i++) {
      if (i) await t.ts.advance(gap);
      keydown({code}, {target: t.pad});
    }
  }

  test('the pad: role button, focused on open, consumes T and Space; the intro copy', async () => {
    const t = await tapBed();
    expect(document.activeElement).toBe(t.pad);
    expect(t.pad.getAttribute('data-consume-keys').split(' ')).toEqual(expect.arrayContaining(['Space', 'KeyT']));
    expect(textOf(t.container.querySelector('.tap-intro'))).toBe(COPY.tap.intro);
    expect(t.live()).toBe(COPY.tap.notPlaying);
  });

  test('a tap while stopped asks for Play and counts nothing', async () => {
    const t = await tapBed();
    keydown({code: 'KeyT'}, {target: t.pad});
    expect(t.handle.taps).toEqual([]);
    expect(t.live()).toBe(COPY.tap.notPlaying);
  });

  test('T and Space tap while playing (Space does not stop the song); the tempo reads live', async () => {
    const t = await tapBed();
    byRole(t.container, 'button', 'Play').click();
    await settle();
    expect(t.ts.snapshot.phase).toBe('playing');
    expect(t.live()).toBe(COPY.tap.waiting);
    await t.ts.advance(1);
    keydown({code: 'KeyT'}, {target: t.pad});
    expect(t.live()).toBe('1 tap');
    await t.ts.advance(0.5);
    keydown({code: 'Space'}, {target: t.pad});
    expect(t.ts.snapshot.phase).toBe('playing');
    expect(t.live()).toBe('≈ 120 bpm · 2 taps');
    await t.ts.advance(0.5);
    pointer(t.pad, 'pointerdown', {pointerType: 'touch', x: 10, y: 10});
    await t.ts.advance(0.5);
    keydown({code: 'KeyT'}, {target: t.pad});
    expect(t.live()).toBe('≈ 120 bpm · 4 taps');
    // Song positions, half a second apart (the engine reports the audible position).
    const tapped = t.handle.taps;
    expect(tapped.slice(1).map((x, i) => Math.round((x - tapped[i]) * 100) / 100)).toEqual([0.5, 0.5, 0.5]);
    expect(tapped[0]).toBeGreaterThan(0.8);
    expect(t.container.querySelector('.tap-result').hidden).toBe(true);
  });

  test('after the taps pause, the result reads “120 bpm · 4/4 · first downbeat …” with its actions', async () => {
    const t = await tapBed();
    await t.ts.play();
    await t.ts.advance(0.41);
    await tapKeys(t, 6);
    await t.ts.advance(tapSheet.FINISH_IDLE_MS / 1000 + 0.05);
    const result = t.container.querySelector('.tap-result');
    expect(result.hidden).toBe(false);
    expect(textOf(result.querySelector('.tap-result-line'))).toBe(`120 bpm · 4/4 · first downbeat ${formatDownbeat(t.handle.taps[0])}`);
    expect(t.handle.taps[0]).toBeGreaterThan(0.3);
    for (const name of [COPY.tap.useIt, COPY.tap.tryAgain, COPY.tap.openEditor]) expect(byRole(result, 'button', name), name).not.toBeNull();
    expect(result.querySelector('.tap-replaces').hidden).toBe(true);   // the song had no grid
  });

  test('[Use it] builds the map through mapChange: one practice-undo step, origin tapped, the markers offer', async () => {
    const t = await tapBed({practice: practiceOf({markers: [{id: 'm1', t: 12, label: 'Groove', updatedAt: 1}, {id: 'm2', t: 40, label: 'Fill', updatedAt: 1}]})});
    expect(t.session.map.isReal).toBe(false);
    await t.ts.play();
    await t.ts.advance(0.5);
    await tapKeys(t, 8);
    t.handle.finish();
    const undoBefore = t.session.undo.size.undo;
    byRole(t.container, 'button', COPY.tap.useIt).click();
    await flush();
    expect(t.session.map.isReal).toBe(true);
    expect(t.session.map.data.origin).toBe('tapped');
    expect(Math.round(t.session.map.data.tailQpm)).toBe(120);
    expect(t.session.undo.size.undo).toBe(undoBefore + 1);
    expect(t.close).toHaveBeenCalledTimes(1);
    const texts = t.ts.statuses.map((s) => s.text);
    expect(texts).toContain(COPY.tap.applied(120));
    expect(texts).toContain('Turn 2 markers into sections');
    // The saved tempo carries the tapped map (debounced 400 ms).
    await t.ts.advance(0.5);
    expect(t.ts.server.calls.saveTempo.at(-1).tempo.songMap.origin).toBe('tapped');
    // One Undo takes it all back.
    t.session.undo.undo();
    expect(t.session.map.isReal).toBe(false);
  });

  test('on a mapped song the result warns that it replaces the grid', async () => {
    const t = await tapBed({mapped: true});
    await t.ts.play();
    await t.ts.advance(1);
    await tapKeys(t, 5, {gap: 0.6});
    t.handle.finish();
    expect(t.container.querySelector('.tap-replaces').hidden).toBe(false);
    expect(textOf(t.container.querySelector('.tap-result-line'))).toMatch(/^100 bpm · 4\/4 · first downbeat /);
  });

  test('fewer than 4 taps: “Tap at least 4 beats.”', async () => {
    const t = await tapBed();
    await t.ts.play();
    await tapKeys(t, 3);
    await t.ts.advance(tapSheet.FINISH_IDLE_MS / 1000 + 0.05);
    expect(t.live()).toBe(COPY.tap.tooFew);
    expect(t.container.querySelector('.tap-result').hidden).toBe(true);
  });

  test('stopping the song with 4 or more taps shows the result at once', async () => {
    const t = await tapBed();
    await t.ts.play();
    await tapKeys(t, 4);
    t.session.transport.stop();
    await flush();
    expect(t.container.querySelector('.tap-result').hidden).toBe(false);
  });

  test('a tap behind the last one (a wrap or a seek) starts a new run', async () => {
    const t = await tapBed();
    await t.ts.play();
    await t.ts.advance(10);
    await tapKeys(t, 3);
    t.session.transport.seek(2);
    await t.ts.advance(0.2);
    keydown({code: 'KeyT'}, {target: t.pad});
    expect(t.handle.taps).toHaveLength(1);
    expect(t.live()).toBe('1 tap');
  });

  test('[Try again] clears the taps; [Open map editor] goes to Edit · Map', async () => {
    const t = await tapBed();
    await t.ts.play();
    await tapKeys(t, 4);
    t.handle.finish();
    byRole(t.container, 'button', COPY.tap.tryAgain).click();
    expect(t.handle.taps).toEqual([]);
    expect(t.container.querySelector('.tap-result').hidden).toBe(true);
    expect(document.activeElement).toBe(t.pad);
    await tapKeys(t, 4);
    t.handle.finish();
    byRole(t.container, 'button', COPY.tap.openEditor).click();
    expect(t.navigations).toEqual([`/s/${t.session.id}/edit/map`]);
    expect(t.close).toHaveBeenCalled();
  });

  test('a refused map change keeps the sheet open with the reason', async () => {
    const t = await tapBed();
    await t.ts.play();
    await tapKeys(t, 4);
    t.handle.finish();
    const spy = vi.spyOn(t.session, 'mapChange').mockImplementation(() => { throw new Error('This drum chart’s bars no longer fit.'); });
    byRole(t.container, 'button', COPY.tap.useIt).click();
    expect(spy).toHaveBeenCalledWith(COPY.tap.label, expect.any(Function), expect.anything());
    expect(t.close).not.toHaveBeenCalled();
    const alert = t.container.querySelector('[role=alert]');
    expect(textOf(alert)).toContain('This drum chart’s bars no longer fit.');
  });

  test('after the sheet’s own Play, T and Space on the focused element tap (the focus returns to the pad)', async () => {
    const t = await tapBed();
    const play = byRole(t.container, 'button', 'Play');
    play.focus();
    play.click();
    await settle();
    expect(t.ts.snapshot.phase).toBe('playing');
    expect(document.activeElement).toBe(t.pad);
    await t.ts.advance(0.5);
    keydown({code: 'KeyT', key: 't'});
    await t.ts.advance(0.5);
    keydown({code: 'Space', key: ' '});
    expect(t.handle.taps).toHaveLength(2);
    expect(t.ts.snapshot.phase).toBe('playing');
  });
});

/* ---------- Get bars ---------- */

describe('Get bars popover', () => {
  test('web without a computer: Detect disabled with the reason; the download link; Tap and Find enabled', async () => {
    const b = await bed({mapped: false});
    const {container} = mountSheet(getBarsSheet, b);
    await flush();
    expect(textOf(container.querySelector('.getbars-intro'))).toBe(COPY.getBars.unmapped);
    const detect = byRole(container, 'button', COPY.getBars.detect);
    expect(detect.getAttribute('aria-disabled')).toBe('true');
    expect(textOf(detect.querySelector('.ui-button-reason'))).toBe(DETECT_COPY.needsDesktop);
    expect(detect.getAttribute('aria-describedby')).toBe(detect.querySelector('.ui-button-reason').id);
    const link = byRole(container, 'link', COPY.getBars.getDesktop);
    expect(link.getAttribute('href')).toBe('/download');
    expect(byRole(container, 'button', COPY.getBars.tap).getAttribute('aria-disabled')).toBeNull();
    expect(byRole(container, 'button', COPY.getBars.find).getAttribute('aria-disabled')).toBeNull();
    detect.click();
    expect(b.ts.server.calls.createBeatDetection).toEqual([]);
  });

  test('web with an online paired computer: Detect runs there, then shows its progress', async () => {
    const b = await bed({mapped: false, devices: 'online'});
    const {container} = mountSheet(getBarsSheet, b);
    await flush();
    const detect = byRole(container, 'button', COPY.getBars.detect);
    expect(detect.getAttribute('aria-disabled')).toBeNull();
    expect(textOf(container.querySelector('.getbars-option:nth-child(2) .getbars-body'))).toBe(COPY.getBars.detectRemote('Studio Mac'));
    expect(byRole(container, 'link', COPY.getBars.getDesktop)).toBeNull();
    detect.click();
    await flush();
    expect(b.ts.server.calls.createBeatDetection.at(-1)).toMatchObject({songId: b.session.id, deviceId: 'device-online'});
    const jobId = b.ts.server.jobRows.at(-1).jobId;
    expect(container.querySelector('.getbars').hasAttribute('data-detecting')).toBe(true);
    expect(textOf(container.querySelector('.getbars-progress-line'))).toBe(DETECT_COPY.waiting);
    b.ts.server.progressJob(jobId, 30);
    await flush();
    expect(textOf(container.querySelector('.getbars-progress-line'))).toBe('Finding bars · 30%');
    expect(container.querySelector('.ui-progress-rail-fill').style.getPropertyValue('--progress')).toBe('0.3');
    expect(byRole(container, 'button', COPY.getBars.detect).getAttribute('aria-disabled')).toBe('true');
  });

  test('desktop with a ready processor: Detect is enabled and runs on this computer', async () => {
    // This computer's companion is one of the paired devices too (its /status deviceId).
    const desktop = {available: true, processor: signal({phase: 'ready', deviceId: 'device-local'})};
    const b = await bed({mapped: false, desktop, devices: [{deviceId: 'device-local', name: 'This Mac', state: 'idle', lastSeenAt: NOW}]});
    const {container} = mountSheet(getBarsSheet, b, {desktop});
    expect(b.session.detect.canDetect.peek()).toEqual({ok: true, deviceId: 'device-local'});
    await flush();
    expect(byRole(container, 'button', COPY.getBars.detect).getAttribute('aria-disabled')).toBeNull();
    expect(textOf(container.querySelector('.getbars-option:nth-child(2) .getbars-body'))).toBe(COPY.getBars.detectBody);
    expect(byRole(container, 'link', COPY.getBars.getDesktop)).toBeNull();
  });

  test('desktop whose processor is not running: Detect disabled with the processor reason, no download link', async () => {
    const desktop = {available: true, processor: signal({phase: 'stopped'})};
    const b = await bed({mapped: false, desktop});
    const {container} = mountSheet(getBarsSheet, b, {desktop});
    await flush();
    const detect = byRole(container, 'button', COPY.getBars.detect);
    expect(detect.getAttribute('aria-disabled')).toBe('true');
    expect(textOf(detect.querySelector('.ui-button-reason'))).toBe(DETECT_COPY.processorOffline);
    expect(byRole(container, 'link', COPY.getBars.getDesktop)).toBeNull();
  });

  test('a paused (export-only) account on the web gets no download link', async () => {
    const b = await bed({mapped: false, accountStatus: 'export_only'});
    const {container} = mountSheet(getBarsSheet, b);
    await flush();
    expect(b.session.detect.canDetect.peek()).toMatchObject({ok: false, reason: DETECT_COPY.exportOnly});
    expect(byRole(container, 'link', COPY.getBars.getDesktop)).toBeNull();
  });

  test('a failed detection shows describeError’s sentence and [Try again] retries the job', async () => {
    const b = await bed({mapped: false, devices: 'online'});
    const {container} = mountSheet(getBarsSheet, b);
    await flush();
    byRole(container, 'button', COPY.getBars.detect).click();
    await flush();
    const jobId = b.ts.server.jobRows.at(-1).jobId;
    b.ts.server.failJob(jobId, 'unknown', 'Detection failed.');
    await flush();
    const alert = container.querySelector('[role=alert]');
    expect(alert).not.toBeNull();
    expect(textOf(alert.querySelector('.ui-status-text')).length).toBeGreaterThan(0);
    const retry = [...alert.querySelectorAll('button')].find((el) => textOf(el) === COPY.getBars.retry);
    retry.click();
    await flush();
    expect(b.ts.server.calls.retry.at(-1)).toMatchObject({jobId});
  });

  test('Tap the beat… opens that sheet; Find a chart… goes to Edit · Map’s Find panel', async () => {
    const b = await bed({mapped: false});
    const {container, close} = mountSheet(getBarsSheet, b);
    await flush();
    byRole(container, 'button', COPY.getBars.tap).click();
    expect(b.opened).toEqual(['tapBeat']);
    byRole(container, 'button', COPY.getBars.find).click();
    expect(b.navigations).toEqual([`/s/${b.session.id}/edit/map/find`]);
    expect(close).toHaveBeenCalled();
  });

  test('a mapped song: the intro offers to replace the grid', async () => {
    const b = await bed({mapped: true, desktop: true});
    const {container} = mountSheet(getBarsSheet, b);
    await flush();
    expect(textOf(container.querySelector('.getbars-intro'))).toBe(COPY.getBars.mapped);
  });

  test('detectDescription names the paired computer, else this one', () => {
    const devices = [{deviceId: 'd1', name: 'Studio Mac'}, {deviceId: 'd2', name: ''}];
    expect(getBarsSheet.detectDescription({ok: true, deviceId: 'd1'}, {devices})).toBe(COPY.getBars.detectRemote('Studio Mac'));
    expect(getBarsSheet.detectDescription({ok: true, deviceId: 'd2'}, {devices})).toBe(COPY.getBars.detectRemoteUnnamed);
    expect(getBarsSheet.detectDescription({ok: true}, {devices, desktopAvailable: true})).toBe(COPY.getBars.detectBody);
    // This computer's own companion is listed among the paired devices: still "this computer".
    expect(getBarsSheet.detectDescription({ok: true, deviceId: 'd1'}, {devices, desktopAvailable: true, localDeviceId: 'd1'})).toBe(COPY.getBars.detectBody);
    expect(getBarsSheet.detectDescription({ok: true, deviceId: 'd1'}, {devices, desktopAvailable: true, localDeviceId: 'd9'})).toBe(COPY.getBars.detectRemote('Studio Mac'));
    expect(getBarsSheet.detectDescription({ok: false, reason: 'x'}, {devices})).toBe(COPY.getBars.detectGeneric);
  });
});
