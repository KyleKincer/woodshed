// The InstrumentPicker (architecture §2.19, D37; spec §6.6.2, §6.2 Instruments, §4.7 Mix sheet):
// "What do you play?" as 56 px multi-select chips plus "When you open a song: [Hear everything]
// [Start with my part out]". Shared by /welcome, Settings → Instruments and the Mix sheet's
// "I play: … ▾". It edits a Profile and never saves: the host writes it (account.patch).
//
//   InstrumentPicker({value, onChange(profile, {change}), label, labelledBy, openWith = true,
//                     mapping = false, disabled = false, …}) → {el, value, set(partial), destroy()}
//     value       Profile {instruments, primary, openWithMyPart}; normalised on the way in
//     onChange    after each user change; change: 'instruments' | 'openWithMyPart'
//     label       the chip group's accessible name (default "What do you play?"), unless
//     labelledBy  names an element that labels it (/welcome's heading)
//     openWith    false hides the open-with-my-part choice (the Mix sheet's inline picker)
//     mapping     true lists the stem mapping in plain words under the chips (Settings)
//     disabled    every control refuses input (aria-disabled), e.g. while the host saves
//   set({value}) re-renders without calling onChange.
//
// Primary rule: the first instrument tapped is primary (the ChipGroup "Primary" badge). Adding more
// keeps it; removing the primary hands it to the earliest-chosen instrument left, as
// settings.patch does on the server (Appendix C item 29). Instruments stay in the order chosen.
//
//   normaliseProfile(value) → Profile                known instruments only, deduplicated, a valid
//                                                     primary, openWithMyPart 'in' unless 'out'
//   withInstruments(profile, instruments) → Profile  the primary rule above, for a new chip list

import '../styles/views/onboarding/instruments.css';
import {h} from '../ui/h.js';
import {ChipGroup} from '../ui/chip.js';
import {Segmented} from '../ui/segmented.js';
import {INSTRUMENTS, describeMapping} from '../app/profile.js';
import {COPY, INSTRUMENT_LABELS} from './onboarding.copy.js';

const OPEN_WITH = Object.freeze(['in', 'out']);

/** A clean Profile from anything (an account value, a partial, null). */
export function normaliseProfile(value) {
  const list = value && Array.isArray(value.instruments) ? value.instruments : [];
  const instruments = [];
  for (const instrument of list) if (INSTRUMENTS.includes(instrument) && !instruments.includes(instrument)) instruments.push(instrument);
  const primary = instruments.includes(value?.primary) ? value.primary : instruments[0] ?? null;
  const openWithMyPart = OPEN_WITH.includes(value?.openWithMyPart) ? value.openWithMyPart : 'in';
  return {instruments, primary, openWithMyPart};
}

/** `profile` with a new instrument list: the primary stays while chosen, else the earliest left (or the first tapped). */
export function withInstruments(profile, instruments) {
  const current = normaliseProfile(profile);
  const next = normaliseProfile({...current, instruments, primary: null});
  next.primary = next.instruments.includes(current.primary) ? current.primary : next.instruments[0] ?? null;
  return next;
}

const sameProfile = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let seq = 0;

export function InstrumentPicker(props = {}) {
  let p = {openWith: true, mapping: false, disabled: false, ...props};
  let profile = normaliseProfile(p.value);
  const id = `onboarding-instruments-${++seq}`;

  const groupNaming = () => (p.labelledBy
    ? {attrs: {'aria-labelledby': p.labelledBy}, label: undefined}
    : {attrs: {}, label: p.label ?? COPY.picker.label});
  const options = () => INSTRUMENTS.map(value => ({value, label: INSTRUMENT_LABELS[value], disabled: !!p.disabled}));

  const chips = ChipGroup({
    ...groupNaming(),
    className: 'onboarding-instruments-chips',
    multiple: true,
    options: options(),
    value: profile.instruments,
    primary: profile.primary,
    onChange: values => {
      profile = withInstruments(profile, values);
      render();
      p.onChange?.({...profile, instruments: [...profile.instruments]}, {change: 'instruments'});
    },
  });

  const mappingList = h('ul', {class: 'onboarding-instruments-mapping', attrs: {'aria-label': COPY.picker.mappingLabel}});

  const openLabelId = `${id}-open`;
  const openLabel = h('p', {class: 'onboarding-instruments-open-label', attrs: {id: openLabelId}}, COPY.picker.openWithLabel);
  const segmentedOptions = () => [
    {value: 'in', label: COPY.picker.hearEverything, disabled: !!p.disabled},
    {value: 'out', label: COPY.picker.partOut, disabled: !!p.disabled},
  ];
  const openWith = Segmented({
    attrs: {'aria-labelledby': openLabelId},
    className: 'onboarding-instruments-open-choice',
    size: 'lg',
    options: segmentedOptions(),
    value: profile.openWithMyPart,
    onChange: value => {
      profile = {...profile, openWithMyPart: value};
      p.onChange?.({...profile, instruments: [...profile.instruments]}, {change: 'openWithMyPart'});
    },
  });
  const openRow = h('div', {class: 'onboarding-instruments-open'}, openLabel, openWith.el);

  const el = h('div', {class: 'onboarding-instruments', attrs: {id}}, chips.el, mappingList, openRow);

  function render() {
    chips.set({...groupNaming(), options: options(), value: profile.instruments, primary: profile.primary});
    openWith.set({options: segmentedOptions(), value: profile.openWithMyPart});
    el.toggleAttribute('data-disabled', !!p.disabled);
    openRow.hidden = !p.openWith;
    const lines = p.mapping ? describeMapping(profile) : [];
    mappingList.replaceChildren(...lines.map(line => h('li', {}, line)));
    mappingList.hidden = !lines.length;
  }

  render();

  return {
    el,
    /** The current Profile (a copy). */
    get value() { return {...profile, instruments: [...profile.instruments]}; },
    set(partial = {}) {
      p = {...p, ...partial};
      if ('value' in partial) {
        const next = normaliseProfile(partial.value);
        if (!sameProfile(next, profile)) profile = next;
      }
      render();
    },
    destroy() {
      chips.destroy();
      openWith.destroy();
      el.remove();
    },
  };
}
