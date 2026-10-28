// Signals and the app store (architecture §2.2).
//
//   signal(initial, {equals})  a writable value: {value, peek(), update(fn), subscribe(fn) → off}
//   computed(fn)               a derived, cached, read-only value
//   effect(fn)                 runs fn now and again whenever a signal it read changes;
//                              fn may return a cleanup, run before the next run and on dispose
//   batch(fn)                  defers effects until fn returns, then runs each at most once
//   untracked(fn)              runs fn without recording dependencies
//
// Semantics:
// - Glitch-free: an effect never observes a half-updated graph. A computed is
//   recomputed only when one of its dependencies actually changed (version check).
// - Effects run in the order they were scheduled, once per flush, after the
//   write (or the outermost batch) that changed their dependencies.
// - No leaks: a computed with no subscribers holds no subscriptions of its own;
//   it re-validates on read. Dependencies an effect stops reading are dropped.
// - `subscribe(fn)` calls fn(value, previous) on changes only (not immediately).
//
// The playback position never passes through signals; it uses the frame bus.

import {prefsSignal} from './prefs.js';

let observer = null;      // the computed or effect currently collecting dependencies
let batchDepth = 0;
let flushing = false;
const queue = [];         // effects waiting to run, in scheduling order
const MAX_RUNS_PER_FLUSH = 100;

const CLEAN = 0, STALE = 1;

function link(dep, node) {
  if (dep.subs.has(node)) return;
  dep.subs.add(node);
  if (dep.kind === 'computed' && dep.subs.size === 1) {
    // First subscriber: the computed becomes live and subscribes upstream.
    for (const upstream of dep.deps.keys()) link(upstream, dep);
  }
}

function unlink(dep, node) {
  if (!dep.subs.delete(node)) return;
  if (dep.kind === 'computed' && dep.subs.size === 0) {
    // Last subscriber gone: release upstream subscriptions; re-validate on next read.
    for (const upstream of dep.deps.keys()) unlink(upstream, dep);
    dep.state = STALE;
  }
}

const isLive = node => (node.kind === 'effect' ? !node.disposed : node.subs.size > 0);

function track(dep) {
  if (!observer) return;
  observer.deps.set(dep, {version: dep.version, value: dep.current});
  if (isLive(observer)) link(dep, observer);
}

function mark(node) {
  for (const sub of node.subs) {
    if (sub.kind === 'computed') {
      if (sub.state === CLEAN) { sub.state = STALE; mark(sub); }
    } else if (!sub.queued && !sub.disposed) {
      sub.queued = true;
      queue.push(sub);
    }
  }
}

function changedSince(deps) {
  for (const [dep, seen] of deps) {
    if (dep.kind === 'computed') refresh(dep);
    if (dep.version === seen.version) continue;
    // A signal written and written back (e.g. inside one batch) has not changed for this reader.
    if (dep.kind === 'signal' && dep.equals(seen.value, dep.current)) { seen.version = dep.version; continue; }
    return true;
  }
  return false;
}

function refresh(c) {
  if (c.computing) throw new Error('computed: cycle detected');
  if (c.initialized && c.state === CLEAN && c.subs.size > 0) return;
  if (c.initialized) {
    let changed;
    try { changed = changedSince(c.deps); } catch { changed = true; }
    if (!changed) { c.state = CLEAN; return; }
  }
  recompute(c);
}

function recompute(c) {
  const previousDeps = c.deps;
  c.deps = new Map();
  c.computing = true;
  const outer = observer;
  observer = c;
  let value, error = null;
  try { value = c.fn(); } catch (e) { error = {e}; }
  finally { observer = outer; c.computing = false; }
  if (c.subs.size > 0) {
    for (const dep of previousDeps.keys()) if (!c.deps.has(dep)) unlink(dep, c);
  }
  const changed = error || !c.initialized || c.error || !c.equals(c.current, value);
  if (error) c.error = error;
  else { c.error = null; c.current = value; }
  if (changed) c.version++;
  c.initialized = true;
  c.state = CLEAN;
}

function runCleanup(e) {
  const cleanup = e.cleanup;
  e.cleanup = null;
  if (cleanup) untracked(cleanup);
}

function runEffect(e) {
  if (e.disposed) return;
  runCleanup(e);
  const previousDeps = e.deps;
  e.deps = new Map();
  const outer = observer;
  observer = e;
  try {
    const result = e.fn();
    if (typeof result === 'function') e.cleanup = result;
  } finally {
    observer = outer;
    for (const dep of previousDeps.keys()) if (!e.deps.has(dep)) unlink(dep, e);
    if (e.disposed) {
      // Disposed during its own run: drop whatever it linked and clean up now.
      for (const dep of e.deps.keys()) unlink(dep, e);
      runCleanup(e);
    }
  }
}

