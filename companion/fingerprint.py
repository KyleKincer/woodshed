"""Identify original audio locally. Failure never blocks audio processing."""
import json
import os
import pathlib
import shutil
import subprocess


def fingerprint(audio):
    binary = os.environ.get('WOODSHED_FPCALC') or shutil.which('fpcalc')
    if not binary:
        bundled = pathlib.Path(__file__).resolve().parent.parent / 'build' / 'bin' / ('fpcalc.exe' if os.name == 'nt' else 'fpcalc')
        if bundled.is_file():
            binary = str(bundled)
    if not binary:
        print('[metadata] Chromaprint unavailable; title/artist lookup will still run.', flush=True)
        return None
    try:
        result = subprocess.run([binary, '-json', '-length', '120', str(audio)], capture_output=True, text=True, timeout=45)
        # Some decoders report an EOF warning despite producing a valid fingerprint.
        data = json.loads(result.stdout)
        value, duration = data.get('fingerprint'), data.get('duration')
        if isinstance(value, str) and 0 < len(value) <= 30000 and isinstance(duration, (int, float)) and duration > 0:
            return {'value': value, 'duration': duration}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    print('[metadata] Audio fingerprint unavailable; title/artist lookup will still run.', flush=True)
    return None
