// The Spots list (architecture §2.14.11, §2.14.1 spot counters; spec §4.7 "Spots list"): J, the
// identity ⋯ → Spots, or the palette. One row per live spot, in song order:
//
//   name · bars 41–48 · 85% · practised 2 days ago · 14 times · ▶
//
// - Selecting a row runs `spot.open {id}` (loop + speed + cue in one undo step, the active spot)
//   and closes the sheet. The active spot's row reads "Looping now"; its count moves live as the
//   session adds passes (`practice.touchSpot` on each pass over the active spot, §2.14.1).
// - A row's actions: Rename (inline), Update from current (the current loop and speed) and Delete
//   (undo toast). They open from the row's ⋯ button, a right-click, Shift+F10 or the ContextMenu
//   key (a menu), or a horizontal swipe on touch (an action tray in the row).
// - Each change is one practice-undo step on the `spots` key (from/to are the whole lists,
//   tombstones included; practice-state turns a dropped spot into a tombstone).
// - The footer's Save spot (B) saves the current loop.
//
//   export function render(container, {session, close, registry?, feedback?, now?}) → {destroy}
//   export function spotDetails(session, spot, now) → {range, rate, practised, active}

import '../../styles/views/stage/sheets-spots.css';
import {registry as appRegistry} from '../../app/commands.js';
import {now as clockNow} from '../../app/clock.js';
import {feedback as appFeedback} from '../../app/feedback.js';
import {effect} from '../../app/store.js';
import {Button, IconButton} from '../../ui/button.js';
import {h, reconcileList} from '../../ui/h.js';
import {icon} from '../../ui/icon.js';
import {Menu, bindContextMenu} from '../../ui/menu.js';
import {relativeTime} from '../../library/song-labels.js';
import {formatTenths} from '../position.js';
import {openSpot} from '../commands.js';
import {COPY as ALL} from './sheets-b.copy.js';

const COPY = ALL.spots;
/** A horizontal drag this far on touch opens (or, the other way, closes) the row's action tray. */
export const SWIPE_PX = 48;
/** A drag starts as a swipe once it moved this far, more sideways than down. */
export const SWIPE_SLOP = 10;
/** The relative times ("practised 5 min ago") are re-read this often while the list is open. */
export const REFRESH_MS = 60_000;
const EDGE_EPS = 0.01;

