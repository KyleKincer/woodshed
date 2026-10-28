// The command registry (architecture §2.6, spec §7.1). Definitions are eager and cheap (D46); their `run` reaches heavy
// work through context providers. The module exports one app-wide registry; `createRegistry()` builds isolated ones
// (tests, registry CI).

import {canonical, isReserved, parseKey} from './keys.js';

export const GROUPS = Object.freeze(['Transport', 'Loop', 'Speed', 'Click', 'Mix', 'Navigate', 'View', 'Practice', 'Edit', 'Map',
  'Chart', 'Library', 'App']);
export const ELECTRON_MENUS = Object.freeze(['File', 'Edit', 'View', 'Transport', 'Help']);
export const ID_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/;

/** Names the context exposes; each is filled by provide(name, getter). */
export const CONTEXT_NAMES = Object.freeze(['place', 'posture', 'route', 'session', 'transport', 'stage', 'edit', 'map', 'chart',
  'library', 'focused', 'store', 'router', 'feedback', 'platform']);

/** Scopes the dispatcher knows at boot (D45, D18). 'KeyE' passes through the score only when no drum letter binds it. */
export const BOOT_SCOPES = Object.freeze([
  ['stage.strip', {}],
  ['stage.bars', {}],
  ['edit.chart.score', {stop: true, passThrough: ['Space', 'Shift+Space', 'Enter', 'Escape', 'PageUp', 'PageDown', 'Mod+KeyK', '?', 'KeyE']}],
]);

const INVALIDATE_MS = 50;
const DEF_KEYS = new Set(['id', 'title', 'group', 'keys', 'scopes', 'when', 'disabledReason', 'run', 'checked', 'repeat', 'pedal',
  'global', 'icon', 'menu', 'palette']);

function fail(def, message) {
  throw new TypeError(`Command ${def?.id ? `"${def.id}"` : '(no id)'}: ${message}`);
}

function validate(def) {
  if (!def || typeof def !== 'object') throw new TypeError('A command definition must be an object.');
  if (typeof def.id !== 'string' || !ID_RE.test(def.id)) fail(def, 'id must look like "area.name".');
  for (const k of Object.keys(def)) if (!DEF_KEYS.has(k)) fail(def, `unknown field "${k}".`);
  if (!(typeof def.title === 'string' && def.title.trim()) && typeof def.title !== 'function') fail(def, 'needs a title.');
  if (!GROUPS.includes(def.group)) fail(def, `group must be one of ${GROUPS.join(', ')}.`);
  if (typeof def.run !== 'function') fail(def, 'needs a run function.');
  for (const fn of ['when', 'disabledReason', 'checked']) {
    if (def[fn] !== undefined && typeof def[fn] !== 'function') fail(def, `${fn} must be a function.`);
  }
  const keys = def.keys ?? [];
  if (!Array.isArray(keys)) fail(def, 'keys must be an array of key strings.');
  const scopes = def.scopes ?? [];
  if (!Array.isArray(scopes) || scopes.some(s => typeof s !== 'string' || !s)) fail(def, 'scopes must be an array of scope names.');
  const canon = keys.map(k => {
    try { parseKey(k); } catch (err) { fail(def, err.message); }
    const c = canonical(k);
    if (isReserved(c)) fail(def, `"${k}" is reserved by the browser or the OS (spec §7.4).`);
    return c;
  });
  if (new Set(canon).size !== canon.length) fail(def, 'lists the same key twice.');
  if (canon.length && !scopes.length) fail(def, 'has keys but no scopes to bind them in.');
  if (def.menu !== undefined) {
    if (typeof def.menu !== 'object' || def.menu === null) fail(def, 'menu must be an object.');
    if (def.menu.electron !== undefined && !ELECTRON_MENUS.includes(def.menu.electron)) {
      fail(def, `menu.electron must be one of ${ELECTRON_MENUS.join(', ')}.`);
    }
  }
  if (def.palette !== undefined && (typeof def.palette !== 'object' || def.palette === null)) fail(def, 'palette must be an object.');
  return Object.freeze({
    ...def,
    keys: Object.freeze(canon),
    scopes: Object.freeze([...scopes]),
    repeat: !!def.repeat,
    pedal: !!def.pedal,
    global: !!def.global,
  });
}

