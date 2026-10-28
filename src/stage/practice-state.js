// Practice state in memory (architecture §2.14.5): the client side of
// `shared/practice.ts`. It holds the song's practice blob v2, applies patches,
// keeps spots and markers mergeable across devices, re-anchors bar refs after a
// map change, and saves.
//
// Saving:
// - A patch schedules a save 600 ms later (debounced, `final: false`). `flush({final: true})`
//   (stop, unmount, pagehide, hidden, share, desktop flush) saves at once; only final saves
//   update the Library summary (D52), so a final flush also runs when the last save was not final.
// - Before each save: next = prunePractice(mergePractice(local, server.value, dirty)).
//   `dirty` holds the top-level keys this device changed and has not seen echoed by the server
//   yet; every other key takes the server's value (another device's change wins). When pruning
//   dropped markers or trimmed notes: status('Some old markers were removed to make room.').
// - One save runs at a time; a request during a save runs after it.
// - Errors: a failed save retries once after 5 s; after that the change stays local (and dirty)
//   until the next save.
// - Read-only songs opened from a share token (`local: {token}`) persist to this device only:
//   deviceStore('share').set(token, p). They read that copy back on open, so a viewer's spots,
//   markers, speed and mix survive a reload (spec §4.13).
//
// Spots and markers merge by id (newest `updatedAt` wins, tombstones win ties), so removals are
// tombstones: a patch that drops an item from `spots`/`markers` tombstones it, and one that brings
// a tombstoned item back revives it. That keeps undo (which patches whole lists back) correct
// against the server merge.
import {signal, readonly} from '../app/store.js';
import {clock as appClock} from '../app/clock.js';
import {deviceStore} from '../app/prefs.js';
import {upgradePractice, mergePractice, prunePractice, PRACTICE_CAP, MAX_SPOTS, MAX_MARKERS, MAX_NAME, MAX_NOTE,
  MIN_RATE, MAX_RATE} from '../../shared/practice.ts';

export const SAVE_DEBOUNCE_MS = 600;
export const RETRY_MS = 5000;
export const COPY = Object.freeze({
  pruned: 'Some old markers were removed to make room.',
});

const LIST_KEYS = ['spots', 'markers'];
const SCALAR_KEYS = ['lastAt', 'cue', 'surface', 'anchorBar', 'anchorTime', 'rate', 'lastRate', 'keepPitch', 'loop', 'tracks',
  'minusMe', 'onlyMe', 'chartAudio', 'click', 'trainer'];
const REF_EPS = 1e-6;
const MIN_LOOP = 0.02;

const json = (value) => (value === undefined ? '∅' : JSON.stringify(value));
const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const randomId = () => globalThis.crypto.randomUUID();

/** Fields a spot patch may set (`null` or '' removes the optional ones). */
const SPOT_FIELDS = ['name', 'a', 'b', 'aBar', 'bBar', 'rate', 'note'];

