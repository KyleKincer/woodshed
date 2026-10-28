// Tap the beat (architecture §4.6, D22, D23; spec §5.1.3): a quick sheet, reachable from the Stage
// without entering Edit, that builds a constant-tempo map from taps.
//
// - "Play the song and tap every beat for 2 bars." A 160×160 pad takes taps from a pointer press or,
//   while it has focus, from T or Space (it declares them in data-consume-keys, so Space taps
//   instead of reaching Play/Stop). A Play button in the sheet starts the song.
// - Each tap is the song position (media seconds) at the press, so the tempo is the recording's at
//   any speed. Taps count only while the song plays; a tap behind the last one (a loop wrap, a seek)
//   or more than MAX_GAP_S after it starts a new run.
// - Live: "≈ 92 bpm · 6 taps" (least squares over the taps). When the taps stop for FINISH_IDLE_MS,
//   or playback stops, four or more taps become the result through `fromTaps`:
//   "92 bpm · 4/4 · first downbeat 0:00.41" with [Use it] [Try again] [Open map editor].
// - [Use it] runs session.mapChange('Tap the beat', m => m.replace(data, 'tapBeat')): one
//   practice-undo step in the Stage (D23; the map stack inside Edit · Map), saved through the tempo
//   debounce; on a song that was unmapped it also triggers the markers offer (§2.14.1).
//
//   export function render(container, {session, close, registry?}) → {destroy}
//   export function tapTempo(taps) → bpm (rounded) | null

import '../../styles/views/stage/sheets-tap-beat.css';
import {registry as appRegistry} from '../../app/commands.js';
import {effect} from '../../app/store.js';
import {Button} from '../../ui/button.js';
import {h} from '../../ui/h.js';
import {InlineStatus} from '../../ui/status.js';
import {fromTaps} from '../../../shared/song-map.ts';
import {COPY as ALL} from './sheets-b.copy.js';

const COPY = ALL.tap;
/** The taps become a result once they pause this long. */
export const FINISH_IDLE_MS = 2000;
/** A gap longer than this (under 20 bpm) starts a new run of taps. */
export const MAX_GAP_S = 3;
/** Two taps closer than this are one (a bounce, or a pointer press and a key together). */
export const MIN_TAP_GAP_S = 0.05;
/** fromTaps needs at least this many taps. */
export const MIN_TAPS = 4;
const NUMERATOR = 4;

const peek = (v) => (v && typeof v === 'object' && typeof v.peek === 'function' ? v.peek() : v);

/** The tapped tempo: 60 / P for the least-squares period P over the tap index; null under 2 taps. */
export function tapTempo(taps) {
  const list = (Array.isArray(taps) ? taps : []).filter(Number.isFinite);
  const n = list.length;
  if (n < 2) return null;
  let sk = 0, st = 0, skk = 0, skt = 0;
  list.forEach((t, k) => { sk += k; st += t; skk += k * k; skt += k * t; });
  const period = (n * skt - sk * st) / (n * skk - sk * sk);
  return period > 0 ? Math.round(60 / period) : null;
}

