// Edit · Chart toolbar (spec §5.2, maps/notation.md §12.2): 44 px (52 on coarse pointers), drawn from the
// workspace's state() and driving it through the registry (commands.js) or run().
//
//   createToolbar({run, registry, openMenu(name, anchor), saveStatus}) → {el, update(state), destroy()}
//     run(action, ...args)    the workspace's run (setters with no command: tuplet, grid)
//     openMenu(name, anchor)  opens 'view' | 'tuplet' | 'edit' | 'part' | 'sections' | 'grid' under its button
//     saveStatus              true: draw the save status here (no posture bar with a status slot is present)
//
// Items, left to right: View Score · Lanes (+ View ▾), steps ♩ 1/4 · ♪ 1/8 · 1/16 · 1/32 · 1/64 with key-cap hints
// 5·4·3·2·1 (D18; Kbd hints show only after keyboard use on fine pointers, spec §5.0), • Dotted, Tuplet ▾, Skip (R),
// "Writing: Snare (S)", ↶ Undo ↷ Redo (text and glyph at ≥ 1200 px, glyph and accessible name below), the range
// "Bars 17–32" with ‹ › and the section jump menu, Edit ▾ and Part ▾; in Lanes only, Grid ▾ and Fit.

import {registry as appRegistry} from '../../app/commands.js';
import {Button, IconButton} from '../../ui/button.js';
import {h} from '../../ui/h.js';
import {Kbd} from '../../ui/kbd.js';
import {Segmented} from '../../ui/segmented.js';
import {Toggle} from '../../ui/toggle.js';
import {COPY} from './menus.js';
import {COPY as COMMANDS, STEP_VALUE} from './commands.js';

/** Step buttons left to right (coarse to fine) with their digit (D18: 5 = 1/4 … 1 = 1/64). */
export const STEP_BUTTONS = Object.freeze([5, 4, 3, 2, 1].map(digit => Object.freeze({digit, value: STEP_VALUE[digit]})));

