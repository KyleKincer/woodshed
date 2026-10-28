"""Local-only audio acquisition, separation and encoding. No cloud credentials."""
from __future__ import annotations
import json, os, pathlib, re, subprocess, sys


# Used only when ytdlp-args.json is not shipped (a processor built without
# `--add-data companion/ytdlp-args.json`): jobs keep working and stderr says why.
# companion/lookup.test.mjs checks this equals the file's 'base' list.
FALLBACK_YTDLP_ARGS = ["--js-runtimes", "node", "--remote-components", "ejs:github", "--ignore-config", "--no-playlist"]


def ytdlp_args_file() -> pathlib.Path | None:
    """Where ytdlp-args.json is: next to this module, or in a frozen build's bundle
    (sys._MEIPASS, via build-processor.py's --add-data). None when it was not shipped;
    desktop_entry.py --self-check fails the build on that."""
    roots = [pathlib.Path(__file__).resolve().parent]
    if getattr(sys, "_MEIPASS", None):
        roots.append(pathlib.Path(sys._MEIPASS))
    for root in roots:
        path = root / "ytdlp-args.json"
        if path.is_file():
            return path
    return None


def _load_ytdlp_args() -> list[str]:
    """The base yt-dlp arguments, shared with companion/lookup.mjs through ytdlp-args.json.

    A missing file falls back to FALLBACK_YTDLP_ARGS with a warning; an unreadable one still raises.
    """
    path = ytdlp_args_file()
    if path is None:
        print("Warning: ytdlp-args.json is missing from the processor; using the built-in yt-dlp arguments.", file=sys.stderr)
        return list(FALLBACK_YTDLP_ARGS)
    args = json.loads(path.read_text(encoding="utf-8")).get("base")
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        raise RuntimeError(f"{path} has no valid 'base' argument list.")
    return args


YTDLP_ARGS = _load_ytdlp_args()
STEM_SETS = {
    "htdemucs_6s": ["drums", "bass", "other", "vocals", "guitar", "piano"],
}
DEFAULT_STEMS = ["drums", "bass", "other", "vocals"]

TWO_STEM_FOCUS = {"drums": "drums", "vocals": "vocals", "bass": "bass"}

AUDIO_EXT = re.compile(r"\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?|wma|webm)$", re.I)
# tqdm redraws and blank rules — useless in an error report.
NOISE = re.compile(r"\d+%\||seconds/s|^[\s|█▏▎▍▌▋▊▉#=>.\-]*$")


# YouTube's refusal. Measured to come and go in windows of minutes with no
# change on our side, so it is transient: the server re-queues the job with
# backoff (bot_check). "Sign in to confirm your age" is an age gate, not a bot
# check. The same pattern as errors.BOT_CHECK and lookup.mjs BOT_CHECK
# (test_errors.py checks all three); pipeline.py stays importable on its own.
BOT_CHECK = re.compile(r"not a bot|sign in to confirm(?! your age)", re.I)


class BotChecked(Exception):
    """YouTube refused the request as automated. Transient; the server retries later (bot_check)."""


# --------------------------------------------------------------------------
# Progress lines (stdout, read by companion/server.mjs)
# --------------------------------------------------------------------------


class Reporter:
    """Writes the processor's JSON lines: progress, early metadata.

    A repeat of the same (stage, whole percent, message) is dropped; the
    companion throttles what reaches Convex (server.mjs createProgressThrottle).
    """

    def __init__(self, out=None):
        self.last = None
        self.stage = None
        self._out = out

    def _print(self, payload):
        print(json.dumps(payload), file=self._out or sys.stdout, flush=True)

    def progress(self, stage, percent, message=''):
        value = (stage, int(percent), message)
        if value == self.last: return
        self.last = value
        self.stage = stage
        self._print({'stage': stage, 'percent': percent, 'message': message})

    def meta(self, meta):
        """Early metadata after acquisition (§6.10 CPB item 6): title, artist, uploader, duration, thumbnail, provider."""
        out = {}
        for key in ('title', 'artist', 'uploader', 'provider'):
            value = str(meta.get(key) or '').strip()
            if value: out[key] = value[:300]
        duration = meta.get('duration')
        if isinstance(duration, (int, float)) and duration > 0: out['duration'] = duration
        thumb = str(meta.get('thumbnail') or '').strip()
        if re.match(r'^https://\S+$', thumb) and len(thumb) <= 2000: out['thumbnail'] = thumb
        if out: self._print({'meta': out})


