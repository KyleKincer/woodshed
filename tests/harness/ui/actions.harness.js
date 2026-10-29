// U1 harness (/__harness/actions): every action and input primitive, wired to an isolated
// command registry and a running dispatcher, so states can capture them and drive them with
// real keys, a mouse and touch (architecture §11.2, §9.4 U1).
//   ?part=actions | inputs | pads   one section (default: all three)
//   ?place=stage                     Stage tokens (the host sets html[data-place=stage])
// window.__u1 exposes {log, registry, prims, state} for state assertions: `log` lists what ran
// ('cmd:transport.playStop', 'hold:activate', 'pad:drums:toggle', …).
import {createRegistry} from '/src/app/commands.js';
import {startDispatcher} from '/src/app/dispatch.js';
import {installIcons} from '/src/ui/icon.js';
import {Button, IconButton} from '/src/ui/button.js';
import {Toggle} from '/src/ui/toggle.js';
import {HoldButton} from '/src/ui/hold-button.js';
import {Segmented} from '/src/ui/segmented.js';
import {Chip, ChipGroup} from '/src/ui/chip.js';
import {Stepper} from '/src/ui/stepper.js';
import {Slider} from '/src/ui/slider.js';
import {Fader} from '/src/ui/fader.js';
import {ChipInput, Select, TextField, Textarea} from '/src/ui/field.js';
import {StemPad} from '/src/ui/stem-pad.js';

const STEMS = [
  {name: 'Drums', color: 'drums', state: 'on', level: 1},
  {name: 'Bass', color: 'bass', state: 'out', level: 0.8},
  {name: 'Guitar', color: 'guitar', state: 'solo', level: 0.65},
  {name: 'Piano', color: 'piano', state: 'on', level: 0.5},
  {name: 'Vocals', color: 'vocals', state: 'on', level: 0.9},
  {name: 'Other', color: 'other', state: 'out', level: 0.3},
];

