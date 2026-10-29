// navigator.requestMIDIAccess fake with one virtual input (architecture §11.2,
// D31). Controls (window.fixture.midi):
//   note(n, vel = 100, {channel = 0})  a note-on (vel 0 is a note-off, as on real pads)
//   noteOff(n, {channel = 0})          a note-off (0x80)
//   cc(n, value, {channel = 0})        a control change
//   deny() / allow()                   later requests reject with SecurityError / succeed
//   disconnect() / connect()           the input goes away / comes back (statechange)
//   state()                            {requests, sysexRequested, connected, sent: [[status, data1, data2], …], listening}
import {fireWithHandler} from './events.js';

export const INPUT = {id: 'fx-midi-1', name: 'Fixture Pad', manufacturer: 'Woodshed', version: '1.0'};

export function installMidi(win) {
  const state = {requests: 0, sysexRequested: false, denied: false, sent: []};
  let access = null;

  class Port extends win.EventTarget {
    constructor() {
      super();
      Object.assign(this, INPUT, {type: 'input', state: 'connected', connection: 'closed', onmidimessage: null, onstatechange: null});
    }
    async open() { this.connection = 'open'; return this; }
    async close() { this.connection = 'closed'; return this; }
  }
  const input = new Port();
  const inputs = new Map([[input.id, input]]);

  function fire(target, event, handler) { fireWithHandler(target, event, handler); }
  function messageEvent(bytes) {
    const data = new Uint8Array(bytes);
    if (typeof win.MIDIMessageEvent === 'function') {
      try { return new win.MIDIMessageEvent('midimessage', {data}); } catch { /* fall through */ }
    }
    const event = new win.Event('midimessage');
    Object.defineProperty(event, 'data', {value: data});
    return event;
  }
  function send(bytes) {
    if (input.state !== 'connected') return false;
    // Assigning onmidimessage (or adding a listener) opens a real port implicitly.
    input.connection = 'open';
    state.sent.push(bytes);
    fire(input, messageEvent(bytes), 'onmidimessage');
    return true;
  }
  function stateChange() {
    const event = new win.Event('statechange');
    Object.defineProperty(event, 'port', {value: input});
    fire(input, event, 'onstatechange');
    if (access) fire(access, event, 'onstatechange');
  }

  win.navigator.requestMIDIAccess = async function requestMIDIAccess(options = {}) {
    state.requests++;
    if (options?.sysex) state.sysexRequested = true;
    if (state.denied) throw new win.DOMException('MIDI access was denied (fixture).', 'SecurityError');
    if (!access) {
      access = new win.EventTarget();
      Object.assign(access, {sysexEnabled: false, onstatechange: null, outputs: new Map()});
      Object.defineProperty(access, 'inputs', {get: () => (input.state === 'connected' ? inputs : new Map())});
    }
    return access;
  };

  const byte = (n, name) => {
    if (!Number.isInteger(n) || n < 0 || n > 127) throw new RangeError(`fixture.midi: ${name} must be an integer 0–127, got ${n}`);
    return n;
  };
  const channelOf = ({channel = 0} = {}) => {
    if (!Number.isInteger(channel) || channel < 0 || channel > 15) throw new RangeError(`fixture.midi: channel must be 0–15, got ${channel}`);
    return channel;
  };
  return {
    note: (n, vel = 100, opts) => send([0x90 | channelOf(opts), byte(n, 'note'), byte(vel, 'velocity')]),
    noteOff: (n, opts) => send([0x80 | channelOf(opts), byte(n, 'note'), 0]),
    cc: (n, value, opts) => send([0xB0 | channelOf(opts), byte(n, 'controller'), byte(value, 'value')]),
    deny() { state.denied = true; },
    allow() { state.denied = false; },
    disconnect() { input.state = 'disconnected'; input.connection = 'closed'; stateChange(); },
    connect() { input.state = 'connected'; stateChange(); },
    state: () => ({requests: state.requests, sysexRequested: state.sysexRequested, connected: input.state === 'connected', sent: state.sent.map(b => [...b]), listening: typeof input.onmidimessage === 'function'}),
  };
}
