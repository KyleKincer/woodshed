// Web MIDI pedals (architecture §2.7, spec §7.5 "Optional P2"; Chromium and the desktop app only): a pad, a drum trigger
// or a MIDI foot switch runs a registry command, e.g. "crash pad = Again".
//
// prefs.midi = {enabled, bindings: [{device, type: 'note'|'cc', number, command}]} on this device. A note-on with
// velocity > 0, or a control change at or above 64, triggers the binding whose type and number match, from the named
// device (a binding with no device matches any). A held switch that keeps sending values ≥ 64 triggers once; it triggers
// again after it drops below 64 or after a pause (TRIGGER_GAP_MS), so a foot switch that only ever sends 127 still works.
// Only commands marked `pedal: true` run (the same list Custom pedals offer), with source 'midi'.
//
// MIDI access is asked for (sysex: false) only once MIDI pedals are on, or while learnMidi() listens. `midiState` tells
// Settings what happened: {supported, access: 'idle'|'pending'|'granted'|'denied'|'unsupported', inputs: [{id, name}]}.

import {registry as appRegistry} from './commands.js';
import {prefs as appPrefs} from './prefs.js';
import {effect, readonly, signal, untracked} from './store.js';
import {now} from './clock.js';

export const MIDI_SOURCE = 'midi';
export const MIDI_TYPES = Object.freeze(['note', 'cc']);
export const CC_THRESHOLD = 64;
export const TRIGGER_GAP_MS = 250;

const state = signal({supported: true, access: 'idle', inputs: []});
/** {supported, access, inputs: [{id, name}]} for Settings. */
export const midiState = readonly(state);

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const byteOk = n => Number.isInteger(n) && n >= 0 && n <= 127;

/**
 * A MIDI message as a possible trigger: {type: 'note', number, value, channel} for a note-on with velocity > 0,
 * {type: 'cc', number, value, channel} for any control change, otherwise null (note-offs, clock, sysex, running status).
 */
export function parseMidi(data) {
  if (!data || data.length < 3) return null;
  const status = data[0], number = data[1], value = data[2];
  if (!byteOk(number) || !byteOk(value)) return null;
  const kind = status & 0xF0, channel = status & 0x0F;
  if (kind === 0x90 && value > 0) return {type: 'note', number, value, channel};
  if (kind === 0xB0) return {type: 'cc', number, value, channel};
  return null;
}

