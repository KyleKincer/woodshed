// The Click sheet (spec §4.7 "Click sheet"; architecture §2.14.3 rules 2, 9 and 21, D14, D51):
// count-in length (Off · 1 bar · 2 bars · 2 beats · Custom 1–16 bars | beats), Count in every
// loop pass, Click Off · During count-in only · Always, Accent downbeats, Click volume, Play the
// song during count-in, the visual click (beat lamps always, plus the per-device edge flash), the
// read-only "At the cue" line and the Edit map footer.
//
//   render(container, {session, close, registry?, prefs?}) → {el, destroy()}
//     registry   the command registry (default the app registry): Edit map, Tap the beat and Get
//                bars run their commands; Count in every loop pass is `loop.eachPass` and the Click
//                choices run `click.mode {mode}`, each option checked and disabled by
//                `registry.state('click.mode', context({args: {mode}}))` (§3.1, the I1b handoff)
//     prefs      device prefs (`practice.edgeFlash`, §2.5); default src/app/prefs.js
//
// Unmapped songs (no bar grid): the count-in is the 2 s Lead-in (audio pre-roll, no clicks) and
// Click reads "Needs a bar grid" with [Tap the beat] [Get bars]; nothing else applies, so the
// click-only controls are not shown. Every change goes through the transport (one practice-undo
// step stored in `practice.click`, D51); the count-in choices map to `setCountIn`, the Click
// choices to `click.mode` (D14's truth table decides what sounds). A read-only (shared) song
// keeps every practice control but shows no map-editing action, nor copy that points to one.
//
// Pure helpers (exported for tests): countInChoice(countIn, {custom}), atCueText(map, cue).

import '../../styles/views/stage/sheets-click.css';
import {registry as appRegistry} from '../../app/commands.js';
import {prefs as appPrefs} from '../../app/prefs.js';
import {h} from '../../ui/h.js';
import {Button} from '../../ui/button.js';
import {Toggle} from '../../ui/toggle.js';
import {Segmented} from '../../ui/segmented.js';
import {Stepper} from '../../ui/stepper.js';
import {Slider} from '../../ui/slider.js';
import '../transport-commands.js';   // registers loop.eachPass and click.mode
import {COPY, COUNT_IN_CHOICES, COUNT_IN_RANGE} from './sheets-a.copy.js';

const C = COPY.click;
const EDGE_FLASH = 'practice.edgeFlash';
const MODES = Object.freeze(['off', 'countin', 'always']);

let seq = 0;
const read = (sig) => (sig && typeof sig.peek === 'function' ? sig.peek() : null);

/** The count-in choice for a count-in state: 'off', a preset ('1-bars', '2-bars', '2-beats') or 'custom'. */
export function countInChoice(countIn, {custom = false} = {}) {
  if (!countIn?.on) return 'off';
  if (custom) return 'custom';
  const hit = COUNT_IN_CHOICES.find((c) => c.length === countIn.length && c.unit === countIn.unit);
  return hit ? hit.value : 'custom';
}

/**
 * 'At the cue: ♩ = 96 · 4/4 · from the map' for a real map, else '' (spec §4.7). The tempo is the
 * felt pulse at the cue (the HUD's bpm, `map.bpmAt`) after that pulse's own note value
 * (`map.pulseLabel`): ♩ in 4/4, ♩. in 6/8, ♪ in 7/8 grouped 2+2+3, so number and glyph agree.
 */
export function atCueText(map, cue) {
  if (!map?.isReal || !map.bars?.length) return '';
  const t = Math.max(0, Number.isFinite(cue) ? cue : 0);
  const index = map.barIndexAt(t);
  const bar = map.bars[index];
  if (!bar) return '';
  const felt = typeof map.bpmAt === 'function' && typeof map.positionAt === 'function' ? map.bpmAt(map.positionAt(t)) : bar.bpm;
  const bpm = Math.round(Number.isFinite(felt) && felt > 0 ? felt : bar.bpm ?? bar.qpm);
  const glyph = typeof map.pulseLabel === 'function' ? map.pulseLabel(index) || '♩' : '♩';
  const grouping = typeof map.beatGrouping === 'function' ? map.beatGrouping(index)?.label ?? '' : '';
  return C.atCue(glyph, bpm, C.meter(bar.numerator, bar.denominator, grouping), C.fromMap);
}

