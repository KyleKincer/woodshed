// navigator.wakeLock fake (architecture §11.2). Requests are granted by default
// while the page is visible, like the real API; hiding the page releases every
// sentinel. Controls (window.fixture.wakeLock):
//   grant()   later requests succeed
//   deny()    later requests reject with NotAllowedError, and held locks are
//             released (the system took them back)
//   state()   {mode, held, active, requests, releases}
import {fireWithHandler} from './events.js';

export function installWakeLock(win) {
  const state = {mode: 'grant', requests: 0, releases: 0};
  const active = new Set();

  class WakeLockSentinel extends win.EventTarget {
    constructor(type) { super(); this.type = type; this.released = false; this.onrelease = null; }
    async release() { releaseOne(this); }
  }
  function releaseOne(sentinel) {
    if (sentinel.released) return;
    sentinel.released = true;
    active.delete(sentinel);
    state.releases++;
    fireWithHandler(sentinel, new win.Event('release'), 'onrelease');
  }
  const releaseAll = () => [...active].forEach(releaseOne);

  const wakeLock = {
    async request(type = 'screen') {
      state.requests++;
      if (type !== 'screen') throw new TypeError(`Failed to execute 'request' on 'WakeLock': The provided value '${type}' is not a valid enum value of type WakeLockType.`);
      if (state.mode === 'deny') throw new win.DOMException('Wake lock permission was denied (fixture).', 'NotAllowedError');
      if (win.document.visibilityState !== 'visible') throw new win.DOMException('The requesting page is not visible.', 'NotAllowedError');
      const sentinel = new WakeLockSentinel(type);
      active.add(sentinel);
      return sentinel;
    },
  };
  Object.defineProperty(win.navigator, 'wakeLock', {configurable: true, get: () => wakeLock});
  win.document.addEventListener('visibilitychange', () => { if (win.document.visibilityState !== 'visible') releaseAll(); });

  return {
    grant() { state.mode = 'grant'; },
    deny() { state.mode = 'deny'; releaseAll(); },
    state: () => ({mode: state.mode, held: active.size > 0, active: active.size, requests: state.requests, releases: state.releases}),
  };
}
