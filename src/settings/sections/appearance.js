// Settings → Appearance (architecture §2.17, §2.5, D3, D40; spec §6.2, §8.6): Theme (System · Light ·
// Dark) and Stage (Match theme · Always dark, the default) are this device's prefs (`prefs.theme`,
// `prefs.stage`); prefs.js applies them at once through window.woodshedAppearance and tells the
// desktop app the theme. Reduce motion is not a setting: a note says it follows the system, and
// whether the system has it on now.

import '../../styles/views/settings/sections.css';
import {h} from '../../ui/h.js';
import {Segmented} from '../../ui/segmented.js';
import {createSaver, settingRow} from '../settings.js';
import {COPY, SECTION_TITLES} from '../settings.copy.js';

const A = COPY.appearance;

function render(el, ctx) {
  const {prefs, platform} = ctx;
  const parts = [];
  const offs = [];
  const keep = part => { parts.push(part); return part; };

  function choiceRow(row, copy, values, labels) {
    let seg;
    const saver = keep(createSaver({focus: () => seg.el.querySelector('[aria-checked=true]')}));
    const r = settingRow({row, label: copy.label, hint: copy.hint ?? null, scope: 'device', saver});
    seg = keep(Segmented({
      attrs: {'aria-labelledby': r.labelId},
      options: values.map((value, i) => ({value, label: labels[i]})),
      value: prefs.get(row),
      onChange: value => saver.run(() => prefs.set(row, value)),
    }));
    r.el.querySelector('.settings-row-control').prepend(seg.el);
    return {row: r, seg};
  }

  const theme = choiceRow('theme', A.theme, ['system', 'light', 'dark'], [A.theme.system, A.theme.light, A.theme.dark]);
  const stage = choiceRow('stage', A.stage, ['match', 'dark'], [A.stage.match, A.stage.dark]);
  offs.push(prefs.value.subscribe(() => {
    theme.seg.set({value: prefs.get('theme')});
    stage.seg.set({value: prefs.get('stage')});
  }));

  const motionState = h('span', {class: 'settings-note-state'});
  const showMotion = () => { motionState.textContent = platform?.reducedMotion?.peek?.() ? A.motionOn : A.motionOff; };
  showMotion();
  if (platform?.reducedMotion?.subscribe) offs.push(platform.reducedMotion.subscribe(showMotion));
  const motion = h('div', {class: 'settings-row', dataset: {scope: 'info', row: 'motion'}},
    h('p', {class: 'settings-note'}, h('span', {}, A.motion), ' ', motionState));

  const page = h('div', {class: 'settings-section', dataset: {section: 'appearance'}},
    h('div', {class: 'settings-group'}, theme.row.el, stage.row.el, motion));
  el.replaceChildren(page);

  return {
    destroy() {
      for (const off of offs.splice(0)) off();
      for (const part of parts.splice(0)) part.destroy();
      page.remove();
    },
  };
}

export default Object.freeze({id: 'appearance', title: SECTION_TITLES.appearance, render});
