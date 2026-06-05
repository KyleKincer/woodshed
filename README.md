# Woodshed

A self-contained desktop app for **practicing along to songs**. Paste a YouTube
link, Woodshed downloads the audio, splits it into stems with
[Demucs](https://github.com/adefossez/demucs), and gives you a multitrack player
with per-stem mute/solo, waveforms, A–B looping and speed control.

The default quality preset is the maximum-quality one (fine-tuned model, heavy
shift averaging, 32-bit float output) — the same settings as the `yt-drumsplit`
CLI script.

## Prerequisites

Three command-line tools (the app detects them and shows a banner if any are
missing — it searches Homebrew, pipx and pyenv locations, so it works even when
launched from the Dock):

```bash
brew install yt-dlp ffmpeg
pipx install demucs        # or: pip3 install --user demucs
```

The first separation downloads the Demucs model weights (a few hundred MB),
cached under `~/.cache/`.

## Run

```bash
cd ~/src/woodshed
npm install      # first time only
npm start
```

Or use the `woodshed` shell alias (added to your `~/.zshrc`).

## Features

- **Library** — every processed song with cover art, stored locally. Search,
  rename, delete, or open the original on YouTube (the `⋯` menu on each card).
- **Add queue** — add songs while others process; live download + separation
  progress bars; failures show the error inline.
- **Presets + custom** — Studio (max quality, default), Balanced, Fast, or fully
  custom (model, shift averaging, overlap, output bit depth). Override per song
  in the Add dialog, or set defaults in Settings.
- **Stem layouts** — full band (drums · bass · vocals · other), the 6-stem model
  (adds guitar + piano), or two-stem modes (e.g. drums + everything else).
- **Player** — sample-locked multitrack playback:
  - Per-track **mute**, **solo**, and **volume**.
  - **Waveforms** per stem (dimmed when muted).
  - **A–B loop**: drag across the waveforms to set a region, or use `[` / `]`.
  - **Speed** control 0.5×–1.5× (varispeed — pitch changes with speed).
  - Click waveforms or the scrub bar to seek.

### Keyboard shortcuts (in the player)

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Seek ∓5s (hold `Shift` for 1s) |
| `[` / `]` | Set loop start / end at the playhead |
| `L` | Toggle A–B loop |
| `1`–`6` | Mute / unmute that stem |
| `0` | Reset the mixer |

## Where data lives

Stems, cover art, `library.json` and `settings.json` live in Electron's userData
directory: `~/Library/Application Support/woodshed/`. Deleting a song removes its
stem files too.

> Note: 32-bit float WAV stems are large (~85 MB/min per stem). For a 4-minute
> full-band song that's ~1.4 GB. Switch the output format to 24-bit WAV in
> Settings → Custom to roughly halve that with no audible loss.
