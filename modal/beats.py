"""Woodshed beat/downbeat detection on Modal.

BeatNet depends on madmom, which only builds on Python 3.9 — the reason the
desktop app provisioned a second, isolated virtualenv on the user's machine.
As a container image that constraint costs nothing: it is just a different
`python_version`.

Deploy:  modal deploy modal/beats.py
"""

from __future__ import annotations

import hmac
import os
import pathlib
import subprocess
import tempfile

import modal

app = modal.App("woodshed-beats")

# madmom needs numpy/cython present at build time and pins hard to old numpy;
# installing in this order is what makes the build succeed.
image = (
    modal.Image.debian_slim(python_version="3.9")
    .apt_install("ffmpeg", "git", "build-essential")
    .pip_install("numpy==1.23.5", "cython==0.29.36", "scipy==1.10.1")
    .pip_install(
        "mido==1.2.10",
        "madmom @ git+https://github.com/CPJKU/madmom.git@main",
    )
    .pip_install(
        "torch==2.0.1",
        "torchaudio==2.0.2",
        extra_index_url="https://download.pytorch.org/whl/cpu",
    )
    .pip_install("BeatNet==1.1.1", "librosa==0.9.2", "requests", "fastapi[standard]")
    .env({"PYTHONUNBUFFERED": "1", "NUMBA_CACHE_DIR": "/tmp/numba"})
)

secrets = modal.Secret.from_name("woodshed")

with image.imports():
    from fastapi import HTTPException, Request


def secrets_match(auth_header: str) -> bool:
    expected = f"Bearer {os.environ['MODAL_SHARED_SECRET']}"
    return hmac.compare_digest(auth_header, expected)


def report(callback_url: str, job_id: str, event: str, **fields):
    import requests

    try:
        res = requests.post(
            callback_url,
            json={"jobId": job_id, "event": event, **fields},
            headers={"authorization": f"Bearer {os.environ['MODAL_SHARED_SECRET']}"},
            timeout=30,
        )
        return res.json() if res.content else {}
    except Exception as exc:
        print(f"[reporter] {event} failed: {exc}")
        return {}


@app.function(image=image, secrets=[secrets], timeout=60 * 30, cpu=4.0)
def run_job(job: dict):
    import requests

    job_id = job["jobId"]
    cb = job["callbackUrl"]
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)

            report(cb, job_id, "progress", stage="detect", percent=10,
                   message="Fetching stems…")
            paths = []
            for i, url in enumerate(job["stemUrls"]):
                dest = tmp / f"stem{i}.audio"
                with requests.get(url, stream=True, timeout=600) as res:
                    res.raise_for_status()
                    with dest.open("wb") as fh:
                        for chunk in res.iter_content(1 << 20):
                            fh.write(chunk)
                paths.append(dest)
            if not paths:
                raise RuntimeError("This song has no stems to analyse.")

            # BeatNet wants one mixed signal. Sum the stems back together at
            # unit gain — that reconstructs the original mix.
            report(cb, job_id, "progress", stage="detect", percent=30,
                   message="Building a mix from the stems…")
            mix = tmp / "mix.wav"
            inputs = []
            for p in paths:
                inputs += ["-i", str(p)]
            subprocess.run(
                ["ffmpeg", "-y", *inputs, "-filter_complex",
                 f"amix=inputs={len(paths)}:normalize=0", "-ar", "22050", "-ac", "1", str(mix)],
                check=True,
                capture_output=True,
            )

            report(cb, job_id, "progress", stage="detect", percent=50,
                   message="Detecting beats…")
            beats = detect(mix)

            report(cb, job_id, "done", beats=beats)
    except Exception as exc:
        print(f"[beats {job_id}] failed: {exc}")
        report(cb, job_id, "error", error=str(exc))


def detect(wav_path: pathlib.Path) -> list[list[float]]:
    """Return [[time, beatInBar], ...] — beatInBar == 1 marks a downbeat.

    This pair shape is what the player's `Metronome.setDetected` already
    parses, so the detector stays a drop-in replacement for the local one.
    """
    import sys
    import types

    # BeatNet imports pyaudio unconditionally for its microphone/streaming
    # modes, which the offline path never touches. Stubbing it avoids pulling
    # portaudio into the image.
    sys.modules.setdefault("pyaudio", types.ModuleType("pyaudio"))

    from BeatNet.BeatNet import BeatNet

    estimator = BeatNet(1, mode="offline", inference_model="DBN", plot=[], thread=False)
    output = estimator.process(str(wav_path))
    return [[round(float(t), 4), int(k)] for t, k in output]


@app.function(image=image, secrets=[secrets], timeout=60)
@modal.fastapi_endpoint(method="POST")
def submit(payload: dict, request: Request):
    if not secrets_match(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="Unauthorized")
    for field in ("jobId", "callbackUrl", "stemUrls"):
        if not payload.get(field):
            raise HTTPException(status_code=400, detail=f"Missing {field}")
    run_job.spawn(payload)
    return {"ok": True}
