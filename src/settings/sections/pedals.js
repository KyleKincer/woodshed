// Settings → Pedals & keys (architecture §2.7, §2.17, §9 PD1; spec §6.2, §7.5). Every row but the shortcuts sheet
// belongs to this device (prefs.pedals, prefs.midi, and the desktop app's own background-shortcuts setting):
//   Pedal mode            on/off. Turning it on with no pedals learned starts Learn my pedal.
//   Your pedals           Learn my pedal: a dialog that asks for two to four pedals, each pressed and then held
//                         (pedals.learn); the learned pedals with their keys and whether they can hold.
//   Profile               Practice · Navigate · Page turn · Custom.
//   What your pedals do   the mapping table: a row per learned pedal, Tap and Hold columns (Double-tap for a pedal
//                         that cannot hold, spec §7.5). In Custom every cell is a menu of the commands marked pedal.
//   Keyboard shortcuts    View keyboard shortcuts (the ? sheet, app.shortcuts).
//   Background shortcuts  desktop only: opt-in global shortcuts with each one's result (an accelerator another app
//                         holds is listed as failed), and on macOS the Accessibility prompt for the media keys. On the
//                         web it joins the one "These need Woodshed for desktop" note.
//   MIDI pedals           where Web MIDI exists (Chromium, the desktop app): on/off, the connected devices, the bound
//                         triggers with Remove, and Add a MIDI pedal (midi.learnMidi, then the command to run).
//   Phone remote          on/off (prefs.remote.allow): whether your other signed-in devices can control a song open
//                         here (src/remote), and Open the remote (/remote) to control another device from this one.

import '../../styles/views/settings/sections.css';
import '../../styles/views/settings/pedals.css';
import {h} from '../../ui/h.js';
import {Button, uid} from '../../ui/button.js';
import {Dialog} from '../../ui/dialog.js';
import {Select} from '../../ui/field.js';
import {Segmented} from '../../ui/segmented.js';
import {Toggle} from '../../ui/toggle.js';
import {icon} from '../../ui/icon.js';
import {label as keyLabel} from '../../app/keys.js';
import {MIN_PEDALS, PROFILE_NAMES, learn as learnPedals, pedalCommands, pedalConfig, profileBindings} from '../../app/pedals.js';
import {learnMidi as learnMidiTrigger, midiConfig, midiState as appMidiState, triggerLabel} from '../../app/midi.js';
import {createSaver, desktopNote, settingRow} from '../settings.js';
import {COPY as SETTINGS_COPY, SECTION_TITLES} from '../settings.copy.js';

