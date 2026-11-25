// The kit pad bank under the sheet on touch layouts (spec §5.2, maps/notation.md §12.6), so touch entry never needs
// a keyboard. A tap writes at the cursor (or auditions, with Audition only on in the Kit tab), the same as the Kit
// tab's pads; a long-press auditions without writing. ◂ ▸ beside the pads step the cursor.
//   iPad portrait   4 rows × 7 pads of 56 px grouped by colour (the piece's family), with Skip in the last slot.
//   a phone         `compact`: 2 rows × 6 pads a page, three pages that swipe sideways. The first page is the core
//                   kit (hats, crash, ride, bell, cross-stick · kick, snare, two toms, pedal hat, Skip), so a groove
//                   is written without swiping and the sheet keeps the height of the two rows it gets back.
//
//   createKitBank({run, compact}) → {el, update(state), set({compact}), destroy()}
//     run(action, ...args)   the workspace's run: 'pad' (kitId), 'audition' (kitId), 'skip', 'cursor' (±1)

import {Button, IconButton} from '../../ui/button.js';
import {h} from '../../ui/h.js';
import {kitPiece} from '../../../shared/notation.ts';
import {COPY} from './menus.js';

/** The bank's 4 × 7 layout (27 pieces and Skip). */
export const BANK_ROWS = Object.freeze([
  Object.freeze(['crash', 'crash2', 'ride', 'rideBell', 'rideEdge', 'china', 'splash']),
  Object.freeze(['closedHat', 'halfHat', 'openHat', 'crashChoke', 'crash2Choke', 'rideChoke', 'chinaChoke']),
  Object.freeze(['snare', 'rimshot', 'crossStick', 'tom1', 'rackTom', 'tom3', 'tom4']),
  Object.freeze(['floorTom', 'floorTom2', 'kick', 'pedalHat', 'cowbell', 'splashChoke', 'skip']),
]);
/** The phone's pages, each two rows of six: the core kit and Skip, the rest of the kit, the chokes. */
export const BANK_PAGES = Object.freeze([
  Object.freeze([Object.freeze(['closedHat', 'openHat', 'crash', 'ride', 'rideBell', 'crossStick']), Object.freeze(['kick', 'snare', 'rackTom', 'floorTom', 'pedalHat', 'skip'])]),
  Object.freeze([Object.freeze(['halfHat', 'crash2', 'china', 'splash', 'rideEdge', 'cowbell']), Object.freeze(['rimshot', 'tom1', 'tom3', 'tom4', 'floorTom2'])]),
  Object.freeze([Object.freeze(['crashChoke', 'crash2Choke', 'rideChoke', 'chinaChoke', 'splashChoke'])]),
]);
export const PAD_LONG_PRESS_MS = 500;

export function createKitBank({run, compact = false} = {}) {
  const parts = [];
  const pads = new Map();
  const skip = Button({label: COPY.skip, icon: 'arrow-right', size: 'lg', className: 'chart-bank-pad chart-bank-skip',
    onClick: () => run?.('skip')});
  parts.push(skip);
  for (const id of BANK_ROWS.flat()) {
    if (id === 'skip') continue;
    const kit = kitPiece(id);
    const pad = Button({
      label: kit.short, size: 'lg', className: 'chart-bank-pad', dataset: {kit: kit.id, family: kit.family},
      attrs: {'aria-label': kit.name}, pressed: false, longPressMs: PAD_LONG_PRESS_MS,
      onClick: () => run?.('pad', kit.id),
      onLongPress: () => run?.('audition', kit.id),
    });
    parts.push(pad);
    pads.set(kit.id, pad);
  }
  const padEl = id => (id === 'skip' ? skip.el : pads.get(id).el);
  let rowCount = 0;
  const row = ids => h('div', {class: 'chart-bank-row', role: 'group', 'aria-label': `Row ${++rowCount}`}, ...ids.map(padEl));
  const padsEl = h('div', {class: 'chart-bank-pads'});
  // The phone's pages fill the width, so dots under them say there are more and which one shows.
  const dots = h('div', {class: 'chart-bank-dots', 'aria-hidden': 'true', hidden: true});
  function showDots() {
    const page = padsEl.clientWidth > 0 ? Math.round(padsEl.scrollLeft / padsEl.clientWidth) : 0;
    [...dots.children].forEach((dot, i) => dot.toggleAttribute('data-current', i === page));
  }
  padsEl.addEventListener('scroll', showDots, {passive: true});
  function lay() {
    rowCount = 0;
    padsEl.toggleAttribute('data-compact', compact);
    if (compact) padsEl.replaceChildren(...BANK_PAGES.map(page => h('div', {class: 'chart-bank-page'}, ...page.map(row))));
    else padsEl.replaceChildren(...BANK_ROWS.map(row));
    dots.hidden = !compact;
    dots.replaceChildren(...(compact ? BANK_PAGES.map(() => h('span', {class: 'chart-bank-dot'})) : []));
    showDots();
  }
  lay();
  const back = IconButton({label: COPY.stepBack, icon: 'chevron-left', size: 'lg', className: 'chart-bank-step', onClick: () => run?.('cursor', -1)});
  const forward = IconButton({label: COPY.stepForward, icon: 'chevron-right', size: 'lg', className: 'chart-bank-step', onClick: () => run?.('cursor', 1)});
  parts.push(back, forward);
  const el = h('div', {class: 'chart-bank', role: 'group', 'aria-label': COPY.kitBank},
    h('div', {class: 'chart-bank-main'}, padsEl, dots),
    h('div', {class: 'chart-bank-nav'}, back.el, forward.el));

  let current = null;
  /** A phone's pages swipe sideways: the page of the piece being written is brought into view. */
  function showPage(id) {
    const page = compact ? pads.get(id)?.el.closest('.chart-bank-page') : null;
    if (!page) return;
    if (page.offsetLeft < padsEl.scrollLeft || page.offsetLeft + page.offsetWidth > padsEl.scrollLeft + padsEl.clientWidth) padsEl.scrollLeft = page.offsetLeft;
  }
  return {
    el,
    get compact() { return compact; },
    update(state) {
      const piece = state?.piece?.id ?? null;
      if (piece === current) return;
      if (current) pads.get(current)?.set({pressed: false});
      current = piece;
      if (piece) { pads.get(piece)?.set({pressed: true}); showPage(piece); }
    },
    set({compact: next} = {}) {
      if (next === undefined || !!next === compact) return;
      compact = !!next;
      lay();
      if (current) showPage(current);
    },
    destroy() { for (const p of parts) p.destroy(); el.remove(); },
  };
}
