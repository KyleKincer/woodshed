// Library selection mode (architecture §2.16, spec §2.6, §7.7, §7.8) and the actions it shares with the card menu:
// bulk delete with its Dialog and pinning with the 8 s Undo toast.
//
//   createSelection({max = 100, order}) → Selection
//     Selection = {ids: ReadonlySignal<Set<id>>, active: ReadonlySignal<boolean>, count: ReadonlySignal<number>,
//                  limited: ReadonlySignal<boolean>, hosted: ReadonlySignal<boolean>, has(id), toggle(id),
//                  range(id, order?), selectAll(ids?), start(id?), set(ids), prune(existing), clear(), setOrder(fn),
//                  mountBar(el, ctx) → {el, deleteSelected(), destroy()}}
//     `order()` gives the visible songs' ids in visual order: Shift-click ranges and ⌘A (selectAll() with no list) use
//     it. The cap is `max` ("Up to 100 at a time"): a toggle, a range or ⌘A that would pass it adds what fits (a toggle:
//     nothing) and sets `limited` until the next change. Selection mode (`active`) starts with the first toggle, range,
//     selectAll or start() and ends with clear() (Done, Esc, opening a song). It stays on with nothing selected, and
//     it survives the trip to bulk Details (/edit/details?ids=…, whose Done/Esc goes back to the Library selection,
//     §2.15), so leaving the Library does not clear it. `hosted` is true while a bar is mounted, i.e. while a view
//     renders the selection: the card menu offers Select (and turns into the selection menu) only then.
//   sharedSelection() → the app's one Selection (created on first use): the Library view and the card menu share it.
//   selectionClick(selection, songId, event, order?) → boolean
//     A card click: ⌘/Ctrl-click toggles and Shift-click ranges (both enter selection mode); while selecting, a plain
//     click toggles. True when the click was a selection gesture (the caller does not open the song).
//   selectionContext(selection, {deleteSelected, order}) → the 'library' command context's selection part
//     {selecting, exitSelection(), select(), selectAll(), deleteSelected()} (library.select, .selectAll,
//     .deleteSelected and app.escape, src/library/commands.js).
//   deleteSongs(songs, deps?) → Promise<{deleted: id[], failed: [{id, title, error}]}|null>
//     The Dialog (spec §2.6 copy), then sequential songs.remove with progress in one toast and a partial-failure report
//     (an error toast with Details); null when the Dialog was cancelled.
//   setPinned(songIds, pin, deps?) → Promise<boolean>
//     Pins (or unpins) the songs through account.patch, within the 12-pin limit, then the 8 s Undo toast; Undo takes
//     out exactly what was pinned, or puts each unpinned song back where it was.
//
// The bar (mountBar): a 56 px floating toolbar at the bottom centre, "3 selected · Edit details · Pin · Re-split
// (desktop) · Delete · Done". Edit details opens /edit/details?ids=a,b,c (D34), Re-split opens the Re-split dialog
// for the selected songs, Delete runs deleteSongs. It is hidden while selection mode is off; it lifts the toast
// region clear of itself (selection.css). Re-split is hidden on the web and disabled with "Paused on this account"
// for export-only and suspended accounts (D10), as in the card menu.

import '../styles/views/library/selection.css';
import {batch, computed, effect, readonly, signal, store as appStore, untracked} from '../app/store.js';
import {account as appAccount, PINS_FULL} from '../app/account.js';
import {announce as appAnnounce, confirm as appConfirm, toast as appToast} from '../app/feedback.js';
import {desktop as appDesktop} from '../app/desktop.js';
import {describeError} from '../app/error-copy.js';
import * as songsApi from '../api/songs.js';
import {MAX_PINS} from '../../convex/lib/presets.ts';
import {Button} from '../ui/button.js';
import {h} from '../ui/h.js';
import {failureReport, openResplitDialog} from './resplit-dialog.js';
import {COPY, MAX_SELECTION, UNDO_MS} from './library-actions.copy.js';

export {MAX_SELECTION, UNDO_MS};

const sameSet = (a, b) => a === b || (a.size === b.size && [...a].every(id => b.has(id)));
const listOf = value => (Array.isArray(value) ? value : value instanceof Set ? [...value] : value ? [...value] : []);
const titleOf = song => song?.title || 'Untitled';

// ---------------------------------------------------------------------------------------------------------------
// The model

