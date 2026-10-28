// U2's harness (/__harness/overlays): every overlay primitive on fake contexts, with the real dispatcher running.
//   ?layout=rail|band     wraps the Sheets section in [data-stage-layout] (Sheet's auto layout)
//   ?demo=menu|submenu|context|popover-<corner>|popover-inline|sheet|sheet-modal|dialog|form|coach|toast|tall-menu|
//         menu-in-sheet|dialog-toast   opens one overlay at load
// window.__overlays = {open(name), handle, overlays(), state} lets states open and inspect overlays; the corners are
// top-left, top-right, bottom-left and bottom-right, and every corner popover asks for placement 'bottom' (the bottom
// corners must flip). popover-inline asks for 'right' from the top-right corner (it must flip to the left).
//   tall-menu       a 14-item menu from a mid-screen button: too tall for either side, it shrinks on the roomier one
//   menu-in-sheet   a menu opened from a button inside a non-modal sheet: it must be drawn (and hit) above the sheet
//   dialog-toast    a modal dialog with the toast region following it (followLayerHost): Undo stays clickable
import {register, registerMany, get as getCommand, invalidate} from '/src/app/commands.js';
import {openOverlays, startDispatcher} from '/src/app/dispatch.js';
import {Banner} from '/src/ui/banner.js';
import {CoachMark} from '/src/ui/coachmark.js';
import {Dialog} from '/src/ui/dialog.js';
import {bindContextMenu, Menu} from '/src/ui/menu.js';
import {Popover, followLayerHost} from '/src/ui/popover.js';
import {Sheet} from '/src/ui/sheet.js';
import {InlineStatus} from '/src/ui/status.js';
import {Toast} from '/src/ui/toast.js';

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const SPEEDS = [50, 60, 70, 75, 80, 85, 90, 100, 110, 125];

const state = {focus: false, speed: 100};

function registerDemoCommands() {
  if (getCommand('harness.focus')) return;
  registerMany([
    {id: 'harness.focus', title: 'Focus', group: 'View', keys: ['KeyF'], scopes: ['stage'], checked: () => state.focus,
      run: () => { state.focus = !state.focus; invalidate(); }},
    {id: 'harness.resplit', title: 'Re-split…', group: 'Library', disabledReason: () => 'Re-split from Woodshed for desktop.', run: () => {}},
    {id: 'harness.again', title: 'Start again', group: 'Transport', keys: ['Enter'], scopes: ['stage'],
      menu: {label: 'Start again (with count-in)'}, run: () => {}},
  ]);
  register({id: 'harness.shortcuts', title: 'Keyboard shortcuts', group: 'App', keys: ['?'], scopes: ['global'], run: () => {}});
}

const songMenu = () => [
  {command: 'harness.again'},
  {label: 'View', items: [
    {label: 'Chart', type: 'radio', checked: true}, {label: 'Road map', type: 'radio', checked: false}, {label: 'Stems', type: 'radio', checked: false},
  ]},
  {command: 'harness.focus'},
  {type: 'separator'},
  {label: 'Spots…', kbd: 'KeyJ', icon: 'bookmark'},
  {label: 'Share…', icon: 'share-2'},
  {command: 'harness.resplit'},
  {type: 'separator'},
  {label: 'Keyboard shortcuts', command: 'harness.shortcuts'},
  {label: 'Delete song', danger: true, icon: 'trash-2'},
];

const cardMenu = () => [{label: 'Select'}, {label: 'Pin to home', icon: 'pin'}, {label: 'Edit details'}, {type: 'separator'}, {label: 'Delete', danger: true}];