def tool_name(cmd) -> str:
    """The name a failure reports for a command: "yt-dlp", "separator", "ffmpeg", … (errors.classify reads it)."""
    names = {'yt_dlp': 'yt-dlp', 'separator': 'separator', 'demucs.separate': 'separator', 'gpu_runtime': 'gpu_runtime'}
    args = [str(a) for a in cmd]
    for flag in ('-m', '--module'):
        if flag in args[1:3]:
            module = args[args.index(flag) + 1] if args.index(flag) + 1 < len(args) else ''
            return names.get(module, module)
    if len(args) > 1 and pathlib.Path(args[1]).name == 'separator.py':
        return 'separator'
    return re.sub(r'\.exe$', '', re.split(r'[\\/]', args[0])[-1], flags=re.I)


def run(cmd, on_line=None, cwd=None, ok_codes=(0,), env=None):
    """Run a command, streaming combined output; raise with real output on failure.

    `ok_codes` exists for yt-dlp's --max-downloads, which reports 101 on success
    because it stopped early by request.
    """
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    meaningful = []
    assert proc.stdout is not None
    with proc.stdout:
        for raw in proc.stdout:
            for line in re.split(r"[\r\n]", raw):
                line = line.strip()
                if not line:
                    continue
                if on_line:
                    on_line(line)
                if not NOISE.search(line):
                    meaningful.append(line)
                    if len(meaningful) > 40:
                        meaningful.pop(0)
    code = proc.wait()
    if code not in ok_codes:
        detail = "\n".join(meaningful[-20:]) or "(no error output captured)"
        if BOT_CHECK.search(detail):
            raise BotChecked(detail)
        raise RuntimeError(f"{tool_name(cmd)} exited with code {code}\n{detail}")


def ffprobe_format(path) -> dict:
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(path)],
            text=True,
        )
        return json.loads(out).get("format", {})
    except Exception:
        return {}


def probe_duration(path) -> int:
    try:
        return round(float(ffprobe_format(path).get("duration") or 0))
    except Exception:
        return 0


def probe_tags(path) -> dict:
    tags = {k.lower(): v for k, v in (ffprobe_format(path).get("tags") or {}).items()}
    return {
        "title": tags.get("title"),
        "artist": tags.get("artist") or tags.get("album_artist") or tags.get("composer"),
        "album": tags.get("album"),
        "albumArtist": tags.get("album_artist") or tags.get("albumartist"),
        "year": str(tags.get("date") or tags.get("year") or "")[:4],
        "genre": tags.get("genre"),
        "trackNumber": str(tags.get("track") or "").split("/")[0],
        "discNumber": str(tags.get("disc") or "").split("/")[0],
        "musicalKey": tags.get("initial_key") or tags.get("key"),
    }


# --------------------------------------------------------------------------
def download_cover(url: str, dest: pathlib.Path) -> bool:
    import requests

    try:
        res = requests.get(url, timeout=30)
        if res.ok and res.content:
            dest.write_bytes(res.content)
            return True
    except Exception as exc:
        print(f"[meta] cover download failed: {exc}")
    return False