/** This section's words (spec §6.2, §7.5). */
export const COPY = Object.freeze({
  mode: Object.freeze({
    label: 'Pedal mode',
    hint: 'Your pedals run what the table shows, ahead of keyboard keys, and ⎍ shows on the Stage. PageUp and PageDown change sections even without it.',
    needsPedals: 'Learn your pedals first: turning pedal mode on starts Learn my pedal.',
  }),
  pedals: Object.freeze({
    label: 'Your pedals',
    learn: 'Learn my pedal',
    again: 'Learn again',
    none: 'No pedals learned yet.',
    holds: 'can hold',
    noHold: 'no hold: double-tap instead',
    item: (slot, key, hold) => `${slot} · ${key} · ${hold}`,
  }),
  dialog: Object.freeze({
    title: 'Learn my pedal',
    intro: 'Press each pedal when asked, then hold it so Woodshed knows whether it can be held.',
    cancel: 'Cancel',
    done: 'Done',
    learned: 'Learned',
  }),
  slots: Object.freeze({left: 'Left pedal', right: 'Right pedal', p3: 'Pedal 3', p4: 'Pedal 4'}),
  profile: Object.freeze({
    label: 'Profile',
    practice: 'Practice',
    navigate: 'Navigate',
    pageturn: 'Page turn',
    custom: 'Custom',
    hint: 'Practice: Again and Play/Stop, held for the previous and next section. Navigate: sections first. Page turn: scroll the chart.',
  }),
  table: Object.freeze({
    label: 'What your pedals do',
    pedal: 'Pedal',
    tap: 'Tap',
    hold: 'Hold',
    double: 'Double-tap',
    holdOrDouble: 'Hold or double-tap',
    nothing: 'Nothing',
    empty: 'Learn your pedals to see what each one does.',
    cell: (slot, gesture) => `${slot}: ${gesture}`,
    setlist: 'In a setlist, holding the right pedal goes to the next song.',
    doubleHint: 'A pedal that cannot be held does its hold action on a double-tap.',
  }),
  background: Object.freeze({
    label: 'Background shortcuts',
    hint: 'Play/Stop, Again, Loop and your keyboard’s media keys keep working while another app is in front.',
    ready: 'Ready',
    failed: 'Another app is using it',
    accessibility: 'macOS needs your permission before the media keys reach Woodshed.',
    allow: 'Allow Woodshed in System Settings → Privacy & Security → Accessibility',
    names: Object.freeze({
      'Control+Alt+Space': 'Play / Stop',
      'Control+Alt+Return': 'Start again',
      'Control+Alt+L': 'Loop',
      MediaPlayPause: 'Play/Pause key',
      MediaNextTrack: 'Next-track key: next section',
      MediaPreviousTrack: 'Previous-track key: start again',
      MediaStop: 'Stop key',
    }),
    note: 'Background shortcuts',
  }),
  remote: Object.freeze({
    label: 'Phone remote',
    hint: 'Your phone, or any device signed in to this account, can control a song open here: play, sections, loop, speed, click. No pairing.',
    open: 'Open the remote',
  }),
  midi: Object.freeze({
    label: 'MIDI pedals',
    hint: 'A pad, a drum trigger or a MIDI foot switch can run a command, for example crash pad = Again.',
    devices: 'Devices',
    noDevices: 'No MIDI device is connected.',
    pending: 'Asking for MIDI access…',
    denied: 'MIDI access was not allowed. Allow it for this site in the browser, then try again.',
    unsupported: 'This browser has no Web MIDI.',
    bindings: 'Bound triggers',
    noBindings: 'Nothing bound yet.',
    any: 'any device',
    binding: (trigger, device, command) => `${trigger} on ${device} → ${command}`,
    add: 'Add a MIDI pedal',
    listen: 'Hit the pad or press the pedal…',
    heard: (trigger, device) => `Heard ${trigger} on ${device}.`,
    runs: 'Runs',
    save: 'Save',
    cancel: 'Cancel',
    remove: binding => `Remove ${binding}`,
  }),
});

const SLOT_NAMES = COPY.slots;

function keyName(code) {
  try { return keyLabel(code) || code; } catch { return code; }
}

const commandTitle = (registry, id) => (id ? registry.titleFor(id) || id : COPY.table.nothing);
const holdText = p => (p.canHold ? COPY.pedals.holds : COPY.pedals.noHold);
const pedalText = p => COPY.pedals.item(SLOT_NAMES[p.slot], keyName(p.code), holdText(p));
const sameTrigger = (a, b) => a.type === b.type && a.number === b.number && (a.device ?? null) === (b.device ?? null);

/** The command menu's options: Nothing (optional), then the pedal commands grouped as the ? sheet groups them. */
function commandOptions(registry, {nothing = true} = {}) {
  const groups = new Map();
  for (const c of pedalCommands(registry)) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push({value: c.id, label: c.title});
  }
  const out = nothing ? [{value: null, label: COPY.table.nothing}] : [];
  for (const [label, options] of groups) out.push({label, options});
  return out;
}

/** 'Play / Stop · ⌃⌥Space' (macOS) or 'Play / Stop · Ctrl+Alt+Space'; media keys by name. */
export function backgroundName(accelerator, {mac = false} = {}) {
  const name = COPY.background.names[accelerator];
  const prefix = 'Control+Alt+';
  const keys = accelerator.startsWith(prefix)
    ? `${mac ? '⌃⌥' : 'Ctrl+Alt+'}${accelerator.slice(prefix.length).replace('Return', mac ? '↩' : 'Enter')}`
    : null;
  return name ? (keys ? `${name} · ${keys}` : name) : accelerator;
}

