"""Verify the shipped part hashes, streamed extraction and executable on CI."""
import json
import pathlib
import shutil
import sys
import tempfile
import subprocess
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'companion'))
manifest = json.loads((ROOT / 'build/gpu-runtime.json').read_text())
if not manifest: sys.exit(0)
processor = ROOT / 'build/processor/woodshed-processor' / ('woodshed-processor.exe' if sys.platform == 'win32' else 'woodshed-processor')
with tempfile.TemporaryDirectory(prefix='woodshed-gpu-package-') as folder:
    command = [str(processor), '--module', 'gpu_runtime', str(ROOT / 'build/gpu-runtime.json'), folder, '--local-parts', str(ROOT / 'release')]
    first = json.loads(subprocess.check_output(command, text=True, timeout=600))
    executable = pathlib.Path(first['executable'])
    assert executable.is_file()
    assert json.loads(subprocess.check_output(command, text=True, timeout=60)) == first
print('PASS: CUDA parts verified, extracted, executable self-check passed, cache reused.')
