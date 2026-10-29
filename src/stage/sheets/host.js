// The Stage's sheets host (architecture §2.14.11, spec §4.7): opens a named sheet as a bottom Sheet
// (band, and anywhere outside the Stage such as Edit's slim transport) or a popover anchored left
// of its rail control (rail, 360 px); the Notes card is a non-modal card at the music's top right
// (320 px). One sheet at a time: opening another closes the first, and opening the one already
// open does nothing. Sheets never pause playback, push history or relayout the music.
//
//   openSheet(name, {session, anchor}) → {name, close(), get open}
//   closeSheets()
//   openSheetName() → the open sheet's name, or null
//   SHEETS        the names, in §2.14.11 order
//
// Each sheet's content comes from its module (wave 2b: speed, click, mix, loop, spots, notes,
// tap-beat, get-bars), resolved by contract path (D2, Appendix C item 58):
//   export function render(container, {session, close}) → {destroy}
// A module that does not exist yet renders the "Not built yet" note in the sheet.

import '../../styles/views/stage/stage.css';
import {pushOverlay} from '../../app/dispatch.js';
import {h} from '../../ui/h.js';
import {icon} from '../../ui/icon.js';
import {Sheet} from '../../ui/sheet.js';
import {COPY} from '../stage.copy.js';

const MODULES = import.meta.glob(['./speed.js', './click.js', './mix.js', './loop.js', './spots.js', './notes.js', './tap-beat.js', './get-bars.js']);

export const SHEETS = Object.freeze(['speed', 'click', 'mix', 'loop', 'spots', 'notes', 'tapBeat', 'getBars']);
const PATHS = Object.freeze({
  speed: './speed.js', click: './click.js', mix: './mix.js', loop: './loop.js',
  spots: './spots.js', notes: './notes.js', tapBeat: './tap-beat.js', getBars: './get-bars.js',
});
/** Rail popovers are 360 px wide (spec §4.7); the Notes card is 320 px. */
export const POPOVER_WIDTH = 360;
export const NOTES_WIDTH = 320;

let current = null;   // {name, handle, close}
let modules = MODULES;

/** Tests replace the sheet modules ({'./speed.js': () => Promise<module>, …}); null restores the real ones. */
export function setSheetModules(next) { modules = next ?? MODULES; }

const isElement = (v) => !!v && typeof v === 'object' && v.nodeType === 1;

/**
 * The anchor a sheet opens from: the given element, else the Stage's `[data-stage-anchor=<name>]`, else its
 * controls. Get bars has no control of its own on the rail: it opens left of the rail's controls like the
 * others. (The full-width strip is no anchor: a popover placed left of it has no room and, in CSS-anchor
 * mode, flips between its widths every frame over the rail.)
 */
function anchorFor(name, anchor, doc) {
  if (isElement(anchor)) return anchor;
  const stage = doc.querySelector('[data-stage-layout]');
  if (!stage) return null;
  return stage.querySelector(`[data-stage-anchor="${name}"]`)
    ?? stage.querySelector('[data-stage-anchor="controls"]');
}

function placeholder() {
  return h('div', {class: 'stage-sheet-later'},
    h('p', {class: 'stage-sheet-later-kicker'}, COPY.notBuilt),
    h('p', {class: 'stage-sheet-later-body'}, COPY.sheetLater));
}

/** Renders the sheet module into `container` once it loads; resolves to its handle (or null). */
async function renderInto(name, container, {session, close, isOpen}) {
  const load = modules?.[PATHS[name]];
  if (!load) { container.replaceChildren(placeholder()); return null; }
  let mod;
  try {
    mod = await load();
  } catch (err) {
    console.error(`[sheets] the ${name} sheet could not load`, err);
    container.replaceChildren(placeholder());
    return null;
  }
  if (!isOpen()) return null;
  if (typeof mod?.render !== 'function') { container.replaceChildren(placeholder()); return null; }
  return mod.render(container, {session, close}) ?? null;
}

/** The Notes card: non-modal, at the music's top right, open until closed (spec §4.7). */
function openNotesCard(host, {session, onClosed}) {
  const titleId = `stage-notes-${Math.random().toString(36).slice(2, 8)}`;
  const body = h('div', {class: 'stage-notes-body'});
  const closeButton = h('button', {type: 'button', class: 'stage-notes-close', attrs: {'aria-label': 'Close'}}, icon('x'));
  const el = h('section', {class: 'stage-notes-card', attrs: {role: 'dialog', 'aria-labelledby': titleId}, dataset: {sheet: 'notes'}},
    h('header', {class: 'stage-notes-head'}, h('h2', {class: 'stage-notes-title', id: titleId}, COPY.sheets.notes), closeButton),
    body);
  host.append(el);
  let open = true, content = null;
  const close = () => {
    if (!open) return;
    open = false;
    pop();
    try { content?.destroy?.(); } catch (err) { console.error('[sheets] notes cleanup failed', err); }
    el.remove();
    onClosed();
  };
  const pop = pushOverlay({el, modal: false, onEscape: close});
  closeButton.addEventListener('click', close);
  void renderInto('notes', body, {session, close, isOpen: () => open}).then((c) => {
    if (open) content = c; else c?.destroy?.();
  });
  return {el, close, get open() { return open; }};
}

/**
 * Opens a sheet (see the header). `session` is the song session the sheet works on; `anchor` the
 * control it belongs to (a rail popover sits to its left).
 */
export function openSheet(name, {session = null, anchor = null} = {}) {
  if (!SHEETS.includes(name)) throw new RangeError(`openSheet: unknown sheet ${JSON.stringify(name)}`);
  if (current?.name === name && current.handle.open) return current.handle;
  closeSheets();
  const doc = (isElement(anchor) ? anchor.ownerDocument : null) ?? globalThis.document;
  let entry = null;
  const onClosed = () => { if (current === entry) current = null; };

  const notesHost = name === 'notes' ? doc.querySelector('[data-notes-host]') : null;
  if (notesHost) {
    const card = openNotesCard(notesHost, {session, onClosed});
    entry = {name, handle: {name, close: card.close, get open() { return card.open; }}};
    current = entry;
    return entry.handle;
  }

  let open = true, content = null;
  const sheet = Sheet({
    title: COPY.sheets[name], layout: 'auto', anchor: anchorFor(name, anchor, doc), width: POPOVER_WIDTH,
    initialDetent: 60, detents: [40, 60, 90], dataset: {sheet: name}, className: 'stage-sheet',
    onClose: () => {
      open = false;
      try { content?.destroy?.(); } catch (err) { console.error(`[sheets] ${name} cleanup failed`, err); }
      content = null;
      onClosed();
    },
  });
  const close = () => sheet.close('close');
  entry = {name, handle: {name, close, get open() { return open; }}};
  current = entry;
  void renderInto(name, sheet.body, {session, close, isOpen: () => open}).then((c) => {
    if (open) content = c; else c?.destroy?.();
  });
  return entry.handle;
}

/** Closes the open sheet, if any. */
export function closeSheets() {
  const open = current;
  current = null;
  if (open?.handle.open) open.handle.close();
}

/** The open sheet's name, or null. */
export function openSheetName() {
  return current?.handle.open ? current.name : null;
}
