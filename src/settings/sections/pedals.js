// Settings → Pedals & keys (architecture §2.17, §9.10 SE1; spec §6.2, §7.2): this package's part is
// "View keyboard shortcuts", which opens the ? sheet (app.shortcuts) generated from the registry.
// PD1 adds pedal mode, the profile, Learn my pedal, the mapping table, background shortcuts
// (desktop) and MIDI devices to this section.

import '../../styles/views/settings/sections.css';
import {h} from '../../ui/h.js';
import {Button, uid} from '../../ui/button.js';
import {settingRow} from '../settings.js';
import {COPY, SECTION_TITLES} from '../settings.copy.js';

function render(el, ctx) {
  const id = uid('settings-row');
  const shortcuts = Button({
    command: 'app.shortcuts', registry: ctx.registry, label: COPY.pedals.shortcuts, icon: 'keyboard', kbd: true,
    className: 'settings-shortcuts', attrs: {'aria-describedby': `${id}-hint`},
  });
  const row = settingRow({row: 'shortcuts', hint: COPY.pedals.hint, scope: 'info', controls: [shortcuts], labelId: id});
  const page = h('div', {class: 'settings-section', dataset: {section: 'pedals'}}, h('div', {class: 'settings-group'}, row.el));
  el.replaceChildren(page);
  return {
    destroy() {
      shortcuts.destroy();
      page.remove();
    },
  };
}

export default Object.freeze({id: 'pedals', title: SECTION_TITLES.pedals, render});
