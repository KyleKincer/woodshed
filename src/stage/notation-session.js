// The song session's drum part (architecture §2.14.2, D27): one lazily opened
// part (`notation/part.js`), the legacy timeline adoption that runs before it
// opens, the part's map guard (installed once, by part.js) and one shared
// `DrumAudio` for the Stage chart, Edit · Chart and the Mix "Chart playback".
//
//   createNotationSession({session, openPart?, persistence?, onRealChange?}) → NotationSession
//   (`onRealChange()`: the part made the song mapped or unmapped; the session's markers offer)
//
// - `start()` (the session's open order, step 5) opens the part when the song
//   has a chart (`song.hasChart`) or when it stores a tempo with no `songMap`
//   (a 1.5 song whose drum part may carry the only real timing; the part's
//   timeline is adopted into the map before the part is fitted to it). A song
//   with no stored tempo is not legacy, and read-only sessions never adopt.
//   Otherwise nothing is fetched and `ready` resolves with `part` null.
//   `open()` opens the part on demand (Edit · Chart writing a new chart, an
//   import).
// - `hasNotation` follows the part (any bar with hits or reviewed). The map
//   counts a song with notation as mapped (`map.setHasPart`, §4.2), which emits
//   no event, so the position model is refreshed by hand (Appendix C item 37).
// - Chart playback (`practice.chartAudio`): off → the recording only; quiet →
//   both at gain .35; loud → both at gain .65. `setListenMode` (Edit · Chart's
//   Listen tab) sets the mode directly and leaves `practice.chartAudio` alone;
//   both live on the session's one DrumAudio, so they survive posture changes.
// - `setMapSyncPaused` (Find a chart audition, D20) holds the part's map saves.
import {signal, readonly} from '../app/store.js';
import {cleanSongMap} from '../../shared/song-map.ts';
import {DrumAudio, LEVELS} from '../js/notation/audio.js';

export const CHART_AUDIO = Object.freeze({
  off: Object.freeze({mode: 'recording', gain: LEVELS.loud}),
  quiet: Object.freeze({mode: 'both', gain: LEVELS.quiet}),
  loud: Object.freeze({mode: 'both', gain: LEVELS.loud}),
});
export const LISTEN_MODES = Object.freeze(['recording', 'notation', 'both']);

export const COPY = Object.freeze({
  imported: 'Imported drum part. Check it against the recording; Undo in Edit · Chart restores the empty part.',
});

const loadPart = async (options) => (await import('../js/notation/part.js')).openPart(options);

/** Hits in a score (an import's count). */
const hitCount = (score) => (score?.bars ?? []).reduce((n, bar) => n + (bar.hits?.length ?? 0), 0);

/**
 * True when the song stores a tempo that predates `songMap` (a 1.5–1.9 row): its drum part may
 * carry the only real timing. A song that was never mapped stores no tempo (`songs.get` → null),
 * and a shared snapshot without its map carries none: neither is legacy.
 */
export function hasLegacyTempo(song) {
  const tempo = song?.tempo;
  return !!tempo && typeof tempo === 'object' && !cleanSongMap(tempo.songMap);
}

/**
 * True when the song needs its part at open: it has a chart, or (owner sessions only) its stored
 * tempo predates `songMap` (legacy adoption). Read-only sessions never adopt into the map.
 */
export function needsPartAtOpen(song, {readOnly = false} = {}) {
  if (!song) return false;
  return !!song.hasChart || (!readOnly && hasLegacyTempo(song));
}

