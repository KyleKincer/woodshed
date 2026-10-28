// The Speed sheet (spec §4.7 "Speed sheet"; architecture §2.14.3 rules 11 and 17, §2.14.11, D30, D59):
// the value with the bpm it gives, preset chips, fine −1 / +1, Keep pitch (per song) and the
// trainer (steppers, "Trains on: …", Start / Stop, its progress and the done line).
//
//   render(container, {session, close, layout?, registry?}) → {el, destroy()}
//     session   the song session (transport, map, position, practice, frame)
//     close     closes the sheet (sheets/host.js)
//     registry  the command registry (default the app registry): presets run `speed.set {rate}`,
//               −1 / +1 `speed.downFine` / `speed.upFine`, Start / Stop `trainer.toggle` (§3.1); each
//               control's disabled state and reason come from `registry.state(id, context({args}))`
//     layout    'band' | 'rail' (default: read from the sheet's presentation: a bottom sheet is
//               the band's, a popover the rail's). On the band a preset tap applies the speed and
//               closes the sheet (D59); ±1, Keep pitch and the trainer never close it.
//
// Every change goes through the transport (through those commands, or `setKeepPitch`), so it is
// one practice-undo step, saved with the song and applied to the engine (the speed range is
// 25–150%, D30). The trainer steppers edit a draft that Start trainer uses (`trainer.toggle` with
// the draft as args, rule 11); while the trainer runs, the draft waits for the next start. The
// draft always holds what the steppers show: a stored or palette trainer off the steppers' grid
// (72%, 20 passes) is snapped to it (`snapDraft`), so the plan line and the next start match. "Trains on" names the loop when it is on, else the current
// section, else the whole song (D28).
//
// Pure helpers (exported for tests): trainsOnText(session, snapshot), bpmText(session, rate, t),
// draftOf(session, snapshot), snapDraft(draft).

import '../../styles/views/stage/sheets-speed.css';
import {h} from '../../ui/h.js';
import {Button} from '../../ui/button.js';
import {Toggle} from '../../ui/toggle.js';
import {Stepper, snapValue} from '../../ui/stepper.js';
import {registry as appRegistry} from '../../app/commands.js';
import {TRAINER_DEFAULT, trainerRates} from '../transport.js';
import '../transport-commands.js';   // registers speed.set, speed.downFine / upFine and trainer.toggle
import {formatTenths} from '../position.js';
import {COPY, PRESETS, TRAINER_RANGE} from './sheets-a.copy.js';

const S = COPY.speed;
const EPS = 1e-6;
const EDGE_EPS = 0.01;
/** The bpm readout follows the playhead this often while playing (a text readout, §2.14.7). */
const BPM_HZ = 4;

let seq = 0;
const read = (sig) => (sig && typeof sig.peek === 'function' ? sig.peek() : null);
const pctOf = (rate) => Math.round((Number.isFinite(rate) ? rate : 1) * 100);

/** 'band' or 'rail' for the sheet holding `container` (a popover is the rail's). */
export function sheetLayout(container, layout) {
  if (layout === 'band' || layout === 'rail') return layout;
  const host = container?.closest?.('[data-presentation]');
  return host?.getAttribute('data-presentation') === 'popover' ? 'rail' : 'band';
}

/**
 * '84 bpm' for the felt tempo at the playhead `t` × rate on a mapped song, else '' (no bar grid, no
 * bpm). The same reading as the HUD's speed sub-line (hud.js): `map.bpmAt(map.positionAt(t))`, so a
 * tempo ramp reads the same in both.
 */
export function bpmText(session, rate, t) {
  const map = session?.map;
  if (!map?.isReal || !map.bars?.length || typeof map.bpmAt !== 'function' || typeof map.positionAt !== 'function') return '';
  const bpm = map.bpmAt(map.positionAt(Math.max(0, Number.isFinite(t) ? t : 0)));
  return Number.isFinite(bpm) && bpm > 0 ? S.bpm(Math.round(bpm * (Number.isFinite(rate) ? rate : 1))) : '';
}

