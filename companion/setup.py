"""Cross-platform isolated runtime. Python 3.11 and FFmpeg must be installed."""
import os, pathlib, subprocess, sys, venv, shutil
root = pathlib.Path(__file__).resolve().parent
runtime = root / '.venv'
if sys.version_info[:2] != (3, 11):
    raise SystemExit('Run with Python 3.11: python3.11 companion/setup.py (Windows: py -3.11 companion/setup.py).')
venv.create(runtime, with_pip=True)
python = runtime / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
def pip(*args): subprocess.run([str(python), '-m', 'pip', *args], check=True)
pip('install', '--upgrade', 'pip', 'setuptools', 'wheel')
if sys.platform != 'darwin' and ('--cpu' in sys.argv or (sys.platform.startswith('linux') and not shutil.which('nvidia-smi'))):
    pip('install', 'torch==2.7.1', 'torchaudio==2.7.1', '--index-url', 'https://download.pytorch.org/whl/cpu')
pip('install', '-r', str(root / 'requirements.txt'))
# Extractors change frequently; rerun setup to update yt-dlp.
pip('install', '--upgrade', 'yt-dlp[default]')
if '--beats' in sys.argv:
    pip('install', 'cython<3', 'scipy', 'mido', 'matplotlib')
    pip('install', '--no-build-isolation', 'madmom @ git+https://github.com/CPJKU/madmom.git@main')
    pip('install', '--no-deps', 'BeatNet==1.1.3')
subprocess.run(['node', str(root.parent / 'scripts' / 'prepare-fingerprint.mjs')], cwd=root.parent, check=True)
print('Runtime ready. Start with npm run companion. Beat detection requires setup.py --beats.')
