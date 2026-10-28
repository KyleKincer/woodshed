// The Loop card (architecture §2.14.11, spec §4.7, D17): long-press Loop, the slim loop chip or
// the HUD Loop line open it (loop.card) through the sheets host (sheets/host.js).
//
//   render(container, {session, close, registry?, feedback?}) → {destroy()}
//
// Rows, top to bottom:
//   the Loop switch (transport.loopToggle, L) and the range: 'Bars 13–20 · Chorus (8 bars)' |
//     '0:31.2–0:41.0 (9.8 s)', or what L would do when there is no loop yet;
//   Loop in here / Loop out here: at the playhead, or the cue when stopped (loop.in I, loop.out O);
//   Start ◀ ▶ and End ◀ ▶ (transport.nudgeLoopEdge): by bar, Alt by beat (mapped); by 0.1 s,
//     Alt 50 ms, Alt+Shift 10 ms (unmapped); Alt+Enter on a focused nudge button moves by the fine unit;
//   ◀ Move 8 bars / Move 8 bars ▶ (loop.moveBack ⇧[, loop.moveFwd ⇧]): by the loop's own length;
//   Count in every pass (loop.eachPass), with a note while Count-in is off;
//   Play N times then stop: Off · 2 · 4 · 8 (loop.playTimes {n});
//   Between passes: None · 1 bar rest (2 s rest unmapped) · Call & response (loop.between {mode}),
//     Call & response disabled with its visible reason when no stem is the player's (D17);
//   Trainer… (speed.sheet: the trainer lives in the Speed sheet);
//   Save as spot… (B): an inline name field pre-filled 'Chorus' or 'Bars 13–20'; Enter saves, Esc cancels;
//   Clear loop (loop.clear, ⌫): undoable, with "Loop cleared · Undo" in the status line.
// Every row follows the transport snapshot live; the card never pauses playback.

import '../../styles/views/stage/sheets-loop.css';
import {registry as appRegistry} from '../../app/commands.js';
import {feedback as appFeedback} from '../../app/feedback.js';
import {effect} from '../../app/store.js';
import {h} from '../../ui/h.js';
import {Button, IconButton} from '../../ui/button.js';
import {Toggle} from '../../ui/toggle.js';
import {Segmented} from '../../ui/segmented.js';
import {TextField} from '../../ui/field.js';
import {formatTenths} from '../position.js';
import {COPY as TRANSPORT_COPY} from '../transport-commands.js';
import {saveSpot, loopLength, boundUndo} from '../menus.js';
import {MAX_NAME} from '../../../shared/practice.ts';

const EPS = 1e-6;
/** The End edge reads the beat just inside the loop (its end is exclusive). */
const END_INSIDE = 1e-3;
let seq = 0;

/** The card's copy (spec §4.7; the row lists no .copy.js, so it lives here, §9.0). */
export const COPY = Object.freeze({
  title: 'Loop',
  loop: 'Loop',
  noLoop: 'No loop yet.',
  emptySections: 'L loops the section you are in, or set the start and end at the playhead.',
  emptyPhrase: 'L loops the 4 bars you are in, or set the start and end at the playhead.',
  emptyUnmapped: 'L loops 10 s around the playhead, or set the start and end at the playhead.',
  loopOff: 'Loop is off. L turns it on.',
  loopIn: 'Loop in here',
  loopOut: 'Loop out here',
  start: 'Start',
  end: 'End',
  earlier: (edge, unit) => `${edge} ${unit} earlier`,
  later: (edge, unit) => `${edge} ${unit} later`,
  unitBar: 'a bar',
  unitTenth: '0.1 s',
  fineMapped: 'Hold Alt to move by a beat.',
  fineUnmapped: 'Hold Alt for 50 ms, Alt+Shift for 10 ms.',
  move: (len) => `Move ${len}`,
  moveBackName: (len) => `Move ${len} back`,
  moveFwdName: (len) => `Move ${len} forward`,
  eachPass: TRANSPORT_COPY.eachPass,
  eachPassOff: 'Count-in is off (C), so passes start without one.',
  playTimes: TRANSPORT_COPY.playTimes,
  playOff: 'Off',
  between: TRANSPORT_COPY.between,
  none: 'None',
  rest: '1 bar rest',
  restUnmapped: '2 s rest',
  call: 'Call & response',
  callNeedsPart: TRANSPORT_COPY.callNeedsPart,
  trainer: 'Trainer…',
  saveAsSpot: 'Save as spot…',
  spotName: 'Spot name',
  save: 'Save',
  cancel: 'Cancel',
  clear: TRANSPORT_COPY.clearLoop,
  cleared: 'Loop cleared',
  undo: 'Undo',
});

