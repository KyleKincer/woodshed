// Fixture handlers for convex/metadata.ts, metadataLookup.ts and artworkUpload.ts.
// Created by FX1 with the 1.9 fixture's handlers moved verbatim; BK7 (wave 0B)
// owns the bodies from here on (§6.9). The seed's `counting` song carries a
// `metadataSuggestion` with metadataStatus 'uncertain'; `jam03` has `needsReview`.
import {db, changed, convexError, wait, findSong} from './runtime.js';
import {COVERS} from './seed.js';

export const handlers = {
  'metadata:update': ({ids, changes}) => {
    for (const id of ids) { const s = findSong(id); if (!s) continue; const {artwork, ...rest} = changes; Object.assign(s, rest); if (artwork?.kind === 'removed') { s.coverUrl = null; s.coverKey = null; } if (artwork?.kind === 'release') s.coverUrl = COVERS.harbor; }
    changed(); return null;
  },
  'metadataLookup:find': async ({title, artist, recordingId}) => {
    await wait(500);
    if (recordingId) return [
      {recordingId, releaseId: 'rel-1', title, artist: artist || 'Northbound', album: 'Weather Systems', year: '2021', duration: 64},
      {recordingId, releaseId: 'rel-2', title, artist: artist || 'Northbound', album: 'Weather Systems (Deluxe)', year: '2022', duration: 64},
      {recordingId, releaseId: 'rel-3', title, artist: artist || 'Northbound', album: 'Songs from the Shed: A Compilation', year: '2023', duration: 65},
    ];
    return [
      {recordingId: 'rec-1', releaseId: 'rel-1', title: title || 'Glasshouse', artist: artist || 'Northbound', album: 'Weather Systems', year: '2021', duration: 64},
      {recordingId: 'rec-2', releaseId: 'rel-4', title: title || 'Glasshouse', artist: artist || 'Northbound', album: 'Glasshouse (Single)', year: '2020', duration: 63, disambiguation: 'radio edit'},
      {recordingId: 'rec-3', releaseId: null, title: `${title || 'Glasshouse'} (Live)`, artist: artist || 'Northbound', album: '', year: '', duration: 71, disambiguation: 'live, 2022-05-14: The Grange'},
    ];
  },
  'metadataLookup:detail': async () => { await wait(300); return {title: 'Glasshouse', artist: 'Northbound', album: 'Weather Systems', albumArtist: 'Northbound', year: '2021', genre: 'Alternative rock', trackNumber: '3', discNumber: '1'}; },
  'artworkUpload:prepare': () => { throw convexError('Artwork upload is not available in the fixture.'); },
};
