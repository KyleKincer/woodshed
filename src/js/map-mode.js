// Map mode: a keyboard scope for building the song map. A selected line
// (bar line or beat) is the cursor. D/T pin a downbeat/beat at the playhead,
// or tap while playing; tempo between pins is derived. The UI is a tempo
// lane above the stems and an inspector below them.
import {fraction, number, compare} from '../../shared/notation.ts';
import {pin, unpin, renumberPin, editBars, rebarBars, beatsPinnedNear, setMeter, meterRun, scaleTempo, fullLength, sameMeter, MIN_QPM, MAX_QPM, pulseOf} from '../../shared/song-map.ts';
import {detectOnsets, nearestOnset} from './onsets.js';
import {drawLane} from './map-lane.js';

const TAP_SNAP_KEY = 'ws.tapSnap', TAP_OFFSET_KEY = 'ws.tapOffset';
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const bpmText = (bpm) => (Math.round(bpm * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function clock(t) {
  if (!Number.isFinite(t)) return '—';
  const sign = t < 0 ? '−' : '', a = Math.abs(t), m = Math.floor(a / 60), s = a - m * 60;
  return `${sign}${m}:${s.toFixed(3).padStart(6, '0')}`;
}
const kbd = (k) => `<kbd>${esc(k)}</kbd>`;
const icon = (paths) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const UNDO = icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>');
const REDO = icon('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>');
const MORE = icon('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>');

/** Every key, grouped the way people think about the job. */
export const MAP_KEYS = [
  ['Move', [['← →', 'Previous / next bar'], ['⇧ ← →', 'Previous / next beat'], ['⌘ ← →', 'Previous / next pin or meter change'], ['1–9 ↵', 'Go to a bar'], ['Home End', 'First / last bar']]],
  ['Pin and tap', [['D', 'Pin the downbeat at the playhead'], ['T', 'Pin the beat at the playhead'], ['Space', 'Play, then tap T on every beat'], [', .', 'Nudge 10 ms (⇧ 1 ms)'], ['⌥ ← →', 'Wrong bar number? Move the pin'], ['⌫', 'Unpin']]],
  ['Shape', [['↑ ↓', 'Beats in this bar (⇧ this bar only)'], ['E', 'Edit bar'], ['R', 'Ramp to the next pin'], ['P', 'Loop these bars'], ['* /', 'Double / halve the tempo'], ['⌥ ↑ ↓', 'Tempo after the last pin'], ['⌘Z', 'Undo'], ['Esc', 'Done']]],
];

export function createMapMode({root, engine, songMap, metronome, readOnly = false, getView, setView, setFollow, timeToX, play, setGridVisible, redraw, onLoopChange = () => {}, onDetect = null}) {
  const panel = root.querySelector('#map-strip');
  const button = root.querySelector('#map-btn');
  const cursorEl = root.querySelector('#map-cursor');
  let active = false, cursorQ = fraction(0), digits = '', preview = null, previewStarting = false, pass = null, calibration = null, drag = null;
  let saved = null, onsets = null, editing = false, hoverPin = null, laneHits = [], tone = 'info', message = '';
  let snapTaps = localStorage.getItem(TAP_SNAP_KEY) !== '0';
  const tapOffset = () => { const v = parseFloat(localStorage.getItem(TAP_OFFSET_KEY)); return Number.isFinite(v) ? clamp(v, -0.2, 0.2) : 0; };

  panel.className = 'map-inspector';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Tempo map');
  panel.innerHTML = `
    <div class="mi-main">
      <span class="mi-mode">Tempo map</span>
      <div class="mi-cells">
        <div class="mi-cell"><span class="mi-k">Bar</span><span class="mi-v" data-cell="bar"></span><span class="mi-s" data-cell="bar-sub"></span></div>
        <div class="mi-cell"><span class="mi-k">Meter</span><span class="mi-v" data-cell="meter"></span><span class="mi-s" data-cell="meter-sub"></span></div>
        <div class="mi-cell mi-wide"><span class="mi-k">Tempo</span><span class="mi-v mi-num" data-cell="tempo"></span><span class="mi-s" data-cell="tempo-sub"></span></div>
        <div class="mi-cell"><span class="mi-k">Pin</span><span class="mi-v mi-num" data-cell="pin"></span><span class="mi-s" data-cell="pin-sub"></span></div>
      </div>
      <div class="mi-actions">
        <button type="button" class="mi-btn primary" data-map="pin"></button>
        <button type="button" class="mi-btn" data-map="tap"></button>
        <button type="button" class="mi-btn" data-map="edit">Edit bar ${kbd('E')}</button>
        <button type="button" class="mi-icon" data-map="more" aria-label="More tempo map tools" aria-haspopup="menu" aria-expanded="false">${MORE}</button>
        <span class="mi-rule" aria-hidden="true"></span>
        <button type="button" class="mi-icon" data-map="undo" aria-label="Undo" title="Undo (⌘Z)">${UNDO}</button>
        <button type="button" class="mi-icon" data-map="redo" aria-label="Redo" title="Redo (⇧⌘Z)">${REDO}</button>
        <button type="button" class="mi-btn mi-done" data-map="done" title="Leave the tempo map (Esc)">Done</button>
      </div>
    </div>
    <div class="mi-foot">
      <p class="mi-msg" id="map-note" role="status"></p>
      <p class="mi-hint" id="map-hint"></p>
    </div>
    <form class="map-editor" hidden>
      <div class="me-title"><span class="mi-k">Editing</span><b data-cell="edit-bar"></b></div>
      <label class="me-field"><span class="mi-k">Beats</span><span class="me-meter"><input name="n" type="number" min="1" max="16" required inputmode="numeric"><span>/</span><select name="d">${[1, 2, 4, 8, 16].map((d) => `<option value="${d}">${d}</option>`).join('')}</select></span></label>
      <label class="me-field"><span class="mi-k">Groups</span><input name="grouping" placeholder="even" size="7" title="How the beats are counted, e.g. 2+2+3 for a 7/8 felt in three"></label>
      <label class="me-field me-length"><span class="mi-k">Pickup</span><span class="me-unit"><input name="pickup" type="number" min="0.25" max="64" step="any"><span>♩</span></span></label>
      <label class="me-field"><span class="mi-k">Label</span><input name="label" maxlength="120" placeholder="Verse, chorus…" size="12"></label>
      <fieldset class="me-field me-scope"><legend class="mi-k">Apply to</legend><div class="me-seg">
        <label><input type="radio" name="scope" value="bar">This bar</label>
        <label><input type="radio" name="scope" value="run" checked>Until next change</label>
        <label><input type="radio" name="scope" value="end">To the end</label>
      </div></fieldset>
      <fieldset class="me-field me-scope"><legend class="mi-k">Keep in place</legend><div class="me-seg">
        <label title="Beats stay at their times; later bar lines slide"><input type="radio" name="keep" value="beats">Beats</label>
        <label title="Pinned bar lines stay; the beats between them re-spread"><input type="radio" name="keep" value="lines">Bar lines</label>
      </div></fieldset>
      <label class="me-field me-bpm"><span class="mi-k">Tempo</span><span class="me-unit"><input name="bpm" type="number" min="10" max="1000" step="any"><span data-cell="bpm-unit"></span></span></label>
      <label class="me-check"><input type="checkbox" name="ramp"> Ramp to next pin</label>
      <div class="me-actions"><button type="button" class="mi-btn" data-map="cancel">Cancel</button><button type="submit" class="mi-btn primary">Apply ${kbd('↵')}</button></div>
    </form>
    <div class="mi-menu" role="menu" hidden></div>
    <div class="mi-keys" role="group" aria-label="Tempo map keys" hidden>
      ${MAP_KEYS.map(([title, rows]) => `<section><h3>${esc(title)}</h3>${rows.map(([k, v]) => `<div>${k.split(' ').map(kbd).join('')}<span>${esc(v)}</span></div>`).join('')}</section>`).join('')}
    </div>`;
  const cells = Object.fromEntries([...panel.querySelectorAll('[data-cell]')].map((el) => [el.dataset.cell, el]));
  const noteEl = panel.querySelector('#map-note'), hintEl = panel.querySelector('#map-hint'), form = panel.querySelector('.map-editor');
  const menu = panel.querySelector('.mi-menu'), keys = panel.querySelector('.mi-keys'), moreButton = panel.querySelector('[data-map="more"]');

  // The lane lives between the time ruler and the stems.
  const lane = document.createElement('div');
  lane.className = 'map-lane'; lane.hidden = true;
  lane.innerHTML = '<div class="map-lane-key"><span>Tempo <small>BPM</small></span><div class="map-lane-scale"></div></div><div class="map-lane-plot"><canvas aria-label="Tempo over time" role="img"></canvas><div class="map-lane-head"></div><div class="map-lane-tip" hidden></div></div>';
  (root.querySelector('.time-ruler') || root.querySelector('.tracks'))?.after(lane);
  const laneCanvas = lane.querySelector('canvas'), laneScale = lane.querySelector('.map-lane-scale'), laneHead = lane.querySelector('.map-lane-head'), laneTip = lane.querySelector('.map-lane-tip');

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
    return line && !line.downbeat ? `bar ${index + 1} beat ${line.beat}` : `bar ${index + 1}`;
  }
  /** A song that has never been mapped still has only the default pin at bar 1. */
  const unmapped = () => songMap.data.pins.length === 1 && songMap.data.pins[0].time === 0 && songMap.undoStack.length === 0;

  function say(text, kind = 'info') { message = text; tone = kind; renderFoot(); }
  const FAILED = Symbol('failed');
  function attempt(fn) {
    try { return fn(); }
    catch (error) { say(error.message || String(error), 'error'); return FAILED; }
  }

  // ---- inspector ----------------------------------------------------------
  function hintFor() {
    if (calibration) return [['T', 'with each click']];
    if (preview) return [['← →', 'step the loop'], [', .', 'nudge'], ['P', 'stop']];
    if (engine.playing) return [['T', 'every beat'], ['D', 'downbeats'], ['Space', 'stop']];
    if (digits) return [['↵', 'go to bar'], ['Esc', 'cancel']];
    if (unmapped()) return [['D', 'on the first downbeat'], ['Space', 'then T to tap along']];
    if (pinAt(cursorQ)) return [[', .', 'nudge'], ['⌥ ← →', 'wrong bar number'], ['⌫', 'unpin']];
    return [['← →', 'bars'], ['D', 'pin here'], ['↑ ↓', 'beats in bar']];
  }
  function renderFoot() {
    const text = message || (unmapped() ? 'New map: stop on the first downbeat and press D, or play and tap T on every beat.' : '');
    noteEl.textContent = text;
    noteEl.dataset.tone = message ? tone : 'info';
    hintEl.innerHTML = hintFor().map(([k, v]) => `<span>${k.split(' ').map(kbd).join('')} ${esc(v)}</span>`).join('') + '<button type="button" class="mi-allkeys" data-map="keys">All keys ' + kbd('?') + '</button>';
  }
  function render() {
    if (!active) return;
    // Before the first real pin, bar 1's default pin is only a placeholder.
    const fresh = unmapped(), q = number(cursorQ), index = songMap.barIndexAt(q), m = songMap.measure(index), span = songMap.spanAt(q), p = fresh ? null : pinAt(cursorQ), line = lineAt(cursorQ);
    const unit = songMap.pulseLabel(index);
    cells.bar.innerHTML = digits ? `<span class="mi-goto">Go to ${esc(digits)}<i></i></span>` : `${index + 1}`;
    cells['bar-sub'].textContent = digits ? 'Enter to jump' : line && !line.downbeat ? `beat ${line.beat}` : 'downbeat';
    cells.meter.textContent = `${m.numerator}/${m.denominator}`;
    const groups = m.grouping && m.grouping.length > 1 && !m.grouping.every((g) => g === 1) ? m.grouping.join('+') : '';
    cells['meter-sub'].textContent = [groups, m.label].filter(Boolean).join(' · ') || (index === 0 && number(m.length) < number(fullLength(m)) ? 'pickup' : '');
    cells.tempo.innerHTML = span.ramp
      ? `<span class="mi-unit">${unit}</span>${bpmText(span.startBpm)}<span class="mi-arrow">→</span>${bpmText(span.endBpm)}`
      : `<span class="mi-unit">${unit}</span>${songMap.bpmAt(q).toFixed(2)}`;
    cells['tempo-sub'].textContent = fresh ? 'a placeholder until you pin'
      : span.ramp ? `ramp to ${describe(span.to.position)}`
      : span.open === 'tail' ? 'after the last pin · ⌥↑↓ sets it'
      : span.open === 'head' ? 'before the first pin'
      : `steady to ${describe(span.to.position)}`;
    cells.pin.innerHTML = p ? `<i class="mi-glyph on"></i>${clock(p.time)}` : `<i class="mi-glyph"></i><span class="mi-free">${fresh ? 'none yet' : 'free'}</span>`;
    cells['pin-sub'].textContent = p ? 'locked to the recording' : fresh ? 'D pins a downbeat here' : 'follows the pins around it';
    const pinButton = panel.querySelector('[data-map="pin"]');
    pinButton.innerHTML = p ? `Unpin ${kbd('⌫')}` : `Pin here ${kbd('D')}`;
    pinButton.classList.toggle('primary', !p);
    panel.querySelector('[data-map="tap"]').innerHTML = engine.playing && !preview ? `Stop ${kbd('Space')}` : `Tap along ${kbd('Space')}`;
    panel.querySelector('[data-map="undo"]').disabled = !songMap.undoStack.length && !songMap.batch?.changed;
    panel.querySelector('[data-map="redo"]').disabled = !songMap.redoStack.length;
    panel.classList.toggle('is-live', !!pass || !!calibration);
    renderFoot();
    if (!menu.hidden) renderMenu();
  }

  // ---- menu and key sheet -------------------------------------------------
  function renderMenu() {
    const span = songMap.spanAt(number(cursorQ));
    const item = (action, label, key = '', checked = null, disabled = false) => `<button type="button" role="${checked === null ? 'menuitem' : 'menuitemcheckbox'}" ${checked === null ? '' : `aria-checked="${checked}"`} data-map="${action}" ${disabled ? 'disabled' : ''}><i class="mi-check"></i><span>${esc(label)}</span>${key ? kbd(key) : ''}</button>`;
    menu.innerHTML = [
      item('ramp', 'Ramp to the next pin', 'R', span.ramp, !(span.from && span.to)),
      item('preview', 'Loop these bars', 'P', !!preview),
      '<hr>',
      item('double', 'Double the tempo', '*'),
      item('half', 'Halve the tempo', '/'),
      '<hr>',
      item('snap', 'Snap taps to drum hits', '', snapTaps),
      item('calibrate', 'Calibrate tap timing'),
      ...(onDetect && !readOnly ? ['<hr>', item('detect', 'Detect beats automatically')] : []),
      '<hr>',
      item('keys', 'All keys', '?'),
    ].join('');
  }
  function toggleMenu(open = menu.hidden) {
    if (open) { closeKeys(); renderMenu(); }
    menu.hidden = !open;
    moreButton.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('button:not(:disabled)')?.focus({preventScroll: true});
  }
  function closeKeys() { keys.hidden = true; }
  function toggleKeys() { const open = keys.hidden; toggleMenu(false); keys.hidden = !open; }
  const onOutside = (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !moreButton.contains(e.target)) toggleMenu(false);
    if (!keys.hidden && !keys.contains(e.target) && !e.target.closest?.('[data-map="keys"]')) closeKeys();
  };
  document.addEventListener('pointerdown', onOutside);

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
  function selectNear(time, options = {}) {
    const line = songMap.nearestLine(time, options);
    if (line) { cursorQ = line.q; redraw(); render(); }
  }

  // ---- edits --------------------------------------------------------------
  const tempoSince = (q) => { const span = songMap.spanAt(number(q) - 1e-6); return span.from ? ` · ${bpmText(span.endBpm)} BPM since ${describe(span.from.position)}` : ''; };
  function pinLine(q, time) {
    const replaced = attempt(() => songMap.edit((d) => pin(d, q, time, true), 'pin'));
    if (replaced === FAILED) return;
    cursorQ = q;
    say(`Pinned ${describe(q)} at ${clock(time)}${tempoSince(q)}${replaced ? ` · replaced ${replaced} out-of-order pin${replaced === 1 ? '' : 's'}` : ''}`, 'ok');
    redraw(); render();
  }
  function pinNearest(kind, time) { pinLine(songMap.nearestLine(time, {bars: kind === 'bar'}).q, time); }
  function nudge(seconds) {
    const q = cursorQ, existing = pinAt(q), time = existing ? existing.time : timeOf(q);
    const pins = songMap.data.pins, prev = pins.findLast((p) => compare(p.position, q) < 0), next = pins.find((p) => compare(p.position, q) > 0);
    const target = clamp(time + seconds, Math.max(0, (prev?.time ?? -Infinity) + 0.002), (next?.time ?? Infinity) - 0.002);
    if (attempt(() => songMap.edit((d) => pin(d, q, target), 'nudge')) === FAILED) return;
    if (!engine.playing && !preview) engine.seek(clamp(target, 0, duration()));
    if (preview && engine.playing) placePreview();
    say(`${existing ? 'Moved' : 'Pinned'} ${describe(q)} to ${clock(target)}`, 'ok');
    redraw(); render();
  }
  function renumber(direction, byBeat) {
    if (!pinAt(cursorQ)) { say('Select a pin to move its bar number. ⌘← → jumps between pins.'); return; }
    const all = lines(), list = byBeat ? all : all.filter((l) => l.downbeat);
    const found = direction > 0 ? list.find((l) => compare(l.q, cursorQ) > 0) : list.findLast((l) => compare(l.q, cursorQ) < 0);
    if (!found) { say('There is no bar further that way.'); return; }
    const before = describe(cursorQ), target = found.q;
    if (attempt(() => songMap.edit((d) => renumberPin(d, cursorQ, target), 'renumber')) === FAILED) return;
    cursorQ = target;
    say(`${before} is now ${describe(target)}${tempoSince(target)}`, 'ok');
    redraw(); render();
  }
  /**
   * Two ways to change a meter. Keep beats: every beat stays at its time and
   * later bar lines slide (re-barring). Keep bar lines: pinned bar lines stay
   * and the beats between them re-spread (fixing a miscount between downbeats).
   */
  const keepBeatsByDefault = (from, to) => beatsPinnedNear(songMap.data, from, to);
  function meterEdit(index, end, keep, patch) {
    if (keep === 'beats' && songMap.notationAfter(index)) throw new Error('Later bars have drum notes, so the bar lines can’t slide. Keep bar lines instead (Edit bar, E).');
    return songMap.edit((d) => (keep === 'beats' ? rebarBars : editBars)(d, index, end(d), patch), 'meter');
  }
  function meterNote(index, meter, keep, scope, dropped) {
    const kept = keep === 'beats' ? 'beats stayed put, later bar lines moved' : 'pinned bar lines stayed put, the beats re-spread';
    return `Bar ${index + 1} is ${meter} ${scope} · ${kept}${dropped ? ` · removed ${dropped} pin${dropped === 1 ? '' : 's'} that no longer fit` : ''}`;
  }
  function changeBeats(delta, onlyThisBar) {
    const index = songMap.barIndexAt(number(cursorQ)), m = songMap.measure(index), next = m.numerator + delta;
    if (next < 1 || next > 16) { say('A bar has between 1 and 16 beats.', 'error'); return; }
    const end = (d) => onlyThisBar ? index : meterRun(d, index), keep = keepBeatsByDefault(index, end(songMap.data)) ? 'beats' : 'lines';
    const dropped = attempt(() => meterEdit(index, end, keep, (bar) => setMeter(bar, next, bar.denominator)));
    if (dropped === FAILED) return;
    cursorQ = songMap.barStart(index);
    say(meterNote(index, `${next}/${m.denominator}`, keep, onlyThisBar ? 'for this bar' : 'until the next change', dropped), 'ok');
    redraw(); render();
  }
  function removePin() {
    if (!pinAt(cursorQ)) { say('This line isn’t pinned.'); return; }
    if (attempt(() => songMap.edit((d) => unpin(d, cursorQ), 'unpin')) === FAILED) return;
    say(`Unpinned ${describe(cursorQ)}. It now follows the pins around it.`, 'ok');
    redraw(); render();
  }
  function toggleRamp() {
    const span = songMap.spanAt(number(cursorQ));
    if (!span.from || !span.to) { say('A ramp runs between two pins. Select a line between them.'); return; }
    if (span.index === 0 && songMap.data.pins.length < 3) { say('A ramp needs a steady tempo next to it. Pin one more line after this span.'); return; }
    const q = span.from.position, on = !span.ramp;
    if (attempt(() => songMap.edit((d) => { const p = d.pins.find((x) => compare(x.position, q) === 0); if (on) p.ramp = true; else delete p.ramp; }, 'ramp')) === FAILED) return;
    const next = songMap.spanAt(number(cursorQ));
    say(on ? `Ramp from ${describe(q)} to ${describe(span.to.position)}: ${bpmText(next.startBpm)} → ${bpmText(next.endBpm)} BPM` : `Steady from ${describe(q)} to ${describe(span.to.position)}`, 'ok');
    redraw(); render();
  }
  function openTempo(delta) {
    const q = number(cursorQ), span = songMap.spanAt(q);
    if (!span.open || (span.open === 'head' && songMap.data.pins.length > 1)) { say('Tempo here comes from the pins around it. Move or renumber a pin to change it.'); return; }
    const pulse = pulseOf(songMap.measure(songMap.barIndexAt(q))), bpm = clamp(songMap.bpmAt(q) + delta, MIN_QPM, MAX_QPM);
    if (attempt(() => songMap.edit((d) => { d.tailQpm = clamp(bpm * pulse, MIN_QPM, MAX_QPM); }, 'tempo')) === FAILED) return;
    say(`Tempo after the last pin: ${bpmText(songMap.bpmAt(q))} BPM`, 'ok');
    redraw(); render();
  }
  function scale(factor) {
    if (attempt(() => songMap.edit((d) => scaleTempo(d, factor), 'scale')) === FAILED) return;
    cursorQ = fraction(Math.round(number(cursorQ) * factor * 64), 64);
    cursorQ = navigable()[lineIndex(navigable(), cursorQ)]?.q ?? fraction(0);
    say(factor > 1 ? 'Doubled the tempo. Every pin stayed where it was.' : 'Halved the tempo. Every pin stayed where it was.', 'ok');
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
    toggleMenu(false); closeKeys();
    const q = number(cursorQ), index = songMap.barIndexAt(q), m = songMap.measure(index), span = songMap.spanAt(q);
    const open = span.open === 'tail' || (span.open === 'head' && songMap.data.pins.length === 1);
    const partial = number(m.length) < number(fullLength(m)) - 1e-9;
    cells['edit-bar'].textContent = `Bar ${index + 1}`;
    form.n.value = m.numerator; form.d.value = String(m.denominator);
    form.grouping.value = m.grouping && m.grouping.length > 1 && !m.grouping.every((g) => g === 1) ? m.grouping.join('+') : '';
    form.pickup.value = number(partial ? m.length : fullLength(m)); form.label.value = m.label; form.querySelector('input[name="scope"][value="run"]').checked = true;
    form.querySelector(`input[name="keep"][value="${keepBeatsByDefault(index, meterRun(songMap.data, index)) ? 'beats' : 'lines'}"]`).checked = true;
    // Hidden fields are disabled so they can never block Apply through validation.
    form.querySelector('.me-length').hidden = form.pickup.disabled = !(index === 0 || partial);
    form.bpm.value = form.bpm.dataset.initial = songMap.bpmAt(q).toFixed(2);
    form.querySelector('.me-bpm').hidden = form.bpm.disabled = !open;
    cells['bpm-unit'].textContent = songMap.pulseLabel(index);
    form.ramp.checked = span.ramp; form.querySelector('.me-check').hidden = form.ramp.disabled = !(span.from && span.to && (span.index > 0 || songMap.data.pins.length > 2));
    form.hidden = false; editing = true; panel.classList.add('is-editing');
    form.n.focus(); form.n.select();
  }
  function closeEditor() { form.hidden = true; editing = false; panel.classList.remove('is-editing'); root.querySelector('#timeline-interact')?.focus?.({preventScroll: true}); }
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEditor(); render(); }
    else e.stopPropagation();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = number(cursorQ), index = songMap.barIndexAt(q), n = parseInt(form.n.value, 10), d = parseInt(form.d.value, 10);
    const grouping = form.grouping.value.trim() ? form.grouping.value.split('+').map((x) => parseInt(x.trim(), 10)) : null;
    if (!(n >= 1 && n <= 16)) { say('A bar has between 1 and 16 beats.', 'error'); return; }
    if (grouping && (grouping.some((g) => !(g >= 1)) || grouping.reduce((a, b) => a + b, 0) !== n)) { say(`Groups must add up to ${n}, like ${n === 7 ? '2+2+3' : n === 5 ? '3+2' : `${n - 1}+1`}.`, 'error'); return; }
    const length = parseFloat(form.pickup.value), scope = form.querySelector('input[name="scope"]:checked')?.value || 'run', label = form.label.value.trim().slice(0, 120);
    const span = songMap.spanAt(q), bpm = parseFloat(form.bpm.value), rampPin = span.from?.position;
    const lengthShown = !form.querySelector('.me-length').hidden, bpmShown = !form.querySelector('.me-bpm').hidden, rampShown = !form.querySelector('.me-check').hidden;
    const keep = form.querySelector('input[name="keep"]:checked')?.value || 'lines', before = songMap.measure(index);
    const meterChanged = before.numerator !== n || before.denominator !== d || (before.grouping || []).join('+') !== (grouping || []).join('+') || (lengthShown && Math.abs(length - number(before.length)) > 1e-9);
    if (meterChanged && keep === 'beats' && songMap.notationAfter(index)) { say('Later bars have drum notes, so the bar lines can’t slide. Choose Keep bar lines.', 'error'); return; }
    const dropped = attempt(() => songMap.edit((draft) => {
      const end = scope === 'bar' ? index : scope === 'end' ? draft.measures.length - 1 : meterRun(draft, index);
      const count = (keep === 'beats' ? rebarBars : editBars)(draft, index, end, (m, i) => {
        setMeter(m, n, d, grouping || undefined);
        if (i === index) {
          m.label = label;
          const full = number(fullLength(m));
          if (lengthShown && Number.isFinite(length) && length > 0 && length < full - 1e-9) m.length = fraction(Math.max(1, Math.round(length * 16)), 16);
        }
      });
      if (bpmShown && Number.isFinite(bpm) && form.bpm.value !== form.bpm.dataset.initial) draft.tailQpm = clamp(bpm * pulseOf(draft.measures[index]), MIN_QPM, MAX_QPM);
      if (rampShown && rampPin) { const p = draft.pins.find((x) => compare(x.position, rampPin) === 0); if (p) { if (form.ramp.checked) p.ramp = true; else delete p.ramp; } }
      return count;
    }, 'bar'));
    if (dropped === FAILED) return;
    cursorQ = songMap.barStart(index);
    closeEditor();
    say(meterChanged ? meterNote(index, `${n}/${d}`, keep, scope === 'bar' ? 'for this bar' : scope === 'end' ? 'to the end' : 'until the next change', dropped) : `Bar ${index + 1} updated`, 'ok');
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
    say('Looping the bars around the selection. ← → steps the loop.');
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
    if (!target) { say('No more bars in the map.', 'error'); return; }
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
    say(`Tap ${pass.count} · ${describe(target)}${span.from ? ` · ${bpmText(span.endBpm)} BPM` : ''}`, 'ok');
    redraw(); render();
  }
  function finishPass() {
    if (!pass) return;
    const count = pass.count; pass = null;
    songMap.endBatch();
    if (count) say(`Tapped ${count} line${count === 1 ? '' : 's'}. ⌘Z undoes the whole pass.`, 'ok');
    render();
  }

  // ---- calibration ------------------------------------------------------------
  function startCalibration() {
    if (engine.playing) play();
    const ctx = engine.ctx, interval = 0.6, start = ctx.currentTime + 0.4, clicks = [];
    for (let i = 0; i < 12; i++) { const when = start + i * interval; clicks.push(when); metronome._click(when, i % 4 === 0, false); }
    calibration = {clicks, taps: [], end: start + 12 * interval + 0.3};
    say('Tap T with each of the 12 clicks. The first few taps are ignored.');
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
    if (taps.length < 4) { say('Not enough taps to calibrate. Try again and tap T with every click.', 'error'); render(); return; }
    const offset = clamp(taps[taps.length >> 1], -0.2, 0.2);
    localStorage.setItem(TAP_OFFSET_KEY, String(offset));
    say(`Your taps land ${Math.abs(Math.round(offset * 1000))} ms ${offset >= 0 ? 'late' : 'early'}. Taps are corrected from now on.`, 'ok');
    render();
  }

  // ---- mode -------------------------------------------------------------------
  function enter(q = null, {edit = false} = {}) {
    if (readOnly) return false;
    if (!active) {
      active = true; message = '';
      saved = {metronome: metronome.enabled, grid: setGridVisible(true)};
      if (!metronome.enabled) metronome.setEnabled(true);
      panel.hidden = false; lane.hidden = false;
      button.classList.add('on'); button.setAttribute('aria-pressed', 'true');
      root.querySelector('.player').classList.add('mapping');
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
    toggleMenu(false); closeKeys();
    active = false; digits = '';
    panel.hidden = true; lane.hidden = true;
    button.classList.remove('on'); button.setAttribute('aria-pressed', 'false');
    root.querySelector('.player').classList.remove('mapping');
    if (saved) { if (!saved.metronome && metronome.enabled) metronome.setEnabled(false); setGridVisible(saved.grid); }
    saved = null;
    redraw();
  }
  button.onclick = () => (active ? exit() : enter());
  if (readOnly) { button.disabled = true; button.title = 'Add this song to your library to edit its tempo map'; }

  const actions = {
    pin: () => (pinAt(cursorQ) && !unmapped() ? removePin() : pinLine(cursorQ, engine.playing ? engine.getPosition() : clamp(engine.getPosition(), 0, duration()))),
    tap: async () => { if (engine.playing) { play(); return; } if (preview) stopPreview(); await play(); say('Tap T on every beat. D on a downbeat keeps the bars in step.'); render(); },
    undo: () => history(false), redo: () => history(true), edit: openEditor, ramp: toggleRamp, preview: togglePreview,
    double: () => scale(2), half: () => scale(0.5), done: exit, cancel: () => { closeEditor(); render(); },
    snap: () => { snapTaps = !snapTaps; localStorage.setItem(TAP_SNAP_KEY, snapTaps ? '1' : '0'); say(snapTaps ? 'Taps snap to the nearest drum hit within 40 ms.' : 'Taps land exactly where you press.'); render(); },
    calibrate: startCalibration, detect: () => onDetect?.((text, kind) => say(text, kind)), keys: toggleKeys,
    more: () => toggleMenu(),
  };
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-map]');
    if (!b || !actions[b.dataset.map]) return;
    e.preventDefault();
    if (b.closest('.mi-menu') && b.dataset.map !== 'keys') toggleMenu(false);
    actions[b.dataset.map]();
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button:not(:disabled)')], i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); toggleMenu(false); moreButton.focus(); }
  });

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
      if (!menu.hidden) toggleMenu(false);
      else if (!keys.hidden) closeKeys();
      else if (digits) { digits = ''; render(); }
      else if (preview && k === 'Escape') { stopPreview(); render(); }
      else exit();
      return true;
    }
    if (k === '?') { toggleKeys(); return true; }
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

  // ---- lane -----------------------------------------------------------------------
  function laneColors() {
    return {accent: cssVar('--accent'), accentFill: cssVar('--accent-fill') || cssVar('--accent'), text: cssVar('--text'), muted: cssVar('--muted'), border: cssVar('--border'),
      paper: cssVar('--bg-2'), ruler: cssVar('--bg'), minor: cssVar('--grid-minor'), warn: cssVar('--warn'), selected: cssVar('--loop-fill') || 'rgba(23,75,209,.08)',
      fill: cssVar('--map-fill') || 'rgba(23,75,209,.07)', connector: cssVar('--map-connector') || cssVar('--border'), open: cssVar('--muted')};
  }
  function drawTempoLane(view) {
    if (!active || lane.hidden || !laneCanvas.clientWidth) return;
    const result = drawLane(laneCanvas, {songMap, view, timeToX, duration: duration(), cursorQ, hoverPin, color: laneColors()});
    laneHits = result.hits;
    laneScale.innerHTML = result.guides.map((g) => `<span style="top:${g.y}px">${Math.round(g.value)}</span>`).join('');
  }
  /** Meter changes and section labels over the waveform; the lane takes over while mapping. */
  function renderFlags(container, view) {
    const html = [];
    if (!active) {
      const starts = songMap.starts, measures = songMap.data.measures;
      let lastX = -Infinity;
      measures.forEach((m, i) => {
        const t = timeOf(starts[i]);
        if (t < view.start - 1e-6 || t > view.end + 1e-6 || t >= duration()) return;
        const change = i === 0 || !sameMeter(m, measures[i - 1]);
        if (!change && !m.label) return;
        const px = timeToX(t);
        if (px - lastX < 46) return;
        lastX = px;
        html.push(`<div class="tempo-flag" style="left:${px}px">${change ? `${m.numerator}/${m.denominator}` : ''}${change && m.label ? ' · ' : ''}${esc(m.label)}</div>`);
      });
    }
    container.innerHTML = html.join('');
  }
  function renderLane(container, view) { renderFlags(container, view); drawTempoLane(view); }

  const laneTime = (e) => { const r = laneCanvas.getBoundingClientRect(), view = getView(); return {x: e.clientX - r.left, y: e.clientY - r.top, time: view.start + (e.clientX - r.left) / r.width * (view.end - view.start)}; };
  const hitPin = (x, y) => laneHits.find((h) => Math.abs(h.x - x) <= 7 && Math.abs(h.y - y) <= 9) || laneHits.find((h) => Math.abs(h.x - x) <= 4);
  laneCanvas.addEventListener('pointerdown', (e) => {
    if (!active || readOnly || e.button !== 0) return;
    const {x, y, time} = laneTime(e), hit = hitPin(x, y);
    if (hit) {
      drag = {q: hit.pin.position, moved: false, startX: x, from: hit.pin.time, refused: false};
      laneCanvas.setPointerCapture(e.pointerId);
      songMap.beginBatch();
      cursorQ = hit.pin.position;
      redraw(); render();
      return;
    }
    selectNear(clamp(time, 0, duration()), {bars: y < 22});
    if (!engine.playing) engine.seek(clamp(timeOf(cursorQ), 0, duration()));
  });
  laneCanvas.addEventListener('pointermove', (e) => {
    if (!active) return;
    const {x, y, time} = laneTime(e);
    if (drag) {
      if (Math.abs(x - drag.startX) > 2) drag.moved = true;
      if (drag.moved) {
        const pins = songMap.data.pins, prev = pins.findLast((p) => compare(p.position, drag.q) < 0), next = pins.find((p) => compare(p.position, drag.q) > 0);
        const target = clamp(time, Math.max(0, (prev?.time ?? -Infinity) + 0.002), Math.min(duration(), (next?.time ?? Infinity) - 0.002));
        // A refused position leaves the pin at its last valid time, with the reason showing.
        drag.refused = attempt(() => songMap.edit((d) => pin(d, drag.q, target), 'drag')) === FAILED;
        showTip(timeToX(pinAt(drag.q)?.time ?? target), `${describe(drag.q)} · ${clock(pinAt(drag.q)?.time ?? target)}`);
        render();
      }
      return;
    }
    const hit = hitPin(x, y);
    laneCanvas.style.cursor = hit ? 'ew-resize' : 'pointer';
    if ((hit?.pin.position ?? null) !== (hoverPin?.position ?? null)) { hoverPin = hit?.pin ?? null; redraw(); }
    if (hit) showTip(hit.x, `${describe(hit.pin.position)} · pinned ${clock(hit.pin.time)}`);
    else { const line = songMap.nearestLine(clamp(time, 0, duration()), {bars: y < 22}); showTip(timeToX(timeOf(line.q)), `${describe(line.q)} · ${bpmText(songMap.bpmAt(number(line.q)))} BPM`); }
  });
  laneCanvas.addEventListener('pointerup', () => {
    if (!drag) return;
    const {moved, q, from, refused} = drag; drag = null;
    songMap.endBatch();
    const time = pinAt(q)?.time;
    if (moved && Math.abs(time - from) > 1e-6 && !refused) say(`Moved ${describe(q)} to ${clock(time)}`, 'ok');
    else if (!engine.playing) engine.seek(clamp(timeOf(q), 0, duration()));
    redraw(); render();
  });
  laneCanvas.addEventListener('pointerleave', () => { laneTip.hidden = true; if (hoverPin) { hoverPin = null; redraw(); } });
  laneCanvas.addEventListener('dblclick', (e) => {
    if (!active || readOnly) return;
    const {time} = laneTime(e), line = songMap.nearestLine(clamp(time, 0, duration()));
    cursorQ = line.q;
    if (pinAt(line.q)) removePin(); else pinLine(line.q, timeOf(line.q));
  });
  function showTip(x, text) { laneTip.hidden = false; laneTip.textContent = text; laneTip.style.left = `${clamp(x, 40, laneCanvas.clientWidth - 40)}px`; }

  /** Selected bar and pinned lines, drawn into the waveform grid. */
  function gridDecor() {
    if (!active) return null;
    const index = songMap.barIndexAt(number(cursorQ)), start = songMap.barStart(index);
    return {pinned: new Set(songMap.compiled.pins.map((p) => Math.round(p.time * 1e4))), band: [timeOf(start), timeOf(number(start) + number(songMap.measure(index).length))]};
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
    const position = engine.getPosition(), headInside = engine.playing && position >= view.start && position <= view.end;
    laneHead.style.display = headInside ? 'block' : 'none';
    if (headInside) laneHead.style.left = timeToX(position) + 'px';
    const playing = engine.playing && !preview;
    if (playing !== tick.playing) { tick.playing = playing; render(); }
  }

  const unsubscribe = songMap.subscribe(() => { if (active) render(); });
  return {
    active: () => active, enter, exit, handleKey, selectNear, renderLane, gridDecor, tick,
    refresh: render, destroy() { exit(); unsubscribe(); document.removeEventListener('pointerdown', onOutside); lane.remove(); },
  };
}
