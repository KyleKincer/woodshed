// Find a chart (architecture §2.15, D20; spec §5.1.2; maps/mapedit.md §7, §11.4): the side panel that
// replaces Edit · Map's inspector at /s/:id/edit/map/find. It tries other people's tempo maps (Chorus
// Encore and the Harmonix Set, or a local file) against the recording with nothing made inert.
//
//   mountFindPanel(el, {session, mapSession, onClose}) → {destroy, keepMine(), useTheirs(), useWithDrums(), state}
//     session      the song Session (map, transport, notation, song, engine, mapChange)
//     mapSession   Edit · Map's MapSession: beginAudition() on mount, endAudition({commit}) to finish (D20)
//     onClose({result: 'theirs'|'drums'|'mine'})   after a commit; default: back to /s/:id/edit/map (replace)
//   Test and harness seams (optional): api {search, load} (src/api/tempo-sources.js), router, feedback,
//   registry, importFile (src/js/tempo-import.js importTempoFile).
//
// The audition (D20):
// - Mounting opens one map batch (mapSession.beginAudition): tempo saves, notation map-sync saves and bar
//   re-anchoring are suspended by the session, and every other map edit, `map.undo` and `map.redo` are
//   refused while it lasts (the Edit · Map commands' `when: c => !c.map.auditioning`).
// - Each try is `map.replace(candidate, 'tempo-source')` (bar N keeps the song's bar N id, and the song's
//   section label when the source names none); the notation guards refuse a candidate that would strand
//   drum notes, and the map stays as it was. "Your map" is `map.restore(snapshot)`: the pre-audition data
//   exactly, never a replace (which would stamp origin 'imported').
// - Use their map → endAudition({commit: true}): one map-stack undo step, saved at once.
//   Use map + drum chart (N hits) → the drum part is imported first (src/edit/drum-import.js; a song that
//   already has a drum chart asks "Replace the drum chart?" first, and Cancel leaves the audition open),
//   then the same commit.
//   Keep my map (and Esc anywhere in the panel) → endAudition({commit: false}) → abortBatch: the map, both
//   undo stacks and the saved tempo are exactly as before. There is no separate Cancel.
// - Leaving mid-audition (router.onLeave, which never blocks navigation): to this song's Edit · Map
//   (closing Find, e.g. Esc from the lanes or Back) it is Keep my map. To a place that keeps this song's
//   session (the Stage, another Edit tab) the audition ends as Keep my map at once (nothing is saved or
//   left half-applied) and then asks "Use this map?" [Use it] [Keep my map]; Use it applies the map you
//   were trying through session.mapChange (one undo step on the posture's stack, D23). To anywhere else
//   (the session is about to close) your map is kept and a toast says so. A drum import in flight is
//   committed. Hiding the tab (onLeave with no destination) changes nothing.
// - Late answers (a slow search, a slow download, a file still parsing) never apply after the panel
//   closed or after a later choice (revision tokens).
//
// Keys: the panel declares data-consume-keys="Escape" and handles Esc itself; its text fields keep every
// other key (dispatch rule 4), so typing never reaches the registry. Space on the panel's buttons and
// radio rows reaches the registry like everywhere in Edit (D35): Play / Stop auditions the map you chose
// with the main transport. Arrow keys move through the result rows (native radios).
//
// ?import=1 (the chart surface's "Import a file"): the panel focuses Import a file… and opens the file
// picker at once when the page still has the user's gesture (navigator.userActivation.isActive).
import '../../styles/views/edit/find.css';
import {registry as appRegistry} from '../../app/commands.js';
import {describeError} from '../../app/error-copy.js';
import * as appFeedback from '../../app/feedback.js';
import {effect, signal, readonly} from '../../app/store.js';
import * as tempoSources from '../../api/tempo-sources.js';
import {Button} from '../../ui/button.js';
import {TextField} from '../../ui/field.js';
import {h, reconcileList} from '../../ui/h.js';
import {icon} from '../../ui/icon.js';
import {InlineStatus} from '../../ui/status.js';
import {importTempoFile, offsetTempoMap, parseBeatText, parseTempoFile} from '../../js/tempo-import.js';
import {compile, hasPickup, timeAt} from '../../../shared/song-map.ts';
import {number} from '../../../shared/notation.ts';
import {importDrumResult, previewDrumImport, replaceDialog} from '../drum-import.js';

