// The Library's window drop (architecture §2.16, spec §3.1): dragging files anywhere over the Library shows a
// full-window target, "Drop to add 3 files"; dropping stages the files and opens the Add sheet (/add), which lists
// them. Nothing uploads until the sheet is confirmed (1.9's silent instant upload is gone).
//
//   startLibraryDrop({router, doc?, win?}) → off      main.js calls it once at boot (§2.3.1 step 7)
//   stageFiles(files)                                 hands files to the next Add sheet (replaces any staged)
//   takeStagedFiles() → File[]                        the Add sheet takes them on mount (and clears them)
//   droppedFiles(dataTransfer) → File[] | Promise<File[]>   a drop's files (a Promise when a folder was dropped: the
//                                                     audio files inside it,
//                                                     a stem pack from Clone Hero, Rock Band or a DAW's bounces)
//   folderOf(file) → string                           the dropped folder a file came from ('' when none)
//
// Only file drags count (dataTransfer.types has 'Files'), and only on the Library place: the home and a
// setlist page, never /welcome or under the /add sheet (the sheet is its own drop zone). Elsewhere a file
// dropped on nothing that wants it is swallowed with the "no drop" cursor, so the browser or the desktop app
// never navigates away to the file. A drop an element handled (it called preventDefault) is left alone.
//
// The target is a manual popover in the top layer (no z-index; it takes no focus and makes nothing inert),
// styled by the Dialog primitive's classes: a centred card on the dimmed window. The window listeners take the
// drop wherever it lands. Screen readers hear the same line through feedback.announce (polite). Esc closes it
// (a non-modal overlay, D36).

import {pushOverlay} from '../app/dispatch.js';
import {announce, cancelAnnounce} from '../app/feedback.js';
import {h} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import '../styles/primitives/dialog.css';

export const COPY = Object.freeze({
  dropTarget: n => (Number.isInteger(n) && n > 0 ? `Drop to add ${n} ${n === 1 ? 'file' : 'files'}` : 'Drop to add files'),
});

/**
 * No dragover for this long means the drag left without a dragleave we could see (Esc, a dragend elsewhere).
 * Above the HTML spec's worst-case gap between dragovers while the pointer is still (350 ms ± 200 ms).
 */
export const DRAG_IDLE_MS = 1000;
const ADD_PATH = '/add';
const ANNOUNCE_KEY = 'library-drop';

let staged = [];
let stopCurrent = null;   // the running startLibraryDrop's off()

/** Hands files to the next Add sheet. */
export function stageFiles(files) {
  staged = [...(files ?? [])].filter(Boolean);
}

/** The staged files, once: the Add sheet calls it when it mounts. */
export function takeStagedFiles() {
  const out = staged;
  staged = [];
  return out;
}

// ---------------------------------------------------------------- folders

/** Files inside a dropped folder that are kept: audio by name (a pack's chart, song.ini or art are not songs). */
const FOLDER_AUDIO = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aiff?|aifc|wma|webm)$/i;
/** How deep and how many: a stem pack is one or two levels; a whole library dropped by mistake stops here. */
const FOLDER_DEPTH = 3;
const FOLDER_FILES = 64;
const folders = new WeakMap();   // File → the dropped folder's path

/** The dropped folder a file came from ('' for a file dropped on its own). */
export function folderOf(file) {
  return (file && folders.get(file)) || '';
}

function readAll(dir) {
  // readEntries answers in batches until it returns none.
  const reader = dir.createReader();
  const out = [];
  return new Promise(resolve => {
    const next = () => reader.readEntries(batch => {
      if (!batch.length) { resolve(out); return; }
      out.push(...batch);
      next();
    }, () => resolve(out));
    next();
  });
}

/**
 * The files a drop carries, at once when no folder was dropped. A dropped folder adds the audio files inside it (FOLDER_DEPTH levels, FOLDER_FILES at
 * most, hidden files skipped), each remembered with its folder (folderOf). The entries are taken now: the browser
 * empties the DataTransfer once the drop event is over.
 */
export function droppedFiles(dt) {
  const plain = dt?.files ? Array.from(dt.files) : [];
  const entries = Array.from(dt?.items ?? []).filter(i => i?.kind === 'file').map(i => i.webkitGetAsEntry?.() ?? null);
  if (!entries.some(e => e?.isDirectory)) return plain;
  const out = [];
  const walk = async (entry, depth) => {
    if (!entry || out.length >= FOLDER_FILES || entry.name?.startsWith('.')) return;
    if (entry.isDirectory) {
      if (depth >= FOLDER_DEPTH) return;
      for (const child of (await readAll(entry)).sort((a, b) => a.name.localeCompare(b.name))) await walk(child, depth + 1);
      return;
    }
    const inFolder = depth > 0;
    if (inFolder && !FOLDER_AUDIO.test(entry.name)) return;
    const file = await new Promise(resolve => entry.file(resolve, () => resolve(null)));
    if (!file) return;
    if (inFolder) folders.set(file, String(entry.fullPath ?? '').split('/').filter(Boolean).slice(0, -1).join('/'));
    out.push(file);
  };
  return (async () => {
    for (const entry of entries) await walk(entry, 0);
    return out;
  })();
}

