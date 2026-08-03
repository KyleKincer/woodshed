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
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git")
    .pip_install(
        "torch==2.7.1",
        "torchaudio==2.7.1",
        extra_index_url="https://download.pytorch.org/whl/cu126",
    )
    .pip_install(
        "demucs==4.0.1",
        "soundfile",
        "yt-dlp",
        "boto3",
        "requests",
        "fastapi[standard]",
    )
    .env({"TORCH_HOME": "/models", "PYTHONUNBUFFERED": "1"})
)

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


def run(cmd, on_line=None, cwd=None):
    """Run a command, streaming combined output; raise with real output on failure."""
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
    if code != 0:
        detail = "\n".join(meaningful[-20:]) or "(no error output captured)"
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


def ytdlp_json(target: str) -> dict:
    try:
        out = subprocess.check_output(
            ["yt-dlp", "--no-playlist", "--no-warnings", "--skip-download", "--dump-json", target],
            text=True,
            stderr=subprocess.DEVNULL,
        )
        for line in out.splitlines():
            if line.strip().startswith("{"):
                return json.loads(line)
    except Exception as exc:
        print(f"[meta] yt-dlp metadata failed: {exc}")
    return {}


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
    if stype == "search":
        target = f"ytsearch1:{source['value']}"
    elif stype == "spotify":
        # Spotify audio is DRM'd; resolve the title via oEmbed then match on
        # YouTube, same fallback the desktop app used without spotdl.
        rep.progress("download", 2, "Resolving Spotify track…")
        query = None
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
        target = f"ytsearch1:{query}"
    else:
        target = source["value"]

    rep.progress("download", 3, "Reading metadata…")
    info = ytdlp_json(target)
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

    rep.progress("download", 5, "Downloading audio…")

    def on_line(line: str):
        if "[download]" in line:
            m = re.search(r"(\d{1,3}(?:\.\d+)?)%", line)
            if m:
                rep.progress("download", float(m.group(1)), "Downloading audio…")

    run(
        [
            "yt-dlp",
            "--no-playlist",
            "-f",
            "bestaudio/best",
            "-x",
            "--audio-format",
            "wav",
            "--audio-quality",
            "0",
            "--progress",
            "--newline",
            "-o",
            str(tmp / "dl.%(ext)s"),
            target,
        ],
        on_line=on_line,
    )
    wavs = list(tmp.glob("dl*.wav"))
    if not wavs:
        raise RuntimeError("No audio could be downloaded.")
    if not meta["duration"]:
        meta["duration"] = probe_duration(wavs[0])
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
    except Exception as exc:
        print(f"[job {job['jobId']}] failed: {exc}")
        try:
            rep.post("error", error=str(exc))
        except Canceled:
            pass


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
