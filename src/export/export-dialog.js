// The Export song dialog (Stage ⋯ → Export song…, the palette, the desktop File menu, a Library card's
// Export…): what to put in the ZIP, its size, and Export with progress and Cancel.
//
//   openExportDialog({session}, deps?) → Promise<void>   resolves when the dialog closes
//     deps {exportSong, feedback, window}: replaced in tests
//
// "Export <title>"
//   Stems        one box per stem (all on), and the format: WAV (lines up in any DAW) or Original files
//   Also         Backing track (no <my part>) when the account's part has a stem and others remain;
//                Tempo map (MIDI) and Drum chart (MIDI) need a bar grid; Drum chart (Guitar Pro) needs a chart.
//                A choice the song cannot make is disabled with its reason under it.
//   the size     "About 184 MB"
//   [Export]     → "Writing drums.wav (1 of 5)…" with [Cancel]; done: "Saved <name>.zip." Errors stay inline.
// Closing the dialog cancels an export in progress.
// The Stage opens it while the audio may still be loading: until `session.load` is ready it says so, leaves the
// stems, format and backing track out and keeps Export off, then adds them when the audio is ready. If the audio
// fails to load it offers the MIDI and Guitar Pro files only.
import '../styles/views/export/export-dialog.css';
import * as appFeedback from '../app/feedback.js';
import {Button} from '../ui/button.js';
import {Dialog} from '../ui/dialog.js';
import {h} from '../ui/h.js';
import {InlineStatus} from '../ui/status.js';
import {estimateBytes, exportOptions, exportSong as runExport} from './export-song.js';

