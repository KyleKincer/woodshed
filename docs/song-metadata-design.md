# Song metadata editing

Scope confirmed by the user and implemented. See [metadata operations](song-metadata-operations.md) for provider configuration and validation.

## Agreed scope

- Rich editing covers identifying details and artwork, library organization, and practice information.
- Internet metadata lookup should help populate rich song details. The implementation uses MusicBrainz, Cover Art Archive, and AcoustID with conservative matching.
- Edits apply throughout the person's synced Woodshed library and appear in exports. Rewriting tags in original audio files is outside this feature.
- Enrichment should happen automatically with minimal user effort; every editable metadata value must remain correctable. Uncertain matches remain optional to review.
- Manual corrections are authoritative: later lookup must not silently overwrite them, and reprocessing must preserve metadata edits.
- Bulk editing is in scope and should make changing shared fields across selected songs straightforward. Individual match review should remain separate from shared-field edits.
- Apply strong online matches automatically to metadata that the user has not corrected. For uncertain matches, retain imported details and offer a quiet Find a match action in the editor without blocking import or playback.
- Include audio fingerprinting as a fallback for poorly tagged audio.
- Prioritize free providers now. Paid metadata services are acceptable in principle, but no paid commitment has been authorized. Check that free access permits the app's actual use; free noncommercial access is not sufficient evidence of permission for commercial use.

## Editor

- Offer Edit song from the library and player. Use a dialog on desktop and a full-screen editor on mobile, with explicit Save and Cancel.
- Expose title, artist, album, album artist, release year, genre, track/disc number, and artwork.
- Expose musical key, tuning, personal tags, and notes as practice information. Keep tempo correction in the existing player controls because it affects practice behavior.
- Every descriptive field remains manually editable, including values populated online.
- Run lookup quietly and expose Find another match inside the editor.
- Bulk editing uses the same layout and changes only fields the user explicitly touches.

## Album and artwork selection

- Preserve a credible imported album. Otherwise prefer the original release when clearly established; leave album and artwork unchanged when uncertain.
- Offer alternative releases through Find another match without requiring the user to understand catalog identifiers.
- Retrieve matching cover art automatically. Also offer Choose another cover, Upload image, and Remove artwork.
- Preserve explicit artwork choices, including removal, through subsequent enrichment and reprocessing.

## Current behavior

The library offers a title-only Rename dialog. Artist, album, uploader, and artwork already exist, but have no full editing interface. Artist and album edits affect search and grouping. Processing currently preserves an existing song's title but may replace its artist, album, and artwork.

## Implementation notes

These technical details guided implementation; provider and validation results are recorded in the operations notes.

- Use the primary-source findings in [music-metadata-research.md](music-metadata-research.md) to select permitted free provider access, artwork retrieval, and fingerprinting integration. MusicBrainz, Cover Art Archive, and AcoustID are integrated; provider access terms still govern production use.
- Define and validate conservative matching criteria, including version differences, duration, and imported album evidence. Search ranking alone does not establish a strong match.
- Preserve manual field choices, including explicit clearing, when background enrichment finishes or reprocessing completes.
- Ensure saved changes appear in both the reactive library and an already-open player, and in exported metadata.
- Internet catalog lookup does not promise completion of musical key, BPM, tuning, or personal practice information.

Use concise labels and omit redundant instructional subtitles. Keep helper text only when it explains a real constraint or consequence.
