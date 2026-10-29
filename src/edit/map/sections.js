// Edit · Map sections: the 32 px sections lane, the markers → sections banner and the section
// suggestion review (architecture §2.15 "sections.js", D23, D47; spec §5.1 "sections lane
// (32 px, editable blocks)", "Markers → sections"; maps/mapedit.md §11.5).
//
//   createSectionsLane(host, {session, mapSession, registry}) →
//     {el, bar, render(view), rename(barIndex), openReview(), closeReview(), escape(), destroy()}
//
// The lane (role=group "Sections") shows one block per section of the map (sectionBlocks):
//   - the name selects the section's first bar (and cues there when stopped); a double-click, F2 or
//     its context menu (right-click, long-press, Shift+F10) renames it inline: Enter or leaving the
//     field keeps the name ('' removes the label), Esc cancels;
//   - every section after the first has a boundary handle on its left edge (role=slider, 24 px hit,
//     44 coarse): drag it to another bar, or ←/→ (Home/End) on it, to move where the section starts
//     (mapSession.moveSectionBoundary, one map step; it never crosses another section).
// A section suggestion (D47; session.detect.suggestion, shown while the map is real and has no
// sections) draws as dashed blocks, with [Keep all] [Review] in the bar under the lane. Review
// (also `?review=sections`) turns the blocks into the review: ✓/✕ per block, an editable name,
// a draggable start, and [Apply N] [Cancel] in the bar. Apply keeps the accepted blocks as one map
// step and dismisses the suggestion (songs.dismissSectionSuggestion through detect.dismiss()).
//
// The markers banner (createMarkersBanner) shows on a mapped song with live markers: "You have 5
// markers. [Turn them into sections] (snaps each to the nearest bar)". Its button runs
// map.markersToSections (one map step whose undo also brings the markers back; the status line
// offers Undo).
import {h} from '../../ui/h.js';
import {Button} from '../../ui/button.js';
import {Banner} from '../../ui/banner.js';
import {bindContextMenu} from '../../ui/menu.js';
import {effect} from '../../app/store.js';
import {nearestBar, sectionBlocks, suggestionBlocks, timeScale} from '../../js/map-lane.js';
import {selectLine} from './lane.js';
import {COPY, MAP_COMMANDS} from './map.copy.js';

const peek = (v) => (v && typeof v === 'object' && typeof v.peek === 'function' ? v.peek() : v);
const HANDLE_KEYS = 'ArrowLeft ArrowRight Home End';

/** "bar 5" / "the pickup" for a measure index. */
function barWord(map, index) {
  const display = map.bars[index]?.display;
  return display === null || display === undefined ? 'the pickup' : `bar ${display}`;
}

/**
 * The sections lane. See the file header. `opts.coarse()` picks the 44 px handle hit; `registry`
 * runs Keep all.
 */