function rootDataset() {
  return typeof document !== 'undefined' && document.documentElement ? document.documentElement.dataset : {};
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

function substitute(value, n) {
  return typeof value === 'string' ? value.split('{n}').join(String(n)) : value;
}

export function createRegistry({bootScopes = BOOT_SCOPES} = {}) {
  const defs = new Map();                 // id → frozen def, in registration order
  const index = new Map();                // scope → Map<KeyString, def[]>
  const scopes = new Map();               // name → {name, stop, passThrough}
  const providers = new Map();            // name → getter[] (last wins; off restores the previous one)
  const families = new Map();             // template → ids
  const listeners = new Set();
  let snapshot = new Map();               // id → state key, for invalidate() diffs
  let timer = null;

  function notify(change) {
    for (const fn of [...listeners]) {
      try { fn(change); } catch (err) { queueMicrotask(() => { throw err; }); }
    }
  }

  function addToIndex(def) {
    for (const scope of def.scopes) {
      let byKey = index.get(scope);
      if (!byKey) index.set(scope, byKey = new Map());
      for (const key of def.keys) {
        const list = byKey.get(key);
        if (list) list.push(def); else byKey.set(key, [def]);
      }
    }
  }

  function removeFromIndex(def) {
    for (const scope of def.scopes) {
      const byKey = index.get(scope);
      if (!byKey) continue;
      for (const key of def.keys) {
        const list = byKey.get(key)?.filter(d => d !== def);
        if (list?.length) byKey.set(key, list); else byKey.delete(key);
      }
    }
  }

  function add(raw) {
    const def = validate(raw);
    if (defs.has(def.id)) fail(def, 'is already registered.');
    defs.set(def.id, def);
    addToIndex(def);
    return def;
  }

  function register(def) {
    const d = add(def);
    notify({type: 'registry', ids: [d.id]});
    return () => unregister(d.id);
  }

  function registerMany(list) {
    const added = [];
    try {
      for (const def of list) added.push(add(def));
    } catch (err) {
      for (const d of added) { defs.delete(d.id); removeFromIndex(d); }
      throw err;
    }
    if (added.length) notify({type: 'registry', ids: added.map(d => d.id)});
    return () => { for (const d of added) unregister(d.id); };
  }

  function unregister(id) {
    const def = defs.get(id);
    if (!def) return false;
    defs.delete(id);
    removeFromIndex(def);
    snapshot.delete(id);
    notify({type: 'registry', ids: [id]});
    return true;
  }

  function defineScope(name, {stop = false, passThrough = []} = {}) {
    if (typeof name !== 'string' || !name) throw new TypeError('A scope needs a name.');
    const list = passThrough.map(k => canonical(k));
    const scope = Object.freeze({name, stop: !!stop, passThrough: Object.freeze(list)});
    scopes.set(name, scope);
    return scope;
  }

  function getScope(name) {
    return scopes.get(name) ?? null;
  }

  /**
   * Declares a dynamic id family so registry CI can expand it: ('mix.mute.{n}', [1, …, 9]). With a definition object as the
   * template (string fields may contain '{n}'), every expanded definition is also registered; its functions receive n:
   * run(c, {...args, n}), and title/when/checked/disabledReason(c, n).
   */
  function registerDynamic(template, ids) {
    if (!Array.isArray(ids) || !ids.length) throw new TypeError('registerDynamic needs a non-empty list of ids.');
    const pattern = typeof template === 'string' ? template : template?.id;
    if (typeof pattern !== 'string' || !pattern.includes('{n}')) throw new TypeError('A dynamic template id must contain "{n}".');
    const expanded = ids.map(n => substitute(pattern, n));
    let off = () => {};
    if (typeof template === 'object') {
      const bind = (fn, n) => (typeof fn === 'function' ? c => fn(c, n) : fn);
      off = registerMany(ids.map(n => ({
        ...template,
        id: substitute(template.id, n),
        title: typeof template.title === 'function' ? bind(template.title, n) : substitute(template.title, n),
        keys: template.keys?.map(k => substitute(k, n)),
        when: bind(template.when, n),
        checked: bind(template.checked, n),
        disabledReason: bind(template.disabledReason, n),
        run: (c, args) => template.run(c, {...args, n}),
      })));
    }
    families.set(pattern, Object.freeze(expanded));
    return () => { off(); families.delete(pattern); };
  }

  /** Every declared dynamic family: [{template, ids}]. */
  function dynamicFamilies() {
    return [...families].map(([template, ids]) => ({template, ids}));
  }

  function provide(name, getter) {
    if (typeof name !== 'string' || !name) throw new TypeError('A provider needs a name.');
    const fn = typeof getter === 'function' ? getter : () => getter;
    let stack = providers.get(name);
    if (!stack) providers.set(name, stack = []);
    stack.push(fn);
    invalidate();
    return () => {
      const list = providers.get(name);
      const at = list ? list.lastIndexOf(fn) : -1;
      if (at >= 0) list.splice(at, 1);
      invalidate();
    };
  }

  function provided(name) {
    const stack = providers.get(name);
    return stack?.length ? stack[stack.length - 1]() : undefined;
  }

  function fallback(name, ctx) {
    if (name === 'place') return rootDataset().place ?? null;
    if (name === 'posture') return rootDataset().posture ?? null;
    if (name === 'route') return ctx.router?.current?.value ?? null;
    return null;
  }

  /** A command context. Provider values are read lazily, on first access, and fixed for the context's lifetime. */
  function context(extra = {}) {
    const ctx = {};
    const names = new Set([...CONTEXT_NAMES, ...providers.keys()]);
    for (const name of names) {
      let cached, done = false;
      Object.defineProperty(ctx, name, {
        enumerable: true,
        configurable: true,
        get() {
          if (!done) {
            done = true;
            const value = provided(name);
            cached = value === undefined ? fallback(name, ctx) : value;
          }
          return cached;
        },
      });
    }
    Object.defineProperty(ctx, 'source', {value: 'program', enumerable: true, writable: true, configurable: true});
    Object.defineProperty(ctx, 'event', {value: null, enumerable: true, writable: true, configurable: true});
    Object.defineProperty(ctx, 'args', {value: undefined, enumerable: true, writable: true, configurable: true});
    for (const [k, v] of Object.entries(extra)) {
      Object.defineProperty(ctx, k, {value: v, enumerable: true, writable: true, configurable: true});
    }
    return ctx;
  }

  function evaluate(def, ctx) {
    const visible = def.when ? safe(() => !!def.when(ctx), false) : true;
    const reason = visible && def.disabledReason ? safe(() => def.disabledReason(ctx) || null, null) : null;
    const checked = def.checked ? safe(() => !!def.checked(ctx), false) : undefined;
    const title = typeof def.title === 'function' ? safe(() => String(def.title(ctx) ?? ''), '') : def.title;
    return {visible, enabled: visible && !reason, reason, checked, title};
  }

  /** {visible, enabled, reason, checked, title} for a command, or null when unknown. `visible` is `when`. */
  function state(id, ctx = context()) {
    const def = defs.get(id);
    return def ? evaluate(def, ctx) : null;
  }

  function get(id) { return defs.get(id) ?? null; }
  function all() { return [...defs.values()]; }
  function isEnabled(id) { return state(id)?.enabled ?? false; }
  function isChecked(id) { return state(id)?.checked; }
  function disabledReasonFor(id) { return state(id)?.reason ?? null; }
  function titleFor(id, ctx) { return state(id, ctx)?.title ?? ''; }

  /** True when the def's `when` passes in ctx (the dispatcher's binding test). */
  function passes(def, ctx) {
    return !def.when || safe(() => !!def.when(ctx), false);
  }

  function run(id, {source = 'pointer', args, event} = {}) {
    const def = defs.get(id);
    if (!def) return false;
    const ctx = context({source, args, event: event ?? null});
    const s = evaluate(def, ctx);
    if (!s.enabled) return false;
    try {
      def.run(ctx, args);
    } finally {
      invalidate();
    }
    return true;
  }

  /** The first def bound to each key in `scope`. */
  function bindingsFor(scope) {
    const out = new Map();
    for (const [key, list] of index.get(scope) ?? []) out.set(key, list[0]);
    return out;
  }

  /** Every def bound to `key` (canonical) in `scope`, in registration order. */
  function defsFor(scope, key) {
    return index.get(scope)?.get(key) ?? [];
  }

  /** Every scope that has at least one binding. */
  function boundScopes() {
    return [...index.keys()].filter(s => index.get(s).size);
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function recompute() {
    timer = null;
    const ctx = context();
    const next = new Map();
    const changed = [];
    for (const def of defs.values()) {
      const s = evaluate(def, ctx);
      const key = `${s.visible}|${s.enabled}|${s.reason}|${s.checked}|${s.title}`;
      next.set(def.id, key);
      if (snapshot.get(def.id) !== key) changed.push(def.id);
    }
    snapshot = next;
    if (changed.length) notify({type: 'state', ids: changed});
  }

  function invalidate() {
    if (timer != null) return;
    timer = setTimeout(recompute, INVALIDATE_MS);
  }

  for (const [name, opts] of bootScopes) defineScope(name, opts);

  return {
    register, registerMany, unregister, defineScope, getScope, registerDynamic, dynamicFamilies, get, all, provide, context,
    run, isEnabled, isChecked, disabledReasonFor, titleFor, state, passes, bindingsFor, defsFor, boundScopes, onChange, invalidate,
  };
}

/** The app-wide registry. */
export const registry = createRegistry();

export const {
  register, registerMany, unregister, defineScope, getScope, registerDynamic, dynamicFamilies, get, all, provide, context, run,
  isEnabled, isChecked, disabledReasonFor, titleFor, state, passes, bindingsFor, defsFor, boundScopes, onChange, invalidate,
} = registry;