/**
 * The card's controls (§9.0): role and accessible name. `when` lists what the row needs: 'range' (a
 * loop exists), 'mapped', 'unmapped', 'form' (the inline spot name is open), 'noform' (it is not).
 * The Move rows' names carry the loop's length: the table's examples are an 8-bar loop and a 9.8 s one.
 */
const ctl = (role, name, extra = {}) => Object.freeze({role, name, ...extra});
export const CONTROLS = Object.freeze([
  ctl('button', COPY.loop, {command: 'transport.loopToggle', pressed: true}),
  ctl('button', COPY.loopIn, {command: 'loop.in'}),
  ctl('button', COPY.loopOut, {command: 'loop.out'}),
  ctl('button', COPY.earlier(COPY.start, COPY.unitBar), {when: 'range mapped'}),
  ctl('button', COPY.later(COPY.start, COPY.unitBar), {when: 'range mapped'}),
  ctl('button', COPY.earlier(COPY.end, COPY.unitBar), {when: 'range mapped'}),
  ctl('button', COPY.later(COPY.end, COPY.unitBar), {when: 'range mapped'}),
  ctl('button', COPY.earlier(COPY.start, COPY.unitTenth), {when: 'range unmapped'}),
  ctl('button', COPY.later(COPY.start, COPY.unitTenth), {when: 'range unmapped'}),
  ctl('button', COPY.earlier(COPY.end, COPY.unitTenth), {when: 'range unmapped'}),
  ctl('button', COPY.later(COPY.end, COPY.unitTenth), {when: 'range unmapped'}),
  ctl('button', COPY.moveBackName('8 bars'), {command: 'loop.moveBack', when: 'range mapped'}),
  ctl('button', COPY.moveFwdName('8 bars'), {command: 'loop.moveFwd', when: 'range mapped'}),
  ctl('button', COPY.moveBackName('9.8 s'), {command: 'loop.moveBack', when: 'range unmapped'}),
  ctl('button', COPY.moveFwdName('9.8 s'), {command: 'loop.moveFwd', when: 'range unmapped'}),
  ctl('button', COPY.eachPass, {command: 'loop.eachPass', pressed: true}),
  ctl('radiogroup', COPY.playTimes, {command: 'loop.playTimes'}),
  ctl('radio', COPY.playOff), ctl('radio', '2'), ctl('radio', '4'), ctl('radio', '8'),
  ctl('radiogroup', COPY.between, {command: 'loop.between'}),
  ctl('radio', COPY.none), ctl('radio', COPY.rest, {when: 'mapped'}), ctl('radio', COPY.restUnmapped, {when: 'unmapped'}), ctl('radio', COPY.call),
  ctl('button', COPY.trainer, {command: 'speed.sheet'}),
  ctl('button', COPY.saveAsSpot, {when: 'range noform'}),
  ctl('textbox', COPY.spotName, {when: 'range form'}),
  ctl('button', COPY.save, {when: 'range form'}),
  ctl('button', COPY.cancel, {when: 'range form'}),
  ctl('button', COPY.clear, {command: 'loop.clear', when: 'range'}),
]);

const PLAY_TIMES = Object.freeze([0, 2, 4, 8]);
const hasRange = (loop) => !!loop && Number.isFinite(loop.a) && Number.isFinite(loop.b) && loop.b - loop.a > EPS;
const feedbackOf = (registry, given) => {
  if (given) return given;
  try { return registry.context().feedback ?? appFeedback; } catch { return appFeedback; }
};

