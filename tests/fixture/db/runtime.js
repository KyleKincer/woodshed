// Shared state and helpers for the fixture's in-memory Convex stand-in
// (architecture §11.2). Handler modules (db/*.js) import from here; db/index.js
// boots the database, routes calls and persists every change.
//
// `db` is a live binding: handlers read and mutate `db.songs`, `db.jobs`, …
// exactly as the 1.9 fixture did, and a reset or reload swaps the whole object.

/** Switches from the page URL: `?fx-library=empty` → `fx.library === 'empty'`. */
export const fx = {};

/** The current database (see db/seed.js for its tables). */
export let db = null;

export function setDb(next) { db = next; }

/** Replace the switches in place, so every importer sees the new values. */
export function setFx(search) {
  for (const key of Object.keys(fx)) delete fx[key];
  for (const [k, v] of new URLSearchParams(search || '')) if (k.startsWith('fx-')) fx[k.slice(3)] = v;
  return fx;
}

export const clone = value => structuredClone(value);
export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export const DAY = 864e5;

/** Returned by a query that never resolves (for example `fx-library=slow`). */
export const NEVER = Symbol('never');

/** A ConvexError look-alike: `data` survives like the real one. */
export function convexError(data) {
  const error = new Error(typeof data === 'string' ? data : data.message);
  error.data = data;
  return error;
}

const listeners = new Set();
let pending = false;

/** Something in `db` changed: re-run subscriptions and persist, once per tick. */
export function changed() {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    for (const fn of [...listeners]) fn();
  }, 0);
}

/** Register a change listener (db/index.js uses it); returns `off`. */
export function onChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const findSong = id => db.songs.find(s => s.id === id);
/** Song rows as the 1.9 client saw them: the synthesis hints stay private. */
export const publicSong = ({bpm, offset, ...s}) => clone(s);
