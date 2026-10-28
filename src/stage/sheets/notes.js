// The Notes card's content (architecture §2.14.11; spec §4.7 "Notes card"): the HUD Notes chip opens
// it as a non-modal card at the music's top right (320 px, sheets/host.js), and it stays open until
// closed. It shows the song's practice notes (17 px, selectable), key, tuning and tags, and the
// active spot's note when it has one; all of them follow the song live. The notes are edited in
// Edit · Details (spec §5.3): an owner's card ends with [Edit details].
//
//   export function render(container, {session, close, registry?}) → {destroy}

import '../../styles/views/stage/sheets-notes.css';
import {registry as appRegistry} from '../../app/commands.js';
import {effect} from '../../app/store.js';
import {Button} from '../../ui/button.js';
import {h} from '../../ui/h.js';
import {COPY as ALL} from './sheets-b.copy.js';

const COPY = ALL.notes;
const peek = (v) => (v && typeof v === 'object' && typeof v.peek === 'function' ? v.peek() : v);
const textOf = (v) => (typeof v === 'string' ? v.trim() : '');

export function render(container, {session, close = () => {}, registry = appRegistry} = {}) {
  if (!session) throw new TypeError('notes: a session is required');
  const offs = [];

  const notes = h('p', {class: 'notes-text selectable'});
  const empty = h('p', {class: 'notes-empty'}, COPY.empty);
  const spotLabel = h('p', {class: 'notes-spot-label'});
  const spotNote = h('p', {class: 'notes-spot-text selectable'});
  const spot = h('div', {class: 'notes-spot'}, spotLabel, spotNote);
  const facts = h('dl', {class: 'notes-facts'});
  const hint = h('p', {class: 'notes-hint'}, COPY.editHint);
  const edit = Button({label: COPY.edit, command: 'edit.details', registry, icon: 'pencil', size: 'sm', variant: 'secondary',
    className: 'notes-edit', onClick: () => close()});
  const owner = h('div', {class: 'notes-owner'}, hint, edit.el);
  const root = h('div', {class: 'notes', attrs: {role: 'region', 'aria-label': COPY.region}, dataset: {sheetBody: 'notes'}},
    notes, empty, spot, facts, owner);
  container.append(root);

  const fact = (label, value) => [h('dt', {class: 'notes-fact-label'}, label), h('dd', {class: 'notes-fact-value selectable'}, value)];

  function paintSong(song) {
    const text = textOf(song?.notes);
    notes.textContent = text;
    notes.hidden = !text;
    const key = textOf(song?.musicalKey), tuning = textOf(song?.tuning);
    const tags = (Array.isArray(song?.tags) ? song.tags : []).map(textOf).filter(Boolean);
    const rows = [];
    if (key) rows.push(...fact(COPY.key, key));
    if (tuning) rows.push(...fact(COPY.tuning, tuning));
    if (tags.length) {
      rows.push(h('dt', {class: 'notes-fact-label'}, COPY.tags),
        h('dd', {class: 'notes-fact-value'}, h('ul', {class: 'notes-tags', attrs: {'aria-label': COPY.tags}},
          tags.map((t) => h('li', {class: 'notes-tag selectable'}, t)))));
    }
    facts.replaceChildren(...rows);
    facts.hidden = !rows.length;
    empty.hidden = !!(text || rows.length);
  }

  function paintSpot() {
    const id = peek(session.practice?.activeSpotId);
    const active = id ? (peek(session.practice?.value)?.spots ?? []).find((s) => s.id === id && !s.deleted) : null;
    const note = textOf(active?.note);
    spot.hidden = !note;
    spotLabel.textContent = note ? COPY.spotNote(active.name) : '';
    spotNote.textContent = note;
  }

  function paintOwner() {
    const visible = !session.readOnly && !!registry.state('edit.details')?.visible;
    owner.hidden = !visible;
  }

  offs.push(effect(() => paintSong(session.song?.value)));
  if (session.practice) {
    offs.push(effect(() => {
      session.practice.activeSpotId?.value;
      session.practice.value?.value;
      paintSpot();
    }));
  }
  paintOwner();
  offs.push(registry.onChange(paintOwner));

  return {
    el: root,
    destroy() {
      for (const off of offs.splice(0).reverse()) off?.();
      edit.destroy();
      root.remove();
    },
  };
}

export default render;