/** The file types Import a file… accepts (every format importTempoFile reads). */
export const ACCEPT = Object.freeze(['.gp3', '.gp4', '.gp5', '.gpx', '.gp', '.sng', '.zip', '.mid', '.midi', '.chart', '.txt', '.tsv', '.lab', '.csv']);
/** The offset buttons, in milliseconds. */
export const SHIFTS = Object.freeze([-100, -10, 10, 100]);
/** Offsets beyond this are refused (milliseconds). */
export const MAX_OFFSET_MS = 3_600_000;
/** A source this much longer or shorter than the recording (seconds) is probably another performance. */
export const MISMATCH_SEC = 2;
/** The longest pre-filled query (the server allows 300 characters). */
export const QUERY_MAX = 160;
export const ENCHOR_URL = 'https://www.enchor.us/';
export const SONGSTERR_URL = 'https://www.songsterr.com/';

const SOURCE_NAMES = Object.freeze({harmonix: 'Harmonix Set', chorus: 'Chorus Encore'});
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const msText = (ms) => {
  const r = Math.round(ms * 10) / 10;
  return Number.isInteger(r) ? String(Math.abs(r)) : Math.abs(r).toFixed(1);
};
/** m:ss for a duration in seconds. */
export function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Every string the panel shows (spec §5.1.2). */
export const COPY = Object.freeze({
  title: 'Find a chart',
  intro: 'Try a chart’s tempo map with your recording, line it up, then choose which map to keep.',
  queryLabel: 'Song or artist',
  search: 'Search',
  scope: 'Searches Chorus Encore and the Harmonix Set.',
  resultsLegend: 'Maps to try',
  yourMap: 'Your map',
  yourMapDetail: 'The map you had before trying charts',
  drumBadge: 'Drum chart',
  chartBy: (name) => `Chart by ${name}`,
  importedSource: 'Imported file',
  loadingRow: 'Loading…',
  importFile: 'Import a file…',
  importHint: 'Guitar Pro, MIDI, Clone Hero .chart, Chorus .sng or .zip, or beat timestamps (.txt, .csv, .tsv, .lab). '
    + 'Files up to 10 MB, song packages up to 128 MB. Nothing is uploaded.',
  otherSources: 'Other sources',
  otherBefore: 'Browse ',
  enchor: 'Chorus Encore',
  otherMiddle: ' or download MIDI from ',
  songsterr: 'Songsterr',
  otherAfter: ', then import the file here. Guitar Pro files import directly, drums included. '
    + 'Their timing follows the score’s playback and repeats, so check the alignment.',
  newTab: '(opens in a new tab)',
  alignLegend: 'Align',
  listeningTo: 'Listening to',
  alignHint: 'Press Space to hear it with the click. Check near the start and near the end.',
  play: 'Play / Stop',
  offsetLabel: 'Offset (ms)',
  offsetHint: 'Moves the whole map. Positive is later.',
  shift: (ms) => `${ms < 0 ? '−' : '+'}${Math.abs(ms)}`,
  shiftLabel: (ms) => `Move the map ${Math.abs(ms)} ms ${ms < 0 ? 'earlier' : 'later'}`,
  lineUp: 'Line up first downbeat with the cue',
  reset: 'Reset',
  alignReason: 'Choose a map above to line it up.',
  useTheirs: 'Use their map',
  useWithDrums: (n) => `Use map + drum chart (${plural(n, 'hit')})`,
  keepMine: 'Keep my map',
  chooseFirst: 'Choose a map above first.',
  noDrumsInside: 'None of its drum hits fall inside the recording.',
  drumsReady: (n, skipped) => `${plural(n, 'drum hit')} ready to import${skipped ? ` · ${skipped} skipped` : ''}`,
  drumsError: (text) => `Its drum chart can’t be imported: ${text}`,
  mismatch: (diff, longer) => `This version is ${diff.toFixed(1)} seconds ${longer ? 'longer' : 'shorter'} than your recording. Check that it is the same performance.`,
  // status line
  start: 'Search for the song, or import a file.',
  emptyQuery: 'Type a song title or artist to search.',
  searching: 'Looking for charts…',
  found: (n) => `${plural(n, 'possible map')}. Choose one to hear it with your recording.`,
  none: 'No matches in Chorus Encore or the Harmonix Set. Import a file, or try another title.',
  incomplete: 'Search incomplete. You can still import a file, or try another title.',
  unavailable: (text) => `Search unavailable. ${text} You can still import a file.`,
  loading: (title) => `Loading ${title}…`,
  loaded: 'Map loaded. Play the recording and check the click near the start and the end.',
  original: 'Back to your map.',
  reading: (name) => `Reading ${name}…`,
  fileLoaded: 'File loaded. Line it up, then choose which map to keep.',
  offsetMoved: (ms) => (Math.abs(ms) < 0.05 ? 'At the source map’s own timing.' : `${msText(ms)} ms ${ms < 0 ? 'earlier' : 'later'} than the source map.`),
  offsetRange: `Choose an offset between −${MAX_OFFSET_MS.toLocaleString('en-US')} and +${MAX_OFFSET_MS.toLocaleString('en-US')} ms.`,
  noTiming: 'That source has no tempo map.',
  importing: 'Importing the drum chart…',
  drumsImported: (n, skipped, replaced = false) => `${replaced ? 'Replaced the drum chart with' : 'Imported'} ${plural(n, 'drum hit')}${skipped ? ` · ${skipped} skipped` : ''}. The bars are drafts; check them in Edit · Chart.`,
  failed: 'That didn’t work. Try again or choose another map.',
  notStarted: 'Find a chart can’t start while another audition is open.',
  closed: 'Find a chart has closed. Open it again to try another map.',
  // leaving mid-audition (D20)
  leaveTitle: 'Use this map?',
  leaveBody: (name) => `You were trying “${name}”. Use it as this song’s map, or keep yours.`,
  leaveUse: 'Use it',
  leaveKeep: 'Keep my map',
  leaveUndo: 'Use their map',
  usedTheirs: 'Using their map',
  undo: 'Undo',
  notApplied: 'Their map couldn’t be applied. Your map is unchanged.',
  leftKept: 'Kept your map. The chart you were trying wasn’t used.',
  drumsFailedAfterLeave: (text) => `Their map was kept, but the drum chart wasn’t imported: ${text}`,
});