const typesOf = dt => (dt?.types ? Array.from(dt.types) : []);
const carriesFiles = e => typesOf(e.dataTransfer).includes('Files');

/** How many files a drag carries, or null when the browser does not say before the drop (Safari). */
function fileCount(dt) {
  const items = dt?.items ? Array.from(dt.items) : [];
  const n = items.filter(item => item?.kind === 'file').length;
  return n > 0 ? n : null;
}

/** Whether the current route is the Library place without a modal route over it. */
function onLibrary(router, doc) {
  const match = router?.current?.value ?? router?.current ?? null;
  const route = match?.route ?? null;
  if (route) return route.place === 'library' && !route.modalOver && match.name !== 'welcome';
  return doc.documentElement?.dataset?.place === 'library';
}

/**
 * Starts the Library drop handling (window dragenter/dragover/dragleave/drop). A second call replaces the first. Returns `off`.
 */
export function startLibraryDrop({router = null, doc = globalThis.document, win = globalThis.window} = {}) {
  if (!doc || !win) return () => {};
  stopCurrent?.();

  const title = h('p', {class: 'ui-dialog-title'});
  const el = h('div', {class: 'ui-dialog lib-drop', popover: 'manual', dataset: {testid: 'library-drop'}},
    h('div', {class: 'ui-dialog-form'}, icon('upload', {size: 32}), title));

  let shown = false;
  let depth = 0;
  let idle = null;
  let popOverlay = null;

  const otherModalOpen = () => doc.querySelector('dialog[open]') !== null;
  const active = () => onLibrary(router, doc) && !otherModalOpen();

  function show(count) {
    const text = COPY.dropTarget(count);
    if (shown && title.textContent === text) return;
    title.textContent = text;
    announce(text, {key: ANNOUNCE_KEY});
    if (shown) return;
    shown = true;
    if (!el.isConnected) doc.body.append(el);
    el.showPopover?.();
    popOverlay = pushOverlay({el, modal: false, onEscape: hide});
  }

  function hide() {
    depth = 0;
    win.clearTimeout(idle);
    idle = null;
    if (!shown) return;
    shown = false;
    cancelAnnounce(ANNOUNCE_KEY);
    popOverlay?.();
    popOverlay = null;
    try { el.hidePopover?.(); } catch { /* already hidden */ }
    el.remove();
  }

  function keepAlive() {
    win.clearTimeout(idle);
    idle = win.setTimeout(hide, DRAG_IDLE_MS);
  }

  const onDragEnter = e => {
    if (!carriesFiles(e)) return;
    if (!active()) { if (!shown) return; hide(); return; }
    depth += 1;
    e.preventDefault();
    show(fileCount(e.dataTransfer));
    keepAlive();
  };

  const onDragOver = e => {
    if (!carriesFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    if (active()) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      if (!shown) show(fileCount(e.dataTransfer));
      // Shown by a dragover with no dragenter counted (after the idle hide, or a dragenter ignored while a dialog
      // was open): the pointer is inside the window, so a boundary crossing must not bring the count to 0.
      if (depth === 0) depth = 1;
      keepAlive();
      return;
    }
    hide();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  };

  const onDragLeave = e => {
    if (!shown || !carriesFiles(e)) return;
    // dragenter on the new target comes before dragleave on the old one, so the count reaches 0 only when the
    // drag leaves the window; the idle timer covers browsers that skip that last dragleave.
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  };

  const onDrop = e => {
    if (!carriesFiles(e)) return;
    const wasShown = shown;
    hide();
    if (e.defaultPrevented) return;
    e.preventDefault();   // never let the browser open the file instead of the app
    if (!wasShown && !active()) return;
    const take = files => {
      if (!files.length) return;
      stageFiles(files);
      if (router?.navigate) router.navigate(ADD_PATH);
    };
    const got = droppedFiles(e.dataTransfer);
    if (Array.isArray(got)) take(got); else void got.then(take);
  };

  const onDragEnd = () => hide();

  win.addEventListener('dragenter', onDragEnter);
  win.addEventListener('dragover', onDragOver);
  win.addEventListener('dragleave', onDragLeave);
  win.addEventListener('drop', onDrop);
  win.addEventListener('dragend', onDragEnd);

  const off = () => {
    hide();
    win.removeEventListener('dragenter', onDragEnter);
    win.removeEventListener('dragover', onDragOver);
    win.removeEventListener('dragleave', onDragLeave);
    win.removeEventListener('drop', onDrop);
    win.removeEventListener('dragend', onDragEnd);
    if (stopCurrent === off) stopCurrent = null;
  };
  stopCurrent = off;
  return off;
}
