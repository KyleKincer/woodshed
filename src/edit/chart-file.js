// Import a chart from a file (spec §5.1.2): the one way in, from the Stage (⋯ menu, palette, the empty
// chart), Edit · Chart (Part ▾, the empty chart), Edit · Map and a file dropped on the song. Every way
// opens Find a chart's import (/s/:id/edit/map/find?import=1): the file is read there, lined up with the
// recording, and kept or not (src/edit/map/find-panel.js).
//
//   chartImportPath(songId) → '/s/<id>/edit/map/find?import=1'
//   isChartFile(file) → bool                   a name Import a file… reads (ACCEPT below)
//   handOffFile(songId, file)                  a dropped file waits for the panel …
//   takeHandedFile(songId) → File | null       … which takes it (once) when it opens or is open
//   onHandedFile(songId, fn) → off()           the open panel hears of a file handed over
//   bindChartDrop(el, {songId, navigate, canDrop}) → off()
//     Dragging a chart file over `el` marks it (data-chart-drop) and dropping it hands the file over and
//     navigates to the import. Anything else dropped is left alone (the browser's own handling).

/** The file types Import a file… reads (src/js/tempo-import.js importTempoFile). */
export const ACCEPT = Object.freeze(['.gp3', '.gp4', '.gp5', '.gpx', '.gp', '.sng', '.zip', '.mid', '.midi', '.chart', '.txt', '.tsv', '.lab', '.csv']);

const handed = new Map();
const listeners = new Map();
const key = (songId) => String(songId ?? '');

export const chartImportPath = (songId) => `/s/${encodeURIComponent(songId)}/edit/map/find?import=1`;

export function isChartFile(file) {
  const name = String(file?.name ?? '').toLowerCase();
  return ACCEPT.some((ext) => name.endsWith(ext));
}

export function handOffFile(songId, file) {
  handed.set(key(songId), file);
  for (const fn of [...(listeners.get(key(songId)) ?? [])]) fn();
}

export function takeHandedFile(songId) {
  const file = handed.get(key(songId)) ?? null;
  handed.delete(key(songId));
  return file;
}

export function onHandedFile(songId, fn) {
  const set = listeners.get(key(songId)) ?? new Set();
  set.add(fn);
  listeners.set(key(songId), set);
  return () => { set.delete(fn); if (!set.size) listeners.delete(key(songId)); };
}

/** Files being dragged (the names are hidden until the drop, so any file counts while dragging). */
const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

export function bindChartDrop(el, {songId, navigate, canDrop = () => true} = {}) {
  if (!el?.addEventListener) return () => {};
  let depth = 0;
  const clear = () => { depth = 0; delete el.dataset.chartDrop; };
  const over = (e) => {
    if (!carriesFiles(e) || !canDrop()) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    el.dataset.chartDrop = '';
  };
  const enter = (e) => { if (carriesFiles(e) && canDrop()) depth++; over(e); };
  const leave = () => { if (--depth <= 0) clear(); };
  const drop = (e) => {
    const file = [...(e.dataTransfer?.files ?? [])].find(isChartFile);
    clear();
    if (!file || !canDrop()) return;
    e.preventDefault();
    handOffFile(songId, file);
    navigate?.(chartImportPath(songId));
  };
  el.addEventListener('dragenter', enter);
  el.addEventListener('dragover', over);
  el.addEventListener('dragleave', leave);
  el.addEventListener('drop', drop);
  return () => {
    el.removeEventListener('dragenter', enter);
    el.removeEventListener('dragover', over);
    el.removeEventListener('dragleave', leave);
    el.removeEventListener('drop', drop);
    clear();
  };
}
