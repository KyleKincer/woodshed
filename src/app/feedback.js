// Feedback (architecture §2.9, spec §7.9): the app's one feedback system.
//
//   toast(message, {tone = 'info', action, durationMs, key}) → {dismiss(), update(message)}
//     One toast is visible at a time, in a FIFO queue, in the bottom-centre region (.ui-toast-region). 'info', 'ok' and
//     'warn' dismiss themselves after 5000 ms; 'error' persists. `durationMs` overrides that per toast (a finite number
//     of ms; Infinity persists). `action` {label, run} adds a button; running it dismisses the toast. A toast with the
//     `key` of a visible or queued toast replaces it in place (its timer restarts) and the returned handle is that
//     toast's. Toasts never take focus. While a pointer is over a toast or the focus is inside it, its timer pauses.
//     While store.stage.playing is true nothing shows: new toasts queue, and a toast already showing goes back to the
//     front of the queue (spec §0 rule 5, "nothing interrupts playback"). They are released, in order, on stop.
//   status(text, {action, durationMs = 2500, key, tone = 'info'}) → void
//     The Stage status line (role=status). The Stage's HUD attaches a renderer with attachStatusLine() and draws
//     statusLine.value; status() replaces the line (one line, the latest wins) and clears it after durationMs
//     (Infinity keeps it until replaced or dismissed). With no status line attached (outside the Stage) it falls back to
//     toast(text, {action, key, tone}) with the toast's own default duration unless durationMs was given.
//   confirm({title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false}) → Promise<boolean>
//   form({title, body, fields, submitLabel = 'Save', cancelLabel = 'Cancel', danger = false, onSubmit}) → Promise<values|null>
//     Both are the Dialog primitive. FieldSpec {name, label, kind: 'text'|'textarea', required, minLength, maxLength,
//     value, hint, placeholder}. With `onSubmit(values)` (async) the dialog stays open while it runs and shows a thrown
//     error inline (at the field named by `err.field`, else under the fields); it resolves with the values once onSubmit
//     resolves, or null on Cancel/Esc.
//   announce(text, {politeness = 'polite', throttleMs = 2000, key}) → void
//     Screen-reader only (two visually hidden live regions, kept inside the topmost modal dialog so they are not
//     inert). Announcements with the same `key` (default: the text itself) are throttled: the first speaks at once; one
//     made within throttleMs of the last spoken one waits, replaces any other waiting text, and speaks when the window
//     ends unless it equals the text last spoken for that key.
//
// Also: `feedback` (all of the above, for ctx.feedback), `statusLine` (ReadonlySignal<StatusEntry|null>),
// `attachStatusLine() → off`, `dismissStatus(key?)`, `toastState()` (for tests and the dev handle) and `resetFeedback()`.
// StatusEntry = {id, text, action, key, tone, durationMs}. Every wall-clock read goes through clock.now().

import {now} from './clock.js';
import {effect, readonly, signal, store, untracked} from './store.js';
import {Dialog} from '../ui/dialog.js';
import {h} from '../ui/h.js';
import {followLayerHost, layerHost} from '../ui/popover.js';
import {TONES, Toast} from '../ui/toast.js';
import '../styles/views/app/toast.css';

export const TOAST_MS = 5000;
export const STATUS_MS = 2500;
export const ANNOUNCE_THROTTLE_MS = 2000;
const POLITENESS = new Set(['polite', 'assertive']);

const hasDocument = () => typeof document !== 'undefined' && !!document.body;

/** The auto-dismiss delay of a toast: a positive finite number, or null (it persists). */
export function toastDuration(tone, durationMs) {
  if (durationMs !== undefined && durationMs !== null) {
    const ms = Number(durationMs);
    if (ms === Infinity) return null;
    if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`toast: durationMs must be a positive number or Infinity, not ${String(durationMs)}`);
    return ms;
  }
  return tone === 'error' ? null : TOAST_MS;
}

