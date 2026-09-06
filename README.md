# Woodshed

Practice along to songs with separated stems, per-stem mute/solo, waveforms,
loops, speed control and a beat-locked metronome.

The website uses **Convex Auth v2 (Google)** and Convex for accounts, library
metadata and practice settings. Audio syncs to private **Cloudflare R2** objects.
The **Electron desktop app** runs yt-dlp, FFmpeg, Demucs and BeatNet on the
user's own computer. No downloads or audio processing run on cloud servers.

Phones can play and manage their synced library. Adding files, downloading
tracks, reprocessing and beat detection require the desktop app on that computer. Native mobile processing and remote desktop job submission
are deferred.

## Development

```sh
npm install
npx convex dev
npm run dev:web
```

Use the same website origin consistently (default `http://localhost:5173`).
`convex dev` writes the deployment URLs to ignored `.env.local`.

### Authentication

`@convex-dev/auth` is pinned to `2.0.0-alpha.1`. This uses the new core and
Google OAuth components, not Clerk or the v1 auth API.

```sh
npx @convex-dev/auth
```

This noninteractive v2 initializer creates signing keys when missing. Do not
use `--force` unless intentionally rotating keys. Configure on the deployment:

- `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`: a Google **Web application** OAuth client.
- `AUTH_ALLOWED_ORIGINS`: comma-separated website origins, e.g. `http://localhost:5173,http://127.0.0.1:47832,https://woodshed.kylekincer.com`.
- Google authorized redirect URI: `https://<deployment>.convex.site/oauth/google/callback`.

For this development deployment, `bash scripts/setup-google-auth.sh` walks
through creating the Google client and stores its credentials securely. The
script specifically targets `jovial-cardinal-295`; adapt it for another project.
Google's consent-screen audience must allow external users. Testing mode only
allows configured test users; publish the consent screen before public launch.

### R2 and quotas