export function createSelection({max = MAX_SELECTION, order = () => []} = {}) {
  if (!Number.isInteger(max) || max < 1) throw new RangeError('createSelection: max must be a positive integer');
  const ids = signal(new Set(), {equals: sameSet});
  const active = signal(false);
  const limited = signal(false);
  const hosts = signal(0);
  const hosted = computed(() => hosts.value > 0);
  const count = computed(() => ids.value.size);
  let anchor = null;
  let orderOf = typeof order === 'function' ? order : () => [];

  const write = (next, {limit = false, on = true} = {}) => batch(() => {
    ids.value = next;
    limited.value = limit;
    if (on) active.value = true;
  });

  const selection = {
    ids: readonly(ids),
    active: readonly(active),
    count,
    limited: readonly(limited),
    hosted,
    max,
    has: id => ids.peek().has(id),
    /** The selected ids in the visible order, then any others (selected, then filtered out). */
    list() {
      const set = ids.peek();
      const seen = listOf(orderOf()).filter(id => set.has(id));
      return [...seen, ...[...set].filter(id => !seen.includes(id))];
    },
    setOrder(fn) { orderOf = typeof fn === 'function' ? fn : () => []; },
    toggle(id) {
      if (id == null) return false;
      const next = new Set(ids.peek());
      if (next.has(id)) {
        next.delete(id);
        anchor = id;
        write(next);
        return true;
      }
      if (next.size >= max) { batch(() => { limited.value = true; active.value = true; }); return false; }
      next.add(id);
      anchor = id;
      write(next);
      return true;
    },
    range(id, list = orderOf()) {
      const visible = listOf(list);
      const from = anchor != null ? visible.indexOf(anchor) : -1;
      const to = visible.indexOf(id);
      if (from < 0 || to < 0) return selection.toggle(id);
      const [a, b] = from <= to ? [from, to] : [to, from];
      const next = new Set(ids.peek());
      let limit = false;
      for (const each of visible.slice(a, b + 1)) {
        if (next.has(each)) continue;
        if (next.size >= max) { limit = true; break; }
        next.add(each);
      }
      write(next, {limit});
      return true;
    },
    selectAll(list = orderOf()) {
      const visible = listOf(list);
      write(new Set(visible.slice(0, max)), {limit: visible.length > max});
      anchor = visible[0] ?? null;
    },
    start(id = null) {
      if (id == null) { active.value = true; return; }
      if (!ids.peek().has(id)) selection.toggle(id);
      else active.value = true;
    },
    set(list) {
      const all = listOf(list);
      write(new Set(all.slice(0, max)), {limit: all.length > max, on: active.peek() || all.length > 0});
    },
    /** Drops ids whose song no longer exists (deleted here or on another device). */
    prune(existing) {
      const has = existing instanceof Map || existing instanceof Set ? k => existing.has(k) : k => listOf(existing).includes(k);
      const current = ids.peek();
      const next = new Set([...current].filter(has));
      if (next.size !== current.size) ids.value = next;
    },
    clear() {
      anchor = null;
      batch(() => { ids.value = new Set(); limited.value = false; active.value = false; });
    },
    mountBar(el, ctx = {}) {
      const bar = mountSelectionBar(el, selection, ctx);
      hosts.value += 1;
      let gone = false;
      const destroy = bar.destroy;
      bar.destroy = () => {
        if (gone) return;
        gone = true;
        hosts.value -= 1;
        destroy();
      };
      return bar;
    },
  };
  return selection;
}

let shared = null;
/** The app's one Selection: home.js renders it and the card menu's Select starts it. */
export function sharedSelection() {
  shared ??= createSelection();
  return shared;
}

/** A card click while selecting, or with ⌘/Ctrl/Shift; true when it was a selection gesture. */
export function selectionClick(selection, songId, event, order) {
  if (!selection || songId == null) return false;
  if (event && event.button !== undefined && event.button !== 0) return false;
  if (event?.shiftKey) { selection.range(songId, order); return true; }
  if (event?.metaKey || event?.ctrlKey) { selection.toggle(songId); return true; }
  if (selection.active.peek()) { selection.toggle(songId); return true; }
  return false;
}

