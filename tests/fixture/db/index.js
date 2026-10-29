// The fixture's in-memory Convex stand-in (architecture §11.2).
//
// Every `db/*.js` module that exports `handlers` ({'module:function': (args) => value})
// is merged here; a name defined twice is an error. The stubs in ../stubs route
// every query, mutation, action and subscription of the app through `call` and
// `subscribe` by function name ("songs:get").
//
// The data comes from db/seed.js. Every change is persisted to
// sessionStorage['fx-db'] and reloaded on boot, so reload, resume and
// new-tab tests see what earlier steps wrote. The switches are early.js's map,
// which stays for the tab when a later URL has none. `?fx-reset=1` (handled by
// ../early.js before anything runs) clears it; a stored db from another seed
// version, or from other seed-affecting switches (seed.js SEED_SWITCHES), is
// replaced by a fresh seed.
//
// window.fixture gains: db() (a deep copy), update(fn) (mutate, then notify),
// reset() (a fresh seed), call(kind, name, args) (run a handler as the app would),
// freezeJobs(), and changed().
import {fx, db, setDb, setFx, pageSwitches, clone, changed, onChanged, NEVER} from './runtime.js';
import {createSeed, seedKey, SEED_VERSION} from './seed.js';

export {fx, db, changed, NEVER};
export const STORAGE_KEY = 'fx-db';

const MODULES = import.meta.glob(['./*.js', '!./index.js', '!./runtime.js', '!./seed.js'], {eager: true});

/** Merge the handler tables; throws on a function name defined in two modules. */
export function mergeHandlers(modules) {
  const out = {}, owner = {};
  for (const [file, mod] of Object.entries(modules)) {
    if (!mod.handlers) continue;
    for (const [name, fn] of Object.entries(mod.handlers)) {
      if (!/^[A-Za-z][\w]*:[A-Za-z][\w]*$/.test(name)) throw new Error(`fixture: bad handler name ${JSON.stringify(name)} in ${file}`);
      if (typeof fn !== 'function') throw new Error(`fixture: handler ${name} in ${file} is not a function`);
      if (owner[name]) throw new Error(`fixture: handler ${name} is defined in both ${owner[name]} and ${file}`);
      owner[name] = file;
      out[name] = fn;
    }
  }
  return out;
}

export const handlers = mergeHandlers(MODULES);

/**
 * Run every module's optional `settle(now)`: finish work that fell due while no page
 * was open (boot) or between timers (each job-creep tick). Modules may also export
 * `resume()`, run once after boot to re-arm their timers.
 */
export function settleAll(now = Date.now()) {
  let any = false;
  for (const mod of Object.values(MODULES)) if (typeof mod.settle === 'function' && mod.settle(now)) any = true;
  return any;
}

let storage = null;

function readStored(key) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    return stored && stored.version === SEED_VERSION && stored.key === key && stored.data ? stored.data : null;
  } catch {
    return null;
  }
}

/** Write the current db to sessionStorage; returns false when storage refuses it. */
export function persist() {
  if (!storage || !db) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({version: SEED_VERSION, key: seedKey(fx), data: db}));
    return true;
  } catch (error) {
    console.warn('[fixture] could not persist the database:', error?.message ?? error);
    return false;
  }
}

/**
 * (Re)initialise from the switches: a query string or a parsed map (default:
 * early.js's sticky map for the tab). Runs on import in a browser; tests call
 * it directly. Returns {restored: boolean}.
 */
export function boot({search = pageSwitches(), store = globalThis.sessionStorage ?? null, now = Date.now()} = {}) {
  setFx(search);
  storage = store;
  const key = seedKey(fx);
  const restored = readStored(key);
  setDb(restored ?? createSeed({fx, now}));
  settleAll();
  for (const mod of Object.values(MODULES)) if (typeof mod.resume === 'function') mod.resume();
  persist();
  return {restored: !!restored};
}

/** Throw the stored data away and start again from the seed. */
export function reset({now = Date.now()} = {}) {
  setDb(createSeed({fx, now}));
  persist();
  changed();
}

// ---- subscriptions ----------------------------------------------------------------
const subs = new Set();

export function subscribe(name, args, cb, onError) {
  const sub = {name, args, cb, onError, last: undefined, lastJson: undefined};
  subs.add(sub);
  run(sub);
  const stop = () => { subs.delete(sub); };
  return Object.assign(stop, {unsubscribe: stop, getCurrentValue: () => sub.last});
}

async function run(sub) {
  if (!subs.has(sub)) return;
  try {
    const value = await call('query', sub.name, sub.args);
    if (value === NEVER || !subs.has(sub)) return;
    const json = JSON.stringify(value);
    if (json === sub.lastJson) return;
    sub.lastJson = json; sub.last = value;
    sub.cb(value);
  } catch (error) { sub.onError?.(error); }
}

onChanged(() => { persist(); subs.forEach(run); });

/** Route one Convex call to its handler. */
export async function call(kind, name, args = {}) {
  const handler = handlers[name];
  if (!handler) {
    console.warn(`[fixture] no handler for ${kind} ${name}`, args);
    throw new Error(`Fixture has no handler for ${name}`);
  }
  const result = await handler(args || {});
  if (kind !== 'query') changed();
  return result === undefined ? null : result;
}

// ---- running jobs creep forward so the library looks alive ---------------------------
let creep = null;
export function startJobCreep(intervalMs = 4000) {
  stopJobCreep();
  creep = setInterval(() => {
    let any = settleAll();
    for (const j of db.jobs) if (j.status === 'running' && j.percent < 99 && !j.frozen) { j.percent = Math.min(99, j.percent + 1); any = true; }
    if (any) changed();
  }, intervalMs);
}
export function stopJobCreep() { if (creep) clearInterval(creep); creep = null; }

export function freezeJobs() {
  for (const j of db.jobs) j.frozen = true;
  changed();
}

/** The window.fixture database API. */
export function installFixtureApi(win) {
  const api = win.fixture ??= {};
  Object.assign(api, {
    fx,
    db: () => clone(db),
    update(fn) { const result = fn(db); changed(); return result === undefined ? undefined : clone(result); },
    reset: () => reset(),
    call: (kind, name, args) => call(kind, name, args).then(v => (v === NEVER ? null : clone(v))),
    freezeJobs,
    changed,
  });
  return api;
}

if (typeof window !== 'undefined' && !globalThis.__FX_DB_MANUAL_BOOT__) {
  boot();
  installFixtureApi(window);
  if (fx.jobs !== 'frozen') startJobCreep();
}