function render(el, ctx) {
  const {prefs, platform, desktop, registry} = ctx;
  const midiState = ctx.midiState ?? appMidiState;
  const learn = ctx.learnPedals ?? learnPedals;
  const learnMidi = ctx.learnMidi ?? learnMidiTrigger;
  const desktopApp = !!(platform?.isDesktopApp || desktop?.available);
  const mac = !!platform?.isMac;
  const parts = [];
  const offs = [];
  const keep = part => { parts.push(part); return part; };
  const groups = [];
  let destroyed = false;
  let dialog = null;
  let abortFlow = null;      // cancels the learn flow of the open dialog
  const closeFlow = () => { abortFlow?.(); abortFlow = null; dialog?.destroy(); dialog = null; };

  const config = () => pedalConfig(prefs.get('pedals'));

  // ---------------------------------------------------------------- Pedal mode
  let modeToggle;
  const modeId = uid('settings-row');
  const modeSaver = keep(createSaver({focus: () => modeToggle.el}));
  const modeNote = h('p', {class: 'settings-note'}, COPY.mode.needsPedals);
  modeToggle = keep(Toggle({
    label: COPY.mode.label, pressed: config().on, className: 'settings-toggle',
    attrs: {'aria-describedby': `${modeId}-hint`},
    onChange: pressed => {
      if (pressed && !config().pedals.length) { void runLearn({enable: true}); return; }
      void modeSaver.run(() => prefs.set('pedals.enabled', pressed));
    },
  }));
  const modeRow = settingRow({row: 'pedalMode', hint: COPY.mode.hint, scope: 'device', controls: [modeToggle, modeNote], saver: modeSaver, labelId: modeId});

  // ---------------------------------------------------------------- Your pedals
  let learnButton;
  const learnSaver = keep(createSaver({focus: () => learnButton.el}));
  const pedalList = h('ul', {class: 'pedals-list', role: 'list'});
  learnButton = keep(Button({label: COPY.pedals.learn, icon: 'footprints', onClick: () => { void runLearn({enable: false}); }}));
  const learnRow = settingRow({row: 'pedals', label: COPY.pedals.label, scope: 'device', controls: [pedalList, learnButton], saver: learnSaver});

  function showPedals(cfg) {
    pedalList.replaceChildren(...(cfg.pedals.length
      ? cfg.pedals.map(p => h('li', {class: 'pedals-item', dataset: {slot: p.slot}},
        h('span', {class: 'pedals-item-icon', 'aria-hidden': 'true'}, icon('footprints', {size: 20})),
        h('span', {}, pedalText(p))))
      : [h('li', {class: 'pedals-item pedals-item-none'}, COPY.pedals.none)]));
    learnButton.set({label: cfg.pedals.length ? COPY.pedals.again : COPY.pedals.learn});
    modeToggle.set({pressed: cfg.on});
    modeNote.hidden = cfg.pedals.length > 0;
  }

  async function runLearn({enable}) {
    closeFlow();
    const abort = new AbortController();
    const finish = new AbortController();
    const prompt = h('p', {class: 'pedals-learn-prompt', role: 'status'});
    const got = h('ul', {class: 'pedals-learn-list', role: 'list', 'aria-label': COPY.dialog.learned});
    const body = h('div', {class: 'pedals-learn'}, h('p', {class: 'pedals-learn-intro'}, COPY.dialog.intro), prompt, got);
    const cancel = {label: COPY.dialog.cancel, value: null, variant: 'secondary'};
    let offeredDone = false;
    const own = Dialog({
      title: COPY.dialog.title, body, actions: [cancel], className: 'pedals-learn-dialog',
      onClose: value => { if (value === 'done') finish.abort(); else if (value !== 'learned') abort.abort(); },
    });
    dialog = own;
    abortFlow = () => abort.abort();
    try {
      const result = await learn({
        signal: abort.signal, done: finish.signal,
        onPrompt: (text, detail) => {
          prompt.textContent = text;
          const learned = detail?.learned ?? [];
          got.replaceChildren(...learned.map(p => h('li', {class: 'pedals-learn-item', dataset: {slot: p.slot}},
            h('span', {class: 'pedals-learn-check', 'aria-hidden': 'true'}, icon('check', {size: 20})),
            h('span', {}, pedalText(p)))));
          if (!offeredDone && learned.length >= MIN_PEDALS) {
            offeredDone = true;
            own.set({actions: [cancel, {label: COPY.dialog.done, value: 'done', variant: 'primary'}]});
          }
        },
      });
      if (own.open) own.close('learned');
      if (destroyed) return;
      await learnSaver.run(() => prefs.update(d => {
        d.pedals.pedals = result.pedals;
        d.pedals.enabled = true;
      }));
    } catch (err) {
      if (err?.name !== 'AbortError') console.warn('[settings] learning the pedals failed:', err?.message ?? err);
      if (own.open) own.close(null);
      if (!destroyed && enable) modeToggle.set({pressed: config().on});
    } finally {
      if (dialog === own) { dialog = null; abortFlow = null; }
    }
  }

  // ---------------------------------------------------------------- Profile
  let profileSeg;
  const profileId = uid('settings-row');
  const profileSaver = keep(createSaver({focus: () => profileSeg.el}));
  profileSeg = keep(Segmented({
    label: COPY.profile.label, value: config().profile,
    options: PROFILE_NAMES.map(value => ({value, label: COPY.profile[value]})),
    attrs: {'aria-describedby': `${profileId}-hint`},
    onChange: value => profileSaver.run(() => prefs.update(d => {
      // Custom starts from what the pedals did a moment ago.
      if (value === 'custom' && !Object.keys(d.pedals.custom ?? {}).length) {
        d.pedals.custom = profileBindings(pedalConfig(d.pedals).profile);
      }
      d.pedals.profile = value;
    })),
  }));
  const profileRow = settingRow({row: 'profile', label: COPY.profile.label, hint: COPY.profile.hint, scope: 'device',
    controls: [profileSeg], saver: profileSaver, labelId: profileId});

  // ---------------------------------------------------------------- What your pedals do
  const tableSaver = keep(createSaver({}));
  const tableHost = h('div', {class: 'pedals-table-host'});
  const tableNotes = h('div', {class: 'pedals-table-notes'});
  const tableRow = settingRow({row: 'mapping', label: COPY.table.label, scope: 'device', controls: [tableHost, tableNotes], saver: tableSaver});
  let tableKey = null;
  const cellSelects = [];

  function setCustom(slot, gesture, id) {
    void tableSaver.run(() => prefs.update(d => {
      const custom = {...(d.pedals.custom ?? {})};
      const entry = {...(custom[slot] ?? {})};
      if (id) entry[gesture] = id; else delete entry[gesture];
      if (entry.tap || entry.hold) custom[slot] = entry; else delete custom[slot];
      d.pedals.custom = custom;
    }));
  }

  function showTable(cfg) {
    const custom = cfg.profile === 'custom';
    const table = profileBindings(cfg.profile, {custom: cfg.custom, isPedalCommand: id => !!registry.get(id)?.pedal});
    // In Custom the menus stay mounted (and focused) while their values change.
    const key = JSON.stringify({profile: cfg.profile, pedals: cfg.pedals, custom: custom ? null : cfg.custom});
    if (key === tableKey && custom) {
      for (const s of cellSelects) s.select.set({value: table[s.slot]?.[s.gesture] ?? null});
      return;
    }
    const active = el.ownerDocument.activeElement;
    const focused = tableHost.contains(active) ? active.closest('[data-cell]')?.dataset.cell : null;
    for (const s of cellSelects.splice(0)) s.select.destroy();
    tableKey = key;
    if (!cfg.pedals.length) {
      tableHost.replaceChildren(h('p', {class: 'settings-value'}, COPY.table.empty));
      tableNotes.replaceChildren();
      return;
    }
    const options = custom ? commandOptions(registry) : null;
    const cell = (p, gesture) => {
      const stored = gesture === 'double' ? 'hold' : gesture;
      const id = table[p.slot]?.[stored] ?? null;
      const name = `${p.slot}:${gesture}`;
      if (!custom) return h('td', {class: 'pedals-cell', dataset: {cell: name, empty: id ? 'false' : 'true'}}, commandTitle(registry, id));
      const select = Select({
        label: COPY.table.cell(SLOT_NAMES[p.slot], COPY.table[gesture]),
        options, value: id, size: 'sm', className: 'pedals-select',
        onChange: value => setCustom(p.slot, stored, value),
      });
      cellSelects.push({slot: p.slot, gesture: stored, select});
      return h('td', {class: 'pedals-cell', dataset: {cell: name}}, select.el);
    };
    const holds = cfg.pedals.filter(p => p.canHold).length;
    const second = holds === cfg.pedals.length ? COPY.table.hold : holds === 0 ? COPY.table.double : COPY.table.holdOrDouble;
    tableHost.replaceChildren(h('table', {class: 'pedals-table', dataset: {profile: cfg.profile}},
      h('caption', {class: 'sr-only'}, COPY.table.label),
      h('thead', {}, h('tr', {},
        h('th', {scope: 'col'}, COPY.table.pedal),
        h('th', {scope: 'col'}, COPY.table.tap),
        h('th', {scope: 'col'}, second))),
      h('tbody', {}, cfg.pedals.map(p => h('tr', {dataset: {slot: p.slot}},
        h('th', {scope: 'row', class: 'pedals-cell-pedal'},
          h('span', {class: 'pedals-slot'}, SLOT_NAMES[p.slot]),
          h('span', {class: 'pedals-key'}, keyName(p.code))),
        cell(p, 'tap'),
        cell(p, p.canHold ? 'hold' : 'double'))))));
    const notes = [];
    if (holds < cfg.pedals.length) notes.push(h('p', {class: 'settings-note'}, COPY.table.doubleHint));
    if (cfg.profile === 'practice' && cfg.pedals.some(p => p.slot === 'right')) notes.push(h('p', {class: 'settings-note'}, COPY.table.setlist));
    tableNotes.replaceChildren(...notes);
    if (focused) tableHost.querySelector(`[data-cell="${focused}"] select`)?.focus({preventScroll: true});
  }

  // ---------------------------------------------------------------- Keyboard shortcuts (the ? sheet)
  const shortcutsId = uid('settings-row');
  const shortcuts = keep(Button({
    command: 'app.shortcuts', registry, label: SETTINGS_COPY.pedals.shortcuts, icon: 'keyboard', kbd: true,
    className: 'settings-shortcuts', attrs: {'aria-describedby': `${shortcutsId}-hint`},
  }));
  const shortcutsRow = settingRow({row: 'shortcuts', hint: SETTINGS_COPY.pedals.hint, scope: 'info', controls: [shortcuts], labelId: shortcutsId});

  groups.push([modeRow, learnRow, profileRow, tableRow], [shortcutsRow]);

  // ---------------------------------------------------------------- Background shortcuts (desktop)
  if (desktopApp) {
    let bgToggle;
    const bgId = uid('settings-row');
    const bgSaver = keep(createSaver({focus: () => bgToggle.el}));
    let bgState = {enabled: false, registered: [], failed: []};
    const list = h('ul', {class: 'pedals-bg-list', role: 'list', hidden: true});
    let allow;
    allow = keep(Button({label: COPY.background.allow, icon: 'external-link', size: 'sm', className: 'pedals-bg-allow', onClick: async () => {
      allow.set({busy: true});
      try {
        const result = await desktop.setBackgroundShortcuts(true, {promptAccessibility: true});
        if (!destroyed) showBackground({enabled: true, ...result});
      } catch (err) {
        console.warn('[settings] the Accessibility prompt failed:', err?.message ?? err);
      } finally {
        if (!destroyed) allow.set({busy: false});
      }
    }}));
    const access = h('div', {class: 'pedals-bg-access', hidden: true}, h('p', {class: 'settings-note'}, COPY.background.accessibility), allow.el);
    bgToggle = keep(Toggle({
      label: COPY.background.label, pressed: false, className: 'settings-toggle', attrs: {'aria-describedby': `${bgId}-hint`},
      onChange: pressed => {
        void bgSaver.run(async () => {
          const result = await desktop.setBackgroundShortcuts(pressed);
          if (!destroyed) showBackground({enabled: pressed, ...result});
        }).then(ok => { if (!ok && !destroyed) bgToggle.set({pressed: bgState.enabled}); });
      },
    }));
    const showBackground = s => {
      bgState = {enabled: !!s?.enabled, registered: s?.registered ?? [], failed: s?.failed ?? [], accessibility: s?.accessibility ?? null};
      bgToggle.set({pressed: bgState.enabled});
      const items = bgState.enabled
        ? [...bgState.registered.map(a => ({a, ok: true})), ...bgState.failed.map(a => ({a, ok: false}))]
        : [];
      list.replaceChildren(...items.map(({a, ok}) => h('li', {class: 'pedals-bg-item', dataset: {ok: ok ? 'true' : 'false', accelerator: a}},
        h('span', {class: 'pedals-bg-icon', 'aria-hidden': 'true'}, icon(ok ? 'check' : 'alert-circle', {size: 20})),
        h('span', {class: 'pedals-bg-name'}, backgroundName(a, {mac})),
        h('span', {class: 'pedals-bg-status'}, ok ? COPY.background.ready : COPY.background.failed))));
      list.hidden = !items.length;
      access.hidden = !(bgState.enabled && bgState.accessibility === 'needed');
    };
    showBackground(bgState);
    Promise.resolve(desktop.info?.()).then(info => {
      if (!destroyed && info?.backgroundShortcuts) showBackground(info.backgroundShortcuts);
    }, () => {});
    groups.push([settingRow({row: 'background', hint: COPY.background.hint, scope: 'device',
      controls: [bgToggle, list, access], saver: bgSaver, labelId: bgId})]);
  }

  // ---------------------------------------------------------------- MIDI pedals (Chromium, desktop)
  const removeButtons = [];
  if (platform?.features?.midi) {
    let midiToggle;
    const midiId = uid('settings-row');
    const midiSaver = keep(createSaver({focus: () => midiToggle.el}));
    const devices = h('p', {class: 'settings-value pedals-midi-devices', role: 'status'});
    const bindingsList = h('ul', {class: 'pedals-midi-list', role: 'list', 'aria-label': COPY.midi.bindings});
    const add = keep(Button({label: COPY.midi.add, icon: 'plus', onClick: () => { void addMidi(); }}));
    midiToggle = keep(Toggle({
      label: COPY.midi.label, pressed: !!prefs.get('midi.enabled'), className: 'settings-toggle',
      attrs: {'aria-describedby': `${midiId}-hint`},
      onChange: pressed => midiSaver.run(() => prefs.set('midi.enabled', pressed)),
    }));
    let midiKey = null;
    const showMidi = () => {
      const cfg = midiConfig(prefs.get('midi'));
      midiToggle.set({pressed: cfg.enabled});
      const key = JSON.stringify(cfg.bindings);
      if (key === midiKey) return;
      midiKey = key;
      for (const b of removeButtons.splice(0)) b.destroy();
      bindingsList.replaceChildren(...(cfg.bindings.length ? cfg.bindings.map(b => {
        const text = COPY.midi.binding(triggerLabel(b), b.device ?? COPY.midi.any, commandTitle(registry, b.command));
        const remove = Button({label: COPY.midi.remove(text), icon: 'trash-2', iconOnly: true, variant: 'quiet', size: 'sm',
          onClick: () => midiSaver.run(() => prefs.update(d => { d.midi.bindings = (d.midi.bindings ?? []).filter(x => !sameTrigger(x, b)); }))});
        removeButtons.push(remove);
        return h('li', {class: 'pedals-midi-item'}, h('span', {class: 'pedals-midi-text'}, text), remove.el);
      }) : [h('li', {class: 'pedals-midi-item pedals-item-none'}, COPY.midi.noBindings)]));
    };
    const showDevices = s => {
      if (s.access === 'pending') devices.textContent = COPY.midi.pending;
      else if (s.access === 'denied') devices.textContent = COPY.midi.denied;
      else if (s.access === 'unsupported') devices.textContent = COPY.midi.unsupported;
      else if (s.access === 'granted') devices.textContent = s.inputs.length ? `${COPY.midi.devices}: ${s.inputs.map(i => i.name).join(', ')}` : COPY.midi.noDevices;
      else devices.textContent = '';
      devices.hidden = !devices.textContent;
    };
    showMidi();
    showDevices(midiState.peek());
    offs.push(midiState.subscribe(showDevices));
    offs.push(prefs.value.subscribe(() => { if (!destroyed) showMidi(); }));

    const addMidi = async () => {
      closeFlow();
      const abort = new AbortController();
      const status = h('p', {class: 'pedals-learn-prompt', role: 'status'}, COPY.midi.listen);
      const pickHost = h('div', {class: 'pedals-midi-pick', hidden: true});
      let heard = null;
      let command = 'transport.again';
      const pick = Select({label: COPY.midi.runs, options: commandOptions(registry, {nothing: false}), value: command, onChange: v => { command = v; }});
      pickHost.append(pick.el);
      const cancel = {label: COPY.midi.cancel, value: null, variant: 'secondary'};
      const own = Dialog({
        title: COPY.midi.add, body: h('div', {class: 'pedals-learn'}, status, pickHost), actions: [cancel], className: 'pedals-midi-dialog',
        onClose: value => {
          abort.abort();
          pick.destroy();
          if (value !== 'save' || !heard || !command || destroyed) return;
          const binding = {device: heard.device || null, type: heard.type, number: heard.number, command};
          void midiSaver.run(() => prefs.update(d => {
            d.midi.bindings = [...(d.midi.bindings ?? []).filter(x => !sameTrigger(x, binding)), binding];
            d.midi.enabled = true;
          }));
        },
      });
      dialog = own;
      abortFlow = () => abort.abort();
      try {
        heard = await learnMidi({signal: abort.signal});
        if (!own.open) return;
        status.textContent = COPY.midi.heard(triggerLabel(heard), heard.device || COPY.midi.any);
        pickHost.hidden = false;
        own.set({actions: [cancel, {label: COPY.midi.save, value: 'save', variant: 'primary'}]});
        pick.input.focus({preventScroll: true});
      } catch (err) {
        if (err?.name === 'AbortError' || !own.open) return;
        status.textContent = err?.code === 'unsupported' ? COPY.midi.unsupported : COPY.midi.denied;
      } finally {
        if (dialog === own && !own.open) { dialog = null; abortFlow = null; }
      }
    };

    groups.push([settingRow({row: 'midi', hint: COPY.midi.hint, scope: 'device',
      controls: [midiToggle, devices, bindingsList, add], saver: midiSaver, labelId: midiId})]);
  }

  // ---------------------------------------------------------------- Phone remote (2.1)
  let remoteToggle;
  const remoteId = uid('settings-row');
  const remoteSaver = keep(createSaver({focus: () => remoteToggle.el}));
  remoteToggle = keep(Toggle({
    label: COPY.remote.label, pressed: prefs.get('remote.allow') !== false, className: 'settings-toggle',
    attrs: {'aria-describedby': `${remoteId}-hint`},
    onChange: pressed => remoteSaver.run(() => prefs.set('remote.allow', pressed)),
  }));
  const openRemote = keep(Button({label: COPY.remote.open, icon: 'monitor-smartphone', variant: 'quiet',
    onClick: () => (ctx.router?.navigate ? ctx.router.navigate('/remote') : globalThis.location?.assign?.('/remote'))}));
  groups.push([settingRow({row: 'remote', hint: COPY.remote.hint, scope: 'device', controls: [remoteToggle, openRemote],
    saver: remoteSaver, labelId: remoteId})]);
  offs.push(prefs.value.subscribe(() => { if (!destroyed) remoteToggle.set({pressed: prefs.get('remote.allow') !== false}); }));

  const page = h('div', {class: 'settings-section settings-pedals', dataset: {section: 'pedals'}},
    groups.map(rows => h('div', {class: 'settings-group'}, rows.map(r => r.el))),
    desktopApp ? null : desktopNote([COPY.background.note]));
  el.replaceChildren(page);

  const show = () => {
    const cfg = config();
    showPedals(cfg);
    profileSeg.set({value: cfg.profile});
    showTable(cfg);
  };
  show();
  offs.push(prefs.value.subscribe(() => { if (!destroyed) show(); }));

  return {
    destroy() {
      destroyed = true;
      closeFlow();
      for (const off of offs.splice(0)) off();
      for (const s of cellSelects.splice(0)) s.select.destroy();
      for (const b of removeButtons.splice(0)) b.destroy();
      for (const part of parts.splice(0)) part.destroy();
      page.remove();
    },
  };
}

export default Object.freeze({id: 'pedals', title: SECTION_TITLES.pedals, render});
