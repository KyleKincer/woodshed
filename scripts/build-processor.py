"""Build a self-contained processing runtime on each release platform."""
import os, pathlib, subprocess, sys
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
subprocess.run([str(executable),'--self-check'],check=True)
