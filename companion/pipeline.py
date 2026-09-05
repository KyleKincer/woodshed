"""Local-only audio acquisition, separation and encoding. No cloud credentials."""
from __future__ import annotations
import json, os, pathlib, re, subprocess, sys
YTDLP_ARGS = ['--js-runtimes', 'node', '--remote-components', 'ejs:github', '--ignore-config', '--no-playlist']
STEM_SETS = {
    "htdemucs_6s": ["drums", "bass", "other", "vocals", "guitar", "piano"],
}
DEFAULT_STEMS = ["drums", "bass", "other", "vocals"]

TWO_STEM_FOCUS = {"drums": "drums", "vocals": "vocals", "bass": "bass"}

AUDIO_EXT = re.compile(r"\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?|wma|webm)$", re.I)
# tqdm redraws and blank rules — useless in an error report.
NOISE = re.compile(r"\d+%\||seconds/s|^[\s|█▏▎▍▌▋▊▉#=>.\-]*$")


class Canceled(Exception):
    """Raised when Convex reports the job was canceled."""


# YouTube's refusal. Measured to come and go in windows of minutes with no
# change on our side — the same query and client config went 0/3 blocked and
# then 2/2 clean a quarter of an hour later. So it is transient, and the job is
# worth requeuing rather than failing.
BOT_CHECK = re.compile(r"not a bot|sign in to confirm", re.I)


class BotChecked(Exception):
    """YouTube refused the request as automated. Transient; retry later."""


# --------------------------------------------------------------------------
# Convex callback plumbing
# --------------------------------------------------------------------------



class Reporter:
    def __init__(self): self.last = None
    def progress(self, stage, percent, message=''):
        value = (stage, int(percent))
        if value == self.last: return
        self.last = value
        print(json.dumps({'stage':stage,'percent':percent,'message':message}), flush=True)

def device():
    import torch
    if torch.cuda.is_available(): return 'cuda'
    return 'cpu'

def run(cmd, on_line=None, cwd=None, ok_codes=(0,)):
    """Run a command, streaming combined output; raise with real output on failure.

    `ok_codes` exists for yt-dlp's --max-downloads, which reports 101 on success
    because it stopped early by request.
    """
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    meaningful = []
    assert proc.stdout is not None
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
        raise RuntimeError(f"{os.path.basename(cmd[0])} exited with code {code}\n{detail}")


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
            duration=round(info.get("duration") or 0),
            cover=cover if got_cover else None,
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
    return [sys.executable, '--module', module] if getattr(sys, 'frozen', False) else [sys.executable, '-m', module]


def separate(wav: pathlib.Path, out_dir: pathlib.Path, quality: dict, stem_mode: str, rep: Reporter):
    model = quality["model"]
    shifts = int(quality.get("shifts") or 0)
    args = [
        *module_command("demucs.separate"),
        "-n",
        model,
        "--shifts",
        str(shifts),
        "--overlap",
        str(quality.get("overlap", 0.25)),
        "-o",
        str(out_dir),
        "-d",
        device(),
    ]
    focus = TWO_STEM_FOCUS.get(stem_mode)
    if stem_mode != "full" and focus:
        args.append(f"--two-stems={focus}")
    args.append(str(wav))

    # htdemucs_ft is four sub-models; each shift is another full pass over all
    # of them. Track completed passes to turn per-pass tqdm into overall %.
    model_count = 4 if model == "htdemucs_ft" else 1
    total_passes = model_count * max(1, shifts)
    state = {"last_bar": 0, "done": 0}

    def on_line(line: str):
        m = re.search(r"(\d{1,3})%\|", line)
        if m:
            bar = int(m.group(1))
            if bar < state["last_bar"] - 10:
                state["done"] += 1
            state["last_bar"] = bar
            overall = min(99.0, ((state["done"] + bar / 100) / total_passes) * 100)
            rep.progress(
                "separate",
                overall,
                f"Separating stems… (pass {min(state['done'] + 1, total_passes)}/{total_passes})",
            )
        elif "Separating track" in line:
            rep.progress("separate", 1, "Separating stems…")

    rep.progress("separate", 0, "Loading model…")
    run(args, on_line=on_line)


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