function flush() {
  if (flushing || batchDepth > 0) return;
  flushing = true;
  const runs = new Map();
  let failure = null;
  try {
    while (queue.length) {
      const e = queue.shift();
      e.queued = false;
      if (e.disposed) continue;
      const n = (runs.get(e) || 0) + 1;
      runs.set(e, n);
      if (n > MAX_RUNS_PER_FLUSH) {
        failure ??= {e: new Error('effect: cycle detected (an effect keeps re-triggering itself)')};
        continue;
      }
      try {
        let due;
        try { due = changedSince(e.deps); } catch { due = true; }
        if (due) runEffect(e);
      } catch (err) {
        failure ??= {e: err};
      }
    }
  } finally {
    flushing = false;
  }
  if (failure) throw failure.e;
}

function write(s, next) {
  if (observer && observer.kind === 'computed') throw new Error('signal: cannot write inside computed()');
  if (s.equals(s.current, next)) return;
  s.current = next;
  s.version++;
  mark(s);
  flush();
}

function subscribeTo(read, fn) {
  let first = true, previous;
  return effect(() => {
    const value = read();
    if (first) { first = false; previous = value; return; }
    const before = previous;
    previous = value;
    untracked(() => fn(value, before));
  });
}

/** A writable signal. */
export function signal(initial, {equals = Object.is} = {}) {
  const s = {kind: 'signal', current: initial, version: 0, subs: new Set(), equals};
  const self = {
    get value() { track(s); return s.current; },
    set value(next) { write(s, next); },
    peek() { return s.current; },
    update(fn) { write(s, fn(s.current)); },
    subscribe(fn) { return subscribeTo(() => self.value, fn); },
  };
  return self;
}

/** A derived, cached, read-only signal. Throws on read if fn threw. */
export function computed(fn, {equals = Object.is} = {}) {
  const c = {kind: 'computed', fn, current: undefined, error: null, version: 0, deps: new Map(),
    subs: new Set(), state: STALE, initialized: false, computing: false, equals};
  const read = () => {
    refresh(c);
    if (c.error) throw c.error.e;
    return c.current;
  };
  const self = {
    get value() {
      refresh(c);
      track(c);
      if (c.error) throw c.error.e;
      return c.current;
    },
    set value(_) { throw new TypeError('computed: read-only'); },
    peek() { return untracked(read); },
    subscribe(fn) { return subscribeTo(() => self.value, fn); },
  };
  return self;
}

/** Runs fn now and whenever a signal it read changes. Returns dispose(). */
export function effect(fn) {
  const e = {kind: 'effect', fn, deps: new Map(), cleanup: null, disposed: false, queued: false};
  const dispose = () => {
    if (e.disposed) return;
    e.disposed = true;
    for (const dep of e.deps.keys()) unlink(dep, e);
    e.deps.clear();
    if (observer !== e) runCleanup(e);
  };
  // The first run is batched like any other: writes it makes run their effects (itself included)
  // after it returns, never nested inside it.
  batchDepth++;
  try {
    runEffect(e);
  } catch (err) {
    batchDepth--;
    dispose();
    try { flush(); } catch { /* the original error wins */ }
    throw err;
  }
  batchDepth--;
  flush();
  return dispose;
}

/** Defers effects until fn returns; returns fn's result. Nested batches flush once, at the end. */
export function batch(fn) {
  batchDepth++;
  let result;
  try {
    result = fn();
  } catch (err) {
    batchDepth--;
    try { flush(); } catch { /* the original error wins */ }
    throw err;
  }
  batchDepth--;
  flush();
  return result;
}

/** Runs fn without recording any signal it reads as a dependency. */
export function untracked(fn) {
  const outer = observer;
  observer = null;
  try { return fn(); } finally { observer = outer; }
}

/** A read-only view of a signal (no setter, no update). */
export function readonly(sig) {
  return Object.freeze({
    get value() { return sig.value; },
    peek: () => sig.peek(),
    subscribe: fn => sig.subscribe(fn),
  });
}

const pendingAccount = signal(null);

export const store = {
  session: signal({user: null, admin: false, status: 'active', online: true}),  // status: 'active'|'export_only'|'suspended'
  config: signal(null),        // settings.config: {presets, models, stemModes, bitrates, defaultPreset}
  account: signal(null),       // settings.config.settings (account settings; §2.4)
  // Device prefs (§2.5). Owned by prefs.js: created and loaded from ws.prefs on first access.
  // Write through prefs.set/update so the change persists and syncs across tabs.
  get prefs() { return prefsSignal(); },
  library: {
    songs: signal(new Map()), loaded: signal(false), jobs: signal([]), uploads: signal([]),
    devices: signal([]), setlists: signal([]),
  },
  processor: signal({phase: 'web'}),   // §2.11
  update: signal({status: 'idle'}),
  stage: signal(null),                 // {songId, layout, surface, playing, focus} while a Stage or Edit view is mounted
  // Account carry-over from the prefs migration until account.patch succeeds (§2.5); mirrors
  // prefs.pendingAccount (setting it to null clears both). Reading it loads the prefs.
  get pendingAccount() { prefsSignal(); return pendingAccount; },
};
