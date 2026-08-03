"""Woodshed beat/downbeat detection on Modal.

The desktop app provisioned an isolated Python 3.9 virtualenv for this, but
3.9 was never really madmom's constraint — madmom's git main supports 3.9
through 3.12. The actual blocker is BeatNet's dependency pin of
`numba==0.54.1`, which has no wheels past 3.9.

So BeatNet is installed with `--no-deps` and its dependencies are supplied at
versions that work on 3.11. That matters because Modal's current image builder
no longer offers 3.9 at all.

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

# Build order matters: madmom compiles Cython extensions against the numpy
# that is already installed, so numpy and cython have to land first. numpy is
# held below 2.0 because madmom still uses the pre-2.0 C API.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "build-essential")
    .pip_install("numpy<2", "cython<3", "scipy")
    .pip_install("madmom @ git+https://github.com/CPJKU/madmom.git@main")
    .pip_install(
        "torch==2.7.1",
        extra_index_url="https://download.pytorch.org/whl/cpu",
    )
    .pip_install("librosa", "mido", "matplotlib")
    # --no-deps: BeatNet's metadata pins numba==0.54.1, which is Python<=3.9
    # only. Its real imports are satisfied by the versions installed above.
    .pip_install("BeatNet==1.1.3", extra_options="--no-deps")
    .pip_install("requests", "fastapi[standard]")
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


@app.function(image=image, timeout=60 * 10)
def selftest():
    """Prove the --no-deps BeatNet install actually imports and runs.

    A green image build only means pip exited 0; installing BeatNet without
    its dependency metadata could still leave a module missing at runtime.
    Run with:  modal run modal/beats.py::selftest
    """
    import sys
    import types

    sys.modules.setdefault("pyaudio", types.ModuleType("pyaudio"))

    import numpy, librosa, madmom  # noqa: F401
    from BeatNet.BeatNet import BeatNet

    print(f"python  {sys.version.split()[0]}")
    print(f"numpy   {numpy.__version__}")
    print(f"librosa {librosa.__version__}")
    print(f"madmom  {madmom.__version__}")

    # Four seconds of clicks at 120 BPM — enough to exercise the real
    # DBN inference path, not just the import.
    import numpy as np
    sr = 22050
    sig = np.zeros(sr * 4, dtype=np.float32)
    for i in range(0, 8):
        start = int(i * 0.5 * sr)
        sig[start:start + 400] = np.hanning(400).astype(np.float32)
    import scipy.io.wavfile as wav
    wav.write("/tmp/click.wav", sr, (sig * 32767).astype("int16"))

    est = BeatNet(1, mode="offline", inference_model="DBN", plot=[], thread=False)
    out = est.process("/tmp/click.wav")
    print(f"detected {len(out)} beats; first few: {out[:4].tolist() if hasattr(out, 'tolist') else out[:4]}")
    return {"beats": len(out)}


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
