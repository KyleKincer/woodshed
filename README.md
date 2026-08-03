<img src="build/icon.png" alt="" width="92" align="right">

# Woodshed

A self-contained desktop app for **practicing along to songs**. Paste a YouTube
link, Woodshed downloads the audio, splits it into stems with
[Demucs](https://github.com/adefossez/demucs), and gives you a multitrack player
with per-stem mute/solo, waveforms, A–B looping and speed control.

The default quality preset is the maximum-quality one (fine-tuned model, heavy
shift averaging, 32-bit float output) — the same settings as the `yt-drumsplit`
CLI script.

Nothing to install by hand: ffmpeg ships with the app, and demucs, yt-dlp and
spotdl are provisioned on first launch into a private
[`uv`](https://github.com/astral-sh/uv)-managed Python environment. That's a
one-time download of a few hundred MB, run entirely locally.

## Install

Builds come from the
[latest release](https://github.com/KyleKincer/woodshed/releases/latest).

### macOS

Via Homebrew:

```bash
brew tap kylekincer/tap
brew trust kylekincer/tap    # recent Homebrew requires this for third-party casks
brew install --cask kylekincer/tap/woodshed
```

(If `brew trust` isn't a command on your Homebrew, it's old enough not to need
it — skip that line.)

Or download the `.dmg` directly: `mac-arm64` for Apple Silicon, `mac-x64` for
Intel.

### Windows

Download and run the `.exe`. It's an unsigned installer, so SmartScreen will
warn — **More info → Run anyway**.

### Linux

Download the `.AppImage`, make it executable, and run it:

```bash
chmod +x Woodshed-*.AppImage
./Woodshed-*.AppImage
```

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

## Development

- [docs/building.md](docs/building.md) — building and running the packaged app
- [docs/signing.md](docs/signing.md) — macOS signing and notarization
- [docs/releasing.md](docs/releasing.md) — cutting a release, the Homebrew tap