// ---------------------------------------------------------------------------------------------------------------
// Toasts

let seq = 0;
const queue = [];            // entries waiting, oldest first
let current = null;          // the visible entry
let view = null;             // its Toast view
let region = null;           // .ui-toast-region, created on first use and kept (a stable container for the toasts)
let offRegion = null;
let stopHold = null;         // the effect watching store.stage.playing
let held = false;
let timer = null;            // the visible toast's auto-dismiss timer
let startedAt = 0;           // when the timer last (re)started
let remaining = null;        // ms left on the visible toast (null: persists)
const pauses = new Set();    // 'hover' | 'focus' while the visible toast's timer is paused

function playing() {
  return store.stage.value?.playing === true;
}

function watchHold() {
  if (stopHold) return;
  stopHold = effect(() => {
    const next = playing();
    untracked(() => setHeld(next));
  });
}

function setHeld(next) {
  if (next === held) return;
  held = next;
  if (held) {
    // Nothing shows while the transport runs: the visible toast goes back to the front of the queue.
    if (current) {
      const entry = current;
      hideCurrent();
      queue.unshift(entry);
    }
  } else {
    pump();
  }
}

function ensureRegion() {
  if (region?.isConnected) return region;
  offRegion?.();            // a region someone removed from the document is replaced
  region = h('div', {class: 'ui-toast-region app-toasts', role: 'region', 'aria-label': 'Notifications'});
  offRegion = followLayerHost(region, 'toast');
  return region;
}

function clearTimer() {
  if (timer != null) clearTimeout(timer);
  timer = null;
}

function startTimer() {
  clearTimer();
  if (remaining == null || pauses.size) return;
  startedAt = now();
  const entry = current;
  timer = setTimeout(() => { timer = null; if (current === entry) dismissEntry(entry); }, remaining);
}

function pauseTimer(reason) {
  if (!current) return;
  if (!pauses.size && timer != null && remaining != null) remaining = Math.max(0, remaining - (now() - startedAt));
  pauses.add(reason);
  clearTimer();
}

function resumeTimer(reason) {
  if (!pauses.delete(reason) || pauses.size || !current) return;
  startTimer();
}

function actionFor(entry) {
  const action = entry.action;
  if (!action) return undefined;
  return {
    label: action.label,
    run: () => {
      try { action.run?.(); } catch (err) { console.error(err); }
    },
  };
}

function show(entry) {
  ensureRegion();
  current = entry;
  pauses.clear();
  view = Toast({
    message: entry.message, tone: entry.tone, action: actionFor(entry),
    dataset: {toastId: String(entry.id), ...(entry.key ? {toastKey: entry.key} : {})},
    onDismiss: () => dismissEntry(entry),
  });
  const el = view.el;
  el.addEventListener('pointerenter', () => pauseTimer('hover'));
  el.addEventListener('pointerleave', () => resumeTimer('hover'));
  el.addEventListener('focusin', () => pauseTimer('focus'));
  el.addEventListener('focusout', e => { if (!el.contains(e.relatedTarget)) resumeTimer('focus'); });
  region.append(el);
  remaining = entry.durationMs;
  startTimer();
}

function hideCurrent() {
  clearTimer();
  pauses.clear();
  view?.destroy();
  view = null;
  current = null;
  remaining = null;
}

function pump() {
  if (current || held || !queue.length || !hasDocument()) return;
  show(queue.shift());
}

function dismissEntry(entry) {
  if (entry.done) return;
  if (current === entry) {
    entry.done = true;
    hideCurrent();
    pump();
    return;
  }
  const at = queue.indexOf(entry);
  if (at >= 0) {
    entry.done = true;
    queue.splice(at, 1);
  }
}

function handleFor(entry) {
  return entry.handle ??= Object.freeze({
    dismiss: () => dismissEntry(entry),
    update: message => {
      if (entry.done) return;
      entry.message = message;
      if (current === entry) view?.set({message});
    },
  });
}

