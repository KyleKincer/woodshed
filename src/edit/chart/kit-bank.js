// The iPad portrait kit pad bank (spec §5.2, maps/notation.md §12.6): docked under the toolbar, 4 rows × 7 pads
// of 56 px grouped by colour (the piece's family), with Skip in the last slot and ◂ ▸ to step the cursor, so touch
// entry never needs a keyboard. A tap writes at the cursor (or auditions, with Audition only on in the Kit tab), the
// same as the Kit tab's pads; a long-press auditions without writing.
//
//   createKitBank({run}) → {el, update(state), destroy()}
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
export const PAD_LONG_PRESS_MS = 500;

export function createKitBank({run} = {}) {
  const parts = [];
  const pads = new Map();
  const rows = BANK_ROWS.map((ids, r) => h('div', {class: 'chart-bank-row', role: 'group', 'aria-label': `Row ${r + 1}`},
    ...ids.map(id => {
      if (id === 'skip') {
        const skip = Button({label: COPY.skip, icon: 'arrow-right', size: 'lg', className: 'chart-bank-pad chart-bank-skip',
          onClick: () => run?.('skip')});
        parts.push(skip);
        return skip.el;
      }
      const kit = kitPiece(id);
      const pad = Button({
        label: kit.short, size: 'lg', className: 'chart-bank-pad', dataset: {kit: kit.id, family: kit.family},
        attrs: {'aria-label': kit.name}, pressed: false, longPressMs: PAD_LONG_PRESS_MS,
        onClick: () => run?.('pad', kit.id),
        onLongPress: () => run?.('audition', kit.id),
      });
      parts.push(pad);
      pads.set(kit.id, pad);
      return pad.el;
    })));
  const back = IconButton({label: COPY.stepBack, icon: 'chevron-left', size: 'lg', className: 'chart-bank-step', onClick: () => run?.('cursor', -1)});
  const forward = IconButton({label: COPY.stepForward, icon: 'chevron-right', size: 'lg', className: 'chart-bank-step', onClick: () => run?.('cursor', 1)});
  parts.push(back, forward);
  const el = h('div', {class: 'chart-bank', role: 'group', 'aria-label': COPY.kitBank},
    h('div', {class: 'chart-bank-pads'}, ...rows),
    h('div', {class: 'chart-bank-nav'}, back.el, forward.el));

  let current = null;
  return {
    el,
    update(state) {
      const piece = state?.piece?.id ?? null;
      if (piece === current) return;
      if (current) pads.get(current)?.set({pressed: false});
      current = piece;
      if (piece) pads.get(piece)?.set({pressed: true});
    },
    destroy() { for (const p of parts) p.destroy(); el.remove(); },
  };
}