/** The Click sheet (see the header). */
export function render(container, {session, close, registry = appRegistry, prefs = appPrefs} = {}) {
  if (!session?.transport) throw new TypeError('click sheet: a session with a transport is required');
  const transport = session.transport;
  const id = `sheet-click-${++seq}`;
  const offs = [];
  const parts = [];
  const snap = () => read(transport.snapshot) ?? {};
  /** A command's state for these args (§3.1; the I1b handoff's per-option rule). */
  const stateOf = (cmd, args) => registry.state(cmd, registry.context(args === undefined ? {} : {args}));
  const run = (cmd, args) => registry.run(cmd, {source: 'pointer', ...(args === undefined ? {} : {args})});
  const mapped = () => !!session.map?.isReal;
  const writable = !session.readOnly;
  let customOpen = false;

  const section = (key, title, ...children) => {
    const headingId = `${id}-${key}`;
    return h('section', {class: 'sheet-click-section', dataset: {section: key}, attrs: {'aria-labelledby': headingId}},
      h('h3', {class: 'sheet-click-heading', id: headingId}, title), ...children);
  };
  const hint = (text, key) => h('p', {class: 'sheet-click-hint', id: `${id}-${key}-hint`}, text);

  // ---- count-in (mapped) -------------------------------------------------------------------------------------
  const countIn = Segmented({label: C.countIn, size: 'lg', className: 'sheet-click-count-in',
    options: COUNT_IN_CHOICES.map((c) => ({value: c.value, label: c.label})),
    value: countInChoice(snap().countIn),
    onChange: (value) => {
      const choice = COUNT_IN_CHOICES.find((c) => c.value === value);
      customOpen = value === 'custom';
      if (value === 'off') transport.setCountIn({on: false});
      else if (choice?.length) transport.setCountIn({on: true, length: choice.length, unit: choice.unit});
      else transport.setCountIn({on: true});
      update();
    }});
  const length = Stepper({label: C.customLength, value: snap().countIn?.length ?? 1, min: COUNT_IN_RANGE.min, max: COUNT_IN_RANGE.max,
    step: 1, bigStep: 4, format: C.lengthValue, size: 'md', className: 'sheet-click-length',
    onChange: (v) => { customOpen = true; transport.setCountIn({on: true, length: v}); update(); }});
  const unit = Segmented({label: C.customUnit, size: 'md', className: 'sheet-click-unit',
    options: [{value: 'bars', label: C.bars}, {value: 'beats', label: C.beats}],
    value: snap().countIn?.unit ?? 'bars',
    onChange: (v) => { customOpen = true; transport.setCountIn({on: true, unit: v}); update(); }});
  parts.push(countIn, length, unit);
  const custom = h('div', {class: 'sheet-click-custom', dataset: {custom: ''}}, length.el, unit.el);

  // ---- count-in (unmapped): the 2 s Lead-in ------------------------------------------------------------------
  const leadInHint = hint(C.leadInHint, 'lead-in');
  const leadIn = Toggle({label: C.leadIn, size: 'lg', className: 'sheet-click-toggle', pressed: !!snap().countIn?.on,
    attrs: {'aria-describedby': leadInHint.id},
    onChange: (pressed) => { transport.setCountIn({on: pressed}); update(); }});
  parts.push(leadIn);
  const leadInRow = h('div', {class: 'sheet-click-row'}, leadIn.el, leadInHint);

  // ---- every pass --------------------------------------------------------------------------------------------
  const everyPassHint = hint(C.everyPassHint, 'every-pass');
  const everyPass = Toggle({label: C.everyPass, command: 'loop.eachPass', registry, icon: '', size: 'lg', className: 'sheet-click-toggle',
    pressed: !!stateOf('loop.eachPass')?.checked, attrs: {'aria-describedby': everyPassHint.id},
    onChange: () => update()});
  parts.push(everyPass);
  const everyPassRow = h('div', {class: 'sheet-click-row'}, everyPass.el, everyPassHint);
  const silent = h('p', {class: 'sheet-click-note'}, C.silentCount);

  const countSection = section('count-in', C.countIn, countIn.el, custom, leadInRow, silent, everyPassRow);

  // ---- click (mapped) ----------------------------------------------------------------------------------------
  const modeOptions = () => MODES.map((m) => {
    const st = stateOf('click.mode', {mode: m});
    return {value: m, label: C.modes[m], disabled: !st?.enabled, reason: st?.enabled ? null : st?.reason ?? null, checked: !!st?.checked};
  });
  const modeValue = (options) => options.find((o) => o.checked)?.value ?? snap().click?.mode ?? 'countin';
  const firstModes = modeOptions();
  const mode = Segmented({label: C.click, size: 'lg', className: 'sheet-click-mode',
    options: firstModes.map(({checked: _, ...o}) => o), value: modeValue(firstModes),
    onChange: (m) => { run('click.mode', {mode: m}); update(); }});
  const accent = Toggle({label: C.accent, size: 'lg', className: 'sheet-click-toggle', pressed: !!snap().click?.accent,
    onChange: (pressed) => { transport.setAccent(pressed); update(); }});
  const volume = Slider({label: C.volume, value: snap().click?.volume ?? 0.7, min: 0, max: 1, step: 0.01, format: C.volumeValue,
    className: 'sheet-click-volume',
    onInput: (v) => transport.setClickVolume(v),
    onChange: (v) => transport.setClickVolume(v)});
  const preRoll = Toggle({label: C.preRoll, size: 'lg', className: 'sheet-click-toggle', pressed: !!snap().click?.preRoll,
    onChange: (pressed) => { transport.setPreRoll(pressed); update(); }});
  parts.push(mode, accent, volume, preRoll);
  const volumeLabel = h('span', {class: 'sheet-click-field-label', attrs: {'aria-hidden': 'true'}}, C.volume);
  const clickControls = h('div', {class: 'sheet-click-controls'}, mode.el, accent.el,
    h('div', {class: 'sheet-click-field'}, volumeLabel, volume.el), preRoll.el);

  // ---- click (unmapped): needs a bar grid ---------------------------------------------------------------------
  const tapBeat = Button({label: C.tapBeat, command: 'stage.tapBeat', registry, size: 'lg', className: 'sheet-click-grid-button'});
  const getBars = Button({label: C.getBars, command: 'stage.getBars', registry, size: 'lg', className: 'sheet-click-grid-button', iconEnd: 'arrow-right'});
  parts.push(tapBeat, getBars);
  const gridActions = h('div', {class: 'sheet-click-grid-actions'}, tapBeat.el, getBars.el);
  gridActions.hidden = !writable;
  // On a shared song the grid can't be made here: the hint that points to Tap the beat / Get bars goes too.
  const needsGridHint = h('p', {class: 'sheet-click-hint'}, C.needsGridHint);
  needsGridHint.hidden = !writable;
  const needsGrid = h('div', {class: 'sheet-click-needs-grid'},
    h('p', {class: 'sheet-click-needs-grid-title'}, C.needsGrid),
    needsGridHint,
    gridActions);

  const clickSection = section('click', C.click, clickControls, needsGrid);

  // ---- visual click ------------------------------------------------------------------------------------------
  const edgeHint = hint(C.edgeFlashHint, 'edge');
  const edgeFlash = Toggle({label: C.edgeFlash, size: 'lg', className: 'sheet-click-toggle', pressed: !!prefs?.get?.(EDGE_FLASH),
    attrs: {'aria-describedby': edgeHint.id},
    onChange: (pressed) => { prefs?.set?.(EDGE_FLASH, pressed); }});
  parts.push(edgeFlash);
  const visualSection = section('visual', C.visual, h('p', {class: 'sheet-click-hint'}, C.lampsAlways),
    h('div', {class: 'sheet-click-row'}, edgeFlash.el, edgeHint));

  // ---- at the cue, footer -------------------------------------------------------------------------------------
  const atCue = h('p', {class: 'sheet-click-at-cue tabular'});
  const editMap = Button({label: C.editMap, command: 'edit.map', registry, variant: 'quiet', size: 'md', iconEnd: 'arrow-right',
    className: 'sheet-click-edit-map', onClick: () => close?.()});
  parts.push(editMap);
  const footer = h('footer', {class: 'sheet-click-footer'}, h('span', {class: 'sheet-click-footer-text'}, C.footer), editMap.el);

  const el = h('div', {class: 'sheet-click', dataset: {sheetContent: 'click'}}, countSection, clickSection, visualSection, atCue, footer);
  container.append(el);

  function update() {
    const s = snap();
    const real = mapped();
    const ci = s.countIn ?? {on: false, length: 1, unit: 'bars'};
    const click = s.click ?? {mode: 'countin', accent: true, volume: 0.7, preRoll: false};
    el.dataset.mapped = String(real);

    // Count-in.
    if (!ci.on) customOpen = false;
    const choice = countInChoice(ci, {custom: customOpen});
    countIn.el.hidden = !real;
    countIn.set({value: choice});
    custom.hidden = !real || choice !== 'custom';
    length.set({value: ci.length});
    unit.set({value: ci.unit});
    leadInRow.hidden = real;
    leadIn.set({pressed: !!ci.on});
    silent.hidden = !real || !ci.on || click.mode !== 'off';
    const eachPass = stateOf('loop.eachPass');
    everyPass.set({pressed: !!eachPass?.checked, disabled: !eachPass?.enabled, disabledReason: eachPass?.reason ?? null});

    // Click.
    clickControls.hidden = !real;
    needsGrid.hidden = real;
    const options = modeOptions();
    mode.set({options: options.map(({checked: _, ...o}) => o), value: modeValue(options)});
    accent.set({pressed: !!click.accent});
    if (!volume.dragging) volume.set({value: click.volume});
    preRoll.set({pressed: !!click.preRoll});

    // Visual click (the edge flash marks downbeats: mapped songs only).
    visualSection.hidden = !real;
    edgeFlash.set({pressed: !!prefs?.get?.(EDGE_FLASH)});

    const cueLine = atCueText(session.map, s.cue);
    atCue.textContent = cueLine;
    atCue.hidden = !cueLine;
    footer.hidden = !real || !writable;
  }

  offs.push(transport.snapshot.subscribe(() => update()));
  if (typeof registry.onChange === 'function') offs.push(registry.onChange(() => update()));
  if (session.position?.revision?.subscribe) offs.push(session.position.revision.subscribe(() => update()));
  if (session.position?.mapped?.subscribe) offs.push(session.position.mapped.subscribe(() => update()));
  if (prefs?.value?.subscribe) offs.push(prefs.value.subscribe(() => edgeFlash.set({pressed: !!prefs.get(EDGE_FLASH)})));
  update();

  return {
    el,
    destroy() {
      for (const off of offs.splice(0)) { try { off?.(); } catch (err) { console.error('[click sheet] cleanup failed', err); } }
      for (const p of parts.splice(0)) p.destroy();
      el.remove();
    },
  };
}

export default render;