export function render(container, {session, close = () => {}, registry = appRegistry} = {}) {
  if (!session?.transport) throw new TypeError('tapBeat: a session is required');
  const transport = session.transport;
  const offs = [];
  let taps = [];
  let result = null;     // {data, bpm, downbeat, meter}
  let hint = null;       // a short line under the pad (not playing, too few taps)
  let error = null;      // a [Use it] or fromTaps failure
  let timer = null;
  let destroyed = false;

  /* ---------- taps ---------- */

  const isPlaying = () => peek(transport.snapshot)?.phase === 'playing';
  const duration = () => session.map?.duration || peek(session.song)?.duration || 0;

  function clearTimer() {
    if (timer != null) clearTimeout(timer);
    timer = null;
  }

  function reset() {
    clearTimer();
    taps = [];
    result = null;
    hint = null;
    error = null;
    paint();
  }

  function tap() {
    if (destroyed) return;
    if (result) { result = null; error = null; taps = []; }
    if (!isPlaying()) { hint = COPY.notPlaying; paint(); return; }
    const t = transport.position();
    if (!Number.isFinite(t)) return;
    const last = taps.at(-1);
    if (last !== undefined && t >= last && t - last < MIN_TAP_GAP_S) return;
    if (last !== undefined && (t < last || t - last > MAX_GAP_S)) taps = [];
    taps.push(t);
    hint = null;
    error = null;
    clearTimer();
    timer = setTimeout(finish, FINISH_IDLE_MS);
    paint();
    pad.dataset.tapped = String(taps.length);
  }

  function finish() {
    clearTimer();
    if (destroyed || result || !taps.length) return;
    if (taps.length < MIN_TAPS) { hint = COPY.tooFew; paint(); return; }
    try {
      const data = fromTaps(taps, duration(), {numerator: NUMERATOR});
      const measure = data.measures[0];
      result = {data, bpm: Math.round(data.tailQpm), downbeat: data.pins[0]?.time ?? taps[0], meter: `${measure.numerator}/${measure.denominator}`};
      hint = null;
      error = null;
    } catch (err) {
      result = null;
      hint = null;
      error = err?.message || String(err);
      taps = [];
    }
    paint();
  }

  function useIt() {
    if (!result) return false;
    const {data, bpm} = result;
    let changed;
    try {
      changed = session.mapChange(COPY.label, (m) => m.replace(data, 'tapBeat'), {status: {text: COPY.applied(bpm), undoLabel: COPY.undo}});
    } catch (err) {
      error = err?.message || String(err);
      paint();
      return false;
    }
    if (!changed) {
      error = session.map?.isReal && JSON.stringify(session.map.data) === JSON.stringify(data) ? COPY.unchanged : COPY.refused;
      paint();
      return false;
    }
    close();
    return true;
  }

  /* ---------- the sheet ---------- */

  const liveId = `tap-live-${Math.random().toString(36).slice(2, 8)}`;
  const pad = h('div', {class: 'tap-pad', tabIndex: 0,
    attrs: {role: 'button', 'aria-label': COPY.padLabel, 'aria-describedby': liveId, 'data-consume-keys': 'Space KeyT'}},
  h('span', {class: 'tap-pad-word', attrs: {'aria-hidden': 'true'}}, COPY.pad),
  h('span', {class: 'tap-pad-hint', attrs: {'aria-hidden': 'true'}}, COPY.padHint));
  const live = h('p', {class: 'tap-live', id: liveId});
  const play = Button({command: 'transport.playStop', registry, icon: 'play', size: 'md', variant: 'secondary', className: 'tap-play'});
  const resultLine = h('p', {class: 'tap-result-line'});
  const replaces = h('p', {class: 'tap-replaces'}, COPY.replaces);
  const status = InlineStatus({tone: 'error', text: ''});
  const useButton = Button({label: COPY.useIt, variant: 'primary', icon: 'check', onClick: useIt, className: 'tap-use'});
  const againButton = Button({label: COPY.tryAgain, variant: 'secondary', icon: 'rotate-ccw', onClick: () => { reset(); pad.focus(); }});
  const editorButton = Button({label: COPY.openEditor, command: 'edit.map', registry, variant: 'quiet', icon: 'grid-3x3', onClick: () => close()});
  const resultBox = h('div', {class: 'tap-result', attrs: {'aria-live': 'polite'}},
    resultLine, replaces,
    h('div', {class: 'tap-actions'}, useButton.el, againButton.el, editorButton.el));
  const root = h('div', {class: 'tap', dataset: {sheetBody: 'tapBeat'}},
    h('p', {class: 'tap-intro'}, COPY.intro),
    h('div', {class: 'tap-pad-row'}, pad, h('div', {class: 'tap-side'}, live, play.el)),
    status.el,
    resultBox);
  container.append(root);

  pad.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();      // keep the focus where it is (on the pad once it has it), no text selection
    if (pad.ownerDocument.activeElement !== pad) pad.focus({preventScroll: true});
    tap();
  });
  const tapKey = (e) => (e.code === 'Space' || e.key === ' ' || e.code === 'KeyT') && !e.metaKey && !e.ctrlKey && !e.altKey;
  pad.addEventListener('keydown', (e) => {
    if (!tapKey(e)) return;
    e.preventDefault();
    if (!e.repeat) tap();
  });
  // A Space keyup on a focused role=button would activate it in some browsers.
  pad.addEventListener('keyup', (e) => { if (tapKey(e)) e.preventDefault(); });

  function paint() {
    if (destroyed) return;
    const n = taps.length;
    if (result) live.textContent = COPY.live(result.bpm, n);
    else if (hint) live.textContent = hint;
    else if (n) live.textContent = COPY.live(tapTempo(taps), n);
    else live.textContent = isPlaying() ? COPY.waiting : COPY.notPlaying;
    root.toggleAttribute('data-result', !!result);
    resultBox.hidden = !result;
    if (result) resultLine.textContent = COPY.result(result.bpm, result.meter, result.downbeat);
    replaces.hidden = !(result && session.map?.isReal);
    status.set({text: error ?? ''});
    status.el.hidden = !error;
  }

  // Playback stopping ends the taps (four or more become the result); the Play button's icon follows.
  let lastPhase = peek(transport.snapshot)?.phase;
  offs.push(effect(() => {
    const phase = transport.snapshot.value?.phase;
    play.set({icon: phase === 'playing' || phase === 'counting' ? 'square' : 'play'});
    if (phase !== lastPhase) {
      const wasPlaying = lastPhase === 'playing';
      lastPhase = phase;
      if (wasPlaying && phase !== 'playing' && taps.length && !result) finish();
      else paint();
    }
  }));
  paint();
  queueMicrotask(() => { if (!destroyed && pad.isConnected) pad.focus({preventScroll: true}); });

  return {
    el: root,
    /** For tests and the harness. */
    get taps() { return taps.slice(); },
    get result() { return result; },
    tap, finish, useIt, reset,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimer();
      for (const off of offs.splice(0).reverse()) off?.();
      play.destroy(); useButton.destroy(); againButton.destroy(); editorButton.destroy(); status.destroy();
      root.remove();
    },
  };
}

export default render;
