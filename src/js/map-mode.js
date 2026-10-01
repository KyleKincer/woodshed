// Map mode: a keyboard scope over the waveform for building the song map.
// A selected line (bar line or beat) is the cursor. D/T pin a downbeat/beat
// at the playhead, or tap while playing; tempo between pins is derived.
import {fraction, number, compare} from '../../shared/notation.ts';
import {pin, unpin, renumberPin, editBars, setMeter, meterRun, scaleTempo, fullLength, sameMeter, MIN_QPM, MAX_QPM, pulseOf} from '../../shared/song-map.ts';
import {detectOnsets, nearestOnset} from './onsets.js';

const TAP_SNAP_KEY = 'ws.tapSnap', TAP_OFFSET_KEY = 'ws.tapOffset';
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const bpmText = (bpm) => (Math.round(bpm * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
function clock(t) {
  if (!Number.isFinite(t)) return '—';
  const sign = t < 0 ? '−' : '', a = Math.abs(t), m = Math.floor(a / 60), s = a - m * 60;
  return `${sign}${m}:${s.toFixed(3).padStart(6, '0')}`;
}
const meterText = (m) => `${m.numerator}/${m.denominator}${m.grouping && m.grouping.length > 1 && !m.grouping.every((g) => g === 1) ? ` (${m.grouping.join('+')})` : ''}`;

export const MAP_HINTS = [
  ['←/→', 'bar'], ['⇧←/→', 'beat'], ['⌘←/→', 'pin'], ['D / T', 'pin downbeat / beat · tap while playing'],
  [', .', 'nudge'], ['⌥←/→', 'renumber'], ['↑/↓', 'beats per bar'], ['E', 'edit bar'], ['R', 'ramp'],
  ['P', 'preview'], ['⌫', 'unpin'], ['* /', '×2 ÷2'], ['⌘Z', 'undo'], ['Esc', 'done'],
];

export function createMapMode({root, engine, songMap, metronome, readOnly = false, getView, setView, setFollow, timeToX, play, setGridVisible, redraw, onLoopChange = () => {}}) {
  const strip = root.querySelector('#map-strip');
  const button = root.querySelector('#map-btn');
  const cursorEl = root.querySelector('#map-cursor');
  let active = false, cursorQ = fraction(0), digits = '', preview = null, previewStarting = false, pass = null, calibration = null, drag = null;
  let saved = null, onsets = null, note = '', editing = false;
  let snapTaps = localStorage.getItem(TAP_SNAP_KEY) !== '0';
  const tapOffset = () => { const v = parseFloat(localStorage.getItem(TAP_OFFSET_KEY)); return Number.isFinite(v) ? clamp(v, -0.2, 0.2) : 0; };

  strip.innerHTML = `
    <div class="map-head">
      <strong class="map-title">Tempo map</strong>
      <div class="map-status" id="map-status" aria-live="polite"></div>
      <div class="map-actions">
        <button class="toggle-btn sm" data-map="undo" title="Undo (⌘Z)">Undo</button>
        <button class="toggle-btn sm" data-map="redo" title="Redo (⇧⌘Z)">Redo</button>
        <button class="toggle-btn sm" data-map="edit" title="Edit this bar's meter, label or open tempo (E)">Edit bar</button>
        <button class="toggle-btn sm" data-map="ramp" title="Ramp the tempo from this pin to the next (R)">Ramp</button>
        <button class="toggle-btn sm" data-map="preview" title="Loop the bars around the selected line with the click (P)">Preview</button>
        <button class="toggle-btn sm" data-map="double" title="Double the counted tempo; pins stay in place (*)">×2</button>
        <button class="toggle-btn sm" data-map="half" title="Halve the counted tempo; pins stay in place (/)">÷2</button>
        <button class="toggle-btn sm" data-map="snap" title="Move each tap to the nearest drum hit within 40 ms">Snap taps</button>
        <button class="toggle-btn sm" data-map="calibrate" title="Measure how early or late you tap">Calibrate taps</button>
        <button class="toggle-btn sm" data-map="done" title="Leave the tempo map (Esc)">Done</button>
      </div>
    </div>
    <div class="map-note" id="map-note" role="status"></div>
    <form class="map-editor" hidden>
      <label>Beats <input name="n" type="number" min="1" max="16" required></label>
      <label>Note <select name="d">${[1, 2, 4, 8, 16].map((d) => `<option value="${d}">${d}</option>`).join('')}</select></label>
      <label>Grouping <input name="grouping" placeholder="e.g. 2+2+3" size="8"></label>
      <label>Length <input name="length" type="number" min="0.0625" max="64" step="0.0625" title="Quarter notes in this bar. Shorten it for a pickup or a partial bar."></label>
      <label>Label <input name="label" maxlength="120" placeholder="Verse, chorus…" size="10"></label>
      <label>Apply to <select name="scope"><option value="run">This bar until the next change</option><option value="bar">This bar only</option><option value="end">This bar to the end</option></select></label>
      <label class="map-bpm-field">Tempo <input name="bpm" type="number" min="10" max="1000" step="0.01"><span class="map-bpm-unit"></span></label>
      <label class="map-check"><input type="checkbox" name="ramp"> Ramp to next pin</label>
      <button type="submit" class="toggle-btn sm on">Apply</button>
      <button type="button" class="toggle-btn sm" data-map="cancel">Cancel</button>
    </form>
    <div class="map-hints" aria-label="Tempo map keys">${MAP_HINTS.map(([k, v]) => `<span><kbd>${esc(k)}</kbd> ${esc(v)}</span>`).join('')}</div>`;
  const statusEl = strip.querySelector('#map-status'), noteEl = strip.querySelector('#map-note'), form = strip.querySelector('.map-editor');

  // ---- geometry helpers ---------------------------------------------------
  const duration = () => engine.duration;
  const lines = () => songMap.lines;
  const timeOf = (q) => songMap.timeAt(q);
  const navigable = () => lines().filter((l) => timeOf(l.q) < duration() - 1e-6);
  function lineIndex(list, q) {
    let best = 0, distance = Infinity;
    for (let i = 0; i < list.length; i++) { const d = Math.abs(number(list[i].q) - number(q)); if (d < distance) { best = i; distance = d; } }
    return best;
  }
  const lineAt = (q) => lines().find((l) => compare(l.q, q) === 0);
  const pinAt = (q) => songMap.data.pins.find((p) => compare(p.position, q) === 0);
  function describe(q) {
    const index = songMap.barIndexAt(number(q)), line = lineAt(q);
    return line ? (line.downbeat ? `bar ${index + 1}` : `bar ${index + 1} beat ${line.beat}`) : `bar ${index + 1}`;
  }

  function say(text) { note = text; noteEl.textContent = text; }
  const FAILED = Symbol('failed');
  function attempt(fn) {
    try { return fn(); }
    catch (error) { say(error.message || String(error)); return FAILED; }
  }

  // ---- status -------------------------------------------------------------
  function render() {
    if (!active) return;
    const q = number(cursorQ), index = songMap.barIndexAt(q), m = songMap.measure(index), span = songMap.spanAt(q), p = pinAt(cursorQ);
    const unit = songMap.pulseLabel(index), line = lineAt(cursorQ);
    const tempo = span.ramp ? `${unit} = ${bpmText(span.startBpm)}→${bpmText(span.endBpm)}` : `${unit} = ${bpmText(songMap.bpmAt(q))}`;
    const from = span.from ? describe(span.from.position) : 'start', to = span.to ? describe(span.to.position) : 'end';
    const where = span.open === 'tail' ? 'open after the last pin' : span.open === 'head' ? 'before the first pin' : `${from} → ${to}`;
    statusEl.innerHTML = `<span class="map-pos">${digits ? `Go to bar <b>${esc(digits)}</b>_` : `Bar <b>${index + 1}</b>${line && !line.downbeat ? ` · beat ${line.beat}` : ''}`}</span>
      <span>${esc(meterText(m))}${m.label ? ` · ${esc(m.label)}` : ''}</span>
      <span class="map-tempo">${esc(tempo)}${span.ramp ? ' ramp' : ''}</span>
      <span class="map-span">${esc(where)}</span>
      <span>${p ? `<b>pinned</b> ${clock(p.time)}` : `at ${clock(timeOf(cursorQ))}`}</span>
      ${pass ? `<span class="map-live">Tapping · ${pass.count}</span>` : ''}${calibration ? '<span class="map-live">Calibrating</span>' : ''}`;
    strip.querySelector('[data-map="undo"]').disabled = !songMap.undoStack.length && !songMap.batch?.changed;
    strip.querySelector('[data-map="redo"]').disabled = !songMap.redoStack.length;
    strip.querySelector('[data-map="preview"]').classList.toggle('on', !!preview);
    strip.querySelector('[data-map="snap"]').classList.toggle('on', snapTaps);
    strip.querySelector('[data-map="ramp"]').classList.toggle('on', span.ramp);
  }

  // ---- cursor -------------------------------------------------------------
  function select(q, {seek = true} = {}) {
    cursorQ = q;
    const time = timeOf(q);
    if (preview) placePreview();
    else if (seek && !pass) engine.seek(clamp(time, 0, duration()));
    const view = getView(), width = view.end - view.start;
    if (time < view.start || time > view.end) { setFollow(false); setView(time - width * 0.25, time + width * 0.75); }
    redraw(); render();
  }
  function step(direction, kind) {
    const list = kind === 'bar' ? navigable().filter((l) => l.downbeat) : navigable();
    if (!list.length) return;
    if (kind === 'pin') {
      const pins = songMap.data.pins.map((p) => p.position), changes = songMap.starts.filter((_, i) => i > 0 && !sameMeter(songMap.measure(i), songMap.measure(i - 1)));
      const targets = [...pins, ...changes].filter((q) => timeOf(q) < duration()).sort(compare);
      const next = direction > 0 ? targets.find((q) => compare(q, cursorQ) > 0) : targets.findLast((q) => compare(q, cursorQ) < 0);
      if (next) select(next); else say(direction > 0 ? 'No later pin or meter change.' : 'No earlier pin or meter change.');
      return;
    }
    let i = lineIndex(list, cursorQ);
    const here = compare(list[i].q, cursorQ);
    if (direction > 0) i = here > 0 ? i : i + 1; else i = here < 0 ? i : i - 1;
    select(list[clamp(i, 0, list.length - 1)].q);
  }
  function selectNear(time) {
    const line = songMap.nearestLine(time);
    if (line) { cursorQ = line.q; redraw(); render(); }
  }

  // ---- edits --------------------------------------------------------------
  function pinNearest(kind, time) {
    const line = songMap.nearestLine(time, {bars: kind === 'bar'});
    const before = songMap.spanAt(number(line.q));
    const replaced = attempt(() => songMap.edit((d) => pin(d, line.q, time, true), 'pin'));
    if (replaced === FAILED) return;
    cursorQ = line.q;
    const after = songMap.spanAt(number(line.q) - 1e-6), tempo = after.from ? ` · ${describe(after.from.position)}–${describe(line.q)}: ${bpmText(after.endBpm)} BPM` : '';
    say(`Pinned ${describe(line.q)} at ${clock(time)}${tempo}${replaced ? ` · replaced ${replaced} out-of-order pin${replaced === 1 ? '' : 's'}` : ''}${Math.abs(before.startBpm - after.endBpm) > 0.005 && after.from ? ` (was ${bpmText(before.startBpm)})` : ''}. ⌥←/→ if the bar number is off.`);
    redraw(); render();
  }
  function nudge(seconds) {
    const q = cursorQ, existing = pinAt(q), time = existing ? existing.time : timeOf(q);
    const pins = songMap.data.pins, prev = pins.findLast((p) => compare(p.position, q) < 0), next = pins.find((p) => compare(p.position, q) > 0);
    const target = clamp(time + seconds, Math.max(0, (prev?.time ?? -Infinity) + 0.002), (next?.time ?? Infinity) - 0.002);
    if (attempt(() => songMap.edit((d) => pin(d, q, target), 'nudge')) === FAILED) return;
    if (!engine.playing && !preview) engine.seek(clamp(target, 0, duration()));
    if (preview && engine.playing) placePreview();
    say(`${existing ? 'Moved' : 'Pinned'} ${describe(q)} to ${clock(target)}`);
    redraw(); render();
  }
  function renumber(direction, byBeat) {
    const existing = pinAt(cursorQ);
    if (!existing) { say('Select a pinned line to renumber (⌘←/→ jumps between pins).'); return; }
    const all = lines(), list = byBeat ? all : all.filter((l) => l.downbeat);
    const sorted = direction > 0 ? list.find((l) => compare(l.q, cursorQ) > 0) : list.findLast((l) => compare(l.q, cursorQ) < 0);
    if (!sorted) { say('There is no bar line further that way.'); return; }
    const before = describe(cursorQ), target = sorted.q;
    if (attempt(() => songMap.edit((d) => renumberPin(d, cursorQ, target), 'renumber')) === FAILED) return;
    cursorQ = target;
    const span = songMap.spanAt(number(target) - 1e-6);
    say(`${before} is now ${describe(target)}${span.from ? ` · ${bpmText(span.endBpm)} BPM since ${describe(span.from.position)}` : ''}`);
    redraw(); render();
  }
  function changeBeats(delta, onlyThisBar) {
    const index = songMap.barIndexAt(number(cursorQ)), m = songMap.measure(index), next = m.numerator + delta;
    if (next < 1 || next > 16) { say('A bar has between 1 and 16 beats.'); return; }
    const dropped = attempt(() => songMap.edit((d) => editBars(d, index, onlyThisBar ? index : meterRun(d, index), (bar) => setMeter(bar, next, bar.denominator)), 'meter'));
    if (dropped === FAILED) return;
    cursorQ = songMap.barStart(index);
    const until = onlyThisBar ? 'this bar only' : 'until the next change';
    say(`Bar ${index + 1} is ${next}/${m.denominator} (${until})${dropped ? ` · removed ${dropped} pin${dropped === 1 ? '' : 's'} that no longer fit` : ''}`);
    redraw(); render();
  }
  function removePin() {
    if (!pinAt(cursorQ)) { say('This line is not pinned.'); return; }
    if (attempt(() => songMap.edit((d) => unpin(d, cursorQ), 'unpin')) === FAILED) return;
    say(`Unpinned ${describe(cursorQ)}; it now follows the pins around it.`);
    redraw(); render();
  }
  function toggleRamp() {
    const span = songMap.spanAt(number(cursorQ));
    if (!span.from || !span.to) { say('A ramp runs between two pins. Select a line between them.'); return; }
    const pins = songMap.data.pins;
    if (span.index === 0 && pins.length < 3) { say('A ramp needs a steady tempo on one side. Pin one more line after this span.'); return; }
    const q = span.from.position, on = !span.ramp;
    if (attempt(() => songMap.edit((d) => { const p = d.pins.find((x) => compare(x.position, q) === 0); if (on) p.ramp = true; else delete p.ramp; }, 'ramp')) === FAILED) return;
    const next = songMap.spanAt(number(cursorQ));
    say(on ? `Ramp ${describe(q)} → ${describe(span.to.position)}: ${bpmText(next.startBpm)} → ${bpmText(next.endBpm)} BPM` : `Steady tempo ${describe(q)} → ${describe(span.to.position)}`);
    redraw(); render();
  }
  function openTempo(delta) {
    const q = number(cursorQ), span = songMap.spanAt(q);
    if (!span.open || (span.open === 'head' && songMap.data.pins.length > 1)) { say('Tempo here comes from the pins. Move or renumber a pin to change it.'); return; }
    const pulse = pulseOf(songMap.measure(songMap.barIndexAt(q))), bpm = clamp(songMap.bpmAt(q) + delta, MIN_QPM, MAX_QPM);
    if (attempt(() => songMap.edit((d) => { d.tailQpm = clamp(bpm * pulse, MIN_QPM, MAX_QPM); }, 'tempo')) === FAILED) return;
    say(`Open tempo ${bpmText(songMap.bpmAt(q))} BPM`);
    redraw(); render();
  }
  function scale(factor) {
    if (attempt(() => songMap.edit((d) => scaleTempo(d, factor), 'scale')) === FAILED) return;
    cursorQ = fraction(Math.round(number(cursorQ) * factor * 64), 64);
    cursorQ = navigable()[lineIndex(navigable(), cursorQ)]?.q ?? fraction(0);
    say(factor > 1 ? 'Doubled the counted tempo. Pins did not move.' : 'Halved the counted tempo. Pins did not move.');
    redraw(); render();
  }
  function history(redo) {
    const done = attempt(() => redo ? songMap.redo() : songMap.undo());
    if (done === FAILED) return;
    say(done ? (redo ? 'Redone.' : 'Undone.') : (redo ? 'Nothing to redo.' : 'Nothing to undo.'));
    const list = navigable();
    if (list.length && !lineAt(cursorQ)) cursorQ = list[lineIndex(list, cursorQ)].q;
    redraw(); render();
  }
  function goToBar() {
    const bar = parseInt(digits, 10); digits = '';
    const index = clamp((bar || 1) - 1, 0, songMap.data.measures.length - 1);
    select(songMap.barStart(index));
  }

  // ---- bar editor ---------------------------------------------------------
  function openEditor() {
    if (readOnly) return;
    const q = number(cursorQ), index = songMap.barIndexAt(q), m = songMap.measure(index), span = songMap.spanAt(q);
    const open = span.open === 'tail' || (span.open === 'head' && songMap.data.pins.length === 1);
    form.n.value = m.numerator; form.d.value = String(m.denominator);
    form.grouping.value = m.grouping && m.grouping.length > 1 ? m.grouping.join('+') : '';
    form.length.value = number(m.length); form.label.value = m.label; form.scope.value = 'run';
    form.bpm.value = form.bpm.dataset.initial = bpmText(songMap.bpmAt(q)); form.bpm.disabled = !open;
    form.bpm.title = open ? 'Tempo where no later pin decides it' : 'Derived from the pins around this bar';
    strip.querySelector('.map-bpm-unit').textContent = ` ${songMap.pulseLabel(index)}${open ? '' : ' (from pins)'}`;
    form.ramp.checked = span.ramp; form.ramp.disabled = !(span.from && span.to && (span.index > 0 || songMap.data.pins.length > 2));
    form.hidden = false; editing = true;
    form.n.focus(); form.n.select();
    say(`Editing bar ${index + 1}. Enter applies, Esc cancels.`);
  }
  function closeEditor() { form.hidden = true; editing = false; root.querySelector('#timeline-interact')?.focus?.({preventScroll: true}); }
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEditor(); say('Edit cancelled.'); }
    else e.stopPropagation();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = number(cursorQ), index = songMap.barIndexAt(q), n = parseInt(form.n.value, 10), d = parseInt(form.d.value, 10);
    const grouping = form.grouping.value.trim() ? form.grouping.value.split('+').map((x) => parseInt(x.trim(), 10)) : null;
    if (!(n >= 1 && n <= 16)) { say('A bar has between 1 and 16 beats.'); return; }
    if (grouping && (grouping.some((g) => !(g >= 1)) || grouping.reduce((a, b) => a + b, 0) !== n)) { say(`Groups must add up to ${n}.`); return; }
    const length = parseFloat(form.length.value), scope = form.scope.value, label = form.label.value.trim().slice(0, 120);
    const span = songMap.spanAt(q), bpm = parseFloat(form.bpm.value), rampPin = span.from?.position;
    const dropped = attempt(() => songMap.edit((draft) => {
      const end = scope === 'bar' ? index : scope === 'end' ? draft.measures.length - 1 : meterRun(draft, index);
      const count = editBars(draft, index, end, (m, i) => {
        setMeter(m, n, d, grouping || undefined);
        if (i === index) {
          m.label = label;
          const full = number(fullLength(m));
          if (Number.isFinite(length) && length > 0 && length < full - 1e-9) m.length = fraction(Math.max(1, Math.round(length * 16)), 16);
        }
      });
      if (!form.bpm.disabled && Number.isFinite(bpm) && form.bpm.value !== form.bpm.dataset.initial) draft.tailQpm = clamp(bpm * pulseOf(draft.measures[index]), MIN_QPM, MAX_QPM);
      if (!form.ramp.disabled && rampPin) { const p = draft.pins.find((x) => compare(x.position, rampPin) === 0); if (p) { if (form.ramp.checked) p.ramp = true; else delete p.ramp; } }
      return count;
    }, 'bar'));
    if (dropped === FAILED) return;
    cursorQ = songMap.barStart(index);
    closeEditor();
    say(`Bar ${index + 1} updated${dropped ? ` · removed ${dropped} pin${dropped === 1 ? '' : 's'} that no longer fit` : ''}.`);
    redraw(); render();
  });

  // ---- preview loop ---------------------------------------------------------
  function previewBounds() {
    const index = songMap.barIndexAt(number(cursorQ)), first = Math.max(0, index - 1), last = Math.min(songMap.data.measures.length - 1, index + 1);
    const a = clamp(timeOf(songMap.barStart(first)), 0, duration());
    const end = songMap.barStart(last), b = clamp(timeOf(number(end) + number(songMap.measure(last).length)), 0, duration());
    return {a, b};
  }
  function placePreview() {
    const {a, b} = previewBounds();
    engine.setLoop(true, a, b);
    engine.seek(a);
    onLoopChange();
    redraw();
  }
  async function togglePreview() {
    if (preview) { stopPreview(); render(); return; }
    preview = {loop: {...engine.loop}, metronome: metronome.enabled, playing: engine.playing};
    if (!metronome.enabled) metronome.setEnabled(true);
    placePreview();
    if (!engine.playing) { previewStarting = true; try { await play(); } finally { previewStarting = false; } }
    say('Previewing the bars around the selection. ←/→ steps the loop; P stops.');
    render();
  }
  function stopPreview() {
    if (!preview) return;
    const before = preview; preview = null;
    if (engine.playing) play();
    engine.setLoop(before.loop.enabled, before.loop.a, before.loop.b);
    engine.seek(clamp(timeOf(cursorQ), 0, duration()));
    onLoopChange();
    redraw();
  }

  // ---- taps -----------------------------------------------------------------
  function heardTime(e) {
    const ctx = engine.ctx, delay = Math.max(0, Math.min(0.1, (performance.now() - (e.timeStamp || performance.now())) / 1000));
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    return engine.getPositionAt ? engine.getPositionAt(ctx.currentTime - delay - latency - tapOffset()) : engine.getPosition();
  }
  function ensureOnsets() {
    if (onsets) return onsets;
    const track = engine.tracks?.find((t) => t.name === 'drums') || engine.tracks?.[0];
    onsets = track?.buffer ? detectOnsets(track.buffer) : [];
    return onsets;
  }
  function tapTime(e) {
    const time = heardTime(e);
    const hit = snapTaps ? nearestOnset(ensureOnsets(), time, 0.04) : null;
    return hit ?? time;
  }
  function tap(kind, e) {
    const time = tapTime(e);
    if (!pass) { pass = {lastQ: null, count: 0}; songMap.beginBatch(); }
    const all = lines();
    let target;
    if (pass.lastQ === null) target = kind === 'bar' ? (lineAt(cursorQ)?.downbeat ? cursorQ : all.find((l) => l.downbeat && compare(l.q, cursorQ) > 0)?.q) : cursorQ;
    else target = all.find((l) => compare(l.q, pass.lastQ) > 0 && (kind !== 'bar' || l.downbeat))?.q;
    if (!target) { say('No more bars in the map.'); return; }
    const lastQ = pass.lastQ;
    const ok = attempt(() => songMap.edit((d) => {
      // A pass rewrites what it covers: earlier pins skipped by a downbeat tap go too.
      if (lastQ) d.pins = d.pins.filter((p) => !(compare(p.position, lastQ) > 0 && compare(p.position, target) < 0));
      pin(d, target, time, true);
      return true;
    }, 'tap'));
    if (ok === FAILED) return;
    pass.lastQ = target; pass.count++; cursorQ = target;
    const span = songMap.spanAt(number(target) - 1e-6);
    say(`Tap ${pass.count} · ${describe(target)}${span.from ? ` · ${bpmText(span.endBpm)} BPM` : ''}`);
    redraw(); render();
  }
  function finishPass() {
    if (!pass) return;
    const count = pass.count; pass = null;
    songMap.endBatch();
    if (count) say(`Tapped ${count} line${count === 1 ? '' : 's'}. ⌘Z undoes the whole pass.`);
    render();
  }

  // ---- calibration ------------------------------------------------------------
  function startCalibration() {
    if (engine.playing) play();
    const ctx = engine.ctx, interval = 0.6, start = ctx.currentTime + 0.4, clicks = [];
    for (let i = 0; i < 12; i++) { const when = start + i * interval; clicks.push(when); metronome._click(when, i % 4 === 0, false); }
    calibration = {clicks, taps: [], end: start + 12 * interval + 0.3};
    say('Tap T with each click (12 clicks). Your first few taps are ignored.');
    render();
  }
  function calibrationTap(e) {
    const ctx = engine.ctx, delay = Math.max(0, Math.min(0.1, (performance.now() - (e.timeStamp || performance.now())) / 1000));
    const heard = ctx.currentTime - delay - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
    const nearest = calibration.clicks.reduce((a, b) => Math.abs(b - heard) < Math.abs(a - heard) ? b : a);
    calibration.taps.push(heard - nearest);
  }
  function finishCalibration() {
    const taps = calibration.taps.slice(3).sort((a, b) => a - b); calibration = null;
    if (taps.length < 4) { say('Not enough taps to calibrate. Try again and tap T with every click.'); render(); return; }
    const offset = clamp(taps[taps.length >> 1], -0.2, 0.2);
    localStorage.setItem(TAP_OFFSET_KEY, String(offset));
    say(`Your taps land ${Math.abs(Math.round(offset * 1000))} ms ${offset >= 0 ? 'late' : 'early'}. Taps are compensated from now on.`);
    render();
  }

  // ---- mode -------------------------------------------------------------------
  function enter(q = null, {edit = false} = {}) {
    if (readOnly) { say(''); return false; }
    if (!active) {
      active = true;
      saved = {metronome: metronome.enabled, grid: setGridVisible(true)};
      if (!metronome.enabled) metronome.setEnabled(true);
      strip.hidden = false;
      button.classList.add('on'); button.setAttribute('aria-pressed', 'true');
      root.querySelector('.player').classList.add('mapping');
      say('Taps start at the selected line. Play and tap T on every beat (D on downbeats), or stop on a hit and press D.');
    }
    const at = q ?? songMap.nearestLine(engine.getPosition(), {bars: true})?.q ?? fraction(0);
    const list = navigable();
    cursorQ = q ?? (list.length ? list[lineIndex(list, at)].q : fraction(0));
    redraw(); render();
    if (edit) openEditor();
    return true;
  }
  function exit() {
    if (!active) return;
    finishPass(); stopPreview();
    if (editing) closeEditor();
    active = false; digits = '';
    strip.hidden = true;
    button.classList.remove('on'); button.setAttribute('aria-pressed', 'false');
    root.querySelector('.player').classList.remove('mapping');
    if (saved) { if (!saved.metronome && metronome.enabled) metronome.setEnabled(false); setGridVisible(saved.grid); }
    saved = null;
    redraw();
  }
  button.onclick = () => (active ? exit() : enter());
  if (readOnly) { button.disabled = true; button.title = 'Add this song to your library to edit its tempo map'; }

  const actions = {
    undo: () => history(false), redo: () => history(true), edit: openEditor, ramp: toggleRamp, preview: togglePreview,
    double: () => scale(2), half: () => scale(0.5), done: exit, cancel: () => { closeEditor(); say('Edit cancelled.'); },
    snap: () => { snapTaps = !snapTaps; localStorage.setItem(TAP_SNAP_KEY, snapTaps ? '1' : '0'); say(snapTaps ? 'Taps snap to the nearest drum hit within 40 ms.' : 'Taps land exactly where you press.'); render(); },
    calibrate: startCalibration,
  };
  strip.addEventListener('click', (e) => { const b = e.target.closest('button[data-map]'); if (b && actions[b.dataset.map]) { e.preventDefault(); actions[b.dataset.map](); } });

  /** Returns true when the key belongs to map mode. */
  function handleKey(e) {
    const k = e.key, lower = k.length === 1 ? k.toLowerCase() : k, mod = e.metaKey || e.ctrlKey;
    if (!active) {
      if (lower === 'm' && e.shiftKey && !mod && !e.altKey) { enter(); return true; }
      return false;
    }
    if (editing) return false;
    if (calibration && (lower === 't' || lower === 'd')) { if (!e.repeat) calibrationTap(e); return true; }
    if ((lower === 'm' && e.shiftKey && !mod) || k === 'Escape') {
      if (digits) { digits = ''; render(); } else if (preview && k === 'Escape') { stopPreview(); render(); } else exit();
      return true;
    }
    if (mod && !e.altKey) {
      if (lower === 'z') { history(e.shiftKey); return true; }
      if (lower === 'y') { history(true); return true; }
      if (k === 'ArrowLeft' || k === 'ArrowRight') { step(k === 'ArrowRight' ? 1 : -1, 'pin'); return true; }
      return false;
    }
    if (/^[0-9]$/.test(k) && !e.altKey) { if (digits.length < 4) digits += k; render(); return true; }
    if (digits && k === 'Backspace') { digits = digits.slice(0, -1); render(); return true; }
    if (digits && k === 'Enter') { goToBar(); return true; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const direction = k === 'ArrowRight' ? 1 : -1;
      if (e.altKey) renumber(direction, e.shiftKey); else step(direction, e.shiftKey ? 'beat' : 'bar');
      return true;
    }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      if (e.altKey) openTempo((k === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 0.1 : 1)); else changeBeats(k === 'ArrowUp' ? 1 : -1, e.shiftKey);
      return true;
    }
    if (k === 'Home' || k === 'End') { const list = navigable().filter((l) => l.downbeat); if (list.length) select((k === 'Home' ? list[0] : list.at(-1)).q); return true; }
    if (e.altKey) return false;
    if (lower === 'd' || lower === 't') {
      if (e.repeat) return true;
      const kind = lower === 'd' ? 'bar' : 'beat';
      if (engine.countingIn) say('Taps start after the count-in.');
      else if (engine.playing && preview) pinNearest(kind, tapTime(e));
      else if (engine.playing) tap(kind, e);
      else pinNearest(kind, engine.getPosition());
      return true;
    }
    if (e.code === 'Comma' || e.code === 'Period') { nudge((e.code === 'Period' ? 1 : -1) * (e.shiftKey ? 0.001 : 0.01)); return true; }
    if (k === 'Delete' || k === 'Backspace') { removePin(); return true; }
    if (lower === 'e') { openEditor(); return true; }
    if (lower === 'r') { toggleRamp(); return true; }
    if (lower === 'p') { togglePreview(); return true; }
    if (k === '*') { scale(2); return true; }
    if (k === '/') { scale(0.5); return true; }
    return false;
  }

  // ---- pointer: drag pins, click selects a line ---------------------------------
  function pinNearX(x) {
    for (const p of songMap.data.pins) if (Math.abs(timeToX(p.time) - x) <= 6) return p;
    return null;
  }
  function pointerDown(x) {
    if (!active || readOnly) return false;
    const p = pinNearX(x);
    if (!p) return false;
    drag = {q: p.position, moved: false, startX: x};
    songMap.beginBatch();
    cursorQ = p.position;
    render();
    return true;
  }
  function pointerMove(x, time) {
    if (!drag) return false;
    if (Math.abs(x - drag.startX) > 2) drag.moved = true;
    if (drag.moved) {
      const pins = songMap.data.pins, prev = pins.findLast((p) => compare(p.position, drag.q) < 0), next = pins.find((p) => compare(p.position, drag.q) > 0);
      const target = clamp(time, Math.max(0, (prev?.time ?? -Infinity) + 0.002), Math.min(duration(), (next?.time ?? Infinity) - 0.002));
      attempt(() => songMap.edit((d) => pin(d, drag.q, target), 'drag'));
      render();
    }
    return true;
  }
  function pointerUp() {
    if (!drag) return false;
    const moved = drag.moved, q = drag.q; drag = null;
    songMap.endBatch();
    if (moved) say(`Moved ${describe(q)} to ${clock(pinAt(q)?.time)}`);
    else if (!engine.playing) engine.seek(clamp(timeOf(q), 0, duration()));
    redraw(); render();
    return true;
  }

  // ---- lane -----------------------------------------------------------------------
  /** Bar numbers, pins, meter changes and span tempos over the visible window. */
  function renderLane(container, view) {
    container.innerHTML = '';
    const width = Math.max(1, container.clientWidth || 1), html = [];
    const x = (t) => timeToX(t), inView = (t) => t >= view.start - 1e-6 && t <= view.end + 1e-6;
    const starts = songMap.starts, measures = songMap.data.measures;
    // Section labels and meter changes are useful in every mode.
    let lastLabelX = -Infinity;
    measures.forEach((m, i) => {
      const t = timeOf(starts[i]);
      if (!inView(t) || t >= duration()) return;
      const change = i === 0 || !sameMeter(m, measures[i - 1]);
      if (!change && !m.label) return;
      const px = x(t);
      if (px - lastLabelX < 46) return;
      lastLabelX = px;
      html.push(`<div class="tempo-flag" style="left:${px}px">${change ? esc(meterText(m)) : ''}${change && m.label ? ' · ' : ''}${esc(m.label)}</div>`);
    });
    if (active) {
      const barTimes = starts.map((q) => timeOf(q));
      const visible = barTimes.filter((t) => inView(t)).length || 1, every = [1, 2, 4, 8, 16, 32, 64].find((n) => width / (visible / n) >= 30) || 128;
      barTimes.forEach((t, i) => { if (inView(t) && t < duration() && i % every === 0) html.push(`<div class="map-bar-num" style="left:${x(t)}px">${i + 1}</div>`); });
      const pins = songMap.compiled.pins, spans = songMap.compiled.spans;
      pins.forEach((p, i) => {
        if (inView(p.time)) html.push(`<div class="map-pin${compare(p.position, cursorQ) === 0 ? ' selected' : ''}" style="left:${x(p.time)}px" title="${esc(describe(p.position))} · ${clock(p.time)}"></div>`);
        const s = spans[i];
        if (!s) return;
        const a = Math.max(view.start, s.t0), b = Math.min(view.end, s.t1);
        if (b <= a) return;
        const bar = songMap.barIndexAt(s.p0), pulse = pulseOf(songMap.measure(bar)), unit = pulse === 1 ? '' : songMap.pulseLabel(bar);
        if (s.ramp) html.push(`<div class="map-ramp" style="left:${x(a)}px;width:${x(b) - x(a)}px"></div>`);
        if (x(s.t1) - x(s.t0) >= 64) {
          const label = unit + (s.ramp ? `${bpmText(s.v0 * 60 / pulse)}→${bpmText(s.v1 * 60 / pulse)}` : bpmText(s.v0 * 60 / pulse));
          html.push(`<div class="map-bpm" style="left:${(x(a) + x(b)) / 2}px">${label}</div>`);
        }
      });
      const last = pins.at(-1);
      if (last && last.time < view.end) {
        const a = Math.max(view.start, last.time), tail = songMap.spanAt(number(last.position) + 1e-6);
        html.push(`<div class="map-bpm open" style="left:${Math.min(width - 40, x(a) + 40)}px">${bpmText(tail.startBpm)} →</div>`);
      }
    }
    container.innerHTML = html.join('');
  }

  function tick() {
    if (!active) { cursorEl.style.display = 'none'; return; }
    if (pass && !engine.playing) finishPass();
    if (calibration && engine.ctx.currentTime > calibration.end) finishCalibration();
    // Stopping the transport ends a preview; the user's own loop comes back.
    if (preview && !engine.playing && !previewStarting) { stopPreview(); render(); }
    const view = getView(), t = timeOf(cursorQ), inside = t >= view.start && t <= view.end;
    cursorEl.style.display = inside ? 'block' : 'none';
    if (inside) cursorEl.style.left = timeToX(t) + 'px';
  }

  const unsubscribe = songMap.subscribe(() => { if (active) render(); });
  return {
    active: () => active, enter, exit, handleKey, pointerDown, pointerMove, pointerUp, selectNear, renderLane, tick,
    refresh: render, destroy() { exit(); unsubscribe(); },
  };
}