/** Shows (or queues) a toast. See the header. */
export function toast(message, {tone = 'info', action, durationMs, key} = {}) {
  if (!TONES.includes(tone)) throw new RangeError(`toast: unknown tone ${JSON.stringify(tone)}`);
  if (action != null && (typeof action !== 'object' || !action.label)) throw new TypeError('toast: action needs a label');
  const fields = {message, tone, action: action ?? null, durationMs: toastDuration(tone, durationMs)};
  watchHold();
  if (key != null) {
    const same = current?.key === key ? current : queue.find(e => e.key === key);
    if (same) {
      Object.assign(same, fields);
      if (same === current) {
        view.set({message: same.message, tone: same.tone, action: actionFor(same)});
        remaining = same.durationMs;
        if (pauses.size) clearTimer(); else startTimer();
      }
      return handleFor(same);
    }
  }
  const entry = {id: ++seq, key: key ?? null, ...fields, done: false, handle: null};
  queue.push(entry);
  pump();
  return handleFor(entry);
}

/** What the toast region holds: {visible: {id, message, tone, key, action}|null, queued: [...], held}. */
export function toastState() {
  const describe = e => ({id: e.id, message: e.message, tone: e.tone, key: e.key, action: e.action?.label ?? null, durationMs: e.durationMs});
  return {visible: current ? describe(current) : null, queued: queue.map(describe), held};
}

// ---------------------------------------------------------------------------------------------------------------
// The Stage status line

const statusSignal = signal(null);
/** ReadonlySignal<StatusEntry|null>: what the Stage status line shows now. */
export const statusLine = readonly(statusSignal);
let statusHosts = 0;
let statusTimer = null;
let statusSeq = 0;

/** The Stage's status line is mounted: status() goes to statusLine until the returned `off` runs. */
export function attachStatusLine() {
  statusHosts++;
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    statusHosts--;
    if (!statusHosts) dismissStatus();
  };
}

/** Clears the status line (only when its key matches, when `key` is given). */
export function dismissStatus(key) {
  const entry = statusSignal.peek();
  if (!entry || (key !== undefined && entry.key !== key)) return;
  if (statusTimer != null) clearTimeout(statusTimer);
  statusTimer = null;
  statusSignal.value = null;
}

