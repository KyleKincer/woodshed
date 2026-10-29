// Fixture handlers for convex/setlists.ts (B3, architecture §6.8). Created by
// FX1 (1.9 had no setlists); BK6 owns the bodies. They mirror every function
// over the seed's `db.setlists` rows ({id, userId, name, songIds, createdAt,
// updatedAt, lastOpenedAt?}) with the server's rules and coded errors:
//   - names are tidied (whitespace runs collapse, ends trimmed) and must be
//     1–80 characters (`invalid`, field 'name');
//   - ≤ 100 lists (`setlist_limit`), ≤ 100 songs per list (`setlist_full`),
//     song ids deduplicated (the first occurrence keeps its place);
//   - every song id must be in `db.songs` (the fixture has one user), else
//     `not_found`, except in setSongs, which drops an id with no song (a song
//     deleted since the client read the list); a list that is not the user's
//     is `not_found`;
//   - new ids are `set-<n>` from a counter in the db, never reused after a remove;
//   - export-only accounts (fx-auth=export_only) cannot create or change lists,
//     but may `touch`; like the other handler modules, the queries do not refuse
//     a suspended account, and every mutation does.
import {db, clone, convexError, findSong} from './runtime.js';

export const LIMITS = Object.freeze({lists: 100, songs: 100, name: 80});

const fail = (code, message, data = {}) => { throw convexError({...data, code, message}); };

/** lib/auth.ts: suspended accounts can do nothing; export-only ones cannot change setlists (D10). */
function account({write = false} = {}) {
  const status = db.user?.status;
  if (status === 'suspended') fail('account_suspended', 'Your account is suspended. Contact the app owner for help.');
  if (write && status === 'export_only') fail('account_export_only', 'Your account is in export-only mode. Playback and library export remain available.');
  return db.user?._id ?? null;
}

const tidy = raw => String(raw ?? '').replace(/\s+/g, ' ').trim();

function cleanName(raw) {
  const name = tidy(raw);
  if (!name || name.length > LIMITS.name) fail('invalid', `Enter a setlist name of 1–${LIMITS.name} characters.`, {field: 'name'});
  return name;
}

const dedupe = ids => [...new Set(Array.isArray(ids) ? ids : [])];

function assertRoom(count) {
  if (count > LIMITS.songs) fail('setlist_full', `A setlist holds up to ${LIMITS.songs} songs.`, {limit: LIMITS.songs});
}

const notYourSong = () => fail('not_found', 'One of these songs is not in your library.');

function assertOwnedSongs(ids) {
  for (const id of ids) if (!findSong(id)) notYourSong();
}

const mine = () => (db.setlists ??= []).filter(l => l.userId === db.user?._id);

function ownList(id) {
  const row = mine().find(l => l.id === id);
  if (!row) fail('not_found', 'This setlist is not in your library.');
  return row;
}

/**
 * The next `set-<n>` id: deterministic per seed, and never reused after a
 * remove (like a server document id). `db.setlistSeq` is the highest n issued;
 * it is persisted with the rest of the db, and any live `set-<n>` row counts too.
 */
function nextId() {
  const live = (db.setlists ?? []).map(l => /^set-(\d+)$/.exec(l.id)?.[1]).filter(Boolean).map(Number);
  const n = Math.max(db.setlistSeq ?? 0, ...live) + 1;
  db.setlistSeq = n;
  return `set-${n}`;
}

const sameOrder = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

const toRow = l => ({id: l.id, name: l.name, count: l.songIds.length, songIds: clone(l.songIds), updatedAt: l.updatedAt, lastOpenedAt: l.lastOpenedAt ?? null});

export const handlers = {
  'setlists:list': () => {
    if (!db.user) return [];
    return mine()
      .map((l, i) => ({l, i}))
      // by_userId_and_updatedAt desc: equal updatedAt falls back to the newer row first.
      .sort((a, b) => b.l.updatedAt - a.l.updatedAt || (b.l.createdAt ?? 0) - (a.l.createdAt ?? 0) || b.i - a.i)
      .slice(0, LIMITS.lists)
      .map(({l}) => toRow(l));
  },

  'setlists:get': ({id}) => {
    const row = db.user ? mine().find(l => l.id === id) : null;
    return row ? {id: row.id, name: row.name, songIds: clone(row.songIds)} : null;
  },

  'setlists:create': ({name, songIds}) => {
    const userId = account({write: true});
    const clean = cleanName(name);
    if (mine().length >= LIMITS.lists) fail('setlist_limit', `You can keep up to ${LIMITS.lists} setlists.`, {limit: LIMITS.lists});
    const ids = dedupe(songIds);
    assertRoom(ids.length);
    assertOwnedSongs(ids);
    const now = Date.now();
    const id = nextId();
    db.setlists.push({id, userId, name: clean, songIds: ids, createdAt: now, updatedAt: now});
    return id;
  },

  'setlists:rename': ({id, name}) => {
    account({write: true});
    const row = ownList(id);
    const clean = cleanName(name);
    if (clean !== row.name) Object.assign(row, {name: clean, updatedAt: Date.now()});
    return null;
  },

  'setlists:setSongs': ({id, songIds}) => {
    account({write: true});
    const row = ownList(id);
    const wanted = dedupe(songIds);
    assertRoom(wanted.length);
    // An id with no song is dropped quietly (songs:remove strips deleted songs
    // from every list, so a stale reorder or Undo may still name one). The
    // fixture has one user, so there is no foreign song to refuse.
    const next = wanted.filter(songId => findSong(songId));
    if (!sameOrder(next, row.songIds)) Object.assign(row, {songIds: next, updatedAt: Date.now()});
    return clone(next);
  },

  'setlists:addSongs': ({id, songIds}) => {
    account({write: true});
    const row = ownList(id);
    const present = new Set(row.songIds);
    const added = dedupe(songIds).filter(songId => !present.has(songId));
    if (!added.length) return {added};
    assertRoom(row.songIds.length + added.length);
    assertOwnedSongs(added);
    Object.assign(row, {songIds: [...row.songIds, ...added], updatedAt: Date.now()});
    return {added: clone(added)};
  },

  'setlists:remove': ({id}) => {
    account({write: true});
    const row = ownList(id);
    db.setlists.splice(db.setlists.indexOf(row), 1);
    return null;
  },

  'setlists:touch': ({id}) => {
    account();
    ownList(id).lastOpenedAt = Date.now();
    return null;
  },
};