export function createToolbar({run, registry = appRegistry, openMenu, saveStatus = false} = {}) {
  const parts = [];
  const add = p => { parts.push(p); return p; };
  // `name` keeps the accessible name fixed ('Tuplet') while the label shows the value ('Tuplet: Triplet').
  const menuButton = (name, label, {className = '', icon, accessibleName = null} = {}) => add(Button({
    label, icon, iconEnd: 'chevron-down', size: 'sm', variant: 'quiet', className: `chart-tool-menu ${className}`.trim(),
    attrs: {'aria-haspopup': 'menu', 'aria-label': accessibleName}, dataset: {menu: name},
    onClick: e => openMenu?.(name, e.currentTarget),
  }));

  // View
  const view = add(Segmented({
    label: COPY.view, size: 'sm', className: 'chart-tool-view', value: 'score',
    options: [{value: 'score', label: COPY.score}, {value: 'lanes', label: COPY.lanes}],
    onChange: v => registry.run('chart.view', {source: 'pointer', args: {view: v}}),
  }));
  const viewMenu = add(IconButton({label: COPY.viewOptions, icon: 'chevron-down', size: 'sm', variant: 'quiet',
    attrs: {'aria-haspopup': 'menu'}, dataset: {menu: 'view'}, onClick: e => openMenu?.('view', e.currentTarget)}));

  // Steps
  const steps = STEP_BUTTONS.map(({digit, value}) => {
    const b = add(Button({
      label: COPY.stepLabels[value], size: 'sm', className: 'chart-tool-step', command: `chart.step.${digit}`, registry,
      attrs: {'aria-label': COPY.stepNames[value]}, title: `${COPY.stepNames[value]} · ${digit}`, dataset: {step: value},
    }));
    const cap = add(Kbd({keys: `Digit${digit}`, hint: true}));
    b.el.append(cap.el);
    return {b, value};
  });
  const dotted = add(Toggle({label: COPY.dotted, size: 'sm', className: 'chart-tool-dot', command: 'chart.dot', registry}));
  const tuplet = menuButton('tuplet', `${COPY.tuplet}: ${COPY.tupletNames[1]}`, {className: 'chart-tool-tuplet', accessibleName: COPY.tuplet});
  const skip = add(Button({label: COPY.skip, size: 'sm', className: 'chart-tool-skip', command: 'chart.skip', registry}));
  const skipCap = add(Kbd({keys: 'KeyR', hint: true}));
  skip.el.append(skipCap.el);

  // Writing: Snare (S)
  const pieceName = h('strong', {class: 'chart-tool-piece-name'});
  const pieceCap = add(Kbd({keys: '', force: true}));
  const writing = h('p', {class: 'chart-tool-writing'}, h('span', {class: 'chart-tool-writing-label'}, COPY.writing), ' ', pieceName, ' ', pieceCap.el);

  // Undo / Redo
  // The text hides below 1200 px (chart.css); aria-label keeps the name.
  const undo = add(Button({label: COPY.undo, icon: 'undo-2', size: 'sm', className: 'chart-tool-history', command: 'chart.undo', registry,
    attrs: {'aria-label': COPY.undo}}));
  const redo = add(Button({label: COPY.redo, icon: 'redo-2', size: 'sm', className: 'chart-tool-history', command: 'chart.redo', registry,
    attrs: {'aria-label': COPY.redo}}));

  // Range
  const rangeText = h('span', {class: 'chart-tool-range-text', 'aria-live': 'off'});
  const prev = add(IconButton({label: COMMANDS.pagePrev, icon: 'chevron-left', size: 'sm', command: 'chart.pagePrev', registry}));
  const next = add(IconButton({label: COMMANDS.pageNext, icon: 'chevron-right', size: 'sm', command: 'chart.pageNext', registry}));
  const sections = menuButton('sections', COPY.sections, {className: 'chart-tool-sections'});

  const edit = menuButton('edit', COPY.edit);
  const part = menuButton('part', COPY.part);

  // Lanes only
  const grid = menuButton('grid', `${COPY.grid}: ${COPY.gridValue(16)}`, {className: 'chart-tool-grid', accessibleName: COPY.grid});
  const fit = add(Button({label: COPY.fit, icon: 'scan', size: 'sm', className: 'chart-tool-fit', command: 'chart.fit', registry}));

  // Save status (only without a posture bar)
  const statusText = h('span', {class: 'chart-tool-save-text'});
  const statusAction = add(Button({label: COPY.review, size: 'sm', variant: 'quiet', className: 'chart-tool-save-action'}));
  statusAction.el.hidden = true;
  const status = saveStatus
    ? h('div', {class: 'chart-tool-save', role: 'status', 'aria-label': COPY.saveStatus}, statusText, statusAction.el)
    : null;

  const group = (name, label, ...children) => h('div', {class: `chart-tool-group chart-tool-${name}`, role: 'group', 'aria-label': label}, ...children);
  const el = h('div', {class: 'chart-toolbar', role: 'toolbar', 'aria-label': COPY.toolbar},
    group('views', COPY.view, view.el, viewMenu.el),
    group('steps', COPY.steps, ...steps.map(s => s.b.el), dotted.el, tuplet.el, skip.el),
    writing,
    group('history', `${COPY.undo} and ${COPY.redo}`, undo.el, redo.el),
    group('range', 'Bars', rangeText, prev.el, next.el, sections.el),
    group('lanes', 'Lanes', grid.el, fit.el),
    group('menus', 'Menus', edit.el, part.el),
    status,
  );
  // A role=toolbar is one tab stop with arrow keys in the ARIA pattern; this one keeps every control tabbable (the
  // spec's buttons stand in for key-caps on touch) and lets the dispatcher route keys.

  let last = null;
  function update(state) {
    if (!state) return;
    last = state;
    el.dataset.layout = state.layout;
    view.set({value: state.layout});
    for (const {b, value} of steps) b.set({pressed: state.step.value === value});
    dotted.set({pressed: !!state.step.dotted});
    tuplet.set({label: `${COPY.tuplet}: ${COPY.tupletNames[state.step.tuplet] ?? COPY.tupletNames[1]}`});
    pieceName.textContent = state.piece.name;
    pieceCap.set({keys: state.piece.key || ''});
    pieceCap.el.hidden = !state.piece.key;
    const {first, last: lastBar, total} = state.range;
    rangeText.textContent = total ? COPY.bars(first + 1, lastBar + 1) : '';
    rangeText.title = total ? COPY.barsOf(first + 1, lastBar + 1, total) : '';
    const lanes = state.layout === 'lanes';
    el.querySelector('.chart-tool-lanes').hidden = !lanes;
    grid.set({label: `${COPY.grid}: ${COPY.gridValue(state.grid.value)}${state.grid.triplet ? ` ${COPY.triplet}` : ''}`});
    if (status) {
      statusText.textContent = state.statusText;
      el.dataset.save = state.status;
      statusAction.el.hidden = !state.recovery;
      if (state.recovery) {
        statusAction.set({label: state.recovery === 'resolve' ? COPY.review : COPY.retry,
          onClick: () => run?.(state.recovery === 'resolve' ? 'resolve' : 'retry-save')});
      }
    }
  }

  return {
    el,
    update,
    get state() { return last; },
    destroy() { for (const p of parts) p.destroy?.(); el.remove(); },
  };
}
