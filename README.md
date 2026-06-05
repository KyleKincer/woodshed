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

### Keyboard shortcuts (in the player)

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Seek ∓5s (hold `Shift` for 1s) |
| `,` / `.` | Nudge playhead ∓0.05s (hold `Shift` for 0.01s) |
| `[` / `]` | Set loop start / end at the playhead |
| `L` | Toggle A–B loop |
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
