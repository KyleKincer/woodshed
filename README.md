# Woodshed

A self-contained desktop app for **practicing along to songs**. Paste a YouTube
link, Woodshed downloads the audio, splits it into stems with
[Demucs](https://github.com/adefossez/demucs), and gives you a multitrack player
with per-stem mute/solo, waveforms, A–B looping and speed control.

The default quality preset is the maximum-quality one (fine-tuned model, heavy
shift averaging, 32-bit float output) — the same settings as the `yt-drumsplit`
CLI script.

## No manual setup

You don't install anything by hand. Woodshed is self-contained:

- **ffmpeg / ffprobe** ship with the app (vendored static binaries).
- **demucs (+ PyTorch), yt-dlp and spotdl** are provisioned automatically on
  first launch into a private, app-managed Python environment using
  [`uv`](https://github.com/astral-sh/uv). You'll see a one-time setup screen; it
  downloads a few hundred MB (PyTorch is the bulk) and runs entirely locally — no
  accounts, no terminal.

Everything lives under the app's data directory, isolated from your system
Python. If you *already* have any of these tools on your PATH, Woodshed uses
those instead and skips provisioning.

> **How the audio is saved:** the managed environment pins `torchaudio < 2.9`
> plus `soundfile`, so demucs saves via the self-contained libsndfile backend —
> no TorchCodec and no system FFmpeg libraries required. A nice side effect:
> `--float32` produces genuine 32-bit float WAV output (true max quality).

The first separation also downloads the Demucs model weights (a few hundred MB),
cached under `~/.cache/`.

## Install

On a Mac, via Homebrew:

```bash
brew tap kylekincer/tap
brew trust kylekincer/tap    # recent Homebrew requires this for third-party casks
brew install --cask kylekincer/tap/woodshed
```

(If `brew trust` isn't a command on your Homebrew, it's old enough not to need
it — skip that line.)

Otherwise grab an installer from the
[latest release](https://github.com/KyleKincer/woodshed/releases/latest) —
`.dmg` for macOS (pick `arm64` for Apple Silicon, `x64` for Intel), `.exe` for
Windows, `.AppImage` for Linux.

> Mac downloads only open cleanly if the release was notarized by Apple. If you
> get *"Apple could not verify Woodshed is free of malware"*, that build wasn't
> — see [Signing](#signing) for the one-line workaround and why.

## Run from source

```bash
cd ~/src/woodshed
npm install      # first time only
npm start
```

Or use the `woodshed` shell alias (added to your `~/.zshrc`).

## Getting songs in

Several ways, all from the **＋ Add song** dialog (or drag-and-drop):

- **Any link** — YouTube, SoundCloud, Bandcamp, Vimeo, a direct `.mp3` URL…
  anything [yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md).
- **Spotify link** — Spotify audio is DRM-protected and can't be downloaded
  directly; with `spotdl` installed, Woodshed reads the track's metadata and
  fetches the closest-matching track from YouTube. (Without `spotdl` it falls
  back to a title search.)
- **Search text** — just type a song name; it grabs the top YouTube result.
- **Local audio files** — drag them onto the window, or use **Choose files…**.
  Supports mp3 / wav / flac / m4a / aac / ogg / opus / aiff / wma.

## Features

- **Library** — every processed song with (square) cover art, stored locally.
  Switch between **grid and list** layouts, and browse by **Songs / Albums /
  Artists** (artist & album come from the source metadata or the file's tags).
  Search, reprocess, rename, delete, or open the original source (the `⋯` menu).
- **Add queue** — add songs while others process; live download + separation
  progress bars; **cancel** any queued or in-progress job (the ✕ on its card);
  failures show the (de-noised) error inline.
- **Presets + custom** — Studio (max quality, default), Balanced, Fast, or fully
  custom (model, shift averaging, overlap, output bit depth). Override per song
  in the Add dialog, or set defaults in Settings.
- **Stem layouts** — full band (drums · bass · vocals · other), the 6-stem model
  (adds guitar + piano), or two-stem modes (e.g. drums + everything else).
- **Player** — sample-locked multitrack playback:
  - Per-track **mute**, **solo**, and **volume**.
  - **Waveforms** per stem (dimmed when muted).
  - **Zoom & pan** the waveforms (scroll to zoom at the cursor, shift-scroll to
    pan) for precise placement, with an **overview minimap** below the stems
    that shows the loop, playhead, and current zoom window (drag the bracket to
    pan, drag its edges to zoom, click to seek).
  - **A–B loop** with draggable edge handles: drag across the waveforms to set a
    region, grab an edge to fine-tune, or drag the whole region. The transport
    shows exact `A → B` times with ±0.05s nudge buttons.
  - **Speed** control 0.5×–1.5× (varispeed — pitch changes with speed).
  - Click a waveform or the overview to seek; the view auto-follows playback.
  - **Metronome** (saved per song): set a tempo by typing BPM or **tapping**
    along (the tap also aligns the downbeat), pick a time signature, accent the
    downbeat, adjust volume, and optionally **count in** a bar before playback.
    Add **tempo / time-signature changes at any point** ("Add at playhead") for
    songs that speed up, slow down, or switch meter. Or **auto-detect** the
    whole beat/downbeat track with [BeatNet](https://github.com/mjhydri/BeatNet)
    ("Auto-detect beats") — handles tempo drift and meter changes automatically,
    then **spot-correct** it ("Edit beats"): drag a beat to re-time it, click
    empty space to add a missing beat, select + Delete a spurious one, toggle
    downbeats (D), or shift the whole track.
    A faint **beat grid** is drawn on the waveforms (brighter downbeats) and the
    click stays locked to the audio at any playback speed and through loops.

  > Auto-detect provisions its own small Python environment on first use (it
  > needs `madmom`, which only runs on Python 3.9). One-time download.

### Keyboard shortcuts (in the player)

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Seek ∓5s (hold `Shift` for 1s) |
| `,` / `.` | Nudge playhead ∓0.05s (hold `Shift` for 0.01s) |
| `[` / `]` | Set loop start / end at the playhead |
| `Home` / `End` | Jump the playhead to loop A / B (or click the A/B times) |
| `L` | Toggle A–B loop |
| `M` | Open the metronome panel |
| `−` / `=` | Zoom out / in (at the playhead) |
| `\` | Fit (zoom out to the whole song) |
| `1`–`9` | Mute / unmute that stem |
| `0` | Reset the mixer |

## Where data lives

Stems, cover art, `library.json` and `settings.json` live in Electron's userData
directory: `~/Library/Application Support/woodshed/`. Deleting a song removes its
stem files too.

> Note: 32-bit float WAV stems are large (~85 MB/min per stem). For a 4-minute
> full-band song that's ~1.4 GB. Switch the output format to 24-bit WAV in
> Settings → Custom to roughly halve that with no audible loss.

## Building a version locally

`npm start` runs the source tree. That's fine for most work, but it doesn't
exercise packaging — asar paths, the vendored ffmpeg/ffprobe binaries, the
managed Python environment resolving from inside a bundle. To test what people
actually download:

```bash
npm run try        # build unpacked (fast) and launch the packaged app
npm run try:dmg    # build the real .dmg, then open dist/
```

`npm run try` runs the app binary in the foreground, so logs come back to your
terminal (unlike double-clicking it). Extra flags:

```bash
./scripts/build-local.sh --clean     # wipe dist/ first
./scripts/build-local.sh --no-run    # just build
```

Installers for one platform, if you want them by hand:

```bash
npm run dist:mac      # .dmg for this Mac's architecture
npm run dist:win      # .exe  (run on Windows)
npm run dist:linux    # .AppImage (run on Linux)
```

> **Build on the platform and architecture you're targeting.** `ffmpeg-static`
> downloads a single binary for the install host, so an x64 `.dmg` built on
> Apple Silicon would ship an arm64 ffmpeg and fail at runtime. That's why
> `npm run dist:mac` only builds this machine's architecture, and why CI sets
> `npm_config_arch` per job. (`ffprobe-static` bundles every platform, so it's
> never a problem.)

## Signing

macOS packaging takes one of two paths, decided by whether an Apple Developer ID
is available. [`electron-builder.js`](electron-builder.js) makes that call once
and everything else follows from it.

**Notarized** (needs the secrets below). electron-builder signs with the
Developer ID certificate under the hardened runtime, uploads the bundle to
Apple's notary service, and staples the resulting ticket into the app. Downloads
open on a plain double-click, and `brew install --cask` works — Homebrew
quarantines cask apps by default, so it needs notarization just as much as a
browser download does.

**Ad-hoc** (no secrets). [`scripts/adhoc-sign.js`](scripts/adhoc-sign.js) applies
a `codesign --sign -` signature instead. Builds you make yourself run with no
ceremony, but Gatekeeper refuses a downloaded copy — an ad-hoc signature has no
team behind it and no notarization ticket — with *"Apple could not verify
Woodshed is free of malware"*. Clear it by hand:

```bash
xattr -dr com.apple.quarantine /Applications/Woodshed.app
```

(Or System Settings → Privacy & Security → **Open Anyway**. On current macOS the
old right-click → Open trick no longer works for un-notarized apps.)

Ad-hoc still beats *unsigned*, which is why the hook exists: skipping signing
leaves the renamed Electron binary's stale linker signature on the bundle, and
macOS rejects that outright as "Woodshed is damaged and can't be opened" — worse,
because no workaround bypasses an invalid signature. v1.0.0 shipped that way.

### Turning notarization on

Requires an [Apple Developer Program](https://developer.apple.com/programs/)
membership ($99/yr) on a paid Individual or Organization team — a free team
can't issue a Developer ID or notarize.

[`scripts/setup-apple-signing.sh`](scripts/setup-apple-signing.sh) does the
mechanical parts:

```bash
./scripts/setup-apple-signing.sh csr
#   -> upload the request at developer.apple.com, download the certificate
./scripts/setup-apple-signing.sh secrets ~/Downloads/developerID_application.cer
```

The second step assembles the `.p12` (bundling Apple's Developer ID intermediate,
without which signing on a runner can fail to build a certificate chain), checks
the certificate against the local private key, verifies your notarization
credentials against Apple with `notarytool` before trusting them, and sets all
five repository secrets:

| Secret | Where it comes from |
| --- | --- |
| `MAC_CSC_LINK` | Base64 of the assembled *Developer ID Application* `.p12` |
| `MAC_CSC_KEY_PASSWORD` | Randomly generated when the `.p12` is built |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from [appleid.apple.com](https://appleid.apple.com) |
| `APPLE_TEAM_ID` | Read out of the certificate's OU |

The private key lives in `~/.woodshed-signing` and never enters the repo. Keep
it — re-issuing the certificate needs it.

All five secrets or none. A certificate *without* notarization credentials is the
trap worth knowing about: the bundle satisfies `codesign` and Gatekeeper still
shows the same "could not verify" dialog, so it looks fixed without being fixed.
The release workflow fails fast on a partial set, and a local build warns.

> **Use a certificate from your own developer account.** Signing a personal app
> with an employer's Developer ID publishes and notarizes it under their
> identity. This machine's keychain holds a *Sweetwater Sound Inc* Developer ID,
> so the setup script refuses that team by name.

CI then asserts what actually matters to whoever downloads it — a Developer ID
authority, a stapled ticket (`stapler validate`) and `spctl` acceptance — rather
than merely that a signature verifies. v1.0.1 passed the weaker check and was
still blocked.

Nothing here is required to build or release; without the secrets the pipeline
just produces ad-hoc builds as before.

## Releasing

Releases are built by GitHub Actions and triggered by a version tag:

```bash
./scripts/build-local.sh     # smoke-test the packaged app first
./scripts/release.sh patch   # or minor / major / an explicit 0.4.2
```

That bumps `package.json`, commits, tags `vX.Y.Z`, and pushes. The tag kicks off
[`.github/workflows/release.yml`](.github/workflows/release.yml), which builds

| Platform | Artifact |
| --- | --- |
| macOS (Apple Silicon) | `Woodshed-X.Y.Z-mac-arm64.dmg` |
| macOS (Intel) | `Woodshed-X.Y.Z-mac-x64.dmg` |
| Windows | `Woodshed-X.Y.Z-win-x64.exe` |
| Linux | `Woodshed-X.Y.Z-linux-x86_64.AppImage` |

then publishes them as a GitHub Release with generated notes and points the
Homebrew tap at the new version. Pushing the tag is the only step — nothing to
confirm afterwards.

Notes:

- `./scripts/release.sh --dry-run patch` shows the version it would cut and
  changes nothing.
- The release is only created after all four builds succeed, so it can't appear
  with an installer missing. To walk one back: `gh release delete vX.Y.Z`, or
  `gh release edit vX.Y.Z --draft=true` to hide it while you sort it out.
- The workflow refuses to build if the tag doesn't match `package.json`, so
  don't hand-tag — `release.sh` keeps them in sync.
- You can run the workflow manually from the Actions tab (**Run workflow**) to
  build all four platforms without tagging or releasing; the installers show up
  as run artifacts.
- Whether Mac builds come out notarized depends on the secrets in
  [Signing](#signing). Without them the pipeline still works, it just ships
  ad-hoc builds that downloaders have to clear by hand.
- CI verifies the mac bundle before uploading it; how strictly depends on which
  path ran (see [Signing](#signing)). v1.0.0 and v1.0.1 both shipped `.dmg`s a
  Mac wouldn't open, for two different reasons. Those checks exist so there
  isn't a third.

### The Homebrew tap

The `homebrew` job runs [`scripts/render-cask.js`](scripts/render-cask.js) to
produce `Casks/woodshed.rb` with a `sha256` pinned per architecture, and commits
it to `KyleKincer/homebrew-tap`. It runs after the release is published, because
Homebrew downloads from the release assets and they have to exist first.

The default `GITHUB_TOKEN` can't write to another repo, so the job authenticates
with a **deploy key** (`HOMEBREW_TAP_DEPLOY_KEY`) rather than a PAT — write access
to that one repo, nothing else, not tied to anyone's account. It's already set
up; to rotate it, generate a keypair, add the public half at
[the tap's deploy keys](https://github.com/KyleKincer/homebrew-tap/settings/keys)
with write access, and `gh secret set HOMEBREW_TAP_DEPLOY_KEY` with the private
half.

If the secret is ever missing the job logs a notice and uploads the rendered cask
as a run artifact so you can copy it over by hand — a tap problem can't block a
release.

To render one locally:

```bash
node scripts/render-cask.js 1.0.2 path/to/dir/with/both/dmgs
```