const peek = (v) => (v && typeof v === 'object' && typeof v.peek === 'function' ? v.peek() : v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
let seq = 0;

/** The bar span text of [a, b) on a mapped song ('bars 41–48'), or the time span ('0:31.2–0:41.0'). */
function rangeText(session, a, b) {
  const map = session.map;
  const mapped = peek(session.position?.mapped) ?? !!map?.isReal;
  if (!mapped || !map?.isReal || !map.bars?.length) return `${formatTenths(a)}–${formatTenths(b)}`;
  const first = map.barIndexAt(a + EDGE_EPS);
  const last = Math.max(first, map.barIndexAt(Math.max(a + 1e-6, b - EDGE_EPS)));
  const display = (i) => (i < 0 ? null : map.bars[i]?.display ?? null);
  return COPY.bars(display(first), display(last));
}

/** Where a spot is now: its bar refs re-resolved on the current map, else its stored seconds. */
function spanOf(session, spot) {
  const a = (spot.aBar && session.position?.resolve?.(spot.aBar)) ?? spot.a;
  const b = (spot.bBar && session.position?.resolve?.(spot.bBar)) ?? spot.b;
  return {a, b};
}

/** The text parts of a row (pure apart from reading the session). */
export function spotDetails(session, spot, now) {
  const {a, b} = spanOf(session, spot);
  const when = Number.isFinite(spot.lastAt) ? relativeTime(spot.lastAt, now) : '';
  return {
    range: rangeText(session, a, b),
    rate: COPY.rate(spot.rate ?? 1),
    practised: COPY.practised(when, spot.passes ?? 0),
    active: peek(session.practice.activeSpotId) === spot.id,
  };
}

const liveSpots = (practice) => (practice.value.peek().spots ?? []).filter((s) => !s.deleted);

export function render(container, {session, close = () => {}, registry = appRegistry, feedback = appFeedback, now = clockNow} = {}) {
  if (!session?.practice) throw new TypeError('spots: a session is required');
  const practice = session.practice;
  const id = `spots-${++seq}`;
  const offs = [];
  let destroyed = false;
  let renaming = null;          // the spot id whose name is being edited
  let revealed = null;          // the spot id whose action tray is open
  let menu = null;

  /* ---------- the changes (one practice-undo step each) ---------- */

  function step(describe, change) {
    const before = clone(practice.value.peek().spots);
    change();
    const after = clone(practice.value.peek().spots);
    if (JSON.stringify(before) === JSON.stringify(after)) return null;
    return session.undo.push({key: 'spots', label: 'spot', describe: () => describe, from: before, to: after,
      apply: (v) => practice.patch({spots: clone(v)})});
  }

  const spotById = (spotId) => liveSpots(practice).find((s) => s.id === spotId) ?? null;

  function open(spot) {
    const ran = registry.run('spot.open', {source: 'pointer', args: {id: spot.id}});
    if (!ran) openSpot({session, feedback}, spot.id);
    close();
  }

  function rename(spotId, name) {
    const spot = spotById(spotId);
    const next = String(name ?? '').trim();
    if (!spot || !next || next === spot.name) return false;
    const entry = step(COPY.describeRename(spot.name, next), () => practice.updateSpot(spotId, {name: next}));
    if (entry) feedback.status?.(COPY.renamed(spot.name, spotById(spotId)?.name ?? next), {key: 'spot'});
    return !!entry;
  }

  function currentLoop() {
    const loop = peek(session.transport?.snapshot)?.loop;
    return loop?.on && loop.b - loop.a > 1e-6 ? loop : null;
  }

  function updateFromCurrent(spotId) {
    const spot = spotById(spotId);
    const loop = currentLoop();
    if (!spot) return false;
    if (!loop) { feedback.status?.(COPY.needsLoop, {key: 'spot'}); return false; }
    const rate = peek(session.transport.snapshot)?.rate ?? spot.rate ?? 1;
    const fields = {a: loop.a, b: loop.b, rate, aBar: session.position?.ref?.(loop.a) ?? null, bBar: session.position?.ref?.(loop.b) ?? null};
    const entry = step(COPY.describeUpdate(spot.name), () => practice.updateSpot(spotId, fields));
    // The loop is this spot now, so its passes count from here (§2.14.1).
    practice.activeSpotId.value = spotId;
    if (entry) feedback.status?.(COPY.updated(spot.name, rate), {key: 'spot'});
    return !!entry;
  }

  function undoLast() {
    if (registry.run('practice.undo', {source: 'pointer'})) return;
    session.undo.undo();
  }

  function remove(spotId) {
    const spot = spotById(spotId);
    if (!spot) return false;
    const entry = step(COPY.describeDelete(spot.name), () => practice.deleteSpot(spotId));
    if (!entry) return false;
    feedback.toast?.(COPY.deleted(spot.name), {action: {label: COPY.undo, run: undoLast}, key: 'spot-delete'});
    return true;
  }

  /* ---------- the row menu and the swipe tray ---------- */

  function menuItems(spot) {
    const canUpdate = !!currentLoop();
    return [
      {id: 'rename', label: COPY.rename, icon: 'pencil', run: () => startRename(spot.id)},
      {id: 'update', label: COPY.update, icon: 'refresh-cw', disabled: !canUpdate, reason: canUpdate ? undefined : COPY.needsLoop,
        run: () => updateFromCurrent(spot.id)},
      {type: 'separator'},
      {id: 'delete', label: COPY.delete, icon: 'trash-2', danger: true, run: () => remove(spot.id)},
    ];
  }

  function openMenu(spot, anchor) {
    menu?.destroy();
    menu = Menu({items: menuItems(spot), anchor, label: COPY.actions(spot.name), registry, onClose: () => { menu = null; }});
  }

  function startRename(spotId) {
    renaming = spotId;
    revealed = null;
    paint();
    const row = [...list.children].find((el) => el.dataset.spotId === spotId);
    const input = row?.querySelector('.spots-rename-input');
    input?.focus();
    input?.select?.();
  }

  function setRevealed(spotId) {
    if (revealed === spotId) return;
    revealed = spotId;
    paint();
  }

  /* ---------- rows ---------- */

  function createRow(spot) {
    const n = ++seq;
    const nameId = `${id}-name-${n}`, detailId = `${id}-detail-${n}`;
    const name = h('span', {class: 'spots-name', id: nameId});
    const range = h('span', {class: 'spots-range'});
    const rate = h('span', {class: 'spots-rate'});
    const practised = h('span', {class: 'spots-practised', dataset: {volatile: ''}});
    const active = h('span', {class: 'spots-active'}, COPY.active);
    const note = h('span', {class: 'spots-note selectable'});
    const detail = h('span', {class: 'spots-detail', id: detailId}, range, ' · ', rate, ' · ', practised);
    const openButton = h('button', {type: 'button', class: 'spots-open', attrs: {'aria-labelledby': nameId, 'aria-describedby': detailId}},
      h('span', {class: 'spots-text'}, h('span', {class: 'spots-head'}, name, active), detail, note),
      h('span', {class: 'spots-play', attrs: {'aria-hidden': 'true'}}, icon('play')));
    let current = spot;
    openButton.addEventListener('click', (e) => {
      if (swipe.swallow) { swipe.swallow = false; e.preventDefault(); return; }
      open(current);
    });
    const more = IconButton({label: COPY.more(spot.name), icon: 'ellipsis', size: 'md', className: 'spots-more',
      onClick: () => openMenu(current, more.el)});

    const renameButton = Button({label: COPY.rename, icon: 'pencil', size: 'sm', variant: 'quiet', onClick: () => startRename(current.id)});
    const updateButton = Button({label: COPY.update, icon: 'refresh-cw', size: 'sm', variant: 'quiet', onClick: () => { updateFromCurrent(current.id); setRevealed(null); }});
    const deleteButton = Button({label: COPY.delete, icon: 'trash-2', size: 'sm', variant: 'danger', onClick: () => { remove(current.id); }});
    const tray = h('div', {class: 'spots-tray', attrs: {role: 'group'}}, renameButton.el, updateButton.el, deleteButton.el);

    const input = h('input', {type: 'text', class: 'spots-rename-input', maxLength: 60,
      attrs: {'aria-label': COPY.nameLabel, 'data-consume-keys': 'Escape Enter', autocomplete: 'off'}});
    let committing = false;
    const finishRename = (commit) => {
      if (committing || renaming !== current.id) return;
      committing = true;
      const value = input.value;
      renaming = null;
      if (commit) rename(current.id, value);
      paint();
      committing = false;
      if (input.ownerDocument.activeElement === input || input.ownerDocument.activeElement === input.ownerDocument.body) openButton.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishRename(false); }
    });
    input.addEventListener('blur', () => finishRename(true));
    const renameField = h('div', {class: 'spots-rename'}, input);

    const main = h('div', {class: 'spots-main'}, openButton, more.el, renameField);
    const el = h('li', {class: 'spots-row'}, main, tray);

    // Swipe (touch and pen): sideways past SWIPE_PX opens the tray; back the other way closes it.
    const swipe = {id: null, x: 0, y: 0, dx: 0, active: false, swallow: false};
    main.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || !e.isPrimary) return;
      Object.assign(swipe, {id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, active: false, swallow: false});
    });
    main.addEventListener('pointermove', (e) => {
      if (swipe.id !== e.pointerId) return;
      const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
      if (!swipe.active) {
        if (Math.abs(dx) < SWIPE_SLOP || Math.abs(dx) <= Math.abs(dy)) {
          if (Math.abs(dy) >= SWIPE_SLOP) swipe.id = null;   // a vertical scroll
          return;
        }
        swipe.active = true;
      }
      swipe.dx = dx;
      main.style.setProperty('--spots-swipe', `${Math.max(-SWIPE_PX * 2, Math.min(SWIPE_PX * 2, dx))}px`);
      el.dataset.swiping = '';
    });
    const endSwipe = (e) => {
      if (swipe.id !== e.pointerId) return;
      swipe.id = null;
      main.style.removeProperty('--spots-swipe');
      delete el.dataset.swiping;
      if (!swipe.active) return;
      swipe.swallow = true;
      // The click that follows the release is the swipe's, not a selection.
      setTimeout(() => { swipe.swallow = false; }, 0);
      if (Math.abs(swipe.dx) >= SWIPE_PX) setRevealed(revealed === current.id ? null : current.id);
    };
    main.addEventListener('pointerup', endSwipe);
    main.addEventListener('pointercancel', endSwipe);

    const offMenu = bindContextMenu(el, () => (renaming === current.id ? null : menuItems(current)),
      {label: COPY.actions(spot.name), registry});

    function update(next) {
      current = next;
      const d = spotDetails(session, next, now());
      if (name.textContent !== next.name) name.textContent = next.name;
      range.textContent = d.range;
      rate.textContent = d.rate;
      practised.textContent = d.practised;
      active.hidden = !d.active;
      note.textContent = next.note ?? '';
      note.hidden = !next.note;
      el.dataset.spotId = next.id;
      el.toggleAttribute('data-active', d.active);
      openButton.setAttribute('aria-current', d.active ? 'true' : 'false');
      more.set({label: COPY.more(next.name)});
      tray.setAttribute('aria-label', COPY.actions(next.name));
      const isRenaming = renaming === next.id;
      const isRevealed = revealed === next.id && !isRenaming;
      el.toggleAttribute('data-renaming', isRenaming);
      el.toggleAttribute('data-revealed', isRevealed);
      openButton.hidden = isRenaming;
      more.el.hidden = isRenaming;
      renameField.hidden = !isRenaming;
      tray.hidden = !isRevealed;
      if (isRenaming && input.dataset.for !== next.id) { input.value = next.name; input.dataset.for = next.id; }
      if (!isRenaming) delete input.dataset.for;
      updateButton.set({disabled: !currentLoop(), title: currentLoop() ? undefined : COPY.needsLoop});
    }
    update(spot);
    return {
      el, update,
      destroy() { offMenu(); more.destroy(); renameButton.destroy(); updateButton.destroy(); deleteButton.destroy(); },
    };
  }

  /* ---------- the sheet ---------- */

  const list = h('ul', {class: 'spots-list', attrs: {'aria-label': COPY.list}});
  const empty = h('div', {class: 'spots-empty'},
    h('p', {class: 'spots-empty-title'}, COPY.emptyTitle),
    h('p', {class: 'spots-empty-body'}, COPY.emptyBody));
  const shared = h('p', {class: 'spots-shared'}, COPY.readOnly);
  shared.hidden = !session.readOnly;
  const save = Button({label: COPY.save, command: 'spot.save', registry, icon: 'bookmark', kbd: true, className: 'spots-save'});
  const root = h('div', {class: 'spots', dataset: {sheetBody: 'spots'}}, shared, list, empty, h('div', {class: 'spots-foot'}, save.el));
  container.append(root);

  function paint() {
    if (destroyed) return;
    const spots = liveSpots(practice).slice().sort((x, y) => spanOf(session, x).a - spanOf(session, y).a || x.name.localeCompare(y.name));
    if (renaming && !spots.some((s) => s.id === renaming)) renaming = null;
    if (revealed && !spots.some((s) => s.id === revealed)) revealed = null;
    reconcileList(list, spots, {key: (s) => s.id, create: createRow});
    list.hidden = !spots.length;
    empty.hidden = !!spots.length;
  }

  offs.push(effect(() => {
    practice.value.value;
    practice.activeSpotId.value;
    session.position?.revision?.value;
    session.transport?.snapshot?.value?.loop;
    paint();
  }));
  const timer = setInterval(paint, REFRESH_MS);
  offs.push(() => clearInterval(timer));
  // Tapping elsewhere in the sheet closes an open tray.
  const onDown = (e) => { if (revealed && !e.target.closest?.('.spots-row[data-revealed]')) setRevealed(null); };
  root.addEventListener('pointerdown', onDown);
  offs.push(() => root.removeEventListener('pointerdown', onDown));

  return {
    el: root,
    /** For tests and the harness: the row actions by spot id. */
    actions: {open: (spotId) => { const s = spotById(spotId); if (s) open(s); }, rename, updateFromCurrent, remove, startRename},
    destroy() {
      if (destroyed) return;
      destroyed = true;
      menu?.destroy();
      for (const off of offs.splice(0).reverse()) off?.();
      reconcileList(list, [], {key: (s) => s.id, create: createRow});
      save.destroy();
      root.remove();
    },
  };
}

export default render;