def acquire(job: dict, tmp: pathlib.Path, rep: Reporter) -> tuple[pathlib.Path, dict]:
    """Fetch the source audio as WAV and return (path, metadata)."""
    import requests

    source = job["source"]
    stype = source["type"]
    meta = {"title": source.get("value", "Untitled"), "uploader": "", "artist": "", "album": "", "duration": 0, "cover": None}

    if stype == "upload":
        rep.progress("download", 5, "Fetching your file…")
        name = source.get("filename") or "upload"
        raw = tmp / f"source_{name}"
        raw = pathlib.Path(job['localSource'])
        if not raw.is_file():
            raise RuntimeError('Original file is not on this computer. Add it again.')
        rep.progress("download", 40, "Converting to WAV…")
        wav = tmp / "source.wav"
        run(["ffmpeg", "-y", "-i", str(raw), "-vn", str(wav)])
        tags = probe_tags(raw)
        stem_name = pathlib.Path(name).stem
        cover = tmp / "cover.jpg"
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(raw), "-an", "-vframes", "1", str(cover)],
                check=True,
                capture_output=True,
            )
        except Exception:
            pass
        meta.update(
            title=tags["title"] or stem_name,
            uploader=tags["artist"] or "Uploaded file",
            artist=tags["artist"] or "",
            album=tags["album"] or "",
            duration=probe_duration(raw),
            cover=cover if cover.exists() and cover.stat().st_size else None,
        )
        meta.update({k: tags.get(k) or "" for k in ["albumArtist", "year", "genre", "trackNumber", "discNumber", "musicalKey"]})
        rep.progress("download", 100, "Ready")
        return wav, meta

    # Everything else goes through yt-dlp.
    query = None
    if stype == "search":
        query = source["value"]
    elif stype == "spotify":
        # Spotify audio is DRM'd; resolve the title via oEmbed then match on a
        # site we can actually download from.
        rep.progress("download", 2, "Resolving Spotify track…")
        try:
            res = requests.get(
                "https://open.spotify.com/oembed",
                params={"url": source["value"]},
                timeout=20,
            )
            query = res.json().get("title")
        except Exception:
            pass
        if not query:
            raise RuntimeError("Could not resolve this Spotify link.")

    def fetch(target: str, extra: list[str]):
        # A blocked attempt can leave a partial file — and its info json —
        # behind, which would otherwise be read as the next attempt's result.
        for stale in tmp.glob("dl*"):
            stale.unlink(missing_ok=True)
        return _fetch_target(target, extra, tmp, meta, rep)

    return first_unblocked(download_candidates(source, query), fetch, rep)


def download_candidates(source: dict, query: str | None) -> list[tuple[str, list[str]]]:
    """(target, extra yt-dlp args) to try, in order.

    A query can come from anywhere, so try YouTube first for catalogue and fall
    back to SoundCloud, which draws no bot check at all. An explicit link gets no
    fallback — the user asked for that specific track, and quietly substituting a
    different upload is worse than failing.

    SoundCloud takes five results rather than one because plenty of what it
    returns cannot be used: some is DRM-protected, where search resolves happily
    and the download then fails, and some is a 30-second preview of the real
    track. `-i --max-downloads 1` walks past the dead ones and stops at the first
    that yields audio.

    The duration window is what keeps the result recognisable as the song. Below
    90s is a preview clip; above 12 minutes is a full-album rip or a DJ mix,
    which SoundCloud search returns readily and which would cost a fortune to
    separate and still not be the track asked for. Both bounds can reject a
    legitimate track, and that is the better way to be wrong: a song that fails
    to appear is obvious, a truncated or hour-long one is not.
    """
    if query is not None:
        return [
            (f"ytsearch1:{query}", []),
            (
                f"scsearch5:{query}",
                [
                    "-i",
                    "--max-downloads",
                    "1",
                    "--match-filter",
                    "duration > 90 & duration < 720",
                ],
            ),
        ]
    # --no-playlist only matters for a link: a watch?v=…&list=… URL would
    # otherwise pull the whole playlist.
    return [(source["value"], ["--no-playlist"])]


def first_unblocked(candidates: list[str], fetch, rep):
    """Return the first candidate that isn't bot-checked.

    Only BotChecked moves on to the next candidate. A genuine failure — bad link,
    no such track, no disk — propagates, because trying SoundCloud for a track
    YouTube simply doesn't have would just replace one error with a worse one.
    """
    blocked: BotChecked | None = None
    for i, (target, extra) in enumerate(candidates):
        try:
            return fetch(target, extra)
        except BotChecked as exc:
            blocked = exc
            if i + 1 < len(candidates):
                print(f"[acquire] {target} bot-checked; trying {candidates[i + 1][0]}")
                rep.progress("download", 3, "YouTube is busy — trying SoundCloud…")
    raise blocked if blocked else RuntimeError("No audio could be downloaded.")