export function createSectionsLane(host, {session, mapSession, registry, coarse = () => false} = {}) {
  const {map} = session;
  const blocksEl = h('div', {class: 'map-sections-blocks'});
  const el = h('div', {class: 'map-sections', role: 'group', attrs: {'aria-label': COPY.sectionsLane}, dataset: {testid: 'map-sections'}}, blocksEl);
  const barText = h('span', {class: 'map-sections-bar-text'});
  const barActions = h('div', {class: 'map-sections-bar-actions'});
  const bar = h('div', {class: 'map-sections-bar', hidden: true, dataset: {testid: 'map-sections-bar'}}, barText, barActions);
  host.append(el);

  let view = {t0: 0, span: 0, width: 0};
  let renaming = null;        // {index, field}
  let dragging = null;        // {kind: 'section'|'review', from, i, to, pointerId, handle}
  let barButtons = [];
  const offs = [];
  const canEdit = () => !session.readOnly && !peek(mapSession.auditioning);
  const suggestion = () => peek(session.detect?.suggestion) ?? null;
  const reviewing = () => !!peek(mapSession.review);
  const scale = () => timeScale(view);
  const say = (text, tone = 'info') => { mapSession.message.value = {text, tone}; };

  // ---------------------------------------------------------------- blocks
  function sectionBlock(b) {
    const name = b.pickup && b.from === null ? COPY.pickupBlock(b.name) : COPY.sectionBlock(b.name, b.from ?? b.to, b.to ?? b.from);
    const label = h('button', {type: 'button', class: 'map-section-name', attrs: {'aria-label': name}, dataset: {bar: String(b.startBar), focusKey: `name:${b.startBar}`}}, b.name);
    label.addEventListener('click', () => { if (!renaming) selectLine(session, mapSession, map.barStart(b.startBar)); });
    label.addEventListener('dblclick', () => rename(b.startBar));
    label.addEventListener('keydown', (e) => { if (e.key === 'F2') { e.preventDefault(); rename(b.startBar); } });
    const offMenu = bindContextMenu(label, () => (canEdit() ? [
      {id: 'section-rename', label: COPY.renameItem, run: () => rename(b.startBar)},
      {id: 'section-remove', label: COPY.removeItem, disabled: !b.label, run: () => mapSession.setLabel(b.startBar, '')},
    ] : []), {label: b.name, registry});
    const block = h('div', {class: 'map-section', dataset: {index: String(b.index), start: String(b.startBar), x: ''}}, label);
    block.style.setProperty('--x0', `${b.x0}px`);
    block.style.setProperty('--w', `${Math.max(0, b.x1 - b.x0)}px`);
    block.dataset.alt = String(b.index % 2);
    // The first section starts the song; an unlabelled "Start" section has no start to move.
    if (b.startBar > 0 && b.label) block.append(handle({kind: 'section', from: b.startBar, name: b.name, x: 0}));
    block._off = offMenu;
    if (renaming?.index === b.startBar) {
      label.hidden = true;
      block.append(renaming.field);
    }
    return block;
  }

  function handle({kind, from, i = null, name, x}) {
    const knob = h('div', {class: 'map-boundary', role: 'slider', tabindex: '0',
      attrs: {'aria-label': kind === 'review' ? COPY.reviewBoundary(name) : COPY.boundary(name), 'aria-orientation': 'horizontal',
        'aria-valuemin': '1', 'aria-valuemax': String(map.bars.length), 'aria-valuenow': String(from + 1),
        'aria-valuetext': COPY.boundaryValue(barWord(map, from))},
      // The 24 px (44 coarse) hit area is centred on the block's edge, so it overlaps the names either side by design.
      dataset: {consumeKeys: HANDLE_KEYS, from: String(from), focusKey: i !== null ? `rboundary:${i}` : `boundary:${from}`, structureAllow: 'overlap',
        ...(i !== null ? {block: String(i)} : {})}});
    knob.style.setProperty('--x', `${x}px`);
    knob.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      let to = null;
      if (e.key === 'ArrowLeft') to = from - 1;
      else if (e.key === 'ArrowRight') to = from + 1;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = map.bars.length - 1;
      if (to === null) return;
      e.preventDefault();
      moveBoundary({kind, from, i, to: Math.max(0, Math.min(map.bars.length - 1, to)), focus: true});
    });
    knob.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (kind === 'section' && !canEdit()) { if (peek(mapSession.auditioning)) say(COPY.auditioning, 'error'); return; }
      e.preventDefault();
      e.stopPropagation();
      dragging = {kind, from, i, to: from, pointerId: e.pointerId, handle: knob};
      try { knob.setPointerCapture?.(e.pointerId); } catch { /* gone */ }
      knob.dataset.dragging = '';
    });
    knob.addEventListener('pointermove', (e) => {
      if (!dragging || dragging.handle !== knob || e.pointerId !== dragging.pointerId) return;
      const rect = el.getBoundingClientRect();
      const t = scale().t(e.clientX - rect.left);
      dragging.to = nearestBar(map, Math.max(0, Math.min(map.duration, t)));
      const parent = knob.parentElement?.getBoundingClientRect();
      const barX = scale().x(map.bars[dragging.to].t0) - ((parent?.left ?? rect.left) - rect.left);
      knob.style.setProperty('--x', `${barX}px`);
      knob.setAttribute('aria-valuetext', COPY.boundaryValue(barWord(map, dragging.to)));
    });
    const finish = (e, cancel) => {
      if (!dragging || dragging.handle !== knob || (e && e.pointerId !== dragging.pointerId)) return;
      const done = dragging;
      dragging = null;
      try { knob.releasePointerCapture?.(done.pointerId); } catch { /* released */ }
      delete knob.dataset.dragging;
      if (cancel || done.to === done.from) { render(); return; }
      moveBoundary(done);
    };
    knob.addEventListener('pointerup', (e) => finish(e, false));
    knob.addEventListener('pointercancel', (e) => finish(e, true));
    return knob;
  }

  function moveBoundary({kind, from, i, to, focus = false}) {
    if (kind === 'review') {
      mapSession.setSuggestionBlock(i, {bar: to});
    } else {
      mapSession.moveSectionBoundary(from, to);
    }
    render();
    if (focus) {
      const selector = kind === 'review' ? `.map-boundary[data-block="${i}"]` : `.map-boundary[data-from="${map.sections.some((s) => s.startBar === to) ? to : from}"]`;
      el.querySelector(selector)?.focus();
    }
  }

  function suggestionBlock(b, {review}) {
    const block = h('div', {class: 'map-suggested', dataset: {block: String(b.i), accepted: String(b.accepted), x: ''}});
    block.style.setProperty('--x0', `${b.x0}px`);
    block.style.setProperty('--w', `${Math.max(0, b.x1 - b.x0)}px`);
    if (!review) {
      block.append(h('span', {class: 'map-suggested-name'}, b.label));
      return block;
    }
    const keep = h('button', {type: 'button', class: 'map-suggested-toggle', attrs: {'aria-label': COPY.accept(b.label), 'aria-pressed': String(b.accepted)},
      dataset: {choice: 'keep', focusKey: `keep:${b.i}`}}, '✓');
    const drop = h('button', {type: 'button', class: 'map-suggested-toggle', attrs: {'aria-label': COPY.reject(b.label), 'aria-pressed': String(!b.accepted)},
      dataset: {choice: 'drop', focusKey: `drop:${b.i}`}}, '✕');
    keep.addEventListener('click', () => { mapSession.setSuggestionBlock(b.i, {accepted: true}); render(); });
    drop.addEventListener('click', () => { mapSession.setSuggestionBlock(b.i, {accepted: false}); render(); });
    const name = h('input', {class: 'map-suggested-input', attrs: {type: 'text', value: b.label, maxlength: '120', 'aria-label': COPY.reviewLabel(b.label)},
      dataset: {focusKey: `input:${b.i}`, consumeKeys: 'Escape'}});
    name.value = b.label;
    const commitName = () => { if (name.value.trim() && name.value.trim() !== b.label) { mapSession.setSuggestionBlock(b.i, {label: name.value}); render(); } };
    name.addEventListener('change', commitName);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitName(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); name.value = b.label; name.blur(); }
    });
    block.append(handle({kind: 'review', from: b.bar, i: b.i, name: b.label, x: 0}), keep, drop, name);
    return block;
  }

  // ---------------------------------------------------------------- the bar under the lane
  function setBar(text, actions) {
    delete bar.dataset.consumeKeys;
    for (const b of barButtons) b.destroy();
    barButtons = actions;
    barText.textContent = text;
    barActions.replaceChildren(...actions.map((b) => b.el));
    bar.hidden = !text && !actions.length;
  }

  // ---------------------------------------------------------------- render
  let lastKey = '';
  /**
   * Draws the lane for `next` (the shared window). The blocks are rebuilt only when what they show
   * changed (mode, sections, labels, the review's choices); a zoom or scroll only moves them, so a
   * focused name, handle or field keeps its focus. A rebuild puts focus back on the same control.
   */
  function render(next, {force = false} = {}) {
    if (next) view = next;
    // An open rename keeps its field (and focus) until it finishes.
    if (renaming && !force) return;
    const real = !!map.isReal;
    const mode = !real ? 'unmapped' : reviewing() ? 'review' : map.hasSections ? 'sections' : suggestion() ? 'suggestion' : 'empty';
    const items = mode === 'review' ? suggestionBlocks(map, peek(mapSession.review).blocks, view)
      : mode === 'sections' ? sectionBlocks(map, view)
        : mode === 'suggestion' ? suggestionBlocks(map, suggestion().sections ?? [], view) : [];
    const key = JSON.stringify([mode, map.revision, map.bars.length, items.map((b) => [b.i ?? b.index, b.startBar ?? b.bar, b.label, b.name, b.accepted])]);
    el.dataset.mode = mode;
    el.toggleAttribute('data-consume-keys', mode === 'review');
    if (mode === 'review') el.dataset.consumeKeys = 'Escape';
    if (key === lastKey && !force) { place(items); return; }
    lastKey = key;
    const focused = el.contains(document.activeElement) ? document.activeElement?.dataset?.focusKey ?? null : null;
    for (const child of blocksEl.children) child._off?.();
    const nodes = [];
    if (mode === 'review') {
      for (const b of items) nodes.push(suggestionBlock(b, {review: true}));
      const accepted = peek(mapSession.review).blocks.filter((b) => b.accepted).length;
      const apply = Button({label: COPY.applyReview(accepted), variant: 'primary', size: 'sm', className: 'map-review-apply', onClick: applyReview,
        disabled: !accepted});
      const cancel = Button({label: COPY.cancelReview, variant: 'quiet', size: 'sm', onClick: closeReview});
      setBar(`${COPY.reviewing} · ${COPY.reviewHint}`, [apply, cancel]);
      bar.dataset.consumeKeys = 'Escape';
    } else if (mode === 'sections') {
      for (const b of items) nodes.push(sectionBlock(b));
      setBar('', []);
    } else if (mode === 'suggestion') {
      for (const b of items) nodes.push(suggestionBlock(b, {review: false}));
      const keepAll = Button({label: COPY.keepAll, size: 'sm', variant: 'secondary', command: MAP_COMMANDS.keepAll, registry});
      const review = Button({label: COPY.review, size: 'sm', variant: 'quiet', onClick: openReview});
      setBar(COPY.suggestion, [keepAll, review]);
    } else {
      if (real) nodes.push(h('span', {class: 'map-sections-empty'}, COPY.noSections));
      setBar('', []);
    }
    blocksEl.replaceChildren(...nodes);
    if (focused) el.querySelector(`[data-focus-key="${focused}"]`)?.focus();
  }

  /** Moves the blocks of an unchanged lane to the window's x positions. */
  function place(items) {
    const nodes = [...blocksEl.children].filter((n) => n.dataset.x !== undefined);
    items.forEach((b, k) => {
      const node = nodes[k];
      if (!node) return;
      node.style.setProperty('--x0', `${b.x0}px`);
      node.style.setProperty('--w', `${Math.max(0, b.x1 - b.x0)}px`);
    });
  }

  // ---------------------------------------------------------------- rename
  function rename(index) {
    if (!canEdit() || !map.isReal) return false;
    const current = map.measure(index)?.label ?? '';
    const section = map.sections.find((s) => s.startBar === index);
    const field = h('input', {class: 'map-section-input', attrs: {type: 'text', maxlength: '120', 'aria-label': COPY.renameField(section?.name ?? barWord(map, index))},
      dataset: {consumeKeys: 'Escape'}});
    field.value = current || section?.name || '';
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      renaming = null;
      if (commit && field.value.trim() !== current) mapSession.setLabel(index, field.value);
      render(null, {force: true});
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    field.addEventListener('blur', () => finish(true));
    renaming = {index, field, finish};
    render(null, {force: true});
    field.focus();
    field.select?.();
    return true;
  }

  // ---------------------------------------------------------------- review (D47)
  function openReview() {
    const s = suggestion();
    if (!map.isReal || !s?.sections?.length) { say(COPY.noSuggestion); return false; }
    mapSession.reviewSuggestion(s);
    render();
    el.querySelector('.map-suggested-toggle')?.focus();
    return true;
  }
  function closeReview() {
    if (!reviewing()) return false;
    mapSession.reviewSuggestion(null);
    render();
    return true;
  }
  function applyReview() {
    if (!reviewing()) return {added: 0};
    if (!canEdit()) { say(COPY.auditioning, 'error'); return {added: 0}; }
    const result = mapSession.applySuggestionReview();
    if (!reviewing()) session.detect?.dismiss?.();
    render();
    return result;
  }

  /** Esc inside the lane's modes: cancel a rename, then close the review. */
  function escape() {
    if (renaming) { renaming.finish(false); return true; }
    return closeReview();
  }

  // Esc inside the review (the lane or its bar) closes it; the name fields handle their own Esc.
  const onEscape = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || renaming || !reviewing()) return;
    e.preventDefault();
    closeReview();
  };
  el.addEventListener('keydown', onEscape);
  bar.addEventListener('keydown', onEscape);
  offs.push(() => { el.removeEventListener('keydown', onEscape); bar.removeEventListener('keydown', onEscape); });

  offs.push(effect(() => { mapSession.review.value; session.detect?.suggestion?.value; render(); }));
  offs.push(map.subscribe(() => render()));

  return {
    el, bar, render, rename, openReview, closeReview, applyReview, escape,
    get reviewing() { return reviewing(); },
    get renaming() { return !!renaming; },
    destroy() {
      for (const off of offs) off();
      for (const child of blocksEl.children) child._off?.();
      for (const b of barButtons) b.destroy();
      el.remove();
      bar.remove();
    },
  };
}

/**
 * The markers → sections banner: shown on a mapped, writable song with live markers.
 *   createMarkersBanner(host, {session, registry}) → {el, render(), destroy()}
 */
export function createMarkersBanner(host, {session, registry} = {}) {
  const {map, practice} = session;
  const action = Button({label: COPY.markersAction, size: 'sm', variant: 'primary', command: MAP_COMMANDS.markersToSections, registry});
  const note = h('span', {class: 'map-banner-note'}, COPY.markersNote);
  const banner = Banner({tone: 'info', text: '', actions: [action.el, note], className: 'map-markers-banner', testid: 'map-markers-banner'});
  host.append(banner.el);
  const live = () => (practice?.value?.peek?.().markers ?? []).filter((m) => !m.deleted);
  function render() {
    const n = live().length;
    const show = !!map.isReal && !session.readOnly && n > 0;
    banner.el.hidden = !show;
    if (show) banner.set({text: COPY.markers(n)});
    return show;
  }
  const offs = [map.subscribe(() => render()), practice?.value?.subscribe?.(() => render()) ?? (() => {})];
  render();
  return {
    el: banner.el, render,
    destroy() { for (const off of offs) off?.(); action.destroy(); banner.destroy(); },
  };
}
