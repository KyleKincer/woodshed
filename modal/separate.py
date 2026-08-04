"""Woodshed stem separation on Modal.

Replaces the local demucs/yt-dlp runtime the Electron app used to provision.
A Convex action POSTs a job here; this spawns a GPU container that acquires the
audio, runs Demucs, encodes the stems to Opus, uploads them to R2, and reports
back to Convex over HTTP.

Deploy:  modal deploy modal/separate.py
"""

from __future__ import annotations

import hmac
import json
import os
import pathlib
import re
import subprocess
import tempfile

import modal

app = modal.App("woodshed-separate")

# Torch pinned below 2.9 with soundfile present so demucs saves via libsndfile
# rather than TorchCodec — same reason the desktop build pinned it.

# YouTube needs two things this image would not otherwise have. First, a
# JavaScript runtime: yt-dlp solves YouTube's JS challenges with one, and
# without it falls back to the android_vr player client, which YouTube answers
# from a datacenter IP with "Sign in to confirm you're not a bot." Second, a
# proof-of-origin token, which bgutil's provider mints locally.
#
# Node rather than Deno (yt-dlp's default) because bgutil's script mode needs
# Node >= 20 anyway; one runtime serves both. Script mode rather than bgutil's
# HTTP server mode because a container here handles exactly one job, so there
# is nothing for a long-lived token server to amortise — and no sidecar to
# start, wait on, or leak.
BGUTIL_VERSION = "1.3.1"
BGUTIL_HOME = "/opt/bgutil-ytdlp-pot-provider/server"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "curl", "ca-certificates")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
    )
    .pip_install(
        "torch==2.7.1",
        "torchaudio==2.7.1",
        extra_index_url="https://download.pytorch.org/whl/cu126",
    )
    .pip_install(
        "demucs==4.0.1",
        "soundfile",
        # Deliberately unpinned: YouTube breaks extractors constantly and a
        # stale pin means no downloads at all. The cost is that an image
        # rebuild can change yt-dlp's behaviour with no change here.
        "yt-dlp",
        "bgutil-ytdlp-pot-provider",
        "boto3",
        "requests",
        "fastapi[standard]",
    )
    .run_commands(
        f"git clone --single-branch --branch {BGUTIL_VERSION}"
        " https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git"
        " /opt/bgutil-ytdlp-pot-provider",
        f"cd {BGUTIL_HOME} && npm ci && npx tsc",
    )
    .env({"TORCH_HOME": "/models", "PYTHONUNBUFFERED": "1"})
)

# Shared by every yt-dlp invocation.
YTDLP_ARGS = [
    "--js-runtimes",
    "node",
    "--extractor-args",
    f"youtubepot-bgutilscript:server_home={BGUTIL_HOME}",
]

# Model weights are a few hundred MB per model. Keeping them on a Volume means
# only the first job of a given model pays the download.
model_cache = modal.Volume.from_name("woodshed-models", create_if_missing=True)

secrets = modal.Secret.from_name("woodshed")

# fastapi and requests live in the image, not on the machine running
# `modal deploy`. `image.imports()` defers them to container start; the
# `from __future__ import annotations` above keeps the `Request` annotation
# on `submit` from being evaluated locally.
with image.imports():
    from fastapi import HTTPException, Request


