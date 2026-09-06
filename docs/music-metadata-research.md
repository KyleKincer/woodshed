# Internet music metadata research

Researched 2026-09-06. This is a provider recommendation, not an accepted UX decision. Scope: enriching Woodshed library entries from local audio and URL imports; original audio files remain unchanged.

## Recommended foundation

Use **MusicBrainz for catalog metadata and Cover Art Archive for candidate artwork**. Begin with identifiers already present in imports, then title/artist search with album and duration as supporting evidence. Consider **AcoustID/Chromaprint** for unknown or poorly tagged audio. This is an engineering recommendation based on their complementary interfaces, not a claim that a provider guarantees correct matches. MusicBrainz supports entity lookup, browse, and search; Picard separately offers audio scanning and explicitly acknowledges unsuccessful or incorrect matches. [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API), [Picard scan workflow](https://picard-docs.musicbrainz.org/en/latest/usage/retrieve_scan.html)

Provider matches should produce suggestions with source IDs and provenance. Keep manual edits authoritative; retain uncertainty and make selecting another match possible. These are design recommendations: Picard’s own matching settings flag closely scored alternatives as ambiguous and caution that lower thresholds increase false positives. [Picard matching](https://picard-docs.musicbrainz.org/en/latest/config/options_matching.html)

## What the data means

- **Recording** identifies particular recorded audio. Studio, live, and remix versions can differ; one recording can occur on many releases. A fingerprint match therefore cannot by itself establish the intended album edition. [Recording](https://musicbrainz.org/doc/Recording)
- **Release** represents a particular issued product; **release group** groups related editions of an album or single. Store these identifiers separately. Album, date, and artwork should refer to a coherent chosen release or clearly identified release-group fallback. [Release](https://musicbrainz.org/doc/Release), [Release group](https://musicbrainz.org/doc/Release_Group)
- **Work** represents the underlying creation, potentially expressed by multiple recordings. A cover or personal performance of a song should not inherit the original recording’s identity merely because the composition matches. [Work](https://musicbrainz.org/doc/Work)

MusicBrainz supplies titles, artist credits, durations, release dates, track/disc positions, identifiers, and relationships for credits. Its standard enrichment does **not** supply track BPM, key, or lyrics; Picard lists those separately as fields not provided from MusicBrainz. No general tuning field was established by these sources. Treat key, tempo, tuning, and practice notes as editable practice information, with separately sourced or computed suggestions if later added. Do not promise reliable internet completion of these fields. [Database overview](https://musicbrainz.org/doc/MusicBrainz_Database), [Picard fields](https://picard-docs.musicbrainz.org/en/latest/variables/tags_basic.html)

## Operational and licensing constraints

| Provider | Verified constraints | Consequence for Woodshed |
| --- | --- | --- |
| MusicBrainz | Public API requires a meaningful User-Agent and at most one request per second per client application; default IP throttling also applies. Free access is described as noncommercial; commercial use directs developers to plans/contact. | Coordinate requests, cache lookups, back off on failures, and confirm the appropriate access arrangement before commercial release. |
| MusicBrainz data | Core data is CC0. Supplementary data is CC BY-NC-SA 3.0; notably **genre associations and user tags** belong to supplementary data, even though genre names themselves are core. | Do not treat every returned field as CC0. Select fields and licensing deliberately, especially automatic genre enrichment. |
| Cover Art Archive | Offers release/release-group artwork, front images, approval flags, and 250/500/1200 thumbnails. Documentation presently lists no rate-limit rules, but specifies redirects and error responses. Its policy describes archival access, not a blanket artwork reuse license. | Use the service URLs and handle missing covers gracefully. Track artwork provenance; API accessibility does not establish rights to redistribute artwork in exports or commercial use. |
| AcoustID | Application key required; free service is noncommercial, commercial access is separate; maximum three requests per second. Lookup accepts fingerprint and duration and can return MusicBrainz metadata. | Adds registration and processing, with its own request queue and commercial arrangement. Lookup does not require sending the full audio file. |

Sources: [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API), [rate limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting), [data license](https://musicbrainz.org/doc/About/Data_License), [field classification](https://musicbrainz.org/doc/MusicBrainz_Database), [CAA API](https://musicbrainz.org/doc/Cover_Art_Archive/API), [CAA policy](https://musicbrainz.org/doc/Cover_Art_Archive), [AcoustID API](https://acoustid.org/webservice).

Chromaprint targets **near-identical audio**, rather than general song recognition. Its native `fpcalc` utility uses FFmpeg; binary dependencies and licenses need consideration for distribution. Inference: identify original audio before practice speed/pitch changes; do not promise recognition of arbitrary covers, noisy recordings, or substantially modified extracts. Placement in the import worker or desktop process versus a browser implementation remains an architecture decision. [Chromaprint source documentation](https://github.com/acoustid/chromaprint)

## Alternatives

**Discogs** is relevant for release details, but a poor default for persistent library enrichment under its published May 2025 API terms: images are restricted data with commercial-use restrictions; terms require fresh displayed content within six hours, limit storage, and require adjacent attribution. Paid integrated features can require written permission. The developer reference returned HTTP 403 during research, so current numerical rate limits were not independently verified. [Discogs API terms](https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use)

**iTunes Search** offers convenient search and artwork, but Apple’s published documentation constrains artwork to promoting store content with linked store badges. It is therefore not a clean generic artwork fallback for Woodshed’s library editor. [Apple Search API overview and terms](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html)

## Decisions still open

1. Search suggestions only, or automatic enrichment on import; which fields may fill without review?
2. Include fingerprinting initially, or add it after measuring search failures on representative imports?
3. How much album-edition choice should the UX expose when recording identity is clear?
4. Does first-release scope include licensed genre associations and downloadable artwork in exports?
5. What is Woodshed’s intended commercial status and expected lookup volume? This determines provider arrangements and whether the public API capacity is sufficient.