export function createNotationSession({session, openPart = loadPart, persistence = null, onRealChange = null} = {}) {
  if (!session) throw new TypeError('createNotationSession: session is required');
  // Until the part answers, the song row's `hasChart` (B1) stands in for it (spec §4.4: Chart when notated).
  const hasNotation = signal(!!session.song.peek()?.hasChart);
  const error = signal(null);
  let part = null;
  let opening = null;
  let audio = null;
  let destroyed = false;
  let offPart = null;
  let syncPaused = false;
  let chartAudio = 'off';
  let listenMode = null;     // set by Edit · Chart's Listen tab; null → follows chartAudio
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  const settle = () => resolveReady();

  function sync() {
    if (destroyed) return;
    const has = !!part?.hasNotation;
    if (hasNotation.peek() !== has) hasNotation.value = has;
    const map = session.map;
    const wasReal = map.isReal;
    map.setHasPart(has);
    if (map.isReal !== wasReal) {
      // setHasPart emits nothing (Appendix C item 8): the position model re-reads `map.isReal`.
      session.position?.refresh?.();
      onRealChange?.();
    }
    audio?.setScore(part?.score ?? null);
  }

  /** Mode and level of the shared DrumAudio from the Listen tab (if set) or the chart audio level. */
  function applyAudio() {
    if (!audio) return;
    const level = CHART_AUDIO[chartAudio] ?? CHART_AUDIO.off;
    const mode = listenMode ?? level.mode;
    if (audio.mode !== mode) audio.setMode(mode);
    audio.setLevel(level.gain);
  }

  function ensureAudio() {
    if (!audio && !destroyed) {
      audio = new DrumAudio(session.engine);
      audio.setScore(part?.score ?? null);
      applyAudio();
    }
    return audio;
  }

  function open() {
    if (opening) return opening;
    if (destroyed) return Promise.resolve();
    const song = session.song.peek();
    opening = (async () => {
      const result = await openPart({
        song, engine: session.engine, metronome: session.metronome, songMap: session.map,
        readOnly: !!session.readOnly, shareToken: session.shareToken ?? null, persistence,
        adoptLegacy: !session.readOnly && hasLegacyTempo(song),
      });
      if (destroyed) { result.destroy(); return; }
      part = result;
      error.value = null;
      offPart = part.subscribe(() => sync());
      if (syncPaused) part.setMapSyncPaused?.(true);
      sync();
    })().catch((err) => {
      opening = null;   // a later open() tries again
      if (!destroyed) error.value = err;
      throw err;
    }).finally(settle);
    return opening;
  }

  /** The session's open order, step 5: open now when the song needs its part, else settle with no part. */
  function start() {
    if (!needsPartAtOpen(session.song.peek(), {readOnly: !!session.readOnly})) { settle(); return Promise.resolve(); }
    return open().catch((err) => { console.warn('The drum part could not be opened.', err); });
  }

  return {
    ready,
    get part() { return part; },
    hasNotation: readonly(hasNotation),
    /** The last open failure (the chart surface shows it with Try again), else null. */
    error: readonly(error),
    get readOnly() { return !!session.readOnly; },
    /** The session's one DrumAudio (created on first use). */
    get drumAudio() { return ensureAudio(); },
    setChartAudio(level) {
      const next = CHART_AUDIO[level] ? level : 'off';
      chartAudio = next;
      listenMode = null;
      if (next === 'off' && !audio) return;   // nothing to silence: the recording plays as it is
      ensureAudio();
      applyAudio();
    },
    get chartAudio() { return chartAudio; },
    setListenMode(mode) {
      if (!LISTEN_MODES.includes(mode)) throw new TypeError(`Unknown listen mode: ${mode}`);
      listenMode = mode;
      ensureAudio();
      applyAudio();
    },
    get listenMode() { return audio ? audio.mode : (CHART_AUDIO[chartAudio] ?? CHART_AUDIO.off).mode; },
    setMapSyncPaused(on) {
      syncPaused = !!on;
      part?.setMapSyncPaused?.(syncPaused);
    },
    get mapSyncPaused() { return syncPaused; },
    /** What the part holds once open: {has, notes, reviewed} (has: hasNotation), or null without a part. */
    async contents() {
      await open();
      return part ? {has: !!part.hasNotation, ...part.stats} : null;
    },
    /**
     * Adopt an imported draft as one undoable chart edit. A part with notation is replaced only with
     * {replace: true} (the caller asked first); otherwise part.importScore throws code 'HAS_NOTATION'.
     */
    async importScore(score, {notice, skipped = 0, replace = false} = {}) {
      await open();
      if (!part) throw new Error('This drum part cannot be edited.');
      part.importScore(score, {replace});
      sync();
      return {count: hitCount(part.score), skipped: Number.isFinite(skipped) ? skipped : 0, notice: notice || COPY.imported};
    },
    start,
    open,
    /** Save the part's pending edits (share, leave, desktop flush). */
    async flush() {
      if (!part) return;
      await part.flush();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offPart?.();
      part?.destroy();
      audio?.destroy();
      part = null;
      audio = null;
      settle();
    },
  };
}

export default createNotationSession;