def secrets_match(auth_header: str) -> bool:
    expected = f"Bearer {os.environ['MODAL_SHARED_SECRET']}"
    return hmac.compare_digest(auth_header, expected)

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
    """Posts job events to Convex and surfaces cancellation.

    Every callback response carries a `cancel` flag; checking it on each
    progress tick is how a user's Cancel button reaches this container.
    """

    def __init__(self, callback_url: str, job_id: str):
        import requests

        self.url = callback_url
        self.job_id = job_id
        self.session = requests.Session()
        self.secret = os.environ["MODAL_SHARED_SECRET"]
        self._last_percent = -1.0

    def post(self, event: str, **fields):
        payload = {"jobId": self.job_id, "event": event, **fields}
        try:
            res = self.session.post(
                self.url,
                json=payload,
                headers={"authorization": f"Bearer {self.secret}"},
                timeout=30,
            )
        except Exception as exc:  # network hiccup shouldn't kill a GPU job
            print(f"[reporter] {event} failed: {exc}")
            return {}
        if res.status_code >= 400:
            print(f"[reporter] {event} -> {res.status_code} {res.text[:200]}")
            return {}
        body = res.json() if res.content else {}
        if body.get("cancel"):
            raise Canceled()
        return body

    def progress(self, stage: str, percent: float, message: str = ""):
        # Throttle: demucs emits a tqdm line per chunk, far more often than the
        # UI can use, and each post is a round trip to Convex.
        if abs(percent - self._last_percent) < 1.0 and percent < 100:
            return
        self._last_percent = percent
        self.post("progress", stage=stage, percent=round(percent, 1), message=message)


# --------------------------------------------------------------------------
# Subprocess helper
# --------------------------------------------------------------------------


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
# R2
# --------------------------------------------------------------------------


def r2_client():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
        region_name="auto",
    )


def r2_upload(client, path: pathlib.Path, key: str, content_type: str) -> int:
    size = path.stat().st_size
    with path.open("rb") as fh:
        client.put_object(
            Bucket=os.environ["R2_BUCKET"],
            Key=key,
            Body=fh,
            ContentType=content_type,
            # Stems are immutable once written (a reprocess writes new keys),
            # so let the browser and Cloudflare cache them indefinitely.
            CacheControl="public, max-age=31536000, immutable",
        )
    return size


# --------------------------------------------------------------------------
# Acquisition
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
        with requests.get(job["sourceUrl"], stream=True, timeout=600) as res:
            res.raise_for_status()
            with raw.open("wb") as fh:
                for chunk in res.iter_content(1 << 20):
                    fh.write(chunk)
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
            "yt-dlp",
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