/** The panel's controls by role and accessible name (the table-driven test renders each). */
export const CONTROLS = Object.freeze([
  {role: 'region', name: COPY.title},
  {role: 'searchbox', name: COPY.queryLabel},
  {role: 'button', name: COPY.search},
  {role: 'radiogroup', name: COPY.resultsLegend},
  {role: 'radio', name: COPY.yourMap},
  {role: 'button', name: COPY.importFile},
  {role: 'link', name: `${COPY.enchor} ${COPY.newTab}`},
  {role: 'link', name: `${COPY.songsterr} ${COPY.newTab}`},
  {role: 'group', name: COPY.alignLegend},
  {role: 'button', name: COPY.play, command: 'transport.playStop'},
  ...SHIFTS.map((ms) => ({role: 'button', name: COPY.shiftLabel(ms)})),
  {role: 'spinbutton', name: COPY.offsetLabel},
  {role: 'button', name: COPY.lineUp},
  {role: 'button', name: COPY.reset},
  {role: 'button', name: COPY.useTheirs},
  {role: 'button', name: COPY.keepMine},
]);

/** Decode a tempo-source download on this device (maps/mapedit.md §7.1: the online-load decoder). */
export async function decodeSource(raw, {duration, meter} = {}) {
  if (!raw || typeof raw !== 'object') throw new Error(COPY.noTiming);
  const imported = raw.format === 'beats'
    ? parseBeatText(raw.text, {duration, meter})
    : parseTempoFile(raw.data, {name: raw.format === 'midi' ? 'notes.mid' : 'notes.chart', duration});
  const aligned = raw.metadata ? (await import('../../js/tempo-archive.js')).applyChartMetadata(imported, raw.metadata) : imported;
  return {...aligned, sourceUrl: raw.sourceUrl};
}

/** The quarter-note position of a map's first downbeat: bar 1, after a pickup. */
export function firstDownbeatQ(data) {
  return hasPickup(data) ? number(data.measures[0].length) : 0;
}

/** Links to browse elsewhere, searched for this song. */
export function otherSourceLinks(song = {}) {
  const enchor = new URL(ENCHOR_URL);
  if (song.title) enchor.searchParams.set('name', song.title);
  if (song.artist) enchor.searchParams.set('artist', song.artist);
  const songsterr = new URL(SONGSTERR_URL);
  const pattern = [song.artist, song.title].filter(Boolean).join(' ');
  if (pattern) songsterr.searchParams.set('pattern', pattern);
  return {enchor: enchor.href, songsterr: songsterr.href};
}

/** The meta line of a result row. */
export function rowMeta(item) {
  if (item.id === 'original') return COPY.yourMapDetail;
  return [item.artist, item.album, SOURCE_NAMES[item.source] ?? item.source, item.charter ? COPY.chartBy(item.charter) : '']
    .filter(Boolean).join(' · ');
}

const peek = (v) => (v && typeof v === 'object' && typeof v.peek === 'function' ? v.peek() : v);
const json = (v) => JSON.stringify(v);

function errorText(err) {
  if (err && typeof err === 'object' && typeof err.code === 'string' && err.code !== 'unknown' && err.name === 'ApiError') {
    return describeError(err, {context: 'load'}).sentence;
  }
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return text || COPY.failed;
}

let panelSeq = 0;

