// Settings → Practice (architecture §2.17, §2.4, §2.5, D14, D40; spec §6.2, §4.7, §4.10, §4.11, §4.2).
//
// Account defaults (account.practice, every device): When Stop is pressed (Return to cue / Stay),
// Default count-in (Off · 1 bar · 2 bars · 2 beats · Custom 1–16 bars or beats), Default click
// (Off · During count-in only · Always), Count in every loop pass, Keep pitch by default and Keep
// screen awake (5 / 10 / 30 min / Always). The count-in and click defaults seed a song's
// practice.click only while that song has none (D14).
// This device (prefs.practice): Distance (Near · Stand · Kit), Follow style (Scroll / Page with the
// side panel and with the bottom dock) and Flash screen edges on downbeats.
//
// Every control saves on change through its row's saver ("Saved" / "Couldn't save · [Retry]").
// Account rows write through account.patch (optimistic; a failure reverts the value, which the
// controls follow); device rows write prefs at once. Both follow changes made elsewhere (another
// device, another tab, the Stage's ⋯ menu) while the section is open.

import '../../styles/views/settings/sections.css';
import {h} from '../../ui/h.js';
import {Segmented} from '../../ui/segmented.js';
import {Stepper} from '../../ui/stepper.js';
import {Toggle} from '../../ui/toggle.js';
import {uid} from '../../ui/button.js';
import {createSaver, settingRow} from '../settings.js';
import {COPY, SECTION_TITLES} from '../settings.copy.js';

const C = COPY.practice;
const WAKE = [5, 10, 30, 'always'];
const DISTANCES = ['near', 'stand', 'kit'];
const FOLLOW = ['scroll', 'page'];

/** The count-in choice a {on, length, unit} shows: 'off', a preset id, or 'custom'. */
export function countInChoice(countIn) {
  if (!countIn?.on) return 'off';
  const {length, unit} = countIn;
  if (unit === 'bars' && length === 1) return 'oneBar';
  if (unit === 'bars' && length === 2) return 'twoBars';
  if (unit === 'beats' && length === 2) return 'twoBeats';
  return 'custom';
}

const PRESETS = Object.freeze({oneBar: {length: 1, unit: 'bars'}, twoBars: {length: 2, unit: 'bars'}, twoBeats: {length: 2, unit: 'beats'}});

/** The countIn a choice sets, from the current one ('custom' keeps the current length and unit). */
export function countInFor(choice, current) {
  const base = {on: true, length: current?.length ?? 1, unit: current?.unit ?? 'bars'};
  if (choice === 'off') return {...base, on: false};
  if (PRESETS[choice]) return {on: true, ...PRESETS[choice]};
  return base;
}

