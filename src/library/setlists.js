// The Setlists row on Library home (spec §2.2.2 with B3, D8; architecture §2.16). Read-only in
// LB1a: one row of compact cards, `Thursday rehearsal · 6 songs`, each opening /set/:id. The row
// is hidden while there are no setlists. LB3 adds "Add to setlist ▸" (card-menu.js).
//
//   mountSetlistsRow(el, {store}) → {destroy()}
//     reads store.library.setlists (rows {id, name, count, songIds, updatedAt, lastOpenedAt}) and
//     store.library.songs for the covers (the first four songs of the list, a 2×2 mosaic).

import '../styles/views/library/home.css';
import {h} from '../ui/h.js';
import {effect, store as appStore} from '../app/store.js';
import {COPY} from './home.copy.js';
import {Cover} from './cards.js';

const MOSAIC = 4;

function SetlistCard(setlist) {
  const tiles = h('span', {class: 'lib-set-mosaic', attrs: {'aria-hidden': 'true'}});
  const name = h('span', {class: 'lib-set-name'});
  const count = h('span', {class: 'lib-set-count'});
  const el = h('a', {class: 'lib-set-card', attrs: {draggable: 'false'}}, tiles, h('span', {class: 'lib-set-text'}, name, count));
  const covers = [];

  function update(next, songs) {
    const n = Number.isFinite(next.count) ? next.count : (next.songIds?.length ?? 0);
    name.textContent = next.name || 'Untitled setlist';
    count.textContent = COPY.setlistCount(n);
    el.setAttribute('href', `/set/${encodeURIComponent(next.id)}`);
    el.dataset.focusKey = `set:${next.id}`;
    el.setAttribute('aria-label', `${next.name || 'Untitled setlist'}, ${COPY.setlistCount(n)}`);
    const members = (next.songIds ?? []).map(id => songs.get(id)).filter(Boolean).slice(0, MOSAIC);
    const want = Math.max(1, members.length);
    while (covers.length < want) { const c = Cover({className: 'lib-set-tile'}); covers.push(c); tiles.append(c.el); }
    while (covers.length > want) covers.pop().el.remove();
    tiles.dataset.count = String(want);
    covers.forEach((c, i) => {
      const song = members[i];
      c.set(song ?? null, song ?? {id: next.id, title: next.name});
    });
  }
  update(setlist, new Map());
  return {el, update};
}

export function mountSetlistsRow(el, {store = appStore} = {}) {
  const heading = h('h2', {class: 'lib-section-title', id: 'lib-setlists-title'}, COPY.setlists);
  const row = h('ul', {class: 'lib-shelf', attrs: {'aria-labelledby': heading.id}});
  const section = h('section', {class: 'lib-setlists', attrs: {'aria-labelledby': heading.id}}, heading, row);
  el.append(section);
  const cards = new Map();   // id → {card, li}

  const off = effect(() => {
    const list = Array.isArray(store.library.setlists.value) ? store.library.setlists.value : [];
    const songs = store.library.songs.value;
    section.hidden = !list.length;
    const keep = new Set(list.map(s => s.id));
    for (const [id, entry] of cards) if (!keep.has(id)) { entry.li.remove(); cards.delete(id); }
    list.forEach((setlist, i) => {
      let entry = cards.get(setlist.id);
      if (!entry) {
        const card = SetlistCard(setlist);
        entry = {card, li: h('li', {class: 'lib-shelf-item'}, card.el)};
        cards.set(setlist.id, entry);
      }
      entry.card.update(setlist, songs);
      if (row.children[i] !== entry.li) row.insertBefore(entry.li, row.children[i] ?? null);
    });
  });

  return {
    el: section,
    destroy() {
      off();
      cards.clear();
      section.remove();
    },
  };
}