export const COPY = Object.freeze({
  title: name => `Export ${name}`,
  lead: 'Files for a DAW, Guitar Pro or another app, in one ZIP. With a bar grid, everything lines up on the same timeline.',
  stems: 'Stems',
  format: 'Format',
  wav: 'WAV',
  wavNote: '16-bit, ready for any DAW',
  original: 'Original files',
  originalNote: 'Smaller, as Woodshed stores them (Opus)',
  also: 'Also include',
  backing: name => name.replace(/\.wav$/, ''),
  backingNote: 'Every other stem, mixed into one file',
  tempoMap: 'Tempo map (MIDI)',
  tempoMapNote: 'Tempo, meter changes and section markers',
  drumMidi: 'Drum chart (MIDI)',
  guitarPro: 'Drum chart (Guitar Pro)',
  needsGrid: 'Needs a bar grid. Use Get bars first.',
  needsChart: 'This song has no drum chart yet.',
  size: bytes => `About ${bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.max(1, Math.round(bytes / 1e6))} MB` : 'under 1 MB'}`,
  export: 'Export',
  exporting: 'Exporting…',
  cancel: 'Cancel',
  close: 'Close',
  saved: name => `Saved ${name}.`,
  canceled: 'Export canceled.',
  failed: 'The export didn’t finish.',
  nothing: 'Choose at least one thing to export.',
  loading: 'Loading the audio… Export is ready when it finishes.',
  loadFailed: 'The audio couldn’t load, so the stems and backing track can’t be exported.',
});

let seq = 0;
const peek = v => (v && typeof v.peek === 'function' ? v.peek() : v);

export async function openExportDialog({session} = {}, deps = {}) {
  if (!session) return;
  const exportSong = deps.exportSong ?? runExport;
  const feedback = deps.feedback ?? appFeedback;
  const win = deps.window ?? globalThis.window;
  let options = exportOptions(session);
  const id = `export-${++seq}`;
  let controller = null, closed = false, phase = null;
  // Export waits for the audio, or for it to fail (then only the MIDI and Guitar Pro files can be written).
  const settled = () => phase === 'ready' || phase === 'error';

  const check = (name, label, {checked = true, disabled = false, note = '', type = 'checkbox', value = '', group = ''} = {}) => {
    const inputId = `${id}-${group || 'x'}-${name}`;
    const input = h('input', {type, id: inputId, name: group || name, value, class: 'export-check-input', checked, disabled,
      attrs: {'data-target-exempt': true}});
    const noteEl = note ? h('span', {class: 'export-check-note', id: `${inputId}-note`}, note) : null;
    if (noteEl) input.setAttribute('aria-describedby', noteEl.id);
    const row = h('label', {class: 'export-check', for: inputId, dataset: {disabled: disabled ? '' : null}},
      input, h('span', {class: 'export-check-text'}, h('span', {class: 'export-check-label'}, label), noteEl));
    return {input, row};
  };
  const fieldset = (legend, ...rows) => h('fieldset', {class: 'export-group'}, h('legend', {class: 'export-legend'}, legend), ...rows);

  // The stems, the format and the backing track need the decoded audio (audioChoices builds them once it is
  // ready); the map and the chart are known from the start.
  let stemBoxes = [], wav = null, original = null, backing = null, stemsGroup = null, formatGroup = null;
  const tempoMap = check('tempo', COPY.tempoMap, {checked: options.mapped, disabled: !options.mapped,
    note: options.mapped ? COPY.tempoMapNote : COPY.needsGrid});
  const drumMidi = check('drum-midi', COPY.drumMidi, {checked: options.mapped && options.hasChart, disabled: !options.mapped || !options.hasChart,
    note: !options.hasChart ? COPY.needsChart : !options.mapped ? COPY.needsGrid : ''});
  const guitarPro = check('gp', COPY.guitarPro, {checked: options.hasChart, disabled: !options.hasChart, note: options.hasChart ? '' : COPY.needsChart});
  const inputs = () => [...stemBoxes, wav, original, backing, tempoMap, drumMidi, guitarPro].filter(Boolean).map(c => c.input);

  const audio = InlineStatus({tone: 'info', text: '', className: 'export-audio'});
  const size = h('p', {class: 'export-size', attrs: {'aria-live': 'polite'}});
  const status = InlineStatus({tone: 'info', text: '', className: 'export-status'});
  const setStatus = (tone, text) => { status.el.hidden = !text; status.set({tone, text: text ?? ''}); };
  setStatus('info', '');

  const choices = () => ({
    stems: stemBoxes.filter(c => c.input.checked).map(c => c.input.value),
    format: original?.input.checked ? 'original' : 'wav',
    backing: !!backing?.input.checked,
    tempoMap: tempoMap.input.checked && !tempoMap.input.disabled,
    drumMidi: drumMidi.input.checked && !drumMidi.input.disabled,
    guitarPro: guitarPro.input.checked && !guitarPro.input.disabled,
  });
  const anything = c => c.stems.length || c.backing || c.tempoMap || c.drumMidi || c.guitarPro;

  const exportButton = Button({label: COPY.export, variant: 'primary', icon: 'download', className: 'export-go', onClick: () => start()});
  const cancelButton = Button({label: COPY.cancel, variant: 'secondary', className: 'export-cancel', onClick: () => controller?.abort()});
  cancelButton.el.hidden = true;

  function paint() {
    const busy = !!controller, c = choices();
    for (const input of inputs()) input.disabled = busy || input.dataset.locked === 'true';
    size.hidden = !settled();
    size.textContent = COPY.size(estimateBytes(options, c));
    exportButton.set({disabled: busy || !settled() || !anything(c), busy: busy ? COPY.exporting : false});
    cancelButton.el.hidden = !busy;
  }
  const watch = (box) => {
    if (box.input.disabled) box.input.dataset.locked = 'true';
    box.input.addEventListener('change', () => { setStatus('info', ''); paint(); });
    return box;
  };
  [tempoMap, drumMidi, guitarPro].forEach(watch);

  const also = fieldset(COPY.also, tempoMap.row, drumMidi.row, guitarPro.row);
  const body = h('div', {class: 'export-dialog-body'},
    h('p', {class: 'export-lead'}, COPY.lead),
    audio.el,
    also,
    size,
    h('div', {class: 'export-actions'}, exportButton.el, cancelButton.el),
    status.el);

  /** The stems, their format and the backing track, from the decoded audio. */
  function audioChoices() {
    for (const el of [stemsGroup, formatGroup, backing?.row]) el?.remove();
    options = exportOptions(session);
    stemBoxes = options.stems.map(s => watch(check(`stem-${s.name}`, s.name, {group: 'stems', value: s.name})));
    wav = watch(check('wav', COPY.wav, {type: 'radio', group: 'format', value: 'wav', note: COPY.wavNote}));
    original = watch(check('original', COPY.original, {type: 'radio', group: 'format', value: 'original', checked: false,
      note: COPY.originalNote, disabled: !options.original}));
    backing = options.canBacking ? watch(check('backing', COPY.backing(options.backingName), {note: COPY.backingNote})) : null;
    stemsGroup = options.stems.length ? fieldset(COPY.stems, h('div', {class: 'export-stems'}, ...stemBoxes.map(c => c.row))) : null;
    formatGroup = options.stems.length ? fieldset(COPY.format, wav.row, original.row) : null;
    audio.el.after(...[stemsGroup, formatGroup].filter(Boolean));
    if (backing) tempoMap.row.before(backing.row);
  }
  function showLoad(load) {
    const next = load?.phase ?? null;
    if (next === phase) return;   // progress within a phase
    phase = next;
    if (phase === 'ready') audioChoices();
    audio.el.hidden = phase === 'ready';
    audio.set(phase === 'error' ? {tone: 'warn', text: COPY.loadFailed} : {tone: 'info', text: phase === 'ready' ? '' : COPY.loading});
    paint();
  }
  showLoad(peek(session.load));
  const offLoad = session.load?.subscribe?.(showLoad);

  const dialog = Dialog({title: COPY.title(options.title), body, className: 'export-dialog', width: 520,
    actions: [{label: COPY.close, value: true, variant: 'secondary'}]});
  paint();

  function start() {
    if (controller || closed || !settled()) return;
    const c = choices();
    if (!anything(c)) { setStatus('warn', COPY.nothing); return; }
    controller = new AbortController();
    const signal = controller.signal;
    setStatus('info', COPY.exporting);
    paint();
    // exportSong opens the save picker synchronously, inside this click.
    let run;
    try {
      run = exportSong(session, c, {signal, window: win, onProgress: (text) => { if (!closed) setStatus('info', text); }});
    } catch (err) {
      run = Promise.reject(err);
    }
    Promise.resolve(run).then((result) => {
      if (closed) return;
      setStatus('ok', COPY.saved(result?.name ?? 'the export'));
      feedback.announce?.(COPY.saved(result?.name ?? 'the export'));
    }, (err) => {
      if (closed) return;
      if (err?.name === 'AbortError') setStatus('info', COPY.canceled);
      else setStatus('error', err?.message || COPY.failed);
    }).finally(() => {
      controller = null;
      if (!closed) paint();
    });
  }

  try {
    await dialog.closed;
  } finally {
    closed = true;
    offLoad?.();
    controller?.abort();
    exportButton.destroy();
    cancelButton.destroy();
    status.destroy();
    audio.destroy();
  }
}
