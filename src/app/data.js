// App-lifetime subscriptions (architecture §2.13, boot step 6): songs.list, jobs.listActive,
// devices.list and setlists.list fill store.library. The songs map updates by id: a row whose
// content did not change keeps its object, so keyed views (reconcileList) skip it, and the map is
// replaced only when something changed. library.loaded flips after the first songs.list.
//
//   startData({store, api, onError}) → stop
//
// store.library.uploads belongs to src/library/upload.js and is not touched here.

import * as songsApi from '../api/songs.js';
import * as jobsApi from '../api/jobs.js';
import * as devicesApi from '../api/devices.js';
import * as setlistsApi from '../api/setlists.js';
import {batch, store as appStore} from './store.js';

const json = v => JSON.stringify(v);

/** The next songs map from a songs.list result, reusing unchanged rows of `previous` (by id and content). */
export function nextSongs(previous, rows) {
  const list = Array.isArray(rows) ? rows : Array.isArray(rows?.songs) ? rows.songs : [];
  const next = new Map();
  let changed = list.length !== previous.size;
  let i = 0;
  const order = [...previous.keys()];
  for (const row of list) {
    if (!row || typeof row.id !== 'string') continue;
    const old = previous.get(row.id);
    const keep = old !== undefined && json(old) === json(row);
    next.set(row.id, keep ? old : row);
    if (!keep || order[i] !== row.id) changed = true;
    i++;
  }
  if (next.size !== previous.size) changed = true;
  return changed ? next : previous;
}

/** A list row's key: songs and setlists carry `id`, jobs.listActive rows `jobId`, devices.list rows `deviceId`. */
export const rowId = item => item?.id ?? item?.jobId ?? item?.deviceId ?? item?._id;

/** A list result with unchanged items (by id and content) reused from `previous`; `previous` itself when nothing changed. */
export function nextList(previous, rows, idOf = rowId) {
  const list = Array.isArray(rows) ? rows : [];
  const byId = new Map(previous.map(item => [idOf(item), item]));
  let changed = list.length !== previous.length;
  const out = list.map((row, i) => {
    const old = byId.get(idOf(row));
    const keep = old !== undefined && json(old) === json(row);
    if (!keep || previous[i] !== old) changed = true;
    return keep ? old : row;
  });
  return changed ? out : previous;
}

/** Starts the four subscriptions. Returns stop(). */
export function startData({store = appStore, api = {songs: songsApi, jobs: jobsApi, devices: devicesApi, setlists: setlistsApi},
  onError = (what, err) => console.error(`[data] ${what} failed:`, err)} = {}) {
  const lib = store.library;
  const offs = [];
  const watch = (what, subscribe, apply) => {
    try {
      offs.push(subscribe(value => {
        try { apply(value); } catch (err) { onError(what, err); }
      }, err => onError(what, err)));
    } catch (err) {
      onError(what, err);
    }
  };

  watch('songs.list', api.songs.subscribeList, value => {
    batch(() => {
      lib.songs.value = nextSongs(lib.songs.peek(), value);
      if (!lib.loaded.peek()) lib.loaded.value = true;
    });
  });
  watch('jobs.listActive', api.jobs.subscribeActive, value => { lib.jobs.value = nextList(lib.jobs.peek(), value, job => job?.jobId); });
  watch('devices.list', api.devices.subscribeList, value => { lib.devices.value = nextList(lib.devices.peek(), value, device => device?.deviceId); });
  watch('setlists.list', api.setlists.subscribeList, value => { lib.setlists.value = nextList(lib.setlists.peek(), value, setlist => setlist?.id); });

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    for (const off of offs.splice(0)) { try { off?.(); } catch { /* already closed */ } }
  };
}
