// Tempo sources (convex/tempoSources.ts): the Find a chart search and download (architecture §1, §2.1).
// One-line wrappers over src/api/client.js; each rejects with an ApiError.
//
//   search({query, duration?}) → {candidates: Candidate[], warnings: string[]}
//     Candidate = {id, title, artist, album, source: 'harmonix'|'chorus', duration, bpm?, meter?: {numerator, denominator},
//                  charter?, hasDrums?, sourceUrl?}; ≤ 40 rows; a provider that could not be searched adds a warning.
//   load({id}) → {format: 'beats', text, sourceUrl} | {format: 'chart'|'midi', data: ArrayBuffer, sourceUrl, metadata?}
//     The raw chart; the Find panel decodes it on this device (src/edit/map/find-panel.js `decodeSource`).
// No user audio leaves the device: the server only searches the catalogs and fetches the chosen chart.
import {action} from './client.js';

export const search = args => action('tempoSources:search', args);
export const load = args => action('tempoSources:load', args);
