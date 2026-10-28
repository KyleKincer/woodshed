// Setlists (B3; architecture §2.1, §6.8). One-line wrappers over the Convex
// `setlists` module; failures come out as ApiError (src/api/client.js) with the
// server's code: `invalid` (field 'name'), `setlist_limit`, `setlist_full`,
// `not_found`, `account_export_only`, `not_signed_in`. User-facing copy comes
// from src/app/error-copy.js, never from here.
//
// A list row: {id, name, count, songIds, updatedAt, lastOpenedAt: number|null},
// most recently changed first. `get` gives {id, name, songIds} or null.

import {mutation, query, subscribe} from './client.js';

/** The server's caps (convex/setlists.ts LIMITS): lists per user, songs per list, name length. */
export const LIMITS = Object.freeze({lists: 100, songs: 100, name: 80});

/** The name the server will store: whitespace runs collapse and the ends are trimmed. */
export const tidyName = raw => String(raw ?? '').replace(/\s+/g, ' ').trim();

/** True when the server will accept `raw` as a name (1–80 characters once tidied). */
export function isValidName(raw) {
  const name = tidyName(raw);
  return name.length > 0 && name.length <= LIMITS.name;
}

/** The caller's setlists (≤ 100). */
export const list = () => query('setlists:list', {});

/** Live `list` (data.js keeps it in store.library.setlists). Returns off(). */
export const subscribeList = (onValue, onError) => subscribe('setlists:list', {}, onValue, onError);

/** One setlist by the id from the URL; null when it is not one of the caller's lists. */
export const get = ({id}) => query('setlists:get', {id});

/** Live `get` for the /set/:id page. Returns off(). */
export const subscribeGet = ({id}, onValue, onError) => subscribe('setlists:get', {id}, onValue, onError);

/** A new list, optionally with songs in order (deduplicated). Resolves to its id. */
export const create = ({name, songIds}) => mutation('setlists:create', songIds === undefined ? {name} : {name, songIds});

/** Rename a list. */
export const rename = ({id, name}) => mutation('setlists:rename', {id, name});

/** Replace the order (reorder, remove, Undo). Resolves to the stored order. */
export const setSongs = ({id, songIds}) => mutation('setlists:setSongs', {id, songIds});

/** Append songs not yet in the list. Resolves to {added: songIds} (what an Undo takes out). */
export const addSongs = ({id, songIds}) => mutation('setlists:addSongs', {id, songIds});

/** Delete a list; its songs stay in the library. */
export const remove = ({id}) => mutation('setlists:remove', {id});

/** Record that the owner opened the list (/set/:id, or a Stage with ?set=). */
export const touch = ({id}) => mutation('setlists:touch', {id});
