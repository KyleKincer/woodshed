// The setlist page (route `setlist`, /set/:id; architecture §2.16, §6.8; spec §1.2 B3, §7.8).
//
//   mount(el, match, ctx) → Promise<{update(match), unmount()}>   resolves once the list (or its absence) is shown,
//                                                                 so html[data-view-ready=setlist] means rendered
//
// - The list's songs in order: position, cover, title and artist (a link to /s/<song>?set=<id>), length, a move
//   handle and ✕ (remove). "Play from the top" opens /s/<first>?set=<id>; the Stage then walks the list
//   (setlist.next / setlist.prev). Opening the page calls setlists.touch.
// - Reorder by dragging the handle (pointer events: mouse, pen and touch) or with ⌥↑ / ⌥↓ on a focused row; each
//   move is announced ("Glasshouse moved to 3 of 5") and saved with setlists.setSongs, whose returned order is the
//   truth (it may be shorter: songs deleted since are dropped). The focused row is never moved in the DOM (its
//   neighbours move around it), so focus stays put.
// - Remove: the row goes at once and an 8 s Undo toast puts the song back where it was (spec §7.8).
// - Rename: inline (Enter saves, Esc cancels; 1–80 characters). Delete setlist… asks first, then returns to the
//   Library. Export-only and suspended accounts see the list read-only (D10), with a note.
// - Edge states: loading (a row skeleton), "This setlist isn't here" (deleted, or not this account's) and the empty
//   list, each with a way back to the Library.
//
// Context: ctx {router, store, feedback} (the app's singletons by default) and ctx.api (setlists API, tests).

import '../styles/views/library/setlists.css';
import {effect, signal, store as appStore, untracked} from '../app/store.js';
import * as appFeedback from '../app/feedback.js';
import {describeError} from '../app/error-copy.js';
import * as setlistsApi from '../api/setlists.js';
import {Button, IconButton} from '../ui/button.js';
import {EmptyState} from '../ui/empty.js';
import {h, reconcileList} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {Skeleton} from '../ui/skeleton.js';
import {Cover} from './cards.js';
import {artistLabel, formatDuration} from './song-labels.js';
import {COPY, UNDO_MS} from './library-actions.copy.js';

/** How long mount waits for the first answer before showing the loading state anyway. */
export const FIRST_DATA_MS = 4000;
/** Pointer travel before a press on the handle becomes a drag. */
export const DRAG_SLOP_PX = 4;
/** Distance from the scroller's edge at which a drag scrolls it. */
export const EDGE_SCROLL_PX = 48;

const titleOf = song => song?.title || 'Untitled';
const enc = encodeURIComponent;

/** Moves `id` by `delta` places in `order`; the same array when it cannot move. */
export function moveId(order, id, delta) {
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** `order` with `id` put back at `index` (clamped), unless it is already there. */
export function reinsert(order, id, index) {
  if (order.includes(id)) return order;
  const next = [...order];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, id);
  return next;
}