def _fetch_target(target: str, extra: list[str], tmp: pathlib.Path, meta: dict, rep: Reporter):
    """Download one target's audio as WAV and read its metadata.

    Metadata comes from --write-info-json rather than a separate --dump-json
    pass, because a search that walks past DRM-protected results downloads a
    different track than the first result, and the old probe would have titled
    the song after a track we never fetched. It also halves the number of
    requests, which is the thing YouTube is counting.
    """
    rep.progress("download", 5, "Downloading audio…")

    def on_line(line: str):
        if "[download]" in line:
            m = re.search(r"(\d{1,3}(?:\.\d+)?)%", line)
            if m:
                rep.progress("download", float(m.group(1)), "Downloading audio…")

    run(
        [
            *module_command("yt_dlp"),
            *YTDLP_ARGS,
            *extra,
            "-f",
            "bestaudio/best",
            "-x",
            "--audio-format",
            "wav",
            "--audio-quality",
            "0",
            "--write-info-json",
            "--progress",
            "--newline",
            "-o",
            str(tmp / "dl.%(ext)s"),
            "--",
            target,
        ],
        on_line=on_line,
        # 101 is how --max-downloads reports "stopped early, as asked".
        ok_codes=(0, 101),
    )
    wavs = list(tmp.glob("dl*.wav"))
    if not wavs:
        raise RuntimeError("No audio could be downloaded.")

    info = {}
    infos = list(tmp.glob("dl*.info.json"))
    if infos:
        try:
            info = json.loads(infos[0].read_text())
        except Exception as exc:
            print(f"[meta] unreadable info json: {exc}")

    if info:
        thumb = info.get("thumbnail") or (
            (info.get("thumbnails") or [{}])[-1].get("url") if info.get("thumbnails") else None
        )
        cover = tmp / "cover.jpg"
        got_cover = download_cover(thumb, cover) if thumb else False
        meta.update(
            title=info.get("track") or info.get("title") or meta["title"],
            uploader=info.get("uploader") or info.get("channel") or "",
            artist=info.get("artist") or info.get("creator") or info.get("uploader") or "",
            album=info.get("album") or "",
            albumArtist=info.get("album_artist") or "",
            year=str(info.get("release_year") or ""),
            genre=info.get("genre") or "",
            trackNumber=str(info.get("track_number") or ""),
            discNumber=str(info.get("disc_number") or ""),
            duration=round(info.get("duration") or 0),
            cover=cover if got_cover else None,
            thumbnail=thumb or None,
            # yt-dlp's site name ("Youtube", "Soundcloud", …), stored as songs.provider.
            provider=info.get("extractor_key") or info.get("extractor") or None,
        )
    if not meta["duration"]:
        meta["duration"] = probe_duration(wavs[0])
    # The canonical URL of whatever we actually landed on. A search and a link
    # that resolve to the same upload should count as the same rendition, and
    # only this side knows they did.
    if info.get("webpage_url"):
        meta["resolvedUrl"] = info["webpage_url"]
    return wavs[0], meta


# --------------------------------------------------------------------------
# Separation + encoding
# --------------------------------------------------------------------------


def expected_stems(stem_mode: str, model: str) -> list[str]:
    if stem_mode == "full":
        return STEM_SETS.get(model, DEFAULT_STEMS)
    focus = TWO_STEM_FOCUS.get(stem_mode, "drums")
    return [focus, f"no_{focus}"]


def module_command(module):
    if module == 'separator' and not getattr(sys, 'frozen', False):
        return [sys.executable, str(pathlib.Path(__file__).with_name('separator.py'))]
    return [sys.executable, '--module', module] if getattr(sys, 'frozen', False) else [sys.executable, '-m', module]


# Demucs "bags" run several sub-models, each a full pass over the track
# (demucs/remote/<name>.yaml lists them); every other pretrained name is one model.
MODEL_COUNTS = {"htdemucs_ft": 4, "mdx": 4, "mdx_q": 4, "mdx_extra": 4, "mdx_extra_q": 4}

# torch.hub's first-use weight download ("Downloading: "https://…/955717e8-8726e21a.th" to …").
MODEL_DOWNLOAD = re.compile(r'Downloading: "[^"]*\.th"')
DOWNLOAD_MESSAGE = "Downloading the separation model (first run)…"
BAR = re.compile(r"(\d{1,3})%\|")
BACKENDS = {"cuda": "NVIDIA GPU", "mps": "Apple GPU", "cpu": "CPU"}


