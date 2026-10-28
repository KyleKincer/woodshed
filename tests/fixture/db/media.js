// Fixture handler for convex/media.ts: signed URLs for covers and stems.
// Stems are synthetic WAV blob URLs (../audio.js); a song with a drum part
// gets its drum stem rendered from the part, so chart playback lines up.
//   fx-media=fail   signing fails (the Stage's load error)
//   fx-media=slow   stem URLs take 8 s (the loading state)
import {db, fx, wait, findSong} from './runtime.js';
import {stemUrl} from '../audio.js';

export const handlers = {
  'media:signKeys': async ({keys}) => {
    if (fx.media === 'fail') { await wait(300); throw new Error('Request timed out (fixture)'); }
    if (fx.media === 'slow' && keys.some(k => !db.coverKeys[k])) await wait(8000);
    const out = {};
    for (const key of keys) {
      if (db.coverKeys[key]) { out[key] = db.coverKeys[key]; continue; }
      const [id, stem] = key.split('/'), s = findSong(id);
      if (s && stem) out[key] = stemUrl(s, stem, db.notation[id]?.score);
    }
    return out;
  },
};
