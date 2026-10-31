// The song card menu and the selection menu (architecture §2.16, spec §2.5, §7.7, §7.8; D49).
//
//   cardMenuItems(song, ctx) → MenuItem[]
//     home.js finds this module by its contract path and calls it for the ⋯ button, a right-click, a 500 ms
//     long-press, Shift+F10 and the ContextMenu key on a card or list row (cards.js opens the items with Menu).
//     ctx: {router, store, registry, desktop, anchor, event} from home.js, plus optional {selection, account, toast,
//     form, platform} (tests and harnesses inject them; the defaults are the app's singletons).
//     Items: Select (first, D49: enters selection mode with this card selected; offered while a view renders the
//     selection, i.e. its bar is mounted: `selection.hosted`) · Practice ↵ (ends selection) · Edit details… E ·
//     Edit chart (when a part exists) · Edit map | Pin / Unpin · Share… · Add to setlist ▸ | Re-split… (desktop; on the
//     web disabled with the visible reason "Needs Woodshed for desktop") · Open original source ↗ (http sources) |
//     Delete… (danger). While selecting, a selected card's menu is the selection menu instead: Edit details of N
//     songs… · Pin / Unpin N songs · Add to setlist ▸ · Re-split N songs… (desktop) | Deselect (this card) · Done |
//     Delete N songs…. Edit details of N songs… keeps the selection (bulk Details' Done/Esc returns to it, §2.15).
//   addToSetlistItems(songIds, ctx) → MenuItem   'Add to setlist ▸': every setlist (a list that already holds every
//     one of the songs, or is full, is disabled with its reason), then "New setlist…" (a name field in a small Dialog;
//     the list is created with the songs). Adding shows an 8 s Undo toast (spec §7.8) that takes out exactly the songs
//     it added (`addSongs` returns {added}; `setSongs` with the list's current order minus those).
//   addToSetlist(setlist, songIds, deps?) / createSetlistWith(songIds, deps?)   the two actions, exported for tests
//
// Export-only (and suspended) accounts may pin (a setting) but not share, re-split or change setlists (D10): those
// items are disabled with "Paused on this account". Share… opens SH1's share dialog (src/share/share-dialog.js, wave
// 3a, resolved by its contract path) with {song, session: null}; until that file exists the item says "Not built yet".

import {store as appStore} from '../app/store.js';
import {account as appAccount} from '../app/account.js';
import {desktop as appDesktop} from '../app/desktop.js';
import {form as appForm, toast as appToast} from '../app/feedback.js';
import {describeError} from '../app/error-copy.js';
import * as setlistsApi from '../api/setlists.js';
import {deleteSongs, setPinned, sharedSelection} from './selection.js';
import {openResplitDialog} from './resplit-dialog.js';
import {COPY, UNDO_MS} from './library-actions.copy.js';

// Later-wave module (SH1, wave 3a), resolved by its contract path (Appendix C item 58).
const LATER = import.meta.glob(['../share/share-dialog.js']);
const SHARE_PATH = '../share/share-dialog.js';

const HTTP = /^https?:\/\//i;
const titleOf = song => song?.title || 'Untitled';
const enc = encodeURIComponent;

/** 'export_only' and 'suspended' accounts cannot share, re-split or change setlists (D10). */
const pausedOf = store => {
  const status = store?.session?.peek?.()?.status;
  return status === 'export_only' || status === 'suspended';
};

const errorText = (err, context = 'save') => describeError(err, {context}).sentence;

/** The http(s) link a song came from (a pasted URL or a Spotify link), or null. */
export function sourceUrl(song) {
  const value = song?.source?.value;
  if (typeof value !== 'string' || !HTTP.test(value)) return null;
  try { return new URL(value).href; } catch { return null; }
}

