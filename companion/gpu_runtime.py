"""Install the optional, checksum-pinned NVIDIA processor on first use.

The manifest ships inside the app. Jobs and network responses cannot choose
executable URLs or hashes. CPU processing remains available offline.
"""
from __future__ import annotations
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import time


def validate_manifest(manifest):
    if manifest.get('schema') != 1 or not re.fullmatch(r'\d+\.\d+\.\d+', manifest.get('version', '')):
        raise ValueError('Invalid accelerator manifest')
    if manifest.get('platform') not in ('linux', 'win32'):
        raise ValueError('Invalid accelerator platform')
    parts = manifest.get('parts', [])
    if not 1 <= len(parts) <= 32:
        raise ValueError('Invalid accelerator parts')
    names = set()
    for part in parts:
        if (not re.fullmatch(r'woodshed-cuda-[a-z0-9.-]+\.part\d{3}', part.get('name', ''))
                or not re.fullmatch(r'[a-f0-9]{64}', part.get('sha256', ''))
                or not isinstance(part.get('size'), int) or not 0 < part['size'] <= 1024**3
                or part['name'] in names):
            raise ValueError('Invalid accelerator part')
        names.add(part['name'])
    if not isinstance(manifest.get('unpackedBytes'), int) or not 0 < manifest['unpackedBytes'] < 30 * 1024**3:
        raise ValueError('Invalid accelerator size')


def matches(path, part):
    if not path.is_file() or path.stat().st_size != part['size']:
        return False
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest() == part['sha256']


class PartReader(io.RawIOBase):
    """Read an archive across part boundaries without a second multi-GB copy."""
    def __init__(self, paths):
        self.paths = iter(paths)
        self.current = None

    def read(self, size=-1):
        if size < 0: raise ValueError('Unbounded accelerator archive read')
        output = bytearray()
        while len(output) < size:
            if self.current is None:
                path = next(self.paths, None)
                if path is None: break
                self.current = path.open('rb')
            chunk = self.current.read(size - len(output))
            if chunk:
                output.extend(chunk)
            else:
                self.current.close()
                self.current = None
        return bytes(output)

    def close(self):
        if self.current: self.current.close()
        super().close()


def fetch_part(url, destination, expected_size, progress):
    import requests
    with requests.get(url, stream=True, timeout=(15, 45)) as response:
        response.raise_for_status()
        size = 0
        with destination.open('wb') as file:
            for chunk in response.iter_content(1024 * 1024):
                size += len(chunk)
                if size > expected_size: raise ValueError('Accelerator download exceeds expected size')
                file.write(chunk)
                progress(size)
    if size != expected_size: raise ValueError('Incomplete accelerator download')