def separate(wav: pathlib.Path, out_dir: pathlib.Path, quality: dict, stem_mode: str, rep: Reporter):
    model = quality["model"]
    shifts = int(quality.get("shifts") or 0)
    args = [
        "python",
        "-m",
        "demucs.separate",
        "-n",
        model,
        "--shifts",
        str(shifts),
        "--overlap",
        str(quality.get("overlap", 0.25)),
        "-o",
        str(out_dir),
        "-d",
        "cuda",
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


# --------------------------------------------------------------------------
# The job
# --------------------------------------------------------------------------


@app.function(
    image=image,
    gpu="L4",
    secrets=[secrets],
    volumes={"/models": model_cache},
    timeout=60 * 60,
    retries=0,
)
def run_job(job: dict):
    rep = Reporter(job["callbackUrl"], job["jobId"])
    try:
        quality = job["quality"]
        stem_mode = job.get("stemMode", "full")
        key_prefix = job["keyPrefix"].rstrip("/")
        ext = "flac" if quality.get("format") == "flac" else "webm"

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            wav, meta = acquire(job, tmp, rep)

            client = r2_client()

            # Push art + title early so the library card stops saying
            # "Processing…" while the slow part runs.
            cover_key = None
            if meta.get("cover"):
                cover_key = f"{key_prefix}/cover.jpg"
                r2_upload(client, meta["cover"], cover_key, "image/jpeg")
            rep.post(
                "meta",
                title=meta["title"],
                uploader=meta["uploader"],
                artist=meta["artist"],
                album=meta["album"],
                duration=meta["duration"],
                coverKey=cover_key,
                resolvedUrl=meta.get("resolvedUrl"),
            )

            sep_out = tmp / "sep"
            separate(wav, sep_out, quality, stem_mode, rep)
            model_dir = sep_out / quality["model"] / wav.stem
            if not model_dir.is_dir():
                raise RuntimeError("Demucs produced no stems.")

            rep.progress("finalize", 92, "Encoding stems…")
            wanted = expected_stems(stem_mode, quality["model"])
            stems = []
            for i, name in enumerate(wanted):
                src = model_dir / f"{name}.wav"
                if not src.exists():
                    continue
                dest = tmp / f"{name}.{ext}"
                mime = encode(src, dest, quality)
                key = f"{key_prefix}/{name}.{ext}"
                size = r2_upload(client, dest, key, mime)
                stems.append({"name": name, "key": key, "bytes": size, "mime": mime})
                rep.progress(
                    "finalize",
                    92 + (i + 1) / len(wanted) * 7,
                    f"Uploading {name}…",
                )

            if not stems:
                raise RuntimeError("Demucs produced no stems.")

            duration = meta["duration"] or probe_duration(model_dir / f"{wanted[0]}.wav")
            rep.post(
                "done",
                title=meta["title"],
                uploader=meta["uploader"],
                artist=meta["artist"],
                album=meta["album"],
                duration=duration,
                coverKey=cover_key,
                stems=stems,
                stemMode=stem_mode,
                quality=quality,
            )

    except Canceled:
        print(f"[job {job['jobId']}] canceled by user")
    except BotChecked as exc:
        # Flagged retryable so Convex requeues with backoff instead of showing
        # the user a failure. The window usually passes in minutes.
        print(f"[job {job['jobId']}] bot-checked: {exc}")
        try:
            rep.post("error", error=f"YouTube bot check.\n{exc}", retryable=True)
        except Canceled:
            pass
    except Exception as exc:
        print(f"[job {job['jobId']}] failed: {exc}")
        try:
            rep.post("error", error=str(exc))
        except Canceled:
            pass


@app.function(image=image, secrets=[secrets], timeout=60 * 5)
def selftest():
    """Check the pieces a real job depends on, without renting a GPU.

    Credentials are the usual failure: they live in three places (Modal
    secret, Convex env, the bucket's own token) and a mismatch only shows up
    mid-job, after a download and a separation have already been paid for.

    Run with:  modal run modal/separate.py::selftest
    """
    import shutil
    import uuid

    for tool in ("ffmpeg", "ffprobe", "yt-dlp", "node"):
        path = shutil.which(tool)
        print(f"{tool:8} {path or 'MISSING'}")
        if not path:
            raise RuntimeError(f"{tool} is not on PATH in the image")

    # Resolve a real YouTube video without downloading it. This is the check
    # that matters: it exercises the JS runtime and the PO token provider
    # together, from a datacenter IP, which is exactly what fails when they are
    # missing — with a bot check rather than an import error. Asserting the
    # provider is *registered* is not enough; a registered provider that mints
    # nothing still gets the job blocked.
    probe = subprocess.run(
        ["yt-dlp", *YTDLP_ARGS, "-v", "--simulate", "--no-warnings",
         "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
        capture_output=True,
        text=True,
    )
    out = probe.stdout + probe.stderr
    providers = next((l for l in out.splitlines() if "PO Token Providers" in l), "")
    print(f"yt-dlp   {providers.strip() or 'no PO token providers line'}")
    if "bgutil" not in providers:
        raise RuntimeError(f"bgutil PO token provider did not load.\n{out[-2000:]}")
    if probe.returncode != 0:
        hint = "bot check" if re.search(r"not a bot", out, re.I) else "see output"
        raise RuntimeError(f"yt-dlp could not resolve a known video ({hint}).\n{out[-2000:]}")
    print("yt-dlp   resolved a YouTube video without a bot check")

    import torch

    print(f"torch    {torch.__version__} (cuda available: {torch.cuda.is_available()})")

    # R2 round trip: put an object, read it back, delete it.
    client = r2_client()
    bucket = os.environ["R2_BUCKET"]
    key = f"_selftest/{uuid.uuid4()}.txt"
    body = b"woodshed selftest"
    client.put_object(Bucket=bucket, Key=key, Body=body, ContentType="text/plain")
    got = client.get_object(Bucket=bucket, Key=key)["Body"].read()
    client.delete_object(Bucket=bucket, Key=key)
    if got != body:
        raise RuntimeError("R2 round trip returned different bytes")
    print(f"r2       round trip OK on bucket '{bucket}'")
    return {"ok": True}


def _probe_youtube(target: str, attempts: int, clients: str | None) -> dict:
    """Resolve a target with full verbosity and report how often it was blocked.

    The container is the only place the truth lives: which player clients
    yt-dlp tries, whether bgutil actually minted a token, and what YouTube said
    back. Reproducing this locally is useless — a home IP is not what gets
    challenged. Repeated because the block is probabilistic; one green run
    proves nothing, which is exactly the trap this function exists to avoid.
    """
    args = list(YTDLP_ARGS)
    if clients:
        args += ["--extractor-args", f"youtube:player_client={clients}"]
    blocked = 0
    for i in range(attempts):
        probe = subprocess.run(
            ["yt-dlp", *args, "-v", "--simulate", "--no-playlist", target],
            capture_output=True,
            text=True,
        )
        out = probe.stdout + probe.stderr
        bot = bool(re.search(r"not a bot", out, re.I))
        blocked += bot
        print(f"    attempt {i + 1}: exit {probe.returncode}{' BOT CHECK' if bot else ''}")
        if probe.returncode != 0 and not bot:
            for line in out.splitlines():
                if line.startswith("ERROR"):
                    print(f"      {line[:200]}")
    print(f"  == {clients or 'default'}: {attempts - blocked}/{attempts} clean")
    return {"clients": clients or "default", "attempts": attempts, "blocked": blocked}


# Candidate client sets. android_vr is in yt-dlp's default rotation and is the
# one that gets bot-checked; the others need a PO token, which bgutil mints.
# The embedded and mobile-app clients are here because they authenticate
# differently from the web ones — a sweep that only walks web variants tests one
# idea five times.
CLIENT_CANDIDATES = [
    None,
    "web_safari",
    "mweb",
    "tv",
    "tv_embedded",
    "web_embedded",
    "web_creator",
    "ios",
    "android",
]


@app.function(image=image, secrets=[secrets], timeout=60 * 30)
def selftest_youtube(
    target: str = "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    attempts: int = 3,
    clients: str = "",
):
    """Probe YouTube resolution, optionally sweeping player_client settings.

    Run with:
      modal run modal/separate.py::selftest_youtube --target "ytsearch1:some song"
      modal run modal/separate.py::selftest_youtube --clients web_safari
      modal run modal/separate.py::selftest_youtube --clients SWEEP
    """
    if clients == "SWEEP":
        return [_probe_youtube(target, attempts, c) for c in CLIENT_CANDIDATES]
    return _probe_youtube(target, attempts, clients or None)


class _NullReporter:
    """Stands in for Reporter in selftests — no Convex, no cancellation."""

    def post(self, event: str, **fields):
        return {}

    def progress(self, stage: str, percent: float, message: str = ""):
        print(f"    [{stage} {percent:.0f}%] {message}")


@app.function(image=image, secrets=[secrets], timeout=60 * 20)
def selftest_fallback(query: str = "john coltrane giant steps"):
    """Prove the YouTube→SoundCloud fallback, and that both halves download.

    The fallback ordering is checked against a fetch that refuses YouTube, since
    a real bot check is not something we can summon on demand. Then each source
    is downloaded for real, because "the loop is correct" and "SoundCloud
    actually yields audio" are different claims.

    Run with:  modal run modal/separate.py::selftest_fallback
    """
    rep = _NullReporter()
    ok = True

    cands = download_candidates({"type": "search", "value": query}, query)
    print(f"candidates   {[t for t, _ in cands]}")
    ok &= [t for t, _ in cands] == [f"ytsearch1:{query}", f"scsearch5:{query}"]
    # A preview clip must not come back as the song.
    ok &= "duration > 90 & duration < 720" in cands[1][1]

    # An explicit link must not silently become a different upload.
    link = {"type": "url", "value": "https://example.com/a.mp3"}
    ok &= [t for t, _ in download_candidates(link, None)] == ["https://example.com/a.mp3"]
    print(f"link only    {[t for t, _ in download_candidates(link, None)]}")

    # YouTube blocked -> SoundCloud chosen.
    def refuse_youtube(target: str, extra: list[str]):
        if target.startswith("ytsearch"):
            raise BotChecked("Sign in to confirm you're not a bot")
        return target

    picked = first_unblocked(cands, refuse_youtube, rep)
    print(f"fell back to {picked}")
    ok &= picked.startswith("scsearch")

    # A real error must not be swallowed into the fallback.
    def real_error(target: str, extra: list[str]):
        raise RuntimeError("no such track")

    try:
        first_unblocked(cands, real_error, rep)
        print("FAIL: a real error was swallowed")
        ok = False
    except RuntimeError as exc:
        print(f"real errors propagate: {exc}")

    # Both sources actually produce audio.
    for target, extra in cands:
        with tempfile.TemporaryDirectory() as td:
            tmp = pathlib.Path(td)
            meta = {"title": query, "uploader": "", "artist": "", "album": "", "duration": 0, "cover": None}
            try:
                wav, got = _fetch_target(target, extra, tmp, meta, rep)
                size = wav.stat().st_size
                dur = got["duration"]
                plausible = 90 <= dur <= 720
                print(f"{target[:9]}  {size / 1e6:.1f} MB  {dur}s  {got['title'][:40]}"
                      f"{'' if plausible else '  <- NOT SONG-LENGTH'}")
                ok &= size > 100_000
                # Only the fallback is filtered; YouTube search relevance is
                # left as it was rather than changed on the way past.
                if target.startswith("scsearch"):
                    ok &= plausible
            except BotChecked:
                print(f"{target[:9]}  bot-checked (window, not a code fault)")
            except Exception as exc:
                print(f"{target[:9]}  FAILED: {exc}")
                ok = False

    print(f"=== {'ok' if ok else 'FAILURES ABOVE'} ===")
    return {"ok": ok}


@app.function(image=image, secrets=[secrets], gpu="L4", timeout=60 * 10)
def selftest_gpu():
    """Prove demucs can actually reach the GPU, on the same config run_job uses.

    Separate from `selftest` so the common check stays free; this one rents an
    L4 for well under a minute. Catches a torch/CUDA mismatch here rather than
    after a real job has already paid to download a track.

    Run with:  modal run modal/separate.py::selftest_gpu
    """
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available inside the GPU container")
    print(f"torch {torch.__version__} on {torch.cuda.get_device_name(0)}")

    # Load the model demucs would load, and push a tensor through the device,
    # so this fails on a broken CUDA build rather than passing on a bare import.
    from demucs.pretrained import get_model

    model = get_model("htdemucs")
    model.to("cuda")
    x = torch.zeros(1, 2, 44100 * 2, device="cuda")
    print(f"model loaded: {model.__class__.__name__}, sources={model.sources}")
    print(f"tensor on {x.device}, sum={float(x.sum())}")
    return {"ok": True, "gpu": torch.cuda.get_device_name(0)}


@app.function(image=image, secrets=[secrets], timeout=60)
@modal.fastapi_endpoint(method="POST")
def submit(payload: dict, request: Request):
    """Entry point Convex calls. Spawns the GPU job and returns immediately.

    The endpoint is public, so the shared secret is the only thing stopping a
    stranger from running GPU jobs on your account — reject before spawning.
    """
    if not secrets_match(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="Unauthorized")
    for field in ("jobId", "callbackUrl", "keyPrefix", "quality", "source"):
        if not payload.get(field):
            raise HTTPException(status_code=400, detail=f"Missing {field}")
    run_job.spawn(payload)
    return {"ok": True}