/** 'bars 13–20' / 'bar 13' / 'pickup–bar 4' for [a, b) on the map. */
function barsWords(map, a, b) {
  const bars = map.bars;
  const first = bars[map.barIndexAt(a)], last = bars[map.barIndexAt(Math.max(a, b - 1e-3))];
  const x = first?.display ?? null, y = last?.display ?? null;
  if (first === last) return x === null ? 'pickup' : `bar ${x}`;
  return x === null ? `pickup–bar ${y}` : `bars ${x}–${y}`;
}

/**
 * What the trainer trains on (spec §4.7, D28): the loop when on ('Chorus (bars 17–24)',
 * 'Bars 13–20', '0:31.2–0:41.0'), else the current section ('Chorus (bars 17–24)'), else the
 * whole song. Unmapped songs never say "bar".
 */
export function trainsOnText(session, snapshot) {
  const map = session?.map;
  const mapped = !!map?.isReal && !!map.bars?.length;
  const loop = snapshot?.loop;
  if (loop?.on && loop.b - loop.a > EPS) {
    if (!mapped) return `${formatTenths(loop.a)}–${formatTenths(loop.b)}`;
    const section = map.hasSections ? map.sections.find((s) => Math.abs(s.t0 - loop.a) < EDGE_EPS && Math.abs(s.t1 - loop.b) < EDGE_EPS) : null;
    const words = barsWords(map, loop.a, loop.b);
    return section ? `${section.name} (${words})` : words.replace(/^./, (c) => c.toUpperCase());
  }
  if (mapped && map.hasSections) {
    const t = typeof session.transport?.position === 'function' ? session.transport.position() : snapshot?.cue ?? 0;
    const section = map.sectionAt(Number.isFinite(t) ? t : 0);
    if (section) return `${section.name} (${barsWords(map, section.t0, section.t1)})`;
  }
  return S.wholeSong;
}

const FIELD_RANGE = Object.freeze({start: TRAINER_RANGE.rate, end: TRAINER_RANGE.rate, step: TRAINER_RANGE.step, passes: TRAINER_RANGE.passes});

/** A draft (percent) on the steppers' grid: each field clamped and snapped exactly as its Stepper shows it. */
export function snapDraft(draft) {
  const out = {};
  for (const [key, range] of Object.entries(FIELD_RANGE)) out[key] = snapValue(draft[key], range);
  return out;
}

/**
 * The trainer configuration the steppers start from, in percent and on the steppers' grid: the
 * running one, else the song's, else the default.
 */
export function draftOf(session, snapshot) {
  return snapDraft(rawDraftOf(session, snapshot));
}

function rawDraftOf(session, snapshot) {
  const cfg = snapshot?.trainer ?? read(session?.practice?.value)?.trainer ?? TRAINER_DEFAULT;
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    start: Math.round(num(cfg.start, TRAINER_DEFAULT.start) * 100),
    end: Math.round(num(cfg.end, TRAINER_DEFAULT.end) * 100),
    step: Math.round(num(cfg.step, TRAINER_DEFAULT.step) * 100),
    passes: Math.round(num(cfg.passes, TRAINER_DEFAULT.passes)),
  };
}

const cfgOf = (draft) => ({start: draft.start / 100, end: draft.end / 100, step: draft.step / 100, passes: draft.passes});
const sameDraft = (a, b) => a.start === b.start && a.end === b.end && a.step === b.step && a.passes === b.passes;