/** The nudge unit for an edge button press: mapped bar / beat (Alt); unmapped 0.1 s, 50 ms (Alt), 10 ms (Alt+Shift). */
export function nudgeUnit(mapped, {altKey = false, shiftKey = false} = {}) {
  if (mapped) return altKey ? 'beat' : 'bar';
  if (altKey && shiftKey) return '10ms';
  return altKey ? '50ms' : 'tenth';
}

export function render(container, {session, close, registry = appRegistry, feedback} = {}) {
  const fb = feedbackOf(registry, feedback);
  const id = `loop-card-${++seq}`;
  const destroyers = [];
  const own = (primitive) => { destroyers.push(() => primitive.destroy()); return primitive; };
  const transport = session?.transport ?? null;
  const position = session?.position ?? null;
  if (!transport || !position) {
    const el = h('p', {class: 'loop-card-empty'}, COPY.noLoop);
    container.replaceChildren(el);
    return {destroy() { el.remove(); }};
  }
  const snapshot = () => transport.snapshot.peek();
  const mapped = () => !!session.map?.isReal;

  // ---------------- head: the switch and the range ----------------
  const loopSwitch = own(Toggle({label: COPY.loop, command: 'transport.loopToggle', kbd: true, registry, size: 'lg', className: 'loop-card-switch'}));
  const range = h('p', {class: 'loop-card-range', id: `${id}-range`});
  const hint = h('p', {class: 'loop-card-hint'});
  const head = h('div', {class: 'loop-card-head'}, h('div', {class: 'loop-card-range-wrap'}, range, hint), loopSwitch.el);

  // ---------------- in / out at the playhead ----------------
  const inBtn = own(Button({command: 'loop.in', label: COPY.loopIn, icon: false, kbd: true, registry, size: 'lg'}));
  const outBtn = own(Button({command: 'loop.out', label: COPY.loopOut, icon: false, kbd: true, registry, size: 'lg'}));
  const setRow = h('div', {class: 'loop-card-row loop-card-set'}, inBtn.el, outBtn.el);

  // ---------------- edges ----------------
  function edgeGroup(edge, name) {
    const labelId = `${id}-${edge}`;
    const value = h('span', {class: 'loop-card-edge-value tabular'});
    const nudge = (dir) => (e) => transport.nudgeLoopEdge(edge, dir, nudgeUnit(mapped(), e ?? {}));
    const earlier = own(IconButton({label: COPY.earlier(name, COPY.unitBar), icon: 'chevron-left', variant: 'secondary', size: 'lg', onClick: nudge(-1)}));
    const later = own(IconButton({label: COPY.later(name, COPY.unitBar), icon: 'chevron-right', variant: 'secondary', size: 'lg', onClick: nudge(1)}));
    // Alt+Enter (Alt+Shift+Enter) on a focused nudge button moves by the fine unit; plain Enter and Space stay native.
    for (const [btn, dir] of [[earlier, -1], [later, 1]]) {
      btn.el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !e.altKey || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        nudge(dir)(e);
      });
    }
    const el = h('div', {class: 'loop-card-edge', role: 'group', 'aria-labelledby': labelId},
      h('span', {class: 'loop-card-edge-label', id: labelId}, name), earlier.el, value, later.el);
    return {
      el,
      update(t, isMapped) {
        const unit = isMapped ? COPY.unitBar : COPY.unitTenth;
        earlier.set({label: COPY.earlier(name, unit)});
        later.set({label: COPY.later(name, unit)});
        // Both edges read inclusively, like the range line: Start is the loop's first beat, End its last one
        // (bars 17–24 read 17 · 1 … 24 · 4, at the song's end too).
        const at = edge === 'b' && isMapped ? Math.max(t - END_INSIDE, snapshot().loop?.a ?? 0) : t;
        value.textContent = isMapped ? position.label(at).main : formatTenths(t);
      },
    };
  }
  const startEdge = edgeGroup('a', COPY.start);
  const endEdge = edgeGroup('b', COPY.end);
  const fine = h('p', {class: 'loop-card-fine'});
  const edges = h('div', {class: 'loop-card-edges'}, startEdge.el, endEdge.el, fine);

  // ---------------- move by length ----------------
  const moveBack = own(Button({command: 'loop.moveBack', kbd: true, registry, icon: 'chevron-left', label: COPY.move(''), size: 'lg'}));
  const moveFwd = own(Button({command: 'loop.moveFwd', kbd: true, registry, icon: false, iconEnd: 'chevron-right', label: COPY.move(''), size: 'lg'}));
  const moveRow = h('div', {class: 'loop-card-row loop-card-move'}, moveBack.el, moveFwd.el);

  // ---------------- options ----------------
  const eachPass = own(Toggle({label: COPY.eachPass, command: 'loop.eachPass', registry, size: 'lg', className: 'loop-card-each'}));
  const eachNote = h('p', {class: 'loop-card-note'}, COPY.eachPassOff);

  const timesId = `${id}-times`;
  const times = own(Segmented({
    attrs: {'aria-labelledby': timesId}, size: 'lg', value: snapshot().loop?.playTimes ?? 0,
    options: PLAY_TIMES.map((n) => ({value: n, label: n === 0 ? COPY.playOff : String(n)})),
    onChange: (n) => { registry.run('loop.playTimes', {source: 'pointer', args: {n}}); sync(); },
  }));
  const betweenId = `${id}-between`;
  const between = own(Segmented({
    attrs: {'aria-labelledby': betweenId}, size: 'lg', value: snapshot().loop?.between ?? 'none', options: betweenOptions(),
    onChange: (mode) => { registry.run('loop.between', {source: 'pointer', args: {mode}}); sync(); },
  }));
  function betweenOptions() {
    const state = registry.state('loop.between', registry.context({args: {mode: 'call'}}));
    const callReason = state?.reason ?? null;
    return [
      {value: 'none', label: COPY.none},
      {value: 'rest', label: mapped() ? COPY.rest : COPY.restUnmapped},
      {value: 'call', label: COPY.call, disabled: !!callReason, reason: callReason ?? undefined},
    ];
  }
  const options = h('div', {class: 'loop-card-options'},
    h('div', {class: 'loop-card-option'}, eachPass.el, eachNote),
    h('div', {class: 'loop-card-option'}, h('p', {class: 'loop-card-label', id: timesId}, COPY.playTimes), times.el),
    h('div', {class: 'loop-card-option'}, h('p', {class: 'loop-card-label', id: betweenId}, COPY.between), between.el));

  // ---------------- trainer, save as spot, clear ----------------
  const trainer = own(Button({command: 'speed.sheet', label: COPY.trainer, registry, icon: 'trainer', size: 'lg'}));
  const saveBtn = own(Button({label: COPY.saveAsSpot, icon: 'bookmark', kbd: 'KeyB', size: 'lg', onClick: () => openForm()}));
  const clearBtn = own(Button({command: 'loop.clear', label: COPY.clear, kbd: true, registry, icon: 'x', size: 'lg', onClick: () => cleared()}));
  const actions = h('div', {class: 'loop-card-row loop-card-actions'}, trainer.el, saveBtn.el, clearBtn.el);

  let form = null;   // {el, field, destroy}
  function openForm() {
    const loop = snapshot().loop;
    if (!hasRange(loop) || form) { form?.field.input.focus(); return; }
    const field = TextField({label: COPY.spotName, value: loop.label ?? '', maxLength: MAX_NAME, autocomplete: 'off', className: 'loop-card-name'});
    field.input.setAttribute('data-consume-keys', 'Escape');
    const submit = Button({label: COPY.save, variant: 'primary', size: 'lg', onClick: () => commitForm()});
    const cancel = Button({label: COPY.cancel, size: 'lg', onClick: () => closeForm({refocus: true})});
    field.input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); commitForm(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeForm({refocus: true}); }
    });
    const el = h('form', {class: 'loop-card-form', attrs: {'aria-label': COPY.saveAsSpot}, on: {submit: (e) => { e.preventDefault(); commitForm(); }}},
      field.el, h('div', {class: 'loop-card-form-actions'}, submit.el, cancel.el));
    form = {el, field, destroy() { field.destroy(); submit.destroy(); cancel.destroy(); el.remove(); }};
    saveBtn.el.hidden = true;
    actions.after(el);
    field.input.focus();
    field.input.select?.();
  }
  function closeForm({refocus = false} = {}) {
    if (!form) return;
    const had = form.el.contains(container.ownerDocument.activeElement);
    form.destroy();
    form = null;
    saveBtn.el.hidden = !hasRange(snapshot().loop);
    if (!had) return;
    // Focus stays in the card: Save as spot… when it is still there, else the Loop switch (the loop went away).
    if (refocus && !saveBtn.el.hidden) saveBtn.el.focus();
    else if (root.isConnected) loopSwitch.el.focus();
  }
  function commitForm() {
    if (!form) return;
    const loop = snapshot().loop;
    const name = form.field.input.value.trim() || loop.label || '';
    if (!hasRange(loop)) { closeForm(); return; }
    const spot = saveSpot(session, {a: loop.a, b: loop.b, name}, {registry, feedback: fb});
    if (spot) closeForm({refocus: true});
  }
  function cleared() {
    // Undo there undoes the clear only while it is still the latest step (never a newer change).
    const step = boundUndo(session, null, {registry, feedback: fb});
    fb.status?.(COPY.cleared, {key: 'loop-clear', action: {label: COPY.undo, run: () => step.run()}});
  }

  const editRows = h('div', {class: 'loop-card-edit'}, edges, moveRow);
  const root = h('section', {class: 'loop-card', id, attrs: {'aria-labelledby': `${id}-range`}, dataset: {loopCard: ''}},
    head, setRow, editRows, options, actions);
  container.replaceChildren(root);

  // B in the card opens the inline name (spec §4.7: "Save as spot… (inline name, pre-filled …; key B)"). The card
  // declares it consumes B while a loop exists, so the dispatcher leaves it to this handler rather than spot.save.
  root.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyB' || e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (form?.el.contains(e.target) && e.target.matches?.('input, textarea')) return;
    if (!hasRange(snapshot().loop)) return;
    e.preventDefault();
    openForm();
  });

  // ---------------- live state ----------------
  function emptyText() {
    if (!mapped()) return COPY.emptyUnmapped;
    return session.map.hasSections ? COPY.emptySections : COPY.emptyPhrase;
  }
  function sync() {
    const s = snapshot(), loop = s.loop ?? {};
    const isMapped = mapped();
    const ranged = hasRange(loop);
    root.dataset.mapped = String(isMapped);
    if (ranged) root.dataset.range = ''; else delete root.dataset.range;
    if (loop.on && ranged) root.dataset.on = ''; else delete root.dataset.on;
    range.textContent = ranged ? position.rangeLabel(loop.a, loop.b) : COPY.noLoop;
    hint.textContent = !ranged ? emptyText() : loop.on ? '' : COPY.loopOff;
    hint.hidden = !hint.textContent;
    editRows.hidden = !ranged;
    if (ranged) {
      startEdge.update(loop.a, isMapped);
      endEdge.update(loop.b, isMapped);
      const len = loopLength(session, loop);
      moveBack.set({label: COPY.move(len), attrs: {'aria-label': COPY.moveBackName(len)}});
      moveFwd.set({label: COPY.move(len), attrs: {'aria-label': COPY.moveFwdName(len)}});
    }
    fine.textContent = isMapped ? COPY.fineMapped : COPY.fineUnmapped;
    eachNote.hidden = !!s.countIn?.on;
    times.set({value: PLAY_TIMES.includes(loop.playTimes) ? loop.playTimes : 0});
    between.set({value: loop.between ?? 'none', options: betweenOptions()});
    saveBtn.el.hidden = !ranged || !!form;
    if (ranged) root.setAttribute('data-consume-keys', 'KeyB'); else root.removeAttribute('data-consume-keys');
    clearBtn.el.hidden = !ranged;
    if (!ranged && form) closeForm();
  }
  destroyers.push(effect(() => {
    transport.snapshot.value;
    position.revision?.value;
    position.mapped?.value;
    sync();
  }));
  destroyers.push(registry.onChange(() => between.set({options: betweenOptions()})));

  return {
    destroy() {
      closeForm();
      for (const off of destroyers.splice(0).reverse()) {
        try { off(); } catch (err) { console.error('[loop card] cleanup failed', err); }
      }
      root.remove();
    },
  };
}