function deps(ctx = {}) {
  return {
    store: ctx.store ?? appStore,
    account: ctx.account ?? appAccount,
    desktop: ctx.desktop ?? appDesktop,
    router: ctx.router ?? null,
    selection: ctx.selection ?? sharedSelection(),
    toast: ctx.toast ?? appToast,
    form: ctx.form ?? appForm,
    api: ctx.setlists ?? setlistsApi,
    later: ctx.later ?? LATER,
    window: ctx.window ?? globalThis.window,
    deleteDeps: {
      ...(ctx.toast ? {toast: ctx.toast} : {}),
      ...(ctx.confirm ? {confirm: ctx.confirm} : {}),
      ...(ctx.songsApi ? {api: ctx.songsApi} : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Setlists

/** Adds the songs to a list, then offers the 8 s Undo. Resolves to the ids added. */
export async function addToSetlist(setlist, songIds, ctx = {}) {
  const d = deps(ctx);
  const ids = [...new Set(songIds)];
  const songs = d.store.library.songs.peek();
  let added;
  try {
    ({added} = await d.api.addSongs({id: setlist.id, songIds: ids}));
  } catch (err) {
    d.toast(errorText(err), {tone: 'error'});
    return [];
  }
  added = Array.isArray(added) ? added : [];
  const name = setlist.name || COPY.untitled;
  if (!added.length) { d.toast(COPY.alreadyIn(name), {key: 'lib-setlist'}); return []; }
  d.toast(added.length === 1 ? COPY.addedOne(titleOf(songs.get(added[0])), name) : COPY.added(added.length, name), {
    key: 'lib-setlist', durationMs: UNDO_MS,
    action: {label: COPY.undo, run: () => undoAdd(setlist.id, added, d)},
  });
  return added;
}

/** Undo of an add: the list's current order without exactly the songs that add put in. */
async function undoAdd(id, added, d) {
  try {
    const current = await d.api.get({id});
    if (!current) return;
    await d.api.setSongs({id, songIds: current.songIds.filter(songId => !added.includes(songId))});
  } catch (err) {
    d.toast(errorText(err), {tone: 'error'});
  }
}

/** "New setlist…": a name in a small Dialog; the list is created with the songs, then the 8 s Undo deletes it. */
export async function createSetlistWith(songIds, ctx = {}) {
  const d = deps(ctx);
  const ids = [...new Set(songIds)];
  let created = null;
  const values = await d.form({
    title: COPY.newSetlistTitle,
    body: COPY.newSetlistBody(ids.length),
    submitLabel: COPY.newSetlistSubmit,
    fields: [{name: 'name', label: COPY.newSetlistName, required: true, maxLength: setlistsApi.LIMITS.name, placeholder: COPY.newSetlistPlaceholder}],
    async onSubmit({name}) {
      if (!setlistsApi.isValidName(name)) throw Object.assign(new Error(`${COPY.newSetlistName} needs 1–${setlistsApi.LIMITS.name} characters.`), {field: 'name'});
      const tidy = setlistsApi.tidyName(name);
      try {
        created = {id: await d.api.create({name: tidy, songIds: ids}), name: tidy};
      } catch (err) {
        const message = errorText(err);
        throw Object.assign(new Error(message), err?.code === 'invalid' && err?.data?.field === 'name' ? {field: 'name'} : {});
      }
    },
  });
  if (!values || !created) return null;
  d.toast(COPY.createdWith(created.name, ids.length), {
    key: 'lib-setlist', durationMs: UNDO_MS,
    action: {
      label: COPY.undo,
      run: async () => {
        try { await d.api.remove({id: created.id}); } catch (err) { d.toast(errorText(err), {tone: 'error'}); }
      },
    },
  });
  return created.id;
}

export function addToSetlistItems(songIds, ctx = {}) {
  const d = deps(ctx);
  const ids = [...new Set(songIds)];
  const lists = Array.isArray(d.store.library.setlists.peek()) ? d.store.library.setlists.peek() : [];
  const paused = pausedOf(d.store);
  const items = lists.map(list => {
    const members = new Set(list.songIds ?? []);
    const missing = ids.filter(id => !members.has(id));
    const count = Number.isFinite(list.count) ? list.count : members.size;
    const full = count + missing.length > setlistsApi.LIMITS.songs;
    const reason = !missing.length ? COPY.inSetlist : full ? COPY.setlistFull : null;
    return {id: `setlist.add.${list.id}`, label: COPY.setlistRow(list.name || COPY.untitled, count), icon: 'list-music', reason,
      run: () => addToSetlist(list, ids, ctx)};
  });
  if (items.length) items.push({type: 'separator'});
  const atLimit = lists.length >= setlistsApi.LIMITS.lists;
  items.push({id: 'setlist.new', label: COPY.newSetlist, icon: 'plus', reason: atLimit ? COPY.setlistsFull : null,
    run: () => createSetlistWith(ids, ctx)});
  return {id: 'card.addToSetlist', type: 'submenu', label: COPY.addToSetlist, icon: 'list-music', items,
    reason: paused ? COPY.pausedAccount : null};
}

// ---------------------------------------------------------------------------------------------------------------
// The menus

function shareItem(song, d) {
  const load = d.later?.[SHARE_PATH];
  const paused = pausedOf(d.store);
  return {
    id: 'card.share', label: COPY.share, icon: 'share-2',
    reason: paused ? COPY.pausedAccount : !load ? COPY.notBuilt : null,
    run: () => {
      if (!load) return;
      Promise.resolve().then(load).then(mod => mod.openShareDialog({song, session: null}))
        .catch(err => console.error('[library] the share dialog could not open', err));
    },
  };
}

function resplitItem(songIds, label, d) {
  const reason = !d.desktop?.available ? COPY.needsDesktop : pausedOf(d.store) ? COPY.pausedAccount : null;
  return {id: 'card.resplit', label, icon: 'refresh-cw', reason,
    run: () => openResplitDialog({songIds, router: d.router, desktop: d.desktop, store: d.store, account: d.account})};
}

function pinItem(songIds, labels, d) {
  const pins = d.account.pins?.peek?.() ?? [];
  const all = songIds.length > 0 && songIds.every(id => pins.includes(id));
  return {id: all ? 'card.unpin' : 'card.pin', label: all ? labels.unpin : labels.pin, icon: all ? 'pin-off' : 'pin',
    run: () => setPinned(songIds, !all, {account: d.account, toast: d.toast, songs: d.store.library.songs})};
}

function selectionMenuItems(song, d, ctx) {
  const sel = d.selection;
  const ids = sel.list();
  const n = ids.length;
  const songs = d.store.library.songs.peek();
  const go = path => d.router?.navigate?.(path);
  return [
    {id: 'selection.details', label: COPY.editDetailsMany(n), icon: 'pencil',
      run: () => go(`/edit/details?ids=${ids.slice(0, sel.max).map(enc).join(',')}`)},
    pinItem(ids, {pin: COPY.pinMany(n), unpin: COPY.unpinMany(n)}, d),
    addToSetlistItems(ids, ctx),
    ...(d.desktop?.available ? [resplitItem(ids, COPY.resplitMany(n), d)] : []),
    {type: 'separator'},
    {id: 'selection.deselect', label: COPY.deselect, icon: 'x', run: () => { if (sel.has(song.id)) sel.toggle(song.id); }},
    {id: 'selection.done', label: COPY.done, icon: 'check', run: () => sel.clear()},
    {type: 'separator'},
    {id: 'selection.delete', label: COPY.deleteMany(n), icon: 'trash-2', danger: true,
      run: async () => {
        const result = await deleteSongs(ids.map(id => songs.get(id)).filter(Boolean), d.deleteDeps);
        if (!result) return;
        if (result.failed.length) sel.set(result.failed.map(f => f.id));
        else sel.clear();
      }},
  ];
}

export function cardMenuItems(song, ctx = {}) {
  if (!song?.id) return [];
  const d = deps(ctx);
  const sel = d.selection;
  // Selection is offered only while a view renders it (its bar is mounted); otherwise it would be invisible.
  const hosted = !!sel.hosted?.peek?.();
  if (hosted && sel.active.peek() && sel.has(song.id)) return selectionMenuItems(song, d, ctx);
  const id = enc(song.id);
  const go = path => d.router?.navigate?.(path);
  const url = sourceUrl(song);
  const items = [
    ...(hosted ? [{id: 'card.select', label: COPY.select, icon: 'check', run: () => sel.start(song.id)}, {type: 'separator'}] : []),
    {id: 'card.practice', label: COPY.practice, icon: 'play', kbd: 'Enter', run: () => { sel.clear(); go(`/s/${id}`); }},
    {id: 'card.editDetails', label: COPY.editDetails, icon: 'pencil', kbd: 'KeyE', run: () => go(`/s/${id}/edit/details`)},
    ...(song.hasChart ? [{id: 'card.editChart', label: COPY.editChart, icon: 'file-music', run: () => go(`/s/${id}/edit/chart`)}] : []),
    {id: 'card.editMap', label: COPY.editMap, icon: 'grid-3x3', run: () => go(`/s/${id}/edit/map`)},
    {type: 'separator'},
    pinItem([song.id], {pin: COPY.pin, unpin: COPY.unpin}, d),
    shareItem(song, d),
    // Export needs the decoded audio: the song's Stage loads it, then opens the dialog (?export=1).
    {id: 'card.export', label: COPY.exportSong, icon: 'download', run: () => { sel.clear(); go(`/s/${id}?export=1`); }},
    addToSetlistItems([song.id], ctx),
    {type: 'separator'},
    resplitItem([song.id], COPY.resplit, d),
    ...(url ? [{id: 'card.openSource', label: COPY.openSource, icon: 'external-link',
      run: () => d.window?.open?.(url, '_blank', 'noopener,noreferrer')}] : []),
    {type: 'separator'},
    {id: 'card.delete', label: COPY.delete, icon: 'trash-2', danger: true, run: () => deleteSongs([song], d.deleteDeps)},
  ];
  return items;
}