export default async function mount(el, {query, h}) {
  registerDemoCommands();
  const stopDispatcher = startDispatcher();
  const handles = new Set();
  const track = handle => { handles.add(handle); window.__overlays.handle = handle; return handle; };
  const cleanups = [];

  const button = (label, onClick, {style, ...props} = {}) => h('button', {
    type: 'button', on: {click: onClick}, ...props,
    style: {minBlockSize: 'var(--h-sm)', paddingInline: 'var(--s3)', ...style},
  }, label);
  const section = (title, ...children) => {
    const id = `ov-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
    return h('section', {class: 'ux-harness-section', 'aria-labelledby': id, style: {display: 'grid', gap: 'var(--s3)'}},
      h('h2', {id, style: {margin: 0, fontSize: 'var(--fs-20)'}}, title), ...children);
  };
  const row = (...children) => h('div', {style: {display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)', alignItems: 'center'}}, ...children);

  // Menus.
  const menuButton = button('Song menu', () => track(Menu({anchor: menuButton, label: 'Song', items: songMenu()})), {'aria-haspopup': 'menu', id: 'ov-menu'});
  const card = h('div', {class: 'ux-harness-card', tabIndex: 0, id: 'ov-card', role: 'group', 'aria-label': 'Harbor Lights card',
    style: {padding: 'var(--s4)', border: '1px solid var(--line)', borderRadius: 'var(--r-surface)', background: 'var(--surface)', maxInlineSize: '320px'}},
  h('strong', {}, 'Harbor Lights'), h('div', {style: {color: 'var(--ink-2)'}}, 'Right-click, long-press or Shift+F10'));
  cleanups.push(bindContextMenu(card, () => cardMenu(), {label: 'Harbor Lights', onOpen: handle => track(handle)}));

  // Sheets.
  const speedContent = () => h('div', {style: {display: 'grid', gap: 'var(--s3)'}},
    h('p', {style: {margin: 0, fontSize: 'var(--fs-24)', fontWeight: 'var(--fw-bold)'}}, `${state.speed}%`),
    h('div', {role: 'group', 'aria-label': 'Presets', style: {display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)'}},
      ...SPEEDS.map(v => button(String(v), () => { state.speed = v; }, {'aria-pressed': String(v === state.speed), style: {minInlineSize: '56px', minBlockSize: 'var(--h-sm)'}}))),
    h('p', {style: {margin: 0, color: 'var(--ink-2)'}}, 'Trains on: Chorus (bars 13–20)'));
  const sheetButton = button('Speed sheet', () => track(Sheet({title: 'Speed', anchor: sheetButton, content: speedContent()})), {id: 'ov-sheet'});
  const modalSheetButton = button('Add sheet (modal)', () => track(Sheet({title: 'Add a song', anchor: modalSheetButton, modal: true, layout: 'bottom',
    content: h('div', {style: {display: 'grid', gap: 'var(--s2)'}},
      h('label', {for: 'ov-link'}, 'Paste a link'),
      h('input', {id: 'ov-link', type: 'url', placeholder: 'https://…', style: {minBlockSize: 'var(--h-md)'}}))})), {id: 'ov-sheet-modal'});
  const sheetsBody = row(sheetButton, modalSheetButton);
  const layout = query.get('layout');
  const sheets = layout ? h('div', {dataset: {stageLayout: layout}}, sheetsBody) : sheetsBody;

  // Dialogs.
  const confirmButton = button('Delete…', () => track(Dialog({title: 'Delete 3 songs?', body: 'Their stems and practice are removed. This cannot be undone.',
    danger: true, actions: [{label: 'Cancel', value: false}, {label: 'Delete 3 songs', value: true, variant: 'danger', submit: true}]})), {id: 'ov-confirm'});
  let attempts = 0;
  const formButton = button('Rename…', () => {
    attempts = 0;
    track(Dialog({title: 'Rename song', form: {
      fields: [{name: 'title', label: 'Title', kind: 'text', required: true, value: 'Harbor Lights', maxLength: 120},
        {name: 'note', label: 'Note', kind: 'textarea', hint: 'Only you see this.', maxLength: 500}],
      onSubmit: () => new Promise((resolve, reject) => {
        attempts++;
        setTimeout(() => (attempts === 1 ? reject(new Error('The server said no. Try again.')) : resolve()), 60);
      }),
    }}));
  }, {id: 'ov-form'});

  // Popovers from the four corners.
  const corner = name => {
    const [v, side] = name.split('-');
    const b = button(name === 'top-left' ? 'Top left' : name === 'top-right' ? 'Top right' : name === 'bottom-left' ? 'Bottom left' : 'Bottom right', () => {
      track(Popover({anchor: b, label: `Popover ${name}`, width: 280, placement: 'bottom',
        content: [h('p', {style: {margin: '0 0 var(--s2)'}}, 'Jobs'), h('p', {style: {margin: 0, color: 'var(--ink-2)'}}, 'Harbor Lights · Split ● 46%'),
          button('Retry', () => {}, {style: {marginBlockStart: 'var(--s2)'}})]}));
    }, {id: `ov-${name}`, dataset: {corner: name}, style: {position: 'fixed', [v]: 'var(--s2)', [side]: 'var(--s2)'}});
    return b;
  };

  // Feedback samples (in flow).
  const toastSamples = h('div', {role: 'group', 'aria-label': 'Toast samples', style: {display: 'grid', gap: 'var(--s2)', justifyItems: 'start'}},
    Toast({message: [h('strong', {}, 'Harbor Lights'), ' is ready'], tone: 'ok', action: {label: 'Practice', run() {}}}).el,
    Toast({message: 'Undid: speed 85% → 100%', action: {label: 'Redo', run() {}}}).el,
    Toast({message: 'Could not reach the processor.', tone: 'error'}).el);
  const statuses = row(...['info', 'ok', 'warn', 'error'].map(tone => InlineStatus({tone,
    text: {info: 'Saving…', ok: 'Saved', warn: 'Not saved yet', error: 'Could not save.'}[tone],
    action: tone === 'error' ? {label: 'Retry', run() {}} : undefined}).el));
  const banners = h('div', {style: {display: 'grid', gap: 'var(--s2)'}},
    Banner({tone: 'warn', text: "You're offline. Songs you've opened recently can still play."}).el,
    Banner({tone: 'info', title: 'Is this the right recording?', text: 'Harbor Lights — Ada Moreno (Official Audio) · YouTube · 3:41',
      actions: [{label: 'Yes', variant: 'primary', run() {}}, {label: 'Wrong song — search again', run() {}}]}).el,
    Banner({tone: 'error', text: "This browser can't play Woodshed's audio format. Use Chrome, Edge, Firefox or Safari 15 or later.", dismissible: true, onDismiss() {}}).el);

  const playButton = button('Play', () => {}, {id: 'ov-play'});
  const region = h('div', {class: 'ui-toast-region', 'aria-label': 'Notifications'});

  el.append(h('div', {id: 'ov-content', style: {display: 'grid', gap: 'var(--s6)', maxInlineSize: '540px', marginInline: 'auto'}},
    h('h1', {style: {margin: 0, fontSize: 'var(--fs-24)'}}, 'Overlays'),
    section('Menus', row(menuButton), card),
    section('Sheets', sheets),
    section('Dialogs', row(confirmButton, formButton)),
    section('Feedback', toastSamples, statuses, banners),
    section('Coach mark', row(playButton))),
  ...CORNERS.map(corner), region);

  const fixedButton = (id, label, style) => {
    document.getElementById(id)?.remove();
    const b = button(label, () => {}, {id, style: {position: 'fixed', ...style}});
    el.append(b);
    return b;
  };
  const tallItems = () => Array.from({length: 14}, (_, i) => ({label: `Bar ${i + 1}`}));

  const open = name => {
    if (name === 'menu') menuButton.click();
    else if (name === 'popover-inline') {
      const b = document.getElementById('ov-top-right');
      track(Popover({anchor: b, label: 'Popover inline', width: 280, placement: 'right', content: 'Beside the anchor'}));
    } else if (name === 'tall-menu') {
      const b = fixedButton('ov-tall', 'Bars', {top: 'calc(50% - 20px)', left: '45%'});
      track(Menu({anchor: b, label: 'Bars', items: tallItems(), presentation: 'popover'}));
    } else if (name === 'menu-in-sheet') {
      const stem = button('Bass ⋯', () => {}, {id: 'ov-stem'});
      track(Sheet({title: 'Mix', layout: 'bottom', detents: [60], initialDetent: 60,
        content: [h('div', {style: {display: 'grid', gap: 'var(--s2)'}},
          ...['Drums', 'Keys'].map(n => h('p', {style: {margin: 0, minBlockSize: 'var(--h-md)'}}, n)), stem,
          ...['Vocals', 'Other'].map(n => h('p', {style: {margin: 0, minBlockSize: 'var(--h-md)'}}, n)))]}));
      track(Menu({anchor: stem, label: 'Bass', items: cardMenu(), presentation: 'popover'}));
    } else if (name === 'dialog-toast') {
      state.undone = 0;
      const dialog = track(Dialog({title: 'Share Harbor Lights', body: 'Anyone with the link can listen.'}));
      const off = followLayerHost(region, 'toast');
      cleanups.push(off);
      region.replaceChildren(Toast({message: 'Link copied', action: {label: 'Undo', run() { state.undone++; }},
        onDismiss: () => region.replaceChildren()}).el);
      dialog.closed.then(() => { state.dialogClosed = true; });
    }
    else if (name === 'submenu') {
      menuButton.click();
      const view = [...document.querySelectorAll('[role=menuitem]')].find(n => n.textContent.includes('View'));
      view?.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true}));
    } else if (name === 'context') {
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2, clientX: r.left + 40, clientY: r.top + 20}));
    } else if (name.startsWith('popover-')) document.getElementById(`ov-${name.slice(8)}`)?.click();
    else if (name === 'sheet') sheetButton.click();
    else if (name === 'sheet-modal') modalSheetButton.click();
    else if (name === 'dialog') confirmButton.click();
    else if (name === 'form') formButton.click();
    else if (name === 'coach') {
      track(CoachMark({anchor: playButton, title: 'Play', step: {i: 1, n: 3}, onSkip() {},
        body: [h('strong', {}, 'Space'), ' or ▶ plays from your loop. ', h('strong', {}, 'Enter'), ' starts again with a count-in.']}));
    } else if (name === 'toast') {
      region.replaceChildren(Toast({message: 'Pinned to home', action: {label: 'Undo', run() {}}, onDismiss: () => region.replaceChildren()}).el);
    } else throw new Error(`overlays harness: unknown demo ${name}`);
    return window.__overlays.handle;
  };
  window.__overlays = {open, handle: null, state, overlays: () => openOverlays().length};

  const demo = query.get('demo');
  if (demo) open(demo);

  return {
    unmount() {
      for (const handle of handles) handle.destroy?.();
      for (const fn of cleanups) fn();
      stopDispatcher();
      el.replaceChildren();
    },
  };
}