Set `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, and
`R2_SECRET_ACCESS_KEY` on the Convex deployment. Never ship these to a browser
or companion. The R2 token needs object read/write access to the bucket.

Bucket CORS must allow your website origins, `GET` and `HEAD`, and expose
`content-length`. Companion PUTs run outside the browser and do not need CORS.

Cloud quota defaults are decimal bytes and can be changed without a code or
schema migration:

```sh
npx convex env set CLOUD_USER_BYTE_LIMIT 250000000
npx convex env set CLOUD_APP_BYTE_LIMIT 8000000000
```

Uploads reserve both quotas atomically before receiving a ten-minute signed
PUT URL. The URL binds size, MIME type and SHA-256; completion verifies R2
metadata. Reservations expire after one hour. Failed/deleted objects are
removed with retries, and capacity is released only after successful deletion.
This can delay reclaimed capacity by up to one hour so old PUT URLs cannot
recreate deleted files. Playback, metadata edits and export do not require
remaining upload capacity.

These are audio-storage limits, not universal billing caps. Shared R2 usage
outside this app is not measured. Existing legacy cloud objects must be
accounted for before using the limit as a whole-bucket bound. See
[storage economics](docs/storage-economics.md) for estimates and future paid-plan
considerations. Billing and cancellation deletion are not enabled.

## Desktop app

Download the full Electron app from [GitHub Releases](https://github.com/KyleKincer/woodshed/releases). Processing tools are bundled. See [desktop builds and updates](docs/desktop-releases.md).

## Source development: local companion

Install **Node.js 22+**, **Python 3.11**, **FFmpeg** (including ffprobe), and Git.
BeatNet's madmom dependency also needs a C/C++ compiler (Linux build tools,
macOS command-line tools, or Windows Visual Studio C++ build tools).

From this checkout, after `npm install`:

| System | Isolated Python runtime setup |
| --- | --- |
| Linux / macOS | `python3.11 companion/setup.py --beats` |
| Windows | `py -3.11 companion/setup.py --beats` |

Omit `--beats` to install separation first; rerun with it to add beat detection.
The runtime is isolated in `companion/.venv`. On Linux without NVIDIA tools,
setup installs CPU PyTorch; NVIDIA systems can use CUDA. CPU processing is
supported everywhere, but is slower. The first separation downloads model
weights. Rerun setup to update yt-dlp when extractors change.

Use Woodshed for desktop and sign in with the same account as the web player.
The desktop app starts its processor and registers it to your account automatically;
there is no pairing link or code to copy. For desktop development, use
`npm run desktop:dev` with the prepared desktop runtime.

The processor binds only `127.0.0.1` and verifies Host/Origin and a random local
credential supplied through the desktop preload bridge. Convex binds that device
to the signed-in account and checks ownership for processing jobs. Browser-only
sessions cannot access the processor; use the desktop app for adding songs,
importing old libraries, and exporting original audio.

The standalone `npm run companion` entry point is for processor development.
It no longer provides a browser pairing workflow. Its optional environment
variables include `WOODSHED_DATA_DIR` (default `~/.woodshed-companion`),
`WOODSHED_PYTHON`, `WOODSHED_WEB_URL` (allowed UI origin), and
`WOODSHED_COMPANION_PORT` (default 47831). The desktop app supplies its own data
directory, UI origin, and an available port. Device credentials stay bound to
the original account; signing in as another account does not transfer local access.

One companion processes one job at a time. Restarting resumes the active job
from completed source/separation/result files. **Retry** on a failed job reuses
its local outputs, including after a quota error. If an upload reservation has
expired, wait for cleanup before retrying. Cancellation kills the process tree.

### Song details and online metadata

Use **Edit song** from a library song's menu or the player header. Edit identifying
fields, artwork, musical key, tuning, tags, and notes; changes sync across your
library. **Select songs → Edit selected** updates only fields you touch or check.

New imports look up strong catalog matches automatically. Uncertain matches stay
available through **Find another match**, where you can review fields and choose
an album or cover. Your corrections, explicit clearing, and artwork choices survive
lookup and reprocessing. Tempo correction stays in the player.

Online lookup uses MusicBrainz and Cover Art Archive; audio recognition uses
Chromaprint locally and a server-side AcoustID application key. See
[metadata setup and validation](docs/song-metadata-operations.md) for free-service
access requirements, configuration, and export behavior.

### Audio and exports

Sync defaults to Opus/WebM at 192 kbps per stem; 128/160/256 are selectable.
All decoding and alignment must remain consistent with the beat grid. Original
source WAV and separated WAV files remain in the companion's account-specific
data directory. The sync codec does not reduce the retained WAV quality.
Local files are not automatically pruned; use the data folder to manage disk
space after exporting anything you want to keep.

**Settings → Export whole library** creates a ZIP with audio, a versioned song
manifest and settings. Chrome/Edge can stream directly to disk; browsers
without the file-writing API use a bounded 100 MB fallback and request a
desktop browser for larger libraries. **Export local WAVs** copies retained
local WAV/FLAC files into a timestamped Downloads folder. No subscription is
required to export.

### Import the old desktop library

Connect the companion on the computer holding the existing library. In
Settings, **Import old library** detects the usual macOS, Linux and Windows
Woodshed app-data directories, or accepts an explicit directory containing
`library.json`. Existing files are left intact; compressed copies use the
same quota/upload checks as new songs. Metadata and tempo corrections are
preserved. Imports are idempotent by legacy song ID. Import up to the queue
limit at a time; rerunning skips already imported songs.

## Validation and deployment

```sh
npm test
npm run typecheck
npm run build
npx convex dev --once
```

Linux is the initial end-to-end validation target. Native platform CI builds installers for Linux, macOS and Windows. Native mobile clients are future work.

The existing Vercel integration deploys on pushes to `main`; production
credentials, allowed auth origins, Google redirect URL and R2 CORS must all
match the public website before publishing. Development changes do not update
production automatically. Never use a development signing key in production.

## Web and admin

The chosen public address is **woodshed.kylekincer.com**. The player retains the
shared desktop layout. `/download` links to full desktop installers on GitHub Releases;
browser-only users are directed there when trying to process songs.

`/admin` provides account management, storage overrides, global storage policy,
access restrictions, device revocation, job cancellation, and an audit trail.
Admin access is enforced server-side with `ADMIN_USER_IDS`. See
[web/admin setup and production cutover](docs/admin-and-web.md).
