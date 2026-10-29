// Edit · Map inspector (architecture §2.15 `mountInspector`; spec §5.1 "Inspector, selected bar or
// pin" and §5.1.1 "Get a map"; maps/mapedit.md §11.4: every key-only map edit has a control).
//
//   mountInspector(el, {session, mapSession, registry, prefs, feedback, store, platform}) →
//     {el, focusMeter(), applyFocused(), destroy()}
//
// Mapped songs (top to bottom):
//   BAR 41 · beat 3       [◀ Bar] [Bar ▶]                              map.prevBar / map.nextBar
//   Go to [ 41 ] [Go] ⏮ ⏭  the typed digits show in the field              map.goOrApply, map.prevPin/nextPin
//   Meter  Beats [−] 7 [+] (every step is one edit, ↑↓)                    map.beatsDown / map.beatsUp
//          Unit 1·2·4·8·16 · Groups [2+2+3] · Pickup length (bar 1 or a short bar)
//          Apply to This bar · Until next change · To the end · Keep in place Beats · Bar lines · [Apply ↵]
//   Label  [Bridge] (Enter or leaving the field labels the bar; '' removes it)
//   Tempo  ♩ [96.00] on an open span, else the span's tempo · [Ramp to next pin R] · [×2] [÷2] · Tail [−] [+]
//   Pin    ● Locked at 0:48.120 | free · [Pin downbeat D] [Pin beat T] · [Unpin ⌫]
//          Nudge [−10 ms] [−1] [+1] [+10 ms] · This pin is bar [ 41 ] (pinned lines)
//   Tools  [Tap along] [Calibrate tap timing…] [Snap taps to drum hits] [Preview these bars P]
//          [Detect beats] [Suggest sections] [Find a chart…]
//   Status the map session's messages (refusals from the model and the drum-part guards in error
//          tone) and the app status line (results that offer Undo: Beat grid found · Undo, a tap
//          pass, markers → sections); the inspector hosts the status line while it is mounted.
// Unmapped songs show "Get a map" instead (spec §5.1.1): Detect beats (desktop or a paired
// computer; the web without one reads "Needs Woodshed for desktop [Get it ↗]"), Tap along, Find a
// chart, with the same status line.
//
// Buttons run registry commands (so key-caps, enabled and pressed states come from §3.4), with
// key-cap hints that show only inside [data-kbd-hints] (Edit adds it after keyboard use, spec §5.0).
import {registry as appRegistry} from '../../app/commands.js';
import {prefs as appPrefs} from '../../app/prefs.js';
import * as appFeedback from '../../app/feedback.js';
import {effect, store as appStore} from '../../app/store.js';
import {desktop as appDesktop} from '../../app/desktop.js';
import {h} from '../../ui/h.js';
import {Button} from '../../ui/button.js';
import {Toggle} from '../../ui/toggle.js';
import {Stepper} from '../../ui/stepper.js';
import {Segmented} from '../../ui/segmented.js';
import {TextField} from '../../ui/field.js';
import {InlineStatus} from '../../ui/status.js';
import {Kbd} from '../../ui/kbd.js';
import {APPLY_TO, COPY, KEEP, MAP_COMMANDS as C, UNITS} from './map.copy.js';
import {bpmText, clockText} from './session.js';
import {selectLine} from './lane.js';

const peek = (v) => (v && typeof v === 'object' && typeof v.peek === 'function' ? v.peek() : v);

/** A key-cap hint inside a control (aria-hidden; shown only in [data-kbd-hints]). */
function hint(el, keys) {
  if (!keys) return null;
  const k = Kbd({keys, hint: true});
  k.el.setAttribute('aria-hidden', 'true');
  k.el.classList.add('map-hint');
  el.append(k.el);
  return k;
}

const section = (name, ...children) => h('section', {class: 'map-insp-section', attrs: {'aria-label': name}, dataset: {section: name.toLowerCase()}},
  h('h3', {class: 'map-insp-heading'}, name), ...children);
const row = (...children) => h('div', {class: 'map-insp-row'}, ...children);

