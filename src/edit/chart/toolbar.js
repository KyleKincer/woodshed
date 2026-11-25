// Edit · Chart toolbar (spec §5.2, maps/notation.md §12.2): 44 px (52 on coarse pointers), drawn from the
// workspace's state() and driving it through the registry (commands.js) or run(). It reads like the note-input
// bar of a notation program: what the next note is worth, how it is played, then the menus.
//
//   createToolbar({run, registry, openMenu(name, anchor), saveStatus}) → {el, update(state), destroy()}
//     run(action, ...args)    the workspace's run (setters with no command: tuplet, roll, grid)
//     openMenu(name, anchor)  opens 'tuplet' | 'roll' | 'edit' | 'part' | 'grid' under its button
//     saveStatus              true: draw the save status here (no posture bar with a status slot is present)
//
// Items, left to right:
//   Step        the five note values as glyphs (quarter … 64th) with key-cap hints 5·4·3·2·1 (D18; Kbd hints show
//               only after keyboard use on fine pointers, spec §5.0), Dotted, Tuplet ▾
//   Articulation  Accent · Heavy accent · Ghost note · Flam · Drag · Roll ▾ · R · L: they show and change the
//               selected notes, or the next note written when nothing is selected
//   Skip (R)    a rest: move on a step without writing
//   in Lanes only, Grid ▾ and Fit
//   Edit ▾ and Part ▾, at the far end
// Undo and Redo are the posture bar's; where the cursor is, the piece being written, Score · Lanes, Follow and
// the zoom are the status bar's (statusbar.js); sections are the navigator's (navigator.js).

import {registry as appRegistry} from '../../app/commands.js';
import {Button, IconButton} from '../../ui/button.js';
import {h} from '../../ui/h.js';
import {Kbd} from '../../ui/kbd.js';
import {Toggle} from '../../ui/toggle.js';
import {COPY} from './menus.js';
import {COPY as COMMANDS, STEP_VALUE} from './commands.js';

/** Step buttons left to right (coarse to fine) with their digit (D18: 5 = 1/4 … 1 = 1/64). */
export const STEP_BUTTONS = Object.freeze([5, 4, 3, 2, 1].map(digit => Object.freeze({digit, value: STEP_VALUE[digit]})));
/** The glyph of each note value (src/styles/icons-custom). */
export const STEP_ICONS = Object.freeze({4: 'note-quarter', 8: 'note-eighth', 16: 'note-sixteenth', 32: 'note-thirty-second', 64: 'note-sixty-fourth'});
/** The articulation toggles: [expression key, command, icon]. */
export const ARTICULATIONS = Object.freeze([
  ['accent', 'chart.accent', 'accent'],
  ['heavy', 'chart.heavy', 'accent-heavy'],
  ['ghost', 'chart.ghost', 'ghost-note'],
  ['flam', 'chart.flam', 'flam'],
  ['drag', 'chart.drag', 'drag'],
].map(Object.freeze));