/** The 'library' command context's selection part (library.select/selectAll/deleteSelected, app.escape). */
export function selectionContext(selection, {deleteSelected = null, order = null, announce = appAnnounce} = {}) {
  return {
    get selecting() { return selection.active.peek(); },
    exitSelection() {
      if (!selection.active.peek()) return false;
      selection.clear();
      announce(COPY.selectingOff, {key: 'lib-selecting'});
      return true;
    },
    select() {
      selection.start();
      announce(COPY.selectingOn, {key: 'lib-selecting'});
    },
    selectAll() { selection.selectAll(order ? order() : undefined); },
    deleteSelected() { return deleteSelected ? deleteSelected() : null; },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Delete (spec §2.6: confirmed by a Dialog; no undo)

/**
 * Asks, then removes the songs one after another (sequential `songs.remove`), with progress in one toast, then
 * reports: every song deleted (an ok toast), or a partial failure (an error toast naming the songs left, with Details).
 */
export async function deleteSongs(songs, {api = songsApi, confirm: ask = appConfirm, toast = appToast, announce = appAnnounce} = {}) {
  const list = listOf(songs).filter(s => s?.id);
  if (!list.length) return null;
  const one = list.length === 1;
  const ok = await ask({
    title: one ? COPY.deleteTitleOne(titleOf(list[0])) : COPY.deleteTitle(list.length),
    body: one ? COPY.deleteBodyOne : COPY.deleteBody,
    confirmLabel: one ? COPY.deleteConfirmOne : COPY.deleteConfirm(list.length),
    danger: true,
  });
  if (!ok) return null;
  const deleted = [], failed = [];
  const progress = one ? null : toast(COPY.deleting(1, list.length), {key: 'lib-delete', durationMs: Infinity});
  for (const [i, song] of list.entries()) {
    progress?.update?.(COPY.deleting(i + 1, list.length));
    try {
      await api.remove({id: song.id});
      deleted.push(song.id);
    } catch (error) {
      failed.push({id: song.id, title: titleOf(song), error});
    }
  }
  progress?.dismiss?.();
  if (!failed.length) {
    const text = one ? COPY.deletedOne(titleOf(list[0])) : COPY.deleted(deleted.length);
    toast(text, {tone: 'ok', key: 'lib-delete'});
    announce(text, {key: 'lib-delete'});
  } else {
    const text = one ? COPY.deleteFailedOne(failed[0].title) : `${COPY.deletePartial(deleted.length, list.length)} ${COPY.deleteFailedNamed(failed.map(f => f.title))}`;
    toast(text, {tone: 'error', key: 'lib-delete',
      action: {label: COPY.details, run: () => failureReport(failed, {title: COPY.deleteFailedNamed(failed.map(f => f.title)), context: 'save'})}});
  }
  return {deleted, failed};
}

// ---------------------------------------------------------------------------------------------------------------
// Pins (8 s Undo toast, spec §7.8)

const errorToast = (toast, err, context = 'save') => toast(describeError(err, {context}).sentence, {tone: 'error'});

/** Pins or unpins songs, then offers Undo for 8 s. Resolves true when the pins changed. */
export async function setPinned(songIds, pin, {account = appAccount, toast = appToast, songs = appStore.library.songs} = {}) {
  const ids = [...new Set(listOf(songIds))];
  if (!ids.length) return false;
  const current = account.pins.peek() ?? [];
  const title = id => titleOf(songs.peek?.()?.get?.(id));
  const patch = async next => {
    try { await account.patch({pins: next}); return true; } catch (err) {
      if (err?.code === 'pins_full') toast(PINS_FULL, {key: 'pins-full'});
      else errorToast(toast, err);
      return false;
    }
  };

  if (pin) {
    const add = ids.filter(id => !current.includes(id));
    if (!add.length) return false;
    const room = MAX_PINS - current.length;
    if (add.length > room) {
      toast(room > 0 ? COPY.pinsRoom(MAX_PINS, room) : PINS_FULL, {key: 'pins-full'});
      return false;
    }
    if (!(await patch([...current, ...add]))) return false;
    toast(add.length === 1 ? COPY.pinnedOne(title(add[0])) : COPY.pinned(add.length), {
      key: 'lib-pins', durationMs: UNDO_MS,
      action: {label: COPY.undo, run: () => patch((account.pins.peek() ?? []).filter(id => !add.includes(id)))},
    });
    return true;
  }

  const removed = current.map((id, index) => ({id, index})).filter(p => ids.includes(p.id));
  if (!removed.length) return false;
  if (!(await patch(current.filter(id => !ids.includes(id))))) return false;
  toast(removed.length === 1 ? COPY.unpinnedOne(title(removed[0].id)) : COPY.unpinned(removed.length), {
    key: 'lib-pins', durationMs: UNDO_MS,
    action: {
      label: COPY.undo,
      run: () => {
        const now = (account.pins.peek() ?? []).filter(id => !removed.some(r => r.id === id));
        for (const r of removed) now.splice(Math.min(r.index, now.length), 0, r.id);
        return patch(now.slice(0, MAX_PINS));
      },
    },
  });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// The floating bar

/**
 * Mounts the bar into `el`. ctx: {router, store, account, desktop, toast, confirm, announce, api}. The bar follows the
 * selection and the library (deleted songs drop out of the selection).
 */
export function mountSelectionBar(el, selection, ctx = {}) {
  const store = ctx.store ?? appStore;
  const account = ctx.account ?? appAccount;
  const desktop = ctx.desktop ?? appDesktop;
  const router = ctx.router ?? null;
  const toast = ctx.toast ?? appToast;
  const announce = ctx.announce ?? appAnnounce;
  const deps = {api: ctx.api ?? songsApi, confirm: ctx.confirm ?? appConfirm, toast, announce};

  const selectedSongs = () => {
    const songs = store.library.songs.peek();
    return selection.list().map(id => songs.get(id)).filter(Boolean);
  };

  const countEl = h('span', {class: 'lib-selbar-count tabular'});
  const capEl = h('span', {class: 'lib-selbar-cap'}, COPY.cap);
  const details = Button({label: COPY.barEditDetails, icon: 'pencil', variant: 'quiet', className: 'lib-selbar-action',
    onClick: () => {
      const ids = selection.list().slice(0, MAX_SELECTION);
      if (!ids.length) return;
      // The selection stays: bulk Details' Done/Esc goes back to it (§2.15).
      router?.navigate?.(`/edit/details?ids=${ids.map(encodeURIComponent).join(',')}`);
    }});
  const pin = Button({label: COPY.barPin, icon: 'pin', variant: 'quiet', className: 'lib-selbar-action',
    onClick: () => {
      const ids = selection.list();
      const pins = account.pins.peek() ?? [];
      void setPinned(ids, !ids.every(id => pins.includes(id)), {account, toast, songs: store.library.songs});
    }});
  const resplit = Button({label: COPY.barResplit, icon: 'refresh-cw', variant: 'quiet', className: 'lib-selbar-action',
    onClick: () => {
      const ids = selection.list();
      if (ids.length) void openResplitDialog({songIds: ids, router, desktop, store, account});
    }});
  const remove = Button({label: COPY.barDelete, icon: 'trash-2', variant: 'quiet', tone: 'danger', className: 'lib-selbar-action',
    onClick: () => { void deleteSelected(); }});
  const done = Button({label: COPY.barDone, variant: 'primary', className: 'lib-selbar-done',
    onClick: () => { selection.clear(); announce(COPY.selectingOff, {key: 'lib-selecting'}); }});
  const primitives = [details, pin, resplit, remove, done];

  // The bar floats over the bottom of the grid by design (like the toast region): the cards under it scroll out
  // from beneath it (selection.css pads the page's end), so the fixture's overlap check leaves it out.
  const bar = h('div', {class: 'lib-selbar', attrs: {role: 'toolbar', 'aria-label': COPY.barLabel, 'data-testid': 'selection-bar',
    'data-structure-allow': 'overlap'}},
    h('span', {class: 'lib-selbar-status'}, countEl, capEl),
    h('span', {class: 'lib-selbar-actions'}, details.el, pin.el, resplit.el, remove.el),
    done.el);
  bar.hidden = true;
  el.append(bar);

  let busy = false;
  async function deleteSelected() {
    const songs = selectedSongs();
    if (busy || !songs.length) return null;
    busy = true;
    try {
      const result = await deleteSongs(songs, deps);
      if (result) {
        const left = result.failed.map(f => f.id);
        if (left.length) selection.set(left);
        else selection.clear();
      }
      return result;
    } finally {
      busy = false;
    }
  }

  let lastCount = null;
  const offs = [
    effect(() => {
      const on = selection.active.value;
      const n = selection.count.value;
      const limit = selection.limited.value;
      const pins = account.pins.value ?? [];
      const status = store.session?.value?.status;
      const ids = [...selection.ids.value];
      untracked(() => {
        bar.hidden = !on;
        countEl.textContent = n ? COPY.selected(n) : COPY.noneSelected;
        capEl.hidden = !(limit || n >= selection.max);
        const none = n === 0;
        const allPinned = !none && ids.every(id => pins.includes(id));
        pin.set({label: allPinned ? COPY.barUnpin : COPY.barPin, icon: allPinned ? 'pin-off' : 'pin', disabled: none});
        details.set({disabled: none});
        remove.set({disabled: none});
        const paused = status === 'export_only' || status === 'suspended';
        resplit.set({disabled: none, disabledReason: paused ? COPY.pausedAccount : null, title: paused ? COPY.pausedAccount : null});
        resplit.el.hidden = !desktop?.available;
        if (on && n !== lastCount) {
          announce(n ? COPY.selected(n) : COPY.noneSelected, {key: 'lib-selected'});
          if (limit) announce(COPY.cap, {key: 'lib-cap'});
        }
        lastCount = on ? n : null;
      });
    }),
    // Songs deleted elsewhere leave the selection.
    effect(() => {
      const songs = store.library.songs.value;
      if (store.library.loaded.value) untracked(() => selection.prune(songs));
    }),
  ];

  return {
    el: bar,
    deleteSelected,
    destroy() {
      for (const off of offs) off();
      for (const p of primitives) p.destroy?.();
      bar.remove();
    },
  };
}