function render(el, ctx) {
  const {account, prefs} = ctx;
  const practice = () => account.value.peek().practice;
  const offs = [];
  const parts = [];
  const keep = part => { parts.push(part); return part; };

  /** A saver for an account row; `focus()` is where focus goes when its Retry disappears. */
  function accountSaver(focus) {
    return keep(createSaver({focus}));
  }
  const patchPractice = (saver, change) => saver.run(() => account.patch({practice: change}));

  // ---- When Stop is pressed
  let stopSeg;
  const stopSaver = accountSaver(() => stopSeg.el.querySelector('[aria-checked=true]'));
  const stopRow = settingRow({row: 'stop', label: C.stop.label, hint: C.stop.hint, scope: 'account', saver: stopSaver});
  stopSeg = keep(Segmented({
    attrs: {'aria-labelledby': stopRow.labelId},
    options: [{value: 'cue', label: C.stop.cue}, {value: 'stay', label: C.stop.stay}],
    value: practice().stop,
    onChange: value => patchPractice(stopSaver, {stop: value}),
  }));
  stopRow.el.querySelector('.settings-row-control').prepend(stopSeg.el);

  // ---- Default count-in
  let countSeg, lengthStepper, unitSeg;
  let customOpen = countInChoice(practice().countIn) === 'custom';
  const countSaver = accountSaver(() => countSeg.el.querySelector('[aria-checked=true]'));
  const countRow = settingRow({row: 'countIn', label: C.countIn.label, hint: C.countIn.hint, scope: 'account', saver: countSaver});
  const writeCountIn = next => patchPractice(countSaver, {countIn: next});
  countSeg = keep(Segmented({
    attrs: {'aria-labelledby': countRow.labelId},
    options: ['off', 'oneBar', 'twoBars', 'twoBeats', 'custom'].map(value => ({value, label: C.countIn[value]})),
    value: customOpen ? 'custom' : countInChoice(practice().countIn),
    onChange: choice => {
      customOpen = choice === 'custom';
      renderCustom();
      const current = practice().countIn;
      const next = countInFor(choice, current);
      if (JSON.stringify(next) !== JSON.stringify(current)) writeCountIn(next);
    },
  }));
  const unitId = `${countRow.labelId}-unit`;
  lengthStepper = keep(Stepper({
    label: C.countIn.length, decLabel: C.countIn.shorter, incLabel: C.countIn.longer,
    min: 1, max: 16, step: 1, bigStep: 4,
    value: practice().countIn.length,
    format: v => C.countIn.format(v, practice().countIn.unit),
    onChange: length => writeCountIn({...practice().countIn, on: true, length}),
  }));
  unitSeg = keep(Segmented({
    attrs: {'aria-labelledby': unitId},
    size: 'sm',
    options: [{value: 'bars', label: C.countIn.bars}, {value: 'beats', label: C.countIn.beats}],
    value: practice().countIn.unit,
    onChange: unit => writeCountIn({...practice().countIn, on: true, unit}),
  }));
  const custom = h('div', {class: 'settings-countin-custom'},
    lengthStepper.el,
    h('div', {class: 'settings-inline'}, h('span', {class: 'settings-inline-label', id: unitId}, C.countIn.unit), unitSeg.el));
  countRow.el.querySelector('.settings-row-control').prepend(countSeg.el, custom);
  function renderCustom() {
    custom.hidden = !customOpen;
  }
  renderCustom();

  // ---- Default click
  let clickSeg;
  const clickSaver = accountSaver(() => clickSeg.el.querySelector('[aria-checked=true]'));
  const clickRow = settingRow({row: 'click', label: C.click.label, hint: C.click.hint, scope: 'account', saver: clickSaver});
  clickSeg = keep(Segmented({
    attrs: {'aria-labelledby': clickRow.labelId},
    options: ['off', 'countin', 'always'].map(value => ({value, label: C.click[value]})),
    value: practice().click,
    onChange: value => patchPractice(clickSaver, {click: value}),
  }));
  clickRow.el.querySelector('.settings-row-control').prepend(clickSeg.el);

  // ---- Count in every loop pass · Keep pitch by default
  function toggleRow(key, copy) {
    let toggle;
    const id = uid('settings-row');
    const saver = accountSaver(() => toggle.el);
    toggle = keep(Toggle({
      label: copy.label, pressed: !!practice()[key], className: 'settings-toggle', attrs: {'aria-describedby': `${id}-hint`},
      onChange: pressed => patchPractice(saver, {[key]: pressed}),
    }));
    const row = settingRow({row: key, hint: copy.hint, scope: 'account', controls: [toggle], saver, labelId: id});
    return {row, toggle};
  }
  const eachPass = toggleRow('eachPassCount', C.eachPassCount);
  const keepPitch = toggleRow('keepPitch', C.keepPitch);

  // ---- Distance (this device)
  let distanceSeg;
  const distanceSaver = keep(createSaver({focus: () => distanceSeg.el.querySelector('[aria-checked=true]')}));
  const distanceRow = settingRow({row: 'distance', label: C.distance.label, hint: C.distance.hint, scope: 'device', saver: distanceSaver});
  distanceSeg = keep(Segmented({
    attrs: {'aria-labelledby': distanceRow.labelId},
    options: DISTANCES.map(value => ({value, label: C.distance[value]})),
    value: prefs.get('practice.distance'),
    onChange: value => distanceSaver.run(() => prefs.set('practice.distance', value)),
  }));
  distanceRow.el.querySelector('.settings-row-control').prepend(distanceSeg.el);

  // ---- Follow style (this device): one choice per layout
  const followSaver = keep(createSaver({focus: () => el.querySelector('.settings-follow [aria-checked=true]')}));
  const followRow = settingRow({row: 'follow', label: C.follow.label, hint: C.follow.hint, scope: 'device', saver: followSaver});
  const followSegs = {};
  const followGroups = ['rail', 'band'].map(layout => {
    const id = `${followRow.labelId}-${layout}`;
    followSegs[layout] = keep(Segmented({
      label: C.follow[`${layout}Group`],
      size: 'sm',
      options: FOLLOW.map(value => ({value, label: C.follow[value]})),
      value: prefs.get(`practice.follow.${layout}`),
      onChange: value => followSaver.run(() => prefs.set(`practice.follow.${layout}`, value)),
    }));
    return h('div', {class: 'settings-inline'}, h('span', {class: 'settings-inline-label', id}, C.follow[layout]), followSegs[layout].el);
  });
  followRow.el.querySelector('.settings-row-control').prepend(h('div', {class: 'settings-follow'}, followGroups));

  // ---- Keep screen awake (account)
  let wakeSeg;
  const wakeSaver = accountSaver(() => wakeSeg.el.querySelector('[aria-checked=true]'));
  const wakeRow = settingRow({row: 'wake', label: C.wake.label, hint: C.wake.hint, scope: 'account', saver: wakeSaver});
  wakeSeg = keep(Segmented({
    attrs: {'aria-labelledby': wakeRow.labelId},
    options: WAKE.map(value => ({value, label: C.wake.options[value]})),
    value: practice().wake,
    onChange: value => patchPractice(wakeSaver, {wake: value}),
  }));
  wakeRow.el.querySelector('.settings-row-control').prepend(wakeSeg.el);

  // ---- Flash screen edges on downbeats (this device)
  let edgeToggle;
  const edgeId = uid('settings-row');
  const edgeSaver = keep(createSaver({focus: () => edgeToggle.el}));
  edgeToggle = keep(Toggle({
    label: C.edgeFlash.label, pressed: !!prefs.get('practice.edgeFlash'), className: 'settings-toggle',
    attrs: {'aria-describedby': `${edgeId}-hint`},
    onChange: pressed => edgeSaver.run(() => prefs.set('practice.edgeFlash', pressed)),
  }));
  const edgeRow = settingRow({row: 'edgeFlash', hint: C.edgeFlash.hint, scope: 'device', controls: [edgeToggle], saver: edgeSaver, labelId: edgeId});

  // ---- follow the stored values
  function showAccount(value) {
    const p = value.practice;
    stopSeg.set({value: p.stop});
    const choice = countInChoice(p.countIn);
    if (choice === 'custom') customOpen = true;
    else if (choice === 'off') customOpen = false;
    countSeg.set({value: customOpen ? 'custom' : choice});
    lengthStepper.set({value: p.countIn.length});
    unitSeg.set({value: p.countIn.unit});
    renderCustom();
    clickSeg.set({value: p.click});
    eachPass.toggle.set({pressed: !!p.eachPassCount});
    keepPitch.toggle.set({pressed: !!p.keepPitch});
    wakeSeg.set({value: p.wake});
  }
  function showPrefs() {
    distanceSeg.set({value: prefs.get('practice.distance')});
    for (const layout of ['rail', 'band']) followSegs[layout].set({value: prefs.get(`practice.follow.${layout}`)});
    edgeToggle.set({pressed: !!prefs.get('practice.edgeFlash')});
  }
  offs.push(account.value.subscribe(showAccount));
  offs.push(prefs.value.subscribe(showPrefs));

  const group = (rows, label) => h('div', {class: 'settings-group', role: label ? 'group' : null, 'aria-label': label ?? null}, rows.map(r => r.el));
  const page = h('div', {class: 'settings-section', dataset: {section: 'practice'}},
    group([stopRow, countRow, clickRow, eachPass.row, keepPitch.row, wakeRow]),
    group([distanceRow, followRow, edgeRow]));
  el.replaceChildren(page);

  return {
    destroy() {
      for (const off of offs.splice(0)) off();
      for (const part of parts.splice(0)) part.destroy();
      page.remove();
    },
  };
}

export default Object.freeze({id: 'practice', title: SECTION_TITLES.practice, render});