export function mountInspector(el, {session, mapSession, registry = appRegistry, prefs = appPrefs, feedback = appFeedback,
  store = appStore, desktop = appDesktop} = {}) {
  if (!session || !mapSession) throw new TypeError('mountInspector needs a session and a map session.');
  const {map} = session;
  const root = h('aside', {class: 'map-inspector', attrs: {'aria-label': COPY.inspector}, dataset: {testid: 'map-inspector'}});
  el.append(root);
  const owned = [];      // primitives to destroy with the current mode
  const offs = [];
  const keep = (p) => { owned.push(p); return p; };
  let mode = null;       // 'mapped' | 'unmapped'
  let parts = null;      // the current mode's elements
  let destroyed = false;

  // ---------------------------------------------------------------- the status line
  const status = InlineStatus({tone: 'info', text: '', className: 'map-insp-status', attrs: {'aria-label': COPY.statusRegion},
    dataset: {testid: 'map-status'}});
  status.el.hidden = true;
  let shown = null;    // {kind: 'message'|'status', entry}
  const detachStatus = feedback.attachStatusLine?.() ?? (() => {});
  function showStatus() {
    const entry = shown?.entry;
    if (!entry || !entry.text) { status.el.hidden = true; return; }
    const tone = ['info', 'ok', 'warn', 'error'].includes(entry.tone) ? entry.tone : 'info';
    status.set({tone, text: entry.text, action: entry.action ? {label: entry.action.label, run: () => entry.action.run?.()} : undefined});
    status.el.hidden = false;
    status.el.dataset.tone = tone;
  }
  offs.push(effect(() => {
    const m = mapSession.message.value;
    if (destroyed) return;
    if (m) shown = {kind: 'message', entry: m};
    else if (shown?.kind === 'message') shown = null;
    showStatus();
  }));
  if (feedback.statusLine) {
    offs.push(effect(() => {
      const entry = feedback.statusLine.value;
      if (destroyed) return;
      if (entry) shown = {kind: 'status', entry};
      else if (shown?.kind === 'status') {
        const m = peek(mapSession.message);
        shown = m ? {kind: 'message', entry: m} : null;
      }
      showStatus();
    }));
  }

  // ---------------------------------------------------------------- shared helpers
  const commandButton = ({hintKeys, hint: showHint = true, ...props}) => {
    const b = keep(Button({size: 'sm', variant: 'secondary', registry, ...props}));
    const keys = hintKeys !== undefined ? hintKeys : registry.get?.(props.command)?.keys?.[0];
    if (showHint && keys) keep(hint(b.el, keys));
    return b;
  };
  const span = () => mapSession.span.peek();

  // ---------------------------------------------------------------- Get a map (unmapped)
  function buildUnmapped() {
    const detectButton = commandButton({label: COPY.detectAction, command: C.detect, variant: 'primary', hint: false});
    const where = h('span', {class: 'map-getmap-where'});
    const needs = h('p', {class: 'map-getmap-needs'}, COPY.needsDesktop, ' ',
      h('a', {href: '/download', class: 'map-getmap-link', attrs: {target: '_blank', rel: 'noopener'}}, COPY.getIt));
    const detectCard = h('div', {class: 'map-getmap-card', dataset: {card: 'detect'}},
      h('h3', {class: 'map-insp-heading'}, COPY.detectTitle), h('p', {class: 'map-getmap-body'}, where), needs, row(detectButton.el));
    const tapButton = commandButton({label: COPY.tapAction, command: C.tapAlong, hint: false});
    const tapCard = h('div', {class: 'map-getmap-card', dataset: {card: 'tap'}},
      h('h3', {class: 'map-insp-heading'}, COPY.tapTitle), h('p', {class: 'map-getmap-body'}, COPY.tapBody), row(tapButton.el));
    const findButton = commandButton({label: COPY.findAction, command: C.find, hint: false});
    const findCard = h('div', {class: 'map-getmap-card', dataset: {card: 'find'}},
      h('h3', {class: 'map-insp-heading'}, COPY.findTitle), row(findButton.el));
    const body = h('div', {class: 'map-getmap'},
      h('h2', {class: 'map-insp-title'}, COPY.getMap), h('p', {class: 'map-getmap-intro'}, COPY.getMapIntro), detectCard, tapCard, findCard);
    root.replaceChildren(body, status.el);
    return {kind: 'unmapped', detectButton, where, needs, tapButton};
  }

  function deviceName(deviceId) {
    const list = peek(store?.library?.devices);
    return (Array.isArray(list) ? list : []).find((d) => d.deviceId === deviceId || d.id === deviceId)?.name ?? null;
  }

  /** Where Detect runs: this computer (the desktop app's processor), a paired computer (B5), or nowhere. */
  function detectWhere(can) {
    const local = !!desktop?.available;
    const processor = peek(desktop?.processor);
    const here = local && can.ok && (processor?.phase === 'ready' || processor?.phase === 'busy');
    if (here || (local && !can.ok)) return COPY.detectHere;
    return can.ok ? COPY.detectRemote(deviceName(can.deviceId)) : null;
  }

  function busyLine() {
    const state = peek(session.detect?.state);
    return state && (state.phase === 'running' || state.phase === 'starting') ? (state.line || COPY.detect) : false;
  }

  function updateUnmapped() {
    const can = peek(session.detect?.canDetect) ?? {ok: false};
    const where = detectWhere(can);
    // The web with no paired computer online: "Needs Woodshed for desktop [Get it ↗]" instead of [Detect].
    const needs = !where && !session.readOnly;
    parts.where.textContent = COPY.detectBody(where ?? COPY.detectHere);
    parts.where.hidden = needs;
    parts.needs.hidden = !needs;
    parts.detectButton.el.hidden = needs;
    parts.detectButton.set({busy: busyLine()});
  }

  // ---------------------------------------------------------------- the full inspector (mapped)
  let draft = null;   // {index, unit, groups, pickup, applyTo, keep, touched: Set}
  function freshDraft(s) {
    return {index: s.index, unit: s.form.denominator, groups: s.form.groups, pickup: String(s.form.pickup.value), applyTo: 'until', keep: s.form.keep, touched: new Set()};
  }

  function buildMapped() {
    // Header and Go to
    const title = h('h2', {class: 'map-insp-title', dataset: {testid: 'map-insp-bar'}});
    const sub = h('span', {class: 'map-insp-sub'});
    const prev = commandButton({label: COPY.prevBar, icon: 'chevron-left', command: C.prevBar, attrs: {'aria-label': COPY.prevBarName}});
    const next = commandButton({label: COPY.nextBar, iconEnd: 'chevron-right', command: C.nextBar, attrs: {'aria-label': COPY.nextBarName}});
    const header = h('header', {class: 'map-insp-header'}, h('div', {class: 'map-insp-name'}, title, sub), h('div', {class: 'map-insp-steps'}, prev.el, next.el));

    const goField = keep(TextField({label: COPY.goToField, inputmode: 'numeric', size: 'sm', maxLength: 4, className: 'map-goto-field',
      onCommit: (v) => { if (String(v).trim()) goTo(v); }}));
    const goButton = commandButton({label: COPY.go, hintKeys: 'Enter', onClick: () => goTo(goField.input.value)});
    const prevPin = commandButton({label: '⏮', command: C.prevPin, attrs: {'aria-label': COPY.prevPinName}, hint: false});
    const nextPin = commandButton({label: '⏭', command: C.nextPin, attrs: {'aria-label': COPY.nextPinName}, hint: false});
    const goto = section(COPY.goTo, row(goField.el, goButton.el, prevPin.el, nextPin.el));

    // Meter
    const beats = keep(Stepper({label: COPY.beats, min: 1, max: 16, step: 1, value: span().meter.numerator, size: 'sm',
      decLabel: COPY.fewerBeats, incLabel: COPY.moreBeats, className: 'map-beats', onChange: onBeats}));
    const unit = keep(Segmented({label: COPY.unit, size: 'sm', value: span().form.denominator,
      options: UNITS.map((u) => ({value: u, label: String(u)})), onChange: (v) => touch('unit', v)}));
    const groups = keep(TextField({label: COPY.groups, hint: COPY.groupsHint, size: 'sm', placeholder: '2+2+3', className: 'map-groups-field',
      onInput: (v) => touch('groups', v)}));
    const pickup = keep(TextField({label: COPY.pickup, hint: COPY.pickupHint, inputmode: 'decimal', size: 'sm', className: 'map-pickup-field',
      onInput: (v) => touch('pickup', v)}));
    const applyTo = keep(Segmented({label: COPY.applyTo, size: 'sm', value: 'until', options: APPLY_TO.map((o) => ({...o})), onChange: (v) => touch('applyTo', v)}));
    const keepIn = keep(Segmented({label: COPY.keep, size: 'sm', value: span().form.keep, options: KEEP.map((o) => ({...o})), onChange: (v) => touch('keep', v)}));
    const apply = commandButton({label: COPY.apply, variant: 'primary', hintKeys: 'Enter', onClick: () => applyMeter()});
    for (const f of [groups, pickup]) {
      f.input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        applyMeter();
      });
    }
    const beatsLabel = h('span', {class: 'map-field-label', attrs: {'aria-hidden': 'true'}}, COPY.beats);
    keep(hint(beatsLabel, 'KeyE'));
    const meter = section(COPY.meter,
      row(beatsLabel, beats.el),
      row(h('span', {class: 'map-field-label', attrs: {'aria-hidden': 'true'}}, COPY.unit), unit.el),
      groups.el, pickup.el,
      row(h('span', {class: 'map-field-label', attrs: {'aria-hidden': 'true'}}, COPY.applyTo), applyTo.el),
      row(h('span', {class: 'map-field-label', attrs: {'aria-hidden': 'true'}}, COPY.keep), keepIn.el),
      row(apply.el));

    // Label
    const label = keep(TextField({label: COPY.labelField, hint: COPY.labelHint, maxLength: 120, size: 'sm', className: 'map-label-field',
      onCommit: (v) => mapSession.setLabel(span().index, v)}));
    const labelSection = section(COPY.label, label.el);

    // Tempo
    const tempoField = keep(TextField({label: COPY.tempoField('♩'), inputmode: 'decimal', size: 'sm', className: 'map-tempo-field',
      onCommit: (v) => { if (String(v).trim()) mapSession.setTempoOpenSpan(Number(v)); }}));
    const tempoRead = h('p', {class: 'map-tempo-read'}, h('span', {class: 'map-tempo-value'}), h('span', {class: 'map-insp-sub'}));
    const ramp = keep(Toggle({label: COPY.ramp, command: C.ramp, size: 'sm', registry}));
    keep(hint(ramp.el, 'KeyR'));
    const double = commandButton({label: COPY.double, command: C.double, attrs: {'aria-label': COPY.doubleName}});
    const halve = commandButton({label: COPY.halve, command: C.halve, attrs: {'aria-label': COPY.halveName}});
    const tailDown = commandButton({label: '−', command: C.tailDown, attrs: {'aria-label': COPY.tailDown}, hint: false});
    const tailUp = commandButton({label: '+', command: C.tailUp, attrs: {'aria-label': COPY.tailUp}, hint: false});
    const tempo = section(COPY.tempo, tempoField.el, tempoRead, row(ramp.el), row(double.el, halve.el),
      row(h('span', {class: 'map-field-label', attrs: {'aria-hidden': 'true'}}, COPY.tail), tailDown.el, tailUp.el));

    // Pin
    const pinState = h('p', {class: 'map-pin-state', dataset: {testid: 'map-pin-state'}}, h('span', {class: 'map-pin-text'}), h('span', {class: 'map-insp-sub'}));
    const pinD = commandButton({label: COPY.pinDownbeat, command: C.pinDownbeat});
    const pinT = commandButton({label: COPY.pinBeat, command: C.pinBeat});
    const unpin = commandButton({label: COPY.unpin, command: C.unpin, hintKeys: 'Backspace'});
    const n10 = commandButton({label: COPY.nudgeBack10, command: C.nudgeBack, attrs: {'aria-label': COPY.nudgeBack10Name}, hint: false});
    const n1 = commandButton({label: COPY.nudgeBack1, command: C.nudgeBackFine, attrs: {'aria-label': COPY.nudgeBack1Name}, hint: false});
    const p1 = commandButton({label: COPY.nudgeFwd1, command: C.nudgeFwdFine, attrs: {'aria-label': COPY.nudgeFwd1Name}, hint: false});
    const p10 = commandButton({label: COPY.nudgeFwd10, command: C.nudgeFwd, attrs: {'aria-label': COPY.nudgeFwd10Name}, hint: false});
    const renumber = keep(TextField({label: COPY.renumber, hint: COPY.renumberHint, inputmode: 'numeric', size: 'sm', maxLength: 4, className: 'map-renumber-field',
      onCommit: (v) => { if (String(v).trim()) mapSession.renumberTo(Number(v)); }}));
    const pinSection = section(COPY.pin, pinState, row(pinD.el, pinT.el, unpin.el),
      row(h('span', {class: 'map-field-label', attrs: {'aria-hidden': 'true'}}, COPY.nudge), n10.el, n1.el, p1.el, p10.el), renumber.el);

    // Tools
    const tapAlong = commandButton({command: C.tapAlong, hintKeys: 'Space'});
    const calibrate = commandButton({label: COPY.calibrate, command: C.calibrate});
    const snapTaps = keep(Toggle({label: COPY.snapTaps, size: 'sm', className: 'map-snap-taps', pressed: prefs.get?.('edit.map.tapSnap') !== false,
      onChange: (on) => prefs.set?.('edit.map.tapSnap', !!on)}));
    const preview = keep(Toggle({label: COPY.preview, command: C.preview, size: 'sm', registry}));
    keep(hint(preview.el, 'KeyP'));
    const detect = commandButton({label: COPY.detect, command: C.detect, hint: false});
    const suggest = commandButton({label: COPY.suggest, command: C.suggest, hint: false});
    const find = commandButton({label: COPY.find, command: C.find, hint: false});
    const tools = section(COPY.tools, h('div', {class: 'map-insp-grid'}, tapAlong.el, calibrate.el, snapTaps.el, preview.el, detect.el, suggest.el, find.el));

    root.replaceChildren(header, goto, meter, labelSection, tempo, pinSection, tools, status.el);
    return {kind: 'mapped', title, sub, goField, beats, unit, groups, pickup, applyTo, keepIn, apply, meter, label, tempoField, tempoRead, tempo,
      pinState, unpin, renumber, pinSection, labelSection, goto, snapTaps, detect, suggest, tapAlong};
  }

  function touch(field, value) {
    if (!draft) return;
    draft[field] = value;
    draft.touched.add(field);
  }

  function goTo(value) {
    const n = parseInt(String(value).trim(), 10);
    if (!Number.isFinite(n)) { mapSession.message.value = {text: COPY.noDigits, tone: 'info'}; return false; }
    mapSession.clearDigits();
    if (!mapSession.goToBar(n)) return false;
    return selectLine(session, mapSession, mapSession.cursorQ.peek());
  }

  function onBeats(v, {source} = {}) {
    if (source === 'program') return;
    const s = span(), delta = v - s.meter.numerator;
    if (!delta) return;
    const thisBar = (draft?.applyTo ?? 'until') === 'this';
    if (Math.abs(delta) === 1) mapSession.changeBeats(delta, {thisBar});
    else mapSession.applyBar({numerator: v, denominator: s.meter.denominator, groups: '', applyTo: draft?.applyTo ?? 'until'});
    // A refused step shows the bar's own value again.
    queueMicrotask(() => { if (parts?.kind === 'mapped') parts.beats.set({value: span().meter.numerator}); });
  }

  /** The Meter form ("Edit bar"): every field, one edit (session.applyBar). */
  function applyMeter() {
    const s = span();
    const d = draft ?? freshDraft(s);
    const form = {numerator: s.meter.numerator, denominator: Number(d.unit), groups: d.groups, applyTo: d.applyTo, keep: d.keep};
    if (s.form.pickup.editable) {
      const value = Number(String(d.pickup).trim());
      if (Number.isFinite(value) && value > 0) form.pickup = value;
    }
    const ok = mapSession.applyBar(form);
    if (ok) draft = freshDraft(span());
    updateMapped();
    return ok;
  }

  function updateMapped() {
    const s = span();
    if (!draft || draft.index !== s.index) draft = freshDraft(s);
    else {
      const fresh = freshDraft(s);
      for (const key of ['unit', 'groups', 'pickup', 'keep']) if (!draft.touched.has(key)) draft[key] = fresh[key];
    }
    const p = parts;
    p.title.textContent = COPY.barHeading(s.name);
    p.sub.textContent = s.beat !== null ? COPY.beatSub(s.beat) : s.downbeat ? COPY.downbeatSub : '';
    root.dataset.bar = String(s.index);
    // Go to: typed digits show in the field.
    const digits = peek(mapSession.digits);
    p.goField.set({value: digits || ''});
    if (digits && p.goField.input.value !== digits && document.activeElement !== p.goField.input) p.goField.input.value = digits;
    if (!digits && document.activeElement !== p.goField.input) p.goField.input.value = '';
    // Meter
    p.beats.set({value: s.meter.numerator});
    p.unit.set({value: Number(draft.unit)});
    p.groups.set({value: draft.groups});
    p.pickup.el.hidden = !s.form.pickup.editable;
    p.pickup.set({value: draft.pickup});
    p.applyTo.set({value: draft.applyTo});
    p.keepIn.set({value: draft.keep});
    // Label
    p.label.set({value: s.form.label ?? ''});
    // Tempo
    p.tempoField.el.hidden = !s.tempo.editable;
    p.tempoField.set({label: COPY.tempoField(s.tempo.unit), value: s.tempo.editable ? s.form.tempo.value.toFixed(2) : ''});
    p.tempoRead.hidden = s.tempo.editable;
    p.tempoRead.firstChild.textContent = `${s.tempo.unit} ${s.tempo.ramp ? COPY.tempoRamp(bpmText(s.tempo.startBpm), bpmText(s.tempo.endBpm)) : COPY.tempoSteady(bpmText(s.tempo.bpm))}`;
    p.tempoRead.lastChild.textContent = !s.real ? COPY.tempoSub.placeholder : COPY.tempoFromPins;
    p.tempo.dataset.open = s.tempo.editable ? s.tempo.open : '';
    // Pin
    const pinned = !!s.pin;
    p.pinState.dataset.pinned = String(pinned);
    p.pinState.firstChild.textContent = pinned ? `● ${COPY.lockedAt(clockText(s.pin.time))}` : COPY.free;
    p.pinState.lastChild.textContent = pinned ? '' : COPY.freeSub;
    p.unpin.el.hidden = !pinned;
    p.renumber.el.hidden = !pinned;
    p.renumber.set({value: pinned && s.display !== null ? String(s.display) : ''});
    // Tools
    p.snapTaps.set({pressed: prefs.get?.('edit.map.tapSnap') !== false});
    p.detect.set({busy: busyLine()});
    p.suggest.el.hidden = !!map.hasSections;
  }

  // ---------------------------------------------------------------- mode and updates
  function destroyOwned() { for (const p of owned.splice(0)) p?.destroy?.(); }
  function update() {
    if (destroyed) return;
    const want = map.isReal ? 'mapped' : 'unmapped';
    if (want !== mode) {
      const focusInside = root.contains(document.activeElement);
      destroyOwned();
      mode = want;
      draft = null;
      parts = want === 'mapped' ? buildMapped() : buildUnmapped();
      root.dataset.mode = want;
      if (focusInside) root.querySelector('button, input, [tabindex="0"]')?.focus?.();
    }
    if (mode === 'mapped') updateMapped(); else updateUnmapped();
  }

  offs.push(effect(() => {
    mapSession.span.value; mapSession.digits.value; mapSession.previewing.value; mapSession.tapping.value; mapSession.auditioning.value;
    session.detect?.state?.value; session.detect?.canDetect?.value; store?.library?.devices?.value; desktop?.processor?.value;
    if (destroyed) return;
    update();
    registry.invalidate?.();
  }));
  offs.push(map.subscribe(() => update()));

  /** E (D19): focus Meter → Beats. */
  function focusMeter() {
    if (mode !== 'mapped') return false;
    const target = parts.beats.el.querySelector('[role=spinbutton]');
    target?.focus();
    return !!target;
  }

  /** Enter with no typed digits (D19): apply the inspector field that has focus. */
  function applyFocused() {
    if (mode !== 'mapped') return false;
    const active = document.activeElement;
    if (!active || !root.contains(active)) return false;
    const p = parts;
    if (p.meter.contains(active)) return applyMeter();
    if (p.goto.contains(active)) return goTo(p.goField.input.value);
    if (p.labelSection.contains(active)) return mapSession.setLabel(span().index, p.label.input.value);
    if (p.tempo.contains(active) && span().tempo.editable && p.tempoField.input.value.trim()) return mapSession.setTempoOpenSpan(Number(p.tempoField.input.value));
    if (p.pinSection.contains(active) && span().pin && p.renumber.input.value.trim()) return mapSession.renumberTo(Number(p.renumber.input.value));
    return false;
  }

  update();

  return {
    el: root, focusMeter, applyFocused,
    get mode() { return mode; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const off of offs) off();
      destroyOwned();
      status.destroy();
      detachStatus();
      root.remove();
    },
  };
}