export function createPracticeState({songId, raw, duration, readOnly = false, persist, server = null, local = null,
  clock = appClock, status = null, legacyTempo, defaults} = {}) {
  const token = local?.token ?? null;
  const shareStore = token ? deviceStore('share') : null;
  const span = Number.isFinite(duration) && duration > 0 ? duration : undefined;
  const upgrade = (value) => upgradePractice(value, {duration: span, legacyTempo, defaults});

  // A share viewer's own copy wins over the sharer's snapshot.
  const stored = shareStore ? shareStore.get(token) : null;
  const state = signal(upgrade(stored ?? raw));
  const activeSpotId = signal(null);

  const dirty = new Set();          // keys changed here since the last save started
  const inflight = new Map();       // key → json of the value a save sent, until the server echoes it
  let unsaved = false;              // anything changed since the last save started (lists included)
  let unsummarized = false;         // a non-final save succeeded since the last final one
  let played = false;
  let disposed = false;
  let debounce = null;
  let retryTimer = null;
  let running = null;               // the save in progress
  let queued = null;                // {final, isRetry, promise, resolve}

  const now = () => clock.now();

  /* ---------- lists ---------- */

  /** A stamp strictly newer than the item's own, so the merge prefers this change. */
  const stampAfter = (item) => Math.max(now(), (item?.updatedAt ?? 0) + 1);

  const sameItem = (a, b) => {
    const {updatedAt: _a, ...x} = a, {updatedAt: _b, ...y} = b;
    return json(x) === json(y);
  };

  /** Turns a whole-list replacement into stamped edits, tombstones and revivals. */
  function reconcile(prev = [], next = []) {
    const before = new Map(prev.map((item) => [item.id, item]));
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(next) ? next : []) {
      if (!item || typeof item.id !== 'string' || seen.has(item.id)) continue;
      seen.add(item.id);
      const old = before.get(item.id);
      if (old && sameItem(old, item)) { out.push(old); continue; }
      // A new item keeps its own stamp; an edited or revived one gets a newer stamp than before.
      out.push({...item, updatedAt: old ? stampAfter(old) : (Number.isFinite(item.updatedAt) ? item.updatedAt : now())});
    }
    for (const old of prev) {
      if (seen.has(old.id)) continue;
      out.push(old.deleted ? old : {...old, deleted: true, updatedAt: stampAfter(old)});
    }
    return out;
  }

  /* ---------- commits ---------- */

  function changedKeys(prev, next) {
    return SCALAR_KEYS.filter((key) => json(prev[key]) !== json(next[key]));
  }

  /** Sets the value (sanitised), records the dirty keys and schedules a save. */
  function commit(next, extraDirty = []) {
    const prev = state.peek();
    next.spots = reconcile(prev.spots, next.spots);
    next.markers = reconcile(prev.markers, next.markers);
    const clean = upgrade({...next, v: 2});
    const keys = changedKeys(prev, clean);
    const listsChanged = LIST_KEYS.some((key) => json(prev[key]) !== json(clean[key]));
    if (!keys.length && !listsChanged) return false;
    for (const key of [...keys, ...extraDirty]) if (SCALAR_KEYS.includes(key)) dirty.add(key);
    unsaved = true;
    state.value = clean;
    scheduleSave();
    return true;
  }

  function patch(update, {dirty: declared = []} = {}) {
    const draft = copy(state.peek());
    let next = draft;
    if (typeof update === 'function') {
      const result = update(draft);
      if (result && typeof result === 'object') next = result;
    } else if (update && typeof update === 'object') {
      next = {...draft, ...copy(update)};
    } else {
      return;
    }
    commit(next, declared);
  }

  /* ---------- spots ---------- */

  const liveSpots = () => state.peek().spots.filter((s) => !s.deleted);

  function spotFields(fields, base = {}) {
    const out = {...base};
    for (const key of SPOT_FIELDS) {
      if (!(key in fields)) continue;
      const value = fields[key];
      if (key === 'name') out.name = text(value, MAX_NAME) || out.name || 'Spot';
      else if (key === 'note') { const note = text(value, MAX_NOTE); if (note) out.note = note; else delete out.note; }
      else if (key === 'aBar' || key === 'bBar') { if (value) out[key] = copy(value); else delete out[key]; }
      else if (key === 'rate') out.rate = Number.isFinite(value) ? clamp(value, MIN_RATE, MAX_RATE) : (out.rate ?? 1);
      else if (Number.isFinite(value)) out[key] = value;
    }
    if (out.b < out.a) [out.a, out.b] = [out.b, out.a];
    return out;
  }

  function addSpot(fields = {}) {
    if (liveSpots().length >= MAX_SPOTS) return null;
    const id = randomId();
    const spot = spotFields(fields, {id, name: 'Spot', a: 0, b: 0, rate: 1, passes: 0, updatedAt: now()});
    if (!(spot.b - spot.a >= MIN_LOOP)) return null;
    patch((p) => { p.spots.push(spot); });
    return state.peek().spots.some((s) => s.id === id && !s.deleted) ? id : null;
  }

  function updateSpot(id, fields = {}) {
    patch((p) => {
      const i = p.spots.findIndex((s) => s.id === id && !s.deleted);
      if (i >= 0) p.spots[i] = spotFields(fields, p.spots[i]);
    });
  }

  function deleteSpot(id) {
    patch((p) => { p.spots = p.spots.filter((s) => s.id !== id); });
    if (activeSpotId.peek() === id) activeSpotId.value = null;
  }

  /** A pass through a practised spot: passes += n, lastAt = now. Not an undo step. */
  function touchSpot(id, {passes = 1} = {}) {
    patch((p) => {
      const spot = p.spots.find((s) => s.id === id && !s.deleted);
      if (!spot) return;
      spot.passes = Math.max(0, Math.floor((spot.passes ?? 0) + (Number.isFinite(passes) ? passes : 1)));
      spot.lastAt = now();
    });
  }

  /* ---------- markers ---------- */

  const liveMarkers = () => state.peek().markers.filter((m) => !m.deleted);

  function addMarker({t, label} = {}) {
    if (!Number.isFinite(t)) return null;
    const live = liveMarkers();
    if (live.length >= MAX_MARKERS) return null;
    const id = randomId();
    const marker = {id, t: Math.max(0, span ? Math.min(t, span) : t), label: text(label, MAX_NAME) || `Marker ${live.length + 1}`, updatedAt: now()};
    patch((p) => { p.markers.push(marker); });
    return id;
  }

  function renameMarker(id, label) {
    const name = text(label, MAX_NAME);
    if (!name) return;
    patch((p) => {
      const marker = p.markers.find((m) => m.id === id && !m.deleted);
      if (marker) marker.label = name;
    });
  }

  function deleteMarker(id) {
    patch((p) => { p.markers = p.markers.filter((m) => m.id !== id); });
  }

  /* ---------- session hooks ---------- */

  /** After a map change: the loop and spots with bar refs move to where their bars now are. */
  function reanchor(map, {auditioning = false} = {}) {
    if (!map || auditioning || map.auditioning) return;
    const resolve = (ref) => (ref ? map.timeOfRef(ref) : null);
    patch((p) => {
      const move = (item) => {
        if (!item.aBar && !item.bBar) return;
        const a = resolve(item.aBar), b = resolve(item.bBar);
        const ok = (!item.aBar || a !== null) && (!item.bBar || b !== null);
        if (!ok) { delete item.aBar; delete item.bBar; return; }   // a bar is gone: keep the seconds
        const na = a ?? item.a, nb = b ?? item.b;
        if (!(nb - na >= MIN_LOOP)) { delete item.aBar; delete item.bBar; return; }
        if (Math.abs(na - item.a) > REF_EPS) item.a = na;
        if (Math.abs(nb - item.b) > REF_EPS) item.b = nb;
      };
      move(p.loop);
      for (const spot of p.spots) if (!spot.deleted) move(spot);
    });
  }

  /** The first Play of this session stamps `lastAt`; later plays do nothing. */
  function markPlayed() {
    if (played) return;
    played = true;
    patch((p) => { p.lastAt = now(); });
  }

  function markStopped() {
    return flush({final: true});
  }

  /* ---------- server ---------- */

  const serverValue = () => (server ? (typeof server.peek === 'function' ? server.peek() : server.value) : null);

  /** Another device's change (or our own echo) arrived: take it for every key we have not changed. */
  function adopt(rawServer) {
    if (rawServer === null || rawServer === undefined) return;
    const upgraded = upgrade(rawServer);
    for (const [key, sent] of inflight) if (json(upgraded[key]) === sent) inflight.delete(key);
    const merged = mergePractice(state.peek(), upgraded, new Set([...dirty, ...inflight.keys()]));
    const clean = upgrade(merged);
    if (json(clean) !== json(state.peek())) state.value = clean;
  }

  const offServer = server && typeof server.subscribe === 'function' ? server.subscribe((value) => adopt(value)) : null;

  /* ---------- saving ---------- */

  function scheduleSave() {
    if (disposed) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      requestSave(false);
    }, SAVE_DEBOUNCE_MS);
  }

  async function write(value, final) {
    if (shareStore) { shareStore.set(token, value); return; }
    if (readOnly || typeof persist !== 'function') return;
    await persist(value, {final});
  }

  async function attempt(final, isRetry) {
    if (!unsaved && !(final && unsummarized)) return;
    if (!isRetry) { clearTimeout(retryTimer); retryTimer = null; }
    const keys = [...dirty];
    const merged = mergePractice(state.peek(), serverValue(), new Set([...keys, ...inflight.keys()]));
    const {value, pruned} = prunePractice(upgrade(merged), PRACTICE_CAP, now());
    if (json(value) !== json(state.peek())) state.value = value;
    if (pruned > 0) status?.(COPY.pruned);
    const sentAll = new Map(keys.map((key) => [key, json(value[key])]));
    dirty.clear();
    unsaved = false;
    for (const [key, sent] of sentAll) inflight.set(key, sent);
    try {
      await write(value, final);
      if (final) unsummarized = false;
      else unsummarized = true;
    } catch (err) {
      // Keep the change: the next save sends it again.
      for (const key of keys) { dirty.add(key); if (inflight.get(key) === sentAll.get(key)) inflight.delete(key); }
      unsaved = true;
      // One retry after 5 s (it still runs after dispose, so a failed save on leave gets its second try).
      if (!isRetry) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { retryTimer = null; requestSave(final, true); }, RETRY_MS);
      }
      console.warn(`Practice save failed for ${songId ?? 'this song'}; keeping the change on this device.`, err);
    }
  }

  function requestSave(final, isRetry = false) {
    if (running) {
      if (!queued) {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        queued = {final, isRetry, promise, resolve};
      } else {
        queued.final = queued.final || final;
        queued.isRetry = queued.isRetry && isRetry;
      }
      return queued.promise;
    }
    running = attempt(final, isRetry).finally(() => {
      running = null;
      if (queued) {
        const next = queued;
        queued = null;
        requestSave(next.final, next.isRetry).then(next.resolve);
      }
    });
    return running;
  }

  function flush({final = false} = {}) {
    clearTimeout(debounce);
    debounce = null;
    return requestSave(final);
  }

  function dispose() {
    if (disposed) return;
    const pending = unsaved;
    disposed = true;
    clearTimeout(debounce);
    debounce = null;
    offServer?.();
    if (pending) requestSave(true);
  }

  return {
    value: readonly(state),
    patch,
    addSpot, updateSpot, deleteSpot, touchSpot,
    activeSpotId,
    addMarker, renameMarker, deleteMarker,
    reanchor, markPlayed, markStopped,
    flush, dispose,
    /** True while a change has not been handed to a save yet (for the desktop quit guard and tests). */
    get pending() { return unsaved || running !== null; },
  };
}

export default createPracticeState;
