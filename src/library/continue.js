// Continue: the hero card and up to three recents (spec §2.2.1, architecture §2.16; D5).
//
//   ContinueSection({songs, now, profile}) → {el, update({songs, now, profile}), destroy()}
//
// Shown only while some song has lastPracticedAt (the section is `hidden` otherwise). The hero is
// the most recently practised song: cover, title, artist, the state line
// ('Bridge loop · 85% · Drums out · practised yesterday'), ▶ Resume (/s/:id: the Stage opens it
// stopped at its cue, so Space plays at once), Start from top (/s/:id?t=0) and up to three spot
// chips from practiceSummary.spots (/s/:id?spot=<id>). Recents are compact cards (cover 64,
// title, state line). Everything is a link: the app frame's router delegate navigates.
// The cover of whichever card is opened gets the shared-element name for the Stage's View
// Transition (cards.js nameCover).

import '../styles/views/library/continue.css';
import {h} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {COPY} from './home.copy.js';
import {continuePicks} from './library-model.js';
import {Cover, CompactCard, nameCover} from './cards.js';
import {artistLabel, practiceLine, practisedLine, spotLabel, stateLine} from './song-labels.js';

const songHref = (id, query = '') => `/s/${encodeURIComponent(id)}${query}`;
const isPlainClick = e => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

function Hero() {
  const cover = Cover({className: 'lib-hero-cover'});
  const coverLink = h('a', {class: 'lib-hero-art', attrs: {tabindex: '-1', 'aria-hidden': 'true', draggable: 'false'}}, cover.el);
  const title = h('h3', {class: 'lib-hero-title selectable'});
  const artist = h('p', {class: 'lib-hero-artist'});
  const state = h('p', {class: 'lib-hero-state'});
  const resumeText = h('span', {}, COPY.resume);
  const resume = h('a', {class: 'lib-hero-resume', attrs: {draggable: 'false'}}, icon('play', {size: 20}), resumeText);
  const startOver = h('a', {class: 'lib-hero-start', attrs: {draggable: 'false'}}, COPY.startOver);
  const actions = h('div', {class: 'lib-hero-actions'}, resume, startOver);
  const spots = h('ul', {class: 'lib-hero-spots', attrs: {'aria-label': COPY.spots}});
  const text = h('div', {class: 'lib-hero-text'}, title, artist, state, actions, spots);
  const el = h('article', {class: 'lib-hero'}, coverLink, text);
  let song = null;
  for (const link of [coverLink, resume, startOver]) {
    link.addEventListener('click', e => { if (song && isPlainClick(e)) nameCover(cover.el, song.id); });
  }
  spots.addEventListener('click', e => {
    if (song && isPlainClick(e) && e.target?.closest?.('a')) nameCover(cover.el, song.id);
  });

  function update(next, {now, profile}) {
    song = next;
    const name = next.title || 'Untitled';
    title.textContent = name;
    title.id = `lib-hero-${next.id}`;
    el.setAttribute('aria-labelledby', title.id);
    const by = artistLabel(next);
    artist.textContent = by;
    artist.hidden = !by;
    state.textContent = stateLine(next, now, {profile});
    coverLink.setAttribute('href', songHref(next.id));
    resume.setAttribute('href', songHref(next.id));
    resume.dataset.focusKey = `continue:${next.id}`;
    resume.setAttribute('aria-label', COPY.resumeLabel(name));
    startOver.setAttribute('href', songHref(next.id, '?t=0'));
    startOver.setAttribute('aria-label', COPY.startOverLabel(name));
    const list = Array.isArray(next.practiceSummary?.spots) ? next.practiceSummary.spots.slice(0, 3) : [];
    spots.replaceChildren(...list.map(spot => h('li', {},
      h('a', {class: 'lib-spot-chip', href: songHref(next.id, `?spot=${encodeURIComponent(spot.id)}`), attrs: {draggable: 'false'}},
        icon('diamond', {size: 20}), h('span', {}, spotLabel(spot))))));
    spots.hidden = !list.length;
    cover.set(next, next);
  }
  return {el, update, get cover() { return cover.el; }};
}

export function ContinueSection({songs = [], now = 0, profile = null} = {}) {
  const heading = h('h2', {class: 'lib-section-title', id: 'lib-continue-title'}, COPY.continue);
  const hero = Hero();
  const recents = h('ul', {class: 'lib-recents', attrs: {'aria-label': COPY.recents}});
  const grid = h('div', {class: 'lib-continue-grid'}, hero.el, recents);
  const el = h('section', {class: 'lib-continue', attrs: {'aria-labelledby': heading.id}}, heading, grid);
  const compact = new Map();   // id → CompactCard

  function update({songs: list = [], now: at = now, profile: p = profile} = {}) {
    const {hero: top, recents: rest} = continuePicks(list);
    el.hidden = !top;
    if (!top) { recents.replaceChildren(); compact.clear(); return; }
    hero.update(top, {now: at, profile: p});
    const keep = new Set(rest.map(s => s.id));
    for (const [id, card] of compact) if (!keep.has(id)) { card.el.parentNode?.remove(); compact.delete(id); }
    const items = rest.map(song => {
      const practice = practiceLine(song, {profile: p});
      const when = practisedLine(song, at);
      let card = compact.get(song.id);
      const line = [practice, when].filter(Boolean).join('\n');
      if (!card) {
        card = CompactCard(song, {className: 'lib-recent', line});
        card.el.addEventListener('click', e => { if (isPlainClick(e)) nameCover(card.cover, song.id); });
        compact.set(song.id, card);
      } else {
        card.update(song, {line});
      }
      card.el.setAttribute('aria-label', [song.title || 'Untitled', practice, when].filter(Boolean).join(', '));
      return card.el.parentNode ?? h('li', {class: 'lib-recent-item'}, card.el);
    });
    items.forEach((li, i) => { if (recents.children[i] !== li) recents.insertBefore(li, recents.children[i] ?? null); });
    recents.hidden = !items.length;
  }
  update({songs, now, profile});
  return {el, update, destroy() { el.remove(); compact.clear(); }};
}
