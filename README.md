# Woodshed

A web app for **practicing along to songs**. Paste a link or drop a file,
Woodshed splits it into stems with [Demucs](https://github.com/adefossez/demucs)
on a cloud GPU, and gives you a multitrack player with per-stem mute/solo,
waveforms, A–B looping, speed control and a beat-locked metronome.

Your library, stems, tempo maps and corrected beat tracks live in your account,
so they follow you to any browser.

## Architecture

| Piece | Runs on | Holds |
| --- | --- | --- |
| UI | Static Vite build (Cloudflare Pages / Vercel / Netlify) | — |
| Auth | [Clerk](https://clerk.com) | Users, sessions |
| Data + orchestration | [Convex](https://convex.dev) | Songs, jobs, settings; job dispatch |
| Audio blobs | [Cloudflare R2](https://developers.cloudflare.com/r2/) | Stems, cover art, uploads |
| Separation + beat detection | [Modal](https://modal.com) | Demucs (GPU), BeatNet (CPU) |

**Why R2 and not Convex file storage.** A song is tens of megabytes of stems
and gets re-fetched on every play. Convex file storage bills egress
(~$0.12/GB); R2 has none, at ~$0.015/GB-month of storage. Convex still holds
all the metadata and does all the authorization — it just hands out signed R2
URLs instead of the bytes.

**Why Opus in WebM.** Demucs emits 16-bit WAV — about 144 MB for a 4-minute
song across four stems. Measured on a real song, Opus at 192 kbps/stem brings
that to **13%** of the original size. WebM rather than Ogg because Safari's
`decodeAudioData` handles Opus in WebM (macOS 12+/iOS 15+) but not in Ogg. AAC
was rejected: its encoder-delay priming samples shift playback a few
milliseconds, which would drift against the beat grid.

The encode is verified sample-aligned — subtracting an Opus round-trip from the
source leaves only −40 dB of quantization noise, where an 8 ms offset would
leave −12 dB. Stems stay locked to each other and to the click.

Set `format: flac` in Settings if you want lossless (~4× the size).

## Setup

```bash
npm install
cp .env.local.example .env.local
```

### 1. Convex

```bash
npx convex dev          # prompts login, creates a deployment, prints its URL
```

Put the printed URL in `.env.local` as `VITE_CONVEX_URL`.

### 2. Clerk

1. Create an application at [clerk.com](https://clerk.com).
2. **Configure → JWT Templates → New → Convex.** Leave the name as `convex` —
   `convex/auth.config.ts` looks for exactly that.
3. Copy the **Issuer** URL, and the publishable key from **API keys**.

```bash
echo 'VITE_CLERK_PUBLISHABLE_KEY=pk_test_...' >> .env.local
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://your-app.clerk.accounts.dev
```

### 3. Cloudflare R2

Create a bucket (e.g. `woodshed`) and an API token with object read/write.

```bash
npx convex env set R2_BUCKET            woodshed
npx convex env set R2_ENDPOINT          https://<account-id>.r2.cloudflarestorage.com
npx convex env set R2_ACCESS_KEY_ID     ...
npx convex env set R2_SECRET_ACCESS_KEY ...
```

The browser uploads originals straight to R2 with signed PUT URLs, so audio
never passes through a Convex function.

**You must also set a CORS policy on the bucket** — the browser both `PUT`s
uploads and `GET`s stems cross-origin, so without this nothing loads and nothing
uploads. In the Cloudflare dashboard, **R2 → your bucket → Settings → CORS
policy**:

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173", "https://your-app.example.com"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["content-length"],
    "MaxAgeSeconds": 3600
  }
]
```

`ExposeHeaders: content-length` is what lets the player show a real
megabyte-count while a song downloads.

### 4. Modal

```bash
pip install modal && modal setup
```

Create a Modal secret named `woodshed` holding `MODAL_SHARED_SECRET` (any long
random string), plus the same four `R2_*` values as above. Then:

```bash
npm run modal:deploy
```

Modal prints a URL per endpoint. Register them, and the same shared secret, with
Convex:

```bash
npx convex env set MODAL_SEPARATE_URL  https://<you>--woodshed-separate-submit.modal.run
npx convex env set MODAL_BEATS_URL     https://<you>--woodshed-beats-submit.modal.run
npx convex env set MODAL_SHARED_SECRET <the same random string>
```

The secret authenticates both directions: Convex → Modal on submit, and Modal →
Convex on the progress/result callbacks.

Verify the beat detector actually works before relying on it — its image
installs BeatNet with `--no-deps` (BeatNet's metadata pins `numba==0.54.1`,
which has no wheels past Python 3.9, while Modal's image builder no longer
offers 3.9 at all). A green build only proves pip exited 0:

```bash
modal run modal/beats.py::selftest
```

That runs real DBN inference over a synthetic 120 BPM click and prints the
detected beats.

### 5. Run

```bash
npm run dev     # convex dev + vite, together
```

## Migrating an existing desktop library

Brings over stems, cover art, tempo maps and hand-corrected beat tracks.

```bash
# Add the R2_* vars to .env.local first, then:
node scripts/migrate-local.mjs --user user_2abc... --dry-run
node scripts/migrate-local.mjs --user user_2abc...
```

Get the Clerk user id from **Clerk dashboard → Users**. `--dry-run` transcodes
and reports the size change without uploading. The script is idempotent, so a
partial run can be repeated safely. `--help` lists the rest of the options.

Songs whose source was a local file path lose their "reprocess from source"
ability (the cloud can't reach your old filesystem); everything else is kept.

## Deploying

Production runs on Vercel at **woodshed.kylekincer.com**, against a separate
Convex production deployment. `vercel.json` drives the build:

```
npx convex deploy --cmd-url-env-var-name VITE_CONVEX_URL --cmd 'vite build'
```

That pushes the backend and builds the client against the same deployment, so
the two can't drift. `VITE_CONVEX_URL` is named explicitly because `framework`
is `null`, which leaves Convex nothing to infer the Vite convention from.

`vercel deploy --prod` ships it. Two environment variables are set on the
Vercel project (Production scope):

| | |
| --- | --- |
| `CONVEX_DEPLOY_KEY` | Convex dashboard → Settings → Deploy Keys. No CLI for this. |
| `VITE_CLERK_PUBLISHABLE_KEY` | The `pk_live_…` key from the Clerk **production** instance. |

Everything else lives on the Convex production deployment
(`npx convex env set --prod …`), mirroring the dev list.

### Ordering traps

- **Convex env vars must exist before the first push.** `auth.config.ts`
  references `CLERK_JWT_ISSUER_DOMAIN`, and Convex statically requires every
  env var named there to be set — a deploy fails outright otherwise, even
  though nothing has run yet.
- **Add the production origin to R2 CORS** before expecting playback. Stems are
  fetched from R2 by the browser, so an unlisted origin fails every load.
- **The `{"aud": "convex"}` claim does not clone** from the development Clerk
  instance. Without it Convex rejects every request as unauthenticated, and the
  app says "Not signed in" while Clerk shows you as signed in.

### Clerk production instance

A production instance serves auth from your own domain, which needs five CNAME
records (`accounts`, `clerk`, `clk._domainkey`, `clk2._domainkey`, `clkmail`).
`kylekincer.com` runs on Vercel nameservers, so they go in with
`vercel dns add kylekincer.com <host> CNAME <target>`.

Clerk issues TLS certificates for `clerk.` and `accounts.` only after it
verifies those records — until then the app loads but every Clerk request fails
with `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`. Production instances also need their
own Google OAuth credentials; development borrows Clerk's shared test ones.

### CSP

`index.html` ships no `<meta>` CSP — the real policy is a response header in
`vercel.json`, which is where it can name your Clerk frontend API domain, your
Convex deployment over both https and wss, and your R2 endpoint per
environment.

## Costs

Roughly, for one user with ~100 songs:

| | |
| --- | --- |
| Clerk | Free to 10k monthly users |
| Convex | Free tier is ample for metadata; $25/mo if you outgrow it |
| R2 | ~8 GB of Opus stems ≈ **$0.12/mo**, no egress charges |
| Modal | ~$30/mo of free credits; see below |
| Hosting | Free |

GPU time is the only per-song cost, and it scales with the preset — Fast
~$0.01, Balanced ~$0.05, Studio ~$0.22 (`htdemucs_ft` × 10 shifts is 40 full
passes). The Add and Settings screens show the estimate. Studio is still the
default, matching the desktop app, but Balanced is the better default now that
passes cost money.

## Getting songs in

- **Any link** — YouTube, SoundCloud, Bandcamp, Vimeo, a direct `.mp3` URL…
  anything [yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md).
- **Spotify link** — DRM-protected, so the title is resolved via oEmbed and the
  closest YouTube match is fetched.
- **Search text** — type a song name; it grabs the top YouTube result.
- **Local audio files** — drag onto the window or use **Choose files…**.

> **Heads-up on cloud downloads.** YouTube rate-limits and bot-challenges
> datacenter IP ranges, so link-based adds will fail intermittently from Modal
> in a way they never did from your laptop. Uploading files always works. If
> link ingestion matters, the usual fixes are passing cookies to yt-dlp or
> routing it through a residential proxy.

## Features

- **Library** — cover art, grid/list layouts, browse by Songs / Albums /
  Artists, search, reprocess, rename, delete.
- **Add queue** — add songs while others process, with live upload, download
  and separation progress. Progress is server-side state, so it survives a
  reload or switching devices mid-job.
- **Presets** — Studio, Balanced, Fast, or custom (model, shifts, overlap),
  each with a GPU cost estimate.
- **Stem layouts** — full band, the 6-stem model (adds guitar + piano), or
  two-stem modes.
- **Player** — sample-locked multitrack playback:
  - Per-track **mute**, **solo**, **volume**.
  - **Waveforms** per stem, with zoom/pan and an overview minimap.
  - **A–B loop** with draggable handles and ±0.05s nudge.
  - **Speed** 0.5×–1.5× (varispeed).
  - **Metronome** saved per song: tap or type a BPM, time signatures, accents,
    count-in, and tempo/meter changes at any point. Or **auto-detect** the whole
    beat track with [BeatNet](https://github.com/mjhydri/BeatNet), then
    spot-correct it. A beat grid is drawn on the waveforms and the click stays
    locked to the audio at any speed and through loops.
- **Offline cache** — stems are cached per device after the first play, keyed by
  their immutable storage key, so re-opening a song is instant and free.

### Keyboard shortcuts (in the player)

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Seek ∓5s (hold `Shift` for 1s) |
| `,` / `.` | Nudge playhead ∓0.05s (hold `Shift` for 0.01s) |
| `[` / `]` | Set loop start / end at the playhead |
| `Home` / `End` | Jump the playhead to loop A / B |
| `L` | Toggle A–B loop |
| `M` | Open the metronome panel |
| `−` / `=` | Zoom out / in (at the playhead) |
| `\` | Fit (zoom out to the whole song) |
| `1`–`9` | Mute / unmute that stem |
| `0` | Reset the mixer |
