// Edit · Chart's status bar: one quiet line under the sheet, as notation programs have. Left to right:
//   Go to        where the cursor is ("Bar 12 · Beat 2.50"); pressing it opens the Go to menu (first and last bar,
//                previous and next section, every section)
//   Writing      the piece the next note is ("Snare" with its key)
//   the message  what the editor last said ("Looping bars 5–8."), else what is selected ("3 notes selected"),
//                else the hint ("Double-click the staff or press a drum key to add"). A polite live region.
//   Follow       Follow playback, while the song plays (pressed while the sheet follows it; a scroll of your own
//                lets go, and pressing it catches up). Stopped, there is nothing to follow, so it is not shown.
//   View         Score · Lanes
//   Zoom         − 100% +   (Score only; the percentage goes back to 100%)
//
//   createStatusBar({registry, openMenu(name, anchor)}) → {el, update(state), say(text), destroy()}
//     say(text)   the editor's message; '' goes back to the selection or the hint

import {registry as appRegistry} from '../../app/commands.js';
import {Button, IconButton} from '../../ui/button.js';
import {h} from '../../ui/h.js';
import {Kbd} from '../../ui/kbd.js';
import {Segmented} from '../../ui/segmented.js';
import {Toggle} from '../../ui/toggle.js';
import {COPY} from './menus.js';
import {COPY as COMMANDS} from './commands.js';

export function createStatusBar({registry = appRegistry, openMenu} = {}) {
  const parts = [];
  const add = p => { parts.push(p); return p; };

  const position = add(Button({
    label: '', iconEnd: 'chevron-down', size: 'sm', variant: 'quiet', className: 'chart-status-position',
    attrs: {'aria-haspopup': 'menu', 'aria-label': COPY.goTo}, dataset: {menu: 'sections'}, title: COPY.goTo,   // named "Go to: Bar 12 · Beat 2.50" once drawn
    onClick: e => openMenu?.('sections', e.currentTarget),
  }));

  const pieceName = h('strong', {class: 'chart-status-piece-name'});
  const pieceCap = add(Kbd({keys: '', force: true}));
  const piece = h('p', {class: 'chart-status-piece'}, h('span', {class: 'chart-status-piece-label'}, COPY.writing), ' ', pieceName, ' ', pieceCap.el);

  const message = h('p', {class: 'chart-status-message chart-edit-message', role: 'status', 'aria-live': 'polite'});

  const follow = add(Toggle({label: COPY.followShort, size: 'sm', variant: 'quiet', className: 'chart-status-follow',
    command: 'chart.follow', registry, title: COMMANDS.follow}));
  const view = add(Segmented({
    label: COPY.view, size: 'sm', className: 'chart-status-view', value: 'score',
    options: [{value: 'score', label: COPY.score}, {value: 'lanes', label: COPY.lanes}],
    onChange: v => registry.run('chart.view', {source: 'pointer', args: {view: v}}),
  }));
  const zoomOut = add(IconButton({label: COMMANDS.zoomOut, icon: 'minus', size: 'sm', variant: 'quiet', command: 'chart.zoomOut', registry}));
  const zoomValue = add(Button({label: COPY.zoomValue(1), size: 'sm', variant: 'quiet', className: 'chart-status-zoom-value',
    command: 'chart.zoomReset', registry, attrs: {'aria-label': COPY.zoomResetName(1)}, title: COMMANDS.zoomReset}));
  const zoomIn = add(IconButton({label: COMMANDS.zoomIn, icon: 'plus', size: 'sm', variant: 'quiet', command: 'chart.zoomIn', registry}));
  const zoom = h('div', {class: 'chart-status-zoom', role: 'group', 'aria-label': COPY.zoom}, zoomOut.el, zoomValue.el, zoomIn.el);

  const el = h('div', {class: 'chart-status', role: 'group', 'aria-label': COPY.statusBar},
    h('div', {class: 'chart-status-lead'}, position.el, piece),
    message,
    h('div', {class: 'chart-status-trail'}, follow.el, view.el, zoom));

  let said = '', fallback = '', hint = false;
  function paint() {
    const text = said || fallback;
    if (message.textContent !== text) message.textContent = text;
    // The hint is quieter than something the editor said or what is selected.
    message.toggleAttribute('data-hint', !said && hint);
  }

  return {
    el,
    message,
    update(state) {
      if (!state) return;
      // The names hold the visible text (the position, the percentage) and say what pressing does.
      position.set({label: state.position || '', attrs: {'aria-haspopup': 'menu', 'aria-label': state.position ? `${COPY.goTo}: ${state.position}` : COPY.goTo}});
      pieceName.textContent = state.piece?.name ?? '';
      pieceCap.set({keys: state.piece?.key || ''});
      pieceCap.el.hidden = !state.piece?.key;
      zoomValue.set({label: COPY.zoomValue(state.zoom ?? 1), attrs: {'aria-label': COPY.zoomResetName(state.zoom ?? 1)}});
      view.set({value: state.layout});
      zoom.hidden = state.layout !== 'score';
      follow.el.hidden = !state.playing;
      fallback = state.selectionLabel || state.hint || '';
      hint = !state.selectionLabel;
      paint();
    },
    say(text) { said = String(text ?? ''); paint(); },
    destroy() { for (const p of parts) p.destroy?.(); el.remove(); },
  };
}