export function createToolbar({run, registry = appRegistry, openMenu, saveStatus = false} = {}) {
  const parts = [];
  const add = p => { parts.push(p); return p; };
  // `accessibleName` keeps the name fixed ('Tuplet') while the label shows the value ('Triplet').
  const menuButton = (name, label, {className = '', icon, accessibleName = null} = {}) => add(Button({
    label, icon, iconEnd: 'chevron-down', size: 'sm', variant: 'quiet', className: `chart-tool-menu ${className}`.trim(),
    attrs: {'aria-haspopup': 'menu', 'aria-label': accessibleName}, dataset: {menu: name},
    onClick: e => openMenu?.(name, e.currentTarget),
  }));

  // Step: the note values, the dot and the tuplet
  const steps = STEP_BUTTONS.map(({digit, value}) => {
    const b = add(IconButton({
      label: COPY.stepNames[value], icon: STEP_ICONS[value], size: 'sm', variant: 'quiet', className: 'chart-tool-step chart-tool-glyph',
      command: `chart.step.${digit}`, registry, title: COPY.stepNames[value], dataset: {step: value},
    }));
    const cap = add(Kbd({keys: `Digit${digit}`, hint: true, className: 'chart-tool-cap'}));
    cap.el.setAttribute('aria-hidden', 'true');
    b.el.append(cap.el);
    return {b, value};
  });
  const dotted = add(Toggle({label: COPY.dotted, icon: 'note-dotted', iconOnly: true, size: 'sm', variant: 'quiet',
    className: 'chart-tool-dot chart-tool-glyph', command: 'chart.dot', registry, title: COPY.dotted}));
  const tuplet = menuButton('tuplet', '', {className: 'chart-tool-tuplet chart-tool-glyph', icon: 'tuplet', accessibleName: COPY.tuplet});

  // Articulation
  const articulations = ARTICULATIONS.map(([key, command, icon]) => ({key, toggle: add(Toggle({
    label: COMMANDS[key], icon, iconOnly: true, size: 'sm', variant: 'quiet', className: 'chart-tool-art chart-tool-glyph',
    command, registry, title: COMMANDS[key], dataset: {expression: key},
  }))}));
  const roll = menuButton('roll', '', {className: 'chart-tool-roll chart-tool-glyph', icon: 'roll', accessibleName: COPY.roll});
  const stickings = [['R', 'chart.stickingRight'], ['L', 'chart.stickingLeft']].map(([hand, command]) => add(Toggle({
    label: hand, size: 'sm', variant: 'quiet', className: 'chart-tool-hand', command, registry,
    attrs: {'aria-label': COMMANDS[hand === 'R' ? 'stickingRight' : 'stickingLeft']}, title: COMMANDS[hand === 'R' ? 'stickingRight' : 'stickingLeft'],
    dataset: {sticking: hand},
  })));

  // Skip: the rest
  const skip = add(Button({label: COPY.skip, icon: 'rest', size: 'sm', variant: 'quiet', className: 'chart-tool-skip', command: 'chart.skip', registry}));
  const skipCap = add(Kbd({keys: 'KeyR', hint: true}));
  skip.el.append(skipCap.el);

  // Lanes only
  const grid = menuButton('grid', `${COPY.grid}: ${COPY.gridValue(16)}`, {className: 'chart-tool-grid', accessibleName: COPY.grid});
  const fit = add(Button({label: COPY.fit, icon: 'scan', size: 'sm', variant: 'quiet', className: 'chart-tool-fit', command: 'chart.fit', registry}));

  const edit = menuButton('edit', COPY.edit);
  const part = menuButton('part', COPY.part);

  // Save status (only without a posture bar)
  const statusText = h('span', {class: 'chart-tool-save-text'});
  const statusAction = add(Button({label: COPY.review, size: 'sm', variant: 'quiet', className: 'chart-tool-save-action'}));
  statusAction.el.hidden = true;
  const status = saveStatus
    ? h('div', {class: 'chart-tool-save', role: 'status', 'aria-label': COPY.saveStatus}, statusText, statusAction.el)
    : null;

  const group = (name, label, ...children) => h('div', {class: `chart-tool-group chart-tool-${name}`, role: 'group', 'aria-label': label}, ...children);
  const lanesGroup = group('lanes', COPY.lanes, grid.el, fit.el);
  const menusGroup = group('menus', COPY.menus, edit.el, part.el);
  const el = h('div', {class: 'chart-toolbar', role: 'toolbar', 'aria-label': COPY.toolbar},
    group('steps', COPY.steps, ...steps.map(s => s.b.el), dotted.el, tuplet.el),
    group('arts', COPY.articulation, ...articulations.map(a => a.toggle.el), roll.el, ...stickings.map(s => s.el)),
    group('entry', COPY.skip, skip.el),
    lanesGroup,
    menusGroup,
    status,
  );
  // A role=toolbar is one tab stop with arrow keys in the ARIA pattern; this one keeps every control tabbable (the
  // spec's buttons stand in for key-caps on touch) and lets the dispatcher route keys.

  let last = null;
  function update(state) {
    if (!state) return;
    last = state;
    el.dataset.layout = state.layout;
    for (const {b, value} of steps) b.set({pressed: state.step.value === value});
    dotted.set({pressed: !!state.step.dotted});
    // The tuplet button names its value once one is chosen ("Triplet"); straight, it is the glyph alone.
    const tupleted = state.step.tuplet > 1;
    tuplet.set({label: tupleted ? COPY.tupletNames[state.step.tuplet] ?? '' : '', dataset: {menu: 'tuplet', active: tupleted},
      title: tupleted ? `${COPY.tuplet}: ${COPY.tupletNames[state.step.tuplet] ?? ''}` : COPY.tuplet});
    const x = state.expression ?? {};
    const rolled = (x.roll || 0) > 0;
    roll.set({label: rolled ? COPY.rollShort(x.roll) : '', dataset: {menu: 'roll', active: rolled},
      title: rolled ? `${COPY.roll}: ${COPY.rollNames[x.roll] ?? ''}` : COPY.roll});
    const lanes = state.layout === 'lanes';
    lanesGroup.hidden = !lanes;
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
    /** Edit ▾ and Part ▾: iPad portrait moves them beside the inspector buttons, so the docked toolbar is one row. */
    menus: menusGroup,
    /** Puts Edit ▾ and Part ▾ back at the toolbar's far end. */
    dockMenus() { el.insertBefore(menusGroup, status); },
    update,
    get state() { return last; },
    destroy() { for (const p of parts) p.destroy?.(); el.remove(); },
  };
}