/** prefs.midi as the runtime reads it; malformed bindings are dropped, and `on` is enabled with at least one binding. */
export function midiConfig(raw) {
  const src = isObject(raw) ? raw : {};
  const bindings = [];
  const seen = new Set();
  for (const b of Array.isArray(src.bindings) ? src.bindings : []) {
    if (!isObject(b) || !MIDI_TYPES.includes(b.type) || !byteOk(b.number) || typeof b.command !== 'string' || !b.command) continue;
    const device = typeof b.device === 'string' && b.device ? b.device : null;
    const key = `${device}|${b.type}|${b.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push({device, type: b.type, number: b.number, command: b.command});
  }
  const enabled = src.enabled === true;
  return {enabled, bindings, on: enabled && bindings.length > 0};
}

/** The binding a trigger from `deviceName` matches: one for that device first, else one for any device. */
export function bindingFor(bindings, {device, type, number}) {
  const same = b => b.type === type && b.number === number;
  return bindings.find(b => same(b) && b.device === device) ?? bindings.find(b => same(b) && b.device == null) ?? null;
}

/** A readable name for a trigger: 'Note 36' or 'CC 64'. */
export function triggerLabel({type, number}) {
  return type === 'cc' ? `CC ${number}` : `Note ${number}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Access and inputs (shared by the runtime and learnMidi)

let accessPromise = null;
let access = null;
const consumers = new Set();          // (input, event) => void
const attached = new Map();           // input → listener
let watchingState = false;

function setState(patch) {
  state.value = {...state.peek(), ...patch};
}

function inputsOf(acc) {
  const out = [];
  try {
    for (const input of acc?.inputs?.values?.() ?? []) if (input && input.state !== 'disconnected') out.push(input);
  } catch { /* an access object without inputs */ }
  return out;
}

function syncInputs() {
  const live = new Set(consumers.size ? inputsOf(access) : []);
  for (const [input, listener] of attached) {
    if (live.has(input)) continue;
    input.removeEventListener?.('midimessage', listener);
    attached.delete(input);
  }
  for (const input of live) {
    if (attached.has(input)) continue;
    const listener = event => { for (const fn of [...consumers]) fn(input, event); };
    input.addEventListener?.('midimessage', listener);
    // Only onmidimessage opens a port implicitly; a listener needs open().
    Promise.resolve().then(() => input.open?.()).catch(() => {});
    attached.set(input, listener);
  }
  setState({inputs: inputsOf(access).map(i => ({id: String(i.id ?? i.name ?? ''), name: String(i.name || i.id || 'MIDI input')}))});
}

/** Requests MIDI access once (sysex: false); resolves the MIDIAccess or null when it is unsupported or refused. */
function requestAccess(nav) {
  if (access) return Promise.resolve(access);
  if (accessPromise) return accessPromise;
  if (typeof nav?.requestMIDIAccess !== 'function') {
    setState({supported: false, access: 'unsupported', inputs: []});
    return Promise.resolve(null);
  }
  setState({supported: true, access: 'pending'});
  accessPromise = Promise.resolve()
    .then(() => nav.requestMIDIAccess({sysex: false}))
    .then(acc => {
      access = acc;
      accessPromise = null;
      setState({access: 'granted'});
      if (!watchingState) {
        watchingState = true;
        acc.addEventListener?.('statechange', () => syncInputs());
      }
      syncInputs();
      return acc;
    }, err => {
      accessPromise = null;
      console.warn('[midi] MIDI access was not granted:', err?.message ?? err);
      setState({access: 'denied', inputs: []});
      return null;
    });
  return accessPromise;
}

function addConsumer(fn, nav) {
  consumers.add(fn);
  const ready = requestAccess(nav).then(acc => { if (acc) syncInputs(); return acc; });
  return {
    ready,
    off() {
      consumers.delete(fn);
      syncInputs();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The runtime

let learning = 0;
let stopRuntime = null;

/**
 * Starts MIDI pedals (boot step 7) and returns `stop`. It follows prefs.midi: while MIDI pedals are on it listens to every
 * connected input (inputs that connect later are picked up) and runs the bound pedal commands. Options exist for tests
 * and harnesses: `registry`, `prefs` (an object with a `.value` signal of the prefs), `navigator`, `onFire`.
 */
export function startMidi({registry = appRegistry, prefs = appPrefs, navigator: nav = globalThis.navigator, onFire = null} = {}) {
  stopRuntime?.();
  if (typeof nav?.requestMIDIAccess !== 'function') setState({supported: false, access: 'unsupported', inputs: []});
  let config = midiConfig(null);
  let consumer = null;
  const last = new Map();             // `${input}|${channel}|${number}` → {value, at} for control changes

  function onMessage(input, event) {
    if (learning > 0 || !config.on) return;
    const msg = parseMidi(event?.data);
    if (!msg) return;
    if (msg.type === 'cc') {
      const k = `${input.id ?? input.name}|${msg.channel}|${msg.number}`;
      const prev = last.get(k);
      const at = now();
      last.set(k, {value: msg.value, at});
      if (msg.value < CC_THRESHOLD) return;
      if (prev && prev.value >= CC_THRESHOLD && at - prev.at < TRIGGER_GAP_MS) return;
    }
    const binding = bindingFor(config.bindings, {device: String(input.name ?? ''), type: msg.type, number: msg.number});
    if (!binding || !registry.get(binding.command)?.pedal) return;
    const ran = registry.run(binding.command, {source: MIDI_SOURCE});
    onFire?.(binding.command, {binding, ran});
  }

  const off = effect(() => {
    const next = midiConfig(prefs.value.value?.midi);
    untracked(() => {
      config = next;
      if (next.on && !consumer) consumer = addConsumer(onMessage, nav);
      else if (!next.on && consumer) { consumer.off(); consumer = null; last.clear(); }
    });
  });

  const stop = () => {
    off();
    consumer?.off();
    consumer = null;
    if (stopRuntime === stop) stopRuntime = null;
  };
  stopRuntime = stop;
  return stop;
}

const abortError = () => {
  try { return new DOMException('Listening for a MIDI pedal was cancelled.', 'AbortError'); } catch {
    const err = new Error('Listening for a MIDI pedal was cancelled.');
    err.name = 'AbortError';
    return err;
  }
};

/**
 * Listens for the next trigger on any input and resolves {device, type, number} (device is the input's name). While it
 * listens, MIDI bindings do not run. `signal` cancels: the promise rejects with an AbortError. Without MIDI access (no
 * support, or refused) it rejects with an Error whose `code` is 'unsupported' or 'denied'.
 */
export function learnMidi({signal = null, navigator: nav = globalThis.navigator} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    let finished = false;
    learning++;
    const consumer = addConsumer((input, event) => {
      if (finished) return;
      const msg = parseMidi(event?.data);
      if (!msg || (msg.type === 'cc' && msg.value < CC_THRESHOLD)) return;
      end();
      resolve({device: String(input.name || input.id || ''), type: msg.type, number: msg.number});
    }, nav);
    function end() {
      if (finished) return;
      finished = true;
      learning--;
      consumer.off();
      signal?.removeEventListener?.('abort', onAbort);
    }
    function onAbort() {
      if (finished) return;
      end();
      reject(abortError());
    }
    signal?.addEventListener?.('abort', onAbort, {once: true});
    consumer.ready.then(acc => {
      if (acc || finished) return;
      const code = untracked(() => state.peek().access) === 'unsupported' ? 'unsupported' : 'denied';
      end();
      reject(Object.assign(new Error(code === 'unsupported' ? 'This browser has no Web MIDI.' : 'MIDI access was not allowed.'), {code}));
    });
  });
}

/** Tests: forget MIDI access and every listener. */
export function resetMidiForTests() {
  stopRuntime?.();
  for (const [input, listener] of attached) input.removeEventListener?.('midimessage', listener);
  attached.clear();
  consumers.clear();
  access = null;
  accessPromise = null;
  watchingState = false;
  learning = 0;
  state.value = {supported: true, access: 'idle', inputs: []};
}
