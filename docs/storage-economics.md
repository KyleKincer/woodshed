# Audio sync economics

Checked 2026-09-04. USD, rough planning estimates; this is not a subscription offer or an approved retention policy.

Use Convex for accounts, ownership, song metadata and practice settings; use private R2 Standard objects for compressed audio. Downloads and separation run on the user's computer. Keep higher-quality source files locally when available and offer ordinary file export. Do not upload a second lossless copy by default.

## Provider costs

R2 Standard includes **10 GB-month storage, 1 million Class A requests and 10 million Class B requests per month**. Above those allowances: **$0.015/GB-month**, **$4.50/million Class A**, **$0.36/million Class B**. Direct R2 internet egress is free. PUT/list are Class A; GET/HEAD are Class B; deletes are free. Billing rounds up units, and storage uses average daily peaks. Standard has no minimum retention duration; Infrequent Access lacks the free allowance and adds retrieval charges, so avoid it here. [Official R2 pricing](https://developers.cloudflare.com/r2/pricing/)

The allowance belongs to the hosting Cloudflare account: **it is shared across Woodshed users and other R2 usage, not 10 GB per registered user**. [Cloudflare R2 account allowance](https://cf-assets.www.cloudflare.com/slt3lc6tev37/4HSbIrd6CzxRpgCux0awBz/7b47dca6524b926dc5b42fd0366672b3/R2_Object_Storage_-_Product_Brief_2023.pdf)

Convex Free/Starter US pricing includes 1 million function calls/month, 0.5 GB database storage, 1 GB database I/O/month, 20 GB-hours action compute/month, 1 GB file storage and 1 GB egress/month. Starter overages include $2.20/million calls, $0.22/GB database storage and I/O, $0.33/GB-hour actions, $0.033/GB file storage and $0.132/GB egress. Professional is $25/developer/month with higher allowances. The existing paid account may already cover this app's metadata needs; verify its actual plan, region and remaining allowance. [Official Convex pricing](https://www.convex.dev/pricing)

Free is capped; Starter permits paid overages. A paid account is not an unlimited free pool. [Convex limits](https://docs.convex.dev/production/state/limits)

Have clients upload/download audio directly using short-lived, authorized R2 URLs, avoiding an audio proxy through Convex. R2 supports signed GET/PUT URLs without exposing bucket credentials. [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

## How many songs?

Assumptions: 240 seconds per song, every stem covers the whole song, bitrate is **per stem**, decimal MB/GB, no deduplication, and storage retained for a full month. These are bitrate calculations, not measured codec results. Variable bitrate, containers, artwork, manifests and retained originals change actual sizes. Budget using measured uploaded bytes and leave headroom.

`MB/song = seconds × kbps/stem × stem count / 8,000`

| Stems | kbps/stem | MB/song | Songs in 10 GB, approximately | 100 songs, GB | 500 songs, GB | 1,000 songs, GB |
| --- | --- | --- | --- | --- | --- | --- |
| 4 | 128 | 15.36 | 651 | 1.536 | 7.68 | 15.36 |
| 4 | 160 | 19.20 | 520 | 1.920 | 9.60 | 19.20 |
| 4 | 192 | 23.04 | 434 | 2.304 | 11.52 | 23.04 |
| 6 | 128 | 23.04 | 434 | 2.304 | 11.52 | 23.04 |
| 6 | 160 | 28.80 | 347 | 2.880 | 14.40 | 28.80 |
| 6 | 192 | 34.56 | 289 | 3.456 | 17.28 | 34.56 |

The existing preset uses 192 kbps Opus. A 160 kbps sync copy would save 16.7%; 128 saves 33.3%. Treat 160 as a candidate pending listening and device playback tests, especially isolated cymbals/transients and time stretching. Do not promise inaudible loss from bitrate alone. Keep all stems aligned and validate decoded duration when changing encoding.

An additional compressed original at 160 kbps adds 4.8 MB/song: totals become 24 MB with four stems or 33.6 MB with six. That reduces the 10 GB fit to about 416 or 297 songs. Uncompressed stereo 44.1 kHz/16-bit PCM is about 42.3 MB per four-minute file; retaining original plus lossless stems in the cloud would multiply storage substantially. FLAC size depends on content. Preserve local originals without charging them against cloud usage.

## Scale examples

Derived storage-only estimates at **160 kbps**, with no original uploaded, using the assumptions above. The shared free allowance is subtracted once. Approximate monthly formula: `ceil(max(0, total GB - 10)) × $0.015`.

| Users | Songs each | Four stems: total GB / monthly storage | Six stems: total GB / monthly storage |
| --- | --- | --- | --- |
| 100 | 100 | 192 / $2.73 | 288 / $4.17 |
| 100 | 500 | 960 / $14.25 | 1,440 / $21.45 |
| 100 | 1,000 | 1,920 / $28.65 | 2,880 / $43.05 |
| 1,000 | 100 | 1,920 / $28.65 | 2,880 / $43.05 |
| 1,000 | 500 | 9,600 / $143.85 | 14,400 / $215.85 |
| 1,000 | 1,000 | 19,200 / $287.85 | 28,800 / $431.85 |

A single 1,000-song library is about $0.29/month for four stems or $0.43 for six before sharing the allowance. A hypothetical $3/month plan would therefore leave about $2.57–$2.71 per subscriber before Convex, requests, payment fees, taxes, hosting and support. This is a storage contribution calculation, not a profitability forecast or proposed price.

Request example: 1,000 users each uploading 100 new four-stem songs generates 400,000 simple PUTs. Each playing 20 songs/day for 30 days generates 2.4 million GETs if each stem is fetched once per playback. These fit the stated request allowances in isolation. Six stems gives 600,000 PUTs and 3.6 million GETs. Retries, HEAD checks, seeking/range requests, signed-URL refreshes and other app usage are additional. Cache downloaded stems locally. Whole-library export has no direct R2 egress charge, but still creates reads and app requests.

## Small seams to leave for paid plans

Implemented starting limits: `CLOUD_USER_BYTE_LIMIT=250000000` (250 MB/account)
and `CLOUD_APP_BYTE_LIMIT=8000000000` (8 GB shared). Both are deployment environment
variables; changing them needs no schema migration. Reservations and delayed cleanup
count toward used bytes. No checkout or cancellation deletion is implemented.

The following future subscription policies remain **proposals, not approved policy**:

- Track actual cloud bytes per user and per object, including uploads pending completion. Reserve quota before authorizing an upload; release failed reservations and verify final sizes. Enforce a configurable per-user byte limit plus an operator-wide upload budget. Public registration must not imply unlimited free storage.
- Keep one entitlement decision (`canUpload`, `cloudByteLimit`, optional expiry) independent of a future billing provider. Playback/export permission should survive entry into a cancellation grace period. Do not build subscription checkout yet.
- Export the complete owned library: audio files plus a versioned manifest containing song metadata, loops and practice settings. Download in batches, support resuming, and assemble folders/archives locally rather than buffering the whole library in browser memory or making a second cloud copy. Export the synced quality everywhere; include higher-quality files only on machines that actually hold them.
- Candidate cancellation policy: service continues until the paid-through date, then a clearly displayed **14-day export grace period** with uploads paused. Notify users of the exact deletion date; offer immediate export at cancellation and do not make a ZIP expiring in minutes their only recovery path. After grace, remove cloud audio in retryable batches and retain a small deletion record. Never delete the user's local originals. Final notices, timing and metadata retention need approval before enabling automated deletion.

For scale: fourteen extra days for a 1,000-song library at 160 kbps costs roughly $0.13 with four stems or $0.20 with six, before free allowance and billing rounding. A usable export window is inexpensive compared with losing user trust. Plan for modest headroom; a public app with unrestricted signup cannot be guaranteed to stay at $0 solely by choosing a generous free tier.

## Desktop installers and updates (September 2026)

Ship installers and updater metadata through public GitHub Releases. The latest
local Linux package is about 594 MiB (~0.62 GB), including its CPU processing
runtime. At 1,000 full downloads that is about 620 GB; 10,000 downloads is about
6.2 TB. None of those bytes pass through Vercel or R2, and installers do not
count against a user's audio quota. Differential updates may transfer less,
but budget examples conservatively assume a complete download each time.

GitHub documents no total release-size or download-bandwidth limit; individual
assets must fit its per-file release limit. These installers fit comfortably.
[GitHub large binary distribution](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)

Builds use standard GitHub-hosted runners in this public repository. Keep it
public to retain free standard-runner usage; avoid switching to paid larger
runners without revisiting costs. Temporary CI artifacts expire after seven
days, while published release assets remain available for installed clients.
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

## Woodshed Plus (September 2026)

Initial pricing: **$2/month or $20/year USD for 5 GB**, versus 250 MB free.
A four-minute song with four 192 kbps stems is approximately 23 MB before art,
so these allowances hold roughly 200 and 10 songs respectively. Six stems,
longer tracks, or FLAC reduce that count. Playback, local processing, and exports
remain free. Prices are server-selected; quota is configurable with
`PRO_STORAGE_BYTES`, and administrator overrides take precedence.

Quick estimates assuming US domestic cards and a fully used 5 GB allowance:

| Per subscriber | Monthly billing | Annual billing, monthly equivalent |
| --- | ---: | ---: |
| Revenue | $2.00 | $1.667 |
| Stripe Payments (2.9% + $0.30 per charge) plus Billing (0.7%) | $0.372 | $0.085 |
| R2 storage at $0.015/GB-month | $0.075 | $0.075 |
| Illustrative backend/operations allowance | $0.10 | $0.10 |
| Contribution toward fixed costs | **$1.453** | **$1.407** |

The $0.10 allowance is a planning assumption, not measured usage. Roughly 32
paying users would cover $45/month of combined shared hosting/backend overhead
at this usage; existing paid accounts may already cover part of that overhead.
This excludes taxes, international cards, currency conversion, refunds, disputes,
support time, and future pricing changes. Annual billing reduces per-charge fees.
R2 free allowances improve the early numbers; do not depend on them at scale.
Downloads have no R2 egress fee, but request operations still count. Cloud
processing is not a paid benefit: downloads and separation stay on the user's
computer.

The base 8 GB app ceiling expands by each paid subscriber's allocated capacity;
admin UI edits the base ceiling, not the funded total. On cancellation, retain
Plus through the paid period, then allow 14 days to export or reduce to the free
quota. After that, remove oldest cloud songs only while over quota, waiting for
actual R2 deletion before choosing another song. Local source/output files remain
untouched. A new payment stops pending cleanup. Failed payments enter the same
export grace period. No refunds or charges are initiated by cleanup.

Sources: [Stripe Payments](https://stripe.com/pricing),
[Stripe Billing](https://stripe.com/billing/pricing),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Convex pricing](https://www.convex.dev/pricing).
