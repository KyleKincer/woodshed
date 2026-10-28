// The test handle (architecture §11.4): window.__woodshed, installed only in development builds
// and on the fixture (window.__FIXTURE__ is set first in <head> by tests/fixture/early.js). Fixture
// states assert on state through it, never on text.
//
//   window.__woodshed = {
//     store,                                    the app store (§2.2)
//     commands: {run(id, opts), isEnabled(id)},
//     activeSession() → {id, transport: {snapshot, position()}, practice: {value}, map: {isReal, sections}} | null,
//     idle() → Promise,                         the current navigation settled, then practice and tempo saves flushed
//   }
//
//   installDevHandle({win, store, registry, activeSession, settled}) → handle | null
//     activeSession() → Session|null (main.js: src/stage/session.js once loaded); settled() → Promise
//     (the router's current transition).

import {registry as appRegistry} from './commands.js';
import {store as appStore} from './store.js';

/** Whether this page gets the handle: Vite's DEV flag, or the fixture's marker. */
export function devHandleWanted(win = globalThis.window, env = import.meta.env) {
  return !!(env?.DEV || win?.__FIXTURE__ === true);
}

/** A read-through view of a Session for assertions (live getters; nothing is copied). */
export function sessionView(session) {
  if (!session) return null;
  return Object.freeze({
    id: session.id,
    transport: Object.freeze({
      get snapshot() { return session.transport?.snapshot?.value ?? null; },
      position: () => session.transport?.position?.() ?? null,
    }),
    practice: Object.freeze({
      get value() { return session.practice?.value?.value ?? null; },
    }),
    map: Object.freeze({
      get isReal() { return !!session.map?.isReal; },
      get sections() { return session.map?.sections ?? []; },
    }),
  });
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

export function installDevHandle({win = globalThis.window, store = appStore, registry = appRegistry, activeSession = () => null,
  settled = () => Promise.resolve(), env = import.meta.env} = {}) {
  if (!win || !devHandleWanted(win, env)) return null;
  const handle = Object.freeze({
    store,
    commands: Object.freeze({
      run: (id, opts) => registry.run(id, opts),
      isEnabled: id => registry.isEnabled(id),
    }),
    activeSession: () => sessionView(activeSession()),
    async idle() {
      await settled();
      const session = activeSession();
      if (session && typeof session.flush === 'function') await session.flush();
      await tick();
    },
  });
  try {
    Object.defineProperty(win, '__woodshed', {value: handle, configurable: true, enumerable: false, writable: false});
  } catch {
    win.__woodshed = handle;
  }
  return handle;
}