/** The Speed sheet (see the header). */
export function render(container, {session, close, layout = null, registry = appRegistry} = {}) {
  if (!session?.transport) throw new TypeError('speed sheet: a session with a transport is required');
  const transport = session.transport;
  const id = `sheet-speed-${++seq}`;
  const offs = [];
  const parts = [];
  const snap = () => read(transport.snapshot) ?? {};
  /** A command's state for these args (§3.1; the I1b handoff's per-option rule). */
  const stateOf = (cmd, args) => registry.state(cmd, registry.context(args === undefined ? {} : {args}));
  const run = (cmd, args) => registry.run(cmd, {source: 'pointer', ...(args === undefined ? {} : {args})});
  const presetArgs = (n) => ({rate: n / 100});

  // ---- the value ---------------------------------------------------------------------------------------------
  const value = h('span', {class: 'sheet-speed-value tabular', id: `${id}-value`});
  const bpm = h('span', {class: 'sheet-speed-bpm tabular'});
  const readout = h('p', {class: 'sheet-speed-readout'}, value, bpm);

  // ---- presets -----------------------------------------------------------------------------------------------
  const presetButtons = PRESETS.map((n) => {
    const b = Button({label: S.preset(n), size: 'lg', variant: 'secondary', className: 'sheet-speed-preset', pressed: false,
      dataset: {preset: String(n)},
      onClick: () => {
        if (!run('speed.set', presetArgs(n))) return;
        if (sheetLayout(container, layout) === 'band') close?.();
      }});
    parts.push(b);
    return {n, b};
  });
  const presets = h('div', {class: 'sheet-speed-presets', role: 'group', attrs: {'aria-label': S.presets}}, presetButtons.map((x) => x.b.el));

  // ---- fine −1 / +1 ------------------------------------------------------------------------------------------
  const slower = Button({label: S.slower, command: 'speed.downFine', registry, size: 'lg', className: 'sheet-speed-fine-button'});
  const faster = Button({label: S.faster, command: 'speed.upFine', registry, size: 'lg', className: 'sheet-speed-fine-button'});
  parts.push(slower, faster);
  const fine = h('div', {class: 'sheet-speed-fine', role: 'group', attrs: {'aria-label': S.fine}}, slower.el, faster.el);

  // ---- keep pitch --------------------------------------------------------------------------------------------
  const pitchHint = h('p', {class: 'sheet-speed-hint', id: `${id}-pitch-hint`}, S.keepPitchHint);
  const keepPitch = Toggle({label: S.keepPitch, size: 'lg', className: 'sheet-speed-pitch-toggle', pressed: !!snap().keepPitch,
    attrs: {'aria-describedby': pitchHint.id},
    onChange: (pressed) => { transport.setKeepPitch(pressed); update(); }});
  parts.push(keepPitch);
  const pitch = h('div', {class: 'sheet-speed-pitch'}, keepPitch.el, pitchHint);

  // ---- trainer -----------------------------------------------------------------------------------------------
  let draft = draftOf(session, snap());
  const stepper = (key, label, range, format) => {
    const labelId = `${id}-${key}`;
    const s = Stepper({label, value: draft[key], min: range.min, max: range.max, step: range.step, bigStep: range.step * 2, format,
      size: 'md', className: 'sheet-speed-stepper', decLabel: S.decrease(label), incLabel: S.increase(label),
      onChange: (v) => { draft = {...draft, [key]: v}; update(); }});
    parts.push(s);
    const field = h('div', {class: 'sheet-speed-field', dataset: {field: key}},
      h('span', {class: 'sheet-speed-field-label', id: labelId, attrs: {'aria-hidden': 'true'}}, label), s.el);
    return {s, field};
  };
  const steppers = {
    start: stepper('start', S.start, TRAINER_RANGE.rate, S.percent),
    end: stepper('end', S.end, TRAINER_RANGE.rate, S.percent),
    step: stepper('step', S.step, TRAINER_RANGE.step, S.stepValue),
    passes: stepper('passes', S.passes, TRAINER_RANGE.passes, S.passesValue),
  };
  const plan = h('p', {class: 'sheet-speed-plan'});
  const trainsOn = h('p', {class: 'sheet-speed-trains-on'});
  const progress = h('p', {class: 'sheet-speed-progress tabular'});
  const pending = h('p', {class: 'sheet-speed-hint'}, S.pendingChanges);
  const trainerButton = Button({label: S.startTrainer, size: 'lg', variant: 'primary', className: 'sheet-speed-trainer-button',
    onClick: () => {
      // trainer.toggle: with a configuration it starts one; without, it stops the running trainer.
      run('trainer.toggle', snap().trainer ? undefined : cfgOf(draft));
      update();
    }});
  parts.push(trainerButton);
  const headingId = `${id}-trainer`;
  const trainer = h('section', {class: 'sheet-speed-trainer', attrs: {'aria-labelledby': headingId}},
    h('h3', {class: 'sheet-speed-heading', id: headingId}, S.trainer),
    h('div', {class: 'sheet-speed-steppers'}, Object.values(steppers).map((x) => x.field)),
    plan, trainsOn, progress, pending, trainerButton.el);

  const el = h('div', {class: 'sheet-speed', dataset: {sheetContent: 'speed'}}, readout, presets, fine, pitch, trainer);
  container.append(el);

  // ---- updates -----------------------------------------------------------------------------------------------
  function updateBpm(t) {
    const text = bpmText(session, snap().rate, Number.isFinite(t) ? t : transport.position?.());
    if (bpm.textContent !== text) bpm.textContent = text;
    bpm.hidden = !text;
  }

  let wasRunning = !!snap().trainer;
  function update() {
    const s = snap();
    // A trainer started elsewhere (the palette, a pedal) shows its own configuration.
    if (s.trainer && !wasRunning) {
      draft = draftOf(session, s);
      for (const [key, {s: field}] of Object.entries(steppers)) field.set({value: draft[key]});
    }
    wasRunning = !!s.trainer;
    const rate = Number.isFinite(s.rate) ? s.rate : 1;
    const shown = pctOf(rate);
    value.textContent = S.percent(shown);
    value.dataset.at100 = String(shown === 100);
    updateBpm();
    for (const {n, b} of presetButtons) {
      const st = stateOf('speed.set', presetArgs(n));
      b.set({pressed: n === shown, disabled: !st?.enabled, disabledReason: st?.enabled ? null : st?.reason ?? null});
    }
    for (const [button, cmd] of [[slower, 'speed.downFine'], [faster, 'speed.upFine']]) {
      const st = stateOf(cmd);
      button.set({disabled: !st?.enabled, disabledReason: st?.reason ?? null});
    }
    keepPitch.set({pressed: !!s.keepPitch});

    const running = s.trainer ?? null;
    const rates = trainerRates(cfgOf(draft));
    plan.textContent = S.plan(draft.start, draft.end, rates.length, draft.passes);
    trainsOn.textContent = S.trainsOn(trainsOnText(session, s));
    if (running) {
      progress.hidden = false;
      progress.textContent = running.done ? S.done(pctOf(running.rate)) : S.progress(running.stepIndex + 1, running.steps, pctOf(running.rate));
      progress.dataset.done = String(!!running.done);
    } else {
      progress.hidden = true;
      progress.textContent = '';
    }
    // Against the running configuration as stored (off-grid values included): the note says when the next start differs.
    const runningDraft = running ? rawDraftOf(session, s) : null;
    pending.hidden = !running || sameDraft(runningDraft, draft);
    const trainerState = stateOf('trainer.toggle', running ? undefined : cfgOf(draft));
    trainerButton.set({label: running ? S.stopTrainer : S.startTrainer, variant: running ? 'secondary' : 'primary',
      disabled: !trainerState?.enabled, disabledReason: trainerState?.reason ?? null});
    trainer.dataset.running = String(!!running);
  }

  offs.push(transport.snapshot.subscribe(() => update()));
  if (typeof registry.onChange === 'function') offs.push(registry.onChange(() => update()));
  if (session.position?.revision?.subscribe) offs.push(session.position.revision.subscribe(() => update()));
  if (typeof session.frame?.subscribe === 'function') {
    offs.push(session.frame.subscribe((f) => {
      if (!f?.playing) return;
      updateBpm(f.position);
      const text = S.trainsOn(trainsOnText(session, snap()));
      if (trainsOn.textContent !== text) trainsOn.textContent = text;
    }, {hz: BPM_HZ}));
  }
  update();

  return {
    el,
    destroy() {
      for (const off of offs.splice(0)) { try { off?.(); } catch (err) { console.error('[speed sheet] cleanup failed', err); } }
      for (const p of parts.splice(0)) p.destroy();
      el.remove();
    },
  };
}

export default render;
