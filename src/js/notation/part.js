// One drum part per open song, shared by the Practice chart and the
// Transcribe editor: loading, saving, tempo-map sync and shared-link updates
// live here, so both views always show the same score.
import {ScoreEditor, validateScore, validateBar, upgradeScore, extent} from '../../../shared/notation.ts';
import {sameContent} from '../../../shared/content.ts';
import {NotationStore, loadSharedNotation, watchSharedNotation} from './store.js';
import {scoreFromTiming} from './entry.js';

/**
 * @returns part with `editor` (ScoreEditor or null when nothing is shared),
 *   `score`, `subscribe(fn(reason))`, `commit()` after edits, `status`.
 */
export async function openPart({song, engine, metronome, songMap = null, readOnly = false, shareToken = null, persistence = null}) {
  const listeners = new Set(), statusListeners = new Set();
  let editor = null, store = null, status = readOnly ? 'read-only' : 'loading', disposed = false;
  const notify = reason => { for (const fn of listeners) fn(reason); };
  const setStatus = next => { status = next; for (const fn of statusListeners) fn(next); };

  // With a song map, the part's timeline always follows the song's shared
  // tempo map; notation edits never change timing on their own.
  const mapScore = input => {
    const score = upgradeScore(input), timeline = structuredClone(songMap.timeline()), ids = timeline.measures.map(m => m.id);
    let bars = score.bars;
    if (bars.length && !bars.some(b => ids.includes(b.measureId))) { const old = score.timeline.measures.map(m => m.id); bars = bars.map(b => ({...b, measureId: ids[old.indexOf(b.measureId)] || b.measureId})); }
    const next = {...score, timeline, bars};
    validateScore(next);
    return next;
  };
  const fitScore = input => {
    if (!songMap) return upgradeScore(input);
    try { return mapScore(input); } catch { songMap.replaceFromTimeline(upgradeScore(input).timeline); return mapScore(input); }
  };
  const newScore = () => songMap ? {version: 2, title: 'Drums', timeline: structuredClone(songMap.timeline()), bars: []} : scoreFromTiming(engine.duration, metronome);

  let score;
  if (readOnly) score = (await loadSharedNotation(shareToken))?.score;
  else {
    store = persistence || new NotationStore(song.id, setStatus);
    score = await store.load();
    if (persistence) setStatus('fixture');
  }
  if (score || !readOnly) editor = new ScoreEditor(score ? fitScore(score) : newScore());

  // Follow tempo-map edits; undo history moves to the new timing too.
  const retime = (list, timeline) => { const out = []; for (let i = list.length - 1; i >= 0; i--) { const next = {...list[i], timeline}; try { validateScore(next); } catch { break; } out.unshift(next); } return out; };
  const syncMap = () => {
    if (!editor || disposed) return;
    const timeline = songMap.timeline();
    if (sameContent(timeline, editor.score.timeline)) return;
    const next = {...editor.score, timeline: structuredClone(timeline)};
    try { validateScore(next); } catch (error) { notify({type: 'error', message: error.message}); return; }
    editor.score = next;
    editor.undoStack = retime(editor.undoStack, next.timeline);
    editor.redoStack = retime(editor.redoStack, next.timeline);
    part.commit('map');
  };
  const unsubscribeMap = songMap ? songMap.subscribe(syncMap) : () => {};
  // Refuse tempo-map edits that would strand written notes.
  const noteGuard = timeline => {
    if (!editor) return;
    for (const bar of editor.score.bars) {
      if (!bar.hits.length && bar.coverage === 'unstarted') continue;
      const index = timeline.measures.findIndex(m => m.id === bar.measureId);
      if (index < 0) throw new Error('That change would remove a bar that has drum notation.');
      try { validateBar(bar, timeline); } catch { throw new Error(`Bar ${index + 1} has drum notes that would no longer fit. Edit them in Transcribe first.`); }
    }
  };
  noteGuard.keep = id => !!editor?.score.bars.some(b => b.measureId === id && (b.hits.length || b.coverage !== 'unstarted'));
  const releaseGuard = songMap && !readOnly ? songMap.setGuard('notation', noteGuard) : () => {};
  const sharedUpdate = data => { if (disposed) return; editor = data?.score ? new ScoreEditor(fitScore(data.score)) : null; notify('shared'); };
  const unwatch = readOnly ? watchSharedNotation(shareToken, sharedUpdate, () => sharedUpdate(null)) : () => {};

  const part = {
    readOnly, song,
    get editor() { return editor; },
    get score() { return editor?.score ?? null; },
    get store() { return store; },
    get status() { return status; },
    /** True when the part has any written or reviewed bar. */
    get hasNotation() { return !!editor?.score.bars.some(b => b.hits.length || b.coverage === 'reviewed'); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onStatus(fn) { statusListeners.add(fn); fn(status); return () => statusListeners.delete(fn); },
    /** Persist and broadcast the editor's current score. */
    commit(reason = 'edit') { if (!editor) return; store?.set(editor.score); notify(reason); },
    mapScore: input => songMap ? mapScore(input) : upgradeScore(input),
    fitScore,
    /** Adopt an imported draft into an empty part as one undoable edit. */
    importScore(input) {
      if (readOnly || disposed || !editor) throw new Error('This drum part cannot be edited.');
      if (store?.blocked) throw new Error('Resolve the saved drum-part conflict before importing.');
      if (editor.score.bars.some(bar => bar.hits.length || bar.coverage !== 'unstarted'))
        throw new Error('This song already has drum notation. Keep the tempo map alone; import drums into a song with an empty part.');
      const next = songMap ? mapScore(structuredClone(input)) : upgradeScore(structuredClone(input));
      validateScore(next);
      editor.transact(draft => Object.assign(draft, next));
      part.commit('import');
    },
    async reload() { const saved = await store.reload(); editor = saved ? new ScoreEditor(fitScore(saved)) : null; notify('reload'); return editor; },
    clampPosition(q) { return Math.max(0, Math.min(q, extent(editor.score.timeline) - 1e-4)); },
    flush: () => store?.flush(),
    destroy() { disposed = true; unwatch(); unsubscribeMap(); releaseGuard(); store?.destroy(); listeners.clear(); statusListeners.clear(); },
  };
  return part;
}
