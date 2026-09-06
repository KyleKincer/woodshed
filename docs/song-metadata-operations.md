# Song metadata operations

## Providers and configuration

MusicBrainz supplies catalog details; Cover Art Archive supplies release cover images.
Chromaprint 1.6.1 generates a fingerprint of the first 120 seconds of original audio
locally; AcoustID receives the fingerprint and full duration for identification.
Original audio and personal notes are not sent to these providers. Title and artist
are sent to MusicBrainz for searches. Requests run on the backend, with coordinated
rate limits, one-day catalog caching, timeouts, and up to two delayed retries for
background enrichment. Lookup failure never blocks import or manual editing.

Register an AcoustID **application** (not user submission) key and set
`ACOUSTID_API_KEY` on the appropriate Convex deployment. It is never a `VITE_*`
variable. The development key was registered and configured during implementation;
no key is committed. Set `MUSICBRAINZ_ENABLED=true` after confirming permitted
provider access; lookup is off by default on unconfigured deployments. Development
has this enabled. Set it to `false` to disable catalog requests.

The public MusicBrainz and AcoustID services offer free noncommercial access.
The presence of a free key does not establish commercial-use permission. Before
enabling this integration for a commercial release, arrange permitted access with
the providers. See the [primary-source research](music-metadata-research.md).
No paid provider subscription was created.

Genre remains editable and is imported from embedded tags when available. Online
genre associations are not fetched because their license differs from core catalog
data. Musical key is imported when tagged, and remains editable alongside tuning
and personal notes; catalog lookup does not claim to infer these practice details.

## Desktop and source installations

`npm run desktop:prepare` downloads the official Chromaprint binary for the build
platform, verifies its pinned SHA-256, and packages it with licenses in `build/`.
The frozen processor includes `companion/fingerprint.py`. New installers therefore
include fingerprint generation without another user setup step.

Source users run `node scripts/prepare-fingerprint.mjs`; `companion/setup.py` also
runs this step. `WOODSHED_FPCALC` can point to a separately installed executable.
Older desktop installations continue processing but need an updated installer to
generate fingerprints. Existing songs without fingerprints still support text
lookup; reprocessing with an updated companion adds the fingerprint.

## Persistence and exports

Only submitted fields change in a bulk edit (maximum 100 songs). Empty submitted
values intentionally clear a field. Personal tags replace the selected songs' tag
lists rather than silently merging them. Metadata corrections and explicit artwork
removal are protected against later lookup, concurrent lookup completion, and
reprocessing. Legacy imports are preserved without automatic enrichment.

Image uploads use existing R2 storage, ownership checks, quota reservation,
checksum/size/type verification, and expiry cleanup. Unsaved uploads expire after
one hour; a failed metadata save can retry the verified image without uploading
another copy. Uploaded covers are single-song edits.

Exports include all descriptive and practice fields, metadata provenance, and the
selected artwork descriptor. Uploaded/imported artwork is included as a file.
Cover Art Archive selections remain release references and image URLs in the
manifest; external catalog artwork is not copied into the ZIP. Original audio-file
tags remain untouched.

## Validation performed

- Convex typecheck, web production build, all 27 Vitest tests and 10 desktop tests.
- Development backend push to `jovial-cardinal-295`.
- Ownership refusal, atomic cross-owner bulk rollback, partial updates, explicit
  clearing, stale lookup protection, export fields, artwork reservation/expiry,
  and reprocessing preservation tests.
- Real MusicBrainz search, release selection and track/disc detail retrieval from
  the development backend.
- Real AcoustID sample-fingerprint lookup using the registered application key.
- Local Chromaprint generation from synthetic audio.
- Chrome checks of the actual editor, and sample-data checks of mixed-value bulk
  editing, failed-save draft preservation and retry, and a 390px mobile viewport.

Packaged installers were not rebuilt or published. Production was not deployed.
