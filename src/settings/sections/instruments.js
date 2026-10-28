// Settings → Instruments (architecture §2.17, §2.19, D37; spec §6.2, §6.6.2): "What do you play?" as
// ON1's InstrumentPicker with the stem mapping in plain words (mapping: true), labelled by the section
// heading; "When you open a song: Hear everything / Start with my part out". The profile is an account
// setting: each change saves at once through account.patch({profile}) ("Saved" / "Couldn't save ·
// [Retry]"). The server normalises the profile (deduplicated, a valid primary) and the picker shows
// what it stored. Changes made elsewhere (another device, /welcome, the Mix sheet's "I play") follow.

import '../../styles/views/settings/sections.css';
import {h} from '../../ui/h.js';
import {InstrumentPicker, normaliseProfile} from '../../onboarding/instruments.js';
import {createSaver} from '../settings.js';
import {COPY, SECTION_TITLES} from '../settings.copy.js';

function render(el, ctx) {
  const {account} = ctx;
  let picker;
  const saver = createSaver({focus: () => picker.el.querySelector('button, [role=radio]')});
  picker = InstrumentPicker({
    value: normaliseProfile(account.profile.peek()),
    labelledBy: ctx.headingId,
    mapping: true,
    onChange: profile => saver.run(() => account.patch({profile})),
  });
  const off = account.profile.subscribe(profile => picker.set({value: normaliseProfile(profile)}));

  const page = h('div', {class: 'settings-section', dataset: {section: 'instruments'}},
    h('p', {class: 'settings-intro'}, COPY.instruments.intro),
    h('div', {class: 'settings-row settings-instruments', dataset: {scope: 'account', row: 'profile'}},
      h('div', {class: 'settings-row-control'}, picker.el, saver.el)));
  el.replaceChildren(page);

  return {
    destroy() {
      off();
      picker.destroy();
      saver.destroy();
      page.remove();
    },
  };
}

export default Object.freeze({id: 'instruments', title: SECTION_TITLES.instruments, render});
