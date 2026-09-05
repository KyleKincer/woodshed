"""Build a self-contained processing runtime on each release platform."""
import os, pathlib, subprocess, sys, importlib.metadata, shutil
root = pathlib.Path(__file__).resolve().parent.parent
packages = ['demucs','dora','julius','openunmix','torchaudio','librosa','BeatNet','madmom','yt_dlp','yt_dlp_ejs']
args = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--name', 'woodshed-processor', '--distpath', str(root/'build/processor'), '--workpath', str(root/'build/pyinstaller'), '--specpath', str(root/'build'), '--paths', str(root/'companion')]
for package in packages: args += ['--collect-all', package]
for module in ['process','pipeline','beats','demucs.separate','soundfile','scipy.signal','scipy.special','numpy','torch','torchaudio']:
    args += ['--hidden-import', module]
for package in ['demucs','torch','torchaudio','numpy','yt-dlp','einops','julius','dora-search','openunmix','lameenc','omegaconf','treetable','tqdm','requests','soundfile','librosa']:
    args += ['--copy-metadata', package]
args += ['--exclude-module','tkinter','--exclude-module','IPython','--exclude-module','pytest',str(root/'companion/desktop_entry.py')]
subprocess.run(args, cwd=root, check=True)
executable = root/'build/processor/woodshed-processor'/('woodshed-processor.exe' if os.name=='nt' else 'woodshed-processor')
# Keep dependency licenses with the distributed executable.
notices = executable.parent / 'THIRD-PARTY-LICENSES'
notices.mkdir(exist_ok=True)
for distribution in importlib.metadata.distributions():
    name = distribution.metadata['Name'] or 'unknown'
    for file in distribution.files or []:
        if any(term in pathlib.Path(file).name.lower() for term in ('license', 'copying', 'notice')):
            source = pathlib.Path(distribution.locate_file(file))
            if source.is_file():
                dest = notices / name / pathlib.Path(file)
                # Metadata may contain relative paths outside site-packages.
                if '..' in dest.parts: continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, dest)
    (notices / (name + '.txt')).write_text(distribution.read_text('METADATA') or distribution.read_text('PKG-INFO') or name, encoding='utf-8')
# BeatNet uses madmom's DBN algorithms, not madmom's pretrained models.
# Omit those unused, separately licensed weights from the distribution.
models = executable.parent / '_internal' / 'madmom' / 'models'
if models.exists():
    for file in models.rglob('*'):
        if file.is_file() and file.suffix not in ('.py', '.pyc'):
            file.unlink()
subprocess.run([str(executable),'--self-check'],check=True)