class SeparationProgress:
    """Turns the separator's output lines into `separate` progress.

    tqdm restarts at 0 for every model and every shift; completed passes are
    counted to report one overall percent. A first-run weight download prints
    its own tqdm bar before "Separating track"; it is reported as the model
    download, never counted as a pass (§6.10 CPB item 5).
    """

    def __init__(self, model: str, shifts: int, rep: Reporter):
        self.rep = rep
        self.total_passes = MODEL_COUNTS.get(model, 1) * max(1, int(shifts or 0))
        self.model_files = MODEL_COUNTS.get(model, 1)
        self.runtime = {"attempts": [], "fallbacks": []}
        self.backend = ""
        self.last_bar = 0
        self.done = 0
        self.downloading = False
        self.downloads = 0

    def _restart(self, percent, message):
        self.rep.last = None
        self.rep.progress("separate", percent, message)

    def _download_percent(self, bar: int) -> float:
        files = max(self.model_files, self.downloads)
        return min(99.0, ((self.downloads - 1) + bar / 100) / files * 100)

    def feed(self, line: str):
        if line.startswith("WOODSHED_RUNTIME "):
            info = json.loads(line.removeprefix("WOODSHED_RUNTIME "))
            self.runtime["attempts"].append(info)
            self.backend = BACKENDS[info["device"]]
            if info["device"] == "cpu":
                self.backend += f" · {info['threads']} threads"
            self.last_bar, self.done = 0, 0
            self._restart(0, f"Loading model… ({self.backend})")
            return
        if line.startswith("WOODSHED_FALLBACK "):
            self.runtime["fallbacks"].append(json.loads(line.removeprefix("WOODSHED_FALLBACK ")))
            self.rep.progress("separate", 0, "GPU unavailable; continuing on CPU…")
            return
        if line.startswith("WOODSHED_TIMING "):
            self.runtime.update(json.loads(line.removeprefix("WOODSHED_TIMING ")))
            return
        if MODEL_DOWNLOAD.search(line):
            self.downloading = True
            self.downloads += 1
            self._restart(self._download_percent(0), DOWNLOAD_MESSAGE)
            return
        m = BAR.search(line)
        if m:
            bar = int(m.group(1))
            if self.downloading:
                self.rep.progress("separate", self._download_percent(bar), DOWNLOAD_MESSAGE)
                return
            if bar < self.last_bar - 10:
                self.done += 1
            self.last_bar = bar
            overall = min(99.0, ((self.done + bar / 100) / self.total_passes) * 100)
            self.rep.progress(
                "separate",
                overall,
                f"Separating stems… ({self.backend}, pass {min(self.done + 1, self.total_passes)}/{self.total_passes})",
            )
        elif "Separating track" in line:
            self.downloading = False
            self.last_bar, self.done = 0, 0
            self._restart(1, "Separating stems…")


def separate(wav: pathlib.Path, out_dir: pathlib.Path, quality: dict, stem_mode: str, rep: Reporter):
    model = quality["model"]
    shifts = int(quality.get("shifts") or 0)
    command = module_command('separator')
    accelerated = None
    if getattr(sys, 'frozen', False):
        from gpu_runtime import prepare
        accelerated = prepare(rep)
        if accelerated: command = [str(accelerated), '--module', 'separator']
    args = [
        *command,
        "-n",
        model,
        "--shifts",
        str(shifts),
        "--overlap",
        str(quality.get("overlap", 0.25)),
        "-o",
        str(out_dir),
    ]
    focus = TWO_STEM_FOCUS.get(stem_mode)
    if stem_mode != "full" and focus:
        args.append(f"--two-stems={focus}")
    args.append(str(wav))

    progress = SeparationProgress(model, shifts, rep)
    rep.progress("separate", 0, "Loading model…")
    if accelerated:
        run(args, on_line=progress.feed, env={**os.environ, 'PYINSTALLER_RESET_ENVIRONMENT': '1'})
    else:
        run(args, on_line=progress.feed)
    (out_dir.parent / 'separation-runtime.json').write_text(json.dumps(progress.runtime, indent=2))


def encode(src: pathlib.Path, dest: pathlib.Path, quality: dict):
    """Transcode a separated WAV to the delivery codec.

    Opus goes in a WebM container, not Ogg: Safari's decodeAudioData handles
    WebM/Opus but not Ogg/Opus. Both are sample-exact on decode (unlike AAC,
    whose priming samples would shift playback against the beat grid).
    """
    fmt = quality.get("format", "opus")
    if fmt == "flac":
        run(["ffmpeg", "-y", "-i", str(src), "-c:a", "flac", "-compression_level", "8", str(dest)])
        return "audio/flac"
    bitrate = int(quality.get("bitrate") or 192)
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(src),
            "-c:a",
            "libopus",
            "-b:a",
            f"{bitrate}k",
            "-vbr",
            "on",
            "-application",
            "audio",
            "-f",
            "webm",
            str(dest),
        ]
    )
    return "audio/webm"
