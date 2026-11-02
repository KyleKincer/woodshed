// Drum import (architecture §2.15): a drum chart from a file or from a Find a chart source becomes the
// song's drum part, on the chart's own bars. Used by the Find panel's "Use this chart (map + N drum hits)"
// (src/edit/map/find-panel.js), which every way of importing a chart from a file leads to
// (src/edit/chart-file.js).
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
//
// Hits are placed by bar (quarter notes from bar 1), so bar N of the file lands in bar N of the map.
import {importDrumHits} from '../js/notation/import-drums.js';

export const COPY = Object.freeze({
  title: 'Imported drums',
  readOnly: 'This song is shared with you, so its drum part can’t be changed.',
  noDrums: 'This file has no drum part. Choose a MIDI, Guitar Pro or Clone Hero chart with drums.',
  noneInside: 'None of this chart’s drum hits fall inside the recording’s bars, so nothing was imported.',
  replaceTitle: 'Replace the drum chart?',
  replaceBody: ({notes, reviewed, incoming, source}) => `The current chart (${count(notes, 'note')}${reviewed ? `, ${count(reviewed, 'bar')} reviewed` : ''}) will be replaced by ${count(incoming, 'note')}${source ? ` from ${source}` : ''}, on its own bars. Your section names stay. Undo brings the current chart back.`,
  replaceConfirm: 'Replace chart',
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