export default async function mount(el, {query, h}) {
  installIcons();
  const part = query.get('part');
  const show = name => !part || part === name;
  const log = [];
  const prims = {};
  const state = {loop: false, countIn: false, playing: false, speed: 0.75};
  const logEl = h('ol', {class: 'u1-log', 'aria-label': 'Harness log', 'data-volatile': ''});
  const note = msg => {
    log.push(msg);
    logEl.append(h('li', {}, msg));
    while (logEl.children.length > 6) logEl.firstChild.remove();
  };

  // ---- an isolated registry and the real dispatcher (scope 'global': the harness has no posture)
  const registry = createRegistry();
  const cmd = def => registry.register({group: 'Transport', scopes: ['global'], ...def});
  cmd({id: 'transport.playStop', title: 'Play', keys: ['Space'], icon: 'play', run: () => { state.playing = !state.playing; note('cmd:transport.playStop'); }});
  cmd({id: 'loop.toggle', title: 'Loop', group: 'Loop', keys: ['KeyL'], icon: 'repeat', checked: () => state.loop,
    run: () => { state.loop = !state.loop; note('cmd:loop.toggle'); }});
  cmd({id: 'click.countIn', title: 'Count-in', group: 'Click', keys: ['KeyC'], icon: 'count-in', checked: () => state.countIn,
    run: () => { state.countIn = !state.countIn; note('cmd:click.countIn'); }});
  cmd({id: 'song.resplit', title: 'Re-split…', group: 'App', icon: 'refresh-cw', disabledReason: () => 'Re-split from Woodshed for desktop.', run: () => note('cmd:song.resplit')});
  cmd({id: 'mix.mute.1', title: 'Mute stem 1', group: 'Mix', keys: ['Digit1'], run: () => note('cmd:mix.mute.1')});
  cmd({id: 'section.prev', title: 'Previous section', group: 'Navigate', keys: ['PageUp'], run: () => note('cmd:section.prev')});
  cmd({id: 'app.shortcuts', title: 'Keyboard shortcuts', group: 'App', keys: ['?'], icon: 'keyboard', run: () => note('cmd:app.shortcuts')});
  const stopDispatcher = startDispatcher({registry});

  const row = (...children) => h('div', {class: 'u1-row', style: {display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--s3)'}}, ...children);
  const section = (id, title, ...children) => h('section', {'aria-labelledby': `u1-${id}`, style: {display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 'var(--s4)', padding: 'var(--s5) var(--s6)'}},
    h('h2', {id: `u1-${id}`, style: {fontSize: 'var(--fs-20)'}}, title), ...children);
  const keep = (key, prim) => { prims[key] = prim; return prim.el; };

  const parts = [];

  if (show('actions')) {
    const variants = ['primary', 'secondary', 'quiet', 'danger'];
    parts.push(section('actions', 'Actions',
      row(...variants.map(variant => keep(`button-${variant}`, Button({label: variant[0].toUpperCase() + variant.slice(1), variant, icon: variant === 'danger' ? 'trash-2' : null, onClick: () => note(`click:${variant}`)})))),
      row(...['sm', 'md', 'lg'].map(size => keep(`size-${size}`, Button({label: `Size ${size}`, size, icon: 'plus'})))),
      row(
        keep('icon-close', IconButton({label: 'Close', icon: 'x', onClick: () => note('click:close')})),
        keep('icon-more', IconButton({label: 'More actions', icon: 'ellipsis', variant: 'secondary'})),
        keep('icon-shortcuts', IconButton({command: 'app.shortcuts', registry})),
        keep('kbd', Button({label: 'Search', icon: 'search', kbd: '/', variant: 'secondary'})),
      ),
      row(
        keep('busy', Button({label: 'Export', busy: true})),
        keep('busy-text', Button({label: 'Billing', busy: 'Opening secure billing…'})),
        keep('busy-percent', Button({label: 'Play', icon: 'play', busy: {label: 'Loading', percent: 62}})),
        keep('disabled', Button({label: 'Disabled', disabled: true})),
        keep('reason', Button({label: 'Detect beats', icon: 'wand-2', disabledReason: 'Needs an online computer.'})),
      ),
      row(
        keep('cmd-loop', Button({command: 'loop.toggle', registry})),
        keep('cmd-countin', Toggle({command: 'click.countIn', registry, sublabel: '1 bar'})),
        keep('cmd-resplit', Button({command: 'song.resplit', registry})),
        keep('toggle-click', Toggle({label: 'Click', icon: 'metronome', onChange: on => note(`toggle:click:${on}`)})),
        keep('long', Button({label: 'Hold me', onClick: () => note('click:long'), onLongPress: () => note('longpress:long')})),
      ),
      row(
        keep('playing', Toggle({label: 'Playing', onChange: on => { state.playing = on; note(`toggle:playing:${on}`); }})),
        keep('hold', HoldButton({label: 'Library', icon: 'chevron-left', iconOnly: true, requireHold: () => state.playing,
          onActivate: () => note('hold:activate'), onTapWhileHold: () => note('hold:hint')})),
        keep('hold-text', HoldButton({label: 'Leave', icon: 'log-out', requireHold: () => state.playing,
          onActivate: () => note('hold:activate'), onTapWhileHold: () => note('hold:hint')})),
      ),
      h('div', {'data-stage-layout': 'band', style: {display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: 'var(--s3)'}},
        keep('dock-again', Button({label: 'Again', icon: 'rotate-ccw', size: 'dock'})),
        keep('dock-play', Button({label: 'Play', icon: 'play', size: 'play', variant: 'primary'})),
        keep('dock-loop', Toggle({label: 'Loop', icon: 'repeat', size: 'dock'})),
        keep('dock-speed', Stepper({label: 'Speed', value: 0.75, min: 0.25, max: 1.5, step: 0.05, bigStep: 0.25, size: 'dock',
          format: v => `${Math.round(v * 100)}%`, onChange: v => { state.speed = v; note(`speed:${Math.round(v * 100)}`); },
          onValueClick: () => note('speed:open'), onValueLongPress: () => note('speed:toggle100')})),
      ),
    ));
  }

  if (show('inputs')) {
    const options = [{value: 'mute', label: 'Mute'}, {value: 'solo', label: 'Solo'}, {value: 'six', label: '6 stems', disabled: true, reason: 'Re-split from Woodshed for desktop.'}];
    parts.push(section('inputs', 'Inputs',
      row(
        keep('segmented', Segmented({label: 'Tap to', options, value: 'mute', onChange: v => note(`segmented:${v}`)})),
        keep('segmented-lg', Segmented({label: 'Paging', size: 'lg', value: 'pages', options: [{value: 'pages', label: 'Pages', icon: 'layout-grid'}, {value: 'scroll', label: 'Continuous', icon: 'list'}]})),
      ),
      row(
        keep('filter', ChipGroup({label: 'Filter', options: [{value: 'ready', label: 'Ready'}, {value: 'processing', label: 'Processing'}, {value: 'review', label: 'Is this right?', tone: 'warn'}], value: 'ready', onChange: v => note(`filter:${v}`)})),
      ),
      row(
        keep('instruments', ChipGroup({label: 'Instruments', multiple: true, value: ['drums', 'bass'], primary: 'drums',
          options: [{value: 'drums', label: 'Drums', icon: 'drum'}, {value: 'bass', label: 'Bass'}, {value: 'guitar', label: 'Guitar', icon: 'guitar'}, {value: 'keys', label: 'Keys', icon: 'piano'}],
          onChange: v => note(`instruments:${v.join('+')}`)})),
      ),
      row(
        keep('chip-tag', Chip({label: 'Funk', removable: true, onRemove: () => note('chip:remove')})),
        keep('chip-ok', Chip({label: 'Matched', tone: 'ok', icon: 'check'})),
        keep('chip-danger', Chip({label: 'Failed', tone: 'danger', icon: 'alert-circle'})),
      ),
      row(
        keep('stepper', Stepper({label: 'Beats', value: 4, min: 1, max: 16, onChange: v => note(`beats:${v}`)})),
        keep('stepper-sm', Stepper({label: 'Passes per step', value: 2, min: 1, max: 8, size: 'sm'})),
        keep('stepper-pct', Stepper({label: 'Start', value: 70, min: 25, max: 150, step: 5, size: 'lg', format: v => `${v}%`})),
      ),
      row(
        keep('slider', Slider({label: 'Volume', value: 0.6, format: v => `${Math.round(v * 100)}%`, onChange: v => note(`volume:${Math.round(v * 100)}`)})),
        keep('fader', Fader({label: 'Drums level', value: 0.8, onChange: v => note(`fader:${Math.round(v * 100)}`)})),
        keep('slider-v', Slider({label: 'Lane height', value: 0.4, orientation: 'vertical', format: v => `${Math.round(v * 100)}%`})),
      ),
      h('div', {style: {display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 'var(--s5)', maxWidth: '960px'}},
        keep('title', TextField({label: 'Title', value: 'Glasshouse', hint: 'As it appears in the Library', status: 'saved', maxLength: 120, onCommit: v => note(`title:${v}`)})),
        keep('artist', TextField({label: 'Artist', value: '', error: 'Enter an artist, or leave it for later.', placeholder: 'Unknown artist'})),
        keep('stems', Select({label: 'Stems', value: 4, hint: 'Six stems take longer.', options: [{value: 2, label: 'Two (vocals and the rest)'}, {value: 4, label: 'Four'}, {value: 6, label: 'Six'}]})),
        keep('notes', Textarea({label: 'Notes', value: 'Push into the chorus.', maxLength: 500, onCommit: v => note(`notes:${v.length}`)})),
        keep('tags', ChipInput({label: 'Tags', values: ['Funk', 'Live'], placeholder: 'Add a tag', onChange: v => note(`tags:${v.join('+')}`)})),
      ),
    ));
  }

  if (show('pads')) {
    let mode = 'mute';
    const pads = [];
    const padRow = (size, list) => h('div', {class: 'u1-pads', 'data-size': size, style: {display: 'grid', gridTemplateColumns: `repeat(${size === 'rail' ? 2 : 3}, max-content)`, gap: 'var(--s3)'}},
      ...list.map((stem, i) => {
        const pad = StemPad({...stem, size, mode, keyCap: `Digit${i + 1}`,
          onToggle: () => { stem.state = stem.state === 'out' ? 'on' : 'out'; pad.set({state: stem.state}); note(`pad:${stem.name.toLowerCase()}:toggle`); },
          onSolo: () => { stem.state = stem.state === 'solo' ? 'on' : 'solo'; pad.set({state: stem.state}); note(`pad:${stem.name.toLowerCase()}:solo`); },
          onLevel: (v, {final}) => { stem.level = v; if (final) note(`pad:${stem.name.toLowerCase()}:level:${Math.round(v * 100)}`); },
        });
        pads.push(pad);
        prims[`pad-${size}-${stem.name.toLowerCase()}`] = pad;
        return pad.el;
      }));
    parts.push(section('pads', 'Stem pads',
      row(keep('pad-mode', Segmented({label: 'Tap to', value: mode, options: [{value: 'mute', label: 'Mute'}, {value: 'solo', label: 'Solo'}],
        onChange: v => { mode = v; for (const pad of pads) pad.set({mode}); note(`mode:${v}`); }}))),
      h('div', {'data-stage-layout': 'band'}, padRow('band', STEMS.map(s => ({...s})))),
      h('div', {'data-stage-layout': 'rail'}, padRow('rail', STEMS.slice(0, 4).map(s => ({...s})))),
    ));
  }

  el.append(...parts, h('section', {'aria-label': 'Log', style: {padding: '0 var(--s6) var(--s6)', fontSize: 'var(--fs-14)', color: 'var(--ink-3)'}}, logEl));
  window.__u1 = {log, registry, prims, state};

  return {
    unmount() {
      stopDispatcher();
      for (const prim of Object.values(prims)) prim.destroy();
      el.replaceChildren();
      delete window.__u1;
    },
  };
}
