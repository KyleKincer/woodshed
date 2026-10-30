// Drum import (architecture §2.15): a drum chart from a file or from a Find a chart source becomes the
// song's drum part. Used by the Find panel's "Use map + drum chart (N hits)" (src/edit/map/find-panel.js)
// and by Edit · Chart's Part ▾ → "Drum part from file…" (ED5).
//
//   previewDrumImport(result, {map, duration}) → {score, importedCount, skippedCount, warnings}
//     result: an importer result (src/js/tempo-import.js: {map, format, warnings, drums?: {hits, source, warnings,
//     tuplets?}}). Lays the hits onto `map` (the bars they will belong to) without touching anything; throws
//     COPY.noDrums when the result has no drum hits, or the importer's reason when the hits cannot be placed.
//   importDrumResult(result, {session, map?, confirmReplace?, source?}) → Promise<{count, skipped, warnings, notice,
//     replaced, canceled?}>
//     The preview, then `session.notation.importScore` (one chart undo step). When the song already has a drum
//     chart, `confirmReplace({notes, reviewed, incoming, source})` asks first (replaceDialog below); false leaves
//     the chart alone and resolves {canceled: true}. Without confirmReplace such an import throws code
//     'HAS_NOTATION'. `map` defaults to the session's current map.
//   replaceDialog(ask) → confirmReplace   "Replace the drum chart?" through feedback.confirm (danger)
//   importDrumPartFromFile(file, {session, confirmReplace?}) → Promise<{count, skipped, warnings, replaced, canceled?}>
//     tempo-import parse (every format and limit of importTempoFile) → importDrumResult against the song's own
//     map. The file's own tempo map is not used; when its bars differ from the song's, a warning says from
//     which bar, and that Find a chart brings in the file's map too.
//
// Hits are placed by bar (quarter notes from bar 1), so bar N of the file lands in bar N of the map.
import {compare} from '../../shared/notation.ts';
import {hasPickup} from '../../shared/song-map.ts';
import {importDrumHits} from '../js/notation/import-drums.js';
import {importTempoFile} from '../js/tempo-import.js';

export const COPY = Object.freeze({
  title: 'Imported drums',
  readOnly: 'This song is shared with you, so its drum part can’t be changed.',
  noDrums: 'This file has no drum part. Choose a MIDI, Guitar Pro or Clone Hero chart with drums.',
  noneInside: 'None of this chart’s drum hits fall inside the recording’s bars, so nothing was imported.',
  replaceTitle: 'Replace the drum chart?',
  replaceBody: ({notes, reviewed, incoming, source}) => `The current chart (${count(notes, 'note')}${reviewed ? `, ${count(reviewed, 'bar')} reviewed` : ''}) will be replaced by ${count(incoming, 'note')}${source ? ` from ${source}` : ''}. The tempo map and sections stay as they are. Undo brings the current chart back.`,
  replaceConfirm: 'Replace chart',
  barsDiffer: (bar) => `The file’s bars differ from this song’s map from ${bar}. Check the imported part, or use Find a chart to bring in the file’s map as well.`,
});

const count = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const unique = (list) => [...new Set(list.filter((s) => typeof s === 'string' && s.trim()))];
const durationOf = (session) => {
  const d = Number(session?.engine?.duration) || Number(session?.map?.duration) || Number(session?.song?.peek?.()?.duration);
  return d > 0 ? d : undefined;
};

/** Lay a result's drum hits onto `map` without changing anything. See the header. */
export function previewDrumImport(result, {map, duration} = {}) {
  const drums = result?.drums;
  if (!drums || !Array.isArray(drums.hits) || !drums.hits.length) throw new Error(COPY.noDrums);
  const out = importDrumHits(drums.hits, map, {title: COPY.title, source: drums.source, duration, tuplets: drums.tuplets});
  return {...out, warnings: unique([...(drums.warnings ?? []), ...out.warnings])};
}

/** confirmReplace for importDrumResult: the "Replace the drum chart?" confirm. See the header. */
export function replaceDialog(ask) {
  return (facts) => ask({title: COPY.replaceTitle, body: COPY.replaceBody(facts), confirmLabel: COPY.replaceConfirm, danger: true});
}

/** Import a result's drum hits as the session's drum part. See the header. */
export async function importDrumResult(result, {session, map, confirmReplace = null, source = ''} = {}) {
  if (!session?.notation) throw new TypeError('importDrumResult needs a session.');
  if (session.readOnly) throw new Error(COPY.readOnly);
  const timing = map ?? session.map.serialize();
  const preview = previewDrumImport(result, {map: timing, duration: durationOf(session)});
  if (!preview.importedCount) throw new Error(COPY.noneInside);
  const current = typeof session.notation.contents === 'function' ? await session.notation.contents() : null;
  const replace = !!current?.has;
  if (replace && confirmReplace) {
    const ok = await confirmReplace({notes: current.notes, reviewed: current.reviewed, incoming: preview.importedCount, source});
    if (!ok) return {count: 0, skipped: 0, warnings: [], notice: '', replaced: false, canceled: true};
  }
  const warnings = preview.warnings;
  const done = await session.notation.importScore(preview.score, {notice: warnings.join(' ') || undefined, skipped: preview.skippedCount,
    replace: replace && !!confirmReplace});
  return {count: done?.count ?? preview.importedCount, skipped: done?.skipped ?? preview.skippedCount, warnings, notice: done?.notice ?? '', replaced: replace};
}

/** The display name of measure `index` in `data` ("bar 5", "the pickup"). */
function barName(data, index) {
  const pickup = hasPickup(data);
  if (pickup && index === 0) return 'the pickup';
  return `bar ${pickup ? index : index + 1}`;
}

/** The first measure index where two maps' bars differ (meter or length), or -1 when they agree. */
export function firstDifferentBar(a, b) {
  const x = a?.measures ?? [], y = b?.measures ?? [];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i].numerator !== y[i].numerator || x[i].denominator !== y[i].denominator || compare(x[i].length, y[i].length) !== 0) return i;
  }
  return -1;
}

/** A drum part from a local file, placed on the song's own map. See the header. */
export async function importDrumPartFromFile(file, {session, parse = importTempoFile, confirmReplace = null} = {}) {
  if (!session?.notation) throw new TypeError('importDrumPartFromFile needs a session.');
  if (session.readOnly) throw new Error(COPY.readOnly);
  const result = await parse(file, {duration: durationOf(session)});
  if (!result?.drums?.hits?.length) throw new Error(COPY.noDrums);
  const songMap = session.map.serialize();
  const differs = result.map ? firstDifferentBar(result.map, songMap) : -1;
  const done = await importDrumResult(result, {session, map: songMap, confirmReplace, source: file?.name ?? ''});
  if (done.canceled) return {count: 0, skipped: 0, warnings: [], replaced: false, canceled: true};
  const warnings = unique([...(result.warnings ?? []), ...done.warnings, ...(differs >= 0 ? [COPY.barsDiffer(barName(songMap, differs))] : [])]);
  return {count: done.count, skipped: done.skipped, warnings, replaced: done.replaced};
}