/** Shows a line in the Stage status line, or a toast outside the Stage. See the header. */
export function status(text, {action, durationMs, key, tone = 'info'} = {}) {
  if (!statusHosts) {
    toast(text, {action, key, tone, durationMs});
    return;
  }
  if (!TONES.includes(tone)) throw new RangeError(`status: unknown tone ${JSON.stringify(tone)}`);
  const ms = durationMs === undefined ? STATUS_MS : Number(durationMs);
  if (!(ms > 0)) throw new RangeError(`status: durationMs must be a positive number or Infinity, not ${String(durationMs)}`);
  if (statusTimer != null) clearTimeout(statusTimer);
  statusTimer = null;
  const entry = Object.freeze({id: ++statusSeq, text, action: action ?? null, key: key ?? null, tone, durationMs: ms});
  statusSignal.value = entry;
  if (Number.isFinite(ms)) {
    statusTimer = setTimeout(() => {
      statusTimer = null;
      if (statusSignal.peek() === entry) statusSignal.value = null;
    }, ms);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Dialogs

/** A confirm dialog; resolves true only for the confirm action. */
export function confirm({title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false} = {}) {
  if (!title) throw new TypeError('confirm: a title is required');
  const dialog = Dialog({
    title, body, danger,
    actions: [
      {label: cancelLabel, value: false, variant: 'secondary'},
      {label: confirmLabel, value: true, variant: danger ? 'danger' : 'primary'},
    ],
  });
  return dialog.closed.then(value => value === true);
}

/** A form dialog; resolves with {name: value} on submit, or null. */
export function form({title, body, fields, submitLabel = 'Save', cancelLabel = 'Cancel', danger = false, onSubmit} = {}) {
  if (!title) throw new TypeError('form: a title is required');
  if (!Array.isArray(fields) || !fields.length) throw new TypeError('form: needs at least one field');
  if (onSubmit !== undefined && typeof onSubmit !== 'function') throw new TypeError('form: onSubmit must be a function');
  const dialog = Dialog({
    title, body, danger,
    form: {fields, ...(onSubmit ? {onSubmit} : {})},
    actions: [
      {label: cancelLabel, value: null, variant: 'secondary'},
      {label: submitLabel, value: 'submit', variant: danger ? 'danger' : 'primary', submit: true},
    ],
  });
  return dialog.closed.then(value => (value && typeof value === 'object' ? value : null));
}

// ---------------------------------------------------------------------------------------------------------------
// Announcements

const liveRegions = {polite: null, assertive: null};
const spoken = new Map();     // key → {at, text}
const waiting = new Map();    // key → {text, politeness, timer}

function liveRegion(politeness) {
  let el = liveRegions[politeness];
  if (!el) {
    el = h('div', {
      class: 'sr-only app-live', 'aria-live': politeness, 'aria-atomic': 'true',
      role: politeness === 'assertive' ? 'alert' : 'status', dataset: {live: politeness},
    });
    liveRegions[politeness] = el;
  }
  // Outside an open modal dialog everything is inert, so the region follows the topmost modal host.
  const host = layerHost(document);
  if (el.parentNode !== host) host.append(el);
  return el;
}

function speak(key, text, politeness) {
  spoken.set(key, {at: now(), text});
  if (!hasDocument()) return;
  // A new node (rather than new text in the old one) makes repeated announcements speak again.
  liveRegion(politeness).replaceChildren(h('span', {}, text));
}

/** Speaks to screen readers. See the header. */
export function announce(text, {politeness = 'polite', throttleMs = ANNOUNCE_THROTTLE_MS, key} = {}) {
  const message = String(text ?? '').trim();
  if (!message) return;
  if (!POLITENESS.has(politeness)) throw new RangeError(`announce: politeness must be polite or assertive, not ${JSON.stringify(politeness)}`);
  const k = key ?? message;
  const last = spoken.get(k);
  const elapsed = last ? now() - last.at : Infinity;
  if (!(throttleMs > 0) || elapsed >= throttleMs) {
    const pending = waiting.get(k);
    if (pending) { clearTimeout(pending.timer); waiting.delete(k); }
    speak(k, message, politeness);
    return;
  }
  const pending = waiting.get(k);
  if (pending) {
    pending.text = message;
    pending.politeness = politeness;
    return;
  }
  const entry = {text: message, politeness, timer: null};
  entry.timer = setTimeout(() => {
    waiting.delete(k);
    if (spoken.get(k)?.text === entry.text) return;
    speak(k, entry.text, entry.politeness);
  }, throttleMs - elapsed);
  waiting.set(k, entry);
}

// ---------------------------------------------------------------------------------------------------------------

/** The feedback API as one object (ctx.feedback). */
export const feedback = Object.freeze({toast, status, confirm, form, announce, attachStatusLine, dismissStatus, statusLine});

/** Drops every toast, the status line and pending announcements, and removes the regions (tests, the fixture). */
export function resetFeedback() {
  clearTimer();
  for (const entry of queue.splice(0)) entry.done = true;
  if (current) { current.done = true; hideCurrent(); }
  stopHold?.();
  stopHold = null;
  held = false;
  offRegion?.();
  offRegion = null;
  region = null;
  statusHosts = 0;
  dismissStatus();
  for (const pending of waiting.values()) clearTimeout(pending.timer);
  waiting.clear();
  spoken.clear();
  for (const name of Object.keys(liveRegions)) { liveRegions[name]?.remove(); liveRegions[name] = null; }
}
