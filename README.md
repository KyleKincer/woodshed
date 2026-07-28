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

## Run

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

Local builds are **unsigned**, so macOS quarantines them. If Gatekeeper refuses
to open a locally built `.dmg`:

```bash
xattr -dr com.apple.quarantine /Applications/Woodshed.app
```

> **Build on the platform and architecture you're targeting.** `ffmpeg-static`
> downloads a single binary for the install host, so an x64 `.dmg` built on
> Apple Silicon would ship an arm64 ffmpeg and fail at runtime. That's why
> `npm run dist:mac` only builds this machine's architecture, and why CI sets
> `npm_config_arch` per job. (`ffprobe-static` bundles every platform, so it's
> never a problem.)

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

and publishes them as a GitHub Release with generated notes. Pushing the tag is
the only step — nothing to confirm afterwards.

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
- CI builds are unsigned and un-notarized (no Apple Developer certificate), so
  first-launch on someone else's Mac needs right-click → Open, or the `xattr`
  command above.