/** Mount the Find a chart panel into `el` (the inspector's place). See the header. */
export function mountFindPanel(el, {session, mapSession, onClose, api = tempoSources, router: routerOption, feedback = appFeedback,
  registry = appRegistry, importFile = importTempoFile} = {}) {
  if (!session?.map) throw new TypeError('mountFindPanel needs a session.');
  if (!mapSession) throw new TypeError('mountFindPanel needs the Edit · Map session.');
  const map = session.map;
  const seq = ++panelSeq;
  const router = routerOption ?? (() => { try { return registry.context?.()?.router ?? null; } catch { return null; } })();
  const song = () => peek(session.song) ?? {};
  const duration = () => Number(session.engine?.duration) || Number(map.duration) || Number(song().duration) || 1;
  const offs = [];

  // ---------- state ----------
  const state = signal({phase: 'open', busy: false});   // phase 'open' | 'ended'; busy while the drum chart imports
  let ended = false, destroyed = false, importing = false, exitCommitted = false;
  let searchRev = 0, loadRev = 0, localSeq = 0, rowSeq = 0, searching = false;
  const begun = mapSession.beginAudition();
  const snapshot = map.snapshot();
  const original = {id: 'original', title: COPY.yourMap, result: {map: snapshot, warnings: []}, offset: 0};
  let items = [original];
  let selected = original;
  let pending = null;          // the item whose download or parse is in flight
  let drumPreview = null;      // {count, skipped, warnings} | {error} | null
  if (!begun) ended = true;

  // ---------- DOM ----------
  const titleId = `find-${seq}-title`;
  const say = InlineStatus({tone: 'info', text: '', className: 'find-status'});
  const setStatus = (text, tone = 'info') => {
    say.set({text, tone});
    say.el.hidden = !text;
  };
  setStatus('');

  const query = TextField({label: COPY.queryLabel, type: 'search', maxLength: 300, autocomplete: 'off', value: [song().artist, song().title].filter(Boolean).join(' ').slice(0, QUERY_MAX),
    className: 'find-query'});
  const searchButton = Button({label: COPY.search, type: 'submit', icon: 'search', variant: 'secondary', className: 'find-search-button'});
  const searchForm = h('form', {class: 'find-search', role: 'search', on: {submit: (e) => { e.preventDefault(); void find(); }}},
    h('div', {class: 'find-search-row'}, query.el, searchButton.el),
    h('p', {class: 'find-scope'}, COPY.scope));

  const radioName = `find-${seq}-choice`;
  const rows = h('div', {class: 'find-rows'});
  const resultsLegendId = `find-${seq}-results`;
  const results = h('fieldset', {class: 'find-results', role: 'radiogroup', 'aria-labelledby': resultsLegendId,
    attrs: {'data-consume-keys': 'ArrowUp ArrowDown ArrowLeft ArrowRight Enter'}},
  h('legend', {class: 'find-legend', id: resultsLegendId}, COPY.resultsLegend), rows);

  const fileInput = h('input', {type: 'file', accept: ACCEPT.join(','), hidden: true, tabIndex: -1, attrs: {'aria-hidden': 'true'},
    on: {change: () => { void readFile(); }}});
  const importHintId = `find-${seq}-import-hint`;
  const importButton = Button({label: COPY.importFile, icon: 'upload', variant: 'secondary', className: 'find-import-button',
    attrs: {'aria-describedby': importHintId}, onClick: () => fileInput.click()});
  const importBlock = h('div', {class: 'find-import'}, importButton.el, fileInput, h('p', {class: 'find-hint', id: importHintId}, COPY.importHint));

  const links = otherSourceLinks(song());
  const external = (href, label) => h('a', {class: 'find-link', href, target: '_blank', rel: 'noopener noreferrer'},
    label, h('span', {class: 'sr-only'}, ` ${COPY.newTab}`), icon('external-link', {size: 16}));
  const others = h('details', {class: 'find-others'},
    h('summary', {class: 'find-others-summary'}, icon('chevron-right', {size: 20}), h('span', {}, COPY.otherSources)),
    h('p', {class: 'find-others-body'}, COPY.otherBefore, external(links.enchor, COPY.enchor), COPY.otherMiddle,
      external(links.songsterr, COPY.songsterr), COPY.otherAfter));

  // Align
  const currentName = h('strong', {class: 'find-current-name'});
  const currentDetail = h('span', {class: 'find-current-detail'});
  const play = Button({label: COPY.play, command: 'transport.playStop', registry, icon: 'play', variant: 'secondary', className: 'find-play'});
  const listening = h('div', {class: 'find-listening'},
    h('div', {class: 'find-current'}, h('span', {class: 'find-current-label'}, COPY.listeningTo), currentName, currentDetail),
    play.el);
  const alignHint = h('p', {class: 'find-hint'}, COPY.alignHint);
  const warnings = h('ul', {class: 'find-warnings', hidden: true});
  const shiftButtons = SHIFTS.map((ms) => {
    return Button({label: COPY.shift(ms), size: 'sm', variant: 'secondary', className: 'find-shift', dataset: {shift: String(ms)},
      attrs: {'aria-label': COPY.shiftLabel(ms)}, onClick: () => changeOffset(offsetMs() + ms)});
  });
  const offsetField = TextField({label: COPY.offsetLabel, type: 'number', value: '0', hint: COPY.offsetHint, inputmode: 'numeric', size: 'sm',
    className: 'find-offset', onCommit: (value) => changeOffset(Number(value))});
  offsetField.input.step = '1';
  offsetField.input.min = String(-MAX_OFFSET_MS);
  offsetField.input.max = String(MAX_OFFSET_MS);
  const offsetRow = h('div', {class: 'find-offset-row'}, shiftButtons[0].el, shiftButtons[1].el, offsetField.el, shiftButtons[2].el, shiftButtons[3].el);
  const lineUp = Button({label: COPY.lineUp, icon: 'arrow-down-to-line', variant: 'secondary', size: 'sm', className: 'find-line-up', onClick: () => lineUpWithCue()});
  const reset = Button({label: COPY.reset, icon: 'rotate-ccw', variant: 'quiet', size: 'sm', className: 'find-reset', onClick: () => changeOffset(0)});
  const alignReasonId = `find-${seq}-align-reason`;
  const alignReason = h('p', {class: 'find-reason', id: alignReasonId}, COPY.alignReason);
  const alignControls = h('fieldset', {class: 'find-align-controls', 'aria-describedby': alignReasonId},
    h('legend', {class: 'sr-only'}, COPY.offsetLabel),
    offsetRow, h('div', {class: 'find-align-actions'}, lineUp.el, reset.el));
  const align = h('fieldset', {class: 'find-align'},
    h('legend', {class: 'find-legend'}, COPY.alignLegend),
    listening, alignHint, warnings, alignReason, alignControls);

  // Commit
  const useTheirsButton = Button({label: COPY.useTheirs, variant: 'primary', icon: 'check', className: 'find-use', onClick: () => useTheirs()});
  const drumsButton = Button({label: COPY.useWithDrums(0), variant: 'secondary', icon: 'drum', className: 'find-use-drums', onClick: () => { void useWithDrums(); }});
  const keepButton = Button({label: COPY.keepMine, variant: 'secondary', className: 'find-keep', onClick: () => keepMine()});
  const commit = h('div', {class: 'find-commit'}, useTheirsButton.el, drumsButton.el, keepButton.el);

  const controls = h('fieldset', {class: 'find-controls'}, searchForm, results, importBlock, others, align);
  const root = h('section', {class: 'find-panel', 'aria-labelledby': titleId, dataset: {findPanel: '', state: 'open'},
    attrs: {'data-consume-keys': 'Escape'}},
  h('header', {class: 'find-header'},
    h('h2', {class: 'find-title', id: titleId}, COPY.title),
    h('p', {class: 'find-intro'}, COPY.intro)),
  say.el, controls, commit);
  root.addEventListener('keydown', onKey);
  el.append(root);

  // ---------- rendering ----------
  function renderRows() {
    reconcileList(rows, items, {
      key: (item) => item.id,
      create: (item) => {
        const rowId = `${radioName}-${++rowSeq}`;
        const input = h('input', {type: 'radio', name: radioName, value: item.id, class: 'find-radio',
          'aria-labelledby': `${rowId}-title`, 'aria-describedby': `${rowId}-meta`,
          on: {change: () => { if (input.checked) void choose(item.id); }}});
        const title = h('span', {class: 'find-row-title', id: `${rowId}-title`});
        const meta = h('span', {class: 'find-row-meta', id: `${rowId}-meta`});
        const badge = h('span', {class: 'find-badge'}, COPY.drumBadge);
        const time = h('span', {class: 'find-row-time'});
        const busy = h('span', {class: 'find-row-busy'}, COPY.loadingRow);
        const row = h('label', {class: 'find-row', dataset: {choice: item.id}}, input,
          h('span', {class: 'find-row-main'}, title, meta), badge, time, busy);
        const update = (it) => {
          title.textContent = it.title;
          meta.textContent = rowMeta(it);
          badge.hidden = !(it.hasDrums || it.result?.drums?.hits?.length);
          time.textContent = clock(it.duration);
          time.hidden = !time.textContent;
          busy.hidden = pending !== it;
          row.dataset.state = pending === it ? 'loading' : selected === it ? 'selected' : '';
          if (pending === it) row.setAttribute('aria-busy', 'true'); else row.removeAttribute('aria-busy');
          // The row being downloaded shows as chosen (the user's choice); a failure falls back to the live map's row.
          input.checked = (pending ?? selected) === it;
        };
        update(item);
        return {el: row, update};
      },
    });
  }

  function renderSelection() {
    const tried = selected !== original;
    currentName.textContent = selected.title;
    currentDetail.textContent = tried ? rowMeta(selected) : '';
    // Warnings: the source's own, its drums', the drum preview's, and a duration mismatch.
    const list = [...(selected.result?.warnings ?? [])];
    drumPreview = null;
    const hits = selected.result?.drums?.hits?.length ?? 0;
    if (tried && hits) {
      try {
        const preview = previewDrumImport(selected.result, {map: map.serialize(), duration: duration()});
        drumPreview = {count: preview.importedCount, skipped: preview.skippedCount};
        list.push(...preview.warnings);
      } catch (err) {
        drumPreview = {error: errorText(err)};
        list.push(COPY.drumsError(drumPreview.error));
      }
    }
    if (tried && Number.isFinite(selected.duration)) {
      const diff = selected.duration - duration();
      if (Math.abs(diff) > MISMATCH_SEC) list.push(COPY.mismatch(Math.abs(diff), diff > 0));
    }
    const unique = [...new Set(list.filter(Boolean))];
    warnings.replaceChildren(...unique.map((text) => h('li', {class: 'find-warning'}, icon('alert-triangle', {size: 16}), h('span', {}, text))));
    warnings.hidden = !unique.length;
    offsetField.set({value: String(Math.round((selected.offset || 0) * 1000))});
    alignReason.hidden = tried;
    alignControls.disabled = !tried || importing || ended;
    renderCommit();
    renderRows();
  }

  function renderCommit() {
    const busy = importing;
    const tried = selected !== original;
    useTheirsButton.set({disabled: ended || busy || !tried, disabledReason: !ended && !busy && !tried ? COPY.chooseFirst : null});
    const hits = tried ? selected.result?.drums?.hits?.length ?? 0 : 0;
    drumsButton.el.hidden = !hits;
    if (hits) {
      const count = drumPreview?.count ?? hits;
      const reason = drumPreview?.error ? COPY.drumsError(drumPreview.error)
        : drumPreview && !drumPreview.count ? COPY.noDrumsInside : null;
      drumsButton.set({label: COPY.useWithDrums(count), disabled: ended || busy || !!reason, disabledReason: ended || busy ? null : reason,
        busy: busy ? COPY.importing : false});
    }
    keepButton.set({disabled: ended || busy});
  }

  function renderState() {
    const busy = importing;
    if (state.peek().busy !== busy || (state.peek().phase === 'ended') !== ended) state.value = {phase: ended ? 'ended' : 'open', busy};
    root.dataset.state = ended ? 'ended' : busy ? 'busy' : 'open';
    if (busy) root.setAttribute('aria-busy', 'true'); else root.removeAttribute('aria-busy');
    controls.disabled = ended || busy;
    searchButton.set({disabled: ended || busy || searching});
    renderSelection();
  }

  // ---------- trying maps ----------
  const live = () => !ended && !destroyed;

  /** Put `item` (with `offset` seconds) on the live map. Throws the model's or a guard's refusal; the map is then unchanged. */
  function apply(item, offset = item.offset || 0) {
    if (item === original) {
      map.restore(snapshot);
    } else {
      if (!item.result?.map) throw new Error(COPY.noTiming);
      const next = offsetTempoMap(item.result.map, offset);
      // Bar N stays bar N of the song (drum notes stay attached); the song's section names survive
      // unless the source names that bar.
      next.measures.forEach((m, i) => {
        const base = snapshot.measures[i];
        if (!base) return;
        m.id = base.id;
        if (!m.label && base.label) m.label = base.label;
      });
      map.replace(next, 'tempo-source');
    }
    item.offset = item === original ? 0 : offset;
    selected = item;
  }

  async function choose(id) {
    const item = items.find((it) => it.id === id);
    if (!item || !live() || importing) { renderSelection(); return; }
    const token = ++loadRev;
    try {
      if (!item.result) {
        pending = item;
        renderRows();
        setStatus(COPY.loading(item.title));
        const raw = await api.load({id: item.id});
        if (token !== loadRev || !live()) return;
        item.result = await decodeSource(raw, {duration: duration(), meter: item.meter});
        if (token !== loadRev || !live()) return;
      }
      apply(item);
      setStatus(item === original ? COPY.original : COPY.loaded, item === original ? 'info' : 'ok');
    } catch (err) {
      if (token === loadRev && live()) setStatus(errorText(err), 'error');
    } finally {
      if (token === loadRev) pending = null;
      if (!destroyed) renderSelection();
    }
  }

  async function find() {
    if (!live() || importing) return;
    const text = query.input.value.trim();
    const rev = ++searchRev;
    if (!text) { setStatus(COPY.emptyQuery); return; }
    searching = true;
    searchButton.set({disabled: true, busy: true});
    setStatus(COPY.searching);
    try {
      const response = await api.search({query: text.slice(0, 300), duration: duration()});
      if (rev !== searchRev || !live()) return;
      const candidates = (Array.isArray(response) ? response : response?.candidates ?? []).filter((c) => c && typeof c.id === 'string' && c.id);
      const searchWarnings = Array.isArray(response?.warnings) ? response.warnings.filter(Boolean) : [];
      const kept = items.filter((it) => it === original || it.local || it === selected || it === pending);
      const ids = new Set(kept.map((it) => it.id));
      items = [...kept, ...candidates.filter((c) => !ids.has(c.id)).map((c) => ({...c, offset: 0}))];
      const summary = candidates.length ? COPY.found(candidates.length) : searchWarnings.length ? COPY.incomplete : COPY.none;
      setStatus([summary, ...searchWarnings].join(' '), !candidates.length && searchWarnings.length ? 'error' : 'info');
      renderRows();
    } catch (err) {
      if (rev === searchRev && live()) setStatus(COPY.unavailable(errorText(err)), 'error');
    } finally {
      if (rev === searchRev) {
        searching = false;
        if (!destroyed) searchButton.set({disabled: !live() || importing, busy: false});
      }
    }
  }

  async function readFile() {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file || !live() || importing) return;
    const token = ++loadRev;
    pending = null;   // a download still in flight loses to the file
    renderRows();
    setStatus(COPY.reading(file.name));
    try {
      const result = await importFile(file, {duration: duration()});
      if (token !== loadRev || !live()) return;
      const item = {id: `file-${++localSeq}`, title: file.name, source: COPY.importedSource, local: true, result, offset: 0,
        hasDrums: !!result?.drums?.hits?.length};
      apply(item);
      items.push(item);
      setStatus(COPY.fileLoaded, 'ok');
      renderSelection();
    } catch (err) {
      if (token === loadRev && live()) setStatus(errorText(err), 'error');
    }
  }

  const offsetMs = () => (selected.offset || 0) * 1000;

  function changeOffset(ms) {
    if (!live() || importing || selected === original) return;
    ++loadRev;   // a late download must not replace the map being lined up
    pending = null;
    try {
      if (!Number.isFinite(ms) || Math.abs(ms) > MAX_OFFSET_MS) throw new Error(COPY.offsetRange);
      apply(selected, ms / 1000);
      setStatus(COPY.offsetMoved(ms), 'ok');
    } catch (err) {
      setStatus(errorText(err), 'error');
    }
    renderSelection();
  }

  function lineUpWithCue() {
    if (!live() || selected === original || !selected.result?.map) return;
    const snap = peek(session.transport?.snapshot);
    const cue = Number.isFinite(snap?.cue) ? snap.cue : Number(session.engine?.editPosition ?? session.engine?.getPosition?.());
    const source = selected.result.map;
    const at = timeAt(compile(source), firstDownbeatQ(source));
    if (!Number.isFinite(cue) || !Number.isFinite(at)) return;
    changeOffset((cue - at) * 1000);
  }

  // ---------- commits ----------
  /** End the audition (commit or abort) and mark the panel done; `navigate` runs onClose (the panel's own buttons). */
  function close(result, {commit, navigate = true}) {
    if (ended) return false;
    ended = true;   // first, so the auditioning subscription below knows this end is ours
    if (mapSession.auditioning?.peek?.()) mapSession.endAudition({commit});
    if (destroyed) return true;
    renderState();
    if (!navigate) return true;
    const done = onClose ?? (() => router?.navigate?.(`/s/${encodeURIComponent(session.id)}/edit/map`, {replace: true}));
    try { done({result}); } catch (err) { console.error('[find-panel] onClose failed', err); }
    return true;
  }

  /** Use their map: one map-stack step, saved now. */
  function useTheirs() {
    if (!live() || importing || selected === original) return false;
    return close('theirs', {commit: true});
  }

  /** Use map + drum chart: the drum part first (a refusal leaves the audition open), then the map. */
  async function useWithDrums() {
    if (!live() || importing || selected === original || !selected.result?.drums?.hits?.length) return false;
    importing = true;
    renderState();
    setStatus(COPY.importing);
    try {
      const done = await importDrumResult(selected.result, {session, map: map.serialize(),
        confirmReplace: replaceDialog(feedback.confirm), source: selected.title});
      importing = false;
      if (done.canceled) {
        if (!exitCommitted && !destroyed) { renderState(); setStatus(''); }
        return false;
      }
      feedback.toast?.(COPY.drumsImported(done.count, done.skipped, done.replaced), {tone: 'ok'});
      if (!exitCommitted) close('drums', {commit: true});
      return true;
    } catch (err) {
      importing = false;
      if (exitCommitted) feedback.toast?.(COPY.drumsFailedAfterLeave(errorText(err)), {tone: 'error'});
      else if (!destroyed) { renderState(); setStatus(errorText(err), 'error'); }
      return false;
    }
  }

  /** Keep my map (and Esc): the map, both undo stacks and the saved tempo exactly as before. */
  function keepMine({navigate = true} = {}) {
    if (ended || importing) return false;
    return close('mine', {commit: false, navigate});
  }

  /** Leaving (or unmounting) while the drum chart imports: the user chose it, so the map is committed now. */
  function commitForExit() {
    exitCommitted = true;
    close('drums', {commit: true, navigate: false});
  }

  function onKey(e) {
    if (e.defaultPrevented || e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    keepMine();
  }

  // ---------- leaving mid-audition (D20) ----------
  const keepsSession = (to) => !!to?.route?.session && String(to.params?.songId ?? '') === String(session.id);
  const isMapView = (to) => keepsSession(to) && to.name === 'edit' && (to.params?.tab ?? 'map') === 'map';

  function onLeave(from, to) {
    if (!to || ended || destroyed) return;
    if (importing) { commitForExit(); return; }   // the user already chose the drum chart: keep that choice
    if (selected === original || isMapView(to)) { keepMine({navigate: false}); return; }
    const candidate = map.snapshot();
    const name = selected.title;
    keepMine({navigate: false});
    if (!keepsSession(to)) { feedback.toast?.(COPY.leftKept); return; }
    void askAfterLeave(candidate, name);
  }

  async function askAfterLeave(candidate, name) {
    let use = false;
    try {
      use = await feedback.confirm({title: COPY.leaveTitle, body: COPY.leaveBody(name), confirmLabel: COPY.leaveUse, cancelLabel: COPY.leaveKeep});
    } catch (err) {
      console.error('[find-panel] the leave confirm failed', err);
      return;
    }
    if (!use || session.disposed) return;
    const before = json(map.snapshot());
    let done = null;
    try {
      done = session.mapChange(COPY.leaveUndo, (m) => m.replace(candidate, 'tempo-source'), {status: {text: COPY.usedTheirs, undoLabel: COPY.undo}});
    } catch (err) {
      feedback.toast?.(errorText(err), {tone: 'error'});
      return;
    }
    if (!done && json(map.snapshot()) === before && json(candidate) !== before) feedback.toast?.(COPY.notApplied, {tone: 'error'});
  }

  if (router?.onLeave) offs.push(router.onLeave(onLeave));

  // An audition someone else ended (the map session destroyed) closes the panel's choices.
  if (mapSession.auditioning?.subscribe) {
    offs.push(mapSession.auditioning.subscribe((on) => {
      if (!on && !ended && !importing) { ended = true; renderState(); setStatus(COPY.closed); }
    }));
  }

  // ---------- start ----------
  renderState();
  const routeQuery = peek(router?.current)?.query ?? {};
  const wantsImport = String(routeQuery.import ?? '') === '1';
  if (!begun) {
    setStatus(COPY.notStarted, 'error');
  } else if (wantsImport) {
    importButton.el.focus({preventScroll: true});
    setStatus(COPY.start);
    if (globalThis.navigator?.userActivation?.isActive) fileInput.click();
  } else {
    query.input.focus({preventScroll: true});
  }
  if (begun && query.input.value.trim()) void find();
  else if (begun && !wantsImport) setStatus(COPY.start);

  return {
    el: root,
    state: readonly(state),
    get selected() { return selected.id; },
    get ended() { return ended; },
    keepMine: () => keepMine(),
    useTheirs,
    useWithDrums,
    search: () => find(),
    destroy() {
      if (destroyed) return;
      if (!ended) {
        if (importing) commitForExit();
        else keepMine({navigate: false});
      }
      destroyed = true;
      ++searchRev;
      ++loadRev;
      for (const off of offs.splice(0)) { try { off?.(); } catch { /* already gone */ } }
      root.removeEventListener('keydown', onKey);
      for (const part of [say, query, searchButton, importButton, play, ...shiftButtons, offsetField, lineUp, reset, useTheirsButton, drumsButton, keepButton]) {
        try { part.destroy(); } catch { /* removed with the root */ }
      }
      root.remove();
    },
  };
}