export async function mount(el, match, ctx = {}) {
  const doc = el.ownerDocument;
  const store = ctx.store ?? appStore;
  const router = ctx.router ?? null;
  const feedback = {...appFeedback, ...(ctx.feedback ?? {})};
  const api = ctx.api ?? setlistsApi;
  const navigate = (...args) => router?.navigate?.(...args);

  let id = match?.params?.id ?? null;
  const ac = new AbortController();
  const listen = (target, type, fn, opts = {}) => target.addEventListener(type, fn, {...opts, signal: ac.signal});
  const disposers = [];
  const primitives = [];

  // ---------- state ----------
  const data = signal(undefined);      // undefined: loading; null: not found; {id, name, songIds}
  const order = signal(null);          // the order shown (optimistic while a write is in flight)
  const renaming = signal(false);
  let pending = 0;                     // writes in flight: subscription values wait until they settle
  let latest = undefined;              // the newest subscription value

  const paused = () => {
    const status = store.session?.peek?.()?.status;
    return status === 'export_only' || status === 'suspended';
  };

  // ---------- frame ----------
  const scroller = h('div', {class: 'lib-scroller set-scroller', attrs: {'data-scroller': ''}});
  const content = h('div', {class: 'app-content set-page'});
  scroller.append(content);
  el.replaceChildren(scroller);

  const back = h('a', {class: 'set-back', attrs: {href: '/'}}, icon('chevron-left', {size: 20}), h('span', {}, COPY.backToLibrary));
  listen(back, 'click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate('/');
  });

  const kicker = h('p', {class: 'set-kicker'}, COPY.setlistKicker);
  const title = h('h1', {class: 'set-title selectable', id: 'set-title'});
  const meta = h('p', {class: 'set-meta tabular'});
  const note = h('p', {class: 'set-note', hidden: true}, COPY.readOnly);

  // rename (inline)
  const renameInput = h('input', {class: 'set-rename-input', id: 'set-rename-input', type: 'text', maxLength: setlistsApi.LIMITS.name,
    autocomplete: 'off', attrs: {'data-consume-keys': 'Escape', 'aria-describedby': 'set-rename-error'}});
  const renameError = h('p', {class: 'set-rename-error', id: 'set-rename-error', role: 'alert', hidden: true});
  const renameSave = Button({label: COPY.renameSave, variant: 'primary', type: 'submit'});
  const renameCancel = Button({label: COPY.renameCancel, variant: 'quiet', onClick: () => stopRename({focus: true})});
  primitives.push(renameSave, renameCancel);
  const renameForm = h('form', {class: 'set-rename', hidden: true, attrs: {novalidate: ''}},
    h('label', {class: 'set-rename-label', for: renameInput.id}, COPY.renameLabel),
    h('div', {class: 'set-rename-row'}, renameInput, renameSave.el, renameCancel.el), renameError);

  const play = Button({label: COPY.play, icon: 'play', variant: 'primary', size: 'lg', className: 'set-play', onClick: () => playFromTop()});
  const rename = Button({label: COPY.rename, icon: 'pencil', variant: 'secondary', className: 'set-rename-button', onClick: () => startRename()});
  const remove = Button({label: COPY.deleteSetlist, icon: 'trash-2', variant: 'quiet', className: 'set-delete', onClick: () => deleteList()});
  primitives.push(play, rename, remove);
  const actions = h('div', {class: 'set-actions'}, play.el, rename.el, remove.el);
  const header = h('header', {class: 'set-header'}, kicker, title, renameForm, meta, actions, note);

  const list = h('ol', {class: 'set-list'});
  const hint = h('p', {class: 'sr-only', id: 'set-move-hint'}, COPY.moveHint);
  const edge = h('div', {class: 'set-edge'});
  const body = h('section', {class: 'set-body', attrs: {'aria-labelledby': title.id}}, hint, list, edge);
  content.append(back, header, body);

  // ---------- rows ----------
  const rows = new Map();   // songId → row entry

  function Row(songId) {
    const cover = Cover({className: 'set-thumb'});
    const pos = h('span', {class: 'set-pos tabular', attrs: {'aria-hidden': 'true'}});
    const name = h('span', {class: 'set-song-title'});
    const artist = h('span', {class: 'set-song-artist'});
    const open = h('a', {class: 'set-open'}, cover.el, h('span', {class: 'set-song-text'}, name, artist));
    const length = h('span', {class: 'set-length tabular'});
    const handle = h('button', {class: 'set-handle', type: 'button', attrs: {'aria-describedby': hint.id}},
      h('span', {class: 'set-handle-grip', attrs: {'aria-hidden': 'true'}}));
    const drop = IconButton({label: 'Remove', icon: 'x', className: 'set-remove', onClick: () => removeSong(songId)});
    const li = h('li', {class: 'set-row', dataset: {songId}}, pos, handle, open, length, drop.el);
    const entry = {
      el: li, songId,
      update() {},   // reconcileList's hook; render() below fills the row
      render({song, index, count, listName, readOnly}) {
        const t = titleOf(song);
        pos.textContent = String(index + 1);
        name.textContent = t;
        const a = artistLabel(song);
        artist.textContent = a;
        artist.hidden = !a;
        length.textContent = formatDuration(song.duration);
        open.setAttribute('href', `/s/${enc(songId)}?set=${enc(id)}`);
        open.setAttribute('aria-label', `${COPY.openSong(t)}, ${COPY.position(index + 1, count)}`);
        open.dataset.focusKey = `setsong:${songId}`;
        handle.setAttribute('aria-label', COPY.moveHandle(t));
        handle.disabled = readOnly || count < 2;
        drop.set({label: COPY.removeSong(t, listName), disabled: readOnly});
        cover.set(song, song);
      },
      destroy() { drop.destroy(); rows.delete(songId); },
    };
    listen(open, 'click', e => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(`/s/${enc(songId)}?set=${enc(id)}`);
    });
    listen(handle, 'pointerdown', e => startDrag(e, entry));
    rows.set(songId, entry);
    return entry;
  }

  // ---------- render ----------
  let edgeState = null;
  let skeleton = null;
  const visibleOrder = () => {
    const songs = store.library.songs.peek();
    return (order.peek() ?? []).filter(songId => songs.has(songId));
  };

  function showEdge(kind) {
    if (edgeState?.kind === kind) return;
    edgeState?.destroy?.();
    skeleton?.destroy(); skeleton = null;
    edge.replaceChildren();
    edgeState = null;
    if (!kind) { edge.hidden = true; return; }
    edge.hidden = false;
    if (kind === 'loading') {
      skeleton = Skeleton({shape: 'row', count: 5, label: COPY.loading});
      edge.append(skeleton.el);
      edgeState = {kind, destroy() {}};
      return;
    }
    const node = kind === 'missing'
      ? EmptyState({title: COPY.missingTitle, body: COPY.missingBody, headingLevel: 2,
        actions: [{label: COPY.missingAction, href: '/', variant: 'primary', onClick: e => { e.preventDefault(); navigate('/'); }}]})
      : EmptyState({title: COPY.emptyTitle, body: COPY.emptyBody, headingLevel: 2,
        actions: [{label: COPY.emptyAction, href: '/', variant: 'secondary', onClick: e => { e.preventDefault(); navigate('/'); }}]});
    edge.append(node.el);
    edgeState = {kind, destroy: () => node.destroy()};
  }

  disposers.push(effect(() => {
    const value = data.value;
    const shown = order.value;
    const songs = store.library.songs.value;
    const loaded = store.library.loaded.value;
    const editing = renaming.value;
    void store.session?.value;
    untracked(() => {
      const readOnly = paused();
      if (value === undefined || (value && !loaded)) {
        header.hidden = true;
        list.hidden = true;
        content.dataset.state = 'loading';
        showEdge('loading');
        return;
      }
      if (value === null) {
        header.hidden = true;
        list.hidden = true;
        back.hidden = false;
        content.dataset.state = 'missing';
        showEdge('missing');
        return;
      }
      const name = value.name || COPY.untitled;
      const ids = (shown ?? value.songIds).filter(songId => songs.has(songId));
      header.hidden = false;
      title.hidden = editing;
      renameForm.hidden = !editing;
      actions.hidden = editing;
      title.textContent = name;
      list.setAttribute('aria-label', COPY.songsLabel(name));
      const seconds = ids.reduce((sum, songId) => sum + (Number(songs.get(songId)?.duration) || 0), 0);
      meta.textContent = ids.length ? `${COPY.setlistCount(ids.length)} · ${COPY.setlistLength(seconds)}` : COPY.setlistCount(0);
      note.hidden = !readOnly;
      play.set({disabled: !ids.length});
      rename.set({disabled: readOnly});
      remove.set({disabled: readOnly});
      list.hidden = !ids.length;
      content.dataset.state = ids.length ? 'ready' : 'empty';
      reconcileList(list, ids.map((songId, index) => ({songId, index})), {
        key: item => item.songId,
        create: item => Row(item.songId),
      });
      ids.forEach((songId, index) => rows.get(songId)?.render({song: songs.get(songId), index, count: ids.length, listName: name, readOnly}));
      showEdge(ids.length ? null : 'empty');
    });
  }));

  // ---------- data ----------
  function settle() {
    if (pending > 0 || latest === undefined) return;
    data.value = latest;
    order.value = latest ? [...latest.songIds] : null;
  }

  let firstResolve;
  const first = new Promise(resolve => { firstResolve = resolve; });
  let off = () => {};
  let touched = null;

  function subscribe() {
    off();
    data.value = undefined;
    order.value = null;
    latest = undefined;
    pending = 0;
    const want = id;
    off = api.subscribeGet({id: want}, value => {
      if (want !== id || ac.signal.aborted) return;
      latest = value ?? null;
      settle();
      firstResolve();
      if (latest && touched !== want) {
        touched = want;
        Promise.resolve(api.touch({id: want})).catch(() => {});
      }
    }, err => {
      if (want !== id || ac.signal.aborted) return;
      console.error('[setlist] could not load the setlist', err);
      latest = null;
      settle();
      firstResolve();
    });
  }
  disposers.push(() => off());
  subscribe();

  /** Writes an order: shows it at once, then takes the stored order the server returns. */
  async function writeOrder(next, {revertTo = order.peek()} = {}) {
    const listId = id;
    order.value = next;
    pending += 1;
    try {
      const stored = await api.setSongs({id: listId, songIds: next});
      if (listId !== id) return null;
      if (Array.isArray(stored)) {
        order.value = stored;
        if (latest) latest = {...latest, songIds: stored};
      }
      return stored;
    } catch (err) {
      if (listId === id) {
        order.value = revertTo;
        feedback.toast(describeError(err, {context: 'save'}).sentence, {tone: 'error'});
      }
      return null;
    } finally {
      pending -= 1;
      settle();
    }
  }

  // ---------- actions ----------
  function playFromTop() {
    const ids = visibleOrder();
    if (ids.length) navigate(`/s/${enc(ids[0])}?set=${enc(id)}`);
  }

  function announceMove(songId) {
    const ids = visibleOrder();
    const song = store.library.songs.peek().get(songId);
    feedback.announce(COPY.moved(titleOf(song), ids.indexOf(songId) + 1, ids.length), {key: 'set-move'});
  }

  function removeSong(songId) {
    if (paused()) return;
    const before = order.peek() ?? [];
    const index = before.indexOf(songId);
    if (index < 0) return;
    const song = store.library.songs.peek().get(songId);
    const name = data.peek()?.name || COPY.untitled;
    // Keep focus in the list: the next row's remove button, else the previous one's, else the Play button.
    const ids = visibleOrder();
    const at = ids.indexOf(songId);
    const neighbour = rows.get(ids[at + 1]) ?? rows.get(ids[at - 1]) ?? null;
    const hadFocus = rows.get(songId)?.el.contains(doc.activeElement);
    void writeOrder(before.filter(x => x !== songId)).then(stored => {
      if (stored === null) return;
      feedback.toast(COPY.removedOne(titleOf(song), name), {
        key: 'set-remove', durationMs: UNDO_MS,
        action: {label: COPY.undo, run: () => writeOrder(reinsert(order.peek() ?? [], songId, index))},
      });
    });
    if (hadFocus) (neighbour?.el.querySelector('.set-remove') ?? play.el).focus({preventScroll: true});
  }

  function startRename() {
    if (paused()) return;
    renameInput.value = data.peek()?.name ?? '';
    renameError.hidden = true;
    renameInput.removeAttribute('aria-invalid');
    renaming.value = true;
    renameInput.focus();
    renameInput.select?.();
  }

  function stopRename({focus = false} = {}) {
    renaming.value = false;
    if (focus) rename.el.focus({preventScroll: true});
  }

  function showRenameError(text) {
    renameError.textContent = text;
    renameError.hidden = false;
    renameInput.setAttribute('aria-invalid', 'true');
    renameInput.focus();
  }

  listen(renameForm, 'submit', async e => {
    e.preventDefault();
    const raw = renameInput.value;
    if (!setlistsApi.isValidName(raw)) { showRenameError(`${COPY.renameLabel} needs 1–${setlistsApi.LIMITS.name} characters.`); return; }
    const name = setlistsApi.tidyName(raw);
    if (name === data.peek()?.name) { stopRename({focus: true}); return; }
    renameSave.set({busy: true, disabled: true});
    pending += 1;
    try {
      await api.rename({id, name});
      if (latest) latest = {...latest, name};
      data.value = {...data.peek(), name};
      stopRename({focus: true});
    } catch (err) {
      showRenameError(describeError(err, {context: 'save'}).sentence);
    } finally {
      pending -= 1;
      renameSave.set({busy: false, disabled: false});
      settle();
    }
  });
  listen(renameInput, 'keydown', e => {
    if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); stopRename({focus: true}); }
  });

  async function deleteList() {
    if (paused()) return;
    const name = data.peek()?.name || COPY.untitled;
    const ok = await feedback.confirm({title: COPY.deleteSetlistTitle(name), body: COPY.deleteSetlistBody,
      confirmLabel: COPY.deleteSetlistConfirm, danger: true});
    if (!ok) return;
    try {
      await api.remove({id});
      feedback.toast(COPY.deletedSetlist(name), {tone: 'ok'});
      navigate('/', {replace: true});
    } catch (err) {
      feedback.toast(describeError(err, {context: 'save'}).sentence, {tone: 'error'});
    }
  }

  // ⌥↑ / ⌥↓ on a focused row
  listen(list, 'keydown', e => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const li = e.target?.closest?.('.set-row');
    if (!li || paused()) return;
    e.preventDefault();
    const songId = li.dataset.songId;
    const ids = visibleOrder();
    const next = moveId(ids, songId, e.key === 'ArrowUp' ? -1 : 1);
    if (next === ids) return;
    void writeOrder(fullOrder(next));
    announceMove(songId);
  });

  /** A reordering of the visible songs, with ids the library does not know (yet) kept at their places. */
  function fullOrder(visible) {
    const all = order.peek() ?? [];
    const known = new Set(visible);
    const queue = [...visible];
    return all.map(songId => (known.has(songId) ? queue.shift() : songId));
  }

  // ---------- drag ----------
  let drag = null;

  function startDrag(e, entry) {
    if (paused() || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const handle = e.currentTarget;
    const li = entry.el;
    drag = {
      entry, li, handle, pointerId: e.pointerId, startY: e.clientY, startTop: li.offsetTop, startScroll: scroller.scrollTop,
      before: visibleOrder(), moved: false,
    };
    try { handle.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
  }

  function dragTo(clientY) {
    const d = drag;
    const delta = clientY - d.startY + (scroller.scrollTop - d.startScroll);
    if (!d.moved) {
      if (Math.abs(delta) < DRAG_SLOP_PX) return;
      d.moved = true;
      d.li.dataset.dragging = '';
      list.dataset.dragging = '';
    }
    const top = d.startTop + delta;
    const center = top + d.li.offsetHeight / 2;
    // Move the neighbours around the dragged row (never the row itself: it may hold focus).
    for (let prev = d.li.previousElementSibling; prev && center < prev.offsetTop + prev.offsetHeight / 2; prev = d.li.previousElementSibling) {
      list.insertBefore(prev, d.li.nextElementSibling);
    }
    for (let next = d.li.nextElementSibling; next && center > next.offsetTop + next.offsetHeight / 2; next = d.li.nextElementSibling) {
      list.insertBefore(next, d.li);
    }
    d.li.style.transform = `translateY(${top - d.li.offsetTop}px)`;
    // Near the scroller's edges, scroll it.
    const box = scroller.getBoundingClientRect();
    if (clientY < box.top + EDGE_SCROLL_PX) scroller.scrollTop -= EDGE_SCROLL_PX / 4;
    else if (clientY > box.bottom - EDGE_SCROLL_PX) scroller.scrollTop += EDGE_SCROLL_PX / 4;
  }

  function endDrag(commit) {
    const d = drag;
    drag = null;
    if (!d) return;
    try { d.handle.releasePointerCapture?.(d.pointerId); } catch { /* released */ }
    d.li.style.removeProperty('transform');
    delete d.li.dataset.dragging;
    delete list.dataset.dragging;
    if (!d.moved) return;
    const now = [...list.children].map(li => li.dataset.songId);
    const changed = now.some((songId, i) => songId !== d.before[i]);
    if (!commit || !changed) {
      // Put the rows back in the stored order.
      reconcileList(list, d.before.map(songId => ({songId})), {key: item => item.songId, create: item => Row(item.songId)});
      return;
    }
    void writeOrder(fullOrder(now), {revertTo: order.peek()});
    announceMove(d.entry.songId);
  }

  listen(list, 'pointermove', e => { if (drag && e.pointerId === drag.pointerId) { e.preventDefault(); dragTo(e.clientY); } });
  listen(list, 'pointerup', e => { if (drag && e.pointerId === drag.pointerId) endDrag(true); });
  listen(list, 'pointercancel', e => { if (drag && e.pointerId === drag.pointerId) endDrag(false); });
  listen(list, 'lostpointercapture', e => { if (drag && e.pointerId === drag.pointerId) endDrag(true); });

  // ---------- first data ----------
  await Promise.race([first, new Promise(resolve => setTimeout(resolve, FIRST_DATA_MS))]);

  return {
    update(next) {
      const nextId = next?.params?.id ?? null;
      if (nextId === id) return;
      id = nextId;
      touched = null;
      stopRename();
      subscribe();
    },
    unmount() {
      ac.abort();
      endDrag(false);
      for (const d of disposers.splice(0).reverse()) { try { d(); } catch (err) { console.error(err); } }
      for (const p of primitives) p.destroy?.();
      for (const entry of [...rows.values()]) entry.destroy();
      edgeState?.destroy?.();
      skeleton?.destroy();
      el.replaceChildren();
    },
  };
}