def install(manifest, cache, progress, fetch=fetch_part, verify=None):
    validate_manifest(manifest)
    # Reuse identical runtime bytes across app-only releases, even when the
    # release tag and asset names change.
    identity = hashlib.sha256(json.dumps({
        'platform': manifest['platform'],
        'parts': [(p['size'], p['sha256']) for p in manifest['parts']],
    }, sort_keys=True).encode()).hexdigest()
    cache = pathlib.Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / identity[:20]
    executable = target / 'woodshed-processor' / ('woodshed-processor.exe' if manifest['platform'] == 'win32' else 'woodshed-processor')
    marker = target / 'complete.json'
    if marker.is_file() and executable.is_file() and marker.read_text() == identity:
        return executable
    downloads = cache / (identity[:20] + '.parts')
    staging = cache / (identity[:20] + '.installing')
    total = sum(part['size'] for part in manifest['parts'])
    shutil.rmtree(staging, ignore_errors=True)
    remaining = sum(p['size'] for p in manifest['parts'] if not (downloads / p['name']).is_file())
    if shutil.disk_usage(cache).free < remaining + manifest['unpackedBytes'] + 1024**3:
        raise OSError('Not enough free space for NVIDIA acceleration')
    downloads.mkdir(exist_ok=True)
    complete = 0
    paths = []
    for part in manifest['parts']:
        path = downloads / part['name']
        paths.append(path)
        if not matches(path, part):
            pending = path.with_suffix(path.suffix + '.pending')
            url = f"https://github.com/KyleKincer/woodshed/releases/download/v{manifest['version']}/{part['name']}"
            fetch(url, pending, part['size'], lambda size: progress(int(90 * (complete + size) / total)))
            if not matches(pending, part):
                pending.unlink(missing_ok=True)
                raise ValueError('Accelerator checksum mismatch')
            pending.replace(path)
        complete += part['size']
        progress(int(90 * complete / total))
    staging.mkdir()
    try:
        progress(92)
        with PartReader(paths) as stream, tarfile.open(fileobj=stream, mode='r|gz') as archive:
            # Reject absolute/escaping paths, device files and escaping links.
            archive.extractall(staging, filter='data')
        staged_executable = staging / executable.relative_to(target)
        if not staged_executable.is_file(): raise ValueError('Missing accelerator executable')
        if verify is not None:
            verify(staged_executable)
        else:
            subprocess.run([str(staged_executable), '--self-check'], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120,
                           env={**os.environ, 'PYINSTALLER_RESET_ENVIRONMENT': '1'},
                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        (staging / 'complete.json').write_text(identity)
        if target.exists(): shutil.rmtree(target)
        staging.replace(target)
        shutil.rmtree(downloads)
        # Only generated runtime caches live here; do not accumulate several
        # multi-GB runtimes across desktop updates.
        for old in cache.iterdir():
            if old != target and re.fullmatch(r'[a-f0-9]{20}(?:\.parts|\.installing)?', old.name):
                shutil.rmtree(old, ignore_errors=True)
        progress(100)
        return executable
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def prepare(reporter):
    manifest_path = os.environ.get('WOODSHED_GPU_MANIFEST')
    cache = os.environ.get('WOODSHED_GPU_CACHE')
    if (sys.platform not in ('linux', 'win32') or not manifest_path or not cache
            or os.environ.get('WOODSHED_DEVICE') == 'cpu'):
        return None

    if not shutil.which('nvidia-smi'): return None
    try:
        manifest = json.loads(pathlib.Path(manifest_path).read_text())
        if manifest.get('platform') != sys.platform: return None
        probe = subprocess.run(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
                               capture_output=True, text=True, timeout=5,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if probe.returncode or not probe.stdout.strip(): return None
        failure = pathlib.Path(cache) / 'retry-after.json'
        try:
            if float(failure.read_text()) > time.time(): return None
        except (OSError, ValueError):
            pass
        return install(manifest, cache, lambda percent: reporter.progress(
            'separate', percent, 'Preparing NVIDIA acceleration (one-time download)…'))
    except Exception as error:
        print(f'[accelerator] Using CPU: {error}', flush=True)
        try:
            pathlib.Path(cache).mkdir(parents=True, exist_ok=True)
            (pathlib.Path(cache) / 'retry-after.json').write_text(str(time.time() + 600))
        except OSError:
            pass
        reporter.last = None
        reporter.progress('separate', 0, 'GPU setup unavailable; using CPU…')
        return None


if __name__ == '__main__':
    # Used by native CI to exercise the exact frozen downloader/extractor with
    # local release parts, before those parts have been published.
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('manifest')
    parser.add_argument('cache')
    parser.add_argument('--local-parts', required=True)
    args = parser.parse_args()
    def local_fetch(url, destination, expected_size, progress):
        shutil.copyfile(pathlib.Path(args.local_parts) / url.rsplit('/', 1)[-1], destination)
    executable = install(json.loads(pathlib.Path(args.manifest).read_text()), args.cache,
                         lambda _: None, fetch=local_fetch)
    print(json.dumps({'executable': str(executable)}), flush=True)
